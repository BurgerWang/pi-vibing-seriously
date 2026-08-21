/**
 * Delegation transaction v2 — closed schema and pure lifecycle decisions.
 *
 * This module deliberately owns no filesystem I/O.  The storage adapter is a
 * separate slice: it supplies a strictly validated committed-generation proof
 * before this state machine can publish any terminal/success state.
 */

import { isAbsolute, posix } from "node:path";

import {
	WORKER_MODEL_ID,
	WORKER_PROVIDER,
} from "./worker-policy.ts";

export const DELEGATION_TRANSACTION_SCHEMA_VERSION = 2 as const;
export const DELEGATION_TRANSACTION_MAX_BYTES = 1_048_576 as const;
export const DELEGATION_TRANSACTION_MAX_PATHS = 500 as const;
export const DELEGATION_TRANSACTION_MAX_ALLOWED_PATHS = 50 as const;
export const DELEGATION_TRANSACTION_MAX_REASON_CHARS = 500 as const;

export const DELEGATION_TRANSACTION_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/;
export const DELEGATION_TRANSACTION_HASH_RE = /^[a-f0-9]{64}$/;
export const DELEGATION_TRANSACTION_WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const DELEGATION_TASK_KINDS = ["implementation", "diagnosis"] as const;
export type DelegationTaskKind = (typeof DELEGATION_TASK_KINDS)[number];

export const DELEGATION_TRANSACTION_STATUSES = [
	"PREPARED",
	"RUNNING",
	"COMMITTING",
	"FINISHED",
	"PENDING_REVIEW",
	"REVIEWED",
	"FAILED",
	"ABORTED",
	"RECOVERY_REQUIRED",
] as const;
export type DelegationTransactionStatus = (typeof DELEGATION_TRANSACTION_STATUSES)[number];

/** Exact authority-record inventory required before a generation is visible. */
export const DELEGATION_COMMITTED_RECORD_NAMES = [
	"after.json",
	"before.json",
	"identity.json",
	"review.json",
	"scope.json",
	"usage.json",
	"worker-report.md",
	"worker-summary.json",
] as const;
export type DelegationCommittedRecordName = (typeof DELEGATION_COMMITTED_RECORD_NAMES)[number];

/** Fixed evaluation order; callers must never replace these facts with prose. */
export const DELEGATION_POSTCONDITION_REASON_ORDER = [
	"PROVIDER_NOT_SUCCESS",
	"EXIT_CODE_NOT_ZERO",
	"REPORT_INCOMPLETE",
	"TERMINAL_FACTS_INCOMPLETE",
	"SCOPE_INCOMPLETE",
	"WORKSPACE_DRIFT_DETECTED",
	"CHANGE_SET_CONFLICT",
	"OUT_OF_SCOPE_CHANGES",
	"IMPLEMENTATION_DELTA_REQUIRED",
	"IMPLEMENTATION_DELTA_HASH_REQUIRED",
	"DIAGNOSIS_DELTA_FORBIDDEN",
	"DIAGNOSIS_SUCCESSFUL_WRITES_FORBIDDEN",
	"DIAGNOSIS_DENIED_WRITES_FORBIDDEN",
] as const;
export type DelegationPostconditionReason = (typeof DELEGATION_POSTCONDITION_REASON_ORDER)[number];

export interface DelegationWorkerIdentity {
	provider: typeof WORKER_PROVIDER;
	model: typeof WORKER_MODEL_ID;
	worker_id: string;
}

export interface DelegationTerminalOutcome {
	delegation_id: string;
	task_kind: DelegationTaskKind;
	worker_identity: DelegationWorkerIdentity;
	provider_success: boolean;
	exit_code: number;
	report_complete: boolean;
	terminal_facts_complete: boolean;
	scope_complete: boolean;
	change_set_status: "ATTRIBUTED" | "WORKSPACE_DRIFT" | "CONFLICT";
	changed_paths: string[];
	successful_write_count: number;
	denied_write_count: number;
	delta_hash: string | null;
}

export interface DelegationCommittedGenerationProof {
	schema_version: typeof DELEGATION_TRANSACTION_SCHEMA_VERSION;
	delegation_id: string;
	task_kind: DelegationTaskKind;
	contract_hash: string;
	worker_identity: DelegationWorkerIdentity;
	generation: number;
	revision: number;
	record_names: DelegationCommittedRecordName[];
	record_count: number;
	content_hash: string;
	commit_marker: string;
}

