/**
 * P6-A telemetry tests — event observation, invalidation classification,
 * record contents, payload read-only guarantee, status segment, graceful
 * fallback for non-DeepSeek providers, and session state persistence.
 */

import assert from "node:assert/strict";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	CACHE_STATE_ENTRY_TYPE,
	createCacheTelemetry,
	formatTokens,
	type CacheStateEntryLike,
	type CacheTelemetry,
	type MessageEndFacts,
} from "../extensions/workbench-runtime/cache/cache-telemetry.ts";
import { buildCacheReport, renderCacheStatus } from "../extensions/workbench-runtime/cache/cache-report.ts";
import { isTelemetryRecord } from "../extensions/workbench-runtime/cache/cache-types.ts";
import { invalidationClass, type CacheInvalidationReason } from "../extensions/workbench-runtime/cache/invalidation-classifier.ts";
import { CacheStore, hasForbiddenTelemetryFields } from "../extensions/workbench-runtime/cache/cache-store.ts";
import { withTempDir } from "./helpers.ts";

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

interface TelemetryHarness {
	telemetry: CacheTelemetry;
	entries: CacheStateEntryLike[];
}

function makeHarness(): TelemetryHarness {
	const entries: CacheStateEntryLike[] = [];
	const telemetry = createCacheTelemetry({
		now: () => BASE_TIME,
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	});
	telemetry.setProjectRoot("/tmp/unused-project-root");
	telemetry.setSessionId("session-file-A");
	telemetry.setMode("DEV");
	telemetry.setThinkingLevel("high");
	telemetry.setEnabled(true);
	return { telemetry, entries };
}

function makeRestoreTarget(sessionId = "session-file-A"): CacheTelemetry {
	const telemetry = createCacheTelemetry({ now: () => BASE_TIME, appendEntry: () => {} });
	telemetry.setSessionId(sessionId);
	telemetry.setMode("DEV");
	telemetry.setThinkingLevel("high");
	return telemetry;
}

function cacheStateEntry(data: unknown): CacheStateEntryLike {
	return { type: "custom", customType: CACHE_STATE_ENTRY_TYPE, data };
}

async function validCacheStateData(): Promise<Record<string, unknown>> {
	const { telemetry, entries } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	const data = entries.at(-1)?.data;
	assert.ok(data && typeof data === "object");
	return structuredClone(data) as Record<string, unknown>;
}

const TOOLS = [
	{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } }, promptGuidelines: ["Use for files"] },
	{ name: "grep", description: "search text", parameters: { type: "object" } },
	{ name: "find", description: "find files", parameters: { type: "object" } },
	{ name: "bash", description: "run a command", parameters: { type: "object" } },
];

function baseFacts(overrides: Partial<MessageEndFacts> = {}): MessageEndFacts {
	return {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		usage: { input: 10000, output: 500, cacheRead: 40000, cacheWrite: 0, totalTokens: 50500, cost: { total: 0.001 } },
		thinkingLevel: "high",
		systemPrompt: "You are the pi-dev-workbench assistant.",
		activeToolNames: ["read", "grep", "find", "bash"],
		tools: TOOLS,
		...overrides,
	};
}

test("first request: record written, FIRST_OBSERVED_REQUEST, verified semantics, hashes only", async () => {
	const { telemetry } = makeHarness();
	const record = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(record);
	assert.equal(record.inferredInvalidationReason, "FIRST_OBSERVED_REQUEST");
	assert.equal(record.inferenceConfidence, "high");
	assert.equal(record.usageSemanticStatus, "verified");
	assert.equal(record.cacheHitRatio, 0.8);
	assert.equal(record.usage.cost, 0.001);
	assert.equal(record.provider, "deepseek");
	assert.equal(record.model, "deepseek-v4-flash");
	assert.equal(record.apiKind, "openai-completions");
	assert.equal(record.workbenchMode, "DEV");
	assert.equal(record.thinkingLevel, "high");
	assert.equal(record.messageStatus, "ok");
	assert.match(record.systemPromptHash, /^[0-9a-f]{64}$/);
	assert.match(record.activeToolNamesHash, /^[0-9a-f]{64}$/);
	assert.match(record.activeToolOrderHash, /^[0-9a-f]{64}$/);
	assert.ok(record.activeToolSchemaHash);
	assert.ok(record.contextShapeHash === null, "no payload observed yet");
	assert.equal(record.hashedSessionId.length, 16, "session id is hashed and truncated");
	// privacy: no prompt text, no tool description text, no message content
	const serialized = JSON.stringify(record);
	assert.ok(!serialized.includes("pi-dev-workbench assistant"), "system prompt text must not be stored");
	assert.ok(!serialized.includes("read a file"), "tool description text must not be stored");
	assert.ok(!serialized.includes("Use for files"), "promptGuidelines text must not be stored");
	assert.equal(hasForbiddenTelemetryFields(record), null);
});

test("stable context: second identical request classifies UNKNOWN, not a fabricated reason", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	const second = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(second);
	assert.equal(second.inferredInvalidationReason, "UNKNOWN");
	assert.equal(second.inferenceConfidence, "low");
	assert.equal(second.usageSemanticStatus, "verified");
});

test("model change is inferred as MODEL_CHANGED (expected, high)", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	telemetry.observeModelChange({ provider: "deepseek", id: "deepseek-v4-pro", api: "openai-completions" });
	const record = await telemetry.observeMessageEnd(baseFacts({ model: "deepseek-v4-pro" }));
	assert.ok(record);
	assert.equal(record.inferredInvalidationReason, "MODEL_CHANGED");
	assert.equal(record.inferenceConfidence, "high");
	assert.equal(invalidationClass(record.inferredInvalidationReason), "expected");
});

test("thinking level change is inferred as THINKING_LEVEL_CHANGED", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	telemetry.observeThinkingChange("max");
	const record = await telemetry.observeMessageEnd(baseFacts({ thinkingLevel: "max" }));
	assert.ok(record);
	assert.equal(record.inferredInvalidationReason, "THINKING_LEVEL_CHANGED");
	assert.equal(record.thinkingLevel, "max");
});

test("mode change is inferred as MODE_CHANGED (expected invalidation)", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	telemetry.observeModeChange("VERIFY");
	const record = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(record);
	assert.equal(record.inferredInvalidationReason, "MODE_CHANGED");
	assert.equal(record.workbenchMode, "VERIFY");
	assert.equal(invalidationClass(record.inferredInvalidationReason), "expected");
});

test("system prompt change is inferred as UNEXPECTED_DRIFT (unexpected drift)", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	const record = await telemetry.observeMessageEnd(baseFacts({ systemPrompt: "You are the pi-dev-workbench assistant (v2)." }));
	assert.ok(record);
	assert.equal(record.inferredInvalidationReason, "UNEXPECTED_DRIFT");
	assert.equal(record.driftSource, "SYSTEM_PROMPT");
	assert.equal(record.inferenceConfidence, "medium");
	assert.equal(invalidationClass(record.inferredInvalidationReason), "unexpected");
});

