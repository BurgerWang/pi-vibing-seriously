/**
 * P6-C action cache integration tests — store + recipe-runner lifecycle.
 *
 * Coverage (P6-C spec §7/§9/§11/§12): same-input hit, content-change miss,
 * recipe-definition miss, argv miss, success cached / failure not cached,
 * no-cache, refresh-cache, maxAge expiry, concurrent same key, stale lock,
 * corrupted action JSON, corrupted CAS, atomic writes, LRU dry-run/apply,
 * new run manifest on hit, gate evidence on hit, cache failure falls back
 * to execution, cache dir layout, secret-free records.
 *
 * P4b/P6-C separation (registered surface, additive): registered
 * workbench_read_run reads around the action-cache lifecycle prove the
 * read can never change the action key, the cache-store bytes/paths, the
 * run history or the recipe execution counter, can never auto-execute or
 * auto-skip (no-cache / refresh-cache / cached-failure semantics stay
 * intact), and render the ACTUAL REUSABLE / fail-closed RERUN_REQUIRED
 * assessment through the registered runtime tool.
 */

import assert from "node:assert/strict";
import { lstat, mkdir, open, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

import { runRecipe, type RunRecipeResult } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import { runGates } from "../extensions/workbench-runtime/core/gate-engine.ts";
import {
	ACTION_RECORD_MAX_BYTES,
	CACHE_INDEX_MAX_BYTES,
	ActionCacheIndexRebuildError,
	LOCK_RECORD_MAX_BYTES,
	ActionCacheStore,
} from "../extensions/workbench-runtime/cache/action-store.ts";
import { recipeDefinitionHash } from "../extensions/workbench-runtime/cache/action-key.ts";
import { readManifest } from "../extensions/workbench-runtime/core/runs.ts";
import { DEFAULT_RECIPE, type Recipe } from "../extensions/workbench-runtime/core/recipe-schema.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { withTempDir, writeConfigFile } from "./helpers.ts";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { WORKER_ALLOWED_PATHS_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ROLE_ENV } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { WORKER_SPEND_PROFILE_ENV } from "../extensions/workbench-runtime/core/worker-spend.ts";

const CONFIG = ".pi";

/**
 * The registered-surface tests below must never inherit a worker-role env
 * from the harness (unit tests can run inside a delegated worker process):
 * the owner/actor resolution would flip the REUSABLE verdict. Clear it
 * before the suite, like tests/run-result-wiring.test.ts.
 */
before(() => {
	delete process.env[WORKER_ROLE_ENV];
	delete process.env[WORKER_PROJECT_ROOT_ENV];
	delete process.env[WORKER_ALLOWED_PATHS_ENV];
	delete process.env[WORKER_SPEND_PROFILE_ENV];
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeExecOptions {
	/** Delay before responding to the recipe command (ms). */
	delayMs?: number;
	recipeCode?: number;
	recipeStdout?: string;
	recipeStderr?: string;
	toolchain?: Record<string, string>;
}

function fakeExec(options: FakeExecOptions = {}): ExecFn & { recipeCalls: number; gitCalls: number; toolchainCalls: number } {
	const state = { recipeCalls: 0, gitCalls: 0, toolchainCalls: 0 };
	const fn = (async (command: string, args: string[], opts?: { timeout?: number; signal?: AbortSignal }) => {
		if (command === "git") {
			state.gitCalls += 1;
			if (args[0] === "rev-parse" && args[1] === "HEAD") {
				return { stdout: `${"a".repeat(40)}\n`, stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		}
		const tool = (options.toolchain ?? {})[command];
		if (tool !== undefined && args[0] === "--version") {
			state.toolchainCalls += 1;
			return { stdout: tool, stderr: "", code: 0, killed: false };
		}
		state.recipeCalls += 1;
		if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
		return {
			stdout: options.recipeStdout ?? "hello from recipe\n",
			stderr: options.recipeStderr ?? "",
			code: options.recipeCode ?? 0,
			killed: false,
		};
	}) as ExecFn & { recipeCalls: number; gitCalls: number; toolchainCalls: number };
	Object.defineProperty(fn, "recipeCalls", { get: () => state.recipeCalls });
	Object.defineProperty(fn, "gitCalls", { get: () => state.gitCalls });
	Object.defineProperty(fn, "toolchainCalls", { get: () => state.toolchainCalls });
	return fn;
}

function cacheYaml(inputs: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { enabled: true, version: 1, mode: "result-only", successOnly: true, inputs, outputs: [], environment: [], toolchain: [], maxAgeSeconds: null, ...extra };
}

async function makeProject(root: string, files: Record<string, string>, recipeOverrides: Record<string, unknown> = {}): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, content, "utf8");
	}
	const recipe = {
		name: "hello",
		description: "hello recipe",
		command: ["hello-cli", "run"],
		cwd: ".",
		timeout_ms: 60_000,
		allowed_modes: ["DEV", "VERIFY"],
		expected_exit_codes: [0],
		writes: [],
		artifacts: [],
		environment: [],
		output_strategy: "tail",
		max_lines: 100,
		max_bytes: 4096,
		validation_components: ["typecheck", "unit-test"],
		...recipeOverrides,
	};
	await writeConfigFile(root, "recipes.yaml", `recipes:\n${yamlInline(recipe)}\n`);
}

function yamlInline(recipe: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(recipe)) {
		if (key === "cache") {
			lines.push("cache:");
			for (const [ck, cv] of Object.entries(value as Record<string, unknown>)) {
				if (Array.isArray(cv)) lines.push(`  ${ck}: [${cv.map((i) => JSON.stringify(i)).join(", ")}]`);
				else lines.push(`  ${ck}: ${JSON.stringify(cv)}`);
			}
		} else if (Array.isArray(value)) {
			lines.push(`${key}: [${value.map((i) => JSON.stringify(i)).join(", ")}]`);
		} else if (typeof value === "object" && value !== null) {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		} else {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		}
	}
	const [first, ...rest] = lines;
	return `- ${first ?? "name: unnamed"}\n${rest.map((l) => `  ${l}`).join("\n")}`;
}

async function run(root: string, exec: ExecFn, opts: { now?: () => Date; cacheMode?: "default" | "no-cache" | "refresh-cache" } = {}): Promise<RunRecipeResult> {
	return runRecipe({ projectRoot: root, recipeName: "hello", params: {}, mode: "DEV", exec, now: opts.now, cacheMode: opts.cacheMode });
}

function cacheDir(root: string): string {
	return join(root, CONFIG, "workbench", "cache");
}

async function countActionRecords(root: string): Promise<number> {
	try {
		const names = await readdir(join(cacheDir(root), "actions"));
		return names.filter((n) => n.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("lifecycle: miss -> execute -> write; identical inputs -> hit without executing", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "const a = 1;\n" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		const first = await run(root, exec);
		assert.equal(first.ok, true);
		assert.equal(first.cache?.status, "miss");
		assert.equal(exec.recipeCalls, 1);
		assert.equal(await countActionRecords(root), 1);

		const second = await run(root, exec);
		assert.equal(second.ok, true);
		assert.equal(second.cache?.status, "hit");
		assert.equal(second.cache?.actionKey, first.cache?.actionKey);
		assert.ok(second.cache?.reusedFromRunId);
		assert.equal(exec.recipeCalls, 1, "hit must not execute the recipe");
	});
});

test("lifecycle: content change -> miss; restore content -> hit again (same key)", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "v1" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		const first = await run(root, exec);
		assert.equal(first.cache?.status, "miss");
		const key1 = first.cache?.actionKey;

		await writeFile(join(root, "src", "a.ts"), "v2", "utf8");
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "miss");
		assert.notEqual(second.cache?.actionKey, key1);
		assert.equal(exec.recipeCalls, 2);

		await writeFile(join(root, "src", "a.ts"), "v1", "utf8");
		const third = await run(root, exec);
		assert.equal(third.cache?.status, "hit");
		assert.equal(third.cache?.actionKey, key1, "restored content re-uses the original key");
		assert.equal(exec.recipeCalls, 2);
	});
});

test("lifecycle: touch (mtime only) keeps hitting", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "stable" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec);
		await new Promise((r) => setTimeout(r, 20));
		await writeFile(join(root, "src", "a.ts"), "stable", "utf8");
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "hit");
		assert.equal(exec.recipeCalls, 1);
	});
});

test("lifecycle: recipe definition change -> miss", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]), timeout_ms: 60_000 });
		const exec = fakeExec();
		await run(root, exec);
		// Definition change: different timeout_ms.
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]), timeout_ms: 90_000 });
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "miss");
		assert.equal(exec.recipeCalls, 2);
		// Definition change with ONLY validation_components differing from the
		// original recipe (timeout_ms back to 60_000): still a miss.
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]), validation_components: ["whitespace"] });
		const third = await run(root, exec);
		assert.equal(third.cache?.status, "miss", "validation_components-only definition change -> miss");
		assert.equal(exec.recipeCalls, 3);
	});
});

test("recipeDefinitionHash: ONLY validation_components differ -> different hash", () => {
	const base: Recipe = { ...DEFAULT_RECIPE, name: "hello", command: ["hello-cli", "run"], validation_components: ["typecheck", "unit-test"] };
	const same: Recipe = { ...base };
	const different: Recipe = { ...base, validation_components: ["whitespace"] };
	assert.equal(recipeDefinitionHash(same), recipeDefinitionHash(base), "identical recipes hash equal");
	assert.notEqual(recipeDefinitionHash(different), recipeDefinitionHash(base), "changing only validation_components must change the definition hash");
});

test("recipeDefinitionHash binds the full artifact contract, not only its glob", () => {
	const legacy = { ...DEFAULT_RECIPE, name: "r", command: ["true"], artifacts: ["out/*.json"], artifact_contracts: [{ path: "out/*.json", required: false, min_count: 0, max_count: null, type: "file" as const, min_bytes: 0, max_bytes: 268435456, sha256: null, freshness: "current" as const, snapshot: false, root: "project" as const, external_root: null, legacy_optional: true }] };
	const required = { ...legacy, artifact_contracts: [{ ...legacy.artifact_contracts[0]!, required: true, min_count: 1, legacy_optional: false }] };
	assert.notEqual(recipeDefinitionHash(required), recipeDefinitionHash(legacy));
});

test("lifecycle: argv change -> miss", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]), params: [{ name: "p", type: "string", required: true }], command: ["hello-cli", "{{p}}"] });
		const exec = fakeExec();
		const a = await runRecipe({ projectRoot: root, recipeName: "hello", params: { p: "a" }, mode: "DEV", exec });
		assert.equal(a.cache?.status, "miss");
		const b = await runRecipe({ projectRoot: root, recipeName: "hello", params: { p: "b" }, mode: "DEV", exec });
		assert.equal(b.cache?.status, "miss");
		assert.notEqual(a.cache?.actionKey, b.cache?.actionKey);
		assert.equal(exec.recipeCalls, 2);
	});
});

