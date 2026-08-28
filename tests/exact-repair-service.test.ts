import assert from "node:assert/strict";
import test from "node:test";

import {
	exactRepairSuccessorNextActionV1,
	runExactRepairServiceV1,
	type ExactRepairServiceDependenciesV1,
} from "../extensions/workbench-runtime/core/exact-repair-service.ts";
import type { ExactRepairCommandAuthorityV1 } from "../extensions/workbench-runtime/core/exact-repair-authority.ts";
import type { DelegationCommittedGenerationV2 } from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";

const ID = "20260827-010203-qrep";
const BOUND = "9".repeat(64);

function committed(
	status: "PENDING_REVIEW" | "INTERRUPTED" | "FAILED",
	lineaged = false,
	changedPaths: readonly string[] = ["src/repaired.ts"],
): DelegationCommittedGenerationV2 {
	return {
		state: {
			delegation_id: ID,
			status,
			task_kind: "implementation",
			revision: 3,
			allowed_paths: ["src/**"],
			committed_proof: { revision: 2, content_hash: "c".repeat(64) },
			review: null,
			terminal_outcome: {
				terminal_facts_complete: true,
				scope_complete: true,
				changed_paths: [...changedPaths],
				delta_hash: "f".repeat(64),
				change_set_status: "ATTRIBUTED",
			},
			...(lineaged ? { repair_lineage: { depth: 1 } } : {}),
		},
		proof: { revision: 2, content_hash: "c".repeat(64) },
		records: {},
	} as unknown as DelegationCommittedGenerationV2;
}

function authority(kind: "semantic-repair" | "terminal-negative-repair" | "terminal-lineage"): ExactRepairCommandAuthorityV1 {
	return {
		schema_version: 1,
		kind: "exact-repair-command-execution-v1",
		repair_of: ID,
		committed_proof_content_hash: "c".repeat(64),
		authority_kind: kind,
		...(kind === "terminal-lineage"
			? { lineage_hash: "6".repeat(64) }
			: { semantic_decision_hash: "d".repeat(64) }),
		...(kind === "terminal-negative-repair" ? { expected_bound_diff_hash: BOUND } : {}),
		arguments: {
			task_kind: "implementation",
			task: "Repair the exact durable parent.",
			allowed_paths: ["src/**"],
			acceptance_criteria: ["The defect is repaired."],
			verification: [],
			timeout_seconds: 600,
			budget_profile: "standard",
			repair_of: ID,
		},
		successor_lineage: { depth: 1 },
		idempotency_key: "e".repeat(64),
		tool_call_id: `q-repair-${"e".repeat(64)}`,
	} as unknown as ExactRepairCommandAuthorityV1;
}

function successor(
	status: "PREPARED" | "PENDING_REVIEW" = "PREPARED",
	disposition: "ACTIVE" | "REVIEW_PENDING" | "REPAIR_PENDING" | "CHAIN_CLOSED" | "EXACT_REPAIR_PENDING" | "BLOCKED" =
		status === "PREPARED" ? "ACTIVE" : "REVIEW_PENDING",
) {
	return {
		delegation_id: "20260827-010204-next",
		status,
		contract_hash: "a".repeat(64),
		transaction_hash: "b".repeat(64),
		committed_proof_content_hash: null,
		disposition,
	};
}

function input() {
	return {
		project_root: "/project",
		repair_of: ID,
		signal: undefined,
		on_update: undefined,
		execution_context: {} as never,
	};
}

