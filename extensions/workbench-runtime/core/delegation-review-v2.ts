/**
 * Strict implementation-review adapter for delegation transactions v2.
 * Immutable generation authority is resolved before any mutable review file
 * is read or written; no v1 fallback exists in this module.
 */

import { posix } from "node:path";

import { canonicalHash } from "../cache/canonical-hash.ts";
import {
	collectReviewBoundDiffHash,
	DEFAULT_REVIEW_MAX_BYTES,
	DEFAULT_REVIEW_MAX_LINES,
	isReviewPresentationFullyVisible,
	isScopeIntegrityPacketComplete,
	validateReviewPresentationAgainstAuthority,
	isStrictSemanticAcceptedOrZeroDelta,
	renderReviewLines,
	reviewDelegationFromAuthority,
	type ReviewAuthorityFacts,
	type ReviewRecord,
	type ReviewResult,
} from "./diff-review.ts";
import { computeDiffHash, type GitFacts } from "./delegation-ledger.ts";
import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import {
	validateDelegationCommandProvenance,
	type DelegationCommandProvenanceRecord,
} from "./delegation-command-effect-provenance.ts";
import { DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2 } from "./delegation-workspace-v2.ts";
import {
	collectReviewRelevanceV2,
	computeReviewRelevanceConflictHashV2,
	computeReviewRelevanceProjectionHashV2,
	REVIEW_RELEVANCE_KIND_V2,
	validateReviewRelevanceProjectionV2,
	type CollectedReviewRelevanceV2,
	type ReviewRelevanceProjectionV2,
} from "./review-relevance-v2.ts";
import { validateWorkspaceGuard, type WorkspaceGuardRecord } from "./workspace-guard.ts";
import {
	bindDelegationBoundedTaskContractV2,
	type DelegationBoundedTaskContractBindingV2,
} from "./delegation-transaction-artifacts.ts";
import {
	delegationReviewRelativePathV2,
	hasDelegationSemanticRepairAuthorityV2,
	hasDelegationSemanticReviewAuthorityV2,
	hasDelegationTerminalNegativeSemanticRepairAuthorityV1,
	isDelegationTerminalNegativeReviewEligibleFromCommittedV1,
	isDelegationTerminalNegativeReviewEligibleV1,
	persistDelegationReviewProvisionalV2,
	persistDelegationTerminalNegativeReviewProvisionalV1,
	publishDelegationSemanticRepairDecisionV1,
	publishDelegationTerminalNegativeRepairDecisionV1,
	publishHistoricalSemanticMigrationAcceptanceV2,
	publishHistoricalSemanticMigrationPresentationV2,
	publishDelegationReviewV2,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTerminalNegativeReviewV1,
	type DelegationCommittedGenerationV2,
	type DelegationReviewAuthorityV2,
	type DelegationReviewArtifactV2,
	type DelegationTerminalNegativeReviewAuthorityV1,
	type DelegationTransactionStorageOptions,
} from "./delegation-transaction-storage.ts";
import {
	collectHistoricalSemanticMigration,
	type HistoricalSemanticMigrationProjection,
} from "./historical-semantic-migration.ts";
import {
	DELEGATION_TRANSACTION_HASH_RE,
	isCurrentDelegationTerminalOutcome,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import type { ExecFn } from "./config.ts";
import { isWorkerPathAllowedRealpath } from "../worker/path-scope.ts";
import { COMMANDER_MODEL_ID, COMMANDER_PROVIDERS } from "./worker-policy.ts";
import {
	validateSemanticReviewEnvelopeV1,
	type SemanticReviewEnvelopeV1,
} from "./semantic-review-envelope.ts";

const AFTER_FIELDS = [
	"schema_version", "delegation_id", "recorded_at", "status", "exit_code", "pinned_identity",
	"git_head", "git_dirty", "diff_hash", "changed_paths", "path_statuses", "path_digests",
	"changed_since_before", "workspace_guard", "change_set_status", "worker_delta_hash", "workspace_guard_hash",
	"change_set_hash", "reported_paths", "usage", "budget", "report_summary", "review_status",
] as const;
const AFTER_FIELDS_GUARD_V2 = [...AFTER_FIELDS, "diff_identity_kind"] as const;
const AFTER_FIELDS_GUARD_V2_ENVELOPE = [...AFTER_FIELDS_GUARD_V2, "review_envelope"] as const;
const AFTER_FIELDS_GUARD_V2_COMMAND = [...AFTER_FIELDS_GUARD_V2, "command_provenance_hash", "effective_delta_hash"] as const;
const AFTER_FIELDS_GUARD_V2_COMMAND_ENVELOPE = [...AFTER_FIELDS_GUARD_V2_COMMAND, "review_envelope"] as const;
const AFTER_WORKER_OUTCOME_FIELDS = ["worker_success", "worker_failure_code"] as const;
const BEFORE_FIELDS = [
	"schema_version", "delegation_id", "recorded_at", "contract", "git_head", "git_dirty",
	"diff_hash", "changed_paths", "path_statuses", "path_digests", "workspace_guard",
] as const;
const BEFORE_FIELDS_GUARD_V2 = [...BEFORE_FIELDS, "diff_identity_kind"] as const;
const CONTRACT_REQUIRED_FIELDS = [
	"task_kind", "task", "allowed_paths", "acceptance_criteria", "verification", "timeout_seconds",
	"budget_profile", "contract_hash",
] as const;
const IDENTITY_FIELDS = [
	"schema_version", "delegation_id", "task_kind", "contract_hash", "generation", "revision", "worker_identity",
] as const;
const SCOPE_FIELDS = [
	"schema_version", "delegation_id", "task_kind", "contract_hash", "allowed_paths", "changed_paths",
	"write_journal", "change_set",
] as const;
const SCOPE_FIELDS_WITH_COMMAND = [...SCOPE_FIELDS, "command_provenance"] as const;

export type DelegationReviewV2ErrorCode =
	| "authority_invalid"
	| "invalid_state"
	| "review_invalid"
	| "review_conflict"
	| "semantic_acceptance_required"
	| "storage_failure";

export interface DelegationReviewV2Success {
	ok: true;
	review: ReviewResult;
	transaction: DelegationTransactionRecord;
	review_hash: string;
	review_path: string;
	finalized: boolean;
	semantic_authority?: "embedded" | "migration_presented" | "migration_accepted" | "not_required" | "repair_required" | "terminal_repair_required";
	migration_binding_hash?: string;
	repair_decision_hash?: string;
	repair_reason_hash?: string;
}

export interface DelegationReviewV2Failure {
	ok: false;
	error: { code: DelegationReviewV2ErrorCode; message: string };
	review?: ReviewResult;
	transaction?: DelegationTransactionRecord;
	binding_hash?: string;
}

export type DelegationReviewV2Result = DelegationReviewV2Success | DelegationReviewV2Failure;

export interface ReviewDelegationV2Input {
	projectRoot: string;
	delegationId: string;
	exec: ExecFn;
	includePaths?: readonly string[];
	maxLines?: number;
	maxBytes?: number;
	secrets?: readonly string[];
	now?: string;
	/** Explicit Sol decision.  Omission performs scope/integrity presentation only. */
	semanticDecision?: "ACCEPT" | "REPAIR";
	/** Exact hash shown in the prior complete provisional packet. */
	expectedBoundDiffHash?: string;
	/** Exact historical migration binding shown by the preceding presentation call. */
	expectedMigrationBindingHash?: string;
	/** Bounded Sol-authored reason persisted only for an explicit REPAIR decision. */
	repairReason?: string;
	/** Runtime-validated active commander identity, required for ACCEPT. */
	reviewer?: { provider: string; model: string };
	/** Runtime model identity used to bind a historical migration presentation. */
	presenter?: { provider: string; model: string };
	storage?: DelegationTransactionStorageOptions;
}

function fail(
	code: DelegationReviewV2ErrorCode,
	message: string,
	details?: Pick<DelegationReviewV2Failure, "review" | "transaction" | "binding_hash">,
): DelegationReviewV2Failure {
	return { ok: false, error: { code, message: message.slice(0, 240) }, ...details };
}

function validSolIdentity(value: { provider: string; model: string } | undefined): value is {
	provider: "openai" | "openai-codex";
	model: "gpt-5.6-sol";
} {
	return value !== undefined && COMMANDER_PROVIDERS.includes(value.provider as (typeof COMMANDER_PROVIDERS)[number]) &&
		value.model === COMMANDER_MODEL_ID;
}

function validRepairReason(value: unknown): value is string {
	return typeof value === "string" && value === value.trim() && value.length > 0 &&
		Buffer.byteLength(value, "utf8") <= 1_024 && !value.includes("\0");
}

function historicalMigrationLines(projection: HistoricalSemanticMigrationProjection, accepted: boolean): string[] {
	return [
		`semantic migration: ${accepted ? "ACCEPTED" : "REQUIRED"} — upgrade-era mechanical FINAL; historical files remain immutable`,
		`migration old head: ${projection.old_git_head}`,
		`migration new head: ${projection.candidate_git_head}`,
		`migration head delta: ${projection.head_delta_paths.length} path(s); raw hash ${projection.head_delta_hash}`,
		...projection.head_delta_paths.map((path) => `  - ${JSON.stringify(path)}`),
		`migration W/D/S content: ${projection.closed_content_hash}`,
		`migration baseline guard: ${projection.baseline_guard_hash}`,
		`migration binding: ${projection.migration_binding_hash}`,
		accepted
			? "migration decision: ACCEPTED by explicit Sol decision bound to both hashes"
			: "migration decision: after inspecting this entire packet, ACCEPT must bind both the packet hash and migration binding",
	];
}

function sameMigrationProjection(left: HistoricalSemanticMigrationProjection, right: HistoricalSemanticMigrationProjection): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function historicalMigrationConflictHash(input: {
	delegationId: string;
	acceptedBindingHash: string;
	current: string;
	path?: string;
}): string {
	return canonicalHash({
		schema_version: 1,
		kind: "historical-semantic-migration-conflict-v1",
		delegation_id: input.delegationId,
		accepted_binding_hash: input.acceptedBindingHash,
		current: input.current,
		...(input.path === undefined ? {} : { path: input.path }),
	});
}

function renderHistoricalMigrationPacket(
	record: ReviewRecord,
	projection: HistoricalSemanticMigrationProjection,
	accepted: boolean,
	maxBytes: number | undefined,
	maxLines: number | undefined,
): ReviewResult | undefined {
	const lines = historicalMigrationLines(projection, accepted);
	const lineCap = maxLines ?? DEFAULT_REVIEW_MAX_LINES;
	const byteCap = maxBytes ?? DEFAULT_REVIEW_MAX_BYTES;
	const manifestBytes = Buffer.byteLength(lines.join("\n"), "utf8") + 1;
	const reviewCaps = { maxLines: lineCap - lines.length, maxBytes: byteCap - manifestBytes };
	if (reviewCaps.maxLines < 16 || reviewCaps.maxBytes < 1024 || !isReviewPresentationFullyVisible(record, reviewCaps)) {
		return undefined;
	}
	return { ok: true, record, lines: [...lines, ...renderReviewLines(record, reviewCaps)] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], optional: readonly string[] = []): boolean {
	const expected = [...fields, ...optional.filter((field) => Object.prototype.hasOwnProperty.call(value, field))];
	const actual = Object.keys(value).sort();
	expected.sort();
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
	try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function isCanonicalTime(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 20 || value.length > 32) return false;
	try { return new Date(value).toISOString() === value; } catch { return false; }
}

function isStrictPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 400 || value !== value.trim() ||
		value.includes("\\") || value.includes("\0") || value.startsWith("/")) return false;
	const normalized = posix.normalize(value);
	return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

