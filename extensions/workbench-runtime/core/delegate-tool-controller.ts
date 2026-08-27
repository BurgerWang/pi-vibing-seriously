/** Public worker-delegation tool controller. */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { canonicalHash } from "../cache/canonical-hash.ts";
import {
	repairDelegationToolActionV1,
	reviewDelegationToolActionV1,
} from "./agent-next-action.ts";
import type { ExecFn } from "./config.ts";
import { boundedCommandText, boundedInlineDetail } from "./command-output.ts";
import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import type { completeDefaultDelegationDeliveryV2 } from "./delegation-default-delivery.ts";
import type { executeDelegationV2 } from "./delegation-execution-v2.ts";
import {
	abortPristinePreparedDelegationUnderStartLockV2,
	isStrictRetryableAbortedRepairV2,
	isStrictRetryableEmptyRepairRecoveryV2,
	readStrictRetryableRawRepairEvidenceV1,
} from "./delegation-execution-owner.ts";
import type { makeDelegationId, readDelegationLedger } from "./delegation-ledger.ts";
import { isVerifyConfigMaintenanceDelegation, type WorkbenchMode } from "./mode-policy.ts";
import {
	observeDiffChange,
	recordDelegation,
	recordProjectAdmittedDelegation,
	recordRepairDelegation,
	recordSuccessorAfterFinalizedReview,
	reviewBlockReason,
	type DelegationState,
} from "./delegation-state.ts";
import {
	admitProjectDelegationPathLaneV1,
	isDelegationPathLaneBypassableProjectIssueV1,
	revalidateProjectDelegationPathLaneV1,
	type DelegationPathLaneAdmissionV1,
} from "./delegation-path-lane-admission.ts";
import { normalizeDelegationBoundedTaskContractV2 } from "./delegation-transaction-artifacts.ts";
import {
	acquireProjectDelegationStartLockV1,
	releaseProjectDelegationStartLockV1,
	type ProjectDelegationStartLockLeaseV1,
} from "./delegation-start-lock.ts";
import {
	acquireProjectCheckoutOperationV1,
	markProjectCheckoutOperationSettledV1,
	releaseProjectCheckoutOperationV1,
	type ProjectCheckoutOperationLeaseV1,
} from "./project-checkout-operation.ts";
import { readDelegationPlanContractAuthority } from "./delegation-plan-reference.ts";
import { planReferenceHash, verifyCurrentPlanReference } from "./plan-reference.ts";
import type { readRecoverableUnpublishedDelegationV2 } from "./delegation-project-authority.ts";
import {
	delegationGenerationRecordRelativePathV2,
	hasDelegationSemanticRepairAuthorityV2,
	hasDelegationSemanticReviewAuthorityV2,
	readDelegationTerminalNegativeSolAuthorityV1,
	readDelegationTransactionV2,
	readDelegationReviewV2,
	type DelegationCommittedGenerationV2,
	type DelegationSemanticRepairDecisionV1,
	type readDelegationCommittedGenerationV2,
} from "./delegation-transaction-storage.ts";
import {
	recoverExactRepairCommandAuthorityV1,
	type ExactRepairCommandAuthorityV1,
} from "./exact-repair-authority.ts";
import { recoverRawLineageExactRepairAuthorityV1 } from "./exact-repair-raw-lineage-authority.ts";
import { readDelegationInactiveBlockerClosureV2 } from "./delegation-authority-closure.ts";
import { readDelegationCleanRepairAbandonmentV1 } from "./delegation-repair-abandonment.ts";
import { collectTerminalRepairRebaseAuthorityV1 } from "./delegation-repair-rebase.ts";
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

interface DelegateSessionMirrorWarning {
	code: "session_mirror_append_failed";
	phase: "prepared_projection" | "execution_projection" | "failed_terminal_projection" | "diagnosis_projection" | "default_delivery_projection";
	message: string;
	durable_readback: "confirmed" | "unavailable" | "mismatch";
	durable_transaction_status?: string;
	durable_review_finalized?: boolean;
}

function attachDelegateSessionMirrorWarning(
	toolResult: ReturnType<typeof buildDelegateWorkerResult>,
	warnings: readonly DelegateSessionMirrorWarning[],
): void {
	if (warnings.length === 0) return;
	const warning = warnings[warnings.length - 1]!;
	toolResult.details.session_mirror_warning = warning;
	toolResult.details.session_mirror_warning_count = warnings.length;
	const reviewStatus = String(toolResult.details.review_status ?? "durable");
	const readback = warning.durable_readback === "confirmed" ? "read-back confirmed" : `read-back ${warning.durable_readback}`;
	const warningLine = `review        : ${reviewStatus} — durable authority; WARNING session mirror append failed (${readback}); reconciliation required`;
	toolResult.content = toolResult.content.map((item) => {
		const lines = item.text.split("\n");
		const reviewLine = lines.findIndex((line) => /^review\s*:/u.test(line));
		if (reviewLine >= 0) lines[reviewLine] = warningLine;
		return { ...item, text: lines.join("\n") };
	});
}

type PreparedCallbackStep =
	| "verification_recheck"
	| "plan_recheck"
	| "repair_authority_recheck"
	| "finalized_successor_recheck"
	| "reviewed_binding_recheck"
	| "session_transition"
	| "session_persist"
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
	bindingKind: "exact" | "terminal-rebase";
	repairLineage?: DelegationRepairLineageV1;
	/** Present only for an exact repair service bridge. Never model-derived. */
	exactCommandAuthority?: ExactRepairCommandAuthorityV1;
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

function pathLaneBlockSummary(admission: DelegationPathLaneAdmissionV1): string {
	const reasons = admission.decision.block_reasons.join(",") || "INVALID_AUTHORITY";
	const ids = [...new Set([
		...admission.decision.conflicts.map((conflict) => conflict.delegation_id),
		...admission.decision.authority_failures
			.map((failure) => failure.delegation_id)
			.filter((id): id is string => id !== null),
	])].sort(byteCompare);
	return `${reasons}${ids.length === 0 ? "" : `; blockers=${ids.join(",")}`}`;
}

