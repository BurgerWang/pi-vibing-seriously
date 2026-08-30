import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	AUTOMATIC_DELIVERY_CONTINUATION_RECOVERY_SESSION_REASONS_V1,
	createAutomaticDeliveryContinuationRuntimeControllerV1,
	type AutomaticDeliveryContinuationRuntimeControllerDependenciesV1,
} from "../extensions/workbench-runtime/core/automatic-delivery-continuation-runtime-controller.ts";
import {
	AUTOMATIC_DELIVERY_CONTINUATION_METADATA_LANE_V1,
} from "../extensions/workbench-runtime/core/automatic-delivery-continuation-authority.ts";
import type {
	AutomaticDeliveryContinuationCandidateV1,
	AutomaticDeliveryContinuationResolveInputV1,
} from "../extensions/workbench-runtime/core/automatic-delivery-continuation-lifecycle.ts";
import type { AutomaticSemanticReviewResult } from "../extensions/workbench-runtime/core/automatic-semantic-review-service.ts";
import type { ExactRepairServiceResultV1 } from "../extensions/workbench-runtime/core/exact-repair-service.ts";
import type { ExactRepairExistingSuccessorV1 } from "../extensions/workbench-runtime/core/exact-repair-successor.ts";
import type { DelegationTransactionStatus } from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import type { ProjectCheckoutOperationLeaseV1 } from "../extensions/workbench-runtime/core/project-checkout-operation.ts";

const ROOT = "/project";
const ID = "20260827-010203-root";
const OTHER_ID = "20260827-010204-next";
const CHILD = "20260827-010205-chld";
const OLD_AUTHORITY = "a".repeat(64);
const NEW_AUTHORITY = "8".repeat(64);
const BOUND = "b".repeat(64);
const PATH_AUTHORITY = "c".repeat(64);

let symbolCounter = 0;
function isolatedSymbol(): symbol {
	symbolCounter += 1;
	return Symbol.for(`pi.workbench.automatic-delivery-continuation-runtime.test.${symbolCounter}`);
}

const zeroUsage = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

type EventHandler = (event: never, ctx: never) => unknown;

class FakePi {
	readonly handlers = new Map<string, EventHandler[]>();
	readonly sent: Array<{
		message: { customType: string; content: string; display: boolean; details: Record<string, unknown> };
		options: { deliverAs?: string; triggerTurn?: boolean } | undefined;
	}> = [];

	on(event: string, handler: EventHandler): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	sendMessage(message: never, options?: never): void {
		this.sent.push({ message, options });
	}

	async emit(event: string, value: unknown, ctx: ExtensionContext): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.handlers.get(event) ?? []) results.push(await handler(value as never, ctx as never));
		return results;
	}
}

function context(overrides: {
	pending?: boolean;
	trusted?: boolean;
	provider?: string;
	model?: string;
	signal?: AbortSignal;
} = {}): ExtensionContext {
	return {
		cwd: ROOT,
		modelRegistry: {},
		model: {
			provider: overrides.provider ?? "openai-codex",
			id: overrides.model ?? "gpt-5.6-sol",
		},
		signal: overrides.signal,
		isProjectTrusted: () => overrides.trusted ?? true,
		hasPendingMessages: () => overrides.pending ?? false,
	} as unknown as ExtensionContext;
}

function candidate(
	overrides: Partial<AutomaticDeliveryContinuationCandidateV1> = {},
): AutomaticDeliveryContinuationCandidateV1 {
	return {
		schema_version: 1,
		project_root: ROOT,
		delegation_id: ID,
		authority_hash: OLD_AUTHORITY,
		bound_diff_hash: BOUND,
		affected_paths: ["src/**"],
		lineage_depth: 0,
		review_authority: "DURABLE_REPAIR_SIDECAR",
		sidecar_kind: "semantic-repair",
		durable_decision: "REPAIR",
		strict_sidecar: true,
		terminal_status: null,
		unique_unresolved_tip: true,
		path_admission: "ALLOW",
		path_admission_authority_hash: PATH_AUTHORITY,
		...overrides,
	};
}

function needsReview(): AutomaticDeliveryContinuationCandidateV1 {
	return candidate({
		review_authority: "ELIGIBLE_TERMINAL_NEEDS_REVIEW",
		sidecar_kind: "none",
		durable_decision: "NEEDS_REVIEW",
		strict_sidecar: false,
		terminal_status: "FAILED",
	});
}

