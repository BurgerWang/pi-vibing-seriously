/**
 * ChangeSet v2 pure finalizer.
 *
 * This module performs no I/O. It turns a sealed worker write journal, two
 * workspace guards, and one caller-captured final full identity per touched
 * path into a closed, deterministic attribution record.
 */

import { createHash } from "node:crypto";

import {
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
} from "./delegation-transaction.ts";
import {
	computeWorkerWriteJournalHash,
	WRITE_JOURNAL_MAX_OPERATIONS,
	WRITE_JOURNAL_MAX_REVISION,
	WRITE_JOURNAL_MAX_SERIALIZED_BYTES,
	WRITE_JOURNAL_MAX_UNIQUE_PATHS,
	WRITE_JOURNAL_SCHEMA_VERSION,
	type CompletedWriteJournalOperation,
	type WorkerWriteJournalRecord,
} from "./write-journal.ts";
import {
	isStrictStreamingIdentityPath,
	STREAMING_IDENTITY_MAX_FILE_BYTES,
	STREAMING_IDENTITY_MAX_PATHS,
	STREAMING_IDENTITY_MAX_TOTAL_BYTES,
	STREAMING_IDENTITY_SCHEMA_VERSION,
	streamingIdentityEqual,
	type StreamingIdentityMeter,
	type StreamingPathIdentity,
} from "./streaming-identity.ts";
import {
	isStrictWorkspaceGuardPath,
	validateWorkspaceGuard,
	WORKSPACE_GUARD_MAX_RELEVANT_PATHS,
	WORKSPACE_GUARD_SCHEMA_VERSION,
	type WorkspaceGuardEntry,
	type WorkspaceGuardIdentity,
	type WorkspaceGuardRecord,
} from "./workspace-guard.ts";

export const CHANGE_SET_SCHEMA_VERSION = 2 as const;
export const CHANGE_SET_MAX_PATHS = 500 as const;

export type ChangeSetStatus = "ATTRIBUTED" | "WORKSPACE_DRIFT" | "CONFLICT";
export type ChangeKind = "new" | "modify" | "delete";
export type WorkspaceDriftClassification = "dependency" | "unknown_origin";
export type ChangeSetConflictReason = "final_identity_mismatch" | "guard_identity_mismatch";

export interface ChangeSetAttributedEntry {
	path: string;
	change: ChangeKind;
	operation_count: number;
	before: StreamingPathIdentity;
	after: StreamingPathIdentity;
}

export interface WorkspaceDriftEntry {
	path: string;
	classification: WorkspaceDriftClassification;
	before: WorkspaceGuardEntry | null;
	after: WorkspaceGuardEntry | null;
}

export interface ChangeSetConflict {
	path: string;
	reason: ChangeSetConflictReason;
}

export interface ChangeSetCounts {
	touched_paths: number;
	attributed_paths: number;
	zero_delta_paths: number;
	workspace_drift_paths: number;
	dependency_drift_paths: number;
	unknown_origin_drift_paths: number;
	conflict_paths: number;
}

export interface ChangeSetRecord {
	schema_version: typeof CHANGE_SET_SCHEMA_VERSION;
	delegation_id: string;
	contract_hash: string;
	journal_hash: string;
	before_workspace_guard_hash: string;
	after_workspace_guard_hash: string;
	dependency_paths: readonly string[];
	status: ChangeSetStatus;
	worker_delta: readonly ChangeSetAttributedEntry[];
	workspace_drift: readonly WorkspaceDriftEntry[];
	conflicts: readonly ChangeSetConflict[];
	finalization_meter: Readonly<StreamingIdentityMeter>;
	counts: Readonly<ChangeSetCounts>;
	worker_delta_hash: string;
	workspace_guard_hash: string;
	change_set_hash: string;
}

export interface ComputeChangeSetInput {
	delegation_id: string;
	contract_hash: string;
	journal_hash: string;
	journal: WorkerWriteJournalRecord;
	before_guard: WorkspaceGuardRecord;
	after_guard: WorkspaceGuardRecord;
	dependency_paths: readonly string[];
	final_identities: readonly StreamingPathIdentity[];
	finalization_meter: Readonly<StreamingIdentityMeter>;
}

