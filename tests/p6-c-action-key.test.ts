/**
 * P6-C action key tests — deterministic identity of one recipe execution.
 *
 * Coverage (P6-C spec §4/§5/§12): input fingerprinting (content change,
 * touch, missing input, glob no-match, symlink, symlink escape, protected
 * secret inputs, executable bit, directory recursion, limits), and every
 * key component (definition, argv, cwd, mode, env, toolchain, lockfile,
 * OS/arch, config, profile, gate schema, upstream).
 */

import assert from "node:assert/strict";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { parseRecipesDocument, type Recipe } from "../extensions/workbench-runtime/core/recipe-schema.ts";
import { computeActionKey } from "../extensions/workbench-runtime/cache/action-key.ts";
import { fingerprintInputs, FingerprintError } from "../extensions/workbench-runtime/cache/action-fingerprint.ts";
import { parseCachePolicy, MAX_INPUT_DEPTH } from "../extensions/workbench-runtime/cache/action-types.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { withTempDir } from "./helpers.ts";

const PKG_VERSION = "0.7.0";

function recipeFromYaml(name: string, yamlDoc: Record<string, unknown>): Recipe {
	const doc = { recipes: [{ name, command: ["echo", "hi"], cwd: ".", timeout_ms: 10000, ...yamlDoc }] };
	const parsed = parseRecipesDocument(doc);
	assert.equal(parsed.errors.length, 0, parsed.errors.join("; "));
	const recipe = parsed.recipes.find((r) => r.name === name);
	assert.ok(recipe, "recipe parsed");
	return recipe;
}

function fakeExec(responses: Record<string, { code: number; stdout: string; stderr?: string }>): ExecFn & { calls: string[][] } {
	const calls: string[][] = [];
	const fn = (async (command: string, args: string[]) => {
		calls.push([command, ...args]);
		const key = [command, ...args].join(" ");
		const match = responses[key] ?? responses[command] ?? { code: 1, stdout: "", stderr: "no response" };
		return { stdout: match.stdout, stderr: match.stderr ?? "", code: match.code, killed: false };
	}) as ExecFn & { calls: string[][] };
	fn.calls = calls;
	return fn;
}

const GIT_RESPONSES = {
	git: { code: 0, stdout: "" },
};

function baseRecipeYaml(inputs: string[]): Record<string, unknown> {
	return {
		cache: { enabled: true, version: 1, mode: "result-only", successOnly: true, inputs, outputs: [], environment: [], toolchain: [], maxAgeSeconds: null },
	};
}

async function writeInputs(root: string, files: Record<string, string>): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, content, "utf8");
	}
}

// ---------------------------------------------------------------------------
// Input fingerprinting
// ---------------------------------------------------------------------------

test("fingerprint: same content -> same hash; content change -> different hash", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "export const a = 1;\n" });
		const one = await fingerprintInputs(dir, ["src/**/*.ts"]);
		const two = await fingerprintInputs(dir, ["src/**/*.ts"]);
		assert.equal(one.merkleHash, two.merkleHash);
		await writeFile(join(dir, "src", "a.ts"), "export const a = 2;\n", "utf8");
		const three = await fingerprintInputs(dir, ["src/**/*.ts"]);
		assert.notEqual(one.merkleHash, three.merkleHash);
	});
});

test("fingerprint: touch (mtime only) does not change the hash", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "same content" });
		const one = await fingerprintInputs(dir, ["src/**/*.ts"]);
		await new Promise((r) => setTimeout(r, 20));
		// recreate with same content (mtime changes; content identical)
		await writeFile(join(dir, "src", "a.ts"), "same content", "utf8");
		await new Promise((r) => setTimeout(r, 20));
		const two = await fingerprintInputs(dir, ["src/**/*.ts"]);
		assert.equal(one.merkleHash, two.merkleHash);
	});
});

test("fingerprint: executable bit is part of the hash", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "bin/run.sh": "#!/bin/sh\necho hi\n" });
		const before = await fingerprintInputs(dir, ["bin/**"]);
		await chmod(join(dir, "bin", "run.sh"), 0o755);
		const after = await fingerprintInputs(dir, ["bin/**"]);
		assert.notEqual(before.merkleHash, after.merkleHash);
	});
});

