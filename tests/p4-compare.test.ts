/**
 * P4 run comparison tests (P4 spec §5, §6).
 *
 * Generic: exit code, duration, artifact changes, gate delta, test counts,
 * shared-JSON artifact metrics. Quant: benchmark/return/drawdown/turnover
 * deltas, cost impact, fold pass/fail delta, parameter changes. Deltas are
 * descriptive — higher returns are never auto-interpreted as better.
 * Incompatible schemas (recipe vs gate, quant vs non-quant) are reported
 * with notes, never silently.
 */

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { compareRuns, QUANT_NEUTRALITY_NOTE } from "../extensions/workbench-runtime/core/compare.ts";
import { runGates } from "../extensions/workbench-runtime/core/gate-engine.ts";
import { runRecipe } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import { renderCompareLines } from "../extensions/workbench-runtime/core/render.ts";
import { makeValidQuantResult, withTempDir, writeConfigFile } from "./helpers.ts";

const RECIPES_YAML = `
recipes:
  - name: test
    description: run the test suite
    command: [npm, test]
    expected_exit_codes: [0]
    artifacts: [out/*.json]
`;

function fakeExec(code = 0): (command: string, args: string[], options?: unknown) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
	return async () => ({ stdout: "", stderr: "", code, killed: false });
}

/** Mutable clock + exec that ticks it, so runs get realistic durations. */
function clockedExec(startMs: number, tickMs: number, code = 0): { exec: (command: string, args: string[], options?: unknown) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>; now: () => Date } {
	let t = startMs;
	return {
		exec: async () => {
			t += tickMs;
			return { stdout: "", stderr: "", code, killed: false };
		},
		now: () => new Date(t),
	};
}

async function setupProject(dir: string, profile = "generic"): Promise<void> {
	await writeConfigFile(dir, "project.yaml", `name: p4-compare\nprofile: ${profile}\n`);
	await writeConfigFile(dir, "recipes.yaml", RECIPES_YAML);
	await writeConfigFile(dir, "gates.yaml", "gates: []\n");
}

async function runRecipeAt(dir: string, startMs: number, options: { code?: number; artifact?: Record<string, unknown>; tickMs?: number } = {}): Promise<string> {
	const { code = 0, artifact, tickMs = 100 } = options;
	if (artifact !== undefined) {
		await mkdir(join(dir, "out"), { recursive: true });
		await writeFile(join(dir, "out", "metrics.json"), JSON.stringify(artifact), "utf8");
	}
	const { exec, now } = clockedExec(startMs, tickMs, code);
	const result = await runRecipe({ projectRoot: dir, recipeName: "test", mode: "DEV", exec, now });
	assert.ok(result.record, "recipe run must produce a record");
	return result.record.run_id;
}

/** A gate run whose single schema check validates results/quant-result.json. */
async function runQuantGateAt(dir: string, date: string, metrics: Record<string, unknown>): Promise<string> {
	await mkdir(join(dir, "results"), { recursive: true });
	await writeFile(join(dir, "results", "quant-result.json"), JSON.stringify(makeValidQuantResult(metrics), null, 2), "utf8");
	const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: fakeExec(), now: () => new Date(date) });
	return result.runId;
}

async function setupQuantGates(dir: string): Promise<void> {
	await writeConfigFile(dir, "project.yaml", "name: p4-quant\nprofile: quant-research/stock-selection\n");
	await writeConfigFile(dir, "recipes.yaml", RECIPES_YAML);
	await writeConfigFile(
		dir,
		"gates.yaml",
		"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Contract, kind: schema, file: results/quant-result.json, schema: quant-result }\n",
	);
}

// ------------------------------------------------------------- error paths

test("compareRuns reports unknown and malformed run ids", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const a = await runRecipeAt(dir, 0);
		const unknown = await compareRuns(dir, a, "20260101-120000-zzzz");
		assert.equal(unknown.ok, false);
		if (!unknown.ok) assert.ok(unknown.error.includes("not found"));
		const malformed = await compareRuns(dir, "nope", a);
		assert.equal(malformed.ok, false);
		if (!malformed.ok) assert.ok(malformed.error.includes("invalid run id"));
	});
});

// ------------------------------------------------------------ generic diff

