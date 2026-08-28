import assert from "node:assert/strict";
import test from "node:test";

import {
	createAutomaticDeliveryContinuationLifecycleV1,
	type AutomaticDeliveryContinuationCandidateV1,
	type AutomaticDeliveryContinuationGateFactsV1,
	type AutomaticDeliveryContinuationLifecycleDependenciesV1,
	type AutomaticDeliveryContinuationLifecycleResultV1,
} from "../extensions/workbench-runtime/core/automatic-delivery-continuation-lifecycle.ts";
import {
	DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
	type DeliveryChainCoordinatorResultV1,
} from "../extensions/workbench-runtime/core/delivery-chain-coordinator.ts";

const ROOT = "/project";
const ID = "20260827-010203-root";
const OTHER_ID = "20260827-010204-next";
const CHILD = "20260827-010205-chld";
const AUTHORITY_HASH = "a".repeat(64);
const POST_REVIEW_AUTHORITY_HASH = "8".repeat(64);
const BOUND_DIFF_HASH = "b".repeat(64);
const PATH_AUTHORITY_HASH = "c".repeat(64);

let symbolCounter = 0;
function isolatedSymbol(): symbol {
	symbolCounter += 1;
	return Symbol.for(`pi.workbench.automatic-delivery-continuation-lifecycle.test.${symbolCounter}`);
}

function resultCode(result: AutomaticDeliveryContinuationLifecycleResultV1): string | undefined {
	return "code" in result ? result.code : undefined;
}

function gateFacts(
	overrides: Partial<AutomaticDeliveryContinuationGateFactsV1> = {},
): AutomaticDeliveryContinuationGateFactsV1 {
	return {
		schema_version: 1,
		mode: "DEV",
		trusted: true,
		runtime_current: true,
		commander_provider: "openai-codex",
		commander_model: "gpt-5.6-sol",
		aborted: false,
		has_pending_messages: false,
		compaction_pending: false,
		...overrides,
	};
}

function candidate(
	overrides: Partial<AutomaticDeliveryContinuationCandidateV1> = {},
): AutomaticDeliveryContinuationCandidateV1 {
	return {
		schema_version: 1,
		project_root: ROOT,
		delegation_id: ID,
		authority_hash: AUTHORITY_HASH,
		bound_diff_hash: BOUND_DIFF_HASH,
		affected_paths: ["src/**"],
		lineage_depth: 0,
		review_authority: "DURABLE_REPAIR_SIDECAR",
		sidecar_kind: "semantic-repair",
		durable_decision: "REPAIR",
		strict_sidecar: true,
		terminal_status: null,
		unique_unresolved_tip: true,
		path_admission: "ALLOW",
		path_admission_authority_hash: PATH_AUTHORITY_HASH,
		...overrides,
	};
}

function settled(value = candidate()) {
	return {
		ok: true as const,
		value: {
			schema_version: 1 as const,
			project_root: value.project_root,
			delegation_id: value.delegation_id,
			authority_hash: value.authority_hash,
			bound_diff_hash: value.bound_diff_hash,
			lineage_depth: 0 as const,
			authority_confirmed: true as const,
			no_active_lane: true as const,
		},
	};
}

function successorRecorded(delegationId = ID): DeliveryChainCoordinatorResultV1 {
	return {
		status: "SUCCESSOR_RECORDED",
		delegation_id: delegationId,
		max_successor_attempts: DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
		successor_attempts_used: 1,
		review: {} as never,
		repair: {
			status: "SUCCESSOR_RECORDED",
			repair_of: delegationId,
			authority: {} as never,
			successor: {
				delegation_id: CHILD,
				status: "PENDING_REVIEW",
				contract_hash: "d".repeat(64),
				transaction_hash: "e".repeat(64),
				committed_proof_content_hash: "f".repeat(64),
				disposition: "REVIEW_PENDING",
			},
			replayed: false,
			execution_attempted: true,
			execution_outcome: "returned",
		},
	};
}

function repairPending(delegationId = ID): DeliveryChainCoordinatorResultV1 {
	return {
		status: "REPAIR_PENDING",
		code: "PARENT_OPERATION_NOT_SETTLED",
		delegation_id: delegationId,
		max_successor_attempts: DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
		successor_attempts_used: 0,
		review: {} as never,
		next_action: `call workbench_repair_delegation with delegation_id=${delegationId}`,
	};
}