test("tool set change is inferred as UNEXPECTED_DRIFT (driftSource TOOL_SET)", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	const record = await telemetry.observeMessageEnd(baseFacts({ activeToolNames: ["read", "grep", "bash"] }));
	assert.ok(record);
	assert.equal(record.inferredInvalidationReason, "UNEXPECTED_DRIFT");
	assert.equal(record.driftSource, "TOOL_SET");
});

test("tool order change (same set) is inferred as UNEXPECTED_DRIFT (driftSource TOOL_ORDER)", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	const record = await telemetry.observeMessageEnd(baseFacts({ activeToolNames: ["grep", "read", "find", "bash"] }));
	assert.ok(record);
	assert.equal(record.inferredInvalidationReason, "UNEXPECTED_DRIFT");
	assert.equal(record.driftSource, "TOOL_ORDER");
});

test("tool schema change (same names/order) is inferred as UNEXPECTED_DRIFT (driftSource TOOL_SCHEMA)", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	const changedTools = TOOLS.map((t) => (t.name === "read" ? { ...t, description: "read a file (v2)" } : t));
	const record = await telemetry.observeMessageEnd(baseFacts({ tools: changedTools }));
	assert.ok(record);
	assert.equal(record.inferredInvalidationReason, "UNEXPECTED_DRIFT");
	assert.equal(record.driftSource, "TOOL_SCHEMA");
	assert.equal(invalidationClass(record.inferredInvalidationReason), "unexpected");
});

test("expected vs unexpected invalidation classes", () => {
	for (const reason of ["FIRST_OBSERVED_REQUEST", "NEW_SESSION", "MODEL_CHANGED", "THINKING_LEVEL_CHANGED", "MODE_CHANGED", "PACKAGE_RELOADED", "COMPACTION", "SESSION_TREE_CHANGED", "HISTORY_PROJECTION_EPOCH_CHANGED", "HISTORY_PROJECTION_SEGMENT_SEALED", "PROVIDER_BEST_EFFORT_MISS"]) {
		assert.equal(invalidationClass(reason as CacheInvalidationReason), "expected", reason);
	}
	for (const reason of ["UNEXPECTED_DRIFT", "SYSTEM_PROMPT_CHANGED", "TOOL_SET_CHANGED", "TOOL_ORDER_CHANGED", "TOOL_SCHEMA_CHANGED", "CONTEXT_PREFIX_DIVERGED"]) {
		assert.equal(invalidationClass(reason as CacheInvalidationReason), "unexpected", reason);
	}
	assert.equal(invalidationClass("UNKNOWN"), "unknown");
});

test("reload and compaction are explicit expected invalidations", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	telemetry.observeReload();
	const reloaded = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(reloaded);
	assert.equal(reloaded.inferredInvalidationReason, "PACKAGE_RELOADED");
	telemetry.observeCompaction();
	const compacted = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(compacted);
	assert.equal(compacted.inferredInvalidationReason, "COMPACTION");
});

test("provider best-effort miss: stable context but zero cache read", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	const record = await telemetry.observeMessageEnd(baseFacts({ usage: { input: 50000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 50500, cost: { total: 0.003 } } }));
	assert.ok(record);
	assert.equal(record.inferredInvalidationReason, "PROVIDER_BEST_EFFORT_MISS");
	assert.equal(record.inferenceConfidence, "low");
	assert.equal(invalidationClass(record.inferredInvalidationReason), "expected");
});

test("normal append-only payload growth is not classified as context prefix divergence", async () => {
	const { telemetry } = makeHarness();
	telemetry.observePayload({ model: "deepseek-v4-flash", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }], stream: true });
	const first = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(first);
	assert.ok(first.contextShapeHash, "contextShapeHash from the payload summary");
	telemetry.observePayload({ model: "deepseek-v4-flash", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }, { role: "assistant", content: "hi" }], stream: true });
	const second = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(second);
	assert.equal(second.inferredInvalidationReason, "UNKNOWN");
	assert.notEqual(first.contextShapeHash, second.contextShapeHash);
});

test("rewriting an existing payload prefix is classified as context prefix divergence", async () => {
	const { telemetry } = makeHarness();
	telemetry.observePayload({ model: "deepseek-v4-flash", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }], stream: true });
	await telemetry.observeMessageEnd(baseFacts());
	telemetry.observePayload({ model: "deepseek-v4-flash", messages: [{ role: "system", content: "sys" }, { role: "user", content: "rewritten" }], stream: true });
	const rewritten = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(rewritten);
	assert.equal(rewritten.inferredInvalidationReason, "CONTEXT_PREFIX_DIVERGED");
});

test("explicit history projection epoch changes are expected and deduplicated", async () => {
	const { telemetry, entries } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	telemetry.observeHistoryProjectionEpoch("projection-1");
	const projected = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(projected);
	assert.equal(projected.inferredInvalidationReason, "HISTORY_PROJECTION_EPOCH_CHANGED");
	assert.equal(invalidationClass(projected.inferredInvalidationReason), "expected");
	assert.ok(!JSON.stringify(entries).includes("projection-1"), "raw projection epoch identifier is never persisted");
	telemetry.observeHistoryProjectionEpoch("projection-1");
	const unchanged = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(unchanged);
	assert.equal(unchanged.inferredInvalidationReason, "UNKNOWN");
});

test("history projection segment seals are expected, hash-only, and deduplicated", async () => {
	const { telemetry, entries } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	telemetry.observeHistoryProjectionSegmentSeal("not-a-segment-hash");
	assert.equal((await telemetry.observeMessageEnd(baseFacts()))?.inferredInvalidationReason, "UNKNOWN");
	const segmentChainHash = "a".repeat(64);
	telemetry.observeHistoryProjectionSegmentSeal(segmentChainHash);
	const sealed = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(sealed);
	assert.equal(sealed.inferredInvalidationReason, "HISTORY_PROJECTION_SEGMENT_SEALED");
	assert.equal(invalidationClass(sealed.inferredInvalidationReason), "expected");
	assert.ok(!JSON.stringify(entries).includes(segmentChainHash), "segment-chain hashes are never persisted");
	telemetry.observeHistoryProjectionSegmentSeal(segmentChainHash);
	const unchanged = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(unchanged);
	assert.equal(unchanged.inferredInvalidationReason, "UNKNOWN");
});

test("lifecycle invalidation outranks and consumes epoch plus segment markers; epoch outranks seal", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());

	telemetry.observeHistoryProjectionSegmentSeal("b".repeat(64));
	telemetry.observeHistoryProjectionEpoch("epoch-priority-1");
	const epoch = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(epoch);
	assert.equal(epoch.inferredInvalidationReason, "HISTORY_PROJECTION_EPOCH_CHANGED");

	telemetry.observeHistoryProjectionSegmentSeal("c".repeat(64));
	telemetry.observeHistoryProjectionEpoch("epoch-priority-2");
	telemetry.observeModeChange("VERIFY");
	const lifecycle = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(lifecycle);
	assert.equal(lifecycle.inferredInvalidationReason, "MODE_CHANGED");
	const consumed = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(consumed);
	assert.equal(consumed.inferredInvalidationReason, "UNKNOWN", "the winning lifecycle event consumes both projection markers");
});

