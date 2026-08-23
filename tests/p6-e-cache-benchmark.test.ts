/**
 * P6-E cache benchmark CLI tests — offline report aggregation, doctor
 * offline checks, tolerant reading (bad lines, missing telemetry), cost-map
 * rules, compare normalization and CLI exit behavior.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	buildBenchmarkReport,
	groupTelemetryByExtensionVersion,
	MAX_RENDERED_VERSION_COHORTS,
	normalizeReport,
	parseCliArgs,
	readActionCache,
	readRunManifests,
	readTelemetry,
	renderBenchmarkReport,
	renderCompare,
	saveBenchmarkReport,
	type BenchmarkReport,
} from "../scripts/cache-benchmark.ts";
import type { TelemetryRecord } from "../extensions/workbench-runtime/cache/cache-types.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

/** One valid current telemetry record (schema 1.2). */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "1.2",
		timestamp: "2026-08-02T01:57:35.263Z",
		extensionVersion: "0.8.0",
		hashedSessionId: "a".repeat(16),
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		thinkingLevel: "max",
		workbenchMode: "DEV",
		messageStatus: "ok",
		usage: { input: 1000, output: 100, cacheRead: 9000, cacheWrite: 0, totalTokens: 10100, cost: 0.001 },
		usageSemanticStatus: "verified",
		cacheHitRatio: 0.9,
		systemPromptHash: "a".repeat(64),
		activeToolNamesHash: "b".repeat(64),
		activeToolOrderHash: "c".repeat(64),
		activeToolSchemaHash: "d".repeat(64),
		contextShapeHash: "e".repeat(64),
		precedingEvent: "before_provider_request",
		inferredInvalidationReason: "FIRST_OBSERVED_REQUEST",
		inferenceConfidence: "high",
		driftSource: null,
		...overrides,
	};
}

function recordV13(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return record({
		schemaVersion: "1.3",
		promptInputTokens: 10000,
		cacheReadShare: 0.9,
		cacheWriteShare: null,
		cacheWriteStatusCode: 1,
		actorRoleCode: 2,
		requestCorrelationCode: 1,
		historyProjection: null,
		wireObservation: {
			requestSerial: 1,
			finalityCode: 0,
			digestStatusCode: 1,
			apiShapeCode: 1,
			relationshipCode: 1,
			itemCount: 1,
			itemLcpCount: 0,
			itemLcpUtf8Bytes: 0,
		},
		...overrides,
	});
}

async function makeProject(root: string): Promise<void> {
	const cache = join(root, ".pi", "workbench", "cache");
	await mkdir(join(cache, "actions"), { recursive: true });
	await mkdir(join(cache, "locks"), { recursive: true });
	await mkdir(join(cache, "tmp"), { recursive: true });
	await mkdir(join(cache, "reports"), { recursive: true });
	await mkdir(join(root, ".pi", "workbench", "runs", "20260802-100000-aaaa"), { recursive: true });
	await mkdir(join(root, ".pi", "workbench", "runs", "20260802-100001-bbbb"), { recursive: true });

	// Telemetry: two valid lines + one corrupt line + one empty line.
	await writeFile(
		join(cache, "telemetry.jsonl"),
		[
			JSON.stringify(record({})),
			JSON.stringify(record({ timestamp: "2026-08-02T01:58:00.000Z", usage: { input: 2000, output: 200, cacheRead: 8000, cacheWrite: 0, totalTokens: 10200, cost: 0.002 }, cacheHitRatio: 0.8 })),
			"{this is not json",
			"",
		].join("\n"),
		"utf8",
	);

	// Exec run manifest (recipe typecheck, 30 s).
	await writeFile(
		join(root, ".pi", "workbench", "runs", "20260802-100000-aaaa", "manifest.json"),
		JSON.stringify({ run_id: "20260802-100000-aaaa", recipe: "typecheck", execution_source: "exec", duration_ms: 30000 }, null, 2),
		"utf8",
	);
	// Cache-hit run manifest referencing the action record below.
	await writeFile(
		join(root, ".pi", "workbench", "runs", "20260802-100001-bbbb", "manifest.json"),
		JSON.stringify(
			{ run_id: "20260802-100001-bbbb", recipe: "typecheck", execution_source: "cache", action_key: "key1", reused_from_run_id: "20260802-100000-aaaa", duration_ms: 12 },
			null,
			2,
		),
		"utf8",
	);

	// Action records: one valid (durationMs 30000) + one corrupt (schema mismatch).
	await writeFile(
		join(cache, "actions", "key1.json"),
		JSON.stringify({ schemaVersion: 1, actionKey: "key1", recipe: "typecheck", success: true, durationMs: 30000, sourceRunId: "20260802-100000-aaaa" }, null, 2),
		"utf8",
	);
	await writeFile(join(cache, "actions", "badkey.json"), JSON.stringify({ schemaVersion: 99, actionKey: "different" }, null, 2), "utf8");
	await writeFile(join(cache, "tmp", "corrupt-key1-unparseable-json.json"), "{}", "utf8");

	// One stale lock (dead owner pid, old timestamp).
	await writeFile(join(cache, "locks", "key1.lock"), JSON.stringify({ key: "key1", token: "t", ownerPid: 99999999, createdAt: "2026-01-01T00:00:00.000Z" }), "utf8");
}

