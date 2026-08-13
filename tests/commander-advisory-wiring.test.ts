/**
 * P7 commander advisory wiring tests — config loading and runtime wiring.
 *
 * Coverage:
 *   - loadProjectConfig: commander.advisory.soft/high overrides load
 *     additively (missing fields inherit defaults); invalid values, unknown
 *     keys, non-mapping levels, and high<=soft ordering violations become
 *     bounded project.yaml ConfigIssue records with safe documented-default
 *     fallback — malformed config never throws and never disables
 *     observability (commanderAdvisory is always fully resolved)
 *   - footer (refreshStatus via message_end): CMD:SOFT / CMD:HIGH appended
 *     only when triggered, driven by the SAME pending-message-aware session
 *     breakdown as COST (existing dedup semantics), trusted-config
 *     thresholds honored best-effort, OK adds no advisory segment, and the
 *     existing WB/COST/WF behavior is preserved
 *   - /q-cost-status: existing cost output retained, advisory facts appended
 *     additively in TUI (notify) and print (stdout) modes; never
 *     trust-gated (defaults on untrusted/error paths); malformed config
 *     falls back to defaults without crashing
 *   - advisory-only continuation: a HIGH-band session never steers, never
 *     sends messages, never cancels/short-circuits message_end, and leaves
 *     the tool_call guard intact while preserving the exact 30-command
 *     inventory, including R8's one observation-only status command (no
 *     enforcement path)
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadProjectConfig } from "../extensions/workbench-runtime/core/config.ts";
import {
	DEFAULT_ADVISORY_HIGH,
	DEFAULT_ADVISORY_SOFT,
	defaultAdvisoryConfig,
} from "../extensions/workbench-runtime/core/commander-advisory.ts";
import {
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_ROLE_ENV,
} from "../extensions/workbench-runtime/core/worker-policy.ts";
import { WORKER_SPEND_PROFILE_ENV } from "../extensions/workbench-runtime/core/worker-spend.ts";
import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { EXPECTED_COMMANDS } from "./p5-inventory.test.ts";
import { withTempDir, writeConfigFile } from "./helpers.ts";

// ------------------------------------------------- worker-env isolation

/**
 * Commander tests must never inherit a worker-role env from the harness
 * (the unit tests may run inside a delegated worker process, where
 * WORKBENCH_AGENT_ROLE=worker is set): worker-only steering messages would
 * increment state.sentMessages and falsify the advisory-only assertion
 * ("no steering message is ever sent by advisory paths"). Like
 * tests/result-summary-wiring.test.ts, snapshot the worker
 * role/project-root/allowed-paths/spend-profile env before the suite and
 * clear it for the tests — and additionally restore each original value
 * afterwards (deleting values that were originally absent) so the process
 * environment is preserved after this suite.
 */
const WORKER_ENV_KEYS = [WORKER_ROLE_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ALLOWED_PATHS_ENV, WORKER_SPEND_PROFILE_ENV] as const;
const originalWorkerEnv = new Map<string, string | undefined>();

