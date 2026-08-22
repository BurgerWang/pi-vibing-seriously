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

function evidence(
	attemptedCalls = 0,
	successfulResults = 0,
	resultIds: readonly string[] = [],
	startedIds: readonly string[] = resultIds,
) {
	return { attemptedCalls, successfulResults, resultIds, startedIds };
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
	assert.deepEqual(
		validateDelegationClaims(inspection, evidence(3, 3, [...FAKE_IDS]), [
			{ id: FAKE_IDS[0], status: "REVIEWED" },
			{ id: FAKE_IDS[1], status: "FAILED" },
			{ id: FAKE_IDS[2], status: "REVIEWED" },
		]),
		{ ok: false, code: "status_mismatch" },
		"a distributive success claim applies to every listed delegation",
	);
});

test("the reproduced inline-code fake worker and run report cannot borrow an older reviewed authority", () => {
	const inspection = inspectDelegationClaims(assistant([
		"新 worker 已成功完成修复：",
		"",
		"- Delegation：`20260822-230337-hdwr`",
		"- 修改：G1 使用 step-scoped bytecode cache prefix，并新增碰撞回归测试",
		"- Focused tests：`20260822-230649-uvdr`，28 passed",
		"- Commit tests：`20260822-230659-idf7`，12 passed",
		"- 完整 G1：`20260822-230712-lu3z`",
		"  - 26 个本地步骤全部 PASS",
	].join("\n")));
	assert.ok(inspection);
	assert.deepEqual(inspection.ids, ["20260822-230337-hdwr"], "run ids are not misclassified as delegations");
	assert.deepEqual(inspection.runIds, [
		"20260822-230649-uvdr",
		"20260822-230659-idf7",
		"20260822-230712-lu3z",
	]);
	assert.equal(inspection.recentClaim, true, "a newly completed worker is a same-run claim");
	assert.equal(inspection.successClaim, true);
	assert.deepEqual(
		validateDelegationClaims(inspection, evidence(), [{ id: REAL_ID, status: "REVIEWED" }]),
		{ ok: false, code: "missing_authority" },
		"an unrelated historical REVIEWED transaction cannot authorize the fabricated id",
	);
});