test("projection marker dedupe resets at a session restore boundary", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	const sessionScopedSegmentHash = "d".repeat(64);
	telemetry.observeHistoryProjectionSegmentSeal(sessionScopedSegmentHash);
	assert.equal((await telemetry.observeMessageEnd(baseFacts()))?.inferredInvalidationReason, "HISTORY_PROJECTION_SEGMENT_SEALED");

	telemetry.restoreFromEntries([]);
	assert.equal((await telemetry.observeMessageEnd(baseFacts()))?.inferredInvalidationReason, "NEW_SESSION");
	telemetry.observeHistoryProjectionSegmentSeal(sessionScopedSegmentHash);
	assert.equal(
		(await telemetry.observeMessageEnd(baseFacts()))?.inferredInvalidationReason,
		"HISTORY_PROJECTION_SEGMENT_SEALED",
		"in-memory segment hashes never leak across a restored session boundary",
	);
});

test("session-tree navigation is an expected one-shot invalidation and later prefix rewrites still drift", async () => {
	const { telemetry } = makeHarness();
	const payload = (text: string) => ({
		model: "deepseek-v4-flash",
		messages: [{ role: "system", content: "sys" }, { role: "user", content: text }],
		stream: true,
	});
	telemetry.observePayload(payload("original branch"));
	await telemetry.observeMessageEnd(baseFacts());

	telemetry.observeSessionTreeChange();
	telemetry.observePayload(payload("selected branch"));
	const navigated = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(navigated);
	assert.equal(navigated.inferredInvalidationReason, "SESSION_TREE_CHANGED");
	assert.equal(navigated.inferenceConfidence, "high");
	assert.equal(invalidationClass(navigated.inferredInvalidationReason), "expected");

	telemetry.observePayload(payload("unattributed rewrite"));
	const drifted = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(drifted);
	assert.equal(drifted.inferredInvalidationReason, "CONTEXT_PREFIX_DIVERGED", "tree marker is consumed exactly once");
	assert.equal(invalidationClass(drifted.inferredInvalidationReason), "unexpected");
});

test("before_provider_request never mutates the payload", () => {
	const { telemetry } = makeHarness();
	const payload = {
		model: "deepseek-v4-flash",
		messages: [
			{ role: "system", content: "You are the pi-dev-workbench assistant." },
			{ role: "user", content: ["text part 1", { type: "text", text: "part 2" }] },
		],
		tools: [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object" } } }],
		stream: true,
	};
	const snapshot = JSON.parse(JSON.stringify(payload)) as unknown;
	telemetry.observePayload(payload);
	assert.deepEqual(payload, snapshot, "payload must be untouched (deep-equal before/after)");
});

test("explicit prompt-cache breakpoint application is a preceding event, not a cache-hit claim", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	telemetry.observePayload({ model: "gpt-5.6-sol", input: [] });
	telemetry.observeExplicitPromptCacheBreakpointsApplied();
	const record = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(record);
	assert.equal(record.precedingEvent, "explicit_prompt_cache_breakpoints_applied");
	assert.equal(record.inferredInvalidationReason, "UNKNOWN");
	assert.equal(record.cacheHitRatio, 0.8, "provider usage remains the only cache-hit evidence");
});

test("payload summary keeps only structure — no text content", () => {
	const { telemetry } = makeHarness();
	telemetry.observePayload({
		model: "deepseek-v4-flash",
		messages: [
			{ role: "system", content: "TOP-SECRET-SYSTEM-PROMPT" },
			{ role: "user", content: "TOP-SECRET-USER-MESSAGE" },
		],
		tools: [{ type: "function", function: { name: "read", description: "desc", parameters: { type: "object" } } }],
	});
	const record = (async () => {
		const r = await telemetry.observeMessageEnd(baseFacts());
		return r;
	})();
	return record.then((r) => {
		assert.ok(r);
		const serialized = JSON.stringify(r);
		assert.ok(!serialized.includes("TOP-SECRET"), "payload text must never reach records");
	});
});

test("status segment: verified data, N/A semantics, and empty state", async () => {
	const { telemetry } = makeHarness();
	assert.equal(telemetry.statusSegment(), undefined, "no requests yet -> no segment");
	await telemetry.observeMessageEnd(baseFacts());
	assert.equal(telemetry.statusSegment(), "CACHE last=80% cum=80% | read 40k | miss 10k");
	// unverified semantics -> N/A
	const { telemetry: telemetry2 } = makeHarness();
	await telemetry2.observeMessageEnd(baseFacts({ apiKind: "unknown-api", usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } } }));
	assert.equal(telemetry2.statusSegment(), "CACHE last=N/A cum=N/A | read 1 | miss 1");
});

test("no-UI mode: telemetry is pure data, works without any UI context", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	await telemetry.observeMessageEnd(baseFacts({
		usage: { input: 90, output: 10, cacheRead: 10, cacheWrite: 0, totalTokens: 110, cost: { total: 0 } },
	}));
	const snapshot = telemetry.snapshot();
	assert.equal(snapshot.requestCount, 2);
	assert.equal(snapshot.lastRequestSemanticStatus, "verified");
	assert.equal(snapshot.cumulativeSemanticStatus, "verified");
	assert.equal(snapshot.lastRequestHitRatio, 0.1);
	assert.equal(snapshot.cumulativeHitRatio, 40010 / 50100);
	assert.equal(typeof telemetry.statusSegment(), "string");
});

test("non-DeepSeek provider degrades gracefully (unknown api kind)", async () => {
	const { telemetry } = makeHarness();
	const record = await telemetry.observeMessageEnd(
		baseFacts({ provider: "some-other-provider", model: "other-model", apiKind: "mystery-api" }),
	);
	assert.ok(record, "records still written for foreign providers");
	assert.equal(record.usageSemanticStatus, "partial");
	assert.equal(record.cacheHitRatio, null, "no guessed ratio");
	assert.equal(telemetry.statusSegment(), "CACHE last=N/A cum=N/A | read 40k | miss 10k");
});

test("anthropic-messages api kind is verified (input excludes cache reads)", async () => {
	const { telemetry } = makeHarness();
	const record = await telemetry.observeMessageEnd(
		baseFacts({ provider: "anthropic", model: "claude-sonnet-4-20250514", apiKind: "anthropic-messages" }),
	);
	assert.ok(record);
	assert.equal(record.usageSemanticStatus, "verified");
	assert.equal(record.cacheHitRatio, 0.8);
});

test("openai-codex-responses (Sol) is verified, computes exact ratio, renders numeric CACHE footer", async () => {
	// Root-cause regression: Pi normalizes the Codex provider through
	// openai-responses-shared, so GPT-5.6 Sol's nonzero cacheRead must never
	// show CACHE N/A again.
	const { telemetry } = makeHarness();
	const record = await telemetry.observeMessageEnd(
		baseFacts({
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			apiKind: "openai-codex-responses",
			usage: { input: 10000, output: 500, cacheRead: 40000, cacheWrite: 0, totalTokens: 50500, cost: { total: 0.001 } },
		}),
	);
	assert.ok(record);
	assert.equal(record.apiKind, "openai-codex-responses");
	assert.equal(record.usageSemanticStatus, "verified");
	assert.equal(record.cacheHitRatio, 0.8, "exact ratio cacheRead/(input+cacheRead)");
	assert.equal(telemetry.statusSegment(), "CACHE last=80% cum=80% | read 40k | miss 10k", "numeric CACHE footer, not N/A");
});

