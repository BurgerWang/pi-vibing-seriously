import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	captureInitFileIdentity,
	safelyWriteInitFile,
} from "../extensions/workbench-runtime/core/init-safe-write.ts";
import { withTempDir } from "./helpers.ts";

test("safe init create is exclusive and never follows a leaf symlink", async () => {
	await withTempDir(async (root) => {
		const target = join(root, ".pi", "workbench", "project.yaml");
		await safelyWriteInitFile({ projectRoot: root, path: target, content: "first\n", action: "create" });
		await assert.rejects(
			safelyWriteInitFile({ projectRoot: root, path: target, content: "second\n", action: "create" }),
			/EEXIST|INIT_WRITE/,
		);
		assert.equal(await readFile(target, "utf8"), "first\n");

		const outside = join(root, "outside.txt");
		await writeFile(outside, "outside\n", "utf8");
		const link = join(root, "AGENTS.md");
		await symlink(outside, link);
		await assert.rejects(
			safelyWriteInitFile({ projectRoot: root, path: link, content: "replacement\n", action: "create" }),
		);
		assert.equal(await readFile(outside, "utf8"), "outside\n");
	});
});

test("safe init overwrite binds the confirmation to the same current bytes", async () => {
	await withTempDir(async (root) => {
		const target = join(root, "AGENTS.md");
		await writeFile(target, "original\n", "utf8");
		const identity = await captureInitFileIdentity(root, target);
		await safelyWriteInitFile({ projectRoot: root, path: target, content: "updated\n", action: "overwrite", expectedIdentity: identity });
		assert.equal(await readFile(target, "utf8"), "updated\n");
	});
});

test("safe init overwrite refuses content drift and symlink replacement", async () => {
	await withTempDir(async (root) => {
		const target = join(root, "AGENTS.md");
		await writeFile(target, "original\n", "utf8");
		const identity = await captureInitFileIdentity(root, target);
		await writeFile(target, "changed after confirmation\n", "utf8");
		await assert.rejects(
			safelyWriteInitFile({ projectRoot: root, path: target, content: "unsafe\n", action: "overwrite", expectedIdentity: identity }),
			/INIT_WRITE_TARGET_CHANGED/,
		);
		assert.equal(await readFile(target, "utf8"), "changed after confirmation\n");

		const outside = join(root, "outside.txt");
		await writeFile(outside, "outside\n", "utf8");
		await writeFile(target, "recapture\n", "utf8");
		const replacementIdentity = await captureInitFileIdentity(root, target);
		await import("node:fs/promises").then(({ unlink }) => unlink(target));
		await symlink(outside, target);
		await assert.rejects(
			safelyWriteInitFile({ projectRoot: root, path: target, content: "unsafe\n", action: "overwrite", expectedIdentity: replacementIdentity }),
		);
		assert.equal(await readFile(outside, "utf8"), "outside\n");
	});
});

test("safe init create rejects a symlinked parent escape", async () => {
	await withTempDir(async (root) => {
		const outside = join(root, "outside");
		await mkdir(outside);
		await symlink(outside, join(root, ".pi"));
		await assert.rejects(
			safelyWriteInitFile({
				projectRoot: root,
				path: join(root, ".pi", "workbench", "project.yaml"),
				content: "blocked\n",
				action: "create",
			}),
			/INIT_WRITE_UNSAFE_PARENT/,
		);
		await assert.rejects(readFile(join(outside, "workbench", "project.yaml"), "utf8"));
	});
});
