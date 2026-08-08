/**
 * P7 commander advisory policy (commander-token-optimization plan §6 P7) —
 * pure, observation-only, no Pi imports.
 *
 * Evaluates the five commander cumulative observability dimensions over the
 * existing P0 `CostBreakdown` facts (core/cost-breakdown.ts) against pinned
 * soft/high thresholds and returns a deterministic `ok | soft | high` band:
 *
 *   - exactly five dimensions in the FIXED order:
 *     requests, gross_tokens, output_tokens, tool_text_bytes, compactions;
 *   - inclusive `>=` boundaries: a dimension reaches `soft` at exactly its
 *     soft threshold and `high` at exactly its high threshold;
 *   - HIGH-over-soft precedence: the overall band is the highest per-
 *     dimension band, so one dimension at high makes the session HIGH even
 *     when another dimension is only soft;
 *   - reasons are the non-ok dimensions in the fixed dimension order, each
 *     carrying its own per-dimension band (a dimension at high is a HIGH
 *     reason, never also a SOFT reason).
 *
 * Default thresholds are documented constants rounded just above the
 * recorded P0 snapshot (docs/baselines/commander-token-p0.md):
 *
 *   soft { requests: 200, gross_tokens: 25_000_000, output_tokens: 125_000,
 *          tool_text_bytes: 3_500_000, compactions: 5 }
 *   high { requests: 300, gross_tokens: 40_000_000, output_tokens: 200_000,
 *          tool_text_bytes: 5_000_000, compactions: 8 }
 *
 * The optional trusted project.yaml `commander.advisory.soft/high` mapping
 * may override individual values (parseAdvisoryConfig): every value must be
 * a positive safe integer and every high value must be greater than its
 * soft value; missing fields inherit the defaults and invalid fields or
 * ordering become bounded ConfigIssue evidence (returned as messages —
 * the caller wraps them into `project.yaml` ConfigIssue records) while the
 * config falls back to the defaults. Observability is never disabled and
 * nothing throws.
 *
 * ADVISORY ONLY: this module never sends messages, never cancels/returns a
 * stop signal, never throws from threshold evaluation, never changes
 * modes/tools/write authority/review/gates/recipes, and creates no hard-
 * stop or enforcement path. A high-band event completes normal
 * message_end/status processing unchanged.
 */

/** The five commander advisory dimensions, in the FIXED evaluation order. */
export const ADVISORY_DIMENSIONS = [
	"requests",
	"gross_tokens",
	"output_tokens",
	"tool_text_bytes",
	"compactions",
] as const;

export type AdvisoryDimension = (typeof ADVISORY_DIMENSIONS)[number];

export type AdvisoryBand = "ok" | "soft" | "high";

/** One dimension's soft (or high) thresholds — all five keys, always present. */
export interface AdvisoryThresholds {
	requests: number;
	gross_tokens: number;
	output_tokens: number;
	tool_text_bytes: number;
	compactions: number;
}

/** Resolved soft + high thresholds (defaults merged; high > soft per dimension). */
export interface AdvisoryConfig {
	soft: AdvisoryThresholds;
	high: AdvisoryThresholds;
}

/**
 * Documented observation-first default thresholds, rounded just above the
 * recorded P0 snapshot (requests ≈ 108, gross ≈ 14.16M, output and tool
 * text bytes per the P0 attribution, compactions = 3).
 */
export const DEFAULT_ADVISORY_SOFT: AdvisoryThresholds = {
	requests: 200,
	gross_tokens: 25_000_000,
	output_tokens: 125_000,
	tool_text_bytes: 3_500_000,
	compactions: 5,
};

export const DEFAULT_ADVISORY_HIGH: AdvisoryThresholds = {
	requests: 300,
	gross_tokens: 40_000_000,
	output_tokens: 200_000,
	tool_text_bytes: 5_000_000,
	compactions: 8,
};

/** Fresh defaults (independent copies — callers never alias the constants). */
export function defaultAdvisoryConfig(): AdvisoryConfig {
	return {
		soft: { ...DEFAULT_ADVISORY_SOFT },
		high: { ...DEFAULT_ADVISORY_HIGH },
	};
}

/** One triggered dimension's facts (reason) in the fixed evaluation order. */
export interface AdvisoryDimensionFacts {
	dimension: AdvisoryDimension;
	/** Normalized current value (finite, non-negative integer). */
	value: number;
	soft: number;
	high: number;
	/** Per-dimension band ("soft" or "high" — never "ok" inside reasons). */
	band: AdvisoryBand;
}

