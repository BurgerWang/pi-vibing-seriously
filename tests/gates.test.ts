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
 * checks and yaml catalog overrides — plus P8 nested projects: file/json/
 * numeric/schema checks against the effective root while the built-in b0.4
 * workbench-config existence check stays repository-root anchored via
 * internal catalog-only metadata (gates.yaml can never set root/file_root).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import {
	GateSetupError,
	fileCheckRoot,
	latestGateStatus,
	loadGates,
	runGates,
	type CheckContext,
} from "../extensions/workbench-runtime/core/gate-engine.ts";
import { BASE_GATES } from "../extensions/workbench-runtime/core/gate-catalog.ts";
import { runRecipe } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import type { GateCheck, WorkerFirstGateFacts } from "../extensions/workbench-runtime/core/gate-schema.ts";
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
		assert.deepEqual(generic.map((g) => g.id), ["b0", "b1", "b2", "b3", "b4", "b5", "b6"]);
		assert.ok(!generic.some((g) => g.id.startsWith("q")), "generic must not load quant gates");
	});

	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "quant-research/stock-selection" });
		const quant = await loadGates(dir);
		const ids = quant.map((g) => g.id);
		assert.deepEqual(ids, ["b0", "b1", "b2", "b3", "b4", "b5", "b6", "q0", "q1", "q2", "q3", "q4", "q5"]);
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
		// P7: B6 is machine-backed — the runtime injects the bounded
		// worker-first compliance facts (clean state: strict policy active,
		// hard denial on, no delegation, lease locked, Sol-initiated run).
		const workerFirstFacts: WorkerFirstGateFacts = {
			schema_version: 1,
			actor: "sol-commander",
			writePolicy: "worker-first-strict",
			commanderWritesDenied: true,
			blockedCommanderWriteAttempts: 0,
			hasDelegation: false,
			latestDelegationId: null,
			reviewStatus: null,
			currentDiffHash: null,
			reviewedDiffHash: null,
			reviewVerdict: null,
			reviewViolationCount: null,
			leaseStatus: "locked",
			leaseReason: null,
			leaseCallsUsed: 0,
			leaseMaxCalls: 10,
			gateRunInitiatedByCommander: true,
		};
		const result = await runGates({ projectRoot: dir, selector: "all", mode: "DEV", exec: spawnExec, manualEvidence, workerFirstFacts });
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

// ---------------------------------------------------------------------------
// P7 slice 3: B6 Worker-First Compliance (machine-backed injected facts)
// ---------------------------------------------------------------------------

function cleanWorkerFirstFacts(overrides: Partial<WorkerFirstGateFacts> = {}): WorkerFirstGateFacts {
	return {
		schema_version: 1,
		actor: "sol-commander",
		writePolicy: "worker-first-strict",
		commanderWritesDenied: true,
		blockedCommanderWriteAttempts: 0,
		hasDelegation: false,
		latestDelegationId: null,
		reviewStatus: null,
		currentDiffHash: null,
		reviewedDiffHash: null,
		reviewVerdict: null,
		reviewViolationCount: null,
		leaseStatus: "locked",
		leaseReason: null,
		leaseCallsUsed: 0,
		leaseMaxCalls: 10,
		gateRunInitiatedByCommander: true,
		...overrides,
	};
}

test("B6 is a built-in universal base gate with exactly eight worker-first checks", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "generic" });
		const gates = await loadGates(dir);
		const b6 = gates.find((g) => g.id === "b6");
		assert.ok(b6, "b6 loads for generic profiles (universal base gate)");
		assert.equal(b6!.source, "catalog");
		assert.equal(b6!.prerequisites.length, 0, "B6 is independent of B0-B5 (no manual-evidence prerequisites)");
		assert.equal(b6!.required, true);
		assert.equal(b6!.blocking, true);
		assert.equal(b6!.checks.length, 8, "exactly the eight machine-backed checks");
		for (const c of b6!.checks) {
			assert.equal(c.kind, "worker-first");
			assert.equal(c.required, true);
			assert.ok(c.worker_first, `check ${c.id} names a worker_first assertion`);
		}
		assert.deepEqual(
			b6!.checks.map((c) => c.worker_first),
			[
				"strict-policy-active",
				"no-unauthorized-commander-writes",
				"no-pending-review",
				"no-stale-review",
				"reviewed-hash-matches-current",
				"worker-paths-within-contracts",
				"no-active-unexplained-lease",
				"commander-initiated-final-verification",
			],
		);
	});
});

