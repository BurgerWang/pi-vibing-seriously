import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import type { FinalizeChangeSetV2Result } from "../extensions/workbench-runtime/core/change-set-finalizer.ts";
import {
	finalizeDelegationChangeSetLifecycleV2,
	prepareDelegationChangeSetLifecycleV2,
	recoverPreparedDelegationChangeSetLifecycleV2,
	type FinalizeDelegationChangeSetLifecycleV2Result,
	type PrepareDelegationChangeSetLifecycleV2Input,
	type PrepareDelegationChangeSetLifecycleV2Result,
	type PreparedDelegationChangeSetLifecycleV2,
} from "../extensions/workbench-runtime/core/delegation-change-set-lifecycle.ts";
import { collectWorkspaceGuard } from "../extensions/workbench-runtime/core/workspace-guard.ts";
import {
	buildWorkerCheckpointV1,
	remainingWorkerBudgetV1,
} from "../extensions/workbench-runtime/core/worker-checkpoint.ts";
import {
	EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
	type WorkerWriteJournalRuntimeObservation,
} from "../extensions/workbench-runtime/core/worker-write-journal-runtime.ts";
import {
	beginWriteJournalOperation,
	completeWriteJournalOperation,
	createWorkerWriteJournal,
	readWorkerWriteJournal,
	sealWorkerWriteJournal,
	type WorkerWriteJournalRecord,
} from "../extensions/workbench-runtime/core/write-journal.ts";

const ID = "20260820-150000-LcV2";
const CONTRACT = "a".repeat(64);
const SECRET = "private-path-and-runtime-detail";
const execFileAsync = promisify(execFile);

const realExec: ExecFn = async (command, args, options) => {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options?.cwd,
			timeout: options?.timeout,
			signal: options?.signal,
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
		});
		return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
	} catch (error) {
		const failed = error as Error & { code?: number; stdout?: string; stderr?: string; killed?: boolean };
		return {
			stdout: failed.stdout ?? "",
			stderr: failed.stderr ?? "",
			code: typeof failed.code === "number" ? failed.code : 1,
			killed: failed.killed ?? false,
		};
	}
};

async function withRepository(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "delegation-change-set-lifecycle-"));
	try {
		assert.equal((await realExec("git", ["init", "-q"], { cwd: root })).code, 0);
		await writeFile(join(root, "base.txt"), "base\n");
		assert.equal((await realExec("git", ["add", "--", "base.txt"], { cwd: root })).code, 0);
		assert.equal((await realExec("git", [
			"-c", "user.name=Lifecycle Test", "-c", "user.email=lifecycle@example.invalid",
			"commit", "-q", "-m", "base",
		], { cwd: root })).code, 0);
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function prepareInput(root: string, dependencyPaths: readonly string[] = []): PrepareDelegationChangeSetLifecycleV2Input {
	return {
		project_root: root,
		delegation_id: ID,
		contract_hash: CONTRACT,
		dependency_paths: dependencyPaths,
		exec: realExec,
	};
}

function preparedSuccess(result: PrepareDelegationChangeSetLifecycleV2Result): Readonly<PreparedDelegationChangeSetLifecycleV2> {
	assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}:${result.error.cause ?? "none"}`);
	if (!result.ok) throw new Error("expected prepare success");
	return result.value;
}

function finalizedSuccess(result: FinalizeDelegationChangeSetLifecycleV2Result) {
	assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}:${result.error.cause ?? "none"}`);
	if (!result.ok) throw new Error("expected finalize success");
	return result.value;
}

function lifecycleFailure(
	result: PrepareDelegationChangeSetLifecycleV2Result | FinalizeDelegationChangeSetLifecycleV2Result,
	code: string,
	cause?: string,
) {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected lifecycle failure");
	assert.equal(result.error.code, code);
	if (cause !== undefined) assert.equal(result.error.cause, cause);
	assert.deepEqual(Object.keys(result.error).sort(), cause === undefined
		? ["code", "message"]
		: ["cause", "code", "message"]);
	assert.equal(Object.isFrozen(result.error), true);
	assert.equal(JSON.stringify(result).includes(SECRET), false);
	return result.error;
}

