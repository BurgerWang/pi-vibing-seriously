/**
 * Execution-efficiency wiring tests (Phase 1 + Phase 2).
 *
 * Rebuilt from scratch after delegation 20260808-100746-bwwc left this file
 * truncated to 0 bytes. Coverage:
 *
 * Phase 1 (cache closure + stability + invalidation):
 *   - the real `typecheck` recipe (parsed from .pi/workbench/recipes.yaml)
 *     declares EXACTLY the five tsc-relevant cache inputs (package.json,
 *     package-lock.json, tsconfig.json, extensions/**\/*.ts, tests/**\/*.ts)
 *     with all safety fields (result-only, successOnly, empty outputs/env,
 *     node/npm toolchain, null maxAge) and no source-mutating recipe fields;
 *   - a real-repository fingerprint is deterministic and excludes
 *     docs/assets/README/skills/prompts/templates/tools/compatibility;
 *   - the real release-assets package script and recipe declare the exact
 *     asset closure (package/lock/tsconfig, the test file, LICENSE, README,
 *     banner, generator, cache-types);
 *   - the REAL typecheck action key (stable fake tool-version exec) is not
 *     invalidated by docs/assets/README edits or added unrelated docs, and
 *     IS invalidated by extension TS, package.json and node version changes.
 *
 * Phase 2 (check composition + runtime-core wiring):
 *   - package.json `check` script string exact;
 *   - `check` recipe argv exact, intentionally UNCACHED, components exactly
 *     [typecheck, unit-test, whitespace];
 *   - components wiring: typecheck [typecheck], unit-test [unit-test],
 *     release-assets-test [];
 *   - package.json `test:runtime-core` is exactly the seven-file script;
 *   - `runtime-core-test` recipe: exact argv/cwd/params/env/mutation/writes/
 *     artifacts/modes/exits, components [], cache v1 result-only successOnly
 *     with empty outputs/env, node/npm toolchain, null maxAge and the exact
 *     ordered 13 inputs.
 *
 * Phase 3 (dev-only feedback recipes + gate preflight wiring):
 *   - package.json `test:gate-preflight` is exactly the three Phase 3 test
 *     files (gates, p4-render, result-summary wiring);
 *   - `typecheck-feedback` recipe: exact argv/cwd/params/env/mutation/
 *     writes/artifacts/modes/exits, INTENTIONALLY UNCACHED (no cache
 *     block), no validation component — dev-only self-hosting feedback;
 *   - `gate-preflight-test` recipe: exact argv/cwd/params/env/mutation/
 *     writes/artifacts/modes/exits, no validation component, cache v1
 *     result-only successOnly with empty outputs/env, node/npm toolchain,
 *     null maxAge and the exact ordered 10-input closure;
 *   - both feedback recipes are explicitly dev-only feedback with empty
 *     validation components and never join the check aggregate.
 *
 * Phase 4 (worker-efficiency feedback wiring):
 *   - package.json `test:worker-efficiency` is exactly the four worker
 *     test files (worker-policy, worker-runner, delegation-ledger,
 *     p6-b-stable-prefix);
 *   - `worker-efficiency-test` recipe: exact argv/cwd/params/env/mutation/
 *     writes/artifacts/modes/exits/tail, no validation component, cache v1
 *     result-only successOnly with empty outputs/env, node/npm toolchain,
 *     null maxAge and the exact ordered 11-input closure (including
 *     docs/worker-delegation.md);
 *   - the recipe is explicitly dev-only feedback and never joins the check
 *     aggregate.
 *
 * Phase 5 (diff-review-efficiency feedback wiring):
 *   - package.json `test:diff-review-efficiency` is exactly the two
 *     diff-review test files (tests/diff-review.test.ts and
 *     tests/diff-review-wiring.test.ts);
 *   - `diff-review-efficiency-test` recipe: exact argv/cwd/params/env/
 *     mutation/writes/artifacts/modes/exits/tail, no validation component,
 *     cache v1 result-only successOnly with empty outputs/env, node/npm
 *     toolchain, null maxAge and the exact ordered 8-input closure;
 *   - the recipe is explicitly dev-only feedback and never joins the check
 *     aggregate.
 *
 * Determinism: the tests parse real package.json/recipes.yaml and fingerprint
 * real files (read-only), but execute NO project recipe, benchmark collector,
 * analyzer or network call — toolchain probing uses a fake exec.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { fingerprintInputs } from "../extensions/workbench-runtime/cache/action-fingerprint.ts";
import { computeActionKey } from "../extensions/workbench-runtime/cache/action-key.ts";
import { DEFAULT_CACHE_POLICY } from "../extensions/workbench-runtime/cache/action-types.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { parseRecipesDocument, type Recipe } from "../extensions/workbench-runtime/core/recipe-schema.ts";
import { withTempDir } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");

const TYPECHECK_INPUTS = [
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"extensions/**/*.ts",
	"tests/**/*.ts",
] as const;