function durableTerminalRepair(): AutomaticDeliveryContinuationCandidateV1 {
	return candidate({
		authority_hash: NEW_AUTHORITY,
		sidecar_kind: "terminal-negative-repair",
	});
}

function repairReview(delegationId = ID): AutomaticSemanticReviewResult {
	return {
		status: "REPAIR",
		delegation_id: delegationId,
		bound_diff_hash: BOUND,
		durable: true,
		replayed: false,
		nested_usage: zeroUsage,
		mechanical_page_calls: 1,
		next_action: `call workbench_repair_delegation with delegation_id=${delegationId}`,
	};
}

function recordedSuccessor(
	status: DelegationTransactionStatus,
	options: {
		replayed?: boolean;
		disposition?: ExactRepairExistingSuccessorV1["disposition"];
		serviceStatus?: "SUCCESSOR_RECORDED" | "SUCCESSOR_ACTIVE" | "EXACT_REPAIR_PENDING" | "SUCCESSOR_BLOCKED";
		executionAttempted?: boolean;
		executionOutcome?: "not_started" | "returned" | "threw";
		executionStatus?: "completed" | "refused";
	} = {},
): ExactRepairServiceResultV1 {
	const replayed = options.replayed ?? false;
	const common = {
		repair_of: ID,
		authority: {} as never,
		successor: {
			delegation_id: CHILD,
			status,
			contract_hash: "d".repeat(64),
			transaction_hash: "e".repeat(64),
			committed_proof_content_hash: status === "PREPARED" ? null : "f".repeat(64),
			disposition: options.disposition ?? "REVIEW_PENDING",
		},
		replayed,
		execution_attempted: options.executionAttempted ?? !replayed,
		execution_outcome: options.executionOutcome ?? (replayed ? "not_started" : "returned"),
	} as const;
	switch (options.serviceStatus) {
		case "SUCCESSOR_ACTIVE": return { status: "SUCCESSOR_ACTIVE", ...common };
		case "EXACT_REPAIR_PENDING": return { status: "EXACT_REPAIR_PENDING", ...common };
		case "SUCCESSOR_BLOCKED": return { status: "SUCCESSOR_BLOCKED", ...common };
		default: return {
			status: "SUCCESSOR_RECORDED",
			...common,
			execution_status: options.executionStatus ?? (replayed ? undefined : "completed"),
		};
	}
}

function lease(projectRoot = ROOT): ProjectCheckoutOperationLeaseV1 {
	return {
		schema_version: 1,
		project_root: projectRoot,
		operation_kind: "command",
		operation_id: "command:auto-delivery-review:test",
		delegation_id: "20260827-010206-lane",
		token: "1".repeat(32),
		mode: "exclusive",
		start_lock_lease: {} as never,
	};
}

function guardLease(delegationId: string): ProjectCheckoutOperationLeaseV1 {
	return {
		...lease(),
		operation_kind: "delegation",
		operation_id: `delegation:${delegationId}`,
		delegation_id: delegationId,
	};
}

