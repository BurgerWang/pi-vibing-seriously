/**
 * P5 tests for the compaction supplement module (core/compact.ts).
 *
 * The workbench never reimplements Pi compaction — it only supplements with
 * bounded ASCII facts (task, mode, gates, runs, evidence paths, next step,
 * do-not-retry) and persists them as custom entries for /new /resume /fork
 * /clone /reload recovery. No run logs ever enter the session context.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildCompactNote,
	collectDoNotRetry,
	COMPACT_NOTE_MESSAGE_TYPE,
	COMPACT_STATE_ENTRY_TYPE,
	emptyCompactState,
	loadCompactStateFromEntries,
	MAX_NOTE_CHARS,
	MAX_NOTE_LINES,
	mergeCompactState,
	pushBounded,
	shouldSupplement,
} from "../extensions/workbench-runtime/core/compact.ts";

function state(overrides: Record<string, unknown> = {}): ReturnType<typeof emptyCompactState> {
	return mergeCompactState(emptyCompactState("DEV"), overrides);
}

// ---------------------------------------------------------------------------
// state shape and sanitization
// ---------------------------------------------------------------------------

test("empty state has no supplement-worthy content", () => {
	const s = emptyCompactState("DEV");
	assert.equal(shouldSupplement(s), false);
	assert.ok(s.passedGates.length === 0 && s.modifiedFiles.length === 0);
});

test("mergeCompactState sanitizes unknown payloads", () => {
	const base = emptyCompactState("VERIFY");
	const merged = mergeCompactState(base, {
		mode: 42, // invalid → keep base
		task: "   fix q3   ",
		passedGates: ["b0", 7, "", "b1", "b2", "b3", "b4", "b5", "q0", "q1", "q2", "q3", "q4", "q5"],
		modifiedFiles: "not-a-list",
		lastRunId: "x".repeat(500),
		doNotRetry: ["a", "b"],
	});
	assert.equal(merged.mode, "VERIFY");
	assert.equal(merged.task, "fix q3");
	assert.ok(merged.passedGates.length <= 12, "gates capped");
	assert.ok(merged.passedGates.every((g) => typeof g === "string"));
	assert.deepEqual(merged.modifiedFiles, []);
	assert.ok((merged.lastRunId ?? "").length <= 64, "strings capped");
	assert.deepEqual(merged.doNotRetry, ["a", "b"]);
});

test("loadCompactStateFromEntries restores the latest persisted entry", () => {
	const entries = [
		{ type: "custom", customType: COMPACT_STATE_ENTRY_TYPE, data: { mode: "AUDIT", task: "old task", failedGates: ["q1"] } },
		{ type: "message" },
		{ type: "custom", customType: "other-ext", data: { task: "nope" } },
		{ type: "custom", customType: COMPACT_STATE_ENTRY_TYPE, data: { mode: "VERIFY", task: "current task", failedGates: ["q3 (run 20260801-120000-abcd)"] } },
	];
	const s = loadCompactStateFromEntries(entries, "VERIFY");
	assert.equal(s.task, "current task");
	assert.deepEqual(s.failedGates, ["q3 (run 20260801-120000-abcd)"]);
	assert.equal(s.mode, "VERIFY");
});

test("loadCompactStateFromEntries ignores non-matching entries and falls back to mode", () => {
	const s = loadCompactStateFromEntries([{ type: "custom", customType: "other", data: { task: "x" } }], "AUDIT");
	assert.equal(s.task, undefined);
	assert.equal(s.mode, "AUDIT");
	// mode is authoritative: a stale state entry cannot override the restored mode
	const stale = loadCompactStateFromEntries(
		[{ type: "custom", customType: COMPACT_STATE_ENTRY_TYPE, data: { mode: "AUDIT", task: "x" } }],
		"VERIFY",
	);
	assert.equal(stale.mode, "VERIFY");
	assert.equal(stale.task, "x");
});

test("pushBounded dedupes and caps, dropping oldest first", () => {
	const list = pushBounded([], "a", 3);
	assert.deepEqual(list, ["a"]);
	const list2 = pushBounded(list, "b", 3);
	const list3 = pushBounded(list2, "a", 3);
	assert.deepEqual(list3, ["a", "b"], "dedup");
	const list4 = pushBounded(list3, "c", 3);
	const list5 = pushBounded(list4, "d", 3);
	assert.deepEqual(list5, ["b", "c", "d"], "oldest dropped");
});

// ---------------------------------------------------------------------------
// do-not-retry tracking
// ---------------------------------------------------------------------------

test("collectDoNotRetry flags repeated identical failures only", () => {
	assert.deepEqual(collectDoNotRetry(["recipe:backtest:ok"]), []);
	assert.deepEqual(collectDoNotRetry(["recipe:backtest:exit:1"]), []);
	assert.deepEqual(collectDoNotRetry(["recipe:backtest:exit:1", "recipe:backtest:ok"]), []);
	const notes = collectDoNotRetry(["recipe:backtest:exit:1", "recipe:backtest:exit:1"]);
	assert.equal(notes.length, 1);
	assert.ok(notes[0]?.includes("backtest") && notes[0]?.includes("do not blindly re-run"));
	const gateNotes = collectDoNotRetry(["gate:FAIL", "gate:FAIL"]);
	assert.equal(gateNotes.length, 1);
	assert.ok(gateNotes[0]?.includes("gate"));
	assert.deepEqual(collectDoNotRetry(["gate:PASS", "gate:PASS"]), [], "repeated PASS is not a failure");
});

// ---------------------------------------------------------------------------
// supplement note
// ---------------------------------------------------------------------------

test("shouldSupplement requires real content", () => {
	assert.equal(shouldSupplement(emptyCompactState("DEV")), false);
	assert.equal(shouldSupplement(state({ task: "t" })), true);
	assert.equal(shouldSupplement(state({ phase: "running workbench_run_gate" })), true);
	assert.equal(shouldSupplement(state({ lastRunId: "20260101-120000-abcd" })), true);
	assert.equal(shouldSupplement(state({ failedGates: ["q3"] })), true);
	assert.equal(shouldSupplement(state({ modifiedFiles: ["src/a.ts"] })), true);
	assert.equal(shouldSupplement(state({ doNotRetry: ["x"] })), true);
	assert.equal(shouldSupplement(state({ passedGates: ["b0"] })), false, "passes alone are not worth carrying");
});

test("buildCompactNote is bounded, ASCII, and contains pointers only", () => {
	const s = state({
		task: "Implement P5 hardening",
		phase: "finished workbench_run_gate",
		lastRunId: "20260801-120000-abcd",
		lastRecipe: "gate",
		passedGates: ["b0", "b1"],
		failedGates: ["q3 (run 20260801-120000-abcd)"],
		blockedGates: ["q4 (run 20260801-120000-abcd)"],
		modifiedFiles: ["extensions/workbench-runtime/index.ts"],
		evidencePaths: [".pi/workbench/runs/20260801-120000-abcd"],
		nextStep: "fix q3.2 then re-run gate q3",
		doNotRetry: ["recipe \"x\" failed twice — investigate first"],
		updatedAt: "2026-08-01T12:00:00.000Z",
	});
	const note = buildCompactNote(s);
	assert.ok(note.length > 0);
	assert.ok(note.split("\n").length <= MAX_NOTE_LINES, "line cap");
	assert.ok(note.length <= MAX_NOTE_CHARS, "char cap");
	assert.ok(note.includes("mode: DEV"));
	assert.ok(note.includes("Implement P5 hardening"));
	assert.ok(note.includes("20260801-120000-abcd"));
	assert.ok(note.includes("q3 (run 20260801-120000-abcd)"));
	assert.ok(note.includes(".pi/workbench/runs/20260801-120000-abcd"));
	assert.ok(note.includes("do not retry"));
	assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}]/u.test(note), "no emoji/symbols");
});

test("buildCompactNote redacts credential shapes", () => {
	const s = state({ task: "use sk-ABC123DEF456GHIJ7890 in the script" });
	const note = buildCompactNote(s);
	assert.ok(!note.includes("sk-ABC123DEF456GHIJ7890"));
	assert.ok(note.includes("[REDACTED]"));
});

test("buildCompactNote truncates pathological content", () => {
	const s = state({ task: "x".repeat(5000) });
	const note = buildCompactNote(s);
	assert.ok(note.length <= MAX_NOTE_CHARS + 20);
});

test("entry and message types are stable identifiers", () => {
	assert.equal(COMPACT_STATE_ENTRY_TYPE, "workbench-state");
	assert.equal(COMPACT_NOTE_MESSAGE_TYPE, "workbench-compact-note");
});
