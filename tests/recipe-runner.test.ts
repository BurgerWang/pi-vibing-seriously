/**
 * Integration tests for the Recipe Runner (P1).
 * Real spawn-based execution (shell=false) against temp projects.
 * Covers: recipe-not-found, allowed_modes, timeout, non-zero exit codes,
 * run artifacts on disk, secret redaction, output truncation, path escapes,
 * env isolation, cancellation, git state, and artifacts collection.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { RecipeSetupError, captureAndPatchRunManifest, runRecipe } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import { makeRunId, isValidRunId, type RunRecord } from "../extensions/workbench-runtime/core/runs.ts";
import { DEFAULT_RECIPE, type Recipe } from "../extensions/workbench-runtime/core/recipe-schema.ts";
import { executedArgvHash } from "../extensions/workbench-runtime/core/validation-evidence.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { validateCommandEffectRecord } from "../extensions/workbench-runtime/core/command-effect.ts";
import {
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_CONTRACT_HASH_ENV,
	WORKER_DELEGATION_ID_ENV,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_ROLE,
	WORKER_TASK_KIND_ENV,
} from "../extensions/workbench-runtime/core/worker-policy.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

const WORKER_ACTOR = { role: WORKER_ROLE, provider: "openai-codex", model: "gpt-5.6-luna" } as const;
const WORKER_ID = "20260827-130000-r3C4";
const WORKER_CONTRACT = "d".repeat(64);

async function withWorkerRecipeEnvironment<T>(
	projectRoot: string,
	allowedPaths: readonly string[],
	taskKind: "implementation" | "diagnosis",
	operation: () => Promise<T>,
): Promise<T> {
	const names = [
		WORKER_DELEGATION_ID_ENV,
		WORKER_CONTRACT_HASH_ENV,
		WORKER_PROJECT_ROOT_ENV,
		WORKER_ALLOWED_PATHS_ENV,
		WORKER_TASK_KIND_ENV,
	] as const;
	const prior = new Map(names.map((name) => [name, process.env[name]] as const));
	process.env[WORKER_DELEGATION_ID_ENV] = WORKER_ID;
	process.env[WORKER_CONTRACT_HASH_ENV] = WORKER_CONTRACT;
	process.env[WORKER_PROJECT_ROOT_ENV] = projectRoot;
	process.env[WORKER_ALLOWED_PATHS_ENV] = JSON.stringify(allowedPaths);
	process.env[WORKER_TASK_KIND_ENV] = taskKind;
	try {
		return await operation();
	} finally {
		for (const name of names) {
			const value = prior.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

const BASE_RECIPES = [
	"recipes:",
	"  - name: hello",
	'    command: ["node", "-e", "console.log(process.argv[1] || \\"hi\\")", "{{msg}}"]',
	"    params:",
	"      - { name: msg, type: string }",
	"    validation_components: [typecheck, unit-test]",
	"  - name: fail",
	'    command: ["node", "-e", "process.exit(3)"]',
	"    expected_exit_codes: [0]",
	"    validation_components: [typecheck, unit-test]",
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

test("direct recipe calls enforce strict Sol policy and exact in-scope worker mutation authority", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"recipes.yaml",
			[
				"recipes:",
				'  - { name: fmt, command: ["node", "-e", "process.exit(0)"], mutation: source, writes: ["src/result.ts"] }',
				'  - { name: build, command: ["node", "-e", "process.exit(0)"], mutation: artifacts, writes: ["dist/result.json"], artifacts: ["dist/**"] }',
				'  - { name: verify, command: ["node", "-e", "process.exit(0)"], mutation: none }',
				"",
			].join("\n"),
		);
		await gitBacked(dir);
		await mkdir(join(dir, "src"), { recursive: true });
		await mkdir(join(dir, "dist"), { recursive: true });
		const sol = { role: undefined, provider: "openai-codex", model: "gpt-5.6-sol" };

		// Strict Sol: mutation:source is denied; none/artifacts run.
		const solSource = await runRecipe({ projectRoot: dir, recipeName: "fmt", mode: "DEV", exec: spawnExec, actorFacts: sol });
		assert.equal(solSource.ok, false);
		assert.ok(solSource.error?.includes("mutation: source"), solSource.error ?? "");
		assert.equal((await runRecipe({ projectRoot: dir, recipeName: "build", mode: "DEV", exec: spawnExec, actorFacts: sol })).ok, true);
		assert.equal((await runRecipe({ projectRoot: dir, recipeName: "verify", mode: "DEV", exec: spawnExec, actorFacts: sol })).ok, true);

		// Delegated implementation worker: exact in-scope source/artifact
		// outputs and mutation:none run under command-effect capture.
		await withWorkerRecipeEnvironment(dir, ["src/**", "dist/result.json"], "implementation", async () => {
			const workerSource = await runRecipe({ projectRoot: dir, recipeName: "fmt", mode: "DEV", exec: spawnExec, actorFacts: WORKER_ACTOR });
			assert.equal(workerSource.ok, true, workerSource.error);
			assert.equal(workerSource.record?.cache_request_mode, "no-cache");
			const workerBuild = await runRecipe({ projectRoot: dir, recipeName: "build", mode: "DEV", exec: spawnExec, actorFacts: WORKER_ACTOR });
			assert.equal(workerBuild.ok, true, workerBuild.error);
			assert.equal(workerBuild.record?.cache_request_mode, "no-cache");
			assert.equal((await runRecipe({ projectRoot: dir, recipeName: "verify", mode: "DEV", exec: spawnExec, actorFacts: WORKER_ACTOR })).ok, true);
		});

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

test("worker recipe identity is required before any command or evidence process can run", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "recipes.yaml", [
			"recipes:",
			'  - { name: verify, command: ["node", "-e", "process.exit(0)"], mutation: none }',
			"",
		].join("\n"));
		const priorId = process.env[WORKER_DELEGATION_ID_ENV];
		const priorHash = process.env[WORKER_CONTRACT_HASH_ENV];
		delete process.env[WORKER_DELEGATION_ID_ENV];
		delete process.env[WORKER_CONTRACT_HASH_ENV];
		let execCalls = 0;
		try {
			const result = await runRecipe({
				projectRoot: dir,
				recipeName: "verify",
				mode: "DEV",
				exec: async () => {
					execCalls += 1;
					return { stdout: "", stderr: "", code: 0, killed: false };
				},
				actorFacts: WORKER_ACTOR,
			});
			assert.equal(result.ok, false);
			assert.equal(result.error, "WORKER_COMMAND_EFFECT_IDENTITY_INVALID");
			assert.equal(execCalls, 0);
		} finally {
			if (priorId === undefined) delete process.env[WORKER_DELEGATION_ID_ENV];
			else process.env[WORKER_DELEGATION_ID_ENV] = priorId;
			if (priorHash === undefined) delete process.env[WORKER_CONTRACT_HASH_ENV];
			else process.env[WORKER_CONTRACT_HASH_ENV] = priorHash;
		}
	});
});

test("diagnosis, glob writes and outputs outside allowed_paths are denied before recipe exec", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "recipes.yaml", [
			"recipes:",
			'  - { name: exact, command: ["node", "-e", "process.exit(0)"], mutation: source, writes: ["src/result.ts"] }',
			'  - { name: broad, command: ["node", "-e", "process.exit(0)"], mutation: source, writes: ["src/**"] }',
			'  - { name: outside, command: ["node", "-e", "process.exit(0)"], mutation: source, writes: ["other/result.ts"] }',
			"",
		].join("\n"));
		let processCalls = 0;
		const exec: ExecFn = async (command, args, options) => {
			if (command === "node") processCalls += 1;
			return spawnExec(command, args, options);
		};
		const diagnosis = await withWorkerRecipeEnvironment(dir, ["src/**"], "diagnosis", () => runRecipe({
			projectRoot: dir, recipeName: "exact", mode: "DEV", exec, actorFacts: WORKER_ACTOR,
		}));
		assert.match(diagnosis.error ?? "", /Diagnosis worker/u);
		const broad = await withWorkerRecipeEnvironment(dir, ["src/**"], "implementation", () => runRecipe({
			projectRoot: dir, recipeName: "broad", mode: "DEV", exec, actorFacts: WORKER_ACTOR,
		}));
		assert.match(broad.error ?? "", /not one exact/u);
		const outside = await withWorkerRecipeEnvironment(dir, ["src/**"], "implementation", () => runRecipe({
			projectRoot: dir, recipeName: "outside", mode: "DEV", exec, actorFacts: WORKER_ACTOR,
		}));
		assert.match(outside.error ?? "", /outside delegation allowed_paths/u);
		assert.equal(processCalls, 0);
	});
});

test("worker mutating recipe rejects a symlink hop outside the allowed subtree before recipe exec", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await mkdir(join(dir, "other"), { recursive: true });
		await symlink(join(dir, "other"), join(dir, "src", "other-link"));
		await writeConfigFile(dir, "recipes.yaml", [
			"recipes:",
			'  - { name: escaped, command: ["node", "-e", "process.exit(0)"], mutation: source, writes: ["src/other-link/result.ts"] }',
			"",
		].join("\n"));
		let processCalls = 0;
		const exec: ExecFn = async (command, args, options) => {
			if (command === "node") processCalls += 1;
			return spawnExec(command, args, options);
		};
		const result = await withWorkerRecipeEnvironment(dir, ["src/**"], "implementation", () => runRecipe({
			projectRoot: dir,
			recipeName: "escaped",
			mode: "DEV",
			exec,
			actorFacts: WORKER_ACTOR,
		}));
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /resolves outside delegation allowed_paths/u);
		assert.equal(processCalls, 0);
	});
});

test("unavailable before evidence persists EVIDENCE_UNAVAILABLE and never starts the recipe process", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "recipes.yaml", [
			"recipes:",
			'  - { name: exact, command: ["node", "-e", "require(\\"fs\\").writeFileSync(\\"src/result.ts\\", \\"after\\")"], mutation: source, writes: ["src/result.ts"] }',
			"",
		].join("\n"));
		await mkdir(join(dir, "src"), { recursive: true });
		await gitBacked(dir);
		let processCalls = 0;
		const exec: ExecFn = async (command, args, options) => {
			if (command === "node") processCalls += 1;
			if (command === "git" && args.includes("--porcelain=v1")) {
				return { stdout: "", stderr: "injected guard failure", code: 1, killed: false };
			}
			return spawnExec(command, args, options);
		};
		const result = await withWorkerRecipeEnvironment(dir, ["src/result.ts"], "implementation", () => runRecipe({
			projectRoot: dir,
			recipeName: "exact",
			mode: "DEV",
			exec,
			actorFacts: WORKER_ACTOR,
		}));
		assert.equal(processCalls, 0, "pre-capture failure must precede the recipe executable");
		assert.equal(result.ok, false);
		assert.equal(result.error, "COMMAND_EFFECT_EVIDENCE_UNAVAILABLE");
		assert.equal(result.record?.run_outcome, "PROCESS_FAILED");
		assert.equal(result.record?.exit_code, null);
		assert.equal(result.commandEffect?.capture_error, "BEFORE_GUARD_UNAVAILABLE");
		assert.equal(result.commandEffect?.status, "EVIDENCE_UNAVAILABLE");
		assert.equal(result.commandEffect?.worker_delegation_id, WORKER_ID);
		assert.equal(result.commandEffect?.worker_contract_hash, WORKER_CONTRACT);
		await assert.rejects(readFile(join(dir, "src/result.ts"), "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
		const persistedEffect = JSON.parse(await readFile(join(result.runDir!, "command-effect.json"), "utf8"));
		assert.equal(validateCommandEffectRecord(persistedEffect), true);
		assert.equal(persistedEffect.status, "EVIDENCE_UNAVAILABLE");
		const persistedManifest = JSON.parse(await readFile(join(result.runDir!, "manifest.json"), "utf8"));
		assert.equal(persistedManifest.run_outcome, "PROCESS_FAILED");
		assert.equal(persistedManifest.command_effect_status, "EVIDENCE_UNAVAILABLE");
	});
});

test("worker mutation:none subprocess writes fail closed with a durable declaration-violation receipt", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "tracked.txt"), "before\n", "utf8");
		await writeConfigFile(
			dir,
			"recipes.yaml",
			[
				"recipes:",
				'  - name: dishonest-verify',
				'    command: ["node", "-e", "require(\\"fs\\").writeFileSync(\\"tracked.txt\\", \\"after\\\\n\\")"]',
				"    mutation: none",
				"    writes: []",
				"",
			].join("\n"),
		);
		await gitBacked(dir);
		const result = await withWorkerRecipeEnvironment(dir, ["tracked.txt"], "implementation", () => runRecipe({
			projectRoot: dir,
			recipeName: "dishonest-verify",
			mode: "DEV",
			exec: spawnExec,
			actorFacts: WORKER_ACTOR,
		}));
		assert.equal(result.ok, false);
		assert.equal(result.error, "RECIPE_DECLARATION_VIOLATION");
		assert.equal(result.record?.run_outcome, "COMMAND_EFFECT_FAILED");
		assert.equal(result.record?.command_effect_status, "RECIPE_DECLARATION_VIOLATION");
		assert.equal(result.commandEffect?.observed_changes[0]?.path, "tracked.txt");
		assert.equal(result.commandEffect?.observed_changes[0]?.classification, "RECIPE_DECLARATION_VIOLATION");
		assert.equal(result.commandEffect?.semantic_acceptance, "NOT_GRANTED");
		assert.equal(result.commandEffect?.worker_delegation_id, WORKER_ID);
		assert.equal(result.commandEffect?.worker_contract_hash, WORKER_CONTRACT);
		const persisted = JSON.parse(await readFile(join(result.runDir!, "command-effect.json"), "utf8"));
		assert.equal(validateCommandEffectRecord(persisted), true);
		assert.equal(persisted.command_effect_hash, result.record?.command_effect_hash);
		const commit = JSON.parse(await readFile(join(result.runDir!, "run-commit.json"), "utf8"));
		assert.ok(commit.files.some((entry: { path: string }) => entry.path === "command-effect.json"));
	});
});

test("worker exact ignored output is command-attributed inside allowed_paths but never semantically accepted", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(
			dir,
			"recipes.yaml",
			[
				"recipes:",
				'  - name: exact-output',
				'    command: ["node", "-e", "require(\\"fs\\").writeFileSync(\\"generated.json\\", \\"{}\\")"]',
				"    mutation: artifacts",
				"    writes: [generated.json]",
				"",
			].join("\n"),
		);
		await gitBacked(dir);
		await writeFile(join(dir, ".gitignore"), ".pi/\ngenerated.json\n", "utf8");
		const result = await withWorkerRecipeEnvironment(dir, ["generated.json"], "implementation", () => runRecipe({
			projectRoot: dir,
			recipeName: "exact-output",
			mode: "DEV",
			exec: spawnExec,
			actorFacts: WORKER_ACTOR,
		}));
		assert.equal(result.ok, true, result.error);
		assert.equal(result.record?.command_effect_status, "COMMAND_ATTRIBUTED");
		assert.equal(result.commandEffect?.observed_changes[0]?.classification, "COMMAND_ATTRIBUTED");
		assert.equal(result.commandEffect?.observed_changes[0]?.before, null, "ignored output is absent from Git guard evidence");
		assert.equal(result.commandEffect?.observed_changes[0]?.after, null, "ignored output is absent from Git guard evidence");
		assert.equal(result.commandEffect?.observed_changes[0]?.before_exact_output?.kind, "missing");
		assert.equal(result.commandEffect?.observed_changes[0]?.after_exact_output?.kind, "file");
		assert.equal(result.commandEffect?.before_exact_output_evidence.meter.bytes_read, 0);
		assert.equal(result.commandEffect?.after_exact_output_evidence.meter.bytes_read, 2);
		assert.equal(result.commandEffect?.semantic_acceptance, "NOT_GRANTED");
		assert.equal(result.commandEffect?.worker_delegation_id, WORKER_ID);
		assert.equal(result.commandEffect?.worker_contract_hash, WORKER_CONTRACT);
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
		// Phase 2A: the nonzero (failed) exec terminal still records the exact
		// declared components and the default cache request mode, and the
		// persisted manifest agrees with the returned record on both fields.
		assert.deepEqual(failed.record?.validation_components, ["typecheck", "unit-test"], "exact declared components on a nonzero run");
		assert.equal(failed.record?.cache_request_mode, "default", "default request mode on a nonzero run");
		const failedManifest = await persistedManifest(failed.runDir as string);
		assert.deepEqual(failedManifest.validation_components, failed.record?.validation_components, "returned == persisted validation_components");
		assert.equal(failedManifest.cache_request_mode, failed.record?.cache_request_mode, "returned == persisted cache_request_mode");

		const expected = await runRecipe({ projectRoot: dir, recipeName: "fail-ok", mode: "DEV", exec: spawnExec });
		assert.equal(expected.ok, true);
		assert.equal(expected.record?.exit_code, 3);
	});
});

test("cache request mode is recorded exactly for default, no-cache and refresh-cache runs", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const components = ["typecheck", "unit-test"];
		const modes = ["default", "no-cache", "refresh-cache"] as const;
		for (const mode of modes) {
			const result = await runRecipe({ projectRoot: dir, recipeName: "hello", mode: "DEV", exec: spawnExec, cacheMode: mode });
			assert.equal(result.ok, true);
			assert.deepEqual(result.record?.validation_components, components, `${mode}: exact declared components returned`);
			assert.equal(result.record?.cache_request_mode, mode, `${mode}: exact request mode returned`);
			const manifest = await persistedManifest(result.runDir as string);
			assert.deepEqual(manifest.validation_components, components, `${mode}: exact declared components persisted`);
			assert.equal(manifest.cache_request_mode, mode, `${mode}: exact request mode persisted`);
			assert.deepEqual(manifest.validation_components, result.record?.validation_components, `${mode}: returned == persisted validation_components`);
			assert.equal(manifest.cache_request_mode, result.record?.cache_request_mode, `${mode}: returned == persisted cache_request_mode`);
		}
	});
});

test("a complete recipe run publishes its payload and atomic commit record", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const result = await runRecipe({ projectRoot: dir, recipeName: "hello", mode: "DEV", exec: spawnExec, params: { msg: "world" } });
		assert.equal(result.ok, true);
		const files = (await readdir(result.runDir as string)).sort();
		assert.deepEqual(files, ["artifact-manifest.json", "command.json", "environment.json", "manifest.json", "run-commit.json", "stderr.log", "stdout.log", "summary.json"]);

		const manifest = JSON.parse(await readFile(join(result.runDir as string, "manifest.json"), "utf8"));
		assert.equal(manifest.schema_version, 2);
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
		assert.equal(manifest.run_transaction_schema_version, 2);
		assert.equal(manifest.run_outcome, "SUCCESS");
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
				// git calls (runner git state + P4a validation capture) carry no
				// timeout/signal — only the recipe command is forwarded them.
				if (cmd === "git") return { stdout: "", stderr: "", code: 0, killed: false };
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

// ---------------------------------------------------------------------------
// P4a: validation-evidence wiring (git-backed projects)
// ---------------------------------------------------------------------------

const SOL_FACTS = { role: undefined, provider: "openai-codex", model: "gpt-5.6-sol" };

/** Git-init the temp project (the .pi config dir stays ignored). */
async function gitBacked(dir: string): Promise<void> {
	await writeFile(join(dir, ".gitignore"), ".pi/\n", "utf8");
	await spawnExec("git", ["init", "-q"], { cwd: dir });
	await spawnExec("git", ["config", "user.email", "t@t"], { cwd: dir });
	await spawnExec("git", ["config", "user.name", "t"], { cwd: dir });
	await spawnExec("git", ["add", "-A"], { cwd: dir });
	await spawnExec("git", ["commit", "-qm", "init"], { cwd: dir });
}

