import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import { bindDelegationBoundedTaskContractV2 } from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";

import {
	authorizedWorkerBudgetPromotionV1,
	buildWorkerCheckpointV1,
	remainingWorkerBudgetV1,
	validateWorkerCheckpointBudgetContinuationV1,
	validateWorkerCheckpointContinuationV1,
	validateWorkerCheckpointV1,
	workerCheckpointContinuationCapsuleV1,
	type WorkerCheckpointV1,
} from "../extensions/workbench-runtime/core/worker-checkpoint.ts";
import {
	createNodeDelegationTransactionStorageAdapter,
	persistPreparedDelegationTransaction,
	persistRunningDelegationTransaction,
	publishDelegationWorkerCheckpointV1,
	readDelegationTransactionV2,
	readDelegationWorkerCheckpointV1,
	type DelegationTransactionStorageFaultPoint,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	preparePausedBudgetContinuationV1,
	recoverDelegationContractFromSessionDirectoryV1,
} from "../extensions/workbench-runtime/core/delegation-resume-authority.ts";
import { createWorkerWriteJournal } from "../extensions/workbench-runtime/core/write-journal.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";

const ID = "20260829-010000-LCO4";
const CONTRACT = "a".repeat(64);
const BEFORE = "b".repeat(64);
const CURRENT = "c".repeat(64);
const RUNTIME = "sha256:" + "d".repeat(64);
const AT = "2026-08-29T01:00:00.000Z";

function usage(turns: number) {
	return {
		input: turns * 10,
		output: turns * 2,
		cacheRead: turns * 3,
		cacheWrite: 0,
		totalTokens: turns * 15,
		cost: { input: turns / 100, output: turns / 50, cacheRead: 0, cacheWrite: 0, total: turns * 0.03 },
	};
}

function checkpoint(
	attempt = 1,
	turns = 32,
	parent: string | null = null,
	profile: "standard" | "extended" = "standard",
	remainingCriterion = "criterion-b",
): Readonly<WorkerCheckpointV1> {
	const cumulative = usage(turns);
	const remaining = remainingWorkerBudgetV1(profile, turns, cumulative.totalTokens, cumulative.output);
	assert.ok(remaining);
	const built = buildWorkerCheckpointV1({
		delegation_id: ID,
		contract_hash: CONTRACT,
		attempt,
		parent_checkpoint_hash: parent,
		runtime_build_identity: RUNTIME,
		before_binding_hash: BEFORE,
		current_binding_hash: CURRENT,
		touched_paths: [{
			path: "src/a.ts",
			before_hash: null,
			current_hash: "e".repeat(64),
			journal_hash: "f".repeat(64),
		}],
		completed_recipe_run_ids: ["20260829-010000-abcd"],
		cumulative_usage: cumulative,
		cumulative_turns: turns,
		remaining_budget: remaining,
		machine_state: remaining.turns === 0 || remaining.total_tokens === 0 || remaining.output_tokens === 0
			? "PAUSED_BUDGET" : "CHECKPOINTED",
		worker_advisory: { completed_criteria: ["criterion-a"], remaining_criteria: [remainingCriterion] },
		created_at: AT,
	});
	assert.equal(built.ok, true);
	if (!built.ok) throw new Error("checkpoint fixture failed");
	return built.value;
}

