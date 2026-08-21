/**
 * ChangeSet v2 full-file identities.
 *
 * This module intentionally has no shell, network, clock, or Pi dependency.
 * It hashes regular files incrementally and retains only bounded identity
 * facts. Callers may lower, but never raise, the exported hard limits.
 */

import { constants, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, resolve, sep } from "node:path";

export const STREAMING_IDENTITY_SCHEMA_VERSION = 2 as const;
export const STREAMING_IDENTITY_MAX_PATHS = 500;
export const STREAMING_IDENTITY_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const STREAMING_IDENTITY_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const STREAMING_IDENTITY_MAX_PATH_BYTES = 400;
export const STREAMING_IDENTITY_CHUNK_BYTES = 64 * 1024;

export const STREAMING_IDENTITY_FAULT_POINTS = [
	"path_before_stat",
	"path_before_realpath",
	"open",
	"handle_before_stat",
	"read",
	"after_hash",
	"handle_after_stat",
	"path_after_stat",
	"path_after_realpath",
	"close",
] as const;

export type StreamingIdentityFaultPoint = typeof STREAMING_IDENTITY_FAULT_POINTS[number];

export type StreamingIdentityErrorCode =
	| "invalid_input"
	| "invalid_path"
	| "duplicate_path"
	| "path_count_overflow"
	| "file_bytes_overflow"
	| "total_bytes_overflow"
	| "path_symlink"
	| "path_not_regular"
	| "path_escape"
	| "stat_failed"
	| "open_failed"
	| "read_failed"
	| "close_failed"
	| "path_after_failed"
	| "unstable";

export interface StreamingIdentityError {
	code: StreamingIdentityErrorCode;
	message: string;
	path?: string;
}

export interface StreamingIdentityMeter {
	paths_attempted: number;
	paths_completed: number;
	bytes_read: number;
}

export interface StreamingIdentityStat {
	dev: string;
	ino: string;
	mtime_ns: string;
	ctime_ns: string;
}

export interface StreamingMissingIdentity {
	schema_version: typeof STREAMING_IDENTITY_SCHEMA_VERSION;
	kind: "missing";
	path: string;
}

export interface StreamingFileIdentity {
	schema_version: typeof STREAMING_IDENTITY_SCHEMA_VERSION;
	kind: "file";
	path: string;
	byte_size: number;
	sha256: string;
	stat: StreamingIdentityStat;
}

export type StreamingPathIdentity = StreamingMissingIdentity | StreamingFileIdentity;

export interface StreamingIdentityLimits {
	max_paths?: number;
	max_total_bytes?: number;
	max_file_bytes?: number;
}

export interface StreamingIdentityFaultContext {
	path: string;
	offset?: number;
	requested_bytes?: number;
}

export interface StreamingIdentityHooks {
	fault?(point: StreamingIdentityFaultPoint, context: Readonly<StreamingIdentityFaultContext>): void | Promise<void>;
}

export interface StreamingIdentityFileHandle {
	stat(): Promise<BigIntStats>;
	read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
	close(): Promise<void>;
}

export interface StreamingIdentityAdapter {
	lstat(path: string): Promise<BigIntStats | null>;
	realpath(path: string): Promise<string | null>;
	openNoFollow(path: string): Promise<StreamingIdentityFileHandle>;
}

export interface CaptureStreamingIdentitiesInput {
	project_root: string;
	paths: readonly string[];
	limits?: Readonly<StreamingIdentityLimits>;
	meter?: StreamingIdentityMeter;
	adapter?: StreamingIdentityAdapter;
	hooks?: StreamingIdentityHooks;
}

export type CaptureStreamingIdentitiesResult =
	| { ok: true; identities: readonly StreamingPathIdentity[]; meter: Readonly<StreamingIdentityMeter> }
	| { ok: false; error: StreamingIdentityError; meter: Readonly<StreamingIdentityMeter> };

