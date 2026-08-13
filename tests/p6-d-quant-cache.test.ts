/**
 * P6-D quant cache integration tests — recipe cache `domain: quant` +
 * `quantContract`, immutable key binding, hit/miss lifecycle, corruption,
 * lineage, and Q Gate revalidation on cache hits.
 *
 * Coverage (P6-D spec §6/§7/§8/§10): manifest must exist, schema-invalid
 * refuses the cache, unresolved latest not cacheable, quant contract
 * change -> miss, result artifact corruption -> corrupt (never a hit),
 * warnings preserved, failed folds never filtered, walk-forward empty
 * folds never validated, upstream lineage (run + action key), cached Q
 * Gate revalidation.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { runRecipe, type RunRecipeResult } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import { runGates } from "../extensions/workbench-runtime/core/gate-engine.ts";
import { ActionCacheStore } from "../extensions/workbench-runtime/cache/action-store.ts";
import { computeKey, lookupValidated, planCache, type ActionCacheContext } from "../extensions/workbench-runtime/cache/action-cache.ts";
import { parseCachePolicy } from "../extensions/workbench-runtime/cache/action-types.ts";
import { parseQuantContractDecl } from "../extensions/workbench-runtime/cache/quant-contracts.ts";
import { validateQuantManifestCommand } from "../extensions/workbench-runtime/cache/quant-cache-validate.ts";
import { buildQuantLineage } from "../extensions/workbench-runtime/cache/quant-cache-lineage.ts";
import { readManifest } from "../extensions/workbench-runtime/core/runs.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { withTempDir, writeConfigFile } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "quant");

async function loadFixture(name: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;
}

interface FakeExecOptions {
	recipeCode?: number;
	recipeStdout?: string;
	recipeStderr?: string;
}

function fakeExec(options: FakeExecOptions = {}): ExecFn & { recipeCalls: number } {
	const state = { recipeCalls: 0 };
	const fn = (async (command: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
		if (command === "git") return { stdout: "", stderr: "", code: 0, killed: false };
		state.recipeCalls += 1;
		return {
			stdout: options.recipeStdout ?? "quant recipe ran\n",
			stderr: options.recipeStderr ?? "",
			code: options.recipeCode ?? 0,
			killed: false,
		};
	}) as ExecFn & { recipeCalls: number };
	Object.defineProperty(fn, "recipeCalls", { get: () => state.recipeCalls });
	return fn;
}

interface QuantRecipe {
	contractType: string;
	manifest: string;
	extra?: Record<string, unknown>;
}

async function makeProject(
	root: string,
	files: Record<string, string>,
	quant: QuantRecipe,
	recipeOverrides: Record<string, unknown> = {},
): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, content, "utf8");
	}
	const cache: Record<string, unknown> = {
		enabled: true,
		version: 1,
		domain: "quant",
		mode: "result-only",
		successOnly: true,
		inputs: ["artifacts/**/*.json"],
		outputs: [],
		environment: [],
		toolchain: [],
		maxAgeSeconds: null,
		quantContract: { type: quant.contractType, manifest: quant.manifest },
		...quant.extra,
	};
	const recipe = {
		name: "hello",
		description: "quant recipe",
		command: ["hello-cli", "run"],
		cwd: ".",
		timeout_ms: 60_000,
		allowed_modes: ["DEV", "VERIFY"],
		expected_exit_codes: [0],
		writes: [],
		artifacts: ["artifacts/**/*.json"],
		environment: [],
		output_strategy: "tail",
		max_lines: 100,
		max_bytes: 4096,
		cache,
		...recipeOverrides,
	};
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
		} else {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		}
	}
	await writeConfigFile(root, "recipes.yaml", `recipes:\n- ${lines[0] ?? "name: unnamed"}\n${lines.slice(1).map((l) => `  ${l}`).join("\n")}\n`);
}

async function writeManifest(root: string, rel: string, manifest: Record<string, unknown>): Promise<void> {
	const path = join(root, rel);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}