test("readTelemetry: valid lines parsed, corrupt lines skipped and counted, rotated files read", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const result = await readTelemetry(root);
		assert.equal(result.records.length, 2);
		assert.equal(result.skipped, 1);
		assert.equal(result.sourceIncomplete, true);
		assert.ok(result.file?.endsWith("telemetry.jsonl"));
		assert.equal(result.rotatedFiles, 0);
	});
});

test("readTelemetry: rotations are strict oldest-to-current and the retained window is bounded", async () => {
	await withTempDir(async (root) => {
		const cache = join(root, ".pi", "workbench", "cache");
		await mkdir(cache, { recursive: true });
		await writeFile(join(cache, "telemetry.2.jsonl"), `${JSON.stringify(record({ timestamp: "2026-08-02T00:00:00.000Z" }))}\n`, "utf8");
		await writeFile(join(cache, "telemetry.1.jsonl"), `${JSON.stringify(record({ timestamp: "2026-08-02T01:00:00.000Z" }))}\n`, "utf8");
		await writeFile(join(cache, "telemetry.jsonl"), `${JSON.stringify(record({ timestamp: "2026-08-02T02:00:00.000Z" }))}\n`, "utf8");

		const result = await readTelemetry(root, { maxRecords: 2 });
		assert.deepEqual(result.records.map((item) => item.timestamp), ["2026-08-02T01:00:00.000Z", "2026-08-02T02:00:00.000Z"]);
		assert.equal(result.rotatedFiles, 2);
		assert.equal(result.filesRead, 3);
		assert.equal(result.truncatedRecords, 1);
		assert.equal(result.sourceIncomplete, false);
		assert.ok(result.telemetryBytes > 0);
	});
});

test("readTelemetry: schema-shaped JSON is rejected unless it satisfies the strict telemetry contract", async () => {
	await withTempDir(async (root) => {
		const cache = join(root, ".pi", "workbench", "cache");
		await mkdir(cache, { recursive: true });
		await writeFile(join(cache, "telemetry.jsonl"), `${JSON.stringify({ timestamp: "2026-08-02T00:00:00.000Z", usage: {} })}\n`, "utf8");
		const result = await readTelemetry(root);
		assert.equal(result.records.length, 0);
		assert.equal(result.skipped, 1);
		assert.equal(result.sourceIncomplete, true);
	});
});

test("readTelemetry: invalid UTF-8 is unavailable evidence and cannot contribute records or estimates", async () => {
	await withTempDir(async (root) => {
		const cache = join(root, ".pi", "workbench", "cache");
		await mkdir(cache, { recursive: true });
		const payload = Buffer.from(`${JSON.stringify(record())}\n`, "utf8");
		const providerMarkerOffset = payload.indexOf(Buffer.from('"provider":"deepseek"', "utf8"));
		assert.notEqual(providerMarkerOffset, -1, "fixture must contain the provider value");
		const providerValueOffset = providerMarkerOffset + '"provider":"'.length;
		payload[providerValueOffset] = 0xff;
		await writeFile(join(cache, "telemetry.jsonl"), payload);

		const telemetry = await readTelemetry(root);
		assert.equal(telemetry.records.length, 0);
		assert.equal(telemetry.skipped, 0);
		assert.equal(telemetry.sourceIncomplete, true);
		assert.equal(telemetry.unavailable, "read_error");

		const report = await buildBenchmarkReport({
			projectRoot: root,
			scope: "project",
			costMap: { "deepseek/deepseek-v4-flash": { cacheRead: 2.8 } },
		});
		assert.equal(report.requestCount, 0);
		assert.equal(report.cacheHitRatio, null);
		assert.equal(report.estimatedAvoidedCost, null);
		assert.equal(report.telemetrySourceIncomplete, true);
		assert.ok(renderBenchmarkReport(report).some((line) => line.includes("incomplete telemetry observation")));
	});
});