export type ChangeSetErrorCode =
	| "invalid_input"
	| "invalid_journal"
	| "invalid_guard"
	| "invalid_dependencies"
	| "invalid_finals"
	| "invalid_meter"
	| "limit_exceeded";

export interface ChangeSetError {
	code: ChangeSetErrorCode;
	message: string;
}

export type ComputeChangeSetResult =
	| { ok: true; value: Readonly<ChangeSetRecord> }
	| { ok: false; error: Readonly<ChangeSetError> };

const ERROR_MESSAGES: Readonly<Record<ChangeSetErrorCode, string>> = Object.freeze({
	invalid_input: "change set input is invalid",
	invalid_journal: "change set journal is invalid",
	invalid_guard: "change set workspace guard is invalid",
	invalid_dependencies: "change set dependency paths are invalid",
	invalid_finals: "change set final identities are invalid",
	invalid_meter: "change set finalization meter is invalid",
	limit_exceeded: "change set hard limit exceeded",
});

const HASH_RE = /^[0-9a-f]{64}$/u;
const DECIMAL_RE = /^(0|[1-9]\d*)$/u;

function isDecimal(value: unknown): value is string {
	return typeof value === "string" && DECIMAL_RE.test(value);
}

function fail(code: ChangeSetErrorCode): ComputeChangeSetResult {
	return { ok: false, error: Object.freeze({ code, message: ERROR_MESSAGES[code] }) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function canonicalHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validIdentity(value: unknown, expectedPath?: string): value is StreamingPathIdentity {
	if (!isPlainObject(value) || value.schema_version !== STREAMING_IDENTITY_SCHEMA_VERSION
		|| !isStrictStreamingIdentityPath(value.path) || (expectedPath !== undefined && value.path !== expectedPath)) return false;
	if (value.kind === "missing") return exactKeys(value, ["schema_version", "kind", "path"]);
	if (value.kind !== "file" || !exactKeys(value, ["schema_version", "kind", "path", "byte_size", "sha256", "stat"])
		|| !safeCounter(value.byte_size) || value.byte_size > STREAMING_IDENTITY_MAX_FILE_BYTES
		|| typeof value.sha256 !== "string" || !HASH_RE.test(value.sha256) || !isPlainObject(value.stat)
		|| !exactKeys(value.stat, ["dev", "ino", "mtime_ns", "ctime_ns"])) return false;
	return isDecimal(value.stat.dev) && isDecimal(value.stat.ino)
		&& isDecimal(value.stat.mtime_ns) && isDecimal(value.stat.ctime_ns);
}

function contentEqual(left: StreamingPathIdentity, right: StreamingPathIdentity): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "missing" || right.kind === "missing") return left.kind === right.kind;
	return left.byte_size === right.byte_size && left.sha256 === right.sha256;
}

