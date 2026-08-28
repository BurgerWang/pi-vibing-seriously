/**
 * Strict bridge from an atomically committed recipe run to delegation
 * subprocess provenance.
 *
 * The child sends only a bounded machine-created run identity.  The parent
 * then re-opens the committed run transaction, re-validates the manifest and
 * command-effect bytes, and binds them to the active delegation/contract.
 * Assistant prose, recipe declarations and delegation allowed_paths are
 * never accepted as provenance.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { types as utilTypes } from "node:util";

import {
	CHANGE_SET_MAX_PATHS,
	validateChangeSet,
	type ChangeKind,
	type ChangeSetRecord,
	type WorkspaceDriftEntry,
} from "./change-set.ts";
import {
	COMMAND_EFFECT_FILE,
	COMMAND_EFFECT_MAX_BYTES,
	commandEffectBlockingReason,
	validateCommandEffectRecord,
	type CommandEffectRecord,
	type CommandEffectObservedChange,
	type CommandEffectStatus,
} from "./command-effect.ts";
import {
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
} from "./delegation-transaction.ts";
import { runsDir } from "./config.ts";
import {
	readCommittedRunTransaction,
	RUN_MANIFEST_MAX_BYTES,
	type RunCommittedFileV2,
} from "./run-transaction.ts";
import { isValidRunId, parseCommittedRunManifestV2 } from "./runs.ts";
import {
	captureStreamingIdentities,
	isStrictStreamingIdentityPath,
	STREAMING_IDENTITY_MAX_FILE_BYTES,
	STREAMING_IDENTITY_MAX_TOTAL_BYTES,
	streamingIdentityEqual,
	type StreamingIdentityMeter,
	type StreamingPathIdentity,
} from "./streaming-identity.ts";
import {
	computeWorkspaceGuardHash,
	isStrictWorkspaceGuardPath,
	validateWorkspaceGuard,
	type WorkspaceGuardEntry,
	type WorkspaceGuardRecord,
} from "./workspace-guard.ts";

export const WORKER_COMMAND_EFFECT_ENTRY_TYPE = "workbench-worker-command-effect-v1" as const;
export const WORKER_COMMAND_EFFECT_ENTRY_SCHEMA = "workbench-worker-command-effect-v1" as const;
export const WORKER_COMMAND_EFFECT_MAX_RUNS = 64 as const;
export const WORKER_COMMAND_EFFECT_MAX_RUN_DIRECTORIES = 10_000 as const;
export const DELEGATION_COMMAND_PROVENANCE_SCHEMA_VERSION = 1 as const;

const HASH_RE = /^[0-9a-f]{64}$/u;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/u;
const ENTRY_FIELDS = [
	"schema", "kind", "delegation_id", "contract_hash", "run_id", "recipe", "started_at", "finished_at", "run_outcome",
	"manifest_sha256", "command_effect_file_sha256", "command_effect_hash", "command_effect_status", "failure_code",
] as const;
const OBSERVATION_FIELDS = ["state", "code", "entries"] as const;
const RECEIPT_FIELDS = [
	"run_id", "recipe", "started_at", "finished_at", "run_outcome", "manifest_sha256", "command_effect_file_sha256",
	"command_effect_hash", "command_effect_status",
] as const;
const COMMAND_DELTA_FIELDS = ["path", "change", "before", "after", "run_ids"] as const;
const PROVENANCE_FIELDS = [
	"schema_version", "delegation_id", "contract_hash", "base_change_set_hash", "worker_delta_hash",
	"runtime_observation", "receipts", "command_delta", "remaining_workspace_drift", "terminal_reasons",
	"effective_status", "effective_paths", "finalization_meter", "effective_delta_hash", "command_provenance_hash",
] as const;
const METER_FIELDS = ["paths_attempted", "paths_completed", "bytes_read"] as const;
const TERMINAL_REASON_ORDER: readonly DelegationCommandProvenanceTerminalReason[] = [
	"RECIPE_DECLARATION_VIOLATION",
	"COMMAND_EFFECT_UNKNOWN_ORIGIN",
	"COMMAND_EFFECT_OUT_OF_SCOPE",
	"COMMAND_EFFECT_EVIDENCE_UNAVAILABLE",
	"COMMAND_EFFECT_RUN_FAILED",
	"COMMAND_EFFECT_BINDING_CONFLICT",
	"COMMAND_EFFECT_PROTOCOL_INVALID",
];

export type WorkerCommandEffectEntryFailureCode =
	| "invalid_tool_result"
	| "run_not_committed"
	| "manifest_unavailable"
	| "manifest_invalid"
	| "command_effect_unavailable"
	| "command_effect_invalid"
	| "identity_mismatch"
	| "delegation_mismatch"
	| "contract_mismatch";

export type WorkerCommandEffectObservationCode = "none" | "invalid" | "overflow" | "identity_mismatch";

export interface WorkerCommandEffectCommittedEntry {
	schema: typeof WORKER_COMMAND_EFFECT_ENTRY_SCHEMA;
	kind: "committed";
	delegation_id: string;
	contract_hash: string;
	run_id: string;
	recipe: string;
	started_at: string;
	finished_at: string;
	run_outcome: "SUCCESS" | "PROCESS_FAILED" | "ARTIFACT_FAILED" | "COMMAND_EFFECT_FAILED";
	manifest_sha256: string;
	command_effect_file_sha256: string;
	command_effect_hash: string;
	command_effect_status: CommandEffectStatus;
	failure_code: null;
}

export interface WorkerCommandEffectUnavailableEntry {
	schema: typeof WORKER_COMMAND_EFFECT_ENTRY_SCHEMA;
	kind: "unavailable";
	delegation_id: string;
	contract_hash: string;
	run_id: string | null;
	recipe: null;
	started_at: null;
	finished_at: null;
	run_outcome: null;
	manifest_sha256: null;
	command_effect_file_sha256: null;
	command_effect_hash: null;
	command_effect_status: null;
	failure_code: WorkerCommandEffectEntryFailureCode;
}

export type WorkerCommandEffectEntry = WorkerCommandEffectCommittedEntry | WorkerCommandEffectUnavailableEntry;

export interface WorkerCommandEffectRuntimeObservation {
	state: "empty" | "observed" | "failed";
	code: WorkerCommandEffectObservationCode;
	entries: readonly WorkerCommandEffectEntry[];
}

export const EMPTY_WORKER_COMMAND_EFFECT_RUNTIME_OBSERVATION: Readonly<WorkerCommandEffectRuntimeObservation> =
	deepFreeze({ state: "empty", code: "none", entries: [] });

export interface BoundCommandEffectReceipt {
	run_id: string;
	recipe: string;
	started_at: string;
	finished_at: string;
	run_outcome: "SUCCESS" | "PROCESS_FAILED" | "ARTIFACT_FAILED" | "COMMAND_EFFECT_FAILED";
	manifest_sha256: string;
	command_effect_file_sha256: string;
	command_effect_hash: string;
	command_effect_status: CommandEffectStatus;
}

export interface DelegationCommandDeltaEntry {
	path: string;
	change: ChangeKind;
	before: StreamingPathIdentity;
	after: StreamingPathIdentity;
	run_ids: readonly string[];
}

export type DelegationCommandProvenanceTerminalReason =
	| "RECIPE_DECLARATION_VIOLATION"
	| "COMMAND_EFFECT_UNKNOWN_ORIGIN"
	| "COMMAND_EFFECT_OUT_OF_SCOPE"
	| "COMMAND_EFFECT_EVIDENCE_UNAVAILABLE"
	| "COMMAND_EFFECT_RUN_FAILED"
	| "COMMAND_EFFECT_BINDING_CONFLICT"
	| "COMMAND_EFFECT_PROTOCOL_INVALID";

export interface DelegationCommandProvenanceRecord {
	schema_version: typeof DELEGATION_COMMAND_PROVENANCE_SCHEMA_VERSION;
	delegation_id: string;
	contract_hash: string;
	base_change_set_hash: string;
	worker_delta_hash: string;
	runtime_observation: Readonly<WorkerCommandEffectRuntimeObservation>;
	receipts: readonly BoundCommandEffectReceipt[];
	command_delta: readonly DelegationCommandDeltaEntry[];
	remaining_workspace_drift: readonly WorkspaceDriftEntry[];
	terminal_reasons: readonly DelegationCommandProvenanceTerminalReason[];
	effective_status: "ATTRIBUTED" | "WORKSPACE_DRIFT" | "CONFLICT";
	effective_paths: readonly string[];
	finalization_meter: Readonly<StreamingIdentityMeter>;
	effective_delta_hash: string;
	command_provenance_hash: string;
}

export interface BuildWorkerCommandEffectEntryInput {
	project_root: string;
	delegation_id: string;
	contract_hash: string;
	tool_name: unknown;
	details: unknown;
}

export interface FinalizeDelegationCommandProvenanceInput {
	project_root: string;
	delegation_id: string;
	contract_hash: string;
	before_guard: Readonly<WorkspaceGuardRecord>;
	after_guard: Readonly<WorkspaceGuardRecord>;
	change_set: Readonly<ChangeSetRecord>;
	observation: Readonly<WorkerCommandEffectRuntimeObservation>;
}

export type ReadBoundCommandEffectReceiptResult =
	| { ok: true; receipt: Readonly<BoundCommandEffectReceipt>; effect: Readonly<CommandEffectRecord> }
	| { ok: false; code: WorkerCommandEffectEntryFailureCode };

export type FinalizeDelegationCommandProvenanceResult =
	| { ok: true; value: Readonly<DelegationCommandProvenanceRecord> }
	| { ok: false; code: "invalid_input" | "identity_unavailable" };

function deepFreeze<T>(value: T): Readonly<T> {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function canonicalStrings(values: readonly string[]): string[] {
	return [...new Set(values)].sort(byteCompare);
}

function hashBytes(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalHash(value: unknown): string {
	return hashBytes(JSON.stringify(value));
}

function exactDataRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return undefined;
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
			if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
			record[field] = descriptor.value;
		}
		return record;
	} catch {
		return undefined;
	}
}

function ownDataValue(value: unknown, field: string): unknown {
	try {
		if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function validRecipe(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 256;
}

function validTime(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validOutcome(value: unknown): value is BoundCommandEffectReceipt["run_outcome"] {
	return value === "SUCCESS" || value === "PROCESS_FAILED" || value === "ARTIFACT_FAILED" || value === "COMMAND_EFFECT_FAILED";
}

function validStatus(value: unknown): value is CommandEffectStatus {
	return value === "CLEAN" || value === "COMMAND_ATTRIBUTED" || value === "RECIPE_DECLARATION_VIOLATION"
		|| value === "UNKNOWN_ORIGIN" || value === "OUT_OF_SCOPE" || value === "EVIDENCE_UNAVAILABLE";
}

function validFailureCode(value: unknown): value is WorkerCommandEffectEntryFailureCode {
	return value === "invalid_tool_result" || value === "run_not_committed" || value === "manifest_unavailable"
		|| value === "manifest_invalid" || value === "command_effect_unavailable" || value === "command_effect_invalid"
		|| value === "identity_mismatch" || value === "delegation_mismatch" || value === "contract_mismatch";
}

function validTerminalReason(value: unknown): value is DelegationCommandProvenanceTerminalReason {
	return value === "RECIPE_DECLARATION_VIOLATION" || value === "COMMAND_EFFECT_UNKNOWN_ORIGIN"
		|| value === "COMMAND_EFFECT_OUT_OF_SCOPE" || value === "COMMAND_EFFECT_EVIDENCE_UNAVAILABLE"
		|| value === "COMMAND_EFFECT_RUN_FAILED" || value === "COMMAND_EFFECT_BINDING_CONFLICT"
		|| value === "COMMAND_EFFECT_PROTOCOL_INVALID";
}

function parseEntry(value: unknown): WorkerCommandEffectEntry | undefined {
	const record = exactDataRecord(value, ENTRY_FIELDS);
	if (record === undefined || record.schema !== WORKER_COMMAND_EFFECT_ENTRY_SCHEMA
		|| typeof record.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(record.delegation_id)
		|| typeof record.contract_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(record.contract_hash)) return undefined;
	if (record.kind === "committed") {
		if (typeof record.run_id !== "string" || !isValidRunId(record.run_id) || !validRecipe(record.recipe)
			|| !validTime(record.started_at) || !validTime(record.finished_at)
			|| !validOutcome(record.run_outcome) || typeof record.manifest_sha256 !== "string" || !HASH_RE.test(record.manifest_sha256)
			|| typeof record.command_effect_file_sha256 !== "string" || !HASH_RE.test(record.command_effect_file_sha256)
			|| typeof record.command_effect_hash !== "string" || !HASH_RE.test(record.command_effect_hash)
			|| !validStatus(record.command_effect_status) || record.failure_code !== null) return undefined;
		return record as unknown as WorkerCommandEffectCommittedEntry;
	}
	if (record.kind !== "unavailable" || !(record.run_id === null || (typeof record.run_id === "string" && isValidRunId(record.run_id)))
		|| record.recipe !== null || record.started_at !== null || record.finished_at !== null
		|| record.run_outcome !== null || record.manifest_sha256 !== null
		|| record.command_effect_file_sha256 !== null || record.command_effect_hash !== null
		|| record.command_effect_status !== null || !validFailureCode(record.failure_code)) return undefined;
	return record as unknown as WorkerCommandEffectUnavailableEntry;
}

export function validateWorkerCommandEffectRuntimeObservation(
	value: unknown,
): value is WorkerCommandEffectRuntimeObservation {
	const record = exactDataRecord(value, OBSERVATION_FIELDS);
	if (record === undefined || (record.state !== "empty" && record.state !== "observed" && record.state !== "failed")
		|| (record.code !== "none" && record.code !== "invalid" && record.code !== "overflow" && record.code !== "identity_mismatch")
		|| !Array.isArray(record.entries) || record.entries.length > WORKER_COMMAND_EFFECT_MAX_RUNS
		|| !record.entries.every((entry) => parseEntry(entry) !== undefined)) return false;
	if (record.state === "empty") return record.code === "none" && record.entries.length === 0;
	if (record.state === "observed") return record.code === "none" && record.entries.length > 0;
	return record.code !== "none";
}

function failedObservation(
	current: Readonly<WorkerCommandEffectRuntimeObservation>,
	code: Exclude<WorkerCommandEffectObservationCode, "none">,
): Readonly<WorkerCommandEffectRuntimeObservation> {
	return deepFreeze({ state: "failed", code, entries: [...current.entries] });
}

function matchingCustomEntry(entry: unknown): { kind: "unrelated" | "invalid" | "entry"; value?: WorkerCommandEffectEntry } {
	if (ownDataValue(entry, "customType") !== WORKER_COMMAND_EFFECT_ENTRY_TYPE) return { kind: "unrelated" };
	if (ownDataValue(entry, "type") !== "custom") return { kind: "invalid" };
	const parsed = parseEntry(ownDataValue(entry, "data"));
	return parsed === undefined ? { kind: "invalid" } : { kind: "entry", value: parsed };
}

/**
 * Consume only the fixed machine-generated custom entry.  Unrelated entries
 * preserve identity; protocol failure is sticky and cannot be repaired by a
 * later child event.
 */