function validPaths(value: unknown, max = 500): value is string[] {
	return Array.isArray(value) && value.length <= max && value.every(isStrictPath) &&
		value.every((path, index) => index === 0 || value[index - 1]! < path);
}

function validByteSortedPaths(value: unknown, max = 500): value is string[] {
	return Array.isArray(value) && value.length <= max && value.every(isStrictPath) &&
		value.every((path, index) => index === 0 || Buffer.from(value[index - 1]!, "utf8").compare(Buffer.from(path, "utf8")) < 0);
}

function validGitRecord(value: Record<string, unknown>, after: boolean): GitFacts | undefined {
	if ((value.git_head !== null && (typeof value.git_head !== "string" || !/^[a-f0-9]{40,64}$/.test(value.git_head))) ||
		typeof value.git_dirty !== "boolean" || !validPaths(value.changed_paths) ||
		!isRecord(value.path_statuses) || !isRecord(value.path_digests)) return undefined;
	const changedPaths = value.changed_paths as string[];
	if (value.git_dirty !== (changedPaths.length > 0) || !sameJson(Object.keys(value.path_statuses).sort(), changedPaths) ||
		!Object.values(value.path_statuses).every((status) => typeof status === "string" && status.length > 0 && status.length <= 4) ||
		!Object.keys(value.path_digests).every((path) => changedPaths.includes(path)) ||
		!Object.values(value.path_digests).every((digest) => typeof digest === "string" && /^[a-f0-9]{64}(?::\d+)?$/.test(digest))) return undefined;
	const facts: GitFacts = {
		gitHead: value.git_head as string | null,
		gitDirty: value.git_dirty,
		changedPaths: [...changedPaths],
		pathStatuses: { ...value.path_statuses } as Record<string, string>,
		pathDigests: { ...value.path_digests } as Record<string, string>,
	};
	const calculated = computeDiffHash(facts.changedPaths, facts.pathDigests, facts.pathStatuses);
	if (value.diff_hash !== calculated || (after && !DELEGATION_TRANSACTION_HASH_RE.test(String(value.diff_hash)))) return undefined;
	return facts;
}

function validAfterGitRecord(value: Record<string, unknown>): GitFacts | undefined {
	if (!isRecord(value.workspace_guard) || !Array.isArray(value.workspace_guard.entries)) return undefined;
	const fullPaths = value.workspace_guard.entries.map((entry) => isRecord(entry) ? entry.path : undefined);
	if (!validByteSortedPaths(fullPaths)) return undefined;
	const legacyOrderedPaths = [...fullPaths].sort();
	return validGitRecord({ ...value, changed_paths: legacyOrderedPaths }, true);
}