function validateStrictJournal(
	value: unknown,
	delegationId: string,
	contractHash: string,
	journalHash: string,
): value is WorkerWriteJournalRecord & { state: "SEALED"; journal_hash: string; operations: readonly CompletedWriteJournalOperation[] } {
	if (!isPlainObject(value) || !exactKeys(value, [
		"schema_version", "delegation_id", "contract_hash", "state", "revision", "limits", "meter", "operations", "journal_hash",
	]) || value.schema_version !== WRITE_JOURNAL_SCHEMA_VERSION || value.delegation_id !== delegationId
		|| value.contract_hash !== contractHash || value.state !== "SEALED" || value.journal_hash !== journalHash
		|| !safeCounter(value.revision) || value.revision > WRITE_JOURNAL_MAX_REVISION || !Array.isArray(value.operations)
		|| value.operations.length > WRITE_JOURNAL_MAX_OPERATIONS || !isPlainObject(value.limits)
		|| !exactKeys(value.limits, ["max_unique_paths", "max_operations", "max_identity_paths", "max_total_bytes", "max_file_bytes", "max_serialized_bytes"])
		|| !isPlainObject(value.meter) || !exactKeys(value.meter, ["paths_attempted", "paths_completed", "bytes_read"])) return false;
	const limits = value.limits;
	if (!safeCounter(limits.max_unique_paths) || limits.max_unique_paths < 1 || limits.max_unique_paths > WRITE_JOURNAL_MAX_UNIQUE_PATHS
		|| !safeCounter(limits.max_operations) || limits.max_operations < 1 || limits.max_operations > WRITE_JOURNAL_MAX_OPERATIONS
		|| !safeCounter(limits.max_identity_paths) || limits.max_identity_paths < 1 || limits.max_identity_paths > STREAMING_IDENTITY_MAX_PATHS
		|| !safeCounter(limits.max_total_bytes) || limits.max_total_bytes < 1 || limits.max_total_bytes > STREAMING_IDENTITY_MAX_TOTAL_BYTES
		|| !safeCounter(limits.max_file_bytes) || limits.max_file_bytes < 1 || limits.max_file_bytes > STREAMING_IDENTITY_MAX_FILE_BYTES
		|| !safeCounter(limits.max_serialized_bytes) || limits.max_serialized_bytes < 1 || limits.max_serialized_bytes > WRITE_JOURNAL_MAX_SERIALIZED_BYTES
		|| value.operations.length > limits.max_operations) return false;
	if (!safeCounter(value.meter.paths_attempted) || !safeCounter(value.meter.paths_completed) || !safeCounter(value.meter.bytes_read)
		|| value.meter.paths_completed > value.meter.paths_attempted || value.meter.paths_attempted > limits.max_identity_paths
		|| value.meter.bytes_read > limits.max_total_bytes) return false;
	const operationIds = new Set<string>();
	const previous = new Map<string, StreamingPathIdentity>();
	const paths = new Set<string>();
	let minimumBytes = 0;
	for (let index = 0; index < value.operations.length; index += 1) {
		const operation = value.operations[index];
		if (!isPlainObject(operation) || !exactKeys(operation, [
			"sequence", "operation_id", "kind", "path", "status", "before", "after", "outcome",
		]) || operation.sequence !== index + 1 || typeof operation.operation_id !== "string" || !HASH_RE.test(operation.operation_id)
			|| operationIds.has(operation.operation_id) || (operation.kind !== "edit" && operation.kind !== "write")
			|| operation.status !== "completed" || (operation.outcome !== "succeeded" && operation.outcome !== "failed")
			|| !isStrictStreamingIdentityPath(operation.path) || !validIdentity(operation.before, operation.path)
			|| !validIdentity(operation.after, operation.path)) return false;
		operationIds.add(operation.operation_id);
		paths.add(operation.path);
		const prior = previous.get(operation.path);
		if (prior !== undefined && !streamingIdentityEqual(prior, operation.before)) return false;
		previous.set(operation.path, operation.after);
		for (const identity of [operation.before, operation.after]) {
			if (identity.kind === "file") {
				if (identity.byte_size > limits.max_file_bytes || minimumBytes > Number.MAX_SAFE_INTEGER - identity.byte_size) return false;
				minimumBytes += identity.byte_size;
			}
		}
	}
	const minimumCaptures = value.operations.length * 2;
	if (paths.size > limits.max_unique_paths || value.meter.paths_completed < minimumCaptures
		|| value.meter.bytes_read < minimumBytes || value.revision < minimumCaptures + 1) return false;
	try {
		if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8") > limits.max_serialized_bytes) return false;
		return computeWorkerWriteJournalHash(value as unknown as WorkerWriteJournalRecord) === journalHash;
	} catch {
		return false;
	}
}

function cloneStreamingIdentity(identity: StreamingPathIdentity): StreamingPathIdentity {
	return identity.kind === "missing"
		? { schema_version: 2, kind: "missing", path: identity.path }
		: {
			schema_version: 2,
			kind: "file",
			path: identity.path,
			byte_size: identity.byte_size,
			sha256: identity.sha256,
			stat: {
				dev: identity.stat.dev,
				ino: identity.stat.ino,
				mtime_ns: identity.stat.mtime_ns,
				ctime_ns: identity.stat.ctime_ns,
			},
		};
}

function cloneGuardIdentity(identity: WorkspaceGuardIdentity): WorkspaceGuardIdentity {
	return identity.kind === "missing"
		? { kind: "missing" }
		: {
			kind: identity.kind,
			byte_size: identity.byte_size,
			stat: {
				dev: identity.stat.dev,
				ino: identity.stat.ino,
				mtime_ns: identity.stat.mtime_ns,
				ctime_ns: identity.stat.ctime_ns,
			},
		};
}

function cloneGuardEntry(entry: WorkspaceGuardEntry): WorkspaceGuardEntry {
	return { path: entry.path, status: entry.status, identity: cloneGuardIdentity(entry.identity) };
}

