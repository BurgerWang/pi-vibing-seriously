/**
 * ChangeSet v2 worker write journal.
 *
 * A journal is mutable only while OPEN. Every mutation is serialized by a
 * token-owned per-delegation lock and uses an exact revision CAS. File
 * identities come from streaming-identity.ts and therefore hash every byte.
 * The journal deliberately stores no tool input, patch, file content, process
 * output, or raw storage error.
 */

import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";

import {
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
} from "./delegation-transaction.ts";
import {
	captureStreamingIdentities,
	createNodeStreamingIdentityAdapter,
	isStrictStreamingIdentityPath,
	STREAMING_IDENTITY_MAX_FILE_BYTES,
	STREAMING_IDENTITY_MAX_PATHS,
	STREAMING_IDENTITY_MAX_TOTAL_BYTES,
	STREAMING_IDENTITY_SCHEMA_VERSION,
	streamingIdentityEqual,
	type StreamingIdentityAdapter,
	type StreamingIdentityErrorCode,
	type StreamingIdentityHooks,
	type StreamingIdentityMeter,
	type StreamingPathIdentity,
} from "./streaming-identity.ts";

export const WRITE_JOURNAL_SCHEMA_VERSION = 2 as const;
export const WRITE_JOURNAL_MAX_UNIQUE_PATHS = 500 as const;
// The structural operation ceiling intentionally has headroom. It never
// raises the cumulative streaming ceiling: a successful completed operation
// consumes two identity-path attempts, so the default identity cap normally
// becomes authoritative first (after 250 completed operations).
export const WRITE_JOURNAL_MAX_OPERATIONS = 1_000 as const;
export const WRITE_JOURNAL_MAX_SERIALIZED_BYTES = 4 * 1024 * 1024;
export const WRITE_JOURNAL_MAX_REVISION = 100_000 as const;
export const WRITE_JOURNAL_LOCK_MAX_BYTES = 4_096 as const;
export const WRITE_JOURNAL_LOCK_RECOVERY_ATTEMPTS = 2 as const;

export const WRITE_JOURNAL_OPERATION_KINDS = ["edit", "write"] as const;
export type WriteJournalOperationKind = typeof WRITE_JOURNAL_OPERATION_KINDS[number];
export type WriteJournalOperationOutcome = "succeeded" | "failed";

export const WRITE_JOURNAL_STORAGE_FAULT_POINTS = [
	"layout.mkdir",
	"lock.acquire",
	"lock.owner.write",
	"lock.owner.read",
	"lock.recover.rename",
	"lock.recover.read",
	"lock.recover.unlink",
	"lock.release.rename",
	"lock.release.read",
	"lock.release.unlink",
	"record.read",
	"create.temp.write",
	"create.temp.read",
	"create.rename",
	"create.final.read",
	"begin.temp.write",
	"begin.temp.read",
	"begin.rename",
	"begin.final.read",
	"complete.temp.write",
	"complete.temp.read",
	"complete.rename",
	"complete.final.read",
	"seal.temp.write",
	"seal.temp.read",
	"seal.rename",
	"seal.final.read",
] as const;

export type WriteJournalStorageFaultPoint = typeof WRITE_JOURNAL_STORAGE_FAULT_POINTS[number];
type WriteJournalPublishPhase = "create" | "begin" | "complete" | "seal";

export interface WriteJournalLimits {
	max_unique_paths: number;
	max_operations: number;
	max_identity_paths: number;
	max_total_bytes: number;
	max_file_bytes: number;
	max_serialized_bytes: number;
}

export interface WriteJournalLimitsInput {
	max_unique_paths?: number;
	max_operations?: number;
	max_identity_paths?: number;
	max_total_bytes?: number;
	max_file_bytes?: number;
	max_serialized_bytes?: number;
}

export interface PendingWriteJournalOperation {
	sequence: number;
	operation_id: string;
	kind: WriteJournalOperationKind;
	path: string;
	status: "pending";
	before: StreamingPathIdentity;
}

export interface CompletedWriteJournalOperation {
	sequence: number;
	operation_id: string;
	kind: WriteJournalOperationKind;
	path: string;
	status: "completed";
	before: StreamingPathIdentity;
	after: StreamingPathIdentity;
	outcome: WriteJournalOperationOutcome;
}

export type WriteJournalOperation = PendingWriteJournalOperation | CompletedWriteJournalOperation;

export interface WorkerWriteJournalRecord {
	schema_version: typeof WRITE_JOURNAL_SCHEMA_VERSION;
	delegation_id: string;
	contract_hash: string;
	state: "OPEN" | "SEALED";
	revision: number;
	limits: WriteJournalLimits;
	meter: StreamingIdentityMeter;
	operations: readonly WriteJournalOperation[];
	journal_hash: string | null;
}

export type WriteJournalErrorCode =
	| "invalid_input"
	| "invalid_path"
	| "conflict"
	| "not_found"
	| "storage_failure"
	| "invalid_record"
	| "limit_exceeded"
	| "identity_failure";

export interface WriteJournalError {
	code: WriteJournalErrorCode;
	message: string;
	point?: WriteJournalStorageFaultPoint;
	identity_code?: StreamingIdentityErrorCode;
	current_revision?: number;
}

export type WriteJournalResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: WriteJournalError };

export interface WriteJournalStorageStat {
	kind: "file" | "directory" | "symlink" | "other";
	size: number;
}

/** Node-only storage boundary. Tests may inject a behaviorally equivalent adapter. */
export interface WriteJournalStorageAdapter {
	makeDirectory(path: string): Promise<void>;
	inspect(path: string): Promise<WriteJournalStorageStat>;
	realpath(path: string): Promise<string>;
	write(path: string, bytes: Uint8Array, exclusive: boolean): Promise<void>;
	readBounded(path: string, maxBytes: number): Promise<Uint8Array>;
	move(source: string, destination: string): Promise<void>;
	removeFile(path: string): Promise<void>;
	randomToken(): string;
	processId: number;
	isProcessAlive(processId: number): boolean;
	fault?(
		point: WriteJournalStorageFaultPoint,
		bytes?: Readonly<Uint8Array>,
	): void | Uint8Array | Promise<void | Uint8Array>;
}

export interface WriteJournalOptions {
	storage_adapter?: WriteJournalStorageAdapter;
	identity_adapter?: StreamingIdentityAdapter;
	identity_hooks?: StreamingIdentityHooks;
}

export interface CreateWorkerWriteJournalInput {
	project_root: string;
	delegation_id: string;
	contract_hash: string;
	limits?: Readonly<WriteJournalLimitsInput>;
}

export interface ReadWorkerWriteJournalInput {
	project_root: string;
	delegation_id: string;
	contract_hash: string;
}

export interface BeginWriteJournalOperationInput extends ReadWorkerWriteJournalInput {
	expected_revision: number;
	operation_id: string;
	kind: WriteJournalOperationKind;
	path: string;
}

