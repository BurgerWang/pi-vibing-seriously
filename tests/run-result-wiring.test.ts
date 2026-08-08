/**
 * Commander Slice B1 (commander-token-optimization plan P2 + P3): WIRING
 * tests for workbench_read_run — integration-style, through the ACTUALLY
 * REGISTERED workbench runtime surface (the registered model tool), with
 * the real spawnExec for recipe execution.
 *
 * The pure renderer unit tests live in tests/run-result.test.ts. This
 * file proves the REGISTERED surface:
 *
 *   - the omitted `include` resolves to `summary` and emits the ordered
 *     Summary → Evidence → Persisted layers, <= 4096 UTF-8 bytes / 40
 *     lines, never raw log lines / test lines / argv, with durable
 *     project-relative run-dir/manifest/summary/stdout/stderr paths, and
 *     a REQUIRED logs/argv guidance line stating the exact
 *     `include=logs`/`include=all` opt-in instruction for bounded tails;
 *   - adversarial manifests (huge fields/lists, control characters,
 *     cache/quant facts) through the ACTUALLY REGISTERED tool stay
 *     bounded with explicit omission facts and the guidance line intact;
 *   - explicit `manifest` adds bounded cwd/argv metadata WITHOUT tails;
 *   - explicit `logs`/`all` append only the existing caller-bounded
 *     tails (default 200-line / 20 KB snippet caps; custom
 *     max_lines/max_bytes honored) after the same metadata block;
 *   - the structured `details` payload keeps its exact legacy shape;
 *   - disk records (manifest.json, summary.json, stdout.log, stderr.log)
 *     stay byte-for-byte unchanged by every read_run call.
 *
 * Every byte/line assertion measures the ACTUAL registered runtime output
 * with TextEncoder/line counts against the Slice B1 caps (4096 bytes /
 * 40 lines for the default summary) — never against a duplicate local
 * formatter.
 *
 * P4b (additive, one focused test): a REAL committed temp git repo
 * (`.pi/` ignored) plus a fresh GPT-5.6 Sol session_start, one explicit
 * registered recipe run (mutation: artifacts, declared write
 * `.pi/counter.txt`, argv secret), then registered workbench_read_run
 * reads in all four include modes — exact `validation : REUSABLE` in text
 * AND structured details everywhere, global caps for summary/manifest,
 * caller-bounded tails for logs/all, privacy-safe default/details
 * rendering, and full byte/entry/stub/counter invariance (reads never
 * execute or mutate anything). The legacy adversarial-manifest test in
 * this file additionally proves the fail-closed `RERUN_REQUIRED —
 * missing-binding` verdict (exact text line AND exact
 * details.validation shape) plus complete tree/runs/stub invariance for
 * a hand-crafted record with NO validation_evidence at all.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { before, test } from "node:test";

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { WORKER_ALLOWED_PATHS_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ROLE_ENV } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { WORKER_SPEND_PROFILE_ENV } from "../extensions/workbench-runtime/core/worker-spend.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

// ------------------------------------------------------------------- caps

/** Documented Slice B1 caps (starting values) — asserted as literals. */
const SUMMARY_MAX_BYTES = 4096;
const SUMMARY_MAX_LINES = 40;

/** Byte- AND line-aware assertion against the actual emitted text. */
function assertWithinCaps(text: string, maxBytes: number, maxLines: number): void {
	const bytes = new TextEncoder().encode(text).length;
	assert.ok(bytes <= maxBytes, `bytes ${bytes} > ${maxBytes}`);
	const lines = text.split("\n").length;
	assert.ok(lines <= maxLines, `lines ${lines} > ${maxLines}`);
}

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

/** Same stub ExtensionAPI surface as tests/result-summary-wiring.test.ts, with the REAL spawnExec. */
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

/** Trusted temp-project ctx for model-tool execution (optional actor model). */
function trustedCtx(root: string, model?: { provider: string; id: string }): ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => `${root}/session.jsonl`,
			getSessionId: () => "run-result-wiring-test",
		} as unknown as ExtensionContext["sessionManager"],
		model,
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

