/**
 * P5 state-recovery tests.
 *
 * Pi emits `session_start` with reason "startup" | "reload" | "new" |
 * "resume" | "fork" (fork also covers /clone). The workbench restores mode
 * and key task state from Pi custom entries in every case; a fresh /new
 * session (fresh session file) falls back to the DEV default. /fork and
 * /clone copy the session file, so the custom entries travel with them.
 *
 * These tests exercise the real extension wiring (index.ts) through a stub
 * ExtensionAPI: session_start restore, before_agent_start tracking, and the
 * session_before_compact supplement and Commander capacity preflight.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { COMPACT_NOTE_MESSAGE_TYPE, COMPACT_STATE_ENTRY_TYPE, type CompactState } from "../extensions/workbench-runtime/core/compact.ts";
import { MODE_ENTRY_TYPE } from "../extensions/workbench-runtime/core/state.ts";
import { WORKER_ALLOWED_PATHS_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ROLE_ENV } from "../extensions/workbench-runtime/core/worker-policy.ts";
import {
	confirmLease,
	issueLease,
	LEASE_STATE_ENTRY_TYPE,
	MAX_LEASE_DURATION_MS,
	revokeLease,
	serializeLease,
	STRICT_SOL_DEV_ALLOWLIST,
} from "../extensions/workbench-runtime/core/write-authority.ts";
import {
	emptyDelegationState,
	DELEGATION_STATE_ENTRY_TYPE,
	loadDelegationStateFromEntries,
	markReviewed,
	recordDelegation,
	serializeDelegationState,
} from "../extensions/workbench-runtime/core/delegation-state.ts";
import {
	WORKER_HARD_BUDGET,
	WORKER_SOFT_BUDGET,
	WORKER_SOFT_STEER_MESSAGE_TYPE,
} from "../extensions/workbench-runtime/core/worker-budget.ts";
import {
	WORKER_SPEND_PROFILE_ENV,
	WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE,
} from "../extensions/workbench-runtime/core/worker-spend.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

interface StubAPI {
	commands: Map<string, unknown>;
	tools: Map<string, unknown>;
	events: Map<string, Array<(event: never, ctx: never) => unknown>>;
	entries: Array<{ type: string; customType: string; data?: unknown }>;
	messages: Array<{ customType: string; content: string; display: boolean; options?: unknown }>;
	activeTools: string[];
	appendEntryCalls: Array<{ customType: string; data: unknown }>;
	notifications: Array<{ message: string; level: string | undefined }>;
}

function makeStub(): StubAPI & ExtensionAPI {
	const stub: StubAPI & ExtensionAPI = {
		commands: new Map(),
		tools: new Map(),
		events: new Map(),
		entries: [],
		messages: [],
		activeTools: [],
		appendEntryCalls: [],
		notifications: [],
		registerCommand: (name: string, def: unknown) => {
			stub.commands.set(name, def);
		},
		registerTool: (def: { name: string }) => {
			stub.tools.set(def.name, def);
		},
		on: (event: string, handler: (event: never, ctx: never) => unknown) => {
			const list = stub.events.get(event) ?? [];
			list.push(handler);
			stub.events.set(event, list);
		},
		appendEntry: (customType: string, data: unknown) => {
			stub.entries.push({ type: "custom", customType, data });
			stub.appendEntryCalls.push({ customType, data });
		},
		sendMessage: (message: { customType: string; content: string; display: boolean }, options?: unknown) => {
			stub.messages.push({ ...message, options });
		},
		sendUserMessage: () => {},
		setActiveTools: (tools: string[]) => {
			stub.activeTools = [...tools];
		},
		getActiveTools: () => stub.activeTools,
		getAllTools: () => [...stub.tools.values()] as never[],
		getThinkingLevel: () => "high" as never,
		exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
	} as unknown as StubAPI & ExtensionAPI;
	return stub;
}

function fakeCtx(entries: StubAPI["entries"], overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		mode: "tui",
		hasUI: false,
		cwd: "/tmp/workbench-project",
		isProjectTrusted: () => false,
		sessionManager: {
			getEntries: () => entries.map((e) => ({ type: e.type, customType: e.customType, data: e.data })),
			getSessionFile: () => "/tmp/workbench-project/session.jsonl",
			getSessionId: () => "stub-session-id",
		} as unknown as ExtensionContext["sessionManager"],
		model: undefined,
		thinkingLevel: undefined,
		ui: {
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => false,
		} as unknown as ExtensionContext["ui"],
		signal: undefined,
		...overrides,
	} as unknown as ExtensionContext;
}

const COMPACT_MODEL = {
	contextWindow: 272_000,
	maxTokens: 128_000,
} as never;

function compactPreparation(history: string, prefix?: string): Record<string, unknown> {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [{ role: "user", content: [{ type: "text", text: history }], timestamp: 1 }],
		turnPrefixMessages: prefix === undefined
			? []
			: [{ role: "user", content: [{ type: "text", text: prefix }], timestamp: 2 }],
		isSplitTurn: prefix !== undefined,
		tokensBefore: 1,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: false, reserveTokens: 27_200, keepRecentTokens: 20_000 },
	};
}

function compactCtx(stub: StubAPI, entries: StubAPI["entries"]): ExtensionContext {
	return fakeCtx(entries, {
		hasUI: true,
		model: COMPACT_MODEL,
		ui: {
			setStatus: () => {},
			setWidget: () => {},
			notify: (message: string, level?: string) => stub.notifications.push({ message, level }),
			confirm: async () => false,
		} as unknown as ExtensionContext["ui"],
	});
}

function entry(customType: string, data: unknown): { type: string; customType: string; data?: unknown } {
	return { type: "custom", customType, data };
}

/** Run a block with the worker role env set, restoring the previous value after. */
function withWorkerRole(fn: () => void): void {
	const previous = process.env[WORKER_ROLE_ENV];
	process.env[WORKER_ROLE_ENV] = "worker";
	try {
		fn();
	} finally {
		if (previous === undefined) delete process.env[WORKER_ROLE_ENV];
		else process.env[WORKER_ROLE_ENV] = previous;
	}
}

/**
 * Run a block with the worker role AND a spend-profile env value set
 * (Phase 2: the fixed child env contract), restoring both after.
 */
function withWorkerRoleAndSpendProfile(profile: string, fn: () => void): void {
	const previousRole = process.env[WORKER_ROLE_ENV];
	const previousProfile = process.env[WORKER_SPEND_PROFILE_ENV];
	process.env[WORKER_ROLE_ENV] = "worker";
	process.env[WORKER_SPEND_PROFILE_ENV] = profile;
	try {
		fn();
	} finally {
		if (previousRole === undefined) delete process.env[WORKER_ROLE_ENV];
		else process.env[WORKER_ROLE_ENV] = previousRole;
		if (previousProfile === undefined) delete process.env[WORKER_SPEND_PROFILE_ENV];
		else process.env[WORKER_SPEND_PROFILE_ENV] = previousProfile;
	}
}

/**
 * Commander tests must never inherit a worker-role env from the harness
 * (the unit tests may run inside a delegated worker process, where
 * WORKBENCH_AGENT_ROLE=worker is set). Clear it before the suite; every
 * worker-role test sets it explicitly through withWorkerRole.
 */
before(() => {
	delete process.env[WORKER_ROLE_ENV];
	delete process.env[WORKER_PROJECT_ROOT_ENV];
	delete process.env[WORKER_ALLOWED_PATHS_ENV];
	delete process.env[WORKER_SPEND_PROFILE_ENV];
});

// ---------------------------------------------------------------------------
// session_start restore wiring
// ---------------------------------------------------------------------------

test("extension registers the expected lifecycle events", () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	for (const event of ["session_start", "session_before_compact", "before_agent_start", "agent_settled", "tool_execution_start", "tool_execution_end", "tool_call"]) {
		assert.ok(stub.events.has(event) && (stub.events.get(event)?.length ?? 0) > 0, `event ${event} registered`);
	}
});

test("session_start restores mode and compact state from custom entries (resume/fork/clone/reload)", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const entries = [
		entry(MODE_ENTRY_TYPE, { mode: "AUDIT" }),
		entry(COMPACT_STATE_ENTRY_TYPE, { task: "verify q3", failedGates: ["q3 (run 20260801-120000-abcd)"], mode: "AUDIT" }),
	];
	const handlers = stub.events.get("session_start");
	assert.ok(handlers && handlers.length > 0);
	await handlers[0]!({ type: "session_start", reason: "resume", previousSessionFile: "/tmp/x.json" } as never, fakeCtx(entries) as never);
	// AUDIT mode tool set applied through the stub
	assert.ok(stub.activeTools.includes("read"));
	assert.ok(!stub.activeTools.includes("bash"));
	// compact state restored: next before_agent_start will carry the task
	const beforeStart = stub.events.get("before_agent_start");
	assert.ok(beforeStart);
	await beforeStart[0]!({ type: "before_agent_start", prompt: "verify gate q3", systemPrompt: "" } as never, fakeCtx(entries) as never);
	const compact = stub.events.get("session_before_compact");
	assert.ok(compact);
	await compact[0]!({ type: "session_before_compact", preparation: {}, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal } as never, fakeCtx(entries) as never);
	assert.ok(stub.appendEntryCalls.some((c) => c.customType === COMPACT_STATE_ENTRY_TYPE), "state persisted as custom entry");
	assert.ok(stub.messages.length > 0, "supplement message sent");
	assert.equal(stub.messages[0]?.customType, COMPACT_NOTE_MESSAGE_TYPE);
	assert.equal(stub.messages[0]?.display, false, "hidden from the TUI");
	const note = stub.messages[0]?.content ?? "";
	assert.ok(note.includes("verify gate q3"));
	assert.ok(note.includes("q3 (run 20260801-120000-abcd)"));
});

test("fresh session (reason=new) falls back to the DEV default", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const handlers = stub.events.get("session_start");
	await handlers![0]!({ type: "session_start", reason: "new" } as never, fakeCtx([]) as never);
	assert.ok(stub.activeTools.includes("bash"), "DEV tools active for a fresh session");
});

test("unknown Commander preflight preserves Pi compaction and never replaces it", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const beforeStart = stub.events.get("before_agent_start");
	await beforeStart![0]!({ type: "before_agent_start", prompt: "do something", systemPrompt: "" } as never, fakeCtx([]) as never);
	const compact = stub.events.get("session_before_compact");
	const result = await compact![0]!({ type: "session_before_compact", preparation: {}, branchEntries: [], reason: "threshold", willRetry: true, signal: new AbortController().signal } as never, fakeCtx([]) as never);
	assert.equal(result, undefined, "no cancel, no replacement compaction");
});

test("session_before_compact stays silent when there is nothing to supplement", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const compact = stub.events.get("session_before_compact");
	await compact![0]!({ type: "session_before_compact", preparation: {}, branchEntries: [], reason: "threshold", willRetry: false, signal: new AbortController().signal } as never, fakeCtx([]) as never);
	assert.equal(stub.messages.length, 0, "no note without meaningful state");
	assert.equal(stub.appendEntryCalls.length, 0);
});

test("compaction notes are deduplicated", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const beforeStart = stub.events.get("before_agent_start");
	await beforeStart![0]!({ type: "before_agent_start", prompt: "same task", systemPrompt: "" } as never, fakeCtx([]) as never);
	const compact = stub.events.get("session_before_compact");
	await compact![0]!({ type: "session_before_compact", preparation: {}, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal } as never, fakeCtx([]) as never);
	await compact![0]!({ type: "session_before_compact", preparation: {}, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal } as never, fakeCtx([]) as never);
	assert.equal(stub.messages.length, 1, "identical notes are not re-sent");
});