function attemptedRepairPending(delegationId = ID): DeliveryChainCoordinatorResultV1 {
	return {
		status: "REPAIR_PENDING",
		code: "EXACT_REPAIR_SERVICE_FAILED",
		delegation_id: delegationId,
		max_successor_attempts: DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
		successor_attempts_used: 1,
		review: {} as never,
		next_action: `call workbench_repair_delegation with delegation_id=${delegationId}`,
	};
}

function reviewRetryable(delegationId = ID): DeliveryChainCoordinatorResultV1 {
	return {
		status: "REVIEW_RETRYABLE",
		delegation_id: delegationId,
		max_successor_attempts: DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
		successor_attempts_used: 0,
		review: {} as never,
		next_action: `call workbench_review_worker_diff with delegation_id=${delegationId}`,
	};
}

function authorityError(delegationId = ID): DeliveryChainCoordinatorResultV1 {
	return {
		status: "AUTHORITY_ERROR",
		code: "REVIEW_RESULT_INVALID",
		delegation_id: delegationId,
		max_successor_attempts: DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
		successor_attempts_used: 0,
		next_action: `call workbench_review_worker_diff with delegation_id=${delegationId}`,
	};
}

function runResult(
	chain: DeliveryChainCoordinatorResultV1,
	authorityHash = AUTHORITY_HASH,
) {
	return { authority_hash: authorityHash, chain };
}

function dependencies(
	overrides: Partial<AutomaticDeliveryContinuationLifecycleDependenciesV1> = {},
): AutomaticDeliveryContinuationLifecycleDependenciesV1 {
	const currentCandidate = candidate();
	return {
		canonicalProjectRoot: async () => ROOT,
		reconcile: async () => ({ ok: true }),
		checkGates: async () => ({ ok: true, value: gateFacts() }),
		resolveCandidate: async () => ({ status: "CANDIDATE", candidate: currentCandidate }),
		confirmSettled: async () => settled(currentCandidate),
		runChain: async () => runResult(successorRecorded()),
		processStateSymbol: isolatedSymbol(),
		...overrides,
	};
}

test("tool_execution_end accepts only a bounded delegate machine-details locator", async () => {
	let durableCalls = 0;
	const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
		reconcile: async () => { durableCalls += 1; return { ok: true }; },
	}));

	assert.deepEqual(lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_run_recipe",
		machine_details: { delegation_id: ID },
	}), { status: "IGNORED", code: "NOT_DELEGATE_TOOL" });
	assert.deepEqual(lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker",
		machine_details: undefined,
	}), { status: "IGNORED", code: "INVALID_MACHINE_DETAILS" });

	let getterCalls = 0;
	const accessorDetails = Object.defineProperty({}, "delegation_id", {
		enumerable: true,
		get() { getterCalls += 1; return ID; },
	});
	assert.equal(lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker",
		machine_details: accessorDetails,
	}).status, "IGNORED");
	assert.equal(getterCalls, 0, "locator parsing never invokes an accessor");

	const proxy = new Proxy({}, { ownKeys() { throw new Error("must not inspect"); } });
	assert.equal(lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker",
		machine_details: proxy,
	}).status, "IGNORED");

	const oversized: Record<string, unknown> = { delegation_id: ID };
	for (let index = 0; index < 40; index += 1) oversized[`field_${index}`] = index;
	assert.equal(lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker",
		machine_details: oversized,
	}).status, "IGNORED");

	assert.deepEqual(lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker",
		machine_details: { delegation_id: ID, status: "untrusted-event-status" },
	}), { status: "RECORDED", delegation_id: ID });
	assert.equal(durableCalls, 0, "tool_execution_end stores a locator and performs no durable action");
});

