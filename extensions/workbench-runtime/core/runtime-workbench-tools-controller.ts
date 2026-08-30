/**
 * Composition helper for the public Workbench tools and their ordered guards.
 *
 * This module owns no domain state. It keeps the composition root bounded while
 * preserving the exact registration order required by the Pi extension API.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createAutomaticDeliveryContinuationRuntimeControllerV1 } from "./automatic-delivery-continuation-runtime-controller.ts";
import { resolveAutomaticDeliveryContinuationCandidateV1 } from "./automatic-delivery-continuation-authority.ts";
import { registerAutomaticSemanticReviewCommand } from "./automatic-semantic-review-command.ts";
import { boundedInlineDetail } from "./command-output.ts";
import { registerCompareTool } from "./compare-tool-controller.ts";
import type { ExecFn } from "./config.ts";
import {
	WORKER_COMMAND_EFFECT_ENTRY_TYPE,
	buildWorkerCommandEffectEntryFromToolResult,
} from "./delegation-command-effect-provenance.ts";
import type { DelegationSessionController } from "./delegation-session-controller.ts";
import { registerDelegationStatusTool } from "./delegation-status-tool-controller.ts";
import {
	registerDelegateTool,
	type DelegateWorkerExecuteV1,
} from "./delegate-tool-controller.ts";
import {
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTerminalNegativeSolAuthorityV1,
	readDelegationTransactionV2,
} from "./delegation-transaction-storage.ts";
import { collectFinalizationRepairRebaseAuthorityV1 } from "./delegation-repair-rebase.ts";
import type { LifecycleActionSnapshotV2 } from "./delegation-lifecycle-resolver.ts";
import { registerExactRepairCommandV1 } from "./exact-repair-command.ts";
import { runExactRepairServiceV1 } from "./exact-repair-service.ts";
import { readExactRepairSuccessorV1 } from "./exact-repair-successor.ts";
import { registerExactRepairToolV1 } from "./exact-repair-tool-controller.ts";
import { registerGateTools } from "./gate-tools-controller.ts";
import type { WorkerFirstGateFacts } from "./gate-schema.ts";
import { registerGitTool } from "./local-commit-tool-controller.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import {
	projectCheckoutOperationBlockReasonV1,
	recoverSettledGenericProjectCheckoutOperationV1,
	type ProjectCheckoutOperationLeaseV1,
} from "./project-checkout-operation.ts";
import { registerRecipeTools } from "./recipe-tools-controller.ts";
import { registerRecoveryTool } from "./recovery-tool-controller.ts";
import { registerReviewTool } from "./review-tool-controller.ts";
import {
	doctorWorkbenchRuntimeBuildV1,
} from "./runtime-build-identity.ts";
import { RUNTIME_CONTROLLER_SERVICES } from "./runtime-controller-services.ts";
import type { RuntimeTransientState } from "./runtime-transient-state.ts";
import { registerToolCallGuard } from "./tool-call-guard-controller.ts";
import {
	registerToolResultMiddleware,
	type PendingReceiptHandle,
} from "./tool-result-middleware-controller.ts";
import type {
	TurnOutputAuthorization,
	TurnOutputBudgetState,
	TurnRole,
} from "./turn-output-budget.ts";
import type { WorkerRoleContext } from "./worker-policy.ts";
import {
	WORKER_CONTRACT_HASH_ENV,
	WORKER_DELEGATION_ID_ENV,
} from "./worker-policy.ts";
import type { WorkerWriteJournalRuntime } from "./worker-write-journal-runtime.ts";
import type { WriteLease } from "./write-authority.ts";

export interface RuntimeWorkbenchToolsControllerV1 {
	readonly pi: ExtensionAPI;
	readonly exec: ExecFn;
	readonly secrets: readonly string[];
	readonly getMode: () => WorkbenchMode;
	readonly getLifecycleActionSnapshot: () => Readonly<LifecycleActionSnapshotV2> | undefined;
	readonly getIdentity: () => { readonly provider?: string; readonly model?: string };
	readonly workerRoleContext: WorkerRoleContext;
	readonly workerWriteJournalRuntime: WorkerWriteJournalRuntime;
	readonly delegationSession: DelegationSessionController;
	readonly transientState: RuntimeTransientState;
	readonly trustedOrError: (ctx: ExtensionContext) => string | undefined;
	readonly projectRootFor: (ctx: ExtensionContext) => Promise<string>;
	readonly output: (ctx: ExtensionCommandContext, lines: string[]) => void;
	readonly buildReadOnlyWorkerFirstGateFacts: (projectRoot: string, now: string) => Promise<WorkerFirstGateFacts>;
	readonly buildWorkerFirstGateFacts: (projectRoot: string, now: string) => Promise<WorkerFirstGateFacts>;
	readonly refreshStatus: (ctx: ExtensionContext) => Promise<void>;
	readonly refreshCompactFacts: () => void;
	readonly delegationStatusLines: (projectRoot: string) => Promise<{ lines: string[]; gitRefresh: "fresh" | "unavailable"; verifyBlockReason?: string | null }>;
	readonly syncLease: (now?: string) => void;
	readonly compactionPending: () => boolean;
	readonly streamingToolCallBlockReason: (toolName: unknown) => string | undefined;
	readonly runtimeMutationBlockReason: (toolName: unknown) => string | undefined;
	readonly outputTurnRole: () => TurnRole;
	readonly authorizeOutput: (toolCallId: unknown, toolName: unknown, input: unknown) => TurnOutputAuthorization;
	readonly observeOutputEnvelope: (toolName: unknown, facts: unknown) => void;
	readonly turnOutputBudget: TurnOutputBudgetState;
	readonly pendingReceiptHandles: Map<string, PendingReceiptHandle>;
	readonly getLease: () => WriteLease | undefined;
	readonly setLease: (lease: WriteLease) => void;
	readonly persistLease: () => boolean | void;
	readonly applyModeTools: () => void;
	readonly recordBlockedWriteAttempt: (now: string) => void;
	readonly recordModifiedFile: (path: string) => void;
}

export interface RegisteredRuntimeWorkbenchToolsV1 {
	hasPendingAutomaticDeliveryContinuation(): boolean;
}

function runtimeFreshnessError(includeAction: boolean): string | undefined {
	try {
		const doctor = doctorWorkbenchRuntimeBuildV1();
		if (doctor.status === "CURRENT") return undefined;
		const detail = `loaded workbench runtime is STALE (loaded=${doctor.loaded.source_hash}; disk=${doctor.disk.source_hash})`;
		return includeAction
			? `${detail}; run /reload or restart Pi, then verify /q-runtime-doctor before retrying`
			: detail;
	} catch (error) {
		if (!includeAction) return "workbench runtime freshness is unavailable";
		return `workbench runtime freshness is unavailable (${boundedInlineDetail((error as Error).message, 512)}); run /reload or restart Pi, then verify /q-runtime-doctor before retrying`;
	}
}

/** Register public tools, direct review/repair commands, and ordered middleware. */
export function registerRuntimeWorkbenchToolsV1(
	controller: RuntimeWorkbenchToolsControllerV1,
): RegisteredRuntimeWorkbenchToolsV1 {
	const pendingCheckoutOperationHandles = new Map<string, ProjectCheckoutOperationLeaseV1>();
	const identity = () => ({
		role: controller.workerRoleContext.role,
		...controller.getIdentity(),
	});

	registerRecipeTools({
		pi: controller.pi,
		getMode: controller.getMode,
		getIdentity: identity,
		exec: controller.exec,
		trustedOrError: controller.trustedOrError,
		projectRootFor: controller.projectRootFor,
		buildReadOnlyWorkerFirstGateFacts: controller.buildReadOnlyWorkerFirstGateFacts,
		peekOutputAuthorization: controller.transientState.peekOutputAuthorization,
		rememberTrustedRunLogContinuation: controller.transientState.rememberTrustedRunLogContinuation,
		bindTrustedIngressAuthority: controller.transientState.bindTrustedIngressAuthority,
		rememberTrustedIngressAuthority: controller.transientState.rememberTrustedIngressAuthority,
	});
	registerGateTools({
		pi: controller.pi,
		getMode: controller.getMode,
		getDelegationState: controller.delegationSession.getState,
		getIdentity: identity,
		exec: controller.exec,
		trustedOrError: controller.trustedOrError,
		projectRootFor: controller.projectRootFor,
		reconcileProjectAuthority: controller.delegationSession.reconcileProjectAuthority,
		getProjectAuthorityBlockReason: controller.delegationSession.projectAuthorityBlockReason,
		buildWorkerFirstGateFacts: controller.buildWorkerFirstGateFacts,
		peekOutputAuthorization: controller.transientState.peekOutputAuthorization,
		rememberTrustedGateContinuation: controller.transientState.rememberTrustedGateContinuation,
		bindTrustedIngressAuthority: controller.transientState.bindTrustedIngressAuthority,
		rememberTrustedIngressAuthority: controller.transientState.rememberTrustedIngressAuthority,
	});
	registerCompareTool({
		pi: controller.pi,
		services: RUNTIME_CONTROLLER_SERVICES.compare,
		trustedOrError: controller.trustedOrError,
		projectRootFor: controller.projectRootFor,
		bindTrustedIngressAuthority: controller.transientState.bindTrustedIngressAuthority,
		rememberTrustedIngressAuthority: controller.transientState.rememberTrustedIngressAuthority,
	});
	let executeModelRepairAlias: DelegateWorkerExecuteV1 | undefined;
	const delegateExecution = registerDelegateTool({
		pi: controller.pi,
		services: RUNTIME_CONTROLLER_SERVICES.delegate,
		exec: controller.exec,
		secrets: controller.secrets,
		trustedOrError: controller.trustedOrError,
		projectRootFor: controller.projectRootFor,
		getMode: controller.getMode,
		reconcileProjectAuthority: controller.delegationSession.reconcileProjectAuthority,
		getProjectAuthorityBlockReason: controller.delegationSession.projectAuthorityBlockReason,
		getProjectAuthorityIssueCode: () => controller.delegationSession.getProjectAuthorityIssue()?.code,
		collectCurrentDelegationBinding: controller.delegationSession.collectCurrentBinding,
		projectTerminalReviewedBinding: controller.delegationSession.projectTerminalReviewedBinding,
		getDelegationState: controller.delegationSession.getState,
		setDelegationState: controller.delegationSession.setState,
		persistDelegationState: controller.delegationSession.persistBestEffort,
		persistDelegationStateStrict: controller.delegationSession.persistStrict,
		markTerminalMirrorBlocked: controller.delegationSession.markTerminalMirrorBlocked,
		refreshStatus: controller.refreshStatus,
		bindTrustedIngressAuthority: controller.transientState.bindTrustedIngressAuthority,
		rememberTrustedIngressAuthority: controller.transientState.rememberTrustedIngressAuthority,
		checkoutOperationForToolCall: (toolCallId, projectRoot) => {
			const lease = pendingCheckoutOperationHandles.get(toolCallId);
			return lease?.project_root === projectRoot ? lease : undefined;
		},
		executeModelRepairAlias: (...args) => {
			if (executeModelRepairAlias === undefined) {
				throw new Error("workbench_delegate_worker: exact repair compatibility router is unavailable");
			}
			return executeModelRepairAlias(...args);
		},
	});
	const automaticDeliveryContinuation = createAutomaticDeliveryContinuationRuntimeControllerV1({
		pi: controller.pi,
		pendingCheckoutOperationHandles,
		exec: controller.exec,
		secrets: controller.secrets,
		getMode: controller.getMode,
		getLifecycleActionSnapshot: controller.getLifecycleActionSnapshot,
		runtimeCurrentOrError: () => runtimeFreshnessError(false),
		compactionPending: controller.compactionPending,
		projectRootFor: controller.projectRootFor,
		recoverSettledCheckoutOperation: ({ project_root: projectRoot }) =>
			recoverSettledGenericProjectCheckoutOperationV1(projectRoot),
		reconcileProjectAuthority: async ({ project_root: projectRoot, now }) =>
			controller.delegationSession.reconcileProjectAuthority(projectRoot, now),
		resolveCandidate: resolveAutomaticDeliveryContinuationCandidateV1,
		confirmSettled: async (input) => {
			try {
				const before = await projectCheckoutOperationBlockReasonV1({ project_root: input.project_root });
				if (before !== undefined) return { ok: false, code: "ACTIVE_CHECKOUT_LANE" };
				const resolution = await resolveAutomaticDeliveryContinuationCandidateV1({
					project_root: input.project_root,
					trigger: "agent_settled",
					locator_delegation_ids: [input.delegation_id],
					require_unique_unresolved_tip: true,
					require_strict_repair_sidecar: true,
					require_full_path_admission: true,
					allow_exact_terminal_needs_review: true,
				});
				if (resolution.status !== "CANDIDATE" ||
					resolution.candidate.delegation_id !== input.delegation_id ||
					resolution.candidate.authority_hash !== input.expected_authority_hash ||
					resolution.candidate.bound_diff_hash !== input.expected_bound_diff_hash ||
					resolution.candidate.lineage_depth !== input.required_lineage_depth) {
					return { ok: false, code: "PARENT_AUTHORITY_UNAVAILABLE" };
				}
				const after = await projectCheckoutOperationBlockReasonV1({ project_root: input.project_root });
				if (after !== undefined) return { ok: false, code: "ACTIVE_CHECKOUT_LANE" };
				return {
					ok: true,
					value: {
						schema_version: 1,
						project_root: input.project_root,
						delegation_id: input.delegation_id,
						authority_hash: input.expected_authority_hash,
						bound_diff_hash: input.expected_bound_diff_hash,
						lineage_depth: 0,
						authority_confirmed: true,
						no_active_lane: true,
					},
				};
			} catch {
				return { ok: false, code: "PARENT_AUTHORITY_UNAVAILABLE" };
			}
		},
		exactRepair: (input) => runExactRepairServiceV1(input, {
			executeExactRepair: delegateExecution.executeExactRepair,
			collectCurrentBinding: controller.delegationSession.collectCurrentBinding,
			readCommittedGeneration: readDelegationCommittedGenerationV2,
			readReview: readDelegationReviewV2,
			readTerminalNegativeRepair: readDelegationTerminalNegativeSolAuthorityV1,
			readSuccessor: readExactRepairSuccessorV1,
			readTransaction: readDelegationTransactionV2,
		}),
	});
	// Automatic delivery continuation is Commander-owned. Registering its
	// before_agent_start hook in a Luna child injects candidate/Gate recovery
	// advice into the active implementation turn and can make a valid DEV
	// worker defer with GATE_NOT_READY.
	const automaticDeliveryContinuationEnabled = controller.workerRoleContext.role !== "worker";
	registerExactRepairCommandV1({
		pi: controller.pi,
		execution: delegateExecution,
		readCommittedGeneration: readDelegationCommittedGenerationV2,
		readReview: readDelegationReviewV2,
		readTerminalNegativeRepair: readDelegationTerminalNegativeSolAuthorityV1,
		readSuccessor: readExactRepairSuccessorV1,
		collectCurrentBinding: controller.delegationSession.collectCurrentBinding,
		reconcileProjectAuthority: controller.delegationSession.reconcileProjectAuthority,
		getMode: controller.getMode,
		runtimeCurrentOrError: () => runtimeFreshnessError(true),
		trustedOrError: controller.trustedOrError,
		projectRootFor: controller.projectRootFor,
		output: controller.output,
	});
	registerAutomaticSemanticReviewCommand({
		pi: controller.pi,
		exec: controller.exec,
		secrets: controller.secrets,
		getMode: controller.getMode,
		runtimeCurrentOrError: () => runtimeFreshnessError(true),
		trustedOrError: controller.trustedOrError,
		projectRootFor: controller.projectRootFor,
		reconcileProjectAuthority: controller.delegationSession.reconcileProjectAuthority,
		getDelegationState: controller.delegationSession.getState,
		persistDelegationStateStrict: controller.delegationSession.persistStrict,
		output: controller.output,
	});
	registerReviewTool({
		pi: controller.pi,
		services: RUNTIME_CONTROLLER_SERVICES.review,
		exec: controller.exec,
		secrets: controller.secrets,
		trustedOrError: controller.trustedOrError,
		projectRootFor: controller.projectRootFor,
		peekOutputAuthorization: controller.transientState.peekOutputAuthorization,
		syncLease: controller.syncLease,
		reconcileProjectAuthority: controller.delegationSession.reconcileProjectAuthority,
		getProjectAuthorityBlockReason: controller.delegationSession.projectAuthorityBlockReason,
		getProjectAuthorityIssueCode: () => controller.delegationSession.getProjectAuthorityIssue()?.code,
		getDelegationState: controller.delegationSession.getState,
		setDelegationState: controller.delegationSession.setState,
		isStrictMirrorDirty: controller.delegationSession.isStrictMirrorDirty,
		setStrictMirrorDirty: controller.delegationSession.setStrictMirrorDirty,
		persistDelegationState: controller.delegationSession.persistBestEffort,
		persistDelegationStateStrict: controller.delegationSession.persistStrict,
		refreshCompactFacts: controller.refreshCompactFacts,
		refreshStatus: controller.refreshStatus,
	});
	registerDelegationStatusTool({
		pi: controller.pi,
		trustedOrError: controller.trustedOrError,
		projectRootFor: controller.projectRootFor,
		syncLease: controller.syncLease,
		delegationStatusLines: controller.delegationStatusLines,
		refreshStatus: controller.refreshStatus,
	});
	registerRecoveryTool({
		pi: controller.pi,
		services: RUNTIME_CONTROLLER_SERVICES.recovery,
		trustedOrError: controller.trustedOrError,
		projectRootFor: controller.projectRootFor,
	});
	registerGitTool({
		pi: controller.pi,
		services: RUNTIME_CONTROLLER_SERVICES.git,
		exec: controller.exec,
		trustedOrError: controller.trustedOrError,
		projectRootFor: controller.projectRootFor,
		getMode: controller.getMode,
		getIdentity: () => ({ roleEnv: controller.workerRoleContext.role, ...controller.getIdentity() }),
		checkoutOperationForToolCall: (toolCallId, projectRoot) => {
			const lease = pendingCheckoutOperationHandles.get(toolCallId);
			return lease?.project_root === projectRoot ? lease : undefined;
		},
		reconcileProjectAuthority: controller.delegationSession.reconcileProjectAuthority,
		refreshStatus: controller.refreshStatus,
	});
	const exactRepairToolExecution = registerExactRepairToolV1({
		pi: controller.pi,
		execution: delegateExecution,
		serviceDependencies: {
			collectCurrentBinding: controller.delegationSession.collectCurrentBinding,
			collectFinalizationRebase: (projectRoot, transaction) =>
				collectFinalizationRepairRebaseAuthorityV1({ projectRoot, transaction, exec: controller.exec }),
			readCommittedGeneration: readDelegationCommittedGenerationV2,
			readReview: readDelegationReviewV2,
			readTerminalNegativeRepair: readDelegationTerminalNegativeSolAuthorityV1,
			readSuccessor: readExactRepairSuccessorV1,
			readTransaction: readDelegationTransactionV2,
		},
		trustedOrError: controller.trustedOrError,
		projectRootFor: controller.projectRootFor,
		getMode: controller.getMode,
		runtimeCurrentOrError: () => runtimeFreshnessError(true),
		reconcileProjectAuthority: controller.delegationSession.reconcileProjectAuthority,
		exec: controller.exec,
	});
	executeModelRepairAlias = exactRepairToolExecution.executeDelegateAlias;
	if (automaticDeliveryContinuationEnabled) automaticDeliveryContinuation.registerToolResultLocatorCaptureBeforeMiddleware();
	registerToolResultMiddleware({
		pi: controller.pi,
		workerJournalActive: controller.workerRoleContext.role === "worker" && controller.workerRoleContext.taskKind === "implementation",
		workerWriteJournalRuntime: controller.workerWriteJournalRuntime,
		getOutputTurnRole: controller.outputTurnRole,
		takeTrustedContinuation: (toolCallId, toolName) =>
			controller.transientState.takeTrustedReadContinuation(toolCallId, toolName)
			?? controller.transientState.takeTrustedRunLogContinuation(toolCallId, toolName)
			?? controller.transientState.takeTrustedGateContinuation(toolCallId, toolName),
		takeOutputAuthorization: controller.transientState.takeOutputAuthorization,
		authorizeOutput: controller.authorizeOutput,
		takeTrustedIngressAuthority: controller.transientState.takeTrustedIngressAuthority,
		turnOutputBudget: controller.turnOutputBudget,
		observeOutputEnvelope: controller.observeOutputEnvelope,
		rememberProcessedNormalResult: controller.transientState.rememberProcessedNormalResult,
		pendingReceiptHandles: controller.pendingReceiptHandles,
		pendingCheckoutOperationHandles,
		secrets: controller.secrets,
		...(controller.workerRoleContext.role === "worker" && controller.workerRoleContext.taskKind === "implementation"
			&& typeof controller.workerRoleContext.projectRoot === "string"
			&& typeof process.env[WORKER_DELEGATION_ID_ENV] === "string"
			&& typeof process.env[WORKER_CONTRACT_HASH_ENV] === "string"
			? {
				observeWorkerRecipeCommandEffect: async (event: Readonly<{ toolName: unknown; details: unknown }>) => {
					const entry = await buildWorkerCommandEffectEntryFromToolResult({
						project_root: controller.workerRoleContext.projectRoot!,
						delegation_id: process.env[WORKER_DELEGATION_ID_ENV]!,
						contract_hash: process.env[WORKER_CONTRACT_HASH_ENV]!,
						tool_name: event.toolName,
						details: event.details,
					});
					if (entry !== undefined) controller.pi.appendEntry(WORKER_COMMAND_EFFECT_ENTRY_TYPE, entry);
				},
			}
			: {}),
	});
	if (automaticDeliveryContinuationEnabled) automaticDeliveryContinuation.registerLifecycleListenersAfterMiddleware();
	registerToolCallGuard({
		pi: controller.pi,
		toolCallBlockReason: controller.streamingToolCallBlockReason,
		runtimeMutationBlockReason: controller.runtimeMutationBlockReason,
		getWorkerRoleContext: () => controller.workerRoleContext,
		getIdentity: controller.getIdentity,
		getMode: controller.getMode,
		getLease: controller.getLease,
		setLease: controller.setLease,
		syncLease: (now) => controller.syncLease(now),
		recordBlockedWriteAttempt: controller.recordBlockedWriteAttempt,
		projectRootFor: controller.projectRootFor,
		makeDelegationId: RUNTIME_CONTROLLER_SERVICES.delegate.makeDelegationId,
		reconcileProjectAuthority: controller.delegationSession.reconcileProjectAuthority,
		authorizeOutput: controller.authorizeOutput,
		rememberOutputAuthorization: controller.transientState.rememberOutputAuthorization,
		workerWriteJournalRuntime: controller.workerWriteJournalRuntime,
		turnOutputBudget: controller.turnOutputBudget,
		pendingReceiptHandles: controller.pendingReceiptHandles,
		pendingCheckoutOperationHandles,
		persistLease: controller.persistLease,
		applyModeTools: controller.applyModeTools,
		recordModifiedFile: controller.recordModifiedFile,
	});

	return {
		hasPendingAutomaticDeliveryContinuation: () =>
			automaticDeliveryContinuationEnabled && automaticDeliveryContinuation.hasPendingBeforeAgentContinuation(),
	};
}
