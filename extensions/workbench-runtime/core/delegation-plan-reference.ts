/**
 * Strict plan-reference projection from the existing delegation-v2 authority.
 *
 * This is a reader only. It creates no active-plan state, mirror, pointer, or
 * lifecycle. The latest delegation id is supplied by the established
 * delegation authority/session projection and the immutable committed
 * generation remains the sole source of the optional plan_ref contract.
 */

import {
	bindDelegationBoundedTaskContractV2,
	type DelegationBoundedTaskContractBindingV2,
} from "./delegation-transaction-artifacts.ts";
import { readDelegationCommittedGenerationV2 } from "./delegation-transaction-storage.ts";
import type { DelegationTransactionStatus } from "./delegation-transaction.ts";
import {
	readDelegationAuthorityObservationV2,
	readProjectDelegationRepairClosureV1,
} from "./delegation-project-authority.ts";
import type { DelegationState } from "./delegation-state.ts";
import { isStrictSemanticAcceptedOrZeroDelta } from "./diff-review.ts";
import type { WorkerFirstGateFacts } from "./gate-schema.ts";
import {
	planReferenceHash,
	requiredPlanGateIds,
	verifyCurrentPlanReference,
	type PlanReferenceV1,
} from "./plan-reference.ts";

export type DelegationPlanBlockedReason =
	| "plan-generation-invalid"
	| "plan-generation-not-reusable"
	| "plan-repair-lineage-mismatch"
	| "plan-contract-invalid"
	| "plan-reference-invalid"
	| "plan-reference-unsafe-path"
	| "plan-reference-unavailable"
	| "plan-reference-not-regular-file"
	| "plan-reference-too-large"
	| "plan-reference-changed-during-read"
	| "plan-reference-digest-mismatch";

export type DelegationPlanContractAuthority =
	| { status: "absent" }
	| {
		status: "present";
		reference: PlanReferenceV1;
		planReferenceHash: string;
		requiredGateIds: string[];
		generationStatus: DelegationTransactionStatus;
	}
	| { status: "blocked"; reason: DelegationPlanBlockedReason };

export type CurrentDelegationPlanAuthority =
	| { status: "absent" }
	| {
		status: "current";
		reference: PlanReferenceV1;
		planReferenceHash: string;
		requiredGateIds: string[];
	}
	| {
		status: "blocked";
		reason: DelegationPlanBlockedReason;
		planReferenceHash: string | null;
		requiredGateIds: string[];
	};

function blocked(reason: DelegationPlanBlockedReason): DelegationPlanContractAuthority {
	return { status: "blocked", reason };
}

/**
 * Read the exact optional plan_ref from one immutable committed generation.
 * A missing generation is compatible with legacy/v1 or before-worker terminal
 * delegations and therefore projects no plan. Any other strict-read or
 * contract/hash contradiction fails closed.
 */
export async function readDelegationPlanContractAuthority(
	projectRoot: string,
	delegationId: string | null | undefined,
): Promise<DelegationPlanContractAuthority> {
	if (delegationId === null || delegationId === undefined) return { status: "absent" };
	const generation = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	if (!generation.ok) {
		return generation.error.code === "not_found"
			? { status: "absent" }
			: blocked("plan-generation-invalid");
	}
	const before = generation.value.records["before.json"];
	if (before === null || typeof before !== "object" || Array.isArray(before)) return blocked("plan-contract-invalid");
	const contract = (before as Record<string, unknown>).contract;
	if (contract === null || typeof contract !== "object" || Array.isArray(contract)) return blocked("plan-contract-invalid");
	const { contract_hash: suppliedHash, ...payload } = contract as Record<string, unknown>;
	const rebound = bindDelegationBoundedTaskContractV2(payload);
	if (!rebound.ok || suppliedHash !== rebound.value.contract_hash || suppliedHash !== generation.value.state.contract_hash) {
		return blocked("plan-contract-invalid");
	}
	const bound = rebound.value as DelegationBoundedTaskContractBindingV2;
	if (bound.plan_ref === undefined) return { status: "absent" };
	const hash = planReferenceHash(bound.plan_ref);
	const gates = requiredPlanGateIds(bound.plan_ref);
	if (hash === null || gates.length === 0) return blocked("plan-reference-invalid");
	return {
		status: "present",
		reference: bound.plan_ref,
		planReferenceHash: hash,
		requiredGateIds: gates,
		generationStatus: generation.value.state.status,
	};
}