test("readTelemetry: missing file is a friendly empty result", async () => {
	await withTempDir(async (root) => {
		const result = await readTelemetry(root);
		assert.equal(result.records.length, 0);
		assert.equal(result.skipped, 0);
		assert.equal(result.file, null);
		assert.equal(result.sourceIncomplete, false);
		assert.equal(result.filesRead, 0);
	});
});

test("readRunManifests: exec and cache-hit manifests distinguished", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const result = await readRunManifests(root);
		assert.equal(result.manifests.length, 2);
		const cache = result.manifests.find((m) => m.executionSource === "cache");
		assert.ok(cache);
		assert.equal(cache?.actionKey, "key1");
		assert.equal(cache?.reusedFromRunId, "20260802-100000-aaaa");
	});
});

test("readRunManifests ignores gate indexes and non-run entries", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const runs = join(root, ".pi", "workbench", "runs");
		await mkdir(join(runs, ".gate-index"));
		await writeFile(join(runs, ".gate-index", "marker.json"), "{}\n", "utf8");
		await mkdir(join(runs, "not-a-run"));
		await writeFile(join(runs, "README.txt"), "diagnostic\n", "utf8");
		const result = await readRunManifests(root);
		assert.equal(result.manifests.length, 2);
		assert.equal(result.corrupt, 0);
	});
});

test("readActionCache: records, corruption evidence, stale locks and sizes", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const facts = await readActionCache(root);
		// key1 is valid; badkey has a schema/key mismatch -> corruption evidence.
		assert.equal(facts.records, 1);
		assert.ok(facts.corruptQuarantined >= 2); // badkey mismatch + tmp/corrupt-* copy
		assert.equal(facts.staleLocks, 1); // dead pid + old timestamp
		assert.equal(facts.durationsByKey.get("key1"), 30000);
		assert.ok(facts.totalBytes > 0);
	});
});

