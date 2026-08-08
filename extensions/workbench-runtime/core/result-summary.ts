/**
 * P1 recipe/gate parent-result summary policy (commander-token-optimization
 * plan §8) — pure, deterministic, unit-testable with plain node:test.
 *
 * The parent toolResult for `workbench_run_recipe` / `workbench_run_gate`
 * (and the `/q-run` / `/q-gate` slash commands) is a BOUNDED presentation
 * summary, never the raw run output:
 *
 *   - success summaries are <= 4096 UTF-8 bytes and <= 40 lines and inline
 *     NO raw stdout/stderr and NO per-test success lines;
 *   - failure/timeout/cancelled summaries are <= 12288 UTF-8 bytes and
 *     <= 120 lines and follow the fixed failure-information precedence:
 *       1. status / exit code (and which command)
 *       2. failing test names/count (when recognizable from Node TAP)
 *       3. first root-cause line
 *       4. timeout / cancelled
 *       5. warning count (warnings-with-exit-0 must be visible)
 *       6. full log paths (and other persisted artifact paths)
 *       7. omission facts (what the summary does NOT contain)
 *     bounded raw excerpts may follow ONLY after these required facts —
 *     AFTER the machine-summary disclaimer — into strictly remaining
 *     capacity, and are the FIRST thing dropped under pressure;
 *   - gate summaries pass through the same caps: status/exit, failing and
 *     blocked gate identifiers + reasons BEFORE passing-gate detail, the
 *     full persisted record path, and omission facts;
 *   - caps are measured in UTF-8 bytes and lines; newline separators are
 *     counted in the byte budget; every truncation is code-point safe (a
 *     code point is never split) and deterministic.
 *
 * GUARANTEED-FIT POLICY (total over every defensive input):
 *   - every untrusted display field (command, artifact paths, cache facts,
 *     failing test names, root cause, gate ids/titles/reasons, requested
 *     selectors, profile, status, run ids, log/record paths) is
 *     sanitized (control characters replaced — a field can never inject
 *     extra lines) and bounded to a documented UTF-8 byte budget; bounded
 *     display is always accompanied by an explicit omission fact;
 *   - lists that are too large render a bounded number of items plus the
 *     EXACT omitted count (never an overflowing join, never a silent drop);
 *   - custom caps are configurable ONLY within documented safe bounds
 *     (MIN_RESULT_SUMMARY_CAPS .. MAX_RESULT_SUMMARY_CAPS): malformed
 *     values resolve to the defaults, unrealistically tiny values clamp to
 *     the safe minima that can always hold the required facts, and huge
 *     values clamp to the safe maxima;
 *   - the required-fact block (status .. omissions .. note) is bounded by
 *     construction and always fits the safe minima; the emitted summary
 *     therefore ALWAYS satisfies the resolved caps — `withinCaps` is
 *     always true and no "caps EXCEEDED" line is ever emitted. A defensive
 *     minimal fallback exists for unreachable pathological states and
 *     still fits the minima.
 *
 * This module NEVER reads files, NEVER claims acceptance, and NEVER
 * rewrites persisted records — full logs/records stay on disk, byte-for-
 * byte unchanged, and are always referenced by path. A summary is
 * presentation only and is never acceptance evidence.
 *
 * Warning detection is a conservative, deterministic line detector over
 * the (already redacted, recipe-bounded) stdout/stderr views: a line
 * counts when it contains the word warn/warning (case-insensitive,
 * word-bounded). A non-empty stderr that yields zero detected warnings is
 * surfaced as an explicit anomaly fact with its path — never hidden.
 *
 * TAP totals are recognized from Node's test-runner summary block — both
 * the classic TAP form (`# tests N`, `# pass N`, `# fail N`, `# skipped
 * N`, `# cancelled N`, `# todo N`, `# duration_ms N`) and Node's default
 * spec-reporter form (`ℹ tests N`, `ℹ pass N`, `ℹ fail N`, `ℹ cancelled
 * N`, `ℹ skipped N`, `ℹ todo N`, `ℹ duration_ms N`), which is what the
 * project's own `unit-test` recipe emits. Last occurrence wins,
 * deterministic; per-test lines (`✔ name (12ms)`) never match. Failing
 * test names are recognized from classic TAP `not ok N - name` lines and
 * the spec reporter's `✖ name (12ms)` failure lines.
 */

/** P1 presentation caps (starting values per the plan §8; configurable within safe bounds). */
export interface ResultSummaryCaps {
	successMaxBytes: number;
	successMaxLines: number;
	failureMaxBytes: number;
	failureMaxLines: number;
}

export const DEFAULT_RESULT_SUMMARY_CAPS: ResultSummaryCaps = Object.freeze({
	successMaxBytes: 4096,
	successMaxLines: 40,
	failureMaxBytes: 12288,
	failureMaxLines: 120,
});

/**
 * Documented safe MINIMUM caps: the smallest values that can always hold
 * the required-fact block (status/exit .. omissions .. note) for the most
 * adversarial defensive input, because every field is bounded and every
 * list shows bounded items plus the exact omitted count. Custom caps below
 * these minima clamp up to them (the production invariants stay
 * satisfiable); caps above MAX clamp down.
 */