export function observeWorkerCommandEffectRuntimeEntry(
	entry: unknown,
	current: Readonly<WorkerCommandEffectRuntimeObservation>,
	expectedIdentity?: Readonly<{ delegation_id: string; contract_hash: string }>,
): Readonly<WorkerCommandEffectRuntimeObservation> {
	const matched = matchingCustomEntry(entry);
	if (matched.kind === "unrelated") return current;
	if (!validateWorkerCommandEffectRuntimeObservation(current)) return failedObservation(EMPTY_WORKER_COMMAND_EFFECT_RUNTIME_OBSERVATION, "invalid");
	if (current.state === "failed") return current;
	if (matched.kind === "invalid" || matched.value === undefined) return failedObservation(current, "invalid");
	const value = matched.value;
	if (expectedIdentity !== undefined && (value.delegation_id !== expectedIdentity.delegation_id
		|| value.contract_hash !== expectedIdentity.contract_hash)) return failedObservation(current, "identity_mismatch");
	if (current.entries.length >= WORKER_COMMAND_EFFECT_MAX_RUNS) return failedObservation(current, "overflow");
	if (value.run_id !== null) {
		const existing = current.entries.find((candidate) => candidate.run_id === value.run_id);
		if (existing !== undefined) {
			return JSON.stringify(existing) === JSON.stringify(value) ? current : failedObservation(current, "invalid");
		}
	}
	return deepFreeze({ state: "observed", code: "none", entries: [...current.entries, structuredClone(value)] });
}

