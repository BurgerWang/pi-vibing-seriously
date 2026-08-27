import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	registerToolCallGuard,
	type ToolCallGuardController,
} from "../extensions/workbench-runtime/core/tool-call-guard-controller.ts";
import { registerToolResultMiddleware } from "../extensions/workbench-runtime/core/tool-result-middleware-controller.ts";
import {
	acquireProjectCheckoutOperationV1,
	inspectProcessCheckoutOperationV1,
	markProjectCheckoutOperationSettledV1,
	releaseProjectCheckoutOperationV1,
	resetProjectCheckoutOperationRegistryForTestV1,
	type AcquireProjectCheckoutOperationInputV1,
	type ProjectCheckoutOperationLeaseV1,
} from "../extensions/workbench-runtime/core/project-checkout-operation.ts";
import { releaseProjectDelegationStartLockV1 } from "../extensions/workbench-runtime/core/delegation-start-lock.ts";
import { withTempDir } from "./helpers.ts";

type EventHandler = (event?: Record<string, unknown>, ctx?: ExtensionContext) => unknown | Promise<unknown>;

const NOW = "2026-08-27T12:00:00.000Z";
const DELEGATION_ID = "20260827-120000-lane";

function fakeLease(input: AcquireProjectCheckoutOperationInputV1): ProjectCheckoutOperationLeaseV1 {
	const delegationId = input.delegation_id ?? "20260827-120001-tool";
	const token = "a".repeat(32);
	return {
		schema_version: 1,
		project_root: input.project_root,
		operation_kind: input.operation_kind,
		operation_id: input.operation_id,
		delegation_id: delegationId,
		token,
		mode: "exclusive",
		start_lock_lease: {
			schema_version: 1,
			project_root: input.project_root,
			delegation_id: delegationId,
			token,
			process_id: process.pid,
			process_start_ticks: "1",
			boot_id: "11111111-1111-1111-1111-111111111111",
			acquired_at: input.now,
		},
	};
}

function guardHarness(): {
	handler: EventHandler;
	order: string[];
	acquisitions: AcquireProjectCheckoutOperationInputV1[];
	pending: Map<string, ProjectCheckoutOperationLeaseV1>;
} {
	let handler: EventHandler | undefined;
	const order: string[] = [];
	const acquisitions: AcquireProjectCheckoutOperationInputV1[] = [];
	const pending = new Map<string, ProjectCheckoutOperationLeaseV1>();
	registerToolCallGuard({
		pi: { on(_name: string, callback: EventHandler) { handler = callback; } } as never,
		toolCallBlockReason: () => undefined,
		runtimeMutationBlockReason: () => undefined,
		getWorkerRoleContext: () => ({}),
		getIdentity: () => ({ provider: "openai-codex", model: "gpt-5.6-terra" }),
		getMode: () => "DEV",
		getLease: () => undefined,
		setLease: () => {},
		syncLease: () => {},
		recordBlockedWriteAttempt: () => {},
		projectRootFor: async () => "/project",
		makeDelegationId: () => DELEGATION_ID,
		reconcileProjectAuthority: async () => { order.push("reconcile"); return true; },
		authorizeOutput: (toolCallId, toolName) => ({
			authorizationId: `${String(toolCallId)}:${String(toolName)}`,
			toolCallId: String(toolCallId),
			toolName: String(toolName),
			policyId: "default",
			planned: false,
			allowed: true,
			allocatedBytes: 2_048,
			controlAllocatedBytes: 0,
		}),
		rememberOutputAuthorization: () => {},
		workerWriteJournalRuntime: { beginToolCall: async () => ({ ok: true }) } as never,
		turnOutputBudget: { releaseAuthorization: () => ({}) } as never,
		pendingReceiptHandles: new Map(),
		pendingCheckoutOperationHandles: pending,
		acquireCheckoutOperation: (async (input: AcquireProjectCheckoutOperationInputV1) => {
			order.push("acquire");
			acquisitions.push(input);
			return { ok: true as const, value: fakeLease(input) };
		}) as typeof acquireProjectCheckoutOperationV1,
		releaseCheckoutOperation: (async () => {
			order.push("release");
			return { ok: true as const, value: null };
		}) as typeof releaseProjectCheckoutOperationV1,
		beginToolReceipt: (async (input: { toolName: string }) => {
			order.push("receipt");
			return {
				ok: true as const,
				kind: "created" as const,
				handle: {
					id: `wtr1-${"b".repeat(64)}`,
					toolName: input.toolName,
					inputHash: "c".repeat(64),
					nonce: "d".repeat(32),
				},
			};
		}) as never,
		persistLease: () => true,
		applyModeTools: () => {},
		recordModifiedFile: () => {},
	} satisfies ToolCallGuardController);
	assert.ok(handler);
	return { handler, order, acquisitions, pending };
}

