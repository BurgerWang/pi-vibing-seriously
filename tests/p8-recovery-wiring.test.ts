/**
 * P8b tool-result recovery WIRING tests — through the ACTUALLY REGISTERED
 * extension stub/event lifecycle (tests/p5-state-recovery.test.ts +
 * tests/result-summary-wiring.test.ts pattern), with the real registered
 * tools and the real two-phase receipt core.
 *
 * The lifecycle is simulated exactly like Pi 0.83 middleware: the
 * registered `tool_call` guard handlers run BEFORE the tool executes (their
 * return controls blocking), the registered tool `execute` runs, then the
 * registered `tool_result` handlers run BEFORE `tool_execution_end`/final
 * result delivery.
 *
 * Coverage (delegated slice requirements):
 *   - started receipt exists BEFORE the underlying execute runs; the
 *     finalized receipt exists BEFORE the simulated external delivery
 *     (tool_execution_end) — begin completes before execution, finalize
 *     completes before the external final result;
 *   - a fresh runtime / resume with the SAME native session id recovers by
 *     the original toolCallId AND by result_id; a same-id replay is blocked
 *     BEFORE the recipe executes (counter proves no duplicate execution)
 *     and the block reason contains no duplicate full original inline
 *     output (only the durable result id + recover instruction);
 *   - recovered output is persisted, bounded and truncated (byte/line caps
 *     + omission marker) and the render stays within the global render
 *     caps with the fixed non-acceptance disclaimer;
 *   - incomplete / missing / malformed / corrupt / conflict fail closed
 *     with the fixed recovery codes; begin storage failure blocks BEFORE
 *     execute; finalization failure exposes unavailable metadata and
 *     leaves the started receipt incomplete;
 *   - distinct parallel calls work; the recovery tool itself is never
 *     receipted; exact-one params (both/neither → invalid);
 *   - receipts never alter run/cache/gate/delegation artifacts or
 *     execution counts (no custom entries, single run record, no
 *     delegations/cache artifacts, counter unchanged by the replay);
 *   - legacy no-receipt sessions (absent/invalid native session identity)
 *     fail closed for both the guard and recovery by tool_call_id.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { DEFAULT_RESULT_MAX_BYTES, DEFAULT_RESULT_MAX_LINES, DETAILS_MAX_BYTES, MAX_TOOL_CALLS_PER_TURN } from "../extensions/workbench-runtime/core/output-policy.ts";
import {
	RECOVERY_TOOL_NAME,
	WORKBENCH_RECEIPT_FREE_TOOL_NAMES,
	workbenchToolRequiresReceipt,
} from "../extensions/workbench-runtime/core/tool-catalog.ts";
import { TURN_CALL_LIMIT_CONTROL_TEXT } from "../extensions/workbench-runtime/core/turn-output-budget.ts";
import {
	deriveResultId,
	MAX_IN_FLIGHT_RECEIPTS,
	MAX_SESSION_IDENTITY_CHARS,
	MAX_TOOL_CALL_ID_CHARS,
	OMISSION_MARKER,
	RECEIPT_DISCLAIMER,
	RENDER_MAX_BYTES,
	RENDER_MAX_LINES,
	RESULT_ID_RE,
	SUMMARY_MAX_BYTES,
	SUMMARY_MAX_LINES,
	toolResultsDir,
} from "../extensions/workbench-runtime/core/tool-result-recovery.ts";
import { WORKER_ALLOWED_PATHS_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ROLE_ENV } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { WORKER_SPEND_PROFILE_ENV } from "../extensions/workbench-runtime/core/worker-spend.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

// ------------------------------------------------------------------ stubs

interface StubAPI {
	commands: Map<string, unknown>;
	tools: Map<string, unknown>;
	events: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	entries: Array<{ type: string; customType: string; data?: unknown }>;
	messages: Array<{ customType: string; content: string; display: boolean; options?: unknown }>;
	activeTools: string[];
}

function makeStub(): StubAPI & ExtensionAPI {
	const stub: StubAPI & ExtensionAPI = {
		commands: new Map(),
		tools: new Map(),
		events: new Map(),
		entries: [],
		messages: [],
		activeTools: [],
		registerCommand: (name: string, def: unknown) => {
			stub.commands.set(name, def);
		},
		registerTool: (def: { name: string }) => {
			stub.tools.set(def.name, def);
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = stub.events.get(event) ?? [];
			list.push(handler);
			stub.events.set(event, list);
		},
		appendEntry: (customType: string, data: unknown) => {
			stub.entries.push({ type: "custom", customType, data });
		},
		sendMessage: () => {},
		sendUserMessage: () => {},
		setActiveTools: (tools: string[]) => {
			stub.activeTools = [...tools];
		},
		getActiveTools: () => stub.activeTools,
		getAllTools: () => [...stub.tools.values()] as never[],
		getThinkingLevel: () => "high" as never,
		exec: spawnExec,
	} as unknown as StubAPI & ExtensionAPI;
	return stub;
}

/** Trusted temp-project ctx with a CONTROLLABLE native session identity. */
function trustedCtx(root: string, sessionId: string): ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => `${root}/session.jsonl`,
			getSessionId: () => sessionId,
		} as unknown as ExtensionContext["sessionManager"],
		model: undefined,
		thinkingLevel: undefined,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => false,
		} as unknown as ExtensionContext["ui"],
		signal: undefined,
	} as unknown as ExtensionCommandContext;
}