test("B6 passes with clean injected facts (no manual evidence can be involved)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const result = await runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec, workerFirstFacts: cleanWorkerFirstFacts() });
		assert.equal(result.ok, true);
		assert.equal(result.gates[0]!.status, "PASS");
		for (const c of result.gates[0]!.checks) {
			assert.equal(c.status, "PASS", `${c.check_id}: ${c.failure_reason ?? c.blocked_reason ?? ""}`);
			assert.ok(c.evidence.some((e) => e.type === "worker_first"), `${c.check_id} records worker_first evidence`);
		}
	});
});

test("B6 fails on negative compliance facts (policy off, hash mismatch, violations, unexplained active lease, non-Sol initiator)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const cases: Array<{ label: string; facts: WorkerFirstGateFacts; failed: string[]; passed: string[] }> = [
			{
				label: "policy not active",
				facts: cleanWorkerFirstFacts({ writePolicy: null }),
				failed: ["b6.1"],
				passed: ["b6.2", "b6.3", "b6.4", "b6.5", "b6.6", "b6.7", "b6.8"],
			},
			{
				label: "unauthorized writes with denial off",
				facts: cleanWorkerFirstFacts({ commanderWritesDenied: false, blockedCommanderWriteAttempts: 3 }),
				failed: ["b6.2"],
				passed: ["b6.1", "b6.3", "b6.4", "b6.5", "b6.6", "b6.7", "b6.8"],
			},
			{
				label: "reviewed hash mismatch",
				facts: cleanWorkerFirstFacts({
					hasDelegation: true,
					latestDelegationId: "20260101-120000-abcd",
					reviewStatus: "REVIEWED",
					currentDiffHash: "a".repeat(64),
					reviewedDiffHash: "b".repeat(64),
					reviewVerdict: "PASS",
					reviewViolationCount: 0,
				}),
				failed: ["b6.5"],
				passed: ["b6.1", "b6.2", "b6.3", "b6.4", "b6.6", "b6.7", "b6.8"],
			},
			{
				label: "worker paths outside contracts",
				facts: cleanWorkerFirstFacts({
					hasDelegation: true,
					latestDelegationId: "20260101-120000-abcd",
					reviewStatus: "REVIEWED",
					currentDiffHash: "a".repeat(64),
					reviewedDiffHash: "a".repeat(64),
					reviewVerdict: "FAIL",
					reviewViolationCount: 2,
				}),
				failed: ["b6.6"],
				passed: ["b6.1", "b6.2", "b6.3", "b6.4", "b6.5", "b6.7", "b6.8"],
			},
			{
				label: "active lease without audited reason",
				facts: cleanWorkerFirstFacts({ leaseStatus: "active", leaseReason: null, leaseCallsUsed: 1, leaseMaxCalls: 10 }),
				failed: ["b6.7"],
				passed: ["b6.1", "b6.2", "b6.3", "b6.4", "b6.5", "b6.6", "b6.8"],
			},
			{
				label: "gate run initiated by another controller",
				facts: cleanWorkerFirstFacts({ actor: "other-controller", gateRunInitiatedByCommander: false }),
				failed: ["b6.8"],
				passed: ["b6.1", "b6.2", "b6.3", "b6.4", "b6.5", "b6.6", "b6.7"],
			},
		];
		for (const scenario of cases) {
			const result = await runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec, workerFirstFacts: scenario.facts });
			assert.equal(result.ok, false, `${scenario.label}: gate must not pass`);
			const statuses = new Map(result.gates[0]!.checks.map((c) => [c.check_id, c.status]));
			for (const id of scenario.failed) assert.equal(statuses.get(id), "FAIL", `${scenario.label}: ${id} must FAIL`);
			for (const id of scenario.passed) assert.equal(statuses.get(id), "PASS", `${scenario.label}: ${id} must PASS`);
		}
	});
});

