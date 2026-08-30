import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	bindDelegationBoundedTaskContractV2,
	type DelegationBoundedTaskContractBindingV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import {
	beginRecipeCommandEffectCapture,
	completeRecipeCommandEffectCapture,
} from "../extensions/workbench-runtime/core/command-effect.ts";
import {
	executeDelegationV2,
	type ExecuteDelegationV2Input,
} from "../extensions/workbench-runtime/core/delegation-execution-v2.ts";
import {
	collectCheckpointResumeExecutionAuthorityV1,
	persistDelegationResumeAuthorityV1,
} from "../extensions/workbench-runtime/core/delegation-resume-authority.ts";
import {
	committedStructuredReviewAuthorityV2,
	reviewDelegationV2,
} from "../extensions/workbench-runtime/core/delegation-review-v2.ts";
import {
	abortPristinePreparedDelegationUnderStartLockV2,
	RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2,
	RETRYABLE_EMPTY_RECOVERY_REASONS_V2,
} from "../extensions/workbench-runtime/core/delegation-execution-owner.ts";
import {
	acquireProjectDelegationStartLockV1,
	releaseProjectDelegationStartLockV1,
} from "../extensions/workbench-runtime/core/delegation-start-lock.ts";
import {
	computeDiffHash,
	collectGitFacts,
	collectAfterFacts,
	type AfterFacts,
	type GitFacts,
} from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import {
	createNodeDelegationTransactionStorageAdapter,
	isDelegationTerminalNegativeReviewEligibleFromCommittedV1,
	isDelegationTerminalNegativeReviewEligibleV1,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTerminalNegativeSolAuthorityV1,
	readDelegationTransactionV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	closeInactiveProjectDelegationBlockerV2,
	collectCurrentDelegationBindingV2,
	readProjectDelegationBlockerV2,
	readProjectDelegationRepairClosureV1,
	readRecoverableUnpublishedDelegationV2,
} from "../extensions/workbench-runtime/core/delegation-project-authority.ts";
import { recoverExactRepairCommandAuthorityV1 } from "../extensions/workbench-runtime/core/exact-repair-authority.ts";
import {
	collectStructuredReviewPresentationV1,
	COMPACT_MIN_BYTES,
} from "../extensions/workbench-runtime/core/diff-review.ts";
import { readWorkerRepairCapsule } from "../extensions/workbench-runtime/core/worker-repair-authority.ts";
import { SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1 } from "../extensions/workbench-runtime/core/semantic-review-envelope.ts";
import {
	bindDelegationRepairLineageV1,
	type DelegationTaskKind,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION } from "../extensions/workbench-runtime/core/worker-write-journal-runtime.ts";
import { beginWriteJournalOperation, completeWriteJournalOperation } from "../extensions/workbench-runtime/core/write-journal.ts";
import { beginRunTransaction, commitRunTransaction } from "../extensions/workbench-runtime/core/run-transaction.ts";
import {
	WorkerRunnerPreflightError,
	type RunWorkerOptions,
	type WorkerRunResult,
} from "../extensions/workbench-runtime/worker/runner.ts";

const HEAD = "1".repeat(40);
const execFileAsync = promisify(execFile);
const realExec: ExecFn = async (command, args, options) => {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options?.cwd, timeout: options?.timeout, signal: options?.signal,
			encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
		});
		return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
	} catch (error) {
		const failed = error as Error & { code?: number; stdout?: string; stderr?: string; killed?: boolean };
		return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: typeof failed.code === "number" ? failed.code : 1, killed: failed.killed ?? false };
	}
};
const WORKER_IDENTITY = {
	provider: WORKER_PROVIDER,
	model: WORKER_MODEL_ID,
	worker_id: "execution-v2-worker",
} as const;

const BEFORE: GitFacts = {
	gitHead: HEAD,
	gitDirty: false,
	changedPaths: [],
	pathStatuses: {},
	pathDigests: {},
};

function id(index: number): string {
	return `20260817-1800${String(index).padStart(2, "0")}-a${String(index).padStart(3, "0")}`;
}

async function root(t: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "delegation-execution-v2-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	assert.equal((await realExec("git", ["init", "-q"], { cwd: directory })).code, 0);
	await writeFile(join(directory, "base.txt"), "base\n");
	assert.equal((await realExec("git", ["add", "--", "base.txt"], { cwd: directory })).code, 0);
	assert.equal((await realExec("git", ["-c", "user.name=Execution V2", "-c", "user.email=execution@example.invalid", "commit", "-q", "-m", "base"], { cwd: directory })).code, 0);
	return directory;
}

function clock(): () => string {
	let second = 0;
	return () => `2026-08-17T18:10:${String(second++).padStart(2, "0")}.000Z`;
}

function contract(kind: DelegationTaskKind): DelegationBoundedTaskContractBindingV2 {
	const bound = bindDelegationBoundedTaskContractV2({
		task_kind: kind,
		task: kind === "implementation" ? "Implement one bounded source change." : "Diagnose one bounded issue.",
		allowed_paths: ["src/**"],
		acceptance_criteria: ["The transaction is complete and authority-bound."],
		verification: ["npm test"],
		timeout_seconds: 600,
		budget_profile: "standard",
	});
	if (!bound.ok) throw new Error(bound.error.message);
	return bound.value;
}

function after(paths: readonly string[]): AfterFacts {
	const changedPaths = [...paths].sort();
	const pathStatuses = Object.fromEntries(changedPaths.map((path) => [path, "??"]));
	const pathDigests = Object.fromEntries(changedPaths.map((path, index) => [path, String(index + 2).repeat(64)]));
	return {
		gitHead: HEAD,
		gitDirty: changedPaths.length > 0,
		changedPaths,
		pathStatuses,
		pathDigests,
		changedSinceBefore: [...changedPaths],
		diffHash: computeDiffHash(changedPaths, pathDigests, pathStatuses),
	};
}

function completeReport(paths: readonly string[]): string {
	return [
		"## Completed",
		"- Completed the bounded worker task.",
		"## Files Changed",
		...(paths.length === 0 ? ["- None."] : paths.map((path) => `- \`${path}\``)),
		"## Verification",
		"- `npm test` — pass",
		"## Remaining Risks",
		"- None.",
	].join("\n");
}

function worker(report: string, patch: Partial<WorkerRunResult> = {}): WorkerRunResult {
	return {
		exitCode: 0,
		provider: WORKER_PROVIDER,
		model: WORKER_MODEL_ID,
		turns: 2,
		stopReason: "end_turn",
		output: report,
		reportText: report,
		reportTextOversized: false,
		stderr: "",
		aborted: false,
		timedOut: false,
		deniedWriteCount: 0,
		usage: {
			input: 100,
			output: 40,
			cacheRead: 20,
			cacheWrite: 0,
			totalTokens: 160,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, total: 3.1 },
		},
		cacheHitRatio: 1 / 6,
		maxContextTokens: 160,
		maxContextRatio: 0.00016,
		softBudgetReached: false,
		hardBudgetExceeded: false,
		compactionCount: 0,
		compactionReasons: [],
		spendProfile: "standard",
		spendState: { turns: 2, totalTokens: 160, outputTokens: 40 },
		spendBand: "ok",
		spendReasons: [],
		spendSoftReached: { turns: false, totalTokens: false, outputTokens: false },
		spendHardExceeded: { turns: false, totalTokens: false, outputTokens: false },
		writeJournalObservation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
		...patch,
	};
}

async function journalWorker(
	projectRoot: string,
	delegationId: string,
	contractHash: string,
	paths: readonly string[],
	result: WorkerRunResult,
	outcome: "succeeded" | "failed" = "succeeded",
): Promise<WorkerRunResult> {
	let revision = 0;
	let observation = EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION;
	for (let index = 0; index < paths.length; index += 1) {
		const path = paths[index]!;
		const operationId = (index + 1).toString(16).padStart(64, "0");
		const begun = await beginWriteJournalOperation({
			project_root: projectRoot, delegation_id: delegationId, contract_hash: contractHash,
			expected_revision: revision, operation_id: operationId, kind: "write", path,
		});
		if (!begun.ok) throw new Error(`journal begin failed:${begun.error.code}`);
		revision = begun.value.revision;
		await mkdir(dirname(join(projectRoot, path)), { recursive: true });
		await writeFile(join(projectRoot, path), `worker:${path}\n`);
		const completed = await completeWriteJournalOperation({
			project_root: projectRoot, delegation_id: delegationId, contract_hash: contractHash,
			expected_revision: revision, operation_id: operationId, kind: "write", path, outcome,
		});
		if (!completed.ok) throw new Error(`journal completion failed:${completed.error.code}`);
		revision = completed.value.revision;
		observation = Object.freeze({ state: "complete", tool: "write", outcome, code: "none", revision });
	}
	return { ...structuredClone(result), writeJournalObservation: observation };
}