interface RecipeTool {
	execute: (
		toolCallId: string,
		params: { recipe: string; params?: Record<string, unknown>; cache?: string },
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

interface ReadRunTool {
	execute: (
		toolCallId: string,
		params: { run_id: string; include?: string; max_lines?: number; max_bytes?: number },
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

interface GateTool {
	execute: (
		toolCallId: string,
		params: { gates: string; manual_evidence?: Record<string, string> },
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
 * (the unit tests may run inside a delegated worker process). Clear it
 * before the suite, like tests/result-summary-wiring.test.ts.
 */
before(() => {
	delete process.env[WORKER_ROLE_ENV];
	delete process.env[WORKER_PROJECT_ROOT_ENV];
	delete process.env[WORKER_ALLOWED_PATHS_ENV];
	delete process.env[WORKER_SPEND_PROFILE_ENV];
});

// --------------------------------------------------------------- fixtures

async function setupProject(root: string, recipesYaml: string): Promise<void> {
	await writeConfigFile(root, "project.yaml", "name: wiring-test\nprofile: generic\n");
	await writeConfigFile(root, "recipes.yaml", recipesYaml);
}

/** 250 noise lines + a raw marker — exceeds the default 200-line tail cap. */
const GREEN_JS = [
	'console.log("RAW-SUCCESS-MARKER-42");',
	'for (let i = 1; i <= 250; i++) console.log("noise-line-" + i);',
].join("\n");

const GREEN_RECIPES = 'recipes:\n  - name: green\n    command: ["node", "green.js"]\n';

const FAIL_JS = ['console.error("TypeError: boom at fail.js:1");', "process.exit(1);"].join("\n");

const FAIL_RECIPES = 'recipes:\n  - name: fail\n    command: ["node", "fail.js"]\n';

/** The run records directory of a temp project. */
function runsDir(root: string): string {
	return join(root, CONFIG_DIR_NAME, "workbench", "runs");
}

/** The single run record directory written by the last recipe run. */
async function singleRunDir(root: string): Promise<string> {
	const entries = (await readdir(runsDir(root))).filter((name) => !name.startsWith("."));
	assert.equal(entries.length, 1, `exactly one run record, got: ${entries.join(", ")}`);
	return join(runsDir(root), entries[0]!);
}

/** Byte snapshots of every persisted run record file (unchanged-check). */
async function snapshotRunDir(runDir: string): Promise<Map<string, Buffer>> {
	const out = new Map<string, Buffer>();
	for (const file of ["manifest.json", "summary.json", "stdout.log", "stderr.log"]) {
		out.set(file, await readFile(join(runDir, file)));
	}
	return out;
}

function assertDiskUnchanged(runDir: string, before: Map<string, Buffer>): Promise<void> {
	return (async () => {
		for (const [file, bytes] of before) {
			const now = await readFile(join(runDir, file));
			assert.deepEqual(now, bytes, `${file} must stay byte-for-byte unchanged`);
		}
	})();
}

// --------------------------------------------------------------------------
// Registered model-tool surface: workbench_read_run
// --------------------------------------------------------------------------

test("workbench_read_run default (include omitted): bounded layered Summary/Evidence/Persisted, no raw logs/argv, durable paths, details preserved, disk unchanged", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, GREEN_RECIPES);
		await writeFile(join(root, "green.js"), GREEN_JS, "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const recipeTool = stub.tools.get("workbench_run_recipe") as unknown as RecipeTool;
		assert.ok(recipeTool, "workbench_run_recipe registered");
		await recipeTool.execute("call-1", { recipe: "green" }, undefined, undefined, trustedCtx(root) as never);

		const runDir = await singleRunDir(root);
		const runId = basename(runDir);
		const diskBefore = await snapshotRunDir(runDir);

		const readRun = stub.tools.get("workbench_read_run") as unknown as ReadRunTool;
		assert.ok(readRun, "workbench_read_run registered");
		const result = await readRun.execute("call-2", { run_id: runId }, undefined, undefined, trustedCtx(root) as never);
		const text = toolText(result);

		// bounded against the ACTUAL registered output: 4096 bytes / 40 lines
		assertWithinCaps(text, SUMMARY_MAX_BYTES, SUMMARY_MAX_LINES);
		// ordered layers
		const lines = text.split("\n");
		const idxSummary = lines.findIndex((l) => l === "--- summary ---");
		const idxEvidence = lines.findIndex((l) => l === "--- evidence ---");
		const idxPersisted = lines.findIndex((l) => l === "--- persisted ---");
		assert.ok(idxSummary >= 0 && idxEvidence > idxSummary && idxPersisted > idxEvidence, text);
		// summary facts
		assert.ok(lines.some((l) => l.startsWith(`run_id     : ${runId}`)), text);
		assert.ok(lines.some((l) => l.startsWith("recipe     : green")), text);
		assert.ok(lines.some((l) => l.startsWith("status     : OK")), text);
		assert.ok(lines.some((l) => l.startsWith("exit code  : 0")), text);
		// durable project-relative persisted paths
		assert.ok(lines.some((l) => l.startsWith(`run dir    : ${CONFIG_DIR_NAME}/workbench/runs/${runId}`)), text);
		assert.ok(lines.some((l) => l.includes(`manifest.json`)), text);
		assert.ok(lines.some((l) => l.includes(`summary.json`)), text);
		assert.ok(lines.some((l) => l.includes("stdout.log") && l.includes("(full log on disk)")), text);
		assert.ok(lines.some((l) => l.includes("stderr.log") && l.includes("(full log on disk)")), text);
		// no raw logs / test lines / argv / cwd in the default summary
		assert.ok(!text.includes("RAW-SUCCESS-MARKER-42"), text);
		assert.ok(!text.includes("noise-line-1"), text);
		assert.ok(!text.includes("noise-line-250"), text);
		assert.ok(!text.includes("--- stdout tail"), text);
		assert.ok(!text.includes("green.js"), "argv values never appear in the default summary");
		assert.ok(!/^argv\s*:/m.test(text), text);
		assert.ok(!/^cwd\s*:/m.test(text), text);
		// the REQUIRED Evidence-layer guidance line states the omission
		// policy AND the exact opt-in instruction for bounded tails
		const guidance = lines.find((l) => l.startsWith("logs/argv  : "));
		assert.ok(guidance, `guidance line missing:\n${text}`);
		assert.ok(guidance!.includes("raw stdout/stderr/tails and argv are omitted"), text);
		assert.ok(guidance!.includes("include=logs or include=all"), text);
		assert.ok(text.includes("note       : machine-derived summary"), text);

		// structured details keep the exact legacy shape
		assert.equal(result.details.run_id, runId);
		assert.equal(result.details.recipe, "green");
		assert.equal(result.details.kind, "recipe");
		assert.equal(result.details.status, "OK");
		assert.equal(result.details.exit_code, 0);
		assert.equal(result.details.stdout_log, `${CONFIG_DIR_NAME}/workbench/runs/${runId}/stdout.log`);
		assert.equal(result.details.stderr_log, `${CONFIG_DIR_NAME}/workbench/runs/${runId}/stderr.log`);
		assert.deepEqual(result.details.artifact_paths, []);

		// disk records stay byte-for-byte unchanged
		await assertDiskUnchanged(runDir, diskBefore);
	});
});

test("workbench_read_run include=manifest: bounded cwd/argv metadata, no tails, within caps", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, GREEN_RECIPES);
		await writeFile(join(root, "green.js"), GREEN_JS, "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const recipeTool = stub.tools.get("workbench_run_recipe") as unknown as RecipeTool;
		await recipeTool.execute("call-1", { recipe: "green" }, undefined, undefined, trustedCtx(root) as never);
		const runDir = await singleRunDir(root);
		const runId = basename(runDir);

		const readRun = stub.tools.get("workbench_read_run") as unknown as ReadRunTool;
		const result = await readRun.execute("call-2", { run_id: runId, include: "manifest" }, undefined, undefined, trustedCtx(root) as never);
		const text = toolText(result);
		assertWithinCaps(text, SUMMARY_MAX_BYTES, SUMMARY_MAX_LINES);
		assert.ok(text.includes("argv       : node green.js"), text);
		assert.ok(/cwd\s*:/.test(text), text);
		assert.ok(!text.includes("--- stdout tail"), "manifest include never appends tails");
		assert.ok(!text.includes("noise-line-250"), text);
		assert.ok(text.includes("no raw logs and no tails"), text);
		assert.ok(text.includes("include=logs or include=all"), text);
	});
});

