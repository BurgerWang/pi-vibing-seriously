/**
 * Parent-owned ChangeSet v2 lifecycle boundary.
 *
 * This module deliberately composes the existing journal, workspace guard,
 * and ChangeSet finalizer authorities. It does not reimplement their storage,
 * Git, identity, or hashing algorithms.
 */

import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
	CHANGE_SET_MAX_PATHS,
	validateChangeSet,
	type ChangeSetRecord,
} from "./change-set.ts";
import {
	finalizeChangeSetV2,
	type FinalizeChangeSetV2Options,
	type FinalizeChangeSetV2Result,
} from "./change-set-finalizer.ts";
import type { ExecFn } from "./config.ts";
import {
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
} from "./delegation-transaction.ts";
import {
	collectWorkspaceGuard,
	validateWorkspaceGuard,
	type CollectWorkspaceGuardInput,
	type CollectWorkspaceGuardResult,
	type WorkspaceGuardRecord,
} from "./workspace-guard.ts";
import {
	EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
	type WorkerWriteJournalRuntimeFailureCode,
	type WorkerWriteJournalRuntimeObservation,
} from "./worker-write-journal-runtime.ts";
import {
	EMPTY_WORKER_COMMAND_EFFECT_RUNTIME_OBSERVATION,
	finalizeDelegationCommandProvenance,
	type DelegationCommandProvenanceRecord,
	type WorkerCommandEffectRuntimeObservation,
} from "./delegation-command-effect-provenance.ts";
import { isStrictStreamingIdentityPath } from "./streaming-identity.ts";
import {
	createWorkerWriteJournal,
	readWorkerWriteJournal,
	sealWorkerWriteJournal,
	validateWorkerWriteJournalRecord,
	workerWriteJournalRelativePath,
	type CreateWorkerWriteJournalInput,
	type ReadWorkerWriteJournalInput,
	type SealWorkerWriteJournalInput,
	type WorkerWriteJournalRecord,
	type WriteJournalOptions,
	type WriteJournalResult,
} from "./write-journal.ts";

export const DELEGATION_CHANGE_SET_LIFECYCLE_SCHEMA_VERSION = 2 as const;

export interface PrepareDelegationChangeSetLifecycleV2Input {
	project_root: string;
	delegation_id: string;
	contract_hash: string;
	dependency_paths: readonly string[];
	exec: ExecFn;
}

export interface PreparedDelegationChangeSetLifecycleV2 {
	schema_version: typeof DELEGATION_CHANGE_SET_LIFECYCLE_SCHEMA_VERSION;
	project_root: string;
	delegation_id: string;
	contract_hash: string;
	dependency_paths: readonly string[];
	before_guard: Readonly<WorkspaceGuardRecord>;
	journal: Readonly<WorkerWriteJournalRecord>;
}

export interface FinalizeDelegationChangeSetLifecycleV2Input {
	prepared: Readonly<PreparedDelegationChangeSetLifecycleV2>;
	observation: Readonly<WorkerWriteJournalRuntimeObservation>;
	/** Optional only for historical/direct callers; production always supplies it. */
	command_effect_observation?: Readonly<WorkerCommandEffectRuntimeObservation>;
	exec: ExecFn;
}

export interface FinalizedDelegationChangeSetLifecycleV2 {
	prepared: Readonly<PreparedDelegationChangeSetLifecycleV2>;
	sealed_journal: Readonly<WorkerWriteJournalRecord>;
	after_guard: Readonly<WorkspaceGuardRecord>;
	change_set: Readonly<ChangeSetRecord>;
	/** Absent only on historical/source-compatible v2 fixtures and records. */
	command_provenance?: Readonly<DelegationCommandProvenanceRecord>;
}

export type DelegationChangeSetLifecycleV2ErrorCode =
	| "invalid_input"
	| "create_failed"
	| "before_guard_failed"
	| "read_failed"
	| "journal_invalid"
	| "observation_invalid"
	| "seal_failed"
	| "sealed_journal_invalid"
	| "after_guard_failed"
	| "finalizer_failed"
	| "command_provenance_failed";

