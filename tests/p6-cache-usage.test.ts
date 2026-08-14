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
	cacheUsageMetrics,
	cacheHitRatioFromTotals,
	isHistoryProjectionFacts,
	isTelemetryRecord,
	verifyUsageSemantics,
	type HistoryProjectionFacts,
	type PiUsageLike,
} from "../extensions/workbench-runtime/cache/cache-types.ts";

const BASE_PROJECTION_FACTS: HistoryProjectionFacts = {
	contextSerial: 1,
	eventCode: 0,
	causeCode: 0,
	epoch: 0,
	epochTransitioned: 0,
	segmentSealed: 0,
	byteOverflow: 0,
	bundleOverflow: 0,
	segmentsBefore: 0,
	segmentsAfter: 0,
	hardToolTextBytes: 1_000_000,
	hardBundles: 5_000,
	rawToolTextBytes: 50_000,
	rawBundles: 40,
	projectedToolTextBytes: 50_000,
	projectedBundles: 40,
	stableToolTextBytesBefore: 0,
	stableBundlesBefore: 0,
	activeToolTextBytesBefore: 50_000,
	activeBundlesBefore: 40,
	agedRawToolTextBytes: 0,
	agedRawBundles: 0,
	agedProjectedToolTextBytes: 0,
	agedProjectedBundles: 0,
	suffixRawToolTextBytes: 50_000,
	suffixRawBundles: 40,
};

function projectionMatrixCandidate(
	eventCode: HistoryProjectionFacts["eventCode"],
	causeCode: HistoryProjectionFacts["causeCode"],
): HistoryProjectionFacts {
	switch (eventCode) {
		case 0:
			return { ...BASE_PROJECTION_FACTS, eventCode, causeCode, segmentsBefore: 2, segmentsAfter: 2 };
		case 1:
			return { ...BASE_PROJECTION_FACTS, eventCode, causeCode, epoch: 1, epochTransitioned: 1, byteOverflow: 1 };
		case 2:
			return {
				...BASE_PROJECTION_FACTS,
				eventCode,
				causeCode,
				epoch: 7,
				segmentSealed: 1,
				byteOverflow: 1,
				segmentsBefore: 2,
				segmentsAfter: 3,
			};
		case 3:
			return {
				...BASE_PROJECTION_FACTS,
				eventCode,
				causeCode,
				epoch: 8,
				epochTransitioned: 1,
				byteOverflow: 1,
				segmentsBefore: causeCode === 7 ? 0 : 16,
			};
		case 4:
			return {
				...BASE_PROJECTION_FACTS,
				eventCode,
				causeCode,
				epoch: 8,
				epochTransitioned: 1,
				segmentsBefore: causeCode === 7 ? 0 : 2,
			};
		case 5:
			return {
				...BASE_PROJECTION_FACTS,
				eventCode,
				causeCode,
				epochTransitioned: 1,
				segmentsBefore: 2,
				projectedToolTextBytes: 0,
				projectedBundles: 0,
				agedRawToolTextBytes: 0,
				agedRawBundles: 0,
				agedProjectedToolTextBytes: 0,
				agedProjectedBundles: 0,
				suffixRawToolTextBytes: 0,
				suffixRawBundles: 0,
			};
		case 6:
			return { ...BASE_PROJECTION_FACTS, eventCode, causeCode, epochTransitioned: 1 };
	}
	throw new Error(`unreachable event code: ${eventCode}`);
}

test("history projection semantic validator exhaustively enforces the event/cause matrix", () => {
	const allowedPairs = new Set([
		"0:0",
		"1:1",
		"2:4",
		"3:2", "3:3", "3:5", "3:6", "3:7",
		"4:5", "4:6", "4:7",
		"5:8",
		"6:9",
	]);
	for (let eventCode = 0; eventCode <= 6; eventCode += 1) {
		for (let causeCode = 0; causeCode <= 9; causeCode += 1) {
			const facts = projectionMatrixCandidate(
				eventCode as HistoryProjectionFacts["eventCode"],
				causeCode as HistoryProjectionFacts["causeCode"],
			);
			assert.equal(
				isHistoryProjectionFacts(facts),
				allowedPairs.has(`${eventCode}:${causeCode}`),
				`event=${eventCode} cause=${causeCode}`,
			);
		}
	}
});

