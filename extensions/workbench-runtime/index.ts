/**
 * pi-dev-workbench runtime composition root.
 *
 * Domain behavior lives in core/, cache/, worker/ and ui/. This file wires
 * session state, Pi lifecycle events, commands, public tools and the ordered
 * output/authorization middleware. Keep public tool order and event order
 * stable; implementation history and feature contracts belong in docs/.
 */

import { readFile } from "node:fs/promises";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	checkToolCall,
	computeActiveTools,
	type WorkbenchMode,
} from "./core/mode-policy.ts";
import { type ReceiptHandle } from "./core/tool-result-recovery.ts";
import {
	computeRoleActiveTools,
	parseWorkerAllowedPaths,
	parseWorkerTaskKindEnvironment, parseWorkerTimeoutMsEnvironment,
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_CONTRACT_HASH_ENV,
	WORKER_DELEGATION_ID_ENV,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_ROLE_ENV,
	WORKER_TASK_KIND_ENV, WORKER_TIMEOUT_MS_ENV,
	type RecipeMutationFacts,
} from "./core/worker-policy.ts";
import {
	WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_ENTRY_TYPE,
	createWorkerWriteJournalRuntime,
} from "./core/worker-write-journal-runtime.ts";
import {
	resolveWorkerSpendProfile,
	WORKER_SPEND_PROFILE_ENV,
} from "./core/worker-spend.ts";
import {
	describeMode,
	loadModeFromEntries,
	MODE_ENTRY_TYPE,
	statusText,
} from "./core/state.ts";
import {
	findProjectRoot,
	loadProjectConfig,
	type ExecFn,
} from "./core/config.ts";
import { type WorkerFirstGateFacts } from "./core/gate-schema.ts";
import {
	listRuns,
	readCommittedManifest,
} from "./core/runs.ts";
import { join } from "node:path";
import { runStatusLabel, fitToWidth } from "./core/format.ts";
import { buildStatusLine } from "./core/status.ts";
import { costStatusSegment } from "./core/cost-breakdown.ts";
import { RuntimeCostBreakdownCache } from "./core/runtime-cost-breakdown-cache.ts";
import {
	advisoryStatusSegment,
	contextOutputAdvisoryStatusSegment,
	evaluateAdvisory,
	type AdvisoryConfig,
} from "./core/commander-advisory.ts";
import { buildWidgetLines, widgetAction, type WidgetState } from "./core/widget.ts";
import { latestGateRunSummary } from "./core/report.ts";
import {
	buildCompactNote,
	collectDoNotRetry,
	COMPACT_NOTE_MESSAGE_TYPE,
	COMPACT_STATE_ENTRY_TYPE,
	emptyCompactState,
	loadCompactStateFromEntries,
	MAX_DO_NOT_RETRY,
	MAX_EVIDENCE_PATHS,
	MAX_GATES,
	MAX_MODIFIED_FILES,
	pushBounded,
	shouldSupplement,
	summarizeReviewedWorkerChangedPaths,
	type CompactState,
} from "./core/compact.ts";
import {
	COMPACT_ATTEMPT_ENTRY_TYPE,
	finishCompactAttempt,
	parseCompactAttemptState,
	startCompactAttempt,
	type CompactAttemptState,
	type CompactAttemptTerminalStatus,
} from "./core/compact-lifecycle.ts";
import { decideCompactOverflowRecovery } from "./core/compact-overflow.ts";
import { evaluateCompactSummaryPreflight } from "./core/compact-preflight.ts";
import {
	createCacheTelemetry,
	type CacheTelemetry,
} from "./cache/cache-telemetry.ts";
import { readDelegationLedger, type GitFacts } from "./core/delegation-ledger.ts";
import {
	readDelegationCommittedGenerationV2,
	readDelegationTransactionV2,
} from "./core/delegation-transaction-storage.ts";
import {
	readRecoverableUnpublishedDelegationV2,
	readDelegationAuthorityObservationV2 as readDelegationAuthorityObservation,
} from "./core/delegation-project-authority.ts";
import { delegationDisplayedStatusV1, delegationNextActionTextV1, delegationProjectIssueRepairStatusV1, delegationRepairStatusLinesV1, readDelegationRepairStatusV1,
	type DelegationRepairStatusV1 } from "./core/delegation-repair-status.ts";
import { buildDelegationWorkerFirstGateFacts } from "./core/delegation-plan-reference.ts";
import { resolveToolOutputPolicy } from "./core/output-policy.ts";
import {
	enforceOutputEnvelope,
	type ImageContent as OutputImageContent,
	type OutputEnvelopeResult,
	type TextContent as OutputTextContent,
} from "./core/output-envelope.ts";
import {
	projectToolResultDetails,
} from "./core/details-projection.ts";
import {
	COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
	HISTORY_DESCRIPTOR_MAX_BYTES,
	HISTORY_MAX_BUNDLES,
	HISTORY_PROJECTION_EVENT_KINDS,
	HISTORY_PROJECTION_OBSERVATION_CAUSES,
	HISTORY_PROJECTION_ENTRY_TYPE,
	HistoryProjectionController,
	OTHER_HISTORY_TOOL_TEXT_MAX_BYTES,
	WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
	safeHistoryProjectionFailureMessages,
	type HistoryProjectionFacts,
	type HistoryProjectionObservability,
} from "./core/context-history-budget.ts";
import {
	buildTrustedRecoveryAuthority,
} from "./core/trusted-recovery-authority.ts";
import { applyExplicitPromptCacheBreakpoints } from "./core/prompt-cache-breakpoints.ts";
import {
	blockedControlText,
	createTurnOutputBudgetState,
	planTurnOutputBudget,
	type TurnOutputAuthorization,
	type TurnRole,
} from "./core/turn-output-budget.ts";
import {
	OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE,
	createOutputControlTelemetry,
	serializeOutputControlTelemetry,
	type OutputControlTelemetryAccumulator,
} from "./core/output-control-telemetry.ts";
import {
	blocksVerify,
	delegationCompactSummary,
	hasPendingReview,
	hasStaleReview,
	demoteReviewedToPending,
	observeDiffChange,
	recordBlockedWriteAttempt,
	reviewBlockReason,
	type DelegationState,
} from "./core/delegation-state.ts";
import {
	defaultWritePolicy,
	detectActorRole,
	LEASE_STATE_ENTRY_TYPE,
	leaseCompactSummary,
	leaseRevokeReason,
	leaseStatus,
	loadLeaseFromEntries,
	revokeLease,
	serializeLease,
	type WriteLease,
} from "./core/write-authority.ts";
import { writeAuthorityFooterSegment } from "./core/lease-command.ts";
import { registerCommanderWriteCommands } from "./core/commander-write-commands.ts";
import { collectSecretValues } from "./core/redact.ts";
import { registerMilestoneHandoffCommand } from "./core/milestone-handoff-controller.ts";
import {
	boundedCommandText as boundedToolText,
	boundedInlineDetail,
} from "./core/command-output.ts";
import { registerRunCommands } from "./core/run-commands.ts";
import { gateParentSummaryLines, registerGateCommands } from "./core/gate-commands.ts";
import { registerInitCommand } from "./core/init-command.ts";
import { registerCacheCommands } from "./core/cache-commands.ts";
import { registerStatusCommands, registerWidgetCommand } from "./core/status-commands.ts";
import { registerNativeToolOverrides } from "./core/native-tool-overrides-controller.ts";
import {
	assistantToolCalls,
	boundedGuardReason,
	ownDataValue,
	streamingControlledApi,
} from "./core/runtime-output-controller.ts";
import {
	fixedToolFailure,
} from "./core/tool-presentation.ts";
import { registerRecipeTools } from "./core/recipe-tools-controller.ts";
import { registerGateTools } from "./core/gate-tools-controller.ts";
import { registerCompareTool } from "./core/compare-tool-controller.ts";
import { registerDelegationStatusTool } from "./core/delegation-status-tool-controller.ts";
import { registerReviewTool } from "./core/review-tool-controller.ts";
import { registerDelegateTool } from "./core/delegate-tool-controller.ts";
import { registerRecoveryTool } from "./core/recovery-tool-controller.ts";
import { registerLocalCommitTool } from "./core/local-commit-tool-controller.ts";
import { RUNTIME_CONTROLLER_SERVICES } from "./core/runtime-controller-services.ts";
import { createRuntimeTransientState } from "./core/runtime-transient-state.ts";
import { createDelegationSessionController } from "./core/delegation-session-controller.ts";
import { registerToolResultMiddleware } from "./core/tool-result-middleware-controller.ts";
import { registerToolCallGuard } from "./core/tool-call-guard-controller.ts";
import { registerMessageEndController } from "./core/message-end-controller.ts";
import { registerDelegationClaimGuard } from "./core/delegation-claim-guard-controller.ts";
import { solCommanderDriftStatus } from "./core/development-efficiency.ts";
import { registerWorkerNoProgressController } from "./core/worker-no-progress-controller.ts";
export {
	installNativeReadV3TestHooks,
	type NativeReadV3TestHookFacts,
	type NativeReadV3TestHooks,
} from "./core/native-tool-overrides-controller.ts";

const STATUS_KEY = "workbench";
type CacheHistoryProjectionInput = NonNullable<
	Parameters<CacheTelemetry["observeContextProjection"]>[0]["historyProjection"]
>;
const OUTPUT_TURN_TELEMETRY_ENTRY_TYPE = "workbench-output-turn-telemetry-v1";
const CONTEXT_PRESSURE_ENTRY_TYPE = "workbench-context-pressure-v1";
type RuntimeOutputContent = Array<OutputTextContent | OutputImageContent>;

/** Secret env values scrubbed from every ledger/review artifact. */
const secrets = collectSecretValues(process.env);

