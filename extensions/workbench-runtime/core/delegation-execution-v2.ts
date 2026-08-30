/**
 * Delegation-v2 execution orchestration.
 *
 * This controller is intentionally independent of the Pi runtime. It owns
 * lifecycle ordering and dependency injection only: the pure state machine,
 * transactional storage, artifact builder, worker runner, and git collector
 * remain the single owners of their respective decisions.
 */

import { isAbsolute, posix } from "node:path";

import { canonicalHash } from "../cache/canonical-hash.ts";
import { validateBudgetContinuationAuthorizationV1 } from "./budget-continuation-authorization.ts";

import {
	bindDelegationBoundedTaskContractV2,
	buildDelegationCommittedArtifactsV2,
	deriveDelegationPersistedReportV2,
	type DelegationBoundedTaskContractBindingV2,
	type DelegationArtifactErrorCode,
} from "./delegation-transaction-artifacts.ts";
import {
	MAX_ERROR_MESSAGE_CHARS,
	MAX_STOP_REASON_CHARS,
	type AfterFacts,
	type GitFacts,
	type LedgerBudget,
	type LedgerSpendFacts,
	type LedgerUsage,
	type LedgerWorkerFacts,
	type LedgerWorkerSummaryRecord,
} from "./delegation-ledger.ts";
import {
	DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2,
	deriveFinalizedDelegationWorkspaceFactsV2,
	derivePreparedDelegationWorkspaceBeforeV2,
	type DelegationWorkspaceAfterFactsV2,
	type DelegationWorkspaceGitFactsV2,
} from "./delegation-workspace-v2.ts";
import {
	finalizeDelegationChangeSetLifecycleV2,
	prepareDelegationChangeSetLifecycleV2,
	validatePreparedDelegationChangeSetLifecycleV2,
	type FinalizedDelegationChangeSetLifecycleV2,
	type PreparedDelegationChangeSetLifecycleV2,
} from "./delegation-change-set-lifecycle.ts";
import { redactText } from "./redact.ts";
import {
	commitDelegationGeneration,
	persistAbortedDelegationTransaction,
	persistCommittingDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRecoveryRequiredDelegationTransaction,
	persistResumedRunningDelegationTransaction,
	persistRunningDelegationTransaction,
	publishDelegationWorkerCheckpointV1,
	type DelegationTransactionStorageOptions,
} from "./delegation-transaction-storage.ts";
import {
	claimDelegationExecutionOwnerV2,
	RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2,
	RETRYABLE_EMPTY_RECOVERY_REASONS_V2,
	releaseDelegationExecutionOwnerV2,
	type DelegationExecutionOwnerOptionsV2,
} from "./delegation-execution-owner.ts";
import {
	BUDGET_PAUSED_RECOVERY_REASON_V2,
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
	DELEGATION_TRANSACTION_WORKER_ID_RE,
	delegationRepairReviewPathsV1,
	delegationPathAllowedV2,
	isDelegationInterruptedCandidateV2,
	parseDelegationRepairLineageV1,
	type DelegationRepairLineageV1,
	type DelegationTransactionRecord,
	type DelegationWorkerIdentity,
} from "./delegation-transaction.ts";
import type { ExecFn } from "./config.ts";
import {
	WORKER_MODEL_ID,
	WORKER_PROVIDER,
	type WorkerTaskContract,
} from "./worker-policy.ts";
import type { WorkerSpendProfile } from "./worker-spend.ts";
import type { WorkerRunFailureCode } from "./worker-run-failure.ts";
import {
	captureStreamingIdentities,
	isStrictStreamingIdentityPath,
	streamingIdentityEqual,
	type StreamingPathIdentity,
} from "./streaming-identity.ts";
import { truncateUtf8 } from "../worker/handoff.ts";
import {
	runPinnedWorker,
	workerRunnerPreflightFailureCode,
	workerRunFailure,
	type RunWorkerOptions,
	type WorkerProgress,
	type WorkerRunResult,
	type WorkerUsage,
	type WorkerRunnerPreflightFailureCode,
} from "../worker/runner.ts";
import { collectReviewRelevanceV2 } from "./review-relevance-v2.ts";
import { preflightSemanticReviewEnvelopeV1 } from "./diff-review.ts";
import type { SemanticReviewEnvelopeV1 } from "./semantic-review-envelope.ts";
import {
	authorizedWorkerBudgetPromotionV1,
	buildWorkerCheckpointV1,
	remainingWorkerBudgetV1,
	validateWorkerCheckpointContinuationV1,
	workerCheckpointBudgetContinuationCapsuleV1,
	workerCheckpointContinuationCapsuleV1,
	validateWorkerCheckpointV1,
	type WorkerBudgetPromotionV1,
	type WorkerCheckpointV1,
} from "./worker-checkpoint.ts";
import { WORKBENCH_RUNTIME_BUILD_IDENTITY } from "./runtime-build-identity.ts";
import { collectWorkspaceGuard, type WorkspaceGuardEntry, type WorkspaceGuardRecord } from "./workspace-guard.ts";
import {
	computeWorkerWriteJournalHash,
	readWorkerWriteJournal,
	type WorkerWriteJournalRecord,
} from "./write-journal.ts";
import {
	readStrictBoundCommandEffectReceipt,
	validateWorkerCommandEffectRuntimeObservation,
	type WorkerCommandEffectEntry,
	type WorkerCommandEffectRuntimeObservation,
} from "./delegation-command-effect-provenance.ts";
import type { WorkerWriteJournalRuntimeObservation } from "./worker-write-journal-runtime.ts";
import type { CheckpointResumeExecutionAuthorityV1 } from "./delegation-resume-authority.ts";

export type DelegationExecutionV2FailureCode =
	| "invalid_input"
	| "prepare_failed"
	| "change_set_prepare_failed"
	| "prepared_callback_failed"
	| "start_failed"
	| "runner_failed"
	| "worker_identity_invalid"
	| "checkpoint_failed"
	| "change_set_finalize_failed"
	| "after_failed"
	| "report_invalid"
	| "commit_state_failed"
	| "artifact_failed"
	| "generation_commit_failed"
	| "postconditions_failed"
	| "unexpected_terminal_state";

export interface DelegationExecutionMachineResultV2 {
	provider: typeof WORKER_PROVIDER;
	model: typeof WORKER_MODEL_ID;
	status: "success" | "failure";
	turns: number;
	exitCode: number | null;
	stopReason: string | null;
	usage: LedgerUsage;
	cacheHitRatio: number | null;
	budget: LedgerBudget;
	spend: LedgerSpendFacts;
	deniedWriteCount: number;
	reportComplete: boolean;
}

export type RunDelegationWorkerV2 = (options: RunWorkerOptions) => Promise<WorkerRunResult>;

export interface CollectDelegationAfterV2Input {
	projectRoot: string;
	before: GitFacts;
	signal?: AbortSignal;
	exec?: ExecFn;
}

export type CollectDelegationAfterV2 = (input: CollectDelegationAfterV2Input) => Promise<AfterFacts>;