function guardEntryEqual(left: WorkspaceGuardEntry | undefined, right: WorkspaceGuardEntry | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return JSON.stringify(cloneGuardEntry(left)) === JSON.stringify(cloneGuardEntry(right));
}

function guardMatchesStreaming(guard: WorkspaceGuardIdentity, streaming: StreamingPathIdentity): boolean {
	if (streaming.kind === "missing") return guard.kind === "missing";
	return guard.kind === "file" && guard.byte_size === streaming.byte_size
		&& guard.stat.dev === streaming.stat.dev && guard.stat.ino === streaming.stat.ino
		&& guard.stat.mtime_ns === streaming.stat.mtime_ns && guard.stat.ctime_ns === streaming.stat.ctime_ns;
}

function classifyChange(before: StreamingPathIdentity, after: StreamingPathIdentity): ChangeKind {
	if (before.kind === "missing") return "new";
	if (after.kind === "missing") return "delete";
	return "modify";
}

function contentProjection(identity: StreamingPathIdentity): unknown {
	return identity.kind === "missing"
		? { kind: "missing" }
		: { kind: "file", byte_size: identity.byte_size, sha256: identity.sha256 };
}

function workerDeltaProjection(
	workerDelta: readonly ChangeSetAttributedEntry[],
	conflicts: readonly ChangeSetConflict[],
): unknown {
	if (conflicts.length > 0) {
		return {
			schema_version: CHANGE_SET_SCHEMA_VERSION,
			status: "CONFLICT",
			conflicts: conflicts.map((conflict) => ({ path: conflict.path, reason: conflict.reason })),
		};
	}
	return {
		schema_version: CHANGE_SET_SCHEMA_VERSION,
		status: "ATTRIBUTED",
		entries: workerDelta.map((entry) => ({
			path: entry.path,
			before: contentProjection(entry.before),
			after: contentProjection(entry.after),
		})),
	};
}

export function computeWorkerDeltaHash(
	workerDelta: readonly ChangeSetAttributedEntry[],
	conflicts: readonly ChangeSetConflict[],
): string {
	return canonicalHash(workerDeltaProjection(workerDelta, conflicts));
}

function recordProjection(record: Omit<ChangeSetRecord, "change_set_hash"> | ChangeSetRecord): unknown {
	return {
		schema_version: CHANGE_SET_SCHEMA_VERSION,
		delegation_id: record.delegation_id,
		contract_hash: record.contract_hash,
		journal_hash: record.journal_hash,
		before_workspace_guard_hash: record.before_workspace_guard_hash,
		after_workspace_guard_hash: record.after_workspace_guard_hash,
		dependency_paths: [...record.dependency_paths],
		status: record.status,
		worker_delta: record.worker_delta.map((entry) => ({
			path: entry.path,
			change: entry.change,
			operation_count: entry.operation_count,
			before: cloneStreamingIdentity(entry.before),
			after: cloneStreamingIdentity(entry.after),
		})),
		workspace_drift: record.workspace_drift.map((entry) => ({
			path: entry.path,
			classification: entry.classification,
			before: entry.before === null ? null : cloneGuardEntry(entry.before),
			after: entry.after === null ? null : cloneGuardEntry(entry.after),
		})),
		conflicts: record.conflicts.map((conflict) => ({ path: conflict.path, reason: conflict.reason })),
		finalization_meter: {
			paths_attempted: record.finalization_meter.paths_attempted,
			paths_completed: record.finalization_meter.paths_completed,
			bytes_read: record.finalization_meter.bytes_read,
		},
		counts: {
			touched_paths: record.counts.touched_paths,
			attributed_paths: record.counts.attributed_paths,
			zero_delta_paths: record.counts.zero_delta_paths,
			workspace_drift_paths: record.counts.workspace_drift_paths,
			dependency_drift_paths: record.counts.dependency_drift_paths,
			unknown_origin_drift_paths: record.counts.unknown_origin_drift_paths,
			conflict_paths: record.counts.conflict_paths,
		},
		worker_delta_hash: record.worker_delta_hash,
		workspace_guard_hash: record.workspace_guard_hash,
	};
}

export function computeChangeSetHash(record: Omit<ChangeSetRecord, "change_set_hash"> | ChangeSetRecord): string {
	return canonicalHash(recordProjection(record));
}

