/** Fail-closed filesystem writes for /q-init. */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const INIT_EXISTING_FILE_MAX_BYTES = 1_048_576 as const;

export interface InitFileIdentity {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
	sha256: string;
	parentDev: bigint;
	parentIno: bigint;
}

interface SafeInitTarget {
	target: string;
	parent: string;
	parentDev: bigint;
	parentIno: bigint;
}

function validRelativeTarget(value: string): boolean {
	return value.length > 0
		&& !isAbsolute(value)
		&& !value.split(sep).some((part) => part.length === 0 || part === "." || part === "..")
		&& !/[\u0000-\u001f\u007f]/u.test(value);
}

async function safeTarget(projectRoot: string, requestedPath: string, createParents: boolean): Promise<SafeInitTarget> {
	if (!isAbsolute(projectRoot) || !isAbsolute(requestedPath)) throw new Error("INIT_WRITE_UNSAFE_PATH");
	const requestedRelative = relative(projectRoot, requestedPath);
	if (!validRelativeTarget(requestedRelative)) throw new Error("INIT_WRITE_UNSAFE_PATH");
	const resolvedRoot = await realpath(projectRoot);
	const parts = requestedRelative.split(sep);
	const leaf = parts.pop();
	if (!leaf) throw new Error("INIT_WRITE_UNSAFE_PATH");
	let parent = resolvedRoot;
	for (const part of parts) {
		const next = join(parent, part);
		if (createParents) {
			try {
				await mkdir(next, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		const stats = await lstat(next, { bigint: true });
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("INIT_WRITE_UNSAFE_PARENT");
		parent = next;
	}
	const parentStats = await lstat(parent, { bigint: true });
	if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) throw new Error("INIT_WRITE_UNSAFE_PARENT");
	return {
		target: join(parent, leaf),
		parent,
		parentDev: parentStats.dev,
		parentIno: parentStats.ino,
	};
}

function sameParent(left: SafeInitTarget, right: SafeInitTarget): boolean {
	return left.parent === right.parent && left.parentDev === right.parentDev && left.parentIno === right.parentIno;
}

function sameFileIdentity(left: InitFileIdentity, right: InitFileIdentity): boolean {
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs
		&& left.sha256 === right.sha256
		&& left.parentDev === right.parentDev
		&& left.parentIno === right.parentIno;
}

async function identityFromHandle(handle: FileHandle, parent: SafeInitTarget): Promise<InitFileIdentity> {
	const before = await handle.stat({ bigint: true });
	if (!before.isFile()) throw new Error("INIT_WRITE_TARGET_NOT_REGULAR");
	if (before.size > BigInt(INIT_EXISTING_FILE_MAX_BYTES)) throw new Error("INIT_WRITE_TARGET_TOO_LARGE");
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let offset = 0;
	for (;;) {
		const read = await handle.read(buffer, 0, buffer.length, offset);
		if (read.bytesRead === 0) break;
		hash.update(buffer.subarray(0, read.bytesRead));
		offset += read.bytesRead;
	}
	const after = await handle.stat({ bigint: true });
	if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
		before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(offset) !== after.size) {
		throw new Error("INIT_WRITE_TARGET_CHANGED");
	}
	return {
		dev: after.dev,
		ino: after.ino,
		size: after.size,
		mtimeNs: after.mtimeNs,
		ctimeNs: after.ctimeNs,
		sha256: hash.digest("hex"),
		parentDev: parent.parentDev,
		parentIno: parent.parentIno,
	};
}

async function assertPathBindsHandle(target: SafeInitTarget, handle: FileHandle): Promise<void> {
	const [pathStats, handleStats] = await Promise.all([
		lstat(target.target, { bigint: true }),
		handle.stat({ bigint: true }),
	]);
	if (pathStats.isSymbolicLink() || !pathStats.isFile() ||
		pathStats.dev !== handleStats.dev || pathStats.ino !== handleStats.ino) {
		throw new Error("INIT_WRITE_TARGET_CHANGED");
	}
}

/** Capture the exact regular-file bytes to which an overwrite confirmation applies. */
export async function captureInitFileIdentity(projectRoot: string, requestedPath: string): Promise<InitFileIdentity> {
	const target = await safeTarget(projectRoot, requestedPath, false);
	const handle = await open(target.target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const identity = await identityFromHandle(handle, target);
		const currentParent = await safeTarget(projectRoot, requestedPath, false);
		if (!sameParent(target, currentParent)) throw new Error("INIT_WRITE_PARENT_CHANGED");
		await assertPathBindsHandle(currentParent, handle);
		return identity;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

export interface SafeInitWriteInput {
	projectRoot: string;
	path: string;
	content: string;
	action: "create" | "overwrite";
	expectedIdentity?: InitFileIdentity;
}

/**
 * Write one planned init file without following the leaf symlink. Creates are
 * exclusive; overwrites re-hash the same opened file before truncation.
 */
export async function safelyWriteInitFile(input: SafeInitWriteInput): Promise<void> {
	const bytes = Buffer.from(input.content, "utf8");
	const target = await safeTarget(input.projectRoot, input.path, input.action === "create");
	if (input.action === "overwrite" && input.expectedIdentity === undefined) {
		throw new Error("INIT_WRITE_CONFIRMATION_IDENTITY_MISSING");
	}
	const flags = input.action === "create"
		? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW
		: fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;
	let handle: FileHandle | undefined;
	let createdIdentity: { dev: bigint; ino: bigint } | undefined;
	let complete = false;
	try {
		handle = await open(target.target, flags, 0o600);
		if (input.action === "overwrite") {
			const currentIdentity = await identityFromHandle(handle, target);
			if (!sameFileIdentity(currentIdentity, input.expectedIdentity!)) throw new Error("INIT_WRITE_TARGET_CHANGED");
		} else {
			const stats = await handle.stat({ bigint: true });
			if (!stats.isFile()) throw new Error("INIT_WRITE_TARGET_NOT_REGULAR");
			createdIdentity = { dev: stats.dev, ino: stats.ino };
		}

		const currentParent = await safeTarget(input.projectRoot, input.path, false);
		if (!sameParent(target, currentParent)) throw new Error("INIT_WRITE_PARENT_CHANGED");
		await assertPathBindsHandle(currentParent, handle);
		await handle.truncate(0);
		await handle.writeFile(bytes);
		await handle.sync();
		const after = await handle.stat({ bigint: true });
		if (after.size !== BigInt(bytes.length)) throw new Error("INIT_WRITE_VERIFY_FAILED");
		const finalParent = await safeTarget(input.projectRoot, input.path, false);
		if (!sameParent(target, finalParent)) throw new Error("INIT_WRITE_PARENT_CHANGED");
		await assertPathBindsHandle(finalParent, handle);
		complete = true;
	} finally {
		await handle?.close().catch(() => undefined);
		if (!complete && input.action === "create" && createdIdentity) {
			try {
				const current = await lstat(target.target, { bigint: true });
				if (!current.isSymbolicLink() && current.dev === createdIdentity.dev && current.ino === createdIdentity.ino) {
					await unlink(target.target);
				}
			} catch {
				// Best-effort cleanup is restricted to the exact inode created here.
			}
		}
	}
}