test("buildBenchmarkReport: all required fields with correct aggregation", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const report = await buildBenchmarkReport({ projectRoot: root, scope: "project" });
		assert.equal(report.schemaVersion, "1.1");
		// Field presence: the P6-E contract list.
		const expected: Array<keyof BenchmarkReport> = [
			"requestCount",
			"schema13Rows",
			"observability",
			"modelRoleObservability",
			"delegationEfficiency",
			"uncachedInputTokens",
			"cacheReadTokens",
			"outputTokens",
			"cacheHitRatio",
			"usageSemanticStatus",
			"providerReportedCost",
			"estimatedAvoidedCost",
			"expectedInvalidations",
			"unexpectedDrifts",
			"historyProjectionSegmentSeals",
			"historyProjectionEpochTransitions",
			"explicitBreakpointAppliedRequests",
			"explicitBreakpointVerifiedUsage",
			"modeChanges",
			"modelChanges",
			"thinkingChanges",
			"reloads",
			"compactions",
			"recipeExecutions",
			"recipeCacheHits",
			"recipeCacheMisses",
			"recipeCacheUnknown",
			"recipeHitRatio",
			"recipeCohorts",
			"extensionVersionCohorts",
			"localExecutionTimeAvoided",
			"cacheStorageSize",
			"corruptionCount",
			"fallbackCount",
			"telemetrySourceIncomplete",
			"truncatedTelemetryRecords",
		];
		for (const key of expected) assert.ok(key in report, key);
		assert.equal(report.requestCount, 2);
		assert.equal(report.uncachedInputTokens, 3000);
		assert.equal(report.cacheReadTokens, 17000);
		assert.equal(report.outputTokens, 300);
		assert.equal(report.cacheHitRatio, null);
		assert.equal(report.usageSemanticStatus, "verified");
		assert.equal(report.providerReportedCost, 0.003);
		assert.equal(report.estimatedAvoidedCost, null); // no cost-map -> null, never hardcoded
		assert.equal(report.recipeExecutions, 2);
		assert.equal(report.recipeCacheHits, 1);
		assert.equal(report.recipeCacheMisses, 1);
		assert.equal(report.recipeCacheUnknown, 0);
		assert.equal(report.recipeHitRatio, 0.5);
		assert.equal(report.localExecutionTimeAvoided, 30); // from the action record duration
		assert.deepEqual(report.recipeCohorts.typecheck, {
			executions: 2,
			hits: 1,
			misses: 1,
			unknown: 0,
			hitRatio: 0.5,
			localExecutionTimeAvoided: 30,
		});
		assert.deepEqual(report.extensionVersionCohorts["0.8.0"], {
			requestCount: 2,
			uncachedInputTokens: 3000,
			cacheReadTokens: 17000,
			outputTokens: 300,
			cacheHitRatio: null,
			usageSemanticStatus: "verified",
		});
		assert.ok(report.cacheStorageSize > 0);
		assert.ok(report.corruptionCount >= 3); // badkey + corrupt copy + bad telemetry line
		assert.equal(report.fallbackCount, 1);
		assert.equal(report.skippedTelemetryLines, 1);
		assert.equal(report.telemetrySourceIncomplete, true);
		assert.equal(report.truncatedTelemetryRecords, 0);
		assert.equal(report.schema13Rows, 0);
		assert.equal(report.observability, null, "legacy rows remain unobserved rather than zero-filled 1.3 facts");
		assert.equal(report.modelRoleObservability.commander.requestCount, 0);
		assert.equal(report.modelRoleObservability.worker.requestCount, 0);
		assert.deepEqual(report.delegationEfficiency, {
			metrics: {
				attempts: 0,
				worker_outcomes_known: 0,
				worker_successes: 0,
				semantic_outcomes_known: 0,
				semantic_accepted: 0,
				semantic_not_required: 0,
				accepted_yield: "unknown",
				accepted_repair_depth_known: 0,
				accepted_repair_depth_unknown: 0,
				first_attempt_accepted: 0,
				first_accepted_yield: "unknown",
				repair_depth_known: 0,
				repair_depth_unknown: 0,
				max_repair_depth: "unknown",
				review_bytes_known: 0,
				review_bytes_unknown: 0,
				review_bytes_observed_total: 0,
				review_presentation_known: 0,
				review_presentation_unknown: 0,
				review_presentation_complete: 0,
			},
			directories: 0,
			strictRecords: 0,
			legacyOrNotV2: 0,
			invalidOrUnavailable: 0,
			sourceIncomplete: false,
		});
	});
});

test("unknown recipe sources are reported separately and excluded from the hit denominator", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const runId = "20260802-100002-cccc";
		const runDir = join(root, ".pi", "workbench", "runs", runId);
		await mkdir(runDir);
		await writeFile(join(runDir, "manifest.json"), JSON.stringify({ run_id: runId, recipe: "typecheck", duration_ms: 1 }), "utf8");
		const report = await buildBenchmarkReport({ projectRoot: root, scope: "project" });
		assert.equal(report.sources.runManifests, 3);
		assert.equal(report.recipeExecutions, 2);
		assert.equal(report.recipeCacheHits, 1);
		assert.equal(report.recipeCacheMisses, 1);
		assert.equal(report.recipeCacheUnknown, 1);
		assert.equal(report.recipeHitRatio, 0.5);
		assert.equal(report.recipeCohorts.typecheck?.unknown, 1);
		assert.equal(report.recipeCohorts.typecheck?.executions, 2);
	});
});