function currentBlockedReason(code: string): DelegationPlanBlockedReason {
	switch (code) {
		case "unsafe_path": return "plan-reference-unsafe-path";
		case "not_regular_file": return "plan-reference-not-regular-file";
		case "too_large": return "plan-reference-too-large";
		case "changed_during_read": return "plan-reference-changed-during-read";
		case "digest_mismatch": return "plan-reference-digest-mismatch";
		case "invalid_reference": return "plan-reference-invalid";
		default: return "plan-reference-unavailable";
	}
}

/** Strict contract read plus a fresh contained current-byte verification. */
export async function readCurrentDelegationPlanAuthority(
	projectRoot: string,
	delegationId: string | null | undefined,
): Promise<CurrentDelegationPlanAuthority> {
	const contract = await readDelegationPlanContractAuthority(projectRoot, delegationId);
	if (contract.status === "blocked") {
		return { status: "blocked", reason: contract.reason, planReferenceHash: null, requiredGateIds: [] };
	}
	if (contract.status === "absent") {
		if (delegationId !== null && delegationId !== undefined) {
			const observation = await readDelegationAuthorityObservationV2(projectRoot, delegationId);
			if (observation.kind === "v2" && observation.repairLineage !== undefined) {
				const root = await readDelegationPlanContractAuthority(projectRoot, observation.repairLineage.rootDelegationId);
				if (root.status !== "absent") {
					return { status: "blocked", reason: "plan-repair-lineage-mismatch", planReferenceHash: null, requiredGateIds: [] };
				}
			}
		}
		return contract;
	}
	if (contract.generationStatus !== "FINISHED" && contract.generationStatus !== "REVIEWED") {
		return {
			status: "blocked",
			reason: "plan-generation-not-reusable",
			planReferenceHash: contract.planReferenceHash,
			requiredGateIds: [...contract.requiredGateIds],
		};
	}
	const observation = await readDelegationAuthorityObservationV2(projectRoot, delegationId!);
	const accepted = observation.kind === "v2" && observation.finalized &&
		(observation.transactionVerdict === "PASS" || (observation.review?.verdict === "PASS" && observation.semanticAccepted));
	if (!accepted) {
		return {
			status: "blocked",
			reason: "plan-generation-not-reusable",
			planReferenceHash: contract.planReferenceHash,
			requiredGateIds: [...contract.requiredGateIds],
		};
	}
	if (observation.kind === "v2" && observation.repairLineage !== undefined) {
		const root = await readDelegationPlanContractAuthority(projectRoot, observation.repairLineage.rootDelegationId);
		// Repair lineage preserves both plan presence and identity exactly. This
		// avoids a later retry silently adopting, dropping, or replacing the plan
		// that governed the rejected root delta.
		const samePlan = root.status === "present" && root.planReferenceHash === contract.planReferenceHash;
		if (!samePlan) {
			return {
				status: "blocked",
				reason: "plan-repair-lineage-mismatch",
				planReferenceHash: contract.status === "present" ? contract.planReferenceHash : null,
				requiredGateIds: contract.status === "present" ? [...contract.requiredGateIds] : [],
			};
		}
	}
	const current = await verifyCurrentPlanReference(projectRoot, contract.reference);
	if (!current.ok) {
		return {
			status: "blocked",
			reason: currentBlockedReason(current.error.code),
			planReferenceHash: contract.planReferenceHash,
			requiredGateIds: [...contract.requiredGateIds],
		};
	}
	return {
		status: "current",
		reference: current.value,
		planReferenceHash: contract.planReferenceHash,
		requiredGateIds: [...contract.requiredGateIds],
	};
}

/** Exact minimal facts copied into the bounded worker-first projection. */
export function delegationPlanWorkerFacts(authority: CurrentDelegationPlanAuthority): {
	planReferenceHash?: string;
	requiredGateIds?: string[];
	planReferenceCurrent?: boolean;
	planReferenceBlockedReason?: DelegationPlanBlockedReason;
} {
	if (authority.status === "absent") return {};
	return {
		...(authority.planReferenceHash === null ? {} : { planReferenceHash: authority.planReferenceHash }),
		...(authority.requiredGateIds.length === 0 ? {} : { requiredGateIds: [...authority.requiredGateIds] }),
		planReferenceCurrent: authority.status === "current",
		...(authority.status === "blocked" ? { planReferenceBlockedReason: authority.reason } : {}),
	};
}