interface ToolDef {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

interface GuardResult {
	block?: boolean;
	reason?: string;
}

/** Run every registered tool_call handler in registration order (Pi semantics). */
async function emitToolCall(stub: StubAPI & ExtensionAPI, ctx: ExtensionContext, event: unknown): Promise<GuardResult> {
	let result: GuardResult = {};
	for (const handler of stub.events.get("tool_call") ?? []) {
		const r = (await handler(event, ctx)) as GuardResult | undefined;
		if (r !== undefined) result = r;
	}
	return result;
}

interface ToolResultPatch {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
	usage?: unknown;
}

/** Run every registered tool_result handler with Pi's SAME-event chaining semantics. */
async function emitToolResult(stub: StubAPI & ExtensionAPI, event: ToolResultEvent): Promise<ToolResultPatch | undefined> {
	const currentEvent: ToolResultEvent & { usage?: unknown } = { ...event };
	let modified = false;
	for (const handler of stub.events.get("tool_result") ?? []) {
		const r = (await handler(currentEvent, undefined)) as ToolResultPatch | undefined;
		if (!r) continue;
		if (r.content !== undefined) { currentEvent.content = r.content; modified = true; }
		if (r.details !== undefined) { currentEvent.details = r.details; modified = true; }
		if (r.isError !== undefined) { currentEvent.isError = r.isError; modified = true; }
		if (r.usage !== undefined) { currentEvent.usage = r.usage; modified = true; }
	}
	return modified
		? { content: currentEvent.content, details: currentEvent.details, isError: currentEvent.isError, usage: currentEvent.usage }
		: undefined;
}

interface ToolResultEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
	isError: boolean;
	details?: unknown;
}

function resultEvent(toolCallId: string, toolName: string, text: string, details: unknown, isError = false): ToolResultEvent {
	return { type: "tool_result", toolCallId, toolName, input: {}, content: [{ type: "text", text }], isError, details };
}

/** UTF-8 byte length of the ACTUAL emitted text. */
function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

function receiptsDir(root: string): string {
	return join(root, CONFIG_DIR_NAME, "workbench", "tool-results");
}

async function receiptFiles(root: string, id: string): Promise<string[]> {
	try {
		const names = await readdir(receiptsDir(root));
		return names.filter((n) => n.startsWith(id));
	} catch {
		return [];
	}
}

before(() => {
	// Commander tests must never inherit a worker-role env from the harness.
	delete process.env[WORKER_ROLE_ENV];
	delete process.env[WORKER_PROJECT_ROOT_ENV];
	delete process.env[WORKER_ALLOWED_PATHS_ENV];
	delete process.env[WORKER_SPEND_PROFILE_ENV];
});

// --------------------------------------------------------------- fixtures

const SESSION = "p8b-wiring-session-0001";
const TICK_RECIPES = 'recipes:\n  - name: tick\n    command: ["node", "tick.js"]\n';
const TICK_JS = [
	'const fs = require("node:fs");',
	'const path = require("node:path");',
	'const f = path.join(__dirname, "counter.txt");',
	"const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, \"utf8\")) : 0) + 1;",
	'fs.writeFileSync(f, String(n));',
	'console.log("TICK-OUTPUT-MARKER-99 tick " + n);',
].join("\n");

async function setupProject(root: string, recipesYaml?: string): Promise<void> {
	await writeConfigFile(root, "project.yaml", "name: p8b-wiring-test\nprofile: generic\n");
	if (recipesYaml !== undefined) await writeConfigFile(root, "recipes.yaml", recipesYaml);
}

async function tickCount(root: string): Promise<number> {
	try {
		return Number(await readFile(join(root, "counter.txt"), "utf8"));
	} catch {
		return 0;
	}
}

// --------------------------------------------------------------------------
// 1. Begin-before-execute + finalize-before-external-delivery + replay block
// --------------------------------------------------------------------------