interface HarnessOptions {
	initialCandidate?: AutomaticDeliveryContinuationCandidateV1;
	successorStatus?: DelegationTransactionStatus;
	successorDisposition?: ExactRepairExistingSuccessorV1["disposition"];
	successorServiceStatus?: "SUCCESSOR_RECORDED" | "SUCCESSOR_ACTIVE" | "EXACT_REPAIR_PENDING" | "SUCCESSOR_BLOCKED";
	pending?: () => boolean;
	compaction?: () => boolean;
	resolve?: (
		input: AutomaticDeliveryContinuationResolveInputV1,
		current: AutomaticDeliveryContinuationCandidateV1,
	) => AutomaticDeliveryContinuationCandidateV1 | undefined;
	review?: (current: AutomaticDeliveryContinuationCandidateV1) => Promise<AutomaticSemanticReviewResult>;
	exactRepair?: AutomaticDeliveryContinuationRuntimeControllerDependenciesV1["exactRepair"];
	onResolve?: (input: AutomaticDeliveryContinuationResolveInputV1) => void;
	onConfirm?: (authorityHash: string) => void;
	onRecoverSettledCheckout?: () => void;
	onReconcile?: () => void;
	recoverSettledCheckout?: AutomaticDeliveryContinuationRuntimeControllerDependenciesV1["recoverSettledCheckoutOperation"];
	onLane?: (phase: "acquire" | "release", allowedPath: string) => void;
	processStateSymbol?: symbol;
	canonicalBudgetPaused?: boolean;
	canonicalBudgetAuthorized?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const pi = new FakePi();
	const pendingHandles = new Map<string, ProjectCheckoutOperationLeaseV1>();
	let current = options.initialCandidate ?? candidate();
	let reviewCalls = 0;
	let exactCalls = 0;
	const ctx = context({ pending: options.pending?.() ?? false });
	const dependencies: AutomaticDeliveryContinuationRuntimeControllerDependenciesV1 = {
		pi: pi as never,
		pendingCheckoutOperationHandles: pendingHandles,
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		secrets: [],
		getMode: () => "DEV",
		getLifecycleActionSnapshot: () => options.canonicalBudgetPaused
			? { action: "PAUSED_BUDGET", authorization: "USER_REQUIRED" }
			: options.canonicalBudgetAuthorized
				? { action: "CONTINUE_CHECKPOINT", authorization: "EXISTING" }
				: undefined,
		runtimeCurrentOrError: () => undefined,
		compactionPending: () => options.compaction?.() ?? false,
		projectRootFor: async () => ROOT,
		recoverSettledCheckoutOperation: async (input) => {
			options.onRecoverSettledCheckout?.();
			return options.recoverSettledCheckout?.(input) ?? { ok: true, value: "absent" };
		},
		reconcileProjectAuthority: async () => { options.onReconcile?.(); return true; },
		resolveCandidate: async (input) => {
			options.onResolve?.(input);
			const resolved = options.resolve?.(input, current) ?? current;
			return resolved === undefined
				? { status: "NOOP", code: "NO_CANDIDATE" }
				: { status: "CANDIDATE", candidate: resolved };
		},
		revalidateCandidate: async ({ candidate: expected }) => ({
			schema_version: 1,
			expected_authority_hash: expected.authority_hash,
			observed_authority_hash: current.authority_hash,
			unchanged: expected.authority_hash === current.authority_hash &&
				expected.delegation_id === current.delegation_id,
			resolution: { status: "CANDIDATE", candidate: current },
		}),
		confirmSettled: async (input) => {
			options.onConfirm?.(input.expected_authority_hash);
			if (input.expected_authority_hash !== current.authority_hash ||
				input.expected_bound_diff_hash !== current.bound_diff_hash) {
				return { ok: false, code: "AUTHORITY_CHANGED" };
			}
			return {
				ok: true,
				value: {
					schema_version: 1,
					project_root: ROOT,
					delegation_id: current.delegation_id,
					authority_hash: current.authority_hash,
					bound_diff_hash: current.bound_diff_hash,
					lineage_depth: 0,
					authority_confirmed: true,
					no_active_lane: true,
				},
			};
		},
		exactRepair: async (input) => {
			exactCalls += 1;
			return options.exactRepair?.(input) ?? recordedSuccessor(
				options.successorStatus ?? "PENDING_REVIEW",
				{
					disposition: options.successorDisposition ?? "REVIEW_PENDING",
					serviceStatus: options.successorServiceStatus,
				},
			);
		},
		review: async () => {
			reviewCalls += 1;
			if (options.review !== undefined) return options.review(current);
			return repairReview(current.delegation_id);
		},
		runReviewOperation: async (input, operation) => {
			assert.deepEqual(input.allowed_paths, [AUTOMATIC_DELIVERY_CONTINUATION_METADATA_LANE_V1]);
			options.onLane?.("acquire", input.allowed_paths[0]);
			const value = await operation(lease(input.project_root));
			options.onLane?.("release", input.allowed_paths[0]);
			return { ok: true, value, release: "released" };
		},
		now: () => new Date("2026-08-27T01:02:03.000Z"),
		processStateSymbol: options.processStateSymbol ?? isolatedSymbol(),
	};
	const runtime = createAutomaticDeliveryContinuationRuntimeControllerV1(dependencies);
	return {
		pi,
		ctx,
		runtime,
		pendingHandles,
		get current() { return current; },
		set current(value: AutomaticDeliveryContinuationCandidateV1) { current = value; },
		get reviewCalls() { return reviewCalls; },
		get exactCalls() { return exactCalls; },
	};
}

function toolResult(toolCallId: string) {
	return {
		type: "tool_result",
		toolCallId,
		toolName: "workbench_delegate_worker",
		input: {},
		content: [{ type: "text", text: "untrusted failure text" }],
		isError: true,
		details: undefined,
	};
}