before(() => {
	for (const key of WORKER_ENV_KEYS) {
		originalWorkerEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

after(() => {
	for (const key of WORKER_ENV_KEYS) {
		const original = originalWorkerEnv.get(key);
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
});

// ------------------------------------------------------------------- helpers

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { total: cost },
	};
}

function assistant(provider: string, model: string, u: unknown, timestamp?: number) {
	return { type: "message", message: { role: "assistant", provider, model, usage: u, ...(timestamp !== undefined ? { timestamp } : {}) } };
}

/** An assistant message whose commander gross tokens exceed the soft default (25M). */
function pendingHugeMessage(timestamp = 1) {
	return { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", timestamp, usage: usage(12_000_000, 1_000, 14_000_000, 0, 19.195) };
}

interface StubState {
	commands: Map<string, { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
	tools: Map<string, unknown>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	statuses: Map<string, string>;
	notified: string[];
	sentMessages: number;
	activeTools: string[];
}

function makeRuntimeStub(): { stub: ExtensionAPI & Record<string, unknown>; state: StubState } {
	const state: StubState = {
		commands: new Map(),
		tools: new Map(),
		handlers: new Map(),
		statuses: new Map(),
		notified: [],
		sentMessages: 0,
		activeTools: [],
	};
	const stub = {
		registerCommand: (name: string, def: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			state.commands.set(name, def);
		},
		registerTool: (def: { name: string }) => {
			state.tools.set(def.name, def);
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const handlers = state.handlers.get(event) ?? [];
			handlers.push(handler);
			state.handlers.set(event, handlers);
		},
		appendEntry: () => {},
		sendMessage: () => {
			state.sentMessages++;
		},
		sendUserMessage: () => {},
		setActiveTools: (tools: string[]) => {
			state.activeTools = [...tools];
		},
		getActiveTools: () => [],
		getAllTools: () => [...state.tools.values()] as never,
		getThinkingLevel: () => "high",
		// git is unavailable in the stub world: findProjectRoot falls back to cwd
		exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
	};
	return { stub: stub as unknown as ExtensionAPI & Record<string, unknown>, state };
}

interface FakeEventCtxOptions {
	entries: readonly unknown[];
	cwd: string;
	trusted: boolean;
	mode?: "tui" | "print";
	statuses: Map<string, string>;
	notified: string[];
	model?: { provider: string; id: string; api?: string };
}

function fakeEventCtx(opts: FakeEventCtxOptions): ExtensionContext {
	return {
		mode: opts.mode ?? "tui",
		hasUI: opts.mode !== "print",
		cwd: opts.cwd,
		isProjectTrusted: () => opts.trusted,
		sessionManager: { getEntries: () => opts.entries },
		model: opts.model,
		thinkingLevel: "high",
		getSystemPrompt: () => "",
		ui: {
			setStatus: (key: string, line: string) => {
				opts.statuses.set(key, line);
			},
			notify: (text: string) => {
				opts.notified.push(text);
			},
			setWidget: () => {},
			confirm: async () => false,
		},
		signal: undefined,
	} as unknown as ExtensionContext;
}

/** Invoke the registered message_end handler (assistant message => refreshStatus). */
async function driveMessageEnd(
	state: StubState,
	ctx: ExtensionContext,
	message: Record<string, unknown>,
): Promise<unknown> {
	const handlers = state.handlers.get("message_end");
	assert.ok(handlers && handlers.length > 0, "message_end handler must be registered");
	let result: unknown;
	for (const handler of handlers) {
		const next = await handler({ message, role: "assistant" }, ctx);
		if (next !== undefined) result = next;
	}
	return result;
}

let advisoryGuardSerial = 0;

/** Drive one fresh turn and one tool call through the registered guards. */
async function driveFreshToolCall(
	state: StubState,
	ctx: ExtensionContext,
	toolName: string,
	input: unknown,
): Promise<unknown> {
	advisoryGuardSerial += 1;
	for (const handler of state.handlers.get("turn_start") ?? []) {
		await handler({ type: "turn_start", turnIndex: advisoryGuardSerial }, ctx);
	}
	for (const handler of state.handlers.get("tool_call") ?? []) {
		const result = await handler({
			type: "tool_call",
			toolCallId: `advisory-guard-${advisoryGuardSerial}`,
			toolName,
			input,
		}, ctx);
		if (result !== undefined) return result;
	}
	return undefined;
}

// ------------------------------------------------------- config wiring (P7)

const FULL_ADVISORY_YAML = [
	"name: advisory-project",
	"profile: generic",
	"commander:",
	"  advisory:",
	"    soft:",
	"      requests: 10",
	"      gross_tokens: 1000000",
	"      output_tokens: 10000",
	"      tool_text_bytes: 50000",
	"      compactions: 2",
	"    high:",
	"      requests: 20",
	"      gross_tokens: 2000000",
	"      output_tokens: 20000",
	"      tool_text_bytes: 100000",
	"      compactions: 4",
	"",
].join("\n");

test("loadProjectConfig: commander.advisory soft/high overrides load additively with no issues", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", FULL_ADVISORY_YAML);
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.deepEqual(config.commanderAdvisory.soft, {
			requests: 10,
			gross_tokens: 1_000_000,
			output_tokens: 10_000,
			tool_text_bytes: 50_000,
			compactions: 2,
		});
		assert.deepEqual(config.commanderAdvisory.high, {
			requests: 20,
			gross_tokens: 2_000_000,
			output_tokens: 20_000,
			tool_text_bytes: 100_000,
			compactions: 4,
		});
		assert.deepEqual(config.issues, []);
	});
});

test("loadProjectConfig: missing advisory fields inherit the documented defaults", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"project.yaml",
			[
				"name: x",
				"profile: generic",
				"commander:",
				"  advisory:",
				"    soft:",
				"      requests: 5",
				"    high:",
				"      compactions: 10",
				"",
			].join("\n"),
		);
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.equal(config.commanderAdvisory.soft.requests, 5);
		assert.equal(config.commanderAdvisory.soft.gross_tokens, DEFAULT_ADVISORY_SOFT.gross_tokens);
		assert.equal(config.commanderAdvisory.high.compactions, 10);
		assert.equal(config.commanderAdvisory.high.requests, DEFAULT_ADVISORY_HIGH.requests);
		assert.deepEqual(config.issues, [], "no issues for missing fields");
	});
});