test("lifecycle: failed runs are never cache authority, including legacy successOnly=false declarations", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec({ recipeCode: 1, recipeStdout: "boom" });
		const first = await run(root, exec);
		assert.equal(first.ok, false);
		assert.equal(first.cache?.status, "miss");
		assert.equal(await countActionRecords(root), 0, "failures are not cached by default");

		const again = await run(root, exec);
		assert.equal(again.cache?.status, "miss");
		assert.equal(exec.recipeCalls, 2, "failure runs always execute");

		// A legacy successOnly=false declaration cannot override the runOk
		// provenance boundary: failed runs never enter the action store.
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"], { successOnly: false }) });
		const third = await run(root, exec);
		assert.equal(third.ok, false);
		assert.equal(third.cache?.status, "miss");
		assert.equal(await countActionRecords(root), 0);
		const fourth = await run(root, exec);
		assert.equal(fourth.cache?.status, "miss");
		assert.equal(fourth.ok, false);
		assert.equal(exec.recipeCalls, 4, "every failed run executes and produces fresh evidence");
	});
});

test("lifecycle: --no-cache never reads or writes", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		const first = await run(root, exec, { cacheMode: "no-cache" });
		assert.equal(first.cache?.status, "no-cache");
		assert.equal(exec.recipeCalls, 1);
		assert.equal(await countActionRecords(root), 0, "no-cache must not write");
		assert.equal(first.record?.cache_request_mode, "no-cache", "exec record keeps the exact request mode");
		assert.deepEqual(first.record?.validation_components, ["typecheck", "unit-test"], "exec record keeps the exact declared components");
		const firstPersisted = await readManifest(root, first.record!.run_id);
		assert.equal(firstPersisted?.cache_request_mode, "no-cache", "persisted manifest agrees on the request mode");
		assert.deepEqual(firstPersisted?.validation_components, first.record?.validation_components, "persisted manifest agrees on the components");
		const second = await run(root, exec, { cacheMode: "no-cache" });
		assert.equal(second.cache?.status, "no-cache");
		assert.equal(second.record?.cache_request_mode, "no-cache", "every no-cache run executes and records no-cache");
		assert.equal(exec.recipeCalls, 2, "no-cache must not read (always executes)");
	});
});

test("lifecycle: --refresh-cache never reads, executes and replaces the record", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec); // miss + write
		const before = await readdir(join(cacheDir(root), "actions"));
		assert.equal(before.length, 1);

		const refreshed = await run(root, exec, { cacheMode: "refresh-cache" });
		assert.equal(refreshed.cache?.status, "refresh-executed");
		assert.equal(exec.recipeCalls, 2, "refresh always executes");
		assert.equal(refreshed.record?.cache_request_mode, "refresh-cache", "refresh exec record keeps the exact request mode");
		assert.deepEqual(refreshed.record?.validation_components, ["typecheck", "unit-test"], "refresh exec record keeps the exact declared components");
		const refreshedPersisted = await readManifest(root, refreshed.record!.run_id);
		assert.equal(refreshedPersisted?.cache_request_mode, "refresh-cache", "persisted manifest agrees on the request mode");
		assert.deepEqual(refreshedPersisted?.validation_components, refreshed.record?.validation_components, "persisted manifest agrees on the components");
		const after = await readdir(join(cacheDir(root), "actions"));
		assert.equal(after.length, 1, "refresh replaces, never duplicates");

		const hit = await run(root, exec);
		assert.equal(hit.cache?.status, "hit");
		assert.equal(exec.recipeCalls, 2);
	});
});

test("lifecycle: maxAgeSeconds expiry -> miss (then re-cached)", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"], { maxAgeSeconds: 60 }) });
		let current = Date.parse("2026-01-01T00:00:00Z");
		const now = () => new Date(current);
		const exec = fakeExec();
		const first = await run(root, exec, { now });
		assert.equal(first.cache?.status, "miss");
		current += 30_000;
		const second = await run(root, exec, { now });
		assert.equal(second.cache?.status, "hit", "within maxAge -> hit");
		current += 60_000;
		const third = await run(root, exec, { now });
		assert.equal(third.cache?.status, "miss", "expired -> not reused");
		assert.equal(exec.recipeCalls, 2, "expired -> executes");
	});
});

// ---------------------------------------------------------------------------
// Hit materialization
// ---------------------------------------------------------------------------

test("hit: new run manifest with executionSource=cache and all P6-C fields", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x", "results/out.json": "{}" }, { cache: cacheYaml(["src/**/*.ts"]), artifacts: ["results/**"] });
		const exec = fakeExec();
		const first = await run(root, exec);
		assert.equal(first.cache?.status, "miss");
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "hit");
		assert.notEqual(second.record?.run_id, first.record?.run_id, "hit creates a NEW run id");
		const manifest = second.record;
		assert.equal(manifest?.execution_source, "cache");
		assert.equal(manifest?.action_key, second.cache?.actionKey);
		assert.equal(manifest?.reused_from_run_id, first.record?.run_id);
		assert.ok(manifest?.cache_created_at);
		assert.ok(manifest?.cache_validated_at);
		assert.equal(manifest?.exit_code, 0);
		assert.ok(Array.isArray(manifest?.evidence_paths) && manifest.evidence_paths.length > 0);
		assert.equal(manifest?.artifact_validation?.status, "result-only");
		assert.equal(manifest?.artifact_validation?.artifacts_restored, false);
		assert.equal(manifest?.argv.length, 0, "argv values are never stored on hit runs");
		assert.ok(manifest?.argv_hash);
		// Phase 2A: materialized hit records use the CURRENT recipe components
		// and default request mode — returned record and disk manifest agree,
		// and the exec terminal matches.
		assert.deepEqual(manifest?.validation_components, ["typecheck", "unit-test"], "hit record keeps the CURRENT recipe components");
		assert.equal(manifest?.cache_request_mode, "default", "materialized hit runs are always default-mode");
		assert.deepEqual(first.record?.validation_components, ["typecheck", "unit-test"], "exec terminal keeps the same components");
		assert.equal(first.record?.cache_request_mode, "default", "exec terminal ran in default mode");
		const persistedManifest = JSON.parse(await readFile(join(root, CONFIG, "workbench", "runs", manifest.run_id, "manifest.json"), "utf8")) as {
			validation_components: string[];
			cache_request_mode: string;
		};
		assert.deepEqual(persistedManifest.validation_components, manifest?.validation_components, "disk manifest == returned record components");
		assert.equal(persistedManifest.cache_request_mode, manifest?.cache_request_mode, "disk manifest == returned record mode");
		// execution.json evidence marker exists in the run directory.
		const execution = JSON.parse(await readFile(join(root, CONFIG, "workbench", "runs", manifest.run_id, "execution.json"), "utf8")) as { execution_source: string };
		assert.equal(execution.execution_source, "cache");
	});
});

test("hit: cached stdout/stderr views are the truncated views", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]), max_bytes: 32 });
		const exec = fakeExec({ recipeStdout: "a".repeat(200) });
		const first = await run(root, exec);
		assert.equal(first.summary?.stdout_truncated, true);
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "hit");
		assert.equal(second.summary?.stdout, first.summary?.stdout);
		assert.equal(second.summary?.stdout_truncated, true);
	});
});

test("hit: gate evidence records execution_source=cache and the gate still passes", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		await writeConfigFile(
			root,
			"gates.yaml",
			[
				"gates:",
				"  - id: g-cache",
				"    title: cached recipe gate",
				"    required: true",
				"    blocking: true",
				"    checks:",
				"      - id: run-hello",
				"        kind: recipe",
				"        recipe: hello",
				"",
			].join("\n"),
		);
		const exec = fakeExec();
		const recipeRun = await run(root, exec); // prime the cache
		assert.equal(recipeRun.cache?.status, "miss");

		const gate = await runGates({ projectRoot: root, selector: "g-cache", mode: "DEV", exec, manualEvidence: {} });
		assert.equal(gate.status, "PASS");
		assert.equal(exec.recipeCalls, 1, "gate reused the cached run — no re-execution");
		const evidence = JSON.parse(await readFile(join(gate.runDir, "evidence.json"), "utf8")) as {
			checks: Record<string, { evidence: Array<{ execution_source?: string }> }>;
		};
		const entry = evidence.checks["run-hello"]?.evidence[0];
		assert.ok(entry, "recipe_run evidence present");
		assert.equal(entry.execution_source, "cache");
	});
});

// ---------------------------------------------------------------------------
// Cache policy / refusal
// ---------------------------------------------------------------------------

test("refusal: cache disabled by default (no cache block)", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" });
		const exec = fakeExec();
		const first = await run(root, exec);
		assert.equal(first.cache?.status, "disabled");
		assert.equal(await countActionRecords(root), 0);
	});
});

test("refusal: symlink escape input -> cache refused, execution proceeds", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const { symlink } = await import("node:fs/promises");
		await symlink("/etc/hostname", join(root, "src", "escape.ts"));
		const exec = fakeExec();
		const first = await run(root, exec);
		assert.equal(first.ok, true);
		assert.equal(first.cache?.status, "refused");
		assert.match(first.cache?.reason ?? "", /symlink|outside/);
		assert.equal(exec.recipeCalls, 1);
		assert.equal(await countActionRecords(root), 0);
	});
});

test("refusal: project-local symlink input also refuses and never creates a reusable record", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const { symlink } = await import("node:fs/promises");
		await symlink("a.ts", join(root, "src", "alias.ts"));
		const exec = fakeExec();
		const first = await run(root, exec);
		const second = await run(root, exec);
		assert.equal(first.cache?.status, "refused");
		assert.equal(second.cache?.status, "refused");
		assert.match(first.cache?.reason ?? "", /symlink.*not cacheable.*without following/i);
		assert.equal(exec.recipeCalls, 2, "refused fingerprints can never become a later cache hit");
		assert.equal(await countActionRecords(root), 0);
	});
});

test("refusal: cache write failure degrades to a normal run (write-failed)", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		// Make the actions path unusable: create a FILE where the dir should be.
		await mkdir(join(cacheDir(root)), { recursive: true });
		await writeFile(join(cacheDir(root), "actions"), "blocking file", "utf8");
		const first = await run(root, exec);
		assert.equal(first.ok, true, "run succeeds despite cache write failure");
		assert.equal(first.cache?.status, "write-failed");
		assert.equal(exec.recipeCalls, 1);
	});
});

test("refusal: artifacts mode never hits (restore disabled) and stores metadata only", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x", "dist/out.js": "x" }, { cache: cacheYaml(["src/**/*.ts"], { mode: "artifacts", outputs: ["dist/**"] }) });
		const exec = fakeExec();
		const first = await run(root, exec);
		assert.equal(first.cache?.status, "artifacts-disabled");
		assert.equal(exec.recipeCalls, 1);
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "artifacts-disabled");
		assert.equal(exec.recipeCalls, 2, "artifacts-mode recipes always execute in v1");
		assert.equal(await countActionRecords(root), 1, "result metadata is still stored");
		const store = new ActionCacheStore(root);
		const index = await store.readIndex();
		const record = (await store.readRecord(index.entries[0]!.key)).record;
		assert.equal(record?.artifacts.restoreDisabled, true);
		assert.equal(record?.artifacts.restored, false);
	});
});

test("records never store secret env values or argv values", async () => {
	await withTempDir(async (root) => {
		const secret = "super-secret-token-value-xyz";
		process.env.MY_SECRET_TOKEN = secret;
		try {
			await makeProject(root, { "src/a.ts": "x" }, {
				cache: cacheYaml(["src/**/*.ts"], { environment: ["MY_SECRET_TOKEN"] }),
				environment: ["MY_SECRET_TOKEN"],
			});
			const exec = fakeExec();
			const result = await run(root, exec);
			assert.equal(result.cache?.status, "miss");
			const store = new ActionCacheStore(root);
			const index = await store.readIndex();
			assert.equal(index.entries.length, 1);
			const record = (await store.readRecord(index.entries[0]!.key)).record;
			assert.ok(record);
			const raw = JSON.stringify(record);
			assert.ok(!raw.includes(secret), "secret value must never be persisted");
			assert.match(record.envValueHashes["MY_SECRET_TOKEN"] ?? "", /^[0-9a-f]{64}$/, "value stored as hash only");
		} finally {
			delete process.env.MY_SECRET_TOKEN;
		}
	});
});