export const MIN_RESULT_SUMMARY_CAPS: ResultSummaryCaps = Object.freeze({
	successMaxBytes: 3584,
	successMaxLines: 32,
	failureMaxBytes: 8192,
	failureMaxLines: 40,
});

/** Documented safe MAXIMUM caps (a summary is presentation, never unbounded). */
export const MAX_RESULT_SUMMARY_CAPS: ResultSummaryCaps = Object.freeze({
	successMaxBytes: 8192,
	successMaxLines: 80,
	failureMaxBytes: 24576,
	failureMaxLines: 240,
});

/** TAP totals recognized from Node's test-runner summary block. */
export interface TapTotals {
	tests?: number;
	pass?: number;
	fail?: number;
	skipped?: number;
	cancelled?: number;
	todo?: number;
	durationMs?: number;
}

/**
 * Bounded display-list limits. All MAX_*_CHARS constants are UTF-8 BYTE
 * budgets (truncation is code-point safe and adds an explicit "…").
 */
export const MAX_FAILING_TEST_NAMES = 20;
export const MAX_FAILING_TEST_NAME_CHARS = 120;
export const MAX_ROOT_CAUSE_CHARS = 240;
export const MAX_FAILING_GATES = 20;
export const MAX_GATE_REASON_CHARS = 120;
export const MAX_GATE_TITLE_CHARS = 80;
export const MAX_GATE_ID_CHARS = 64;
export const MAX_GATE_STATUS_CHARS = 16;
export const MAX_RUN_ID_CHARS = 64;
export const MAX_RECIPE_CHARS = 64;
export const MAX_COMMAND_CHARS = 200;
export const MAX_PROFILE_CHARS = 64;
export const MAX_ARTIFACT_PATHS = 8;
export const MAX_ARTIFACT_PATH_CHARS = 80;
export const MAX_ARTIFACT_LINE_BYTES = 700;
export const MAX_REQUESTED_SELECTORS = 8;
export const MAX_REQUESTED_CHARS = 64;
export const MAX_REQUESTED_LINE_BYTES = 720;
export const MAX_CACHE_STATUS_CHARS = 16;
export const MAX_CACHE_KEY_CHARS = 16;
export const MAX_CACHE_RUN_ID_CHARS = 64;
export const MAX_CACHE_REASON_CHARS = 120;
export const MAX_CACHE_LINE_BYTES = 320;
export const MAX_LOG_PATH_CHARS = 300;
export const MAX_RECORD_PATH_CHARS = 400;
export const MAX_OMISSIONS_CHARS = 480;
export const MAX_EXCERPT_LINE_BYTES = 240;
export const MAX_EXCERPT_HEADER_BYTES = 420;

// ---------------------------------------------------------------------------
// UTF-8 / code-point-safe helpers
// ---------------------------------------------------------------------------

/** Exact UTF-8 byte length of a string (deterministic). */
export function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * Code-point-safe UTF-8 byte truncation: never splits a code point
 * (surrogate pairs and astral characters stay intact), deterministic.
 * `maxBytes <= 0` yields the empty string.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
	let used = 0;
	const out: string[] = [];
	for (const ch of text) {
		const bytes = utf8Bytes(ch);
		if (used + bytes > maxBytes) return { text: out.join(""), truncated: true };
		used += bytes;
		out.push(ch);
	}
	return { text: out.join(""), truncated: false };
}

const CONTROL_RE = /[\x00-\x1f\x7f]/g;

/**
 * Sanitize an untrusted display field: control characters (including
 * newlines — a field must never inject extra summary lines) are replaced
 * by a single space, deterministically. Non-string values render as
 * "(invalid)" so the policy never throws on defensive input.
 */
function inline(text: unknown): string {
	if (typeof text !== "string") return "(invalid)";
	return text.replace(CONTROL_RE, " ");
}

/**
 * Bound an untrusted display field to `maxBytes` UTF-8 bytes, code-point
 * safe, with an explicit "…" marker when truncated. Newlines/control
 * characters inside the field are sanitized first.
 */
function boundedBytes(text: unknown, maxBytes: number): string {
	const cleaned = inline(text);
	const cut = truncateUtf8Bytes(cleaned, maxBytes);
	if (!cut.truncated) return cleaned;
	if (maxBytes < 3) return cut.text;
	return `${truncateUtf8Bytes(cleaned, maxBytes - 3).text}…`;
}

/**
 * Deterministic number rendering for display: finite numbers render
 * exactly (String(n), bounded — the largest finite double is ~24 chars),
 * anything else renders "?".
 */
function num(value: number): string {
	return Number.isFinite(value) ? String(value) : "?";
}

/**
 * Join display items into ONE inline line bounded to `maxBytes` bytes:
 * shows at most `maxItems` items (each bounded to `itemMaxBytes`); when
 * items were dropped, appends the EXACT omitted count ("(+N more …)").
 * Items are dropped (never the count suffix) until the line fits, so the
 * exact omitted count always survives. Returns the line plus the actual
 * number of items shown (so structured omitted counts stay exact).
 */
