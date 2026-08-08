/**
 * P1 recipe/gate parent-result summary WIRING tests (commander-token-
 * optimization plan §8) — integration-style, through the ACTUALLY
 * REGISTERED workbench runtime surfaces (model tools AND slash commands).
 *
 * The pure builder unit tests live in tests/result-summary.test.ts. This
 * file proves the REGISTERED surfaces use the bounded builders from
 * core/result-summary.ts:
 *
 *   - workbench_run_recipe model tool and /q-run slash command return the
 *     bounded success summary (status/exit, run id, log paths, TAP
 *     totals, omission facts) — never raw stdout/stderr, never per-test
 *     success lines;
 *   - workbench_run_gate model tool and /q-gate slash command return the
 *     bounded gate summary (status, failing gate facts BEFORE passing
 *     detail, full persisted record path) — never per-check raw detail,
 *     never raw gate log lines;
 *   - Phase 3B: workbench_run_gate {preflight:true} and /q-gate --preflight
 *     are READ-ONLY — exact readiness/provided/missing manual facts, zero
 *     run/recipe/status effects, never raw notes, never Gate status/run id;
 *     the formal call afterwards is unchanged (creates the gate run,
 *     executes the recipe check, returns NOT_RUN for missing evidence);
 *   - failure summaries keep the fixed failure-information precedence
 *     with bounded raw excerpts only AFTER the machine-summary
 *     disclaimer;
 *   - every byte/line assertion measures the ACTUAL registered runtime
 *     output with TextEncoder/line counts against the documented plan §8
 *     caps (4096 bytes / 40 lines success, 12288 bytes / 120 lines
 *     failure) — never against a duplicate local formatter;
 *   - full run/gate records and logs stay persisted on disk and are
 *     verified by reading them back.
 *
 * The runtime is wired through the same stub ExtensionAPI used by
 * tests/p5-state-recovery.test.ts and the shared temp-project helpers
 * (tests/helpers.ts); recipe/gate execution uses the real spawnExec.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { WORKER_ALLOWED_PATHS_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ROLE_ENV } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { WORKER_SPEND_PROFILE_ENV } from "../extensions/workbench-runtime/core/worker-spend.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

// ------------------------------------------------------------------- caps

/** Documented plan §8 caps (starting values) — asserted as literals. */
const SUCCESS_MAX_BYTES = 4096;
const SUCCESS_MAX_LINES = 40;
const FAILURE_MAX_BYTES = 12288;
const FAILURE_MAX_LINES = 120;

/** Exact UTF-8 byte length of the ACTUAL runtime output (TextEncoder). */
function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Byte- AND line-aware assertion against the actual emitted text. */
function assertWithinCaps(text: string, maxBytes: number, maxLines: number): void {
	assert.ok(utf8Bytes(text) <= maxBytes, `bytes ${utf8Bytes(text)} > ${maxBytes}`);
	assert.ok(text.split("\n").length <= maxLines, `lines ${text.split("\n").length} > ${maxLines}`);
}

const RUN_ID_RE = /\d{8}-\d{6}-[A-Za-z0-9]{4}/;

// ------------------------------------------------------------------ stubs

interface StubAPI {
	commands: Map<string, unknown>;
	tools: Map<string, unknown>;
	events: Map<string, Array<(event: never, ctx: never) => unknown>>;
	entries: Array<{ type: string; customType: string; data?: unknown }>;
	messages: Array<{ customType: string; content: string; display: boolean; options?: unknown }>;
	activeTools: string[];
	appendEntryCalls: Array<{ customType: string; data: unknown }>;
}

/** Same stub ExtensionAPI surface as tests/p5-state-recovery.test.ts, with the REAL spawnExec for recipe/gate execution. */
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
		getThinkingLevel: () => "high" as never,
		exec: spawnExec,
	} as unknown as StubAPI & ExtensionAPI;
	return stub;
}

/** Trusted temp-project ctx; captures TUI notify output for slash commands. */
function trustedCtx(root: string): ExtensionCommandContext & { notifyLines: string[] } {
	const notifyLines: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: root,
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => `${root}/session.jsonl`,
			getSessionId: () => "result-summary-wiring-test",
		} as unknown as ExtensionContext["sessionManager"],
		model: undefined,
		thinkingLevel: undefined,
		ui: {
			notify: (text: string) => {
				notifyLines.push(text);
			},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => false,
		} as unknown as ExtensionContext["ui"],
		signal: undefined,
	} as unknown as ExtensionCommandContext;
	return Object.assign(ctx, { notifyLines });
}