function completedObservation(
	revision: number,
	tool: "edit" | "write",
	outcome: "succeeded" | "failed",
): Readonly<WorkerWriteJournalRuntimeObservation> {
	return Object.freeze({ state: "complete", tool, outcome, code: "none", revision });
}

async function journalOperation(
	root: string,
	path: string,
	kind: "edit" | "write",
	outcome: "succeeded" | "failed",
	contents: string,
): Promise<Readonly<WorkerWriteJournalRuntimeObservation>> {
	const operationId = (kind === "edit" ? "1" : "2").repeat(64);
	const begun = await beginWriteJournalOperation({
		project_root: root,
		delegation_id: ID,
		contract_hash: CONTRACT,
		expected_revision: 0,
		operation_id: operationId,
		kind,
		path,
	});
	assert.equal(begun.ok, true, begun.ok ? undefined : begun.error.code);
	await writeFile(join(root, path), contents);
	const completed = await completeWriteJournalOperation({
		project_root: root,
		delegation_id: ID,
		contract_hash: CONTRACT,
		expected_revision: 1,
		operation_id: operationId,
		kind,
		path,
		outcome,
	});
	assert.equal(completed.ok, true, completed.ok ? undefined : completed.error.code);
	if (!completed.ok) throw new Error("journal completion failed");
	return completedObservation(completed.value.revision, kind, outcome);
}

test("real clean Git no-op accepts only EMPTY, keeps journal artifact irrelevant, and freezes authority", async () => {
	await withRepository(async (root) => {
		const input = prepareInput(root);
		const snapshot = { ...input, dependency_paths: [...input.dependency_paths] };
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(input));
		assert.deepEqual(input, snapshot);
		assert.equal(prepared.journal.state, "OPEN");
		assert.equal(prepared.journal.revision, 0);
		assert.deepEqual(prepared.journal.operations, []);
		assert.deepEqual(prepared.before_guard.entries, []);
		assert.ok(prepared.before_guard.irrelevant_artifact_paths.some((path) => path.endsWith("/write-journal.json")));
		assert.equal(Object.isFrozen(prepared), true);
		assert.equal(Object.isFrozen(prepared.before_guard), true);
		assert.equal(Object.isFrozen(prepared.journal), true);

		const finalizeInput = { prepared, observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION, exec: realExec };
		const beforeFinalize = structuredClone({ prepared, observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION });
		const value = finalizedSuccess(await finalizeDelegationChangeSetLifecycleV2(finalizeInput));
		assert.deepEqual({ prepared: finalizeInput.prepared, observation: finalizeInput.observation }, beforeFinalize);
		assert.equal(value.sealed_journal.state, "SEALED");
		assert.equal(value.sealed_journal.revision, 1);
		assert.equal(value.change_set.status, "ATTRIBUTED");
		assert.deepEqual(value.change_set.worker_delta, []);
		assert.equal(Object.isFrozen(value), true);
		assert.equal(Object.isFrozen(value.change_set), true);
	});
});