async function persistedManifest(runDir: string): Promise<any> {
	return JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
}

test("P4a: successful exec run persists a sol binding; returned and persisted agree", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		await gitBacked(dir);
		const result = await runRecipe({ projectRoot: dir, recipeName: "hello", mode: "DEV", exec: spawnExec, params: { msg: "world" }, actorFacts: SOL_FACTS });
		assert.equal(result.ok, true);
		assert.equal(result.record?.execution_source, "exec");
		const persisted = await persistedManifest(result.runDir as string);
		assert.deepEqual(persisted.validation_evidence, result.record?.validation_evidence, "returned and persisted blocks are identical");
		const binding = persisted.validation_evidence.binding;
		assert.ok(binding, "capture succeeded on a git-backed project");
		assert.equal(binding.owner, "sol");
		assert.deepEqual(binding.outcome, { successful: true, complete: true, source: "exec" });
		assert.equal(binding.kind, "recipe");
		assert.equal(binding.target.kind, "recipe");
		assert.equal(binding.target.name, "hello");
		assert.equal(binding.target.cwd, ".");
		assert.equal(binding.target.invocation_hash, result.record?.argv_hash, "exec binding binds the executed-argv hash");
		assert.match(binding.target.invocation_hash, /^[0-9a-f]{64}$/);
		assert.ok(binding.commit, "git HEAD bound");
		assert.match(binding.diff_hash, /^[0-9a-f]{64}$/);
	});
});