interface RecipeTool {
	execute: (
		toolCallId: string,
		params: { recipe: string; params?: Record<string, unknown>; cache?: string },
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

interface GateTool {
	execute: (
		toolCallId: string,
		params: { gates: string; manual_evidence?: Record<string, string>; preflight?: boolean },
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

/** Text content of a tool result (the ACTUAL registered runtime output). */
function toolText(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((c) => c.text).join("\n");
}

/**
 * Commander tests must never inherit a worker-role env from the harness
 * (the unit tests may run inside a delegated worker process, where
 * WORKBENCH_AGENT_ROLE=worker is set). Clear it before the suite, like
 * tests/p5-state-recovery.test.ts.
 */
before(() => {
	delete process.env[WORKER_ROLE_ENV];
	delete process.env[WORKER_PROJECT_ROOT_ENV];
	delete process.env[WORKER_ALLOWED_PATHS_ENV];
	delete process.env[WORKER_SPEND_PROFILE_ENV];
});

// --------------------------------------------------------------- fixtures

async function setupProject(root: string, recipesYaml?: string, gatesYaml?: string): Promise<void> {
	await writeConfigFile(root, "project.yaml", "name: wiring-test\nprofile: generic\n");
	if (recipesYaml !== undefined) await writeConfigFile(root, "recipes.yaml", recipesYaml);
	if (gatesYaml !== undefined) await writeConfigFile(root, "gates.yaml", gatesYaml);
}

/** A successful recipe with a raw marker, 60 noise lines and the Node spec-reporter block. */
const GREEN_JS = [
	'console.log("RAW-SUCCESS-MARKER-42");',
	'for (let i = 1; i <= 60; i++) console.log("noise-line-" + i);',
	'console.log("ℹ tests 3");',
	'console.log("ℹ pass 3");',
	'console.log("ℹ fail 0");',
	'console.log("ℹ cancelled 0");',
	'console.log("ℹ skipped 0");',
	'console.log("ℹ todo 0");',
	'console.log("ℹ duration_ms 12.5");',
].join("\n");

const GREEN_RECIPES = 'recipes:\n  - name: green\n    command: ["node", "green.js"]\n';

/** A failing recipe: two spec-reporter failure lines, the totals block, a stderr root cause, exit 1. */
const FAIL_JS = [
	'console.log("✖ failing-test-alpha (1ms)");',
	'console.log("✖ failing-test-beta (1ms)");',
	'console.log("ℹ tests 2");',
	'console.log("ℹ pass 0");',
	'console.log("ℹ fail 2");',
	'console.log("ℹ cancelled 0");',
	'console.log("ℹ skipped 0");',
	'console.log("ℹ todo 0");',
	'console.log("ℹ duration_ms 4.5");',
	'console.error("TypeError: boom at fail.js:1");',
	"process.exit(1);",
].join("\n");

const FAIL_RECIPES = 'recipes:\n  - name: fail\n    command: ["node", "fail.js"]\n';

/** A gate with two missing file checks: FAIL with gate reason "check(s) failed: g1.1, g1.2". */
const GATES_FAIL_YAML = [
	"gates:",
	"  - id: g1",
	"    title: Data files present",
	"    checks:",
	"      - { id: g1.1, title: Prices file, kind: file, path: data/prices.csv }",
	"      - { id: g1.2, title: Returns file, kind: file, path: data/returns.csv }",
	"",
].join("\n");

// ---------------------------------------------------------------- Phase 3B

/** Root marker the preflight fixture's recipe check writes ONLY when executed. */
const PREFLIGHT_MARKER = "PREFLIGHT-MARKER.txt";

/** Distinctive raw manual-evidence note that must never surface in preflight output. */
const TOP_SECRET_NOTE = "TOP-SECRET-AUDIT-NOTE-77";

/** Declared read-only (mutation: none) recipe that writes a root marker if executed. */
const PREFLIGHT_RECIPES = [
	"recipes:",
	"  - name: mark",
	"    mutation: none",
	'    command: ["node", "-e", "require(\\"fs\\").writeFileSync(\\"PREFLIGHT-MARKER.txt\\", \\"executed\\")"]',
	"",
].join("\n");

/**
 * A gate with two REQUIRED manual checks, one OPTIONAL manual check and one
 * recipe check (mark). Formal runs end NOT_RUN while g1.2 evidence is
 * missing; the recipe check still executes and writes the root marker.
 */
const PREFLIGHT_GATES = [
	"gates:",
	"  - id: g1",
	"    title: Phase 3B preflight gate",
	"    checks:",
	'      - { id: g1.1, title: "Prices audit", kind: manual, required: true, prompt: "audit the prices dataset" }',
	'      - { id: g1.2, title: "Returns audit", kind: manual, required: true, prompt: "audit the returns dataset" }',
	'      - { id: g1.3, title: "Optional cross-check", kind: manual, required: false, prompt: "optional sanity cross-check" }',
	"      - { id: g1.4, title: Marker recipe, kind: recipe, recipe: mark }",
	"",
].join("\n");

/** The run records directory of a temp project. */
function runsDir(root: string): string {
	return join(root, CONFIG_DIR_NAME, "workbench", "runs");
}

/**
 * Non-hidden entries of a temp project's runs dir; a missing runs dir
 * (zero runs ever created) normalizes to [].
 */
async function runsEntries(root: string): Promise<string[]> {
	try {
		return (await readdir(runsDir(root))).filter((name) => !name.startsWith("."));
	} catch (error) {
		assert.equal((error as { code?: string }).code, "ENOENT", "unexpected runs-dir read failure");
		return [];
	}
}

/** The single run record directory written by the last tool/command call. */
async function singleRunDir(root: string): Promise<string> {
	const entries = (await readdir(runsDir(root))).filter((name) => !name.startsWith("."));
	assert.equal(entries.length, 1, `exactly one run record, got: ${entries.join(", ")}`);
	return join(runsDir(root), entries[0]!);
}

// --------------------------------------------------------------------------
// Registered model-tool surface: workbench_run_recipe
// --------------------------------------------------------------------------

test("workbench_run_recipe success summary: status/run id/log paths/TAP totals; raw stdout never inlined; full log on disk", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, GREEN_RECIPES);
		await writeFile(join(root, "green.js"), GREEN_JS, "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const tool = stub.tools.get("workbench_run_recipe") as unknown as RecipeTool;
		assert.ok(tool, "workbench_run_recipe registered");
		const result = await tool.execute("call-1", { recipe: "green" }, undefined, undefined, trustedCtx(root) as never);
		const text = toolText(result);
		// bounded against the ACTUAL registered output: 4096 bytes / 40 lines
		assertWithinCaps(text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
		// required status / evidence-path facts
		assert.ok(text.includes("status     : OK"), text);
		assert.ok(text.includes("exit code  : 0"), text);
		assert.match(text, /recipe\s+: green/);
		assert.ok(text.includes("command    : node green.js"), text);
		assert.match(text, /run id\s+: \d{8}-\d{6}-[A-Za-z0-9]{4}/);
		assert.ok(text.includes("3 tests, 3 passed, 0 failed"), text);
		assert.ok(text.includes("(Node TAP)"), text);
		assert.ok(text.includes("stdout log : .pi/workbench/runs/"), text);
		assert.ok(text.includes("stderr log : .pi/workbench/runs/"), text);
		assert.ok(text.includes("(full log on disk)"), text);
		assert.ok(text.includes("stdout/stderr NOT inlined (P1 policy)"), text);
		assert.ok(text.includes("no per-test success lines"), text);
		assert.ok(text.includes("note       : machine-derived summary"), text);
		// raw successful output excluded byte-for-byte
		assert.ok(!text.includes("RAW-SUCCESS-MARKER-42"), text);
		assert.ok(!text.includes("noise-line-1"), text);
		assert.ok(!text.includes("noise-line-60"), text);
		assert.ok(!text.includes("ℹ "), "raw spec-reporter lines never inline");
		// full evidence stays on disk, byte-for-byte, referenced by path
		const runDir = await singleRunDir(root);
		const stdoutLog = await readFile(join(runDir, "stdout.log"), "utf8");
		assert.ok(stdoutLog.includes("RAW-SUCCESS-MARKER-42"), "full log keeps the raw marker");
		assert.ok(stdoutLog.includes("noise-line-60"), "full log keeps every line");
	});
});

test("workbench_run_recipe failure summary: fixed failure-first precedence, bounded excerpts only after the disclaimer, 12288 bytes / 120 lines", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, FAIL_RECIPES);
		await writeFile(join(root, "fail.js"), FAIL_JS, "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const tool = stub.tools.get("workbench_run_recipe") as unknown as RecipeTool;
		assert.ok(tool, "workbench_run_recipe registered");
		const result = await tool.execute("call-1", { recipe: "fail" }, undefined, undefined, trustedCtx(root) as never);
		const text = toolText(result);
		// bounded against the ACTUAL registered output: 12288 bytes / 120 lines
		assertWithinCaps(text, FAILURE_MAX_BYTES, FAILURE_MAX_LINES);
		// required facts in the fixed §8 precedence order
		assert.ok(text.includes("status     : FAILED"), text);
		assert.ok(text.includes("exit code  : 1"), text);
		assert.ok(text.includes("command    : node fail.js"), text);
		assert.ok(text.includes("failing tests: 2 of 2 — names below"), text);
		assert.ok(text.includes("  - failing-test-alpha"), text);
		assert.ok(text.includes("  - failing-test-beta"), text);
		assert.ok(text.includes("root cause : TypeError: boom at fail.js:1"), text);
		assert.ok(text.includes("timeout    : no"), text);
		assert.ok(text.includes("cancelled  : no"), text);
		assert.ok(text.includes("warnings   : 0 (none detected)"), text);
		assert.ok(text.includes("stdout log : .pi/workbench/runs/"), text);
		assert.ok(text.includes("stderr log : .pi/workbench/runs/"), text);
		assert.ok(text.includes("note       : machine-derived summary"), text);
		// raw lines appear ONLY inside bounded excerpts AFTER the disclaimer
		const lines = text.split("\n");
		const noteIdx = lines.findIndex((line) => line.startsWith("note       : "));
		const excerptIdx = lines.findIndex((line) => line.startsWith("--- stdout excerpt"));
		const rawLineIdx = lines.findIndex((line) => line.includes("✖ failing-test-alpha"));
		assert.ok(noteIdx >= 0, "note present");
		assert.ok(excerptIdx > noteIdx, "excerpts only after the machine-summary disclaimer");
		assert.match(lines[excerptIdx]!, /--- stdout excerpt \(last \d+ of \d+ lines; full log at /);
		assert.ok(rawLineIdx > noteIdx, "raw failure lines only after the disclaimer");
		// the required failing-name facts come BEFORE any raw line
		const factsIdx = lines.findIndex((line) => line === "  - failing-test-alpha");
		assert.ok(factsIdx >= 0 && factsIdx < rawLineIdx, "required facts before raw excerpts");
	});
});