function inventoryEntry(files: readonly RunCommittedFileV2[], path: string): RunCommittedFileV2 | undefined {
	return files.find((entry) => entry.path === path);
}

async function readInventoryBoundFile(
	runDir: string,
	entry: RunCommittedFileV2 | undefined,
	maximum: number,
): Promise<Buffer | undefined> {
	if (entry === undefined || entry.bytes <= 0 || entry.bytes > maximum) return undefined;
	try {
		const bytes = await readFile(join(runDir, entry.path));
		return bytes.length === entry.bytes && hashBytes(bytes) === entry.sha256 ? bytes : undefined;
	} catch {
		return undefined;
	}
}

type StrictCommandEffectRunResult =
	| { ok: true; receipt: Readonly<BoundCommandEffectReceipt>; effect: Readonly<CommandEffectRecord> }
	| { ok: false; code: WorkerCommandEffectEntryFailureCode | "not_command_effect" };

async function readStrictCommandEffectRun(projectRoot: string, runId: string): Promise<StrictCommandEffectRunResult> {
	if (typeof projectRoot !== "string" || projectRoot.length === 0 || !isValidRunId(runId)) {
		return { ok: false, code: "manifest_invalid" };
	}
	const transaction = await readCommittedRunTransaction(projectRoot, runId);
	if (!transaction.ok) return { ok: false, code: transaction.code === "not_found" || transaction.code === "partial" ? "run_not_committed" : "identity_mismatch" };
	const manifestEntry = inventoryEntry(transaction.record.files, "manifest.json");
	const manifestBytes = await readInventoryBoundFile(transaction.runDir, manifestEntry, RUN_MANIFEST_MAX_BYTES);
	if (manifestBytes === undefined || manifestEntry === undefined) return { ok: false, code: "manifest_unavailable" };
	let manifest;
	try {
		manifest = parseCommittedRunManifestV2(JSON.parse(manifestBytes.toString("utf8")), runId);
	} catch {
		manifest = null;
	}
	if (manifest === null) return { ok: false, code: "manifest_invalid" };
	if (manifest.command_effect_path === undefined) return { ok: false, code: "not_command_effect" };
	if (manifest.command_effect_path !== COMMAND_EFFECT_FILE
		|| typeof manifest.command_effect_hash !== "string" || !validStatus(manifest.command_effect_status)
		|| !validOutcome(manifest.run_outcome)) return { ok: false, code: "manifest_invalid" };
	const effectEntry = inventoryEntry(transaction.record.files, COMMAND_EFFECT_FILE);
	const effectBytes = await readInventoryBoundFile(transaction.runDir, effectEntry, COMMAND_EFFECT_MAX_BYTES);
	if (effectBytes === undefined || effectEntry === undefined) return { ok: false, code: "command_effect_unavailable" };
	let effect: unknown;
	try { effect = JSON.parse(effectBytes.toString("utf8")); } catch { return { ok: false, code: "command_effect_invalid" }; }
	if (!validateCommandEffectRecord(effect) || effect.run_id !== runId || effect.recipe !== manifest.recipe
		|| effect.command_effect_hash !== manifest.command_effect_hash || effect.status !== manifest.command_effect_status) {
		return { ok: false, code: "command_effect_invalid" };
	}
	const receipt: BoundCommandEffectReceipt = {
		run_id: runId,
		recipe: manifest.recipe,
		started_at: manifest.started_at,
		finished_at: manifest.finished_at,
		run_outcome: manifest.run_outcome,
		manifest_sha256: manifestEntry.sha256,
		command_effect_file_sha256: effectEntry.sha256,
		command_effect_hash: effect.command_effect_hash,
		command_effect_status: effect.status,
	};
	return { ok: true, receipt: deepFreeze(receipt), effect: deepFreeze(structuredClone(effect)) };
}

/** Strict-read one atomically committed run and bind it to the active worker. */
export async function readStrictBoundCommandEffectReceipt(input: {
	project_root: string;
	delegation_id: string;
	contract_hash: string;
	run_id: string;
}): Promise<ReadBoundCommandEffectReceiptResult> {
	if (typeof input?.project_root !== "string" || input.project_root.length === 0
		|| !DELEGATION_TRANSACTION_ID_RE.test(input.delegation_id)
		|| !DELEGATION_TRANSACTION_HASH_RE.test(input.contract_hash) || !isValidRunId(input.run_id)) {
		return { ok: false, code: "manifest_invalid" };
	}
	const read = await readStrictCommandEffectRun(input.project_root, input.run_id);
	if (!read.ok) return { ok: false, code: read.code === "not_command_effect" ? "manifest_invalid" : read.code };
	if (read.effect.actor !== "worker" || read.effect.worker_delegation_id !== input.delegation_id) {
		return { ok: false, code: "delegation_mismatch" };
	}
	if (read.effect.worker_contract_hash !== input.contract_hash) return { ok: false, code: "contract_mismatch" };
	return read;
}

function unavailableEntry(
	delegationId: string,
	contractHash: string,
	runId: string | null,
	code: WorkerCommandEffectEntryFailureCode,
): Readonly<WorkerCommandEffectUnavailableEntry> {
	return deepFreeze({
		schema: WORKER_COMMAND_EFFECT_ENTRY_SCHEMA,
		kind: "unavailable",
		delegation_id: delegationId,
		contract_hash: contractHash,
		run_id: runId,
		recipe: null,
		started_at: null,
		finished_at: null,
		run_outcome: null,
		manifest_sha256: null,
		command_effect_file_sha256: null,
		command_effect_hash: null,
		command_effect_status: null,
		failure_code: code,
	});
}

/**
 * Convert a recipe tool result into a bounded custom entry.  run_id is used
 * only as an untrusted locator; every authoritative field comes from a
 * strict read of the committed run transaction.
 */