test("UI-free service reads ordinary semantic REPAIR and records one strict successor", async () => {
	let reviewReads = 0;
	let terminalReads = 0;
	let successorReads = 0;
	let executions = 0;
	let bindingReads = 0;
	const expected = authority("semantic-repair");
	const dependencies: ExactRepairServiceDependenciesV1 = {
		readCommittedGeneration: (async () => ({ ok: true, value: committed("PENDING_REVIEW") })) as never,
		readReview: (async () => { reviewReads += 1; return { ok: true, value: { review: true } }; }) as never,
		readTerminalNegativeRepair: (async () => { terminalReads += 1; throw new Error("must not read terminal sidecar"); }) as never,
		recoverAuthority: ((recoveryInput: { review?: unknown; terminalNegativeRepair?: unknown }) => {
			assert.ok(recoveryInput.review);
			assert.equal(recoveryInput.terminalNegativeRepair, undefined);
			return { ok: true, value: expected };
		}) as never,
		readSuccessor: (async () => {
			successorReads += 1;
			return successorReads === 1 ? { ok: true, kind: "none" } : { ok: true, kind: "existing", value: successor("PENDING_REVIEW") };
		}) as never,
		collectCurrentBinding: async () => { bindingReads += 1; return { status: "fresh", hash: BOUND }; },
		executeExactRepair: (async (received: ExactRepairCommandAuthorityV1) => {
			executions += 1;
			assert.equal(received, expected);
			return { content: [{ type: "text", text: "untrusted tool text" }], details: { ok: true } };
		}) as never,
	};
	const result = await runExactRepairServiceV1(input(), dependencies);
	assert.equal(result.status, "SUCCESSOR_RECORDED");
	if (result.status !== "SUCCESSOR_RECORDED") return;
	assert.equal(result.replayed, false);
	assert.equal(result.execution_outcome, "returned");
	assert.equal(result.successor.status, "PENDING_REVIEW");
	assert.equal(result.lifecycle_resolution?.primary_action.action, "EXECUTE_EXACT_REPAIR");
	assert.equal(result.lifecycle_resolution?.primary_action.exact_target.id, ID);
	assert.deepEqual({ reviewReads, terminalReads, successorReads, executions, bindingReads }, {
		reviewReads: 1, terminalReads: 0, successorReads: 2, executions: 1, bindingReads: 0,
	});
});

test("UI-free service routes INTERRUPTED and legacy FAILED through terminal-negative sidecar and fresh binding", async () => {
	for (const status of ["INTERRUPTED", "FAILED"] as const) {
		let terminalReads = 0;
		let successorReads = 0;
		let executions = 0;
		let bindingReads = 0;
		const expected = authority("terminal-negative-repair");
		const result = await runExactRepairServiceV1(input(), {
			readCommittedGeneration: (async () => ({ ok: true, value: committed(status) })) as never,
			readReview: (async () => { throw new Error("must not read ordinary review"); }) as never,
			readTerminalNegativeRepair: (async () => {
				terminalReads += 1;
				return { ok: true, value: { bound_diff_hash: BOUND } };
			}) as never,
			recoverAuthority: ((recoveryInput: { currentBindingHash?: string; terminalNegativeRepair?: unknown }) => {
				assert.equal(recoveryInput.currentBindingHash, BOUND);
				assert.ok(recoveryInput.terminalNegativeRepair);
				return { ok: true, value: expected };
			}) as never,
			readSuccessor: (async () => {
				successorReads += 1;
				return successorReads === 1
					? { ok: true, kind: "none" }
					: { ok: true, kind: "existing", value: successor("PENDING_REVIEW") };
			}) as never,
			collectCurrentBinding: async () => { bindingReads += 1; return { status: "fresh", hash: BOUND }; },
			executeExactRepair: (async () => { executions += 1; return { content: [], details: { ok: true } }; }) as never,
		});
		assert.equal(result.status, "SUCCESSOR_RECORDED", status);
		if (result.status === "SUCCESSOR_RECORDED") assert.equal(result.authority.authority_kind, "terminal-negative-repair", status);
		assert.deepEqual({ terminalReads, successorReads, executions, bindingReads }, {
			terminalReads: 1, successorReads: 2, executions: 1, bindingReads: 1,
		}, status);
	}
});