test("P8b lifecycle: started receipt exists before execute; finalized before external delivery; same-id replay blocked with no duplicate output", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, TICK_RECIPES);
		await writeFile(join(root, "tick.js"), TICK_JS, "utf8");

		// ---- runtime A: full lifecycle
		const stubA = makeStub();
		workbenchRuntime(stubA);
		const ctxA = trustedCtx(root, SESSION);
		const recipeTool = stubA.tools.get("workbench_run_recipe") as unknown as ToolDef;
		assert.ok(recipeTool, "workbench_run_recipe registered");

		const callId = "call-tick-1";
		const guardA = await emitToolCall(stubA, ctxA, {
			type: "tool_call",
			toolCallId: callId,
			toolName: "workbench_run_recipe",
			input: { recipe: "tick" },
		});
		assert.equal(guardA.block, undefined, "first call is not blocked");

		// The started receipt exists BEFORE the underlying execute runs, and
		// the recipe has NOT executed yet.
		const idA = deriveResultId(SESSION, callId);
		assert.match(idA, RESULT_ID_RE);
		assert.deepEqual(await receiptFiles(root, idA), [`${idA}.started`], "started receipt exists before execute");
		assert.equal(await tickCount(root), 0, "recipe not executed yet");

		const resultA = await recipeTool.execute(callId, { recipe: "tick" }, undefined, undefined, ctxA as never);
		assert.equal(await tickCount(root), 1, "recipe executed exactly once");

		// Finalize happens in the tool_result handler — the finalized receipt
		// must exist BEFORE the simulated external delivery (tool_execution_end).
		const mergedA = await emitToolResult(stubA, resultEvent(callId, "workbench_run_recipe", toolText(resultA), resultA.details));
		assert.ok(mergedA?.details, "tool_result middleware merged details");
		const receiptMeta = (mergedA?.details as Record<string, unknown>).receipt as Record<string, unknown>;
		assert.equal(receiptMeta.available, true, "success merges available: true");
		assert.equal(receiptMeta.result_id, idA);
		assert.equal(receiptMeta.status, "success");
		assert.ok(String(receiptMeta.path).startsWith(".pi/workbench/tool-results/"), "project-relative receipt path");
		assert.deepEqual((await receiptFiles(root, idA)).sort(), [`${idA}.json`, `${idA}.started`], "finalized before external delivery");

		// Simulated external delivery sees the ALREADY merged details.
		const endHandlers = stubA.events.get("tool_execution_end") ?? [];
		for (const h of endHandlers) {
			await h({ type: "tool_execution_end", toolCallId: callId, toolName: "workbench_run_recipe", result: { details: mergedA?.details }, isError: false }, ctxA);
		}

		// The original full inline output never enters the receipt: the
		// receipt summary is a bounded redacted presentation, not raw output.
		const finalized = JSON.parse(await readFile(join(receiptsDir(root), `${idA}.json`), "utf8")) as { summary: string; tool: string; input_hash: string };
		assert.ok(!finalized.summary.includes("TICK-OUTPUT-MARKER-99"), "receipt never persists raw inline output");
		assert.equal(finalized.tool, "workbench_run_recipe");
		assert.match(finalized.input_hash, /^[0-9a-f]{64}$/, "canonical input hash only");

		// ---- runtime B: fresh runtime / resume with the SAME native session id
		const stubB = makeStub();
		workbenchRuntime(stubB);
		const ctxB = trustedCtx(root, SESSION);
		const guardB = await emitToolCall(stubB, ctxB, {
			type: "tool_call",
			toolCallId: callId,
			toolName: "workbench_run_recipe",
			input: { recipe: "tick" },
		});
		assert.equal(guardB.block, true, "same-id replay is blocked before execution");
		assert.ok(guardB.reason, "block carries a reason");
		assert.ok(guardB.reason!.includes(idA), "reason contains the durable result id");
		assert.match(guardB.reason!, /workbench_recover_tool_result/, "reason instructs recovery");
		assert.ok(!guardB.reason!.includes("TICK-OUTPUT-MARKER-99"), "block reason contains no duplicate full original inline output");
		assert.equal(await tickCount(root), 1, "replay did NOT re-execute the recipe (counter unchanged)");

		// Recovery by the original toolCallId (current-session derivation).
		const recoverTool = stubB.tools.get(RECOVERY_TOOL_NAME) as unknown as ToolDef;
		assert.ok(recoverTool, "recovery tool registered");
		const byCall = await recoverTool.execute("call-recover-1", { tool_call_id: callId }, undefined, undefined, ctxB as never);
		const callText = toolText(byCall);
		assert.ok(byCall.details, "recovery details present");
		assert.equal((byCall.details as Record<string, unknown>).available, true);
		assert.equal((byCall.details as Record<string, unknown>).result_id, idA);
		assert.ok(callText.startsWith("tool-result receipt (schema wtr1)"), "bounded renderer");
		assert.ok(callText.includes(RECEIPT_DISCLAIMER), "persisted summary labeled non-acceptance evidence");
		assert.ok(!callText.includes("TICK-OUTPUT-MARKER-99"), "recovery never re-inlines the original output");

		// Recovery by the durable result_id.
		const byId = await recoverTool.execute("call-recover-2", { result_id: idA }, undefined, undefined, ctxB as never);
		assert.equal((byId.details as Record<string, unknown>).result_id, idA);
		assert.equal(toolText(byId), callText, "deterministic recovery by either identity");

		// Receipts never altered the run record or execution counts.
		const runEntries = (await readdir(join(root, CONFIG_DIR_NAME, "workbench", "runs"))).filter((n) => !n.startsWith("."));
		assert.equal(runEntries.length, 1, "exactly one run record (the one real execution)");
	});
});

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((c) => c.text).join("\n");
}

// --------------------------------------------------------------------------
// 2. Persisted / bounded / truncated recovery output
// --------------------------------------------------------------------------