test("loadProjectConfig: no commander key resolves to the documented defaults", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", "name: x\nprofile: generic\n");
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.deepEqual(config.commanderAdvisory, defaultAdvisoryConfig());
		assert.deepEqual(config.issues, []);
	});
});

test("loadProjectConfig: invalid values record bounded project.yaml ConfigIssue evidence and fall back to defaults", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"project.yaml",
			[
				"name: x",
				"profile: generic",
				"commander:",
				"  advisory:",
				"    soft:",
				"      requests: -5",
				"      gross_tokens: abc",
				"      output_tokens: 1.5",
				"      bogus: 3",
				"    high:",
				"      requests: 0",
				"",
			].join("\n"),
		);
		const config = await loadProjectConfig(dir, { trusted: true });
		const advisoryIssues = config.issues.filter((i) => i.file === "project.yaml");
		assert.ok(advisoryIssues.length >= 5, JSON.stringify(advisoryIssues));
		for (const needle of ["requests", "gross_tokens", "output_tokens", "bogus", "high"]) {
			assert.ok(advisoryIssues.some((i) => i.message.includes(needle)), `${needle}: ${JSON.stringify(advisoryIssues)}`);
		}
		// safe documented fallback — observability is never disabled
		assert.equal(config.commanderAdvisory.soft.requests, DEFAULT_ADVISORY_SOFT.requests);
		assert.equal(config.commanderAdvisory.soft.gross_tokens, DEFAULT_ADVISORY_SOFT.gross_tokens);
		assert.equal(config.commanderAdvisory.soft.output_tokens, DEFAULT_ADVISORY_SOFT.output_tokens);
		assert.equal(config.commanderAdvisory.high.requests, DEFAULT_ADVISORY_HIGH.requests);
		assert.ok(config.commanderAdvisory.high.requests > config.commanderAdvisory.soft.requests);
	});
});

