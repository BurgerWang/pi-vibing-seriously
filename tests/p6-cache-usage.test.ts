/**
 * P6-A usage semantics tests — the mapping between DeepSeek's raw usage
 * fields and Pi's normalized usage, and the cacheHitRatio rules.
 *
 * The raw -> normalized conversions below replicate Pi 0.83.0's documented
 * adapter math (verified in the installed source):
 *
 *   - openai-completions (pi's built-in deepseek provider):
 *       input      = max(0, prompt_tokens - cacheRead - cacheWrite)
 *       cacheRead  = prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens
 *       cacheWrite = prompt_tokens_details.cache_write_tokens (DeepSeek: absent -> 0)
 *       output     = completion_tokens
 *     DeepSeek's real API reports prompt_cache_hit_tokens /
 *     prompt_cache_miss_tokens at the top level, so usage.input ends up as
 *     the cache-miss portion and cacheRead as the cache-hit portion.
 *
 *   - openai-responses:
 *       input      = max(0, input_tokens - cached_tokens - cache_write_tokens)
 *       cacheRead  = input_tokens_details.cached_tokens
 *       totalTokens = raw total_tokens
 *
 *   - openai-codex-responses: the Codex provider streams through the same
 *     openai-responses-shared finalizeResponse mapping, so the raw ->
 *     normalized conversion is identical to openai-responses.
 *
 * The runtime itself never parses raw payloads — it consumes Pi's
 * normalized usage and only computes a ratio for api kinds whose semantics
 * are confirmed (VERIFIED_API_KINDS).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	cacheHitRatioFromTotals,
	verifyUsageSemantics,
	type PiUsageLike,
} from "../extensions/workbench-runtime/cache/cache-types.ts";

/** Pi's openai-completions parseChunkUsage mapping (see pi-ai dist/api/openai-completions.js). */
function normalizeChatCompletions(raw: {
	prompt_tokens: number;
	prompt_cache_hit_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	completion_tokens: number;
}): PiUsageLike {
	const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0;
	const cacheWrite = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
	const input = Math.max(0, raw.prompt_tokens - cacheRead - cacheWrite);
	const output = raw.completion_tokens;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { total: 0.00123 },
	};
}

/** Pi's openai-responses finalizeResponse mapping (pi-ai dist/api/openai-responses-shared.js). */
function normalizeResponses(raw: {
	input_tokens: number;
	input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	output_tokens: number;
	total_tokens: number;
}): PiUsageLike {
	const cached = raw.input_tokens_details?.cached_tokens ?? 0;
	const cacheWrite = raw.input_tokens_details?.cache_write_tokens ?? 0;
	const input = Math.max(0, raw.input_tokens - cached - cacheWrite);
	return {
		input,
		output: raw.output_tokens,
		cacheRead: cached,
		cacheWrite,
		totalTokens: raw.total_tokens,
		cost: { total: 0.00042 },
	};
}

/**
 * Pi's openai-codex-responses stream (pi-ai dist/api/openai-codex-responses.js)
 * calls processResponsesStream from openai-responses-shared, so Codex raw
 * Responses payloads normalize through the exact same finalizeResponse
 * mapping as openai-responses.
 */
function normalizeCodexResponses(raw: {
	input_tokens: number;
	input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	output_tokens: number;
	total_tokens: number;
}): PiUsageLike {
	return normalizeResponses(raw);
}

test("DeepSeek Chat Completions usage fixture maps to Pi normalized usage", () => {
	// DeepSeek API: prompt_tokens = hit + miss; hit reported top-level.
	const raw = { prompt_tokens: 50000, prompt_cache_hit_tokens: 40000, prompt_cache_miss_tokens: 10000, completion_tokens: 2000 };
	const usage = normalizeChatCompletions(raw);
	assert.equal(usage.input, 10000, "input = the cache-miss (uncached) portion");
	assert.equal(usage.cacheRead, 40000, "cacheRead = prompt_cache_hit_tokens");
	assert.equal(usage.cacheWrite, 0, "DeepSeek does not report cache writes");
	assert.equal(usage.output, 2000);
	assert.equal(usage.totalTokens, 52000);
	const semantics = verifyUsageSemantics("openai-completions", usage);
	assert.equal(semantics.status, "verified");
	assert.equal(semantics.cacheHitRatio, 40000 / (10000 + 40000));
});

test("DeepSeek Chat Completions fixture with prompt_tokens_details.cached_tokens", () => {
	const raw = {
		prompt_tokens: 8000,
		prompt_tokens_details: { cached_tokens: 6000 },
		completion_tokens: 300,
	};
	const usage = normalizeChatCompletions(raw);
	assert.equal(usage.input, 2000);
	assert.equal(usage.cacheRead, 6000);
	const semantics = verifyUsageSemantics("openai-completions", usage);
	assert.equal(semantics.status, "verified");
	assert.equal(semantics.cacheHitRatio, 0.75);
});

test("DeepSeek Responses usage fixture maps to Pi normalized usage", () => {
	const raw = {
		input_tokens: 50000,
		input_tokens_details: { cached_tokens: 40000 },
		output_tokens: 2000,
		total_tokens: 52000,
	};
	const usage = normalizeResponses(raw);
	assert.equal(usage.input, 10000, "responses: input excludes cached tokens");
	assert.equal(usage.cacheRead, 40000);
	assert.equal(usage.output, 2000);
	assert.equal(usage.totalTokens, 52000);
	const semantics = verifyUsageSemantics("openai-responses", usage);
	assert.equal(semantics.status, "verified");
	assert.equal(semantics.cacheHitRatio, 0.8);
});

