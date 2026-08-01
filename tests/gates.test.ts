/**
 * Gate Engine tests (P3) — the validation ladder semantics.
 *
 * Covers the required scenarios: gate dependency order, prerequisite FAIL →
 * BLOCKED, required NOT_RUN never PASSes, missing artifacts, missing JSON
 * fields, numeric constraints, non-numeric/NaN values, quant gates only
 * loading for quant profiles, generic not enforcing quant gates, failed
 * folds not filtered, evidence path escapes, gate result persistence, and
 * independent run ids — plus recipe checks, manual evidence marking,
 * non-blocking prerequisites, persisted prerequisite resolution, config
 * checks and yaml catalog overrides.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	GateSetupError,
	latestGateStatus,
	loadGates,
	runGates,
} from "../extensions/workbench-runtime/core/gate-engine.ts";
import { runRecipe } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import { makeValidQuantResult, spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

const CONFIG_CHECK = "      - { id: g1.1, title: Config, kind: config }";

async function setupProject(dir: string, options: { profile?: string; gatesYaml?: string; recipesYaml?: string } = {}): Promise<void> {
	const profile = options.profile ?? "generic";
	await writeConfigFile(dir, "project.yaml", `name: test-project\nprofile: ${profile}\n`);
	if (options.recipesYaml !== undefined) {
		await writeConfigFile(dir, "recipes.yaml", options.recipesYaml);
	}
	await writeConfigFile(dir, "gates.yaml", options.gatesYaml ?? "gates: []\n");
}

function gatesYaml(gates: string): string {
	return `gates:\n${gates}`;
}

async function readRunFile(runDir: string, file: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(runDir, file), "utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Dependency order and prerequisite semantics
// ---------------------------------------------------------------------------

test("gates run in dependency order regardless of request order", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`,
					`  - id: g2\n    title: G2\n    prerequisites: [g1]\n    checks:\n${CONFIG_CHECK}`,
					`  - id: g3\n    title: G3\n    prerequisites: [g2]\n    checks:\n${CONFIG_CHECK}`,
				].join("\n"),
			),
		});
		// Reversed request: the engine must still evaluate g1 before g2 before g3.
		const result = await runGates({ projectRoot: dir, selector: "g3,g2,g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.ok, true);
		assert.deepEqual(result.gates.map((g) => g.id), ["g1", "g2", "g3"]);
		assert.equal(result.gates[1]!.prerequisite_status["g1"]!.source, "this-run");
		assert.equal(result.gates[2]!.prerequisite_status["g2"]!.status, "PASS");
	});
});

test("prerequisite FAIL blocks dependent gates (checks not evaluated)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Missing file, kind: file, path: does-not-exist.txt }`,
					`  - id: g2\n    title: G2\n    prerequisites: [g1]\n    checks:\n${CONFIG_CHECK}`,
					`  - id: g3\n    title: G3\n    prerequisites: [g2]\n    checks:\n${CONFIG_CHECK}`,
				].join("\n"),
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1,g2,g3", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.equal(result.gates[1]!.status, "BLOCKED");
		assert.ok(result.gates[1]!.blocked_reason?.includes("prerequisite g1 is FAIL"));
		assert.deepEqual(result.gates[1]!.checks, [], "blocked gates must not evaluate checks");
		assert.equal(result.gates[2]!.status, "BLOCKED");
		assert.ok(result.gates[2]!.blocked_reason?.includes("prerequisite g2 is BLOCKED"));
		assert.equal(result.ok, false);
	});
});

test("required NOT_RUN checks never let a gate PASS", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Manual audit, kind: manual, prompt: "audit needed" }`,
			),
		});
		const withoutEvidence = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(withoutEvidence.gates[0]!.status, "NOT_RUN");
		assert.equal(withoutEvidence.ok, false);

		const withEvidence = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "g1.1": "audit performed: timestamps checked against point-in-time data" },
		});
		assert.equal(withEvidence.gates[0]!.status, "PASS");
		assert.equal(withEvidence.ok, true);
	});
});

test("optional NOT_RUN checks do not block PASS but are recorded as warnings", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}\n      - { id: g1.2, title: Optional audit, kind: manual, required: false }`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS");
		assert.ok(result.gates[0]!.warnings.some((w) => w.includes("g1.2") && w.includes("not run")));
		assert.equal(result.ok, true);
	});
});

test("a non-blocking prerequisite FAIL does not block dependents", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    blocking: false\n    checks:\n      - { id: g1.1, title: Missing file, kind: file, path: does-not-exist.txt }`,
					`  - id: g2\n    title: G2\n    prerequisites: [g1]\n    checks:\n${CONFIG_CHECK}`,
				].join("\n"),
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1,g2", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.equal(result.gates[1]!.status, "PASS", "non-blocking prerequisite failure must not block dependents");
		assert.equal(result.gates[1]!.prerequisite_status["g1"]!.status, "FAIL");
	});
});

test("prerequisites resolve from prior persisted gate runs", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`,
					`  - id: g2\n    title: G2\n    prerequisites: [g1]\n    checks:\n${CONFIG_CHECK}`,
				].join("\n"),
			),
		});
		const first = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(first.gates[0]!.status, "PASS");

		const second = await runGates({ projectRoot: dir, selector: "g2", mode: "DEV", exec: spawnExec });
		assert.equal(second.gates[0]!.status, "PASS", "g2 must resolve g1's PASS from the persisted run");
		assert.ok(second.gates[0]!.prerequisite_status["g1"]!.source.startsWith("run:"));
		assert.equal(second.gates[0]!.prerequisite_status["g1"]!.status, "PASS");

		const latest = await latestGateStatus(dir, "g1");
		assert.equal(latest?.status, "PASS");
		assert.equal(latest?.run_id, first.runId);
	});
});

// ---------------------------------------------------------------------------
// Check kinds: file / json / numeric / manual / schema / recipe
// ---------------------------------------------------------------------------

test("missing artifact fails the file check with the check id in the reason", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Data file, kind: file, path: data/prices.csv }`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.ok(result.gates[0]!.failure_reason?.includes("g1.1"));
	});

	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Data file, kind: file, any_of: [data/a.csv, data/b.csv] }`,
			),
		});
		await mkdir(join(dir, "data"), { recursive: true });
		await writeFile(join(dir, "data", "b.csv"), "x", "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS", "any_of must pass when one of the files exists");
	});
});

test("missing JSON field fails the json check", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Split method, kind: json, file: results/quant-result.json, path: split.method }`,
			),
		});
		await mkdir(join(dir, "results"), { recursive: true });
		await writeFile(join(dir, "results", "quant-result.json"), JSON.stringify({ split: {} }), "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.ok(result.gates[0]!.checks[0]!.failure_reason?.includes("split.method"));
	});
});

test("json equals and any_of_paths checks", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Method, kind: json, file: results/r.json, path: split.method, equals: walk-forward }`,
					`  - id: g2\n    title: G2\n    checks:\n      - { id: g2.1, title: Risk metric, kind: json, file: results/r.json, any_of_paths: [metrics.sharpe, metrics.sortino] }`,
				].join("\n"),
			),
		});
		await mkdir(join(dir, "results"), { recursive: true });
		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ split: { method: "walk-forward" }, metrics: { sortino: 1.2 } }), "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1,g2", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS");
		assert.equal(result.gates[1]!.status, "PASS", "any_of_paths must pass when one path exists");
	});
});

test("numeric constraints are enforced (min/max, inclusive)", async () => {
	const check = (min: number, max: number): string =>
		`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Return, kind: numeric, file: results/r.json, path: metrics.return, min: ${min}, max: ${max} }`;
	await withTempDir(async (dir) => {
		await setupProject(dir, { gatesYaml: gatesYaml(check(10, 20)) });
		await mkdir(join(dir, "results"), { recursive: true });
		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ metrics: { return: 5 } }), "utf8");
		const below = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(below.gates[0]!.status, "FAIL");
		assert.ok(below.gates[0]!.checks[0]!.failure_reason?.includes("below min"));

		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ metrics: { return: 15 } }), "utf8");
		const within = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(within.gates[0]!.status, "PASS");

		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ metrics: { return: 25 } }), "utf8");
		const above = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(above.gates[0]!.status, "FAIL");
		assert.ok(above.gates[0]!.checks[0]!.failure_reason?.includes("above max"));
	});
});

test("non-numeric and non-finite values fail numeric checks", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Return, kind: numeric, file: results/r.json, path: x }`,
			),
		});
		await mkdir(join(dir, "results"), { recursive: true });

		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ x: "abc" }), "utf8");
		const nonNumeric = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(nonNumeric.gates[0]!.status, "FAIL");
		assert.ok(nonNumeric.gates[0]!.checks[0]!.failure_reason?.includes("finite number"));

		// 1e999 is valid JSON text but parses to Infinity.
		await writeFile(join(dir, "results", "r.json"), '{"x": 1e999}', "utf8");
		const infinity = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(infinity.gates[0]!.status, "FAIL");
		assert.ok(infinity.gates[0]!.checks[0]!.failure_reason?.includes("finite number"));

		await writeFile(join(dir, "results", "r.json"), JSON.stringify({}), "utf8");
		const missing = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(missing.gates[0]!.status, "FAIL");
	});
});

test("numeric checks support array length paths (folds.length)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Folds, kind: numeric, file: results/r.json, path: folds.length, min: 2 }`,
			),
		});
		await mkdir(join(dir, "results"), { recursive: true });
		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ folds: [{ id: "a" }] }), "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.ok(result.gates[0]!.checks[0]!.failure_reason?.includes("below min"));
	});
});

test("recipe checks run declared recipes and record run evidence", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: "recipes:\n  - name: check:lint\n    command: [\"node\", \"-e\", \"process.exit(0)\"]\n",
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Lint, kind: recipe, recipe: check:lint }`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS");
		const evidence = result.gates[0]!.checks[0]!.evidence;
		assert.equal(evidence[0]!.type, "recipe_run");
		assert.equal(evidence[0]!.recipe, "check:lint");
		assert.equal(evidence[0]!.exit_code, 0);
		assert.ok(evidence[0]!.run_id, "recipe run id recorded");
	});
});

test("recipe checks fail when no alternative recipe is declared", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: "recipes:\n  - name: unrelated\n    command: [\"true\"]\n",
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Lint, kind: recipe, recipes: [check:lint, lint] }`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.ok(result.gates[0]!.checks[0]!.failure_reason?.includes("no declared recipe"));
	});
});

test("failed recipes fail their check with the run outcome recorded", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: "recipes:\n  - name: check:lint\n    command: [\"node\", \"-e\", \"process.exit(2)\"]\n",
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Lint, kind: recipe, recipe: check:lint }`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.equal(result.gates[0]!.checks[0]!.evidence[0]!.exit_code, 2);
	});
});

test("manual evidence is explicitly marked as type manual", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Audit, kind: manual, prompt: "audit" }`,
			),
		});
		const result = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "g1.1": "manual review completed" },
		});
		const evidenceJson = (await readRunFile(result.runDir, "evidence.json")) as { checks: Record<string, { evidence: { type: string; provided_by: string }[] }> };
		const evidence = evidenceJson.checks["g1.1"]!.evidence;
		assert.equal(evidence[0]!.type, "manual");
		assert.equal(evidence[0]!.provided_by, "manual-input");
	});
});

test("schema checks validate quant-result artifacts and keep failed folds visible", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Contract, kind: schema, file: results/quant-result.json, schema: quant-result }`,
			),
		});
		await mkdir(join(dir, "results"), { recursive: true });
		const artifact = makeValidQuantResult({
			folds: [
				{ id: "f1", status: "failed" },
				{ id: "f2", status: "passed", metrics: { return: 0.1, sharpe: 0.7 } },
			],
		});
		await writeFile(join(dir, "results", "quant-result.json"), JSON.stringify(artifact), "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS");
		const evidence = result.gates[0]!.checks[0]!.evidence[0]!;
		assert.equal(evidence.type, "schema");
		assert.ok((evidence.detail ?? "").includes("failed folds reported: f1"), "failed folds must stay visible in the evidence");

		// A contract violation fails the check.
		const broken = makeValidQuantResult();
		delete (broken.metrics as Record<string, unknown>).return;
		await writeFile(join(dir, "results", "quant-result.json"), JSON.stringify(broken), "utf8");
		const failed = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(failed.gates[0]!.status, "FAIL");
		assert.ok(failed.gates[0]!.checks[0]!.failure_reason?.includes("does not conform"));
	});
});

test("artifact checks use persisted run records, never model claims", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: [
				"recipes:",
				'  - name: producer',
				'    command: ["node", "-e", "require(\\"fs\\").mkdirSync(\\"out\\", { recursive: true }); require(\\"fs\\").writeFileSync(\\"out/result.json\\", \\"{}\\")"]',
				'    writes: ["out/"]',
				'    artifacts: ["out/*.json"]',
				"",
			].join("\n"),
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Output produced, kind: artifact, artifact_recipe: producer, glob: "out/*.json" }`,
			),
		});
		const before = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(before.gates[0]!.status, "FAIL", "no run of the recipe exists yet — must fail, not pass");

		const recipe = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec });
		assert.equal(recipe.ok, true);
		const after = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(after.gates[0]!.status, "PASS");
		assert.equal(after.gates[0]!.checks[0]!.evidence[0]!.run_id, recipe.record?.run_id);
	});
});

test("config checks fail when the workbench config has issues", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", "name: no-profile\n"); // profile missing → config issue
		await writeConfigFile(dir, "gates.yaml", "gates: []\n");
		const result = await runGates({ projectRoot: dir, selector: "b0", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.ok(result.gates[0]!.checks[0]!.failure_reason?.includes("config"));
	});
});

// ---------------------------------------------------------------------------
// Profiles: quant gates only for quant profiles
// ---------------------------------------------------------------------------

test("quant gates load only for quant profiles", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "generic" });
		const generic = await loadGates(dir);
		assert.deepEqual(generic.map((g) => g.id), ["b0", "b1", "b2", "b3", "b4", "b5"]);
		assert.ok(!generic.some((g) => g.id.startsWith("q")), "generic must not load quant gates");
	});

	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "quant-research/stock-selection" });
		const quant = await loadGates(dir);
		const ids = quant.map((g) => g.id);
		assert.deepEqual(ids, ["b0", "b1", "b2", "b3", "b4", "b5", "q0", "q1", "q2", "q3", "q4", "q5"]);
	});
});

test("generic profiles do not enforce quant gates (running all)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "generic" });
		await writeFile(join(dir, "package.json"), "{}", "utf8");
		await writeConfigFile(dir, "recipes.yaml", "recipes: []\n");
		const result = await runGates({ projectRoot: dir, selector: "all", mode: "DEV", exec: spawnExec });
		const ids = result.gates.map((g) => g.id);
		assert.ok(ids.includes("b0") && ids.includes("b5"), "base gates run");
		assert.ok(!ids.some((id) => id.startsWith("q")), "quant gates must not be evaluated for generic");
	});

	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "generic" });
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "q0", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("quant gates load only for quant-research profiles"),
		);
	});
});

test("the full base ladder passes when recipes and manual evidence are provided", async () => {
	await withTempDir(async (dir) => {
		const recipes = [
			"recipes:",
			'  - { name: check:format, command: ["node", "-e", "process.exit(0)"] }',
			'  - { name: check:lint, command: ["node", "-e", "process.exit(0)"] }',
			'  - { name: check:typecheck, command: ["node", "-e", "process.exit(0)"] }',
			'  - { name: check:static, command: ["node", "-e", "process.exit(0)"] }',
			'  - { name: test:unit, command: ["node", "-e", "process.exit(0)"] }',
			'  - { name: test:integration, command: ["node", "-e", "process.exit(0)"] }',
			"",
		].join("\n");
		await setupProject(dir, { profile: "generic", recipesYaml: recipes });
		await writeFile(join(dir, "package.json"), "{}", "utf8");
		const manualEvidence: Record<string, string> = {};
		for (const id of ["b2.2", "b2.3", "b3.2", "b3.3", "b4.1", "b4.2", "b4.3", "b5.1", "b5.2"]) {
			manualEvidence[id] = `manual evidence for ${id}`;
		}
		const result = await runGates({ projectRoot: dir, selector: "all", mode: "DEV", exec: spawnExec, manualEvidence });
		assert.equal(result.ok, true, `expected full base ladder PASS, got ${result.gates.map((g) => `${g.id}:${g.status}`).join(", ")}`);
		for (const g of result.gates) assert.equal(g.status, "PASS");
	});
});

// ---------------------------------------------------------------------------
// Path containment and gate config errors
// ---------------------------------------------------------------------------

test("evidence paths that escape the project root are rejected", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Evil, kind: file, path: ../evil.txt }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("escapes the project root"),
		);
	});

	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Evil, kind: json, file: /etc/passwd, path: x }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("escapes the project root"),
		);
	});
});

test("symlink escapes are rejected for evidence paths", async () => {
	await withTempDir(async (dir) => {
		await symlink("/etc", join(dir, "etc-link"));
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Evil, kind: file, path: etc-link/passwd }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("escapes the project root"),
		);
	});
});

test("invalid gates.yaml aborts the run with a setup error", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: X, kind: made-up-kind }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("kind"),
		);
	});
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test("gate results persist the full run record layout", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		const files = (await readFile(join(result.runDir, "manifest.json"), "utf8")).length > 0;
		assert.ok(files);
		const entries = (await import("node:fs/promises")).readdir;
		const names = (await entries(result.runDir)).sort();
		assert.deepEqual(names, ["artifacts", "evidence.json", "gates.json", "manifest.json", "stderr.log", "stdout.log", "summary.json"]);

		const manifest = (await readRunFile(result.runDir, "manifest.json")) as Record<string, unknown>;
		assert.equal(manifest.run_id, result.runId);
		assert.equal(manifest.recipe, "gate");
		assert.equal(manifest.exit_code, 0);
		assert.equal(manifest.profile, "generic");
		assert.ok(manifest.started_at && manifest.finished_at);
		assert.equal(typeof manifest.duration_ms, "number");

		const gates = (await readRunFile(result.runDir, "gates.json")) as {
			schema_version: number;
			run_id: string;
			requested: string[];
			gates: {
				id: string;
				status: string;
				prerequisites: string[];
				checks: unknown[];
				evidence_paths: string[];
				failure_reason: string | null;
				blocked_reason: string | null;
				started_at: string;
				finished_at: string;
			}[];
		};
		assert.equal(gates.schema_version, 1);
		assert.equal(gates.run_id, result.runId);
		assert.deepEqual(gates.requested, ["g1"]);
		const g = gates.gates[0]!;
		assert.equal(g.id, "g1");
		assert.equal(g.status, "PASS");
		assert.deepEqual(g.prerequisites, []);
		assert.equal(g.checks.length, 1);
		assert.ok(g.evidence_paths.length > 0, "evidence paths must be recorded");
		assert.equal(g.failure_reason, null);
		assert.equal(g.blocked_reason, null);
		assert.ok(g.started_at && g.finished_at);

		const summary = (await readRunFile(result.runDir, "summary.json")) as Record<string, unknown>;
		assert.equal(summary.status, "PASS");
		assert.equal(summary.kind, "gate");
		assert.ok(typeof summary.stdout === "string");
	});
});

test("repeated runs produce independent run ids", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`,
			),
		});
		const first = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		const second = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.notEqual(first.runId, second.runId);
		assert.notEqual(first.runDir, second.runDir);
		assert.equal(await latestGateStatus(dir, "g1").then((s) => s?.run_id), second.runId, "the latest status must come from the newest run");
	});
});

// ---------------------------------------------------------------------------
// gates.yaml overrides
// ---------------------------------------------------------------------------

test("project gate definitions replace built-in catalog gates by id", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: b0\n    title: Custom Readiness\n    checks:\n      - { id: b0.1, title: Config only, kind: config }`,
			),
		});
		const gates = await loadGates(dir);
		const b0 = gates.find((g) => g.id === "b0");
		assert.equal(b0?.title, "Custom Readiness");
		assert.equal(b0?.source, "project");
		assert.equal(b0?.checks.length, 1);

		const result = await runGates({ projectRoot: dir, selector: "b0", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.checks.length, 1, "the yaml definition fully replaced the built-in");
		assert.equal(result.gates[0]!.status, "PASS");
	});
});
