/**
 * Split session-cost observability tests (Unreleased).
 *
 * Coverage:
 *   - classification: assistant => commander, workbench_delegate_worker
 *     toolResult => worker, other toolResult + branch_summary/compaction
 *     => other (mirrors Pi's footer loop exactly)
 *   - reconciliation: total === commander + worker + other EXACTLY, and the
 *     total equals a naive Pi-footer-style running sum over the same entries
 *   - commander-by-model grouping (provider/responseModel ?? model), sort,
 *     and zero-entry filter (same as Pi's getUsageCostBreakdown)
 *   - malformed / non-finite / negative values contribute zero, never NaN,
 *     never throw
 *   - token totals (Pi convention: input + output + cacheRead + cacheWrite)
 *   - formatting: formatCost / formatTokens (Pi footer mirror) / the
 *     deterministic COST status segment (O omitted when zero, S and W shown)
 *   - status integration: buildStatusLine appends the real segment
 *   - command inventory + behavior: the registered /q-cost-status handler
 *     prints exact commander/worker/other/total and per-model rows in TUI
 *     (notify) and print (stdout) modes
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	buildCostBreakdown,
	costStatusSegment,
	formatCost,
	formatTokens,
	renderCostBreakdown,
	WORKER_TOOL_NAME,
} from "../extensions/workbench-runtime/core/cost-breakdown.ts";
import { buildStatusLine } from "../extensions/workbench-runtime/core/status.ts";
import workbenchRuntime from "../extensions/workbench-runtime/index.ts";

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

function assistant(provider: string, model: string, u: unknown, responseModel?: string) {
	return { type: "message", message: { role: "assistant", provider, model, responseModel, usage: u } };
}

function toolResult(toolName: string, u: unknown) {
	return { type: "message", message: { role: "toolResult", toolName, usage: u } };
}

function branchSummary(u: unknown) {
	return { type: "branch_summary", fromId: "x", summary: "s", usage: u };
}

function compaction(u: unknown) {
	return { type: "compaction", summary: "s", firstKeptEntryId: "x", tokensBefore: 0, usage: u };
}

/** Naive Pi-footer-style aggregation (footer.js addUsageToTotals loop). */
function piFooterSum(entries: readonly unknown[]): { cost: number; tokens: number } {
	let cost = 0;
	let tokens = 0;
	for (const entry of entries) {
		const e = entry as { type?: unknown; message?: unknown; usage?: unknown };
		let u: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } } | undefined;
		if (e.type === "message" && typeof e.message === "object" && e.message !== null) {
			const m = e.message as { role?: unknown; usage?: unknown };
			if (m.role === "assistant") u = m.usage as typeof u;
			else if (m.role === "toolResult" && m.usage) u = m.usage as typeof u;
		} else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) {
			u = e.usage as typeof u;
		}
		if (!u) continue;
		const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		cost += num(u.cost?.total);
		tokens += num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
	}
	return { cost, tokens };
}

// ------------------------------------------------------- classification

test("assistant usage lands in the commander bucket; provider/responseModel-or-model key", () => {
	const entries = [
		assistant("openai-codex", "gpt-5.6-sol", usage(100, 50, 0, 0, 0.42), "gpt-5.6-sol"),
		assistant("openai", "gpt-5.6-sol", usage(10, 5, 0, 0, 0.001)),
	];
	const b = buildCostBreakdown(entries);
	assert.ok(Math.abs(b.commander.cost - 0.421) < 1e-9, String(b.commander.cost));
	assert.equal(b.worker.cost, 0);
	assert.equal(b.other.cost, 0);
	assert.deepEqual(
		b.commanderByModel.map((m) => m.key),
		["openai-codex/gpt-5.6-sol", "openai/gpt-5.6-sol"],
		"responseModel ?? model is used for the key",
	);
});

test("workbench_delegate_worker toolResult usage lands in the worker bucket", () => {
	const entries = [toolResult(WORKER_TOOL_NAME, usage(5000, 300, 10000, 0, 0.063))];
	const b = buildCostBreakdown(entries);
	assert.equal(b.worker.cost, 0.063);
	assert.equal(b.worker.input, 5000);
	assert.equal(b.worker.cacheRead, 10000);
	assert.equal(b.commander.cost, 0);
	assert.equal(b.other.cost, 0);
});