async function run(root: string, exec: ExecFn): Promise<RunRecipeResult> {
	return runRecipe({ projectRoot: root, recipeName: "hello", params: {}, mode: "DEV", exec });
}

/** Build the action-cache context the runner uses (test seam for lookup). */
async function cacheContextFor(root: string, exec: ExecFn): Promise<ActionCacheContext> {
	const { loadProjectConfig } = await import("../extensions/workbench-runtime/core/config.ts");
	const { EXTENSION_VERSION } = await import("../extensions/workbench-runtime/cache/cache-types.ts");
	const { buildArgv } = await import("../extensions/workbench-runtime/core/recipe-schema.ts");
	const config = await loadProjectConfig(root, { trusted: true });
	const recipe = config.recipes.find((r) => r.name === "hello");
	if (!recipe) throw new Error("recipe missing");
	return {
		projectRoot: root,
		recipe,
		policy: recipe.cache,
		argv: buildArgv(recipe, {}),
		mode: "DEV",
		profile: config.profile,
		projectGates: config.gates,
		packageVersion: EXTENSION_VERSION,
		exec,
		store: new ActionCacheStore(root),
		cacheMode: "default",
	};
}

function actionStore(root: string): ActionCacheStore {
	return new ActionCacheStore(root);
}

async function actionRecords(root: string): Promise<number> {
	const store = actionStore(root);
	const index = await store.readIndex();
	return index.entries.filter((e) => e.recipe === "hello").length;
}

// ---------------------------------------------------------------------------
// Cache policy parsing (quant domain)
// ---------------------------------------------------------------------------

test("policy: quant domain is opt-in and disabled by default", () => {
	const none = parseCachePolicy(undefined, ["hello-cli"], []);
	assert.equal(none.policy.enabled, false);
	assert.equal(none.policy.domain, "default");

	// domain: quant alone never enables.
	const quant = parseCachePolicy({ enabled: false, domain: "quant", quantContract: { type: "data-snapshot", manifest: "artifacts/data-snapshot.json" } }, ["hello-cli"], []);
	assert.equal(quant.policy.enabled, false);
	assert.equal(quant.policy.domain, "quant");

	// enabled + domain quant + contract -> on.
	const on = parseCachePolicy({ enabled: true, domain: "quant", quantContract: { type: "data-snapshot", manifest: "artifacts/data-snapshot.json" } }, ["hello-cli"], []);
	assert.equal(on.policy.enabled, true);
	assert.equal(on.policy.quantContract?.type, "data-snapshot");
});

test("policy: domain quant without quantContract disables caching with an issue", () => {
	const result = parseCachePolicy({ enabled: true, domain: "quant" }, ["hello-cli"], []);
	assert.equal(result.policy.enabled, false);
	assert.ok(result.issues.some((i) => i.includes("quantContract")));
});

test("policy: quantContract without domain quant disables caching with an issue", () => {
	const result = parseCachePolicy({ enabled: true, quantContract: { type: "data-snapshot", manifest: "artifacts/data-snapshot.json" } }, ["hello-cli"], []);
	assert.equal(result.policy.enabled, false);
	assert.ok(result.issues.some((i) => i.includes("domain: quant")));
});

test("policy: unknown contract types and unsafe manifest paths are rejected", () => {
	const bad = parseCachePolicy({ enabled: true, domain: "quant", quantContract: { type: "tick-replay", manifest: "x.json" } }, ["hello-cli"], []);
	assert.equal(bad.policy.enabled, false);
	const escape = parseCachePolicy({ enabled: true, domain: "quant", quantContract: { type: "data-snapshot", manifest: "../x.json" } }, ["hello-cli"], []);
	assert.equal(escape.policy.enabled, false);
	// parseQuantContractDecl directly.
	assert.equal(parseQuantContractDecl({ type: "lob", manifest: "x.json" }).decl, null);
	assert.equal(parseQuantContractDecl({ type: "data-snapshot", manifest: "../x.json" }).decl, null);
});