// ---------------------------------------------------------------------------
// Store: locks, corruption, atomicity, CAS, LRU, clear
// ---------------------------------------------------------------------------

test("store: concurrent same-key runs execute once or wait safely", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec({ delayMs: 150 });
		const [a, b] = await Promise.all([run(root, exec), run(root, exec)]);
		const hits = [a, b].filter((r) => r.cache?.status === "hit").length;
		const misses = [a, b].filter((r) => r.cache?.status === "miss").length;
		assert.equal(misses, 1, "exactly one run executed");
		assert.equal(hits, 1, "the other reused the result (double-checked lock)");
		assert.equal(exec.recipeCalls, 1);
		// Phase 2A: BOTH terminals (exec miss + double-checked hit) materialize
		// records with the current recipe components and default request mode,
		// and the on-disk manifests agree with the returned records.
		for (const result of [a, b]) {
			assert.deepEqual(result.record?.validation_components, ["typecheck", "unit-test"], "current recipe components on every materialized record");
			assert.equal(result.record?.cache_request_mode, "default", "materialized records are always default-mode");
			const onDisk = await readManifest(root, result.record!.run_id);
			assert.deepEqual(onDisk?.validation_components, result.record?.validation_components, "disk manifest == returned record components");
			assert.equal(onDisk?.cache_request_mode, result.record?.cache_request_mode, "disk manifest == returned record mode");
		}
	});
});

test("store: stale lock is recovered", async () => {
	await withTempDir(async (root) => {
		const store = new ActionCacheStore(root, { lockStaleMs: 1000, lockWaitMs: 1500, pid: process.pid });
		const key = "a".repeat(64);
		await mkdir(join(cacheDir(root), "locks"), { recursive: true });
		await writeFile(
			join(cacheDir(root), "locks", `${key}.lock`),
			JSON.stringify({ key, token: "old", ownerPid: 999999, createdAt: new Date(Date.now() - 10_000).toISOString() }),
			"utf8",
		);
		const lock = await store.acquireLock(key);
		assert.ok(lock, "stale lock must be broken");
		await lock!.release();
		// Fresh lock held by a live owner is NOT broken.
		const fresh = await store.acquireLock(key);
		assert.ok(fresh);
		const second = await store.acquireLock(key);
		assert.equal(second, null, "a fresh held lock must not be granted twice");
		await fresh!.release();
	});
});

test("store: different action keys serialize cache-index RMW and preserve both entries", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec);
		const seedStore = new ActionCacheStore(root);
		const seedIndex = await seedStore.readIndex();
		const seed = (await seedStore.readRecord(seedIndex.entries[0]!.key)).record;
		assert.ok(seed);
		await seedStore.clear("all");

		let firstEnteredResolve!: () => void;
		const firstEntered = new Promise<void>((resolve) => { firstEnteredResolve = resolve; });
		let releaseFirst!: () => void;
		const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let secondEntered = false;
		const firstStore = new ActionCacheStore(root, {
			indexMutationHooks: { afterAcquire: async () => { firstEnteredResolve(); await firstBlocked; } },
		});
		const secondStore = new ActionCacheStore(root, {
			indexMutationHooks: { afterAcquire: () => { secondEntered = true; } },
		});
		const firstRecord = { ...seed, actionKey: "1".repeat(64), recipe: "first" };
		const secondRecord = { ...seed, actionKey: "2".repeat(64), recipe: "second" };

		const firstWrite = firstStore.writeRecord(firstRecord);
		await firstEntered;
		const secondWrite = secondStore.writeRecord(secondRecord);
		await new Promise((resolve) => setTimeout(resolve, 75));
		assert.equal(secondEntered, false, "a different key cannot enter index RMW while the first mutation owns the global mutex");
		releaseFirst();
		assert.deepEqual(await Promise.all([firstWrite, secondWrite]), [{ ok: true }, { ok: true }]);

		const finalIndex = await seedStore.readIndex();
		assert.deepEqual(finalIndex.entries.map((entry) => entry.key).sort(), [firstRecord.actionKey, secondRecord.actionKey]);
		assert.deepEqual(await seedStore.stats(), {
			entries: 2,
			totalBytes: finalIndex.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
			perRecipe: {
				first: { entries: 1, bytes: finalIndex.entries.find((entry) => entry.recipe === "first")!.sizeBytes },
				second: { entries: 1, bytes: finalIndex.entries.find((entry) => entry.recipe === "second")!.sizeBytes },
			},
		});
	});
});

test("store: cache-index write is accepted only after strict readback", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec);
		const seedStore = new ActionCacheStore(root);
		const seedIndex = await seedStore.readIndex();
		const seed = (await seedStore.readRecord(seedIndex.entries[0]!.key)).record;
		assert.ok(seed);
		await seedStore.clear("all");

		const key = "3".repeat(64);
		let faulted = false;
		const faultedStore = new ActionCacheStore(root, {
			indexMutationHooks: {
				afterWriteBeforeVerify: async () => {
					if (faulted) return;
					faulted = true;
					await writeFile(seedStore.indexPath(), "{corrupted-after-rename", "utf8");
				},
			},
		});
		const result = await faultedStore.writeRecord({ ...seed, actionKey: key, recipe: "faulted" });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /strict write verification failed/);
		assert.deepEqual(await faultedStore.readRecord(key), { record: null, corrupt: false }, "failed readback rolls back the published record");
		assert.deepEqual((await seedStore.readIndex()).entries, [], "the next bounded read repairs the corrupted index from rolled-back actions");
	});
});

test("store: cache-index mutex recovers only a stable dead owner and preserves a live owner", async () => {
	await withTempDir(async (root) => {
		const bootId = "11111111-1111-4111-8111-111111111111";
		const processStartTicks = "200";
		const identityOptions = {
			isProcessAlive: (pid: number) => pid === process.pid,
			readBootId: async () => bootId,
			readProcessStartTicks: async (pid: number) => pid === process.pid ? processStartTicks : null,
		};
		const locks = join(cacheDir(root), "locks");
		await mkdir(locks, { recursive: true });
		const recovering = new ActionCacheStore(root, { lockStaleMs: 10, indexLockWaitMs: 500, ...identityOptions });
		await writeFile(recovering.indexLockPath(), JSON.stringify({
			token: "dead-index-owner",
			ownerPid: 999999,
			createdAt: new Date(Date.now() - 10_000).toISOString(),
			kind: "cache-index",
		}), "utf8");
		assert.deepEqual((await recovering.rebuildIndex()).entries, [], "dead owner is atomically claimed and recovered");

		await writeFile(recovering.indexLockPath(), JSON.stringify({
			token: "live-index-owner",
			ownerPid: process.pid,
			bootId,
			processStartTicks,
			createdAt: new Date(Date.now() - 10_000).toISOString(),
			kind: "cache-index",
		}), "utf8");
		const blocked = new ActionCacheStore(root, { lockStaleMs: 10, indexLockWaitMs: 50, ...identityOptions });
		await assert.rejects(blocked.rebuildIndex(), /cache index mutation lock wait timed out/);
		const persisted = JSON.parse(await readFile(blocked.indexLockPath(), "utf8")) as { token?: unknown };
		assert.equal(persisted.token, "live-index-owner", "live index owner is never removed based on age");
	});
});

test("store: cache locks bind liveness to boot id and process start ticks, not PID alone", async () => {
	await withTempDir(async (root) => {
		const bootId = "11111111-1111-4111-8111-111111111111";
		const otherBootId = "22222222-2222-4222-8222-222222222222";
		const currentStartTicks = "200";
		const options = {
			lockStaleMs: 10,
			lockWaitMs: 60,
			indexLockWaitMs: 60,
			isProcessAlive: (pid: number) => pid === process.pid,
			readBootId: async () => bootId,
			readProcessStartTicks: async (pid: number) => pid === process.pid ? currentStartTicks : null,
		};
		const store = new ActionCacheStore(root, options);
		await mkdir(join(cacheDir(root), "locks"), { recursive: true });
		const oldCreatedAt = new Date(Date.now() - 10_000).toISOString();

		await writeFile(store.indexLockPath(), JSON.stringify({
			token: "reused-pid-index", ownerPid: process.pid, bootId,
			processStartTicks: "100", createdAt: oldCreatedAt, kind: "cache-index",
		}), "utf8");
		assert.deepEqual((await store.rebuildIndex()).entries, [], "same PID with different start ticks is a dead prior process");

		const bootMismatchKey = "6".repeat(64);
		await writeFile(store.lockPath(bootMismatchKey), JSON.stringify({
			key: bootMismatchKey, token: "prior-boot", ownerPid: process.pid,
			bootId: otherBootId, processStartTicks: currentStartTicks, createdAt: oldCreatedAt,
		}), "utf8");
		const afterBootMismatch = await store.acquireLock(bootMismatchKey);
		assert.ok(afterBootMismatch, "same PID/start ticks from another boot is recoverable");
		await afterBootMismatch!.release();

		const liveKey = "7".repeat(64);
		await writeFile(store.lockPath(liveKey), JSON.stringify({
			key: liveKey, token: "exact-live-owner", ownerPid: process.pid,
			bootId, processStartTicks: currentStartTicks, createdAt: oldCreatedAt,
		}), "utf8");
		assert.equal(await store.acquireLock(liveKey), null, "exact boot/start identity is never recovered based on age");
		const livePayload = JSON.parse(await readFile(store.lockPath(liveKey), "utf8")) as { token?: unknown };
		assert.equal(livePayload.token, "exact-live-owner");
	});
});

test("store: unavailable process-instance identity fails closed for global and per-key locks", async () => {
	await withTempDir(async (root) => {
		const unavailable = new ActionCacheStore(root, {
			lockStaleMs: 10,
			lockWaitMs: 30,
			indexLockWaitMs: 30,
			isProcessAlive: () => true,
			readBootId: async () => null,
			readProcessStartTicks: async () => null,
		});
		await mkdir(join(cacheDir(root), "locks"), { recursive: true });
		const key = "a".repeat(64);
		const existing = JSON.stringify({
			key, token: "unproven-owner", ownerPid: process.pid,
			bootId: "11111111-1111-4111-8111-111111111111", processStartTicks: "100",
			createdAt: new Date(Date.now() - 10_000).toISOString(),
		});
		await writeFile(unavailable.lockPath(key), existing, "utf8");
		assert.equal(await unavailable.acquireLock(key), null);
		assert.equal(await readFile(unavailable.lockPath(key), "utf8"), existing, "unproven per-key owner is untouched");

		await writeFile(unavailable.indexLockPath(), JSON.stringify({
			token: "unproven-index-owner", ownerPid: process.pid,
			bootId: "11111111-1111-4111-8111-111111111111", processStartTicks: "100",
			createdAt: new Date(Date.now() - 10_000).toISOString(), kind: "cache-index",
		}), "utf8");
		await assert.rejects(unavailable.rebuildIndex(), /owner process identity is unavailable/);
		assert.equal((await lstat(unavailable.indexLockPath())).isFile(), true, "unproven global owner is untouched");
	});
});