test("P4a: failed exec run persists an unsuccessful binding without altering the outcome", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		await gitBacked(dir);
		const result = await runRecipe({ projectRoot: dir, recipeName: "fail", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(result.ok, false);
		assert.equal(result.record?.exit_code, 3);
		assert.equal(result.record?.execution_source, "exec");
		const persisted = await persistedManifest(result.runDir as string);
		assert.deepEqual(persisted.validation_evidence, result.record?.validation_evidence, "returned and persisted blocks are identical");
		assert.deepEqual(persisted.validation_evidence.binding.outcome, { successful: false, complete: true, source: "exec" });
		assert.equal(persisted.exit_code, 3, "the original outcome is never masked");
	});
});

test("P4a: spawn failure persists incomplete evidence and still surfaces the error", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		await gitBacked(dir);
		const exec: ExecFn = async (cmd, args, options) => {
			if (cmd === "git") return spawnExec(cmd, args, options);
			throw new Error("boom: cannot spawn");
		};
		await assert.rejects(runRecipe({ projectRoot: dir, recipeName: "hello", mode: "DEV", exec, actorFacts: SOL_FACTS }), /failed to spawn/);
		const runsDir = join(dir, CONFIG_DIR_NAME, "workbench", "runs");
		const runIds = await readdir(runsDir);
		assert.equal(runIds.length, 1, "the spawn-failure run is persisted");
		const manifest = await persistedManifest(join(runsDir, runIds[0]!));
		assert.equal(manifest.exit_code, null);
		// Phase 2A: the spawn-failure terminal persists the exact declared
		// components and the default cache request mode.
		assert.deepEqual(manifest.validation_components, ["typecheck", "unit-test"], "spawn-failure manifest keeps the exact declared components");
		assert.equal(manifest.cache_request_mode, "default", "spawn-failure manifest records the default cache request mode");
		const block = manifest.validation_evidence;
		assert.ok(block, "spawn-failure runs persist validation evidence");
		if (block.binding) {
			assert.deepEqual(block.binding.outcome, { successful: false, complete: false, source: "exec" }, "spawn failure is unsuccessful AND incomplete");
		} else {
			assert.ok(block.unavailable_reason, "bounded unavailable reason when capture fails");
		}
	});
});