async function createThenEditWorker(
	projectRoot: string,
	delegationId: string,
	contractHash: string,
	path: string,
	result: WorkerRunResult,
): Promise<WorkerRunResult> {
	let revision = 0;
	for (const [index, kind] of (["write", "edit"] as const).entries()) {
		const operationId = (index + 1).toString(16).padStart(64, "a");
		const begun = await beginWriteJournalOperation({
			project_root: projectRoot, delegation_id: delegationId, contract_hash: contractHash,
			expected_revision: revision, operation_id: operationId, kind, path,
		});
		if (!begun.ok) throw new Error(`journal begin failed:${begun.error.code}`);
		revision = begun.value.revision;
		await mkdir(dirname(join(projectRoot, path)), { recursive: true });
		await writeFile(join(projectRoot, path), index === 0 ? "first worker version\n" : "final worker version\n");
		const completed = await completeWriteJournalOperation({
			project_root: projectRoot, delegation_id: delegationId, contract_hash: contractHash,
			expected_revision: revision, operation_id: operationId, kind, path, outcome: "succeeded",
		});
		if (!completed.ok) throw new Error(`journal completion failed:${completed.error.code}`);
		revision = completed.value.revision;
	}
	return {
		...structuredClone(result),
		writeJournalObservation: Object.freeze({ state: "complete", tool: "edit", outcome: "succeeded", code: "none", revision }),
	};
}

async function commitCleanWorkerRecipe(
	projectRoot: string,
	delegationId: string,
	contractHash: string,
	options: {
		runId: string;
		recipe: string;
		startedAt: string;
		finishedAt: string;
		outcome: "SUCCESS" | "PROCESS_FAILED";
		mutate?: () => Promise<void>;
		expectedEffectStatus?: "CLEAN" | "RECIPE_DECLARATION_VIOLATION";
	},
): Promise<void> {
	const started = await beginRecipeCommandEffectCapture({
		project_root: projectRoot,
		exec: realExec,
		declared_writes: [],
	});
	await options.mutate?.();
	const effect = await completeRecipeCommandEffectCapture({
		project_root: projectRoot,
		exec: realExec,
		started,
		run_id: options.runId,
		recipe: options.recipe,
		actor: "worker",
		worker_delegation_id: delegationId,
		worker_contract_hash: contractHash,
		mutation_declaration: "none",
		declared_writes: [],
	});
	assert.equal(effect.status, options.expectedEffectStatus ?? "CLEAN");
	const transaction = await beginRunTransaction(projectRoot, options.runId);
	const manifest = {
		schema_version: 2,
		run_id: options.runId,
		recipe: effect.recipe,
		profile: "generic",
		started_at: options.startedAt,
		finished_at: options.finishedAt,
		duration_ms: Date.parse(options.finishedAt) - Date.parse(options.startedAt),
		cwd: projectRoot,
		argv: ["fixture-check"],
		exit_code: options.outcome === "SUCCESS" ? 0 : 2,
		timed_out: false,
		cancelled: false,
		git_commit: null,
		git_dirty: true,
		artifact_paths: [],
		stdout_truncated: false,
		stderr_truncated: false,
		mode: "DEV",
		expected_exit_codes: [0],
		declared_writes: [],
		environment_names: [],
		validation_components: [],
		cache_request_mode: "no-cache",
		run_transaction_schema_version: 2,
		run_outcome: options.outcome,
		command_effect_path: "command-effect.json",
		command_effect_hash: effect.command_effect_hash,
		command_effect_status: effect.status,
	};
	await Promise.all([
		writeFile(join(transaction.stagingDir, "manifest.json"), JSON.stringify(manifest), "utf8"),
		writeFile(join(transaction.stagingDir, "command-effect.json"), JSON.stringify(effect), "utf8"),
		writeFile(join(transaction.stagingDir, "command.json"), "{}", "utf8"),
		writeFile(join(transaction.stagingDir, "environment.json"), "{}", "utf8"),
		writeFile(join(transaction.stagingDir, "summary.json"), "{}", "utf8"),
		writeFile(join(transaction.stagingDir, "stdout.log"), "expected validation failure\n", "utf8"),
		writeFile(join(transaction.stagingDir, "stderr.log"), "", "utf8"),
	]);
	await commitRunTransaction(transaction, new Date(options.finishedAt));
}

async function commitFailedCleanWorkerRecipe(
	projectRoot: string,
	delegationId: string,
	contractHash: string,
): Promise<void> {
	await commitCleanWorkerRecipe(projectRoot, delegationId, contractHash, {
		runId: "20260827-185440-tf01",
		recipe: "expected-no-write-check",
		startedAt: "2026-08-27T11:54:40.123Z",
		finishedAt: "2026-08-27T11:54:40.193Z",
		outcome: "PROCESS_FAILED",
	});
}

async function input(
	projectRoot: string,
	delegationId: string,
	kind: DelegationTaskKind,
	afterFacts: AfterFacts,
	workerResult: WorkerRunResult,
	patch: Partial<ExecuteDelegationV2Input> = {},
): Promise<ExecuteDelegationV2Input> {
	const boundContract = patch.contract ?? contract(kind);
	const before = await collectGitFacts(projectRoot, realExec);
	return {
		projectRoot,
		delegationId,
		contract: boundContract,
		before,
		workerIdentity: { ...WORKER_IDENTITY },
		clock: clock(),
		exec: realExec,
		runWorker: async () => journalWorker(projectRoot, delegationId, boundContract.contract_hash, afterFacts.changedSinceBefore, workerResult),
		...patch,
	};
}

test("execution v2: implementation commits PENDING_REVIEW and strict reader returns the same generation", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(1);
	const report = completeReport(["src/changed.ts"]);
	const executionInput = await input(projectRoot, delegationId, "implementation", after(["src/changed.ts"]), worker(report), {
		secrets: ["not-present"],
	});
	const ownerPath = join(projectRoot, CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2", "execution-owner.json");
	const originalRunner = executionInput.runWorker!;
	let ownerObserved = false;
	executionInput.runWorker = async (options) => {
		const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
		assert.equal(owner.delegation_id, delegationId);
		assert.equal(owner.contract_hash, executionInput.contract.contract_hash);
		assert.equal(owner.process_id, process.pid);
		ownerObserved = true;
		return originalRunner(options);
	};
	const inputSnapshot = {
		contract: structuredClone(executionInput.contract),
		before: structuredClone(executionInput.before),
		workerIdentity: structuredClone(executionInput.workerIdentity),
		secrets: structuredClone(executionInput.secrets),
	};
	const result = await executeDelegationV2(executionInput);
	assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result));
	if (!result.ok) return;
	assert.equal(result.status, "PENDING_REVIEW");
	assert.equal(ownerObserved, true);
	await assert.rejects(access(ownerPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	assert.equal(result.durable_state.status, "PENDING_REVIEW");
	assert.deepEqual(result.after.changedSinceBefore, ["src/changed.ts"]);
	assert.equal(result.result.provider, WORKER_PROVIDER);
	assert.equal(result.result.model, WORKER_MODEL_ID);
	assert.equal(result.result.reportComplete, true);
	assert.equal(result.result.deniedWriteCount, 0);
	assert.equal(Object.prototype.hasOwnProperty.call(result.result, "output"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(result.result, "reportText"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(result.result, "stderr"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(result.result, "errorMessage"), false);
	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, true);
	if (!committed.ok) return;
	assert.equal(committed.value.state.status, "PENDING_REVIEW");
	assert.equal(committed.value.state.terminal_outcome?.worker_success, true);
	assert.equal(committed.value.state.terminal_outcome?.worker_failure_code, null);
	assert.deepEqual(committed.value.records["worker-summary.json"], result.workerSummary);
	assert.equal(committed.value.records["worker-report.md"], report);
	assert.deepEqual((committed.value.records["usage.json"] as { usage: unknown }).usage, result.workerSummary.usage);
	const scope = committed.value.records["scope.json"] as Record<string, any>;
	const afterRecord = committed.value.records["after.json"] as Record<string, any>;
	const usageRecord = committed.value.records["usage.json"] as Record<string, any>;
	assert.equal(afterRecord.worker_success, true);
	assert.equal(afterRecord.worker_failure_code, null);
	assert.equal(usageRecord.worker_success, true);
	assert.equal(usageRecord.worker_failure_code, null);
	assert.equal(result.workerSummary.worker_success, true);
	assert.equal(result.workerSummary.worker_failure_code, null);
	assert.equal(scope.write_journal.state, "SEALED");
	assert.equal(scope.change_set.status, "ATTRIBUTED");
	assert.equal(afterRecord.worker_delta_hash, scope.change_set.worker_delta_hash);
	assert.equal(afterRecord.workspace_guard_hash, scope.change_set.workspace_guard_hash);
	assert.equal(afterRecord.change_set_hash, scope.change_set.change_set_hash);
	assert.deepEqual(inputSnapshot, {
		contract: executionInput.contract,
		before: executionInput.before,
		workerIdentity: executionInput.workerIdentity,
		secrets: executionInput.secrets,
	});
});

test("execution v2: a failed CLEAN recipe fails the worker without inventing workspace drift", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(52);
	const path = "src/command-failure.ts";
	const report = [
		"## Completed",
		"- Completed the bounded source change.",
		"## Files Changed",
		`- \`${path}\``,
		"## Verification",
		"- expected-no-write-check — failed because a later promotion has not run",
		"## Remaining Risks",
		"- Promotion remains pending.",
	].join("\n");
	const executionInput = await input(projectRoot, delegationId, "implementation", after([path]), worker(report));
	executionInput.runWorker = async () => {
		const result = await journalWorker(
			projectRoot,
			delegationId,
			executionInput.contract.contract_hash,
			[path],
			worker(report),
		);
		await commitFailedCleanWorkerRecipe(projectRoot, delegationId, executionInput.contract.contract_hash);
		return result;
	};
	const result = await executeDelegationV2(executionInput);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "postconditions_failed");
	assert.equal(result.durable_state?.status, "FAILED");
	assert.deepEqual(result.durable_state?.postcondition_reasons, ["WORKER_RUN_FAILED"]);
	assert.equal(result.durable_state?.terminal_outcome?.worker_success, false);
	assert.equal(result.durable_state?.terminal_outcome?.worker_failure_code, "COMMAND_EFFECT_RUN_FAILED");
	assert.equal(result.durable_state?.terminal_outcome?.change_set_status, "ATTRIBUTED");
	assert.equal(result.worker_failure_code, "COMMAND_EFFECT_RUN_FAILED");

	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, true, committed.ok ? "" : committed.error.code);
	if (!committed.ok) return;
	assert.equal(isDelegationTerminalNegativeReviewEligibleV1(committed.value.state), true);
	const scope = committed.value.records["scope.json"] as Record<string, any>;
	assert.equal(scope.change_set.status, "ATTRIBUTED");
	assert.equal(scope.command_provenance.effective_status, "ATTRIBUTED");
	assert.deepEqual(scope.command_provenance.remaining_workspace_drift, []);
	assert.deepEqual(scope.command_provenance.terminal_reasons, ["COMMAND_EFFECT_RUN_FAILED"]);
});