test("workbench_read_run include=logs: caller-bounded tails only (default 200-line cap), metadata block, raw markers excluded from the tail boundary", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, GREEN_RECIPES);
		await writeFile(join(root, "green.js"), GREEN_JS, "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const recipeTool = stub.tools.get("workbench_run_recipe") as unknown as RecipeTool;
		await recipeTool.execute("call-1", { recipe: "green" }, undefined, undefined, trustedCtx(root) as never);
		const runDir = await singleRunDir(root);
		const runId = basename(runDir);

		const readRun = stub.tools.get("workbench_read_run") as unknown as ReadRunTool;
		const result = await readRun.execute("call-2", { run_id: runId, include: "logs" }, undefined, undefined, trustedCtx(root) as never);
		const text = toolText(result);
		// the caller-bounded tail (default 200 lines) is appended after the metadata block
		assert.ok(text.includes(`--- stdout tail (truncated): ${CONFIG_DIR_NAME}/workbench/runs/${runId}/stdout.log ---`), text);
		assert.ok(text.includes("noise-line-250"), "tail keeps the LAST log lines");
		assert.ok(text.includes("noise-line-51"), "tail starts at the 200-line boundary (line 51 of 251)");
		assert.ok(!text.includes("noise-line-50"), "earlier lines are outside the caller-bounded tail");
		// exact-line matching: substring checks would false-positive on
		// noise-line-10 … noise-line-19 (and 100 … 199) inside the tail
		assert.ok(!text.split("\n").includes("noise-line-1"), "line 1 is outside the caller-bounded tail");
		assert.ok(!text.split("\n").includes("RAW-SUCCESS-MARKER-42"), "the first line is outside the 200-line tail");
		assert.ok(text.includes("--- stderr tail (full):"), text);
		assert.ok(text.includes("(empty)"), text);
		// the same metadata block (incl. argv) precedes the tails
		const idxArgv = text.split("\n").findIndex((l) => l.startsWith("argv       : "));
		const idxTail = text.split("\n").findIndex((l) => l.startsWith("--- stdout tail"));
		assert.ok(idxArgv >= 0 && idxTail > idxArgv, "metadata before tails");
		assert.ok(text.includes("caller-bounded tails below (max_lines / max_bytes)"), text);
	});
});

test("workbench_read_run include=all honors custom caller caps (max_lines/max_bytes)", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, GREEN_RECIPES);
		await writeFile(join(root, "green.js"), GREEN_JS, "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const recipeTool = stub.tools.get("workbench_run_recipe") as unknown as RecipeTool;
		await recipeTool.execute("call-1", { recipe: "green" }, undefined, undefined, trustedCtx(root) as never);
		const runDir = await singleRunDir(root);
		const runId = basename(runDir);

		const readRun = stub.tools.get("workbench_read_run") as unknown as ReadRunTool;
		const result = await readRun.execute(
			"call-2",
			{ run_id: runId, include: "all", max_lines: 5, max_bytes: 512 },
			undefined,
			undefined,
			trustedCtx(root) as never,
		);
		const text = toolText(result);
		assert.ok(text.includes(`--- stdout tail (truncated): ${CONFIG_DIR_NAME}/workbench/runs/${runId}/stdout.log ---`), text);
		assert.ok(text.includes("noise-line-250"), text);
		assert.ok(text.includes("noise-line-246"), "custom 5-line tail keeps the LAST 5 lines");
		assert.ok(!text.includes("noise-line-245"), text);
		assert.ok(text.includes("argv       : node green.js"), "all include keeps the metadata block");
		// stderr tail is empty
		assert.ok(text.includes("(empty)"), text);
	});
});

test("workbench_read_run default on a failing run: status FAILED, exit 1, within caps, disk unchanged", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, FAIL_RECIPES);
		await writeFile(join(root, "fail.js"), FAIL_JS, "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const recipeTool = stub.tools.get("workbench_run_recipe") as unknown as RecipeTool;
		await recipeTool.execute("call-1", { recipe: "fail" }, undefined, undefined, trustedCtx(root) as never);
		const runDir = await singleRunDir(root);
		const runId = basename(runDir);
		const diskBefore = await snapshotRunDir(runDir);

		const readRun = stub.tools.get("workbench_read_run") as unknown as ReadRunTool;
		const result = await readRun.execute("call-2", { run_id: runId }, undefined, undefined, trustedCtx(root) as never);
		const text = toolText(result);
		assertWithinCaps(text, SUMMARY_MAX_BYTES, SUMMARY_MAX_LINES);
		assert.ok(text.includes("status     : FAILED"), text);
		assert.ok(text.includes("exit code  : 1"), text);
		// the raw failing stderr is never inlined in the default summary
		assert.ok(!text.includes("TypeError: boom at fail.js:1"), text);
		assert.ok(!/^argv\s*:/m.test(text), text);
		await assertDiskUnchanged(runDir, diskBefore);
	});
});

