import assert from "node:assert/strict";
import { test } from "node:test";

import { validateWorkerVerificationRecipes } from "../extensions/workbench-runtime/core/worker-verification.ts";
import { withTempDir, writeConfigFile } from "./helpers.ts";

const RECIPES = [
	"recipes:",
	"  - name: test:unit",
	"    command: [node, --test]",
	"    mutation: none",
	"  - name: artifacts",
	"    command: [node, build.mjs]",
	"    writes: [artifacts/]",
	"    mutation: artifacts",
	"  - name: required-param",
	"    command: [node, script.mjs, '{{target}}']",
	"    mutation: none",
	"    params:",
	"      - { name: target, required: true }",
	"",
].join("\n");

test("verification preflight stable-deduplicates declared write-free recipes without executing them", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "recipes.yaml", RECIPES);
		assert.deepEqual(await validateWorkerVerificationRecipes(dir, ["test:unit", "test:unit"]), {
			ok: true,
			recipes: ["test:unit"],
		});
		assert.deepEqual(await validateWorkerVerificationRecipes(dir, ["missing"]), {
			ok: false,
			code: "recipe_missing",
			recipe: "missing",
		});
		assert.deepEqual(await validateWorkerVerificationRecipes(dir, ["artifacts"]), {
			ok: false,
			code: "recipe_mutates",
			recipe: "artifacts",
		});
		assert.deepEqual(await validateWorkerVerificationRecipes(dir, ["required-param"]), {
			ok: false,
			code: "recipe_requires_params",
			recipe: "required-param",
		});
	});
});

test("verification preflight fails closed only on recipe-catalog issues", async () => {
	await withTempDir(async (dir) => {
		assert.deepEqual(await validateWorkerVerificationRecipes(dir, []), { ok: true, recipes: [] },
			"an empty verification request never depends on recipe-catalog health");
		await writeConfigFile(dir, "recipes.yaml", RECIPES);
		await writeConfigFile(dir, "gates.yaml", "gates: definitely-invalid\n");
		await writeConfigFile(dir, "profiles.yaml", "profiles: definitely-invalid\n");
		assert.equal((await validateWorkerVerificationRecipes(dir, ["test:unit"])).ok, true);

		await writeConfigFile(dir, "recipes.yaml", "recipes: [\n");
		assert.deepEqual(await validateWorkerVerificationRecipes(dir, []), { ok: true, recipes: [] });
		const invalid = await validateWorkerVerificationRecipes(dir, ["test:unit"]);
		assert.equal(invalid.ok, false);
		if (!invalid.ok) assert.equal(invalid.code, "config_invalid");
	});
});

test("verification preflight rejects malformed roots and names before config lookup", async () => {
	assert.deepEqual(await validateWorkerVerificationRecipes("relative", []), { ok: false, code: "invalid_project_root" });
	assert.deepEqual(await validateWorkerVerificationRecipes("/tmp", [" padded "]), { ok: false, code: "invalid_recipe_name" });
});