test("other toolResult usage and branch_summary/compaction usage land in the other bucket", () => {
	const entries = [
		toolResult("workbench_run_recipe", usage(100, 20, 0, 0, 0.01)),
		toolResult("read", usage(50, 0, 0, 0, 0.002)),
		branchSummary(usage(200, 40, 0, 0, 0.02)),
		compaction(usage(300, 60, 0, 0, 0.03)),
	];
	const b = buildCostBreakdown(entries);
	assert.equal(b.other.cost, 0.01 + 0.002 + 0.02 + 0.03);
	assert.equal(b.commander.cost, 0);
	assert.equal(b.worker.cost, 0);
});

test("non-cost entries (custom, user messages, labels) are ignored", () => {
	const entries = [
		{ type: "custom", customType: "workbench-mode", data: { mode: "DEV" } },
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "label", targetId: "x", label: "l" },
		{ type: "session_info", name: "s" },
		{ type: "thinking_level_change", thinkingLevel: "high" },
		{ type: "model_change", provider: "p", modelId: "m" },
		null,
		"garbage",
		42,
	];
	const b = buildCostBreakdown(entries);
	assert.equal(b.commander.cost, 0);
	assert.equal(b.worker.cost, 0);
	assert.equal(b.other.cost, 0);
	assert.equal(b.total.cost, 0);
	assert.equal(b.commanderByModel.length, 0);
});

// ------------------------------------------------------ reconciliation

test("total is EXACTLY commander + worker + other (cost and tokens)", () => {
	const entries = [
		assistant("openai-codex", "gpt-5.6-sol", usage(12000, 800, 45000, 0, 19.195)),
		toolResult(WORKER_TOOL_NAME, usage(5000, 300, 10000, 0, 0.063)),
		toolResult("workbench_run_recipe", usage(300, 40, 0, 0, 0.031)),
		branchSummary(usage(2000, 150, 0, 0, 0.393)),
		compaction(usage(500, 60, 0, 0, 0.0)),
	];
	const b = buildCostBreakdown(entries);
	const expected = { ...b.commander };
	expected.cost = b.commander.cost + b.worker.cost + b.other.cost;
	expected.tokens = b.commander.tokens + b.worker.tokens + b.other.tokens;
	expected.input = b.commander.input + b.worker.input + b.other.input;
	expected.output = b.commander.output + b.worker.output + b.other.output;
	expected.cacheRead = b.commander.cacheRead + b.worker.cacheRead + b.other.cacheRead;
	expected.cacheWrite = b.commander.cacheWrite + b.worker.cacheWrite + b.other.cacheWrite;
	assert.deepEqual(b.total, expected);
	assert.equal(b.total.cost, b.commander.cost + b.worker.cost + b.other.cost);
	assert.equal(b.total.tokens, b.commander.tokens + b.worker.tokens + b.other.tokens);
});

test("pending message_end usage is current and included exactly once", () => {
	const pendingAssistant = {
		role: "assistant",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		timestamp: 123,
		usage: usage(100, 10, 200, 0, 0.5),
	};
	const beforePersistence = buildCostBreakdown([], pendingAssistant);
	assert.equal(beforePersistence.commander.cost, 0.5);
	assert.equal(beforePersistence.total.tokens, 310);

	const persisted = [{ type: "message", message: { ...pendingAssistant } }];
	const afterPersistence = buildCostBreakdown(persisted, pendingAssistant);
	assert.equal(afterPersistence.commander.cost, 0.5, "timestamp+role dedupe prevents double counting");
	assert.equal(afterPersistence.total.tokens, 310);

	const pendingWorker = {
		role: "toolResult",
		toolName: WORKER_TOOL_NAME,
		timestamp: 124,
		usage: usage(50, 5, 100, 0, 0.02),
	};
	const worker = buildCostBreakdown(persisted, pendingWorker);
	assert.equal(worker.commander.cost, 0.5);
	assert.equal(worker.worker.cost, 0.02, "worker tool-result message is visible immediately");
});

