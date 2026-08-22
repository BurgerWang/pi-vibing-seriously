import assert from "node:assert/strict";
import test from "node:test";

import {
	DELEGATION_CLAIM_GUARD_CODE,
	inspectDelegationClaims,
	registerDelegationClaimGuard,
	validateDelegationClaims,
} from "../extensions/workbench-runtime/core/delegation-claim-guard-controller.ts";

const REAL_ID = "20260822-105301-zn8s";
const FAKE_IDS = [
	"20260822-124052-xSAX",
	"20260822-125504-Nd0d",
	"20260822-125844-gG6g",
] as const;

function assistant(text: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		stopReason: "stop",
		timestamp: 1,
	};
}

function evidence(attemptedCalls = 0, successfulResults = 0, resultIds: readonly string[] = []) {
	return { attemptedCalls, successfulResults, resultIds };
}

function finalText(message: Record<string, unknown>): string {
	const content = message.content as Array<{ type: string; text?: string }>;
	return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

test("the reproduced three fabricated SUCCESS/REVIEWED delegations fail closed", () => {
	const inspection = inspectDelegationClaims(assistant([
		"已按要求改用三个全新的 delegation 尝试：",
		`${FAKE_IDS[0]} 新文件`,
		`${FAKE_IDS[1]} 单个 source`,
		`${FAKE_IDS[2]} 两个已有文件`,
		"三次都返回 worker SUCCESS/REVIEWED 报告。",
	].join("\n")));
	assert.ok(inspection);
	assert.deepEqual(inspection.ids, [...FAKE_IDS]);
	assert.equal(inspection.executionClaim, true);
	assert.equal(inspection.successClaim, true);
	assert.equal(inspection.recentClaim, true);
	assert.deepEqual(validateDelegationClaims(inspection, evidence(), []), { ok: false, code: "missing_authority" });
});

test("the earlier fabricated delegation_id report is also an execution claim", () => {
	const inspection = inspectDelegationClaims(assistant([
		"继续推进时发现新的 delegation 没有形成实际 transaction。",
		"本次新尝试返回：",
		"delegation_id: 20260822-120748-AqxU",
	].join("\n")));
	assert.ok(inspection);
	assert.equal(inspection.negativeOnly, false, "a nearby negative observation cannot erase the positive delegation_id claim");
	assert.deepEqual(validateDelegationClaims(inspection, evidence(), []), { ok: false, code: "missing_authority" });
});

test("negative audit mentions remain readable while status mismatches fail", () => {
	const negative = inspectDelegationClaims(assistant(`delegation ${FAKE_IDS[0]} does not exist and was not executed.`));
	assert.ok(negative);
	assert.equal(negative.negativeOnly, true);
	assert.deepEqual(validateDelegationClaims(negative, evidence(), []), { ok: true });

	const mismatch = inspectDelegationClaims(assistant(`delegation ${REAL_ID} — REVIEWED`));
	assert.ok(mismatch);
	assert.deepEqual(
		validateDelegationClaims(mismatch, evidence(), [{ id: REAL_ID, status: "FAILED" }]),
		{ ok: false, code: "status_mismatch" },
	);
	assert.deepEqual(
		validateDelegationClaims(mismatch, evidence(), [{ id: REAL_ID, status: "REVIEWED" }]),
		{ ok: true },
	);
});

test("generic new execution and success claims require same-turn tool evidence", () => {
	const recent = inspectDelegationClaims(assistant("已按要求启动新的 delegation worker。"));
	assert.ok(recent);
	assert.deepEqual(validateDelegationClaims(recent, evidence(), []), { ok: false, code: "missing_call" });
	assert.deepEqual(validateDelegationClaims(recent, evidence(1), []), { ok: true });

	const success = inspectDelegationClaims(assistant("delegation worker SUCCESS; implementation completed."));
	assert.ok(success);
	assert.deepEqual(validateDelegationClaims(success, evidence(1), []), { ok: false, code: "missing_success_result" });
	assert.deepEqual(validateDelegationClaims(success, evidence(1, 1, [REAL_ID]), []), { ok: false, code: "missing_authority" });
	assert.deepEqual(
		validateDelegationClaims(success, evidence(1, 1, [REAL_ID]), [{ id: REAL_ID, status: "REVIEWED" }]),
		{ ok: true },
	);
});

interface Stub {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
}

function stub(): Stub {
	return { handlers: new Map() };
}

function register(
	state: Stub,
	readStatus: (id: string) => string | undefined,
	committedAuthority = true,
	sessionStatus?: "PENDING_REVIEW" | "REVIEWED" | "STALE",
): void {
	registerDelegationClaimGuard({
		pi: {
			on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
				const handlers = state.handlers.get(name) ?? [];
				handlers.push(handler);
				state.handlers.set(name, handlers);
			},
		} as never,
		isCommander: () => true,
		projectRootFor: async () => "/project",
		getDelegationState: () => ({
			...(sessionStatus === undefined ? {} : { latestId: REAL_ID }),
			status: sessionStatus ?? "PENDING_REVIEW",
		}),
		readTransaction: (async (_root: string, id: string) => {
			const status = readStatus(id);
			return status === undefined
				? { ok: false, error: { code: "not_found", message: "missing" } }
				: { ok: true, value: { delegation_id: id, status } };
		}) as never,
		readCommittedGeneration: (async (_root: string, id: string) => {
			const status = readStatus(id);
			return status === undefined || !committedAuthority
				? { ok: false, error: { code: "not_found", message: "missing" } }
				: { ok: true, value: { state: { delegation_id: id, status } } };
		}) as never,
		readLegacyLedger: (async () => null) as never,
	});
}