// ---------------------------------------------------------------------------
// Worker context-budget protection (extension lifecycle, worker role only)
// ---------------------------------------------------------------------------

test("allowed Commander preflight preserves compaction and its supplement", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const beforeStart = stub.events.get("before_agent_start");
	await beforeStart![0]!({ type: "before_agent_start", prompt: "commander task", systemPrompt: "" } as never, fakeCtx([]) as never);
	const compact = stub.events.get("session_before_compact");
	const result = await compact![0]!({ type: "session_before_compact", preparation: compactPreparation("small"), branchEntries: [], reason: "threshold", willRetry: true, signal: new AbortController().signal } as never, compactCtx(stub, []) as never);
	assert.equal(result, undefined, "allowed Commander compaction continues");
	assert.ok(stub.messages.length > 0, "the commander supplement note is still sent");
	assert.equal(stub.messages[0]?.customType, COMPACT_NOTE_MESSAGE_TYPE);
});

test("near-capacity Commander preflight warns and preserves the native supplement path", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const beforeStart = stub.events.get("before_agent_start")![0]!;
	await beforeStart({ type: "before_agent_start", prompt: "near-capacity warning task", systemPrompt: "" } as never, fakeCtx([]) as never);
	const compact = stub.events.get("session_before_compact")![0]!;
	const result = await compact({
		type: "session_before_compact",
		preparation: compactPreparation("w".repeat(600_000)),
		branchEntries: [],
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	} as never, compactCtx(stub, []) as never);

	assert.equal(result, undefined, "warning is advisory and native compaction continues");
	assert.equal(stub.messages.length, 1, "normal supplement still runs after the warning");
	assert.equal(stub.notifications.length, 1);
	assert.match(stub.notifications[0]!.message, /warning/i);
	assert.match(stub.notifications[0]!.message, /summary request envelope/i);
});

test("oversized Commander preflight blocks manual, threshold and overflow before any supplement", async () => {
	for (const reason of ["manual", "threshold", "overflow"] as const) {
		const stub = makeStub();
		workbenchRuntime(stub);
		const beforeStart = stub.events.get("before_agent_start")![0]!;
		await beforeStart({ type: "before_agent_start", prompt: "commander task", systemPrompt: "" } as never, fakeCtx([]) as never);
		const compact = stub.events.get("session_before_compact")![0]!;
		const secret = `NEVER-RENDER-${reason}`;
		const result = await compact({
			type: "session_before_compact",
			preparation: compactPreparation(`${secret}${"x".repeat(674_179 - secret.length)}`, "p".repeat(51_071)),
			branchEntries: [],
			reason,
			willRetry: reason === "overflow",
			signal: new AbortController().signal,
		} as never, compactCtx(stub, []) as never);

		assert.deepEqual(result, { cancel: true });
		assert.equal(stub.messages.length, 0, "blocked compaction writes no supplement message");
		assert.equal(stub.appendEntryCalls.some((call) => call.customType === COMPACT_STATE_ENTRY_TYPE), false, "blocked compaction persists no supplement state");
		assert.equal(stub.notifications.length, 1);
		const notice = stub.notifications[0]!.message;
		assert.match(notice, /blocked/i);
		assert.ok(notice.includes("/q-milestone-handoff <next step>"));
		assert.equal(notice.includes(secret), false, "notice carries no raw session content");
	}
});

test("worker session_before_compact cancels compaction (never silently continues)", async () => {
	const stub = makeStub();
	withWorkerRole(() => workbenchRuntime(stub));
	const compact = stub.events.get("session_before_compact");
	assert.ok(compact && compact.length > 0);
	const unreadablePreparation = new Proxy({}, {
		get() {
			throw new Error("worker preparation must not be read");
		},
	});
	const result = await compact[0]!({ type: "session_before_compact", preparation: unreadablePreparation, branchEntries: [], reason: "threshold", willRetry: true, signal: new AbortController().signal } as never, fakeCtx([]) as never);
	assert.deepEqual(result, { cancel: true }, "worker role cancels compaction");
	assert.equal(stub.messages.length, 0, "no supplement note for a cancelled worker compaction");
	// A second worker compaction event also cancels.
	const again = await compact[0]!({ type: "session_before_compact", preparation: {}, branchEntries: [], reason: "overflow", willRetry: true, signal: new AbortController().signal } as never, fakeCtx([]) as never);
	assert.deepEqual(again, { cancel: true });
});

function assistantUsage(totalTokens: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...overrides };
}

function messageEndEvent(totalTokens: number, overrides: Record<string, unknown> = {}): never {
	return {
		type: "message_end",
		message: { role: "assistant", provider: "deepseek", model: "deepseek-v4-flash", usage: assistantUsage(totalTokens, overrides) },
	} as never;
}

/** Pi invokes every registered message_end handler in registration order. */
async function fireMessageEnd(stub: StubAPI, event: never, ctx: never): Promise<void> {
	const handlers = stub.events.get("message_end") ?? [];
	assert.ok(handlers.length > 0, "message_end handlers registered");
	for (const handler of handlers) await handler(event, ctx);
}

test("worker role sends exactly one hidden soft-budget steer at/above 80%", async () => {
	const stub = makeStub();
	withWorkerRole(() => workbenchRuntime(stub));
	const messageEnd = stub.events.get("message_end");
	assert.ok(messageEnd && messageEnd.length > 0);
	const handler = (event: never, ctx: never) => fireMessageEnd(stub, event, ctx);
	const ctx = fakeCtx([]) as never;

	// Below the soft threshold: no steer.
	await handler(messageEndEvent(799_999), ctx);
	assert.equal(stub.messages.length, 0);

	// At the soft threshold (80%): exactly one hidden CONTEXT steer. The
	// independent cumulative spend state (1,599,999) stays below the standard
	// soft total (3,000,000), so no spend steer fires yet.
	await handler(messageEndEvent(WORKER_SOFT_BUDGET), ctx);
	assert.equal(stub.messages.length, 1);
	const steer = stub.messages[0]!;
	assert.equal(steer.customType, WORKER_SOFT_STEER_MESSAGE_TYPE);
	assert.equal(steer.display, false, "steer is hidden from the TUI");
	assert.deepEqual(steer.options, { deliverAs: "steer" }, "delivered in the active tool loop, not deferred to a future user turn");
	assert.match(steer.content, /stop/i);
	assert.match(steer.content, /handoff/i);
	assert.match(steer.content, /remaining work/i);

	// The context steer is one-shot: further per-message soft/hard context
	// never re-sends it. The INDEPENDENT spend steer fires exactly once when
	// the cumulative total first crosses the standard soft limit — the fourth
	// message brings the cumulative total to 3,399,998 (>= 3,000,000).
	await handler(messageEndEvent(899_999), ctx);
	assert.equal(stub.messages.length, 1, "cumulative spend (2,499,998) still below the standard soft total");
	await handler(messageEndEvent(WORKER_HARD_BUDGET), ctx);
	assert.equal(stub.messages.length, 2, "one context steer + one independent spend steer");
	const contextSteers = stub.messages.filter((m) => m.customType === WORKER_SOFT_STEER_MESSAGE_TYPE);
	const spendSteers = stub.messages.filter((m) => m.customType === WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE);
	assert.equal(contextSteers.length, 1, "the context steer is one-shot");
	assert.equal(spendSteers.length, 1, "the spend steer is one-shot and fully independent of the context steer");
	const spend = spendSteers[0]!;
	assert.equal(spend.display, false, "spend steer is hidden from the TUI");
	assert.deepEqual(spend.options, { deliverAs: "steer" });
	assert.match(spend.content, /profile standard/);
	assert.match(spend.content, /total_tokens 3399998\/3000000/);

	// One-shot again: another soft/hard message re-sends neither steer.
	await handler(messageEndEvent(899_999), ctx);
	assert.equal(stub.messages.length, 2, "both steers stay one-shot");
});

test("commander session never receives the worker soft-budget steer", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const messageEnd = stub.events.get("message_end");
	assert.ok(messageEnd && messageEnd.length > 0);
	await fireMessageEnd(stub, messageEndEvent(WORKER_HARD_BUDGET), fakeCtx([]) as never);
	assert.equal(stub.messages.length, 0, "the steer is worker-role only");
});

// ---------------------------------------------------------------------------
// Phase 2: worker cumulative spend steer wiring (worker token-budget repair)
// ---------------------------------------------------------------------------

test("worker role sends exactly one hidden cumulative spend steer at the standard soft total boundary", async () => {
	const stub = makeStub();
	withWorkerRole(() => workbenchRuntime(stub));
	const messageEnd = stub.events.get("message_end");
	assert.ok(messageEnd && messageEnd.length > 0);
	const handler = (event: never, ctx: never) => fireMessageEnd(stub, event, ctx);
	const ctx = fakeCtx([]) as never;

	// 4 x 600,000 = 2,400,000: below the standard soft total (3,000,000) and
	// below the per-message 80% context threshold (no context steer either).
	for (let i = 0; i < 4; i++) await handler(messageEndEvent(600_000), ctx);
	assert.equal(stub.messages.length, 0);

	// The 5th message reaches exactly 3,000,000: the spend band first becomes
	// soft and exactly one hidden spend steer fires (total_tokens dimension).
	await handler(messageEndEvent(600_000), ctx);
	assert.equal(stub.messages.length, 1);
	const steer = stub.messages[0]!;
	assert.equal(steer.customType, WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE);
	assert.equal(steer.display, false, "spend steer is hidden from the TUI");
	assert.deepEqual(steer.options, { deliverAs: "steer" }, "delivered in the active tool loop, not deferred to a future user turn");
	assert.match(steer.content, /profile standard/);
	assert.match(steer.content, /total_tokens 3000000\/3000000/);
	assert.match(steer.content, /Stop starting new implementation work now/);
	assert.match(steer.content, /handoff/i);

	// One-shot: further soft-band messages never re-send the steer.
	await handler(messageEndEvent(600_000), ctx);
	await handler(messageEndEvent(600_000), ctx);
	assert.equal(stub.messages.length, 1, "the spend steer is one-shot");
});

test("worker role spend steer fires on the turns dimension (low profile, exact soft boundary)", async () => {
	const stub = makeStub();
	withWorkerRoleAndSpendProfile("low", () => workbenchRuntime(stub));
	const messageEnd = stub.events.get("message_end");
	assert.ok(messageEnd && messageEnd.length > 0);
	const handler = (event: never, ctx: never) => fireMessageEnd(stub, event, ctx);
	const ctx = fakeCtx([]) as never;

	// 7 x 100 tokens: 7 turns stay below the low soft turns limit (8).
	for (let i = 0; i < 7; i++) await handler(messageEndEvent(100), ctx);
	assert.equal(stub.messages.length, 0);

	// The 8th turn reaches the low soft turns limit exactly: one steer naming
	// the low profile and the turns dimension.
	await handler(messageEndEvent(100), ctx);
	assert.equal(stub.messages.length, 1);
	const steer = stub.messages[0]!;
	assert.equal(steer.customType, WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE);
	assert.match(steer.content, /profile low/);
	assert.match(steer.content, /turns 8\/8/);

	// One-shot: two more turns re-send nothing.
	await handler(messageEndEvent(100), ctx);
	await handler(messageEndEvent(100), ctx);
	assert.equal(stub.messages.length, 1);
});