export interface AdvisoryFacts {
	/** Overall band — the highest per-dimension band (HIGH > SOFT > OK). */
	band: AdvisoryBand;
	/** Normalized current values for all five dimensions (fixed order). */
	values: AdvisoryThresholds;
	/** Effective soft thresholds (defaults merged). */
	soft: AdvisoryThresholds;
	/** Effective high thresholds (defaults merged, high > soft per dimension). */
	high: AdvisoryThresholds;
	/** Triggered dimensions in the fixed order, each with its own band. */
	reasons: AdvisoryDimensionFacts[];
}

/**
 * Display bound for rendered advisory counts (defensive) and the extraction
 * clamp for normalized current values (see toCount). Real session counts are
 * orders of magnitude below this; a hand-crafted finite-but-absurd value
 * clamps here (at extraction for evaluateAdvisory facts, at render for
 * hand-crafted facts) with an explicit note so rendered lines stay bounded.
 * The BAND is always evaluated on the normalized facts — display clamping
 * never changes the verdict.
 */
export const MAX_ADVISORY_COUNT_DISPLAY = 2 ** 50;

/** Hard cap on parseAdvisoryConfig issue messages (adversarial YAML stays bounded). */
export const MAX_ADVISORY_CONFIG_ISSUES = 20;

/** Defensive number: only finite, non-negative numbers count. */
function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Normalize a current-value fact to a deterministic non-negative integer,
 * clamped at MAX_ADVISORY_COUNT_DISPLAY. Clamping at extraction (not only
 * at render) guarantees the four-component gross_tokens sum can never
 * overflow to Infinity — malformed/absurd facts always produce finite,
 * bounded values and never NaN/Infinity. The clamp floor is orders of
 * magnitude above any documented threshold, so the band verdict is
 * unchanged for every real session.
 */
function toCount(value: unknown): number {
	const rounded = Math.round(finiteNonNegative(value));
	return rounded > MAX_ADVISORY_COUNT_DISPLAY ? MAX_ADVISORY_COUNT_DISPLAY : rounded;
}

/** A positive safe integer, else the given fallback. */
function positiveSafeIntOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Extract the five current values from a CostBreakdown-like object,
 * defensively (malformed/missing fields normalize to zero, never throw):
 *   requests        — commanderRequests (exact commander turn count)
 *   gross_tokens    — commander input + output + cacheRead + cacheWrite
 *                     (the exact commander gross, same as the P0 fact)
 *   output_tokens   — commander.output
 *   tool_text_bytes — toolTextBytesTotal (session inline TEXT bytes)
 *   compactions     — compactions (exact compaction count)
 */
export function advisoryCurrentValues(breakdown: unknown): AdvisoryThresholds {
	const b = (typeof breakdown === "object" && breakdown !== null ? breakdown : {}) as Record<string, unknown>;
	const commander = (typeof b.commander === "object" && b.commander !== null ? b.commander : {}) as Record<string, unknown>;
	return {
		requests: toCount(b.commanderRequests),
		gross_tokens:
			toCount(commander.input) + toCount(commander.output) + toCount(commander.cacheRead) + toCount(commander.cacheWrite),
		output_tokens: toCount(commander.output),
		tool_text_bytes: toCount(b.toolTextBytesTotal),
		compactions: toCount(b.compactions),
	};
}

/**
 * Resolve effective thresholds from a partial config (defensively, no
 * issues): every dimension resolves to a positive safe integer or the
 * documented default; a dimension whose high value is not strictly greater
 * than its soft value falls back to BOTH defaults for that dimension, so
 * the resolved config always satisfies high > soft per dimension.
 */
export function resolveThresholds(config: unknown): AdvisoryConfig {
	const resolved = defaultAdvisoryConfig();
	if (typeof config !== "object" || config === null || Array.isArray(config)) return resolved;
	const doc = config as Record<string, unknown>;
	// Each level resolves against ITS OWN documented defaults (an invalid
	// soft field falls back to the soft default, an invalid high field to
	// the high default) — invalid values never cross levels.
	const resolveLevel = (level: "soft" | "high", raw: unknown, defaults: AdvisoryThresholds): void => {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
		const map = raw as Record<string, unknown>;
		for (const dimension of ADVISORY_DIMENSIONS) {
			resolved[level][dimension] = positiveSafeIntOr(map[dimension], defaults[dimension]);
		}
	};
	resolveLevel("soft", doc.soft, DEFAULT_ADVISORY_SOFT);
	resolveLevel("high", doc.high, DEFAULT_ADVISORY_HIGH);
	for (const dimension of ADVISORY_DIMENSIONS) {
		if (resolved.high[dimension] <= resolved.soft[dimension]) {
			resolved.soft[dimension] = DEFAULT_ADVISORY_SOFT[dimension];
			resolved.high[dimension] = DEFAULT_ADVISORY_HIGH[dimension];
		}
	}
	return resolved;
}

