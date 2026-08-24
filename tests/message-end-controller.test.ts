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
