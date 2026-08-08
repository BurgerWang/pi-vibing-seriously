/**
 * Commander Slice B1 (commander-token-optimization plan P2 + P3): pure
 * unit tests for the layered workbench_read_run renderer
 * (extensions/workbench-runtime/core/run-result.ts).
 *
 * Coverage:
 *   - caps constants and deterministic resolution (malformed/tiny/huge
 *     values clamp to documented safe bounds; withinCaps is always true);
 *   - the default `summary` include renders the ordered Summary →
 *     Evidence → Persisted layers with the required machine-derived facts
 *     and NEVER inlines raw stdout/stderr, per-test lines, or argv; the
 *     Evidence layer always carries a REQUIRED logs/argv guidance line
 *     with the exact `include=logs`/`include=all` opt-in instruction that
 *     survives adversarial fields/lists and the caps;
 *   - adversarial fields (huge strings, control characters including
 *     newlines, astral code points, non-string values, non-array lists,
 *     non-finite numbers) are sanitized and bounded code-point-safely,
 *     measured against the ACTUAL output with TextEncoder/line counts
 *     (4096 bytes / 40 lines);
 *   - explicit `manifest` adds bounded cwd/argv metadata without tails;
 *   - explicit `logs`/`all` append only the existing caller-bounded tails
 *     verbatim (never re-bounded by the renderer);
 *   - cache/quant-contract facts render bounded; optional lines that
 *     cannot fit the caps are dropped lowest-priority-first and recorded
 *     in the aggregate; metadata/persisted-path bounding facts are
 *     precomputed before the aggregate omissions line; legacy records (no
 *     optional fields) render identically;
 *   - P4b: the REQUIRED `validation :` line — exact `validation :
 *     REUSABLE` for REUSABLE-without-reasons and the fixed RERUN_REQUIRED
 *     codes, fail-closed `missing-binding` for absent payloads, fail-closed
 *     contradiction handling (REUSABLE claimed WITH reasons renders
 *     RERUN_REQUIRED), and adversarial reason sets (whole line <=
 *     MAX_VALIDATION_LINE_BYTES, complete codes only, exact `(+N more)`
 *     omitted count) — in every include mode with capped/tail semantics
 *     preserved, including at the minimum caps;
 *   - the read-only batching classifier is the exact deterministic
 *     allowlist and never infers independence.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunRecord } from "../extensions/workbench-runtime/core/runs.ts";
import {
	DEFAULT_RUN_RESULT_CAPS,
	INDEPENDENT_READ_ONLY_ALLOWLIST,
	isIndependentReadOnlyTool,
	isRunResultInclude,
	MAX_RUN_RESULT_CAPS,
	MAX_VALIDATION_LINE_BYTES,
	MIN_RUN_RESULT_CAPS,
	renderRunResult,
	resolveRunResultCaps,
	type RunResultRenderInput,
} from "../extensions/workbench-runtime/core/run-result.ts";

// ------------------------------------------------------------------- caps

const SUCCESS_MAX_BYTES = 4096;
const SUCCESS_MAX_LINES = 40;

/** Exact UTF-8 byte length of the ACTUAL rendered output (TextEncoder). */
function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Byte- AND line-aware assertion against the actual emitted text. */
function assertWithinCaps(text: string, maxBytes: number, maxLines: number): void {
	assert.ok(utf8Bytes(text) <= maxBytes, `bytes ${utf8Bytes(text)} > ${maxBytes}`);
	assert.ok(text.split("\n").length <= maxLines, `lines ${text.split("\n").length} > ${maxLines}`);
}

/** A rendered result never contains lone surrogate halves (code-point safe). */
function assertNoLoneSurrogates(text: string): void {
	for (const cp of Array.from(text)) {
		const code = cp.codePointAt(0) ?? 0;
		assert.ok(
			!(code >= 0xd800 && code <= 0xdfff),
			`lone surrogate in output: ${JSON.stringify(cp)}`,
		);
	}
}

// --------------------------------------------------------------- fixtures

function makeManifest(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		schema_version: 1,
		run_id: "20260101-120000-abcd",
		recipe: "typecheck",
		profile: "generic",
		started_at: "2026-01-01T12:00:00.000Z",
		finished_at: "2026-01-01T12:01:00.000Z",
		duration_ms: 60000,
		cwd: "/tmp/proj",
		argv: ["npm", "run", "typecheck"],
		exit_code: 0,
		timed_out: false,
		cancelled: false,
		git_commit: "aa2301763d95abcdeffedcba0123456789abcdef01",
		git_dirty: false,
		artifact_paths: [],
		stdout_truncated: false,
		stderr_truncated: false,
		mode: "VERIFY",
		expected_exit_codes: [0],
		declared_writes: [],
		environment_names: [],
		validation_components: ["typecheck"],
		cache_request_mode: "no-cache",
		...overrides,
	};
}

function renderInput(overrides: Partial<RunResultRenderInput> = {}): RunResultRenderInput {
	return {
		include: "summary",
		manifest: makeManifest(),
		stdoutSnippet: null,
		stderrSnippet: null,
		runDir: ".pi/workbench/runs/20260101-120000-abcd",
		manifestPath: ".pi/workbench/runs/20260101-120000-abcd/manifest.json",
		summaryPath: ".pi/workbench/runs/20260101-120000-abcd/summary.json",
		stdoutPath: ".pi/workbench/runs/20260101-120000-abcd/stdout.log",
		stderrPath: ".pi/workbench/runs/20260101-120000-abcd/stderr.log",
		...overrides,
	};
}

// --------------------------------------------------------------------------
// Caps
// --------------------------------------------------------------------------