test("loadProjectConfig: high<=soft ordering violations record an issue and fall back to both defaults", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"project.yaml",
			[
				"name: x",
				"profile: generic",
				"commander:",
				"  advisory:",
				"    soft:",
				"      requests: 500",
				"    high:",
				"      requests: 400",
				"",
			].join("\n"),
		);
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.ok(
			config.issues.some((i) => i.file === "project.yaml" && i.message.includes("high requests") && i.message.includes("greater than soft requests")),
			JSON.stringify(config.issues),
		);
		assert.equal(config.commanderAdvisory.soft.requests, DEFAULT_ADVISORY_SOFT.requests);
		assert.equal(config.commanderAdvisory.high.requests, DEFAULT_ADVISORY_HIGH.requests);
	});
});

test("loadProjectConfig: malformed commander/advisory shapes become issues and never throw", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"project.yaml",
			[
				"name: x",
				"profile: generic",
				"commander: just-a-string",
				"",
			].join("\n"),
		);
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.ok(
			config.issues.some((i) => i.file === "project.yaml" && i.message.includes('"commander" must be a mapping')),
			JSON.stringify(config.issues),
		);
		assert.deepEqual(config.commanderAdvisory, defaultAdvisoryConfig());
	});
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"project.yaml",
			[
				"name: x",
				"profile: generic",
				"commander:",
				"  advisory: [1, 2, 3]",
				"",
			].join("\n"),
		);
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.ok(
			config.issues.some((i) => i.file === "project.yaml" && i.message.includes('"commander.advisory" must be a mapping')),
			JSON.stringify(config.issues),
		);
		assert.deepEqual(config.commanderAdvisory, defaultAdvisoryConfig());
	});
	await withTempDir(async (dir) => {
		// worst-case adversarial config still resolves with defaults
		await writeConfigFile(
			dir,
			"project.yaml",
			[
				"name: x",
				"profile: generic",
				"commander:",
				"  advisory:",
				"    soft:",
				"      requests: -1",
				"      gross_tokens: .inf",
				"      output_tokens: '200'",
				"      tool_text_bytes: true",
				"      compactions: 1.5",
				"    high:",
				"      requests: 1",
				"      gross_tokens: -2",
				"      bogus: 9",
				"",
			].join("\n"),
		);
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.deepEqual(config.commanderAdvisory, defaultAdvisoryConfig());
		assert.ok(config.issues.length >= 6, JSON.stringify(config.issues));
	});
});

// ------------------------------------------------------- footer wiring (P7)

test("footer appends CMD:SOFT driven by the pending-message-aware session breakdown (defaults)", async () => {
	await withTempDir(async (dir) => {
		const { stub, state } = makeRuntimeStub();
		workbenchRuntime(stub);
		const statuses = new Map<string, string>();
		// no persisted entries yet — the pending assistant message (gross 26M
		// >= soft 25M) must be visible exactly like the COST segment
		const ctx = fakeEventCtx({ entries: [], cwd: dir, trusted: true, statuses, notified: [] });
		const result = await driveMessageEnd(state, ctx, pendingHugeMessage(1));
		assert.equal(result, undefined, "message_end completes without cancelling");
		const line = statuses.get("workbench") ?? "";
		assert.ok(line.includes("COST S:$19.195"), `COST segment from the same breakdown: ${line}`);
		assert.ok(line.includes("CMD:SOFT"), `advisory segment appended: ${line}`);
	});
});

test("footer uses the existing pending-message dedup semantics (pending + persisted counted once)", async () => {
	await withTempDir(async (dir) => {
		const { stub, state } = makeRuntimeStub();
		workbenchRuntime(stub);
		// Pi 0.83 persists message_end after handlers: the second refresh sees
		// the same message BOTH persisted and pending — the breakdown must
		// count it exactly once, so COST and CMD stay identical.
		const pending = pendingHugeMessage(42);
		const persistedEntries = [{ type: "message", message: { ...pending } }];
		const statuses = new Map<string, string>();
		const ctx = fakeEventCtx({ entries: persistedEntries, cwd: dir, trusted: true, statuses, notified: [] });
		await driveMessageEnd(state, ctx, pending);
		const line = statuses.get("workbench") ?? "";
		assert.ok(line.includes("COST S:$19.195"), `deduped COST: ${line}`);
		assert.ok(line.includes("CMD:SOFT"), `deduped advisory: ${line}`);
		assert.equal(line.match(/COST S:/g)?.length, 1, "one COST segment");
		assert.equal(line.match(/CMD:SOFT/g)?.length, 1, "one advisory segment");
	});
});

