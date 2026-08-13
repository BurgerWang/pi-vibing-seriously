/**
 * P6-A report + doctor tests — aggregation, change counting, estimated
 * avoided cost rules, rendering, and the doctor's hygiene checks.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCacheReport, renderCacheReport, renderCacheStatus } from "../extensions/workbench-runtime/cache/cache-report.ts";
import { runDoctor, doctorToJson, renderDoctor, type DoctorFacts } from "../extensions/workbench-runtime/cache/cache-doctor.ts";
import { createCacheTelemetry, type CacheTelemetry, type MessageEndFacts } from "../extensions/workbench-runtime/cache/cache-telemetry.ts";
import type { TelemetryRecord } from "../extensions/workbench-runtime/cache/cache-types.ts";

const BASE_TIME = 1_700_000_000_000;

const TOOLS = [
	{ name: "read", description: "read a file", parameters: { type: "object" } },
	{ name: "grep", description: "search text", parameters: { type: "object" } },
	{ name: "find", description: "find files", parameters: { type: "object" } },
	{ name: "bash", description: "run a command", parameters: { type: "object" } },
];

interface PlanStep {
	/** Event observed before this request. */
	ev?: (t: CacheTelemetry) => void;
	/** Fact overrides for this request. */
	facts?: Partial<MessageEndFacts>;
}

/** Drive a real telemetry instance through a plan and collect the records. */
async function collectRecords(plan: PlanStep[]): Promise<TelemetryRecord[]> {
	const telemetry = createCacheTelemetry({ now: () => BASE_TIME, appendEntry: () => {} });
	telemetry.setProjectRoot("/tmp/irrelevant");
	telemetry.setSessionId("sess-1");
	telemetry.setMode("DEV");
	telemetry.setThinkingLevel("high");
	const records: TelemetryRecord[] = [];
	const base = (overrides: Partial<MessageEndFacts> = {}): MessageEndFacts => ({
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		usage: { input: 10000, output: 500, cacheRead: 40000, cacheWrite: 0, totalTokens: 50500, cost: { total: 0.001 } },
		// thinkingLevel deliberately unset: records fall back to the tracked
		// level so thinking-level changes are visible in the records.
		thinkingLevel: null,
		systemPrompt: "You are the pi-dev-workbench assistant.",
		activeToolNames: ["read", "grep", "find", "bash"],
		tools: TOOLS,
		...overrides,
	});
	for (const step of plan) {
		step.ev?.(telemetry);
		const record = await telemetry.observeMessageEnd(base(step.facts));
		if (record) records.push(record);
	}
	return records;
}

const rateLookup = (provider: string, model: string): { cacheRead: number } | undefined => {
	if (provider === "deepseek" && model === "deepseek-v4-flash") return { cacheRead: 0.0028 };
	return undefined;
};

test("report aggregates totals, modes, models and hit ratio", async () => {
	const records = await collectRecords([{}, {}, { ev: (t) => t.observeModeChange("VERIFY") }]);
	const report = buildCacheReport(records, "session", rateLookup);
	assert.equal(report.requestCount, 3);
	assert.deepEqual(report.byMode, { DEV: 2, VERIFY: 1 });
	assert.deepEqual(report.byModel, { "deepseek/deepseek-v4-flash": 3 });
	assert.equal(report.totals.input, 30000);
	assert.equal(report.totals.cacheRead, 120000);
	assert.equal(report.totals.output, 1500);
	assert.equal(report.totals.cost, 0.003);
	assert.equal(report.hitRatio, 0.8);
	assert.equal(report.semanticStatus, "verified");
	assert.equal(report.changeCounts.mode, 1);
	// record 1 = FIRST_OBSERVED_REQUEST (expected), record 2 = UNKNOWN, record 3 = MODE_CHANGED (expected)
	assert.equal(report.expectedInvalidations, 2);
	assert.equal(report.unexpectedDrifts, 0);
	assert.equal(report.invalidationCounts["UNKNOWN"], 1);
});