// ---------------------------------------------------------------------------
// Quant domain lifecycle
// ---------------------------------------------------------------------------

test("quant lifecycle: valid immutable manifest -> miss, write, then hit without executing", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, {}, { contractType: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("valid-data-snapshot"));
		const exec = fakeExec();

		const first = await run(root, exec);
		assert.equal(first.ok, true);
		assert.equal(exec.recipeCalls, 1);
		assert.equal(first.cache?.status, "miss");
		assert.ok(first.cache?.actionKey);
		assert.equal(await actionRecords(root), 1);

		const second = await run(root, exec);
		assert.equal(second.ok, true);
		assert.equal(exec.recipeCalls, 1, "second run must come from the cache");
		assert.equal(second.cache?.status, "hit");
		assert.equal(second.cache?.reusedFromRunId, first.record?.run_id);

		// The action record carries the quant contract facts.
		const record = (await actionStore(root).readRecord(second.cache?.actionKey ?? "")).record;
		assert.ok(record);
		assert.equal(record?.quantContractKey?.startsWith("quant:data-snapshot:2026-08-01-eod-v3:r3:"), true);
		assert.equal(record?.quantContractInfo?.type, "data-snapshot");
		assert.equal(record?.quantContractInfo?.validationStatus, "validated");
	});
});

test("quant lifecycle: manifest must exist — missing manifest refuses the cache", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, {}, { contractType: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		const exec = fakeExec();
		const result = await run(root, exec);
		assert.equal(result.ok, true, "normal execution proceeds");
		assert.equal(exec.recipeCalls, 1);
		assert.equal(result.cache?.status, "refused");
		assert.match(result.cache?.reason ?? "", /manifest file is unavailable/);
		assert.equal(await actionRecords(root), 0, "nothing cached");
	});
});

test("quant lifecycle: schema-invalid manifest refuses the cache", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, {}, { contractType: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		await writeManifest(root, "artifacts/data-snapshot.json", { schemaVersion: 1, contractType: "data-snapshot", snapshotId: "x" });
		const exec = fakeExec();
		const result = await run(root, exec);
		assert.equal(result.ok, true);
		assert.equal(result.cache?.status, "refused");
		assert.equal(await actionRecords(root), 0);
	});
});

test("quant lifecycle: unresolved latest refuses the cache (no registry)", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, {}, { contractType: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("invalid-latest-snapshot"));
		const exec = fakeExec();
		const result = await run(root, exec);
		assert.equal(result.ok, true);
		assert.equal(result.cache?.status, "refused");
		assert.match(result.cache?.reason ?? "", /could not be resolved/);
		assert.equal(await actionRecords(root), 0);
	});
});

test("quant lifecycle: logical latest resolves to an immutable revision and caches", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, {}, { contractType: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("invalid-latest-snapshot"));
		await writeManifest(root, "artifacts/data-snapshot-2026-08-01.json", await loadFixture("valid-data-snapshot"));
		const exec = fakeExec();
		const first = await run(root, exec);
		assert.equal(first.cache?.status, "miss", "resolved -> cacheable");
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "hit");
		const record = (await actionStore(root).readRecord(second.cache?.actionKey ?? "")).record;
		assert.equal(record?.quantContractInfo?.logicalReference, "latest");
		assert.match(record?.quantContractInfo?.resolvedReference ?? "", /^quant:data-snapshot:2026-08-01-eod-v3:r3:/);
	});
});

test("quant lifecycle: manifest content change -> different key -> miss", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, {}, { contractType: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("valid-data-snapshot"));
		const exec = fakeExec();
		const first = await run(root, exec);
		assert.equal(first.cache?.status, "miss");
		assert.equal(await actionRecords(root), 1);

		const changed = await loadFixture("valid-data-snapshot");
		changed.providerRevision = "r4";
		await writeManifest(root, "artifacts/data-snapshot.json", changed);
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "miss", "provider revision change must invalidate");
		assert.notEqual(second.cache?.actionKey, first.cache?.actionKey);
		assert.equal(exec.recipeCalls, 2);
		assert.equal(await actionRecords(root), 2);
	});
});

