/**
 * Runtime bridge between Pi worker edit/write events and ChangeSet v2's
 * durable worker write journal.
 *
 * This boundary retains only bounded identifiers, one canonical path, and an
 * exact journal revision. Raw tool input, file content, errors, and storage
 * details are never copied into runtime errors or telemetry.
 */

import { createHash } from "node:crypto";
import { isAbsolute, posix, resolve } from "node:path";
import { types as utilTypes } from "node:util";

import {
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
} from "./delegation-transaction.ts";
import {
	STREAMING_IDENTITY_MAX_PATH_BYTES,
	isStrictStreamingIdentityPath,
} from "./streaming-identity.ts";
import {
	beginWriteJournalOperation,
	completeWriteJournalOperation,
	readWorkerWriteJournal,
	type BeginWriteJournalOperationInput,
	type CompleteWriteJournalOperationInput,
	type ReadWorkerWriteJournalInput,
	type WorkerWriteJournalRecord,
	type WriteJournalResult,
} from "./write-journal.ts";

export const WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_ENTRY_TYPE =
	"workbench-worker-write-journal-runtime-v1" as const;
export const WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA =
	"workbench-worker-write-journal-runtime-v1" as const;
export const WORKER_WRITE_JOURNAL_RUNTIME_OPERATION_SCHEMA =
	"workbench-worker-write-journal-operation-v1" as const;
export const WORKER_WRITE_JOURNAL_RUNTIME_BLOCK_REASON =
	"Worker write journal unavailable" as const;
export const WORKER_WRITE_JOURNAL_RUNTIME_SERIALIZE_REASON =
	"Parallel worker writes are not supported; retry this write after the pending write completes." as const;
export const WORKER_WRITE_JOURNAL_RUNTIME_RESULT_ERROR_TEXT =
	"Worker write journal completion failed; further worker writes are blocked." as const;
export const WORKER_WRITE_JOURNAL_RUNTIME_MAX_TOOL_CALL_ID_CHARS = 256 as const;

export type WorkerWriteJournalRuntimeTool = "edit" | "write";
export type WorkerWriteJournalRuntimeApplicability = "active" | "not_applicable" | "invalid_context";
export type WorkerWriteJournalRuntimeFailureCode =
	| "invalid_context"
	| "invalid_call_id"
	| "invalid_path"
	| "pending_conflict"
	| "unbegun_result"
	| "result_mismatch"
	| "journal_read_failed"
	| "journal_not_open"
	| "journal_begin_failed"
	| "journal_complete_failed"
	| "telemetry_failed"
	| "poisoned";

export type WorkerWriteJournalRuntimeTelemetryPhase = "begin" | "complete" | "failure";
export type WorkerWriteJournalRuntimeTelemetryOutcome = "none" | "succeeded" | "failed";
export type WorkerWriteJournalRuntimeTelemetryCode = "none" | WorkerWriteJournalRuntimeFailureCode;

/** Closed telemetry DTO: all fields are fixed enums or safe non-negative numbers. */
export interface WorkerWriteJournalRuntimeTelemetry {
	schema: typeof WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA;
	phase: WorkerWriteJournalRuntimeTelemetryPhase;
	tool: WorkerWriteJournalRuntimeTool;
	outcome: WorkerWriteJournalRuntimeTelemetryOutcome;
	code: WorkerWriteJournalRuntimeTelemetryCode;
	revision: number;
	poisoned: 0 | 1;
}

export type WorkerWriteJournalRuntimeObservationState = "empty" | "begun" | "complete" | "failed";
export type WorkerWriteJournalRuntimeObservationTool = "none" | WorkerWriteJournalRuntimeTool;
export type WorkerWriteJournalRuntimeObservationCode = "none" | "invalid" | WorkerWriteJournalRuntimeFailureCode;

/**
 * Closed, content-free parent observation of the worker journal protocol.
 * Only fixed enums and the last safe journal revision cross the child boundary.
 */