const RELEASE_ASSETS_INPUTS = [
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"tests/release-assets.test.ts",
	"LICENSE",
	"README.md",
	"assets/banner.svg",
	"tools/make-banner.mjs",
	"extensions/workbench-runtime/cache/cache-types.ts",
] as const;

const RUNTIME_CORE_TEST_FILES = [
	"tests/recipe-schema.test.ts",
	"tests/recipe-runner.test.ts",
	"tests/p6-c-action-cache.test.ts",
	"tests/inspect.test.ts",
	"tests/p4-render.test.ts",
	"tests/execution-efficiency.test.ts",
	"tests/commander-native-tool-benchmark-v2-wiring.test.ts",
] as const;

const RUNTIME_CORE_INPUTS = [
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	".pi/workbench/recipes.yaml",
	"extensions/**/*.ts",
	"tests/helpers.ts",
	...RUNTIME_CORE_TEST_FILES,
] as const;

const GATE_PREFLIGHT_TEST_FILES = [
	"tests/gates.test.ts",
	"tests/p4-render.test.ts",
	"tests/result-summary-wiring.test.ts",
] as const;

const GATE_PREFLIGHT_INPUTS = [
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	".pi/workbench/recipes.yaml",
	".pi/workbench/gates.yaml",
	"extensions/**/*.ts",
	"tests/helpers.ts",
	...GATE_PREFLIGHT_TEST_FILES,
] as const;

const WORKER_EFFICIENCY_TEST_FILES = [
	"tests/worker-policy.test.ts",
	"tests/worker-runner.test.ts",
	"tests/delegation-ledger.test.ts",
	"tests/p6-b-stable-prefix.test.ts",
] as const;

const WORKER_EFFICIENCY_INPUTS = [
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	".pi/workbench/recipes.yaml",
	"extensions/**/*.ts",
	"tests/helpers.ts",
	...WORKER_EFFICIENCY_TEST_FILES,
	"docs/worker-delegation.md",
] as const;

const DIFF_REVIEW_TEST_FILES = [
	"tests/diff-review.test.ts",
	"tests/diff-review-wiring.test.ts",
] as const;

const DIFF_REVIEW_INPUTS = [
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	".pi/workbench/recipes.yaml",
	"extensions/**/*.ts",
	"tests/helpers.ts",
	...DIFF_REVIEW_TEST_FILES,
] as const;

interface RealPackage {
	version: string;
	scripts: Record<string, string>;
}

let cachedPkg: RealPackage | null = null;
async function realPackage(): Promise<RealPackage> {
	if (cachedPkg === null) {
		cachedPkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as RealPackage;
	}
	return cachedPkg;
}

let cachedRecipes: Recipe[] | null = null;
async function realRecipes(): Promise<Recipe[]> {
	if (cachedRecipes === null) {
		const text = await readFile(join(ROOT, ".pi", "workbench", "recipes.yaml"), "utf8");
		const parsed = parseRecipesDocument(parseYaml(text));
		assert.equal(parsed.errors.length, 0, parsed.errors.join("; "));
		cachedRecipes = parsed.recipes;
	}
	return cachedRecipes;
}

async function realRecipe(name: string): Promise<Recipe> {
	const recipes = await realRecipes();
	const recipe = recipes.find((r) => r.name === name);
	assert.ok(recipe, `real recipes.yaml must declare "${name}"`);
	return recipe;
}

/** Write a set of files under a project root (parents created as needed). */
async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, content, "utf8");
	}
}

interface ProbeCall {
	command: string;
	args: string[];
	cwd: string | undefined;
	timeout: number | undefined;
}

/** Stable fake tool-version exec: records every probe, never spawns. */
interface FakeToolExec extends ExecFn {
	calls: ProbeCall[];
}

function fakeToolExec(versions: Record<string, string>): FakeToolExec {
	const calls: ProbeCall[] = [];
	const fn = (async (
		command: string,
		args: string[],
		options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
	) => {
		calls.push({ command, args, cwd: options?.cwd, timeout: options?.timeout });
		const version = versions[command];
		if (version === undefined) {
			return { stdout: "", stderr: `no fake response for ${command}`, code: 1, killed: false };
		}
		return { stdout: version, stderr: "", code: 0, killed: false };
	}) as FakeToolExec;
	fn.calls = calls;
	return fn;
}