test("quant lifecycle: result artifact corruption on a hit is CORRUPT and re-executes", async () => {
	await withTempDir(async (root) => {
		const manifest = await loadFixture("valid-stock-selection-backtest");
		// Write the result artifact with the hash the fixture declares... the
		// fixture's resultArtifactHash is a placeholder, so first fix it.
		const artifactContent = '{"schema_version":"1.0","metrics":{"return":0.01}}\n';
		const { sha256HexBytes } = await import("../extensions/workbench-runtime/cache/canonical-hash.ts");
		manifest.resultArtifactHash = sha256HexBytes(Buffer.from(artifactContent, "utf8"));
		await makeProject(root, {}, { contractType: "backtest-result", manifest: "artifacts/backtest-result.json" });
		await writeManifest(root, "artifacts/backtest-result.json", manifest);
		await mkdir(join(root, "results"), { recursive: true });
		await writeFile(join(root, "results", "quant-result.json"), artifactContent, "utf8");

		const exec = fakeExec();
		const first = await run(root, exec);
		assert.equal(first.cache?.status, "miss");
		assert.equal(exec.recipeCalls, 1);

		// First hit verifies the artifact hash.
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "hit");
		assert.equal(exec.recipeCalls, 1);

		// Corrupt the result artifact: the declared hash no longer matches.
		await writeFile(join(root, "results", "quant-result.json"), '{"schema_version":"1.0","metrics":{"return":0.99}}\n', "utf8");

		// The lookup itself classifies the mismatch as CORRUPTION.
		const ctx = await cacheContextFor(root, exec);
		const computed = await computeKey(ctx);
		assert.ok(computed.ok);
		const outcome = await lookupValidated(ctx, computed.key);
		assert.equal(outcome.status, "corrupt", "hash mismatch is corruption, never a silent hit");

		// The run degrades to execution (never a silent hit) and re-writes.
		const third = await run(root, exec);
		assert.notEqual(third.cache?.status, "hit");
		assert.equal(exec.recipeCalls, 2, "corruption falls back to execution");
		assert.equal(third.ok, true);
	});
});

test("quant lifecycle: manifest warnings are preserved verbatim in the action record", async () => {
	await withTempDir(async (root) => {
		const manifest = await loadFixture("failed-fold-retained");
		await makeProject(root, {}, { contractType: "backtest-result", manifest: "artifacts/backtest-result.json" });
		await writeManifest(root, "artifacts/backtest-result.json", manifest);
		const artifactContent = '{"schema_version":"1.0"}\n';
		const { sha256HexBytes } = await import("../extensions/workbench-runtime/cache/canonical-hash.ts");
		manifest.resultArtifactHash = sha256HexBytes(Buffer.from(artifactContent, "utf8"));
		await writeManifest(root, "artifacts/backtest-result.json", manifest);
		await mkdir(join(root, "results"), { recursive: true });
		await writeFile(join(root, "results", "quant-result.json"), artifactContent, "utf8");

		const exec = fakeExec();
		const result = await run(root, exec);
		assert.equal(result.cache?.status, "miss");
		const record = (await actionStore(root).readRecord(result.cache?.actionKey ?? "")).record;
		assert.ok(record?.quantContractInfo);
		assert.deepEqual(record?.quantContractInfo.warnings, manifest.warnings);
		assert.ok(record?.quantContractInfo.warnings.some((w) => w.includes("failed")));
	});
});

test("quant lifecycle: failed folds are never filtered and never block caching", async () => {
	await withTempDir(async (root) => {
		const manifest = await loadFixture("failed-fold-retained");
		const artifactContent = '{"schema_version":"1.0"}\n';
		const { sha256HexBytes } = await import("../extensions/workbench-runtime/cache/canonical-hash.ts");
		manifest.resultArtifactHash = sha256HexBytes(Buffer.from(artifactContent, "utf8"));
		await makeProject(root, {}, { contractType: "backtest-result", manifest: "artifacts/backtest-result.json" });
		await writeManifest(root, "artifacts/backtest-result.json", manifest);
		await mkdir(join(root, "results"), { recursive: true });
		await writeFile(join(root, "results", "quant-result.json"), artifactContent, "utf8");
		const exec = fakeExec();
		const first = await run(root, exec);
		assert.equal(first.cache?.status, "miss");
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "hit", "failed folds retained and reported are cacheable");
	});
});

