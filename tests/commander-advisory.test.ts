/**
 * P7 commander advisory policy tests (pure, no Pi imports).
 *
 * Coverage:
 *   - the five fixed dimensions (requests, gross_tokens, output_tokens,
 *     tool_text_bytes, compactions) with default thresholds matching the
 *     approved contract EXACTLY
 *   - current-value extraction from a CostBreakdown-like object
 *     (gross = input + output + cacheRead + cacheWrite; malformed /
 *     non-finite / negative / absurd facts normalize defensively — never
 *     NaN/Infinity)
 *   - inclusive >= boundaries at the exact soft/high thresholds for every
 *     dimension (soft-1 => ok, soft => soft, high-1 => soft, high => high)
 *   - HIGH-over-soft precedence with mixed dimensions and fixed-order
 *     reasons carrying their own per-dimension band
 *   - threshold resolution: defaults on missing/garbage, additive partial
 *     overrides, high<=soft per-dimension fallback to BOTH defaults
 *   - parseAdvisoryConfig: valid/missing/invalid/unknown/ordering evidence
 *     with bounded issues and safe documented-default fallback, never
 *     throwing on adversarial input
 *   - advisoryStatusSegment footer mapping (ok => undefined, soft/high =>
 *     CMD:SOFT / CMD:HIGH)
 *   - renderAdvisoryFacts: deterministic, bounded, defensive rendering
 *     (hand-crafted malformed facts never produce NaN/Infinity, extra
 *     lines, or throws)
 *   - observe-only semantics: evaluation is a pure function that never
 *     sends, blocks, cancels, or throws
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ADVISORY_DIMENSIONS,
	advisoryCurrentValues,
	advisoryStatusSegment,
	DEFAULT_ADVISORY_HIGH,
	DEFAULT_ADVISORY_SOFT,
	defaultAdvisoryConfig,
	evaluateAdvisory,
	MAX_ADVISORY_CONFIG_ISSUES,
	MAX_ADVISORY_COUNT_DISPLAY,
	parseAdvisoryConfig,
	renderAdvisoryFacts,
	resolveThresholds,
	type AdvisoryBand,
	type AdvisoryConfig,
	type AdvisoryFacts,
} from "../extensions/workbench-runtime/core/commander-advisory.ts";

// ------------------------------------------------------------------- helpers

/** Minimal CostBreakdown-like object (evaluateAdvisory accepts any shape). */
function breakdown(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		commanderRequests: 0,
		compactions: 0,
		toolTextBytesTotal: 0,
		commander: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	};
}