test("WorkerCheckpointV1 is hash-bound, bounded, monotonic, and produces a transcript-free capsule", () => {
	const first = checkpoint();
	assert.equal(validateWorkerCheckpointV1(first), true);
	assert.equal(validateWorkerCheckpointContinuationV1(first, {
		delegation_id: ID,
		contract_hash: CONTRACT,
		runtime_build_identity: RUNTIME,
		expected_attempt: 1,
		parent_checkpoint_hash: null,
		before_binding_hash: BEFORE,
		current_binding_hash: CURRENT,
		allowed_paths: ["src/**"],
		active_attempt: false,
	}), true);
	assert.equal(validateWorkerCheckpointContinuationV1({
		...first,
		touched_paths: [{ ...first.touched_paths[0]!, path: "src/nested/a.ts" }],
	}, {
		delegation_id: ID,
		contract_hash: CONTRACT,
		runtime_build_identity: RUNTIME,
		expected_attempt: 1,
		parent_checkpoint_hash: null,
		before_binding_hash: BEFORE,
		current_binding_hash: CURRENT,
		allowed_paths: ["src/"],
		active_attempt: false,
	}), false, "tampering still invalidates the checkpoint hash");
	const { schema_version: _schema, kind: _kind, checkpoint_hash: _hash, ...directoryInput } = first;
	const directoryCheckpoint = buildWorkerCheckpointV1({
		...directoryInput,
		touched_paths: [{ ...first.touched_paths[0]!, path: "src/nested/a.ts" }],
	});
	assert.equal(directoryCheckpoint.ok, true);
	if (directoryCheckpoint.ok) {
		assert.equal(validateWorkerCheckpointContinuationV1(directoryCheckpoint.value, {
			delegation_id: ID,
			contract_hash: CONTRACT,
			runtime_build_identity: RUNTIME,
			expected_attempt: 1,
			parent_checkpoint_hash: null,
			before_binding_hash: BEFORE,
			current_binding_hash: CURRENT,
			allowed_paths: ["src/"],
			active_attempt: false,
		}), true, "directory rules must authorize descendants exactly like delegation execution");
	}
	const capsule = workerCheckpointContinuationCapsuleV1(first);
	assert.ok(capsule);
	assert.equal(Buffer.byteLength(JSON.stringify(capsule), "utf8") <= 4 * 1024, true);
	assert.equal(JSON.stringify(capsule).includes("transcript"), false);
	assert.equal(validateWorkerCheckpointV1({ ...first, cumulative_turns: Number.NaN }), false);
	assert.equal(validateWorkerCheckpointV1({ ...first, current_binding_hash: "0".repeat(64) }), false);

	const second = checkpoint(2, 40, first.checkpoint_hash);
	assert.equal(second.attempt, first.attempt + 1);
	assert.equal(second.cumulative_turns > first.cumulative_turns, true);
	assert.equal(second.cumulative_usage.totalTokens > first.cumulative_usage.totalTokens, true);
	assert.equal(checkpoint(1, 64).machine_state, "PAUSED_BUDGET");
});

test("an authorized standard-to-extended promotion preserves cumulative enforcement", () => {
	const paused = checkpoint(1, 64);
	assert.equal(validateWorkerCheckpointBudgetContinuationV1(paused, {
		delegation_id: ID,
		contract_hash: CONTRACT,
		checkpoint_hash: paused.checkpoint_hash,
		before_binding_hash: BEFORE,
		current_binding_hash: CURRENT,
		allowed_paths: ["src/**"],
	}), true);
	const authorizationHash = "9".repeat(64);
	const promotion = authorizedWorkerBudgetPromotionV1(paused, authorizationHash);
	assert.ok(promotion);
	const cumulative = usage(70);
	const remaining = remainingWorkerBudgetV1(
		"extended",
		70,
		cumulative.totalTokens,
		cumulative.output,
	);
	assert.ok(remaining);
	const { schema_version: _schema, kind: _kind, checkpoint_hash: _hash, ...base } = paused;
	const built = buildWorkerCheckpointV1({
		...base,
		attempt: 2,
		parent_checkpoint_hash: paused.checkpoint_hash,
		cumulative_usage: cumulative,
		cumulative_turns: 70,
		budget_promotion: promotion,
		remaining_budget: remaining,
		machine_state: "CHECKPOINTED",
		created_at: "2026-08-29T01:01:00.000Z",
	});
	assert.equal(built.ok, true);
	if (!built.ok) return;
	assert.equal(built.value.cumulative_turns, 70, "lifetime telemetry remains cumulative");
	assert.equal(built.value.remaining_budget.turns, 26);
	assert.equal(built.value.budget_promotion?.authorization_hash, authorizationHash);
	assert.equal(authorizedWorkerBudgetPromotionV1(built.value, authorizationHash), undefined, "promotion is one-shot");
});