test("generic comparison diffs exit code, duration and artifacts", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const a = await runRecipeAt(dir, 0, { artifact: { tests: 100, pass: 95 }, tickMs: 100 });
		const b = await runRecipeAt(dir, 60_000, { code: 1, artifact: { tests: 102, pass: 97 }, tickMs: 300 });

		const outcome = await compareRuns(dir, a, b);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		const r = outcome.report;

		assert.equal(r.compatible, true);
		assert.equal(r.generic.exit_code.a, 0);
		assert.equal(r.generic.exit_code.b, 1);
		assert.equal(r.generic.exit_code.changed, true);
		assert.equal(r.generic.duration_ms.changed, true);
		assert.deepEqual(r.generic.artifacts.common, ["out/metrics.json"]);
		assert.deepEqual(r.generic.artifacts.added, []);
		assert.deepEqual(r.generic.artifacts.removed, []);
		// Gate delta and test counts are only defined for gate runs.
		assert.equal(r.generic.gate_delta, null);
		assert.equal(r.generic.test_counts, null);
		assert.equal(r.quant, null);
		assert.ok(r.notes.some((n) => n.includes("neither run has a valid quant-result artifact")));
	});
});

test("generic comparison diffs numeric leaves of shared JSON artifacts", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const a = await runRecipeAt(dir, 0, { artifact: { tests: 100, pass: 95, timing: { setup: 1.5 } } });
		const b = await runRecipeAt(dir, 60_000, { artifact: { tests: 102, pass: 97, timing: { setup: 1.8 } } });

		const outcome = await compareRuns(dir, a, b);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		const metrics = outcome.report.generic.artifact_metrics;
		const byField = new Map(metrics.map((m) => [m.field, m]));
		assert.equal(byField.get("tests")?.a, 100);
		assert.equal(byField.get("tests")?.b, 102);
		assert.equal(byField.get("timing.setup")?.a, 1.5);
		assert.equal(byField.get("timing.setup")?.b, 1.8);
		assert.equal(byField.get("pass")?.a, 95);
		assert.equal(byField.get("pass")?.b, 97);
	});
});

test("generic comparison detects artifact additions and removals", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		await mkdir(join(dir, "out"), { recursive: true });
		await writeFile(join(dir, "out", "only-a.json"), "{}", "utf8");
		const a = await runRecipeAt(dir, 0);
		await rm(join(dir, "out", "only-a.json"));
		await writeFile(join(dir, "out", "only-b.json"), "{}", "utf8");
		const b = await runRecipeAt(dir, 60_000);
		const outcome = await compareRuns(dir, a, b);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		assert.deepEqual(outcome.report.generic.artifacts.added, ["out/only-b.json"]);
		assert.deepEqual(outcome.report.generic.artifacts.removed, ["out/only-a.json"]);
	});
});

test("comparing a run to itself yields zero deltas", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const a = await runRecipeAt(dir, 0, { artifact: { tests: 100 } });
		const outcome = await compareRuns(dir, a, a);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		assert.equal(outcome.report.generic.exit_code.changed, false);
		assert.equal(outcome.report.generic.duration_ms.changed, false);
		assert.deepEqual(outcome.report.generic.artifact_metrics, []);
	});
});

// --------------------------------------------------------- incompatible

test("comparing a gate run with a recipe run is incompatible with a note", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const recipeRun = await runRecipeAt(dir, 0);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Missing, kind: file, path: nope.txt }\n",
		);
		const gateRun = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: fakeExec(), now: () => new Date("2026-08-01T00:01:00.000Z") });

		const outcome = await compareRuns(dir, gateRun.runId, recipeRun);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		const r = outcome.report;
		assert.equal(r.compatible, false);
		assert.ok(r.notes.some((n) => n.includes("record schemas differ")), "notes must explain the schema mismatch");
		assert.ok(r.notes.some((n) => n.includes("gate delta and test counts are not comparable")));
		// Generic facts are still compared.
		assert.equal(r.generic.exit_code.a, 1); // gate run fails (exit 1)
		assert.equal(r.generic.exit_code.b, 0);
		assert.equal(r.generic.gate_delta, null);
		assert.equal(r.generic.test_counts, null);
	});
});

test("quant vs non-quant runs are incompatible and skip quant metrics with a note", async () => {
	await withTempDir(async (dir) => {
		await setupQuantGates(dir);
		const quantRun = await runQuantGateAt(dir, "2026-08-01T00:00:00.000Z", {});
		const recipeRun = await runRecipeAt(dir, 60_000);
		const outcome = await compareRuns(dir, quantRun, recipeRun);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		assert.equal(outcome.report.compatible, false);
		assert.equal(outcome.report.quant, null);
		assert.ok(
			outcome.report.notes.some((n) => n.includes("quant metrics not compared") && n.includes(recipeRun) && n.includes("no valid quant-result artifact")),
			"note must name the run without a quant artifact",
		);
	});
});

// ------------------------------------------------------------ quant diff