export async function buildWorkerCommandEffectEntryFromToolResult(
	input: BuildWorkerCommandEffectEntryInput,
): Promise<Readonly<WorkerCommandEffectEntry> | undefined> {
	if (input.tool_name !== "workbench_run_recipe") return undefined;
	if (!DELEGATION_TRANSACTION_ID_RE.test(input.delegation_id) || !DELEGATION_TRANSACTION_HASH_RE.test(input.contract_hash)) {
		return undefined;
	}
	const phase = ownDataValue(input.details, "phase");
	const locator = ownDataValue(input.details, "run_id");
	// Fixed failures before a run begins legitimately have neither field.
	if (phase === undefined && locator === undefined) return undefined;
	if (phase !== "finished" || typeof locator !== "string" || !isValidRunId(locator)) {
		return unavailableEntry(input.delegation_id, input.contract_hash, null, "invalid_tool_result");
	}
	const read = await readStrictBoundCommandEffectReceipt({
		project_root: input.project_root,
		delegation_id: input.delegation_id,
		contract_hash: input.contract_hash,
		run_id: locator,
	});
	if (!read.ok) return unavailableEntry(input.delegation_id, input.contract_hash, locator, read.code);
	return deepFreeze({
		schema: WORKER_COMMAND_EFFECT_ENTRY_SCHEMA,
		kind: "committed",
		delegation_id: input.delegation_id,
		contract_hash: input.contract_hash,
		...read.receipt,
		failure_code: null,
	});
}

function cloneIdentity(value: StreamingPathIdentity): StreamingPathIdentity {
	return structuredClone(value);
}

function cloneDrift(value: WorkspaceDriftEntry): WorkspaceDriftEntry {
	return structuredClone(value);
}

function guardEntryEqual(left: WorkspaceGuardEntry | null, right: WorkspaceGuardEntry | null): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function changeKind(before: StreamingPathIdentity, after: StreamingPathIdentity): ChangeKind {
	if (before.kind === "missing") return "new";
	if (after.kind === "missing") return "delete";
	return "modify";
}

function entryProjection(entry: WorkerCommandEffectEntry): unknown {
	return { ...entry };
}

function receiptProjection(receipt: BoundCommandEffectReceipt): unknown {
	return { ...receipt };
}

function deltaProjection(delta: DelegationCommandDeltaEntry): unknown {
	return {
		path: delta.path,
		change: delta.change,
		before: delta.before,
		after: delta.after,
		run_ids: [...delta.run_ids],
	};
}

function provenanceProjection(record: Omit<DelegationCommandProvenanceRecord, "command_provenance_hash">): unknown {
	return {
		schema_version: record.schema_version,
		delegation_id: record.delegation_id,
		contract_hash: record.contract_hash,
		base_change_set_hash: record.base_change_set_hash,
		worker_delta_hash: record.worker_delta_hash,
		runtime_observation: {
			state: record.runtime_observation.state,
			code: record.runtime_observation.code,
			entries: record.runtime_observation.entries.map(entryProjection),
		},
		receipts: record.receipts.map(receiptProjection),
		command_delta: record.command_delta.map(deltaProjection),
		remaining_workspace_drift: record.remaining_workspace_drift.map(cloneDrift),
		terminal_reasons: [...record.terminal_reasons],
		effective_status: record.effective_status,
		effective_paths: [...record.effective_paths],
		finalization_meter: { ...record.finalization_meter },
		effective_delta_hash: record.effective_delta_hash,
	};
}

function effectiveDeltaHash(
	delegationId: string,
	contractHash: string,
	workerDeltaHash: string,
	commandDelta: readonly DelegationCommandDeltaEntry[],
	receipts: readonly BoundCommandEffectReceipt[],
): string {
	// The effective content delta is exactly the existing W delta when no
	// command-owned path exists. Receipts remain independently bound by the
	// command_provenance_hash, so CLEAN/failed commands cannot silently change
	// the historical delta identity expected by v2 readers.
	if (commandDelta.length === 0) return workerDeltaHash;
	return canonicalHash({
		schema_version: DELEGATION_COMMAND_PROVENANCE_SCHEMA_VERSION,
		kind: "delegation-effective-delta-v1",
		delegation_id: delegationId,
		contract_hash: contractHash,
		worker_delta_hash: workerDeltaHash,
		command_delta: commandDelta.map(deltaProjection),
		receipts: receipts.map(receiptProjection),
	});
}

interface CommandPathChain {
	path: string;
	before: StreamingPathIdentity;
	after: StreamingPathIdentity;
	before_guard: WorkspaceGuardEntry | null;
	after_guard: WorkspaceGuardEntry | null;
	run_ids: string[];
	last_finished_at: string;
}

interface DiscoveredBoundCommandEffects {
	receipts: BoundCommandEffectReceipt[];
	effects: CommandEffectRecord[];
	overflow: boolean;
	unavailable: boolean;
}

function receiptOrder(left: BoundCommandEffectReceipt, right: BoundCommandEffectReceipt): number {
	const started = Date.parse(left.started_at) - Date.parse(right.started_at);
	if (started !== 0) return started;
	const finished = Date.parse(left.finished_at) - Date.parse(right.finished_at);
	return finished !== 0 ? finished : byteCompare(left.run_id, right.run_id);
}

/**
 * A worker may repair a failed check and rerun the same exact recipe.  The
 * recipe's terminal result is authoritative only when every earlier failed
 * invocation is followed, without overlap, by its final successful run.
 * Failures from another recipe, or a final failed invocation, remain sticky.
 */
function hasUnresolvedCommandRunFailure(
	receipts: readonly BoundCommandEffectReceipt[],
): boolean {
	const byRecipe = new Map<string, BoundCommandEffectReceipt[]>();
	for (const receipt of receipts) {
		const entries = byRecipe.get(receipt.recipe) ?? [];
		entries.push(receipt);
		byRecipe.set(receipt.recipe, entries);
	}
	for (const entries of byRecipe.values()) {
		const failures = entries.filter((receipt) => receipt.run_outcome !== "SUCCESS");
		if (failures.length === 0) continue;
		const terminal = entries.at(-1)!;
		if (terminal.run_outcome !== "SUCCESS" || failures.some((failure) =>
			Date.parse(terminal.started_at) < Date.parse(failure.finished_at))) return true;
	}
	return false;
}

/**
 * Discover authority from the project store itself. Session custom entries
 * are intentionally absent from this algorithm: a reload, mirror failure or
 * lost JSON event cannot hide an already committed worker receipt.
 */
async function discoverBoundCommandEffects(
	projectRoot: string,
	delegationId: string,
	contractHash: string,
): Promise<DiscoveredBoundCommandEffects> {
	let entries;
	try {
		entries = await readdir(runsDir(projectRoot), { withFileTypes: true });
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { receipts: [], effects: [], overflow: false, unavailable: false }
			: { receipts: [], effects: [], overflow: false, unavailable: true };
	}
	if (entries.length > WORKER_COMMAND_EFFECT_MAX_RUN_DIRECTORIES) {
		return { receipts: [], effects: [], overflow: true, unavailable: false };
	}
	const runIds = entries.filter((entry) => entry.isDirectory() && isValidRunId(entry.name))
		.map((entry) => entry.name).sort(byteCompare);
	const found: Array<{ receipt: BoundCommandEffectReceipt; effect: CommandEffectRecord }> = [];
	for (const runId of runIds) {
		const read = await readStrictCommandEffectRun(projectRoot, runId);
		if (!read.ok || read.effect.actor !== "worker"
			|| read.effect.worker_delegation_id !== delegationId || read.effect.worker_contract_hash !== contractHash) continue;
		found.push({ receipt: structuredClone(read.receipt), effect: structuredClone(read.effect) });
		if (found.length > WORKER_COMMAND_EFFECT_MAX_RUNS) {
			return { receipts: [], effects: [], overflow: true, unavailable: false };
		}
	}
	found.sort((left, right) => receiptOrder(left.receipt, right.receipt));
	return {
		receipts: found.map((entry) => entry.receipt),
		effects: found.map((entry) => entry.effect),
		overflow: false,
		unavailable: false,
	};
}