test("worker role spend steer fires on the output dimension at the exact soft boundary", async () => {
	const stub = makeStub();
	withWorkerRole(() => workbenchRuntime(stub));
	const messageEnd = stub.events.get("message_end");
	assert.ok(messageEnd && messageEnd.length > 0);
	const handler = (event: never, ctx: never) => fireMessageEnd(stub, event, ctx);
	const ctx = fakeCtx([]) as never;

	// 3 x 30,000 output = 90,000: below the standard soft output (120,000).
	for (let i = 0; i < 3; i++) await handler(messageEndEvent(30_030, { output: 30_000 }), ctx);
	assert.equal(stub.messages.length, 0);

	// The 4th message reaches exactly 120,000 output: one steer naming the
	// output_tokens dimension (cumulative total 120,120 stays below the
	// standard soft total and 4 turns below the soft turns limit).
	await handler(messageEndEvent(30_030, { output: 30_000 }), ctx);
	assert.equal(stub.messages.length, 1);
	const steer = stub.messages[0]!;
	assert.equal(steer.customType, WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE);
	assert.match(steer.content, /profile standard/);
	assert.match(steer.content, /output_tokens 120000\/120000/);
});

test("spend steer fires when the band first becomes hard (soft steer, hard band)", async () => {
	const stub = makeStub();
	// Low profile: soft total 750,000, hard total 1,250,000. Per-message
	// totals stay below 800,000 so the context steer never fires.
	withWorkerRoleAndSpendProfile("low", () => workbenchRuntime(stub));
	const messageEnd = stub.events.get("message_end");
	assert.ok(messageEnd && messageEnd.length > 0);
	const handler = (event: never, ctx: never) => fireMessageEnd(stub, event, ctx);
	const ctx = fakeCtx([]) as never;

	// One message at 700,000: below the low soft total — band ok, no steer.
	await handler(messageEndEvent(700_000), ctx);
	assert.equal(stub.messages.length, 0);

	// The second message jumps the cumulative total to 1,400,000: the FIRST
	// non-ok band is HARD and still triggers exactly one soft steer.
	await handler(messageEndEvent(700_000), ctx);
	assert.equal(stub.messages.length, 1);
	const steer = stub.messages[0]!;
	assert.equal(steer.customType, WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE);
	assert.match(steer.content, /profile low/);
	assert.match(steer.content, /total_tokens 1400000\/750000/, "the steer text renders soft-limit denominators");
	await handler(messageEndEvent(700_000), ctx);
	assert.equal(stub.messages.length, 1, "one-shot even when the band stays hard");
});

test("malformed spend-profile env falls back to standard defensively", async () => {
	const stub = makeStub();
	withWorkerRoleAndSpendProfile("bogus-profile", () => workbenchRuntime(stub));
	const messageEnd = stub.events.get("message_end");
	assert.ok(messageEnd && messageEnd.length > 0);
	const handler = (event: never, ctx: never) => fireMessageEnd(stub, event, ctx);
	const ctx = fakeCtx([]) as never;

	// 5 x 600,000 = 3,000,000: the STANDARD soft total boundary. The fallback
	// profile is standard (low would steer at 750,000, extended at 8,000,000).
	for (let i = 0; i < 5; i++) await handler(messageEndEvent(600_000), ctx);
	assert.equal(stub.messages.length, 1);
	assert.equal(stub.messages[0]!.customType, WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE);
	assert.match(stub.messages[0]!.content, /profile standard/);
});

test("commander session never receives the spend steer even with a profile env set", async () => {
	const stub = makeStub();
	const previous = process.env[WORKER_SPEND_PROFILE_ENV];
	process.env[WORKER_SPEND_PROFILE_ENV] = "low";
	try {
		// No WORKER role env: this is a commander session despite the env.
		workbenchRuntime(stub);
	} finally {
		if (previous === undefined) delete process.env[WORKER_SPEND_PROFILE_ENV];
		else process.env[WORKER_SPEND_PROFILE_ENV] = previous;
	}
	const messageEnd = stub.events.get("message_end");
	assert.ok(messageEnd && messageEnd.length > 0);
	const handler = (event: never, ctx: never) => fireMessageEnd(stub, event, ctx);
	// 9 turns would cross the low soft turns limit (8) in a worker session.
	for (let i = 0; i < 9; i++) await handler(messageEndEvent(100), fakeCtx([]) as never);
	assert.equal(stub.messages.length, 0, "the spend steer never reaches a commander session");
});

test("a spend steer send failure is swallowed and never breaks a model request", async () => {
	const stub = makeStub();
	withWorkerRole(() => workbenchRuntime(stub));
	const originalSend = stub.sendMessage;
	stub.sendMessage = ((
		message: Parameters<typeof stub.sendMessage>[0],
		options?: Parameters<typeof stub.sendMessage>[1],
	) => {
		if (message.customType === WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE) throw new Error("steer send failed");
		originalSend(message, options);
	}) as typeof stub.sendMessage;
	const messageEnd = stub.events.get("message_end");
	assert.ok(messageEnd && messageEnd.length > 0);
	const handler = (event: never, ctx: never) => fireMessageEnd(stub, event, ctx);
	const ctx = fakeCtx([]) as never;

	// 5 x 600,000 crosses the standard soft total on the 5th message; the
	// send throws inside the handler and is swallowed — the handler resolves.
	for (let i = 0; i < 5; i++) {
		await assert.doesNotReject(handler(messageEndEvent(600_000), ctx) as Promise<unknown>);
	}
	assert.equal(stub.messages.length, 0, "the failing spend steer is never recorded as sent");
	// The one-shot flag stays unset, so a later soft-band message retries; the
	// failure is still swallowed and the request keeps working.
	for (let i = 0; i < 3; i++) {
		await assert.doesNotReject(handler(messageEndEvent(600_000), ctx) as Promise<unknown>);
	}
	assert.equal(stub.messages.length, 0);
});

// ---------------------------------------------------------------------------
// /q-status output includes the P5 policy summary (print mode friendly)
// ---------------------------------------------------------------------------

test("/q-status reports the path policy and command guard", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const def = stub.commands.get("q-status") as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
	let outputText = "";
	const ctx = {
		...fakeCtx([]),
		hasUI: true,
		ui: { notify: (text: string) => { outputText = text; }, confirm: async () => false, setStatus: () => {}, setWidget: () => {} },
	} as unknown as ExtensionCommandContext;
	await def.handler("", ctx);
	assert.ok(outputText.includes("path policy"), "q-status mentions the path policy");
	assert.ok(outputText.includes("command guard"), "q-status mentions the command guard");
	assert.ok(outputText.includes("workbench mode"), "q-status works in print mode (stdout fallback)");
});

// ---------------------------------------------------------------------------
// P7 write-authority wiring (slice 2)
// ---------------------------------------------------------------------------

test("P7 tools and commands are registered statically", () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	assert.ok(stub.tools.has("workbench_review_worker_diff"), "review tool registered");
	assert.ok(stub.tools.has("workbench_delegation_status"), "status tool registered");
	assert.ok(stub.commands.has("q-delegation-status"), "/q-delegation-status registered");
});

test("strict Sol DEV exposes exactly the fixed 15-tool allowlist on session_start", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const handlers = stub.events.get("session_start");
	assert.ok(handlers && handlers.length > 0);
	const ctx = fakeCtx([], {
		model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" } as never,
	});
	await handlers[0]!({ type: "session_start", reason: "resume" } as never, ctx as never);
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST], "exactly the fixed allowlist in canonical order");
	assert.equal(stub.activeTools.length, 15, "15 tools, no bash/edit/write/foreign");
	for (const tool of ["bash", "edit", "write", "web_search"]) {
		assert.ok(!stub.activeTools.includes(tool), `${tool} must not be active for strict Sol`);
	}
});

test("non-Sol sessions keep the existing DEV tool set (other controllers unchanged)", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const handlers = stub.events.get("session_start");
	await handlers![0]!({ type: "session_start", reason: "resume" } as never, fakeCtx([]) as never);
	assert.ok(stub.activeTools.includes("bash"), "DEV tools stay for non-Sol controllers");
	assert.ok(stub.activeTools.includes("edit"));
});

test("the tool_call guard blocks bash/edit/write and foreign tools for strict Sol despite re-enable", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const sessionStart = stub.events.get("session_start")![0]!;
	await sessionStart(
		{ type: "session_start", reason: "resume" } as never,
		fakeCtx([], { model: { provider: "openai", id: "gpt-5.6-sol", api: "responses" } as never }) as never,
	);
	type GuardResult = { block?: boolean; reason?: string } | undefined;
	const bash = (await guardCall(stub, "bash", { command: "ls -la" })) as GuardResult;
	assert.ok(bash && bash.block === true, "bash blocked for strict Sol");
	assert.match(String(bash.reason), /Worker-first write authority/);
	const edit = (await guardCall(stub, "edit", { path: "src/main.ts" })) as GuardResult;
	assert.ok(edit && edit.block === true, "edit blocked without a lease");
	assert.match(String(edit.reason), /lease locked/);
	const foreign = (await guardCall(stub, "web_search", {})) as GuardResult;
	assert.ok(foreign && foreign.block === true, "foreign tool blocked despite re-enable");
	assert.match(String(foreign.reason), /outside the strict Sol DEV allowlist/);
	const read = (await guardCall(stub, "read", { path: "README.md" })) as GuardResult;
	assert.equal(read, undefined, "allowlist tools pass the guard");
});

test("non-Sol controllers keep the existing DEV guard behavior (bash allowed)", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	type GuardResult = { block?: boolean; reason?: string } | undefined;
	const bash = (await guardCall(stub, "bash", { command: "ls -la" })) as GuardResult;
	assert.equal(bash, undefined, "non-Sol DEV bash is not newly denied");
});

test("worker role keeps its edit/write path scope in the P7 tool_call guard", async () => {
	await withTempDir(async (root) => {
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "main.ts"), "x", "utf8");
		const previous = {
			role: process.env[WORKER_ROLE_ENV],
			root: process.env[WORKER_PROJECT_ROOT_ENV],
			paths: process.env[WORKER_ALLOWED_PATHS_ENV],
		};
		process.env[WORKER_ROLE_ENV] = "worker";
		process.env[WORKER_PROJECT_ROOT_ENV] = root;
		process.env[WORKER_ALLOWED_PATHS_ENV] = JSON.stringify(["src/**"]);
		try {
			const stub = makeStub();
			workbenchRuntime(stub);
			type GuardResult = { block?: boolean; reason?: string } | undefined;
			const inScope = (await guardCall(stub, "edit", { path: "src/main.ts" })) as GuardResult;
			assert.equal(inScope, undefined, "in-scope worker edit passes");
			const outOfScope = (await guardCall(stub, "edit", { path: "README.md" })) as GuardResult;
			assert.ok(outOfScope && outOfScope.block === true, "out-of-scope worker edit blocked");
			assert.match(String(outOfScope.reason), /outside the parent-approved scope/);
		} finally {
			// Restore the REAL env var names (the object keys above are not the env names).
			if (previous.role === undefined) delete process.env[WORKER_ROLE_ENV];
			else process.env[WORKER_ROLE_ENV] = previous.role;
			if (previous.root === undefined) delete process.env[WORKER_PROJECT_ROOT_ENV];
			else process.env[WORKER_PROJECT_ROOT_ENV] = previous.root;
			if (previous.paths === undefined) delete process.env[WORKER_ALLOWED_PATHS_ENV];
			else process.env[WORKER_ALLOWED_PATHS_ENV] = previous.paths;
		}
	});
});

