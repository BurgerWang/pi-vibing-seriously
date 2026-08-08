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
 *   - P0 exact commander gross facts rendering: full unabridged digits
 *     (exact gross = input + output + cacheRead + cacheWrite) even when the
 *     compact bucket row shows k/M; deterministic one-decimal cacheRead
 *     share (0.0%, 100.0%, explicit N/A on a zero gross); malformed /
 *     non-finite / negative counts never render NaN/Infinity; above-bound
 *     counts clamp to MAX_COMMANDER_COUNT_DISPLAY with an explicit note —
 *     every rendered line stays under the per-line byte bound and output
 *     is deterministic
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	buildCostBreakdown,
	costStatusSegment,
	formatCost,
	formatTokens,
	MAX_COMMANDER_COUNT_DISPLAY,
	MAX_TOOL_NAME_BYTES,
	MAX_TOOL_ROWS,
	renderCostBreakdown,
	toolResultTextBytes,
	WORKER_TOOL_NAME,
	type CostBreakdown,
	type CostTotals,
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

// ------------------------------------------------ P0 session facts (additive)

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** True when a string contains a lone (unpaired) UTF-16 surrogate. */
function hasLoneSurrogate(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function textToolResult(toolName: string, content?: unknown, extra: Record<string, unknown> = {}) {
	return { type: "message", message: { role: "toolResult", toolName, content, ...extra } };
}

test("commanderRequests counts every commander assistant turn exactly once, usage-independent", () => {
	const entries = [
		assistant("openai-codex", "gpt-5.6-sol", usage(100, 10, 0, 0, 0.5)),
		assistant("openai", "gpt-5.6-sol", undefined), // no usage object
		{ type: "message", message: { role: "assistant", provider: "openai", model: "gpt-5.6-sol", usage: null } },
		{ type: "message", message: { role: "user", content: "hi" } },
		toolResult("read", usage(1, 1, 0, 0, 0.01)),
	];
	const b = buildCostBreakdown(entries);
	assert.equal(b.commanderRequests, 3, "turns count even when usage facts are missing");
	assert.equal(b.commander.cost, 0.5, "cost semantics unchanged (usage-less turns add zero)");
	assert.equal(b.commander.tokens, 110);
	assert.equal(b.total.tokens, 112, "usage-less turns contribute zero tokens");
});

test("compactions counts exactly the compaction entries, usage-independent", () => {
	const entries = [
		compaction(usage(10, 5, 0, 0, 0.01)),
		{ type: "compaction", summary: "s", firstKeptEntryId: "x", tokensBefore: 0 }, // no usage
		compaction(usage(0, 0, 0, 0, 0)),
		branchSummary(usage(1, 1, 0, 0, 0.02)), // branch summaries are NOT compactions
	];
	const b = buildCostBreakdown(entries);
	assert.equal(b.compactions, 3);
	assert.equal(b.other.cost, 0.01 + 0.02, "cost semantics unchanged");
});

test("pending assistant message counts exactly once in commanderRequests (never double-counted)", () => {
	const pending = { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", timestamp: 123, usage: usage(10, 5, 0, 0, 0.1) };
	const beforePersistence = buildCostBreakdown([], pending);
	assert.equal(beforePersistence.commanderRequests, 1, "pending turn visible before persistence");
	assert.equal(beforePersistence.commander.cost, 0.1);
	// timestamp+role dedupe: the persisted copy is never double-counted
	const afterPersistence = buildCostBreakdown([{ type: "message", message: { ...pending } }], pending);
	assert.equal(afterPersistence.commanderRequests, 1);
	assert.equal(afterPersistence.commander.cost, 0.1);
	// identity dedupe (no timestamp): the same object is counted once
	const untimestamped = { role: "assistant", provider: "p", model: "m", usage: usage(1, 1, 0, 0, 0.01) };
	const identity = buildCostBreakdown([{ type: "message", message: untimestamped }], untimestamped);
	assert.equal(identity.commanderRequests, 1);
	assert.equal(identity.commander.cost, 0.01);
});

test("toolResultEntries counts every toolResult entry, usage-independent", () => {
	const entries = [
		toolResult("read", usage(10, 5, 0, 0, 0.01)),
		toolResult("workbench_run_recipe", undefined), // no usage object
		{ type: "message", message: { role: "toolResult", toolName: "ls" } }, // no usage at all
		{ type: "message", message: "not-an-object" }, // malformed -> never counted
		{ type: "message", message: { role: "user", content: "x" } }, // not a toolResult
		compaction(usage(1, 1, 0, 0, 0.02)),
	];
	const b = buildCostBreakdown(entries);
	assert.equal(b.toolResultEntries, 3, "entries that enter context count even without usage");
	assert.equal(b.other.cost, 0.01 + 0.02, "cost semantics unchanged (usage-less toolResults add zero)");
});

test("toolResultTextBytes: exact UTF-8 bytes for string and text-array content", () => {
	const stringEntry = textToolResult("read", "héllo🧪");
	assert.equal(toolResultTextBytes(stringEntry), byteLength("héllo🧪"));
	const arrayEntry = textToolResult("read", [
		{ type: "text", text: "abc" },
		{ type: "text", text: "é" },
		{ type: "image", image: "data:..." }, // non-text item ignored
		{ type: "text", text: "🧪" },
		"plain-string-item", // non-object item ignored
	]);
	assert.equal(toolResultTextBytes(arrayEntry), byteLength("abc") + byteLength("é") + byteLength("🧪"));
	// end-to-end through buildCostBreakdown
	const b = buildCostBreakdown([stringEntry, arrayEntry]);
	assert.equal(b.toolTextBytesTotal, toolResultTextBytes(stringEntry) + toolResultTextBytes(arrayEntry));
	assert.deepEqual(b.toolTextBytes, [{ toolName: "read", count: 2, textBytes: b.toolTextBytesTotal }]);
	assert.equal(b.toolResultEntries, 2);
});

test("non-text and malformed content contributes zero bytes and never throws", () => {
	const cases = [
		textToolResult("t", 42),
		textToolResult("t", null),
		textToolResult("t"),
		textToolResult("t", [{ type: "image", image: "x" }, { type: "text" }, 7, "s", null]),
		{ type: "message", message: { role: "assistant", content: "assistant text is never counted" } },
		{ type: "message", message: "broken" },
		"garbage",
		null,
		undefined,
	];
	for (const entry of cases) {
		assert.equal(toolResultTextBytes(entry), 0);
	}
	const b = buildCostBreakdown(cases);
	assert.equal(b.toolTextBytesTotal, 0);
	assert.equal(b.toolResultEntries, 4, "the four well-formed toolResult entries still count");
});

test("malformed tool results group under the (unknown) tool deterministically", () => {
	const entries = [
		textToolResult("", "empty name"),
		{ type: "message", message: { role: "toolResult", content: "no name" } },
		{ type: "message", message: { role: "toolResult", toolName: 42, content: "numeric name" } },
		textToolResult("read", "a"),
	];
	const b = buildCostBreakdown(entries);
	assert.deepEqual(b.toolTextBytes, [
		{ toolName: "(unknown)", count: 3, textBytes: byteLength("empty name") + byteLength("no name") + byteLength("numeric name") },
		{ toolName: "read", count: 1, textBytes: 1 },
	]);
	assert.equal(b.toolResultEntries, 4);
});

test("toolTextBytes structured ordering is stable and entry-order independent", () => {
	const a = [textToolResult("zeta", "zz"), textToolResult("alpha", "aa"), textToolResult("zeta", "z")];
	const b1 = buildCostBreakdown(a);
	const b2 = buildCostBreakdown([a[2]!, a[0]!, a[1]!]);
	assert.deepEqual(b1.toolTextBytes, b2.toolTextBytes, "toolName code-unit order, independent of entry order");
	assert.deepEqual(b1.toolTextBytes, [
		{ toolName: "alpha", count: 1, textBytes: 2 },
		{ toolName: "zeta", count: 2, textBytes: 3 },
	]);
	assert.equal(b1.toolResultEntries, 3);
	assert.equal(b1.toolTextBytesTotal, 5);
});

test("total reconciliation holds with the P0 facts", () => {
	const entries = [
		assistant("openai-codex", "gpt-5.6-sol", usage(12000, 800, 45000, 0, 19.195)),
		toolResult(WORKER_TOOL_NAME, usage(5000, 300, 10000, 0, 0.063)),
		textToolResult("workbench_run_recipe", "résultat🧪"),
		textToolResult("read", [{ type: "text", text: "abc" }]),
		compaction(usage(500, 60, 0, 0, 0.0)),
	];
	const b = buildCostBreakdown(entries);
	assert.equal(b.toolResultEntries, b.toolTextBytes.reduce((acc, e) => acc + e.count, 0));
	assert.equal(b.toolTextBytesTotal, b.toolTextBytes.reduce((acc, e) => acc + e.textBytes, 0));
	const direct = entries.reduce((acc, e) => acc + toolResultTextBytes(e), 0);
	assert.equal(b.toolTextBytesTotal, direct, "structured total equals the per-entry sum");
	// the P0 facts never disturb the exact cost/token buckets
	assert.equal(b.commander.cost, 19.195);
	assert.equal(b.worker.cost, 0.063);
	assert.equal(b.total.tokens, b.commander.tokens + b.worker.tokens + b.other.tokens);
});

test("ranked per-tool rendering: huge/control tool names bounded with omission facts; no result text leaks", () => {
	const hugeName = "x".repeat(10_000);
	const controlName = "evil\u0007name\nline2";
	const entries = [
		textToolResult(hugeName, "SECRET-RESULT-TEXT-1", { arguments: { path: "SECRET-ARG-MARKER-1" } }),
		textToolResult(controlName, "SECRET-RESULT-TEXT-2"),
	];
	const b = buildCostBreakdown(entries);
	const lines = renderCostBreakdown(b);
	const text = lines.join("\n");
	assert.ok(!text.includes("\u0007"), "control characters are sanitized");
	assert.ok(lines.every((line) => !line.includes("\n")), "a tool name can never inject extra lines");
	assert.ok(!text.includes(hugeName), "the 10KB raw name is never rendered");
	assert.ok(!text.includes(controlName), "the raw control-character name is never rendered");
	assert.ok(!text.includes("SECRET-RESULT-TEXT"), "result text is never rendered");
	assert.ok(!text.includes("SECRET-ARG-MARKER"), "tool arguments are never rendered");
	assert.ok(text.includes("(+2 tool name(s) bounded for display — exact names in the toolTextBytes fields)"), text);
	assert.ok(lines.every((l) => byteLength(l) < 200), "every rendered line stays small");
	// the exact structured facts are untouched by display bounding (toolName
	// code-unit order: "evil…" sorts before "xxx…")
	assert.equal(b.toolTextBytes[0]!.toolName, controlName);
	assert.equal(b.toolTextBytes[1]!.toolName, hugeName);
	assert.equal(b.toolTextBytesTotal, byteLength("SECRET-RESULT-TEXT-1") + byteLength("SECRET-RESULT-TEXT-2"));
});

test("bounded tool-name display is byte-exact and code-point safe", () => {
	const astralName = "🧪".repeat(50);
	const b = buildCostBreakdown([textToolResult(astralName, "abc")]);
	const lines = renderCostBreakdown(b);
	const row = lines.find((line) => line.includes(" calls, "))!;
	assert.ok(row.includes("…"), `explicit marker on the truncated name: ${row}`);
	// the rendered name portion is <= MAX_TOOL_NAME_BYTES UTF-8 bytes (29 + the
	// 3-byte "…"; astral code points keep 4-byte granularity, never a split)
	const namePortion = row.trim().split(" ")[0]!;
	assert.ok(byteLength(namePortion) <= MAX_TOOL_NAME_BYTES, `name bounded to ${MAX_TOOL_NAME_BYTES} UTF-8 bytes`);
	assert.ok(byteLength(namePortion) >= MAX_TOOL_NAME_BYTES - 4, "truncation keeps as much of the name as fits");
	assert.ok(!hasLoneSurrogate(row), "no split surrogate pairs");
});

test("maxToolRows clamps: malformed/Infinity/huge options never produce unbounded output; exact omission counts", () => {
	const entries: unknown[] = [];
	for (let i = 0; i < 100; i++) {
		entries.push(textToolResult(`tool-${String(i).padStart(3, "0")}`, "abc"));
	}
	const b = buildCostBreakdown(entries);
	assert.equal(b.toolTextBytes.length, 100);
	const rowsOf = (lines: string[]): number => lines.filter((l) => l.includes(" calls, ")).length;
	for (const opts of [
		undefined,
		{ maxToolRows: Number.POSITIVE_INFINITY },
		{ maxToolRows: Number.NaN },
		{ maxToolRows: -7 },
		{ maxToolRows: "12" as never },
		{ maxToolRows: 1e9 },
	]) {
		const lines = renderCostBreakdown(b, opts);
		assert.ok(rowsOf(lines) <= MAX_TOOL_ROWS, `rows bounded for ${String(opts)}: ${rowsOf(lines)}`);
		assert.ok(
			lines.some((l) => l.includes("more tools omitted — bounded display; exact facts in the toolTextBytes fields")),
			String(opts),
		);
	}
	// exact counts: default 12 rows / 88 omitted; 0 -> no rows / 100 omitted;
	// valid 3 -> 3 rows / 97 omitted; huge -> clamped to MAX_TOOL_ROWS / 60 omitted
	const def = renderCostBreakdown(b);
	assert.equal(rowsOf(def), 12);
	assert.ok(def.some((l) => l.includes("(+88 more tools omitted")));
	const zero = renderCostBreakdown(b, { maxToolRows: 0 });
	assert.equal(rowsOf(zero), 0);
	assert.ok(zero.some((l) => l.includes("(+100 more tools omitted")));
	const three = renderCostBreakdown(b, { maxToolRows: 3 });
	assert.equal(rowsOf(three), 3);
	assert.ok(three.some((l) => l.includes("(+97 more tools omitted")));
	const maxed = renderCostBreakdown(b, { maxToolRows: 1e9 });
	assert.equal(rowsOf(maxed), MAX_TOOL_ROWS);
	assert.ok(maxed.some((l) => l.includes("(+60 more tools omitted")));
	// ranked order: equal text bytes -> toolName ascending (deterministic)
	const names = three
		.filter((l) => l.includes(" calls, "))
		.map((l) => l.trim().split(" ")[0]!);
	assert.deepEqual(names, ["tool-000", "tool-001", "tool-002"]);
});

test("model keys are sanitized and bounded with an explicit omission fact", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", provider: "p\u0007evil\nprovider", model: "m".repeat(500), usage: usage(1, 1, 0, 0, 0.01) } },
	];
	const b = buildCostBreakdown(entries);
	assert.equal(b.commanderByModel.length, 1);
	assert.equal(b.commanderByModel[0]!.key, "p\u0007evil\nprovider/" + "m".repeat(500), "structured key stays exact");
	const lines = renderCostBreakdown(b);
	const text = lines.join("\n");
	assert.ok(lines.every((line) => !line.includes("\n") && !line.includes("\u0007")), "no injected lines/control chars");
	assert.ok(!text.includes("m".repeat(500)), "the raw 500-char model never appears");
	assert.ok(text.includes("(+1 model key(s) bounded for display — exact keys in the commanderByModel field)"), text);
});