test("verified semantics with zero denominator: null ratio and CACHE N/A footer", async () => {
	const { telemetry } = makeHarness();
	const record = await telemetry.observeMessageEnd(
		baseFacts({
			apiKind: "openai-codex-responses",
			usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0 } },
		}),
	);
	assert.ok(record);
	assert.equal(record.usageSemanticStatus, "verified");
	assert.equal(record.cacheHitRatio, null, "zero denominator yields null, never NaN/Infinity");
	assert.equal(telemetry.statusSegment(), "CACHE last=N/A cum=N/A | read 0 | miss 0");
});

test("disabled telemetry records nothing", async () => {
	const { telemetry } = makeHarness();
	telemetry.setEnabled(false);
	const record = await telemetry.observeMessageEnd(baseFacts());
	assert.equal(record, null);
	assert.equal(telemetry.statusSegment(), undefined);
});

test("usage-less, disabled, and store-less message_end settle request correlation before the next request", async () => {
	const cases: Array<{
		label: string;
		telemetry: CacheTelemetry;
		earlyFacts: MessageEndFacts;
		recover: () => void;
	}> = [];

	const usageLess = makeHarness().telemetry;
	cases.push({ label: "usage-less", telemetry: usageLess, earlyFacts: baseFacts({ usage: undefined }), recover: () => {} });

	const disabled = makeHarness().telemetry;
	disabled.setEnabled(false);
	cases.push({ label: "disabled", telemetry: disabled, earlyFacts: baseFacts(), recover: () => disabled.setEnabled(true) });

	const storeLess = createCacheTelemetry({ now: () => BASE_TIME, appendEntry: () => {} });
	storeLess.setSessionId("session-file-A");
	storeLess.setMode("DEV");
	storeLess.setThinkingLevel("high");
	cases.push({
		label: "store-less",
		telemetry: storeLess,
		earlyFacts: baseFacts(),
		recover: () => storeLess.setProjectRoot("/tmp/unused-project-root"),
	});

	for (const scenario of cases) {
		scenario.telemetry.observeContextProjection({ actorRoleCode: 1, historyProjection: PROJECTION_ANATOMY });
		scenario.telemetry.observePayload({ messages: [{ role: "user", content: `dropped-${scenario.label}` }] });
		assert.equal(await scenario.telemetry.observeMessageEnd(scenario.earlyFacts), null, scenario.label);
		scenario.recover();

		scenario.telemetry.observeContextProjection({ actorRoleCode: 2, historyProjection: PROJECTION_ANATOMY });
		scenario.telemetry.observePayload({ messages: [{ role: "user", content: `healthy-${scenario.label}` }] });
		const healthy = await scenario.telemetry.observeMessageEnd(baseFacts());
		assert.ok(healthy, scenario.label);
		assert.equal(healthy.requestCorrelationCode, 1, scenario.label);
		assert.equal(healthy.actorRoleCode, 2, scenario.label);
		assert.equal(healthy.historyProjection?.contextSerial, 2, scenario.label);
		assert.equal(healthy.wireObservation?.requestSerial, 2, scenario.label);
	}
});

test("session state entry is lightweight and restored on session_start", async () => {
	const { telemetry, entries } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	await telemetry.observeMessageEnd(baseFacts());
	telemetry.flush();

	const stateEntries = entries.filter((e) => e.customType === "workbench-cache-state");
	assert.equal(stateEntries.length >= 1, true);
	assert.equal((stateEntries[0]?.data as { requestCount?: number }).requestCount, 1, "older entries keep their own chronological snapshot");
	assert.notEqual(stateEntries[0]?.data, stateEntries[stateEntries.length - 1]?.data, "persisted snapshots never expose the mutable internal state");
	const data = stateEntries[stateEntries.length - 1]?.data as {
		schemaVersion: string;
		requestCount: number;
		usage: { input: number; cost: number };
		lastHashes: Record<string, string>;
		lastInvalidationReason: string;
		telemetryFile: string;
		telemetryWriteGapPending: number;
	};
	assert.ok(data);
	assert.equal(data.schemaVersion, "1.3");
	assert.equal(data.requestCount, 2);
	assert.equal(data.usage.input, 20000);
	assert.equal(data.usage.cost, 0.002);
	assert.ok(data.lastHashes.systemPromptHash);
	assert.equal(data.lastInvalidationReason, "UNKNOWN");
	assert.equal(data.telemetryFile, ".pi/workbench/cache/telemetry.jsonl");
	assert.equal(data.telemetryWriteGapPending, 0);
	// no message bodies, no large arrays
	const serialized = JSON.stringify(data);
	assert.ok(!serialized.includes("pi-dev-workbench assistant"));
	assert.ok(serialized.length < 2000);

	// restore into a fresh instance (same session id)
	const restored = createCacheTelemetry({ now: () => BASE_TIME, appendEntry: () => {} });
	restored.setProjectRoot("/tmp/irrelevant");
	restored.setSessionId("session-file-A");
	restored.restoreFromEntries(stateEntries);
	restored.setMode("DEV");
	const record = await restored.observeMessageEnd(baseFacts());
	assert.ok(record);
	assert.equal(record.inferredInvalidationReason, "UNKNOWN", "hashes matched, no change");
	assert.equal(record.hashedSessionId.length, 16);
	// aggregate continues from the restored count
	assert.equal(restored.snapshot().requestCount, 3);
});

test("legacy restored aggregates without semantic provenance never fabricate a cumulative ratio", async () => {
	const { telemetry, entries } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	const legacyEntries = entries.map((entry) => {
		if (entry.customType !== "workbench-cache-state" || typeof entry.data !== "object" || entry.data === null) return entry;
		const {
			usageSemanticStatus: _removedSemanticStatus,
			telemetryWriteGapPending: _removedGapFlag,
			...legacy
		} = entry.data as Record<string, unknown>;
		return { ...entry, data: { ...legacy, schemaVersion: "1.0" } };
	});
	const restored = createCacheTelemetry({ now: () => BASE_TIME, appendEntry: () => {} });
	restored.setProjectRoot("/tmp/irrelevant");
	restored.setSessionId("session-file-A");
	restored.restoreFromEntries(legacyEntries);
	assert.equal(restored.snapshot().requestCount, 1, "legacy state remains restorable");
	assert.equal(restored.snapshot().cumulativeSemanticStatus, "unverified");
	assert.equal(restored.snapshot().cumulativeHitRatio, null);
	assert.equal(restored.statusSegment(), "CACHE last=N/A cum=N/A | read 40k | miss 10k");
	await restored.observeMessageEnd(baseFacts());
	assert.equal(restored.snapshot().cumulativeSemanticStatus, "unverified");
	assert.equal(restored.snapshot().cumulativeHitRatio, null);
	assert.equal(restored.statusSegment(), "CACHE last=80% cum=N/A | read 80k | miss 20k");
});