export type DelegationChangeSetLifecycleV2FailureCause =
	| "exception"
	| "invalid_result"
	| "invalid_input"
	| "invalid_path"
	| "conflict"
	| "not_found"
	| "storage_failure"
	| "invalid_record"
	| "limit_exceeded"
	| "identity_failure"
	| "git_failure"
	| "path_overflow"
	| "status_overflow"
	| "stat_failure"
	| "unstable"
	| "invalid_journal"
	| "invalid_guard"
	| "invalid_dependencies";

export interface DelegationChangeSetLifecycleV2Error {
	code: DelegationChangeSetLifecycleV2ErrorCode;
	message: string;
	cause?: DelegationChangeSetLifecycleV2FailureCause;
}

export type PrepareDelegationChangeSetLifecycleV2Result =
	| { ok: true; value: Readonly<PreparedDelegationChangeSetLifecycleV2> }
	| { ok: false; error: Readonly<DelegationChangeSetLifecycleV2Error> };

export type FinalizeDelegationChangeSetLifecycleV2Result =
	| { ok: true; value: Readonly<FinalizedDelegationChangeSetLifecycleV2> }
	| { ok: false; error: Readonly<DelegationChangeSetLifecycleV2Error> };

type CreateJournal = (
	input: CreateWorkerWriteJournalInput,
	options?: WriteJournalOptions,
) => Promise<WriteJournalResult<WorkerWriteJournalRecord>>;
type ReadJournal = (
	input: ReadWorkerWriteJournalInput,
	options?: Pick<WriteJournalOptions, "storage_adapter">,
) => Promise<WriteJournalResult<WorkerWriteJournalRecord>>;
type SealJournal = (
	input: SealWorkerWriteJournalInput,
	options?: Pick<WriteJournalOptions, "storage_adapter">,
) => Promise<WriteJournalResult<WorkerWriteJournalRecord>>;
type CollectGuard = (input: CollectWorkspaceGuardInput) => Promise<CollectWorkspaceGuardResult>;
type FinalizeChangeSet = typeof finalizeChangeSetV2;

export interface PrepareDelegationChangeSetLifecycleV2Dependencies {
	create_journal?: CreateJournal;
	collect_guard?: CollectGuard;
	journal_options?: WriteJournalOptions;
	guard_options?: Omit<CollectWorkspaceGuardInput, "project_root" | "exec">;
}

export interface FinalizeDelegationChangeSetLifecycleV2Dependencies {
	read_journal?: ReadJournal;
	seal_journal?: SealJournal;
	collect_guard?: CollectGuard;
	finalize_change_set?: FinalizeChangeSet;
	journal_options?: Pick<WriteJournalOptions, "storage_adapter">;
	guard_options?: Omit<CollectWorkspaceGuardInput, "project_root" | "exec">;
	finalizer_options?: FinalizeChangeSetV2Options;
}

const PREPARE_INPUT_FIELDS = ["project_root", "delegation_id", "contract_hash", "dependency_paths", "exec"] as const;
const PREPARED_FIELDS = [
	"schema_version", "project_root", "delegation_id", "contract_hash", "dependency_paths", "before_guard", "journal",
] as const;
const FINALIZE_INPUT_FIELDS = ["prepared", "observation", "exec"] as const;
const FINALIZE_INPUT_FIELDS_WITH_COMMAND_EFFECT = ["prepared", "observation", "command_effect_observation", "exec"] as const;
const OBSERVATION_FIELDS = ["state", "tool", "outcome", "code", "revision"] as const;
const PREPARE_DEPENDENCY_FIELDS = ["create_journal", "collect_guard", "journal_options", "guard_options"] as const;
const FINALIZE_DEPENDENCY_FIELDS = [
	"read_journal", "seal_journal", "collect_guard", "finalize_change_set", "journal_options", "guard_options", "finalizer_options",
] as const;