test("workbench_read_run default on a hand-crafted adversarial manifest: guidance line, bounded lists, no raw content/argv, within caps", async () => {
	await withTempDir(async (root) => {
		await setupProject(root, GREEN_RECIPES);
		const runId = "20260805-120000-a1b2";
		const manifest = {
			schema_version: 1,
			run_id: runId,
			recipe: "r".repeat(5000),
			profile: "p\ninject-line",
			started_at: "2026-08-05T12:00:00.000Z\ninjected",
			finished_at: "2026-08-05T12:01:00.000Z",
			duration_ms: 60000,
			cwd: "c".repeat(5000),
			argv: ["SECRET-ARGV-MARKER-77", "node", "green.js"],
			exit_code: 0,
			timed_out: false,
			cancelled: false,
			git_commit: "aa2301763d95",
			git_dirty: false,
			artifact_paths: Array.from({ length: 100 }, (_, i) => `a${i}`),
			evidence_paths: Array.from({ length: 100 }, (_, i) => `e${i}`),
			declared_writes: Array.from({ length: 50 }, (_, i) => `w${i}`),
			stdout_truncated: true,
			stderr_truncated: true,
			mode: "VERIFY",
			expected_exit_codes: [0],
			environment_names: [],
			execution_source: "cache",
			action_key: "k".repeat(5000),
			reused_from_run_id: "20260805-110000-zz9z",
			cache_created_at: "t".repeat(100),
			cache_validated_at: "t".repeat(100),
			artifact_validation: { mode: "full", artifacts_restored: true, hash_verified: true, status: "v".repeat(100) },
			quant_contract: { type: "q".repeat(100), manifest: "m".repeat(5000), validation_status: "valid", logical_reference: null, resolved_reference: null, warnings: ["w".repeat(500)] },
		};
		await writeConfigFile(root, `runs/${runId}/manifest.json`, JSON.stringify(manifest));
		await writeConfigFile(root, `runs/${runId}/stdout.log`, "RAW-SUCCESS-MARKER-42\n" + Array.from({ length: 250 }, (_, i) => `noise-line-${i + 1}`).join("\n"));
		await writeConfigFile(root, `runs/${runId}/stderr.log`, "RAW-STDERR-MARKER-9\n");

		const stub = makeStub();
		workbenchRuntime(stub);
		const readRun = stub.tools.get("workbench_read_run") as unknown as ReadRunTool;

		// P4b legacy-record coverage: this hand-crafted manifest intentionally
		// carries NO validation_evidence. Snapshot the full run tree, the
		// runs-dir entries and the stub state (existing helpers) BEFORE the
		// registered read, so the read can prove the fail-closed verdict AND
		// complete read-only invariance.
		const runDir = join(runsDir(root), runId);
		const treeBefore = await snapshotRunTree(runDir);
		const runsEntriesBefore = (await readdir(runsDir(root))).filter((name) => !name.startsWith("."));
		const stubBefore = snapshotStubState(stub);

		const result = await readRun.execute("call-1", { run_id: runId }, undefined, undefined, trustedCtx(root) as never);
		const text = toolText(result);

		assertWithinCaps(text, SUMMARY_MAX_BYTES, SUMMARY_MAX_LINES);
		const lines = text.split("\n");
		// the REQUIRED guidance line states the omission policy AND the exact opt-in
		const guidance = lines.find((l) => l.startsWith("logs/argv  : "));
		assert.ok(guidance, `guidance line missing:\n${text}`);
		assert.ok(guidance!.includes("raw stdout/stderr/tails and argv are omitted"), guidance);
		assert.ok(guidance!.includes("include=logs or include=all"), guidance);
		// control characters never inject extra lines
		for (const injected of ["inject-line", "injected"]) {
			assert.ok(!lines.includes(injected), `injected line survived: ${injected}`);
		}
		// adversarial lists are bounded with the exact omitted count in the
		// ACTUAL registered output
		assert.ok(text.includes("(+92 more artifact path(s) omitted — full list in the run record)"), text);
		assert.ok(text.includes("(+92 more evidence path(s) omitted — full list in the run record)"), text);
		assert.ok(text.includes("(+42 more declared write(s) omitted — full list in the run record)"), text);
		assert.ok(text.includes("92 artifact path(s) omitted (bounded display)"), text);
		// raw logs and argv never appear in the default summary
		assert.ok(!text.includes("RAW-SUCCESS-MARKER-42"), text);
		assert.ok(!text.includes("RAW-STDERR-MARKER-9"), text);
		assert.ok(!text.includes("SECRET-ARGV-MARKER-77"), text);
		assert.ok(!text.includes("noise-line-250"), text);
		// bounded fields are recorded with a durable-source fact, cache/quant
		// facts render, durable paths stay present, no degradation
		assert.ok(text.includes("run fields bounded (display) — full values in manifest.json"), text);
		assert.ok(text.includes("cache      : CACHE"), text);
		assert.ok(text.includes("quant      : "), text);
		assert.ok(text.includes(`run dir    : ${CONFIG_DIR_NAME}/workbench/runs/${runId}`), text);
		assert.ok(!text.includes("degraded to the minimal form"), text);

		// P4b legacy-record verdict: the exact fail-closed line — absent
		// validation evidence never claims reuse — AND the exact structured
		// details shape, with the normal record fields still readable beside
		// the verdict
		assert.ok(lines.includes("validation : RERUN_REQUIRED — missing-binding"), `exact fail-closed validation line missing:\n${text}`);
		assert.deepEqual(result.details.validation, { status: "RERUN_REQUIRED", reasons: ["missing-binding"] });
		assert.ok(lines.includes(`run_id     : ${runId}`), text);
		assert.ok(lines.includes("status     : OK"), text);
		assert.ok(lines.includes("exit code  : 0"), text);
		assert.equal(result.details.run_id, runId);
		assert.equal(result.details.status, "OK");
		assert.equal(result.details.exit_code, 0);

		// complete read-only invariance: the full run tree, the runs-dir
		// entries and the stub session-visible state are all unchanged
		await assertRunTreeUnchanged(runDir, treeBefore);
		assert.deepEqual(
			(await readdir(runsDir(root))).filter((name) => !name.startsWith(".")),
			runsEntriesBefore,
			"no run record appeared",
		);
		const stubAfter = snapshotStubState(stub);
		assert.equal(stubAfter.entries, stubBefore.entries, "no implicit session entries");
		assert.equal(stubAfter.appendEntryCalls, stubBefore.appendEntryCalls, "no implicit appendEntry calls");
		assert.equal(stubAfter.messages, stubBefore.messages, "no implicit messages");
		assert.deepEqual(stubAfter.activeTools, stubBefore.activeTools, "no implicit tool-set change");
	});
});

