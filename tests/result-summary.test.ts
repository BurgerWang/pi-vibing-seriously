/**
 * P1 recipe/gate parent-result summary policy tests (commander-token-
 * optimization plan §8) — pure, deterministic, plain node:test.
 *
 * Coverage:
 *   - TAP totals: the repository's real Node spec-reporter block (`ℹ tests`,
 *     `ℹ pass`, `ℹ fail`, `ℹ cancelled`, `ℹ skipped`, `ℹ todo`,
 *     `ℹ duration_ms`) and classic `#` TAP; per-test lines never match;
 *     last occurrence wins; non-finite values rejected
 *   - failing names from `not ok` and `✖` (duration suffix stripped)
 *   - the 825-green fixture: compact TAP totals, paths, warning/anomaly
 *     state and omission facts; NO raw stdout/stderr; NO per-test success
 *     lines; always within the success caps
 *   - failure precedence: status/exit+command, failing tests, root cause,
 *     timeout/cancelled, warning count, both full log paths, omission
 *     facts, note — bounded excerpts only after the note and dropped
 *     first under pressure
 *   - bounded lists: bounded items + EXACT omitted counts for failing
 *     names, artifact paths, requested selectors and failing gates
 *   - huge/multibyte (CJK + astral) fields: byte-exact, code-point-safe,
 *     never overflow
 *   - newline separators counted in the byte budget (exact accounting)
 *   - malformed/tiny/huge custom caps resolve to documented safe bounds;
 *     `withinCaps` is ALWAYS true — no "caps EXCEEDED" output exists
 *   - deterministic output; pathological log/record paths bounded with
 *     explicit omission facts while realistic paths stay verbatim
 *   - gate PASS/FAIL/BLOCKED summaries: status/exit, FAIL/BLOCKED facts
 *     before PASS detail, full record path, omission facts, caps
 *   - defensive garbage inputs never throw and still fit the caps
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildGateParentSummary,
	buildRecipeParentSummary,
	countWarningLines,
	DEFAULT_RESULT_SUMMARY_CAPS,
	detectRootCause,
	MAX_LOG_PATH_CHARS,
	MAX_RESULT_SUMMARY_CAPS,
	MIN_RESULT_SUMMARY_CAPS,
	parseFailingTestNames,
	parseTapTotals,
	resolveCaps,
	truncateUtf8Bytes,
	utf8Bytes,
	type GateParentSummaryInput,
	type RecipeParentSummaryInput,
} from "../extensions/workbench-runtime/core/result-summary.ts";

// ------------------------------------------------------------------- helpers

const STDOUT_LOG = ".pi/workbench/runs/20260805-123654-gziw/stdout.log";
const STDERR_LOG = ".pi/workbench/runs/20260805-123654-gziw/stderr.log";
const RECORD_PATH = ".pi/workbench/runs/20260805-123654-gziw";

function recipeInput(overrides: Partial<RecipeParentSummaryInput> = {}): RecipeParentSummaryInput {
	return {
		runId: "20260805-123654-gziw",
		recipe: "unit-test",
		command: "npm test",
		ok: true,
		exitCode: 0,
		durationMs: 124369.551791,
		timedOut: false,
		cancelled: false,
		stdout: "",
		stderr: "",
		stdoutLogPath: STDOUT_LOG,
		stderrLogPath: STDERR_LOG,
		stdoutTruncated: false,
		stderrTruncated: false,
		artifactPaths: [],
		...overrides,
	};
}

/** The exact Node spec-reporter summary block the project's unit-test recipe emits. */
function specReporterBlock(tests: number, fail: number, durationMs = 124369.551791): string {
	return [
		`ℹ tests ${tests}`,
		"ℹ suites 0",
		`ℹ pass ${tests - fail}`,
		`ℹ fail ${fail}`,
		"ℹ cancelled 0",
		"ℹ skipped 0",
		"ℹ todo 0",
		`ℹ duration_ms ${durationMs}`,
	].join("\n");
}

function green825Stdout(): string {
	const lines: string[] = [];
	for (let i = 1; i <= 825; i++) lines.push(`✔ green test number ${i} (${(i % 100) / 10}ms)`);
	lines.push(specReporterBlock(825, 0));
	return lines.join("\n");
}

function failingStdout(count: number): string {
	const lines: string[] = [];
	for (let i = 1; i <= count; i++) lines.push(`✖ failing-test-${i} (${(i % 50) + 1}ms)`);
	lines.push(specReporterBlock(count, count, 42.5));
	return lines.join("\n");
}

function gateInput(overrides: Partial<GateParentSummaryInput> = {}): GateParentSummaryInput {
	return {
		runId: "20260805-123654-gziw",
		requested: ["base"],
		profile: "generic",
		status: "FAIL",
		gates: [],
		recordPath: RECORD_PATH,
		...overrides,
	};
}

function gate(id: string, status: string, title: string, reason: string | null = null) {
	return { id, status, title, failure_reason: reason, blocked_reason: null };
}