// --------------------------------------------------------------------------
// Registered slash-command surface: /q-run
// --------------------------------------------------------------------------

test("/q-run renders the same bounded success summary (no raw output, within the 4096-byte/40-line success caps)", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, GREEN_RECIPES);
		await writeFile(join(root, "green.js"), GREEN_JS, "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const def = stub.commands.get("q-run") as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
		assert.ok(def, "/q-run registered");
		const ctx = trustedCtx(root);
		await def.handler("green", ctx as never);
		const text = ctx.notifyLines.join("\n");
		// bounded against the ACTUAL registered command output
		assertWithinCaps(text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
		assert.ok(text.includes("status     : OK"), text);
		assert.match(text, /run id\s+: \d{8}-\d{6}-[A-Za-z0-9]{4}/);
		assert.ok(text.includes("stdout log : .pi/workbench/runs/"), text);
		assert.ok(text.includes("(full log on disk)"), text);
		assert.ok(text.includes("stdout/stderr NOT inlined (P1 policy)"), text);
		assert.ok(text.includes("no per-test success lines"), text);
		assert.ok(text.includes("note       : machine-derived summary"), text);
		assert.ok(!text.includes("RAW-SUCCESS-MARKER-42"), text);
		assert.ok(!text.includes("noise-line-60"), text);
		assert.ok(!text.includes("ℹ "), text);
	});
});