type WorkerFirstRuntimeFacts = Pick<
	WorkerFirstGateFacts,
	| "actor"
	| "writePolicy"
	| "commanderWritesDenied"
	| "leaseStatus"
	| "leaseReason"
	| "leaseCallsUsed"
	| "leaseMaxCalls"
	| "gateRunInitiatedByCommander"
>;

export interface BuildDelegationWorkerFirstGateFactsInput {
	projectRoot: string;
	state: DelegationState;
	currentDiffHash: string | null;
	reviewBlock?: string;
	runtime: WorkerFirstRuntimeFacts;
}

/**
 * Build the bounded delegation/review/plan projection used by Gate execution
 * and read-only validation assessment. The composition root supplies only its
 * session-scoped actor/lease facts; durable authority is read here.
 */
export async function buildDelegationWorkerFirstGateFacts(
	input: BuildDelegationWorkerFirstGateFactsInput,
): Promise<WorkerFirstGateFacts> {
	const { projectRoot, state } = input;
	let reviewBlock = input.reviewBlock;
	let reviewVerdict: "PASS" | "FAIL" | null = null;
	let reviewViolationCount: number | null = null;
	const repairClosure = await readProjectDelegationRepairClosureV1(projectRoot);
	if (reviewBlock === undefined) {
		if (!repairClosure.ok) {
			reviewBlock = `delegation repair authority is ${repairClosure.issue.code}; verification fails closed`;
		} else if (repairClosure.unresolvedTipId !== null && repairClosure.unresolvedTipId !== state.latestId) {
			reviewBlock = `delegation ${repairClosure.unresolvedTipId} has an unresolved semantic repair; verification fails closed`;
		}
	}
	if (state.latestId !== undefined && reviewBlock === undefined) {
		const authority = await readDelegationAuthorityObservationV2(projectRoot, state.latestId);
		if (authority.kind === "invalid-v2") {
			reviewBlock = `delegation ${state.latestId} v2 authority is ${authority.code}; verification fails closed`;
		} else if (authority.kind === "legacy") {
			if (authority.zeroDelta && authority.review && isStrictSemanticAcceptedOrZeroDelta(authority.review)) {
				reviewVerdict = authority.review.verdict;
				reviewViolationCount = authority.review.violations.length;
			} else {
				reviewBlock = `delegation ${state.latestId} legacy review lacks strict semantic acceptance`;
			}
		} else if (authority.review && authority.finalized && authority.semanticAccepted) {
			reviewVerdict = authority.review.verdict;
			reviewViolationCount = authority.review.violations.length;
		} else if (authority.review && authority.finalized) {
			reviewBlock = `delegation ${state.latestId} finalized review lacks strict semantic acceptance`;
		} else if (authority.review) {
			reviewBlock = `delegation ${state.latestId} v2 review authority is provisional`;
		} else if (authority.transactionVerdict !== null) {
			reviewVerdict = authority.transactionVerdict;
			reviewViolationCount = authority.transactionVerdict === "PASS" ? 0 : 1;
		} else {
			reviewBlock = `delegation ${state.latestId} v2 review authority is not finalized`;
		}
	}
	const planAuthority = await readCurrentDelegationPlanAuthority(projectRoot, state.latestId);
	if (planAuthority.status === "blocked" && reviewBlock === undefined) {
		reviewBlock = `delegation plan authority is ${planAuthority.reason}; verification fails closed`;
	}
	return {
		schema_version: 1,
		blockedReason: reviewBlock,
		...input.runtime,
		blockedCommanderWriteAttempts: state.blockedWriteAttempts,
		hasDelegation: state.latestId !== undefined,
		latestDelegationId: state.latestId ?? null,
		reviewStatus: state.latestId !== undefined ? state.status : null,
		currentDiffHash: input.currentDiffHash,
		reviewedDiffHash: state.reviewedDiffHash ?? null,
		reviewVerdict,
		reviewViolationCount,
		...delegationPlanWorkerFacts(planAuthority),
	};
}