interface GenerationReviewAuthority {
	kind: "legacy-v2" | "guard-v2";
	contract: DelegationBoundedTaskContractBindingV2;
	authority: ReviewAuthorityFacts;
	after_guard: WorkspaceGuardRecord;
	change_set: ChangeSetRecord;
	command_provenance?: DelegationCommandProvenanceRecord;
	review_envelope?: SemanticReviewEnvelopeV1;
}

function authorityFromGeneration(generation: DelegationCommittedGenerationV2): GenerationReviewAuthority | undefined {
	const state = generation.state;
	const ordinaryReview = state.status === "PENDING_REVIEW" || state.status === "REVIEWED";
	const terminalNegativeReview = isDelegationTerminalNegativeReviewEligibleFromCommittedV1(state, generation.records);
	if (state.task_kind !== "implementation" || state.terminal_outcome === null || state.committed_proof === null ||
		(!ordinaryReview && !terminalNegativeReview)) return undefined;
	const before = generation.records["before.json"];
	const after = generation.records["after.json"];
	const identity = generation.records["identity.json"];
	const scope = generation.records["scope.json"];
	if (!isRecord(before) || !isRecord(after) ||
		!isRecord(identity) || !exactFields(identity, IDENTITY_FIELDS) || !isRecord(scope)
		|| !(exactFields(scope, SCOPE_FIELDS) || exactFields(scope, SCOPE_FIELDS_WITH_COMMAND))) return undefined;
	const guardV2 = before.diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2 ||
		after.diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2;
	const envelopeTagged = guardV2 && Object.prototype.hasOwnProperty.call(after, "review_envelope");
	const commandTagged = guardV2 && Object.prototype.hasOwnProperty.call(after, "command_provenance_hash");
	const hasWorkerSuccess = Object.prototype.hasOwnProperty.call(after, "worker_success");
	const hasWorkerFailure = Object.prototype.hasOwnProperty.call(after, "worker_failure_code");
	const currentOutcome = isCurrentDelegationTerminalOutcome(state.terminal_outcome);
	// Fresh generations close worker execution independently from provider
	// transport success. Historical generations remain readable only in their
	// exact legacy shape: both fields absent, never one field or a forged pair.
	if (hasWorkerSuccess !== hasWorkerFailure || hasWorkerSuccess !== currentOutcome) return undefined;
	const baseAfterFields = guardV2
		? commandTagged
			? (envelopeTagged ? AFTER_FIELDS_GUARD_V2_COMMAND_ENVELOPE : AFTER_FIELDS_GUARD_V2_COMMAND)
			: (envelopeTagged ? AFTER_FIELDS_GUARD_V2_ENVELOPE : AFTER_FIELDS_GUARD_V2)
		: AFTER_FIELDS;
	const expectedAfterFields = hasWorkerSuccess
		? [...baseAfterFields, ...AFTER_WORKER_OUTCOME_FIELDS]
		: baseAfterFields;
	if (guardV2
		? (!exactFields(before, BEFORE_FIELDS_GUARD_V2) || !exactFields(after, expectedAfterFields)
			|| before.diff_identity_kind !== DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2
			|| after.diff_identity_kind !== DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2)
		: (!exactFields(before, BEFORE_FIELDS) || !exactFields(after, expectedAfterFields))) return undefined;
	if (currentOutcome && (typeof after.worker_success !== "boolean" ||
		!(after.worker_failure_code === null || typeof after.worker_failure_code === "string") ||
		after.worker_success !== (after.worker_failure_code === null) ||
		after.worker_success !== state.terminal_outcome.worker_success ||
		after.worker_failure_code !== state.terminal_outcome.worker_failure_code ||
		after.status !== (after.worker_success ? "success" : "failure"))) return undefined;
	if (before.schema_version !== 2 || before.delegation_id !== state.delegation_id || !isCanonicalTime(before.recorded_at) ||
		after.schema_version !== 2 || after.delegation_id !== state.delegation_id || !isCanonicalTime(after.recorded_at) ||
		after.review_status !== "PENDING_REVIEW" || !validByteSortedPaths(after.changed_paths) ||
		!(guardV2 ? validByteSortedPaths(after.changed_since_before) : validPaths(after.changed_since_before)) || !validPaths(after.reported_paths) ||
		!isRecord(before.workspace_guard) || !isRecord(after.workspace_guard)) return undefined;
	const contract = before.contract;
	if (!isRecord(contract) || !exactFields(contract, CONTRACT_REQUIRED_FIELDS, ["repair_of", "plan_ref", "extended_reason"]) ||
		contract.task_kind !== state.task_kind || contract.contract_hash !== state.contract_hash ||
		!sameJson(contract.allowed_paths, state.allowed_paths)) return undefined;
	const { contract_hash: suppliedHash, ...contractPayload } = contract;
	const canonicalContract = bindDelegationBoundedTaskContractV2(contractPayload);
	if (!canonicalContract.ok || suppliedHash !== canonicalContract.value.contract_hash) return undefined;
	let afterFacts: GitFacts | undefined;
	if (guardV2) {
		if (!validateWorkspaceGuard(after.workspace_guard) || after.diff_hash !== (after.workspace_guard as WorkspaceGuardRecord).workspace_guard_hash
			|| !isRecord(after.path_statuses) || !isRecord(after.path_digests)
			|| !Object.entries(after.path_digests).every(([path, digest]) => (after.changed_paths as string[]).includes(path)
				&& typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest))) return undefined;
		afterFacts = {
			gitHead: after.git_head as string | null,
			gitDirty: (after.changed_paths as string[]).length > 0,
			changedPaths: [...after.changed_paths as string[]],
			pathStatuses: { ...after.path_statuses } as Record<string, string>,
			pathDigests: { ...after.path_digests } as Record<string, string>,
		};
	} else {
		const beforeFacts = validGitRecord(before, false);
		afterFacts = validAfterGitRecord(after);
		if (beforeFacts === undefined) return undefined;
	}
	if (afterFacts === undefined || !sameJson(after.changed_paths, state.terminal_outcome.changed_paths) ||
		(envelopeTagged && (!validateSemanticReviewEnvelopeV1(after.review_envelope) ||
			after.review_envelope.path_count !== (after.changed_paths as string[]).length))) return undefined;
	if (identity.schema_version !== 2 || identity.delegation_id !== state.delegation_id || identity.task_kind !== state.task_kind ||
		identity.contract_hash !== state.contract_hash || identity.generation !== state.generation ||
		identity.revision !== state.committed_proof.revision || !sameJson(identity.worker_identity, state.worker_identity)) return undefined;
	if (scope.schema_version !== 2 || scope.delegation_id !== state.delegation_id || scope.task_kind !== state.task_kind ||
		scope.contract_hash !== state.contract_hash || !sameJson(scope.allowed_paths, state.allowed_paths) ||
		!sameJson(scope.changed_paths, state.terminal_outcome.changed_paths) ||
		!isRecord(scope.write_journal) || !isRecord(scope.change_set) || !validateChangeSet(scope.change_set)) return undefined;
	const changeSet = scope.change_set as ChangeSetRecord;
	const commandProvenance = Object.prototype.hasOwnProperty.call(scope, "command_provenance")
		? scope.command_provenance as DelegationCommandProvenanceRecord
		: undefined;
	if (commandTagged !== (commandProvenance !== undefined)
		|| (commandProvenance !== undefined && (!validateDelegationCommandProvenance(commandProvenance, changeSet)
			|| after.command_provenance_hash !== commandProvenance.command_provenance_hash
			|| after.effective_delta_hash !== commandProvenance.effective_delta_hash))) return undefined;
	if (!validateWorkspaceGuard(after.workspace_guard)) return undefined;
	const afterGuard = after.workspace_guard as unknown as WorkspaceGuardRecord;
	return {
		kind: guardV2 ? "guard-v2" : "legacy-v2",
		contract: structuredClone(canonicalContract.value),
		after_guard: afterGuard,
		change_set: changeSet,
		...(commandProvenance === undefined ? {} : { command_provenance: commandProvenance }),
		...(envelopeTagged ? { review_envelope: structuredClone(after.review_envelope as SemanticReviewEnvelopeV1) } : {}),
		authority: {
			delegation_id: state.delegation_id,
			allowed_paths: [...state.allowed_paths],
			worker_paths: [...(after.changed_paths as string[])],
			recorded_after_hash: after.diff_hash as string,
			after: afterFacts,
			reported_paths: [...(after.reported_paths as string[])],
			...(envelopeTagged ? { review_envelope: structuredClone(after.review_envelope as SemanticReviewEnvelopeV1) } : {}),
		},
	};
}

