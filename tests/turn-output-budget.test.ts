import assert from "node:assert/strict";
import { test } from "node:test";

import {
	COMMANDER_TURN_MAX_BYTES,
	MAX_TOOL_CALLS_PER_TURN,
	WORKER_TURN_MAX_BYTES,
} from "../extensions/workbench-runtime/core/output-policy.ts";
import {
	DEFENSIVE_DYNAMIC_RESERVATION_BYTES,
	MAX_BLOCK_CONTROL_BYTES,
	TURN_CALL_LIMIT_CONTROL_TEXT,
	TURN_OUTPUT_BUDGET_CONTROL_TEXT,
	TurnOutputBudgetState,
	blockedControlText,
	createTurnOutputBudgetState,
	planTurnOutputBudget,
	type TurnToolCall,
} from "../extensions/workbench-runtime/core/turn-output-budget.ts";

function call(toolCallId: string, toolName = "unknown", args?: unknown): TurnToolCall {
	return { toolCallId, toolName, args };
}

function reservedSum(plan: ReturnType<typeof planTurnOutputBudget>): number {
	return plan.reservations.reduce(
		(sum, reservation) => sum + reservation.allocatedBytes + reservation.controlAllocatedBytes,
		0,
	);
}

test("planner allocates exact desired bytes when the role cap has room", () => {
	const plan = planTurnOutputBudget({
		turnSerial: 7,
		role: "commander",
		calls: [call("a"), call("b")],
	});
	assert.equal(plan.schema, "workbench-turn-output-v1");
	assert.equal(plan.turnSerial, 7);
	assert.equal(plan.maxBytes, COMMANDER_TURN_MAX_BYTES);
	assert.deepEqual(plan.reservations.map((reservation) => reservation.allocatedBytes), [16_384, 16_384]);
	assert.deepEqual(plan.reservations.map((reservation) => reservation.status), ["reserved", "reserved"]);
	assert.equal(plan.reservedBytes, 32_768);
	assert.equal(plan.totalReservedBytes, reservedSum(plan));
	assert.equal(plan.consumedBytes, 0);
	assert.equal(plan.controlConsumedBytes, 0);
});

test("mixed policies share one cap and the integer remainder follows source order", () => {
	const plan = planTurnOutputBudget({
		turnSerial: 1,
		role: "commander",
		maxBytes: 6_200,
		calls: [call("a"), call("b"), call("c")],
	});
	assert.deepEqual(plan.reservations.map((reservation) => reservation.minimumBytes), [2_048, 2_048, 2_048]);
	assert.deepEqual(plan.reservations.map((reservation) => reservation.allocatedBytes), [2_067, 2_067, 2_066]);
	assert.equal(plan.totalReservedBytes, 6_200);

	const mixed = planTurnOutputBudget({
		turnSerial: 2,
		role: "commander",
		maxBytes: 12_288,
		calls: [call("read", "read"), call("run", "workbench_run_recipe")],
	});
	assert.deepEqual(mixed.reservations.map((reservation) => reservation.minimumBytes), [2_048, 4_096]);
	assert.equal(mixed.totalReservedBytes, 12_288);
	assert.ok(mixed.reservations[1]!.allocatedBytes > mixed.reservations[0]!.allocatedBytes);
});

test("call-limit overflow is blocked and its fixed control result is budgeted", () => {
	const calls = Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 1 }, (_, index) => call(`call-${index}`));
	const plan = planTurnOutputBudget({ turnSerial: 3, role: "commander", calls });
	assert.equal(plan.reservations.length, 17);
	assert.equal(plan.reservations[16]!.status, "blocked");
	assert.equal(plan.reservations[16]!.blockCode, "turn_call_limit");
	assert.equal(plan.reservations[16]!.allocatedBytes, 0);
	assert.equal(plan.reservations[16]!.controlAllocatedBytes, Buffer.byteLength(TURN_CALL_LIMIT_CONTROL_TEXT));
	assert.equal(reservedSum(plan), plan.totalReservedBytes);
	assert.ok(plan.totalReservedBytes <= COMMANDER_TURN_MAX_BYTES);
});

