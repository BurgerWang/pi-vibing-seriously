/**
 * P5 command-inventory and direct-load tests (extended additively through
 * R8 with cache, delegation, cost, and context/output observability).
 *
 * 1. Direct load: the extension module is imported and its default export is
 *    invoked with a stub ExtensionAPI — no Pi runtime needed. This is the
 *    "extension direct-load smoke test" as a repeatable unit test.
 * 2. Inventory: the registered command set must be exact and deterministic
 *    deterministic workbench commands, the registered tool surface exactly
 *    the 16 tools (three fixed native read/grep/find overrides first, then
 *    the 13 workbench catalog tools), and the 7 prompt templates — no
 *    missing, extra, or colliding names. The P7 lease commands and the P5
 *    milestone handoff are user-only: they are commands, never model tools.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { NATIVE_OVERRIDE_NAMES } from "../extensions/workbench-runtime/core/native-tool-policy.ts";
import { WORKBENCH_TOOL_NAMES } from "../extensions/workbench-runtime/core/tool-catalog.ts";

/** The deterministic command surface (P5 requirement 七, extended additively through R8). */
export const EXPECTED_COMMANDS = [
	"q-mode-audit",
	"q-mode-dev",
	"q-mode-verify",
	"q-status",
	"q-runtime-doctor",
	// Deterministic user-only repair transition; no model turn is involved.
	"q-repair",
	// Deterministic automatic semantic review; replaces the old prompt name.
	"q-review",
	"q-init",
	"q-run",
	"q-runs",
	"q-run-show",
	"q-gate",
	"q-gates",
	"q-gate-show",
	"q-evidence",
	"q-report",
	"q-compare",
	"q-widget",
	// P6-A cache telemetry commands.
	"q-cache-status",
	"q-cache-report",
	"q-cache-doctor",
	// P6-C action cache commands.
	"q-cache-explain",
	"q-cache-prune",
	"q-cache-clear",
	// P6-D quant cache contract commands.
	"q-cache-validate",
	"q-cache-lineage",
	// Unreleased split session-cost observability command.
	"q-cost-status",
	// R8: numeric-only context/output control observations (no enforcement).
	"q-context-output-status",
	// P7: delegation write-authority + review status command.
	"q-delegation-status",
	// P7 slice 3: user-only commander write-lease commands.
	"q-write-policy",
	"q-commander-write-unlock",
	"q-commander-write-lock",
	// P5: user-only milestone session-handoff command.
	"q-milestone-handoff",
] as const;

export const EXPECTED_TOOLS = [
	"workbench_project_inspect",
	"workbench_run_recipe",
	"workbench_read_run",
	"workbench_run_gate",
	"workbench_read_gate",
	"workbench_list_gates",
	"workbench_compare_runs",
	// P7: the three delegation tools follow the seven existing tools
	// (delegate → review → status, matching WORKBENCH_TOOL_NAMES).
	"workbench_delegate_worker",
	"workbench_review_worker_diff",
	"workbench_delegation_status",
	// P8b: the public read-only recovery tool follows the original tools.
	"workbench_recover_tool_result",
	// Structured Git completion is the additive final catalog tool.
	"workbench_git",
	// Exact repair is appended after Git and accepts only a delegation id.
	"workbench_repair_delegation",
] as const;

export const EXPECTED_PROMPTS = ["q-audit", "q-plan", "q-build", "q-debug", "q-verify", "q-optimize", "q-code-review"] as const;

function makeStub(): ExtensionAPI & Record<string, unknown> {
	const commands = new Map<string, { description?: string }>();
	const tools = new Map<string, { description?: string }>();
	const events = new Map<string, number>();
	const stub = {
		commands,
		tools,
		events,
		registerCommand: (name: string, def: { description?: string }) => {
			commands.set(name, def);
		},
		registerTool: (def: { name: string; description?: string }) => {
			tools.set(def.name, def);
		},
		on: (event: string) => {
			events.set(event, (events.get(event) ?? 0) + 1);
		},
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		setActiveTools: () => {},
		getActiveTools: () => [],
		getAllTools: () => [...tools.values()] as never,
		exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
	};
	return stub as unknown as ExtensionAPI & Record<string, unknown>;
}