export interface DelegationReviewProof {
	delegation_id: string;
	generation: number;
	transaction_revision: number;
	review_hash: string;
	reviewed_at: string;
	reviewer: "sol";
}

export interface DelegationTransactionRecord {
	schema_version: typeof DELEGATION_TRANSACTION_SCHEMA_VERSION;
	delegation_id: string;
	task_kind: DelegationTaskKind;
	contract_hash: string;
	allowed_paths: string[];
	worker_identity: DelegationWorkerIdentity;
	generation: number;
	revision: number;
	status: DelegationTransactionStatus;
	created_at: string;
	updated_at: string;
	postcondition_reasons: DelegationPostconditionReason[];
	terminal_outcome: DelegationTerminalOutcome | null;
	committed_proof: DelegationCommittedGenerationProof | null;
	review: DelegationReviewProof | null;
	abort_reason: string | null;
	recovery_reason: string | null;
}

export interface PrepareDelegationTransactionInput {
	delegation_id: string;
	task_kind: string;
	contract_hash: string;
	allowed_paths: readonly string[];
	worker_identity: {
		provider: string;
		model: string;
		worker_id: string;
	};
	generation: number;
	now: string;
}

export interface DelegationCasInput {
	delegation_id: string;
	contract_hash: string;
	worker_identity: DelegationWorkerIdentity;
	expected_generation: number;
	expected_revision: number;
	now: string;
}

export interface BeginDelegationCommitInput extends DelegationCasInput {
	outcome: DelegationTerminalOutcome;
}

export interface PublishDelegationCommitInput extends DelegationCasInput {
	proof: DelegationCommittedGenerationProof;
}

export interface ReviewDelegationTransactionInput extends DelegationCasInput {
	review_hash: string;
}

export interface StopDelegationTransactionInput extends DelegationCasInput {
	reason: string;
}

export type DelegationTransactionResult =
	| { ok: true; state: DelegationTransactionRecord }
	| { ok: false; error: string };

type UnknownRecord = Record<string, unknown>;

const TOP_LEVEL_FIELDS = [
	"schema_version",
	"delegation_id",
	"task_kind",
	"contract_hash",
	"allowed_paths",
	"worker_identity",
	"generation",
	"revision",
	"status",
	"created_at",
	"updated_at",
	"postcondition_reasons",
	"terminal_outcome",
	"committed_proof",
	"review",
	"abort_reason",
	"recovery_reason",
] as const;

const IDENTITY_FIELDS = ["provider", "model", "worker_id"] as const;
const OUTCOME_FIELDS = [
	"delegation_id",
	"task_kind",
	"worker_identity",
	"provider_success",
	"exit_code",
	"report_complete",
	"terminal_facts_complete",
	"scope_complete",
	"change_set_status",
	"changed_paths",
	"successful_write_count",
	"denied_write_count",
	"delta_hash",
] as const;
const PROOF_FIELDS = [
	"schema_version",
	"delegation_id",
	"task_kind",
	"contract_hash",
	"worker_identity",
	"generation",
	"revision",
	"record_names",
	"record_count",
	"content_hash",
	"commit_marker",
] as const;
const REVIEW_FIELDS = [
	"delegation_id",
	"generation",
	"transaction_revision",
	"review_hash",
	"reviewed_at",
	"reviewer",
] as const;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: UnknownRecord, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...fields].sort();
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTime(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 20 || value.length > 32) return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function isTaskKind(value: unknown): value is DelegationTaskKind {
	return DELEGATION_TASK_KINDS.includes(value as DelegationTaskKind);
}

function isStatus(value: unknown): value is DelegationTransactionStatus {
	return DELEGATION_TRANSACTION_STATUSES.includes(value as DelegationTransactionStatus);
}

function isReason(value: unknown): value is DelegationPostconditionReason {
	return DELEGATION_POSTCONDITION_REASON_ORDER.includes(value as DelegationPostconditionReason);
}

function isStrictRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 400) return false;
	if (value !== value.trim() || isAbsolute(value) || value.includes("\\") || value.includes("\0")) return false;
	const normalized = posix.normalize(value);
	return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

