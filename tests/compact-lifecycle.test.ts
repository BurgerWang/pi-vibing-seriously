import assert from "node:assert/strict";
import { test } from "node:test";

import {
	COMPACT_ATTEMPT_ENTRY_TYPE,
	COMPACT_ATTEMPT_SCHEMA,
	finishCompactAttempt,
	isCompactAttemptTerminal,
	parseCompactAttemptState,
	serializeCompactAttemptState,
	startCompactAttempt,
} from "../extensions/workbench-runtime/core/compact-lifecycle.ts";

const STARTED_AT = "2026-08-23T01:02:03.000Z";
const FINISHED_AT = "2026-08-23T01:02:04.000Z";

test("compact attempts serialize a strict started to terminal lifecycle", () => {
	assert.equal(COMPACT_ATTEMPT_ENTRY_TYPE, "workbench-compact-attempt");
	const started = startCompactAttempt({
		attemptId: "compact-1",
		startedAt: STARTED_AT,
		reason: "overflow",
		owner: "workbench-overflow-recovery",
		willRetry: true,
	});
	assert.deepEqual(started, {
		schema: COMPACT_ATTEMPT_SCHEMA,
		attemptId: "compact-1",
		status: "started",
		startedAt: STARTED_AT,
		finishedAt: null,
		reason: "overflow",
		owner: "workbench-overflow-recovery",
		willRetry: true,
		resultCode: null,
	});
	assert.equal(isCompactAttemptTerminal(started), false);
	const completed = finishCompactAttempt(started, "completed", FINISHED_AT);
	assert.ok(completed);
	assert.equal(completed.status, "completed");
	assert.equal(completed.finishedAt, FINISHED_AT);
	assert.equal(completed.resultCode, "compact_completed");
	assert.equal(isCompactAttemptTerminal(completed), true);
	assert.deepEqual(parseCompactAttemptState(JSON.parse(JSON.stringify(completed))), completed);
	assert.deepEqual(serializeCompactAttemptState(completed), completed);
	assert.equal(Object.isFrozen(completed), true);
});

test("compact attempts reject partial records and repeated or backwards transitions", () => {
	const started = startCompactAttempt({
		attemptId: "compact-2",
		startedAt: STARTED_AT,
		reason: "threshold",
		owner: "pi-native",
		willRetry: false,
	});
	const failed = finishCompactAttempt(started, "failed", FINISHED_AT);
	assert.ok(failed);
	assert.equal(finishCompactAttempt(failed, "completed", "2026-08-23T01:02:05.000Z"), undefined);
	assert.equal(finishCompactAttempt(started, "completed", "2026-08-23T01:02:02.000Z"), undefined);
	assert.equal(parseCompactAttemptState({ ...started, unexpected: true }), undefined);
	assert.equal(parseCompactAttemptState({ ...started, finishedAt: FINISHED_AT }), undefined);
	assert.throws(() => startCompactAttempt({ ...started, attemptId: "bad id with spaces" }), /invalid compact attempt start/);
	assert.throws(() => serializeCompactAttemptState({ ...started, status: "success" }), /invalid compact attempt state/);
});