test("failure tool_result captures the pending guard lease before middleware cleanup", async () => {
	let cleanupComplete = false;
	let reconciledAfterCleanup = false;
	let contentGetterCalls = 0;
	const h = harness({
		onReconcile: () => {
			reconciledAfterCleanup = cleanupComplete;
			assert.equal(h.pendingHandles.has("call-1"), false);
		},
	});
	h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	h.pi.on("tool_result", ((event: { toolCallId: string }) => {
		h.pendingHandles.delete(event.toolCallId);
		cleanupComplete = true;
	}) as never);
	h.runtime.registerLifecycleListenersAfterMiddleware();

	h.pendingHandles.set("call-1", guardLease(ID));
	const failureEvent = Object.defineProperty(toolResult("call-1"), "content", {
		enumerable: true,
		get() { contentGetterCalls += 1; return [{ type: "text", text: "must not parse" }]; },
	});
	await h.pi.emit("tool_result", failureEvent, h.ctx);
	await h.pi.emit("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "workbench_delegate_worker",
		result: { details: { error: "no delegation id in projected failure" } },
		isError: true,
	}, h.ctx);
	await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);

	assert.equal(contentGetterCalls, 0, "locator capture never parses worker/error text");
	assert.equal(reconciledAfterCleanup, true, "automatic continuation starts only after middleware cleanup");
	assert.equal(h.exactCalls, 1);
	assert.equal(h.pi.sent.length, 1);
	assert.equal(h.pi.sent[0]?.options?.triggerTurn, false);
	assert.equal(h.pi.sent[0]?.message.details.lifecycle_action, "EXECUTE_EXACT_REPAIR");
	assert.equal(h.pi.sent[0]?.message.details.lifecycle_reason, "EXACT_REPAIR_DECISION_CURRENT");
	assert.match(String(h.pi.sent[0]?.message.details.lifecycle_snapshot_hash), /^[a-f0-9]{64}$/u);
});

test("settled generic checkout recovery precedes authority reconciliation and a failed cleanup is retryable after reload", async () => {
	let recoveryAvailable = false;
	const order: string[] = [];
	const h = harness({
		onRecoverSettledCheckout: () => order.push("checkout-recovery"),
		onReconcile: () => order.push("authority-reconcile"),
		recoverSettledCheckout: async () => recoveryAvailable
			? { ok: true, value: "recovered" }
			: { ok: false, error: { code: "storage_failure", message: "injected release recovery fault" } },
	});
	h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	h.runtime.registerLifecycleListenersAfterMiddleware();
	await h.pi.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: "settled-release-fault", toolName: "workbench_delegate_worker",
		result: { details: { delegation_id: ID } }, isError: false,
	}, h.ctx);
	await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
	assert.deepEqual(order, ["checkout-recovery"], "authority reads cannot run behind an unrecovered settled writer");
	assert.deepEqual({ review: h.reviewCalls, exact: h.exactCalls }, { review: 0, exact: 0 });
	assert.equal(h.runtime.hasPendingBeforeAgentContinuation(), true);

	recoveryAvailable = true;
	await h.pi.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
	await h.pi.emit("before_agent_start", {
		type: "before_agent_start", prompt: "continue", systemPrompt: "", systemPromptOptions: {},
	}, h.ctx);
	assert.deepEqual(order.slice(1, 3), ["checkout-recovery", "authority-reconcile"]);
	assert.deepEqual({ review: h.reviewCalls, exact: h.exactCalls }, { review: 1, exact: 1 });
});

test("settled delegation CAS proceeds to transaction-aware authority reconciliation", async () => {
	const order: string[] = [];
	const h = harness({
		onRecoverSettledCheckout: () => order.push("checkout-observe"),
		onReconcile: () => order.push("delegation-cas-reconcile"),
		recoverSettledCheckout: async () => ({ ok: true, value: "delegation_cas_pending" }),
	});
	h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	h.runtime.registerLifecycleListenersAfterMiddleware();
	await h.pi.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: "delegation-cas", toolName: "workbench_delegate_worker",
		result: { details: { delegation_id: ID } }, isError: true,
	}, h.ctx);
	await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
	assert.deepEqual(order.slice(0, 2), ["checkout-observe", "delegation-cas-reconcile"]);
	assert.equal(h.exactCalls, 1, "transaction-aware reconciliation may close the old delegation before one successor");
});