test("quant lifecycle: walk-forward declared with empty folds is never validated -> refused", async () => {
	await withTempDir(async (root) => {
		const manifest = await loadFixture("valid-stock-selection-backtest");
		manifest.foldArtifacts = [];
		await makeProject(root, {}, { contractType: "backtest-result", manifest: "artifacts/backtest-result.json" });
		await writeManifest(root, "artifacts/backtest-result.json", manifest);
		const exec = fakeExec();
		const result = await run(root, exec);
		assert.equal(result.ok, true);
		assert.equal(result.cache?.status, "refused");
		assert.equal(await actionRecords(root), 0);
	});
});

test("quant lifecycle: recipe inputs still fingerprint the key (inputs + quant contract)", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, { "src/a.ts": "const a = 1;\n" }, { contractType: "data-snapshot", manifest: "artifacts/data-snapshot.json", extra: { inputs: ["src/**/*.ts"] } });
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("valid-data-snapshot"));
		const exec = fakeExec();
		await run(root, exec);
		await writeFile(join(root, "src", "a.ts"), "const a = 2;\n", "utf8");
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "miss", "input change still invalidates even with a valid quant contract");
		assert.equal(exec.recipeCalls, 2);
	});
});

// ---------------------------------------------------------------------------
// /q-cache-validate command
// ---------------------------------------------------------------------------

test("q-cache-validate: immutable valid manifest report", async () => {
	await withTempDir(async (root) => {
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("valid-data-snapshot"));
		const report = await validateQuantManifestCommand(root, "artifacts/data-snapshot.json");
		assert.equal(report.ok, true);
		assert.equal(report.contractType, "data-snapshot");
		assert.equal(report.schemaVersion, 1);
		assert.equal(report.immutable, true);
		assert.equal(report.mutableId, false);
		assert.ok(report.contentHash);
		assert.match(report.upstreamKey ?? "", /^quant:data-snapshot:2026-08-01-eod-v3:r3:/);
		assert.deepEqual(report.missingFields, []);
		assert.equal(report.validationStatus, "validated");
		assert.equal(report.cacheEligible, true);
		assert.deepEqual(report.qGateImplications.map((g) => g.gate), ["q1"]);
	});
});

test("q-cache-validate: mutable latest report + resolution attempt", async () => {
	await withTempDir(async (root) => {
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("invalid-latest-snapshot"));
		await writeManifest(root, "artifacts/data-snapshot-2026-08-01.json", await loadFixture("valid-data-snapshot"));
		const report = await validateQuantManifestCommand(root, "artifacts/data-snapshot.json");
		assert.equal(report.ok, true);
		assert.equal(report.mutableId, true);
		assert.equal(report.cacheEligible, false);
		assert.equal(report.resolution?.attempted, true);
		assert.equal(report.resolution?.ok, true, "registry contains an immutable revision");
		assert.equal(report.resolution?.resolved?.manifest.snapshotId, "2026-08-01-eod-v3");
	});
});

test("q-cache-validate: missing manifest errors cleanly", async () => {
	await withTempDir(async (root) => {
		const report = await validateQuantManifestCommand(root, "artifacts/never.json");
		assert.equal(report.ok, false);
		assert.match(report.error ?? "", /manifest file is unavailable/);
	});
});

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