// ---------------------------------------------------------------------------
// P7 slice 3: user-only lease command wiring
// ---------------------------------------------------------------------------

const UNLOCK_ARGS = "user-directed --paths src/**,README.md --calls 3 --minutes 10";

/** Fire session_start as approved GPT-5.6 Sol (sets the commander identity). */
async function solSession(stub: StubAPI, entries?: StubAPI["entries"]): Promise<void> {
	const handlers = stub.events.get("session_start");
	assert.ok(handlers && handlers.length > 0);
	await handlers[0]!(
		{ type: "session_start", reason: "resume" } as never,
		fakeCtx(entries ?? [], { model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" } as never }) as never,
	);
}

/** Run a registered command handler, capturing its visible output (TUI notify or stdout). */
async function runCmd(
	stub: StubAPI,
	name: string,
	args: string,
	opts: { hasUI?: boolean; mode?: "tui" | "rpc" | "json" | "print"; confirm?: () => Promise<boolean> } = {},
): Promise<{ output: string; confirmCalls: Array<{ title: string; body: string }>; statuses: string[] }> {
	const def = stub.commands.get(name) as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
	assert.ok(def, `command ${name} registered`);
	const hasUI = opts.hasUI ?? false;
	const mode = opts.mode ?? "print";
	const confirmCalls: Array<{ title: string; body: string }> = [];
	const statuses: string[] = [];
	let output = "";
	const original = console.log;
	console.log = (msg?: unknown) => {
		output += `${String(msg)}\n`;
	};
	const ctx = {
		...fakeCtx([]),
		mode,
		hasUI,
		ui: {
			notify: (text: string) => {
				output += `${text}\n`;
			},
			setStatus: (_key: string, line: string) => {
				statuses.push(line);
			},
			setWidget: () => {},
			confirm: async (title: string, body: string) => {
				confirmCalls.push({ title, body });
				return opts.confirm ? opts.confirm() : false;
			},
		},
	} as unknown as ExtensionCommandContext;
	try {
		await def.handler(args, ctx);
	} finally {
		console.log = original;
	}
	return { output, confirmCalls, statuses };
}

let guardTurnSerial = 0;

/** Run all guards for one real fresh-turn tool call with a unique Pi id. */
async function guardCall(
	stub: StubAPI,
	toolName: string,
	input: unknown,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	guardTurnSerial += 1;
	const ctx = fakeCtx([]) as never;
	for (const handler of stub.events.get("turn_start") ?? []) {
		await handler({ type: "turn_start", turnIndex: guardTurnSerial } as never, ctx);
	}
	for (const guard of stub.events.get("tool_call") ?? []) {
		const result = (await guard({
			type: "tool_call",
			toolCallId: `p5-state-guard-${guardTurnSerial}`,
			toolName,
			input,
		} as never, ctx)) as { block?: boolean; reason?: string } | undefined;
		if (result !== undefined) return result;
	}
	return undefined;
}

/** Extract the two issued token parts from a non-TUI issuance output. */
function issuedParts(output: string): { partA: string; partB: string } {
	const a = /confirmation part A: (\S+)/.exec(output);
	const b = /confirmation part B: (\S+)/.exec(output);
	assert.ok(a && b, "both token parts are visibly emitted");
	const partA = a[1]!;
	const partB = b[1]!;
	assert.ok(partA.length > 0 && partA.length <= 64);
	assert.ok(partB.length > 0 && partB.length <= 64);
	assert.notEqual(partA, partB, "parts are distinct");
	return { partA, partB };
}

async function leaseStatusLine(stub: StubAPI): Promise<string> {
	const { output } = await runCmd(stub, "q-write-policy", "status", { hasUI: true });
	const line = output.split("\n").find((l) => l.startsWith("lease        :"));
	assert.ok(line, "lease status line present");
	return line;
}

/** Issue a lease (non-TUI) and confirm it with the emitted parts. */
async function issueAndConfirm(stub: StubAPI, args: string = UNLOCK_ARGS): Promise<{ output: string; partA: string; partB: string }> {
	const issued = await runCmd(stub, "q-commander-write-unlock", args);
	const { partA, partB } = issuedParts(issued.output);
	const confirmed = await runCmd(stub, "q-commander-write-unlock", `confirm ${partA} ${partB}`);
	assert.ok(confirmed.output.includes("CONFIRMED"), "lease confirms with both exact parts");
	return { output: issued.output, partA, partB };
}

test("the three P7 lease commands are registered user-only and work in print mode", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	for (const name of ["q-write-policy", "q-commander-write-unlock", "q-commander-write-lock"]) {
		assert.ok(stub.commands.has(name), `${name} registered as a command`);
		assert.ok(!stub.tools.has(name), `${name} is never a model tool`);
	}
	// /q-write-policy status works without a project and without trust (non-Sol: not-applicable).
	const { output } = await runCmd(stub, "q-write-policy", "status");
	assert.ok(output.includes("actor"));
	assert.ok(output.includes("policy"));
	assert.ok(output.includes("not-applicable"));
});

test("non-TUI unlock issues a pending lease, emits two distinct bounded token parts, and status never leaks them", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	const issued = await runCmd(stub, "q-commander-write-unlock", UNLOCK_ARGS);
	const { partA, partB } = issuedParts(issued.output);
	assert.ok(issued.output.includes("BLOCKED until confirmed"));
	// Pending lease: still exactly the canonical 15 (no edit/write yet).
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST]);
	assert.equal(stub.activeTools.length, 15);
	// The guard still blocks edit while pending.
	const blocked = await guardCall(stub, "edit", { path: "src/main.ts" });
	assert.ok(blocked && blocked.block === true);
	assert.match(String(blocked.reason), /lease pending/);
	// Status shows pending with a confirm hint — never the actual parts.
	const status = await runCmd(stub, "q-write-policy", "status");
	assert.ok(status.output.includes("pending confirmation"));
	assert.ok(status.output.includes("confirm <partA> <partB>"));
	assert.ok(!status.output.includes(partA) && !status.output.includes(partB), "tokens never leak into status");
	const compact = await runCmd(stub, "q-status", "");
	assert.ok(!compact.output.includes(partA) && !compact.output.includes(partB), "tokens never leak into /q-status");
});

test("non-TUI confirmation requires BOTH exact parts on the same command; mismatch leaves the lease locked", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	const issued = await runCmd(stub, "q-commander-write-unlock", UNLOCK_ARGS);
	const { partA, partB } = issuedParts(issued.output);
	// Wrong part B: refused, lease still pending, nothing consumed.
	const mismatch = await runCmd(stub, "q-commander-write-unlock", `confirm ${partA} WRONG`);
	assert.match(mismatch.output, /token mismatch|stays locked/);
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST]);
	// Swapped parts are not a confirmation either.
	await runCmd(stub, "q-commander-write-unlock", `confirm ${partB} ${partA}`);
	assert.match(await leaseStatusLine(stub), /pending/);
	// Both exact parts activate the lease and enable edit/write.
	const ok = await runCmd(stub, "q-commander-write-unlock", `confirm ${partA} ${partB}`);
	assert.ok(ok.output.includes("CONFIRMED and active"));
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST, "edit", "write"]);
	assert.equal(stub.activeTools.length, 17);
	assert.equal(await guardCall(stub, "edit", { path: "src/main.ts" }), undefined, "authorized edit passes the guard");
	// The lease-id form confirms too, and a wrong id is refused.
	const id = /pending lease (\S+)/.exec(issued.output)?.[1];
	assert.ok(id);
	await runCmd(stub, "q-commander-write-lock", "");
	const reissued = await runCmd(stub, "q-commander-write-unlock", UNLOCK_ARGS);
	const { partA: a2, partB: b2 } = issuedParts(reissued.output);
	const newId = /pending lease (\S+)/.exec(reissued.output)?.[1];
	assert.ok(newId && newId !== id, "a fresh lease id is issued after lock");
	const wrongId = await runCmd(stub, "q-commander-write-unlock", `confirm ${id} ${a2} ${b2}`);
	assert.match(wrongId.output, /lease id mismatch/);
	const withId = await runCmd(stub, "q-commander-write-unlock", `confirm ${newId} ${a2} ${b2}`);
	assert.ok(withId.output.includes("CONFIRMED"));
});

test("TUI unlock requires explicit human confirmation; cancel leaves the lease locked, yes activates it", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	// Cancel: nothing issued, nothing persisted, tools stay exactly 15.
	const cancel = await runCmd(stub, "q-commander-write-unlock", UNLOCK_ARGS, { hasUI: true, mode: "tui", confirm: async () => false });
	assert.match(cancel.output, /canceled/);
	assert.equal(cancel.confirmCalls.length, 1, "exactly one confirmation dialog");
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST]);
	assert.match(await leaseStatusLine(stub), /WRITE-LEASE locked/);
	assert.ok(!stub.appendEntryCalls.some((c) => c.customType === LEASE_STATE_ENTRY_TYPE), "no lease entry persisted on cancel");
	// Yes: the human TUI confirmation activates the lease immediately.
	const yes = await runCmd(stub, "q-commander-write-unlock", UNLOCK_ARGS, { hasUI: true, mode: "tui", confirm: async () => true });
	assert.ok(yes.output.includes("CONFIRMED and active"));
	assert.equal(yes.confirmCalls.length, 1);
	// The dialog carries every scope/reason/calls/expiry fact.
	const body = yes.confirmCalls[0]!.body;
	assert.ok(body.includes("user-directed"));
	assert.ok(body.includes("src/**, README.md"));
	assert.ok(body.includes("up to 3 authorized edit/write call(s)"));
	assert.ok(body.includes("10 minute(s)"));
	assert.ok(body.includes("edit, write only"));
	assert.ok(!body.includes("confirmation part"), "TUI dialog never shows token parts");
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST, "edit", "write"]);
	assert.match(await leaseStatusLine(stub), /WRITE-LEASE active/);
});

test("unlock is Sol + DEV + worker-first-strict only; everyone else is refused", async () => {
	// Non-Sol actor (no session identity): refused; the lease is not applicable.
	const stubA = makeStub();
	workbenchRuntime(stubA);
	const refusedA = await runCmd(stubA, "q-commander-write-unlock", UNLOCK_ARGS);
	assert.match(refusedA.output, /refused/);
	assert.match(refusedA.output, /worker-first-strict/);
	assert.match(await leaseStatusLine(stubA), /\(not applicable\)/);
	// Delegated worker (env contract wins even with Sol-looking model facts): refused.
	// The policy line still resolves by provider/model, but the ACTOR gate refuses.
	const stubB = makeStub();
	withWorkerRole(() => workbenchRuntime(stubB));
	await solSession(stubB);
	const refusedB = await runCmd(stubB, "q-commander-write-unlock", UNLOCK_ARGS);
	assert.match(refusedB.output, /refused/);
	assert.match(refusedB.output, /delegated-worker/);
	assert.match(await leaseStatusLine(stubB), /WRITE-LEASE locked/);
	// Leaving DEV: refused (VERIFY entry also revokes any lease).
	const stubC = makeStub();
	workbenchRuntime(stubC);
	await solSession(stubC);
	await runCmd(stubC, "q-mode-verify", "", { hasUI: true });
	const refusedC = await runCmd(stubC, "q-commander-write-unlock", UNLOCK_ARGS, { hasUI: true });
	assert.match(refusedC.output, /only in DEV mode/);
});