function isAllowedPathRule(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 400) return false;
	const base = value.endsWith("/**") ? value.slice(0, -3) : value.endsWith("/") ? value.slice(0, -1) : value;
	return base.length > 0 && isStrictRelativePath(base);
}

function isSortedUnique(values: readonly string[]): boolean {
	for (let index = 0; index < values.length; index += 1) {
		if (index > 0 && values[index - 1]! >= values[index]!) return false;
	}
	return true;
}

function isByteSortedUnique(values: readonly string[]): boolean {
	return values.every((value, index) => index === 0 ||
		Buffer.from(values[index - 1]!, "utf8").compare(Buffer.from(value, "utf8")) < 0);
}

function cloneIdentity(identity: DelegationWorkerIdentity): DelegationWorkerIdentity {
	return { provider: identity.provider, model: identity.model, worker_id: identity.worker_id };
}

function sameIdentity(left: DelegationWorkerIdentity, right: DelegationWorkerIdentity): boolean {
	return left.provider === right.provider && left.model === right.model && left.worker_id === right.worker_id;
}

function validIdentity(value: unknown): value is DelegationWorkerIdentity {
	if (!isRecord(value) || !hasExactFields(value, IDENTITY_FIELDS)) return false;
	return value.provider === WORKER_PROVIDER && value.model === WORKER_MODEL_ID &&
		typeof value.worker_id === "string" && DELEGATION_TRANSACTION_WORKER_ID_RE.test(value.worker_id);
}

function cloneOutcome(outcome: DelegationTerminalOutcome): DelegationTerminalOutcome {
	return {
		...outcome,
		worker_identity: cloneIdentity(outcome.worker_identity),
		changed_paths: [...outcome.changed_paths],
	};
}

function validOutcome(value: unknown): value is DelegationTerminalOutcome {
	if (!isRecord(value) || !hasExactFields(value, OUTCOME_FIELDS)) return false;
	if (!DELEGATION_TRANSACTION_ID_RE.test(String(value.delegation_id)) || !isTaskKind(value.task_kind)) return false;
	if (!validIdentity(value.worker_identity)) return false;
	if (typeof value.provider_success !== "boolean" || !Number.isSafeInteger(value.exit_code)) return false;
	if (typeof value.report_complete !== "boolean" || typeof value.terminal_facts_complete !== "boolean" || typeof value.scope_complete !== "boolean") return false;
	if (value.change_set_status !== "ATTRIBUTED" && value.change_set_status !== "WORKSPACE_DRIFT" && value.change_set_status !== "CONFLICT") return false;
	if (!Array.isArray(value.changed_paths) || value.changed_paths.length > DELEGATION_TRANSACTION_MAX_PATHS) return false;
	if (!value.changed_paths.every(isStrictRelativePath) || !isByteSortedUnique(value.changed_paths)) return false;
	if (!isNonNegativeInteger(value.successful_write_count) || !isNonNegativeInteger(value.denied_write_count)) return false;
	return value.delta_hash === null || (typeof value.delta_hash === "string" && DELEGATION_TRANSACTION_HASH_RE.test(value.delta_hash));
}

function markerFor(proof: Omit<DelegationCommittedGenerationProof, "commit_marker">): string {
	return `delegation-v2:${proof.delegation_id}:${proof.task_kind}:${proof.contract_hash}:${proof.generation}:${proof.revision}:${proof.content_hash}`;
}

export function delegationCommitMarker(
	proof: Omit<DelegationCommittedGenerationProof, "commit_marker">,
): string {
	return markerFor(proof);
}

function cloneProof(proof: DelegationCommittedGenerationProof): DelegationCommittedGenerationProof {
	return {
		...proof,
		worker_identity: cloneIdentity(proof.worker_identity),
		record_names: [...proof.record_names],
	};
}

