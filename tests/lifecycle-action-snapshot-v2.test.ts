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
	type DelegationLifecycleBindingV1,
} from "../extensions/workbench-runtime/core/delegation-lifecycle-resolver.ts";
import {
	lifecycleActionSnapshotCommandV2,
	lifecycleActionStatusLinesV2,
	lifecycleActionSnapshotTextV2,
	lifecycleActionTurnDirectiveV2,
} from "../extensions/workbench-runtime/core/agent-next-action.ts";
import { computeActiveToolsForLifecycleSnapshotV2, DEV_TOOLS } from "../extensions/workbench-runtime/core/mode-policy.ts";
import { buildWorkerCheckpointV1, remainingWorkerBudgetV1 } from "../extensions/workbench-runtime/core/worker-checkpoint.ts";
import { authorizePausedBudgetContinuationTurnV1 } from "../extensions/workbench-runtime/core/budget-continuation-authorization.ts";

const ID = "20260829-020000-LCO5";
const HASH = "a".repeat(64);

function resolution(
	attempt: DelegationLifecycleAttemptV1,
	health: DelegationLifecycleAuthorityHealthV1 = "VALID",
	binding: DelegationLifecycleBindingV1 = "CURRENT",
) {
	const snapshot = delegationLifecycleSnapshotFromCompatibilityProjectionV1({
		source_authority: { id: ID, revision: 1 },
		authority_health: health,
		authority_disposition: "INACTIVE",
		binding,
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

function checkpoint(turns: number, profile: "standard" | "extended" = "standard") {
	const usage = {
		input: turns * 10, output: turns * 2, cacheRead: turns * 3, cacheWrite: 0, totalTokens: turns * 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const remaining = remainingWorkerBudgetV1(profile, turns, usage.totalTokens, usage.output)!;
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
		...(profile === "extended" ? {
			budget_promotion: {
				from_profile: "standard" as const,
				to_profile: "extended" as const,
				authorization_hash: "e".repeat(64),
			},
		} : {}),
		remaining_budget: remaining,
		machine_state: Object.values(remaining).some((value) => typeof value === "number" && value === 0)
			? "PAUSED_BUDGET" : "CHECKPOINTED",
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

test("a stale finalized slice exposes the guarded fresh-successor lane instead of a status no-op", () => {
	const built = buildLifecycleActionSnapshotV2({
		project_root: "/project",
		mode: "DEV",
		resolution: resolution("AWAITING_REVIEW", "VALID", "REBASEABLE"),
	});
	assert.equal(built.ok, true);
	if (!built.ok) return;
	assert.equal(built.value.action, "START_DELEGATION");
	assert.equal(built.value.tool, "workbench_delegate_worker");
	assert.equal(built.value.arguments, null, "the successor contract must be freshly bounded from current work");
	assert.equal(built.value.safe_automatic, false);
	assert.equal(built.value.authorization, "EXISTING");
	const tools = computeActiveToolsForLifecycleSnapshotV2("DEV", DEV_TOOLS, built.value);
	assert.equal(tools.includes("workbench_delegate_worker"), true);
	assert.equal(tools.includes("workbench_review_worker_diff"), false);
	assert.equal(tools.includes("edit"), false);
	const directive = lifecycleActionTurnDirectiveV2(built.value, tools);
	assert.match(directive ?? "", /implementation contract must require a real in-scope delta/u);
	assert.match(directive ?? "", /use task_kind=diagnosis/u);
});

test("checkpoint and budget pause override ACTIVE without creating semantic repair", () => {
	const active = resolution("ACTIVE");
	const continuing = buildLifecycleActionSnapshotV2({ project_root: "/project", mode: "DEV", resolution: active, checkpoint: checkpoint(32) });
	assert.equal(continuing.ok, true);
	if (!continuing.ok) return;
	assert.equal(continuing.value.action, "CONTINUE_CHECKPOINT");
	assert.equal(continuing.value.tool, "workbench_repair_delegation");
	assert.deepEqual(continuing.value.arguments, { delegation_id: ID });
	assert.equal(continuing.value.safe_automatic, true);
	assert.equal(continuing.value.authorization, "EXISTING");
	const directive = lifecycleActionTurnDirectiveV2(continuing.value, ["read", "workbench_repair_delegation"]);
	assert.match(directive ?? "", /Fresh Workbench lifecycle facts for this turn/u);
	assert.match(directive ?? "", /"tool_active":true/u);
	assert.match(directive ?? "", new RegExp(`call the listed exact tool with the supplied delegation_id`, "u"));
	assert.doesNotMatch(directive ?? "", /invent or reconstruct a new contract.*allowed_paths/u);

	const pausedCheckpoint = checkpoint(64);
	const paused = buildLifecycleActionSnapshotV2({ project_root: "/project", mode: "DEV", resolution: active, checkpoint: pausedCheckpoint });
	assert.equal(paused.ok, true);
	if (!paused.ok) return;
	assert.equal(paused.value.action, "PAUSED_BUDGET");
	assert.equal(paused.value.authorization, "USER_REQUIRED");
	assert.equal(lifecycleActionSnapshotTextV2(paused.value).includes("repair"), false);
	assert.deepEqual(lifecycleActionStatusLinesV2(paused.value), [
		"lifecycle v2 : PAUSED_BUDGET",
		"typed action : PAUSED_BUDGET (PAUSED_BUDGET_STANDARD_PROMOTION_AVAILABLE)",
		"next action  : the cumulative standard budget is paused; one ordinary explicit continue/authorize instruction promotes this exact checkpoint to the finite extended profile without resetting spend",
	]);
	const pausedDirective = lifecycleActionTurnDirectiveV2(paused.value, ["read", "workbench_delegation_status"]);
	assert.match(pausedDirective ?? "", /Stop execution and request the exact explicit user authorization/u);
	assert.match(pausedDirective ?? "", /do not call status as a substitute for authorization/iu);
	assert.match(pausedDirective ?? "", /do not create a successor/u);
	assert.match(pausedDirective ?? "", /"tool":null/u);

	for (const prompt of ["继续", "好的，那么请继续推进", "授权延长预算", "I authorize you to resume"]) {
		const authorized = authorizePausedBudgetContinuationTurnV1(paused.value, prompt, pausedCheckpoint);
		assert.ok(authorized, prompt);
		assert.equal(authorized.snapshot.action, "CONTINUE_CHECKPOINT");
		assert.equal(authorized.snapshot.tool, "workbench_repair_delegation");
		assert.equal(authorized.snapshot.authorization, "EXISTING");
		assert.equal(authorized.authorization.checkpoint_hash, paused.value.exact_target.bound_hash);
		assert.equal(authorized.authorization.target_profile, "extended");
		assert.equal(JSON.stringify(authorized.authorization).includes(prompt), false, "raw prompt must not enter authority");
	}
	for (const prompt of ["为什么不能继续？", "是否可以继续", "不要继续", "报告当前状态"]) {
		assert.equal(authorizePausedBudgetContinuationTurnV1(paused.value, prompt, pausedCheckpoint), undefined, prompt);
	}

	const extendedCheckpoint = checkpoint(96, "extended");
	const extended = buildLifecycleActionSnapshotV2({
		project_root: "/project", mode: "DEV", resolution: active, checkpoint: extendedCheckpoint,
	});
	assert.equal(extended.ok, true);
	if (!extended.ok) return;
	assert.equal(extended.value.reason_code, "PAUSED_BUDGET_EXTENDED_SPLIT_REQUIRED");
	assert.match(lifecycleActionSnapshotTextV2(extended.value), /new bounded task split/u);
	assert.equal(authorizePausedBudgetContinuationTurnV1(extended.value, "继续", extendedCheckpoint), undefined);
	assert.match(lifecycleActionTurnDirectiveV2(extended.value, ["read"]) ?? "", /SPLIT_REQUIRED/u);
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
