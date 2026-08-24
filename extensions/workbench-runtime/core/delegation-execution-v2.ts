/**
 * Delegation-v2 execution orchestration.
 *
 * This controller is intentionally independent of the Pi runtime. It owns
 * lifecycle ordering and dependency injection only: the pure state machine,
 * transactional storage, artifact builder, worker runner, and git collector
 * remain the single owners of their respective decisions.
 */

import { isAbsolute, posix } from "node:path";

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
	persistRunningDelegationTransaction,
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
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
	DELEGATION_TRANSACTION_WORKER_ID_RE,
	delegationPathAllowedV2,
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
import { isStrictStreamingIdentityPath } from "./streaming-identity.ts";
import { truncateUtf8 } from "../worker/handoff.ts";
import {
	runPinnedWorker,
	workerRunFailure,
	type RunWorkerOptions,
	type WorkerRunFailureCode,
	type WorkerProgress,
	type WorkerRunResult,
} from "../worker/runner.ts";
import { collectReviewRelevanceV2 } from "./review-relevance-v2.ts";
import { preflightSemanticReviewEnvelopeV1 } from "./diff-review.ts";
import type { SemanticReviewEnvelopeV1 } from "./semantic-review-envelope.ts";

export type DelegationExecutionV2FailureCode =
	| "invalid_input"
	| "prepare_failed"
	| "change_set_prepare_failed"
	| "prepared_callback_failed"
	| "start_failed"
	| "runner_failed"
	| "worker_identity_invalid"
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
	onPrepared?: (
		state: DelegationTransactionRecord,
		before: Readonly<DelegationWorkspaceGitFactsV2>,
	) => void | Promise<void>;
	/** Explicit argv-only execution dependency used by the default collector. */
	exec?: ExecFn;
	runWorker?: RunDelegationWorkerV2;
	collectAfter?: CollectDelegationAfterV2;
	storageOptions?: DelegationTransactionStorageOptions;
	/** Test seam for boot identity; storage remains bound to storageOptions. */
	executionOwnerOptions?: Omit<DelegationExecutionOwnerOptionsV2, "storage_options">;
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
	/** Bounded builder category; raw builder messages are never exposed. */
	artifact_error_code?: DelegationArtifactErrorCode | "internal_error";
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
		(!Array.isArray(input.secrets) || !input.secrets.every((secret) => typeof secret === "string")))) return undefined;
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
	succeeded: boolean,
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
		status: succeeded ? "success" : "failure",
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

