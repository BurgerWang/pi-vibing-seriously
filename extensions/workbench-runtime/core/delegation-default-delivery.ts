/**
 * Fixed Sol -> Luna default delivery for successful implementation workers.
 *
 * The public runtime delegates execution once, then this boundary performs the
 * ordinary actual-diff review and closes the session mirror when that review is
 * complete. The explicit review tool remains available for incomplete,
 * conflicting, or recovery cases.
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

export const DEFAULT_DELIVERY_REVIEW_MAX_LINES = 400 as const;
export const DEFAULT_DELIVERY_REVIEW_MAX_BYTES = 32_768 as const;

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
 * Review and close one ordinary successful implementation delivery.
 *
 * No worker prose is accepted here. Success requires the immutable v2 review
 * boundary to produce a finalized PASS with complete coverage. Large or
 * segmented reviews remain PENDING_REVIEW and use the explicit review tool as
 * a recovery path.
 */
export async function completeDefaultDelegationDeliveryV2(
	input: CompleteDefaultDelegationDeliveryV2Input,
	dependencies: CompleteDefaultDelegationDeliveryV2Dependencies = {},
): Promise<DefaultDelegationDeliveryV2Result> {
	if (input.state.latestId !== input.delegationId) {
		return { ok: false, code: "state_transition_failed", state: input.state };
	}

	const review = await (dependencies.review ?? reviewDelegationV2)({
		projectRoot: input.projectRoot,
		delegationId: input.delegationId,
		exec: input.exec,
		includePaths: [...input.changedPaths],
		maxLines: DEFAULT_DELIVERY_REVIEW_MAX_LINES,
		maxBytes: DEFAULT_DELIVERY_REVIEW_MAX_BYTES,
		...(input.secrets === undefined ? {} : { secrets: [...input.secrets] }),
		now: input.now,
	});

	if (!review.ok) {
		if (review.binding_hash !== undefined) {
			const projected = observeDiffChange(input.state, review.binding_hash, input.now);
			const persistenceFailure = persistProjected(input, projected);
			if (persistenceFailure !== undefined) return persistenceFailure;
		}
		return {
			ok: false,
			code: "review_failed",
			state: input.state,
			review_error: review.error.code,
		};
	}

	const record = review.review.record;
	if (!review.review.ok || record === undefined) {
		return {
			ok: false,
			code: "review_failed",
			state: input.state,
			review_path: review.review_path,
		};
	}

	let projected = observeDiffChange(input.state, record.bound_diff_hash, input.now);
	const complete = review.finalized
		&& record.verdict === "PASS"
		&& record.coverage_complete
		&& record.remaining_paths.length === 0;
	if (!complete) {
		const persistenceFailure = persistProjected(input, projected);
		if (persistenceFailure !== undefined) return persistenceFailure;
		return {
			ok: false,
			code: "review_incomplete",
			state: projected,
			review_path: review.review_path,
		};
	}

	if (projected.status !== "REVIEWED") {
		const marked = markReviewed(projected, input.now);
		if (!marked.ok) {
			return {
				ok: false,
				code: "state_transition_failed",
				state: input.state,
				review_path: review.review_path,
			};
		}
		projected = marked.state;
	}
	const persistenceFailure = persistProjected(input, projected);
	if (persistenceFailure !== undefined) {
		return { ...persistenceFailure, review_path: review.review_path };
	}
	return { ok: true, state: projected, review };
}