test("store: legacy empty/truncated fixed locks recover after the stale grace without partial publication", async () => {
	await withTempDir(async (root) => {
		const store = new ActionCacheStore(root, { lockStaleMs: 10, lockWaitMs: 500, indexLockWaitMs: 500 });
		await mkdir(join(cacheDir(root), "locks"), { recursive: true });
		const old = new Date(Date.now() - 10_000);

		await writeFile(store.indexLockPath(), "", "utf8");
		await utimes(store.indexLockPath(), old, old);
		assert.deepEqual((await store.rebuildIndex()).entries, [], "empty index-lock crash residue is safely recovered");

		const key = "8".repeat(64);
		await writeFile(store.lockPath(key), "{", "utf8");
		await utimes(store.lockPath(key), old, old);
		const acquired = await store.acquireLock(key);
		assert.ok(acquired, "truncated per-key lock crash residue is safely recovered");
		await acquired!.release();
		assert.deepEqual(await readdir(join(cacheDir(root), "locks")), [], "fixed and owner/claim names are removed after release");
	});
});

test("store: static index symlinks and symlinked cache ancestors are never followed", async () => {
	await withTempDir(async (root) => {
		const store = new ActionCacheStore(root);
		await mkdir(cacheDir(root), { recursive: true });
		const external = join(root, "external-index.json");
		const externalPayload = `${JSON.stringify({
			schemaVersion: 1,
			entries: [{
				key: "7".repeat(64), recipe: "external", createdAt: new Date().toISOString(),
				lastUsedAt: new Date().toISOString(), sizeBytes: 1, success: true, mode: "result-only",
			}],
		}, null, 2)}\n`;
		await writeFile(external, externalPayload, "utf8");
		await symlink(external, store.indexPath());
		assert.deepEqual((await store.readIndex()).entries, [], "index leaf symlink is rebuilt locally, not trusted");
		assert.equal(await readFile(external, "utf8"), externalPayload, "external symlink target is untouched");
	});
	await withTempDir(async (root) => {
		await mkdir(join(root, ".pi", "workbench"), { recursive: true });
		const externalCache = join(root, "external-cache");
		await mkdir(externalCache);
		await symlink(externalCache, cacheDir(root));
		const store = new ActionCacheStore(root, { indexLockWaitMs: 50 });
		await assert.rejects(store.readIndex(), /cache directory component is unsafe/);
		assert.deepEqual(await readdir(externalCache), [], "unsafe ancestor target is never populated");
	});
});

test("store: a valid index without membership makes an orphan record a miss until rebuild", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec);
		const store = new ActionCacheStore(root);
		const original = await store.readIndex();
		assert.equal(original.entries.length, 1);
		await writeFile(store.indexPath(), `${JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2)}\n`, "utf8");
		const rerun = await run(root, exec);
		assert.equal(rerun.cache?.status, "miss", "unindexed record is not lookup-visible");
		assert.equal(exec.recipeCalls, 2, "orphan record cannot suppress execution");
	});
});

test("store: record publication is serialized with clear and prune", async () => {
	for (const maintenance of ["clear", "prune"] as const) {
		await withTempDir(async (root) => {
			await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
			await run(root, fakeExec());
			const seedStore = new ActionCacheStore(root);
			const seedIndex = await seedStore.readIndex();
			const seed = (await seedStore.readRecord(seedIndex.entries[0]!.key)).record;
			assert.ok(seed);
			await seedStore.clear("all");

			let publishedResolve!: () => void;
			const published = new Promise<void>((resolve) => { publishedResolve = resolve; });
			let continueResolve!: () => void;
			const continueWrite = new Promise<void>((resolve) => { continueResolve = resolve; });
			const writer = new ActionCacheStore(root, {
				indexMutationHooks: { afterRecordPublishBeforeIndex: async () => { publishedResolve(); await continueWrite; } },
			});
			const record = { ...seed, actionKey: (maintenance === "clear" ? "4" : "5").repeat(64), recipe: maintenance };
			const writePromise = writer.writeRecord(record);
			await published;
			const maintainer = new ActionCacheStore(root);
			let maintenanceFinished = false;
			const maintenancePromise = (maintenance === "clear"
				? maintainer.clear("all")
				: maintainer.prune({ apply: true, maxBytes: 0 }))
				.finally(() => { maintenanceFinished = true; });
			await new Promise((resolve) => setTimeout(resolve, 75));
			assert.equal(maintenanceFinished, false, `${maintenance} cannot pass an in-flight record/index transaction`);
			continueResolve();
			assert.deepEqual(await writePromise, { ok: true });
			await maintenancePromise;
			assert.deepEqual((await seedStore.readIndex()).entries, []);
			assert.deepEqual(await seedStore.readRecord(record.actionKey), { record: null, corrupt: false });
		});
	}
});

test("store: clear/prune report record deletion failure and retain index authority", async () => {
	for (const maintenance of ["clear", "prune"] as const) {
		await withTempDir(async (root) => {
			await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
			await run(root, fakeExec());
			const store = new ActionCacheStore(root);
			const index = await store.readIndex();
			const entry = index.entries[0]!;
			await rm(store.actionPath(entry.key));
			await mkdir(store.actionPath(entry.key));
			await writeFile(join(store.actionPath(entry.key), "blocking-child"), "x", "utf8");
			if (maintenance === "clear") {
				await assert.rejects(store.clear("all"), /could not remove every selected record/);
			} else {
				await assert.rejects(store.prune({ apply: true, maxBytes: 0 }), /could not remove every selected record/);
			}
			assert.equal((await store.readIndex()).entries.some((candidate) => candidate.key === entry.key), true);
		});
	}
});

test("store: stale-lock recovery never deletes an intervening fresh owner", async () => {
	await withTempDir(async (root) => {
		const bootId = "11111111-1111-4111-8111-111111111111";
		const processStartTicks = "200";
		const identityOptions = {
			isProcessAlive: (pid: number) => pid === process.pid,
			readBootId: async () => bootId,
			readProcessStartTicks: async (pid: number) => pid === process.pid ? processStartTicks : null,
		};
		const key = "9".repeat(64);
		const path = join(cacheDir(root), "locks", `${key}.lock`);
		await mkdir(join(cacheDir(root), "locks"), { recursive: true });
		await writeFile(path, JSON.stringify({ key, token: "stale", ownerPid: 999999, createdAt: new Date(Date.now() - 10_000).toISOString() }), "utf8");
		let replaced = false;
		let thirdOwnerAcquiredWhileFreshOwnerPresent = false;
		const store = new ActionCacheStore(root, {
			lockStaleMs: 10,
			lockWaitMs: 120,
			...identityOptions,
			afterStaleLockObserved: async () => {
				if (replaced) return;
				replaced = true;
				await rm(path, { force: true });
				await writeFile(path, JSON.stringify({
					key, token: "fresh", ownerPid: process.pid, bootId, processStartTicks, createdAt: new Date().toISOString(),
				}), "utf8");
				const third = await new ActionCacheStore(root, { lockWaitMs: 50, ...identityOptions }).acquireLock(key);
				thirdOwnerAcquiredWhileFreshOwnerPresent = third !== null;
				await third?.release();
			},
		});
		assert.equal(await store.acquireLock(key), null, "the intervening live owner remains authoritative");
		assert.equal(thirdOwnerAcquiredWhileFreshOwnerPresent, false, "a third contender never observes an acquisition gap");
		const persisted = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
		assert.equal(persisted.token, "fresh", "identity/token mismatch restores the captured replacement instead of deleting it");
	});
});

test("store: a post-execution persistence failure releases the live cache lock", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const base = fakeExec();
		const exec = (async (command: string, args: string[], options?: Parameters<ExecFn>[2]) => {
			const result = await base(command, args, options);
			if (command === "env" && args.includes("hello-cli")) {
				const runsRoot = join(root, CONFIG, "workbench", "runs");
				const staging = (await readdir(runsRoot)).find((name) => name.includes(".staging-"));
				assert.ok(staging, "the run transaction staging directory exists during execution");
				await rm(join(runsRoot, staging), { recursive: true, force: true });
			}
			return result;
		}) as ExecFn;

		await assert.rejects(run(root, exec), /ENOENT|no such file/i);
		assert.deepEqual(await readdir(join(cacheDir(root), "locks")), [], "finally releases the lock after the persistence exception");
	});
});

test("store: corrupted action JSON is a miss and is quarantined", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec);
		const store = new ActionCacheStore(root);
		const index = await store.readIndex();
		const key = index.entries[0]!.key;
		await writeFile(join(cacheDir(root), "actions", `${key}.json`), "{not-json", "utf8");
		const { record, corrupt } = await store.readRecord(key);
		assert.equal(record, null);
		assert.equal(corrupt, true);
		const quarantine = await readdir(join(cacheDir(root), "tmp"));
		assert.ok(quarantine.some((n) => n.startsWith("corrupt-")), "corrupt record quarantined");
		const outcome = await run(root, exec);
		assert.equal(outcome.cache?.status, "miss");
		assert.equal(exec.recipeCalls, 2, "corruption -> miss -> executes");
	});
});

test("store: valid JSON with a damaged required field becomes a miss and re-executes", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec);
		const store = new ActionCacheStore(root);
		const index = await store.readIndex();
		const key = index.entries[0]!.key;
		const path = store.actionPath(key);
		const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		record.toolchainVersions = null;
		await writeFile(path, JSON.stringify(record), "utf8");

		const result = await run(root, exec);
		assert.equal(result.cache?.status, "miss");
		assert.equal(exec.recipeCalls, 2, "damaged record is quarantined and the recipe executes normally");
		const quarantine = await readdir(join(cacheDir(root), "tmp"));
		assert.ok(quarantine.some((name) => name.startsWith("corrupt-")), "valid-JSON schema damage is quarantined");
	});
});