/** Execute one fresh generation-1 delegation under the v2 transaction. */
export async function executeDelegationV2(input: ExecuteDelegationV2Input): Promise<DelegationExecutionV2Result> {
	const checked = checkInput(input);
	if (checked === undefined) return failure("invalid_input", undefined, input);
	const storageOptions = input.storageOptions;
	const preparedAt = safeClock(input.clock);
	if (preparedAt === undefined) return failure("prepare_failed", checked, input);
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
	let state = prepared.value;
	const ownerAt = safeClock(input.clock);
	if (ownerAt === undefined) {
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
		if (owner !== undefined && !owner.ok && owner.error.owner_absent === true) {
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
	try {
	let changeSetPrepared: Readonly<PreparedDelegationChangeSetLifecycleV2>;
	if (input.exec === undefined) {
		state = await attemptPreparedAbort(checked, state, input.clock, storageOptions,
			RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.changeSetPreparationFailed);
		return failure("change_set_prepare_failed", checked, input, { durable_state: state });
	}
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
	const preparedBeforeResult = derivePreparedDelegationWorkspaceBeforeV2(changeSetPrepared);
	if (!preparedBeforeResult.ok) {
		state = await attemptPreparedAbort(checked, state, input.clock, storageOptions,
			RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.guardBeforeFailed);
		return failure("change_set_prepare_failed", checked, input, { durable_state: state });
	}
	const preparedBefore = preparedBeforeResult.value;

	if (input.onPrepared !== undefined) {
		try {
			await input.onPrepared(structuredClone(state), structuredClone(preparedBefore));
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
		state = await attemptPreparedAbort(checked, state, input.clock, storageOptions,
			RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.runningTimeUnavailable);
		return failure("start_failed", checked, input, { durable_state: state });
	}
	const running = await persistRunningDelegationTransaction(checked.projectRoot, {
		delegation_id: checked.delegationId,
		contract_hash: checked.contract.contract_hash,
		worker_identity: checked.workerIdentity,
		expected_generation: state.generation,
		expected_revision: state.revision,
		now: runningAt,
	}, storageOptions).catch(() => undefined);
	if (running === undefined || !running.ok) {
		state = await attemptPreparedAbort(checked, state, input.clock, storageOptions,
			RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.runningPersistFailed);
		return failure("start_failed", checked, input, { durable_state: state });
	}
	state = running.value;

	let worker: WorkerRunResult;
	try {
		worker = await (input.runWorker ?? runPinnedWorker)({
			projectRoot: checked.projectRoot,
			contract: workerTask(checked.contract),
			runtimeIdentity: {
				delegationId: checked.delegationId,
				contractHash: checked.contract.contract_hash,
			},
			timeoutMs: checked.contract.timeout_seconds * 1_000,
			signal: input.signal,
			onProgress: input.onProgress,
			spendProfile: checked.contract.budget_profile as WorkerSpendProfile,
		});
	} catch {
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRunnerFailed);
		return failure("runner_failed", checked, input, { durable_state: state });
	}
	if (!fixedWorkerIdentity(worker)) {
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerIdentityInvalid);
		return failure("worker_identity_invalid", checked, input, { durable_state: state });
	}
	const workerFailure = workerRunFailure(worker);
	const succeeded = workerFailure === undefined;
	// Provider transport/identity success is independent from the overall
	// worker outcome. A locally enforced budget/timeout/report failure after
	// verified Luna assistant messages must never become PROVIDER_NOT_SUCCESS.
	const providerSucceeded = fixedWorkerIdentity(worker) && worker.turns > 0;
	let changeSetLifecycle: Readonly<FinalizedDelegationChangeSetLifecycleV2>;
	try {
		const finalizedLifecycle = await finalizeDelegationChangeSetLifecycleV2({
			prepared: changeSetPrepared,
			observation: worker.writeJournalObservation,
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
	if (!workspaceFacts.ok) {
		state = await attemptRecovery(checked, state, input.clock, storageOptions,
			RETRYABLE_EMPTY_RECOVERY_REASONS_V2.afterFactsConflict);
		return failure("after_failed", checked, input, { durable_state: state });
	}
	const before = workspaceFacts.value.before;
	const after = workspaceFacts.value.after;

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
	const changedPaths = changeSetLifecycle.change_set.worker_delta.map((entry) => entry.path);
	const deltaHash = checked.contract.task_kind === "implementation"
		? changeSetLifecycle.change_set.worker_delta_hash
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
			exit_code: worker.exitCode,
			report_complete: report.value.report_complete,
			terminal_facts_complete: true,
			scope_complete: scopeComplete,
			change_set_status: changeSetLifecycle.change_set.status,
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
	if (checked.contract.task_kind === "implementation" && changedPaths.length > 0 &&
		state.postcondition_reasons.length === 0 && state.terminal_outcome?.terminal_facts_complete === true &&
		state.terminal_outcome.scope_complete === true) {
		const relevance = await collectReviewRelevanceV2({
			project_root: checked.projectRoot,
			delegation_id: checked.delegationId,
			contract_hash: checked.contract.contract_hash,
			after_guard: changeSetLifecycle.after_guard,
			change_set: changeSetLifecycle.change_set,
			exec: input.exec,
		}).catch(() => undefined);
		const envelope = relevance?.ok
			? await preflightSemanticReviewEnvelopeV1({
				projectRoot: checked.projectRoot,
				workerPaths: changedPaths,
				allowedPaths: checked.contract.allowed_paths,
				afterDigests: after.pathDigests,
				pathStatuses: after.pathStatuses,
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
		const ledgerWorker = ledgerWorkerFacts(worker, succeeded, report.value.persisted_text, checked.secrets);
		artifacts = buildDelegationCommittedArtifactsV2({
			transaction: state,
			contract: checked.contract,
			before,
			after,
			changeSetLifecycle,
			worker: ledgerWorker,
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
		...(workerFailure === undefined ? {} : { worker_failure_code: workerFailure.code }),
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
	if (state.status === "FAILED" || state.status === "RECOVERY_REQUIRED") {
		return failure("postconditions_failed", checked, input, common);
	}
	return failure("unexpected_terminal_state", checked, input, common);
	} finally {
		// A still-incomplete state retains the owner as crash evidence. Terminal
		// states remove only the exact token; cleanup never downgrades a result.
		if (state.status !== "PREPARED" && state.status !== "RUNNING" && state.status !== "COMMITTING") {
			await releaseDelegationExecutionOwnerV2(
				checked.projectRoot,
				state,
				owner.value.token,
				ownerOptions,
			).catch(() => undefined);
		}
	}
}