test("valid data matches Pi's default footer aggregation exactly", () => {
	const entries = [
		assistant("openai-codex", "gpt-5.6-sol", usage(12000, 800, 45000, 0, 19.195)),
		toolResult(WORKER_TOOL_NAME, usage(5000, 300, 10000, 0, 0.063)),
		toolResult("workbench_run_recipe", usage(300, 40, 0, 0, 0.031)),
		branchSummary(usage(2000, 150, 0, 0, 0.393)),
		compaction(usage(500, 60, 0, 0, 0.0)),
		assistant("deepseek", "deepseek-v4-flash", usage(8000, 500, 0, 0, 0.02)),
		{ type: "custom", customType: "workbench-cache-state", data: {} },
	];
	const b = buildCostBreakdown(entries);
	const naive = piFooterSum(entries);
	// the bucket-sum total matches Pi's running-sum footer up to float
	// association; the RENDERED totals are identical at $0.001 precision
	assert.ok(Math.abs(b.total.cost - naive.cost) < 1e-9, `cost ${b.total.cost} vs ${naive.cost}`);
	assert.equal(b.total.cost.toFixed(3), naive.cost.toFixed(3), "rendered cost identical to Pi's footer");
	assert.equal(b.total.tokens, naive.tokens, "tokens must match the naive Pi footer sum");
	// buckets sum to the same naive total
	assert.ok(Math.abs(b.commander.cost + b.worker.cost + b.other.cost - naive.cost) < 1e-9);
	assert.equal(b.commander.tokens + b.worker.tokens + b.other.tokens, naive.tokens);
});

// ------------------------------------------------ commander by model

test("commander-by-model: key uses responseModel ?? model, sorted by cost desc, zero entries filtered", () => {
	const entries = [
		assistant("openai-codex", "gpt-5.6-sol", usage(100, 10, 0, 0, 0.005), "gpt-5.6-sol"),
		assistant("deepseek", "deepseek-v4-flash", usage(1000, 100, 0, 0, 0.05)),
		assistant("openai", "gpt-5.6-sol", usage(50, 5, 0, 0, 0.001)),
		// zero cost AND zero tokens -> filtered out entirely (Pi's rule)
		assistant("anthropic", "claude", usage(0, 0, 0, 0, 0)),
	];
	const b = buildCostBreakdown(entries);
	assert.deepEqual(
		b.commanderByModel.map((m) => [m.key, m.cost]),
		[
			["deepseek/deepseek-v4-flash", 0.05],
			["openai-codex/gpt-5.6-sol", 0.005],
			["openai/gpt-5.6-sol", 0.001],
		],
		"cost-descending, zero entries dropped",
	);
	assert.ok(Math.abs(b.commander.cost - 0.056) < 1e-9, String(b.commander.cost));
	// a zero-cost entry WITH tokens is still listed (Pi's cost>0 || tokens>0)
	const withTokens = buildCostBreakdown([assistant("openai", "gpt-5.6-sol", usage(10, 0, 0, 0, 0))]);
	assert.equal(withTokens.commanderByModel.length, 1);
	assert.equal(withTokens.commanderByModel[0]!.tokens, 10);
});

// ------------------------------------------------ malformed values