// --------------------------------------------------------------------------
// Registered model-tool surface: workbench_run_gate
// --------------------------------------------------------------------------

test("workbench_run_gate failure summary: gate status/record path, FAIL facts, no per-check raw detail, 12288 bytes / 120 lines", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, undefined, GATES_FAIL_YAML);
		const stub = makeStub();
		workbenchRuntime(stub);
		const tool = stub.tools.get("workbench_run_gate") as unknown as GateTool;
		assert.ok(tool, "workbench_run_gate registered");
		const result = await tool.execute("call-1", { gates: "g1" }, undefined, undefined, trustedCtx(root) as never);
		const text = toolText(result);
		// bounded against the ACTUAL registered output: 12288 bytes / 120 lines
		assertWithinCaps(text, FAILURE_MAX_BYTES, FAILURE_MAX_LINES);
		// gate status + full persisted record path
		assert.ok(text.includes("status     : FAIL"), text);
		assert.ok(text.includes("exit code  : 1"), text);
		assert.ok(text.includes("requested  : g1"), text);
		assert.ok(text.includes("profile    : generic"), text);
		assert.ok(text.includes("failing gates (1):"), text);
		assert.ok(text.includes("g1 [FAIL] Data files present — check(s) failed: g1.1, g1.2"), text);
		assert.match(text, /full record: \.pi\/workbench\/runs\/\d{8}-\d{6}-[A-Za-z0-9]{4}/);
		assert.ok(text.includes("per-check detail, warnings and evidence paths live in the persisted gate record"), text);
		assert.ok(text.includes("note       : machine-derived summary"), text);
		// irrelevant raw detail excluded
		assert.ok(!text.includes("no file matched"), "per-check failure detail never inlined");
		assert.ok(!text.includes("==> gate g1"), "raw gate log lines never inlined");
		assert.ok(!text.includes("checks passed"), "raw per-check progress never inlined");
		// durable gate record stays on disk
		const runDir = await singleRunDir(root);
		for (const file of ["gates.json", "evidence.json", "manifest.json", "summary.json"]) {
			const record = await readFile(join(runDir, file), "utf8");
			assert.ok(record.length > 0, `${file} persisted on disk`);
		}
	});
});