function validProof(value: unknown): value is DelegationCommittedGenerationProof {
	if (!isRecord(value) || !hasExactFields(value, PROOF_FIELDS)) return false;
	if (value.schema_version !== DELEGATION_TRANSACTION_SCHEMA_VERSION) return false;
	if (!DELEGATION_TRANSACTION_ID_RE.test(String(value.delegation_id)) || !isTaskKind(value.task_kind)) return false;
	if (typeof value.contract_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(value.contract_hash)) return false;
	if (!validIdentity(value.worker_identity) || !isPositiveInteger(value.generation) || !isNonNegativeInteger(value.revision)) return false;
	if (!Array.isArray(value.record_names) || value.record_names.length !== DELEGATION_COMMITTED_RECORD_NAMES.length) return false;
	if (!value.record_names.every((name, index) => name === DELEGATION_COMMITTED_RECORD_NAMES[index])) return false;
	if (value.record_count !== DELEGATION_COMMITTED_RECORD_NAMES.length) return false;
	if (typeof value.content_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(value.content_hash)) return false;
	if (typeof value.commit_marker !== "string") return false;
	return value.commit_marker === markerFor(value as unknown as Omit<DelegationCommittedGenerationProof, "commit_marker">);
}

function cloneReview(review: DelegationReviewProof): DelegationReviewProof {
	return { ...review };
}

function validReview(value: unknown): value is DelegationReviewProof {
	return isRecord(value) && hasExactFields(value, REVIEW_FIELDS) &&
		DELEGATION_TRANSACTION_ID_RE.test(String(value.delegation_id)) &&
		isPositiveInteger(value.generation) && isNonNegativeInteger(value.transaction_revision) &&
		typeof value.review_hash === "string" && DELEGATION_TRANSACTION_HASH_RE.test(value.review_hash) &&
		isIsoTime(value.reviewed_at) && value.reviewer === "sol";
}

export function delegationPathAllowedV2(path: string, allowedPaths: readonly string[]): boolean {
	for (const rule of allowedPaths) {
		if (rule.endsWith("/**")) {
			const base = rule.slice(0, -3);
			if (path === base || path.startsWith(`${base}/`)) return true;
		} else if (rule.endsWith("/")) {
			const base = rule.slice(0, -1);
			if (path === base || path.startsWith(`${base}/`)) return true;
		} else if (path === rule) {
			return true;
		}
	}
	return false;
}

/** Evaluate machine facts only, in a fixed order independent of worker prose. */
export function evaluateDelegationPostconditions(
	state: Pick<DelegationTransactionRecord, "task_kind" | "allowed_paths">,
	outcome: DelegationTerminalOutcome,
): DelegationPostconditionReason[] {
	const reasons: DelegationPostconditionReason[] = [];
	if (!outcome.provider_success) reasons.push("PROVIDER_NOT_SUCCESS");
	if (outcome.exit_code !== 0) reasons.push("EXIT_CODE_NOT_ZERO");
	if (!outcome.report_complete) reasons.push("REPORT_INCOMPLETE");
	if (!outcome.terminal_facts_complete) reasons.push("TERMINAL_FACTS_INCOMPLETE");
	if (!outcome.scope_complete) reasons.push("SCOPE_INCOMPLETE");
	if (outcome.change_set_status === "WORKSPACE_DRIFT") reasons.push("WORKSPACE_DRIFT_DETECTED");
	if (outcome.change_set_status === "CONFLICT") reasons.push("CHANGE_SET_CONFLICT");
	if (outcome.changed_paths.some((path) => !delegationPathAllowedV2(path, state.allowed_paths))) reasons.push("OUT_OF_SCOPE_CHANGES");
	if (state.task_kind === "implementation") {
		if (outcome.changed_paths.length === 0) reasons.push("IMPLEMENTATION_DELTA_REQUIRED");
		if (outcome.delta_hash === null) reasons.push("IMPLEMENTATION_DELTA_HASH_REQUIRED");
	} else {
		if (outcome.changed_paths.length !== 0 || outcome.delta_hash !== null) reasons.push("DIAGNOSIS_DELTA_FORBIDDEN");
		if (outcome.successful_write_count !== 0) reasons.push("DIAGNOSIS_SUCCESSFUL_WRITES_FORBIDDEN");
		if (outcome.denied_write_count !== 0) reasons.push("DIAGNOSIS_DENIED_WRITES_FORBIDDEN");
	}
	return reasons;
}