test("P4a: validation evidence never contains raw argv or env secret values", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		await gitBacked(dir);
		const secret = "p4a-super-secret-param-value";
		const envSecret = "p4a-super-secret-env-value";
		process.env.SECRET_TOKEN = envSecret;
		try {
			const argvRun = await runRecipe({ projectRoot: dir, recipeName: "hello", mode: "DEV", exec: spawnExec, params: { msg: secret }, actorFacts: SOL_FACTS });
			assert.equal(argvRun.ok, true);
			const argvEvidence = JSON.stringify((await persistedManifest(argvRun.runDir as string)).validation_evidence);
			assert.ok(!argvEvidence.includes(secret), "raw argv values never appear in the evidence block");

			const envRun = await runRecipe({ projectRoot: dir, recipeName: "echo-secret", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
			assert.equal(envRun.ok, true);
			const envEvidence = JSON.stringify((await persistedManifest(envRun.runDir as string)).validation_evidence);
			assert.ok(!envEvidence.includes(envSecret), "raw env values never appear in the evidence block");
			assert.ok(!envEvidence.includes("SECRET_TOKEN"), "env names are not part of the evidence block");
		} finally {
			delete process.env.SECRET_TOKEN;
		}
	});
});

test("command provenance capture-unavailable fails closed while preserving bounded validation evidence", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const failingGit: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args[0] === "status") return { stdout: "", stderr: "fatal: not a git repository", code: 128, killed: false };
			return { stdout: "", stderr: "", code: 0, killed: false };
		};
		const result = await runRecipe({ projectRoot: dir, recipeName: "hello", mode: "DEV", exec: failingGit, params: { msg: "x" }, actorFacts: SOL_FACTS });
		assert.equal(result.ok, false, "production recipe provenance is fail-closed when guards are unavailable");
		assert.equal(result.error, "COMMAND_EFFECT_EVIDENCE_UNAVAILABLE");
		assert.equal(result.record?.exit_code, null, "the recipe process never started");
		assert.equal(result.record?.run_outcome, "PROCESS_FAILED");
		assert.equal(result.record?.command_effect_status, "EVIDENCE_UNAVAILABLE");
		assert.deepEqual(result.warnings, ["COMMAND_EFFECT_EVIDENCE_UNAVAILABLE"]);
		const persisted = await persistedManifest(result.runDir as string);
		assert.equal(persisted.validation_evidence.binding, null);
		assert.ok(persisted.validation_evidence.unavailable_reason.includes("capture failed"), persisted.validation_evidence.unavailable_reason ?? "");
		assert.deepEqual(persisted.validation_evidence, result.record?.validation_evidence, "returned and persisted unavailable blocks agree");
		const effect = JSON.parse(await readFile(join(result.runDir!, "command-effect.json"), "utf8"));
		assert.equal(effect.status, "EVIDENCE_UNAVAILABLE");
		assert.equal(effect.semantic_acceptance, "NOT_GRANTED");
	});
});