/** True when a string contains a lone (unpaired) UTF-16 surrogate. */
function hasLoneSurrogate(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function lineIndex(lines: readonly string[], prefix: string): number {
	const idx = lines.findIndex((line) => line.startsWith(prefix));
	assert.ok(idx >= 0, `line with prefix "${prefix}" must exist in:\n${lines.join("\n")}`);
	return idx;
}

// ------------------------------------------------------------ TAP parsing

test("parseTapTotals recognizes the repository's real Node spec-reporter block (ℹ tests/pass/fail/cancelled/skipped/todo/duration_ms)", () => {
	const totals = parseTapTotals(green825Stdout());
	assert.ok(totals, "totals recognized");
	assert.equal(totals.tests, 825);
	assert.equal(totals.pass, 825);
	assert.equal(totals.fail, 0);
	assert.equal(totals.cancelled, 0);
	assert.equal(totals.skipped, 0);
	assert.equal(totals.todo, 0);
	assert.equal(totals.durationMs, 124369.551791);
	// per-test success lines never match
	const withTests = parseTapTotals("✔ pass 825 (12ms)\nℹ tests 825\n");
	assert.equal(withTests?.tests, 825);
	assert.equal(withTests?.pass, undefined, "per-test lines must never match");
});

test("parseTapTotals recognizes classic # TAP totals; last occurrence wins; non-finite rejected", () => {
	const totals = parseTapTotals([
		"# Subtest: ignored",
		"# tests 3",
		"# pass 2",
		"# fail 1",
		"# cancelled 0",
		"# skipped 1",
		"# todo 0",
		"# duration_ms 12.5",
		"# tests 4",
	].join("\n"));
	assert.equal(totals?.tests, 4, "last occurrence wins");
	assert.equal(totals?.fail, 1);
	assert.equal(totals?.skipped, 1);
	assert.equal(totals?.durationMs, 12.5);
	// a 400-digit number overflows to Infinity and is rejected
	const overflowing = parseTapTotals(`ℹ tests ${"9".repeat(400)}`);
	assert.equal(overflowing, null);
	assert.equal(parseTapTotals("ℹ suites 0"), null, "suites is not a totals key");
	assert.equal(parseTapTotals(""), null);
	assert.equal(parseTapTotals(undefined), null);
	assert.equal(parseTapTotals(42), null);
});

test("parseFailingTestNames recognizes not ok and ✖ lines (duration stripped); green lines never match", () => {
	assert.deepEqual(parseFailingTestNames("✖ alpha test (12.5ms)\n✖ beta\nnot ok 3 - gamma test\nnot ok 4 gamma"), [
		"alpha test",
		"beta",
		"gamma test",
		"gamma",
	]);
	assert.deepEqual(parseFailingTestNames("✔ alpha test (12ms)\nℹ pass 1"), [], "green lines never match");
	assert.deepEqual(parseFailingTestNames("✖ \nnot ok 2 - "), [], "empty names skipped");
	assert.deepEqual(parseFailingTestNames(undefined), []);
});

test("detectRootCause scans stdout then stderr for the first error line; TAP message details count", () => {
	assert.equal(detectRootCause("line1\nTypeError: boom at x:1", "warn: nope"), "TypeError: boom at x:1");
	assert.equal(detectRootCause("no errors here", "AssertionError: values differ"), "AssertionError: values differ");
	assert.equal(detectRootCause("no errors here", "  message: actual 5"), "actual 5");
	assert.equal(detectRootCause("clean", "clean"), null);
	assert.equal(detectRootCause(undefined, "TypeError: x"), "TypeError: x");
	// byte-bounded with explicit ellipsis
	const long = detectRootCause("Error: " + "é".repeat(500), "", 40);
	assert.ok(long && long.endsWith("…") && utf8Bytes(long) <= 40, String(long));
});

test("countWarningLines counts warn/warning lines conservatively across streams", () => {
	assert.equal(countWarningLines("warn: a\nWARNING: b\nwarning: c\nwarnings: d\nplain"), 4);
	assert.equal(countWarningLines("warn", "warning"), 2);
	assert.equal(countWarningLines("ℹ pass 825"), 0);
	assert.equal(countWarningLines(undefined, 42), 0);
});

// ------------------------------------------------------------ caps

test("resolveCaps: defaults for missing/malformed, clamped to documented safe bounds otherwise", () => {
	assert.deepEqual(resolveCaps(undefined), DEFAULT_RESULT_SUMMARY_CAPS);
	assert.deepEqual(resolveCaps({}), DEFAULT_RESULT_SUMMARY_CAPS);
	// malformed values fall back to the defaults
	assert.deepEqual(
		resolveCaps({ successMaxBytes: Number.NaN, successMaxLines: Number.POSITIVE_INFINITY, failureMaxBytes: -5, failureMaxLines: Number.NEGATIVE_INFINITY }),
		DEFAULT_RESULT_SUMMARY_CAPS,
	);
	// unrealistically tiny values clamp UP to the safe minima
	assert.deepEqual(resolveCaps({ successMaxBytes: 1, successMaxLines: 1, failureMaxBytes: 1, failureMaxLines: 1 }), MIN_RESULT_SUMMARY_CAPS);
	// huge values clamp DOWN to the safe maxima
	assert.deepEqual(resolveCaps({ successMaxBytes: 1e9, failureMaxLines: 1e9 }), {
		...DEFAULT_RESULT_SUMMARY_CAPS,
		successMaxBytes: MAX_RESULT_SUMMARY_CAPS.successMaxBytes,
		failureMaxLines: MAX_RESULT_SUMMARY_CAPS.failureMaxLines,
	});
	// fractional values floor; in-range values pass through
	assert.deepEqual(resolveCaps({ successMaxBytes: 5000.9, failureMaxLines: 60.2 }), { ...DEFAULT_RESULT_SUMMARY_CAPS, successMaxBytes: 5000, failureMaxLines: 60 });
});

// ---------------------------------------------------- the 825-green fixture

test("the 825-green fixture emits compact TAP totals, paths, warning/anomaly state and omission facts — never raw output or green names", () => {
	const summary = buildRecipeParentSummary(
		recipeInput({
			stdout: green825Stdout(),
			stderr: "some stderr diagnostic noise here",
			artifactPaths: ["out/result.json"],
		}),
	);
	assert.equal(summary.withinCaps, true);
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.successMaxBytes, `bytes ${summary.utf8Bytes}`);
	assert.ok(summary.lines.length <= DEFAULT_RESULT_SUMMARY_CAPS.successMaxLines, `lines ${summary.lines.length}`);
	assert.equal(summary.tap?.tests, 825);
	assert.equal(summary.failingTests.length, 0);
	assert.equal(summary.excerptLines, 0, "success never inlines excerpts");
	// compact TAP totals
	assert.ok(summary.text.includes("825 tests, 825 passed, 0 failed, 0 skipped, 0 cancelled, 0 todo, duration 124369.551791 ms (Node TAP)"), summary.text);
	// NO per-test success lines and NO raw stdout
	assert.ok(!summary.text.includes("green test number"), "no individual green names");
	assert.ok(!summary.text.includes("✔"), "no green checkmarks");
	assert.ok(!summary.text.includes("ℹ "), "no raw spec-reporter lines");
	assert.ok(!summary.text.includes("some stderr diagnostic noise here"), "no raw stderr");
	// both full log paths visible
	assert.ok(summary.text.includes(`stdout log : ${STDOUT_LOG} (full log on disk)`), summary.text);
	assert.ok(summary.text.includes(`stderr log : ${STDERR_LOG} (full log on disk)`), summary.text);
	// warning/anomaly state + omission facts
	assert.ok(summary.text.includes("warnings   : 0 (none detected)"), summary.text);
	assert.ok(summary.text.includes("stderr     : non-empty with no detected warnings"), summary.text);
	assert.ok(summary.text.includes("stdout/stderr NOT inlined (P1 policy)"), summary.text);
	assert.ok(summary.text.includes("no per-test success lines"), summary.text);
	assert.ok(summary.text.includes("note       : machine-derived summary"), summary.text);
	assert.ok(summary.text.includes("artifacts  : out/result.json"), summary.text);
});