test("execution v2: a historical undeclared recipe mutation is REPAIR-only and carries every unsafe path", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(54);
	const workerPath = "src/historical-command-drift.ts";
	const unsafeCommandPath = "generated/undeclared-output.json";
	const bound = bindDelegationBoundedTaskContractV2({
		task_kind: "implementation",
		task: "Repair one exact historical worker path.",
		allowed_paths: [workerPath],
		acceptance_criteria: ["The worker path and every historical unsafe dependency receive explicit review."],
		verification: ["recipe:focused-check"],
		timeout_seconds: 600,
		budget_profile: "standard",
	});
	assert.equal(bound.ok, true, bound.ok ? "" : bound.error.code);
	if (!bound.ok) return;
	const report = completeReport([workerPath]);
	const executionInput = await input(
		projectRoot,
		delegationId,
		"implementation",
		after([workerPath]),
		worker(report),
		{ contract: bound.value },
	);
	executionInput.runWorker = async () => {
		const result = await journalWorker(
			projectRoot,
			delegationId,
			executionInput.contract.contract_hash,
			[workerPath],
			worker(report),
		);
		await commitCleanWorkerRecipe(projectRoot, delegationId, executionInput.contract.contract_hash, {
			runId: "20260827-185443-tf04",
			recipe: "focused-check",
			startedAt: "2026-08-27T11:54:43.000Z",
			finishedAt: "2026-08-27T11:54:43.100Z",
			outcome: "PROCESS_FAILED",
			expectedEffectStatus: "RECIPE_DECLARATION_VIOLATION",
			mutate: async () => {
				await mkdir(dirname(join(projectRoot, unsafeCommandPath)), { recursive: true });
				await writeFile(join(projectRoot, unsafeCommandPath), JSON.stringify({
					unexpected: true,
					payload: "x".repeat(COMPACT_MIN_BYTES),
				}) + "\n", "utf8");
			},
		});
		return result;
	};
	const result = await executeDelegationV2(executionInput);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.durable_state?.status, "FAILED");
	assert.equal(result.durable_state?.terminal_outcome?.change_set_status, "WORKSPACE_DRIFT");
	assert.deepEqual(result.durable_state?.terminal_outcome?.changed_paths, [workerPath]);

	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, true, committed.ok ? "" : committed.error.code);
	if (!committed.ok) return;
	assert.equal(isDelegationTerminalNegativeReviewEligibleV1(committed.value.state), false);
	assert.equal(isDelegationTerminalNegativeReviewEligibleFromCommittedV1(
		committed.value.state,
		committed.value.records,
	), true, "a complete negative generation opens REPAIR-only recovery");
	const scope = committed.value.records["scope.json"] as Record<string, any>;
	assert.deepEqual(scope.command_provenance.terminal_reasons, [
		"RECIPE_DECLARATION_VIOLATION",
		"COMMAND_EFFECT_RUN_FAILED",
	]);
	assert.deepEqual(scope.command_provenance.remaining_workspace_drift.map((entry: { path: string }) => entry.path), [
		unsafeCommandPath,
	]);

	const presented = await reviewDelegationV2({
		projectRoot,
		delegationId,
		exec: realExec,
		now: "2026-08-28T01:00:00.000Z",
	});
	assert.equal(presented.ok, true, presented.ok ? "" : JSON.stringify(presented.error));
	if (!presented.ok || presented.review.record === undefined) return;
	assert.deepEqual(presented.review.record.checked_paths, [workerPath],
		"the provisional negative review does not accept the unsafe command path");
	const repaired = await reviewDelegationV2({
		projectRoot,
		delegationId,
		exec: realExec,
		now: "2026-08-28T01:00:01.000Z",
		semanticDecision: "REPAIR",
		expectedBoundDiffHash: presented.review.record.bound_diff_hash,
		repairReason: "Repair the worker result and preserve every unsafe historical command path for final successor review.",
		reviewer: { provider: "openai", model: "gpt-5.6-sol" },
	});
	assert.equal(repaired.ok, true, repaired.ok ? "" : JSON.stringify(repaired.error));
	if (!repaired.ok) return;
	const terminal = await readDelegationTerminalNegativeSolAuthorityV1(projectRoot, delegationId);
	assert.equal(terminal.ok, true, terminal.ok ? "" : terminal.error.code);
	if (!terminal.ok) return;
	const binding = await collectCurrentDelegationBindingV2(projectRoot, delegationId, realExec);
	assert.equal(binding.status, "fresh");
	if (binding.status !== "fresh") return;
	const authority = recoverExactRepairCommandAuthorityV1({
		repairOf: delegationId,
		committed: committed.value,
		terminalNegativeRepair: terminal.value,
		currentBindingHash: binding.hash,
	});
	assert.equal(authority.ok, true, authority.ok ? "" : authority.code);
	if (!authority.ok) return;
	assert.deepEqual(authority.value.arguments.allowed_paths, [workerPath], "successor write authority stays exact");
	assert.deepEqual(authority.value.successor_lineage.carried_paths, [unsafeCommandPath, workerPath],
		"unsafe command drift is review-carried instead of silently discarded");

	const successorId = id(55);
	const successorContract = bindDelegationBoundedTaskContractV2(authority.value.arguments);
	assert.equal(successorContract.ok, true, successorContract.ok ? "" : successorContract.error.code);
	if (!successorContract.ok) return;
	let successorSecond = 2;
	const successor = await executeDelegationV2(await input(
		projectRoot,
		successorId,
		"implementation",
		after([]),
		worker(completeReport([])),
		{
			contract: successorContract.value,
			dependencyPaths: authority.value.successor_lineage.carried_paths,
			repairLineage: authority.value.successor_lineage,
			clock: () => `2026-08-28T01:01:${String(successorSecond++).padStart(2, "0")}.000Z`,
		},
	));
	assert.equal(successor.ok, true, successor.ok ? "" : JSON.stringify(successor));
	if (!successor.ok) return;
	assert.equal(successor.status, "PENDING_REVIEW");
	assert.deepEqual(successor.durable_state.terminal_outcome?.changed_paths, []);
	const successorPresented = await reviewDelegationV2({
		projectRoot,
		delegationId: successorId,
		exec: realExec,
		now: "2026-08-28T01:02:00.000Z",
	});
	assert.equal(successorPresented.ok, true, successorPresented.ok ? "" : JSON.stringify(successorPresented.error));
	if (!successorPresented.ok || successorPresented.review.record === undefined) return;
	assert.equal(successorPresented.review.record.presentation_complete, true);
	assert.deepEqual(successorPresented.review.record.checked_paths, [unsafeCommandPath, workerPath],
		"final review explicitly presents the inherited unsafe path before it can close the lineage");
	const inheritedCompact = successorPresented.review.record.patch.find((entry) => entry.path === unsafeCommandPath);
	assert.equal(inheritedCompact?.source, "compact");
	assert.equal(inheritedCompact?.truncated, true, "bounded compact previews remain honestly marked truncated");
	assert.equal(inheritedCompact?.compact?.digest_matches_after, true,
		"the carried compact packet binds the current relevance-projection digest");
	const compactProgress = successorPresented.review.record.presentation_progress?.find((item) => item.path === unsafeCommandPath);
	assert.equal(compactProgress?.source, "compact");
	assert.equal(compactProgress?.next_byte, compactProgress?.total_bytes,
		"the one-page compact fact stream is complete and never enters an impossible pagination loop");
	const successorCommitted = await readDelegationCommittedGenerationV2(projectRoot, successorId);
	const successorReview = await readDelegationReviewV2(projectRoot, successorId);
	assert.equal(successorCommitted.ok, true, successorCommitted.ok ? "" : successorCommitted.error.code);
	assert.equal(successorReview.ok, true, successorReview.ok ? "" : successorReview.error.code);
	if (!successorCommitted.ok || !successorReview.ok) return;
	const structuredAuthority = committedStructuredReviewAuthorityV2(successorCommitted.value, successorReview.value);
	assert.equal(structuredAuthority.ok, true, structuredAuthority.ok ? "" : structuredAuthority.code);
	if (!structuredAuthority.ok) return;
	const structuredPresentation = await collectStructuredReviewPresentationV1({
		projectRoot,
		authority: structuredAuthority.value.authority,
		exec: realExec,
	});
	assert.equal(structuredPresentation.ok, true, structuredPresentation.ok ? "" : structuredPresentation.code);
	if (!structuredPresentation.ok) return;
	assert.equal(structuredPresentation.value.pages.filter((page) => page.path === unsafeCommandPath).length, 1,
		"committed structured review reproduces the compact stream as one immutable page");
	const accepted = await reviewDelegationV2({
		projectRoot,
		delegationId: successorId,
		exec: realExec,
		now: "2026-08-28T01:02:01.000Z",
		semanticDecision: "ACCEPT",
		expectedBoundDiffHash: successorPresented.review.record.bound_diff_hash,
		reviewer: { provider: "openai", model: "gpt-5.6-sol" },
	});
	assert.equal(accepted.ok, true, accepted.ok ? "" : JSON.stringify(accepted.error));
	if (!accepted.ok) return;
	assert.equal(accepted.transaction.status, "REVIEWED");
	assert.deepEqual(await readProjectDelegationRepairClosureV1(projectRoot), {
		ok: true,
		unresolvedTipId: null,
		rootCount: 1,
		lineageCount: 1,
	});
	assert.deepEqual(await readProjectDelegationBlockerV2(projectRoot), { ok: true, value: null });
});