/**
 * Evaluate the advisory band over a CostBreakdown-like object with the
 * given thresholds (defaults when missing). Inclusive `>=` boundaries,
 * HIGH-over-soft precedence, fixed-order reasons. Never throws and never
 * produces NaN/Infinity — malformed facts/thresholds normalize defensively.
 */
export function evaluateAdvisory(breakdown: unknown, config?: unknown): AdvisoryFacts {
	const values = advisoryCurrentValues(breakdown);
	const thresholds = resolveThresholds(config);
	const reasons: AdvisoryDimensionFacts[] = [];
	let band: AdvisoryBand = "ok";
	for (const dimension of ADVISORY_DIMENSIONS) {
		const value = values[dimension];
		const soft = thresholds.soft[dimension];
		const high = thresholds.high[dimension];
		const dimensionBand: AdvisoryBand = value >= high ? "high" : value >= soft ? "soft" : "ok";
		if (dimensionBand === "high") band = "high";
		else if (dimensionBand === "soft" && band === "ok") band = "soft";
		if (dimensionBand !== "ok") {
			reasons.push({ dimension, value, soft, high, band: dimensionBand });
		}
	}
	return { band, values, soft: thresholds.soft, high: thresholds.high, reasons };
}

/**
 * Compact TUI footer segment — "CMD:SOFT" or "CMD:HIGH", exactly when the
 * band is triggered; undefined when ok (the footer shows nothing for an ok
 * session). Observation-only.
 */
export function advisoryStatusSegment(facts: AdvisoryFacts): string | undefined {
	if (facts.band === "ok") return undefined;
	return `CMD:${facts.band.toUpperCase()}`;
}

/** Bounded display of a raw config value inside an issue message. */
function boundedValue(value: unknown): string {
	if (typeof value === "string") return value.length > 40 ? `"${value.slice(0, 40)}…"` : JSON.stringify(value);
	if (typeof value === "number") return String(value);
	return "a non-number";
}

/**
 * Parse the optional project.yaml `commander.advisory` value into a fully
 * resolved AdvisoryConfig, collecting bounded ConfigIssue messages:
 *   - `soft`/`high` must each be a mapping with the exact five dimension
 *     keys (unknown keys are rejected with an issue);
 *   - every value must be a positive safe integer (else an issue + the
 *     field falls back to its documented default);
 *   - every high value must be greater than its soft value (else an issue
 *     + BOTH fall back to the documented defaults for that dimension);
 *   - missing fields inherit the defaults; `undefined` input is a no-op;
 *   - issue evidence is hard-capped (MAX_ADVISORY_CONFIG_ISSUES) so
 *     adversarial YAML can never produce unbounded output.
 * Never throws; observability is never disabled by a bad config.
 */
export function parseAdvisoryConfig(raw: unknown): { config: AdvisoryConfig; issues: string[] } {
	const config = defaultAdvisoryConfig();
	const issues: string[] = [];
	const push = (message: string): void => {
		if (issues.length < MAX_ADVISORY_CONFIG_ISSUES) issues.push(message);
	};
	if (raw === undefined) return { config, issues };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		push('"commander.advisory" must be a mapping (e.g. commander: { advisory: { soft: {...}, high: {...} } })');
		return { config, issues };
	}
	const doc = raw as Record<string, unknown>;
	const parseLevel = (level: "soft" | "high", levelDoc: unknown): void => {
		if (levelDoc === undefined) return;
		if (typeof levelDoc !== "object" || levelDoc === null || Array.isArray(levelDoc)) {
			push(
				`"commander.advisory.${level}" must be a mapping with the five dimension keys (requests, gross_tokens, output_tokens, tool_text_bytes, compactions)`,
			);
			return;
		}
		const map = levelDoc as Record<string, unknown>;
		for (const key of Object.keys(map)) {
			if (!ADVISORY_DIMENSIONS.includes(key as AdvisoryDimension)) {
				push(
					`"commander.advisory.${level}.${key}" is not a known dimension (expected requests, gross_tokens, output_tokens, tool_text_bytes or compactions)`,
				);
				continue;
			}
			const value = map[key];
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
				push(
					`"commander.advisory.${level}.${key}" must be a positive safe integer (got ${boundedValue(value)}) — using the documented default`,
				);
				continue;
			}
			config[level][key as AdvisoryDimension] = value;
		}
	};
	parseLevel("soft", doc.soft);
	parseLevel("high", doc.high);
	// Per-dimension ordering: high must be strictly greater than soft. A
	// violation falls back to BOTH documented defaults for that dimension.
	for (const dimension of ADVISORY_DIMENSIONS) {
		if (config.high[dimension] <= config.soft[dimension]) {
			push(
				`"commander.advisory" high ${dimension} (${config.high[dimension]}) must be greater than soft ${dimension} (${config.soft[dimension]}) — using the documented defaults for ${dimension}`,
			);
			config.soft[dimension] = DEFAULT_ADVISORY_SOFT[dimension];
			config.high[dimension] = DEFAULT_ADVISORY_HIGH[dimension];
		}
	}
	return { config, issues };
}