test("extension-version grouping is single-pass and human rendering is bounded", async () => {
	const records = Array.from({ length: MAX_RENDERED_VERSION_COHORTS + 7 }, (_, index) =>
		record({ extensionVersion: `v-${String(index).padStart(3, "0")}` }) as unknown as TelemetryRecord);
	let visits = 0;
	const grouped = groupTelemetryByExtensionVersion(records, () => { visits += 1; });
	assert.equal(visits, records.length);
	assert.equal(grouped.size, records.length);

	await withTempDir(async (root) => {
		const cache = join(root, ".pi", "workbench", "cache");
		await mkdir(cache, { recursive: true });
		await writeFile(join(cache, "telemetry.jsonl"), `${records.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
		const report = await buildBenchmarkReport({ projectRoot: root, scope: "project" });
		assert.equal(Object.keys(report.extensionVersionCohorts).length, records.length, "JSON retains every bounded-source cohort");
		const lines = renderBenchmarkReport(report);
		assert.equal(lines.filter((line) => line.startsWith("version cohort v-")).length, MAX_RENDERED_VERSION_COHORTS);
		assert.ok(lines.some((line) => line === "version cohorts omitted: 7 (JSON retains all bounded-source cohorts)"));
	});
});

test("buildBenchmarkReport mirrors schema 1.3 observability without claiming final actual wire", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const telemetryPath = join(root, ".pi", "workbench", "cache", "telemetry.jsonl");
		const commander = recordV13({
			provider: "openai",
			model: "gpt-5.6",
			apiKind: "openai-responses",
			usage: { input: 9, output: 1, cacheRead: 90, cacheWrite: 1, totalTokens: 101, cost: 0.01 },
			cacheHitRatio: 90 / 99,
			promptInputTokens: 100,
			cacheReadShare: 0.9,
			cacheWriteShare: 0.01,
			cacheWriteStatusCode: 2,
			actorRoleCode: 1,
		});
		const worker = recordV13({
			timestamp: "2026-08-02T01:58:00.000Z",
			usage: { input: 20, output: 1, cacheRead: 80, cacheWrite: 0, totalTokens: 101, cost: 0.01 },
			cacheHitRatio: 0.8,
			promptInputTokens: 100,
			cacheReadShare: 0.8,
			wireObservation: {
				requestSerial: 2,
				finalityCode: 0,
				digestStatusCode: 1,
				apiShapeCode: 1,
				relationshipCode: 2,
				itemCount: 2,
				itemLcpCount: 1,
				itemLcpUtf8Bytes: 9,
			},
		});
		await writeFile(telemetryPath, `${JSON.stringify(commander)}\n${JSON.stringify(worker)}\n`, "utf8");

		const report = await buildBenchmarkReport({ projectRoot: root, scope: "project" });
		assert.equal(report.schema13Rows, 2);
		assert.equal(report.observability?.retainedWindowUsage.cacheReadShare, 0.85);
		assert.equal(report.observability?.retainedWindowUsage.cacheWriteShare, null);
		assert.equal(report.observability?.actorCohorts.commander.cacheWriteShare, 0.01);
		assert.equal(report.observability?.actorCohorts.worker.cacheWriteShare, null);
		assert.deepEqual(report.observability?.wholeItemLcp, { eligibleRequests: 2, itemCount: 1, utf8Bytes: 9 });
		const rendered = renderBenchmarkReport(report).join("\n");
		assert.match(rendered, /local wire observation: requests=2 nonfinal=2 finalityCode=0/);
		assert.match(rendered, /actor cohorts\s+: unknown=0 commander=1 worker=1/);
		assert.ok(!rendered.includes("verified wire"));
	});
});

test("buildBenchmarkReport mirrors projection and verified explicit-breakpoint record facts", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const telemetryPath = join(root, ".pi", "workbench", "cache", "telemetry.jsonl");
		const segment = record({
			inferredInvalidationReason: "HISTORY_PROJECTION_SEGMENT_SEALED",
			precedingEvent: "context_projection",
		});
		const epoch = record({
			timestamp: "2026-08-02T01:58:00.000Z",
			inferredInvalidationReason: "HISTORY_PROJECTION_EPOCH_CHANGED",
			precedingEvent: "context_projection",
		});
		const applied = record({
			timestamp: "2026-08-02T01:59:00.000Z",
			provider: "openai",
			model: "gpt-5.6-sol",
			apiKind: "openai-responses",
			precedingEvent: "explicit_prompt_cache_breakpoints_applied",
			inferredInvalidationReason: "UNKNOWN",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 5, totalTokens: 115, cost: 0.01 },
			cacheHitRatio: 0,
		});
		await writeFile(telemetryPath, `${[segment, epoch, applied].map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");

		const report = await buildBenchmarkReport({ projectRoot: root, scope: "project" });
		assert.equal(report.historyProjectionSegmentSeals, 1);
		assert.equal(report.historyProjectionEpochTransitions, 1);
		assert.equal(report.explicitBreakpointAppliedRequests, 1);
		assert.deepEqual(report.explicitBreakpointVerifiedUsage, {
			requestCount: 1,
			input: 100,
			cacheRead: 0,
			cacheWrite: 5,
			hitRatio: 0,
		});
		const rendered = renderBenchmarkReport(report).join("\n");
		assert.match(rendered, /segment seals=1 epoch transitions=1/);
		assert.match(rendered, /explicit breakpoints.*applied=1.*cacheRead=0.*ratio=0%/);
		for (const forbidden of ["boundaryMarker", "segmentChainHash", "payload"]) assert.ok(!rendered.includes(forbidden));
	});
});

test("estimatedAvoidedCost: computed only from an explicit cost-map", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const telemetryPath = join(root, ".pi", "workbench", "cache", "telemetry.jsonl");
		const cleanTelemetry = [
			JSON.stringify(record({})),
			JSON.stringify(record({ timestamp: "2026-08-02T01:58:00.000Z", usage: { input: 2000, output: 200, cacheRead: 8000, cacheWrite: 0, totalTokens: 10200, cost: 0.002 }, cacheHitRatio: 0.8 })),
		].join("\n") + "\n";
		await writeFile(telemetryPath, cleanTelemetry, "utf8");
		const costMap = { "deepseek/deepseek-v4-flash": { cacheRead: 2.8 } }; // USD per 1M tokens
		const report = await buildBenchmarkReport({ projectRoot: root, scope: "project", costMap });
		assert.equal(report.estimatedAvoidedCost, (17000 * 2.8) / 1_000_000);
		await writeFile(telemetryPath, `${cleanTelemetry}{not-json}\n`, "utf8");
		const incomplete = await buildBenchmarkReport({ projectRoot: root, scope: "project", costMap });
		assert.equal(incomplete.estimatedAvoidedCost, null, "a cost map cannot make partial source evidence complete");
		await writeFile(telemetryPath, cleanTelemetry, "utf8");
		// Unknown model voids the whole estimate (strict).
		const partial = await buildBenchmarkReport({
			projectRoot: root,
			scope: "project",
			costMap: { "other/model": { cacheRead: 1 } },
		});
		assert.equal(partial.estimatedAvoidedCost, null);
	});
});

