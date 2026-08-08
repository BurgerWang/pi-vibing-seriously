/**
 * P4b TUI renderer tests — direct tests of the exported `renderReadRunLines`
 * line builder (core/render.ts) for the additive current-state validation
 * verdict (`details.validation`).
 *
 * Coverage (P4b):
 *   - compact and expanded output additively render the REUSABLE and
 *     RERUN_REQUIRED verdicts alongside the existing read-run fields
 *   - expanded refusals carry the fixed reason codes, bounded to the
 *     display cap (`MAX_VALIDATION_DISPLAY_CHARS` in core/render.ts)
 *   - absent and malformed validation payloads are fail-closed: they never
 *     fabricate a verdict (compact omits the validation segment, expanded
 *     renders `(n/a)`)
 *   - the renderer accepts structured validation ONLY when internally
 *     consistent: exact REUSABLE with an actually-empty reasons array, or
 *     exact RERUN_REQUIRED with a non-empty array whose EVERY entry is a
 *     canonical fixed refusal code (the single
 *     VALIDATION_REFUSAL_REASONS allowlist — never duplicated here).
 *     Contradictions (REUSABLE+reasons), RERUN_REQUIRED empty/non-array/
 *     unknown/newline/raw-secret reasons and every other malformed payload
 *     fail closed to (n/a): no injected line or secret can ever appear
 *   - many valid fixed reasons stay one bounded single-line validation
 *     segment: output line count is invariant, overflow is capped, and
 *     every complete rendered token is a canonical code
 *
 * The line builder is pure and ANSI-free; existing field rendering is
 * asserted by inclusion (never by snapshotting irrelevant formatting).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	renderReadRunLines,
	type ReadRunToolDetails,
} from "../extensions/workbench-runtime/core/render.ts";
import {
	isValidationRefusalReason,
	VALIDATION_REFUSAL_REASONS,
	type ValidationRefusalReason,
} from "../extensions/workbench-runtime/core/validation-evidence.ts";

/** Display cap for the joined reason codes (MAX_VALIDATION_DISPLAY_CHARS in core/render.ts). */
const REASONS_DISPLAY_CAP = 160;
/** Length of the fixed `validation : RERUN_REQUIRED — ` prefix. */
const VALIDATION_PREFIX_LENGTH = "validation : RERUN_REQUIRED — ".length;

/** Minimal valid fixture: every required field present, no validation verdict. */
const READ_RUN: ReadRunToolDetails = {
	run_id: "20260801-004",
	recipe: "npm test",
	kind: "recipe",
	status: "OK",
	exit_code: 0,
	duration_ms: 1234,
	profile: "generic",
	mode: "VERIFY",
	started_at: "2026-08-01T00:00:00.000Z",
	finished_at: "2026-08-01T00:00:01.234Z",
	git_commit: "abc123def456",
	git_dirty: false,
	artifact_paths: ["results/out.json"],
	stdout_log: ".pi/workbench/runs/20260801-004/stdout.log",
	stderr_log: ".pi/workbench/runs/20260801-004/stderr.log",
};

/** Fixed expanded line count of the read_run line builder. */
const EXPANDED_LINE_COUNT = renderReadRunLines(READ_RUN, true).length;

// --------------------------------------------------------- verdict rendering

test("compact and expanded output additively show the REUSABLE verdict", () => {
	const d: ReadRunToolDetails = { ...READ_RUN, validation: { status: "REUSABLE", reasons: [] } };

	// compact stays exactly one line: existing fields preserved, verdict added
	const compact = renderReadRunLines(d, false);
	assert.equal(compact.length, 1);
	assert.ok(compact[0]!.includes("RECIPE run:20260801-004"), compact[0]!);
	assert.ok(compact[0]!.includes("npm test"), compact[0]!);
	assert.ok(compact[0]!.includes("OK"), compact[0]!);
	assert.ok(compact[0]!.includes("exit=0"), compact[0]!);
	assert.ok(compact[0]!.includes("1.2s"), compact[0]!);
	assert.ok(compact[0]!.includes("validation=REUSABLE"), compact[0]!);

	// expanded keeps every existing field and adds the validation line
	const expanded = renderReadRunLines(d, true);
	assert.ok(expanded.some((l) => l.startsWith("profile    : generic")), expanded.join("\n"));
	assert.ok(expanded.some((l) => l.startsWith("mode       : VERIFY")), expanded.join("\n"));
	assert.ok(expanded.some((l) => l.startsWith("git        : abc123def456")), expanded.join("\n"));
	assert.ok(expanded.some((l) => l.startsWith("artifacts  : results/out.json")), expanded.join("\n"));
	assert.ok(expanded.some((l) => l.startsWith("stdout log : .pi/workbench/runs/20260801-004/stdout.log")), expanded.join("\n"));
	// a REUSABLE verdict carries no reasons segment
	assert.ok(expanded.includes("validation : REUSABLE"), expanded.join("\n"));
	assert.equal(expanded.filter((l) => l.startsWith("validation : ")).length, 1, "exactly one validation line");
});

