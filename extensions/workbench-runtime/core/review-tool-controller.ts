/** Public delegation diff-review tool controller. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ExecFn } from "./config.ts";
import {
	demoteReviewedToPending,
	markSemanticAccepted,
	markReviewed,
	observeDiffChange,
	type DelegationState,
} from "./delegation-state.ts";
import type { reviewDelegationV2 } from "./delegation-review-v2.ts";
import type { readRecoverableUnpublishedDelegationV2 } from "./delegation-project-authority.ts";
import type { readDelegationCommittedGenerationV2 } from "./delegation-transaction-storage.ts";
import {
	MAX_REVIEW_GUIDANCE_BYTES,
	MAX_REVIEW_PATCH_PATHS,
	MAX_REVIEW_PATH_BYTES,
	classifySemanticReviewRisk,
	isStrictSemanticAcceptedOrZeroDelta,
	normalizeReviewPresentationCoverage,
	type reviewDelegation,
} from "./diff-review.ts";
import {
	DIFF_REVIEW_RESULT_MAX_BYTES,
	DIFF_REVIEW_RESULT_MAX_LINES,
	clampWholeResultText,
} from "./output-policy.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";
import { commanderBlockReason } from "./worker-policy.ts";
import { workbenchToolRenderer } from "../ui/tool-renderers.ts";

interface OutputAuthorizationReservation {
	readonly allowed: boolean;
	readonly allocatedBytes: number;
}

const SEMANTIC_REVIEW_HEADER_LINES = 2;
const SEMANTIC_REVIEW_HEADER_SEPARATOR_BYTES = 2;
const MAX_BOUND_DIFF_HASH = "f".repeat(64);

function semanticReviewHeader(
	semanticReview: "accepted" | "required" | "not_required" | "repair_required",
	boundDiffHash: string,
	repairOf?: string,
): string[] {
	return [
		"review kind: scope_integrity (mechanical evidence; never Gate authority)",
		`semantic review: ${semanticReview.toUpperCase()}${semanticReview === "accepted" ? ` — explicit Sol ACCEPT bound ${boundDiffHash}` : semanticReview === "repair_required" ? ` — explicit Sol REPAIR bound ${boundDiffHash}; start only exact repair_of=${repairOf ?? "20260823-000000-xxxx"}` : semanticReview === "required" ? ` — inspect the complete packet, then call again with semantic_decision=ACCEPT or REPAIR and expected_bound_diff_hash=${boundDiffHash}; REPAIR also requires repair_reason` : " — zero actual delta"}`,
	];
}

const SEMANTIC_REVIEW_HEADER_MAX_BYTES = Math.max(
	...(["accepted", "required", "not_required", "repair_required"] as const).map((status) =>
		Buffer.byteLength(semanticReviewHeader(status, MAX_BOUND_DIFF_HASH, "20260823-000000-xxxx").join("\n"), "utf8")),
);

export interface ReviewToolController {
	pi: Pick<ExtensionAPI, "registerTool">;
	services: ReviewToolServices;
	exec: ExecFn;
	secrets: readonly string[];
	trustedOrError(ctx: ExtensionContext): string | undefined;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	peekOutputAuthorization(toolCallId: unknown, toolName: unknown): OutputAuthorizationReservation | undefined;
	syncLease(): void;
	reconcileProjectAuthority(projectRoot: string, now: string, options: { deferReviewedFreshness?: boolean }): Promise<unknown>;
	getProjectAuthorityBlockReason(action: "review"): string | undefined;
	getProjectAuthorityIssueCode(): string | undefined;
	getDelegationState(): DelegationState;
	setDelegationState(state: DelegationState): void;
	isStrictMirrorDirty(): boolean;
	setStrictMirrorDirty(dirty: boolean): void;
	persistDelegationState(): void;
	persistDelegationStateStrict(state: DelegationState): void;
	refreshCompactFacts(): void;
	refreshStatus(ctx: ExtensionContext): Promise<void>;
}

export interface ReviewToolServices {
	now(): Date;
	readCommittedGeneration: typeof readDelegationCommittedGenerationV2;
	readRecoverableUnpublished: typeof readRecoverableUnpublishedDelegationV2;
	reviewV2: typeof reviewDelegationV2;
	reviewLegacy: typeof reviewDelegation;
}

/** Register review_worker_diff at its fixed catalog position. */
export function registerReviewTool(controller: ReviewToolController): void {
	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_review_worker_diff,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_review_worker_diff,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const pendingAuthorization = controller.peekOutputAuthorization(toolCallId, "workbench_review_worker_diff");
			const requestedMaxBytes = Math.min(params.max_bytes ?? DIFF_REVIEW_RESULT_MAX_BYTES, DIFF_REVIEW_RESULT_MAX_BYTES);
			const renderMaxBytes = pendingAuthorization === undefined
				? requestedMaxBytes
				: pendingAuthorization.allowed
					? Math.min(requestedMaxBytes, pendingAuthorization.allocatedBytes)
					: 0;
			const renderMaxLines = Math.min(params.max_lines ?? DIFF_REVIEW_RESULT_MAX_LINES, DIFF_REVIEW_RESULT_MAX_LINES);
			const packetMaxBytes = renderMaxBytes - SEMANTIC_REVIEW_HEADER_MAX_BYTES - SEMANTIC_REVIEW_HEADER_SEPARATOR_BYTES;
			const packetMaxLines = renderMaxLines - SEMANTIC_REVIEW_HEADER_LINES;
			const reviewText = (value: unknown): string => clampWholeResultText(value, {
				maxBytes: renderMaxBytes,
				maxLines: renderMaxLines,
			}).text;
			const semanticDecisionRaw = (params as unknown as { semantic_decision?: unknown }).semantic_decision;
			const expectedBoundDiffHashRaw = (params as unknown as { expected_bound_diff_hash?: unknown }).expected_bound_diff_hash;
			const expectedMigrationBindingHashRaw = (params as unknown as { expected_migration_binding_hash?: unknown }).expected_migration_binding_hash;
			const repairReasonRaw = (params as unknown as { repair_reason?: unknown }).repair_reason;
			const semanticDecisionSupplied = semanticDecisionRaw !== undefined || expectedBoundDiffHashRaw !== undefined ||
				expectedMigrationBindingHashRaw !== undefined || repairReasonRaw !== undefined;
			const boundHashValid = typeof expectedBoundDiffHashRaw === "string" && /^[0-9a-f]{64}$/u.test(expectedBoundDiffHashRaw);
			const acceptShape = semanticDecisionRaw === "ACCEPT" && boundHashValid && repairReasonRaw === undefined &&
				(expectedMigrationBindingHashRaw === undefined || (
					typeof expectedMigrationBindingHashRaw === "string" && /^[0-9a-f]{64}$/u.test(expectedMigrationBindingHashRaw)
				));
			const repairShape = semanticDecisionRaw === "REPAIR" && boundHashValid && expectedMigrationBindingHashRaw === undefined &&
				typeof repairReasonRaw === "string" && repairReasonRaw === repairReasonRaw.trim() && repairReasonRaw.length > 0 &&
				Buffer.byteLength(repairReasonRaw, "utf8") <= 1_024 && !repairReasonRaw.includes("\0");
			if (semanticDecisionSupplied && !acceptShape && !repairShape) {
				const repairIntent = semanticDecisionRaw === "REPAIR" || repairReasonRaw !== undefined;
				return {
					content: [{ type: "text", text: reviewText("workbench_review_worker_diff: invalid semantic decision; ACCEPT requires the exact bound hash, while REPAIR requires the exact bound hash plus a bounded repair_reason") }],
					details: { ok: false, error: repairIntent ? "invalid_semantic_repair" : "invalid_semantic_accept", review_kind: "scope_integrity", gate_authority: false },
				};
			}
			const expectedBoundDiffHash = semanticDecisionSupplied ? expectedBoundDiffHashRaw as string : undefined;
			const expectedMigrationBindingHash = typeof expectedMigrationBindingHashRaw === "string"
				? expectedMigrationBindingHashRaw
				: undefined;
			if (semanticDecisionSupplied) {
				const commanderError = commanderBlockReason(ctx.model?.provider, ctx.model?.id);
				if (commanderError) {
					const repairIntent = semanticDecisionRaw === "REPAIR";
					return {
						content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: semantic decision refused; ${commanderError}`) }],
						details: { ok: false, error: repairIntent ? "semantic_repair_requires_sol" : "semantic_accept_requires_sol", review_kind: "scope_integrity", gate_authority: false },
					};
				}
			}
			const repairRequired = (delegationId: string) => ({
				content: [{
					type: "text" as const,
					text: reviewText(
						`workbench_review_worker_diff: repair_required; delegation ${delegationId} cannot be completed by review; call workbench_delegate_worker with repair_of=${delegationId} to start a fresh bounded repair; do not retry review`,
					),
				}],
							details: {
					ok: false,
					error: "repair_required",
					authority_version: 2,
					repair_of: delegationId,
					next_action: "workbench_delegate_worker",
				},
			});
			if (packetMaxBytes <= 0 || packetMaxLines <= 0) {
				return { content: [], details: { ok: false, error: "output_allocation_unavailable" } };
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: ${trustError}`) }], details: {} };
			}
			controller.syncLease();
			const projectRoot = await controller.projectRootFor(ctx);
			await controller.reconcileProjectAuthority(projectRoot, controller.services.now().toISOString(), { deferReviewedFreshness: true });
			const projectBlock = controller.getProjectAuthorityBlockReason("review");
			if (projectBlock) {
				return {
					content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: ${projectBlock}`) }],
					details: { ok: false, error: controller.getProjectAuthorityIssueCode() ?? "project_authority_invalid", authority_version: 2 },
				};
			}
			const delegationId = params.delegation_id.trim();
			const initialState = controller.getDelegationState();
			if (initialState.latestId === undefined) {
				return { content: [{ type: "text", text: reviewText("workbench_review_worker_diff: no delegation to review") }], details: {} };
			}
			if (initialState.latestId !== delegationId) {
				return {
					content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: delegation ${delegationId} is not the latest delegation (${initialState.latestId}); only the latest delegation can be reviewed`) }],
					details: {},
				};
			}
			const now = controller.services.now().toISOString();
			const v2Preflight = await controller.services.readCommittedGeneration(projectRoot, delegationId);
			let result: Awaited<ReturnType<typeof reviewDelegation>>;
			let authorityVersion: 1 | 2;
			let finalized = false;
			let reviewRecordPath: string | undefined;
			let migrationBindingHash: string | undefined;
			let repairDecisionHash: string | undefined;
			let repairReasonHash: string | undefined;
			let semanticReview: "accepted" | "required" | "not_required" | "repair_required" = "required";
			let semanticRisk: "low" | "medium" | "high" = "medium";
			if (v2Preflight.ok) {
				if (v2Preflight.value.state.status === "FAILED") return repairRequired(delegationId);
				authorityVersion = 2;
				const v2Result = await controller.services.reviewV2({
					projectRoot,
					delegationId,
					exec: controller.exec,
					includePaths: params.include_paths,
					maxLines: packetMaxLines,
					maxBytes: packetMaxBytes,
					secrets: controller.secrets,
					now,
					...(ctx.model === undefined ? {} : { presenter: { provider: ctx.model.provider, model: ctx.model.id } }),
					...(semanticDecisionSupplied ? {
						semanticDecision: semanticDecisionRaw as "ACCEPT" | "REPAIR",
						expectedBoundDiffHash: expectedBoundDiffHash!,
						...(expectedMigrationBindingHash === undefined ? {} : { expectedMigrationBindingHash }),
						...(typeof repairReasonRaw === "string" ? { repairReason: repairReasonRaw } : {}),
						reviewer: { provider: ctx.model!.provider, model: ctx.model!.id },
					} : {}),
				});
				if (!v2Result.ok) {
					if (v2Result.binding_hash !== undefined) {
						const state = controller.getDelegationState();
						const conflicted = observeDiffChange(state, v2Result.binding_hash, now);
						if (conflicted !== state || controller.isStrictMirrorDirty()) {
							try {
								controller.persistDelegationStateStrict(conflicted);
							} catch {
								controller.setDelegationState(conflicted);
								controller.setStrictMirrorDirty(true);
								controller.refreshCompactFacts();
								return {
									content: [{ type: "text", text: reviewText("workbench_review_worker_diff: relevance conflict detected but session_persistence_failed") }],
									details: { ok: false, error: "session_persistence_failed", authority_version: 2 },
								};
							}
						}
					}
					const migrationBlocked = v2Result.error.code === "semantic_acceptance_required";
					return {
						content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: v2 ${v2Result.error.code}: ${v2Result.error.message}`) }],
						details: {
							ok: false,
								error: v2Result.error.code,
								authority_version: 2,
								review_kind: "scope_integrity",
								gate_authority: false,
								...(v2Result.binding_hash === undefined ? {} : { binding_hash: v2Result.binding_hash }),
								...(migrationBlocked ? { next_action: "workbench_review_worker_diff", delegation_id: delegationId } : {}),
						},
					};
				}
				result = v2Result.review;
				finalized = v2Result.finalized;
				reviewRecordPath = v2Result.review_path;
				migrationBindingHash = v2Result.migration_binding_hash;
				repairDecisionHash = v2Result.repair_decision_hash;
				repairReasonHash = v2Result.repair_reason_hash;
				if (!result.ok || !result.record) {
					return {
						content: [{ type: "text", text: reviewText("workbench_review_worker_diff: v2 review record unavailable") }],
						details: { ok: false, error: "review_invalid", authority_version: 2 },
					};
				}

				const semantic = classifySemanticReviewRisk(result.record.checked_paths);
				semanticRisk = semantic.risk;
				semanticReview = v2Result.semantic_authority === "repair_required"
					? "repair_required"
					: v2Result.semantic_authority === "migration_accepted" || result.record.semantic_review === "accepted"
					? "accepted"
					: result.record.semantic_review === "not_required" || !semantic.required ? "not_required" : "required";
				const effectiveBindingHash = v2Result.migration_binding_hash ?? result.record.bound_diff_hash;
				let projected = observeDiffChange(controller.getDelegationState(), effectiveBindingHash, now);
				if (finalized && (isStrictSemanticAcceptedOrZeroDelta(result.record) || v2Result.semantic_authority === "migration_accepted")) {
					if (projected.status !== "REVIEWED") {
						const marked = result.record.semantic_review === "accepted" || v2Result.semantic_authority === "migration_accepted"
							? markSemanticAccepted(projected, { delegationId, expectedDiffHash: effectiveBindingHash, now })
							: markReviewed(projected, now);
						if (!marked.ok) {
							return {
								content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: finalized v2 scope/integrity packet could not project semantic acceptance: ${marked.error}`) }],
								details: { ok: false, error: "session_transition_failed", authority_version: 2, finalized: true },
							};
						}
						projected = marked.state;
					}
				} else if (projected.status === "REVIEWED") {
					const demoted = demoteReviewedToPending(projected, now);
					if (demoted.ok) projected = demoted.state;
				}
				if (projected !== controller.getDelegationState()) {
					try {
						controller.persistDelegationStateStrict(projected);
					} catch {
						if (!finalized && projected.status !== "REVIEWED") {
							controller.setDelegationState(projected);
							controller.setStrictMirrorDirty(true);
							controller.refreshCompactFacts();
						}
						return {
							content: [{ type: "text", text: reviewText("workbench_review_worker_diff: v2 review artifact persisted but session_persistence_failed") }],
							details: { ok: false, error: "session_persistence_failed", authority_version: 2, finalized, review_record: reviewRecordPath },
						};
					}
				}
			} else if (v2Preflight.error.code === "not_found") {
				authorityVersion = 1;
				if (semanticDecisionSupplied) {
					return {
						content: [{ type: "text", text: reviewText("workbench_review_worker_diff: semantic ACCEPT requires strict v2 provisional authority; legacy review is read-only compatibility evidence and must use bounded repair") }],
						details: { ok: false, error: "semantic_accept_requires_v2", authority_version: 1, review_kind: "scope_integrity", gate_authority: false, next_action: "workbench_delegate_worker_repair_of" },
					};
				}
				result = await controller.services.reviewLegacy({
					projectRoot,
					delegationId,
					exec: controller.exec,
					includePaths: params.include_paths,
					maxLines: packetMaxLines,
					maxBytes: packetMaxBytes,
					secrets: controller.secrets,
				});
				if (!result.ok || !result.record) {
					return { content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: ${result.error ?? "review failed"}`) }], details: { ok: false, error: result.error } };
				}
				const semantic = classifySemanticReviewRisk(result.record.checked_paths);
				semanticRisk = semantic.risk;
				semanticReview = !semantic.required ? "not_required" : "required";
				let nextState = observeDiffChange(controller.getDelegationState(), result.record.bound_diff_hash, now);
				if (isStrictSemanticAcceptedOrZeroDelta(result.record)) {
					if (nextState.status !== "REVIEWED") {
						const marked = markReviewed(nextState, now);
						if (!marked.ok) {
							return {
								content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: review record written but state refused REVIEWED: ${marked.error}`) }],
								details: { ok: false, error: marked.error },
							};
						}
						nextState = marked.state;
					}
				} else if (nextState.status === "REVIEWED") {
					const demoted = demoteReviewedToPending(nextState, now);
					if (demoted.ok) nextState = demoted.state;
				}
				controller.setDelegationState(nextState);
				controller.persistDelegationState();
			} else {
				if (v2Preflight.error.code === "invalid_record") {
					const recoverable = await controller.services.readRecoverableUnpublished(projectRoot, delegationId);
					if (recoverable.ok) return repairRequired(delegationId);
				}
				return {
					content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: v2 authority ${v2Preflight.error.code}; legacy fallback refused`) }],
					details: { ok: false, error: v2Preflight.error.code, authority_version: 2 },
				};
			}
			await controller.refreshStatus(ctx);
			const record = result.record;
			const presentation = normalizeReviewPresentationCoverage(record);
			const semanticHeader = semanticReviewHeader(semanticReview, record.bound_diff_hash, delegationId);
			const text = reviewText([...semanticHeader, ...result.lines].join("\n"));
			const nextIncludePaths: string[] = [];
			let nextIncludeBytes = 0;
			for (const path of presentation.presentation_remaining_paths) {
				if (nextIncludePaths.length >= MAX_REVIEW_PATCH_PATHS) break;
				if (typeof path !== "string" || Buffer.byteLength(path, "utf8") > MAX_REVIEW_PATH_BYTES) break;
				if (/[\u0000-\u001f\u007f]/.test(path)) break;
				const quotedBytes = Buffer.byteLength(JSON.stringify(path), "utf8") + (nextIncludePaths.length > 0 ? 2 : 0);
				if (nextIncludeBytes + quotedBytes > MAX_REVIEW_GUIDANCE_BYTES) break;
				nextIncludePaths.push(path);
				nextIncludeBytes += quotedBytes;
			}
			return {
				content: [{ type: "text", text }],
					details: {
						ok: true,
						delegation_id: delegationId,
						review_kind: "scope_integrity",
						verdict: record.verdict,
						scope_integrity_verdict: record.verdict,
						review_status: controller.getDelegationState().status,
						semantic_review: semanticReview,
						semantic_risk: semanticRisk,
						gate_authority: false,
						bound_diff_hash: record.bound_diff_hash,
					...(migrationBindingHash !== undefined
						? { migration_binding_hash: migrationBindingHash }
						: {}),
					...(semanticReview === "repair_required"
						? {
							repair_of: delegationId,
							next_action: "workbench_delegate_worker",
							...(repairDecisionHash === undefined ? {} : { repair_decision_hash: repairDecisionHash }),
							...(repairReasonHash === undefined ? {} : { repair_reason_hash: repairReasonHash }),
						}
						: {}),
					recorded_after_hash: record.recorded_after_hash,
					mismatch: record.mismatch,
					violation_count: record.violations.length,
					drift_count: record.drift_paths.length,
					checked_count: record.checked_paths.length,
					displayed_count: record.displayed_paths.length,
					remaining_count: record.remaining_paths.length,
						coverage_complete: record.coverage_complete,
						presentation_complete: presentation.presentation_complete,
						fully_presented_count: presentation.fully_presented_paths.length,
						presentation_remaining_count: presentation.presentation_remaining_paths.length,
					review_record: reviewRecordPath ?? record.review_path,
					next_include_paths: nextIncludePaths,
					patch_truncated: record.patch_truncated,
					authority_version: authorityVersion,
					finalized,
				},
			};
		},
		...workbenchToolRenderer("review", "workbench_review_worker_diff"),
	});
}
