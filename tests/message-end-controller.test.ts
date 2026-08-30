import assert from "node:assert/strict";
import { test } from "node:test";

import {
	registerMessageEndController,
	WORKER_TIME_CHECKPOINT_MESSAGE_TYPE,
	WORKER_TIME_FINALIZE_MESSAGE_TYPE,
} from "../extensions/workbench-runtime/core/message-end-controller.ts";

test("worker wall-clock advisories fire at 65% and 85%, then reset on session replacement", () => {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
	const messages: Array<{ customType?: string; content?: string }> = [];
	let budgetSteers = 0;
	const pi = {
		on(name: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		sendMessage(message: { customType?: string; content?: string }) { messages.push(message); },
		getThinkingLevel: () => "xhigh",
		getActiveTools: () => [],
		getAllTools: () => [],
	};
	registerMessageEndController({
		pi: pi as never,
		cacheTelemetry: {} as never,
		getWorkerContext: () => ({ role: "worker", spendProfile: "extended", timeoutMs: 1_000 }),
		projectRootFor: async () => "/project",
		refreshStatus: async () => {},
		onWorkerBudgetSteerSent: () => { budgetSteers += 1; },
		scheduleTimer: (callback, delay) => {
			const timer = { callback, delay, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true; },
	});

	for (const handler of handlers.get("session_start") ?? []) handler({});
	assert.deepEqual(timers.map((timer) => timer.delay), [650, 850]);
	timers[0]!.callback();
	timers[1]!.callback();
	assert.deepEqual(messages.map((message) => message.customType), [
		WORKER_TIME_CHECKPOINT_MESSAGE_TYPE,
		WORKER_TIME_FINALIZE_MESSAGE_TYPE,
	]);
	assert.match(messages[0]!.content ?? "", /Finish one coherent in-scope change/);
	assert.match(messages[1]!.content ?? "", /write the required four-heading final report now/);
	assert.equal(budgetSteers, 2);

	for (const handler of handlers.get("session_start") ?? []) handler({});
	assert.deepEqual(timers.slice(0, 2).map((timer) => timer.cleared), [true, true]);
	assert.deepEqual(timers.slice(2).map((timer) => timer.delay), [650, 850]);
});

test("commander sessions do not schedule worker wall-clock advisories", () => {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	let scheduled = 0;
	registerMessageEndController({
		pi: {
			on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, [handler]); },
			sendMessage() {}, getThinkingLevel: () => "xhigh", getActiveTools: () => [], getAllTools: () => [],
		} as never,
		cacheTelemetry: {} as never,
		getWorkerContext: () => ({ role: undefined, spendProfile: "extended", timeoutMs: 1_000 }),
		projectRootFor: async () => "/project", refreshStatus: async () => {},
		scheduleTimer: () => { scheduled += 1; return {}; }, clearTimer: () => {},
	});
	for (const handler of handlers.get("session_start") ?? []) handler({});
	assert.equal(scheduled, 0);
});