test("Codex Responses raw usage fixture is verified with Responses semantics and exact ratio", () => {
	// OpenAI Codex reports cached tokens inside input_tokens_details; Pi
	// normalizes the Codex stream through openai-responses-shared, so
	// usage.input is the un-cached portion and cacheRead the cached portion.
	const raw = {
		input_tokens: 50000,
		input_tokens_details: { cached_tokens: 40000, cache_write_tokens: 0 },
		output_tokens: 2000,
		total_tokens: 52000,
	};
	const usage = normalizeCodexResponses(raw);
	assert.equal(usage.input, 10000, "codex: input excludes cached tokens");
	assert.equal(usage.cacheRead, 40000);
	assert.equal(usage.cacheWrite, 0);
	assert.equal(usage.output, 2000);
	assert.equal(usage.totalTokens, 52000);
	const semantics = verifyUsageSemantics("openai-codex-responses", usage);
	assert.equal(semantics.status, "verified", "openai-codex-responses uses verified Responses semantics");
	assert.equal(semantics.cacheHitRatio, 40000 / (10000 + 40000), "exact ratio cacheRead/(input+cacheRead)");
});

test("Pi normalized usage fixture (as delivered on assistant messages)", () => {
	const usage: PiUsageLike = {
		input: 12345,
		output: 678,
		cacheRead: 45678,
		cacheWrite: 0,
		totalTokens: 12345 + 678 + 45678 + 0,
		cost: { total: 0.0005321 },
	};
	const semantics = verifyUsageSemantics("openai-completions", usage);
	assert.equal(semantics.status, "verified");
	assert.equal(semantics.cacheHitRatio, 45678 / (12345 + 45678));
});

test("verified hit ratio: cacheRead / (input + cacheRead)", () => {
	assert.equal(cacheHitRatioFromTotals({ input: 3000, cacheRead: 7000 }), 0.7);
	assert.equal(cacheHitRatioFromTotals({ input: 0, cacheRead: 500 }), 1);
});

test("zero denominator yields null, never NaN or Infinity", () => {
	assert.equal(cacheHitRatioFromTotals({ input: 0, cacheRead: 0 }), null);
	assert.equal(verifyUsageSemantics("openai-completions", {
		input: 0,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { total: 0 },
	}).cacheHitRatio, null);
});

test("cacheWrite=0 is not an error and does not invalidate semantics", () => {
	const usage: PiUsageLike = {
		input: 1000,
		output: 100,
		cacheRead: 9000,
		cacheWrite: 0,
		totalTokens: 10100,
		cost: { total: 0.0001 },
	};
	const semantics = verifyUsageSemantics("openai-completions", usage);
	assert.equal(semantics.status, "verified");
	assert.equal(semantics.cacheHitRatio, 0.9);
});

test("unknown api kind degrades to partial, never guesses a ratio", () => {
	const usage: PiUsageLike = { input: 1000, output: 100, cacheRead: 9000, cacheWrite: 0, totalTokens: 10100, cost: { total: 0.01 } };
	const semantics = verifyUsageSemantics("my-custom-provider-api", usage);
	assert.equal(semantics.status, "partial");
	assert.equal(semantics.cacheHitRatio, null, "no ratio without confirmed semantics");
});

test("unverified semantics: negative or non-finite usage fields", () => {
	const base = { output: 100, cacheRead: 9000, cacheWrite: 0, totalTokens: 10100, cost: { total: 0.01 } };
	assert.equal(verifyUsageSemantics("openai-completions", { ...base, input: -1 }).status, "unverified");
	assert.equal(verifyUsageSemantics("openai-completions", { ...base, input: Number.NaN }).status, "unverified");
	assert.equal(verifyUsageSemantics("openai-completions", { ...base, input: Number.POSITIVE_INFINITY }).status, "unverified");
	assert.equal(verifyUsageSemantics("openai-completions", { ...base, input: 1000, cost: { total: Number.NaN } }).status, "unverified");
});

test("unverified semantics: totalTokens inconsistent with the components", () => {
	const usage: PiUsageLike = { input: 1000, output: 100, cacheRead: 9000, cacheWrite: 0, totalTokens: 500, cost: { total: 0.01 } };
	const semantics = verifyUsageSemantics("openai-completions", usage);
	assert.equal(semantics.status, "unverified");
	assert.equal(semantics.cacheHitRatio, null);
});

test("missing usage is unverified", () => {
	const semantics = verifyUsageSemantics("openai-completions", undefined);
	assert.equal(semantics.status, "unverified");
	assert.equal(semantics.cacheHitRatio, null);
});

test("cost metadata missing: usage cost stays the fact, ratio unaffected", () => {
	// A zero/missing registry rate never affects the per-request ratio; it
	// only voids the estimated avoided cost at report time.
	const usage: PiUsageLike = { input: 5000, output: 200, cacheRead: 15000, cacheWrite: 0, totalTokens: 20200, cost: { total: 0 } };
	const semantics = verifyUsageSemantics("openai-completions", usage);
	assert.equal(semantics.status, "verified");
	assert.equal(semantics.cacheHitRatio, 0.75);
});

test("cost metadata currency/unit unknown: no estimate is fabricated", () => {
	// This is enforced by the report rate lookup (cache-report.ts): a lookup
	// returning no rate or a non-finite rate voids the estimate. The unit
	// contract is "same USD-per-1M-token rates Pi uses for usage.cost".
	const usage: PiUsageLike = { input: 5000, output: 200, cacheRead: 15000, cacheWrite: 0, totalTokens: 20200, cost: { total: 0.0042 } };
	assert.equal(verifyUsageSemantics("openai-completions", usage).status, "verified");
});
