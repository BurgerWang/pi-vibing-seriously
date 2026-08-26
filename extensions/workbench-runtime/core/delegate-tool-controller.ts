/** Public worker-delegation tool controller. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ExecFn } from "./config.ts";
import { boundedCommandText, boundedInlineDetail } from "./command-output.ts";
import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import type { completeDefaultDelegationDeliveryV2 } from "./delegation-default-delivery.ts";
import type { executeDelegationV2 } from "./delegation-execution-v2.ts";
import {
	abortPristinePreparedDelegationUnderStartLockV2,
	isStrictRetryableAbortedRepairV2,
	isStrictRetryableEmptyRepairRecoveryV2,
} from "./delegation-execution-owner.ts";
import type { makeDelegationId, readDelegationLedger } from "./delegation-ledger.ts";
import { isVerifyConfigMaintenanceDelegation, type WorkbenchMode } from "./mode-policy.ts";
import {
	observeDiffChange,
	recordDelegation,
	recordRepairDelegation,
	recordSuccessorAfterFinalizedReview,
	reviewBlockReason,
	type DelegationState,
} from "./delegation-state.ts";
import { normalizeDelegationBoundedTaskContractV2 } from "./delegation-transaction-artifacts.ts";
import {
	acquireProjectDelegationStartLockV1,
	releaseProjectDelegationStartLockV1,
	type ProjectDelegationStartLockLeaseV1,
} from "./delegation-start-lock.ts";
import { readDelegationPlanContractAuthority } from "./delegation-plan-reference.ts";
import { planReferenceHash, verifyCurrentPlanReference } from "./plan-reference.ts";
import type { readRecoverableUnpublishedDelegationV2 } from "./delegation-project-authority.ts";
import {
	delegationGenerationRecordRelativePathV2,
	hasDelegationSemanticRepairAuthorityV2,
	hasDelegationSemanticReviewAuthorityV2,
	readDelegationTransactionV2,
	readDelegationReviewV2,
	type DelegationCommittedGenerationV2,
	type readDelegationCommittedGenerationV2,
} from "./delegation-transaction-storage.ts";
import { readDelegationInactiveBlockerClosureV2 } from "./delegation-authority-closure.ts";
import { readDelegationCleanRepairAbandonmentV1 } from "./delegation-repair-abandonment.ts";
import {
	bindDelegationRepairLineageV1,
	exactDelegationRepairAllowedPathsV1,
	DELEGATION_REPAIR_LINEAGE_MAX_DEPTH,
	type DelegationRepairLineageV1,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";
import type { buildTrustedRecoveryAuthority } from "./trusted-recovery-authority.ts";
import type { TrustedRecoveryAuthority } from "./tool-result-ingress-projection.ts";
import { workerVerificationRecipeNames } from "./worker-contract.ts";
import {
	commanderBlockReason,
	resolveWorkerTaskKind,
	WORKER_MODEL_ID,
	WORKER_MODEL_SELECTOR,
	WORKER_PROVIDER,
} from "./worker-policy.ts";
import { validateWorkerVerificationRecipes } from "./worker-verification.ts";
import { buildDelegateWorkerResult, type HandoffScopeIntegrityPacket } from "../worker/handoff.ts";

type CurrentDelegationBinding =
	| { readonly status: "unavailable" }
	| { readonly status: "fresh" | "conflict"; readonly hash: string };

const DELEGATION_FAILURE_SUMMARY_MAX_BYTES = 2_048 as const;

type PreparedCallbackStep =
	| "verification_recheck"
	| "plan_recheck"
	| "repair_authority_recheck"
	| "finalized_successor_recheck"
	| "reviewed_binding_recheck"
	| "session_transition"
	| "session_persist"
	| "start_lock_release"
	| "progress_publish";

type V2RepairAuthorityKind = "committed" | "unpublished" | "raw-lineage";

interface V2RepairAuthority {
	id: string;
	kind: V2RepairAuthorityKind;
	status: DelegationTransactionRecord["status"];
	contractHash: string;
	generationContentHash: string | null;
	semanticDecisionHash: string | null;
	expectedBindingHash: string;
	repairLineage?: DelegationRepairLineageV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function byteSortedUnion(...sets: ReadonlyArray<readonly string[]>): string[] | undefined {
	const paths = [...new Set(sets.flatMap((set) => [...set]))].sort(byteCompare);
	return paths.length > 0 && paths.length <= 500 ? paths : undefined;
}

function strictCommittedChangeSet(value: DelegationCommittedGenerationV2): ChangeSetRecord | undefined {
	const scope = value.records["scope.json"];
	if (!isRecord(scope) || !validateChangeSet(scope.change_set)) return undefined;
	const changeSet = scope.change_set as ChangeSetRecord;
	if (changeSet.delegation_id !== value.state.delegation_id || changeSet.contract_hash !== value.state.contract_hash ||
		value.state.terminal_outcome === null || value.state.terminal_outcome.change_set_status !== changeSet.status ||
		value.state.terminal_outcome.delta_hash !== changeSet.worker_delta_hash) return undefined;
	return changeSet;
}

/**
 * Derive the immutable continuity for one exact repair successor.
 *
 * The first link is rooted in the packet-bound Sol REPAIR decision. Later
 * links preserve that root and add the immediate parent's strict W/D scope.
 */
