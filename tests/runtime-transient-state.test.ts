/** Unit tests for runtime-local transient controller state. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	createRuntimeTransientState,
	MAX_PENDING_TRUSTED_INGRESS_SLOTS,
} from "../extensions/workbench-runtime/core/runtime-transient-state.ts";
import {
	TOOL_RESULT_INGRESS_BUDGET_BYTES,
	TRUSTED_RECOVERY_AUTHORITY_SCHEMA,
	type TrustedRecoveryAuthority,
} from "../extensions/workbench-runtime/core/tool-result-ingress-projection.ts";
import type { TurnOutputAuthorization } from "../extensions/workbench-runtime/core/turn-output-budget.ts";

function authorization(id: string, call = "call-1", tool = "read"): TurnOutputAuthorization {
	return {
		authorizationId: id,
		toolCallId: call,
		toolName: tool,
		policyId: "native-read-page",
		planned: true,
		allowed: true,
		allocatedBytes: 100,
		controlAllocatedBytes: 0,
	};
}

function authority(call = "call-1", tool = "read"): TrustedRecoveryAuthority {
	return {
		schema: TRUSTED_RECOVERY_AUTHORITY_SCHEMA,
		sourceKind: "finalized_run_page",
		toolCallId: call,
		toolName: tool,
		sourcePath: ".pi/workbench/runs/run-1/manifest.json",
		sourceIdentity: { kind: "digest", sha256: "a".repeat(64) },
		finalized: 1,
		budgetBytes: TOOL_RESULT_INGRESS_BUDGET_BYTES,
		requiredFacts: [],
	};
}

test("output authorization is exact FIFO and peek never consumes", () => {
	const state = createRuntimeTransientState();
	const first = authorization("auth-1");
	const second = authorization("auth-2");
	state.rememberOutputAuthorization(first);
	state.rememberOutputAuthorization(second);

	assert.equal(state.peekOutputAuthorization("call-1", "read"), first);
	assert.equal(state.peekOutputAuthorization("call-1", "read"), first);
	assert.equal(state.takeOutputAuthorization("call-1", "read"), first);
	assert.equal(state.takeOutputAuthorization("call-1", "read"), second);
	assert.equal(state.takeOutputAuthorization("call-1", "read"), undefined);
	assert.equal(state.takeOutputAuthorization("call-1", "write"), undefined);
});

test("trusted continuations are bounded and routed only to their exact tool", () => {
	const state = createRuntimeTransientState();
	state.rememberTrustedReadContinuation("read-1", "cursor-r");
	state.rememberTrustedRunLogContinuation("run-1", "cursor-run");
	state.rememberTrustedGateContinuation("gate-1", "cursor-gate");
	state.rememberTrustedReadContinuation("empty", "");
	state.rememberTrustedReadContinuation("large", "x".repeat(1_025));

	assert.equal(state.takeTrustedReadContinuation("read-1", "write"), undefined);
	assert.deepEqual(state.takeTrustedReadContinuation("read-1", "read"), { kind: "read", value: "cursor-r" });
	assert.deepEqual(state.takeTrustedRunLogContinuation("run-1", "workbench_read_run"), { kind: "run-log", value: "cursor-run" });
	assert.deepEqual(state.takeTrustedGateContinuation("gate-1", "workbench_read_gate"), { kind: "gate-read", value: "cursor-gate" });
	assert.equal(state.takeTrustedReadContinuation("empty", "read"), undefined);
	assert.equal(state.takeTrustedReadContinuation("large", "read"), undefined);
});

test("trusted ingress keeps empty FIFO slots and saturation fails closed until reset", () => {
	const state = createRuntimeTransientState();
	const bound = state.bindTrustedIngressAuthority(authority(), [{ type: "text", text: "bounded result" }]);
	assert.ok(bound);
	state.rememberTrustedIngressAuthority("call-1", "read", undefined);
	state.rememberTrustedIngressAuthority("call-1", "read", bound);
	assert.equal(state.takeTrustedIngressAuthority("call-1", "read"), undefined);
	assert.equal(state.takeTrustedIngressAuthority("call-1", "read"), bound);

	for (let index = 0; index <= MAX_PENDING_TRUSTED_INGRESS_SLOTS; index += 1) {
		state.rememberTrustedIngressAuthority(`saturated-${index}`, "read", bound);
	}
	assert.equal(state.takeTrustedIngressAuthority("saturated-0", "read"), undefined);
	state.rememberTrustedIngressAuthority("still-saturated", "read", bound);
	assert.equal(state.takeTrustedIngressAuthority("still-saturated", "read"), undefined);

	state.resetTrustedIngressAuthorities();
	state.rememberTrustedIngressAuthority("after-reset", "read", bound);
	assert.equal(state.takeTrustedIngressAuthority("after-reset", "read"), bound);
});

test("processed-result replay counts are exact and resetTurn clears every registry", () => {
	const state = createRuntimeTransientState();
	state.rememberProcessedNormalResult("call-1", "read");
	state.rememberProcessedNormalResult("call-1", "read");
	assert.equal(state.takeProcessedNormalResult("call-1", "read"), true);
	assert.equal(state.takeProcessedNormalResult("call-1", "read"), true);
	assert.equal(state.takeProcessedNormalResult("call-1", "read"), false);

	state.rememberOutputAuthorization(authorization("auth-reset"));
	state.rememberTrustedReadContinuation("call-1", "cursor-reset");
	state.rememberProcessedNormalResult("call-1", "read");
	state.resetTurn();
	assert.equal(state.takeOutputAuthorization("call-1", "read"), undefined);
	assert.equal(state.takeTrustedReadContinuation("call-1", "read"), undefined);
	assert.equal(state.takeProcessedNormalResult("call-1", "read"), false);
});

test("separate runtime instances cannot communicate through transient state", () => {
	const first = createRuntimeTransientState();
	const second = createRuntimeTransientState();
	first.rememberOutputAuthorization(authorization("auth-only-first"));
	first.rememberProcessedNormalResult("call-1", "read");

	assert.equal(second.takeOutputAuthorization("call-1", "read"), undefined);
	assert.equal(second.takeProcessedNormalResult("call-1", "read"), false);
	assert.equal(first.takeOutputAuthorization("call-1", "read")?.authorizationId, "auth-only-first");
	assert.equal(first.takeProcessedNormalResult("call-1", "read"), true);
});