test("a lineaged FAILED parent prefers a newer terminal-negative decision and otherwise retains lineage retry", async () => {
	for (const hasNewDecision of [true, false] as const) {
		let terminalReads = 0;
		let recoveredWithTerminal = false;
		const expected = authority(hasNewDecision ? "terminal-negative-repair" : "semantic-repair") as ExactRepairCommandAuthorityV1;
		const result = await runExactRepairServiceV1(input(), {
			readCommittedGeneration: (async () => ({ ok: true, value: committed("FAILED", true) })) as never,
			readReview: (async () => { throw new Error("must not read ordinary review"); }) as never,
			readTerminalNegativeRepair: (async () => {
				terminalReads += 1;
				return hasNewDecision
					? { ok: true, value: { bound_diff_hash: BOUND } }
					: { ok: false, error: { code: "not_found" } };
			}) as never,
			recoverAuthority: ((recoveryInput: { terminalNegativeRepair?: unknown }) => {
				recoveredWithTerminal = recoveryInput.terminalNegativeRepair !== undefined;
				return { ok: true, value: expected };
			}) as never,
			readSuccessor: (async () => ({ ok: true, kind: "existing", value: successor("PENDING_REVIEW") })) as never,
			collectCurrentBinding: async () => ({ status: "fresh", hash: BOUND }),
			executeExactRepair: (async () => { throw new Error("durable replay must not execute"); }) as never,
		});
		assert.equal(result.status, "SUCCESSOR_RECORDED");
		assert.equal(terminalReads, 1);
		assert.equal(recoveredWithTerminal, hasNewDecision);
	}
});

test("a zero-delta lineaged FAILED parent bypasses the inapplicable terminal-negative reader", async () => {
	let terminalReads = 0;
	let recoveredWithTerminal = true;
	const result = await runExactRepairServiceV1(input(), {
		readCommittedGeneration: (async () => ({ ok: true, value: committed("FAILED", true, []) })) as never,
		readReview: (async () => { throw new Error("must not read ordinary review"); }) as never,
		readTerminalNegativeRepair: (async () => {
			terminalReads += 1;
			return { ok: false, error: { code: "invalid_record" } };
		}) as never,
		recoverAuthority: ((recoveryInput: { terminalNegativeRepair?: unknown }) => {
			recoveredWithTerminal = recoveryInput.terminalNegativeRepair !== undefined;
		return { ok: true, value: authority("terminal-lineage") };
		}) as never,
		readSuccessor: (async () => ({ ok: true, kind: "existing", value: successor("PENDING_REVIEW") })) as never,
		collectCurrentBinding: async () => ({ status: "fresh", hash: BOUND }),
		executeExactRepair: (async () => { throw new Error("durable replay must not execute"); }) as never,
	});
	assert.equal(result.status, "SUCCESSOR_RECORDED");
	assert.equal(terminalReads, 0);
	assert.equal(recoveredWithTerminal, false);
});

test("an eligible lineaged FAILED parent still rejects a corrupt terminal-negative sidecar", async () => {
	let recoveries = 0;
	const result = await runExactRepairServiceV1(input(), {
		readCommittedGeneration: (async () => ({ ok: true, value: committed("FAILED", true) })) as never,
		readReview: (async () => { throw new Error("must not read ordinary review"); }) as never,
		readTerminalNegativeRepair: (async () => ({ ok: false, error: { code: "invalid_record" } })) as never,
		recoverAuthority: (() => {
			recoveries += 1;
			return { ok: true, value: authority("terminal-lineage") };
		}) as never,
		readSuccessor: (async () => { throw new Error("corrupt authority must stop before successor replay"); }) as never,
		collectCurrentBinding: async () => ({ status: "fresh", hash: BOUND }),
		executeExactRepair: (async () => { throw new Error("corrupt authority must not execute"); }) as never,
	});
	assert.deepEqual(result, {
		status: "AUTHORITY_UNAVAILABLE",
		repair_of: ID,
		source: "terminal-negative-repair",
		code: "invalid_record",
	});
	assert.equal(recoveries, 0);
});

test("durable replay precedes live binding and never executes a second worker", async () => {
	let bindingReads = 0;
	let executions = 0;
	const result = await runExactRepairServiceV1(input(), {
		readCommittedGeneration: (async () => ({ ok: true, value: committed("INTERRUPTED") })) as never,
		readTerminalNegativeRepair: (async () => ({ ok: true, value: { bound_diff_hash: BOUND } })) as never,
		recoverAuthority: (() => ({ ok: true, value: authority("terminal-negative-repair") })) as never,
		readSuccessor: (async () => ({ ok: true, kind: "existing", value: successor() })) as never,
		readReview: (async () => { throw new Error("must not read"); }) as never,
		collectCurrentBinding: async () => { bindingReads += 1; return { status: "conflict", hash: "7".repeat(64) }; },
		executeExactRepair: (async () => { executions += 1; throw new Error("must not execute"); }) as never,
	});
	assert.equal(result.status, "SUCCESSOR_ACTIVE");
	if (result.status === "SUCCESSOR_ACTIVE") {
		assert.equal(result.replayed, true);
		assert.equal(result.execution_attempted, false);
	}
	assert.equal(bindingReads, 0);
	assert.equal(executions, 0);
});

