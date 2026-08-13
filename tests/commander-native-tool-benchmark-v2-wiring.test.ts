/**
 * NRO protocol-v2 package/recipe wiring tests — hermetic, read-only parsing
 * of package.json and .pi/workbench/recipes.yaml (no recipe execution, no
 * prepare/analyze/collection, no v2 run artifacts). Covers:
 *
 *   - package.json: exactly the three intended v2 scripts with the frozen
 *     v2 inputs path, the fixed v2 manifest path and the v2 FINAL
 *     collector entry; every pre-existing script and the version metadata
 *     stay byte-identical (the later test:release-assets,
 *     test:runtime-core, test:gate-preflight, test:worker-efficiency,
 *     test:diff-review-efficiency, test:context-output-baseline,
 *     test:context-output-core and
 *     benchmark:context-output scripts and the release-assets-test,
 *     runtime-core-test, typecheck-feedback, gate-preflight-test,
 *     worker-efficiency-test, diff-review-efficiency-test,
 *     context-output-baseline-test, context-output-core-test and
 *     context-output-benchmark recipes are
 *     additive and pinned here or in tests/execution-efficiency.test.ts);
 *   - recipes.yaml stays schema-valid (no parse errors/warnings) and the
 *     declared recipe set is exactly the pre-existing set plus the three v2
 *     recipes, release-assets-test, runtime-core-test, typecheck-feedback,
 *     gate-preflight-test, worker-efficiency-test, diff-review-efficiency-test,
 *     context-output-baseline-test, context-output-core-test and
 *     context-output-benchmark (nothing
 *     removed);
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
const CONTEXT_OUTPUT_BASELINE_SCRIPT = "tsx --test tests/context-output-baseline.test.ts";
const CONTEXT_OUTPUT_CORE_SCRIPT = "tsx --test tests/output-envelope.test.ts tests/turn-output-budget.test.ts tests/continuation-cursor.test.ts tests/bounded-file-io.test.ts tests/details-projection.test.ts tests/context-history-budget.test.ts tests/output-control-telemetry.test.ts";
const CONTEXT_OUTPUT_INTEGRATION_SCRIPT = "tsx --test tests/output-control-wiring.test.ts tests/read-v3.test.ts tests/read-run-log-page.test.ts tests/compare-output-bounds.test.ts tests/gate-output-bounds.test.ts tests/context-output-worker.test.ts";
const CONTEXT_OUTPUT_STRESS_SCRIPT = "tsx --test tests/context-output-stress.test.ts";
const READ_V3_SCRIPT = "tsx --test tests/native-tool-policy.test.ts tests/native-tool-wiring.test.ts tests/read-v3.test.ts";
const CONTEXT_OUTPUT_BENCHMARK_SCRIPT = "tsx scripts/context-output-benchmark.ts";
const SESSION_SANITIZE_SCRIPT = "tsx scripts/workbench-session-sanitize.ts";

test("package.json: exact script inventory includes v2 and final v0.10 context-output scripts", async () => {
	const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version?: string; scripts?: Record<string, string> };

	// Exactly the three v2 scripts, with the exact frozen intent.
	assert.equal(pkg.scripts?.["commander:nro:v2:prepare"], V2_PREPARE_SCRIPT);
	assert.equal(pkg.scripts?.["commander:nro:v2:benchmark"], V2_BENCHMARK_SCRIPT);
	assert.equal(pkg.scripts?.["commander:nro:v2:final"], V2_FINAL_SCRIPT);
	assert.equal(pkg.scripts?.["test:context-output-baseline"], CONTEXT_OUTPUT_BASELINE_SCRIPT);
	assert.equal(pkg.scripts?.["test:read-v3"], READ_V3_SCRIPT);
	assert.equal(pkg.scripts?.["benchmark:context-output"], CONTEXT_OUTPUT_BENCHMARK_SCRIPT);
	assert.equal(pkg.scripts?.["session:sanitize"], SESSION_SANITIZE_SCRIPT);

	// The complete scripts map is exactly the pre-existing scripts plus the
	// three v2 scripts and the additive test:release-assets,
	// test:runtime-core, test:gate-preflight, test:worker-efficiency and
	// test:diff-review-efficiency scripts, plus the two approved R0
	// context-output baseline, core, and benchmark scripts — nothing changed,
	// nothing removed.
	assert.deepEqual(pkg.scripts, {
		typecheck: "tsc --noEmit",
		test: "tsx --test tests/*.test.ts",
		"test:release-assets": "tsx --test tests/release-assets.test.ts",
		"test:runtime-core": "tsx --test tests/recipe-schema.test.ts tests/recipe-runner.test.ts tests/p6-c-action-cache.test.ts tests/inspect.test.ts tests/p4-render.test.ts tests/execution-efficiency.test.ts tests/commander-native-tool-benchmark-v2-wiring.test.ts",
		"test:gate-preflight": "tsx --test tests/gates.test.ts tests/p4-render.test.ts tests/result-summary-wiring.test.ts",
		"test:worker-efficiency": "tsx --test tests/worker-policy.test.ts tests/worker-runner.test.ts tests/delegation-ledger.test.ts tests/p6-b-stable-prefix.test.ts",
		"test:diff-review-efficiency": "tsx --test tests/diff-review.test.ts tests/diff-review-wiring.test.ts",
		"test:context-output-baseline": CONTEXT_OUTPUT_BASELINE_SCRIPT,
		"test:context-output-core": CONTEXT_OUTPUT_CORE_SCRIPT,
		"test:context-output-integration": CONTEXT_OUTPUT_INTEGRATION_SCRIPT,
		"test:context-output-stress": CONTEXT_OUTPUT_STRESS_SCRIPT,
		"test:read-v3": READ_V3_SCRIPT,
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
		"benchmark:context-output": CONTEXT_OUTPUT_BENCHMARK_SCRIPT,
		"session:sanitize": SESSION_SANITIZE_SCRIPT,
	});
	// No version metadata drift.
	assert.equal(pkg.version, "0.10.0");
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

test("recipes.yaml: schema-valid, exact recipe inventory includes additive context-output recipes without removing prior entries", async () => {
	const doc = await loadRecipes();
	assert.deepEqual(doc.errors, []);
	assert.deepEqual(doc.warnings, []);
	// The declared recipe set is exactly the pre-existing set plus the three
	// v2 recipes, release-assets-test, runtime-core-test, typecheck-feedback,
	// gate-preflight-test, worker-efficiency-test and
	// diff-review-efficiency-test, plus the approved context-output
	// recipes — the parser returns recipes sorted by name, so compare
	// order-independently.
	assert.deepEqual(
		[...doc.recipes.map((r) => r.name)].sort(),
		[
			"typecheck",
			"unit-test",
			"check",
			"release-assets-test",
			"runtime-core-test",
			"typecheck-feedback",
			"gate-preflight-test",
			"worker-efficiency-test",
			"diff-review-efficiency-test",
				"context-output-baseline-test",
				"context-output-core-test",
				"context-output-integration-test",
				"context-output-stress",
				"read-v3-test",
			"context-output-benchmark",
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

	const contextOutputBaseline = doc.recipes.find((r) => r.name === "context-output-baseline-test");
	assert.ok(contextOutputBaseline, "context-output-baseline-test recipe declared");
	assert.deepEqual(contextOutputBaseline.command, ["npm", "run", "test:context-output-baseline"]);
	assert.deepEqual(contextOutputBaseline.allowed_modes, ["DEV", "VERIFY"]);
	assert.equal(contextOutputBaseline.mutation, "none");
	assert.deepEqual(contextOutputBaseline.writes, []);
	assert.equal(contextOutputBaseline.cache.enabled, true);
	assert.equal(contextOutputBaseline.cache.version, 2);
	assert.deepEqual(contextOutputBaseline.cache.inputs, [
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		".pi/workbench/recipes.yaml",
		"extensions/**/*.ts",
		"tests/helpers.ts",
		"tests/context-output-baseline.test.ts",
		"scripts/context-output-benchmark.ts",
	]);

	const contextOutputCore = doc.recipes.find((r) => r.name === "context-output-core-test");
	assert.ok(contextOutputCore, "context-output-core-test recipe declared");
	assert.deepEqual(contextOutputCore.command, ["npm", "run", "test:context-output-core"]);
	assert.deepEqual(contextOutputCore.allowed_modes, ["DEV", "VERIFY"]);
	assert.equal(contextOutputCore.mutation, "none");
	assert.deepEqual(contextOutputCore.writes, []);
	assert.equal(contextOutputCore.cache.enabled, true);
	assert.equal(contextOutputCore.cache.version, 4);
	assert.deepEqual(contextOutputCore.cache.inputs, [
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		".pi/workbench/recipes.yaml",
		"extensions/workbench-runtime/core/output-policy.ts",
		"extensions/workbench-runtime/core/output-envelope.ts",
		"extensions/workbench-runtime/core/turn-output-budget.ts",
		"extensions/workbench-runtime/core/continuation-cursor.ts",
		"extensions/workbench-runtime/core/bounded-file-io.ts",
		"extensions/workbench-runtime/core/details-projection.ts",
		"extensions/workbench-runtime/core/context-history-budget.ts",
		"extensions/workbench-runtime/core/output-control-telemetry.ts",
		"tests/output-envelope.test.ts",
		"tests/turn-output-budget.test.ts",
		"tests/continuation-cursor.test.ts",
		"tests/bounded-file-io.test.ts",
		"tests/details-projection.test.ts",
		"tests/context-history-budget.test.ts",
		"tests/output-control-telemetry.test.ts",
	]);

	const contextOutputIntegration = doc.recipes.find((r) => r.name === "context-output-integration-test");
	assert.ok(contextOutputIntegration, "context-output-integration-test recipe declared");
	assert.deepEqual(contextOutputIntegration.command, ["npm", "run", "test:context-output-integration"]);
	assert.deepEqual(contextOutputIntegration.allowed_modes, ["DEV", "VERIFY"]);
	assert.equal(contextOutputIntegration.mutation, "none");
	assert.deepEqual(contextOutputIntegration.writes, []);
	assert.equal(contextOutputIntegration.cache.enabled, true);
	assert.equal(contextOutputIntegration.cache.version, 5);
	assert.deepEqual(contextOutputIntegration.cache.inputs, [
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		".pi/workbench/recipes.yaml",
		"extensions/**/*.ts",
		"extensions/workbench-runtime/core/compare.ts",
		"extensions/workbench-runtime/core/comparison-record.ts",
		"extensions/workbench-runtime/core/details-projection.ts",
		"extensions/workbench-runtime/core/context-history-budget.ts",
		"extensions/workbench-runtime/core/diff-review.ts",
		"extensions/workbench-runtime/core/render.ts",
		"extensions/workbench-runtime/ui/tool-renderers.ts",
		"tests/helpers.ts",
		"tests/output-control-wiring.test.ts",
		"tests/read-v3.test.ts",
		"tests/read-run-log-page.test.ts",
		"tests/compare-output-bounds.test.ts",
		"tests/gate-output-bounds.test.ts",
		"tests/context-output-worker.test.ts",
	]);

	const readV3 = doc.recipes.find((r) => r.name === "read-v3-test");
	assert.ok(readV3, "read-v3-test recipe declared");
	assert.deepEqual(readV3.command, ["npm", "run", "test:read-v3"]);
	assert.deepEqual(readV3.allowed_modes, ["DEV", "VERIFY"]);
	assert.equal(readV3.mutation, "none");
	assert.deepEqual(readV3.writes, []);
	assert.equal(readV3.cache.enabled, true);
	assert.deepEqual(readV3.cache.inputs, [
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		".pi/workbench/recipes.yaml",
		"extensions/**/*.ts",
		"tests/helpers.ts",
		"tests/native-tool-policy.test.ts",
		"tests/native-tool-wiring.test.ts",
		"tests/read-v3.test.ts",
	]);

	const contextOutputBenchmark = doc.recipes.find((r) => r.name === "context-output-benchmark");
	assert.ok(contextOutputBenchmark, "context-output-benchmark recipe declared");
	assert.deepEqual(contextOutputBenchmark.command, ["npm", "run", "benchmark:context-output"]);
	assert.deepEqual(contextOutputBenchmark.allowed_modes, ["DEV", "VERIFY"]);
	assert.equal(contextOutputBenchmark.mutation, "artifacts");
	assert.deepEqual(contextOutputBenchmark.writes, [".pi/workbench/runs/context-output-benchmark/context-output-benchmark.json"]);
	assert.deepEqual(contextOutputBenchmark.artifacts, [".pi/workbench/runs/context-output-benchmark/context-output-benchmark.json"]);
	assert.equal(contextOutputBenchmark.cache.enabled, false);

	const contextOutputStress = doc.recipes.find((r) => r.name === "context-output-stress");
	assert.ok(contextOutputStress, "context-output-stress recipe declared");
	assert.deepEqual(contextOutputStress.command, ["npm", "run", "test:context-output-stress"]);
	assert.deepEqual(contextOutputStress.allowed_modes, ["DEV", "VERIFY"]);
	assert.equal(contextOutputStress.mutation, "artifacts");
	assert.deepEqual(contextOutputStress.writes, [".pi/workbench/runs/context-output-stress/context-output-evidence.json"]);
	assert.deepEqual(contextOutputStress.artifacts, [".pi/workbench/runs/context-output-stress/context-output-evidence.json"]);
	assert.equal(contextOutputStress.cache.enabled, false);

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