/** A breakdown whose commander gross tokens equal `gross` exactly. */
function grossBreakdown(gross: number, output = 0): Record<string, unknown> {
	return breakdown({ commander: { input: gross - output, output, cacheRead: 0, cacheWrite: 0 } });
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

// ------------------------------------------------------- defaults contract

test("default thresholds match the approved contract exactly (five fixed dimensions)", () => {
	assert.deepEqual(DEFAULT_ADVISORY_SOFT, {
		requests: 200,
		gross_tokens: 25_000_000,
		output_tokens: 125_000,
		tool_text_bytes: 3_500_000,
		compactions: 5,
	});
	assert.deepEqual(DEFAULT_ADVISORY_HIGH, {
		requests: 300,
		gross_tokens: 40_000_000,
		output_tokens: 200_000,
		tool_text_bytes: 5_000_000,
		compactions: 8,
	});
	assert.deepEqual(ADVISORY_DIMENSIONS, [
		"requests",
		"gross_tokens",
		"output_tokens",
		"tool_text_bytes",
		"compactions",
	]);
	// defaults are fresh copies — callers can never alias the constants
	const a = defaultAdvisoryConfig();
	a.soft.requests = 1;
	a.high.compactions = 2;
	assert.equal(DEFAULT_ADVISORY_SOFT.requests, 200);
	assert.equal(DEFAULT_ADVISORY_HIGH.compactions, 8);
	assert.deepEqual(defaultAdvisoryConfig(), { soft: DEFAULT_ADVISORY_SOFT, high: DEFAULT_ADVISORY_HIGH });
});

// ------------------------------------------------------ current-value facts

test("advisoryCurrentValues extracts the five fixed dimensions", () => {
	const values = advisoryCurrentValues(
		breakdown({
			commanderRequests: 187,
			compactions: 4,
			toolTextBytesTotal: 123_456,
			commander: { input: 1_530_854, output: 111_430, cacheRead: 21_961_216, cacheWrite: 0 },
		}),
	);
	assert.deepEqual(values, {
		requests: 187,
		gross_tokens: 23_603_500, // exactly input + output + cacheRead + cacheWrite
		output_tokens: 111_430,
		tool_text_bytes: 123_456,
		compactions: 4,
	});
});

test("advisoryCurrentValues normalizes malformed/non-finite/negative facts to zero, never NaN", () => {
	const values = advisoryCurrentValues({
		commanderRequests: Number.NaN,
		compactions: Number.POSITIVE_INFINITY,
		toolTextBytesTotal: -5,
		commander: {
			input: "many",
			output: Number.NEGATIVE_INFINITY,
			cacheRead: -1,
			cacheWrite: undefined,
		},
	} as never);
	assert.deepEqual(values, {
		requests: 0,
		gross_tokens: 0,
		output_tokens: 0,
		tool_text_bytes: 0,
		compactions: 0,
	});
	for (const value of Object.values(values)) {
		assert.ok(Number.isFinite(value), "every normalized fact is finite");
	}
});

test("absurd finite facts clamp at extraction: the gross sum can never overflow to Infinity", () => {
	const values = advisoryCurrentValues({
		commanderRequests: 1e308,
		compactions: 1e308,
		toolTextBytesTotal: 1e308,
		commander: { input: 1e308, output: 1e308, cacheRead: 1e308, cacheWrite: 1e308 },
	} as never);
	// each component clamps to MAX_ADVISORY_COUNT_DISPLAY, so the summed
	// gross is exactly 4 * 2^50 = 2^52 — finite and exactly representable
	assert.equal(values.requests, MAX_ADVISORY_COUNT_DISPLAY);
	assert.equal(values.compactions, MAX_ADVISORY_COUNT_DISPLAY);
	assert.equal(values.tool_text_bytes, MAX_ADVISORY_COUNT_DISPLAY);
	assert.equal(values.gross_tokens, 4 * MAX_ADVISORY_COUNT_DISPLAY);
	assert.equal(values.output_tokens, MAX_ADVISORY_COUNT_DISPLAY);
	for (const value of Object.values(values)) {
		assert.ok(Number.isFinite(value), "never Infinity: " + String(value));
	}
});

// ------------------------------------------- inclusive boundaries (defaults)

test("requests boundaries: 199 ok, 200 soft, 299 soft, 300 high (inclusive >=)", () => {
	const at = (requests: number): AdvisoryBand => evaluateAdvisory(breakdown({ commanderRequests: requests })).band;
	assert.equal(at(199), "ok");
	assert.equal(at(200), "soft");
	assert.equal(at(299), "soft");
	assert.equal(at(300), "high");
	assert.equal(at(301), "high");
});

test("gross_tokens boundaries: 24_999_999 ok, 25_000_000 soft, 39_999_999 soft, 40_000_000 high", () => {
	const at = (gross: number): AdvisoryBand => evaluateAdvisory(grossBreakdown(gross)).band;
	assert.equal(at(24_999_999), "ok");
	assert.equal(at(25_000_000), "soft");
	assert.equal(at(39_999_999), "soft");
	assert.equal(at(40_000_000), "high");
});

test("output_tokens boundaries: 124_999 ok, 125_000 soft, 199_999 soft, 200_000 high", () => {
	const at = (output: number): AdvisoryBand => evaluateAdvisory(grossBreakdown(output, output)).band;
	assert.equal(at(124_999), "ok");
	assert.equal(at(125_000), "soft");
	assert.equal(at(199_999), "soft");
	assert.equal(at(200_000), "high");
});

test("tool_text_bytes boundaries: 3_499_999 ok, 3_500_000 soft, 4_999_999 soft, 5_000_000 high", () => {
	const at = (bytes: number): AdvisoryBand => evaluateAdvisory(breakdown({ toolTextBytesTotal: bytes })).band;
	assert.equal(at(3_499_999), "ok");
	assert.equal(at(3_500_000), "soft");
	assert.equal(at(4_999_999), "soft");
	assert.equal(at(5_000_000), "high");
});

test("compactions boundaries: 4 ok, 5 soft, 7 soft, 8 high (inclusive >=)", () => {
	const at = (compactions: number): AdvisoryBand => evaluateAdvisory(breakdown({ compactions })).band;
	assert.equal(at(4), "ok");
	assert.equal(at(5), "soft");
	assert.equal(at(7), "soft");
	assert.equal(at(8), "high");
});

test("an ok session evaluates to ok with all five values and empty reasons", () => {
	const facts = evaluateAdvisory(breakdown({ commanderRequests: 10, compactions: 1, toolTextBytesTotal: 1000 }));
	assert.equal(facts.band, "ok");
	assert.deepEqual(facts.reasons, []);
	assert.equal(facts.values.requests, 10);
	assert.equal(facts.values.gross_tokens, 0);
	assert.equal(facts.values.output_tokens, 0);
	assert.equal(facts.values.tool_text_bytes, 1000);
	assert.equal(facts.values.compactions, 1);
});

// ------------------------------------------- precedence + fixed reason order

test("HIGH overrides SOFT across mixed dimensions", () => {
	const facts = evaluateAdvisory(
		breakdown({
			commanderRequests: 300, // exactly high
			compactions: 5, // exactly soft
			toolTextBytesTotal: 3_500_000, // exactly soft
		}),
	);
	assert.equal(facts.band, "high");
	assert.deepEqual(
		facts.reasons.map((r) => [r.dimension, r.band]),
		[
			["requests", "high"],
			["tool_text_bytes", "soft"],
			["compactions", "soft"],
		],
		"reasons in the FIXED dimension order, each with its own band",
	);
});

test("all five dimensions triggered: overall high, reasons in the fixed order, per-dimension bands", () => {
	const facts = evaluateAdvisory(
		breakdown({
			commanderRequests: 500,
			compactions: 20,
			toolTextBytesTotal: 4_000_000,
			commander: { input: 60_000_000, output: 250_000, cacheRead: 0, cacheWrite: 0 },
		}),
	);
	assert.equal(facts.band, "high");
	assert.deepEqual(
		facts.reasons.map((r) => r.dimension),
		[...ADVISORY_DIMENSIONS],
	);
	assert.deepEqual(
		facts.reasons.map((r) => r.band),
		["high", "high", "high", "soft", "high"],
	);
	// each reason carries its exact normalized value + the effective thresholds
	const requests = facts.reasons[0]!;
	assert.deepEqual(
		[requests.value, requests.soft, requests.high],
		[500, DEFAULT_ADVISORY_SOFT.requests, DEFAULT_ADVISORY_HIGH.requests],
	);
});

test("a reason dimension is never duplicated across bands", () => {
	const facts = evaluateAdvisory(breakdown({ commanderRequests: 350 }));
	assert.deepEqual(
		facts.reasons.map((r) => [r.dimension, r.band]),
		[["requests", "high"]],
		"a high dimension is a HIGH reason, never also a SOFT reason",
	);
	assert.equal(facts.reasons.length, 1);
});

// ------------------------------------------------------ threshold resolution

test("resolveThresholds: defaults on missing/garbage config", () => {
	assert.deepEqual(resolveThresholds(undefined), defaultAdvisoryConfig());
	assert.deepEqual(resolveThresholds(null), defaultAdvisoryConfig());
	assert.deepEqual(resolveThresholds("x"), defaultAdvisoryConfig());
	assert.deepEqual(resolveThresholds([1, 2]), defaultAdvisoryConfig());
	assert.deepEqual(resolveThresholds({}), defaultAdvisoryConfig());
	assert.deepEqual(resolveThresholds({ soft: "x", high: [] }), defaultAdvisoryConfig());
});

test("resolveThresholds: additive partial overrides with per-level default fallback", () => {
	const resolved = resolveThresholds({
		soft: { requests: 10, gross_tokens: -1, bogus: 3 },
		high: { requests: 20 },
	});
	assert.equal(resolved.soft.requests, 10, "valid soft override applies");
	assert.equal(resolved.soft.gross_tokens, DEFAULT_ADVISORY_SOFT.gross_tokens, "invalid soft value falls back to the SOFT default");
	assert.equal(resolved.soft.output_tokens, DEFAULT_ADVISORY_SOFT.output_tokens, "missing fields inherit defaults");
	assert.equal(resolved.high.requests, 20);
	assert.equal(resolved.high.output_tokens, DEFAULT_ADVISORY_HIGH.output_tokens, "missing high field inherits the HIGH default");
	assert.ok(resolved.high.compactions > resolved.soft.compactions);
});

test("resolveThresholds: high<=soft falls back to BOTH documented defaults per dimension", () => {
	const resolved = resolveThresholds({
		soft: { requests: 500 },
		high: { requests: 500 }, // not strictly greater
	});
	assert.equal(resolved.soft.requests, DEFAULT_ADVISORY_SOFT.requests);
	assert.equal(resolved.high.requests, DEFAULT_ADVISORY_HIGH.requests);
	// other dimensions untouched
	assert.equal(resolved.soft.compactions, DEFAULT_ADVISORY_SOFT.compactions);
	assert.equal(resolved.high.compactions, DEFAULT_ADVISORY_HIGH.compactions);
});

test("evaluateAdvisory honors configured thresholds", () => {
	const config: AdvisoryConfig = {
		soft: { requests: 1, gross_tokens: 100, output_tokens: 10, tool_text_bytes: 1000, compactions: 1 },
		high: { requests: 2, gross_tokens: 200, output_tokens: 20, tool_text_bytes: 2000, compactions: 2 },
	};
	const facts = evaluateAdvisory(breakdown({ commanderRequests: 1, toolTextBytesTotal: 500 }), config);
	assert.equal(facts.band, "soft");
	assert.deepEqual(
		facts.reasons.map((r) => r.dimension),
		["requests"],
	);
	assert.equal(facts.soft.requests, 1);
	assert.equal(facts.high.requests, 2);
	// the configured high fires at exactly its value
	const high = evaluateAdvisory(breakdown({ commanderRequests: 2 }), config);
	assert.equal(high.band, "high");
});

// --------------------------------------------------------- parseAdvisoryConfig

test("parseAdvisoryConfig: undefined input is a no-op with defaults and no issues", () => {
	const { config, issues } = parseAdvisoryConfig(undefined);
	assert.deepEqual(config, defaultAdvisoryConfig());
	assert.deepEqual(issues, []);
});

test("parseAdvisoryConfig: full valid soft/high overrides resolve exactly", () => {
	const { config, issues } = parseAdvisoryConfig({
		soft: { requests: 10, gross_tokens: 1000, output_tokens: 100, tool_text_bytes: 2000, compactions: 2 },
		high: { requests: 20, gross_tokens: 2000, output_tokens: 200, tool_text_bytes: 4000, compactions: 4 },
	});
	assert.deepEqual(issues, []);
	assert.deepEqual(config.soft, { requests: 10, gross_tokens: 1000, output_tokens: 100, tool_text_bytes: 2000, compactions: 2 });
	assert.deepEqual(config.high, { requests: 20, gross_tokens: 2000, output_tokens: 200, tool_text_bytes: 4000, compactions: 4 });
});

test("parseAdvisoryConfig: missing fields inherit the documented defaults (additive)", () => {
	const { config, issues } = parseAdvisoryConfig({
		soft: { requests: 5 },
		high: { compactions: 10 },
	});
	assert.deepEqual(issues, []);
	assert.equal(config.soft.requests, 5);
	assert.equal(config.soft.gross_tokens, DEFAULT_ADVISORY_SOFT.gross_tokens);
	assert.equal(config.high.compactions, 10);
	assert.equal(config.high.requests, DEFAULT_ADVISORY_HIGH.requests);
	assert.ok(config.high.gross_tokens > config.soft.gross_tokens);
});

test("parseAdvisoryConfig: invalid values produce issues and fall back to the documented defaults", () => {
	const cases: unknown[] = [0, -5, 1.5, "200", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, null, true, {}];
	for (const bad of cases) {
		const { config, issues } = parseAdvisoryConfig({ soft: { requests: bad } });
		assert.ok(issues.length >= 1, `bad value ${String(bad)} must produce an issue`);
		assert.ok(
			issues[0]!.includes("positive safe integer"),
			`issue names the rule for ${String(bad)}: ${issues[0]}`,
		);
		assert.equal(config.soft.requests, DEFAULT_ADVISORY_SOFT.requests, `fallback for ${String(bad)}`);
		assert.equal(config.high.requests, DEFAULT_ADVISORY_HIGH.requests, "the other level is untouched");
	}
	// a valid field next to an invalid one still applies (additive)
	const mixed = parseAdvisoryConfig({ soft: { requests: 7, compactions: -1 } });
	assert.equal(mixed.config.soft.requests, 7);
	assert.equal(mixed.config.soft.compactions, DEFAULT_ADVISORY_SOFT.compactions);
	assert.equal(mixed.issues.length, 1);
});

test("parseAdvisoryConfig: unknown keys and non-mapping levels produce bounded issues", () => {
	const unknown = parseAdvisoryConfig({ soft: { requests: 1, bogus: 2 } });
	assert.ok(unknown.issues.some((i) => i.includes("bogus") && i.includes("not a known dimension")), unknown.issues.join("|"));
	assert.equal(unknown.config.soft.requests, 1, "the valid key still applies");
	const level = parseAdvisoryConfig({ soft: "nope", high: [1, 2] });
	assert.equal(level.issues.length, 2);
	assert.ok(level.issues.every((i) => i.includes('"commander.advisory.soft"') || i.includes('"commander.advisory.high"')), level.issues.join("|"));
	const root = parseAdvisoryConfig("nope");
	assert.equal(root.issues.length, 1);
	assert.ok(root.issues[0]!.includes("must be a mapping"));
	assert.deepEqual(root.config, defaultAdvisoryConfig());
	const rootArray = parseAdvisoryConfig([1, 2, 3]);
	assert.equal(rootArray.issues.length, 1);
});

test("parseAdvisoryConfig: high<=soft records an issue and falls back to BOTH documented defaults", () => {
	const { config, issues } = parseAdvisoryConfig({
		soft: { requests: 500 },
		high: { requests: 500 },
	});
	assert.ok(issues.some((i) => i.includes("high requests") && i.includes("greater than soft requests")), issues.join("|"));
	assert.equal(config.soft.requests, DEFAULT_ADVISORY_SOFT.requests);
	assert.equal(config.high.requests, DEFAULT_ADVISORY_HIGH.requests);
	// only the violated dimension falls back; others keep valid overrides
	const partial = parseAdvisoryConfig({
		soft: { requests: 500, compactions: 2 },
		high: { requests: 300, compactions: 4 },
	});
	assert.equal(partial.config.soft.requests, DEFAULT_ADVISORY_SOFT.requests);
	assert.equal(partial.config.soft.compactions, 2, "valid compactions override is kept");
	assert.equal(partial.config.high.compactions, 4);
	assert.equal(partial.issues.length, 1, "one ordering issue for requests only");
});

test("parseAdvisoryConfig: adversarial input stays bounded and never throws", () => {
	// hundreds of unknown keys — issue evidence is hard-capped
	const soft: Record<string, unknown> = {};
	const high: Record<string, unknown> = {};
	const doc: Record<string, unknown> = { soft, high };
	for (let i = 0; i < 500; i++) soft[`key-${i}`] = i;
	for (let i = 0; i < 500; i++) high[`key-${i}`] = i;
	const { config, issues } = parseAdvisoryConfig(doc);
	assert.ok(issues.length <= MAX_ADVISORY_CONFIG_ISSUES, `capped at ${MAX_ADVISORY_CONFIG_ISSUES}: ${issues.length}`);
	assert.deepEqual(config, defaultAdvisoryConfig());
	// deeply weird inputs never throw
	for (const weird of [42, [], "x", { soft: { requests: { nested: 1 } } }, { soft: null, high: undefined }, { soft: { requests: Symbol("s") as never } }]) {
		const out = parseAdvisoryConfig(weird);
		assert.ok(Array.isArray(out.issues));
		assert.ok(out.config.soft.requests > 0 && out.config.high.requests > out.config.soft.requests);
	}
});

// ------------------------------------------------------ footer segment

test("advisoryStatusSegment: ok adds no footer segment; soft/high map to CMD:SOFT / CMD:HIGH", () => {
	assert.equal(advisoryStatusSegment(evaluateAdvisory(breakdown())), undefined);
	assert.equal(advisoryStatusSegment(evaluateAdvisory(breakdown({ commanderRequests: 200 }))), "CMD:SOFT");
	assert.equal(advisoryStatusSegment(evaluateAdvisory(breakdown({ commanderRequests: 300 }))), "CMD:HIGH");
	// configured thresholds drive the segment too
	const config: AdvisoryConfig = {
		soft: { requests: 1, gross_tokens: 1, output_tokens: 1, tool_text_bytes: 1, compactions: 1 },
		high: { requests: 2, gross_tokens: 2, output_tokens: 2, tool_text_bytes: 2, compactions: 2 },
	};
	assert.equal(advisoryStatusSegment(evaluateAdvisory(breakdown({ commanderRequests: 1 }), config)), "CMD:SOFT");
	assert.equal(advisoryStatusSegment(evaluateAdvisory(breakdown({ commanderRequests: 2 }), config)), "CMD:HIGH");
});

// ------------------------------------------------------ rendering

test("renderAdvisoryFacts renders band, five values with thresholds, and reasons deterministically", () => {
	const facts = evaluateAdvisory(
		breakdown({
			commanderRequests: 250,
			compactions: 9,
			commander: { input: 30_000_000, output: 150_000, cacheRead: 0, cacheWrite: 0 },
		}),
	);
	const lines = renderAdvisoryFacts(facts);
	const text = lines.join("\n");
	assert.ok(lines[0]!.startsWith("commander advisory"), text);
	// labels are padEnd(16): band + 12 spaces, requests + 8, gross_tokens + 4,
	// output_tokens + 3, tool_text_bytes + 1, compactions + 5, reasons + 9
	// (the leading two rendered indentation spaces are not part of the needles)
	assert.ok(text.includes("band            : HIGH"), text);
	assert.ok(text.includes("requests        : 250 (soft 200 / high 300)"), text);
	assert.ok(text.includes("gross_tokens    : 30150000 (soft 25000000 / high 40000000)"), text);
	assert.ok(text.includes("output_tokens   : 150000 (soft 125000 / high 200000)"), text);
	assert.ok(text.includes("tool_text_bytes : 0 (soft 3500000 / high 5000000)"), text);
	assert.ok(text.includes("compactions     : 9 (soft 5 / high 8)"), text);
	assert.ok(
		text.includes("reasons         : requests (SOFT); gross_tokens (SOFT); output_tokens (SOFT); compactions (HIGH)"),
		text,
	);
	assert.ok(lines.every((l) => byteLength(l) < 200), "every line stays bounded");
	// deterministic
	assert.deepEqual(renderAdvisoryFacts(facts), lines);
	// ok session: band OK, reasons none
	const okText = renderAdvisoryFacts(evaluateAdvisory(breakdown())).join("\n");
	assert.ok(okText.includes("band            : OK"), okText);
	assert.ok(okText.includes("reasons         : (none — all dimensions below their soft thresholds)"), okText);
});

test("renderAdvisoryFacts clamps hand-crafted absurd values with the explicit note", () => {
	// extraction clamps exactly AT the display bound: the normalized fact is
	// MAX_ADVISORY_COUNT_DISPLAY (not above it), so rendering shows the
	// clamped count WITHOUT claiming it was above max — the render clamp note
	// only fires for values still above the bound at render time.
	const facts = evaluateAdvisory(breakdown({ commanderRequests: 1e308 }));
	assert.equal(facts.values.requests, MAX_ADVISORY_COUNT_DISPLAY, "extraction already clamps");
	const lines = renderAdvisoryFacts(facts);
	assert.ok(lines.some((l) => l.includes(String(MAX_ADVISORY_COUNT_DISPLAY))), lines.join("\n"));
	assert.ok(!lines.some((l) => l.includes("clamped for display")), "exactly-at-max is not above max: " + lines.join("\n"));
	assert.ok(lines.every((l) => !l.includes("NaN") && !l.includes("Infinity")), lines.join("\n"));
	// render-clamp path: a hand-crafted AdvisoryFacts copy with an over-max
	// current value (evaluateAdvisory would already have clamped it) triggers
	// the explicit render note and still renders the clamped count
	const overMax = {
		band: "high",
		values: { ...facts.values, requests: MAX_ADVISORY_COUNT_DISPLAY + 1 },
		soft: facts.soft,
		high: facts.high,
		reasons: facts.reasons,
	} as unknown as AdvisoryFacts;
	const clamped = renderAdvisoryFacts(overMax);
	assert.ok(clamped.some((l) => l.includes("clamped for display")), clamped.join("\n"));
	assert.ok(clamped.some((l) => l.includes(`requests        : ${MAX_ADVISORY_COUNT_DISPLAY} (soft`)), clamped.join("\n"));
	assert.ok(clamped.every((l) => !l.includes("NaN") && !l.includes("Infinity")), clamped.join("\n"));
	assert.ok(clamped.every((l) => byteLength(l) < 200), clamped.join("\n"));
});

test("renderAdvisoryFacts is defensive on hand-crafted malformed facts — no NaN/Infinity, no throw", () => {
	const malformed = {
		band: "banana", // unknown band — fails safe to OK, never a made-up verdict
		values: {
			requests: Number.NaN,
			gross_tokens: Number.POSITIVE_INFINITY,
			output_tokens: -5,
			tool_text_bytes: "many",
			compactions: 1e308,
		},
		soft: {
			requests: Number.NaN,
			gross_tokens: 0,
			output_tokens: -1,
			tool_text_bytes: "x",
			compactions: undefined,
		},
		high: {
			requests: Number.POSITIVE_INFINITY,
			gross_tokens: 1.5,
			output_tokens: 3,
			tool_text_bytes: null,
			compactions: -2,
		},
		reasons: "not-an-array",
	} as unknown as AdvisoryFacts;
	const lines = renderAdvisoryFacts(malformed);
	const text = lines.join("\n");
	assert.ok(!text.includes("NaN") && !text.includes("Infinity"), text);
	assert.ok(text.includes("band            : OK"), "unknown band degrades to ok");
	assert.ok(text.includes("reasons         : (none — all dimensions below their soft thresholds)"), "non-array reasons degrade");
	assert.ok(lines.every((l) => byteLength(l) < 200), "every line stays bounded");
	// absent/null values/soft/high subobjects render the documented defaults
	// and fail safe — never a throw, never NaN/Infinity
	const missingSub = { band: "high" } as unknown as AdvisoryFacts;
	const missingText = renderAdvisoryFacts(missingSub).join("\n");
	assert.ok(missingText.includes("band            : HIGH"), "a valid band is still honored: " + missingText);
	assert.ok(missingText.includes("requests        : 0 (soft 200 / high 300)"), "absent subobjects render the defaults: " + missingText);
	assert.ok(!missingText.includes("NaN") && !missingText.includes("Infinity"), missingText);
	const nullSub = { values: null, soft: null, high: null, reasons: [] } as unknown as AdvisoryFacts;
	const nullText = renderAdvisoryFacts(nullSub).join("\n");
	assert.ok(nullText.includes("band            : OK"), "absent band fails safe to OK: " + nullText);
	assert.ok(nullText.includes("requests        : 0 (soft 200 / high 300)"), nullText);
	assert.ok(nullText.includes("reasons         : (none — all dimensions below their soft thresholds)"), nullText);
	assert.ok(!nullText.includes("NaN") && !nullText.includes("Infinity"), nullText);
	// malformed reason entries degrade deterministically
	const badReasons = {
		band: "soft",
		values: { requests: 1, gross_tokens: 0, output_tokens: 0, tool_text_bytes: 0, compactions: 0 },
		soft: { requests: 1, gross_tokens: 1, output_tokens: 1, tool_text_bytes: 1, compactions: 1 },
		high: { requests: 2, gross_tokens: 2, output_tokens: 2, tool_text_bytes: 2, compactions: 2 },
		reasons: [null, { dimension: 42, band: "high" }, { dimension: "compactions", band: undefined }],
	} as unknown as AdvisoryFacts;
	const degraded = renderAdvisoryFacts(badReasons).join("\n");
	assert.ok(degraded.includes("? (OK); ? (HIGH); compactions (OK)"), degraded);
	assert.equal(renderAdvisoryFacts(malformed).join("\n"), text, "deterministic");
});

// ------------------------------------------------------ observe-only proof

/** Safe label for an adversarial input — String(input) throws on Object.create(null). */
function safeInputLabel(input: unknown, index: number): string {
	if (input === null) return `input #${index} (null)`;
	if (typeof input === "string") return `input #${index} ("${input}")`;
	if (typeof input === "number") return `input #${index} (${input})`;
	return `input #${index} (${typeof input})`;
}

test("evaluateAdvisory never throws and stays finite on adversarial breakdowns", () => {
	const adversarial = [
		undefined,
		null,
		42,
		"x",
		[],
		{ commanderRequests: Number.NaN },
		{ commander: { input: 1e308, output: 1e308, cacheRead: 1e308, cacheWrite: 1e308 } },
		{ commanderRequests: -10, compactions: -3, toolTextBytesTotal: Number.POSITIVE_INFINITY },
		{ commander: "garbage", commanderRequests: { deep: 1 } },
		Object.create(null),
	];
	for (const [index, input] of adversarial.entries()) {
		const label = safeInputLabel(input, index);
		const facts = evaluateAdvisory(input);
		assert.ok(["ok", "soft", "high"].includes(facts.band), label);
		for (const value of Object.values(facts.values)) {
			assert.ok(Number.isFinite(value) && value >= 0, `finite non-negative value for ${label}`);
		}
	}
});
