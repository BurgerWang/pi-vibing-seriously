/**
 * Pinned worker context-budget tests (pure module).
 *
 * Covers the model-specific budget metadata (1,000,000 context tokens, 80%
 * soft handoff at 800,000, 90% hard stop at 900,000 — independent of the
 * Commander/project compaction reserve), the Pi-compatible context-token
 * calculation (positive totalTokens wins, otherwise the non-negative
 * input+output+cacheRead+cacheWrite sum), threshold boundaries, malformed
 * usage, the one-shot soft steer text, and the deterministic summary line.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	WORKER_HARD_BUDGET,
	WORKER_MODEL_CONTEXT_TOKENS,
	WORKER_SOFT_BUDGET,
	WORKER_SOFT_STEER_MESSAGE_TYPE,
	WORKER_SOFT_STEER_TEXT,
	formatWorkerBudgetSummary,
	workerBudgetBand,
	workerContextRatio,
	workerContextTokens,
} from "../extensions/workbench-runtime/core/worker-budget.ts";

test("pinned worker budget metadata: 1,000,000 context, 80% soft, 90% hard", () => {
	assert.equal(WORKER_MODEL_CONTEXT_TOKENS, 1_000_000);
	assert.equal(WORKER_SOFT_BUDGET, 800_000);
	assert.equal(WORKER_HARD_BUDGET, 900_000);
	assert.ok(WORKER_SOFT_BUDGET < WORKER_HARD_BUDGET, "soft below hard");
	assert.ok(WORKER_HARD_BUDGET < WORKER_MODEL_CONTEXT_TOKENS, "hard below the full window");
});

test("workerContextTokens prefers a positive totalTokens", () => {
	assert.equal(
		workerContextTokens({ totalTokens: 123_456, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
		123_456,
	);
	assert.equal(workerContextTokens({ totalTokens: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), 1);
});

test("workerContextTokens falls back to nonnegative input+output+cacheRead+cacheWrite", () => {
	assert.equal(workerContextTokens({ totalTokens: 0, input: 100, output: 200, cacheRead: 300, cacheWrite: 400 }), 1000);
	assert.equal(workerContextTokens({ totalTokens: -5, input: 100, output: 200, cacheRead: 300, cacheWrite: 400 }), 1000);
	assert.equal(workerContextTokens({ totalTokens: Number.NaN, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }), 100);
	assert.equal(workerContextTokens({ input: 10, output: 20 }), 30);
	assert.equal(workerContextTokens({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }), 100);
	assert.equal(workerContextTokens({}), 0);
});

test("malformed usage contributes zero — never NaN, never throws", () => {
	assert.equal(workerContextTokens(null), 0);
	assert.equal(workerContextTokens(undefined), 0);
	assert.equal(workerContextTokens("usage"), 0);
	assert.equal(workerContextTokens(42), 0);
	assert.equal(workerContextTokens([]), 0);
	assert.equal(workerContextTokens({ totalTokens: "big" }), 0);
	assert.equal(workerContextTokens({ totalTokens: Infinity, input: 5 }), 5);
	assert.equal(workerContextTokens({ input: -10, output: "x", cacheRead: Infinity, cacheWrite: 7 }), 7);
	assert.equal(workerContextTokens({ input: Number.NaN, output: 1.5, cacheRead: 2.5, cacheWrite: 0 }), 4);
	assert.equal(workerContextTokens({ input: -1, output: -1, cacheRead: -1, cacheWrite: -1 }), 0);
});

test("workerContextRatio is tokens / 1,000,000 and never NaN", () => {
	assert.equal(workerContextRatio(0), 0);
	assert.equal(workerContextRatio(WORKER_SOFT_BUDGET), 0.8);
	assert.equal(workerContextRatio(WORKER_HARD_BUDGET), 0.9);
	assert.equal(workerContextRatio(1_000_000), 1);
	assert.equal(workerContextRatio(1_100_000), 1.1);
	assert.equal(workerContextRatio(-1), 0);
	assert.equal(workerContextRatio(Number.NaN), 0);
	assert.equal(workerContextRatio(Infinity), 0);
});

test("workerBudgetBand boundaries: ok below 80%, soft at 80%, hard at 90%", () => {
	assert.equal(workerBudgetBand(0), "ok");
	assert.equal(workerBudgetBand(799_999), "ok");
	assert.equal(workerBudgetBand(WORKER_SOFT_BUDGET), "soft");
	assert.equal(workerBudgetBand(899_999), "soft");
	assert.equal(workerBudgetBand(WORKER_HARD_BUDGET), "hard");
	assert.equal(workerBudgetBand(900_001), "hard");
	assert.equal(workerBudgetBand(1_000_000), "hard");
	assert.equal(workerBudgetBand(Number.NaN), "ok");
	assert.equal(workerBudgetBand(-1), "ok");
});

test("soft steer message type and text instruct stop/handoff/remaining work", () => {
	assert.equal(WORKER_SOFT_STEER_MESSAGE_TYPE, "workbench-worker-soft-steer");
	const text = WORKER_SOFT_STEER_TEXT;
	assert.match(text, /stop/i);
	assert.match(text, /new implementation/i);
	assert.match(text, /handoff/i);
	assert.match(text, /remaining work/i);
	assert.ok(text.includes(String(WORKER_SOFT_BUDGET)), "steer names the soft threshold");
	assert.ok(text.length < 1000, "steer stays small and bounded");
});

test("budget summary formatter is deterministic", () => {
	assert.equal(formatWorkerBudgetSummary(800_000, 0.8), "max context 800000 / 1000000 (80%) | soft 800000 | hard 900000");
	assert.equal(formatWorkerBudgetSummary(0, 0), "max context 0 / 1000000 (0%) | soft 800000 | hard 900000");
	assert.equal(formatWorkerBudgetSummary(899_999, 0.899999), "max context 899999 / 1000000 (89.9%) | soft 800000 | hard 900000");
	assert.equal(formatWorkerBudgetSummary(812_345, 0.812345), "max context 812345 / 1000000 (81.2%) | soft 800000 | hard 900000");
	assert.equal(formatWorkerBudgetSummary(900_000, 0.9), "max context 900000 / 1000000 (90%) | soft 800000 | hard 900000");
	assert.equal(formatWorkerBudgetSummary(1_000_000, 1), "max context 1000000 / 1000000 (100%) | soft 800000 | hard 900000");
});

test("budget summary formatter defends against malformed inputs", () => {
	assert.equal(formatWorkerBudgetSummary(Number.NaN, Number.NaN), "max context 0 / 1000000 (0%) | soft 800000 | hard 900000");
	assert.equal(formatWorkerBudgetSummary(-1, -1), "max context 0 / 1000000 (0%) | soft 800000 | hard 900000");
	assert.equal(formatWorkerBudgetSummary(850_000, Number.NaN), "max context 850000 / 1000000 (85%) | soft 800000 | hard 900000");
});