test("run-only completion claims require a committed run with the claimed outcome", () => {
	const runId = "20260822-230649-uvdr";
	const inspection = inspectDelegationClaims(assistant(`Focused tests: \`${runId}\`, 28 passed`));
	assert.ok(inspection);
	assert.deepEqual(inspection.ids, []);
	assert.deepEqual(inspection.runIds, [runId]);
	assert.equal(inspection.expectedRunOutcomes[runId], "SUCCESS");
	assert.deepEqual(validateDelegationClaims(inspection, evidence(), [], []), { ok: false, code: "missing_run_authority" });
	assert.deepEqual(
		validateDelegationClaims(inspection, evidence(), [], [{ id: runId, outcome: "FAILURE" }]),
		{ ok: false, code: "run_status_mismatch" },
	);
	assert.deepEqual(
		validateDelegationClaims(inspection, evidence(), [], [{ id: runId, outcome: "SUCCESS" }]),
		{ ok: true },
	);
	assert.equal(
		inspectDelegationClaims(assistant(`The persisted run \`${runId}\` does not exist.`)),
		undefined,
		"truthful missing-run diagnostics remain reportable",
	);
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

test("quoted evidence, code blocks, and negated clauses cannot fabricate authority", () => {
	const inspection = inspectDelegationClaims(assistant([
		"Rejected transcript:",
		"```text",
		`delegation ${FAKE_IDS[0]} — SUCCESS/REVIEWED`,
		"```",
		`I did not start delegation ${FAKE_IDS[1]}.`,
		`delegation ${REAL_ID} — REVIEWED`,
	].join("\n")));
	assert.ok(inspection);
	assert.deepEqual(inspection.ids, [REAL_ID]);
	assert.deepEqual(
		validateDelegationClaims(inspection, evidence(), [{ id: REAL_ID, status: "REVIEWED" }]),
		{ ok: true },
	);

	const audit = inspectDelegationClaims(assistant("本次根因审计已完成；未启动任何 delegation。"));
	assert.ok(audit);
	assert.equal(audit.negativeOnly, true);
	assert.deepEqual(validateDelegationClaims(audit, evidence(), []), { ok: true });
});

test("multiple ids and transaction/session statuses bind only to their own clauses and sources", () => {
	const multi = inspectDelegationClaims(assistant([
		`delegation ${FAKE_IDS[0]} REVIEWED.`,
		`delegation ${FAKE_IDS[1]} FAILED.`,
	].join("\n")));
	assert.ok(multi);
	assert.deepEqual(multi.ids, [FAKE_IDS[0], FAKE_IDS[1]]);
	assert.deepEqual(
		validateDelegationClaims(multi, evidence(), [
			{ id: FAKE_IDS[0], status: "REVIEWED" },
			{ id: FAKE_IDS[1], status: "FAILED" },
		]),
		{ ok: true },
	);

	const sourced = inspectDelegationClaims(assistant([
		`latest: ${REAL_ID} REVIEWED`,
		"authority v2: transaction FAILED",
	].join("\n")));
	assert.ok(sourced);
	assert.deepEqual(sourced.expectedStatuses[REAL_ID], [
		{ status: "REVIEWED", source: "session" },
		{ status: "FAILED", source: "transaction" },
	]);
	assert.deepEqual(
		validateDelegationClaims(sourced, evidence(), [{ id: REAL_ID, status: "FAILED", sessionStatus: "REVIEWED" }]),
		{ ok: true },
	);

	const forgedTransaction = inspectDelegationClaims(assistant(
		`authority v2: transaction REVIEWED for delegation ${REAL_ID}`,
	));
	assert.ok(forgedTransaction);
	assert.deepEqual(
		validateDelegationClaims(forgedTransaction, evidence(), [{ id: REAL_ID, status: "FAILED", sessionStatus: "REVIEWED" }]),
		{ ok: false, code: "status_mismatch" },
		"a REVIEWED session mirror cannot satisfy a transaction-labeled claim",
	);

	const semanticSuccess = inspectDelegationClaims(assistant(`delegation ${REAL_ID} completed successfully`));
	assert.ok(semanticSuccess);
	assert.deepEqual(
		validateDelegationClaims(semanticSuccess, evidence(), [{ id: REAL_ID, status: "FAILED" }]),
		{ ok: false, code: "status_mismatch" },
	);

	const ambiguous = inspectDelegationClaims(assistant([
		`delegation ${FAKE_IDS[0]}`,
		`delegation ${FAKE_IDS[1]}`,
		"worker SUCCESS",
	].join("\n")));
	assert.ok(ambiguous);
	assert.deepEqual(
		validateDelegationClaims(ambiguous, evidence(), [
			{ id: FAKE_IDS[0], status: "REVIEWED" },
			{ id: FAKE_IDS[1], status: "REVIEWED" },
		]),
		{ ok: false, code: "ambiguous_status_binding" },
	);
});

test("claim id overflow fails closed instead of silently ignoring later ids", () => {
	const ids = Array.from({ length: 33 }, (_, index) => `20260822-130000-A${String(index).padStart(3, "0")}`);
	const inspection = inspectDelegationClaims(assistant(ids.map((id) => `delegation ${id} REVIEWED`).join("\n")));
	assert.ok(inspection);
	assert.equal(inspection.overflow, true);
	assert.equal(inspection.ids.length, 32);
	assert.deepEqual(validateDelegationClaims(inspection, evidence(), []), { ok: false, code: "claim_overflow" });
});

test("future plans are not past-tense execution claims, and broad recent reports bind every listed id", () => {
	assert.equal(
		inspectDelegationClaims(assistant("下一步可以启动新的 delegation worker。")),
		undefined,
	);
	assert.equal(
		inspectDelegationClaims(assistant("I will start a new delegation worker after review.")),
		undefined,
	);
	const priorStart = inspectDelegationClaims(assistant("The Luna worker started."));
	assert.ok(priorStart);
	assert.equal(priorStart.workerStartClaim, true);
	assert.deepEqual(validateDelegationClaims(priorStart, evidence(), []), { ok: false, code: "missing_authority" });
	assert.deepEqual(
		validateDelegationClaims(priorStart, evidence(), [{ id: REAL_ID, status: "RUNNING" }]),
		{ ok: true },
	);

	const inspection = inspectDelegationClaims(assistant([
		"已按要求改用两个全新的 delegation：",
		FAKE_IDS[0],
		FAKE_IDS[1],
	].join("\n")));
	assert.ok(inspection);
	assert.deepEqual(inspection.sameRunStartIds, [FAKE_IDS[0], FAKE_IDS[1]]);
	assert.deepEqual(
		validateDelegationClaims(inspection, evidence(1, 1, [FAKE_IDS[0]]), [
			{ id: FAKE_IDS[0], status: "REVIEWED" },
			{ id: FAKE_IDS[1], status: "REVIEWED" },
		]),
		{ ok: false, code: "missing_started_authority" },
	);
});

test("generic new execution and success claims require durable same-turn authority", () => {
	const recent = inspectDelegationClaims(assistant("已按要求启动新的 delegation worker。"));
	assert.ok(recent);
	assert.deepEqual(validateDelegationClaims(recent, evidence(), []), { ok: false, code: "missing_started_authority" });
	assert.deepEqual(
		validateDelegationClaims(recent, evidence(1), []),
		{ ok: false, code: "missing_started_authority" },
		"an attempted tool call is not proof that a worker started",
	);
	assert.deepEqual(
		validateDelegationClaims(recent, evidence(1, 0, [], [REAL_ID]), []),
		{ ok: false, code: "missing_started_authority" },
		"a changed session pointer is not enough without readable authority",
	);
	assert.deepEqual(
		validateDelegationClaims(recent, evidence(1, 0, [], [REAL_ID]), [{ id: REAL_ID, status: "PREPARED" }]),
		{ ok: false, code: "missing_started_authority" },
		"a PREPARED transaction does not prove that the Luna child started",
	);
	assert.deepEqual(
		validateDelegationClaims(recent, evidence(1, 0, [], [REAL_ID]), [{ id: REAL_ID, status: "RUNNING" }]),
		{ ok: true },
	);

	const success = inspectDelegationClaims(assistant("The new delegation worker was started and returned SUCCESS; implementation completed."));
	assert.ok(success);
	assert.deepEqual(
		validateDelegationClaims(success, evidence(1, 0, [], [REAL_ID]), [{ id: REAL_ID, status: "RUNNING" }]),
		{ ok: false, code: "missing_success_result" },
	);
	assert.deepEqual(validateDelegationClaims(success, evidence(1, 1, [REAL_ID]), []), { ok: false, code: "missing_started_authority" });
	assert.deepEqual(
		validateDelegationClaims(success, evidence(1, 1, [REAL_ID]), [{ id: REAL_ID, status: "REVIEWED" }]),
		{ ok: true },
	);

	const completed = inspectDelegationClaims(assistant(`新 worker 已成功完成：Delegation \`${REAL_ID}\``));
	assert.ok(completed);
	assert.equal(completed.recentClaim, true);
	assert.deepEqual(
		validateDelegationClaims(completed, evidence(), [{ id: REAL_ID, status: "REVIEWED" }]),
		{ ok: false, code: "missing_success_result" },
		"a current durable transaction is not proof that this turn ran it",
	);
	assert.deepEqual(
		validateDelegationClaims(completed, evidence(1, 1, [REAL_ID]), [{ id: REAL_ID, status: "REVIEWED" }]),
		{ ok: true },
	);
});

test("retrospective worker success binds to strict latest authority without a new same-run call", () => {
	const inspection = inspectDelegationClaims(assistant(
		"Read-only diagnosis: the prior delegation worker completed successfully; the review now reports review_conflict.",
	));
	assert.ok(inspection);
	assert.equal(inspection.recentClaim, false);
	assert.deepEqual(
		validateDelegationClaims(inspection, evidence(), [{ id: REAL_ID, status: "REVIEWED", sessionStatus: "STALE" }]),
		{ ok: true },
	);
	assert.deepEqual(validateDelegationClaims(inspection, evidence(), []), { ok: false, code: "missing_authority" });
	assert.deepEqual(
		validateDelegationClaims(inspection, evidence(), [{ id: REAL_ID, status: "FAILED", sessionStatus: "STALE" }]),
		{ ok: false, code: "status_mismatch" },
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
	legacyLedger?: unknown,
	readRun: (id: string) => "SUCCESS" | "FAILURE" | undefined = () => undefined,
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
		readLegacyLedger: (async () => legacyLedger ?? null) as never,
		readCommittedRun: (async (_root: string, id: string) => {
			const outcome = readRun(id);
			return outcome === undefined ? null : {
				run_id: id,
				run_outcome: outcome === "SUCCESS" ? "SUCCESS" : "PROCESS_FAILED",
			};
		}) as never,
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
	assert.ok(text.includes("reason: missing_authority"), "the bounded machine reason makes future failures diagnosable");
	assert.match(text, /claim_hash: [a-f0-9]{64}/u, "the rejected prose remains correlatable without retaining it verbatim");
	assert.equal(text.includes(FAKE_IDS[0]), false, "the guard never reinforces a fabricated id");
	assert.equal(finalText(message).includes(DELEGATION_CLAIM_GUARD_CODE), false, "caller message is immutable");
});

test("controller rejects the exact backticked fake completion even when an older latest transaction is reviewed", async () => {
	const state = stub();
	register(state, (id) => id === REAL_ID ? "REVIEWED" : undefined, true, "REVIEWED");
	await emit(state, "agent_start", { type: "agent_start" });
	const message = assistant([
		"新 worker 已成功完成修复：",
		"- Delegation：`20260822-230337-hdwr`",
		"- Focused tests：`20260822-230649-uvdr`，28 passed",
		"- 完整 G1：`20260822-230712-lu3z`，26 个本地步骤全部 PASS",
	].join("\n"));
	const results = await emit(state, "message_end", { type: "message_end", message });
	const replacement = (results.find((value) => value !== undefined) as { message: Record<string, unknown> }).message;
	assert.match(finalText(replacement), /reason: missing_authority/u);
	assert.equal(finalText(replacement).includes("20260822-230337-hdwr"), false);
});

test("controller rejects fabricated run ids even when the delegation itself is real", async () => {
	const state = stub();
	register(state, (id) => id === REAL_ID ? "REVIEWED" : undefined, true, "REVIEWED");
	await emit(state, "agent_start", { type: "agent_start" });
	const fakeRun = "20260822-230649-uvdr";
	const results = await emit(state, "message_end", {
		type: "message_end",
		message: assistant(`Prior delegation ${REAL_ID} completed successfully. Focused tests: \`${fakeRun}\`, 28 passed.`),
	});
	const replacement = (results.find((value) => value !== undefined) as { message: Record<string, unknown> }).message;
	assert.match(finalText(replacement), /reason: missing_run_authority/u);
	assert.equal(finalText(replacement).includes(fakeRun), false);
});

test("a failed delegate tool attempt cannot be reported as a started worker", async () => {
	const state = stub();
	register(state, () => undefined);
	await emit(state, "agent_start", { type: "agent_start" });
	await emit(state, "message_end", {
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Starting a delegation." },
				{ type: "toolCall", id: "call-failed", name: "workbench_delegate_worker", arguments: {} },
			],
		},
	});
	await emit(state, "tool_execution_end", {
		type: "tool_execution_end",
		toolCallId: "call-failed",
		toolName: "workbench_delegate_worker",
		isError: true,
		result: { details: { status: "error" } },
	});
	const results = await emit(state, "message_end", {
		type: "message_end",
		message: assistant("I started a new delegation worker."),
	});
	const replacement = (results.find((value) => value !== undefined) as { message: Record<string, unknown> }).message;
	assert.ok(finalText(replacement).includes("reason: missing_started_authority"));
});

test("legacy fallback accepts only internally consistent schema-v1 authority", async () => {
	const complete = {
		manifest: {
			schema_version: 1,
			delegation_id: REAL_ID,
			status: "finished",
			review_status: "PENDING_REVIEW",
			finished_at: "2026-08-22T00:00:00.000Z",
			diff_hash_after: "after-hash",
			diff_hash_before: "before-hash",
		},
		before: { schema_version: 1, delegation_id: REAL_ID, diff_hash: "before-hash" },
		after: {
			schema_version: 1,
			delegation_id: REAL_ID,
			status: "success",
			exit_code: 0,
			review_status: "PENDING_REVIEW",
			diff_hash: "after-hash",
		},
		workerSummary: {
			schema_version: 1,
			delegation_id: REAL_ID,
			status: "success",
			exit_code: 0,
		},
	};
	for (const [label, ledger, accepted] of [
		["complete", complete, true],
		["unknown schema", { ...complete, manifest: { ...complete.manifest, schema_version: 9 } }, false],
		["partial", { ...complete, workerSummary: null }, false],
	] as const) {
		const state = stub();
		register(state, () => undefined, true, undefined, ledger);
		await emit(state, "agent_start", { type: "agent_start" });
		const results = await emit(state, "message_end", {
			type: "message_end",
			message: assistant(`delegation ${REAL_ID} SUCCESS`),
		});
		assert.equal(results[0] === undefined, accepted, label);
	}
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

test("controller resolves an id-less retrospective completion against strict latest authority", async () => {
	const state = stub();
	register(state, (id) => id === REAL_ID ? "REVIEWED" : undefined, true, "STALE");
	await emit(state, "agent_start", { type: "agent_start" });
	const message = assistant(
		"Read-only diagnosis: the prior delegation worker completed successfully; the review now reports review_conflict.",
	);
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
