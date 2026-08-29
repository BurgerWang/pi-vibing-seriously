import assert from "node:assert/strict";
import test from "node:test";

import {
	appendLifecycleActionSnapshotIfChangedV2,
	buildLifecycleActionSnapshotV2,
	delegationLifecycleSnapshotFromCompatibilityProjectionV1,
	resolveDelegationLifecycleV1,
	validateLifecycleActionExecutionV2,
	validateLifecycleActionSnapshotV2,
	type DelegationLifecycleAttemptV1,
	type DelegationLifecycleAuthorityHealthV1,
} from "../extensions/workbench-runtime/core/delegation-lifecycle-resolver.ts";
import {
	lifecycleActionSnapshotCommandV2,
	lifecycleActionSnapshotTextV2,
} from "../extensions/workbench-runtime/core/agent-next-action.ts";
import { computeActiveToolsForLifecycleSnapshotV2, DEV_TOOLS } from "../extensions/workbench-runtime/core/mode-policy.ts";
import { buildWorkerCheckpointV1, remainingWorkerBudgetV1 } from "../extensions/workbench-runtime/core/worker-checkpoint.ts";

const ID = "20260829-020000-LCO5";
const HASH = "a".repeat(64);

function resolution(attempt: DelegationLifecycleAttemptV1, health: DelegationLifecycleAuthorityHealthV1 = "VALID") {
	const snapshot = delegationLifecycleSnapshotFromCompatibilityProjectionV1({
		source_authority: { id: ID, revision: 1 },
		authority_health: health,
		authority_disposition: "INACTIVE",
		binding: "CURRENT",
		attempt,
		target: { kind: "DELEGATION", id: ID },
		recovery_rank: { unresolved_obligations: attempt === "NONE" ? 0 : 1, unresolved_attempts: attempt === "NONE" ? 0 : 1 },
	});
	return resolveDelegationLifecycleV1(snapshot, {
		schema_version: 1,
		kind: "delegation-lifecycle-event-v1",
		event: "OBSERVE",
		expected_snapshot_hash: null,
	});
}

function action(attempt: DelegationLifecycleAttemptV1, health: DelegationLifecycleAuthorityHealthV1 = "VALID") {
	const built = buildLifecycleActionSnapshotV2({ project_root: "/project", mode: "DEV", resolution: resolution(attempt, health) });
	assert.equal(built.ok, true);
	if (!built.ok) throw new Error("snapshot fixture failed");
	return built.value;
}

function checkpoint(turns: number) {
	const usage = {
		input: turns * 10, output: turns * 2, cacheRead: turns * 3, cacheWrite: 0, totalTokens: turns * 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const remaining = remainingWorkerBudgetV1("standard", turns, usage.totalTokens, usage.output)!;
	const built = buildWorkerCheckpointV1({
		delegation_id: ID,
		contract_hash: HASH,
		attempt: 1,
		parent_checkpoint_hash: null,
		runtime_build_identity: "sha256:" + "b".repeat(64),
		before_binding_hash: "c".repeat(64),
		current_binding_hash: "d".repeat(64),
		touched_paths: [],
		completed_recipe_run_ids: [],
		cumulative_usage: usage,
		cumulative_turns: turns,
		remaining_budget: remaining,
		machine_state: remaining.turns === 0 ? "PAUSED_BUDGET" : "CHECKPOINTED",
		worker_advisory: { completed_criteria: [], remaining_criteria: [] },
		created_at: "2026-08-29T02:00:00.000Z",
	});
	assert.equal(built.ok, true);
	if (!built.ok) throw new Error("checkpoint fixture failed");
	return built.value;
}

test("canonical lifecycle states map to exactly one deterministic V2 primary action", () => {
	const cases = [
		["NONE", "CONTINUE_DIRECT_DEVELOPMENT"],
		["ACTIVE", "NONE"],
		["AWAITING_REVIEW", "REVIEW_CANDIDATE"],
		["REPAIRABLE", "START_EXACT_REPAIR"],
	] as const;
	for (const [attempt, expected] of cases) {
		const first = action(attempt);
		const second = action(attempt);
		assert.equal(first.action, expected);
		assert.equal(first.snapshot_hash, second.snapshot_hash);
		assert.equal(validateLifecycleActionSnapshotV2(first), true);
	}
	assert.equal(action("NONE", "CORRUPT").action, "RECOVER_AUTHORITY");
});

test("status text, tool command, and active tools consume the same snapshot target", () => {
	const review = action("AWAITING_REVIEW");
	assert.equal(review.exact_target.delegation_id, ID);
	assert.equal(lifecycleActionSnapshotCommandV2(review), `call workbench_review_worker_diff delegation_id=${ID}`);
	assert.match(lifecycleActionSnapshotTextV2(review), new RegExp(ID));
	const tools = computeActiveToolsForLifecycleSnapshotV2("DEV", DEV_TOOLS, review);
	assert.equal(tools.includes("workbench_review_worker_diff"), true);
	assert.equal(tools.includes("workbench_delegate_worker"), false);
	assert.equal(tools.includes("edit"), false);
});

test("checkpoint and budget pause override ACTIVE without creating semantic repair", () => {
	const active = resolution("ACTIVE");
	const continuing = buildLifecycleActionSnapshotV2({ project_root: "/project", mode: "DEV", resolution: active, checkpoint: checkpoint(32) });
	assert.equal(continuing.ok, true);
	if (!continuing.ok) return;
	assert.equal(continuing.value.action, "CONTINUE_CHECKPOINT");
	assert.equal(continuing.value.safe_automatic, true);
	assert.equal(continuing.value.authorization, "EXISTING");

	const paused = buildLifecycleActionSnapshotV2({ project_root: "/project", mode: "DEV", resolution: active, checkpoint: checkpoint(64) });
	assert.equal(paused.ok, true);
	if (!paused.ok) return;
	assert.equal(paused.value.action, "PAUSED_BUDGET");
	assert.equal(paused.value.authorization, "USER_REQUIRED");
	assert.equal(lifecycleActionSnapshotTextV2(paused.value).includes("repair"), false);
});

test("executor rejects stale authority or a different exact target and never substitutes another action", () => {
	const review = action("AWAITING_REVIEW");
	const expected = {
		project_root_hash: review.project_root_hash,
		mode: review.mode,
		authority_hash: review.authority_hash,
		action: review.action,
		exact_target: review.exact_target,
	};
	assert.equal(validateLifecycleActionExecutionV2(review, expected), true);
	assert.equal(validateLifecycleActionExecutionV2(review, { ...expected, authority_hash: "f".repeat(64) }), false);
	assert.equal(validateLifecycleActionExecutionV2(review, {
		...expected,
		exact_target: { delegation_id: "20260829-020001-OTHR" },
	}), false);
});

test("100 repeated status projections append no duplicate authority entry and remain under 2 KiB", () => {
	const snapshot = action("AWAITING_REVIEW");
	const appended: unknown[] = [];
	let latest: string | null = null;
	for (let index = 0; index < 100; index += 1) {
		const result = appendLifecycleActionSnapshotIfChangedV2(snapshot, latest, (_type, data) => appended.push(data));
		assert.ok(result);
		latest = result.latest_snapshot_hash;
	}
	assert.equal(appended.length, 1);
	assert.equal(Buffer.byteLength(JSON.stringify(appended[0]), "utf8") <= 2 * 1024, true);
});
