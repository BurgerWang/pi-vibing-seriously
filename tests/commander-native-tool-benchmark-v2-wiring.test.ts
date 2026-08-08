/**
 * NRO protocol-v2 package/recipe wiring tests — hermetic, read-only parsing
 * of package.json and .pi/workbench/recipes.yaml (no recipe execution, no
 * prepare/analyze/collection, no v2 run artifacts). Covers:
 *
 *   - package.json: exactly the three intended v2 scripts with the frozen
 *     v2 inputs path, the fixed v2 manifest path and the v2 FINAL
 *     collector entry; every pre-existing script and the version metadata
 *     stay byte-identical;
 *   - recipes.yaml stays schema-valid (no parse errors/warnings) and the
 *     declared recipe set is exactly the pre-existing set plus the three v2
 *     recipes (nothing removed);
 *   - commander-native-tool-benchmark-v2-prepare: exact argv through the
 *     package script (`--collection {{collection}}`), exactly one required
 *     string param, DEV+VERIFY, expected exit 0, mutation artifacts, the
 *     only two v2 evidence outputs declared as writes/artifacts, no cache
 *     block, exact param → argv wiring;
 *   - commander-native-tool-benchmark-v2: fixed JSON invocation carried by
 *     the package script (no recipe-level args), no params, no writes, no
 *     artifacts, mutation none, DEV+VERIFY, expected exit 0, no cache;
 *   - commander-native-tool-v2-final-collect: exact argv through the v2
 *     FINAL package script, DEV-only, PAID external provider/model
 *     collection requiring separate explicit user authorization,
 *     intentionally uncached, expected exits [0,1], mutation artifacts,
 *     writes/artifacts exactly the independent v2 final collection root,
 *     no params/env, and the sufficient bounded timeout (the existing v1
 *     FINAL timeout 112500000);
 *   - the existing v1 package scripts and v1 NRO/P9 recipes are unchanged.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { parse as parseYaml } from "yaml";

import { buildArgv, parseRecipesDocument } from "../extensions/workbench-runtime/core/recipe-schema.ts";

import { ATTEMPT_TIMEOUT_MS_V2, FINAL_V2_MAX_ATTEMPTS, OUTPUT_ROOT_NAME_V2 } from "../scripts/commander-native-tool-v2-final-collect.ts";

// ---------------------------------------------------------------------------
// package.json wiring
// ---------------------------------------------------------------------------

const V2_PREPARE_SCRIPT = "tsx scripts/commander-native-tool-benchmark-v2-prepare.ts prepare --inputs fixtures/commander-native-tool-benchmark-v2/inputs";
const V2_BENCHMARK_SCRIPT = "tsx scripts/commander-native-tool-benchmark-v2-analyze.ts analyze .pi/workbench/runs/commander-native-tool-benchmark-v2-manifest.json --json";
const V2_FINAL_SCRIPT = "tsx scripts/commander-native-tool-v2-final-collect.ts";

test("package.json: exactly the three intended v2 scripts, frozen v2 inputs and fixed v2 manifest path; all existing scripts and version metadata unchanged", async () => {
	const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version?: string; scripts?: Record<string, string> };

	// Exactly the three v2 scripts, with the exact frozen intent.
	assert.equal(pkg.scripts?.["commander:nro:v2:prepare"], V2_PREPARE_SCRIPT);
	assert.equal(pkg.scripts?.["commander:nro:v2:benchmark"], V2_BENCHMARK_SCRIPT);
	assert.equal(pkg.scripts?.["commander:nro:v2:final"], V2_FINAL_SCRIPT);

	// The complete scripts map is exactly the pre-existing 12 scripts plus
	// the three v2 scripts — nothing changed, nothing added.
	assert.deepEqual(pkg.scripts, {
		typecheck: "tsc --noEmit",
		test: "tsx --test tests/*.test.ts",
		check: "npm run typecheck && npm test && git diff --check",
		"commander:benchmark": "tsx scripts/commander-token-benchmark.ts",
		"commander:prepare": "tsx scripts/commander-token-p9-prepare.ts",
		"commander:nro:prepare": "tsx scripts/commander-native-tool-benchmark.ts prepare --inputs fixtures/commander-native-tool-benchmark/inputs",
		"commander:nro:benchmark": "tsx scripts/commander-native-tool-benchmark.ts analyze .pi/workbench/runs/commander-native-tool-benchmark-manifest.json --json",
		"commander:nro:v2:prepare": V2_PREPARE_SCRIPT,
		"commander:nro:v2:benchmark": V2_BENCHMARK_SCRIPT,
		"commander:nro:v2:final": V2_FINAL_SCRIPT,
		"commander:nro:final": "tsx scripts/commander-native-tool-final-collect.ts",
		"commander:nro:pilot": "tsx scripts/commander-native-tool-dev-pilot.ts",
		"cache:report": "tsx scripts/cache-benchmark.ts report",
		"cache:doctor": "tsx scripts/cache-benchmark.ts doctor",
	});
	// No version metadata drift.
	assert.equal(pkg.version, "0.9.0");
});

// ---------------------------------------------------------------------------
// recipes.yaml wiring
// ---------------------------------------------------------------------------

const V2_EVIDENCE_DIR = ".pi/workbench/runs/commander-native-tool-benchmark-v2/**";
const V2_MANIFEST = ".pi/workbench/runs/commander-native-tool-benchmark-v2-manifest.json";

async function loadRecipes(): Promise<ReturnType<typeof parseRecipesDocument>> {
	const text = await readFile(join(process.cwd(), ".pi", "workbench", "recipes.yaml"), "utf8");
	return parseRecipesDocument(parseYaml(text));
}

test("recipes.yaml: schema-valid, declared recipe set is exactly the pre-existing set plus the three v2 recipes", async () => {
	const doc = await loadRecipes();
	assert.deepEqual(doc.errors, []);
	assert.deepEqual(doc.warnings, []);
	// The declared recipe set is exactly the pre-existing set plus the three
	// v2 recipes — the parser returns recipes sorted by name, so compare
	// order-independently.
	assert.deepEqual(
		[...doc.recipes.map((r) => r.name)].sort(),
		[
			"typecheck",
			"unit-test",
			"check",
			"commander-token-p9-prepare",
			"commander-token-p9-benchmark",
			"commander-native-tool-benchmark-prepare",
			"commander-native-tool-benchmark",
			"commander-native-tool-benchmark-v2-prepare",
			"commander-native-tool-benchmark-v2",
			"commander-native-tool-v2-final-collect",
			"commander-native-tool-dev-pilot-collect",
			"commander-native-tool-final-collect",
		].sort(),
	);
	// No recipe besides the three v2 ones may reference the v2 package scripts.
	const v2ScriptNames = new Set(["commander:nro:v2:prepare", "commander:nro:v2:benchmark", "commander:nro:v2:final"]);
	for (const recipe of doc.recipes) {
		const touched = recipe.command.filter((a) => v2ScriptNames.has(a));
		const expected =
			recipe.name === "commander-native-tool-benchmark-v2-prepare"
				? ["commander:nro:v2:prepare"]
				: recipe.name === "commander-native-tool-benchmark-v2"
					? ["commander:nro:v2:benchmark"]
					: recipe.name === "commander-native-tool-v2-final-collect"
						? ["commander:nro:v2:final"]
						: [];
		assert.deepEqual(touched, expected, `recipe ${recipe.name} must use only its own v2 script`);
	}
});

test("recipes.yaml: commander-native-tool-benchmark-v2-prepare — exact argv, one required collection param, artifact-only v2 outputs, uncached", async () => {
	const doc = await loadRecipes();
	assert.deepEqual(doc.errors, []);
	assert.deepEqual(doc.warnings, []);
	const recipe = doc.recipes.find((r) => r.name === "commander-native-tool-benchmark-v2-prepare");
	assert.ok(recipe, "commander-native-tool-benchmark-v2-prepare recipe declared");

	// Exact argv shape: npm run commander:nro:v2:prepare -- --collection <placeholder>.
	assert.deepEqual(recipe.command, ["npm", "run", "commander:nro:v2:prepare", "--", "--collection", "{{collection}}"]);
	assert.equal(recipe.cwd, ".");
	// Exactly the one required string param, in fixed order.
	assert.deepEqual(
		recipe.params.map((p) => [p.name, p.type, p.required]),
		[["collection", "string", true]],
	);
	// Artifact-only write surface: exactly the two v2 evidence outputs.
	assert.deepEqual(recipe.writes, [V2_EVIDENCE_DIR, V2_MANIFEST]);
	assert.deepEqual(recipe.artifacts, [V2_EVIDENCE_DIR, V2_MANIFEST]);
	assert.equal(recipe.mutation, "artifacts");
	assert.deepEqual(recipe.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(recipe.expected_exit_codes, [0]);
	assert.deepEqual(recipe.environment, []);
	// Intentionally uncached (no cache block).
	assert.equal(recipe.cache.enabled, false);

	// Exact param -> argv wiring.
	const argv = buildArgv(recipe, { collection: "fixtures/commander-native-tool-benchmark-v2/collection-record.json" });
	assert.deepEqual(argv, ["npm", "run", "commander:nro:v2:prepare", "--", "--collection", "fixtures/commander-native-tool-benchmark-v2/collection-record.json"]);
});

test("recipes.yaml: commander-native-tool-benchmark-v2 — fixed JSON invocation through the package script, read-only, uncached, no params", async () => {
	const doc = await loadRecipes();
	assert.deepEqual(doc.errors, []);
	const recipe = doc.recipes.find((r) => r.name === "commander-native-tool-benchmark-v2");
	assert.ok(recipe, "commander-native-tool-benchmark-v2 recipe declared");
	// The fixed manifest path and --json live in the package script; the
	// recipe carries no arguments.
	assert.deepEqual(recipe.command, ["npm", "run", "commander:nro:v2:benchmark"]);
	assert.equal(recipe.cwd, ".");
	assert.equal(recipe.mutation, "none");
	assert.deepEqual(recipe.writes, []);
	assert.deepEqual(recipe.artifacts, []);
	assert.deepEqual(recipe.params, []);
	assert.deepEqual(recipe.environment, []);
	assert.deepEqual(recipe.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(recipe.expected_exit_codes, [0]);
	// Intentionally uncached (no cache block).
	assert.equal(recipe.cache.enabled, false);
});

test("recipes.yaml: commander-native-tool-v2-final-collect — exact argv, DEV-only, PAID/authorization-labelled, uncached, [0,1], artifact-only exact root, no params/env, sufficient bounded timeout", async () => {
	const doc = await loadRecipes();
	assert.deepEqual(doc.errors, []);
	assert.deepEqual(doc.warnings, []);
	const recipe = doc.recipes.find((r) => r.name === "commander-native-tool-v2-final-collect");
	assert.ok(recipe, "commander-native-tool-v2-final-collect recipe declared");

	// exact invocation: the v2 FINAL package script, no args, project cwd
	assert.deepEqual(recipe.command, ["npm", "run", "commander:nro:v2:final"]);
	assert.equal(recipe.cwd, ".");
	// paid external provider/model collection, DEV-only, clearly labelled
	assert.deepEqual(recipe.allowed_modes, ["DEV"]);
	assert.ok(recipe.description.includes("PAID"), "recipe must be labelled as PAID external provider/model collection");
	assert.ok(recipe.description.includes("authorization"), "recipe must require separate explicit user authorization");
	assert.ok(recipe.description.includes("ABBAx10"), "recipe must state the fixed ABBAx10 plan");
	assert.ok(recipe.description.includes("40 valid"), "recipe must state the fixed 40-valid cohort");
	assert.ok(recipe.description.includes("20 per arm"), "recipe must state 20 sessions per arm");
	assert.ok(recipe.description.includes("60 successfully-started"), "recipe must state the max 60 successfully-started attempts");
	// expected exits: 0 = complete 40-valid collection; 1 = truthful capped partial / runtime hard-fail
	assert.deepEqual(recipe.expected_exit_codes, [0, 1]);
	// mutation/artifact/write scope: ONLY the independent v2 final collection root
	assert.equal(recipe.mutation, "artifacts");
	assert.deepEqual(recipe.writes, [`.pi/workbench/runs/${OUTPUT_ROOT_NAME_V2}/**`]);
	assert.deepEqual(recipe.artifacts, [`.pi/workbench/runs/${OUTPUT_ROOT_NAME_V2}/**`]);
	// no params, no env
	assert.deepEqual(recipe.params, []);
	assert.deepEqual(recipe.environment, []);
	// intentionally never cached
	assert.equal(recipe.cache.enabled, false);
	// timeout: the existing v1 FINAL timeout (112500000) — covers the frozen
	// worst case 60 x 30-minute per-attempt timeouts plus bounded overhead
	assert.equal(recipe.timeout_ms, 112500000);
	assert.equal(FINAL_V2_MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS_V2, 60 * 30 * 60 * 1000);
	assert.ok(
		recipe.timeout_ms >= FINAL_V2_MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS_V2 + 3_600_000,
		`timeout must cover ~31 h (60 x 30 min + overhead), got ${recipe.timeout_ms}`,
	);
	assert.ok(recipe.timeout_ms <= 150_000_000, `timeout must stay bounded, got ${recipe.timeout_ms}`);
});

test("recipes.yaml: existing v1 recipe/package wiring is unchanged", async () => {
	const doc = await loadRecipes();
	assert.deepEqual(doc.errors, []);
	assert.deepEqual(doc.warnings, []);
	const byName = new Map(doc.recipes.map((r) => [r.name, r]));

	// v1 NRO prepare: exact argv, single required collection param, the two
	// v1 evidence outputs, artifact-only, uncached.
	const v1Prepare = byName.get("commander-native-tool-benchmark-prepare");
	assert.ok(v1Prepare);
	assert.deepEqual(v1Prepare.command, ["npm", "run", "commander:nro:prepare", "--", "--collection", "{{collection}}"]);
	assert.deepEqual(
		v1Prepare.params.map((p) => [p.name, p.type, p.required]),
		[["collection", "string", true]],
	);
	assert.deepEqual(v1Prepare.writes, [".pi/workbench/runs/commander-native-tool-benchmark/**", ".pi/workbench/runs/commander-native-tool-benchmark-manifest.json"]);
	assert.deepEqual(v1Prepare.artifacts, [".pi/workbench/runs/commander-native-tool-benchmark/**", ".pi/workbench/runs/commander-native-tool-benchmark-manifest.json"]);
	assert.equal(v1Prepare.mutation, "artifacts");
	assert.deepEqual(v1Prepare.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(v1Prepare.expected_exit_codes, [0]);
	assert.equal(v1Prepare.cache.enabled, false);

	// v1 NRO analyzer: fixed JSON invocation, read-only, uncached.
	const v1Benchmark = byName.get("commander-native-tool-benchmark");
	assert.ok(v1Benchmark);
	assert.deepEqual(v1Benchmark.command, ["npm", "run", "commander:nro:benchmark"]);
	assert.equal(v1Benchmark.mutation, "none");
	assert.deepEqual(v1Benchmark.writes, []);
	assert.deepEqual(v1Benchmark.artifacts, []);
	assert.deepEqual(v1Benchmark.params, []);
	assert.equal(v1Benchmark.cache.enabled, false);

	// Cache policy of the base recipes is untouched.
	const typecheck = byName.get("typecheck");
	assert.ok(typecheck);
	assert.deepEqual(typecheck.command, ["npm", "run", "typecheck"]);
	assert.equal(typecheck.mutation, "none");
	assert.deepEqual(typecheck.writes, []);
	assert.deepEqual(typecheck.artifacts, []);
	assert.equal(typecheck.cache.enabled, true);
	const unitTest = byName.get("unit-test");
	assert.ok(unitTest);
	assert.deepEqual(unitTest.command, ["npm", "test"]);
	assert.equal(unitTest.mutation, "none");
	assert.equal(unitTest.cache.enabled, true);
	const check = byName.get("check");
	assert.ok(check);
	assert.deepEqual(check.command, ["npm", "run", "check"]);
	assert.equal(check.mutation, "none");
	assert.equal(check.cache.enabled, false);
});