export interface CompleteWriteJournalOperationInput extends BeginWriteJournalOperationInput {
	outcome: WriteJournalOperationOutcome;
}

export interface SealWorkerWriteJournalInput extends ReadWorkerWriteJournalInput {
	expected_revision: number;
}

interface JournalPaths {
	root_real: string;
	directories: readonly string[];
	v2: string;
	record: string;
	lock: string;
}

interface JournalLockOwner {
	schema_version: 2;
	delegation_id: string;
	token: string;
	process_id: number;
}

interface HeldJournalLock {
	path: string;
	token: string;
}

const TOP_LEVEL_FIELDS = [
	"schema_version", "delegation_id", "contract_hash", "state", "revision",
	"limits", "meter", "operations", "journal_hash",
] as const;
const LIMIT_FIELDS = [
	"max_unique_paths", "max_operations", "max_identity_paths", "max_total_bytes",
	"max_file_bytes", "max_serialized_bytes",
] as const;
const METER_FIELDS = ["paths_attempted", "paths_completed", "bytes_read"] as const;
const PENDING_FIELDS = ["sequence", "operation_id", "kind", "path", "status", "before"] as const;
const COMPLETED_FIELDS = [
	"sequence", "operation_id", "kind", "path", "status", "before", "after", "outcome",
] as const;
const MISSING_IDENTITY_FIELDS = ["schema_version", "kind", "path"] as const;
const FILE_IDENTITY_FIELDS = ["schema_version", "kind", "path", "byte_size", "sha256", "stat"] as const;
const IDENTITY_STAT_FIELDS = ["dev", "ino", "mtime_ns", "ctime_ns"] as const;
const LOCK_FIELDS = ["schema_version", "delegation_id", "token", "process_id"] as const;
const TOKEN_RE = /^[a-f0-9]{32}$/;
const DECIMAL_RE = /^(0|[1-9]\d*)$/;

class StoragePointFailure extends Error {
	constructor(readonly point: WriteJournalStorageFaultPoint) {
		super("write journal storage point failed");
	}
}

const STATIC_MESSAGES: Readonly<Record<WriteJournalErrorCode, string>> = Object.freeze({
	invalid_input: "write journal input is invalid",
	invalid_path: "write journal path is not strict canonical form",
	conflict: "write journal state conflicts with the requested transition",
	not_found: "write journal record does not exist",
	storage_failure: "write journal storage operation failed",
	invalid_record: "write journal record is invalid",
	limit_exceeded: "write journal hard or configured limit was exceeded",
	identity_failure: "write journal identity capture failed",
});

function fail<T>(
	code: WriteJournalErrorCode,
	extra?: Pick<WriteJournalError, "point" | "identity_code" | "current_revision">,
): WriteJournalResult<T> {
	return { ok: false, error: { code, message: STATIC_MESSAGES[code], ...extra } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reject executable or non-JSON object structure before schema validation.
 * `util.types.isProxy` is checked before reflection so proxy traps are never
 * invoked by this preflight. Data-property values are read from descriptors,
 * not through potentially executable property access.
 */
function isStrictJournalData(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return true;
	}
	if (typeof value !== "object" || utilTypes.isProxy(value)) return false;
	const object = value as object;
	if (seen.has(object)) return false;
	seen.add(object);
	try {
		const prototype = Object.getPrototypeOf(object);
		const array = Array.isArray(object);
		if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
		for (const key of Reflect.ownKeys(object)) {
			if (array && key === "length") continue;
			if (typeof key !== "string") return false;
			const descriptor = Object.getOwnPropertyDescriptor(object, key);
			if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable
				|| !isStrictJournalData(descriptor.value, seen)) return false;
		}
		return true;
	} catch {
		return false;
	} finally {
		seen.delete(object);
	}
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...fields].sort();
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function isSafeCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedPositive(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function normalizeLimits(input: Readonly<WriteJournalLimitsInput> | undefined): WriteJournalLimits | undefined {
	if (input !== undefined && (!isRecord(input) || Object.keys(input).some((key) => !LIMIT_FIELDS.includes(key as typeof LIMIT_FIELDS[number])))) {
		return undefined;
	}
	const limits: WriteJournalLimits = {
		max_unique_paths: input?.max_unique_paths ?? WRITE_JOURNAL_MAX_UNIQUE_PATHS,
		max_operations: input?.max_operations ?? WRITE_JOURNAL_MAX_OPERATIONS,
		max_identity_paths: input?.max_identity_paths ?? STREAMING_IDENTITY_MAX_PATHS,
		max_total_bytes: input?.max_total_bytes ?? STREAMING_IDENTITY_MAX_TOTAL_BYTES,
		max_file_bytes: input?.max_file_bytes ?? STREAMING_IDENTITY_MAX_FILE_BYTES,
		max_serialized_bytes: input?.max_serialized_bytes ?? WRITE_JOURNAL_MAX_SERIALIZED_BYTES,
	};
	if (!boundedPositive(limits.max_unique_paths, WRITE_JOURNAL_MAX_UNIQUE_PATHS)
		|| !boundedPositive(limits.max_operations, WRITE_JOURNAL_MAX_OPERATIONS)
		|| !boundedPositive(limits.max_identity_paths, STREAMING_IDENTITY_MAX_PATHS)
		|| !boundedPositive(limits.max_total_bytes, STREAMING_IDENTITY_MAX_TOTAL_BYTES)
		|| !boundedPositive(limits.max_file_bytes, STREAMING_IDENTITY_MAX_FILE_BYTES)
		|| !boundedPositive(limits.max_serialized_bytes, WRITE_JOURNAL_MAX_SERIALIZED_BYTES)) return undefined;
	return limits;
}

function normalizeMeter(value: unknown): StreamingIdentityMeter | undefined {
	if (!isRecord(value) || !exactFields(value, METER_FIELDS)) return undefined;
	if (!isSafeCounter(value.paths_attempted) || !isSafeCounter(value.paths_completed) || !isSafeCounter(value.bytes_read)) return undefined;
	if (value.paths_completed > value.paths_attempted) return undefined;
	return {
		paths_attempted: value.paths_attempted,
		paths_completed: value.paths_completed,
		bytes_read: value.bytes_read,
	};
}

function normalizeIdentity(value: unknown, expectedPath: string): StreamingPathIdentity | undefined {
	if (!isRecord(value) || value.schema_version !== STREAMING_IDENTITY_SCHEMA_VERSION || value.path !== expectedPath) return undefined;
	if (value.kind === "missing") {
		if (!exactFields(value, MISSING_IDENTITY_FIELDS)) return undefined;
		return { schema_version: STREAMING_IDENTITY_SCHEMA_VERSION, kind: "missing", path: expectedPath };
	}
	if (value.kind !== "file" || !exactFields(value, FILE_IDENTITY_FIELDS) || !isRecord(value.stat)
		|| !exactFields(value.stat, IDENTITY_STAT_FIELDS)) return undefined;
	if (!isSafeCounter(value.byte_size) || typeof value.sha256 !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(value.sha256)) return undefined;
	for (const field of IDENTITY_STAT_FIELDS) {
		if (typeof value.stat[field] !== "string" || !DECIMAL_RE.test(value.stat[field] as string)) return undefined;
	}
	return {
		schema_version: STREAMING_IDENTITY_SCHEMA_VERSION,
		kind: "file",
		path: expectedPath,
		byte_size: value.byte_size,
		sha256: value.sha256,
		stat: {
			dev: value.stat.dev as string,
			ino: value.stat.ino as string,
			mtime_ns: value.stat.mtime_ns as string,
			ctime_ns: value.stat.ctime_ns as string,
		},
	};
}

function normalizeOperation(value: unknown, expectedSequence: number): WriteJournalOperation | undefined {
	if (!isRecord(value) || value.sequence !== expectedSequence || typeof value.operation_id !== "string"
		|| !DELEGATION_TRANSACTION_HASH_RE.test(value.operation_id) || !WRITE_JOURNAL_OPERATION_KINDS.includes(value.kind as WriteJournalOperationKind)
		|| !isStrictStreamingIdentityPath(value.path)) return undefined;
	const path = value.path;
	const before = normalizeIdentity(value.before, path);
	if (before === undefined) return undefined;
	if (value.status === "pending") {
		if (!exactFields(value, PENDING_FIELDS)) return undefined;
		return {
			sequence: expectedSequence,
			operation_id: value.operation_id,
			kind: value.kind as WriteJournalOperationKind,
			path,
			status: "pending",
			before,
		};
	}
	if (value.status !== "completed" || !exactFields(value, COMPLETED_FIELDS)
		|| (value.outcome !== "succeeded" && value.outcome !== "failed")) return undefined;
	const after = normalizeIdentity(value.after, path);
	if (after === undefined) return undefined;
	return {
		sequence: expectedSequence,
		operation_id: value.operation_id,
		kind: value.kind as WriteJournalOperationKind,
		path,
		status: "completed",
		before,
		after,
		outcome: value.outcome,
	};
}

function encodeCanonicalJson(value: unknown, maximum: number): Uint8Array | undefined {
	try {
		const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		return bytes.length <= maximum ? bytes : undefined;
	} catch {
		return undefined;
	}
}

function decodeJson(bytes: Uint8Array): unknown | undefined {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return undefined;
	}
}

