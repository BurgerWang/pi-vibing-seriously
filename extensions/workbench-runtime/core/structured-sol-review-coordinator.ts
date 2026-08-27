/**
 * Storage-independent coordinator for automatic Sol semantic review.
 *
 * It snapshots committed authority, rebuilds the complete presentation,
 * invokes the structured reviewer, then rebuilds the presentation again
 * before exposing a semantic decision. Durable state advancement belongs to
 * the caller and must occur only after validating the returned receipt.
 */

import type { Usage } from "@earendil-works/pi-ai";

import { canonicalHash } from "../cache/canonical-hash.ts";
import {
	bindDelegationBoundedTaskContractV2,
	type DelegationBoundedTaskContractBindingV2,
	type DelegationBoundedTaskContractPayloadV2,
} from "./delegation-transaction-artifacts.ts";
import {
	collectStructuredReviewPresentationV1,
	type CollectStructuredReviewPresentationErrorCodeV1,
	type ReviewAuthorityFacts,
} from "./diff-review.ts";
import {
	computeReviewRelevanceProjectionHashV2,
	validateReviewRelevanceProjectionV2,
	type ReviewRelevanceProjectionV2,
} from "./review-relevance-v2.ts";
import {
	runStructuredSolReview,
	type RunStructuredSolReviewInput,
	type StructuredSolReviewReceipt,
	type StructuredSolReviewTerminalCode,
} from "./structured-sol-review.ts";
import {
	validateSemanticReviewEnvelopeV1,
	type SemanticReviewEnvelopeV1,
} from "./semantic-review-envelope.ts";
import type { ExecFn } from "./config.ts";

/** Conservative production ceiling; the structured core's 512 is parsing-only. */
export const AUTOMATIC_STRUCTURED_SOL_REVIEW_MAX_PAGES = 32 as const;

export type StructuredSolReviewCoordinatorFailureCode =
	| CollectStructuredReviewPresentationErrorCodeV1
	| StructuredSolReviewTerminalCode
	| "COMMITTED_AUTHORITY_INVALID"
	| "LEGACY_ENVELOPE_REQUIRES_MIGRATION"
	| "REVIEW_TOO_LARGE"
	| "PRESENTATION_DRIFT"
	| "REVIEW_RUNTIME_FAILURE";

export interface CoordinateStructuredSolReviewInput {
	project_root: string;
	delegation_id: string;
	contract: Readonly<DelegationBoundedTaskContractBindingV2>;
	relevance_projection: Readonly<ReviewRelevanceProjectionV2>;
	semantic_envelope: Readonly<SemanticReviewEnvelopeV1>;
	authority: Readonly<ReviewAuthorityFacts>;
	model_registry: RunStructuredSolReviewInput["model_registry"];
	exec: ExecFn;
	secrets?: readonly string[];
	signal?: AbortSignal;
	now?: () => Date;
}

export type CoordinateStructuredSolReviewResult =
	| {
		status: "ACCEPT";
		receipt: Readonly<StructuredSolReviewReceipt>;
		usage: Readonly<Usage>;
	}
	| {
		status: "REPAIR";
		receipt: Readonly<StructuredSolReviewReceipt>;
		usage: Readonly<Usage>;
	}
	| {
		status: "RETRYABLE_FAILURE";
		code: StructuredSolReviewCoordinatorFailureCode;
		presentation_error?: CollectStructuredReviewPresentationErrorCodeV1;
		attempt_receipt?: Readonly<StructuredSolReviewReceipt>;
		usage: Readonly<Usage>;
	};

export type CoordinateStructuredSolTerminalNegativeReviewResult =
	| Extract<CoordinateStructuredSolReviewResult, { status: "REPAIR" }>
	| Extract<CoordinateStructuredSolReviewResult, { status: "RETRYABLE_FAILURE" }>;

function zeroUsage(): Readonly<Usage> {
	return Object.freeze({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
	});
}

function validCommittedAuthority(input: CoordinateStructuredSolReviewInput): boolean {
	try {
		if (input.delegation_id !== input.authority.delegation_id
			|| input.contract.contract_hash !== input.relevance_projection.contract_hash
			|| input.relevance_projection.delegation_id !== input.delegation_id
			|| !validateReviewRelevanceProjectionV2(input.relevance_projection)
			|| !validateSemanticReviewEnvelopeV1(input.semantic_envelope)
			|| computeReviewRelevanceProjectionHashV2(input.relevance_projection) !== input.semantic_envelope.relevance_projection_hash
			|| canonicalHash(input.relevance_projection) !== canonicalHash(input.authority.relevance_projection)
			|| canonicalHash(input.semantic_envelope) !== canonicalHash(input.authority.review_envelope)) return false;
		const { contract_hash: suppliedHash, ...payload } = input.contract;
		const rebound = bindDelegationBoundedTaskContractV2(payload as DelegationBoundedTaskContractPayloadV2);
		return rebound.ok && rebound.value.contract_hash === suppliedHash
			&& canonicalHash(rebound.value) === canonicalHash(input.contract);
	} catch {
		return false;
	}
}

function snapshotInput(input: CoordinateStructuredSolReviewInput): CoordinateStructuredSolReviewInput {
	return {
		...input,
		contract: structuredClone(input.contract),
		relevance_projection: structuredClone(input.relevance_projection),
		semantic_envelope: structuredClone(input.semantic_envelope),
		authority: structuredClone(input.authority),
		secrets: input.secrets === undefined ? undefined : [...input.secrets],
	};
}

