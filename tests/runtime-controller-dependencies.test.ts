/** Isolated dependency and fail-closed tests for extracted public controllers. */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	registerCompareTool,
	type CompareToolController,
} from "../extensions/workbench-runtime/core/compare-tool-controller.ts";
import {
	registerDelegateTool,
	type DelegateToolController,
} from "../extensions/workbench-runtime/core/delegate-tool-controller.ts";
import { emptyDelegationState } from "../extensions/workbench-runtime/core/delegation-state.ts";
import {
	registerRecoveryTool,
	type RecoveryToolController,
} from "../extensions/workbench-runtime/core/recovery-tool-controller.ts";
import {
	registerReviewTool,
	type ReviewToolController,
} from "../extensions/workbench-runtime/core/review-tool-controller.ts";
import { RUNTIME_CONTROLLER_SERVICES } from "../extensions/workbench-runtime/core/runtime-controller-services.ts";

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details: Record<string, unknown>;
}

interface CapturedTool {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
}

function captureRegistration(register: (controller: never) => void, controller: object): CapturedTool {
	let captured: CapturedTool | undefined;
	register({
		...controller,
		pi: {
			registerTool(definition: unknown) {
				captured = definition as CapturedTool;
			},
		},
	} as never);
	assert.ok(captured);
	return captured;
}