const ERROR_MESSAGES: Readonly<Record<DelegationChangeSetLifecycleV2ErrorCode, string>> = Object.freeze({
	invalid_input: "delegation ChangeSet lifecycle input is invalid",
	create_failed: "delegation ChangeSet journal creation failed",
	before_guard_failed: "delegation ChangeSet before guard collection failed",
	read_failed: "delegation ChangeSet journal read failed",
	journal_invalid: "delegation ChangeSet open journal is invalid",
	observation_invalid: "delegation ChangeSet worker observation is invalid",
	seal_failed: "delegation ChangeSet journal seal failed",
	sealed_journal_invalid: "delegation ChangeSet sealed journal is invalid",
	after_guard_failed: "delegation ChangeSet after guard collection failed",
	finalizer_failed: "delegation ChangeSet finalization failed",
	command_provenance_failed: "delegation command-effect provenance finalization failed",
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Reject inherited/accessor fields so validation itself cannot execute input code. */
function exactDataRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
	if (!isPlainObject(value)) return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Object.keys(descriptors).sort();
	const expected = [...fields].sort();
	if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return undefined;
	for (const key of keys) {
		const descriptor = descriptors[key];
		if (descriptor === undefined || !("value" in descriptor)) return undefined;
	}
	return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function dependenciesRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
	if (value === undefined) return {};
	if (!isPlainObject(value)) return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!fields.includes(key) || !("value" in descriptor)) return undefined;
	}
	return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function validProjectRoot(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.trim() === value
		&& !/[\u0000-\u001f\u007f]/u.test(value)
		&& isAbsolute(value)
		&& resolve(value) === value;
}

function validDependencyPaths(value: unknown, delegationId: string): value is readonly string[] {
	if (!Array.isArray(value) || value.length > CHANGE_SET_MAX_PATHS) return false;
	const journalPath = workerWriteJournalRelativePath(delegationId);
	let previous: string | undefined;
	for (const path of value) {
		if (!isStrictStreamingIdentityPath(path) || path === journalPath) return false;
		if (previous !== undefined && byteCompare(previous, path) >= 0) return false;
		previous = path;
	}
	return true;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
	if (value === null || typeof value !== "object") return value;
	const object = value as object;
	if (seen.has(object)) return value;
	seen.add(object);
	for (const child of Object.values(object)) deepFreeze(child, seen);
	return Object.freeze(value);
}

function immutableSnapshot<T>(value: T): Readonly<T> | undefined {
	try {
		return deepFreeze(structuredClone(value));
	} catch {
		return undefined;
	}
}

function failure(
	code: DelegationChangeSetLifecycleV2ErrorCode,
	cause?: DelegationChangeSetLifecycleV2FailureCause,
): { ok: false; error: Readonly<DelegationChangeSetLifecycleV2Error> } {
	return {
		ok: false,
		error: Object.freeze({
			code,
			message: ERROR_MESSAGES[code],
			...(cause === undefined ? {} : { cause }),
		}),
	};
}

function safeCause(value: unknown): DelegationChangeSetLifecycleV2FailureCause {
	const allowed: readonly DelegationChangeSetLifecycleV2FailureCause[] = [
		"invalid_input", "invalid_path", "conflict", "not_found", "storage_failure", "invalid_record", "limit_exceeded",
		"identity_failure", "git_failure", "path_overflow", "status_overflow", "stat_failure", "unstable", "invalid_journal",
		"invalid_guard", "invalid_dependencies",
	];
	return typeof value === "string" && allowed.includes(value as DelegationChangeSetLifecycleV2FailureCause)
		? value as DelegationChangeSetLifecycleV2FailureCause
		: "invalid_result";
}

function operationIsCompleted(value: unknown): value is WorkerWriteJournalRecord["operations"][number] & { status: "completed" } {
	return isPlainObject(value)
		&& value.status === "completed"
		&& (value.kind === "edit" || value.kind === "write")
		&& (value.outcome === "succeeded" || value.outcome === "failed");
}

function safeNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validOpenJournal(
	value: unknown,
	identity: { delegation_id: string; contract_hash: string },
): value is WorkerWriteJournalRecord {
	return validateWorkerWriteJournalRecord(value)
		&& value.delegation_id === identity.delegation_id
		&& value.contract_hash === identity.contract_hash
		&& value.state === "OPEN"
		&& value.journal_hash === null
		&& !value.operations.some((operation) => operation.status === "pending");
}

function initialJournal(value: unknown, delegationId: string, contractHash: string): value is WorkerWriteJournalRecord {
	return validOpenJournal(value, { delegation_id: delegationId, contract_hash: contractHash })
		&& value.revision === 0
		&& value.operations.length === 0;
}

