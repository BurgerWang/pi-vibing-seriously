/** R2 final-envelope, receipt-ordering and persistence fail-safe wiring. */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { before, test } from "node:test";

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

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { COMPARISON_PERSIST_ERROR } from "../extensions/workbench-runtime/core/comparison-record.ts";
import { runsDir, workbenchDir } from "../extensions/workbench-runtime/core/config.ts";
import {
	COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
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
import { TURN_CALL_LIMIT_CONTROL_TEXT } from "../extensions/workbench-runtime/core/turn-output-budget.ts";
import { COMPARE_SUMMARY_MAX_BYTES, COMPARE_SUMMARY_MAX_LINES } from "../extensions/workbench-runtime/core/render.ts";
import { deriveResultId } from "../extensions/workbench-runtime/core/tool-result-recovery.ts";
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
	assert.match(handler, /historyProjectionFailureMessages\(\s*event\.messages,\s*maxToolTextBytes,\s*HISTORY_DESCRIPTOR_MAX_BYTES/);
	assert.doesNotMatch(handler, /appendEntry|sessionManager|getEntries|event\.messages\s*=/);
});

test("context success and fail-closed projections update latest numeric history telemetry", async () => {
	const stub = makeRoleRuntime("other");
	const ctx = trustedCtx(process.cwd(), "history-telemetry") as ExtensionContext;
	await emitEvent(stub, "turn_start", { type: "turn_start", turnIndex: 41, timestamp: 1 }, ctx);
	const paired: AgentMessage[] = [
		{ role: "assistant", content: [{ type: "toolCall", id: "history-ok", name: "read", arguments: {} }], timestamp: 1 } as unknown as AgentMessage,
		{ role: "toolResult", toolCallId: "history-ok", toolName: "read", content: [{ type: "text", text: "x".repeat(80 * 1_024) }], isError: false, timestamp: 2 } as unknown as AgentMessage,
	];
	const success = await emitContext(stub, paired, ctx);
	assert.ok(historyToolTextBytes(success) <= OTHER_HISTORY_TOOL_TEXT_MAX_BYTES);
	const failed = await emitContext(stub, [
		{ role: "toolResult", toolCallId: "orphan", toolName: "read", content: [{ type: "text", text: "orphan" }], isError: false, timestamp: 3 } as unknown as AgentMessage,
	], ctx);
	assert.equal(validateContextToolPairing(failed), true);
	await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex: 41, message: {}, toolResults: [] }, ctx);
	const entry = [...stub.appendedEntries].reverse().find((item) => item.customType === OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE);
	const snapshot = parseOutputControlTelemetry(entry?.data);
	assert.ok(snapshot);
	assert.ok(snapshot.totals.historyCollapsedResults >= 2, "both bounded success and fail-closed history observations are counted");
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
			const details = final.details as Record<string, unknown>;
			const envelope = details.output_envelope as Record<string, unknown>;
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
