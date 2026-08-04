/**
 * P4 renderer tests (P4 spec §3, §6) — compact/expanded/partial renderers,
 * missing fields, narrow-width degradation, error rendering, and the
 * UI-disabled guard. Line builders are pure and ANSI-free; the TUI wrapper
 * is exercised with a passthrough/fake theme and Pi's real Text component
 * (word-wrapping at narrow widths is Pi's own degradation layer).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Text } from "@earendil-works/pi-tui";

import type { RunComparison } from "../extensions/workbench-runtime/core/compare.ts";
import {
	renderCompareLines,
	renderErrorLine,
	renderGateLines,
	renderInspectLines,
	renderPartialLine,
	renderReadRunLines,
	renderRecipeLines,
	renderToolCallLine,
	type GateToolDetails,
	type InspectToolDetails,
	type ReadRunToolDetails,
	type RecipeToolDetails,
} from "../extensions/workbench-runtime/core/render.ts";
import { fitToWidth } from "../extensions/workbench-runtime/core/format.ts";
import { widgetAction, type WidgetState } from "../extensions/workbench-runtime/core/widget.ts";
import { workbenchToolRenderer } from "../extensions/workbench-runtime/ui/tool-renderers.ts";

const RECIPE: RecipeToolDetails = {
	ok: true,
	run_id: "20260801-004",
	recipe: "npm test",
	status: "OK",
	exit_code: 0,
	duration_ms: 1234,
	artifact_paths: ["results/out.json"],
	stdout_log: ".pi/workbench/runs/20260801-004/stdout.log",
	stderr_log: ".pi/workbench/runs/20260801-004/stderr.log",
	expected_exit_codes: [0],
};

const GATE: GateToolDetails = {
	ok: false,
	status: "FAIL",
	run_id: "20260801-005",
	requested: ["all"],
	profile: "quant-research/stock-selection",
	gates: [
		{
			id: "b1",
			status: "FAIL",
			title: "Static Quality",
			failure_reason: "check(s) failed: b1.3",
			blocked_reason: null,
			failed_checks: ["b1.3"],
		},
	],
	counts: { pass: 0, fail: 1, blocked: 0, not_run: 0 },
	log_path: ".pi/workbench/runs/20260801-005",
};

const READ_RUN: ReadRunToolDetails = {
	run_id: "20260801-004",
	recipe: "npm test",
	kind: "recipe",
	status: "OK",
	exit_code: 0,
	duration_ms: 1234,
	profile: "generic",
	mode: "VERIFY",
	started_at: "2026-08-01T00:00:00.000Z",
	finished_at: "2026-08-01T00:00:01.234Z",
	git_commit: "abc123def456",
	git_dirty: false,
	artifact_paths: ["results/out.json"],
	stdout_log: ".pi/workbench/runs/20260801-004/stdout.log",
	stderr_log: ".pi/workbench/runs/20260801-004/stderr.log",
};

const INSPECT: InspectToolDetails = {
	project_root: "/tmp/proj",
	git: { is_git: true, commit: "abc123def456", dirty: true, branch: "main" },
	stacks: ["JavaScript/TypeScript (npm)"],
	profile: "quant-research/stock-selection",
	recipes: ["test", "backtest"],
	config_errors: [],
	config_files_present: ["project.yaml", "recipes.yaml"],
};

const QUANT_REPORT: RunComparison = {
	compatible: true,
	notes: [],
	a: { run_id: "20260801-001", recipe: "backtest", started_at: "t" },
	b: { run_id: "20260801-002", recipe: "backtest", started_at: "t" },
	generic: {
		exit_code: { a: 0, b: 0, changed: false },
		duration_ms: { a: 1000, b: 2000, changed: true },
		artifacts: { added: ["out/b.json"], removed: ["out/a.json"], common: ["out/c.json"] },
		gate_delta: null,
		test_counts: null,
		artifact_metrics: [{ file: "out/m.json", field: "tests", a: 10, b: 12 }],
	},
	quant: {
		benchmark_delta: { a: 0.04, b: 0.05, changed: true },
		return: { a: 0.12, b: 0.15, changed: true },
		drawdown: { a: -0.18, b: -0.22, changed: true },
		turnover: { a: 0.6, b: 0.62, changed: true },
		costs: [{ file: "costs", field: "fees_bps", a: 5, b: 8 }],
		folds: {
			a: { passed: 2, failed: 1, skipped: 0, pending: 0 },
			b: { passed: 3, failed: 0, skipped: 0, pending: 0 },
		},
		parameters: [{ field: "lookback", a: 20, b: 30 }],
		a_path: "results/quant-result.json",
		b_path: "results/quant-result.json",
	},
};

// ------------------------------------------------------------- compact view

test("compact recipe renderer is a single line with status, run, recipe, exit, duration", () => {
	const lines = renderRecipeLines(RECIPE, false);
	assert.equal(lines.length, 1);
	assert.ok(lines[0]!.includes("OK"));
	assert.ok(lines[0]!.includes("run:20260801-004"));
	assert.ok(lines[0]!.includes("npm test"));
	assert.ok(lines[0]!.includes("exit=0"));
	assert.ok(lines[0]!.includes("1.2s"));
});

test("compact gate renderer summarizes per-gate statuses", () => {
	const lines = renderGateLines(GATE, false);
	assert.equal(lines.length, 1);
	assert.ok(lines[0]!.includes("FAIL run:20260801-005"));
	assert.ok(lines[0]!.includes("b1:FAIL"));
});

test("compact read_run and inspect renderers stay one line", () => {
	assert.equal(renderReadRunLines(READ_RUN, false).length, 1);
	const inspect = renderInspectLines(INSPECT, false);
	assert.equal(inspect.length, 1);
	assert.ok(inspect[0]!.includes("profile:quant-research/stock-selection"));
	assert.ok(inspect[0]!.includes("recipes:2"));
});

test("expanded inspect renderer shows the effective project root explicitly", () => {
	const nested = renderInspectLines({ ...INSPECT, effective_project_root: "/tmp/proj/research" }, true);
	assert.ok(nested.some((l) => l.includes("effective root: /tmp/proj/research")), nested.join("\n"));
	assert.ok(nested.some((l) => l.includes("project root : /tmp/proj")), nested.join("\n"));

	// Default (no project_dir): the effective root is the repository root.
	const flat = renderInspectLines(INSPECT, true);
	assert.ok(flat.some((l) => l.includes("effective root: /tmp/proj (repository root)")), flat.join("\n"));
});

test("compact compare renderer shows exit, duration, artifact and quant deltas", () => {
	const [line] = renderCompareLines(QUANT_REPORT, false);
	assert.ok(line!.includes("exit 0 -> 0"));
	assert.ok(line!.includes("1.0s -> 2.0s"));
	assert.ok(line!.includes("artifacts +1/-1"));
	assert.ok(/quant \d+ changed/.test(line!));
});

// ------------------------------------------------------------ expanded view

test("expanded recipe renderer shows recipe, duration, exit code, artifacts and log paths", () => {
	const lines = renderRecipeLines(RECIPE, true).join("\n");
	assert.ok(lines.includes("recipe     : npm test"));
	assert.ok(lines.includes("duration   : 1.2s (1234 ms)"));
	assert.ok(lines.includes("exit code  : 0 (expected: 0)"));
	assert.ok(lines.includes("artifacts  : results/out.json"));
	assert.ok(lines.includes("stdout log : .pi/workbench/runs/20260801-004/stdout.log"));
	assert.ok(lines.includes("stderr log : .pi/workbench/runs/20260801-004/stderr.log"));
});

test("expanded gate renderer shows per-gate rows, failed checks and the log path", () => {
	const lines = renderGateLines(GATE, true).join("\n");
	assert.ok(/b1\s+FAIL/.test(lines), lines);
	assert.ok(lines.includes("Static Quality"));
	assert.ok(lines.includes("check(s) failed: b1.3"));
	assert.ok(lines.includes("failed checks: b1.3"));
	assert.ok(lines.includes("log path    : .pi/workbench/runs/20260801-005"));
});

test("expanded compare renderer lists all deltas and the neutrality note", () => {
	const lines = renderCompareLines(QUANT_REPORT, true).join("\n");
	assert.ok(lines.includes("run a      : 20260801-001 (backtest)"));
	assert.ok(lines.includes("exit code  : 0 -> 0"));
	assert.ok(lines.includes("duration   : 1.0s -> 2.0s"));
	assert.ok(lines.includes("artifacts  : +out/b.json -out/a.json (common: out/c.json)"));
	assert.ok(lines.includes("test counts: n/a (not recorded in run JSON for recipe runs)"));
	assert.ok(lines.includes("gate delta : n/a (neither run is a gate run)"));
	assert.ok(lines.includes("out/m.json#tests: 10 -> 12 (+2)"));
	assert.ok(lines.includes("quant metrics:"));
	assert.ok(lines.includes("return          : 0.12 -> 0.15 (+0.03)"));
	assert.ok(lines.includes("benchmark delta : 0.04 -> 0.05 (+0.01)"));
	assert.ok(lines.includes("drawdown        : -0.18 -> -0.22 (-0.04)"));
	assert.ok(lines.includes("costs.fees_bps    : 5 -> 8 (+3)"));
	assert.ok(lines.includes("folds           : 2 passed / 1 failed / 0 skipped / 0 pending -> 3 passed / 0 failed / 0 skipped / 0 pending"));
	assert.ok(lines.includes("parameter lookback: 20 -> 30"));
	assert.ok(lines.includes("deltas are descriptive facts only"));
});

test("comparison notes render for incompatible schemas", () => {
	const incompatible: RunComparison = {
		...QUANT_REPORT,
		compatible: false,
		notes: ["run a is a gate run and run b is a recipe run — record schemas differ; only generic facts are compared", "gate delta and test counts are not comparable across a gate run and a recipe run"],
	};
	const lines = renderCompareLines(incompatible, true).join("\n");
	assert.ok(lines.includes("compatible : no — see notes"));
	assert.ok(lines.includes("- run a is a gate run and run b is a recipe run"));
	assert.ok(lines.includes("- deltas are descriptive facts only"));
});

// ------------------------------------------------- partial / error / call

test("partial renderer reports progress", () => {
	assert.equal(renderPartialLine("workbench_run_recipe"), "workbench_run_recipe working...");
	assert.equal(renderPartialLine("workbench_run_gate", "running gates all"), "workbench_run_gate running gates all");
});

test("error renderer keeps the failure visible", () => {
	assert.equal(renderErrorLine("workbench_run_recipe", "recipe not found"), "workbench_run_recipe: recipe not found");
});

test("tool call lines summarize arguments per tool", () => {
	assert.equal(renderToolCallLine("workbench_run_recipe", { recipe: "npm test" }), "workbench_run_recipe npm test");
	assert.equal(renderToolCallLine("workbench_run_gate", { gates: "base" }), "workbench_run_gate base");
	assert.equal(renderToolCallLine("workbench_read_run", { run_id: "20260801-004" }), "workbench_read_run 20260801-004");
	assert.equal(renderToolCallLine("workbench_compare_runs", { a: "x", b: "y" }), "workbench_compare_runs x vs y");
	assert.equal(renderToolCallLine("workbench_list_gates", {}), "workbench_list_gates");
});

// --------------------------------------------------------- missing fields

test("renderers survive missing fields", () => {
	const recipe = renderRecipeLines({} as unknown as RecipeToolDetails, true);
	assert.ok(recipe.length >= 2);
	assert.ok(recipe[0]!.includes("? run:? ? exit=killed n/a"), recipe[0]);

	const gate = renderGateLines({} as unknown as GateToolDetails, true);
	assert.ok(gate.length >= 1);
	assert.ok(gate[0]!.includes("? run:? "));

	const inspect = renderInspectLines({} as unknown as InspectToolDetails, true);
	assert.ok(inspect[0]!.includes("profile:not set"));
	assert.ok(inspect.some((l) => l.includes("git          : (not a git repo)")));

	const readRun = renderReadRunLines({} as unknown as ReadRunToolDetails, true);
	assert.ok(readRun[0]!.includes("RUN run:? ? ? exit=killed n/a"));
	assert.ok(readRun.some((l) => l.includes("stdout log : (n/a)")));
});

// ---------------------------------------------------------- narrow widths

test("compare lines fit a narrow terminal width", () => {
	const lines = renderCompareLines(QUANT_REPORT, true, 40);
	for (const line of lines) {
		assert.ok(Array.from(line).length <= 40, `line too wide (${Array.from(line).length}): ${line}`);
	}
});

test("Pi Text component wraps wide renderer output at narrow widths without losing tokens", () => {
	const component = new Text(renderRecipeLines(RECIPE, true).join("\n"), 0, 0);
	const wrapped = component.render(30).join("\n");
	for (const token of ["recipe", "exit=0", "stdout log", "artifacts", "npm test"]) {
		assert.ok(wrapped.includes(token), `token "${token}" lost after wrapping: ${wrapped}`);
	}
});

test("fitToWidth is the truncation primitive used by status/widget/compare", () => {
	assert.equal(fitToWidth("a".repeat(100), 50).length, 50);
	assert.equal(fitToWidth("short", 10), "short");
});

// -------------------------------------------------------------- TUI wrapper

const FAKE_THEME = {
	fg: (color: string, text: string): string => `<${color}>${text}</${color}>`,
	bold: (text: string): string => `*${text}*`,
};

function renderText(component: unknown, width = 200): string {
	return (component as { render: (w: number) => string[] }).render(width).join("\n");
}

test("TUI renderer colors status (success/error/warning) and dims details", () => {
	const { renderResult } = workbenchToolRenderer("recipe", "workbench_run_recipe");
	const out = renderText(
		renderResult({ details: RECIPE, content: [] }, { expanded: false, isPartial: false }, FAKE_THEME, { isError: false }),
	);
	assert.ok(out.includes("<success>OK run:20260801-004 npm test exit=0 1.2s</success>"));

	const failed = renderText(
		renderResult(
			{ details: { ...RECIPE, status: "FAILED", exit_code: 1 }, content: [] },
			{ expanded: false, isPartial: false },
			FAKE_THEME,
			{ isError: false },
		),
	);
	assert.ok(failed.includes("<error>FAILED run:20260801-004"));
});

test("TUI renderer shows progress while partial", () => {
	const { renderResult } = workbenchToolRenderer("recipe", "workbench_run_recipe");
	const out = renderText(
		renderResult({ details: { phase: "started" }, content: [] }, { expanded: false, isPartial: true }, FAKE_THEME, { isError: false }),
	);
	assert.ok(out.includes("workbench_run_recipe started"), out);
});

test("TUI renderer surfaces errors in the error color", () => {
	const { renderResult } = workbenchToolRenderer("gate", "workbench_run_gate");
	const out = renderText(
		renderResult(
			{ details: {}, content: [{ type: "text", text: "gates.yaml: broken" }] },
			{ expanded: false, isPartial: false },
			FAKE_THEME,
			{ isError: true },
		),
	);
	assert.ok(out.includes("<error>workbench_run_gate: gates.yaml: broken</error>"), out);
});

test("TUI renderer call header names the tool and its arguments", () => {
	const { renderCall } = workbenchToolRenderer("recipe", "workbench_run_recipe");
	const out = renderText(renderCall({ recipe: "npm test" }, FAKE_THEME, { lastComponent: undefined }));
	assert.ok(out.includes("*workbench_run_recipe*"));
	assert.ok(out.includes("npm test"));
});

test("TUI compare renderer marks incompatible comparisons in the warning color", () => {
	const { renderResult } = workbenchToolRenderer("compare", "workbench_compare_runs");
	const incompatible: RunComparison = { ...QUANT_REPORT, compatible: false, notes: ["record schemas differ"] };
	const out = renderText(
		renderResult({ details: { ok: true, report: incompatible }, content: [] }, { expanded: false, isPartial: false }, FAKE_THEME, { isError: false }),
	);
	assert.ok(out.includes("<warning>"), out);
});

// --------------------------------------------------------------- UI disabled

test("widget is a no-op when UI is disabled (print/json never touch TUI APIs)", () => {
	const state: WidgetState = { taskActive: true, gateFailed: true, forced: true, task: "t", phase: "p" };
	assert.equal(widgetAction(state, false), "noop");
});

test("renderers never read files or recompute metrics — they render details verbatim", () => {
	// The compact recipe line must quote exactly the details values.
	const mutated = { ...RECIPE, duration_ms: 850, artifact_paths: ["X"], status: "OK" };
	const [line] = renderRecipeLines(mutated, false);
	assert.ok(line!.includes("850ms"));
	assert.ok(!line!.includes("1234"));
});