test("renderCostBreakdown stays bounded and deterministic on a hand-crafted malformed breakdown", () => {
	const b = {
		commander: { cost: Number.NaN, tokens: Number.POSITIVE_INFINITY, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
		worker: { cost: -1, tokens: 5, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		other: { cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		total: { cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		commanderByModel: "not-an-array" as never,
		commanderRequests: Number.POSITIVE_INFINITY,
		compactions: -3,
		toolTextBytes: [
			{ toolName: "a\nb", count: Number.POSITIVE_INFINITY, textBytes: Number.NaN },
			{ toolName: 42 as never, count: "x" as never, textBytes: 7 },
			{ toolName: "c".repeat(5000), count: 1, textBytes: 3 },
		],
		toolResultEntries: Number.NaN,
		toolTextBytesTotal: Number.POSITIVE_INFINITY,
	} as unknown as CostBreakdown;
	const lines = renderCostBreakdown(b);
	const text = lines.join("\n");
	assert.ok(lines.every((line) => !line.includes("\n")), "no injected newlines");
	assert.ok(lines.every((line) => byteLength(line) < 200), "every line bounded");
	assert.ok(text.includes("(invalid)"), "non-string names render as (invalid)");
	assert.ok(text.includes("tool name(s) bounded for display"), text);
	assert.ok(text.includes("(no assistant usage)"), "non-array commanderByModel degrades safely");
	assert.equal(renderCostBreakdown(b).join("\n"), text, "deterministic");
});

// ---------------------------- P0 exact commander gross facts (rendering)

/** Minimal well-formed breakdown for renderer-focused defensive tests. */
function handCraftedBreakdown(commander: Record<string, unknown>): CostBreakdown {
	const base: CostTotals = { cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const commanderTotals = { ...base, ...commander } as unknown as CostTotals;
	return {
		commander: commanderTotals,
		worker: { ...base },
		other: { ...base },
		total: { ...commanderTotals }, // coherent hand-crafted reconciliation
		commanderByModel: [],
		commanderRequests: 0,
		compactions: 0,
		toolTextBytes: [],
		toolResultEntries: 0,
		toolTextBytesTotal: 0,
	};
}

/** The exact rendered commander gross-facts line for a breakdown. */
function grossLineOf(lines: string[]): string {
	const line = lines.find((l) => l.startsWith("  commander gross tokens"));
	assert.ok(line, `gross line missing: ${lines.join("\n")}`);
	return line;
}

/** The exact rendered commander cacheRead-share line for a breakdown. */
function shareLineOf(lines: string[]): string {
	const line = lines.find((l) => l.startsWith("  commander cacheRead share"));
	assert.ok(line, `share line missing: ${lines.join("\n")}`);
	return line;
}

test("P0 gross line keeps full unabridged digits (exact gross=sum) while the compact bucket row shows M", () => {
	const entries = [assistant("openai-codex", "gpt-5.6-sol", usage(23_456_789, 1_234_567, 20_000_000, 0, 12.83))];
	const b = buildCostBreakdown(entries);
	const gross = b.commander.input + b.commander.output + b.commander.cacheRead + b.commander.cacheWrite;
	assert.equal(gross, 44_691_356, "component sum is exact");
	assert.equal(b.commander.tokens, gross);
	const lines = renderCostBreakdown(b);
	const text = lines.join("\n");
	// the compact bucket row still uses Pi's k/M format
	assert.ok(text.includes("45M tokens"), text);
	// the P0 line is exact full digits — never k/M-compacted
	assert.equal(
		grossLineOf(lines),
		"  commander gross tokens   : 44691356 (input 23456789 + output 1234567 + cacheRead 20000000 + cacheWrite 0)",
	);
	assert.ok(!text.includes("23M"), "input component is never rendered compactly: " + text);
	assert.ok(!text.includes("1.2M"), "output component is never rendered compactly: " + text);
	// exact share, deterministic one-decimal
	assert.equal(
		shareLineOf(lines),
		"  commander cacheRead share : 44.8% (cacheRead 20000000 / gross 44691356)",
	);
	// the rendered gross equals the structured facts exactly (template check)
	assert.equal(
		grossLineOf(lines),
		`  commander gross tokens   : ${gross} (input ${b.commander.input} + output ${b.commander.output} + cacheRead ${b.commander.cacheRead} + cacheWrite ${b.commander.cacheWrite})`,
	);
	// new lines stay under the existing per-line bound
	assert.ok(byteLength(grossLineOf(lines)) < 200);
	assert.ok(byteLength(shareLineOf(lines)) < 200);
});

test("P0 cacheRead share is a deterministic one-decimal percent through a real buildCostBreakdown", () => {
	const b = buildCostBreakdown([assistant("openai-codex", "gpt-5.6-sol", usage(10_000, 4_000, 47_000, 600, 1))]);
	assert.equal(b.commander.tokens, 61_600);
	const lines = renderCostBreakdown(b);
	assert.equal(
		shareLineOf(lines),
		"  commander cacheRead share : 76.3% (cacheRead 47000 / gross 61600)",
	);
	assert.equal(renderCostBreakdown(b).join("\n"), lines.join("\n"), "repeated renders are identical");
});

test("P0 cacheRead share renders 0.0%, 100.0%, and explicit N/A on a zero gross", () => {
	// 0%: zero cacheRead with a positive gross
	const zeroShare = renderCostBreakdown(buildCostBreakdown([assistant("p", "m", usage(100, 200, 0, 0, 1))]));
	assert.ok(zeroShare.includes("  commander cacheRead share : 0.0% (cacheRead 0 / gross 300)"), zeroShare.join("\n"));
	// 100%: all tokens are cacheRead
	const fullShare = renderCostBreakdown(buildCostBreakdown([assistant("p", "m", usage(0, 0, 500, 0, 1))]));
	assert.ok(fullShare.includes("  commander cacheRead share : 100.0% (cacheRead 500 / gross 500)"), fullShare.join("\n"));
	// zero gross (empty session) -> explicit N/A with the no-denominator note
	const emptyLines = renderCostBreakdown(buildCostBreakdown([]));
	assert.ok(
		emptyLines.includes("  commander cacheRead share : N/A (gross tokens 0 — no denominator)"),
		emptyLines.join("\n"),
	);
	assert.equal(
		grossLineOf(emptyLines),
		"  commander gross tokens   : 0 (input 0 + output 0 + cacheRead 0 + cacheWrite 0)",
	);
	// hand-crafted all-zero commander -> same explicit N/A line
	const crafted = renderCostBreakdown(handCraftedBreakdown({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
	assert.ok(
		crafted.includes("  commander cacheRead share : N/A (gross tokens 0 — no denominator)"),
		crafted.join("\n"),
	);
});

test("P0 malformed/non-finite/negative counts normalize to zero and never render NaN/Infinity", () => {
	const b = handCraftedBreakdown({
		input: Number.NaN,
		output: Number.POSITIVE_INFINITY,
		cacheRead: -5,
		cacheWrite: "many" as never,
		tokens: Number.POSITIVE_INFINITY,
		cost: Number.NaN,
	});
	const lines = renderCostBreakdown(b);
	const text = lines.join("\n");
	assert.ok(!text.includes("NaN") && !text.includes("Infinity"), text);
	assert.equal(
		grossLineOf(lines),
		"  commander gross tokens   : 0 (input 0 + output 0 + cacheRead 0 + cacheWrite 0)",
	);
	assert.ok(text.includes("  commander cacheRead share : N/A (gross tokens 0 — no denominator)"), text);
	assert.ok(lines.every((l) => byteLength(l) < 200), "every line bounded");
	assert.equal(renderCostBreakdown(b).join("\n"), text, "deterministic");
	// negative cacheRead with positive components: cacheRead -> 0, share is 0.0%
	const neg = renderCostBreakdown(handCraftedBreakdown({ input: 100, output: 100, cacheRead: -50, cacheWrite: 0, tokens: 200 }));
	assert.equal(
		shareLineOf(neg),
		"  commander cacheRead share : 0.0% (cacheRead 0 / gross 200)",
	);
	assert.ok(!neg.join("\n").includes("NaN") && !neg.join("\n").includes("Infinity"));
	// malformed usage entries through buildCostBreakdown normalize identically
	const viaEntries = buildCostBreakdown([
		assistant("openai-codex", "gpt-5.6-sol", {
			input: Number.NaN,
			output: Number.POSITIVE_INFINITY,
			cacheRead: -5,
			cacheWrite: "many",
			totalTokens: 0,
			cost: { total: Number.NaN },
		}),
	]);
	const viaLines = renderCostBreakdown(viaEntries);
	const viaText = viaLines.join("\n");
	assert.equal(
		grossLineOf(viaLines),
		"  commander gross tokens   : 0 (input 0 + output 0 + cacheRead 0 + cacheWrite 0)",
	);
	assert.ok(!viaText.includes("NaN") && !viaText.includes("Infinity"), viaText);
});

test("P0 above-bound commander counts clamp with the explicit note and stay bounded", () => {
	// a single absurd finite component clamps to MAX_COMMANDER_COUNT_DISPLAY
	const single = renderCostBreakdown(
		handCraftedBreakdown({ input: 1e308, output: 0, cacheRead: 0, cacheWrite: 0, tokens: MAX_COMMANDER_COUNT_DISPLAY }),
	);
	const singleText = single.join("\n");
	assert.equal(
		grossLineOf(single),
		`  commander gross tokens   : ${MAX_COMMANDER_COUNT_DISPLAY} (input ${MAX_COMMANDER_COUNT_DISPLAY} + output 0 + cacheRead 0 + cacheWrite 0)`,
	);
	assert.ok(
		single.includes(
			`  (commander token count(s) above ${MAX_COMMANDER_COUNT_DISPLAY} clamped for display — exact values in the commander bucket)`,
		),
		singleText,
	);
	assert.ok(single.every((l) => byteLength(l) < 200), "clamped lines stay under the per-line bound");
	assert.equal(renderCostBreakdown(handCraftedBreakdown({ input: 1e308, output: 0, cacheRead: 0, cacheWrite: 0, tokens: MAX_COMMANDER_COUNT_DISPLAY })).join("\n"), singleText, "deterministic");
	// all four components above the bound clamp independently; gross is the
	// exact integer sum of the clamped components (4 * 2^50 < 2^53 — exact)
	const all = renderCostBreakdown(
		handCraftedBreakdown({ input: 1e308, output: 1e308, cacheRead: 1e308, cacheWrite: 1e308, tokens: 4 * MAX_COMMANDER_COUNT_DISPLAY }),
	);
	const allText = all.join("\n");
	assert.equal(
		grossLineOf(all),
		`  commander gross tokens   : ${4 * MAX_COMMANDER_COUNT_DISPLAY} (input ${MAX_COMMANDER_COUNT_DISPLAY} + output ${MAX_COMMANDER_COUNT_DISPLAY} + cacheRead ${MAX_COMMANDER_COUNT_DISPLAY} + cacheWrite ${MAX_COMMANDER_COUNT_DISPLAY})`,
	);
	assert.equal(
		shareLineOf(all),
		`  commander cacheRead share : 25.0% (cacheRead ${MAX_COMMANDER_COUNT_DISPLAY} / gross ${4 * MAX_COMMANDER_COUNT_DISPLAY})`,
	);
	assert.ok(all.some((l) => l.includes("clamped for display")), allText);
	assert.ok(all.every((l) => byteLength(l) < 200), "all lines bounded");
	// exact boundary: MAX_COMMANDER_COUNT_DISPLAY itself is NOT clamped; one above is
	const boundary = renderCostBreakdown(
		handCraftedBreakdown({ input: MAX_COMMANDER_COUNT_DISPLAY, output: 1, cacheRead: 0, cacheWrite: 0, tokens: MAX_COMMANDER_COUNT_DISPLAY + 1 }),
	);
	const boundaryText = boundary.join("\n");
	assert.ok(boundaryText.includes(`(input ${MAX_COMMANDER_COUNT_DISPLAY} + output 1 + cacheRead 0 + cacheWrite 0)`), boundaryText);
	assert.ok(!boundary.some((l) => l.includes("clamped for display")), boundaryText);
	const over = renderCostBreakdown(
		handCraftedBreakdown({ input: MAX_COMMANDER_COUNT_DISPLAY + 1, output: 0, cacheRead: 0, cacheWrite: 0, tokens: MAX_COMMANDER_COUNT_DISPLAY }),
	);
	assert.ok(over.some((l) => l.includes("clamped for display")), over.join("\n"));
	// the structured bucket facts are never altered by display clamping
	const structured = handCraftedBreakdown({ input: 1e308, output: 0, cacheRead: 0, cacheWrite: 0, tokens: MAX_COMMANDER_COUNT_DISPLAY });
	assert.equal(structured.commander.input, 1e308);
});
