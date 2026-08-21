/** Formal context-output stress evidence; ordinary `npm test` stays light and write-free. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
	CONTEXT_OUTPUT_SCENARIO_IDS,
	runContextOutputEvidence,
	writeJsonAtomic,
	type ContextOutputEvidence,
} from "../scripts/context-output-evidence.ts";
import {
	HISTORY_MAX_BUNDLES,
	HISTORY_PROJECTION_MAX_SEGMENTS,
	HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
} from "../extensions/workbench-runtime/core/context-history-budget.ts";
import { OUTPUT_HARD_CAPS, WORKER_TURN_MAX_BYTES } from "../extensions/workbench-runtime/core/output-policy.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";

export const CONTEXT_OUTPUT_STRESS_ARTIFACT = ".pi/workbench/runs/context-output-stress/context-output-evidence.json";
const FORMAL_STRESS = process.env.npm_lifecycle_event === "test:context-output-stress";
const TELEMETRY_FILE_PATTERN = /^telemetry(?:\.\d+)?\.jsonl$/;

async function fingerprint(path: string): Promise<string> {
	try {
		const stats = await lstat(path);
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error";
	}
}

async function telemetrySnapshot(projectRoot: string): Promise<Record<string, { bytes: number; sha256: string }>> {
	const cacheDir = join(projectRoot, ".pi", "workbench", "cache");
	let names: string[];
	try {
		names = (await readdir(cacheDir)).filter((name) => TELEMETRY_FILE_PATTERN.test(name)).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	return Object.fromEntries(await Promise.all(names.map(async (name) => {
		const content = await readFile(join(cacheDir, name));
		return [name, { bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") }];
	})));
}

async function readTelemetryRecords(projectRoot: string): Promise<Array<Record<string, unknown>>> {
	const content = await readFile(join(projectRoot, ".pi", "workbench", "cache", "telemetry.jsonl"), "utf8");
	return content.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function isOfflineFakeTelemetryRecord(record: Record<string, unknown>): boolean {
	const usage = record.usage as Record<string, unknown> | undefined;
	return record.provider === WORKER_PROVIDER
		&& record.model === WORKER_MODEL_ID
		&& record.apiKind === "openai-completions"
		&& usage?.input === 100
		&& usage.output === 10
		&& usage.cacheRead === 0
		&& usage.cacheWrite === 0
		&& usage.totalTokens === 110;
}

test("ordinary npm test leaves formal stress disabled and does not touch its evidence artifact", { skip: FORMAL_STRESS }, async () => {
	const artifact = resolve(CONTEXT_OUTPUT_STRESS_ARTIFACT);
	const before = await fingerprint(artifact);
	await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
	const after = await fingerprint(artifact);
	assert.equal(after, before, "import and lightweight gating must not create or rewrite formal evidence");
	assert.equal(FORMAL_STRESS, false);
});

test("formal stress runs all nine offline scenarios and atomically persists hard-cap evidence", { skip: !FORMAL_STRESS }, async () => {
	const temporary = await mkdtemp(join(tmpdir(), "pi-context-output-stress-"));
	const repositoryRoot = resolve(".");
	const repositoryTelemetryBefore = await telemetrySnapshot(repositoryRoot);
	try {
		const evidence = await runContextOutputEvidence(temporary);
		assert.deepEqual(Object.keys(await telemetrySnapshot(temporary)), ["telemetry.jsonl"], "the temporary project must own the only stress telemetry sink");
		const isolatedRecords = await readTelemetryRecords(temporary);
		assert.equal(isolatedRecords.length, 25, "the isolated real AgentSession must persist one fake-usage record per provider response");
		assert.ok(isolatedRecords.every(isOfflineFakeTelemetryRecord), "the isolated telemetry sink must contain only deterministic fake-provider records");
		const artifact = resolve(CONTEXT_OUTPUT_STRESS_ARTIFACT);
		await writeJsonAtomic(artifact, evidence);
		const persisted = JSON.parse(await readFile(artifact, "utf8")) as ContextOutputEvidence;
		assert.deepEqual(persisted, evidence);
		assertEvidence(evidence);
	} finally {
		try {
			const repositoryTelemetryAfter = await telemetrySnapshot(repositoryRoot);
			assert.deepEqual(
				repositoryTelemetryAfter,
				repositoryTelemetryBefore,
				"offline formal stress must not create, append, or rotate repository cache telemetry",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
});

function assertEvidence(evidence: ContextOutputEvidence): void {
	assert.equal(evidence.schema, "workbench-context-output-evidence-v1");
	assert.equal(evidence.offline, true);
	assert.equal(evidence.model_calls, 0);
	assert.deepEqual(evidence.hard_caps, OUTPUT_HARD_CAPS);
	assert.deepEqual(evidence.scenarios.map((scenario) => scenario.id), [...CONTEXT_OUTPUT_SCENARIO_IDS]);
	assert.equal(evidence.scenarios.length, 9);
	assert.ok(evidence.scenarios.every((scenario) => scenario.status === "PASS"));
	assert.ok(evidence.scenarios.every((scenario) => scenario.acceptance.length > 0));
	assert.ok(evidence.scenarios.flatMap((scenario) => scenario.acceptance).every((check) => check.passed));
	for (const id of ["source-100mib-100k-lines", "single-line-10mib"] as const) {
		const sourceId = evidence.scenarios.find((scenario) => scenario.id === id)?.metrics.source_id;
		assert.match(String(sourceId), /^[0-9a-f]{64}$/);
	}
	assert.equal(evidence.acceptance.passed, true);
	assert.deepEqual(evidence.acceptance.failed_checks, []);
	assert.ok(evidence.metrics.per_result_text_bytes.count > 0);
	assert.ok(evidence.metrics.per_result_text_bytes.max <= 32_768);
	assert.ok(evidence.metrics.per_turn_tool_text_bytes.max <= 65_536);
	assert.ok(evidence.metrics.active_history_tool_text_bytes.max <= OUTPUT_HARD_CAPS.commander.historyMaxBytes);
	assert.equal(evidence.metrics.rss.sparse_log_child.measurement, "process.resourceUsage().maxRSS");
	assert.ok(evidence.metrics.rss.sparse_log_child.baseline_peak_bytes > 0);
	assert.ok(evidence.metrics.rss.sparse_log_child.peak_bytes >= evidence.metrics.rss.sparse_log_child.baseline_peak_bytes);
	assert.ok(evidence.metrics.rss.sparse_log_child.peak_delta_bytes < 64 * 1_024 * 1_024);
	const sparse = evidence.scenarios.find((scenario) => scenario.id === "sparse-logs-1gib");
	assert.equal(sparse?.metrics.rss_measurement, "child process.resourceUsage().maxRSS");
	assert.ok(Number(sparse?.metrics.rss_peak_delta_bytes) < 64 * 1_024 * 1_024);
	const diff = evidence.scenarios.find((scenario) => scenario.id === "diff-review-500-paths");
	assert.equal(diff?.metrics.checked_paths, 500);
	assert.equal(diff?.metrics.path_stat_entries, 500);
	assert.equal(diff?.metrics.artifact_complete, true);
	assert.equal(diff?.metrics.persisted_read_back, true);
	assert.equal(diff?.metrics.scope_violation_observed, true);
	const worker = evidence.scenarios.find((scenario) => scenario.id === "worker-standard-24-turns");
	const history = evidence.scenarios.find((scenario) => scenario.id === "active-history-100-turns");
	const roleReserve = history?.metrics.role_reserve as Record<string, Record<string, unknown>> | undefined;
	for (const role of ["commander", "worker"] as const) {
		assert.equal(roleReserve?.[role]?.same_epoch_payload_append_only, true, role);
		assert.equal(roleReserve?.[role]?.fixed_anchor_provider_visible_unchanged, true, role);
		assert.equal(roleReserve?.[role]?.fixed_anchor_nonempty, true, role);
		assert.equal(roleReserve?.[role]?.anchor_formula_valid, true, role);
		assert.equal(roleReserve?.[role]?.segment_seals_before_checkpoint, HISTORY_PROJECTION_MAX_SEGMENTS, role);
		assert.equal(roleReserve?.[role]?.checkpoint_ordinal, HISTORY_PROJECTION_MAX_SEGMENTS + 1, role);
		assert.equal(roleReserve?.[role]?.post_checkpoint_segment_seals, 2, role);
		assert.equal(roleReserve?.[role]?.stable_prior_markers_across_seals, true, role);
		assert.equal(roleReserve?.[role]?.stable_prior_provider_prefix_across_seals, true, role);
		assert.equal(roleReserve?.[role]?.segment_caps_valid, true, role);
		assert.equal(roleReserve?.[role]?.active_caps_valid, true, role);
		assert.equal(roleReserve?.[role]?.seal_selection_reserve_valid, true, role);
		assert.equal(roleReserve?.[role]?.reserve_only_crossing_observed, true, role);
		assert.equal(roleReserve?.[role]?.reserve_only_crossing_same_epoch_no_seal, true, role);
		assert.equal(roleReserve?.[role]?.state_within_32k, true, role);
		assert.equal(roleReserve?.[role]?.state_strict_json_roundtrip, true, role);
		assert.equal(roleReserve?.[role]?.segment_seals_keep_epoch, true, role);
		assert.equal(roleReserve?.[role]?.checkpoint_epoch_increment_exactly_one, true, role);
		assert.equal(roleReserve?.[role]?.checkpoint_epoch_hash_changed, true, role);
		assert.equal(roleReserve?.[role]?.transition_causes_expected, true, role);
		assert.equal(roleReserve?.[role]?.latest_complete_aggregate_raw, true, role);
		assert.equal(roleReserve?.[role]?.pairing_valid, true, role);
		assert.equal(roleReserve?.[role]?.hard_and_bundle_caps_valid, true, role);
		assert.ok(Number(roleReserve?.[role]?.max_projected_tool_text_bytes) <= Number(roleReserve?.[role]?.hard_history_bytes), role);
		assert.ok(Number(roleReserve?.[role]?.max_projected_bundles) <= HISTORY_MAX_BUNDLES, role);
		assert.equal(
			Number(roleReserve?.[role]?.segment_reserve_bytes),
			HISTORY_PROJECTION_MAX_SEGMENTS * HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
			role,
		);
		assert.equal(
			Number(roleReserve?.[role]?.anchor_max_bytes),
			Number(roleReserve?.[role]?.hard_history_bytes)
				- Number(roleReserve?.[role]?.aggregate_turn_bytes)
				- Number(roleReserve?.[role]?.segment_reserve_bytes),
			role,
		);
		assert.equal(
			Number(roleReserve?.[role]?.minimum_reserved_suffix_bytes),
			Number(roleReserve?.[role]?.aggregate_turn_bytes) + Number(roleReserve?.[role]?.segment_reserve_bytes),
			role,
		);
		assert.ok(Number(roleReserve?.[role]?.state_json_bytes_max) <= 32 * 1_024, role);
		assert.match(String(roleReserve?.[role]?.fixed_anchor_provider_sha256), /^[0-9a-f]{64}$/, role);
	}
	assert.equal(history?.metrics.bundle_cap, 128);
	assert.equal(history?.metrics.bundle_cap_enforced, true);
	assert.equal(history?.metrics.fail_closed_hostile_history, true);
	assert.equal(history?.metrics.cache_invalidation_reason, "HISTORY_PROJECTION_EPOCH_CHANGED");
	assert.equal(history?.metrics.cache_invalidation_class, "expected");
	assert.equal(history?.metrics.provider_cache_read_measurement, "not_measured_offline");
	assert.equal(worker?.metrics.production_read_tool_results, 24);
	assert.equal(worker?.fixture.source_file_bytes_each, 512 * 1_024);
	assert.equal(worker?.fixture.total_source_bytes, 24 * 512 * 1_024);
	assert.equal(worker?.fixture.reserve_crossing_tool_turn, 12);
	assert.equal(worker?.fixture.reserve_crossing_read_limit_lines, 1);
	assert.equal(worker?.fixture.reserve_crossing_first_line_bytes, 4 * 1_024);
	assert.ok(Number(worker?.metrics.max_pre_history_tool_result_text_bytes) <= 32_768);
	assert.equal(worker?.metrics.actual_tool_result_message_events, 24);
	assert.equal(worker?.metrics.forwarded_raw_tool_result_events, 0);
	assert.equal(worker?.metrics.turns, 25, "24 tool-result turns require a 25th provider response to observe the final projection");
	assert.equal(worker?.metrics.preflight_observations, 25);
	assert.equal(worker?.metrics.child_context_requests, 25);
	assert.equal(worker?.metrics.child_before_provider_requests, 25);
	assert.equal(worker?.metrics.request_boundary_order_valid, true);
	assert.equal(worker?.metrics.projections_after_completed_tool_turns, 24);
	assert.equal(worker?.metrics.child_context_handler_count, 1);
	assert.equal(worker?.metrics.child_before_provider_handler_count, 1);
	assert.equal(worker?.metrics.child_project_trusted, true);
	assert.equal(worker?.metrics.production_runtime_package_provenance_valid, true);
	assert.equal(worker?.metrics.session_project_root_isolated, true);
	assert.equal(worker?.metrics.isolated_telemetry_records, 25);
	assert.ok(Number(worker?.metrics.isolated_telemetry_bytes) > 0);
	assert.match(String(worker?.metrics.isolated_telemetry_sha256), /^[0-9a-f]{64}$/);
	assert.equal(worker?.metrics.isolated_telemetry_only_fake_records, true);
	assert.equal(worker?.metrics.child_canonical_telemetry_entries_before_final_response, 24);
	assert.equal(worker?.metrics.child_facts_consistent, true);
	assert.equal(worker?.metrics.preflight_before_every_provider_response, true);
	assert.equal(worker?.metrics.canonical_progress_one_turn_lag_observed, true);
	assert.equal(worker?.metrics.final_output_control_observed, true);
	assert.ok(Number(worker?.metrics.final_collapsed_tool_results) > 0);
	assert.ok(Number(worker?.metrics.context_pressure_entries) >= 24);
	assert.equal(worker?.metrics.context_pressure_nine_fields_valid, true);
	assert.ok(Number(worker?.metrics.history_projection_v3_entries) >= 24);
	assert.equal(worker?.metrics.history_projection_v3_valid, true);
	assert.equal(worker?.metrics.history_projection_hard_caps_valid, true);
	assert.equal(worker?.metrics.history_projection_remaining_capacity_valid, true);
	assert.equal(worker?.metrics.history_projection_selection_reserve_valid, true);
	assert.equal(worker?.metrics.history_projection_reserve_only_growth_observed, true);
	assert.equal(worker?.metrics.history_projection_reserve_only_growth_stayed_same_topology, true);
	const reserveCrossingResultBytes = Number(worker?.metrics.reserve_crossing_result_text_bytes);
	const reserveCrossingActiveBytes = Number(worker?.metrics.maximum_history_projection_active_tool_text_bytes);
	assert.ok(reserveCrossingResultBytes > 0 && reserveCrossingResultBytes < 12_288);
	assert.equal(
		reserveCrossingActiveBytes,
		WORKER_TURN_MAX_BYTES + reserveCrossingResultBytes,
		"the deterministic smaller page must grow the same active topology strictly beyond the 48 KiB selection reserve",
	);
	assert.equal(worker?.metrics.reserve_crossing_expected_active_tool_text_bytes, reserveCrossingActiveBytes);
	assert.ok(reserveCrossingActiveBytes > WORKER_TURN_MAX_BYTES, "reserve-only crossing must stay strict");
	assert.ok(reserveCrossingActiveBytes < OUTPUT_HARD_CAPS.worker.historyMaxBytes, "reserve-only growth must remain below the true hard cap");
	assert.ok(Number(worker?.metrics.maximum_history_projection_state_bytes) <= 32 * 1_024);
	assert.equal(
		worker?.metrics.minimum_worker_anchor_reserve_bytes,
		48 * 1_024 + HISTORY_PROJECTION_MAX_SEGMENTS * HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
	);
	assert.equal(worker?.metrics.latest_completed_bundle_raw, true);
	assert.equal(worker?.metrics.offline_provider_cache_read_tokens, 0);
	assert.equal(worker?.metrics.real_provider_cache_read_measured, false);
	assert.equal(worker?.metrics.source_files_unchanged, true);
	assert.equal(evidence.metrics.compaction_count, 0);
	assert.deepEqual(evidence.metrics.worker, { success: true, failure_reason: "none" });
	assert.match(evidence.note, /Gate.*authoritative/);
}