test("history projection semantic validator preserves every legitimate overflow and repeated-failure combination", () => {
	const validCause = [0, 1, 4, 2, 5, 8, 9] as const;
	const overflowPolicy = ["none", "required", "required", "required", "none", "any", "any"] as const;
	for (let eventCode = 0; eventCode <= 6; eventCode += 1) {
		for (const byteOverflow of [0, 1] as const) {
			for (const bundleOverflow of [0, 1] as const) {
				const facts = {
					...projectionMatrixCandidate(eventCode as HistoryProjectionFacts["eventCode"], validCause[eventCode]!),
					byteOverflow,
					bundleOverflow,
				};
				const expected = overflowPolicy[eventCode] === "any"
					|| (overflowPolicy[eventCode] === "none" ? byteOverflow === 0 && bundleOverflow === 0 : byteOverflow + bundleOverflow > 0);
				assert.equal(isHistoryProjectionFacts(facts), expected, `event=${eventCode} overflow=${byteOverflow}:${bundleOverflow}`);
			}
		}
	}

	assert.equal(isHistoryProjectionFacts({ ...projectionMatrixCandidate(5, 8), epochTransitioned: 0 }), true, "repeated failure remains valid");
	assert.equal(isHistoryProjectionFacts({ ...projectionMatrixCandidate(5, 8), epochTransitioned: 1 }), true, "first failure remains valid");
});

test("history projection semantic validator rejects impossible flags and segment transitions", () => {
	const invalid: Array<[string, HistoryProjectionFacts]> = [
		["none transitions epoch", { ...projectionMatrixCandidate(0, 0), epochTransitioned: 1 }],
		["none seals segment", { ...projectionMatrixCandidate(0, 0), segmentSealed: 1 }],
		["none changes segment count", { ...projectionMatrixCandidate(0, 0), segmentsAfter: 1 }],
		["initial does not transition", { ...projectionMatrixCandidate(1, 1), epochTransitioned: 0 }],
		["initial carries prior segment", { ...projectionMatrixCandidate(1, 1), segmentsBefore: 1 }],
		["initial leaves a segment", { ...projectionMatrixCandidate(1, 1), segmentsAfter: 1 }],
		["seal transitions epoch", { ...projectionMatrixCandidate(2, 4), epochTransitioned: 1 }],
		["seal flag absent", { ...projectionMatrixCandidate(2, 4), segmentSealed: 0 }],
		["seal does not append exactly one", { ...projectionMatrixCandidate(2, 4), segmentsAfter: 2 }],
		["seal exceeds fixed segment window", { ...projectionMatrixCandidate(2, 4), segmentsBefore: 16, segmentsAfter: 17 }],
		["checkpoint does not transition", { ...projectionMatrixCandidate(3, 2), epochTransitioned: 0 }],
		["checkpoint seals a segment", { ...projectionMatrixCandidate(3, 2), segmentSealed: 1 }],
		["checkpoint leaves segments", { ...projectionMatrixCandidate(3, 2), segmentsAfter: 1 }],
		["legacy checkpoint claims prior segments", { ...projectionMatrixCandidate(3, 7), segmentsBefore: 1 }],
		["inactive boundary does not transition", { ...projectionMatrixCandidate(4, 5), epochTransitioned: 0 }],
		["inactive boundary leaves segments", { ...projectionMatrixCandidate(4, 5), segmentsAfter: 1 }],
		["legacy inactive boundary claims prior segments", { ...projectionMatrixCandidate(4, 7), segmentsBefore: 1 }],
		["failure seals a segment", { ...projectionMatrixCandidate(5, 8), segmentSealed: 1 }],
		["failure leaves segments", { ...projectionMatrixCandidate(5, 8), segmentsAfter: 1 }],
		["recovery does not transition", { ...projectionMatrixCandidate(6, 9), epochTransitioned: 0 }],
		["recovery claims prior segments", { ...projectionMatrixCandidate(6, 9), segmentsBefore: 1 }],
		["recovery leaves segments", { ...projectionMatrixCandidate(6, 9), segmentsAfter: 1 }],
	];
	for (const [label, facts] of invalid) assert.equal(isHistoryProjectionFacts(facts), false, label);
});