test("final projected tool details are a success locator and multiple locators are filtered by strict resolver", async () => {
	const initialLocatorSets: string[][] = [];
	const eligible = candidate({ delegation_id: OTHER_ID });
	const h = harness({
		resolve: (input) => {
			if (input.locator_delegation_ids.length > 1) {
				initialLocatorSets.push([...input.locator_delegation_ids]);
				return eligible;
			}
			return eligible;
		},
	});
	h.current = eligible;
	h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	h.runtime.registerLifecycleListenersAfterMiddleware();
	for (const [call, id] of [["call-a", ID], ["call-b", OTHER_ID]] as const) {
		await h.pi.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: call,
			toolName: "workbench_delegate_worker",
			result: { details: { delegation_id: id, status: id === ID ? "REVIEWED" : "PENDING_REVIEW" } },
			isError: false,
		}, h.ctx);
	}
	await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
	assert.deepEqual(initialLocatorSets, [[ID, OTHER_ID]]);
	assert.equal(h.exactCalls, 1, "a closed first locator never creates ambiguity or a second child");
});

test("pending messages and compaction defer without review, while claim suppression stays active", async () => {
	let pending = true;
	let compacting = false;
	const h = harness({ pending: () => pending, compaction: () => compacting });
	// Context methods read the mutable gates rather than a shared current ctx.
	(h.ctx as { hasPendingMessages(): boolean }).hasPendingMessages = () => pending;
	h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	h.runtime.registerLifecycleListenersAfterMiddleware();
	await h.pi.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: "call", toolName: "workbench_delegate_worker",
		result: { details: { delegation_id: ID } }, isError: false,
	}, h.ctx);
	assert.equal(h.runtime.hasPendingBeforeAgentContinuation(), true);
	await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
	assert.deepEqual({ review: h.reviewCalls, exact: h.exactCalls }, { review: 0, exact: 0 });

	pending = false;
	compacting = true;
	await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
	assert.deepEqual({ review: h.reviewCalls, exact: h.exactCalls }, { review: 0, exact: 0 });
	compacting = false;
	await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
	assert.deepEqual({ review: h.reviewCalls, exact: h.exactCalls }, { review: 1, exact: 1 });
	assert.equal(h.runtime.hasPendingBeforeAgentContinuation(), false);
	assert.equal(h.pi.sent.every((entry) => entry.options?.triggerTurn === false), true);
});

test("NEEDS_REVIEW uses only the delegation metadata lane and proves the new sidecar authority before exact repair", async () => {
	const order: string[] = [];
	const confirmed: string[] = [];
	const h = harness({
		initialCandidate: needsReview(),
		review: async () => {
			order.push("review");
			h.current = durableTerminalRepair();
			return repairReview();
		},
		onResolve: (input) => order.push(input.allow_exact_terminal_needs_review ? "resolve-needs" : "resolve-sidecar"),
		onConfirm: (hash) => { confirmed.push(hash); order.push(`confirm-${hash[0]}`); },
		onLane: (phase, allowedPath) => {
			assert.equal(allowedPath, ".pi/workbench/delegations/**");
			order.push(`lane-${phase}`);
		},
		exactRepair: async () => {
			order.push("exact");
			assert.ok(order.includes("lane-release"));
			assert.equal(confirmed.filter((hash) => hash === NEW_AUTHORITY).length >= 2, true);
			return recordedSuccessor("PENDING_REVIEW");
		},
	});
	h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	h.runtime.registerLifecycleListenersAfterMiddleware();
	await h.pi.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: "terminal", toolName: "workbench_delegate_worker",
		result: { details: { delegation_id: ID } }, isError: true,
	}, h.ctx);
	await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);

	assert.equal(confirmed[0], OLD_AUTHORITY, "the terminal parent is settled before metadata review");
	assert.equal(confirmed.slice(1).every((hash) => hash === NEW_AUTHORITY), true);
	assert.ok(order.indexOf("lane-release") < order.lastIndexOf("confirm-8"));
	assert.ok(order.lastIndexOf("confirm-8") < order.indexOf("exact"));
	assert.equal(h.exactCalls, 1);
	assert.equal(h.pi.sent[0]?.message.details.lifecycle_action, "REVIEW_CANDIDATE");
	assert.equal(h.pi.sent[0]?.message.details.lifecycle_reason, "CURRENT_DELTA_REVIEW_REQUIRED");
});