test("legacy checkpoint recovery ignores its own runtime lock telemetry without weakening relevant path authority", async () => {
	await withRepository(async (root) => {
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		await journalOperation(root, "continued.txt", "write", "succeeded", "checkpoint bytes\n");
		const current = await collectWorkspaceGuard({ project_root: root, exec: realExec });
		assert.equal(current.ok, true);
		if (!current.ok) throw new Error("current guard unavailable");
		const remaining = remainingWorkerBudgetV1("standard", 1, 10, 2);
		assert.notEqual(remaining, undefined);
		const checkpoint = buildWorkerCheckpointV1({
			delegation_id: ID,
			contract_hash: CONTRACT,
			attempt: 1,
			parent_checkpoint_hash: null,
			runtime_build_identity: "sha256:legacy-recovery-test",
			before_binding_hash: prepared.before_guard.workspace_guard_hash,
			current_binding_hash: current.guard.workspace_guard_hash,
			touched_paths: [{
				path: "continued.txt",
				before_hash: null,
				current_hash: "b".repeat(64),
				journal_hash: "c".repeat(64),
			}],
			completed_recipe_run_ids: [],
			cumulative_usage: {
				input: 6,
				output: 2,
				cacheRead: 2,
				cacheWrite: 0,
				totalTokens: 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			cumulative_turns: 1,
			remaining_budget: remaining!,
			machine_state: "CHECKPOINTED",
			worker_advisory: { completed_criteria: [], remaining_criteria: [] },
			created_at: "2026-08-20T15:01:00.000Z",
		});
		assert.equal(checkpoint.ok, true);
		const recover = () => recoverPreparedDelegationChangeSetLifecycleV2({
			project_root: root,
			delegation_id: ID,
			contract_hash: CONTRACT,
			dependency_paths: [],
			checkpoint: checkpoint.value,
			exec: realExec,
		});
		const beforeLock = await recover();
		assert.equal(beforeLock.ok, true);
		await writeFile(join(root, ".pi", "workbench", "delegation-start.lock"), "runtime lock telemetry\n");
		const afterLock = await recover();
		assert.equal(afterLock.ok, true);
		assert.deepEqual(afterLock.value, beforeLock.value);
		assert.deepEqual(afterLock.value.before_guard.irrelevant_artifact_paths, []);
		assert.equal(afterLock.value.before_guard.meter.irrelevant_paths, 0);
	});
});

for (const scenario of [
	{ kind: "write" as const, outcome: "succeeded" as const, path: "written.txt" },
	{ kind: "edit" as const, outcome: "failed" as const, path: "failed-edit.txt" },
]) {
	test(`real ${scenario.kind} journal operation with ${scenario.outcome} outcome remains attributable`, async () => {
		await withRepository(async (root) => {
			const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
			const observation = await journalOperation(root, scenario.path, scenario.kind, scenario.outcome, "worker bytes\n");
			const value = finalizedSuccess(await finalizeDelegationChangeSetLifecycleV2({ prepared, observation, exec: realExec }));
			assert.equal(value.change_set.status, "ATTRIBUTED");
			assert.deepEqual(value.change_set.worker_delta.map((entry) => [entry.path, entry.change, entry.operation_count]), [
				[scenario.path, "new", 1],
			]);
			const operation = value.sealed_journal.operations[0];
			assert.equal(operation?.status, "completed");
			assert.equal(operation?.status === "completed" ? operation.outcome : undefined, scenario.outcome);
		});
	});
}

for (const scenario of [
	{ dependencies: ["dependency.txt"], classification: "dependency" },
	{ dependencies: [] as string[], classification: "unknown_origin" },
]) {
	test(`pre-dirty facts remain separate while later ${scenario.classification} drift is classified`, async () => {
		await withRepository(async (root) => {
			await writeFile(join(root, "predirty.txt"), "before\n");
			const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root, scenario.dependencies)));
			assert.deepEqual(prepared.before_guard.entries.map((entry) => entry.path), ["predirty.txt"]);
			await writeFile(join(root, "dependency.txt"), "later drift\n");
			const value = finalizedSuccess(await finalizeDelegationChangeSetLifecycleV2({
				prepared,
				observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
				exec: realExec,
			}));
			assert.equal(value.change_set.status, "WORKSPACE_DRIFT");
			assert.deepEqual(value.change_set.workspace_drift.map((entry) => [entry.path, entry.classification]), [
				["dependency.txt", scenario.classification],
			]);
			assert.equal(value.change_set.workspace_drift.some((entry) => entry.path === "predirty.txt"), false);
		});
	});
}