test("every occurrence of a duplicate id is blocked and cannot reuse an authorization", () => {
	const plan = planTurnOutputBudget({
		turnSerial: 4,
		role: "worker",
		calls: [call("same", "read"), call("middle"), call("same", "read")],
	});
	assert.deepEqual(plan.reservations.map((reservation) => reservation.status), ["blocked", "reserved", "blocked"]);
	assert.deepEqual(
		[plan.reservations[0]!.blockCode, plan.reservations[2]!.blockCode],
		["turn_output_budget", "turn_output_budget"],
	);
	const state = createTurnOutputBudgetState();
	assert.equal(state.install(plan), true);
	const first = state.authorize(call("same", "read"));
	const second = state.authorize(call("same", "read"));
	const third = state.authorize(call("same", "read"));
	assert.equal(first.allowed, false);
	assert.equal(second.allowed, false);
	assert.notEqual(first.authorizationId, second.authorizationId);
	assert.equal(third.authorizationId, undefined);
	assert.equal(third.controlAllocatedBytes, 0);
});

test("minimum allocation admits only an executable source prefix and later controls become zero", () => {
	const controlSize = Buffer.byteLength(TURN_OUTPUT_BUDGET_CONTROL_TEXT);
	const plan = planTurnOutputBudget({
		turnSerial: 5,
		role: "worker",
		maxBytes: 2_048 + controlSize,
		calls: [call("first"), call("second"), call("third")],
	});
	assert.equal(plan.reservations[0]!.allocatedBytes, 2_048);
	assert.equal(plan.reservations[1]!.status, "blocked");
	assert.equal(plan.reservations[1]!.controlAllocatedBytes, controlSize);
	assert.equal(plan.reservations[2]!.status, "blocked");
	assert.equal(plan.reservations[2]!.controlAllocatedBytes, 0);
	assert.equal(plan.totalReservedBytes, plan.maxBytes);
});

test("role caps are exact and other receives the worker cap", () => {
	assert.equal(planTurnOutputBudget({ turnSerial: 1, role: "commander", calls: [] }).maxBytes, COMMANDER_TURN_MAX_BYTES);
	assert.equal(planTurnOutputBudget({ turnSerial: 1, role: "worker", calls: [] }).maxBytes, WORKER_TURN_MAX_BYTES);
	assert.equal(planTurnOutputBudget({ turnSerial: 1, role: "other", calls: [] }).maxBytes, WORKER_TURN_MAX_BYTES);
	assert.equal(planTurnOutputBudget({ turnSerial: 1, role: "hostile", calls: [] }).role, "other");
});

test("only omitted planner caps inherit defaults and every explicit invalid lower cap fails closed", () => {
	const omitted = planTurnOutputBudget({ turnSerial: 1, role: "commander", calls: [call("a")] });
	assert.equal(omitted.maxBytes, COMMANDER_TURN_MAX_BYTES);
	assert.equal(omitted.reservations[0]!.status, "reserved");

	for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.75, "16"] as unknown[]) {
		const invalidBytes = planTurnOutputBudget({
			turnSerial: 1,
			role: "commander",
			calls: [call("a")],
			maxBytes: invalid,
		});
		assert.equal(invalidBytes.maxBytes, 0);
		assert.equal(reservedSum(invalidBytes), 0);

		const invalidCalls = planTurnOutputBudget({
			turnSerial: 1,
			role: "commander",
			calls: [call("a")],
			maxCalls: invalid,
		});
		assert.equal(invalidCalls.reservations[0]!.status, "blocked");
		assert.equal(invalidCalls.reservations[0]!.blockCode, "turn_call_limit");
	}
});