test("writer-lane CAS refuses a candidate whose canonical lifecycle action changes", async () => {
	let h: ReturnType<typeof harness>;
	h = harness({
		onLane: (phase) => {
			if (phase === "acquire") h.current = candidate({ affected_paths: ["other/**"] });
		},
	});
	h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	h.runtime.registerLifecycleListenersAfterMiddleware();
	await h.pi.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: "lifecycle-cas", toolName: "workbench_delegate_worker",
		result: { details: { delegation_id: ID } }, isError: false,
	}, h.ctx);
	await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
	assert.deepEqual({ review: h.reviewCalls, exact: h.exactCalls }, { review: 0, exact: 0 });
	assert.equal(h.pi.sent[0]?.message.details.status, "DEFER");
	assert.equal(h.pi.sent[0]?.message.details.code, "CHAIN_FAILED");
});

test("lost exact response replays once after reload and before_agent_start injects, never self-sends", async () => {
	let durableSuccessor = false;
	let physicalStarts = 0;
	const h = harness({
		successorStatus: "REVIEWED",
		successorDisposition: "CHAIN_CLOSED",
		exactRepair: async () => {
			if (!durableSuccessor) {
				physicalStarts += 1;
				durableSuccessor = true;
				throw new Error("response lost after durable child");
			}
			return recordedSuccessor("REVIEWED", { replayed: true, disposition: "CHAIN_CLOSED" });
		},
	});
	h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	h.runtime.registerLifecycleListenersAfterMiddleware();
	await h.pi.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: "lost", toolName: "workbench_delegate_worker",
		result: { details: { delegation_id: ID } }, isError: false,
	}, h.ctx);
	await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
	assert.equal(h.pi.sent.length, 1);
	assert.equal(h.pi.sent[0]?.options?.triggerTurn, false);

	await h.pi.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
	assert.equal(h.runtime.hasPendingBeforeAgentContinuation(), true);
	const beforeResults = await h.pi.emit("before_agent_start", {
		type: "before_agent_start", prompt: "continue", systemPrompt: "", systemPromptOptions: {},
	}, h.ctx);
	const injected = beforeResults.find((value) => value !== undefined) as {
		message?: { display?: boolean; details?: { successor_status?: string } };
	} | undefined;
	assert.equal(injected?.message?.display, false);
	assert.equal(injected?.message?.details?.successor_status, "REVIEWED");
	assert.equal(h.pi.sent.length, 1, "before_agent_start injects into the current turn and never sends another turn");
	assert.equal(physicalStarts, 1, "strict replay does not duplicate the child execution");
	assert.equal(h.exactCalls, 2);
});

test("agent follow-up and next_action use only the strict durable successor disposition", async () => {
	const cases: ReadonlyArray<{
		status: DelegationTransactionStatus;
		disposition: ExactRepairExistingSuccessorV1["disposition"];
		serviceStatus?: "SUCCESSOR_RECORDED" | "SUCCESSOR_ACTIVE" | "EXACT_REPAIR_PENDING" | "SUCCESSOR_BLOCKED";
		triggerTurn: boolean;
		nextAction: string | null;
	}> = [
		{ status: "REVIEWED", disposition: "CHAIN_CLOSED", triggerTurn: true, nextAction: null },
		{ status: "REVIEWED", disposition: "BLOCKED", serviceStatus: "SUCCESSOR_BLOCKED", triggerTurn: false, nextAction: "call workbench_delegation_status" },
		{ status: "FINISHED", disposition: "BLOCKED", serviceStatus: "SUCCESSOR_BLOCKED", triggerTurn: false, nextAction: "call workbench_delegation_status" },
		{ status: "PENDING_REVIEW", disposition: "REVIEW_PENDING", triggerTurn: false, nextAction: `call workbench_review_worker_diff with delegation_id=${CHILD}` },
		{ status: "INTERRUPTED", disposition: "REVIEW_PENDING", triggerTurn: false, nextAction: `call workbench_review_worker_diff with delegation_id=${CHILD}` },
		{ status: "PENDING_REVIEW", disposition: "REPAIR_PENDING", triggerTurn: false, nextAction: `call workbench_repair_delegation with delegation_id=${CHILD}` },
		{ status: "FAILED", disposition: "EXACT_REPAIR_PENDING", serviceStatus: "EXACT_REPAIR_PENDING", triggerTurn: false, nextAction: `call workbench_repair_delegation with delegation_id=${CHILD}` },
		{ status: "PREPARED", disposition: "ACTIVE", serviceStatus: "SUCCESSOR_ACTIVE", triggerTurn: false, nextAction: "call workbench_delegation_status" },
		{ status: "ABORTED", disposition: "BLOCKED", serviceStatus: "SUCCESSOR_BLOCKED", triggerTurn: false, nextAction: "call workbench_delegation_status" },
	];
	for (const entry of cases) {
		const h = harness({
			successorStatus: entry.status,
			successorDisposition: entry.disposition,
			successorServiceStatus: entry.serviceStatus,
		});
		h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
		h.runtime.registerLifecycleListenersAfterMiddleware();
		await h.pi.emit("tool_execution_end", {
			type: "tool_execution_end", toolCallId: `${entry.status}-${entry.disposition}`, toolName: "workbench_delegate_worker",
			result: { details: { delegation_id: ID, next_action: "/q-repair untrusted" } }, isError: false,
		}, h.ctx);
		await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
		assert.equal(h.pi.sent.length, 1);
		const sent = h.pi.sent[0]!;
		assert.equal(sent.options?.triggerTurn, entry.triggerTurn, `${entry.status}/${entry.disposition}`);
		assert.equal(sent.message.details.next_action, entry.nextAction, `${entry.status}/${entry.disposition}`);
		assert.equal(sent.message.details.successor_disposition, entry.disposition);
		assert.equal(JSON.stringify(sent).includes("/q-repair untrusted"), false, "worker details never route continuation");
	}
});