function projectionFromReview(review: ReviewRecord | null): ReviewRelevanceProjectionV2 | undefined {
	if (review === null || review.schema_version !== 2 || review.diff_identity_kind !== REVIEW_RELEVANCE_KIND_V2 ||
		!validateReviewRelevanceProjectionV2(review.relevance_projection)) return undefined;
	return review.relevance_projection;
}

function authorityWithRelevance(
	base: ReviewAuthorityFacts,
	relevance: Readonly<Pick<CollectedReviewRelevanceV2, "binding" | "projection" | "worker_paths">>,
): ReviewAuthorityFacts {
	const worker = new Set(relevance.worker_paths);
	const pathStatuses: Record<string, string> = {};
	const pathDigests: Record<string, string> = {};
	for (const entry of relevance.projection.entries) {
		if (!worker.has(entry.path)) continue;
		pathStatuses[entry.path] = entry.status;
		if (entry.full_identity.kind === "file") pathDigests[entry.path] = entry.full_identity.sha256;
	}
	return {
		...base,
		recorded_after_hash: relevance.binding.projection_hash,
		current: {
			gitHead: relevance.projection.git_head,
			gitDirty: relevance.worker_paths.length > 0,
			changedPaths: [...relevance.worker_paths],
			pathStatuses,
			pathDigests,
		},
		current_diff_hash: relevance.binding.projection_hash,
		drift_paths: [],
		relevance_binding: relevance.binding,
		relevance_projection: relevance.projection,
	};
}

export type CommittedStructuredReviewAuthorityV2Result =
	| {
		ok: true;
		value: {
			contract: Readonly<DelegationBoundedTaskContractBindingV2>;
			authority: Readonly<ReviewAuthorityFacts>;
			review: Readonly<DelegationReviewArtifactV2["review"]>;
		};
	}
	| { ok: false; code: "INVALID_COMMITTED_AUTHORITY" | "LEGACY_REVIEW_REQUIRES_MIGRATION" | "LINEAGE_PRESENTATION_GAP" | "PROVISIONAL_REVIEW_INVALID" };

/**
 * A repair successor may close carried rejected paths that it did not touch
 * again. W/C is sufficient only when every carried path is present there;
 * generic D entries cannot prove rejected-lineage ownership.
 */
export function missingRepairLineageStructuredPresentationPathsV2(
	repairLineage: Readonly<DelegationTransactionRecord["repair_lineage"]>,
	projection: Readonly<ReviewRelevanceProjectionV2>,
): string[] | undefined {
	if (!validateReviewRelevanceProjectionV2(projection)) return undefined;
	if (repairLineage === undefined) return [];
	const presented = new Set(projection.entries
		.filter((entry) => entry.roles.includes("W") || entry.roles.includes("C"))
		.map((entry) => entry.path));
	return repairLineage.carried_paths.filter((path) => !presented.has(path));
}

/**
 * Reconstruct the storage-independent structured-review input exclusively
 * from a strictly verified committed generation and its strict durable
 * provisional review. This performs no I/O and grants no semantic authority.
 */
function committedStructuredReviewAuthorityForLifecycleV2(
	generation: Readonly<DelegationCommittedGenerationV2>,
	reviewAuthority: Readonly<DelegationReviewAuthorityV2>,
	lifecycle: "pending" | "terminal-negative",
): CommittedStructuredReviewAuthorityV2Result {
	try {
		const info = authorityFromGeneration(generation as DelegationCommittedGenerationV2);
		const lifecycleMatches = lifecycle === "pending"
			? generation.state.status === "PENDING_REVIEW" && reviewAuthority.state.status === "PENDING_REVIEW"
			: isDelegationTerminalNegativeReviewEligibleFromCommittedV1(generation.state, generation.records)
				&& (isDelegationTerminalNegativeReviewEligibleV1(reviewAuthority.state)
					|| reviewAuthority.terminal_negative_legacy_clean_command === true);
		if (info === undefined || !lifecycleMatches
			|| reviewAuthority.state.delegation_id !== generation.state.delegation_id
			|| reviewAuthority.state.contract_hash !== generation.state.contract_hash
			|| reviewAuthority.finalized) return { ok: false, code: "INVALID_COMMITTED_AUTHORITY" };
		if (info.kind !== "guard-v2") return { ok: false, code: "LEGACY_REVIEW_REQUIRES_MIGRATION" };
		const record = reviewAuthority.review;
		const binding = record.relevance_binding;
		const projection = record.relevance_projection;
		const envelope = record.review_envelope;
		if (record.schema_version !== 2 || record.delegation_id !== generation.state.delegation_id
			|| record.semantic_review !== "required" || record.semantic_acceptance !== undefined
			|| !validateReviewRelevanceProjectionV2(projection)
			|| projection.delegation_id !== generation.state.delegation_id
			|| projection.contract_hash !== generation.state.contract_hash
			|| binding === undefined || binding.projection_hash !== computeReviewRelevanceProjectionHashV2(projection)
			|| record.bound_diff_hash !== binding.projection_hash
			|| !validateSemanticReviewEnvelopeV1(envelope)
			|| envelope.relevance_projection_hash !== binding.projection_hash
			|| info.review_envelope === undefined || canonicalHash(info.review_envelope) !== canonicalHash(envelope)) {
			return { ok: false, code: "PROVISIONAL_REVIEW_INVALID" };
		}
		const effectivePaths = [...new Set(projection.entries
			.filter((entry) => entry.roles.includes("W") || entry.roles.includes("C"))
			.map((entry) => entry.path))]
			.sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")));
		const lineageGap = missingRepairLineageStructuredPresentationPathsV2(generation.state.repair_lineage, projection);
		if (lineageGap === undefined) return { ok: false, code: "PROVISIONAL_REVIEW_INVALID" };
		if (lineageGap.length > 0) return { ok: false, code: "LINEAGE_PRESENTATION_GAP" };
		if (!sameJson(effectivePaths, info.authority.worker_paths) || !sameJson(effectivePaths, record.checked_paths)
			|| envelope.path_count !== effectivePaths.length) return { ok: false, code: "PROVISIONAL_REVIEW_INVALID" };
		const authority = authorityWithRelevance(info.authority, {
			binding,
			projection,
			worker_paths: effectivePaths,
		});
		return {
			ok: true,
			value: {
				contract: Object.freeze(structuredClone(info.contract)),
				authority: Object.freeze({ ...authority, worker_paths: Object.freeze([...effectivePaths]) }),
				review: Object.freeze(structuredClone(record)),
			},
		};
	} catch {
		return { ok: false, code: "INVALID_COMMITTED_AUTHORITY" };
	}
}