function joinBounded(
	items: readonly unknown[],
	maxBytes: number,
	maxItems: number,
	itemMaxBytes: number,
	moreLabel: string,
	moreWhere: string,
): { line: string; shown: number } {
	const boundedItems = items.slice(0, maxItems).map((item) => boundedBytes(item, itemMaxBytes));
	let shown = boundedItems.length;
	for (;;) {
		let line = boundedItems.slice(0, shown).join(", ");
		if (items.length > shown) line += ` (+${items.length - shown} more ${moreLabel} omitted — ${moreWhere})`;
		if (utf8Bytes(line) <= maxBytes || shown === 0) return { line, shown };
		shown--;
	}
}

// ---------------------------------------------------------------------------
// Machine-derived fact detectors (deterministic, never throw)
// ---------------------------------------------------------------------------

/**
 * Node test-runner totals: classic TAP (`# tests N`) and Node's default
 * spec reporter (`ℹ tests N` — the format the project's own `unit-test`
 * recipe emits). The LAST occurrence of a key wins (deterministic).
 * Per-test lines (`✔ name (12ms)`) never match because the key must be
 * followed by a bare number at end of line; non-finite values (digit
 * strings overflowing to Infinity) are rejected.
 */
const TAP_FACT_RE = /^(?:#|ℹ)\s*(tests|pass|fail|cancelled|skipped|todo|duration_ms)\s+(\d+(?:\.\d+)?)\s*$/;

export function parseTapTotals(text: unknown): TapTotals | null {
	const totals: TapTotals = {};
	let any = false;
	for (const line of typeof text === "string" ? text.split("\n") : []) {
		const match = TAP_FACT_RE.exec(line);
		if (!match) continue;
		const value = Number(match[2]);
		if (!Number.isFinite(value)) continue;
		any = true;
		switch (match[1]) {
			case "tests":
				totals.tests = value;
				break;
			case "pass":
				totals.pass = value;
				break;
			case "fail":
				totals.fail = value;
				break;
			case "skipped":
				totals.skipped = value;
				break;
			case "cancelled":
				totals.cancelled = value;
				break;
			case "todo":
				totals.todo = value;
				break;
			case "duration_ms":
				totals.durationMs = value;
				break;
		}
	}
	return any ? totals : null;
}

const NOT_OK_RE = /^not ok \d+(?: - | )(.*)$/;
const SPEC_FAIL_RE = /^✖ (.+)$/;
/** Node appends the run time to spec-reporter failure lines: `✖ name (12ms)`. */
const TRAILING_MS_RE = /\s*\(\d+(?:\.\d+)?ms\)\s*$/;

/**
 * Failing test names from Node test-runner output, in order: classic TAP
 * `not ok N - name` lines plus the default spec reporter's `✖ name (12ms)`
 * failure lines (the format the project's own `unit-test` recipe emits).
 * The trailing ` (12ms)` run time is stripped from spec names. Deterministic.
 */
export function parseFailingTestNames(text: unknown): string[] {
	const names: string[] = [];
	for (const line of typeof text === "string" ? text.split("\n") : []) {
		const tap = NOT_OK_RE.exec(line);
		if (tap) {
			const name = tap[1]!.trim();
			if (name.length > 0) names.push(name);
			continue;
		}
		const spec = SPEC_FAIL_RE.exec(line);
		if (spec) {
			const name = spec[1]!.trim().replace(TRAILING_MS_RE, "");
			if (name.length > 0) names.push(name);
		}
	}
	return names;
}

const ROOT_CAUSE_RE = /(?:^|\s)(?:Error|AssertionError|TypeError|ReferenceError|RangeError|SyntaxError|EvalError|URIError)\b/;
const TAP_FAILURE_MESSAGE_RE = /^message:\s*/;

/**
 * First root-cause line: scan stdout then stderr for the first line that
 * names an error type or starts a Node TAP failure `message:` detail.
 * Bounded to `maxBytes` UTF-8 bytes with an explicit ellipsis. Returns
 * null when nothing error-like is found.
 */
export function detectRootCause(stdout: unknown, stderr: unknown, maxBytes = MAX_ROOT_CAUSE_CHARS): string | null {
	for (const stream of [stdout, stderr]) {
		for (const line of typeof stream === "string" ? stream.split("\n") : []) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			if (ROOT_CAUSE_RE.test(trimmed) || TAP_FAILURE_MESSAGE_RE.test(trimmed)) {
				const cleaned = trimmed.replace(TAP_FAILURE_MESSAGE_RE, "").trim();
				return boundedBytes(cleaned, maxBytes);
			}
		}
	}
	return null;
}

const WARNING_LINE_RE = /\bwarn(?:ing)?s?\b/i;

/**
 * Conservative deterministic warning-line detector: count lines containing
 * the word warn/warning (case-insensitive, word-bounded) across the given
 * streams, in order. Conservative = may over-detect, never silently
 * misses a visible warning line.
 */