test("agent_settled reconciles then rebuilds strict authority and runs one depth-zero chain", async () => {
	const order: string[] = [];
	let chainCalls = 0;
	const currentCandidate = candidate();
	const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
		reconcile: async (input) => {
			order.push("reconcile");
			assert.deepEqual(input, {
				project_root: ROOT,
				trigger: "agent_settled",
				locator_delegation_ids: [ID],
				runtime_context: undefined,
			});
			return { ok: true };
		},
		checkGates: async () => { order.push("gates"); return { ok: true, value: gateFacts() }; },
		resolveCandidate: async (input) => {
			order.push("resolve");
			assert.deepEqual(input, {
				project_root: ROOT,
				trigger: "agent_settled",
				locator_delegation_ids: [ID],
				require_unique_unresolved_tip: true,
				require_strict_repair_sidecar: true,
				require_full_path_admission: true,
				allow_exact_terminal_needs_review: true,
			});
			return { status: "CANDIDATE", candidate: currentCandidate };
		},
		confirmSettled: async (input) => {
			order.push("confirm");
			assert.deepEqual(input, {
				project_root: ROOT,
				delegation_id: ID,
				expected_authority_hash: AUTHORITY_HASH,
				expected_bound_diff_hash: BOUND_DIFF_HASH,
				required_lineage_depth: 0,
			});
			return settled(currentCandidate);
		},
		runChain: async (input) => {
			order.push("chain");
			chainCalls += 1;
			assert.equal(input.max_successor_attempts, 1);
			assert.equal(input.candidate.delegation_id, ID);
			assert.equal(input.settled_authority.no_active_lane, true);
			return runResult(successorRecorded());
		},
	}));
	lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker",
		machine_details: { delegation_id: ID, status: "failure", review_status: "whatever" },
	});
	const result = await lifecycle.onAgentSettled();
	assert.equal(result.status, "CHAIN_RESULT");
	assert.deepEqual(order, ["reconcile", "gates", "resolve", "confirm", "chain"]);
	assert.equal(chainCalls, 1, "one parent authority can start at most one child chain");
	assert.deepEqual(await lifecycle.onAgentSettled(), {
		trigger: "agent_settled", status: "NOOP", code: "NO_TOOL_LOCATOR",
	});
});

test("reload is only marked at session start and a historical candidate without a sidecar is NOOP", async () => {
	let resolves = 0;
	let chains = 0;
	const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
		resolveCandidate: async (input) => {
			resolves += 1;
			assert.equal(input.trigger, "before_agent_start");
			assert.deepEqual(input.locator_delegation_ids, [], "reload performs a strict unique-tip scan without session latest");
			return { status: "NOOP", code: "NO_DURABLE_REPAIR_SIDECAR" };
		},
		runChain: async () => { chains += 1; return runResult(successorRecorded()); },
	}));
	assert.deepEqual(await lifecycle.onBeforeAgentStart(), {
		trigger: "before_agent_start", status: "NOOP", code: "NO_RELOAD_PENDING",
	});
	lifecycle.markReloadPending();
	assert.deepEqual(await lifecycle.onBeforeAgentStart(), {
		trigger: "before_agent_start", status: "NOOP", code: "NO_DURABLE_REPAIR_SIDECAR",
	});
	assert.deepEqual({ resolves, chains }, { resolves: 1, chains: 0 });
	assert.equal(resultCode(await lifecycle.onBeforeAgentStart()), "NO_RELOAD_PENDING");
});

test("an exact agent_settled terminal locator may review eligible FAILED or INTERRUPTED without a sidecar", async () => {
	for (const terminalStatus of ["FAILED", "INTERRUPTED"] as const) {
		let confirms = 0;
		let chains = 0;
		const needsReview = candidate({
			review_authority: "ELIGIBLE_TERMINAL_NEEDS_REVIEW",
			sidecar_kind: "none",
			durable_decision: "NEEDS_REVIEW",
			strict_sidecar: false,
			terminal_status: terminalStatus,
		});
		const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
			resolveCandidate: async (input) => {
				assert.deepEqual(input.locator_delegation_ids, [ID]);
				assert.equal(input.allow_exact_terminal_needs_review, true);
				return { status: "CANDIDATE", candidate: needsReview };
			},
			confirmSettled: async () => { confirms += 1; return settled(needsReview); },
			runChain: async (input) => {
				chains += 1;
				assert.equal(input.candidate.review_authority, "ELIGIBLE_TERMINAL_NEEDS_REVIEW");
				assert.equal(input.candidate.terminal_status, terminalStatus);
				return runResult(successorRecorded(), POST_REVIEW_AUTHORITY_HASH);
			},
		}));
		lifecycle.observeToolExecutionEnd({
			tool_name: "workbench_delegate_worker", machine_details: { delegation_id: ID },
		});
		assert.equal((await lifecycle.onAgentSettled()).status, "CHAIN_RESULT");
		assert.deepEqual({ confirms, chains }, { confirms: 1, chains: 1 });
	}
});

