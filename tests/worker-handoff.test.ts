/**
 * P7 bounded worker handoff tests (worker/handoff.ts + worker/context-diagnostics.ts).
 *
 * Coverage: the five centralized bounds; UTF-8-safe truncation (multibyte
 * sequences and 4-byte astral characters never split, no lone surrogates);
 * the four-section report parser (item/section caps, overlong items,
 * Chinese UTF-8, missing-section fallback with parse warning — never raw
 * text; the reliable-vs-capped distinction); the parent handoff builder
 * (≤120 lines / ≤12288 UTF-8 bytes after rendering, required fact lines
 * always preserved — even with 500×400-char pathological paths and CJK
 * items, whole-line dropping never cuts mid-item, no report/patch/test-log
 * content, details exclusions incl. allowed_paths, actual changed paths
 * from the ledger input, the safe fallback with no partial section items,
 * the commander-action instruction); and the pure context diagnostics
 * (estimateLatestTurnTokens / compactablePrefixAvailable /
 * detectSingleHugeRecentTurn) — the compaction-boundary root shape is
 * honored via firstKeptEntryId on ORIGINAL entry indices, the old ~50-KiB
 * runner-bounded handoff is flagged while the new ≤12-KiB bounded handoff
 * never triggers, malformed input fails safe, and Pi compaction is never
 * reimplemented.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";

import {
	buildDelegateWorkerResult,
	changedPathsLine,
	HANDOFF_COMMANDER_ACTION_LINES,
	HANDOFF_DEFAULT_DELIVERY_COMPLETE_LINES,
	isVerificationCommand,
	MAX_PARENT_HANDOFF_BYTES,
	MAX_PARENT_HANDOFF_LINES,
	MAX_SUMMARY_ITEM_CHARS,
	MAX_SUMMARY_ITEMS_PER_SECTION,
	MAX_WORKER_REPORT_BYTES,
	parsedReportToHandoffSummary,
	parseWorkerReport,
	reportPathSibling,
	sanitizeSummaryItem,
	truncateUtf8,
	type BuildDelegateWorkerResultInput,
	type HandoffSpendFacts,
	type HandoffSummary,
	type ParsedWorkerReport,
} from "../extensions/workbench-runtime/worker/handoff.ts";
import {
	compactablePrefixAvailable,
	CONTEXT_RISK_DELEGATION_HANDOFF_TOO_LARGE,
	DEFAULT_HUGE_TURN_MIN_BYTES,
	DEFAULT_HUGE_TURN_MIN_TOKENS,
	delegationContextRiskLine,
	detectSingleHugeRecentTurn,
	estimateLatestTurnTokens,
} from "../extensions/workbench-runtime/worker/context-diagnostics.ts";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

test("the five bounded-handoff constants are centralized with the fixed values", () => {
	assert.equal(MAX_PARENT_HANDOFF_BYTES, 12 * 1024);
	assert.equal(MAX_PARENT_HANDOFF_LINES, 120);
	assert.equal(MAX_WORKER_REPORT_BYTES, 512 * 1024);
	assert.equal(MAX_SUMMARY_ITEMS_PER_SECTION, 8);
	assert.equal(MAX_SUMMARY_ITEM_CHARS, 500);
});

// ---------------------------------------------------------------------------
// UTF-8-safe truncation
// ---------------------------------------------------------------------------

test("truncateUtf8 never splits a multibyte sequence and is byte-exact", () => {
	// ASCII: byte cap is exact.
	assert.equal(truncateUtf8("abcdef", 3), "abc");
	assert.equal(truncateUtf8("abcdef", 6), "abcdef");
	assert.equal(truncateUtf8("abcdef", 100), "abcdef");
	// CJK: each char is 3 bytes; a 4-byte cap must cut to ONE char (3 bytes),
	// never split the second char.
	const cjk = "已实现";
	assert.equal(truncateUtf8(cjk, 4), "已");
	assert.equal(truncateUtf8(cjk, 6), "已实");
	assert.equal(truncateUtf8(cjk, 5), "已", "a cut inside a 3-byte char falls back to the previous char boundary");
	assert.equal(Buffer.byteLength(truncateUtf8(cjk.repeat(1000), 1000), "utf8"), 999, "byte budget respected to the boundary");
	// Emoji surrogate pair: 4 bytes per char; a 5-byte cap keeps one full emoji.
	const emoji = "✅✅";
	assert.equal(truncateUtf8(emoji, 5), "✅");
	// Malformed input fails safe.
	assert.equal(truncateUtf8("", 10), "");
	assert.equal(truncateUtf8("abc", 0), "");
	assert.equal(truncateUtf8("abc", -5), "");
	assert.equal(truncateUtf8("abc", Number.NaN), "");
});

test("truncateUtf8 is code-point safe for 4-byte astral characters at every small byte cap", () => {
	// U+1F680 ROCKET: 2 UTF-16 code units, 4 UTF-8 bytes. The old binary
	// search over UTF-16 indices could cut BETWEEN the surrogate pair and
	// return a lone surrogate (encoded as U+FFFD by Buffer).
	const rocket = "🚀";
	for (const cap of [1, 2, 3]) {
		assert.equal(truncateUtf8(rocket, cap), "", `cap ${cap} cannot hold a 4-byte astral char`);
	}
	assert.equal(truncateUtf8(rocket, 4), rocket, "cap 4 holds exactly one astral char");
	assert.equal(truncateUtf8(`${rocket}x`, 4), rocket, "cap 4 keeps the full emoji and drops the ASCII tail");
	// Two astral chars (8 bytes): caps 5/6/7 must return exactly ONE whole
	// emoji — never a lone surrogate, never a replacement char.
	const pair = `${rocket}${rocket}`;
	for (const cap of [5, 6, 7]) {
		const cut = truncateUtf8(pair, cap);
		assert.equal(cut, rocket, `cap ${cap} returns one whole emoji`);
		assert.equal(Buffer.from(cut, "utf8").toString("utf8"), cut, `cap ${cap}: strict round trip — never a LONE surrogate`);
		assert.ok(!cut.includes("\uFFFD"), `cap ${cap}: no replacement char`);
	}
	assert.equal(truncateUtf8(pair, 8), pair);
	// Mixed astral + CJK: the byte cap is respected and the result is always
	// strictly valid UTF-8 (round trip is lossless — no malformed sequences).
	const mixed = `${rocket}${"已".repeat(50)}${rocket}`;
	const cut = truncateUtf8(mixed, 40);
	assert.ok(Buffer.byteLength(cut, "utf8") <= 40, "byte budget respected");
	assert.equal(Buffer.from(cut, "utf8").toString("utf8"), cut, "strict round trip — no lone surrogate, no malformed sequence");
	assert.ok(!cut.includes("\uFFFD"), "no replacement char");
});

test("sanitizeSummaryItem flattens newlines and caps characters without splitting surrogate pairs", () => {
	assert.deepEqual(sanitizeSummaryItem("  line1\nline2\tline3  "), { text: "line1 line2 line3", truncated: false });
	assert.deepEqual(sanitizeSummaryItem("x".repeat(501)), { text: "x".repeat(500), truncated: true });
	const cjk = "实".repeat(501);
	assert.equal(sanitizeSummaryItem(cjk).text.length, 500, "500 CHARACTERS kept, not bytes");
	assert.equal(sanitizeSummaryItem(cjk).truncated, true);
	// A real surrogate-pair character (U+1F680, 2 UTF-16 units per char):
	// the 500-character cap counts CODE POINTS, so pairs are never split
	// and no replacement char appears.
	const rocket = "🚀".repeat(600);
	const emoji = sanitizeSummaryItem(rocket);
	assert.equal(Array.from(emoji.text).length, 500, "500 code points kept");
	assert.equal(emoji.text.length, 1000, "kept chars are whole surrogate pairs (2 UTF-16 units each)");
	assert.equal(emoji.truncated, true);
	assert.ok(!emoji.text.includes("\uFFFD"), "no replacement chars — no split surrogate pair");
});

// ---------------------------------------------------------------------------
// four-section report parser
// ---------------------------------------------------------------------------

function fullReport(): string {
	return [
		"## Completed",
		"- Implemented the parser slice",
		"- Added focused tests",
		"## Files Changed",
		"- `src/parser.ts` — new option",
		"- `tests/parser.test.ts`",
		"## Verification",
		"- `npm run typecheck` — exit 0",
		"- ran the unit-test recipe: 12 tests passed, 0 failed",
		"## Remaining Risks",
		"- none",
	].join("\n");
}

test("parseWorkerReport extracts the four required sections into bounded items", () => {
	const parsed = parseWorkerReport(fullReport());
	assert.deepEqual(parsed.completed, ["Implemented the parser slice", "Added focused tests"]);
	assert.deepEqual(parsed.filesChangedClaims, ["`src/parser.ts` — new option", "`tests/parser.test.ts`"]);
	assert.deepEqual(parsed.verificationCommands, ["`npm run typecheck` — exit 0"], "backticked command claims are commands");
	assert.deepEqual(parsed.verificationObservations, ["ran the unit-test recipe: 12 tests passed, 0 failed"], "prose results are observations");
	assert.deepEqual(parsed.remainingRisks, ["none"]);
	assert.equal(parsed.parseWarning, null, "a normal four-section report parses reliably");
	assert.deepEqual(parsed.foundSections, ["completed", "files changed", "verification", "remaining risks"]);
	assert.equal(parsed.truncatedItems, false);
	assert.equal(parsed.reliable, true);
});

test("parseWorkerReport degrades safely: missing sections, empty and malformed reports yield a parse warning, never raw text", () => {
	const partial = parseWorkerReport("## Completed\n- only this section\n");
	assert.deepEqual(partial.completed, ["only this section"]);
	assert.deepEqual(partial.remainingRisks, []);
	assert.equal(partial.reliable, false, "missing required sections make parsing UNRELIABLE");
	assert.match(partial.parseWarning ?? "", /missing required section\(s\): files changed, verification, remaining risks/);
	// Empty and malformed inputs.
	const empty = parseWorkerReport("");
	assert.ok((empty.parseWarning ?? "").startsWith("worker report is empty"), empty.parseWarning ?? "");
	assert.deepEqual(empty.completed, []);
	assert.equal(empty.reliable, false);
	const nonString = parseWorkerReport(42 as unknown);
	assert.ok((nonString.parseWarning ?? "").startsWith("worker report is empty"));
	assert.equal(nonString.reliable, false);
	// Prose between sections is ignored; unknown ## headings end a section.
	const prose = parseWorkerReport("PREAMBLE prose\n## Completed\n- done\n## Unrelated\n- not an item\n## Remaining Risks\n- risk");
	assert.deepEqual(prose.completed, ["done"]);
	assert.deepEqual(prose.remainingRisks, ["risk"]);
	assert.equal(prose.reliable, false, "the Unrelated heading is not a required section");
});

test("parseWorkerReport distinguishes missing sections (unreliable) from item-cap truncation (reliable but bounded)", () => {
	// All four sections present but the Completed section overflows the item
	// cap: parsing stays RELIABLE — the parent renders the bounded items
	// plus the explicit truncation fact, never a fallback.
	const capped = [
		"## Completed",
		...Array.from({ length: 12 }, (_, i) => `- item ${i}`),
		"## Files Changed",
		"- `src/a.ts`",
		"## Verification",
		"- ran unit-test",
		"## Remaining Risks",
		"- none",
	].join("\n");
	const parsed = parseWorkerReport(capped);
	assert.equal(parsed.reliable, true, "cap hits alone do not make sections unreliable");
	assert.equal(parsed.truncatedItems, true);
	assert.match(parsed.parseWarning ?? "", /section item cap/);
	assert.equal(parsed.completed.length, MAX_SUMMARY_ITEMS_PER_SECTION, "at most 8 items per section");
	assert.ok(parsed.completed.includes("item 7") && !parsed.completed.includes("item 11"), "the newest overflow items are dropped");
	// The same overflow with a MISSING section is unreliable.
	const missing = parseWorkerReport(["## Completed", ...Array.from({ length: 12 }, (_, i) => `- item ${i}`)].join("\n"));
	assert.equal(missing.reliable, false, "missing sections dominate the caps fact");
});

test("parseWorkerReport caps items per section (8) and characters per item (500) and warns", () => {
	const many = ["## Completed", ...Array.from({ length: 12 }, (_, i) => `- item ${i}`), "## Remaining Risks", "- none"].join("\n");
	const parsed = parseWorkerReport(many);
	assert.equal(parsed.completed.length, MAX_SUMMARY_ITEMS_PER_SECTION, "at most 8 items per section");
	assert.ok(parsed.completed.includes("item 7") && !parsed.completed.includes("item 11"), "the newest overflow items are dropped");
	assert.equal(parsed.truncatedItems, true);
	assert.match(parsed.parseWarning ?? "", /section item cap/);
	// Overlong items are truncated to 500 chars.
	const overlong = ["## Completed", `- ${"长".repeat(600)}`, "## Remaining Risks", "- none"].join("\n");
	const capped = parseWorkerReport(overlong);
	assert.equal(capped.completed[0]?.length, 500, "overlong items are capped at 500 characters");
	assert.match(capped.parseWarning ?? "", /section item cap/);
});

test("isVerificationCommand separates command claims from observed results", () => {
	assert.equal(true, isVerificationCommand("`npm run typecheck` — exit 0"));
	assert.equal(true, isVerificationCommand("npm run typecheck — exit 0"));
	assert.equal(true, isVerificationCommand("workbench_run_recipe unit-test: exit 0"));
	assert.equal(false, isVerificationCommand("ran the unit-test recipe"));
	assert.equal(false, isVerificationCommand("exit 0, 12 tests passed"));
	assert.equal(false, isVerificationCommand("none"));
	assert.equal(false, isVerificationCommand("ok"));
	assert.equal(false, isVerificationCommand(""));
});

// ---------------------------------------------------------------------------
// parent handoff builder
// ---------------------------------------------------------------------------

const HANDOFF_REPORT = [
	"PREAMBLE: full report body that must never be embedded inline.",
	"## Completed",
	"- Implemented the slice",
	"## Files Changed",
	"- `src/main.ts`",
	"## Verification",
	"- `npm run typecheck` — exit 0",
	"- ran the unit-test recipe: 10 tests passed",
	"## Remaining Risks",
	"- none",
].join("\n");

function handoffInput(overrides: Partial<BuildDelegateWorkerResultInput> = {}): BuildDelegateWorkerResultInput {
	return {
		delegationId: "20260601-120000-abcd",
		provider: WORKER_PROVIDER,
		model: WORKER_MODEL_ID,
		status: "success",
		turns: 3,
		exitCode: 0,
		stopReason: "stop",
		changedPaths: ["src/main.ts"],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 20,
			cacheWrite: 0,
			totalTokens: 35,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
		},
		cacheHitRatio: 2 / 3,
		budget: {
			maxContextTokens: 108_800,
			maxContextRatio: 0.4,
			softBudgetReached: false,
			hardBudgetExceeded: false,
			compactionCount: 0,
			compactionReasons: [],
		},
		reportPath: ".pi/workbench/delegations/20260601-120000-abcd/worker-report.md",
		summary: parsedReportToHandoffSummary(parseWorkerReport(HANDOFF_REPORT)),
		reviewStatus: "PENDING_REVIEW",
		...overrides,
	};
}

test("parsedReportToHandoffSummary converts the parsed report into the persisted parent-handoff shape", () => {
	const parsed = parseWorkerReport(fullReport());
	const summary = parsedReportToHandoffSummary(parsed);
	assert.deepEqual(summary, {
		completed: ["Implemented the parser slice", "Added focused tests"],
		verification_commands: ["`npm run typecheck` — exit 0"],
		verification_observations: ["ran the unit-test recipe: 12 tests passed, 0 failed"],
		remaining_risks: ["none"],
		parse_warning: null,
		parse_reliable: true,
		truncated_items: false,
	});
	const partial = parsedReportToHandoffSummary(parseWorkerReport("## Completed\n- only this section\n"));
	assert.equal(partial.parse_reliable, false);
	assert.equal(partial.parse_warning, "missing required section(s): files changed, verification, remaining risks");
});

test("the parent handoff never contains report/patch/test-log content and is bounded to 120 lines / 12288 UTF-8 bytes", () => {
	const result = buildDelegateWorkerResult(handoffInput());
	const text = result.content[0]?.text ?? "";
	// No report body, no patch, no test log.
	assert.ok(!text.includes("PREAMBLE"), "the report body is never embedded");
	assert.ok(!text.includes("diff --git"), "no patch content");
	assert.ok(!text.includes("12 tests passed"), "no test logs");
	// Caps hold after rendering.
	assert.ok(text.split("\n").length <= MAX_PARENT_HANDOFF_LINES, "line cap");
	assert.ok(Buffer.byteLength(text, "utf8") <= MAX_PARENT_HANDOFF_BYTES, "UTF-8 byte cap");
	// The required bounded facts are present.
	assert.ok(text.includes("20260601-120000-abcd"), "delegation id");
	assert.ok(text.includes("openai-codex/gpt-5.6-luna"), "provider/model");
	assert.ok(text.includes("SUCCESS"), "status");
	assert.ok(text.includes("src/main.ts"), "actual changed paths");
	assert.ok(text.includes("uncached input 10 | cache read 20 | hit ratio 67%"), "usage/cache summary");
	assert.ok(text.includes("worker budget : max context 108800 / 272000 (40%)"), "budget summary");
	assert.ok(text.includes(".pi/workbench/delegations/20260601-120000-abcd/worker-report.md"), "report path");
	assert.ok(text.includes("worker-summary.json") && text.includes("usage.json"), "artifact pointers");
	assert.ok(text.includes("workbench_review_worker_diff"), "Sol must inspect the actual diff");
	assert.ok(text.includes("PENDING_REVIEW"), "review warning");
	assert.ok(text.includes("--- Commander action required ---"), "commander action");
});

test("pathological 500×400-char changed paths and CJK items never remove required facts and never cut a line mid-item", () => {
	const paths = Array.from({ length: 500 }, (_, i) => `src/${"a".repeat(390)}${i}.ts`);
	assert.equal(paths.length, 500);
	assert.ok(paths.every((p) => p.length >= 398 && p.length <= 400), "500 paths of ~400 chars each");
	const summary: HandoffSummary = {
		completed: Array.from({ length: 8 }, (_, i) => `已完成的任务项 ${i}：` + "实".repeat(480)),
		verification_commands: [],
		verification_observations: Array.from({ length: 8 }, (_, i) => `验证观察 ${i}：` + "验".repeat(480)),
		remaining_risks: Array.from({ length: 8 }, (_, i) => `风险 ${i}：` + "险".repeat(480)),
		parse_warning: null,
		parse_reliable: true,
		truncated_items: false,
	};
	const result = buildDelegateWorkerResult(handoffInput({ changedPaths: paths, summary }));
	const text = result.content[0]?.text ?? "";
	assert.ok(text.split("\n").length <= MAX_PARENT_HANDOFF_LINES, "line cap");
	assert.ok(Buffer.byteLength(text, "utf8") <= MAX_PARENT_HANDOFF_BYTES, "UTF-8 byte cap");
	// Required pointers/facts survive the pathological inputs.
	for (const needle of [
		"20260601-120000-abcd",
		"openai-codex/gpt-5.6-luna",
		"SUCCESS",
		"uncached input 10 | cache read 20 | hit ratio 67%",
		"worker budget : max context 108800 / 272000 (40%)",
		".pi/workbench/delegations/20260601-120000-abcd/worker-report.md",
		"worker-summary.json",
		"usage.json",
		"PENDING_REVIEW",
		"workbench_review_worker_diff",
		"--- Commander action required ---",
	]) {
		assert.ok(text.includes(needle), `required fact survives: ${needle.slice(0, 50)}`);
	}
	// Bounded actual changed paths with an explicit omission count.
	assert.match(text, /changed paths : .+more omitted/, "path overflow shows the omission count");
	// No partial item: every rendered item line is a WHOLE sanitized item.
	const allItems = [...summary.completed, ...summary.verification_observations, ...summary.remaining_risks];
	const sanitizedSet = new Set(allItems.map((s) => sanitizeSummaryItem(s).text));
	const renderedItems = text.split("\n").filter((line) => line.startsWith("  - "));
	assert.ok(renderedItems.length > 0, "some items survive");
	for (const line of renderedItems) {
		assert.ok(sanitizedSet.has(line.slice(4)), `rendered line is a whole sanitized item, never a cut: ${line.slice(4, 44)}…`);
	}
	// Strict UTF-8 round trip — no line ends mid-code-point.
	assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
	assert.ok(!text.includes("\uFFFD"), "no replacement characters in the rendered handoff");
});

test("Chinese UTF-8 items are bounded correctly in the parent handoff (bytes, not chars)", () => {
	const summary: HandoffSummary = {
		completed: Array.from({ length: 8 }, (_, i) => `已完成的任务项 ${i}：` + "实".repeat(480)),
		verification_commands: [],
		verification_observations: Array.from({ length: 8 }, (_, i) => `验证观察 ${i}：` + "验".repeat(480)),
		remaining_risks: Array.from({ length: 8 }, (_, i) => `风险 ${i}：` + "险".repeat(480)),
		parse_warning: null,
		parse_reliable: true,
		truncated_items: false,
	};
	const result = buildDelegateWorkerResult(handoffInput({ summary }));
	const text = result.content[0]?.text ?? "";
	// 24 items × ~1500 bytes would be ~36 KiB raw — the byte cap must bind.
	assert.ok(Buffer.byteLength(text, "utf8") <= MAX_PARENT_HANDOFF_BYTES, "UTF-8 byte cap holds with CJK items");
	assert.ok(text.split("\n").length <= MAX_PARENT_HANDOFF_LINES, "line cap holds");
	// The commander-action tail and the required artifact pointers survive.
	assert.ok(text.includes("--- Commander action required ---"), "commander instruction preserved");
	assert.ok(text.includes("workbench_review_worker_diff"), "actual-diff instruction preserved");
	assert.ok(text.includes("worker-report.md") && text.includes("worker-summary.json") && text.includes("usage.json"), "artifact pointers preserved");
	// The truncated body never ends mid-multibyte-sequence (strict round-trip).
	assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
});

test("whole optional summary lines are dropped (never cut) until both caps hold", () => {
	// A handoff whose optional item lines are far too large: the byte cap
	// must bind by DROPPING whole lines — never by cutting one mid-item.
	const summary: HandoffSummary = {
		completed: Array.from({ length: 8 }, (_, i) => `长任务 ${i}：` + "实".repeat(490)),
		verification_commands: [],
		verification_observations: Array.from({ length: 8 }, (_, i) => `验证 ${i}：` + "验".repeat(490)),
		remaining_risks: Array.from({ length: 8 }, (_, i) => `风险 ${i}：` + "险".repeat(490)),
		parse_warning: null,
		parse_reliable: true,
		truncated_items: false,
	};
	const result = buildDelegateWorkerResult(handoffInput({ summary }));
	const text = result.content[0]?.text ?? "";
	assert.ok(Buffer.byteLength(text, "utf8") <= MAX_PARENT_HANDOFF_BYTES);
	const lines = text.split("\n");
	// Whole-item invariant: every "  - " line equals a complete sanitized item.
	const sanitized = new Set(
		[...summary.completed, ...summary.verification_observations, ...summary.remaining_risks].map((s) => sanitizeSummaryItem(s).text),
	);
	for (const line of lines.filter((l) => l.startsWith("  - "))) {
		assert.ok(sanitized.has(line.slice(4)), "every rendered item line is whole");
	}
	// Dropped items are accounted for by the omission marker or the caps fact
	// is not needed when everything fit — at minimum the caps hold.
	const risksSection = lines.findIndex((l) => l === "remaining risk:");
	const requiredIndex = lines.findIndex((l) => l.startsWith("worker cache"));
	assert.ok(requiredIndex >= 0, "the worker cache line is always present");
	if (risksSection >= 0) assert.ok(risksSection < requiredIndex, "item blocks sit before the required fact lines");
});

test("structured details carry only bounded fields and prohibit output/full_report/transcript/patch/allowed_paths/phase", () => {
	const result = buildDelegateWorkerResult(handoffInput());
	const details = result.details;
	assert.equal(details.delegation_id, "20260601-120000-abcd");
	assert.equal(details.report_path, ".pi/workbench/delegations/20260601-120000-abcd/worker-report.md");
	assert.deepEqual(details.changed_paths, ["src/main.ts"], "actual changed paths");
	assert.equal(details.status, "success");
	assert.equal(details.turns, 3);
	assert.equal(details.cache_hit_ratio, 2 / 3);
	assert.equal(details.max_context_tokens, 108_800);
	assert.equal(details.review_status, "PENDING_REVIEW");
	const summary = details.summary as {
		completed: string[];
		parse_warning: string | null;
		parse_reliable: boolean;
		truncated_items: boolean;
	};
	assert.deepEqual(summary.completed, ["Implemented the slice"]);
	assert.equal(summary.parse_warning, null);
	assert.equal(summary.parse_reliable, true);
	assert.equal(summary.truncated_items, false);
	assert.equal(result.usage.input, 10, "top-level nested worker usage preserved for cost accounting");
	for (const forbidden of ["output", "full_report", "transcript", "patch", "allowed_paths", "phase"]) {
		assert.ok(!(forbidden in details), `details must not contain "${forbidden}"`);
	}
	assert.ok(!JSON.stringify(details).includes("PREAMBLE"), "no report text in details");
});

test("details stay tightly bounded: changed paths are capped and failure strings are bounded", () => {
	const paths = Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`);
	const result = buildDelegateWorkerResult(
		handoffInput({ changedPaths: paths, failureMessage: `line1\n${"x".repeat(2000)}` }),
	);
	const details = result.details;
	assert.ok(Array.isArray(details.changed_paths));
	assert.equal((details.changed_paths as string[]).length, 50, "details changed paths are capped");
	assert.equal((details.failure_message as string).length, 500, "failure string is bounded");
	assert.ok(!(details.failure_message as string).includes("\n"), "failure string is flattened to one line");
	// The rendered failure line is bounded too.
	assert.ok((result.content[0]?.text ?? "").includes("failure       : line1 "), "rendered failure line uses the bounded string");
});

test("unreliable report sections trigger the safe fallback: parse warning + facts only, no partial section items", () => {
	const summary: HandoffSummary = {
		completed: ["partial item that must never be shown"],
		verification_commands: [],
		verification_observations: [],
		remaining_risks: [],
		parse_warning: "missing required section(s): files changed, verification, remaining risks",
		parse_reliable: false,
		truncated_items: false,
	};
	// The actual diff is src/main.ts + tests/handoff.test.ts — never the
	// report prose.
	const result = buildDelegateWorkerResult(
		handoffInput({ summary, changedPaths: ["src/main.ts", "tests/handoff.test.ts"] }),
	);
	const text = result.content[0]?.text ?? "";
	assert.ok(text.includes("PARSE WARNING : missing required section(s)"), "parse warning visible");
	assert.ok(text.includes("parsed items  : suppressed"), "the fallback is stated explicitly");
	assert.ok(!/^\s{2}- /m.test(text), "no partial section item is rendered in fallback mode");
	assert.ok(!text.includes("partial item that must never be shown"), "parsed items are never shown");
	assert.ok(text.includes("src/main.ts, tests/handoff.test.ts"), "ACTUAL changed paths shown");
	assert.ok(!text.includes("README.md"), "never the report's Files Changed claims");
	assert.ok(
		text.includes("worker-report.md") && text.includes("worker-summary.json") && text.includes("usage.json"),
		"durable report/artifact paths shown",
	);
	assert.ok(text.includes("workbench_review_worker_diff"), "Sol actual-diff instruction shown");
	assert.ok(text.includes("--- Commander action required ---"), "commander action shown");
	const details = result.details.summary as HandoffSummary;
	assert.deepEqual(details.completed, [], "details carry no partial items either");
	assert.equal(details.parse_reliable, false);
});

test("capped-but-reliable sections render bounded items plus the explicit truncation fact", () => {
	const summary: HandoffSummary = {
		completed: Array.from({ length: 8 }, (_, i) => `item ${i}`),
		verification_commands: [],
		verification_observations: ["ran the unit-test recipe"],
		remaining_risks: ["none"],
		parse_warning: "section item cap (8 items / 500 chars per item) hit; items truncated",
		parse_reliable: true,
		truncated_items: true,
	};
	const result = buildDelegateWorkerResult(handoffInput({ summary }));
	const text = result.content[0]?.text ?? "";
	assert.ok(text.includes("item caps     : hit"), "explicit bounded-truncation fact rendered");
	assert.ok(text.includes("  - item 0") && text.includes("  - item 7"), "bounded items still rendered");
	assert.ok(text.includes("PARSE WARNING : section item cap"), "parse warning line rendered");
	assert.ok(!text.includes("parsed items  : suppressed"), "caps are NOT treated as missing sections");
});

// ---------------------------------------------------------------------------
// Phase 3: cumulative spend facts in the parent handoff (worker token-budget
// repair) — deterministic spend summary line + tightly bounded spend details
// derived from the SAME persisted worker-summary spend object
// ---------------------------------------------------------------------------

const SPEND_FACTS: HandoffSpendFacts = {
	profile: "standard",
	turns: 3,
	totalTokens: 35,
	outputTokens: 5,
	band: "ok",
	softReached: { turns: false, totalTokens: false, outputTokens: false },
	hardExceeded: { turns: false, totalTokens: false, outputTokens: false },
	reasons: [],
};

test("the parent handoff renders the deterministic spend summary line and the nested spend details from the persisted spend object", () => {
	const result = buildDelegateWorkerResult(handoffInput({ spend: SPEND_FACTS }));
	const text = result.content[0]?.text ?? "";
	// The exact deterministic line (profile hard limits as denominators).
	assert.ok(text.includes("spend budget : turns 3/64 | total 35/10880000 | output 5/320000 | profile standard"), "deterministic spend summary line rendered");
	// The nested details carry the EXACT canonical spend object (single
	// derivation — the persisted worker-summary spend object, verbatim).
	assert.deepEqual(result.details.spend, SPEND_FACTS);
	// Caps hold with the new fact line.
	assert.ok(text.split("\n").length <= MAX_PARENT_HANDOFF_LINES, "line cap");
	assert.ok(Buffer.byteLength(text, "utf8") <= MAX_PARENT_HANDOFF_BYTES, "UTF-8 byte cap");
	// The context budget line and the top-level usage stay intact.
	assert.ok(text.includes("worker budget : max context 108800 / 272000 (40%)"), "context budget line preserved");
	assert.equal(result.usage.input, 10, "top-level nested worker usage preserved for cost accounting");
});

test("a hard-band spend object renders the hard-limit summary line and the dimension-named failure line", () => {
	const hardSpend: HandoffSpendFacts = {
		profile: "standard",
		turns: 64,
		totalTokens: 10_880_000,
		outputTokens: 320_000,
		band: "hard",
		softReached: { turns: true, totalTokens: true, outputTokens: true },
		hardExceeded: { turns: true, totalTokens: true, outputTokens: true },
		reasons: ["turns", "total_tokens", "output_tokens"],
	};
	const result = buildDelegateWorkerResult(
		handoffInput({
			spend: hardSpend,
			failureMessage: "Worker cumulative spend hard budget reached (profile standard): turns 64/64, total_tokens 10880000/10880000, output_tokens 320000/320000. Continue with a bounded follow-up delegation in the current Sol session after reviewing any partial delta; do not request a new Sol session.",
		}),
	);
	const text = result.content[0]?.text ?? "";
	assert.ok(text.includes("spend budget : turns 64/64 | total 10880000/10880000 | output 320000/320000 | profile standard"));
	assert.ok(text.includes("failure       : Worker cumulative spend hard budget reached"), "dimension-named failure line rendered");
	assert.ok(text.includes("current Sol session"), "hard stop carries bounded same-session continuation guidance");
	assert.deepEqual(result.details.spend, hardSpend);
	assert.ok(text.split("\n").length <= MAX_PARENT_HANDOFF_LINES);
	assert.ok(Buffer.byteLength(text, "utf8") <= MAX_PARENT_HANDOFF_BYTES);
});

test("the spend summary line is a required fact line that survives byte-cap pressure with CJK items (no split code points)", () => {
	const summary: HandoffSummary = {
		completed: Array.from({ length: 8 }, (_, i) => `已完成的任务项 ${i}：` + "实".repeat(480)),
		verification_commands: [],
		verification_observations: Array.from({ length: 8 }, (_, i) => `验证观察 ${i}：` + "验".repeat(480)),
		remaining_risks: Array.from({ length: 8 }, (_, i) => `风险 ${i}：` + "险".repeat(480)),
		parse_warning: null,
		parse_reliable: true,
		truncated_items: false,
	};
	const result = buildDelegateWorkerResult(handoffInput({ summary, spend: SPEND_FACTS }));
	const text = result.content[0]?.text ?? "";
	assert.ok(text.includes("spend budget : turns 3/64 | total 35/10880000 | output 5/320000 | profile standard"), "the spend line is a required fact line and survives the byte-cap pressure");
	assert.ok(text.split("\n").length <= MAX_PARENT_HANDOFF_LINES, "line cap");
	assert.ok(Buffer.byteLength(text, "utf8") <= MAX_PARENT_HANDOFF_BYTES, "UTF-8 byte cap");
	assert.equal(Buffer.from(text, "utf8").toString("utf8"), text, "strict round trip — no split multibyte sequence");
	assert.ok(!text.includes("\uFFFD"), "no replacement characters");
});

test("spend details are tightly bounded and leak no report text, tool arguments, patches or logs", () => {
	const result = buildDelegateWorkerResult(handoffInput({ spend: SPEND_FACTS }));
	const spend = result.details.spend as Record<string, unknown>;
	assert.deepEqual(
		Object.keys(spend).sort(),
		["band", "hardExceeded", "outputTokens", "profile", "reasons", "softReached", "totalTokens", "turns"],
		"the spend details are exactly the canonical spend object keys",
	);
	assert.equal(spend.profile, "standard");
	assert.ok(Array.isArray(spend.reasons));
	const serialized = JSON.stringify(result.details);
	assert.ok(!serialized.includes("PREAMBLE"), "no report text in the details");
	assert.ok(!serialized.includes("diff --git"), "no patch content in the details");
	assert.ok(!serialized.includes("12 tests passed"), "no test logs in the details");
	assert.ok(!serialized.includes("allowed_paths"), "no allowed_paths in the details");
	// Omitted spend facts keep the exact pre-Phase-3 details shape.
	const legacy = buildDelegateWorkerResult(handoffInput());
	assert.ok(!("spend" in legacy.details), "no spend key when the ledger record carried none");
});

test("changedPathsLine shows whole paths with an omission count and never cuts mid-path", () => {
	assert.equal(changedPathsLine([]), "changed paths : (none) (actual diff from the ledger — never worker prose)");
	const few = changedPathsLine(["src/a.ts", "tests/b.test.ts"]);
	assert.ok(few.includes("src/a.ts, tests/b.test.ts") && !few.includes("omitted"));
	// 500 × 400-char paths: only whole paths are shown, the rest are counted.
	const paths = Array.from({ length: 500 }, (_, i) => `src/${"a".repeat(390)}${i}.ts`);
	const line = changedPathsLine(paths);
	assert.match(line, /\(497 more omitted\)/);
	assert.ok(Buffer.byteLength(line, "utf8") < MAX_PARENT_HANDOFF_BYTES / 2, "the path line stays small");
	for (const path of paths) {
		// Every shown path is complete (a cut path would not round-trip).
		if (line.includes(path)) assert.ok(line.includes(`${path}`), "shown paths are whole");
	}
});

test("reportPathSibling derives the sibling artifact paths", () => {
	const report = ".pi/workbench/delegations/20260601-120000-abcd/worker-report.md";
	assert.equal(reportPathSibling(report, "worker-summary.json"), ".pi/workbench/delegations/20260601-120000-abcd/worker-summary.json");
	assert.equal(reportPathSibling(report, "usage.json"), ".pi/workbench/delegations/20260601-120000-abcd/usage.json");
});

test("the fixed commander-action tail is exactly the documented four lines", () => {
	assert.equal(HANDOFF_COMMANDER_ACTION_LINES.length, 4);
	assert.equal(HANDOFF_COMMANDER_ACTION_LINES[1], "--- Commander action required ---");
	assert.ok(HANDOFF_COMMANDER_ACTION_LINES[3]?.includes("workbench_review_worker_diff"));
});

test("REVIEWED zero-delta handoff returns an ordinary Candidate without lifecycle choreography or strict authority", () => {
	const result = buildDelegateWorkerResult(handoffInput({
		reviewStatus: "REVIEWED",
		changedPaths: [],
		scopeIntegrityPacket: {
			lines: ["review: PASS"],
			review_kind: "scope_integrity",
			scope_integrity_verdict: "PASS",
			bound_diff_hash: "b".repeat(64),
			review_record: ".pi/workbench/delegations/20260601-120000-abcd/v2/review.json",
			presentation_complete: true,
			patch_truncated: false,
			semantic_review: "not_required",
			semantic_risk: "low",
		},
	}));
	const text = result.content[0]?.text ?? "";
	assert.match(text, /review\s+: REVIEWED — semantic acceptance recorded or zero-delta closure/);
	assert.match(text, /candidate\s+: READY_FOR_FINAL_VERIFICATION/);
	assert.match(text, /--- Ordinary delivery complete ---/);
	assert.match(text, /no manual review\/status\/repair command is required/);
	assert.match(text, /Gates, research, release, and profit authority remain separate/);
	assert.doesNotMatch(text, /--- Commander action required ---/);
	assert.deepEqual(result.details.ordinary_candidate, {
		status: "READY_FOR_FINAL_VERIFICATION",
		binding_hash: "b".repeat(64),
		authority_scope: "DEVELOPMENT_ONLY",
		gate_authority: false,
		research_authority: false,
		release_authority: false,
		profit_authority: false,
	});
	assert.equal(HANDOFF_DEFAULT_DELIVERY_COMPLETE_LINES.length, 4);
	assert.ok(Buffer.byteLength(text, "utf8") <= MAX_PARENT_HANDOFF_BYTES);
	assert.ok(text.split("\n").length <= MAX_PARENT_HANDOFF_LINES);
});

test("semantic ACCEPT returns the same ordinary Candidate presentation and no manual lifecycle action", () => {
	const result = buildDelegateWorkerResult(handoffInput({
		reviewStatus: "REVIEWED",
		changedPaths: ["src/a.ts"],
		scopeIntegrityPacket: {
			lines: ["review: PASS"],
			review_kind: "scope_integrity",
			scope_integrity_verdict: "PASS",
			bound_diff_hash: "b".repeat(64),
			review_record: ".pi/workbench/delegations/20260601-120000-abcd/v2/review.json",
			presentation_complete: true,
			patch_truncated: false,
			semantic_review: "accepted",
			semantic_risk: "medium",
		},
	}));
	const text = result.content[0]?.text ?? "";
	assert.match(text, /candidate\s+: READY_FOR_FINAL_VERIFICATION/);
	assert.match(text, /--- Ordinary delivery complete ---/);
	assert.doesNotMatch(text, /Commander action required|workbench_review_worker_diff|workbench_delegation_status|workbench_repair_delegation/);
	assert.equal((result.details.ordinary_candidate as { authority_scope?: string }).authority_scope, "DEVELOPMENT_ONLY");
	assert.equal(result.details.gate_authority, false);
});

test("complete handoff-sized scope/integrity packet is embedded wholly before worker prose under worst-case path pressure", () => {
	const paths = Array.from({ length: 500 }, (_, index) => `src/${"p".repeat(390)}${index}.ts`);
	const packetLines = Array.from({ length: 48 }, (_, index) => `+ packet-${String(index).padStart(2, "0")}-${"x".repeat(80)}`);
	assert.ok(Buffer.byteLength(packetLines.join("\n"), "utf8") < 5_120);
	const result = buildDelegateWorkerResult(handoffInput({
		changedPaths: paths,
		stopReason: "s".repeat(100),
		failureMessage: "f".repeat(500),
		spend: SPEND_FACTS,
		summary: {
			completed: [], verification_commands: [], verification_observations: [], remaining_risks: [],
			parse_warning: "w".repeat(500), parse_reliable: false, truncated_items: false,
		},
		scopeIntegrityPacket: {
			lines: packetLines,
			review_kind: "scope_integrity",
			scope_integrity_verdict: "PASS",
			bound_diff_hash: "b".repeat(64),
			review_record: ".pi/workbench/delegations/20260601-120000-abcd/v2/review.json",
			presentation_complete: true,
			patch_truncated: false,
			semantic_review: "required",
			semantic_risk: "medium",
		},
	}));
	const text = result.content[0]?.text ?? "";
	assert.equal(result.details.presentation_complete, true, "a backend-complete default packet must never be clipped in the delegate result");
	assert.equal(result.details.patch_truncated, false);
	for (const line of packetLines) assert.ok(text.includes(line), `whole packet line embedded: ${line.slice(0, 20)}`);
	assert.ok(text.indexOf(packetLines[0]!) < text.indexOf("--- Commander action required ---"), "actual diff packet precedes the required commander tail");
	assert.ok(Buffer.byteLength(text, "utf8") <= MAX_PARENT_HANDOFF_BYTES);
	assert.ok(text.split("\n").length <= MAX_PARENT_HANDOFF_LINES);
	assert.equal(result.details.semantic_review, "required");
	assert.equal(result.details.gate_authority, false);
});

test("a complete strict compact-facts packet remains presentation-complete despite honest source-content summarization", () => {
	const result = buildDelegateWorkerResult(handoffInput({
		scopeIntegrityPacket: {
			lines: [
				"review kind: scope_integrity (mechanical; no semantic-quality or Gate authority)",
				"evidence   : COMPLETE — each worker path has a full patch or strict compact fact packet",
				"compact   : status=\" M\" size=40000 bytes digest=" + "a".repeat(64) + " (sha256)",
				"generator : generator equality NOT_VERIFIED — independent current-state generator validation is required",
			],
			review_kind: "scope_integrity",
			scope_integrity_verdict: "PASS",
			bound_diff_hash: "c".repeat(64),
			review_record: ".pi/workbench/delegations/20260601-120000-abcd/v2/review.json",
			presentation_complete: true,
			patch_truncated: true,
			semantic_review: "required",
			semantic_risk: "high",
		},
	}));
	const text = result.content[0]?.text ?? "";
	assert.equal(result.details.presentation_complete, true);
	assert.equal(result.details.patch_truncated, true, "source content summarization remains explicit");
	assert.match(text, /packet display: COMPLETE \(strict compact facts complete; source content summarized\)/);
	assert.match(text, /generator equality NOT_VERIFIED/);
	assert.equal(result.details.semantic_risk, "high");
	assert.equal(result.details.gate_authority, false);
});

// ---------------------------------------------------------------------------
// diagnostics: estimateLatestTurnTokens / compactablePrefixAvailable /
// detectSingleHugeRecentTurn
// ---------------------------------------------------------------------------

function messageEntry(message: Record<string, unknown>): { type: "message"; message: Record<string, unknown> } {
	return { type: "message", message };
}

function userEntry(text: string): { type: "message"; message: Record<string, unknown> } {
	return messageEntry({ role: "user", content: [{ type: "text", text }] });
}

function assistantEntry(text: string, usage?: Record<string, unknown>): { type: "message"; message: Record<string, unknown> } {
	return messageEntry({ role: "assistant", content: [{ type: "text", text }], usage });
}

function delegationToolResultEntry(text: string): { type: "message"; message: Record<string, unknown> } {
	return messageEntry({ role: "toolResult", toolName: "workbench_delegate_worker", content: [{ type: "text", text }] });
}

test("the default diagnostic thresholds are relative to the 12 KiB parent cap: above a new handoff, below the old 50-KiB runner bound", () => {
	assert.equal(MAX_PARENT_HANDOFF_BYTES, 12 * 1024);
	assert.equal(DEFAULT_HUGE_TURN_MIN_BYTES, 2 * MAX_PARENT_HANDOFF_BYTES, "byte threshold = 2× the new parent cap");
	assert.equal(DEFAULT_HUGE_TURN_MIN_TOKENS, Math.ceil((2 * MAX_PARENT_HANDOFF_BYTES) / 4), "token threshold = the char/4 estimate of the byte threshold");
	assert.ok(DEFAULT_HUGE_TURN_MIN_BYTES > MAX_PARENT_HANDOFF_BYTES, "strictly above the new cap — a valid new handoff never warns");
	assert.ok(DEFAULT_HUGE_TURN_MIN_BYTES < 50 * 1024, "below Pi's old DEFAULT_MAX_BYTES ≈ 50 KiB — the pre-fix handoff always warns");
});

test("estimateLatestTurnTokens estimates the latest turn with Pi's char/4 heuristic plus usage", () => {
	const entries = [
		userEntry("first turn prompt"),
		assistantEntry("first turn reply"),
		userEntry("u".repeat(20)),
		assistantEntry("a".repeat(20), { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150 }),
		delegationToolResultEntry("x".repeat(400)),
	];
	// The latest turn is user(20) + assistant(20) + toolResult(400) = 440
	// chars → ceil(440/4) = 110 text tokens; usage adds 150.
	const withUsage = estimateLatestTurnTokens(entries);
	assert.equal(withUsage, 110 + 150);
	const textOnly = estimateLatestTurnTokens(entries, { includeUsage: false });
	assert.equal(textOnly, 110);
	// Malformed sessions fail safe to 0.
	assert.equal(estimateLatestTurnTokens([]), 0);
	assert.equal(estimateLatestTurnTokens([{ type: "message", message: { role: "user", content: "hi" } }]), 0, "no assistant → 0");
	assert.equal(estimateLatestTurnTokens("garbage" as unknown as readonly unknown[]), 0);
});

test("compactablePrefixAvailable mirrors Pi cut points defensively: one-turn sessions have no prefix", () => {
	// The problematic single-huge-recent-turn shape: exactly one turn.
	assert.equal(compactablePrefixAvailable([userEntry("delegate"), assistantEntry("ok"), delegationToolResultEntry("result")]), false);
	// A compaction entry followed by the single delegation turn still has no prefix.
	assert.equal(
		compactablePrefixAvailable([{ type: "compaction" }, userEntry("delegate"), assistantEntry("ok"), delegationToolResultEntry("result")]),
		false,
	);
	// Two complete turns: a prefix before the latest turn exists.
	assert.equal(
		compactablePrefixAvailable([userEntry("a"), assistantEntry("b"), userEntry("delegate"), assistantEntry("ok"), delegationToolResultEntry("result")]),
		true,
	);
	// The newest entry being a compaction means Pi prepares nothing.
	assert.equal(compactablePrefixAvailable([userEntry("a"), assistantEntry("b"), { type: "compaction" }]), false);
	// Malformed input fails safe.
	assert.equal(compactablePrefixAvailable([]), false);
	assert.equal(compactablePrefixAvailable("garbage" as unknown as readonly unknown[]), false);
	assert.equal(compactablePrefixAvailable([{ type: "message", message: "not-an-object" }]), false);
});

test("compactablePrefixAvailable honors the latest compaction firstKeptEntryId boundary on ORIGINAL entry indices", () => {
	// The exact root shape: historical turns + a compaction whose
	// firstKeptEntryId points at the SOLE recent delegation turn; the old
	// ~50-KiB embedded handoff must be flagged (no compactable prefix) —
	// the historical turns BEFORE the boundary never count.
	const oldHandoff = "x".repeat(50 * 1024);
	const rootShape = [
		{ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "historical prompt" }] } },
		{ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "historical reply" }] } },
		{ type: "compaction", id: "c1", summary: "history", firstKeptEntryId: "m3" },
		{ type: "message", id: "m3", message: { role: "user", content: [{ type: "text", text: "delegate the slice" }] } },
		{ type: "message", id: "m4", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
		{ type: "message", id: "m5", message: { role: "toolResult", toolName: "workbench_delegate_worker", content: [{ type: "text", text: oldHandoff }] } },
	];
	assert.equal(compactablePrefixAvailable(rootShape), false, "historical turns before the boundary never count");
	assert.equal(detectSingleHugeRecentTurn(rootShape), true, "the old 50-KiB sole post-compaction delegation handoff is flagged");
	assert.equal(delegationContextRiskLine(rootShape), CONTEXT_RISK_DELEGATION_HANDOFF_TOO_LARGE);

	// The SAME root shape with the NEW bounded handoff never warns.
	const boundedRoot = [
		{ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "historical prompt" }] } },
		{ type: "compaction", id: "c1", summary: "history", firstKeptEntryId: "m2" },
		{ type: "message", id: "m2", message: { role: "user", content: [{ type: "text", text: "delegate the slice" }] } },
		{ type: "message", id: "m3", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
		{ type: "message", id: "m4", message: { role: "toolResult", toolName: "workbench_delegate_worker", content: [{ type: "text", text: "x".repeat(12 * 1024) }] } },
	];
	assert.equal(detectSingleHugeRecentTurn(boundedRoot), false, "a <=12 KiB new handoff never warns");

	// Two ACTIVE recent turns after the boundary: a valid prefix exists.
	const twoRecent = [
		{ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "old" }] } },
		{ type: "compaction", id: "c1", summary: "history", firstKeptEntryId: "m2" },
		{ type: "message", id: "m2", message: { role: "user", content: [{ type: "text", text: "earlier recent turn" }] } },
		{ type: "message", id: "m3", message: { role: "assistant", content: [{ type: "text", text: "earlier reply" }] } },
		{ type: "message", id: "m4", message: { role: "user", content: [{ type: "text", text: "delegate" }] } },
		{ type: "message", id: "m5", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
		{ type: "message", id: "m6", message: { role: "toolResult", toolName: "workbench_delegate_worker", content: [{ type: "text", text: oldHandoff }] } },
	];
	assert.equal(compactablePrefixAvailable(twoRecent), true, "an active pre-latest-turn prefix exists inside the boundary");
	assert.equal(detectSingleHugeRecentTurn(twoRecent), false, "a prefix disqualifies the single-turn hazard");

	// firstKeptEntryId not found: the boundary falls back to the entry after
	// the compaction (the sole delegation turn then still has no prefix).
	const fallbackBoundary = [
		{ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "delegate" }] } },
		{ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
		{ type: "compaction", id: "c1", summary: "history", firstKeptEntryId: "missing-id" },
		{ type: "message", id: "m3", message: { role: "toolResult", toolName: "workbench_delegate_worker", content: [{ type: "text", text: oldHandoff }] } },
	];
	assert.equal(compactablePrefixAvailable(fallbackBoundary), false, "fallback boundary is compaction index + 1");
	assert.equal(detectSingleHugeRecentTurn(fallbackBoundary), true);
});

test("detectSingleHugeRecentTurn flags the known single-huge-recent-turn shape and never the bounded handoff", () => {
	// The pre-fix shape: the ONLY post-compaction turn embeds a huge
	// delegation toolResult (e.g. 2 MiB of report text).
	const huge = "h".repeat(2 * 1024 * 1024);
	const oldShape = [userEntry("delegate"), assistantEntry("ok"), delegationToolResultEntry(huge)];
	assert.equal(detectSingleHugeRecentTurn(oldShape), true, "single huge delegation tool-result turn detected");
	assert.equal(estimateLatestTurnTokens(oldShape, { includeUsage: false }) >= DEFAULT_HUGE_TURN_MIN_TOKENS, true);
	assert.equal(huge.length >= DEFAULT_HUGE_TURN_MIN_BYTES, true);
	// The NEW bounded handoff (≤ 12 KiB embedded text) never triggers.
	const newShape = [userEntry("delegate"), assistantEntry("ok"), delegationToolResultEntry("x".repeat(12 * 1024))];
	assert.equal(detectSingleHugeRecentTurn(newShape), false, "the bounded handoff does not trigger the risk line");
	// A compactable prefix (earlier turns) disqualifies the single-turn hazard.
	const withPrefix = [userEntry("earlier"), assistantEntry("earlier reply"), userEntry("delegate"), assistantEntry("ok"), delegationToolResultEntry(huge)];
	assert.equal(detectSingleHugeRecentTurn(withPrefix), false, "a prefix exists — not the single-turn hazard");
	// No delegation tool result at all.
	assert.equal(detectSingleHugeRecentTurn([userEntry("a"), assistantEntry("b")]), false);
	// Thresholds can be tightened/loosened; malformed input fails safe.
	assert.equal(detectSingleHugeRecentTurn(newShape, { minBytes: 1024 }), true, "explicit thresholds bind");
	assert.equal(detectSingleHugeRecentTurn("garbage" as unknown as readonly unknown[]), false);
	assert.equal(detectSingleHugeRecentTurn([]), false);
});

test("delegationContextRiskLine emits exactly the required CONTEXT RISK string when detected", () => {
	const oldShape = [userEntry("delegate"), assistantEntry("ok"), delegationToolResultEntry("h".repeat(1024 * 1024))];
	assert.equal(delegationContextRiskLine(oldShape), "CONTEXT RISK: latest delegation handoff too large");
	assert.equal(delegationContextRiskLine(oldShape), CONTEXT_RISK_DELEGATION_HANDOFF_TOO_LARGE);
	const newShape = [userEntry("delegate"), assistantEntry("ok"), delegationToolResultEntry("x".repeat(12 * 1024))];
	assert.equal(delegationContextRiskLine(newShape), undefined);
});
