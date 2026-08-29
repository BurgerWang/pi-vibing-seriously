/** Durable, idempotent orchestration for automatic Sol semantic review. */

import type { Usage } from "@earendil-works/pi-ai";
import { canonicalHash } from "../cache/canonical-hash.ts";
import {
	repairDelegationToolActionV1,
	reviewDelegationToolActionV1,
} from "./agent-next-action.ts";

import {
	DEFAULT_REVIEW_MAX_BYTES,
	DEFAULT_REVIEW_MAX_LINES,
	collectStructuredReviewPresentationV1,
	isScopeIntegrityPacketComplete,
	normalizeReviewPresentationCoverage,
	type ReviewRecord,
} from "./diff-review.ts";
import {
	committedStructuredReviewAuthorityV2,
	committedTerminalNegativeStructuredReviewAuthorityV1,
	reviewDelegationV2,
	type DelegationReviewV2Result,
} from "./delegation-review-v2.ts";
import {
	hasDelegationSemanticRepairAuthorityV2,
	hasDelegationSemanticReviewAuthorityV2,
	hasDelegationTerminalNegativeSemanticRepairAuthorityV1,
	isDelegationTerminalNegativeReviewEligibleFromCommittedV1,
	readDelegationCommittedGenerationV2,
	readDelegationSemanticReviewEvidenceV2,
	publishDelegationSemanticReviewEvidenceV2,
	publishDelegationSemanticReviewProgressV2,
	withDelegationSemanticReviewJobV2,
	readDelegationReviewV2,
	readDelegationTerminalNegativeReviewV1,
	type DelegationCommittedGenerationV2,
	type DelegationReviewAuthorityV2,
	type DelegationTerminalNegativeReviewAuthorityV1,
} from "./delegation-transaction-storage.ts";
import {
	AUTOMATIC_STRUCTURED_SOL_REVIEW_MAX_PAGES,
	coordinateStructuredSolReview,
	coordinateStructuredSolTerminalNegativeReview,
	coordinateStructuredSolReviewV2,
	type CoordinateStructuredSolReviewInput,
	type StructuredSolReviewCoordinatorFailureCode,
} from "./structured-sol-review-coordinator.ts";
import {
	completeSemanticReviewProgressV2,
	STRUCTURED_SOL_REVIEW_LARGE_JOB_MAX_PAGES_V2,
} from "./structured-sol-review.ts";
import { WORKBENCH_RUNTIME_BUILD_IDENTITY } from "./runtime-build-identity.ts";
import type {
	SemanticReviewDependencyEdgeV2,
	SemanticReviewEvidenceV2,
} from "./semantic-review-evidence-v2.ts";
import type { ReviewRelevanceProjectionV2 } from "./review-relevance-v2.ts";
import type { ExecFn } from "./config.ts";

export const AUTOMATIC_SEMANTIC_REVIEW_NEXT_ACTION = "workbench_review_worker_diff" as const;

export type AutomaticSemanticReviewRetryCode =
	| StructuredSolReviewCoordinatorFailureCode
	| "SPLIT_REQUIRED"
	| "PROGRESS_PERSISTENCE_FAILED"
	| "DURABLE_REVIEW_NOT_FOUND"
	| "MECHANICAL_SCOPE_INTEGRITY_FAILED"
	| "MECHANICAL_PRESENTATION_FAILED"
	| "MECHANICAL_PRESENTATION_STALLED"
	| "LINEAGE_PRESENTATION_GAP"
	| "DECISION_PERSISTENCE_FAILED"
	| "DECISION_READBACK_UNAVAILABLE";

export type AutomaticSemanticReviewAuthorityErrorCode =
	| "COMMITTED_AUTHORITY_UNAVAILABLE"
	| "COMMITTED_AUTHORITY_INVALID"
	| "DURABLE_REVIEW_INVALID";

export interface AutomaticSemanticReviewDurableResult {
	status: "ACCEPT" | "REPAIR";
	delegation_id: string;
	bound_diff_hash: string;
	durable: true;
	replayed: boolean;
	receipt_hash?: string;
	nested_usage: Readonly<Usage>;
	mechanical_page_calls: number;
	review_page_count?: number;
	review_batch_count?: number;
	final_model_calls?: number;
	raw_page_bytes_in_final?: number;
	fresh_stream_count?: number;
	inherited_stream_count?: number;
	next_action?: string;
	review_result?: Extract<DelegationReviewV2Result, { ok: true }>;
}

export interface AutomaticSemanticReviewRetryResult {
	status: "RETRYABLE_FAILURE";
	code: AutomaticSemanticReviewRetryCode;
	delegation_id: string;
	bound_diff_hash?: string;
	receipt_hash?: string;
	nested_usage: Readonly<Usage>;
	mechanical_page_calls: number;
	next_action: string;
	review_result?: never;
}

export interface AutomaticSemanticReviewAuthorityErrorResult {
	status: "AUTHORITY_ERROR";
	code: AutomaticSemanticReviewAuthorityErrorCode;
	delegation_id: string;
	nested_usage: Readonly<Usage>;
	mechanical_page_calls: number;
	next_action: string;
	receipt_hash?: never;
	review_result?: never;
}

export type AutomaticSemanticReviewResult =
	| AutomaticSemanticReviewDurableResult
	| AutomaticSemanticReviewRetryResult
	| AutomaticSemanticReviewAuthorityErrorResult;

export interface AutomaticSemanticReviewInput {
	project_root: string;
	delegation_id: string;
	exec: ExecFn;
	model_registry: CoordinateStructuredSolReviewInput["model_registry"];
	secrets?: readonly string[];
	signal?: AbortSignal;
	now?: () => Date;
}