test("report counts model/thinking/mode/reload/compaction changes", async () => {
	const records = await collectRecords([
		{ ev: (t) => t.observeModelChange({ provider: "deepseek", id: "deepseek-v4-pro", api: "openai-completions" }), facts: { model: "deepseek-v4-pro" } },
		{ ev: (t) => t.observeThinkingChange("max") },
		{ ev: (t) => t.observeModeChange("AUDIT") },
		{ ev: (t) => t.observeReload() },
		{ ev: (t) => t.observeCompaction() },
	]);
	const report = buildCacheReport(records, "project", rateLookup);
	assert.equal(report.changeCounts.model, 1);
	assert.equal(report.changeCounts.thinking, 1);
	assert.equal(report.changeCounts.mode, 1);
	assert.equal(report.changeCounts.reload, 1);
	assert.equal(report.changeCounts.compaction, 1);
});

test("expected vs unexpected invalidation counts", async () => {
	const records = await collectRecords([
		{ ev: (t) => t.observeModeChange("VERIFY") },
		{ ev: (t) => t.observeModeChange("DEV") },
		{ ev: (t) => t.observeReload() },
		{ ev: (t) => t.observeCompaction() },
		{},
	]);
	const report = buildCacheReport(records, "session", rateLookup);
	// FIRST_OBSERVED_REQUEST + MODE_CHANGED + PACKAGE_RELOADED + COMPACTION = 4 expected; UNKNOWN = 1
	assert.equal(report.expectedInvalidations, 4);
	assert.equal(report.unexpectedDrifts, 0);
	assert.equal(report.invalidationCounts["MODE_CHANGED"], 1);
	assert.equal(report.invalidationCounts["PACKAGE_RELOADED"], 1);
	assert.equal(report.invalidationCounts["COMPACTION"], 1);
	assert.equal(report.invalidationCounts["UNKNOWN"], 1);
});

test("unexpected drift is counted for system/tool changes (UNEXPECTED_DRIFT + driftSource)", async () => {
	const records = await collectRecords([
		{},
		{ facts: { systemPrompt: "You are the pi-dev-workbench assistant v2." } },
		{ facts: { systemPrompt: "You are the pi-dev-workbench assistant v2.", activeToolNames: ["read"] } },
	]);
	const report = buildCacheReport(records, "session", rateLookup);
	assert.equal(report.unexpectedDrifts, 2);
	assert.equal(report.expectedInvalidations, 1);
	assert.equal(report.invalidationCounts["UNEXPECTED_DRIFT"], 2);
	assert.equal(records[1]?.driftSource, "SYSTEM_PROMPT");
	assert.equal(records[2]?.driftSource, "TOOL_SET");
	// same-mode mutations: both drift records kept the same mode (DEV)
	assert.equal(report.sameModeMutationCount, 2);
});

test("same-mode mutation count excludes mode-switch boundaries", async () => {
	const records = await collectRecords([
		{},
		{ ev: (t) => t.observeModeChange("VERIFY") },
		{ facts: { systemPrompt: "You are the pi-dev-workbench assistant v2." } },
	]);
	const report = buildCacheReport(records, "session", rateLookup);
	// record 3: system prompt changed in VERIFY mode (same mode as record 2)
	assert.equal(report.sameModeMutationCount, 1);
	assert.equal(report.unexpectedDrifts, 1);
	assert.equal(report.expectedInvalidations, 2); // FIRST_OBSERVED_REQUEST + MODE_CHANGED
});

test("estimated avoided cost: computed only when ALL rates resolve", async () => {
	const records = await collectRecords([{}, {}]);
	// 2 records x 40000 cacheRead tokens at $0.0028/1M tokens
	assert.equal(records.length, 2);
	const withRates = buildCacheReport(records, "session", rateLookup);
	assert.equal(withRates.estimatedAvoidedCost, (80000 * 0.0028) / 1_000_000);
	// unknown provider/model -> null (strict, no partial estimates)
	const withoutRates = buildCacheReport(records, "session", () => undefined);
	assert.equal(withoutRates.estimatedAvoidedCost, null);
});

test("estimated avoided cost: non-finite or negative rates void the estimate", async () => {
	const records = await collectRecords([{}, {}]);
	const bad = buildCacheReport(records, "session", () => ({ cacheRead: Number.NaN }));
	assert.equal(bad.estimatedAvoidedCost, null);
	const negative = buildCacheReport(records, "session", () => ({ cacheRead: -1 }));
	assert.equal(negative.estimatedAvoidedCost, null);
});