/**
 * Parent-side strict consumer. Every committed observation is re-read. Only
 * exact COMMAND_ATTRIBUTED paths with a continuous identity/guard chain and
 * a current final identity become command_delta. Everything else remains
 * drift or contributes a closed terminal reason.
 */
export async function finalizeDelegationCommandProvenance(
	input: FinalizeDelegationCommandProvenanceInput,
): Promise<FinalizeDelegationCommandProvenanceResult> {
	if (typeof input?.project_root !== "string" || input.project_root.length === 0
		|| !DELEGATION_TRANSACTION_ID_RE.test(input.delegation_id)
		|| !DELEGATION_TRANSACTION_HASH_RE.test(input.contract_hash)
		|| !validateWorkspaceGuard(input.before_guard) || !validateWorkspaceGuard(input.after_guard)
		|| input.before_guard.git_head !== input.after_guard.git_head
		|| !validateChangeSet(input.change_set)
		|| input.change_set.delegation_id !== input.delegation_id || input.change_set.contract_hash !== input.contract_hash
		|| !validateWorkerCommandEffectRuntimeObservation(input.observation)) return { ok: false, code: "invalid_input" };

	const reasons = new Set<DelegationCommandProvenanceTerminalReason>();
	const discovered = await discoverBoundCommandEffects(input.project_root, input.delegation_id, input.contract_hash);
	if (discovered.overflow || discovered.unavailable) reasons.add("COMMAND_EFFECT_EVIDENCE_UNAVAILABLE");
	const receipts = discovered.receipts;
	const effects = discovered.effects;
	// Observation can never create authority, and a missing observation is a
	// normal recoverable condition. If present, however, a contradiction with
	// the durable project receipts is retained as negative protocol evidence.
	if (input.observation.state === "failed") reasons.add("COMMAND_EFFECT_PROTOCOL_INVALID");
	const durableByRun = new Map(receipts.map((receipt) => [receipt.run_id, receipt] as const));
	for (const observed of input.observation.entries) {
		if (observed.delegation_id !== input.delegation_id || observed.contract_hash !== input.contract_hash) {
			reasons.add("COMMAND_EFFECT_PROTOCOL_INVALID");
			continue;
		}
		if (observed.kind === "unavailable") {
			if (observed.run_id === null) reasons.add("COMMAND_EFFECT_PROTOCOL_INVALID");
			else if (!durableByRun.has(observed.run_id)) reasons.add("COMMAND_EFFECT_EVIDENCE_UNAVAILABLE");
			else reasons.add("COMMAND_EFFECT_PROTOCOL_INVALID");
			continue;
		}
		const durable = durableByRun.get(observed.run_id);
		const observedReceipt: BoundCommandEffectReceipt = {
			run_id: observed.run_id,
			recipe: observed.recipe,
			started_at: observed.started_at,
			finished_at: observed.finished_at,
			run_outcome: observed.run_outcome,
			manifest_sha256: observed.manifest_sha256,
			command_effect_file_sha256: observed.command_effect_file_sha256,
			command_effect_hash: observed.command_effect_hash,
			command_effect_status: observed.command_effect_status,
		};
		if (durable === undefined) reasons.add("COMMAND_EFFECT_EVIDENCE_UNAVAILABLE");
		else if (JSON.stringify(durable) !== JSON.stringify(observedReceipt)) reasons.add("COMMAND_EFFECT_BINDING_CONFLICT");
	}
	if (hasUnresolvedCommandRunFailure(receipts)) reasons.add("COMMAND_EFFECT_RUN_FAILED");
	for (let index = 0; index < effects.length; index += 1) {
		const effect = effects[index]!;
		const blocking = commandEffectBlockingReason(effect);
		if (blocking !== undefined) reasons.add(blocking);
	}

	const workerPaths = new Set(input.change_set.worker_delta.map((entry) => entry.path));
	const chains = new Map<string, CommandPathChain>();
	const invalidCommandPaths = new Set<string>();
	for (let effectIndex = 0; effectIndex < effects.length; effectIndex += 1) {
		const effect = effects[effectIndex]!;
		const receipt = receipts[effectIndex]!;
		if (effect.before_guard === null || effect.after_guard === null
			|| effect.before_guard.git_head !== input.before_guard.git_head
			|| effect.after_guard.git_head !== input.after_guard.git_head) {
			reasons.add("COMMAND_EFFECT_BINDING_CONFLICT");
			continue;
		}
		for (const change of effect.observed_changes) {
			if (change.classification !== "COMMAND_ATTRIBUTED") continue;
			if (invalidCommandPaths.has(change.path)) continue;
			if (change.before_exact_output === null || change.after_exact_output === null || workerPaths.has(change.path)) {
				reasons.add("COMMAND_EFFECT_BINDING_CONFLICT");
				invalidCommandPaths.add(change.path);
				chains.delete(change.path);
				continue;
			}
			const prior = chains.get(change.path);
			if (prior === undefined) {
				chains.set(change.path, {
					path: change.path,
					before: cloneIdentity(change.before_exact_output),
					after: cloneIdentity(change.after_exact_output),
					before_guard: change.before === null ? null : structuredClone(change.before),
					after_guard: change.after === null ? null : structuredClone(change.after),
					run_ids: [effect.run_id],
					last_finished_at: receipt.finished_at,
				});
				continue;
			}
			if (Date.parse(receipt.started_at) < Date.parse(prior.last_finished_at)
				|| !streamingIdentityEqual(prior.after, change.before_exact_output)
				|| !guardEntryEqual(prior.after_guard, change.before)) {
				reasons.add("COMMAND_EFFECT_BINDING_CONFLICT");
				chains.delete(change.path);
				invalidCommandPaths.add(change.path);
				continue;
			}
			prior.after = cloneIdentity(change.after_exact_output);
			prior.after_guard = change.after === null ? null : structuredClone(change.after);
			prior.run_ids.push(effect.run_id);
			prior.last_finished_at = receipt.finished_at;
		}
	}

	const paths = [...chains.keys()].sort(byteCompare);
	const meter: StreamingIdentityMeter = { paths_attempted: 0, paths_completed: 0, bytes_read: 0 };
	const captured = paths.length <= CHANGE_SET_MAX_PATHS
		? await captureStreamingIdentities({ project_root: input.project_root, paths, meter })
		: undefined;
	if (captured === undefined || !captured.ok) reasons.add("COMMAND_EFFECT_EVIDENCE_UNAVAILABLE");
	const currentByPath = new Map((captured?.ok ? captured.identities : []).map((identity) => [identity.path, identity] as const));
	const driftByPath = new Map(input.change_set.workspace_drift.map((entry) => [entry.path, entry] as const));
	const commandDelta: DelegationCommandDeltaEntry[] = [];
	const attributed = new Set<string>();
	for (const path of paths) {
		const chain = chains.get(path)!;
		const current = currentByPath.get(path);
		if (captured === undefined || !captured.ok) continue;
		if (current === undefined || !streamingIdentityEqual(current, chain.after)) {
			reasons.add("COMMAND_EFFECT_BINDING_CONFLICT");
			continue;
		}
		const drift = driftByPath.get(path);
		if (drift !== undefined && (!guardEntryEqual(drift.before, chain.before_guard) || !guardEntryEqual(drift.after, chain.after_guard))) {
			reasons.add("COMMAND_EFFECT_BINDING_CONFLICT");
			continue;
		}
		if (streamingIdentityEqual(chain.before, chain.after)) continue;
		commandDelta.push({
			path,
			change: changeKind(chain.before, chain.after),
			before: cloneIdentity(chain.before),
			after: cloneIdentity(chain.after),
			run_ids: [...chain.run_ids],
		});
		attributed.add(path);
	}
	const remainingDrift = input.change_set.workspace_drift.filter((entry) => !attributed.has(entry.path)).map(cloneDrift);
	const effectivePaths = canonicalStrings([
		...input.change_set.worker_delta.map((entry) => entry.path),
		...commandDelta.map((entry) => entry.path),
	]);
	const hasSpatialFailure = [...reasons].some((reason) => reason !== "COMMAND_EFFECT_RUN_FAILED");
	const effectiveStatus = input.change_set.conflicts.length > 0 || reasons.has("COMMAND_EFFECT_BINDING_CONFLICT")
		|| reasons.has("COMMAND_EFFECT_PROTOCOL_INVALID")
		? "CONFLICT"
		: remainingDrift.length > 0 || hasSpatialFailure
			? "WORKSPACE_DRIFT"
			: "ATTRIBUTED";
	const deltaHash = effectiveDeltaHash(input.delegation_id, input.contract_hash, input.change_set.worker_delta_hash, commandDelta, receipts);
	const withoutHash: Omit<DelegationCommandProvenanceRecord, "command_provenance_hash"> = {
		schema_version: DELEGATION_COMMAND_PROVENANCE_SCHEMA_VERSION,
		delegation_id: input.delegation_id,
		contract_hash: input.contract_hash,
		base_change_set_hash: input.change_set.change_set_hash,
		worker_delta_hash: input.change_set.worker_delta_hash,
		runtime_observation: structuredClone(input.observation),
		receipts,
		command_delta: commandDelta,
		remaining_workspace_drift: remainingDrift,
		terminal_reasons: TERMINAL_REASON_ORDER.filter((reason) => reasons.has(reason)),
		effective_status: effectiveStatus,
		effective_paths: effectivePaths,
		finalization_meter: { ...(captured?.meter ?? meter) },
		effective_delta_hash: deltaHash,
	};
	return { ok: true, value: deepFreeze({ ...withoutHash, command_provenance_hash: canonicalHash(provenanceProjection(withoutHash)) }) };
}

