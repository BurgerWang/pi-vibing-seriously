/** One-review/one-successor delivery-chain coordinator. */

import {
	repairDelegationToolActionV1,
	reviewDelegationToolActionV1,
} from "./agent-next-action.ts";

import {
	runAutomaticSemanticReview,
	type AutomaticSemanticReviewInput,
	type AutomaticSemanticReviewDurableResult,
	type AutomaticSemanticReviewResult,
} from "./automatic-semantic-review-service.ts";
import {
	type ExactRepairServiceInputV1,
	type ExactRepairServiceResultV1,
	type ExactRepairServiceRunnerV1,
	type ExactRepairSuccessorRecordedV1,
	exactRepairSuccessorNextActionV1,
} from "./exact-repair-service.ts";

export const DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1 = 1 as const;

export interface DeliveryChainParentSettledAuthorityV1 {
	readonly schema_version: 1;
	readonly project_root: string;
	readonly delegation_id: string;
	readonly bound_diff_hash: string;
	readonly parent_lineage_depth: 0;
	readonly authority_confirmed: true;
	readonly no_active_lane: true;
}

export type DeliveryChainParentSettledCheckResultV1 =
	| { readonly ok: true; readonly value: Readonly<DeliveryChainParentSettledAuthorityV1> }
	| { readonly ok: false; readonly code: string };

export interface DeliveryChainCoordinatorInputV1 {
	readonly review: AutomaticSemanticReviewInput;
	readonly exact_repair_execution: Pick<
		ExactRepairServiceInputV1,
		"signal" | "on_update" | "execution_context"
	>;
	readonly max_successor_attempts: typeof DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1;
}

export interface DeliveryChainCoordinatorDependenciesV1 {
	readonly review?: typeof runAutomaticSemanticReview;
	/**
	 * Lifecycle-owned seam called only after normal tool_result/agent_settled
	 * cleanup. It strictly proves the parent authority and the absence of an
	 * active checkout lane; it never releases or borrows a live parent token.
	 */
	readonly confirmParentSettled: (input: {
		readonly project_root: string;
		readonly delegation_id: string;
		readonly bound_diff_hash: string;
		readonly required_parent_lineage_depth: 0;
	}) => Promise<DeliveryChainParentSettledCheckResultV1>;
	/** Strict exact-repair service with production dependencies already bound. */
	readonly repair: ExactRepairServiceRunnerV1;
}

interface DeliveryChainBaseResultV1 {
	readonly delegation_id: string;
	readonly max_successor_attempts: typeof DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1;
	readonly successor_attempts_used: 0 | 1;
}

type AutomaticSemanticAcceptResultV1 = AutomaticSemanticReviewDurableResult & {
	readonly status: "ACCEPT";
};

type AutomaticSemanticRepairResultV1 = AutomaticSemanticReviewDurableResult & {
	readonly status: "REPAIR";
};

export interface DeliveryChainAcceptResultV1 extends DeliveryChainBaseResultV1 {
	readonly status: "ACCEPT";
	readonly successor_attempts_used: 0;
	readonly review: AutomaticSemanticAcceptResultV1;
}

export interface DeliveryChainReviewRetryResultV1 extends DeliveryChainBaseResultV1 {
	readonly status: "REVIEW_RETRYABLE";
	readonly successor_attempts_used: 0;
	readonly review: Extract<AutomaticSemanticReviewResult, { status: "RETRYABLE_FAILURE" }>;
	readonly next_action: string;
}

export interface DeliveryChainAuthorityErrorResultV1 extends DeliveryChainBaseResultV1 {
	readonly status: "AUTHORITY_ERROR";
	readonly successor_attempts_used: 0;
	readonly code: "INVALID_MAX_SUCCESSOR_ATTEMPTS" | "REVIEW_RESULT_INVALID" | "REVIEW_SERVICE_FAILED";
	readonly review?: AutomaticSemanticReviewResult;
	readonly next_action: string;
}