test("session scoping filters telemetry by hashed session id", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const report = await buildBenchmarkReport({ projectRoot: root, scope: "session", sessionId: "a".repeat(16) });
		assert.equal(report.requestCount, 2);
		const none = await buildBenchmarkReport({ projectRoot: root, scope: "session", sessionId: "nope" });
		assert.equal(none.requestCount, 0);
		assert.equal(none.cacheHitRatio, null);
	});
});

test("renderBenchmarkReport: human-readable lines carry the same facts, never sensitive content", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const report = await buildBenchmarkReport({ projectRoot: root, scope: "project" });
		const lines = renderBenchmarkReport(report);
		assert.ok(lines.some((l) => l.includes("request count") && l.includes("2")));
		assert.ok(lines.some((l) => l.includes("cache hit ratio")));
		assert.ok(lines.some((l) => l.includes("estimated avoided cost")));
		assert.ok(lines.some((l) => l.includes("corruption")));
		assert.ok(lines.some((l) => l.includes("data quality") && l.includes("PARTIAL")));
		assert.ok(lines.some((l) => l.includes("version cohort caveat") && l.includes("not a source-commit identity")));
		const joined = lines.join("\n");
		assert.ok(!joined.includes("auth.json"));
		assert.ok(!joined.includes("apiKey"));
		assert.ok(!joined.includes("systemPrompt="), "no prompt hashes beyond the report schema");
	});
});