function validIdentity(value: unknown, expectedPath: string): value is StreamingPathIdentity {
	const common = exactDataRecord(value, ownDataValue(value, "kind") === "missing"
		? ["schema_version", "kind", "path"]
		: ["schema_version", "kind", "path", "byte_size", "sha256", "stat"]);
	if (common === undefined || common.schema_version !== 2 || common.path !== expectedPath) return false;
	if (common.kind === "missing") return true;
	const stat = exactDataRecord(common.stat, ["dev", "ino", "mtime_ns", "ctime_ns"]);
	return common.kind === "file" && typeof common.byte_size === "number" && Number.isSafeInteger(common.byte_size)
		&& common.byte_size >= 0 && common.byte_size <= STREAMING_IDENTITY_MAX_FILE_BYTES
		&& typeof common.sha256 === "string" && HASH_RE.test(common.sha256)
		&& stat !== undefined && [stat.dev, stat.ino, stat.mtime_ns, stat.ctime_ns]
			.every((entry) => typeof entry === "string" && DECIMAL_RE.test(entry));
}

function validReceipt(value: unknown): value is BoundCommandEffectReceipt {
	const record = exactDataRecord(value, RECEIPT_FIELDS);
	return record !== undefined && typeof record.run_id === "string" && isValidRunId(record.run_id)
		&& validRecipe(record.recipe) && validTime(record.started_at) && validTime(record.finished_at)
		&& Date.parse(record.finished_at) >= Date.parse(record.started_at) && validOutcome(record.run_outcome)
		&& typeof record.manifest_sha256 === "string" && HASH_RE.test(record.manifest_sha256)
		&& typeof record.command_effect_file_sha256 === "string" && HASH_RE.test(record.command_effect_file_sha256)
		&& typeof record.command_effect_hash === "string" && HASH_RE.test(record.command_effect_hash)
		&& validStatus(record.command_effect_status);
}

function validCommandDelta(value: unknown): value is DelegationCommandDeltaEntry {
	const record = exactDataRecord(value, COMMAND_DELTA_FIELDS);
	if (record === undefined || typeof record.path !== "string" || !isStrictStreamingIdentityPath(record.path)
		|| (record.change !== "new" && record.change !== "modify" && record.change !== "delete")
		|| !validIdentity(record.before, record.path) || !validIdentity(record.after, record.path)
		|| !Array.isArray(record.run_ids) || record.run_ids.length === 0
		|| record.run_ids.length > WORKER_COMMAND_EFFECT_MAX_RUNS
		|| !record.run_ids.every((runId) => typeof runId === "string" && isValidRunId(runId))) return false;
	const before = record.before as StreamingPathIdentity;
	const after = record.after as StreamingPathIdentity;
	if (streamingIdentityEqual(before, after)) return false;
	return changeKind(before, after) === record.change
		&& new Set(record.run_ids as string[]).size === record.run_ids.length;
}

function validGuardEntry(value: unknown, path: string): value is WorkspaceGuardEntry {
	if (value === null) return false;
	try {
		const cloned = structuredClone(value) as WorkspaceGuardEntry;
		if (cloned.path !== path) return false;
		const guard: WorkspaceGuardRecord = {
			schema_version: 2,
			git_head: null,
			entries: [cloned],
			irrelevant_artifact_paths: [],
			meter: { status_bytes: 0, relevant_paths: 1, irrelevant_paths: 0, stat_calls: 2, content_bytes_read: 0 },
			workspace_guard_hash: computeWorkspaceGuardHash(null, [cloned]),
		};
		return validateWorkspaceGuard(guard);
	} catch {
		return false;
	}
}

function validWorkspaceDrift(value: unknown): value is WorkspaceDriftEntry {
	const record = exactDataRecord(value, ["path", "classification", "before", "after"]);
	return record !== undefined && typeof record.path === "string" && isStrictWorkspaceGuardPath(record.path)
		&& (record.classification === "dependency" || record.classification === "unknown_origin")
		&& (record.before === null || validGuardEntry(record.before, record.path))
		&& (record.after === null || validGuardEntry(record.after, record.path))
		&& !(record.before === null && record.after === null)
		&& !guardEntryEqual(record.before as WorkspaceGuardEntry | null, record.after as WorkspaceGuardEntry | null);
}

function validMeter(value: unknown): value is StreamingIdentityMeter {
	const record = exactDataRecord(value, METER_FIELDS);
	return record !== undefined && typeof record.paths_attempted === "number" && Number.isSafeInteger(record.paths_attempted)
		&& record.paths_attempted >= 0 && record.paths_attempted <= CHANGE_SET_MAX_PATHS
		&& typeof record.paths_completed === "number" && Number.isSafeInteger(record.paths_completed)
		&& record.paths_completed >= 0 && record.paths_completed <= record.paths_attempted
		&& typeof record.bytes_read === "number" && Number.isSafeInteger(record.bytes_read)
		&& record.bytes_read >= 0 && record.bytes_read <= STREAMING_IDENTITY_MAX_TOTAL_BYTES;
}

