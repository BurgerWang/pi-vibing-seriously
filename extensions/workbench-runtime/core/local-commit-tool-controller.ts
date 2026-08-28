/** Public controller for the Sol-only structured Git capability. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ExecFn } from "./config.ts";
import { pushCurrentBranchV1, type GitPublishResultV1 } from "./git-publish.ts";
import {
	commitLatestReviewedDelegationV1,
	type LocalReviewedCommitServicesV1,
} from "./local-commit.ts";
import type {
	abandonCleanProjectDelegationRepairV1,
	closeInactiveProjectDelegationBlockerV2,
	quarantineProjectDelegationAuthorityV1,
} from "./delegation-project-authority.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";
import { detectActorRole, type ActorFacts } from "./write-authority.ts";
import type { ProjectCheckoutOperationLeaseV1 } from "./project-checkout-operation.ts";

export interface GitToolController {
	pi: Pick<ExtensionAPI, "registerTool">;
	services: LocalCommitToolServices;
	exec: ExecFn;
	trustedOrError(ctx: ExtensionContext): string | undefined;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	getMode(): WorkbenchMode;
	getIdentity(): ActorFacts;
	checkoutOperationForToolCall?(toolCallId: string, projectRoot: string): ProjectCheckoutOperationLeaseV1 | undefined;
	reconcileProjectAuthority(projectRoot: string, now: string): Promise<boolean>;
	refreshStatus(ctx: ExtensionContext): Promise<void>;
}

export interface LocalCommitToolServices {
	now(): Date;
	abandonCleanRepair: typeof abandonCleanProjectDelegationRepairV1;
	closeInactiveBlocker: typeof closeInactiveProjectDelegationBlockerV2;
	quarantineUnreadableAuthority: typeof quarantineProjectDelegationAuthorityV1;
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
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				return {
					content: [{ type: "text" as const, text: `workbench_git: ${trustError}` }],
					details: { ok: false, code: "untrusted_project" },
				};
			}
			const identity = controller.getIdentity();
			const mode = controller.getMode();
			const recoveryAction = params.action === "close_clean_repair" || params.action === "close_inactive_blocker" ||
				params.action === "quarantine_unreadable_authority";
			if ((mode !== "DEV" && !(mode === "VERIFY" && recoveryAction)) || detectActorRole(identity) !== "sol-commander") {
				return {
					content: [{ type: "text" as const, text: "workbench_git: permission_denied; authority recovery requires the approved Sol commander in DEV or VERIFY, while checkpoint/push remain DEV-only" }],
					details: { ok: false, code: "permission_denied" },
				};
			}
			const projectRoot = await controller.projectRootFor(ctx);
			if (params.action === "close_inactive_blocker") {
				if ((identity.provider !== "openai" && identity.provider !== "openai-codex") || identity.model !== "gpt-5.6-sol") {
					return { content: [{ type: "text" as const, text: "workbench_git: permission_denied" }], details: { ok: false, code: "permission_denied" } };
				}
				const result = await controller.services.closeInactiveBlocker({
					project_root: projectRoot,
					expected_delegation_id: params.delegation_id,
					now: controller.services.now().toISOString(),
					exec: controller.exec,
					closed_by: { provider: identity.provider, model: identity.model },
				});
				if (!result.ok) {
					return {
						content: [{ type: "text" as const, text: `workbench_git: ${result.code}; Git mutation=NONE; unrelated work preserved` }],
						details: { ok: false, action: "close_inactive_blocker", code: result.code, ...(result.delegation_id === undefined ? {} : { delegation_id: result.delegation_id }) },
					};
				}
				await controller.reconcileProjectAuthority(projectRoot, controller.services.now().toISOString());
				await controller.refreshStatus(ctx);
				return {
					content: [{ type: "text" as const, text: `workbench_git: inactive blocker closed; delegation=${result.value.delegation_id}; closed_attempts=${result.closed_delegation_ids.length}; relevant_paths=${result.value.relevant_paths.length}; unrelated work=PRESERVED; Git mutation=NONE; authority=NOT_ACCEPTED${result.remaining_blocker_id === undefined ? "; next_action=continue in this worktree" : "; next_action=follow the current status for the remaining blocker"}` }],
					details: {
						ok: true,
						action: "close_inactive_blocker",
						delegation_id: result.value.delegation_id,
						closed_delegation_ids: [...result.closed_delegation_ids],
						closed_attempt_count: result.closed_delegation_ids.length,
						relevant_path_count: result.value.relevant_paths.length,
						closure_hash: result.value.closure_hash,
						git_mutation: "NONE",
						authority: "NOT_ACCEPTED",
						unrelated_work: "PRESERVED",
						...(result.remaining_blocker_id === undefined ? {} : { remaining_blocker_id: result.remaining_blocker_id }),
					},
				};
			}
			if (params.action === "quarantine_unreadable_authority") {
				if ((identity.provider !== "openai" && identity.provider !== "openai-codex") || identity.model !== "gpt-5.6-sol") {
					return { content: [{ type: "text" as const, text: "workbench_git: permission_denied" }], details: { ok: false, code: "permission_denied" } };
				}
				const result = await controller.services.quarantineUnreadableAuthority({
					project_root: projectRoot,
					delegation_id: params.delegation_id,
					now: controller.services.now().toISOString(),
					quarantined_by: { provider: identity.provider, model: identity.model },
				});
				if (!result.ok) {
					return {
						content: [{ type: "text" as const, text: `workbench_git: ${result.code}; source authority and Git were not changed` }],
						details: { ok: false, action: "quarantine_unreadable_authority", code: result.code, ...(result.delegation_id === undefined ? {} : { delegation_id: result.delegation_id }) },
					};
				}
				await controller.reconcileProjectAuthority(projectRoot, controller.services.now().toISOString());
				await controller.refreshStatus(ctx);
				return {
					content: [{ type: "text" as const, text: `workbench_git: unreadable authority quarantined; delegation=${result.value.delegation_id}; inventory_entries=${result.value.inventory_entry_count}; source bytes=PRESERVED; Git mutation=NONE; authority=NOT_ACCEPTED; next_action=continue in this worktree` }],
					details: {
						ok: true,
						action: "quarantine_unreadable_authority",
						delegation_id: result.value.delegation_id,
						inventory_entry_count: result.value.inventory_entry_count,
						quarantine_hash: result.value.quarantine_hash,
						source_bytes: "PRESERVED",
						git_mutation: "NONE",
						authority: "NOT_ACCEPTED",
					},
				};
			}
			if (params.action === "close_clean_repair") {
				if ((identity.provider !== "openai" && identity.provider !== "openai-codex") || identity.model !== "gpt-5.6-sol") {
					return {
						content: [{ type: "text" as const, text: "workbench_git: permission_denied" }],
						details: { ok: false, code: "permission_denied" },
					};
				}
				const result = await controller.services.abandonCleanRepair({
					project_root: projectRoot,
					now: controller.services.now().toISOString(),
					exec: controller.exec,
					abandoned_by: { provider: identity.provider, model: identity.model },
				});
				if (!result.ok) {
					return {
						content: [{ type: "text" as const, text: `workbench_git: ${result.code}; no Git files or refs were changed` }],
						details: {
							ok: false,
							action: "close_clean_repair",
							code: result.code,
							...(result.delegation_id === undefined ? {} : { delegation_id: result.delegation_id }),
						},
					};
				}
				await controller.reconcileProjectAuthority(projectRoot, controller.services.now().toISOString());
				await controller.refreshStatus(ctx);
				return {
					content: [{
						type: "text" as const,
						text: `workbench_git: clean repair closed; delegation=${result.value.delegation_id}; git_head=${result.value.clean_git_head}; Git mutation=NONE; rejected authority=NOT_ACCEPTED; next_action=continue delegation in this worktree`,
					}],
					details: {
						ok: true,
						action: "close_clean_repair",
						delegation_id: result.value.delegation_id,
						git_head: result.value.clean_git_head,
						workspace_guard_hash: result.value.clean_workspace_guard_hash,
						abandonment_hash: result.value.abandonment_hash,
						git_mutation: "NONE",
						rejected_authority: "NOT_ACCEPTED",
						next_action: "CONTINUE_DELEGATION_IN_CURRENT_WORKTREE",
						...(result.lifecycle_resolution === undefined ? {} : {
							lifecycle_action: result.lifecycle_resolution.primary_action.action,
							lifecycle_reason: result.lifecycle_resolution.primary_action.reason,
							lifecycle_snapshot_hash: result.lifecycle_resolution.primary_action.snapshot_hash,
						}),
					},
				};
			}
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
			const checkoutOperation = controller.checkoutOperationForToolCall?.(toolCallId, projectRoot);
			const result = await controller.services.commitReviewed({
				project_root: projectRoot,
				message: params.message,
				now,
				exec: controller.exec,
				...(checkoutOperation === undefined ? {} : { checkout_operation_token: checkoutOperation.token }),
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