test("reload never guesses an eligible terminal without a durable sidecar", async () => {
	let confirms = 0;
	let chains = 0;
	const needsReview = candidate({
		review_authority: "ELIGIBLE_TERMINAL_NEEDS_REVIEW",
		sidecar_kind: "none",
		durable_decision: "NEEDS_REVIEW",
		strict_sidecar: false,
		terminal_status: "INTERRUPTED",
	});
	const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
		resolveCandidate: async (input) => {
			assert.deepEqual(input.locator_delegation_ids, []);
			assert.equal(input.allow_exact_terminal_needs_review, false);
			return { status: "CANDIDATE", candidate: needsReview };
		},
		confirmSettled: async () => { confirms += 1; return settled(needsReview); },
		runChain: async () => { chains += 1; return runResult(successorRecorded()); },
	}));
	lifecycle.markReloadPending();
	const result = await lifecycle.onBeforeAgentStart();
	assert.equal(result.status, "NOOP");
	assert.equal(result.code, "NO_DURABLE_REPAIR_SIDECAR");
	assert.deepEqual({ confirms, chains }, { confirms: 0, chains: 0 });
});

test("depth-one and deeper lineage tips never create a third automatic attempt", async () => {
	for (const lineageDepth of [1, 2, 99]) {
		let confirms = 0;
		let chains = 0;
		const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
			resolveCandidate: async () => ({
				status: "CANDIDATE",
				candidate: candidate({ lineage_depth: lineageDepth }),
			}),
			confirmSettled: async () => { confirms += 1; return settled(); },
			runChain: async () => { chains += 1; return runResult(successorRecorded()); },
		}));
		lifecycle.markReloadPending();
		const result = await lifecycle.onBeforeAgentStart();
		assert.equal(result.status, "NOOP");
		assert.equal(result.code, "LINEAGE_DEPTH_LIMIT");
		assert.deepEqual({ confirms, chains }, { confirms: 0, chains: 0 });
	}
});

test("DEV, trust, runtime, Sol, queue and compaction gates all fail closed through the seam", async () => {
	for (const gateCode of [
		"MODE_NOT_DEV", "UNTRUSTED", "RUNTIME_NOT_CURRENT", "MODEL_NOT_SOL",
		"PENDING_MESSAGES", "COMPACTION_PENDING",
	]) {
		let ready = false;
		let resolves = 0;
		const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
			checkGates: async () => ready
				? { ok: true, value: gateFacts() }
				: { ok: false, code: gateCode },
			resolveCandidate: async () => {
				resolves += 1;
				return { status: "CANDIDATE", candidate: candidate() };
			},
		}));
		lifecycle.observeToolExecutionEnd({
			tool_name: "workbench_delegate_worker", machine_details: { delegation_id: ID },
		});
		const deferred = await lifecycle.onAgentSettled();
		assert.equal(deferred.status, "DEFER");
		assert.equal(deferred.code, "GATE_NOT_READY");
		if (deferred.status === "DEFER") assert.equal(deferred.detail_code, gateCode);
		assert.equal(resolves, 0);
		ready = true;
		assert.equal((await lifecycle.onAgentSettled()).status, "CHAIN_RESULT", "a transient gate keeps the locator pending");
	}

	const controller = new AbortController();
	controller.abort();
	let resolves = 0;
	const aborted = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
		resolveCandidate: async () => { resolves += 1; return { status: "CANDIDATE", candidate: candidate() }; },
	}));
	aborted.markReloadPending();
	const result = await aborted.onBeforeAgentStart({ signal: controller.signal });
	assert.equal(result.status, "DEFER");
	assert.equal(result.code, "ABORTED");
	assert.equal(resolves, 0);

	const malformed = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
		checkGates: async () => ({ ok: true, value: { ...gateFacts(), trusted: false } as never }),
	}));
	malformed.markReloadPending();
	assert.equal(resultCode(await malformed.onBeforeAgentStart()), "GATE_RESULT_INVALID");
});