function hashPayload(record: WorkerWriteJournalRecord): Omit<WorkerWriteJournalRecord, "journal_hash"> {
	return {
		schema_version: record.schema_version,
		delegation_id: record.delegation_id,
		contract_hash: record.contract_hash,
		state: record.state,
		revision: record.revision,
		limits: { ...record.limits },
		meter: { ...record.meter },
		operations: record.operations.map((operation) => cloneOperation(operation)),
	};
}

/** SHA-256 of canonical UTF-8 JSON plus newline, excluding only journal_hash. */
export function computeWorkerWriteJournalHash(record: WorkerWriteJournalRecord): string {
	const bytes = encodeCanonicalJson(hashPayload(record), WRITE_JOURNAL_MAX_SERIALIZED_BYTES);
	if (bytes === undefined) throw new Error("write journal hash payload exceeds its hard bound");
	return createHash("sha256").update(bytes).digest("hex");
}

function cloneIdentity(identity: StreamingPathIdentity): StreamingPathIdentity {
	return identity.kind === "missing"
		? { schema_version: 2, kind: "missing", path: identity.path }
		: {
			schema_version: 2,
			kind: "file",
			path: identity.path,
			byte_size: identity.byte_size,
			sha256: identity.sha256,
			stat: { ...identity.stat },
		};
}

function cloneOperation(operation: WriteJournalOperation): WriteJournalOperation {
	return operation.status === "pending"
		? {
			sequence: operation.sequence,
			operation_id: operation.operation_id,
			kind: operation.kind,
			path: operation.path,
			status: "pending",
			before: cloneIdentity(operation.before),
		}
		: {
			sequence: operation.sequence,
			operation_id: operation.operation_id,
			kind: operation.kind,
			path: operation.path,
			status: "completed",
			before: cloneIdentity(operation.before),
			after: cloneIdentity(operation.after),
			outcome: operation.outcome,
		};
}

function cloneJournal(record: WorkerWriteJournalRecord): WorkerWriteJournalRecord {
	return {
		schema_version: WRITE_JOURNAL_SCHEMA_VERSION,
		delegation_id: record.delegation_id,
		contract_hash: record.contract_hash,
		state: record.state,
		revision: record.revision,
		limits: { ...record.limits },
		meter: { ...record.meter },
		operations: record.operations.map((operation) => cloneOperation(operation)),
		journal_hash: record.journal_hash,
	};
}

function validateChain(operations: readonly WriteJournalOperation[]): boolean {
	const afterByPath = new Map<string, StreamingPathIdentity>();
	for (const operation of operations) {
		const previous = afterByPath.get(operation.path);
		if (previous !== undefined && !streamingIdentityEqual(previous, operation.before)) return false;
		if (operation.status === "completed") afterByPath.set(operation.path, operation.after);
	}
	return true;
}

function identityBytesLowerBound(operations: readonly WriteJournalOperation[]): number | undefined {
	let total = 0;
	for (const operation of operations) {
		const identities = operation.status === "completed"
			? [operation.before, operation.after]
			: [operation.before];
		for (const identity of identities) {
			if (identity.kind !== "file") continue;
			if (identity.byte_size > Number.MAX_SAFE_INTEGER - total) return undefined;
			total += identity.byte_size;
		}
	}
	return total;
}

