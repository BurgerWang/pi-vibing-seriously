/** Public controller for the Sol-only structured Git capability. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ExecFn } from "./config.ts";
import { pushCurrentBranchV1, type GitPublishResultV1 } from "./git-publish.ts";
import {
	commitLatestReviewedDelegationV1,
	type LocalReviewedCommitServicesV1,
} from "./local-commit.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";
import { detectActorRole, type ActorFacts } from "./write-authority.ts";

export interface GitToolController {
	pi: Pick<ExtensionAPI, "registerTool">;
	services: LocalCommitToolServices;
	exec: ExecFn;
	trustedOrError(ctx: ExtensionContext): string | undefined;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	getMode(): WorkbenchMode;
	getIdentity(): ActorFacts;
	reconcileProjectAuthority(projectRoot: string, now: string): Promise<boolean>;
	refreshStatus(ctx: ExtensionContext): Promise<void>;
}

export interface LocalCommitToolServices {
	now(): Date;
	commitReviewed: typeof commitLatestReviewedDelegationV1;
	commitServices: LocalReviewedCommitServicesV1;
	pushCurrent: typeof pushCurrentBranchV1;
}

function publishFailureDetails(result: Extract<GitPublishResultV1, { ok: false }>): Record<string, unknown> {
	return {
		ok: false,
		action: "push",
		code: result.code,
		...(result.commit === undefined ? {} : { commit: result.commit }),
		...(result.branch === undefined ? {} : { branch: result.branch }),
	};
}

/** Register the structured Git tool at the final catalog position. */
export function registerGitTool(controller: GitToolController): void {
	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_git,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_git,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				return {
					content: [{ type: "text" as const, text: `workbench_git: ${trustError}` }],
					details: { ok: false, code: "untrusted_project" },
				};
			}
			if (controller.getMode() !== "DEV" || detectActorRole(controller.getIdentity()) !== "sol-commander") {
				return {
					content: [{ type: "text" as const, text: "workbench_git: permission_denied; Git checkpoint/push requires the approved Sol commander in DEV" }],
					details: { ok: false, code: "permission_denied" },
				};
			}
			const projectRoot = await controller.projectRootFor(ctx);
			if (params.action === "push") {
				const result = await controller.services.pushCurrent({
					project_root: projectRoot,
					expected_head: params.expected_head,
					...(params.remote === undefined ? {} : { remote: params.remote }),
					exec: controller.exec,
				});
				if (!result.ok) {
					return {
						content: [{ type: "text" as const, text: `workbench_git: ${result.code}; ${result.message}` }],
						details: publishFailureDetails(result),
					};
				}
				await controller.refreshStatus(ctx);
				return {
					content: [{
						type: "text" as const,
						text: `workbench_git: pushed; commit=${result.commit}; branch=${result.branch}; remote=${result.remote}; verification=${result.verification}; force=NOT_ALLOWED`,
					}],
					details: { action: "push", ...result },
				};
			}
			const now = controller.services.now().toISOString();
			const reconciled = await controller.reconcileProjectAuthority(projectRoot, now);
			if (!reconciled) {
				return {
					content: [{ type: "text" as const, text: "workbench_git: authority_unavailable; durable delegation authority could not be reconciled" }],
					details: { ok: false, code: "authority_unavailable" },
				};
			}
			const result = await controller.services.commitReviewed({
				project_root: projectRoot,
				message: params.message,
				now,
				exec: controller.exec,
			}, controller.services.commitServices);
			if (!result.ok) {
				return {
					content: [{
						type: "text" as const,
						text: `workbench_git: ${result.code}; ${result.message}`,
					}],
					details: {
						ok: false,
						action: "checkpoint",
						code: result.code,
						...(result.delegation_id === undefined ? {} : { delegation_id: result.delegation_id }),
						...(result.commit === undefined ? {} : { commit: result.commit }),
					},
				};
			}
			await controller.reconcileProjectAuthority(projectRoot, controller.services.now().toISOString());
			await controller.refreshStatus(ctx);
			const warning = result.lock_release === "recovery_required"
				? "; warning=local commit succeeded but the project lock requires recovery before the next delegation"
				: "";
			const nextActionCode = result.lock_release === "recovery_required"
				? "RECOVER_PROJECT_LOCK"
				: result.remaining_changed_paths > 0 ? "REVIEW_REMAINING_CHANGES" : "NONE";
			const nextAction = nextActionCode === "RECOVER_PROJECT_LOCK"
				? "; next_action=RECOVER_PROJECT_LOCK (do not start another commit or delegation until lock recovery succeeds)"
				: nextActionCode === "REVIEW_REMAINING_CHANGES"
					? "; next_action=REVIEW_REMAINING_CHANGES (all compatible accepted slices were checkpointed; remaining changes need review or belong to unrelated work)"
					: "; next_action=NONE (worktree has no remaining project changes)";
			return {
				content: [{
					type: "text" as const,
					text: `workbench_git: checkpointed; delegations=${result.delegation_ids.length}; commit=${result.commit}; branch=${result.branch}; paths=${result.committed_paths.length}; authority_binding=${result.authority_binding}; preserved_staged=${result.preserved_staged_paths}; remaining_changes=${result.remaining_changed_paths}; push=NOT_RUN${warning}${nextAction}`,
				}],
				details: {
					ok: true,
					action: "checkpoint",
					delegation_id: result.delegation_id,
					delegation_ids: result.delegation_ids,
					commit: result.commit,
					branch: result.branch,
					path_count: result.committed_paths.length,
					authority_binding: result.authority_binding,
					preserved_staged_count: result.preserved_staged_paths,
					remaining_changed_count: result.remaining_changed_paths,
					next_action: nextActionCode,
					push: "NOT_RUN",
					lock_release: result.lock_release,
				},
			};
		},
	});
}