test("fingerprint: missing input is an explicit key component", async () => {
	await withTempDir(async (dir) => {
		const one = await fingerprintInputs(dir, ["src/never-exists.ts"]);
		assert.equal(one.facts.missingPatterns, 1);
		assert.deepEqual(one.entries.map((e) => e.t), ["missing"]);
		const two = await fingerprintInputs(dir, ["src/never-exists.ts"]);
		assert.equal(one.merkleHash, two.merkleHash);
		// The file appears -> the key must change.
		await writeInputs(dir, { "src/never-exists.ts": "now here" });
		const three = await fingerprintInputs(dir, ["src/never-exists.ts"]);
		assert.notEqual(one.merkleHash, three.merkleHash);
		assert.equal(three.facts.missingPatterns, 0);
	});
});

test("fingerprint: glob with no match enters the key (stable across runs)", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x" });
		const one = await fingerprintInputs(dir, ["src/**/*.ts", "extensions/**/*.ts"]);
		const two = await fingerprintInputs(dir, ["src/**/*.ts", "extensions/**/*.ts"]);
		assert.equal(one.merkleHash, two.merkleHash);
		assert.equal(one.facts.missingPatterns, 1);
	});
});

test("fingerprint: directory recursion (nested change) and stable sort", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, {
			"src/b.ts": "b",
			"src/sub/c.ts": "c",
			"src/sub/deep/d.ts": "d",
		});
		const one = await fingerprintInputs(dir, ["src"]);
		assert.equal(one.facts.files, 3);
		assert.equal(one.facts.dirs, 3);
		await writeFile(join(dir, "src", "sub", "deep", "d.ts"), "changed", "utf8");
		const two = await fingerprintInputs(dir, ["src"]);
		assert.notEqual(one.merkleHash, two.merkleHash);
		// Pattern order must not matter.
		const three = await fingerprintInputs(dir, ["src", "src/**"]);
		const four = await fingerprintInputs(dir, ["src/**", "src"]);
		assert.equal(three.merkleHash, four.merkleHash);
	});
});

test("fingerprint: project-local symlink records target + content hash", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "data/real.txt": "target content" });
		await symlink("real.txt", join(dir, "data", "link.txt"));
		const one = await fingerprintInputs(dir, ["data/**"]);
		// The directory entry carries the recursive Merkle hash (which includes
		// the symlink's link target + target content hash).
		assert.ok(one.entries.some((e) => e.p === "data" && e.t === "dir"));
		// A direct pattern match exposes the symlink entry itself.
		const direct = await fingerprintInputs(dir, ["data/link.txt"]);
		assert.equal(direct.entries[0]?.t, "symlink");
		assert.equal(direct.facts.symlinks, 1);
		// Changing the TARGET content changes the symlink entry hash and the merkle hash.
		await writeFile(join(dir, "data", "real.txt"), "other content", "utf8");
		const two = await fingerprintInputs(dir, ["data/**"]);
		assert.notEqual(one.merkleHash, two.merkleHash);
		const directTwo = await fingerprintInputs(dir, ["data/link.txt"]);
		assert.notEqual(direct.merkleHash, directTwo.merkleHash);
	});
});

test("fingerprint: broken symlink refuses the cache", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "data/real.txt": "x" });
		await symlink("gone.txt", join(dir, "data", "broken.txt"));
		await assert.rejects(fingerprintInputs(dir, ["data/**"]), FingerprintError);
	});
});

test("fingerprint: symlink escaping the project root refuses the cache", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x" });
		await symlink("/etc/hostname", join(dir, "src", "escape.txt"));
		await assert.rejects(fingerprintInputs(dir, ["src/**"]), FingerprintError);
	});
});