test("recovered output is persisted, bounded and truncated (caps + omission marker + render caps)", async () => {
	await withTempDir(async (root) => {
		await setupProject(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const ctx = trustedCtx(root, SESSION);

		const callId = "call-huge-1";
		const guard = await emitToolCall(stub, ctx, {
			type: "tool_call",
			toolCallId: callId,
			toolName: "workbench_run_recipe",
			input: {},
		});
		assert.equal(guard.block, undefined);
		const id = deriveResultId(SESSION, callId);

		// A deliberately HUGE tool result (5000 lines) — the finalize must
		// extract text blocks only, redact, and cap to the summary bounds.
		const huge = Array.from({ length: 5000 }, (_, i) => `line-${i}-${"x".repeat(80)}`).join("\n");
		const merged = await emitToolResult(stub, resultEvent(callId, "workbench_run_recipe", huge, { ok: true }));
		assert.ok(merged?.details, "details merged");
		const boundedText = (merged?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
		assert.ok(utf8Bytes(boundedText) <= DEFAULT_RESULT_MAX_BYTES, "receipt input is the final per-tool bounded content");
		assert.ok(boundedText.split("\n").length <= DEFAULT_RESULT_MAX_LINES, "receipt input respects the final line cap");
		assert.ok(!boundedText.includes("line-4999"), "raw tail is removed before receipt finalization");
		const envelopeFacts = (merged.details as Record<string, unknown>).output_envelope as Record<string, unknown>;
		assert.equal(envelopeFacts.schema, "workbench-output-v1");
		assert.equal(envelopeFacts.shownTextBytes, utf8Bytes(boundedText));
		assert.equal((merged.details as Record<string, unknown>).receipt && ((merged.details as Record<string, unknown>).receipt as Record<string, unknown>).available, true);
		const finalized = JSON.parse(await readFile(join(receiptsDir(root), `${id}.json`), "utf8")) as {
			summary: string;
			summary_omitted_lines: number;
			summary_omitted_bytes: number;
		};
		assert.ok(utf8Bytes(finalized.summary) <= SUMMARY_MAX_BYTES, `summary bytes ${utf8Bytes(finalized.summary)} <= ${SUMMARY_MAX_BYTES}`);
		assert.ok(finalized.summary.split("\n").length <= SUMMARY_MAX_LINES, `summary lines ${finalized.summary.split("\n").length} <= ${SUMMARY_MAX_LINES}`);
		assert.ok(finalized.summary.endsWith(OMISSION_MARKER), "explicit omission marker when truncated");
		assert.ok(finalized.summary_omitted_lines > 0 && finalized.summary_omitted_bytes > 0, "omission facts recorded");

		// Recovery renders the persisted bounded summary within the global caps.
		const recoverTool = stub.tools.get(RECOVERY_TOOL_NAME) as unknown as ToolDef;
		const recovered = await recoverTool.execute("call-recover-3", { result_id: id }, undefined, undefined, ctx as never);
		const text = toolText(recovered);
		assert.ok(utf8Bytes(text) <= RENDER_MAX_BYTES, `render bytes ${utf8Bytes(text)} <= ${RENDER_MAX_BYTES}`);
		assert.ok(text.split("\n").length <= RENDER_MAX_LINES, `render lines ${text.split("\n").length} <= ${RENDER_MAX_LINES}`);
		assert.ok(text.includes(OMISSION_MARKER), "omission visible in recovery");
		assert.ok(text.includes(RECEIPT_DISCLAIMER), "non-acceptance disclaimer always present");
		assert.ok(!text.includes("line-4999"), "huge raw content never re-inlined");
	});
});

// --------------------------------------------------------------------------
// 3. Fail-closed matrix (missing / incomplete / malformed / corrupt / conflict)
// --------------------------------------------------------------------------

test("recovery fail-closed codes: missing, incomplete, malformed/corrupt, conflict", async () => {
	await withTempDir(async (root) => {
		await setupProject(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const ctx = trustedCtx(root, SESSION);
		const recoverTool = stub.tools.get(RECOVERY_TOOL_NAME) as unknown as ToolDef;

		// missing — a well-formed id with no artifacts.
		const otherId = `wtr1-${"0".repeat(64)}`;
		const missing = await recoverTool.execute("call-m1", { result_id: otherId }, undefined, undefined, ctx as never);
		assert.equal((missing.details as Record<string, unknown>).code, "missing");
		assert.equal((missing.details as Record<string, unknown>).available, false);
		assert.match(toolText(missing), /missing/, "fixed bounded failure line");
		// malformed result_id shape → invalid.
		const badShape = await recoverTool.execute("call-m2", { result_id: "wtr1-xyz" }, undefined, undefined, ctx as never);
		assert.equal((badShape.details as Record<string, unknown>).code, "invalid");

		// incomplete — a started receipt that was never finalized.
		const callInc = "call-incomplete-1";
		await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: callInc, toolName: "workbench_run_recipe", input: {} });
		const idInc = deriveResultId(SESSION, callInc);
		const incomplete = await recoverTool.execute("call-m3", { result_id: idInc }, undefined, undefined, ctx as never);
		assert.equal((incomplete.details as Record<string, unknown>).code, "incomplete");
		assert.equal((incomplete.details as Record<string, unknown>).result_id, idInc);

		// malformed artifact → corrupt.
		const callBad = "call-malformed-1";
		await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: callBad, toolName: "workbench_run_recipe", input: {} });
		const idBad = deriveResultId(SESSION, callBad);
		await writeFile(join(receiptsDir(root), `${idBad}.started`), "not-json{", "utf8");
		const corrupt = await recoverTool.execute("call-m4", { result_id: idBad }, undefined, undefined, ctx as never);
		assert.equal((corrupt.details as Record<string, unknown>).code, "corrupt");

		// conflict — both phases parse but disagree (cross-phase mismatch).
		const callC = "call-conflict-1";
		await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: callC, toolName: "workbench_run_recipe", input: {} });
		const idC = deriveResultId(SESSION, callC);
		const startedRaw = JSON.parse(await readFile(join(receiptsDir(root), `${idC}.started`), "utf8")) as Record<string, unknown>;
		const conflicting = {
			schema: "wtr1",
			schema_version: 1,
			id: idC,
			tool: startedRaw.tool,
			input_hash: startedRaw.input_hash,
			status: "success",
			error: null,
			summary: "conflicting-phase",
			summary_omitted_lines: 0,
			summary_omitted_bytes: 0,
			created_at: new Date(Date.parse(String(startedRaw.created_at)) + 60_000).toISOString(),
			finalized_at: new Date(Date.parse(String(startedRaw.created_at)) + 120_000).toISOString(),
		};
		await writeFile(join(receiptsDir(root), `${idC}.json`), `${JSON.stringify(conflicting, null, 2)}\n`, "utf8");
		const conflict = await recoverTool.execute("call-m5", { result_id: idC }, undefined, undefined, ctx as never);
		assert.equal((conflict.details as Record<string, unknown>).code, "conflict");
	});
});

