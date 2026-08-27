import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	EMPTY_WORKER_NO_PROGRESS_STATE,
	WORKER_NO_PROGRESS_STEER_MESSAGE_TYPE,
	aggregateDelegationEfficiency,
	advanceWorkerNoProgress,
	decideWorkerProfile,
	solCommanderDriftStatus,
} from "../extensions/workbench-runtime/core/development-efficiency.ts";
import {
	WORKER_CANARY_SCHEMA,
	buildWorkerCanaryReport,
	parseWorkerCanaryManifest,
	type WorkerCanaryManifest,
} from "../extensions/workbench-runtime/core/worker-canary.ts";
import { registerWorkerNoProgressController } from "../extensions/workbench-runtime/core/worker-no-progress-controller.ts";
import { readDelegationEfficiency, semanticReviewFromStrictRecord } from "../scripts/cache-benchmark.ts";

test("routing recommends standard only from complete bounded evidence without changing the default", () => {
	const bounded = decideWorkerProfile({
		task_kind: "implementation",
		risk: "low",
		root_cause_known: true,
		cross_cutting: false,
		allowed_path_count: 3,
		acceptance_criterion_count: 2,
		verification_count: 1,
	});
	assert.equal(bounded.recommended_profile, "standard");
	assert.equal(bounded.effective_profile, "standard", "advisory routing does not change the bounded runtime default");
	assert.equal(bounded.recommendation_status, "evidence_complete");

	const unknown = decideWorkerProfile({ task_kind: "implementation" });
	assert.equal(unknown.recommended_profile, "extended");
	assert.equal(unknown.effective_profile, "standard");
	assert.equal(unknown.recommendation_status, "insufficient_evidence");
	assert.ok(unknown.missing_evidence.includes("risk"));
	const malformed = decideWorkerProfile({
		task_kind: "implementation", risk: "tiny", root_cause_known: "yes", cross_cutting: "no",
		allowed_path_count: -1, acceptance_criterion_count: 1, verification_count: 1,
	});
	assert.equal(malformed.recommendation_status, "insufficient_evidence");
	assert.deepEqual([...malformed.missing_evidence].sort(), ["allowed_path_count", "cross_cutting", "risk", "root_cause_known"]);

	const explicit = decideWorkerProfile({
		task_kind: "implementation", requested_profile: "standard", risk: "high", root_cause_known: true,
		cross_cutting: true, allowed_path_count: 10, acceptance_criterion_count: 1, verification_count: 1,
	});
	assert.equal(explicit.recommended_profile, "extended");
	assert.equal(explicit.effective_profile, "standard", "the pure recommendation does not override explicit runtime selection");
	assert.equal(explicit.explicit_conflict, true);
});

test("delegation metrics exclude unknown and not-required semantic outcomes from yield denominators", () => {
	const metrics = aggregateDelegationEfficiency([
		{ delegation_id: "a", worker_outcome: "success", semantic_accepted: true, repair_depth: 0, review_bytes: 100, review_presentation_complete: true },
		{ delegation_id: "b", worker_outcome: "success", semantic_accepted: "unknown", repair_depth: 0, review_bytes: 50, review_presentation_complete: false },
		{ delegation_id: "c", worker_outcome: "failure", semantic_accepted: false, repair_depth: 0, review_bytes: "unknown", review_presentation_complete: "unknown" },
		{ delegation_id: "d", worker_outcome: "success", semantic_accepted: "not_required", repair_depth: "unknown", review_bytes: "unknown", review_presentation_complete: "unknown" },
		{ delegation_id: "e", worker_outcome: "success", semantic_accepted: true, repair_depth: 1, review_bytes: 25, review_presentation_complete: true },
		{ delegation_id: "a", worker_outcome: "failure", semantic_accepted: false, repair_depth: 9, review_bytes: 999, review_presentation_complete: false },
	]);
	assert.equal(metrics.attempts, 5);
	assert.equal(metrics.semantic_outcomes_known, 3);
	assert.equal(metrics.semantic_accepted, 2);
	assert.equal(metrics.semantic_not_required, 1);
	assert.equal(metrics.accepted_yield, 2 / 3);
	assert.equal(metrics.accepted_repair_depth_known, 2);
	assert.equal(metrics.first_accepted_yield, 0.5);
	assert.equal(metrics.max_repair_depth, "unknown");
	assert.equal(metrics.review_bytes_known, 3);
	assert.equal(metrics.review_bytes_unknown, 2);
	assert.equal(metrics.review_bytes_observed_total, 175);
	const incompleteLineage = aggregateDelegationEfficiency([
		{ delegation_id: "x", worker_outcome: "success", semantic_accepted: true, repair_depth: 0, review_bytes: 1, review_presentation_complete: true },
		{ delegation_id: "y", worker_outcome: "success", semantic_accepted: true, repair_depth: "unknown", review_bytes: 1, review_presentation_complete: true },
	]);
	assert.equal(incompleteLineage.accepted_repair_depth_unknown, 1);
	assert.equal(incompleteLineage.first_accepted_yield, "unknown");
});