type ComputedKeyOk = Extract<Awaited<ReturnType<typeof computeActionKey>>, { ok: true }>;

/** Compute the REAL typecheck recipe's action key against a project root. */
async function typecheckKeyFor(root: string, recipe: Recipe, exec: ExecFn, pkgVersion: string): Promise<ComputedKeyOk> {
	const result = await computeActionKey({
		projectRoot: root,
		recipe,
		policy: recipe.cache,
		argv: [...recipe.command],
		mode: "DEV",
		profile: undefined,
		projectGates: [],
		packageVersion: pkgVersion,
		exec,
	});
	if (!result.ok) assert.fail(result.reason);
	return result;
}

// ---------------------------------------------------------------------------
// Phase 1: cache closure, stability and invalidation
// ---------------------------------------------------------------------------

test("real recipes.yaml parses cleanly and declares the execution-efficiency recipes", async () => {
	const recipes = await realRecipes();
	const names = recipes.map((r) => r.name).sort();
	for (const name of ["check", "release-assets-test", "runtime-core-test", "typecheck", "unit-test", "typecheck-feedback", "gate-preflight-test", "worker-efficiency-test", "diff-review-efficiency-test"]) {
		assert.ok(names.includes(name), `recipes.yaml must declare "${name}"`);
	}
	assert.equal(recipes.length, names.length, "recipes are unique and sorted");
});