test("invalid, failed, begun, and mismatched observations do not seal or scan after", async () => {
	await withRepository(async (root) => {
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		const observations: unknown[] = [
			{ state: "failed", tool: "write", outcome: "none", code: "poisoned", revision: 0 },
			{ state: "begun", tool: "write", outcome: "none", code: "none", revision: 1 },
			{ state: "complete", tool: "write", outcome: "succeeded", code: "none", revision: 0 },
			{ ...EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION, extra: true },
		];
		for (const observation of observations) {
			const counts = { seal: 0, after: 0, finalizer: 0 };
			const result = await finalizeDelegationChangeSetLifecycleV2({
				prepared,
				observation: observation as WorkerWriteJournalRuntimeObservation,
				exec: realExec,
			}, {
				seal_journal: async () => { counts.seal += 1; throw new Error(SECRET); },
				collect_guard: async () => { counts.after += 1; throw new Error(SECRET); },
				finalize_change_set: async () => { counts.finalizer += 1; throw new Error(SECRET); },
			});
			lifecycleFailure(result, "observation_invalid");
			assert.deepEqual(counts, { seal: 0, after: 0, finalizer: 0 });
		}
	});
});

test("pending durable journal is rejected before seal, after guard, and finalizer", async () => {
	await withRepository(async (root) => {
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		const begun = await beginWriteJournalOperation({
			project_root: root,
			delegation_id: ID,
			contract_hash: CONTRACT,
			expected_revision: 0,
			operation_id: "3".repeat(64),
			kind: "write",
			path: "pending.txt",
		});
		assert.equal(begun.ok, true);
		const counts = { seal: 0, after: 0, finalizer: 0 };
		const result = await finalizeDelegationChangeSetLifecycleV2({
			prepared,
			observation: { state: "begun", tool: "write", outcome: "none", code: "none", revision: 1 },
			exec: realExec,
		}, {
			seal_journal: async () => { counts.seal += 1; throw new Error(SECRET); },
			collect_guard: async () => { counts.after += 1; throw new Error(SECRET); },
			finalize_change_set: async () => { counts.finalizer += 1; throw new Error(SECRET); },
		});
		lifecycleFailure(result, "journal_invalid");
		assert.deepEqual(counts, { seal: 0, after: 0, finalizer: 0 });
	});
});

test("completed durable operation requires exact last tool, outcome, and revision observation", async () => {
	await withRepository(async (root) => {
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		await journalOperation(root, "observed.txt", "write", "succeeded", "observed bytes\n");
		const mismatches: readonly WorkerWriteJournalRuntimeObservation[] = [
			{ state: "complete", tool: "edit", outcome: "succeeded", code: "none", revision: 2 },
			{ state: "complete", tool: "write", outcome: "failed", code: "none", revision: 2 },
			{ state: "complete", tool: "write", outcome: "succeeded", code: "none", revision: 1 },
		];
		for (const observation of mismatches) {
			let sealCalls = 0;
			const result = await finalizeDelegationChangeSetLifecycleV2({ prepared, observation, exec: realExec }, {
				seal_journal: async () => { sealCalls += 1; throw new Error(SECRET); },
			});
			lifecycleFailure(result, "observation_invalid");
			assert.equal(sealCalls, 0);
		}
	});
});

test("dependency paths are strict canonical sorted unique bounded and cannot name the journal artifact", async () => {
	await withRepository(async (root) => {
		const invalid: readonly string[][] = [
			["z.txt", "a.txt"],
			["a.txt", "a.txt"],
			Array.from({ length: 501 }, (_, index) => `dep/${String(index).padStart(3, "0")}.txt`),
			[`.pi/workbench/delegations/${ID}/v2/write-journal.json`],
			["dep\n.txt"],
		];
		for (const dependencyPaths of invalid) {
			let createCalls = 0;
			const result = await prepareDelegationChangeSetLifecycleV2(prepareInput(root, dependencyPaths), {
				create_journal: async () => { createCalls += 1; throw new Error(SECRET); },
			});
			lifecycleFailure(result, "invalid_input");
			assert.equal(createCalls, 0);
		}
	});
});