test("footer honors trusted commander.advisory thresholds (best-effort config)", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"project.yaml",
			[
				"name: x",
				"profile: generic",
				"commander:",
				"  advisory:",
				"    soft:",
				"      requests: 1",
				"    high:",
				"      requests: 2",
				"",
			].join("\n"),
		);
		const { stub, state } = makeRuntimeStub();
		workbenchRuntime(stub);
		const statuses = new Map<string, string>();
		// Pi 0.83 persists message_end AFTER the handlers run, so the runtime
		// never accumulates session state by itself: model real persistence
		// with a mutable entries array — after the first message_end the
		// finished first message is persisted into entries, and the second
		// message is then seen as pending (counted exactly once).
		const entries: unknown[] = [];
		const firstMessage = {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			timestamp: 7,
			usage: usage(100, 10, 0, 0, 0.5),
		};
		const ctx = fakeEventCtx({ entries, cwd: dir, trusted: true, statuses, notified: [] });
		// a single assistant turn reaches the configured soft (requests 1)
		await driveMessageEnd(state, ctx, firstMessage);
		assert.ok((statuses.get("workbench") ?? "").includes("CMD:SOFT"), statuses.get("workbench"));
		// persist the first message (what Pi does after the handlers), then
		// send the second turn as pending — requests 2 reaches the configured
		// high exactly as in a real persisted session
		entries.push({ type: "message", message: firstMessage });
		await driveMessageEnd(state, ctx, {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			timestamp: 8,
			usage: usage(100, 10, 0, 0, 0.5),
		});
		assert.ok((statuses.get("workbench") ?? "").includes("CMD:HIGH"), statuses.get("workbench"));
	});
});

test("footer: OK session adds no advisory segment and keeps WB/COST behavior", async () => {
	await withTempDir(async (dir) => {
		const { stub, state } = makeRuntimeStub();
		workbenchRuntime(stub);
		const statuses = new Map<string, string>();
		const ctx = fakeEventCtx({
			entries: [assistant("openai-codex", "gpt-5.6-sol", usage(12000, 800, 45000, 0, 19.195))],
			cwd: dir,
			trusted: true,
			statuses,
			notified: [],
		});
		await driveMessageEnd(state, ctx, {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			timestamp: 3,
			usage: usage(10, 1, 0, 0, 0.01),
		});
		const line = statuses.get("workbench") ?? "";
		assert.ok(line.startsWith("WB:DEV"), `status line intact: ${line}`);
		assert.ok(line.includes("COST S:$19.205"), `COST preserved: ${line}`);
		assert.ok(!line.includes("CMD:"), `OK adds no advisory segment: ${line}`);
	});
});

test("footer degrades to defaults on untrusted/error config paths (never trust-gated)", async () => {
	await withTempDir(async (dir) => {
		const { stub, state } = makeRuntimeStub();
		workbenchRuntime(stub);
		const statuses = new Map<string, string>();
		// untrusted: no config read at all — defaults still drive the footer
		const ctx = fakeEventCtx({ entries: [], cwd: dir, trusted: false, statuses, notified: [] });
		await driveMessageEnd(state, ctx, pendingHugeMessage(5));
		assert.ok((statuses.get("workbench") ?? "").includes("CMD:SOFT"), "defaults apply without trust");
	});
});

// ------------------------------------------------------ /q-cost-status wiring