export interface DeliveryChainSuccessorResultV1 extends DeliveryChainBaseResultV1 {
	readonly status: "SUCCESSOR_RECORDED";
	readonly successor_attempts_used: 1;
	readonly review: AutomaticSemanticRepairResultV1;
	readonly repair: ExactRepairSuccessorRecordedV1;
}

export interface DeliveryChainRepairPendingResultV1 extends DeliveryChainBaseResultV1 {
	readonly status: "REPAIR_PENDING";
	readonly successor_attempts_used: 0 | 1;
	readonly code:
		| "PARENT_OPERATION_NOT_SETTLED"
		| "PARENT_SETTLED_AUTHORITY_INVALID"
		| "EXACT_REPAIR_SERVICE_FAILED"
		| "EXACT_REPAIR_RESULT_INVALID";
	readonly review: AutomaticSemanticRepairResultV1;
	readonly repair?: ExactRepairServiceResultV1;
	readonly next_action: string;
}

export type DeliveryChainCoordinatorResultV1 =
	| DeliveryChainAcceptResultV1
	| DeliveryChainReviewRetryResultV1
	| DeliveryChainAuthorityErrorResultV1
	| DeliveryChainSuccessorResultV1
	| DeliveryChainRepairPendingResultV1;

const SHA256_RE = /^[a-f0-9]{64}$/u;

function exactRepairDispositionNextAction(
	repair: ExactRepairServiceResultV1,
	parentDelegationId: string,
): string {
	const successorAction = "successor" in repair ? exactRepairSuccessorNextActionV1(repair.successor) : null;
	return successorAction ?? repairDelegationToolActionV1(parentDelegationId);
}

function validDurableReviewResult(
	result: AutomaticSemanticReviewResult,
	delegationId: string,
): boolean {
	if (result.delegation_id !== delegationId) return false;
	if (result.status !== "ACCEPT" && result.status !== "REPAIR") return true;
	return result.durable === true && SHA256_RE.test(result.bound_diff_hash) &&
		(result.status !== "REPAIR" || result.next_action === repairDelegationToolActionV1(delegationId));
}

function isAcceptResult(result: AutomaticSemanticReviewResult): result is AutomaticSemanticAcceptResultV1 {
	return result.status === "ACCEPT";
}

function isRepairResult(result: AutomaticSemanticReviewResult): result is AutomaticSemanticRepairResultV1 {
	return result.status === "REPAIR";
}

/**
 * Run at most one automatic successor attempt. The exact repair execution
 * includes the child's normal delivery/review path, but this coordinator never
 * recurses: a second durable REPAIR remains an explicit child repair-tool call.
 */
