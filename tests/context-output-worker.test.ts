/** Runtime-level worker/provider assertions for the R7 history boundary. */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import {
	HISTORY_DESCRIPTOR_MAX_BYTES,
	HISTORY_MAX_BUNDLES,
	HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES,
	HISTORY_PROJECTION_ENTRY_TYPE,
	HISTORY_PROJECTION_MAX_SEGMENTS,
	HISTORY_PROJECTION_SEGMENT_MAX_BUNDLES,
	HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
	HistoryProjectionController,
	WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
	historyToolTextBytes,
	validateContextToolPairing,
	type AgentMessage,
	type HistoryProjectionStateEntryData,
} from "../extensions/workbench-runtime/core/context-history-budget.ts";
import {
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_ROLE_ENV,
} from "../extensions/workbench-runtime/core/worker-policy.ts";
import { WORKER_SPEND_PROFILE_ENV } from "../extensions/workbench-runtime/core/worker-spend.ts";
import {
	createOutputControlTelemetry,
	serializeOutputControlTelemetry,
} from "../extensions/workbench-runtime/core/output-control-telemetry.ts";
import { WORKER_TURN_MAX_BYTES } from "../extensions/workbench-runtime/core/output-policy.ts";
import {
	assertWorkerSucceeded,
	runDeepseekWorker,
	type PiInvocation,
} from "../extensions/workbench-runtime/worker/runner.ts";
import type { WorkerTaskContract } from "../extensions/workbench-runtime/core/worker-policy.ts";

interface RuntimeStub {
	events: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	tools: Map<string, unknown>;
	appendedEntries: Array<{ customType: string; data: unknown }>;
}

function makeStub(): RuntimeStub & ExtensionAPI {
	const stub: RuntimeStub & ExtensionAPI = {
		events: new Map(),
		tools: new Map(),
		appendedEntries: [],
		registerCommand: () => {},
		registerTool: (definition: { name: string }) => { stub.tools.set(definition.name, definition); },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const handlers = stub.events.get(event) ?? [];
			handlers.push(handler);
			stub.events.set(event, handlers);
		},
		appendEntry: (customType: string, data?: unknown) => { stub.appendedEntries.push({ customType, data }); },
		sendMessage: () => {},
		sendUserMessage: () => {},
		setActiveTools: () => {},
		getActiveTools: () => [],
		getAllTools: () => [...stub.tools.values()] as never[],
		getThinkingLevel: () => "high" as never,
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	} as unknown as RuntimeStub & ExtensionAPI;
	return stub;
}

function workerRuntime(): RuntimeStub & ExtensionAPI {
	const names = [WORKER_ROLE_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ALLOWED_PATHS_ENV, WORKER_SPEND_PROFILE_ENV] as const;
	const previous = new Map(names.map((name) => [name, process.env[name]]));
	try {
		process.env[WORKER_ROLE_ENV] = "worker";
		delete process.env[WORKER_PROJECT_ROOT_ENV];
		delete process.env[WORKER_ALLOWED_PATHS_ENV];
		delete process.env[WORKER_SPEND_PROFILE_ENV];
		const stub = makeStub();
		workbenchRuntime(stub);
		return stub;
	} finally {
		for (const name of names) {
			const value = previous.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function context(entries: readonly unknown[]): ExtensionContext {
	return {
		mode: "print",
		hasUI: false,
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => entries,
			getSessionFile: () => `${process.cwd()}/worker-session.jsonl`,
			getSessionId: () => "context-output-worker",
		},
		model: undefined,
		thinkingLevel: undefined,
		ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
		signal: undefined,
	} as unknown as ExtensionContext;
}

async function emitContext(
	stub: RuntimeStub,
	messages: AgentMessage[],
	ctx: ExtensionContext,
): Promise<AgentMessage[]> {
	let current = messages;
	const handlers = stub.events.get("context") ?? [];
	assert.equal(handlers.length, 1, "one runtime history boundary per provider request");
	for (const handler of handlers) {
		const result = (await handler({ type: "context", messages: current }, ctx)) as { messages?: AgentMessage[] } | undefined;
		if (result?.messages) current = result.messages;
	}
	return current;
}

function assistant(id: string, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }],
		timestamp,
	} as unknown as AgentMessage;
}