test("workbench_run_gate PASS summary fits the 4096-byte/40-line success caps", async () => {
	await withTempDir(async (root) => {
		await setupProject(
			root,
			undefined,
			"gates:\n  - id: g1\n    title: Data file present\n    checks:\n      - { id: g1.1, title: Prices, kind: file, path: data/prices.csv }\n",
		);
		await mkdir(join(root, "data"), { recursive: true });
		await writeFile(join(root, "data", "prices.csv"), "date,price\n", "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const tool = stub.tools.get("workbench_run_gate") as unknown as GateTool;
		assert.ok(tool, "workbench_run_gate registered");
		const result = await tool.execute("call-1", { gates: "g1" }, undefined, undefined, trustedCtx(root) as never);
		const text = toolText(result);
		// bounded against the ACTUAL registered output: 4096 bytes / 40 lines
		assertWithinCaps(text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
		assert.ok(text.includes("status     : PASS"), text);
		assert.ok(text.includes("exit code  : 0"), text);
		assert.ok(text.includes("passing    : g1 (1)"), text);
		assert.match(text, /full record: \.pi\/workbench\/runs\/\d{8}-\d{6}-[A-Za-z0-9]{4}/);
		assert.ok(text.includes("note       : machine-derived summary"), text);
	});
});

// --------------------------------------------------------------------------
// Registered slash-command surface: /q-gate
// --------------------------------------------------------------------------

test("/q-gate renders the same bounded gate failure summary (status/record path; no raw gate log; within the 12288-byte/120-line failure caps)", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, undefined, GATES_FAIL_YAML);
		const stub = makeStub();
		workbenchRuntime(stub);
		const def = stub.commands.get("q-gate") as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
		assert.ok(def, "/q-gate registered");
		const ctx = trustedCtx(root);
		await def.handler("g1", ctx as never);
		const text = ctx.notifyLines.join("\n");
		// bounded against the ACTUAL registered command output
		assertWithinCaps(text, FAILURE_MAX_BYTES, FAILURE_MAX_LINES);
		assert.ok(text.includes("status     : FAIL"), text);
		assert.match(text, /full record: \.pi\/workbench\/runs\/\d{8}-\d{6}-[A-Za-z0-9]{4}/);
		assert.ok(text.includes("g1 [FAIL] Data files present — check(s) failed: g1.1, g1.2"), text);
		assert.ok(text.includes("per-check detail, warnings and evidence paths live in the persisted gate record"), text);
		assert.ok(text.includes("note       : machine-derived summary"), text);
		assert.ok(!text.includes("==> gate g1"), "raw gate log never inlined");
		assert.ok(!text.includes("no file matched"), "per-check detail never inlined");
		assert.ok(!text.includes("checks passed"), text);
	});
});