test("implementation no-progress steering is one-shot while diagnosis remains disabled", () => {
	let state = { ...EMPTY_WORKER_NO_PROGRESS_STATE };
	for (let index = 0; index < 3; index += 1) {
		const result = advanceWorkerNoProgress(state, {
			task_kind: "implementation", successful_write: false, new_verification_evidence: false,
		});
		state = result.state;
		assert.equal(result.steer, false);
	}
	const fourth = advanceWorkerNoProgress(state, {
		task_kind: "implementation", successful_write: false, new_verification_evidence: false,
	});
	assert.equal(fourth.steer, true);
	const fifth = advanceWorkerNoProgress(fourth.state, {
		task_kind: "implementation", successful_write: false, new_verification_evidence: false,
	});
	assert.equal(fifth.steer, false);

	const diagnosis = advanceWorkerNoProgress({ ...EMPTY_WORKER_NO_PROGRESS_STATE, seen_assistant: true, consecutive_intervals: 99 }, {
		task_kind: "diagnosis", successful_write: false, new_verification_evidence: false,
	});
	assert.equal(diagnosis.steer, false);
	assert.equal(diagnosis.state.consecutive_intervals, 0);
});

test("worker no-progress controller steers once and treats new recipe run ids as progress", () => {
	type Handler = (event: Record<string, unknown>) => void;
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => sent.push({ message, options }),
	};
	registerWorkerNoProgressController({
		pi: pi as never,
		workerRole: "worker",
		workerTaskKind: "implementation",
	});
	const emit = (name: string, event: Record<string, unknown>) => {
		for (const handler of handlers.get(name) ?? []) handler(event);
	};
	const assistant = { message: { role: "assistant" } };
	emit("session_start", {});
	emit("message_end", assistant);
	emit("message_end", assistant);
	emit("message_end", assistant);
	emit("tool_execution_end", {
		toolName: "workbench_run_recipe",
		isError: false,
		result: { details: { ok: true, run_id: "run-1" } },
	});
	emit("message_end", assistant);
	assert.equal(sent.length, 0, "a new successful verification id resets the no-progress interval");
	emit("message_end", assistant);
	emit("message_end", assistant);
	emit("message_end", assistant);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.message.customType, WORKER_NO_PROGRESS_STEER_MESSAGE_TYPE);
	assert.deepEqual(sent[0]!.options, { deliverAs: "steer" });
	emit("message_end", assistant);
	assert.equal(sent.length, 1, "the advisory cannot loop");
});