export function countWarningLines(...streams: readonly unknown[]): number {
	let count = 0;
	for (const stream of streams) {
		for (const line of typeof stream === "string" ? stream.split("\n") : []) {
			if (WARNING_LINE_RE.test(line)) count++;
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Caps resolution
// ---------------------------------------------------------------------------

/**
 * Resolve effective caps, deterministically:
 *   - malformed values (non-number, NaN/±Infinity, negative) fall back to
 *     the DEFAULT caps;
 *   - valid values clamp to the documented safe bounds
 *     (MIN_RESULT_SUMMARY_CAPS .. MAX_RESULT_SUMMARY_CAPS), so the
 *     guaranteed-fit invariants stay satisfiable for every input;
 *   - fractional values floor to whole units.
 */
export function resolveCaps(caps?: Partial<ResultSummaryCaps>): ResultSummaryCaps {
	const pick = (value: number | undefined, fallback: number, min: number, max: number): number => {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
		return Math.min(max, Math.max(min, Math.floor(value)));
	};
	return {
		successMaxBytes: pick(caps?.successMaxBytes, DEFAULT_RESULT_SUMMARY_CAPS.successMaxBytes, MIN_RESULT_SUMMARY_CAPS.successMaxBytes, MAX_RESULT_SUMMARY_CAPS.successMaxBytes),
		successMaxLines: pick(caps?.successMaxLines, DEFAULT_RESULT_SUMMARY_CAPS.successMaxLines, MIN_RESULT_SUMMARY_CAPS.successMaxLines, MAX_RESULT_SUMMARY_CAPS.successMaxLines),
		failureMaxBytes: pick(caps?.failureMaxBytes, DEFAULT_RESULT_SUMMARY_CAPS.failureMaxBytes, MIN_RESULT_SUMMARY_CAPS.failureMaxBytes, MAX_RESULT_SUMMARY_CAPS.failureMaxBytes),
		failureMaxLines: pick(caps?.failureMaxLines, DEFAULT_RESULT_SUMMARY_CAPS.failureMaxLines, MIN_RESULT_SUMMARY_CAPS.failureMaxLines, MAX_RESULT_SUMMARY_CAPS.failureMaxLines),
	};
}

/**
 * A line accumulator with EXACT accounting: `usedBytes` counts the UTF-8
 * bytes of every line PLUS one byte per newline separator (the final text
 * is `lines.join("\n")`). Required lines are added unconditionally (they
 * are bounded by construction and always fit the resolved caps); optional
 * lines (excerpts, passing-gate detail) are added only when BOTH caps
 * still have room.
 */
class LineBudget {
	readonly lines: string[] = [];
	private bytes = 0;
	constructor(
		private readonly maxBytes: number,
		private readonly maxLines: number,
	) {}

	addRequired(line: string): void {
		this.bytes += utf8Bytes(line) + (this.lines.length > 0 ? 1 : 0);
		this.lines.push(line);
	}

	tryAdd(line: string): boolean {
		const lineBytes = utf8Bytes(line);
		if (this.lines.length + 1 > this.maxLines) return false;
		if (this.bytes + lineBytes + (this.lines.length > 0 ? 1 : 0) > this.maxBytes) return false;
		this.bytes += lineBytes + (this.lines.length > 0 ? 1 : 0);
		this.lines.push(line);
		return true;
	}

	get usedBytes(): number {
		return this.bytes;
	}

	get maxLinesRemaining(): number {
		return Math.max(0, this.maxLines - this.lines.length);
	}

	get maxBytesRemaining(): number {
		return Math.max(0, this.maxBytes - this.bytes);
	}
}

// ---------------------------------------------------------------------------
// Recipe parent-result summary
// ---------------------------------------------------------------------------

export interface RecipeParentSummaryInput {
	runId: string;
	recipe: string;
	/** Display form of the executed command (already redacted by the runner). */
	command: string;
	ok: boolean;
	exitCode: number | null;
	durationMs: number;
	timedOut: boolean;
	cancelled: boolean;
	/** Already redacted, recipe-bounded stdout view (never the full log). */
	stdout: string;
	/** Already redacted, recipe-bounded stderr view (never the full log). */
	stderr: string;
	stdoutLogPath: string;
	stderrLogPath: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	artifactPaths: readonly string[];
	cache?: {
		status: string;
		actionKey?: string;
		reusedFromRunId?: string;
		reason?: string;
	} | null;
	caps?: Partial<ResultSummaryCaps>;
}

export interface RecipeParentSummary {
	lines: string[];
	text: string;
	utf8Bytes: number;
	/**
	 * Always true by construction: the required facts are bounded and the
	 * resolved caps never go below the safe minima, so the emitted summary
	 * always fits (excerpts are dropped first and only ever use remaining
	 * capacity).
	 */
	withinCaps: boolean;
	/** The resolved (clamped) caps used for this summary. */
	caps: ResultSummaryCaps;
	tap: TapTotals | null;
	failingTests: string[];
	/** Failing test names parsed but not listed (explicit omission fact). */
	failingTestsOmitted: number;
	/** Artifact paths parsed but not listed (explicit omission fact). */
	artifactsOmitted: number;
	rootCause: string | null;
	warningCount: number;
	stderrNonEmpty: boolean;
	/** Non-empty stderr with zero detected warnings (explicit anomaly fact). */
	stderrAnomaly: boolean;
	/** Raw excerpt lines appended after the required facts (failures only). */
	excerptLines: number;
	/** The individual facts joined into the `omissions :` line. */
	omissionFacts: readonly string[];
}

/** Build the bounded `cache :` fact line (every field bounded). */
function cacheFactLine(cache: NonNullable<RecipeParentSummaryInput["cache"]>): string {
	const parts: string[] = [boundedBytes(cache.status, MAX_CACHE_STATUS_CHARS).toUpperCase()];
	if (cache.reusedFromRunId) parts.push(`reused ${boundedBytes(cache.reusedFromRunId, MAX_CACHE_RUN_ID_CHARS)}`);
	if (cache.actionKey) parts.push(`key ${boundedBytes(cache.actionKey, MAX_CACHE_KEY_CHARS)}`);
	if (cache.reason) parts.push(boundedBytes(cache.reason, MAX_CACHE_REASON_CHARS));
	return boundedBytes(parts.join(" — "), MAX_CACHE_LINE_BYTES);
}

const MINIMAL_FALLBACK_MARKER = "summary    : MINIMAL FALLBACK —";

/**
 * Defensive minimal summary, used ONLY when the required-fact block does
 * not fit (unreachable under clamped caps — every field is bounded and the
 * minima are chosen to hold the worst-case required block). Fits the safe
 * minima by construction, so the bounded-output invariant is total.
 */
function buildMinimalFallback(input: RecipeParentSummaryInput, status: string, caps: ResultSummaryCaps): RecipeParentSummary {
	const exitCode = input.exitCode === null ? "killed" : num(input.exitCode);
	const lines = [
		`status     : ${status}`,
		`exit code  : ${exitCode}`,
		`run id     : ${boundedBytes(input.runId, MAX_RUN_ID_CHARS)}`,
		`command    : ${boundedBytes(input.command, MAX_COMMAND_CHARS)}`,
		`stdout log : ${boundedBytes(input.stdoutLogPath, MAX_LOG_PATH_CHARS)} (full log on disk)`,
		`stderr log : ${boundedBytes(input.stderrLogPath, MAX_LOG_PATH_CHARS)} (full log on disk)`,
		"omissions  : summary degraded to the minimal form — full evidence in the persisted run record",
		"note       : machine-derived summary — full evidence is persisted at the paths above; a summary is never acceptance evidence",
	];
	const text = lines.join("\n");
	return {
		lines,
		text,
		utf8Bytes: utf8Bytes(text),
		withinCaps: true,
		caps,
		tap: null,
		failingTests: [],
		failingTestsOmitted: 0,
		artifactsOmitted: 0,
		rootCause: null,
		warningCount: 0,
		stderrNonEmpty: false,
		stderrAnomaly: false,
		excerptLines: 0,
		omissionFacts: ["summary degraded to the minimal form — required facts not representable within caps"],
	};
}

/**
 * Build the bounded parent summary for a recipe result (P1 §8). Success:
 * status/exit, duration, artifacts, cache, log paths, recognized TAP
 * totals, warning/anomaly facts, explicit omission facts — never raw
 * stdout/stderr, never per-test success lines. Failure: the fixed
 * precedence order above, with bounded raw excerpts only after the
 * required facts (including the note). Every untrusted field is bounded
 * with explicit omission facts; lists render bounded items plus the exact
 * omitted count; the emitted summary ALWAYS fits the resolved caps.
 */
export function buildRecipeParentSummary(input: RecipeParentSummaryInput): RecipeParentSummary {
	const caps = resolveCaps(input.caps);
	const failure = !input.ok || input.timedOut || input.cancelled;
	const maxBytes = failure ? caps.failureMaxBytes : caps.successMaxBytes;
	const maxLines = failure ? caps.failureMaxLines : caps.successMaxLines;

	const status = input.timedOut ? "TIMED OUT" : input.cancelled ? "CANCELLED" : input.ok ? "OK" : "FAILED";
	const tap = parseTapTotals(input.stdout);
	const failingTests = parseFailingTestNames(input.stdout);
	const rootCause = failure ? detectRootCause(input.stdout, input.stderr) : null;
	const warningCount = countWarningLines(input.stdout, input.stderr);
	const stderrNonEmpty = typeof input.stderr === "string" && input.stderr.trim().length > 0;
	const stderrAnomaly = stderrNonEmpty && countWarningLines(input.stderr) === 0;

	const budget = new LineBudget(maxBytes, maxLines);
	const omissionFacts: string[] = [];
	const artifacts = Array.isArray(input.artifactPaths) ? input.artifactPaths : [];

	// -- 1. status / exit code (and which command) -------------------------
	budget.addRequired(`status     : ${status}`);
	budget.addRequired(`run id     : ${boundedBytes(input.runId, MAX_RUN_ID_CHARS)}`);
	budget.addRequired(`recipe     : ${boundedBytes(input.recipe, MAX_RECIPE_CHARS)}`);
	budget.addRequired(`exit code  : ${input.exitCode === null ? "killed" : num(input.exitCode)}`);
	budget.addRequired(`command    : ${boundedBytes(input.command, MAX_COMMAND_CHARS)}`);
	budget.addRequired(`duration   : ${num(input.durationMs)} ms`);
	const artifactsLine = joinBounded(
		artifacts,
		MAX_ARTIFACT_LINE_BYTES,
		MAX_ARTIFACT_PATHS,
		MAX_ARTIFACT_PATH_CHARS,
		"artifact path(s)",
		"full list in the run record",
	);
	const artifactsOmitted = artifacts.length - artifactsLine.shown;
	budget.addRequired(`artifacts  : ${artifacts.length > 0 ? artifactsLine.line : "(none)"}`);
	if (artifactsOmitted > 0) omissionFacts.push(`${artifactsOmitted} artifact path(s) omitted (bounded display)`);
	if (input.cache && typeof input.cache === "object") {
		budget.addRequired(`cache      : ${cacheFactLine(input.cache)}`);
		omissionFacts.push("cache facts bounded (display)");
	}

	// -- recognized TAP totals (status block, never raw output) ------------
	if (tap) {
		const parts = [`${num(tap.tests ?? NaN)} tests`];
		if (tap.pass !== undefined) parts.push(`${num(tap.pass)} passed`);
		if (tap.fail !== undefined) parts.push(`${num(tap.fail)} failed`);
		if (tap.skipped !== undefined) parts.push(`${num(tap.skipped)} skipped`);
		if (tap.cancelled !== undefined) parts.push(`${num(tap.cancelled)} cancelled`);
		if (tap.todo !== undefined) parts.push(`${num(tap.todo)} todo`);
		if (tap.durationMs !== undefined) parts.push(`duration ${num(tap.durationMs)} ms`);
		budget.addRequired(`tests      : ${parts.join(", ")} (Node TAP)`);
	}

	// -- 2. failing test names/count (when recognizable) -------------------
	let failingTestsOmitted = 0;
	if (failure && failingTests.length > 0) {
		const total = tap?.fail ?? failingTests.length;
		budget.addRequired(`failing tests: ${num(total)} of ${num(tap?.tests ?? NaN)} — names below`);
		const shown = failingTests.slice(0, MAX_FAILING_TEST_NAMES);
		for (const name of shown) {
			budget.addRequired(`  - ${boundedBytes(name, MAX_FAILING_TEST_NAME_CHARS)}`);
		}
		failingTestsOmitted = failingTests.length - shown.length;
		if (failingTestsOmitted > 0) {
			budget.addRequired(
				`  (+${failingTestsOmitted} more failing test names omitted — full names in ${boundedBytes(input.stdoutLogPath, 80)})`,
			);
		}
	}

	// -- 3. first root-cause line ------------------------------------------
	if (failure && rootCause) budget.addRequired(`root cause : ${rootCause}`);

	// -- 4. timeout / cancelled --------------------------------------------
	if (failure) {
		budget.addRequired(`timeout    : ${input.timedOut ? "yes" : "no"}`);
		budget.addRequired(`cancelled  : ${input.cancelled ? "yes" : "no"}`);
	}

	// -- 5. warning count (warnings-with-exit-0 must be visible) -----------
	budget.addRequired(`warnings   : ${num(warningCount)}${warningCount === 0 ? " (none detected)" : " (see logs)"}`);
	if (stderrAnomaly) {
		budget.addRequired(`stderr     : non-empty with no detected warnings — see ${boundedBytes(input.stderrLogPath, 240)}`);
	}

	// -- 6. full log paths (and other persisted artifact paths) ------------
	budget.addRequired(`stdout log : ${boundedBytes(input.stdoutLogPath, MAX_LOG_PATH_CHARS)} (full log on disk)`);
	budget.addRequired(`stderr log : ${boundedBytes(input.stderrLogPath, MAX_LOG_PATH_CHARS)} (full log on disk)`);
	if (utf8Bytes(inline(input.stdoutLogPath)) > MAX_LOG_PATH_CHARS || utf8Bytes(inline(input.stderrLogPath)) > MAX_LOG_PATH_CHARS) {
		omissionFacts.push("log path(s) bounded (display) — full path in the run record");
	}
	if (utf8Bytes(inline(input.command)) > MAX_COMMAND_CHARS) omissionFacts.push("command bounded (display)");

	// -- 7. omission facts --------------------------------------------------
	if (failure) {
		omissionFacts.push("stdout/stderr inlined only as bounded excerpts after these facts (never before)");
	} else {
		omissionFacts.push("stdout/stderr NOT inlined (P1 policy)");
		omissionFacts.push("no per-test success lines");
	}
	if (input.stdoutTruncated || input.stderrTruncated) {
		omissionFacts.push("log views bounded by the recipe output_strategy (full logs on disk)");
	}
	if (failingTestsOmitted > 0) omissionFacts.push(`${failingTestsOmitted} failing test name(s) omitted (bounded display)`);
	omissionFacts.push("full logs/records stay persisted and unchanged — read them at the paths above");
	budget.addRequired(`omissions  : ${boundedBytes(omissionFacts.join("; "), MAX_OMISSIONS_CHARS)}`);

	// -- machine-derived disclaimer (required, ALWAYS before excerpts) -----
	budget.addRequired("note       : machine-derived summary — full evidence is persisted at the paths above; a summary is never acceptance evidence");

	let withinCaps = budget.lines.length <= maxLines && budget.usedBytes <= maxBytes;
	if (!withinCaps) {
		// Unreachable under clamped caps (bounded fields + safe minima);
		// total defense keeps the emitted result bounded no matter what.
		return buildMinimalFallback(input, status, caps);
	}

	// -- bounded raw excerpts (failures only, AFTER all required facts) -----
	let excerptLines = 0;
	if (failure) {
		const streams: ReadonlyArray<readonly [string, unknown, string]> = [
			["stdout", input.stdout, input.stdoutLogPath],
			["stderr", input.stderr, input.stderrLogPath],
		];
		for (const [name, view, path] of streams) {
			const raw = typeof view === "string" ? view.split("\n") : [];
			while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
			if (raw.length === 0) continue;
			const displayLines = raw.map((line) => boundedBytes(line, MAX_EXCERPT_LINE_BYTES));
			// Select the longest tail that fits together with its header,
			// using exact accounting (newline separators included).
			let tail = 0;
			let tailBytes = 0;
			for (let i = displayLines.length - 1; i >= 0; i--) {
				const lineBytes = utf8Bytes(displayLines[i]!);
				const separator = tail > 0 ? 1 : 0;
				if (budget.maxLinesRemaining < 2 + tail) break;
				if (budget.maxBytesRemaining < MAX_EXCERPT_HEADER_BYTES + tailBytes + lineBytes + separator) break;
				tail++;
				tailBytes += lineBytes + separator;
			}
			if (tail === 0) continue;
			const header = `--- ${name} excerpt (last ${tail} of ${raw.length} lines; full log at ${boundedBytes(path, 240)}) ---`;
			if (!budget.tryAdd(header)) continue;
			for (let i = raw.length - tail; i < raw.length; i++) {
				if (!budget.tryAdd(displayLines[i]!)) break;
				excerptLines++;
			}
		}
	}

	const lines = budget.lines;
	const text = lines.join("\n");
	return {
		lines,
		text,
		utf8Bytes: utf8Bytes(text),
		withinCaps: true,
		caps,
		tap,
		failingTests,
		failingTestsOmitted,
		artifactsOmitted,
		rootCause,
		warningCount,
		stderrNonEmpty,
		stderrAnomaly,
		excerptLines,
		omissionFacts,
	};
}

// ---------------------------------------------------------------------------
// Gate parent-result summary
// ---------------------------------------------------------------------------

export interface GateParentSummaryInput {
	runId: string;
	requested: readonly string[];
	profile: string | undefined;
	/** Gate run status: PASS | FAIL | BLOCKED | ... */
	status: string;
	gates: readonly {
		id: string;
		status: string;
		title: string;
		failure_reason: string | null;
		blocked_reason: string | null;
	}[];
	/** Full persisted gate-run record path (always named, never truncated for valid workbench paths). */
	recordPath: string;
	caps?: Partial<ResultSummaryCaps>;
}

export interface GateParentSummary {
	lines: string[];
	text: string;
	utf8Bytes: number;
	/** Always true by construction (see RecipeParentSummary.withinCaps). */
	withinCaps: boolean;
	/** The resolved (clamped) caps used for this summary. */
	caps: ResultSummaryCaps;
	/** FAIL/BLOCKED gate ids listed in the summary. */
	failingGateIds: string[];
	/** FAIL/BLOCKED gate ids parsed but not listed (explicit omission fact). */
	failingGatesOmitted: number;
	/** Passing gates whose detail line was dropped for the caps. */
	passingGatesOmitted: number;
	/** The individual facts joined into the `omissions :` line. */
	omissionFacts: readonly string[];
}

/**
 * Build the bounded parent summary for a gate run (P1 §8): status/exit,
 * failing/blocked gate identifiers + reasons BEFORE passing-gate detail,
 * the full persisted record path, and explicit omission facts. Passing /
 * not-run gate detail is optional and dropped (with an omission fact)
 * when the caps require it. Every untrusted field is bounded; the emitted
 * summary ALWAYS fits the resolved caps.
 */
export function buildGateParentSummary(input: GateParentSummaryInput): GateParentSummary {
	const caps = resolveCaps(input.caps);
	const success = input.status === "PASS";
	const maxBytes = success ? caps.successMaxBytes : caps.failureMaxBytes;
	const maxLines = success ? caps.successMaxLines : caps.failureMaxLines;

	const gates = Array.isArray(input.gates) ? input.gates : [];
	const failing = gates.filter((g) => g.status === "FAIL" || g.status === "BLOCKED");
	const passing = gates.filter((g) => g.status === "PASS");
	const notRun = gates.filter((g) => g.status !== "PASS" && g.status !== "FAIL" && g.status !== "BLOCKED");
	const requested = Array.isArray(input.requested) ? input.requested : [];

	const budget = new LineBudget(maxBytes, maxLines);
	const omissionFacts: string[] = [];

	// -- required: status / exit -------------------------------------------
	budget.addRequired(`gate run   : ${boundedBytes(input.runId, MAX_RUN_ID_CHARS)}`);
	const requestedLine = joinBounded(requested, MAX_REQUESTED_LINE_BYTES, MAX_REQUESTED_SELECTORS, MAX_REQUESTED_CHARS, "requested selector(s)", "full list in the gate record");
	budget.addRequired(`requested  : ${requestedLine.line}`);
	if (requestedLine.shown < requested.length) {
		omissionFacts.push(`${requested.length - requestedLine.shown} requested selector(s) omitted (bounded display)`);
	}
	budget.addRequired(`profile    : ${boundedBytes(input.profile ?? "(none)", MAX_PROFILE_CHARS)}`);
	budget.addRequired(`status     : ${boundedBytes(input.status, MAX_GATE_STATUS_CHARS)}`);
	budget.addRequired(`exit code  : ${success ? 0 : 1}`);

	// -- required: failing/blocked gate identifiers + reasons --------------
	let failingGatesOmitted = 0;
	const shownFailing: typeof failing = [];
	if (failing.length > 0) {
		budget.addRequired(`failing gates (${failing.length}):`);
		const shown = failing.slice(0, MAX_FAILING_GATES);
		shownFailing.push(...shown);
		for (const g of shown) {
			const reason = g.failure_reason ?? g.blocked_reason ?? "";
			budget.addRequired(
				`  ${boundedBytes(g.id, MAX_GATE_ID_CHARS)} [${boundedBytes(g.status, MAX_GATE_STATUS_CHARS)}] ${boundedBytes(g.title, MAX_GATE_TITLE_CHARS)}${reason ? ` — ${boundedBytes(reason, MAX_GATE_REASON_CHARS)}` : ""}`,
			);
		}
		failingGatesOmitted = failing.length - shown.length;
		if (failingGatesOmitted > 0) {
			budget.addRequired(`  (+${failingGatesOmitted} more failing/blocked gates — full detail in the record path above)`);
		}
		if (
			failing.some(
				(g) =>
					utf8Bytes(inline(g.id)) > MAX_GATE_ID_CHARS ||
					utf8Bytes(inline(g.title)) > MAX_GATE_TITLE_CHARS ||
					utf8Bytes(inline(g.failure_reason ?? g.blocked_reason ?? "")) > MAX_GATE_REASON_CHARS,
			)
		) {
			omissionFacts.push("gate ids/titles/reasons bounded (display)");
		}
	}

	// -- required: full persisted record path ------------------------------
	budget.addRequired(`full record: ${boundedBytes(input.recordPath, MAX_RECORD_PATH_CHARS)}`);
	if (utf8Bytes(inline(input.recordPath)) > MAX_RECORD_PATH_CHARS) omissionFacts.push("record path bounded (display) — full path in the persisted gate record");

	// -- optional: passing / not-run gate detail (dropped under pressure) --
	let passingGatesOmitted = 0;
	const optional: string[] = [];
	if (passing.length > 0) {
		optional.push(`passing    : ${joinBounded(passing.map((g) => g.id), MAX_REQUESTED_LINE_BYTES, MAX_FAILING_GATES, MAX_GATE_ID_CHARS, "passing gate id(s)", "full list in the gate record").line} (${passing.length})`);
	}
	if (notRun.length > 0) {
		optional.push(`not run    : ${joinBounded(notRun.map((g) => g.id), MAX_REQUESTED_LINE_BYTES, MAX_FAILING_GATES, MAX_GATE_ID_CHARS, "not-run gate id(s)", "full list in the gate record").line} (${notRun.length})`);
	}
	for (const line of optional) {
		if (!budget.tryAdd(line)) {
			if (line.startsWith("passing")) passingGatesOmitted = passing.length;
		}
	}

	// -- required: omission facts -------------------------------------------
	if (passingGatesOmitted > 0) omissionFacts.push(`${passingGatesOmitted} passing gate id(s) omitted (bounded display)`);
	omissionFacts.push("per-check detail, warnings and evidence paths live in the persisted gate record");
	budget.addRequired(`omissions  : ${boundedBytes(omissionFacts.join("; "), MAX_OMISSIONS_CHARS)}`);

	// -- machine-derived disclaimer ----------------------------------------
	budget.addRequired("note       : machine-derived summary — full evidence is persisted at the record path above; a summary is never acceptance evidence");

	const withinCaps = budget.lines.length <= maxLines && budget.usedBytes <= maxBytes;
	if (!withinCaps) {
		// Unreachable under clamped caps; total defense (fits the minima).
		const lines = [
			`gate run   : ${boundedBytes(input.runId, MAX_RUN_ID_CHARS)}`,
			`status     : ${boundedBytes(input.status, MAX_GATE_STATUS_CHARS)}`,
			`exit code  : ${success ? 0 : 1}`,
			`full record: ${boundedBytes(input.recordPath, MAX_RECORD_PATH_CHARS)}`,
			"omissions  : summary degraded to the minimal form — full evidence in the persisted gate record",
			"note       : machine-derived summary — full evidence is persisted at the record path above; a summary is never acceptance evidence",
		];
		const text = lines.join("\n");
		return {
			lines,
			text,
			utf8Bytes: utf8Bytes(text),
			withinCaps: true,
			caps,
			failingGateIds: [],
			failingGatesOmitted: 0,
			passingGatesOmitted: 0,
			omissionFacts: ["summary degraded to the minimal form — required facts not representable within caps"],
		};
	}

	const lines = budget.lines;
	const text = lines.join("\n");
	return {
		lines,
		text,
		utf8Bytes: utf8Bytes(text),
		withinCaps: true,
		caps,
		failingGateIds: shownFailing.map((g) => g.id),
		failingGatesOmitted,
		passingGatesOmitted,
		omissionFacts,
	};
}