function deepFreeze<T>(value: T): Readonly<T> {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

function validSortedUniquePaths(paths: unknown, maximum: number): paths is readonly string[] {
	if (!Array.isArray(paths) || paths.length > maximum) return false;
	let previous: string | undefined;
	for (const path of paths) {
		if (!isStrictStreamingIdentityPath(path) || (previous !== undefined && byteCompare(previous, path) >= 0)) return false;
		previous = path;
	}
	return true;
}

/**
 * Finalize a ChangeSet from caller-observed immutable facts. No content other
 * than the supplied full identities is read or retained.
 */
export function computeChangeSet(input: ComputeChangeSetInput): ComputeChangeSetResult {
	if (!isPlainObject(input) || !exactKeys(input, [
		"delegation_id", "contract_hash", "journal_hash", "journal", "before_guard", "after_guard",
		"dependency_paths", "final_identities", "finalization_meter",
	]) || typeof input.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(input.delegation_id)
		|| typeof input.contract_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(input.contract_hash)
		|| typeof input.journal_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(input.journal_hash)) return fail("invalid_input");
	if (!validateStrictJournal(input.journal, input.delegation_id, input.contract_hash, input.journal_hash)) return fail("invalid_journal");
	if (!validateWorkspaceGuard(input.before_guard) || !validateWorkspaceGuard(input.after_guard)
		|| input.before_guard.schema_version !== WORKSPACE_GUARD_SCHEMA_VERSION
		|| input.after_guard.schema_version !== WORKSPACE_GUARD_SCHEMA_VERSION
		|| input.before_guard.entries.length > WORKSPACE_GUARD_MAX_RELEVANT_PATHS
		|| input.after_guard.entries.length > WORKSPACE_GUARD_MAX_RELEVANT_PATHS
		|| input.before_guard.git_head !== input.after_guard.git_head) return fail("invalid_guard");
	if (!validSortedUniquePaths(input.dependency_paths, CHANGE_SET_MAX_PATHS)) return fail("invalid_dependencies");

	const firstByPath = new Map<string, CompletedWriteJournalOperation>();
	const lastByPath = new Map<string, CompletedWriteJournalOperation>();
	const operationCount = new Map<string, number>();
	for (const operation of input.journal.operations) {
		if (!firstByPath.has(operation.path)) firstByPath.set(operation.path, operation);
		lastByPath.set(operation.path, operation);
		operationCount.set(operation.path, (operationCount.get(operation.path) ?? 0) + 1);
	}
	const touchedPaths = [...firstByPath.keys()].sort(byteCompare);
	if (touchedPaths.length > CHANGE_SET_MAX_PATHS) return fail("limit_exceeded");
	if (!Array.isArray(input.final_identities) || input.final_identities.length !== touchedPaths.length) return fail("invalid_finals");
	for (let index = 0; index < input.final_identities.length; index += 1) {
		if (!validIdentity(input.final_identities[index], touchedPaths[index])) return fail("invalid_finals");
	}
	if (!isPlainObject(input.finalization_meter) || !exactKeys(input.finalization_meter, ["paths_attempted", "paths_completed", "bytes_read"])
		|| input.finalization_meter.paths_attempted !== touchedPaths.length
		|| input.finalization_meter.paths_completed !== touchedPaths.length
		|| !safeCounter(input.finalization_meter.bytes_read) || input.finalization_meter.bytes_read > STREAMING_IDENTITY_MAX_TOTAL_BYTES) {
		return fail("invalid_meter");
	}
	let minimumFinalBytes = 0;
	for (const identity of input.final_identities) {
		if (identity.kind === "file") {
			if (minimumFinalBytes > Number.MAX_SAFE_INTEGER - identity.byte_size) return fail("invalid_meter");
			minimumFinalBytes += identity.byte_size;
		}
	}
	if (input.finalization_meter.bytes_read < minimumFinalBytes) return fail("invalid_meter");

	const beforeGuard = new Map(input.before_guard.entries.map((entry) => [entry.path, entry] as const));
	const afterGuard = new Map(input.after_guard.entries.map((entry) => [entry.path, entry] as const));
	const conflicts: ChangeSetConflict[] = [];
	for (let index = 0; index < touchedPaths.length; index += 1) {
		const path = touchedPaths[index]!;
		const first = firstByPath.get(path)!;
		const last = lastByPath.get(path)!;
		const finalIdentity = input.final_identities[index]!;
		if (!streamingIdentityEqual(finalIdentity, last.after)) {
			conflicts.push({ path, reason: "final_identity_mismatch" });
			continue;
		}
		const beforeEntry = beforeGuard.get(path);
		const afterEntry = afterGuard.get(path);
		if ((beforeEntry !== undefined && !guardMatchesStreaming(beforeEntry.identity, first.before))
			|| (afterEntry !== undefined && !guardMatchesStreaming(afterEntry.identity, finalIdentity))) {
			conflicts.push({ path, reason: "guard_identity_mismatch" });
		}
	}

	const dependencySet = new Set(input.dependency_paths);
	const touchedSet = new Set(touchedPaths);
	const allGuardPaths = new Set([...beforeGuard.keys(), ...afterGuard.keys()]);
	const workspaceDrift: WorkspaceDriftEntry[] = [];
	for (const path of [...allGuardPaths].sort(byteCompare)) {
		if (touchedSet.has(path)) continue;
		const before = beforeGuard.get(path);
		const after = afterGuard.get(path);
		if (guardEntryEqual(before, after)) continue;
		workspaceDrift.push({
			path,
			classification: dependencySet.has(path) ? "dependency" : "unknown_origin",
			before: before === undefined ? null : cloneGuardEntry(before),
			after: after === undefined ? null : cloneGuardEntry(after),
		});
	}
	if (workspaceDrift.length > CHANGE_SET_MAX_PATHS) return fail("limit_exceeded");

	const workerDelta: ChangeSetAttributedEntry[] = [];
	if (conflicts.length === 0) {
		for (let index = 0; index < touchedPaths.length; index += 1) {
			const path = touchedPaths[index]!;
			const before = firstByPath.get(path)!.before;
			const after = input.final_identities[index]!;
			if (contentEqual(before, after)) continue;
			workerDelta.push({
				path,
				change: classifyChange(before, after),
				operation_count: operationCount.get(path)!,
				before: cloneStreamingIdentity(before),
				after: cloneStreamingIdentity(after),
			});
		}
	}
	const dependencyDrift = workspaceDrift.filter((entry) => entry.classification === "dependency").length;
	const unknownDrift = workspaceDrift.length - dependencyDrift;
	const counts: ChangeSetCounts = {
		touched_paths: touchedPaths.length,
		attributed_paths: workerDelta.length,
		zero_delta_paths: conflicts.length === 0 ? touchedPaths.length - workerDelta.length : 0,
		workspace_drift_paths: workspaceDrift.length,
		dependency_drift_paths: dependencyDrift,
		unknown_origin_drift_paths: unknownDrift,
		conflict_paths: conflicts.length,
	};
	const status: ChangeSetStatus = conflicts.length > 0 ? "CONFLICT" : workspaceDrift.length > 0 ? "WORKSPACE_DRIFT" : "ATTRIBUTED";
	const workerDeltaHash = computeWorkerDeltaHash(workerDelta, conflicts);
	const withoutHash: Omit<ChangeSetRecord, "change_set_hash"> = {
		schema_version: CHANGE_SET_SCHEMA_VERSION,
		delegation_id: input.delegation_id,
		contract_hash: input.contract_hash,
		journal_hash: input.journal_hash,
		before_workspace_guard_hash: input.before_guard.workspace_guard_hash,
		after_workspace_guard_hash: input.after_guard.workspace_guard_hash,
		dependency_paths: [...input.dependency_paths],
		status,
		worker_delta: workerDelta,
		workspace_drift: workspaceDrift,
		conflicts,
		finalization_meter: { ...input.finalization_meter },
		counts,
		worker_delta_hash: workerDeltaHash,
		workspace_guard_hash: input.after_guard.workspace_guard_hash,
	};
	const value: ChangeSetRecord = { ...withoutHash, change_set_hash: computeChangeSetHash(withoutHash) };
	return { ok: true, value: deepFreeze(value) };
}

function validGuardStat(value: unknown): boolean {
	return isPlainObject(value) && exactKeys(value, ["dev", "ino", "mtime_ns", "ctime_ns"])
		&& isDecimal(value.dev) && isDecimal(value.ino)
		&& isDecimal(value.mtime_ns) && isDecimal(value.ctime_ns);
}

function validGuardIdentity(value: unknown): value is WorkspaceGuardIdentity {
	if (!isPlainObject(value) || typeof value.kind !== "string") return false;
	if (value.kind === "missing") return exactKeys(value, ["kind"]);
	return ["file", "directory", "symlink", "other"].includes(value.kind)
		&& exactKeys(value, ["kind", "byte_size", "stat"])
		&& safeCounter(value.byte_size) && validGuardStat(value.stat);
}

function validGuardEntry(value: unknown, expectedPath: string): value is WorkspaceGuardEntry {
	if (!isPlainObject(value) || !exactKeys(value, ["path", "status", "identity"])
		|| value.path !== expectedPath || typeof value.status !== "string" || value.status.length !== 2
		|| !validGuardIdentity(value.identity)) return false;
	const [x, y] = value.status;
	const allowed = new Set([" ", "M", "A", "D", "R", "C", "U", "?", "!"]);
	if (!x || !y || !allowed.has(x) || !allowed.has(y) || value.status === "  ") return false;
	if ((x === "?" || y === "?") && value.status !== "??") return false;
	return !((x === "!" || y === "!") && value.status !== "!!");
}

function validAttributedEntry(value: unknown): value is ChangeSetAttributedEntry {
	if (!isPlainObject(value) || !exactKeys(value, ["path", "change", "operation_count", "before", "after"])
		|| !isStrictStreamingIdentityPath(value.path) || typeof value.change !== "string"
		|| !["new", "modify", "delete"].includes(value.change)
		|| !safeCounter(value.operation_count) || value.operation_count < 1
		|| !validIdentity(value.before, value.path) || !validIdentity(value.after, value.path)
		|| contentEqual(value.before, value.after)) return false;
	return classifyChange(value.before, value.after) === value.change;
}

function validateDrift(value: unknown): value is WorkspaceDriftEntry {
	if (!isPlainObject(value) || !exactKeys(value, ["path", "classification", "before", "after"])
		|| !isStrictWorkspaceGuardPath(value.path)
		|| (value.classification !== "dependency" && value.classification !== "unknown_origin")
		|| (value.before !== null && !validGuardEntry(value.before, value.path))
		|| (value.after !== null && !validGuardEntry(value.after, value.path))
		|| (value.before === null && value.after === null)) return false;
	return !guardEntryEqual(value.before === null ? undefined : value.before, value.after === null ? undefined : value.after);
}

function validConflict(value: unknown): value is ChangeSetConflict {
	return isPlainObject(value) && exactKeys(value, ["path", "reason"])
		&& isStrictStreamingIdentityPath(value.path)
		&& (value.reason === "final_identity_mismatch" || value.reason === "guard_identity_mismatch");
}

/** Strict, closed-schema validator for persisted ChangeSet v2 records. */
export function validateChangeSet(value: unknown): value is ChangeSetRecord {
	if (!isPlainObject(value) || !exactKeys(value, [
		"schema_version", "delegation_id", "contract_hash", "journal_hash", "before_workspace_guard_hash",
		"after_workspace_guard_hash", "dependency_paths", "status", "worker_delta", "workspace_drift", "conflicts",
		"finalization_meter", "counts", "worker_delta_hash", "workspace_guard_hash", "change_set_hash",
	]) || value.schema_version !== CHANGE_SET_SCHEMA_VERSION
		|| typeof value.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(value.delegation_id)
		|| typeof value.contract_hash !== "string" || !HASH_RE.test(value.contract_hash)
		|| typeof value.journal_hash !== "string" || !HASH_RE.test(value.journal_hash)
		|| typeof value.before_workspace_guard_hash !== "string" || !HASH_RE.test(value.before_workspace_guard_hash)
		|| typeof value.after_workspace_guard_hash !== "string" || !HASH_RE.test(value.after_workspace_guard_hash)
		|| typeof value.workspace_guard_hash !== "string" || value.workspace_guard_hash !== value.after_workspace_guard_hash
		|| typeof value.worker_delta_hash !== "string" || !HASH_RE.test(value.worker_delta_hash)
		|| typeof value.change_set_hash !== "string" || !HASH_RE.test(value.change_set_hash)
		|| typeof value.status !== "string" || !["ATTRIBUTED", "WORKSPACE_DRIFT", "CONFLICT"].includes(value.status)
		|| !validSortedUniquePaths(value.dependency_paths, CHANGE_SET_MAX_PATHS)
		|| !Array.isArray(value.worker_delta) || value.worker_delta.length > CHANGE_SET_MAX_PATHS
		|| !Array.isArray(value.workspace_drift) || value.workspace_drift.length > CHANGE_SET_MAX_PATHS
		|| !Array.isArray(value.conflicts) || value.conflicts.length > CHANGE_SET_MAX_PATHS) return false;
	let previous: string | undefined;
	const deltaPaths = new Set<string>();
	let minimumRecordedFinalBytes = 0;
	for (const entry of value.worker_delta) {
		if (!validAttributedEntry(entry) || (previous !== undefined && byteCompare(previous, entry.path) >= 0)) return false;
		if (entry.after.kind === "file") {
			if (minimumRecordedFinalBytes > Number.MAX_SAFE_INTEGER - entry.after.byte_size) return false;
			minimumRecordedFinalBytes += entry.after.byte_size;
		}
		deltaPaths.add(entry.path);
		previous = entry.path;
	}
	previous = undefined;
	let dependencyDrift = 0;
	for (const entry of value.workspace_drift) {
		if (!validateDrift(entry) || (previous !== undefined && byteCompare(previous, entry.path) >= 0)) return false;
		if (deltaPaths.has(entry.path)) return false;
		if ((value.dependency_paths as readonly string[]).includes(entry.path) !== (entry.classification === "dependency")) return false;
		if (entry.classification === "dependency") dependencyDrift += 1;
		previous = entry.path;
	}
	previous = undefined;
	for (const conflict of value.conflicts) {
		if (!validConflict(conflict) || (previous !== undefined && byteCompare(previous, conflict.path) >= 0)) return false;
		if (deltaPaths.has(conflict.path) || (value.workspace_drift as readonly WorkspaceDriftEntry[]).some((entry) => entry.path === conflict.path)) return false;
		previous = conflict.path;
	}
	if (!isPlainObject(value.finalization_meter) || !exactKeys(value.finalization_meter, ["paths_attempted", "paths_completed", "bytes_read"])
		|| !safeCounter(value.finalization_meter.paths_attempted)
		|| value.finalization_meter.paths_completed !== value.finalization_meter.paths_attempted
		|| value.finalization_meter.paths_attempted > STREAMING_IDENTITY_MAX_PATHS
		|| !safeCounter(value.finalization_meter.bytes_read) || value.finalization_meter.bytes_read > STREAMING_IDENTITY_MAX_TOTAL_BYTES
		|| !isPlainObject(value.counts) || !exactKeys(value.counts, [
			"touched_paths", "attributed_paths", "zero_delta_paths", "workspace_drift_paths",
			"dependency_drift_paths", "unknown_origin_drift_paths", "conflict_paths",
		])) return false;
	for (const count of Object.values(value.counts)) if (!safeCounter(count)) return false;
	if (value.counts.touched_paths !== value.finalization_meter.paths_attempted
		|| value.counts.attributed_paths !== value.worker_delta.length
		|| value.counts.workspace_drift_paths !== value.workspace_drift.length
		|| value.counts.dependency_drift_paths !== dependencyDrift
		|| value.counts.unknown_origin_drift_paths !== value.workspace_drift.length - dependencyDrift
		|| value.counts.conflict_paths !== value.conflicts.length
		|| value.finalization_meter.bytes_read < minimumRecordedFinalBytes) return false;
	if (value.status === "CONFLICT") {
		if (value.conflicts.length === 0 || value.worker_delta.length !== 0 || value.counts.zero_delta_paths !== 0) return false;
	} else {
		if (value.conflicts.length !== 0 || value.counts.zero_delta_paths !== value.counts.touched_paths - value.worker_delta.length) return false;
		if (value.status === "ATTRIBUTED" && value.workspace_drift.length !== 0) return false;
		if (value.status === "WORKSPACE_DRIFT" && value.workspace_drift.length === 0) return false;
	}
	if (value.worker_delta_hash !== computeWorkerDeltaHash(value.worker_delta, value.conflicts)) return false;
	return value.change_set_hash === computeChangeSetHash(value as unknown as ChangeSetRecord);
}