export interface WorkerWriteJournalRuntimeObservation {
	state: WorkerWriteJournalRuntimeObservationState;
	tool: WorkerWriteJournalRuntimeObservationTool;
	outcome: WorkerWriteJournalRuntimeTelemetryOutcome;
	code: WorkerWriteJournalRuntimeObservationCode;
	revision: number;
}

/** Exact immutable observation before any trusted journal telemetry arrives. */
export const EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION: Readonly<WorkerWriteJournalRuntimeObservation> =
	Object.freeze({
		state: "empty",
		tool: "none",
		outcome: "none",
		code: "none",
		revision: 0,
	});

export interface WorkerWriteJournalRuntimeContext {
	role: unknown;
	task_kind: unknown;
	project_root: unknown;
	delegation_id: unknown;
	contract_hash: unknown;
}

export interface WorkerWriteJournalOperationIdInput {
	delegation_id: unknown;
	contract_hash: unknown;
	tool_call_id: unknown;
	tool: unknown;
	path: unknown;
}

export interface WorkerWriteJournalBeginInput {
	toolCallId: unknown;
	toolName: unknown;
	path: unknown;
}

export interface WorkerWriteJournalCompleteInput {
	toolCallId: unknown;
	toolName: unknown;
	isError: unknown;
}

export type WorkerWriteJournalRuntimeResult =
	| { ok: true; action: "not_applicable" }
	| { ok: true; action: "begun" | "completed"; revision: number; operation_id: string }
	| { ok: false; code: WorkerWriteJournalRuntimeFailureCode; reason:
		typeof WORKER_WRITE_JOURNAL_RUNTIME_BLOCK_REASON | typeof WORKER_WRITE_JOURNAL_RUNTIME_SERIALIZE_REASON };

export interface WorkerWriteJournalRuntimeState {
	applicability: WorkerWriteJournalRuntimeApplicability;
	poisoned: 0 | 1;
	pending: 0 | 1;
	revision: number;
}

type ReadJournal = (
	input: ReadWorkerWriteJournalInput,
) => Promise<WriteJournalResult<WorkerWriteJournalRecord>>;
type BeginJournal = (
	input: BeginWriteJournalOperationInput,
) => Promise<WriteJournalResult<WorkerWriteJournalRecord>>;
type CompleteJournal = (
	input: CompleteWriteJournalOperationInput,
) => Promise<WriteJournalResult<WorkerWriteJournalRecord>>;

export interface WorkerWriteJournalRuntimeDependencies {
	appendTelemetry: (telemetry: Readonly<WorkerWriteJournalRuntimeTelemetry>) => void;
	readJournal?: ReadJournal;
	beginJournal?: BeginJournal;
	completeJournal?: CompleteJournal;
}

export interface WorkerWriteJournalRuntime {
	beginToolCall(input: Readonly<WorkerWriteJournalBeginInput>): Promise<WorkerWriteJournalRuntimeResult>;
	completeToolResult(input: Readonly<WorkerWriteJournalCompleteInput>): Promise<WorkerWriteJournalRuntimeResult>;
	inspectState(): Readonly<WorkerWriteJournalRuntimeState>;
}

interface ActiveContext {
	projectRoot: string;
	delegationId: string;
	contractHash: string;
}

interface PendingHandle {
	toolCallId: string;
	tool: WorkerWriteJournalRuntimeTool;
	path: string;
	operationId: string;
	revision: number;
}

const CONTEXT_FIELDS = ["role", "task_kind", "project_root", "delegation_id", "contract_hash"] as const;
const OPERATION_ID_FIELDS = ["delegation_id", "contract_hash", "tool_call_id", "tool", "path"] as const;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

function isPlainExactRecord(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		if (Object.getOwnPropertySymbols(value).length !== 0) return false;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const names = Object.keys(descriptors).sort();
		const expected = [...fields].sort();
		if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return false;
		return fields.every((field) => {
			const descriptor = descriptors[field];
			return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
		});
	} catch {
		return false;
	}
}