test("fingerprint: protected secret inputs are never read (refused marker)", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { ".env": "SECRET_TOKEN=super-secret-value" });
		const fp = await fingerprintInputs(dir, [".env"]);
		assert.equal(fp.entries.length, 1);
		assert.equal(fp.entries[0]!.t, "protected");
		assert.equal(fp.entries[0]!.h, "refused");
		assert.equal(fp.facts.protectedRefused, 1);
		// The secret CONTENT must not influence the hash.
		const fp2 = await fingerprintInputs(dir, [".env"]);
		assert.equal(fp.merkleHash, fp2.merkleHash);
	});
});

test("fingerprint: depth limit fails closed", async () => {
	await withTempDir(async (dir) => {
		let deep = join(dir, "src");
		for (let i = 0; i < MAX_INPUT_DEPTH + 5; i += 1) {
			deep = join(deep, "d");
			await mkdir(deep, { recursive: true });
		}
		await writeFile(join(deep, "leaf.txt"), "x", "utf8");
		await assert.rejects(fingerprintInputs(dir, ["src"]), FingerprintError);
	});
});

// ---------------------------------------------------------------------------
// Action key components
// ---------------------------------------------------------------------------

async function keyFor(root: string, recipe: Recipe, exec: ExecFn, overrides: Record<string, unknown> = {}) {
	const result = await computeActionKey({
		projectRoot: root,
		recipe,
		policy: recipe.cache,
		argv: ["echo", "hi"],
		mode: "DEV",
		profile: undefined,
		projectGates: [],
		packageVersion: PKG_VERSION,
		exec,
		...overrides,
	});
	return result;
}

test("action key: identical inputs produce the identical key; git state is NOT part of it", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x" });
		const recipe = recipeFromYaml("t", baseRecipeYaml(["src/**/*.ts"]));
		const exec = fakeExec({ ...GIT_RESPONSES, node: { code: 0, stdout: "v20.0.0" } });
		const one = await keyFor(dir, recipe, exec);
		const two = await keyFor(dir, recipe, exec);
		assert.ok(one.ok && two.ok);
		assert.equal(one.key.key, two.key.key);
		assert.equal(one.key.components.recipeName, "t");
		assert.ok(/^[0-9a-f]{64}$/.test(one.key.key));
	});
});

test("action key: recipe definition change -> different key", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x" });
		const exec = fakeExec({ ...GIT_RESPONSES });
		const a = recipeFromYaml("t", { ...baseRecipeYaml(["src/**/*.ts"]), timeout_ms: 10_000 });
		const b = recipeFromYaml("t", { ...baseRecipeYaml(["src/**/*.ts"]), timeout_ms: 20_000 });
		const ka = await keyFor(dir, a, exec);
		const kb = await keyFor(dir, b, exec);
		assert.ok(ka.ok && kb.ok);
		assert.notEqual(ka.key.key, kb.key.key);
	});
});

test("action key: argv change -> different key", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x" });
		const recipe = recipeFromYaml("t", baseRecipeYaml(["src/**/*.ts"]));
		const exec = fakeExec({ ...GIT_RESPONSES });
		const one = await computeActionKey({ projectRoot: dir, recipe, policy: recipe.cache, argv: ["echo", "a"], mode: "DEV", profile: undefined, projectGates: [], packageVersion: PKG_VERSION, exec });
		const two = await computeActionKey({ projectRoot: dir, recipe, policy: recipe.cache, argv: ["echo", "b"], mode: "DEV", profile: undefined, projectGates: [], packageVersion: PKG_VERSION, exec });
		assert.ok(one.ok && two.ok);
		assert.notEqual(one.key.key, two.key.key);
	});
});

test("action key: cwd change -> different key (and POSIX normalization)", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x", "sub/b.ts": "y" });
		const exec = fakeExec({ ...GIT_RESPONSES });
		const a = recipeFromYaml("t", { ...baseRecipeYaml(["src/**/*.ts"]), cwd: "." });
		const b = recipeFromYaml("t", { ...baseRecipeYaml(["src/**/*.ts"]), cwd: "sub" });
		const ka = await keyFor(dir, a, exec);
		const kb = await keyFor(dir, b, exec);
		assert.ok(ka.ok && kb.ok);
		assert.equal(ka.key.components.normalizedCwd, ".");
		assert.equal(kb.key.components.normalizedCwd, "sub");
		assert.notEqual(ka.key.key, kb.key.key);
	});
});