test("hostile calls and throwing inputs fail closed without throwing", () => {
	const hostileCall = Object.create(null, {
		toolCallId: { get() { throw new Error("no id"); } },
		toolName: { value: "read" },
	});
	const plan = planTurnOutputBudget({ turnSerial: Number.NaN, role: "worker", calls: [hostileCall, null] });
	assert.equal(plan.turnSerial, 0);
	assert.deepEqual(plan.reservations.map((reservation) => reservation.status), ["blocked", "blocked"]);
	assert.deepEqual(plan.reservations.map((reservation) => reservation.allocatedBytes), [0, 0]);
	assert.ok(plan.totalReservedBytes <= plan.maxBytes);

	const hostileInput = Object.create(null, { role: { get() { throw new Error("no role"); } } });
	const empty = planTurnOutputBudget(hostileInput);
	assert.equal(empty.role, "other");
	assert.equal(empty.maxBytes, 0);
	assert.deepEqual(empty.reservations, []);
});

test("throwing top-level planner getters cannot recover role caps or authorize calls", () => {
	for (const hostileKey of ["maxBytes", "maxCalls", "calls"] as const) {
		const hostileInput = new Proxy({
			turnSerial: 1,
			role: "commander",
			calls: [call("secret")],
		}, {
			get(target, key, receiver): unknown {
				if (key === hostileKey) throw new Error("hostile getter");
				return Reflect.get(target, key, receiver);
			},
		});
		const plan = planTurnOutputBudget(hostileInput);
		assert.equal(plan.maxBytes, 0);
		assert.equal(reservedSum(plan), 0);
		assert.deepEqual(plan.reservations, []);
	}
});

test("plans and reservation copies are immutable", () => {
	const calls = [call("a")];
	const plan = planTurnOutputBudget({ turnSerial: 6, role: "worker", calls });
	calls[0]!.toolCallId = "mutated";
	assert.equal(plan.reservations[0]!.toolCallId, "a");
	assert.equal(Object.isFrozen(plan), true);
	assert.equal(Object.isFrozen(plan.reservations), true);
	assert.equal(Object.isFrozen(plan.reservations[0]), true);
	assert.throws(() => {
		(plan.reservations[0]! as { allocatedBytes: number }).allocatedBytes = 99;
	}, TypeError);
});

test("parallel completion permutations do not change allocations or accounting", () => {
	const plan = planTurnOutputBudget({
		turnSerial: 8,
		role: "worker",
		calls: [call("a"), call("b"), call("c")],
	});
	const run = (order: string[]) => {
		const state = new TurnOutputBudgetState();
		assert.equal(state.install(plan), true);
		const authorizations = new Map(
			["a", "b", "c"].map((id) => [id, state.authorize(call(id))]),
		);
		for (const id of order) {
			const authorization = authorizations.get(id);
			assert.ok(authorization?.authorizationId);
			state.consume({ authorizationId: authorization.authorizationId, actualBytes: 1_000 });
		}
		return state.turnEnd();
	};
	const forward = run(["a", "b", "c"]);
	const reverse = run(["c", "b", "a"]);
	assert.equal(forward.consumedBytes, 3_000);
	assert.deepEqual(forward, reverse);
});

test("eight and sixteen mixed calls exactly share commander and worker batch caps", () => {
	const mixed = (count: number) => Array.from({ length: count }, (_, index) => {
		if (index % 4 === 0) return call(`read-${index}`, "read", { path: "x" });
		if (index % 4 === 1) return call(`run-${index}`, "workbench_read_run", { include: "logs" });
		if (index % 4 === 2) return call(`compare-${index}`, "workbench_compare_runs", {});
		return call(`search-${index}`, "grep", { pattern: "x" });
	});
	const commander = planTurnOutputBudget({ turnSerial: 80, role: "commander", calls: mixed(8) });
	const worker = planTurnOutputBudget({ turnSerial: 81, role: "worker", calls: mixed(16) });
	assert.equal(commander.totalReservedBytes, COMMANDER_TURN_MAX_BYTES);
	assert.equal(worker.totalReservedBytes, WORKER_TURN_MAX_BYTES);
	assert.ok(commander.reservations.every((reservation) => reservation.status === "reserved"));
	assert.ok(worker.reservations.every((reservation) => reservation.status === "reserved"));
});