test("normalizeReport: accepts both the benchmark shape and the extension CacheReport shape", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const report = await buildBenchmarkReport({ projectRoot: root, scope: "project" });
		const row = normalizeReport("bench", report);
		assert.equal(row.requestCount, 2);
		assert.equal(row.cacheRead, 17000);
		assert.equal(row.recipeHits, 1);

		const extensionShape = {
			scope: "session" as const,
			schemaVersion: "1.0",
			generatedAt: "x",
			requestCount: 10,
			schema13Rows: 0,
			observability: null,
			byMode: {},
			byModel: {},
			totals: { input: 100, cacheRead: 200, output: 50, cacheWrite: 0, totalTokens: 350, cost: 0.01 },
			hitRatio: 2 / 3,
			semanticStatus: "verified" as const,
			changeCounts: { model: 0, thinking: 0, mode: 0, reload: 0, compaction: 0 },
			invalidationCounts: {},
			expectedInvalidations: 1,
			unexpectedDrifts: 0,
			sameModeMutationCount: 0,
			historyProjectionSegmentSeals: 0,
			historyProjectionEpochTransitions: 0,
			explicitBreakpointAppliedRequests: 0,
			explicitBreakpointVerifiedUsage: { requestCount: 0, input: 0, cacheRead: 0, cacheWrite: 0, hitRatio: null },
			estimatedAvoidedCost: 0.005,
			skippedRecords: 0,
		};
		const extRow = normalizeReport("ext", extensionShape);
		assert.equal(extRow.cacheRead, 200);
		assert.equal(extRow.recipeHits, null);
	});
});

test("renderCompare: table output for mixed-shape reports", () => {
	const rows = [
		{ name: "a", scope: "session", requestCount: 10, hitRatio: 0.9, semanticStatus: "verified", uncachedInput: 1, cacheRead: 9, output: 1, cost: 0.01, expected: 1, unexpected: 0, recipeHits: null, recipeMisses: null },
		{ name: "b", scope: "project", requestCount: 20, hitRatio: 0.8, semanticStatus: "verified", uncachedInput: 4, cacheRead: 16, output: 2, cost: 0.02, expected: 2, unexpected: 1, recipeHits: 3, recipeMisses: 2 },
	];
	const lines = renderCompare(rows);
	assert.ok(lines[0]?.includes("comparison"));
	assert.ok(lines.some((l) => l.includes("a")) && lines.some((l) => l.includes("b")));
});

test("parseCliArgs: commands, options and positional names", () => {
	const opts = parseCliArgs(["compare", "p6a-baseline", "p6b-stable-dev", "--project", "/tmp/x", "--json"]);
	assert.equal(opts.command, "compare");
	assert.deepEqual(opts.names, ["p6a-baseline", "p6b-stable-dev"]);
	assert.equal(opts.projectRoot, "/tmp/x");
	assert.equal(opts.json, true);
	const session = parseCliArgs(["report", "--session", "abc", "--save", "x"]);
	assert.equal(session.session, "abc");
	assert.equal(session.save, "x");
	const canary = parseCliArgs(["canary", "abba.json", "--json"]);
	assert.equal(canary.command, "canary");
	assert.deepEqual(canary.names, ["abba.json"]);
	assert.equal(canary.json, true);
	// Unknown command degrades to report (documented behavior).
	assert.equal(parseCliArgs(["bogus"]).command, "report");
});

test("saveBenchmarkReport: atomic save inside reports/, name sanitized", async () => {
	await withTempDir(async (root) => {
		const result = await saveBenchmarkReport(root, "my.report", { a: 1 });
		assert.ok(result.ok);
		assert.ok(result.path?.endsWith("reports/my_report.json"));
		const escaping = await saveBenchmarkReport(root, "..", { a: 1 });
		assert.equal(escaping.ok, false);
	});
});

test("CLI: friendly exit when telemetry is missing, JSON and text modes", async () => {
	await withTempDir(async (root) => {
		const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
		const script = join(process.cwd(), "scripts", "cache-benchmark.ts");
		const text = await spawnExec(tsx, [script, "report", "--project", root], { timeout: 60000 });
		assert.equal(text.code, 0);
		assert.ok(text.stdout.includes("no cache telemetry found"));
		const json = await spawnExec(tsx, [script, "report", "--project", root, "--json"], { timeout: 60000 });
		assert.equal(json.code, 0);
		const parsed = JSON.parse(json.stdout) as { requestCount: number; note: string };
		assert.equal(parsed.requestCount, 0);
		const doctor = await spawnExec(tsx, [script, "doctor", "--project", root], { timeout: 60000 });
		assert.equal(doctor.code, 0);
		assert.ok(doctor.stdout.includes("no cache telemetry found"));
	});
});