function normalizeJournal(raw: unknown): WorkerWriteJournalRecord | undefined {
	if (!isRecord(raw) || !exactFields(raw, TOP_LEVEL_FIELDS) || raw.schema_version !== WRITE_JOURNAL_SCHEMA_VERSION
		|| typeof raw.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(raw.delegation_id)
		|| typeof raw.contract_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(raw.contract_hash)
		|| (raw.state !== "OPEN" && raw.state !== "SEALED") || !isSafeCounter(raw.revision)
		|| raw.revision > WRITE_JOURNAL_MAX_REVISION || !Array.isArray(raw.operations)) return undefined;
	const limits = normalizeLimits(raw.limits as Readonly<WriteJournalLimitsInput>);
	const meter = normalizeMeter(raw.meter);
	if (limits === undefined || meter === undefined || !isRecord(raw.limits) || !exactFields(raw.limits, LIMIT_FIELDS)) return undefined;
	if (meter.paths_attempted > limits.max_identity_paths || meter.bytes_read > limits.max_total_bytes
		|| raw.operations.length > limits.max_operations) return undefined;

	const operations: WriteJournalOperation[] = [];
	const ids = new Set<string>();
	const paths = new Set<string>();
	let pendingCount = 0;
	for (let index = 0; index < raw.operations.length; index += 1) {
		const operation = normalizeOperation(raw.operations[index], index + 1);
		if (operation === undefined || ids.has(operation.operation_id)) return undefined;
		ids.add(operation.operation_id);
		paths.add(operation.path);
		if (operation.status === "pending") {
			pendingCount += 1;
			if (index !== raw.operations.length - 1) return undefined;
		}
		operations.push(operation);
	}
	if (paths.size > limits.max_unique_paths || pendingCount > 1 || !validateChain(operations)) return undefined;
	const minimumSuccessfulCaptures = operations.length
		+ operations.filter((operation) => operation.status === "completed").length;
	const minimumIdentityBytes = identityBytesLowerBound(operations);
	if (minimumIdentityBytes === undefined || meter.bytes_read < minimumIdentityBytes
		|| meter.paths_completed < minimumSuccessfulCaptures || raw.revision < minimumSuccessfulCaptures) return undefined;
	for (const operation of operations) {
		if ((operation.before.kind === "file" && operation.before.byte_size > limits.max_file_bytes)
			|| (operation.status === "completed" && operation.after.kind === "file" && operation.after.byte_size > limits.max_file_bytes)) {
			return undefined;
		}
	}
	if (raw.state === "SEALED" && pendingCount !== 0) return undefined;
	if (raw.state === "SEALED" && raw.revision < minimumSuccessfulCaptures + 1) return undefined;
	if (raw.state === "OPEN" && raw.journal_hash !== null) return undefined;
	if (raw.state === "SEALED" && (typeof raw.journal_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(raw.journal_hash))) return undefined;
	const record: WorkerWriteJournalRecord = {
		schema_version: WRITE_JOURNAL_SCHEMA_VERSION,
		delegation_id: raw.delegation_id,
		contract_hash: raw.contract_hash,
		state: raw.state,
		revision: raw.revision,
		limits,
		meter,
		operations,
		journal_hash: raw.journal_hash as string | null,
	};
	if (record.state === "SEALED" && record.journal_hash !== computeWorkerWriteJournalHash(record)) return undefined;
	return record;
}

/**
 * Pure strict validator for an in-memory worker journal record.
 *
 * Unlike the durable reader, this accepts semantically equivalent object key
 * insertion order. It still reuses the journal's single normalization path,
 * including every schema, limit, meter, identity-chain, pending-layout, and
 * sealed-hash invariant. Executable object structure fails closed.
 */
export function validateWorkerWriteJournalRecord(value: unknown): value is WorkerWriteJournalRecord {
	try {
		return isStrictJournalData(value) && normalizeJournal(value) !== undefined;
	} catch {
		return false;
	}
}

function canonicalBytes(record: WorkerWriteJournalRecord): Uint8Array | undefined {
	return encodeCanonicalJson(cloneJournal(record), Math.min(record.limits.max_serialized_bytes, WRITE_JOURNAL_MAX_SERIALIZED_BYTES));
}

function parseCanonicalRecord(bytes: Uint8Array): WorkerWriteJournalRecord | undefined {
	const record = normalizeJournal(decodeJson(bytes));
	if (record === undefined) return undefined;
	const encoded = canonicalBytes(record);
	return encoded !== undefined && Buffer.from(encoded).equals(Buffer.from(bytes)) ? record : undefined;
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function kindOf(stats: Awaited<ReturnType<typeof lstat>>): WriteJournalStorageStat["kind"] {
	if (stats.isSymbolicLink()) return "symlink";
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	return "other";
}

async function nodeReadBounded(path: string, maxBytes: number): Promise<Uint8Array> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
	const handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || before.size < 0n || before.size > BigInt(maxBytes)) throw new Error("unsafe bounded journal read");
		const buffer = Buffer.allocUnsafe(Number(before.size));
		let offset = 0;
		while (offset < buffer.length) {
			const result = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (result.bytesRead <= 0) throw new Error("short journal read");
			offset += result.bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
			|| before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
			throw new Error("journal changed during read");
		}
		return buffer;
	} finally {
		await handle.close();
	}
}

/** Production Node adapter; it does no shell or network I/O. */
export function createNodeWriteJournalStorageAdapter(
	fault?: WriteJournalStorageAdapter["fault"],
): WriteJournalStorageAdapter {
	return {
		makeDirectory: async (path) => mkdir(path, { mode: 0o700 }),
		async inspect(path) {
			const stats = await lstat(path);
			return { kind: kindOf(stats), size: Number(stats.size) };
		},
		realpath,
		async write(path, bytes, exclusive) {
			const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
			const flags = constants.O_WRONLY | constants.O_CREAT | noFollow | (exclusive ? constants.O_EXCL : constants.O_TRUNC);
			const handle = await open(path, flags, 0o600);
			try {
				let offset = 0;
				while (offset < bytes.length) {
					const result = await handle.write(bytes, offset, bytes.length - offset, offset);
					if (result.bytesWritten <= 0) throw new Error("short journal write");
					offset += result.bytesWritten;
				}
			} finally {
				await handle.close();
			}
		},
		readBounded: nodeReadBounded,
		move: rename,
		removeFile: unlink,
		randomToken: () => randomBytes(16).toString("hex"),
		processId: process.pid,
		isProcessAlive(processId) {
			if (!Number.isSafeInteger(processId) || processId <= 0) return false;
			try {
				process.kill(processId, 0);
				return true;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "EPERM";
			}
		},
		fault,
	};
}

function validBaseInput(input: ReadWorkerWriteJournalInput): boolean {
	return isRecord(input) && typeof input.project_root === "string" && input.project_root.length > 0
		&& typeof input.delegation_id === "string" && DELEGATION_TRANSACTION_ID_RE.test(input.delegation_id)
		&& typeof input.contract_hash === "string" && DELEGATION_TRANSACTION_HASH_RE.test(input.contract_hash);
}

function relativeRecordPath(delegationId: string): string {
	return posix.join(".pi", "workbench", "delegations", delegationId, "v2", "write-journal.json");
}

/** Exact project-relative location of one delegation's v2 write journal. */
export function workerWriteJournalRelativePath(delegationId: string): string | undefined {
	return DELEGATION_TRANSACTION_ID_RE.test(delegationId) ? relativeRecordPath(delegationId) : undefined;
}