test("create and before-guard failures are stage-specific, closed, and content-free", async () => {
	await withRepository(async (root) => {
		const createResult = await prepareDelegationChangeSetLifecycleV2(prepareInput(root), {
			create_journal: async () => ({
				ok: false,
				error: { code: "storage_failure", message: SECRET, point: "create.final.read" },
			}),
		});
		lifecycleFailure(createResult, "create_failed", "storage_failure");

		const malformed = {
			schema_version: 2,
			delegation_id: ID,
			contract_hash: CONTRACT,
			state: "OPEN",
			revision: 0,
			limits: {},
			meter: {},
			operations: [],
			journal_hash: null,
		} as unknown as WorkerWriteJournalRecord;
		const invalidSuccess = await prepareDelegationChangeSetLifecycleV2(prepareInput(root), {
			create_journal: async () => ({ ok: true, value: malformed }),
		});
		lifecycleFailure(invalidSuccess, "create_failed", "invalid_result");

		const beforeResult = await prepareDelegationChangeSetLifecycleV2(prepareInput(root), {
			collect_guard: async () => ({
				ok: false,
				error: { code: "git_failure", message: SECRET },
				meter: { status_bytes: 0, relevant_paths: 0, irrelevant_paths: 0, stat_calls: 0, content_bytes_read: 0 },
			}),
		});
		lifecycleFailure(beforeResult, "before_guard_failed", "git_failure");
	});
});

test("injected journal successes cannot bypass the strict journal validator at create, read, or seal", async () => {
	await withRepository(async (root) => {
		const created = await createWorkerWriteJournal({
			project_root: root,
			delegation_id: ID,
			contract_hash: CONTRACT,
		});
		assert.equal(created.ok, true);
		if (!created.ok) throw new Error("create failed");
		const forgedInitials: unknown[] = [
			{ ...created.value, meter: { paths_attempted: 0, paths_completed: 1, bytes_read: 0 } },
			{ ...created.value, extra: true },
		];
		for (const forged of forgedInitials) {
			let guardCalls = 0;
			const result = await prepareDelegationChangeSetLifecycleV2(prepareInput(root), {
				create_journal: async () => ({ ok: true, value: forged as WorkerWriteJournalRecord }),
				collect_guard: async () => { guardCalls += 1; throw new Error(SECRET); },
			});
			lifecycleFailure(result, "create_failed", "invalid_result");
			assert.equal(guardCalls, 0);
		}
	});

	await withRepository(async (root) => {
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		await journalOperation(root, "chain.txt", "edit", "succeeded", "first change\n");
		const secondBegun = await beginWriteJournalOperation({
			project_root: root,
			delegation_id: ID,
			contract_hash: CONTRACT,
			expected_revision: 2,
			operation_id: "2".repeat(64),
			kind: "write",
			path: "chain.txt",
		});
		assert.equal(secondBegun.ok, true);
		await writeFile(join(root, "chain.txt"), "second change\n");
		const secondCompleted = await completeWriteJournalOperation({
			project_root: root,
			delegation_id: ID,
			contract_hash: CONTRACT,
			expected_revision: 3,
			operation_id: "2".repeat(64),
			kind: "write",
			path: "chain.txt",
			outcome: "succeeded",
		});
		assert.equal(secondCompleted.ok, true);
		if (!secondCompleted.ok) throw new Error("completion failed");
		const durable = secondCompleted.value;
		const badChain = structuredClone(durable) as WorkerWriteJournalRecord;
		const second = badChain.operations[1];
		assert.equal(second?.status, "completed");
		if (second?.status !== "completed" || second.before.kind !== "file") throw new Error("expected file chain");
		second.before.sha256 = "0".repeat(64);
		const forgedReads: unknown[] = [
			{ ...durable, meter: { ...durable.meter, paths_attempted: 0 } },
			badChain,
			{ ...durable, extra: true },
		];
		for (const forged of forgedReads) {
			let sealCalls = 0;
			const result = await finalizeDelegationChangeSetLifecycleV2({
				prepared,
				observation: completedObservation(4, "write", "succeeded"),
				exec: realExec,
			}, {
				read_journal: async () => ({ ok: true, value: forged as WorkerWriteJournalRecord }),
				seal_journal: async () => { sealCalls += 1; throw new Error(SECRET); },
			});
			lifecycleFailure(result, "journal_invalid");
			assert.equal(sealCalls, 0);
		}

		const sealed = await sealWorkerWriteJournal({
			project_root: root,
			delegation_id: ID,
			contract_hash: CONTRACT,
			expected_revision: durable.revision,
		});
		assert.equal(sealed.ok, true);
		if (!sealed.ok) throw new Error("seal failed");
		let afterCalls = 0;
		const corruptSealed = {
			...sealed.value,
			meter: { ...sealed.value.meter, paths_completed: 0 },
		};
		const sealedResult = await finalizeDelegationChangeSetLifecycleV2({
			prepared,
			observation: completedObservation(4, "write", "succeeded"),
			exec: realExec,
		}, {
			read_journal: async () => ({ ok: true, value: durable }),
			seal_journal: async () => ({ ok: true, value: corruptSealed }),
			collect_guard: async () => { afterCalls += 1; throw new Error(SECRET); },
		});
		lifecycleFailure(sealedResult, "sealed_journal_invalid");
		assert.equal(afterCalls, 0);
	});
});