test("compact and expanded output additively show RERUN_REQUIRED with bounded reasons", () => {
	const d: ReadRunToolDetails = {
		...READ_RUN,
		validation: { status: "RERUN_REQUIRED", reasons: ["missing-binding", "target-mismatch"] },
	};

	const compact = renderReadRunLines(d, false);
	assert.equal(compact.length, 1);
	assert.ok(compact[0]!.includes("validation=RERUN_REQUIRED"), compact[0]!);

	const expanded = renderReadRunLines(d, true);
	const vline = expanded.find((l) => l.startsWith("validation : "))!;
	assert.ok(vline.startsWith("validation : RERUN_REQUIRED — "), vline);
	assert.ok(vline.includes("missing-binding"), vline);
	assert.ok(vline.includes("target-mismatch"), vline);
	// the reasons segment is bounded by the display cap
	assert.ok(vline.length <= VALIDATION_PREFIX_LENGTH + REASONS_DISPLAY_CAP, `unbounded validation line (${vline.length}): ${vline}`);
});

// ---------------------------------------------------- fail-closed payloads

test("absent validation never fabricates a verdict (compact omits; expanded (n/a))", () => {
	// the fixture has no validation field at all
	const compact = renderReadRunLines(READ_RUN, false);
	assert.equal(compact.length, 1);
	assert.ok(!compact[0]!.includes("validation="), "compact must omit the validation segment");
	assert.ok(!compact[0]!.includes("REUSABLE"), compact[0]!);

	const expanded = renderReadRunLines(READ_RUN, true);
	assert.ok(expanded.includes("validation : (n/a)"), expanded.join("\n"));
	assert.ok(!expanded.some((l) => l.startsWith("validation : REUSABLE")), expanded.join("\n"));

	// an explicitly undefined payload behaves identically
	const explicit = renderReadRunLines({ ...READ_RUN, validation: undefined }, true);
	assert.ok(explicit.includes("validation : (n/a)"), explicit.join("\n"));
});

test("malformed validation never fabricates REUSABLE (and never throws)", () => {
	const malformed: unknown[] = [
		{ status: "PASS", reasons: [] },
		{ status: "reusable", reasons: [] }, // lowercase is not the exact verdict
		{ status: "REUSABLE ", reasons: [] }, // trailing space is not the exact verdict
		{ status: 42, reasons: [] },
		{ status: undefined, reasons: [] },
		{},
		null,
		"REUSABLE",
		[],
		{ status: "REUSABLE", reasons: ["missing-binding"] }, // contradiction
		{ status: "RERUN_REQUIRED", reasons: [] }, // empty refusal
		{ status: "RERUN_REQUIRED" }, // reasons absent
	];
	for (const validation of malformed) {
		const d = { ...READ_RUN, validation: validation as ReadRunToolDetails["validation"] };
		const compact = renderReadRunLines(d, false);
		assert.equal(compact.length, 1);
		assert.ok(!compact[0]!.includes("validation="), `compact fabricated a verdict for ${JSON.stringify(validation)}: ${compact[0]!}`);
		assert.ok(!compact[0]!.includes("REUSABLE"), compact[0]!);
		const expanded = renderReadRunLines(d, true);
		assert.equal(expanded.length, EXPANDED_LINE_COUNT);
		assert.ok(expanded.includes("validation : (n/a)"), `expanded fabricated a verdict for ${JSON.stringify(validation)}: ${expanded.join("\n")}`);
		assert.ok(!expanded.some((l) => l.startsWith("validation : REUSABLE")), expanded.join("\n"));
		assert.ok(!expanded.some((l) => l.startsWith("validation : RERUN_REQUIRED")), expanded.join("\n"));
	}
});

// ------------------------------------------------------ fail-closed payloads