function exactObservation(value: unknown): WorkerWriteJournalRuntimeObservation | undefined {
	const record = exactDataRecord(value, OBSERVATION_FIELDS);
	if (record === undefined || typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 0) {
		return undefined;
	}
	if (record.state !== "empty" && record.state !== "begun" && record.state !== "complete" && record.state !== "failed") return undefined;
	if (record.tool !== "none" && record.tool !== "edit" && record.tool !== "write") return undefined;
	if (record.outcome !== "none" && record.outcome !== "succeeded" && record.outcome !== "failed") return undefined;
	const failureCodes: readonly WorkerWriteJournalRuntimeFailureCode[] = [
		"invalid_context", "invalid_call_id", "invalid_path", "pending_conflict", "unbegun_result", "result_mismatch",
		"journal_read_failed", "journal_not_open", "journal_begin_failed", "journal_complete_failed", "telemetry_failed", "poisoned",
	];
	if (record.code !== "none" && record.code !== "invalid"
		&& !failureCodes.includes(record.code as WorkerWriteJournalRuntimeFailureCode)) return undefined;
	return record as unknown as WorkerWriteJournalRuntimeObservation;
}

function observationMatchesJournal(
	observationValue: unknown,
	journal: WorkerWriteJournalRecord,
): boolean {
	const observation = exactObservation(observationValue);
	if (observation === undefined) return false;
	if (journal.operations.length === 0) {
		return observation.state === EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION.state
			&& observation.tool === EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION.tool
			&& observation.outcome === EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION.outcome
			&& observation.code === EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION.code
			&& observation.revision === 0
			&& journal.revision === 0;
	}
	const last = journal.operations[journal.operations.length - 1];
	return last !== undefined
		&& operationIsCompleted(last)
		&& observation.state === "complete"
		&& observation.code === "none"
		&& observation.revision === journal.revision
		&& observation.tool === last.kind
		&& observation.outcome === last.outcome;
}

function validSealedJournal(sealed: unknown, open: WorkerWriteJournalRecord): sealed is WorkerWriteJournalRecord {
	return validateWorkerWriteJournalRecord(sealed)
		&& sealed.delegation_id === open.delegation_id
		&& sealed.contract_hash === open.contract_hash
		&& sealed.state === "SEALED"
		&& sealed.revision === open.revision + 1
		&& isDeepStrictEqual(sealed.limits, open.limits)
		&& isDeepStrictEqual(sealed.meter, open.meter)
		&& isDeepStrictEqual(sealed.operations, open.operations);
}

function validPrepared(value: unknown): value is PreparedDelegationChangeSetLifecycleV2 {
	const record = exactDataRecord(value, PREPARED_FIELDS);
	if (record === undefined || record.schema_version !== DELEGATION_CHANGE_SET_LIFECYCLE_SCHEMA_VERSION
		|| !validProjectRoot(record.project_root)
		|| typeof record.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(record.delegation_id)
		|| typeof record.contract_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(record.contract_hash)
		|| !validDependencyPaths(record.dependency_paths, record.delegation_id)
		|| !validateWorkspaceGuard(record.before_guard)
		|| !initialJournal(record.journal, record.delegation_id, record.contract_hash)) return false;
	const journalPath = workerWriteJournalRelativePath(record.delegation_id);
	return !record.before_guard.entries.some((entry) => entry.path === journalPath);
}

function prepareDependencies(value: unknown): PrepareDelegationChangeSetLifecycleV2Dependencies | undefined {
	const record = dependenciesRecord(value, PREPARE_DEPENDENCY_FIELDS);
	if (record === undefined
		|| (record.create_journal !== undefined && typeof record.create_journal !== "function")
		|| (record.collect_guard !== undefined && typeof record.collect_guard !== "function")) return undefined;
	return record as unknown as PrepareDelegationChangeSetLifecycleV2Dependencies;
}

function finalizeDependencies(value: unknown): FinalizeDelegationChangeSetLifecycleV2Dependencies | undefined {
	const record = dependenciesRecord(value, FINALIZE_DEPENDENCY_FIELDS);
	if (record === undefined
		|| (record.read_journal !== undefined && typeof record.read_journal !== "function")
		|| (record.seal_journal !== undefined && typeof record.seal_journal !== "function")
		|| (record.collect_guard !== undefined && typeof record.collect_guard !== "function")
		|| (record.finalize_change_set !== undefined && typeof record.finalize_change_set !== "function")) return undefined;
	return record as unknown as FinalizeDelegationChangeSetLifecycleV2Dependencies;
}