test("reconciliation and a strict no-active-lane proof are mandatory before runChain", async () => {
	let reconciled = false;
	let parentSettled = false;
	let chainCalls = 0;
	const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
		reconcile: async () => reconciled ? { ok: true } : { ok: false, code: "RECOVERY_PENDING" },
		confirmSettled: async () => parentSettled ? settled() : { ok: false, code: "LIVE_PARENT_LANE" },
		runChain: async () => { chainCalls += 1; return runResult(successorRecorded()); },
	}));
	lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker", machine_details: { delegation_id: ID },
	});
	assert.equal(resultCode(await lifecycle.onAgentSettled()), "RECONCILE_FAILED");
	assert.equal(chainCalls, 0);
	reconciled = true;
	assert.equal(resultCode(await lifecycle.onAgentSettled()), "PARENT_NOT_SETTLED");
	assert.equal(chainCalls, 0, "the lifecycle never executes or releases inside a live parent lane");
	parentSettled = true;
	assert.equal((await lifecycle.onAgentSettled()).status, "CHAIN_RESULT");
	assert.equal(chainCalls, 1);

	let mismatchedCalls = 0;
	const mismatch = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
		confirmSettled: async () => ({
			...settled(),
			value: { ...settled().value, authority_hash: "9".repeat(64) },
		}),
		runChain: async () => { mismatchedCalls += 1; return runResult(successorRecorded()); },
	}));
	mismatch.markReloadPending();
	assert.equal(resultCode(await mismatch.onBeforeAgentStart()), "PARENT_SETTLED_AUTHORITY_INVALID");
	assert.equal(mismatchedCalls, 0);
});

test("locator mismatch and malformed path authority block without trusting session or tool status", async () => {
	for (const resolvedCandidate of [
		candidate({ delegation_id: OTHER_ID }),
		{ ...candidate(), path_admission: "DENY" } as unknown as AutomaticDeliveryContinuationCandidateV1,
	]) {
		let confirms = 0;
		let chains = 0;
		const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
			resolveCandidate: async () => ({ status: "CANDIDATE", candidate: resolvedCandidate }),
			confirmSettled: async () => { confirms += 1; return settled(); },
			runChain: async () => { chains += 1; return runResult(successorRecorded()); },
		}));
		lifecycle.observeToolExecutionEnd({
			tool_name: "workbench_delegate_worker",
			machine_details: { delegation_id: ID, status: "success", review_status: "REVIEWED" },
		});
		const result = await lifecycle.onAgentSettled();
		assert.equal(result.status, "BLOCKED");
		assert.ok(result.code === "LOCATOR_AUTHORITY_MISMATCH" || result.code === "CANDIDATE_AUTHORITY_INVALID");
		assert.deepEqual({ confirms, chains }, { confirms: 0, chains: 0 });
	}
});

test("Symbol.for state gives joiners a non-actionable defer and preserves the owner's runtime context", async () => {
	const stateSymbol = isolatedSymbol();
	let reconciles = 0;
	let resolves = 0;
	let confirms = 0;
	let chains = 0;
	let releaseChain!: () => void;
	let chainEntered!: () => void;
	const ownerContext = { owner: true };
	const joinerContext = { owner: false };
	let chainContext: unknown;
	const entered = new Promise<void>((resolve) => { chainEntered = resolve; });
	const blocked = new Promise<void>((resolve) => { releaseChain = resolve; });
	const shared = dependencies({
		processStateSymbol: stateSymbol,
		reconcile: async () => { reconciles += 1; return { ok: true }; },
		resolveCandidate: async () => { resolves += 1; return { status: "CANDIDATE", candidate: candidate() }; },
		confirmSettled: async () => { confirms += 1; return settled(); },
		runChain: async (input) => {
			chains += 1;
			chainContext = input.runtime_context;
			chainEntered();
			await blocked;
			return runResult(successorRecorded());
		},
	});
	const fromTool = createAutomaticDeliveryContinuationLifecycleV1(shared);
	const fromReload = createAutomaticDeliveryContinuationLifecycleV1(shared);
	fromTool.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker", machine_details: { delegation_id: ID },
	});
	fromReload.markReloadPending();
	const first = fromTool.onAgentSettled({ runtime_context: ownerContext });
	await entered;
	const second = fromReload.onBeforeAgentStart({ runtime_context: joinerContext });
	releaseChain();
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.equal(firstResult.status, "CHAIN_RESULT");
	assert.deepEqual(secondResult, {
		trigger: "before_agent_start", status: "DEFER", code: "ROOT_CONTINUATION_IN_FLIGHT",
	});
	assert.equal(chainContext, ownerContext, "the joiner's context never replaces the owner's side-effect context");
	assert.deepEqual({ reconciles, resolves, confirms, chains }, { reconciles: 1, resolves: 1, confirms: 1, chains: 1 });

	const afterReload = createAutomaticDeliveryContinuationLifecycleV1(shared);
	afterReload.markReloadPending();
	const repeated = await afterReload.onBeforeAgentStart();
	assert.equal(repeated.status, "CHAIN_RESULT");
	assert.deepEqual({ reconciles, resolves, confirms, chains }, { reconciles: 2, resolves: 2, confirms: 2, chains: 2 });
});

