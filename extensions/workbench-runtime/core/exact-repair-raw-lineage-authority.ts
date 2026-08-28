/** Strict durable authority for retrying one no-write raw repair lineage tip. */

import { canonicalHash } from "../cache/canonical-hash.ts";
import {
	readStrictRetryableRawRepairEvidenceV1,
	type StrictRetryableRawRepairEvidenceV1,
} from "./delegation-execution-owner.ts";
import {
	admitProjectDelegationPathLaneV1,
	isDelegationPathLaneBypassableProjectIssueV1,
} from "./delegation-path-lane-admission.ts";
import { readProjectDelegationRepairClosureV1 } from "./delegation-project-authority.ts";
import { bindDelegationBoundedTaskContractV2 } from "./delegation-transaction-artifacts.ts";
import {
	hasDelegationSemanticRepairAuthorityV2,
	isDelegationTerminalNegativeReviewEligibleFromCommittedV1,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTerminalNegativeSolAuthorityV1,
	readDelegationTransactionV2,
	type DelegationCommittedGenerationV2,
	type DelegationSemanticRepairDecisionV1,
} from "./delegation-transaction-storage.ts";
import {
	bindDelegationRepairLineageV1,
	DELEGATION_REPAIR_LINEAGE_MAX_DEPTH,
	EXACT_REPAIR_RAW_LINEAGE_MAX_RETRYABLE_DEPTH_V1,
	parseDelegationRepairLineageV1,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import {
	EXACT_REPAIR_COMMAND_EXECUTION_KIND_V1,
	type ExactRepairRawLineageAuthorityV1,
	type ExactRepairToolArgumentsV1,
} from "./exact-repair-authority.ts";

export type RawLineageExactRepairAuthorityCodeV1 =
	| "AUTHORITY_CHANGED"
	| "CONTRACT_RECOVERY_FAILED"
	| "CURRENT_BINDING_CHANGED"
	| "PROJECT_CLOSURE_INVALID"
	| "RAW_TIP_NOT_RETRYABLE"
	| "ROOT_AUTHORITY_INVALID"
	| "STORAGE_FAILURE";

export type RecoverRawLineageExactRepairAuthorityResultV1 =
	| { readonly ok: true; readonly value: Readonly<ExactRepairRawLineageAuthorityV1> }
	| { readonly ok: false; readonly code: RawLineageExactRepairAuthorityCodeV1 };

export interface RawLineageCurrentBindingV1 {
	readonly status: "unavailable" | "fresh" | "conflict";
	readonly hash?: string;
}

export interface RawLineageExactRepairAuthorityReadersV1 {
	readonly readClosure: typeof readProjectDelegationRepairClosureV1;
	readonly readTransaction: typeof readDelegationTransactionV2;
	readonly readCommitted: typeof readDelegationCommittedGenerationV2;
	readonly readReview: typeof readDelegationReviewV2;
	readonly readTerminalNegative: typeof readDelegationTerminalNegativeSolAuthorityV1;
	readonly readRawEvidence: typeof readStrictRetryableRawRepairEvidenceV1;
	readonly admitPathLane: typeof admitProjectDelegationPathLaneV1;
}

const DEFAULT_READERS = Object.freeze({
	readClosure: readProjectDelegationRepairClosureV1,
	readTransaction: readDelegationTransactionV2,
	readCommitted: readDelegationCommittedGenerationV2,
	readReview: readDelegationReviewV2,
	readTerminalNegative: readDelegationTerminalNegativeSolAuthorityV1,
	readRawEvidence: readStrictRetryableRawRepairEvidenceV1,
	admitPathLane: admitProjectDelegationPathLaneV1,
}) satisfies RawLineageExactRepairAuthorityReadersV1;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function reboundRootContract(
	root: DelegationCommittedGenerationV2,
	repairOf: string,
): ReturnType<typeof bindDelegationBoundedTaskContractV2> {
	const before = root.records["before.json"];
	if (!isRecord(before) || !isRecord(before.contract)) {
		return { ok: false, error: { code: "invalid_contract", message: "root before contract is absent" } };
	}
	const { contract_hash: persistedHash, repair_of: _priorRepair, ...payload } = before.contract;
	const original = bindDelegationBoundedTaskContractV2({
		...payload,
		...(before.contract.repair_of === undefined ? {} : { repair_of: before.contract.repair_of }),
	});
	if (!original.ok || persistedHash !== original.value.contract_hash ||
		root.state.contract_hash !== original.value.contract_hash) return original.ok
		? { ok: false, error: { code: "binding_conflict", message: "root contract hash changed" } }
		: original;
	return bindDelegationBoundedTaskContractV2({ ...payload, repair_of: repairOf });
}

async function readCommittedDecision(input: {
	projectRoot: string;
	committed: DelegationCommittedGenerationV2;
	readers: RawLineageExactRepairAuthorityReadersV1;
}): Promise<
	| {
		readonly ok: true;
		readonly kind: "semantic-repair" | "terminal-negative-repair";
		readonly decision: DelegationSemanticRepairDecisionV1;
	}
	| { readonly ok: false; readonly storage: boolean }
> {
	const state = input.committed.state;
	if (state.task_kind !== "implementation") return { ok: false, storage: false };
	if (state.status === "PENDING_REVIEW") {
		const review = await input.readers.readReview(input.projectRoot, state.delegation_id);
		if (!review.ok) return { ok: false, storage: review.error.code === "storage_failure" };
		if (!hasDelegationSemanticRepairAuthorityV2(review.value) || review.value.semantic_repair === undefined ||
			canonicalHash(review.value.state) !== canonicalHash(state)) return { ok: false, storage: false };
		return { ok: true, kind: "semantic-repair", decision: review.value.semantic_repair };
	}
	if (!isDelegationTerminalNegativeReviewEligibleFromCommittedV1(state, input.committed.records)) {
		return { ok: false, storage: false };
	}
	const terminal = await input.readers.readTerminalNegative(input.projectRoot, state.delegation_id);
	if (!terminal.ok) return { ok: false, storage: terminal.error.code === "storage_failure" };
	if (canonicalHash(terminal.value.state) !== canonicalHash(state)) return { ok: false, storage: false };
	return { ok: true, kind: "terminal-negative-repair", decision: terminal.value.decision };
}

function toolArguments(
	root: DelegationCommittedGenerationV2,
	repairOf: string,
): ExactRepairToolArgumentsV1 | undefined {
	const rebound = reboundRootContract(root, repairOf);
	if (!rebound.ok || rebound.value.task_kind !== "implementation" ||
		(rebound.value.budget_profile !== "standard" && rebound.value.budget_profile !== "extended")) return undefined;
	const { contract_hash: _contractHash, budget_profile: budgetProfile, ...payload } = rebound.value;
	return { ...payload, budget_profile: budgetProfile };
}

export interface RawLineageImmutableRepairV1 {
	readonly repair_of: string;
	readonly parent: DelegationTransactionRecord;
	readonly arguments: ExactRepairToolArgumentsV1;
	readonly successor_lineage: NonNullable<DelegationTransactionRecord["repair_lineage"]>;
	readonly root_delegation_id: string;
	readonly root_authority_kind: "semantic-repair" | "terminal-negative-repair";
	readonly root_transaction_hash: string;
	readonly root_proof_content_hash: string;
	readonly root_decision_hash: string;
	readonly continuation_decision_delegation_id: string;
	readonly continuation_decision_proof_content_hash: string;
	readonly continuation_decision_hash: string;
	readonly continuation_expected_binding_hash: string;
	readonly lineage_hash: string;
	readonly raw_tip_transaction_hash: string;
	readonly raw_tip_evidence_hash: string;
	readonly immutable_hash: string;
}

export type ReadRawLineageImmutableRepairResultV1 =
	| { readonly ok: true; readonly value: Readonly<RawLineageImmutableRepairV1> }
	| { readonly ok: false; readonly code: RawLineageExactRepairAuthorityCodeV1 };

/** Read only facts that remain valid after a durable successor is published. */
export async function readRawLineageImmutableRepairV1(
	projectRoot: string,
	repairOf: string,
	readers: RawLineageExactRepairAuthorityReadersV1 = DEFAULT_READERS,
): Promise<ReadRawLineageImmutableRepairResultV1> {
	const tipRead = await readers.readTransaction(projectRoot, repairOf);
	if (!tipRead.ok) return { ok: false, code: tipRead.error.code === "storage_failure" ? "STORAGE_FAILURE" : "RAW_TIP_NOT_RETRYABLE" };
	const tip = tipRead.value;
	const lineage = parseDelegationRepairLineageV1(tip.repair_lineage);
	if (tip.task_kind !== "implementation" || tip.committed_proof !== null || lineage === undefined ||
		lineage.repair_of === tip.delegation_id || lineage.depth >= DELEGATION_REPAIR_LINEAGE_MAX_DEPTH ||
		lineage.depth > EXACT_REPAIR_RAW_LINEAGE_MAX_RETRYABLE_DEPTH_V1) {
		return { ok: false, code: "RAW_TIP_NOT_RETRYABLE" };
	}
	const evidence = await readers.readRawEvidence(projectRoot, tip);
	if (!evidence.ok) {
		return { ok: false, code: evidence.code === "STORAGE_FAILURE" ? "STORAGE_FAILURE" :
			evidence.code === "AUTHORITY_CHANGED" ? "AUTHORITY_CHANGED" : "RAW_TIP_NOT_RETRYABLE" };
	}
	const rootRead = await readers.readCommitted(projectRoot, lineage.root_delegation_id);
	if (!rootRead.ok) return { ok: false, code: rootRead.error.code === "storage_failure" ? "STORAGE_FAILURE" : "ROOT_AUTHORITY_INVALID" };
	const root = rootRead.value;
	if (root.state.delegation_id !== lineage.root_delegation_id || root.state.repair_lineage !== undefined ||
		root.state.committed_proof === null || root.proof.content_hash !== root.state.committed_proof.content_hash) {
		return { ok: false, code: "ROOT_AUTHORITY_INVALID" };
	}
	const rootDecision = await readCommittedDecision({ projectRoot, committed: root, readers });
	if (!rootDecision.ok || rootDecision.decision.decision_hash !== lineage.root_decision_hash) {
		return { ok: false, code: !rootDecision.ok && rootDecision.storage ? "STORAGE_FAILURE" : "ROOT_AUTHORITY_INVALID" };
	}
	let continuation = root;
	let continuationDecision = rootDecision;
	if (lineage.continuation_decision_delegation_id !== root.state.delegation_id) {
		const continuationRead = await readers.readCommitted(projectRoot, lineage.continuation_decision_delegation_id);
		if (!continuationRead.ok) {
			return { ok: false, code: continuationRead.error.code === "storage_failure" ? "STORAGE_FAILURE" : "ROOT_AUTHORITY_INVALID" };
		}
		continuation = continuationRead.value;
		const continuationLineage = parseDelegationRepairLineageV1(continuation.state.repair_lineage);
		if (continuation.state.delegation_id !== lineage.continuation_decision_delegation_id ||
			continuationLineage === undefined || continuationLineage.root_delegation_id !== lineage.root_delegation_id ||
			continuationLineage.root_decision_hash !== lineage.root_decision_hash) {
			return { ok: false, code: "ROOT_AUTHORITY_INVALID" };
		}
		const decision = await readCommittedDecision({ projectRoot, committed: continuation, readers });
		if (!decision.ok) return { ok: false, code: decision.storage ? "STORAGE_FAILURE" : "ROOT_AUTHORITY_INVALID" };
		continuationDecision = decision;
	}
	if (continuationDecision.decision.decision_hash !== lineage.continuation_decision_hash) {
		return { ok: false, code: "ROOT_AUTHORITY_INVALID" };
	}
	const priorContract = reboundRootContract(root, lineage.repair_of);
	if (!priorContract.ok || priorContract.value.contract_hash !== tip.contract_hash ||
		!sameStrings(priorContract.value.allowed_paths, tip.allowed_paths)) {
		return { ok: false, code: "CONTRACT_RECOVERY_FAILED" };
	}
	const arguments_ = toolArguments(root, tip.delegation_id);
	if (arguments_ === undefined || !sameStrings(arguments_.allowed_paths, tip.allowed_paths)) {
		return { ok: false, code: "CONTRACT_RECOVERY_FAILED" };
	}
	const successorLineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: lineage.root_delegation_id,
		repair_of: tip.delegation_id,
		root_decision_hash: lineage.root_decision_hash,
		continuation_decision_delegation_id: lineage.continuation_decision_delegation_id,
		continuation_decision_hash: lineage.continuation_decision_hash,
		parent_lineage_hash: lineage.lineage_hash,
		depth: lineage.depth + 1,
		carried_paths: [...lineage.carried_paths],
	});
	if (successorLineage === undefined) return { ok: false, code: "AUTHORITY_CHANGED" };
	const projection = {
		repair_of: tip.delegation_id,
		arguments: arguments_,
		successor_lineage: successorLineage,
		root_delegation_id: root.state.delegation_id,
		root_authority_kind: rootDecision.kind,
		root_transaction_hash: canonicalHash(root.state),
		root_proof_content_hash: root.proof.content_hash,
		root_decision_hash: rootDecision.decision.decision_hash,
		continuation_decision_delegation_id: continuation.state.delegation_id,
		continuation_decision_proof_content_hash: continuation.proof.content_hash,
		continuation_decision_hash: continuationDecision.decision.decision_hash,
		continuation_expected_binding_hash: continuationDecision.decision.expected_bound_diff_hash,
		lineage_hash: lineage.lineage_hash,
		raw_tip_transaction_hash: canonicalHash(tip),
		raw_tip_evidence_hash: (evidence.value as StrictRetryableRawRepairEvidenceV1).evidence_hash,
	};
	return {
		ok: true,
		value: Object.freeze({ ...projection, parent: tip, immutable_hash: canonicalHash(projection) }),
	};
}

