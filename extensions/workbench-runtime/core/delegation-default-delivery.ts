/**
 * Fixed Sol -> Luna default delivery for successful implementation workers.
 *
 * The public runtime delegates execution once, then this boundary produces one
 * bounded scope/integrity actual-diff packet.  Any non-zero implementation
 * delta stays PENDING_REVIEW until Sol explicitly accepts the exact bound hash;
 * a mechanical PASS is never semantic quality or Gate authority.
 */

import type { ExecFn } from "./config.ts";
import {
	reviewDelegationV2,
	type DelegationReviewV2ErrorCode,
	type DelegationReviewV2Result,
} from "./delegation-review-v2.ts";
import {
	markReviewed,
	observeDiffChange,
	type DelegationState,
} from "./delegation-state.ts";
import {
	classifySemanticReviewRisk,
	isScopeIntegrityPacketComplete,
	type SemanticReviewRisk,
} from "./diff-review.ts";

/** Leaves room for the fixed worker handoff facts inside its 12 KiB/120-line cap. */
export const DEFAULT_DELIVERY_REVIEW_MAX_LINES = 56 as const;
export const DEFAULT_DELIVERY_REVIEW_MAX_BYTES = 5_120 as const;
/** Compatibility export: default delivery intentionally emits one packet only. */
export const DEFAULT_DELIVERY_REVIEW_MAX_SEGMENTS = 1 as const;

export type DefaultDelegationDeliveryErrorCode =
	| "review_failed"
	| "review_incomplete"
	| "state_transition_failed"
	| "session_persistence_failed";

export interface CompleteDefaultDelegationDeliveryV2Input {
	projectRoot: string;
	delegationId: string;
	changedPaths: readonly string[];
	state: DelegationState;
	exec: ExecFn;
	secrets?: readonly string[];
	now: string;
	persistState: (state: DelegationState) => void;
}

export interface CompleteDefaultDelegationDeliveryV2Dependencies {
	review?: typeof reviewDelegationV2;
}

export interface DefaultDelegationDeliveryV2Success {
	ok: true;
	state: DelegationState;
	review: Extract<DelegationReviewV2Result, { ok: true }>;
	review_kind: "scope_integrity";
	scope_integrity_verdict: "PASS" | "FAIL";
	presentation_complete: boolean;
	semantic_review: "required" | "not_required";
	semantic_risk: SemanticReviewRisk;
}

export interface DefaultDelegationDeliveryV2Failure {
	ok: false;
	code: DefaultDelegationDeliveryErrorCode;
	state: DelegationState;
	review_error?: DelegationReviewV2ErrorCode;
	review_path?: string;
}

export type DefaultDelegationDeliveryV2Result =
	| DefaultDelegationDeliveryV2Success
	| DefaultDelegationDeliveryV2Failure;

function persistProjected(
	input: CompleteDefaultDelegationDeliveryV2Input,
	projected: DelegationState,
): DefaultDelegationDeliveryV2Failure | undefined {
	if (projected === input.state) return undefined;
	try {
		input.persistState(projected);
		return undefined;
	} catch {
		return {
			ok: false,
			code: "session_persistence_failed",
			state: input.state,
		};
	}
}

/**
 * Produce one scope/integrity packet for an ordinary implementation delivery.
 *
 * No worker prose is accepted here.  A single, handoff-sized packet is
 * generated so Sol sees actual diff evidence in the delegate result itself.
 * Incomplete/truncated packets remain provisional and use the explicit review
 * tool for bounded follow-up segments.  Only a complete zero-delta packet may
 * close mechanically; every actual implementation delta remains pending for a
 * separate hash-bound Sol semantic ACCEPT.
 */
export async function completeDefaultDelegationDeliveryV2(
	input: CompleteDefaultDelegationDeliveryV2Input,
	dependencies: CompleteDefaultDelegationDeliveryV2Dependencies = {},
): Promise<DefaultDelegationDeliveryV2Result> {
	if (input.state.latestId !== input.delegationId) {
		return { ok: false, code: "state_transition_failed", state: input.state };
	}

	const runReview = dependencies.review ?? reviewDelegationV2;
	const review = await runReview({
		projectRoot: input.projectRoot,
		delegationId: input.delegationId,
		exec: input.exec,
		includePaths: [...input.changedPaths],
		maxLines: DEFAULT_DELIVERY_REVIEW_MAX_LINES,
		maxBytes: DEFAULT_DELIVERY_REVIEW_MAX_BYTES,
		...(input.secrets === undefined ? {} : { secrets: [...input.secrets] }),
		now: input.now,
	});
	let projected = input.state;
	if (!review.ok) {
		if (review.binding_hash !== undefined) projected = observeDiffChange(input.state, review.binding_hash, input.now);
		const persistenceFailure = persistProjected(input, projected);
		if (persistenceFailure !== undefined) return persistenceFailure;
		return { ok: false, code: "review_failed", state: projected, review_error: review.error.code };
	}
	const record = review.review.record;
	if (!review.review.ok || record === undefined) {
		return { ok: false, code: "review_failed", state: projected, review_path: review.review_path };
	}
	projected = observeDiffChange(input.state, record.bound_diff_hash, input.now);
	const semantic = classifySemanticReviewRisk(record.checked_paths);
	const presentationComplete = isScopeIntegrityPacketComplete(record);
	if (!semantic.required && presentationComplete && review.finalized && projected.status !== "REVIEWED") {
		const marked = markReviewed(projected, input.now);
		if (!marked.ok) {
			return { ok: false, code: "state_transition_failed", state: input.state, review_path: review.review_path };
		}
		projected = marked.state;
	}
	const persistenceFailure = persistProjected(input, projected);
	if (persistenceFailure !== undefined) return { ...persistenceFailure, review_path: review.review_path };
	return {
		ok: true,
		state: projected,
		review,
		review_kind: "scope_integrity",
		scope_integrity_verdict: record.verdict,
		presentation_complete: presentationComplete,
		semantic_review: semantic.required ? "required" : "not_required",
		semantic_risk: semantic.risk,
	};
}