test("store: oversized and non-regular authority records are rejected before allocation", async () => {
	await withTempDir(async (root) => {
		const allocations: number[] = [];
		const reads: number[] = [];
		const store = new ActionCacheStore(root, {
			boundedReadHooks: {
				onBufferAllocate: (bytes) => allocations.push(bytes),
				beforeRead: (bytes) => reads.push(bytes),
			},
		});
		await mkdir(join(cacheDir(root), "actions"), { recursive: true });
		const oversizedKey = "b".repeat(64);
		const oversizedHandle = await open(store.actionPath(oversizedKey), "w");
		try { await oversizedHandle.truncate(ACTION_RECORD_MAX_BYTES + 1); }
		finally { await oversizedHandle.close(); }
		assert.deepEqual(await store.readRecord(oversizedKey), { record: null, corrupt: true });
		assert.deepEqual(allocations, [], "oversized action record is rejected before allocation");
		assert.deepEqual(reads, [], "oversized action record is rejected before read");

		const directoryKey = "c".repeat(64);
		await mkdir(store.actionPath(directoryKey));
		assert.deepEqual(await store.readRecord(directoryKey), { record: null, corrupt: true });
		assert.deepEqual(allocations, [], "non-regular action record is rejected before allocation");

		const symlinkKey = "f".repeat(64);
		const symlinkTarget = join(root, "outside-record.json");
		await writeFile(symlinkTarget, JSON.stringify({ actionKey: symlinkKey }), "utf8");
		const { symlink } = await import("node:fs/promises");
		await symlink(symlinkTarget, store.actionPath(symlinkKey));
		assert.deepEqual(await store.readRecord(symlinkKey), { record: null, corrupt: true });
		assert.deepEqual(allocations, [], "action-record symlinks are rejected without reading their targets");

		const indexHandle = await open(store.indexPath(), "w");
		try { await indexHandle.truncate(CACHE_INDEX_MAX_BYTES + 1); }
		finally { await indexHandle.close(); }
		const rebuilt = await store.readIndex();
		assert.deepEqual(rebuilt.entries, [], "oversized index fails closed to a bounded rebuild");
		assert.ok(allocations.every((bytes) => bytes <= LOCK_RECORD_MAX_BYTES), "oversized index itself is rejected before allocation; only bounded mutex/readback records allocate");

		await mkdir(join(cacheDir(root), "locks"), { recursive: true });
		const lockKey = "d".repeat(64);
		const lockHandle = await open(store.lockPath(lockKey), "w");
		try { await lockHandle.truncate(LOCK_RECORD_MAX_BYTES + 1); }
		finally { await lockHandle.close(); }
		assert.equal(await store.hasFreshLock(lockKey), true, "oversized lock fails closed as occupied and is never deleted");
		assert.ok(allocations.every((bytes) => bytes <= LOCK_RECORD_MAX_BYTES), "all index/lock verification allocations stay under the lock-record cap");
	});
});

test("store: index rebuild skips oversized action records without allocating them", async () => {
	await withTempDir(async (root) => {
		const allocations: number[] = [];
		const reads: number[] = [];
		const store = new ActionCacheStore(root, {
			boundedReadHooks: {
				onBufferAllocate: (bytes) => allocations.push(bytes),
				beforeRead: (bytes) => reads.push(bytes),
			},
		});
		await mkdir(join(cacheDir(root), "actions"), { recursive: true });
		const key = "e".repeat(64);
		const handle = await open(store.actionPath(key), "w");
		try { await handle.truncate(ACTION_RECORD_MAX_BYTES + 1); }
		finally { await handle.close(); }
		assert.deepEqual((await store.rebuildIndex()).entries, []);
		assert.ok(allocations.every((bytes) => bytes <= LOCK_RECORD_MAX_BYTES), "the oversized action record itself is never allocated");
		assert.ok(reads.every((bytes) => bytes <= LOCK_RECORD_MAX_BYTES), "only bounded index-lock/index verification reads occur");
	});
});

test("store: index rebuild refuses incomplete entry and total-byte scans", async () => {
	await withTempDir(async (root) => {
		const actions = join(cacheDir(root), "actions");
		await mkdir(actions, { recursive: true });
		await writeFile(join(actions, "foreign-a"), "x", "utf8");
		await writeFile(join(actions, "foreign-b"), "x", "utf8");
		const entryBounded = new ActionCacheStore(root, { indexRebuildMaxEntries: 1 });
		await assert.rejects(
			entryBounded.rebuildIndex(),
			(error: unknown) => error instanceof ActionCacheIndexRebuildError && /entry scan limit/.test(error.message),
			"an entry-overflow is an explicit refusal, never a truncated empty index",
		);

		await rm(actions, { recursive: true, force: true });
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec);
		const byteBounded = new ActionCacheStore(root, { indexRebuildMaxBytes: 1 });
		await assert.rejects(
			byteBounded.rebuildIndex(),
			(error: unknown) => error instanceof ActionCacheIndexRebuildError && /record scan limit/.test(error.message),
			"a byte-overflow is an explicit refusal, never a partial index",
		);
	});
});

test("store: index rebuild refuses an actions-directory symlink without following it", async () => {
	await withTempDir(async (root) => {
		const external = join(root, "external-actions");
		await mkdir(external, { recursive: true });
		await mkdir(cacheDir(root), { recursive: true });
		const { symlink } = await import("node:fs/promises");
		await symlink(external, join(cacheDir(root), "actions"));
		await assert.rejects(new ActionCacheStore(root).rebuildIndex(), /not a real directory/);
	});
});

test("store: corrupted index is rebuilt from actions/", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec);
		await writeFile(join(cacheDir(root), "cache-index.json"), "garbage[[[", "utf8");
		const store = new ActionCacheStore(root);
		const index = await store.readIndex();
		assert.equal(index.entries.length, 1, "index rebuilt from the actions directory");
		assert.equal(index.schemaVersion, 1);
	});
});

test("store: structurally valid JSON with unsafe index fields is rebuilt, never trusted", async () => {
	await withTempDir(async (root) => {
		await mkdir(cacheDir(root), { recursive: true });
		await writeFile(join(cacheDir(root), "cache-index.json"), JSON.stringify({
			schemaVersion: 1,
			entries: [{
				key: "a".repeat(64),
				recipe: "hello",
				createdAt: "2026-01-01T00:00:00.000Z",
				lastUsedAt: "2026-01-01T00:00:00.000Z",
				sizeBytes: Number.MAX_SAFE_INTEGER,
				success: true,
				mode: "result-only",
			}],
		}), "utf8");
		const index = await new ActionCacheStore(root).readIndex();
		assert.deepEqual(index.entries, [], "malicious size accounting cannot survive the strict parser");
	});
});

test("store: atomic write leaves no partial files", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec);
		const actions = await readdir(join(cacheDir(root), "actions"));
		assert.equal(actions.length, 1);
		assert.ok(actions[0]!.endsWith(".json"));
		const tmp = await readdir(join(cacheDir(root), "tmp"));
		assert.equal(tmp.filter((n) => n.endsWith(".tmp")).length, 0, "no leftover tmp files");
		// Record parses and matches its key.
		const store = new ActionCacheStore(root);
		const index = await store.readIndex();
		const { record } = await store.readRecord(index.entries[0]!.key);
		assert.ok(record);
		assert.equal(record.actionKey, index.entries[0]!.key);
	});
});

test("store: CAS read re-verifies the hash; mismatch -> quarantine + miss", async () => {
	await withTempDir(async (root) => {
		const store = new ActionCacheStore(root);
		const content = "artifact content v1";
		const { sha256Hex } = await import("../extensions/workbench-runtime/cache/canonical-hash.ts");
		const hash = sha256Hex(content);
		const stored = await store.storeCasArtifact(content, hash);
		assert.equal(stored.ok, true, "store under its content-derived name");
		// Corrupt the stored content in place.
		await writeFile(join(cacheDir(root), "cas", hash), "tampered content", "utf8");
		const read = await store.readCasArtifact(hash);
		assert.equal(read.ok, false);
		assert.equal(read.reason, "hash-mismatch");
		const quarantine = await readdir(join(cacheDir(root), "cas", "quarantine"));
		assert.ok(quarantine.length >= 1, "mismatched CAS content quarantined");
		const missing = await store.readCasArtifact("11".repeat(32));
		assert.equal(missing.reason, "missing");
	});
});

test("store: LRU prune dry-run reports reclaimable space without deleting", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const recipe2 = { name: "hello", description: "hello recipe", command: ["hello-cli", "run"], cwd: ".", timeout_ms: 60_000, allowed_modes: ["DEV", "VERIFY"], expected_exit_codes: [0], writes: [], artifacts: [], environment: [], output_strategy: "tail", max_lines: 100, max_bytes: 4096, cache: cacheYaml(["src/**/*.ts"]) };
		// Declare both recipes BEFORE any run: recipes.yaml content is part of
		// the relevant-workbench-config hash, so rewriting it later would
		// change hello's key.
		await writeConfigFile(root, "recipes.yaml", `recipes:\n${yamlInline(recipe2)}\n${yamlInline({ ...recipe2, name: "other" })}\n`);
		const exec = fakeExec();
		let current = Date.parse("2026-01-01T00:00:00Z");
		const now = () => new Date(current);
		await run(root, exec, { now });
		current += 1000;
		await run(root, exec, { now }); // hit: refreshes lastUsedAt for hello
		current += 2000;
		const other = await runRecipe({ projectRoot: root, recipeName: "other", params: {}, mode: "DEV", exec, now });
		assert.equal(other.cache?.status, "miss");
		current += 1000;
		await run(root, exec, { now }); // hit again: hello newest

		const store = new ActionCacheStore(root, { now });
		// Budget big enough for exactly one record: the other (older) must go.
		const index = await store.readIndex();
		const sizes = index.entries.map((e) => e.sizeBytes).sort((a, b) => b - a);
		const budget = sizes[0]! + 10;
		const dry = await store.prune({ apply: false, maxBytes: budget });
		assert.equal(dry.dryRun, true);
		assert.ok(dry.reclaimableBytes > 0);
		assert.equal(await countActionRecords(root), 2, "dry-run deletes nothing");

		const applied = await store.prune({ apply: true, maxBytes: budget });
		assert.equal(applied.dryRun, false);
		assert.ok(applied.removed.length >= 1);
		assert.equal(await countActionRecords(root), 2 - applied.removed.length);
		const after = await store.readIndex();
		assert.equal(after.entries.length, 2 - applied.removed.length);
		// Exactly one of the two records survives — the surviving one hits.
		const hitHello = await run(root, exec, { now });
		const hitOther = await runRecipe({ projectRoot: root, recipeName: "other", params: {}, mode: "DEV", exec, now });
		assert.equal([hitHello, hitOther].filter((r) => r.cache?.status === "hit").length, 1, "surviving record still hits");
	});
});

test("store: clear removes one recipe or all, never runs/", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec);
		const runsBefore = (await readdir(join(root, CONFIG, "workbench", "runs"))).length;
		const store = new ActionCacheStore(root);
		const cleared = await store.clear("hello");
		assert.equal(cleared.removed, 1);
		assert.equal(await countActionRecords(root), 0);
		const runsAfter = (await readdir(join(root, CONFIG, "workbench", "runs"))).length;
		assert.equal(runsAfter, runsBefore, "clearing never touches run history");
		// clear all (with a record present again)
		await run(root, exec);
		const clearedAll = await store.clear("all");
		assert.equal(clearedAll.removed, 1);
	});
});

test("store: cache dir layout matches the spec", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec);
		const entries = await readdir(cacheDir(root));
		// cas/ is created lazily on first CAS use (restore disabled in v1).
		for (const expected of ["actions", "locks", "tmp", "cache-index.json"]) {
			assert.ok(entries.includes(expected), `missing ${expected} in ${cacheDir(root)}: ${entries.join(", ")}`);
		}
		// The layout root matches <root>/<CONFIG_DIR_NAME>/workbench/cache.
		assert.ok(cacheDir(root).endsWith(join(".pi", "workbench", "cache")), "cache root under <root>/.pi/workbench/cache");
	});
});