async function emit(state: Stub, name: string, event: unknown): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of state.handlers.get(name) ?? []) results.push(await handler(event, {}));
	return results;
}

test("controller replaces fabricated final prose and never repeats its ids", async () => {
	const state = stub();
	register(state, () => undefined);
	await emit(state, "agent_start", { type: "agent_start" });
	const message = assistant(`已按要求启动 delegation ${FAKE_IDS[0]} — SUCCESS/REVIEWED`);
	const results = await emit(state, "message_end", { type: "message_end", message });
	const replacement = (results.find((value) => value !== undefined) as { message: Record<string, unknown> }).message;
	const text = finalText(replacement);
	assert.ok(text.includes(DELEGATION_CLAIM_GUARD_CODE));
	assert.equal(text.includes(FAKE_IDS[0]), false, "the guard never reinforces a fabricated id");
	assert.equal(finalText(message).includes(DELEGATION_CLAIM_GUARD_CODE), false, "caller message is immutable");
});

test("controller permits a strict matching transaction and a real same-turn result", async () => {
	const state = stub();
	register(state, (id) => id === REAL_ID ? "REVIEWED" : undefined);
	await emit(state, "agent_start", { type: "agent_start" });
	assert.deepEqual(await emit(state, "message_end", { type: "message_end", message: assistant(`delegation ${REAL_ID} — REVIEWED`) }), [undefined]);

	await emit(state, "message_end", {
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will start the delegation now." },
				{ type: "toolCall", id: "call-real", name: "workbench_delegate_worker", arguments: {} },
			],
		},
	});
	await emit(state, "tool_execution_end", {
		type: "tool_execution_end",
		toolCallId: "call-real",
		toolName: "workbench_delegate_worker",
		isError: false,
		result: { details: { delegation_id: REAL_ID, status: "success" } },
	});
	await emit(state, "turn_start", { type: "turn_start", turnIndex: 1 });
	assert.deepEqual(
		await emit(state, "message_end", { type: "message_end", message: assistant("delegation worker SUCCESS; completed.") }),
		[undefined],
	);
});

test("status output with a STALE session mirror and REVIEWED transaction is not an execution claim", async () => {
	const message = assistant([
		`latest       : ${REAL_ID} STALE`,
		"current hash : 23ccf6528ecf62a458e74103bbcb8594c638402a61239b9312ebb2ee884b10c2",
		"reviewed hash: 789907762ba18c1c8411c4650cd3fe2f681593453329a7daa4eb348751534203",
		`blocked      : Starting a new worker delegation is blocked while delegation ${REAL_ID} is STALE; review the current diff first`,
		"authority v2 : transaction REVIEWED",
		"review v2    : PASS at 2026-08-22T03:57:19.888Z (FINAL)",
	].join("\n"));
	const inspection = inspectDelegationClaims(message);
	assert.ok(inspection);
	assert.equal(inspection.executionClaim, false, "a blocked next action is not a claimed execution");
	assert.deepEqual(
		validateDelegationClaims(inspection, evidence(), [{ id: REAL_ID, status: "REVIEWED", sessionStatus: "STALE" }]),
		{ ok: true },
	);
	assert.deepEqual(
		validateDelegationClaims(inspection, evidence(), [{ id: REAL_ID, status: "REVIEWED", sessionStatus: "REVIEWED" }]),
		{ ok: false, code: "status_mismatch" },
		"STALE remains machine-validated against the session mirror",
	);

	const state = stub();
	register(state, (id) => id === REAL_ID ? "REVIEWED" : undefined, true, "STALE");
	await emit(state, "agent_start", { type: "agent_start" });
	assert.deepEqual(await emit(state, "message_end", { type: "message_end", message }), [undefined]);
});

test("terminal transaction prose is rejected when its committed generation is unavailable", async () => {
	const state = stub();
	register(state, (id) => id === REAL_ID ? "REVIEWED" : undefined, false);
	await emit(state, "agent_start", { type: "agent_start" });
	const results = await emit(state, "message_end", {
		type: "message_end",
		message: assistant(`delegation ${REAL_ID} — REVIEWED`),
	});
	const replacement = (results.find((value) => value !== undefined) as { message: Record<string, unknown> }).message;
	assert.ok(finalText(replacement).includes(DELEGATION_CLAIM_GUARD_CODE));
});