function result(id: string, text: string, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		details: { raw_domain_value: "must-not-enter-descriptors" },
		isError: false,
		timestamp,
	} as unknown as AgentMessage;
}

function manyBundles(prefix: string, count: number): AgentMessage[] {
	const messages: AgentMessage[] = [{ role: "user", content: `request-${prefix}`, timestamp: 0 } as unknown as AgentMessage];
	for (let index = 0; index < count; index += 1) {
		const id = `${prefix}-${index}`;
		const text = index === count - 1
			? `LATEST-${prefix}`
			: `RAW-${prefix}-${index}-${"x".repeat(1_024)}`;
		messages.push(assistant(id, index * 2 + 1), result(id, text, index * 2 + 2));
	}
	return messages;
}

function aggregateBundle(prefix: string, sizes: readonly number[]): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: sizes.map((_, index) => ({
				type: "toolCall",
				id: `${prefix}-${index}`,
				name: "read",
				arguments: { path: `${prefix}-${index}.txt` },
			})),
			timestamp: 1,
		} as unknown as AgentMessage,
		...sizes.map((size, index) => result(`${prefix}-${index}`, String(index).repeat(size), index + 2)),
	];
}

async function emitRuntimeEvent(
	stub: RuntimeStub,
	eventName: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	for (const handler of stub.events.get(eventName) ?? []) await handler(event, ctx);
}

function toolBundleCount(messages: readonly AgentMessage[]): number {
	return messages.filter((message) => {
		if ((message as { role?: unknown }).role !== "assistant") return false;
		const content = (message as { content?: unknown }).content;
		return Array.isArray(content) && content.some((block) => (
			block !== null && typeof block === "object" && (block as { type?: unknown }).type === "toolCall"
		));
	}).length;
}

function resultText(messages: readonly AgentMessage[], id: string): string | undefined {
	const message = messages.find((candidate) => (
		(candidate as { role?: unknown }).role === "toolResult"
		&& (candidate as { toolCallId?: unknown }).toolCallId === id
	));
	if (!message) return undefined;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	return content
		.filter((block): block is { type: "text"; text: string } => (
			block !== null && typeof block === "object"
			&& (block as { type?: unknown }).type === "text"
			&& typeof (block as { text?: unknown }).text === "string"
		))
		.map((block) => block.text)
		.join("");
}

function jsonProviderMessages(messages: readonly AgentMessage[]): unknown[] {
	return JSON.parse(JSON.stringify(convertToLlm(Array.from(messages)))) as unknown[];
}

function latestProjectionState(stub: RuntimeStub): HistoryProjectionStateEntryData {
	const entry = [...stub.appendedEntries].reverse().find((candidate) => (
		candidate.customType === HISTORY_PROJECTION_ENTRY_TYPE
	));
	assert.ok(entry, "runtime must persist the v3 projection state at turn end");
	return entry.data as HistoryProjectionStateEntryData;
}