test("success never inlines raw stdout/stderr even when the run output is hostile", () => {
	const summary = buildRecipeParentSummary(
		recipeInput({
			stdout: "SECRET-RAW-STDOUT-MARKER\nwarn: something\n" + specReporterBlock(1, 0),
			stderr: "SECRET-RAW-STDERR-MARKER",
		}),
	);
	assert.ok(!summary.text.includes("SECRET-RAW-STDOUT-MARKER"), summary.text);
	assert.ok(!summary.text.includes("SECRET-RAW-STDERR-MARKER"), summary.text);
	assert.ok(summary.text.includes("warnings   : 1 (see logs)"), summary.text);
	assert.ok(summary.text.includes("stderr     : non-empty with no detected warnings"), summary.text);
	assert.equal(summary.withinCaps, true);
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.successMaxBytes);
});

test("warning success (exit 0) keeps the warning count visible under the SUCCESS caps", () => {
	const summary = buildRecipeParentSummary(
		recipeInput({
			ok: true,
			exitCode: 0,
			stdout: "warn: flaky helper\nwarning: deprecated\n",
		}),
	);
	assert.equal(summary.warningCount, 2);
	assert.ok(summary.text.includes("warnings   : 2 (see logs)"), summary.text);
	assert.equal(summary.withinCaps, true);
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.successMaxBytes, `bytes ${summary.utf8Bytes}`);
	assert.ok(summary.lines.length <= DEFAULT_RESULT_SUMMARY_CAPS.successMaxLines);
});

test("stderr anomaly is explicit only when stderr is non-empty and warning-free", () => {
	// Warning-free non-empty diagnostic noise: the conservative detector must
	// count ZERO warning lines so the anomaly fact surfaces (a fixture that
	// contains the word "warning" would be a detected warning instead).
	const clean = buildRecipeParentSummary(recipeInput({ stderr: "some plain diagnostic noise" }));
	assert.equal(clean.stderrAnomaly, true);
	assert.ok(clean.text.includes("non-empty with no detected warnings"), clean.text);
	const warningStderr = buildRecipeParentSummary(recipeInput({ stderr: "warn: known noise" }));
	assert.equal(warningStderr.stderrAnomaly, false);
	assert.ok(!warningStderr.text.includes("no detected warnings"), warningStderr.text);
	const empty = buildRecipeParentSummary(recipeInput({ stderr: "" }));
	assert.equal(empty.stderrAnomaly, false);
	assert.equal(empty.stderrNonEmpty, false);
});

