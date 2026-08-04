/**
 * Integration tests for the Recipe Runner (P1).
 * Real spawn-based execution (shell=false) against temp projects.
 * Covers: recipe-not-found, allowed_modes, timeout, non-zero exit codes,
 * run artifacts on disk, secret redaction, output truncation, path escapes,
 * env isolation, cancellation, git state, and artifacts collection.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { RecipeSetupError, runRecipe } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import { makeRunId, isValidRunId } from "../extensions/workbench-runtime/core/runs.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

const BASE_RECIPES = [
	"recipes:",
	"  - name: hello",
	'    command: ["node", "-e", "console.log(process.argv[1] || \\"hi\\")", "{{msg}}"]',
	"    params:",
	"      - { name: msg, type: string }",
	"  - name: fail",
	'    command: ["node", "-e", "process.exit(3)"]',
	"    expected_exit_codes: [0]",
	"  - name: fail-ok",
	'    command: ["node", "-e", "process.exit(3)"]',
	"    expected_exit_codes: [3]",
	"  - name: dev-only",
	'    command: ["node", "-e", "console.log(\\"dev\\")"]',
	"    allowed_modes: [DEV]",
	"  - name: sleepy",
	'    command: ["node", "-e", "setTimeout(() => {}, 60000)"]',
	"    timeout_ms: 300",
	"  - name: noisy",
	'    command: ["node", "-e", "for (let i = 1; i <= 5000; i++) console.log(\\"line\\" + i)"]',
	"    max_lines: 100",
	"    output_strategy: tail",
	"  - name: noisy-head",
	'    command: ["node", "-e", "for (let i = 1; i <= 5000; i++) console.log(\\"line\\" + i)"]',
	"    max_lines: 100",
	"    output_strategy: head",
	"  - name: echo-secret",
	'    command: ["node", "-e", "console.log(process.env.SECRET_TOKEN || \\"none\\")"]',
	"    environment: [SECRET_TOKEN]",
	"  - name: echo-env",
	'    command: ["node", "-e", "console.log(process.env.ONLY_ME || process.env.NOT_DECLARED || \\"none\\")"]',
	"    environment: [ONLY_ME]",
	"  - name: write-out",
	'    command: ["node", "-e", "require(\\"fs\\").mkdirSync(\\"out\\", { recursive: true }); require(\\"fs\\").writeFileSync(\\"out/result.json\\", \\"{}\\")"]',
	"    writes: [\"out/\"]",
	'    artifacts: ["out/*.json"]',
	"",
].join("\n");

async function setupProject(dir: string): Promise<void> {
	await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\n");
	await writeConfigFile(dir, "recipes.yaml", BASE_RECIPES);
}

test("recipe not found returns a structured error", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const result = await runRecipe({ projectRoot: dir, recipeName: "does-not-exist", mode: "DEV", exec: spawnExec });
		assert.equal(result.ok, false);
		assert.ok(result.error?.includes("does-not-exist"));
	});
});

test("allowed_modes gates recipe execution", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const denied = await runRecipe({ projectRoot: dir, recipeName: "dev-only", mode: "VERIFY", exec: spawnExec });
		assert.equal(denied.ok, false);
		assert.ok(denied.error?.includes("not allowed in VERIFY"));

		const allowed = await runRecipe({ projectRoot: dir, recipeName: "dev-only", mode: "DEV", exec: spawnExec });
		assert.equal(allowed.ok, true);
	});
});

// ---------------------------------------------------------------------------
// P7 slice 3: direct recipe execution applies the shared mutation policy
// ---------------------------------------------------------------------------

test("direct recipe calls enforce the mutation policy: strict Sol denies source, workers run only none", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"recipes.yaml",
			[
				"recipes:",
				'  - { name: fmt, command: ["node", "-e", "process.exit(0)"], mutation: source, writes: ["src/"] }',
				'  - { name: build, command: ["node", "-e", "process.exit(0)"], mutation: artifacts, artifacts: ["dist/**"] }',
				'  - { name: verify, command: ["node", "-e", "process.exit(0)"], mutation: none }',
				"",
			].join("\n"),
		);
		const sol = { role: undefined, provider: "openai-codex", model: "gpt-5.6-sol" };
		const worker = { role: "worker", provider: "deepseek", model: "deepseek-v4-flash" };

		// Strict Sol: mutation:source is denied; none/artifacts run.
		const solSource = await runRecipe({ projectRoot: dir, recipeName: "fmt", mode: "DEV", exec: spawnExec, actorFacts: sol });
		assert.equal(solSource.ok, false);
		assert.ok(solSource.error?.includes("mutation: source"), solSource.error ?? "");
		assert.equal((await runRecipe({ projectRoot: dir, recipeName: "build", mode: "DEV", exec: spawnExec, actorFacts: sol })).ok, true);
		assert.equal((await runRecipe({ projectRoot: dir, recipeName: "verify", mode: "DEV", exec: spawnExec, actorFacts: sol })).ok, true);

		// Delegated worker: only mutation:none runs (artifacts included).
		const workerSource = await runRecipe({ projectRoot: dir, recipeName: "fmt", mode: "DEV", exec: spawnExec, actorFacts: worker });
		assert.equal(workerSource.ok, false);
		assert.ok(workerSource.error?.includes("mutation: source"));
		const workerBuild = await runRecipe({ projectRoot: dir, recipeName: "build", mode: "DEV", exec: spawnExec, actorFacts: worker });
		assert.equal(workerBuild.ok, false);
		assert.ok(workerBuild.error?.includes("mutation: artifacts"));
		assert.equal((await runRecipe({ projectRoot: dir, recipeName: "verify", mode: "DEV", exec: spawnExec, actorFacts: worker })).ok, true);

		// Other controllers and fact-less callers keep prior behavior.
		const other = { role: undefined, provider: "anthropic", model: "claude-sonnet" };
		assert.equal((await runRecipe({ projectRoot: dir, recipeName: "fmt", mode: "DEV", exec: spawnExec, actorFacts: other })).ok, true);
		assert.equal((await runRecipe({ projectRoot: dir, recipeName: "fmt", mode: "DEV", exec: spawnExec })).ok, true);

		// Legacy inference: a writes-bearing recipe without an explicit
		// mutation is source and is denied for strict Sol.
		await writeConfigFile(
			dir,
			"recipes.yaml",
			"recipes:\n  - { name: legacy-fmt, command: [\"node\", \"-e\", \"process.exit(0)\"], writes: [\"src/\"] }\n",
		);
		const legacy = await runRecipe({ projectRoot: dir, recipeName: "legacy-fmt", mode: "DEV", exec: spawnExec, actorFacts: sol });
		assert.equal(legacy.ok, false);
		assert.ok(legacy.error?.includes("mutation: source"), "legacy non-empty writes infer source");
	});
});

test("timeout kills the process and marks the run timed out", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const result = await runRecipe({ projectRoot: dir, recipeName: "sleepy", mode: "DEV", exec: spawnExec });
		assert.equal(result.ok, false);
		assert.equal(result.record?.timed_out, true);
		assert.equal(result.record?.cancelled, false);
		assert.equal(result.record?.exit_code, null);
		assert.equal(result.summary?.timed_out, true);
	});
});

test("non-zero exit code is a failure unless expected", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const failed = await runRecipe({ projectRoot: dir, recipeName: "fail", mode: "DEV", exec: spawnExec });
		assert.equal(failed.ok, false);
		assert.equal(failed.record?.exit_code, 3);

		const expected = await runRecipe({ projectRoot: dir, recipeName: "fail-ok", mode: "DEV", exec: spawnExec });
		assert.equal(expected.ok, true);
		assert.equal(expected.record?.exit_code, 3);
	});
});

test("all six run artifacts are written to the run directory", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const result = await runRecipe({ projectRoot: dir, recipeName: "hello", mode: "DEV", exec: spawnExec, params: { msg: "world" } });
		assert.equal(result.ok, true);
		const files = (await readdir(result.runDir as string)).sort();
		assert.deepEqual(files, ["command.json", "environment.json", "manifest.json", "stderr.log", "stdout.log", "summary.json"]);

		const manifest = JSON.parse(await readFile(join(result.runDir as string, "manifest.json"), "utf8"));
		assert.equal(manifest.schema_version, 1);
		assert.equal(manifest.recipe, "hello");
		assert.equal(manifest.profile, "generic");
		assert.equal(manifest.exit_code, 0);
		assert.equal(manifest.timed_out, false);
		assert.equal(manifest.cancelled, false);
		assert.ok(manifest.started_at);
		assert.ok(manifest.finished_at);
		assert.ok(typeof manifest.duration_ms === "number");
		assert.ok(Array.isArray(manifest.argv));
		assert.equal(manifest.argv.join(" ").includes("world"), true);
		assert.ok(manifest.cwd);
		assert.ok(manifest.stdout_truncated === false);
		assert.ok(manifest.stderr_truncated === false);
	});
});

test("secret env values are redacted from every artifact", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const secret = "supersecret-token-value-12345";
		const previous = process.env.SECRET_TOKEN;
		process.env.SECRET_TOKEN = secret;
		try {
			const result = await runRecipe({ projectRoot: dir, recipeName: "echo-secret", mode: "DEV", exec: spawnExec });
			assert.equal(result.ok, true);
			const runDir = result.runDir as string;
			const stdoutLog = await readFile(join(runDir, "stdout.log"), "utf8");
			const manifest = await readFile(join(runDir, "manifest.json"), "utf8");
			const command = await readFile(join(runDir, "command.json"), "utf8");
			const environment = await readFile(join(runDir, "environment.json"), "utf8");
			const summary = await readFile(join(runDir, "summary.json"), "utf8");

			assert.ok(!stdoutLog.includes(secret), "stdout.log must not contain the secret");
			assert.ok(stdoutLog.includes("[REDACTED]"), "stdout.log should show redaction");
			assert.ok(!manifest.includes(secret), "manifest must not contain the secret");
			assert.ok(!command.includes(secret), "command.json must not contain the secret");
			assert.ok(!summary.includes(secret), "summary.json must not contain the secret");
			assert.ok(environment.includes("[REDACTED]"), "environment.json redacts secret values");
			assert.ok(!environment.includes(secret), "environment.json must not contain the secret");
		} finally {
			if (previous === undefined) delete process.env.SECRET_TOKEN;
			else process.env.SECRET_TOKEN = previous;
		}
	});
});

test("output truncation keeps bounded views while full logs are persisted", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const tail = await runRecipe({ projectRoot: dir, recipeName: "noisy", mode: "DEV", exec: spawnExec });
		assert.equal(tail.ok, true);
		assert.equal(tail.record?.stdout_truncated, true);
		const tailLines = tail.summary!.stdout.split("\n").filter((l) => l.length > 0);
		assert.ok(tailLines.length <= 100);
		assert.equal(tailLines[0], "line4901", "tail strategy keeps the LAST lines");
		assert.equal(tailLines[tailLines.length - 1], "line5000");
		const fullLog = await readFile(join(tail.runDir as string, "stdout.log"), "utf8");
		assert.equal(fullLog.split("\n").length, 5001, "full log keeps everything");

		const head = await runRecipe({ projectRoot: dir, recipeName: "noisy-head", mode: "DEV", exec: spawnExec });
		assert.equal(head.record?.stdout_truncated, true);
		const headLines = head.summary!.stdout.split("\n").filter((l) => l.length > 0);
		assert.equal(headLines[0], "line1", "head strategy keeps the FIRST lines");
	});
});

test("cwd escapes the project root", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"recipes.yaml",
			"recipes:\n  - name: escape\n    command: [\"pwd\"]\n    cwd: \"../\"\n",
		);
		await assert.rejects(
			runRecipe({ projectRoot: dir, recipeName: "escape", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof RecipeSetupError && error.message.includes("escapes the project root"),
		);
	});
});

test("absolute cwd escapes the project root", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"recipes.yaml",
			"recipes:\n  - name: escape\n    command: [\"pwd\"]\n    cwd: \"/tmp\"\n",
		);
		await assert.rejects(
			runRecipe({ projectRoot: dir, recipeName: "escape", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof RecipeSetupError && error.message.includes("escapes the project root"),
		);
	});
});

test("../ writes paths escape the project root", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"recipes.yaml",
			"recipes:\n  - name: escape\n    command: [\"true\"]\n    writes: [\"../evil.txt\"]\n",
		);
		await assert.rejects(
			runRecipe({ projectRoot: dir, recipeName: "escape", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof RecipeSetupError && error.message.includes("writes path escapes"),
		);
	});
});

test("absolute artifacts patterns escape the project root", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"recipes.yaml",
			"recipes:\n  - name: escape\n    command: [\"true\"]\n    artifacts: [\"/tmp/*.csv\"]\n",
		);
		await assert.rejects(
			runRecipe({ projectRoot: dir, recipeName: "escape", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof RecipeSetupError && error.message.includes("artifacts pattern escapes"),
		);
	});
});

test("declared writes and artifact globs are recorded after the run", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const result = await runRecipe({ projectRoot: dir, recipeName: "write-out", mode: "DEV", exec: spawnExec });
		assert.equal(result.ok, true);
		assert.deepEqual(result.record?.declared_writes, ["out/"]);
		assert.deepEqual(result.record?.artifact_paths, ["out/result.json"]);
		assert.deepEqual(result.summary?.artifact_paths, ["out/result.json"]);
	});
});

test("only declared environment variables reach the process", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const saved = { onlyMe: process.env.ONLY_ME, notDeclared: process.env.NOT_DECLARED };
		process.env.ONLY_ME = "visible-value";
		process.env.NOT_DECLARED = "hidden-value";
		try {
			const result = await runRecipe({ projectRoot: dir, recipeName: "echo-env", mode: "DEV", exec: spawnExec });
			assert.equal(result.ok, true);
			assert.ok(result.summary?.stdout.includes("visible-value"), "declared env var is passed");
			assert.ok(!result.summary?.stdout.includes("hidden-value"), "undeclared env var is NOT passed");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});

test("aborted signal marks the run cancelled", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const controller = new AbortController();
		controller.abort();
		const result = await runRecipe({
			projectRoot: dir,
			recipeName: "hello",
			mode: "DEV",
			exec: async (cmd, args, opts) => {
				// Simulate the process being killed by the abort signal.
				assert.ok(opts?.signal, "AbortSignal must be forwarded to exec");
				return { stdout: "", stderr: "", code: 0, killed: true };
			},
			signal: controller.signal,
		});
		assert.equal(result.record?.cancelled, true);
		assert.equal(result.record?.timed_out, false);
		assert.equal(result.record?.exit_code, null);
		assert.equal(result.ok, false);
	});
});

test("timeout and cwd are forwarded to exec", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		let seen: { timeout?: number; cwd?: string } = {};
		const result = await runRecipe({
			projectRoot: dir,
			recipeName: "hello",
			mode: "DEV",
			params: { msg: "x" },
			exec: async (cmd, args, opts) => {
				seen = { timeout: opts?.timeout, cwd: opts?.cwd };
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			},
		});
		assert.equal(result.ok, true);
		assert.equal(seen.timeout, 120000, "default timeout forwarded");
		assert.equal(seen.cwd, dir, "cwd resolved to project root");
	});
});

test("git commit and dirty state are recorded in the manifest", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const notGit = await runRecipe({ projectRoot: dir, recipeName: "hello", mode: "DEV", exec: spawnExec });
		assert.equal(notGit.record?.git_commit, null);
		assert.equal(notGit.record?.git_dirty, false);

		await spawnExec("git", ["init", "-q"], { cwd: dir });
		await spawnExec("git", ["config", "user.email", "t@t"], { cwd: dir });
		await spawnExec("git", ["config", "user.name", "t"], { cwd: dir });
		await spawnExec("git", ["add", "-A"], { cwd: dir });
		await spawnExec("git", ["commit", "-qm", "init"], { cwd: dir });
		const clean = await runRecipe({ projectRoot: dir, recipeName: "hello", mode: "DEV", exec: spawnExec });
		assert.ok(clean.record?.git_commit, "commit hash recorded");
		assert.equal(clean.record?.git_dirty, false);

		// Make the worktree dirty.
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(dir, "dirty.txt"), "x", "utf8");
		const dirty = await runRecipe({ projectRoot: dir, recipeName: "hello", mode: "DEV", exec: spawnExec });
		assert.equal(dirty.record?.git_dirty, true);
	});
});

test("run ids are unique, time-based and strictly validated", () => {
	const a = makeRunId(new Date(2026, 0, 1, 12, 0, 0));
	const b = makeRunId(new Date(2026, 0, 1, 12, 0, 0));
	assert.match(a, /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/);
	assert.ok(isValidRunId(a));
	assert.ok(a !== b, "random suffix prevents collisions");
	assert.ok(!isValidRunId("../../etc/passwd"));
	assert.ok(!isValidRunId("20260101-120000-ab"));
});