test("estimated avoided cost is unavailable when source evidence is partial or bounded", async () => {
	const records = await collectRecords([{}, {}]);
	const partial = buildCacheReport(records, "project", rateLookup, { skippedRecords: 1, sourceIncomplete: true });
	assert.equal(partial.estimatedAvoidedCost, null);
	assert.ok(renderCacheReport(partial).some((line) => line.includes("incomplete telemetry observation")));

	const bounded = buildCacheReport(records, "project", rateLookup, { truncatedRecords: 1 });
	assert.equal(bounded.hitRatio, 0.8, "a bounded ratio remains explicitly scoped to the retained window");
	assert.equal(bounded.estimatedAvoidedCost, null, "a retained window cannot support a full-history cost estimate");
	const rendered = renderCacheReport(bounded);
	assert.ok(rendered.some((line) => line.includes("bounded retained window")));
	assert.ok(rendered.some((line) => line.includes("full estimate unavailable")));
});

test("empty report: no records, no fabrication", () => {
	const report = buildCacheReport([], "session", rateLookup);
	assert.equal(report.requestCount, 0);
	assert.equal(report.hitRatio, null);
	assert.equal(report.semanticStatus, null);
	assert.equal(report.estimatedAvoidedCost, null);
});

test("partial or unverified usage semantics never fabricate an aggregate hit ratio", async () => {
	const records = await collectRecords([{}]);
	const partial = [{ ...records[0]!, usageSemanticStatus: "partial" as const, cacheHitRatio: null }];
	const unverified = [{ ...records[0]!, usageSemanticStatus: "unverified" as const, cacheHitRatio: null }];
	assert.equal(buildCacheReport(partial, "project", rateLookup).hitRatio, null);
	assert.equal(buildCacheReport(unverified, "project", rateLookup).hitRatio, null);
	assert.equal(
		buildCacheReport(records, "project", rateLookup, { skippedRecords: 2, sourceIncomplete: true }).hitRatio,
		null,
		"an incomplete chronological read must not present a verified ratio",
	);
});

test("durable telemetry write gaps make reports and doctor conclusions partial", async () => {
	const records = await collectRecords([{}, {}]);
	const gapRecord: TelemetryRecord = {
		...records[1]!,
		precedingEvent: "telemetry_write_gap",
		usageSemanticStatus: "unverified",
		cacheHitRatio: null,
	};
	const gappedRecords = [records[0]!, gapRecord];
	const report = buildCacheReport(gappedRecords, "project", rateLookup);
	assert.equal(report.sourceIncomplete, true);
	assert.equal(report.semanticStatus, "unverified");
	assert.equal(report.hitRatio, null);
	assert.equal(report.estimatedAvoidedCost, null);
	assert.equal(report.invalidationCounts[gapRecord.inferredInvalidationReason], 1);
	assert.equal(report.invalidationCounts["telemetry_write_gap"], undefined, "the quality marker is not an invalidation reason");
	assert.ok(renderCacheReport(report).some((line) => line.includes("data quality") && line.includes("PARTIAL")));

	const facts: DoctorFacts = {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		modelCostPresent: true,
		modelCostRatesValid: true,
		systemPrompt: "You are the pi-dev-workbench assistant.",
		activeToolNames: ["read", "grep"],
		tools: TOOLS,
		records: gappedRecords,
		telemetryEnabled: true,
		telemetryBytes: 2048,
		telemetryMaxBytes: 5 * 1024 * 1024,
		rotatedFiles: 0,
	};
	const checks = runDoctor(facts);
	const quality = checks.find((check) => check.id === "telemetry_source_quality");
	assert.equal(quality?.status, "warn");
	assert.ok(quality?.message.includes("PARTIAL"));
	assert.ok(quality?.message.includes("telemetry-write-gap=yes"));
	assert.equal(checks.find((check) => check.id === "same_mode_drift")?.status, "warn");
	const json = doctorToJson(checks, facts) as { telemetry_quality?: { sourceIncomplete?: boolean } };
	assert.equal(json.telemetry_quality?.sourceIncomplete, true);
});

