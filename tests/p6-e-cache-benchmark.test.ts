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
import { spawnExec, withTempDir } from "./helpers.ts";

/** One valid telemetry record (schema 1.1). */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "1.1",
		timestamp: "2026-08-02T01:57:35.263Z",
		extensionVersion: "0.8.0",
		hashedSessionId: "sess-a",
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
			JSON.stringify(record({ timestamp: "2026-08-02T01:58:00.000Z", usage: { input: 2000, output: 200, cacheRead: 8000, cacheWrite: 0, totalTokens: 10200, cost: 0.002 } })),
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
		assert.ok(result.file?.endsWith("telemetry.jsonl"));
		assert.equal(result.rotatedFiles, 0);
	});
});

test("readTelemetry: missing file is a friendly empty result", async () => {
	await withTempDir(async (root) => {
		const result = await readTelemetry(root);
		assert.equal(result.records.length, 0);
		assert.equal(result.skipped, 0);
		assert.equal(result.file, null);
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
		// Field presence: the P6-E contract list.
		const expected: Array<keyof BenchmarkReport> = [
			"requestCount",
			"uncachedInputTokens",
			"cacheReadTokens",
			"outputTokens",
			"cacheHitRatio",
			"usageSemanticStatus",
			"providerReportedCost",
			"estimatedAvoidedCost",
			"expectedInvalidations",
			"unexpectedDrifts",
			"modeChanges",
			"modelChanges",
			"thinkingChanges",
			"reloads",
			"compactions",
			"recipeExecutions",
			"recipeCacheHits",
			"recipeCacheMisses",
			"recipeHitRatio",
			"localExecutionTimeAvoided",
			"cacheStorageSize",
			"corruptionCount",
			"fallbackCount",
		];
		for (const key of expected) assert.ok(key in report, key);
		assert.equal(report.requestCount, 2);
		assert.equal(report.uncachedInputTokens, 3000);
		assert.equal(report.cacheReadTokens, 17000);
		assert.equal(report.outputTokens, 300);
		assert.equal(report.cacheHitRatio, 17000 / 20000);
		assert.equal(report.usageSemanticStatus, "verified");
		assert.equal(report.providerReportedCost, 0.003);
		assert.equal(report.estimatedAvoidedCost, null); // no cost-map -> null, never hardcoded
		assert.equal(report.recipeExecutions, 2);
		assert.equal(report.recipeCacheHits, 1);
		assert.equal(report.recipeCacheMisses, 1);
		assert.equal(report.recipeHitRatio, 0.5);
		assert.equal(report.localExecutionTimeAvoided, 30); // from the action record duration
		assert.ok(report.cacheStorageSize > 0);
		assert.ok(report.corruptionCount >= 3); // badkey + corrupt copy + bad telemetry line
		assert.equal(report.fallbackCount, 1);
		assert.equal(report.skippedTelemetryLines, 1);
	});
});

test("estimatedAvoidedCost: computed only from an explicit cost-map", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const costMap = { "deepseek/deepseek-v4-flash": { cacheRead: 2.8 } }; // USD per 1M tokens
		const report = await buildBenchmarkReport({ projectRoot: root, scope: "project", costMap });
		assert.equal(report.estimatedAvoidedCost, (17000 * 2.8) / 1_000_000);
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
		const report = await buildBenchmarkReport({ projectRoot: root, scope: "session", sessionId: "sess-a" });
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

test("CLI: report --json carries the full contract, doctor exits 0 on healthy data", async () => {
	await withTempDir(async (root) => {
		await makeProject(root);
		const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
		const script = join(process.cwd(), "scripts", "cache-benchmark.ts");
		const report = await spawnExec(tsx, [script, "report", "--project", root, "--json"], { timeout: 60000 });
		assert.equal(report.code, 0);
		const parsed = JSON.parse(report.stdout) as BenchmarkReport;
		assert.equal(parsed.requestCount, 2);
		assert.equal(parsed.recipeCacheHits, 1);
		const doctor = await spawnExec(tsx, [script, "doctor", "--project", root, "--json"], { timeout: 60000 });
		assert.equal(doctor.code, 0);
		const checks = JSON.parse(doctor.stdout) as { checks: Array<{ id: string; status: string }>; fail_count: number };
		assert.equal(checks.fail_count, 0);
		const ids = checks.checks.map((c) => c.id);
		assert.ok(ids.includes("forbidden_fields"));
		assert.ok(ids.includes("action_cache_integrity"));
		// Offline context skips Pi-dependent checks honestly.
		const skipped = checks.checks.filter((c) => c.status === "skip").map((c) => c.id);
		assert.ok(skipped.includes("tool_stability"));
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