test("q-cache-lineage: run with all three contracts links upstream relationships", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, {}, { contractType: "backtest-result", manifest: "artifacts/backtest-result.json" });
		const backtest = await loadFixture("valid-stock-selection-backtest");
		const artifactContent = '{"schema_version":"1.0"}\n';
		const { sha256HexBytes } = await import("../extensions/workbench-runtime/cache/canonical-hash.ts");
		backtest.resultArtifactHash = sha256HexBytes(Buffer.from(artifactContent, "utf8"));
		await writeManifest(root, "artifacts/backtest-result.json", backtest);
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("valid-data-snapshot"));
		await writeManifest(root, "artifacts/feature-set.json", await loadFixture("valid-stock-selection-feature-set"));
		await mkdir(join(root, "results"), { recursive: true });
		await writeFile(join(root, "results", "quant-result.json"), artifactContent, "utf8");

		const exec = fakeExec();
		const result = await run(root, exec);
		assert.ok(result.record?.run_id);

		const lineage = await buildQuantLineage(root, result.record.run_id);
		assert.equal(lineage.ok, true);
		assert.equal(lineage.kind, "run");
		assert.equal(lineage.runId, result.record.run_id);
		// All three contracts discovered from the run's artifacts.
		const types = lineage.quantContracts.map((n) => n.type).sort();
		assert.deepEqual(types, ["backtest-result", "data-snapshot", "feature-set"]);
		// The backtest-result node reports the artifact hash verification.
		const bt = lineage.quantContracts.find((n) => n.type === "backtest-result");
		assert.equal(bt?.resultArtifact?.verified, true);
		assert.ok(lineage.upstreamRelationships.length >= 3, "snapshot/feature/universe relationships");
		assert.ok(lineage.upstreamRelationships.some((r) => r.includes("dataSnapshotKey")));
	});
});

test("q-cache-lineage: action key target shows the record and its source run", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, {}, { contractType: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("valid-data-snapshot"));
		const exec = fakeExec();
		const result = await run(root, exec);
		assert.ok(result.cache?.actionKey);

		const lineage = await buildQuantLineage(root, result.cache.actionKey);
		assert.equal(lineage.ok, true);
		assert.equal(lineage.kind, "action-key");
		assert.equal(lineage.runId, result.record?.run_id);
		assert.equal(lineage.recipe, "hello");

		// An unknown key reports an invalidation reason instead of failing.
		const unknown = await buildQuantLineage(root, "f".repeat(64));
		assert.equal(unknown.ok, true);
		assert.match(unknown.invalidationReason ?? "", /no action record/);
	});
});

test("q-cache-lineage: a cached run points at its reused source run", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, {}, { contractType: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("valid-data-snapshot"));
		const exec = fakeExec();
		const first = await run(root, exec);
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "hit");
		assert.ok(second.record?.run_id);

		const lineage = await buildQuantLineage(root, second.record.run_id);
		assert.equal(lineage.executionSource, "cache");
		assert.equal(lineage.reusedFromRunId, first.record?.run_id);
		assert.ok(lineage.quantContracts.some((n) => n.type === "data-snapshot"));
	});
});

// ---------------------------------------------------------------------------
// Cached Q Gate revalidation
// ---------------------------------------------------------------------------

