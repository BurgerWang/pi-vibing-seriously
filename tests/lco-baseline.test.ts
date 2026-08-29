import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
	LCO_BASELINE_AGGREGATOR_VERSION,
	aggregateCommanderSessionJsonl,
	summarizeReplayFixture,
} from "../scripts/lco-throughput-baseline.ts";
import { LCO_THROUGHPUT_EXIT_VERSION, computeLcoThroughputExitV1 } from "../scripts/lco-throughput-exit.ts";

const ROOT = process.cwd();

test("LCO WP0 freezes internally consistent request, time, and ordinary DEV baselines", async () => {
	const baselineText = await readFile(join(ROOT, "docs/baselines/pi-workbench-lco-v1.json"), "utf8");
	const baseline = JSON.parse(baselineText) as any;
	assert.equal(baseline.sources.aggregation_script.version, LCO_BASELINE_AGGREGATOR_VERSION);
	assert.equal(baseline.classification.requests.reduce((sum: number, row: any) => sum + row.requests, 0), 399);
	assert.equal(baseline.wall_clock.phases.reduce((sum: number, row: any) => sum + row.minutes, 0), 224.4);
	assert.equal(baseline.long_chain.review_tool_calls, 223);
	assert.equal(baseline.ordinary_dev_guardrail.first_effective_write_median_seconds, 3.707);
	assert.equal(baseline.ordinary_dev_guardrail.exit_maximum_seconds, 4.960);
	assert.deepEqual(baseline.protocol_freeze.allowed_new_core_modules, ["semantic-review-evidence-v2.ts", "worker-checkpoint.ts"]);
	assert.equal(baseline.external_project_boundary.every((entry: any) => entry.written_by_lco_wp0 === false), true);
	for (const forbidden of ["BEGIN PRIVATE KEY", "api_key", "authorization: bearer", "message.content", "/mnt/tb4/Code/"]) {
		assert.equal(baselineText.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
	}
});

test("LCO synthetic replay fixture is exactly 42 paths and 47 pages", async () => {
	const fixtureText = await readFile(join(ROOT, "tests/fixtures/lco-long-chain-replay-v1.json"), "utf8");
	const summary = summarizeReplayFixture(JSON.parse(fixtureText));
	assert.deepEqual(summary, { streams: 42, unique_paths: 42, pages: 47, synthetic_only: true });
	assert.equal(fixtureText.includes("Scalper"), false);
	assert.equal(fixtureText.includes("Mace"), false);
	assert.equal(fixtureText.includes("Onchain"), false);
});

test("LCO session aggregator never projects prompts or tool bodies", () => {
	const aggregate = aggregateCommanderSessionJsonl([
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "secret" }] } }),
		JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "workbench_review_worker_diff", content: [{ type: "text", text: "source" }] } }),
		JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "prompt" }] } }),
	].join("\n"));
	assert.deepEqual(aggregate, { commander_requests: 1, tool_results: 1, tool_calls: { workbench_review_worker_diff: 1 } });
	assert.equal(JSON.stringify(aggregate).includes("secret"), false);
	assert.equal(JSON.stringify(aggregate).includes("source"), false);
	assert.equal(JSON.stringify(aggregate).includes("prompt"), false);
});

test("LCO sanitized same-topology replay preserves workload and recomputes the performance exit", async () => {
	const baseline = JSON.parse(await readFile(join(ROOT, "docs/baselines/pi-workbench-lco-v1.json"), "utf8")) as any;
	const observationsText = await readFile(
		join(ROOT, "docs/baselines/pi-workbench-lco-v1-performance-observations.json"),
		"utf8",
	);
	const observations = JSON.parse(observationsText) as any;
	const replay = computeLcoThroughputExitV1(baseline, observations);
	assert.equal(replay.schema_version, LCO_THROUGHPUT_EXIT_VERSION);
	assert.equal(replay.evidence_class, "SANITIZED_COUNTERFACTUAL_REPLAY");
	assert.deepEqual(replay.preserved_workload, {
		product_worker_minutes: 92.6,
		orientation_status_coordination_minutes: 28.6,
		recipe_runs: 63,
		recipe_process_seconds: 46.8,
	});
	assert.deepEqual(replay.metrics, {
		wall_minutes: 124.08,
		commander_requests: 127,
		commander_review_tool_calls: 0,
		ordinary_delegation_review_actions: 2,
		review_page_batches: 6,
		final_model_calls: 1,
		commander_tool_text_bytes: 491327,
		review_output_share: 0.013671,
		active_review_snapshot_bytes: 781,
		no_worker_repair_calls: 0,
		review_commander_cost_usd: 0.845234,
		commander_total_cost_usd: 11.346234,
		raw_page_bytes_in_final: 0,
		checkpoint_continuation_repeated_review_count: 0,
	});
	for (const forbidden of ["BEGIN PRIVATE KEY", "api_key", "authorization: bearer", "message.content", "Scalper_V2 commander session"])
		assert.equal(observationsText.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
});

test("LCO exit report binds final runtime, inheritance, performance, and read-only canaries", async () => {
	const exit = JSON.parse(await readFile(join(ROOT, "docs/baselines/pi-workbench-lco-v1-exit.json"), "utf8")) as any;
	assert.equal(exit.overall_verdict, "COMPLETE_QUALITY_AND_PERFORMANCE_PASS");
	assert.equal(exit.plan_complete, true);
	assert.equal(exit.work_packages.filter((item: any) => item.verdict === "PASS").length, 8);
	assert.equal(exit.work_packages.find((item: any) => item.id === "LCO-WP7")?.verdict, "PASS");
	assert.equal(exit.quality_qualification.corpus.total, 60);
	assert.equal(exit.quality_qualification.release_blocking_metrics.every((item: any) => item.observed === 0), true);
	assert.equal(exit.complexity_budget.new_pure_core_module_count, 2);
	assert.equal(exit.source_identity.runtime_reload_performed, false);
	assert.equal(exit.source_identity.fresh_process_restart_performed, true);
	assert.equal(exit.source_identity.loaded_runtime_source_hash, exit.source_identity.disk_runtime_source_hash);
	assert.equal(exit.source_identity.loaded_runtime_source_hash, "sha256:ee5f1e342a2adbbd11bb2c169324fe8b53dac52c48df5f60ad7f12e28cb375c7");
	assert.equal(exit.runtime_canaries.synthetic_42_path_47_page.completed_batch_replay_count, 0);
	assert.equal(exit.runtime_canaries.synthetic_42_path_47_page.raw_page_content_in_final, false);
	assert.equal(exit.runtime_canaries.acceptance.find((item: any) => item.id === "LCO-WP7-AC03")?.verdict, "PASS");
	assert.equal(exit.runtime_canaries.scalper.successor_inheritance_e2e.child_fresh_streams, 1);
	assert.equal(exit.runtime_canaries.scalper.successor_inheritance_e2e.child_inherited_streams, 41);
	assert.equal(exit.runtime_canaries.scalper.successor_inheritance_e2e.false_inherited_streams, 0);
	assert.equal(exit.tiered_verdict.throughput_metrics, "PASS_SANITIZED_SAME_TOPOLOGY_REPLAY");
	assert.equal(exit.performance_evidence.historical_raw_session_transmitted, false);
	assert.equal(exit.quantitative_exit.every((item: any) => item.verdict.startsWith("PASS")), true);
	assert.equal(exit.external_projects.every((project: any) => project.written === false), true);
	assert.equal(exit.external_projects.every((project: any) => project.canary === "PASS_ISOLATED_CLONE"), true);
});