function rawPaths(projectRoot: string, delegationId: string, rootReal: string): JournalPaths {
	const root = resolve(projectRoot);
	const directories = [
		join(root, ".pi"),
		join(root, ".pi", "workbench"),
		join(root, ".pi", "workbench", "delegations"),
		join(root, ".pi", "workbench", "delegations", delegationId),
		join(root, ".pi", "workbench", "delegations", delegationId, "v2"),
	];
	const v2 = directories[directories.length - 1]!;
	return {
		root_real: rootReal,
		directories,
		v2,
		record: join(v2, "write-journal.json"),
		lock: join(v2, "write-journal.lock"),
	};
}

function contained(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function fault(
	adapter: WriteJournalStorageAdapter,
	point: WriteJournalStorageFaultPoint,
	bytes?: Readonly<Uint8Array>,
): Promise<Uint8Array | undefined> {
	const changed = await adapter.fault?.(point, bytes);
	return changed === undefined ? undefined : Uint8Array.from(changed);
}

async function readAt(
	adapter: WriteJournalStorageAdapter,
	path: string,
	maximum: number,
	point: WriteJournalStorageFaultPoint,
): Promise<Uint8Array> {
	const bytes = await adapter.readBounded(path, maximum);
	const changed = (await fault(adapter, point, bytes)) ?? bytes;
	if (changed.length > maximum) throw new Error("fault bytes exceed bound");
	return changed;
}

async function inspectSafeDirectories(paths: JournalPaths, adapter: WriteJournalStorageAdapter): Promise<WriteJournalResult<JournalPaths>> {
	try {
		for (const directory of paths.directories) {
			const stat = await adapter.inspect(directory);
			if (stat.kind !== "directory") return fail("invalid_record", { point: "layout.mkdir" });
			const resolved = await adapter.realpath(directory);
			if (!isAbsolute(resolved) || !contained(paths.root_real, resolved)) return fail("invalid_record", { point: "layout.mkdir" });
		}
		return { ok: true, value: paths };
	} catch (error) {
		return isErrno(error, "ENOENT") ? fail("not_found", { point: "layout.mkdir" }) : fail("storage_failure", { point: "layout.mkdir" });
	}
}

async function existingLayout(projectRoot: string, delegationId: string, adapter: WriteJournalStorageAdapter): Promise<WriteJournalResult<JournalPaths>> {
	let rootReal: string;
	try {
		rootReal = await adapter.realpath(resolve(projectRoot));
		if (!isAbsolute(rootReal)) return fail("invalid_record", { point: "layout.mkdir" });
	} catch {
		return fail("storage_failure", { point: "layout.mkdir" });
	}
	return inspectSafeDirectories(rawPaths(projectRoot, delegationId, rootReal), adapter);
}

async function ensureLayout(projectRoot: string, delegationId: string, adapter: WriteJournalStorageAdapter): Promise<WriteJournalResult<JournalPaths>> {
	let rootReal: string;
	try {
		rootReal = await adapter.realpath(resolve(projectRoot));
		if (!isAbsolute(rootReal)) return fail("invalid_record", { point: "layout.mkdir" });
	} catch {
		return fail("storage_failure", { point: "layout.mkdir" });
	}
	const paths = rawPaths(projectRoot, delegationId, rootReal);
	for (const directory of paths.directories) {
		try {
			await fault(adapter, "layout.mkdir");
			await adapter.makeDirectory(directory);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) return fail("storage_failure", { point: "layout.mkdir" });
		}
		try {
			const stat = await adapter.inspect(directory);
			const resolved = await adapter.realpath(directory);
			if (stat.kind !== "directory" || !isAbsolute(resolved) || !contained(rootReal, resolved)) {
				return fail("invalid_record", { point: "layout.mkdir" });
			}
		} catch {
			return fail("storage_failure", { point: "layout.mkdir" });
		}
	}
	return { ok: true, value: paths };
}

function encodeLock(owner: JournalLockOwner): Uint8Array | undefined {
	return encodeCanonicalJson(owner, WRITE_JOURNAL_LOCK_MAX_BYTES);
}

function parseLock(value: unknown, delegationId: string): JournalLockOwner | undefined {
	if (!isRecord(value) || !exactFields(value, LOCK_FIELDS) || value.schema_version !== 2 || value.delegation_id !== delegationId
		|| typeof value.token !== "string" || !TOKEN_RE.test(value.token)
		|| !Number.isSafeInteger(value.process_id) || Number(value.process_id) <= 0) return undefined;
	return {
		schema_version: 2,
		delegation_id: delegationId,
		token: value.token,
		process_id: value.process_id as number,
	};
}

function storageToken(adapter: WriteJournalStorageAdapter): string | undefined {
	try {
		const token = adapter.randomToken();
		return TOKEN_RE.test(token) ? token : undefined;
	} catch {
		return undefined;
	}
}

async function releaseOwnedLock(
	path: string,
	token: string,
	adapter: WriteJournalStorageAdapter,
	injectFaults: boolean,
): Promise<void> {
	const releasePath = `${path}.release.${token}`;
	let point: WriteJournalStorageFaultPoint = "lock.release.rename";
	try {
		if (injectFaults) await fault(adapter, point);
		await adapter.move(path, releasePath);
		point = "lock.release.read";
		const bytes = injectFaults
			? await readAt(adapter, releasePath, WRITE_JOURNAL_LOCK_MAX_BYTES, point)
			: await adapter.readBounded(releasePath, WRITE_JOURNAL_LOCK_MAX_BYTES);
		const raw = decodeJson(bytes);
		const delegationId = isRecord(raw) && typeof raw.delegation_id === "string" ? raw.delegation_id : "";
		const owner = parseLock(raw, delegationId);
		if (owner === undefined || owner.token !== token) {
			await adapter.move(releasePath, path).catch(() => undefined);
			throw new Error("foreign lock token");
		}
		point = "lock.release.unlink";
		if (injectFaults) await fault(adapter, point);
		await adapter.removeFile(releasePath);
	} catch {
		throw new StoragePointFailure(point);
	}
}

