/** R2 final-envelope, receipt-ordering and persistence fail-safe wiring. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { before, describe, test } from "node:test";

import {
	CONFIG_DIR_NAME,
	DefaultResourceLoader,
	SettingsManager,
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type RegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { COMPARISON_PERSIST_ERROR } from "../extensions/workbench-runtime/core/comparison-record.ts";
import { runsDir, workbenchDir } from "../extensions/workbench-runtime/core/config.ts";
import {
	COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
	HISTORY_MAX_BUNDLES,
	HISTORY_PROJECTION_ENTRY_TYPE,
	OTHER_HISTORY_TOOL_TEXT_MAX_BYTES,
	WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
	historyToolTextBytes,
	validateContextToolPairing,
	type AgentMessage,
} from "../extensions/workbench-runtime/core/context-history-budget.ts";
import {
	COMMANDER_TURN_MAX_BYTES,
	DEFAULT_RESULT_MAX_BYTES,
	DETAILS_MAX_BYTES,
	ERROR_RESULT_MAX_BYTES,
	NATIVE_READ_MAX_BYTES,
	RUN_LOG_RESULT_MAX_BYTES,
	STREAM_UPDATE_MAX_BYTES,
	WORKER_TURN_MAX_BYTES,
} from "../extensions/workbench-runtime/core/output-policy.ts";
import { STREAM_UPDATE_MAX_LINES } from "../extensions/workbench-runtime/core/output-envelope.ts";
import {
	DEFENSIVE_DYNAMIC_RESERVATION_BYTES,
	TURN_CALL_LIMIT_CONTROL_TEXT,
} from "../extensions/workbench-runtime/core/turn-output-budget.ts";
import { COMPARE_SUMMARY_MAX_BYTES, COMPARE_SUMMARY_MAX_LINES } from "../extensions/workbench-runtime/core/render.ts";
import { deriveResultId } from "../extensions/workbench-runtime/core/tool-result-recovery.ts";
import {
	TOOL_RESULT_INGRESS_BUDGET_BYTES,
	TOOL_RESULT_INGRESS_METADATA_MAX_BYTES,
	projectToolResultIngress,
	type TrustedRecoveryAuthority,
	type TrustedRecoverySourceKind,
} from "../extensions/workbench-runtime/core/tool-result-ingress-projection.ts";
import {
	TRUSTED_RECOVERY_SOURCE_MAX_BYTES,
	buildTrustedRecoveryAuthority,
	toolResultTextContentDigest,
} from "../extensions/workbench-runtime/core/trusted-recovery-authority.ts";
import { applyExplicitPromptCacheBreakpoints } from "../extensions/workbench-runtime/core/prompt-cache-breakpoints.ts";
import {
	OUTPUT_CONTROL_STATUS_MAX_BYTES,
	OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE,
	createOutputControlTelemetry,
	parseOutputControlTelemetry,
	serializeOutputControlTelemetry,
} from "../extensions/workbench-runtime/core/output-control-telemetry.ts";
import { WORKER_ALLOWED_PATHS_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ROLE_ENV } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { WORKER_SPEND_PROFILE_ENV } from "../extensions/workbench-runtime/core/worker-spend.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

interface StubAPI {
	commands: Map<string, unknown>;
	tools: Map<string, unknown>;
	toolSources: Map<string, Record<string, unknown>>;
	events: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	eventOrder: string[];
	activeTools: string[];
	appendedEntries: Array<{ customType: string; data: unknown }>;
}

const WORKBENCH_SOURCE_PATH = join(process.cwd(), "extensions/workbench-runtime/index.ts");

function workbenchSourceInfo(): Record<string, unknown> {
	return {
		path: WORKBENCH_SOURCE_PATH,
		source: "local",
		scope: "temporary",
		origin: "top-level",
		baseDir: join(process.cwd(), "extensions/workbench-runtime"),
	};
}

function builtinSourceInfo(name: string): Record<string, unknown> {
	return { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level", baseDir: undefined };
}

function makeStub(): StubAPI & ExtensionAPI {
	const stub: StubAPI & ExtensionAPI = {
		commands: new Map(), tools: new Map(), toolSources: new Map(), events: new Map(), eventOrder: [], activeTools: [], appendedEntries: [],
		registerCommand: (name: string, def: unknown) => { stub.commands.set(name, def); },
		registerTool: (def: { name: string }) => {
			stub.tools.set(def.name, def);
			stub.toolSources.set(def.name, workbenchSourceInfo());
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			stub.eventOrder.push(event);
			const handlers = stub.events.get(event) ?? [];
			handlers.push(handler); stub.events.set(event, handlers);
		},
		appendEntry: (customType: string, data?: unknown) => { stub.appendedEntries.push({ customType, data }); }, sendMessage: () => {}, sendUserMessage: () => {},
		setActiveTools: (tools: string[]) => { stub.activeTools = [...tools]; },
		getActiveTools: () => stub.activeTools,
		getAllTools: () => [...stub.tools.entries()].map(([name, definition]) => {
			const sourceInfo = stub.toolSources.get(name);
			return sourceInfo
				? { ...(definition as Record<string, unknown>), sourceInfo }
				: definition;
		}) as never[],
		getThinkingLevel: () => "high" as never,
		exec: spawnExec,
	} as unknown as StubAPI & ExtensionAPI;
	return stub;
}

function trustedCtx(root: string, sessionId = "output-control-wiring-session"): ExtensionCommandContext {
	return {
		mode: "tui", hasUI: true, cwd: root, isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => [], getSessionFile: () => `${root}/session.jsonl`, getSessionId: () => sessionId,
		} as unknown as ExtensionContext["sessionManager"],
		model: undefined, thinkingLevel: undefined,
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, confirm: async () => false } as unknown as ExtensionContext["ui"],
		signal: undefined,
	} as unknown as ExtensionCommandContext;
}

interface ResultEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: Array<Record<string, unknown>>;
	isError: boolean;
	details?: unknown;
	usage?: unknown;
}

interface ResultPatch {
	content?: Array<Record<string, unknown>>;
	details?: unknown;
	isError?: boolean;
	usage?: unknown;
}

async function emitToolResult(stub: StubAPI, initial: ResultEvent): Promise<ResultEvent> {
	const current = { ...initial, content: [...initial.content] };
	for (const handler of stub.events.get("tool_result") ?? []) {
		const patch = (await handler(current, undefined)) as ResultPatch | undefined;
		if (!patch) continue;
		if (patch.content !== undefined) current.content = patch.content;
		if (patch.details !== undefined) current.details = patch.details;
		if (patch.isError !== undefined) current.isError = patch.isError;
		if (patch.usage !== undefined) current.usage = patch.usage;
	}
	return current;
}

async function emitToolCall(stub: StubAPI, ctx: ExtensionContext, event: unknown): Promise<{ block?: boolean; reason?: string }> {
	let last: { block?: boolean; reason?: string } = {};
	for (const handler of stub.events.get("tool_call") ?? []) {
		const result = (await handler(event, ctx)) as { block?: boolean; reason?: string } | undefined;
		if (result) last = result;
		if (last.block) break;
	}
	return last;
}

async function emitMessageEnd(stub: StubAPI, message: Record<string, unknown>, ctx: ExtensionContext): Promise<Record<string, unknown>> {
	let current = message;
	for (const handler of stub.events.get("message_end") ?? []) {
		const result = (await handler({ type: "message_end", message: current }, ctx)) as { message?: Record<string, unknown> } | undefined;
		if (result?.message) current = result.message;
	}
	return current;
}

async function emitEvent(stub: StubAPI, name: string, event: Record<string, unknown>, ctx: ExtensionContext): Promise<void> {
	for (const handler of stub.events.get(name) ?? []) await handler(event, ctx);
}

async function emitBeforeProviderRequest(stub: StubAPI, payload: unknown, ctx: ExtensionContext): Promise<unknown> {
	let current = payload;
	for (const handler of stub.events.get("before_provider_request") ?? []) {
		const replacement = await handler({ type: "before_provider_request", payload: current }, ctx);
		if (replacement !== undefined) current = replacement;
	}
	return current;
}

async function emitContext(
	stub: StubAPI,
	messages: AgentMessage[],
	ctx: ExtensionContext,
): Promise<AgentMessage[]> {
	let current = messages;
	for (const handler of stub.events.get("context") ?? []) {
		const result = (await handler({ type: "context", messages: current }, ctx)) as { messages?: AgentMessage[] } | undefined;
		if (result?.messages) current = result.messages;
	}
	return current;
}

function assistantBatch(calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>): Record<string, unknown> {
	return {
		role: "assistant",
		content: calls.map((item) => ({ type: "toolCall", id: item.id, name: item.name, arguments: item.arguments ?? {} })),
		provider: "test",
		model: "test",
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function makeRoleRuntime(role: "commander" | "worker" | "other"): StubAPI & ExtensionAPI {
	const names = [WORKER_ROLE_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ALLOWED_PATHS_ENV, WORKER_SPEND_PROFILE_ENV] as const;
	const previous = new Map(names.map((name) => [name, process.env[name]]));
	try {
		if (role === "worker") process.env[WORKER_ROLE_ENV] = "worker";
		else delete process.env[WORKER_ROLE_ENV];
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

async function startBudgetTurn(
	stub: StubAPI,
	ctx: ExtensionContext,
	role: "commander" | "worker" | "other",
	turnIndex: number,
	calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>,
): Promise<void> {
	if (role === "commander") {
		await emitEvent(stub, "model_select", {
			type: "model_select",
			model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" },
			previousModel: undefined,
			source: "set",
		}, ctx);
	}
	await emitEvent(stub, "turn_start", { type: "turn_start", turnIndex, timestamp: 1 }, ctx);
	await emitMessageEnd(stub, assistantBatch(calls), ctx);
}

function textOf(content: Array<Record<string, unknown>>): string {
	return content.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
}

function bytes(text: string): number { return Buffer.byteLength(text, "utf8"); }

async function writeComparisonManifest(root: string, runId: string, startedAt: string): Promise<void> {
	const directory = join(runsDir(root), runId);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "manifest.json"), JSON.stringify({
		schema_version: 1,
		run_id: runId,
		recipe: "test",
		profile: "generic",
		started_at: startedAt,
		finished_at: startedAt,
		duration_ms: 1,
		cwd: ".",
		argv: [],
		exit_code: 0,
		timed_out: false,
		cancelled: false,
		git_commit: null,
		git_dirty: false,
		artifact_paths: [],
		stdout_truncated: false,
		stderr_truncated: false,
		mode: "DEV",
		expected_exit_codes: [0],
		declared_writes: [],
		environment_names: [],
		validation_components: [],
		cache_request_mode: "no-cache",
	}), "utf8");
}

async function writeGatePagingFixture(root: string, runId: string, count: number): Promise<string[]> {
	const directory = join(runsDir(root), runId);
	await mkdir(directory, { recursive: true });
	const timestamp = "2026-08-13T00:00:00.000Z";
	await writeFile(join(directory, "manifest.json"), JSON.stringify({
		schema_version: 1,
		run_id: runId,
		recipe: "gate",
		profile: "generic",
		started_at: timestamp,
		finished_at: timestamp,
		duration_ms: 1,
		cwd: ".",
		argv: [],
		exit_code: 0,
		timed_out: false,
		cancelled: false,
		git_commit: null,
		git_dirty: false,
		artifact_paths: [],
		stdout_truncated: false,
		stderr_truncated: false,
		mode: "VERIFY",
		expected_exit_codes: [0],
		declared_writes: [],
		environment_names: [],
		validation_components: [],
		cache_request_mode: "no-cache",
	}), "utf8");
		const gates = Array.from({ length: count }, (_, index) => ({
		id: `page${index}`,
		title: `gate-${index}-${"界".repeat(80)}`,
		status: index % 7 === 0 ? "FAIL" : "PASS",
		failure_reason: index % 7 === 0 ? `reason-${index}-${"错".repeat(80)}` : null,
		blocked_reason: null,
		checks: [{
			check_id: `page${index}.1`,
			status: index % 7 === 0 ? "FAIL" : "PASS",
			kind: "config",
			failure_reason: index % 7 === 0 ? `check-${index}-${"坏".repeat(80)}` : null,
			blocked_reason: null,
		}],
	}));
	await writeFile(join(directory, "gates.json"), JSON.stringify({
		schema_version: 1,
		run_id: runId,
		requested: ["all"],
		profile: "generic",
		mode: "VERIFY",
		gates,
	}), "utf8");
	return gates.flatMap((gate) => [`gate:${gate.id}`, `check:${gate.id}/${gate.checks[0]!.check_id}`]);
}

before(() => {
	delete process.env[WORKER_ROLE_ENV];
	delete process.env[WORKER_PROJECT_ROOT_ENV];
	delete process.env[WORKER_ALLOWED_PATHS_ENV];
	delete process.env[WORKER_SPEND_PROFILE_ENV];
});

test("runtime registers one fail-closed context projector before provider telemetry and applies exact role ceilings", async () => {
	const makeHistory = (id: string, text: string): AgentMessage[] => [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { path: "bounded.txt" } }],
			timestamp: 1,
		} as unknown as AgentMessage,
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 2,
		} as unknown as AgentMessage,
	];
	const input = makeHistory("role-cap", "x".repeat(80 * 1_024));
	const run = async (role: "commander" | "worker" | "other") => {
		const stub = makeRoleRuntime(role);
		const ctx = trustedCtx(process.cwd(), `history-${role}`) as ExtensionContext;
		assert.equal(stub.events.get("context")?.length, 1);
		assert.ok(stub.eventOrder.indexOf("context") < stub.eventOrder.indexOf("before_provider_request"));
		if (role === "commander") {
			await emitEvent(stub, "model_select", {
				type: "model_select",
				model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" },
				previousModel: undefined,
				source: "set",
			}, ctx);
		}
		return emitContext(stub, input, ctx);
	};

	const commander = await run("commander");
	const worker = await run("worker");
	const other = await run("other");
	assert.equal(historyToolTextBytes(commander), 80 * 1_024);
	assert.ok(historyToolTextBytes(commander) <= COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.ok(historyToolTextBytes(worker) <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.ok(historyToolTextBytes(other) <= OTHER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.ok(historyToolTextBytes(worker) < historyToolTextBytes(commander));
	assert.ok(historyToolTextBytes(other) < historyToolTextBytes(commander));
	assert.equal(validateContextToolPairing(commander), true);
	assert.equal(validateContextToolPairing(worker), true);
	assert.equal(validateContextToolPairing(other), true);

	const source = await readFile(join(process.cwd(), "extensions/workbench-runtime/index.ts"), "utf8");
	const handlerStart = source.indexOf('pi.on("context"');
	const providerStart = source.indexOf('pi.on("before_provider_request"');
	assert.ok(handlerStart >= 0 && handlerStart < providerStart);
	assert.equal((source.match(/pi\.on\("context"/g) ?? []).length, 1);
	const handler = source.slice(handlerStart, providerStart);
	assert.match(handler, /catch\s*\{/);
	assert.match(handler, /historyProjectionController\.project\(/);
	assert.match(handler, /safeHistoryProjectionFailureMessages\(\)/);
	assert.doesNotMatch(handler, /historyProjectionFailureMessages|historyToolTextBytes\(\s*event\.messages/);
	assert.doesNotMatch(handler, /appendEntry|sessionManager|getEntries|event\.messages\s*=/);
});

test("runtime applies v3 boundary breakpoints only to public OpenAI GPT-5.6 and resets them with projection lifecycle", async () => {
	const stub = makeRoleRuntime("other");
	const base = trustedCtx(process.cwd(), "runtime-prompt-cache-breakpoint") as ExtensionContext;
	const publicOpenAiCtx = {
		...base,
		model: { provider: "openai", id: "gpt-5.6-sol", api: "openai-responses" },
	} as ExtensionContext;
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 5; index += 1) {
		const id = `runtime-cache-boundary-${index}`;
		raw.push(
			{
				role: "assistant",
				content: [{ type: "toolCall", id, name: "read", arguments: { path: `${index}.txt` } }],
				timestamp: index * 2 + 1,
			} as unknown as AgentMessage,
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: String(index).repeat(20 * 1_024) }],
				isError: false,
				timestamp: index * 2 + 2,
			} as unknown as AgentMessage,
		);
	}
	const projected = await emitContext(stub, raw, publicOpenAiCtx);
	const markers = projected.flatMap((message) => {
		const candidate = message as unknown as { customType?: unknown; content?: unknown };
		return candidate.customType === "workbench-history-projection-boundary" && typeof candidate.content === "string"
			? [candidate.content]
			: [];
	});
	assert.ok(markers.length >= 1, "a projected v3 anchor exposes at least one exact provider boundary marker");

	const publicPayload = breakpointPayload(markers);
	const publicResult = await emitBeforeProviderRequest(stub, publicPayload, publicOpenAiCtx) as Record<string, unknown>;
	assert.notEqual(publicResult, publicPayload);
	const publicBlocks = (((publicResult.input as Array<Record<string, unknown>>)[0]!.content) as Array<Record<string, unknown>>);
	assert.deepEqual(publicBlocks.map((block) => block.prompt_cache_breakpoint), markers.map(() => ({ mode: "explicit" })));
	assert.deepEqual(withoutPromptCacheBreakpoints(publicResult), publicPayload);
	assert.equal(
		await emitBeforeProviderRequest(stub, publicResult, publicOpenAiCtx),
		publicResult,
		"an already-applied outgoing payload remains identity-exact",
	);

	const codexPayload = breakpointPayload(markers);
	const codexCtx = {
		...base,
		model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-codex-responses" },
	} as ExtensionContext;
	assert.equal(await emitBeforeProviderRequest(stub, codexPayload, codexCtx), codexPayload, "Codex remains experimentally disabled");

	const deepseekPayload = {
		model: "deepseek-v4-flash",
		messages: [{ role: "system", content: "stable" }, { role: "user", content: "worker" }],
		prompt_cache_key: "must-stay-uninterpreted",
	};
	const deepseekBytes = Buffer.from(JSON.stringify(deepseekPayload));
	const deepseekCtx = {
		...base,
		model: { provider: "deepseek", id: "deepseek-v4-flash", api: "openai-completions" },
	} as ExtensionContext;
	const deepseekResult = await emitBeforeProviderRequest(stub, deepseekPayload, deepseekCtx);
	assert.equal(deepseekResult, deepseekPayload);
	assert.deepEqual(deepseekResult, deepseekPayload);
	assert.deepEqual(Buffer.from(JSON.stringify(deepseekResult)), deepseekBytes);

	await emitEvent(stub, "session_tree", { type: "session_tree", newLeafId: "new", oldLeafId: "old" }, publicOpenAiCtx);
	const afterReset = breakpointPayload(markers);
	assert.equal(
		await emitBeforeProviderRequest(stub, afterReset, publicOpenAiCtx),
		afterReset,
		"session-tree projection reset clears the in-memory provider markers",
	);

	const source = await readFile(join(process.cwd(), "extensions/workbench-runtime/index.ts"), "utf8");
	const contextStart = source.indexOf('pi.on("context"');
	const providerStart = source.indexOf('pi.on("before_provider_request"');
	const providerEnd = source.indexOf('pi.on("message_end"', providerStart);
	const contextHandler = source.slice(contextStart, providerStart);
	const providerHandler = source.slice(providerStart, providerEnd);
	assert.match(contextHandler, /if \(projection\.epochTransitioned && projection\.epochHash\)[\s\S]*else if \(projection\.segmentSealed && projection\.segmentChainHash\)/);
	assert.match(contextHandler, /observeHistoryProjectionSegmentSeal\(projection\.segmentChainHash\)/);
	const helperIndex = providerHandler.indexOf("applyExplicitPromptCacheBreakpoints(");
	const observeIndex = providerHandler.indexOf("cacheTelemetry.observePayload(");
	const appliedEventIndex = providerHandler.indexOf("cacheTelemetry.observeExplicitPromptCacheBreakpointsApplied(");
	const returnIndex = providerHandler.indexOf("return breakpointResult.payload");
	assert.ok(
		helperIndex >= 0 && helperIndex < observeIndex && observeIndex < appliedEventIndex && appliedEventIndex < returnIndex,
		"helper → transformed observation → applied preceding event → outgoing replacement order",
	);
	assert.match(providerHandler, /breakpointResult\.status === "applied" \|\| breakpointResult\.reason === "already_applied"/);
	assert.match(providerHandler, /allowCodexExperimental:\s*false/);
});

test("worker runtime projects the real outgoing context and round-trips strict v3 state", async () => {
	const stub = makeRoleRuntime("worker");
	const ctx = trustedCtx(process.cwd(), "worker-history-v3") as ExtensionContext;
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 5; index += 1) {
		const id = `worker-history-${index}`;
		raw.push(
			{
				role: "assistant",
				content: [{ type: "toolCall", id, name: "read", arguments: { path: `${index}.txt` } }],
				timestamp: index * 2 + 1,
			} as unknown as AgentMessage,
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: String(index).repeat(20 * 1_024) }],
				isError: false,
				timestamp: index * 2 + 2,
			} as unknown as AgentMessage,
		);
	}

	await emitEvent(stub, "turn_start", { type: "turn_start", turnIndex: 61, timestamp: 1 }, ctx);
	const projected = await emitContext(stub, raw, ctx);
	assert.ok(historyToolTextBytes(projected) <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.equal(validateContextToolPairing(projected), true);
	const latest = projected.find((message) => (
		(message as { role?: unknown }).role === "toolResult"
		&& (message as { toolCallId?: unknown }).toolCallId === "worker-history-4"
	)) as unknown as { content: Array<Record<string, unknown>> };
	assert.equal(textOf(latest.content), "4".repeat(20 * 1_024), "latest complete worker bundle stays raw");

	await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex: 61, message: {}, toolResults: [] }, ctx);
	const persisted = [...stub.appendedEntries].reverse().find((entry) => entry.customType === HISTORY_PROJECTION_ENTRY_TYPE);
	assert.ok(persisted, "worker persists the v3 custom entry type");
	const state = persisted.data as Record<string, unknown>;
	assert.deepEqual(Object.keys(state).sort(), [
		"active", "activeRawStartMessageCount", "anchor", "anchorBundles", "anchorToolTextBytes", "descriptorMaxBytes",
		"epoch", "epochHash", "hardBundles", "hardToolTextBytes", "observedRawHash", "observedRawMessageCount",
		"projectedBundles", "projectedToolTextBytes", "rawBundles", "rawToolTextBytes", "schemaVersion",
		"segmentChainHash", "segments", "stateHash", "transitionCollapsedResults", "transitionRemovedBundles",
	].sort());
	assert.equal(state.schemaVersion, 3);
	assert.equal(state.active, 1);
	assert.equal(state.hardToolTextBytes, WORKER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.equal(state.hardBundles, HISTORY_MAX_BUNDLES);
	assert.equal(
		state.anchorToolTextBytes,
		Math.max(0, WORKER_HISTORY_TOOL_TEXT_MAX_BYTES - WORKER_TURN_MAX_BYTES - 16 * 384),
	);
	assert.equal(state.anchorBundles, HISTORY_MAX_BUNDLES - 16 - 16);
	assert.match(String(state.epochHash), /^[0-9a-f]{64}$/);
	assert.match(String(state.segmentChainHash), /^[0-9a-f]{64}$/);
	assert.match(String(state.stateHash), /^[0-9a-f]{64}$/);
	assert.ok(Array.isArray(state.segments));
	assert.equal(state.segments.length, 0);
	const anchor = state.anchor as Record<string, unknown>;
	assert.deepEqual(Object.keys(anchor).sort(), [
		"boundaryId", "collapsedResults", "projectedBundles", "projectedHash", "projectedMessageCount",
		"projectedToolTextBytes", "rawEndMessageCount", "rawHash", "rawStartMessageCount", "removedBundles",
	].sort());
	assert.equal(anchor.rawStartMessageCount, 0);
	assert.ok(Number(anchor.rawEndMessageCount) > 0);
	assert.ok(Number(anchor.projectedMessageCount) > 0, "the fixed anchor is nonempty");
	assert.ok(Number(anchor.projectedToolTextBytes) <= Number(state.anchorToolTextBytes));
	assert.ok(Number(anchor.projectedBundles) <= Number(state.anchorBundles));
	for (const key of ["boundaryId", "projectedHash", "rawHash"]) assert.match(String(anchor[key]), /^[0-9a-f]{64}$/);
	assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") <= 32 * 1_024);

	const wireState = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
	const resumedStub = makeRoleRuntime("worker");
	const resumedBase = trustedCtx(process.cwd(), "worker-history-v3-resume") as ExtensionContext;
	const resumedCtx = {
		...resumedBase,
		sessionManager: {
			...resumedBase.sessionManager,
			getEntries: () => [{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: wireState }],
		},
	} as ExtensionContext;
	await emitEvent(resumedStub, "session_start", { type: "session_start", reason: "reload" }, resumedCtx);
	await emitEvent(resumedStub, "turn_start", { type: "turn_start", turnIndex: 62, timestamp: 2 }, resumedCtx);
	const replayed = await emitContext(
		resumedStub,
		JSON.parse(JSON.stringify(raw)) as AgentMessage[],
		resumedCtx,
	);
	assert.deepEqual(
		JSON.parse(JSON.stringify(convertToLlm(replayed))),
		JSON.parse(JSON.stringify(convertToLlm(projected))),
		"strict JSON-wire state restores the exact provider projection",
	);
	await emitEvent(resumedStub, "turn_end", { type: "turn_end", turnIndex: 62, message: {}, toolResults: [] }, resumedCtx);
	const replayedState = [...resumedStub.appendedEntries].reverse()
		.find((entry) => entry.customType === HISTORY_PROJECTION_ENTRY_TYPE)?.data;
	assert.deepEqual(replayedState, wireState, "an unchanged replay preserves strict v3 state exactly");
});

test("runtime context terminal fallback never re-inspects hostile messages or exposes raw context", async () => {
	const stub = makeRoleRuntime("other");
	const ctx = trustedCtx(process.cwd(), "history-hostile-runtime") as ExtensionContext;
	const handler = stub.events.get("context")?.[0];
	assert.ok(handler);
	const invoke = async (event: unknown): Promise<AgentMessage[]> => {
		const result = (await handler(event, ctx)) as { messages?: AgentMessage[] } | undefined;
		assert.ok(result?.messages);
		assert.equal(result.messages.length, 1);
		assert.equal((result.messages[0] as { customType?: unknown }).customType, "workbench-history-projection-failure");
		assert.equal(validateContextToolPairing(result.messages), true);
		assert.ok(historyToolTextBytes(result.messages) <= OTHER_HISTORY_TOOL_TEXT_MAX_BYTES);
		assert.doesNotMatch(JSON.stringify(result.messages), /RAW-CONTEXT-SECRET|HOSTILE-CONTEXT/);
		return result.messages;
	};

	let eventGetterCalls = 0;
	const accessorEvent: Record<string, unknown> = { type: "context" };
	Object.defineProperty(accessorEvent, "messages", {
		enumerable: true,
		get(): never {
			eventGetterCalls += 1;
			throw new Error("RAW-CONTEXT-SECRET-EVENT");
		},
	});
	await invoke(accessorEvent);
	assert.equal(eventGetterCalls, 1, "terminal catch must not read event.messages a second time");

	let proxyTrapCalls = 0;
	const hostileMessages = new Proxy([] as AgentMessage[], {
		get(): never {
			proxyTrapCalls += 1;
			throw new Error("RAW-CONTEXT-SECRET-PROXY");
		},
	});
	await invoke({ type: "context", messages: hostileMessages });
	assert.equal(proxyTrapCalls, 0, "controller must reject a hostile messages proxy without invoking any trap");

	const revoked = Proxy.revocable([] as AgentMessage[], {});
	revoked.revoke();
	await invoke({ type: "context", messages: revoked.proxy });
});

test("runtime seals v3 segments on true hard crossings without rewriting stable prefixes and checkpoints seal 17", async () => {
	const stub = makeRoleRuntime("other");
	const ctx = trustedCtx(process.cwd(), "history-epoch-runtime") as ExtensionContext;
	const providerWire = (messages: AgentMessage[]): unknown[] => (
		JSON.parse(JSON.stringify(convertToLlm(messages))) as unknown[]
	);
	const boundaryMarkers = (messages: AgentMessage[]): string[] => messages.flatMap((message) => {
		const candidate = message as unknown as { customType?: unknown; content?: unknown };
		return candidate.customType === "workbench-history-projection-boundary" && typeof candidate.content === "string"
			? [candidate.content]
			: [];
	});
	const latestState = (): Record<string, unknown> => {
		const entry = [...stub.appendedEntries].reverse().find((item) => item.customType === HISTORY_PROJECTION_ENTRY_TYPE);
		assert.ok(entry, "the runtime persists a v3 history state after each completed turn");
		return entry.data as Record<string, unknown>;
	};
	const stableMessageCount = (state: Record<string, unknown>): number => {
		const anchor = state.anchor as Record<string, unknown>;
		const segments = state.segments as Array<Record<string, unknown>>;
		return Number(anchor.projectedMessageCount)
			+ segments.reduce((sum, segment) => sum + Number(segment.projectedMessageCount), 0);
	};
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 30; index += 1) {
		const id = `runtime-epoch-${index}`;
		raw.push(
			{ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }], timestamp: index * 2 + 1 } as unknown as AgentMessage,
			{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "x".repeat(3_000) }], isError: false, timestamp: index * 2 + 2 } as unknown as AgentMessage,
		);
	}
	await emitEvent(stub, "turn_start", { type: "turn_start", turnIndex: 51, timestamp: 1 }, ctx);
	const first = await emitContext(stub, raw, ctx);
	const firstCollapsed = first.filter((message) => (
		(message as { role?: unknown }).role === "toolResult"
		&& textOf((message as { content?: Array<Record<string, unknown>> }).content ?? []).includes("[historical tool result collapsed]")
	)).length;
	assert.ok(firstCollapsed > 0);
	const firstProviderVisible = providerWire(first);
	raw.push({ role: "user", content: "ordinary same-epoch append", timestamp: 900 } as unknown as AgentMessage);
	const sameEpochAppend = await emitContext(stub, raw, ctx);
	const sameEpochProviderVisible = providerWire(sameEpochAppend);
	assert.deepEqual(
		sameEpochProviderVisible.slice(0, firstProviderVisible.length),
		firstProviderVisible,
		"a non-sealing append preserves the complete provider-visible payload prefix",
	);
	await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex: 51, message: {}, toolResults: [] }, ctx);
	let previousProviderVisible = sameEpochProviderVisible;
	let previousMarkers = boundaryMarkers(sameEpochAppend);
	let previousState = latestState();
	assert.equal(previousState.schemaVersion, 3);
	assert.equal(previousState.active, 1);
	assert.equal((previousState.segments as unknown[]).length, 0);
	const initialEpoch = Number(previousState.epoch);
	const initialEpochHash = String(previousState.epochHash);
	assert.match(initialEpochHash, /^[0-9a-f]{64}$/);
	let checkpointEpoch = initialEpoch;
	for (let index = 0; index < 25; index += 1) {
		await emitEvent(stub, "turn_start", { type: "turn_start", turnIndex: 52 + index, timestamp: 2 + index }, ctx);
		const id = `runtime-suffix-${index}`;
		const suffixBytes = index % 2 === 0 ? 48 * 1_024 : 40 * 1_024;
		raw.push(
			{ role: "user", content: `suffix-${index}`, timestamp: 1_000 + index * 3 } as unknown as AgentMessage,
			{ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }], timestamp: 1_001 + index * 3 } as unknown as AgentMessage,
			{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: String(index % 10).repeat(suffixBytes) }], isError: false, timestamp: 1_002 + index * 3 } as unknown as AgentMessage,
		);
		assert.ok(
			Number(previousState.projectedToolTextBytes) + suffixBytes > OTHER_HISTORY_TOOL_TEXT_MAX_BYTES,
			`seal ${index + 1} fixture must cross the complete projected-history hard byte cap`,
		);
		const next = await emitContext(stub, raw, ctx);
		await emitEvent(stub, "turn_end", {
			type: "turn_end", turnIndex: 52 + index, message: {}, toolResults: [],
		}, ctx);
		const nextProviderVisible = providerWire(next);
		const nextMarkers = boundaryMarkers(next);
		const nextState = latestState();
		const seal = index + 1;
		const nextSegments = nextState.segments as Array<Record<string, unknown>>;
		assert.equal(nextState.schemaVersion, 3, `seal ${seal}`);
		assert.equal(nextState.active, 1, `seal ${seal}`);
		assert.equal(nextState.hardToolTextBytes, OTHER_HISTORY_TOOL_TEXT_MAX_BYTES, `seal ${seal}`);
		assert.equal(nextState.hardBundles, HISTORY_MAX_BUNDLES, `seal ${seal}`);
		assert.ok(Buffer.byteLength(JSON.stringify(nextState), "utf8") <= 32 * 1_024, `seal ${seal}`);
		const anchor = nextState.anchor as Record<string, unknown>;
		assert.ok(Number(anchor.projectedMessageCount) > 0, `seal ${seal} nonempty anchor`);
		for (const segment of nextSegments) {
			assert.ok(Number(segment.projectedToolTextBytes) <= 384, `seal ${seal} segment byte reserve`);
			assert.ok(Number(segment.projectedBundles) <= 1, `seal ${seal} segment bundle reserve`);
		}
		assert.ok(historyToolTextBytes(next) <= OTHER_HISTORY_TOOL_TEXT_MAX_BYTES, `seal ${seal} hard byte cap`);
		assert.equal(validateContextToolPairing(next), true, `seal ${seal} pairing`);
		const stableBundles = Number(anchor.projectedBundles)
			+ nextSegments.reduce((sum, segment) => sum + Number(segment.projectedBundles), 0);
		assert.ok(Number(nextState.projectedBundles) - stableBundles <= 16, `seal ${seal} active bundle reserve`);
		assert.ok(
			historyToolTextBytes(raw.slice(Number(nextState.activeRawStartMessageCount))) <= WORKER_TURN_MAX_BYTES,
			`seal ${seal} active turn reserve`,
		);

		if (seal <= 16) {
			assert.equal(Number(nextState.epoch), initialEpoch, `seal ${seal} must not advance the epoch`);
			assert.equal(nextState.epochHash, initialEpochHash, `seal ${seal} must keep the epoch hash`);
			assert.equal(nextSegments.length, seal, `seal ${seal} segment count`);
			assert.deepEqual(nextState.anchor, previousState.anchor, `seal ${seal} rewrote the anchor`);
			assert.deepEqual(
				nextSegments.slice(0, (previousState.segments as unknown[]).length),
				previousState.segments,
				`seal ${seal} rewrote a prior segment`,
			);
			assert.deepEqual(nextMarkers.slice(0, previousMarkers.length), previousMarkers, `seal ${seal} marker prefix`);
			const immutableCount = stableMessageCount(previousState);
			assert.deepEqual(
				nextProviderVisible.slice(0, immutableCount),
				previousProviderVisible.slice(0, immutableCount),
				`seal ${seal} rewrote the anchor/prior-segment provider prefix`,
			);
		} else if (seal === 17) {
			checkpointEpoch = initialEpoch + 1;
			assert.equal(Number(nextState.epoch), checkpointEpoch, "seal 17 performs exactly one checkpoint");
			assert.notEqual(nextState.epochHash, initialEpochHash, "checkpoint replaces the epoch hash");
			assert.equal(nextSegments.length, 0, "checkpoint clears the sealed segment chain");
			assert.equal(nextMarkers.length, 1, "checkpoint leaves one fixed anchor boundary");
		} else {
			assert.equal(Number(nextState.epoch), checkpointEpoch, `post-checkpoint seal ${seal} epoch`);
			assert.equal(nextSegments.length, seal - 17, `post-checkpoint seal ${seal} segment count`);
			assert.deepEqual(nextState.anchor, previousState.anchor, `post-checkpoint seal ${seal} rewrote the anchor`);
			assert.deepEqual(
				nextSegments.slice(0, (previousState.segments as unknown[]).length),
				previousState.segments,
				`post-checkpoint seal ${seal} rewrote a prior segment`,
			);
			assert.deepEqual(nextMarkers.slice(0, previousMarkers.length), previousMarkers, `post-checkpoint seal ${seal} marker prefix`);
			const immutableCount = stableMessageCount(previousState);
			assert.deepEqual(
				nextProviderVisible.slice(0, immutableCount),
				previousProviderVisible.slice(0, immutableCount),
				`post-checkpoint seal ${seal} rewrote the stable provider prefix`,
			);
		}
		previousProviderVisible = nextProviderVisible;
		previousMarkers = nextMarkers;
		previousState = nextState;
	}

	const outputEntry = [...stub.appendedEntries].reverse().find((entry) => entry.customType === OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE);
	const outputSnapshot = parseOutputControlTelemetry(outputEntry?.data);
	assert.ok(outputSnapshot);

	const state = latestState();
	assert.equal(state.active, 1);
	assert.equal(state.schemaVersion, 3);
	assert.match(String(state.epochHash), /^[0-9a-f]{64}$/);
	assert.match(String(state.segmentChainHash), /^[0-9a-f]{64}$/);
	assert.match(String(state.stateHash), /^[0-9a-f]{64}$/);
	assert.equal((state.segments as unknown[]).length, 8, "eight seals follow checkpoint 17");
	assert.equal(JSON.stringify(state).includes("runtime-epoch"), false);
	assert.equal(outputSnapshot.totals.historyCollapsedResults, state.transitionCollapsedResults, "replays do not re-count collapsed results");
	assert.equal(outputSnapshot.totals.historyRemovedBundles, state.transitionRemovedBundles, "replays do not re-count removed bundles");
	const wireState = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
	const resumedStub = makeRoleRuntime("other");
	const resumedBase = trustedCtx(process.cwd(), "history-epoch-resume") as ExtensionContext;
	const resumedCtx = {
		...resumedBase,
		sessionManager: {
			...resumedBase.sessionManager,
			getEntries: () => [{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: wireState }],
		},
	} as ExtensionContext;
	await emitEvent(resumedStub, "session_start", { type: "session_start", reason: "reload" }, resumedCtx);
	const resumedRaw = [
		...(JSON.parse(JSON.stringify(raw)) as AgentMessage[]),
		{ role: "user", content: "bounded suffix", timestamp: 2_000 } as unknown as AgentMessage,
	];
	const resumed = await emitContext(resumedStub, resumedRaw, resumedCtx);
	assert.deepEqual(
		providerWire(resumed).slice(0, previousProviderVisible.length),
		previousProviderVisible,
		"strict JSON-wire reload restores the exact anchor, segments, and active provider prefix",
	);
	assert.deepEqual(boundaryMarkers(resumed), previousMarkers, "reload restores every persisted v3 boundary marker");

	const pressureEntry = [...stub.appendedEntries].reverse().find((entry) => entry.customType === "workbench-context-pressure-v1");
	const pressure = pressureEntry?.data as Record<string, unknown>;
	assert.deepEqual(Object.keys(pressure).sort(), [
		"epoch", "hardBundleCount", "hardHistoryBytes", "projectedToolTextBytes", "rawBundleCount",
		"rawToolTextBytes", "role", "schema", "timestampMs",
	].sort());
	assert.equal(pressure.schema, "workbench-context-pressure-v1");
	assert.equal(pressure.role, "other");
	assert.equal(pressure.rawBundleCount, 55);
	assert.equal(pressure.hardHistoryBytes, OTHER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.equal(pressure.hardBundleCount, HISTORY_MAX_BUNDLES);
	assert.ok(typeof pressure.timestampMs === "number" && Number.isSafeInteger(pressure.timestampMs));

	await emitEvent(stub, "session_tree", { type: "session_tree", newLeafId: "new", oldLeafId: "old" }, ctx);
	const treeReset = [...stub.appendedEntries].reverse().find((entry) => entry.customType === HISTORY_PROJECTION_ENTRY_TYPE)?.data as Record<string, unknown>;
	assert.equal(treeReset.schemaVersion, 3);
	assert.equal(treeReset.active, 0);
	assert.deepEqual(treeReset.segments, []);
	await emitContext(stub, raw, ctx);
	await emitEvent(stub, "session_compact", { type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "manual", willRetry: false }, ctx);
	const compactReset = [...stub.appendedEntries].reverse().find((entry) => entry.customType === HISTORY_PROJECTION_ENTRY_TYPE)?.data as Record<string, unknown>;
	assert.equal(compactReset.schemaVersion, 3);
	assert.equal(compactReset.active, 0);
	assert.deepEqual(compactReset.segments, []);
});

test("runtime session_tree marks exactly the next cache record expected and preserves later drift detection", async () => {
	await withTempDir(async (root) => {
		const stub = makeRoleRuntime("other");
		const base = trustedCtx(root, "cache-session-tree-runtime") as ExtensionContext;
		const ctx = {
			...base,
			model: { provider: "deepseek", id: "deepseek-v4-flash", api: "openai-completions" },
			thinkingLevel: "high",
			getSystemPrompt: () => "stable workbench system prompt",
		} as ExtensionContext;
		const payload = (text: string) => ({
			model: "deepseek-v4-flash",
			messages: [{ role: "system", content: "stable workbench system prompt" }, { role: "user", content: text }],
		});
		const assistant = (timestamp: number) => ({
			role: "assistant",
			content: [],
			provider: "deepseek",
			model: "deepseek-v4-flash",
			api: "openai-completions",
			usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, totalTokens: 1010, cost: { total: 0.001 } },
			stopReason: "stop",
			timestamp,
		});

		await emitEvent(stub, "session_start", { type: "session_start", reason: "new" }, ctx);
		await emitEvent(stub, "before_provider_request", { type: "before_provider_request", payload: payload("original branch") }, ctx);
		await emitMessageEnd(stub, assistant(1), ctx);
		await emitEvent(stub, "session_tree", { type: "session_tree", newLeafId: "selected", oldLeafId: "original" }, ctx);
		await emitEvent(stub, "before_provider_request", { type: "before_provider_request", payload: payload("selected branch") }, ctx);
		await emitMessageEnd(stub, assistant(2), ctx);
		await emitEvent(stub, "before_provider_request", { type: "before_provider_request", payload: payload("unattributed rewrite") }, ctx);
		await emitMessageEnd(stub, assistant(3), ctx);

		const telemetryPath = join(root, CONFIG_DIR_NAME, "workbench", "cache", "telemetry.jsonl");
		const records = (await readFile(telemetryPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { inferredInvalidationReason?: string });
		assert.equal(records.length, 3);
		assert.equal(records[1]?.inferredInvalidationReason, "SESSION_TREE_CHANGED", "Pi's actual post-navigation event attributes the next branch rewrite");
		assert.equal(records[2]?.inferredInvalidationReason, "CONTEXT_PREFIX_DIVERGED", "the lifecycle marker is consumed once and later drift stays visible");
	});
});

test("runtime marks fail-closed and recovery projection boundaries exactly once", async () => {
	await withTempDir(async (root) => {
		const stub = makeRoleRuntime("other");
		const base = trustedCtx(root, "cache-history-failure-boundary") as ExtensionContext;
		const ctx = {
			...base,
			model: { provider: "deepseek", id: "deepseek-v4-flash", api: "openai-completions" },
			thinkingLevel: "high",
			getSystemPrompt: () => "stable workbench system prompt",
		} as ExtensionContext;
		const assistant = (timestamp: number) => ({
			role: "assistant",
			content: [],
			provider: "deepseek",
			model: "deepseek-v4-flash",
			api: "openai-completions",
			usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, totalTokens: 1_010, cost: { total: 0.001 } },
			stopReason: "stop",
			timestamp,
		});
		const observeRequest = async (messages: AgentMessage[], timestamp: number): Promise<void> => {
			await emitEvent(stub, "before_provider_request", {
				type: "before_provider_request",
				payload: { model: "deepseek-v4-flash", messages },
			}, ctx);
			await emitMessageEnd(stub, assistant(timestamp), ctx);
		};

		await emitEvent(stub, "session_start", { type: "session_start", reason: "new" }, ctx);
		const healthy = [{ role: "user", content: "healthy", timestamp: 1 } as unknown as AgentMessage];
		await observeRequest(await emitContext(stub, healthy, ctx), 1);
		const corruptA = [
			{ role: "user", content: "ordinary-a-FAILURE-BOUNDARY-RUNTIME-SECRET-A", timestamp: 2 } as unknown as AgentMessage,
			{
				role: "toolResult",
				toolCallId: "orphan-secret-a",
				toolName: "read",
				content: [{ type: "text", text: "FAILURE-BOUNDARY-RUNTIME-SECRET-A" }],
				isError: false,
				timestamp: 3,
			} as unknown as AgentMessage,
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "local-a", name: "read", arguments: { secret: "LOCAL-CALL-A" } }],
				timestamp: 4,
			} as unknown as AgentMessage,
			{
				role: "toolResult",
				toolCallId: "local-a",
				toolName: "read",
				content: [{ type: "text", text: "LOCAL-RESULT-A" }],
				isError: false,
				timestamp: 5,
			} as unknown as AgentMessage,
		];
		const corruptB = [
			{ role: "user", content: "different-ordinary-b-FAILURE-BOUNDARY-RUNTIME-SECRET-B", timestamp: 6 } as unknown as AgentMessage,
			{
				role: "toolResult",
				toolCallId: "orphan-secret-b",
				toolName: "read",
				content: [{ type: "text", text: "FAILURE-BOUNDARY-RUNTIME-SECRET-B".repeat(41) }],
				isError: false,
				timestamp: 7,
			} as unknown as AgentMessage,
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "different-local-b", name: "read", arguments: { secret: "LOCAL-CALL-B" } }],
				timestamp: 8,
			} as unknown as AgentMessage,
			{
				role: "toolResult",
				toolCallId: "different-local-b",
				toolName: "read",
				content: [{ type: "text", text: "DIFFERENT-LOCAL-RESULT-B".repeat(13) }],
				isError: false,
				timestamp: 9,
			} as unknown as AgentMessage,
		];
		const firstFailure = await emitContext(stub, corruptA, ctx);
		const repeatedFailure = await emitContext(stub, corruptB, ctx);
		assert.deepEqual(
			convertToLlm(repeatedFailure),
			convertToLlm(firstFailure),
			"runtime failure payload is fixed across ordinary text, orphan size, and latest local bundle changes",
		);
		assert.doesNotMatch(JSON.stringify([firstFailure, repeatedFailure]), /RUNTIME-SECRET|LOCAL-CALL|LOCAL-RESULT/);
		await observeRequest(firstFailure, 2);
		await observeRequest(repeatedFailure, 3);
		await observeRequest(await emitContext(stub, healthy, ctx), 4);
		await observeRequest(await emitContext(stub, healthy, ctx), 5);

		const telemetryPath = join(root, CONFIG_DIR_NAME, "workbench", "cache", "telemetry.jsonl");
		const records = (await readFile(telemetryPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { inferredInvalidationReason?: string });
		assert.deepEqual(records.map((record) => record.inferredInvalidationReason), [
			"NEW_SESSION",
			"HISTORY_PROJECTION_EPOCH_CHANGED",
			"UNKNOWN",
			"HISTORY_PROJECTION_EPOCH_CHANGED",
			"UNKNOWN",
		]);
		assert.doesNotMatch(JSON.stringify(records), /RUNTIME-SECRET|LOCAL-CALL|LOCAL-RESULT/);
	});
});

test("context success and fail-closed projections update latest numeric history telemetry", async () => {
	const stub = makeRoleRuntime("other");
	const ctx = trustedCtx(process.cwd(), "history-telemetry") as ExtensionContext;
	await emitEvent(stub, "turn_start", { type: "turn_start", turnIndex: 41, timestamp: 1 }, ctx);
	const paired: AgentMessage[] = [
		{ role: "assistant", content: [{ type: "toolCall", id: "history-old", name: "read", arguments: {} }], timestamp: 1 } as unknown as AgentMessage,
		{ role: "toolResult", toolCallId: "history-old", toolName: "read", content: [{ type: "text", text: "x".repeat(80 * 1_024) }], isError: false, timestamp: 2 } as unknown as AgentMessage,
		{ role: "assistant", content: [{ type: "toolCall", id: "history-latest", name: "read", arguments: {} }], timestamp: 3 } as unknown as AgentMessage,
		{ role: "toolResult", toolCallId: "history-latest", toolName: "read", content: [{ type: "text", text: "latest" }], isError: false, timestamp: 4 } as unknown as AgentMessage,
	];
	const success = await emitContext(stub, paired, ctx);
	assert.ok(historyToolTextBytes(success) <= OTHER_HISTORY_TOOL_TEXT_MAX_BYTES);
	await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex: 41, message: {}, toolResults: [] }, ctx);
	const successEntry = [...stub.appendedEntries].reverse().find((item) => item.customType === OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE);
	const successSnapshot = parseOutputControlTelemetry(successEntry?.data);
	assert.ok(successSnapshot);
	assert.ok(successSnapshot.totals.historyCollapsedResults > 0);

	await emitEvent(stub, "turn_start", { type: "turn_start", turnIndex: 42, timestamp: 5 }, ctx);
	const failed = await emitContext(stub, [
		{ role: "toolResult", toolCallId: "orphan", toolName: "read", content: [{ type: "text", text: "orphan" }], isError: false, timestamp: 6 } as unknown as AgentMessage,
	], ctx);
	assert.equal(validateContextToolPairing(failed), true);
	await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex: 42, message: {}, toolResults: [] }, ctx);
	const entry = [...stub.appendedEntries].reverse().find((item) => item.customType === OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE);
	const snapshot = parseOutputControlTelemetry(entry?.data);
	assert.ok(snapshot);
	assert.equal(
		snapshot.totals.historyCollapsedResults,
		successSnapshot.totals.historyCollapsedResults,
		"fixed fail-closed boundaries do not claim input-dependent collapses",
	);
	assert.equal(snapshot.activeHistoryToolTextBytes, historyToolTextBytes(failed), "active history is the latest gauge, not a sum");
});

test("runtime registers exactly three ordered tool_result handlers and envelope bounds unknown custom text and errors", async () => {
	const stub = makeStub(); workbenchRuntime(stub);
	assert.equal(stub.events.get("tool_result")?.length, 3);
	const raw = `${"safe\n".repeat(420_000)}RAW-TAIL-2M`;
	const bounded = await emitToolResult(stub, {
		type: "tool_result", toolCallId: "unknown-1", toolName: "third_party_huge", input: {},
		content: [{ type: "text", text: raw }], isError: false, details: { domain: "kept" }, usage: { input: 7 },
	});
	const shown = textOf(bounded.content);
	assert.ok(bytes(shown) <= DEFAULT_RESULT_MAX_BYTES);
	assert.ok(!shown.includes("RAW-TAIL-2M"));
	assert.equal(bounded.isError, false);
	assert.deepEqual(bounded.usage, { input: 7 });
	const details = bounded.details as Record<string, unknown>;
	assert.equal(details.domain, "kept", "ordinary plain domain field survives R2");
	const facts = details.output_envelope as Record<string, unknown>;
	assert.equal(facts.schema, "workbench-output-v1");
	assert.equal(facts.shownTextBytes, bytes(shown));
	assert.equal(facts.originalTextBytes, bytes(raw));
	assert.equal(facts.truncated, true);
	assert.match(shown, /action=rerun_narrow_or_persist_then_bounded_read/, "2 MiB custom output retains a replayable narrowing action");

	const error = await emitToolResult(stub, {
		type: "tool_result", toolCallId: "unknown-2", toolName: "third_party_huge", input: {},
		content: [{ type: "text", text: "e".repeat(2_000_000) }], isError: true, details: {},
	});
	assert.ok(bytes(textOf(error.content)) <= ERROR_RESULT_MAX_BYTES);
	assert.equal(error.isError, true);
});

test("every registered tool uses the execute callback boundary; a real run_recipe emits only bounded non-receipt updates", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: streaming-update-wiring\nprofile: generic\n");
		await writeConfigFile(root, "recipes.yaml", [
			"recipes:",
			"  - name: streaming-update",
			'    command: ["node", "-e", "process.stdout.write(\'ok\')"]',
			"",
		].join("\n"));
		const stub = makeStub(); workbenchRuntime(stub);
		type Partial = { content: Array<{ type: string; text?: string }>; details: unknown };
		type RecipeTool = {
			execute: (
				toolCallId: string,
				params: { recipe: string },
				signal: undefined,
				onUpdate: (partial: Partial) => void,
				ctx: ExtensionContext,
			) => Promise<unknown>;
		};
		const tool = stub.tools.get("workbench_run_recipe") as RecipeTool;
		assert.ok(tool);
		const updates: Partial[] = [];
		await tool.execute(
			"streaming-update-call",
			{ recipe: "streaming-update" },
			undefined,
			(partial) => updates.push(partial),
			trustedCtx(root, "streaming-update-session") as ExtensionContext,
		);
		assert.equal(updates.length, 2, "registered run_recipe starting and finished callbacks both traverse the wrapper");
		for (const update of updates) {
			const text = update.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
			assert.ok(bytes(text) <= STREAM_UPDATE_MAX_BYTES);
			assert.ok((text.length === 0 ? 0 : text.split("\n").length) <= STREAM_UPDATE_MAX_LINES);
			assert.ok(Buffer.byteLength(JSON.stringify(update.details), "utf8") <= DETAILS_MAX_BYTES);
			const details = update.details as Record<string, unknown>;
			assert.equal(Object.hasOwn(details, "receipt"), false, "partial updates never carry receipt evidence");
			assert.equal((details.output_envelope as Record<string, unknown>).schema, "workbench-output-v1");
		}
	});

	const source = await readFile(join(process.cwd(), "extensions/workbench-runtime/index.ts"), "utf8");
	assert.match(source, /export default function workbenchRuntime\(runtimePi: ExtensionAPI\): void \{\s*const streamingControl = streamingControlledApi\(runtimePi\);\s*const pi = streamingControl\.api;/);
	assert.equal((source.match(/\bpi\.registerTool\(\{/g) ?? []).length, 14, "all static native/catalog registrations use the controlled API");
	const boundaryStart = source.indexOf("function boundedStreamingUpdate");
	const boundaryEnd = source.indexOf("function wrapStreamingToolDefinition", boundaryStart);
	const boundary = source.slice(boundaryStart, boundaryEnd);
	assert.match(boundary, /enforceStreamingUpdate\(\{ toolName, content \}\)/);
	assert.match(boundary, /projectToolResultDetails\(/);
	assert.doesNotMatch(boundary, /turnOutputBudget|authorizeOutput|takeOutputAuthorization|finalizeReceipt/);
	assert.match(source, /runtimePi\.on\("tool_execution_update"/);
	assert.match(source, /boundGlobalStreamingUpdate\(event\)/);
});

test("an active foreign tool with a frozen oversized update is blocked before execute, callback, or publish", async () => {
	const toolName = "foreign_frozen_stream";
	let executions = 0;
	let callbackInvocations = 0;
	let publications = 0;
	const foreignTool = {
		name: toolName,
		description: "valid foreign streaming fixture",
		parameters: { type: "object", properties: {} },
		async execute(
			_toolCallId: string,
			_params: Record<string, never>,
			_signal: undefined,
			onUpdate: ((partial: unknown) => void) | undefined,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, never> }> {
			executions += 1;
			onUpdate?.(Object.freeze({
				content: Object.freeze([{ type: "text", text: "F".repeat(1024 * 1024) }]),
				details: Object.freeze({}),
			}));
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	};
	const stub = makeStub();
	stub.tools.set(toolName, foreignTool);
	stub.toolSources.set(toolName, {
		path: "/foreign/frozen-stream.ts",
		source: "local",
		scope: "temporary",
		origin: "top-level",
		baseDir: "/foreign",
	});
	workbenchRuntime(stub);
	stub.setActiveTools([toolName]);
	const ctx = trustedCtx(process.cwd(), "foreign-frozen-stream-session") as ExtensionContext;
	await startBudgetTurn(stub, ctx, "other", 0, [{ id: "foreign-frozen-call", name: toolName }]);
	const guard = await emitToolCall(stub, ctx, {
		type: "tool_call",
		toolCallId: "foreign-frozen-call",
		toolName,
		input: {},
	});
	const pendingPublications: Promise<void>[] = [];
	if (!guard.block) {
		await foreignTool.execute("foreign-frozen-call", {}, undefined, (partial) => {
			callbackInvocations += 1;
			pendingPublications.push(emitEvent(stub, "tool_execution_update", {
				type: "tool_execution_update",
				toolCallId: "foreign-frozen-call",
				toolName,
				args: {},
				partialResult: partial,
			}, ctx).then(() => { publications += 1; }));
		});
	}
	await Promise.all(pendingPublications);
	assert.deepEqual(guard, { block: true, reason: "Tool streaming output boundary is unavailable" });
	assert.equal(executions, 0);
	assert.equal(callbackInvocations, 0);
	assert.equal(publications, 0);
	assert.ok(bytes(guard.reason ?? "") < 512);

	stub.toolSources.set("workbench_project_inspect", {
		path: "/foreign/collision.ts",
		source: "local",
		scope: "temporary",
		origin: "top-level",
		baseDir: "/foreign",
	});
	const collision = await emitToolCall(stub, ctx, {
		type: "tool_call",
		toolCallId: "foreign-collision-call",
		toolName: "workbench_project_inspect",
		input: {},
	});
	assert.deepEqual(collision, { block: true, reason: "Tool streaming output boundary is unavailable" });
});

test("the real project package loader provenance passes only this workbench entry while absent names retain Pi's unknown path", async () => {
	await withTempDir(async (agentDir) => {
		const projectRoot = process.cwd();
		const settingsManager = SettingsManager.create(projectRoot, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({
			cwd: projectRoot,
			agentDir,
			settingsManager,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const extension = loaded.extensions.find((candidate) => candidate.resolvedPath === WORKBENCH_SOURCE_PATH);
		assert.ok(extension, "PackageManager + ResourceLoader load the actual workbench entry");
		const expectedSourceInfo = {
			path: WORKBENCH_SOURCE_PATH,
			source: "..",
			scope: "project",
			origin: "package",
			baseDir: projectRoot,
		};
		assert.deepEqual(extension.sourceInfo, expectedSourceInfo, "the test consumes Pi's actual package source tuple");
		assert.deepEqual(extension.tools.get("read")?.sourceInfo, expectedSourceInfo);

		// Bind the loader's real shared runtime to the same effective first-wins
		// projection AgentSession exposes through getAllTools(). This exercises the
		// handlers created by the package-loaded module, not the local stub factory.
		const effective = new Map<string, RegisteredTool>();
		for (const loadedExtension of loaded.extensions) {
			for (const registered of loadedExtension.tools.values()) {
				if (!effective.has(registered.definition.name)) effective.set(registered.definition.name, registered);
			}
		}
		loaded.runtime.getAllTools = () => [...effective.values()].map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
		const ctx = trustedCtx(projectRoot, "real-package-provenance-session") as ExtensionContext;
		const emitLoadedGuard = async (toolCallId: string, toolName: string): Promise<{ block?: boolean; reason?: string }> => {
			let result: { block?: boolean; reason?: string } = {};
			for (const handler of extension.handlers.get("tool_call") ?? []) {
				const next = await handler({ type: "tool_call", toolCallId, toolName, input: {} }, ctx) as typeof result | undefined;
				if (next !== undefined) result = next;
				if (result.block) break;
			}
			return result;
		};
		assert.deepEqual(await emitLoadedGuard("real-package-read", "read"), {}, "the exact package-loaded override remains executable");
		assert.deepEqual(await emitLoadedGuard("real-package-unknown", "definitely_absent_tool"), {}, "an absent name is not converted into a streaming block");
		const inspect = effective.get("workbench_project_inspect");
		assert.ok(inspect);
		effective.set("workbench_project_inspect", {
			definition: inspect.definition,
			sourceInfo: {
				path: join(projectRoot, "foreign-package/index.ts"),
				source: "../foreign-package",
				scope: "project",
				origin: "package",
				baseDir: join(projectRoot, "foreign-package"),
			},
		});
		assert.deepEqual(
			await emitLoadedGuard("foreign-project-package-collision", "workbench_project_inspect"),
			{ block: true, reason: "Tool streaming output boundary is unavailable" },
			"an arbitrary project package cannot borrow trust by colliding with a workbench name",
		);
	});
});

test("the real user package loader accepts relative and absolute source spellings while rejecting hostile provenance", async () => {
	await withTempDir(async (fixtureRoot) => {
		const projectRoot = process.cwd();
		const userCwd = join(fixtureRoot, "user-cwd");
		await mkdir(userCwd, { recursive: true });
		const relativeAgentDir = join(fixtureRoot, ".pi", "relative-agent");
		const absoluteAgentDir = join(fixtureRoot, ".pi", "absolute-agent");
		const relativeInstalledSource = relative(relativeAgentDir, projectRoot);
		assert.notEqual(relativeInstalledSource, "");
		assert.notEqual(relativeInstalledSource, "..", "the fixture exercises pi install -l . from outside the package root");
		assert.equal(isAbsolute(relativeInstalledSource), false);
		assert.equal(isAbsolute(projectRoot), true);

		for (const { label, agentDir, installedSource } of [
			{ label: "relative", agentDir: relativeAgentDir, installedSource: relativeInstalledSource },
			{ label: "absolute", agentDir: absoluteAgentDir, installedSource: projectRoot },
		]) {
			await mkdir(agentDir, { recursive: true });
			await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [installedSource] }, null, 2)}\n`, "utf8");

			const settingsManager = SettingsManager.create(userCwd, agentDir, { projectTrusted: true });
			const loader = new DefaultResourceLoader({
				cwd: userCwd,
				agentDir,
				settingsManager,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			const loaded = loader.getExtensions();
			assert.deepEqual(loaded.errors, []);
			const extension = loaded.extensions.find((candidate) => candidate.resolvedPath === WORKBENCH_SOURCE_PATH);
			assert.ok(extension, `PackageManager + ResourceLoader load the ${label} user-installed workbench entry`);
			const expectedSourceInfo: RegisteredTool["sourceInfo"] = {
				path: WORKBENCH_SOURCE_PATH,
				source: installedSource,
				scope: "user",
				origin: "package",
				baseDir: projectRoot,
			};
			assert.deepEqual(extension.sourceInfo, expectedSourceInfo, `the test consumes Pi's actual ${label} user package source tuple`);
			assert.deepEqual(extension.tools.get("read")?.sourceInfo, expectedSourceInfo);

			const effective = new Map<string, RegisteredTool>();
			for (const loadedExtension of loaded.extensions) {
				for (const registered of loadedExtension.tools.values()) {
					if (!effective.has(registered.definition.name)) effective.set(registered.definition.name, registered);
				}
			}
			loaded.runtime.getAllTools = () => [...effective.values()].map(({ definition, sourceInfo }) => ({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				promptGuidelines: definition.promptGuidelines,
				sourceInfo,
			}));
			const ctx = trustedCtx(userCwd, `real-user-package-${label}-provenance-session`) as ExtensionContext;
			const emitLoadedGuard = async (toolCallId: string, toolName: string): Promise<{ block?: boolean; reason?: string }> => {
				let result: { block?: boolean; reason?: string } = {};
				for (const handler of extension.handlers.get("tool_call") ?? []) {
					const next = await handler({ type: "tool_call", toolCallId, toolName, input: {} }, ctx) as typeof result | undefined;
					if (next !== undefined) result = next;
					if (result.block) break;
				}
				return result;
			};
			assert.deepEqual(await emitLoadedGuard(`real-user-package-${label}-read`, "read"), {}, `the exact ${label} user-installed read override remains executable`);

			const inspect = effective.get("workbench_project_inspect");
			assert.ok(inspect);
			assert.deepEqual(
				await emitLoadedGuard(`real-user-package-${label}-inspect`, "workbench_project_inspect"),
				{},
				`the exact ${label} user-installed normal workbench tool remains executable`,
			);
			if (label !== "absolute") continue;

			for (const code of [...Array.from({ length: 0x20 }, (_, index) => index), 0x7f]) {
				effective.set("workbench_project_inspect", {
					definition: inspect.definition,
					sourceInfo: { ...expectedSourceInfo, source: `${installedSource}${String.fromCharCode(code)}` },
				});
				assert.deepEqual(
					await emitLoadedGuard(`control-user-package-source-${code}`, "workbench_project_inspect"),
					{ block: true, reason: "Tool streaming output boundary is unavailable" },
					`ASCII control source U+${code.toString(16).padStart(4, "0")} cannot borrow the exact user-package identity`,
				);
			}

			let sourceGetterCalls = 0;
			const accessorSourceInfo = Object.defineProperty({
				path: WORKBENCH_SOURCE_PATH,
				scope: "user",
				origin: "package",
				baseDir: projectRoot,
			}, "source", {
				enumerable: true,
				get: () => {
					sourceGetterCalls += 1;
					return installedSource;
				},
			}) as typeof expectedSourceInfo;
			effective.set("workbench_project_inspect", {
				definition: inspect.definition,
				sourceInfo: accessorSourceInfo,
			});
			assert.deepEqual(
				await emitLoadedGuard("accessor-user-package-source", "workbench_project_inspect"),
				{ block: true, reason: "Tool streaming output boundary is unavailable" },
				"an accessor source cannot borrow the exact user-package identity",
			);
			assert.equal(sourceGetterCalls, 0, "provenance inspection never invokes a source getter");

			effective.set("workbench_project_inspect", {
				definition: inspect.definition,
				sourceInfo: { ...expectedSourceInfo, source: "x".repeat(4_097) },
			});
			assert.deepEqual(
				await emitLoadedGuard("oversized-user-package-source", "workbench_project_inspect"),
				{ block: true, reason: "Tool streaming output boundary is unavailable" },
				"an oversized source string cannot borrow the exact user-package identity",
			);
			effective.set("workbench_project_inspect", {
				definition: inspect.definition,
				sourceInfo: {
					path: join(fixtureRoot, "foreign-package/index.ts"),
					source: installedSource,
					scope: "user",
					origin: "package",
					baseDir: join(fixtureRoot, "foreign-package"),
				},
			});
			assert.deepEqual(
				await emitLoadedGuard("foreign-user-package-collision", "workbench_project_inspect"),
				{ block: true, reason: "Tool streaming output boundary is unavailable" },
				"an arbitrary user package cannot borrow trust by colliding with a workbench name",
			);
		}
	});
});

test("the global publish boundary bounds updates and gives a real oversized built-in bash result a replay action", async () => {
	await withTempDir(async (root) => {
		const bash = createBashToolDefinition(root);
		const stub = makeStub();
		stub.tools.set("bash", bash);
		stub.toolSources.set("bash", builtinSourceInfo("bash"));
		workbenchRuntime(stub);
		assert.equal(stub.tools.get("bash"), bash, "the boundary does not re-register or alter built-in bash identity");
		type Partial = { content: Array<{ type: string; text?: string }>; details: unknown };
		const ctx = trustedCtx(root, "builtin-bash-streaming-session") as ExtensionContext;
		const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(81920) + 'BASH-RAW-TAIL-80K')"`;
		await startBudgetTurn(stub, ctx, "other", 0, [{ id: "builtin-bash-streaming-call", name: "bash", arguments: { command } }]);
		const guard = await emitToolCall(stub, ctx, {
			type: "tool_call",
			toolCallId: "builtin-bash-streaming-call",
			toolName: "bash",
			input: { command },
		});
		assert.equal(guard.block, undefined, "exact Pi builtin provenance remains executable");
		const rawTextBytes: number[] = [];
		const published: Partial[] = [];
		const pending: Promise<void>[] = [];
		const rawFinal = await (stub.tools.get("bash") as typeof bash).execute(
			"builtin-bash-streaming-call",
			{ command },
			undefined,
			(partial) => {
				const mutable = partial as Partial;
				rawTextBytes.push(bytes(mutable.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("")));
				pending.push(emitEvent(stub, "tool_execution_update", {
					type: "tool_execution_update",
					toolCallId: "builtin-bash-streaming-call",
					toolName: "bash",
					args: { command: "bounded fixture" },
					partialResult: mutable,
				}, ctx).then(() => { published.push(mutable); }));
			},
			ctx,
		);
		await Promise.all(pending);
		assert.ok(rawTextBytes.some((size) => size > STREAM_UPDATE_MAX_BYTES), "real built-in bash produced an oversized partial snapshot");
		assert.ok(published.length > 0);
		for (const update of published) {
			const text = update.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
			assert.ok(bytes(text) <= STREAM_UPDATE_MAX_BYTES);
			assert.ok((text.length === 0 ? 0 : text.split("\n").length) <= STREAM_UPDATE_MAX_LINES);
			assert.ok(Buffer.byteLength(JSON.stringify(update.details), "utf8") <= DETAILS_MAX_BYTES);
			assert.equal(((update.details as Record<string, unknown>).output_envelope as Record<string, unknown>).schema, "workbench-output-v1");
		}
		const nativeDetails = rawFinal.details as { truncation?: { truncated?: boolean }; fullOutputPath?: string } | undefined;
		assert.equal(nativeDetails?.truncation?.truncated, true, "real bash output exceeded Pi's native 50 KiB final window");
		assert.equal(typeof nativeDetails?.fullOutputPath, "string", "Pi persisted its native full output, but the envelope does not trust this detail");
		const boundedFinal = await emitToolResult(stub, {
			type: "tool_result",
			toolCallId: "builtin-bash-streaming-call",
			toolName: "bash",
			input: { command: "bounded fixture" },
			content: rawFinal.content.map((block): Record<string, unknown> => block.type === "text"
				? { type: "text", text: block.text }
				: { type: "image", data: block.data, mimeType: block.mimeType }),
			isError: false,
			details: rawFinal.details,
		});
		const finalText = textOf(boundedFinal.content);
		assert.ok(bytes(finalText) <= DEFAULT_RESULT_MAX_BYTES);
		assert.doesNotMatch(finalText, /BASH-RAW-TAIL-80K/);
		assert.match(finalText, /action=rerun_redirect_file_then_bounded_read/);
		assert.equal(((boundedFinal.details as Record<string, unknown>).output_envelope as Record<string, unknown>).shownTextBytes, bytes(finalText));
	});
});

test("image policy preserves only the first native-read image; every other policy emits bounded omission text", async () => {
	const stub = makeStub(); workbenchRuntime(stub);
	const images = [{ type: "image", data: "a", mimeType: "image/png" }, { type: "image", data: "b", mimeType: "image/png" }];
	const read = await emitToolResult(stub, { type: "tool_result", toolCallId: "r1", toolName: "read", input: { path: "x.png" }, content: images, isError: false });
	assert.equal(read.content.filter((block) => block.type === "image").length, 1);
	assert.ok(bytes(textOf(read.content)) <= NATIVE_READ_MAX_BYTES);
	assert.match(textOf(read.content), /image omitted/);
	const other = await emitToolResult(stub, { type: "tool_result", toolCallId: "r2", toolName: "unknown", input: {}, content: images, isError: false });
	assert.equal(other.content.filter((block) => block.type === "image").length, 0);
	assert.match(textOf(other.content), /image omitted/);
});

test("details projection drops malformed registered DTO shapes and fixes hostile proxies to projection_error", async () => {
	const malformed: unknown[] = [
		"raw",
		["raw"],
		Object.defineProperty({}, "secret", { enumerable: true, get: () => { throw new Error("getter"); } }),
	];
	for (const [index, details] of malformed.entries()) {
		const stub = makeStub(); workbenchRuntime(stub);
		const result = await emitToolResult(stub, {
			type: "tool_result", toolCallId: `malformed-${index}`, toolName: "workbench_project_inspect", input: {},
			content: [{ type: "text", text: "ok" }], isError: false, details,
		});
		const projected = result.details as Record<string, unknown>;
		assert.equal(JSON.stringify(projected).includes("raw"), false);
		assert.equal(JSON.stringify(projected).includes("getter"), false);
		assert.equal((projected.output_envelope as Record<string, unknown>).schema, "workbench-output-v1");
		assert.ok(Buffer.byteLength(JSON.stringify(projected), "utf8") <= DETAILS_MAX_BYTES);
	}

	let trapCalls = 0;
	const hostile = new Proxy({}, {
		ownKeys: () => { trapCalls += 1; throw new Error("proxy secret"); },
		getOwnPropertyDescriptor: () => { trapCalls += 1; throw new Error("proxy secret"); },
		getPrototypeOf: () => { trapCalls += 1; throw new Error("proxy secret"); },
		get: () => { trapCalls += 1; throw new Error("proxy secret"); },
	});
	const stub = makeStub(); workbenchRuntime(stub);
	const result = await emitToolResult(stub, {
		type: "tool_result", toolCallId: "hostile-proxy", toolName: "workbench_project_inspect", input: {},
		content: [{ type: "text", text: "ok" }], isError: false, details: hostile,
	});
	const projected = result.details as Record<string, unknown>;
	assert.deepEqual(projected.details_projection, { available: false, code: "projection_error" });
	assert.equal((projected.output_envelope as Record<string, unknown>).schema, "workbench-output-v1");
	assert.equal(JSON.stringify(projected).includes("proxy secret"), false);
	assert.equal(trapCalls, 0);
	assert.ok(Buffer.byteLength(JSON.stringify(projected), "utf8") <= DETAILS_MAX_BYTES);
});

test("normal result projection reaches tool_execution_end and later session observers as an 8 KiB DTO", async () => {
	const stub = makeStub(); workbenchRuntime(stub); const ctx = trustedCtx(process.cwd()) as ExtensionContext;
	let executionObserved: unknown;
	let persistenceObserved: unknown;
	stub.events.get("tool_execution_end")?.push((event) => {
		executionObserved = (event as { result?: { details?: unknown } }).result?.details;
	});
	stub.events.get("message_end")?.push((event) => {
		persistenceObserved = (event as { message?: { details?: unknown } }).message?.details;
	});
	const rawDetails = {
		ok: true,
		run_id: "20260813-000000-details",
		recipe: "check",
		status: "PASS",
		record: { full: "record-secret-" + "r".repeat(100_000) },
		gates_full: Array.from({ length: 1_000 }, (_, index) => ({ id: index, prose: "gate-secret" })),
		report: "report-secret-" + "p".repeat(100_000),
		review: Array.from({ length: 1_000 }, () => "review-secret"),
		output_envelope: { policy: "forged", shownTextBytes: 999_999 },
		receipt: { available: true, result_id: "attacker" },
	};
	const result = await emitToolResult(stub, {
		type: "tool_result", toolCallId: "details-normal", toolName: "workbench_run_recipe", input: {},
		content: [{ type: "text", text: "bounded" }], isError: false, details: rawDetails,
	});
	const projected = result.details as Record<string, unknown>;
	const serialized = JSON.stringify(projected);
	assert.ok(Buffer.byteLength(serialized, "utf8") <= DETAILS_MAX_BYTES);
	assert.equal(projected.run_id, "20260813-000000-details");
	assert.equal(projected.recipe, "check");
	assert.equal(Object.hasOwn(projected, "record"), false);
	assert.equal(Object.hasOwn(projected, "gates_full"), false);
	assert.equal(Object.hasOwn(projected, "report"), false);
	assert.equal(Object.hasOwn(projected, "review"), false);
	assert.equal(Object.hasOwn(projected, "receipt"), false);
	assert.equal(serialized.includes("secret"), false);
	assert.equal((projected.output_envelope as Record<string, unknown>).policy, "run-summary");

	await emitEvent(stub, "tool_execution_end", {
		type: "tool_execution_end", toolCallId: result.toolCallId, toolName: result.toolName,
		result: { content: result.content, details: result.details }, isError: result.isError,
	}, ctx);
	assert.deepEqual(executionObserved, projected);
	assert.ok(Buffer.byteLength(JSON.stringify(executionObserved) ?? "", "utf8") <= DETAILS_MAX_BYTES);

	const persisted = await emitMessageEnd(stub, {
		role: "toolResult", toolCallId: result.toolCallId, toolName: result.toolName,
		content: result.content, details: result.details, isError: result.isError, timestamp: 1,
	}, ctx);
	assert.equal(persisted.details, persistenceObserved);
	assert.deepEqual(persistenceObserved, projected);
	assert.ok(Buffer.byteLength(JSON.stringify(persistenceObserved) ?? "", "utf8") <= DETAILS_MAX_BYTES);
});

test("registered compare returns only the bounded DTO and persistence failure enters the fixed isError envelope", async () => {
	type CompareTool = {
		execute: (
			toolCallId: string,
			params: { a: string; b: string },
			signal: undefined,
			onUpdate: undefined,
			ctx: ExtensionContext,
		) => Promise<{ content: Array<Record<string, unknown>>; details: Record<string, unknown> }>;
	};
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: compare-output-wiring\nprofile: generic\n");
		await writeComparisonManifest(root, "20260813-000000-aaaa", "2026-08-13T00:00:00.000Z");
		await writeComparisonManifest(root, "20260813-000001-bbbb", "2026-08-13T00:00:01.000Z");
		const stub = makeStub(); workbenchRuntime(stub);
		const tool = stub.tools.get("workbench_compare_runs") as CompareTool;
		assert.ok(tool);
		const raw = await tool.execute(
			"compare-runtime-success",
			{ a: "20260813-000000-aaaa", b: "20260813-000001-bbbb" },
			undefined,
			undefined,
			trustedCtx(root) as ExtensionContext,
		);
		const rawText = textOf(raw.content);
		assert.ok(bytes(rawText) <= COMPARE_SUMMARY_MAX_BYTES);
		assert.ok(rawText.split("\n").length <= COMPARE_SUMMARY_MAX_LINES);
		assert.deepEqual(Object.keys(raw.details).sort(), [
			"a_run_id", "artifact_added_count", "artifact_removed_count", "b_run_id", "comparison_id",
			"comparison_path", "compatible", "gate_changed_count", "ok", "parameter_changed_count",
			"quant_changed_count",
		].sort());
		assert.equal(Object.hasOwn(raw.details, "report"), false);

		const projected = await emitToolResult(stub, {
			type: "tool_result", toolCallId: "compare-runtime-success", toolName: "workbench_compare_runs",
			input: { a: "20260813-000000-aaaa", b: "20260813-000001-bbbb" },
			content: raw.content, details: raw.details, isError: false,
		});
		assert.ok(Buffer.byteLength(JSON.stringify(projected.details), "utf8") <= DETAILS_MAX_BYTES);
		assert.equal(Object.hasOwn(projected.details as Record<string, unknown>, "report"), false);
	});

	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: compare-output-failure\nprofile: generic\n");
		await writeComparisonManifest(root, "20260813-000002-cccc", "2026-08-13T00:00:02.000Z");
		await writeComparisonManifest(root, "20260813-000003-dddd", "2026-08-13T00:00:03.000Z");
		await mkdir(workbenchDir(root), { recursive: true });
		await writeFile(join(workbenchDir(root), "comparisons"), "blocks comparison persistence", "utf8");
		const stub = makeStub(); workbenchRuntime(stub);
		const tool = stub.tools.get("workbench_compare_runs") as CompareTool;
		const fixedMessage = `workbench_compare_runs: ${COMPARISON_PERSIST_ERROR}`;
		await assert.rejects(
			tool.execute(
				"compare-runtime-failure",
				{ a: "20260813-000002-cccc", b: "20260813-000003-dddd" },
				undefined,
				undefined,
				trustedCtx(root) as ExtensionContext,
			),
			new Error(fixedMessage),
		);
		const failed = await emitToolResult(stub, {
			type: "tool_result", toolCallId: "compare-runtime-failure", toolName: "workbench_compare_runs",
			input: { a: "20260813-000002-cccc", b: "20260813-000003-dddd" },
			content: [{ type: "text", text: fixedMessage }], details: {}, isError: true,
		});
		assert.equal(failed.isError, true);
		assert.equal(textOf(failed.content), fixedMessage);
		assert.ok(bytes(textOf(failed.content)) <= ERROR_RESULT_MAX_BYTES);
		assert.ok(Buffer.byteLength(JSON.stringify(failed.details), "utf8") <= DETAILS_MAX_BYTES);
	});
});

test("compare and review tool_result projection cannot persist full reports or review arrays", async () => {
	const stub = makeStub(); workbenchRuntime(stub);
	const compare = await emitToolResult(stub, {
		type: "tool_result", toolCallId: "compare-projection", toolName: "workbench_compare_runs", input: {},
		content: [{ type: "text", text: "bounded comparison" }], isError: false,
		details: {
			ok: true,
			comparison_id: `cmp1-${"a".repeat(64)}`,
			a_run_id: "20260813-000000-aaaa",
			b_run_id: "20260813-000001-bbbb",
			compatible: true,
			artifact_added_count: 1,
			artifact_removed_count: 2,
			gate_changed_count: 3,
			quant_changed_count: 4,
			parameter_changed_count: 5,
			comparison_path: ".pi/workbench/comparisons/cmp1-a/comparison.json",
			report: { secret: "FULL-COMPARISON-REPORT-" + "x".repeat(100_000) },
		},
	});
	const compareDetails = compare.details as Record<string, unknown>;
	assert.equal(Object.hasOwn(compareDetails, "report"), false);
	assert.equal(JSON.stringify(compareDetails).includes("FULL-COMPARISON-REPORT"), false);
	assert.ok(Buffer.byteLength(JSON.stringify(compareDetails), "utf8") <= DETAILS_MAX_BYTES);

	const review = await emitToolResult(stub, {
		type: "tool_result", toolCallId: "review-projection", toolName: "workbench_review_worker_diff", input: {},
		content: [{ type: "text", text: "bounded review" }], isError: false,
		details: {
			ok: true,
			delegation_id: "dlg1-bounded",
			verdict: "PASS",
			review_status: "PENDING_REVIEW",
			bound_diff_hash: "b".repeat(64),
			recorded_after_hash: "c".repeat(64),
			mismatch: false,
			violations: Array.from({ length: 500 }, (_, index) => ({ path: `FULL-VIOLATION-${index}`, reason: "secret" })),
			drift_paths: Array.from({ length: 500 }, (_, index) => `FULL-DRIFT-${index}`),
			checked_paths: Array.from({ length: 500 }, (_, index) => `FULL-CHECKED-${index}`),
			displayed_paths: Array.from({ length: 100 }, (_, index) => `FULL-DISPLAYED-${index}`),
			remaining_paths: Array.from({ length: 400 }, (_, index) => `src/remaining-${index}.ts`),
			coverage_complete: false,
			review_record: ".pi/workbench/delegations/dlg1-bounded/review.json",
			patch_paths: Array.from({ length: 500 }, (_, index) => ({ path: `FULL-PATCH-${index}`, text: "secret" })),
			patch_truncated: true,
		},
	});
	const reviewDetails = review.details as Record<string, unknown>;
	for (const forbidden of ["violations", "drift_paths", "checked_paths", "displayed_paths", "remaining_paths", "patch_paths"]) {
		assert.equal(Object.hasOwn(reviewDetails, forbidden), false, forbidden);
	}
	assert.equal(reviewDetails.violation_count, 500);
	assert.equal(reviewDetails.drift_count, 500);
	assert.equal(reviewDetails.checked_count, 500);
	assert.equal(reviewDetails.displayed_count, 100);
	assert.equal(reviewDetails.remaining_count, 400);
	const reviewSerialized = JSON.stringify(reviewDetails);
	assert.equal(reviewSerialized.includes("FULL-"), false);
	assert.ok(Buffer.byteLength(reviewSerialized, "utf8") <= DETAILS_MAX_BYTES);
});

test("receipt finalization consumes bounded content and projection metadata reaches tool_execution_end", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: output-control-wiring\nprofile: generic\n");
		const stub = makeStub(); workbenchRuntime(stub); const ctx = trustedCtx(root);
		const callId = "receipt-huge-1";
		const guard = await emitToolCall(stub, ctx as ExtensionContext, { type: "tool_call", toolCallId: callId, toolName: "workbench_project_inspect", input: {} });
		assert.equal(guard.block, undefined);
		const raw = `${"receipt-line\n".repeat(200_000)}RECEIPT-RAW-TAIL`;
		const result = await emitToolResult(stub, { type: "tool_result", toolCallId: callId, toolName: "workbench_project_inspect", input: {}, content: [{ type: "text", text: raw }], isError: false, details: { ok: true } });
		const shown = textOf(result.content);
		assert.ok(bytes(shown) <= DEFAULT_RESULT_MAX_BYTES);
		assert.ok(!shown.includes("RECEIPT-RAW-TAIL"));
		const receipt = (result.details as Record<string, unknown>).receipt as Record<string, unknown>;
		assert.equal(receipt.available, true);
		const receiptId = deriveResultId("output-control-wiring-session", callId);
		const stored = JSON.parse(await readFile(join(root, CONFIG_DIR_NAME, "workbench", "tool-results", `${receiptId}.json`), "utf8")) as { summary: string };
		assert.ok(!stored.summary.includes("RECEIPT-RAW-TAIL"));
		assert.ok(stored.summary.length <= shown.length, "receipt scans only the already-bounded result");
		let observed: unknown;
		stub.events.get("tool_execution_end")?.push((event) => { observed = (event as { result?: { details?: unknown } }).result?.details; });
		for (const handler of stub.events.get("tool_execution_end") ?? []) await handler({ type: "tool_execution_end", toolCallId: callId, toolName: "workbench_project_inspect", result: { content: result.content, details: result.details }, isError: false }, ctx);
		assert.equal(((observed as Record<string, unknown>).output_envelope as Record<string, unknown>).schema, "workbench-output-v1");
	});
});

test("message_end fail-safe bounds immediate results before later persistence observers and never creates receipts", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: output-control-wiring\nprofile: generic\n");
		const stub = makeStub(); workbenchRuntime(stub); const ctx = trustedCtx(root);
		let seenByLater: Record<string, unknown> | undefined;
		stub.events.get("message_end")?.push((event) => { seenByLater = (event as { message: Record<string, unknown> }).message; });
		const raw = `${"blocked\n".repeat(300_000)}IMMEDIATE-RAW-TAIL`;
		const result = await emitMessageEnd(stub, {
			role: "toolResult", toolCallId: "blocked-1", toolName: "workbench_run_recipe",
			content: [{ type: "text", text: raw }],
			details: {
				ok: false, run_id: "immediate-run", recipe: "check",
				record: { full: "record-secret-" + "r".repeat(100_000) },
				report: "report-secret-" + "p".repeat(100_000),
				output_envelope: { policy: "forged", shownTextBytes: 999_999 },
				receipt: { available: true, result_id: "attacker" },
			},
			isError: true, timestamp: 1, usage: { input: 2 }, addedToolNames: ["future"],
		}, ctx as ExtensionContext);
		assert.ok(bytes(textOf(result.content as Array<Record<string, unknown>>)) <= ERROR_RESULT_MAX_BYTES);
		assert.ok(!textOf(result.content as Array<Record<string, unknown>>).includes("IMMEDIATE-RAW-TAIL"));
		assert.equal(seenByLater, result, "later message_end consumers see the bounded replacement");
		assert.deepEqual(result.usage, { input: 2 });
		assert.deepEqual(result.addedToolNames, ["future"]);
		const details = result.details as Record<string, unknown>;
		assert.ok(Buffer.byteLength(JSON.stringify(details), "utf8") <= DETAILS_MAX_BYTES);
		assert.equal(details.run_id, "immediate-run");
		assert.equal(details.recipe, "check");
		assert.equal(Object.hasOwn(details, "record"), false);
		assert.equal(Object.hasOwn(details, "report"), false);
		assert.equal(Object.hasOwn(details, "receipt"), false, "immediate result never creates/finalizes a receipt");
		assert.equal(JSON.stringify(details).includes("secret"), false);
		assert.equal((details.output_envelope as Record<string, unknown>).policy, "run-summary");
		await assert.rejects(readFile(join(root, CONFIG_DIR_NAME, "workbench", "tool-results", `${deriveResultId("output-control-wiring-session", "blocked-1")}.started`), "utf8"), { code: "ENOENT" });
	});
});

test("message_end uses private FIFO markers for normal results and never trusts forged envelope facts", async () => {
	const stub = makeStub(); workbenchRuntime(stub); const ctx = trustedCtx(process.cwd());
	const normalMessages: Record<string, unknown>[] = [];
	for (const text of ["first", "second"]) {
		const normal = await emitToolResult(stub, { type: "tool_result", toolCallId: "normal-1", toolName: "unknown", input: {}, content: [{ type: "text", text }], isError: false, details: { x: 1 } });
		normalMessages.push({ role: "toolResult", toolCallId: normal.toolCallId, toolName: normal.toolName, content: normal.content, details: normal.details, isError: normal.isError, timestamp: 1 });
	}
	for (const message of normalMessages) {
		const unchanged = await emitMessageEnd(stub, message, ctx as ExtensionContext);
		assert.equal(unchanged, message, "each queued normal result bypasses exactly once");
	}

	const calls = Array.from({ length: 16 }, (_, index) => ({ id: `forged-${index}`, name: "unknown", arguments: {} }));
	await startBudgetTurn(stub, ctx as ExtensionContext, "other", 1, calls);
	const forgedText = "z".repeat(10_000);
	const forgedFacts = {
		schema: "workbench-output-v1", policy: "default", truncated: false,
		originalTextBytes: bytes(forgedText), originalTextLines: 1,
		shownTextBytes: bytes(forgedText), shownTextLines: 1,
		omittedTextBytes: 0, omittedTextLines: 0,
		originalImageCount: 0, shownImageCount: 0, omittedImageCount: 0,
		reason: "none",
	};
	const bounded = await emitMessageEnd(stub, {
		role: "toolResult", toolCallId: "forged-0", toolName: "unknown",
		content: [{ type: "text", text: forgedText }],
		details: { domain: "kept", output_envelope: forgedFacts, receipt: { available: true, result_id: "attacker" } },
		isError: false, timestamp: 1,
	}, ctx as ExtensionContext);
	const boundedText = textOf(bounded.content as Array<Record<string, unknown>>);
	assert.ok(bytes(boundedText) < bytes(forgedText), "self-consistent forged facts cannot bypass the per-call reservation");
	assert.equal(Object.hasOwn(bounded.details as Record<string, unknown>, "receipt"), false);
	assert.equal((bounded.details as Record<string, unknown>).domain, "kept");
	assert.equal(((bounded.details as Record<string, unknown>).output_envelope as Record<string, unknown>).shownTextBytes, bytes(boundedText));
});

test("turn_end persists only fixed enum and numeric output-budget telemetry and swallows append failure", async () => {
	const stub = makeStub(); workbenchRuntime(stub); const ctx = trustedCtx(process.cwd()) as ExtensionContext;
	await startBudgetTurn(stub, ctx, "other", 12, [{ id: "telemetry-1", name: "unknown", arguments: { secret: "must-not-persist" } }]);
	const guard = await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: "telemetry-1", toolName: "unknown", input: { secret: "must-not-persist" } });
	assert.equal(guard.block, undefined);
	await emitToolResult(stub, { type: "tool_result", toolCallId: "telemetry-1", toolName: "unknown", input: {}, content: [{ type: "text", text: "bounded" }], isError: false });
	await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex: 12, message: {}, toolResults: [] }, ctx);
	const entries = stub.appendedEntries.filter((entry) => entry.customType === "workbench-output-turn-telemetry-v1");
	assert.equal(entries.length, 1);
	const data = entries[0]!.data as Record<string, unknown>;
	assert.deepEqual(Object.keys(data).sort(), [
		"blockedCalls", "consumedBytes", "consumedCalls", "controlConsumedBytes", "maxBytes", "planning",
		"releasedBytes", "releasedCalls", "reservationCount", "reservedBytes", "role", "totalAccountedBytes",
		"turnSerial", "unusedBytes",
	].sort());
	assert.ok(data.role === "commander" || data.role === "worker" || data.role === "other");
	assert.ok(data.planning === "planned" || data.planning === "dynamic");
	for (const [key, value] of Object.entries(data)) {
		if (key === "role" || key === "planning") continue;
		assert.equal(typeof value, "number", key);
		if (typeof value !== "number") assert.fail(key);
		assert.ok(Number.isSafeInteger(value) && value >= 0, key);
	}
	assert.ok((data.totalAccountedBytes as number) <= (data.maxBytes as number));
	assert.equal(JSON.stringify(data).includes("must-not-persist"), false);

	const failureStub = makeStub();
	(failureStub as unknown as { appendEntry: (customType: string, data?: unknown) => void }).appendEntry = () => { throw new Error("storage down"); };
	workbenchRuntime(failureStub);
	const failureCtx = trustedCtx(process.cwd(), "telemetry-failure") as ExtensionContext;
	await emitEvent(failureStub, "turn_start", { type: "turn_start", turnIndex: 13, timestamp: 1 }, failureCtx);
	await assert.doesNotReject(emitEvent(failureStub, "turn_end", { type: "turn_end", turnIndex: 13, message: {}, toolResults: [] }, failureCtx));
});

test("runtime records normal and immediate envelopes exactly once and persists one strict session snapshot at turn_end", async () => {
	const stub = makeStub(); workbenchRuntime(stub); const ctx = trustedCtx(process.cwd(), "output-telemetry-once") as ExtensionContext;
	const calls = [
		{ id: "normal-once", name: "read", arguments: { path: "a.txt" } },
		{ id: "immediate-once", name: "tool_missing", arguments: {} },
	];
	await startBudgetTurn(stub, ctx, "other", 31, calls);
	const normal = await emitToolResult(stub, {
		type: "tool_result", toolCallId: calls[0]!.id, toolName: calls[0]!.name, input: calls[0]!.arguments,
		content: [{ type: "text", text: "normal-result" }], isError: false, details: {},
	});
	await emitMessageEnd(stub, {
		role: "toolResult", toolCallId: normal.toolCallId, toolName: normal.toolName, content: normal.content,
		details: normal.details, isError: normal.isError, timestamp: 1,
	}, ctx);
	await emitMessageEnd(stub, {
		role: "toolResult", toolCallId: calls[1]!.id, toolName: calls[1]!.name,
		content: [{ type: "text", text: "immediate-result" }], details: {}, isError: true, timestamp: 2,
	}, ctx);
	await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex: 31, message: {}, toolResults: [] }, ctx);

	const entries = stub.appendedEntries.filter((entry) => entry.customType === OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE);
	assert.equal(entries.length, 1);
	const snapshot = parseOutputControlTelemetry(entries[0]!.data);
	assert.ok(snapshot);
	assert.equal(snapshot.totals.toolResults, 2, "normal message_end must not double-count its middleware observation");
	assert.deepEqual(snapshot.perTool.map((item) => item.tool), ["read", "other"]);
	assert.equal(JSON.stringify(snapshot).includes("normal-result"), false);
	assert.equal(JSON.stringify(snapshot).includes("immediate-result"), false);
});

test("session restore ignores hostile telemetry, status text/json stay bounded and expose no session secret", async () => {
	const secret = "STATUS-SECRET-CURSOR-ARGS-991";
	const prior = createOutputControlTelemetry("other");
	prior.recordEnvelope("read", {
		schema: "workbench-output-v1", policy: "native-read-page", truncated: false,
		originalTextBytes: 7, originalTextLines: 1, shownTextBytes: 7, shownTextLines: 1,
		omittedTextBytes: 0, omittedTextLines: 0, originalImageCount: 0, shownImageCount: 0,
		omittedImageCount: 0, reason: "none",
	});
	const entries: unknown[] = [
		{ type: "custom", customType: OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE, data: serializeOutputControlTelemetry(prior.snapshot()) },
		{ type: "custom", customType: OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE, data: { schema: secret, args: secret, cursor: secret } },
	];
	const outputs: string[] = [];
	const base = trustedCtx(process.cwd(), "output-telemetry-restore") as ExtensionContext;
	const ctx = {
		...base,
		sessionManager: { ...base.sessionManager, getEntries: () => entries },
		ui: { ...base.ui, notify: (text: string) => { outputs.push(text); } },
	} as ExtensionContext;
	const stub = makeStub(); workbenchRuntime(stub);
	await emitEvent(stub, "session_start", { type: "session_start", reason: "resume" }, ctx);
	const command = stub.commands.get("q-context-output-status") as {
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	};
	await command.handler("", ctx as ExtensionCommandContext);
	await command.handler("json", ctx as ExtensionCommandContext);
	assert.equal(outputs.length, 2);
	for (const rendered of outputs) {
		assert.ok(Buffer.byteLength(rendered, "utf8") <= OUTPUT_CONTROL_STATUS_MAX_BYTES);
		assert.doesNotMatch(rendered, new RegExp(secret));
	}
	assert.match(outputs[0]!, /tool_results=0/, "malformed latest matching entry resets restored observations fail closed");
	const json = JSON.parse(outputs[1]!) as Record<string, unknown>;
	assert.equal(json.schema, "workbench-output-control-telemetry-v1");
	assert.equal((json.totals as Record<string, unknown>).toolResults, 0);
	await command.handler("hostile-arg", ctx as ExtensionCommandContext);
	assert.equal(outputs[2], "usage: /q-context-output-status [json]");
});

test("footer adds CTX:SOFT/HIGH from numeric observations without becoming an enforcement dependency", async () => {
	const prior = createOutputControlTelemetry("other");
	for (let index = 0; index < 4; index += 1) {
		prior.recordEnvelope("read", {
			schema: "workbench-output-v1", policy: "native-read-page", truncated: true,
			originalTextBytes: 100, originalTextLines: 1, shownTextBytes: 50, shownTextLines: 1,
			omittedTextBytes: 50, omittedTextLines: 0, originalImageCount: 0, shownImageCount: 0,
			omittedImageCount: 0, reason: "per-tool-cap",
		});
	}
	let footer = "";
	const base = trustedCtx(process.cwd(), "output-telemetry-footer") as ExtensionContext;
	const ctx = {
		...base,
		sessionManager: {
			...base.sessionManager,
			getEntries: () => [{ type: "custom", customType: OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE, data: serializeOutputControlTelemetry(prior.snapshot()) }],
		},
		ui: { ...base.ui, setStatus: (_key: string, value: string) => { footer = value; } },
	} as ExtensionContext;
	const stub = makeStub(); workbenchRuntime(stub);
	await emitEvent(stub, "session_start", { type: "session_start", reason: "resume" }, ctx);
	await emitMessageEnd(stub, assistantBatch([]), ctx);
	assert.match(footer, /(?:^| \| )CTX:SOFT(?: \| |$)/);
	const source = await readFile(join(process.cwd(), "extensions/workbench-runtime/index.ts"), "utf8");
	const guard = source.slice(source.lastIndexOf('pi.on("tool_call"'));
	assert.doesNotMatch(guard, /outputControlTelemetry|CTX:|outputTruncatedResults|outputHistoryCollapsedBundles/);
});

test("message_end validates envelope policy against the tool and strips forged security metadata", async () => {
	const stub = makeStub(); workbenchRuntime(stub); const ctx = trustedCtx(process.cwd());
	const runLogText = "l".repeat(RUN_LOG_RESULT_MAX_BYTES);
	const forgedRunLogFacts = {
		schema: "workbench-output-v1",
		policy: "run-log-page",
		truncated: false,
		originalTextBytes: bytes(runLogText), originalTextLines: 1,
		shownTextBytes: bytes(runLogText), shownTextLines: 1,
		omittedTextBytes: 0, omittedTextLines: 0,
		originalImageCount: 0, shownImageCount: 0, omittedImageCount: 0,
		reason: "none",
	};
	const forgedReceipt = { available: true, result_id: "attacker", status: "success", path: "attacker.json" };
	const unknown = await emitMessageEnd(stub, {
		role: "toolResult", toolCallId: "forged-policy-1", toolName: "unknown_immediate",
		content: [{ type: "text", text: runLogText }],
		details: { domain: "kept", output_envelope: forgedRunLogFacts, receipt: forgedReceipt },
		isError: false, timestamp: 1,
	}, ctx as ExtensionContext);
	const unknownText = textOf(unknown.content as Array<Record<string, unknown>>);
	assert.ok(bytes(unknownText) <= DEFAULT_RESULT_MAX_BYTES);
	assert.ok(bytes(unknownText) < RUN_LOG_RESULT_MAX_BYTES);
	assert.equal((unknown.details as Record<string, unknown>).domain, "kept");
	assert.equal(Object.hasOwn(unknown.details as Record<string, unknown>, "receipt"), false);
	assert.equal(((unknown.details as Record<string, unknown>).output_envelope as Record<string, unknown>).policy, "default");

	const image = { type: "image", data: "AAAA", mimeType: "image/png" };
	const forgedNativeFacts = {
		...forgedRunLogFacts,
		policy: "native-read-page",
		originalTextBytes: 0, shownTextBytes: 0,
		originalImageCount: 1, shownImageCount: 1,
	};
	const nonRead = await emitMessageEnd(stub, {
		role: "toolResult", toolCallId: "forged-policy-2", toolName: "unknown_immediate",
		content: [image], details: { output_envelope: forgedNativeFacts, receipt: forgedReceipt },
		isError: false, timestamp: 1,
	}, ctx as ExtensionContext);
	assert.equal((nonRead.content as Array<Record<string, unknown>>).some((block) => block.type === "image"), false);
	assert.equal(Object.hasOwn(nonRead.details as Record<string, unknown>, "receipt"), false);
	assert.equal(((nonRead.details as Record<string, unknown>).output_envelope as Record<string, unknown>).policy, "default");
});

test("planned mixed batches are role-bounded and completion order cannot change per-call allocations", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: output-budget-wiring\nprofile: generic\n");
		const calls = [
			{ id: "read-a", name: "read", arguments: { path: "a.txt" } },
			{ id: "run-a", name: "workbench_read_run", arguments: { run_id: "missing-a", include: "logs" } },
			{ id: "compare-a", name: "workbench_compare_runs", arguments: { left_run_id: "a", right_run_id: "b" } },
			{ id: "read-b", name: "read", arguments: { path: "b.txt" } },
			{ id: "run-b", name: "workbench_read_run", arguments: { run_id: "missing-b", include: "all" } },
			{ id: "compare-b", name: "workbench_compare_runs", arguments: { left_run_id: "c", right_run_id: "d" } },
			{ id: "grep-a", name: "grep", arguments: { pattern: "x", path: "." } },
			{ id: "find-a", name: "find", arguments: { pattern: "*", path: "." } },
		];
		const run = async (role: "commander" | "worker", order: number[], serial: number, session: string) => {
			const stub = makeRoleRuntime(role);
			const ctx = trustedCtx(root, session) as ExtensionContext;
			await startBudgetTurn(stub, ctx, role, serial, calls);
			for (const item of calls) {
				const guard = await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: item.id, toolName: item.name, input: item.arguments });
				assert.equal(guard.block, undefined, item.id);
			}
			const shown = new Map<string, number>();
			for (const index of order) {
				const item = calls[index]!;
				const result = await emitToolResult(stub, {
					type: "tool_result", toolCallId: item.id, toolName: item.name, input: item.arguments,
					content: [{ type: "text", text: "x".repeat(100_000) }], isError: false, details: {},
				});
				const textBytes = bytes(textOf(result.content));
				shown.set(item.id, textBytes);
				const persisted = await emitMessageEnd(stub, {
					role: "toolResult", toolCallId: item.id, toolName: item.name, content: result.content,
					details: result.details, isError: result.isError, timestamp: 1,
				}, ctx);
				assert.equal(bytes(textOf(persisted.content as Array<Record<string, unknown>>)), textBytes, "normal result is not double-consumed");
			}
			await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex: serial, message: {}, toolResults: [] }, ctx);
			return shown;
		};
		const forward = await run("commander", calls.map((_, index) => index), 0, "budget-commander-forward");
		const reverse = await run("commander", calls.map((_, index) => index).reverse(), 0, "budget-commander-reverse");
		assert.deepEqual([...forward].sort(), [...reverse].sort(), "source-order reservations are completion-order independent");
		assert.ok([...forward.values()].reduce((sum, value) => sum + value, 0) <= COMMANDER_TURN_MAX_BYTES);
		const worker = await run("worker", [2, 0, 7, 4, 1, 6, 5, 3], 0, "budget-worker");
		assert.ok([...worker.values()].reduce((sum, value) => sum + value, 0) <= WORKER_TURN_MAX_BYTES);
	});
});

test("registered read_gate reconstructs every semantic row through exact 4 KiB turn reservations without downstream truncation or cursor skips", async () => {
	type GateReadTool = {
		execute: (
			toolCallId: string,
			params: { run_id: string; include: "checks"; cursor?: string; max_lines: number },
			signal: undefined,
			onUpdate: undefined,
			ctx: ExtensionContext,
		) => Promise<{ content: Array<Record<string, unknown>>; details: Record<string, unknown> }>;
	};
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: gate-reservation-pages\nprofile: generic\n");
		const runId = "20260813-000010-page";
		const expected = await writeGatePagingFixture(root, runId, 80);
		const stub = makeRoleRuntime("commander");
		const ctx = trustedCtx(root, "gate-reservation-chain") as ExtensionContext;
		const tool = stub.tools.get("workbench_read_gate") as GateReadTool;
		assert.ok(tool);
		const reconstructed: string[] = [];
		let cursor: string | undefined;
		let turnIndex = 0;
		do {
			const id = `gate-page-${turnIndex}`;
			const params = { run_id: runId, include: "checks" as const, ...(cursor ? { cursor } : {}), max_lines: 320 };
			const calls = Array.from({ length: 16 }, (_, index) => ({
				id: index === 0 ? id : `${id}-reserve-${index}`,
				name: "workbench_read_gate",
				arguments: params,
			}));
			await startBudgetTurn(stub, ctx, "commander", turnIndex, calls);
			const guard = await emitToolCall(stub, ctx, {
				type: "tool_call", toolCallId: id, toolName: "workbench_read_gate", input: params,
			});
			assert.equal(guard.block, undefined);
			const raw = await tool.execute(id, params, undefined, undefined, ctx);
			const rawText = textOf(raw.content);
			assert.ok(bytes(rawText) <= 4_096, "execute renders inside this call's exact minimum reservation");
			const final = await emitToolResult(stub, {
				type: "tool_result", toolCallId: id, toolName: "workbench_read_gate", input: params,
				content: raw.content, details: raw.details, isError: false,
			});
			const finalText = textOf(final.content);
			assert.equal(finalText, rawText, "generic result envelope is a no-op after allocation-aware semantic rendering");
			assert.doesNotMatch(finalText, /^\[workbench-tool-result-ingress v1\]/, "an already-bounded semantic page is never inflated by a recovery wrapper");
			const details = final.details as Record<string, unknown>;
			const envelope = details.output_envelope as Record<string, unknown>;
			const ingress = details.ingress_projection as Record<string, unknown>;
			assert.ok(ingress, "the byte-exact page still carries trusted durable-source metadata");
			assert.equal(ingress.originalBytes, bytes(rawText));
			assert.equal(ingress.projectedBytes, bytes(rawText));
			assert.equal(ingress.bodyShownBytes, bytes(rawText));
			assert.equal(ingress.omittedBytes, 0);
			assert.equal(envelope.truncated, false);
			assert.equal(envelope.shownTextBytes, bytes(finalText));
			const rowKeys = finalText.split("\n").flatMap((line) => {
				const gate = /^gate (page\d+) (?:PASS|FAIL|BLOCKED|NOT_RUN) /.exec(line);
				if (gate) return [`gate:${gate[1]}`];
				const check = /^check (page\d+\/page\d+\.1) (?:PASS|FAIL|BLOCKED|NOT_RUN) /.exec(line);
				return check ? [`check:${check[1]}`] : [];
			});
			assert.equal(rowKeys.length, details.shown_count);
			reconstructed.push(...rowKeys);
			cursor = typeof details.next_cursor === "string" ? details.next_cursor : undefined;
			await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex, message: {}, toolResults: [] }, ctx);
			turnIndex += 1;
			assert.ok(turnIndex < 100, "cursor chain must make progress under the 4 KiB minimum reservation");
		} while (cursor);
		assert.deepEqual(reconstructed, expected, "cursor offsets advance only past complete rows actually visible in final content");
	});
});

test("the seventeenth call is fixed-blocked before receipt and a new turn resets the limit", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: output-budget-limit\nprofile: generic\n");
		const stub = makeRoleRuntime("commander");
		const ctx = trustedCtx(root, "budget-limit-session") as ExtensionContext;
		const calls = Array.from({ length: 17 }, (_, index) => ({ id: `limit-${index}`, name: "workbench_project_inspect", arguments: {} }));
		await startBudgetTurn(stub, ctx, "commander", 0, calls);
		for (const item of calls.slice(0, 16)) {
			assert.equal((await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: item.id, toolName: item.name, input: {} })).block, undefined);
		}
		const blocked = await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: calls[16]!.id, toolName: calls[16]!.name, input: {} });
		assert.equal(blocked.block, true);
		assert.equal(blocked.reason, TURN_CALL_LIMIT_CONTROL_TEXT);
		assert.ok(bytes(blocked.reason ?? "") < 512);
		await assert.rejects(readFile(join(root, CONFIG_DIR_NAME, "workbench", "tool-results", `${deriveResultId("budget-limit-session", calls[16]!.id)}.started`), "utf8"), { code: "ENOENT" });
		const immediate = await emitMessageEnd(stub, {
			role: "toolResult", toolCallId: calls[16]!.id, toolName: calls[16]!.name,
			content: [{ type: "text", text: `raw ${"secret".repeat(10_000)}` }], details: {}, isError: true, timestamp: 1,
		}, ctx);
		assert.equal(textOf(immediate.content as Array<Record<string, unknown>>), TURN_CALL_LIMIT_CONTROL_TEXT);
		await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);
		await startBudgetTurn(stub, ctx, "commander", 1, [{ id: "after-reset", name: "read", arguments: { path: "x" } }]);
		assert.equal((await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: "after-reset", toolName: "read", input: { path: "x" } })).block, undefined);
	});
});

test("early guard, unknown-tool and validation-style immediate errors claim their reservations", async () => {
	const stub = makeRoleRuntime("other");
	const ctx = trustedCtx(process.cwd(), "budget-immediate-session") as ExtensionContext;
	const audit = stub.commands.get("q-mode-audit") as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
	await audit.handler("", ctx as ExtensionCommandContext);
	const calls = [
		{ id: "mode-block", name: "write", arguments: { path: "x", content: "x" } },
		{ id: "unknown-block", name: "tool_missing", arguments: {} },
		{ id: "validation-block", name: "read", arguments: { path: 7 } },
	];
	await startBudgetTurn(stub, ctx, "other", 0, calls);
	const modeGuard = await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: "mode-block", toolName: "write", input: calls[0]!.arguments });
	assert.equal(modeGuard.block, true);
	assert.ok(bytes(modeGuard.reason ?? "") <= 511);
	const rawMessages = [
		{ id: "mode-block", name: "write" },
		{ id: "unknown-block", name: "tool_missing" },
		{ id: "validation-block", name: "read" },
	];
	let sum = 0;
	for (const item of rawMessages) {
		const result = await emitMessageEnd(stub, {
			role: "toolResult", toolCallId: item.id, toolName: item.name,
			content: [{ type: "text", text: "e".repeat(100_000) }], details: {}, isError: true, timestamp: 1,
		}, ctx);
		const shown = textOf(result.content as Array<Record<string, unknown>>);
		sum += bytes(shown);
		assert.ok(bytes(shown) <= ERROR_RESULT_MAX_BYTES);
		assert.equal(((result.details as Record<string, unknown>).output_envelope as Record<string, unknown>).shownTextBytes, bytes(shown));
	}
	assert.ok(sum <= WORKER_TURN_MAX_BYTES);
});

test("receipt BEGIN failure releases its authorization and the immediate fallback is empty", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: output-budget-release\nprofile: generic\n");
		const stub = makeRoleRuntime("other");
		const base = trustedCtx(root, "valid-session") as ExtensionContext;
		const ctx = {
			...base,
			sessionManager: { ...base.sessionManager, getSessionId: () => "" },
		} as ExtensionContext;
		await startBudgetTurn(stub, ctx, "other", 0, [{ id: "receipt-fail", name: "workbench_project_inspect", arguments: {} }]);
		const guard = await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: "receipt-fail", toolName: "workbench_project_inspect", input: {} });
		assert.equal(guard.block, true);
		assert.ok(bytes(guard.reason ?? "") <= 511);
		const result = await emitMessageEnd(stub, {
			role: "toolResult", toolCallId: "receipt-fail", toolName: "workbench_project_inspect",
			content: [{ type: "text", text: "must-not-survive" }], details: {}, isError: true, timestamp: 1,
		}, ctx);
		assert.deepEqual(result.content, []);
		assert.equal(result.isError, true);
		assert.equal(((result.details as Record<string, unknown>).output_envelope as Record<string, unknown>).shownTextBytes, 0);
	});
});

test("blocked reservations with zero control allocation persist an empty result", async () => {
	const stub = makeRoleRuntime("commander");
	const ctx = trustedCtx(process.cwd(), "budget-zero-control") as ExtensionContext;
	const calls = Array.from({ length: 1_000 }, (_, index) => ({ id: `many-${index}`, name: "read", arguments: { path: "x" } }));
	await startBudgetTurn(stub, ctx, "commander", 0, calls);
	const last = calls.at(-1)!;
	const guard = await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: last.id, toolName: last.name, input: last.arguments });
	assert.equal(guard.block, true);
	assert.ok(bytes(guard.reason ?? "") < 512);
	const result = await emitMessageEnd(stub, {
		role: "toolResult", toolCallId: last.id, toolName: last.name,
		content: [{ type: "text", text: "unbudgeted" }], details: {}, isError: true, timestamp: 1,
	}, ctx);
	assert.deepEqual(result.content, []);
});

test("tool_call guard source order pins budget before receipt and bookkeeping", async () => {
	const source = await readFile(join(process.cwd(), "extensions/workbench-runtime/index.ts"), "utf8");
	const guard = source.slice(source.lastIndexOf('pi.on("tool_call"'));
	const markers = [
		"streamingControl.toolCallBlockReason(",
		"workerRoleToolCallBlockReason(",
		"isWorkerPathAllowedRealpath(",
		"commanderToolCallBlockReason({",
		"checkToolCall(mode",
		"authorizeOutput(event.toolCallId",
		"beginReceipt({",
		"consumeLeaseCall(",
	];
	const positions = markers.map((marker) => guard.indexOf(marker));
	assert.ok(positions.every((position) => position >= 0), JSON.stringify(positions));
	assert.deepEqual([...positions].sort((a, b) => a - b), positions);
	assert.ok((guard.match(/reason: boundedGuardReason\(/g) ?? []).length >= 6, "every variable guard reason uses the bounded helper");
});

test("native read peeks the exact pending FIFO allocation before cursor rendering without consuming it", async () => {
	const source = await readFile(join(process.cwd(), "extensions/workbench-runtime/index.ts"), "utf8");
	const peekStart = source.indexOf("function peekOutputAuthorization(");
	const peekEnd = source.indexOf("\n\tfunction rememberTrustedReadContinuation(", peekStart);
	assert.ok(peekStart >= 0 && peekEnd > peekStart);
	const peek = source.slice(peekStart, peekEnd);
	assert.match(peek, /exactCallKey\(toolCallId, toolName\)/);
	assert.match(peek, /pendingOutputAuthorizations\.get\(key\)\?\.\[0\]/);
	assert.doesNotMatch(peek, /shift\(|delete\(/, "execute-side peek must not consume the tool_result FIFO slot");

	const readStart = source.indexOf("...NATIVE_OVERRIDE_METADATA.read");
	const readEnd = source.indexOf("...NATIVE_OVERRIDE_METADATA.grep", readStart);
	assert.ok(readStart >= 0 && readEnd > readStart);
	const read = source.slice(readStart, readEnd);
	const markers = [
		'peekOutputAuthorization(toolCallId, "read")',
		"const maxOutputBytes =",
		"buildNativeReadV3Page({",
		"maxOutputBytes,",
	];
	const positions = markers.map((marker) => read.indexOf(marker));
	assert.ok(positions.every((position) => position >= 0), JSON.stringify(positions));
	assert.deepEqual([...positions].sort((a, b) => a - b), positions);
	assert.match(source, /const trustedContinuation = takeTrustedReadContinuation\(event\.toolCallId, event\.toolName\)/);
	assert.doesNotMatch(
		source.slice(source.indexOf('/** tool_result #1'), source.indexOf('/**\n\t * tool_result #2')),
		/details\?\.next_cursor|details\.next_cursor/,
		"tool_result continuation must never be derived from caller-controlled details",
	);
});

test("forged read details cannot inject a continuation into the final truncation marker", async () => {
	const stub = makeRoleRuntime("other");
	const forged = "attacker-cursor-secret";
	const result = await emitToolResult(stub, {
		type: "tool_result",
		toolCallId: "forged-read-continuation",
		toolName: "read",
		input: { path: "never-executed.txt" },
		content: [{ type: "text", text: "x".repeat(100_000) }],
		isError: false,
		details: { schema: "workbench-read-page-v1", complete: false, next_cursor: forged },
	});
	const shown = textOf(result.content);
	assert.match(shown, /workbench-output truncated/);
	assert.doesNotMatch(shown, new RegExp(forged));
	assert.doesNotMatch(shown, /continuation=read:/);
});

function breakpointPayload(markers: readonly string[], model = "gpt-5.6-sol"): Record<string, unknown> {
	return {
		model,
		prompt_cache_key: "output-control-wiring-session",
		input: [
			{
				role: "developer",
				content: markers.map((text, index) => ({
					type: "input_text",
					text,
					marker_index: index,
				})),
			},
			{ type: "function_call", id: "fc_keep", call_id: "call_keep", name: "read", arguments: "{}" },
			{
				role: "user",
				content: [{ type: "input_text", text: "ACTIVE-TAIL-MUST-STAY-RAW", tail: true }],
			},
		],
		tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
	};
}

function withoutPromptCacheBreakpoints(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutPromptCacheBreakpoints);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (
		key === "prompt_cache_breakpoint" ? [] : [[key, withoutPromptCacheBreakpoints(item)]]
	)));
}

function explicitBreakpointInput(input: {
	payload: unknown;
	provider?: string;
	api?: string;
	modelId?: string;
	allowCodexExperimental?: boolean;
	expectedMarkerTexts: readonly string[];
}) {
	return applyExplicitPromptCacheBreakpoints({
		payload: input.payload,
		provider: input.provider ?? "openai",
		api: input.api ?? "openai-responses",
		modelId: input.modelId ?? "gpt-5.6-sol",
		allowCodexExperimental: input.allowCodexExperimental ?? false,
		expectedMarkerTexts: input.expectedMarkerTexts,
	});
}

test("explicit breakpoint helper marks only exact public-OpenAI GPT-5.6 native input_text markers with copy-on-write", () => {
	const markers = ["SEALED-SEGMENT-A", "SEALED-SEGMENT-B"] as const;
	const payload = breakpointPayload(markers);
	const originalJson = JSON.stringify(payload);
	const originalInput = payload.input as Array<Record<string, unknown>>;
	const originalMarkerItem = originalInput[0]!;
	const originalMarkerContent = originalMarkerItem.content as Array<Record<string, unknown>>;
	const originalCall = originalInput[1]!;
	const originalTail = originalInput[2]!;

	const result = explicitBreakpointInput({ payload, expectedMarkerTexts: markers });
	assert.equal(result.status, "applied");
	assert.equal(result.reason, "breakpoints_applied");
	assert.equal(result.markerCount, 2);
	assert.notEqual(result.payload, payload);
	assert.equal(JSON.stringify(payload), originalJson, "the input payload is never mutated");

	const transformed = result.payload as Record<string, unknown>;
	const transformedInput = transformed.input as Array<Record<string, unknown>>;
	const transformedMarkerItem = transformedInput[0]!;
	const transformedMarkerContent = transformedMarkerItem.content as Array<Record<string, unknown>>;
	assert.notEqual(transformedInput, originalInput);
	assert.notEqual(transformedMarkerItem, originalMarkerItem);
	assert.notEqual(transformedMarkerContent, originalMarkerContent);
	assert.notEqual(transformedMarkerContent[0], originalMarkerContent[0]);
	assert.notEqual(transformedMarkerContent[1], originalMarkerContent[1]);
	assert.equal(transformedInput[1], originalCall, "an unmodified function-call item keeps identity");
	assert.equal(transformedInput[2], originalTail, "the active tail keeps identity and receives no breakpoint");
	assert.deepEqual(transformedMarkerContent.map((block) => block.prompt_cache_breakpoint), [
		{ mode: "explicit" },
		{ mode: "explicit" },
	]);
	assert.equal((transformedInput[2]!.content as Array<Record<string, unknown>>)[0]!.prompt_cache_breakpoint, undefined);
	assert.equal(transformed.prompt_cache_key, payload.prompt_cache_key);
	assert.equal(Object.hasOwn(transformed, "prompt_cache_options"), false);
	assert.deepEqual(withoutPromptCacheBreakpoints(transformed), payload, "only explicit breakpoint fields differ canonically");
});

test("explicit breakpoint helper gates Codex experimentally and leaves DeepSeek worker payloads byte/deep exact", () => {
	const marker = "SEALED-CODEX-MARKER";
	const codexPayload = breakpointPayload([marker]);
	const disabled = explicitBreakpointInput({
		payload: codexPayload,
		provider: "openai-codex",
		api: "openai-codex-responses",
		allowCodexExperimental: false,
		expectedMarkerTexts: [marker],
	});
	assert.deepEqual({ status: disabled.status, reason: disabled.reason, markerCount: disabled.markerCount }, {
		status: "noop", reason: "codex_experimental_disabled", markerCount: 0,
	});
	assert.equal(disabled.payload, codexPayload);

	const enabled = explicitBreakpointInput({
		payload: codexPayload,
		provider: "openai-codex",
		api: "openai-codex-responses",
		allowCodexExperimental: true,
		expectedMarkerTexts: [marker],
	});
	assert.equal(enabled.status, "applied");
	assert.equal(enabled.markerCount, 1);

	const deepseekPayload = {
		model: "deepseek-v4-flash",
		messages: [{ role: "system", content: "stable" }, { role: "user", content: "worker" }],
		prompt_cache_key: "must-not-be-interpreted",
	};
	const beforeBytes = Buffer.from(JSON.stringify(deepseekPayload));
	const deepseek = explicitBreakpointInput({
		payload: deepseekPayload,
		provider: "deepseek",
		api: "openai-completions",
		modelId: "deepseek-v4-flash",
		expectedMarkerTexts: [marker],
	});
	assert.equal(deepseek.status, "noop");
	assert.equal(deepseek.reason, "provider_not_supported");
	assert.equal(deepseek.payload, deepseekPayload);
	assert.deepEqual(deepseek.payload, deepseekPayload);
	assert.deepEqual(Buffer.from(JSON.stringify(deepseek.payload)), beforeBytes);
});

test("explicit breakpoint helper strictly noops on invalid keys, models, inputs, occurrences, and existing foreign breakpoints", () => {
	const marker = "SEALED-STRICT-MARKER";
	const missingKey = breakpointPayload([marker]);
	delete missingKey.prompt_cache_key;
	const mismatchedPayloadModel = breakpointPayload([marker], "gpt-5.6-worker");
	const malformed = breakpointPayload([marker]);
	((malformed.input as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>)[0]!.text = 7;
	const duplicate = breakpointPayload([marker, marker]);
	const missing = breakpointPayload(["DIFFERENT-MARKER"]);
	const unordered = breakpointPayload(["SEALED-A", "SEALED-B"]);
	const sparse = breakpointPayload([marker]);
	const sparseInput = new Array<unknown>(2);
	sparseInput[1] = (sparse.input as unknown[])[0];
	sparse.input = sparseInput;
	const malformedBreakpoint = breakpointPayload([marker]);
	((malformedBreakpoint.input as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>)[0]!.prompt_cache_breakpoint = { mode: "automatic" };
	const unexpectedBreakpoint = breakpointPayload([marker]);
	((unexpectedBreakpoint.input as Array<Record<string, unknown>>)[2]!.content as Array<Record<string, unknown>>)[0]!.prompt_cache_breakpoint = { mode: "explicit" };

	const cases: Array<{
		name: string;
		payload: unknown;
		markers: readonly string[];
		modelId?: string;
		reason: string;
	}> = [
		{ name: "missing cache key", payload: missingKey, markers: [marker], reason: "invalid_prompt_cache_key" },
		{ name: "older model", payload: breakpointPayload([marker], "gpt-5.5"), markers: [marker], modelId: "gpt-5.5", reason: "model_not_supported" },
		{ name: "confusable model family", payload: breakpointPayload([marker], "gpt-5.60-sol"), markers: [marker], modelId: "gpt-5.60-sol", reason: "model_not_supported" },
		{ name: "payload model mismatch", payload: mismatchedPayloadModel, markers: [marker], reason: "payload_model_mismatch" },
		{ name: "malformed input_text", payload: malformed, markers: [marker], reason: "malformed_input_text" },
		{ name: "duplicate marker", payload: duplicate, markers: [marker], reason: "marker_duplicate" },
		{ name: "missing marker", payload: missing, markers: [marker], reason: "marker_missing" },
		{ name: "marker order", payload: unordered, markers: ["SEALED-B", "SEALED-A"], reason: "marker_order_mismatch" },
		{ name: "sparse input", payload: sparse, markers: [marker], reason: "invalid_payload" },
		{ name: "malformed breakpoint", payload: malformedBreakpoint, markers: [marker], reason: "malformed_breakpoint" },
		{ name: "breakpoint outside markers", payload: unexpectedBreakpoint, markers: [marker], reason: "unexpected_breakpoint" },
	];
	for (const item of cases) {
		const before = (() => { try { return JSON.stringify(item.payload); } catch { return undefined; } })();
		const result = explicitBreakpointInput({
			payload: item.payload,
			modelId: item.modelId,
			expectedMarkerTexts: item.markers,
		});
		assert.equal(result.status, "noop", item.name);
		assert.equal(result.reason, item.reason, item.name);
		assert.equal(result.payload, item.payload, item.name);
		assert.equal((() => { try { return JSON.stringify(item.payload); } catch { return undefined; } })(), before, item.name);
	}

	for (const markers of [[], Array.from({ length: 18 }, (_, index) => `M-${index}`), [marker, marker]]) {
		const payload = breakpointPayload([marker]);
		const result = explicitBreakpointInput({ payload, expectedMarkerTexts: markers });
		assert.equal(result.status, "noop");
		assert.equal(result.reason, "invalid_markers");
		assert.equal(result.payload, payload);
	}
});

test("explicit breakpoint helper never invokes accessors or proxy traps and rejects non-plain data", () => {
	const marker = "SEALED-HOSTILE-MARKER";
	let markerTrapCalls = 0;
	const proxiedMarkers = new Proxy([marker], {
		get(): never { markerTrapCalls += 1; throw new Error("must not read marker proxy"); },
		ownKeys(): never { markerTrapCalls += 1; throw new Error("must not enumerate marker proxy"); },
	});
	const markerProxyResult = explicitBreakpointInput({
		payload: breakpointPayload([marker]),
		expectedMarkerTexts: proxiedMarkers,
	});
	assert.equal(markerProxyResult.status, "noop");
	assert.equal(markerProxyResult.reason, "invalid_markers");
	assert.equal(markerTrapCalls, 0);

	let markerGetterCalls = 0;
	const accessorMarkers: string[] = [];
	Object.defineProperty(accessorMarkers, "0", {
		enumerable: true,
		configurable: true,
		get(): never { markerGetterCalls += 1; throw new Error("must not invoke marker getter"); },
	});
	const markerAccessorResult = explicitBreakpointInput({
		payload: breakpointPayload([marker]),
		expectedMarkerTexts: accessorMarkers,
	});
	assert.equal(markerAccessorResult.status, "noop");
	assert.equal(markerAccessorResult.reason, "invalid_markers");
	assert.equal(markerGetterCalls, 0);

	const ordinary = breakpointPayload([marker]);
	let rootTrapCalls = 0;
	const proxy = new Proxy(ordinary, {
		get(): never { rootTrapCalls += 1; throw new Error("must not read proxy"); },
		ownKeys(): never { rootTrapCalls += 1; throw new Error("must not enumerate proxy"); },
	});
	const proxied = explicitBreakpointInput({ payload: proxy, expectedMarkerTexts: [marker] });
	assert.equal(proxied.status, "noop");
	assert.equal(proxied.reason, "invalid_payload");
	assert.equal(proxied.payload, proxy);
	assert.equal(rootTrapCalls, 0);

	let nestedTrapCalls = 0;
	const nestedPayload = breakpointPayload([marker]);
	nestedPayload.tools = new Proxy([], {
		get(): never { nestedTrapCalls += 1; throw new Error("must not read nested proxy"); },
		ownKeys(): never { nestedTrapCalls += 1; throw new Error("must not enumerate nested proxy"); },
	});
	const nested = explicitBreakpointInput({ payload: nestedPayload, expectedMarkerTexts: [marker] });
	assert.equal(nested.status, "noop");
	assert.equal(nested.reason, "invalid_payload");
	assert.equal(nested.payload, nestedPayload);
	assert.equal(nestedTrapCalls, 0);

	let getterCalls = 0;
	const accessorPayload = breakpointPayload([marker]);
	Object.defineProperty(accessorPayload, "input", {
		enumerable: true,
		get(): never { getterCalls += 1; throw new Error("must not invoke input getter"); },
	});
	const accessor = explicitBreakpointInput({ payload: accessorPayload, expectedMarkerTexts: [marker] });
	assert.equal(accessor.status, "noop");
	assert.equal(accessor.reason, "invalid_payload");
	assert.equal(accessor.payload, accessorPayload);
	assert.equal(getterCalls, 0);

	const revoked = Proxy.revocable(ordinary, {});
	revoked.revoke();
	const revokedResult = explicitBreakpointInput({ payload: revoked.proxy, expectedMarkerTexts: [marker] });
	assert.equal(revokedResult.status, "noop");
	assert.equal(revokedResult.reason, "invalid_payload");
	assert.equal(revokedResult.payload, revoked.proxy);

	const symbolPayload = breakpointPayload([marker]);
	Object.defineProperty(symbolPayload, Symbol("hostile"), { value: "hidden", enumerable: true });
	const symbolResult = explicitBreakpointInput({ payload: symbolPayload, expectedMarkerTexts: [marker] });
	assert.equal(symbolResult.status, "noop");
	assert.equal(symbolResult.reason, "invalid_payload");
	assert.equal(symbolResult.payload, symbolPayload);

	const exoticPayload = breakpointPayload([marker]);
	exoticPayload.metadata = new Date(0);
	const exotic = explicitBreakpointInput({ payload: exoticPayload, expectedMarkerTexts: [marker] });
	assert.equal(exotic.status, "noop");
	assert.equal(exotic.reason, "invalid_payload");
	assert.equal(exotic.payload, exoticPayload);
});

test("explicit breakpoint helper safely completes a partially pre-marked payload", () => {
	const markers = ["SEALED-PARTIAL-A", "SEALED-PARTIAL-B"] as const;
	const payload = breakpointPayload(markers);
	const originalInput = payload.input as Array<Record<string, unknown>>;
	const originalContent = originalInput[0]!.content as Array<Record<string, unknown>>;
	originalContent[0]!.prompt_cache_breakpoint = { mode: "explicit" };
	const alreadyMarkedBlock = originalContent[0]!;
	const unmarkedBlock = originalContent[1]!;
	const originalJson = JSON.stringify(payload);

	const result = explicitBreakpointInput({ payload, expectedMarkerTexts: markers });
	assert.equal(result.status, "applied");
	assert.equal(result.markerCount, 2);
	assert.equal(JSON.stringify(payload), originalJson, "partial application never mutates its source payload");
	const transformed = result.payload as Record<string, unknown>;
	const transformedContent = ((transformed.input as Array<Record<string, unknown>>)[0]!.content) as Array<Record<string, unknown>>;
	assert.equal(transformedContent[0], alreadyMarkedBlock, "an exact existing marker block keeps identity");
	assert.notEqual(transformedContent[1], unmarkedBlock, "only the missing marker block is cloned");
	assert.deepEqual(transformedContent.map((block) => block.prompt_cache_breakpoint), [
		{ mode: "explicit" },
		{ mode: "explicit" },
	]);

	const idempotent = explicitBreakpointInput({ payload: result.payload, expectedMarkerTexts: markers });
	assert.equal(idempotent.status, "noop");
	assert.equal(idempotent.reason, "already_applied");
	assert.equal(idempotent.payload, result.payload);
});

test("explicit breakpoint helper supports 17 ordered markers and is payload-idempotent", () => {
	const markers = Array.from({ length: 17 }, (_, index) => `SEALED-SEGMENT-${String(index).padStart(2, "0")}`);
	const payload = breakpointPayload(markers);
	const first = explicitBreakpointInput({ payload, expectedMarkerTexts: markers });
	assert.equal(first.status, "applied");
	assert.equal(first.markerCount, 17);
	const firstPayload = first.payload as Record<string, unknown>;
	const markerBlocks = (((firstPayload.input as Array<Record<string, unknown>>)[0]!.content) as Array<Record<string, unknown>>);
	assert.deepEqual(markerBlocks.map((block) => block.text), markers);
	assert.deepEqual(markerBlocks.map((block) => block.prompt_cache_breakpoint), markers.map(() => ({ mode: "explicit" })));
	assert.equal((((firstPayload.input as Array<Record<string, unknown>>)[2]!.content) as Array<Record<string, unknown>>)[0]!.prompt_cache_breakpoint, undefined);

	const second = explicitBreakpointInput({ payload: first.payload, expectedMarkerTexts: markers });
	assert.equal(second.status, "noop");
	assert.equal(second.reason, "already_applied");
	assert.equal(second.markerCount, 17);
	assert.equal(second.payload, first.payload, "an idempotent pass performs no extra cloning");
	assert.deepEqual(second.payload, first.payload);
});

describe("tool-result ingress projection", () => {
	const ingressDigest = "ab".repeat(32);
	const ingressFacts = [
		{ key: "run_id", value: "run-ingress-01" },
		{ key: "exit_code", value: 0 },
		{ key: "complete", value: true },
	] as const;

	const eligibleCases: ReadonlyArray<{
		sourceKind: TrustedRecoverySourceKind;
		toolName: string;
		sourcePath: string;
	}> = [
		{
			sourceKind: "finalized_recipe_run",
			toolName: "workbench_run_recipe",
			sourcePath: ".pi/workbench/runs/run-recipe-01/summary.json",
		},
		{
			sourceKind: "executed_gate_run",
			toolName: "workbench_run_gate",
			sourcePath: ".pi/workbench/runs/run-gate-01/gates.json",
		},
		{
			sourceKind: "immutable_comparison",
			toolName: "workbench_compare_runs",
			sourcePath: `.pi/workbench/comparisons/cmp1-${"cd".repeat(32)}/comparison.json`,
		},
		{
			sourceKind: "completed_worker_report",
			toolName: "workbench_delegate_worker",
			sourcePath: ".pi/workbench/delegations/delegation-01/worker-report.md",
		},
		{
			sourceKind: "finalized_run_page",
			toolName: "workbench_read_run",
			sourcePath: ".pi/workbench/runs/run-page-01/stdout.log",
		},
		{
			sourceKind: "run_id_gate_page",
			toolName: "workbench_read_gate",
			sourcePath: ".pi/workbench/runs/run-page-01/gates.json",
		},
	];

	function ingressAuthority(
		entry: (typeof eligibleCases)[number],
		toolCallId = `call-${entry.sourceKind}`,
	): TrustedRecoveryAuthority {
		return {
			schema: "workbench-trusted-recovery-authority-v1",
			sourceKind: entry.sourceKind,
			toolCallId,
			toolName: entry.toolName,
			sourcePath: entry.sourcePath,
			sourceIdentity: { kind: "digest", sha256: ingressDigest },
			finalized: 1,
			budgetBytes: TOOL_RESULT_INGRESS_BUDGET_BYTES,
			requiredFacts: ingressFacts,
		};
	}

	function assertUnchanged(
		input: Parameters<typeof projectToolResultIngress>[0],
		content: unknown,
	): void {
		const result = projectToolResultIngress(input);
		assert.equal(result.status, "unchanged");
		assert.equal(result.changed, false);
		assert.equal(result.content, content, "fail-open paths preserve the exact provider content reference");
	}

	test("projects exactly the six trusted recovery sources with one deterministic bounded format", () => {
		const middleOnlySecret = "RAW_MIDDLE_SECRET_MUST_NOT_SURVIVE";
		const sourceText = `HEAD-世界-🙂\n${"A".repeat(6_000)}${middleOnlySecret}${"Z".repeat(6_000)}\nTAIL-终`;

		for (const entry of eligibleCases) {
			const content = [
				{ type: "text", text: sourceText.slice(0, 6_500) },
				{ type: "text", text: sourceText.slice(6_500) },
			];
			const originalJson = JSON.stringify(content);
			const toolCallId = `call-${entry.sourceKind}`;
			const authority = ingressAuthority(entry, toolCallId);
			const input = { toolCallId, toolName: entry.toolName, content, isError: false, authority };

			const first = projectToolResultIngress(input);
			assert.equal(first.status, "projected", entry.sourceKind);
			if (first.status !== "projected") assert.fail(`projection missing for ${entry.sourceKind}`);
			assert.equal(first.changed, true);
			assert.notEqual(first.content, content);
			assert.equal(JSON.stringify(content), originalJson, "projection is copy-on-write");
			assert.equal(first.content.length, 1);
			const text = first.content[0]!.text;
			assert.ok(Buffer.byteLength(text, "utf8") <= TOOL_RESULT_INGRESS_BUDGET_BYTES);
			assert.match(text, /^\[workbench-tool-result-ingress v1\]\n/);
			assert.ok(text.includes('fact.run_id="run-ingress-01"'));
			assert.ok(text.includes("fact.exit_code=0"));
			assert.ok(text.includes("fact.complete=true"));
			assert.ok(text.includes(`source_kind=${entry.sourceKind}`));
			assert.ok(text.includes(`source_path=${entry.sourcePath}`));
			assert.ok(text.includes(`source_ref=digest:${ingressDigest.slice(0, 16)}`));
			assert.match(text, /original_bytes=\d+\n/);
			assert.match(text, /projected_bytes=\d+\n/);
			assert.match(text, /omitted_bytes=[1-9]\d*\n/);
			assert.match(text, /projection_hash=[0-9a-f]{64}\n?$/);
			assert.ok(!text.includes(middleOnlySecret), "the bounded body omits unselected middle bytes");
			assert.ok(!text.includes("/home/"));
			assert.ok(!text.includes("argv="));
			assert.ok(!text.includes(toolCallId), "private call identity is hashed, never rendered");
			assert.ok(!text.includes("commander"));
			assert.ok(!text.includes("worker_role"));

			assert.equal(first.metadata.schema, "workbench-tool-result-ingress-metadata-v1");
			assert.equal(first.metadata.sourceKind, entry.sourceKind);
			assert.equal(first.metadata.sourcePath, entry.sourcePath);
			assert.equal(first.metadata.sourceIdentityKind, "digest");
			assert.equal(first.metadata.budgetBytes, TOOL_RESULT_INGRESS_BUDGET_BYTES);
			assert.equal(first.metadata.requiredFactCount, ingressFacts.length);
			assert.equal(first.metadata.projectedBytes, Buffer.byteLength(text, "utf8"));
			assert.ok(first.metadata.omittedBytes > 0);
			assert.ok(Buffer.byteLength(JSON.stringify(first.metadata), "utf8") <= TOOL_RESULT_INGRESS_METADATA_MAX_BYTES);
			assert.ok(!JSON.stringify(first.metadata).includes(toolCallId));

			const repeat = projectToolResultIngress(input);
			assert.deepEqual(repeat, first, "same authoritative source yields byte-identical first projection");

			const idempotent = projectToolResultIngress({ ...input, content: first.content });
			assert.equal(idempotent.status, "projected");
			if (idempotent.status !== "projected") assert.fail("projected content must be recognized");
			assert.equal(idempotent.changed, false);
			assert.equal(idempotent.content, first.content, "idempotence performs no additional cloning");
			assert.deepEqual(idempotent.metadata, first.metadata);
		}
	});

	test("keeps trusted text at or below 4 KiB byte-exact while binding metadata to the ordered block content", () => {
		const entry = eligibleCases.find((candidate) => candidate.sourceKind === "run_id_gate_page")!;
		const toolCallId = "call-small-byte-exact";
		const authority = ingressAuthority(entry, toolCallId);
		const cases = [
			[
				{ type: "text", text: "gate page alpha" },
				{ type: "text", text: "gate page beta 🙂" },
			],
			[{ type: "text", text: "x".repeat(TOOL_RESULT_INGRESS_BUDGET_BYTES) }],
		] as const;

		for (const content of cases) {
			const providerText = content.map((block) => block.text).join("\n");
			const providerBytes = Buffer.byteLength(providerText, "utf8");
			assert.ok(providerBytes <= TOOL_RESULT_INGRESS_BUDGET_BYTES);
			const result = projectToolResultIngress({
				toolCallId,
				toolName: entry.toolName,
				content,
				isError: false,
				authority,
			});
			assert.equal(result.status, "projected");
			if (result.status !== "projected") assert.fail("trusted small content must carry projection metadata");
			assert.equal(result.changed, false);
			assert.equal(result.content, content, "the exact content array reference survives");
			assert.equal(result.content[0], content[0], "the exact content block reference survives");
			assert.equal(result.metadata.originalBytes, providerBytes);
			assert.equal(result.metadata.projectedBytes, providerBytes);
			assert.equal(result.metadata.bodyShownBytes, providerBytes);
			assert.equal(result.metadata.omittedBytes, 0);
			assert.equal(result.metadata.projectionHash, toolResultTextContentDigest(content));
			assert.doesNotMatch(providerText, /\[workbench-tool-result-ingress|\[workbench-recovery|projection_hash=/);
		}
	});

	test("fails open without traps for ineligible, erroneous, non-text, or malformed authority", () => {
		const entry = eligibleCases[0]!;
		const toolCallId = "call-invalid-matrix";
		const authority = ingressAuthority(entry, toolCallId);
		const content = [{ type: "text", text: "small finalized output" }];
		const baseInput = { toolCallId, toolName: entry.toolName, content, isError: false, authority };

		for (const sourceKind of ["receipt", "current_state", "native_read", "search", "edit", "image", "error", "foreign"]) {
			assertUnchanged({ ...baseInput, authority: { ...authority, sourceKind } }, content);
		}

		const malformedAuthorities: unknown[] = [
			{ ...authority, schema: "foreign-v1" },
			{ ...authority, toolCallId: "different-call" },
			{ ...authority, toolName: "workbench_read_current" },
			{ ...authority, finalized: 0 },
			{ ...authority, budgetBytes: TOOL_RESULT_INGRESS_BUDGET_BYTES + 1 },
			{ ...authority, sourcePath: "/home/operator/raw.log" },
			{ ...authority, sourcePath: ".pi/workbench/runs/../secrets.txt" },
			{ ...authority, sourceIdentity: { kind: "digest", sha256: "short" } },
			{
				...authority,
				sourceIdentity: {
					kind: "snapshot",
					snapshotId: "cd".repeat(32),
					byteLength: -1,
					modifiedNs: "01",
					device: 1,
					inode: null,
				},
			},
			{ ...authority, requiredFacts: [{ key: "argv", value: "--show-secret" }] },
			{ ...authority, requiredFacts: [{ key: "note", value: "/home/operator/token" }] },
			{ ...authority, requiredFacts: [{ key: "note", value: "x".repeat(300) }] },
			{ ...authority, unexpected: true },
			new Date(0),
		];
		for (const malformed of malformedAuthorities) {
			assert.doesNotThrow(() => assertUnchanged({ ...baseInput, authority: malformed }, content));
		}

		assertUnchanged({ ...baseInput, isError: true }, content);
		const imageContent = [{ type: "image", data: "base64", mimeType: "image/png" }];
		assertUnchanged({ ...baseInput, content: imageContent }, imageContent);
		const mixedContent = [{ type: "text", text: "text" }, { type: "image", data: "base64", mimeType: "image/png" }];
		assertUnchanged({ ...baseInput, content: mixedContent }, mixedContent);

		let authorityTrapCalls = 0;
		const authorityProxy = new Proxy({}, {
			get(): never { authorityTrapCalls += 1; throw new Error("authority proxy trap must not run"); },
			ownKeys(): never { authorityTrapCalls += 1; throw new Error("authority proxy trap must not run"); },
		});
		assert.doesNotThrow(() => assertUnchanged({ ...baseInput, authority: authorityProxy }, content));
		assert.equal(authorityTrapCalls, 0);

		let accessorCalls = 0;
		const accessorAuthority = Object.create(null) as Record<string, unknown>;
		for (const [key, value] of Object.entries(authority)) {
			Object.defineProperty(accessorAuthority, key, { value, enumerable: true, configurable: true });
		}
		Object.defineProperty(accessorAuthority, "sourcePath", {
			enumerable: true,
			configurable: true,
			get(): never { accessorCalls += 1; throw new Error("authority accessor must not run"); },
		});
		assert.doesNotThrow(() => assertUnchanged({ ...baseInput, authority: accessorAuthority }, content));
		assert.equal(accessorCalls, 0);

		const symbolAuthority = { ...authority } as TrustedRecoveryAuthority & { [key: symbol]: unknown };
		Object.defineProperty(symbolAuthority, Symbol("hidden"), { value: true, enumerable: true });
		assertUnchanged({ ...baseInput, authority: symbolAuthority }, content);

		const revokedAuthority = Proxy.revocable({ ...authority }, {});
		revokedAuthority.revoke();
		assert.doesNotThrow(() => assertUnchanged({ ...baseInput, authority: revokedAuthority.proxy }, content));

		let contentTrapCalls = 0;
		const contentProxy = new Proxy([], {
			get(): never { contentTrapCalls += 1; throw new Error("content proxy trap must not run"); },
			ownKeys(): never { contentTrapCalls += 1; throw new Error("content proxy trap must not run"); },
		});
		assert.doesNotThrow(() => assertUnchanged({ ...baseInput, content: contentProxy }, contentProxy));
		assert.equal(contentTrapCalls, 0);
	});

	test("accepts a strict immutable snapshot and truncates on Unicode code-point boundaries", () => {
		const entry = eligibleCases.find((candidate) => candidate.sourceKind === "finalized_run_page")!;
		const toolCallId = "call-snapshot-unicode";
		const authority: TrustedRecoveryAuthority = {
			...ingressAuthority(entry, toolCallId),
			sourceIdentity: {
				kind: "snapshot",
				snapshotId: "ef".repeat(32),
				byteLength: 24_001,
				modifiedNs: "1723600000000000000",
				device: 2049,
				inode: 912345,
			},
		};
		const content = [{ type: "text", text: `${"🙂世界".repeat(2_000)}\ud800${"终点🚀".repeat(2_000)}` }];
		const result = projectToolResultIngress({ toolCallId, toolName: entry.toolName, content, isError: false, authority });
		assert.equal(result.status, "projected");
		if (result.status !== "projected") assert.fail("strict snapshot must project");
		const text = result.content[0]!.text;
		assert.equal(result.metadata.sourceIdentityKind, "snapshot");
		assert.ok(text.includes("source_ref=snapshot:efefefefefefefef"));
		assert.ok(Buffer.byteLength(text, "utf8") <= TOOL_RESULT_INGRESS_BUDGET_BYTES);
		assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text));
		assert.ok(text.includes("🙂"));
		assert.ok(text.includes("🚀"));
	});
});

describe("trusted recovery authority and runtime ingress wiring", () => {
	type RuntimeResult = {
		content: Array<Record<string, unknown>>;
		details: Record<string, unknown>;
		usage?: unknown;
	};
	type RuntimeTool = {
		execute: (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: undefined,
			onUpdate: undefined,
			ctx: ExtensionContext,
		) => Promise<RuntimeResult>;
	};

	const authorityFacts: Readonly<Record<TrustedRecoverySourceKind, ReadonlyArray<{ key: string; value: string | number | boolean | null }>>> = {
		finalized_recipe_run: [
			{ key: "run_id", value: "20260814-170000-recp" },
			{ key: "recipe", value: "ingress-large" },
			{ key: "status", value: "OK" },
			{ key: "exit_code", value: 0 },
			{ key: "duration_ms", value: 1 },
		],
		executed_gate_run: [
			{ key: "run_id", value: "20260814-170001-gate" },
			{ key: "status", value: "PASS" },
			{ key: "gate_count", value: 1 },
		],
		immutable_comparison: [
			{ key: "comparison_id", value: `cmp1-${"a".repeat(64)}` },
			{ key: "a_run_id", value: "20260814-170002-left" },
			{ key: "b_run_id", value: "20260814-170003-rght" },
			{ key: "compatible", value: true },
		],
		completed_worker_report: [
			{ key: "delegation_id", value: "20260814-170004-work" },
			{ key: "status", value: "success" },
			{ key: "turns", value: 1 },
			{ key: "exit_code", value: 0 },
		],
		finalized_run_page: [
			{ key: "run_id", value: "20260814-170005-page" },
			{ key: "include", value: "logs" },
			{ key: "log_stream", value: "stdout" },
			{ key: "page", value: 0 },
		],
		run_id_gate_page: [
			{ key: "run_id", value: "20260814-170006-gate" },
			{ key: "include", value: "summary" },
			{ key: "page", value: 0 },
		],
	};

	const authorityPaths: Readonly<Record<TrustedRecoverySourceKind, string>> = {
		finalized_recipe_run: ".pi/workbench/runs/20260814-170000-recp/summary.json",
		executed_gate_run: ".pi/workbench/runs/20260814-170001-gate/gates.json",
		immutable_comparison: `.pi/workbench/comparisons/cmp1-${"a".repeat(64)}/comparison.json`,
		completed_worker_report: ".pi/workbench/delegations/20260814-170004-work/worker-report.md",
		finalized_run_page: ".pi/workbench/runs/20260814-170005-page/stdout.log",
		run_id_gate_page: ".pi/workbench/runs/20260814-170006-gate/gates.json",
	};

	const toolBySource: Readonly<Record<TrustedRecoverySourceKind, string>> = {
		finalized_recipe_run: "workbench_run_recipe",
		executed_gate_run: "workbench_run_gate",
		immutable_comparison: "workbench_compare_runs",
		completed_worker_report: "workbench_delegate_worker",
		finalized_run_page: "workbench_read_run",
		run_id_gate_page: "workbench_read_gate",
	};

	function assertIngressResult(
		result: ResultEvent,
		sourceKind: TrustedRecoverySourceKind,
		sourceSuffix: string,
	): Record<string, unknown> {
		const text = textOf(result.content);
		assert.ok(bytes(text) <= TOOL_RESULT_INGRESS_BUDGET_BYTES);
		const details = result.details as Record<string, unknown>;
		const metadata = details.ingress_projection as Record<string, unknown>;
		assert.ok(metadata, `missing ingress metadata for ${sourceKind}`);
		assert.equal(metadata.schema, "workbench-tool-result-ingress-metadata-v1");
		assert.equal(metadata.sourceKind, sourceKind);
		assert.equal(metadata.sourceIdentityKind, "snapshot");
		assert.equal(typeof metadata.sourceIdentityHash, "string");
		assert.equal(typeof metadata.authorityHash, "string");
		assert.equal(typeof metadata.projectionHash, "string");
		assert.equal(metadata.budgetBytes, TOOL_RESULT_INGRESS_BUDGET_BYTES);
		assert.equal(metadata.projectedBytes, bytes(text));
		if (Number(metadata.originalBytes) > TOOL_RESULT_INGRESS_BUDGET_BYTES) {
			assert.match(text, /^\[workbench-tool-result-ingress v1\]\n/);
			assert.ok(Number(metadata.omittedBytes) > 0);
		} else {
			assert.doesNotMatch(text, /^\[workbench-tool-result-ingress v1\]/);
			assert.equal(metadata.originalBytes, metadata.projectedBytes);
			assert.equal(metadata.bodyShownBytes, metadata.projectedBytes);
			assert.equal(metadata.omittedBytes, 0);
		}
		assert.match(String(metadata.sourcePath), new RegExp(`${sourceSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
		assert.ok(Buffer.byteLength(JSON.stringify(details), "utf8") <= DETAILS_MAX_BYTES);
		assert.doesNotMatch(JSON.stringify(metadata), /toolCallId|\/tmp\/|worker-report body|RAW-INGRESS-MIDDLE/);
		return metadata;
	}

	test("authority is minted only for exact durable regular sources below the real project root", async () => {
		await withTempDir(async (outer) => {
			const projectRoot = join(outer, "project");
			await mkdir(projectRoot, { recursive: true });
			for (const sourceKind of Object.keys(authorityPaths) as TrustedRecoverySourceKind[]) {
				const sourcePath = authorityPaths[sourceKind];
				const absolute = join(projectRoot, sourcePath);
				await mkdir(dirname(absolute), { recursive: true });
				await writeFile(absolute, `${sourceKind}\n`, "utf8");
				const toolName = toolBySource[sourceKind];
				const authority = await buildTrustedRecoveryAuthority({
					projectRoot,
					sourceKind,
					toolCallId: `authority-${sourceKind}`,
					toolName,
					sourcePath,
					requiredFacts: authorityFacts[sourceKind],
				});
				assert.ok(authority, sourceKind);
				assert.equal(authority.sourcePath, sourcePath);
				assert.equal(authority.sourceIdentity.kind, "snapshot");
				if (authority.sourceIdentity.kind !== "snapshot") assert.fail("durable sources require snapshot identity");
				const sourceStat = await stat(absolute, { bigint: true });
				const contentDigest = createHash("sha256").update(`${sourceKind}\n`, "utf8").digest("hex");
				const expectedSnapshotId = createHash("sha256").update(JSON.stringify([
					"trusted-recovery-source-v2",
					sourcePath,
					contentDigest,
					Number(sourceStat.size),
					sourceStat.mtimeNs.toString(10),
					sourceStat.ctimeNs.toString(10),
					Number(sourceStat.dev),
					Number(sourceStat.ino),
				]), "utf8").digest("hex");
				assert.equal(authority.sourceIdentity.snapshotId, expectedSnapshotId, `${sourceKind} identity binds bytes and complete stable stat facts`);
				assert.equal(JSON.stringify(authority).includes(projectRoot), false);
			}

			const outside = join(outer, "outside.txt");
			await writeFile(outside, "outside", "utf8");
			const outsideDir = join(outer, "outside-dir");
			await mkdir(outsideDir, { recursive: true });
			await writeFile(join(outsideDir, "stdout.log"), "outside-dir", "utf8");
			const linkedPath = ".pi/workbench/runs/20260814-170007-link/stdout.log";
			const linkedAbsolute = join(projectRoot, linkedPath);
			await mkdir(dirname(linkedAbsolute), { recursive: true });
			await symlink(outside, linkedAbsolute);
			const linkedDirectoryPath = ".pi/workbench/runs/20260814-170007-dir/stdout.log";
			await symlink(outsideDir, dirname(join(projectRoot, linkedDirectoryPath)), "dir");
			const base = {
				projectRoot,
				sourceKind: "finalized_run_page" as const,
				toolCallId: "authority-rejected",
				toolName: "workbench_read_run",
				requiredFacts: authorityFacts.finalized_run_page,
			};
			assert.equal(await buildTrustedRecoveryAuthority({ ...base, sourcePath: linkedPath }), undefined, "final symlink is never authority");
			assert.equal(await buildTrustedRecoveryAuthority({ ...base, sourcePath: linkedDirectoryPath }), undefined, "symlinked path components are never authority");
			assert.equal(await buildTrustedRecoveryAuthority({ ...base, sourcePath: "../outside.txt" }), undefined, "outside path is never authority");
			assert.equal(await buildTrustedRecoveryAuthority({ ...base, sourcePath: ".pi/workbench/runs/missing/stdout.log" }), undefined);
			assert.equal(await buildTrustedRecoveryAuthority({
				...base,
				sourcePath: authorityPaths.finalized_run_page,
				requiredFacts: [{ key: "run_id", value: "wrong-contract" }],
			}), undefined, "tool-specific fact sets are exact");

			const joined = [{ type: "text", text: "first" }, { type: "text", text: "second🙂" }];
			const digest = toolResultTextContentDigest(joined);
			assert.match(digest ?? "", /^[0-9a-f]{64}$/);
			assert.notEqual(toolResultTextContentDigest([{ type: "text", text: "first\nsecond🙂" }]), digest, "block segmentation is part of the private digest");
			assert.equal(toolResultTextContentDigest([{ type: "text", text: "first" }, { type: "image", data: "x", mimeType: "image/png" }]), undefined);
			const hostileBlock = { type: "text", text: "first", extra: "not-provider-text" };
			assert.equal(toolResultTextContentDigest([hostileBlock]), undefined);
		});
	});

	test("authority fails closed on same-size sub-millisecond mutation and oversized durable sources", async () => {
		await withTempDir(async (outer) => {
			const projectRoot = join(outer, "project");
			const racePath = ".pi/workbench/runs/20260814-170008-race/stdout.log";
			const raceAbsolute = join(projectRoot, racePath);
			await mkdir(dirname(raceAbsolute), { recursive: true });
			await writeFile(raceAbsolute, "AAAA", "utf8");
			const fixedSeconds = 1_723_600_000;
			await utimes(raceAbsolute, fixedSeconds, fixedSeconds);
			let hookSnapshot: { byteLength: number; modifiedNs: string; changedNs: string; device: number; inode: number } | undefined;
			let mutatedSnapshot: { byteLength: number; modifiedNs: string; changedNs: string; device: number; inode: number } | undefined;
			let hookCalled = false;
			const raced = await buildTrustedRecoveryAuthority({
				projectRoot,
				sourceKind: "finalized_run_page",
				toolCallId: "authority-raced",
				toolName: "workbench_read_run",
				sourcePath: racePath,
				requiredFacts: authorityFacts.finalized_run_page,
				testHooks: {
					afterInitialStat: async (snapshot) => {
						hookCalled = true;
						hookSnapshot = { ...snapshot };
						await writeFile(raceAbsolute, "BBBB", "utf8");
						await utimes(raceAbsolute, fixedSeconds, fixedSeconds);
						const mutated = await stat(raceAbsolute, { bigint: true });
						mutatedSnapshot = {
							byteLength: Number(mutated.size),
							modifiedNs: mutated.mtimeNs.toString(10),
							changedNs: mutated.ctimeNs.toString(10),
							device: Number(mutated.dev),
							inode: Number(mutated.ino),
						};
					},
				},
			});
			assert.equal(hookCalled, true);
			assert.ok(hookSnapshot);
			assert.ok(mutatedSnapshot);
			assert.equal(mutatedSnapshot.byteLength, hookSnapshot.byteLength, "mutation preserves byte length");
			assert.equal(mutatedSnapshot.modifiedNs, hookSnapshot.modifiedNs, "mutation restores the same high-resolution mtime");
			assert.equal(mutatedSnapshot.device, hookSnapshot.device);
			assert.equal(mutatedSnapshot.inode, hookSnapshot.inode);
			assert.notEqual(mutatedSnapshot.changedNs, hookSnapshot.changedNs, "unforgeable ctime still exposes the sub-millisecond mutation");
			assert.equal(raced, undefined, "a source mutated between same-handle observations never mints authority");

			const oversizedPath = ".pi/workbench/runs/20260814-170009-large/stdout.log";
			const oversizedAbsolute = join(projectRoot, oversizedPath);
			await mkdir(dirname(oversizedAbsolute), { recursive: true });
			await writeFile(oversizedAbsolute, Buffer.alloc(TRUSTED_RECOVERY_SOURCE_MAX_BYTES + 1, 0x78));
			assert.equal(await buildTrustedRecoveryAuthority({
				projectRoot,
				sourceKind: "finalized_run_page",
				toolCallId: "authority-oversized",
				toolName: "workbench_read_run",
				sourcePath: oversizedPath,
				requiredFacts: authorityFacts.finalized_run_page,
			}), undefined, "sources above the fixed 4 MiB authority cap fail open");
		});
	});

	test("Commander and worker runtimes project each eligible durable tool source before the generic envelope", async () => {
		await withTempDir(async (root) => {
			await writeConfigFile(root, "project.yaml", "name: ingress-runtime\nprofile: generic\n");
			await writeConfigFile(root, "recipes.yaml", [
				"recipes:",
				"  - name: ingress-large",
				'    command: ["node", "-e", "process.stdout.write(\'R\'.repeat(12000))"]',
				"",
			].join("\n"));
			await writeConfigFile(root, "gates.yaml", [
				"gates:",
				"  - id: g1",
				"    title: Ingress gate",
				"    checks:",
				"      - { id: g1.1, title: Present, kind: file, path: present.txt }",
				"",
			].join("\n"));
			await writeFile(join(root, "present.txt"), "present", "utf8");
			await writeComparisonManifest(root, "20260814-171000-left", "2026-08-14T17:10:00.000Z");
			await writeComparisonManifest(root, "20260814-171001-rght", "2026-08-14T17:10:01.000Z");

			const stub = makeRoleRuntime("commander");
			const base = trustedCtx(root, "ingress-runtime-session") as ExtensionContext;
			const ctx = {
				...base,
				model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" },
			} as ExtensionContext;
			await emitEvent(stub, "model_select", {
				type: "model_select",
				model: ctx.model,
				previousModel: undefined,
				source: "set",
			}, ctx);

			const recipe = stub.tools.get("workbench_run_recipe") as RuntimeTool;
			const recipeRaw = await recipe.execute("ingress-recipe", { recipe: "ingress-large", cache: "no-cache" }, undefined, undefined, ctx);
			const recipeResult = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-recipe", toolName: "workbench_run_recipe",
				input: { recipe: "ingress-large", cache: "no-cache" }, content: recipeRaw.content, details: {
					...recipeRaw.details,
					ingress_projection: { schema: "caller-forged", sourcePath: "/tmp/forged" },
				}, isError: false,
			});
			assertIngressResult(recipeResult, "finalized_recipe_run", "/summary.json");
			assert.notEqual((recipeResult.details as Record<string, unknown>).ingress_projection, (recipeRaw.details as Record<string, unknown>).ingress_projection);
			const recipeRunId = String((recipeRaw.details as Record<string, unknown>).run_id);

			const readRun = stub.tools.get("workbench_read_run") as RuntimeTool;
			const plannedCommanderCalls = [
				{ id: "ingress-read-run", name: "workbench_read_run", arguments: { run_id: recipeRunId, include: "logs", log_stream: "stdout", max_bytes: 32768 } },
				{ id: "ingress-read-run-small", name: "workbench_read_run", arguments: { run_id: recipeRunId, include: "logs", log_stream: "stdout", max_bytes: 2048 } },
				{ id: "ingress-compare", name: "workbench_compare_runs", arguments: { a: "20260814-171000-left", b: "20260814-171001-rght" } },
				{ id: "ingress-gate", name: "workbench_run_gate", arguments: { gates: "g1" } },
				{ id: "ingress-read-gate", name: "workbench_read_gate", arguments: { run_id: "planned-after-gate", include: "summary" } },
				{ id: "ingress-read-both", name: "workbench_read_run", arguments: { run_id: recipeRunId, include: "logs", log_stream: "both" } },
				{ id: "ingress-preflight", name: "workbench_run_gate", arguments: { gates: "g1", preflight: true } },
				{ id: "ingress-current-gate", name: "workbench_read_gate", arguments: { gate_id: "g1", include: "summary" } },
			];
			await startBudgetTurn(stub, ctx, "commander", 70, plannedCommanderCalls);
			const runPageRaw = await readRun.execute("ingress-read-run", {
				run_id: recipeRunId, include: "logs", log_stream: "stdout", max_bytes: 32768,
			}, undefined, undefined, ctx);
			const runPage = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-read-run", toolName: "workbench_read_run",
				input: { run_id: recipeRunId, include: "logs", log_stream: "stdout", max_bytes: 32768 },
				content: runPageRaw.content, details: runPageRaw.details, isError: false,
			});
			assertIngressResult(runPage, "finalized_run_page", "/stdout.log");

			const smallRunPageRaw = await readRun.execute("ingress-read-run-small", {
				run_id: recipeRunId, include: "logs", log_stream: "stdout", max_bytes: 2048,
			}, undefined, undefined, ctx);
			const smallRunPageRawText = textOf(smallRunPageRaw.content);
			assert.ok(bytes(smallRunPageRawText) <= TOOL_RESULT_INGRESS_BUDGET_BYTES);
			const smallRunPage = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-read-run-small", toolName: "workbench_read_run",
				input: { run_id: recipeRunId, include: "logs", log_stream: "stdout", max_bytes: 2048 },
				content: smallRunPageRaw.content, details: smallRunPageRaw.details, isError: false,
			});
			assert.equal(textOf(smallRunPage.content), smallRunPageRawText, "a <=4 KiB run-log cursor page is byte-exact through the generic envelope");
			assertIngressResult(smallRunPage, "finalized_run_page", "/stdout.log");

			const compare = stub.tools.get("workbench_compare_runs") as RuntimeTool;
			const compareRaw = await compare.execute("ingress-compare", {
				a: "20260814-171000-left", b: "20260814-171001-rght",
			}, undefined, undefined, ctx);
			const comparison = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-compare", toolName: "workbench_compare_runs",
				input: { a: "20260814-171000-left", b: "20260814-171001-rght" },
				content: compareRaw.content, details: compareRaw.details, isError: false,
			});
			assertIngressResult(comparison, "immutable_comparison", "/comparison.json");

			const gate = stub.tools.get("workbench_run_gate") as RuntimeTool;
			const gateRaw = await gate.execute("ingress-gate", { gates: "g1" }, undefined, undefined, ctx);
			const gateResult = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-gate", toolName: "workbench_run_gate",
				input: { gates: "g1" }, content: gateRaw.content, details: gateRaw.details, isError: false,
			});
			assertIngressResult(gateResult, "executed_gate_run", "/gates.json");
			const gateRunId = String((gateRaw.details as Record<string, unknown>).run_id);

			const readGate = stub.tools.get("workbench_read_gate") as RuntimeTool;
			const gatePageRaw = await readGate.execute("ingress-read-gate", {
				run_id: gateRunId, include: "summary",
			}, undefined, undefined, ctx);
			const gatePage = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-read-gate", toolName: "workbench_read_gate",
				input: { run_id: gateRunId, include: "summary" }, content: gatePageRaw.content, details: gatePageRaw.details, isError: false,
			});
			assertIngressResult(gatePage, "run_id_gate_page", "/gates.json");

			const bothRaw = await readRun.execute("ingress-read-both", {
				run_id: recipeRunId, include: "logs", log_stream: "both",
			}, undefined, undefined, ctx);
			const both = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-read-both", toolName: "workbench_read_run",
				input: { run_id: recipeRunId, include: "logs", log_stream: "both" },
				content: bothRaw.content, details: { ...bothRaw.details, ingress_projection: { schema: "caller-forged" } }, isError: false,
			});
			assert.equal(textOf(both.content).startsWith("[workbench-tool-result-ingress v1]"), false, "multi-source log page stays unchanged");
			assert.equal(Object.hasOwn(both.details as Record<string, unknown>, "ingress_projection"), false, "caller metadata is dropped on an ineligible result");

			const preflightRaw = await gate.execute("ingress-preflight", { gates: "g1", preflight: true }, undefined, undefined, ctx);
			const preflight = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-preflight", toolName: "workbench_run_gate",
				input: { gates: "g1", preflight: true }, content: preflightRaw.content, details: preflightRaw.details, isError: false,
			});
			assert.equal(Object.hasOwn(preflight.details as Record<string, unknown>, "ingress_projection"), false);

			const currentGateRaw = await readGate.execute("ingress-current-gate", { gate_id: "g1", include: "summary" }, undefined, undefined, ctx);
			const currentGate = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-current-gate", toolName: "workbench_read_gate",
				input: { gate_id: "g1", include: "summary" }, content: currentGateRaw.content, details: currentGateRaw.details, isError: false,
			});
			assert.equal(Object.hasOwn(currentGate.details as Record<string, unknown>, "ingress_projection"), false);

			const workerStub = makeRoleRuntime("worker");
			const workerRecipe = workerStub.tools.get("workbench_run_recipe") as RuntimeTool;
			const workerRaw = await workerRecipe.execute("ingress-worker-recipe", {
				recipe: "ingress-large", cache: "no-cache",
			}, undefined, undefined, trustedCtx(root, "ingress-worker-session") as ExtensionContext);
			const workerResult = await emitToolResult(workerStub, {
				type: "tool_result", toolCallId: "ingress-worker-recipe", toolName: "workbench_run_recipe",
				input: { recipe: "ingress-large", cache: "no-cache" }, content: workerRaw.content, details: workerRaw.details, isError: false,
			});
			assertIngressResult(workerResult, "finalized_recipe_run", "/summary.json");
		});
	});

	test("a completed real delegate execution authorizes only its durable worker report", async () => {
		await withTempDir(async (root) => {
			await writeConfigFile(root, "project.yaml", "name: ingress-worker-report\nprofile: generic\n");
			const initialized = await spawnExec("git", ["init", "-q"], { cwd: root });
			assert.equal(initialized.code, 0, initialized.stderr);
			const fakeWorker = join(root, "fake-worker.cjs");
			const report = [
				"## Completed",
				"- Recorded a bounded no-change handoff.",
				"## Files Changed",
				"- None.",
				"## Verification",
				"- No command requested.",
				"## Remaining Risks",
				"- None.",
			].join("\n");
			await writeFile(fakeWorker, [
				"const message = {",
				"  role: 'assistant',",
				`  content: [{ type: 'text', text: ${JSON.stringify(report)} }],`,
				"  provider: 'deepseek', model: 'deepseek-v4-flash', stopReason: 'stop',",
				"  usage: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },",
				"};",
				"process.stdout.write(JSON.stringify({ type: 'message_end', message }) + '\\n');",
				"",
			].join("\n"), "utf8");

			const stub = makeRoleRuntime("commander");
			const base = trustedCtx(root, "ingress-delegate-session") as ExtensionContext;
			const ctx = {
				...base,
				model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" },
			} as ExtensionContext;
			const tool = stub.tools.get("workbench_delegate_worker") as RuntimeTool;
			const previousScript = process.argv[1];
			let raw: RuntimeResult;
			try {
				process.argv[1] = fakeWorker;
				raw = await tool.execute("ingress-worker-report", {
					task: "Return the fixed bounded report without changing files.",
					allowed_paths: ["extensions/workbench-runtime/index.ts"],
					acceptance_criteria: ["A durable worker report is recorded."],
					verification: [],
					timeout_seconds: 60,
				}, undefined, undefined, ctx);
			} finally {
				if (previousScript === undefined) delete process.argv[1];
				else process.argv[1] = previousScript;
			}
			const projected = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-worker-report", toolName: "workbench_delegate_worker",
				input: { task: "bounded", allowed_paths: ["extensions/workbench-runtime/index.ts"] },
				content: raw.content, details: raw.details, usage: raw.usage, isError: false,
			});
			const metadata = assertIngressResult(projected, "completed_worker_report", "/worker-report.md");
			assert.equal(metadata.requiredFactCount, 4);
			assert.equal(Object.hasOwn(projected.details as Record<string, unknown>, "summary"), false, "ordinary worker report summary is not retained in projected details");
		});
	});

	test("exact FIFO correlation fails open for stale, mismatched, failed, lifecycle-cleared, and immediate-only results", async () => {
		await withTempDir(async (root) => {
			await writeConfigFile(root, "project.yaml", "name: ingress-fifo\nprofile: generic\n");
			await writeConfigFile(root, "recipes.yaml", [
				"recipes:",
				"  - name: ingress-ok",
				'    command: ["node", "-e", "process.stdout.write(\'ok\')"]',
				"",
			].join("\n"));
			const stub = makeRoleRuntime("other");
			const ctx = trustedCtx(root, "ingress-fifo-session") as ExtensionContext;
			const tool = stub.tools.get("workbench_run_recipe") as RuntimeTool;

			const failedRaw = await tool.execute("ingress-failed-slot", { recipe: "missing" }, undefined, undefined, ctx);
			const successRaw = await tool.execute("ingress-success-slot", { recipe: "ingress-ok", cache: "no-cache" }, undefined, undefined, ctx);
			const failed = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-failed-slot", toolName: "workbench_run_recipe",
				input: { recipe: "missing" }, content: failedRaw.content, details: failedRaw.details, isError: true,
			});
			assert.equal(Object.hasOwn(failed.details as Record<string, unknown>, "ingress_projection"), false, "the failed FIFO slot cannot steal the next authority");
			const success = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-success-slot", toolName: "workbench_run_recipe",
				input: { recipe: "ingress-ok" }, content: successRaw.content, details: successRaw.details, isError: false,
			});
			assertIngressResult(success, "finalized_recipe_run", "/summary.json");

			const mismatchRaw = await tool.execute("ingress-name-mismatch", { recipe: "ingress-ok", cache: "no-cache" }, undefined, undefined, ctx);
			const mismatch = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-name-mismatch", toolName: "workbench_compare_runs",
				input: {}, content: mismatchRaw.content, details: {}, isError: false,
			});
			assert.equal(Object.hasOwn(mismatch.details as Record<string, unknown>, "ingress_projection"), false);
			const matchedLater = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-name-mismatch", toolName: "workbench_run_recipe",
				input: { recipe: "ingress-ok" }, content: mismatchRaw.content, details: mismatchRaw.details, isError: false,
			});
			assertIngressResult(matchedLater, "finalized_recipe_run", "/summary.json");

			const lifecycleRaw = await tool.execute("ingress-lifecycle", { recipe: "ingress-ok", cache: "no-cache" }, undefined, undefined, ctx);
			await emitEvent(stub, "session_tree", { type: "session_tree", newLeafId: "next", oldLeafId: "old" }, ctx);
			const lifecycle = await emitToolResult(stub, {
				type: "tool_result", toolCallId: "ingress-lifecycle", toolName: "workbench_run_recipe",
				input: { recipe: "ingress-ok" }, content: lifecycleRaw.content, details: lifecycleRaw.details, isError: false,
			});
			assert.equal(Object.hasOwn(lifecycle.details as Record<string, unknown>, "ingress_projection"), false, "tree lifecycle clears private authority");

			const immediateRaw = await tool.execute("ingress-immediate", { recipe: "ingress-ok", cache: "no-cache" }, undefined, undefined, ctx);
			const immediate = await emitMessageEnd(stub, {
				role: "toolResult", toolCallId: "ingress-immediate", toolName: "workbench_run_recipe",
				content: immediateRaw.content, details: immediateRaw.details, isError: false, timestamp: 1,
			}, ctx);
			assert.equal(textOf(immediate.content as Array<Record<string, unknown>>).startsWith("[workbench-tool-result-ingress v1]"), false, "message_end never mints or consumes ingress authority");
			assert.equal(Object.hasOwn(immediate.details as Record<string, unknown>, "ingress_projection"), false);
			await emitEvent(stub, "session_start", { type: "session_start", reason: "reload" }, ctx);
		});
	});

	test("byte-exact content binding fails open on replacement and receipt finalization sees only the real projected result", async () => {
		await withTempDir(async (root) => {
			await writeConfigFile(root, "project.yaml", "name: ingress-receipt\nprofile: generic\n");
			await writeConfigFile(root, "recipes.yaml", [
				"recipes:",
				"  - name: ingress-receipt",
				'    command: ["node", "-e", "process.stdout.write(\'R\'.repeat(12000))"]',
				"",
			].join("\n"));
			const stub = makeRoleRuntime("other");
			const ctx = trustedCtx(root, "ingress-receipt-session") as ExtensionContext;
			const mismatchCall = { id: "ingress-content-mismatch", name: "workbench_run_recipe", arguments: { recipe: "ingress-receipt", cache: "no-cache" } };
			await startBudgetTurn(stub, ctx, "other", 91, [mismatchCall]);
			assert.equal((await emitToolCall(stub, ctx, {
				type: "tool_call", toolCallId: mismatchCall.id, toolName: mismatchCall.name, input: mismatchCall.arguments,
			})).block, undefined);
			const tool = stub.tools.get("workbench_run_recipe") as RuntimeTool;
			const mismatchRaw = await tool.execute(mismatchCall.id, mismatchCall.arguments, undefined, undefined, ctx);
			const replacementMarker = "BYTE-EXACT-MISMATCH-REMAINS-UNPROJECTED";
			const mismatch = await emitToolResult(stub, {
				type: "tool_result", toolCallId: mismatchCall.id, toolName: mismatchCall.name, input: mismatchCall.arguments,
				content: [{ type: "text", text: replacementMarker }], details: mismatchRaw.details, isError: false,
			});
			assert.equal(textOf(mismatch.content), replacementMarker);
			assert.equal(Object.hasOwn(mismatch.details as Record<string, unknown>, "ingress_projection"), false);
			const recipeRunId = String(mismatchRaw.details.run_id);
			await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex: 91, message: {}, toolResults: [] }, ctx);

			const realCall = {
				id: "ingress-receipt-call",
				name: "workbench_read_run",
				arguments: { run_id: recipeRunId, include: "logs", log_stream: "stdout", max_bytes: 32768 },
			};
			await startBudgetTurn(stub, ctx, "other", 92, [realCall]);
			assert.equal((await emitToolCall(stub, ctx, {
				type: "tool_call", toolCallId: realCall.id, toolName: realCall.name, input: realCall.arguments,
			})).block, undefined);
			const readRun = stub.tools.get("workbench_read_run") as RuntimeTool;
			const raw = await readRun.execute(realCall.id, realCall.arguments, undefined, undefined, ctx);
			assert.ok(bytes(textOf(raw.content)) > TOOL_RESULT_INGRESS_BUDGET_BYTES, "the real provider input exceeds the ingress budget before projection");
			const result = await emitToolResult(stub, {
				type: "tool_result", toolCallId: realCall.id, toolName: realCall.name, input: realCall.arguments,
				content: raw.content, details: raw.details, isError: false,
			});
			assertIngressResult(result, "finalized_run_page", "/stdout.log");
			const receiptFacts = (result.details as Record<string, unknown>).receipt as Record<string, unknown>;
			assert.equal(receiptFacts.available, true);
			const receiptPath = String(receiptFacts.path);
			const receipt = JSON.parse(await readFile(join(root, receiptPath), "utf8")) as { summary: string };
			assert.match(receipt.summary, /^\[workbench-tool-result-ingress v1\]\n/);
			assert.ok(bytes(receipt.summary) <= TOOL_RESULT_INGRESS_BUDGET_BYTES);
		});
	});

	test("falls back to the original raw result when a low turn reservation cannot preserve the ingress projection", async () => {
		await withTempDir(async (root) => {
			await writeConfigFile(root, "project.yaml", "name: ingress-low-reservation\nprofile: generic\n");
			const leftRunId = "20260814-172000-left";
			const rightRunId = "20260814-172001-rght";
			await writeGatePagingFixture(root, leftRunId, 48);
			await writeGatePagingFixture(root, rightRunId, 48);
			const gateIds = Array.from(
				{ length: 48 },
				(_, index) => `gate-${String(index).padStart(2, "0")}-${"g".repeat(119)}`,
			);
			for (const [runId, status] of [[leftRunId, "BLOCKED"], [rightRunId, "NOT_RUN"]] as const) {
				await writeFile(join(runsDir(root), runId, "gates.json"), JSON.stringify({
					schema_version: 1,
					run_id: runId,
					requested: ["all"],
					profile: "generic",
					mode: "VERIFY",
					gates: gateIds.map((id) => ({ id, status })),
				}), "utf8");
			}

			const stub = makeRoleRuntime("other");
			const ctx = trustedCtx(root, "ingress-low-reservation-session") as ExtensionContext;
			const target = {
				id: "ingress-low-reservation",
				name: "workbench_compare_runs",
				arguments: { a: leftRunId, b: rightRunId },
			};
			await emitEvent(stub, "turn_start", { type: "turn_start", turnIndex: 93, timestamp: 1 }, ctx);
			assert.equal((await emitToolCall(stub, ctx, {
				type: "tool_call", toolCallId: target.id, toolName: target.name, input: target.arguments,
			})).block, undefined);
			const compare = stub.tools.get("workbench_compare_runs") as RuntimeTool;
			const raw = await compare.execute(target.id, target.arguments, undefined, undefined, ctx);
			const rawText = textOf(raw.content);
			assert.ok(bytes(rawText) > TOOL_RESULT_INGRESS_BUDGET_BYTES, "the finalized immutable-comparison presentation deterministically exercises the oversized ingress wrapper path");
			assert.equal(rawText.startsWith("[workbench-tool-result-ingress v1]"), false);
			const rawDigest = toolResultTextContentDigest(raw.content);
			assert.match(rawDigest ?? "", /^[0-9a-f]{64}$/, "the runtime authority is bound to this exact ordered tool content");
			const rawDetails = raw.details as Record<string, unknown>;
			const comparisonId = rawDetails.comparison_id;
			const aRunId = rawDetails.a_run_id;
			const bRunId = rawDetails.b_run_id;
			const compatible = rawDetails.compatible;
			if (typeof comparisonId !== "string"
				|| typeof aRunId !== "string"
				|| typeof bRunId !== "string"
				|| typeof compatible !== "boolean") {
				assert.fail("immutable comparison details must expose typed recovery facts");
			}
			const authority = await buildTrustedRecoveryAuthority({
				projectRoot: root,
				sourceKind: "immutable_comparison",
				toolCallId: target.id,
				toolName: target.name,
				sourcePath: String(rawDetails.comparison_path),
				requiredFacts: [
					{ key: "comparison_id", value: comparisonId },
					{ key: "a_run_id", value: aRunId },
					{ key: "b_run_id", value: bRunId },
					{ key: "compatible", value: compatible },
				],
			});
			assert.ok(authority, "the persisted comparison is a valid trusted recovery source");
			const candidate = projectToolResultIngress({
				toolCallId: target.id,
				toolName: target.name,
				content: raw.content,
				isError: false,
				authority,
			});
			assert.equal(candidate.status, "projected");
			if (candidate.status !== "projected") assert.fail("trusted oversized comparison must produce an ingress candidate");
			assert.equal(candidate.changed, true);
			const candidateText = candidate.content.map((block) => block.text).join("");
			assert.match(candidateText, /^\[workbench-tool-result-ingress v1\]\n/);
			assert.ok(bytes(candidateText) <= TOOL_RESULT_INGRESS_BUDGET_BYTES);

			const result = await emitToolResult(stub, {
				type: "tool_result", toolCallId: target.id, toolName: target.name, input: target.arguments,
				content: raw.content, details: raw.details, isError: false,
			});
			const shown = textOf(result.content);
			const details = result.details as Record<string, unknown>;
			const envelope = details.output_envelope as Record<string, unknown>;
			assert.match(shown, /\[workbench-output truncated /);
			assert.doesNotMatch(shown, /\[workbench-tool-result-ingress|\[workbench-recovery|projection_hash=/, "metadata-free output is rebuilt from the original result, never a partial ingress wrapper");
			assert.ok(bytes(shown) <= DEFENSIVE_DYNAMIC_RESERVATION_BYTES);
			assert.equal(shown.startsWith(rawText.slice(0, 256)), true, "the generic envelope is rebuilt from the byte-exact raw comparison prefix");
			assert.equal(envelope.reason, "turn-reservation");
			assert.equal(envelope.policy, "compare");
			assert.equal(envelope.truncated, true);
			assert.equal(envelope.originalTextBytes, bytes(rawText), "envelope accounting is based on the original raw result exactly once");
			assert.equal(envelope.shownTextBytes, bytes(shown));
			assert.equal(Object.hasOwn(details, "ingress_projection"), false, "post-envelope content cannot retain the pre-envelope projection hash or byte facts");

			const receiptFacts = details.receipt as Record<string, unknown>;
			assert.equal(receiptFacts.available, true);
			const receipt = JSON.parse(await readFile(join(root, String(receiptFacts.path)), "utf8")) as {
				summary: string;
				summary_omitted_bytes: number;
			};
			assert.doesNotMatch(receipt.summary, /\[workbench-tool-result-ingress|\[workbench-recovery|projection_hash=/, "the receipt scans only the final generic envelope");
			assert.ok(bytes(receipt.summary) <= DEFENSIVE_DYNAMIC_RESERVATION_BYTES);
			assert.equal(shown.startsWith(receipt.summary.slice(0, 256)), true);
			assert.ok(receipt.summary_omitted_bytes >= 0);

			await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex: 93, message: {}, toolResults: [] }, ctx);
			const telemetryEntries = stub.appendedEntries.filter((entry) => entry.customType === "workbench-output-turn-telemetry-v1");
			assert.equal(telemetryEntries.length, 1);
			const telemetry = telemetryEntries[0]!.data as Record<string, unknown>;
			assert.equal(telemetry.planning, "dynamic");
			assert.equal(telemetry.reservationCount, 1);
			assert.equal(telemetry.reservedBytes, DEFENSIVE_DYNAMIC_RESERVATION_BYTES);
			assert.equal(telemetry.consumedCalls, 1);
			assert.equal(telemetry.consumedBytes, bytes(shown));
			assert.equal(telemetry.totalAccountedBytes, bytes(shown));
		});
	});
});

test("runtime correlates exactly one numeric context projection to the next provider request for every actor role", async () => {
	for (const [role, actorRoleCode] of [["commander", 1], ["worker", 2], ["other", 0]] as const) {
		await withTempDir(async (root) => {
			await writeConfigFile(root, "project.yaml", `name: context-correlation-${role}\nprofile: generic\n`);
			const stub = makeRoleRuntime(role);
			const base = trustedCtx(root, `context-correlation-${role}`) as ExtensionContext;
			const model = role === "commander"
				? { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" }
				: { provider: "deepseek", id: "deepseek-v4-flash", api: "openai-completions" };
			const ctx = {
				...base,
				model,
				thinkingLevel: "high",
				getSystemPrompt: () => "stable numeric correlation prompt",
			} as ExtensionContext;
			await emitEvent(stub, "session_start", { type: "session_start", reason: "new" }, ctx);
			if (role === "commander") {
				await emitEvent(stub, "model_select", { type: "model_select", model, previousModel: undefined, source: "set" }, ctx);
			}
			const cacheStatus = stub.commands.get("q-cache-status") as { handler: (args: string, context: ExtensionCommandContext) => Promise<void> };
			await cacheStatus.handler("", ctx as ExtensionCommandContext);

			const projected = await emitContext(stub, [
				{ role: "user", content: `ordinary-${role}`, timestamp: 1 } as unknown as AgentMessage,
			], ctx);
			await emitBeforeProviderRequest(stub, {
				model: model.id,
				messages: [{ role: "system", content: "stable numeric correlation prompt" }, { role: "user", content: `ordinary-${role}` }],
			}, ctx);
			await emitMessageEnd(stub, {
				role: "assistant", content: [], provider: model.provider, model: model.id, api: model.api,
				usage: { input: 10, output: 2, cacheRead: 20, cacheWrite: 0, totalTokens: 32, cost: { total: 0 } },
				stopReason: "stop", timestamp: 2,
			}, ctx);
			assert.equal(projected.length, 1);
			const telemetryPath = join(root, CONFIG_DIR_NAME, "workbench", "cache", "telemetry.jsonl");
			const records = (await readFile(telemetryPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
			const record = records.at(-1)!;
			assert.equal(record.schemaVersion, "1.3");
			assert.equal(record.actorRoleCode, actorRoleCode, role);
			assert.equal(record.requestCorrelationCode, 1, role);
			const anatomy = record.historyProjection as Record<string, unknown>;
			assert.equal(anatomy.contextSerial, 1, role);
			assert.equal(anatomy.eventCode, 0, role);
			assert.equal(anatomy.causeCode, 0, role);
			assert.equal(Object.values(anatomy).every((value) => typeof value === "number"), true, role);
			assert.doesNotMatch(JSON.stringify(record), new RegExp(`ordinary-${role}|stable numeric correlation prompt`));
		});
	}
});

test("runtime context correlation fails closed for multiple contexts and retains the controller's fixed-failure anatomy", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(root, "project.yaml", "name: context-correlation-failure\nprofile: generic\n");
		const stub = makeRoleRuntime("other");
		const base = trustedCtx(root, "context-correlation-failure") as ExtensionContext;
		const model = { provider: "deepseek", id: "deepseek-v4-flash", api: "openai-completions" };
		const ctx = {
			...base,
			model,
			thinkingLevel: "high",
			getSystemPrompt: () => "stable fail-closed prompt",
		} as ExtensionContext;
		await emitEvent(stub, "session_start", { type: "session_start", reason: "new" }, ctx);
		const cacheStatus = stub.commands.get("q-cache-status") as { handler: (args: string, context: ExtensionCommandContext) => Promise<void> };
		await cacheStatus.handler("", ctx as ExtensionCommandContext);
		const assistant = (timestamp: number) => ({
			role: "assistant", content: [], provider: model.provider, model: model.id, api: model.api,
			usage: { input: 10, output: 2, cacheRead: 20, cacheWrite: 0, totalTokens: 32, cost: { total: 0 } },
			stopReason: "stop", timestamp,
		});
		const observeProvider = async (timestamp: number): Promise<void> => {
			await emitBeforeProviderRequest(stub, { model: model.id, messages: [] }, ctx);
			await emitMessageEnd(stub, assistant(timestamp), ctx);
		};

		await emitContext(stub, [{ role: "user", content: "first", timestamp: 1 } as unknown as AgentMessage], ctx);
		await emitContext(stub, [{ role: "user", content: "second", timestamp: 2 } as unknown as AgentMessage], ctx);
		await observeProvider(3);

		const fixed = await emitContext(stub, [{
			role: "toolResult", toolCallId: "orphan-correlation", toolName: "read",
			content: [{ type: "text", text: "HOSTILE-CONTEXT-TEXT" }], isError: false, timestamp: 4,
		} as unknown as AgentMessage], ctx);
		assert.equal(validateContextToolPairing(fixed), true);
		await observeProvider(5);

		const telemetryPath = join(root, CONFIG_DIR_NAME, "workbench", "cache", "telemetry.jsonl");
		const records = (await readFile(telemetryPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		const multiple = records.at(-2)!;
		assert.equal(multiple.requestCorrelationCode, 2);
		assert.equal(multiple.actorRoleCode, 0);
		assert.equal(multiple.historyProjection, null);
		const failure = records.at(-1)!;
		assert.equal(failure.requestCorrelationCode, 1);
		assert.equal(failure.actorRoleCode, 0);
		assert.equal((failure.historyProjection as Record<string, unknown>).eventCode, 5);
		assert.equal((failure.historyProjection as Record<string, unknown>).causeCode, 8);
		assert.doesNotMatch(JSON.stringify(records), /HOSTILE-CONTEXT-TEXT|stable fail-closed prompt/);
	});
});