function cloneState(state: DelegationTransactionRecord): DelegationTransactionRecord {
	return {
		...state,
		allowed_paths: [...state.allowed_paths],
		worker_identity: cloneIdentity(state.worker_identity),
		postcondition_reasons: [...state.postcondition_reasons],
		terminal_outcome: state.terminal_outcome === null ? null : cloneOutcome(state.terminal_outcome),
		committed_proof: state.committed_proof === null ? null : cloneProof(state.committed_proof),
		review: state.review === null ? null : cloneReview(state.review),
	};
}

function validReasonText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= DELEGATION_TRANSACTION_MAX_REASON_CHARS &&
		value === value.trim() && !value.includes("\0");
}

function exactReasons(actual: readonly DelegationPostconditionReason[], expected: readonly DelegationPostconditionReason[]): boolean {
	return actual.length === expected.length && actual.every((reason, index) => reason === expected[index]);
}

function validStateInvariants(state: DelegationTransactionRecord): boolean {
	const outcome = state.terminal_outcome;
	const proof = state.committed_proof;
	const review = state.review;
	if (outcome !== null) {
		if (outcome.delegation_id !== state.delegation_id || outcome.task_kind !== state.task_kind || !sameIdentity(outcome.worker_identity, state.worker_identity)) return false;
		if (!exactReasons(state.postcondition_reasons, evaluateDelegationPostconditions(state, outcome))) return false;
	} else if (state.postcondition_reasons.length !== 0) {
		return false;
	}
	if (proof !== null) {
		if (proof.delegation_id !== state.delegation_id || proof.task_kind !== state.task_kind || proof.contract_hash !== state.contract_hash || !sameIdentity(proof.worker_identity, state.worker_identity)) return false;
		if (proof.generation !== state.generation) return false;
	}
	if (review !== null) {
		if (review.delegation_id !== state.delegation_id || review.generation !== state.generation) return false;
	}

	switch (state.status) {
		case "PREPARED":
			return state.revision === 0 && outcome === null && proof === null && review === null &&
				state.abort_reason === null && state.recovery_reason === null;
		case "RUNNING":
			return state.revision === 1 && outcome === null && proof === null && review === null &&
				state.abort_reason === null && state.recovery_reason === null;
		case "COMMITTING":
			return state.revision === 2 && outcome !== null && proof === null && review === null &&
				state.abort_reason === null && state.recovery_reason === null;
		case "PENDING_REVIEW":
			return state.revision === 3 && state.task_kind === "implementation" && outcome !== null && proof !== null && review === null &&
				proof.revision === 2 &&
				state.postcondition_reasons.length === 0 && state.abort_reason === null && state.recovery_reason === null;
		case "FINISHED":
			return state.revision === 3 && state.task_kind === "diagnosis" && outcome !== null && proof !== null && review === null &&
				proof.revision === 2 &&
				state.postcondition_reasons.length === 0 && state.abort_reason === null && state.recovery_reason === null;
		case "REVIEWED":
			return state.revision === 4 && state.task_kind === "implementation" && outcome !== null && proof !== null && review !== null &&
				proof.revision === 2 && review.transaction_revision === 3 &&
				state.postcondition_reasons.length === 0 && state.abort_reason === null && state.recovery_reason === null;
		case "FAILED":
			return state.revision === 3 && outcome !== null && proof !== null && review === null && state.postcondition_reasons.length > 0 &&
				proof.revision === 2 &&
				outcome.terminal_facts_complete && outcome.scope_complete && state.abort_reason === null && state.recovery_reason === null;
		case "ABORTED":
			return (state.revision === 1 || state.revision === 2) && outcome === null && proof === null && review === null &&
				state.abort_reason !== null && state.recovery_reason === null;
		case "RECOVERY_REQUIRED":
			if (review !== null || state.abort_reason !== null || state.recovery_reason === null) return false;
			if (state.revision === 2) return outcome === null && proof === null;
			if (state.revision !== 3 || outcome === null) return false;
			return proof === null || proof.revision === 2;
	}
}