test("strict cache-state restoration accepts schema 1.1 through current 1.3 only with the known shape", async () => {
	const current = await validCacheStateData();
	for (const schemaVersion of ["1.1", "1.2", "1.3"] as const) {
		const restored = makeRestoreTarget();
		restored.restoreFromEntries([cacheStateEntry({ ...current, schemaVersion })]);
		assert.equal(restored.snapshot().requestCount, 1, schemaVersion);
		assert.equal(restored.snapshot().cumulativeSemanticStatus, "verified", schemaVersion);
	}

	for (const data of [
		{ ...current, schemaVersion: "1.4" },
		{ ...current, schemaVersion: "1.1", projectionSegmentHash: "secret" },
		{ ...current, schemaVersion: "1.1", lastInvalidationReason: "HISTORY_PROJECTION_SEGMENT_SEALED" },
	]) {
		const rejected = makeRestoreTarget();
		rejected.restoreFromEntries([cacheStateEntry(data)]);
		assert.equal(rejected.snapshot().requestCount, 0);
	}
});

test("footer keeps a verified last-request ratio visible when cumulative semantics are legacy N/A", async () => {
	const { telemetry, entries } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	const legacyEntries = entries.map((entry) => {
		if (entry.customType !== "workbench-cache-state" || typeof entry.data !== "object" || entry.data === null) return entry;
		const {
			usageSemanticStatus: _removedSemanticStatus,
			telemetryWriteGapPending: _removedGapFlag,
			...legacy
		} = entry.data as Record<string, unknown>;
		return { ...entry, data: legacy };
	});
	const restored = createCacheTelemetry({ now: () => BASE_TIME, appendEntry: () => {} });
	restored.setProjectRoot("/tmp/irrelevant");
	restored.setSessionId("session-file-A");
	restored.restoreFromEntries(legacyEntries);
	const legacyFollowup = await restored.observeMessageEnd(baseFacts({
		usage: { input: 20, output: 1, cacheRead: 80, cacheWrite: 0, totalTokens: 101, cost: { total: 0 } },
	}));
	assert.ok(legacyFollowup);
	assert.notEqual(legacyFollowup.precedingEvent, "telemetry_write_gap", "legacy unverified state never fabricates a write gap");
	assert.equal(restored.statusSegment(), "CACHE last=80% cum=N/A | read 40k | miss 10k");
	assert.equal(restored.snapshot().lastRequestHitRatio, 0.8);
	assert.equal(restored.snapshot().cumulativeHitRatio, null);
});

test("state restore rejects accessors, proxies, and revoked proxies without executing hostile code", async () => {
	const valid = await validCacheStateData();
	let getterCalls = 0;
	const accessorState = { ...valid };
	Object.defineProperty(accessorState, "usage", {
		enumerable: true,
		get(): never {
			getterCalls += 1;
			throw new Error("state getter executed");
		},
	});

	let proxyTrapCalls = 0;
	const proxyState = new Proxy(valid, {
		get(): never {
			proxyTrapCalls += 1;
			throw new Error("state proxy trap executed");
		},
		ownKeys(): never {
			proxyTrapCalls += 1;
			throw new Error("state proxy ownKeys trap executed");
		},
	});
	const revokedState = Proxy.revocable(valid, {});
	revokedState.revoke();

	for (const hostile of [accessorState, proxyState, revokedState.proxy]) {
		const restored = makeRestoreTarget();
		assert.doesNotThrow(() => restored.restoreFromEntries([cacheStateEntry(hostile)]));
		assert.equal(restored.snapshot().requestCount, 0);
		assert.equal(restored.statusSegment(), undefined);
		assert.doesNotThrow(() => renderCacheStatus(restored.snapshot()));
	}
	assert.equal(getterCalls, 0, "accessor descriptors are rejected without invoking the getter");
	assert.equal(proxyTrapCalls, 0, "node proxy detection rejects state before any proxy trap");

	let entryGetterCalls = 0;
	const accessorEntry: Record<string, unknown> = { type: "custom", data: valid };
	Object.defineProperty(accessorEntry, "customType", {
		enumerable: true,
		get(): never {
			entryGetterCalls += 1;
			throw new Error("entry getter executed");
		},
	});
	const entryTarget = makeRestoreTarget();
	assert.doesNotThrow(() => entryTarget.restoreFromEntries([accessorEntry as unknown as CacheStateEntryLike]));
	assert.equal(entryGetterCalls, 0);
	assert.equal(entryTarget.snapshot().requestCount, 0);

	const revokedEntries = Proxy.revocable([cacheStateEntry(valid)], {});
	revokedEntries.revoke();
	const arrayTarget = makeRestoreTarget();
	assert.doesNotThrow(() => arrayTarget.restoreFromEntries(revokedEntries.proxy));
	assert.equal(arrayTarget.snapshot().requestCount, 0);
});

test("state restore rejects injected strings, invalid numerics, extra keys, and inconsistent aggregates", async () => {
	const valid = await validCacheStateData();
	const usage = valid.usage as Record<string, unknown>;
	const hashes = valid.lastHashes as Record<string, unknown>;
	const invalidStates: Array<{ label: string; data: Record<string, unknown> }> = [
		{ label: "usage string", data: { ...valid, usage: "not-usage" } },
		{ label: "negative token", data: { ...valid, usage: { ...usage, input: -1 } } },
		{ label: "NaN cost", data: { ...valid, usage: { ...usage, cost: Number.NaN } } },
		{ label: "infinite cost", data: { ...valid, usage: { ...usage, cost: Number.POSITIVE_INFINITY } } },
		{ label: "huge request count", data: { ...valid, requestCount: Number.MAX_SAFE_INTEGER } },
		{ label: "huge token", data: { ...valid, usage: { ...usage, cacheRead: Number.MAX_SAFE_INTEGER } } },
		{ label: "total mismatch", data: { ...valid, usage: { ...usage, totalTokens: 1 } } },
		{ label: "invalid semantic provenance", data: { ...valid, usageSemanticStatus: "verified-ish" } },
		{ label: "invalid write-gap flag", data: { ...valid, telemetryWriteGapPending: 2 } },
		{ label: "write-gap flag requires unverified aggregate", data: { ...valid, telemetryWriteGapPending: 1, usageSemanticStatus: "verified" } },
		{ label: "invalid hash", data: { ...valid, lastHashes: { ...hashes, systemPromptHash: "not-a-hash" } } },
		{ label: "missing hashes for nonempty state", data: { ...valid, lastHashes: {} } },
		{ label: "unsafe telemetry path", data: { ...valid, telemetryFile: ".pi/workbench/cache/telemetry.jsonl\nspoof" } },
		{ label: "extra state key", data: { ...valid, injectedPrompt: "secret" } },
		{ label: "extra usage key", data: { ...valid, usage: { ...usage, hidden: 1 } } },
		{ label: "extra hash key", data: { ...valid, lastHashes: { ...hashes, hidden: "secret" } } },
	];

	for (const invalid of invalidStates) {
		const restored = makeRestoreTarget();
		assert.doesNotThrow(() => restored.restoreFromEntries([cacheStateEntry(invalid.data)]), invalid.label);
		const snapshot = restored.snapshot();
		assert.equal(snapshot.requestCount, 0, invalid.label);
		assert.deepEqual(snapshot.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, invalid.label);
		assert.equal(restored.statusSegment(), undefined, invalid.label);
		const rendered = renderCacheStatus(snapshot).join("\n");
		assert.doesNotMatch(rendered, /NaN|Infinity/, invalid.label);
	}
});