// --------------------------------------------------------------------------
// P4b fresh-Sol registered wiring: REUSABLE verdict, privacy, read-only
// --------------------------------------------------------------------------

/** The argv secret the counter recipe accepts (never rendered by default/details). */
const ARGV_SECRET = "ARGV-SECRET-MARKER-9f3a";

/** GPT-5.6 Sol on an approved first-party provider (fresh-session actor). */
const SOL_MODEL = { provider: "openai-codex", id: "gpt-5.6-sol" };

/**
 * The counter script increments ONLY the ignored `.pi/counter.txt` and
 * accepts the argv secret (process.argv[2]) without ever printing it.
 * Five stdout lines keep tail-boundary assertions observable.
 */
const COUNTER_JS = [
	'const { readFileSync, writeFileSync } = require("node:fs");',
	"// accepts the argv secret (process.argv[2]) but never prints or persists it",
	"const secret = process.argv[2];",
	'if (!secret || secret.length < 4) process.exit(2);',
	'const path = ".pi/counter.txt";',
	'writeFileSync(path, String(Number(readFileSync(path, "utf8")) + 1), "utf8");',
	'console.log("RAW-STDOUT-MARKER-42");',
	'for (let i = 1; i <= 4; i++) console.log("counter-noise-" + i);',
].join("\n");

/** Declared recipe: mutation: artifacts, one declared write, one argv secret param. */
const COUNTER_RECIPES = [
	"recipes:",
	"  - name: counter",
	"    description: increments the ignored .pi counter; accepts an argv secret",
	'    command: ["node", "counter.js", "{{secret}}"]',
	"    cwd: .",
	"    mutation: artifacts",
	'    writes: [".pi/counter.txt"]',
	"    artifacts: []",
	"    expected_exit_codes: [0]",
	"    allowed_modes: [DEV, VERIFY]",
	"    params:",
	"      - name: secret",
	"        type: string",
	"        required: true",
].join("\n");

/** The distinctive manual evidence note (never rendered by read_run text/details). */
const MANUAL_SECRET = "MANUAL-SECRET-MARKER-7c2e audit performed: point-in-time availability and signal alignment verified";

/** Manual gate: g1 with ONE required human check g1.1 (never machine-satisfiable). */
const MANUAL_GATES_YAML = [
	"gates:",
	"  - id: g1",
	"    title: G1",
	"    checks:",
	"      - id: g1.1",
	"        title: Manual audit",
	"        kind: manual",
	'        prompt: "audit needed"',
].join("\n");

/** Fire the registered session_start handler as fresh GPT-5.6 Sol (openai-codex). */
async function fireSolSession(stub: StubAPI & ExtensionAPI, root: string): Promise<void> {
	const handlers = stub.events.get("session_start") ?? [];
	assert.ok(handlers.length > 0, "session_start handler registered");
	for (const handler of handlers) {
		await handler({ type: "session_start", reason: "new" } as never, trustedCtx(root, SOL_MODEL) as never);
	}
}

/** Initialize + first-commit a REAL temp git repo (identity via -c flags). */
async function initGitRepo(root: string): Promise<void> {
	const git = async (args: string[]): Promise<void> => {
		const result = await spawnExec("git", args, { cwd: root });
		assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	};
	await git(["init"]);
	await git(["add", "-A"]);
	await git(["-c", "user.name=Workbench Test", "-c", "user.email=workbench-test@example.com", "commit", "-m", "fixtures"]);
}

/** Recursive byte + entry snapshot of a run record directory. */
interface RunTreeSnapshot {
	/** Sorted relative paths of every directory entry (files and dirs). */
	entries: string[];
	/** Relative path → full file bytes. */
	files: Map<string, Buffer>;
}

async function snapshotRunTree(runDir: string): Promise<RunTreeSnapshot> {
	const entries: string[] = [];
	const files = new Map<string, Buffer>();
	const walk = async (dir: string, prefix: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			entries.push(rel);
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full, rel);
			else files.set(rel, await readFile(full));
		}
	};
	await walk(runDir, "");
	entries.sort();
	return { entries, files };
}

/** Assert the run directory tree is entry-for-entry and byte-for-byte unchanged. */
async function assertRunTreeUnchanged(runDir: string, before: RunTreeSnapshot): Promise<void> {
	const after = await snapshotRunTree(runDir);
	assert.deepEqual(after.entries, before.entries, "run directory entries changed");
	assert.deepEqual([...after.files.keys()], [...before.files.keys()], "run file set changed");
	for (const [rel, bytes] of before.files) {
		const now = after.files.get(rel);
		assert.ok(now, `run file disappeared: ${rel}`);
		assert.deepEqual(now, bytes, `run file changed: ${rel}`);
	}
}

/** JSON-safe snapshot of the stub's session-visible state. */
function snapshotStubState(stub: StubAPI & ExtensionAPI): {
	entries: string;
	appendEntryCalls: string;
	messages: string;
	activeTools: string[];
} {
	return {
		entries: JSON.stringify(stub.entries),
		appendEntryCalls: JSON.stringify(stub.appendEntryCalls),
		messages: JSON.stringify(stub.messages),
		activeTools: [...stub.activeTools],
	};
}