test("execution v2: the same recipe's final SUCCESS closes its earlier CLEAN process failure", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(53);
	const path = "src/command-recovered.ts";
	const report = completeReport([path]);
	const executionInput = await input(projectRoot, delegationId, "implementation", after([path]), worker(report));
	executionInput.runWorker = async () => {
		const result = await journalWorker(
			projectRoot,
			delegationId,
			executionInput.contract.contract_hash,
			[path],
			worker(report),
		);
		await commitCleanWorkerRecipe(projectRoot, delegationId, executionInput.contract.contract_hash, {
			runId: "20260827-185441-tf02",
			recipe: "expected-no-write-check",
			startedAt: "2026-08-27T11:54:41.000Z",
			finishedAt: "2026-08-27T11:54:41.100Z",
			outcome: "PROCESS_FAILED",
		});
		await commitCleanWorkerRecipe(projectRoot, delegationId, executionInput.contract.contract_hash, {
			runId: "20260827-185442-tf03",
			recipe: "expected-no-write-check",
			startedAt: "2026-08-27T11:54:42.000Z",
			finishedAt: "2026-08-27T11:54:42.100Z",
			outcome: "SUCCESS",
		});
		return result;
	};
	const result = await executeDelegationV2(executionInput);
	assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result));
	if (!result.ok) return;
	assert.equal(result.status, "PENDING_REVIEW");
	assert.equal(result.durable_state.terminal_outcome?.worker_success, true);
	assert.equal(result.durable_state.terminal_outcome?.worker_failure_code, null);
	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, true, committed.ok ? "" : committed.error.code);
	if (!committed.ok) return;
	const scope = committed.value.records["scope.json"] as Record<string, any>;
	assert.deepEqual(scope.command_provenance.receipts.map((receipt: Record<string, unknown>) => receipt.run_outcome), [
		"PROCESS_FAILED",
		"SUCCESS",
	]);
	assert.deepEqual(scope.command_provenance.terminal_reasons, []);
});

test("execution v2: an over-envelope delivery never enters PENDING and exposes strict repair_of recovery authority", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(51);
	const path = "src/over-envelope.ts";
	const report = completeReport([path]);
	const executionInput = await input(projectRoot, delegationId, "implementation", after([path]), worker(report));
	executionInput.runWorker = async () => {
		const operationId = "c".repeat(64);
		const begun = await beginWriteJournalOperation({
			project_root: projectRoot, delegation_id: delegationId, contract_hash: executionInput.contract.contract_hash,
			expected_revision: 0, operation_id: operationId, kind: "write", path,
		});
		assert.equal(begun.ok, true);
		if (!begun.ok) throw new Error("journal begin failed");
		await mkdir(dirname(join(projectRoot, path)), { recursive: true });
		await writeFile(join(projectRoot, path), Buffer.alloc(SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1 + 1, 0x78));
		const completed = await completeWriteJournalOperation({
			project_root: projectRoot, delegation_id: delegationId, contract_hash: executionInput.contract.contract_hash,
			expected_revision: begun.value.revision, operation_id: operationId, kind: "write", path, outcome: "succeeded",
		});
		assert.equal(completed.ok, true);
		if (!completed.ok) throw new Error("journal completion failed");
		return worker(report, {
			writeJournalObservation: Object.freeze({
				state: "complete", tool: "write", outcome: "succeeded", code: "none", revision: completed.value.revision,
			}),
		});
	};
	const result = await executeDelegationV2(executionInput);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "artifact_failed");
	assert.equal(result.artifact_error_code, "review_envelope_exceeded");
	assert.equal(result.durable_state?.status, "RECOVERY_REQUIRED");
	assert.equal(result.durable_state?.recovery_reason, "committed artifact construction failed: review_envelope_exceeded");
	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, false, "capacity refusal happens before immutable PENDING publication");
	const recoverable = await readRecoverableUnpublishedDelegationV2(projectRoot, delegationId);
	assert.equal(recoverable.ok, true, recoverable.ok ? "" : recoverable.error.code);
	const capsule = await readWorkerRepairCapsule(projectRoot, delegationId);
	assert.equal(capsule.ok, true, capsule.ok ? "" : capsule.code);
	if (capsule.ok) {
		assert.equal(capsule.capsule.repair_of, delegationId);
		assert.equal(capsule.capsule.authority_kind, "v2_unpublished");
		assert.deepEqual(capsule.capsule.changed_paths, [path]);
	}
});

test("execution v2: execution-owner publication failure closes PREPARED before returning", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(47);
	const result = await executeDelegationV2(await input(
		projectRoot,
		delegationId,
		"implementation",
		after([]),
		worker(completeReport([])),
		{
			executionOwnerOptions: {
				boot_facts: {
					boot_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
					system_boot_time_ms: Date.parse("2026-08-17T17:00:00.000Z"),
					runtime_started_at: "2026-08-17T17:00:01.000Z",
				},
				read_process_start_ticks: async () => "not-a-process-start-tick",
			},
		},
	));
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "start_failed");
	assert.equal(result.durable_state?.status, "ABORTED");
	assert.equal(
		result.durable_state?.abort_reason,
		RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.executionOwnerClaimFailed,
	);
	const durable = await readDelegationTransactionV2(projectRoot, delegationId);
	assert.equal(durable.ok && durable.value.status, "ABORTED");
});

test("execution v2: ambiguous owner prepublication failure is closed under the exact start lock before same-process retry", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(50);
	const start = await acquireProjectDelegationStartLockV1({
		project_root: projectRoot,
		delegation_id: delegationId,
		now: "2026-08-17T18:09:58.000Z",
	});
	assert.equal(start.ok, true, start.ok ? "" : start.error.code);
	if (!start.ok) return;

	const base = createNodeDelegationTransactionStorageAdapter();
	let failOwnerInspectionOnce = true;
	const ownerSuffix = "/execution-owner.json";
	const adapter = {
		...base,
		write: async (path: string, bytes: Uint8Array, exclusive: boolean) => {
			if (path.endsWith(ownerSuffix)) {
				const error = new Error("injected execution-owner prepublication failure") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return base.write(path, bytes, exclusive);
		},
		inspect: async (path: string) => {
			if (path.endsWith(ownerSuffix) && failOwnerInspectionOnce) {
				failOwnerInspectionOnce = false;
				const error = new Error("injected ambiguous owner absence") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return base.inspect(path);
		},
	};
	const result = await executeDelegationV2(await input(
		projectRoot,
		delegationId,
		"implementation",
		after([]),
		worker(completeReport([])),
		{ storageOptions: { adapter } },
	));
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "start_failed");
	assert.equal(result.durable_state?.status, "PREPARED",
		"ambiguous absence remains PREPARED at the execution boundary");
	if (result.durable_state?.status !== "PREPARED") return;

	const closed = await abortPristinePreparedDelegationUnderStartLockV2({
		project_root: projectRoot,
		transaction: result.durable_state,
		start_lock_lease: start.value,
		now: "2026-08-17T18:10:10.000Z",
		options: { storage_options: { adapter } },
	});
	assert.equal(closed.status, "recovered", closed.status === "blocked" ? closed.code : "");
	assert.equal(closed.transaction.status, "ABORTED");
	assert.equal((await releaseProjectDelegationStartLockV1(start.value)).ok, true);

	const retry = await acquireProjectDelegationStartLockV1({
		project_root: projectRoot,
		delegation_id: id(49),
		now: "2026-08-17T18:10:11.000Z",
	});
	assert.equal(retry.ok, true, retry.ok ? "" : retry.error.code);
	if (retry.ok) assert.equal((await releaseProjectDelegationStartLockV1(retry.value)).ok, true);
});