test("action key: mode change -> different key", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x" });
		const recipe = recipeFromYaml("t", baseRecipeYaml(["src/**/*.ts"]));
		const exec = fakeExec({ ...GIT_RESPONSES });
		const dev = await keyFor(dir, recipe, exec);
		const verify = await keyFor(dir, recipe, exec, { mode: "VERIFY" });
		assert.ok(dev.ok && verify.ok);
		assert.notEqual(dev.key.key, verify.key.key);
	});
});

test("action key: declared environment change -> different key; raw values never stored", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x" });
		const recipe = recipeFromYaml("t", {
			...baseRecipeYaml(["src/**/*.ts"]),
			environment: ["NODE_ENV"],
			cache: { ...(baseRecipeYaml(["src/**/*.ts"]).cache ?? {}), environment: ["MY_CACHE_VAR"] },
		});
		const exec = fakeExec({ ...GIT_RESPONSES });
		const one = await keyFor(dir, recipe, exec, { envOverride: { NODE_ENV: "test", MY_CACHE_VAR: "alpha" } });
		const two = await keyFor(dir, recipe, exec, { envOverride: { NODE_ENV: "test", MY_CACHE_VAR: "beta" } });
		assert.ok(one.ok && two.ok);
		assert.notEqual(one.key.key, two.key.key);
		// Values appear only as hashes inside the components.
		const envHash = one.key.components.environmentHash;
		assert.ok(!envHash.includes("alpha") && !envHash.includes("beta"));
		// Unset env var is an explicit component.
		const three = await keyFor(dir, recipe, exec, { envOverride: { NODE_ENV: "test" } });
		assert.ok(three.ok);
		assert.notEqual(one.key.key, three.key.key);
	});
});

test("action key: toolchain version change -> different key; failed probe -> explicit unknown", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x" });
		const recipe = recipeFromYaml("t", {
			...baseRecipeYaml(["src/**/*.ts"]),
			cache: { ...(baseRecipeYaml(["src/**/*.ts"]).cache ?? {}), toolchain: ["node"] },
		});
		const v20 = fakeExec({ ...GIT_RESPONSES, node: { code: 0, stdout: "v20.0.0" } });
		const v22 = fakeExec({ ...GIT_RESPONSES, node: { code: 0, stdout: "v22.1.0" } });
		const one = await keyFor(dir, recipe, v20);
		const two = await keyFor(dir, recipe, v22);
		assert.ok(one.ok && two.ok);
		assert.equal(one.key.components.toolchainVersions.node, "v20.0.0");
		assert.notEqual(one.key.key, two.key.key);

		const broken = fakeExec({ ...GIT_RESPONSES, node: { code: 1, stdout: "" } });
		const three = await keyFor(dir, recipe, broken);
		assert.ok(three.ok);
		assert.equal(three.key.components.toolchainVersions.node, "unknown");
	});
});

test("action key: lockfile change -> different key", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x", "package-lock.json": "{\"lockfileVersion\":3,\"a\":1}" });
		const recipe = recipeFromYaml("t", baseRecipeYaml(["src/**/*.ts"]));
		const exec = fakeExec({ ...GIT_RESPONSES });
		const one = await keyFor(dir, recipe, exec);
		assert.ok(one.ok);
		assert.match(one.key.components.lockfileHashes["package-lock.json"] ?? "", /^[0-9a-f]{64}$/);
		await writeFile(join(dir, "package-lock.json"), "{\"lockfileVersion\":3,\"a\":2}", "utf8");
		const two = await keyFor(dir, recipe, exec);
		assert.ok(one.ok && two.ok);
		assert.notEqual(one.key.components.lockfileHashes["package-lock.json"], two.key.components.lockfileHashes["package-lock.json"]);
		assert.notEqual(one.key.key, two.key.key);
	});
});