test("malformed usage values contribute zero (never NaN, never throw); valid fields still count", () => {
	const malformed = [
		assistant("openai-codex", "gpt-5.6-sol", {
			input: Number.NaN,
			output: Number.POSITIVE_INFINITY,
			cacheRead: -5,
			cacheWrite: "many",
			totalTokens: 0,
			cost: { total: Number.NaN },
		}),
		// negative cost/output are dropped, but the valid input field counts
		assistant("openai", "gpt-5.6-sol", { input: 10, output: -1, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: -0.5 } }),
		toolResult(WORKER_TOOL_NAME, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: Number.POSITIVE_INFINITY } }),
		toolResult("read", "not-an-usage-object"),
		branchSummary(null),
		compaction({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: undefined } }),
	];
	const b = buildCostBreakdown(malformed);
	// no bucket ever carries NaN/Infinity cost; invalid fields contribute zero
	for (const bucket of [b.commander, b.worker, b.other, b.total]) {
		assert.equal(bucket.cost, 0);
		assert.ok(Number.isFinite(bucket.cost));
		assert.ok(Number.isFinite(bucket.tokens));
	}
	// valid token fields from otherwise-malformed entries still contribute
	assert.equal(b.commander.tokens, 10);
	assert.equal(b.worker.tokens, 10);
	assert.equal(b.other.tokens, 0);
	assert.equal(b.total.tokens, 20);
	// the zero-cost-but-tokens commander entry is still listed (Pi's rule)
	assert.deepEqual(b.commanderByModel, [{ key: "openai/gpt-5.6-sol", cost: 0, tokens: 10 }]);
});

test("assistant message without a usage object contributes zero instead of crashing", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol" } },
		{ type: "message", message: { role: "assistant", provider: "openai", model: "gpt-5.6-sol", usage: undefined } },
	];
	const b = buildCostBreakdown(entries);
	assert.equal(b.commander.cost, 0);
	assert.equal(b.total.cost, 0);
});

test("negative cost contributes zero while positive entries still count", () => {
	const entries = [
		assistant("openai-codex", "gpt-5.6-sol", usage(100, 10, 0, 0, -3.0)),
		assistant("openai-codex", "gpt-5.6-sol", usage(100, 10, 0, 0, 1.5)),
	];
	const b = buildCostBreakdown(entries);
	assert.equal(b.commander.cost, 1.5, "negative cost is dropped, positive kept");
	assert.equal(b.total.cost, 1.5);
});

// -------------------------------------------------- token totals

test("token totals use Pi's convention: input + output + cacheRead + cacheWrite", () => {
	const entries = [
		assistant("openai-codex", "gpt-5.6-sol", usage(12000, 800, 45000, 0, 1)),
		toolResult(WORKER_TOOL_NAME, usage(5000, 300, 10000, 0, 1)),
		toolResult("read", usage(300, 40, 0, 0, 1)),
	];
	const b = buildCostBreakdown(entries);
	assert.equal(b.commander.tokens, 12000 + 800 + 45000);
	assert.equal(b.worker.tokens, 5000 + 300 + 10000);
	assert.equal(b.other.tokens, 300 + 40);
	assert.equal(b.total.tokens, b.commander.tokens + b.worker.tokens + b.other.tokens);
	assert.equal(b.total.input, 12000 + 5000 + 300);
	assert.equal(b.total.cacheRead, 45000 + 10000);
});

// ----------------------------------------------------- formatting

test("formatCost renders Pi's footer dollar format ($x.xxx)", () => {
	assert.equal(formatCost(19.195), "$19.195");
	assert.equal(formatCost(0.063), "$0.063");
	assert.equal(formatCost(0), "$0.000");
	assert.equal(formatCost(Number.NaN), "$0.000");
	assert.equal(formatCost(Number.POSITIVE_INFINITY), "$0.000");
});

test("formatTokens mirrors Pi's footer formatTokens exactly", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(9999), "10.0k");
	assert.equal(formatTokens(12345), "12k");
	assert.equal(formatTokens(999999), "1000k");
	assert.equal(formatTokens(1234567), "1.2M");
	assert.equal(formatTokens(12345678), "12M");
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(Number.NaN), "0");
	assert.equal(formatTokens(-5), "0");
});

