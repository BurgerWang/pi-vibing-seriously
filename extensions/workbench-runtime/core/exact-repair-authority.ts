/** Pure recovery of one deterministic strict-authority repair call. */

import { createHash } from "node:crypto";

import { canonicalHash } from "../cache/canonical-hash.ts";
import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import {
	isDelegationCommandScopeAttributedV1,
	validateDelegationCommandProvenance,
	type DelegationCommandProvenanceRecord,
} from "./delegation-command-effect-provenance.ts";
import {
	normalizeDelegationBoundedTaskContractV2,
	type DelegationBoundedTaskContractBindingV2,
} from "./delegation-transaction-artifacts.ts";
import {
	hasDelegationSemanticRepairAuthorityV2,
	isDelegationTerminalNegativeReviewEligibleFromCommittedV1,
	type DelegationCommittedGenerationV2,
	type DelegationReviewAuthorityV2,
	type DelegationSemanticRepairDecisionV1,
	type DelegationTerminalNegativeSolAuthorityV1,
} from "./delegation-transaction-storage.ts";
import {
	bindDelegationRepairLineageV1,
	DELEGATION_REPAIR_LINEAGE_MAX_DEPTH,
	delegationPathAllowedV2,
	parseDelegationRepairLineageV1,
	type DelegationRepairLineageV1,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import { validateSemanticReviewEnvelopeV1 } from "./semantic-review-envelope.ts";
import { ownDataValue } from "./runtime-output-controller.ts";

export const EXACT_REPAIR_COMMAND_EXECUTION_KIND_V1 = "exact-repair-command-execution-v1" as const;

export type ExactRepairToolArgumentsV1 = Omit<
	DelegationBoundedTaskContractBindingV2,
	"budget_profile" | "contract_hash"
> & {
	readonly budget_profile: "standard" | "extended";
};

export type ExactRepairAuthorityRecoveryCodeV1 =
	| "AUTHORITY_CHANGED"
	| "CONTRACT_RECOVERY_FAILED"
	| "CURRENT_BINDING_CHANGED"
	| "INVALID_COMMITTED_SCOPE"
	| "REPAIR_LINEAGE_REQUIRED"
	| "SEMANTIC_REPAIR_AUTHORITY_REQUIRED"
	| "TERMINAL_NEGATIVE_REPAIR_AUTHORITY_REQUIRED"
	| "UNSUPPORTED_AUTHORITY_STATE";

export interface ExactRepairCommandAuthorityBaseV1 {
	readonly schema_version: 1;
	readonly kind: typeof EXACT_REPAIR_COMMAND_EXECUTION_KIND_V1;
	readonly repair_of: string;
	readonly committed_proof_content_hash: string;
	readonly arguments: ExactRepairToolArgumentsV1;
	/** Exact lineage the successor transaction must persist. */
	readonly successor_lineage: DelegationRepairLineageV1;
	readonly idempotency_key: string;
	readonly tool_call_id: string;
}

export interface ExactRepairSemanticAuthorityV1 extends ExactRepairCommandAuthorityBaseV1 {
	readonly authority_kind: "semantic-repair";
	readonly semantic_decision_hash: string;
}

export interface ExactRepairTerminalAuthorityV1 extends ExactRepairCommandAuthorityBaseV1 {
	readonly authority_kind: "terminal-lineage";
	readonly lineage_hash: string;
}

export interface ExactRepairTerminalNegativeAuthorityV1 extends ExactRepairCommandAuthorityBaseV1 {
	readonly authority_kind: "terminal-negative-repair";
	readonly semantic_decision_hash: string;
	readonly expected_bound_diff_hash: string;
}

/**
 * Exact continuation of a strictly evidenced raw repair tip. For this
 * authority kind `committed_proof_content_hash` is the immutable root
 * generation proof; the selected `repair_of` transaction itself deliberately
 * has no proof. A post-worker finalization crash additionally carries a
 * journal/current-byte rebase hash.
 */
export interface ExactRepairRawLineageAuthorityV1 extends ExactRepairCommandAuthorityBaseV1 {
	readonly authority_kind: "raw-lineage-retry";
	readonly raw_tip_retry_kind: "ABORTED" | "EMPTY_RECOVERY" | "FINALIZATION_RECOVERY";
	readonly root_delegation_id: string;
	readonly root_authority_kind: "semantic-repair" | "terminal-negative-repair";
	readonly root_transaction_hash: string;
	readonly root_decision_hash: string;
	readonly continuation_decision_delegation_id: string;
	readonly continuation_decision_proof_content_hash: string;
	readonly continuation_decision_hash: string;
	readonly lineage_hash: string;
	readonly raw_tip_transaction_hash: string;
	readonly raw_tip_evidence_hash: string;
	readonly raw_tip_rebase_hash: string | null;
	readonly expected_current_binding_hash: string;
	readonly closure_root_count: number | null;
	readonly closure_lineage_count: number | null;
	readonly closure_hash: string;
	readonly path_admission_authority_hash: string;
}

export type ExactRepairCommandAuthorityV1 =
	| ExactRepairSemanticAuthorityV1
	| ExactRepairTerminalNegativeAuthorityV1
	| ExactRepairTerminalAuthorityV1
	| ExactRepairRawLineageAuthorityV1;

/**
 * Narrow seam supplied by the strict terminal-negative reader. The reader,
 * not this module, proves that the Sol decision was atomically persisted.
 * This core still revalidates every parent/proof/review hash binding before it
 * can become command authority.
 */
export type ExactRepairTerminalNegativeSolAuthorityV1 = DelegationTerminalNegativeSolAuthorityV1;

export type RecoverExactRepairCommandAuthorityResultV1 =
	| { readonly ok: true; readonly value: Readonly<ExactRepairCommandAuthorityV1> }
	| { readonly ok: false; readonly code: ExactRepairAuthorityRecoveryCodeV1 };

/**
 * Rebind the immutable parent contract to one exact repair id. This helper is
 * intentionally tolerant only at its outer unknown boundary; both production
 * callers first use the strict committed-generation reader.
 */
export function exactRepairToolArgumentsV1(
	committed: unknown,
	repairOf: string,
): ExactRepairToolArgumentsV1 | undefined {
	const state = ownDataValue(committed, "state");
	const status = ownDataValue(state, "status");
	if (
		ownDataValue(state, "delegation_id") !== repairOf
		|| (status !== "PENDING_REVIEW" && status !== "INTERRUPTED" && status !== "FAILED" && status !== "RECOVERY_REQUIRED")
		|| ownDataValue(state, "task_kind") !== "implementation"
	) return undefined;
	const records = ownDataValue(committed, "records");
	const before = ownDataValue(records, "before.json");
	const persistedContract = ownDataValue(before, "contract");
	const persistedPlanRef = ownDataValue(persistedContract, "plan_ref");
	const persistedExtendedReason = ownDataValue(persistedContract, "extended_reason");
	const original = normalizeDelegationBoundedTaskContractV2({
		task_kind: ownDataValue(persistedContract, "task_kind"),
		task: ownDataValue(persistedContract, "task"),
		allowed_paths: ownDataValue(persistedContract, "allowed_paths"),
		acceptance_criteria: ownDataValue(persistedContract, "acceptance_criteria"),
		verification: ownDataValue(persistedContract, "verification"),
		timeout_seconds: ownDataValue(persistedContract, "timeout_seconds"),
		budget_profile: ownDataValue(persistedContract, "budget_profile"),
		...(ownDataValue(persistedContract, "repair_of") === undefined
			? {}
			: { repair_of: ownDataValue(persistedContract, "repair_of") }),
		...(persistedPlanRef === undefined ? {} : { plan_ref: persistedPlanRef }),
		...(persistedExtendedReason === undefined ? {} : { extended_reason: persistedExtendedReason }),
	});
	const stateContractHash = ownDataValue(state, "contract_hash");
	if (!original.ok || original.value.contract_hash !== stateContractHash ||
		ownDataValue(persistedContract, "contract_hash") !== stateContractHash) return undefined;
	const rebound = normalizeDelegationBoundedTaskContractV2({
		task_kind: original.value.task_kind,
		task: original.value.task,
		allowed_paths: original.value.allowed_paths,
		acceptance_criteria: original.value.acceptance_criteria,
		verification: original.value.verification,
		timeout_seconds: original.value.timeout_seconds,
		budget_profile: original.value.budget_profile,
		repair_of: repairOf,
		...(original.value.plan_ref === undefined ? {} : { plan_ref: original.value.plan_ref }),
		...(original.value.extended_reason === undefined ? {} : { extended_reason: original.value.extended_reason }),
	});
	if (!rebound.ok || rebound.value.task_kind !== "implementation") return undefined;
	const budgetProfile = rebound.value.budget_profile;
	if (budgetProfile !== "standard" && budgetProfile !== "extended") return undefined;
	const { contract_hash: _contractHash, budget_profile: _budgetProfile, ...arguments_ } = rebound.value;
	return { ...arguments_, budget_profile: budgetProfile };
}

interface StrictCommittedRepairScopeV1 {
	readonly carried_paths: readonly string[];
}

const TERMINAL_NEGATIVE_DECISION_FIELDS = [
	"schema_version", "delegation_id", "contract_hash", "generation", "transaction_revision",
	"generation_content_hash", "base_review_hash", "expected_bound_diff_hash", "decision", "repair_reason",
	"repair_reason_hash", "reviewer", "decided_at", "decision_hash",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...fields].sort();
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function byteSortedUnion(...sets: ReadonlyArray<readonly string[]>): string[] | undefined {
	const values = [...new Set(sets.flatMap((set) => [...set]))].sort(byteCompare);
	return values.length > 0 && values.length <= 500 ? values : undefined;
}

/**
 * Recover only concrete, committed facts. Allowed-path rules remain immutable
 * successor write authority; they are never expanded into artificial write
 * paths. A terminal-negative compatibility repair additionally carries every
 * unresolved drift/conflict path into later semantic review without granting
 * the worker write authority over it.
 */
function strictCommittedRepairScopeV1(
	committed: DelegationCommittedGenerationV2,
	allowTerminalNegativeCompatibility = false,
): StrictCommittedRepairScopeV1 | undefined {
	const state = committed.state;
	const scope = committed.records["scope.json"];
	if (!isRecord(scope) || !validateChangeSet(scope.change_set) || state.terminal_outcome === null) return undefined;
	const changeSet = scope.change_set as ChangeSetRecord;
	const hasCommand = Object.prototype.hasOwnProperty.call(scope, "command_provenance");
	const command = hasCommand ? scope.command_provenance : undefined;
	if (hasCommand && !validateDelegationCommandProvenance(command, changeSet)) return undefined;
	const commandProvenance = command as DelegationCommandProvenanceRecord | undefined;
	const effectivePaths = commandProvenance === undefined
		? changeSet.worker_delta.map((entry) => entry.path)
		: [...commandProvenance.effective_paths];
	const effectiveStatus = commandProvenance?.effective_status ?? changeSet.status;
	const effectiveHash = commandProvenance?.effective_delta_hash ?? changeSet.worker_delta_hash;
	const terminalNegativeCompatibility = allowTerminalNegativeCompatibility
		&& isDelegationTerminalNegativeReviewEligibleFromCommittedV1(state, committed.records);
	const terminalLineageWorkspaceRebase = state.repair_lineage !== undefined
		&& (state.status === "FAILED" || state.status === "RECOVERY_REQUIRED")
		&& effectiveStatus === "WORKSPACE_DRIFT";
	const scopeChangedPaths = scope.changed_paths;
	const scopeAllowedPaths = scope.allowed_paths;
	const outcome = state.terminal_outcome;
	if (changeSet.delegation_id !== state.delegation_id || changeSet.contract_hash !== state.contract_hash ||
		!Array.isArray(scopeChangedPaths) || !scopeChangedPaths.every((path): path is string => typeof path === "string") ||
		!Array.isArray(scopeAllowedPaths) || !scopeAllowedPaths.every((path): path is string => typeof path === "string") ||
		!sameStrings(scopeChangedPaths, effectivePaths) || !sameStrings(scopeAllowedPaths, state.allowed_paths) ||
		!sameStrings(outcome.changed_paths, effectivePaths) || outcome.change_set_status !== effectiveStatus ||
		(!terminalNegativeCompatibility && !terminalLineageWorkspaceRebase && (commandProvenance === undefined
			? effectiveStatus !== "ATTRIBUTED"
			: !isDelegationCommandScopeAttributedV1(commandProvenance, changeSet))) ||
		outcome.delta_hash !== effectiveHash ||
		outcome.terminal_facts_complete !== true || outcome.scope_complete !== true) return undefined;
	if (commandProvenance !== undefined &&
		(commandProvenance.delegation_id !== state.delegation_id ||
			commandProvenance.contract_hash !== state.contract_hash ||
			commandProvenance.base_change_set_hash !== changeSet.change_set_hash ||
			commandProvenance.worker_delta_hash !== changeSet.worker_delta_hash)) return undefined;
	const parentLineage = state.repair_lineage === undefined
		? undefined
		: parseDelegationRepairLineageV1(state.repair_lineage);
	if (state.repair_lineage !== undefined && parentLineage === undefined) return undefined;
	const carriedPaths = byteSortedUnion(
		parentLineage?.carried_paths ?? [],
		effectivePaths,
		changeSet.dependency_paths,
		...(terminalNegativeCompatibility ? [
			(commandProvenance?.remaining_workspace_drift ?? changeSet.workspace_drift).map((entry) => entry.path),
			changeSet.conflicts.map((entry) => entry.path),
		] : []),
	);
	// Only this transaction's effective W∪C is write authority. Inherited
	// carried paths and dependency paths remain review/conflict provenance and
	// may legitimately lie outside a later repair's narrower write contract.
	if (carriedPaths === undefined ||
		effectivePaths.some((path) => !delegationPathAllowedV2(path, state.allowed_paths))) return undefined;
	return { carried_paths: carriedPaths };
}

function successorLineageV1(input: {
	readonly parent: DelegationTransactionRecord;
	readonly carriedPaths: readonly string[];
	readonly semanticDecisionHash?: string;
}): DelegationRepairLineageV1 | undefined {
	const parentLineage = input.parent.repair_lineage === undefined
		? undefined
		: parseDelegationRepairLineageV1(input.parent.repair_lineage);
	if (input.parent.repair_lineage !== undefined && parentLineage === undefined) return undefined;
	if (parentLineage === undefined) {
		if (input.semanticDecisionHash === undefined) return undefined;
		return bindDelegationRepairLineageV1({
			schema_version: 1,
			kind: "semantic-repair-lineage-v1",
			root_delegation_id: input.parent.delegation_id,
			repair_of: input.parent.delegation_id,
			root_decision_hash: input.semanticDecisionHash,
			continuation_decision_delegation_id: input.parent.delegation_id,
			continuation_decision_hash: input.semanticDecisionHash,
			parent_lineage_hash: null,
			depth: 1,
			carried_paths: [...input.carriedPaths],
		});
	}
	return bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: parentLineage.root_delegation_id,
		repair_of: input.parent.delegation_id,
		root_decision_hash: parentLineage.root_decision_hash,
		continuation_decision_delegation_id: input.semanticDecisionHash === undefined
			? parentLineage.continuation_decision_delegation_id
			: input.parent.delegation_id,
		continuation_decision_hash: input.semanticDecisionHash ?? parentLineage.continuation_decision_hash,
		parent_lineage_hash: parentLineage.lineage_hash,
		depth: Math.min(parentLineage.depth + 1, DELEGATION_REPAIR_LINEAGE_MAX_DEPTH),
		carried_paths: [...input.carriedPaths],
	});
}