test("P4a: a manifest-patch write failure returns the original record — never a binding that was not persisted", async () => {
	await withTempDir(async (dir) => {
		await gitBacked(dir);
		const runId = "20260101-120000-abcd";
		const runDir = join(dir, CONFIG_DIR_NAME, "workbench", "runs", runId);
		await mkdir(runDir, { recursive: true });
		const record: RunRecord = {
			schema_version: 1,
			run_id: runId,
			recipe: "hello",
			profile: "generic",
			started_at: "2026-01-01T12:00:00.000Z",
			finished_at: "2026-01-01T12:00:01.000Z",
			duration_ms: 1000,
			cwd: dir,
			argv: ["node", "-e", "x"],
			exit_code: 0,
			timed_out: false,
			cancelled: false,
			git_commit: null,
			git_dirty: false,
			artifact_paths: [],
			stdout_truncated: false,
			stderr_truncated: false,
			mode: "DEV",
			expected_exit_codes: [0],
			declared_writes: [],
			environment_names: [],
			validation_components: [],
			cache_request_mode: "default",
			execution_source: "exec",
			argv_hash: executedArgvHash(["node", "-e", "x"]),
		};
		const recipe: Recipe = { ...DEFAULT_RECIPE, name: "hello", command: ["node", "-e", "x"] };
		// manifest.json is a DIRECTORY: the patch writeFile fails (EISDIR) even
		// though the capture itself succeeds.
		await mkdir(join(runDir, "manifest.json"));
		const patched = await captureAndPatchRunManifest({
			projectRoot: dir,
			runDir,
			record,
			profile: "generic",
			mode: "DEV",
			exec: spawnExec,
			recipe,
			argv: ["node", "-e", "x"],
			argvHash: record.argv_hash,
			projectGates: [],
			actorFacts: SOL_FACTS,
			successful: true,
			complete: true,
			source: "exec",
		});
		assert.equal(patched, record, "the ORIGINAL record is returned when the patch cannot be persisted");
		assert.equal(patched.validation_evidence, undefined, "no binding is fabricated for a patch that was not persisted");
	});
});