/** Create the durable OPEN journal before collecting the authoritative before guard. */
export async function prepareDelegationChangeSetLifecycleV2(
	inputValue: PrepareDelegationChangeSetLifecycleV2Input,
	dependenciesValue?: PrepareDelegationChangeSetLifecycleV2Dependencies,
): Promise<PrepareDelegationChangeSetLifecycleV2Result> {
	try {
		const input = exactDataRecord(inputValue, PREPARE_INPUT_FIELDS);
		const dependencies = prepareDependencies(dependenciesValue);
		if (input === undefined || dependencies === undefined || !validProjectRoot(input.project_root)
			|| typeof input.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(input.delegation_id)
			|| typeof input.contract_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(input.contract_hash)
			|| !validDependencyPaths(input.dependency_paths, input.delegation_id) || typeof input.exec !== "function") {
			return failure("invalid_input");
		}
		const createJournal = dependencies.create_journal ?? createWorkerWriteJournal;
		let created: WriteJournalResult<WorkerWriteJournalRecord>;
		try {
			created = await createJournal({
				project_root: input.project_root,
				delegation_id: input.delegation_id,
				contract_hash: input.contract_hash,
			}, dependencies.journal_options);
		} catch {
			return failure("create_failed", "exception");
		}
		if (!isPlainObject(created) || created.ok !== true || !("value" in created)) {
			const cause = isPlainObject(created) && created.ok === false && isPlainObject(created.error)
				? safeCause(created.error.code) : "invalid_result";
			return failure("create_failed", cause);
		}
		if (!initialJournal(created.value, input.delegation_id, input.contract_hash)) {
			return failure("create_failed", "invalid_result");
		}

		const collectGuard = dependencies.collect_guard ?? collectWorkspaceGuard;
		let before: CollectWorkspaceGuardResult;
		try {
			before = await collectGuard({
				...(dependencies.guard_options ?? {}),
				project_root: input.project_root,
				exec: input.exec as ExecFn,
			});
		} catch {
			return failure("before_guard_failed", "exception");
		}
		if (!isPlainObject(before) || before.ok !== true || !("guard" in before) || !validateWorkspaceGuard(before.guard)) {
			const cause = isPlainObject(before) && before.ok === false && isPlainObject(before.error)
				? safeCause(before.error.code) : "invalid_result";
			return failure("before_guard_failed", cause);
		}
		const journalPath = workerWriteJournalRelativePath(input.delegation_id);
		if (before.guard.entries.some((entry) => entry.path === journalPath)) {
			return failure("before_guard_failed", "invalid_result");
		}

		const prepared = immutableSnapshot({
			schema_version: DELEGATION_CHANGE_SET_LIFECYCLE_SCHEMA_VERSION,
			project_root: input.project_root,
			delegation_id: input.delegation_id,
			contract_hash: input.contract_hash,
			dependency_paths: [...input.dependency_paths as readonly string[]],
			before_guard: before.guard,
			journal: created.value,
		});
		return prepared === undefined ? failure("before_guard_failed", "invalid_result") : { ok: true, value: prepared };
	} catch {
		return failure("invalid_input");
	}
}

/**
 * Strict-read, validate the worker observation, exact-CAS seal, then collect
 * the after guard and invoke the existing ChangeSet v2 finalizer.
 */