test("raw-lineage replay is immutable-first and never re-enters live recovery or execution", async () => {
	let immutableReads = 0;
	let replayReads = 0;
	let liveRecoveries = 0;
	let transactionReads = 0;
	let bindingReads = 0;
	let successorReads = 0;
	let executions = 0;
	const rawSuccessor = successor("PREPARED", "EXACT_REPAIR_PENDING");
	const result = await runExactRepairServiceV1(input(), {
		readCommittedGeneration: (async () => ({ ok: false, error: { code: "not_found" } })) as never,
		readRawImmutable: (async () => {
			immutableReads += 1;
			return {
				ok: true,
				value: {
					immutable_hash: "1".repeat(64),
					parent: { delegation_id: ID },
					arguments: { repair_of: ID },
					successor_lineage: { repair_of: ID },
				},
			};
		}) as never,
		readRawSuccessor: (async () => {
			replayReads += 1;
			return { ok: true, kind: "existing", value: rawSuccessor };
		}) as never,
		recoverRawAuthority: (async () => {
			liveRecoveries += 1;
			throw new Error("replay must not require live authority");
		}) as never,
		readTransaction: (async () => {
			transactionReads += 1;
			throw new Error("replay must not reread mutable tip state");
		}) as never,
		readSuccessor: (async () => {
			successorReads += 1;
			throw new Error("raw replay must use immutable successor scan");
		}) as never,
		collectCurrentBinding: async () => {
			bindingReads += 1;
			return { status: "conflict", hash: "7".repeat(64) };
		},
		executeExactRepair: (async () => {
			executions += 1;
			throw new Error("replay must not execute");
		}) as never,
	});
	assert.equal(result.status, "RAW_SUCCESSOR_REPLAY");
	if (result.status === "RAW_SUCCESSOR_REPLAY") {
		assert.equal(result.successor.disposition, "EXACT_REPAIR_PENDING");
		assert.equal(result.next_action, `call workbench_repair_delegation with delegation_id=${rawSuccessor.delegation_id}`);
		assert.equal(result.execution_attempted, false);
	}
	assert.deepEqual({ immutableReads, replayReads, liveRecoveries, transactionReads, bindingReads, successorReads, executions }, {
		immutableReads: 1,
		replayReads: 1,
		liveRecoveries: 0,
		transactionReads: 0,
		bindingReads: 0,
		successorReads: 0,
		executions: 0,
	});
});

test("a successor published during raw live recovery is replayed instead of reported as a false failure", async () => {
	let replayReads = 0;
	let liveRecoveries = 0;
	let transactionReads = 0;
	let executions = 0;
	const rawSuccessor = successor("PREPARED", "EXACT_REPAIR_PENDING");
	const result = await runExactRepairServiceV1(input(), {
		readCommittedGeneration: (async () => ({ ok: false, error: { code: "not_found" } })) as never,
		readRawImmutable: (async () => ({
			ok: true,
			value: {
				immutable_hash: "1".repeat(64),
				parent: { delegation_id: ID },
				arguments: { repair_of: ID },
				successor_lineage: { repair_of: ID },
			},
		})) as never,
		readRawSuccessor: (async () => {
			replayReads += 1;
			return replayReads === 1
				? { ok: true, kind: "none" }
				: { ok: true, kind: "existing", value: rawSuccessor };
		}) as never,
		recoverRawAuthority: (async () => {
			liveRecoveries += 1;
			return { ok: false, code: "PROJECT_CLOSURE_INVALID" };
		}) as never,
		readTransaction: (async () => {
			transactionReads += 1;
			throw new Error("the raced successor must be replayed before tip reread");
		}) as never,
		readSuccessor: (async () => { throw new Error("must not enter committed successor path"); }) as never,
		collectCurrentBinding: async () => { throw new Error("injected recovery owns any live checks"); },
		executeExactRepair: (async () => {
			executions += 1;
			throw new Error("race replay must not execute");
		}) as never,
	});
	assert.equal(result.status, "RAW_SUCCESSOR_REPLAY");
	if (result.status === "RAW_SUCCESSOR_REPLAY") {
		assert.equal(result.successor.delegation_id, rawSuccessor.delegation_id);
		assert.equal(result.next_action, `call workbench_repair_delegation with delegation_id=${rawSuccessor.delegation_id}`);
	}
	assert.deepEqual({ replayReads, liveRecoveries, transactionReads, executions }, {
		replayReads: 2,
		liveRecoveries: 1,
		transactionReads: 0,
		executions: 0,
	});
});