test("unlock validates project-relative scope, calls and minutes; bad arguments never issue a lease", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	for (const bad of [
		"/etc/passwd --calls 1 --minutes 1",
		"user-directed --paths /etc/passwd --calls 1 --minutes 1",
		"user-directed --paths ../escape/** --calls 1 --minutes 1",
		"user-directed --paths src/** --calls 0 --minutes 1",
		"user-directed --paths src/** --calls 11 --minutes 1",
		"user-directed --paths src/** --calls 1 --minutes 0",
		"user-directed --paths src/** --calls 1 --minutes 31",
		"manual-override --paths src/** --calls 1 --minutes 1",
		"user-directed --calls 1 --minutes 1",
	]) {
		const result = await runCmd(stub, "q-commander-write-unlock", bad);
		assert.match(result.output, /q-commander-write-unlock:/, bad);
		assert.match(await leaseStatusLine(stub), /WRITE-LEASE locked/, bad);
		assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST], bad);
	}
	// Max bounds are accepted.
	const ok = await runCmd(stub, "q-commander-write-unlock", "user-directed --paths src/** --calls 10 --minutes 30");
	assert.ok(ok.output.includes("pending lease"));
});

test("a pending or active lease blocks re-issuance until confirmed or locked", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	const issued = await runCmd(stub, "q-commander-write-unlock", UNLOCK_ARGS);
	const { partA, partB } = issuedParts(issued.output);
	const again = await runCmd(stub, "q-commander-write-unlock", UNLOCK_ARGS);
	assert.match(again.output, /already pending/);
	await runCmd(stub, "q-commander-write-unlock", `confirm ${partA} ${partB}`);
	const active = await runCmd(stub, "q-commander-write-unlock", UNLOCK_ARGS);
	assert.match(active.output, /already active/);
});

test("every authorized edit/write consumes one call; exhaustion removes edit/write from the active set", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	await issueAndConfirm(stub, "user-directed --paths src/** --calls 1 --minutes 10");
	assert.equal(stub.activeTools.length, 17);
	// A path outside the lease is blocked BEFORE consumption: the call stays available.
	const outOfScope = await guardCall(stub, "edit", { path: "tests/uncovered.ts" });
	assert.ok(outOfScope && outOfScope.block === true);
	assert.match(String(outOfScope.reason), /outside the active write lease/);
	assert.match(await leaseStatusLine(stub), /active.*0\/1/);
	// The single authorized write consumes the only call; exhaustion reapplies the exact 15.
	assert.equal(await guardCall(stub, "edit", { path: "src/main.ts" }), undefined);
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST]);
	assert.match(await leaseStatusLine(stub), /WRITE-LEASE exhausted/);
	const exhausted = await guardCall(stub, "edit", { path: "src/main.ts" });
	assert.ok(exhausted && exhausted.block === true);
	assert.match(String(exhausted.reason), /lease exhausted/);
});

test("/q-commander-write-lock revokes, persists audit facts and reapplies the exact 15 tools", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	await issueAndConfirm(stub);
	assert.equal(stub.activeTools.length, 17);
	const locked = await runCmd(stub, "q-commander-write-lock", "");
	assert.match(locked.output, /revoked/);
	assert.match(locked.output, /user-directed lock/);
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST]);
	const blocked = await guardCall(stub, "edit", { path: "src/main.ts" });
	assert.ok(blocked && blocked.block === true);
	assert.match(String(blocked.reason), /lease revoked/);
	assert.match(await leaseStatusLine(stub), /WRITE-LEASE revoked/);
	// Audit facts are persisted: the last lease entry carries the revocation.
	const leaseEntries = stub.appendEntryCalls.filter((c) => c.customType === LEASE_STATE_ENTRY_TYPE);
	const last = leaseEntries[leaseEntries.length - 1];
	assert.ok(last && typeof last.data === "object" && last.data !== null);
	assert.match(String((last.data as { revokedReason?: unknown }).revokedReason), /user-directed lock/);
	// Lock with no lease is a safe no-op.
	const stubB = makeStub();
	workbenchRuntime(stubB);
	await solSession(stubB);
	const noLease = await runCmd(stubB, "q-commander-write-lock", "");
	assert.match(noLease.output, /already locked/);
});

test("leaving DEV, model change and session end revoke the lease and reapply locked tools", async () => {
	// Mode change: VERIFY revokes and reapplies the VERIFY tool set.
	const stubA = makeStub();
	workbenchRuntime(stubA);
	await solSession(stubA);
	await issueAndConfirm(stubA);
	assert.equal(stubA.activeTools.length, 17);
	await runCmd(stubA, "q-mode-verify", "", { hasUI: true });
	assert.match(await leaseStatusLine(stubA), /WRITE-LEASE revoked/);
	assert.ok(!stubA.activeTools.includes("edit") && !stubA.activeTools.includes("write"));
	assert.ok(!stubA.activeTools.includes("workbench_delegate_worker"), "VERIFY set applied");
	await runCmd(stubA, "q-mode-dev", "", { hasUI: true });
	assert.deepEqual(stubA.activeTools, [...STRICT_SOL_DEV_ALLOWLIST], "back to exact 15 after re-entering DEV");
	// Model change: the lease is bound to GPT-5.6 Sol — it is revoked and the
	// audit fact is persisted; the non-Sol actor falls back to the existing
	// DEV behavior, and a returning Sol session reapplies the locked tools.
	const stubB = makeStub();
	workbenchRuntime(stubB);
	await solSession(stubB);
	await issueAndConfirm(stubB);
	const modelSelect = stubB.events.get("model_select")![0]!;
	await modelSelect(
		{ type: "model_select", model: { provider: "deepseek", id: "deepseek-v4-flash", api: "chat" } } as never,
		fakeCtx([]) as never,
	);
	assert.match(await leaseStatusLine(stubB), /\(not applicable\)/, "non-Sol actor: lease not applicable");
	const leaseEntries = stubB.appendEntryCalls.filter((c) => c.customType === LEASE_STATE_ENTRY_TYPE);
	const last = leaseEntries[leaseEntries.length - 1];
	assert.ok(last && typeof last.data === "object" && last.data !== null);
	assert.match(String((last.data as { revokedReason?: unknown }).revokedReason), /model\/provider change/);
	assert.ok(stubB.activeTools.includes("bash"), "non-Sol controllers keep the existing DEV tool set");
	// Returning Sol: the revoked lease keeps the exact 15 locked tools.
	const sessionStart = stubB.events.get("session_start")![0]!;
	await sessionStart(
		{ type: "session_start", reason: "resume" } as never,
		fakeCtx(stubB.entries, { model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" } as never }) as never,
	);
	assert.match(await leaseStatusLine(stubB), /WRITE-LEASE revoked/);
	assert.deepEqual(stubB.activeTools, [...STRICT_SOL_DEV_ALLOWLIST]);
	const blocked = await guardCall(stubB, "edit", { path: "src/main.ts" });
	assert.ok(blocked && blocked.block === true);
	assert.match(String(blocked.reason), /lease revoked/);
	// Session end: the lease never outlives its session.
	const stubC = makeStub();
	workbenchRuntime(stubC);
	await solSession(stubC);
	await issueAndConfirm(stubC);
	const shutdown = stubC.events.get("session_shutdown")![0]!;
	await shutdown({} as never, fakeCtx([]) as never);
	assert.match(await leaseStatusLine(stubC), /WRITE-LEASE revoked/);
	assert.deepEqual(stubC.activeTools, [...STRICT_SOL_DEV_ALLOWLIST]);
});

test("lease state persists reason/paths/calls/expiry/usage and restores accurately after session replacement", async () => {
	// Runtime A: issue, confirm and consume exactly one call.
	const stubA = makeStub();
	workbenchRuntime(stubA);
	await solSession(stubA);
	await issueAndConfirm(stubA, "user-directed --paths src/**,README.md --calls 2 --minutes 10");
	assert.equal(await guardCall(stubA, "edit", { path: "src/main.ts" }), undefined, "one authorized write");
	assert.equal(stubA.activeTools.length, 17, "still active with one call left");
	// Runtime B: a fresh session (compaction/session replacement) restores the lease.
	const stubB = makeStub();
	workbenchRuntime(stubB);
	await solSession(stubB, stubA.entries);
	const status = await runCmd(stubB, "q-write-policy", "status");
	assert.ok(status.output.includes("active"), "restored lease is active");
	assert.ok(status.output.includes("1/2"), "callsUsed restored exactly");
	assert.ok(status.output.includes("src/**"), "paths restored");
	assert.deepEqual(stubB.activeTools, [...STRICT_SOL_DEV_ALLOWLIST, "edit", "write"]);
	assert.equal(await guardCall(stubB, "edit", { path: "README.md" }), undefined, "restored lease still authorizes writes");
});

test("pending lease restores with its token parts intact and confirms on the same command after restart", async () => {
	const stubA = makeStub();
	workbenchRuntime(stubA);
	await solSession(stubA);
	const issued = await runCmd(stubA, "q-commander-write-unlock", UNLOCK_ARGS);
	const { partA, partB } = issuedParts(issued.output);
	assert.match(await leaseStatusLine(stubA), /pending/);
	// Fresh runtime restores the PENDING lease (tokens travel in the custom entry).
	const stubB = makeStub();
	workbenchRuntime(stubB);
	await solSession(stubB, stubA.entries);
	assert.match(await leaseStatusLine(stubB), /pending/);
	assert.deepEqual(stubB.activeTools, [...STRICT_SOL_DEV_ALLOWLIST], "pending lease enables nothing");
	const ok = await runCmd(stubB, "q-commander-write-unlock", `confirm ${partA} ${partB}`);
	assert.ok(ok.output.includes("CONFIRMED and active"));
	assert.deepEqual(stubB.activeTools, [...STRICT_SOL_DEV_ALLOWLIST, "edit", "write"]);
});

test("lease restore is policy-bound and fail-closed: wrong model, corrupt or expired entries never activate", async () => {
	// Build a valid confirmed lease entry via the pure module (2020 timestamps
	// so an expired variant stays structurally valid: issuedAt < expiresAt,
	// duration within the 30-minute bound — but expired relative to NOW).
	const issued = issueLease({
		id: "wl-crafted",
		reason: "user-directed",
		paths: ["src/**"],
		confirmationTokenA: "TOKEN-A-123",
		confirmationTokenB: "TOKEN-B-456",
		now: "2020-01-01T00:00:00.000Z",
	});
	if (!issued.ok) throw new Error(issued.error);
	const confirmed = confirmLease(issued.lease, "TOKEN-A-123", "TOKEN-B-456", "2020-01-01T00:00:00.000Z");
	if (!confirmed.ok) throw new Error(confirmed.error);
	const validEntry = entry(LEASE_STATE_ENTRY_TYPE, serializeLease(confirmed.lease));
	// Expired entry (valid structure, past expiry): session_start sees it as
	// expired — tools stay exactly 15.
	const expiredEntry = entry(LEASE_STATE_ENTRY_TYPE, {
		...serializeLease(confirmed.lease),
		issuedAt: "2020-01-01T00:00:00.000Z",
		expiresAt: "2020-01-01T00:30:00.000Z",
	});
	const stubExpired = makeStub();
	workbenchRuntime(stubExpired);
	await solSession(stubExpired, [expiredEntry]);
	assert.match(await leaseStatusLine(stubExpired), /WRITE-LEASE expired/);
	assert.deepEqual(stubExpired.activeTools, [...STRICT_SOL_DEV_ALLOWLIST]);
	// Corrupt entry (reason outside the fixed four): fail closed to locked.
	const corruptEntry = entry(LEASE_STATE_ENTRY_TYPE, { ...serializeLease(confirmed.lease), reason: "manual-override" });
	const stubCorrupt = makeStub();
	workbenchRuntime(stubCorrupt);
	await solSession(stubCorrupt, [corruptEntry]);
	assert.match(await leaseStatusLine(stubCorrupt), /WRITE-LEASE locked/);
	assert.deepEqual(stubCorrupt.activeTools, [...STRICT_SOL_DEV_ALLOWLIST]);
	// A valid entry under a different (non-Sol) model is revoked on restore
	// (audit fact persisted); a returning Sol session sees the revoked lease
	// and the exact locked tools.
	const stubOtherModel = makeStub();
	workbenchRuntime(stubOtherModel);
	const handlers = stubOtherModel.events.get("session_start");
	await handlers![0]!(
		{ type: "session_start", reason: "resume" } as never,
		fakeCtx([validEntry], { model: { provider: "deepseek", id: "deepseek-v4-flash", api: "chat" } as never }) as never,
	);
	assert.match(await leaseStatusLine(stubOtherModel), /\(not applicable\)/);
	const leaseEntries = stubOtherModel.appendEntryCalls.filter((c) => c.customType === LEASE_STATE_ENTRY_TYPE);
	const last = leaseEntries[leaseEntries.length - 1];
	assert.ok(last && typeof last.data === "object" && last.data !== null);
	assert.match(String((last.data as { revokedReason?: unknown }).revokedReason), /model\/provider change/);
	await handlers![0]!(
		{ type: "session_start", reason: "resume" } as never,
		fakeCtx(stubOtherModel.entries, { model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" } as never }) as never,
	);
	assert.match(await leaseStatusLine(stubOtherModel), /WRITE-LEASE revoked/);
	const blocked = await guardCall(stubOtherModel, "edit", { path: "src/main.ts" });
	assert.ok(blocked && blocked.block === true);
	assert.match(String(blocked.reason), /lease revoked/);
	assert.deepEqual(stubOtherModel.activeTools, [...STRICT_SOL_DEV_ALLOWLIST]);
});

// ---------------------------------------------------------------------------
// P7 slice 3 focused repair: TUI-only human confirmation (mode-based),
// /q-write-policy argument strictness, lazy lease-lock sync, footer segment
// ---------------------------------------------------------------------------

test("RPC mode is non-TUI: hasUI never opens the human dialog — the pending two-part token flow is used", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	// RPC contexts are dialog-capable (hasUI=true) but are NOT a real TUI:
	// the human inline confirmation must not fire — the pending two-part
	// token flow is used instead.
	const issued = await runCmd(stub, "q-commander-write-unlock", UNLOCK_ARGS, { mode: "rpc", hasUI: true });
	assert.equal(issued.confirmCalls.length, 0, "RPC never opens a human confirmation dialog");
	const { partA, partB } = issuedParts(issued.output);
	assert.ok(issued.output.includes("BLOCKED until confirmed"), "pending lease issued");
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST], "pending lease enables nothing yet");
	// The two-step confirmation completes on the same command, in RPC mode.
	const confirmed = await runCmd(stub, "q-commander-write-unlock", `confirm ${partA} ${partB}`, { mode: "rpc", hasUI: true });
	assert.ok(confirmed.output.includes("CONFIRMED and active"));
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST, "edit", "write"]);
	// print/json are equally non-TUI (no dialog), even with hasUI true.
	for (const mode of ["print", "json"] as const) {
		const stub2 = makeStub();
		workbenchRuntime(stub2);
		await solSession(stub2);
		const issued2 = await runCmd(stub2, "q-commander-write-unlock", UNLOCK_ARGS, { mode, hasUI: true });
		assert.equal(issued2.confirmCalls.length, 0, `${mode} never opens a human dialog`);
		const parts = issuedParts(issued2.output);
		const confirmed2 = await runCmd(stub2, "q-commander-write-unlock", `confirm ${parts.partA} ${parts.partB}`, { mode, hasUI: true });
		assert.ok(confirmed2.output.includes("CONFIRMED and active"));
		assert.deepEqual(stub2.activeTools, [...STRICT_SOL_DEV_ALLOWLIST, "edit", "write"]);
	}
	// Only a real TUI (mode "tui") asks the human.
	const stubTui = makeStub();
	workbenchRuntime(stubTui);
	await solSession(stubTui);
	const tui = await runCmd(stubTui, "q-commander-write-unlock", UNLOCK_ARGS, { mode: "tui", hasUI: true, confirm: async () => false });
	assert.equal(tui.confirmCalls.length, 1, "only the real TUI asks for human confirmation");
	assert.match(tui.output, /canceled/);
	assert.deepEqual(stubTui.activeTools, [...STRICT_SOL_DEV_ALLOWLIST], "cancel leaves the exact canonical 15");
});