test("renderCacheReport and renderCacheStatus produce text without throwing", async () => {
	const records = await collectRecords([{}]);
	const report = buildCacheReport(records, "session", rateLookup);
	const lines = renderCacheReport(report);
	assert.ok(lines.some((l) => l.includes("requests")));
	assert.ok(lines.some((l) => l.includes("hit ratio")));
	assert.ok(lines.some((l) => l.includes("estimated avoided cost")));
	const telemetry = createCacheTelemetry({ now: () => BASE_TIME, appendEntry: () => {} });
	telemetry.setProjectRoot("/tmp/irrelevant");
	telemetry.setSessionId("status-session");
	await telemetry.observeMessageEnd({
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		usage: { input: 10, output: 1, cacheRead: 90, cacheWrite: 0, totalTokens: 101, cost: { total: 0 } },
		thinkingLevel: "high",
		systemPrompt: "stable",
		activeToolNames: [],
		tools: [],
	});
	await telemetry.observeMessageEnd({
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		usage: { input: 90, output: 1, cacheRead: 10, cacheWrite: 0, totalTokens: 101, cost: { total: 0 } },
		thinkingLevel: "high",
		systemPrompt: "stable",
		activeToolNames: [],
		tools: [],
	});
	const statusLines = renderCacheStatus(telemetry.snapshot());
	assert.ok(statusLines.some((l) => l.includes("requests")));
	assert.ok(statusLines.some((l) => l.includes("last request ratio") && l.includes("10%")));
	assert.ok(statusLines.some((l) => l.includes("cumulative ratio") && l.includes("50%")));
	assert.equal(telemetry.statusSegment(), "CACHE last=10% cum=50% | read 100 | miss 100");
});

test("report rejects malformed runtime records without throwing or producing NaN", async () => {
	const records = await collectRecords([{}]);
	const malformed = { ...records[0]!, usage: { ...records[0]!.usage, input: Number.NaN } } as TelemetryRecord;
	const report = buildCacheReport([records[0]!, malformed], "project", rateLookup);
	assert.equal(report.requestCount, 1);
	assert.equal(report.skippedRecords, 1);
	assert.equal(report.sourceIncomplete, true);
	assert.equal(report.hitRatio, null);
	assert.ok(Object.values(report.totals).every(Number.isFinite));
	assert.doesNotThrow(() => renderCacheReport(report));
});

test("doctor: all checks pass on a healthy setup", async () => {
	const records = await collectRecords([{}]);
	const facts: DoctorFacts = {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		modelCostPresent: true,
		modelCostRatesValid: true,
		systemPrompt: "You are the pi-dev-workbench assistant.",
		activeToolNames: ["read", "grep"],
		tools: TOOLS,
		records,
		telemetryEnabled: true,
		telemetryBytes: 1024,
		telemetryMaxBytes: 5 * 1024 * 1024,
		rotatedFiles: 0,
	};
	const checks = runDoctor(facts);
	const fails = checks.filter((c) => c.status === "fail");
	assert.deepEqual(fails, [], `unexpected fails: ${JSON.stringify(fails)}`);
	const ids = checks.map((c) => c.id);
	for (const expected of ["current_model", "telemetry_source_quality", "usage_fields", "model_cost_metadata", "models_json", "auth_json", "system_prompt_dynamics", "prefix_hashes", "tool_metadata_static", "tool_stability", "same_mode_drift", "expected_vs_unexpected", "churn", "forbidden_fields", "telemetry_size", "telemetry_enabled"]) {
		assert.ok(ids.includes(expected), expected);
	}
});

test("doctor: partial or truncated telemetry suppresses clean historical conclusions", async () => {
	const records = await collectRecords([{}]);
	const facts: DoctorFacts = {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		modelCostPresent: true,
		modelCostRatesValid: true,
		systemPrompt: "You are the pi-dev-workbench assistant.",
		activeToolNames: ["read", "grep"],
		tools: TOOLS,
		records,
		telemetryEnabled: true,
		telemetryBytes: 2048,
		telemetryMaxBytes: 5 * 1024 * 1024,
		rotatedFiles: 2,
		sourceIncomplete: true,
		skippedRecords: 1,
		truncatedRecords: 7,
		filesRead: 3,
		sourceUnavailable: "read_error",
	};
	const checks = runDoctor(facts);
	const quality = checks.find((check) => check.id === "telemetry_source_quality");
	assert.equal(quality?.status, "warn");
	assert.ok(quality?.message.includes("PARTIAL"));
	const drift = checks.find((check) => check.id === "same_mode_drift");
	assert.equal(drift?.status, "warn");
	assert.ok(drift?.message.includes("prevents a no-drift conclusion"));
	assert.equal(checks.find((check) => check.id === "expected_vs_unexpected")?.status, "warn");
	assert.equal(checks.find((check) => check.id === "forbidden_fields")?.status, "warn");
	const json = doctorToJson(checks, facts) as { telemetry_quality?: Record<string, unknown> };
	assert.deepEqual(json.telemetry_quality, {
		sourceIncomplete: true,
		skippedRecords: 1,
		truncatedRecords: 7,
		filesRead: 3,
		sourceUnavailable: "read_error",
	});
});