// --------------------------------------------------------------------------
// 4. Begin storage failure blocks BEFORE execute
// --------------------------------------------------------------------------

test("begin storage failure blocks the tool call BEFORE execute (fail closed)", async () => {
	await withTempDir(async (root) => {
		// Make the config-dir path unusable: `.pi` becomes a regular FILE, so
		// the receipt directory can never be created/contained. No project
		// config is needed — the guard's begin step fails before the tool runs.
		await writeFile(join(root, CONFIG_DIR_NAME), "i am a file", "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const ctx = trustedCtx(root, SESSION);
		const guard = await emitToolCall(stub, ctx, {
			type: "tool_call",
			toolCallId: "call-storage-1",
			toolName: "workbench_run_recipe",
			input: {},
		});
		assert.equal(guard.block, true, "storage failure blocks before execute");
		assert.match(guard.reason ?? "", /storage unavailable/, "fixed storage block reason");
		// The underlying tool never ran: no receipt dir could exist and the
		// registered execute is only ever called by the harness after a
		// non-blocking guard — here it is never called.
		assert.equal(await tickCount(root), 0);
	});
});

// --------------------------------------------------------------------------
// 5. Finalization failure exposes unavailable metadata and leaves incomplete
// --------------------------------------------------------------------------

test("finalization failure: unavailable metadata merged, started receipt left incomplete", async () => {
	await withTempDir(async (root) => {
		await setupProject(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const ctx = trustedCtx(root, SESSION);
		const callId = "call-finalize-fail-1";
		await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: callId, toolName: "workbench_run_recipe", input: {} });
		const id = deriveResultId(SESSION, callId);

		// Corrupt the started phase after begin — finalize must fail closed
		// and the started artifact must stay in place (incomplete).
		await writeFile(join(receiptsDir(root), `${id}.started`), "{broken", "utf8");
		const merged = await emitToolResult(stub, resultEvent(callId, "workbench_run_recipe", "ok", { ok: true }));
		const projectedDetails = merged?.details as Record<string, unknown>;
		const receiptMeta = projectedDetails.receipt as Record<string, unknown>;
		assert.equal(receiptMeta.available, false, "failure never claims availability");
		assert.equal(receiptMeta.code, "corrupt_started", "bounded unavailable code");
		assert.equal(receiptMeta.result_id, id);
		assert.deepEqual((await receiptFiles(root, id)).sort(), [`${id}.started`], "started receipt left incomplete (never deleted, never finalized)");
		// R6 projects registered tools through their explicit DTO whitelist.
		// `ok` is a run-recipe DTO field, while trusted control-plane facts also
		// survive and the complete persisted details object stays bounded.
		assert.equal(projectedDetails.ok, true, "listed run-recipe domain field survives per-tool DTO");
		assert.equal(Object.hasOwn(projectedDetails, "output_envelope"), true, "trusted envelope preserved");
		assert.equal((projectedDetails.output_envelope as Record<string, unknown>).schema, "workbench-output-v1");
		assert.ok(Buffer.byteLength(JSON.stringify(projectedDetails), "utf8") <= DETAILS_MAX_BYTES, "projected details stay within the session cap");

		const recoverTool = stub.tools.get(RECOVERY_TOOL_NAME) as unknown as ToolDef;
		const recovered = await recoverTool.execute("call-r1", { result_id: id }, undefined, undefined, ctx as never);
		assert.equal((recovered.details as Record<string, unknown>).code, "corrupt", "recovery sees corrupt, never completed");
	});
});

// --------------------------------------------------------------------------
// 6. Distinct parallel calls
// --------------------------------------------------------------------------