export function committedStructuredReviewAuthorityV2(
	generation: Readonly<DelegationCommittedGenerationV2>,
	reviewAuthority: Readonly<DelegationReviewAuthorityV2>,
): CommittedStructuredReviewAuthorityV2Result {
	return committedStructuredReviewAuthorityForLifecycleV2(generation, reviewAuthority, "pending");
}

/** REPAIR-only structured authority for a committed terminal-negative parent. */
export function committedTerminalNegativeStructuredReviewAuthorityV1(
	generation: Readonly<DelegationCommittedGenerationV2>,
	reviewAuthority: Readonly<DelegationTerminalNegativeReviewAuthorityV1>,
): CommittedStructuredReviewAuthorityV2Result {
	return committedStructuredReviewAuthorityForLifecycleV2(generation, reviewAuthority, "terminal-negative");
}

function relevanceConflictHash(
	state: DelegationTransactionRecord,
	changeSet: ChangeSetRecord,
	error: { code: string; path?: string },
): string | undefined {
	if (!["head_conflict", "relevant_conflict", "unknown_origin", "binding_conflict"].includes(error.code)) return undefined;
	return computeReviewRelevanceConflictHashV2({
		delegation_id: state.delegation_id,
		contract_hash: state.contract_hash,
		change_set_hash: changeSet.change_set_hash,
		error_code: error.code as "head_conflict" | "relevant_conflict" | "unknown_origin" | "binding_conflict",
		...(error.path === undefined ? {} : { path: error.path }),
	});
}

async function workerScopeIsSafeBeforeContent(
	projectRoot: string,
	workerPaths: readonly string[],
	allowedPaths: readonly string[],
): Promise<boolean> {
	for (const path of workerPaths) {
		if (!(await isWorkerPathAllowedRealpath(projectRoot, path, allowedPaths))) return false;
	}
	return true;
}

function artifactFor(state: DelegationTransactionRecord, reviewedAt: string, review: ReviewRecord): DelegationReviewArtifactV2 {
	// The shared renderer intentionally uses optional `compact: undefined`
	// properties in its in-memory patch entries.  Canonical JSON omits those
	// properties; normalize the detached copy before strict storage parsing so
	// the object being validated is exactly the object whose bytes are hashed.
	const canonicalReview = JSON.parse(JSON.stringify(review)) as ReviewRecord;
	return {
		schema_version: 2,
		delegation_id: state.delegation_id,
		task_kind: "implementation",
		contract_hash: state.contract_hash,
		worker_identity: { ...state.worker_identity },
		generation: state.generation,
		transaction_revision: 3,
		reviewed_at: reviewedAt,
		review: canonicalReview,
	};
}

