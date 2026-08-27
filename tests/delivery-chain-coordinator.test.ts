import assert from "node:assert/strict";
import test from "node:test";

import {
	coordinateDeliveryChainV1,
	DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
	type DeliveryChainCoordinatorInputV1,
} from "../extensions/workbench-runtime/core/delivery-chain-coordinator.ts";
import type { AutomaticSemanticReviewResult } from "../extensions/workbench-runtime/core/automatic-semantic-review-service.ts";
import type {
	ExactRepairServiceResultV1,
	ExactRepairSuccessorRecordedV1,
} from "../extensions/workbench-runtime/core/exact-repair-service.ts";
import type { ExactRepairExistingSuccessorV1 } from "../extensions/workbench-runtime/core/exact-repair-successor.ts";
import type { ExactRepairCommandAuthorityV1 } from "../extensions/workbench-runtime/core/exact-repair-authority.ts";

const ID = "20260827-010203-root";
const CHILD = "20260827-010204-child";
const BOUND = "9".repeat(64);

const zeroUsage = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

function input(): DeliveryChainCoordinatorInputV1 {
	return {
		review: {
			project_root: "/project",
			delegation_id: ID,
			exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
			model_registry: {} as never,
		},
		exact_repair_execution: {
			signal: undefined,
			on_update: undefined,
			execution_context: {} as never,
		},
		max_successor_attempts: DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
	};
}

function durableReview(status: "ACCEPT" | "REPAIR"): AutomaticSemanticReviewResult {
	return {
		status,
		delegation_id: ID,
		bound_diff_hash: BOUND,
		durable: true,
		replayed: false,
		nested_usage: zeroUsage,
		mechanical_page_calls: 1,
		...(status === "REPAIR" ? { next_action: `call workbench_repair_delegation with delegation_id=${ID}` } : {}),
	};
}

function exactAuthority(kind: "semantic-repair" | "terminal-negative-repair"): ExactRepairCommandAuthorityV1 {
	return {
		authority_kind: kind,
		repair_of: ID,
		idempotency_key: "a".repeat(64),
		tool_call_id: `q-repair-${"a".repeat(64)}`,
	} as unknown as ExactRepairCommandAuthorityV1;
}

function recorded(kind: "semantic-repair" | "terminal-negative-repair"): ExactRepairSuccessorRecordedV1 {
	return {
		status: "SUCCESSOR_RECORDED",
		repair_of: ID,
		authority: exactAuthority(kind),
			successor: {
				delegation_id: CHILD,
				status: "PENDING_REVIEW",
				contract_hash: "b".repeat(64),
				transaction_hash: "c".repeat(64),
				committed_proof_content_hash: "d".repeat(64),
				disposition: "REVIEW_PENDING",
			},
		replayed: false,
		execution_attempted: true,
		execution_outcome: "returned",
		execution_status: "completed",
		execution_result: {
			content: [{ type: "text", text: "untrusted child text" }],
			details: { ok: true, next_action: `call workbench_repair_delegation with delegation_id=${CHILD}` },
		},
	};
}

function strictDisposition(
	status: "SUCCESSOR_ACTIVE" | "EXACT_REPAIR_PENDING" | "SUCCESSOR_BLOCKED",
	disposition: Extract<ExactRepairExistingSuccessorV1["disposition"], "ACTIVE" | "EXACT_REPAIR_PENDING" | "BLOCKED">,
): ExactRepairServiceResultV1 {
	return {
		status,
		repair_of: ID,
		authority: exactAuthority("semantic-repair"),
		successor: {
			delegation_id: CHILD,
			status: disposition === "ACTIVE" ? "RUNNING" : "FAILED",
			contract_hash: "b".repeat(64),
			transaction_hash: "c".repeat(64),
			committed_proof_content_hash: disposition === "ACTIVE" ? null : "d".repeat(64),
			disposition,
		},
		replayed: true,
		execution_attempted: false,
		execution_outcome: "not_started",
	};
}

function settledAuthority() {
	return {
		ok: true as const,
		value: {
			schema_version: 1 as const,
			project_root: "/project",
			delegation_id: ID,
			bound_diff_hash: BOUND,
			parent_lineage_depth: 0 as const,
			authority_confirmed: true as const,
			no_active_lane: true as const,
		},
	};
}

test("normal Sol REPAIR confirms the settled parent then invokes one semantic successor", async () => {
	let confirmations = 0;
	let repairs = 0;
	const result = await coordinateDeliveryChainV1(input(), {
		review: async () => durableReview("REPAIR"),
		confirmParentSettled: async (request) => {
			confirmations += 1;
			assert.deepEqual(request, {
				project_root: "/project",
				delegation_id: ID,
				bound_diff_hash: BOUND,
				required_parent_lineage_depth: 0,
			});
			return settledAuthority();
		},
		repair: async (repairInput) => {
			repairs += 1;
			assert.equal(repairInput.repair_of, ID);
			return recorded("semantic-repair");
		},
	});
	assert.equal(result.status, "SUCCESSOR_RECORDED");
	assert.equal(result.successor_attempts_used, 1);
	if (result.status === "SUCCESSOR_RECORDED") {
		assert.equal(result.repair.authority.authority_kind, "semantic-repair");
		assert.equal(result.repair.successor.delegation_id, CHILD);
	}
	assert.deepEqual({ confirmations, repairs }, { confirmations: 1, repairs: 1 });
});