function context(): ExtensionContext {
	return {
		cwd: "/project",
		sessionManager: { getSessionId: () => "session-lane" },
	} as unknown as ExtensionContext;
}

test.afterEach(() => resetProjectCheckoutOperationRegistryForTestV1());

test("delegate guard acquires the exact lifecycle lane before beginning any receipt", async () => {
	const harness = guardHarness();
	const result = await harness.handler({
		toolCallId: "delegate-call",
		toolName: "workbench_delegate_worker",
		input: {},
	}, context());
	assert.equal(result, undefined);
	assert.deepEqual(harness.order, ["reconcile", "acquire", "receipt"]);
	assert.equal(harness.acquisitions[0]?.operation_kind, "delegation");
	assert.equal(harness.acquisitions[0]?.delegation_id, DELEGATION_ID);
	assert.equal(harness.pending.get("delegate-call")?.delegation_id, DELEGATION_ID);
});

test("exact repair routers skip only the outer lane and still create receipts", async () => {
	for (const [toolCallId, toolName, input] of [
		["repair-tool", "workbench_repair_delegation", { delegation_id: DELEGATION_ID }],
		["repair-alias", "workbench_delegate_worker", {
			task: "ignored",
			allowed_paths: ["ignored.ts"],
			acceptance_criteria: ["ignored"],
			repair_of: DELEGATION_ID,
		}],
	] as const) {
		const harness = guardHarness();
		const result = await harness.handler({ toolCallId, toolName, input }, context());
		assert.equal(result, undefined);
		assert.deepEqual(harness.order, ["receipt"], `${toolName} outer router must not deadlock the private delegation lane`);
		assert.equal(harness.acquisitions.length, 0);
		assert.equal(harness.pending.size, 0);
	}
});

test("authority-recovery Git routers skip the outer lane while ordinary Git actions retain it", async () => {
	for (const [toolCallId, input] of [
		["close-clean", { action: "close_clean_repair" }],
		["close-inactive", { action: "close_inactive_blocker", delegation_id: DELEGATION_ID }],
		["quarantine", { action: "quarantine_unreadable_authority", delegation_id: DELEGATION_ID }],
	] as const) {
		const harness = guardHarness();
		const result = await harness.handler({ toolCallId, toolName: "workbench_git", input }, context());
		assert.equal(result, undefined);
		assert.deepEqual(
			harness.order,
			["receipt"],
			`${input.action} must leave the delegation-start lock available for its strict internal recovery service`,
		);
		assert.equal(harness.acquisitions.length, 0);
		assert.equal(harness.pending.size, 0);
	}

	for (const [toolCallId, input] of [
		["checkpoint", { action: "checkpoint", message: "reviewed checkpoint" }],
		["push", { action: "push", expected_head: "a".repeat(40) }],
		["malformed", { action: "unknown" }],
	] as const) {
		const harness = guardHarness();
		const result = await harness.handler({ toolCallId, toolName: "workbench_git", input }, context());
		assert.equal(result, undefined);
		assert.deepEqual(harness.order.slice(0, 2), ["reconcile", "acquire"]);
		assert.equal(harness.acquisitions.length, 1);
		assert.equal(harness.pending.has(toolCallId), true);
	}
});