const ERROR_MESSAGES: Readonly<Record<StreamingIdentityErrorCode, string>> = Object.freeze({
	invalid_input: "streaming identity input is invalid",
	invalid_path: "project-relative path is not strict canonical form",
	duplicate_path: "streaming identity path is duplicated",
	path_count_overflow: "streaming identity path-count limit exceeded",
	file_bytes_overflow: "streaming identity per-file byte limit exceeded",
	total_bytes_overflow: "streaming identity total-byte limit exceeded",
	path_symlink: "streaming identity target is a symbolic link",
	path_not_regular: "streaming identity target is not a regular file",
	path_escape: "streaming identity path escapes the project root",
	stat_failed: "streaming identity stat operation failed",
	open_failed: "streaming identity open operation failed",
	read_failed: "streaming identity read operation failed",
	close_failed: "streaming identity close operation failed",
	path_after_failed: "streaming identity post-read path verification failed",
	unstable: "streaming identity source changed during capture",
});

const CLOSE_FAILED_SENTINEL = Object.freeze({ kind: "streaming_identity_close_failed" });

function resultMeter(meter: StreamingIdentityMeter): Readonly<StreamingIdentityMeter> {
	return Object.freeze({ ...meter });
}

function failure(
	code: StreamingIdentityErrorCode,
	meter: StreamingIdentityMeter,
	path?: string,
): CaptureStreamingIdentitiesResult {
	return {
		ok: false,
		error: Object.freeze({ code, message: ERROR_MESSAGES[code], ...(path === undefined ? {} : { path }) }),
		meter: resultMeter(meter),
	};
}

function isSafeCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedPositive(value: unknown, hardMaximum: number): number | undefined {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value > 0
		&& value <= hardMaximum
		? value
		: undefined;
}

function normalizeLimits(limits: Readonly<StreamingIdentityLimits> | undefined): Required<StreamingIdentityLimits> | undefined {
	if (limits !== undefined && (limits === null || typeof limits !== "object" || Array.isArray(limits))) return undefined;
	const max_paths = limits?.max_paths ?? STREAMING_IDENTITY_MAX_PATHS;
	const max_total_bytes = limits?.max_total_bytes ?? STREAMING_IDENTITY_MAX_TOTAL_BYTES;
	const max_file_bytes = limits?.max_file_bytes ?? STREAMING_IDENTITY_MAX_FILE_BYTES;
	if (!boundedPositive(max_paths, STREAMING_IDENTITY_MAX_PATHS)
		|| !boundedPositive(max_total_bytes, STREAMING_IDENTITY_MAX_TOTAL_BYTES)
		|| !boundedPositive(max_file_bytes, STREAMING_IDENTITY_MAX_FILE_BYTES)) return undefined;
	return { max_paths, max_total_bytes, max_file_bytes };
}

/** Strict portable project-relative path accepted by ChangeSet v2. */
export function isStrictStreamingIdentityPath(path: unknown): path is string {
	if (typeof path !== "string" || path.length === 0 || Buffer.byteLength(path, "utf8") > STREAMING_IDENTITY_MAX_PATH_BYTES) return false;
	if (isAbsolute(path) || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)) return false;
	if (path === "." || path.startsWith("./") || path.endsWith("/") || path.includes("//")) return false;
	if (posix.normalize(path) !== path) return false;
	return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function nodeErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/** Production Node adapter. The final component is opened without symlink following when supported. */
export function createNodeStreamingIdentityAdapter(): StreamingIdentityAdapter {
	return {
		async lstat(path) {
			try {
				return await lstat(path, { bigint: true });
			} catch (error) {
				if (nodeErrorCode(error) === "ENOENT") return null;
				throw error;
			}
		},
		async realpath(path) {
			try {
				return await realpath(path);
			} catch (error) {
				if (nodeErrorCode(error) === "ENOENT") return null;
				throw error;
			}
		},
		async openNoFollow(path) {
			const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
			const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
			const handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
			return {
				stat: () => handle.stat({ bigint: true }),
				read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
				close: () => handle.close(),
			};
		},
	};
}

function safeByteSize(stats: BigIntStats): number | undefined {
	return stats.size >= 0n && stats.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(stats.size) : undefined;
}