/**
 * Recover an exact successor only from the unique unresolved raw tip.  The
 * locator is never used as authority: every transaction, root decision,
 * no-write envelope, contract and current binding is read again from disk.
 */
export async function recoverRawLineageExactRepairAuthorityV1(input: {
	readonly project_root: string;
	readonly repair_of: string;
	readonly collectCurrentBinding: (
		projectRoot: string,
		delegationId: string,
	) => Promise<RawLineageCurrentBindingV1>;
}, readers: RawLineageExactRepairAuthorityReadersV1 = DEFAULT_READERS): Promise<RecoverRawLineageExactRepairAuthorityResultV1> {
	const closure = await readers.readClosure(input.project_root);
	if (!closure.ok && !isDelegationPathLaneBypassableProjectIssueV1(closure.issue.code)) {
		return { ok: false, code: closure.issue.code === "storage_failure" ? "STORAGE_FAILURE" : "PROJECT_CLOSURE_INVALID" };
	}
	const immutable = await readRawLineageImmutableRepairV1(input.project_root, input.repair_of, readers);
	if (!immutable.ok) return immutable;
	const admission = await readers.admitPathLane({
		project_root: input.project_root,
		allowed_paths: immutable.value.arguments.allowed_paths,
		repair_tip_exclusion_id: immutable.value.repair_of,
	});
	if (admission.decision.decision !== "ALLOW" || admission.repair_tip_exclusion_id !== immutable.value.repair_of ||
		!admission.repair_tip_ids.includes(immutable.value.repair_of)) {
		return { ok: false, code: "PROJECT_CLOSURE_INVALID" };
	}
	const binding = await input.collectCurrentBinding(input.project_root, immutable.value.continuation_decision_delegation_id);
	if (binding.status !== "fresh" || typeof binding.hash !== "string" || !/^[a-f0-9]{64}$/u.test(binding.hash) ||
		binding.hash !== immutable.value.continuation_expected_binding_hash) {
		return { ok: false, code: "CURRENT_BINDING_CHANGED" };
	}
	const closureProjection = closure.ok ? {
		schema_version: 1 as const,
		kind: "raw-lineage-project-closure-v1" as const,
		status: "closed-scan" as const,
		unresolved_tip_id: closure.unresolvedTipId,
		root_count: closure.rootCount,
		lineage_count: closure.lineageCount,
	} : {
		schema_version: 1 as const,
		kind: "raw-lineage-project-closure-v1" as const,
		status: "historical-multiplicity" as const,
		issue_code: closure.issue.code,
		issue_delegation_id: closure.issue.delegationId ?? null,
	};
	const projection = {
		schema_version: 1 as const,
		kind: EXACT_REPAIR_COMMAND_EXECUTION_KIND_V1,
		repair_of: immutable.value.repair_of,
		committed_proof_content_hash: immutable.value.root_proof_content_hash,
		arguments: immutable.value.arguments,
		successor_lineage: immutable.value.successor_lineage,
		authority_kind: "raw-lineage-retry" as const,
		root_delegation_id: immutable.value.root_delegation_id,
		root_authority_kind: immutable.value.root_authority_kind,
		root_transaction_hash: immutable.value.root_transaction_hash,
		root_decision_hash: immutable.value.root_decision_hash,
		continuation_decision_delegation_id: immutable.value.continuation_decision_delegation_id,
		continuation_decision_proof_content_hash: immutable.value.continuation_decision_proof_content_hash,
		continuation_decision_hash: immutable.value.continuation_decision_hash,
		lineage_hash: immutable.value.lineage_hash,
		raw_tip_transaction_hash: immutable.value.raw_tip_transaction_hash,
		raw_tip_evidence_hash: immutable.value.raw_tip_evidence_hash,
		expected_current_binding_hash: binding.hash,
		closure_root_count: closure.ok ? closure.rootCount : null,
		closure_lineage_count: closure.ok ? closure.lineageCount : null,
		closure_hash: canonicalHash(closureProjection),
		path_admission_authority_hash: admission.authority_hash,
	};
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

/** Locked TOCTOU seam: no mutation may proceed when any durable fact moved. */
export async function revalidateRawLineageExactRepairAuthorityV1(input: {
	readonly project_root: string;
	readonly authority: ExactRepairRawLineageAuthorityV1;
	readonly collectCurrentBinding: (
		projectRoot: string,
		delegationId: string,
	) => Promise<RawLineageCurrentBindingV1>;
}, readers: RawLineageExactRepairAuthorityReadersV1 = DEFAULT_READERS): Promise<boolean> {
	const recovered = await recoverRawLineageExactRepairAuthorityV1({
		project_root: input.project_root,
		repair_of: input.authority.repair_of,
		collectCurrentBinding: input.collectCurrentBinding,
	}, readers);
	return recovered.ok && canonicalHash(recovered.value) === canonicalHash(input.authority);
}
