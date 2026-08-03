/**
 * P5 command-inventory and direct-load tests (extended by P6-A with the
 * cache telemetry commands and lifecycle events).
 *
 * 1. Direct load: the extension module is imported and its default export is
 *    invoked with a stub ExtensionAPI — no Pi runtime needed. This is the
 *    "extension direct-load smoke test" as a repeatable unit test.
 * 2. Inventory: the registered command set must be EXACTLY the 18
 *    deterministic workbench commands, the 8 workbench tools, and the 7
 *    prompt templates — no missing, extra, or colliding names.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";

/** The deterministic command surface (P5 requirement 七, extended by P6-A). */
export const EXPECTED_COMMANDS = [
	"q-mode-audit",
	"q-mode-dev",
	"q-mode-verify",
	"q-status",
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
] as const;

export const EXPECTED_TOOLS = [
	"workbench_project_inspect",
	"workbench_run_recipe",
	"workbench_read_run",
	"workbench_run_gate",
	"workbench_read_gate",
	"workbench_list_gates",
	"workbench_compare_runs",
	"workbench_delegate_worker",
] as const;

export const EXPECTED_PROMPTS = ["q-audit", "q-plan", "q-build", "q-debug", "q-verify", "q-optimize", "q-review"] as const;

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

test("extension module direct-loads and registers exactly the 23 deterministic commands", () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const registered = stub.commands as Map<string, unknown>;
	assert.deepEqual(
		[...registered.keys()].sort(),
		[...EXPECTED_COMMANDS].sort(),
		"registered commands must be exactly the P5+P6-A+P6-C+P6-D command list",
	);
});

test("extension registers exactly the 8 workbench tools", () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	const tools = stub.tools as Map<string, unknown>;
	assert.deepEqual([...tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
	for (const name of EXPECTED_TOOLS) {
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