/** Every unexcluded blocker must be a byte-bound known non-overlap warning. */
function pathLaneAllowsHistoricalBypass(
	admission: DelegationPathLaneAdmissionV1,
	verifiedRepairTipExclusionId?: string,
): boolean {
	if (admission.decision.decision !== "ALLOW" || admission.blockers.length === 0) return false;
	const exclusionId = admission.repair_tip_exclusion_id;
	if (exclusionId !== null && exclusionId !== verifiedRepairTipExclusionId) return false;
	const warnings = new Set(admission.decision.maintenance_warnings.map((warning) => warning.delegation_id));
	return admission.blockers.every((blocker) => blocker.kind === "known" &&
		(blocker.delegation_id === exclusionId || warnings.has(blocker.delegation_id)));
}

function pathLaneAllowsSessionBlockBypass(
	admission: DelegationPathLaneAdmissionV1,
	blockingDelegationId: string | undefined,
): boolean {
	if (blockingDelegationId === undefined || admission.repair_tip_exclusion_id !== null ||
		!pathLaneAllowsHistoricalBypass(admission)) return false;
	return admission.blockers.some((blocker) => blocker.kind === "known" && blocker.delegation_id === blockingDelegationId) &&
		admission.decision.maintenance_warnings.some((warning) => warning.delegation_id === blockingDelegationId);
}

/**
 * A single-value session mirror is not project authority.  Its live binding
 * may be unavailable (for example, a historical ignored path), yet a fresh
 * ordinary lane or a different exact repair tip can still proceed when the
 * full immutable-authority scan proves that mirrored blocker known and
 * non-overlapping.  The selected exact tip itself is never skipped here.
 */
function pathLaneAllowsSessionBindingBypass(
	admission: DelegationPathLaneAdmissionV1,
	blockingDelegationId: string | undefined,
	verifiedRepairTipExclusionId?: string,
): boolean {
	if (blockingDelegationId === undefined || blockingDelegationId === admission.repair_tip_exclusion_id ||
		!pathLaneAllowsHistoricalBypass(admission, verifiedRepairTipExclusionId)) return false;
	return admission.blockers.some((blocker) => blocker.kind === "known" && blocker.delegation_id === blockingDelegationId) &&
		admission.decision.maintenance_warnings.some((warning) => warning.delegation_id === blockingDelegationId);
}

function pathLaneMayResolveProjectIssue(code: string | undefined): boolean {
	return isDelegationPathLaneBypassableProjectIssueV1(code);
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
	/** Distinguishes an unbypassable authority fault from a historical mirror block. */
	getProjectAuthorityIssueCode?(): string | undefined;
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
	/** Lease acquired by the ordered tool_call barrier before receipt creation. */
	checkoutOperationForToolCall?(toolCallId: string, projectRoot: string): ProjectCheckoutOperationLeaseV1 | undefined;
	/**
	 * Safe compatibility router for historical model calls that supplied
	 * repair_of on this broad tool. It consumes only the id and recovers the
	 * complete executable contract from immutable authority.
	 */
	executeModelRepairAlias?: DelegateWorkerExecuteV1;
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
	/** Optional injection seam; production falls back to the strict terminal-negative reader. */
	readTerminalNegativeRepair?: typeof readDelegationTerminalNegativeSolAuthorityV1;
	/** Optional bounded seam for direct bridge tests; production uses the strict plan reader. */
	readPlanContractAuthority?: typeof readDelegationPlanContractAuthority;
	/** Optional deterministic seam for controller tests; production uses strict storage admission. */
	admitPathLane?: typeof admitProjectDelegationPathLaneV1;
	/** Optional deterministic seam for controller tests; production uses strict storage revalidation. */
	revalidatePathLane?: typeof revalidateProjectDelegationPathLaneV1;
	readRecoverableUnpublished: typeof readRecoverableUnpublishedDelegationV2;
	readLegacyLedger: typeof readDelegationLedger;
	executeDelegation: typeof executeDelegationV2;
	completeDefaultDelivery: typeof completeDefaultDelegationDeliveryV2;
	buildTrustedRecoveryAuthority: typeof buildTrustedRecoveryAuthority;
}

export type DelegateWorkerExecuteV1 = ToolDefinition<
	typeof WORKBENCH_TOOL_PARAMETERS.workbench_delegate_worker
>["execute"];

export type DelegateExactRepairExecuteV1 = (
	authority: ExactRepairCommandAuthorityV1,
	signal: Parameters<DelegateWorkerExecuteV1>[2],
	onUpdate: Parameters<DelegateWorkerExecuteV1>[3],
	ctx: Parameters<DelegateWorkerExecuteV1>[4],
) => ReturnType<DelegateWorkerExecuteV1>;

/** The user command and model-callable tool share this exact execution function. */
export interface DelegateToolExecutionHandleV1 {
	readonly execute: DelegateWorkerExecuteV1;
	readonly executeExactRepair: DelegateExactRepairExecuteV1;
}

/**
 * Register delegate_worker at its fixed catalog position.
 *
 * The historically named project start lock is the shared checkout's
 * lifecycle-wide single-writer lease. It is intentionally retained through
 * worker execution and mechanical delivery, not released at PREPARED.
 */