function parseState(raw: unknown): DelegationTransactionRecord | undefined {
	if (!isRecord(raw) || !hasExactFields(raw, TOP_LEVEL_FIELDS)) return undefined;
	if (raw.schema_version !== DELEGATION_TRANSACTION_SCHEMA_VERSION) return undefined;
	if (typeof raw.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(raw.delegation_id)) return undefined;
	if (!isTaskKind(raw.task_kind) || !isStatus(raw.status)) return undefined;
	if (typeof raw.contract_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(raw.contract_hash)) return undefined;
	if (!Array.isArray(raw.allowed_paths) || raw.allowed_paths.length === 0 || raw.allowed_paths.length > DELEGATION_TRANSACTION_MAX_ALLOWED_PATHS) return undefined;
	if (!raw.allowed_paths.every(isAllowedPathRule) || !isSortedUnique(raw.allowed_paths)) return undefined;
	if (!validIdentity(raw.worker_identity) || !isPositiveInteger(raw.generation) || !isNonNegativeInteger(raw.revision)) return undefined;
	if (!isIsoTime(raw.created_at) || !isIsoTime(raw.updated_at)) return undefined;
	if (raw.updated_at < raw.created_at) return undefined;
	if (!Array.isArray(raw.postcondition_reasons) || !raw.postcondition_reasons.every(isReason)) return undefined;
	if (!isSortedUniqueByOrder(raw.postcondition_reasons)) return undefined;
	if (raw.terminal_outcome !== null && !validOutcome(raw.terminal_outcome)) return undefined;
	if (raw.committed_proof !== null && !validProof(raw.committed_proof)) return undefined;
	if (raw.review !== null && !validReview(raw.review)) return undefined;
	if (raw.abort_reason !== null && !validReasonText(raw.abort_reason)) return undefined;
	if (raw.recovery_reason !== null && !validReasonText(raw.recovery_reason)) return undefined;
	const state = cloneState(raw as unknown as DelegationTransactionRecord);
	return validStateInvariants(state) ? state : undefined;
}

function isSortedUniqueByOrder(reasons: readonly DelegationPostconditionReason[]): boolean {
	let last = -1;
	for (const reason of reasons) {
		const index = DELEGATION_POSTCONDITION_REASON_ORDER.indexOf(reason);
		if (index <= last) return false;
		last = index;
	}
	return true;
}

export type ParseDelegationTransactionResult =
	| { ok: true; state: DelegationTransactionRecord }
	| { ok: false; error: string };

/** Closed-field, bounded parser for persisted v2 state. */
export function parseDelegationTransaction(raw: unknown): ParseDelegationTransactionResult {
	let encoded: string;
	try {
		encoded = JSON.stringify(raw);
	} catch {
		return { ok: false, error: "delegation transaction must be JSON-serializable" };
	}
	if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > DELEGATION_TRANSACTION_MAX_BYTES) {
		return { ok: false, error: `delegation transaction exceeds ${DELEGATION_TRANSACTION_MAX_BYTES} bytes` };
	}
	const state = parseState(raw);
	if (state === undefined) return { ok: false, error: "invalid delegation transaction v2 record" };
	return { ok: true, state };
}

/** Strict serializer: invalid in-memory states are refused, never repaired. */
export function serializeDelegationTransaction(state: DelegationTransactionRecord): DelegationTransactionRecord {
	const parsed = parseDelegationTransaction(state);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.state;
}

const INVALID_TRANSITION_SOURCE_ERROR = "invalid delegation transaction source state";

/**
 * Every public transition starts from the same closed, bounded parser used by
 * durable v2 state.  Returning its detached clone also prevents a caller from
 * changing nested source data while the transition is being evaluated.
 */
function validateTransitionSourceState(state: DelegationTransactionRecord): DelegationTransactionResult {
	try {
		const parsed = parseDelegationTransaction(state);
		return parsed.ok ? parsed : { ok: false, error: INVALID_TRANSITION_SOURCE_ERROR };
	} catch {
		return { ok: false, error: INVALID_TRANSITION_SOURCE_ERROR };
	}
}

function validateCas(state: DelegationTransactionRecord, input: DelegationCasInput): string | undefined {
	if (input.delegation_id !== state.delegation_id) return "delegation identity mismatch";
	if (input.contract_hash !== state.contract_hash) return "contract identity mismatch";
	if (!validIdentity(input.worker_identity) || !sameIdentity(input.worker_identity, state.worker_identity)) return "worker identity mismatch";
	if (input.expected_generation !== state.generation) return `generation CAS mismatch: expected ${input.expected_generation}, current ${state.generation}`;
	if (input.expected_revision !== state.revision) return `revision CAS mismatch: expected ${input.expected_revision}, current ${state.revision}`;
	if (!isIsoTime(input.now) || input.now < state.updated_at) return "transition time must be canonical ISO-8601 and monotonic";
	return undefined;
}