async function acquireLock(paths: JournalPaths, delegationId: string, adapter: WriteJournalStorageAdapter): Promise<WriteJournalResult<HeldJournalLock>> {
	for (let attempt = 0; attempt <= WRITE_JOURNAL_LOCK_RECOVERY_ATTEMPTS; attempt += 1) {
		const token = storageToken(adapter);
		if (token === undefined) return fail("storage_failure", { point: "lock.acquire" });
		const owner: JournalLockOwner = { schema_version: 2, delegation_id: delegationId, token, process_id: adapter.processId };
		const encoded = encodeLock(owner);
		if (encoded === undefined) return fail("storage_failure", { point: "lock.owner.write" });
		let created = false;
		let acquisitionPoint: WriteJournalStorageFaultPoint = "lock.acquire";
		try {
			await fault(adapter, acquisitionPoint);
			acquisitionPoint = "lock.owner.write";
			const writeBytes = (await fault(adapter, acquisitionPoint, encoded)) ?? encoded;
			if (writeBytes.length > WRITE_JOURNAL_LOCK_MAX_BYTES) throw new Error("lock bound");
			await adapter.write(paths.lock, writeBytes, true);
			created = true;
			acquisitionPoint = "lock.owner.read";
			const read = await readAt(adapter, paths.lock, WRITE_JOURNAL_LOCK_MAX_BYTES, acquisitionPoint);
			const parsed = parseLock(decodeJson(read), delegationId);
			if (parsed === undefined || parsed.token !== token || parsed.process_id !== adapter.processId) throw new Error("lock mismatch");
			return { ok: true, value: { path: paths.lock, token } };
		} catch (error) {
			if (created) await releaseOwnedLock(paths.lock, token, adapter, false).catch(() => undefined);
			if (!isErrno(error, "EEXIST")) return fail("storage_failure", { point: acquisitionPoint });
		}

		let existing: JournalLockOwner | undefined;
		let existingBytes: Uint8Array;
		try {
			existingBytes = await readAt(adapter, paths.lock, WRITE_JOURNAL_LOCK_MAX_BYTES, "lock.owner.read");
			existing = parseLock(decodeJson(existingBytes), delegationId);
		} catch {
			return fail("conflict", { point: "lock.owner.read" });
		}
		if (existing === undefined || adapter.isProcessAlive(existing.process_id)) return fail("conflict", { point: "lock.acquire" });
		if (attempt >= WRITE_JOURNAL_LOCK_RECOVERY_ATTEMPTS) return fail("conflict", { point: "lock.recover.rename" });
		const recoveryToken = storageToken(adapter);
		if (recoveryToken === undefined) return fail("storage_failure", { point: "lock.recover.rename" });
		const recovered = `${paths.lock}.recovered.${recoveryToken}`;
		let recoveryPoint: WriteJournalStorageFaultPoint = "lock.recover.rename";
		let moved = false;
		try {
			await fault(adapter, recoveryPoint);
			await adapter.move(paths.lock, recovered);
			moved = true;
			recoveryPoint = "lock.recover.read";
			const recoveredBytes = await readAt(adapter, recovered, WRITE_JOURNAL_LOCK_MAX_BYTES, recoveryPoint);
			const recoveredOwner = parseLock(decodeJson(recoveredBytes), delegationId);
			if (recoveredOwner === undefined || recoveredOwner.token !== existing.token
				|| !Buffer.from(recoveredBytes).equals(Buffer.from(existingBytes))) throw new Error("stale lock changed");
			recoveryPoint = "lock.recover.unlink";
			await fault(adapter, recoveryPoint);
			await adapter.removeFile(recovered);
		} catch {
			// A failed recovery may never turn into an unlocked delegation. Put
			// the exact candidate back when possible; if a foreign actor already
			// claimed the lock path the exclusive move fails and both artifacts
			// remain diagnosable instead of deleting either owner.
			if (moved) await adapter.move(recovered, paths.lock).catch(() => undefined);
			return fail("conflict", { point: recoveryPoint });
		}
	}
	return fail("conflict", { point: "lock.acquire" });
}

async function withLock<T>(
	projectRoot: string,
	delegationId: string,
	adapter: WriteJournalStorageAdapter,
	operation: (paths: JournalPaths) => Promise<WriteJournalResult<T>>,
): Promise<WriteJournalResult<T>> {
	const layout = await ensureLayout(projectRoot, delegationId, adapter);
	if (!layout.ok) return layout;
	const lock = await acquireLock(layout.value, delegationId, adapter);
	if (!lock.ok) return lock;
	let result: WriteJournalResult<T>;
	try {
		result = await operation(layout.value);
	} catch {
		result = fail("storage_failure");
	}
	try {
		await releaseOwnedLock(lock.value.path, lock.value.token, adapter, true);
	} catch (error) {
		return fail("storage_failure", {
			point: error instanceof StoragePointFailure ? error.point : "lock.release.unlink",
		});
	}
	return result;
}

async function readRecordAt(
	paths: JournalPaths,
	delegationId: string,
	contractHash: string,
	adapter: WriteJournalStorageAdapter,
	point: WriteJournalStorageFaultPoint = "record.read",
): Promise<WriteJournalResult<WorkerWriteJournalRecord>> {
	try {
		const stat = await adapter.inspect(paths.record);
		if (stat.kind !== "file" || !isSafeCounter(stat.size) || stat.size > WRITE_JOURNAL_MAX_SERIALIZED_BYTES) {
			return fail("invalid_record", { point });
		}
		const bytes = await readAt(adapter, paths.record, WRITE_JOURNAL_MAX_SERIALIZED_BYTES, point);
		const record = parseCanonicalRecord(bytes);
		if (record === undefined || record.delegation_id !== delegationId || record.contract_hash !== contractHash
			|| bytes.length > record.limits.max_serialized_bytes) return fail("invalid_record", { point });
		return { ok: true, value: record };
	} catch (error) {
		return isErrno(error, "ENOENT") ? fail("not_found", { point }) : fail("storage_failure", { point });
	}
}

async function publishRecord(
	paths: JournalPaths,
	record: WorkerWriteJournalRecord,
	phase: WriteJournalPublishPhase,
	adapter: WriteJournalStorageAdapter,
	createOnly: boolean,
): Promise<WriteJournalResult<WorkerWriteJournalRecord>> {
	const encoded = canonicalBytes(record);
	if (encoded === undefined) return fail("limit_exceeded");
	const token = storageToken(adapter);
	if (token === undefined) return fail("storage_failure", { point: `${phase}.temp.write` });
	const temp = join(paths.v2, `.write-journal.${phase}.${token}.tmp`);
	const writePoint = `${phase}.temp.write` as WriteJournalStorageFaultPoint;
	const tempReadPoint = `${phase}.temp.read` as WriteJournalStorageFaultPoint;
	const renamePoint = `${phase}.rename` as WriteJournalStorageFaultPoint;
	const finalReadPoint = `${phase}.final.read` as WriteJournalStorageFaultPoint;
	let currentPoint = writePoint;
	try {
		if (createOnly) {
			try {
				await adapter.inspect(paths.record);
				return fail("conflict", { point: renamePoint });
			} catch (error) {
				if (!isErrno(error, "ENOENT")) return fail("invalid_record", { point: renamePoint });
			}
		}
		currentPoint = writePoint;
		const writeBytes = (await fault(adapter, currentPoint, encoded)) ?? encoded;
		if (writeBytes.length > record.limits.max_serialized_bytes) return fail("limit_exceeded", { point: writePoint });
		await adapter.write(temp, writeBytes, true);
		currentPoint = tempReadPoint;
		const tempBytes = await readAt(adapter, temp, record.limits.max_serialized_bytes, currentPoint);
		const tempRecord = parseCanonicalRecord(tempBytes);
		if (tempRecord === undefined || !Buffer.from(tempBytes).equals(Buffer.from(encoded))) {
			throw new StoragePointFailure(currentPoint);
		}
		currentPoint = renamePoint;
		await fault(adapter, currentPoint);
		await adapter.move(temp, paths.record);
		currentPoint = finalReadPoint;
		const finalBytes = await readAt(adapter, paths.record, record.limits.max_serialized_bytes, currentPoint);
		const finalRecord = parseCanonicalRecord(finalBytes);
		if (finalRecord === undefined || !Buffer.from(finalBytes).equals(Buffer.from(encoded))) return fail("storage_failure", { point: finalReadPoint });
		return { ok: true, value: finalRecord };
	} catch (error) {
		await adapter.removeFile(temp).catch(() => undefined);
		return fail("storage_failure", {
			point: error instanceof StoragePointFailure ? error.point : currentPoint,
		});
	}
}

