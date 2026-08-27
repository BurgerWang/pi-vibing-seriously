import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	automaticSemanticReviewCommandDelegationId,
	registerAutomaticSemanticReviewCommand,
} from "../extensions/workbench-runtime/core/automatic-semantic-review-command.ts";
import type { AutomaticSemanticReviewInput } from "../extensions/workbench-runtime/core/automatic-semantic-review-service.ts";

const ID = "20260827-050505-qrev";

interface CapturedCommand {
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

function context(onWait: () => void, onSend: () => void): ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/project",
		isProjectTrusted: () => true,
		model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-codex-responses" },
		modelRegistry: {},
		waitForIdle: async () => { onWait(); },
		sendUserMessage: () => { onSend(); },
		ui: { notify: () => {} },
	} as unknown as ExtensionCommandContext;
}

test("q-review accepts exactly one canonical delegation id", () => {
	assert.equal(automaticSemanticReviewCommandDelegationId(` ${ID} `), ID);
	assert.equal(automaticSemanticReviewCommandDelegationId(`${ID} extra`), undefined);
});

test("q-review directly invokes the shared service after waitForIdle and never sends a user message", async () => {
	let command: CapturedCommand | undefined;
	let waits = 0;
	let sends = 0;
	let calls = 0;
	const output: string[] = [];
	registerAutomaticSemanticReviewCommand({
		pi: { registerCommand(_name: string, definition: unknown) { command = definition as CapturedCommand; } } as never,
		review: (async (input: AutomaticSemanticReviewInput) => {
			calls += 1;
			assert.equal(input.delegation_id, ID);
			return {
				status: "RETRYABLE_FAILURE",
				code: "MODEL_UNAVAILABLE",
				delegation_id: ID,
				bound_diff_hash: "a".repeat(64),
				nested_usage: {
					input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				mechanical_page_calls: 1,
				next_action: `/q-review ${ID}`,
			};
		}) as never,
		runCheckoutOperation: (async (_input: unknown, run: () => Promise<unknown>) => ({ ok: true, value: await run(), release: "released" })) as never,
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		secrets: [],
		getMode: () => "DEV",
		runtimeCurrentOrError: () => undefined,
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
		reconcileProjectAuthority: async () => true,
		getDelegationState: () => ({ latestId: ID, status: "PENDING_REVIEW", currentDiffHash: "a".repeat(64), blockedWriteAttempts: 0, updatedAt: "2026-08-27T05:05:05.000Z" }),
		persistDelegationStateStrict: () => assert.fail("retryable review must not project ACCEPT"),
		output: (_ctx, lines) => { output.push(lines.join("\n")); },
	});
	assert.ok(command);
	await command.handler(ID, context(() => { waits += 1; }, () => { sends += 1; }));
	assert.equal(waits, 1);
	assert.equal(calls, 1);
	assert.equal(sends, 0);
	assert.match(output.join("\n"), /MODEL_UNAVAILABLE/u);
	assert.match(output.join("\n"), /nested_usage: input=3/u);
	assert.match(output.join("\n"), new RegExp(`/q-review ${ID}`, "u"));
});

test("q-review rejects stale runtime before trust or service execution", async () => {
	let command: CapturedCommand | undefined;
	let trustChecks = 0;
	let calls = 0;
	const output: string[] = [];
	registerAutomaticSemanticReviewCommand({
		pi: { registerCommand(_name: string, definition: unknown) { command = definition as CapturedCommand; } } as never,
		review: (async () => { calls += 1; throw new Error("must not run"); }) as never,
		runCheckoutOperation: (async () => assert.fail("stale runtime must not acquire a checkout lane")) as never,
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		secrets: [],
		getMode: () => "DEV",
		runtimeCurrentOrError: () => "loaded workbench runtime is STALE",
		trustedOrError: () => { trustChecks += 1; return undefined; },
		projectRootFor: async () => "/project",
		reconcileProjectAuthority: async () => true,
		getDelegationState: () => ({ status: "PENDING_REVIEW", blockedWriteAttempts: 0, updatedAt: "" }),
		persistDelegationStateStrict: () => {},
		output: (_ctx, lines) => { output.push(lines.join("\n")); },
	});
	assert.ok(command);
	await command.handler(ID, context(() => {}, () => {}));
	assert.equal(trustChecks, 0);
	assert.equal(calls, 0);
	assert.match(output.join("\n"), /runtime is STALE/u);
});

test("q-review executes the mechanical FAIL route without a model turn and reports bounded manual repair", async () => {
	let command: CapturedCommand | undefined;
	let sends = 0;
	const output: string[] = [];
	registerAutomaticSemanticReviewCommand({
		pi: { registerCommand(_name: string, definition: unknown) { command = definition as CapturedCommand; } } as never,
		review: (async () => ({
			status: "RETRYABLE_FAILURE",
			code: "MECHANICAL_SCOPE_INTEGRITY_FAILED",
			delegation_id: ID,
			bound_diff_hash: "a".repeat(64),
			nested_usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			mechanical_page_calls: 0,
			next_action: `inspect bounded scope violations for ${ID}`,
		})) as never,
		runCheckoutOperation: (async (_input: unknown, run: () => Promise<unknown>) => ({ ok: true, value: await run(), release: "released" })) as never,
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		secrets: [],
		getMode: () => "DEV",
		runtimeCurrentOrError: () => undefined,
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
		reconcileProjectAuthority: async () => true,
		getDelegationState: () => ({ latestId: ID, status: "PENDING_REVIEW", currentDiffHash: "a".repeat(64), blockedWriteAttempts: 0, updatedAt: "2026-08-27T05:05:05.000Z" }),
		persistDelegationStateStrict: () => assert.fail("mechanical FAIL must not project ACCEPT"),
		output: (_ctx, lines) => { output.push(lines.join("\n")); },
	});
	assert.ok(command);
	await command.handler(ID, context(() => {}, () => { sends += 1; }));
	assert.equal(sends, 0);
	assert.match(output.join("\n"), /MECHANICAL_SCOPE_INTEGRITY_FAILED/u);
	assert.match(output.join("\n"), /automatic ACCEPT is forbidden/u);
});