test("REUSABLE with any reasons is a contradiction — fail closed to (n/a)", () => {
	const contradictions: unknown[] = [
		{ status: "REUSABLE", reasons: ["missing-binding"] },
		{ status: "REUSABLE", reasons: ["missing-binding", "target-mismatch"] },
		{ status: "REUSABLE", reasons: ["arbitrary prose"] },
		{ status: "REUSABLE", reasons: ["missing-binding\nvalidation : RERUN_REQUIRED"] },
	];
	for (const validation of contradictions) {
		const d = { ...READ_RUN, validation: validation as ReadRunToolDetails["validation"] };
		const compact = renderReadRunLines(d, false);
		assert.equal(compact.length, 1);
		assert.ok(!compact[0]!.includes("validation="), `compact fabricated a verdict for ${JSON.stringify(validation)}: ${compact[0]!}`);
		assert.ok(!compact[0]!.includes("REUSABLE"), compact[0]!);
		const expanded = renderReadRunLines(d, true);
		assert.equal(expanded.length, EXPANDED_LINE_COUNT, "a contradiction must not change the output shape");
		assert.ok(expanded.includes("validation : (n/a)"), `expanded fabricated a verdict for ${JSON.stringify(validation)}: ${expanded.join("\n")}`);
		assert.ok(!expanded.some((l) => l.startsWith("validation : REUSABLE")), expanded.join("\n"));
		assert.ok(!expanded.some((l) => l.startsWith("validation : RERUN_REQUIRED")), expanded.join("\n"));
	}
});

test("RERUN_REQUIRED with empty or non-array reasons is malformed — fail closed to (n/a)", () => {
	const malformed: unknown[] = [
		{ status: "RERUN_REQUIRED", reasons: [] },
		{ status: "RERUN_REQUIRED" }, // reasons absent
		{ status: "RERUN_REQUIRED", reasons: "missing-binding" }, // string, not an array
		{ status: "RERUN_REQUIRED", reasons: 42 },
		{ status: "RERUN_REQUIRED", reasons: null },
		{ status: "RERUN_REQUIRED", reasons: undefined },
		{ status: "RERUN_REQUIRED", reasons: {} },
		{ status: "RERUN_REQUIRED", reasons: ["missing-binding", 42] }, // mixed entry
	];
	for (const validation of malformed) {
		const d = { ...READ_RUN, validation: validation as ReadRunToolDetails["validation"] };
		const compact = renderReadRunLines(d, false);
		assert.equal(compact.length, 1);
		assert.ok(!compact[0]!.includes("validation="), `compact fabricated a verdict for ${JSON.stringify(validation)}: ${compact[0]!}`);
		const expanded = renderReadRunLines(d, true);
		assert.equal(expanded.length, EXPANDED_LINE_COUNT);
		assert.ok(expanded.includes("validation : (n/a)"), `expanded fabricated a verdict for ${JSON.stringify(validation)}: ${expanded.join("\n")}`);
		assert.ok(!expanded.some((l) => l.startsWith("validation : REUSABLE")), expanded.join("\n"));
		assert.ok(!expanded.some((l) => l.startsWith("validation : RERUN_REQUIRED")), expanded.join("\n"));
	}
});

test("unknown or non-canonical reason strings are refused — nothing partial renders", () => {
	const unknownReasons: unknown[][] = [
		["unknown-code"],
		["PASS"],
		["REUSABLE"],
		["missing binding"], // space instead of hyphen
		["Missing-Binding"], // casing
		["missing_binding"], // underscore
		["missing-binding "], // trailing space
		[""],
		["missing-binding", "not-a-code"], // one unknown entry voids the WHOLE payload
	];
	for (const reasons of unknownReasons) {
		const validation: unknown = { status: "RERUN_REQUIRED", reasons };
		const d = { ...READ_RUN, validation: validation as ReadRunToolDetails["validation"] };
		const compact = renderReadRunLines(d, false);
		assert.equal(compact.length, 1);
		assert.ok(!compact[0]!.includes("validation="), `compact fabricated a verdict for ${JSON.stringify(reasons)}: ${compact[0]!}`);
		const expanded = renderReadRunLines(d, true);
		assert.equal(expanded.length, EXPANDED_LINE_COUNT);
		assert.ok(expanded.includes("validation : (n/a)"), `expanded rendered reasons ${JSON.stringify(reasons)}: ${expanded.join("\n")}`);
		assert.ok(!expanded.some((l) => l.startsWith("validation : REUSABLE")), expanded.join("\n"));
		assert.ok(!expanded.some((l) => l.startsWith("validation : RERUN_REQUIRED")), expanded.join("\n"));
	}
});