test("execution v2: a cumulative hard turn boundary pauses without commit or semantic repair", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(46);
	const report = completeReport(["src/changed.ts"]);
	const markedWorker = worker(report, {
		turns: 64,
		spendState: { turns: 64, totalTokens: 160, outputTokens: 40 },
		spendBand: "hard",
		spendReasons: ["turns"],
		spendSoftReached: { turns: true, totalTokens: false, outputTokens: false },
		spendHardExceeded: { turns: true, totalTokens: false, outputTokens: false },
	});
	const result = await executeDelegationV2(await input(
		projectRoot,
		delegationId,
		"implementation",
		after(["src/changed.ts"]),
		markedWorker,
	));
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.status, "PAUSED_BUDGET");
	if (result.status !== "PAUSED_BUDGET") return;
	assert.equal(result.worker_failure_code, "SPEND_TURN_LIMIT");
	assert.equal(result.durable_state.status, "RUNNING");
	assert.deepEqual(result.durable_state.postcondition_reasons, []);
	assert.equal(result.durable_state.terminal_outcome, null);
	assert.equal(result.checkpoint.machine_state, "PAUSED_BUDGET");
	assert.equal(result.checkpoint.cumulative_turns, 64);
	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, false, "a paused checkpoint is not a committed generation");
});

test("execution v2: a soft checkpoint continues in one delegation with cumulative spend and one final generation", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(47);
	const bound = contract("implementation");
	const calls: RunWorkerOptions[] = [];
	const first = worker("checkpoint handoff", {
		turns: 32,
		spendState: { turns: 32, totalTokens: 480, outputTokens: 64 },
		spendBand: "soft",
		spendReasons: ["turns"],
		spendSoftReached: { turns: true, totalTokens: false, outputTokens: false },
		checkpointRequest: {
			attempt: 1,
			advisory: { completed_criteria: [], remaining_criteria: ["The transaction is complete and authority-bound."] },
		},
	});
	first.usage = {
		input: 320, output: 64, cacheRead: 96, cacheWrite: 0, totalTokens: 480,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
	};
	const second = worker(completeReport(["src/changed.ts"]), {
		turns: 2,
		spendState: { turns: 34, totalTokens: 640, outputTokens: 104 },
		spendBand: "soft",
		spendReasons: ["turns"],
		spendSoftReached: { turns: true, totalTokens: false, outputTokens: false },
	});
	const before = await collectGitFacts(projectRoot, realExec);
	const result = await executeDelegationV2({
		projectRoot,
		delegationId,
		contract: bound,
		before,
		workerIdentity: { ...WORKER_IDENTITY },
		clock: clock(),
		exec: realExec,
		runWorker: async (options) => {
			calls.push(options);
			if (calls.length === 1) {
				return journalWorker(projectRoot, delegationId, bound.contract_hash, ["src/changed.ts"], first);
			}
			return structuredClone(second);
		},
	});
	assert.equal(result.ok, true, result.ok ? "" : result.code);
	if (!result.ok || result.status === "PAUSED_BUDGET") return;
	assert.equal(result.status, "PENDING_REVIEW");
	assert.equal(calls.length, 2);
	assert.equal(calls[0]!.attempt, 1);
	assert.equal(calls[1]!.attempt, 2);
	assert.deepEqual(calls[1]!.initialSpendState, { turns: 32, totalTokens: 480, outputTokens: 64 });
	assert.equal((calls[1]!.continuationCapsule as { attempt?: number }).attempt, 2);
	assert.equal(result.result.turns, 34);
	assert.equal(result.result.usage.totalTokens, 640);
	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, true);
	if (committed.ok) assert.equal(committed.value.state.generation, 1);
});

test("execution v2: a new process resumes the exact recovery transaction from its durable checkpoint", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(62);
	const { contract_hash: _baseHash, ...baseContract } = contract("implementation");
	const boundResult = bindDelegationBoundedTaskContractV2({
		...baseContract,
		allowed_paths: ["src/"],
	});
	assert.equal(boundResult.ok, true);
	if (!boundResult.ok) return;
	const bound = boundResult.value;
	const first = worker("checkpoint handoff", {
		turns: 32,
		spendState: { turns: 32, totalTokens: 480, outputTokens: 64 },
		spendBand: "soft",
		spendReasons: ["turns"],
		spendSoftReached: { turns: true, totalTokens: false, outputTokens: false },
		checkpointRequest: {
			attempt: 1,
			advisory: { completed_criteria: [], remaining_criteria: ["The transaction is complete and authority-bound."] },
		},
	});
	first.usage = {
		input: 320, output: 64, cacheRead: 96, cacheWrite: 0, totalTokens: 480,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
	};
	const ticks = clock();
	let calls = 0;
	const crashed = await executeDelegationV2({
		projectRoot,
		delegationId,
		contract: bound,
		workerIdentity: { ...WORKER_IDENTITY },
		clock: ticks,
		exec: realExec,
		onPrepared: async (_state, _before, prepared) => {
			const persisted = await persistDelegationResumeAuthorityV1({
				project_root: projectRoot,
				delegation_id: delegationId,
				contract: bound,
				prepared,
			});
			assert.equal(persisted.ok, true);
		},
		runWorker: async () => {
			calls += 1;
			if (calls === 1) {
				return journalWorker(projectRoot, delegationId, bound.contract_hash, ["src/changed.ts"], first);
			}
			throw new Error("simulated process loss after checkpoint");
		},
	});
	assert.equal(crashed.ok, false);
	if (crashed.ok) return;
	assert.equal(crashed.code, "runner_failed");
	assert.equal(crashed.durable_state?.status, "RECOVERY_REQUIRED");
	const authority = await collectCheckpointResumeExecutionAuthorityV1({
		project_root: projectRoot,
		delegation_id: delegationId,
		exec: realExec,
	});
	assert.equal(authority.ok, true, authority.ok ? "" : authority.code);
	if (!authority.ok) return;
	const resumedCalls: RunWorkerOptions[] = [];
	const resumed = await executeDelegationV2({
		projectRoot,
		delegationId,
		contract: bound,
		workerIdentity: { ...WORKER_IDENTITY },
		clock: ticks,
		exec: realExec,
		checkpointRecovery: authority.value,
		runWorker: async (options) => {
			resumedCalls.push(options);
			return worker(completeReport(["src/changed.ts"]), {
				turns: 2,
				spendState: { turns: 34, totalTokens: 640, outputTokens: 104 },
				spendBand: "soft",
				spendReasons: ["turns"],
				spendSoftReached: { turns: true, totalTokens: false, outputTokens: false },
			});
		},
	});
	assert.equal(resumed.ok, true, resumed.ok ? "" : JSON.stringify(resumed));
	if (!resumed.ok || resumed.status === "PAUSED_BUDGET") return;
	assert.equal(resumed.status, "PENDING_REVIEW");
	assert.equal(resumed.durable_state.revision, 5);
	assert.equal(resumedCalls.length, 1);
	assert.equal(resumedCalls[0]!.attempt, 2);
	assert.deepEqual(resumedCalls[0]!.initialSpendState, { turns: 32, totalTokens: 480, outputTokens: 64 });
	assert.equal(resumed.result.usage.totalTokens, 640);
	assert.deepEqual(resumed.after.changedSinceBefore, ["src/changed.ts"]);
});

test("execution v2: unknown out-of-journal drift blocks automatic checkpoint continuation", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(61);
	const bound = contract("implementation");
	const first = worker("checkpoint handoff", {
		turns: 32,
		spendState: { turns: 32, totalTokens: 480, outputTokens: 64 },
		spendBand: "soft",
		spendReasons: ["turns"],
		spendSoftReached: { turns: true, totalTokens: false, outputTokens: false },
		checkpointRequest: {
			attempt: 1,
			advisory: { completed_criteria: [], remaining_criteria: ["The transaction is complete and authority-bound."] },
		},
	});
	first.usage = {
		input: 320, output: 64, cacheRead: 96, cacheWrite: 0, totalTokens: 480,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
	};
	const before = await collectGitFacts(projectRoot, realExec);
	let calls = 0;
	const result = await executeDelegationV2({
		projectRoot,
		delegationId,
		contract: bound,
		before,
		workerIdentity: { ...WORKER_IDENTITY },
		clock: clock(),
		exec: realExec,
		runWorker: async () => {
			calls += 1;
			const observed = await journalWorker(projectRoot, delegationId, bound.contract_hash, ["src/changed.ts"], first);
			await writeFile(join(projectRoot, "outside.txt"), "unknown writer\n");
			return observed;
		},
	});
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "checkpoint_failed");
	assert.equal(calls, 1, "unknown drift must not start attempt N+1");
	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, false);
});