test("q-cost-status keeps the cost output and renders advisory facts in TUI mode with trusted config", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", FULL_ADVISORY_YAML);
		const { stub, state } = makeRuntimeStub();
		workbenchRuntime(stub);
		const def = state.commands.get("q-cost-status");
		assert.ok(def, "q-cost-status registered");
		const entries = [assistant("openai-codex", "gpt-5.6-sol", usage(600_000, 15_000, 500_000, 0, 2.5))];
		await def.handler("", fakeEventCtx({ entries, cwd: dir, trusted: true, statuses: new Map(), notified: state.notified }) as ExtensionCommandContext);
		assert.equal(state.notified.length, 1, "TUI output goes through ctx.ui.notify");
		const text = state.notified[0] ?? "";
		// existing cost output retained
		assert.ok(text.includes("session cost breakdown"), text);
		assert.ok(text.includes("$2.500"), text);
		assert.ok(text.includes("commander by model"), text);
		// advisory facts appended additively — configured thresholds drive the
		// band; requests 1 is below soft 10, so only gross_tokens and
		// output_tokens are SOFT and the fixed-order reasons name both
		assert.ok(text.includes("commander advisory (P7 observation-only"), text);
		assert.ok(text.includes("band            : SOFT"), text);
		assert.ok(text.includes("requests        : 1 (soft 10 / high 20)"), text);
		assert.ok(text.includes("gross_tokens    : 1115000 (soft 1000000 / high 2000000)"), text);
		assert.ok(text.includes("reasons         : gross_tokens (SOFT); output_tokens (SOFT)"), text);
	});
});

test("q-cost-status works in print mode via the stdout fallback with the advisory section", async () => {
	await withTempDir(async (dir) => {
		const { stub, state } = makeRuntimeStub();
		workbenchRuntime(stub);
		const def = state.commands.get("q-cost-status");
		assert.ok(def);
		const logs: string[] = [];
		const original = console.log;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		try {
			const entries = [assistant("openai-codex", "gpt-5.6-sol", usage(30_000_000, 100, 0, 0, 3.0))];
			// a real print-mode context (hasUI false) routes the output to stdout
			await def.handler("", fakeEventCtx({ entries, cwd: dir, trusted: true, statuses: new Map(), notified: [], mode: "print" }) as ExtensionCommandContext);
		} finally {
			console.log = original;
		}
		assert.equal(logs.length, 1, "print mode falls back to stdout");
		const text = logs[0] ?? "";
		assert.ok(text.includes("session cost breakdown"), text);
		assert.ok(text.includes("$3.000"), text);
		assert.ok(text.includes("commander advisory"), "advisory section present in print mode");
		assert.ok(text.includes("band            : SOFT"), `gross 30010100 is >= soft 25M and < high 40M: ${text}`);
	});
});

test("q-cost-status is never trust-gated: untrusted sessions render defaults", async () => {
	await withTempDir(async (dir) => {
		const { stub, state } = makeRuntimeStub();
		workbenchRuntime(stub);
		const def = state.commands.get("q-cost-status");
		assert.ok(def);
		const entries = [assistant("openai-codex", "gpt-5.6-sol", usage(100, 10, 0, 0, 0.5))];
		await def.handler("", fakeEventCtx({ entries, cwd: dir, trusted: false, statuses: new Map(), notified: state.notified }) as ExtensionCommandContext);
		const text = state.notified[0] ?? "";
		assert.ok(text.includes("commander advisory"), "advisory section renders without trust");
		assert.ok(text.includes("band            : OK"), "defaults apply (requests 1 < 200, gross 110 < 25M)");
		assert.ok(text.includes("requests        : 1 (soft 200 / high 300)"), "documented defaults shown");
	});
});