const DIMENSION_LABEL_WIDTH = 16;

/** Defensive display count: finite non-negative integer clamped to MAX_ADVISORY_COUNT_DISPLAY. */
function displayCount(value: unknown): { value: number; clamped: boolean } {
	const rounded = Math.round(finiteNonNegative(value));
	return rounded > MAX_ADVISORY_COUNT_DISPLAY
		? { value: MAX_ADVISORY_COUNT_DISPLAY, clamped: true }
		: { value: rounded, clamped: false };
}

/** Defensive display threshold: positive safe integer, else the documented default. */
function displayThreshold(value: unknown, fallback: number): number {
	return positiveSafeIntOr(value, fallback);
}

/**
 * Deterministic, bounded rendering for /q-cost-status (ASCII, no line
 * breaks). Defensive against hand-crafted malformed facts: the band FAILS
 * SAFE to OK unless it is exactly one of the three valid values
 * (ok/soft/high) — an unknown or malformed band string can never render a
 * made-up verdict; current values normalize to non-negative integers
 * clamped at MAX_ADVISORY_COUNT_DISPLAY (with an explicit note);
 * thresholds normalize to positive safe integers or the documented
 * defaults; absent/malformed values/soft/high subobjects render the
 * documented defaults; and non-array/unknown reason entries degrade
 * deterministically — never NaN/Infinity, never a throw, every line
 * bounded. In production the facts always come from evaluateAdvisory, so
 * the defensive paths are inert.
 */
export function renderAdvisoryFacts(facts: AdvisoryFacts): string[] {
	// Every direct read below is guarded so rendering cannot throw on
	// hand-crafted facts: a non-object facts value, a non-string band, and
	// absent/malformed values/soft/high subobjects all degrade
	// deterministically instead of throwing.
	const source = (typeof facts === "object" && facts !== null ? facts : {}) as Partial<AdvisoryFacts>;
	const rawBand = typeof source.band === "string" ? source.band : "";
	const band: AdvisoryBand = rawBand === "ok" || rawBand === "soft" || rawBand === "high" ? rawBand : "ok";
	const values = (typeof source.values === "object" && source.values !== null ? source.values : {}) as Record<
		string,
		unknown
	>;
	const soft = (typeof source.soft === "object" && source.soft !== null ? source.soft : {}) as Record<string, unknown>;
	const high = (typeof source.high === "object" && source.high !== null ? source.high : {}) as Record<string, unknown>;
	const lines = [
		"commander advisory (P7 observation-only — no hard stop, no enforcement):",
		`  ${"band".padEnd(DIMENSION_LABEL_WIDTH)}: ${band.toUpperCase()}`,
	];
	let clamped = 0;
	for (const dimension of ADVISORY_DIMENSIONS) {
		const shown = displayCount(values[dimension]);
		if (shown.clamped) clamped++;
		lines.push(
			`  ${dimension.padEnd(DIMENSION_LABEL_WIDTH)}: ${shown.value} (soft ${displayThreshold(soft[dimension], DEFAULT_ADVISORY_SOFT[dimension])} / high ${displayThreshold(high[dimension], DEFAULT_ADVISORY_HIGH[dimension])})`,
		);
	}
	if (clamped > 0) {
		lines.push(
			`  (${clamped} current value(s) above ${MAX_ADVISORY_COUNT_DISPLAY} clamped for display — the band is evaluated on the normalized facts)`,
		);
	}
	const reasons = Array.isArray(source.reasons) ? source.reasons : [];
	const reasonText =
		reasons.length === 0
			? "(none — all dimensions below their soft thresholds)"
			: reasons
					.map((r) => {
						const dimension = typeof r?.dimension === "string" ? r.dimension : "?";
						// Per-reason band fails safe too: only the exact ok/soft/high
						// values render; anything else shows OK.
						const rawReasonBand = typeof r?.band === "string" ? r.band : "";
						const reasonBand: AdvisoryBand =
							rawReasonBand === "ok" || rawReasonBand === "soft" || rawReasonBand === "high" ? rawReasonBand : "ok";
						return `${dimension} (${reasonBand.toUpperCase()})`;
					})
					.join("; ");
	lines.push(`  ${"reasons".padEnd(DIMENSION_LABEL_WIDTH)}: ${reasonText}`);
	return lines;
}