test("run-result caps constants and resolution are deterministic", () => {
	assert.deepEqual(DEFAULT_RUN_RESULT_CAPS, { maxBytes: SUCCESS_MAX_BYTES, maxLines: SUCCESS_MAX_LINES });
	assert.deepEqual(MIN_RUN_RESULT_CAPS, { maxBytes: 3584, maxLines: 32 });
	assert.deepEqual(MAX_RUN_RESULT_CAPS, { maxBytes: 8192, maxLines: 80 });
	// omitted/malformed resolve to the defaults
	assert.deepEqual(resolveRunResultCaps(undefined), DEFAULT_RUN_RESULT_CAPS);
	assert.deepEqual(resolveRunResultCaps({}), DEFAULT_RUN_RESULT_CAPS);
	assert.deepEqual(resolveRunResultCaps({ maxBytes: NaN, maxLines: -5 }), DEFAULT_RUN_RESULT_CAPS);
	assert.deepEqual(resolveRunResultCaps({ maxBytes: Infinity, maxLines: Number.NaN }), DEFAULT_RUN_RESULT_CAPS);
	assert.deepEqual(resolveRunResultCaps({ maxBytes: "big" as unknown as number }), DEFAULT_RUN_RESULT_CAPS);
	// tiny values clamp UP to the safe minima; huge values clamp DOWN
	assert.deepEqual(resolveRunResultCaps({ maxBytes: 1, maxLines: 1 }), MIN_RUN_RESULT_CAPS);
	assert.deepEqual(resolveRunResultCaps({ maxBytes: 10_000_000, maxLines: 10_000 }), MAX_RUN_RESULT_CAPS);
	// fractional values floor
	assert.deepEqual(resolveRunResultCaps({ maxBytes: 4096.9, maxLines: 40.9 }), DEFAULT_RUN_RESULT_CAPS);
	// include validation is exact
	for (const v of ["summary", "manifest", "logs", "all"]) assert.equal(isRunResultInclude(v), true, v);
	for (const v of ["", "everything", "log", 42, null, undefined]) assert.equal(isRunResultInclude(v), false, String(v));
});

// --------------------------------------------------------------------------
// Default summary layer
// --------------------------------------------------------------------------

