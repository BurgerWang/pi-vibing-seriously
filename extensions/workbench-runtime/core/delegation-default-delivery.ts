/**
 * Optional development-first delivery for successful implementation workers.
 *
 * The public runtime delegates execution once, then this boundary produces one
 * bounded scope/integrity actual-diff packet, then invokes the structured Sol
 * reviewer when the packet is mechanically complete.  A non-zero delta stays
 * PENDING_REVIEW on any review failure and advances only after durable,
 * hash-bound Sol ACCEPT; a mechanical PASS is never semantic quality or Gate
 * authority.
 */

import type { ExecFn } from "./config.ts";
import { reviewDelegationToolActionV1 } from "./agent-next-action.ts";
import {
	reviewDelegationV2,
	type DelegationReviewV2ErrorCode,
	type DelegationReviewV2Result,
} from "./delegation-review-v2.ts";
import { readDelegationReviewV2 } from "./delegation-transaction-storage.ts";
import {
	markReviewed,
	markSemanticAccepted,
	observeDiffChange,
	type DelegationState,
} from "./delegation-state.ts";
import {
	classifySemanticReviewRisk,
	isScopeIntegrityPacketComplete,
	type SemanticReviewRisk,
} from "./diff-review.ts";
import {
	runAutomaticSemanticReview,
	type AutomaticSemanticReviewInput,
	type AutomaticSemanticReviewResult,
} from "./automatic-semantic-review-service.ts";

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
	/** Production supplies Pi's current registry; omission preserves test/manual compatibility. */
	modelRegistry?: AutomaticSemanticReviewInput["model_registry"];
	signal?: AbortSignal;
}

export interface CompleteDefaultDelegationDeliveryV2Dependencies {
	review?: typeof reviewDelegationV2;
	/** Fault-injection seam; production reads the just-persisted strict review. */
	readReview?: typeof readDelegationReviewV2;
	automaticSemanticReview?: typeof runAutomaticSemanticReview;
	/** Completion-boundary clock for automatic review timestamps. */
	now?: () => Date;
}

export interface DefaultDelegationDeliverySessionMirrorWarning {
	code: "session_mirror_append_failed";
	message: string;
	durable_readback: "confirmed" | "unavailable" | "mismatch";
	durable_transaction_status?: string;
	durable_review_finalized?: boolean;
}

export interface DefaultDelegationDeliveryV2Success {
	ok: true;
	state: DelegationState;
	review: Extract<DelegationReviewV2Result, { ok: true }>;
	review_kind: "scope_integrity";
	scope_integrity_verdict: "PASS" | "FAIL";
	presentation_complete: boolean;
	semantic_review: "accepted" | "repair_required" | "required" | "not_required";
	semantic_risk: SemanticReviewRisk;
	session_mirror_warning?: DefaultDelegationDeliverySessionMirrorWarning;
	automatic_semantic_review?: AutomaticSemanticReviewResult;
}

export interface DefaultDelegationDeliveryV2Failure {
	ok: false;
	code: DefaultDelegationDeliveryErrorCode;
	state: DelegationState;
	review_error?: DelegationReviewV2ErrorCode;
	review_path?: string;
	recovery: "authority_error" | "retryable";
	next_action?: string;
}

export type DefaultDelegationDeliveryV2Result =
	| DefaultDelegationDeliveryV2Success
	| DefaultDelegationDeliveryV2Failure;

async function persistProjected(
	input: CompleteDefaultDelegationDeliveryV2Input,
	projected: DelegationState,
	dependencies: CompleteDefaultDelegationDeliveryV2Dependencies,
	durableReview?: Extract<DelegationReviewV2Result, { ok: true }>,
): Promise<DefaultDelegationDeliveryV2Failure | DefaultDelegationDeliverySessionMirrorWarning | undefined> {
	if (projected === input.state) return undefined;
	try {
		input.persistState(projected);
		return undefined;
	} catch {
		// A successful review call has already atomically published project
		// authority. The append-only session entry is only a recoverable mirror:
		// its failure must not turn the completed durable operation into a tool
		// failure. Read the strict review back before returning so callers can
		// distinguish confirmed durable authority from a transient read fault.
		if (durableReview !== undefined) {
			const readReview = dependencies.readReview ?? readDelegationReviewV2;
			let warning: DefaultDelegationDeliverySessionMirrorWarning = {
				code: "session_mirror_append_failed",
				message: "durable review succeeded; session mirror append failed and will be reconciled from durable authority",
				durable_readback: "unavailable",
			};
			try {
				const readback = await readReview(input.projectRoot, input.delegationId);
				if (readback.ok) {
					const exact = readback.value.review_hash === durableReview.review_hash
						&& readback.value.review_path === durableReview.review_path
						&& readback.value.finalized === durableReview.finalized;
					warning = {
						...warning,
						durable_readback: exact ? "confirmed" : "mismatch",
						durable_transaction_status: readback.value.state.status,
						durable_review_finalized: readback.value.finalized,
					};
				}
			} catch {
				// Preserve the already-returned successful durable review result.
				// The explicit unavailable read-back fact remains visible to Sol.
			}
			return warning;
		}
		return {
			ok: false,
			code: "session_persistence_failed",
			state: input.state,
			recovery: "retryable",
			next_action: reviewDelegationToolActionV1(input.delegationId),
		};
	}
}

/**
 * Produce one scope/integrity packet for an ordinary implementation delivery.
 *
 * No worker prose is accepted here.  A single, handoff-sized packet is
 * generated so Sol sees actual diff evidence in the delegate result itself.
 * Incomplete/truncated packets remain provisional and use the deterministic
 * q-review service for bounded follow-up segments.  Only a complete zero-delta
 * packet may close mechanically; every actual implementation delta requires a
 * durable hash-bound Sol semantic ACCEPT.
 */
