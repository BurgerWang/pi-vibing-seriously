/**
 * P4 run report tests (P4 spec §4, §6) — /q-report latest|<run-id>.
 *
 * Facts only from the persisted run records (manifest.json, gates.json,
 * summary.json, run-attributed quant-result.json); unknown targets resolve
 * to null; gate runs get a gates/failed-checks section; quant runs get the
 * declared quant facts.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { runGates } from "../extensions/workbench-runtime/core/gate-engine.ts";
import { runRecipe } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import {
	buildRunReport,
	latestGateRunSummary,
	readGateFileRecord,
	resolveRunTarget,
} from "../extensions/workbench-runtime/core/report.ts";
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

async function setupRecipeProject(dir: string): Promise<void> {
	await writeConfigFile(dir, "project.yaml", "name: p4-report\nprofile: generic\n");
	await writeConfigFile(dir, "recipes.yaml", RECIPES_YAML);
	await writeConfigFile(dir, "gates.yaml", "gates: []\n");
}

async function runRecipeAt(dir: string, date: string, code = 0): Promise<string> {
	const result = await runRecipe({
		projectRoot: dir,
		recipeName: "test",
		mode: "DEV",
		exec: fakeExec(code),
		now: () => new Date(date),
	});
	assert.ok(result.ok === (code === 0), "recipe run outcome must match the fake exit code");
	assert.ok(result.record, "recipe run must produce a record");
	return result.record.run_id;
}

async function setupQuantGateProject(dir: string, metrics: Record<string, unknown>): Promise<void> {
	await writeConfigFile(dir, "project.yaml", "name: p4-quant\nprofile: quant-research/stock-selection\n");
	await writeConfigFile(dir, "recipes.yaml", "recipes: []\n");
	await writeConfigFile(
		dir,
		"gates.yaml",
		"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Contract, kind: schema, file: results/quant-result.json, schema: quant-result }\n",
	);
	await mkdir(join(dir, "results"), { recursive: true });
	await writeFile(join(dir, "results", "quant-result.json"), JSON.stringify(makeValidQuantResult(metrics), null, 2), "utf8");
}

async function runGateAt(dir: string, date: string): Promise<string> {
	const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: fakeExec(), now: () => new Date(date) });
	return result.runId;
}

// ------------------------------------------------------------------- target

test("resolveRunTarget latest returns the newest run", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		const first = await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		const second = await runRecipeAt(dir, "2026-08-01T00:01:00.000Z");
		assert.notEqual(first, second);
		assert.equal(await resolveRunTarget(dir, "latest"), second);
	});
});

test("recipe runs snapshot declared JSON artifacts so later runs cannot corrupt earlier records", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await mkdir(join(dir, "out"), { recursive: true });
		await writeFile(join(dir, "out", "metrics.json"), JSON.stringify({ tests: 10 }), "utf8");
		const first = await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		// Overwrite the same project file before the second run.
		await writeFile(join(dir, "out", "metrics.json"), JSON.stringify({ tests: 99 }), "utf8");
		const second = await runRecipeAt(dir, "2026-08-01T00:01:00.000Z");

		const snapshotA = JSON.parse(await readFile(join(dir, CONFIG_DIR_NAME, "workbench", "runs", first, "artifacts", "metrics.json"), "utf8")) as { tests: number };
		assert.equal(snapshotA.tests, 10, "first run snapshot must keep its run-time content");
		const snapshotB = JSON.parse(await readFile(join(dir, CONFIG_DIR_NAME, "workbench", "runs", second, "artifacts", "metrics.json"), "utf8")) as { tests: number };
		assert.equal(snapshotB.tests, 99);
	});
});

test("resolveRunTarget accepts an explicit existing run id", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		const runId = await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		assert.equal(await resolveRunTarget(dir, runId), runId);
	});
});

test("resolveRunTarget returns null for unknown and malformed targets", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		assert.equal(await resolveRunTarget(dir, "20260101-120000-zzzz"), null, "valid-format but unknown run");
		assert.equal(await resolveRunTarget(dir, "not-a-run-id"), null, "malformed target");
		assert.equal(await resolveRunTarget(dir, ""), null, "empty target");
	});
});

test("buildRunReport returns null for an unknown run", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		assert.equal(await buildRunReport(dir, "20260101-120000-zzzz"), null);
	});
});

// ------------------------------------------------------------------ reports

test("recipe run report carries manifest facts and log paths", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await mkdir(join(dir, "out"), { recursive: true });
		await writeFile(join(dir, "out", "report.json"), JSON.stringify({ tests: 1 }), "utf8");
		const runId = await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		const lines = await buildRunReport(dir, runId);
		assert.ok(lines, "report must exist");
		const text = lines.join("\n");
		assert.ok(text.includes(`run       : ${runId}`));
		assert.ok(text.includes("recipe    : test"));
		assert.ok(text.includes("profile   : generic"));
		assert.ok(text.includes("status    : OK"));
		assert.ok(text.includes("exit code : 0"));
		assert.ok(text.includes("artifacts : out/report.json"));
		assert.ok(text.includes("stdout log:"));
		assert.ok(text.includes("stderr log:"));
		assert.ok(text.includes("manifest.json"), "report must cite the full record path");
		assert.ok(!text.includes("gates ("), "recipe run report must not invent a gates section");
	});
});

test("gate run report lists per-gate statuses and failed checks", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		// g1 fails: a gate whose only check requires a missing file.
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Missing, kind: file, path: nope.txt }\n",
		);
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: fakeExec(), now: () => new Date("2026-08-01T00:00:00.000Z") });
		const lines = await buildRunReport(dir, result.runId);
		const text = lines?.join("\n") ?? "";
		assert.ok(text.includes("recipe    : gate (gate run)"));
		assert.ok(text.includes("gates (1):"));
		assert.match(text, /g1\s+FAIL/);
		assert.ok(text.includes("failed checks:"));
		assert.ok(text.includes("g1.1"));
	});
});

test("quant run report includes the declared quant facts", async () => {
	await withTempDir(async (dir) => {
		await setupQuantGateProject(dir, {});
		const runId = await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		const lines = await buildRunReport(dir, runId);
		const text = lines?.join("\n") ?? "";
		assert.ok(text.includes("quant result"));
		assert.ok(text.includes("return          : 0.12"));
		assert.ok(text.includes("benchmark delta : 0.04"));
		assert.ok(text.includes("folds           : 3 passed, 0 not passed"));
		assert.ok(text.includes("parameters      : lookback, top_n, seed"));
	});
});

// ------------------------------------------------------- latest gate summary

test("latestGateRunSummary reports worst gate, counts and blocking reason", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			[
				"gates:",
				"  - id: g1",
				"    title: G1",
				"    checks:",
				"      - { id: g1.1, title: Config, kind: config }",
				"  - id: g2",
				"    title: G2",
				"    prerequisites: [g1]",
				"    checks:",
				"      - { id: g2.1, title: Missing, kind: file, path: nope.txt }",
			].join("\n"),
		);
		const result = await runGates({ projectRoot: dir, selector: "g1,g2", mode: "DEV", exec: fakeExec(), now: () => new Date("2026-08-01T00:00:00.000Z") });
		assert.equal(result.status, "FAIL");
		const summary = await latestGateRunSummary(dir);
		assert.ok(summary, "summary must exist after a gate run");
		assert.equal(summary.run_id, result.runId);
		assert.equal(summary.status, "FAIL");
		assert.equal(summary.worst_gate?.id, "g2");
		assert.equal(summary.worst_gate?.status, "FAIL");
		assert.ok(summary.blocking_reason?.includes("g2.1"), "blocking reason must cite the failing check");
		assert.deepEqual(summary.counts, { pass: 1, fail: 1, blocked: 0, not_run: 0 });
	});
});

test("latestGateRunSummary returns null when no gate run exists", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		assert.equal(await latestGateRunSummary(dir), null);
	});
});

test("readGateFileRecord rejects run id mismatches and non-gate records", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		const runId = await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		assert.equal(await readGateFileRecord(dir, runId), null, "recipe run has no gates.json");
		assert.equal(await readGateFileRecord(dir, "20260101-120000-zzzz"), null, "unknown run");
	});
});