function exactValue(value: Record<string, unknown>, key: string): unknown {
	return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function isTool(value: unknown): value is WorkerWriteJournalRuntimeTool {
	return value === "edit" || value === "write";
}

function normalizeToolCallId(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value !== value.trim()
		|| value.length > WORKER_WRITE_JOURNAL_RUNTIME_MAX_TOOL_CALL_ID_CHARS) {
		return undefined;
	}
	return CONTROL_RE.test(value) ? undefined : value;
}

/**
 * Canonicalize an already policy-approved relative path for the strict journal
 * schema. Windows separators, controls, escapes, and overlong values fail.
 */
export function normalizeWorkerWriteJournalPath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > STREAMING_IDENTITY_MAX_PATH_BYTES) {
		return undefined;
	}
	if (isAbsolute(value) || value.includes("\\") || CONTROL_RE.test(value)) return undefined;
	const normalized = posix.normalize(value);
	return isStrictStreamingIdentityPath(normalized) ? normalized : undefined;
}

/** Deterministic content-free operation id bound to the exact worker call projection. */
export function deriveWorkerWriteJournalOperationId(
	input: Readonly<WorkerWriteJournalOperationIdInput>,
): string | undefined {
	if (!isPlainExactRecord(input, OPERATION_ID_FIELDS)) return undefined;
	const delegationId = exactValue(input, "delegation_id");
	const contractHash = exactValue(input, "contract_hash");
	const toolCallId = normalizeToolCallId(exactValue(input, "tool_call_id"));
	const tool = exactValue(input, "tool");
	const path = exactValue(input, "path");
	if (typeof delegationId !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(delegationId)
		|| typeof contractHash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(contractHash)
		|| toolCallId === undefined || !isTool(tool) || !isStrictStreamingIdentityPath(path)) return undefined;
	const projection = JSON.stringify({
		schema: WORKER_WRITE_JOURNAL_RUNTIME_OPERATION_SCHEMA,
		delegation_id: delegationId,
		contract_hash: contractHash,
		tool_call_id: toolCallId,
		tool,
		path,
	});
	return createHash("sha256").update(projection, "utf8").digest("hex");
}

function parseContext(value: unknown): { applicability: WorkerWriteJournalRuntimeApplicability; active?: ActiveContext } {
	if (!isPlainExactRecord(value, CONTEXT_FIELDS)) return { applicability: "invalid_context" };
	const role = exactValue(value, "role");
	if (role !== "worker") return { applicability: "not_applicable" };
	const taskKind = exactValue(value, "task_kind");
	if (taskKind === "diagnosis") return { applicability: "not_applicable" };
	const projectRoot = exactValue(value, "project_root");
	const delegationId = exactValue(value, "delegation_id");
	const contractHash = exactValue(value, "contract_hash");
	if (taskKind !== "implementation" || typeof projectRoot !== "string" || projectRoot.length === 0
		|| projectRoot !== projectRoot.trim() || CONTROL_RE.test(projectRoot) || !isAbsolute(projectRoot)
		|| resolve(projectRoot) !== projectRoot || typeof delegationId !== "string"
		|| !DELEGATION_TRANSACTION_ID_RE.test(delegationId) || typeof contractHash !== "string"
		|| !DELEGATION_TRANSACTION_HASH_RE.test(contractHash)) return { applicability: "invalid_context" };
	return {
		applicability: "active",
		active: { projectRoot, delegationId, contractHash },
	};
}

function validJournalRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const OBSERVATION_FIELDS = ["state", "tool", "outcome", "code", "revision"] as const;
const TELEMETRY_FIELDS = ["schema", "phase", "tool", "outcome", "code", "revision", "poisoned"] as const;

interface ParsedRuntimeTelemetry {
	phase: WorkerWriteJournalRuntimeTelemetryPhase;
	tool: WorkerWriteJournalRuntimeTool;
	outcome: WorkerWriteJournalRuntimeTelemetryOutcome;
	code: WorkerWriteJournalRuntimeTelemetryCode;
	revision: number;
	poisoned: 0 | 1;
}

type RuntimeTelemetryEntry =
	| { kind: "unrelated" }
	| { kind: "invalid" }
	| { kind: "telemetry"; value: ParsedRuntimeTelemetry };

function exactPlainDataRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	try {
		if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const names = Object.keys(descriptors).sort();
		const expected = [...fields].sort();
		if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return undefined;
		const record: Record<string, unknown> = Object.create(null);
		for (const field of fields) {
			const descriptor = descriptors[field];
			if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
				return undefined;
			}
			record[field] = descriptor.value;
		}
		return record;
	} catch {
		return undefined;
	}
}

function isTelemetryPhase(value: unknown): value is WorkerWriteJournalRuntimeTelemetryPhase {
	return value === "begin" || value === "complete" || value === "failure";
}

function isTelemetryOutcome(value: unknown): value is WorkerWriteJournalRuntimeTelemetryOutcome {
	return value === "none" || value === "succeeded" || value === "failed";
}

function isTelemetryFailureCode(value: unknown): value is WorkerWriteJournalRuntimeFailureCode {
	return value === "invalid_context"
		|| value === "invalid_call_id"
		|| value === "invalid_path"
		|| value === "pending_conflict"
		|| value === "unbegun_result"
		|| value === "result_mismatch"
		|| value === "journal_read_failed"
		|| value === "journal_not_open"
		|| value === "journal_begin_failed"
		|| value === "journal_complete_failed"
		|| value === "telemetry_failed"
		|| value === "poisoned";
}

function isTelemetryCode(value: unknown): value is WorkerWriteJournalRuntimeTelemetryCode {
	return value === "none" || isTelemetryFailureCode(value);
}

function matchingRuntimeTelemetryEntry(entry: unknown): RuntimeTelemetryEntry {
	try {
		if (entry === null || typeof entry !== "object" || utilTypes.isProxy(entry)) return { kind: "unrelated" };
		const customType = Object.getOwnPropertyDescriptor(entry, "customType");
		if (!customType) return { kind: "unrelated" };
		if (!Object.prototype.hasOwnProperty.call(customType, "value")) return { kind: "invalid" };
		if (customType.value !== WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_ENTRY_TYPE) return { kind: "unrelated" };
		const type = Object.getOwnPropertyDescriptor(entry, "type");
		const data = Object.getOwnPropertyDescriptor(entry, "data");
		if (!type || !Object.prototype.hasOwnProperty.call(type, "value") || type.value !== "custom"
			|| !data || !Object.prototype.hasOwnProperty.call(data, "value")) return { kind: "invalid" };
		const record = exactPlainDataRecord(data.value, TELEMETRY_FIELDS);
		if (record === undefined
			|| record.schema !== WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA
			|| !isTelemetryPhase(record.phase)
			|| !isTool(record.tool)
			|| !isTelemetryOutcome(record.outcome)
			|| !isTelemetryCode(record.code)
			|| !validJournalRevision(record.revision)
			|| (record.poisoned !== 0 && record.poisoned !== 1)) return { kind: "invalid" };
		return {
			kind: "telemetry",
			value: {
				phase: record.phase,
				tool: record.tool,
				outcome: record.outcome,
				code: record.code,
				revision: record.revision,
				poisoned: record.poisoned,
			},
		};
	} catch {
		return { kind: "unrelated" };
	}
}

function exactObservation(value: unknown): Readonly<WorkerWriteJournalRuntimeObservation> | undefined {
	const record = exactPlainDataRecord(value, OBSERVATION_FIELDS);
	if (record === undefined || !validJournalRevision(record.revision)
		|| (record.state !== "empty" && record.state !== "begun" && record.state !== "complete" && record.state !== "failed")
		|| (record.tool !== "none" && !isTool(record.tool))
		|| !isTelemetryOutcome(record.outcome)
		|| (record.code !== "none" && record.code !== "invalid" && !isTelemetryFailureCode(record.code))) return undefined;
	if (record.state === "empty") {
		if (record.tool !== "none" || record.outcome !== "none" || record.code !== "none" || record.revision !== 0) return undefined;
	} else if (record.state === "begun") {
		if (!isTool(record.tool) || record.outcome !== "none" || record.code !== "none") return undefined;
	} else if (record.state === "complete") {
		if (!isTool(record.tool) || (record.outcome !== "succeeded" && record.outcome !== "failed") || record.code !== "none") {
			return undefined;
		}
	} else if (record.code === "none" || (record.code !== "invalid" && !isTool(record.tool))) {
		return undefined;
	}
	return record as unknown as Readonly<WorkerWriteJournalRuntimeObservation>;
}

