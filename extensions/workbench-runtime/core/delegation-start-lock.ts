/**
 * Cross-process single-writer serialization for one project delegation.
 *
 * The fixed lock name is never opened for writing. A complete, fsynced owner
 * is first written beside it and then atomically committed with hard-link(2),
 * so contenders cannot observe an empty or partially written owner at the
 * publication path. The persisted name is retained for compatibility, but a
 * controller lease spans the whole checkout-writing lifecycle: admission,
 * PREPARED, worker execution, generation publication, and mechanical delivery.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { DELEGATION_TRANSACTION_ID_RE } from "./delegation-transaction.ts";

export const PROJECT_DELEGATION_START_LOCK_MAX_BYTES_V1 = 4_096 as const;
export const PROJECT_DELEGATION_START_LOCK_RECOVERY_ATTEMPTS_V1 = 2 as const;
export const PROJECT_DELEGATION_START_LOCK_RELATIVE_PATH_V1 =
	`${CONFIG_DIR_NAME}/workbench/delegation-start.lock` as const;

const TOKEN_RE = /^[a-f0-9]{32}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const BOOT_ID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PROCESS_START_TICKS_RE = /^(0|[1-9]\d*)$/;
const OWNER_FIELDS = [
	"schema_version",
	"kind",
	"project_root_hash",
	"delegation_id",
	"token",
	"process_id",
	"process_start_ticks",
	"boot_id",
	"acquired_at",
] as const;

export type ProjectDelegationStartLockErrorCodeV1 =
	| "conflict"
	| "invalid_input"
	| "invalid_record"
	| "storage_failure";

export interface ProjectDelegationStartLockErrorV1 {
	code: ProjectDelegationStartLockErrorCodeV1;
	message: string;
	point?: string;
}

export type ProjectDelegationStartLockResultV1<T> =
	| { ok: true; value: T }
	| { ok: false; error: ProjectDelegationStartLockErrorV1 };

export interface AcquireProjectDelegationStartLockInputV1 {
	project_root: string;
	delegation_id: string;
	now: string;
}

export interface ProjectDelegationStartLockLeaseV1 {
	schema_version: 1;
	/** Canonical real path used for every lock operation. */
	project_root: string;
	delegation_id: string;
	token: string;
	process_id: number;
	/** Linux /proc field 22, bound to this exact process incarnation. */
	process_start_ticks: string;
	/** Kernel boot identity, bound to the process-start tick namespace. */
	boot_id: string;
	acquired_at: string;
}

export interface ProjectDelegationStartLockOptionsV1 {
	/** Test seam; production uses process.pid. */
	process_id?: number;
	/** Test seam; production uses kill(pid, 0) and treats EPERM as alive. */
	is_process_alive?: (processId: number) => boolean;
	/** Test seams; production reads the current Linux boot and /proc process identity. */
	read_boot_id?: () => Promise<string | null>;
	read_process_start_ticks?: (processId: number) => Promise<string | null>;
	/** Test seam; must return 32 lowercase hexadecimal characters. */
	random_token?: () => string;
}

export interface ProjectDelegationStartLockOwnerV1 {
	schema_version: 1;
	kind: "project-delegation-start-lock-v1";
	project_root_hash: string;
	delegation_id: string;
	token: string;
	process_id: number;
	process_start_ticks: string;
	boot_id: string;
	acquired_at: string;
}

export type ProjectDelegationStartLockInspectionV1 =
	| { status: "absent" }
	| { status: "live" | "dead"; owner: ProjectDelegationStartLockOwnerV1; lease: ProjectDelegationStartLockLeaseV1 };

interface StartLockLayout {
	projectRoot: string;
	workbench: string;
	lock: string;
	projectRootHash: string;
}