test("successor dispositions expose only executable deterministic next actions", () => {
	const id = successor().delegation_id;
	for (const [disposition, expected] of [
		["ACTIVE", "call workbench_delegation_status"],
		["REVIEW_PENDING", `call workbench_review_worker_diff with delegation_id=${id}`],
		["REPAIR_PENDING", `call workbench_repair_delegation with delegation_id=${id}`],
		["CHAIN_CLOSED", null],
		["EXACT_REPAIR_PENDING", `call workbench_repair_delegation with delegation_id=${id}`],
		["BLOCKED", "call workbench_delegation_status"],
	] as const) {
		assert.equal(exactRepairSuccessorNextActionV1(successor("PREPARED", disposition)), expected, disposition);
	}
});

test("stale terminal binding and idempotency conflict both fail before exact execution", async () => {
	for (const scenario of ["binding", "idempotency"] as const) {
		let executions = 0;
		const result = await runExactRepairServiceV1(input(), {
			readCommittedGeneration: (async () => ({ ok: true, value: committed("INTERRUPTED") })) as never,
			readTerminalNegativeRepair: (async () => ({ ok: true, value: { bound_diff_hash: BOUND } })) as never,
			recoverAuthority: (() => ({ ok: true, value: authority("terminal-negative-repair") })) as never,
			readSuccessor: (async () => scenario === "idempotency"
				? { ok: false, code: "IDEMPOTENCY_CONFLICT", delegation_id: "20260827-010204-conflict" }
				: { ok: true, kind: "none" }) as never,
			readReview: (async () => { throw new Error("must not read"); }) as never,
			collectCurrentBinding: async () => ({ status: "conflict", hash: "7".repeat(64) }),
			executeExactRepair: (async () => { executions += 1; throw new Error("must not execute"); }) as never,
		});
		assert.equal(result.status, scenario === "binding" ? "CURRENT_BINDING_CHANGED" : "IDEMPOTENCY_REFUSED");
		assert.equal(result.lifecycle_resolution?.primary_action.action,
			scenario === "binding" ? "REBASE_CURRENT_BINDING" : "EXECUTE_EXACT_REPAIR");
		assert.equal(executions, 0);
	}
});

test("lost response succeeds only through strict successor readback; returned text without a successor fails closed", async () => {
	for (const durableAfter of [true, false] as const) {
		let successorReads = 0;
		const result = await runExactRepairServiceV1(input(), {
			readCommittedGeneration: (async () => ({ ok: true, value: committed("PENDING_REVIEW") })) as never,
			readReview: (async () => ({ ok: true, value: { review: true } })) as never,
			readTerminalNegativeRepair: (async () => { throw new Error("must not read"); }) as never,
			recoverAuthority: (() => ({ ok: true, value: authority("semantic-repair") })) as never,
			readSuccessor: (async () => {
				successorReads += 1;
				return successorReads === 1 || !durableAfter
					? { ok: true, kind: "none" }
					: { ok: true, kind: "existing", value: successor("PENDING_REVIEW") };
			}) as never,
			collectCurrentBinding: async () => ({ status: "fresh", hash: BOUND }),
			executeExactRepair: durableAfter
				? (async () => { throw new Error("response channel lost"); }) as never
				: (async () => ({ content: [{ type: "text", text: "claimed success" }], details: { ok: true } })) as never,
		});
		assert.equal(result.status, durableAfter ? "SUCCESSOR_RECORDED" : "EXECUTION_READBACK_FAILED");
		if (durableAfter && result.status === "SUCCESSOR_RECORDED") {
			assert.equal(result.execution_outcome, "threw");
			assert.match(result.execution_error ?? "", /response channel lost/u);
		}
	}
});
