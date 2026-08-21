import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
	bindDelegationBoundedTaskContractV2,
	type DelegationBoundedTaskContractBindingV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import {
	executeDelegationV2,
	type ExecuteDelegationV2Input,
} from "../extensions/workbench-runtime/core/delegation-execution-v2.ts";
import {
	computeDiffHash,
	collectGitFacts,
	collectAfterFacts,
	type AfterFacts,
	type GitFacts,
} from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import {
	createNodeDelegationTransactionStorageAdapter,
	readDelegationCommittedGenerationV2,
	readDelegationTransactionV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import type { DelegationTaskKind } from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION } from "../extensions/workbench-runtime/core/worker-write-journal-runtime.ts";
import { beginWriteJournalOperation, completeWriteJournalOperation } from "../extensions/workbench-runtime/core/write-journal.ts";
import type { WorkerRunResult } from "../extensions/workbench-runtime/worker/runner.ts";

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
	assert.deepEqual(committed.value.records["worker-summary.json"], result.workerSummary);
	assert.equal(committed.value.records["worker-report.md"], report);
	assert.deepEqual((committed.value.records["usage.json"] as { usage: unknown }).usage, result.workerSummary.usage);
	const scope = committed.value.records["scope.json"] as Record<string, any>;
	const afterRecord = committed.value.records["after.json"] as Record<string, any>;
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

test("execution v2: a turn-only marker remains a successful committed delegation", async (t) => {
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
	assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result));
	if (!result.ok) return;
	assert.equal(result.status, "PENDING_REVIEW");
	assert.deepEqual(result.durable_state.postcondition_reasons, []);
	assert.equal(result.durable_state.terminal_outcome?.provider_success, true);
	assert.equal(result.workerSummary.status, "success");
	assert.equal(result.workerSummary.spend?.band, "hard");
	assert.deepEqual(result.workerSummary.spend?.reasons, ["turns"]);
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

test("execution v2: complete machine facts commit postcondition failures as fail-closed generations", async (t) => {
	const cases: Array<{
		name: string;
		kind: DelegationTaskKind;
		after: AfterFacts;
		worker: WorkerRunResult;
		reason: string;
		absentReason?: string;
		workerFailureCode?: string;
		expectedStatus?: "FAILED" | "RECOVERY_REQUIRED";
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
		},
		{
			name: "legacy local turn stop is not a provider failure",
			kind: "implementation",
			after: after(["src/changed.ts"]),
			worker: worker(completeReport(["src/changed.ts"]), {
				exitCode: 143,
				turns: 64,
				errorMessage: "Worker cumulative spend hard budget reached (profile standard): turns 64/64.",
				spendState: { turns: 64, totalTokens: 160, outputTokens: 40 },
				spendBand: "hard",
				spendReasons: ["turns"],
				spendSoftReached: { turns: true, totalTokens: false, outputTokens: false },
				spendHardExceeded: { turns: true, totalTokens: false, outputTokens: false },
			}),
			reason: "EXIT_CODE_NOT_ZERO",
			absentReason: "PROVIDER_NOT_SUCCESS",
			workerFailureCode: "SPEND_TURN_LIMIT_LEGACY",
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
		const bound = contract("implementation");
		const report = completeReport(["src/changed.ts"]);
		const executionInput = await input(projectRoot, delegationId, "implementation", after(["src/changed.ts"]), worker(report), {
			contract: bound,
			runWorker: async () => {
				const completed = await journalWorker(projectRoot, delegationId, bound.contract_hash, ["src/changed.ts"], worker(report));
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