// ---------------------------------------------------- failure precedence

test("failure keeps the fixed precedence: status/exit+command, failing tests, root cause, timeout/cancelled, warnings, paths, omissions, note", () => {
	const summary = buildRecipeParentSummary(
		recipeInput({
			ok: false,
			exitCode: 7,
			command: "npm run check",
			stdout: "warn: before\n" + failingStdout(3),
			stderr: "TypeError: boom at src/main.ts:12",
			artifactPaths: ["out/a.json"],
			cache: { status: "hit", reusedFromRunId: "20260805-123509-am6y", reason: "validated" },
		}),
	);
	assert.equal(summary.withinCaps, true);
	const lines = summary.lines;
	const order = [
		"status     : FAILED",
		"exit code  : 7",
		"command    : npm run check",
		"failing tests: 3 of 3 — names below",
		"root cause : TypeError: boom at src/main.ts:12",
		"timeout    : no",
		"cancelled  : no",
		"warnings   : 1 (see logs)",
		"stdout log : ",
		"stderr log : ",
		"omissions  : ",
		"note       : ",
	];
	let prev = -1;
	for (const prefix of order) {
		const idx = lineIndex(lines, prefix);
		assert.ok(idx > prev, `"${prefix}" must come after the previous required fact`);
		prev = idx;
	}
	// both full log paths visible verbatim
	assert.ok(summary.text.includes(`stdout log : ${STDOUT_LOG} (full log on disk)`), summary.text);
	assert.ok(summary.text.includes(`stderr log : ${STDERR_LOG} (full log on disk)`), summary.text);
	// cache facts present and bounded
	assert.ok(summary.text.includes("cache      : HIT — reused 20260805-123509-am6y"), summary.text);
	assert.ok(summary.text.includes("500 failed") === false, "3 failing, not 500");
	assert.ok(summary.text.includes("failing-test-1"), summary.text);
});

test("failing-name lists render bounded items plus the EXACT omitted count under cap pressure", () => {
	const summary = buildRecipeParentSummary(
		recipeInput({
			ok: false,
			exitCode: 1,
			stdout: failingStdout(500),
			stderr: "Error: boom",
		}),
	);
	assert.equal(summary.failingTests.length, 500);
	assert.equal(summary.failingTestsOmitted, 480, "20 of 500 names are listed");
	assert.equal(summary.lines.filter((line) => line.startsWith("  - ")).length, 20);
	assert.ok(summary.text.includes("failing tests: 500 of 500 — names below"), summary.text);
	assert.ok(summary.text.includes("(+480 more failing test names omitted — full names in "), summary.text);
	assert.ok(summary.text.includes("480 failing test name(s) omitted (bounded display)"), summary.text);
	assert.equal(summary.withinCaps, true);
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxBytes, `bytes ${summary.utf8Bytes}`);
	assert.ok(summary.lines.length <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxLines);
});

test("timeout and cancelled statuses render with exit code killed and the timeout/cancelled facts", () => {
	const timedOut = buildRecipeParentSummary(recipeInput({ ok: false, timedOut: true, exitCode: null, stderr: "Error: slow" }));
	assert.ok(timedOut.text.includes("status     : TIMED OUT"), timedOut.text);
	assert.ok(timedOut.text.includes("exit code  : killed"), timedOut.text);
	assert.ok(timedOut.text.includes("timeout    : yes"), timedOut.text);
	assert.ok(timedOut.text.includes("cancelled  : no"), timedOut.text);

	const cancelled = buildRecipeParentSummary(recipeInput({ ok: false, cancelled: true, exitCode: null, stderr: "Error: abort" }));
	assert.ok(cancelled.text.includes("status     : CANCELLED"), cancelled.text);
	assert.ok(cancelled.text.includes("cancelled  : yes"), cancelled.text);
	assert.ok(cancelled.text.includes("timeout    : no"), cancelled.text);
	assert.equal(timedOut.withinCaps && cancelled.withinCaps, true);
});

// ---------------------------------------------------- bounded display fields