export default function workbenchRuntime(runtimePi: ExtensionAPI): void {
	const streamingControl = streamingControlledApi(runtimePi);
	const pi = streamingControl.api;
	let compactState: CompactState = emptyCompactState("DEV");
	let recentOutcomes: string[] = [];
	let lastCompactNote: string | undefined;
	const uiRefreshSerial = { status: 0, widget: 0 };
	const runtimeCostBreakdown = new RuntimeCostBreakdownCache();
	function touchCompactState(): void { compactState.updatedAt = new Date().toISOString(); }
	function rememberRunOutcome(toolName: string, details: Record<string, unknown>): void {
		if (toolName === "workbench_run_gate") recentOutcomes.push(`gate:${typeof details.status === "string" ? details.status : "UNKNOWN"}`);
		else if (toolName === "workbench_run_recipe") {
			const recipe = typeof details.recipe === "string" ? details.recipe : "?";
			recentOutcomes.push(details.ok === true ? `recipe:${recipe}:ok` : `recipe:${recipe}:exit:${String(details.exit_code ?? "?")}`);
		}
		recentOutcomes = recentOutcomes.slice(-12);
		compactState.doNotRetry = collectDoNotRetry(recentOutcomes, MAX_DO_NOT_RETRY);
	}
	let mode: WorkbenchMode = "DEV";
	let writeLease: WriteLease | undefined;
	/**
	 * P8b: in-memory handles for receipts begun by THIS runtime
	 * (toolCallId → handle + project root). CAPACITY-BLOCKING at
	 * MAX_IN_FLIGHT_RECEIPTS: when the map is already full a new registered
	 * workbench call is blocked fail-closed BEFORE begin/execution with a
	 * fixed bounded reason — existing handles are never evicted and nothing
	 * is begun for the blocked call. Only handles created here are ever
	 * finalized; a replayed call or the recovery tool never enters this map.
	 */
	const pendingReceiptHandles = new Map<string, { handle: ReceiptHandle; projectRoot: string }>();
	/** Latest selected identity/reasoning facts (updated on session_start/select events). */
	let currentModelFacts: { provider?: string; model?: string; thinking?: string } = {};
	let workerBudgetSteerSent = false;
	const workerRoleContext = {
		role: process.env[WORKER_ROLE_ENV],
		projectRoot: process.env[WORKER_PROJECT_ROOT_ENV],
		allowedPaths: parseWorkerAllowedPaths(process.env[WORKER_ALLOWED_PATHS_ENV]),
		taskKind: parseWorkerTaskKindEnvironment(process.env[WORKER_TASK_KIND_ENV]),
		// Phase 2 (worker token-budget repair): the delegation spend profile
		// from the fixed child env contract. Current runners write only
		// standard/extended; retired `low` and malformed/missing child env
		// resolve defensively to `standard`.
		spendProfile: resolveWorkerSpendProfile(process.env[WORKER_SPEND_PROFILE_ENV]),
		timeoutMs: parseWorkerTimeoutMsEnvironment(process.env[WORKER_TIMEOUT_MS_ENV]),
	};
	const workerWriteJournalRuntime = createWorkerWriteJournalRuntime({
		role: workerRoleContext.role,
		task_kind: workerRoleContext.taskKind,
		project_root: workerRoleContext.projectRoot,
		delegation_id: process.env[WORKER_DELEGATION_ID_ENV],
		contract_hash: process.env[WORKER_CONTRACT_HASH_ENV],
	}, {
		appendTelemetry: (telemetry) => pi.appendEntry(WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_ENTRY_TYPE, telemetry),
	});
	const turnOutputBudget = createTurnOutputBudgetState();
	/** Session-scoped numeric-only context-output observations (never enforcement). */
	let outputControlTelemetry: OutputControlTelemetryAccumulator | undefined;
	let outputControlTelemetryRole: TurnRole | undefined;
	const transientState = createRuntimeTransientState();
	/**
	 * Numeric-only local projected-history side channel. R8 consumes this
	 * in-memory snapshot when it persists unified output-control telemetry; it
	 * is not a final-wire observation, does not append an entry per provider
	 * request, and never retains message text.
	 */
	let latestHistoryProjectionFacts: HistoryProjectionFacts = {
		originalToolTextBytes: 0,
		finalToolTextBytes: 0,
		collapsedResults: 0,
		removedBundles: 0,
		protectedLatestBundles: 0,
	};
	const historyProjectionController = new HistoryProjectionController();
	let latestHistoryProjectionBoundaryMarkers: readonly string[] = [];
	let latestHistoryPressure: {
		epoch: number;
		rawBundleCount: number;
		hardHistoryBytes: number;
		hardBundleCount: number;
	} = {
		epoch: 0,
		rawBundleCount: 0,
		hardHistoryBytes: OTHER_HISTORY_TOOL_TEXT_MAX_BYTES,
		hardBundleCount: HISTORY_MAX_BUNDLES,
	};
	let currentTurnSerial = 0;

	function outputTurnRole(): TurnRole {
		if (workerRoleContext.role === "worker") return "worker";
		return detectActorRole({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		}) === "sol-commander" ? "commander" : "other";
	}

	function cacheActorRoleCode(role: TurnRole): 0 | 1 | 2 {
		return role === "commander" ? 1 : role === "worker" ? 2 : 0;
	}

	function cacheHistoryProjectionInput(
		observation: HistoryProjectionObservability,
	): CacheHistoryProjectionInput | null {
		const eventCode = HISTORY_PROJECTION_EVENT_KINDS.indexOf(observation.eventKind);
		const causeCode = HISTORY_PROJECTION_OBSERVATION_CAUSES.indexOf(observation.transitionCause);
		if (eventCode < 0 || eventCode > 6 || causeCode < 0 || causeCode > 9) return null;
		return {
			eventCode: eventCode as 0 | 1 | 2 | 3 | 4 | 5 | 6,
			causeCode: causeCode as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
			epoch: observation.epoch,
			epochTransitioned: observation.epochTransitioned,
			segmentSealed: observation.segmentSealed,
			byteOverflow: observation.byteOverflow,
			bundleOverflow: observation.bundleOverflow,
			segmentsBefore: observation.segmentsBefore,
			segmentsAfter: observation.segmentsAfter,
			hardToolTextBytes: observation.hardToolTextBytes,
			hardBundles: observation.hardBundles,
			rawToolTextBytes: observation.rawToolTextBytes,
			rawBundles: observation.rawBundles,
			projectedToolTextBytes: observation.projectedToolTextBytes,
			projectedBundles: observation.projectedBundles,
			stableToolTextBytesBefore: observation.stableToolTextBytesBefore,
			stableBundlesBefore: observation.stableBundlesBefore,
			activeToolTextBytesBefore: observation.activeToolTextBytesBefore,
			activeBundlesBefore: observation.activeBundlesBefore,
			agedRawToolTextBytes: observation.agedRawToolTextBytes,
			agedRawBundles: observation.agedRawBundles,
			agedProjectedToolTextBytes: observation.agedProjectedToolTextBytes,
			agedProjectedBundles: observation.agedProjectedBundles,
			suffixRawToolTextBytes: observation.suffixRawToolTextBytes,
			suffixRawBundles: observation.suffixRawBundles,
		};
	}

	function ensureOutputControlTelemetry(entries?: readonly unknown[]): OutputControlTelemetryAccumulator {
		const role = outputTurnRole();
		if (!outputControlTelemetry || outputControlTelemetryRole !== role) {
			outputControlTelemetry = createOutputControlTelemetry(role);
			outputControlTelemetryRole = role;
			if (entries) outputControlTelemetry.restoreFromEntries(entries);
		}
		return outputControlTelemetry;
	}

	function mirrorOutputControlCompactFacts(): void {
		const snapshot = ensureOutputControlTelemetry().snapshot();
		compactState.outputTruncatedResults = snapshot.totals.truncatedResults;
		compactState.outputHistoryCollapsedBundles = snapshot.totals.historyCollapsedResults;
	}

	function persistOutputControlTelemetry(): void {
		const snapshot = serializeOutputControlTelemetry(ensureOutputControlTelemetry().snapshot());
		pi.appendEntry(OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE, snapshot);
	}

	function persistHistoryProjectionState(): void {
		try {
			pi.appendEntry(HISTORY_PROJECTION_ENTRY_TYPE, historyProjectionController.serialize());
		} catch {
			// Projection persistence is advisory; hard caps are re-established on the next context event.
		}
	}

	function persistContextPressure(): void {
		try {
			pi.appendEntry(CONTEXT_PRESSURE_ENTRY_TYPE, {
				schema: CONTEXT_PRESSURE_ENTRY_TYPE,
				role: outputTurnRole(),
				epoch: latestHistoryPressure.epoch,
				rawToolTextBytes: latestHistoryProjectionFacts.originalToolTextBytes,
				projectedToolTextBytes: latestHistoryProjectionFacts.finalToolTextBytes,
				rawBundleCount: latestHistoryPressure.rawBundleCount,
				hardHistoryBytes: latestHistoryPressure.hardHistoryBytes,
				hardBundleCount: latestHistoryPressure.hardBundleCount,
				timestampMs: Date.now(),
			});
		} catch {
			// Raw-pressure telemetry must never affect enforcement or the provider path.
		}
	}

	function resetHistoryProjection(): void {
		historyProjectionController.reset();
		latestHistoryProjectionBoundaryMarkers = [];
		latestHistoryProjectionFacts = {
			originalToolTextBytes: 0,
			finalToolTextBytes: 0,
			collapsedResults: 0,
			removedBundles: 0,
			protectedLatestBundles: 0,
		};
		latestHistoryPressure = {
			epoch: historyProjectionController.serialize().epoch,
			rawBundleCount: 0,
			hardHistoryBytes: outputTurnRole() === "commander"
				? COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES
				: outputTurnRole() === "worker"
					? WORKER_HISTORY_TOOL_TEXT_MAX_BYTES
					: OTHER_HISTORY_TOOL_TEXT_MAX_BYTES,
			hardBundleCount: HISTORY_MAX_BUNDLES,
		};
	}

	function observeOutputEnvelope(toolName: unknown, facts: unknown): void {
		try {
			ensureOutputControlTelemetry().recordEnvelope(toolName, facts);
			mirrorOutputControlCompactFacts();
		} catch {
			// Observation is never allowed to alter or reject a bounded result.
		}
	}

	function authorizeOutput(toolCallId: unknown, toolName: unknown, args: unknown): TurnOutputAuthorization {
		return turnOutputBudget.authorizeToolCall({ toolCallId, toolName, args });
	}
	const execFn: ExecFn = (command, args, options) =>
		pi.exec(command, args, { cwd: options?.cwd, timeout: options?.timeout, signal: options?.signal });

	// ---------------------------------------------------------- P6-A cache

	/** Session-scoped prompt-cache telemetry (hash + content-free numeric, never blocking). */
	const cacheTelemetry: CacheTelemetry = createCacheTelemetry({
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
	});

	// ------------------------------------------------ compact continuity v2

	let compactAttempt: CompactAttemptState | undefined;
	let compactAttemptSerial = 0;
	const terminalCompactAttemptIds = new Set<string>();
	let pendingRetryCompactNote: { content: string; updatedAt: string } | undefined;
	let retryCompactNoteReady = false;
	let workbenchOverflowCompactRequested = false;
	let overflowRecoveryAttempted = false;
	let overflowFollowUpPending = false;
	let pendingOverflowRecoveryContext: ExtensionContext | undefined;
	// True only when Pi's own post-agent overflow path reached
	// session_before_compact for the currently pending recovery. Once native Pi
	// has started an attempt, the workbench must never schedule a second compact.
	let nativeOverflowCompactStarted = false;

	function appendCompactAttempt(value: CompactAttemptState): void {
		try {
			pi.appendEntry(COMPACT_ATTEMPT_ENTRY_TYPE, value);
		} catch {
			// The in-memory transition remains monotonic for this runtime.
		}
	}

	function beginCompactAttempt(
		reason: "manual" | "threshold" | "overflow",
		willRetry: boolean,
	): CompactAttemptState {
		if (compactAttempt?.status === "started") finishActiveCompactAttempt("failed");
		const now = new Date();
		const owner = workbenchOverflowCompactRequested ? "workbench-overflow-recovery" : "pi-native";
		workbenchOverflowCompactRequested = false;
		compactAttempt = startCompactAttempt({
			attemptId: `compact-${now.getTime()}-${++compactAttemptSerial}`,
			startedAt: now.toISOString(),
			reason,
			owner,
			willRetry,
		});
		appendCompactAttempt(compactAttempt);
		return compactAttempt;
	}

	function finishActiveCompactAttempt(status: CompactAttemptTerminalStatus): CompactAttemptState | undefined {
		if (!compactAttempt || terminalCompactAttemptIds.has(compactAttempt.attemptId)) return undefined;
		const terminal = finishCompactAttempt(compactAttempt, status, new Date().toISOString());
		if (!terminal) return undefined;
		compactAttempt = terminal;
		terminalCompactAttemptIds.add(terminal.attemptId);
		appendCompactAttempt(terminal);
		return terminal;
	}

	function latestCompactAttempt(entries: readonly unknown[]): CompactAttemptState | undefined {
		let latest: unknown;
		let found = false;
		for (const entry of entries) {
			if (ownDataValue(entry, "type") !== "custom" || ownDataValue(entry, "customType") !== COMPACT_ATTEMPT_ENTRY_TYPE) continue;
			latest = ownDataValue(entry, "data");
			found = true;
		}
		return found ? parseCompactAttemptState(latest) : undefined;
	}

	function reconcileCompactAttempt(entries: readonly unknown[], sessionReason: string): void {
		const restored = latestCompactAttempt(entries);
		if (!restored) return;
		if (terminalCompactAttemptIds.has(restored.attemptId)) return;
		compactAttempt = restored;
		if (restored.status !== "started") {
			terminalCompactAttemptIds.add(restored.attemptId);
			return;
		}
		finishActiveCompactAttempt(sessionReason === "startup" ? "failed" : "cancelled");
	}

	function persistCompactState(): void {
		try {
			pi.appendEntry(COMPACT_STATE_ENTRY_TYPE, compactState);
		} catch {
			// non-interactive context: the in-memory state is still valid
		}
	}

	function requireMilestoneHandoff(ctx: ExtensionContext, reason: string): void {
		compactState.nextStep = "/q-milestone-handoff <next step> before continuing";
		touchCompactState();
		persistCompactState();
		const notice = `${reason} Automatic context recovery stops here; use /q-milestone-handoff <next step>.`;
		if (ctx.hasUI) ctx.ui.notify(notice, "warning");
		else console.warn(notice);
	}

	// ------------------------------------------------------------------ state

	function persistLease(): boolean {
		refreshCompactP7Facts();
		try {
			pi.appendEntry(LEASE_STATE_ENTRY_TYPE, writeLease ? serializeLease(writeLease) : undefined);
			return true;
		} catch {
			return false;
		}
	}

	let latestRepairStatus: DelegationRepairStatusV1 = { kind: "none" };

	/** Refresh the non-authoritative compact summary from hard state. */
	function refreshCompactP7Facts(delegationState = delegationSession.getState()): void {
		const now = new Date().toISOString();
		const actor = detectActorRole({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		});
		const policy = defaultWritePolicy(currentModelFacts.provider, currentModelFacts.model);
		compactState.writePolicy = policy ?? undefined;
		compactState.commanderWritesDenied =
			actor === "sol-commander" ? leaseStatus(writeLease, now) !== "active" : undefined;
		compactState.lastDelegationId = delegationState.latestId;
		compactState.pendingDelegationReview =
			delegationState.latestId !== undefined && (hasPendingReview(delegationState) || hasStaleReview(delegationState))
				? true
				: undefined;
		compactState.reviewedDiffHash = delegationState.reviewedDiffHash;
		compactState.activeWriteLease = writeLease ? leaseCompactSummary(writeLease, now) : undefined;
		compactState.blockedCommanderWriteAttempts =
			delegationState.blockedWriteAttempts > 0 ? delegationState.blockedWriteAttempts : undefined;
		compactState.nextDelegationAction =
			actor === "sol-commander" || delegationState.latestId !== undefined
				? delegationNextActionTextV1(delegationState, latestRepairStatus)
				: undefined;
		touchCompactState();
	}

	const delegationSession = createDelegationSessionController({
		exec: execFn,
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
		onStateChanged: refreshCompactP7Facts,
	}, RUNTIME_CONTROLLER_SERVICES.delegationSession);

	/** Build gate facts from explicit state and an injected current binding. */
	async function buildWorkerFirstGateFactsFromState(
		projectRoot: string,
		state: DelegationState,
		injectedCurrentDiffHash: string | null,
		now: string,
	): Promise<WorkerFirstGateFacts> {
		const actor = detectActorRole({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		});
		const policy = defaultWritePolicy(currentModelFacts.provider, currentModelFacts.model);
		const leaseNow = leaseStatus(writeLease, now);
		return buildDelegationWorkerFirstGateFacts({
			projectRoot, state, currentDiffHash: injectedCurrentDiffHash,
			reviewBlock: delegationSession.projectAuthorityBlockReason("verify") ?? reviewBlockReason(state, "verify"),
			runtime: {
				actor, writePolicy: policy ?? null,
				commanderWritesDenied: actor === "sol-commander" ? leaseNow !== "active" : null,
				leaseStatus: leaseNow, leaseReason: writeLease?.reason ?? null,
				leaseCallsUsed: writeLease?.callsUsed ?? 0, leaseMaxCalls: writeLease?.maxCalls ?? 0,
				gateRunInitiatedByCommander: actor === "sol-commander",
			},
		});
	}

	/** Mutating gate path: refresh and persist the current authority binding. */
	async function buildWorkerFirstGateFacts(projectRoot: string, now: string): Promise<WorkerFirstGateFacts> {
		await delegationSession.reconcileProjectAuthority(projectRoot, now);
		const hash = await delegationSession.collectCurrentDiffHash(projectRoot);
		if (hash === null) {
			return buildWorkerFirstGateFactsFromState(projectRoot, delegationSession.getState(), null, now);
		}
		const observed = observeDiffChange(delegationSession.getState(), hash, now);
		delegationSession.setState(observed);
		delegationSession.persistBestEffort();
		return buildWorkerFirstGateFactsFromState(projectRoot, observed, observed.currentDiffHash ?? null, now);
	}

	/** Read-only gate projection; collection failure leaves the current hash missing. */
	async function buildReadOnlyWorkerFirstGateFacts(projectRoot: string, now: string): Promise<WorkerFirstGateFacts> {
		const hash = await delegationSession.collectCurrentDiffHash(projectRoot);
		if (hash === null) {
			return buildWorkerFirstGateFactsFromState(projectRoot, delegationSession.getState(), null, now);
		}
		const projected = observeDiffChange(delegationSession.getState(), hash, now);
		return buildWorkerFirstGateFactsFromState(projectRoot, projected, projected.currentDiffHash ?? null, now);
	}

	function applyModeTools(): void {
		const actorFacts = {
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		};
		const leaseTools =
			writeLease && leaseStatus(writeLease, new Date().toISOString()) === "active" ? [...writeLease.tools] : [];
		pi.setActiveTools(
			computeRoleActiveTools(
				computeActiveTools(mode, pi.getActiveTools(), actorFacts, leaseTools),
				workerRoleContext.role,
				workerRoleContext.taskKind,
			),
		);
	}

	/** Reapply the locked 16-tool surface when a temporary lease is no longer active. */
	function syncLeaseLock(now?: string): void {
		if (writeLease && leaseStatus(writeLease, now ?? new Date().toISOString()) !== "active") {
			applyModeTools();
		}
	}

	/** Refresh the bounded status line from persisted project/session facts. */
	async function refreshStatus(ctx: ExtensionContext, pendingMessage?: unknown): Promise<void> {
		const refreshSerial = ++uiRefreshSerial.status;
		// No status bar exists in print/json modes; skip silently.
		if (ctx.mode === "print" || ctx.mode === "json") return;
		let line = statusText(mode);
		let advisoryConfig: AdvisoryConfig | undefined;
		try {
			if (ctx.isProjectTrusted()) {
				const projectRoot = await projectRootFor(ctx);
				if (refreshSerial !== uiRefreshSerial.status) return;
				const repairStatus = delegationProjectIssueRepairStatusV1(delegationSession.getProjectAuthorityIssue()) ?? await readDelegationRepairStatusV1(projectRoot, delegationSession.getState(), execFn);
				if (refreshSerial !== uiRefreshSerial.status) return;
				latestRepairStatus = repairStatus;
				refreshCompactP7Facts();
				const config = await loadProjectConfig(projectRoot, { trusted: true });
				if (refreshSerial !== uiRefreshSerial.status) return;
				advisoryConfig = config.commanderAdvisory;
				cacheTelemetry.setEnabled(config.cacheTelemetry);
				cacheTelemetry.setProjectRoot(projectRoot);
				const gate = await latestGateRunSummary(projectRoot);
				if (refreshSerial !== uiRefreshSerial.status) return;
				const runs = await listRuns(projectRoot, 1);
				if (refreshSerial !== uiRefreshSerial.status) return;
				const latestRun = runs[0];
				line = buildStatusLine({
					mode,
					profile: config.profile,
					activeGate: gate?.worst_gate ? { id: gate.worst_gate.id, status: gate.worst_gate.status, run_id: gate.run_id } : undefined,
					latestRun: latestRun
						? { run_id: latestRun.run_id, status: runStatusLabel(latestRun), ok: runStatusLabel(latestRun) === "OK" }
						: undefined,
				});
			}
		} catch {
			// keep the mode-only fallback line
		}
		if (refreshSerial !== uiRefreshSerial.status) return;
		const cacheSegment = cacheTelemetry.statusSegment();
		if (cacheSegment) line = line ? `${line} | ${cacheSegment}` : cacheSegment;
		const breakdown = runtimeCostBreakdown.read(ctx.sessionManager.getEntries(), pendingMessage);
		const costSegment = costStatusSegment(breakdown);
		if (costSegment) line = line ? `${line} | ${costSegment}` : costSegment;
		const advisorySegment = advisoryStatusSegment(evaluateAdvisory(breakdown, advisoryConfig));
		if (advisorySegment) line = line ? `${line} | ${advisorySegment}` : advisorySegment;
		const outputAdvisorySegment = contextOutputAdvisoryStatusSegment(ensureOutputControlTelemetry().snapshot().advisory);
		if (outputAdvisorySegment) line = line ? `${line} | ${outputAdvisorySegment}` : outputAdvisorySegment;
		const driftSegment = workerRoleContext.role === "worker" ? null : solCommanderDriftStatus({
			provider: ctx.model?.provider ?? currentModelFacts.provider,
			model: ctx.model?.id ?? currentModelFacts.model,
			reasoning: ctx.thinkingLevel ?? currentModelFacts.thinking ?? pi.getThinkingLevel(),
		});
		if (driftSegment) line = line ? `${line} | ${driftSegment}` : driftSegment;
		syncLeaseLock();
		const actor = detectActorRole({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		});
		const policy = defaultWritePolicy(currentModelFacts.provider, currentModelFacts.model);
		const writeSegment = writeAuthorityFooterSegment({
			actor,
			policy,
			lease: writeLease,
			now: new Date().toISOString(),
		});
		if (writeSegment) line = line ? `${line} | ${writeSegment}` : writeSegment;
		const delegationState = delegationSession.getState();
		if (hasPendingReview(delegationState) || hasStaleReview(delegationState)) {
			line = line ? `${line} | WF:REVIEW` : "WF:REVIEW";
		}
		if (refreshSerial === uiRefreshSerial.status) ctx.ui.setStatus(STATUS_KEY, line);
	}

	/** P6-A: keep the telemetry enable flag in sync with project.yaml (opt-out). */
	async function refreshCacheConfig(ctx: ExtensionContext): Promise<void> {
		try {
			if (!ctx.isProjectTrusted()) {
				cacheTelemetry.setEnabled(false);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const config = await loadProjectConfig(projectRoot, { trusted: true });
			cacheTelemetry.setEnabled(config.cacheTelemetry);
		} catch {
			// default on — telemetry is best-effort, hashed and content-free numeric
			cacheTelemetry.setEnabled(true);
		}
	}

	// ------------------------------------------------------------------ widget

	const WIDGET_KEY = "workbench";
	let widgetForced = false;
	let widgetTask: string | undefined;
	let widgetPhase: string | undefined;

	/** Collect the widget facts (latest gate run + latest run) from disk. */
	async function collectWidgetState(ctx: ExtensionContext): Promise<WidgetState> {
		const state: WidgetState = {
			task: widgetTask,
			phase: widgetPhase,
			taskActive: widgetTask !== undefined,
			gateFailed: false,
			forced: widgetForced,
		};
		try {
			if (!ctx.isProjectTrusted()) return state;
			const projectRoot = await projectRootFor(ctx);
			const gate = await latestGateRunSummary(projectRoot);
			if (gate) {
				state.gateFailed = gate.status !== "PASS";
				state.activeGate = gate.worst_gate
					? `${gate.worst_gate.id} ${gate.worst_gate.status} (run ${gate.run_id})`
					: `all ${gate.status} (run ${gate.run_id})`;
				state.blockingReason = gate.blocking_reason ?? undefined;
			}
			const runs = await listRuns(projectRoot, 1);
			const latest = runs[0];
			if (latest) {
				state.lastRun = `run:${latest.run_id} ${latest.recipe} exit=${latest.exit_code ?? "killed"} ${runStatusLabel(latest)}`;
			}
		} catch {
			// minimal state (task/phase only)
		}
		return state;
	}

	/**
	 * Show/hide the widget per the P4 rules. Never touches the UI without
	 * `ctx.hasUI` (print/json are no-ops).
	 */
	async function refreshWidget(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const refreshSerial = ++uiRefreshSerial.widget;
		const state = await collectWidgetState(ctx);
		if (refreshSerial !== uiRefreshSerial.widget) return;
		const action = widgetAction(state, ctx.hasUI);
		if (action === "show") {
			ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(state, { width: 96 }));
		} else if (action === "hide") {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	}

	function setMode(next: WorkbenchMode, ctx: ExtensionContext, label: string): void {
		// P7: leaving DEV revokes any temporary commander write lease (the
		// policy requires revocation on mode change; expiry/exhaustion are
		// statuses that surface through leaseStatus instead).
		if (next !== "DEV" && writeLease) {
			const now = new Date().toISOString();
			const reason = leaseRevokeReason(writeLease, {
				mode: next,
				provider: currentModelFacts.provider,
				model: currentModelFacts.model,
			});
			if (reason) {
				writeLease = revokeLease(writeLease, reason, now);
				persistLease();
			}
		}
		mode = next;
		cacheTelemetry.observeModeChange(next);
		pi.appendEntry(MODE_ENTRY_TYPE, { mode });
		applyModeTools();
		const text = `${label}: ${describeMode(mode)}`;
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
		} else {
			// print/json modes: visible stdout fallback.
			console.log(text);
		}
		void refreshStatus(ctx);
	}

	function output(ctx: ExtensionCommandContext, lines: string[]): void {
		const text = lines.join("\n");
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
		} else {
			// print/json modes: fall back to stdout so /q-* still works.
			console.log(text);
		}
	}

	function trustedOrError(ctx: ExtensionContext): string | undefined {
		if (!ctx.isProjectTrusted()) {
			return "project is not trusted — workbench will not read or run its configuration. Exit Pi, re-enter the project, and approve project trust first.";
		}
		return undefined;
	}

	async function projectRootFor(ctx: ExtensionContext): Promise<string> {
		return findProjectRoot(ctx.cwd, execFn);
	}

	function runsDirFor(projectRoot: string): string {
		return join(projectRoot, CONFIG_DIR_NAME, "workbench", "runs");
	}

	/**
	 * P7: refresh the delegation state against its tagged current binding, then build
	 * the status lines (actor, policy, lease, latest delegation, review
	 * status, hashes, blocked write attempts, latest review verdict). Relevant
	 * or unknown-origin new-v2 drift, or any legacy full-diff change, turns a
	 * REVIEWED delegation STALE here.
	 *
	 * Fail closed: when the authority-specific binding cannot be collected, the
	 * authoritative delegation state stays untouched (no observe, no
	 * persist) and the report VISIBLY marks the real-git refresh
	 * UNAVAILABLE — the persisted hashes are never presented as freshly
	 * verified.
	 */
	async function delegationStatusLines(projectRoot: string): Promise<{ lines: string[]; gitRefresh: "fresh" | "unavailable" }> {
		const now = new Date().toISOString();
		let gitRefresh: "fresh" | "unavailable" = "fresh";
		await delegationSession.reconcileProjectAuthority(projectRoot, now);
		latestRepairStatus = delegationProjectIssueRepairStatusV1(delegationSession.getProjectAuthorityIssue()) ?? await readDelegationRepairStatusV1(projectRoot, delegationSession.getState(), execFn);
		refreshCompactP7Facts();
		try {
			if (delegationSession.getProjectAuthorityIssue() !== undefined) throw new Error("project authority unavailable");
			const binding = await delegationSession.collectCurrentBinding(projectRoot);
			if (binding.status === "unavailable") throw new Error("delegation binding unavailable");
			delegationSession.setState(observeDiffChange(delegationSession.getState(), binding.hash, now));
			delegationSession.persistBestEffort();
		} catch {
			// Real-git refresh unavailable: the in-memory/persisted
			// authoritative state is left untouched and reported as NOT
			// freshly verified (never silently presented as fresh).
			gitRefresh = "unavailable";
		}
		const actor = detectActorRole({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		});
		const policy = defaultWritePolicy(currentModelFacts.provider, currentModelFacts.model);
		const lines = [
			`actor        : ${actor} (${currentModelFacts.provider ?? "(none)"}/${currentModelFacts.model ?? "(none)"})`,
			`write policy : ${policy ?? "not-applicable"}`,
			`write lease  : ${leaseCompactSummary(writeLease, now)}`,
		];
		const delegationProjectAuthorityIssue = delegationSession.getProjectAuthorityIssue();
		const delegationState = delegationSession.getState();
		if (delegationProjectAuthorityIssue !== undefined) {
			lines.push(
				`project auth : INVALID (${delegationProjectAuthorityIssue.code}) — delegation and verification fail closed`,
				`latest       : ${delegationProjectAuthorityIssue.delegationId ?? delegationState.latestId ?? "(unknown)"} PROJECT_AUTHORITY_INVALID`,
				`blocked writes: ${delegationState.blockedWriteAttempts}`,
			);
		} else if (delegationState.latestId !== undefined) {
			const authority = await readDelegationAuthorityObservation(projectRoot, delegationState.latestId);
			const displayedStatus = delegationDisplayedStatusV1(delegationState.status, authority.kind === "v2" ? authority.transactionStatus : undefined);
			lines.push(
				`latest       : ${delegationState.latestId} ${displayedStatus}`,
				`current hash : ${delegationState.currentDiffHash ?? "(none)"}`,
				`reviewed hash: ${delegationState.reviewedDiffHash ?? "(none)"}`,
				`blocked writes: ${delegationState.blockedWriteAttempts}`,
			);
			lines.push(...delegationRepairStatusLinesV1(latestRepairStatus));
			const block = authority.kind === "v2" && !["PENDING_REVIEW", "REVIEWED"].includes(authority.transactionStatus)
				? undefined
				: reviewBlockReason(delegationState, "delegation");
			const finalizedReviewedStaleSuccessor = delegationState.status === "STALE" && authority.kind === "v2"
				&& authority.transactionStatus === "REVIEWED" && authority.finalized
				&& authority.review?.verdict === "PASS" && authority.semanticAccepted;
			if (block && !finalizedReviewedStaleSuccessor) lines.push(`blocked      : ${block}`);
			if (block && finalizedReviewedStaleSuccessor) {
				lines.push(
					"successor    : ALLOWED after live revalidation — prior v2 review has strict semantic authority; a fresh delegation adopts the current workspace as its new baseline",
					"verify block : VERIFY remains blocked until the fresh successor is reviewed",
				);
			}
			if (authority.kind === "invalid-v2") {
				const recoverable = authority.code === "invalid_record"
					? await readRecoverableUnpublishedDelegationV2(projectRoot, delegationState.latestId)
					: undefined;
				if (recoverable?.ok) {
					lines.push(
						"authority v2 : RECOVERABLE_UNPUBLISHED (RECOVERY_REQUIRED; committed proof absent)",
					);
					if (latestRepairStatus.kind !== "delegation_retry") {
						lines.push(`next action  : call workbench_delegate_worker with repair_of=${delegationState.latestId}; do not retry review`);
					}
				} else {
					lines.push(`authority v2 : INVALID (${authority.code}) — legacy fallback refused`);
				}
			} else if (authority.kind === "legacy" && authority.review) {
				const review = authority.review;
				lines.push(
					`review       : ${review.verdict} at ${review.reviewed_at}${review.mismatch ? " (MISMATCH: current diff differs from the recorded after hash)" : ""}`,
					`review bound : ${review.bound_diff_hash}`,
				);
			} else if (authority.kind === "v2") {
				const recoverable = authority.transactionStatus === "RECOVERY_REQUIRED" && authority.repairLineage === undefined
					? await readRecoverableUnpublishedDelegationV2(projectRoot, delegationState.latestId)
					: undefined;
				if (recoverable?.ok) {
					lines.push("authority v2 : RECOVERABLE_UNPUBLISHED (RECOVERY_REQUIRED; committed proof absent)");
					if (latestRepairStatus.kind !== "delegation_retry") {
						lines.push(`next action  : call workbench_delegate_worker with repair_of=${delegationState.latestId}; do not retry review`);
					}
				} else {
					lines.push(`authority v2 : transaction ${authority.transactionStatus}`);
					if (authority.review) {
						lines.push(
							`review v2    : ${authority.review.verdict} at ${authority.review.reviewed_at}${authority.finalized ? " (FINAL)" : " (PROVISIONAL)"}`,
							`review path  : ${authority.reviewPath ?? "(none)"}`,
							`review bound : ${authority.review.bound_diff_hash}`,
						);
						const strictSemantic = authority.finalized && authority.semanticAccepted;
						if (authority.finalized && !strictSemantic) lines.push(
							"semantic v2  : MISSING — historical scope/integrity FINAL is not hash-bound Sol ACCEPT",
							authority.review.schema_version === 2 ? "next action  : call workbench_review_worker_diff without a decision; inspect the migration packet, then ACCEPT both displayed hashes" : "next action  : legacy schema-1 FINAL has no automatic semantic migration and remains blocked",
						);
						else if (authority.semanticSource === "migration") lines.push(`semantic v2  : ACCEPT (migration) by ${authority.semanticReviewer} at ${authority.semanticAcceptedAt}`, `reviewed bind : ${authority.semanticBindingHash}`);
						else if (authority.semanticSource === "embedded") lines.push(`semantic v2  : ACCEPT by ${authority.semanticReviewer} at ${authority.semanticAcceptedAt}`);
						else if (strictSemantic) lines.push("semantic v2  : NOT_REQUIRED (zero delta)");
					} else if (authority.transactionVerdict !== null) {
						lines.push(`completion v2: ${authority.transactionVerdict} (strict terminal machine facts; no review artifact)`);
						if (authority.repairLineage === undefined && authority.transactionStatus === "ABORTED") {
							lines.push("next action  : start a fresh delegation; the terminal before-worker transaction needs no review");
						}
					} else {
						lines.push(`review v2    : NOT_RUN`);
					}
				}
			}
		} else {
			latestRepairStatus = { kind: "none" };
			lines.push(`latest       : (no delegation)`);
			lines.push(`blocked writes: ${delegationState.blockedWriteAttempts}`);
		}
		if (gitRefresh === "unavailable") {
			lines.push(`git refresh  : UNAVAILABLE — git status failed; the hashes above are persisted state, NOT freshly verified`);
		}
		return { lines, gitRefresh };
	}

	// -------------------------------------------------------------- lifecycle

	pi.on("session_start", async (event, ctx) => {
		transientState.resetTrustedIngressAuthorities();
		workerBudgetSteerSent = false;
		// Restore the most recent persisted mode and workbench state from the
		// current session's custom entries. Custom entries survive compaction
		// and every session-replacement path (/new, /resume, /fork, /clone,
		// /reload all reach this handler via session_start); /new starts a
		// fresh session file, so it falls back to the DEV default.
		const entries = ctx.sessionManager.getEntries();
		pendingRetryCompactNote = undefined;
		retryCompactNoteReady = false;
		workbenchOverflowCompactRequested = false;
		overflowRecoveryAttempted = false;
		overflowFollowUpPending = false;
		pendingOverflowRecoveryContext = undefined;
		nativeOverflowCompactStarted = false;
		latestHistoryProjectionBoundaryMarkers = [];
		mode = loadModeFromEntries(entries);
		compactState = loadCompactStateFromEntries(entries, mode);
		reconcileCompactAttempt(entries, event.reason);
		// Restore delegation state. A confirmed write lease never crosses a
		// session_start boundary without a fresh user grant: this also prevents a
		// failed append from reviving an older active entry on reload.
		delegationSession.restore(entries);
		writeLease = loadLeaseFromEntries(entries);
		const selectedThinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
		currentModelFacts = ctx.model
			? { provider: ctx.model.provider, model: ctx.model.id, thinking: selectedThinking }
			: { thinking: selectedThinking };
		if (event.reason === "new" || event.reason === "fork") {
			resetHistoryProjection();
			persistHistoryProjectionState();
			persistContextPressure();
		} else {
			historyProjectionController.restoreFromEntries(entries);
		}
		// Restore only the latest strict numeric/fixed-enum snapshot for the
		// resolved role. Malformed matching entries reset the accumulator.
		outputControlTelemetry = undefined;
		outputControlTelemetryRole = undefined;
		ensureOutputControlTelemetry(entries);
		mirrorOutputControlCompactFacts();
		if (writeLease) {
			const now = new Date().toISOString();
			const reason = leaseRevokeReason(writeLease, {
				mode,
				provider: currentModelFacts.provider,
				model: currentModelFacts.model,
			}) ?? (leaseStatus(writeLease, now) === "active" ? "session restoration requires a fresh write lease" : undefined);
			if (reason) {
				writeLease = revokeLease(writeLease, reason, now);
				persistLease();
			}
		}
		try { if (!ctx.isProjectTrusted()) throw new Error("untrusted project");
			const projectRoot = await projectRootFor(ctx);
			await delegationSession.reconcileProjectAuthority(projectRoot, new Date().toISOString());
			latestRepairStatus = delegationProjectIssueRepairStatusV1(delegationSession.getProjectAuthorityIssue()) ?? await readDelegationRepairStatusV1(projectRoot, delegationSession.getState(), execFn);
			refreshCompactP7Facts();
		} catch {
			// Project discovery is retried at every project-authority consumer.
			// A non-project session start must not invent an invalid authority.
			latestRepairStatus = { kind: "none" };
			delegationSession.clearProjectAuthorityIssue();
		}
		// P7 slice 3: mirror the restored authority facts into the compaction
		// state (fresh derivation — the mirror never overrides the restored
		// lease/delegation entries, which stay authoritative).
		refreshCompactP7Facts();
		applyModeTools();

		// P6-A: restore the cache telemetry summary and lifecycle reasons.
		const sessionId = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId() ?? ctx.cwd;
		cacheTelemetry.setSessionId(sessionId);
		cacheTelemetry.setMode(mode);
		cacheTelemetry.setThinkingLevel(selectedThinking);
		cacheTelemetry.restoreFromEntries(entries);
		if (event.reason === "reload") cacheTelemetry.observeReload();
		if (event.reason === "new") cacheTelemetry.observeNewSession();
		if (ctx.model) {
			cacheTelemetry.observeModelChange({ provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api });
		}

		void refreshCacheConfig(ctx);
		void refreshStatus(ctx);
		void refreshWidget(ctx); // a previously failed gate keeps the widget visible
	});

	pi.on("session_compact", (event) => {
		finishActiveCompactAttempt("completed");
		cacheTelemetry.observeCompaction();
		if (event.reason === "overflow" && event.willRetry) {
			pendingOverflowRecoveryContext = undefined;
			nativeOverflowCompactStarted = false;
		}
		retryCompactNoteReady = event.willRetry && pendingRetryCompactNote !== undefined;
		transientState.resetTrustedIngressAuthorities();
		resetHistoryProjection();
		persistHistoryProjectionState();
		persistContextPressure();
	});

	pi.on("session_tree", () => {
		transientState.resetTrustedIngressAuthorities();
		resetHistoryProjection();
		persistHistoryProjectionState();
		persistContextPressure();
		cacheTelemetry.observeSessionTreeChange();
	});

	// ----------------------------------------------------- P5 compaction

	// Workers always cancel before reading preparation. Commander compaction
	// keeps Pi's native summarizer unless a content-free capacity preflight
	// conservatively estimates one of its provider request envelopes at or
	// above the model window. This is an engineering guard, not a tokenizer proof.
	// The workbench never replaces Pi's summary.
	pi.on("session_before_compact", (event, ctx) => {
		pendingRetryCompactNote = undefined;
		retryCompactNoteReady = false;
		if (event.reason === "overflow" && pendingOverflowRecoveryContext !== undefined) {
			nativeOverflowCompactStarted = true;
		}
		beginCompactAttempt(event.reason, event.willRetry);
		// Worker role only: a delegated worker must never silently continue
		// through lossy compaction — cancel it and let the runner's pinned
		// budget policy decide the outcome. This check must remain before any
		// access to event.preparation.
		if (workerRoleContext.role === "worker") {
			finishActiveCompactAttempt("cancelled");
			return { cancel: true };
		}

		const preflight = evaluateCompactSummaryPreflight({
			preparation: event.preparation,
			model: ctx.model,
			customInstructions: event.customInstructions,
		});
		if (preflight.verdict === "block") {
			const notice = `Commander compaction blocked by summary-capacity preflight: summary request envelope ${preflight.worstRequestEnvelopeTokens}/${preflight.contextWindowTokens} tokens. No summary provider call was made. Use /q-milestone-handoff <next step>.`;
			if (ctx.hasUI) ctx.ui.notify(notice, "warning");
			else console.warn(notice);
			finishActiveCompactAttempt("cancelled");
			return { cancel: true };
		}
		if (preflight.verdict === "warn") {
			const notice = `Commander compaction preflight warning: summary request envelope ${preflight.worstRequestEnvelopeTokens}/${preflight.contextWindowTokens} tokens; native Pi compaction will continue.`;
			if (ctx.hasUI) ctx.ui.notify(notice, "warning");
			else console.warn(notice);
		}
		if (!shouldSupplement(compactState)) {
			pendingRetryCompactNote = undefined;
			return undefined;
		}
		const note = buildCompactNote(compactState);
		persistCompactState();
		if (event.willRetry) {
			pendingRetryCompactNote = { content: note, updatedAt: compactState.updatedAt };
			retryCompactNoteReady = false;
			return undefined;
		}
		pendingRetryCompactNote = undefined;
		if (note === lastCompactNote) return undefined;
		lastCompactNote = note;
		try {
			pi.sendMessage(
				{
					customType: COMPACT_NOTE_MESSAGE_TYPE,
					content: note,
					display: false,
					details: { updated_at: compactState.updatedAt },
				},
				{ deliverAs: "nextTurn" },
			);
		} catch {
			// print/json modes: the durable state entry above is the fallback
		}
		return undefined;
	});

	// -------------------------------------------------------- widget events

	pi.on("turn_start", (event) => {
		currentTurnSerial = event.turnIndex;
		transientState.resetTurn();
		pendingReceiptHandles.clear();
		turnOutputBudget.startTurn({ turnSerial: event.turnIndex, role: outputTurnRole() });
		ensureOutputControlTelemetry();
	});

	pi.on("turn_end", () => {
		const telemetry = turnOutputBudget.endTurn();
		try {
			pi.appendEntry(OUTPUT_TURN_TELEMETRY_ENTRY_TYPE, {
				role: telemetry.role,
				planning: telemetry.planned ? "planned" : "dynamic",
				turnSerial: telemetry.turnSerial,
				maxBytes: telemetry.maxBytes,
				reservationCount: telemetry.reservationCount,
				blockedCalls: telemetry.blockedCalls,
				consumedCalls: telemetry.consumedCalls,
				releasedCalls: telemetry.releasedCalls,
				reservedBytes: telemetry.reservedBytes,
				consumedBytes: telemetry.consumedBytes,
				controlConsumedBytes: telemetry.controlConsumedBytes,
				totalAccountedBytes: telemetry.totalAccountedBytes,
				releasedBytes: telemetry.releasedBytes,
				unusedBytes: telemetry.unusedBytes,
			});
		} catch {
			// Legacy per-turn observation persistence is best-effort.
		}
		try {
			ensureOutputControlTelemetry().recordTurn(telemetry);
			mirrorOutputControlCompactFacts();
			persistOutputControlTelemetry();
		} catch {
			// Session telemetry persistence is advisory and never breaks closure.
		}
		persistHistoryProjectionState();
		persistContextPressure();
		transientState.resetTurn();
		pendingReceiptHandles.clear();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// P7: lazy lease-lock sync before every agent turn — an
		// expired/exhausted lease is reverted to the exact canonical 15
		// before the model can see stale edit/write tools. No timers or
		// background resources.
		syncLeaseLock();
		// P7 slice 3: keep the compaction mirror fresh at every turn start.
		refreshCompactP7Facts();
		const promptTask = fitToWidth(event.prompt.trim().replace(/\s+/g, " ").slice(0, 120), 96);
		widgetTask = promptTask || "active task";
		widgetPhase = "planning";
		compactState.task = widgetTask;
		compactState.phase = "planning";
		if (!overflowFollowUpPending && promptTask) {
			compactState.objective = promptTask;
			compactState.nextStep = `continue "${promptTask}"`;
		}
		overflowFollowUpPending = false;
		touchCompactState();
		void refreshWidget(ctx);
		if (retryCompactNoteReady && pendingRetryCompactNote) {
			const note = pendingRetryCompactNote;
			pendingRetryCompactNote = undefined;
			retryCompactNoteReady = false;
			return {
				message: {
					customType: COMPACT_NOTE_MESSAGE_TYPE,
					content: note.content,
					display: false,
					details: { updated_at: note.updatedAt },
				},
			};
		}
		return undefined;
	});

	pi.on("agent_end", (event, ctx) => {
		let assistant: unknown;
		for (let index = event.messages.length - 1; index >= 0 && index >= event.messages.length - 256; index -= 1) {
			const candidate = event.messages[index];
			if (ownDataValue(candidate, "role") === "assistant") {
				assistant = candidate;
				break;
			}
		}
		const stopReason = ownDataValue(assistant, "stopReason");
		if (stopReason !== "error") {
			if (stopReason === "stop") {
				overflowRecoveryAttempted = false;
				pendingOverflowRecoveryContext = undefined;
				nativeOverflowCompactStarted = false;
			}
			return;
		}
		const errorMessage = ownDataValue(assistant, "errorMessage");
		if (typeof errorMessage !== "string") return;
		const decision = decideCompactOverflowRecovery(errorMessage, overflowRecoveryAttempted);
		if (!decision.classification) return;
		if (!decision.recover) {
			pendingOverflowRecoveryContext = undefined;
			nativeOverflowCompactStarted = false;
			requireMilestoneHandoff(ctx, "A second explicit context overflow was detected.");
			return;
		}
		overflowRecoveryAttempted = decision.recoveryAttempted;
		compactState.nextStep = "compact once, then continue the preserved objective";
		touchCompactState();
		persistCompactState();
		// Pi 0.84.2 runs its native overflow recovery immediately after
		// agent_end. Defer the workbench fallback until agent_settled so
		// ctx.compact() cannot deadlock on waitForIdle or race a native compact.
		pendingOverflowRecoveryContext = ctx;
		nativeOverflowCompactStarted = false;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		widgetTask = undefined;
		widgetPhase = undefined;
		compactState.task = undefined;
		compactState.phase = undefined;
		touchCompactState();
		void refreshWidget(ctx);

		const recoveryCtx = pendingOverflowRecoveryContext;
		if (!recoveryCtx) return;
		pendingOverflowRecoveryContext = undefined;
		if (nativeOverflowCompactStarted) {
			nativeOverflowCompactStarted = false;
			finishActiveCompactAttempt("failed");
			requireMilestoneHandoff(recoveryCtx, "Pi's native overflow compact started but did not complete; no second automatic compact will be attempted.");
			return;
		}
		workbenchOverflowCompactRequested = true;
		let callbackFinished = false;
		try {
			recoveryCtx.compact({
				customInstructions: "Preserve the durable workbench objective and next action as bounded pointers.",
				onComplete: () => {
					if (callbackFinished) return;
					callbackFinished = true;
					compactState.nextStep = compactState.objective
						? `continue "${compactState.objective}"`
						: "continue the preserved objective";
					touchCompactState();
					persistCompactState();
					overflowFollowUpPending = true;
					try {
						pi.sendMessage({
							customType: COMPACT_NOTE_MESSAGE_TYPE,
							content: `${buildCompactNote(compactState)}\ncontext recovery: one compact completed; continue now. On another overflow, stop and use /q-milestone-handoff.`,
							display: false,
							details: { recovery: "context-window-overflow", attempt: "one" },
						}, { deliverAs: "followUp", triggerTurn: true });
					} catch {
						requireMilestoneHandoff(recoveryCtx, "The compact succeeded but its continuation could not be queued.");
					}
				},
				onError: () => {
					if (callbackFinished) return;
					callbackFinished = true;
					workbenchOverflowCompactRequested = false;
					finishActiveCompactAttempt("failed");
					requireMilestoneHandoff(recoveryCtx, "The one automatic compact attempt failed.");
				},
			});
		} catch {
			workbenchOverflowCompactRequested = false;
			finishActiveCompactAttempt("failed");
			requireMilestoneHandoff(recoveryCtx, "The one automatic compact attempt could not start.");
		}
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!event.toolName.startsWith("workbench_")) return;
		widgetPhase = `running ${event.toolName}`;
		compactState.phase = widgetPhase;
		touchCompactState();
		void refreshWidget(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!event.toolName.startsWith("workbench_")) return;
		widgetPhase = `finished ${event.toolName}`;
		compactState.phase = widgetPhase;
		const details = (event.result as { details?: unknown } | undefined)?.details;
		if (details && typeof details === "object" && !Array.isArray(details)) {
			const record = details as Record<string, unknown>;
			if (event.toolName === "workbench_delegate_worker") {
				for (const path of summarizeReviewedWorkerChangedPaths({
					reviewStatus: record.review_status,
					changedPaths: record.changed_paths,
				})) {
					compactState.modifiedFiles = pushBounded(compactState.modifiedFiles, path, MAX_MODIFIED_FILES);
				}
			}
			const runId = typeof record.run_id === "string" ? record.run_id : undefined;
			if (runId) {
				compactState.lastRunId = runId;
				if (typeof record.recipe === "string") compactState.lastRecipe = record.recipe;
				const evidencePath = `.pi/workbench/runs/${runId}`;
				compactState.evidencePaths = pushBounded(compactState.evidencePaths, evidencePath, MAX_EVIDENCE_PATHS);
					if (event.toolName === "workbench_run_gate" && Array.isArray(record.gates)) {
						// R6: tool_execution_end receives the projected, bounded DTO.
						// Consume only its finite status summary; never depend on gates_full
						// or a domain GateRunEntry/check/evidence structure.
						for (const g of (record.gates as Array<{ id?: unknown; status?: unknown }>).slice(0, 32)) {
							const id = typeof g.id === "string" ? g.id : "?";
						if (g.status === "PASS") compactState.passedGates = pushBounded(compactState.passedGates, id, MAX_GATES);
						else if (g.status === "FAIL") compactState.failedGates = pushBounded(compactState.failedGates, `${id} (run ${runId})`, MAX_GATES);
						else if (g.status === "BLOCKED") compactState.blockedGates = pushBounded(compactState.blockedGates, `${id} (run ${runId})`, MAX_GATES);
					}
				}
				rememberRunOutcome(event.toolName, record);
			}
		}
		touchCompactState();
		void refreshStatus(ctx);
		void refreshWidget(ctx);
	});

	// ------------------------------------------------------- P6-A cache events

	// Model/thinking/mode changes are the strongest (explicit) invalidation
	// signals; the next message_end classifies them as such.
	pi.on("model_select", (event, ctx) => {
		cacheTelemetry.observeModelChange({ provider: event.model.provider, id: event.model.id, api: event.model.api });
		// P7: the actor identity (and with it the strict Sol DEV tool set and
		// the write lease validity) follows the provider/model pair — update
		// the facts, revoke a lease bound to a different commander identity,
		// and recompute the active tool set.
		currentModelFacts = { ...currentModelFacts, provider: event.model.provider, model: event.model.id };
		if (writeLease) {
			const now = new Date().toISOString();
			const reason = leaseRevokeReason(writeLease, {
				mode,
				provider: currentModelFacts.provider,
				model: currentModelFacts.model,
			});
			if (reason) {
				writeLease = revokeLease(writeLease, reason, now);
				persistLease();
			}
		}
		applyModeTools();
		void refreshStatus(ctx);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		cacheTelemetry.observeThinkingChange(event.level);
		currentModelFacts = { ...currentModelFacts, thinking: event.level };
		void refreshStatus(ctx);
	});

	// Pi 0.84.2 calls `context` before constructing every provider request. It
	// structured-clones the active messages first, so this replacement affects
	// only the outgoing copy and can never rewrite session entries. The handler
	// catches its own failures because Pi otherwise swallows an extension error
	// and continues with the unprojected (raw) context.
	pi.on("context", (event) => {
		const role = outputTurnRole();
		const maxToolTextBytes = role === "commander"
			? COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES
			: role === "worker"
				? WORKER_HISTORY_TOOL_TEXT_MAX_BYTES
				: OTHER_HISTORY_TOOL_TEXT_MAX_BYTES;
		try {
			const projection = historyProjectionController.project({
				messages: event.messages,
				maxToolTextBytes,
				maxBundles: HISTORY_MAX_BUNDLES,
				descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
				role,
			});
			cacheTelemetry.observeContextProjection({
				actorRoleCode: cacheActorRoleCode(role),
				historyProjection: cacheHistoryProjectionInput(projection.observability),
			});
			latestHistoryProjectionFacts = { ...projection.facts };
			latestHistoryProjectionBoundaryMarkers = projection.boundaryMarkers.map((boundary) => boundary.marker);
			latestHistoryPressure = {
				epoch: projection.epoch,
				rawBundleCount: projection.rawBundleCount,
				hardHistoryBytes: maxToolTextBytes,
				hardBundleCount: HISTORY_MAX_BUNDLES,
			};
			ensureOutputControlTelemetry().recordHistory({
				...projection.facts,
				collapsedResults: projection.newlyCollapsedResults,
				removedBundles: projection.newlyRemovedBundles,
			}, role);
			if (projection.epochTransitioned && projection.epochHash) {
				cacheTelemetry.observeHistoryProjectionEpoch(projection.epochHash);
			} else if (projection.segmentSealed && projection.segmentChainHash) {
				cacheTelemetry.observeHistoryProjectionSegmentSeal(projection.segmentChainHash);
			}
			mirrorOutputControlCompactFacts();
			return { messages: projection.messages };
		} catch {
			// Do not inspect event.messages again here. It may be a revoked proxy,
			// an accessor that already threw, or another hostile structured value.
			// Pi falls back to raw context if this handler throws, so the terminal
			// catch path must be fixed, bounded, and independently no-throw.
			cacheTelemetry.observeContextProjection({
				actorRoleCode: cacheActorRoleCode(role),
				historyProjection: null,
			});
			const messages = safeHistoryProjectionFailureMessages();
			latestHistoryProjectionBoundaryMarkers = [];
			latestHistoryProjectionFacts = {
				originalToolTextBytes: 0,
				finalToolTextBytes: 0,
				collapsedResults: 0,
				removedBundles: 0,
				protectedLatestBundles: 0,
			};
			latestHistoryPressure = {
				epoch: 0,
				rawBundleCount: 0,
				hardHistoryBytes: maxToolTextBytes,
				hardBundleCount: HISTORY_MAX_BUNDLES,
			};
			try {
				ensureOutputControlTelemetry().recordHistory(latestHistoryProjectionFacts, role);
				mirrorOutputControlCompactFacts();
			} catch {
				// Advisory telemetry cannot reopen the raw-context fallback path.
			}
			return { messages };
		}
	});

	// Apply exact, core-proven immutable cache boundaries only for the public
	// OpenAI GPT-5.6 Responses path. The helper is copy-on-write and fails
	// closed to the original payload for every unsupported/uncertain shape;
	// The provider boundary stays identity-exact for every configured worker.
	// Telemetry records a local, nonfinal observation of the post-breakpoint
	// payload at this extension boundary, never the pre-transform payload. The
	// provider/SDK may still transform it; retained facts are structural hashes
	// and content-free numeric anatomy, never verified final-wire claims.
	pi.on("before_provider_request", (event, ctx) => {
		const breakpointResult = applyExplicitPromptCacheBreakpoints({
			payload: event.payload,
			provider: ctx.model?.provider ?? "",
			api: ctx.model?.api ?? "",
			modelId: ctx.model?.id ?? "",
			allowCodexExperimental: false,
			expectedMarkerTexts: latestHistoryProjectionBoundaryMarkers,
		});
		cacheTelemetry.observePayload(breakpointResult.payload);
		if (breakpointResult.status === "applied" || breakpointResult.reason === "already_applied") {
			cacheTelemetry.observeExplicitPromptCacheBreakpointsApplied();
		}
		return breakpointResult.payload;
	});

	// The first message_end handler plans assistant batches before Pi starts
	// any tool, and owns every immediate toolResult path that bypasses
	// tool_result middleware (unknown tool, validation failure, guard block,
	// abort, or length-stop). It is registered before telemetry/persistence
	// observers and never creates/finalizes a receipt.
	pi.on("message_end", (event) => {
		const messageValue = event.message as unknown;
		const calls = assistantToolCalls(messageValue);
		if (calls !== undefined) {
			const plan = planTurnOutputBudget({
				turnSerial: currentTurnSerial,
				role: outputTurnRole(),
				calls,
			});
			turnOutputBudget.installPlan(plan);
			transientState.clearOutputAuthorizations();
			return undefined;
		}
		if (ownDataValue(messageValue, "role") !== "toolResult") return undefined;

		const toolCallIdValue = ownDataValue(messageValue, "toolCallId");
		const toolNameValue = ownDataValue(messageValue, "toolName");
		const toolCallId = typeof toolCallIdValue === "string" ? toolCallIdValue : "";
		const toolName = typeof toolNameValue === "string" ? toolNameValue : "";
		// Never trust caller-supplied output_envelope/receipt facts as proof of
		// processing. Only this private, exact FIFO marker can bypass immediate
		// result accounting after the normal tool_result middleware path.
		if (transientState.takeProcessedNormalResult(toolCallId, toolName)) return undefined;
		let authorization = transientState.takeOutputAuthorization(toolCallId, toolName);
		try {
			const content = ownDataValue(messageValue, "content");
			const details = ownDataValue(messageValue, "details");
			const role = outputTurnRole();
			authorization ??= authorizeOutput(toolCallId, toolName, undefined);
			pendingReceiptHandles.delete(toolCallId);
			const policy = resolveToolOutputPolicy({ toolName, args: undefined, role });
			let envelope: OutputEnvelopeResult;
			if (!authorization.authorizationId) {
				envelope = enforceOutputEnvelope({
					toolName,
					content: [],
					isError: true,
					policy,
					allocatedBytes: 0,
				});
			} else if (!authorization.allowed) {
				const controlText = authorization.controlAllocatedBytes > 0
					? authorization.controlText ?? blockedControlText(authorization.blockCode ?? "turn_output_budget")
					: "";
				envelope = enforceOutputEnvelope({
					toolName,
					content: controlText ? [{ type: "text", text: controlText }] : [],
					isError: true,
					policy,
					allocatedBytes: authorization.controlAllocatedBytes,
				});
				const accounting = turnOutputBudget.accountImmediate({
					authorizationId: authorization.authorizationId,
					actualBytes: envelope.facts.shownTextBytes,
				});
				if (!accounting.accepted) {
					envelope = enforceOutputEnvelope({ toolName, content: [], isError: true, policy, allocatedBytes: 0 });
				}
			} else {
				envelope = enforceOutputEnvelope({
					toolName,
					content: content as RuntimeOutputContent,
					isError: true,
					policy,
					allocatedBytes: authorization.allocatedBytes,
				});
				const accounting = turnOutputBudget.accountImmediate({
					authorizationId: authorization.authorizationId,
					actualBytes: envelope.facts.shownTextBytes,
				});
				if (!accounting.accepted) {
					envelope = enforceOutputEnvelope({ toolName, content: [], isError: true, policy, allocatedBytes: 0 });
				}
			}
			const projectedDetails = projectToolResultDetails({
				toolName,
				details,
				envelope: envelope.facts,
			}).details;
			observeOutputEnvelope(toolName, envelope.facts);
			const replacement = {
				...(messageValue as Record<string, unknown>),
				content: envelope.content,
				details: projectedDetails,
				isError: true,
			};
			return { message: replacement as never };
		} catch {
			if (authorization?.authorizationId) {
				turnOutputBudget.accountImmediate({ authorizationId: authorization.authorizationId, actualBytes: 0 });
			}
			pendingReceiptHandles.delete(toolCallId);
			const policy = resolveToolOutputPolicy({ toolName, args: undefined, role: outputTurnRole() });
			const envelope = enforceOutputEnvelope({ toolName, content: [], isError: true, policy, allocatedBytes: 0 });
			observeOutputEnvelope(toolName || "unknown", envelope.facts);
			const timestampValue = ownDataValue(messageValue, "timestamp");
			return {
				message: {
					role: "toolResult",
					toolCallId: toolCallId || "unknown",
					toolName: toolName || "unknown",
					content: envelope.content,
					details: projectToolResultDetails({
						toolName: toolName || "unknown",
						details: undefined,
						envelope: envelope.facts,
					}).details,
					isError: true,
					timestamp: typeof timestampValue === "number" && Number.isFinite(timestampValue) ? timestampValue : 0,
				} as never,
			};
		}
	});

	registerMessageEndController({
		pi,
		cacheTelemetry,
		getWorkerContext: () => ({
			role: workerRoleContext.role, spendProfile: workerRoleContext.spendProfile, timeoutMs: workerRoleContext.timeoutMs,
		}),
		projectRootFor,
		refreshStatus,
		onWorkerBudgetSteerSent: () => { workerBudgetSteerSent = true; },
	});
	registerWorkerNoProgressController({
		pi,
		workerRole: workerRoleContext.role,
		workerTaskKind: workerRoleContext.taskKind,
		budgetSteerSent: () => workerBudgetSteerSent,
	});
	registerDelegationClaimGuard({
		pi,
		isCommander: () => outputTurnRole() === "commander",
		projectRootFor,
		getDelegationState: delegationSession.getState,
		readTransaction: readDelegationTransactionV2,
		readCommittedGeneration: readDelegationCommittedGenerationV2,
		readLegacyLedger: readDelegationLedger,
		readCommittedRun: readCommittedManifest,
	});
	// Safe flush: persist the session state entry (append-only JSONL records
	// are already written per request; nothing is buffered here).
	pi.on("session_shutdown", () => {
		transientState.resetTrustedIngressAuthorities();
		cacheTelemetry.flush();
		// P7: a commander write lease never outlives its session.
		if (writeLease) {
			const now = new Date().toISOString();
			const reason = leaseRevokeReason(writeLease, { mode, sessionEnded: true });
			if (reason) {
				writeLease = revokeLease(writeLease, reason, now);
				persistLease();
				// Reapply the locked tool set (back to the exact canonical 15).
				applyModeTools();
			}
		}
	});

	// --------------------------------------------------------------- commands

	const statusCommandController = {
		pi,
		getMode: () => mode,
		setMode,
		getIdentity: () => ({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		}),
		getLease: () => writeLease,
		getDelegationState: delegationSession.getState,
		syncLease: syncLeaseLock,
		reconcileProjectAuthority: delegationSession.reconcileProjectAuthority,
		getProjectAuthorityBlockReason: delegationSession.projectAuthorityBlockReason,
		trustedOrError,
		projectRootFor,
		delegationStatusLines,
		getOutputTelemetry: ensureOutputControlTelemetry,
		getWidgetForced: () => widgetForced,
		setWidgetForced: (forced: boolean) => { widgetForced = forced; },
		output,
		refreshStatus,
		refreshWidget,
	};
	registerStatusCommands(statusCommandController);

	registerCommanderWriteCommands({
		pi,
		getMode: () => mode,
		getIdentity: () => ({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		}),
		getLease: () => writeLease,
		setLease: (lease) => { writeLease = lease; },
		syncLease: syncLeaseLock,
		persistLease,
		applyModeTools,
		refreshStatus,
		output,
	});

	// ------------------------------------------------ P5 milestone handoff

	registerMilestoneHandoffCommand({
		pi,
		getRole: () => workerRoleContext.role,
		getMode: () => mode,
		getCompactState: () => compactState,
		getDelegationState: delegationSession.getState,
		getSecrets: () => secrets,
		refreshCompactFacts: refreshCompactP7Facts,
		output,
	});

	// ------------------------------------------------------------ /q-init

	registerInitCommand({
		pi,
		trustedOrError,
		projectRootFor,
		output,
	});

	// ------------------------------------------------------------ /q-run

	registerRunCommands({
		pi,
		getMode: () => mode,
		getActorFacts: () => ({
			role: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		}),
		exec: execFn,
		trustedOrError,
		projectRootFor,
		output,
		refreshStatus,
		refreshWidget,
	});

	// ------------------------------------------------------------ /q-gate

	registerGateCommands({
		pi,
		getMode: () => mode,
		getDelegationState: delegationSession.getState,
		getActorFacts: () => ({
			role: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		}),
		getProjectAuthorityBlockReason: delegationSession.projectAuthorityBlockReason,
		reconcileProjectAuthority: delegationSession.reconcileProjectAuthority,
		buildWorkerFirstFacts: buildWorkerFirstGateFacts,
		exec: execFn,
		trustedOrError,
		projectRootFor,
		output,
		refreshStatus,
		refreshWidget,
	});

	// ----------------------------------------------------------- /q-widget

	registerWidgetCommand(statusCommandController);

	// ------------------------------------------------------- P6-A cache cmds

	registerCacheCommands({
		pi,
		telemetry: cacheTelemetry,
		getMode: () => mode,
		exec: execFn,
		refreshConfig: refreshCacheConfig,
		trustedOrError,
		projectRootFor,
		output,
	});

	// --------------------------------------- NRO N1/N2 native tool overrides

	registerNativeToolOverrides({
		pi,
		peekOutputAuthorization: transientState.peekOutputAuthorization,
		rememberTrustedReadContinuation: transientState.rememberTrustedReadContinuation,
	});

	// --------------------------------------------------------- custom tools

	registerRecipeTools({
		pi,
		getMode: () => mode,
		getIdentity: () => ({
			role: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		}),
		exec: execFn,
		trustedOrError,
		projectRootFor,
		buildReadOnlyWorkerFirstGateFacts,
		peekOutputAuthorization: transientState.peekOutputAuthorization,
		rememberTrustedRunLogContinuation: transientState.rememberTrustedRunLogContinuation,
		bindTrustedIngressAuthority: transientState.bindTrustedIngressAuthority,
		rememberTrustedIngressAuthority: transientState.rememberTrustedIngressAuthority,
	});
	registerGateTools({
		pi,
		getMode: () => mode,
		getDelegationState: delegationSession.getState,
		getIdentity: () => ({
			role: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		}),
		exec: execFn,
		trustedOrError,
		projectRootFor,
		reconcileProjectAuthority: delegationSession.reconcileProjectAuthority,
		getProjectAuthorityBlockReason: delegationSession.projectAuthorityBlockReason,
		buildWorkerFirstGateFacts,
		peekOutputAuthorization: transientState.peekOutputAuthorization,
		rememberTrustedGateContinuation: transientState.rememberTrustedGateContinuation,
		bindTrustedIngressAuthority: transientState.bindTrustedIngressAuthority,
		rememberTrustedIngressAuthority: transientState.rememberTrustedIngressAuthority,
	});
	registerCompareTool({
		pi,
		services: RUNTIME_CONTROLLER_SERVICES.compare,
		trustedOrError,
		projectRootFor,
		bindTrustedIngressAuthority: transientState.bindTrustedIngressAuthority,
		rememberTrustedIngressAuthority: transientState.rememberTrustedIngressAuthority,
	});

	registerDelegateTool({
		pi,
		services: RUNTIME_CONTROLLER_SERVICES.delegate,
		exec: execFn,
		secrets,
		trustedOrError,
		projectRootFor,
		reconcileProjectAuthority: delegationSession.reconcileProjectAuthority,
		getProjectAuthorityBlockReason: delegationSession.projectAuthorityBlockReason,
		collectCurrentDelegationBinding: delegationSession.collectCurrentBinding,
		projectTerminalReviewedBinding: delegationSession.projectTerminalReviewedBinding,
		getDelegationState: delegationSession.getState,
		setDelegationState: delegationSession.setState,
		persistDelegationState: delegationSession.persistBestEffort,
		persistDelegationStateStrict: delegationSession.persistStrict,
		markTerminalMirrorBlocked: delegationSession.markTerminalMirrorBlocked,
		refreshStatus,
		bindTrustedIngressAuthority: transientState.bindTrustedIngressAuthority,
		rememberTrustedIngressAuthority: transientState.rememberTrustedIngressAuthority,
	});
	registerReviewTool({
		pi,
		services: RUNTIME_CONTROLLER_SERVICES.review,
		exec: execFn,
		secrets,
		trustedOrError,
		projectRootFor,
		peekOutputAuthorization: transientState.peekOutputAuthorization,
		syncLease: syncLeaseLock,
		reconcileProjectAuthority: delegationSession.reconcileProjectAuthority,
		getProjectAuthorityBlockReason: delegationSession.projectAuthorityBlockReason,
		getProjectAuthorityIssueCode: () => delegationSession.getProjectAuthorityIssue()?.code,
		getDelegationState: delegationSession.getState,
		setDelegationState: delegationSession.setState,
		isStrictMirrorDirty: delegationSession.isStrictMirrorDirty,
		setStrictMirrorDirty: delegationSession.setStrictMirrorDirty,
		persistDelegationState: delegationSession.persistBestEffort,
		persistDelegationStateStrict: delegationSession.persistStrict,
		refreshCompactFacts: refreshCompactP7Facts,
		refreshStatus,
	});
	registerDelegationStatusTool({
		pi,
		trustedOrError,
		projectRootFor,
		syncLease: syncLeaseLock,
		delegationStatusLines,
	});

	registerRecoveryTool({
		pi,
		services: RUNTIME_CONTROLLER_SERVICES.recovery,
		trustedOrError,
		projectRootFor,
	});
	registerLocalCommitTool({ pi, services: RUNTIME_CONTROLLER_SERVICES.localCommit, exec: execFn, trustedOrError, projectRootFor, getMode: () => mode, getIdentity: () => ({ roleEnv: workerRoleContext.role, provider: currentModelFacts.provider, model: currentModelFacts.model }), reconcileProjectAuthority: delegationSession.reconcileProjectAuthority, refreshStatus });
	registerToolResultMiddleware({
		pi,
		workerJournalActive: workerRoleContext.role === "worker" && workerRoleContext.taskKind === "implementation",
		workerWriteJournalRuntime,
		getOutputTurnRole: outputTurnRole,
		takeTrustedContinuation: (toolCallId, toolName) =>
			transientState.takeTrustedReadContinuation(toolCallId, toolName)
			?? transientState.takeTrustedRunLogContinuation(toolCallId, toolName)
			?? transientState.takeTrustedGateContinuation(toolCallId, toolName),
		takeOutputAuthorization: transientState.takeOutputAuthorization,
		authorizeOutput,
		takeTrustedIngressAuthority: transientState.takeTrustedIngressAuthority,
		turnOutputBudget,
		observeOutputEnvelope,
		rememberProcessedNormalResult: transientState.rememberProcessedNormalResult,
		pendingReceiptHandles,
		secrets,
	});
	registerToolCallGuard({
		pi,
		toolCallBlockReason: (toolName) => streamingControl.toolCallBlockReason(toolName),
		getWorkerRoleContext: () => workerRoleContext,
		getIdentity: () => currentModelFacts,
		getMode: () => mode,
		getLease: () => writeLease,
		setLease: (lease) => { writeLease = lease; },
		syncLease: syncLeaseLock,
		recordBlockedWriteAttempt: (now) => {
			delegationSession.setState(recordBlockedWriteAttempt(delegationSession.getState(), now));
			delegationSession.persistBestEffort();
		},
		projectRootFor,
		authorizeOutput,
		rememberOutputAuthorization: transientState.rememberOutputAuthorization,
		workerWriteJournalRuntime,
		turnOutputBudget,
		pendingReceiptHandles,
		persistLease,
		applyModeTools,
		recordModifiedFile: (path) => {
			compactState.modifiedFiles = pushBounded(compactState.modifiedFiles, path, MAX_MODIFIED_FILES);
		},
	});
}