/** Public fail-closed v2 review boundary. */
export async function reviewDelegationV2(input: ReviewDelegationV2Input): Promise<DelegationReviewV2Result> {
	try {
		const semanticDecisionSupplied = input.semanticDecision !== undefined || input.expectedBoundDiffHash !== undefined ||
			input.expectedMigrationBindingHash !== undefined || input.repairReason !== undefined || input.reviewer !== undefined;
		const acceptDecision = input.semanticDecision === "ACCEPT";
		const repairDecision = input.semanticDecision === "REPAIR";
		const commonDecisionValid = typeof input.expectedBoundDiffHash === "string" &&
			DELEGATION_TRANSACTION_HASH_RE.test(input.expectedBoundDiffHash) && validSolIdentity(input.reviewer);
		const decisionShapeValid = acceptDecision
			? commonDecisionValid && input.repairReason === undefined &&
				(input.expectedMigrationBindingHash === undefined || DELEGATION_TRANSACTION_HASH_RE.test(input.expectedMigrationBindingHash))
			: repairDecision
				? commonDecisionValid && input.expectedMigrationBindingHash === undefined && validRepairReason(input.repairReason)
				: !semanticDecisionSupplied;
		if (!decisionShapeValid) {
			return fail("review_invalid", "semantic decision requires an exact bound hash, active Sol identity, and decision-specific fields");
		}
		// Required ordering: immutable committed-generation authority is always
		// resolved before the mutable v2 review path is inspected.
		const generation = await readDelegationCommittedGenerationV2(input.projectRoot, input.delegationId, input.storage);
		if (!generation.ok) return fail("authority_invalid", "delegation committed-generation authority is unavailable");
		const state = generation.value.state;
		const terminalNegative = isDelegationTerminalNegativeReviewEligibleFromCommittedV1(state, generation.value.records);
		if (acceptDecision && terminalNegative) {
			return fail("invalid_state", "terminal-negative delegations can never publish semantic ACCEPT or ordinary REVIEWED authority", { transaction: state });
		}
		if (repairDecision && state.status !== "PENDING_REVIEW" && !terminalNegative) {
			return fail("invalid_state", "semantic REPAIR requires a current provisional or eligible terminal-negative implementation", { transaction: state });
		}
		const authorityInfo = authorityFromGeneration(generation.value);
		if (authorityInfo === undefined) return fail("invalid_state", "delegation is not a strictly bound implementation review", { transaction: state });
		const reviewPath = delegationReviewRelativePathV2(state.delegation_id);
		if (reviewPath === undefined) return fail("authority_invalid", "delegation review path is invalid", { transaction: state });
		if (authorityInfo.kind === "guard-v2" && !(await workerScopeIsSafeBeforeContent(
			input.projectRoot,
			authorityInfo.authority.worker_paths,
			authorityInfo.authority.allowed_paths,
		))) {
			return fail("review_invalid", "delegation worker path fails the parent-approved realpath scope", { transaction: state });
		}

		if (state.status === "REVIEWED") {
			const existing = await readDelegationReviewV2(input.projectRoot, state.delegation_id, input.storage);
			if (!existing.ok || !existing.value.finalized) return fail("authority_invalid", "finalized review authority is unavailable", { transaction: state });
			const historicalSemanticMigrationRequired = existing.value.review.schema_version === 2 &&
				existing.value.review.checked_paths.length > 0 && !isStrictSemanticAcceptedOrZeroDelta(existing.value.review);
			if (historicalSemanticMigrationRequired) {
				if (authorityInfo.kind !== "guard-v2") {
					return fail("authority_invalid", "historical review is not eligible for schema-2 semantic migration", { transaction: state });
				}
				const candidate = await collectHistoricalSemanticMigration({
					projectRoot: input.projectRoot,
					delegationId: state.delegation_id,
					contractHash: state.contract_hash,
					baseReviewHash: existing.value.review_hash,
					review: existing.value.review,
					afterGuard: authorityInfo.after_guard,
					exec: input.exec,
				});
				if (!candidate.ok) {
					const acceptedMigration = existing.value.semantic_migration?.status === "ACCEPTED"
						? existing.value.semantic_migration
						: undefined;
					if (acceptedMigration !== undefined) {
						return fail(
							"review_conflict",
							`accepted historical semantic migration is stale because current authority is ${candidate.code}${candidate.path === undefined ? "" : ` at ${candidate.path}`}; start a fresh successor delegation`,
							{
								transaction: state,
								binding_hash: historicalMigrationConflictHash({
									delegationId: state.delegation_id,
									acceptedBindingHash: acceptedMigration.migration_projection.migration_binding_hash,
									current: candidate.code,
									...(candidate.path === undefined ? {} : { path: candidate.path }),
								}),
							},
						);
					}
					return fail(
						"semantic_acceptance_required",
						`historical semantic migration is blocked by ${candidate.code}${candidate.path === undefined ? "" : ` at ${candidate.path}`}; no worker repair or ordinary successor may erase this authority`,
						{ transaction: state },
					);
				}
				const packet = renderHistoricalMigrationPacket(
					existing.value.review,
					candidate.projection,
					semanticDecisionSupplied || existing.value.semantic_migration?.status === "ACCEPTED",
					input.maxBytes,
					input.maxLines,
				);
				if (packet === undefined) {
					return fail("review_invalid", "historical migration packet does not fit the authorized complete presentation envelope", { transaction: state });
				}
				const now = input.now ?? new Date().toISOString();
				const migrationPresenter = validSolIdentity(input.presenter) ? input.presenter : undefined;
				if (!semanticDecisionSupplied && migrationPresenter === undefined) {
					return fail("review_invalid", "historical migration presentation requires the active Sol commander", { transaction: state });
				}
				const common = {
					delegation_id: state.delegation_id,
					contract_hash: state.contract_hash,
					worker_identity: state.worker_identity,
					expected_generation: state.generation,
					expected_revision: 4 as const,
					now,
					base_review_hash: existing.value.review_hash,
					expected_bound_diff_hash: existing.value.review.bound_diff_hash,
					projection: candidate.projection,
				};
				let priorMigration = existing.value.semantic_migration;
				if (priorMigration !== undefined && !sameMigrationProjection(priorMigration.migration_projection, candidate.projection)) {
					if (priorMigration.status === "ACCEPTED") {
						return fail("review_conflict", "accepted historical semantic migration binding is stale; start a fresh successor delegation", {
							transaction: state,
							binding_hash: historicalMigrationConflictHash({
								delegationId: state.delegation_id,
								acceptedBindingHash: priorMigration.migration_projection.migration_binding_hash,
								current: candidate.projection.migration_binding_hash,
							}),
						});
					}
					if (semanticDecisionSupplied) {
						return fail("review_conflict", "historical migration projection changed after presentation; present the current packet before ACCEPT", {
							transaction: state,
							binding_hash: candidate.projection.migration_binding_hash,
						});
					}
					priorMigration = undefined;
				}
				if (priorMigration?.status === "ACCEPTED") {
					const acceptance = priorMigration.acceptance;
					if (semanticDecisionSupplied && (
						input.expectedBoundDiffHash !== acceptance.expected_bound_diff_hash ||
						input.expectedMigrationBindingHash !== acceptance.expected_migration_binding_hash ||
						!validSolIdentity(input.reviewer) || input.reviewer.provider !== acceptance.reviewer.provider ||
						input.reviewer.model !== acceptance.reviewer.model
					)) return fail("review_conflict", "semantic migration ACCEPT replay does not match immutable authority", { transaction: state });
					return {
						ok: true,
						review: packet,
						transaction: state,
						review_hash: existing.value.review_hash,
						review_path: existing.value.review_path,
						finalized: true,
						semantic_authority: "migration_accepted",
						migration_binding_hash: candidate.projection.migration_binding_hash,
					};
				}
				if (!semanticDecisionSupplied) {
					if (priorMigration?.status === "PRESENTED") {
						return {
							ok: true,
							review: packet,
							transaction: state,
							review_hash: existing.value.review_hash,
							review_path: existing.value.review_path,
							finalized: true,
							semantic_authority: "migration_presented",
							migration_binding_hash: candidate.projection.migration_binding_hash,
						};
					}
					const presented = await publishHistoricalSemanticMigrationPresentationV2(input.projectRoot, {
						...common,
						presenter: migrationPresenter!,
					}, input.storage);
					if (!presented.ok) return fail(presented.error.code === "storage_failure" ? "storage_failure" : "review_conflict", presented.error.message, { transaction: state });
					return {
						ok: true,
						review: packet,
						transaction: state,
						review_hash: existing.value.review_hash,
						review_path: existing.value.review_path,
						finalized: true,
						semantic_authority: presented.value.status === "ACCEPTED" ? "migration_accepted" : "migration_presented",
						migration_binding_hash: candidate.projection.migration_binding_hash,
					};
				}
				if (input.expectedMigrationBindingHash === undefined) {
					return fail("review_invalid", "historical migration ACCEPT requires expected_migration_binding_hash from the preceding complete presentation", { transaction: state });
				}
				if (input.expectedBoundDiffHash !== existing.value.review.bound_diff_hash ||
					input.expectedMigrationBindingHash !== candidate.projection.migration_binding_hash || !validSolIdentity(input.reviewer)) {
					return fail("review_conflict", "historical migration ACCEPT does not match the current packet, migration binding, or Sol identity", { transaction: state });
				}
				const accepted = await publishHistoricalSemanticMigrationAcceptanceV2(input.projectRoot, {
					...common,
					expected_migration_binding_hash: input.expectedMigrationBindingHash,
					reviewer: input.reviewer,
				}, input.storage);
				if (!accepted.ok) return fail(accepted.error.code === "storage_failure" ? "storage_failure" : "review_conflict", accepted.error.message, { transaction: state });
				return {
					ok: true,
					review: packet,
					transaction: state,
					review_hash: existing.value.review_hash,
					review_path: existing.value.review_path,
					finalized: true,
					semantic_authority: "migration_accepted",
					migration_binding_hash: candidate.projection.migration_binding_hash,
				};
			}
			if (input.expectedMigrationBindingHash !== undefined) {
				return fail("review_invalid", "expected_migration_binding_hash is valid only for an explicitly presented historical migration", { transaction: state });
			}
			if (semanticDecisionSupplied) {
				const acceptance = existing.value.review.semantic_acceptance;
				if (existing.value.review.semantic_review !== "accepted" || acceptance === undefined) {
					return fail("authority_invalid", "zero-delta finalized authority needs no semantic ACCEPT", { transaction: state });
				}
				if (acceptance.expected_bound_diff_hash !== input.expectedBoundDiffHash ||
					acceptance.reviewer.provider !== input.reviewer!.provider || acceptance.reviewer.model !== input.reviewer!.model) {
					return fail("review_conflict", "semantic ACCEPT replay does not match the immutable acceptance authority", { transaction: state });
				}
			}
			if (authorityInfo.kind === "guard-v2") {
				const expected = projectionFromReview(existing.value.review);
				if (expected === undefined) return fail("authority_invalid", "new-v2 finalized review lacks a strict relevance projection", { transaction: state });
				const current = await collectReviewRelevanceV2({
					project_root: input.projectRoot,
					delegation_id: state.delegation_id,
					contract_hash: state.contract_hash,
					after_guard: authorityInfo.after_guard,
					change_set: authorityInfo.change_set,
					...(authorityInfo.command_provenance === undefined ? {} : {
						command_provenance: authorityInfo.command_provenance,
					}),
					exec: input.exec,
					expected_projection: expected,
				});
				if (!current.ok) {
					return fail("review_conflict", "current relevance no longer matches the immutable finalized review", {
						transaction: state,
						...(relevanceConflictHash(state, authorityInfo.change_set, current.error) === undefined ? {} : {
							binding_hash: relevanceConflictHash(state, authorityInfo.change_set, current.error),
						}),
					});
				}
				if (current.value.binding.projection_hash !== existing.value.review.bound_diff_hash) {
					return fail("review_conflict", "current relevance no longer matches the immutable finalized review", { transaction: state });
				}
			} else {
				if (existing.value.review.schema_version !== 1) return fail("authority_invalid", "legacy-v2 review schema is invalid", { transaction: state });
				const currentHash = await collectReviewBoundDiffHash(input.projectRoot, input.exec);
				if (currentHash === null) return fail("review_invalid", "current git review facts are unavailable", { transaction: state });
				if (currentHash !== existing.value.review.bound_diff_hash) {
					return fail("review_conflict", "current diff no longer matches the immutable finalized review", { transaction: state });
				}
			}
			const review: ReviewResult = {
				ok: true,
				record: existing.value.review,
				lines: renderReviewLines(existing.value.review, { maxBytes: input.maxBytes, maxLines: input.maxLines }),
			};
			if (semanticDecisionSupplied && existing.value.review.bound_diff_hash !== input.expectedBoundDiffHash) {
				return fail("review_conflict", "semantic ACCEPT hash does not match the finalized scope/integrity packet", { transaction: state });
			}
			return {
				ok: true,
				review,
				transaction: existing.value.state,
				review_hash: existing.value.review_hash,
				review_path: existing.value.review_path,
				finalized: true,
			};
		}

		const priorRead = terminalNegative
			? await readDelegationTerminalNegativeReviewV1(input.projectRoot, state.delegation_id, input.storage)
			: await readDelegationReviewV2(input.projectRoot, state.delegation_id, input.storage);
		let priorReview: ReviewRecord | null = null;
		let priorRepairDecision = priorRead.ok
			? terminalNegative
				? (priorRead.value as DelegationTerminalNegativeReviewAuthorityV1).terminal_negative_repair?.decision
				: priorRead.value.semantic_repair
			: undefined;
		if (priorRead.ok) {
			if (priorRead.value.finalized) return fail("review_conflict", "pending transaction conflicts with a finalized review", { transaction: state });
			priorReview = priorRead.value.review;
		} else if (priorRead.error.code !== "not_found") {
			return fail("authority_invalid", "existing provisional review is corrupt or unsafe", { transaction: state });
		}
		if (semanticDecisionSupplied) {
			if (priorReview === null) {
				return fail("review_invalid", "semantic decision requires a complete provisional scope/integrity packet from an earlier call", { transaction: state });
			}
			if (priorReview.bound_diff_hash !== input.expectedBoundDiffHash) {
				return fail("review_conflict", "semantic decision hash does not match the prior scope/integrity packet", { transaction: state });
			}
			if (!isScopeIntegrityPacketComplete(priorReview)) {
				return fail("review_invalid", "semantic decision requires a complete untruncated and drift-free scope/integrity packet", { transaction: state });
			}
			if (priorReview.semantic_review !== "required" || priorReview.semantic_acceptance !== undefined) {
				return fail("review_invalid", "semantic decision requires a provisional semantic-review-required packet, never self-asserted authority", { transaction: state });
			}
			if (acceptDecision && priorRepairDecision !== undefined) {
				return fail("review_conflict", "semantic ACCEPT conflicts with the immutable REPAIR decision", { transaction: state });
			}
		}
		if (authorityInfo.kind === "legacy-v2") {
			// Historical experimental v2 is strict read-only. Existing schema1
			// evidence may be replayed, but this adapter never rewrites/upgrades it.
			if (priorReview === null || priorReview.schema_version !== 1) {
				return fail("authority_invalid", "legacy-v2 pending review has no replayable schema1 artifact", { transaction: state });
			}
			const currentHash = await collectReviewBoundDiffHash(input.projectRoot, input.exec);
			if (currentHash === null || currentHash !== priorReview.bound_diff_hash) {
				return fail("review_conflict", "legacy-v2 full diff no longer matches its read-only review", { transaction: state });
			}
			if (semanticDecisionSupplied) {
				return fail("authority_invalid", "historical legacy-v2 review cannot publish new semantic acceptance; use bounded repair", { transaction: state });
			}
			return {
				ok: true,
				review: { ok: true, record: priorReview, lines: renderReviewLines(priorReview, { maxBytes: input.maxBytes, maxLines: input.maxLines }) },
				transaction: state,
				review_hash: priorRead.ok ? priorRead.value.review_hash : "",
				review_path: reviewPath,
				finalized: false,
			};
		}
		const expectedProjection = priorReview === null ? undefined : projectionFromReview(priorReview);
		if (priorReview !== null && expectedProjection === undefined) {
			return fail("authority_invalid", "new-v2 provisional review lacks a strict relevance projection", { transaction: state });
		}
		const relevance = await collectReviewRelevanceV2({
			project_root: input.projectRoot,
			delegation_id: state.delegation_id,
			contract_hash: state.contract_hash,
			after_guard: authorityInfo.after_guard,
			change_set: authorityInfo.change_set,
			...(authorityInfo.command_provenance === undefined ? {} : {
				command_provenance: authorityInfo.command_provenance,
			}),
			exec: input.exec,
			...(expectedProjection === undefined ? {} : { expected_projection: expectedProjection }),
		});
		if (!relevance.ok) {
			const bindingHash = relevanceConflictHash(state, authorityInfo.change_set, relevance.error);
			return fail("review_conflict", `delegation relevance review failed closed (${relevance.error.code})`, {
				transaction: state,
				...(bindingHash === undefined ? {} : { binding_hash: bindingHash }),
			});
		}
		if (authorityInfo.review_envelope !== undefined &&
			authorityInfo.review_envelope.relevance_projection_hash !== relevance.value.binding.projection_hash) {
			return fail("review_conflict", "delegation semantic-review envelope no longer matches the current relevance projection", {
				transaction: state,
				binding_hash: relevance.value.binding.projection_hash,
			});
		}
		const authority = authorityWithRelevance(authorityInfo.authority, relevance.value);
		const reviewedAt = input.now ?? new Date().toISOString();
		if (!isCanonicalTime(reviewedAt)) return fail("review_invalid", "review time must be canonical ISO-8601", { transaction: state });
		let review: ReviewResult;
		if (semanticDecisionSupplied) {
			if (relevance.value.binding.projection_hash !== input.expectedBoundDiffHash || priorReview === null) {
				return fail("review_conflict", "semantic decision no longer matches the current diff binding", { transaction: state });
			}
			if (!await validateReviewPresentationAgainstAuthority({
				projectRoot: input.projectRoot,
				record: priorReview,
				authority,
				exec: input.exec,
				secrets: input.secrets,
			})) {
				return fail("review_invalid", "semantic decision presentation proof no longer matches the current authoritative redacted source streams", { transaction: state });
			}
			if (repairDecision) {
				const decisionInput = {
					delegation_id: state.delegation_id,
					contract_hash: state.contract_hash,
					worker_identity: { ...state.worker_identity },
					expected_generation: state.generation,
					expected_revision: state.revision,
					now: reviewedAt,
					base_review_hash: priorRead.ok ? priorRead.value.review_hash : "",
					expected_bound_diff_hash: input.expectedBoundDiffHash!,
					repair_reason: input.repairReason!,
					reviewer: {
						provider: input.reviewer!.provider as "openai" | "openai-codex",
						model: COMMANDER_MODEL_ID,
					} as const,
				};
				let repairDecisionHash: string;
				let repairReasonHash: string;
				if (terminalNegative) {
					const decided = await publishDelegationTerminalNegativeRepairDecisionV1(input.projectRoot, decisionInput, input.storage);
					if (!decided.ok) {
						return fail(decided.error.code === "storage_failure" ? "storage_failure" : "review_conflict", decided.error.message, { transaction: state });
					}
					repairDecisionHash = decided.value.decision.decision_hash;
					repairReasonHash = decided.value.decision.repair_reason_hash;
				} else {
					const decided = await publishDelegationSemanticRepairDecisionV1(input.projectRoot, decisionInput, input.storage);
					if (!decided.ok) {
						return fail(decided.error.code === "storage_failure" ? "storage_failure" : "review_conflict", decided.error.message, { transaction: state });
					}
					repairDecisionHash = decided.value.decision_hash;
					repairReasonHash = decided.value.repair_reason_hash;
				}
				return {
					ok: true,
					review: {
						ok: true,
						record: priorReview,
						lines: renderReviewLines(priorReview, { maxBytes: input.maxBytes, maxLines: input.maxLines }),
					},
					transaction: state,
					review_hash: priorRead.ok ? priorRead.value.review_hash : "",
					review_path: reviewPath,
					finalized: false,
					semantic_authority: terminalNegative ? "terminal_repair_required" : "repair_required",
					repair_decision_hash: repairDecisionHash,
					repair_reason_hash: repairReasonHash,
				};
			}
			const acceptedRecord: ReviewRecord = {
				...priorReview,
				reviewed_at: reviewedAt,
				semantic_review: "accepted",
				semantic_acceptance: {
					decision: "ACCEPT",
					expected_bound_diff_hash: input.expectedBoundDiffHash!,
					reviewer: {
						provider: input.reviewer!.provider as "openai" | "openai-codex",
						model: COMMANDER_MODEL_ID,
					},
					accepted_at: reviewedAt,
				},
			};
			review = {
				ok: true,
				record: acceptedRecord,
				lines: renderReviewLines(acceptedRecord, { maxBytes: input.maxBytes, maxLines: input.maxLines }),
			};
		} else if (priorRead.ok && priorRepairDecision !== undefined && (
			terminalNegative
				? hasDelegationTerminalNegativeSemanticRepairAuthorityV1(priorRead.value as DelegationTerminalNegativeReviewAuthorityV1)
				: hasDelegationSemanticRepairAuthorityV2(priorRead.value)
		)) {
			review = {
				ok: true,
				record: priorReview!,
				lines: renderReviewLines(priorReview!, { maxBytes: input.maxBytes, maxLines: input.maxLines }),
			};
		} else {
			review = await reviewDelegationFromAuthority({
				projectRoot: input.projectRoot,
				delegationId: state.delegation_id,
				exec: input.exec,
				includePaths: input.includePaths === undefined ? undefined : [...input.includePaths],
				maxLines: input.maxLines,
				maxBytes: input.maxBytes,
				secrets: input.secrets === undefined ? undefined : [...input.secrets],
				now: reviewedAt,
				authority,
				priorReview,
				reviewPath,
			});
		}
		if (!review.ok || review.record === undefined) return fail("review_invalid", review.error ?? "delegation diff review failed closed", { review, transaction: state });
		if (priorRepairDecision !== undefined) {
			return {
				ok: true,
				review,
				transaction: state,
				review_hash: priorRead.ok ? priorRead.value.review_hash : "",
				review_path: reviewPath,
				finalized: false,
				semantic_authority: terminalNegative ? "terminal_repair_required" : "repair_required",
				repair_decision_hash: priorRepairDecision.decision_hash,
				repair_reason_hash: priorRepairDecision.repair_reason_hash,
			};
		}
		const artifact = artifactFor(state, reviewedAt, review.record);
		const cas = {
			delegation_id: state.delegation_id,
			contract_hash: state.contract_hash,
			worker_identity: { ...state.worker_identity },
			expected_generation: state.generation,
			expected_revision: state.revision,
			now: reviewedAt,
			artifact,
		};
		const mayFinalize = !terminalNegative && isStrictSemanticAcceptedOrZeroDelta(review.record);
		const persisted = terminalNegative
			? await persistDelegationTerminalNegativeReviewProvisionalV1(input.projectRoot, cas, input.storage)
			: mayFinalize
				? await publishDelegationReviewV2(input.projectRoot, cas, input.storage)
				: await persistDelegationReviewProvisionalV2(input.projectRoot, cas, input.storage);
		if (!persisted.ok) {
			const point = persisted.error.point === undefined ? "" : ` at ${persisted.error.point}`;
			return fail("storage_failure", `delegation v2 review persistence failed (${persisted.error.code}${point}): ${persisted.error.message}`, { review, transaction: state });
		}
		const persistedReview: ReviewResult = {
			...review,
			record: persisted.value.review,
		};
		return {
			ok: true,
			review: persistedReview,
			transaction: persisted.value.state,
			review_hash: persisted.value.review_hash,
			review_path: persisted.value.review_path,
			finalized: persisted.value.finalized,
		};
	} catch {
		return fail("review_invalid", "delegation v2 review failed closed");
	}
}
