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
	STRUCTURED_SOL_REVIEW_BATCH_REQUEST_POLICY_HASH_V2,
	runStructuredSolReview,
	runStructuredSolReviewBatchedV2,
	type SemanticReviewProgressV2,
	type RunStructuredSolReviewInput,
	type StructuredSolReviewReceipt,
	type StructuredSolReviewTerminalCode,
} from "./structured-sol-review.ts";
import {
	buildSemanticReviewEvidenceV2,
	computeCrossFileAssessmentHashV2,
	planSemanticReviewInheritanceV2,
	type SemanticReviewDependencyEdgeV2,
	type SemanticReviewEvidenceV2,
	type SemanticReviewInheritancePlanV2,
} from "./semantic-review-evidence-v2.ts";
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

export interface CoordinateStructuredSolReviewV2Input extends CoordinateStructuredSolReviewInput {
	generation: number;
	generation_content_hash: string;
	runtime_build_identity: string;
	parent_evidence?: Readonly<SemanticReviewEvidenceV2> | null;
	lineage_contract_compatible?: boolean;
	declared_dependencies?: readonly SemanticReviewDependencyEdgeV2[];
	finding_paths?: readonly string[];
	scope_expansion?: boolean;
	unknown_paths?: readonly string[];
	binary_semantic_gaps?: readonly string[];
	capacity?: "ordinary" | "large";
	resume_progress?: Readonly<SemanticReviewProgressV2>;
	on_progress?: (progress: Readonly<SemanticReviewProgressV2>) => void | Promise<void>;
}

export type CoordinateStructuredSolReviewV2Result =
	| {
		status: "ACCEPT" | "REPAIR";
		evidence: Readonly<SemanticReviewEvidenceV2>;
		progress: Readonly<SemanticReviewProgressV2>;
		inheritance: Readonly<SemanticReviewInheritancePlanV2>;
		usage: Readonly<Usage>;
	}
	| {
		status: "RETRYABLE_FAILURE" | "SPLIT_REQUIRED";
		code: StructuredSolReviewCoordinatorFailureCode | "SPLIT_REQUIRED" | "PROGRESS_PERSISTENCE_FAILED";
		progress?: Readonly<SemanticReviewProgressV2>;
		inheritance?: Readonly<SemanticReviewInheritancePlanV2>;
		usage: Readonly<Usage>;
	};

export function deriveStructuredSolRepairAffectedPathsV2(input: {
	readonly status: "ACCEPT" | "REPAIR";
	readonly fresh_paths: readonly string[];
	readonly assessments_by_path: ReadonlyMap<string, readonly { readonly decision: "PASS" | "REPAIR"; readonly findings: readonly { readonly finding_id: string; readonly severity: "BLOCKING" | "ADVISORY" }[] }[]>;
	readonly blocking_finding_ids: readonly string[];
	readonly cross_blocking_finding_ids: readonly string[];
}): readonly string[] {
	if (input.status === "ACCEPT") return [];
	const pageBlockingIds = new Set<string>();
	const pageAffectedPaths = new Set<string>();
	for (const [path, assessments] of input.assessments_by_path) {
		let affected = false;
		for (const assessment of assessments) {
			if (assessment.decision === "REPAIR") affected = true;
			for (const finding of assessment.findings) {
				if (finding.severity !== "BLOCKING") continue;
				pageBlockingIds.add(finding.finding_id);
				affected = true;
			}
		}
		if (affected) pageAffectedPaths.add(path);
	}
	const crossBlockingIds = new Set(input.cross_blocking_finding_ids);
	const hasUnboundBlockingFinding = input.blocking_finding_ids.some((id) =>
		!pageBlockingIds.has(id) && !crossBlockingIds.has(id));
	if (crossBlockingIds.size > 0 || hasUnboundBlockingFinding || pageAffectedPaths.size === 0) {
		return [...new Set(input.fresh_paths)].sort();
	}
	return [...pageAffectedPaths].sort();
}

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

function semanticStreamIdV2(path: string, source: string): string {
	return canonicalHash({ schema_version: 2, kind: "semantic-review-stream-v2", path, source });
}

function canonicalCoordinatorTimeV2(input: CoordinateStructuredSolReviewV2Input): string {
	try {
		const value = (input.now ?? (() => new Date()))();
		return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : "1970-01-01T00:00:00.000Z";
	} catch {
		return "1970-01-01T00:00:00.000Z";
	}
}