test("q-cost-status renders defaults (no crash) when the trusted config is malformed", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"project.yaml",
			[
				"name: x",
				"profile: generic",
				"commander:",
				"  advisory:",
				"    soft:",
				"      requests: -5",
				"      gross_tokens: .inf",
				"",
			].join("\n"),
		);
		const { stub, state } = makeRuntimeStub();
		workbenchRuntime(stub);
		const def = state.commands.get("q-cost-status");
		assert.ok(def);
		const entries = [assistant("openai-codex", "gpt-5.6-sol", usage(300, 10, 0, 0, 0.01))];
		await def.handler("", fakeEventCtx({ entries, cwd: dir, trusted: true, statuses: new Map(), notified: state.notified }) as ExtensionCommandContext);
		const text = state.notified[0] ?? "";
		assert.ok(text.includes("commander advisory"), text);
		assert.ok(text.includes("band            : OK"), text);
		assert.ok(text.includes("requests        : 1 (soft 200 / high 300)"), "documented default fallback rendered");
	});
});

test("q-cost-status with a HIGH band renders the complete cost section (no short-circuit)", async () => {
	await withTempDir(async (dir) => {
		const { stub, state } = makeRuntimeStub();
		workbenchRuntime(stub);
		const def = state.commands.get("q-cost-status");
		assert.ok(def);
		const entries = [
			assistant("openai-codex", "gpt-5.6-sol", usage(30_000_000, 11_000_000, 0, 0, 3.0)),
			{ type: "message", message: { role: "toolResult", toolName: "workbench_delegate_worker", usage: usage(100, 20, 0, 0, 0.063) } },
		];
		await def.handler("", fakeEventCtx({ entries, cwd: dir, trusted: true, statuses: new Map(), notified: state.notified }) as ExtensionCommandContext);
		const text = state.notified[0] ?? "";
		assert.ok(text.includes("band            : HIGH"), "gross 41M >= high 40M");
		// gross (41M) AND output (11M) are both HIGH — the fixed-order reasons
		// assert both, never gross alone
		assert.ok(text.includes("reasons         : gross_tokens (HIGH); output_tokens (HIGH)"), text);
		assert.ok(text.includes("session cost breakdown"), "cost section fully rendered");
		assert.ok(text.includes("$3.063"), "total row still exact");
		assert.ok(text.includes("total"), text);
	});
});

// --------------------------------------------- advisory-only continuation proof

test("advisory paths never enforce and preserve the exact 30-command surface including R8 observation-only status", async () => {
	await withTempDir(async (dir) => {
		const { stub, state } = makeRuntimeStub();
		workbenchRuntime(stub);
		const statuses = new Map<string, string>();
		const ctx = fakeEventCtx({ entries: [], cwd: dir, trusted: true, statuses, notified: [] });
		// a HIGH-band session: message_end completes, sends nothing, cancels nothing
		const highMessage = {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			timestamp: 9,
			usage: usage(30_000_000, 100, 11_000_000, 0, 3.0), // gross 41,000,100 >= high 40M
		};
		const result = await driveMessageEnd(state, ctx, highMessage);
		assert.equal(result, undefined, "message_end returns undefined — no cancel/terminate signal");
		assert.equal(state.sentMessages, 0, "no steering message is ever sent by advisory paths");
		assert.ok((statuses.get("workbench") ?? "").includes("CMD:HIGH"), statuses.get("workbench"));
		// the tool_call guard is untouched by advisory state: a benign read
		// call in DEV still proceeds (no block, no short-circuit)
		assert.ok((state.handlers.get("tool_call")?.length ?? 0) > 0, "tool_call guard registered");
		const allowed = await driveFreshToolCall(state, ctx, "read", {});
		assert.equal(allowed, undefined, "normal tool calls proceed unchanged");
		// The exact additive R8 surface is preserved: one observation-only
		// context/output status command and no enforcement command.
		assert.deepEqual([...state.commands.keys()].sort(), [...EXPECTED_COMMANDS].sort());
		assert.ok(state.commands.has("q-context-output-status"), "R8 observation-only status command remains registered");
		assert.ok(state.commands.has("q-run") && state.commands.has("q-gate"), "existing commands intact");
	});
});