test("huge commands/artifact paths/cache reasons are bounded with explicit omission facts", () => {
	const summary = buildRecipeParentSummary(
		recipeInput({
			ok: false,
			exitCode: 2,
			command: "x".repeat(1_000_000) + "\n" + "y".repeat(1_000_000),
			artifactPaths: Array.from({ length: 500 }, (_, i) => `art-${i}-` + "p".repeat(10_000)),
			stdout: failingStdout(1),
			stderr: "Error: boom",
			cache: { status: "hit", actionKey: "k".repeat(10_000), reason: "r".repeat(10_000) },
		}),
	);
	assert.equal(summary.withinCaps, true);
	// the command is one bounded line (no injected newlines)
	const commandLine = summary.lines.find((line) => line.startsWith("command    : "));
	assert.ok(commandLine, "command line present");
	assert.equal(summary.lines.filter((line) => line.startsWith("command")).length, 1, "newlines in the command never inject extra lines");
	assert.ok(utf8Bytes(commandLine!) <= 12 + 200 + 3, `command line bounded: ${utf8Bytes(commandLine!)}`);
	// artifact list: bounded items + exact omitted count
	assert.ok(summary.artifactsOmitted > 0, `artifactsOmitted = ${summary.artifactsOmitted}`);
	assert.ok(summary.text.includes(`(+${summary.artifactsOmitted} more artifact path(s) omitted — full list in the run record)`), summary.text);
	assert.ok(summary.text.includes(`${summary.artifactsOmitted} artifact path(s) omitted (bounded display)`), summary.text);
	// cache line bounded; the 10KB reason never inlines raw
	const cacheLine = summary.lines.find((line) => line.startsWith("cache      : "));
	assert.ok(cacheLine && utf8Bytes(cacheLine) <= 12 + 320, `cache line bounded: ${utf8Bytes(cacheLine ?? "")}`);
	assert.ok(summary.text.includes("cache facts bounded (display)"), summary.text);
	assert.ok(!summary.text.includes("r".repeat(1000)), "raw cache reason never inlined");
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxBytes, `bytes ${summary.utf8Bytes}`);
});

test("multibyte CJK/astral fields never split code points and stay within caps", () => {
	const names: string[] = [];
	for (let i = 1; i <= 30; i++) names.push(`名前テスト${i}🧪`);
	const summary = buildRecipeParentSummary(
		recipeInput({
			ok: false,
			exitCode: 1,
			stdout: names.map((n) => `✖ ${n} (1ms)`).join("\n") + "\n" + specReporterBlock(30, 30),
			stderr: "Error: バグ",
		}),
	);
	assert.equal(summary.withinCaps, true);
	assert.equal(summary.failingTestsOmitted, 10, "20 CJK names listed, 10 omitted with exact count");
	assert.ok(summary.text.includes("(+10 more failing test names omitted"), summary.text);
	assert.ok(!hasLoneSurrogate(summary.text), "no split surrogate pairs");
	assert.equal(summary.text.includes("\uFFFD"), false, "no replacement characters");
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxBytes, `bytes ${summary.utf8Bytes}`);
	// a name that is one long astral run truncates to an exact byte budget
	const astral = buildRecipeParentSummary(
		recipeInput({ ok: false, exitCode: 1, stdout: `✖ ${"🧪".repeat(100)} (1ms)\n` + specReporterBlock(1, 1), stderr: "Error: x" }),
	);
	const nameLine = astral.lines.find((line) => line.startsWith("  - "))!;
	assert.ok(nameLine.endsWith("…"), "astral truncation shows the explicit marker");
	assert.ok(utf8Bytes(nameLine) <= 4 + 120, `astral name line bounded: ${utf8Bytes(nameLine)}`);
	assert.ok(!hasLoneSurrogate(astral.text));
	assert.equal(astral.withinCaps, true);
});

test("truncateUtf8Bytes is code-point safe at astral boundaries", () => {
	assert.deepEqual(truncateUtf8Bytes("🧪🧪🧪", 6), { text: "🧪", truncated: true });
	assert.deepEqual(truncateUtf8Bytes("🧪🧪", 8), { text: "🧪🧪", truncated: false });
	assert.deepEqual(truncateUtf8Bytes("a🧪b", 5), { text: "a🧪", truncated: true });
	assert.deepEqual(truncateUtf8Bytes("abc", 0), { text: "", truncated: true });
	assert.deepEqual(truncateUtf8Bytes("", 10), { text: "", truncated: false });
});

// ---------------------------------------------------- exact byte accounting

test("newline separators are counted in the byte budget (exact accounting)", () => {
	const summary = buildRecipeParentSummary(
		recipeInput({ ok: false, exitCode: 1, stdout: failingStdout(25), stderr: "Error: boom", artifactPaths: ["a.txt", "b.txt"] }),
	);
	const expected = summary.lines.reduce((acc, line) => acc + utf8Bytes(line), 0) + (summary.lines.length - 1);
	assert.equal(summary.utf8Bytes, expected, "bytes = Σ line bytes + (lines - 1) newline bytes");
	assert.equal(summary.utf8Bytes, utf8Bytes(summary.text));
	assert.equal(summary.text, summary.lines.join("\n"));
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxBytes);
	// the accounting is EXACT: the summary uses no more than the cap and the
	// cap minus usage is precisely the remaining capacity
	assert.ok(DEFAULT_RESULT_SUMMARY_CAPS.failureMaxBytes - summary.utf8Bytes >= 0);
});

