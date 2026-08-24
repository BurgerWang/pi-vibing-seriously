import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCostBreakdown } from "../extensions/workbench-runtime/core/cost-breakdown.ts";
import { RuntimeCostBreakdownCache } from "../extensions/workbench-runtime/core/runtime-cost-breakdown-cache.ts";

function assistant(timestamp: number, input: number): Record<string, unknown> {
	return {
		type: "message",
		message: {
			role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", timestamp,
			usage: { input, output: 1, cacheRead: 2, cacheWrite: 0, cost: { total: input / 1_000 } },
		},
	};
}

test("runtime cost cache is exact while append-only refresh work stays linear", () => {
	const cache = new RuntimeCostBreakdownCache();
	const entries: unknown[] = [];
	for (let index = 0; index < 2_000; index += 1) {
		entries.push(assistant(index, index + 1));
		assert.deepEqual(cache.read(entries), buildCostBreakdown(entries));
	}
	assert.deepEqual(cache.inspectWork(), { scannedEntries: 2_000, rebuilds: 0 });
});

test("pending messages count once before and after persistence and branch replacement rebuilds", () => {
	const cache = new RuntimeCostBreakdownCache();
	const first = assistant(1, 10);
	const pending = (assistant(2, 20).message ?? {}) as Record<string, unknown>;
	assert.deepEqual(cache.read([first], pending), buildCostBreakdown([first], pending));
	const persisted = { type: "message", message: pending };
	assert.deepEqual(cache.read([first, persisted], pending), buildCostBreakdown([first, persisted], pending));
	const laterEntry = assistant(4, 40);
	assert.deepEqual(
		cache.read([first, persisted, laterEntry], pending),
		buildCostBreakdown([first, persisted, laterEntry], pending),
		"a persisted pending message remains deduplicated after later entries append",
	);
	const replacement = [assistant(3, 30)];
	assert.deepEqual(cache.read(replacement), buildCostBreakdown(replacement));
	assert.deepEqual(cache.inspectWork(), { scannedEntries: 4, rebuilds: 1 });
});

test("incremental merges preserve mixed buckets, stable model order, compactions, and tool bytes", () => {
	const usage = (input: number, total: number) => ({ input, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total } });
	const entries: unknown[] = [
		assistant(1, 10),
		{ type: "message", message: { role: "toolResult", toolName: "workbench_delegate_worker", content: "worker", usage: usage(20, 0.2) } },
		{ type: "compaction", usage: usage(30, 0.3) },
		{ type: "message", message: { role: "assistant", provider: "other", model: "equal-cost", timestamp: 2, usage: usage(40, 0.01) } },
		{ type: "message", message: { role: "toolResult", toolName: "z-tool", content: [{ type: "text", text: "α" }], usage: usage(50, 0.5) } },
	];
	const cache = new RuntimeCostBreakdownCache();
	const prefix: unknown[] = [];
	for (const entry of entries) {
		prefix.push(entry);
		assert.deepEqual(cache.read(prefix), buildCostBreakdown(prefix));
	}
	assert.deepEqual(cache.inspectWork(), { scannedEntries: entries.length, rebuilds: 0 });
});

test("batch boundaries preserve the reference floating-point addition order", () => {
	const entries = [assistant(1, 100), assistant(2, 200), assistant(3, 300)];
	const cache = new RuntimeCostBreakdownCache();
	cache.read(entries.slice(0, 1));
	assert.deepEqual(cache.read(entries), buildCostBreakdown(entries));
	assert.equal(cache.read(entries).commander.cost, 0.1 + 0.2 + 0.3);
});