test("a lost response or attempts-zero retry is single-attempt per session epoch", async () => {
	const stateSymbol = isolatedSymbol();
	let calls = 0;
	const shared = dependencies({
		processStateSymbol: stateSymbol,
		runChain: async (input) => {
			calls += 1;
			assert.equal(input.max_successor_attempts, 1);
			if (calls === 1) throw new Error("lost response");
			if (calls === 2) return runResult(repairPending());
			return runResult(successorRecorded());
		},
	});
	const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(shared);
	lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker", machine_details: { delegation_id: ID },
	});
	assert.equal(resultCode(await lifecycle.onAgentSettled()), "CHAIN_FAILED");
	assert.equal(resultCode(await lifecycle.onAgentSettled()), "AUTHORITY_ALREADY_CONTINUED");
	assert.equal(calls, 1, "same-epoch hooks never repeat an expensive review after lost response");
	assert.equal(resultCode(await lifecycle.onAgentSettled()), "NO_TOOL_LOCATOR");

	const epochTwo = createAutomaticDeliveryContinuationLifecycleV1(shared);
	epochTwo.markReloadPending();
	const pending = await epochTwo.onBeforeAgentStart();
	assert.equal(pending.status, "CHAIN_RESULT");
	if (pending.status === "CHAIN_RESULT") assert.equal(pending.chain.status, "REPAIR_PENDING");
	assert.equal(calls, 2);
	assert.equal(resultCode(await epochTwo.onBeforeAgentStart()), "AUTHORITY_ALREADY_CONTINUED");

	const epochThree = createAutomaticDeliveryContinuationLifecycleV1(shared);
	epochThree.markReloadPending();
	assert.equal((await epochThree.onBeforeAgentStart()).status, "CHAIN_RESULT");
	assert.equal(calls, 3, "a new session epoch may perform one strict idempotent replay");
});

test("review retry never hot-loops and a new session epoch may retry once", async () => {
	const stateSymbol = isolatedSymbol();
	let calls = 0;
	const shared = dependencies({
		processStateSymbol: stateSymbol,
		runChain: async () => {
			calls += 1;
			return runResult(calls === 1 ? reviewRetryable() : authorityError());
		},
	});
	const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(shared);
	lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker", machine_details: { delegation_id: ID },
	});
	const retry = await lifecycle.onAgentSettled();
	assert.equal(retry.status, "CHAIN_RESULT");
	if (retry.status === "CHAIN_RESULT") assert.equal(retry.chain.status, "REVIEW_RETRYABLE");
	const sameEpoch = await lifecycle.onAgentSettled();
	assert.equal(resultCode(sameEpoch), "AUTHORITY_ALREADY_CONTINUED");
	assert.equal(calls, 1);

	const reloaded = createAutomaticDeliveryContinuationLifecycleV1(shared);
	reloaded.markReloadPending();
	const invalid = await reloaded.onBeforeAgentStart();
	assert.equal(invalid.status, "CHAIN_RESULT");
	if (invalid.status === "CHAIN_RESULT") assert.equal(invalid.chain.status, "AUTHORITY_ERROR");
	assert.equal(calls, 2);
});

test("attempts-used authority does not hot-loop but a reload epoch permits one strict replay", async () => {
	const stateSymbol = isolatedSymbol();
	let chains = 0;
	const shared = dependencies({
		processStateSymbol: stateSymbol,
		runChain: async () => {
			chains += 1;
			return runResult(chains === 1 ? attemptedRepairPending() : successorRecorded());
		},
	});
	const fromTool = createAutomaticDeliveryContinuationLifecycleV1(shared);
	fromTool.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker", machine_details: { delegation_id: ID },
	});
	const attempted = await fromTool.onAgentSettled();
	assert.equal(attempted.status, "CHAIN_RESULT");
	if (attempted.status === "CHAIN_RESULT") {
		assert.equal(attempted.chain.status, "REPAIR_PENDING");
		assert.equal(attempted.chain.successor_attempts_used, 1);
	}
	assert.equal(resultCode(await fromTool.onAgentSettled()), "NO_TOOL_LOCATOR");
	fromTool.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker", machine_details: { delegation_id: ID },
	});
	assert.equal(resultCode(await fromTool.onAgentSettled()), "AUTHORITY_ALREADY_CONTINUED");
	assert.equal(chains, 1, "same-epoch callbacks cannot retry attempts_used=1");

	const fromReload = createAutomaticDeliveryContinuationLifecycleV1(shared);
	fromReload.markReloadPending();
	assert.equal((await fromReload.onBeforeAgentStart()).status, "CHAIN_RESULT");
	assert.equal(chains, 2, "new session epoch permits one exact-service replay under the same hash");
});