function normalizedStat(stats: BigIntStats): StreamingIdentityStat | undefined {
	if (stats.dev < 0n || stats.ino < 0n || stats.mtimeNs < 0n || stats.ctimeNs < 0n) return undefined;
	return Object.freeze({
		dev: stats.dev.toString(10),
		ino: stats.ino.toString(10),
		mtime_ns: stats.mtimeNs.toString(10),
		ctime_ns: stats.ctimeNs.toString(10),
	});
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
	return left.isFile() === right.isFile()
		&& left.isSymbolicLink() === right.isSymbolicLink()
		&& left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

function contained(rootReal: string, targetReal: string): boolean {
	return targetReal === rootReal || targetReal.startsWith(`${rootReal}${sep}`);
}

async function callFault(
	hooks: StreamingIdentityHooks | undefined,
	point: StreamingIdentityFaultPoint,
	path: string,
	offset?: number,
	requested_bytes?: number,
): Promise<void> {
	await hooks?.fault?.(point, Object.freeze({
		path,
		...(offset === undefined ? {} : { offset }),
		...(requested_bytes === undefined ? {} : { requested_bytes }),
	}));
}

async function deepestExistingRealpath(adapter: StreamingIdentityAdapter, absolute: string): Promise<string | null> {
	let current = absolute;
	for (;;) {
		const found = await adapter.realpath(current);
		if (found !== null) return found;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function identityEqualUnchecked(left: StreamingPathIdentity, right: StreamingPathIdentity): boolean {
	if (left.schema_version !== right.schema_version || left.kind !== right.kind || left.path !== right.path) return false;
	if (left.kind === "missing" || right.kind === "missing") return left.kind === right.kind;
	return left.byte_size === right.byte_size
		&& left.sha256 === right.sha256
		&& left.stat.dev === right.stat.dev
		&& left.stat.ino === right.stat.ino
		&& left.stat.mtime_ns === right.stat.mtime_ns
		&& left.stat.ctime_ns === right.stat.ctime_ns;
}

/** Canonical equality for later journal and ChangeSet chain checks. */
export function streamingIdentityEqual(left: StreamingPathIdentity, right: StreamingPathIdentity): boolean {
	return identityEqualUnchecked(left, right);
}

interface CaptureOneContext {
	rootReal: string;
	path: string;
	absolute: string;
	adapter: StreamingIdentityAdapter;
	hooks?: StreamingIdentityHooks;
	meter: StreamingIdentityMeter;
	maxFileBytes: number;
	maxTotalBytes: number;
	callBytes: number;
}

type CaptureOneResult =
	| { ok: true; identity: StreamingPathIdentity; callBytes: number }
	| { ok: false; code: StreamingIdentityErrorCode };

async function captureOne(context: CaptureOneContext): Promise<CaptureOneResult> {
	const { rootReal, path, absolute, adapter, hooks, meter } = context;
	let beforePath: BigIntStats | null;
	try {
		await callFault(hooks, "path_before_stat", path);
		beforePath = await adapter.lstat(absolute);
	} catch {
		return { ok: false, code: "stat_failed" };
	}

	if (beforePath === null) {
		let ancestorReal: string | null;
		try {
			await callFault(hooks, "path_before_realpath", path);
			ancestorReal = await deepestExistingRealpath(adapter, dirname(absolute));
		} catch {
			return { ok: false, code: "stat_failed" };
		}
		if (ancestorReal === null || !contained(rootReal, ancestorReal)) return { ok: false, code: "path_escape" };
		try {
			await callFault(hooks, "path_after_realpath", path);
			const afterAncestorReal = await deepestExistingRealpath(adapter, dirname(absolute));
			if (afterAncestorReal === null || !contained(rootReal, afterAncestorReal)) return { ok: false, code: "path_escape" };
			await callFault(hooks, "path_after_stat", path);
			if (await adapter.lstat(absolute) !== null) return { ok: false, code: "unstable" };
			return {
				ok: true,
				identity: Object.freeze({ schema_version: STREAMING_IDENTITY_SCHEMA_VERSION, kind: "missing", path }),
				callBytes: context.callBytes,
			};
		} catch {
			return { ok: false, code: "path_after_failed" };
		}
	}
	if (beforePath.isSymbolicLink()) return { ok: false, code: "path_symlink" };
	if (!beforePath.isFile()) return { ok: false, code: "path_not_regular" };

	let beforeReal: string | null;
	try {
		await callFault(hooks, "path_before_realpath", path);
		beforeReal = await adapter.realpath(absolute);
	} catch {
		return { ok: false, code: "stat_failed" };
	}
	if (beforeReal === null) return { ok: false, code: "unstable" };
	if (!contained(rootReal, beforeReal)) return { ok: false, code: "path_escape" };

	let handle: StreamingIdentityFileHandle;
	try {
		await callFault(hooks, "open", path);
		handle = await adapter.openNoFollow(absolute);
	} catch {
		return { ok: false, code: "open_failed" };
	}

	let captured: CaptureOneResult;
	try {
		let opened: BigIntStats;
		try {
			await callFault(hooks, "handle_before_stat", path);
			opened = await handle.stat();
		} catch {
			captured = { ok: false, code: "stat_failed" };
			return captured;
		}
		if (!opened.isFile() || opened.isSymbolicLink() || !sameStat(beforePath, opened)) {
			captured = { ok: false, code: "unstable" };
			return captured;
		}
		const size = safeByteSize(opened);
		const stat = normalizedStat(opened);
		if (size === undefined || stat === undefined) {
			captured = { ok: false, code: "stat_failed" };
			return captured;
		}
		if (size > context.maxFileBytes) {
			captured = { ok: false, code: "file_bytes_overflow" };
			return captured;
		}
		if (context.callBytes + size > context.maxTotalBytes) {
			captured = { ok: false, code: "total_bytes_overflow" };
			return captured;
		}

		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(Math.min(STREAMING_IDENTITY_CHUNK_BYTES, Math.max(size, 1)));
		let offset = 0;
		while (offset < size) {
			const requested = Math.min(chunk.length, size - offset);
			let bytesRead: number;
			try {
				await callFault(hooks, "read", path, offset, requested);
				({ bytesRead } = await handle.read(chunk, 0, requested, offset));
			} catch {
				captured = { ok: false, code: "read_failed" };
				return captured;
			}
			if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > requested) {
				captured = { ok: false, code: "unstable" };
				return captured;
			}
			hash.update(chunk.subarray(0, bytesRead));
			offset += bytesRead;
			meter.bytes_read += bytesRead;
			context.callBytes += bytesRead;
		}
		try {
			await callFault(hooks, "after_hash", path);
		} catch {
			captured = { ok: false, code: "unstable" };
			return captured;
		}

		let afterHandle: BigIntStats;
		try {
			await callFault(hooks, "handle_after_stat", path);
			afterHandle = await handle.stat();
		} catch {
			captured = { ok: false, code: "stat_failed" };
			return captured;
		}
		if (!sameStat(opened, afterHandle)) {
			captured = { ok: false, code: "unstable" };
			return captured;
		}

		let afterReal: string | null;
		try {
			await callFault(hooks, "path_after_realpath", path);
			afterReal = await adapter.realpath(absolute);
		} catch {
			captured = { ok: false, code: "path_after_failed" };
			return captured;
		}
		if (afterReal === null || afterReal !== beforeReal || !contained(rootReal, afterReal)) {
			captured = { ok: false, code: "unstable" };
			return captured;
		}
		let afterPath: BigIntStats | null;
		try {
			await callFault(hooks, "path_after_stat", path);
			afterPath = await adapter.lstat(absolute);
		} catch {
			captured = { ok: false, code: "path_after_failed" };
			return captured;
		}
		if (afterPath === null || !sameStat(afterHandle, afterPath)) {
			captured = { ok: false, code: "unstable" };
			return captured;
		}

		captured = {
			ok: true,
			identity: Object.freeze({
				schema_version: STREAMING_IDENTITY_SCHEMA_VERSION,
				kind: "file",
				path,
				byte_size: size,
				sha256: hash.digest("hex"),
				stat,
			}),
			callBytes: context.callBytes,
		};
		return captured;
	} finally {
		let closeFailed = false;
		try {
			await callFault(hooks, "close", path);
		} catch {
			closeFailed = true;
		}
		try {
			await handle.close();
		} catch {
			closeFailed = true;
		}
		// A throw from finally deliberately overrides any pending return. The
		// public entry point catches this private sentinel and emits a closed
		// structured result, so a close failure can never publish an identity.
		if (closeFailed) throw CLOSE_FAILED_SENTINEL;
	}
}

/**
 * Capture a closed, deterministic v2 identity set. Any failure returns no
 * identities; the meter remains an honest account of bytes already read.
 */
export async function captureStreamingIdentities(
	input: CaptureStreamingIdentitiesInput,
): Promise<CaptureStreamingIdentitiesResult> {
	const fallbackMeter: StreamingIdentityMeter = { paths_attempted: 0, paths_completed: 0, bytes_read: 0 };
	if (!input || typeof input !== "object" || typeof input.project_root !== "string" || !Array.isArray(input.paths)) {
		return failure("invalid_input", fallbackMeter);
	}
	const meter = input.meter ?? fallbackMeter;
	if (!isSafeCounter(meter.paths_attempted) || !isSafeCounter(meter.paths_completed) || !isSafeCounter(meter.bytes_read)) {
		return failure("invalid_input", fallbackMeter);
	}
	if (meter.paths_completed > meter.paths_attempted) return failure("invalid_input", fallbackMeter);
	const limits = normalizeLimits(input.limits);
	if (!limits) return failure("invalid_input", meter);
	if (meter.paths_attempted > limits.max_paths
		|| input.paths.length > limits.max_paths - meter.paths_attempted) return failure("path_count_overflow", meter);
	if (meter.bytes_read > limits.max_total_bytes) return failure("total_bytes_overflow", meter);

	const paths = [...input.paths];
	const seen = new Set<string>();
	for (const path of paths) {
		if (!isStrictStreamingIdentityPath(path)) return failure("invalid_path", meter, typeof path === "string" ? path.slice(0, STREAMING_IDENTITY_MAX_PATH_BYTES) : undefined);
		if (seen.has(path)) return failure("duplicate_path", meter, path);
		seen.add(path);
	}
	paths.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));

	const rootAbsolute = resolve(input.project_root);
	const adapter = input.adapter ?? createNodeStreamingIdentityAdapter();
	let rootReal: string | null;
	try {
		rootReal = await adapter.realpath(rootAbsolute);
	} catch {
		return failure("stat_failed", meter);
	}
	if (rootReal === null || !isAbsolute(rootReal)) return failure("stat_failed", meter);

	const identities: StreamingPathIdentity[] = [];
	let callBytes = meter.bytes_read;
	for (const path of paths) {
		meter.paths_attempted += 1;
		const absolute = resolve(rootAbsolute, ...path.split("/"));
		if (absolute === rootAbsolute || !absolute.startsWith(`${rootAbsolute}${sep}`)) return failure("path_escape", meter, path);
		let captured: CaptureOneResult;
		try {
			captured = await captureOne({
				rootReal,
				path,
				absolute,
				adapter,
				hooks: input.hooks,
				meter,
				maxFileBytes: limits.max_file_bytes,
				maxTotalBytes: limits.max_total_bytes,
				callBytes,
			});
		} catch (error) {
			return failure(error === CLOSE_FAILED_SENTINEL ? "close_failed" : "read_failed", meter, path);
		}
		if (!captured.ok) return failure(captured.code, meter, path);
		callBytes = captured.callBytes;
		identities.push(captured.identity);
		meter.paths_completed += 1;
	}
	return { ok: true, identities: Object.freeze(identities), meter: resultMeter(meter) };
}