test("restore uses only the latest matching entry: older malformed is ignored, latest malformed fails closed", async () => {
	const valid = await validCacheStateData();
	const olderAccessor: Record<string, unknown> = { ...valid };
	let olderGetterCalls = 0;
	Object.defineProperty(olderAccessor, "usage", {
		enumerable: true,
		get(): never {
			olderGetterCalls += 1;
			throw new Error("older getter executed");
		},
	});
	const latestValid = makeRestoreTarget();
	latestValid.restoreFromEntries([
		cacheStateEntry(olderAccessor),
		{ type: "custom", customType: "unrelated", data: { secret: true } },
		cacheStateEntry(valid),
	]);
	assert.equal(latestValid.snapshot().requestCount, 1);
	assert.equal(latestValid.snapshot().cumulativeSemanticStatus, "verified");
	assert.equal(latestValid.snapshot().cumulativeHitRatio, 0.8);
	assert.equal(olderGetterCalls, 0, "the older malformed entry is never inspected after a latest valid match");

	const latestMalformed = makeRestoreTarget();
	latestMalformed.restoreFromEntries([
		cacheStateEntry(valid),
		cacheStateEntry({ ...valid, usage: "malformed-latest" }),
	]);
	assert.equal(latestMalformed.snapshot().requestCount, 0);
	assert.equal(latestMalformed.snapshot().cumulativeSemanticStatus, null);
	assert.equal(latestMalformed.statusSegment(), undefined);
});

test("restored state and returned snapshots are detached from untrusted references", async () => {
	const valid = await validCacheStateData();
	const restored = makeRestoreTarget();
	restored.restoreFromEntries([cacheStateEntry(valid)]);
	const hostileUsage = valid.usage as Record<string, unknown>;
	hostileUsage.cost = Number.NaN;
	hostileUsage.cacheRead = -1;
	const firstSnapshot = restored.snapshot();
	assert.equal(firstSnapshot.usage.cost, 0.001);
	assert.equal(firstSnapshot.usage.cacheRead, 40000);
	firstSnapshot.usage.cost = Number.NaN;
	firstSnapshot.usage.cacheRead = -1;
	const secondSnapshot = restored.snapshot();
	assert.equal(secondSnapshot.usage.cost, 0.001);
	assert.equal(secondSnapshot.usage.cacheRead, 40000);
	assert.doesNotMatch(renderCacheStatus(secondSnapshot).join("\n"), /NaN|Infinity/);
});

test("restoring entries from a DIFFERENT session id marks NEW_SESSION", async () => {
	const { telemetry, entries } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	telemetry.flush();
	const restored = createCacheTelemetry({ now: () => BASE_TIME, appendEntry: () => {} });
	restored.setProjectRoot("/tmp/irrelevant");
	restored.setSessionId("session-file-B");
	restored.restoreFromEntries(entries);
	const record = await restored.observeMessageEnd(baseFacts());
	assert.ok(record);
	assert.equal(record.inferredInvalidationReason, "NEW_SESSION");
});

test("telemetry failure never throws and never blocks (untrusted store)", async () => {
	const telemetry = createCacheTelemetry({ now: () => BASE_TIME, appendEntry: () => {} });
	// no project root set — observeMessageEnd must degrade to null, not throw
	const record = await telemetry.observeMessageEnd(baseFacts());
	assert.equal(record, null);
	// flush with a throwing appendEntry must not throw either
	telemetry.flush();
});

test("telemetry append gaps remain unverified until one durable marker succeeds", async () => {
	await withTempDir(async (dir) => {
		const entries: CacheStateEntryLike[] = [];
		const telemetry = createCacheTelemetry({
			now: () => BASE_TIME,
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		});
		telemetry.setProjectRoot(dir);
		telemetry.setSessionId("session-file-A");
		telemetry.setMode("DEV");
		telemetry.setThinkingLevel("high");
		const payload = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "same" }] };

		telemetry.observePayload(payload);
		const initial = await telemetry.observeMessageEnd(baseFacts());
		assert.ok(initial);
		assert.equal(initial.usageSemanticStatus, "verified");

		// Preserve the existing telemetry directory, then replace .pi with a
		// regular file so CacheStore.appendRecord deterministically returns
		// {ok:false}. Restoring the directory later exercises a real retry.
		const configDir = join(dir, ".pi");
		const savedConfigDir = join(dir, ".pi.saved");
		await rename(configDir, savedConfigDir);
		await writeFile(configDir, "blocked", "utf8");

		telemetry.observeCompaction();
		telemetry.observePayload(payload);
		const firstFailure = await telemetry.observeMessageEnd(baseFacts());
		assert.ok(firstFailure, "append failure is contained and still advances the observed request");
		assert.equal(firstFailure.inferredInvalidationReason, "COMPACTION");
		assert.equal(firstFailure.precedingEvent, "telemetry_write_gap");
		assert.equal(firstFailure.usageSemanticStatus, "unverified");
		assert.equal(firstFailure.cacheHitRatio, null);

		telemetry.observePayload(payload);
		const retryFailure = await telemetry.observeMessageEnd(baseFacts());
		assert.ok(retryFailure);
		assert.equal(retryFailure.precedingEvent, "telemetry_write_gap", "a failed retry keeps the bounded marker pending");
		assert.equal(retryFailure.inferredInvalidationReason, "UNKNOWN", "the consumed compaction flag is not replayed");
		assert.equal(retryFailure.usageSemanticStatus, "unverified");

		const failedSnapshot = telemetry.snapshot();
		assert.equal(failedSnapshot.requestCount, 3, "successful and failed persistence attempts all represent real provider requests");
		assert.equal(failedSnapshot.usage.input, 30000);
		assert.equal(failedSnapshot.usage.cacheRead, 120000);
		assert.equal(failedSnapshot.lastRequestSemanticStatus, "unverified");
		assert.equal(failedSnapshot.lastRequestHitRatio, null);
		assert.equal(failedSnapshot.cumulativeSemanticStatus, "unverified");
		assert.equal(failedSnapshot.cumulativeHitRatio, null);
		assert.equal(telemetry.statusSegment(), "CACHE last=N/A cum=N/A | read 120k | miss 30k");
		const failedState = entries.at(-1)?.data as { requestCount?: number; usageSemanticStatus?: string };
		assert.equal(failedState.requestCount, 3);
		assert.equal(failedState.usageSemanticStatus, "unverified", "the session entry remains honest even with no later JSONL success");

		await unlink(configDir);
		await rename(savedConfigDir, configDir);
		telemetry.observePayload(payload);
		const recovered = await telemetry.observeMessageEnd(baseFacts());
		assert.ok(recovered);
		assert.equal(recovered.precedingEvent, "telemetry_write_gap");
		assert.equal(recovered.usageSemanticStatus, "unverified");
		assert.equal(recovered.cacheHitRatio, null);
		assert.equal(recovered.inferredInvalidationReason, "UNKNOWN", "a write gap is data quality, not an invalidation reason");

		const durable = await new CacheStore(dir).readRecords();
		assert.equal(durable.skipped, 0);
		assert.equal(durable.records.length, 2, "the two failed observations are absent and bounded by one durable marker");
		const durableMarker = durable.records[1];
		assert.ok(isTelemetryRecord(durableMarker));
		assert.equal(durableMarker.precedingEvent, "telemetry_write_gap");
		assert.equal(durableMarker.usageSemanticStatus, "unverified");

		telemetry.observePayload(payload);
		const afterGap = await telemetry.observeMessageEnd(baseFacts());
		assert.ok(afterGap);
		assert.equal(afterGap.precedingEvent, "before_provider_request", "one successful marker clears the pending gap");
		assert.equal(afterGap.usageSemanticStatus, "verified");
		assert.equal(afterGap.cacheHitRatio, 0.8);
		assert.equal(telemetry.snapshot().requestCount, 5);
		assert.equal(telemetry.snapshot().cumulativeSemanticStatus, "unverified", "later successes cannot re-verify a gapped session aggregate");
	});
});