/** Validate a content-free journal cursor before a fresh child observes later revisions. */
export function validateWorkerWriteJournalRuntimeObservation(
	value: unknown,
): value is Readonly<WorkerWriteJournalRuntimeObservation> {
	return exactObservation(value) !== undefined;
}

function invalidObservation(revision: number): Readonly<WorkerWriteJournalRuntimeObservation> {
	return Object.freeze({
		state: "failed",
		tool: "none",
		outcome: "none",
		code: "invalid",
		revision,
	});
}

/**
 * Purely observe the fixed Pi custom entry emitted by the worker journal
 * bridge. Unrelated entries preserve object identity. Once failed, the
 * observation is sticky and later child entries cannot repair it.
 */
export function observeWorkerWriteJournalRuntimeEntry(
	entry: unknown,
	current: Readonly<WorkerWriteJournalRuntimeObservation>,
): Readonly<WorkerWriteJournalRuntimeObservation> {
	const matched = matchingRuntimeTelemetryEntry(entry);
	if (matched.kind === "unrelated") return current;
	const previous = exactObservation(current);
	if (previous === undefined) return invalidObservation(0);
	if (previous.state === "failed") return current;
	if (matched.kind === "invalid") return invalidObservation(previous.revision);
	const telemetry = matched.value;
	if (telemetry.phase === "failure" || telemetry.code !== "none" || telemetry.poisoned === 1) {
		if (telemetry.phase !== "failure" || telemetry.code === "none" || telemetry.poisoned !== 1) {
			return invalidObservation(previous.revision);
		}
		return Object.freeze({
			state: "failed",
			tool: telemetry.tool,
			outcome: telemetry.outcome,
			code: telemetry.code,
			revision: telemetry.revision,
		});
	}
	if (previous.revision === Number.MAX_SAFE_INTEGER || telemetry.revision !== previous.revision + 1) {
		return invalidObservation(previous.revision);
	}
	if (telemetry.phase === "begin" && telemetry.outcome === "none"
		&& (previous.state === "empty" || previous.state === "complete")) {
		return Object.freeze({
			state: "begun",
			tool: telemetry.tool,
			outcome: "none",
			code: "none",
			revision: telemetry.revision,
		});
	}
	if (telemetry.phase === "complete" && (telemetry.outcome === "succeeded" || telemetry.outcome === "failed")
		&& previous.state === "begun" && telemetry.tool === previous.tool) {
		return Object.freeze({
			state: "complete",
			tool: telemetry.tool,
			outcome: telemetry.outcome,
			code: "none",
			revision: telemetry.revision,
		});
	}
	return invalidObservation(previous.revision);
}

function isThenable(value: unknown): boolean {
	try {
		return value !== null && (typeof value === "object" || typeof value === "function")
			&& typeof (value as { then?: unknown }).then === "function";
	} catch {
		return true;
	}
}

