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

test("mergeCompactState sanitizes the P7 worker-first fields (typed, bounded, fail-safe)", () => {
	const base = emptyCompactState("DEV");
	const merged = mergeCompactState(base, {
		writePolicy: "worker-first-strict",
		commanderWritesDenied: true,
		lastDelegationId: "20260801-120000-abcd",
		pendingDelegationReview: true,
		reviewedDiffHash: "a".repeat(200),
		activeWriteLease: "WRITE-LEASE active wl-1 user-directed 0/10 edit,write src/**",
		blockedCommanderWriteAttempts: 42,
		nextDelegationAction: "review delegation 20260801-120000-abcd (PENDING_REVIEW)",
	});
	assert.equal(merged.writePolicy, "worker-first-strict");
	assert.equal(merged.commanderWritesDenied, true);
	assert.equal(merged.lastDelegationId, "20260801-120000-abcd");
	assert.equal(merged.pendingDelegationReview, true);
	assert.equal(merged.reviewedDiffHash?.length, 128, "hash bounded to 128 chars");
	assert.ok((merged.activeWriteLease?.length ?? 0) <= 240);
	assert.equal(merged.blockedCommanderWriteAttempts, 42);
	assert.ok(merged.nextDelegationAction?.includes("PENDING_REVIEW"));

	// Hostile/corrupt values fail closed to the base (never fabricated).
	const hostile = mergeCompactState(base, {
		writePolicy: "lenient-policy",
		commanderWritesDenied: "yes",
		lastDelegationId: 42,
		pendingDelegationReview: 1,
		reviewedDiffHash: "",
		activeWriteLease: ["x"],
		blockedCommanderWriteAttempts: -5,
		nextDelegationAction: "   ",
	});
	assert.equal(hostile.writePolicy, undefined, "unknown policy strings are dropped");
	assert.equal(hostile.commanderWritesDenied, undefined);
	assert.equal(hostile.lastDelegationId, undefined);
	assert.equal(hostile.pendingDelegationReview, undefined);
	assert.equal(hostile.reviewedDiffHash, undefined);
	assert.equal(hostile.activeWriteLease, undefined);
	assert.equal(hostile.blockedCommanderWriteAttempts, undefined, "negative counters are dropped");
	assert.equal(hostile.nextDelegationAction, undefined);

	// Over-large counters clamp to the bounded ceiling.
	const clamped = mergeCompactState(base, { blockedCommanderWriteAttempts: 1_000_000 });
	assert.equal(clamped.blockedCommanderWriteAttempts, 999);
});

test("loadCompactStateFromEntries restores the P7 worker-first fields", () => {
	const entries = [
		{ type: "custom", customType: COMPACT_STATE_ENTRY_TYPE, data: { mode: "DEV", lastDelegationId: "20260801-120000-abcd", pendingDelegationReview: true, blockedCommanderWriteAttempts: 7 } },
		{ type: "custom", customType: COMPACT_STATE_ENTRY_TYPE, data: { mode: "DEV", lastDelegationId: "20260802-120000-abcd", reviewedDiffHash: "c".repeat(64), blockedCommanderWriteAttempts: 9 } },
	];
	const s = loadCompactStateFromEntries(entries, "DEV");
	assert.equal(s.lastDelegationId, "20260802-120000-abcd", "later entries win");
	assert.equal(s.reviewedDiffHash, "c".repeat(64));
	assert.equal(s.blockedCommanderWriteAttempts, 9);
	assert.equal(s.mode, "DEV");
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
	// P7 worker-first facts trigger the supplement on their own.
	assert.equal(shouldSupplement(state({ writePolicy: "worker-first-strict" })), true);
	assert.equal(shouldSupplement(state({ commanderWritesDenied: true })), true);
	assert.equal(shouldSupplement(state({ lastDelegationId: "20260801-120000-abcd" })), true);
	assert.equal(shouldSupplement(state({ pendingDelegationReview: true })), true);
	assert.equal(shouldSupplement(state({ blockedCommanderWriteAttempts: 3 })), true);
	assert.equal(shouldSupplement(state({ nextDelegationAction: "review the diff" })), true);
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

test("buildCompactNote names fixed Sol/Luna delivery, the temporary lease boundary, and delegation state", () => {
	const s = state({
		writePolicy: "worker-first-strict",
		commanderWritesDenied: true,
		lastDelegationId: "20260801-120000-abcd",
		pendingDelegationReview: true,
		reviewedDiffHash: undefined,
		blockedCommanderWriteAttempts: 4,
		nextDelegationAction: "review delegation 20260801-120000-abcd (PENDING_REVIEW) before the next delegation or VERIFY",
	});
	const note = buildCompactNote(s);
	assert.ok(note.includes("development writes: Sol plans, Luna implements"), note);
	assert.ok(note.includes("commander writes: locked (temporary lease required)"), note);
	assert.ok(note.includes("delegation: 20260801-120000-abcd PENDING_REVIEW"), note);
	assert.ok(note.includes("blocked commander writes: 4"), note);
	assert.ok(note.includes("next delegation action: review delegation 20260801-120000-abcd"), note);
	assert.ok(note.split("\n").length <= MAX_NOTE_LINES);
	assert.ok(note.length <= MAX_NOTE_CHARS);

	// Reviewed state carries the bounded reviewed hash.
	const reviewed = buildCompactNote(
		state({
			writePolicy: "worker-first-strict",
			commanderWritesDenied: true,
			lastDelegationId: "20260801-120000-abcd",
			reviewedDiffHash: "f".repeat(64),
			nextDelegationAction: "delegation 20260801-120000-abcd REVIEWED — start the next delegation or run final verification",
		}),
	);
	assert.ok(reviewed.includes("delegation: 20260801-120000-abcd REVIEWED"), reviewed);
	assert.ok(reviewed.includes(`(hash ${"f".repeat(12)})`), reviewed);

	// An active lease summary line carries the bounded summary, never tokens.
	const leased = buildCompactNote(
		state({
			writePolicy: "worker-first-strict",
			commanderWritesDenied: false,
			activeWriteLease: "WRITE-LEASE active wl-1 user-directed 0/10 edit,write src/**",
			nextDelegationAction: "start the next worker delegation",
		}),
	);
	assert.ok(leased.includes("write lease: WRITE-LEASE active wl-1"), leased);
	assert.ok(!leased.includes("confirmation part"), "lease tokens never appear in the note");
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