test("cached Q Gate revalidation: a hit still re-validates quant contract schema checks", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, {}, { contractType: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("valid-data-snapshot"));
		await writeConfigFile(
			root,
			"gates.yaml",
			[
				"gates:",
				"  - id: g1",
				"    title: Quant manifest schema",
				"    checks:",
				"      - { id: g1.1, title: Snapshot schema, kind: schema, file: artifacts/data-snapshot.json, schema: data-snapshot }",
				"      - { id: g1.2, title: Feature schema, kind: schema, file: artifacts/feature-set.json, schema: feature-set }",
			].join("\n"),
		);
		// A valid feature-set manifest (so the gate can pass).
		await writeManifest(root, "artifacts/feature-set.json", await loadFixture("valid-stock-selection-feature-set"));
		const exec = fakeExec();

		// Cache the run.
		const first = await run(root, exec);
		assert.equal(first.cache?.status, "miss");

		// Gate run BEFORE the hit: schema checks pass.
		const gatesBefore = await runGates({ projectRoot: root, selector: "g1", mode: "DEV", exec });
		assert.equal(gatesBefore.status, "PASS");

		// Second recipe run is a cache hit — gates are NOT bypassed.
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "hit");
		assert.equal(exec.recipeCalls, 1);

		const gatesAfter = await runGates({ projectRoot: root, selector: "g1", mode: "DEV", exec });
		assert.equal(gatesAfter.status, "PASS", "gates re-validate after the cache hit");
		const schemaCheck = gatesAfter.gates[0]?.checks.find((c) => c.check_id === "g1.1");
		assert.equal(schemaCheck?.status, "PASS");
		assert.ok(schemaCheck?.evidence.some((e) => e.type === "schema"));
		const schemaEvidence = schemaCheck?.evidence.find((e) => e.type === "schema");
		assert.match(schemaEvidence?.detail ?? "", /validated/);

		// Breaking the manifest invalidates the gate AND the cache key.
		const broken = await loadFixture("valid-data-snapshot");
		broken.adjustmentPolicy = undefined;
		delete broken.adjustmentPolicy;
		await writeManifest(root, "artifacts/data-snapshot.json", broken);
		const gatesBroken = await runGates({ projectRoot: root, selector: "g1", mode: "DEV", exec });
		assert.equal(gatesBroken.status, "FAIL", "semantic requirements missing -> not validated -> gate fails");
		const third = await run(root, exec);
		assert.notEqual(third.cache?.status, "hit", "manifest change -> key change -> miss");
	});
});

test("cached run record still re-validates through the full gate ladder status model", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, {}, { contractType: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("invalid-latest-snapshot"));
		await writeConfigFile(
			root,
			"gates.yaml",
			["gates:", "  - id: g1", "    title: Mutable snapshot", "    checks:", "      - { id: g1.1, title: Must be immutable, kind: schema, file: artifacts/data-snapshot.json, schema: data-snapshot }"].join("\n"),
		);
		const exec = fakeExec();
		// Cache is refused for the mutable manifest; the run executes.
		const result = await run(root, exec);
		assert.equal(result.cache?.status, "refused");
		const gates = await runGates({ projectRoot: root, selector: "g1", mode: "DEV", exec });
		assert.equal(gates.status, "FAIL", "a mutable id can never pass a quant contract schema gate");
		const check = gates.gates[0]?.checks[0];
		assert.match(check?.failure_reason ?? "", /data-snapshot contract/);
	});
});

test("gate schema: unknown schema names are setup errors", async () => {
	await withTempDir(async (root) => {
		await writeConfigFile(
			root,
			"gates.yaml",
			["gates:", "  - id: g1", "    title: Bad schema", "    checks:", "      - { id: g1.1, title: X, kind: schema, file: a.json, schema: hft-replay }"].join("\n"),
		);
		const exec = fakeExec();
		await assert.rejects(runGates({ projectRoot: root, selector: "g1", mode: "DEV", exec }), /unknown built-in schema/);
	});
});

test("cache hit run manifest records execution_source=cache and quant action key", async () => {
	await withTempDir(async (root) => {
		await makeProject(root, {}, { contractType: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		await writeManifest(root, "artifacts/data-snapshot.json", await loadFixture("valid-data-snapshot"));
		const exec = fakeExec();
		const first = await run(root, exec);
		const second = await run(root, exec);
		assert.equal(second.cache?.status, "hit");
		const manifest = await readManifest(root, second.record?.run_id ?? "");
		assert.equal(manifest?.execution_source, "cache");
		assert.ok(manifest?.action_key);
		assert.ok(manifest?.reused_from_run_id);
		// P6-D: cached quant runs carry the contract facts on the manifest.
		assert.equal(manifest?.quant_contract?.type, "data-snapshot");
		assert.match(manifest?.quant_contract?.immutable_key ?? "", /^quant:data-snapshot:2026-08-01-eod-v3:r3:/);
		assert.equal(manifest?.quant_contract?.validation_status, "validated");
	});
});