test("B6 checks are BLOCKED when the facts carry a blocked reason (pending/stale review blocks final verification)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const facts = cleanWorkerFirstFacts({
			hasDelegation: true,
			latestDelegationId: "20260101-120000-abcd",
			reviewStatus: "PENDING_REVIEW",
			currentDiffHash: "a".repeat(64),
			blockedReason: "VERIFY mode / final gate verification is blocked while delegation 20260101-120000-abcd is PENDING_REVIEW; review the current diff first",
		});
		const result = await runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec, workerFirstFacts: facts });
		assert.equal(result.gates[0]!.status, "BLOCKED");
		assert.equal(result.ok, false);
		for (const c of result.gates[0]!.checks) {
			assert.equal(c.status, "BLOCKED", `${c.check_id} must be BLOCKED`);
			assert.ok(c.blocked_reason?.includes("PENDING_REVIEW"));
		}
	});
});

test("B6 without injected facts is NOT_RUN and a required NOT_RUN never PASSes", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		// No facts at all: every worker-first check is NOT_RUN, the gate is
		// NOT_RUN and never PASSes — model prose/manual evidence cannot help.
		const result = await runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "NOT_RUN");
		assert.equal(result.ok, false);
		for (const c of result.gates[0]!.checks) assert.equal(c.status, "NOT_RUN");
		// Manual evidence for worker-first check ids must not change anything.
		const withManual = await runGates({
			projectRoot: dir,
			selector: "b6",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "b6.1": "the policy is definitely active, trust me" },
		});
		assert.equal(withManual.gates[0]!.status, "NOT_RUN", "manual evidence can never satisfy worker-first checks");
	});
});

test("partial facts produce NOT_RUN only for the checks whose fact is missing", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const facts = cleanWorkerFirstFacts({
			hasDelegation: true,
			latestDelegationId: "20260101-120000-abcd",
			reviewStatus: null, // review facts missing
			leaseStatus: null, // lease facts missing
		});
		const result = await runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec, workerFirstFacts: facts });
		const statuses = new Map(result.gates[0]!.checks.map((c) => [c.check_id, c.status]));
		assert.equal(statuses.get("b6.1"), "PASS");
		assert.equal(statuses.get("b6.3"), "NOT_RUN", "missing review-status fact -> NOT_RUN");
		assert.equal(statuses.get("b6.4"), "NOT_RUN");
		assert.equal(statuses.get("b6.7"), "NOT_RUN", "missing lease-status fact -> NOT_RUN");
		assert.equal(result.gates[0]!.status, "NOT_RUN", "required NOT_RUN checks keep the gate NOT_RUN");
	});
});

test("gates.yaml worker-first checks validate strictly (kind + worker_first name)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: WF, kind: worker-first }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("worker_first"),
		);
	});
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: WF, kind: worker-first, worker_first: made-up }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("worker_first"),
		);
	});
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: WF, kind: file, worker_first: strict-policy-active }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("worker_first"),
		);
	});
});

test("B6 runs directly with selector b6 without any B0-B5 evidence", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		// No manual evidence, no recipes, no B0-B5 prerequisite runs: B6 still
		// evaluates from the injected facts alone.
		const result = await runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec, workerFirstFacts: cleanWorkerFirstFacts() });
		assert.equal(result.ok, true);
		assert.equal(result.gates[0]!.status, "PASS");
	});
});

// ---------------------------------------------------------------------------
// P7 slice 3: gate-engine recipe checks apply the shared mutation policy
// ---------------------------------------------------------------------------