test("Sol drift is visible but remains a pure status observation", () => {
	assert.equal(solCommanderDriftStatus({ provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "xhigh" }), null);
	assert.equal(solCommanderDriftStatus({ provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" }), "MODEL:SOL_HIGH!=XHIGH");
	assert.equal(solCommanderDriftStatus({ provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "bad\nstatus" }), "MODEL:SOL_REASONING_UNKNOWN");
	assert.equal(solCommanderDriftStatus({ provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "xhigh" }), "MODEL:CMD_DRIFT");
	assert.equal(solCommanderDriftStatus({}), "MODEL:CMD_UNKNOWN");
});

function canaryManifest(blocks: number, unknownIdentity = false): WorkerCanaryManifest {
	const identity = (model: string) => ({
		requested: { provider: "openai-codex", model, reasoning: "xhigh" },
		effective: { provider: "openai-codex", model: unknownIdentity ? null : model, reasoning: "xhigh" },
	});
	return {
		schema: WORKER_CANARY_SCHEMA,
		variants: { A: "extended baseline", B: "risk-routed standard" },
		trials: Array.from({ length: blocks }, (_, block) => (["A", "B", "B", "A"] as const).map((arm, index) => ({
			block_id: `block-${block}`,
			position: (index + 1) as 1 | 2 | 3 | 4,
			arm,
			task_family: `family-${block}`,
			commander: identity("gpt-5.6-sol"),
			worker: identity("gpt-5.6-luna"),
			elapsed_ms: arm === "A" ? 1_000 : 750,
			first_accepted: arm === "B" || index === 0,
			repair_depth: 0,
			review_bytes: 1_000,
			review_presentation_complete: true,
			regressions: 0,
			critical_defects: 0,
			scope_defects: 0,
			authority_defects: 0,
			commander_tokens: 100,
			worker_tokens: 200,
		}))).flat(),
	};
}

test("strict ABBA report stays non-authoritative and refuses sparse or unknown evidence", () => {
	const parsed = parseWorkerCanaryManifest(canaryManifest(12));
	assert.ok(parsed);
	const report = buildWorkerCanaryReport(parsed);
	assert.equal(report.complete_abba_blocks, 12);
	assert.equal(report.decision, "TARGET_MET");
	assert.equal(report.authority, "DESCRIPTIVE_ONLY");
	assert.equal(report.differences.elapsed_ratio_b_over_a, 0.75);

	const sparse = buildWorkerCanaryReport(canaryManifest(2));
	assert.equal(sparse.decision, "NOT_EVALUABLE");
	assert.ok(sparse.reasons.includes("insufficient_complete_abba_blocks"));

	const unknown = buildWorkerCanaryReport(canaryManifest(12, true));
	assert.equal(unknown.decision, "NOT_EVALUABLE");
	assert.ok(unknown.reasons.includes("unknown_primary_or_identity_facts"));
	const incomplete = canaryManifest(12);
	incomplete.trials.push({ ...incomplete.trials[0]!, block_id: "partial-block", position: 1, arm: "A" });
	const incompleteReport = buildWorkerCanaryReport(incomplete);
	assert.equal(incompleteReport.decision, "NOT_EVALUABLE");
	assert.ok(incompleteReport.reasons.includes("incomplete_or_invalid_abba_blocks"));

	const defectManifest = canaryManifest(12);
	defectManifest.trials.find((trial) => trial.arm === "B")!.critical_defects = 1;
	const defect = buildWorkerCanaryReport(defectManifest);
	assert.equal(defect.decision, "TARGET_NOT_MET");
	assert.ok(defect.reasons.includes("critical_defect_observed"));
});

test("delegation scanner separates legacy or non-v2 directories from invalid v2 authority", async () => {
	const projectRoot = await mkdtemp(join(tmpdir(), "delegation-efficiency-"));
	try {
		await mkdir(join(projectRoot, ".pi", "workbench", "delegations", "20260823-010203-abcd"), { recursive: true });
		const legacyOnly = await readDelegationEfficiency(projectRoot);
		assert.equal(legacyOnly.directories, 1);
		assert.equal(legacyOnly.strictRecords, 0);
		assert.equal(legacyOnly.legacyOrNotV2, 1);
		assert.equal(legacyOnly.invalidOrUnavailable, 0);
		assert.equal(legacyOnly.sourceIncomplete, false);
		assert.equal(legacyOnly.metrics.first_accepted_yield, "unknown");
		assert.equal(legacyOnly.metrics.max_repair_depth, "unknown");

		const invalid = join(projectRoot, ".pi", "workbench", "delegations", "20260823-010204-efgh", "v2");
		await mkdir(invalid, { recursive: true });
		await writeFile(join(invalid, "transaction.json"), "{}\n", "utf8");
		const mixed = await readDelegationEfficiency(projectRoot);
		assert.equal(mixed.directories, 2);
		assert.equal(mixed.strictRecords, 0);
		assert.equal(mixed.legacyOrNotV2, 1);
		assert.equal(mixed.invalidOrUnavailable, 1);
		assert.equal(mixed.sourceIncomplete, true);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("offline acceptance requires the strict schema-2 hash-bound Sol marker", () => {
	const hash = "a".repeat(64);
	const accepted = {
		schema_version: 2,
		semantic_review: "accepted",
		bound_diff_hash: hash,
		reviewed_at: "2026-08-23T00:00:00.000Z",
		semantic_acceptance: {
			decision: "ACCEPT",
			expected_bound_diff_hash: hash,
			reviewer: { provider: "openai-codex", model: "gpt-5.6-sol" },
			accepted_at: "2026-08-23T00:00:00.000Z",
		},
	};
	assert.equal(semanticReviewFromStrictRecord(accepted), true);
	assert.equal(semanticReviewFromStrictRecord({ ...accepted, schema_version: 1 }), "unknown");
	assert.equal(semanticReviewFromStrictRecord({
		...accepted,
		semantic_acceptance: { ...accepted.semantic_acceptance, expected_bound_diff_hash: "b".repeat(64) },
	}), "unknown");
	assert.equal(semanticReviewFromStrictRecord({ schema_version: 2, semantic_review: "not_required" }), "not_required");
});
