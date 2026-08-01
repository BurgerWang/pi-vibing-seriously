/**
 * Tests for the path containment guard (P1).
 * Covers: ../ escapes, absolute-path escapes, symlink escapes, and
 * containment of declared writes/artifact globs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { lexicalContain, realpathContained } from "../extensions/workbench-runtime/core/path-guard.ts";
import { withTempDir } from "./helpers.ts";

test("lexical containment allows paths inside the root", async () => {
	await withTempDir(async (dir) => {
		assert.equal(lexicalContain(dir, "."), dir);
		assert.equal(lexicalContain(dir, "scripts"), join(dir, "scripts"));
		assert.equal(lexicalContain(dir, "a/b/c"), join(dir, "a/b/c"));
		assert.equal(lexicalContain(dir, "./x/../y"), join(dir, "y"));
	});
});

test("lexical containment rejects ../ escapes", async () => {
	await withTempDir(async (dir) => {
		assert.equal(lexicalContain(dir, ".."), undefined);
		assert.equal(lexicalContain(dir, "../evil"), undefined);
		assert.equal(lexicalContain(dir, "a/../../evil"), undefined);
		assert.equal(lexicalContain(dir, "a/.."), dir);
	});
});

test("lexical containment rejects absolute paths outside the root", async () => {
	await withTempDir(async (dir) => {
		assert.equal(lexicalContain(dir, "/tmp"), undefined);
		assert.equal(lexicalContain(dir, "/etc/passwd"), undefined);
		assert.equal(lexicalContain(dir, join(dir, "..", "outside")), undefined);
	});
});

test("lexical containment also guards artifact glob patterns", async () => {
	await withTempDir(async (dir) => {
		assert.equal(lexicalContain(dir, "results/*.csv"), join(dir, "results/*.csv"));
		assert.equal(lexicalContain(dir, "results/**/*.json"), join(dir, "results/**/*.json"));
		assert.equal(lexicalContain(dir, "../results/*.csv"), undefined);
		assert.equal(lexicalContain(dir, "/tmp/*.csv"), undefined);
	});
});

test("realpath containment rejects symlinks that point outside the root", async () => {
	await withTempDir(async (dir) => {
		const outside = join(dir, "..", `outside-${Math.random().toString(36).slice(2)}`);
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "secret.txt"), "s3cr3t", "utf8");
		try {
			await symlink(outside, join(dir, "link-out"));
			assert.equal(await realpathContained(dir, "link-out/secret.txt"), undefined);
			assert.equal(await realpathContained(dir, "link-out"), undefined);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

test("realpath containment allows symlinks that stay inside the root", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "real"), { recursive: true });
		await writeFile(join(dir, "real", "f.txt"), "x", "utf8");
		await symlink(join(dir, "real"), join(dir, "link-in"));
		const resolved = await realpathContained(dir, "link-in/f.txt");
		assert.ok(resolved !== undefined);
		assert.equal(resolved, join(dir, "real", "f.txt"));
	});
});

test("realpath containment resolves non-existent deep paths via existing ancestors", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "out"), { recursive: true });
		// Not-yet-created file inside a symlinked directory that escapes.
		const outside = join(dir, "..", `outside2-${Math.random().toString(36).slice(2)}`);
		await mkdir(outside, { recursive: true });
		try {
			await symlink(outside, join(dir, "link2"));
			assert.equal(await realpathContained(dir, "link2/new-file.csv"), undefined);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
		// Plain non-existent path inside the root is fine.
		assert.ok((await realpathContained(dir, "out/future.csv")) !== undefined);
	});
});