test("quant comparison diffs benchmark, return, drawdown, turnover, costs, folds and parameters", async () => {
	await withTempDir(async (dir) => {
		await setupQuantGates(dir);
		const runA = await runQuantGateAt(dir, "2026-08-01T00:00:00.000Z", {
			metrics: { return: 0.12, volatility: 0.15, drawdown: -0.18, sharpe: 0.8, turnover: 0.6, exposure: 0.95, benchmark_delta: 0.04 },
			costs: { fees_bps: 5, slippage_bps: 10 },
			parameters: { lookback: 20, top_n: 50 },
			folds: [
				{ id: "f1", status: "passed", metrics: { return: 0.1, sharpe: 0.7 } },
				{ id: "f2", status: "failed" },
			],
		});
		const runB = await runQuantGateAt(dir, "2026-08-01T00:01:00.000Z", {
			metrics: { return: 0.15, volatility: 0.16, drawdown: -0.22, sharpe: 0.9, turnover: 0.62, exposure: 0.95, benchmark_delta: 0.05 },
			costs: { fees_bps: 8, slippage_bps: 10 },
			parameters: { lookback: 30, top_n: 50 },
			folds: [
				{ id: "f1", status: "passed", metrics: { return: 0.13, sharpe: 0.8 } },
				{ id: "f2", status: "passed", metrics: { return: 0.16, sharpe: 0.85 } },
			],
		});

		const outcome = await compareRuns(dir, runA, runB);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		const q = outcome.report.quant;
		assert.ok(q, "quant comparison must be present when both runs carry a quant artifact");
		assert.equal(outcome.report.compatible, true);
		assert.equal(q.return.a, 0.12);
		assert.equal(q.return.b, 0.15);
		assert.equal(q.return.changed, true);
		assert.equal(q.benchmark_delta.a, 0.04);
		assert.equal(q.benchmark_delta.b, 0.05);
		assert.equal(q.drawdown.a, -0.18);
		assert.equal(q.drawdown.b, -0.22);
		assert.equal(q.turnover.b, 0.62);
		assert.deepEqual(q.costs, [{ file: "costs", field: "fees_bps", a: 5, b: 8 }]);
		assert.deepEqual(q.folds.a, { passed: 1, failed: 1, skipped: 0, pending: 0 });
		assert.deepEqual(q.folds.b, { passed: 2, failed: 0, skipped: 0, pending: 0 });
		assert.deepEqual(q.parameters.map((p) => p.field), ["lookback"]);
		assert.equal(q.parameters[0]?.a, 20);
		assert.equal(q.parameters[0]?.b, 30);
		assert.ok(outcome.report.notes.length === 0, "fully compatible comparison must not invent notes");
	});
});

test("comparison rendering is neutral about higher returns", async () => {
	await withTempDir(async (dir) => {
		await setupQuantGates(dir);
		const runA = await runQuantGateAt(dir, "2026-08-01T00:00:00.000Z", {});
		const runB = await runQuantGateAt(dir, "2026-08-01T00:01:00.000Z", {
			metrics: { return: 0.99, volatility: 0.15, drawdown: -0.18, sharpe: 0.8, turnover: 0.6, exposure: 0.95, benchmark_delta: 0.04 },
		});
		const outcome = await compareRuns(dir, runA, runB);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		const text = renderCompareLines(outcome.report, true).join("\n");
		assert.ok(text.includes("return"), "quant return delta must be shown");
		assert.ok(text.includes("0.12 -> 0.99"));
		// The neutrality statement must be present; no "better/worse" verdicts.
		assert.ok(text.includes(QUANT_NEUTRALITY_NOTE));
		assert.ok(!/better|worse|improved/i.test(text.replace(QUANT_NEUTRALITY_NOTE, "")), "no verdict language outside the neutrality note");
	});
});

test("gate delta lists per-gate status changes", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const yaml = (file: string) =>
			`gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: C, kind: file, path: ${file} }\n`;
		await writeConfigFile(dir, "gates.yaml", yaml("present.txt"));
		await writeFile(join(dir, "present.txt"), "x", "utf8");
		const passRun = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: fakeExec(), now: () => new Date("2026-08-01T00:00:00.000Z") });
		await writeConfigFile(dir, "gates.yaml", yaml("missing.txt"));
		const failRun = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: fakeExec(), now: () => new Date("2026-08-01T00:01:00.000Z") });

		const outcome = await compareRuns(dir, passRun.runId, failRun.runId);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		const delta = outcome.report.generic.gate_delta;
		assert.ok(delta, "gate delta must exist for two gate runs");
		assert.deepEqual(delta.changed, [{ gate: "g1", a: "PASS", b: "FAIL" }]);
		assert.deepEqual(outcome.report.generic.test_counts, {
			a: { passed: 1, failed: 0, blocked: 0, not_run: 0 },
			b: { passed: 0, failed: 1, blocked: 0, not_run: 0 },
		});
	});
});