test("agent_settled self-followup requires one fresh completed executor result", async () => {
	for (const entry of [
		{ label: "fresh", options: { disposition: "CHAIN_CLOSED", executionStatus: "completed" }, trigger: true },
		{ label: "replay", options: { disposition: "CHAIN_CLOSED", replayed: true }, trigger: false },
		{ label: "throw", options: { disposition: "CHAIN_CLOSED", executionOutcome: "threw", executionStatus: "completed" }, trigger: false },
		{ label: "refused", options: { disposition: "CHAIN_CLOSED", executionStatus: "refused" }, trigger: false },
	] as const) {
		const h = harness({
			successorStatus: "REVIEWED",
			successorDisposition: "CHAIN_CLOSED",
			exactRepair: async () => recordedSuccessor("REVIEWED", entry.options),
		});
		h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
		h.runtime.registerLifecycleListenersAfterMiddleware();
		await h.pi.emit("tool_execution_end", {
			type: "tool_execution_end", toolCallId: entry.label, toolName: "workbench_delegate_worker",
			result: { details: { delegation_id: ID } }, isError: false,
		}, h.ctx);
		await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
		assert.equal(h.pi.sent[0]?.options?.triggerTurn, entry.trigger, entry.label);
	}
});

test("process-shared controllers coalesce authority and a separate-process replay stays non-triggering", async () => {
	const shared = isolatedSymbol();
	const first = harness({
		processStateSymbol: shared,
		successorStatus: "REVIEWED",
		successorDisposition: "CHAIN_CLOSED",
	});
	first.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	first.runtime.registerLifecycleListenersAfterMiddleware();
	await first.pi.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: "first", toolName: "workbench_delegate_worker",
		result: { details: { delegation_id: ID } }, isError: false,
	}, first.ctx);
	await first.pi.emit("agent_settled", { type: "agent_settled" }, first.ctx);
	assert.equal(first.pi.sent[0]?.options?.triggerTurn, true);

	const joined = harness({ processStateSymbol: shared });
	joined.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	joined.runtime.registerLifecycleListenersAfterMiddleware();
	await joined.pi.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: "joined", toolName: "workbench_delegate_worker",
		result: { details: { delegation_id: ID } }, isError: false,
	}, joined.ctx);
	await joined.pi.emit("agent_settled", { type: "agent_settled" }, joined.ctx);
	assert.equal(joined.exactCalls, 0, "same-process controller cannot repeat the authority");
	assert.equal(joined.pi.sent.length, 0, "same-process controller emits no duplicate follow-up");

	const replay = harness({
		processStateSymbol: isolatedSymbol(),
		exactRepair: async () => recordedSuccessor("REVIEWED", {
			disposition: "CHAIN_CLOSED",
			replayed: true,
		}),
	});
	replay.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	replay.runtime.registerLifecycleListenersAfterMiddleware();
	await replay.pi.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: "replay", toolName: "workbench_delegate_worker",
		result: { details: { delegation_id: ID } }, isError: false,
	}, replay.ctx);
	await replay.pi.emit("agent_settled", { type: "agent_settled" }, replay.ctx);
	assert.equal(replay.pi.sent[0]?.options?.triggerTurn, false, "durable replay is advisory across a process boundary");
});