test("extension module direct-loads and registers the exact deterministic command inventory", () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const registered = stub.commands as Map<string, unknown>;
	assert.deepEqual(
		[...registered.keys()].sort(),
		[...EXPECTED_COMMANDS].sort(),
		"registered commands must be exactly the P5+P6-A+P6-C+P6-D+P7+R8+Unreleased command list",
	);
});

test("extension registers exactly 16 tools: the three fixed native overrides first, then the 13 workbench catalog tools", () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const tools = stub.tools as Map<string, unknown>;
	// Native overrides are same-name overrides, never catalog tools.
	assert.deepEqual([...EXPECTED_TOOLS], [...WORKBENCH_TOOL_NAMES], "EXPECTED_TOOLS tracks WORKBENCH_TOOL_NAMES");
	assert.deepEqual(
		[...tools.keys()],
		[...NATIVE_OVERRIDE_NAMES, ...EXPECTED_TOOLS],
		"native read/grep/find fixed first, then the 13 catalog tools in order (16 total)",
	);
	const catalogTools = [...tools.keys()].filter((n) => n.startsWith("workbench_"));
	assert.deepEqual(catalogTools, [...EXPECTED_TOOLS], "catalog subset matches the current additive inventory");
	for (const name of catalogTools) {
		assert.ok(name.startsWith("workbench_"), name);
	}
});

test("extension registers the lifecycle events it relies on", () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const events = (stub as unknown as { events: Map<string, number> }).events;
	for (const event of [
		"session_start",
		"session_before_compact",
		"session_shutdown",
		"before_agent_start",
		"agent_settled",
		"tool_execution_start",
		"tool_execution_end",
		"tool_call",
		// P6-A cache telemetry events.
		"model_select",
		"thinking_level_select",
		"before_provider_request",
		"message_end",
	]) {
		assert.ok((events.get(event) ?? 0) >= 1, event);
	}
});

test("the P7 lease commands and the P5 milestone handoff are user-only — never registered as model tools", () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const commands = stub.commands as Map<string, unknown>;
	const tools = stub.tools as Map<string, unknown>;
	for (const name of ["q-write-policy", "q-commander-write-unlock", "q-commander-write-lock", "q-milestone-handoff"]) {
		assert.ok(commands.has(name), `${name} must be registered as a command`);
		assert.ok(!tools.has(name), `${name} must NOT be registered as a model tool`);
	}
	// No registered tool may collide with any registered command (and vice versa).
	for (const name of commands.keys()) {
		assert.ok(!tools.has(name), `tool collision with command ${name}`);
	}
	for (const name of tools.keys()) {
		assert.ok(!commands.has(name), `command collision with tool ${name}`);
	}
});

test("prompt templates are exactly the 7 q-* templates", async () => {
	const dir = join(process.cwd(), "prompts");
	const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
	assert.deepEqual(files.sort(), [...EXPECTED_PROMPTS].map((p) => `${p}.md`).sort());
	for (const name of EXPECTED_PROMPTS) {
		const content = await readFile(join(dir, `${name}.md`), "utf8");
		assert.ok(content.trim().length > 0, `${name}.md is not empty`);
	}
});

test("no naming conflicts between commands and prompt templates", () => {
	const commands: Set<string> = new Set(EXPECTED_COMMANDS);
	for (const prompt of EXPECTED_PROMPTS) {
		assert.ok(!commands.has(prompt), `prompt "${prompt}" collides with a command`);
	}
	// Skills also must not collide with the command surface.
	for (const tool of EXPECTED_TOOLS) {
		assert.ok(!commands.has(tool));
	}
	assert.equal(new Set(EXPECTED_COMMANDS).size, EXPECTED_COMMANDS.length);
	assert.equal(new Set(EXPECTED_TOOLS).size, EXPECTED_TOOLS.length);
	assert.equal(new Set(EXPECTED_PROMPTS).size, EXPECTED_PROMPTS.length);
});

test("every registered command has a description (help/discovery surface)", () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const commands = stub.commands as Map<string, { description?: string }>;
	for (const [name, def] of commands) {
		assert.ok((def.description ?? "").length > 10, `${name} needs a description`);
	}
});