test("multiple delegate locators are byte-ordered and the strict resolver selects one eligible tip", async () => {
	let chains = 0;
	const eligible = candidate({ delegation_id: OTHER_ID });
	const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
		resolveCandidate: async (input) => {
			assert.deepEqual(input.locator_delegation_ids, [ID, OTHER_ID]);
			return { status: "CANDIDATE", candidate: eligible };
		},
		confirmSettled: async () => settled(eligible),
		runChain: async () => { chains += 1; return runResult(successorRecorded(OTHER_ID)); },
	}));
	assert.equal(lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker", machine_details: { delegation_id: OTHER_ID },
	}).status, "RECORDED");
	assert.equal(lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker", machine_details: { delegation_id: ID },
	}).status, "RECORDED");
	assert.equal((await lifecycle.onAgentSettled()).status, "CHAIN_RESULT");
	assert.equal(chains, 1);
	assert.equal(resultCode(await lifecycle.onAgentSettled()), "NO_TOOL_LOCATOR");
});

test("tool locator set overflow blocks without consulting durable authority", async () => {
	let calls = 0;
	const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(dependencies({
		reconcile: async () => { calls += 1; return { ok: true }; },
	}));
	for (let index = 0; index < 8; index += 1) {
		assert.equal(lifecycle.observeToolExecutionEnd({
			tool_name: "workbench_delegate_worker",
			machine_details: { delegation_id: `20260827-02020${index}-${String(index).padStart(4, "0")}` },
		}).status, "RECORDED");
	}
	assert.deepEqual(lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker",
		machine_details: { delegation_id: "20260827-020208-0008" },
	}), { status: "BLOCKED", code: "TOOL_LOCATOR_OVERFLOW" });
	assert.deepEqual(await lifecycle.onAgentSettled(), {
		trigger: "agent_settled", status: "BLOCKED", code: "TOOL_LOCATOR_OVERFLOW",
	});
	assert.equal(calls, 0);
	assert.equal(lifecycle.hasPendingBeforeAgentContinuation(), true, "overflow never erases the bounded locator evidence");
});

test("claim-guard suppression reports reload, locator and overflow pending state", async () => {
	const lifecycle = createAutomaticDeliveryContinuationLifecycleV1(dependencies());
	assert.equal(lifecycle.hasPendingBeforeAgentContinuation(), false);
	lifecycle.markReloadPending();
	assert.equal(lifecycle.hasPendingBeforeAgentContinuation(), true);
	assert.equal((await lifecycle.onBeforeAgentStart()).status, "CHAIN_RESULT");
	assert.equal(lifecycle.hasPendingBeforeAgentContinuation(), false);

	assert.equal(lifecycle.observeToolExecutionEnd({
		tool_name: "workbench_delegate_worker", machine_details: { delegation_id: ID },
	}).status, "RECORDED");
	assert.equal(lifecycle.hasPendingBeforeAgentContinuation(), true);
	assert.equal((await lifecycle.onAgentSettled()).status, "NOOP", "the same epoch is already attempted");
	assert.equal(lifecycle.hasPendingBeforeAgentContinuation(), false);

	for (let index = 0; index < 9; index += 1) {
		lifecycle.observeToolExecutionEnd({
			tool_name: "workbench_delegate_worker",
			machine_details: { delegation_id: `20260827-03030${index}-${String(index).padStart(4, "0")}` },
		});
	}
	assert.equal(lifecycle.hasPendingBeforeAgentContinuation(), true);
	assert.equal(resultCode(await lifecycle.onAgentSettled()), "TOOL_LOCATOR_OVERFLOW");
	assert.equal(lifecycle.hasPendingBeforeAgentContinuation(), true);
});