export interface ExecuteDelegationV2Input {
	projectRoot: string;
	delegationId: string;
	contract: DelegationBoundedTaskContractBindingV2;
	/** Deprecated compatibility input. New v2 derives its before from one guard. */
	before?: GitFacts;
	/** Internal closed dependency set; the public runtime default is exactly []. */
	dependencyPaths?: readonly string[];
	/** Strict unresolved semantic-repair continuity; never write authority. */
	repairLineage?: DelegationRepairLineageV1;
	workerIdentity: DelegationWorkerIdentity;
	secrets?: readonly string[];
	signal?: AbortSignal;
	onProgress?: (progress: WorkerProgress) => void;
	clock: () => string;
	/** Exact checkout-lane token inherited by the pinned child runtime. */
	checkoutOperationToken?: string;
	onPrepared?: (
		state: DelegationTransactionRecord,
		before: Readonly<DelegationWorkspaceGitFactsV2>,
		prepared: Readonly<PreparedDelegationChangeSetLifecycleV2>,
	) => void | Promise<void>;
	/** Explicit argv-only execution dependency used by the default collector. */
	exec?: ExecFn;
	runWorker?: RunDelegationWorkerV2;
	collectAfter?: CollectDelegationAfterV2;
	storageOptions?: DelegationTransactionStorageOptions;
	/** Test seam for boot identity; storage remains bound to storageOptions. */
	executionOwnerOptions?: Omit<DelegationExecutionOwnerOptionsV2, "storage_options">;
	/** Exact same-transaction continuation collected and revalidated under the checkout writer lease. */
	checkpointRecovery?: Readonly<CheckpointResumeExecutionAuthorityV1>;
}

interface DelegationExecutionV2Common {
	delegation_id: string;
	before: GitFacts;
	durable_state?: DelegationTransactionRecord;
	after?: DelegationWorkspaceAfterFactsV2;
	result?: DelegationExecutionMachineResultV2;
	workerSummary?: LedgerWorkerSummaryRecord;
	/** Closed runner category; never contains provider text, stderr, paths, or raw errors. */
	worker_failure_code?: WorkerRunFailureCode;
	/** Closed preflight category for a runner exception before terminal facts. */
	runner_preflight_failure_code?: WorkerRunnerPreflightFailureCode;
	/** Bounded builder category; raw builder messages are never exposed. */
	artifact_error_code?: DelegationArtifactErrorCode | "internal_error";
	/** Latest durable execution checkpoint; never semantic review authority. */
	checkpoint?: Readonly<WorkerCheckpointV1>;
}

export type DelegationExecutionV2Result =
	| (DelegationExecutionV2Common & {
		ok: true;
		status: "PENDING_REVIEW" | "FINISHED";
		durable_state: DelegationTransactionRecord;
		after: DelegationWorkspaceAfterFactsV2;
		result: DelegationExecutionMachineResultV2;
		workerSummary: LedgerWorkerSummaryRecord;
	})
	| (DelegationExecutionV2Common & {
		ok: true;
		status: "PAUSED_BUDGET";
		durable_state: DelegationTransactionRecord;
		checkpoint: Readonly<WorkerCheckpointV1>;
	})
	| (DelegationExecutionV2Common & {
		ok: false;
		code: DelegationExecutionV2FailureCode;
	});