async function withFakeChild(
	source: string,
	fn: (invocation: PiInvocation, dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "context-output-worker-"));
	try {
		const script = join(dir, "fake-worker.mjs");
		await writeFile(script, source, "utf8");
		await fn({ command: process.execPath, argsPrefix: [script] }, dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const RUNNER_CONTRACT: WorkerTaskContract = {
	task: "Observe the child request-preflight boundary",
	allowedPaths: ["src/**"],
	acceptanceCriteria: ["The child output projection is bounded"],
	verification: [],
};

function envelope(input: {
	policy: "native-read-page" | "run-log-page";
	originalTextBytes: number;
	shownTextBytes: number;
	shownTextLines: number;
}): Record<string, unknown> {
	return {
		schema: "workbench-output-v1",
		policy: input.policy,
		truncated: true,
		originalTextBytes: input.originalTextBytes,
		originalTextLines: 10_000,
		shownTextBytes: input.shownTextBytes,
		shownTextLines: input.shownTextLines,
		omittedTextBytes: input.originalTextBytes - input.shownTextBytes,
		omittedTextLines: 10_000 - input.shownTextLines,
		originalImageCount: 0,
		shownImageCount: 0,
		omittedImageCount: 0,
		reason: "per-tool-cap",
	};
}

test("worker projects 1000 bundles before every provider request without mutating session/input history", async () => {
	const stub = workerRuntime();
	const sessionEntries = [{ type: "message", id: "entry-1", message: { role: "user", content: "SESSION-SENTINEL" } }];
	const sessionBefore = JSON.stringify(sessionEntries);
	const firstInput = manyBundles("first", 1_000);
	const firstBefore = JSON.stringify(firstInput);
	const first = await emitContext(stub, firstInput, context(sessionEntries));

	assert.ok(historyToolTextBytes(first) <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.ok(toolBundleCount(first) <= HISTORY_MAX_BUNDLES);
	assert.equal(validateContextToolPairing(first), true);
	assert.equal(resultText(first, "first-999"), "LATEST-first");
	assert.equal(JSON.stringify(firstInput), firstBefore, "outgoing projection must not rewrite the source messages");
	assert.equal(JSON.stringify(sessionEntries), sessionBefore, "session entries must never be rewritten");

	// A second simulated provider request must project its own current copy;
	// no result text or projected array from the first request is reused.
	const secondInput = manyBundles("second", 160);
	const secondBefore = JSON.stringify(secondInput);
	const second = await emitContext(stub, secondInput, context(sessionEntries));
	assert.ok(historyToolTextBytes(second) <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.ok(toolBundleCount(second) <= HISTORY_MAX_BUNDLES);
	assert.equal(validateContextToolPairing(second), true);
	assert.equal(resultText(second, "second-159"), "LATEST-second");
	assert.equal(resultText(second, "first-999"), undefined);
	assert.equal(JSON.stringify(secondInput), secondBefore);
	assert.equal(JSON.stringify(sessionEntries), sessionBefore);
	assert.equal(stub.appendedEntries.length, 0, "context projection does not persist per-request content or telemetry");
});

test("worker runtime persists strict v3 segments through sixteen seals, checkpoint seventeen, and post-checkpoint seals", async () => {
	const stub = workerRuntime();
	const ctx = context([]);
	const raw: AgentMessage[] = [{ role: "user", content: "worker v3 segmented reserve", timestamp: 0 } as unknown as AgentMessage];
	for (let index = 0; index < 6; index += 1) raw.push(...aggregateBundle(`old-${index}`, [20 * 1_024]));
	raw.push(...aggregateBundle("seed-40k", [40 * 1_024]));
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const expectedAnchorBytes = WORKER_HISTORY_TOOL_TEXT_MAX_BYTES
		- WORKER_TURN_MAX_BYTES
		- HISTORY_PROJECTION_MAX_SEGMENTS * HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES;
	const assertStrictState = (
		state: HistoryProjectionStateEntryData,
		projected: readonly AgentMessage[],
		label: string,
		reserveSelected: boolean,
	): void => {
		const serialized = JSON.stringify(state);
		assert.ok(Buffer.byteLength(serialized, "utf8") <= 32 * 1_024, label);
		const normalized = JSON.parse(serialized) as HistoryProjectionStateEntryData;
		const restored = new HistoryProjectionController();
		assert.equal(restored.restoreFromEntries([
			{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: normalized },
		]), true, label);
		const replayed = restored.project({
			messages: JSON.parse(JSON.stringify(raw)) as AgentMessage[],
			...config,
		});
		assert.deepEqual(jsonProviderMessages(replayed.messages), jsonProviderMessages(projected), label);
		assert.deepEqual(restored.serialize(), normalized, label);
		assert.equal(state.anchorToolTextBytes, expectedAnchorBytes, label);
		assert.equal(
			state.hardToolTextBytes - state.anchorToolTextBytes,
			WORKER_TURN_MAX_BYTES + HISTORY_PROJECTION_MAX_SEGMENTS * HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
			label,
		);
		assert.ok(state.segments.length <= HISTORY_PROJECTION_MAX_SEGMENTS, label);
		for (const segment of state.segments) {
			assert.ok(segment.projectedToolTextBytes <= HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES, label);
			assert.ok(segment.projectedBundles <= HISTORY_PROJECTION_SEGMENT_MAX_BUNDLES, label);
		}
		const stableToolTextBytes = state.anchor.projectedToolTextBytes
			+ state.segments.reduce((sum, segment) => sum + segment.projectedToolTextBytes, 0);
		const stableBundles = state.anchor.projectedBundles
			+ state.segments.reduce((sum, segment) => sum + segment.projectedBundles, 0);
		const activeMessages = raw.slice(state.activeRawStartMessageCount);
		const activeToolTextBytes = historyToolTextBytes(activeMessages);
		const activeBundles = toolBundleCount(activeMessages);
		assert.ok(activeToolTextBytes <= state.hardToolTextBytes - stableToolTextBytes, label);
		assert.ok(activeBundles <= state.hardBundles - stableBundles, label);
		if (reserveSelected) {
			assert.ok(activeToolTextBytes <= WORKER_TURN_MAX_BYTES, label);
			assert.ok(activeBundles <= HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES, label);
		}
		assert.ok(historyToolTextBytes(projected) <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES, label);
		assert.ok(toolBundleCount(projected) <= HISTORY_MAX_BUNDLES, label);
		assert.equal(validateContextToolPairing(projected), true, label);
	};

	const initial = await emitContext(stub, raw, ctx);
	await emitRuntimeEvent(stub, "turn_end", { type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, ctx);
	const initialState = latestProjectionState(stub);
	assert.equal(initialState.schemaVersion, 3);
	assert.equal(initialState.active, 1);
	assert.equal(initialState.segments.length, 0);
	assertStrictState(initialState, initial, "initial", true);
	const anchorMessageCount = initialState.anchor.projectedMessageCount;
	const fixedProviderAnchor = jsonProviderMessages(initial.slice(0, anchorMessageCount));
	assert.ok(fixedProviderAnchor.length > 0, "the immutable provider anchor must be nonempty");
	const initialProviderPayload = jsonProviderMessages(initial);

	raw.push(...aggregateBundle("same-epoch-1k", [1 * 1_024]));
	const sameEpoch = await emitContext(stub, raw, ctx);
	await emitRuntimeEvent(stub, "turn_end", { type: "turn_end", turnIndex: 2, message: {}, toolResults: [] }, ctx);
	const sameState = latestProjectionState(stub);
	assert.equal(sameState.epoch, initialState.epoch);
	assert.equal(sameState.epochHash, initialState.epochHash);
	assert.equal(sameState.segments.length, 0);
	assert.deepEqual(
		jsonProviderMessages(sameEpoch).slice(0, initialProviderPayload.length),
		initialProviderPayload,
		"the complete provider payload is append-only before the active tail seals",
	);
	assertStrictState(sameState, sameEpoch, "same-state append", false);

	// The 48 KiB turn reserve is a suffix-selection budget, not a second hard
	// cap. This append grows the active tail from 41 KiB to 49 KiB while the
	// complete projected history remains below the real 64 KiB worker limit.
	raw.push(...aggregateBundle("reserve-only-8k", [8 * 1_024]));
	const reserveOnly = await emitContext(stub, raw, ctx);
	await emitRuntimeEvent(stub, "turn_end", { type: "turn_end", turnIndex: 3, message: {}, toolResults: [] }, ctx);
	const reserveOnlyState = latestProjectionState(stub);
	assert.ok(historyToolTextBytes(raw.slice(reserveOnlyState.activeRawStartMessageCount)) > WORKER_TURN_MAX_BYTES);
	assert.ok(historyToolTextBytes(reserveOnly) <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.equal(reserveOnlyState.epoch, sameState.epoch);
	assert.equal(reserveOnlyState.epochHash, sameState.epochHash);
	assert.equal(reserveOnlyState.segmentChainHash, sameState.segmentChainHash);
	assert.equal(reserveOnlyState.activeRawStartMessageCount, sameState.activeRawStartMessageCount);
	assert.equal(reserveOnlyState.segments.length, sameState.segments.length);
	assert.deepEqual(
		jsonProviderMessages(reserveOnly).slice(0, jsonProviderMessages(sameEpoch).length),
		jsonProviderMessages(sameEpoch),
		"reserve-only growth must keep the provider prefix append-only",
	);
	assertStrictState(reserveOnlyState, reserveOnly, "reserve-only append", false);

	let previousState = reserveOnlyState;
	let previousProvider = jsonProviderMessages(reserveOnly);
	let previousStableCount = reserveOnlyState.anchor.projectedMessageCount;
	let previousBoundaryIds = [reserveOnlyState.anchor.boundaryId];
	for (let ordinal = 1; ordinal <= HISTORY_PROJECTION_MAX_SEGMENTS + 3; ordinal += 1) {
		const size = ordinal % 2 === 1 ? 48 * 1_024 : 40 * 1_024;
		const id = `roll-${ordinal}`;
		raw.push(...aggregateBundle(id, [size]));
		const projected = await emitContext(stub, raw, ctx);
		await emitRuntimeEvent(stub, "turn_end", {
			type: "turn_end", turnIndex: ordinal + 3, message: {}, toolResults: [],
		}, ctx);
		const state = latestProjectionState(stub);
		const provider = jsonProviderMessages(projected);
		const boundaryIds = [state.anchor.boundaryId, ...state.segments.map((segment) => segment.boundaryId)];
		assertStrictState(state, projected, `ordinal=${ordinal}`, true);
		assert.equal(resultText(projected, `${id}-0`), "0".repeat(size), `ordinal=${ordinal} latest raw`);

		if (ordinal <= HISTORY_PROJECTION_MAX_SEGMENTS) {
			assert.equal(state.epoch, previousState.epoch, `ordinal=${ordinal}`);
			assert.equal(state.epochHash, previousState.epochHash, `ordinal=${ordinal}`);
			assert.equal(state.segments.length, ordinal, `ordinal=${ordinal}`);
			assert.deepEqual(boundaryIds.slice(0, previousBoundaryIds.length), previousBoundaryIds, `ordinal=${ordinal}`);
			assert.deepEqual(provider.slice(0, previousStableCount), previousProvider.slice(0, previousStableCount), `ordinal=${ordinal}`);
			assert.deepEqual(provider.slice(0, anchorMessageCount), fixedProviderAnchor, `ordinal=${ordinal} anchor`);
		} else if (ordinal === HISTORY_PROJECTION_MAX_SEGMENTS + 1) {
			assert.equal(state.epoch, previousState.epoch + 1, "checkpoint increments the epoch exactly once");
			assert.notEqual(state.epochHash, previousState.epochHash, "checkpoint changes the epoch hash");
			assert.equal(state.segments.length, 0, "checkpoint seventeen resets the segment chain");
		} else {
			assert.equal(state.epoch, previousState.epoch, `post-checkpoint ordinal=${ordinal}`);
			assert.equal(state.epochHash, previousState.epochHash, `post-checkpoint ordinal=${ordinal}`);
			assert.equal(state.segments.length, ordinal - HISTORY_PROJECTION_MAX_SEGMENTS - 1, `ordinal=${ordinal}`);
			assert.deepEqual(boundaryIds.slice(0, previousBoundaryIds.length), previousBoundaryIds, `ordinal=${ordinal}`);
			assert.deepEqual(provider.slice(0, previousStableCount), previousProvider.slice(0, previousStableCount), `ordinal=${ordinal}`);
		}
		previousStableCount = state.anchor.projectedMessageCount
			+ state.segments.reduce((sum, segment) => sum + segment.projectedMessageCount, 0);
		previousBoundaryIds = boundaryIds;
		previousProvider = provider;
		previousState = state;
	}

	const pressure = [...stub.appendedEntries].reverse().find((entry) => (
		entry.customType === "workbench-context-pressure-v1"
	))?.data as Record<string, unknown>;
	assert.deepEqual(Object.keys(pressure).sort(), [
		"epoch",
		"hardBundleCount",
		"hardHistoryBytes",
		"projectedToolTextBytes",
		"rawBundleCount",
		"rawToolTextBytes",
		"role",
		"schema",
		"timestampMs",
	].sort(), "the pressure protocol remains the exact nine-field v1 shape");
	assert.equal(pressure.schema, "workbench-context-pressure-v1");
	assert.equal(pressure.role, "worker");
	assert.equal(pressure.hardHistoryBytes, WORKER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.equal(pressure.hardBundleCount, HISTORY_MAX_BUNDLES);
	assert.equal(pressure.epoch, previousState.epoch);
});

test("hostile worker history fails closed and never exposes raw tool text", async () => {
	let trapCalls = 0;
	const hostile = new Proxy({
		role: "toolResult",
		toolCallId: "hostile-id",
		toolName: "read",
		content: [{ type: "text", text: "HOSTILE-RAW-TOOL-SECRET" }],
	}, {
		get: () => { trapCalls += 1; throw new Error("hostile get"); },
		ownKeys: () => { trapCalls += 1; throw new Error("hostile ownKeys"); },
		getOwnPropertyDescriptor: () => { trapCalls += 1; throw new Error("hostile descriptor"); },
		getPrototypeOf: () => { trapCalls += 1; throw new Error("hostile prototype"); },
	}) as unknown as AgentMessage;
	const stub = workerRuntime();
	const projected = await emitContext(stub, [hostile], context([]));
	const serialized = JSON.stringify(projected);
	assert.equal(trapCalls, 0, "proxy detection must precede reflection");
	assert.doesNotMatch(serialized, /HOSTILE-RAW-TOOL-SECRET|hostile get|hostile ownKeys|hostile descriptor/);
	assert.match(serialized, /workbench-history-projection-failure/);
	assert.equal(historyToolTextBytes(projected), 0);
	assert.equal(validateContextToolPairing(projected), true);
});

test("runner observes only fixed numeric child preflight telemetry after consecutive large read/log results", async () => {
	const telemetry = createOutputControlTelemetry("worker");
	assert.equal(telemetry.recordEnvelope("read", envelope({
		policy: "native-read-page",
		originalTextBytes: 2 * 1024 * 1024,
		shownTextBytes: 12_288,
		shownTextLines: 240,
	})), true);
	assert.equal(telemetry.recordEnvelope("workbench_read_run", envelope({
		policy: "run-log-page",
		originalTextBytes: 512 * 1024,
		shownTextBytes: 32_768,
		shownTextLines: 400,
	})), true);
	assert.equal(telemetry.recordTurn({
		schema: "workbench-turn-output-telemetry-v1",
		turnSerial: 7,
		role: "worker",
		planned: true,
		maxBytes: WORKER_TURN_MAX_BYTES,
		reservationCount: 2,
		blockedCalls: 0,
		consumedCalls: 2,
		releasedCalls: 0,
		reservedBytes: WORKER_TURN_MAX_BYTES,
		consumedBytes: 45_000,
		controlConsumedBytes: 0,
		totalAccountedBytes: 45_000,
		releasedBytes: WORKER_TURN_MAX_BYTES - 45_000,
		unusedBytes: WORKER_TURN_MAX_BYTES - 45_000,
	}), true);
	assert.equal(telemetry.recordHistory({
		originalToolTextBytes: 2_500_000,
		finalToolTextBytes: 64_000,
		collapsedResults: 2,
		removedBundles: 1,
		protectedLatestBundles: 2,
	}, "worker"), true);
	const snapshot = serializeOutputControlTelemetry(telemetry.snapshot());
	const secret = "RAW-READ-LOG-TEXT-MUST-NOT-CROSS-RUNNER";
	const events = [
		{
			type: "entry_appended",
			entry: {
				type: "custom",
				customType: "workbench-output-control-telemetry-v1",
				data: snapshot,
				id: "pi-entry-output",
				parentId: "pi-entry-parent",
				timestamp: "2026-08-13T00:00:00.000Z",
			},
		},
		{
			type: "entry_appended",
			entry: {
				type: "custom",
				customType: "workbench-output-turn-telemetry-v1",
				data: {
					role: "worker",
					planning: "planned",
					turnSerial: 7,
					maxBytes: WORKER_TURN_MAX_BYTES,
					reservationCount: 2,
					blockedCalls: 0,
					consumedCalls: 2,
					releasedCalls: 0,
					reservedBytes: WORKER_TURN_MAX_BYTES,
					consumedBytes: 45_000,
					controlConsumedBytes: 0,
					totalAccountedBytes: 45_000,
					releasedBytes: WORKER_TURN_MAX_BYTES - 45_000,
					unusedBytes: WORKER_TURN_MAX_BYTES - 45_000,
				},
				id: "pi-entry-turn",
				parentId: "pi-entry-output",
				timestamp: "2026-08-13T00:00:00.001Z",
			},
		},
		{
			type: "entry_appended",
			entry: {
				type: "custom",
				customType: "workbench-output-control-telemetry-v1",
				data: { text: secret, args: secret, logs: secret, error: secret },
			},
		},
		{
			type: "entry_appended",
			entry: {
				type: "custom",
				customType: "workbench-output-turn-telemetry-v1",
				data: {
					role: "worker",
					planning: "planned",
					turnSerial: 6,
					maxBytes: WORKER_TURN_MAX_BYTES,
					reservationCount: 1,
					blockedCalls: 0,
					consumedCalls: 1,
					releasedCalls: 0,
					reservedBytes: 12_288,
					consumedBytes: 12_000,
					controlConsumedBytes: 0,
					totalAccountedBytes: 12_000,
					releasedBytes: 288,
					unusedBytes: WORKER_TURN_MAX_BYTES - 12_000,
					text: secret,
				},
			},
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				provider: "deepseek",
				model: "deepseek-v4-flash",
				content: [{ type: "text", text: "## Completed\nObserved bounded child preflight facts." }],
				stopReason: "stop",
				usage: {
					input: 10, output: 5, cacheRead: 20, cacheWrite: 0, totalTokens: 35,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		},
	];
	const source = `process.stdout.write(${JSON.stringify(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)});`;
	await withFakeChild(source, async (invocation, dir) => {
		const progress: Array<Record<string, unknown>> = [];
		const worker = await runDeepseekWorker({
			projectRoot: dir,
			contract: RUNNER_CONTRACT,
			timeoutMs: 2_000,
			invocation,
			onProgress: (value) => progress.push({ ...value }),
		});
		assertWorkerSucceeded(worker);
		assert.deepEqual(worker.outputControl, {
			currentToolTextBytes: 64_000,
			collapsedToolResults: 2,
			turnReservedBytes: WORKER_TURN_MAX_BYTES,
		});
		assert.equal(progress.length, 1);
		assert.equal(progress[0]!.currentToolTextBytes, 64_000);
		assert.equal(progress[0]!.collapsedToolResults, 2);
		assert.equal(progress[0]!.turnReservedBytes, WORKER_TURN_MAX_BYTES);
		assert.ok((progress[0]!.currentToolTextBytes as number) <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES);
		assert.doesNotMatch(JSON.stringify([worker.outputControl, progress]), new RegExp(secret));
	});
});