test("action key: OS/arch change -> different key (override seam)", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x" });
		const recipe = recipeFromYaml("t", baseRecipeYaml(["src/**/*.ts"]));
		const exec = fakeExec({ ...GIT_RESPONSES });
		const one = await keyFor(dir, recipe, exec, { osOverride: "linux@6.1", archOverride: "x64" });
		const two = await keyFor(dir, recipe, exec, { osOverride: "darwin@23.0", archOverride: "arm64" });
		assert.ok(one.ok && two.ok);
		assert.notEqual(one.key.key, two.key.key);
	});
});

test("action key: workbench config / profile / gate schema changes -> different key", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x" });
		const recipe = recipeFromYaml("t", baseRecipeYaml(["src/**/*.ts"]));
		const exec = fakeExec({ ...GIT_RESPONSES });
		const base = await keyFor(dir, recipe, exec);
		assert.ok(base.ok);

		await mkdir(join(dir, ".pi", "workbench"), { recursive: true });
		await writeFile(join(dir, ".pi", "workbench", "project.yaml"), "name: demo\n", "utf8");
		const withConfig = await keyFor(dir, recipe, exec);
		assert.ok(withConfig.ok);
		assert.notEqual(base.key.key, withConfig.key.key);

		const profile = await keyFor(dir, recipe, exec, { profile: "quant-research/stock-selection" });
		assert.ok(profile.ok);
		assert.notEqual(withConfig.key.key, profile.key.key);

		const withGates = await keyFor(dir, recipe, exec, {
			profile: "quant-research/stock-selection",
			projectGates: [{ id: "g1", title: "t", checks: [{ id: "c1", kind: "file", path: "src/a.ts" }] }],
		});
		assert.ok(withGates.ok);
		assert.notEqual(profile.key.key, withGates.key.key);
	});
});

test("action key: upstream action keys chain into the parent key", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x" });
		await mkdir(join(dir, ".pi", "workbench"), { recursive: true });
		const childYaml = { recipes: [{ name: "child", command: ["echo", "c"], cwd: ".", timeout_ms: 10000, cache: { enabled: true, mode: "result-only", inputs: ["src/**/*.ts"] } }] };
		await writeFile(join(dir, ".pi", "workbench", "recipes.yaml"), JSON.stringify(childYaml), "utf8");
		const exec = fakeExec({ ...GIT_RESPONSES });
		const parent = recipeFromYaml("parent", {
			...baseRecipeYaml(["src/**/*.ts"]),
			cache: { ...(baseRecipeYaml(["src/**/*.ts"]).cache ?? {}), upstream: ["child"] },
		});
		const one = await keyFor(dir, parent, exec);
		assert.ok(one.ok);
		assert.equal(one.key.components.upstreamActionKeys.length, 1);
		// Child input change changes the PARENT key (upstream key chained).
		await writeFile(join(dir, "src", "a.ts"), "y", "utf8");
		const two = await keyFor(dir, parent, exec);
		assert.ok(two.ok);
		assert.notEqual(one.key.key, two.key.key);
	});
});

test("action key: upstream cycle / missing upstream refuses the cache", async () => {
	await withTempDir(async (dir) => {
		await writeInputs(dir, { "src/a.ts": "x" });
		await mkdir(join(dir, ".pi", "workbench"), { recursive: true });
		const exec = fakeExec({ ...GIT_RESPONSES });
		const missing = recipeFromYaml("p", { ...baseRecipeYaml([]), cache: { ...(baseRecipeYaml([]).cache ?? {}), upstream: ["nope"] } });
		const refused = await keyFor(dir, missing, exec);
		assert.ok(!refused.ok);
		assert.match(refused.reason, /upstream/);
	});
});

test("cache policy: network/random/source-mutating recipes are denied caching (warning, recipe kept)", () => {
	const result = parseCachePolicy({ enabled: true, inputs: [] }, ["curl", "-s", "https://example.com"], []);
	assert.equal(result.policy.enabled, false);
	assert.ok(result.issues.some((i) => i.includes("network") || i.includes("not cacheable")));

	const random = parseCachePolicy({ enabled: true }, ["date"], []);
	assert.equal(random.policy.enabled, false);

	const npmInstall = parseCachePolicy({ enabled: true }, ["npm", "install"], []);
	assert.equal(npmInstall.policy.enabled, false);

	const sourceWrite = parseCachePolicy({ enabled: true }, ["tsc"], ["src/generated.ts"]);
	assert.equal(sourceWrite.policy.enabled, false);

	const gitApply = parseCachePolicy({ enabled: true }, ["git", "apply", "patch.diff"], []);
	assert.equal(gitApply.policy.enabled, false);

	// Safe commands stay cacheable.
	const safe = parseCachePolicy({ enabled: true, mode: "result-only" }, ["npm", "test"], []);
	assert.equal(safe.policy.enabled, true);
});