test("costStatusSegment: S and W always shown, O omitted when zero, hidden with no facts", () => {
	const b = buildCostBreakdown([
		assistant("openai-codex", "gpt-5.6-sol", usage(12000, 800, 45000, 0, 19.195)),
		toolResult(WORKER_TOOL_NAME, usage(5000, 300, 10000, 0, 0.063)),
		toolResult("workbench_run_recipe", usage(300, 40, 0, 0, 0.424)),
	]);
	assert.equal(costStatusSegment(b), "COST S:$19.195 W:$0.063 O:$0.424");

	// O omitted when zero — S and W still shown
	const noOther = buildCostBreakdown([
		assistant("openai-codex", "gpt-5.6-sol", usage(12000, 800, 45000, 0, 19.195)),
		toolResult(WORKER_TOOL_NAME, usage(5000, 300, 10000, 0, 0.063)),
	]);
	assert.equal(costStatusSegment(noOther), "COST S:$19.195 W:$0.063");

	// W shown even at zero when S has cost
	const noWorker = buildCostBreakdown([assistant("openai-codex", "gpt-5.6-sol", usage(100, 10, 0, 0, 1))]);
	assert.equal(costStatusSegment(noWorker), "COST S:$1.000 W:$0.000");

	// S shown even at zero when W has cost
	const noCommander = buildCostBreakdown([toolResult(WORKER_TOOL_NAME, usage(100, 10, 0, 0, 0.5))]);
	assert.equal(costStatusSegment(noCommander), "COST S:$0.000 W:$0.500");

	// O with tokens but zero cost is still omitted (segment shows costs)
	const zeroCostOther = buildCostBreakdown([
		assistant("openai-codex", "gpt-5.6-sol", usage(100, 10, 0, 0, 1)),
		toolResult("read", usage(50, 0, 0, 0, 0)),
	]);
	assert.equal(costStatusSegment(zeroCostOther), "COST S:$1.000 W:$0.000");

	// no facts at all -> no segment
	assert.equal(costStatusSegment(buildCostBreakdown([])), undefined);
	assert.equal(costStatusSegment(buildCostBreakdown([{ type: "custom", customType: "x" }])), undefined);
});

// ------------------------------------------------- status integration

test("buildStatusLine appends the real COST segment after the CACHE segment", () => {
	const breakdown = buildCostBreakdown([
		assistant("openai-codex", "gpt-5.6-sol", usage(12000, 800, 45000, 0, 19.195)),
		toolResult(WORKER_TOOL_NAME, usage(5000, 300, 10000, 0, 0.063)),
		toolResult("read", usage(300, 40, 0, 0, 0.424)),
	]);
	const line = buildStatusLine({
		mode: "VERIFY",
		profile: "generic",
		cache: "CACHE 72% | read 40k | miss 12k",
		cost: costStatusSegment(breakdown),
	});
	assert.equal(line, "WB:VERIFY | generic | CACHE 72% | read 40k | miss 12k | COST S:$19.195 W:$0.063 O:$0.424");
	// without a cost segment the line is unchanged
	assert.equal(buildStatusLine({ mode: "VERIFY", cost: undefined }), "WB:VERIFY");
});

test("renderCostBreakdown prints exact buckets, total, and per-model rows", () => {
	const breakdown = buildCostBreakdown([
		assistant("openai-codex", "gpt-5.6-sol", usage(12000, 800, 45000, 0, 19.195)),
		assistant("deepseek", "deepseek-v4-flash", usage(1000, 100, 0, 0, 0.05)),
		toolResult(WORKER_TOOL_NAME, usage(5000, 300, 10000, 0, 0.063)),
		toolResult("workbench_run_recipe", usage(300, 40, 0, 0, 0.031)),
		branchSummary(usage(2000, 150, 0, 0, 0.393)),
	]);
	const lines = renderCostBreakdown(breakdown);
	const text = lines.join("\n");
	assert.ok(text.includes("commander"), text);
	assert.ok(text.includes("worker"), text);
	assert.ok(text.includes("other"), text);
	assert.ok(text.includes("total"), text);
	assert.ok(text.includes("$19.195"), text); // openai-codex by-model row
	assert.ok(text.includes("$0.063"), text);
	assert.ok(text.includes("$0.424"), text); // 0.031 + 0.393
	assert.ok(text.includes("$19.732"), text); // exact total = 19.195 + 0.05 + 0.063 + 0.424
	assert.ok(text.includes("openai-codex/gpt-5.6-sol"), text);
	assert.ok(text.includes("deepseek/deepseek-v4-flash"), text);
	assert.ok(text.includes("tokens"), text);
	assert.ok(/^\s*[ -~]+$/m.test(text), "ASCII-only rendering");
	const empty = renderCostBreakdown(buildCostBreakdown([]));
	assert.ok(empty.some((l) => l.includes("(no assistant usage)")), empty.join("\n"));
});