function failure<T>(
	code: ProjectDelegationStartLockErrorCodeV1,
	message: string,
	point?: string,
): ProjectDelegationStartLockResultV1<T> {
	return { ok: false, error: { code, message, ...(point === undefined ? {} : { point }) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function isCanonicalTime(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 20 || value.length > 64 || !value.endsWith("Z")) return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isSafeProcessId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function contained(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`)
		&& !isAbsolute(fromRoot));
}

function hashProjectRoot(projectRoot: string): string {
	return createHash("sha256").update(projectRoot, "utf8").digest("hex");
}

function encodeOwner(owner: ProjectDelegationStartLockOwnerV1): Buffer | undefined {
	const bytes = Buffer.from(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
	return bytes.length <= PROJECT_DELEGATION_START_LOCK_MAX_BYTES_V1 ? bytes : undefined;
}

function normalizeOwner(value: unknown): ProjectDelegationStartLockOwnerV1 | undefined {
	if (!isRecord(value) || !exactFields(value, OWNER_FIELDS)
		|| value.schema_version !== 1 || value.kind !== "project-delegation-start-lock-v1"
		|| typeof value.project_root_hash !== "string" || !HASH_RE.test(value.project_root_hash)
		|| typeof value.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(value.delegation_id)
		|| typeof value.token !== "string" || !TOKEN_RE.test(value.token)
		|| !isSafeProcessId(value.process_id)
		|| typeof value.process_start_ticks !== "string" || !PROCESS_START_TICKS_RE.test(value.process_start_ticks)
		|| typeof value.boot_id !== "string" || !BOOT_ID_RE.test(value.boot_id)
		|| !isCanonicalTime(value.acquired_at)) return undefined;
	return {
		schema_version: 1,
		kind: "project-delegation-start-lock-v1",
		project_root_hash: value.project_root_hash,
		delegation_id: value.delegation_id,
		token: value.token,
		process_id: value.process_id,
		process_start_ticks: value.process_start_ticks,
		boot_id: value.boot_id,
		acquired_at: value.acquired_at,
	};
}

function parseCanonicalOwner(bytes: Uint8Array): ProjectDelegationStartLockOwnerV1 | undefined {
	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		return undefined;
	}
	const owner = normalizeOwner(decoded);
	const canonical = owner === undefined ? undefined : encodeOwner(owner);
	return canonical !== undefined && canonical.equals(Buffer.from(bytes)) ? owner : undefined;
}

function defaultIsProcessAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		if (isErrno(error, "ESRCH")) return false;
		// EPERM proves that a process exists. Unknown errors fail closed too.
		return true;
	}
}

async function defaultReadBootId(): Promise<string | null> {
	try {
		const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
		return BOOT_ID_RE.test(value) ? value : null;
	} catch {
		return null;
	}
}

async function defaultReadProcessStartTicks(processId: number): Promise<string | null> {
	if (!isSafeProcessId(processId)) return null;
	try {
		const raw = await readFile(`/proc/${processId}/stat`, "utf8");
		const commandEnd = raw.lastIndexOf(")");
		if (commandEnd < 0) return null;
		const fieldsAfterCommand = raw.slice(commandEnd + 1).trim().split(/\s+/);
		const startTicks = fieldsAfterCommand[19];
		return startTicks !== undefined && PROCESS_START_TICKS_RE.test(startTicks) ? startTicks : null;
	} catch {
		return null;
	}
}

async function currentBootId(options: ProjectDelegationStartLockOptionsV1): Promise<string | null> {
	try {
		const value = await (options.read_boot_id ?? defaultReadBootId)();
		return value !== null && BOOT_ID_RE.test(value) ? value : null;
	} catch {
		return null;
	}
}

async function currentProcessStartTicks(
	processId: number,
	options: ProjectDelegationStartLockOptionsV1,
): Promise<string | null> {
	try {
		const value = await (options.read_process_start_ticks ?? defaultReadProcessStartTicks)(processId);
		return value !== null && PROCESS_START_TICKS_RE.test(value) ? value : null;
	} catch {
		return null;
	}
}

async function inspectOwnerIdentity(
	owner: ProjectDelegationStartLockOwnerV1,
	options: ProjectDelegationStartLockOptionsV1,
): Promise<"live" | "dead" | "unproven"> {
	const bootId = await currentBootId(options);
	if (bootId === null) return "unproven";
	if (bootId !== owner.boot_id) return "dead";
	let alive: boolean;
	try {
		alive = (options.is_process_alive ?? defaultIsProcessAlive)(owner.process_id);
	} catch {
		return "unproven";
	}
	if (!alive) return "dead";
	const startTicks = await currentProcessStartTicks(owner.process_id, options);
	if (startTicks === null) return "unproven";
	return startTicks === owner.process_start_ticks ? "live" : "dead";
}

function processId(options: ProjectDelegationStartLockOptionsV1): number | undefined {
	return options.process_id ?? process.pid;
}

function randomToken(options: ProjectDelegationStartLockOptionsV1): string | undefined {
	try {
		const token = options.random_token?.() ?? randomBytes(16).toString("hex");
		return TOKEN_RE.test(token) ? token : undefined;
	} catch {
		return undefined;
	}
}

async function readBoundedRegularFile(path: string): Promise<Buffer> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
	const handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || before.size < 0n || before.size > BigInt(PROJECT_DELEGATION_START_LOCK_MAX_BYTES_V1)) {
			throw new Error("unsafe delegation start-lock owner");
		}
		const bytes = Buffer.allocUnsafe(Number(before.size));
		let offset = 0;
		while (offset < bytes.length) {
			const read = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (read.bytesRead <= 0) throw new Error("short delegation start-lock read");
			offset += read.bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
			|| before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
			throw new Error("delegation start-lock changed during read");
		}
		return bytes;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function writeCompleteCandidate(path: string, bytes: Uint8Array): Promise<void> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
	let complete = false;
	try {
		let offset = 0;
		while (offset < bytes.length) {
			const written = await handle.write(bytes, offset, bytes.length - offset, offset);
			if (written.bytesWritten <= 0) throw new Error("short delegation start-lock write");
			offset += written.bytesWritten;
		}
		await handle.sync();
		complete = true;
	} finally {
		await handle.close().catch(() => undefined);
		// This path was exclusively created by this call. Remove a partial
		// candidate here; callers never unlink a pre-existing foreign path.
		if (!complete) await unlink(path).catch(() => undefined);
	}
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function safeDirectory(path: string, root: string): Promise<boolean> {
	const stats = await lstat(path);
	if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
	const canonical = await realpath(path);
	return canonical === path && contained(root, canonical);
}

async function ensureLayout(projectRootInput: string): Promise<ProjectDelegationStartLockResultV1<StartLockLayout>> {
	if (typeof projectRootInput !== "string" || projectRootInput.length === 0 || projectRootInput.includes("\0")) {
		return failure("invalid_input", "project root is required", "layout");
	}
	let projectRoot: string;
	try {
		projectRoot = await realpath(resolve(projectRootInput));
		const stats = await lstat(projectRoot);
		if (!stats.isDirectory() || projectRoot === parse(projectRoot).root) {
			return failure("invalid_input", "project root must be a non-root directory", "layout");
		}
	} catch {
		return failure("invalid_input", "project root is unavailable", "layout");
	}

	const piDirectory = join(projectRoot, CONFIG_DIR_NAME);
	const workbench = join(piDirectory, "workbench");
	for (const directory of [piDirectory, workbench]) {
		try {
			await mkdir(directory, { mode: 0o700 });
		} catch (error) {
			if (!isErrno(error, "EEXIST")) return failure("storage_failure", "start-lock layout creation failed", "layout");
		}
		try {
			if (!(await safeDirectory(directory, projectRoot))) {
				return failure("invalid_record", "start-lock layout escapes the canonical project root", "layout");
			}
		} catch {
			return failure("invalid_record", "start-lock layout is unsafe", "layout");
		}
	}

	return {
		ok: true,
		value: {
			projectRoot,
			workbench,
			lock: join(workbench, "delegation-start.lock"),
			projectRootHash: hashProjectRoot(projectRoot),
		},
	};
}

async function existingLayout(projectRootInput: string): Promise<ProjectDelegationStartLockResultV1<StartLockLayout>> {
	if (typeof projectRootInput !== "string" || projectRootInput.length === 0 || projectRootInput.includes("\0")) {
		return failure("invalid_input", "project root is required", "layout");
	}
	let projectRoot: string;
	try {
		projectRoot = await realpath(resolve(projectRootInput));
		const stats = await lstat(projectRoot);
		if (!stats.isDirectory() || projectRoot === parse(projectRoot).root) {
			return failure("invalid_input", "project root must be a non-root directory", "layout");
		}
		const workbench = join(projectRoot, CONFIG_DIR_NAME, "workbench");
		if (!(await safeDirectory(join(projectRoot, CONFIG_DIR_NAME), projectRoot))
			|| !(await safeDirectory(workbench, projectRoot))) {
			return failure("invalid_record", "start-lock layout is unsafe", "layout");
		}
		return {
			ok: true,
			value: {
				projectRoot,
				workbench,
				lock: join(workbench, "delegation-start.lock"),
				projectRootHash: hashProjectRoot(projectRoot),
			},
		};
	} catch {
		return failure("invalid_record", "start-lock layout is unavailable", "layout");
	}
}

async function recoverObservedOwner(
	layout: StartLockLayout,
	observed: Buffer,
	options: ProjectDelegationStartLockOptionsV1,
): Promise<ProjectDelegationStartLockResultV1<void>> {
	const token = randomToken(options);
	if (token === undefined) return failure("storage_failure", "recovery token is invalid", "recover");
	const recovered = `${layout.lock}.recovered.${token}`;
	try {
		try {
			await lstat(recovered);
			return failure("conflict", "recovery destination already exists", "recover");
		} catch (error) {
			if (!isErrno(error, "ENOENT")) return failure("storage_failure", "recovery destination inspection failed", "recover");
		}
		await rename(layout.lock, recovered);
		await syncDirectory(layout.workbench);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return failure("conflict", "start lock changed before recovery", "recover");
		return failure("storage_failure", "start-lock recovery rename failed", "recover");
	}

	let recoveredBytes: Buffer;
	try {
		recoveredBytes = await readBoundedRegularFile(recovered);
	} catch {
		await link(recovered, layout.lock).then(() => syncDirectory(layout.workbench)).catch(() => undefined);
		return failure("conflict", "recovered start lock cannot be verified", "recover");
	}
	if (!recoveredBytes.equals(observed)) {
		await link(recovered, layout.lock).then(() => syncDirectory(layout.workbench)).catch(() => undefined);
		return failure("conflict", "start lock changed during recovery", "recover");
	}
	try {
		await unlink(recovered);
		await syncDirectory(layout.workbench);
		return { ok: true, value: undefined };
	} catch {
		return failure("storage_failure", "recovered start-lock cleanup failed", "recover");
	}
}

async function inspectContention(
	layout: StartLockLayout,
	options: ProjectDelegationStartLockOptionsV1,
): Promise<ProjectDelegationStartLockResultV1<"retry" | "recover"> & { observed?: Buffer }> {
	let stats: Awaited<ReturnType<typeof lstat>>;
	try {
		stats = await lstat(layout.lock);
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: "retry" }
			: failure("storage_failure", "start-lock inspection failed", "contend");
	}
	if (!stats.isFile() || stats.isSymbolicLink() || stats.size > PROJECT_DELEGATION_START_LOCK_MAX_BYTES_V1) {
		return failure("invalid_record", "start-lock path is not a bounded regular file", "contend");
	}
	let bytes: Buffer;
	try {
		bytes = await readBoundedRegularFile(layout.lock);
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: "retry" }
			: failure("conflict", "start-lock owner changed during inspection", "contend");
	}
	const owner = parseCanonicalOwner(bytes);
	if (owner === undefined) return failure("invalid_record", "start-lock owner is malformed and cannot be recovered safely", "contend");
	if (owner.project_root_hash !== layout.projectRootHash) {
		return failure("invalid_record", "start-lock owner belongs to another project root", "contend");
	}
	const identity = await inspectOwnerIdentity(owner, options);
	if (identity === "unproven") {
		return failure("conflict", "start-lock owner liveness cannot be established", "contend");
	}
	return identity === "live"
		? failure("conflict", "another process owns the project delegation start lock", "contend")
		: { ok: true, value: "recover", observed: bytes };
}

/** Strict read-only owner/liveness proof for the PREPARED-before-owner crash window. */
export async function inspectProjectDelegationStartLockV1(
	projectRoot: string,
	options: ProjectDelegationStartLockOptionsV1 = {},
): Promise<ProjectDelegationStartLockResultV1<ProjectDelegationStartLockInspectionV1>> {
	const layout = await existingLayout(projectRoot);
	if (!layout.ok) return layout;
	let bytes: Buffer;
	try {
		bytes = await readBoundedRegularFile(layout.value.lock);
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: { status: "absent" } }
			: failure("storage_failure", "start-lock owner cannot be read", "inspect");
	}
	const owner = parseCanonicalOwner(bytes);
	if (owner === undefined || owner.project_root_hash !== layout.value.projectRootHash) {
		return failure("invalid_record", "start-lock owner is invalid", "inspect");
	}
	const identity = await inspectOwnerIdentity(owner, options);
	if (identity === "unproven") {
		return failure("conflict", "start-lock owner liveness cannot be established", "inspect");
	}
	return {
		ok: true,
		value: {
			status: identity,
			owner,
			lease: {
				schema_version: 1,
				project_root: layout.value.projectRoot,
				delegation_id: owner.delegation_id,
				token: owner.token,
				process_id: owner.process_id,
				process_start_ticks: owner.process_start_ticks,
				boot_id: owner.boot_id,
				acquired_at: owner.acquired_at,
			},
		},
	};
}

/**
 * Acquire the one project-wide delegation lifecycle writer lock.
 *
 * A valid live owner conflicts. Only a canonical dead owner is recovered;
 * malformed fixed evidence fails closed because it cannot prove ownership.
 */
export async function acquireProjectDelegationStartLockV1(
	input: AcquireProjectDelegationStartLockInputV1,
	options: ProjectDelegationStartLockOptionsV1 = {},
): Promise<ProjectDelegationStartLockResultV1<ProjectDelegationStartLockLeaseV1>> {
	if (!isRecord(input) || typeof input.delegation_id !== "string"
		|| !DELEGATION_TRANSACTION_ID_RE.test(input.delegation_id) || !isCanonicalTime(input.now)) {
		return failure("invalid_input", "delegation id and canonical acquisition time are required", "input");
	}
	const ownerProcessId = processId(options);
	if (!isSafeProcessId(ownerProcessId)) return failure("invalid_input", "process id is invalid", "input");
	const ownerBootId = await currentBootId(options);
	const ownerProcessStartTicks = await currentProcessStartTicks(ownerProcessId, options);
	if (ownerBootId === null || ownerProcessStartTicks === null) {
		return failure("invalid_input", "exact process identity is unavailable", "input");
	}
	const layout = await ensureLayout(input.project_root);
	if (!layout.ok) return layout;

	for (let attempt = 0; attempt <= PROJECT_DELEGATION_START_LOCK_RECOVERY_ATTEMPTS_V1; attempt += 1) {
		const token = randomToken(options);
		if (token === undefined) return failure("storage_failure", "start-lock token is invalid", "candidate");
		const owner: ProjectDelegationStartLockOwnerV1 = {
			schema_version: 1,
			kind: "project-delegation-start-lock-v1",
			project_root_hash: layout.value.projectRootHash,
			delegation_id: input.delegation_id,
			token,
			process_id: ownerProcessId,
			process_start_ticks: ownerProcessStartTicks,
			boot_id: ownerBootId,
			acquired_at: input.now,
		};
		const encoded = encodeOwner(owner);
		if (encoded === undefined) return failure("storage_failure", "start-lock owner exceeds its bound", "candidate");
		const candidate = `${layout.value.lock}.candidate.${token}`;
		let candidateComplete = false;
		let committed = false;
		try {
			await writeCompleteCandidate(candidate, encoded);
			candidateComplete = true;
			const candidateBytes = await readBoundedRegularFile(candidate);
			const candidateOwner = parseCanonicalOwner(candidateBytes);
			if (candidateOwner === undefined || candidateOwner.token !== token || !candidateBytes.equals(encoded)) {
				throw new Error("candidate readback mismatch");
			}
			await link(candidate, layout.value.lock);
			committed = true;
			await syncDirectory(layout.value.workbench);
			await unlink(candidate);
			await syncDirectory(layout.value.workbench);
			const fixedBytes = await readBoundedRegularFile(layout.value.lock);
			const fixedOwner = parseCanonicalOwner(fixedBytes);
			if (fixedOwner === undefined || fixedOwner.token !== token || fixedOwner.process_id !== ownerProcessId
				|| fixedOwner.process_start_ticks !== ownerProcessStartTicks || fixedOwner.boot_id !== ownerBootId
				|| !fixedBytes.equals(encoded)) throw new Error("committed owner readback mismatch");
			return {
				ok: true,
				value: {
					schema_version: 1,
					project_root: layout.value.projectRoot,
					delegation_id: input.delegation_id,
					token,
					process_id: ownerProcessId,
					process_start_ticks: ownerProcessStartTicks,
					boot_id: ownerBootId,
					acquired_at: input.now,
				},
			};
		} catch (error) {
			if (candidateComplete) await unlink(candidate).catch(() => undefined);
			if (committed) {
				const provisionalLease: ProjectDelegationStartLockLeaseV1 = {
					schema_version: 1,
					project_root: layout.value.projectRoot,
					delegation_id: input.delegation_id,
					token,
					process_id: ownerProcessId,
					process_start_ticks: ownerProcessStartTicks,
					boot_id: ownerBootId,
					acquired_at: input.now,
				};
				await releaseProjectDelegationStartLockV1(provisionalLease).catch(() => undefined);
				return failure("storage_failure", "committed start-lock owner could not be verified", "commit");
			}
			if (!isErrno(error, "EEXIST")) {
				return failure("storage_failure", "complete start-lock candidate publication failed", "candidate");
			}
		}

		const contention = await inspectContention(layout.value, options);
		if (!contention.ok) return contention;
		if (contention.value === "retry") continue;
		if (attempt >= PROJECT_DELEGATION_START_LOCK_RECOVERY_ATTEMPTS_V1 || contention.observed === undefined) {
			return failure("conflict", "start-lock recovery attempts were exhausted", "recover");
		}
		const recovered = await recoverObservedOwner(layout.value, contention.observed, options);
		if (!recovered.ok) {
			if (recovered.error.code === "conflict" && recovered.error.message.includes("changed before recovery")) continue;
			return recovered;
		}
	}
	return failure("conflict", "start-lock acquisition attempts were exhausted", "acquire");
}

/** Token-checked release. Only an already absent fixed path is idempotent. */
export async function releaseProjectDelegationStartLockV1(
	lease: ProjectDelegationStartLockLeaseV1,
	_options: ProjectDelegationStartLockOptionsV1 = {},
): Promise<ProjectDelegationStartLockResultV1<void>> {
	if (!isRecord(lease) || lease.schema_version !== 1 || typeof lease.project_root !== "string"
		|| typeof lease.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(lease.delegation_id)
		|| typeof lease.token !== "string" || !TOKEN_RE.test(lease.token)
		|| !isSafeProcessId(lease.process_id)
		|| typeof lease.process_start_ticks !== "string" || !PROCESS_START_TICKS_RE.test(lease.process_start_ticks)
		|| typeof lease.boot_id !== "string" || !BOOT_ID_RE.test(lease.boot_id)
		|| !isCanonicalTime(lease.acquired_at)) {
		return failure("invalid_input", "start-lock lease is invalid", "release");
	}
	const layout = await existingLayout(lease.project_root);
	if (!layout.ok) return layout;
	if (layout.value.projectRoot !== lease.project_root) {
		return failure("invalid_input", "lease project root is not canonical", "release");
	}

	let observed: Buffer;
	try {
		const stats = await lstat(layout.value.lock);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size > PROJECT_DELEGATION_START_LOCK_MAX_BYTES_V1) {
			return failure("invalid_record", "start-lock path is not a bounded regular file", "release");
		}
		observed = await readBoundedRegularFile(layout.value.lock);
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: undefined }
			: failure("storage_failure", "start-lock owner cannot be read for release", "release");
	}
	const owner = parseCanonicalOwner(observed);
	if (owner === undefined || owner.project_root_hash !== layout.value.projectRootHash) {
		return failure("invalid_record", "start-lock owner is invalid", "release");
	}
	if (owner.token !== lease.token || owner.delegation_id !== lease.delegation_id
		|| owner.process_id !== lease.process_id || owner.process_start_ticks !== lease.process_start_ticks
		|| owner.boot_id !== lease.boot_id || owner.acquired_at !== lease.acquired_at) {
		return failure("conflict", "start-lock lease does not own the fixed lock", "release");
	}

	const releasing = `${layout.value.lock}.release.${lease.token}`;
	try {
		try {
			await lstat(releasing);
			return failure("conflict", "start-lock release destination already exists", "release");
		} catch (error) {
			if (!isErrno(error, "ENOENT")) return failure("storage_failure", "release destination inspection failed", "release");
		}
		await rename(layout.value.lock, releasing);
		await syncDirectory(layout.value.workbench);
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: undefined }
			: failure("storage_failure", "start-lock release rename failed", "release");
	}

	let releasedBytes: Buffer;
	try {
		releasedBytes = await readBoundedRegularFile(releasing);
	} catch {
		await link(releasing, layout.value.lock).then(() => syncDirectory(layout.value.workbench)).catch(() => undefined);
		return failure("conflict", "renamed start-lock owner cannot be verified", "release");
	}
	const releasedOwner = parseCanonicalOwner(releasedBytes);
	if (releasedOwner === undefined || releasedOwner.token !== lease.token || !releasedBytes.equals(observed)) {
		await link(releasing, layout.value.lock).then(() => syncDirectory(layout.value.workbench)).catch(() => undefined);
		return failure("conflict", "foreign start lock was not released", "release");
	}
	try {
		await unlink(releasing);
		await syncDirectory(layout.value.workbench);
		return { ok: true, value: undefined };
	} catch {
		return failure("storage_failure", "released start-lock cleanup failed", "release");
	}
}

/** Acquire, run one operation, and always attempt token-checked release. */
export async function withProjectDelegationStartLockV1<T>(
	input: AcquireProjectDelegationStartLockInputV1,
	operation: (lease: ProjectDelegationStartLockLeaseV1) => T | Promise<T>,
	options: ProjectDelegationStartLockOptionsV1 = {},
): Promise<ProjectDelegationStartLockResultV1<T>> {
	const acquired = await acquireProjectDelegationStartLockV1(input, options);
	if (!acquired.ok) return acquired;
	let value: T;
	try {
		value = await operation(acquired.value);
	} catch (error) {
		const released = await releaseProjectDelegationStartLockV1(acquired.value, options);
		if (!released.ok) throw new AggregateError([error, released.error], "operation and start-lock release both failed");
		throw error;
	}
	const released = await releaseProjectDelegationStartLockV1(acquired.value, options);
	return released.ok ? { ok: true, value } : released;
}