function context(): ExtensionContext {
	return {
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
}

function resultText(result: ToolResult): string {
	return result.content.map((item) => item.text ?? "").join("\n");
}

test("compare controller uses injected comparison service and preserves bounded failure", async () => {
	let authorityCalls = 0;
	const controller = {
		services: {
			compareRuns: async () => ({ ok: false, error: "missing_run" }),
			buildTrustedRecoveryAuthority: async () => {
				authorityCalls += 1;
				return undefined;
			},
		},
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
		bindTrustedIngressAuthority: () => undefined,
		rememberTrustedIngressAuthority: () => {},
	} as unknown as Omit<CompareToolController<unknown>, "pi">;
	const tool = captureRegistration(registerCompareTool, controller);

	const result = await tool.execute("compare-1", { a: "run-a", b: "run-b" }, undefined, undefined, context());

	assert.equal(result.details.ok, false);
	assert.equal(result.details.error, "missing_run");
	assert.match(resultText(result), /missing_run/);
	assert.equal(authorityCalls, 0);
});

test("recovery controller uses injected storage and reports missing without filesystem access", async () => {
	const calls: unknown[] = [];
	const controller = {
		services: {
			recoverReceipt: async (input: unknown) => {
				calls.push(input);
				return { ok: false, kind: "missing" } as const;
			},
		},
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
	} as unknown as Omit<RecoveryToolController, "pi">;
	const tool = captureRegistration(registerRecoveryTool, controller);
	const resultId = `wtr1-${"a".repeat(64)}`;

	const result = await tool.execute("recover-1", { result_id: resultId }, undefined, undefined, context());

	assert.deepEqual(calls, [{ projectRoot: "/project", id: resultId }]);
	assert.deepEqual(result.details, { ok: false, available: false, code: "missing", result_id: resultId });
});

test("review controller refuses corrupt v2 authority and never falls back to legacy", async () => {
	let legacyCalls = 0;
	const fixed = new Date("2026-08-21T01:02:03.000Z");
	let reconciledAt = "";
	const state = {
		latestId: "20260821-010203-W1r2",
		status: "PENDING_REVIEW" as const,
		currentDiffHash: "a".repeat(64),
		blockedWriteAttempts: 0,
		updatedAt: fixed.toISOString(),
	};
	const controller = {
		services: {
			now: () => fixed,
			readCommittedGeneration: async () => ({
				ok: false,
				error: { code: "invalid_record", message: "private storage detail" },
			}),
			readRecoverableUnpublished: async () => ({ ok: false, error: { code: "not_recoverable" } }),
			reviewV2: async () => { throw new Error("must not review invalid authority"); },
			reviewLegacy: async () => {
				legacyCalls += 1;
				throw new Error("must not fall back");
			},
		},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		secrets: [],
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
		peekOutputAuthorization: () => undefined,
		syncLease: () => {},
		reconcileProjectAuthority: async (_root: string, now: string) => { reconciledAt = now; },
		getProjectAuthorityBlockReason: () => undefined,
		getProjectAuthorityIssueCode: () => undefined,
		getDelegationState: () => state,
		setDelegationState: () => {},
		isStrictMirrorDirty: () => false,
		setStrictMirrorDirty: () => {},
		persistDelegationState: () => {},
		persistDelegationStateStrict: () => {},
		refreshCompactFacts: () => {},
		refreshStatus: async () => {},
	} as unknown as Omit<ReviewToolController, "pi">;
	const tool = captureRegistration(registerReviewTool, controller);

	const result = await tool.execute("review-1", { delegation_id: state.latestId }, undefined, undefined, context());

	assert.equal(reconciledAt, fixed.toISOString());
	assert.equal(legacyCalls, 0);
	assert.equal(result.details.error, "invalid_record");
	assert.equal(result.details.authority_version, 2);
	assert.doesNotMatch(resultText(result), /private storage detail/);
});

test("delegate controller refuses unavailable repair authority before execution", async () => {
	const fixed = new Date("2026-08-21T02:03:04.000Z");
	let legacyCalls = 0;
	let executionCalls = 0;
	let reconcileTime = "";
	const controller = {
		services: {
			now: () => fixed,
			makeDelegationId: () => "20260821-020304-W1r2",
			readCommittedGeneration: async () => ({
				ok: false,
				error: { code: "storage_failure", message: "private disk path" },
			}),
			readLegacyLedger: async () => {
				legacyCalls += 1;
				return null;
			},
			readRecoverableUnpublished: async () => ({ ok: false, error: { code: "not_recoverable" } }),
			executeDelegation: async () => {
				executionCalls += 1;
				throw new Error("must not execute");
			},
			completeDefaultDelivery: async () => { throw new Error("must not deliver"); },
			buildTrustedRecoveryAuthority: async () => undefined,
		},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		secrets: [],
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
		reconcileProjectAuthority: async (_root: string, now: string) => { reconcileTime = now; },
		getProjectAuthorityBlockReason: () => undefined,
		collectCurrentDelegationBinding: async () => ({ status: "fresh", hash: "a".repeat(64) }),
		projectTerminalReviewedBinding: async () => null,
		getDelegationState: () => emptyDelegationState(),
		setDelegationState: () => {},
		persistDelegationState: () => {},
		persistDelegationStateStrict: () => {},
		markTerminalMirrorBlocked: () => {},
		refreshStatus: async () => {},
		bindTrustedIngressAuthority: () => undefined,
		rememberTrustedIngressAuthority: () => {},
	} as unknown as Omit<DelegateToolController<unknown>, "pi">;
	const tool = captureRegistration(registerDelegateTool, controller);

	await assert.rejects(
		tool.execute("delegate-1", {
			task: "Diagnose the bounded issue.",
			task_kind: "diagnosis",
			allowed_paths: ["src/**"],
			acceptance_criteria: ["The issue is diagnosed."],
			verification: [],
			timeout_seconds: 60,
			repair_of: "20260820-130000-W1r2",
		}, undefined, undefined, context()),
		(error: unknown) => {
			assert.match(String(error), /v2 authority is storage_failure/);
			assert.doesNotMatch(String(error), /private disk path/);
			return true;
		},
	);
	assert.equal(reconcileTime, fixed.toISOString());
	assert.equal(legacyCalls, 0);
	assert.equal(executionCalls, 0);
});

test("delegate controller exposes only the bounded artifact builder category", async () => {
	const fixed = new Date("2026-08-21T03:04:05.000Z");
	const controller = {
		services: {
			now: () => fixed,
			makeDelegationId: () => "20260821-030405-W1r2",
			readCommittedGeneration: async () => ({ ok: false, error: { code: "not_found" } }),
			readRecoverableUnpublished: async () => ({ ok: false, error: { code: "not_recoverable" } }),
			readLegacyLedger: async () => null,
			executeDelegation: async () => ({
				ok: false,
				code: "artifact_failed",
				artifact_error_code: "invalid_facts",
				durable_state: { status: "RECOVERY_REQUIRED", postcondition_reasons: [] },
			}),
			completeDefaultDelivery: async () => { throw new Error("must not deliver"); },
			buildTrustedRecoveryAuthority: async () => undefined,
		},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		secrets: [],
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
		reconcileProjectAuthority: async () => true,
		getProjectAuthorityBlockReason: () => undefined,
		collectCurrentDelegationBinding: async () => ({ status: "fresh", hash: "a".repeat(64) }),
		projectTerminalReviewedBinding: async () => null,
		getDelegationState: () => emptyDelegationState(),
		setDelegationState: () => {},
		persistDelegationState: () => {},
		persistDelegationStateStrict: () => {},
		markTerminalMirrorBlocked: () => {},
		refreshStatus: async () => {},
		bindTrustedIngressAuthority: () => undefined,
		rememberTrustedIngressAuthority: () => {},
	} as unknown as Omit<DelegateToolController<unknown>, "pi">;
	const tool = captureRegistration(registerDelegateTool, controller);

	await assert.rejects(
		tool.execute("delegate-artifact", {
			task: "Implement the bounded change.",
			task_kind: "implementation",
			allowed_paths: ["src/**"],
			acceptance_criteria: ["The change is implemented."],
			verification: [],
			timeout_seconds: 60,
		}, undefined, undefined, context()),
		(error: unknown) => {
			assert.match(String(error), /artifact_failed; artifact_error=invalid_facts; durable_status=RECOVERY_REQUIRED/);
			assert.doesNotMatch(String(error), /private|path|worker facts conflict/);
			return true;
		},
	);
});

test("production controller service bundle is immutable and complete", () => {
	assert.ok(Object.isFrozen(RUNTIME_CONTROLLER_SERVICES));
	for (const services of Object.values(RUNTIME_CONTROLLER_SERVICES)) assert.ok(Object.isFrozen(services));
	assert.equal(typeof RUNTIME_CONTROLLER_SERVICES.delegate.now, "function");
	assert.equal(typeof RUNTIME_CONTROLLER_SERVICES.delegate.readRecoverableUnpublished, "function");
	assert.equal(typeof RUNTIME_CONTROLLER_SERVICES.review.reviewV2, "function");
	assert.equal(typeof RUNTIME_CONTROLLER_SERVICES.compare.compareRuns, "function");
	assert.equal(typeof RUNTIME_CONTROLLER_SERVICES.recovery.recoverReceipt, "function");
});