test("no-plan authorization uses one fixed defensive reservation and never reuses an id", () => {
	const state = new TurnOutputBudgetState();
	state.start({ turnSerial: 9, role: "worker" });
	const authorization = state.authorize(call("dynamic", "workbench_run_recipe"));
	assert.equal(authorization.planned, false);
	assert.equal(authorization.allowed, true);
	assert.equal(authorization.allocatedBytes, DEFENSIVE_DYNAMIC_RESERVATION_BYTES);
	const duplicate = state.authorize(call("dynamic", "workbench_run_recipe"));
	assert.equal(duplicate.allowed, false);
	assert.equal(duplicate.allocatedBytes, 0);
	const accounting = state.consume({ authorizationId: authorization.authorizationId, actualBytes: 512 });
	assert.deepEqual(accounting, {
		accepted: true,
		allowedBytes: DEFENSIVE_DYNAMIC_RESERVATION_BYTES,
		accountedBytes: 512,
		truncated: false,
		control: false,
	});
	assert.equal(state.consume({ authorizationId: authorization.authorizationId, actualBytes: 1 }).accepted, false);
	assert.ok(state.turnEnd().totalAccountedBytes <= WORKER_TURN_MAX_BYTES);
});

test("no-plan authorization enforces the 16-call limit for commander and worker and reset restores it", () => {
	for (const role of ["commander", "worker"] as const) {
		const state = new TurnOutputBudgetState();
		state.start({ turnSerial: 90, role });
		for (let index = 0; index < MAX_TOOL_CALLS_PER_TURN; index += 1) {
			const authorization = state.authorize(call(`${role}-${index}`, "read"));
			assert.equal(authorization.allowed, true);
		}
		const seventeenth = state.authorize(call(`${role}-16`, "read"));
		assert.equal(seventeenth.allowed, false);
		assert.equal(seventeenth.blockCode, "turn_call_limit");
		assert.equal(seventeenth.controlText, TURN_CALL_LIMIT_CONTROL_TEXT);
		assert.equal(seventeenth.controlAllocatedBytes, Buffer.byteLength(TURN_CALL_LIMIT_CONTROL_TEXT));
		assert.ok(seventeenth.authorizationId);

		const repeated = state.authorize(call(`${role}-0`, "read"));
		assert.equal(repeated.allowed, false);
		assert.equal(repeated.blockCode, "turn_call_limit");
		assert.equal(repeated.controlAllocatedBytes, Buffer.byteLength(TURN_CALL_LIMIT_CONTROL_TEXT));
		assert.notEqual(repeated.authorizationId, seventeenth.authorizationId);
		const telemetry = state.turnEnd();
		assert.ok(telemetry.reservedBytes <= telemetry.maxBytes);

		state.reset();
		state.start({ turnSerial: 91, role });
		assert.equal(state.authorize(call(`${role}-after-reset`, "read")).allowed, true);
	}
});

test("hostile and duplicate no-plan attempts count toward the call limit", () => {
	const state = new TurnOutputBudgetState();
	state.start({ turnSerial: 92, role: "worker" });
	const hostile = new Proxy({} as TurnToolCall, { get(): never { throw new Error("hostile"); } });
	for (let index = 0; index < 8; index += 1) {
		assert.equal(state.authorize(hostile).allowed, false);
	}
	const first = state.authorize(call("repeat", "read"));
	assert.equal(first.allowed, true);
	for (let index = 0; index < 7; index += 1) {
		assert.equal(state.authorize(call("repeat", "read")).allowed, false);
	}
	const seventeenth = state.authorize(call("new", "read"));
	assert.equal(seventeenth.blockCode, "turn_call_limit");
	assert.equal(seventeenth.allowed, false);
	assert.ok(state.snapshot().totalReservedBytes <= WORKER_TURN_MAX_BYTES);
});