/** Construct one process-local, globally single-pending worker journal bridge. */
export function createWorkerWriteJournalRuntime(
	context: Readonly<WorkerWriteJournalRuntimeContext>,
	dependencies: Readonly<WorkerWriteJournalRuntimeDependencies>,
): WorkerWriteJournalRuntime {
	const parsed = parseContext(context);
	const active = parsed.active;
	const readJournal = dependencies?.readJournal ?? readWorkerWriteJournal;
	const beginJournal = dependencies?.beginJournal ?? beginWriteJournalOperation;
	const completeJournal = dependencies?.completeJournal ?? completeWriteJournalOperation;
	const appendTelemetry = dependencies?.appendTelemetry;
	let poisoned = parsed.applicability === "invalid_context" || typeof appendTelemetry !== "function";
	let pending: PendingHandle | undefined;
	let beginning = false;
	const blockedParallelCalls = new Map<string, WorkerWriteJournalRuntimeTool>();
	let revision = 0;

	function emitTelemetry(telemetry: WorkerWriteJournalRuntimeTelemetry): boolean {
		try {
			if (typeof appendTelemetry !== "function") return false;
			const returned = (appendTelemetry as (value: Readonly<WorkerWriteJournalRuntimeTelemetry>) => unknown)(
				Object.freeze({ ...telemetry }),
			);
			return !isThenable(returned);
		} catch {
			return false;
		}
	}

	function failed(
		code: WorkerWriteJournalRuntimeFailureCode,
		tool: WorkerWriteJournalRuntimeTool,
		outcome: WorkerWriteJournalRuntimeTelemetryOutcome = "none",
	): WorkerWriteJournalRuntimeResult {
		poisoned = true;
		const emitted = emitTelemetry({
			schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA,
			phase: "failure",
			tool,
			outcome,
			code,
			revision,
			poisoned: 1,
		});
		return {
			ok: false,
			code: emitted ? code : "telemetry_failed",
			reason: WORKER_WRITE_JOURNAL_RUNTIME_BLOCK_REASON,
		};
	}

	async function beginToolCall(
		input: Readonly<WorkerWriteJournalBeginInput>,
	): Promise<WorkerWriteJournalRuntimeResult> {
		const tool = input?.toolName;
		if (!isTool(tool)) return { ok: true, action: "not_applicable" };
		if (parsed.applicability === "not_applicable") return { ok: true, action: "not_applicable" };
		if (parsed.applicability !== "active" || active === undefined) return failed("invalid_context", tool);
		if (poisoned) return failed("poisoned", tool);
		const toolCallId = normalizeToolCallId(input?.toolCallId);
		if (toolCallId === undefined) return failed("invalid_call_id", tool);
		if (pending !== undefined || beginning) {
			// Pi may issue independent edit/write calls in parallel. The journal is
			// intentionally serial, so block only the later call and let the model
			// retry it after the active call completes. No mutation happened for the
			// blocked call, therefore poisoning the durable transaction would turn a
			// scheduling detail into an unrecoverable cross-file failure.
			blockedParallelCalls.set(toolCallId, tool);
			return { ok: false, code: "pending_conflict", reason: WORKER_WRITE_JOURNAL_RUNTIME_SERIALIZE_REASON };
		}
		const path = normalizeWorkerWriteJournalPath(input?.path);
		if (path === undefined) return failed("invalid_path", tool);
		const operationId = deriveWorkerWriteJournalOperationId({
			delegation_id: active.delegationId,
			contract_hash: active.contractHash,
			tool_call_id: toolCallId,
			tool,
			path,
		});
		if (operationId === undefined) return failed("invalid_call_id", tool);

		beginning = true;
		try {
		let current: WriteJournalResult<WorkerWriteJournalRecord>;
		try {
			current = await readJournal({
				project_root: active.projectRoot,
				delegation_id: active.delegationId,
				contract_hash: active.contractHash,
			});
		} catch {
			return failed("journal_read_failed", tool);
		}
		if (!current.ok || !validJournalRevision(current.value.revision)) return failed("journal_read_failed", tool);
		revision = current.value.revision;
		if (current.value.state !== "OPEN") return failed("journal_not_open", tool);

		let begun: WriteJournalResult<WorkerWriteJournalRecord>;
		try {
			begun = await beginJournal({
				project_root: active.projectRoot,
				delegation_id: active.delegationId,
				contract_hash: active.contractHash,
				expected_revision: revision,
				operation_id: operationId,
				kind: tool,
				path,
			});
		} catch {
			return failed("journal_begin_failed", tool);
		}
		if (!begun.ok) return failed("journal_begin_failed", tool);
		if (begun.value.state !== "OPEN" || !validJournalRevision(begun.value.revision)
			|| begun.value.revision !== revision + 1) return failed("journal_begin_failed", tool);
		const latest = begun.value.operations[begun.value.operations.length - 1];
		if (latest?.status !== "pending" || latest.operation_id !== operationId || latest.kind !== tool || latest.path !== path) {
			return failed("journal_begin_failed", tool);
		}
		revision = begun.value.revision;
		pending = { toolCallId, tool, path, operationId, revision };
		if (!emitTelemetry({
			schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA,
			phase: "begin",
			tool,
			outcome: "none",
			code: "none",
			revision,
			poisoned: 0,
		})) {
			poisoned = true;
			return { ok: false, code: "telemetry_failed", reason: WORKER_WRITE_JOURNAL_RUNTIME_BLOCK_REASON };
		}
		return { ok: true, action: "begun", revision, operation_id: operationId };
		} finally {
			beginning = false;
		}
	}

	async function completeToolResult(
		input: Readonly<WorkerWriteJournalCompleteInput>,
	): Promise<WorkerWriteJournalRuntimeResult> {
		const tool = input?.toolName;
		if (!isTool(tool)) return { ok: true, action: "not_applicable" };
		if (parsed.applicability === "not_applicable") return { ok: true, action: "not_applicable" };
		if (parsed.applicability !== "active" || active === undefined) return failed("invalid_context", tool);
		if (poisoned) return failed("poisoned", tool);
		const toolCallId = normalizeToolCallId(input?.toolCallId);
		if (toolCallId === undefined) return failed("invalid_call_id", tool);
		const blockedTool = blockedParallelCalls.get(toolCallId);
		if (blockedTool !== undefined) {
			blockedParallelCalls.delete(toolCallId);
			return blockedTool === tool
				? { ok: true, action: "not_applicable" }
				: failed("result_mismatch", tool);
		}
		if (pending === undefined) return failed("unbegun_result", tool);
		if (pending.toolCallId !== toolCallId || pending.tool !== tool) return failed("result_mismatch", tool);
		if (typeof input.isError !== "boolean") return failed("result_mismatch", tool);
		const outcome = input.isError ? "failed" : "succeeded";
		let completed: WriteJournalResult<WorkerWriteJournalRecord>;
		try {
			completed = await completeJournal({
				project_root: active.projectRoot,
				delegation_id: active.delegationId,
				contract_hash: active.contractHash,
				expected_revision: pending.revision,
				operation_id: pending.operationId,
				kind: pending.tool,
				path: pending.path,
				outcome,
			});
		} catch {
			return failed("journal_complete_failed", tool, outcome);
		}
		if (!completed.ok) return failed("journal_complete_failed", tool, outcome);
		if (completed.value.state !== "OPEN" || !validJournalRevision(completed.value.revision)
			|| completed.value.revision !== pending.revision + 1) return failed("journal_complete_failed", tool, outcome);
		const latest = completed.value.operations[completed.value.operations.length - 1];
		if (latest?.status !== "completed" || latest.operation_id !== pending.operationId || latest.kind !== pending.tool
			|| latest.path !== pending.path || latest.outcome !== outcome) {
			return failed("journal_complete_failed", tool, outcome);
		}
		const operationId = pending.operationId;
		revision = completed.value.revision;
		pending = undefined;
		if (!emitTelemetry({
			schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA,
			phase: "complete",
			tool,
			outcome,
			code: "none",
			revision,
			poisoned: 0,
		})) {
			poisoned = true;
			return { ok: false, code: "telemetry_failed", reason: WORKER_WRITE_JOURNAL_RUNTIME_BLOCK_REASON };
		}
		return { ok: true, action: "completed", revision, operation_id: operationId };
	}

	return Object.freeze({
		beginToolCall,
		completeToolResult,
		inspectState: (): Readonly<WorkerWriteJournalRuntimeState> => Object.freeze({
			applicability: parsed.applicability,
			poisoned: poisoned ? 1 : 0,
			pending: pending === undefined ? 0 : 1,
			revision,
		}),
	});
}
