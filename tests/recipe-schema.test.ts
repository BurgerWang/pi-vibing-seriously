/**
 * Tests for the recipe schema (P1): validation rules, argv enforcement,
 * parameter substitution, and defaults.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRecipe, parseRecipesDocument, buildArgv, RecipeParamError } from "../extensions/workbench-runtime/core/recipe-schema.ts";

const FULL_RECIPE = {
	name: "backtest",
	description: "Run the backtest",
	command: ["python", "scripts/backtest.py", "--symbol", "{{symbol}}"],
	cwd: "research",
	timeout_ms: 60000,
	allowed_modes: ["DEV", "VERIFY"],
	expected_exit_codes: [0, 1],
	writes: ["data/", "results/"],
	artifacts: ["results/**/*.csv"],
	environment: ["DATA_DIR"],
	output_strategy: "head",
	max_lines: 100,
	max_bytes: 4096,
	params: [{ name: "symbol", type: "string", required: true, description: "Ticker symbol" }],
};

test("a fully specified recipe parses with all fields", () => {
	const result = parseRecipe(FULL_RECIPE, 0);
	assert.deepEqual(result.errors, []);
	const recipe = result.recipes[0];
	assert.ok(recipe);
	assert.equal(recipe.name, "backtest");
	assert.deepEqual(recipe.command, ["python", "scripts/backtest.py", "--symbol", "{{symbol}}"]);
	assert.equal(recipe.cwd, "research");
	assert.equal(recipe.timeout_ms, 60000);
	assert.deepEqual(recipe.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(recipe.expected_exit_codes, [0, 1]);
	assert.deepEqual(recipe.writes, ["data/", "results/"]);
	assert.deepEqual(recipe.artifacts, ["results/**/*.csv"]);
	assert.deepEqual(recipe.environment, ["DATA_DIR"]);
	assert.equal(recipe.output_strategy, "head");
	assert.equal(recipe.max_lines, 100);
	assert.equal(recipe.max_bytes, 4096);
	assert.equal(recipe.params.length, 1);
	assert.equal(recipe.params[0]?.required, true);
});

test("minimal recipes get safe defaults", () => {
	const result = parseRecipe({ name: "min", command: ["npm", "test"] }, 0);
	assert.deepEqual(result.errors, []);
	const recipe = result.recipes[0];
	assert.ok(recipe);
	assert.equal(recipe.cwd, ".");
	assert.equal(recipe.timeout_ms, 120000);
	assert.deepEqual(recipe.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(recipe.expected_exit_codes, [0]);
	assert.equal(recipe.output_strategy, "tail");
	assert.equal(recipe.max_lines, 2000);
	assert.equal(recipe.max_bytes, 51200);
	assert.deepEqual(recipe.writes, []);
	assert.deepEqual(recipe.environment, []);
});

test("command must be an argv array, never a shell string", () => {
	const asString = parseRecipe({ name: "r", command: "npm test && npm run typecheck" }, 0);
	assert.equal(asString.recipes.length, 0);
	assert.ok(asString.errors.some((e) => e.includes("argv array") && e.includes("shell string")), asString.errors.join("; "));

	const empty = parseRecipe({ name: "r", command: [] }, 0);
	assert.equal(empty.recipes.length, 0);
	assert.ok(empty.errors.some((e) => e.includes("non-empty argv array")));

	const missing = parseRecipe({ name: "r" }, 0);
	assert.equal(missing.recipes.length, 0);
	assert.ok(missing.errors.some((e) => e.includes('"command" is required')));
});

test("unknown recipe fields are rejected", () => {
	const result = parseRecipe({ name: "r", command: ["ls"], shell: true }, 0);
	assert.equal(result.recipes.length, 0);
	assert.ok(result.errors.some((e) => e.includes('unknown field "shell"')));
});

test("invalid allowed_modes are rejected", () => {
	const result = parseRecipe({ name: "r", command: ["ls"], allowed_modes: ["DEV", "HFT"] }, 0);
	assert.equal(result.recipes.length, 0);
	assert.ok(result.errors.some((e) => e.includes("invalid allowed_modes entry")));
});

test("invalid output_strategy is rejected", () => {
	const result = parseRecipe({ name: "r", command: ["ls"], output_strategy: "middle" }, 0);
	assert.equal(result.recipes.length, 0);
	assert.ok(result.errors.some((e) => e.includes('"head" or "tail"')));
});

test("invalid environment variable names are rejected", () => {
	const result = parseRecipe({ name: "r", command: ["ls"], environment: ["DATA DIR", "1BAD"] }, 0);
	assert.equal(result.recipes.length, 0);
	assert.ok(result.errors.some((e) => e.includes("invalid environment variable name")));
});

test("non-integer timeout and limits are rejected", () => {
	for (const [field, value] of [
		["timeout_ms", "fast"],
		["max_lines", 0],
		["max_bytes", -1],
	] as const) {
		const result = parseRecipe({ name: "r", command: ["ls"], [field]: value }, 0);
		assert.equal(result.recipes.length, 0, `${field} should be rejected`);
		assert.ok(result.errors.some((e) => e.includes(`"${field}" must be a positive integer`)), result.errors.join("; "));
	}
});

test("invalid param declarations are rejected", () => {
	const result = parseRecipe({ name: "r", command: ["ls"], params: [{ name: "x", type: "date" }] }, 0);
	assert.equal(result.recipes.length, 0);
	assert.ok(result.errors.some((e) => e.includes("invalid type")));
});

test("duplicate recipe names are rejected at document level", () => {
	const result = parseRecipesDocument({
		recipes: [
			{ name: "dup", command: ["a"] },
			{ name: "dup", command: ["b"] },
		],
	});
	assert.equal(result.recipes.length, 1);
	assert.ok(result.errors.some((e) => e.includes('duplicate recipe name "dup"')));
});

test("recipes.yaml accepts a top-level list or a recipes key", () => {
	const asList = parseRecipesDocument([{ name: "a", command: ["x"] }]);
	assert.equal(asList.recipes.length, 1);
	assert.deepEqual(asList.errors, []);

	const asMap = parseRecipesDocument({ recipes: [{ name: "a", command: ["x"] }] });
	assert.equal(asMap.recipes.length, 1);

	const broken = parseRecipesDocument({ recipes: "nope" });
	assert.equal(broken.recipes.length, 0);
	assert.ok(broken.errors.some((e) => e.includes("recipes.yaml root")));
});

// ---------------------------------------------------------------------------
// buildArgv — parameter substitution
// ---------------------------------------------------------------------------

test("buildArgv substitutes declared params into argv placeholders", () => {
	const recipe = parseRecipe(FULL_RECIPE, 0).recipes[0]!;
	const argv = buildArgv(recipe, { symbol: "AAPL" });
	assert.deepEqual(argv, ["python", "scripts/backtest.py", "--symbol", "AAPL"]);
});

test("buildArgv rejects unknown params (model cannot inject anything)", () => {
	const recipe = parseRecipe(FULL_RECIPE, 0).recipes[0]!;
	assert.throws(() => buildArgv(recipe, { symbol: "AAPL", extra: "x" }), RecipeParamError);
	assert.throws(() => buildArgv(recipe, { symbol: "AAPL", "--shell": "rm -rf /" }), RecipeParamError);
});

test("buildArgv enforces required params and types", () => {
	const recipe = parseRecipe(FULL_RECIPE, 0).recipes[0]!;
	assert.throws(() => buildArgv(recipe, {}), RecipeParamError);
	assert.throws(() => buildArgv(recipe, { symbol: 42 }), RecipeParamError);

	const numeric = parseRecipe({ name: "n", command: ["node", "x.js", "{{count}}"], params: [{ name: "count", type: "number" }] }, 0).recipes[0]!;
	assert.deepEqual(buildArgv(numeric, { count: 3 }), ["node", "x.js", "3"]);
	assert.throws(() => buildArgv(numeric, { count: "3" }), RecipeParamError);
});

test("buildArgv rejects placeholders that reference undeclared params", () => {
	const recipe = parseRecipe({ name: "r", command: ["echo", "{{nope}}"] }, 0).recipes[0]!;
	assert.throws(() => buildArgv(recipe, {}), /not a declared parameter/);
});

test("optional params without placeholders are harmless", () => {
	const recipe = parseRecipe(
		{ name: "r", command: ["ls"], params: [{ name: "extra", type: "boolean" }] },
		0,
	).recipes[0]!;
	assert.deepEqual(buildArgv(recipe, {}), ["ls"]);
	assert.deepEqual(buildArgv(recipe, { extra: true }), ["ls"]);
});