test("real typecheck recipe: cache inputs are exactly the five tsc-relevant patterns with all safety fields", async () => {
	const tc = await realRecipe("typecheck");

	// Recipe-level wiring: read-only npm script, no writes/artifacts/env/params.
	assert.deepEqual(tc.command, ["npm", "run", "typecheck"]);
	assert.equal(tc.cwd, ".");
	assert.equal(tc.timeout_ms, 300_000);
	assert.deepEqual(tc.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(tc.expected_exit_codes, [0]);
	assert.deepEqual(tc.writes, []);
	assert.equal(tc.mutation, "none");
	assert.deepEqual(tc.artifacts, []);
	assert.deepEqual(tc.environment, []);
	assert.deepEqual(tc.params, []);
	assert.deepEqual(tc.validation_components, ["typecheck"]);
	assert.equal(tc.output_strategy, "tail");
	assert.equal(tc.max_lines, 200);
	assert.equal(tc.max_bytes, 20_480);

	// Cache policy: EXACTLY the five content patterns that can change tsc's
	// outcome, with every safety field pinned.
	const cache = tc.cache;
	assert.equal(cache.enabled, true);
	assert.equal(cache.version, 1);
	assert.equal(cache.domain, "default");
	assert.equal(cache.quantContract, null);
	assert.equal(cache.mode, "result-only");
	assert.equal(cache.successOnly, true);
	assert.deepEqual(cache.inputs, [...TYPECHECK_INPUTS]);
	assert.deepEqual(cache.outputs, []);
	assert.deepEqual(cache.environment, []);
	assert.deepEqual(
		cache.toolchain.map((t) => t.name),
		["node", "npm"],
	);
	assert.equal(cache.maxAgeSeconds, null);
	assert.deepEqual(cache.upstream, []);
});

test("real typecheck recipe: repository fingerprint is stable and excludes docs/assets/README", async () => {
	const tc = await realRecipe("typecheck");
	const one = await fingerprintInputs(ROOT, tc.cache.inputs);
	const two = await fingerprintInputs(ROOT, tc.cache.inputs);
	assert.equal(one.merkleHash, two.merkleHash, "fingerprint must be deterministic (no mtime/size dependence)");
	assert.equal(one.facts.missingPatterns, 0, "every declared typecheck pattern must match real files");
	assert.equal(one.facts.protectedRefused, 0);
	assert.ok(one.facts.files >= 5, "the five patterns cover at least five real files");

	// The shared config files are fingerprinted as files.
	for (const p of ["package.json", "package-lock.json", "tsconfig.json"]) {
		const entry = one.entries.find((e) => e.p === p);
		assert.ok(entry, `${p} must be fingerprinted`);
		assert.equal(entry.t, "file");
		assert.match(entry.h, /^[0-9a-f]{64}$/);
	}

	// Both TypeScript globs are live against the real repository.
	assert.ok(
		one.entries.some((e) => e.p.startsWith("extensions/") && e.p.endsWith(".ts")),
		"extension TS must be fingerprinted",
	);
	assert.ok(
		one.entries.some((e) => e.p.startsWith("tests/") && e.p.endsWith(".ts")),
		"test TS must be fingerprinted",
	);
	assert.ok(
		one.entries.some((e) => e.p === "tests/execution-efficiency.test.ts"),
		"this test file is part of the typecheck closure",
	);

	// Unrelated repo content is deliberately OUT of the closure: a docs-only
	// or asset-only change never invalidates the cached typecheck result.
	const outside = one.entries.filter((e) => {
		return (
			e.p === "README.md" ||
			e.p.startsWith("docs/") ||
			e.p.startsWith("assets/") ||
			e.p.startsWith("skills/") ||
			e.p.startsWith("prompts/") ||
			e.p.startsWith("templates/") ||
			e.p.startsWith("tools/") ||
			e.p.startsWith("compatibility/")
		);
	});
	assert.deepEqual(outside, [], "docs/assets/README/skills/prompts/templates/tools/compatibility stay out of the typecheck fingerprint");

	// Stable ordering: the flat entry list is sorted by path.
	const paths = one.entries.map((e) => e.p);
	assert.deepEqual(paths, [...paths].sort(), "fingerprint entries are stable-sorted");
});

test("real release-assets wiring: package script and recipe declare the exact asset closure", async () => {
	const pkg = await realPackage();
	assert.equal(pkg.scripts["test:release-assets"], "tsx --test tests/release-assets.test.ts");

	const ra = await realRecipe("release-assets-test");
	assert.deepEqual(ra.command, ["npm", "run", "test:release-assets"]);
	assert.deepEqual(ra.validation_components, []);
	const cache = ra.cache;
	assert.equal(cache.enabled, true);
	assert.equal(cache.version, 1);
	assert.equal(cache.mode, "result-only");
	assert.equal(cache.successOnly, true);
	assert.equal(cache.maxAgeSeconds, null);
	assert.deepEqual(
		cache.toolchain.map((t) => t.name),
		["node", "npm"],
	);
	assert.deepEqual(cache.outputs, []);
	assert.deepEqual(cache.environment, []);
	assert.deepEqual(cache.inputs, [...RELEASE_ASSETS_INPUTS]);
	for (const input of RELEASE_ASSETS_INPUTS) {
		await assert.doesNotReject(readFile(join(ROOT, input)), `release-assets input ${input} must exist`);
	}
});

test("real typecheck action key: docs/assets/README and added unrelated docs keep the key; extension TS, package.json and node version invalidate", async () => {
	const tc = await realRecipe("typecheck");
	const pkg = await realPackage();
	await withTempDir(async (dir) => {
		await writeFiles(dir, {
			"package.json": JSON.stringify({ name: "proj", version: "0.0.0" }, null, 2),
			"package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }, null, 2),
			"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
			"extensions/workbench-runtime/core/recipe-schema.ts": "export const schemaVersion = 1;\n",
			"extensions/workbench-runtime/core/action-key.ts": "export const keyVersion = 1;\n",
			"tests/sample.test.ts": "import assert from \"node:assert/strict\";\n",
			"README.md": "# demo\n",
			"docs/guide.md": "# guide\n",
			"assets/banner.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n",
		});

		const exec = fakeToolExec({ node: "v22.14.0", npm: "10.9.2" });
		const base = await typecheckKeyFor(dir, tc, exec, pkg.version);
		const baseFp = await fingerprintInputs(dir, tc.cache.inputs);
		assert.equal(baseFp.facts.files, 6, "seeded project fingerprints exactly the six seeded files");
		assert.equal(baseFp.facts.missingPatterns, 0);
		assert.equal(base.key.components.inputFacts.files, 6);
		assert.equal(base.key.components.toolchainVersions.node, "v22.14.0");
		assert.equal(base.key.components.toolchainVersions.npm, "10.9.2");

		// Determinism: identical inputs produce the identical key.
		const again = await typecheckKeyFor(dir, tc, exec, pkg.version);
		assert.equal(again.key.key, base.key.key);

		// Unrelated content: added docs, assets and a README edit are NOT
		// declared typecheck inputs — fingerprint and key must not move.
		await writeFiles(dir, {
			"docs/unrelated.md": "# added later\n",
			"assets/extra.svg": "<svg></svg>\n",
		});
		await writeFile(join(dir, "README.md"), "# demo — edited\n", "utf8");
		const docsFp = await fingerprintInputs(dir, tc.cache.inputs);
		assert.equal(docsFp.merkleHash, baseFp.merkleHash, "docs/assets/README are not typecheck inputs");
		assert.equal(docsFp.facts.files, 6);
		assert.ok(
			docsFp.entries.every((e) => !e.p.startsWith("docs/") && !e.p.startsWith("assets/") && e.p !== "README.md"),
			"added docs/assets/README content never enters the fingerprint",
		);
		const docsKey = await typecheckKeyFor(dir, tc, exec, pkg.version);
		assert.equal(docsKey.key.key, base.key.key, "added unrelated docs must not invalidate the typecheck key");

		// Extension TypeScript is a declared input -> key must change.
		await writeFile(join(dir, "extensions", "workbench-runtime", "core", "recipe-schema.ts"), "export const schemaVersion = 2;\n", "utf8");
		const extKey = await typecheckKeyFor(dir, tc, exec, pkg.version);
		assert.notEqual(extKey.key.key, base.key.key, "extension TS change must invalidate the typecheck key");

		// package.json is a declared input -> key must change.
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: "proj", version: "0.0.1" }, null, 2), "utf8");
		const pkgKey = await typecheckKeyFor(dir, tc, exec, pkg.version);
		assert.notEqual(pkgKey.key.key, base.key.key, "package.json change must invalidate the typecheck key");

		// Toolchain version is a key component -> key must change.
		const nodeBump = fakeToolExec({ node: "v22.15.0", npm: "10.9.2" });
		const nodeKey = await typecheckKeyFor(dir, tc, nodeBump, pkg.version);
		assert.notEqual(nodeKey.key.key, base.key.key, "node version change must invalidate the typecheck key");
		assert.equal(nodeKey.key.components.toolchainVersions.node, "v22.15.0");

		// The version probes run exactly the built-in allow-listed queries
		// (node --version / npm --version) against the project root.
		assert.equal(exec.calls.length, 10, "five key computations x node+npm probes");
		for (const call of exec.calls) {
			assert.deepEqual(call.args, ["--version"]);
			assert.equal(call.cwd, dir);
			assert.equal(call.timeout, 5000);
		}
		assert.deepEqual(nodeBump.calls.map((c) => c.command), ["node", "npm"]);
	});
});