export function deriveDelegationRepairLineageV1(input: {
	parent: DelegationTransactionRecord;
	changeSet?: ChangeSetRecord;
	semanticDecision?: { delegationId: string; decisionHash: string };
	additionalPaths?: readonly string[];
}): DelegationRepairLineageV1 | undefined {
	const parentLineage = input.parent.repair_lineage;
	const workerPaths = input.changeSet?.worker_delta.map((entry) => entry.path) ?? [];
	const dependencyPaths = input.changeSet?.dependency_paths ?? [];
	const carriedPaths = byteSortedUnion(
		parentLineage?.carried_paths ?? [],
		workerPaths,
		dependencyPaths,
		input.additionalPaths ?? [],
	);
	if (carriedPaths === undefined) return undefined;
	if (parentLineage === undefined) {
		if (input.semanticDecision === undefined || input.semanticDecision.delegationId !== input.parent.delegation_id || input.changeSet === undefined) return undefined;
		return bindDelegationRepairLineageV1({
			schema_version: 1,
			kind: "semantic-repair-lineage-v1",
			root_delegation_id: input.parent.delegation_id,
			repair_of: input.parent.delegation_id,
			root_decision_hash: input.semanticDecision.decisionHash,
			continuation_decision_delegation_id: input.parent.delegation_id,
			continuation_decision_hash: input.semanticDecision.decisionHash,
			parent_lineage_hash: null,
			depth: 1,
			carried_paths: carriedPaths,
		});
	}
	if (input.semanticDecision !== undefined && input.semanticDecision.delegationId !== input.parent.delegation_id) return undefined;
	return bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: parentLineage.root_delegation_id,
		repair_of: input.parent.delegation_id,
		root_decision_hash: parentLineage.root_decision_hash,
		continuation_decision_delegation_id: input.semanticDecision?.delegationId ?? parentLineage.continuation_decision_delegation_id,
		continuation_decision_hash: input.semanticDecision?.decisionHash ?? parentLineage.continuation_decision_hash,
		parent_lineage_hash: parentLineage.lineage_hash,
		// Depth is a bounded/saturated diagnostic counter. The cryptographic
		// parent hash and immediate repair_of continue to advance at the cap.
		depth: Math.min(parentLineage.depth + 1, DELEGATION_REPAIR_LINEAGE_MAX_DEPTH),
		carried_paths: carriedPaths,
	});
}

