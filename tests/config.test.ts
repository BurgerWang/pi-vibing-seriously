/**
 * Tests for workbench project configuration loading (P1).
 * Covers: config parsing, invalid YAML, untrusted rejection, project root
 * detection, and the official CONFIG_DIR_NAME.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	findProjectRoot,
	ConfigFileReadError,
	loadProjectConfig,
	resolveEffectiveProjectRoot,
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

test("only ENOENT is optional; present non-regular or invalid UTF-8 config fails closed", async () => {
	await withTempDir(async (dir) => {
		const configDir = workbenchDir(dir);
		await mkdir(join(configDir, "project.yaml"), { recursive: true });
		await assert.rejects(
			loadProjectConfig(dir, { trusted: true }),
			(error) => error instanceof ConfigFileReadError && error.message.includes("not a regular file"),
		);
	});
	await withTempDir(async (dir) => {
		await mkdir(workbenchDir(dir), { recursive: true });
		await writeFile(join(workbenchDir(dir), "project.yaml"), Buffer.from([0xff, 0xfe, 0xfd]));
		await assert.rejects(
			loadProjectConfig(dir, { trusted: true }),
			(error) => error instanceof ConfigFileReadError && error.message.includes("invalid_utf8"),
		);
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

// ---------------------------------------------------------------------------
// P8: optional project_dir → safe effective project root
// ---------------------------------------------------------------------------

const NESTED_PROJECT = (projectDir: string): string => `name: demo-project\nprofile: generic\nproject_dir: ${projectDir}\n`;

async function projectIssue(config: Awaited<ReturnType<typeof loadProjectConfig>>): Promise<string | undefined> {
	return config.issues.find((i) => i.file === "project.yaml" && i.message.includes("project_dir"))?.message;
}

test("project_dir defaults to the repository root (legacy configs keep working)", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", VALID_PROJECT); // no project_dir key
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.equal(config.projectDir, undefined);
		assert.equal(config.effectiveProjectRoot, dir);
		assert.deepEqual(config.issues, []);

		// Explicit "project_dir: ." is the same default, without issues.
		await writeConfigFile(dir, "project.yaml", VALID_PROJECT + "project_dir: .\n");
		const explicit = await loadProjectConfig(dir, { trusted: true });
		assert.equal(explicit.projectDir, ".");
		assert.equal(explicit.effectiveProjectRoot, dir);
		assert.deepEqual(explicit.issues, []);
	});
});

test("a nested existing directory becomes the effective project root", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", NESTED_PROJECT("research"));
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.equal(config.projectDir, "research");
		assert.equal(config.effectiveProjectRoot, await realpath(join(dir, "research")));
		assert.deepEqual(config.issues, []);

		// resolveEffectiveProjectRoot is the single resolution primitive.
		const direct = await resolveEffectiveProjectRoot(dir, "research");
		assert.equal(direct.root, await realpath(join(dir, "research")));
		assert.equal(direct.issue, undefined);
	});
});

test("a symlink inside the repository to another inside directory is accepted", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "real-dir"), { recursive: true });
		await symlink("real-dir", join(dir, "link-dir")); // relative symlink, stays inside
		await writeConfigFile(dir, "project.yaml", NESTED_PROJECT("link-dir"));
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.equal(config.effectiveProjectRoot, await realpath(join(dir, "real-dir")));
		assert.deepEqual(config.issues, []);
	});
});

test("absolute project_dir values are rejected with a project.yaml issue", async () => {
	const absolutes = ["/etc", "/tmp/x", "C:\\x", "C:/x", "\\server\\share", "D:relative"];
	for (const bad of absolutes) {
		await withTempDir(async (dir) => {
			await writeConfigFile(dir, "project.yaml", NESTED_PROJECT(JSON.stringify(bad)));
			const config = await loadProjectConfig(dir, { trusted: true });
			assert.equal(config.effectiveProjectRoot, dir, `must fall back to the repo root for ${bad}`);
			const issue = await projectIssue(config);
			assert.ok(issue && issue.includes("relative path"), `expected a relative-path issue for ${bad}: ${JSON.stringify(config.issues)}`);
		});
	}
});

test("project_dir resolving outside via .. is rejected", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", NESTED_PROJECT("../outside"));
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.equal(config.effectiveProjectRoot, dir);
		const issue = await projectIssue(config);
		assert.ok(issue && issue.includes("outside the project root"), JSON.stringify(config.issues));
	});
});

test("project_dir symlink escapes are rejected without reading the outside target", async () => {
	await withTempDir(async (dir) => {
		await symlink("/etc", join(dir, "escape-link"));
		await writeConfigFile(dir, "project.yaml", NESTED_PROJECT("escape-link"));
		const config = await loadProjectConfig(dir, { trusted: true });
		assert.equal(config.effectiveProjectRoot, dir);
		const issue = await projectIssue(config);
		assert.ok(issue && issue.includes("symlink"), JSON.stringify(config.issues));
	});
});

test("missing and non-directory project_dir values are rejected", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", NESTED_PROJECT("does-not-exist"));
		const missing = await loadProjectConfig(dir, { trusted: true });
		assert.equal(missing.effectiveProjectRoot, dir);
		const missingIssue = await projectIssue(missing);
		assert.ok(missingIssue && missingIssue.includes("does not exist"), JSON.stringify(missing.issues));

		await writeFile(join(dir, "notes.txt"), "x", "utf8");
		await writeConfigFile(dir, "project.yaml", NESTED_PROJECT("notes.txt"));
		const notDir = await loadProjectConfig(dir, { trusted: true });
		assert.equal(notDir.effectiveProjectRoot, dir);
		const notDirIssue = await projectIssue(notDir);
		assert.ok(notDirIssue && notDirIssue.includes("not a directory"), JSON.stringify(notDir.issues));
	});
});

test("non-string and empty project_dir values are rejected", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", "name: x\nprofile: generic\nproject_dir: [a, b]\n");
		const nonString = await loadProjectConfig(dir, { trusted: true });
		assert.equal(nonString.effectiveProjectRoot, dir);
		assert.equal(nonString.projectDir, undefined);
		const nonStringIssue = await projectIssue(nonString);
		assert.ok(nonStringIssue && nonStringIssue.includes("must be a string"), JSON.stringify(nonString.issues));

		await writeConfigFile(dir, "project.yaml", 'name: x\nprofile: generic\nproject_dir: ""\n');
		const empty = await loadProjectConfig(dir, { trusted: true });
		assert.equal(empty.effectiveProjectRoot, dir);
		const emptyIssue = await projectIssue(empty);
		assert.ok(emptyIssue && emptyIssue.includes("non-empty"), JSON.stringify(empty.issues));
	});
});

test("a bad project_dir never disables the rest of the config (inspectable fallback)", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", NESTED_PROJECT("../outside"));
		await writeConfigFile(dir, "recipes.yaml", VALID_RECIPES);
		const config = await loadProjectConfig(dir, { trusted: true });
		// The fallback keeps the repository root; recipes/profile still load.
		assert.equal(config.effectiveProjectRoot, dir);
		assert.equal(config.profile, "generic");
		assert.equal(config.recipes.length, 1);
		assert.equal(config.recipes[0]?.name, "typecheck");
		assert.ok(config.issues.some((i) => i.file === "project.yaml" && i.message.includes("project_dir")));
	});
});