test("hit: run history is preserved (hit adds a new run, never overwrites)", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		await run(root, exec);
		await run(root, exec);
		const runs = await readdir(join(root, CONFIG, "workbench", "runs"));
		assert.equal(runs.length, 2);
		const manifests = await Promise.all(runs.map((r) => readManifest(root, r)));
		const sources = manifests.map((m) => m?.execution_source).sort();
		assert.deepEqual(sources, ["cache", "exec"]);
	});
});

test("hit: expected-exit validation — cached run respects current recipe codes", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]), expected_exit_codes: [0] });
		const exec = fakeExec();
		await run(root, exec);
		// Same definition would need same expected codes; a record with an
		// unexpected exit code must be rejected by lookup validation.
		const store = new ActionCacheStore(root);
		const index = await store.readIndex();
		const { record } = await store.readRecord(index.entries[0]!.key);
		assert.ok(record);
		record.exitCode = 5;
		const actionsDir = join(cacheDir(root), "actions");
		await writeFile(join(actionsDir, `${record.actionKey}.json`), JSON.stringify(record), "utf8");
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "miss", "unexpected exit code -> miss, never a hit");
		assert.equal(exec.recipeCalls, 2);
	});
});

// ---------------------------------------------------------------------------
// P4a: validation evidence on exec + cache terminals (cache semantics unchanged)
// ---------------------------------------------------------------------------

test("P4a: exec and fast cache-hit runs persist matching bindings without changing cache semantics", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		const first = await run(root, exec);
		assert.equal(first.cache?.status, "miss");
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "hit");
		assert.equal(exec.recipeCalls, 1, "P4a evidence must not change P6-C execution counts");

		const m1 = await readManifest(root, first.record!.run_id);
		const m2 = await readManifest(root, second.record!.run_id);
		assert.deepEqual(m1?.validation_evidence, first.record?.validation_evidence, "returned == persisted (exec)");
		assert.deepEqual(m2?.validation_evidence, second.record?.validation_evidence, "returned == persisted (hit)");
		// Profile-less project: the returned binding omits the own profile
		// property exactly as the persisted JSON does — deep-equal above is
		// the exact-shape match, not an undefined-vs-absent normalization.
		assert.equal(Object.hasOwn(first.record!.validation_evidence!.binding!, "profile"), false, "returned exec binding has no own profile property");
		assert.equal(Object.hasOwn(second.record!.validation_evidence!.binding!, "profile"), false, "returned hit binding has no own profile property");
		assert.equal(Object.hasOwn(m1!.validation_evidence!.binding!, "profile"), false, "persisted exec binding has no own profile property");
		assert.equal(Object.hasOwn(m2!.validation_evidence!.binding!, "profile"), false, "persisted hit binding has no own profile property");
		const b1 = m1?.validation_evidence?.binding;
		const b2 = m2?.validation_evidence?.binding;
		assert.ok(b1 && b2, "both terminals persist a binding");
		assert.deepEqual(b1.outcome, { successful: true, complete: true, source: "exec" });
		assert.deepEqual(b2.outcome, { successful: true, complete: true, source: "cache" });
		assert.equal(b1.owner, "unknown", "fact-less callers bind owner=unknown");
		assert.equal(b2.owner, "unknown");
		if (b1.target.kind === "recipe" && b2.target.kind === "recipe") {
			assert.equal(b2.target.name, "hello");
			assert.equal(b2.target.invocation_hash, b1.target.invocation_hash, "same argv binds the same invocation hash across exec and cache");
			assert.equal(b2.target.invocation_hash, m2?.argv_hash, "cache binding uses the action-key argv hash");
			assert.equal(b2.target.definition_hash, b1.target.definition_hash, "same definition hash across terminals");
			assert.equal(b2.target.cwd, b1.target.cwd, "same normalized cwd across terminals");
		}
	});
});

test("P4a: concurrent locked/double-checked hit persists evidence on both terminals", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec({ delayMs: 150 });
		const [a, b] = await Promise.all([run(root, exec), run(root, exec)]);
		const miss = [a, b].find((r) => r.cache?.status === "miss");
		const hit = [a, b].find((r) => r.cache?.status === "hit");
		assert.ok(miss && hit, "exactly one exec + one double-checked hit");
		assert.equal(exec.recipeCalls, 1);
		const missManifest = await readManifest(root, miss.record!.run_id);
		const hitManifest = await readManifest(root, hit.record!.run_id);
		assert.equal(missManifest?.validation_evidence?.binding?.outcome.source, "exec");
		assert.equal(hitManifest?.validation_evidence?.binding?.outcome.source, "cache");
		assert.deepEqual(missManifest?.validation_evidence, miss.record?.validation_evidence);
		assert.deepEqual(hitManifest?.validation_evidence, hit.record?.validation_evidence);
	});
});

test("P4a: successOnly=false cannot turn an unsuccessful run into cache authority", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"], { successOnly: false }) });
		const exec = fakeExec({ recipeCode: 1 });
		const first = await run(root, exec);
		assert.equal(first.ok, false);
		assert.equal(first.cache?.status, "miss");
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "miss");
		assert.equal(second.ok, false);
		assert.equal(exec.recipeCalls, 2);
		assert.equal(await countActionRecords(root), 0);
		const manifest = await readManifest(root, second.record!.run_id);
		assert.deepEqual(manifest?.validation_evidence?.binding?.outcome, { successful: false, complete: true, source: "exec" });
	});
});

// ---------------------------------------------------------------------------
// P4b/P6-C separation: the registered workbench_read_run surface around the
// action-cache lifecycle (reads must never consult, alter or skip the cache)
// ---------------------------------------------------------------------------

/** Documented read_run summary caps (asserted against the actual output). */
const SUMMARY_MAX_BYTES = 4096;
const SUMMARY_MAX_LINES = 40;

/** GPT-5.6 Sol on an approved first-party provider (fresh-session actor). */
const SOL_MODEL = { provider: "openai-codex", id: "gpt-5.6-sol" };

interface StubAPI {
	commands: Map<string, unknown>;
	tools: Map<string, unknown>;
	events: Map<string, Array<(event: never, ctx: never) => unknown>>;
	entries: Array<{ type: string; customType: string; data?: unknown }>;
	messages: Array<{ customType: string; content: string; display: boolean; options?: unknown }>;
	activeTools: string[];
	appendEntryCalls: Array<{ customType: string; data: unknown }>;
}

/**
 * Same stub ExtensionAPI surface as tests/run-result-wiring.test.ts, with an
 * injectable exec so recipe executions stay observable through fakeExec.
 */
function makeStub(exec: ExecFn): StubAPI & ExtensionAPI {
	const stub: StubAPI & ExtensionAPI = {
		commands: new Map(),
		tools: new Map(),
		events: new Map(),
		entries: [],
		messages: [],
		activeTools: [],
		appendEntryCalls: [],
		registerCommand: (name: string, def: unknown) => {
			stub.commands.set(name, def);
		},
		registerTool: (def: { name: string }) => {
			stub.tools.set(def.name, def);
		},
		on: (event: string, handler: (event: never, ctx: never) => unknown) => {
			const list = stub.events.get(event) ?? [];
			list.push(handler);
			stub.events.set(event, list);
		},
		appendEntry: (customType: string, data: unknown) => {
			stub.entries.push({ type: "custom", customType, data });
			stub.appendEntryCalls.push({ customType, data });
		},
		sendMessage: (message: { customType: string; content: string; display: boolean }, options?: unknown) => {
			stub.messages.push({ ...message, options });
		},
		sendUserMessage: () => {},
		setActiveTools: (tools: string[]) => {
			stub.activeTools = [...tools];
		},
		getActiveTools: () => stub.activeTools,
		getAllTools: () => [...stub.tools.values()] as never[],
		getThinkingLevel: () => "high" as never,
		exec,
	} as unknown as StubAPI & ExtensionAPI;
	return stub;
}

/** Trusted temp-project ctx for model-tool execution (optional actor model). */
function trustedCtx(root: string, model?: { provider: string; id: string }): ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => `${root}/session.jsonl`,
			getSessionId: () => "p6-c-separation-test",
		} as unknown as ExtensionContext["sessionManager"],
		model,
		thinkingLevel: undefined,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => false,
		} as unknown as ExtensionContext["ui"],
		signal: undefined,
	} as unknown as ExtensionCommandContext;
}

/** Fire the registered session_start handler as fresh GPT-5.6 Sol. */
async function fireSolSession(stub: StubAPI & ExtensionAPI, root: string): Promise<void> {
	const handlers = stub.events.get("session_start") ?? [];
	assert.ok(handlers.length > 0, "session_start handler registered");
	for (const handler of handlers) {
		await handler({ type: "session_start", reason: "new" } as never, trustedCtx(root, SOL_MODEL) as never);
	}
}

