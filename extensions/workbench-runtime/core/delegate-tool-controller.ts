/** Public worker-delegation tool controller. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ExecFn } from "./config.ts";
import type { completeDefaultDelegationDeliveryV2 } from "./delegation-default-delivery.ts";
import type { executeDelegationV2 } from "./delegation-execution-v2.ts";
import type { makeDelegationId, readDelegationLedger } from "./delegation-ledger.ts";
import {
	observeDiffChange,
	recordDelegation,
	recordRepairDelegation,
	reviewBlockReason,
	type DelegationState,
} from "./delegation-state.ts";
import { normalizeDelegationBoundedTaskContractV2 } from "./delegation-transaction-artifacts.ts";
import type { readRecoverableUnpublishedDelegationV2 } from "./delegation-project-authority.ts";
import type { readDelegationCommittedGenerationV2 } from "./delegation-transaction-storage.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";
import type { buildTrustedRecoveryAuthority } from "./trusted-recovery-authority.ts";
import type { TrustedRecoveryAuthority } from "./tool-result-ingress-projection.ts";
import {
	commanderBlockReason,
	resolveWorkerTaskKind,
	WORKER_MODEL_ID,
	WORKER_MODEL_SELECTOR,
	WORKER_PROVIDER,
} from "./worker-policy.ts";
import { buildDelegateWorkerResult } from "../worker/handoff.ts";

type CurrentDelegationBinding =
	| { readonly status: "unavailable" }
	| { readonly status: "fresh" | "conflict"; readonly hash: string };

export interface DelegateToolController<TIngress> {
	pi: Pick<ExtensionAPI, "registerTool">;
	services: DelegateToolServices;
	exec: ExecFn;
	secrets: readonly string[];
	trustedOrError(ctx: ExtensionContext): string | undefined;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	reconcileProjectAuthority(projectRoot: string, now: string): Promise<unknown>;
	getProjectAuthorityBlockReason(action: "delegation"): string | undefined;
	collectCurrentDelegationBinding(projectRoot: string, delegationId?: string): Promise<CurrentDelegationBinding>;
	projectTerminalReviewedBinding(projectRoot: string, delegationId: string, now: string): Promise<DelegationState | null>;
	getDelegationState(): DelegationState;
	setDelegationState(state: DelegationState): void;
	persistDelegationState(): void;
	persistDelegationStateStrict(state: DelegationState): void;
	markTerminalMirrorBlocked(): void;
	refreshStatus(ctx: ExtensionContext): Promise<void>;
	bindTrustedIngressAuthority(authority: TrustedRecoveryAuthority | undefined, content: unknown): TIngress | undefined;
	rememberTrustedIngressAuthority(toolCallId: unknown, toolName: unknown, bound: TIngress | undefined): void;
}

export interface DelegateToolServices {
	now(): Date;
	makeDelegationId: typeof makeDelegationId;
	readCommittedGeneration: typeof readDelegationCommittedGenerationV2;
	readRecoverableUnpublished: typeof readRecoverableUnpublishedDelegationV2;
	readLegacyLedger: typeof readDelegationLedger;
	executeDelegation: typeof executeDelegationV2;
	completeDefaultDelivery: typeof completeDefaultDelegationDeliveryV2;
	buildTrustedRecoveryAuthority: typeof buildTrustedRecoveryAuthority;
}

/** Register delegate_worker at its fixed catalog position. */
export function registerDelegateTool<TIngress>(controller: DelegateToolController<TIngress>): void {
	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_delegate_worker,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_delegate_worker,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let trustedIngress: TIngress | undefined;
			try {
				const trustError = controller.trustedOrError(ctx);
				if (trustError) throw new Error(`workbench_delegate_worker: ${trustError}`);
				const commanderError = commanderBlockReason(ctx.model?.provider, ctx.model?.id);
				if (commanderError) throw new Error(commanderError);
				const taskKind = resolveWorkerTaskKind(params.task_kind);
				if (!taskKind.ok) throw new Error(`workbench_delegate_worker: ${taskKind.error}`);
				const contract = normalizeDelegationBoundedTaskContractV2({
					task_kind: taskKind.taskKind,
					task: params.task,
					allowed_paths: params.allowed_paths,
					acceptance_criteria: params.acceptance_criteria,
					...(params.verification === undefined ? {} : { verification: params.verification }),
					...(params.timeout_seconds === undefined ? {} : { timeout_seconds: params.timeout_seconds }),
					...(params.budget_profile === undefined ? {} : { budget_profile: params.budget_profile }),
					...(params.repair_of === undefined ? {} : { repair_of: params.repair_of }),
				});
				if (!contract.ok) throw new Error(`workbench_delegate_worker: ${contract.error.code}`);
				const projectRoot = await controller.projectRootFor(ctx);
				await controller.reconcileProjectAuthority(projectRoot, controller.services.now().toISOString());
				const projectBlock = controller.getProjectAuthorityBlockReason("delegation");
				if (projectBlock) throw new Error(`workbench_delegate_worker: ${projectBlock}`);

				let v2RepairAuthority: { id: string; kind: "committed" | "unpublished" } | undefined;
				if (contract.value.repair_of !== undefined) {
					const repairId = contract.value.repair_of;
					const priorV2 = await controller.services.readCommittedGeneration(projectRoot, repairId);
					if (priorV2.ok) {
						if (!new Set<string>(["FAILED", "FINISHED", "REVIEWED"]).has(priorV2.value.state.status)) {
							throw new Error(`workbench_delegate_worker: repair_of ${repairId} references non-terminal v2 status ${priorV2.value.state.status}`);
						}
						v2RepairAuthority = { id: repairId, kind: "committed" };
					} else if (priorV2.error.code === "not_found") {
						const priorV1 = await controller.services.readLegacyLedger(projectRoot, repairId);
						if (priorV1 === null || priorV1.manifest.status !== "finished" || priorV1.after === null) {
							throw new Error(`workbench_delegate_worker: repair_of ${repairId} does not reference a finished delegation authority`);
						}
					} else if (priorV2.error.code === "invalid_record") {
						const recoverable = await controller.services.readRecoverableUnpublished(projectRoot, repairId);
						if (!recoverable.ok) {
							throw new Error(`workbench_delegate_worker: repair_of ${repairId} unpublished v2 authority is ${recoverable.error.code}`);
						}
						v2RepairAuthority = { id: repairId, kind: "unpublished" };
					} else {
						throw new Error(`workbench_delegate_worker: repair_of ${repairId} v2 authority is ${priorV2.error.code}`);
					}
				}

				const startedAt = controller.services.now().toISOString();
				let currentState = controller.getDelegationState();
				if (currentState.latestId !== undefined) {
					const priorBinding = await controller.collectCurrentDelegationBinding(projectRoot, currentState.latestId);
					if (priorBinding.status === "unavailable") {
						throw new Error("workbench_delegate_worker: current delegation binding is unavailable; start fails closed");
					}
					const observedState = observeDiffChange(currentState, priorBinding.hash, startedAt);
					if (observedState !== currentState) {
						controller.setDelegationState(observedState);
						controller.persistDelegationState();
						currentState = observedState;
					}
				}
				const reviewBlock = reviewBlockReason(currentState, "delegation");
				const exactBlockingRepair = reviewBlock !== undefined
					&& v2RepairAuthority !== undefined
					&& currentState.latestId === v2RepairAuthority.id;
				if (reviewBlock && !exactBlockingRepair) throw new Error(`workbench_delegate_worker: ${reviewBlock}`);
				if (v2RepairAuthority?.kind === "unpublished" && !exactBlockingRepair) {
					throw new Error(`workbench_delegate_worker: repair_of ${v2RepairAuthority.id} is not the latest blocking delegation`);
				}

				const delegationId = controller.services.makeDelegationId(controller.services.now());
				const execution = await controller.services.executeDelegation({
					projectRoot,
					delegationId,
					contract: contract.value,
					workerIdentity: {
						provider: WORKER_PROVIDER,
						model: WORKER_MODEL_ID,
						worker_id: `worker:${delegationId}`,
					},
					secrets: controller.secrets,
					signal,
					exec: controller.exec,
					clock: () => controller.services.now().toISOString(),
					onPrepared: async (_transaction, preparedBefore) => {
						if (v2RepairAuthority?.kind === "unpublished") {
							const revalidated = await controller.services.readRecoverableUnpublished(projectRoot, v2RepairAuthority.id);
							if (!revalidated.ok) throw new Error("recoverable repair authority changed before worker launch");
						} else if (v2RepairAuthority?.kind === "committed") {
							const revalidated = await controller.services.readCommittedGeneration(projectRoot, v2RepairAuthority.id);
							if (!revalidated.ok || !new Set<string>(["FAILED", "FINISHED", "REVIEWED"]).has(revalidated.value.state.status)) {
								throw new Error("committed repair authority changed before worker launch");
							}
						}
						const recordInput = {
							id: delegationId,
							diffHash: preparedBefore.diffHash,
							now: startedAt,
						};
						const recorded = exactBlockingRepair
							? recordRepairDelegation(controller.getDelegationState(), recordInput, v2RepairAuthority!.id)
							: recordDelegation(controller.getDelegationState(), recordInput);
						if (!recorded.ok) throw new Error("delegation session mirror refused PREPARED");
						controller.setDelegationState(recorded.state);
						controller.persistDelegationStateStrict(recorded.state);
						void controller.refreshStatus(ctx);
						onUpdate?.({
							content: [{ type: "text", text: `Pinned worker: 0 turn(s), model ${WORKER_MODEL_SELECTOR} | spend total 0 | output 0 | band ok` }],
							details: {
								phase: "starting",
								delegation_id: delegationId,
								turns: 0,
								totalTokens: 0,
								outputTokens: 0,
								spendBand: "ok",
								provider: WORKER_PROVIDER,
								model: WORKER_MODEL_SELECTOR,
							},
						});
					},
					onProgress: (progress) => {
						onUpdate?.({
							content: [{ type: "text", text: `Pinned worker: ${progress.turns} turn(s), model ${progress.provider ?? WORKER_PROVIDER}/${progress.model ?? WORKER_MODEL_ID} | spend total ${progress.totalTokens} | output ${progress.outputTokens} | band ${progress.spendBand}` }],
							details: {
								phase: "running",
								turns: progress.turns,
								totalTokens: progress.totalTokens,
								outputTokens: progress.outputTokens,
								spendBand: progress.spendBand,
								provider: progress.provider,
								model: progress.model,
							},
						});
					},
				});

				if (execution.after !== undefined) {
					const observed = observeDiffChange(controller.getDelegationState(), execution.after.diffHash, controller.services.now().toISOString());
					controller.setDelegationState(observed);
					try {
						controller.persistDelegationStateStrict(observed);
					} catch {
						throw new Error("workbench_delegate_worker: delegation v2 session mirror persistence failed");
					}
				}
				if (execution.after === undefined) {
					await controller.reconcileProjectAuthority(projectRoot, controller.services.now().toISOString());
				}
				if (!execution.ok) {
					if (execution.durable_state?.status === "FAILED" && execution.after !== undefined && execution.after.changedSinceBefore.length === 0) {
						const reviewed = await controller.projectTerminalReviewedBinding(projectRoot, delegationId, controller.services.now().toISOString());
						if (reviewed === null) {
							throw new Error("workbench_delegate_worker: delegation v2 failed terminal session mirror could not enter REVIEWED");
						}
						try {
							controller.persistDelegationStateStrict(reviewed);
						} catch {
							controller.markTerminalMirrorBlocked();
							throw new Error("workbench_delegate_worker: delegation v2 failed terminal session mirror persistence failed");
						}
					}
					const status = execution.durable_state?.status ?? "UNAVAILABLE";
					const reasons = execution.durable_state?.postcondition_reasons.join(",") || "none";
					const artifactError = execution.artifact_error_code === undefined
						? ""
						: `; artifact_error=${execution.artifact_error_code}`;
					throw new Error(`workbench_delegate_worker: delegation v2 ${execution.code}${artifactError}; durable_status=${status}; postconditions=${reasons}`);
				}
				const result = execution.result;
				const handoffSummary = execution.workerSummary;
				const authority = await controller.services.buildTrustedRecoveryAuthority({
					projectRoot,
					sourceKind: "completed_worker_report",
					toolCallId,
					toolName: "workbench_delegate_worker",
					sourcePath: handoffSummary.report_path,
					requiredFacts: [
						{ key: "delegation_id", value: delegationId },
						{ key: "status", value: "success" },
						{ key: "turns", value: result.turns },
						{ key: "exit_code", value: result.exitCode },
					],
				});
				if (authority === undefined) throw new Error("workbench_delegate_worker: delegation v2 trusted report authority unavailable");
				if (taskKind.taskKind === "diagnosis") {
					const reviewed = await controller.projectTerminalReviewedBinding(projectRoot, delegationId, controller.services.now().toISOString());
					if (reviewed === null) throw new Error("workbench_delegate_worker: diagnosis session mirror could not enter REVIEWED");
					try {
						controller.persistDelegationStateStrict(reviewed);
					} catch {
						controller.markTerminalMirrorBlocked();
						throw new Error("workbench_delegate_worker: diagnosis session mirror persistence failed");
					}
				} else {
					const delivery = await controller.services.completeDefaultDelivery({
						projectRoot,
						delegationId,
						changedPaths: handoffSummary.changed_paths,
						state: controller.getDelegationState(),
						exec: controller.exec,
						secrets: controller.secrets,
						now: controller.services.now().toISOString(),
						persistState: (nextState) => controller.persistDelegationStateStrict(nextState),
					});
					if (!delivery.ok) {
						if (delivery.code === "session_persistence_failed") controller.markTerminalMirrorBlocked();
						const reviewError = delivery.review_error === undefined ? "" : `; review_error=${delivery.review_error}`;
						throw new Error(`workbench_delegate_worker: default delivery ${delivery.code}${reviewError}; explicit review required`);
					}
				}
				const toolResult = buildDelegateWorkerResult({
					delegationId,
					provider: result.provider,
					model: result.model,
					status: "success",
					turns: result.turns,
					exitCode: result.exitCode,
					stopReason: result.stopReason,
					changedPaths: handoffSummary.changed_paths,
					usage: result.usage,
					cacheHitRatio: result.cacheHitRatio,
					budget: {
						maxContextTokens: result.budget.maxContextTokens,
						maxContextRatio: result.budget.maxContextRatio,
						softBudgetReached: result.budget.softBudgetReached,
						hardBudgetExceeded: result.budget.hardBudgetExceeded,
						compactionCount: result.budget.compactionCount,
						compactionReasons: [...result.budget.compactionReasons],
					},
					reportPath: handoffSummary.report_path,
					summary: handoffSummary,
					spend: handoffSummary.spend,
					reviewStatus: controller.getDelegationState().status,
				});
				void controller.refreshStatus(ctx);
				trustedIngress = controller.bindTrustedIngressAuthority(authority, toolResult.content);
				return toolResult;
			} finally {
				controller.rememberTrustedIngressAuthority(toolCallId, "workbench_delegate_worker", trustedIngress);
			}
		},
	});
}
