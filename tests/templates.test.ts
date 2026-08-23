/**
 * Tests for the q-init templates (P1 + P2).
 * Covers: profile set, generic has no quantitative content, quant profiles
 * are scoped to selection/timing, no hft/market-making/lob/execution-engine
 * anywhere, every template's recipes pass the strict schema, and the AGENTS
 * template selection (P2: generic → AGENTS.generic.md, quant →
 * AGENTS.quant-research.md).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { getInitTemplate, INIT_PROFILES, isSupportedInitProfile } from "../extensions/workbench-runtime/core/templates.ts";
import { parseRecipesDocument } from "../extensions/workbench-runtime/core/recipe-schema.ts";

const FORBIDDEN = ["hft", "market-making", "market making", "lob", "order book", "matching engine", "execution-engine", "colocation"];

test("exactly three init profiles are supported", () => {
	assert.deepEqual(INIT_PROFILES, ["generic", "quant-research/stock-selection", "quant-research/market-timing"]);
	for (const profile of INIT_PROFILES) assert.ok(isSupportedInitProfile(profile));
});

test("every profile ships the four config files", async () => {
	for (const profile of INIT_PROFILES) {
		const template = await getInitTemplate(profile);
		assert.deepEqual(Object.keys(template.files).sort(), ["gates.yaml", "profiles.yaml", "project.yaml", "recipes.yaml"]);
	}
});

test("AGENTS.md template is selected by profile", async () => {
	const generic = await getInitTemplate("generic");
	const selection = await getInitTemplate("quant-research/stock-selection");
	const timing = await getInitTemplate("quant-research/market-timing");
	assert.ok(generic.agentsFile.includes("generic profile"), "generic profile selects the generic AGENTS template");
	assert.equal(selection.agentsFile, timing.agentsFile, "both quant profiles share the quant-research AGENTS template");
	assert.ok(selection.agentsFile.includes("quant-research profile"), "quant profile selects the quant AGENTS template");
	assert.notEqual(generic.agentsFile, selection.agentsFile);
});

test("generic template contains no quantitative content", async () => {
	const template = await getInitTemplate("generic");
	const text = Object.values(template.files).join("\n").toLowerCase() + "\n" + template.agentsFile.toLowerCase();
	for (const term of ["backtest", "stock selection", "market timing", "walk-forward", "quant"]) {
		assert.ok(!text.includes(term), `generic must not mention "${term}"`);
	}
});

test("no template mentions out-of-scope domains", async () => {
	for (const profile of INIT_PROFILES) {
		const template = await getInitTemplate(profile);
		const text = Object.values(template.files).join("\n").toLowerCase() + "\n" + template.agentsFile.toLowerCase();
		for (const term of FORBIDDEN) {
			assert.ok(!text.includes(term), `${profile} must not mention "${term}"`);
		}
	}
});

test("stock-selection template is scoped to selection workflows", async () => {
	const text = Object.values((await getInitTemplate("quant-research/stock-selection")).files).join("\n").toLowerCase();
	assert.ok(text.includes("stock selection"));
	assert.ok(text.includes("backtest:selection"));
	assert.ok(!text.includes("market timing"));
});

test("market-timing template is scoped to timing workflows", async () => {
	const text = Object.values((await getInitTemplate("quant-research/market-timing")).files).join("\n").toLowerCase();
	assert.ok(text.includes("market timing"));
	assert.ok(text.includes("backtest:timing"));
	assert.ok(text.includes("walkforward:validate"));
	assert.ok(!text.includes("stock selection"));
});

test("every template recipe passes the strict schema", async () => {
	for (const profile of INIT_PROFILES) {
		const recipesYaml = (await getInitTemplate(profile)).files["recipes.yaml"];
		assert.ok(recipesYaml, "recipes.yaml present");
		const parsed = parseRecipesDocument(parseYaml(recipesYaml));
		assert.deepEqual(parsed.errors, [], `${profile}: template recipes must be schema-valid`);
		if (profile === "generic") {
			assert.deepEqual(parsed.recipes, [], "the static generic fallback is explicitly unconfigured; q-init generates detected recipes");
		} else {
			assert.ok(parsed.recipes.length >= 1, `${profile}: at least one recipe`);
		}
		for (const recipe of parsed.recipes) {
			assert.ok(Array.isArray(recipe.command), "command is an argv array");
			assert.ok(recipe.command.length > 0);
			assert.ok(!recipe.command.some((c) => c.includes("&&") || c.includes(";") || c.includes("|")), "no shell metacharacters in argv");
			assert.ok(recipe.allowed_modes.includes("VERIFY"), "recipes are runnable in VERIFY");
		}
	}
});

test("template recipes declare mutation none/artifacts consistently with their writes", async () => {
	// Generic's static package asset is a safe NOT_CONFIGURED fallback. The
	// q-init adapter replaces it with a stack-detected immutable plan snapshot.
	const genericYaml = (await getInitTemplate("generic")).files["recipes.yaml"];
	assert.ok(genericYaml, "recipes.yaml present");
	const generic = parseRecipesDocument(parseYaml(genericYaml));
	assert.deepEqual(generic.recipes, []);
	assert.match(genericYaml, /NOT_CONFIGURED/);
	// Quant templates: every data/feature/backtest/walk-forward recipe writes
	// ONLY data/result/artifact files, so each one declares mutation artifacts
	// (never source — the scripts never mutate project source code).
	for (const profile of ["quant-research/stock-selection", "quant-research/market-timing"] as const) {
		const recipesYaml = (await getInitTemplate(profile)).files["recipes.yaml"];
		assert.ok(recipesYaml, "recipes.yaml present");
		const parsed = parseRecipesDocument(parseYaml(recipesYaml));
		assert.ok(parsed.recipes.length >= 4, `${profile}: data/feature/backtest/walkforward recipes present`);
		for (const recipe of parsed.recipes) {
			assert.equal(recipe.mutation, "artifacts", `${profile} recipe ${recipe.name} declares mutation: artifacts`);
			assert.ok(recipe.writes.length > 0, `${profile} recipe ${recipe.name} keeps its declared writes`);
			for (const write of recipe.writes) {
				assert.match(
					write,
					/^(data|results|artifacts)\//,
					`${profile} recipe ${recipe.name} writes only under data/results/artifacts (got ${write})`,
				);
			}
		}
	}
	// Explicit declarations, never inference: every template recipe carries
	// the field verbatim.
	for (const profile of INIT_PROFILES) {
		const text = (await getInitTemplate(profile)).files["recipes.yaml"];
		assert.ok(text, "recipes.yaml present");
		const mutations = text.split("\n").filter((l) => l.trim().startsWith("mutation:"));
		const parsed = parseRecipesDocument(parseYaml(text));
		assert.equal(mutations.length, parsed.recipes.length, `${profile}: every recipe declares mutation explicitly`);
	}
});