// ---------------------------------------------------------------------------
// Phase 2: check composition and runtime-core wiring
// ---------------------------------------------------------------------------

test("package.json: check script is the exact full-check chain", async () => {
	const pkg = await realPackage();
	assert.equal(pkg.scripts["typecheck"], "tsc --noEmit");
	assert.equal(pkg.scripts["test"], "tsx --test tests/*.test.ts");
	assert.equal(pkg.scripts["check"], "npm run typecheck && npm test && git diff --check");
});

test("check recipe: exact argv, intentionally uncached, components [typecheck, unit-test, whitespace]", async () => {
	const check = await realRecipe("check");
	assert.deepEqual(check.command, ["npm", "run", "check"]);
	assert.deepEqual(check.validation_components, ["typecheck", "unit-test", "whitespace"]);
	assert.deepEqual(check.cache, DEFAULT_CACHE_POLICY, "check must stay uncached (no cache block)");
	assert.equal(check.mutation, "none");
	assert.deepEqual(check.writes, []);
	assert.deepEqual(check.artifacts, []);
	assert.deepEqual(check.environment, []);
	assert.deepEqual(check.params, []);
	assert.deepEqual(check.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(check.expected_exit_codes, [0]);
	assert.equal(check.cwd, ".");
	assert.equal(check.timeout_ms, 900_000);
	assert.equal(check.output_strategy, "tail");
	assert.equal(check.max_lines, 300);
	assert.equal(check.max_bytes, 30_720);
});

test("validation components wiring: typecheck [typecheck], unit-test [unit-test], release-assets []", async () => {
	const typecheck = await realRecipe("typecheck");
	const unitTest = await realRecipe("unit-test");
	const releaseAssets = await realRecipe("release-assets-test");
	assert.deepEqual(typecheck.validation_components, ["typecheck"]);
	assert.deepEqual(unitTest.validation_components, ["unit-test"]);
	assert.deepEqual(unitTest.command, ["npm", "test"]);
	assert.deepEqual(releaseAssets.validation_components, []);
});

test("package.json: test:runtime-core is exactly the seven runtime-core test files", async () => {
	const pkg = await realPackage();
	const script = pkg.scripts["test:runtime-core"];
	assert.ok(script, "test:runtime-core script declared");
	const files = script.split(/\s+/).filter((token) => token.endsWith(".ts"));
	assert.equal(files.length, 7, "test:runtime-core must run exactly seven test files");
	assert.deepEqual(files, [...RUNTIME_CORE_TEST_FILES]);
	for (const file of RUNTIME_CORE_TEST_FILES) {
		await assert.doesNotReject(readFile(join(ROOT, file)), `${file} must exist`);
	}
});

test("runtime-core-test recipe: exact argv/cwd/params/env/mutation/writes/artifacts/modes/exits and components", async () => {
	const rc = await realRecipe("runtime-core-test");
	assert.deepEqual(rc.command, ["npm", "run", "test:runtime-core"]);
	assert.equal(rc.cwd, ".");
	assert.deepEqual(rc.params, []);
	assert.deepEqual(rc.environment, []);
	assert.equal(rc.mutation, "none");
	assert.deepEqual(rc.writes, []);
	assert.deepEqual(rc.artifacts, []);
	assert.deepEqual(rc.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(rc.expected_exit_codes, [0]);
	assert.equal(rc.timeout_ms, 600_000);
	assert.equal(rc.output_strategy, "tail");
	assert.equal(rc.max_lines, 300);
	assert.equal(rc.max_bytes, 30_720);
	assert.deepEqual(rc.validation_components, []);
});

test("runtime-core-test recipe: cache v1 result-only successOnly, empty outputs/env, node/npm, null maxAge, exact ordered 13 inputs", async () => {
	const rc = await realRecipe("runtime-core-test");
	const cache = rc.cache;
	assert.equal(cache.enabled, true);
	assert.equal(cache.version, 1);
	assert.equal(cache.domain, "default");
	assert.equal(cache.quantContract, null);
	assert.equal(cache.mode, "result-only");
	assert.equal(cache.successOnly, true);
	assert.deepEqual(cache.outputs, []);
	assert.deepEqual(cache.environment, []);
	assert.deepEqual(
		cache.toolchain.map((t) => t.name),
		["node", "npm"],
	);
	assert.equal(cache.maxAgeSeconds, null);
	assert.deepEqual(cache.upstream, []);
	assert.equal(cache.inputs.length, 13, "exactly the ordered 13-input closure");
	assert.deepEqual(cache.inputs, [...RUNTIME_CORE_INPUTS]);
	for (const input of RUNTIME_CORE_INPUTS) {
		if (input.includes("*")) continue;
		await assert.doesNotReject(readFile(join(ROOT, input)), `runtime-core input ${input} must exist`);
	}
});

// ---------------------------------------------------------------------------
// Phase 3: dev-only feedback recipes (typecheck-feedback, gate-preflight-test)
// ---------------------------------------------------------------------------

test("package.json: test:gate-preflight is exactly the three Phase 3 test files", async () => {
	const pkg = await realPackage();
	const script = pkg.scripts["test:gate-preflight"];
	assert.ok(script, "test:gate-preflight script declared");
	assert.equal(script, "tsx --test tests/gates.test.ts tests/p4-render.test.ts tests/result-summary-wiring.test.ts");
	const files = script.split(/\s+/).filter((token) => token.endsWith(".ts"));
	assert.deepEqual(files, [...GATE_PREFLIGHT_TEST_FILES]);
	for (const file of GATE_PREFLIGHT_TEST_FILES) {
		await assert.doesNotReject(readFile(join(ROOT, file)), `${file} must exist`);
	}
});

test("typecheck-feedback recipe: exact argv, read-only, uncached self-hosting alias, no validation component", async () => {
	const fb = await realRecipe("typecheck-feedback");
	// The recipe is a self-hosting alias of the real typecheck invocation.
	assert.deepEqual(fb.command, ["npm", "run", "typecheck"]);
	assert.equal(fb.cwd, ".");
	assert.deepEqual(fb.params, []);
	assert.deepEqual(fb.environment, []);
	assert.equal(fb.mutation, "none");
	assert.deepEqual(fb.writes, []);
	assert.deepEqual(fb.artifacts, []);
	assert.deepEqual(fb.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(fb.expected_exit_codes, [0]);
	assert.equal(fb.timeout_ms, 300_000);
	assert.equal(fb.output_strategy, "tail");
	assert.equal(fb.max_lines, 200);
	assert.equal(fb.max_bytes, 20_480);
	// Intentionally UNCACHED — no cache block at all.
	assert.deepEqual(fb.cache, DEFAULT_CACHE_POLICY, "typecheck-feedback must stay uncached (no cache block)");
	// Feedback only: no validation component — never check/Gate evidence.
	assert.deepEqual(fb.validation_components, []);
});

test("gate-preflight-test recipe: exact argv/cwd/params/env/mutation/writes/artifacts/modes/exits, no validation component", async () => {
	const gp = await realRecipe("gate-preflight-test");
	assert.deepEqual(gp.command, ["npm", "run", "test:gate-preflight"]);
	assert.equal(gp.cwd, ".");
	assert.deepEqual(gp.params, []);
	assert.deepEqual(gp.environment, []);
	assert.equal(gp.mutation, "none");
	assert.deepEqual(gp.writes, []);
	assert.deepEqual(gp.artifacts, []);
	assert.deepEqual(gp.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(gp.expected_exit_codes, [0]);
	assert.equal(gp.timeout_ms, 600_000);
	assert.equal(gp.output_strategy, "tail");
	assert.equal(gp.max_lines, 300);
	assert.equal(gp.max_bytes, 30_720);
	// Feedback only: no validation component — never check/Gate evidence.
	assert.deepEqual(gp.validation_components, []);
});

test("gate-preflight-test recipe: cache v1 result-only successOnly, empty outputs/env, node/npm, null maxAge, exact ordered 10-input closure", async () => {
	const gp = await realRecipe("gate-preflight-test");
	const cache = gp.cache;
	assert.equal(cache.enabled, true);
	assert.equal(cache.version, 1);
	assert.equal(cache.domain, "default");
	assert.equal(cache.quantContract, null);
	assert.equal(cache.mode, "result-only");
	assert.equal(cache.successOnly, true);
	assert.deepEqual(cache.outputs, []);
	assert.deepEqual(cache.environment, []);
	assert.deepEqual(
		cache.toolchain.map((t) => t.name),
		["node", "npm"],
	);
	assert.equal(cache.maxAgeSeconds, null);
	assert.deepEqual(cache.upstream, []);
	assert.equal(cache.inputs.length, 10, "exactly the ordered 10-input gate-preflight closure");
	assert.deepEqual(cache.inputs, [...GATE_PREFLIGHT_INPUTS]);
	for (const input of GATE_PREFLIGHT_INPUTS) {
		if (input.includes("*")) continue;
		await assert.doesNotReject(readFile(join(ROOT, input)), `gate-preflight input ${input} must exist`);
	}
});

// ---------------------------------------------------------------------------
// Phase 4: worker-efficiency feedback wiring
// ---------------------------------------------------------------------------

test("package.json: test:worker-efficiency is exactly the four worker test files", async () => {
	const pkg = await realPackage();
	const script = pkg.scripts["test:worker-efficiency"];
	assert.ok(script, "test:worker-efficiency script declared");
	assert.equal(script, "tsx --test tests/worker-policy.test.ts tests/worker-runner.test.ts tests/delegation-ledger.test.ts tests/p6-b-stable-prefix.test.ts");
	const files = script.split(/\s+/).filter((token) => token.endsWith(".ts"));
	assert.equal(files.length, 4, "test:worker-efficiency must run exactly four test files");
	assert.deepEqual(files, [...WORKER_EFFICIENCY_TEST_FILES]);
	for (const file of WORKER_EFFICIENCY_TEST_FILES) {
		await assert.doesNotReject(readFile(join(ROOT, file)), `${file} must exist`);
	}
});

test("worker-efficiency-test recipe: exact argv/cwd/params/env/mutation/writes/artifacts/modes/exits/tail, no validation component", async () => {
	const we = await realRecipe("worker-efficiency-test");
	assert.deepEqual(we.command, ["npm", "run", "test:worker-efficiency"]);
	assert.equal(we.cwd, ".");
	assert.deepEqual(we.params, []);
	assert.deepEqual(we.environment, []);
	assert.equal(we.mutation, "none");
	assert.deepEqual(we.writes, []);
	assert.deepEqual(we.artifacts, []);
	assert.deepEqual(we.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(we.expected_exit_codes, [0]);
	assert.equal(we.timeout_ms, 600_000);
	assert.equal(we.output_strategy, "tail");
	assert.equal(we.max_lines, 300);
	assert.equal(we.max_bytes, 30_720);
	// Focused feedback only: no validation component — never check/Gate evidence.
	assert.deepEqual(we.validation_components, []);
});

test("worker-efficiency-test recipe: cache v1 result-only successOnly, empty outputs/env, node/npm, null maxAge, exact ordered 11 inputs", async () => {
	const we = await realRecipe("worker-efficiency-test");
	const cache = we.cache;
	assert.equal(cache.enabled, true);
	assert.equal(cache.version, 1);
	assert.equal(cache.domain, "default");
	assert.equal(cache.quantContract, null);
	assert.equal(cache.mode, "result-only");
	assert.equal(cache.successOnly, true);
	assert.deepEqual(cache.outputs, []);
	assert.deepEqual(cache.environment, []);
	assert.deepEqual(
		cache.toolchain.map((t) => t.name),
		["node", "npm"],
	);
	assert.equal(cache.maxAgeSeconds, null);
	assert.deepEqual(cache.upstream, []);
	assert.equal(cache.inputs.length, 11, "exactly the ordered 11-input worker-efficiency closure");
	assert.deepEqual(cache.inputs, [...WORKER_EFFICIENCY_INPUTS]);
	for (const input of WORKER_EFFICIENCY_INPUTS) {
		if (input.includes("*")) continue;
		await assert.doesNotReject(readFile(join(ROOT, input)), `worker-efficiency input ${input} must exist`);
	}
});

// ---------------------------------------------------------------------------
// Phase 5: diff-review-efficiency feedback wiring
// ---------------------------------------------------------------------------

test("package.json: test:diff-review-efficiency is exactly the two diff-review test files", async () => {
	const pkg = await realPackage();
	const script = pkg.scripts["test:diff-review-efficiency"];
	assert.ok(script, "test:diff-review-efficiency script declared");
	assert.equal(script, "tsx --test tests/diff-review.test.ts tests/diff-review-wiring.test.ts");
	const files = script.split(/\s+/).filter((token) => token.endsWith(".ts"));
	assert.equal(files.length, 2, "test:diff-review-efficiency must run exactly two test files");
	assert.deepEqual(files, [...DIFF_REVIEW_TEST_FILES]);
	for (const file of DIFF_REVIEW_TEST_FILES) {
		await assert.doesNotReject(readFile(join(ROOT, file)), `${file} must exist`);
	}
});

test("diff-review-efficiency-test recipe: exact argv/cwd/params/env/mutation/writes/artifacts/modes/exits/tail, no validation component", async () => {
	const dr = await realRecipe("diff-review-efficiency-test");
	assert.deepEqual(dr.command, ["npm", "run", "test:diff-review-efficiency"]);
	assert.equal(dr.cwd, ".");
	assert.deepEqual(dr.params, []);
	assert.deepEqual(dr.environment, []);
	assert.equal(dr.mutation, "none");
	assert.deepEqual(dr.writes, []);
	assert.deepEqual(dr.artifacts, []);
	assert.deepEqual(dr.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(dr.expected_exit_codes, [0]);
	assert.equal(dr.timeout_ms, 600_000);
	assert.equal(dr.output_strategy, "tail");
	assert.equal(dr.max_lines, 300);
	assert.equal(dr.max_bytes, 30_720);
	// Focused feedback only: no validation component — never check/Gate evidence.
	assert.deepEqual(dr.validation_components, []);
});

test("diff-review-efficiency-test recipe: cache v1 result-only successOnly, empty outputs/env, node/npm, null maxAge, exact ordered 8 inputs", async () => {
	const dr = await realRecipe("diff-review-efficiency-test");
	const cache = dr.cache;
	assert.equal(cache.enabled, true);
	assert.equal(cache.version, 1);
	assert.equal(cache.domain, "default");
	assert.equal(cache.quantContract, null);
	assert.equal(cache.mode, "result-only");
	assert.equal(cache.successOnly, true);
	assert.deepEqual(cache.outputs, []);
	assert.deepEqual(cache.environment, []);
	assert.deepEqual(
		cache.toolchain.map((t) => t.name),
		["node", "npm"],
	);
	assert.equal(cache.maxAgeSeconds, null);
	assert.deepEqual(cache.upstream, []);
	assert.equal(cache.inputs.length, 8, "exactly the ordered 8-input diff-review-efficiency closure");
	assert.deepEqual(cache.inputs, [...DIFF_REVIEW_INPUTS]);
	for (const input of DIFF_REVIEW_INPUTS) {
		if (input.includes("*")) continue;
		await assert.doesNotReject(readFile(join(ROOT, input)), `diff-review-efficiency input ${input} must exist`);
	}
});

test("feedback recipes: explicitly dev-only feedback, empty validation components, never part of the check aggregate", async () => {
	const check = await realRecipe("check");
	for (const name of ["typecheck-feedback", "gate-preflight-test", "worker-efficiency-test", "diff-review-efficiency-test"]) {
		const recipe = await realRecipe(name);
		assert.deepEqual(recipe.validation_components, [], `${name} must declare no validation component`);
		assert.ok(recipe.description.includes("dev-only"), `${name} must be labelled dev-only feedback`);
		assert.ok(recipe.description.includes("feedback"), `${name} must be labelled feedback, never check evidence`);
		assert.equal(new Set<string>(check.validation_components).has(name), false, `${name} must never be a check aggregate component`);
	}
	// The Phase 2 aggregate rule stays exactly [typecheck, unit-test, whitespace].
	assert.deepEqual(check.validation_components, ["typecheck", "unit-test", "whitespace"]);
});
