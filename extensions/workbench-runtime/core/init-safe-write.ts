/** Fail-closed filesystem writes for /q-init. */

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	unlink,
	type FileHandle,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

export const INIT_EXISTING_FILE_MAX_BYTES = 1_048_576 as const;

export interface InitFileIdentity {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
	mode: bigint;
	uid: bigint;
	gid: bigint;
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

export type InitWriteFaultPoint =
	| "after-temp-create"
	| "after-temp-write"
	| "after-temp-sync"
	| "before-publish"
	| "after-publish"
	| "after-parent-sync";

export interface SafeInitWriteOptions {
	/** Test-only boundary hook. Production callers must leave this unset. */
	fault?: (
		point: InitWriteFaultPoint,
		paths: { targetPath: string; tempPath: string },
	) => void | Promise<void>;
}

function validRelativeTarget(value: string): boolean {
	return value.length > 0
		&& !isAbsolute(value)
		&& !value.split(sep).some((part) => part.length === 0 || part === "." || part === "..")
		&& !/[\u0000-\u001f\u007f]/u.test(value);
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
	try {
		await handle.sync();
	} finally {
		await handle.close().catch(() => undefined);
	}
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
			let created = false;
			try {
				await mkdir(next, { mode: 0o700 });
				created = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			if (created) await syncDirectory(parent);
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
		&& left.mode === right.mode
		&& left.uid === right.uid
		&& left.gid === right.gid
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
	if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
		|| before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
		|| before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid
		|| BigInt(offset) !== after.size) {
		throw new Error("INIT_WRITE_TARGET_CHANGED");
	}
	return {
		dev: after.dev,
		ino: after.ino,
		size: after.size,
		mtimeNs: after.mtimeNs,
		ctimeNs: after.ctimeNs,
		mode: after.mode,
		uid: after.uid,
		gid: after.gid,
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
	if (pathStats.isSymbolicLink() || !pathStats.isFile()
		|| pathStats.dev !== handleStats.dev || pathStats.ino !== handleStats.ino) {
		throw new Error("INIT_WRITE_TARGET_CHANGED");
	}
}

async function assertPreparedBytes(handle: FileHandle, bytes: Buffer): Promise<void> {
	const stats = await handle.stat({ bigint: true });
	if (!stats.isFile() || stats.size !== BigInt(bytes.length)) throw new Error("INIT_WRITE_VERIFY_FAILED");
	const expected = createHash("sha256").update(bytes).digest("hex");
	const actual = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let offset = 0;
	for (;;) {
		const read = await handle.read(buffer, 0, buffer.length, offset);
		if (read.bytesRead === 0) break;
		actual.update(buffer.subarray(0, read.bytesRead));
		offset += read.bytesRead;
	}
	if (BigInt(offset) !== stats.size || actual.digest("hex") !== expected) {
		throw new Error("INIT_WRITE_VERIFY_FAILED");
	}
}

/** Capture the exact regular-file bytes and metadata to which an overwrite confirmation applies. */
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

async function createSiblingTemp(target: SafeInitTarget): Promise<{
	path: string;
	handle: FileHandle;
	dev: bigint;
	ino: bigint;
}> {
	const leaf = basename(target.target);
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const path = join(target.parent, `.${leaf}.q-init-${process.pid}-${randomBytes(16).toString("hex")}.tmp`);
		try {
			const handle = await open(
				path,
				fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
				0o600,
			);
			const stats = await handle.stat({ bigint: true });
			if (!stats.isFile()) {
				await handle.close().catch(() => undefined);
				throw new Error("INIT_WRITE_TEMP_NOT_REGULAR");
			}
			return { path, handle, dev: stats.dev, ino: stats.ino };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new Error("INIT_WRITE_TEMP_COLLISION");
}

async function unlinkIfExact(path: string, expected: { dev: bigint; ino: bigint }): Promise<boolean> {
	try {
		const current = await lstat(path, { bigint: true });
		if (current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) return false;
		await unlink(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}

/**
 * Atomically publish one planned init file from a durable sibling temporary.
 * Creates use link(2) for no-clobber publication. Overwrites validate the
 * confirmed inode/bytes immediately before rename(2); Node has no portable
 * compare-and-swap rename, so an uncooperative writer can still race in the
 * final syscall-sized interval, but it can never expose partial new bytes.
 */
export async function safelyWriteInitFile(
	input: SafeInitWriteInput,
	options: SafeInitWriteOptions = {},
): Promise<void> {
	if (input.action === "overwrite" && input.expectedIdentity === undefined) {
		throw new Error("INIT_WRITE_CONFIRMATION_IDENTITY_MISSING");
	}
	const bytes = Buffer.from(input.content, "utf8");
	const target = await safeTarget(input.projectRoot, input.path, input.action === "create");
	const temp = await createSiblingTemp(target);
	const paths = { targetPath: target.target, tempPath: temp.path };
	let published = false;
	let parentSynced = false;
	let targetHandle: FileHandle | undefined;
	try {
		await options.fault?.("after-temp-create", paths);
		await temp.handle.writeFile(bytes);
		await options.fault?.("after-temp-write", paths);
		await temp.handle.sync();
		await assertPreparedBytes(temp.handle, bytes);
		await options.fault?.("after-temp-sync", paths);

		if (input.action === "overwrite") {
			// Retain the previous contract that the confirmed file itself must be
			// writable, even though atomic publication only needs parent permission.
			targetHandle = await open(target.target, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
			const currentIdentity = await identityFromHandle(targetHandle, target);
			if (!sameFileIdentity(currentIdentity, input.expectedIdentity!)) throw new Error("INIT_WRITE_TARGET_CHANGED");
			// Preserve the confirmed file's ownership and permission bits. Failure is
			// pre-publication and therefore leaves the old file untouched.
			await temp.handle.chown(Number(currentIdentity.uid), Number(currentIdentity.gid));
			await temp.handle.chmod(Number(currentIdentity.mode & 0o7777n));
			await temp.handle.sync();
		}

		await options.fault?.("before-publish", paths);
		const currentParent = await safeTarget(input.projectRoot, input.path, false);
		if (!sameParent(target, currentParent)) throw new Error("INIT_WRITE_PARENT_CHANGED");
		if (input.action === "overwrite") {
			// Re-hash after the final injectable/concurrency window, then keep the
			// verified handle open until the atomic replacement has been issued.
			const finalIdentity = await identityFromHandle(targetHandle!, currentParent);
			if (!sameFileIdentity(finalIdentity, input.expectedIdentity!)) throw new Error("INIT_WRITE_TARGET_CHANGED");
			await assertPathBindsHandle(currentParent, targetHandle!);
			await rename(temp.path, target.target);
		} else {
			await link(temp.path, target.target);
		}
		published = true;
		await options.fault?.("after-publish", paths);

		const finalParent = await safeTarget(input.projectRoot, input.path, false);
		if (!sameParent(target, finalParent)) throw new Error("INIT_WRITE_PARENT_CHANGED");
		await assertPathBindsHandle(finalParent, temp.handle);
		if (!(await unlinkIfExact(temp.path, temp))) throw new Error("INIT_WRITE_TEMP_OWNERSHIP_LOST");
		await syncDirectory(target.parent);
		parentSynced = true;
		await options.fault?.("after-parent-sync", paths);
	} finally {
		await targetHandle?.close().catch(() => undefined);
		await temp.handle.close().catch(() => undefined);
		try {
			const removed = await unlinkIfExact(temp.path, temp);
			if (!parentSynced && (removed || published)) await syncDirectory(target.parent);
		} catch {
			// Never broaden cleanup beyond the exact temporary inode created here.
		}
	}
}