test("recipe checks apply the shared mutation policy: strict Sol denies mutation:source, workers run only mutation:none", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: [
				"recipes:",
				'  - { name: fmt, command: ["node", "-e", "process.exit(0)"], mutation: source, writes: ["src/"] }',
				'  - { name: build, command: ["node", "-e", "process.exit(0)"], mutation: artifacts, artifacts: ["dist/**"] }',
				'  - { name: verify, command: ["node", "-e", "process.exit(0)"], mutation: none }',
				"",
			].join("\n"),
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Fmt, kind: recipe, recipe: fmt }`,
					`  - id: g2\n    title: G2\n    checks:\n      - { id: g2.1, title: Build, kind: recipe, recipe: build }`,
					`  - id: g3\n    title: G3\n    checks:\n      - { id: g3.1, title: Verify, kind: recipe, recipe: verify }`,
				].join("\n"),
			),
		});
		// Strict Sol: mutation:source recipe check is BLOCKED; none/artifacts run.
		const sol = await runGates({
			projectRoot: dir,
			selector: "g1,g2,g3",
			mode: "DEV",
			exec: spawnExec,
			actorFacts: { role: undefined, provider: "openai-codex", model: "gpt-5.6-sol" },
		});
		assert.equal(sol.gates[0]!.status, "BLOCKED");
		assert.ok(sol.gates[0]!.checks[0]!.blocked_reason?.includes("mutation: source"), sol.gates[0]!.checks[0]!.blocked_reason ?? "");
		assert.equal(sol.gates[1]!.status, "PASS", "mutation:artifacts recipe check runs for strict Sol");
		assert.equal(sol.gates[2]!.status, "PASS", "mutation:none recipe check runs for strict Sol");
		// Delegated worker: only mutation:none runs.
		const worker = await runGates({
			projectRoot: dir,
			selector: "g1,g2,g3",
			mode: "DEV",
			exec: spawnExec,
			actorFacts: { role: "worker", provider: "deepseek", model: "deepseek-v4-flash" },
		});
		assert.equal(worker.gates[0]!.status, "BLOCKED");
		assert.equal(worker.gates[1]!.status, "BLOCKED", "workers cannot run mutation:artifacts recipes");
		assert.ok(worker.gates[1]!.checks[0]!.blocked_reason?.includes("mutation: artifacts"));
		assert.equal(worker.gates[2]!.status, "PASS", "workers run mutation:none recipe checks");
		// Other controllers / no actor facts: prior behavior (all run).
		const other = await runGates({ projectRoot: dir, selector: "g1,g2,g3", mode: "DEV", exec: spawnExec });
		assert.equal(other.gates[0]!.status, "PASS");
		assert.equal(other.gates[1]!.status, "PASS");
		assert.equal(other.gates[2]!.status, "PASS");
	});
});

// ---------------------------------------------------------------------------
// P8: safe nested project support (project.yaml project_dir)
// ---------------------------------------------------------------------------

test("file/json/numeric gate checks resolve against the effective project root", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Data, kind: file, path: data/prices.csv }`,
					`  - id: g2\n    title: G2\n    checks:\n      - { id: g2.1, title: JSON, kind: json, file: results/r.json, path: split.method }`,
					`  - id: g3\n    title: G3\n    checks:\n      - { id: g3.1, title: Numeric, kind: numeric, file: results/r.json, path: metrics.return, min: 0 }`,
				].join("\n"),
			),
		);
		// Artifacts exist ONLY under the nested root — never under the repo root.
		await mkdir(join(dir, "research", "data"), { recursive: true });
		await writeFile(join(dir, "research", "data", "prices.csv"), "x", "utf8");
		await mkdir(join(dir, "research", "results"), { recursive: true });
		await writeFile(join(dir, "research", "results", "r.json"), JSON.stringify({ split: { method: "walk-forward" }, metrics: { return: 0.1 } }), "utf8");

		const result = await runGates({ projectRoot: dir, selector: "g1,g2,g3", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS", result.gates[0]!.failure_reason ?? "");
		assert.equal(result.gates[1]!.status, "PASS", result.gates[1]!.failure_reason ?? "");
		assert.equal(result.gates[2]!.status, "PASS", result.gates[2]!.failure_reason ?? "");
		assert.equal(result.ok, true);
	});
});

test("nested gate file checks ignore repository-root files (no fallback to the repo root)", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Data, kind: file, path: data/prices.csv }`),
		);
		// The file exists ONLY at the repo root — the check must still FAIL.
		await mkdir(join(dir, "data"), { recursive: true });
		await writeFile(join(dir, "data", "prices.csv"), "x", "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.ok(result.gates[0]!.checks[0]!.failure_reason?.includes("no file matched"));
	});
});

test("nested gate file checks still reject symlink escapes relative to the effective root", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await symlink("/etc", join(dir, "research", "etc-link"));
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Evil, kind: file, path: etc-link/passwd }`),
		);
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("escapes the project root"),
		);
	});
});

test("schema checks read artifacts from the effective project root", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Contract, kind: schema, file: results/quant-result.json, schema: quant-result }`),
		);
		await mkdir(join(dir, "research", "results"), { recursive: true });
		await writeFile(join(dir, "research", "results", "quant-result.json"), JSON.stringify(makeValidQuantResult()), "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS", result.gates[0]!.checks[0]!.failure_reason ?? "");
	});
});

test("gate runs persist at the repository root when project_dir is set", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`),
		);
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS");
		// The run record lives under the REPO root's .pi/workbench/runs — never
		// inside the nested project directory.
		assert.ok(
			result.runDir.startsWith(join(dir, ".pi", "workbench", "runs") + sep),
			`runDir ${result.runDir} must be under the repo root runs dir`,
		);
		const manifest = (await readRunFile(result.runDir, "manifest.json")) as Record<string, unknown>;
		assert.equal(manifest.cwd, dir, "the gate run cwd stays at the repository root");
	});
});

