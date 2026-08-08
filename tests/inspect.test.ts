/**
 * Inspect service tests (P8 safe nested project support + Phase 2B
 * per-recipe validation-component observability).
 *
 * Covers: stack detection reads ONLY the effective project root's top level
 * (project.yaml `project_dir`, repo root by default), while git and
 * config-files-present stay repository-root based, and the inspect result
 * exposes the effective project root explicitly. Phase 2B: recipe entries
 * carry the exact declared validation_components arrays (explicit empty and
 * omitted/default included); recipes are exposed in deterministic
 * name-sorted order (never YAML declaration order), while component order
 * within each array stays exactly as declared.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inspectProject } from "../extensions/workbench-runtime/core/inspect.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

test("stack detection reads only the effective project root's top level", async () => {
	await withTempDir(async (dir) => {
		const root = await realpath(dir);
		await mkdir(join(root, "research"), { recursive: true });
		await writeConfigFile(root, "project.yaml", "name: x\nprofile: generic\nproject_dir: research\n");

		// Only the REPO root has package.json — the nested root has none, so
		// no stack may be detected (stack detection must not fall back to the
		// repository root).
		await writeFile(join(root, "package.json"), "{}", "utf8");
		const repoOnly = await inspectProject(root, { trusted: true, exec: spawnExec });
		assert.deepEqual(repoOnly.stacks, [], "repo-root files must not count for a nested project");
		assert.equal(repoOnly.effective_project_root, await realpath(join(root, "research")));

		// Now the NESTED root has package.json — the stack is detected from it.
		await writeFile(join(root, "research", "package.json"), "{}", "utf8");
		const nested = await inspectProject(root, { trusted: true, exec: spawnExec });
		assert.equal(nested.stacks.length, 1);
		assert.equal(nested.stacks[0]!.language, "JavaScript/TypeScript");
		assert.deepEqual(nested.stacks[0]!.evidence, ["package.json"]);
	});
});

test("without project_dir the repository root is the effective root", async () => {
	await withTempDir(async (dir) => {
		const root = await realpath(dir);
		await writeConfigFile(root, "project.yaml", "name: x\nprofile: generic\n");
		await writeFile(join(root, "pyproject.toml"), "", "utf8");
		const result = await inspectProject(root, { trusted: true, exec: spawnExec });
		assert.equal(result.effective_project_root, root);
		assert.equal(result.stacks.length, 1);
		assert.equal(result.stacks[0]!.language, "Python");
	});
});

test("git and config-files-present stay at the repository root for nested projects", async () => {
	await withTempDir(async (dir) => {
		const root = await realpath(dir);
		await mkdir(join(root, "research"), { recursive: true });
		await writeConfigFile(root, "project.yaml", "name: x\nprofile: generic\nproject_dir: research\n");
		await spawnExec("git", ["init", "-q"], { cwd: root });
		await writeFile(join(root, "tracked.txt"), "x", "utf8");

		const result = await inspectProject(root, { trusted: true, exec: spawnExec });
		// Git facts come from the repository root (rev-parse toplevel matches).
		assert.equal(result.git.is_git, true);
		assert.equal(result.git.commit, null, "no commits yet — null, not an error");
		assert.ok(result.config_files_present.includes("project.yaml"), "config files are listed from the repo root");
		assert.deepEqual(result.config_files_present, ["project.yaml"], "only project.yaml exists at the repo root");
		// The effective root is still the nested directory.
		assert.equal(result.effective_project_root, await realpath(join(root, "research")));
	});
});

test("a bad project_dir falls back to the repo root and surfaces as a config error", async () => {
	await withTempDir(async (dir) => {
		const root = await realpath(dir);
		await writeConfigFile(root, "project.yaml", "name: x\nprofile: generic\nproject_dir: /etc\n");
		const result = await inspectProject(root, { trusted: true, exec: spawnExec });
		assert.equal(result.effective_project_root, root, "fallback keeps the repo root");
		assert.ok(
			result.config_errors.some((e) => e.file === "project.yaml" && e.message.includes("project_dir")),
			JSON.stringify(result.config_errors),
		);
	});
});

test("recipe entries preserve exact validation arrays in name-sorted order (Phase 2B)", async () => {
	await withTempDir(async (dir) => {
		const root = await realpath(dir);
		// Deliberately NON-alphabetical declaration order: zeta (declared
		// aggregate, two components), alpha (explicit empty), beta (omitted ->
		// default). Config loading deterministically sorts recipes by name, so
		// the exposed order must be alpha, beta, zeta — never YAML order.
		await writeConfigFile(
			root,
			"recipes.yaml",
			[
				"recipes:",
				"  - name: zeta",
				"    description: declared aggregate (two components)",
				"    command: [echo, z]",
				"    validation_components: [typecheck, unit-test]",
				"  - name: alpha",
				"    description: explicit empty",
				"    command: [echo, a]",
				"    validation_components: []",
				"  - name: beta",
				"    description: omitted -> default",
				"    command: [echo, b]",
				"",
			].join("\n"),
		);
		const result = await inspectProject(root, { trusted: true, exec: spawnExec });
		assert.deepEqual(result.config_errors, [], JSON.stringify(result.config_errors));
		assert.deepEqual(
			result.recipes.map((r) => r.name),
			["alpha", "beta", "zeta"],
			"recipes are deterministically sorted by name (never YAML declaration order)",
		);
		assert.deepEqual(result.recipes[0]!.validation_components, [], "explicit empty stays exactly []");
		assert.deepEqual(result.recipes[1]!.validation_components, [], "omitted field defaults to [] — never undefined");
		assert.deepEqual(result.recipes[2]!.validation_components, ["typecheck", "unit-test"], "aggregate declaration preserved exactly");
	});
});