test("telemetry append gap survives session-state restore and marks the next durable record", async () => {
	await withTempDir(async (dir) => {
		const entries: CacheStateEntryLike[] = [];
		const telemetry = createCacheTelemetry({
			now: () => BASE_TIME,
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		});
		telemetry.setProjectRoot(dir);
		telemetry.setSessionId("session-file-A");
		telemetry.setMode("DEV");
		telemetry.observePayload({ messages: [] });
		assert.ok(await telemetry.observeMessageEnd(baseFacts()));

		const configDir = join(dir, ".pi");
		const savedConfigDir = join(dir, ".pi.saved");
		await rename(configDir, savedConfigDir);
		await writeFile(configDir, "blocked", "utf8");
		telemetry.observePayload({ messages: [] });
		const failed = await telemetry.observeMessageEnd(baseFacts());
		assert.ok(failed);
		const failedState = entries.at(-1)?.data as {
			requestCount?: number;
			usageSemanticStatus?: string;
			telemetryWriteGapPending?: number;
		};
		assert.equal(failedState.requestCount, 2);
		assert.equal(failedState.usageSemanticStatus, "unverified");
		assert.equal(failedState.telemetryWriteGapPending, 1);

		const restartedEntries: CacheStateEntryLike[] = [];
		const restarted = createCacheTelemetry({
			now: () => BASE_TIME,
			appendEntry: (customType, data) => restartedEntries.push({ type: "custom", customType, data }),
		});
		restarted.setProjectRoot(dir);
		restarted.setSessionId("session-file-A");
		restarted.setMode("DEV");
		restarted.restoreFromEntries(entries);
		assert.equal(restarted.snapshot().requestCount, 2, "strict restore retains the failed request accounting");
		assert.equal(restarted.snapshot().cumulativeSemanticStatus, "unverified");

		await unlink(configDir);
		await rename(savedConfigDir, configDir);
		restarted.observePayload({ messages: [] });
		const recovered = await restarted.observeMessageEnd(baseFacts());
		assert.ok(recovered);
		assert.equal(recovered.precedingEvent, "telemetry_write_gap");
		assert.equal(recovered.usageSemanticStatus, "unverified");
		assert.equal(recovered.cacheHitRatio, null);
		assert.equal((restartedEntries.at(-1)?.data as { telemetryWriteGapPending?: number }).telemetryWriteGapPending, 0);

		const durable = await new CacheStore(dir).readRecords();
		assert.equal(durable.records.length, 2);
		const durableRecords = durable.records.filter(isTelemetryRecord);
		assert.equal(durableRecords.length, durable.records.length, "CacheStore returned only strict telemetry records");
		assert.equal(durableRecords[1]?.precedingEvent, "telemetry_write_gap");
		const report = buildCacheReport(durableRecords, "project", () => ({ cacheRead: 0.0028 }));
		assert.equal(report.sourceIncomplete, true);
		assert.equal(report.hitRatio, null);
		assert.equal(report.estimatedAvoidedCost, null);
	});
});

test("messageStatus reflects error stop reasons", async () => {
	const { telemetry } = makeHarness();
	const record = await telemetry.observeMessageEnd(baseFacts({ stopReason: "error", errorMessage: "boom" }));
	assert.ok(record);
	assert.equal(record.messageStatus, "error");
});

test("hash-only record: full telemetry schema is present and minimal", async () => {
	const { telemetry } = makeHarness();
	const record = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(record);
	const expectedKeys = [
		"schemaVersion",
		"timestamp",
		"extensionVersion",
		"hashedSessionId",
		"provider",
		"model",
		"apiKind",
		"thinkingLevel",
		"workbenchMode",
		"messageStatus",
		"usage",
		"usageSemanticStatus",
		"cacheHitRatio",
		"promptInputTokens",
		"cacheReadShare",
		"cacheWriteShare",
		"cacheWriteStatusCode",
		"actorRoleCode",
		"requestCorrelationCode",
		"historyProjection",
		"wireObservation",
		"systemPromptHash",
		"activeToolNamesHash",
		"activeToolOrderHash",
		"activeToolSchemaHash",
		"contextShapeHash",
		"precedingEvent",
		"inferredInvalidationReason",
		"inferenceConfidence",
		"driftSource",
	];
	assert.deepEqual(Object.keys(record).sort(), expectedKeys.sort());
	assert.deepEqual(Object.keys(record.usage).sort(), ["cacheRead", "cacheWrite", "cost", "input", "output", "totalTokens"].sort());
	assert.equal(record.schemaVersion, "1.3");
	assert.equal(record.promptInputTokens, 50_000);
	assert.equal(record.cacheReadShare, 0.8);
	assert.equal(record.cacheWriteShare, null);
	assert.equal(record.cacheWriteStatusCode, 1);
	assert.equal(record.actorRoleCode, 0);
	assert.equal(record.requestCorrelationCode, 0);
	assert.equal(record.historyProjection, null);
	assert.equal(record.wireObservation, null);
	assert.equal(Object.hasOwn(record, "historyProjectionSegmentHash"), false);
	assert.equal(Object.hasOwn(record, "historyProjectionMarker"), false);
});