/** Strict closed-schema persisted-companion validator. */
export function validateDelegationCommandProvenance(
	value: unknown,
	changeSet?: Readonly<ChangeSetRecord>,
): value is DelegationCommandProvenanceRecord {
	if (changeSet !== undefined && !validateChangeSet(changeSet)) return false;
	const record = exactDataRecord(value, PROVENANCE_FIELDS);
	if (record === undefined || record.schema_version !== DELEGATION_COMMAND_PROVENANCE_SCHEMA_VERSION
		|| typeof record.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(record.delegation_id)
		|| typeof record.contract_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(record.contract_hash)
		|| typeof record.base_change_set_hash !== "string" || !HASH_RE.test(record.base_change_set_hash)
		|| typeof record.worker_delta_hash !== "string" || !HASH_RE.test(record.worker_delta_hash)
		|| !validateWorkerCommandEffectRuntimeObservation(record.runtime_observation)
		|| !Array.isArray(record.receipts) || record.receipts.length > WORKER_COMMAND_EFFECT_MAX_RUNS || !record.receipts.every(validReceipt)
		|| !Array.isArray(record.command_delta) || record.command_delta.length > CHANGE_SET_MAX_PATHS || !record.command_delta.every(validCommandDelta)
		|| !Array.isArray(record.remaining_workspace_drift) || record.remaining_workspace_drift.length > CHANGE_SET_MAX_PATHS
		|| !record.remaining_workspace_drift.every(validWorkspaceDrift)
		|| !Array.isArray(record.terminal_reasons) || !record.terminal_reasons.every(validTerminalReason)
		|| (record.effective_status !== "ATTRIBUTED" && record.effective_status !== "WORKSPACE_DRIFT" && record.effective_status !== "CONFLICT")
		|| !Array.isArray(record.effective_paths) || record.effective_paths.length > CHANGE_SET_MAX_PATHS
		|| !record.effective_paths.every((path) => typeof path === "string" && isStrictStreamingIdentityPath(path))
		|| typeof record.effective_delta_hash !== "string" || !HASH_RE.test(record.effective_delta_hash)
		|| typeof record.command_provenance_hash !== "string" || !HASH_RE.test(record.command_provenance_hash)
		|| !validMeter(record.finalization_meter)) return false;
	const command = record.command_delta as unknown as DelegationCommandDeltaEntry[];
	const receipts = record.receipts as unknown as BoundCommandEffectReceipt[];
	if (command.some((entry, index) => index > 0 && byteCompare(command[index - 1]!.path, entry.path) >= 0)
		|| (record.remaining_workspace_drift as WorkspaceDriftEntry[])
			.some((entry, index, all) => index > 0 && byteCompare(all[index - 1]!.path, entry.path) >= 0)
		|| receipts.some((receipt, index) => index > 0 && receiptOrder(receipts[index - 1]!, receipt) >= 0)
		|| new Set(receipts.map((receipt) => receipt.run_id)).size !== receipts.length
		|| (record.terminal_reasons as DelegationCommandProvenanceTerminalReason[])
			.some((reason, index, all) => index > 0 && TERMINAL_REASON_ORDER.indexOf(all[index - 1]!) >= TERMINAL_REASON_ORDER.indexOf(reason))
		|| (record.effective_paths as string[]).some((path, index, all) => index > 0 && byteCompare(all[index - 1]!, path) >= 0)) return false;
	const receiptIndexes = new Map(receipts.map((receipt, index) => [receipt.run_id, index] as const));
	if (command.some((entry) => entry.run_ids.some((runId, index, runIds) => {
		const receiptIndex = receiptIndexes.get(runId);
		const priorIndex = index === 0 ? undefined : receiptIndexes.get(runIds[index - 1]!);
		return receiptIndex === undefined || (priorIndex !== undefined && priorIndex >= receiptIndex)
			|| receipts[receiptIndex]!.command_effect_status === "CLEAN"
			|| receipts[receiptIndex]!.command_effect_status === "RECIPE_DECLARATION_VIOLATION"
			|| receipts[receiptIndex]!.command_effect_status === "EVIDENCE_UNAVAILABLE";
	}))) return false;
	const terminal = new Set(record.terminal_reasons as DelegationCommandProvenanceTerminalReason[]);
	const hasFailedRun = receipts.some((receipt) => receipt.run_outcome !== "SUCCESS");
	const hasUnresolvedRunFailure = hasUnresolvedCommandRunFailure(receipts);
	const historicalStickyRunFailure = terminal.has("COMMAND_EFFECT_RUN_FAILED") && hasFailedRun && !hasUnresolvedRunFailure;
	if (terminal.has("COMMAND_EFFECT_RUN_FAILED") !== hasUnresolvedRunFailure && !historicalStickyRunFailure) return false;
	for (const receipt of receipts) {
		const required = receipt.command_effect_status === "RECIPE_DECLARATION_VIOLATION" ? "RECIPE_DECLARATION_VIOLATION"
			: receipt.command_effect_status === "UNKNOWN_ORIGIN" ? "COMMAND_EFFECT_UNKNOWN_ORIGIN"
				: receipt.command_effect_status === "OUT_OF_SCOPE" ? "COMMAND_EFFECT_OUT_OF_SCOPE"
					: receipt.command_effect_status === "EVIDENCE_UNAVAILABLE" ? "COMMAND_EFFECT_EVIDENCE_UNAVAILABLE"
						: undefined;
		if (required !== undefined && !terminal.has(required)) return false;
	}
	const observation = record.runtime_observation as WorkerCommandEffectRuntimeObservation;
	if (observation.state === "failed" && !terminal.has("COMMAND_EFFECT_PROTOCOL_INVALID")) return false;
	const receiptByRun = new Map(receipts.map((receipt) => [receipt.run_id, receipt] as const));
	for (const observed of observation.entries) {
		if (observed.delegation_id !== record.delegation_id || observed.contract_hash !== record.contract_hash) {
			if (!terminal.has("COMMAND_EFFECT_PROTOCOL_INVALID")) return false;
			continue;
		}
		if (observed.kind === "unavailable") {
			if (observed.run_id === null || receiptByRun.has(observed.run_id)) {
				if (!terminal.has("COMMAND_EFFECT_PROTOCOL_INVALID")) return false;
			} else if (!terminal.has("COMMAND_EFFECT_EVIDENCE_UNAVAILABLE")) return false;
			continue;
		}
		const durable = receiptByRun.get(observed.run_id);
		if (durable === undefined) {
			if (!terminal.has("COMMAND_EFFECT_EVIDENCE_UNAVAILABLE")) return false;
			continue;
		}
		const observedReceipt: BoundCommandEffectReceipt = {
			run_id: observed.run_id,
			recipe: observed.recipe,
			started_at: observed.started_at,
			finished_at: observed.finished_at,
			run_outcome: observed.run_outcome,
			manifest_sha256: observed.manifest_sha256,
			command_effect_file_sha256: observed.command_effect_file_sha256,
			command_effect_hash: observed.command_effect_hash,
			command_effect_status: observed.command_effect_status,
		};
		if (JSON.stringify(durable) !== JSON.stringify(observedReceipt)
			&& !terminal.has("COMMAND_EFFECT_BINDING_CONFLICT")) return false;
	}
	const hasSpatialFailure = [...terminal].some((reason) => reason !== "COMMAND_EFFECT_RUN_FAILED");
	const expectedStatus = terminal.has("COMMAND_EFFECT_BINDING_CONFLICT") || terminal.has("COMMAND_EFFECT_PROTOCOL_INVALID")
		|| changeSet?.status === "CONFLICT"
		? "CONFLICT"
		: (record.remaining_workspace_drift as unknown[]).length > 0 || hasSpatialFailure
			? "WORKSPACE_DRIFT"
			: "ATTRIBUTED";
	// v1 initially collapsed a clean PROCESS_FAILED receipt into
	// WORKSPACE_DRIFT.  Preserve strict read compatibility for those immutable
	// records while every newly finalized record keeps spatial attribution and
	// carries the process failure separately in terminal_reasons.
	const legacyCleanRunFailure = expectedStatus === "ATTRIBUTED" && record.effective_status === "WORKSPACE_DRIFT"
		&& terminal.size === 1 && terminal.has("COMMAND_EFFECT_RUN_FAILED")
		&& (record.remaining_workspace_drift as unknown[]).length === 0;
	if (record.effective_status !== expectedStatus && !legacyCleanRunFailure) return false;
	if (changeSet !== undefined) {
		if (changeSet.delegation_id !== record.delegation_id || changeSet.contract_hash !== record.contract_hash
			|| changeSet.change_set_hash !== record.base_change_set_hash || changeSet.worker_delta_hash !== record.worker_delta_hash) return false;
		const expectedPaths = canonicalStrings([...changeSet.worker_delta.map((entry) => entry.path), ...command.map((entry) => entry.path)]);
		if (JSON.stringify(expectedPaths) !== JSON.stringify(record.effective_paths)) return false;
		const commandPaths = new Set(command.map((entry) => entry.path));
		if (changeSet.worker_delta.some((entry) => commandPaths.has(entry.path))) return false;
		const expectedDrift = changeSet.workspace_drift.filter((entry) => !commandPaths.has(entry.path));
		if (JSON.stringify(expectedDrift) !== JSON.stringify(record.remaining_workspace_drift)) return false;
	}
	const expectedDeltaHash = effectiveDeltaHash(record.delegation_id as string, record.contract_hash as string,
		record.worker_delta_hash as string, command, receipts);
	if (record.effective_delta_hash !== expectedDeltaHash) return false;
	const { command_provenance_hash: _ignored, ...withoutHash } = record as unknown as DelegationCommandProvenanceRecord;
	return record.command_provenance_hash === canonicalHash(provenanceProjection(withoutHash));
}