test("review presentation and unknown custom tools both require the closed checkout lane", async () => {
	for (const [toolCallId, toolName] of [
		["review-call", "workbench_review_worker_diff"],
		["foreign-call", "third_party_unknown_writer"],
	] as const) {
		const harness = guardHarness();
		const result = await harness.handler({ toolCallId, toolName, input: {} }, context());
		assert.equal(result, undefined);
		assert.deepEqual(harness.order.slice(0, 2), ["reconcile", "acquire"]);
		assert.equal(harness.pending.has(toolCallId), true);
	}
});

test("gate preflight remains read-only while detached bash is denied before acquisition", async () => {
	const preflight = guardHarness();
	assert.equal(await preflight.handler({
		toolCallId: "gate-preflight",
		toolName: "workbench_run_gate",
		input: { preflight: true },
	}, context()), undefined);
	assert.deepEqual(preflight.order, []);

	const detached = guardHarness();
	const result = await detached.handler({
		toolCallId: "background-shell",
		toolName: "bash",
		input: { command: "run-task &" },
	}, context()) as { block?: boolean; reason?: string };
	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /Background\/detached shell processes are forbidden/u);
	assert.deepEqual(detached.order, []);
});

test("agent settlement releases ordinary tools but retains a settled delegation for exact CAS recovery", async () => {
	await withTempDir(async (ordinaryRoot) => {
		await withTempDir(async (delegationRoot) => {
			const ordinary = await acquireProjectCheckoutOperationV1({
				project_root: ordinaryRoot,
				operation_kind: "tool",
				operation_id: "tool:third-party:missing-result",
				now: NOW,
			});
			const delegation = await acquireProjectCheckoutOperationV1({
				project_root: delegationRoot,
				operation_kind: "delegation",
				operation_id: `delegation:${DELEGATION_ID}`,
				delegation_id: DELEGATION_ID,
				now: NOW,
			});
			assert.equal(ordinary.ok, true);
			assert.equal(delegation.ok, true);
			if (!ordinary.ok || !delegation.ok) return;

			const events = new Map<string, EventHandler[]>();
			const pending = new Map<string, ProjectCheckoutOperationLeaseV1>([
				["ordinary", ordinary.value],
				["delegation", delegation.value],
			]);
			registerToolResultMiddleware({
				pi: { on(name: string, callback: EventHandler) {
					const handlers = events.get(name) ?? [];
					handlers.push(callback);
					events.set(name, handlers);
				} } as never,
				workerJournalActive: false,
				workerWriteJournalRuntime: {} as never,
				getOutputTurnRole: () => "other",
				takeTrustedContinuation: () => undefined,
				takeOutputAuthorization: () => undefined,
				authorizeOutput: () => ({}) as never,
				takeTrustedIngressAuthority: () => undefined,
				turnOutputBudget: {} as never,
				observeOutputEnvelope: () => {},
				rememberProcessedNormalResult: () => {},
				pendingReceiptHandles: new Map(),
				pendingCheckoutOperationHandles: pending,
				secrets: [],
			});
			for (const handler of events.get("session_shutdown") ?? []) {
				await handler({}, { isIdle: () => false } as unknown as ExtensionContext);
			}
			assert.equal(pending.size, 2, "non-idle shutdown never guesses that a child/tool has settled");
			assert.equal(inspectProcessCheckoutOperationV1(ordinaryRoot, ordinary.value.token), "active");
			assert.equal(inspectProcessCheckoutOperationV1(delegationRoot, delegation.value.token), "active");
			assert.equal(markProjectCheckoutOperationSettledV1(delegation.value, "delegation_cas"), true);
			for (const handler of events.get("agent_settled") ?? []) {
				await handler({}, { isIdle: () => true } as unknown as ExtensionContext);
			}
			assert.equal(pending.size, 0);
			await assert.rejects(
				readFile(join(ordinaryRoot, CONFIG_DIR_NAME, "workbench", "delegation-start.lock"), "utf8"),
				(error: NodeJS.ErrnoException) => error.code === "ENOENT",
			);
			assert.equal(inspectProcessCheckoutOperationV1(delegationRoot, delegation.value.token), "settled");
			assert.equal(
				JSON.parse(await readFile(join(delegationRoot, CONFIG_DIR_NAME, "workbench", "delegation-start.lock"), "utf8")).token,
				delegation.value.token,
			);
			assert.equal((await releaseProjectCheckoutOperationV1(delegation.value)).ok, true);
		});
	});
});