/** Shared assertions for EVERY include mode: exact REUSABLE verdict + privacy-safe details. */
function assertReusableResult(result: { content: Array<{ type: string; text: string }>; details: Record<string, unknown> }, label: string): string {
	const text = toolText(result);
	assert.ok(text.split("\n").includes("validation : REUSABLE"), `${label}: exact validation line missing:\n${text}`);
	assert.deepEqual(result.details.validation, { status: "REUSABLE", reasons: [] }, `${label}: details.validation exact shape`);
	const detailsJson = JSON.stringify(result.details);
	assert.ok(!detailsJson.includes(ARGV_SECRET), `${label}: structured details expose the argv secret`);
	assert.ok(!detailsJson.includes("unavailable"), `${label}: structured details expose unavailable_reason prose`);
	assert.ok(!detailsJson.includes("manual"), `${label}: structured details expose manual evidence text`);
	assert.ok(!detailsJson.includes("worker"), `${label}: structured details expose worker facts`);
	return text;
}

test("P4b fresh-Sol recipe run: REUSABLE in text+details across all four include modes, privacy-safe default, byte/entry/stub/counter invariance", async () => {
	await withTempDir(async (root) => {
		// fixtures: config, script, .gitignore, and the PRE-CREATED declared
		// write path (`.pi/` is gitignored, so the counter is never a diff fact)
		await setupProject(root, COUNTER_RECIPES);
		await writeFile(join(root, "counter.js"), COUNTER_JS, "utf8");
		await writeFile(join(root, ".gitignore"), `${CONFIG_DIR_NAME}/\n`, "utf8");
		await mkdir(join(root, CONFIG_DIR_NAME), { recursive: true });
		await writeFile(join(root, CONFIG_DIR_NAME, "counter.txt"), "0", "utf8");

		// a REAL committed temp git repo — the binding binds an actual HEAD
		await initGitRepo(root);
		const committedHead = (await spawnExec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
		assert.ok(/^[0-9a-f]{40}$/.test(committedHead), `expected a real HEAD commit, got: ${committedHead}`);

		const stub = makeStub();
		workbenchRuntime(stub);
		await fireSolSession(stub, root);

		// exactly ONE explicit invocation of the registered recipe tool
		const recipeTool = stub.tools.get("workbench_run_recipe") as unknown as RecipeTool;
		assert.ok(recipeTool, "workbench_run_recipe registered");
		const runResult = await recipeTool.execute("call-1", { recipe: "counter", params: { secret: ARGV_SECRET } }, undefined, undefined, trustedCtx(root) as never);
		assert.equal(runResult.details.status, "OK", toolText(runResult));
		assert.equal(runResult.details.exit_code, 0, toolText(runResult));
		assert.equal(await readFile(join(root, CONFIG_DIR_NAME, "counter.txt"), "utf8"), "1", "the ignored counter was incremented exactly once");

		const runDir = await singleRunDir(root);
		const runId = basename(runDir);

		// the persisted evidence is a successful, complete, SOL-owned binding
		const persisted = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as {
			argv_hash?: string;
			validation_evidence?: {
				binding?: {
					owner?: string;
					outcome?: { successful?: boolean; complete?: boolean };
					target?: { invocation_hash?: string };
				};
			};
		};
		assert.equal(persisted.validation_evidence?.binding?.owner, "sol");
		assert.equal(persisted.validation_evidence?.binding?.outcome?.successful, true);
		assert.equal(persisted.validation_evidence?.binding?.outcome?.complete, true);
		assert.equal(persisted.argv_hash, persisted.validation_evidence?.binding?.target?.invocation_hash, "manifest argv_hash == binding invocation hash");

		// snapshot EVERY run file + directory entry, the runs dir, the stub
		// session-visible state and the counter BEFORE any read
		const treeBefore = await snapshotRunTree(runDir);
		const runsEntriesBefore = (await readdir(runsDir(root))).filter((name) => !name.startsWith("."));
		const stubBefore = snapshotStubState(stub);

		const readRun = stub.tools.get("workbench_read_run") as unknown as ReadRunTool;
		assert.ok(readRun, "workbench_read_run registered");

		// ---- include=summary (default): within global caps, privacy-safe ----
		const summary = await readRun.execute("call-2", { run_id: runId }, undefined, undefined, trustedCtx(root) as never);
		const summaryText = assertReusableResult(summary, "summary");
		assertWithinCaps(summaryText, SUMMARY_MAX_BYTES, SUMMARY_MAX_LINES);
		// ordered layers
		const summaryLines = summaryText.split("\n");
		const idxSummary = summaryLines.findIndex((l) => l === "--- summary ---");
		const idxEvidence = summaryLines.findIndex((l) => l === "--- evidence ---");
		const idxPersisted = summaryLines.findIndex((l) => l === "--- persisted ---");
		assert.ok(idxSummary >= 0 && idxEvidence > idxSummary && idxPersisted > idxEvidence, summaryText);
		// the default summary never exposes the argv secret, raw stdout,
		// argv/cwd metadata, or unavailable/manual/worker prose
		assert.ok(!summaryText.includes(ARGV_SECRET), summaryText);
		assert.ok(!summaryText.includes("RAW-STDOUT-MARKER-42"), summaryText);
		assert.ok(!summaryText.includes("counter-noise-1"), summaryText);
		assert.ok(!summaryText.includes("counter.js"), summaryText);
		assert.ok(!summaryText.includes("unavailable"), summaryText);
		assert.ok(!/^argv\s*:/m.test(summaryText), summaryText);
		assert.ok(!/^cwd\s*:/m.test(summaryText), summaryText);
		const guidance = summaryLines.find((l) => l.startsWith("logs/argv  : "));
		assert.ok(guidance, `guidance line missing:\n${summaryText}`);
		assert.ok(guidance!.includes("include=logs or include=all"), summaryText);
		assert.ok(summaryText.includes(`run dir    : ${CONFIG_DIR_NAME}/workbench/runs/${runId}`), summaryText);

		// ---- include=manifest: within global caps, metadata, no tails ------
		const manifest = await readRun.execute("call-3", { run_id: runId, include: "manifest" }, undefined, undefined, trustedCtx(root) as never);
		const manifestText = assertReusableResult(manifest, "manifest");
		assertWithinCaps(manifestText, SUMMARY_MAX_BYTES, SUMMARY_MAX_LINES);
		// explicit raw opt-in: the manifest metadata DOES carry the argv
		// (secret included) — never asserted hidden here
		assert.ok(manifestText.includes(`argv       : node counter.js ${ARGV_SECRET}`), manifestText);
		assert.ok(/^cwd\s*:/m.test(manifestText), manifestText);
		assert.ok(manifestText.includes("no raw logs and no tails"), manifestText);
		assert.ok(!manifestText.includes("--- stdout tail"), manifestText);
		assert.ok(!manifestText.includes("counter-noise-4"), manifestText);

		// ---- include=logs: caller-bounded tail semantics (default caps) ----
		const logs = await readRun.execute("call-4", { run_id: runId, include: "logs" }, undefined, undefined, trustedCtx(root) as never);
		const logsText = assertReusableResult(logs, "logs");
		assert.ok(logsText.includes(`--- stdout tail (full): ${CONFIG_DIR_NAME}/workbench/runs/${runId}/stdout.log ---`), logsText);
		assert.ok(logsText.includes("RAW-STDOUT-MARKER-42"), logsText);
		assert.ok(logsText.includes("counter-noise-4"), logsText);
		assert.ok(logsText.includes(`--- stderr tail (full): ${CONFIG_DIR_NAME}/workbench/runs/${runId}/stderr.log ---`), logsText);
		assert.ok(logsText.includes("(empty)"), logsText);
		assert.ok(logsText.includes(`argv       : node counter.js ${ARGV_SECRET}`), "logs keeps the metadata block (explicit opt-in)");

		// ---- include=all: custom caller caps bound the tail ----------------
		const all = await readRun.execute("call-5", { run_id: runId, include: "all", max_lines: 2, max_bytes: 2048 }, undefined, undefined, trustedCtx(root) as never);
		const allText = assertReusableResult(all, "all");
		assert.ok(allText.includes(`--- stdout tail (truncated): ${CONFIG_DIR_NAME}/workbench/runs/${runId}/stdout.log ---`), allText);
		for (const kept of ["counter-noise-3", "counter-noise-4"]) {
			assert.ok(allText.split("\n").includes(kept), `tail keeps ${kept}:\n${allText}`);
		}
		for (const dropped of ["RAW-STDOUT-MARKER-42", "counter-noise-1", "counter-noise-2"]) {
			assert.ok(!allText.split("\n").includes(dropped), `tail must drop ${dropped}:\n${allText}`);
		}
		assert.ok(allText.includes("(empty)"), allText);

		// ---- read-only invariance: nothing executed, nothing mutated ------
		await assertRunTreeUnchanged(runDir, treeBefore);
		assert.deepEqual(
			(await readdir(runsDir(root))).filter((name) => !name.startsWith(".")),
			runsEntriesBefore,
			"no implicit run record appeared",
		);
		const stubAfter = snapshotStubState(stub);
		assert.equal(stubAfter.entries, stubBefore.entries, "no implicit session entries");
		assert.equal(stubAfter.appendEntryCalls, stubBefore.appendEntryCalls, "no implicit appendEntry calls");
		assert.equal(stubAfter.messages, stubBefore.messages, "no implicit messages");
		assert.deepEqual(stubAfter.activeTools, stubBefore.activeTools, "no implicit tool-set change");
		assert.equal(await readFile(join(root, CONFIG_DIR_NAME, "counter.txt"), "utf8"), "1", "counter still 1 — reads never re-executed the recipe");
		const statusAfter = await spawnExec("git", ["status", "--porcelain"], { cwd: root });
		assert.equal(statusAfter.stdout.trim(), "", "reads left the git worktree untouched");
	});
});

test("P4b fresh-Sol manual gate run: one registered PASS, REUSABLE in default text+details, privacy-safe, full tree/runs/stub invariance", async () => {
	await withTempDir(async (root) => {
		// fixtures: project config (no recipes needed) + a manual gate whose ONLY
		// required check (g1.1) needs human evidence + `.pi/` gitignored
		await setupProject(root, "recipes: []\n");
		await writeConfigFile(root, "gates.yaml", MANUAL_GATES_YAML);
		await writeFile(join(root, ".gitignore"), `${CONFIG_DIR_NAME}/\n`, "utf8");

		// a REAL committed temp git repo — the binding binds an actual HEAD; the
		// run record lands under the ignored `.pi/` and is never a diff fact
		await initGitRepo(root);
		const committedHead = (await spawnExec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
		assert.ok(/^[0-9a-f]{40}$/.test(committedHead), `expected a real HEAD commit, got: ${committedHead}`);

		const stub = makeStub();
		workbenchRuntime(stub);
		await fireSolSession(stub, root);

		// exactly ONE explicit invocation of the registered gate tool: selector
		// g1 + the distinctive manual evidence for its required check g1.1
		const gateTool = stub.tools.get("workbench_run_gate") as unknown as GateTool;
		assert.ok(gateTool, "workbench_run_gate registered");
		const gateResult = await gateTool.execute(
			"call-1",
			{ gates: "g1", manual_evidence: { "g1.1": MANUAL_SECRET } },
			undefined,
			undefined,
			trustedCtx(root) as never,
		);
		assert.equal(gateResult.details.status, "PASS", toolText(gateResult));
		assert.equal(gateResult.details.ok, true, toolText(gateResult));
		const gateSummary = gateResult.details.gates as Array<{ id: string; status: string }>;
		assert.equal(gateSummary.length, 1, toolText(gateResult));
		assert.equal(gateSummary[0]!.id, "g1", toolText(gateResult));
		assert.equal(gateSummary[0]!.status, "PASS", toolText(gateResult));
		const counts = gateResult.details.counts as { pass: number; fail: number; blocked: number; not_run: number };
		assert.deepEqual(counts, { pass: 1, fail: 0, blocked: 0, not_run: 0 }, toolText(gateResult));

		const runDir = await singleRunDir(root);
		const runId = basename(runDir);
		assert.equal(gateResult.details.run_id, runId, "the gate tool's run_id is the single persisted run record");

		// the persisted evidence is a successful, complete, SOL-owned gate binding
		const persisted = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as {
			argv?: string[];
			validation_evidence?: {
				binding?: {
					kind?: string;
					owner?: string;
					outcome?: { successful?: boolean; complete?: boolean };
					target?: { kind?: string; selector?: string; requested_gates?: string[]; effective_gates?: string[] };
				};
			};
		};
		assert.equal(persisted.validation_evidence?.binding?.kind, "gate");
		assert.equal(persisted.validation_evidence?.binding?.owner, "sol");
		assert.equal(persisted.validation_evidence?.binding?.outcome?.successful, true);
		assert.equal(persisted.validation_evidence?.binding?.outcome?.complete, true);
		assert.equal(persisted.validation_evidence?.binding?.target?.kind, "gate");
		assert.equal(persisted.validation_evidence?.binding?.target?.selector, "g1");
		assert.deepEqual(persisted.validation_evidence?.binding?.target?.requested_gates, ["g1"]);
		assert.deepEqual(persisted.validation_evidence?.binding?.target?.effective_gates, ["g1"]);
		// the gate argv is the plain /q-gate selector — no secret in the record
		assert.deepEqual(persisted.argv, ["/q-gate", "g1"]);

		// snapshot EVERY run file + directory entry, the runs dir and the stub
		// session-visible state BEFORE the read
		const treeBefore = await snapshotRunTree(runDir);
		const runsEntriesBefore = (await readdir(runsDir(root))).filter((name) => !name.startsWith("."));
		const stubBefore = snapshotStubState(stub);

		const readRun = stub.tools.get("workbench_read_run") as unknown as ReadRunTool;
		assert.ok(readRun, "workbench_read_run registered");

		// exactly ONE registered read: the default bounded summary
		const result = await readRun.execute("call-2", { run_id: runId }, undefined, undefined, trustedCtx(root) as never);
		const text = assertReusableResult(result, "gate summary");
		assertWithinCaps(text, SUMMARY_MAX_BYTES, SUMMARY_MAX_LINES);
		// ordered layers + the exact REUSABLE verdict line
		const lines = text.split("\n");
		const idxSummary = lines.findIndex((l) => l === "--- summary ---");
		const idxEvidence = lines.findIndex((l) => l === "--- evidence ---");
		const idxPersisted = lines.findIndex((l) => l === "--- persisted ---");
		assert.ok(idxSummary >= 0 && idxEvidence > idxSummary && idxPersisted > idxEvidence, text);
		assert.ok(lines.includes("validation : REUSABLE"), text);
		assert.ok(lines.some((l) => l.startsWith(`run_id     : ${runId}`)), text);
		assert.ok(lines.some((l) => l.startsWith("recipe     : gate")), text);
		assert.ok(lines.some((l) => l.startsWith("status     : OK")), text);
		assert.ok(lines.some((l) => l.startsWith("exit code  : 0")), text);
		assert.ok(lines.some((l) => l.startsWith(`run dir    : ${CONFIG_DIR_NAME}/workbench/runs/${runId}`)), text);
		// privacy: the manual secret, unavailable prose, argv/cwd metadata and
		// worker-first facts never leave the default summary — and raw gate
		// stdout is never inlined
		assert.ok(!text.includes(MANUAL_SECRET), text);
		assert.ok(!text.includes("unavailable"), text);
		assert.ok(!text.includes("gates in run (dependency order)"), text);
		assert.ok(!/^argv\s*:/m.test(text), text);
		assert.ok(!/^cwd\s*:/m.test(text), text);
		for (const workerFact of ["worker", "sol-commander", "delegation", "lease"]) {
			assert.ok(!text.includes(workerFact), `worker-first fact leaked into the summary: ${workerFact}`);
		}
		const guidance = lines.find((l) => l.startsWith("logs/argv  : "));
		assert.ok(guidance, `guidance line missing:\n${text}`);
		assert.ok(guidance!.includes("include=logs or include=all"), text);

		// exact structured details: gate identity + the exact REUSABLE shape,
		// never the manual secret / unavailable prose / argv / worker facts
		assert.equal(result.details.run_id, runId);
		assert.equal(result.details.recipe, "gate");
		assert.equal(result.details.kind, "gate");
		assert.equal(result.details.status, "OK");
		assert.equal(result.details.exit_code, 0);
		assert.equal(result.details.profile, "generic");
		assert.equal(result.details.mode, "DEV");
		assert.equal(result.details.git_commit, committedHead);
		assert.equal(result.details.git_dirty, false);
		assert.deepEqual(result.details.artifact_paths, ["gates.json", "evidence.json", "summary.json"]);
		assert.deepEqual(result.details.validation, { status: "REUSABLE", reasons: [] });
		const detailsJson = JSON.stringify(result.details);
		assert.ok(!detailsJson.includes(MANUAL_SECRET), "structured details expose the manual secret");

		// ---- read-only invariance: nothing executed, nothing mutated ------
		await assertRunTreeUnchanged(runDir, treeBefore);
		assert.deepEqual(
			(await readdir(runsDir(root))).filter((name) => !name.startsWith(".")),
			runsEntriesBefore,
			"no second run record appeared",
		);
		const stubAfter = snapshotStubState(stub);
		assert.equal(stubAfter.entries, stubBefore.entries, "no implicit session entries");
		assert.equal(stubAfter.appendEntryCalls, stubBefore.appendEntryCalls, "no implicit appendEntry calls");
		assert.equal(stubAfter.messages, stubBefore.messages, "no implicit messages");
		assert.deepEqual(stubAfter.activeTools, stubBefore.activeTools, "no implicit tool-set change");
		const statusAfter = await spawnExec("git", ["status", "--porcelain"], { cwd: root });
		assert.equal(statusAfter.stdout.trim(), "", "the read left the git worktree untouched");
	});
});