export async function coordinateDeliveryChainV1(
	input: DeliveryChainCoordinatorInputV1,
	dependencies: DeliveryChainCoordinatorDependenciesV1,
): Promise<DeliveryChainCoordinatorResultV1> {
	const delegationId = input.review.delegation_id;
	const base = {
		delegation_id: delegationId,
		max_successor_attempts: DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
	} as const;
	if (input.max_successor_attempts !== DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1) {
		return {
			...base,
			status: "AUTHORITY_ERROR",
			code: "INVALID_MAX_SUCCESSOR_ATTEMPTS",
			successor_attempts_used: 0,
			next_action: reviewDelegationToolActionV1(delegationId),
		};
	}

	let review: AutomaticSemanticReviewResult;
	try {
		review = await (dependencies.review ?? runAutomaticSemanticReview)(input.review);
	} catch {
		return {
			...base,
			status: "AUTHORITY_ERROR",
			code: "REVIEW_SERVICE_FAILED",
			successor_attempts_used: 0,
			next_action: reviewDelegationToolActionV1(delegationId),
		};
	}
	if (!validDurableReviewResult(review, delegationId)) {
		return {
			...base,
			status: "AUTHORITY_ERROR",
			code: "REVIEW_RESULT_INVALID",
			successor_attempts_used: 0,
			review,
			next_action: reviewDelegationToolActionV1(delegationId),
		};
	}
	if (isAcceptResult(review)) {
		return { ...base, status: "ACCEPT", successor_attempts_used: 0, review };
	}
	if (review.status === "RETRYABLE_FAILURE") {
		return {
			...base,
			status: "REVIEW_RETRYABLE",
			successor_attempts_used: 0,
			review,
			next_action: review.next_action,
		};
	}
	if (review.status === "AUTHORITY_ERROR") {
		return {
			...base,
			status: "AUTHORITY_ERROR",
			code: "REVIEW_RESULT_INVALID",
			successor_attempts_used: 0,
			review,
			next_action: review.next_action,
		};
	}
	if (!isRepairResult(review)) {
		return {
			...base,
			status: "AUTHORITY_ERROR",
			code: "REVIEW_RESULT_INVALID",
			successor_attempts_used: 0,
			review,
			next_action: reviewDelegationToolActionV1(delegationId),
		};
	}

	let settled: DeliveryChainParentSettledCheckResultV1;
	try {
		settled = await dependencies.confirmParentSettled({
			project_root: input.review.project_root,
			delegation_id: delegationId,
			bound_diff_hash: review.bound_diff_hash,
			required_parent_lineage_depth: 0,
		});
	} catch {
		return {
			...base,
			status: "REPAIR_PENDING",
			code: "PARENT_OPERATION_NOT_SETTLED",
			successor_attempts_used: 0,
			review,
			next_action: repairDelegationToolActionV1(delegationId),
		};
	}
	if (!settled.ok) {
		return {
			...base,
			status: "REPAIR_PENDING",
			code: "PARENT_OPERATION_NOT_SETTLED",
			successor_attempts_used: 0,
			review,
			next_action: repairDelegationToolActionV1(delegationId),
		};
	}
	if (settled.value.schema_version !== 1 || settled.value.authority_confirmed !== true ||
		settled.value.no_active_lane !== true ||
		settled.value.project_root !== input.review.project_root ||
		settled.value.delegation_id !== delegationId || settled.value.bound_diff_hash !== review.bound_diff_hash ||
		settled.value.parent_lineage_depth !== 0) {
		return {
			...base,
			status: "REPAIR_PENDING",
			code: "PARENT_SETTLED_AUTHORITY_INVALID",
			successor_attempts_used: 0,
			review,
			next_action: repairDelegationToolActionV1(delegationId),
		};
	}

	let repair: ExactRepairServiceResultV1;
	try {
		repair = await dependencies.repair({
			project_root: input.review.project_root,
			repair_of: delegationId,
			...input.exact_repair_execution,
		});
	} catch {
		return {
			...base,
			status: "REPAIR_PENDING",
			code: "EXACT_REPAIR_SERVICE_FAILED",
			successor_attempts_used: 1,
			review,
			next_action: repairDelegationToolActionV1(delegationId),
		};
	}
	if (repair.repair_of !== delegationId) {
		return {
			...base,
			status: "REPAIR_PENDING",
			code: "EXACT_REPAIR_RESULT_INVALID",
			successor_attempts_used: 1,
			review,
			repair,
			next_action: repairDelegationToolActionV1(delegationId),
		};
	}
	if (repair.status === "SUCCESSOR_RECORDED" &&
		(repair.successor.disposition === "REVIEW_PENDING" ||
			repair.successor.disposition === "REPAIR_PENDING" ||
			repair.successor.disposition === "CHAIN_CLOSED")) {
		return {
			...base,
			status: "SUCCESSOR_RECORDED",
			successor_attempts_used: 1,
			review,
			repair,
		};
	}
	return {
		...base,
		status: "REPAIR_PENDING",
		code: repair.status === "SUCCESSOR_RECORDED"
			? "EXACT_REPAIR_RESULT_INVALID"
			: "EXACT_REPAIR_SERVICE_FAILED",
		successor_attempts_used: 1,
		review,
		repair,
		next_action: exactRepairDispositionNextAction(repair, delegationId),
	};
}