test("execution v2: create then edit the same new file commits with missing pre-worker authority", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(30);
	const path = "src/repeated-new.ts";
	const bound = contract("implementation");
	const report = completeReport([path]);
	const before = await collectGitFacts(projectRoot, realExec);
	const result = await executeDelegationV2({
		projectRoot,
		delegationId,
		contract: bound,
		before,
		workerIdentity: { ...WORKER_IDENTITY },
		clock: clock(),
		exec: realExec,
		runWorker: async () => createThenEditWorker(projectRoot, delegationId, bound.contract_hash, path, worker(report)),
	});
	assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result));
	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, true, committed.ok ? "" : committed.error.code);
	if (!committed.ok) return;
	const scope = committed.value.records["scope.json"] as Record<string, any>;
	const beforeRecord = committed.value.records["before.json"] as Record<string, any>;
	assert.equal(scope.change_set.worker_delta[0]?.before.kind, "missing");
	assert.equal(scope.change_set.worker_delta[0]?.operation_count, 2);
	assert.deepEqual(beforeRecord.path_digests, {});
});

test("execution v2: artifact failure preserves a bounded builder category in result and durable recovery", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(31);
	const path = "src/invalid-worker-facts.ts";
	const report = completeReport([path]);
	const inconsistent = worker(report, {
		spendState: { turns: 99, totalTokens: 160, outputTokens: 40 },
	});
	const result = await executeDelegationV2(await input(
		projectRoot,
		delegationId,
		"implementation",
		after([path]),
		inconsistent,
	));
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "artifact_failed");
	assert.equal(result.artifact_error_code, "binding_conflict");
	assert.equal(result.durable_state?.status, "RECOVERY_REQUIRED");
	assert.equal(result.durable_state?.committed_proof, null);
	assert.equal(result.durable_state?.recovery_reason, "committed artifact construction failed: binding_conflict");
	assert.doesNotMatch(JSON.stringify(result), /worker facts conflict with the pinned transaction outcome/);
});

test("execution v2 passes its checked delegation and contract identity to the injected runner", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(3);
	const boundContract = contract("implementation");
	let observed: { delegationId: string; contractHash: string } | undefined;
	const executionInput = await input(
		projectRoot,
		delegationId,
		"implementation",
		after(["src/changed.ts"]),
		worker(completeReport(["src/changed.ts"])),
		{
			contract: boundContract,
			runWorker: async (options) => {
				observed = options.runtimeIdentity === undefined ? undefined : { ...options.runtimeIdentity };
				return journalWorker(projectRoot, delegationId, boundContract.contract_hash, ["src/changed.ts"],
					worker(completeReport(["src/changed.ts"])));
			},
		},
	);
	const result = await executeDelegationV2(executionInput);
	assert.equal(result.ok, true);
	assert.deepEqual(observed, {
		delegationId,
		contractHash: boundContract.contract_hash,
	});
});

test("execution v2: diagnosis commits FINISHED only with zero writes", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(2);
	const report = completeReport([]);
	const result = await executeDelegationV2(await input(projectRoot, delegationId, "diagnosis", after([]), worker(report)));
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.status, "FINISHED");
	assert.equal(result.durable_state.status, "FINISHED");
	assert.deepEqual(result.after.changedSinceBefore, []);
	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, true);
	assert.equal(committed.ok && committed.value.state.status, "FINISHED");
});

test("execution v2: an already-installed repair successor reviews and accepts its full carried scope with zero new delta", async (t) => {
	const projectRoot = await root(t);
	const carriedPath = "src/already-fixed.ts";
	await mkdir(join(projectRoot, "src"), { recursive: true });
	await writeFile(join(projectRoot, carriedPath), "export const repaired = true;\n");
	const rootId = id(32);
	const delegationId = id(33);
	const decisionHash = "9".repeat(64);
	const lineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: rootId,
		repair_of: rootId,
		root_decision_hash: decisionHash,
		continuation_decision_delegation_id: rootId,
		continuation_decision_hash: decisionHash,
		parent_lineage_hash: null,
		depth: 1,
		carried_paths: [carriedPath],
	});
	assert.notEqual(lineage, undefined);
	const result = await executeDelegationV2(await input(
		projectRoot,
		delegationId,
		"implementation",
		after([]),
		worker(completeReport([])),
		{
			dependencyPaths: [carriedPath],
			repairLineage: lineage!,
		},
	));
	assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result));
	if (!result.ok) return;
	assert.equal(result.status, "PENDING_REVIEW");
	assert.deepEqual(result.durable_state.postcondition_reasons, []);
	assert.deepEqual(result.durable_state.terminal_outcome?.changed_paths, []);

	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, true, committed.ok ? "" : committed.error.code);
	if (!committed.ok) return;
	const afterRecord = committed.value.records["after.json"] as Record<string, any>;
	const scopeRecord = committed.value.records["scope.json"] as Record<string, any>;
	assert.deepEqual(afterRecord.changed_paths, []);
	assert.equal(afterRecord.review_envelope.path_count, 1);
	assert.deepEqual(scopeRecord.change_set.dependency_paths, [carriedPath]);

	const presented = await reviewDelegationV2({
		projectRoot,
		delegationId,
		exec: realExec,
		now: "2026-08-17T18:11:00.000Z",
	});
	assert.equal(presented.ok, true, presented.ok ? "" : JSON.stringify(presented.error));
	if (!presented.ok || presented.review.record === undefined) return;
	assert.deepEqual(presented.review.record.checked_paths, [carriedPath]);
	assert.deepEqual(presented.review.record.relevance_projection?.entries
		.find((entry) => entry.path === carriedPath)?.roles, ["D"]);
	assert.equal(presented.review.record.presentation_complete, true);
	const accepted = await reviewDelegationV2({
		projectRoot,
		delegationId,
		exec: realExec,
		now: "2026-08-17T18:11:01.000Z",
		semanticDecision: "ACCEPT",
		expectedBoundDiffHash: presented.review.record.bound_diff_hash,
		reviewer: { provider: "openai-codex", model: "gpt-5.6-sol" },
	});
	assert.equal(accepted.ok, true, accepted.ok ? "" : JSON.stringify(accepted.error));
	if (accepted.ok) assert.equal(accepted.transaction.status, "REVIEWED");
});

test("execution v2: complete machine facts commit postcondition failures as fail-closed generations", async (t) => {
	const cases: Array<{
		name: string;
		kind: DelegationTaskKind;
		after: AfterFacts;
		worker: WorkerRunResult;
		reason: string;
		absentReason?: string;
		workerFailureCode?: string;
		expectedStatus?: "FAILED" | "INTERRUPTED" | "RECOVERY_REQUIRED";
	}> = [
		{
			name: "zero-delta implementation",
			kind: "implementation",
			after: after([]),
			worker: worker(completeReport([])),
			reason: "IMPLEMENTATION_DELTA_REQUIRED",
		},
		{
			name: "diagnosis changed a file",
			kind: "diagnosis",
			after: after(["src/changed.ts"]),
			worker: worker(completeReport(["src/changed.ts"])),
			reason: "DIAGNOSIS_DELTA_FORBIDDEN",
		},
		{
			name: "diagnosis attempted a denied write",
			kind: "diagnosis",
			after: after([]),
			worker: worker(completeReport([]), { deniedWriteCount: 1 }),
			reason: "DIAGNOSIS_DENIED_WRITES_FORBIDDEN",
		},
		{
			name: "incomplete report",
			kind: "implementation",
			after: after(["src/changed.ts"]),
			worker: worker("## Completed\n- incomplete"),
			reason: "REPORT_INCOMPLETE",
		},
		{
			name: "worker exit failure",
			kind: "implementation",
			after: after(["src/changed.ts"]),
			worker: worker(completeReport(["src/changed.ts"]), { exitCode: 7, errorMessage: "worker failed" }),
			reason: "EXIT_CODE_NOT_ZERO",
			absentReason: "PROVIDER_NOT_SUCCESS",
			workerFailureCode: "EXIT_CODE_NONZERO",
			expectedStatus: "INTERRUPTED",
		},
		{
			name: "timeout with exit zero",
			kind: "implementation",
			after: after(["src/changed.ts"]),
			worker: worker(completeReport(["src/changed.ts"]), { timedOut: true }),
			reason: "WORKER_RUN_FAILED",
			absentReason: "EXIT_CODE_NOT_ZERO",
			workerFailureCode: "TIMED_OUT",
			expectedStatus: "INTERRUPTED",
		},
		{
			name: "compaction with exit zero",
			kind: "implementation",
			after: after(["src/changed.ts"]),
			worker: worker(completeReport(["src/changed.ts"]), {
				compactionCount: 1,
				compactionReasons: ["context pressure"],
			}),
			reason: "WORKER_RUN_FAILED",
			absentReason: "EXIT_CODE_NOT_ZERO",
			workerFailureCode: "COMPACTION_REJECTED",
			expectedStatus: "INTERRUPTED",
		},
		{
			name: "out-of-scope implementation change",
			kind: "implementation",
			after: after(["outside.ts"]),
			worker: worker(completeReport(["outside.ts"])),
			reason: "OUT_OF_SCOPE_CHANGES",
			expectedStatus: "RECOVERY_REQUIRED",
		},
	];
	let caseIndex = 10;
	for (const item of cases) {
		await t.test(item.name, async () => {
			const projectRoot = await root(t);
			const delegationId = id(caseIndex++);
			const result = await executeDelegationV2(await input(projectRoot, delegationId, item.kind, item.after, item.worker));
			assert.equal(result.ok, false);
			if (result.ok) return;
			assert.equal(result.code, "postconditions_failed");
			assert.equal(result.durable_state?.status, item.expectedStatus ?? "FAILED");
			assert.equal(result.durable_state?.postcondition_reasons.includes(item.reason as never), true);
			if (item.absentReason !== undefined) {
				assert.equal(result.durable_state?.postcondition_reasons.includes(item.absentReason as never), false);
			}
			if (item.workerFailureCode !== undefined) assert.equal(result.worker_failure_code, item.workerFailureCode);
			const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
			assert.equal(committed.ok, true);
			assert.equal(committed.ok && committed.value.state.status, item.expectedStatus ?? "FAILED");
			if (committed.ok && item.workerFailureCode !== undefined) {
				assert.equal(committed.value.state.terminal_outcome?.worker_success, false);
				assert.equal(committed.value.state.terminal_outcome?.worker_failure_code, item.workerFailureCode);
				for (const name of ["after.json", "usage.json", "worker-summary.json"] as const) {
					const record = committed.value.records[name] as Record<string, unknown>;
					assert.equal(record.worker_success, false, name);
					assert.equal(record.worker_failure_code, item.workerFailureCode, name);
				}
			}
		});
	}
});