test("v1.3 cache shares distinguish DeepSeek unavailable writes from Responses normalized writes", () => {
	const deepseek = { input: 10_000, output: 500, cacheRead: 40_000, cacheWrite: 0, totalTokens: 50_500, cost: { total: 0 } };
	assert.deepEqual(cacheUsageMetrics("deepseek", "openai-completions", deepseek, "verified"), {
		promptInputTokens: 50_000,
		cacheReadShare: 0.8,
		cacheWriteShare: null,
		cacheWriteStatusCode: 1,
	});

	const codex = { input: 9_500, output: 500, cacheRead: 40_000, cacheWrite: 500, totalTokens: 50_500, cost: { total: 0 } };
	assert.deepEqual(cacheUsageMetrics("openai-codex", "openai-codex-responses", codex, "verified"), {
		promptInputTokens: 50_000,
		cacheReadShare: 0.8,
		cacheWriteShare: 0.01,
		cacheWriteStatusCode: 2,
	});

	assert.deepEqual(cacheUsageMetrics("custom", "custom-api", deepseek, "partial"), {
		promptInputTokens: 50_000,
		cacheReadShare: null,
		cacheWriteShare: null,
		cacheWriteStatusCode: 0,
	});
	const zeroPromptCodex: PiUsageLike = {
		input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 },
	};
	assert.deepEqual(cacheUsageMetrics("openai-codex", "openai-codex-responses", zeroPromptCodex, "verified"), {
		promptInputTokens: 0,
		cacheReadShare: null,
		cacheWriteShare: null,
		cacheWriteStatusCode: 2,
	});
});

test("strict v1.3 correlation rejects actor attribution when request correlation is ambiguous or missing", () => {
	const unknownAmbiguous = {
		schemaVersion: "1.3",
		timestamp: "2026-08-14T00:00:00.000Z",
		extensionVersion: "0.10.0",
		hashedSessionId: "0123456789abcdef",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		thinkingLevel: null,
		workbenchMode: "DEV",
		messageStatus: "ok",
		usage: { input: 10, output: 1, cacheRead: 90, cacheWrite: 0, totalTokens: 101, cost: 0 },
		usageSemanticStatus: "verified",
		cacheHitRatio: 0.9,
		promptInputTokens: 100,
		cacheReadShare: 0.9,
		cacheWriteShare: null,
		cacheWriteStatusCode: 1,
		actorRoleCode: 0,
		requestCorrelationCode: 2,
		historyProjection: null,
		wireObservation: null,
		systemPromptHash: "a".repeat(64),
		activeToolNamesHash: "b".repeat(64),
		activeToolOrderHash: "c".repeat(64),
		activeToolSchemaHash: null,
		contextShapeHash: null,
		precedingEvent: null,
		inferredInvalidationReason: "FIRST_OBSERVED_REQUEST",
		inferenceConfidence: "high",
		driftSource: null,
	} as const;
	assert.equal(isTelemetryRecord(unknownAmbiguous), true, "ambiguous correlation remains valid only as unknown actor");
	assert.equal(
		isTelemetryRecord({ ...unknownAmbiguous, actorRoleCode: 1 }),
		false,
		"multiple/stale correlation cannot be attributed to Commander",
	);
	assert.equal(
		isTelemetryRecord({ ...unknownAmbiguous, requestCorrelationCode: 3, actorRoleCode: 2 }),
		false,
		"missing correlation cannot be attributed to worker",
	);
});

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