test("distinct parallel tool calls each get their own receipt lifecycle", async () => {
	await withTempDir(async (root) => {
		await setupProject(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const ctx = trustedCtx(root, SESSION);
		const recoverTool = stub.tools.get(RECOVERY_TOOL_NAME) as unknown as ToolDef;

		const calls = ["call-para-a", "call-para-b", "call-para-c"];
		for (const callId of calls) {
			const guard = await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: callId, toolName: "workbench_run_recipe", input: {} });
			assert.equal(guard.block, undefined, callId);
		}
		for (const callId of calls) {
			const merged = await emitToolResult(stub, resultEvent(callId, "workbench_run_recipe", `result of ${callId}`, { ok: true }));
			assert.ok(merged, `tool_result middleware merged details for ${callId}`);
			assert.ok(merged.details, `details present for ${callId}`);
			const receiptMeta = (merged.details as Record<string, unknown>).receipt as Record<string, unknown>;
			assert.equal(receiptMeta.available, true, callId);
		}
		const ids = calls.map((callId) => deriveResultId(SESSION, callId));
		assert.equal(new Set(ids).size, calls.length, "distinct ids");
		for (const id of ids) {
			assert.deepEqual((await receiptFiles(root, id)).sort(), [`${id}.json`, `${id}.started`], id);
			const recovered = await recoverTool.execute("call-r2", { result_id: id }, undefined, undefined, ctx as never);
			assert.equal((recovered.details as Record<string, unknown>).available, true, id);
		}
	});
});

// --------------------------------------------------------------------------
// 7. Replay-safe reads are never receipted
// --------------------------------------------------------------------------

test("inspect/read/list/status/compare/recover are zero-receipt while side-effecting tools remain protected", async () => {
	await withTempDir(async (root) => {
		await setupProject(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const ctx = trustedCtx(root, SESSION);

		for (const [index, toolName] of WORKBENCH_RECEIPT_FREE_TOOL_NAMES.entries()) {
			assert.equal(workbenchToolRequiresReceipt(toolName), false, toolName);
			const toolCallId = `call-read-free-${index}`;
			const guard = await emitToolCall(stub, ctx, {
				type: "tool_call", toolCallId, toolName, input: {},
			});
			assert.equal(guard.block, undefined, toolName);
			assert.deepEqual(await receiptFiles(root, deriveResultId(SESSION, toolCallId)), [], toolName);
			const merged = await emitToolResult(stub, resultEvent(toolCallId, toolName, "bounded read result", { ok: true }));
			assert.equal(Object.hasOwn((merged?.details ?? {}) as Record<string, unknown>, "receipt"), false, toolName);
		}

		for (const toolName of [
			"workbench_run_recipe",
			"workbench_run_gate",
			"workbench_delegate_worker",
			"workbench_review_worker_diff",
		]) {
			assert.equal(workbenchToolRequiresReceipt(toolName), true, toolName);
		}
	});
});

// --------------------------------------------------------------------------
// 8. Recovery tool itself is never receipted; exact-one params
// --------------------------------------------------------------------------

test("recovery tool is never receipted and enforces EXACTLY ONE id source", async () => {
	await withTempDir(async (root) => {
		await setupProject(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const ctx = trustedCtx(root, SESSION);
		const recoverTool = stub.tools.get(RECOVERY_TOOL_NAME) as unknown as ToolDef;

		// A recovery-tool call passes the guard and creates NO receipt.
		const guard = await emitToolCall(stub, ctx, {
			type: "tool_call",
			toolCallId: "call-recover-self-1",
			toolName: RECOVERY_TOOL_NAME,
			input: { result_id: `wtr1-${"1".repeat(64)}` },
		});
		assert.equal(guard.block, undefined, "recovery tool is never blocked by the begin step");
		assert.deepEqual(await receiptFiles(root, deriveResultId(SESSION, "call-recover-self-1")), [], "recovery tool never receipts itself");

		// Exact-one: both → invalid; neither → invalid.
		const both = await recoverTool.execute("call-x1", { result_id: `wtr1-${"1".repeat(64)}`, tool_call_id: "call-anything" }, undefined, undefined, ctx as never);
		assert.equal((both.details as Record<string, unknown>).code, "invalid");
		const neither = await recoverTool.execute("call-x2", {}, undefined, undefined, ctx as never);
		assert.equal((neither.details as Record<string, unknown>).code, "invalid");
		assert.match(toolText(neither), /exactly one/, "fixed invalid explanation");

		// A valid single-source call still works after the invalid ones.
		const ok = await recoverTool.execute("call-x3", { result_id: `wtr1-${"0".repeat(64)}` }, undefined, undefined, ctx as never);
		assert.equal((ok.details as Record<string, unknown>).code, "missing", "well-formed single source reaches the receipt store");
	});
});

// --------------------------------------------------------------------------
// 9. Receipts never alter run/cache/gate/delegation artifacts or counts
// --------------------------------------------------------------------------

test("receipt lifecycle alters no run/cache/gate/delegation artifacts and no execution counts", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, TICK_RECIPES);
		await writeFile(join(root, "tick.js"), TICK_JS, "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const ctx = trustedCtx(root, SESSION);

		const callId = "call-neutral-1";
		await emitToolCall(stub, ctx, { type: "tool_call", toolCallId: callId, toolName: "workbench_run_recipe", input: { recipe: "tick" } });
		const recipeTool = stub.tools.get("workbench_run_recipe") as unknown as ToolDef;
		const result = await recipeTool.execute(callId, { recipe: "tick" }, undefined, undefined, ctx as never);
		await emitToolResult(stub, resultEvent(callId, "workbench_run_recipe", toolText(result), result.details));

		// Execution counts: exactly one tick; no custom session entries were
		// ever appended by the receipt lifecycle (begin/finalize are disk-only).
		assert.equal(await tickCount(root), 1, "exactly one execution");
		assert.equal(stub.entries.length, 0, "receipt lifecycle appends no session entries");

		// Run artifacts: exactly the single run record — receipts never touch
		// the run directory content.
		const runsDir = join(root, CONFIG_DIR_NAME, "workbench", "runs");
		const runEntries = (await readdir(runsDir)).filter((n) => !n.startsWith("."));
		assert.equal(runEntries.length, 1, "exactly one run record");
		const manifest = JSON.parse(await readFile(join(runsDir, runEntries[0]!, "manifest.json"), "utf8")) as { recipe: string; exit_code: number };
		assert.equal(manifest.recipe, "tick");
		assert.equal(manifest.exit_code, 0);

		// No cache / delegation / gate artifacts were created by the lifecycle.
		const workbenchDir = join(root, CONFIG_DIR_NAME, "workbench");
		for (const name of ["cache", "delegations"]) {
			await stat(join(workbenchDir, name)).then(
				() => assert.fail(`${name} must not exist`),
				() => {},
			);
		}
		// The receipts themselves are the ONLY extra files (2 per receipt).
		const all = await readdir(receiptsDir(root));
		assert.equal(all.filter((n) => !n.startsWith(".")).length, 2, "only the two receipt phases exist");
	});
});

