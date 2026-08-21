/** Public delegation diff-review tool controller. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ExecFn } from "./config.ts";
import {
	demoteReviewedToPending,
	markReviewed,
	observeDiffChange,
	type DelegationState,
} from "./delegation-state.ts";
import type { reviewDelegationV2 } from "./delegation-review-v2.ts";
import type { readDelegationCommittedGenerationV2 } from "./delegation-transaction-storage.ts";
import {
	MAX_REVIEW_GUIDANCE_BYTES,
	MAX_REVIEW_PATCH_PATHS,
	MAX_REVIEW_PATH_BYTES,
	type reviewDelegation,
} from "./diff-review.ts";
import {
	DIFF_REVIEW_RESULT_MAX_BYTES,
	DIFF_REVIEW_RESULT_MAX_LINES,
	clampWholeResultText,
} from "./output-policy.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";
import { workbenchToolRenderer } from "../ui/tool-renderers.ts";

interface OutputAuthorizationReservation {
	readonly allowed: boolean;
	readonly allocatedBytes: number;
}

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
			const reviewText = (value: unknown): string => clampWholeResultText(value, {
				maxBytes: renderMaxBytes,
				maxLines: renderMaxLines,
			}).text;
			if (renderMaxBytes <= 0) return { content: [], details: { ok: false, error: "output_allocation_unavailable" } };
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
			if (v2Preflight.ok) {
				authorityVersion = 2;
				const v2Result = await controller.services.reviewV2({
					projectRoot,
					delegationId,
					exec: controller.exec,
					includePaths: params.include_paths,
					maxLines: renderMaxLines,
					maxBytes: renderMaxBytes,
					secrets: controller.secrets,
					now,
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
					return {
						content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: v2 ${v2Result.error.code}`) }],
						details: { ok: false, error: v2Result.error.code, authority_version: 2 },
					};
				}
				result = v2Result.review;
				finalized = v2Result.finalized;
				reviewRecordPath = v2Result.review_path;
				if (!result.ok || !result.record) {
					return {
						content: [{ type: "text", text: reviewText("workbench_review_worker_diff: v2 review record unavailable") }],
						details: { ok: false, error: "review_invalid", authority_version: 2 },
					};
				}

				let projected = observeDiffChange(controller.getDelegationState(), result.record.bound_diff_hash, now);
				if (finalized && result.record.verdict === "PASS" && result.record.coverage_complete) {
					if (projected.status !== "REVIEWED") {
						const marked = markReviewed(projected, now);
						if (!marked.ok) {
							return {
								content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: finalized v2 review could not project REVIEWED: ${marked.error}`) }],
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
				result = await controller.services.reviewLegacy({
					projectRoot,
					delegationId,
					exec: controller.exec,
					includePaths: params.include_paths,
					maxLines: renderMaxLines,
					maxBytes: renderMaxBytes,
					secrets: controller.secrets,
				});
				if (!result.ok || !result.record) {
					return { content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: ${result.error ?? "review failed"}`) }], details: { ok: false, error: result.error } };
				}
				let nextState = observeDiffChange(controller.getDelegationState(), result.record.bound_diff_hash, now);
				if (result.record.verdict === "PASS" && result.record.coverage_complete) {
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
				return {
					content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: v2 authority ${v2Preflight.error.code}; legacy fallback refused`) }],
					details: { ok: false, error: v2Preflight.error.code, authority_version: 2 },
				};
			}
			void controller.refreshStatus(ctx);
			const record = result.record;
			const text = reviewText(result.lines.join("\n"));
			const nextIncludePaths: string[] = [];
			let nextIncludeBytes = 0;
			for (const path of record.remaining_paths) {
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
					verdict: record.verdict,
					review_status: controller.getDelegationState().status,
					bound_diff_hash: record.bound_diff_hash,
					recorded_after_hash: record.recorded_after_hash,
					mismatch: record.mismatch,
					violation_count: record.violations.length,
					drift_count: record.drift_paths.length,
					checked_count: record.checked_paths.length,
					displayed_count: record.displayed_paths.length,
					remaining_count: record.remaining_paths.length,
					coverage_complete: record.coverage_complete,
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