interface RecipeTool {
	execute: (
		toolCallId: string,
		params: { recipe: string; params?: Record<string, unknown>; cache?: string },
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

interface ReadRunTool {
	execute: (
		toolCallId: string,
		params: { run_id: string; include?: string; max_lines?: number; max_bytes?: number },
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

interface ToolCacheDetails {
	status: string;
	actionKey?: string;
	reusedFromRunId?: string;
}

interface RecipeToolDetails {
	ok: boolean;
	status: string;
	exit_code: number | null;
	run_id: string;
	cache: ToolCacheDetails;
	/** Phase 2B: exact declared components / request mode from the run record. */
	validation_components?: string[];
	cache_request_mode?: string;
}

/** Text content of a tool result (the ACTUAL registered runtime output). */
function toolText(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((c) => c.text).join("\n");
}

/** Byte- AND line-aware assertion against the actual emitted text. */
function assertWithinCaps(text: string, maxBytes: number, maxLines: number): void {
	const bytes = new TextEncoder().encode(text).length;
	assert.ok(bytes <= maxBytes, `bytes ${bytes} > ${maxBytes}`);
	const lines = text.split("\n").length;
	assert.ok(lines <= maxLines, `lines ${lines} > ${maxLines}`);
}

interface CacheStoreSnapshot {
	/** Sorted relative paths of every cache-dir entry (files and dirs). */
	entries: string[];
	/** Relative path -> full file bytes. */
	files: Map<string, Buffer>;
}

/** Recursive byte + entry snapshot of the WHOLE action-cache store dir. */
async function snapshotCacheStore(root: string): Promise<CacheStoreSnapshot> {
	const entries: string[] = [];
	const files = new Map<string, Buffer>();
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const dirents = await readdir(dir, { withFileTypes: true }).catch(() => null);
		if (!dirents) return; // missing subtree = empty
		for (const entry of dirents) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full, rel);
			else files.set(rel, await readFile(full));
			entries.push(rel);
		}
	};
	await walk(cacheDir(root), "");
	entries.sort();
	return { entries, files };
}

/** Assert two cache-store snapshots are entry-for-entry and byte-for-byte equal. */
function assertStoreUnchanged(before: CacheStoreSnapshot, after: CacheStoreSnapshot, label: string): void {
	assert.deepEqual(after.entries, before.entries, `${label}: cache-store paths changed`);
	assert.deepEqual([...after.files.keys()], [...before.files.keys()], `${label}: cache-store file set changed`);
	for (const [rel, bytes] of before.files) {
		const now = after.files.get(rel);
		assert.ok(now, `${label}: cache-store file disappeared: ${rel}`);
		assert.deepEqual(now, bytes, `${label}: cache-store file changed: ${rel}`);
	}
}

/** The runs-record directory entries of a temp project. */
async function runsEntries(root: string): Promise<string[]> {
	try {
		return (await readdir(join(root, CONFIG, "workbench", "runs"))).filter((n) => !n.startsWith(".")).sort();
	} catch {
		return [];
	}
}

/** JSON-safe snapshot of the stub's session-visible state. */
function snapshotStubState(stub: StubAPI & ExtensionAPI): {
	entries: string;
	appendEntryCalls: string;
	messages: string;
	activeTools: string[];
} {
	return {
		entries: JSON.stringify(stub.entries),
		appendEntryCalls: JSON.stringify(stub.appendEntryCalls),
		messages: JSON.stringify(stub.messages),
		activeTools: [...stub.activeTools],
	};
}

test("P4b/P6-C separation: a registered read (REUSABLE in text+details) leaves the action key, cache-store bytes/paths, run history and execution counter unchanged — the next explicit default invocation still hits with the same key and adds a new run manifest", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "const a = 1;\n" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		const stub = makeStub(exec);
		workbenchRuntime(stub);
		await fireSolSession(stub, root);

		const recipeTool = stub.tools.get("workbench_run_recipe") as unknown as RecipeTool;
		assert.ok(recipeTool, "workbench_run_recipe registered");
		const readRun = stub.tools.get("workbench_read_run") as unknown as ReadRunTool;
		assert.ok(readRun, "workbench_read_run registered");

		// exactly ONE explicit default invocation: miss -> execute -> cache write
		const first = await recipeTool.execute("call-1", { recipe: "hello" }, undefined, undefined, trustedCtx(root) as never);
		const firstDetails = first.details as unknown as RecipeToolDetails;
		assert.equal(firstDetails.ok, true, toolText(first));
		assert.equal(firstDetails.cache.status, "miss", toolText(first));
		const actionKey = firstDetails.cache.actionKey;
		assert.ok(actionKey, "miss exposes the action key");
		assert.match(actionKey, /^[0-9a-f]{64}$/, "expected a 64-hex action key");
		const firstRunId = firstDetails.run_id;
		assert.equal(exec.recipeCalls, 1, "the explicit miss executed the recipe exactly once");

		// Phase 2B: the top-level tool details carry the exact record facts —
		// validation components and cache request mode equal the persisted manifest.
		const firstRecord = await readManifest(root, firstRunId);
		assert.ok(firstRecord, "exec run manifest exists");
		assert.deepEqual(firstDetails.validation_components, firstRecord.validation_components, "exec details == persisted components");
		assert.equal(firstDetails.cache_request_mode, firstRecord.cache_request_mode, "exec details == persisted request mode");

		// the persisted exec terminal carries a successful SOL binding whose
		// invocation identity agrees with the manifest argv_hash
		const persisted = JSON.parse(await readFile(join(root, CONFIG, "workbench", "runs", firstRunId, "manifest.json"), "utf8")) as {
			argv_hash?: string;
			validation_evidence?: {
				binding?: { owner?: string; outcome?: { successful?: boolean }; target?: { invocation_hash?: string } };
			};
		};
		assert.equal(persisted.validation_evidence?.binding?.owner, "sol");
		assert.equal(persisted.validation_evidence?.binding?.outcome?.successful, true);
		assert.equal(persisted.argv_hash, persisted.validation_evidence?.binding?.target?.invocation_hash);

		// snapshot the WHOLE cache store (entries + bytes), the runs dir, the
		// first run manifest, the action record and the stub session state
		const storeBefore = await snapshotCacheStore(root);
		const runsBefore = await runsEntries(root);
		const firstManifestBefore = await readFile(join(root, CONFIG, "workbench", "runs", firstRunId, "manifest.json"));
		const recordBefore = await readFile(join(cacheDir(root), "actions", `${actionKey}.json`));
		const stubBefore = snapshotStubState(stub);

		// registered read, default include: the ACTUAL rendered assessment
		const read1 = await readRun.execute("call-2", { run_id: firstRunId }, undefined, undefined, trustedCtx(root) as never);
		const text1 = toolText(read1);
		assert.ok(text1.split("\n").includes("validation : REUSABLE"), `exact REUSABLE line missing:\n${text1}`);
		assert.deepEqual(read1.details.validation, { status: "REUSABLE", reasons: [] }, "details.validation exact shape");
		assertWithinCaps(text1, SUMMARY_MAX_BYTES, SUMMARY_MAX_LINES);

		// registered read, include=all (bounded tails): the same verdict
		const read2 = await readRun.execute(
			"call-3",
			{ run_id: firstRunId, include: "all", max_lines: 40, max_bytes: 4096 },
			undefined,
			undefined,
			trustedCtx(root) as never,
		);
		const text2 = toolText(read2);
		assert.ok(text2.split("\n").includes("validation : REUSABLE"), text2);
		assert.deepEqual(read2.details.validation, { status: "REUSABLE", reasons: [] });

		// ---- the reads changed NOTHING: same key, same store bytes/paths, no
		// run record, no execution, no implicit session append ----
		assert.equal(exec.recipeCalls, 1, "reads never execute the recipe");
		assertStoreUnchanged(storeBefore, await snapshotCacheStore(root), "after the reads");
		assert.deepEqual(await readFile(join(cacheDir(root), "actions", `${actionKey}.json`)), recordBefore, "reads never touch the action record");
		assert.deepEqual(await runsEntries(root), runsBefore, "reads added no run record");
		assert.deepEqual(
			await readFile(join(root, CONFIG, "workbench", "runs", firstRunId, "manifest.json")),
			firstManifestBefore,
			"reads never rewrite the run manifest",
		);
		const stubAfterReads = snapshotStubState(stub);
		assert.equal(stubAfterReads.entries, stubBefore.entries, "reads appended no implicit session entries");
		assert.equal(stubAfterReads.appendEntryCalls, stubBefore.appendEntryCalls, "reads appended no implicit appendEntry calls");
		assert.equal(stubAfterReads.messages, stubBefore.messages, "reads sent no implicit messages");
		assert.deepEqual(stubAfterReads.activeTools, stubBefore.activeTools, "reads changed no tool set");

		// ---- the next explicit default invocation keeps normal cache semantics ----
		const second = await recipeTool.execute("call-4", { recipe: "hello" }, undefined, undefined, trustedCtx(root) as never);
		const secondDetails = second.details as unknown as RecipeToolDetails;
		assert.equal(secondDetails.ok, true, toolText(second));
		assert.equal(secondDetails.cache.status, "hit", "after the reads the same-input invocation still hits");
		assert.equal(secondDetails.cache.actionKey, actionKey, "same inputs -> same action key across the reads");
		assert.equal(secondDetails.cache.reusedFromRunId, firstRunId, "the hit reuses the original exec run");
		assert.equal(exec.recipeCalls, 1, "the hit does not re-execute the recipe");

		// Phase 2B: the cache-hit terminal agrees with its materialized manifest too.
		const hitRecord = await readManifest(root, secondDetails.run_id);
		assert.ok(hitRecord, "hit run manifest exists");
		assert.deepEqual(secondDetails.validation_components, hitRecord.validation_components, "hit details == persisted components");
		assert.equal(secondDetails.cache_request_mode, hitRecord.cache_request_mode, "hit details == persisted request mode");

		// run-record addition (explicit hit) vs cache-store state: the runs dir
		// grew by EXACTLY one manifest; the action record is untouched and the
		// only possible store change is the documented LRU index touch
		const runsAfterHit = await runsEntries(root);
		assert.equal(runsAfterHit.length, runsBefore.length + 1, "exactly one new run manifest from the explicit hit");
		assert.ok(runsAfterHit.includes(secondDetails.run_id), "the new run record is the hit's");
		const storeAfterHit = await snapshotCacheStore(root);
		assert.deepEqual(storeAfterHit.entries, storeBefore.entries, "cache-store paths unchanged by the hit");
		assert.equal(await countActionRecords(root), 1, "still exactly one action record");
		assert.deepEqual(await readFile(join(cacheDir(root), "actions", `${actionKey}.json`)), recordBefore, "the hit never rewrites the action record");
		for (const [rel, bytes] of storeBefore.files) {
			if (rel === "cache-index.json") continue; // LRU lastUsedAt touch only
			assert.deepEqual(storeAfterHit.files.get(rel), bytes, `store file changed by the hit: ${rel}`);
		}
		const indexBefore = JSON.parse(storeBefore.files.get("cache-index.json")!.toString("utf8")) as {
			entries: Array<{ key: string; createdAt: string; sizeBytes: number }>;
		};
		const indexAfter = JSON.parse(storeAfterHit.files.get("cache-index.json")!.toString("utf8")) as {
			entries: Array<{ key: string; createdAt: string; sizeBytes: number }>;
		};
		assert.equal(indexAfter.entries.length, 1, "index keeps exactly one entry");
		assert.equal(indexAfter.entries[0]!.key, indexBefore.entries[0]!.key, "index entry key unchanged");
		assert.equal(indexAfter.entries[0]!.createdAt, indexBefore.entries[0]!.createdAt, "index entry createdAt unchanged");
		assert.equal(indexAfter.entries[0]!.sizeBytes, indexBefore.entries[0]!.sizeBytes, "index entry size unchanged");

		// the hit materialized a REAL cache run record; prior history untouched
		const hitManifest = JSON.parse(await readFile(join(root, CONFIG, "workbench", "runs", secondDetails.run_id, "manifest.json"), "utf8")) as {
			execution_source?: string;
			action_key?: string;
			reused_from_run_id?: string;
		};
		assert.equal(hitManifest.execution_source, "cache");
		assert.equal(hitManifest.action_key, actionKey);
		assert.equal(hitManifest.reused_from_run_id, firstRunId);
		assert.deepEqual(
			await readFile(join(root, CONFIG, "workbench", "runs", firstRunId, "manifest.json")),
			firstManifestBefore,
			"prior run history is never overwritten",
		);

		// reads AFTER the explicit cache activity still render REUSABLE and
		// still change nothing — the assessment stays cache-independent both ways
		const read3 = await readRun.execute("call-5", { run_id: firstRunId }, undefined, undefined, trustedCtx(root) as never);
		assert.ok(toolText(read3).split("\n").includes("validation : REUSABLE"), toolText(read3));
		const read4 = await readRun.execute("call-6", { run_id: secondDetails.run_id }, undefined, undefined, trustedCtx(root) as never);
		assert.ok(toolText(read4).split("\n").includes("validation : REUSABLE"), toolText(read4));
		assert.deepEqual(read4.details.validation, { status: "REUSABLE", reasons: [] }, "the cached (hit) run also renders REUSABLE");
		assertStoreUnchanged(storeAfterHit, await snapshotCacheStore(root), "after the post-hit reads");
		assert.equal(exec.recipeCalls, 1, "reads after the hit still never execute");
	});
});