test("CLI: report and doctor expose corrupt-source quality without a hard failure", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
		const script = join(process.cwd(), "scripts", "cache-benchmark.ts");
		const report = await spawnExec(tsx, [script, "report", "--project", root, "--json"], { timeout: 60000 });
		assert.equal(report.code, 0);
		const parsed = JSON.parse(report.stdout) as BenchmarkReport;
		assert.equal(parsed.requestCount, 2);
		assert.equal(parsed.recipeCacheHits, 1);
		assert.equal(parsed.cacheHitRatio, null);
		assert.equal(parsed.telemetrySourceIncomplete, true);
		const doctor = await spawnExec(tsx, [script, "doctor", "--project", root, "--json"], { timeout: 60000 });
		assert.equal(doctor.code, 0);
		const checks = JSON.parse(doctor.stdout) as {
			checks: Array<{ id: string; status: string; message: string }>;
			fail_count: number;
			telemetry_quality: { sourceIncomplete: boolean; skippedRecords: number };
		};
		assert.equal(checks.fail_count, 0);
		const ids = checks.checks.map((c) => c.id);
		assert.ok(ids.includes("forbidden_fields"));
		assert.equal(checks.telemetry_quality.sourceIncomplete, true);
		assert.equal(checks.telemetry_quality.skippedRecords, 1);
		assert.equal(checks.checks.find((item) => item.id === "telemetry_source_quality")?.status, "warn");
		assert.ok(checks.checks.find((item) => item.id === "same_mode_drift")?.message.includes("prevents a no-drift conclusion"));
		assert.ok(ids.includes("action_cache_integrity"));
		// Offline context skips Pi-dependent checks honestly.
		const skipped = checks.checks.filter((c) => c.status === "skip").map((c) => c.id);
		assert.ok(skipped.includes("tool_stability"));
	});
});

test("CLI: an all-corrupt telemetry source is reported as partial evidence, not as missing telemetry", async () => {
	await withTempDir(async (root) => {
		const cache = join(root, ".pi", "workbench", "cache");
		await mkdir(cache, { recursive: true });
		await writeFile(join(cache, "telemetry.jsonl"), "{not-json}\n", "utf8");
		const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
		const script = join(process.cwd(), "scripts", "cache-benchmark.ts");
		const report = await spawnExec(tsx, [script, "report", "--project", root, "--json"], { timeout: 60000 });
		assert.equal(report.code, 0);
		const parsedReport = JSON.parse(report.stdout) as BenchmarkReport;
		assert.equal(parsedReport.requestCount, 0);
		assert.equal(parsedReport.telemetrySourceIncomplete, true);
		assert.equal(parsedReport.cacheHitRatio, null);

		const doctor = await spawnExec(tsx, [script, "doctor", "--project", root, "--json"], { timeout: 60000 });
		assert.equal(doctor.code, 0);
		const parsedDoctor = JSON.parse(doctor.stdout) as { checks: Array<{ id: string; status: string }> };
		assert.equal(parsedDoctor.checks.find((item) => item.id === "telemetry_source_quality")?.status, "warn");
	});
});

test("CLI: compare exits 1 with a clear message when no saved reports exist", async () => {
	await withTempDir(async (root) => {
		const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
		const script = join(process.cwd(), "scripts", "cache-benchmark.ts");
		const result = await spawnExec(tsx, [script, "compare", "nope", "--project", root], { timeout: 60000 });
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes("no saved reports found"));
	});
});

test("CLI: canary has a strict read-only descriptive entry point", async () => {
	await withTempDir(async (root) => {
		const manifest = join(root, "abba.json");
		await writeFile(manifest, JSON.stringify({
			schema: "workbench-sol-luna-abba-v1",
			variants: { A: "extended baseline", B: "advisory routed" },
			trials: [],
		}), "utf8");
		const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
		const script = join(process.cwd(), "scripts", "cache-benchmark.ts");
		const result = await spawnExec(tsx, [script, "canary", manifest, "--json"], { timeout: 60000 });
		assert.equal(result.code, 0);
		const parsed = JSON.parse(result.stdout) as { authority: string; decision: string; minimum_complete_blocks: number };
		assert.equal(parsed.authority, "DESCRIPTIVE_ONLY");
		assert.equal(parsed.decision, "NOT_EVALUABLE");
		assert.equal(parsed.minimum_complete_blocks, 12);
	});
});