test("recipe execution and artifact checks stay repository-root based with project_dir set", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"recipes.yaml",
			[
				"recipes:",
				'  - name: producer',
				'    command: ["node", "-e", "process.stdout.write(process.cwd()); require(\\"fs\\").mkdirSync(\\"out\\", { recursive: true }); require(\\"fs\\").writeFileSync(\\"out/result.json\\", \\"{}\\")"]',
				'    artifacts: ["out/*.json"]',
				"",
			].join("\n"),
		);
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Output, kind: artifact, artifact_recipe: producer }`),
		);
		// The recipe executes at the REPO root (recipe cwd semantics unchanged).
		const recipe = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec });
		assert.equal(recipe.ok, true, recipe.error ?? "");
		assert.equal(recipe.record?.cwd, dir, "recipe cwd stays at the repository root");
		const manifest = (await readRunFile(recipe.runDir!, "manifest.json")) as Record<string, unknown>;
		assert.equal(manifest.cwd, dir);

		// The artifact check reads the run record at the repo root and passes.
		const gate = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(gate.gates[0]!.status, "PASS", gate.gates[0]!.failure_reason ?? "");
	});
});

// ---------------------------------------------------------------------------
// P8: the built-in workbench-config existence check (b0.4) stays
// repository-root anchored via INTERNAL catalog metadata — a nested
// effective root must never relocate or impersonate it, and a project
// gates.yaml can never request repository-root anchoring (root/file_root
// are rejected by the strict schema)
// ---------------------------------------------------------------------------

test("built-in b0.4 checks the repository-root workbench config for nested projects", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		// Repository root: the workbench config written by /q-init (project.yaml
		// declares the nested effective root; recipes.yaml + empty gates.yaml
		// keep the built-in catalog).
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(dir, "recipes.yaml", "recipes: []\n");
		await writeConfigFile(dir, "gates.yaml", "gates: []\n");
		// Effective root only: manifest + dependency files (the b0.2/b0.3
		// targets) — and NO .pi/workbench under the nested directory.
		await writeFile(join(dir, "research", "package.json"), "{}", "utf8");
		await writeFile(join(dir, "research", "package-lock.json"), "{}", "utf8");

		const result = await runGates({ projectRoot: dir, selector: "b0", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.id, "b0");
		const byId = new Map(result.gates[0]!.checks.map((c) => [c.check_id, c]));
		assert.equal(byId.get("b0.1")!.status, "PASS", byId.get("b0.1")!.failure_reason ?? "");
		assert.equal(byId.get("b0.2")!.status, "PASS", "manifest is found at the effective root");
		assert.equal(byId.get("b0.3")!.status, "PASS", "dependency files are found at the effective root");
		assert.equal(
			byId.get("b0.4")!.status,
			"PASS",
			"workbench config is found at the repository root even though the nested root has no .pi/workbench",
		);
		assert.equal(result.gates[0]!.status, "PASS", result.gates[0]!.failure_reason ?? "");
		assert.equal(result.ok, true);
	});
});

test("a nested .pi/workbench cannot satisfy the built-in b0.4 repository-root check", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research", ".pi", "workbench"), { recursive: true });
		// Repository root: NO workbench config at all (no .pi/workbench). The
		// nested directory carries the complete config it would need if it
		// were the project root — project.yaml + recipes.yaml + gates.yaml
		// (impersonation attempt).
		await writeFile(join(dir, "research", ".pi", "workbench", "project.yaml"), "name: nested\nprofile: generic\n", "utf8");
		await writeFile(join(dir, "research", ".pi", "workbench", "recipes.yaml"), "recipes: []\n", "utf8");
		await writeFile(join(dir, "research", ".pi", "workbench", "gates.yaml"), "gates: []\n", "utf8");

		// Nested-only config must NOT satisfy the repository-root anchored b0.4.
		const result = await runGates({ projectRoot: dir, selector: "b0", mode: "DEV", exec: spawnExec });
		const byId = new Map(result.gates[0]!.checks.map((c) => [c.check_id, c]));
		assert.equal(byId.get("b0.4")!.status, "FAIL", "a nested .pi/workbench must never satisfy b0.4");
		assert.ok(byId.get("b0.4")!.failure_reason?.includes("no file matched"), byId.get("b0.4")!.failure_reason ?? "");
		assert.equal(result.gates[0]!.status, "FAIL");

		// Control: once the repository root itself carries the workbench config
		// (project.yaml + recipes.yaml written by /q-init; project_dir keeps the
		// effective root nested) the same check passes — the repository root is
		// the only source, even with the nested .pi/workbench still present.
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(dir, "recipes.yaml", "recipes: []\n");
		await writeConfigFile(dir, "gates.yaml", "gates: []\n");
		await writeFile(join(dir, "research", "package.json"), "{}", "utf8");
		await writeFile(join(dir, "research", "package-lock.json"), "{}", "utf8");
		const again = await runGates({ projectRoot: dir, selector: "b0", mode: "DEV", exec: spawnExec });
		const againById = new Map(again.gates[0]!.checks.map((c) => [c.check_id, c]));
		assert.equal(againById.get("b0.1")!.status, "PASS", againById.get("b0.1")!.failure_reason ?? "");
		assert.equal(againById.get("b0.2")!.status, "PASS", againById.get("b0.2")!.failure_reason ?? "");
		assert.equal(againById.get("b0.3")!.status, "PASS", againById.get("b0.3")!.failure_reason ?? "");
		assert.equal(againById.get("b0.4")!.status, "PASS", againById.get("b0.4")!.failure_reason ?? "");
		assert.equal(again.gates[0]!.status, "PASS", again.gates[0]!.failure_reason ?? "");
		assert.equal(again.ok, true);
	});
});

test("file checks without root metadata keep resolving against the effective root", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research", ".pi", "workbench"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: WB config, kind: file, path: .pi/workbench/recipes.yaml }`),
		);
		// The file exists ONLY under the nested effective root — the default
		// (effective-root) anchoring still finds it; only the built-in b0.4
		// internal repository-root metadata would ignore it.
		await writeFile(join(dir, "research", ".pi", "workbench", "recipes.yaml"), "recipes: []\n", "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS", result.gates[0]!.failure_reason ?? "");
	});
});