/**
 * True only when command provenance proves a completely attributed spatial
 * delta.  A failed command may make the worker attempt fail, but it is not
 * workspace drift when its effect is CLEAN/attributed and every receipt is
 * durably bound.  The WORKSPACE_DRIFT branch is read-only compatibility for
 * immutable v1 records produced before that distinction was enforced.
 */
export function isDelegationCommandScopeAttributedV1(
	value: unknown,
	changeSet: Readonly<ChangeSetRecord>,
): value is DelegationCommandProvenanceRecord {
	if (!validateDelegationCommandProvenance(value, changeSet)) return false;
	const record = value as DelegationCommandProvenanceRecord;
	const onlyRunFailure = record.terminal_reasons.every((reason) => reason === "COMMAND_EFFECT_RUN_FAILED");
	const legacyCleanRunFailure = record.effective_status === "WORKSPACE_DRIFT"
		&& record.terminal_reasons.length === 1
		&& record.terminal_reasons[0] === "COMMAND_EFFECT_RUN_FAILED";
	return changeSet.status === "ATTRIBUTED" && record.remaining_workspace_drift.length === 0 && onlyRunFailure
		&& (record.effective_status === "ATTRIBUTED" || legacyCleanRunFailure);
}

interface AttributedEffectStep {
	receipt: BoundCommandEffectReceipt;
	effect: CommandEffectRecord;
	change: CommandEffectObservedChange;
}

function validAttributedStepChain(
	steps: readonly AttributedEffectStep[],
	afterGuard: Readonly<WorkspaceGuardRecord> | undefined,
): boolean {
	if (steps.length === 0) return false;
	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index]!;
		if (step.change.before_exact_output === null || step.change.after_exact_output === null
			|| step.effect.before_guard === null || step.effect.after_guard === null
			|| step.effect.before_guard.git_head !== step.effect.after_guard.git_head
			|| (afterGuard !== undefined && step.effect.after_guard.git_head !== afterGuard.git_head)) return false;
		if (index === 0) continue;
		const prior = steps[index - 1]!;
		if (Date.parse(step.receipt.started_at) < Date.parse(prior.receipt.finished_at)
			|| !streamingIdentityEqual(prior.change.after_exact_output!, step.change.before_exact_output)
			|| !guardEntryEqual(prior.change.after, step.change.before)) return false;
	}
	return true;
}

/**
 * Re-open the complete bounded durable scan before review/checkpoint authority
 * is used.  Besides receipt bytes, this validates that every C path and its
 * run_ids are the exact per-path sequence found in the committed effects.
 */
export async function revalidateDelegationCommandProvenanceReceipts(
	projectRoot: string,
	record: Readonly<DelegationCommandProvenanceRecord>,
	changeSet?: Readonly<ChangeSetRecord>,
	afterGuard?: Readonly<WorkspaceGuardRecord>,
): Promise<boolean> {
	if (!validateDelegationCommandProvenance(record, changeSet)
		|| (afterGuard !== undefined && !validateWorkspaceGuard(afterGuard))) return false;
	const discovered = await discoverBoundCommandEffects(projectRoot, record.delegation_id, record.contract_hash);
	if (discovered.overflow || discovered.unavailable
		|| JSON.stringify(discovered.receipts) !== JSON.stringify(record.receipts)) return false;

	const stepsByPath = new Map<string, AttributedEffectStep[]>();
	for (let index = 0; index < discovered.effects.length; index += 1) {
		const effect = discovered.effects[index]!;
		const receipt = discovered.receipts[index]!;
		for (const change of effect.observed_changes) {
			if (change.classification !== "COMMAND_ATTRIBUTED") continue;
			const steps = stepsByPath.get(change.path) ?? [];
			steps.push({ effect, receipt, change });
			stepsByPath.set(change.path, steps);
		}
	}
	const workerPaths = new Set(changeSet?.worker_delta.map((entry) => entry.path) ?? []);
	const driftByPath = new Map(changeSet?.workspace_drift.map((entry) => [entry.path, entry] as const) ?? []);
	const deltaByPath = new Map(record.command_delta.map((entry) => [entry.path, entry] as const));
	let requiresBindingConflict = false;
	for (const delta of record.command_delta) {
		const steps = stepsByPath.get(delta.path);
		if (steps === undefined || workerPaths.has(delta.path) || !validAttributedStepChain(steps, afterGuard)
			|| JSON.stringify(steps.map((step) => step.effect.run_id)) !== JSON.stringify(delta.run_ids)) return false;
		const first = steps[0]!.change;
		const last = steps[steps.length - 1]!.change;
		if (!streamingIdentityEqual(first.before_exact_output!, delta.before)
			|| !streamingIdentityEqual(last.after_exact_output!, delta.after)) return false;
		const drift = driftByPath.get(delta.path);
		if (drift !== undefined && (!guardEntryEqual(drift.before, first.before)
			|| !guardEntryEqual(drift.after, last.after))) return false;
	}
	for (const [path, steps] of stepsByPath) {
		if (deltaByPath.has(path)) continue;
		const chainValid = !workerPaths.has(path) && validAttributedStepChain(steps, afterGuard);
		const first = steps[0]?.change.before_exact_output;
		const last = steps[steps.length - 1]?.change.after_exact_output;
		const drift = driftByPath.get(path);
		const driftMatches = first !== null && first !== undefined && last !== null && last !== undefined
			&& (drift === undefined || (guardEntryEqual(drift.before, steps[0]!.change.before)
				&& guardEntryEqual(drift.after, steps[steps.length - 1]!.change.after)));
		if (!chainValid || !driftMatches || (first !== null && first !== undefined && last !== null && last !== undefined
			&& !streamingIdentityEqual(first, last))) requiresBindingConflict = true;
	}
	return !requiresBindingConflict || record.terminal_reasons.includes("COMMAND_EFFECT_BINDING_CONFLICT");
}