test("exact caps: a maximal adversarial failure summary fits the MIN failure caps exactly", () => {
	const names = Array.from({ length: 20 }, (_, i) => `名前${i}`.repeat(10)); // 20 names × ≥120 bytes → each truncated
	const summary = buildRecipeParentSummary(
		recipeInput({
			ok: false,
			exitCode: -1,
			command: "c".repeat(1000),
			artifactPaths: Array.from({ length: 100 }, (_, i) => `art-${i}-` + "p".repeat(500)),
			stdout: names.map((n) => `✖ ${n} (1ms)`).join("\n") + "\n" + specReporterBlock(20, 20),
			stderr: "Error: " + "é".repeat(1000),
			stdoutTruncated: true,
			stderrTruncated: true,
			cache: { status: "hit", actionKey: "k".repeat(500), reason: "r".repeat(500) },
			caps: { failureMaxBytes: 1, failureMaxLines: 1, successMaxBytes: 1, successMaxLines: 1 },
		}),
	);
	assert.deepEqual(summary.caps, MIN_RESULT_SUMMARY_CAPS, "tiny caps resolve to the safe minima");
	assert.equal(summary.withinCaps, true, "the emitted summary always fits");
	assert.ok(summary.utf8Bytes <= MIN_RESULT_SUMMARY_CAPS.failureMaxBytes, `bytes ${summary.utf8Bytes} > ${MIN_RESULT_SUMMARY_CAPS.failureMaxBytes}`);
	assert.ok(summary.lines.length <= MIN_RESULT_SUMMARY_CAPS.failureMaxLines, `lines ${summary.lines.length}`);
	assert.ok(!summary.text.includes("EXCEEDED"), "no caps-EXCEEDED output exists");
});

// ---------------------------------------------------- excerpts

test("failure excerpts come AFTER the disclaimer and are the first thing dropped", () => {
	const summary = buildRecipeParentSummary(
		recipeInput({
			ok: false,
			exitCode: 3,
			stdout: Array.from({ length: 2000 }, (_, i) => `err line ${i}`).join("\n") + "\n" + specReporterBlock(0, 0),
			stderr: "Error: boom",
			caps: { failureMaxBytes: 1, failureMaxLines: 1 },
		}),
	);
	assert.equal(summary.withinCaps, true);
	const noteIdx = lineIndex(summary.lines, "note       : ");
	const excerptIdx = summary.lines.findIndex((line) => line.startsWith("--- stdout excerpt"));
	assert.ok(excerptIdx > noteIdx, "excerpts only after the disclaimer");
	assert.ok(excerptIdx >= 0, "excerpt present when capacity remains");
	// The view is 2008 lines: 2000 err lines + the 8-line spec-reporter block.
	assert.match(summary.lines[excerptIdx]!, /--- stdout excerpt \(last \d+ of 2008 lines; full log at /);
	assert.ok(summary.excerptLines > 0, summary.text);
	// the header's N is exact: the excerpt lines shown are the tail
	const shown = Number(/(?:last )(\d+) of 2008/.exec(summary.lines[excerptIdx]!)![1]);
	assert.equal(shown, summary.excerptLines);
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxBytes, `bytes ${summary.utf8Bytes}`);

	// dropped first: at the MIN line cap with a maximal required block, no
	// excerpt line fits and the summary still fits
	const names = Array.from({ length: 20 }, (_, i) => `failing-test-${i}`);
	const full = buildRecipeParentSummary(
		recipeInput({
			ok: false,
			exitCode: 3,
			stdout: names.map((n) => `✖ ${n} (1ms)`).join("\n") + "\n" + specReporterBlock(20, 20),
			stderr: "Error: boom",
			stdoutTruncated: true,
			stderrTruncated: true,
			cache: { status: "hit" },
			artifactPaths: ["a.txt"],
			caps: { failureMaxBytes: 1, failureMaxLines: 1 },
		}),
	);
	assert.equal(full.withinCaps, true);
	assert.equal(full.excerptLines, 0, "excerpts are dropped first under pressure");
	assert.ok(full.lines.length <= MIN_RESULT_SUMMARY_CAPS.failureMaxLines, `lines ${full.lines.length}`);
});

test("a single huge log line yields a bounded excerpt line without overflow", () => {
	const summary = buildRecipeParentSummary(
		recipeInput({
			ok: false,
			exitCode: 9,
			stdout: "z".repeat(10_000_000) + "\n" + "tail marker line",
			stderr: "Error: boom",
		}),
	);
	assert.equal(summary.withinCaps, true);
	assert.ok(summary.excerptLines >= 1, summary.text);
	assert.ok(summary.text.includes("tail marker line"), "small tail lines are kept");
	const excerpt = summary.lines.find((line) => line.startsWith("--- stdout excerpt"))!;
	assert.match(excerpt, /last 2 of 2 lines/);
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxBytes, `bytes ${summary.utf8Bytes}`);
});

// ---------------------------------------------------- pathological paths