test("a continuation inheriting soft-band spend does not re-steer or checkpoint immediately", async () => {
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const messages: unknown[] = [];
	const entries: unknown[] = [];
	registerMessageEndController({
		pi: {
			on(name: string, handler: (...args: any[]) => unknown) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			sendMessage(message: unknown) { messages.push(message); },
			appendEntry(type: string, value: unknown) { entries.push({ type, value }); },
			getThinkingLevel: () => "xhigh", getActiveTools: () => [], getAllTools: () => [],
		} as never,
		cacheTelemetry: {} as never,
		getWorkerContext: () => ({
			role: "worker",
			spendProfile: "extended",
			attempt: 2,
			initialSpendState: { turns: 64, totalTokens: 160, outputTokens: 40 },
		}),
		projectRootFor: async () => "/project",
		refreshStatus: async () => {},
	});
	for (const handler of handlers.get("session_start") ?? []) handler({});
	const message = {
		role: "assistant",
		usage: {
			input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	for (const handler of handlers.get("message_end") ?? []) {
		await handler({ type: "message_end", message }, { isProjectTrusted: () => false });
	}
	assert.deepEqual(messages, []);
	assert.deepEqual(entries, []);
});

test("soft handoff waits for a reliable final report and emits a bounded rich advisory", async () => {
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const messages: unknown[] = [];
	const entries: Array<{ type: string; value: Record<string, unknown> }> = [];
	registerMessageEndController({
		pi: {
			on(name: string, handler: (...args: any[]) => unknown) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			sendMessage(message: unknown) { messages.push(message); },
			appendEntry(type: string, value: Record<string, unknown>) { entries.push({ type, value }); },
			getThinkingLevel: () => "xhigh", getActiveTools: () => [], getAllTools: () => [],
		} as never,
		cacheTelemetry: {} as never,
		getWorkerContext: () => ({
			role: "worker",
			spendProfile: "standard",
			attempt: 2,
			initialSpendState: { turns: 31, totalTokens: 100, outputTokens: 20 },
		}),
		projectRootFor: async () => "/project",
		refreshStatus: async () => {},
	});
	for (const handler of handlers.get("session_start") ?? []) handler({});
	const emit = async (content: unknown, stopReason?: string) => {
		const message = {
			role: "assistant",
			content,
			stopReason,
			usage: {
				input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		for (const handler of handlers.get("message_end") ?? []) {
			await handler({ type: "message_end", message }, { isProjectTrusted: () => false });
		}
	};
	await emit([{ type: "text", text: "Reached the atomic boundary." }], "toolUse");
	assert.equal(messages.length, 1, "the soft steer fires at turn 32");
	assert.equal(entries.length, 0, "the triggering message is not a handoff report");
	await emit([{ type: "text", text: "## Completed\n- provisional\n## Files Changed\n- None.\n## Verification\n- None.\n## Remaining Risks\n- still running" }, { type: "toolCall", name: "workbench_run_recipe" }], "toolUse");
	assert.equal(entries.length, 0, "tool-use continuation cannot become a prose checkpoint");
	await emit([{ type: "text", text: [
		"## Completed",
		"- Work completed for: C1,C2",
		"- Decision: Keep schema v1; token sk-abcdefgh12345678 is not persisted",
		"- Implemented the parser path",
		"## Files Changed",
		"- src/parser.ts",
		"## Verification",
		"- recipe:unit-test run:20260830-120000-abcd outcome:SUCCESS",
		"## Remaining Risks",
		"- Remaining criteria: C3",
		"- Next: Update the compatibility docs",
		"- Legacy fixture still needs review",
	].join("\n") }], "stop");
	assert.equal(entries.length, 1);
	assert.equal(entries[0]!.value.attempt, 2);
	assert.deepEqual(entries[0]!.value.completed_criteria, ["C1", "C2"]);
	assert.deepEqual(entries[0]!.value.remaining_criteria, ["C3"]);
	assert.deepEqual(entries[0]!.value.completed_work, ["Implemented the parser path"]);
	assert.deepEqual(entries[0]!.value.key_decisions, ["Keep schema v1; token [REDACTED] is not persisted"]);
	assert.deepEqual(entries[0]!.value.next_actions, ["Update the compatibility docs"]);
	assert.deepEqual(entries[0]!.value.remaining_risks, ["Legacy fixture still needs review"]);
	assert.ok(Buffer.byteLength(JSON.stringify(entries[0]!.value), "utf8") < 4 * 1024);
});

test("a malformed terminal soft-handoff report degrades to machine-only continuation", async () => {
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const entries: Array<{ type: string; value: Record<string, unknown> }> = [];
	registerMessageEndController({
		pi: {
			on(name: string, handler: (...args: any[]) => unknown) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			sendMessage() {},
			appendEntry(type: string, value: Record<string, unknown>) { entries.push({ type, value }); },
			getThinkingLevel: () => "xhigh", getActiveTools: () => [], getAllTools: () => [],
		} as never,
		cacheTelemetry: {} as never,
		getWorkerContext: () => ({
			role: "worker", spendProfile: "standard", attempt: 1,
			initialSpendState: { turns: 31, totalTokens: 0, outputTokens: 0 },
		}),
		projectRootFor: async () => "/project", refreshStatus: async () => {},
	});
	for (const handler of handlers.get("session_start") ?? []) handler({});
	const emit = async (content: string, stopReason?: string) => {
		const message = {
			role: "assistant", content: [{ type: "text", text: content }], stopReason,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
		};
		for (const handler of handlers.get("message_end") ?? []) {
			await handler({ type: "message_end", message }, { isProjectTrusted: () => false });
		}
	};
	await emit("soft boundary reached");
	await emit("missing the required headings", "stop");
	assert.equal(entries.length, 1);
	assert.deepEqual(entries[0]!.value.completed_criteria, []);
	assert.deepEqual(entries[0]!.value.remaining_criteria, []);
	assert.deepEqual(entries[0]!.value.next_actions, []);
});