interface CheckedInput {
	projectRoot: string;
	delegationId: string;
	contract: DelegationBoundedTaskContractBindingV2;
	dependencyPaths: string[];
	repairLineage?: DelegationRepairLineageV1;
	workerIdentity: DelegationWorkerIdentity;
	secrets: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedUniqueStrings(values: readonly string[]): boolean {
	return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function cloneGitFacts(raw: unknown): GitFacts | undefined {
	if (!isRecord(raw) || (raw.gitHead !== null &&
		(typeof raw.gitHead !== "string" || !/^[a-f0-9]{40,64}$/.test(raw.gitHead))) ||
		typeof raw.gitDirty !== "boolean" || !Array.isArray(raw.changedPaths) || raw.changedPaths.length > 500 ||
		!raw.changedPaths.every((path) => typeof path === "string" && path.length > 0 && path.length <= 400 &&
			path === path.trim() && !isAbsolute(path) && !path.includes("\\") && !path.includes("\0") &&
			posix.normalize(path) === path && path !== "." && path !== ".." && !path.startsWith("../")) ||
		!sortedUniqueStrings(raw.changedPaths as string[]) || !isRecord(raw.pathStatuses) || !isRecord(raw.pathDigests)) return undefined;
	const changedPaths = [...raw.changedPaths] as string[];
	if (raw.gitDirty !== (changedPaths.length > 0)) return undefined;
	const statusPaths = Object.keys(raw.pathStatuses).sort();
	if (statusPaths.length !== changedPaths.length || statusPaths.some((path, index) => path !== changedPaths[index]) ||
		!Object.values(raw.pathStatuses).every((status) => typeof status === "string" && status.length > 0 && status.length <= 4)) return undefined;
	if (!Object.keys(raw.pathDigests).every((path) => changedPaths.includes(path)) ||
		!Object.values(raw.pathDigests).every((digest) => typeof digest === "string" && /^[a-f0-9]{64}(?::\d+)?$/.test(digest))) return undefined;
	return {
		gitHead: raw.gitHead as string | null,
		gitDirty: raw.gitDirty,
		changedPaths,
		pathStatuses: { ...(raw.pathStatuses as Record<string, string>) },
		pathDigests: { ...(raw.pathDigests as Record<string, string>) },
	};
}

function checkInput(input: ExecuteDelegationV2Input): CheckedInput | undefined {
	if (!isRecord(input) || typeof input.projectRoot !== "string" || input.projectRoot.length === 0 ||
		input.projectRoot !== input.projectRoot.trim() || !isAbsolute(input.projectRoot) || input.projectRoot.includes("\0") ||
		typeof input.delegationId !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(input.delegationId) ||
		typeof input.clock !== "function") return undefined;
	const contractRaw = input.contract as unknown;
	if (!isRecord(contractRaw) || typeof contractRaw.contract_hash !== "string" ||
		!DELEGATION_TRANSACTION_HASH_RE.test(contractRaw.contract_hash)) return undefined;
	const { contract_hash, ...payload } = contractRaw;
	const rebound = bindDelegationBoundedTaskContractV2(payload);
	if (!rebound.ok || rebound.value.contract_hash !== contract_hash) return undefined;
	const identity = input.workerIdentity;
	if (!isRecord(identity) || identity.provider !== WORKER_PROVIDER || identity.model !== WORKER_MODEL_ID ||
		typeof identity.worker_id !== "string" || !DELEGATION_TRANSACTION_WORKER_ID_RE.test(identity.worker_id)) return undefined;
	const dependencyPaths = [...(input.dependencyPaths ?? [])];
	const repairLineage = input.repairLineage === undefined ? undefined : parseDelegationRepairLineageV1(input.repairLineage);
	if (!dependencyPaths.every((path, index) => isStrictStreamingIdentityPath(path)
		&& (index === 0 || byteCompare(dependencyPaths[index - 1]!, path) < 0)) ||
		(input.repairLineage !== undefined && repairLineage === undefined) ||
		(repairLineage !== undefined && (rebound.value.task_kind !== "implementation" ||
			!sameByteSortedPaths(dependencyPaths, repairLineage.carried_paths))) ||
		(input.secrets !== undefined &&
		(!Array.isArray(input.secrets) || !input.secrets.every((secret) => typeof secret === "string"))) ||
		(input.checkoutOperationToken !== undefined && !/^[a-f0-9]{32}$/u.test(input.checkoutOperationToken))) return undefined;
	return {
		projectRoot: input.projectRoot,
		delegationId: input.delegationId,
		contract: structuredClone(rebound.value),
		dependencyPaths,
		...(repairLineage === undefined ? {} : { repairLineage }),
		workerIdentity: { ...identity },
		secrets: [...(input.secrets ?? [])],
	};
}

function cloneAfter(after: DelegationWorkspaceAfterFactsV2): DelegationWorkspaceAfterFactsV2 {
	return {
		diffIdentityKind: DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2,
		gitHead: after.gitHead,
		gitDirty: after.gitDirty,
		changedPaths: [...after.changedPaths],
		pathStatuses: { ...after.pathStatuses },
		pathDigests: { ...after.pathDigests },
		changedSinceBefore: [...after.changedSinceBefore],
		diffHash: after.diffHash,
	};
}

function cloneAfterIfSafe(after: DelegationWorkspaceAfterFactsV2): DelegationWorkspaceAfterFactsV2 | undefined {
	try {
		return cloneAfter(after);
	} catch {
		return undefined;
	}
}

function safeClock(clock: () => string): string | undefined {
	try {
		const value = clock();
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

function workerTask(contract: DelegationBoundedTaskContractBindingV2): WorkerTaskContract {
	return {
		taskKind: contract.task_kind,
		task: contract.task,
		allowedPaths: [...contract.allowed_paths],
		acceptanceCriteria: [...contract.acceptance_criteria],
		verification: [...contract.verification],
		budgetProfile: contract.budget_profile,
		...(contract.repair_of === undefined ? {} : { repairOf: contract.repair_of }),
	};
}

function fixedWorkerIdentity(result: WorkerRunResult): boolean {
	return result.provider === WORKER_PROVIDER && result.model === WORKER_MODEL_ID;
}

function ledgerWorkerFacts(
	result: WorkerRunResult,
	failureCode: WorkerRunFailureCode | null,
	reportSummary: string,
	secrets: readonly string[],
): LedgerWorkerFacts {
	const stopReason = result.stopReason === undefined
		? null
		: truncateUtf8(redactText(result.stopReason, secrets), MAX_STOP_REASON_CHARS);
	const errorMessage = result.errorMessage === undefined
		? null
		: truncateUtf8(redactText(result.errorMessage, secrets), MAX_ERROR_MESSAGE_CHARS);
	return {
		provider: result.provider ?? null,
		model: result.model ?? null,
		status: failureCode === null ? "success" : "failure",
		workerSuccess: failureCode === null,
		workerFailureCode: failureCode,
		exitCode: result.exitCode,
		turns: result.turns,
		stopReason,
		errorMessage,
		usage: {
			input: result.usage.input,
			output: result.usage.output,
			cacheRead: result.usage.cacheRead,
			cacheWrite: result.usage.cacheWrite,
			totalTokens: result.usage.totalTokens,
			cost: { ...result.usage.cost },
		},
		cacheHitRatio: result.cacheHitRatio,
		budget: {
			maxContextTokens: result.maxContextTokens,
			maxContextRatio: result.maxContextRatio,
			softBudgetReached: result.softBudgetReached,
			hardBudgetExceeded: result.hardBudgetExceeded,
			compactionCount: result.compactionCount,
			compactionReasons: [...result.compactionReasons],
		},
		spendProfile: result.spendProfile,
		spendState: { ...result.spendState },
		spendBand: result.spendBand,
		spendReasons: [...result.spendReasons],
		spendSoftReached: { ...result.spendSoftReached },
		spendHardExceeded: { ...result.spendHardExceeded },
		reportSummary,
	};
}

function machineResult(
	summary: LedgerWorkerSummaryRecord,
	deniedWriteCount: number,
	reportComplete: boolean,
): DelegationExecutionMachineResultV2 {
	return {
		provider: summary.provider as typeof WORKER_PROVIDER,
		model: summary.model as typeof WORKER_MODEL_ID,
		status: summary.status,
		turns: summary.turns,
		exitCode: summary.exit_code,
		stopReason: summary.stop_reason,
		usage: structuredClone(summary.usage),
		cacheHitRatio: summary.cache_hit_ratio,
		budget: structuredClone(summary.budget),
		spend: structuredClone(summary.spend!),
		deniedWriteCount,
		reportComplete,
	};
}

function failure(
	code: DelegationExecutionV2FailureCode,
	checked: CheckedInput | undefined,
	input: ExecuteDelegationV2Input,
	extra: Partial<DelegationExecutionV2Common> = {},
): DelegationExecutionV2Result {
	return {
		ok: false,
		code,
		delegation_id: checked?.delegationId ??
			(typeof input?.delegationId === "string" && DELEGATION_TRANSACTION_ID_RE.test(input.delegationId)
				? input.delegationId
				: "invalid"),
		before: cloneGitFacts(input?.before) ?? {
			gitHead: null,
			gitDirty: false,
			changedPaths: [],
			pathStatuses: {},
			pathDigests: {},
		},
		...extra,
	};
}

async function attemptRecovery(
	checked: CheckedInput,
	state: DelegationTransactionRecord,
	clock: () => string,
	storageOptions: DelegationTransactionStorageOptions | undefined,
	reason: string,
): Promise<DelegationTransactionRecord> {
	if (state.status !== "RUNNING" && state.status !== "COMMITTING") return state;
	const now = safeClock(clock);
	if (now === undefined) return state;
	const recovered = await persistRecoveryRequiredDelegationTransaction(checked.projectRoot, {
		delegation_id: checked.delegationId,
		contract_hash: checked.contract.contract_hash,
		worker_identity: checked.workerIdentity,
		expected_generation: state.generation,
		expected_revision: state.revision,
		now,
		reason,
	}, storageOptions).catch(() => undefined);
	return recovered?.ok ? recovered.value : state;
}

async function attemptPreparedAbort(
	checked: CheckedInput,
	state: DelegationTransactionRecord,
	clock: () => string,
	storageOptions: DelegationTransactionStorageOptions | undefined,
	reason: string,
): Promise<DelegationTransactionRecord> {
	if (state.status !== "PREPARED") return state;
	const now = safeClock(clock);
	if (now === undefined) return state;
	const aborted = await persistAbortedDelegationTransaction(checked.projectRoot, {
		delegation_id: checked.delegationId,
		contract_hash: checked.contract.contract_hash,
		worker_identity: checked.workerIdentity,
		expected_generation: state.generation,
		expected_revision: state.revision,
		now,
		reason,
	}, storageOptions).catch(() => undefined);
	return aborted?.ok ? aborted.value : state;
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function sameByteSortedPaths(left: readonly string[], right: readonly string[]): boolean {
	const leftSorted = [...left].sort(byteCompare);
	const rightSorted = [...right].sort(byteCompare);
	return leftSorted.length === rightSorted.length && leftSorted.every((path, index) => path === rightSorted[index]);
}

function zeroWorkerUsage(): WorkerUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addWorkerUsage(target: WorkerUsage, usage: Readonly<WorkerUsage>): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	if (usage.cacheWrite1h !== undefined) target.cacheWrite1h = (target.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + usage.reasoning;
	target.cost.input += usage.cost.input;
	target.cost.output += usage.cost.output;
	target.cost.cacheRead += usage.cost.cacheRead;
	target.cost.cacheWrite += usage.cost.cacheWrite;
	target.cost.total += usage.cost.total;
}

function mergeCommandEffectObservations(
	left: Readonly<WorkerCommandEffectRuntimeObservation>,
	right: Readonly<WorkerCommandEffectRuntimeObservation> | undefined,
): Readonly<WorkerCommandEffectRuntimeObservation> | undefined {
	if (!validateWorkerCommandEffectRuntimeObservation(left)) return undefined;
	if (right === undefined) return left;
	if (!validateWorkerCommandEffectRuntimeObservation(right)) return undefined;
	const entries: WorkerCommandEffectEntry[] = left.entries.map((entry) => structuredClone(entry));
	for (const entry of right.entries) {
		const duplicate = entry.run_id === null ? undefined : entries.find((candidate) => candidate.run_id === entry.run_id);
		if (duplicate !== undefined) {
			if (canonicalHash(duplicate) !== canonicalHash(entry)) return undefined;
			continue;
		}
		entries.push(structuredClone(entry));
	}
	if (left.state === "failed" || right.state === "failed") {
		return Object.freeze({
			state: "failed" as const,
			code: left.state === "failed" ? left.code : right.code,
			entries: Object.freeze(entries),
		});
	}
	return Object.freeze(entries.length === 0
		? { state: "empty" as const, code: "none" as const, entries: Object.freeze(entries) }
		: { state: "observed" as const, code: "none" as const, entries: Object.freeze(entries) });
}

function aggregateWorkerAttempts(
	attempts: readonly WorkerRunResult[],
	baselineUsage?: Readonly<WorkerUsage>,
	baselineWriteObservation?: Readonly<WorkerWriteJournalRuntimeObservation>,
): WorkerRunResult | undefined {
	const latest = attempts.at(-1);
	if (latest === undefined) return undefined;
	const usage = zeroWorkerUsage();
	if (baselineUsage !== undefined) addWorkerUsage(usage, baselineUsage);
	let deniedWriteCount = 0;
	let maxContextTokens = 0;
	let softBudgetReached = false;
	let hardBudgetExceeded = false;
	let compactionCount = 0;
	const compactionReasons: string[] = [];
	let writeObservation: Readonly<WorkerWriteJournalRuntimeObservation> | undefined = baselineWriteObservation;
	let commandObservation: Readonly<WorkerCommandEffectRuntimeObservation> = {
		state: "empty", code: "none", entries: [],
	};
	for (const attempt of attempts) {
		addWorkerUsage(usage, attempt.usage);
		deniedWriteCount += attempt.deniedWriteCount;
		maxContextTokens = Math.max(maxContextTokens, attempt.maxContextTokens);
		softBudgetReached ||= attempt.softBudgetReached;
		hardBudgetExceeded ||= attempt.hardBudgetExceeded;
		compactionCount += attempt.compactionCount;
		for (const reason of attempt.compactionReasons) if (!compactionReasons.includes(reason)) compactionReasons.push(reason);
		if (attempt.writeJournalObservation.state !== "empty") writeObservation = attempt.writeJournalObservation;
		const merged = mergeCommandEffectObservations(commandObservation, attempt.commandEffectObservation);
		if (merged === undefined) return undefined;
		commandObservation = merged;
	}
	const denominator = usage.input + usage.cacheRead;
	const spendState = latest.spendState;
	return {
		...latest,
		turns: spendState.turns,
		spendState,
		usage,
		cacheHitRatio: denominator > 0 ? usage.cacheRead / denominator : null,
		deniedWriteCount,
		maxContextTokens,
		maxContextRatio: maxContextTokens / 272_000,
		softBudgetReached,
		hardBudgetExceeded,
		compactionCount,
		compactionReasons,
		writeJournalObservation: writeObservation ?? latest.writeJournalObservation,
		commandEffectObservation: commandObservation,
	};
}

async function recoveredCheckpointWriteObservation(
	checked: CheckedInput,
): Promise<Readonly<WorkerWriteJournalRuntimeObservation> | undefined> {
	const read = await readWorkerWriteJournal({
		project_root: checked.projectRoot,
		delegation_id: checked.delegationId,
		contract_hash: checked.contract.contract_hash,
	});
	if (!read.ok || read.value.state !== "OPEN" || read.value.operations.length === 0
		|| read.value.operations.some((operation) => operation.status !== "completed")) return undefined;
	const last = read.value.operations.at(-1);
	return last?.status === "completed" ? Object.freeze({
		state: "complete" as const,
		tool: last.kind,
		outcome: last.outcome,
		code: "none" as const,
		revision: read.value.revision,
	}) : undefined;
}

function identityContentHash(identity: StreamingPathIdentity): string | null {
	return identity.kind === "missing" ? null : identity.sha256;
}

function guardEntryMap(guard: Readonly<WorkspaceGuardRecord>): Map<string, WorkspaceGuardEntry> {
	return new Map(guard.entries.map((entry) => [entry.path, entry]));
}

function guardChangesAreJournalBound(
	before: Readonly<WorkspaceGuardRecord>,
	current: Readonly<WorkspaceGuardRecord>,
	journalPaths: ReadonlySet<string>,
): boolean {
	if (before.git_head !== current.git_head) return false;
	const prior = guardEntryMap(before);
	const next = guardEntryMap(current);
	for (const path of new Set([...prior.keys(), ...next.keys()])) {
		if (canonicalHash(prior.get(path) ?? null) !== canonicalHash(next.get(path) ?? null) && !journalPaths.has(path)) return false;
	}
	return true;
}

async function verifiedRecipeRunIds(
	checked: CheckedInput,
	observation: Readonly<WorkerCommandEffectRuntimeObservation>,
	inherited: readonly string[] = [],
): Promise<string[] | undefined> {
	if (!validateWorkerCommandEffectRuntimeObservation(observation) || observation.state === "failed") return undefined;
	const runIds = [...new Set([
		...inherited,
		...observation.entries.flatMap((entry) => entry.run_id === null ? [] : [entry.run_id]),
	])].sort(byteCompare);
	if (!sortedUniqueStrings(runIds)) return undefined;
	for (const runId of runIds) {
		const receipt = await readStrictBoundCommandEffectReceipt({
			project_root: checked.projectRoot,
			delegation_id: checked.delegationId,
			contract_hash: checked.contract.contract_hash,
			run_id: runId,
		});
		if (!receipt.ok) return undefined;
	}
	return runIds;
}

async function buildDurableWorkerCheckpoint(
	checked: CheckedInput,
	prepared: Readonly<PreparedDelegationChangeSetLifecycleV2>,
	worker: Readonly<WorkerRunResult>,
	commandObservation: Readonly<WorkerCommandEffectRuntimeObservation>,
	attempt: number,
	parentCheckpointHash: string | null,
	machineState: "CHECKPOINTED" | "PAUSED_BUDGET",
	createdAt: string,
	exec: ExecFn,
	storageOptions: DelegationTransactionStorageOptions | undefined,
	checkpointRuntimeIdentity = WORKBENCH_RUNTIME_BUILD_IDENTITY.source_hash,
	inheritedRecipeRunIds: readonly string[] = [],
	budgetPromotion?: Readonly<WorkerBudgetPromotionV1>,
): Promise<Readonly<WorkerCheckpointV1> | undefined> {
	const journalRead = await readWorkerWriteJournal({
		project_root: checked.projectRoot,
		delegation_id: checked.delegationId,
		contract_hash: checked.contract.contract_hash,
	});
	if (!journalRead.ok || journalRead.value.state !== "OPEN"
		|| journalRead.value.operations.some((operation) => operation.status !== "completed")) return undefined;
	const journal = journalRead.value;
	const currentGuard = await collectWorkspaceGuard({ project_root: checked.projectRoot, exec });
	if (!currentGuard.ok) return undefined;
	const journalPaths = [...new Set(journal.operations.map((operation) => operation.path))].sort(byteCompare);
	if (!guardChangesAreJournalBound(prepared.before_guard, currentGuard.guard, new Set(journalPaths))) return undefined;
	const currentIdentities = await captureStreamingIdentities({
		project_root: checked.projectRoot,
		paths: journalPaths,
	});
	if (!currentIdentities.ok) return undefined;
	const currentByPath = new Map(currentIdentities.identities.map((identity) => [identity.path, identity]));
	const journalHash = computeWorkerWriteJournalHash(journal);
	const touchedPaths = journalPaths.map((path) => {
		const operations = journal.operations.filter((operation) => operation.path === path);
		const first = operations[0];
		const last = operations.at(-1);
		const current = currentByPath.get(path);
		if (first === undefined || last === undefined || last.status !== "completed" || current === undefined
			|| !streamingIdentityEqual(last.after, current)) return undefined;
		return {
			path,
			before_hash: identityContentHash(first.before),
			current_hash: identityContentHash(current),
			journal_hash: journalHash,
		};
	});
	if (touchedPaths.some((entry) => entry === undefined)) return undefined;
	const completedRecipeRunIds = await verifiedRecipeRunIds(checked, commandObservation, inheritedRecipeRunIds);
	if (completedRecipeRunIds === undefined) return undefined;
	const profile = worker.spendProfile === "extended" ? "extended" : "standard";
	const remaining = remainingWorkerBudgetV1(
		profile,
		worker.spendState.turns,
		worker.spendState.totalTokens,
		worker.spendState.outputTokens,
	);
	if (remaining === undefined) return undefined;
	const built = buildWorkerCheckpointV1({
		delegation_id: checked.delegationId,
		contract_hash: checked.contract.contract_hash,
		attempt,
		parent_checkpoint_hash: parentCheckpointHash,
		runtime_build_identity: checkpointRuntimeIdentity,
		before_binding_hash: prepared.before_guard.workspace_guard_hash,
		current_binding_hash: currentGuard.guard.workspace_guard_hash,
		touched_paths: touchedPaths as NonNullable<(typeof touchedPaths)[number]>[],
		completed_recipe_run_ids: completedRecipeRunIds,
		cumulative_usage: structuredClone(worker.usage),
		cumulative_turns: worker.spendState.turns,
		...(budgetPromotion === undefined ? {} : { budget_promotion: structuredClone(budgetPromotion) }),
		remaining_budget: remaining,
		machine_state: machineState,
		worker_advisory: worker.checkpointRequest?.advisory ?? { completed_criteria: [], remaining_criteria: [] },
		created_at: createdAt,
	});
	if (!built.ok) return undefined;
	const published = await publishDelegationWorkerCheckpointV1(checked.projectRoot, built.value, storageOptions);
	return published.ok && published.value.checkpoint_hash === built.value.checkpoint_hash ? published.value : undefined;
}

function validCheckpointRecoveryInput(
	checked: CheckedInput,
	value: unknown,
): value is Readonly<CheckpointResumeExecutionAuthorityV1> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const recovery = value as CheckpointResumeExecutionAuthorityV1;
	const budgetContinuation = recovery.budget_continuation;
	if (recovery.schema_version !== 1 || recovery.kind !== "checkpoint-resume-execution-authority-v1"
		|| recovery.delegation_id !== checked.delegationId
		|| recovery.contract.contract_hash !== checked.contract.contract_hash
		|| canonicalHash(recovery.contract) !== canonicalHash(checked.contract)
		|| recovery.transaction.status !== "RECOVERY_REQUIRED"
		|| budgetContinuation !== undefined && recovery.transaction.recovery_reason !== BUDGET_PAUSED_RECOVERY_REASON_V2
		|| recovery.transaction.delegation_id !== checked.delegationId
		|| recovery.transaction.contract_hash !== checked.contract.contract_hash
		|| recovery.transaction.worker_identity.provider !== checked.workerIdentity.provider
		|| recovery.transaction.worker_identity.model !== checked.workerIdentity.model
		|| recovery.transaction.worker_identity.worker_id !== checked.workerIdentity.worker_id
		|| !validatePreparedDelegationChangeSetLifecycleV2(recovery.prepared)
		|| recovery.prepared.project_root !== checked.projectRoot
		|| recovery.prepared.delegation_id !== checked.delegationId
		|| recovery.prepared.contract_hash !== checked.contract.contract_hash
		|| !validateWorkerCheckpointV1(recovery.checkpoint)
		|| (budgetContinuation === undefined
			? recovery.checkpoint.machine_state !== "CHECKPOINTED"
			: recovery.checkpoint.machine_state !== "PAUSED_BUDGET"
				|| !validateBudgetContinuationAuthorizationV1(budgetContinuation)
				|| budgetContinuation.delegation_id !== checked.delegationId
				|| budgetContinuation.checkpoint_hash !== recovery.checkpoint.checkpoint_hash
				|| budgetContinuation.target_profile !== "extended"
				|| recovery.checkpoint.remaining_budget.profile !== "standard"
				|| recovery.checkpoint.budget_promotion !== undefined)
		|| recovery.checkpoint.delegation_id !== checked.delegationId
		|| recovery.checkpoint.contract_hash !== checked.contract.contract_hash
		|| recovery.checkpoint.before_binding_hash !== recovery.prepared.before_guard.workspace_guard_hash
		|| (budgetContinuation === undefined
			? workerCheckpointContinuationCapsuleV1(recovery.checkpoint)
			: workerCheckpointBudgetContinuationCapsuleV1(recovery.checkpoint)) === undefined) return false;
	const { authority_hash: supplied, ...withoutHash } = recovery;
	return typeof supplied === "string" && supplied === canonicalHash(withoutHash);
}

/** Execute one fresh generation-1 delegation under the v2 transaction. */
export async function executeDelegationV2(input: ExecuteDelegationV2Input): Promise<DelegationExecutionV2Result> {
	const checked = checkInput(input);
	if (checked === undefined) return failure("invalid_input", undefined, input);
	const checkpointRecovery = input.checkpointRecovery;
	if (checkpointRecovery !== undefined && !validCheckpointRecoveryInput(checked, checkpointRecovery)) {
		return failure("invalid_input", checked, input);
	}
	const storageOptions = input.storageOptions;
	const preparedAt = safeClock(input.clock);
	if (preparedAt === undefined) return failure("prepare_failed", checked, input);
	let state: DelegationTransactionRecord;
	if (checkpointRecovery === undefined) {
		const prepared = await persistPreparedDelegationTransaction(checked.projectRoot, {
			delegation_id: checked.delegationId,
			task_kind: checked.contract.task_kind,
			contract_hash: checked.contract.contract_hash,
			allowed_paths: checked.contract.allowed_paths,
			worker_identity: checked.workerIdentity,
			generation: 1,
			now: preparedAt,
			...(checked.repairLineage === undefined ? {} : { repair_lineage: checked.repairLineage }),
		}, storageOptions).catch(() => undefined);
		if (prepared === undefined || !prepared.ok) return failure("prepare_failed", checked, input);
		state = prepared.value;
	} else {
		state = structuredClone(checkpointRecovery.transaction);
	}
	const ownerAt = safeClock(input.clock);
	if (ownerAt === undefined) {
		if (checkpointRecovery === undefined) {
			const aborted = await persistAbortedDelegationTransaction(checked.projectRoot, {
				delegation_id: checked.delegationId,
				contract_hash: checked.contract.contract_hash,
				worker_identity: checked.workerIdentity,
				expected_generation: state.generation,
				expected_revision: state.revision,
				now: preparedAt,
				reason: RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.executionOwnerTimeUnavailable,
			}, storageOptions).catch(() => undefined);
			if (aborted?.ok) state = aborted.value;
		}
		return failure("start_failed", checked, input, { durable_state: state });
	}
	const ownerOptions: DelegationExecutionOwnerOptionsV2 = {
		...(input.executionOwnerOptions ?? {}),
		...(storageOptions === undefined ? {} : { storage_options: storageOptions }),
	};
	const owner = await claimDelegationExecutionOwnerV2(
		checked.projectRoot,
		state,
		ownerAt,
		ownerOptions,
	).catch(() => undefined);
	if (owner === undefined || !owner.ok) {
		// No worker has been launched yet. The claim primitive marks absence only
		// after a strict not-found observation or after removing the exact token
		// created by this call. A foreign EEXIST owner is never removed here.
		if (checkpointRecovery === undefined && owner !== undefined && !owner.ok && owner.error.owner_absent === true) {
			state = await attemptPreparedAbort(
				checked,
				state,
				input.clock,
				storageOptions,
				RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.executionOwnerClaimFailed,
			);
		}
		return failure("start_failed", checked, input, { durable_state: state });
	}
	let releaseIncompleteOwner = false;
	try {
	let changeSetPrepared: Readonly<PreparedDelegationChangeSetLifecycleV2>;
	if (input.exec === undefined) {
		if (checkpointRecovery === undefined) {
			state = await attemptPreparedAbort(checked, state, input.clock, storageOptions,
				RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.changeSetPreparationFailed);
		}
		return failure("change_set_prepare_failed", checked, input, { durable_state: state });
	}
	if (checkpointRecovery !== undefined) {
		changeSetPrepared = checkpointRecovery.prepared;
	} else {
		try {
			const preparedLifecycle = await prepareDelegationChangeSetLifecycleV2({
				project_root: checked.projectRoot,
				delegation_id: checked.delegationId,
				contract_hash: checked.contract.contract_hash,
				dependency_paths: [...checked.dependencyPaths],
				exec: input.exec,
			});
			if (!preparedLifecycle.ok) throw new Error("change set prepare failed");
			changeSetPrepared = preparedLifecycle.value;
		} catch {
			state = await attemptPreparedAbort(checked, state, input.clock, storageOptions,
				RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.changeSetPreparationFailed);
			return failure("change_set_prepare_failed", checked, input, { durable_state: state });
		}
	}
	const preparedBeforeResult = derivePreparedDelegationWorkspaceBeforeV2(changeSetPrepared);
	if (!preparedBeforeResult.ok) {
		if (checkpointRecovery === undefined) {
			state = await attemptPreparedAbort(checked, state, input.clock, storageOptions,
				RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.guardBeforeFailed);
		}
		return failure("change_set_prepare_failed", checked, input, { durable_state: state });
	}
	const preparedBefore = preparedBeforeResult.value;

	if (checkpointRecovery === undefined && input.onPrepared !== undefined) {
		try {
			await input.onPrepared(
				structuredClone(state),
				structuredClone(preparedBefore),
				structuredClone(changeSetPrepared),
			);
		} catch {
			const abortedAt = safeClock(input.clock);
			if (abortedAt !== undefined) {
				const aborted = await persistAbortedDelegationTransaction(checked.projectRoot, {
					delegation_id: checked.delegationId,
					contract_hash: checked.contract.contract_hash,
					worker_identity: checked.workerIdentity,
					expected_generation: state.generation,
					expected_revision: state.revision,
					now: abortedAt,
					reason: RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.preparedCallbackFailed,
				}, storageOptions).catch(() => undefined);
				if (aborted?.ok) state = aborted.value;
			}
			return failure("prepared_callback_failed", checked, input, { durable_state: state });
		}
	}

	const runningAt = safeClock(input.clock);
	if (runningAt === undefined) {
		if (checkpointRecovery === undefined) {
			state = await attemptPreparedAbort(checked, state, input.clock, storageOptions,
				RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.runningTimeUnavailable);
		}
		return failure("start_failed", checked, input, { durable_state: state });
	}
	const runningInput = {
		delegation_id: checked.delegationId,
		contract_hash: checked.contract.contract_hash,
		worker_identity: checked.workerIdentity,
		expected_generation: state.generation,
		expected_revision: state.revision,
		now: runningAt,
	};
	const running = await (checkpointRecovery === undefined
		? persistRunningDelegationTransaction(checked.projectRoot, runningInput, storageOptions)
		: persistResumedRunningDelegationTransaction(checked.projectRoot, runningInput, storageOptions))
		.catch(() => undefined);
	if (running === undefined || !running.ok) {
		if (checkpointRecovery === undefined) {
			state = await attemptPreparedAbort(checked, state, input.clock, storageOptions,
				RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.runningPersistFailed);
		}
		return failure("start_failed", checked, input, { durable_state: state });
	}
	state = running.value;
	const baselineWriteObservation = checkpointRecovery === undefined
		? undefined
		: await recoveredCheckpointWriteObservation(checked);
	if (checkpointRecovery !== undefined && baselineWriteObservation === undefined) {
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRunnerFailed);
		return failure("checkpoint_failed", checked, input, { durable_state: state });
	}

	let worker: WorkerRunResult | undefined;
	const workerAttempts: WorkerRunResult[] = [];
	let attempt = checkpointRecovery === undefined ? 1 : checkpointRecovery.checkpoint.attempt + 1;
	const budgetContinuation = checkpointRecovery?.budget_continuation;
	const authorizedPromotion = checkpointRecovery === undefined || budgetContinuation === undefined
		? undefined
		: authorizedWorkerBudgetPromotionV1(
			checkpointRecovery.checkpoint,
			budgetContinuation.authority_hash,
		);
	if (checkpointRecovery !== undefined && budgetContinuation !== undefined && authorizedPromotion === undefined) {
		return failure("checkpoint_failed", checked, input, { durable_state: state });
	}
	const budgetPromotion = authorizedPromotion ?? checkpointRecovery?.checkpoint.budget_promotion;
	const executionSpendProfile: WorkerSpendProfile = budgetContinuation !== undefined
		? "extended"
		: checkpointRecovery?.checkpoint.remaining_budget.profile ?? checked.contract.budget_profile as WorkerSpendProfile;
	let initialSpendState: Readonly<{ turns: number; totalTokens: number; outputTokens: number }> | undefined =
		checkpointRecovery === undefined
			? undefined
			: {
				turns: checkpointRecovery.checkpoint.cumulative_turns,
				totalTokens: checkpointRecovery.checkpoint.cumulative_usage.totalTokens,
				outputTokens: checkpointRecovery.checkpoint.cumulative_usage.output,
			};
	let continuationCapsule: Readonly<Record<string, unknown>> | undefined = checkpointRecovery === undefined
		? undefined
		: budgetContinuation === undefined
			? workerCheckpointContinuationCapsuleV1(checkpointRecovery.checkpoint)
			: workerCheckpointBudgetContinuationCapsuleV1(checkpointRecovery.checkpoint);
	let initialWriteJournalObservation = baselineWriteObservation;
	let parentCheckpointHash: string | null = checkpointRecovery?.checkpoint.checkpoint_hash ?? null;
	const checkpointRuntimeIdentity = checkpointRecovery?.checkpoint.runtime_build_identity
		?? WORKBENCH_RUNTIME_BUILD_IDENTITY.source_hash;
	const inheritedRecipeRunIds = checkpointRecovery?.checkpoint.completed_recipe_run_ids ?? [];
	for (;;) {
		let currentAttempt: WorkerRunResult;
		try {
			currentAttempt = await (input.runWorker ?? runPinnedWorker)({
				projectRoot: checked.projectRoot,
				contract: workerTask(checked.contract),
				runtimeIdentity: {
					delegationId: checked.delegationId,
					contractHash: checked.contract.contract_hash,
					...(input.checkoutOperationToken === undefined
						? {}
						: { checkoutOperationToken: input.checkoutOperationToken }),
				},
				timeoutMs: checked.contract.timeout_seconds * 1_000,
				signal: input.signal,
				onProgress: input.onProgress,
				spendProfile: executionSpendProfile,
				attempt,
				...(initialSpendState === undefined ? {} : { initialSpendState }),
				...(continuationCapsule === undefined ? {} : { continuationCapsule }),
				...(initialWriteJournalObservation === undefined ? {} : { initialWriteJournalObservation }),
			});
		} catch (error) {
			const preflightCode = workerRunnerPreflightFailureCode(error);
			const recoveryReason = preflightCode === "REPAIR_AUTHORITY_UNAVAILABLE"
				? RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRepairAuthorityUnavailable
				: preflightCode === "REPAIR_AUTHORITY_INVALID"
					? RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRepairAuthorityInvalid
					: preflightCode === "REPAIR_CAPSULE_TOO_LARGE"
						? RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRepairCapsuleTooLarge
						: RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRunnerFailed;
			state = await attemptRecovery(checked, state, input.clock, storageOptions, recoveryReason);
			return failure("runner_failed", checked, input, {
				durable_state: state,
				...(preflightCode === undefined ? {} : { runner_preflight_failure_code: preflightCode }),
			});
		}
		if (!fixedWorkerIdentity(currentAttempt)) {
			state = await attemptRecovery(checked, state, input.clock, storageOptions,
				RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerIdentityInvalid);
			return failure("worker_identity_invalid", checked, input, { durable_state: state });
		}
		workerAttempts.push(currentAttempt);
		const aggregate = aggregateWorkerAttempts(
			workerAttempts,
			checkpointRecovery?.checkpoint.cumulative_usage,
			baselineWriteObservation,
		);
		if (aggregate === undefined || aggregate.commandEffectObservation === undefined) {
			state = await attemptRecovery(checked, state, input.clock, storageOptions,
				RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRunnerFailed);
			return failure("checkpoint_failed", checked, input, { durable_state: state });
		}
		const currentFailure = workerRunFailure(currentAttempt);
		const cumulativeHard = currentAttempt.spendHardExceeded.turns
			|| currentAttempt.spendHardExceeded.totalTokens || currentAttempt.spendHardExceeded.outputTokens;
		if (cumulativeHard) {
			const checkpointAt = safeClock(input.clock);
			const checkpoint: Readonly<WorkerCheckpointV1> | undefined = checkpointAt === undefined ? undefined : await buildDurableWorkerCheckpoint(
				checked, changeSetPrepared, aggregate, aggregate.commandEffectObservation, attempt,
				parentCheckpointHash, "PAUSED_BUDGET", checkpointAt, input.exec, storageOptions,
				checkpointRuntimeIdentity, inheritedRecipeRunIds, budgetPromotion,
			);
			if (checkpoint === undefined) {
				state = await attemptRecovery(checked, state, input.clock, storageOptions,
					RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRunnerFailed);
				return failure("checkpoint_failed", checked, input, { durable_state: state });
			}
			state = await attemptRecovery(
				checked,
				state,
				input.clock,
				storageOptions,
				BUDGET_PAUSED_RECOVERY_REASON_V2,
			);
			releaseIncompleteOwner = true;
			return {
				ok: true,
				status: "PAUSED_BUDGET",
				delegation_id: checked.delegationId,
				before: structuredClone(preparedBefore),
				durable_state: structuredClone(state),
				checkpoint,
				worker_failure_code: currentFailure?.code,
			};
		}
		if (currentAttempt.checkpointRequest !== undefined) {
			if (currentFailure !== undefined || currentAttempt.checkpointRequest.attempt !== attempt) {
				state = await attemptRecovery(checked, state, input.clock, storageOptions,
					RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRunnerFailed);
				return failure("checkpoint_failed", checked, input, { durable_state: state });
			}
			const checkpointAt = safeClock(input.clock);
			const checkpoint: Readonly<WorkerCheckpointV1> | undefined = checkpointAt === undefined ? undefined : await buildDurableWorkerCheckpoint(
				checked, changeSetPrepared, aggregate, aggregate.commandEffectObservation, attempt,
				parentCheckpointHash, "CHECKPOINTED", checkpointAt, input.exec, storageOptions,
				checkpointRuntimeIdentity, inheritedRecipeRunIds, budgetPromotion,
			);
			if (checkpoint === undefined) {
				state = await attemptRecovery(checked, state, input.clock, storageOptions,
					RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRunnerFailed);
				return failure("checkpoint_failed", checked, input, { durable_state: state });
			}
			const currentGuard = await collectWorkspaceGuard({ project_root: checked.projectRoot, exec: input.exec });
			const capsule = workerCheckpointContinuationCapsuleV1(checkpoint);
			if (!currentGuard.ok || capsule === undefined || !validateWorkerCheckpointContinuationV1(checkpoint, {
				delegation_id: checked.delegationId,
				contract_hash: checked.contract.contract_hash,
				runtime_build_identity: checkpointRuntimeIdentity,
				expected_attempt: attempt,
				parent_checkpoint_hash: parentCheckpointHash,
				before_binding_hash: changeSetPrepared.before_guard.workspace_guard_hash,
				current_binding_hash: currentGuard.guard.workspace_guard_hash,
				allowed_paths: checked.contract.allowed_paths,
				active_attempt: false,
			})) {
				state = await attemptRecovery(checked, state, input.clock, storageOptions,
					RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRunnerFailed);
				return failure("checkpoint_failed", checked, input, { durable_state: state, checkpoint });
			}
			parentCheckpointHash = checkpoint.checkpoint_hash;
			initialSpendState = {
				turns: checkpoint.cumulative_turns,
				totalTokens: checkpoint.cumulative_usage.totalTokens,
				outputTokens: checkpoint.cumulative_usage.output,
			};
			continuationCapsule = capsule;
			initialWriteJournalObservation = aggregate.writeJournalObservation;
			attempt += 1;
			continue;
		}
		worker = aggregate;
		break;
	}
	if (worker === undefined) {
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRunnerFailed);
		return failure("runner_failed", checked, input, { durable_state: state });
	}
	const runnerFailure = workerRunFailure(worker);
	// Provider transport/identity success is independent from the overall
	// worker outcome. A locally enforced budget/timeout/report failure after
	// verified Luna assistant messages must never become PROVIDER_NOT_SUCCESS.
	const providerSucceeded = fixedWorkerIdentity(worker) && worker.turns > 0;
	let changeSetLifecycle: Readonly<FinalizedDelegationChangeSetLifecycleV2>;
	try {
		const finalizedLifecycle = await finalizeDelegationChangeSetLifecycleV2({
			prepared: changeSetPrepared,
			observation: worker.writeJournalObservation,
			command_effect_observation: worker.commandEffectObservation,
			exec: input.exec,
		});
		if (!finalizedLifecycle.ok) throw new Error("change set finalize failed");
		changeSetLifecycle = finalizedLifecycle.value;
	} catch {
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			RETRYABLE_EMPTY_RECOVERY_REASONS_V2.changeSetFinalizeFailed);
		return failure("change_set_finalize_failed", checked, input, { durable_state: state });
	}

	const workspaceFacts = deriveFinalizedDelegationWorkspaceFactsV2(changeSetLifecycle);
	if (!workspaceFacts.ok || changeSetLifecycle.command_provenance === undefined) {
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			RETRYABLE_EMPTY_RECOVERY_REASONS_V2.afterFactsConflict);
		return failure("after_failed", checked, input, { durable_state: state });
	}
	const before = workspaceFacts.value.before;
	const after = workspaceFacts.value.after;
	const commandProvenance = changeSetLifecycle.command_provenance;
	const workerFailureCode: WorkerRunFailureCode | null = runnerFailure?.code ??
		(commandProvenance.terminal_reasons.includes("COMMAND_EFFECT_RUN_FAILED")
			? "COMMAND_EFFECT_RUN_FAILED"
			: null);
	const succeeded = workerFailureCode === null;

	let report: ReturnType<typeof deriveDelegationPersistedReportV2>;
	try {
		report = deriveDelegationPersistedReportV2(worker.reportText, checked.secrets);
	} catch {
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerReportInvalid);
		return failure("report_invalid", checked, input, { durable_state: state });
	}
	if (!report.ok) {
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerReportInvalid);
		return failure("report_invalid", checked, input, { durable_state: state });
	}
	const changedPaths = [...commandProvenance.effective_paths];
	const deltaHash = checked.contract.task_kind === "implementation"
		? commandProvenance.effective_delta_hash
		: null;
	const successfulWriteCount = changeSetLifecycle.sealed_journal.operations.filter((operation) =>
		operation.status === "completed" && operation.outcome === "succeeded").length;
	const scopeComplete = changedPaths.every((path) => delegationPathAllowedV2(path, checked.contract.allowed_paths));
	const committingAt = safeClock(input.clock);
	if (committingAt === undefined) {
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			RETRYABLE_EMPTY_RECOVERY_REASONS_V2.commitTimeUnavailable);
		return failure("commit_state_failed", checked, input, { durable_state: state });
	}
	const committing = await persistCommittingDelegationTransaction(checked.projectRoot, {
		delegation_id: checked.delegationId,
		contract_hash: checked.contract.contract_hash,
		worker_identity: checked.workerIdentity,
		expected_generation: state.generation,
		expected_revision: state.revision,
		now: committingAt,
		outcome: {
			delegation_id: checked.delegationId,
			task_kind: checked.contract.task_kind,
			worker_identity: { ...checked.workerIdentity },
			provider_success: providerSucceeded,
			worker_success: succeeded,
			worker_failure_code: workerFailureCode,
			exit_code: worker.exitCode,
			report_complete: report.value.report_complete,
			terminal_facts_complete: true,
			scope_complete: scopeComplete,
			change_set_status: commandProvenance.effective_status,
			changed_paths: changedPaths,
			successful_write_count: successfulWriteCount,
			denied_write_count: worker.deniedWriteCount,
			delta_hash: deltaHash,
		},
	}, storageOptions).catch(() => undefined);
	if (committing === undefined || !committing.ok) {
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			RETRYABLE_EMPTY_RECOVERY_REASONS_V2.commitPersistFailed);
		return failure("commit_state_failed", checked, input, { durable_state: state });
	}
	state = committing.value;

	let reviewEnvelope: SemanticReviewEnvelopeV1 | undefined;
	const reviewPaths = delegationRepairReviewPathsV1(changedPaths, state.repair_lineage);
	const reviewEnvelopeRequired = checked.contract.task_kind === "implementation" &&
		(state.postcondition_reasons.length === 0 || (state.terminal_outcome !== null &&
			isDelegationInterruptedCandidateV2(state, state.terminal_outcome))) &&
		state.terminal_outcome?.terminal_facts_complete === true && state.terminal_outcome.scope_complete === true;
	if (reviewEnvelopeRequired) {
		if (reviewPaths === undefined || reviewPaths.length === 0) {
			state = await attemptRecovery(checked, state, input.clock, storageOptions,
				"committed artifact construction failed: review_envelope_exceeded");
			return failure("artifact_failed", checked, input, {
				durable_state: state,
				artifact_error_code: "review_envelope_exceeded",
				after: cloneAfter(after),
			});
		}
		const relevance = await collectReviewRelevanceV2({
			project_root: checked.projectRoot,
			delegation_id: checked.delegationId,
			contract_hash: checked.contract.contract_hash,
			after_guard: changeSetLifecycle.after_guard,
			change_set: changeSetLifecycle.change_set,
			command_provenance: commandProvenance,
			exec: input.exec,
		}).catch(() => undefined);
		const relevanceStatuses = relevance?.ok
			? Object.fromEntries(relevance.value.projection.entries.map((entry) => [entry.path, entry.status]))
			: {};
		const relevanceDigests = relevance?.ok
			? Object.fromEntries(relevance.value.projection.entries.flatMap((entry) =>
				entry.full_identity.kind === "file" ? [[entry.path, entry.full_identity.sha256] as const] : []))
			: {};
		const envelope = relevance?.ok
			? await preflightSemanticReviewEnvelopeV1({
				projectRoot: checked.projectRoot,
				workerPaths: reviewPaths,
				allowedPaths: checked.contract.allowed_paths,
				...(state.repair_lineage === undefined ? {} : {
					lineageCarriedPaths: state.repair_lineage.carried_paths,
				}),
				afterDigests: relevanceDigests,
				pathStatuses: relevanceStatuses,
				relevanceProjection: relevance.value.projection,
				relevanceProjectionHash: relevance.value.binding.projection_hash,
				exec: input.exec,
				secrets: checked.secrets,
			})
			: undefined;
		if (envelope === undefined || !envelope.ok) {
			state = await attemptRecovery(checked, state, input.clock, storageOptions,
				"committed artifact construction failed: review_envelope_exceeded");
			return failure("artifact_failed", checked, input, {
				durable_state: state,
				artifact_error_code: "review_envelope_exceeded",
				after: cloneAfter(after),
			});
		}
		reviewEnvelope = envelope.value;
	}

	let artifacts: ReturnType<typeof buildDelegationCommittedArtifactsV2>;
	try {
		const ledgerWorker = ledgerWorkerFacts(worker, workerFailureCode, report.value.persisted_text, checked.secrets);
		artifacts = buildDelegationCommittedArtifactsV2({
			transaction: state,
			contract: checked.contract,
			before,
			after,
			changeSetLifecycle,
			worker: ledgerWorker,
			...(budgetPromotion === undefined ? {} : { budgetPromotion }),
			reportText: worker.reportText,
			secrets: checked.secrets,
			...(reviewEnvelope === undefined ? {} : { reviewEnvelope }),
		});
	} catch {
		const artifactErrorCode = "internal_error" as const;
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			`committed artifact construction failed: ${artifactErrorCode}`);
		const safeAfter = cloneAfterIfSafe(after);
		return failure("artifact_failed", checked, input, {
			durable_state: state,
			artifact_error_code: artifactErrorCode,
			...(safeAfter === undefined ? {} : { after: safeAfter }),
		});
	}
	if (!artifacts.ok) {
		const artifactErrorCode = artifacts.error.code;
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			`committed artifact construction failed: ${artifactErrorCode}`);
		const safeAfter = cloneAfterIfSafe(after);
		return failure("artifact_failed", checked, input, {
			durable_state: state,
			artifact_error_code: artifactErrorCode,
			...(safeAfter === undefined ? {} : { after: safeAfter }),
		});
	}

	const commitAt = safeClock(input.clock);
	if (commitAt === undefined) {
		state = await attemptRecovery(checked, state, input.clock, storageOptions, "generation commit time was unavailable");
		return failure("generation_commit_failed", checked, input, { durable_state: state, after: cloneAfter(after) });
	}
	const committed = await commitDelegationGeneration(checked.projectRoot, {
		delegation_id: checked.delegationId,
		contract_hash: checked.contract.contract_hash,
		worker_identity: checked.workerIdentity,
		expected_generation: state.generation,
		expected_revision: state.revision,
		now: commitAt,
		records: artifacts.value.records,
	}, storageOptions).catch(() => undefined);
	if (committed === undefined || !committed.ok) {
		state = await attemptRecovery(checked, state, input.clock, storageOptions, "generation commit or publish failed");
		return failure("generation_commit_failed", checked, input, { durable_state: state, after: cloneAfter(after) });
	}
	state = committed.value;
	const result = machineResult(artifacts.value.workerSummary, worker.deniedWriteCount, artifacts.value.reportComplete);
	const common = {
		durable_state: structuredClone(state),
		after: cloneAfter(after),
		result,
		workerSummary: structuredClone(artifacts.value.workerSummary),
		...(workerFailureCode === null ? {} : { worker_failure_code: workerFailureCode }),
	};
	const expectedSuccess = checked.contract.task_kind === "implementation" ? "PENDING_REVIEW" : "FINISHED";
	if (succeeded && state.status === expectedSuccess) {
		return {
			ok: true,
			status: expectedSuccess,
			delegation_id: checked.delegationId,
			before: structuredClone(before),
			...common,
		};
	}
	if (state.status === "INTERRUPTED" || state.status === "FAILED" || state.status === "RECOVERY_REQUIRED") {
		return failure("postconditions_failed", checked, input, common);
	}
	return failure("unexpected_terminal_state", checked, input, common);
	} finally {
		// A still-incomplete state retains the owner as crash evidence. Terminal
		// states remove only the exact token; cleanup never downgrades a result.
		if (releaseIncompleteOwner || (state.status !== "PREPARED" && state.status !== "RUNNING" && state.status !== "COMMITTING")) {
			await releaseDelegationExecutionOwnerV2(
				checked.projectRoot,
				state,
				owner.value.token,
				ownerOptions,
			).catch(() => undefined);
		}
	}
}