test("tool_result settlement makes pre-unlink and post-unlink release faults exactly recoverable", async () => {
	for (const fault of ["pre-unlink", "post-unlink"] as const) {
		await withTempDir(async (root) => {
			const first = await acquireProjectCheckoutOperationV1({
				project_root: root,
				operation_kind: "delegation",
				operation_id: `delegation:${DELEGATION_ID}`,
				delegation_id: DELEGATION_ID,
				now: NOW,
			});
			assert.equal(first.ok, true);
			if (!first.ok) return;

			const events = new Map<string, EventHandler[]>();
			const pending = new Map([["faulted-result", first.value]]);
			registerToolResultMiddleware({
				pi: { on(name: string, callback: EventHandler) {
					const handlers = events.get(name) ?? [];
					handlers.push(callback);
					events.set(name, handlers);
				} } as never,
				workerJournalActive: false,
				workerWriteJournalRuntime: {} as never,
				getOutputTurnRole: () => "other",
				takeTrustedContinuation: () => undefined,
				takeOutputAuthorization: () => ({
					authorizationId: "faulted-result:workbench_delegate_worker",
					toolCallId: "faulted-result",
					toolName: "workbench_delegate_worker",
					policyId: "default",
					planned: false,
					allowed: true,
					allocatedBytes: 2_048,
					controlAllocatedBytes: 0,
				}),
				authorizeOutput: () => ({}) as never,
				takeTrustedIngressAuthority: () => undefined,
				turnOutputBudget: { consumeResult: () => ({ accepted: true }) } as never,
				observeOutputEnvelope: () => {},
				rememberProcessedNormalResult: () => {},
				pendingReceiptHandles: new Map(),
				pendingCheckoutOperationHandles: pending,
				releaseCheckoutOperation: async (lease) => {
					if (fault === "pre-unlink") {
						return { ok: false, error: { code: "storage_failure", message: "injected pre-unlink fault" } };
					}
					return releaseProjectCheckoutOperationV1(lease, {
						release_start_lock: async (...args) => {
							const released = await releaseProjectDelegationStartLockV1(...args);
							return released.ok
								? { ok: false, error: { code: "storage_failure", message: "injected post-unlink fault", operation: "release" } }
								: released;
						},
					});
				},
				secrets: [],
			});
			const event = {
				toolCallId: "faulted-result",
				toolName: "workbench_delegate_worker",
				input: {},
				content: [{ type: "text", text: "durable result" }],
				isError: false,
				details: { delegation_id: DELEGATION_ID },
			};
			for (const handler of events.get("tool_result") ?? []) await handler(event, context());
			assert.equal(pending.size, 0);
			assert.equal(inspectProcessCheckoutOperationV1(root, first.value.token), "settled");

			const next = await acquireProjectCheckoutOperationV1({
				project_root: root,
				operation_kind: "tool",
				operation_id: `tool:after-${fault}`,
				now: "2026-08-27T12:00:01.000Z",
			});
			assert.equal(next.ok, true, next.ok ? "" : next.error.message);
			if (next.ok) assert.equal((await releaseProjectCheckoutOperationV1(next.value)).ok, true);
		});
	}
});