test("doctor flags dynamic system prompt markers (ids only, never content)", () => {
	const facts: DoctorFacts = {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		modelCostPresent: true,
		modelCostRatesValid: true,
		systemPrompt: "You are X. Current time: 14:32. Run id: run-abc123. Today is 2026-01-15.",
		activeToolNames: [],
		tools: [],
		records: [],
		telemetryEnabled: true,
		telemetryBytes: 0,
		telemetryMaxBytes: 5 * 1024 * 1024,
		rotatedFiles: 0,
	};
	const checks = runDoctor(facts);
	const dynamics = checks.find((c) => c.id === "system_prompt_dynamics");
	assert.ok(dynamics);
	assert.equal(dynamics.status, "warn");
	assert.ok(dynamics.message.includes("iso-date") || dynamics.message.includes("clock-time") || dynamics.message.includes("run-id"));
	assert.ok(!dynamics.message.includes("14:32"), "marker content must never be echoed");
	assert.ok(!dynamics.message.includes("run-abc123"));
});

test("doctor flags forbidden fields in records", async () => {
	const records = await collectRecords([{}]);
	const leaked = { ...(records[0] as TelemetryRecord), content: "x" } as unknown as TelemetryRecord;
	const facts: DoctorFacts = {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		modelCostPresent: true,
		modelCostRatesValid: true,
		systemPrompt: "sp",
		activeToolNames: [],
		tools: [],
		records: [leaked],
		telemetryEnabled: true,
		telemetryBytes: 10,
		telemetryMaxBytes: 5 * 1024 * 1024,
		rotatedFiles: 0,
	};
	const checks = runDoctor(facts);
	const forbidden = checks.find((c) => c.id === "forbidden_fields");
	assert.ok(forbidden);
	assert.equal(forbidden.status, "fail");
});

test("doctor flags same-mode drift (UNEXPECTED_DRIFT within a stable mode)", async () => {
	const records = await collectRecords([{}, { facts: { activeToolNames: ["read", "grep"] } }]);
	const facts: DoctorFacts = {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		modelCostPresent: true,
		modelCostRatesValid: true,
		systemPrompt: "sp",
		activeToolNames: ["read", "grep"],
		tools: TOOLS,
		records,
		telemetryEnabled: true,
		telemetryBytes: 10,
		telemetryMaxBytes: 5 * 1024 * 1024,
		rotatedFiles: 0,
	};
	const checks = runDoctor(facts);
	const drift = checks.find((c) => c.id === "same_mode_drift");
	assert.ok(drift);
	assert.equal(drift.status, "warn");
	const prefix = checks.find((c) => c.id === "prefix_hashes");
	assert.ok(prefix, "prefix_hashes check present (P6-B)");
	assert.ok(prefix.message.includes("systemPromptHash="), "prefix_hashes exposes the current system prompt hash");
	assert.ok(prefix.message.includes("activeToolNamesHash="), "prefix_hashes exposes the active tool names hash");
	assert.ok(prefix.message.includes("activeToolOrderHash="), "prefix_hashes exposes the active tool order hash");
	assert.ok(prefix.message.includes("activeToolSchemaHash="), "prefix_hashes exposes the active tool schema hash");
});

test("doctor json mode is plain data", async () => {
	const facts: DoctorFacts = {
		provider: null,
		model: null,
		apiKind: null,
		modelCostPresent: false,
		modelCostRatesValid: false,
		systemPrompt: "sp",
		activeToolNames: [],
		tools: [],
		records: [],
		telemetryEnabled: false,
		telemetryBytes: 0,
		telemetryMaxBytes: 5 * 1024 * 1024,
		rotatedFiles: 0,
	};
	const checks = runDoctor(facts);
	const json = doctorToJson(checks);
	assert.equal(json.checks instanceof Array, true);
	assert.ok(typeof json.fail_count === "number");
	const lines = renderDoctor(checks);
	assert.ok(lines[0]?.includes("cache doctor"));
});