function nextState(
	state: DelegationTransactionRecord,
	now: string,
	patch: Partial<DelegationTransactionRecord>,
): DelegationTransactionRecord {
	return cloneState({ ...state, ...patch, revision: state.revision + 1, updated_at: now });
}

export function createPreparedDelegationTransaction(
	input: PrepareDelegationTransactionInput,
): DelegationTransactionResult {
	if (!DELEGATION_TRANSACTION_ID_RE.test(input.delegation_id)) return { ok: false, error: "invalid delegation id" };
	if (!isTaskKind(input.task_kind)) return { ok: false, error: `task_kind ${JSON.stringify(input.task_kind)} is not enabled in Stage 1` };
	if (!DELEGATION_TRANSACTION_HASH_RE.test(input.contract_hash)) return { ok: false, error: "contract_hash must be a lowercase sha256" };
	if (!validIdentity(input.worker_identity)) return { ok: false, error: `worker identity must be ${WORKER_PROVIDER}/${WORKER_MODEL_ID} with a valid worker_id` };
	if (!isPositiveInteger(input.generation)) return { ok: false, error: "generation must be a positive safe integer" };
	if (!isIsoTime(input.now)) return { ok: false, error: "now must be canonical ISO-8601" };
	const allowedPaths = Array.isArray(input.allowed_paths) ? [...input.allowed_paths] : [];
	if (allowedPaths.length === 0 || allowedPaths.length > DELEGATION_TRANSACTION_MAX_ALLOWED_PATHS || !allowedPaths.every(isAllowedPathRule)) {
		return { ok: false, error: "allowed_paths must contain only bounded project-relative path rules" };
	}
	allowedPaths.sort();
	if (!isSortedUnique(allowedPaths)) return { ok: false, error: "allowed_paths must be unique" };
	return {
		ok: true,
		state: {
			schema_version: DELEGATION_TRANSACTION_SCHEMA_VERSION,
			delegation_id: input.delegation_id,
			task_kind: input.task_kind,
			contract_hash: input.contract_hash,
			allowed_paths: allowedPaths,
			worker_identity: cloneIdentity(input.worker_identity),
			generation: input.generation,
			revision: 0,
			status: "PREPARED",
			created_at: input.now,
			updated_at: input.now,
			postcondition_reasons: [],
			terminal_outcome: null,
			committed_proof: null,
			review: null,
			abort_reason: null,
			recovery_reason: null,
		},
	};
}

export function startDelegationTransaction(
	state: DelegationTransactionRecord,
	input: DelegationCasInput,
): DelegationTransactionResult {
	const source = validateTransitionSourceState(state);
	if (!source.ok) return source;
	state = source.state;
	const casError = validateCas(state, input);
	if (casError) return { ok: false, error: casError };
	if (state.status !== "PREPARED") return { ok: false, error: `cannot start delegation from ${state.status}` };
	return { ok: true, state: nextState(state, input.now, { status: "RUNNING" }) };
}

export function beginDelegationCommit(
	state: DelegationTransactionRecord,
	input: BeginDelegationCommitInput,
): DelegationTransactionResult {
	const source = validateTransitionSourceState(state);
	if (!source.ok) return source;
	state = source.state;
	const casError = validateCas(state, input);
	if (casError) return { ok: false, error: casError };
	if (state.status !== "RUNNING") return { ok: false, error: `cannot begin commit from ${state.status}` };
	if (!validOutcome(input.outcome)) return { ok: false, error: "invalid terminal outcome facts" };
	if (input.outcome.delegation_id !== state.delegation_id || input.outcome.task_kind !== state.task_kind) {
		return { ok: false, error: "terminal outcome delegation/task identity mismatch" };
	}
	if (!sameIdentity(input.outcome.worker_identity, state.worker_identity)) return { ok: false, error: "terminal outcome worker identity mismatch" };
	const outcome = cloneOutcome(input.outcome);
	return {
		ok: true,
		state: nextState(state, input.now, {
			status: "COMMITTING",
			terminal_outcome: outcome,
			postcondition_reasons: evaluateDelegationPostconditions(state, outcome),
		}),
	};
}