function sameCanonicalJournal(left: WorkerWriteJournalRecord, right: WorkerWriteJournalRecord): boolean {
	const leftBytes = canonicalBytes(left);
	const rightBytes = canonicalBytes(right);
	return leftBytes !== undefined && rightBytes !== undefined
		&& Buffer.from(leftBytes).equals(Buffer.from(rightBytes));
}

/**
 * Identity capture is irreversible work for the cumulative meter. If the
 * first atomic publication reports a storage fault, strict-read the durable
 * final record while the delegation lock is still held. Preserve an intended
 * record that was renamed before a final-read fault; if the exact prior record
 * remains, retry the intended publication once. The public call still reports
 * the original fault, so recovery never upgrades uncertain I/O into success.
 */
async function publishAfterIdentityCapture(
	paths: JournalPaths,
	prior: WorkerWriteJournalRecord,
	intended: WorkerWriteJournalRecord,
	phase: "begin" | "complete",
	adapter: WriteJournalStorageAdapter,
): Promise<WriteJournalResult<WorkerWriteJournalRecord>> {
	const first = await publishRecord(paths, intended, phase, adapter, false);
	if (first.ok || first.error.code !== "storage_failure") return first;
	const originalFailure = first;
	const durable = await readRecordAt(
		paths,
		intended.delegation_id,
		intended.contract_hash,
		adapter,
	);
	if (!durable.ok || sameCanonicalJournal(durable.value, intended)) return originalFailure;
	if (sameCanonicalJournal(durable.value, prior)) {
		await publishRecord(paths, intended, phase, adapter, false);
	}
	return originalFailure;
}

function sameMeter(left: StreamingIdentityMeter, right: StreamingIdentityMeter): boolean {
	return left.paths_attempted === right.paths_attempted && left.paths_completed === right.paths_completed
		&& left.bytes_read === right.bytes_read;
}

function nextRevision(record: WorkerWriteJournalRecord): number | undefined {
	return record.revision < WRITE_JOURNAL_MAX_REVISION ? record.revision + 1 : undefined;
}

async function persistMeterAfterIdentityFailure(
	paths: JournalPaths,
	record: WorkerWriteJournalRecord,
	meter: StreamingIdentityMeter,
	phase: "begin" | "complete",
	adapter: WriteJournalStorageAdapter,
	identityCode: StreamingIdentityErrorCode,
): Promise<WriteJournalResult<never>> {
	if (sameMeter(record.meter, meter)) return fail("identity_failure", { identity_code: identityCode, current_revision: record.revision });
	const revision = nextRevision(record);
	if (revision === undefined) return fail("limit_exceeded", { current_revision: record.revision });
	const updated: WorkerWriteJournalRecord = { ...cloneJournal(record), revision, meter: { ...meter } };
	const published = await publishAfterIdentityCapture(paths, record, updated, phase, adapter);
	return published.ok
		? fail("identity_failure", { identity_code: identityCode, current_revision: revision })
		: published as WriteJournalResult<never>;
}

function optionsAdapters(options: WriteJournalOptions | undefined): {
	storage: WriteJournalStorageAdapter;
	identity: StreamingIdentityAdapter;
	hooks?: StreamingIdentityHooks;
} {
	return {
		storage: options?.storage_adapter ?? createNodeWriteJournalStorageAdapter(),
		identity: options?.identity_adapter ?? createNodeStreamingIdentityAdapter(),
		...(options?.identity_hooks === undefined ? {} : { hooks: options.identity_hooks }),
	};
}

/** Create one empty OPEN journal. Existing records are never overwritten. */
export async function createWorkerWriteJournal(
	input: CreateWorkerWriteJournalInput,
	options?: WriteJournalOptions,
): Promise<WriteJournalResult<WorkerWriteJournalRecord>> {
	if (!validBaseInput(input)) return fail("invalid_input");
	const limits = normalizeLimits(input.limits);
	if (limits === undefined) return fail("invalid_input");
	const { storage } = optionsAdapters(options);
	const initial: WorkerWriteJournalRecord = {
		schema_version: WRITE_JOURNAL_SCHEMA_VERSION,
		delegation_id: input.delegation_id,
		contract_hash: input.contract_hash,
		state: "OPEN",
		revision: 0,
		limits,
		meter: { paths_attempted: 0, paths_completed: 0, bytes_read: 0 },
		operations: [],
		journal_hash: null,
	};
	if (canonicalBytes(initial) === undefined) return fail("limit_exceeded");
	return withLock(input.project_root, input.delegation_id, storage, (paths) =>
		publishRecord(paths, initial, "create", storage, true));
}

/** Strict canonical read. Missing, unsafe, corrupt, and storage failures remain distinct. */
export async function readWorkerWriteJournal(
	input: ReadWorkerWriteJournalInput,
	options?: Pick<WriteJournalOptions, "storage_adapter">,
): Promise<WriteJournalResult<WorkerWriteJournalRecord>> {
	if (!validBaseInput(input)) return fail("invalid_input");
	const storage = options?.storage_adapter ?? createNodeWriteJournalStorageAdapter();
	const layout = await existingLayout(input.project_root, input.delegation_id, storage);
	if (!layout.ok) return layout;
	return readRecordAt(layout.value, input.delegation_id, input.contract_hash, storage);
}