test("execution v2: runner throw, identity drift, and after failure become durable recovery without a committed success", async (t) => {
	const cases: Array<{
		name: string;
		code: "runner_failed" | "worker_identity_invalid" | "after_failed";
		patch: Partial<ExecuteDelegationV2Input>;
	}> = [
		{
			name: "runner throws",
			code: "runner_failed",
			patch: { runWorker: async () => { throw new Error("secret runner failure"); } },
		},
		{
			name: "worker identity drifts",
			code: "worker_identity_invalid",
			patch: { runWorker: async () => worker(completeReport(["src/changed.ts"]), { provider: "foreign-secret-provider" }) },
		},
	];
	let caseIndex = 30;
	for (const item of cases) {
		await t.test(item.name, async () => {
			const projectRoot = await root(t);
			const delegationId = id(caseIndex++);
			const result = await executeDelegationV2(await input(
				projectRoot,
				delegationId,
				"implementation",
				after(["src/changed.ts"]),
				worker(completeReport(["src/changed.ts"])),
				item.patch,
			));
			assert.equal(result.ok, false);
			if (result.ok) return;
			assert.equal(result.code, item.code);
			assert.equal(result.durable_state?.status, "RECOVERY_REQUIRED");
			assert.equal(JSON.stringify(result).includes("secret"), false);
			const strict = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
			assert.equal(strict.ok, false);
		});
	}
});

test("execution v2: repair preflight failure keeps its closed cause in the response and durable recovery", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(34);
	const result = await executeDelegationV2(await input(
		projectRoot,
		delegationId,
		"implementation",
		after(["src/changed.ts"]),
		worker(completeReport(["src/changed.ts"])),
		{
			runWorker: async () => { throw new WorkerRunnerPreflightError("REPAIR_AUTHORITY_INVALID"); },
		},
	));
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "runner_failed");
	assert.equal(result.runner_preflight_failure_code, "REPAIR_AUTHORITY_INVALID");
	assert.equal(result.durable_state?.status, "RECOVERY_REQUIRED");
	assert.equal(result.durable_state?.recovery_reason,
		RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRepairAuthorityInvalid);
	assert.equal(JSON.stringify(result).includes("authority was invalid"), true);
	assert.equal((await readDelegationCommittedGenerationV2(projectRoot, delegationId)).ok, false);
});

test("execution v2: missing exec aborts prepared ChangeSet lifecycle before callback or child", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(35);
	let childCalls = 0;
	let preparedCalls = 0;
	const executionInput = await input(projectRoot, delegationId, "implementation", after(["src/changed.ts"]), worker(completeReport(["src/changed.ts"])), {
		exec: undefined,
		onPrepared: () => { preparedCalls += 1; },
		runWorker: async () => { childCalls += 1; return worker(completeReport(["src/changed.ts"])); },
	});
	const result = await executeDelegationV2(executionInput);
	assert.equal(result.ok, false);
	assert.equal(result.ok || result.code, "change_set_prepare_failed");
	assert.equal(result.durable_state?.status, "ABORTED");
	assert.equal(preparedCalls, 0);
	assert.equal(childCalls, 0);
});

test("execution v2: malformed journal observation requires recovery before legacy after collection", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(36);
	let afterCalls = 0;
	const result = await executeDelegationV2(await input(
		projectRoot, delegationId, "implementation", after(["src/changed.ts"]), worker(completeReport(["src/changed.ts"])), {
			runWorker: async () => worker(completeReport(["src/changed.ts"]), {
				writeJournalObservation: { state: "begun", tool: "write", outcome: "none", code: "none", revision: 1 },
			}),
			collectAfter: async () => { afterCalls += 1; throw new Error("must not run"); },
		},
	));
	assert.equal(result.ok, false);
	assert.equal(result.ok || result.code, "change_set_finalize_failed");
	assert.equal(result.durable_state?.status, "RECOVERY_REQUIRED");
	assert.equal(afterCalls, 0);
	assert.equal((await readDelegationCommittedGenerationV2(projectRoot, delegationId)).ok, false);
});

test("execution v2: WORKSPACE_DRIFT and CONFLICT commit immutable FAILED ChangeSet evidence", async (t) => {
	for (const scenario of ["WORKSPACE_DRIFT", "CONFLICT"] as const) {
		const projectRoot = await root(t);
		const delegationId = id(scenario === "WORKSPACE_DRIFT" ? 37 : 38);
		if (scenario === "CONFLICT") {
			await writeFile(join(projectRoot, ".gitignore"), "src/changed.ts\n");
			assert.equal((await realExec("git", ["add", "--", ".gitignore"], { cwd: projectRoot })).code, 0);
			assert.equal((await realExec("git", ["-c", "user.name=Execution V2", "-c", "user.email=execution@example.invalid", "commit", "-q", "-m", "ignore conflict fixture"], { cwd: projectRoot })).code, 0);
		}
		const bound = contract("implementation");
		const report = completeReport(["src/changed.ts"]);
		const executionInput = await input(projectRoot, delegationId, "implementation", after(["src/changed.ts"]), worker(report), {
			contract: bound,
			runWorker: async () => {
				const journalPaths = scenario === "CONFLICT"
					? Array.from({ length: 74 }, () => "src/changed.ts")
					: ["src/changed.ts"];
				const completed = await journalWorker(projectRoot, delegationId, bound.contract_hash, journalPaths, worker(report));
				if (scenario === "WORKSPACE_DRIFT") await writeFile(join(projectRoot, "unowned-drift.txt"), "drift\n");
				else await writeFile(join(projectRoot, "src/changed.ts"), "post-journal-conflict\n");
				return completed;
			},
		});
		const result = await executeDelegationV2(executionInput);
		assert.equal(result.ok, false, scenario);
		assert.equal(result.ok || result.code, "postconditions_failed", scenario);
		assert.equal(result.durable_state?.status, "FAILED", scenario);
		const reason = scenario === "WORKSPACE_DRIFT" ? "WORKSPACE_DRIFT_DETECTED" : "CHANGE_SET_CONFLICT";
		assert.equal(result.durable_state?.postcondition_reasons.includes(reason), true, scenario);
		const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
		assert.equal(committed.ok, true, scenario);
		if (!committed.ok) continue;
		const scope = committed.value.records["scope.json"] as Record<string, any>;
		const afterRecord = committed.value.records["after.json"] as Record<string, any>;
		assert.equal(scope.change_set.status, scenario);
		assert.equal(afterRecord.change_set_status, scenario);
		assert.equal(afterRecord.worker_delta_hash, scope.change_set.worker_delta_hash);
		assert.equal(afterRecord.workspace_guard_hash, scope.change_set.workspace_guard_hash);
		assert.equal(afterRecord.change_set_hash, scope.change_set.change_set_hash);
		if (scenario === "CONFLICT") {
			assert.equal(committed.value.state.terminal_outcome?.successful_write_count, 74);
			assert.deepEqual(committed.value.state.terminal_outcome?.changed_paths, []);
			assert.equal((await collectGitFacts(projectRoot, realExec)).gitDirty, false, "ignored worker residue is Git-clean but not discarded");
			const stillDirty = await closeInactiveProjectDelegationBlockerV2({
				project_root: projectRoot,
				expected_delegation_id: delegationId,
				now: "2026-08-17T18:11:00.000Z",
				exec: realExec,
				closed_by: { provider: "openai", model: "gpt-5.6-sol" },
			});
			assert.equal(stillDirty.ok, false);
			if (!stillDirty.ok) assert.equal(stillDirty.code, "relevant_paths_not_clean");

			await rm(join(projectRoot, "src", "changed.ts"));
			await writeFile(join(projectRoot, "unrelated-user-work.txt"), "preserve me\n");
			const closed = await closeInactiveProjectDelegationBlockerV2({
				project_root: projectRoot,
				expected_delegation_id: delegationId,
				now: "2026-08-17T18:11:01.000Z",
				exec: realExec,
				closed_by: { provider: "openai", model: "gpt-5.6-sol" },
			});
			assert.equal(closed.ok, true, closed.ok ? "" : closed.code);
			if (closed.ok) assert.deepEqual(closed.value.relevant_paths, ["src/changed.ts"]);
			assert.equal(await readFile(join(projectRoot, "unrelated-user-work.txt"), "utf8"), "preserve me\n");
			assert.deepEqual(await readProjectDelegationBlockerV2(projectRoot), { ok: true, value: null });
		}
	}
});

