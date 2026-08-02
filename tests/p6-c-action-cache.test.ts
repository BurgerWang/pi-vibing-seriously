/**
 * P6-C action cache integration tests — store + recipe-runner lifecycle.
 *
 * Coverage (P6-C spec §7/§9/§11/§12): same-input hit, content-change miss,
 * recipe-definition miss, argv miss, success cached / failure not cached,
 * no-cache, refresh-cache, maxAge expiry, concurrent same key, stale lock,
 * corrupted action JSON, corrupted CAS, atomic writes, LRU dry-run/apply,
 * new run manifest on hit, gate evidence on hit, cache failure falls back
 * to execution, cache dir layout, secret-free records.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { runRecipe, type RunRecipeResult } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import { runGates } from "../extensions/workbench-runtime/core/gate-engine.ts";
import { ActionCacheStore } from "../extensions/workbench-runtime/cache/action-store.ts";
import { readManifest } from "../extensions/workbench-runtime/core/runs.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { withTempDir, writeConfigFile } from "./helpers.ts";

const CONFIG = ".pi";

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
	});
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

test("lifecycle: failure is NOT cached by default; explicit successOnly=false caches it", async () => {
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

		// Explicit successOnly=false caches failures too.
		await makeProject(root, { "src/a.ts": "x" }, { cache: cacheYaml(["src/**/*.ts"], { successOnly: false }) });
		const third = await run(root, exec);
		assert.equal(third.ok, false);
		assert.equal(third.cache?.status, "miss");
		assert.equal(await countActionRecords(root), 1);
		const fourth = await run(root, exec);
		assert.equal(fourth.cache?.status, "hit");
		assert.equal(fourth.ok, false, "cached failure reproduces the failure");
		assert.equal(exec.recipeCalls, 3);
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
		const second = await run(root, exec, { cacheMode: "no-cache" });
		assert.equal(second.cache?.status, "no-cache");
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