test("P4b/P6-C separation: a read can neither auto-execute nor auto-skip — an explicit --no-cache invocation after the read still executes and never reads or writes the store", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		const stub = makeStub(exec);
		workbenchRuntime(stub);
		await fireSolSession(stub, root);
		const recipeTool = stub.tools.get("workbench_run_recipe") as unknown as RecipeTool;
		const readRun = stub.tools.get("workbench_read_run") as unknown as ReadRunTool;
		assert.ok(recipeTool && readRun, "workbench_run_recipe and workbench_read_run registered");

		const first = await recipeTool.execute("call-1", { recipe: "hello" }, undefined, undefined, trustedCtx(root) as never);
		const firstDetails = first.details as unknown as RecipeToolDetails;
		assert.equal(firstDetails.cache.status, "miss", toolText(first));
		assert.equal(exec.recipeCalls, 1);
		const storeBefore = await snapshotCacheStore(root);
		const runsBefore = await runsEntries(root);

		// registered read
		const read1 = await readRun.execute("call-2", { run_id: firstDetails.run_id }, undefined, undefined, trustedCtx(root) as never);
		assert.ok(toolText(read1).split("\n").includes("validation : REUSABLE"), toolText(read1));
		assertStoreUnchanged(storeBefore, await snapshotCacheStore(root), "after the read");
		assert.deepEqual(await runsEntries(root), runsBefore, "the read added no run record");
		assert.equal(exec.recipeCalls, 1, "the read never executed the recipe");

		// explicit --no-cache after the read: still executes, never reads/writes
		const noCache = await recipeTool.execute("call-3", { recipe: "hello", cache: "no-cache" }, undefined, undefined, trustedCtx(root) as never);
		const noCacheDetails = noCache.details as unknown as RecipeToolDetails;
		assert.equal(noCacheDetails.ok, true, toolText(noCache));
		assert.equal(noCacheDetails.cache.status, "no-cache", toolText(noCache));
		assert.equal(exec.recipeCalls, 2, "no-cache after the read still executes — the read never auto-skipped it");
		assertStoreUnchanged(storeBefore, await snapshotCacheStore(root), "no-cache never reads or writes the store");
		assert.equal(await countActionRecords(root), 1, "no-cache added no action record");
		assert.equal((await runsEntries(root)).length, runsBefore.length + 1, "exactly one new run manifest from the explicit no-cache run");

		// the read afterwards still renders REUSABLE and still changes nothing
		const read2 = await readRun.execute("call-4", { run_id: firstDetails.run_id }, undefined, undefined, trustedCtx(root) as never);
		assert.ok(toolText(read2).split("\n").includes("validation : REUSABLE"), toolText(read2));
		assertStoreUnchanged(storeBefore, await snapshotCacheStore(root), "after the post-no-cache read");
		assert.equal(exec.recipeCalls, 2, "reads never execute the recipe");
	});
});

test("P4b/P6-C separation: a read never auto-executes — an explicit --refresh-cache invocation after the read still executes and replaces the record; the next default still hits", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"]) });
		const exec = fakeExec();
		const stub = makeStub(exec);
		workbenchRuntime(stub);
		await fireSolSession(stub, root);
		const recipeTool = stub.tools.get("workbench_run_recipe") as unknown as RecipeTool;
		const readRun = stub.tools.get("workbench_read_run") as unknown as ReadRunTool;
		assert.ok(recipeTool && readRun, "workbench_run_recipe and workbench_read_run registered");

		const first = await recipeTool.execute("call-1", { recipe: "hello" }, undefined, undefined, trustedCtx(root) as never);
		const firstDetails = first.details as unknown as RecipeToolDetails;
		assert.equal(firstDetails.cache.status, "miss", toolText(first));
		const actionKey = firstDetails.cache.actionKey;
		assert.ok(actionKey, "miss exposes the action key");
		assert.equal(exec.recipeCalls, 1);
		const storeBefore = await snapshotCacheStore(root);
		const runsBefore = await runsEntries(root);

		// registered read
		const read1 = await readRun.execute("call-2", { run_id: firstDetails.run_id }, undefined, undefined, trustedCtx(root) as never);
		assert.ok(toolText(read1).split("\n").includes("validation : REUSABLE"), toolText(read1));
		assertStoreUnchanged(storeBefore, await snapshotCacheStore(root), "after the read");
		assert.equal(exec.recipeCalls, 1, "the read never executed the recipe");

		// explicit --refresh-cache after the read: still executes and REPLACES
		const refresh = await recipeTool.execute("call-3", { recipe: "hello", cache: "refresh-cache" }, undefined, undefined, trustedCtx(root) as never);
		const refreshDetails = refresh.details as unknown as RecipeToolDetails;
		assert.equal(refreshDetails.cache.status, "refresh-executed", toolText(refresh));
		assert.equal(refreshDetails.cache.actionKey, actionKey, "refresh keeps the same action key");
		assert.equal(exec.recipeCalls, 2, "refresh after the read still executes — the read never auto-executed it");
		assert.equal(await countActionRecords(root), 1, "refresh replaces, never duplicates");
		assert.equal((await runsEntries(root)).length, runsBefore.length + 1, "exactly one new run manifest from the explicit refresh");
		const actionStore = new ActionCacheStore(root);
		const index = await actionStore.readIndex();
		assert.equal(index.entries.length, 1, "index keeps exactly one entry after the replacement");
		const { record } = await actionStore.readRecord(index.entries[0]!.key);
		assert.equal(record?.sourceRunId, refreshDetails.run_id, "the replaced record points at the refreshed run");

		// the read of the refreshed (exec) run stays REUSABLE and store-agnostic
		const storeAfterRefresh = await snapshotCacheStore(root);
		const read2 = await readRun.execute("call-4", { run_id: refreshDetails.run_id }, undefined, undefined, trustedCtx(root) as never);
		assert.ok(toolText(read2).split("\n").includes("validation : REUSABLE"), toolText(read2));
		assertStoreUnchanged(storeAfterRefresh, await snapshotCacheStore(root), "after the post-refresh read");

		// the next default invocation still hits with the same key
		const hit = await recipeTool.execute("call-5", { recipe: "hello" }, undefined, undefined, trustedCtx(root) as never);
		const hitDetails = hit.details as unknown as RecipeToolDetails;
		assert.equal(hitDetails.cache.status, "hit", toolText(hit));
		assert.equal(hitDetails.cache.actionKey, actionKey, "same action key after the refresh");
		assert.equal(exec.recipeCalls, 2, "the post-refresh hit does not re-execute");
		const storeAfterHit = await snapshotCacheStore(root);
		const read3 = await readRun.execute("call-6", { run_id: hitDetails.run_id }, undefined, undefined, trustedCtx(root) as never);
		assert.ok(toolText(read3).split("\n").includes("validation : REUSABLE"), toolText(read3));
		assertStoreUnchanged(storeAfterHit, await snapshotCacheStore(root), "after the post-hit read");
	});
});

test("P4b/P6-C separation: failed outcomes stay uncached and reads never change the next explicit execution", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"], { successOnly: false }) });
		const exec = fakeExec({ recipeCode: 1, recipeStdout: "boom" });
		const stub = makeStub(exec);
		workbenchRuntime(stub);
		await fireSolSession(stub, root);
		const recipeTool = stub.tools.get("workbench_run_recipe") as unknown as RecipeTool;
		const readRun = stub.tools.get("workbench_read_run") as unknown as ReadRunTool;
		assert.ok(recipeTool && readRun, "workbench_run_recipe and workbench_read_run registered");

		// Explicit failing invocation: miss, but never a cache write even when the
		// legacy declaration says successOnly=false.
		const first = await recipeTool.execute("call-1", { recipe: "hello" }, undefined, undefined, trustedCtx(root) as never);
		const firstDetails = first.details as unknown as RecipeToolDetails;
		assert.equal(firstDetails.status, "FAILED", toolText(first));
		assert.equal(firstDetails.exit_code, 1, toolText(first));
		assert.equal(firstDetails.cache.status, "miss", toolText(first));
		const actionKey = firstDetails.cache.actionKey;
		assert.ok(actionKey, "miss exposes the action key");
		assert.equal(exec.recipeCalls, 1);
		const storeBefore = await snapshotCacheStore(root);
		const runsBefore = await runsEntries(root);
		assert.equal(await countActionRecords(root), 0);

		// registered read of the FAILED exec run: status stays FAILED and the
		// exact fail-closed verdict renders through the registered surface
		const read1 = await readRun.execute("call-2", { run_id: firstDetails.run_id }, undefined, undefined, trustedCtx(root) as never);
		const text1 = toolText(read1);
		assert.ok(text1.split("\n").includes("status     : FAILED"), text1);
		assert.ok(
			text1.split("\n").includes("validation : RERUN_REQUIRED — unsuccessful-source"),
			`exact fail-closed line missing:\n${text1}`,
		);
		assert.deepEqual(
			read1.details.validation,
			{ status: "RERUN_REQUIRED", reasons: ["unsuccessful-source"] },
			"details.validation exact shape",
		);

		// the read changed nothing
		assertStoreUnchanged(storeBefore, await snapshotCacheStore(root), "after reading the failed run");
		assert.deepEqual(await runsEntries(root), runsBefore, "the read added no run record");
		assert.equal(exec.recipeCalls, 1, "the read never re-executed the failing recipe");

		// The next explicit invocation still executes and fails. The intervening
		// read neither created cache authority nor flipped the outcome.
		const second = await recipeTool.execute("call-3", { recipe: "hello" }, undefined, undefined, trustedCtx(root) as never);
		const secondDetails = second.details as unknown as RecipeToolDetails;
		assert.equal(secondDetails.cache.status, "miss", toolText(second));
		assert.equal(secondDetails.cache.actionKey, actionKey, "same action key for the repeated failed execution");
		assert.equal(secondDetails.status, "FAILED", "the fresh failed execution remains failed");
		assert.equal(secondDetails.exit_code, 1);
		assert.equal(exec.recipeCalls, 2, "failed runs are re-executed because no cache authority exists");
		assert.equal(await countActionRecords(root), 0);
		const storeAfterHit = await snapshotCacheStore(root);
		assert.deepEqual(storeAfterHit.entries, storeBefore.entries, "no cache record was created by the repeated failure");
		assert.equal((await runsEntries(root)).length, runsBefore.length + 1, "exactly one new run manifest from the explicit repeated execution");

		// Registered read of the second failed exec run: still FAILED and still
		// fail-closed as an unsuccessful source.
		const read2 = await readRun.execute("call-4", { run_id: secondDetails.run_id }, undefined, undefined, trustedCtx(root) as never);
		const text2 = toolText(read2);
		assert.ok(text2.split("\n").includes("status     : FAILED"), text2);
		assert.ok(text2.split("\n").includes("validation : RERUN_REQUIRED — unsuccessful-source"), text2);
		assert.deepEqual(read2.details.validation, { status: "RERUN_REQUIRED", reasons: ["unsuccessful-source"] });
		assertStoreUnchanged(storeAfterHit, await snapshotCacheStore(root), "after reading the repeated failed run");
		assert.equal(exec.recipeCalls, 2, "reads never executed anything");
	});
});