export async function finalizeDelegationChangeSetLifecycleV2(
	inputValue: FinalizeDelegationChangeSetLifecycleV2Input,
	dependenciesValue?: FinalizeDelegationChangeSetLifecycleV2Dependencies,
): Promise<FinalizeDelegationChangeSetLifecycleV2Result> {
	try {
		const input = exactDataRecord(inputValue, FINALIZE_INPUT_FIELDS_WITH_COMMAND_EFFECT)
			?? exactDataRecord(inputValue, FINALIZE_INPUT_FIELDS);
		const dependencies = finalizeDependencies(dependenciesValue);
		if (input === undefined || dependencies === undefined || !validPrepared(input.prepared) || typeof input.exec !== "function") {
			return failure("invalid_input");
		}
		const prepared = input.prepared;
		const identity = {
			project_root: prepared.project_root,
			delegation_id: prepared.delegation_id,
			contract_hash: prepared.contract_hash,
		};
		const readJournal = dependencies.read_journal ?? readWorkerWriteJournal;
		let read: WriteJournalResult<WorkerWriteJournalRecord>;
		try {
			read = await readJournal(identity, dependencies.journal_options);
		} catch {
			return failure("read_failed", "exception");
		}
		if (!isPlainObject(read) || read.ok !== true || !("value" in read)) {
			const cause = isPlainObject(read) && read.ok === false && isPlainObject(read.error)
				? safeCause(read.error.code) : "invalid_result";
			return failure("read_failed", cause);
		}
		const open = read.value;
		if (!validOpenJournal(open, identity)) return failure("journal_invalid");
		if (!observationMatchesJournal(input.observation, open)) return failure("observation_invalid");

		const sealJournal = dependencies.seal_journal ?? sealWorkerWriteJournal;
		let sealed: WriteJournalResult<WorkerWriteJournalRecord>;
		try {
			sealed = await sealJournal({ ...identity, expected_revision: open.revision }, dependencies.journal_options);
		} catch {
			return failure("seal_failed", "exception");
		}
		if (!isPlainObject(sealed) || sealed.ok !== true || !("value" in sealed)) {
			const cause = isPlainObject(sealed) && sealed.ok === false && isPlainObject(sealed.error)
				? safeCause(sealed.error.code) : "invalid_result";
			return failure("seal_failed", cause);
		}
		if (!validSealedJournal(sealed.value, open)) return failure("sealed_journal_invalid");

		const collectGuard = dependencies.collect_guard ?? collectWorkspaceGuard;
		let after: CollectWorkspaceGuardResult;
		try {
			after = await collectGuard({
				...(dependencies.guard_options ?? {}),
				project_root: prepared.project_root,
				exec: input.exec as ExecFn,
			});
		} catch {
			return failure("after_guard_failed", "exception");
		}
		if (!isPlainObject(after) || after.ok !== true || !("guard" in after) || !validateWorkspaceGuard(after.guard)) {
			const cause = isPlainObject(after) && after.ok === false && isPlainObject(after.error)
				? safeCause(after.error.code) : "invalid_result";
			return failure("after_guard_failed", cause);
		}

		const finalizeChangeSet = dependencies.finalize_change_set ?? finalizeChangeSetV2;
		let finalized: FinalizeChangeSetV2Result;
		try {
			finalized = await finalizeChangeSet({
				project_root: prepared.project_root,
				delegation_id: prepared.delegation_id,
				contract_hash: prepared.contract_hash,
				journal_hash: sealed.value.journal_hash!,
				journal: sealed.value,
				before_guard: prepared.before_guard,
				after_guard: after.guard,
				dependency_paths: prepared.dependency_paths,
			}, dependencies.finalizer_options);
		} catch {
			return failure("finalizer_failed", "exception");
		}
		if (!isPlainObject(finalized) || finalized.ok !== true || !("value" in finalized)) {
			const cause = isPlainObject(finalized) && finalized.ok === false && isPlainObject(finalized.error)
				? safeCause(finalized.error.code) : "invalid_result";
			return failure("finalizer_failed", cause);
		}
		if (!validateChangeSet(finalized.value) || finalized.value.delegation_id !== prepared.delegation_id
			|| finalized.value.contract_hash !== prepared.contract_hash
			|| finalized.value.journal_hash !== sealed.value.journal_hash) return failure("finalizer_failed", "invalid_result");
		const commandProvenance = await finalizeDelegationCommandProvenance({
			project_root: prepared.project_root,
			delegation_id: prepared.delegation_id,
			contract_hash: prepared.contract_hash,
			before_guard: prepared.before_guard,
			after_guard: after.guard,
			change_set: finalized.value,
			observation: (input.command_effect_observation as Readonly<WorkerCommandEffectRuntimeObservation> | undefined)
				?? EMPTY_WORKER_COMMAND_EFFECT_RUNTIME_OBSERVATION,
		});
		if (!commandProvenance.ok) return failure("command_provenance_failed",
			commandProvenance.code === "identity_unavailable" ? "identity_failure" : "invalid_result");

		const value = immutableSnapshot({
			prepared,
			sealed_journal: sealed.value,
			after_guard: after.guard,
			change_set: finalized.value,
			command_provenance: commandProvenance.value,
		});
		return value === undefined ? failure("finalizer_failed", "invalid_result") : { ok: true, value };
	} catch {
		return failure("invalid_input");
	}
}