test("terminal-negative Sol REPAIR uses the same single-attempt entry and never recursively repairs the child", async () => {
	let reviews = 0;
	let repairs = 0;
	const result = await coordinateDeliveryChainV1(input(), {
		review: async () => { reviews += 1; return durableReview("REPAIR"); },
		confirmParentSettled: async () => settledAuthority(),
		repair: async () => { repairs += 1; return recorded("terminal-negative-repair"); },
	});
	assert.equal(result.status, "SUCCESSOR_RECORDED");
	if (result.status === "SUCCESSOR_RECORDED") {
		assert.equal(result.repair.authority.authority_kind, "terminal-negative-repair");
		assert.equal(result.repair.successor.status, "PENDING_REVIEW");
	}
	assert.equal(reviews, 1, "the coordinator reviews only the parent entry");
	assert.equal(repairs, 1, "a child REPAIR route remains durable and is never auto-run again");
});

test("ACCEPT and retryable review never inspect settled authority or invoke exact repair", async () => {
	for (const review of [
		durableReview("ACCEPT"),
		{
			status: "RETRYABLE_FAILURE",
			code: "MODEL_ERROR",
			delegation_id: ID,
			nested_usage: zeroUsage,
			mechanical_page_calls: 0,
			next_action: `call workbench_review_worker_diff with delegation_id=${ID}`,
		} as AutomaticSemanticReviewResult,
	]) {
		let confirmations = 0;
		let repairs = 0;
		const result = await coordinateDeliveryChainV1(input(), {
			review: async () => review,
			confirmParentSettled: async () => { confirmations += 1; return settledAuthority(); },
			repair: async () => { repairs += 1; return recorded("semantic-repair"); },
		});
		assert.equal(result.status, review.status === "ACCEPT" ? "ACCEPT" : "REVIEW_RETRYABLE");
		assert.equal(result.successor_attempts_used, 0);
		assert.deepEqual({ confirmations, repairs }, { confirmations: 0, repairs: 0 });
	}
});

test("active lane or mismatched settled-authority proof starts zero children", async () => {
	for (const confirm of [
		async () => ({ ok: false as const, code: "OWNER_STILL_ACTIVE" }),
		async () => ({
			ok: true as const,
			value: { ...settledAuthority().value, delegation_id: "20260827-010205-wrong" },
		}),
		async () => ({
			ok: true as const,
			value: { ...settledAuthority().value, parent_lineage_depth: 1 },
		}),
		async () => ({
			ok: true as const,
			value: { ...settledAuthority().value, bound_diff_hash: "7".repeat(64) },
		}),
	]) {
		let repairs = 0;
		const result = await coordinateDeliveryChainV1(input(), {
			review: async () => durableReview("REPAIR"),
			confirmParentSettled: confirm as never,
			repair: async () => { repairs += 1; return recorded("semantic-repair"); },
		});
		assert.equal(result.status, "REPAIR_PENDING");
		assert.equal(result.successor_attempts_used, 0);
		if (result.status === "REPAIR_PENDING") assert.equal(result.next_action, `call workbench_repair_delegation with delegation_id=${ID}`);
		assert.equal(repairs, 0);
	}
});

test("an exact service failure consumes the one automatic attempt and is never retried", async () => {
	let repairs = 0;
	const failed: ExactRepairServiceResultV1 = {
		status: "EXECUTION_FAILED",
		repair_of: ID,
		authority: exactAuthority("semantic-repair"),
		execution_attempted: true,
		error: "injected",
		successor_readback: { status: "none" },
	};
	const result = await coordinateDeliveryChainV1(input(), {
		review: async () => durableReview("REPAIR"),
		confirmParentSettled: async () => settledAuthority(),
		repair: async () => { repairs += 1; return failed; },
	});
	assert.equal(result.status, "REPAIR_PENDING");
	assert.equal(result.successor_attempts_used, 1);
	assert.equal(repairs, 1);
});

test("strict child disposition controls the retry route without trusting raw transaction status", async () => {
	for (const entry of [
		{ result: strictDisposition("SUCCESSOR_ACTIVE", "ACTIVE"), next: "call workbench_delegation_status" },
		{ result: strictDisposition("EXACT_REPAIR_PENDING", "EXACT_REPAIR_PENDING"), next: `call workbench_repair_delegation with delegation_id=${CHILD}` },
		{ result: strictDisposition("SUCCESSOR_BLOCKED", "BLOCKED"), next: "call workbench_delegation_status" },
	] as const) {
		const result = await coordinateDeliveryChainV1(input(), {
			review: async () => durableReview("REPAIR"),
			confirmParentSettled: async () => settledAuthority(),
			repair: async () => entry.result,
		});
		assert.equal(result.status, "REPAIR_PENDING");
		assert.equal(result.next_action, entry.next);
		assert.equal(result.successor_attempts_used, 1);
	}
});

test("runtime-invalid successor limit fails before review, settled-authority confirmation, or repair", async () => {
	let calls = 0;
	const malformed = { ...input(), max_successor_attempts: 2 } as unknown as DeliveryChainCoordinatorInputV1;
	const result = await coordinateDeliveryChainV1(malformed, {
		review: async () => { calls += 1; return durableReview("REPAIR"); },
		confirmParentSettled: async () => { calls += 1; return settledAuthority(); },
		repair: async () => { calls += 1; return recorded("semantic-repair"); },
	});
	assert.equal(result.status, "AUTHORITY_ERROR");
	if (result.status === "AUTHORITY_ERROR") assert.equal(result.code, "INVALID_MAX_SUCCESSOR_ATTEMPTS");
	assert.equal(calls, 0);
});