test("execution v2: failed tool outcome counts zero successful writes but preserves attributed delta", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(39);
	const bound = contract("implementation");
	const report = completeReport(["src/changed.ts"]);
	const result = await executeDelegationV2(await input(projectRoot, delegationId, "implementation", after(["src/changed.ts"]), worker(report), {
		contract: bound,
		runWorker: async () => journalWorker(projectRoot, delegationId, bound.contract_hash, ["src/changed.ts"], worker(report), "failed"),
	}));
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.durable_state.terminal_outcome?.successful_write_count, 0);
	assert.deepEqual(result.durable_state.terminal_outcome?.changed_paths, ["src/changed.ts"]);
});

test("execution v2: a pre-dirty touched path remains journal-attributed without workspace drift", async (t) => {
	const projectRoot = await root(t);
	await mkdir(join(projectRoot, "src"), { recursive: true });
	await writeFile(join(projectRoot, "src/predirty.ts"), "pre-dirty\n");
	const delegationId = id(44);
	const report = completeReport(["src/predirty.ts"]);
	const result = await executeDelegationV2(await input(projectRoot, delegationId, "implementation", after(["src/predirty.ts"]), worker(report)));
	assert.equal(result.ok, true);
	if (!result.ok) return;
	if (result.status === "PAUSED_BUDGET") assert.fail("unexpected budget pause");
	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, true);
	if (!committed.ok) return;
	const changeSet = (committed.value.records["scope.json"] as Record<string, any>).change_set;
	assert.equal(changeSet.status, "ATTRIBUTED");
	assert.deepEqual(changeSet.worker_delta.map((entry: { path: string }) => entry.path), ["src/predirty.ts"]);
});

test("execution v2: Unicode legacy ordering commits and strict-reads byte-canonical worker delta", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(45);
	const paths = ["src/😀.ts", "src/\uE000.ts"];
	const report = completeReport(paths);
	const result = await executeDelegationV2(await input(projectRoot, delegationId, "implementation", after(paths), worker(report)));
	assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result));
	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, true);
	if (!committed.ok) return;
	const authoritative = (committed.value.records["after.json"] as Record<string, any>).changed_paths;
	assert.deepEqual(authoritative, ["src/\uE000.ts", "src/😀.ts"]);
});

test("execution v2: legacy collectAfter injection is never called by new public v2", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(40);
	let calls = 0;
	const result = await executeDelegationV2(await input(
		projectRoot,
		delegationId,
		"implementation",
		after(["src/changed.ts"]),
		worker(completeReport(["src/changed.ts"])),
		{
			collectAfter: async ({ projectRoot: rootPath, before, exec }) => ({
				...(calls += 1, {}),
				...await collectAfterFacts(rootPath, before, exec!),
				diffHash: "f".repeat(64),
			}),
		},
	));
	assert.equal(result.ok, true);
	assert.equal(calls, 0);
	assert.equal((await readDelegationCommittedGenerationV2(projectRoot, delegationId)).ok, true);
});

test("execution v2: onPrepared observes PREPARED before RUNNING and before child launch", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(41);
	const events: string[] = [];
	const result = await executeDelegationV2(await input(
		projectRoot,
		delegationId,
		"implementation",
		after(["src/changed.ts"]),
		worker(completeReport(["src/changed.ts"])),
		{
			onPrepared: async (state) => {
				events.push(`callback:${state.status}`);
				const stored = await readDelegationTransactionV2(projectRoot, delegationId);
				assert.equal(stored.ok && stored.value.status, "PREPARED");
			},
			runWorker: async (options) => {
				events.push("child");
				const stored = await readDelegationTransactionV2(projectRoot, delegationId);
				assert.equal(stored.ok && stored.value.status, "RUNNING");
				return journalWorker(projectRoot, delegationId, options.runtimeIdentity!.contractHash, ["src/changed.ts"],
					worker(completeReport(["src/changed.ts"])));
			},
		},
	));
	assert.equal(result.ok, true);
	assert.deepEqual(events, ["callback:PREPARED", "child"]);
});

test("execution v2: onPrepared failure aborts durably and never launches the child", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(42);
	let launched = false;
	const result = await executeDelegationV2(await input(
		projectRoot,
		delegationId,
		"implementation",
		after(["src/changed.ts"]),
		worker(completeReport(["src/changed.ts"])),
		{
			onPrepared: () => { throw new Error("callback secret"); },
			runWorker: async () => {
				launched = true;
				return worker(completeReport(["src/changed.ts"]));
			},
		},
	));
	assert.equal(result.ok, false);
	assert.equal(result.ok || result.code, "prepared_callback_failed");
	assert.equal(result.durable_state?.status, "ABORTED");
	assert.equal(launched, false);
	assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("execution v2: report, stop reason, and worker summary are redacted from the same persisted derivation", async (t) => {
	const projectRoot = await root(t);
	const delegationId = id(43);
	const secret = "execution-super-secret";
	const rawReport = `${secret}\n${completeReport(["src/changed.ts"])}`;
	const result = await executeDelegationV2(await input(
		projectRoot,
		delegationId,
		"implementation",
		after(["src/changed.ts"]),
		worker(rawReport, { stopReason: secret, errorMessage: secret }),
		{ secrets: [secret] },
	));
	assert.equal(result.ok, true);
	if (!result.ok) return;
	if (result.status === "PAUSED_BUDGET") assert.fail("unexpected budget pause");
	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	assert.equal(committed.ok, true);
	if (!committed.ok) return;
	assert.equal(JSON.stringify(result).includes(secret), false);
	assert.equal(committed.value.records["worker-report.md"].includes(secret), false);
	assert.deepEqual(committed.value.records["worker-summary.json"], result.workerSummary);
	assert.equal(result.result.stopReason, "[REDACTED]");
});

test("execution v2: selected persistence faults never produce a finished transaction", async (t) => {
	const cases: Array<{
		name: string;
		fault: Parameters<typeof createNodeDelegationTransactionStorageAdapter>[0];
		code: "prepare_failed" | "commit_state_failed" | "generation_commit_failed";
		expectedStatus?: string;
	}> = [
		{
			name: "prepared state rename fails",
			fault: (point) => { if (point === "state.rename") throw new Error("fault"); },
			code: "prepare_failed",
		},
		{
			name: "committing state rename fails once",
			fault: (() => {
				let count = 0;
				return (point) => { if (point === "state.rename" && ++count === 3) throw new Error("fault"); };
			})(),
			code: "commit_state_failed",
			expectedStatus: "RECOVERY_REQUIRED",
		},
		{
			name: "worker report staging write fails",
			fault: (point) => { if (point === "generation.record.worker-report.md.write") throw new Error("fault"); },
			code: "generation_commit_failed",
			expectedStatus: "RECOVERY_REQUIRED",
		},
		{
			name: "terminal transaction publish fails",
			fault: (point) => { if (point === "publish_state.rename") throw new Error("fault"); },
			code: "generation_commit_failed",
			expectedStatus: "RECOVERY_REQUIRED",
		},
	];
	let caseIndex = 50;
	for (const item of cases) {
		await t.test(item.name, async () => {
			const projectRoot = await root(t);
			const delegationId = id(caseIndex++);
			const adapter = createNodeDelegationTransactionStorageAdapter(item.fault);
			const result = await executeDelegationV2(await input(
				projectRoot,
				delegationId,
				"implementation",
				after(["src/changed.ts"]),
				worker(completeReport(["src/changed.ts"])),
				{ storageOptions: { adapter } },
			));
			assert.equal(result.ok, false);
			if (result.ok) return;
			assert.equal(result.code, item.code);
			if (item.expectedStatus !== undefined) assert.equal(result.durable_state?.status, item.expectedStatus);
			const state = await readDelegationTransactionV2(projectRoot, delegationId, { adapter });
			if (state.ok) assert.notEqual(state.value.status, "FINISHED");
			if (state.ok) assert.notEqual(state.value.status, "PENDING_REVIEW");
		});
	}
});

test("execution v2: malformed preflight input performs no child or after work", async (t) => {
	const projectRoot = await root(t);
	let childCalls = 0;
	let afterCalls = 0;
	const valid = await input(
		projectRoot,
		id(60),
		"implementation",
		after(["src/changed.ts"]),
		worker(completeReport(["src/changed.ts"])),
		{
			runWorker: async () => {
				childCalls += 1;
				return worker(completeReport(["src/changed.ts"]));
			},
			collectAfter: async () => {
				afterCalls += 1;
				return after(["src/changed.ts"]);
			},
		},
	);
	valid.contract = { ...valid.contract, contract_hash: "f".repeat(64) };
	const result = await executeDelegationV2(valid);
	assert.equal(result.ok, false);
	assert.equal(result.ok || result.code, "invalid_input");
	assert.equal(childCalls, 0);
	assert.equal(afterCalls, 0);
});