export async function completeDefaultDelegationDeliveryV2(
	input: CompleteDefaultDelegationDeliveryV2Input,
	dependencies: CompleteDefaultDelegationDeliveryV2Dependencies = {},
): Promise<DefaultDelegationDeliveryV2Result> {
	const completionClock = dependencies.now ?? (() => new Date());
	if (input.state.latestId !== input.delegationId) {
		return { ok: false, code: "state_transition_failed", state: input.state, recovery: "authority_error" };
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
		const persistenceFailure = await persistProjected(input, projected, dependencies);
		if (persistenceFailure !== undefined) {
			return "ok" in persistenceFailure
				? persistenceFailure
				: { ok: false, code: "session_persistence_failed", state: input.state, recovery: "retryable", next_action: reviewDelegationToolActionV1(input.delegationId) };
		}
		const authorityError = review.error.code === "authority_invalid" || review.error.code === "invalid_state";
		return {
			ok: false,
			code: "review_failed",
			state: projected,
			review_error: review.error.code,
			recovery: authorityError ? "authority_error" : "retryable",
			...(authorityError ? {} : { next_action: reviewDelegationToolActionV1(input.delegationId) }),
		};
	}
	let effectiveReview = review;
	let record = review.review.record;
	if (!review.review.ok || record === undefined) {
		return { ok: false, code: "review_failed", state: projected, review_path: review.review_path, recovery: "retryable", next_action: reviewDelegationToolActionV1(input.delegationId) };
	}
	projected = observeDiffChange(input.state, record.bound_diff_hash, input.now);
	const semantic = classifySemanticReviewRisk(record.checked_paths);
	let presentationComplete = isScopeIntegrityPacketComplete(record);
	let automaticSemanticReview: AutomaticSemanticReviewResult | undefined;
	if (record.verdict === "FAIL") {
		automaticSemanticReview = {
			status: "RETRYABLE_FAILURE",
			code: "MECHANICAL_SCOPE_INTEGRITY_FAILED",
			delegation_id: input.delegationId,
			bound_diff_hash: record.bound_diff_hash,
			nested_usage: Object.freeze({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
			}),
			mechanical_page_calls: 0,
			next_action: reviewDelegationToolActionV1(input.delegationId),
		};
	} else if (semantic.required && input.modelRegistry !== undefined
		&& record.semantic_review !== "accepted") {
		const runAutomatic = dependencies.automaticSemanticReview ?? runAutomaticSemanticReview;
		automaticSemanticReview = await runAutomatic({
			project_root: input.projectRoot,
			delegation_id: input.delegationId,
			exec: input.exec,
			model_registry: input.modelRegistry,
			...(input.secrets === undefined ? {} : { secrets: [...input.secrets] }),
			...(input.signal === undefined ? {} : { signal: input.signal }),
			now: completionClock,
		});
		if (automaticSemanticReview.status === "ACCEPT" || automaticSemanticReview.status === "REPAIR") {
			presentationComplete = true;
		}
		if (automaticSemanticReview.status === "AUTHORITY_ERROR") {
			return {
				ok: false,
				code: "review_failed",
				state: projected,
				review_path: review.review_path,
				recovery: "authority_error",
			};
		}
		if (automaticSemanticReview.status !== "RETRYABLE_FAILURE" && automaticSemanticReview.review_result !== undefined) {
			effectiveReview = automaticSemanticReview.review_result;
			record = effectiveReview.review.record;
			if (record === undefined) {
				return { ok: false, code: "review_failed", state: projected, review_path: review.review_path, recovery: "authority_error" };
			}
			projected = observeDiffChange(projected, record.bound_diff_hash, input.now);
			presentationComplete = isScopeIntegrityPacketComplete(record);
		}
		if (automaticSemanticReview.status === "ACCEPT" && projected.status !== "REVIEWED") {
			let acceptedAt: string;
			try {
				const completed = completionClock();
				acceptedAt = completed instanceof Date && Number.isFinite(completed.getTime())
					? completed.toISOString()
					: new Date().toISOString();
			} catch {
				acceptedAt = new Date().toISOString();
			}
			const marked = markSemanticAccepted(projected, {
				delegationId: input.delegationId,
				expectedDiffHash: automaticSemanticReview.bound_diff_hash,
				now: acceptedAt,
			});
			if (!marked.ok) {
				return { ok: false, code: "state_transition_failed", state: input.state, review_path: effectiveReview.review_path, recovery: "authority_error" };
			}
			projected = marked.state;
		}
	}
	if (!semantic.required && presentationComplete && review.finalized && projected.status !== "REVIEWED") {
		const marked = markReviewed(projected, input.now);
		if (!marked.ok) {
			return { ok: false, code: "state_transition_failed", state: input.state, review_path: review.review_path, recovery: "authority_error" };
		}
		projected = marked.state;
	}
	const persistenceResult = await persistProjected(input, projected, dependencies, effectiveReview);
	if (persistenceResult !== undefined && "ok" in persistenceResult) {
		return { ...persistenceResult, review_path: review.review_path };
	}
	return {
		ok: true,
		state: projected,
		review: effectiveReview,
		review_kind: "scope_integrity",
		scope_integrity_verdict: record.verdict,
		presentation_complete: presentationComplete,
		semantic_review: automaticSemanticReview?.status === "ACCEPT"
			? "accepted"
			: automaticSemanticReview?.status === "REPAIR"
				? "repair_required"
				: semantic.required ? "required" : "not_required",
		semantic_risk: semantic.risk,
		...(automaticSemanticReview === undefined ? {} : { automatic_semantic_review: automaticSemanticReview }),
		...(persistenceResult === undefined ? {} : { session_mirror_warning: persistenceResult }),
	};
}
