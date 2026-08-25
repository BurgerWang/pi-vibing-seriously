/** Public controller for the Sol-only reviewed local-commit capability. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ExecFn } from "./config.ts";
import {
	commitLatestReviewedDelegationV1,
	type LocalReviewedCommitServicesV1,
} from "./local-commit.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";
import { detectActorRole, type ActorFacts } from "./write-authority.ts";

export interface LocalCommitToolController {
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
}

/** Register the local-commit tool at the final catalog position. */
export function registerLocalCommitTool(controller: LocalCommitToolController): void {
	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_commit_reviewed,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_commit_reviewed,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				return {
					content: [{ type: "text" as const, text: `workbench_commit_reviewed: ${trustError}` }],
					details: { ok: false, code: "untrusted_project" },
				};
			}
			if (controller.getMode() !== "DEV" || detectActorRole(controller.getIdentity()) !== "sol-commander") {
				return {
					content: [{ type: "text" as const, text: "workbench_commit_reviewed: permission_denied; local commit requires the approved Sol commander in DEV" }],
					details: { ok: false, code: "permission_denied" },
				};
			}
			const projectRoot = await controller.projectRootFor(ctx);
			const now = controller.services.now().toISOString();
			const reconciled = await controller.reconcileProjectAuthority(projectRoot, now);
			if (!reconciled) {
				return {
					content: [{ type: "text" as const, text: "workbench_commit_reviewed: authority_unavailable; durable delegation authority could not be reconciled" }],
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
						text: `workbench_commit_reviewed: ${result.code}; ${result.message}`,
					}],
					details: {
						ok: false,
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
			return {
				content: [{
					type: "text" as const,
					text: `workbench_commit_reviewed: committed; delegation_id=${result.delegation_id}; commit=${result.commit}; branch=${result.branch}; paths=${result.committed_paths.length}; remaining_changes=${result.remaining_changed_paths}; push=NOT_RUN${warning}`,
				}],
				details: {
					ok: true,
					delegation_id: result.delegation_id,
					commit: result.commit,
					branch: result.branch,
					path_count: result.committed_paths.length,
					remaining_changed_count: result.remaining_changed_paths,
					push: "NOT_RUN",
					lock_release: result.lock_release,
				},
			};
		},
	});
}