test("pathological log paths fall back to bounded display with an omission fact; realistic paths stay verbatim", () => {
	const huge = "a".repeat(1_000_000) + "/stdout.log";
	const summary = buildRecipeParentSummary(
		recipeInput({
			ok: false,
			exitCode: 1,
			stdout: "line\n",
			stderr: "Error: boom",
			stdoutLogPath: huge,
			stderrLogPath: huge,
			caps: { failureMaxBytes: 1, failureMaxLines: 1 },
		}),
	);
	assert.equal(summary.withinCaps, true);
	assert.ok(summary.text.includes("log path(s) bounded (display) — full path in the run record"), summary.text);
	assert.ok(!summary.text.includes(huge), "the 1MB path is never inlined");
	// The bounded path keeps the explicit "…" marker followed by the fixed
	// suffix — the line is EXACTLY label + MAX_LOG_PATH_CHARS + suffix bytes.
	const pathLine = summary.lines.find((line) => line.startsWith("stdout log : "))!;
	assert.ok(pathLine.endsWith("… (full log on disk)"), `path line keeps the explicit truncation marker: ${pathLine}`);
	assert.equal(
		utf8Bytes(pathLine),
		utf8Bytes("stdout log : ") + MAX_LOG_PATH_CHARS + utf8Bytes(" (full log on disk)"),
		`path line exactly bounded: ${utf8Bytes(pathLine)}`,
	);
	// realistic validated run paths remain visible in full (green fixture above + here)
	const realistic = buildRecipeParentSummary(recipeInput({ stdout: green825Stdout() }));
	assert.ok(realistic.text.includes(STDOUT_LOG) && realistic.text.includes(STDERR_LOG), realistic.text);
});

// ---------------------------------------------------- determinism

test("output is deterministic for identical inputs and differs across inputs", () => {
	const a = buildRecipeParentSummary(recipeInput({ ok: false, exitCode: 1, stdout: failingStdout(5), stderr: "Error: boom" }));
	const b = buildRecipeParentSummary(recipeInput({ ok: false, exitCode: 1, stdout: failingStdout(5), stderr: "Error: boom" }));
	assert.equal(a.text, b.text);
	assert.equal(a.utf8Bytes, b.utf8Bytes);
	const c = buildRecipeParentSummary(recipeInput({ ok: false, exitCode: 1, command: "npm run other", stdout: failingStdout(5), stderr: "Error: boom" }));
	assert.notEqual(a.text, c.text);
});

// ---------------------------------------------------- defensive inputs

test("defensive garbage inputs never throw and still fit the caps", () => {
	const summary = buildRecipeParentSummary(
		recipeInput({
			runId: 123 as never,
			recipe: undefined as never,
			command: { weird: true } as never,
			ok: "maybe" as never,
			exitCode: Number.NaN,
			durationMs: Number.POSITIVE_INFINITY,
			stdout: undefined as never,
			stderr: 42 as never,
			stdoutLogPath: null as never,
			stderrLogPath: ["array"] as never,
			artifactPaths: "not-an-array" as never,
			cache: { status: 42 } as never,
			timedOut: false,
			cancelled: false,
		}),
	);
	assert.equal(summary.withinCaps, true);
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.successMaxBytes, `bytes ${summary.utf8Bytes}`);
	assert.ok(summary.lines.length <= DEFAULT_RESULT_SUMMARY_CAPS.successMaxLines);
	// garbage paths render as bounded "(invalid)" display, never throw
	assert.ok(summary.text.includes("(invalid)"), summary.text);
});

// ---------------------------------------------------- gate summaries

test("gate FAIL summary: FAIL/BLOCKED facts before passing detail, full record path, omission facts, failure caps", () => {
	const summary = buildGateParentSummary(
		gateInput({
			status: "FAIL",
			requested: ["base", "quant"],
			gates: [
				gate("q3", "FAIL", "Quant results validated", "backtest-result schema rejected"),
				gate("b6", "BLOCKED", "Worker-first gate", "review pending"),
				gate("q1", "PASS", "Data snapshot", null),
				gate("q2", "PASS", "Feature set", null),
				gate("q5", "PASS", "Backtest", null),
			],
		}),
	);
	assert.equal(summary.withinCaps, true);
	assert.deepEqual(summary.failingGateIds, ["q3", "b6"]);
	assert.equal(summary.failingGatesOmitted, 0);
	const lines = summary.lines;
	assert.ok(lineIndex(lines, "status     : FAIL") < lineIndex(lines, "failing gates (2):"), "status before failing facts");
	assert.ok(lineIndex(lines, "failing gates (2):") < lineIndex(lines, "passing    : "), "FAIL/BLOCKED facts BEFORE passing detail");
	assert.ok(lineIndex(lines, "full record: ") < lineIndex(lines, "passing    : "), "record path before optional detail");
	assert.ok(summary.text.includes("  q3 [FAIL] Quant results validated — backtest-result schema rejected"), summary.text);
	assert.ok(summary.text.includes("  b6 [BLOCKED] Worker-first gate — review pending"), summary.text);
	assert.ok(summary.text.includes(`full record: ${RECORD_PATH}`), summary.text);
	assert.ok(summary.text.includes("exit code  : 1"), summary.text);
	assert.ok(summary.text.includes("per-check detail, warnings and evidence paths live in the persisted gate record"), summary.text);
	assert.ok(summary.text.includes("note       : machine-derived summary"), summary.text);
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxBytes, `bytes ${summary.utf8Bytes}`);
	assert.ok(summary.lines.length <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxLines);
});