export interface AutomaticSemanticReviewDependencies {
	readCommittedGeneration?: typeof readDelegationCommittedGenerationV2;
	readReview?: typeof readDelegationReviewV2;
	readTerminalNegativeReview?: typeof readDelegationTerminalNegativeReviewV1;
	review?: typeof reviewDelegationV2;
	collectPresentation?: typeof collectStructuredReviewPresentationV1;
	coordinate?: typeof coordinateStructuredSolReview;
	coordinateTerminalNegative?: typeof coordinateStructuredSolTerminalNegativeReview;
	resolveCommittedAuthority?: typeof committedStructuredReviewAuthorityV2;
	resolveTerminalNegativeAuthority?: typeof committedTerminalNegativeStructuredReviewAuthorityV1;
	isSemanticAccepted?: typeof hasDelegationSemanticReviewAuthorityV2;
	isSemanticRepair?: typeof hasDelegationSemanticRepairAuthorityV2;
	isTerminalNegativeRepair?: typeof hasDelegationTerminalNegativeSemanticRepairAuthorityV1;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lineageContractIdentity(committed: Readonly<DelegationCommittedGenerationV2>): string | undefined {
	const before = committed.records["before.json"];
	if (!isRecord(before) || !isRecord(before.contract)) return undefined;
	const { contract_hash: _contractHash, repair_of: _repairOf, ...semanticContract } = before.contract;
	return canonicalHash(semanticContract);
}

function lineageContractsCompatible(
	parent: Readonly<DelegationCommittedGenerationV2>,
	current: Readonly<DelegationCommittedGenerationV2>,
): boolean {
	const parentIdentity = lineageContractIdentity(parent);
	const currentIdentity = lineageContractIdentity(current);
	return parentIdentity !== undefined && currentIdentity !== undefined && parentIdentity === currentIdentity;
}

/**
 * Relevance roles identify why a path is present, not a dependency edge.
 * The current projection schema carries no owner/ref relationship, so it is
 * unsafe to invent an all-to-all D/S -> W/C graph. Explicit relationships can
 * be added here only after they are hash-bound in durable authority.
 */
export function declaredSemanticReviewDependenciesV2(
	_projection: Pick<ReviewRelevanceProjectionV2, "entries">,
): readonly SemanticReviewDependencyEdgeV2[] {
	return Object.freeze([]);
}

/** S-only controls bind policy/envelope compatibility, but are not evidence streams. */
export function semanticReviewScopeExpandedV2(
	projection: Pick<ReviewRelevanceProjectionV2, "entries">,
	parentEvidence: Pick<SemanticReviewEvidenceV2, "streams">,
): boolean {
	const parentPaths = new Set(parentEvidence.streams.map((stream) => stream.path));
	return projection.entries.some((entry) =>
		(entry.roles.includes("W") || entry.roles.includes("C") || entry.roles.includes("D"))
		&& !parentPaths.has(entry.path));
}

function nextAction(delegationId: string): string {
	return reviewDelegationToolActionV1(delegationId);
}

function retryNextAction(code: AutomaticSemanticReviewRetryCode, delegationId: string): string {
	switch (code) {
		case "LEGACY_ENVELOPE_REQUIRES_MIGRATION":
			return `use bounded workbench_review_worker_diff paging to migrate delegation ${delegationId}; automatic legacy review is unavailable`;
		case "REVIEW_TOO_LARGE":
			return `legacy review compatibility is limited to 32 pages for delegation ${delegationId}; resume with the V2 review job or split the change`;
		case "SPLIT_REQUIRED":
			return `split delegation ${delegationId}; the review exceeds the explicit 128-page/4-MiB large-job ceiling`;
		case "LINEAGE_PRESENTATION_GAP":
			return `use bounded manual semantic review for delegation ${delegationId}; carried rejected paths are not distinguishable in the committed W/C authority`;
		case "MECHANICAL_SCOPE_INTEGRITY_FAILED":
			return `inspect the bounded violations with workbench_review_worker_diff for delegation ${delegationId}; repair the scope breach before any semantic ACCEPT`;
		default:
			return nextAction(delegationId);
	}
}

function canonicalNow(input: AutomaticSemanticReviewInput): string {
	try {
		const value = (input.now ?? (() => new Date()))();
		return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
	} catch {
		return new Date().toISOString();
	}
}

function progressIdentity(record: Readonly<ReviewRecord>): string {
	return JSON.stringify({
		bound_diff_hash: record.bound_diff_hash,
		presentation_progress: record.presentation_progress ?? [],
		fully_presented_paths: record.fully_presented_paths ?? [],
		presentation_remaining_paths: record.presentation_remaining_paths ?? [],
		presentation_complete: record.presentation_complete ?? false,
	});
}

function nextIncompletePath(record: Readonly<ReviewRecord>): string | undefined {
	const coverage = normalizeReviewPresentationCoverage(record);
	return coverage.presentation_remaining_paths[0];
}

function durableDecision(
	authority: Readonly<DelegationReviewAuthorityV2>,
	delegationId: string,
	mechanicalPageCalls: number,
	usage: Readonly<Usage>,
	replayed: boolean,
	receiptHash?: string,
	reviewResult?: Extract<DelegationReviewV2Result, { ok: true }>,
	isAccepted: typeof hasDelegationSemanticReviewAuthorityV2 = hasDelegationSemanticReviewAuthorityV2,
	isRepair: typeof hasDelegationSemanticRepairAuthorityV2 = hasDelegationSemanticRepairAuthorityV2,
): AutomaticSemanticReviewDurableResult | undefined {
	if (isAccepted(authority)) {
		return {
			status: "ACCEPT",
			delegation_id: delegationId,
			bound_diff_hash: authority.review.bound_diff_hash,
			durable: true,
			replayed,
			...(receiptHash === undefined ? {} : { receipt_hash: receiptHash }),
			nested_usage: usage,
			mechanical_page_calls: mechanicalPageCalls,
			...(reviewResult === undefined ? {} : { review_result: reviewResult }),
		};
	}
	if (isRepair(authority)) {
		return {
			status: "REPAIR",
			delegation_id: delegationId,
			bound_diff_hash: authority.review.bound_diff_hash,
			durable: true,
			replayed,
			...(receiptHash === undefined ? {} : { receipt_hash: receiptHash }),
			nested_usage: usage,
			mechanical_page_calls: mechanicalPageCalls,
			next_action: repairDelegationToolActionV1(delegationId),
			...(reviewResult === undefined ? {} : { review_result: reviewResult }),
		};
	}
	return undefined;
}

function terminalNegativeDurableDecision(
	authority: Readonly<DelegationTerminalNegativeReviewAuthorityV1>,
	delegationId: string,
	mechanicalPageCalls: number,
	usage: Readonly<Usage>,
	replayed: boolean,
	receiptHash?: string,
	reviewResult?: Extract<DelegationReviewV2Result, { ok: true }>,
	isRepair: typeof hasDelegationTerminalNegativeSemanticRepairAuthorityV1 = hasDelegationTerminalNegativeSemanticRepairAuthorityV1,
): AutomaticSemanticReviewDurableResult | undefined {
	if (!isRepair(authority)) return undefined;
	return {
		status: "REPAIR",
		delegation_id: delegationId,
		bound_diff_hash: authority.review.bound_diff_hash,
		durable: true,
		replayed,
		...(receiptHash === undefined ? {} : { receipt_hash: receiptHash }),
		nested_usage: usage,
		mechanical_page_calls: mechanicalPageCalls,
		next_action: repairDelegationToolActionV1(delegationId),
		...(reviewResult === undefined ? {} : { review_result: reviewResult }),
	};
}

function boundedRepairReason(value: string | null | undefined): string {
	const fallback = "Structured Sol review requires repair of the committed terminal-negative delegation.";
	const candidate = typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
	if (Buffer.byteLength(candidate, "utf8") <= 1_024) return candidate;
	let bounded = "";
	for (const character of candidate) {
		if (Buffer.byteLength(`${bounded}${character}…`, "utf8") > 1_024) break;
		bounded += character;
	}
	return bounded.length === 0 ? fallback : `${bounded}…`;
}

/**
 * Complete and persist a REPAIR-only Sol review for one strictly eligible
 * committed FAILED/INTERRUPTED implementation. The terminal transaction is
 * never rewritten; only its distinct immutable repair sidecar can advance.
 */
async function runAutomaticTerminalNegativeSemanticReview(
	input: AutomaticSemanticReviewInput,
	initialGeneration: Readonly<DelegationCommittedGenerationV2>,
	dependencies: AutomaticSemanticReviewDependencies,
): Promise<AutomaticSemanticReviewResult> {
	const empty = zeroUsage();
	const action = nextAction(input.delegation_id);
	const readCommitted = dependencies.readCommittedGeneration ?? readDelegationCommittedGenerationV2;
	const readTerminal = dependencies.readTerminalNegativeReview ?? readDelegationTerminalNegativeReviewV1;
	const review = dependencies.review ?? reviewDelegationV2;
	const collectPresentation = dependencies.collectPresentation ?? collectStructuredReviewPresentationV1;
	const coordinate = dependencies.coordinateTerminalNegative ?? coordinateStructuredSolTerminalNegativeReview;
	const resolveCommitted = dependencies.resolveTerminalNegativeAuthority ?? committedTerminalNegativeStructuredReviewAuthorityV1;
	const isRepair = dependencies.isTerminalNegativeRepair ?? hasDelegationTerminalNegativeSemanticRepairAuthorityV1;
	let generation = initialGeneration;
	let mechanicalPageCalls = 0;

	let durable: Awaited<ReturnType<typeof readDelegationTerminalNegativeReviewV1>> | undefined;
	try {
		durable = await readTerminal(input.project_root, input.delegation_id);
	} catch {
		return { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
	}
	if (durable.ok) {
		const replay = terminalNegativeDurableDecision(durable.value, input.delegation_id, 0, empty, true, undefined, undefined, isRepair);
		if (replay !== undefined) return replay;
	} else if (durable.error.code !== "not_found") {
		return { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
	}

	if (!durable.ok) {
		const initial = await review({
			projectRoot: input.project_root,
			delegationId: input.delegation_id,
			exec: input.exec,
			maxLines: DEFAULT_REVIEW_MAX_LINES,
			maxBytes: DEFAULT_REVIEW_MAX_BYTES,
			...(input.secrets === undefined ? {} : { secrets: [...input.secrets] }),
			now: canonicalNow(input),
		});
		if (!initial.ok) {
			const authorityFailure = initial.error.code === "authority_invalid" || initial.error.code === "invalid_state";
			return authorityFailure
				? { status: "AUTHORITY_ERROR", code: "COMMITTED_AUTHORITY_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action }
				: { status: "RETRYABLE_FAILURE", code: "DURABLE_REVIEW_NOT_FOUND", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
		}
		try {
			durable = await readTerminal(input.project_root, input.delegation_id);
		} catch {
			return { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
		}
		if (!durable.ok) {
			return durable.error.code === "not_found"
				? { status: "RETRYABLE_FAILURE", code: "DURABLE_REVIEW_NOT_FOUND", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action }
				: { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
		}
	}
	if (durable.value.review.verdict === "FAIL") {
		const code = "MECHANICAL_SCOPE_INTEGRITY_FAILED" as const;
		return {
			status: "RETRYABLE_FAILURE",
			code,
			delegation_id: input.delegation_id,
			bound_diff_hash: durable.value.review.bound_diff_hash,
			nested_usage: empty,
			mechanical_page_calls: 0,
			next_action: retryNextAction(code, input.delegation_id),
		};
	}

	let resolved = resolveCommitted(generation, durable.value);
	if (!resolved.ok) {
		const retryCode = resolved.code === "LINEAGE_PRESENTATION_GAP" ? resolved.code : "LEGACY_ENVELOPE_REQUIRES_MIGRATION";
		return resolved.code === "LEGACY_REVIEW_REQUIRES_MIGRATION" || resolved.code === "LINEAGE_PRESENTATION_GAP"
			? { status: "RETRYABLE_FAILURE", code: retryCode, delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: retryNextAction(retryCode, input.delegation_id) }
			: { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
	}

	const preview = await collectPresentation({
		projectRoot: input.project_root,
		authority: resolved.value.authority,
		exec: input.exec,
		secrets: input.secrets,
	});
	if (!preview.ok) {
		return { status: "RETRYABLE_FAILURE", code: preview.code, delegation_id: input.delegation_id, bound_diff_hash: resolved.value.review.bound_diff_hash, nested_usage: empty, mechanical_page_calls: 0, next_action: retryNextAction(preview.code, input.delegation_id) };
	}
	if (preview.value.envelope_compatibility !== "current") {
		return { status: "RETRYABLE_FAILURE", code: "LEGACY_ENVELOPE_REQUIRES_MIGRATION", delegation_id: input.delegation_id, bound_diff_hash: resolved.value.review.bound_diff_hash, nested_usage: empty, mechanical_page_calls: 0, next_action: retryNextAction("LEGACY_ENVELOPE_REQUIRES_MIGRATION", input.delegation_id) };
	}
	if (dependencies.coordinate !== undefined && preview.value.pages.length > AUTOMATIC_STRUCTURED_SOL_REVIEW_MAX_PAGES) {
		return { status: "RETRYABLE_FAILURE", code: "REVIEW_TOO_LARGE", delegation_id: input.delegation_id, bound_diff_hash: resolved.value.review.bound_diff_hash, nested_usage: empty, mechanical_page_calls: 0, next_action: retryNextAction("REVIEW_TOO_LARGE", input.delegation_id) };
	}

	let currentRecord = durable.value.review;
	while (!isScopeIntegrityPacketComplete(currentRecord)) {
		if (mechanicalPageCalls >= (dependencies.coordinate === undefined
			? STRUCTURED_SOL_REVIEW_LARGE_JOB_MAX_PAGES_V2
			: AUTOMATIC_STRUCTURED_SOL_REVIEW_MAX_PAGES)) {
			return { status: "RETRYABLE_FAILURE", code: "MECHANICAL_PRESENTATION_FAILED", delegation_id: input.delegation_id, bound_diff_hash: currentRecord.bound_diff_hash, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
		}
		const path = nextIncompletePath(currentRecord);
		if (path === undefined) {
			return { status: "RETRYABLE_FAILURE", code: "MECHANICAL_PRESENTATION_STALLED", delegation_id: input.delegation_id, bound_diff_hash: currentRecord.bound_diff_hash, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
		}
		const before = progressIdentity(currentRecord);
		const page = await review({
			projectRoot: input.project_root,
			delegationId: input.delegation_id,
			exec: input.exec,
			includePaths: [path],
			maxLines: DEFAULT_REVIEW_MAX_LINES,
			maxBytes: DEFAULT_REVIEW_MAX_BYTES,
			...(input.secrets === undefined ? {} : { secrets: [...input.secrets] }),
			now: canonicalNow(input),
		});
		mechanicalPageCalls += 1;
		if (!page.ok || !page.review.ok || page.review.record === undefined) {
			const authorityFailure = !page.ok && (page.error.code === "authority_invalid" || page.error.code === "invalid_state");
			return authorityFailure
				? { status: "AUTHORITY_ERROR", code: "COMMITTED_AUTHORITY_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action }
				: { status: "RETRYABLE_FAILURE", code: "MECHANICAL_PRESENTATION_FAILED", delegation_id: input.delegation_id, bound_diff_hash: currentRecord.bound_diff_hash, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
		}
		currentRecord = page.review.record;
		if (progressIdentity(currentRecord) === before) {
			return { status: "RETRYABLE_FAILURE", code: "MECHANICAL_PRESENTATION_STALLED", delegation_id: input.delegation_id, bound_diff_hash: currentRecord.bound_diff_hash, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
		}
	}

	const refreshedGeneration = await readCommitted(input.project_root, input.delegation_id).catch(() => undefined);
	durable = await readTerminal(input.project_root, input.delegation_id).catch(() => undefined);
	if (refreshedGeneration === undefined || !refreshedGeneration.ok || durable === undefined || !durable.ok) {
		return { status: "AUTHORITY_ERROR", code: "COMMITTED_AUTHORITY_UNAVAILABLE", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
	}
	generation = refreshedGeneration.value;
	resolved = resolveCommitted(generation, durable.value);
	if (!resolved.ok && resolved.code === "LINEAGE_PRESENTATION_GAP") {
		return { status: "RETRYABLE_FAILURE", code: "LINEAGE_PRESENTATION_GAP", delegation_id: input.delegation_id, bound_diff_hash: currentRecord.bound_diff_hash, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: retryNextAction("LINEAGE_PRESENTATION_GAP", input.delegation_id) };
	}
	if (!resolved.ok || !isScopeIntegrityPacketComplete(resolved.value.review)) {
		return { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
	}

	const coordinated = await coordinate({
		project_root: input.project_root,
		delegation_id: input.delegation_id,
		contract: resolved.value.contract,
		relevance_projection: resolved.value.review.relevance_projection!,
		semantic_envelope: resolved.value.review.review_envelope!,
		authority: resolved.value.authority,
		model_registry: input.model_registry,
		exec: input.exec,
		secrets: input.secrets,
		signal: input.signal,
		now: input.now,
	});
	if (coordinated.status === "RETRYABLE_FAILURE") {
		return {
			status: "RETRYABLE_FAILURE",
			code: coordinated.code,
			delegation_id: input.delegation_id,
			bound_diff_hash: resolved.value.review.bound_diff_hash,
			...(coordinated.attempt_receipt === undefined ? {} : { receipt_hash: coordinated.attempt_receipt.receipt_hash }),
			nested_usage: coordinated.usage,
			mechanical_page_calls: mechanicalPageCalls,
			next_action: retryNextAction(coordinated.code, input.delegation_id),
		};
	}

	const receiptHash = coordinated.receipt.receipt_hash;
	let decided: DelegationReviewV2Result | undefined;
	try {
		decided = await review({
			projectRoot: input.project_root,
			delegationId: input.delegation_id,
			exec: input.exec,
			...(input.secrets === undefined ? {} : { secrets: [...input.secrets] }),
			now: canonicalNow(input),
			semanticDecision: "REPAIR",
			expectedBoundDiffHash: resolved.value.review.bound_diff_hash,
			repairReason: boundedRepairReason(coordinated.receipt.final_assessment?.repair_reason),
			reviewer: { provider: "openai-codex", model: "gpt-5.6-sol" },
		});
	} catch {
		// Lost response is resolved solely by the strict terminal sidecar readback.
	}
	const readback = await readTerminal(input.project_root, input.delegation_id).catch(() => undefined);
	if (readback?.ok) {
		const durableResult = terminalNegativeDurableDecision(
			readback.value,
			input.delegation_id,
			mechanicalPageCalls,
			coordinated.usage,
			false,
			receiptHash,
			decided?.ok ? decided : undefined,
			isRepair,
		);
		if (durableResult !== undefined) return durableResult;
	}
	return {
		status: "RETRYABLE_FAILURE",
		code: readback === undefined || !readback.ok ? "DECISION_READBACK_UNAVAILABLE" : "DECISION_PERSISTENCE_FAILED",
		delegation_id: input.delegation_id,
		bound_diff_hash: resolved.value.review.bound_diff_hash,
		receipt_hash: receiptHash,
		nested_usage: coordinated.usage,
		mechanical_page_calls: mechanicalPageCalls,
		next_action: action,
	};
}

/**
 * Complete the bounded durable presentation, run structured Sol review, and
 * publish only through reviewDelegationV2's existing hash-bound decision API.
 */
export async function runAutomaticSemanticReview(
	input: AutomaticSemanticReviewInput,
	dependencies: AutomaticSemanticReviewDependencies = {},
): Promise<AutomaticSemanticReviewResult> {
	const empty = zeroUsage();
	const action = nextAction(input.delegation_id);
	const readCommitted = dependencies.readCommittedGeneration ?? readDelegationCommittedGenerationV2;
	const readReview = dependencies.readReview ?? readDelegationReviewV2;
	const review = dependencies.review ?? reviewDelegationV2;
	const collectPresentation = dependencies.collectPresentation ?? collectStructuredReviewPresentationV1;
	const coordinate = dependencies.coordinate ?? coordinateStructuredSolReview;
	const resolveCommitted = dependencies.resolveCommittedAuthority ?? committedStructuredReviewAuthorityV2;
	const isAccepted = dependencies.isSemanticAccepted ?? hasDelegationSemanticReviewAuthorityV2;
	const isRepair = dependencies.isSemanticRepair ?? hasDelegationSemanticRepairAuthorityV2;
	let mechanicalPageCalls = 0;

	let generation: Awaited<ReturnType<typeof readDelegationCommittedGenerationV2>>;
	try {
		generation = await readCommitted(input.project_root, input.delegation_id);
	} catch {
		return { status: "AUTHORITY_ERROR", code: "COMMITTED_AUTHORITY_UNAVAILABLE", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
	}
	if (!generation.ok) {
		return { status: "AUTHORITY_ERROR", code: "COMMITTED_AUTHORITY_UNAVAILABLE", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
	}
	if (isDelegationTerminalNegativeReviewEligibleFromCommittedV1(generation.value.state, generation.value.records)) {
		return runAutomaticTerminalNegativeSemanticReview(input, generation.value, dependencies);
	}

	let durable: Awaited<ReturnType<typeof readDelegationReviewV2>> | undefined;
	try {
		durable = await readReview(input.project_root, input.delegation_id);
	} catch {
		return { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
	}
	if (durable?.ok) {
		const replay = durableDecision(durable.value, input.delegation_id, 0, empty, true, undefined, undefined, isAccepted, isRepair);
		if (replay !== undefined) return replay;
	} else if (durable !== undefined && durable.error.code !== "not_found") {
		return { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
	} else if (generation.value.state.status === "REVIEWED") {
		return { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
	}

	if (generation.value.state.status !== "PENDING_REVIEW") {
		return { status: "AUTHORITY_ERROR", code: "COMMITTED_AUTHORITY_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
	}

	// A prior presentation may be absent after a recoverable post-worker
	// failure. Create exactly one provisional packet before resolving it.
	if (!durable?.ok) {
		const initial = await review({
			projectRoot: input.project_root,
			delegationId: input.delegation_id,
			exec: input.exec,
			maxLines: DEFAULT_REVIEW_MAX_LINES,
			maxBytes: DEFAULT_REVIEW_MAX_BYTES,
			...(input.secrets === undefined ? {} : { secrets: [...input.secrets] }),
			now: canonicalNow(input),
		});
		if (!initial.ok) {
			const authorityFailure = initial.error.code === "authority_invalid" || initial.error.code === "invalid_state";
			return authorityFailure
				? { status: "AUTHORITY_ERROR", code: "COMMITTED_AUTHORITY_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action }
				: { status: "RETRYABLE_FAILURE", code: "DURABLE_REVIEW_NOT_FOUND", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
		}
		try {
			durable = await readReview(input.project_root, input.delegation_id);
		} catch {
			return { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
		}
		if (!durable.ok) {
			return durable.error.code === "not_found"
				? { status: "RETRYABLE_FAILURE", code: "DURABLE_REVIEW_NOT_FOUND", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action }
				: { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
		}
	}
	if (durable.value.review.verdict === "FAIL") {
		const code = "MECHANICAL_SCOPE_INTEGRITY_FAILED" as const;
		return {
			status: "RETRYABLE_FAILURE",
			code,
			delegation_id: input.delegation_id,
			bound_diff_hash: durable.value.review.bound_diff_hash,
			nested_usage: empty,
			mechanical_page_calls: 0,
			next_action: retryNextAction(code, input.delegation_id),
		};
	}

	let resolved = resolveCommitted(generation.value, durable.value);
	if (!resolved.ok) {
		const retryCode = resolved.code === "LINEAGE_PRESENTATION_GAP" ? resolved.code : "LEGACY_ENVELOPE_REQUIRES_MIGRATION";
		return resolved.code === "LEGACY_REVIEW_REQUIRES_MIGRATION" || resolved.code === "LINEAGE_PRESENTATION_GAP"
			? { status: "RETRYABLE_FAILURE", code: retryCode, delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: retryNextAction(retryCode, input.delegation_id) }
			: { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: 0, next_action: action };
	}

	const preview = await collectPresentation({
		projectRoot: input.project_root,
		authority: resolved.value.authority,
		exec: input.exec,
		secrets: input.secrets,
	});
	if (!preview.ok) {
		return { status: "RETRYABLE_FAILURE", code: preview.code, delegation_id: input.delegation_id, bound_diff_hash: resolved.value.review.bound_diff_hash, nested_usage: empty, mechanical_page_calls: 0, next_action: retryNextAction(preview.code, input.delegation_id) };
	}
	if (preview.value.envelope_compatibility !== "current") {
		return { status: "RETRYABLE_FAILURE", code: "LEGACY_ENVELOPE_REQUIRES_MIGRATION", delegation_id: input.delegation_id, bound_diff_hash: resolved.value.review.bound_diff_hash, nested_usage: empty, mechanical_page_calls: 0, next_action: retryNextAction("LEGACY_ENVELOPE_REQUIRES_MIGRATION", input.delegation_id) };
	}
	if (dependencies.coordinate !== undefined && preview.value.pages.length > AUTOMATIC_STRUCTURED_SOL_REVIEW_MAX_PAGES) {
		return { status: "RETRYABLE_FAILURE", code: "REVIEW_TOO_LARGE", delegation_id: input.delegation_id, bound_diff_hash: resolved.value.review.bound_diff_hash, nested_usage: empty, mechanical_page_calls: 0, next_action: retryNextAction("REVIEW_TOO_LARGE", input.delegation_id) };
	}

	let currentRecord = durable.value.review;
	while (!isScopeIntegrityPacketComplete(currentRecord)) {
		if (mechanicalPageCalls >= (dependencies.coordinate === undefined
			? STRUCTURED_SOL_REVIEW_LARGE_JOB_MAX_PAGES_V2
			: AUTOMATIC_STRUCTURED_SOL_REVIEW_MAX_PAGES)) {
			return { status: "RETRYABLE_FAILURE", code: "MECHANICAL_PRESENTATION_FAILED", delegation_id: input.delegation_id, bound_diff_hash: currentRecord.bound_diff_hash, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
		}
		const path = nextIncompletePath(currentRecord);
		if (path === undefined) {
			return { status: "RETRYABLE_FAILURE", code: "MECHANICAL_PRESENTATION_STALLED", delegation_id: input.delegation_id, bound_diff_hash: currentRecord.bound_diff_hash, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
		}
		const before = progressIdentity(currentRecord);
		const page = await review({
			projectRoot: input.project_root,
			delegationId: input.delegation_id,
			exec: input.exec,
			includePaths: [path],
			maxLines: DEFAULT_REVIEW_MAX_LINES,
			maxBytes: DEFAULT_REVIEW_MAX_BYTES,
			...(input.secrets === undefined ? {} : { secrets: [...input.secrets] }),
			now: canonicalNow(input),
		});
		mechanicalPageCalls += 1;
		if (!page.ok || !page.review.ok || page.review.record === undefined) {
			const authorityFailure = !page.ok && (page.error.code === "authority_invalid" || page.error.code === "invalid_state");
			return authorityFailure
				? { status: "AUTHORITY_ERROR", code: "COMMITTED_AUTHORITY_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action }
				: { status: "RETRYABLE_FAILURE", code: "MECHANICAL_PRESENTATION_FAILED", delegation_id: input.delegation_id, bound_diff_hash: currentRecord.bound_diff_hash, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
		}
		currentRecord = page.review.record;
		if (progressIdentity(currentRecord) === before) {
			return { status: "RETRYABLE_FAILURE", code: "MECHANICAL_PRESENTATION_STALLED", delegation_id: input.delegation_id, bound_diff_hash: currentRecord.bound_diff_hash, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
		}
	}

	// Re-read both authorities after the last durable provisional write.
	generation = await readCommitted(input.project_root, input.delegation_id).catch(() => ({ ok: false } as never));
	durable = await readReview(input.project_root, input.delegation_id).catch(() => undefined);
	if (!generation.ok || !durable?.ok) {
		return { status: "AUTHORITY_ERROR", code: "COMMITTED_AUTHORITY_UNAVAILABLE", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
	}
	resolved = resolveCommitted(generation.value, durable.value);
	if (!resolved.ok && resolved.code === "LINEAGE_PRESENTATION_GAP") {
		return { status: "RETRYABLE_FAILURE", code: "LINEAGE_PRESENTATION_GAP", delegation_id: input.delegation_id, bound_diff_hash: currentRecord.bound_diff_hash, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: retryNextAction("LINEAGE_PRESENTATION_GAP", input.delegation_id) };
	}
	if (!resolved.ok || !isScopeIntegrityPacketComplete(resolved.value.review)) {
		return { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
	}
	// Production default: one locked resumable V2 review job and one immutable
	// evidence owner. An injected coordinator retains the V1 compatibility seam.
	if (dependencies.coordinate === undefined) {
		let parentEvidence: SemanticReviewEvidenceV2 | null = null;
		let lineageContractCompatible = false;
		const parentId = generation.value.state.repair_lineage?.repair_of;
		if (parentId !== undefined) {
			const parent = await readDelegationSemanticReviewEvidenceV2(input.project_root, parentId).catch(() => undefined);
			if (parent === undefined || !parent.ok) {
				return { status: "AUTHORITY_ERROR", code: "DURABLE_REVIEW_INVALID", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
			}
			parentEvidence = parent.value ?? null;
			if (parentEvidence !== null) {
				const parentGeneration = await readCommitted(input.project_root, parentId).catch(() => undefined);
				if (parentGeneration === undefined || !parentGeneration.ok) {
					return { status: "AUTHORITY_ERROR", code: "COMMITTED_AUTHORITY_UNAVAILABLE", delegation_id: input.delegation_id, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
				}
				lineageContractCompatible = lineageContractsCompatible(parentGeneration.value, generation.value);
			}
		}
		const projection = resolved.value.review.relevance_projection!;
		const declaredDependencies = declaredSemanticReviewDependenciesV2(projection);
		const scopeExpansion = parentEvidence !== null && semanticReviewScopeExpandedV2(projection, parentEvidence);
		const locked = await withDelegationSemanticReviewJobV2(
			input.project_root,
			input.delegation_id,
			canonicalNow(input),
			async ({ progress, publishProgress }) => coordinateStructuredSolReviewV2({
				project_root: input.project_root,
				delegation_id: input.delegation_id,
				generation: generation.value.state.generation,
				generation_content_hash: generation.value.state.committed_proof!.content_hash,
				runtime_build_identity: WORKBENCH_RUNTIME_BUILD_IDENTITY.source_hash,
				contract: resolved.value.contract,
				relevance_projection: projection,
				semantic_envelope: resolved.value.review.review_envelope!,
				authority: resolved.value.authority,
				model_registry: input.model_registry,
				exec: input.exec,
				secrets: input.secrets,
				signal: input.signal,
				now: input.now,
				parent_evidence: parentEvidence,
				lineage_contract_compatible: lineageContractCompatible,
				declared_dependencies: declaredDependencies,
				finding_paths: parentEvidence?.cross_file_assessment.affected_paths,
				scope_expansion: scopeExpansion,
				binary_semantic_gaps: parentEvidence?.streams.filter((stream) => stream.verdict === "NOT_INSPECTED").map((stream) => stream.path),
				resume_progress: progress,
				on_progress: async (next) => {
					const stored = await publishProgress(next);
					if (!stored.ok) throw new Error("semantic review progress publication failed");
				},
			}),
		);
		if (!locked.ok) {
			return { status: "RETRYABLE_FAILURE", code: "PROGRESS_PERSISTENCE_FAILED", delegation_id: input.delegation_id, bound_diff_hash: resolved.value.review.bound_diff_hash, nested_usage: empty, mechanical_page_calls: mechanicalPageCalls, next_action: action };
		}
		const coordinatedV2 = locked.value;
		if (!("evidence" in coordinatedV2)) {
			return {
				status: "RETRYABLE_FAILURE", code: coordinatedV2.code, delegation_id: input.delegation_id,
				bound_diff_hash: resolved.value.review.bound_diff_hash, nested_usage: coordinatedV2.usage,
				mechanical_page_calls: mechanicalPageCalls, next_action: retryNextAction(coordinatedV2.code, input.delegation_id),
			};
		}
		const candidateEvidence = coordinatedV2.evidence;
		let evidence = await publishDelegationSemanticReviewEvidenceV2(input.project_root, {
			delegation_id: input.delegation_id,
			contract_hash: generation.value.state.contract_hash,
			worker_identity: generation.value.state.worker_identity,
			expected_generation: generation.value.state.generation,
			expected_revision: generation.value.state.revision,
			now: candidateEvidence.completed_at,
			base_review_hash: durable.value.review_hash,
			evidence: candidateEvidence,
		}).catch(() => undefined);
		if (evidence === undefined || !evidence.ok) {
			const winner = await readDelegationSemanticReviewEvidenceV2(input.project_root, input.delegation_id).catch(() => undefined);
			if (winner?.ok && winner.value?.evidence_hash === candidateEvidence.evidence_hash) evidence = { ok: true, value: winner.value };
			else return { status: "RETRYABLE_FAILURE", code: "DECISION_PERSISTENCE_FAILED", delegation_id: input.delegation_id, bound_diff_hash: resolved.value.review.bound_diff_hash, receipt_hash: candidateEvidence.evidence_hash, nested_usage: coordinatedV2.usage, mechanical_page_calls: mechanicalPageCalls, next_action: action };
		}
		const publishedEvidence = evidence.value;
		const completedProgress = completeSemanticReviewProgressV2(coordinatedV2.progress, publishedEvidence.evidence_hash, candidateEvidence.completed_at);
		if (completedProgress === undefined || !(await publishDelegationSemanticReviewProgressV2(input.project_root, completedProgress)).ok) {
			return { status: "RETRYABLE_FAILURE", code: "PROGRESS_PERSISTENCE_FAILED", delegation_id: input.delegation_id, bound_diff_hash: resolved.value.review.bound_diff_hash, receipt_hash: publishedEvidence.evidence_hash, nested_usage: coordinatedV2.usage, mechanical_page_calls: mechanicalPageCalls, next_action: action };
		}
		const reviewReadback = await readDelegationReviewV2(input.project_root, input.delegation_id).catch(() => undefined);
		if (reviewReadback?.ok) {
			const result = durableDecision(reviewReadback.value, input.delegation_id, mechanicalPageCalls, coordinatedV2.usage, false, publishedEvidence.evidence_hash, undefined, isAccepted, isRepair);
			if (result !== undefined && result.status === coordinatedV2.status) {
				const freshStreams = candidateEvidence.streams.filter((stream) => stream.source === "FRESH");
				return {
					...result,
					review_page_count: freshStreams.reduce((total, stream) => total + stream.page_binding_hashes.length, 0),
					review_batch_count: coordinatedV2.progress.batches.length,
					final_model_calls: 1,
					raw_page_bytes_in_final: 0,
					fresh_stream_count: freshStreams.length,
					inherited_stream_count: candidateEvidence.streams.length - freshStreams.length,
				};
			}
		}
		return { status: "RETRYABLE_FAILURE", code: "DECISION_READBACK_UNAVAILABLE", delegation_id: input.delegation_id, bound_diff_hash: resolved.value.review.bound_diff_hash, receipt_hash: publishedEvidence.evidence_hash, nested_usage: coordinatedV2.usage, mechanical_page_calls: mechanicalPageCalls, next_action: action };
	}

	const coordinated = await coordinate({
		project_root: input.project_root,
		delegation_id: input.delegation_id,
		contract: resolved.value.contract,
		relevance_projection: resolved.value.review.relevance_projection!,
		semantic_envelope: resolved.value.review.review_envelope!,
		authority: resolved.value.authority,
		model_registry: input.model_registry,
		exec: input.exec,
		secrets: input.secrets,
		signal: input.signal,
		now: input.now,
	});
	if (coordinated.status === "RETRYABLE_FAILURE") {
		return {
			status: "RETRYABLE_FAILURE",
			code: coordinated.code,
			delegation_id: input.delegation_id,
			bound_diff_hash: resolved.value.review.bound_diff_hash,
			...(coordinated.attempt_receipt === undefined ? {} : { receipt_hash: coordinated.attempt_receipt.receipt_hash }),
			nested_usage: coordinated.usage,
			mechanical_page_calls: mechanicalPageCalls,
			next_action: retryNextAction(coordinated.code, input.delegation_id),
		};
	}

	const receiptHash = coordinated.receipt.receipt_hash;
	const decisionInput = coordinated.status === "ACCEPT"
		? {
			semanticDecision: "ACCEPT" as const,
			expectedBoundDiffHash: resolved.value.review.bound_diff_hash,
			reviewer: { provider: "openai-codex", model: "gpt-5.6-sol" } as const,
		}
		: {
			semanticDecision: "REPAIR" as const,
			expectedBoundDiffHash: resolved.value.review.bound_diff_hash,
			repairReason: coordinated.receipt.final_assessment?.repair_reason ?? "Structured Sol review requires repair.",
			reviewer: { provider: "openai-codex", model: "gpt-5.6-sol" } as const,
		};
	let decided: DelegationReviewV2Result | undefined;
	try {
		decided = await review({
			projectRoot: input.project_root,
			delegationId: input.delegation_id,
			exec: input.exec,
			...(input.secrets === undefined ? {} : { secrets: [...input.secrets] }),
			now: canonicalNow(input),
			...decisionInput,
		});
	} catch {
		// Lost response is resolved solely by strict durable read-back below.
	}
	const readback = await readReview(input.project_root, input.delegation_id).catch(() => undefined);
	if (readback?.ok) {
		const durableResult = durableDecision(
			readback.value,
			input.delegation_id,
			mechanicalPageCalls,
			coordinated.usage,
			false,
			receiptHash,
			decided?.ok ? decided : undefined,
			isAccepted,
			isRepair,
		);
		if (durableResult !== undefined && durableResult.status === coordinated.status) return durableResult;
	}
	return {
		status: "RETRYABLE_FAILURE",
		code: readback === undefined || !readback.ok ? "DECISION_READBACK_UNAVAILABLE" : "DECISION_PERSISTENCE_FAILED",
		delegation_id: input.delegation_id,
		bound_diff_hash: resolved.value.review.bound_diff_hash,
		receipt_hash: receiptHash,
		nested_usage: coordinated.usage,
		mechanical_page_calls: mechanicalPageCalls,
		next_action: action,
	};
}