test("/q-write-policy accepts exactly the trimmed `status` argument; other/missing args print usage and never alter state", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	for (const bad of ["", "  ", "Status", "STATUS", "status extra", "--help", "status --json", "lease"]) {
		const { output } = await runCmd(stub, "q-write-policy", bad);
		assert.match(output, /usage: \/q-write-policy status/, JSON.stringify(bad));
	}
	// No state change: the lease stays locked and the tools stay exact 15.
	assert.match(await leaseStatusLine(stub), /WRITE-LEASE locked/);
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST]);
	assert.ok(!stub.appendEntryCalls.some((c) => c.customType === LEASE_STATE_ENTRY_TYPE), "no lease entry written");
	// Trimmed `status` is accepted.
	const ok = await runCmd(stub, "q-write-policy", "  status  ");
	assert.ok(ok.output.includes("worker-first-strict"));
	assert.ok(ok.output.includes("WRITE-LEASE locked"));
});

test("lazy lease-lock sync: an expired lease is re-locked at the next agent turn and on the next tool call — no timers", async () => {
	// Craft an ACTIVE confirmed lease that expires ~150ms after creation
	// (structurally valid: 30-minute duration, confirmed, calls remaining).
	// A fresh entry is made per stub so the near-expiry window is measured
	// from that stub's own restore.
	const makeLazyEntry = (): StubAPI["entries"] => {
		const expiresAt = new Date(Date.now() + 150).toISOString();
		const issuedAt = new Date(Date.parse(expiresAt) - MAX_LEASE_DURATION_MS).toISOString();
		const issued = issueLease({
			id: "wl-lazy",
			reason: "user-directed",
			paths: ["src/**"],
			confirmationTokenA: "LAZY-A-123",
			confirmationTokenB: "LAZY-B-456",
			now: issuedAt,
			durationMs: MAX_LEASE_DURATION_MS,
		});
		assert.ok(issued.ok, issued.ok ? "" : issued.error);
		const confirmed = confirmLease(issued.lease, "LAZY-A-123", "LAZY-B-456", issuedAt);
		assert.ok(confirmed.ok, confirmed.ok ? "" : confirmed.error);
		return [entry(LEASE_STATE_ENTRY_TYPE, serializeLease(confirmed.lease))];
	};

	// Agent-turn path: the lease is active at restore; after expiry, the
	// next before_agent_start reverts the advertised set to the exact 15.
	const stubA = makeStub();
	workbenchRuntime(stubA);
	await solSession(stubA, makeLazyEntry());
	assert.equal(stubA.activeTools.length, 17, "the near-expiry lease is still active at restore");
	await new Promise((resolve) => setTimeout(resolve, 300));
	const beforeStart = stubA.events.get("before_agent_start")![0]!;
	await beforeStart!({ type: "before_agent_start", prompt: "continue", systemPrompt: "" } as never, fakeCtx([]) as never);
	assert.deepEqual(stubA.activeTools, [...STRICT_SOL_DEV_ALLOWLIST], "expired lease: exact canonical 15 readvertised before the turn");
	assert.match(await leaseStatusLine(stubA), /WRITE-LEASE expired/);
	const blocked = await guardCall(stubA, "edit", { path: "src/main.ts" });
	assert.ok(blocked && blocked.block === true);
	assert.match(String(blocked.reason), /lease expired/);

	// Guard path: an expired edit call BLOCKS (second layer) AND removes the
	// stale edit/write from the advertised set — even with no agent turn in
	// between, and with no timer/background job anywhere.
	const stubB = makeStub();
	workbenchRuntime(stubB);
	await solSession(stubB, makeLazyEntry());
	assert.equal(stubB.activeTools.length, 17, "still active at restore");
	await new Promise((resolve) => setTimeout(resolve, 300));
	const guardBlocked = await guardCall(stubB, "edit", { path: "src/main.ts" });
	assert.ok(guardBlocked && guardBlocked.block === true);
	assert.match(String(guardBlocked.reason), /lease expired/);
	assert.deepEqual(stubB.activeTools, [...STRICT_SOL_DEV_ALLOWLIST], "the blocked call removed the stale edit/write tools");
});

