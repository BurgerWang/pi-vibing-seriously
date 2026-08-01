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
 * session_before_compact supplement (persist entry + hidden next-turn
 * message; never cancel, never replace Pi's compaction).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { COMPACT_NOTE_MESSAGE_TYPE, COMPACT_STATE_ENTRY_TYPE, type CompactState } from "../extensions/workbench-runtime/core/compact.ts";
import { MODE_ENTRY_TYPE } from "../extensions/workbench-runtime/core/state.ts";

interface StubAPI {
	commands: Map<string, unknown>;
	tools: Map<string, unknown>;
	events: Map<string, Array<(event: never, ctx: never) => unknown>>;
	entries: Array<{ type: string; customType: string; data?: unknown }>;
	messages: Array<{ customType: string; content: string; display: boolean; options?: unknown }>;
	activeTools: string[];
	appendEntryCalls: Array<{ customType: string; data: unknown }>;
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
		} as unknown as ExtensionContext["sessionManager"],
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

function entry(customType: string, data: unknown): { type: string; customType: string; data?: unknown } {
	return { type: "custom", customType, data };
}

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

test("session_before_compact never cancels and never replaces Pi compaction", async () => {
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