function isCanonicalTime(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 20 || value.length > 32) return false;
	try { return new Date(value).toISOString() === value; } catch { return false; }
}

function validTerminalNegativeDecisionV1(input: {
	readonly committed: DelegationCommittedGenerationV2;
	readonly authority: ExactRepairTerminalNegativeSolAuthorityV1;
	readonly currentBindingHash: string | undefined;
}): DelegationSemanticRepairDecisionV1 | undefined {
	const { committed, authority, currentBindingHash } = input;
	const state = committed.state;
	const decision = authority.decision;
	if (canonicalHash(authority.state) !== canonicalHash(state) ||
		!isRecord(decision) || !exactFields(decision as unknown as Record<string, unknown>, TERMINAL_NEGATIVE_DECISION_FIELDS) ||
		![authority.review_hash, authority.bound_diff_hash, currentBindingHash].every((hash) =>
			typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)) ||
		currentBindingHash !== authority.bound_diff_hash || decision.schema_version !== 1 || decision.decision !== "REPAIR" ||
		decision.delegation_id !== state.delegation_id || decision.contract_hash !== state.contract_hash ||
		decision.generation !== state.generation || decision.transaction_revision !== state.revision ||
		decision.generation_content_hash !== committed.proof.content_hash ||
		decision.base_review_hash !== authority.review_hash ||
		decision.expected_bound_diff_hash !== authority.bound_diff_hash ||
		typeof decision.repair_reason !== "string" || decision.repair_reason.length === 0 ||
		decision.repair_reason !== decision.repair_reason.trim() || decision.repair_reason.includes("\0") ||
		Buffer.byteLength(decision.repair_reason, "utf8") > 1_024 ||
		decision.repair_reason_hash !== createHash("sha256").update(decision.repair_reason, "utf8").digest("hex") ||
		!isRecord(decision.reviewer) || exactFields(decision.reviewer, ["provider", "model"]) === false ||
		(decision.reviewer.provider !== "openai" && decision.reviewer.provider !== "openai-codex") ||
		decision.reviewer.model !== "gpt-5.6-sol" || !isCanonicalTime(decision.decided_at) ||
		!isCanonicalTime(state.updated_at) || Date.parse(decision.decided_at) < Date.parse(state.updated_at)) return undefined;
	const { decision_hash: suppliedHash, ...payload } = decision;
	if (!/^[a-f0-9]{64}$/u.test(suppliedHash) || canonicalHash(payload) !== suppliedHash) return undefined;
	const after = committed.records["after.json"];
	const envelope = isRecord(after) ? after.review_envelope : undefined;
	if (state.status === "INTERRUPTED" || envelope !== undefined) {
		if (!validateSemanticReviewEnvelopeV1(envelope) ||
			envelope.relevance_projection_hash !== authority.bound_diff_hash) return undefined;
	}
	return decision;
}

