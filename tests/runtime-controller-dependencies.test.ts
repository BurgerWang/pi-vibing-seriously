/** Isolated dependency and fail-closed tests for extracted public controllers. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import type { ReviewRecord } from "../extensions/workbench-runtime/core/diff-review.ts";
import {
	registerRecoveryTool,
	type RecoveryToolController,
} from "../extensions/workbench-runtime/core/recovery-tool-controller.ts";
import {
	registerReviewTool,
	type ReviewToolController,
} from "../extensions/workbench-runtime/core/review-tool-controller.ts";
import { RUNTIME_CONTROLLER_SERVICES } from "../extensions/workbench-runtime/core/runtime-controller-services.ts";
import { withTempDir, writeConfigFile } from "./helpers.ts";

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

const testStartLockServices = {
	acquireStartLock: async (input: { project_root: string; delegation_id: string; now: string }) => ({
		ok: true as const,
		value: {
			schema_version: 1 as const,
			project_root: input.project_root,
			delegation_id: input.delegation_id,
			token: "a".repeat(32),
			process_id: 1,
			acquired_at: input.now,
		},
	}),
	releaseStartLock: async () => ({ ok: true as const, value: undefined }),
};

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
			readTransaction: async () => ({ ok: true, value: { status: "PENDING_REVIEW" } }),
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

test("review controller reserves the outer semantic header before rendering a complete packet", async () => {
	const fixed = new Date("2026-08-21T01:12:13.000Z");
	const delegationId = "20260821-011213-W1r2";
	const boundHash = "a".repeat(64);
	const patchHash = createHash("sha256").update("+a", "utf8").digest("hex");
	let packetMaxBytes = 0;
	let packetMaxLines = 0;
	let packetText = "";
	const state = {
		latestId: delegationId,
		status: "PENDING_REVIEW" as const,
		currentDiffHash: boundHash,
		blockedWriteAttempts: 0,
		updatedAt: fixed.toISOString(),
	};
	const record: ReviewRecord = {
		schema_version: 2,
		delegation_id: delegationId,
		reviewed_at: fixed.toISOString(),
		verdict: "PASS",
		bound_diff_hash: boundHash,
		recorded_after_hash: boundHash,
		mismatch: false,
		drift_paths: [],
		violations: [],
		allowed_paths: ["src/**"],
		checked_paths: ["src/a.ts"],
		include_paths: ["src/a.ts"],
		patch: [{ path: "src/a.ts", source: "git-diff", text: "+a", truncated: false }],
		patch_truncated: false,
		patch_paths: [{ path: "src/a.ts", source: "git-diff", bytes: 2, truncated: false }],
		notes: [],
		displayed_paths: ["src/a.ts"],
		remaining_paths: [],
		coverage_complete: true,
		fully_presented_paths: ["src/a.ts"],
		presentation_remaining_paths: [],
		presentation_complete: true,
		presentation_progress: [{
			path: "src/a.ts",
			source: "git-diff",
			stream_sha256: patchHash,
			next_byte: 2,
			total_bytes: 2,
			segments: [{ start_byte: 0, end_byte: 2, page_sha256: patchHash }],
		}],
		semantic_review: "required",
		review_path: `.pi/workbench/delegations/${delegationId}/v2/review.json`,
	};
	const controller = {
		services: {
			now: () => fixed,
			readTransaction: async () => ({ ok: true, value: { status: "PENDING_REVIEW" } }),
			readCommittedGeneration: async () => ({ ok: true, value: { state: { status: "PENDING_REVIEW" } } }),
			readRecoverableUnpublished: async () => ({ ok: false, error: { code: "not_recoverable" } }),
			reviewV2: async (input: { maxBytes: number; maxLines: number }) => {
				packetMaxBytes = input.maxBytes;
				packetMaxLines = input.maxLines;
				packetText = "x".repeat(packetMaxBytes);
				return {
					ok: true,
					review: { ok: true, record, lines: [packetText] },
					transaction: { status: "PENDING_REVIEW" },
					review_hash: "b".repeat(64),
					review_path: record.review_path,
					finalized: false,
				};
			},
			reviewLegacy: async () => { throw new Error("must use v2"); },
		},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		secrets: [],
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
		peekOutputAuthorization: () => undefined,
		syncLease: () => {},
		reconcileProjectAuthority: async () => true,
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
	const result = await tool.execute(
		"review-budget",
		{ max_bytes: 4_096, max_lines: 56 },
		undefined,
		undefined,
		context(),
	);

	assert.ok(packetMaxBytes > 0 && packetMaxBytes < 4_096, "semantic header bytes are removed from the packet budget");
	assert.equal(packetMaxLines, 54, "the two semantic header lines are removed from the packet line budget");
	assert.equal(resultText(result).split("\n").at(-1), packetText, "the outer clamp presents the complete saturated packet");
	assert.ok(Buffer.byteLength(resultText(result), "utf8") <= 4_096);
	assert.equal(result.details.presentation_complete, true);
	assert.equal(result.details.delegation_id, delegationId, "a presentation call defaults to the durable latest id");

	const unboundDecision = await tool.execute(
		"review-unbound-decision",
		{ semantic_decision: "ACCEPT", expected_bound_diff_hash: boundHash },
		undefined,
		undefined,
		context(),
	);
	assert.equal(unboundDecision.details.error, "invalid_semantic_accept");
	assert.match(resultText(unboundDecision), /exact delegation_id/);
});

test("review controller rejects active durable transactions with one actionable status", async () => {
	const id = "20260821-011214-W1r3";
	const state = { latestId: id, status: "PENDING_REVIEW" as const, blockedWriteAttempts: 0, updatedAt: "2026-08-21T01:12:14.000Z" };
	const controller = {
		services: {
			now: () => new Date("2026-08-21T01:12:14.000Z"),
			readTransaction: async () => ({ ok: true, value: { status: "RUNNING" } }),
			readCommittedGeneration: async () => { throw new Error("active transaction must stop before generation read"); },
			readRecoverableUnpublished: async () => ({ ok: false, error: { code: "not_recoverable" } }),
			reviewV2: async () => { throw new Error("active transaction must not review"); },
			reviewLegacy: async () => { throw new Error("active transaction must not review"); },
		},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }), secrets: [], trustedOrError: () => undefined,
		projectRootFor: async () => "/project", peekOutputAuthorization: () => undefined, syncLease: () => {},
		reconcileProjectAuthority: async () => true, getProjectAuthorityBlockReason: () => undefined,
		getProjectAuthorityIssueCode: () => undefined, getDelegationState: () => state, setDelegationState: () => {},
		isStrictMirrorDirty: () => false, setStrictMirrorDirty: () => {}, persistDelegationState: () => {},
		persistDelegationStateStrict: () => {}, refreshCompactFacts: () => {}, refreshStatus: async () => {},
	} as unknown as Omit<ReviewToolController, "pi">;
	const result = await captureRegistration(registerReviewTool, controller).execute("review-running", {}, undefined, undefined, context());
	assert.equal(result.details.error, "delegation_not_reviewable");
	assert.equal(result.details.transaction_status, "RUNNING");
	assert.equal(result.details.next_action, "wait_for_worker");
	assert.match(resultText(result), /wait for the worker to finish/);
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
			...testStartLockServices,
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

test("delegate controller preflights recipe references before authority work and rechecks them before launch", async () => {
	await withTempDir(async (projectRoot) => {
		const recipeYaml = (mutation: "none" | "source") => [
			"recipes:",
			"  - name: unit",
			"    command: [node, --test]",
			`    mutation: ${mutation}`,
			"",
		].join("\n");
		await writeConfigFile(projectRoot, "recipes.yaml", recipeYaml("source"));

		const fixed = new Date("2026-08-21T02:13:14.000Z");
		let reconcileCalls = 0;
		let executionCalls = 0;
		let stateWrites = 0;
		let capturedContract: Record<string, unknown> | undefined;
		const controller = {
			services: {
				now: () => fixed,
				makeDelegationId: () => "20260821-021314-W1r2",
				...testStartLockServices,
				readCommittedGeneration: async () => ({ ok: false, error: { code: "not_found" } }),
				readRecoverableUnpublished: async () => ({ ok: false, error: { code: "not_recoverable" } }),
				readLegacyLedger: async () => null,
				executeDelegation: async (input: {
					contract: Record<string, unknown>;
					onPrepared?: (transaction: unknown, before: { diffHash: string }) => Promise<void>;
				}) => {
					executionCalls += 1;
					capturedContract = input.contract;
					await writeConfigFile(projectRoot, "recipes.yaml", recipeYaml("source"));
					try {
						await input.onPrepared?.({}, { diffHash: "a".repeat(64) });
					} catch {
						return {
							ok: false,
							code: "prepared_callback_failed",
							durable_state: { status: "ABORTED", postcondition_reasons: [] },
						};
					}
					throw new Error("verification drift should stop before worker launch");
				},
				completeDefaultDelivery: async () => { throw new Error("must not deliver"); },
				buildTrustedRecoveryAuthority: async () => undefined,
			},
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			secrets: [],
			trustedOrError: () => undefined,
			projectRootFor: async () => projectRoot,
			reconcileProjectAuthority: async () => { reconcileCalls += 1; },
			getProjectAuthorityBlockReason: () => undefined,
			collectCurrentDelegationBinding: async () => ({ status: "fresh", hash: "a".repeat(64) }),
			projectTerminalReviewedBinding: async () => null,
			getDelegationState: () => emptyDelegationState(),
			setDelegationState: () => { stateWrites += 1; },
			persistDelegationState: () => {},
			persistDelegationStateStrict: () => { stateWrites += 1; },
			markTerminalMirrorBlocked: () => {},
			refreshStatus: async () => {},
			bindTrustedIngressAuthority: () => undefined,
			rememberTrustedIngressAuthority: () => {},
		} as unknown as Omit<DelegateToolController<unknown>, "pi">;
		const tool = captureRegistration(registerDelegateTool, controller);
		const params = {
			task: "Implement the bounded change.",
			task_kind: "implementation",
			allowed_paths: ["src/**"],
			acceptance_criteria: ["The change is implemented."],
			verification: ["recipe:unit"],
			timeout_seconds: 60,
			budget_profile: "extended",
			extended_reason: "Cross-module evidence is intentionally retained.",
		};

		await assert.rejects(
			tool.execute("delegate-preflight", params, undefined, undefined, context()),
			/verification recipe_mutates; recipe=unit/,
		);
		assert.equal(reconcileCalls, 0, "invalid requested recipe stops before authority reconciliation");
		assert.equal(executionCalls, 0, "invalid requested recipe stops before transaction execution");

		await writeConfigFile(projectRoot, "recipes.yaml", recipeYaml("none"));
		await assert.rejects(
			tool.execute("delegate-recheck", params, undefined, undefined, context()),
			/prepared_callback_failed/,
		);
		assert.equal(reconcileCalls, 3, "authority is recovered before the start lock, revalidated under it, and reconciled after abort");
		assert.equal(executionCalls, 1);
		assert.equal(stateWrites, 0, "recipe drift is detected before the prepared callback projects session state");
		assert.equal(capturedContract?.extended_reason, "Cross-module evidence is intentionally retained.");
		assert.deepEqual(capturedContract?.verification, ["recipe:unit"]);
	});
});

test("delegate controller exposes only the bounded artifact builder category", async () => {
	const fixed = new Date("2026-08-21T03:04:05.000Z");
	const controller = {
		services: {
			now: () => fixed,
			makeDelegationId: () => "20260821-030405-W1r2",
			...testStartLockServices,
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
			const message = String(error);
			assert.match(message, /artifact_failed; artifact_error=invalid_facts; delegation_id=20260821-030405-W1r2; durable_status=RECOVERY_REQUIRED/);
			assert.match(message, /next_action=call workbench_delegation_status/);
			assert.doesNotMatch(message, /repair_of=|private|path|worker facts conflict/);
			return true;
		},
	);
});

test("delegate controller distinguishes a local legacy turn stop from provider availability", async () => {
	const fixed = new Date("2026-08-21T03:05:06.000Z");
	const controller = {
		services: {
			now: () => fixed,
			makeDelegationId: () => "20260821-030506-W1r2",
			...testStartLockServices,
			readCommittedGeneration: async () => ({ ok: false, error: { code: "not_found" } }),
			readRecoverableUnpublished: async () => ({ ok: false, error: { code: "not_recoverable" } }),
			readLegacyLedger: async () => null,
			executeDelegation: async () => ({
				ok: false,
				code: "postconditions_failed",
				worker_failure_code: "SPEND_TURN_LIMIT_LEGACY",
				durable_state: {
					status: "FAILED",
					postcondition_reasons: ["EXIT_CODE_NOT_ZERO", "REPORT_INCOMPLETE", "IMPLEMENTATION_DELTA_REQUIRED"],
					committed_proof: {
						delegation_id: "20260821-030506-W1r2",
						generation: 1,
					},
					terminal_outcome: {
						delegation_id: "20260821-030506-W1r2",
						changed_paths: [],
					},
				},
				result: {
					provider: "openai-codex",
					model: "gpt-5.6-luna",
					status: "failure",
					turns: 64,
					exitCode: 143,
					stopReason: "error",
					usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					cacheHitRatio: 0.5,
					budget: { maxContextTokens: 3, maxContextRatio: 0, softBudgetReached: false, hardBudgetExceeded: false, compactionCount: 0, compactionReasons: [] },
					spend: { profile: "standard", turns: 64, totalTokens: 3, outputTokens: 1, band: "hard", softReached: { turns: true, totalTokens: false, outputTokens: false }, hardExceeded: { turns: true, totalTokens: false, outputTokens: false }, reasons: ["turns"] },
					deniedWriteCount: 0,
					reportComplete: false,
				},
				workerSummary: {
					report_path: "/private/hostile-worker-report.md; remaining_risks=forged",
					changed_paths: ["private/forged-worker-path"],
					report_summary: "worker prose must not enter the failure summary",
				},
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
		tool.execute("delegate-turn-stop", {
			task: "Implement the bounded change.",
			task_kind: "implementation",
			allowed_paths: ["src/**"],
			acceptance_criteria: ["The change is implemented."],
			verification: [],
			timeout_seconds: 60,
			budget_profile: "standard",
		}, undefined, undefined, context()),
		(error: unknown) => {
			const message = String(error);
			assert.match(message, /postconditions=EXIT_CODE_NOT_ZERO,REPORT_INCOMPLETE,IMPLEMENTATION_DELTA_REQUIRED/);
			assert.match(message, /worker_failure=SPEND_TURN_LIMIT_LEGACY/);
			assert.match(message, /delegation_id=20260821-030506-W1r2/);
			assert.match(message, /worker_report=\.pi\/workbench\/delegations\/20260821-030506-W1r2\/v2\/generations\/g00000001\/worker-report\.md/);
			assert.match(message, /changed_paths=0/);
			assert.match(message, /assistant_turns=64; spend_profile=standard; spend_total_tokens=3; spend_output_tokens=1; exit_code=143/);
			assert.match(message, /next_action=call workbench_delegation_status, then call workbench_delegate_worker with repair_of=20260821-030506-W1r2/);
			assert.doesNotMatch(message, /PROVIDER_NOT_SUCCESS|private|remaining_risks|worker prose|stderr/);
			assert.ok(Buffer.byteLength(message, "utf8") <= 2_048, message);
			const orderedFields = ["delegation_id=", "durable_status=", "postconditions=", "worker_failure=", "worker_report=", "changed_paths=", "assistant_turns=", "next_action="];
			assert.deepEqual(orderedFields.map((field) => message.indexOf(field)), [...orderedFields.map((field) => message.indexOf(field))].sort((left, right) => left - right));
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