test("cache policy: artifacts mode requires outputs; restore disabled in v1", () => {
	const noOutputs = parseCachePolicy({ enabled: true, mode: "artifacts", inputs: [] }, ["tsc"], []);
	assert.equal(noOutputs.policy.enabled, false);
	assert.ok(noOutputs.issues.some((i) => i.includes("outputs")));

	const withOutputs = parseCachePolicy({ enabled: true, mode: "artifacts", inputs: [], outputs: ["dist/**"] }, ["tsc"], []);
	assert.equal(withOutputs.policy.enabled, true);
	assert.ok(withOutputs.issues.some((i) => i.includes("disabled"))); // restore disabled note

	// result-only with outputs: warning, caching still on.
	const ro = parseCachePolicy({ enabled: true, mode: "result-only", inputs: [], outputs: ["dist/**"] }, ["tsc"], []);
	assert.equal(ro.policy.enabled, true);
	assert.ok(ro.issues.some((i) => i.includes("ignored")));
});

test("cache policy: default disabled; enabled must be exactly true", () => {
	const none = parseCachePolicy(undefined, ["tsc"], []);
	assert.equal(none.policy.enabled, false);
	const explicit = parseCachePolicy({ enabled: true, inputs: [] }, ["tsc"], []);
	assert.equal(explicit.policy.enabled, true);
	assert.equal(explicit.policy.successOnly, true);
	const failureOk = parseCachePolicy({ enabled: true, successOnly: false, inputs: [] }, ["tsc"], []);
	assert.equal(failureOk.policy.successOnly, false);
});

test("cache policy: maxAgeSeconds and toolchain declarations validate", () => {
	const badAge = parseCachePolicy({ enabled: true, maxAgeSeconds: -5, inputs: [] }, ["tsc"], []);
	assert.ok(badAge.issues.some((i) => i.includes("maxAgeSeconds")));
	const badTool = parseCachePolicy({ enabled: true, toolchain: ["powershell"], inputs: [] }, ["tsc"], []);
	assert.ok(badTool.issues.some((i) => i.includes("unknown tool")));
	const custom = parseCachePolicy({ enabled: true, toolchain: [{ name: "my_tool", command: ["my-tool", "--version"] }], inputs: [] }, ["tsc"], []);
	assert.equal(custom.policy.toolchain.length, 1);
	assert.equal(custom.policy.toolchain[0]!.name, "my_tool");
	const shellString = parseCachePolicy({ enabled: true, toolchain: [{ name: "bad", command: "my-tool --version" }], inputs: [] }, ["tsc"], []);
	assert.ok(shellString.issues.some((i) => i.includes("argv")));
});

test("recipe schema: cache block parses and violations never drop the recipe", () => {
	const parsed = parseRecipesDocument({
		recipes: [
			{ name: "ok", command: ["npm", "test"], cache: { enabled: true, inputs: ["tests/**/*.ts"], toolchain: ["node"] } },
			{ name: "bad", command: ["curl", "-s", "https://x"], cache: { enabled: true, inputs: [] } },
			{ name: "plain", command: ["echo", "hi"] },
		],
	});
	assert.equal(parsed.errors.length, 0);
	assert.equal(parsed.recipes.length, 3);
	assert.equal(parsed.recipes.find((r) => r.name === "ok")?.cache.enabled, true);
	assert.equal(parsed.recipes.find((r) => r.name === "bad")?.cache.enabled, false);
	assert.equal(parsed.recipes.find((r) => r.name === "plain")?.cache.enabled, false);
	assert.ok(parsed.warnings.some((w) => w.includes("bad") && w.includes("network")));
});
