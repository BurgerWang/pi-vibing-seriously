/**
 * P6-A report + doctor tests — aggregation, change counting, estimated
 * avoided cost rules, rendering, and the doctor's hygiene checks.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCacheReport, renderCacheReport, renderCacheStatus } from "../extensions/workbench-runtime/cache/cache-report.ts";
import { runDoctor, doctorToJson, renderDoctor, type DoctorFacts } from "../extensions/workbench-runtime/cache/cache-doctor.ts";
import { hasForbiddenTelemetryFields } from "../extensions/workbench-runtime/cache/cache-store.ts";
import { createCacheTelemetry, type CacheTelemetry, type MessageEndFacts } from "../extensions/workbench-runtime/cache/cache-telemetry.ts";
import { isTelemetryRecord, type TelemetryRecord } from "../extensions/workbench-runtime/cache/cache-types.ts";

const BASE_TIME = 1_700_000_000_000;

const PROJECTION_ANATOMY = {
	eventCode: 2 as const,
	causeCode: 4 as const,
	epoch: 7,
	epochTransitioned: 0 as const,
	segmentSealed: 1 as const,
	byteOverflow: 1 as const,
	bundleOverflow: 0 as const,
	segmentsBefore: 2,
	segmentsAfter: 3,
	hardToolTextBytes: 1_000_000,
	hardBundles: 5_000,
	rawToolTextBytes: 120_000,
	rawBundles: 80,
	projectedToolTextBytes: 90_000,
	projectedBundles: 70,
	stableToolTextBytesBefore: 60_000,
	stableBundlesBefore: 50,
	activeToolTextBytesBefore: 30_000,
	activeBundlesBefore: 20,
	agedRawToolTextBytes: 20_000,
	agedRawBundles: 10,
	agedProjectedToolTextBytes: 10_000,
	agedProjectedBundles: 8,
	suffixRawToolTextBytes: 100_000,
	suffixRawBundles: 70,
};

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

test("schema 1.3 report aggregates exact local observations and disjoint read/write shares by actor", async () => {
	const records = await collectRecords([
		{
			ev: (t) => {
				t.observeContextProjection({ actorRoleCode: 1, historyProjection: PROJECTION_ANATOMY });
				t.observePayload({ messages: [{ role: "user", content: "A🙂" }] });
			},
			facts: {
				provider: "openai",
				model: "gpt-5.6",
				apiKind: "openai-responses",
				usage: { input: 9, output: 1, cacheRead: 90, cacheWrite: 1, totalTokens: 101, cost: { total: 0.01 } },
			},
		},
		{
			ev: (t) => {
				t.observeContextProjection({
					actorRoleCode: 2,
					historyProjection: { ...PROJECTION_ANATOMY, eventCode: 3, causeCode: 3, epochTransitioned: 1, segmentSealed: 0, byteOverflow: 0, bundleOverflow: 1, segmentsAfter: 0 },
				});
				t.observePayload({ messages: [{ role: "user", content: "A🙂" }, { role: "assistant", content: "next" }] });
			},
			facts: {
				usage: { input: 20, output: 1, cacheRead: 80, cacheWrite: 0, totalTokens: 101, cost: { total: 0.01 } },
			},
		},
	]);

	const report = buildCacheReport(records, "project", rateLookup);
	assert.equal(report.schema13Rows, 2);
	assert.ok(report.observability);
	assert.deepEqual(report.observability.correlationCounts, { unwired: 0, exact: 2, multipleOrStale: 0, missing: 0 });
	assert.equal(report.observability.localObservedRequests, 2);
	assert.equal(report.observability.nonFinalObservedRequests, 2);
	assert.deepEqual(report.observability.wholeItemLcp, { eligibleRequests: 2, itemCount: 1, utf8Bytes: 9 });
	assert.equal(report.observability.projection.eventCounts[2], 1);
	assert.equal(report.observability.projection.eventCounts[3], 1);
	assert.equal(report.observability.projection.byteOverflowRequests, 1);
	assert.equal(report.observability.projection.bundleOverflowRequests, 1);
	assert.equal(report.observability.retainedWindowUsage.cacheReadShare, 0.85, "shares are recomputed from disjoint totals");
	assert.equal(report.observability.retainedWindowUsage.cacheWriteShare, null, "DeepSeek write-unavailable prevents a fabricated whole-window write share");
	assert.equal(report.observability.actorCohorts.commander.cacheWriteShare, 0.01);
	assert.equal(report.observability.actorCohorts.worker.cacheWriteShare, null);
	assert.equal(report.observability.actorCohorts.unknown.requestCount, 0, "unknown actors are not guessed");
	assert.deepEqual(report.modelRoleObservability?.commander, {
		requestCount: 1,
		requestedProviderModels: null,
		effectiveProviderModels: { "openai/gpt-5.6": 1 },
		requestedReasoningLevels: { high: 1 },
		effectiveReasoningLevels: null,
	});
	assert.deepEqual(report.modelRoleObservability?.worker, {
		requestCount: 1,
		requestedProviderModels: null,
		effectiveProviderModels: { "deepseek/deepseek-v4-flash": 1 },
		requestedReasoningLevels: { high: 1 },
		effectiveReasoningLevels: null,
	});
	assert.equal(report.observability.projectionCohorts.segmentSeal.requestCount, 1);
	assert.equal(report.observability.projectionCohorts.epochTransition.requestCount, 1);
	const facts: DoctorFacts = {
		provider: "openai",
		model: "gpt-5.6",
		apiKind: "openai-responses",
		modelCostPresent: true,
		modelCostRatesValid: true,
		systemPrompt: "stable",
		activeToolNames: ["read", "grep", "find", "bash"],
		tools: TOOLS,
		records,
		telemetryEnabled: true,
		telemetryBytes: 1024,
		telemetryMaxBytes: 5 * 1024 * 1024,
		rotatedFiles: 0,
	};
	const checks = runDoctor(facts);
	assert.equal(checks.find((check) => check.id === "provider_wire_observation")?.status, "warn");
	assert.match(checks.find((check) => check.id === "provider_wire_observation")?.message ?? "", /not final actual wire/);
	assert.equal(checks.find((check) => check.id === "request_correlation")?.status, "ok");
	const doctorJson = doctorToJson(checks, facts) as { cache_observability?: { schema13Rows?: number; facts?: { nonFinalObservedRequests?: number } } };
	assert.equal(doctorJson.cache_observability?.schema13Rows, 2);
	assert.equal(doctorJson.cache_observability?.facts?.nonFinalObservedRequests, 2);

	const bounded = buildCacheReport(records, "project", rateLookup, { truncatedRecords: 1 });
	assert.equal(bounded.hitRatio, 170 / 199, "legacy retained-window cacheHitRatio semantics stay unchanged");
	assert.equal(bounded.observability?.retainedWindowUsage.cacheReadShare, null);
	assert.equal(bounded.observability?.retainedWindowUsage.cacheReadShareStatusCode, 4);
	const {
		promptInputTokens: _promptInputTokens,
		cacheReadShare: _cacheReadShare,
		cacheWriteShare: _cacheWriteShare,
		cacheWriteStatusCode: _cacheWriteStatusCode,
		actorRoleCode: _actorRoleCode,
		requestCorrelationCode: _requestCorrelationCode,
		historyProjection: _historyProjection,
		wireObservation: _wireObservation,
		...legacyFields
	} = records[1]!;
	const mixed = buildCacheReport([records[0]!, { ...legacyFields, schemaVersion: "1.2" }], "project", rateLookup);
	assert.equal(mixed.schema13Rows, 1);
	assert.equal(mixed.hitRatio, 170 / 199, "legacy overall ratio remains available for a verified complete mixed source");
	assert.equal(mixed.observability?.retainedWindowUsage.cacheReadShare, null);
	assert.equal(mixed.observability?.retainedWindowUsage.cacheReadShareStatusCode, 2);

	const missingWire = { ...records[0] } as Record<string, unknown>;
	delete missingWire.wireObservation;
	const invalid = buildCacheReport([missingWire as unknown as TelemetryRecord], "project", rateLookup);
	assert.equal(invalid.schema13Rows, 0);
	assert.equal(invalid.observability, null, "missing 1.3 facts mean unobserved, never zero-filled");
	assert.equal(invalid.sourceIncomplete, true);
});

test("doctor fails correlation closed for multiple and missing schema 1.3 request events", async () => {
	const records = await collectRecords([
		{
			ev: (t) => {
				t.observeContextProjection({ actorRoleCode: 1, historyProjection: PROJECTION_ANATOMY });
				t.observeContextProjection({ actorRoleCode: 1, historyProjection: PROJECTION_ANATOMY });
				t.observePayload({ messages: [] });
			},
		},
		{ ev: (t) => t.observeContextProjection({ actorRoleCode: 2, historyProjection: PROJECTION_ANATOMY }) },
	]);
	assert.deepEqual(records.map((record) => record.actorRoleCode), [0, 0], "the emitter clears actor attribution on non-exact correlation");
	const report = buildCacheReport(records, "project", rateLookup);
	assert.deepEqual(report.observability?.correlationCounts, { unwired: 0, exact: 0, multipleOrStale: 1, missing: 1 });
	assert.equal(report.observability?.actorCohorts.unknown.requestCount, 2);
	assert.equal(report.observability?.actorCohorts.commander.requestCount, 0);
	assert.equal(report.observability?.actorCohorts.worker.requestCount, 0);

	const corruptAttribution = [
		{ ...records[0]!, actorRoleCode: 1 as const },
		{ ...records[1]!, actorRoleCode: 2 as const },
	];
	const invalidReport = buildCacheReport(corruptAttribution, "project", rateLookup);
	assert.equal(invalidReport.requestCount, 0, "non-exact actor attribution is rejected before aggregation");
	assert.equal(invalidReport.schema13Rows, 0);
	assert.equal(invalidReport.observability, null, "invalid rows never populate Commander or worker cohorts");
	assert.equal(invalidReport.skippedRecords, 2);
	assert.equal(invalidReport.sourceIncomplete, true);
	const checks = runDoctor({
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		modelCostPresent: true,
		modelCostRatesValid: true,
		systemPrompt: "stable",
		activeToolNames: ["read", "grep", "find", "bash"],
		tools: TOOLS,
		records,
		telemetryEnabled: true,
		telemetryBytes: 1024,
		telemetryMaxBytes: 5 * 1024 * 1024,
		rotatedFiles: 0,
	});
	const correlation = checks.find((check) => check.id === "request_correlation");
	assert.equal(correlation?.status, "warn");
	assert.match(correlation?.message ?? "", /multiple-or-stale=1 missing=1/);
});

test("report rejects impossible projection anatomy before it can poison projection cohorts", async () => {
	const records = await collectRecords([{
		ev: (t) => {
			t.observeContextProjection({ actorRoleCode: 1, historyProjection: PROJECTION_ANATOMY });
			t.observePayload({ messages: [] });
		},
	}]);
	assert.equal(records.length, 1);
	const poisoned = {
		...records[0]!,
		historyProjection: { ...records[0]!.historyProjection!, eventCode: 2 as const, causeCode: 3 as const },
	};
	const report = buildCacheReport([records[0]!, poisoned], "project", rateLookup);
	assert.equal(report.requestCount, 1);
	assert.equal(report.schema13Rows, 1);
	assert.equal(report.skippedRecords, 1);
	assert.equal(report.sourceIncomplete, true);
	assert.equal(report.observability?.projection.observedRequests, 1);
	assert.deepEqual(report.observability?.projection.eventCounts, { "2": 1 });
	assert.equal(report.observability?.projectionCohorts.segmentSeal.requestCount, 1);
	assert.equal(report.observability?.retainedWindowUsage.cacheReadShare, null);
	assert.equal(report.observability?.retainedWindowUsage.cacheReadShareStatusCode, 3);
});

test("schema 1.3 cohort shares use exact BigInt sums and fail only overflowing cohorts closed", async () => {
	const [commanderTemplate, workerTemplate] = await collectRecords([
		{
			ev: (t) => {
				t.observeContextProjection({ actorRoleCode: 1, historyProjection: PROJECTION_ANATOMY });
				t.observePayload({ messages: [] });
			},
		},
		{
			ev: (t) => {
				t.observeContextProjection({
					actorRoleCode: 2,
					historyProjection: {
						...PROJECTION_ANATOMY,
						eventCode: 3,
						causeCode: 2,
						epochTransitioned: 1,
						segmentSealed: 0,
						segmentsAfter: 0,
					},
				});
				t.observePayload({ messages: [] });
			},
		},
	]);
	assert.ok(commanderTemplate && workerTemplate);

	const half = 500_000_000_000_000;
	const hugeCommanderRows = Array.from({ length: 20 }, () => ({
		...commanderTemplate,
		usage: { input: half, output: 0, cacheRead: half, cacheWrite: 0, totalTokens: 1_000_000_000_000_000, cost: 0 },
		cacheHitRatio: 0.5,
		promptInputTokens: 1_000_000_000_000_000,
		cacheReadShare: 0.5,
		cacheWriteShare: null,
		cacheWriteStatusCode: 1 as const,
	}));
	for (const row of hugeCommanderRows) assert.equal(isTelemetryRecord(row), true, "each source row remains independently valid");

	const report = buildCacheReport([...hugeCommanderRows, workerTemplate], "project", rateLookup);
	const retained = report.observability?.retainedWindowUsage;
	const commander = report.observability?.actorCohorts.commander;
	const worker = report.observability?.actorCohorts.worker;
	const segment = report.observability?.projectionCohorts.segmentSeal;
	const checkpoint = report.observability?.projectionCohorts.epochTransition;
	assert.ok(retained && commander && worker && segment && checkpoint);

	for (const cohort of [retained, commander, segment]) {
		assert.equal(cohort.promptInputTokens, Number.MAX_SAFE_INTEGER, "overflowing published totals saturate");
		assert.equal(cohort.uncachedInputTokens, Number.MAX_SAFE_INTEGER);
		assert.equal(cohort.cacheReadTokens, Number.MAX_SAFE_INTEGER);
		assert.equal(cohort.cacheReadShare, null, "a true 50% share is never distorted toward 100%");
		assert.equal(cohort.cacheWriteShare, null);
		assert.equal(cohort.cacheReadShareStatusCode, 7);
		assert.equal(cohort.cacheWriteShareStatusCode, 7);
	}

	assert.equal(worker.cacheReadShare, 0.8, "a disjoint non-overflowing actor cohort remains exact");
	assert.equal(worker.cacheReadShareStatusCode, 1);
	assert.equal(worker.cacheWriteShare, null);
	assert.equal(worker.cacheWriteShareStatusCode, 6);
	assert.equal(checkpoint.cacheReadShare, 0.8, "a disjoint non-overflowing projection cohort remains exact");
	assert.equal(checkpoint.cacheReadShareStatusCode, 1);
});

test("report preserves projection counters and only exact eligible public OpenAI explicit-breakpoint usage", async () => {
	const records = await collectRecords([
		{},
		{ ev: (t) => t.observeHistoryProjectionSegmentSeal("a".repeat(64)) },
		{ ev: (t) => t.observeHistoryProjectionEpoch("projection-epoch-2") },
		{
			ev: (t) => t.observeExplicitPromptCacheBreakpointsApplied(),
			facts: {
				provider: "openai",
				model: "gpt-5.6",
				apiKind: "openai-responses",
				usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 2, totalTokens: 13, cost: { total: 0.01 } },
			},
		},
		{
			ev: (t) => t.observeExplicitPromptCacheBreakpointsApplied(),
			facts: {
				provider: "openai",
				model: "gpt-5.6-sol",
				apiKind: "openai-responses",
				usage: { input: 30, output: 2, cacheRead: 60, cacheWrite: 5, totalTokens: 97, cost: { total: 0.02 } },
			},
		},
		{
			ev: (t) => t.observeExplicitPromptCacheBreakpointsApplied(),
			facts: {
				provider: "deepseek",
				model: "gpt-5.6-sol",
				apiKind: "openai-completions",
				usage: { input: 100, output: 3, cacheRead: 900, cacheWrite: 0, totalTokens: 1003, cost: { total: 0.03 } },
			},
		},
		{
			ev: (t) => t.observeExplicitPromptCacheBreakpointsApplied(),
			facts: {
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				apiKind: "openai-codex-responses",
				usage: { input: 200, output: 4, cacheRead: 1_800, cacheWrite: 1, totalTokens: 2_005, cost: { total: 0.04 } },
			},
		},
		{
			ev: (t) => t.observeExplicitPromptCacheBreakpointsApplied(),
			facts: {
				provider: "openai",
				model: "gpt-5.6-sol",
				apiKind: "openai-completions",
				usage: { input: 300, output: 5, cacheRead: 2_700, cacheWrite: 2, totalTokens: 3_007, cost: { total: 0.05 } },
			},
		},
		{
			ev: (t) => t.observeExplicitPromptCacheBreakpointsApplied(),
			facts: {
				provider: "openai",
				model: "gpt-5.60-sol",
				apiKind: "openai-responses",
				usage: { input: 400, output: 6, cacheRead: 3_600, cacheWrite: 3, totalTokens: 4_009, cost: { total: 0.06 } },
			},
		},
	]);
	const applied = records.filter((record) => record.precedingEvent === "explicit_prompt_cache_breakpoints_applied");
	assert.equal(applied.length, 6);
	assert.ok(applied.every((record) => record.usageSemanticStatus === "verified"), "adversarial records have verified usage semantics");
	const report = buildCacheReport(records, "project", rateLookup);
	assert.equal(report.schemaVersion, "1.3");
	assert.equal(report.historyProjectionSegmentSeals, 1);
	assert.equal(report.historyProjectionEpochTransitions, 1);
	assert.equal(report.explicitBreakpointAppliedRequests, 6, "all applied markers remain visible for doctor mismatch diagnostics");
	assert.deepEqual(report.explicitBreakpointVerifiedUsage, {
		requestCount: 2,
		input: 40,
		cacheRead: 60,
		cacheWrite: 7,
		hitRatio: 0.6,
	});
	const rendered = renderCacheReport(report).join("\n");
	assert.match(rendered, /segment seals=1 epoch transitions=1/);
	assert.match(rendered, /explicit breakpoints.*applied=6.*verified requests=2.*cacheRead=60/);
	for (const forbidden of ["boundaryMarker", "segmentChainHash", "payload"]) assert.ok(!rendered.includes(forbidden));

	const partial = buildCacheReport(records, "project", rateLookup, { sourceIncomplete: true, skippedRecords: 1 });
	assert.equal(partial.explicitBreakpointVerifiedUsage.hitRatio, null, "partial source evidence cannot present a clean applied-request ratio");
	assert.equal(partial.observability?.retainedWindowUsage.cacheReadShare, null);
	assert.equal(partial.observability?.retainedWindowUsage.cacheReadShareStatusCode, 3);
});

test("report excludes an errored eligible applied request even when its zero usage semantics are verified", async () => {
	const records = await collectRecords([{
		ev: (t) => t.observeExplicitPromptCacheBreakpointsApplied(),
		facts: {
			provider: "openai",
			model: "gpt-5.6-sol",
			apiKind: "openai-responses",
			stopReason: "error",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		},
	}]);
	assert.equal(records[0]?.messageStatus, "error");
	assert.equal(records[0]?.usageSemanticStatus, "verified", "zero usage remains semantically valid for the API kind");

	const report = buildCacheReport(records, "project", rateLookup);
	assert.equal(report.explicitBreakpointAppliedRequests, 1, "the applied request remains visible as a shape fact");
	assert.deepEqual(report.explicitBreakpointVerifiedUsage, {
		requestCount: 0,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		hitRatio: null,
	});
	assert.equal(report.hitRatio, null, "overall ratio retains its existing zero-denominator semantics");
});

test("truncated complete records suppress only the explicit-breakpoint ratio, not retained numeric facts", async () => {
	const records = await collectRecords([
		{
			ev: (t) => t.observeExplicitPromptCacheBreakpointsApplied(),
			facts: {
				provider: "openai",
				model: "gpt-5.6",
				apiKind: "openai-responses",
				usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 2, totalTokens: 13, cost: { total: 0.01 } },
			},
		},
		{
			ev: (t) => t.observeExplicitPromptCacheBreakpointsApplied(),
			facts: {
				provider: "openai",
				model: "gpt-5.6-sol",
				apiKind: "openai-responses",
				usage: { input: 30, output: 2, cacheRead: 60, cacheWrite: 5, totalTokens: 97, cost: { total: 0.02 } },
			},
		},
	]);
	assert.ok(records.every((record) => record.usageSemanticStatus === "verified"));
	const bounded = buildCacheReport(records, "project", rateLookup, { truncatedRecords: 4 });
	assert.equal(bounded.sourceIncomplete, false);
	assert.equal(bounded.hitRatio, 0.6, "overall hitRatio remains the verified retained-window ratio");
	assert.deepEqual(bounded.explicitBreakpointVerifiedUsage, {
		requestCount: 2,
		input: 40,
		cacheRead: 60,
		cacheWrite: 7,
		hitRatio: null,
	});
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
	assert.equal(report.schemaVersion, "1.3", "empty/current fallback follows the telemetry schema");
	assert.equal(report.requestCount, 0);
	assert.equal(report.hitRatio, null);
	assert.equal(report.semanticStatus, null);
	assert.equal(report.estimatedAvoidedCost, null);
	assert.equal(report.historyProjectionSegmentSeals, 0);
	assert.equal(report.historyProjectionEpochTransitions, 0);
	assert.equal(report.explicitBreakpointAppliedRequests, 0);
	assert.deepEqual(report.explicitBreakpointVerifiedUsage, {
		requestCount: 0,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		hitRatio: null,
	});
});

test("partial or unverified usage semantics never fabricate an aggregate hit ratio", async () => {
	const records = await collectRecords([{}]);
	const partial = [{ ...records[0]!, usageSemanticStatus: "partial" as const, cacheHitRatio: null, cacheReadShare: null, cacheWriteShare: null, cacheWriteStatusCode: 0 as const }];
	const unverified = [{ ...records[0]!, usageSemanticStatus: "unverified" as const, cacheHitRatio: null, cacheReadShare: null, cacheWriteShare: null, cacheWriteStatusCode: 0 as const }];
	const partialReport = buildCacheReport(partial, "project", rateLookup);
	assert.equal(partialReport.hitRatio, null);
	assert.equal(partialReport.observability?.retainedWindowUsage.cacheReadShare, null);
	assert.equal(partialReport.observability?.retainedWindowUsage.cacheReadShareStatusCode, 5);
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
		cacheReadShare: null,
		cacheWriteShare: null,
		cacheWriteStatusCode: 0,
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
	const facts: DoctorFacts = {
		provider: "deepseek", model: "deepseek-v4-flash", apiKind: "openai-completions",
		modelCostPresent: true, modelCostRatesValid: true, systemPrompt: "stable",
		activeToolNames: ["read"], tools: TOOLS, records: [records[0]!, malformed],
		telemetryEnabled: true, telemetryBytes: 1024, telemetryMaxBytes: 5 * 1024 * 1024, rotatedFiles: 0,
	};
	const checks = runDoctor(facts);
	assert.equal(checks.find((check) => check.id === "telemetry_source_quality")?.status, "warn");
	assert.match(checks.find((check) => check.id === "telemetry_source_quality")?.message ?? "", /schema-invalid=1/);
	const json = doctorToJson(checks, facts) as { telemetry_quality?: { invalidSchemaRecords?: number } };
	assert.equal(json.telemetry_quality?.invalidSchemaRecords, 1);
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
	for (const expected of ["current_model", "telemetry_source_quality", "provider_wire_observation", "request_correlation", "usage_fields", "model_cost_metadata", "models_json", "auth_json", "system_prompt_dynamics", "prefix_hashes", "tool_metadata_static", "tool_stability", "same_mode_drift", "expected_vs_unexpected", "history_projection_events", "explicit_breakpoint_usage", "churn", "forbidden_fields", "telemetry_size", "telemetry_enabled"]) {
		assert.ok(ids.includes(expected), expected);
	}
	assert.equal(checks.find((check) => check.id === "explicit_breakpoint_usage")?.status, "skip", "DeepSeek without an applied record is not warned");
});

test("doctor reports segment/checkpoint counts and accepts verified public OpenAI breakpoint usage with cacheRead zero", async () => {
	const records = await collectRecords([
		{},
		{ ev: (t) => t.observeHistoryProjectionSegmentSeal("b".repeat(64)) },
		{ ev: (t) => t.observeHistoryProjectionEpoch("projection-epoch-3") },
		{
			ev: (t) => t.observeExplicitPromptCacheBreakpointsApplied(),
			facts: {
				provider: "openai",
				model: "gpt-5.6-sol",
				apiKind: "openai-responses",
				usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 8, totalTokens: 113, cost: { total: 0.01 } },
			},
		},
	]);
	const facts: DoctorFacts = {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		modelCostPresent: true,
		modelCostRatesValid: true,
		systemPrompt: "stable",
		activeToolNames: ["read", "grep", "find", "bash"],
		tools: TOOLS,
		records,
		telemetryEnabled: true,
		telemetryBytes: 1024,
		telemetryMaxBytes: 5 * 1024 * 1024,
		rotatedFiles: 0,
	};
	const checks = runDoctor(facts);
	const projection = checks.find((check) => check.id === "history_projection_events");
	assert.equal(projection?.status, "ok");
	assert.match(projection?.message ?? "", /segment seals=1 epoch transitions=1/);
	const breakpoint = checks.find((check) => check.id === "explicit_breakpoint_usage");
	assert.equal(breakpoint?.status, "ok", "cacheRead=0 is provider authority, not a failed optimization");
	assert.match(breakpoint?.message ?? "", /applied=1 eligible=1 verified=1.*input=100 cacheRead=0 cacheWrite=8.*ratio=0%/);

	const json = doctorToJson(checks, facts) as {
		history_projection?: { segmentSeals?: number; epochTransitions?: number };
		explicit_breakpoints?: { appliedRequests?: number; eligibleAppliedRequests?: number; erroredEligibleAppliedRequests?: number; verifiedUsage?: { cacheRead?: number; hitRatio?: number | null } };
	};
	assert.deepEqual(json.history_projection, { segmentSeals: 1, epochTransitions: 1 });
	assert.equal(json.explicit_breakpoints?.appliedRequests, 1);
	assert.equal(json.explicit_breakpoints?.eligibleAppliedRequests, 1);
	assert.equal(json.explicit_breakpoints?.erroredEligibleAppliedRequests, 0);
	assert.equal(json.explicit_breakpoints?.verifiedUsage?.cacheRead, 0);
	assert.equal(json.explicit_breakpoints?.verifiedUsage?.hitRatio, 0);
	const serialized = JSON.stringify(json);
	for (const forbidden of ["boundaryMarker", "segmentChainHash", "payload"]) assert.ok(!serialized.includes(forbidden));

	const codexRecords = await collectRecords([{
		facts: {
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			apiKind: "openai-codex-responses",
		},
	}]);
	const codexChecks = runDoctor({
		...facts,
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		apiKind: "openai-codex-responses",
		records: codexRecords,
	});
	assert.equal(codexChecks.find((check) => check.id === "explicit_breakpoint_usage")?.status, "skip", "Codex default-disabled traffic is not warned");
});

test("doctor warns and reports an errored eligible applied request without treating zero usage as authoritative", async () => {
	const records = await collectRecords([{
		ev: (t) => t.observeExplicitPromptCacheBreakpointsApplied(),
		facts: {
			provider: "openai",
			model: "gpt-5.6-sol",
			apiKind: "openai-responses",
			stopReason: "error",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		},
	}]);
	const facts: DoctorFacts = {
		provider: "openai",
		model: "gpt-5.6-sol",
		apiKind: "openai-responses",
		modelCostPresent: true,
		modelCostRatesValid: true,
		systemPrompt: "stable",
		activeToolNames: ["read", "grep", "find", "bash"],
		tools: TOOLS,
		records,
		telemetryEnabled: true,
		telemetryBytes: 1024,
		telemetryMaxBytes: 5 * 1024 * 1024,
		rotatedFiles: 0,
	};
	const checks = runDoctor(facts);
	const breakpoint = checks.find((check) => check.id === "explicit_breakpoint_usage");
	assert.equal(breakpoint?.status, "warn");
	assert.match(breakpoint?.message ?? "", /applied=1 eligible=1 verified=0 errored eligible=1.*messageStatus=error/);
	assert.doesNotMatch(breakpoint?.message ?? "", /provider usage is authoritative/);

	const json = doctorToJson(checks, facts) as {
		explicit_breakpoints?: {
			appliedRequests?: number;
			eligibleAppliedRequests?: number;
			erroredEligibleAppliedRequests?: number;
			verifiedUsage?: { requestCount?: number; input?: number; cacheRead?: number; cacheWrite?: number; hitRatio?: number | null };
		};
	};
	assert.equal(json.explicit_breakpoints?.appliedRequests, 1);
	assert.equal(json.explicit_breakpoints?.eligibleAppliedRequests, 1);
	assert.equal(json.explicit_breakpoints?.erroredEligibleAppliedRequests, 1);
	assert.deepEqual(json.explicit_breakpoints?.verifiedUsage, {
		requestCount: 0,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		hitRatio: null,
	});
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
	assert.equal(checks.find((check) => check.id === "history_projection_events")?.status, "warn");
	assert.equal(checks.find((check) => check.id === "explicit_breakpoint_usage")?.status, "warn");
	assert.equal(checks.find((check) => check.id === "forbidden_fields")?.status, "warn");
	const json = doctorToJson(checks, facts) as { telemetry_quality?: Record<string, unknown> };
	assert.deepEqual(json.telemetry_quality, {
		sourceIncomplete: true,
		skippedRecords: 1,
		invalidSchemaRecords: 0,
		truncatedRecords: 7,
		filesRead: 3,
		sourceUnavailable: "read_error",
	});

	const truncatedOnly = runDoctor({
		...facts,
		sourceIncomplete: false,
		skippedRecords: 0,
		sourceUnavailable: null,
		truncatedRecords: 7,
	});
	assert.equal(truncatedOnly.find((check) => check.id === "history_projection_events")?.status, "warn");
	assert.equal(truncatedOnly.find((check) => check.id === "explicit_breakpoint_usage")?.status, "warn");
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

test("doctor treats hostile telemetry records as partial without invoking traps or accessors", () => {
	let proxyTrapCalls = 0;
	const proxy = new Proxy(Object.create(null) as Record<string, unknown>, {
		get() {
			proxyTrapCalls += 1;
			throw new Error("telemetry proxy get trap executed");
		},
		ownKeys() {
			proxyTrapCalls += 1;
			throw new Error("telemetry proxy ownKeys trap executed");
		},
		getOwnPropertyDescriptor() {
			proxyTrapCalls += 1;
			throw new Error("telemetry proxy descriptor trap executed");
		},
	});
	const revoked = Proxy.revocable(Object.create(null), {});
	revoked.revoke();
	let getterCalls = 0;
	const accessor = Object.create(null) as Record<string, unknown>;
	Object.defineProperty(accessor, "content", {
		enumerable: true,
		get() {
			getterCalls += 1;
			throw new Error("telemetry accessor executed");
		},
	});
	const symbolRecord = Object.create(null) as Record<string | symbol, unknown>;
	symbolRecord[Symbol("hidden")] = "secret";
	const exoticRecord = new Date(0);
	const hostileRecords = [proxy, revoked.proxy, accessor, symbolRecord, exoticRecord];

	for (const hostile of hostileRecords) {
		assert.doesNotThrow(() => hasForbiddenTelemetryFields(hostile));
		assert.notEqual(hasForbiddenTelemetryFields(hostile), null, "uninspectable values fail closed");
	}

	const facts: DoctorFacts = {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		modelCostPresent: true,
		modelCostRatesValid: true,
		systemPrompt: "sp",
		activeToolNames: [],
		tools: [],
		records: hostileRecords as unknown as readonly TelemetryRecord[],
		telemetryEnabled: true,
		telemetryBytes: 10,
		telemetryMaxBytes: 5 * 1024 * 1024,
		rotatedFiles: 0,
	};
	let checks: ReturnType<typeof runDoctor> = [];
	assert.doesNotThrow(() => {
		checks = runDoctor(facts);
	});
	assert.equal(checks.find((check) => check.id === "telemetry_source_quality")?.status, "warn");
	assert.equal(checks.find((check) => check.id === "forbidden_fields")?.status, "warn");
	assert.match(checks.find((check) => check.id === "forbidden_fields")?.message ?? "", /uninspectable=5/);
	assert.doesNotThrow(() => doctorToJson(checks, facts));
	assert.equal(proxyTrapCalls, 0);
	assert.equal(getterCalls, 0);
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