test("footer renders WF:LEASE used/max only for an ACTIVE lease and WF:LOCKED otherwise; WF:REVIEW stays independent", async () => {
	const solModel = { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" } as never;
	/** Run session_start (Sol identity unless `sol` is false) and return the last footer line. */
	const footerAfterStart = async (stub: StubAPI, leaseEntries: StubAPI["entries"], sol: boolean): Promise<string> => {
		const statuses: string[] = [];
		const handlers = stub.events.get("session_start");
		assert.ok(handlers && handlers.length > 0);
		const ctx = {
			...fakeCtx(leaseEntries, sol ? { model: solModel } : {}),
			ui: {
				setStatus: (_key: string, line: string) => {
					statuses.push(line);
				},
				setWidget: () => {},
				notify: () => {},
				confirm: async () => false,
			},
		} as unknown as ExtensionContext;
		await handlers[0]!({ type: "session_start", reason: "resume" } as never, ctx as never);
		return statuses[statuses.length - 1] ?? "";
	};

	// Active lease: the required compact segment carries exact used/max.
	const recentNow = new Date(Date.now() - 60_000).toISOString();
	const issued = issueLease({
		id: "wl-footer",
		reason: "user-directed",
		paths: ["src/**"],
		confirmationTokenA: "FOOT-A-123",
		confirmationTokenB: "FOOT-B-456",
		now: recentNow,
	});
	assert.ok(issued.ok, issued.ok ? "" : issued.error);
	const confirmed = confirmLease(issued.lease, "FOOT-A-123", "FOOT-B-456", recentNow);
	assert.ok(confirmed.ok, confirmed.ok ? "" : confirmed.error);
	const stubActive = makeStub();
	workbenchRuntime(stubActive);
	const activeLine = await footerAfterStart(stubActive, [entry(LEASE_STATE_ENTRY_TYPE, serializeLease(confirmed.lease))], true);
	assert.ok(activeLine.includes("WF:LEASE 0/10"), `active footer: ${activeLine}`);
	assert.ok(!activeLine.includes("WF:LOCKED"), "active lease never renders WF:LOCKED");
	assert.ok(!activeLine.includes("WF:REVIEW"), "the lease segment never merges the independent WF:REVIEW segment");
	assert.deepEqual(stubActive.activeTools, [...STRICT_SOL_DEV_ALLOWLIST, "edit", "write"]);

	// Locked (no lease): WF:LOCKED.
	const stubLocked = makeStub();
	workbenchRuntime(stubLocked);
	const lockedLine = await footerAfterStart(stubLocked, [], true);
	assert.ok(lockedLine.includes("WF:LOCKED"), `locked footer: ${lockedLine}`);
	assert.ok(!lockedLine.includes("WF:LEASE"), "no WF:LEASE without an active lease");

	// Pending / exhausted / expired / revoked all render WF:LOCKED with the
	// exact canonical 15 tools.
	const pending = issueLease({
		id: "wl-p",
		reason: "user-directed",
		paths: ["src/**"],
		confirmationTokenA: "P-A-123",
		confirmationTokenB: "P-B-456",
		now: recentNow,
	});
	assert.ok(pending.ok);
	const exhausted = issueLease({
		id: "wl-e",
		reason: "user-directed",
		paths: ["src/**"],
		confirmationTokenA: "E-A-123",
		confirmationTokenB: "E-B-456",
		maxCalls: 2,
		now: recentNow,
	});
	assert.ok(exhausted.ok);
	const exhaustedConfirmed = confirmLease(exhausted.lease, "E-A-123", "E-B-456", recentNow);
	assert.ok(exhaustedConfirmed.ok);
	const cases: Array<[string, StubAPI["entries"]]> = [
		["pending", [entry(LEASE_STATE_ENTRY_TYPE, serializeLease(pending.lease))]],
		["exhausted", [entry(LEASE_STATE_ENTRY_TYPE, serializeLease({ ...exhaustedConfirmed.lease, callsUsed: 2 }))]],
		["expired", [entry(LEASE_STATE_ENTRY_TYPE, serializeLease({ ...confirmed.lease, issuedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:30:00.000Z" }))]],
		["revoked", [entry(LEASE_STATE_ENTRY_TYPE, serializeLease(revokeLease(confirmed.lease, "user-directed lock via /q-commander-write-lock", recentNow)))]],
	];
	for (const [label, leaseEntries] of cases) {
		const stub = makeStub();
		workbenchRuntime(stub);
		const line = await footerAfterStart(stub, leaseEntries, true);
		assert.ok(line.includes("WF:LOCKED"), `${label} footer renders WF:LOCKED: ${line}`);
		assert.ok(!line.includes("WF:LEASE"), `${label} never renders WF:LEASE: ${line}`);
		assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST], `${label}: exact canonical 15`);
	}

	// Non-strict actors render no WF segment at all.
	const stubOther = makeStub();
	workbenchRuntime(stubOther);
	const otherLine = await footerAfterStart(stubOther, [], false);
	assert.ok(!otherLine.includes("WF:"), `no WF segment for non-Sol actors: ${otherLine}`);
});

// ---------------------------------------------------------------------------
// P7 slice 3: compaction mirror, blocked-write audit counter, worker-first
// gate facts wiring
// ---------------------------------------------------------------------------

test("the strict Sol guard counts EVERY blocked edit/write attempt, with or without a delegation", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	type GuardResult = { block?: boolean; reason?: string } | undefined;
	// No delegation exists: every blocked attempt is still counted.
	for (let i = 0; i < 3; i += 1) {
		const blocked = (await guardCall(stub, "edit", { path: "src/main.ts" })) as GuardResult;
		assert.ok(blocked && blocked.block === true);
	}
	const delegationEntries = stub.appendEntryCalls.filter((c) => c.customType === DELEGATION_STATE_ENTRY_TYPE);
	const last = delegationEntries[delegationEntries.length - 1];
	assert.ok(last && typeof last.data === "object" && last.data !== null);
	assert.equal((last.data as { blockedWriteAttempts?: number }).blockedWriteAttempts, 3, "every blocked attempt increments the audit counter");
	// A blocked bash call is NOT an edit/write attempt: the counter stays.
	await guardCall(stub, "bash", { command: "ls" });
	const after = stub.appendEntryCalls.filter((c) => c.customType === DELEGATION_STATE_ENTRY_TYPE);
	assert.equal((after[after.length - 1]!.data as { blockedWriteAttempts?: number }).blockedWriteAttempts, 3);
	// A blocked foreign-tool call is not a write attempt either.
	await guardCall(stub, "web_search", {});
	const after2 = stub.appendEntryCalls.filter((c) => c.customType === DELEGATION_STATE_ENTRY_TYPE);
	assert.equal((after2[after2.length - 1]!.data as { blockedWriteAttempts?: number }).blockedWriteAttempts, 3);
});

test("session_start derives P7 worker-first facts and the compaction note names them (pending review)", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const recorded = recordDelegation(emptyDelegationState(), {
		id: "20260801-120000-abcd",
		diffHash: "a".repeat(64),
		now: "2026-08-01T12:00:00.000Z",
	});
	if (!recorded.ok) throw new Error(recorded.error);
	const entries = [entry(DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState(recorded.state))];
	await solSession(stub, entries);
	const beforeStart = stub.events.get("before_agent_start")![0]!;
	await beforeStart!({ type: "before_agent_start", prompt: "review the worker diff", systemPrompt: "" } as never, fakeCtx(entries) as never);
	const compact = stub.events.get("session_before_compact")![0]!;
	await compact!({ type: "session_before_compact", preparation: {}, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal } as never, fakeCtx(entries) as never);
	assert.ok(stub.messages.length > 0, "supplement note sent");
	const note = stub.messages[0]?.content ?? "";
	assert.ok(note.includes("worker-first: strict active"), note);
	assert.ok(note.includes("commander writes: denied"), note);
	assert.ok(note.includes("delegation: 20260801-120000-abcd PENDING_REVIEW"), note);
	assert.ok(note.includes("next delegation action: review delegation 20260801-120000-abcd"), note);
});

test("a reviewed delegation restores and the compaction note shows REVIEWED with the bound hash and next action", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const recorded = recordDelegation(emptyDelegationState(), {
		id: "20260801-120000-abcd",
		diffHash: "a".repeat(64),
		now: "2026-08-01T12:00:00.000Z",
	});
	if (!recorded.ok) throw new Error(recorded.error);
	const reviewed = markReviewed(recorded.state, "2026-08-01T12:05:00.000Z");
	if (!reviewed.ok) throw new Error(reviewed.error);
	const entries = [entry(DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState(reviewed.state))];
	await solSession(stub, entries);
	const beforeStart = stub.events.get("before_agent_start")![0]!;
	await beforeStart!({ type: "before_agent_start", prompt: "start the next slice", systemPrompt: "" } as never, fakeCtx(entries) as never);
	const compact = stub.events.get("session_before_compact")![0]!;
	await compact!({ type: "session_before_compact", preparation: {}, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal } as never, fakeCtx(entries) as never);
	const note = stub.messages[0]?.content ?? "";
	assert.ok(note.includes("delegation: 20260801-120000-abcd REVIEWED"), note);
	assert.ok(note.includes(`(hash ${"a".repeat(12)})`), note);
	assert.ok(note.includes("next delegation action: delegation 20260801-120000-abcd REVIEWED"), note);
});

test("the compaction mirror never weakens the hard guards (note text is not consulted)", async () => {
	// A hostile compact entry claiming the policy is off and writes are
	// allowed changes the NOTE only — the tool_call guard still denies
	// strict-Sol edit/write from the authoritative lease/delegation state.
	const stub = makeStub();
	workbenchRuntime(stub);
	const hostile = [entry(COMPACT_STATE_ENTRY_TYPE, { writePolicy: "lenient", commanderWritesDenied: false, task: "x" })];
	await solSession(stub, hostile);
	type GuardResult = { block?: boolean; reason?: string } | undefined;
	const edit = (await guardCall(stub, "edit", { path: "src/main.ts" })) as GuardResult;
	assert.ok(edit && edit.block === true, "the guard ignores the compact note text");
	assert.match(String(edit.reason), /lease locked/);
});

/** Build a trusted project ctx (real temp project root) for tool/command handlers. */
function trustedProjectCtx(root: string, overrides: Partial<ExtensionContext> = {}): ExtensionCommandContext {
	const statuses: string[] = [];
	const notifyLines: string[] = [];
	const ctx = {
		...fakeCtx([], { model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" } as never }),
		cwd: root,
		isProjectTrusted: () => true,
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (text: string) => {
				notifyLines.push(text);
			},
			setStatus: (_key: string, line: string) => {
				statuses.push(line);
			},
			setWidget: () => {},
			confirm: async () => false,
		},
		...overrides,
	} as unknown as ExtensionCommandContext;
	(ctx as { __statuses?: string[] }).__statuses = statuses;
	(ctx as { __notifyLines?: string[] }).__notifyLines = notifyLines;
	return ctx;
}

test("workbench_run_gate injects the worker-first facts: B6 passes for a clean Sol session (model tool)", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: t\nprofile: generic\n");
		const stub = makeStub();
		workbenchRuntime(stub);
		await solSession(stub); // currentModelFacts = approved Sol
		const tool = stub.tools.get("workbench_run_gate") as {
			execute: (id: string, params: { gates: string; manual_evidence?: Record<string, string> }, signal: unknown, onUpdate: unknown, ctx: ExtensionContext) => Promise<{ details: { status?: string; gates?: Array<{ id: string; status: string }>; ok?: boolean } }>;
		};
		assert.ok(tool, "workbench_run_gate registered");
		const ctx = trustedProjectCtx(root);
		const result = await tool.execute("call-1", { gates: "b6", manual_evidence: {} }, undefined, undefined, ctx);
		const details = result.details;
		assert.equal(details.ok, true, JSON.stringify(details));
		assert.equal(details.status, "PASS");
		const b6 = details.gates?.find((g) => g.id === "b6");
		assert.equal(b6?.status, "PASS", "B6 passes from runtime-injected facts");
	});
});

test("/q-gate (slash command) injects the same worker-first facts", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: t\nprofile: generic\n");
		const stub = makeStub();
		workbenchRuntime(stub);
		await solSession(stub);
		const def = stub.commands.get("q-gate") as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
		assert.ok(def);
		const ctx = trustedProjectCtx(root);
		await def.handler("b6", ctx);
		const output = ((ctx as { __notifyLines?: string[] }).__notifyLines ?? []).join("\n");
		assert.ok(output.includes("b6"), output);
		assert.ok(output.includes("PASS"), output);
		assert.ok(!output.includes("NOT_RUN"), output);
	});
});

test("the gate tool injects delegation-blocked facts: a pending review BLOCKs B6 (runtime wiring)", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: t\nprofile: generic\n");
		const stub = makeStub();
		workbenchRuntime(stub);
		const recorded = recordDelegation(emptyDelegationState(), {
			id: "20260801-120000-abcd",
			diffHash: "a".repeat(64),
			now: "2026-08-01T12:00:00.000Z",
		});
		if (!recorded.ok) throw new Error(recorded.error);
		await solSession(stub, [entry(DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState(recorded.state))]);
		const tool = stub.tools.get("workbench_run_gate") as {
			execute: (id: string, params: { gates: string; manual_evidence?: Record<string, string> }, signal: unknown, onUpdate: unknown, ctx: ExtensionContext) => Promise<{ details: { status?: string; gates?: Array<{ id: string; status: string }>; ok?: boolean } }>;
		};
		const result = await tool.execute("call-1", { gates: "b6" }, undefined, undefined, trustedProjectCtx(root));
		assert.equal(result.details.ok, false);
		assert.equal(result.details.status, "BLOCKED", "pending review BLOCKs B6 in DEV gate runs");
		const b6 = result.details.gates?.find((g) => g.id === "b6");
		assert.equal(b6?.status, "BLOCKED");
	});
});