// ----------------------------------------------- command inventory

function makeCommandStub(): {
	stub: ExtensionAPI & Record<string, unknown>;
	commands: Map<string, { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
} {
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const tools = new Map<string, unknown>();
	const events = new Map<string, number>();
	const stub = {
		registerCommand: (name: string, def: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			commands.set(name, def);
		},
		registerTool: (def: { name: string }) => {
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
	return { stub: stub as unknown as ExtensionAPI & Record<string, unknown>, commands };
}

function fakeCommandCtx(
	entries: readonly unknown[],
	opts: { mode: "tui" | "print"; hasUI: boolean; notified: string[] },
): ExtensionCommandContext {
	return {
		mode: opts.mode,
		hasUI: opts.hasUI,
		cwd: "/tmp/workbench-project",
		isProjectTrusted: () => true,
		sessionManager: { getEntries: () => entries },
		model: undefined,
		thinkingLevel: undefined,
		ui: {
			notify: (text: string) => {
				opts.notified.push(text);
			},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => false,
		},
		signal: undefined,
	} as unknown as ExtensionCommandContext;
}

test("q-cost-status is registered with a description", () => {
	const { stub, commands } = makeCommandStub();
	workbenchRuntime(stub);
	const def = commands.get("q-cost-status");
	assert.ok(def, "q-cost-status must be registered");
	assert.ok((def.description ?? "").length > 10, "description present");
});

test("q-cost-status prints commander/worker/other/total and per-model costs in TUI mode", async () => {
	const { stub, commands } = makeCommandStub();
	workbenchRuntime(stub);
	const def = commands.get("q-cost-status");
	assert.ok(def);
	const entries = [
		assistant("openai-codex", "gpt-5.6-sol", usage(12000, 800, 45000, 0, 19.195)),
		assistant("deepseek", "deepseek-v4-flash", usage(1000, 100, 0, 0, 0.05)),
		toolResult(WORKER_TOOL_NAME, usage(5000, 300, 10000, 0, 0.063)),
		toolResult("workbench_run_recipe", usage(300, 40, 0, 0, 0.031)),
		branchSummary(usage(2000, 150, 0, 0, 0.393)),
	];
	const notified: string[] = [];
	await def.handler("", fakeCommandCtx(entries, { mode: "tui", hasUI: true, notified }));
	assert.equal(notified.length, 1, "TUI output goes through ctx.ui.notify");
	const text = notified[0] ?? "";
	assert.ok(text.includes("$19.245"), text); // commander = 19.195 + 0.05
	assert.ok(text.includes("$0.063"), text);
	assert.ok(text.includes("$0.424"), text); // other = 0.031 + 0.393
	assert.ok(text.includes("$19.732"), text); // total = 19.245 + 0.063 + 0.424
	assert.ok(text.includes("openai-codex/gpt-5.6-sol"), text);
	assert.ok(text.includes("deepseek/deepseek-v4-flash"), text);
});

test("q-cost-status works in print mode via the stdout fallback", async () => {
	const { stub, commands } = makeCommandStub();
	workbenchRuntime(stub);
	const def = commands.get("q-cost-status");
	assert.ok(def);
	const entries = [
		assistant("openai-codex", "gpt-5.6-sol", usage(12000, 800, 45000, 0, 19.195)),
		toolResult(WORKER_TOOL_NAME, usage(5000, 300, 10000, 0, 0.063)),
	];
	const logs: string[] = [];
	const original = console.log;
	console.log = (value?: unknown) => {
		logs.push(String(value));
	};
	try {
		await def.handler("", fakeCommandCtx(entries, { mode: "print", hasUI: false, notified: [] }));
	} finally {
		console.log = original;
	}
	assert.equal(logs.length, 1, "print mode falls back to stdout");
	assert.ok((logs[0] ?? "").includes("commander"), logs[0]);
	assert.ok((logs[0] ?? "").includes("$19.195"), logs[0]);
});