export function registerDelegateTool<TIngress>(controller: DelegateToolController<TIngress>): DelegateToolExecutionHandleV1 {
	const executeKernel = async (
		toolCallId: Parameters<DelegateWorkerExecuteV1>[0],
		params: Parameters<DelegateWorkerExecuteV1>[1],
		signal: Parameters<DelegateWorkerExecuteV1>[2],
		onUpdate: Parameters<DelegateWorkerExecuteV1>[3],
		ctx: Parameters<DelegateWorkerExecuteV1>[4],
		exactRepairAuthority?: ExactRepairCommandAuthorityV1,
	): ReturnType<DelegateWorkerExecuteV1> => {
			let trustedIngress: TIngress | undefined;
			const sessionMirrorWarnings: DelegateSessionMirrorWarning[] = [];
			let checkoutOperationLease: ProjectCheckoutOperationLeaseV1 | undefined;
			let ownsCheckoutOperationLease = false;
			let startLockLease: ProjectDelegationStartLockLeaseV1 | undefined;
			let preserveStartLock = false;
			const releaseStartLock = async (): Promise<void> => {
				if (checkoutOperationLease === undefined) return;
				if (!ownsCheckoutOperationLease) {
					checkoutOperationLease = undefined;
					startLockLease = undefined;
					return;
				}
				if (!markProjectCheckoutOperationSettledV1(checkoutOperationLease, "generic_release")) {
					throw new Error("workbench_delegate_worker: project start lock settlement conflict");
				}
				const released = await releaseProjectCheckoutOperationV1(checkoutOperationLease, {
					release_start_lock: controller.services.releaseStartLock,
				});
				if (!released.ok) throw new Error(`workbench_delegate_worker: project start lock release ${released.error.code}`);
				checkoutOperationLease = undefined;
				ownsCheckoutOperationLease = false;
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
				if (exactRepairAuthority !== undefined &&
					(toolCallId !== exactRepairAuthority.tool_call_id ||
						exactRepairAuthority.repair_of !== contract.value.repair_of ||
						canonicalHash(params) !== canonicalHash(exactRepairAuthority.arguments))) {
					throw new Error("workbench_delegate_worker: in-process exact repair authority binding is invalid");
				}
				if (contract.value.repair_of !== undefined && exactRepairAuthority === undefined) {
					throw new Error(`workbench_delegate_worker: unbound repair_of ${contract.value.repair_of} reached the delegation kernel`);
				}
				const projectRoot = await controller.projectRootFor(ctx);
				const guardedCheckoutOperation = controller.checkoutOperationForToolCall?.(toolCallId, projectRoot);
				if (guardedCheckoutOperation !== undefined) {
					if (guardedCheckoutOperation.operation_kind !== "delegation"
						|| guardedCheckoutOperation.project_root !== projectRoot) {
						throw new Error("workbench_delegate_worker: ordered checkout operation binding is invalid");
					}
					checkoutOperationLease = guardedCheckoutOperation;
					startLockLease = guardedCheckoutOperation.start_lock_lease;
				}
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
				// Recovery-only unlocked prepass: a dead prior lock is still required
				// to prove and close its exact PREPARED-before-execution-owner crash
				// window. No result from this pass is accepted as start authority. The
				// admission decision is recomputed below while holding the new
				// lifecycle-wide checkout writer lease.
				await controller.reconcileProjectAuthority(projectRoot, controller.services.now().toISOString());
				const preflightProjectIssueCode = controller.getProjectAuthorityIssueCode?.();
				if (preflightProjectIssueCode !== undefined && !pathLaneMayResolveProjectIssue(preflightProjectIssueCode)) {
					const projectBlock = controller.getProjectAuthorityBlockReason("delegation");
					throw new Error(`workbench_delegate_worker: ${projectBlock ?? `project authority is ${preflightProjectIssueCode}; delegation fails closed`}`);
				}
				const laneAdmissionInput = {
					project_root: projectRoot,
					allowed_paths: contract.value.allowed_paths,
					...(exactRepairAuthority === undefined ? {} : {
						repair_tip_exclusion_id: exactRepairAuthority.repair_of,
					}),
				};
				const admitPathLane = controller.services.admitPathLane ?? admitProjectDelegationPathLaneV1;
				const revalidatePathLane = controller.services.revalidatePathLane ?? revalidateProjectDelegationPathLaneV1;
				const pathLaneAdmission = await admitPathLane(laneAdmissionInput);
				if (pathLaneAdmission.decision.decision !== "ALLOW") {
					throw new Error(`workbench_delegate_worker: path lane admission blocked: ${pathLaneBlockSummary(pathLaneAdmission)}`);
				}
				if (preflightProjectIssueCode !== undefined &&
					!pathLaneAllowsHistoricalBypass(pathLaneAdmission, exactRepairAuthority?.repair_of)) {
					const projectBlock = controller.getProjectAuthorityBlockReason("delegation");
					throw new Error(`workbench_delegate_worker: ${projectBlock ?? `project authority is ${preflightProjectIssueCode}; delegation fails closed`}`);
				}
				const startedAt = guardedCheckoutOperation?.start_lock_lease.acquired_at
					?? controller.services.now().toISOString();
				const delegationId = guardedCheckoutOperation?.delegation_id
					?? controller.services.makeDelegationId(new Date(startedAt));
				const readTransaction = controller.services.readTransaction ?? readDelegationTransactionV2;
				const readReview = controller.services.readReview ?? readDelegationReviewV2;
				const readTerminalNegativeRepair = controller.services.readTerminalNegativeRepair
					?? readDelegationTerminalNegativeSolAuthorityV1;
				const readPlanContractAuthority = controller.services.readPlanContractAuthority
					?? readDelegationPlanContractAuthority;
				const recordSessionMirrorWarning = async (
					phase: DelegateSessionMirrorWarning["phase"],
					expectedDurableStatus?: string,
				): Promise<void> => {
					let warning: DelegateSessionMirrorWarning = {
						code: "session_mirror_append_failed",
						phase,
						message: "durable delegation state succeeded; session mirror append failed and will be reconciled from durable authority",
						durable_readback: "unavailable",
					};
					try {
						const readback = await readTransaction(projectRoot, delegationId);
						if (readback.ok) {
							const status = readback.value.status;
							warning = {
								...warning,
								durable_readback: expectedDurableStatus === undefined || status === expectedDurableStatus
									? "confirmed"
									: "mismatch",
								durable_transaction_status: status,
							};
						}
					} catch {
						// The execution result already carries strict durable state. Keep
						// the read-back failure explicit without reclassifying it as a
						// worker/delegation failure.
					}
					sessionMirrorWarnings.push(warning);
				};
				const acquired = guardedCheckoutOperation === undefined
					? await acquireProjectCheckoutOperationV1({
					project_root: projectRoot,
					operation_kind: "delegation",
					operation_id: `delegation:${delegationId}`,
					delegation_id: delegationId,
					now: startedAt,
				}, {
					acquire_start_lock: controller.services.acquireStartLock,
					release_start_lock: controller.services.releaseStartLock,
				})
					: { ok: true as const, value: guardedCheckoutOperation };
				if (!acquired.ok) throw new Error(`workbench_delegate_worker: project start lock ${acquired.error.code}`);
				checkoutOperationLease = acquired.value;
				ownsCheckoutOperationLease = guardedCheckoutOperation === undefined;
				startLockLease = acquired.value.start_lock_lease;
				// This is the first locked project-authority boundary. From here through worker
				// execution, generation publication, and mechanical delivery, no other
				// Pi process may write this shared checkout, even on disjoint paths.
				await controller.reconcileProjectAuthority(projectRoot, controller.services.now().toISOString());
				const projectBlock = controller.getProjectAuthorityBlockReason("delegation");
				const projectIssueCode = controller.getProjectAuthorityIssueCode?.();
				if ((projectIssueCode !== undefined && !pathLaneMayResolveProjectIssue(projectIssueCode)) ||
					(projectBlock !== undefined && controller.getProjectAuthorityIssueCode === undefined)) {
					throw new Error(`workbench_delegate_worker: ${projectBlock ?? `project authority is ${projectIssueCode}; delegation fails closed`}`);
				}

				const lineageWritePaths = exactDelegationRepairAllowedPathsV1(contract.value.allowed_paths);
				const requireLineageWritePaths = (): string[] => {
					if (lineageWritePaths === undefined) {
						throw new Error("workbench_delegate_worker: unresolved semantic repair requires only exact-file allowed_paths; subtree or glob rules are forbidden");
					}
					return lineageWritePaths;
				};
				const hasStrictLineageRoot = async (state: DelegationTransactionRecord): Promise<boolean> => {
					if (state.repair_lineage === undefined) return true;
					const rootId = state.repair_lineage.root_delegation_id;
					const rootState = await readTransaction(projectRoot, rootId);
					if (!rootState.ok) return false;
					if (rootState.value.repair_lineage === undefined
						&& (rootState.value.status === "FAILED" || rootState.value.status === "INTERRUPTED")) {
						const terminal = await readTerminalNegativeRepair(projectRoot, rootId);
						return terminal.ok && terminal.value.decision.decision_hash === state.repair_lineage.root_decision_hash;
					}
					const root = await readReview(projectRoot, rootId);
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
					let rootDecision: DelegationSemanticRepairDecisionV1 | undefined;
					if (root.ok && hasDelegationSemanticRepairAuthorityV2(root.value)) {
						rootDecision = root.value.semantic_repair!;
					} else {
						const rootState = rootId === state.delegation_id
							? { ok: true as const, value: state }
							: await readTransaction(projectRoot, rootId);
						if (!rootState.ok) {
							throw new Error(`workbench_delegate_worker: repair_of ${state.delegation_id} root closure is ${rootState.error.code}`);
						}
						if (rootState.value.repair_lineage === undefined &&
							(rootState.value.status === "FAILED" || rootState.value.status === "INTERRUPTED")) {
							const terminalRoot = await readTerminalNegativeRepair(projectRoot, rootId);
							if (terminalRoot.ok) rootDecision = terminalRoot.value.decision;
							else if (terminalRoot.error.code !== "not_found") {
								throw new Error(`workbench_delegate_worker: repair_of ${state.delegation_id} terminal-negative root closure is ${terminalRoot.error.code}`);
							}
						}
					}
					if (rootDecision === undefined) return false;
					const closed = await readDelegationCleanRepairAbandonmentV1(
						projectRoot,
						state,
						rootDecision,
					);
					if (!closed.ok) throw new Error(`workbench_delegate_worker: repair_of ${state.delegation_id} clean-repair closure is ${closed.error.code}`);
					return closed.value !== undefined;
				};
				const collectExactCommandRepairAuthority = async (
					expected: ExactRepairCommandAuthorityV1,
				): Promise<V2RepairAuthority | undefined> => {
					const repairId = expected.repair_of;
					if (expected.authority_kind === "raw-lineage-retry") {
						const recovered = await recoverRawLineageExactRepairAuthorityV1({
							project_root: projectRoot,
							repair_of: repairId,
							collectCurrentBinding: (root, id) => controller.collectCurrentDelegationBinding(root, id),
						});
						if (!recovered.ok || canonicalHash(recovered.value) !== canonicalHash(expected)) return undefined;
						const parent = await readTransaction(projectRoot, repairId);
						if (!parent.ok || canonicalHash(parent.value) !== expected.raw_tip_transaction_hash) return undefined;
						return {
							id: repairId,
							kind: "raw-lineage",
							status: parent.value.status,
							contractHash: parent.value.contract_hash,
							generationContentHash: null,
							semanticDecisionHash: expected.continuation_decision_hash,
							expectedBindingHash: expected.expected_current_binding_hash,
							bindingKind: "exact",
							repairLineage: expected.successor_lineage,
							exactCommandAuthority: expected,
						};
					}
					const prior = await controller.services.readCommittedGeneration(projectRoot, repairId);
					if (!prior.ok || await repairWasDurablyClosed(prior.value.state)) return undefined;
					const parent = prior.value.state;
					let expectedBindingHash: string | undefined;
					let bindingKind: V2RepairAuthority["bindingKind"] = "exact";
					let recovered: ReturnType<typeof recoverExactRepairCommandAuthorityV1>;
					if (expected.authority_kind === "semantic-repair") {
						const review = await readReview(projectRoot, repairId);
						if (!review.ok || !hasDelegationSemanticRepairAuthorityV2(review.value)) return undefined;
						expectedBindingHash = review.value.semantic_repair!.expected_bound_diff_hash;
						const binding = await controller.collectCurrentDelegationBinding(projectRoot, repairId);
						if (binding.status !== "fresh" || binding.hash !== expectedBindingHash) return undefined;
						recovered = recoverExactRepairCommandAuthorityV1({
							repairOf: repairId,
							committed: prior.value,
							review: review.value,
						});
					} else if (expected.authority_kind === "terminal-negative-repair") {
						const negative = await readTerminalNegativeRepair(projectRoot, repairId);
						if (!negative.ok) return undefined;
						const binding = await controller.collectCurrentDelegationBinding(projectRoot, repairId);
						if (binding.status !== "fresh" || binding.hash !== expected.expected_bound_diff_hash) return undefined;
						expectedBindingHash = binding.hash;
						recovered = recoverExactRepairCommandAuthorityV1({
							repairOf: repairId,
							committed: prior.value,
							terminalNegativeRepair: negative.value,
							currentBindingHash: binding.hash,
						});
					} else {
						recovered = recoverExactRepairCommandAuthorityV1({ repairOf: repairId, committed: prior.value });
						const binding = await controller.collectCurrentDelegationBinding(projectRoot, repairId);
						if (binding.status === "fresh") {
							expectedBindingHash = binding.hash;
						} else {
							const rebased = await collectTerminalRepairRebaseAuthorityV1({
								projectRoot,
								committed: prior.value,
								exec: controller.exec,
							});
							if (!rebased.ok) return undefined;
							bindingKind = "terminal-rebase";
							expectedBindingHash = rebased.value.rebase_hash;
						}
					}
					if (!recovered.ok || expectedBindingHash === undefined ||
						canonicalHash(recovered.value) !== canonicalHash(expected)) return undefined;
					return {
						id: repairId,
						kind: "committed",
						status: parent.status,
						contractHash: parent.contract_hash,
						generationContentHash: prior.value.proof.content_hash,
						semanticDecisionHash: "semantic_decision_hash" in expected
							? expected.semantic_decision_hash
							: null,
						expectedBindingHash,
						bindingKind,
						repairLineage: expected.successor_lineage,
						exactCommandAuthority: expected,
					};
				};
				let v2RepairAuthority: V2RepairAuthority | undefined;
				if (exactRepairAuthority !== undefined) {
					v2RepairAuthority = await collectExactCommandRepairAuthority(exactRepairAuthority);
					if (v2RepairAuthority === undefined) {
						throw new Error("workbench_delegate_worker: exact repair authority or current binding changed");
					}
				} else if (contract.value.repair_of !== undefined) {
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
						let bindingKind: V2RepairAuthority["bindingKind"] = "exact";
						let expectedBindingHash: string | undefined = binding.status === "fresh" ? binding.hash : undefined;
						if (expectedSemanticBinding !== undefined) {
							if (binding.status !== "fresh" || binding.hash !== expectedSemanticBinding) {
								throw new Error(`workbench_delegate_worker: repair_of ${repairId} current binding is not the exact repair authority`);
							}
						} else if (binding.status !== "fresh" && repairLineage !== undefined &&
							(parent.status === "FAILED" || parent.status === "RECOVERY_REQUIRED")) {
							const rebased = await collectTerminalRepairRebaseAuthorityV1({
								projectRoot,
								committed: priorV2.value,
								exec: controller.exec,
							});
							if (!rebased.ok) {
								const path = rebased.path === undefined ? "" : `; path=${rebased.path}`;
								throw new Error(`workbench_delegate_worker: repair_of ${repairId} terminal rebase is ${rebased.code}${path}`);
							}
							bindingKind = "terminal-rebase";
							expectedBindingHash = rebased.value.rebase_hash;
						} else if (binding.status !== "fresh") {
							throw new Error(`workbench_delegate_worker: repair_of ${repairId} current binding is not the exact repair authority`);
						}
						if (expectedBindingHash === undefined) {
							throw new Error(`workbench_delegate_worker: repair_of ${repairId} current binding is unavailable`);
						}
						v2RepairAuthority = {
							id: repairId,
							kind: "committed",
							status: parent.status,
							contractHash: parent.contract_hash,
							generationContentHash: priorV2.value.proof.content_hash,
							semanticDecisionHash,
							expectedBindingHash,
							bindingKind,
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
								bindingKind: "exact",
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
								bindingKind: "exact",
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
				const revalidateV2RepairAuthority = async (
					preparedSuccessor?: DelegationTransactionRecord,
				): Promise<boolean> => {
					const authority = v2RepairAuthority;
					if (authority === undefined) return true;
					try {
						if (authority.exactCommandAuthority !== undefined) {
							const exact = authority.exactCommandAuthority;
							if (exact.authority_kind === "raw-lineage-retry" && preparedSuccessor !== undefined) {
								const expectedContract = normalizeDelegationBoundedTaskContractV2(exact.arguments);
								if (!expectedContract.ok || preparedSuccessor.status !== "PREPARED" ||
									preparedSuccessor.contract_hash !== expectedContract.value.contract_hash ||
									canonicalHash(preparedSuccessor.repair_lineage) !== canonicalHash(exact.successor_lineage)) return false;
								const raw = await readTransaction(projectRoot, exact.repair_of);
								if (!raw.ok || canonicalHash(raw.value) !== exact.raw_tip_transaction_hash) return false;
								const evidence = await readStrictRetryableRawRepairEvidenceV1(projectRoot, raw.value);
								if (!evidence.ok || evidence.value.evidence_hash !== exact.raw_tip_evidence_hash) return false;
								const root = await controller.services.readCommittedGeneration(projectRoot, exact.root_delegation_id);
								if (!root.ok || root.value.proof.content_hash !== exact.committed_proof_content_hash ||
									canonicalHash(root.value.state) !== exact.root_transaction_hash) return false;
								const rootDecision = exact.root_authority_kind === "semantic-repair"
									? await readReview(projectRoot, exact.root_delegation_id)
									: await readTerminalNegativeRepair(projectRoot, exact.root_delegation_id);
								const rootDecisionHash = exact.root_authority_kind === "semantic-repair"
									? rootDecision.ok && "semantic_repair" in rootDecision.value &&
										hasDelegationSemanticRepairAuthorityV2(rootDecision.value) ? rootDecision.value.semantic_repair!.decision_hash : undefined
									: rootDecision.ok && "decision" in rootDecision.value ? rootDecision.value.decision.decision_hash : undefined;
								if (rootDecisionHash !== exact.root_decision_hash) return false;
								const continuation = await controller.services.readCommittedGeneration(
									projectRoot,
									exact.continuation_decision_delegation_id,
								);
								if (!continuation.ok || continuation.value.proof.content_hash !== exact.continuation_decision_proof_content_hash) return false;
								let continuationDecisionHash: string | undefined;
								if (continuation.value.state.status === "PENDING_REVIEW") {
									const review = await readReview(projectRoot, continuation.value.state.delegation_id);
									if (review.ok && hasDelegationSemanticRepairAuthorityV2(review.value)) {
										continuationDecisionHash = review.value.semantic_repair!.decision_hash;
									}
								} else {
									const negative = await readTerminalNegativeRepair(projectRoot, continuation.value.state.delegation_id);
									if (negative.ok) continuationDecisionHash = negative.value.decision.decision_hash;
								}
								if (continuationDecisionHash !== exact.continuation_decision_hash) return false;
								const binding = await controller.collectCurrentDelegationBinding(
									projectRoot,
									exact.continuation_decision_delegation_id,
								);
								return binding.status === "fresh" && binding.hash === exact.expected_current_binding_hash;
							}
							const current = await collectExactCommandRepairAuthority(authority.exactCommandAuthority);
							return current !== undefined && current.expectedBindingHash === authority.expectedBindingHash &&
								current.bindingKind === authority.bindingKind &&
								current.repairLineage?.lineage_hash === authority.repairLineage?.lineage_hash &&
								canonicalHash(current.exactCommandAuthority) === canonicalHash(authority.exactCommandAuthority);
						}
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
					if (authority.bindingKind === "terminal-rebase") {
						if (authority.kind !== "committed") return false;
						const current = await controller.services.readCommittedGeneration(projectRoot, authority.id);
						if (!current.ok) return false;
						const rebased = await collectTerminalRepairRebaseAuthorityV1({
							projectRoot,
							committed: current.value,
							exec: controller.exec,
						});
						return rebased.ok && rebased.value.rebase_hash === authority.expectedBindingHash;
					}
					const binding = await controller.collectCurrentDelegationBinding(projectRoot, authority.id);
					return binding.status === "fresh" && binding.hash === authority.expectedBindingHash;
					} catch {
						return false;
					}
				};

				if (!await revalidateV2RepairAuthority()) {
					throw new Error("workbench_delegate_worker: repair authority or current binding changed before transaction preparation");
				}
				const verifiedRepairTipExclusionId = v2RepairAuthority?.exactCommandAuthority?.repair_of;
				let currentState = controller.getDelegationState();
				if (currentState.latestId !== undefined &&
					!pathLaneAllowsSessionBindingBypass(pathLaneAdmission, currentState.latestId, verifiedRepairTipExclusionId)) {
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
				if (projectBlock !== undefined && !pathLaneAllowsHistoricalBypass(pathLaneAdmission, verifiedRepairTipExclusionId)) {
					throw new Error(`workbench_delegate_worker: ${projectBlock}`);
				}
				const reviewBlock = reviewBlockReason(currentState, "delegation");
				const strictExactTipRepair = v2RepairAuthority?.exactCommandAuthority !== undefined &&
					pathLaneAdmission.repair_tip_exclusion_id === v2RepairAuthority.id &&
					pathLaneAdmission.repair_tip_ids.includes(v2RepairAuthority.id);
				const exactBlockingRepair = reviewBlock !== undefined && v2RepairAuthority !== undefined &&
					(currentState.latestId === v2RepairAuthority.id || strictExactTipRepair);
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
				const laneBypassedBlockingId = reviewBlock !== undefined && !exactBlockingRepair && finalizedStaleSuccessorId === undefined &&
					pathLaneAllowsSessionBlockBypass(pathLaneAdmission, currentState.latestId)
					? currentState.latestId
					: undefined;
				if (reviewBlock && !exactBlockingRepair && finalizedStaleSuccessorId === undefined && laneBypassedBlockingId === undefined) {
					throw new Error(`workbench_delegate_worker: ${reviewBlock}`);
				}
				const reviewedPrelaunch = v2RepairAuthority === undefined && reviewBlock === undefined && currentState.latestId !== undefined &&
					currentState.status === "REVIEWED" && currentState.reviewedDiffHash !== undefined
					? { id: currentState.latestId, hash: currentState.reviewedDiffHash }
					: undefined;
				if (v2RepairAuthority !== undefined &&
					(v2RepairAuthority.kind !== "committed" || v2RepairAuthority.repairLineage !== undefined ||
						v2RepairAuthority.status === "PENDING_REVIEW") && !exactBlockingRepair && !strictExactTipRepair) {
					throw new Error(`workbench_delegate_worker: repair_of ${v2RepairAuthority.id} is not the latest blocking delegation`);
				}
				// Continuity is anchored only in a strict committed generation. An
				// exact recoverable unpublished repair has no such generation yet and
				// follows its existing dedicated authority path above. Every ordinary
				// successor must preserve (or explicitly replace) a proven latest plan.
				const lineagePlanRoot = v2RepairAuthority?.repairLineage?.root_delegation_id;
				if (lineagePlanRoot !== undefined || !(v2RepairAuthority !== undefined && v2RepairAuthority.kind !== "committed" && exactBlockingRepair)) {
					const priorPlan = await readPlanContractAuthority(
						projectRoot,
						lineagePlanRoot ?? (laneBypassedBlockingId === undefined ? currentState.latestId : undefined),
					);
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

				// The lifecycle writer lease is held, and this strict second scan is
				// deliberately the final awaited authority check before the callee can
				// publish PREPARED. The full unexcluded authority and any exact tip
				// exclusion are both bound by the expected hash.
				const laneRevalidation = await revalidatePathLane({
					...laneAdmissionInput,
					expected_authority_hash: pathLaneAdmission.authority_hash,
				});
				if (!laneRevalidation.unchanged || laneRevalidation.admission.decision.decision !== "ALLOW") {
					const changed = laneRevalidation.unchanged ? "" : "authority changed; ";
					throw new Error(`workbench_delegate_worker: path lane revalidation blocked before PREPARED: ${changed}${pathLaneBlockSummary(laneRevalidation.admission)}`);
				}
				if (laneRevalidation.admission.repair_tip_exclusion_id !== null &&
					laneRevalidation.admission.repair_tip_exclusion_id !== verifiedRepairTipExclusionId) {
					throw new Error("workbench_delegate_worker: path lane repair-tip exclusion lacks exact in-process repair authority");
				}

				let preparedCallbackStep: PreparedCallbackStep | undefined;
				let execution: Awaited<ReturnType<DelegateToolServices["executeDelegation"]>>;
				try {
					execution = await controller.services.executeDelegation({
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
					checkoutOperationToken: checkoutOperationLease.token,
					onPrepared: async (_transaction, preparedBefore) => {
						// executeDelegation invokes this callback only after strict durable
						// PREPARED publication. From this point an outer throw is ambiguous
						// until exact durable readback proves a terminal replacement.
						preserveStartLock = true;
						preparedCallbackStep = "verification_recheck";
						await verifyRecipesBeforeLaunch();
						if (contract.value.plan_ref !== undefined) {
							preparedCallbackStep = "plan_recheck";
							const currentPlan = await verifyCurrentPlanReference(projectRoot, contract.value.plan_ref);
							if (!currentPlan.ok) throw new Error(`plan_ref ${currentPlan.error.code} before worker launch`);
						}
						if (v2RepairAuthority !== undefined) {
							preparedCallbackStep = "repair_authority_recheck";
							if (!await revalidateV2RepairAuthority(_transaction)) {
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
						try {
							preparedCallbackStep = "session_transition";
							const recorded = exactBlockingRepair && controller.getDelegationState().latestId === v2RepairAuthority!.id
								? recordRepairDelegation(controller.getDelegationState(), recordInput, v2RepairAuthority!.id)
								: strictExactTipRepair
									? recordProjectAdmittedDelegation(controller.getDelegationState(), recordInput)
								: laneBypassedBlockingId !== undefined
									? recordProjectAdmittedDelegation(controller.getDelegationState(), recordInput)
								: finalizedStaleSuccessorId !== undefined
									? recordSuccessorAfterFinalizedReview(controller.getDelegationState(), recordInput, finalizedStaleSuccessorId)
									: recordDelegation(controller.getDelegationState(), recordInput);
							if (!recorded.ok) throw new Error("delegation session mirror refused PREPARED");
							controller.setDelegationState(recorded.state);
							preparedCallbackStep = "session_persist";
							controller.persistDelegationStateStrict(recorded.state);
						} catch {
							// PREPARED is already durable project authority. A session append is
							// presentation only and must not turn success into ABORTED/retry.
							await recordSessionMirrorWarning("prepared_projection", "PREPARED");
						}
						void controller.refreshStatus(ctx).catch(() => undefined);
						preparedCallbackStep = "progress_publish";
						try { onUpdate?.({
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
						}); } catch {
							// Progress publication is a non-authoritative session/UI mirror.
						}
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
				} catch (error) {
					if (preserveStartLock && startLockLease !== undefined) {
						try {
							const durable = await readTransaction(projectRoot, delegationId);
							if (durable.ok) {
								if (durable.value.status === "PREPARED") {
									const closed = await abortPristinePreparedDelegationUnderStartLockV2({
										project_root: projectRoot,
										transaction: durable.value,
										start_lock_lease: startLockLease,
										now: controller.services.now().toISOString(),
									});
									preserveStartLock = closed.status !== "recovered";
								} else {
									preserveStartLock = ["RUNNING", "COMMITTING"].includes(durable.value.status);
								}
							}
						} catch {
							// A failed strict read or closure attempt cannot disprove the durable
							// PREPARED callback. Retain the exact lease as crash evidence.
						}
					}
					throw error;
				}
				let durableExecutionState = execution.durable_state;
				// Once execution has returned a durable PREPARED observation, retain the
				// exact lease unless the closure CAS proves a terminal replacement. Set
				// this before attempting closure so a storage/inspection throw cannot
				// accidentally release the only evidence protecting the ambiguous record.
				if (durableExecutionState !== undefined) {
					preserveStartLock = ["PREPARED", "RUNNING", "COMMITTING"].includes(durableExecutionState.status);
				}
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
				if (durableExecutionState !== undefined) {
					preserveStartLock = ["PREPARED", "RUNNING", "COMMITTING"].includes(durableExecutionState.status);
				}

				if (execution.after !== undefined) {
					const observed = observeDiffChange(controller.getDelegationState(), execution.after.diffHash, controller.services.now().toISOString());
					controller.setDelegationState(observed);
					try {
						controller.persistDelegationStateStrict(observed);
					} catch {
						await recordSessionMirrorWarning("execution_projection", durableExecutionState?.status);
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
							controller.setDelegationState(reviewed);
							await recordSessionMirrorWarning("failed_terminal_projection", durableExecutionState.status);
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
					const deterministicTerminalRepair = ["FAILED", "RECOVERY_REQUIRED"].includes(status)
						&& durableExecutionState?.repair_lineage !== undefined;
					const nextAction = deterministicTerminalRepair
						? `; next_action=${repairDelegationToolActionV1(delegationId)}`
						: "; next_action=call workbench_delegation_status";
					const mirrorWarning = sessionMirrorWarnings.length === 0
						? ""
						: `; warning=session_mirror_append_failed; durable_readback=${sessionMirrorWarnings.at(-1)!.durable_readback}`;
					const summary = `workbench_delegate_worker: delegation v2 ${execution.code}${artifactError}${preparedStep}; delegation_id=${delegationId}; durable_status=${status}; postconditions=${reasons}${workerFailure}${workerReport}${changedPaths}${workerFacts}${mirrorWarning}${nextAction}`;
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
				let reviewPostprocessing: {
					status: "RETRYABLE_FAILURE";
					code: string;
					next_action: string;
				} | undefined;
				let automaticSemanticReview: Exclude<Awaited<ReturnType<DelegateToolServices["completeDefaultDelivery"]>>, { ok: false }>["automatic_semantic_review"];
				if (taskKind.taskKind === "diagnosis") {
					const reviewed = await controller.projectTerminalReviewedBinding(projectRoot, delegationId, controller.services.now().toISOString());
					if (reviewed === null) throw new Error("workbench_delegate_worker: diagnosis session mirror could not enter REVIEWED");
					try {
						controller.persistDelegationStateStrict(reviewed);
					} catch {
						controller.setDelegationState(reviewed);
						await recordSessionMirrorWarning("diagnosis_projection", "FINISHED");
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
						modelRegistry: ctx.modelRegistry,
						...(signal === undefined ? {} : { signal }),
					});
					if (!delivery.ok) {
						const reviewError = delivery.review_error === undefined ? "" : `; review_error=${delivery.review_error}`;
						if (delivery.recovery === "authority_error") {
							throw new Error(`workbench_delegate_worker: default delivery authority error ${delivery.code}${reviewError}`);
						}
						reviewPostprocessing = {
							status: "RETRYABLE_FAILURE",
							code: delivery.review_error ?? delivery.code,
							next_action: delivery.next_action ?? reviewDelegationToolActionV1(delegationId),
						};
					} else {
						automaticSemanticReview = delivery.automatic_semantic_review;
						if (automaticSemanticReview?.status === "RETRYABLE_FAILURE") {
							reviewPostprocessing = {
								status: "RETRYABLE_FAILURE",
								code: automaticSemanticReview.code,
								next_action: automaticSemanticReview.next_action,
							};
						}
						if (delivery.session_mirror_warning !== undefined) {
							controller.setDelegationState(delivery.state);
							sessionMirrorWarnings.push({
								...delivery.session_mirror_warning,
								phase: "default_delivery_projection",
							});
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
				if (reviewPostprocessing !== undefined) {
					toolResult.details.review_postprocessing = reviewPostprocessing;
					toolResult.details.next_action = reviewPostprocessing.next_action;
					toolResult.content = toolResult.content.map((item) => ({
						...item,
						text: `${item.text}\nreview recovery: ${reviewPostprocessing!.status} (${reviewPostprocessing!.code}); next action: ${reviewPostprocessing!.next_action}`,
					}));
				}
				if (automaticSemanticReview !== undefined) {
					const { review_result: _reviewResult, ...boundedAutomatic } = automaticSemanticReview;
					toolResult.details.automatic_semantic_review = boundedAutomatic;
					toolResult.details.nested_usage = automaticSemanticReview.nested_usage;
					if (automaticSemanticReview.receipt_hash !== undefined) {
						toolResult.details.semantic_review_receipt_hash = automaticSemanticReview.receipt_hash;
					}
					if (automaticSemanticReview.next_action !== undefined) toolResult.details.next_action = automaticSemanticReview.next_action;
					const recovery = automaticSemanticReview.status === "RETRYABLE_FAILURE"
						? `; next action: ${automaticSemanticReview.next_action}`
						: automaticSemanticReview.status === "REPAIR" ? `; next action: ${automaticSemanticReview.next_action}` : "";
					toolResult.content = toolResult.content.map((item) => ({
						...item,
						text: `${item.text}\nautomatic Sol review: ${automaticSemanticReview!.status}${"code" in automaticSemanticReview! ? ` (${automaticSemanticReview!.code})` : ""}${recovery}`,
					}));
				}
				attachDelegateSessionMirrorWarning(toolResult, sessionMirrorWarnings);
				void controller.refreshStatus(ctx);
				trustedIngress = controller.bindTrustedIngressAuthority(authority, toolResult.content);
				return toolResult;
			} finally {
				controller.rememberTrustedIngressAuthority(toolCallId, "workbench_delegate_worker", trustedIngress);
				// Terminal success, explicit abort/failure, delivery failure, and
				// pre-PREPARED throws release here. A post-PREPARED throw releases only
				// after strict terminal readback/CAS; otherwise its active or unreadable
				// transaction retains the exact lease as same-process crash evidence.
				if (preserveStartLock && checkoutOperationLease !== undefined) {
					markProjectCheckoutOperationSettledV1(checkoutOperationLease);
				} else {
					await releaseStartLock();
				}
			}
			};
	const execute: DelegateWorkerExecuteV1 = async (toolCallId, params, signal, onUpdate, ctx) => {
		if (params.repair_of !== undefined) {
			if (controller.executeModelRepairAlias === undefined) {
				throw new Error("workbench_delegate_worker: exact repair compatibility router is unavailable");
			}
			return controller.executeModelRepairAlias(toolCallId, params, signal, onUpdate, ctx);
		}
		return executeKernel(toolCallId, params, signal, onUpdate, ctx);
	};
	const executeExactRepair: DelegateExactRepairExecuteV1 = (authority, signal, onUpdate, ctx) =>
		executeKernel(authority.tool_call_id, authority.arguments, signal, onUpdate, ctx, authority);
	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_delegate_worker,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_delegate_worker,
		executionMode: "sequential",
		execute,
	});
	return Object.freeze({ execute, executeExactRepair });
}