export function publishDelegationCommit(
	state: DelegationTransactionRecord,
	input: PublishDelegationCommitInput,
): DelegationTransactionResult {
	const source = validateTransitionSourceState(state);
	if (!source.ok) return source;
	state = source.state;
	const casError = validateCas(state, input);
	if (casError) return { ok: false, error: casError };
	if (state.status !== "COMMITTING" || state.terminal_outcome === null) return { ok: false, error: `cannot publish commit from ${state.status}` };
	if (!validProof(input.proof)) return { ok: false, error: "committed generation proof is incomplete, corrupt, or has an unknown record set" };
	const proof = input.proof;
	if (proof.delegation_id !== state.delegation_id || proof.task_kind !== state.task_kind || proof.contract_hash !== state.contract_hash || !sameIdentity(proof.worker_identity, state.worker_identity)) {
		return { ok: false, error: "committed generation proof identity mismatch" };
	}
	if (proof.generation !== state.generation || proof.revision !== state.revision) {
		return { ok: false, error: "committed generation proof generation/revision mismatch" };
	}
	let status: DelegationTransactionStatus;
	if (!state.terminal_outcome.terminal_facts_complete || !state.terminal_outcome.scope_complete) {
		status = "RECOVERY_REQUIRED";
	} else if (state.postcondition_reasons.length > 0) {
		status = "FAILED";
	} else {
		status = state.task_kind === "implementation" ? "PENDING_REVIEW" : "FINISHED";
	}
	return {
		ok: true,
		state: nextState(state, input.now, {
			status,
			committed_proof: cloneProof(proof),
			recovery_reason: status === "RECOVERY_REQUIRED" ? "committed terminal or scope facts are incomplete" : null,
		}),
	};
}

export function reviewDelegationTransaction(
	state: DelegationTransactionRecord,
	input: ReviewDelegationTransactionInput,
): DelegationTransactionResult {
	const source = validateTransitionSourceState(state);
	if (!source.ok) return source;
	state = source.state;
	const casError = validateCas(state, input);
	if (casError) return { ok: false, error: casError };
	if (state.status !== "PENDING_REVIEW" || state.task_kind !== "implementation" || state.committed_proof === null) {
		return { ok: false, error: `cannot review delegation from ${state.status}` };
	}
	if (!DELEGATION_TRANSACTION_HASH_RE.test(input.review_hash)) return { ok: false, error: "review_hash must be a lowercase sha256" };
	return {
		ok: true,
		state: nextState(state, input.now, {
			status: "REVIEWED",
			review: {
				delegation_id: state.delegation_id,
				generation: state.generation,
				transaction_revision: state.revision,
				review_hash: input.review_hash,
				reviewed_at: input.now,
				reviewer: "sol",
			},
		}),
	};
}

export function abortDelegationTransaction(
	state: DelegationTransactionRecord,
	input: StopDelegationTransactionInput,
): DelegationTransactionResult {
	const source = validateTransitionSourceState(state);
	if (!source.ok) return source;
	state = source.state;
	const casError = validateCas(state, input);
	if (casError) return { ok: false, error: casError };
	if (state.status !== "PREPARED" && state.status !== "RUNNING") return { ok: false, error: `cannot abort delegation from ${state.status}` };
	if (!validReasonText(input.reason)) return { ok: false, error: "abort reason must be a non-empty bounded string" };
	return { ok: true, state: nextState(state, input.now, { status: "ABORTED", abort_reason: input.reason }) };
}

export function requireDelegationRecovery(
	state: DelegationTransactionRecord,
	input: StopDelegationTransactionInput,
): DelegationTransactionResult {
	const source = validateTransitionSourceState(state);
	if (!source.ok) return source;
	state = source.state;
	const casError = validateCas(state, input);
	if (casError) return { ok: false, error: casError };
	if (state.status !== "RUNNING" && state.status !== "COMMITTING") return { ok: false, error: `cannot require recovery from ${state.status}` };
	if (!validReasonText(input.reason)) return { ok: false, error: "recovery reason must be a non-empty bounded string" };
	return { ok: true, state: nextState(state, input.now, { status: "RECOVERY_REQUIRED", recovery_reason: input.reason }) };
}