test("read identity mismatch, read failure, and observation mismatch all fail before sealing", async () => {
	await withRepository(async (root) => {
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		const durable = await readWorkerWriteJournal({ project_root: root, delegation_id: ID, contract_hash: CONTRACT });
		assert.equal(durable.ok, true);
		if (!durable.ok) throw new Error("read failed");

		const readFailure = await finalizeDelegationChangeSetLifecycleV2({
			prepared, observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION, exec: realExec,
		}, {
			read_journal: async () => ({ ok: false, error: { code: "invalid_record", message: SECRET } }),
		});
		lifecycleFailure(readFailure, "read_failed", "invalid_record");

		let sealCalls = 0;
		const wrongIdentity = await finalizeDelegationChangeSetLifecycleV2({
			prepared, observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION, exec: realExec,
		}, {
			read_journal: async () => ({ ok: true, value: { ...durable.value, contract_hash: "b".repeat(64) } }),
			seal_journal: async () => { sealCalls += 1; throw new Error(SECRET); },
		});
		lifecycleFailure(wrongIdentity, "journal_invalid");
		assert.equal(sealCalls, 0);
	});
});

test("seal, after-guard, and finalizer failures remain stage-specific and never leak injected detail", async () => {
	await withRepository(async (root) => {
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		const sealFailure = await finalizeDelegationChangeSetLifecycleV2({
			prepared, observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION, exec: realExec,
		}, {
			seal_journal: async () => ({ ok: false, error: { code: "storage_failure", message: SECRET } }),
		});
		lifecycleFailure(sealFailure, "seal_failed", "storage_failure");
	});

	await withRepository(async (root) => {
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		let finalizerCalls = 0;
		const afterFailure = await finalizeDelegationChangeSetLifecycleV2({
			prepared, observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION, exec: realExec,
		}, {
			collect_guard: async () => ({
				ok: false,
				error: { code: "stat_failure", message: SECRET },
				meter: { status_bytes: 0, relevant_paths: 0, irrelevant_paths: 0, stat_calls: 0, content_bytes_read: 0 },
			}),
			finalize_change_set: async () => { finalizerCalls += 1; throw new Error(SECRET); },
		});
		lifecycleFailure(afterFailure, "after_guard_failed", "stat_failure");
		assert.equal(finalizerCalls, 0);
	});

	await withRepository(async (root) => {
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		const durable = await readWorkerWriteJournal({ project_root: root, delegation_id: ID, contract_hash: CONTRACT });
		assert.equal(durable.ok, true);
		if (!durable.ok) throw new Error("read failed");
		const invalidSealed = await finalizeDelegationChangeSetLifecycleV2({
			prepared, observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION, exec: realExec,
		}, {
			seal_journal: async () => ({
				ok: true,
				value: { ...durable.value, state: "SEALED", revision: 1, journal_hash: "0".repeat(64) },
			}),
		});
		lifecycleFailure(invalidSealed, "sealed_journal_invalid");
	});

	await withRepository(async (root) => {
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		const finalizerFailure = await finalizeDelegationChangeSetLifecycleV2({
			prepared, observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION, exec: realExec,
		}, {
			finalize_change_set: async () => ({
				ok: false,
				error: { code: "identity_failure", message: SECRET, identity_code: "read_failed" },
			}),
		});
		lifecycleFailure(finalizerFailure, "finalizer_failed", "identity_failure");
	});

	await withRepository(async (root) => {
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		const invalidSuccess = await finalizeDelegationChangeSetLifecycleV2({
			prepared, observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION, exec: realExec,
		}, {
			finalize_change_set: async () => ({ ok: true, value: {
				delegation_id: ID,
				contract_hash: CONTRACT,
				journal_hash: "0".repeat(64),
			} } as unknown as FinalizeChangeSetV2Result),
		});
		lifecycleFailure(invalidSuccess, "finalizer_failed", "invalid_result");
	});
});