test("checkpoint storage advances a paused standard checkpoint only through an authorized promotion", async () => {
	const root = await mkdtemp(join(tmpdir(), "lco-budget-promotion-"));
	try {
		const options = await runningProject(root);
		const paused = checkpoint(1, 64);
		assert.equal((await publishDelegationWorkerCheckpointV1(root, paused, options)).ok, true);
		const promotion = authorizedWorkerBudgetPromotionV1(paused, "9".repeat(64));
		assert.ok(promotion);
		const cumulative = usage(65);
		const remaining = remainingWorkerBudgetV1("extended", 65, cumulative.totalTokens, cumulative.output);
		assert.ok(remaining);
		const { schema_version: _schema, kind: _kind, checkpoint_hash: _hash, ...base } = paused;
		const next = buildWorkerCheckpointV1({
			...base,
			attempt: 2,
			parent_checkpoint_hash: paused.checkpoint_hash,
			cumulative_usage: cumulative,
			cumulative_turns: 65,
			budget_promotion: promotion,
			remaining_budget: remaining,
			machine_state: "CHECKPOINTED",
			created_at: "2026-08-29T01:01:00.000Z",
		});
		assert.equal(next.ok, true);
		if (next.ok) assert.equal((await publishDelegationWorkerCheckpointV1(root, next.value, options)).ok, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a legacy RUNNING budget pause migrates only under the exact checkpoint grant", async () => {
	const root = await mkdtemp(join(tmpdir(), "lco-budget-migration-"));
	try {
		const options = await runningProject(root);
		const paused = checkpoint(1, 64);
		assert.equal((await publishDelegationWorkerCheckpointV1(root, paused, options)).ok, true);
		assert.equal((await createWorkerWriteJournal({
			project_root: root,
			delegation_id: ID,
			contract_hash: CONTRACT,
		})).ok, true);
		const withoutHash = {
			schema_version: 1 as const,
			kind: "budget-continuation-authorization-v1" as const,
			delegation_id: ID,
			checkpoint_hash: paused.checkpoint_hash,
			target_profile: "extended" as const,
			prompt_hash: "8".repeat(64),
		};
		const authorization = { ...withoutHash, authority_hash: canonicalHash(withoutHash) };
		const migrated = await preparePausedBudgetContinuationV1({
			project_root: root,
			delegation_id: ID,
			authorization,
		});
		assert.deepEqual(migrated, { ok: true });
		const transaction = await readDelegationTransactionV2(root, ID);
		assert.equal(transaction.ok, true);
		if (transaction.ok) {
			assert.equal(transaction.value.status, "RECOVERY_REQUIRED");
			assert.equal(transaction.value.recovery_reason, "worker paused at a bounded budget epoch before terminal facts");
		}
		assert.deepEqual(await preparePausedBudgetContinuationV1({
			project_root: root,
			delegation_id: ID,
			authorization: { ...authorization, checkpoint_hash: "7".repeat(64) },
		}), { ok: false, code: "BUDGET_AUTHORIZATION_INVALID" }, "tampered authority hash is rejected before migration");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("legacy recovery finds one exact contract in a bounded sibling session scan", async () => {
	const root = await mkdtemp(join(tmpdir(), "lco-legacy-session-contract-"));
	try {
		const bound = bindDelegationBoundedTaskContractV2({
			task_kind: "implementation",
			task: "Complete the exact paused implementation slice.",
			allowed_paths: ["src/**"],
			acceptance_criteria: ["The bounded slice is complete."],
			verification: [],
			timeout_seconds: 600,
			budget_profile: "standard",
		});
		assert.equal(bound.ok, true);
		if (!bound.ok) return;
		const { contract_hash: _contractHash, ...arguments_ } = bound.value;
		await writeFile(join(root, "legacy.jsonl"), [
			JSON.stringify({ type: "session", cwd: "/project" }),
			JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", name: "workbench_delegate_worker", arguments: arguments_ }] },
			}),
			JSON.stringify({ type: "message", message: { role: "toolResult", content: ID } }),
		].join("\n") + "\n");
		const recovered = await recoverDelegationContractFromSessionDirectoryV1(root, ID, {
			contract_hash: bound.value.contract_hash,
			task_kind: "implementation",
			allowed_paths: ["src/**"],
		});
		assert.equal(recovered?.contract_hash, bound.value.contract_hash);
		assert.deepEqual(recovered, bound.value);
		assert.equal(await recoverDelegationContractFromSessionDirectoryV1(root, ID, {
			contract_hash: "0".repeat(64), task_kind: "implementation", allowed_paths: ["src/**"],
		}), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function runningProject(root: string, adapter = createNodeDelegationTransactionStorageAdapter()) {
	const options = { adapter };
	const prepared = await persistPreparedDelegationTransaction(root, {
		delegation_id: ID,
		task_kind: "implementation",
		contract_hash: CONTRACT,
		allowed_paths: ["src/**"],
		worker_identity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: "checkpoint-worker" },
		generation: 1,
		now: AT,
	}, options);
	assert.equal(prepared.ok, true);
	if (!prepared.ok) throw new Error("prepare failed");
	const running = await persistRunningDelegationTransaction(root, {
		delegation_id: ID,
		contract_hash: CONTRACT,
		worker_identity: prepared.value.worker_identity,
		expected_generation: prepared.value.generation,
		expected_revision: prepared.value.revision,
		now: "2026-08-29T01:00:01.000Z",
	}, options);
	assert.equal(running.ok, true);
	return options;
}

test("checkpoint storage atomically publishes one monotonic attempt and rejects concurrent forks", async () => {
	const root = await mkdtemp(join(tmpdir(), "lco-checkpoint-"));
	try {
		const options = await runningProject(root);
		const first = checkpoint();
		const competing = checkpoint(1, 32, null, "standard", "criterion-c");
		assert.notEqual(competing.checkpoint_hash, first.checkpoint_hash);
		const published = await Promise.all([
			publishDelegationWorkerCheckpointV1(root, first, options),
			publishDelegationWorkerCheckpointV1(root, competing, options),
		]);
		assert.equal(published.filter((result) => result.ok).length, 1);
		const read = await readDelegationWorkerCheckpointV1(root, ID, options);
		assert.equal(read.ok, true);
		if (!read.ok) return;
		assert.equal([first.checkpoint_hash, competing.checkpoint_hash].includes(read.value?.checkpoint_hash ?? ""), true);
		const stale = checkpoint(2, 40, "9".repeat(64));
		assert.equal((await publishDelegationWorkerCheckpointV1(root, stale, options)).ok, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const point of [
	"worker_checkpoint_v1.temp.write",
	"worker_checkpoint_v1.temp.read",
	"worker_checkpoint_v1.rename",
	"worker_checkpoint_v1.final.read",
] as const satisfies readonly DelegationTransactionStorageFaultPoint[]) {
	test(`checkpoint storage fails closed and is retryable at ${point}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "lco-checkpoint-fault-"));
		let armed = false;
		const adapter = createNodeDelegationTransactionStorageAdapter((observed) => {
			if (armed && observed === point) throw new Error(point);
		});
		try {
			const options = await runningProject(root, adapter);
			armed = true;
			assert.equal((await publishDelegationWorkerCheckpointV1(root, checkpoint(), options)).ok, false);
			armed = false;
			assert.equal((await publishDelegationWorkerCheckpointV1(root, checkpoint(), options)).ok, true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