test("consume never borrows, receipt-BEGIN release is terminal, and reset clears state", () => {
	const plan = planTurnOutputBudget({ turnSerial: 10, role: "worker", calls: [call("a"), call("b")] });
	const state = createTurnOutputBudgetState();
	assert.equal(state.installPlan(plan), true);
	const first = state.authorizeToolCall(call("a"));
	const second = state.authorizeToolCall(call("b"));
	assert.ok(first.authorizationId && second.authorizationId);
	assert.equal(state.releaseAuthorization({ authorizationId: first.authorizationId }), true);
	assert.equal(state.releaseAuthorization({ authorizationId: first.authorizationId }), false);
	const secondAccounting = state.consumeResult({ authorizationId: second.authorizationId, actualBytes: Number.MAX_SAFE_INTEGER });
	assert.equal(secondAccounting.accountedBytes, second.allocatedBytes);
	assert.equal(secondAccounting.truncated, true);
	const telemetry = state.endTurn();
	assert.equal(telemetry.consumedBytes, second.allocatedBytes);
	assert.equal(telemetry.controlConsumedBytes, 0);
	assert.ok(telemetry.totalAccountedBytes <= telemetry.maxBytes);
	assert.equal(telemetry.releasedCalls, 1);
	assert.deepEqual(state.endTurn(), telemetry);
	state.reset();
	assert.equal(state.snapshot().consumedBytes, 0);
	assert.deepEqual(state.snapshot().reservations, []);
});

test("immediate executable and blocked results use only their independent allocations", () => {
	const plan = planTurnOutputBudget({
		turnSerial: 11,
		role: "worker",
		calls: [call("duplicate", "read"), call("ok"), call("duplicate", "read")],
	});
	const state = createTurnOutputBudgetState();
	assert.equal(state.install(plan), true);
	const blocked = state.authorize(call("duplicate", "read"));
	const executable = state.authorize(call("ok"));
	assert.ok(blocked.authorizationId && executable.authorizationId);
	const blockedResult = state.accountImmediateResult({ authorizationId: blocked.authorizationId, actualBytes: 10_000 });
	const executableResult = state.accountImmediate({ authorizationId: executable.authorizationId, actualBytes: 10_000_000 });
	assert.equal(blockedResult.control, true);
	assert.equal(blockedResult.allowedBytes, blocked.controlAllocatedBytes);
	assert.equal(blockedResult.accountedBytes, blocked.controlAllocatedBytes);
	assert.equal(executableResult.control, false);
	assert.equal(executableResult.accountedBytes, executable.allocatedBytes);
	assert.equal(state.accountImmediateResult({ authorizationId: blocked.authorizationId, actualBytes: 1 }).accepted, false);
	const telemetry = state.turnEnd();
	assert.equal(telemetry.controlConsumedBytes, blocked.controlAllocatedBytes);
	assert.equal(telemetry.consumedBytes, executable.allocatedBytes);
	assert.ok(telemetry.consumedBytes + telemetry.controlConsumedBytes <= telemetry.maxBytes);
});

test("blocked reason text is fixed, bounded, and contains no call data", () => {
	assert.equal(blockedControlText("turn_call_limit"), TURN_CALL_LIMIT_CONTROL_TEXT);
	assert.equal(blockedControlText("turn_output_budget"), TURN_OUTPUT_BUDGET_CONTROL_TEXT);
	for (const text of [TURN_CALL_LIMIT_CONTROL_TEXT, TURN_OUTPUT_BUDGET_CONTROL_TEXT]) {
		assert.ok(Buffer.byteLength(text, "utf8") < MAX_BLOCK_CONTROL_BYTES);
		assert.equal(text.includes("secret"), false);
	}
});
