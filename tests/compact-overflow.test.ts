import assert from "node:assert/strict";
import { test } from "node:test";

import {
	classifyCompactOverflow,
	decideCompactOverflowRecovery,
} from "../extensions/workbench-runtime/core/compact-overflow.ts";

test("overflow classification accepts explicit context-window provider signals", () => {
	assert.deepEqual(classifyCompactOverflow({ code: "context_length_exceeded" }), {
		kind: "context-window-overflow",
		source: "code",
	});
	assert.deepEqual(classifyCompactOverflow({ error: { code: "prompt_too_long" } }), {
		kind: "context-window-overflow",
		source: "code",
	});
	assert.deepEqual(classifyCompactOverflow(new Error("maximum context length is 128,000 tokens")), {
		kind: "context-window-overflow",
		source: "message",
	});
});

test("overflow classification excludes generic size, transport and quota failures", () => {
	for (const value of [
		{ status: 413, message: "request too large" },
		{ code: "rate_limit_exceeded", message: "too many tokens per minute" },
		new Error("output was too long"),
		new Error("overflow"),
		new Error("request timed out"),
	]) assert.equal(classifyCompactOverflow(value), undefined);
});

test("overflow recovery is permitted once and only for a classified overflow", () => {
	const error = { code: "context_window_exceeded" };
	assert.deepEqual(decideCompactOverflowRecovery(error, false), {
		classification: { kind: "context-window-overflow", source: "code" },
		recover: true,
		recoveryAttempted: true,
		reason: "recover-once",
	});
	assert.deepEqual(decideCompactOverflowRecovery(error, true), {
		classification: { kind: "context-window-overflow", source: "code" },
		recover: false,
		recoveryAttempted: true,
		reason: "recovery-already-attempted",
	});
	assert.deepEqual(decideCompactOverflowRecovery(new Error("timeout"), false), {
		recover: false,
		recoveryAttempted: false,
		reason: "not-context-overflow",
	});
});