test("default summary: ordered Summary/Evidence/Persisted layers, required facts, within caps", () => {
	const r = renderRunResult(renderInput());
	assert.equal(r.include, "summary");
	assert.equal(r.capped, true);
	assert.equal(r.withinCaps, true);
	assertWithinCaps(r.text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
	assertNoLoneSurrogates(r.text);
	const lines = r.text.split("\n");
	const idxSummary = lines.findIndex((l) => l === "--- summary ---");
	const idxEvidence = lines.findIndex((l) => l === "--- evidence ---");
	const idxPersisted = lines.findIndex((l) => l === "--- persisted ---");
	assert.ok(idxSummary >= 0 && idxEvidence > idxSummary && idxPersisted > idxEvidence, "layers in Summary → Evidence → Persisted order");
	// summary facts
	assert.ok(lines.some((l) => l.startsWith("run_id     : 20260101-120000-abcd")), r.text);
	assert.ok(lines.some((l) => l.startsWith("recipe     : typecheck")), r.text);
	assert.ok(lines.some((l) => l.startsWith("profile    : generic")), r.text);
	assert.ok(lines.some((l) => l.startsWith("mode       : VERIFY")), r.text);
	assert.ok(lines.some((l) => l.startsWith("status     : OK")), r.text);
	assert.ok(lines.some((l) => l.startsWith("exit code  : 0")), r.text);
	assert.ok(lines.some((l) => l.startsWith("duration   : 60000 ms")), r.text);
	assert.ok(lines.some((l) => l.startsWith("started    : 2026-01-01T12:00:00.000Z")), r.text);
	assert.ok(lines.some((l) => l.startsWith("timed out  : no")), r.text);
	assert.ok(lines.some((l) => l.startsWith("git        : aa2301763d95")), r.text);
	// evidence facts
	assert.ok(lines.some((l) => l.startsWith("artifacts  : (none)")), r.text);
	assert.ok(lines.some((l) => l.startsWith("evidence   : (none)")), r.text);
	assert.ok(lines.some((l) => l.startsWith("declared writes: (none)")), r.text);
	assert.ok(lines.some((l) => l.startsWith("truncation : stdout no, stderr no")), r.text);
	// persisted facts — durable project-relative paths
	assert.ok(lines.some((l) => l.startsWith("run dir    : .pi/workbench/runs/20260101-120000-abcd")), r.text);
	assert.ok(lines.some((l) => l.endsWith("manifest.json")), r.text);
	assert.ok(lines.some((l) => l.endsWith("summary.json")), r.text);
	assert.ok(lines.some((l) => l.includes("stdout.log") && l.includes("(full log on disk)")), r.text);
	assert.ok(lines.some((l) => l.includes("stderr.log") && l.includes("(full log on disk)")), r.text);
	assert.ok(lines.some((l) => l.startsWith("note       : machine-derived summary")), r.text);
	// layer accounting matches the actual emission
	assert.equal(r.layers.summary + r.layers.evidence + r.layers.metadata + r.layers.persisted + r.layers.tails, lines.length);
	assert.equal(r.layers.metadata, 0, "no metadata layer in the default summary");
	assert.equal(r.layers.tails, 0, "no tails in the default summary");
	assert.equal(r.argvShown, false);
	assert.equal(r.cwdShown, false);
});

test("default summary never inlines raw log content, per-test lines, or argv", () => {
	const r = renderRunResult(
		renderInput({
			manifest: makeManifest({
				argv: ["node", "green.js", "--verbose"],
				artifact_paths: ["results/quant-result.json"],
			}),
			stdoutSnippet: { content: "RAW-SUCCESS-MARKER-42\nnoise-line-1\n", truncated: true },
		}),
	);
	// no argv/cwd field lines, no tail sections, no raw log content
	assert.ok(!/^argv\s*:/m.test(r.text), r.text);
	assert.ok(!/^cwd\s*:/m.test(r.text), r.text);
	assert.ok(!r.text.includes("--- stdout tail"), r.text);
	assert.ok(!r.text.includes("RAW-SUCCESS-MARKER-42"), r.text);
	assert.ok(!r.text.includes("noise-line-1"), r.text);
	assert.ok(!r.text.includes("green.js"), "argv values never appear in the default summary");
	// the REQUIRED Evidence-layer guidance line states the omission policy
	// AND the exact opt-in instruction — its own line, never only a tail of
	// the truncatable aggregate omissions line
	const guidance = r.text.split("\n").find((l) => l.startsWith("logs/argv  : "));
	assert.ok(guidance, `guidance line missing:\n${r.text}`);
	assert.ok(guidance!.includes("raw stdout/stderr/tails and argv are omitted"), guidance);
	assert.ok(guidance!.includes("include=logs or include=all"), guidance);
	// the guidance never lives in the truncatable aggregate either
	assert.ok(!r.omissionFacts.some((f) => f.includes("inlined") || f.includes("no raw log lines")), r.omissionFacts.join("; "));
});

test("status mapping: failed / killed / timed out / cancelled manifests", () => {
	const failed = renderRunResult(renderInput({ manifest: makeManifest({ exit_code: 1 }) }));
	assert.ok(failed.text.includes("status     : FAILED"), failed.text);
	assert.ok(failed.text.includes("exit code  : 1"), failed.text);
	const killed = renderRunResult(renderInput({ manifest: makeManifest({ exit_code: null }) }));
	assert.ok(killed.text.includes("status     : KILLED"), killed.text);
	assert.ok(killed.text.includes("exit code  : killed"), killed.text);
	const timed = renderRunResult(renderInput({ manifest: makeManifest({ timed_out: true }) }));
	assert.ok(timed.text.includes("status     : TIMED OUT"), timed.text);
	assert.ok(timed.text.includes("timed out  : yes"), timed.text);
	const cancelled = renderRunResult(renderInput({ manifest: makeManifest({ cancelled: true }) }));
	assert.ok(cancelled.text.includes("status     : CANCELLED"), cancelled.text);
});

// --------------------------------------------------------------------------
// Adversarial fields
// --------------------------------------------------------------------------

test("adversarial fields: sanitized (no line injection), bounded, code-point safe, within caps", () => {
	const r = renderRunResult(
		renderInput({
			manifest: makeManifest({
				run_id: "20260101-120000-abcd",
				recipe: "r".repeat(5000),
				profile: "p\ninject-line\nagain",
				mode: "VERIFY\x00\x1b",
				started_at: "2026-01-01T12:00:00.000Z\nsecond-line",
				finished_at: "2026-01-01T12:01:00.000Z\r\nthird-line",
				git_commit: "a".repeat(40),
				duration_ms: Number.POSITIVE_INFINITY,
				exit_code: Number.NaN,
				artifact_paths: Array.from({ length: 100 }, (_, i) => `a${i}`),
				evidence_paths: Array.from({ length: 100 }, (_, i) => `e${i}`),
				declared_writes: Array.from({ length: 50 }, (_, i) => `w${i}`),
				stdout_truncated: true,
				stderr_truncated: false,
			}),
		}),
	);
	assert.equal(r.withinCaps, true);
	assertWithinCaps(r.text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
	assertNoLoneSurrogates(r.text);
	// control characters never inject extra lines
	for (const injected of ["inject-line", "again", "second-line", "third-line"]) {
		assert.ok(!r.text.split("\n").includes(injected), `injected line survived: ${injected}`);
	}
	// the recipe value is bounded to its budget with an explicit marker
	const recipeLine = r.text.split("\n").find((l) => l.startsWith("recipe     : "))!;
	assert.ok(recipeLine.endsWith("…"), `recipe line not bounded: ${recipeLine.slice(0, 80)}`);
	assert.ok(utf8Bytes(recipeLine.replace("recipe     : ", "")) <= 64, recipeLine);
	// non-finite numbers render defensively
	assert.ok(r.text.includes("duration   : ? ms"), r.text);
	// exact omitted counts
	assert.equal(r.artifactsShown, 8);
	assert.equal(r.artifactsOmitted, 92);
	assert.equal(r.evidencePathsOmitted, 92);
	assert.equal(r.declaredWritesOmitted, 42);
	assert.ok(r.omissionFacts.includes("92 artifact path(s) omitted (bounded display)"), r.omissionFacts.join("; "));
	assert.ok(r.omissionFacts.includes("92 evidence path(s) omitted (bounded display)"), r.omissionFacts.join("; "));
	assert.ok(r.omissionFacts.includes("42 declared write(s) omitted (bounded display)"), r.omissionFacts.join("; "));
	assert.ok(r.omissionFacts.includes("run fields bounded (display) — full values in manifest.json"), r.omissionFacts.join("; "));
	// the omissions line itself stays bounded (13-byte label + 480-byte value)
	const omissionsLine = r.text.split("\n").find((l) => l.startsWith("omissions  : "))!;
	assert.ok(utf8Bytes(omissionsLine.replace("omissions  : ", "")) <= 480, omissionsLine.slice(0, 120));
});

test("adversarial fields: astral code points are never split (code-point-safe truncation)", () => {
	const r = renderRunResult(
		renderInput({
			manifest: makeManifest({
				recipe: "🚀".repeat(100),
				profile: "🚀".repeat(100),
				started_at: "🚀".repeat(100),
			}),
		}),
	);
	assert.equal(r.withinCaps, true);
	assertWithinCaps(r.text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
	assertNoLoneSurrogates(r.text);
	// the truncated field ends with the explicit marker, never a half pair
	const recipeLine = r.text.split("\n").find((l) => l.startsWith("recipe     : "))!;
	assert.ok(recipeLine.endsWith("…"), recipeLine);
	assert.ok(!/[\uD800-\uDFFF]$/.test(recipeLine), `recipe line ends mid-pair: ${recipeLine.slice(-8)}`);
});

test("adversarial non-string / non-array fields render defensively and never throw", () => {
	const r = renderRunResult(
		renderInput({
			manifest: makeManifest({
				run_id: 12345 as unknown as string,
				recipe: null as unknown as string,
				profile: 42 as unknown as string,
				artifact_paths: "not-an-array" as unknown as string[],
				evidence_paths: null as unknown as string[],
				declared_writes: 7 as unknown as string[],
				argv: "not-an-array" as unknown as string[],
				cwd: 9 as unknown as string,
				git_commit: 123 as unknown as string,
				started_at: {} as unknown as string,
			}),
		}),
	);
	assert.equal(r.withinCaps, true);
	assertWithinCaps(r.text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
	assert.ok(r.text.includes("run_id     : (invalid)"), r.text);
	assert.ok(r.text.includes("recipe     : (invalid)"), r.text);
	assert.ok(r.text.includes("artifacts  : (none)"), r.text);
	assert.ok(r.text.includes("evidence   : (none)"), r.text);
	assert.ok(r.text.includes("declared writes: (none)"), r.text);
	assert.ok(r.text.includes("started    : (invalid)"), r.text);
	// defensive status (missing expected_exit_codes never throws; a missing
	// expected list cannot make an exit-0 run look OK)
	const noExpected = renderRunResult(
		renderInput({
			manifest: { ...makeManifest(), expected_exit_codes: undefined as unknown as number[] },
		}),
	);
	assert.ok(noExpected.text.includes("status     : FAILED"), noExpected.text);
});

test("withinCaps stays true at the minimum caps under fully adversarial input", () => {
	const r = renderRunResult(
		renderInput({
			caps: { maxBytes: 1, maxLines: 1 },
			manifest: makeManifest({
				recipe: "r".repeat(5000),
				profile: "p\nq\n",
				artifact_paths: Array.from({ length: 100 }, (_, i) => `a${i}`),
				evidence_paths: Array.from({ length: 100 }, (_, i) => `e${i}`),
				declared_writes: Array.from({ length: 50 }, (_, i) => `w${i}`),
				started_at: "2026-01-01T12:00:00.000Z\nx",
			}),
		}),
	);
	assert.equal(r.withinCaps, true);
	assertWithinCaps(r.text, MIN_RUN_RESULT_CAPS.maxBytes, MIN_RUN_RESULT_CAPS.maxLines);
	// the required-fact block fits the safe minima even at the worst case —
	// the emitted summary is never "caps EXCEEDED" and never degrades
	assert.ok(!r.text.includes("caps EXCEEDED"), r.text);
});

test("default summary: the required logs/argv opt-in guidance line is always emitted, even at minimum caps under adversarial fields/lists", () => {
	const r = renderRunResult(
		renderInput({
			caps: { maxBytes: 1, maxLines: 1 }, // clamps to MIN_RUN_RESULT_CAPS
			manifest: makeManifest({
				run_id: "x".repeat(100),
				recipe: "r".repeat(5000),
				profile: "p\ninject-line\nagain",
				mode: "M".repeat(100),
				started_at: "2026-01-01T12:00:00.000Z\nsecond-line",
				finished_at: "2026-01-01T12:01:00.000Z".repeat(3),
				git_commit: "a".repeat(40),
				artifact_paths: Array.from({ length: 100 }, (_, i) => `a${i}`),
				evidence_paths: Array.from({ length: 100 }, (_, i) => `e${i}`),
				declared_writes: Array.from({ length: 50 }, (_, i) => `w${i}`),
			}),
		}),
	);
	assert.equal(r.withinCaps, true);
	assertWithinCaps(r.text, MIN_RUN_RESULT_CAPS.maxBytes, MIN_RUN_RESULT_CAPS.maxLines);
	assertNoLoneSurrogates(r.text);
	// the guidance is its OWN required line in the evidence layer — it can
	// never be truncated away together with the aggregate omissions line
	const guidance = r.text.split("\n").find((l) => l.startsWith("logs/argv  : "));
	assert.ok(guidance, `guidance line missing:\n${r.text}`);
	assert.ok(guidance!.includes("raw stdout/stderr/tails and argv are omitted"), guidance);
	assert.ok(guidance!.includes("include=logs or include=all"), guidance);
	// no degradation, no raw content, no injected lines, exact counts intact
	assert.ok(r.text.includes("--- summary ---"), r.text);
	assert.ok(!r.text.includes("degraded to the minimal form"), r.text);
	assert.ok(!r.text.split("\n").includes("inject-line"), r.text);
	assert.ok(!r.text.split("\n").includes("second-line"), r.text);
	assert.equal(r.artifactsOmitted, 92);
	assert.ok(r.text.includes("92 artifact path(s) omitted (bounded display)"), r.text);
});

test("optional cache/quant lines that cannot fit the caps are recorded in the aggregate (never silently dropped)", () => {
	const r = renderRunResult(
		renderInput({
			include: "manifest", // required cwd/argv metadata pushes the worst case past MIN caps
			caps: { maxBytes: 1, maxLines: 1 }, // clamps to MIN_RUN_RESULT_CAPS
			manifest: makeManifest({
				run_id: "x".repeat(100),
				recipe: "r".repeat(5000),
				profile: "p".repeat(5000),
				mode: "M".repeat(100),
				started_at: "2026-01-01T12:00:00.000Z".repeat(3),
				finished_at: "2026-01-01T12:01:00.000Z".repeat(3),
				git_commit: "a".repeat(40),
				cwd: "c".repeat(5000),
				argv: ["a".repeat(5000)],
				artifact_paths: Array.from({ length: 100 }, (_, i) => `a${i}`),
				evidence_paths: Array.from({ length: 100 }, (_, i) => `e${i}`),
				declared_writes: Array.from({ length: 50 }, (_, i) => `w${i}`),
				execution_source: "cache",
				action_key: "k".repeat(5000),
				reused_from_run_id: "r".repeat(100),
				cache_created_at: "t".repeat(100),
				cache_validated_at: "t".repeat(100),
				artifact_validation: { mode: "full", artifacts_restored: true, hash_verified: true, status: "v".repeat(100) },
				quant_contract: { type: "q".repeat(100), manifest: "m".repeat(5000), validation_status: "valid", immutable_key: "ik", logical_reference: null, resolved_reference: null, warnings: ["w".repeat(500)] },
			}),
		}),
	);
	assert.equal(r.withinCaps, true);
	assertWithinCaps(r.text, MIN_RUN_RESULT_CAPS.maxBytes, MIN_RUN_RESULT_CAPS.maxLines);
	assertNoLoneSurrogates(r.text);
	// no fallback degradation — the required machine facts survive
	assert.ok(r.text.includes("--- summary ---"), r.text);
	assert.ok(r.text.includes("run_id     : "), r.text);
	assert.ok(!r.text.includes("degraded to the minimal form"), r.text);
	// the lowest-priority optional facts are dropped first (quant, then the
	// artifact-validation line) and RECORDED in the EMITTED aggregate —
	// never silently
	assert.ok(!r.text.includes("quant      : "), r.text);
	assert.ok(!r.text.includes("artifact validation: "), r.text);
	assert.ok(r.text.includes("quant facts omitted (display caps) — full values in manifest.json"), r.text);
	assert.ok(r.text.includes("some cache facts omitted (display caps) — full values in manifest.json"), r.text);
	assert.ok(r.omissionFacts.includes("quant facts omitted (display caps) — full values in manifest.json"), r.omissionFacts.join("; "));
	assert.ok(r.omissionFacts.includes("some cache facts omitted (display caps) — full values in manifest.json"), r.omissionFacts.join("; "));
	// higher-priority facts survive alongside the recorded drops. P4b: the
	// REQUIRED validation line grows the required block, so at the MINIMUM
	// caps the lowest-priority optional cache-valid line is dropped too —
	// deterministically recorded in the aggregate (FACT_CACHE_OMITTED,
	// asserted above), never silently; it still renders at the default caps
	// (asserted in the cache-facts test below).
	assert.ok(r.text.includes("execution  : cache"), r.text);
	assert.ok(r.text.includes("cache      : CACHE"), r.text);
	assert.ok(r.text.includes("cwd        : "), r.text);
	assert.ok(r.text.includes("argv       : "), r.text);
	// exact list counts are never silently lost either
	assert.equal(r.artifactsOmitted, 92);
	assert.equal(r.evidencePathsOmitted, 92);
	assert.equal(r.declaredWritesOmitted, 42);
	assert.ok(r.text.includes("92 artifact path(s) omitted (bounded display)"), r.text);
	assert.ok(r.text.includes("92 evidence path(s) omitted (bounded display)"), r.text);
	assert.ok(r.text.includes("42 declared write(s) omitted (bounded display)"), r.text);
});

test("metadata and persisted-path bounding facts are precomputed before the aggregate omissions line is emitted", () => {
	const r = renderRunResult(
		renderInput({
			include: "manifest",
			manifest: makeManifest({
				cwd: "c".repeat(5000),
				argv: ["a".repeat(5000)],
				recipe: "r".repeat(5000),
				artifact_paths: Array.from({ length: 100 }, (_, i) => `a${i}`),
			}),
			runDir: "d".repeat(5000),
			manifestPath: "m".repeat(5000),
			summaryPath: "s".repeat(5000),
			stdoutPath: "o".repeat(5000),
			stderrPath: "e".repeat(5000),
		}),
	);
	assert.equal(r.withinCaps, true);
	assertWithinCaps(r.text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
	// bounded metadata display AND truncated persisted paths are recorded in
	// the EMITTED aggregate — never discovered only after the omissions line
	assert.ok(r.text.includes("cwd/argv metadata bounded (display) — full values in manifest.json"), r.text);
	assert.ok(r.text.includes("run fields bounded (display) — full values in manifest.json"), r.text);
	// the metadata layer still renders the bounded values with markers
	assert.ok(r.text.includes("cwd        : ccc"), r.text);
	assert.ok(r.text.includes("argv       : aaa"), r.text);
	// the persisted layer keeps the durable paths (bounded with markers)
	const runDirLine = r.text.split("\n").find((l) => l.startsWith("run dir    : "))!;
	assert.ok(runDirLine.endsWith("…"), runDirLine);
	assert.ok(r.text.includes("stdout log : ") && r.text.includes("(full log on disk)"), r.text);
});

test("metadata (cwd/argv) always renders for explicit includes, even at minimum caps", () => {
	const r = renderRunResult(
		renderInput({
			include: "manifest",
			caps: { maxBytes: 1, maxLines: 1 },
			manifest: makeManifest({
				cwd: "c".repeat(5000),
				argv: ["a".repeat(5000)],
				recipe: "r".repeat(5000),
				profile: "p".repeat(5000),
				started_at: "2026-01-01T12:00:00.000Z".repeat(3),
				finished_at: "2026-01-01T12:01:00.000Z".repeat(3),
				artifact_paths: Array.from({ length: 100 }, (_, i) => `a${i}`),
				evidence_paths: Array.from({ length: 100 }, (_, i) => `e${i}`),
				declared_writes: Array.from({ length: 50 }, (_, i) => `w${i}`),
				execution_source: "cache",
				action_key: "k".repeat(5000),
				cache_created_at: "t".repeat(100),
				cache_validated_at: "t".repeat(100),
				artifact_validation: { mode: "full", artifacts_restored: true, hash_verified: true, status: "v".repeat(100) },
				quant_contract: { type: "q".repeat(100), manifest: "m".repeat(5000), validation_status: "valid", immutable_key: "ik", logical_reference: null, resolved_reference: null, warnings: [] },
			}),
		}),
	);
	assert.equal(r.withinCaps, true);
	assertWithinCaps(r.text, MIN_RUN_RESULT_CAPS.maxBytes, MIN_RUN_RESULT_CAPS.maxLines);
	assert.ok(r.text.includes("cwd        : "), r.text);
	assert.ok(r.text.includes("argv       : "), r.text);
	assert.equal(r.cwdShown, true);
	assert.equal(r.argvShown, true);
	assert.ok(!r.text.includes("degraded to the minimal form"), r.text);
});

// --------------------------------------------------------------------------
// Explicit includes
// --------------------------------------------------------------------------

test("manifest include: bounded cwd/argv metadata, no tails, within caps", () => {
	const r = renderRunResult(
		renderInput({
			include: "manifest",
			manifest: makeManifest({ argv: ["node", "green.js", "flag".repeat(2000)], cwd: "/tmp/proj" }),
		}),
	);
	assert.equal(r.include, "manifest");
	assert.equal(r.capped, true);
	assert.equal(r.withinCaps, true);
	assertWithinCaps(r.text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
	assert.ok(r.text.includes("argv       : node green.js flag"), r.text);
	assert.ok(r.text.includes("cwd        : /tmp/proj"), r.text);
	assert.equal(r.argvShown, true);
	assert.equal(r.cwdShown, true);
	assert.ok(!r.text.includes("--- stdout tail"), r.text);
	assert.equal(r.layers.tails, 0);
	// the manifest include carries its own guidance line (no tails yet)
	assert.ok(r.text.includes("no raw logs and no tails"), r.text);
	assert.ok(r.text.includes("include=logs or include=all"), r.text);
	// the joined argv stays bounded code-point-safely
	const argvLine = r.text.split("\n").find((l) => l.startsWith("argv       : "))!;
	assert.ok(utf8Bytes(argvLine.replace("argv       : ", "")) <= 240, argvLine.slice(0, 120));
	assert.ok(r.omissionFacts.includes("cwd/argv metadata bounded (display) — full values in manifest.json"), r.omissionFacts.join("; "));
});

test("logs include: caller-bounded tails appended verbatim, never re-bounded", () => {
	const stdoutTail = Array.from({ length: 300 }, (_, i) => `tail-line-${i + 1}`).join("\n");
	const stderrTail = "warn: something";
	const r = renderRunResult(
		renderInput({
			include: "logs",
			stdoutSnippet: { content: stdoutTail, truncated: true },
			stderrSnippet: { content: stderrTail, truncated: false },
		}),
	);
	assert.equal(r.capped, false, "logs/all have no global cap — tails are caller-bounded");
	assert.equal(r.withinCaps, true);
	assert.equal(r.stdoutTailShown, true);
	assert.equal(r.stderrTailShown, true);
	assert.ok(r.text.includes("--- stdout tail (truncated): .pi/workbench/runs/20260101-120000-abcd/stdout.log ---"), r.text);
	assert.ok(r.text.includes("--- stderr tail (full): .pi/workbench/runs/20260101-120000-abcd/stderr.log ---"), r.text);
	// the caller-bounded tail passes through VERBATIM (all 300 lines)
	assert.ok(r.text.includes("tail-line-1"), r.text);
	assert.ok(r.text.includes("tail-line-300"), r.text);
	assert.equal(r.text.split("\n").filter((l) => l.startsWith("tail-line-")).length, 300);
	assert.ok(r.text.includes("warn: something"), r.text);
	// metadata (cwd/argv) is present for explicit includes
	assert.ok(r.text.includes("argv       : npm run typecheck"), r.text);
	// the logs include carries its own caller-bounded-tails guidance line
	assert.ok(r.text.includes("caller-bounded tails below (max_lines / max_bytes)"), r.text);
	// layer accounting
	assert.equal(r.layers.tails, 1 + 300 + 1 + 1);
	assert.equal(r.layers.summary + r.layers.evidence + r.layers.metadata + r.layers.persisted + r.layers.tails, r.text.split("\n").length);
});

test("all include: metadata plus both tails; empty tails render (empty)", () => {
	const r = renderRunResult(
		renderInput({
			include: "all",
			stdoutSnippet: { content: "line-a\nline-b", truncated: false },
			stderrSnippet: { content: "", truncated: false },
		}),
	);
	assert.equal(r.include, "all");
	assert.equal(r.stdoutTailShown, true);
	assert.equal(r.stderrTailShown, true);
	assert.ok(r.text.includes("--- stdout tail (full):"), r.text);
	assert.ok(r.text.includes("line-a"), r.text);
	assert.ok(r.text.includes("(empty)"), r.text);
	assert.ok(r.text.includes("argv       : npm run typecheck"), r.text);
});

// --------------------------------------------------------------------------
// Cache / quant facts and legacy records
// --------------------------------------------------------------------------

test("cache facts render bounded (execution source, reuse, key, validity, artifact validation)", () => {
	const r = renderRunResult(
		renderInput({
			manifest: makeManifest({
				execution_source: "cache",
				action_key: "k".repeat(100),
				reused_from_run_id: "20260102-120000-efgh",
				cache_created_at: "2026-01-02T12:00:00.000Z",
				cache_validated_at: "2026-01-02T12:05:00.000Z",
				artifact_validation: { mode: "full", artifacts_restored: true, hash_verified: true, status: "valid" },
			}),
		}),
	);
	assert.ok(r.text.includes("execution  : cache"), r.text);
	assert.ok(r.text.includes("cache      : CACHE — reused 20260102-120000-efgh — key kkk"), r.text);
	assert.ok(r.text.includes("cache valid:"), r.text);
	assert.ok(r.text.includes("artifact validation: valid full restored yes hash verified"), r.text);
	assertWithinCaps(r.text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
});

test("quant contract facts render bounded", () => {
	const r = renderRunResult(
		renderInput({
			manifest: makeManifest({
				execution_source: "cache",
				quant_contract: {
					type: "BACKTEST_RESULT",
					manifest: "results/quant-result.json",
					immutable_key: "20260101-120000-abcd",
					validation_status: "valid",
					logical_reference: null,
					resolved_reference: null,
					warnings: ["w1", "w2", "w3"],
				},
			}),
		}),
	);
	assert.ok(r.text.includes("quant      : BACKTEST_RESULT valid manifest results/quant-result.json warnings 3"), r.text);
	assertWithinCaps(r.text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
});

test("legacy records (no optional cache/quant/evidence fields) render identically within caps", () => {
	const r = renderRunResult(
		renderInput({
			manifest: makeManifest({
				execution_source: undefined,
				action_key: undefined,
				evidence_paths: undefined,
				artifact_validation: undefined,
				quant_contract: undefined,
			}),
		}),
	);
	assert.ok(!r.text.includes("execution  :"), r.text);
	assert.ok(!r.text.includes("cache      :"), r.text);
	assert.ok(!r.text.includes("quant      :"), r.text);
	assert.ok(r.text.includes("evidence   : (none)"), r.text);
	assertWithinCaps(r.text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
	// legacy records keep the exact same layered structure
	const lines = r.text.split("\n");
	assert.ok(lines.includes("--- summary ---"), r.text);
	assert.ok(lines.includes("--- evidence ---"), r.text);
	assert.ok(lines.includes("--- persisted ---"), r.text);
});

// --------------------------------------------------------------------------
// P4b validation line (pure renderer)
// --------------------------------------------------------------------------

test("validation: REUSABLE (no reasons) emits exactly `validation : REUSABLE` in every include mode; RERUN_REQUIRED emits its fixed codes; capped/tail semantics preserved", () => {
	const includes = ["summary", "manifest", "logs", "all"] as const;
	for (const include of includes) {
		const reusable = renderRunResult(
			renderInput({
				include,
				validation: { status: "REUSABLE", reasons: [] },
				stdoutSnippet: { content: "stdout-marker-line\n", truncated: true },
				stderrSnippet: { content: "stderr-marker-line\n", truncated: false },
			}),
		);
		assert.equal(reusable.withinCaps, true, include);
		// the validation line appears exactly once, with the exact REUSABLE text
		assert.equal(reusable.text.split("\n").filter((l) => l.startsWith("validation : ")).length, 1, include);
		assert.equal(reusable.text.split("\n").find((l) => l.startsWith("validation : ")), "validation : REUSABLE", include);
		if (include === "summary" || include === "manifest") {
			// capped semantics unchanged: global byte/line caps still hold
			assert.equal(reusable.capped, true, include);
			assertWithinCaps(reusable.text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
			assert.equal(reusable.layers.tails, 0, include);
		} else {
			// tail semantics unchanged: logs/all stay uncapped, tails verbatim
			assert.equal(reusable.capped, false, include);
			assert.equal(reusable.stdoutTailShown, true, include);
			assert.equal(reusable.stderrTailShown, true, include);
			assert.ok(reusable.text.includes("stdout-marker-line"), include);
			assert.ok(reusable.text.includes("stderr-marker-line"), include);
		}

		const rerun = renderRunResult(
			renderInput({
				include,
				validation: { status: "RERUN_REQUIRED", reasons: ["stale-artifacts"] },
				stdoutSnippet: { content: "stdout-marker-line\n", truncated: true },
				stderrSnippet: { content: "stderr-marker-line\n", truncated: false },
			}),
		);
		assert.equal(rerun.text.split("\n").find((l) => l.startsWith("validation : ")), "validation : RERUN_REQUIRED — stale-artifacts", include);
		assert.equal(rerun.withinCaps, true, include);
	}
});

test("validation: absent/null payloads fail closed to RERUN_REQUIRED — missing-binding", () => {
	for (const validation of [undefined, null] as const) {
		const r = renderRunResult(renderInput({ validation }));
		const line = r.text.split("\n").find((l) => l.startsWith("validation : "))!;
		assert.equal(line, "validation : RERUN_REQUIRED — missing-binding", String(validation));
	}
	// an explicit refusal with no usable reasons also defaults to missing-binding
	const emptyReasons = renderRunResult(renderInput({ validation: { status: "RERUN_REQUIRED", reasons: [] } }));
	assert.equal(emptyReasons.text.split("\n").find((l) => l.startsWith("validation : ")), "validation : RERUN_REQUIRED — missing-binding");
	assertWithinCaps(emptyReasons.text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
});

test("validation: a payload claiming REUSABLE with reasons is contradictory — fails closed to RERUN_REQUIRED with those reasons", () => {
	const r = renderRunResult(
		renderInput({ validation: { status: "REUSABLE", reasons: ["stale-artifacts", "hash-mismatch"] } }),
	);
	assert.equal(r.text.split("\n").find((l) => l.startsWith("validation : ")), "validation : RERUN_REQUIRED — stale-artifacts, hash-mismatch");
	// malformed (non-string) reason values are dropped deterministically; a
	// refusal left with no usable reasons degrades to missing-binding
	const malformed = renderRunResult(
		renderInput({
			validation: {
				status: "RERUN_REQUIRED",
				reasons: ["ok-code", 42 as unknown as string, null as unknown as string, {} as unknown as string, "another-code"],
			},
		}),
	);
	assert.equal(malformed.text.split("\n").find((l) => l.startsWith("validation : ")), "validation : RERUN_REQUIRED — ok-code, another-code");
	const onlyMalformed = renderRunResult(
		renderInput({
			validation: {
				status: "RERUN_REQUIRED",
				reasons: [42 as unknown as string, null as unknown as string, {} as unknown as string],
			},
		}),
	);
	assert.equal(onlyMalformed.text.split("\n").find((l) => l.startsWith("validation : ")), "validation : RERUN_REQUIRED — missing-binding");
});

test("validation: many/adversarial reason codes — line within MAX_VALIDATION_LINE_BYTES, complete codes only, exact (+N more) omitted count", () => {
	// adversarial reason set: fixed codes, an injection attempt, astral code
	// points and oversized ASCII — every code bounded to the per-code display
	// budget (40 UTF-8 bytes), never split mid-code
	const codes = [
		"missing-binding",
		"stale-artifacts",
		"hash-mismatch",
		"env-changed",
		"recipe-changed",
		"binding-incomplete",
		"cmd\ninject-line", // control characters are sanitized to spaces
		"🚀".repeat(20), // 240 raw bytes → "🚀"×9 + "…" (39 bytes)
		"x".repeat(200), // → "x"×37 + "…" (40 bytes)
		"z".repeat(200),
		"y".repeat(200),
		"last-code",
	];
	// expected COMPLETE bounded display of every input code, in order
	const expected = [
		"missing-binding",
		"stale-artifacts",
		"hash-mismatch",
		"env-changed",
		"recipe-changed",
		"binding-incomplete",
		"cmd inject-line",
		"🚀".repeat(9) + "…",
		"x".repeat(37) + "…",
		"z".repeat(37) + "…",
		"y".repeat(37) + "…",
		"last-code",
	];
	const r = renderRunResult(renderInput({ validation: { status: "RERUN_REQUIRED", reasons: codes } }));
	const line = r.text.split("\n").find((l) => l.startsWith("validation : "))!;
	// the WHOLE emitted line — prefix, every complete code, and the exact
	// omitted-count suffix — fits the documented byte budget
	assert.ok(utf8Bytes(line) <= MAX_VALIDATION_LINE_BYTES, `${utf8Bytes(line)} > ${MAX_VALIDATION_LINE_BYTES}: ${line}`);
	assertNoLoneSurrogates(line);
	// the reason payload can never inject extra lines
	assert.equal(r.text.split("\n").filter((l) => l.startsWith("validation : ")).length, 1, r.text);
	assert.ok(!r.text.split("\n").includes("inject-line"), r.text);
	// parse the emitted codes and the exact omitted-count suffix
	const prefix = "validation : RERUN_REQUIRED — ";
	assert.ok(line.startsWith(prefix), line);
	const body = line.slice(prefix.length);
	const suffix = body.match(/^(.*)…\(\+(\d+) more\)$/);
	const shownText = suffix ? suffix[1]! : body;
	const omitted = suffix ? Number(suffix[2]!) : 0;
	const shown = shownText.length > 0 ? shownText.split(", ") : [];
	assert.ok(omitted > 0, "adversarial set must exceed the line budget");
	assert.equal(omitted, codes.length - shown.length, line);
	// complete codes only: the shown codes are exactly the first N input
	// codes in their complete bounded display form — never partial fragments
	assert.deepEqual(shown, expected.slice(0, shown.length), line);
	// the first omitted code is absent entirely (not even partially present)
	assert.ok(!shownText.includes(expected[shown.length]!.slice(0, 8)), line);
	// exactness: the omitted count is maximal — one more complete code plus
	// its (smaller) suffix would overflow the budget
	const nextJoined = expected.slice(0, shown.length + 1).join(", ");
	const nextSuffix = `…(+${codes.length - shown.length - 1} more)`;
	assert.ok(utf8Bytes(prefix + nextJoined + nextSuffix) > MAX_VALIDATION_LINE_BYTES, line);
});

test("validation: minimum-cap adversarial summary stays within the min byte/line caps with the required validation line", () => {
	const r = renderRunResult(
		renderInput({
			caps: { maxBytes: 1, maxLines: 1 }, // clamps to MIN_RUN_RESULT_CAPS
			manifest: makeManifest({
				recipe: "r".repeat(5000),
				profile: "p\nq\n",
				artifact_paths: Array.from({ length: 100 }, (_, i) => `a${i}`),
				evidence_paths: Array.from({ length: 100 }, (_, i) => `e${i}`),
				declared_writes: Array.from({ length: 50 }, (_, i) => `w${i}`),
				started_at: "2026-01-01T12:00:00.000Z\nx",
			}),
			validation: {
				status: "RERUN_REQUIRED",
				reasons: ["missing-binding", "stale-artifacts", "hash-mismatch", "env-changed", "recipe-changed", "binding-incomplete", "cmd\ninject", "🚀".repeat(20), "x".repeat(200), "z".repeat(200), "y".repeat(200), "last-code"],
			},
		}),
	);
	assert.equal(r.withinCaps, true);
	assertWithinCaps(r.text, MIN_RUN_RESULT_CAPS.maxBytes, MIN_RUN_RESULT_CAPS.maxLines);
	assertNoLoneSurrogates(r.text);
	// the REQUIRED validation line survives at the minimum caps, bounded
	const line = r.text.split("\n").find((l) => l.startsWith("validation : "))!;
	assert.ok(utf8Bytes(line) <= MAX_VALIDATION_LINE_BYTES, line);
	assert.ok(line.startsWith("validation : RERUN_REQUIRED — "), line);
	// no fallback degradation, no injected lines, summary intact
	assert.ok(r.text.includes("--- summary ---"), r.text);
	assert.ok(!r.text.includes("degraded to the minimal form"), r.text);
	assert.ok(!r.text.split("\n").includes("inject"), r.text);
});

// --------------------------------------------------------------------------
// Read-only batching classifier (P3)
// --------------------------------------------------------------------------

test("the read-only batching allowlist is the exact approved deterministic set", () => {
	assert.deepEqual(
		[...INDEPENDENT_READ_ONLY_ALLOWLIST],
		[
			"read",
			"grep",
			"find",
			"ls",
			"workbench_project_inspect",
			"workbench_read_run",
			"workbench_read_gate",
			"workbench_list_gates",
			"workbench_compare_runs",
		],
	);
	assert.ok(Object.isFrozen(INDEPENDENT_READ_ONLY_ALLOWLIST), "allowlist is frozen");
	// every listed tool is classified
	for (const name of INDEPENDENT_READ_ONLY_ALLOWLIST) {
		assert.equal(isIndependentReadOnlyTool(name), true, name);
	}
});

test("the classifier excludes delegation_status and every execution/review/delegation/write tool", () => {
	for (const name of [
		"bash",
		"edit",
		"write",
		"workbench_run_recipe",
		"workbench_run_gate",
		"workbench_delegate_worker",
		"workbench_review_worker_diff",
		"workbench_delegation_status",
	]) {
		assert.equal(isIndependentReadOnlyTool(name), false, name);
	}
});

test("the classifier never infers independence for unknown tools", () => {
	// unknown/foreign tools are never classified, regardless of name shape
	for (const name of ["workbench_gate_check", "zeta_ext", "", "read_file"]) {
		assert.equal(isIndependentReadOnlyTool(name), false, name);
	}
	// membership is a pure allowlist check — identical calls give identical answers
	const a = isIndependentReadOnlyTool("workbench_read_run");
	const b = isIndependentReadOnlyTool("workbench_read_run");
	assert.equal(a, b);
	assert.equal(a, true);
});
