/**
 * Commander compact-summary capacity preflight.
 *
 * The estimator consumes Pi's exact session_before_compact preparation and
 * returns content-free numeric/enum facts. These tests pin the capacity
 * envelope, split-turn independence and the real oversized-SCALPER shape.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import {
	COMPACT_PREFLIGHT_FIXED_INPUT_TOKENS,
	COMPACT_PREFLIGHT_SAFETY_BPS,
	COMPACT_PREFLIGHT_TOKENIZER_HEADROOM_BPS,
	evaluateCompactSummaryPreflight,
} from "../extensions/workbench-runtime/core/compact-preflight.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];

const MODEL = {
	contextWindow: 272_000,
	maxTokens: 128_000,
} as const;

function preparation(input: {
	history?: string;
	prefix?: string;
	previousSummary?: string;
	reserveTokens?: number;
}): Preparation {
	const history = input.history === undefined
		? []
		: [{ role: "user", content: [{ type: "text", text: input.history }], timestamp: 1 }];
	const prefix = input.prefix === undefined
		? []
		: [{ role: "user", content: [{ type: "text", text: input.prefix }], timestamp: 2 }];
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: history,
		turnPrefixMessages: prefix,
		isSplitTurn: prefix.length > 0,
		tokensBefore: 1,
		previousSummary: input.previousSummary,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: {
			enabled: false,
			reserveTokens: input.reserveTokens ?? 27_200,
			keepRecentTokens: 20_000,
		},
	} as unknown as Preparation;
}

test("small whole-turn preparation is allowed with the exact fixed safety envelope", () => {
	const result = evaluateCompactSummaryPreflight({
		preparation: preparation({ history: "small" }),
		model: MODEL,
	});

	assert.equal(result.verdict, "allow");
	assert.equal(result.reason, "within-budget");
	assert.equal(result.requestCount, 1);
	assert.equal(result.worstRequestKind, "history");
	assert.equal(result.contextWindowTokens, 272_000);
	assert.equal(result.calls[0]?.reservedOutputTokens, 21_760);
	assert.equal(result.calls[0]?.safetyTokens, 13_600);
	assert.equal(COMPACT_PREFLIGHT_FIXED_INPUT_TOKENS, 2_048);
	assert.equal(COMPACT_PREFLIGHT_SAFETY_BPS, 500);
	assert.equal(COMPACT_PREFLIGHT_TOKENIZER_HEADROOM_BPS, 500);
});

test("UTF-8 bytes/3 dominates chars/4 for multilingual summary content", () => {
	const result = evaluateCompactSummaryPreflight({
		preparation: preparation({ history: "界".repeat(3_000) }),
		model: MODEL,
	});

	assert.equal(result.verdict, "allow");
	const call = result.calls[0]!;
	assert.equal(call.serializedChars, 3_008);
	assert.equal(call.serializedUtf8Bytes, 9_008);
	assert.equal(call.basePayloadTokens, 3_003);
});

test("near-capacity request warns but remains admitted", () => {
	const result = evaluateCompactSummaryPreflight({
		preparation: preparation({ history: "a".repeat(600_000) }),
		model: MODEL,
	});

	assert.equal(result.verdict, "warn");
	assert.equal(result.reason, "near-capacity");
	assert.ok(result.worstRequestEnvelopeTokens >= 244_800);
	assert.ok(result.worstRequestEnvelopeTokens < 272_000);
});

test("real oversized SCALPER split-turn serialization shape blocks before provider summarization", () => {
	// Reproduced from the pre-compaction branch without retaining its content:
	// history serialized to 674,187 UTF-8 bytes and the turn prefix to 51,079.
	const result = evaluateCompactSummaryPreflight({
		preparation: preparation({
			history: "h".repeat(674_179),
			prefix: "p".repeat(51_071),
		}),
		model: MODEL,
	});

	assert.equal(result.verdict, "block");
	assert.equal(result.reason, "request-too-large");
	assert.equal(result.requestCount, 2);
	assert.equal(result.worstRequestKind, "history");
	assert.equal(result.calls[0]?.serializedUtf8Bytes, 674_187);
	assert.equal(result.calls[1]?.serializedUtf8Bytes, 51_079);
	assert.ok(result.calls[0]!.requestEnvelopeTokens >= MODEL.contextWindow);
	assert.ok(result.calls[1]!.requestEnvelopeTokens < MODEL.contextWindow);
});

test("history and split-prefix requests use independent 0.8 and 0.5 reserve outputs", () => {
	const result = evaluateCompactSummaryPreflight({
		preparation: preparation({ history: "history", prefix: "prefix" }),
		model: { contextWindow: 272_000, maxTokens: 10_000 },
	});

	assert.equal(result.verdict, "allow");
	assert.equal(result.requestCount, 2);
	assert.equal(result.calls[0]?.kind, "history");
	assert.equal(result.calls[0]?.reservedOutputTokens, 10_000, "model maxTokens clamps history output");
	assert.equal(result.calls[1]?.kind, "turn-prefix");
	assert.equal(result.calls[1]?.reservedOutputTokens, 10_000, "model maxTokens clamps prefix output");
});

test("Pi 0.84.2 maxTokens zero or negative means unbounded for both split requests", () => {
	for (const maxTokens of [0, -1, Number.MIN_SAFE_INTEGER]) {
		const result = evaluateCompactSummaryPreflight({
			preparation: preparation({
				history: "history",
				prefix: "prefix",
				reserveTokens: 10_001,
			}),
			model: { contextWindow: 272_000, maxTokens },
		});

		assert.equal(result.verdict, "allow", `maxTokens=${maxTokens} remains a valid Pi model value`);
		assert.equal(result.requestCount, 2);
		assert.equal(result.calls[0]?.reservedOutputTokens, 8_000, "history uses floor(reserveTokens * 0.8)");
		assert.equal(result.calls[1]?.reservedOutputTokens, 5_000, "prefix uses floor(reserveTokens * 0.5)");
	}
});

test("reserveTokens zero is admitted with zero reserved output while negative reserve is unknown", () => {
	const zero = evaluateCompactSummaryPreflight({
		preparation: preparation({ history: "history", prefix: "prefix", reserveTokens: 0 }),
		model: { contextWindow: 272_000, maxTokens: 0 },
	});

	assert.equal(zero.verdict, "allow");
	assert.equal(zero.requestCount, 2);
	assert.deepEqual(zero.calls.map((call) => call.reservedOutputTokens), [0, 0]);

	const negative = evaluateCompactSummaryPreflight({
		preparation: preparation({ history: "history", reserveTokens: -1 }),
		model: MODEL,
	});
	assert.equal(negative.verdict, "unknown");
	assert.equal(negative.reason, "invalid-input");
});

test("oversized split prefix blocks independently while a small history request remains within budget", () => {
	const result = evaluateCompactSummaryPreflight({
		preparation: preparation({ history: "history", prefix: "p".repeat(750_000) }),
		model: MODEL,
	});

	assert.equal(result.verdict, "block");
	assert.equal(result.reason, "request-too-large");
	assert.equal(result.requestCount, 2);
	assert.equal(result.worstRequestKind, "turn-prefix");
	assert.ok(result.calls[0]!.requestEnvelopeTokens < MODEL.contextWindow);
	assert.ok(result.calls[1]!.requestEnvelopeTokens >= MODEL.contextWindow);
});

test("previous summary and custom instructions increase only the history request", () => {
	const base = evaluateCompactSummaryPreflight({
		preparation: preparation({ history: "history", prefix: "prefix" }),
		model: MODEL,
	});
	const expanded = evaluateCompactSummaryPreflight({
		preparation: preparation({
			history: "history",
			prefix: "prefix",
			previousSummary: "旧摘要".repeat(1_000),
		}),
		customInstructions: "preserve exact evidence ".repeat(1_000),
		model: MODEL,
	});

	assert.ok(expanded.calls[0]!.estimatedInputTokens > base.calls[0]!.estimatedInputTokens);
	assert.equal(expanded.calls[1]!.estimatedInputTokens, base.calls[1]!.estimatedInputTokens);
});

test("dynamic history text can cross the block boundary without changing the split-prefix request", () => {
	const base = evaluateCompactSummaryPreflight({
		preparation: preparation({ history: "h".repeat(580_000), prefix: "prefix" }),
		model: MODEL,
	});
	const expanded = evaluateCompactSummaryPreflight({
		preparation: preparation({
			history: "h".repeat(580_000),
			prefix: "prefix",
			previousSummary: "s".repeat(90_000),
		}),
		customInstructions: "i".repeat(20_000),
		model: MODEL,
	});

	assert.equal(base.verdict, "allow");
	assert.ok(base.calls[0]!.requestEnvelopeTokens < MODEL.contextWindow);
	assert.equal(expanded.verdict, "block");
	assert.equal(expanded.worstRequestKind, "history");
	assert.ok(expanded.calls[0]!.requestEnvelopeTokens >= MODEL.contextWindow);
	assert.equal(expanded.calls[1]!.requestEnvelopeTokens, base.calls[1]!.requestEnvelopeTokens);
});

test("malformed or unavailable facts return unknown with numeric/enum-only output", () => {
	const invalidPreparation = evaluateCompactSummaryPreflight({
		preparation: {} as Preparation,
		model: MODEL,
	});
	const invalidModel = evaluateCompactSummaryPreflight({
		preparation: preparation({ history: "x" }),
		model: { contextWindow: 0, maxTokens: 128_000 },
	});

	for (const result of [invalidPreparation, invalidModel]) {
		assert.equal(result.verdict, "unknown");
		assert.equal(result.reason, "invalid-input");
		assert.equal(result.requestCount, 0);
		assert.deepEqual(result.calls, []);
		const serialized = JSON.stringify(result);
		assert.ok(!serialized.includes("history") && !serialized.includes("preserve"));
	}
});

test("serialization failures return unknown instead of throwing", () => {
	const hostile = preparation({ history: "safe" }) as unknown as Record<string, unknown>;
	hostile.messagesToSummarize = new Proxy([], {
		get() {
			throw new Error("raw secret must not escape");
		},
	});

	const result = evaluateCompactSummaryPreflight({
		preparation: hostile as unknown as Preparation,
		model: MODEL,
	});
	assert.equal(result.verdict, "unknown");
	assert.equal(result.reason, "estimation-failed");
	assert.equal(JSON.stringify(result).includes("raw secret"), false);
});