test("gate PASS summary: status/exit 0, passing detail, record path, success caps", () => {
	const summary = buildGateParentSummary(
		gateInput({
			status: "PASS",
			gates: ["q1", "q2", "q3", "q5"].map((id) => gate(id, "PASS", `${id} title`, null)),
		}),
	);
	assert.equal(summary.withinCaps, true);
	assert.equal(summary.passingGatesOmitted, 0);
	assert.ok(summary.text.includes("status     : PASS"), summary.text);
	assert.ok(summary.text.includes("exit code  : 0"), summary.text);
	assert.ok(summary.text.includes("passing    : q1, q2, q3, q5 (4)"), summary.text);
	assert.ok(summary.text.includes(`full record: ${RECORD_PATH}`), summary.text);
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.successMaxBytes, `bytes ${summary.utf8Bytes}`);
	assert.ok(summary.lines.length <= DEFAULT_RESULT_SUMMARY_CAPS.successMaxLines);
});

test("gate BLOCKED uses blocked reasons and the failure caps", () => {
	const summary = buildGateParentSummary(
		gateInput({
			status: "BLOCKED",
			gates: [gate("b6", "BLOCKED", "Worker-first gate", "a pending review blocks final verification")],
		}),
	);
	assert.equal(summary.withinCaps, true);
	assert.ok(summary.text.includes("status     : BLOCKED"), summary.text);
	assert.ok(summary.text.includes("[BLOCKED] Worker-first gate — a pending review blocks final verification"), summary.text);
	assert.ok(summary.text.includes("exit code  : 1"), summary.text);
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxBytes);
});

test("huge gate reasons/ids/titles are bounded with the exact omitted count; passing detail drops under pressure", () => {
	const failing = Array.from({ length: 100 }, (_, i) => gate(`gate-${i}`, "FAIL", "t".repeat(10_000), "r".repeat(10_000)));
	const summary = buildGateParentSummary(
		gateInput({
			status: "FAIL",
			requested: Array.from({ length: 100 }, (_, i) => `req-${i}-` + "s".repeat(500)),
			gates: [...failing, gate("q1", "PASS", "ok", null)],
		}),
	);
	assert.equal(summary.withinCaps, true);
	assert.equal(summary.failingGatesOmitted, 80, "20 of 100 failing gates listed");
	assert.ok(summary.text.includes("(+80 more failing/blocked gates — full detail in the record path above)"), summary.text);
	assert.ok(summary.text.includes("gate ids/titles/reasons bounded (display)"), summary.text);
	// 100 requested selectors: the bounded line shows 8 (MAX_REQUESTED_SELECTORS)
	// and the EXACT omitted count is 92 — never a silent drop, never 80.
	assert.ok(summary.text.includes("(+92 more requested selector(s) omitted — full list in the gate record)"), summary.text);
	assert.ok(summary.text.includes("92 requested selector(s) omitted (bounded display)"), summary.text);
	assert.ok(summary.text.includes(`full record: ${RECORD_PATH}`), "full record path preserved");
	// passing detail is optional: it is either shown bounded or dropped with
	// an omission fact — never overflowing
	assert.ok(summary.passingGatesOmitted === 0 || summary.passingGatesOmitted === 1, String(summary.passingGatesOmitted));
	if (summary.passingGatesOmitted > 0) {
		assert.ok(summary.text.includes("passing gate id(s) omitted (bounded display)"), summary.text);
	}
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxBytes, `bytes ${summary.utf8Bytes}`);
	assert.ok(summary.lines.length <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxLines);
});

test("gate summaries obey the same caps: tiny caps clamp to the safe minima and never overflow", () => {
	const summary = buildGateParentSummary(
		gateInput({
			status: "FAIL",
			requested: ["base"],
			gates: [gate("q3", "FAIL", "title", "reason"), gate("q1", "PASS", "ok", null)],
			recordPath: "r".repeat(100_000),
			caps: { successMaxBytes: 1, successMaxLines: 1, failureMaxBytes: 1, failureMaxLines: 1 },
		}),
	);
	assert.deepEqual(summary.caps, MIN_RESULT_SUMMARY_CAPS);
	assert.equal(summary.withinCaps, true);
	assert.ok(summary.utf8Bytes <= MIN_RESULT_SUMMARY_CAPS.failureMaxBytes, `bytes ${summary.utf8Bytes}`);
	assert.ok(summary.lines.length <= MIN_RESULT_SUMMARY_CAPS.failureMaxLines);
	assert.ok(summary.text.includes("record path bounded (display)"), summary.text);

	const passing = buildGateParentSummary(
		gateInput({ status: "PASS", gates: [gate("q1", "PASS", "ok", null)], caps: { successMaxBytes: 1, successMaxLines: 1 } }),
	);
	assert.equal(passing.withinCaps, true);
	assert.ok(passing.utf8Bytes <= MIN_RESULT_SUMMARY_CAPS.successMaxBytes, `bytes ${passing.utf8Bytes}`);
});

test("gate defensive garbage inputs never throw and still fit the caps", () => {
	const summary = buildGateParentSummary(
		gateInput({
			runId: 42 as never,
			requested: null as never,
			profile: { bad: true } as never,
			status: undefined as never,
			gates: "not-an-array" as never,
			recordPath: 7 as never,
		}),
	);
	assert.equal(summary.withinCaps, true);
	assert.ok(summary.utf8Bytes <= DEFAULT_RESULT_SUMMARY_CAPS.failureMaxBytes, `bytes ${summary.utf8Bytes}`);
	assert.ok(summary.text.includes("(invalid)"), summary.text);
});