test("gates.yaml cannot set root or file_root (strict schema, internal metadata only)", async () => {
	// `root` is no longer a public gate-check field: rejected for any kind,
	// including kind=file with the previously-valid "repository" value.
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: C, kind: file, root: repository, path: package.json }`),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes('unknown field "root"'),
		);
	});
	// Even the no-op "effective" value is rejected — the schema has no root option.
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: C, kind: file, root: effective, path: x }`),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes('unknown field "root"'),
		);
	});
	// Non-file kinds reject it too (previously "root is only valid for kind=file").
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: C, kind: json, file: x.json, path: a, root: repository }`),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes('unknown field "root"'),
		);
	});
	// The internal metadata name file_root is equally rejected from YAML.
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: C, kind: file, file_root: repository, path: package.json }`),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes('unknown field "file_root"'),
		);
	});
});

test("built-in b0.4 is the only catalog check with internal repository-root metadata", async () => {
	const b0 = BASE_GATES.find((g) => g.id === "b0");
	assert.ok(b0, "base gate b0 exists");
	const b04 = b0!.checks.find((c) => c.id === "b0.4");
	assert.ok(b04, "built-in b0.4 exists");
	assert.equal(b04!.file_root, "repository", "b0.4 carries the internal file_root: repository metadata");
	for (const c of b0!.checks) {
		if (c.id !== "b0.4") {
			assert.equal(c.file_root, undefined, `built-in ${c.id} must not carry file_root`);
		}
	}
	// The engine helper maps the internal metadata to the repository root and
	// everything else to the effective root.
	const ctx = { projectRoot: "/repo", effectiveProjectRoot: "/repo/research" } as unknown as CheckContext;
	assert.equal(fileCheckRoot(ctx, b04 as GateCheck), "/repo", "file_root: repository selects the repository root");
	const plain: GateCheck = { ...(b04 as GateCheck), file_root: undefined };
	assert.equal(fileCheckRoot(ctx, plain), "/repo/research", "default file checks select the effective root");
});