test("B6 diff freshness fails closed when the real current git facts cannot be collected (failing git exec)", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: t\nprofile: generic\n");
		// A delegation that was REVIEWED with reviewed == current: the stale
		// in-memory pair that must NEVER re-PASS the freshness check without a
		// real git refresh.
		const recorded = recordDelegation(emptyDelegationState(), {
			id: "20260801-120000-abcd",
			diffHash: "a".repeat(64),
			now: "2026-08-01T12:00:00.000Z",
		});
		if (!recorded.ok) throw new Error(recorded.error);
		const reviewed = markReviewed(recorded.state, "2026-08-01T12:05:00.000Z");
		if (!reviewed.ok) throw new Error(reviewed.error);
		const entries = [entry(DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState(reviewed.state))];

		// Inject a failing git exec: every git command rejects, so the real
		// current diff facts cannot be collected.
		const stub = makeStub();
		stub.exec = async (): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			throw new Error("git exec failed");
		};
		workbenchRuntime(stub);
		await solSession(stub, entries);

		const tool = stub.tools.get("workbench_run_gate") as {
			execute: (id: string, params: { gates: string; manual_evidence?: Record<string, string> }, signal: unknown, onUpdate: unknown, ctx: ExtensionContext) => Promise<{ details: { status?: string; gates?: Array<{ id: string; status: string }>; ok?: boolean; run_id?: string } }>;
		};
		assert.ok(tool, "workbench_run_gate registered");
		const result = await tool.execute("call-1", { gates: "b6", manual_evidence: {} }, undefined, undefined, trustedProjectCtx(root));
		const details = result.details;
		assert.equal(details.ok, false, "B6 must not pass when the current diff cannot be collected");
		assert.notEqual(details.status, "PASS");
		const b6 = details.gates?.find((g) => g.id === "b6");
		assert.notEqual(b6?.status, "PASS", "B6 never PASSes from a stale reviewed hash");

		// The reviewed/current hash check is NOT_RUN: the injected current
		// hash is MISSING (never the stale in-memory hash), so the stale
		// reviewed hash cannot satisfy the freshness check.
		assert.ok(details.run_id, "gate run recorded");
		const gatesFile = JSON.parse(
			await readFile(join(root, CONFIG_DIR_NAME, "workbench", "runs", details.run_id, "gates.json"), "utf8"),
		) as { gates: Array<{ id: string; checks: Array<{ check_id: string; status: string }> }> };
		const b6Entry = gatesFile.gates.find((g) => g.id === "b6");
		assert.ok(b6Entry, "b6 record present in gates.json");
		const hashCheck = b6Entry.checks.find((c) => c.check_id === "b6.5");
		assert.ok(hashCheck, "b6.5 check record present");
		assert.equal(hashCheck.status, "NOT_RUN", "reviewed-hash-matches-current is NOT_RUN, never PASS");

		// The authoritative delegation state was neither mutated nor
		// re-persisted by the failed refresh: still REVIEWED with the bound
		// reviewed/current pair intact, and no delegation entry was written.
		const restored = loadDelegationStateFromEntries(entries);
		assert.equal(restored.latestId, "20260801-120000-abcd");
		assert.equal(restored.status, "REVIEWED", "delegation stays REVIEWED");
		assert.equal(restored.currentDiffHash, "a".repeat(64), "in-memory current hash untouched");
		assert.equal(restored.reviewedDiffHash, "a".repeat(64), "reviewed hash untouched");
		assert.equal(
			stub.appendEntryCalls.filter((c) => c.customType === DELEGATION_STATE_ENTRY_TYPE).length,
			0,
			"the failed refresh persists no delegation-state entry",
		);
	});
});

test("B6 diff freshness fails closed on a NON-ZERO git status exit (no fabricated clean tree)", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: t\nprofile: generic\n");
		// The stale in-memory pair that must NEVER re-PASS the freshness check
		// without a real git refresh.
		const recorded = recordDelegation(emptyDelegationState(), {
			id: "20260801-120000-abcd",
			diffHash: "d".repeat(64),
			now: "2026-08-01T12:00:00.000Z",
		});
		if (!recorded.ok) throw new Error(recorded.error);
		const reviewed = markReviewed(recorded.state, "2026-08-01T12:05:00.000Z");
		if (!reviewed.ok) throw new Error(reviewed.error);
		const entries = [entry(DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState(reviewed.state))];

		// Default stub exec: every git command EXITS 1 — the non-zero git
		// status failure form (previously tolerated as an empty clean tree).
		const stub = makeStub();
		workbenchRuntime(stub);
		await solSession(stub, entries);

		const tool = stub.tools.get("workbench_run_gate") as {
			execute: (id: string, params: { gates: string; manual_evidence?: Record<string, string> }, signal: unknown, onUpdate: unknown, ctx: ExtensionContext) => Promise<{ details: { status?: string; gates?: Array<{ id: string; status: string }>; ok?: boolean; run_id?: string } }>;
		};
		assert.ok(tool, "workbench_run_gate registered");
		const result = await tool.execute("call-1", { gates: "b6", manual_evidence: {} }, undefined, undefined, trustedProjectCtx(root));
		const details = result.details;
		assert.equal(details.ok, false, "B6 must not pass when git status exits non-zero");
		assert.notEqual(details.status, "PASS");
		const b6 = details.gates?.find((g) => g.id === "b6");
		assert.notEqual(b6?.status, "PASS", "B6 never PASSes from a stale reviewed hash");

		// The reviewed/current hash check is NOT_RUN: the injected current
		// hash is MISSING (never the stale in-memory hash).
		assert.ok(details.run_id, "gate run recorded");
		const gatesFile = JSON.parse(
			await readFile(join(root, CONFIG_DIR_NAME, "workbench", "runs", details.run_id, "gates.json"), "utf8"),
		) as { gates: Array<{ id: string; checks: Array<{ check_id: string; status: string }> }> };
		const b6Entry = gatesFile.gates.find((g) => g.id === "b6");
		assert.ok(b6Entry, "b6 record present in gates.json");
		const hashCheck = b6Entry.checks.find((c) => c.check_id === "b6.5");
		assert.ok(hashCheck, "b6.5 check record present");
		assert.equal(hashCheck.status, "NOT_RUN", "reviewed-hash-matches-current is NOT_RUN, never PASS");

		// The authoritative delegation state was neither mutated nor
		// re-persisted by the failed refresh.
		const restored = loadDelegationStateFromEntries(entries);
		assert.equal(restored.status, "REVIEWED", "delegation stays REVIEWED");
		assert.equal(restored.currentDiffHash, "d".repeat(64), "in-memory current hash untouched");
		assert.equal(restored.reviewedDiffHash, "d".repeat(64), "reviewed hash untouched");
		assert.equal(
			stub.appendEntryCalls.filter((c) => c.customType === DELEGATION_STATE_ENTRY_TYPE).length,
			0,
			"the failed refresh persists no delegation-state entry",
		);
	});
});

test("workbench_delegate_worker refuses BEFORE creating a ledger or launching when the real git state cannot be collected", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: t\nprofile: generic\n");
		const stub = makeStub();
		stub.exec = async (): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			throw new Error("git exec failed");
		};
		workbenchRuntime(stub);
		await solSession(stub);

		const tool = stub.tools.get("workbench_delegate_worker") as {
			execute: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: ExtensionContext) => Promise<unknown>;
		};
		assert.ok(tool, "workbench_delegate_worker registered");
		await assert.rejects(
			tool.execute(
				"call-1",
				{ task: "t", allowed_paths: ["src/**"], acceptance_criteria: [], verification: [], timeout_seconds: 1800 },
				undefined,
				undefined,
				trustedProjectCtx(root),
			),
			/cannot collect the real git state before delegating/,
			"the delegation is refused with a structured git-collection error",
		);
		// No ledger directory was created and no delegation was recorded.
		// (readdir rejects with ENOENT — the refusal happens before any
		// ledger write.)
		await assert.rejects(readdir(join(root, CONFIG_DIR_NAME, "workbench", "delegations")));
		assert.equal(
			stub.appendEntryCalls.filter((c) => c.customType === DELEGATION_STATE_ENTRY_TYPE).length,
			0,
			"no delegation-state entry was persisted",
		);
	});
});

test("delegation status reports real-git refresh UNAVAILABLE without touching authoritative state or claiming freshness", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: t\nprofile: generic\n");
		const recorded = recordDelegation(emptyDelegationState(), {
			id: "20260801-120000-abcd",
			diffHash: "c".repeat(64),
			now: "2026-08-01T12:00:00.000Z",
		});
		if (!recorded.ok) throw new Error(recorded.error);
		const reviewed = markReviewed(recorded.state, "2026-08-01T12:05:00.000Z");
		if (!reviewed.ok) throw new Error(reviewed.error);
		const entries = [entry(DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState(reviewed.state))];

		// Failing git exec: the real-git refresh cannot run.
		const stub = makeStub();
		stub.exec = async (): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			throw new Error("git exec failed");
		};
		workbenchRuntime(stub);
		await solSession(stub, entries);

		const tool = stub.tools.get("workbench_delegation_status") as {
			execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: ExtensionContext) => Promise<{ content: Array<{ type: string; text: string }>; details: { git_refresh?: string } }>;
		};
		assert.ok(tool, "workbench_delegation_status registered");
		const result = await tool.execute("call-1", {}, undefined, undefined, trustedProjectCtx(root));
		const text = result.content.map((c) => c.text).join("\n");
		assert.ok(text.includes("UNAVAILABLE"), "status visibly reports that the real-git refresh is unavailable");
		assert.ok(text.includes("NOT freshly verified"), "persisted hashes are never presented as freshly verified");
		assert.equal(result.details.git_refresh, "unavailable");

		// The authoritative delegation state was neither mutated nor
		// re-persisted by the failed refresh.
		assert.equal(
			stub.appendEntryCalls.filter((c) => c.customType === DELEGATION_STATE_ENTRY_TYPE).length,
			0,
			"the failed refresh persists no delegation-state entry",
		);
		const restored = loadDelegationStateFromEntries(entries);
		assert.equal(restored.latestId, "20260801-120000-abcd");
		assert.equal(restored.status, "REVIEWED", "delegation stays REVIEWED");
		assert.equal(restored.currentDiffHash, "c".repeat(64), "in-memory current hash untouched");
		assert.equal(restored.reviewedDiffHash, "c".repeat(64), "reviewed hash untouched");
	});
});

test("delegation status refreshes against the real git diff when git works (git_refresh fresh)", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: t\nprofile: generic\n");
		// A real git repo so `git status` succeeds.
		for (const args of [
			["init", "-q"],
			["config", "user.email", "test@example.com"],
			["config", "user.name", "Workbench Test"],
			["config", "commit.gpgsign", "false"],
		]) {
			const result = await spawnExec("git", args, { cwd: root });
			assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
		}
		await writeFile(join(root, "README.md"), "hi\n", "utf8");
		await spawnExec("git", ["add", "-A"], { cwd: root });
		const commit = await spawnExec("git", ["commit", "-q", "-m", "init"], { cwd: root });
		assert.equal(commit.code, 0, `git commit failed: ${commit.stderr}`);

		const stub = makeStub();
		stub.exec = spawnExec;
		workbenchRuntime(stub);
		await solSession(stub);

		const tool = stub.tools.get("workbench_delegation_status") as {
			execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: ExtensionContext) => Promise<{ content: Array<{ type: string; text: string }>; details: { git_refresh?: string } }>;
		};
		assert.ok(tool, "workbench_delegation_status registered");
		const result = await tool.execute("call-1", {}, undefined, undefined, trustedProjectCtx(root));
		const text = result.content.map((c) => c.text).join("\n");
		assert.equal(result.details.git_refresh, "fresh", "a working git status refreshes the report");
		assert.ok(!text.includes("UNAVAILABLE"), "no unavailable marker on a successful refresh");
	});
});