// --------------------------------------------------------------------------
// 9. Legacy no-receipt sessions fail closed
// --------------------------------------------------------------------------

test("legacy no-receipt sessions (absent native session identity) fail closed", async () => {
	await withTempDir(async (root) => {
		await setupProject(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const legacyCtx = trustedCtx(root, ""); // no valid native session identity

		// The guard fails closed: no receipt identity → workbench tools block.
		const guard = await emitToolCall(stub, legacyCtx, {
			type: "tool_call",
			toolCallId: "call-legacy-1",
			toolName: "workbench_run_recipe",
			input: {},
		});
		assert.equal(guard.block, true, "legacy session blocks before execute");
		assert.match(guard.reason ?? "", /receipt identity unavailable/, "fixed invalid-identity block reason");

		// Recovery by tool_call_id also fails closed (no session identity to
		// derive from) — and nothing was ever persisted.
		const recoverTool = stub.tools.get(RECOVERY_TOOL_NAME) as unknown as ToolDef;
		const recovered = await recoverTool.execute("call-legacy-r1", { tool_call_id: "call-legacy-1" }, undefined, undefined, legacyCtx as never);
		assert.equal((recovered.details as Record<string, unknown>).code, "invalid", "recovery by tool_call_id fails closed in legacy sessions");
		assert.equal((recovered.details as Record<string, unknown>).available, false);
	});
});

// --------------------------------------------------------------------------
// 10. Recovery by tool_call_id validates the CURRENT session identity first
// --------------------------------------------------------------------------

test("recovery by tool_call_id validates the current session identity before any hash", async () => {
	await withTempDir(async (root) => {
		await setupProject(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const recoverTool = stub.tools.get(RECOVERY_TOOL_NAME) as unknown as ToolDef;

		// Missing / control-char / over-bound CURRENT native session
		// identities fail closed with the fixed invalid code (nothing is
		// ever hashed or persisted).
		const invalidSessions: Array<[string, string]> = [
			["missing", ""],
			["control-char", "bad\u0007session"],
			["over-bound", "s".repeat(MAX_SESSION_IDENTITY_CHARS + 1)],
		];
		for (const [label, sessionId] of invalidSessions) {
			const ctx = trustedCtx(root, sessionId);
			const recovered = await recoverTool.execute("call-ident-1", { tool_call_id: "call-anything" }, undefined, undefined, ctx as never);
			assert.deepEqual(recovered.details, { ok: false, available: false, code: "invalid" }, `session ${label}`);
			assert.match(toolText(recovered), /invalid/, `fixed bounded failure line for session ${label}`);
		}

		// Control-char / over-bound tool_call_id parameters fail closed the
		// same way in a valid session.
		const ctx = trustedCtx(root, SESSION);
		for (const toolCallId of ["call\u001fid", "c".repeat(MAX_TOOL_CALL_ID_CHARS + 1)]) {
			const recovered = await recoverTool.execute("call-ident-2", { tool_call_id: toolCallId }, undefined, undefined, ctx as never);
			assert.deepEqual(recovered.details, { ok: false, available: false, code: "invalid" }, `tool_call_id length ${toolCallId.length}`);
		}

		// The invalid identities never derived an id and never persisted
		// anything: no receipt artifacts exist in this project.
		assert.deepEqual(await receiptFiles(root, "wtr1-"), [], "invalid identities hash nothing");
	});
});

// --------------------------------------------------------------------------
// 11. tool_result tool-name mismatch never finalizes
// --------------------------------------------------------------------------

test("tool_result tool-name mismatch never finalizes: started stays incomplete, handle consumed", async () => {
	await withTempDir(async (root) => {
		await setupProject(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const ctx = trustedCtx(root, SESSION);

		const callId = "call-name-mismatch-1";
		const guard = await emitToolCall(stub, ctx, {
			type: "tool_call",
			toolCallId: callId,
			toolName: "workbench_run_recipe",
			input: {},
		});
		assert.equal(guard.block, undefined, "call begins normally");
		const id = deriveResultId(SESSION, callId);
		assert.deepEqual(await receiptFiles(root, id), [`${id}.started`], "started receipt exists");

		// A tool_result for a DIFFERENT tool name with the SAME toolCallId
		// never finalizes: only the bounded mismatch fact is merged.
		const mismatched = await emitToolResult(stub, resultEvent(callId, "workbench_project_inspect", "wrong-tool result text", { ok: true }));
		assert.ok(mismatched?.details, "details merged for the mismatch");
		const receiptMeta = (mismatched.details as Record<string, unknown>).receipt as Record<string, unknown>;
		assert.equal(receiptMeta.available, false, "mismatch never claims availability");
		assert.equal(receiptMeta.code, "tool_name_mismatch", "bounded mismatch code");
		assert.equal(receiptMeta.result_id, id);
		assert.equal(receiptMeta.tool, "workbench_run_recipe", "mismatch fact names the begun tool");
		assert.deepEqual(await receiptFiles(root, id), [`${id}.started`], "no finalized JSON — started stays incomplete");
		assert.equal(Object.hasOwn(mismatched.details as Record<string, unknown>, "ok"), false,
			"mismatched project-inspect projection does not invent run-recipe domain details");

		// The in-memory handle was consumed: a later tool_result with the
		// CORRECT name finds no pending handle and finalizes nothing. The
		// global envelope/details handlers still run for every result.
		const later = await emitToolResult(stub, resultEvent(callId, "workbench_run_recipe", "real result text", { ok: true }));
		assert.ok(later?.details, "global output-control middleware still projects details");
		assert.equal(Object.hasOwn(later.details as Record<string, unknown>, "receipt"), false, "consumed handle produces no new receipt metadata");
		assert.equal(((later.details as Record<string, unknown>).output_envelope as Record<string, unknown>).schema, "workbench-output-v1");
		assert.deepEqual(await receiptFiles(root, id), [`${id}.started`], "still no finalized JSON after the corrected result");

		// Recovery sees the incomplete receipt — never completed.
		const recoverTool = stub.tools.get(RECOVERY_TOOL_NAME) as unknown as ToolDef;
		const recovered = await recoverTool.execute("call-r3", { result_id: id }, undefined, undefined, ctx as never);
		assert.equal((recovered.details as Record<string, unknown>).code, "incomplete", "receipt stays recoverable as incomplete");
	});
});

// --------------------------------------------------------------------------
// 12. Capacity reachability: the per-turn call limit is the tighter bound
// --------------------------------------------------------------------------

test("capacity: the 16-call turn limit prevents an unreachable full map and never evicts admitted handles", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, TICK_RECIPES);
		await writeFile(join(root, "tick.js"), TICK_JS, "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const ctx = trustedCtx(root, SESSION);

		// A real turn clears the pending map at its boundary. Because turn_end
		// clears it again and the hard per-turn call limit is smaller than the
		// receipt-core capacity, a full runtime map is deliberately unreachable.
		assert.ok(MAX_TOOL_CALLS_PER_TURN < MAX_IN_FLIGHT_RECEIPTS, "turn budget is the tighter runtime bound");
		for (const handler of stub.events.get("turn_start") ?? []) {
			await handler({ type: "turn_start", turnIndex: 0, timestamp: 1 }, ctx);
		}

		// Admit every call reachable in this turn without completing its result,
		// leaving all sixteen receipt handles pending simultaneously.
		const fillIds: string[] = [];
		for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN; i++) {
			const callId = `call-cap-fill-${i}`;
			const guard = await emitToolCall(stub, ctx, {
				type: "tool_call",
				toolCallId: callId,
				toolName: "workbench_run_recipe",
				input: {},
			});
			assert.equal(guard.block, undefined, callId);
			assert.deepEqual(await receiptFiles(root, deriveResultId(SESSION, callId)), [`${deriveResultId(SESSION, callId)}.started`], `${callId} remains pending`);
			fillIds.push(callId);
		}
		assert.equal(await tickCount(root), 0, "nothing executed yet");

		// The next registered workbench call is blocked by the hard turn budget
		// before receipt capacity is consulted, beginReceipt runs, or execution.
		const excessCallId = "call-cap-excess-1";
		const excessGuard = await emitToolCall(stub, ctx, {
			type: "tool_call",
			toolCallId: excessCallId,
			toolName: "workbench_run_recipe",
			input: { recipe: "tick" },
		});
		assert.equal(excessGuard.block, true, "excess call is blocked");
		assert.equal(excessGuard.reason, TURN_CALL_LIMIT_CONTROL_TEXT, "fixed bounded turn-call-limit reason");
		assert.deepEqual(await receiptFiles(root, deriveResultId(SESSION, excessCallId)), [], "excess call has NO receipt (blocked before begin)");
		assert.equal(await tickCount(root), 0, "excess call did not execute");

		// Capacity was not used as an eviction mechanism: every admitted handle
		// is retained and can still finalize successfully.
		for (const callId of fillIds) {
			const merged = await emitToolResult(stub, resultEvent(callId, "workbench_run_recipe", `result of ${callId}`, { ok: true }));
			assert.ok(merged, `details merged for ${callId}`);
			assert.ok(merged.details, `details present for ${callId}`);
			const receiptMeta = (merged.details as Record<string, unknown>).receipt as Record<string, unknown>;
			assert.equal(receiptMeta.available, true, callId);
		}
	});
});
