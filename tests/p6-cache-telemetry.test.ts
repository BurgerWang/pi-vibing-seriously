/**
 * P6-A telemetry tests — event observation, invalidation classification,
 * record contents, payload read-only guarantee, status segment, graceful
 * fallback for non-DeepSeek providers, and session state persistence.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	createCacheTelemetry,
	formatTokens,
	type CacheStateEntryLike,
	type CacheTelemetry,
	type MessageEndFacts,
} from "../extensions/workbench-runtime/cache/cache-telemetry.ts";
import { invalidationClass, type CacheInvalidationReason } from "../extensions/workbench-runtime/cache/invalidation-classifier.ts";
import { hasForbiddenTelemetryFields } from "../extensions/workbench-runtime/cache/cache-store.ts";
import { withTempDir } from "./helpers.ts";

const BASE_TIME = 1_700_000_000_000;

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
	for (const reason of ["FIRST_OBSERVED_REQUEST", "NEW_SESSION", "MODEL_CHANGED", "THINKING_LEVEL_CHANGED", "MODE_CHANGED", "PACKAGE_RELOADED", "COMPACTION", "PROVIDER_BEST_EFFORT_MISS"]) {
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

test("context prefix divergence: payload shape changed, fingerprints stable", async () => {
	const { telemetry } = makeHarness();
	telemetry.observePayload({ model: "deepseek-v4-flash", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }], stream: true });
	const first = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(first);
	assert.ok(first.contextShapeHash, "contextShapeHash from the payload summary");
	telemetry.observePayload({ model: "deepseek-v4-flash", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }, { role: "assistant", content: "hi" }], stream: true });
	const second = await telemetry.observeMessageEnd(baseFacts());
	assert.ok(second);
	assert.equal(second.inferredInvalidationReason, "CONTEXT_PREFIX_DIVERGED");
	assert.notEqual(first.contextShapeHash, second.contextShapeHash);
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
	assert.equal(telemetry.statusSegment(), "CACHE 80% | read 40k | miss 10k");
	// unverified semantics -> N/A
	const { telemetry: telemetry2 } = makeHarness();
	await telemetry2.observeMessageEnd(baseFacts({ apiKind: "unknown-api", usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } } }));
	assert.equal(telemetry2.statusSegment(), "CACHE N/A");
});

test("no-UI mode: telemetry is pure data, works without any UI context", async () => {
	const { telemetry } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	const snapshot = telemetry.snapshot();
	assert.equal(snapshot.requestCount, 1);
	assert.equal(snapshot.semanticStatus, "verified");
	assert.equal(snapshot.hitRatio, 0.8);
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
	assert.equal(telemetry.statusSegment(), "CACHE N/A");
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
	assert.equal(telemetry.statusSegment(), "CACHE 80% | read 40k | miss 10k", "numeric CACHE footer, not N/A");
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
	assert.equal(telemetry.statusSegment(), "CACHE N/A");
});

test("disabled telemetry records nothing", async () => {
	const { telemetry } = makeHarness();
	telemetry.setEnabled(false);
	const record = await telemetry.observeMessageEnd(baseFacts());
	assert.equal(record, null);
	assert.equal(telemetry.statusSegment(), undefined);
});

test("session state entry is lightweight and restored on session_start", async () => {
	const { telemetry, entries } = makeHarness();
	await telemetry.observeMessageEnd(baseFacts());
	await telemetry.observeMessageEnd(baseFacts());
	telemetry.flush();

	const stateEntries = entries.filter((e) => e.customType === "workbench-cache-state");
	assert.equal(stateEntries.length >= 1, true);
	const data = stateEntries[stateEntries.length - 1]?.data as {
		schemaVersion: string;
		requestCount: number;
		usage: { input: number; cost: number };
		lastHashes: Record<string, string>;
		lastInvalidationReason: string;
		telemetryFile: string;
	};
	assert.ok(data);
	assert.equal(data.schemaVersion, "1.1");
	assert.equal(data.requestCount, 2);
	assert.equal(data.usage.input, 20000);
	assert.equal(data.usage.cost, 0.002);
	assert.ok(data.lastHashes.systemPromptHash);
	assert.equal(data.lastInvalidationReason, "UNKNOWN");
	assert.equal(data.telemetryFile, ".pi/workbench/cache/telemetry.jsonl");
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