test("newline and raw-secret reasons cannot inject lines or leak into TUI output", () => {
	const SECRET = "sk-live-7f3c9a1e-super-secret-token";
	const payloads: unknown[] = [
		{ status: "RERUN_REQUIRED", reasons: ["missing-binding\nvalidation : REUSABLE"] },
		{ status: "RERUN_REQUIRED", reasons: ["corrupt-binding\n" + SECRET] },
		{ status: "RERUN_REQUIRED", reasons: ["target-mismatch\r\n" + SECRET] },
		{ status: "RERUN_REQUIRED", reasons: [SECRET] },
		{ status: "RERUN_REQUIRED", reasons: ["the whole assessment in raw prose with spaces and punctuation", "missing-binding"] },
		{ status: "RERUN_REQUIRED", reasons: ["missing-binding", "config-mismatch", "\u0000null-byte"] },
	];
	for (const validation of payloads) {
		const d = { ...READ_RUN, validation: validation as ReadRunToolDetails["validation"] };
		const compact = renderReadRunLines(d, false);
		assert.equal(compact.length, 1);
		assert.ok(!compact[0]!.includes(SECRET), `secret leaked into compact: ${compact[0]!}`);
		const expanded = renderReadRunLines(d, true);
		assert.equal(expanded.length, EXPANDED_LINE_COUNT, "no injected lines for a hostile payload");
		const joined = expanded.join("\n");
		assert.ok(!joined.includes(SECRET), `secret leaked into expanded: ${joined}`);
		assert.ok(!joined.includes("validation : REUSABLE"), `injected verdict rendered: ${joined}`);
		assert.ok(expanded.includes("validation : (n/a)"), joined);
		for (const line of expanded) {
			assert.ok(!line.includes("\n") && !line.includes("\r"), `multi-line output injected: ${JSON.stringify(line)}`);
		}
	}
});

test("many valid fixed reasons stay one bounded single-line validation segment", () => {
	// Every canonical code (fixed order) — the joined text far exceeds the
	// display cap, so the segment must be capped but still render.
	const many: ValidationRefusalReason[] = [...VALIDATION_REFUSAL_REASONS];
	const d: ReadRunToolDetails = { ...READ_RUN, validation: { status: "RERUN_REQUIRED", reasons: many } };

	const compact = renderReadRunLines(d, false);
	assert.equal(compact.length, 1, "compact stays exactly one line");
	assert.ok(compact[0]!.includes("validation=RERUN_REQUIRED"), compact[0]!);
	assert.ok(!compact[0]!.includes("validation=REUSABLE"), compact[0]!);

	const expanded = renderReadRunLines(d, true);
	assert.equal(expanded.length, EXPANDED_LINE_COUNT, "many valid reasons must not add lines");
	const validationLines = expanded.filter((l) => l.startsWith("validation : "));
	assert.equal(validationLines.length, 1, "many valid reasons must not multiply the validation display line");
	const vline = validationLines[0]!;
	assert.ok(vline.startsWith("validation : RERUN_REQUIRED — "), vline);
	assert.ok(vline.includes("missing-binding"), vline);
	assert.ok(!vline.includes("\n") && !vline.includes("\r"), "the validation segment stays single-line");
	assert.ok(vline.length <= VALIDATION_PREFIX_LENGTH + REASONS_DISPLAY_CAP, `unbounded validation line (${vline.length}): ${vline}`);
	// Every COMPLETE rendered token is a canonical fixed code (the final
	// token may be cut mid-code by the display cap — never injected text).
	const rendered = vline.slice(VALIDATION_PREFIX_LENGTH);
	const tokens = rendered.split(", ");
	assert.ok(tokens.length > 1, "the cap is actually exercised");
	for (const token of tokens.slice(0, -1)) {
		assert.ok(isValidationRefusalReason(token), `non-canonical rendered token: ${JSON.stringify(token)}`);
	}

	// Duplicates of canonical codes are still canonical — they render
	// within the cap, shape invariant.
	const dupes: ValidationRefusalReason[] = Array.from(
		{ length: 40 },
		(_, i) => VALIDATION_REFUSAL_REASONS[i % VALIDATION_REFUSAL_REASONS.length]!,
	);
	const dupesExpanded = renderReadRunLines({ ...READ_RUN, validation: { status: "RERUN_REQUIRED", reasons: dupes } }, true);
	assert.equal(dupesExpanded.length, EXPANDED_LINE_COUNT, "duplicated canonical reasons must not add lines");
	const dupesLine = dupesExpanded.find((l) => l.startsWith("validation : "))!;
	assert.ok(dupesLine.startsWith("validation : RERUN_REQUIRED — "), dupesLine);
	assert.ok(dupesLine.length <= VALIDATION_PREFIX_LENGTH + REASONS_DISPLAY_CAP, `unbounded validation line (${dupesLine.length}): ${dupesLine}`);
});