test("post-seal replay is rejected as non-OPEN before seal, after guard, and finalizer", async () => {
	await withRepository(async (root) => {
		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		finalizedSuccess(await finalizeDelegationChangeSetLifecycleV2({
			prepared, observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION, exec: realExec,
		}));
		const counts = { seal: 0, after: 0, finalizer: 0 };
		const replay = await finalizeDelegationChangeSetLifecycleV2({
			prepared, observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION, exec: realExec,
		}, {
			seal_journal: async () => { counts.seal += 1; throw new Error(SECRET); },
			collect_guard: async () => { counts.after += 1; throw new Error(SECRET); },
			finalize_change_set: async () => { counts.finalizer += 1; throw new Error(SECRET); },
		});
		lifecycleFailure(replay, "journal_invalid");
		assert.deepEqual(counts, { seal: 0, after: 0, finalizer: 0 });
	});
});

test("strict closed inputs reject extra fields and preserve caller objects", async () => {
	await withRepository(async (root) => {
		let createCalls = 0;
		const extra = { ...prepareInput(root), extra: SECRET } as unknown as PrepareDelegationChangeSetLifecycleV2Input;
		const rejected = await prepareDelegationChangeSetLifecycleV2(extra, {
			create_journal: async () => { createCalls += 1; throw new Error(SECRET); },
		});
		lifecycleFailure(rejected, "invalid_input");
		assert.equal(createCalls, 0);

		for (const projectRoot of ["/tmp/../tmp", `${root} `]) {
			const nonCanonical = await prepareDelegationChangeSetLifecycleV2(prepareInput(projectRoot), {
				create_journal: async () => { createCalls += 1; throw new Error(SECRET); },
			});
			lifecycleFailure(nonCanonical, "invalid_input");
		}
		assert.equal(createCalls, 0);

		const prepared = preparedSuccess(await prepareDelegationChangeSetLifecycleV2(prepareInput(root)));
		const forged = structuredClone(prepared) as PreparedDelegationChangeSetLifecycleV2;
		forged.contract_hash = "b".repeat(64);
		let readCalls = 0;
		const mismatch = await finalizeDelegationChangeSetLifecycleV2({
			prepared: forged,
			observation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
			exec: realExec,
		}, {
			read_journal: async () => { readCalls += 1; throw new Error(SECRET); },
		});
		lifecycleFailure(mismatch, "invalid_input");
		assert.equal(readCalls, 0);
	});
});