test("telemetry 1.3 correlates one context, one local provider observation, and one message_end", async () => {
	const { telemetry } = makeHarness();
	telemetry.observeContextProjection({ actorRoleCode: 1, historyProjection: PROJECTION_ANATOMY });
	telemetry.observePayload({ messages: [{ role: "user", content: "A🙂" }] });
	const first = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(first);
	assert.equal(first.requestCorrelationCode, 1);
	assert.equal(first.actorRoleCode, 1);
	assert.equal(first.historyProjection?.contextSerial, 1);
	assert.equal(first.wireObservation?.requestSerial, 1);
	assert.equal(first.wireObservation?.finalityCode, 0, "this hook is local observation, never claimed as final actual wire");
	assert.equal(first.wireObservation?.itemLcpCount, 0);

	telemetry.observeContextProjection({
		actorRoleCode: 2,
		historyProjection: {
			...PROJECTION_ANATOMY,
			eventCode: 0,
			causeCode: 0,
			epochTransitioned: 0,
			segmentSealed: 0,
			byteOverflow: 0,
			bundleOverflow: 0,
			segmentsAfter: PROJECTION_ANATOMY.segmentsBefore,
		},
	});
	telemetry.observePayload({ messages: [{ role: "user", content: "A🙂" }, { role: "assistant", content: "next" }] });
	const second = await telemetry.observeMessageEnd(baseFacts({ provider: "openai-codex", apiKind: "openai-codex-responses" }));
	assert.ok(second);
	assert.equal(second.requestCorrelationCode, 1);
	assert.equal(second.actorRoleCode, 2);
	assert.equal(second.historyProjection?.contextSerial, 2);
	assert.equal(second.wireObservation?.requestSerial, 2);
	assert.equal(second.wireObservation?.relationshipCode, 2);
	assert.equal(second.wireObservation?.itemLcpCount, 1);
	assert.equal(second.wireObservation?.itemLcpUtf8Bytes, 9);
	assert.equal(isTelemetryRecord(second), true);
});

test("telemetry 1.3 correlation fails closed for multiple, stale, and missing request events", async () => {
	const { telemetry } = makeHarness();
	telemetry.observeContextProjection({ actorRoleCode: 1, historyProjection: PROJECTION_ANATOMY });
	telemetry.observeContextProjection({ actorRoleCode: 1, historyProjection: PROJECTION_ANATOMY });
	telemetry.observePayload({ messages: [] });
	const multiple = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(multiple);
	assert.equal(multiple.requestCorrelationCode, 2);
	assert.equal(multiple.historyProjection, null);

	telemetry.observeContextProjection({ actorRoleCode: 2, historyProjection: PROJECTION_ANATOMY });
	const missing = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(missing);
	assert.equal(missing.requestCorrelationCode, 3);
	assert.equal(missing.historyProjection, null);
	assert.equal(missing.wireObservation, null);
});

test("telemetry writer rejects semantically impossible projection anatomy before request correlation", async () => {
	const { telemetry } = makeHarness();
	telemetry.observeContextProjection({
		actorRoleCode: 1,
		historyProjection: { ...PROJECTION_ANATOMY, eventCode: 2, causeCode: 3 },
	});
	telemetry.observePayload({ messages: [] });
	const record = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(record);
	assert.equal(record.requestCorrelationCode, 2);
	assert.equal(record.actorRoleCode, 0);
	assert.equal(record.historyProjection, null);
	assert.equal(isTelemetryRecord(record), true, "the fail-closed writer still emits a strict record");
});

test("strict telemetry reader accepts exact 1.0-1.3 shapes and rejects hostile 1.3 nested facts", async () => {
	const { telemetry } = makeHarness();
	const current = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(current);
	assert.equal(isTelemetryRecord(current), true);

	const {
		actorRoleCode: _actorRoleCode,
		requestCorrelationCode: _requestCorrelationCode,
		historyProjection: _historyProjection,
		wireObservation: _wireObservation,
		promptInputTokens: _promptInputTokens,
		cacheReadShare: _cacheReadShare,
		cacheWriteShare: _cacheWriteShare,
		cacheWriteStatusCode: _cacheWriteStatusCode,
		...preV1_3
	} = current;
	const v1_2 = { ...preV1_3, schemaVersion: "1.2" };
	assert.equal(isTelemetryRecord(v1_2), true);
	const v1_1 = { ...preV1_3, schemaVersion: "1.1" };
	assert.equal(isTelemetryRecord(v1_1), true);
	const { driftSource: _legacyDriftSource, ...withoutDriftSource } = preV1_3;
	const v1_0 = { ...withoutDriftSource, schemaVersion: "1.0" };
	assert.equal(isTelemetryRecord(v1_0), true);
	const segmentSealed = {
		...current,
		inferredInvalidationReason: "HISTORY_PROJECTION_SEGMENT_SEALED",
		inferenceConfidence: "high",
	};
	assert.equal(isTelemetryRecord(segmentSealed), true);
	assert.equal(isTelemetryRecord({ ...v1_2, inferredInvalidationReason: "HISTORY_PROJECTION_SEGMENT_SEALED" }), true);
	assert.equal(isTelemetryRecord({ ...v1_1, inferredInvalidationReason: "HISTORY_PROJECTION_SEGMENT_SEALED" }), false);
	const {
		driftSource: _segmentLegacyDrift,
		...segmentLegacy
	} = { ...v1_1, inferredInvalidationReason: "HISTORY_PROJECTION_SEGMENT_SEALED" };
	assert.equal(isTelemetryRecord({ ...segmentLegacy, schemaVersion: "1.0" }), false);

	assert.equal(isTelemetryRecord({ ...current, schemaVersion: "1.4" }), false);
	assert.equal(isTelemetryRecord({ ...v1_0, driftSource: null }), false, "1.0 keeps its exact legacy key set");
	const { driftSource: _removed, ...missingCurrentField } = v1_1;
	assert.equal(isTelemetryRecord(missingCurrentField), false, "1.1 requires the driftSource field");
	assert.equal(isTelemetryRecord({ ...current, historyProjectionSegmentHash: "secret" }), false, "1.2 rejects marker/hash expansion");
	assert.equal(isTelemetryRecord({ ...current, wireObservation: { requestSerial: 1, finalityCode: 1 } }), false);
	const hostileProjection = Object.create(null) as Record<string, unknown>;
	Object.assign(hostileProjection, { ...PROJECTION_ANATOMY, contextSerial: 1, extra: 1 });
	assert.equal(isTelemetryRecord({ ...current, requestCorrelationCode: 1, historyProjection: hostileProjection }), false);
	const accessor = { ...current } as Record<string, unknown>;
	Object.defineProperty(accessor, "promptInputTokens", { enumerable: true, get: () => 50_000 });
	assert.equal(isTelemetryRecord(accessor), false);
});

test("precedingEvent tracks the last observed Pi event", async () => {
	const { telemetry } = makeHarness();
	telemetry.observeCompaction();
	telemetry.observePayload({ model: "x", messages: [] });
	const record = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(record);
	assert.equal(record.precedingEvent, "before_provider_request");
});

test("formatTokens compact rendering", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1000), "1k");
	assert.equal(formatTokens(71234), "71k");
	assert.equal(formatTokens(184321), "184k");
	assert.equal(formatTokens(1845321), "1.8M");
});