export interface DelegateToolController<TIngress> {
	pi: Pick<ExtensionAPI, "registerTool">;
	services: DelegateToolServices;
	exec: ExecFn;
	secrets: readonly string[];
	trustedOrError(ctx: ExtensionContext): string | undefined;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	getMode?(): WorkbenchMode;
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
	acquireStartLock: typeof acquireProjectDelegationStartLockV1;
	releaseStartLock: typeof releaseProjectDelegationStartLockV1;
	readCommittedGeneration: typeof readDelegationCommittedGenerationV2;
	/** Optional injection seam; production falls back to the strict storage reader. */
	readTransaction?: typeof readDelegationTransactionV2;
	/** Optional injection seam; production falls back to the strict storage reader. */
	readReview?: typeof readDelegationReviewV2;
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
			const refreshFailureStatus = async (): Promise<void> => {
				try { await controller.refreshStatus(ctx); } catch { /* failure reporting stays primary */ }
			};
			let trustedIngress: TIngress | undefined;
			let startLockLease: ProjectDelegationStartLockLeaseV1 | undefined;
			let preserveStartLock = false;
			const releaseStartLock = async (): Promise<void> => {
				if (startLockLease === undefined) return;
				const released = await controller.services.releaseStartLock(startLockLease);
				if (!released.ok) throw new Error(`workbench_delegate_worker: project start lock release ${released.error.code}`);
				startLockLease = undefined;
			};
			try {
				const trustError = controller.trustedOrError(ctx);
				if (trustError) throw new Error(`workbench_delegate_worker: ${trustError}`);
				const commanderError = commanderBlockReason(ctx.model?.provider, ctx.model?.id);
				if (commanderError) throw new Error(commanderError);
				if ((controller.getMode?.() ?? "DEV") === "VERIFY" && !isVerifyConfigMaintenanceDelegation(params)) {
					throw new Error("workbench_delegate_worker: VERIFY permits only review-gated maintenance of exact recipes.yaml/gates.yaml paths with verification omitted");
				}
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
					...(params.plan_ref === undefined ? {} : { plan_ref: params.plan_ref }),
					...(params.extended_reason === undefined ? {} : { extended_reason: params.extended_reason }),
				});
				if (!contract.ok) throw new Error(`workbench_delegate_worker: ${contract.error.code}`);
				const projectRoot = await controller.projectRootFor(ctx);
				const verificationRecipes = workerVerificationRecipeNames(contract.value.verification);
				if (verificationRecipes === undefined) {
					throw new Error("workbench_delegate_worker: invalid verification recipe reference");
				}
				const initialVerification = await validateWorkerVerificationRecipes(projectRoot, verificationRecipes);
				if (!initialVerification.ok) {
					const recipe = initialVerification.recipe === undefined ? undefined : boundedInlineDetail(initialVerification.recipe, 200);
					const configRepair = initialVerification.code === "config_invalid" || initialVerification.code === "recipe_missing";
					const nextAction = configRepair
						? `retry workbench_delegate_worker with allowed_paths=[\".pi/workbench/recipes.yaml\"] and verification omitted to repair only the recipe declaration, review that delta, then retry the original delegation; this lane is available in DEV and VERIFY`
						: "correct the verification contract to reference an existing write-free, parameter-free recipe, then retry";
					return {
						content: [{
							type: "text" as const,
							text: boundedCommandText(`workbench_delegate_worker: verification_${initialVerification.code}${recipe === undefined ? "" : `\nrecipe: ${recipe}`}\nnext_action: ${nextAction}`),
						}],
						details: {
							ok: false,
							error: `verification_${initialVerification.code}`,
							...(recipe === undefined ? {} : { recipe }),
							...(initialVerification.issue_count === undefined ? {} : { issue_count: initialVerification.issue_count }),
							next_action: nextAction,
						},
					};
				}
				const verifyRecipesBeforeLaunch = async (): Promise<void> => {
					const preflight = await validateWorkerVerificationRecipes(projectRoot, verificationRecipes);
					if (!preflight.ok) {
						const recipe = preflight.recipe === undefined ? "" : `; recipe=${preflight.recipe}`;
						throw new Error(`workbench_delegate_worker: verification ${preflight.code}${recipe}`);
					}
				};
				if (contract.value.plan_ref !== undefined) {
					const currentPlan = await verifyCurrentPlanReference(projectRoot, contract.value.plan_ref);
					if (!currentPlan.ok) throw new Error(`workbench_delegate_worker: plan_ref ${currentPlan.error.code}`);
				}
				// Reconcile before acquiring a new start lock so a dead prior lock can
				// prove and close the PREPARED-before-execution-owner crash window.
				await controller.reconcileProjectAuthority(projectRoot, controller.services.now().toISOString());
				const initialProjectBlock = controller.getProjectAuthorityBlockReason("delegation");
				if (initialProjectBlock) throw new Error(`workbench_delegate_worker: ${initialProjectBlock}`);
				const startedAt = controller.services.now().toISOString();
				const delegationId = controller.services.makeDelegationId(new Date(startedAt));
				const acquired = await controller.services.acquireStartLock({
					project_root: projectRoot,
					delegation_id: delegationId,
					now: startedAt,
				});
				if (!acquired.ok) throw new Error(`workbench_delegate_worker: project start lock ${acquired.error.code}`);
				startLockLease = acquired.value;
				await controller.reconcileProjectAuthority(projectRoot, controller.services.now().toISOString());
				const projectBlock = controller.getProjectAuthorityBlockReason("delegation");
				if (projectBlock) throw new Error(`workbench_delegate_worker: ${projectBlock}`);

				const readTransaction = controller.services.readTransaction ?? readDelegationTransactionV2;
				const readReview = controller.services.readReview ?? readDelegationReviewV2;
				const lineageWritePaths = exactDelegationRepairAllowedPathsV1(contract.value.allowed_paths);
				const requireLineageWritePaths = (): string[] => {
					if (lineageWritePaths === undefined) {
						throw new Error("workbench_delegate_worker: unresolved semantic repair requires only exact-file allowed_paths; subtree or glob rules are forbidden");
					}
					return lineageWritePaths;
				};
				const hasStrictLineageRoot = async (state: DelegationTransactionRecord): Promise<boolean> => {
					if (state.repair_lineage === undefined) return true;
					const root = await readReview(projectRoot, state.repair_lineage.root_delegation_id);
					return root.ok && hasDelegationSemanticRepairAuthorityV2(root.value) &&
						root.value.semantic_repair!.decision_hash === state.repair_lineage.root_decision_hash;
				};
				const repairWasDurablyClosed = async (state: DelegationTransactionRecord): Promise<boolean> => {
					const inactiveClosure = await readDelegationInactiveBlockerClosureV2(projectRoot, state);
					if (!inactiveClosure.ok) {
						throw new Error(`workbench_delegate_worker: repair_of ${state.delegation_id} blocker closure is ${inactiveClosure.error.code}`);
					}
					if (inactiveClosure.value !== undefined) return true;
					const rootId = state.repair_lineage?.root_delegation_id ?? state.delegation_id;
					const root = await readReview(projectRoot, rootId);
					if (!root.ok || !hasDelegationSemanticRepairAuthorityV2(root.value)) return false;
					const closed = await readDelegationCleanRepairAbandonmentV1(
						projectRoot,
						state,
						root.value.semantic_repair!,
					);
					if (!closed.ok) throw new Error(`workbench_delegate_worker: repair_of ${state.delegation_id} clean-repair closure is ${closed.error.code}`);
					return closed.value !== undefined;
				};
				let v2RepairAuthority: V2RepairAuthority | undefined;
				if (contract.value.repair_of !== undefined) {
					const repairId = contract.value.repair_of;
					const priorV2 = await controller.services.readCommittedGeneration(projectRoot, repairId);
					if (priorV2.ok) {
						const parent = priorV2.value.state;
						if (await repairWasDurablyClosed(parent)) {
							throw new Error(`workbench_delegate_worker: repair_of ${repairId} was durably closed after the rejected delta was discarded; start an ordinary delegation`);
						}
						if (!await hasStrictLineageRoot(parent)) {
							throw new Error(`workbench_delegate_worker: repair_of ${repairId} repair lineage root authority is invalid`);
						}
						let semanticDecisionHash: string | null = null;
						let expectedSemanticBinding: string | undefined;
						let repairLineage: DelegationRepairLineageV1 | undefined;
						if (parent.status === "PENDING_REVIEW") {
							const priorReview = await readReview(projectRoot, repairId);
							if (!priorReview.ok || !hasDelegationSemanticRepairAuthorityV2(priorReview.value)) {
								throw new Error(`workbench_delegate_worker: repair_of ${repairId} requires an exact immutable semantic REPAIR decision`);
							}
							const changeSet = strictCommittedChangeSet(priorV2.value);
							semanticDecisionHash = priorReview.value.semantic_repair!.decision_hash;
							expectedSemanticBinding = priorReview.value.semantic_repair!.expected_bound_diff_hash;
							repairLineage = changeSet === undefined ? undefined : deriveDelegationRepairLineageV1({
								parent,
								changeSet,
								semanticDecision: { delegationId: parent.delegation_id, decisionHash: semanticDecisionHash },
								additionalPaths: requireLineageWritePaths(),
							});
							if (repairLineage === undefined) {
								throw new Error(`workbench_delegate_worker: repair_of ${repairId} has no bounded strict ChangeSet lineage`);
							}
						} else if (parent.status === "FAILED" || parent.status === "RECOVERY_REQUIRED") {
							if (parent.status === "RECOVERY_REQUIRED" && parent.repair_lineage === undefined) {
								throw new Error(`workbench_delegate_worker: repair_of ${repairId} references recovery without inherited repair lineage`);
							}
							if (parent.repair_lineage !== undefined) {
								const changeSet = strictCommittedChangeSet(priorV2.value);
								repairLineage = changeSet === undefined ? undefined : deriveDelegationRepairLineageV1({
									parent,
									changeSet,
									additionalPaths: requireLineageWritePaths(),
								});
								if (repairLineage === undefined) {
									throw new Error(`workbench_delegate_worker: repair_of ${repairId} repair lineage cannot be advanced safely`);
								}
							}
						} else if (parent.status === "REVIEWED") {
							const priorReview = await readReview(projectRoot, repairId);
							if (!priorReview.ok || !priorReview.value.finalized ||
								!hasDelegationSemanticReviewAuthorityV2(priorReview.value)) {
								throw new Error(`workbench_delegate_worker: repair_of ${repairId} requires explicit historical semantic migration review first`);
							}
						} else if (parent.status !== "FINISHED") {
							throw new Error(`workbench_delegate_worker: repair_of ${repairId} references non-repairable v2 status ${parent.status}`);
						}
						const binding = await controller.collectCurrentDelegationBinding(projectRoot, repairId);
						if (binding.status !== "fresh" ||
							(expectedSemanticBinding !== undefined && binding.hash !== expectedSemanticBinding)) {
							throw new Error(`workbench_delegate_worker: repair_of ${repairId} current binding is not the exact repair authority`);
						}
						v2RepairAuthority = {
							id: repairId,
							kind: "committed",
							status: parent.status,
							contractHash: parent.contract_hash,
							generationContentHash: priorV2.value.proof.content_hash,
							semanticDecisionHash,
							expectedBindingHash: binding.hash,
							...(repairLineage === undefined ? {} : { repairLineage }),
						};
					} else if (priorV2.error.code === "not_found") {
						const priorV1 = await controller.services.readLegacyLedger(projectRoot, repairId);
						if (priorV1 === null || priorV1.manifest.status !== "finished" || priorV1.after === null) {
							throw new Error(`workbench_delegate_worker: repair_of ${repairId} does not reference a finished delegation authority`);
						}
					} else if (priorV2.error.code === "invalid_record") {
						const raw = await readTransaction(projectRoot, repairId);
						if (raw.ok && await repairWasDurablyClosed(raw.value)) {
							throw new Error(`workbench_delegate_worker: repair_of ${repairId} was durably closed after the rejected delta was discarded; start an ordinary delegation`);
						}
						const rawLineageRetryable = raw.ok && raw.value.repair_lineage !== undefined &&
							(await isStrictRetryableAbortedRepairV2(projectRoot, raw.value) ||
								await isStrictRetryableEmptyRepairRecoveryV2(projectRoot, raw.value));
						if (raw.ok && rawLineageRetryable && await hasStrictLineageRoot(raw.value)) {
							const repairLineage = deriveDelegationRepairLineageV1({
								parent: raw.value,
								additionalPaths: requireLineageWritePaths(),
							});
							const binding = await controller.collectCurrentDelegationBinding(projectRoot, repairId);
							if (repairLineage === undefined || binding.status !== "fresh") {
								throw new Error(`workbench_delegate_worker: repair_of ${repairId} raw repair lineage cannot be advanced safely`);
							}
							v2RepairAuthority = {
								id: repairId,
								kind: "raw-lineage",
								status: raw.value.status,
								contractHash: raw.value.contract_hash,
								generationContentHash: null,
								semanticDecisionHash: null,
								expectedBindingHash: binding.hash,
								repairLineage,
							};
						} else {
							const recoverable = await controller.services.readRecoverableUnpublished(projectRoot, repairId);
							if (!recoverable.ok) {
								throw new Error(`workbench_delegate_worker: repair_of ${repairId} unpublished v2 authority is ${recoverable.error.code}`);
							}
							const parent = recoverable.value.transaction;
							if (!await hasStrictLineageRoot(parent)) {
								throw new Error(`workbench_delegate_worker: repair_of ${repairId} repair lineage root authority is invalid`);
							}
							const retryPaths = parent.repair_lineage === undefined
								? undefined
								: byteSortedUnion(parent.terminal_outcome?.changed_paths ?? [], requireLineageWritePaths());
							const repairLineage = parent.repair_lineage === undefined || retryPaths === undefined ? undefined : deriveDelegationRepairLineageV1({
								parent,
								additionalPaths: retryPaths,
							});
							if (parent.repair_lineage !== undefined && repairLineage === undefined) {
								throw new Error(`workbench_delegate_worker: repair_of ${repairId} recovery lineage cannot be advanced safely`);
							}
							const binding = await controller.collectCurrentDelegationBinding(projectRoot, repairId);
							if (binding.status !== "fresh") {
								throw new Error(`workbench_delegate_worker: repair_of ${repairId} current binding is unavailable`);
							}
							v2RepairAuthority = {
								id: repairId,
								kind: "unpublished",
								status: parent.status,
								contractHash: parent.contract_hash,
								generationContentHash: null,
								semanticDecisionHash: null,
								expectedBindingHash: binding.hash,
								...(repairLineage === undefined ? {} : { repairLineage }),
							};
						}
					} else {
						throw new Error(`workbench_delegate_worker: repair_of ${repairId} v2 authority is ${priorV2.error.code}`);
					}
					if (v2RepairAuthority?.repairLineage !== undefined && taskKind.taskKind !== "implementation") {
						throw new Error("workbench_delegate_worker: unresolved semantic repair lineage requires an implementation delegation");
					}
				}
				const revalidateV2RepairAuthority = async (): Promise<boolean> => {
					const authority = v2RepairAuthority;
					if (authority === undefined) return true;
					try {
						if (authority.kind === "committed") {
							const current = await controller.services.readCommittedGeneration(projectRoot, authority.id);
							if (!current.ok || current.value.state.status !== authority.status ||
								current.value.state.contract_hash !== authority.contractHash ||
								current.value.proof.content_hash !== authority.generationContentHash ||
								!await hasStrictLineageRoot(current.value.state)) return false;
							if (authority.semanticDecisionHash !== null) {
								const review = await readReview(projectRoot, authority.id);
								if (!review.ok || !hasDelegationSemanticRepairAuthorityV2(review.value) ||
									review.value.semantic_repair!.decision_hash !== authority.semanticDecisionHash ||
									review.value.semantic_repair!.expected_bound_diff_hash !== authority.expectedBindingHash) return false;
							} else if (authority.status === "REVIEWED") {
								const review = await readReview(projectRoot, authority.id);
								if (!review.ok || !review.value.finalized || !hasDelegationSemanticReviewAuthorityV2(review.value)) return false;
							}
							if (authority.repairLineage !== undefined) {
								const changeSet = strictCommittedChangeSet(current.value);
								const advanced = changeSet === undefined ? undefined : deriveDelegationRepairLineageV1({
									parent: current.value.state,
									changeSet,
									...(authority.semanticDecisionHash === null ? {} : {
										semanticDecision: { delegationId: current.value.state.delegation_id, decisionHash: authority.semanticDecisionHash },
									}),
									additionalPaths: requireLineageWritePaths(),
								});
								if (advanced?.lineage_hash !== authority.repairLineage.lineage_hash) return false;
							}
						} else if (authority.kind === "raw-lineage") {
							const current = await readTransaction(projectRoot, authority.id);
							if (!current.ok || current.value.status !== authority.status || current.value.contract_hash !== authority.contractHash ||
								!await hasStrictLineageRoot(current.value) ||
								(current.value.status === "RECOVERY_REQUIRED" &&
									!await isStrictRetryableEmptyRepairRecoveryV2(projectRoot, current.value)) ||
								deriveDelegationRepairLineageV1({
									parent: current.value,
									additionalPaths: requireLineageWritePaths(),
								})?.lineage_hash !== authority.repairLineage?.lineage_hash) return false;
						} else {
							const current = await controller.services.readRecoverableUnpublished(projectRoot, authority.id);
							if (!current.ok || current.value.transaction.status !== authority.status ||
								current.value.transaction.contract_hash !== authority.contractHash ||
								!await hasStrictLineageRoot(current.value.transaction)) return false;
							if (authority.repairLineage !== undefined) {
								const retryPaths = byteSortedUnion(
									current.value.transaction.terminal_outcome?.changed_paths ?? [],
									requireLineageWritePaths(),
								);
								const advanced = deriveDelegationRepairLineageV1({
									parent: current.value.transaction,
									...(retryPaths === undefined ? {} : { additionalPaths: retryPaths }),
								});
								if (retryPaths === undefined || advanced?.lineage_hash !== authority.repairLineage.lineage_hash) return false;
							}
						}
						const binding = await controller.collectCurrentDelegationBinding(projectRoot, authority.id);
						return binding.status === "fresh" && binding.hash === authority.expectedBindingHash;
					} catch {
						return false;
					}
				};

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
				if (!await revalidateV2RepairAuthority()) {
					throw new Error("workbench_delegate_worker: repair authority or current binding changed before transaction preparation");
				}
				const reviewBlock = reviewBlockReason(currentState, "delegation");
				const exactBlockingRepair = reviewBlock !== undefined
					&& v2RepairAuthority !== undefined
					&& currentState.latestId === v2RepairAuthority.id;
				let finalizedStaleSuccessorId: string | undefined;
				if (
					reviewBlock !== undefined
					&& contract.value.repair_of === undefined
					&& currentState.status === "STALE"
					&& currentState.latestId !== undefined
				) {
					const prior = await controller.services.readCommittedGeneration(projectRoot, currentState.latestId);
					if (prior.ok && prior.value.state.status === "REVIEWED") {
						const priorReview = await readDelegationReviewV2(projectRoot, currentState.latestId);
						if (priorReview.ok && priorReview.value.finalized && hasDelegationSemanticReviewAuthorityV2(priorReview.value)) {
							finalizedStaleSuccessorId = currentState.latestId;
						}
					}
				}
				if (reviewBlock && !exactBlockingRepair && finalizedStaleSuccessorId === undefined) {
					throw new Error(`workbench_delegate_worker: ${reviewBlock}`);
				}
				const reviewedPrelaunch = reviewBlock === undefined && currentState.latestId !== undefined &&
					currentState.status === "REVIEWED" && currentState.reviewedDiffHash !== undefined
					? { id: currentState.latestId, hash: currentState.reviewedDiffHash }
					: undefined;
				if (v2RepairAuthority !== undefined &&
					(v2RepairAuthority.kind !== "committed" || v2RepairAuthority.repairLineage !== undefined ||
						v2RepairAuthority.status === "PENDING_REVIEW") && !exactBlockingRepair) {
					throw new Error(`workbench_delegate_worker: repair_of ${v2RepairAuthority.id} is not the latest blocking delegation`);
				}
				// Continuity is anchored only in a strict committed generation. An
				// exact recoverable unpublished repair has no such generation yet and
				// follows its existing dedicated authority path above. Every ordinary
				// successor must preserve (or explicitly replace) a proven latest plan.
				const lineagePlanRoot = v2RepairAuthority?.repairLineage?.root_delegation_id;
				if (lineagePlanRoot !== undefined || !(v2RepairAuthority !== undefined && v2RepairAuthority.kind !== "committed" && exactBlockingRepair)) {
					const priorPlan = await readDelegationPlanContractAuthority(projectRoot, lineagePlanRoot ?? currentState.latestId);
					if (priorPlan.status === "blocked") {
						throw new Error(`workbench_delegate_worker: latest plan_ref authority is ${priorPlan.reason}`);
					}
					if (priorPlan.status === "present" && contract.value.plan_ref === undefined) {
						throw new Error("workbench_delegate_worker: plan_ref is required because the latest strict committed delegation carries one");
					}
					if (priorPlan.status === "present" &&
						planReferenceHash(contract.value.plan_ref!) !== priorPlan.planReferenceHash) {
						throw new Error("workbench_delegate_worker: plan_ref must exactly inherit the unresolved repair root plan");
					}
					if (lineagePlanRoot !== undefined && priorPlan.status === "absent" && contract.value.plan_ref !== undefined) {
						throw new Error("workbench_delegate_worker: plan_ref must exactly preserve the unresolved repair root's absent plan authority");
					}
				}

				let preparedCallbackStep: PreparedCallbackStep | undefined;
				const execution = await controller.services.executeDelegation({
					projectRoot,
					delegationId,
					contract: contract.value,
					...(v2RepairAuthority?.repairLineage === undefined ? {} : {
						dependencyPaths: [...v2RepairAuthority.repairLineage.carried_paths],
						repairLineage: v2RepairAuthority.repairLineage,
					}),
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
						preparedCallbackStep = "verification_recheck";
						await verifyRecipesBeforeLaunch();
						if (contract.value.plan_ref !== undefined) {
							preparedCallbackStep = "plan_recheck";
							const currentPlan = await verifyCurrentPlanReference(projectRoot, contract.value.plan_ref);
							if (!currentPlan.ok) throw new Error(`plan_ref ${currentPlan.error.code} before worker launch`);
						}
						if (v2RepairAuthority !== undefined) {
							preparedCallbackStep = "repair_authority_recheck";
							if (!await revalidateV2RepairAuthority()) {
								throw new Error("repair authority or current binding changed before worker launch");
							}
						} else if (finalizedStaleSuccessorId !== undefined) {
							preparedCallbackStep = "finalized_successor_recheck";
							const revalidated = await controller.services.readCommittedGeneration(projectRoot, finalizedStaleSuccessorId);
							const revalidatedReview = await readDelegationReviewV2(projectRoot, finalizedStaleSuccessorId);
							if (!revalidated.ok || revalidated.value.state.status !== "REVIEWED" || !revalidatedReview.ok ||
								!revalidatedReview.value.finalized || !hasDelegationSemanticReviewAuthorityV2(revalidatedReview.value)) {
								throw new Error("finalized stale successor authority changed before worker launch");
							}
						} else if (reviewedPrelaunch !== undefined) {
							preparedCallbackStep = "reviewed_binding_recheck";
							const rebound = await controller.collectCurrentDelegationBinding(projectRoot, reviewedPrelaunch.id);
							if (rebound.status !== "fresh" || rebound.hash !== reviewedPrelaunch.hash) {
								throw new Error("reviewed delegation authority changed before worker launch");
							}
						}
						const recordInput = {
							id: delegationId,
							diffHash: preparedBefore.diffHash,
							now: startedAt,
						};
						preparedCallbackStep = "session_transition";
						const recorded = exactBlockingRepair
							? recordRepairDelegation(controller.getDelegationState(), recordInput, v2RepairAuthority!.id)
							: finalizedStaleSuccessorId !== undefined
								? recordSuccessorAfterFinalizedReview(controller.getDelegationState(), recordInput, finalizedStaleSuccessorId)
								: recordDelegation(controller.getDelegationState(), recordInput);
						if (!recorded.ok) throw new Error("delegation session mirror refused PREPARED");
						controller.setDelegationState(recorded.state);
						preparedCallbackStep = "session_persist";
						controller.persistDelegationStateStrict(recorded.state);
						preparedCallbackStep = "start_lock_release";
						await releaseStartLock();
						void controller.refreshStatus(ctx);
						preparedCallbackStep = "progress_publish";
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
							content: [{ type: "text", text: `Pinned worker: ${progress.turns} turn(s), model ${progress.provider ?? WORKER_PROVIDER}/${progress.model ?? WORKER_MODEL_ID} | spend total ${progress.totalTokens} | output ${progress.outputTokens} | band ${progress.spendBand} | elapsed ${Math.floor(progress.elapsedMs / 60_000)}m | remaining ${Math.ceil(progress.remainingMs / 60_000)}m` }],
							details: {
								phase: "running",
								turns: progress.turns,
								totalTokens: progress.totalTokens,
								outputTokens: progress.outputTokens,
								spendBand: progress.spendBand,
								provider: progress.provider,
								model: progress.model,
								elapsed_ms: progress.elapsedMs,
								remaining_ms: progress.remainingMs,
							},
						});
					},
				});
				let durableExecutionState = execution.durable_state;
				if (durableExecutionState?.status === "PREPARED" && startLockLease !== undefined) {
					const closed = await abortPristinePreparedDelegationUnderStartLockV2({
						project_root: projectRoot,
						transaction: durableExecutionState,
						start_lock_lease: startLockLease,
						now: controller.services.now().toISOString(),
					});
					if (closed.status === "recovered") durableExecutionState = closed.transaction;
				}
				// PREPARED remains ambiguous only when exact-lock, absent-owner,
				// pristine-journal/inventory proof could not close it. Preserve the lock
				// in that fail-closed case; a recovered ABORTED record releases it below.
				preserveStartLock = durableExecutionState?.status === "PREPARED";

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
					if (durableExecutionState?.status === "FAILED" && durableExecutionState.repair_lineage === undefined &&
						execution.after !== undefined && execution.after.changedSinceBefore.length === 0) {
						const reviewed = await controller.projectTerminalReviewedBinding(projectRoot, delegationId, controller.services.now().toISOString());
						if (reviewed === null) {
							throw new Error("workbench_delegate_worker: delegation v2 failed terminal session mirror could not enter REVIEWED");
						}
						try {
							controller.persistDelegationStateStrict(reviewed);
						} catch {
							controller.markTerminalMirrorBlocked();
							await refreshFailureStatus();
							throw new Error("workbench_delegate_worker: delegation v2 failed terminal session mirror persistence failed");
						}
					}
					const status = durableExecutionState?.status ?? "UNAVAILABLE";
					const reasons = durableExecutionState?.postcondition_reasons.join(",") || "none";
					const artifactError = execution.artifact_error_code === undefined
						? ""
						: `; artifact_error=${execution.artifact_error_code}`;
					const preparedStep = execution.code === "prepared_callback_failed" && preparedCallbackStep !== undefined
						? `; prepared_step=${preparedCallbackStep}`
						: "";
					const workerFailure = execution.worker_failure_code === undefined
						? ""
						: `; worker_failure=${execution.worker_failure_code}`;
					const workerFacts = execution.result === undefined
						? ""
						: `; assistant_turns=${execution.result.turns}; spend_profile=${execution.result.spend.profile}; spend_total_tokens=${execution.result.spend.totalTokens}; spend_output_tokens=${execution.result.spend.outputTokens}; exit_code=${execution.result.exitCode ?? "none"}`;
					// Reconstruct the immutable report locator only from strict durable
					// authority. Never echo a worker-authored report path or report prose.
					const committedProof = durableExecutionState?.committed_proof;
					const workerReportPath = committedProof?.delegation_id === delegationId
						? delegationGenerationRecordRelativePathV2(delegationId, committedProof.generation, "worker-report.md")
						: undefined;
					const workerReport = workerReportPath === undefined ? "" : `; worker_report=${workerReportPath}`;
					const terminalOutcome = durableExecutionState?.terminal_outcome;
					const changedPathCount = terminalOutcome?.delegation_id === delegationId
						? terminalOutcome.changed_paths.length
						: undefined;
					const changedPaths = changedPathCount === undefined ? "" : `; changed_paths=${changedPathCount}`;
					const nextAction = status === "FAILED"
						? `; next_action=call workbench_delegation_status, then call workbench_delegate_worker with repair_of=${delegationId}`
						: "; next_action=call workbench_delegation_status";
					const summary = `workbench_delegate_worker: delegation v2 ${execution.code}${artifactError}${preparedStep}; delegation_id=${delegationId}; durable_status=${status}; postconditions=${reasons}${workerFailure}${workerReport}${changedPaths}${workerFacts}${nextAction}`;
					const boundedSummary = Buffer.byteLength(summary, "utf8") <= DELEGATION_FAILURE_SUMMARY_MAX_BYTES
						? summary
						: `workbench_delegate_worker: delegation v2 ${execution.code}${preparedStep}; delegation_id=${delegationId}; durable_status=${status}; postconditions=summary_over_bound${workerReport}${changedPaths}${nextAction}`;
					throw new Error(boundedSummary);
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
				let scopeIntegrityPacket: HandoffScopeIntegrityPacket | undefined;
				if (taskKind.taskKind === "diagnosis") {
					const reviewed = await controller.projectTerminalReviewedBinding(projectRoot, delegationId, controller.services.now().toISOString());
					if (reviewed === null) throw new Error("workbench_delegate_worker: diagnosis session mirror could not enter REVIEWED");
					try {
						controller.persistDelegationStateStrict(reviewed);
					} catch {
						controller.markTerminalMirrorBlocked();
						await refreshFailureStatus();
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
						if (delivery.code === "session_persistence_failed") {
							controller.markTerminalMirrorBlocked();
							await refreshFailureStatus();
						}
						const reviewError = delivery.review_error === undefined ? "" : `; review_error=${delivery.review_error}`;
						throw new Error(`workbench_delegate_worker: default delivery ${delivery.code}${reviewError}; explicit review required`);
					}
					const reviewRecord = delivery.review.review.record;
					if (reviewRecord === undefined) throw new Error("workbench_delegate_worker: scope/integrity packet record unavailable");
					scopeIntegrityPacket = {
						lines: [...delivery.review.review.lines],
						review_kind: delivery.review_kind,
						scope_integrity_verdict: delivery.scope_integrity_verdict,
						bound_diff_hash: reviewRecord.bound_diff_hash,
						review_record: delivery.review.review_path,
						presentation_complete: delivery.presentation_complete,
						patch_truncated: reviewRecord.patch_truncated,
						semantic_review: delivery.semantic_review,
						semantic_risk: delivery.semantic_risk,
					};
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
					...(scopeIntegrityPacket === undefined ? {} : { scopeIntegrityPacket }),
				});
				void controller.refreshStatus(ctx);
				trustedIngress = controller.bindTrustedIngressAuthority(authority, toolResult.content);
				return toolResult;
			} finally {
				controller.rememberTrustedIngressAuthority(toolCallId, "workbench_delegate_worker", trustedIngress);
				if (!preserveStartLock) await releaseStartLock();
			}
		},
	});
}