// --------------------------------------------------------------------------
// Phase 3B: registered preflight surfaces (read-only, exact facts, zero
// effects) + unchanged formal semantics afterwards
// --------------------------------------------------------------------------

test("Phase 3B preflight is read-only and exact: model {preflight:true} and /q-gate --preflight report provided/missing required manual checks with zero callbacks/runs/recipe execution; the formal call afterwards still creates the gate run, executes the recipe and stays NOT_RUN", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, PREFLIGHT_RECIPES, PREFLIGHT_GATES);
		const stub = makeStub();
		workbenchRuntime(stub);
		const tool = stub.tools.get("workbench_run_gate") as unknown as GateTool;
		assert.ok(tool, "workbench_run_gate registered");
		const ctx = trustedCtx(root);
		const before = await runsEntries(root);
		assert.deepEqual(before, [], "no run records before any preflight");

		// ---- model tool: workbench_run_gate { preflight: true } -------------
		const updates: unknown[] = [];
		const model = await tool.execute(
			"call-preflight",
			{ gates: "g1", manual_evidence: { "g1.1": TOP_SECRET_NOTE }, preflight: true },
			undefined,
			(u: unknown) => {
				updates.push(u);
			},
			ctx as never,
		);
		const text = toolText(model);
		// bounded against the ACTUAL registered preflight output: 4096 bytes / 40 lines
		assertWithinCaps(text, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
		// exact readiness/missing/provided facts
		assert.ok(text.includes("preflight g1 ready=no missing=1"), text);
		assert.ok(text.includes("requested   : g1"), text);
		assert.ok(text.includes("ready       : no"), text);
		assert.ok(text.includes("provided    : g1.1"), text);
		assert.ok(text.includes("missing     : g1.2"), text);
		assert.ok(text.includes("required manual checks:"), text);
		assert.ok(text.includes("provided:yes"), text);
		assert.ok(text.includes("provided:no"), text);
		// explicit zero facts
		assert.ok(text.includes("no run created; 0 recipes executed; no gate status assigned"), text);
		// raw evidence note and formal Gate status/run-id tokens excluded
		assert.ok(!text.includes(TOP_SECRET_NOTE), "raw manual note never inlined");
		for (const token of ["PASS", "FAIL", "BLOCKED", "NOT_RUN", "status     :", "run id", "run_id", "run:"]) {
			assert.ok(!text.includes(token), `preflight text must not contain ${JSON.stringify(token)}`);
		}
		// exact structured preflight details — readiness, required checks,
		// provided/missing ids, literal zero effects, NO formal Gate fields
		const details = model.details as Record<string, unknown>;
		assert.equal(details.preflight, true);
		assert.equal(details.selector, "g1");
		assert.deepEqual(details.requested, ["g1"]);
		assert.equal(details.profile, "generic");
		assert.equal(details.manual_evidence_ready, false);
		assert.deepEqual(details.provided_manual_evidence, ["g1.1"]);
		assert.deepEqual(details.missing_manual_evidence, ["g1.2"]);
		assert.equal(details.gate_run_created, false);
		assert.equal(details.recipes_executed, 0);
		assert.equal(details.gate_status_assigned, false);
		const checks = details.required_manual_checks as Array<{ gate_id: string; check_id: string; prompt: string | undefined; provided: boolean }>;
		assert.deepEqual(
			checks.map((c) => c.check_id),
			["g1.1", "g1.2"],
			"required manual checks in declaration order; optional/recipe checks excluded",
		);
		assert.equal(checks[0]!.gate_id, "g1");
		assert.equal(checks[0]!.provided, true, "g1.1 satisfied by the supplied note");
		assert.equal(checks[1]!.provided, false, "g1.2 has no evidence");
		assert.ok(checks[0]!.prompt?.includes("prices dataset"), "declared prompt present");
		for (const key of ["ok", "status", "run_id", "gates"]) {
			assert.equal(Object.hasOwn(details, key), false, `preflight details never carry formal Gate field ${key}`);
		}
		// zero streaming updates, zero run records, recipe check never executed
		assert.equal(updates.length, 0, "preflight never sends a streaming update");
		assert.deepEqual(await runsEntries(root), before, "model preflight creates no run record");
		await assert.rejects(readFile(join(root, PREFLIGHT_MARKER), "utf8"), { code: "ENOENT" }, "model preflight never executes the recipe check");

		// ---- slash command: /q-gate g1 --preflight manual:g1.1=... ----------
		const def = stub.commands.get("q-gate") as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
		assert.ok(def, "/q-gate registered");
		await def.handler(`g1 --preflight manual:g1.1=${TOP_SECRET_NOTE}`, ctx as never);
		const notify = ctx.notifyLines.join("\n");
		// bounded notification with the same evidence syntax and facts
		assertWithinCaps(notify, SUCCESS_MAX_BYTES, SUCCESS_MAX_LINES);
		assert.ok(notify.includes("preflight g1 ready=no missing=1"), notify);
		assert.ok(notify.includes("provided    : g1.1"), notify);
		assert.ok(notify.includes("missing     : g1.2"), notify);
		assert.ok(notify.includes("no run created; 0 recipes executed; no gate status assigned"), notify);
		assert.ok(!notify.includes(TOP_SECRET_NOTE), "raw manual note never inlined in the notification");
		for (const token of ["PASS", "FAIL", "BLOCKED", "NOT_RUN", "status     :", "run id", "run_id", "run:"]) {
			assert.ok(!notify.includes(token), `notification must not contain ${JSON.stringify(token)}`);
		}
		assert.deepEqual(await runsEntries(root), before, "slash preflight creates no run record");
		await assert.rejects(readFile(join(root, PREFLIGHT_MARKER), "utf8"), { code: "ENOENT" }, "slash preflight never executes the recipe check");

		// ---- formal call: same tool, NO preflight, NO manual evidence -------
		const formalUpdates: unknown[] = [];
		const formal = await tool.execute(
			"call-formal",
			{ gates: "g1" },
			undefined,
			(u: unknown) => {
				formalUpdates.push(u);
			},
			ctx as never,
		);
		const formalDetails = formal.details as Record<string, unknown>;
		assert.equal(formalDetails.status, "NOT_RUN", "missing required manual evidence still leaves the gate NOT_RUN");
		assert.match(String(formalDetails.run_id), RUN_ID_RE);
		assert.equal(formalDetails.ok, false);
		assert.equal(Object.hasOwn(formalDetails, "run_id"), true, "the formal path carries the Gate run id");
		assert.ok(formalUpdates.length >= 1, "the formal path still streams updates");
		// The formal call created exactly ONE GATE run — the record identified
		// by details.run_id (manifest recipe "gate"). The only other runs-dir
		// entry is the recipe-check run the gate engine executed (runRecipe
		// persists its own record); the root marker proves it really ran.
		const entries = await runsEntries(root);
		assert.equal(entries.length, 2, `gate run + recipe-check run, got: ${entries.join(", ")}`);
		const manifests: Array<{ recipe: string; run_id: string }> = [];
		for (const entry of entries) {
			manifests.push(JSON.parse(await readFile(join(runsDir(root), entry, "manifest.json"), "utf8")) as { recipe: string; run_id: string });
		}
		const gateManifests = manifests.filter((m) => m.recipe === "gate");
		assert.equal(gateManifests.length, 1, "exactly one gate run record");
		assert.equal(gateManifests[0]!.run_id, formalDetails.run_id, "details.run_id identifies the persisted gate run");
		assert.equal(manifests.filter((m) => m.recipe === "mark").length, 1, "the recipe check ran and persisted its run record");
		assert.equal(await readFile(join(root, PREFLIGHT_MARKER), "utf8"), "executed", "recipe check actually executed in the formal run");
	});
});