/**
 * V2 coordinator: strict inheritance is decided before model work, only the
 * fresh delta is batched, and a new cross-file final decision is always made.
 */
export async function coordinateStructuredSolReviewV2(
	input: CoordinateStructuredSolReviewV2Input,
): Promise<CoordinateStructuredSolReviewV2Result> {
	const empty = zeroUsage();
	let snapshot: CoordinateStructuredSolReviewV2Input;
	try { snapshot = structuredClone(input) as CoordinateStructuredSolReviewV2Input; } catch { snapshot = input; }
	if (!validCommittedAuthority(snapshot) || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1
		|| !/^[0-9a-f]{64}$/u.test(snapshot.generation_content_hash)
		|| typeof snapshot.runtime_build_identity !== "string" || snapshot.runtime_build_identity.length === 0) {
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
	const roleByPath = new Map(snapshot.relevance_projection.entries.map((entry) => [entry.path, [...entry.roles]]));
	const currentStreams = before.value.streams.map((stream) => ({
		stream_id: semanticStreamIdV2(stream.path, stream.source),
		path: stream.path,
		content_hash: stream.stream_sha256,
		roles: roleByPath.get(stream.path) ?? [],
	}));
	const parent = snapshot.parent_evidence ?? null;
	const inheritance = planSemanticReviewInheritanceV2({
		current_streams: currentStreams,
		parent_evidence: parent,
		direct_parent_evidence_hash: parent?.evidence_hash ?? null,
		contract_hash: snapshot.contract.contract_hash,
		review_policy_hash: snapshot.resume_progress?.review_policy_hash ?? STRUCTURED_SOL_REVIEW_BATCH_REQUEST_POLICY_HASH_V2,
		model_identity: { provider: "openai-codex", model: "gpt-5.6-sol", api: "openai-codex-responses" },
		runtime_build_identity: snapshot.runtime_build_identity,
		lineage_contract_compatible: snapshot.lineage_contract_compatible,
		declared_dependencies: snapshot.declared_dependencies,
		finding_paths: snapshot.finding_paths,
		scope_expansion: snapshot.scope_expansion,
		unknown_paths: snapshot.unknown_paths,
		binary_semantic_gaps: snapshot.binary_semantic_gaps,
		relevance_projection_compatible: true,
		review_envelope_compatible: true,
	});
	const pathByStreamId = new Map(currentStreams.map((stream) => [stream.stream_id, stream.path]));
	const freshPaths = inheritance.fresh_stream_ids.map((id) => pathByStreamId.get(id)).filter((path): path is string => path !== undefined);
	const inheritedSummary = inheritance.inherited_streams.length === 0 || parent === null ? undefined : {
		parent_evidence_hash: parent.evidence_hash,
		inherited_stream_count: inheritance.inherited_streams.length,
		inherited_stream_set_hash: canonicalHash(inheritance.inherited_streams.map((stream) => stream.inheritance_proof_hash)),
		dependency_closure_hash: inheritance.dependency_closure_hash,
	};
	let review: Awaited<ReturnType<typeof runStructuredSolReviewBatchedV2>>;
	try {
		review = await runStructuredSolReviewBatchedV2({
			delegation_id: snapshot.delegation_id,
			generation: snapshot.generation,
			contract_hash: snapshot.contract.contract_hash,
			bound_diff_hash: snapshot.semantic_envelope.relevance_projection_hash,
			contract: snapshot.contract,
			relevance_projection: snapshot.relevance_projection,
			semantic_envelope: snapshot.semantic_envelope,
			streams: before.value.streams,
			pages: before.value.pages,
			fresh_paths: freshPaths,
			...(inheritedSummary === undefined ? {} : { inherited_proof_summary: inheritedSummary }),
			model_registry: snapshot.model_registry,
			signal: snapshot.signal,
			now: snapshot.now,
			capacity: snapshot.capacity,
			resume_progress: snapshot.resume_progress,
			on_progress: snapshot.on_progress,
		});
	} catch {
		return { status: "RETRYABLE_FAILURE", code: "REVIEW_RUNTIME_FAILURE", inheritance, usage: empty };
	}
	if (!("page_assessments" in review)) {
		return { status: review.status, code: review.code, progress: review.progress, inheritance, usage: review.usage };
	}
	const after = await collectStructuredReviewPresentationV1({
		projectRoot: snapshot.project_root,
		authority: snapshot.authority,
		exec: snapshot.exec,
		secrets: snapshot.secrets,
	});
	if (!after.ok || after.value.presentation_hash !== before.value.presentation_hash
		|| canonicalHash(after.value.semantic_envelope) !== canonicalHash(before.value.semantic_envelope)) {
		return { status: "RETRYABLE_FAILURE", code: "PRESENTATION_DRIFT", progress: review.progress, inheritance, usage: review.usage };
	}
	const freshPagePaths = before.value.pages.filter((page) => freshPaths.includes(page.path)).map((page) => page.path);
	const assessmentsByPath = new Map<string, typeof review.page_assessments>();
	for (const assessment of review.page_assessments) {
		const path = freshPagePaths[assessment.page_number - 1];
		if (path === undefined) return { status: "RETRYABLE_FAILURE", code: "PRESENTATION_DRIFT", progress: review.progress, inheritance, usage: review.usage };
		assessmentsByPath.set(path, [...(assessmentsByPath.get(path) ?? []), assessment]);
	}
	const freshStreams = before.value.streams.filter((stream) => freshPaths.includes(stream.path)).map((stream) => {
		const assessments = assessmentsByPath.get(stream.path) ?? [];
		const pageBindings = before.value.pages.filter((page) => page.path === stream.path).map(({ content: _content, ...binding }) => canonicalHash(binding)).sort();
		return {
			source: "FRESH" as const,
			stream_id: semanticStreamIdV2(stream.path, stream.source),
			path: stream.path,
			content_hash: stream.stream_sha256,
			page_binding_hashes: pageBindings,
			assessment_hash: canonicalHash(assessments),
			verdict: assessments.length === 0 ? "NOT_INSPECTED" as const
				: assessments.some((assessment) => assessment.decision === "REPAIR") ? "REPAIR" as const : "PASS" as const,
		};
	});
	const streams = [...freshStreams, ...inheritance.inherited_streams];
	const crossBlocking = review.final_assessment.cross_page_findings
		.filter((finding) => finding.severity === "BLOCKING").map((finding) => finding.finding_id);
	const blocking = [...review.final_assessment.blocking_finding_ids, ...crossBlocking].sort();
	const affectedPaths = deriveStructuredSolRepairAffectedPathsV2({
		status: review.status,
		fresh_paths: freshPaths,
		assessments_by_path: assessmentsByPath,
		blocking_finding_ids: blocking,
		cross_blocking_finding_ids: crossBlocking,
	});
	const crossPayload = {
		fresh: true as const,
		page_assessment_set_hash: canonicalHash({
			fresh: review.page_assessments,
			inherited: inheritance.inherited_streams.map((stream) => stream.inheritance_proof_hash),
		}),
		reviewed_stream_set_hash: snapshot.semantic_envelope.stream_set_hash,
		decision: review.status,
		blocking_finding_ids: blocking,
		affected_paths: affectedPaths,
		summary_hash: canonicalHash({ summary: review.final_assessment.summary }),
	};
	const crossFile = { ...crossPayload, assessment_hash: computeCrossFileAssessmentHashV2(crossPayload) };
	const evidence = buildSemanticReviewEvidenceV2({
		delegation_id: snapshot.delegation_id,
		generation: snapshot.generation,
		generation_content_hash: snapshot.generation_content_hash,
		contract_hash: snapshot.contract.contract_hash,
		bound_diff_hash: snapshot.semantic_envelope.relevance_projection_hash,
		relevance_projection_hash: snapshot.semantic_envelope.relevance_projection_hash,
		review_envelope_hash: canonicalHash(snapshot.semantic_envelope),
		review_policy_hash: review.progress.review_policy_hash,
		model_identity: { provider: "openai-codex", model: "gpt-5.6-sol", api: "openai-codex-responses" },
		runtime_build_identity: snapshot.runtime_build_identity,
		stream_set_hash: snapshot.semantic_envelope.stream_set_hash,
		parent_evidence_hash: parent?.evidence_hash ?? null,
		streams,
		cross_file_assessment: crossFile,
		final_decision: review.status,
		repair_reason: review.status === "REPAIR" ? review.final_assessment.repair_reason : null,
		nested_usage: review.usage,
		completed_at: canonicalCoordinatorTimeV2(snapshot),
	});
	return evidence.ok
		? { status: review.status, evidence: evidence.value, progress: review.progress, inheritance, usage: review.usage }
		: { status: "RETRYABLE_FAILURE", code: "COMMITTED_AUTHORITY_INVALID", progress: review.progress, inheritance, usage: review.usage };
}
