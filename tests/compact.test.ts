/** R8 numeric-only context-output compaction supplement tests. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	MAX_NOTE_CHARS,
	MAX_NOTE_LINES,
	buildCompactNote,
	emptyCompactState,
	mergeCompactState,
	shouldSupplement,
} from "../extensions/workbench-runtime/core/compact.ts";

test("compact note adds at most one numeric context-output line and remains bounded", () => {
	const state = mergeCompactState(emptyCompactState("DEV"), {
		outputTruncatedResults: Number.MAX_SAFE_INTEGER,
		outputHistoryCollapsedBundles: Number.MAX_SAFE_INTEGER,
	});
	assert.equal(shouldSupplement(state), true);
	const note = buildCompactNote(state);
	assert.equal(note.match(/^context output:/gm)?.length, 1);
	assert.match(
		note,
		/context output: 9007199254740991 results truncated, 9007199254740991 history bundles collapsed/,
	);
	assert.ok(note.split("\n").length <= MAX_NOTE_LINES);
	assert.ok(note.length <= MAX_NOTE_CHARS);
	assert.doesNotMatch(note, /(?:cursor|args|patch|stdout|stderr)=|RAW-SECRET/i);
});

test("compact numeric observations are sanitized and never become enforcement state", () => {
	const state = mergeCompactState(emptyCompactState("DEV"), {
		outputTruncatedResults: "42",
		outputHistoryCollapsedBundles: -1,
		secret: "must-not-survive",
	});
	assert.equal(state.outputTruncatedResults, undefined);
	assert.equal(state.outputHistoryCollapsedBundles, undefined);
	assert.equal(shouldSupplement(state), false);
	assert.doesNotMatch(buildCompactNote(state), /must-not-survive/);
});