test("session_start marks reload continuation only for startup, reload and resume", async () => {
	assert.deepEqual(AUTOMATIC_DELIVERY_CONTINUATION_RECOVERY_SESSION_REASONS_V1, ["startup", "reload", "resume"]);
	for (const reason of ["startup", "reload", "resume", "new", "fork"] as const) {
		const h = harness();
		h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
		h.runtime.registerLifecycleListenersAfterMiddleware();
		await h.pi.emit("session_start", { type: "session_start", reason }, h.ctx);
		assert.equal(
			h.runtime.hasPendingBeforeAgentContinuation(),
			reason === "startup" || reason === "reload" || reason === "resume",
			reason,
		);
	}
});

test("canonical budget pause clears non-authoritative continuation without review, repair, or advice", async () => {
	const h = harness({ canonicalBudgetPaused: true });
	h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	h.runtime.registerLifecycleListenersAfterMiddleware();
	await h.pi.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: "paused", toolName: "workbench_delegate_worker",
		result: { details: { delegation_id: ID } }, isError: false,
	}, h.ctx);
	await h.pi.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
	assert.equal(h.runtime.hasPendingBeforeAgentContinuation(), true);
	const before = await h.pi.emit("before_agent_start", {
		type: "before_agent_start", prompt: "continue", systemPrompt: "", systemPromptOptions: {},
	}, h.ctx);
	await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
	assert.equal(before.every((result) => result === undefined), true);
	assert.equal(h.runtime.hasPendingBeforeAgentContinuation(), false);
	assert.deepEqual({ review: h.reviewCalls, exact: h.exactCalls, sent: h.pi.sent.length }, { review: 0, exact: 0, sent: 0 });
});

test("authorized checkpoint continuation owns the turn and suppresses conflicting delivery advice", async () => {
	const h = harness({ canonicalBudgetAuthorized: true });
	h.runtime.registerToolResultLocatorCaptureBeforeMiddleware();
	h.runtime.registerLifecycleListenersAfterMiddleware();
	await h.pi.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
	assert.equal(h.runtime.hasPendingBeforeAgentContinuation(), true);
	const before = await h.pi.emit("before_agent_start", {
		type: "before_agent_start", prompt: "继续", systemPrompt: "", systemPromptOptions: {},
	}, h.ctx);
	await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
	assert.equal(before.every((result) => result === undefined), true);
	assert.equal(h.runtime.hasPendingBeforeAgentContinuation(), false);
	assert.deepEqual({ review: h.reviewCalls, exact: h.exactCalls, sent: h.pi.sent.length }, { review: 0, exact: 0, sent: 0 });
});

test("production registers the failure locator before middleware and lifecycle only after cleanup", async () => {
	const [source, index] = await Promise.all([
		readFile(new URL("../extensions/workbench-runtime/core/runtime-workbench-tools-controller.ts", import.meta.url), "utf8"),
		readFile(new URL("../extensions/workbench-runtime/index.ts", import.meta.url), "utf8"),
	]);
	const pre = source.indexOf("automaticDeliveryContinuation.registerToolResultLocatorCaptureBeforeMiddleware();");
	const middleware = source.indexOf("registerToolResultMiddleware({");
	const post = source.indexOf("automaticDeliveryContinuation.registerLifecycleListenersAfterMiddleware();");
	assert.ok(pre >= 0 && middleware > pre && post > middleware, "production listener order is pre-capture, cleanup middleware, then lifecycle");
	assert.match(source, /automaticDeliveryContinuationEnabled = controller\.workerRoleContext\.role !== "worker"/u);
	assert.match(source, /if \(automaticDeliveryContinuationEnabled\) automaticDeliveryContinuation\.registerToolResultLocatorCaptureBeforeMiddleware\(\)/u);
	assert.match(source, /if \(automaticDeliveryContinuationEnabled\) automaticDeliveryContinuation\.registerLifecycleListenersAfterMiddleware\(\)/u);
	assert.match(source, /automaticDeliveryContinuationEnabled && automaticDeliveryContinuation\.hasPendingBeforeAgentContinuation\(\)/u);
	assert.match(index, /hasPendingAutomaticDeliveryContinuation:\s*\(\)\s*=>\s*hasPendingAutomaticDeliveryContinuation\(\)/u);
	assert.match(source, /resolveCandidate:\s*resolveAutomaticDeliveryContinuationCandidateV1/u);
	assert.match(source, /exactRepair:\s*\(input\)\s*=>\s*runExactRepairServiceV1/u);
});