/**
 * Return ACCEPT/REPAIR only for a stable, completed semantic assessment.
 * Provider/protocol/presentation failures are operationally retryable and
 * can never be confused with a Sol semantic REPAIR decision.
 */
async function coordinateStructuredSolReviewInternal(
	input: CoordinateStructuredSolReviewInput,
	decisionConstraint?: "REPAIR_ONLY",
): Promise<CoordinateStructuredSolReviewResult> {
	const empty = zeroUsage();
	let snapshot: CoordinateStructuredSolReviewInput;
	try {
		snapshot = snapshotInput(input);
	} catch {
		return { status: "RETRYABLE_FAILURE", code: "COMMITTED_AUTHORITY_INVALID", usage: empty };
	}
	if (!validCommittedAuthority(snapshot)) {
		return { status: "RETRYABLE_FAILURE", code: "COMMITTED_AUTHORITY_INVALID", usage: empty };
	}
	const before = await collectStructuredReviewPresentationV1({
		projectRoot: snapshot.project_root,
		authority: snapshot.authority,
		exec: snapshot.exec,
		secrets: snapshot.secrets,
	});
	if (!before.ok) return { status: "RETRYABLE_FAILURE", code: before.code, usage: empty };
	if (before.value.envelope_compatibility !== "current") {
		return { status: "RETRYABLE_FAILURE", code: "LEGACY_ENVELOPE_REQUIRES_MIGRATION", usage: empty };
	}
	if (before.value.pages.length > AUTOMATIC_STRUCTURED_SOL_REVIEW_MAX_PAGES) {
		return { status: "RETRYABLE_FAILURE", code: "REVIEW_TOO_LARGE", usage: empty };
	}

	let review: Awaited<ReturnType<typeof runStructuredSolReview>>;
	try {
		review = await runStructuredSolReview({
			delegation_id: snapshot.delegation_id,
			contract_hash: snapshot.contract.contract_hash,
			bound_diff_hash: snapshot.semantic_envelope.relevance_projection_hash,
			contract: snapshot.contract,
			relevance_projection: snapshot.relevance_projection,
			semantic_envelope: snapshot.semantic_envelope,
			streams: before.value.streams,
			pages: before.value.pages,
			model_registry: snapshot.model_registry,
			signal: snapshot.signal,
			now: snapshot.now,
			...(decisionConstraint === undefined ? {} : { decision_constraint: decisionConstraint }),
		});
	} catch {
		return { status: "RETRYABLE_FAILURE", code: "REVIEW_RUNTIME_FAILURE", usage: empty };
	}

	const after = await collectStructuredReviewPresentationV1({
		projectRoot: snapshot.project_root,
		authority: snapshot.authority,
		exec: snapshot.exec,
		secrets: snapshot.secrets,
	});
	if (!after.ok) {
		return {
			status: "RETRYABLE_FAILURE",
			code: "PRESENTATION_DRIFT",
			presentation_error: after.code,
			...(review.receipt === undefined ? {} : { attempt_receipt: review.receipt }),
			usage: review.usage,
		};
	}
	if (after.value.presentation_hash !== before.value.presentation_hash
		|| canonicalHash(after.value.semantic_envelope) !== canonicalHash(before.value.semantic_envelope)) {
		return {
			status: "RETRYABLE_FAILURE",
			code: "PRESENTATION_DRIFT",
			...(review.receipt === undefined ? {} : { attempt_receipt: review.receipt }),
			usage: review.usage,
		};
	}
	if (!review.ok) {
		return {
			status: "RETRYABLE_FAILURE",
			code: review.code,
			...(review.receipt === undefined ? {} : { attempt_receipt: review.receipt }),
			usage: review.usage,
		};
	}
	if (decisionConstraint === "REPAIR_ONLY" && review.decision !== "REPAIR") {
		return {
			status: "RETRYABLE_FAILURE",
			code: "INVALID_TOOL_RESPONSE",
			attempt_receipt: review.receipt,
			usage: review.usage,
		};
	}
	return review.decision === "ACCEPT"
		? { status: "ACCEPT", receipt: review.receipt, usage: review.usage }
		: { status: "REPAIR", receipt: review.receipt, usage: review.usage };
}

export async function coordinateStructuredSolReview(
	input: CoordinateStructuredSolReviewInput,
): Promise<CoordinateStructuredSolReviewResult> {
	return coordinateStructuredSolReviewInternal(input);
}

/**
 * Terminal-negative variant whose final TypeBox tool and immutable receipt
 * both bind REPAIR_ONLY. It can never expose ACCEPT as a semantic outcome.
 */
export async function coordinateStructuredSolTerminalNegativeReview(
	input: CoordinateStructuredSolReviewInput,
): Promise<CoordinateStructuredSolTerminalNegativeReviewResult> {
	const result = await coordinateStructuredSolReviewInternal(input, "REPAIR_ONLY");
	return result.status === "ACCEPT"
		? { status: "RETRYABLE_FAILURE", code: "INVALID_TOOL_RESPONSE", attempt_receipt: result.receipt, usage: result.usage }
		: result;
}