/** Capture and atomically publish the full before identity for one attempt. */
export async function beginWriteJournalOperation(
	input: BeginWriteJournalOperationInput,
	options?: WriteJournalOptions,
): Promise<WriteJournalResult<WorkerWriteJournalRecord>> {
	if (!validBaseInput(input) || !isSafeCounter(input.expected_revision) || input.expected_revision > WRITE_JOURNAL_MAX_REVISION
		|| typeof input.operation_id !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(input.operation_id)
		|| !WRITE_JOURNAL_OPERATION_KINDS.includes(input.kind) || !isStrictStreamingIdentityPath(input.path)) {
		return !isStrictStreamingIdentityPath(input?.path) ? fail("invalid_path") : fail("invalid_input");
	}
	const { storage, identity, hooks } = optionsAdapters(options);
	return withLock(input.project_root, input.delegation_id, storage, async (paths) => {
		const current = await readRecordAt(paths, input.delegation_id, input.contract_hash, storage);
		if (!current.ok) return current;
		const record = current.value;
		if (record.state !== "OPEN" || record.revision !== input.expected_revision
			|| record.operations.some((operation) => operation.status === "pending" || operation.operation_id === input.operation_id)) {
			return fail("conflict", { current_revision: record.revision });
		}
		if (record.operations.length >= record.limits.max_operations || nextRevision(record) === undefined) {
			return fail("limit_exceeded", { current_revision: record.revision });
		}
		const distinct = new Set(record.operations.map((operation) => operation.path));
		if (!distinct.has(input.path) && distinct.size >= record.limits.max_unique_paths) {
			return fail("limit_exceeded", { current_revision: record.revision });
		}
		const meter = { ...record.meter };
		const captured = await captureStreamingIdentities({
			project_root: input.project_root,
			paths: [input.path],
			limits: {
				max_paths: record.limits.max_identity_paths,
				max_total_bytes: record.limits.max_total_bytes,
				max_file_bytes: record.limits.max_file_bytes,
			},
			meter,
			adapter: identity,
			...(hooks === undefined ? {} : { hooks }),
		});
		if (!captured.ok) return persistMeterAfterIdentityFailure(paths, record, meter, "begin", storage, captured.error.code);
		const before = captured.identities[0]!;
		for (let index = record.operations.length - 1; index >= 0; index -= 1) {
			const previous = record.operations[index]!;
			if (previous.path !== input.path) continue;
			if (previous.status !== "completed" || !streamingIdentityEqual(previous.after, before)) {
				return persistMeterAfterIdentityFailure(paths, record, meter, "begin", storage, "unstable");
			}
			break;
		}
		const revision = nextRevision(record)!;
		const operation: PendingWriteJournalOperation = {
			sequence: record.operations.length + 1,
			operation_id: input.operation_id,
			kind: input.kind,
			path: input.path,
			status: "pending",
			before: cloneIdentity(before),
		};
		const updated: WorkerWriteJournalRecord = {
			...cloneJournal(record),
			revision,
			meter,
			operations: [...record.operations.map(cloneOperation), operation],
		};
		return publishAfterIdentityCapture(paths, record, updated, "begin", storage);
	});
}

/** Capture and atomically publish after identity and the closed tool outcome. */
export async function completeWriteJournalOperation(
	input: CompleteWriteJournalOperationInput,
	options?: WriteJournalOptions,
): Promise<WriteJournalResult<WorkerWriteJournalRecord>> {
	if (!validBaseInput(input) || !isSafeCounter(input.expected_revision) || input.expected_revision > WRITE_JOURNAL_MAX_REVISION
		|| typeof input.operation_id !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(input.operation_id)
		|| !WRITE_JOURNAL_OPERATION_KINDS.includes(input.kind) || !isStrictStreamingIdentityPath(input.path)
		|| (input.outcome !== "succeeded" && input.outcome !== "failed")) {
		return !isStrictStreamingIdentityPath(input?.path) ? fail("invalid_path") : fail("invalid_input");
	}
	const { storage, identity, hooks } = optionsAdapters(options);
	return withLock(input.project_root, input.delegation_id, storage, async (paths) => {
		const current = await readRecordAt(paths, input.delegation_id, input.contract_hash, storage);
		if (!current.ok) return current;
		const record = current.value;
		const latest = record.operations[record.operations.length - 1];
		if (record.state !== "OPEN" || record.revision !== input.expected_revision || latest === undefined
			|| latest.status !== "pending" || latest.operation_id !== input.operation_id
			|| latest.kind !== input.kind || latest.path !== input.path || nextRevision(record) === undefined) {
			return fail("conflict", { current_revision: record.revision });
		}
		const meter = { ...record.meter };
		const captured = await captureStreamingIdentities({
			project_root: input.project_root,
			paths: [input.path],
			limits: {
				max_paths: record.limits.max_identity_paths,
				max_total_bytes: record.limits.max_total_bytes,
				max_file_bytes: record.limits.max_file_bytes,
			},
			meter,
			adapter: identity,
			...(hooks === undefined ? {} : { hooks }),
		});
		if (!captured.ok) return persistMeterAfterIdentityFailure(paths, record, meter, "complete", storage, captured.error.code);
		const after = captured.identities[0]!;
		const completed: CompletedWriteJournalOperation = {
			sequence: latest.sequence,
			operation_id: latest.operation_id,
			kind: latest.kind,
			path: latest.path,
			status: "completed",
			before: cloneIdentity(latest.before),
			after: cloneIdentity(after),
			outcome: input.outcome,
		};
		const updated: WorkerWriteJournalRecord = {
			...cloneJournal(record),
			revision: nextRevision(record)!,
			meter,
			operations: [...record.operations.slice(0, -1).map(cloneOperation), completed],
		};
		return publishAfterIdentityCapture(paths, record, updated, "complete", storage);
	});
}

/** Seal the journal and bind every canonical byte except the hash field itself. */
export async function sealWorkerWriteJournal(
	input: SealWorkerWriteJournalInput,
	options?: Pick<WriteJournalOptions, "storage_adapter">,
): Promise<WriteJournalResult<WorkerWriteJournalRecord>> {
	if (!validBaseInput(input) || !isSafeCounter(input.expected_revision) || input.expected_revision > WRITE_JOURNAL_MAX_REVISION) {
		return fail("invalid_input");
	}
	const storage = options?.storage_adapter ?? createNodeWriteJournalStorageAdapter();
	return withLock(input.project_root, input.delegation_id, storage, async (paths) => {
		const current = await readRecordAt(paths, input.delegation_id, input.contract_hash, storage);
		if (!current.ok) return current;
		const record = current.value;
		if (record.revision !== input.expected_revision) return fail("conflict", { current_revision: record.revision });
		if (record.state === "SEALED") return { ok: true, value: cloneJournal(record) };
		if (record.operations.some((operation) => operation.status === "pending") || !validateChain(record.operations)) {
			return fail("conflict", { current_revision: record.revision });
		}
		const revision = nextRevision(record);
		if (revision === undefined) return fail("limit_exceeded", { current_revision: record.revision });
		const sealedWithoutHash: WorkerWriteJournalRecord = {
			...cloneJournal(record),
			state: "SEALED",
			revision,
			journal_hash: null,
		};
		const sealed: WorkerWriteJournalRecord = {
			...sealedWithoutHash,
			journal_hash: computeWorkerWriteJournalHash(sealedWithoutHash),
		};
		return publishRecord(paths, sealed, "seal", storage, false);
	});
}