/**
 * Recover a hash-bound direct command from either one mutually consistent
 * semantic REPAIR authority or one strict committed terminal lineage. The
 * latter has no semantic decision and therefore binds its idempotency key to
 * the immutable committed proof plus lineage hash instead.
 */
export function recoverExactRepairCommandAuthorityV1(input: {
	readonly repairOf: string;
	readonly committed: DelegationCommittedGenerationV2;
	readonly review?: DelegationReviewAuthorityV2;
	readonly terminalNegativeRepair?: ExactRepairTerminalNegativeSolAuthorityV1;
	readonly currentBindingHash?: string;
}): RecoverExactRepairCommandAuthorityResultV1 {
	const state = input.committed.state;
	if (state.delegation_id !== input.repairOf || state.task_kind !== "implementation" ||
		(state.status !== "PENDING_REVIEW" && state.status !== "INTERRUPTED" &&
			state.status !== "FAILED" && state.status !== "RECOVERY_REQUIRED")) {
		return { ok: false, code: "UNSUPPORTED_AUTHORITY_STATE" };
	}
	if (state.committed_proof === null ||
		canonicalHash(state.committed_proof) !== canonicalHash(input.committed.proof)) {
		return { ok: false, code: "AUTHORITY_CHANGED" };
	}
	const arguments_ = exactRepairToolArgumentsV1(input.committed, input.repairOf);
	if (arguments_ === undefined) return { ok: false, code: "CONTRACT_RECOVERY_FAILED" };
	if (!sameStrings(arguments_.allowed_paths, state.allowed_paths)) {
		return { ok: false, code: "CONTRACT_RECOVERY_FAILED" };
	}
	const scope = strictCommittedRepairScopeV1(
		input.committed,
		input.terminalNegativeRepair !== undefined,
	);
	if (scope === undefined) return { ok: false, code: "INVALID_COMMITTED_SCOPE" };
	const commonProjection = {
		schema_version: 1 as const,
		kind: EXACT_REPAIR_COMMAND_EXECUTION_KIND_V1,
		repair_of: input.repairOf,
		committed_proof_content_hash: input.committed.proof.content_hash,
		arguments: arguments_,
	};
	let projection:
		| Omit<ExactRepairSemanticAuthorityV1, "idempotency_key" | "tool_call_id">
		| Omit<ExactRepairTerminalNegativeAuthorityV1, "idempotency_key" | "tool_call_id">
		| Omit<ExactRepairTerminalAuthorityV1, "idempotency_key" | "tool_call_id">;
	if (state.status === "PENDING_REVIEW") {
		if (input.review === undefined || canonicalHash(state) !== canonicalHash(input.review.state) ||
			input.committed.proof.content_hash !== input.review.state.committed_proof?.content_hash) {
			return { ok: false, code: input.review === undefined ? "SEMANTIC_REPAIR_AUTHORITY_REQUIRED" : "AUTHORITY_CHANGED" };
		}
		if (!hasDelegationSemanticRepairAuthorityV2(input.review) || input.review.semantic_repair === undefined) {
			return { ok: false, code: "SEMANTIC_REPAIR_AUTHORITY_REQUIRED" };
		}
		const successorLineage = successorLineageV1({
			parent: state,
			carriedPaths: scope.carried_paths,
			semanticDecisionHash: input.review.semantic_repair.decision_hash,
		});
		if (successorLineage === undefined) return { ok: false, code: "REPAIR_LINEAGE_REQUIRED" };
		projection = {
			...commonProjection,
			authority_kind: "semantic-repair",
			semantic_decision_hash: input.review.semantic_repair.decision_hash,
			successor_lineage: successorLineage,
		};
	} else if (state.status === "INTERRUPTED" ||
		(state.status === "FAILED" && (state.repair_lineage === undefined || input.terminalNegativeRepair !== undefined))) {
		if (input.terminalNegativeRepair === undefined) {
			return { ok: false, code: "TERMINAL_NEGATIVE_REPAIR_AUTHORITY_REQUIRED" };
		}
		if (input.currentBindingHash === undefined ||
			input.currentBindingHash !== input.terminalNegativeRepair.bound_diff_hash) {
			return { ok: false, code: "CURRENT_BINDING_CHANGED" };
		}
		const decision = validTerminalNegativeDecisionV1({
			committed: input.committed,
			authority: input.terminalNegativeRepair,
			currentBindingHash: input.currentBindingHash,
		});
		if (decision === undefined) return { ok: false, code: "AUTHORITY_CHANGED" };
		const successorLineage = successorLineageV1({
			parent: state,
			carriedPaths: scope.carried_paths,
			semanticDecisionHash: decision.decision_hash,
		});
		if (successorLineage === undefined) return { ok: false, code: "REPAIR_LINEAGE_REQUIRED" };
		projection = {
			...commonProjection,
			authority_kind: "terminal-negative-repair",
			semantic_decision_hash: decision.decision_hash,
			expected_bound_diff_hash: decision.expected_bound_diff_hash,
			successor_lineage: successorLineage,
		};
	} else {
		const lineage = parseDelegationRepairLineageV1(state.repair_lineage);
		if (lineage === undefined) return { ok: false, code: "REPAIR_LINEAGE_REQUIRED" };
		const successorLineage = successorLineageV1({ parent: state, carriedPaths: scope.carried_paths });
		if (successorLineage === undefined) return { ok: false, code: "REPAIR_LINEAGE_REQUIRED" };
		projection = {
			...commonProjection,
			authority_kind: "terminal-lineage",
			lineage_hash: lineage.lineage_hash,
			successor_lineage: successorLineage,
		};
	}
	const idempotencyKey = canonicalHash(projection);
	return {
		ok: true,
		value: Object.freeze({
			...projection,
			idempotency_key: idempotencyKey,
			tool_call_id: `q-repair-${idempotencyKey}`,
		}),
	};
}
