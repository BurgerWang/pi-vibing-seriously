/**
 * Tests for workbench project configuration loading (P1).
 * Covers: config parsing, invalid YAML, untrusted rejection, project root
 * detection, and the official CONFIG_DIR_NAME.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	findProjectRoot,
	loadProjectConfig,
	UntrustedProjectError,
	workbenchDir,
	runsDir,
} from "../extensions/workbench-runtime/core/config.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

const VALID_PROJECT = [
	"name: demo-project",
	"description: Demo project",
	"profile: generic",
	"",
].join("\n");

const VALID_RECIPES = [
	"recipes:",
	"  - name: typecheck",
	'    command: ["npm", "run", "typecheck"]',
	"    description: Run typecheck",
	"",
].join("\n");

test("loads a complete valid configuration", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", VALID_PROJECT);
		await writeConfigFile(dir, "recipes.yaml", VALID_RECIPES);
		await writeConfigFile(dir, "gates.yaml", "gates:\n  - name: no-merge\n");
		await writeConfigFile(dir, "profiles.yaml", "profiles:\n  - name: generic\n");

		const config = await loadProjectConfig(dir, { trusted: true });
		assert.equal(config.projectName, "demo-project");
		assert.equal(config.profile, "generic");
		assert.equal(config.recipes.length, 1);
		assert.equal(config.recipes[0]?.name, "typecheck");
		assert.equal(config.gates.length, 1);
		assert.equal(config.profiles.length, 1);
		assert.deepEqual(config.issues, []);
	});
});

test("invalid YAML is reported as a config issue, not thrown", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", VALID_PROJECT);
		await writeConfigFile(dir, "recipes.yaml", "recipes:\n  - name: broken\n   command: [oops\n");

		const config = await loadProjectConfig(dir, { trusted: true });
		assert.equal(config.recipes.length, 0);
		assert.ok(config.issues.some((i) => i.file === "recipes.yaml" && i.message.includes("invalid YAML")), JSON.stringify(config.issues));
	});
});

test("untrusted projects are rejected before any config is read", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", VALID_PROJECT);
		await assert.rejects(
			loadProjectConfig(dir, { trusted: false }),
			(error) => error instanceof UntrustedProjectError && error.message.includes("not trusted"),
		);
	});
});

test("missing config files produce an empty configuration without errors", async () => {
	await withTempDir(async (dir) => {
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.equal(config.profile, undefined);
		assert.equal(config.recipes.length, 0);
		assert.deepEqual(config.issues, []);
	});
});

test("project.yaml without a profile is reported", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", "name: x\n");
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.ok(config.issues.some((i) => i.file === "project.yaml" && i.message.includes("profile")));
	});
});

test("unknown recipe fields are config errors (strict schema)", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"recipes.yaml",
			"recipes:\n  - name: r1\n    command: [\"npm\", \"test\"]\n    commmand: [\"npm\", \"run\", \"typecheck\"]\n",
		);
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.equal(config.recipes.length, 0);
		assert.ok(config.issues.some((i) => i.file === "recipes.yaml" && i.message.includes('unknown field "commmand"')));
	});
});

test("workbench directory uses the official CONFIG_DIR_NAME", () => {
	assert.equal(CONFIG_DIR_NAME, ".pi");
	assert.equal(workbenchDir("/repo"), join("/repo", CONFIG_DIR_NAME, "workbench"));
	assert.equal(runsDir("/repo"), join("/repo", CONFIG_DIR_NAME, "workbench", "runs"));
});

test("findProjectRoot prefers git toplevel and falls back to cwd", async () => {
	await withTempDir(async (dir) => {
		// Non-git dir → cwd.
		const root = await findProjectRoot(dir, spawnExec);
		assert.equal(root, dir);

		// Git repo → toplevel.
		await spawnExec("git", ["init", "-q"], { cwd: dir });
		const sub = join(dir, "a", "b");
		await mkdir(sub, { recursive: true });
		await writeFile(join(dir, "tracked.txt"), "x", "utf8");
		const root2 = await findProjectRoot(sub, spawnExec);
		assert.equal(root2, dir);
	});
});
