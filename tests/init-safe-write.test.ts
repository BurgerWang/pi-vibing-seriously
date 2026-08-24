import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	captureInitFileIdentity,
	safelyWriteInitFile,
	type InitWriteFaultPoint,
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
		await chmod(target, 0o640);
		const identity = await captureInitFileIdentity(root, target);
		await safelyWriteInitFile({ projectRoot: root, path: target, content: "updated\n", action: "overwrite", expectedIdentity: identity });
		assert.equal(await readFile(target, "utf8"), "updated\n");
		assert.equal((await stat(target)).mode & 0o7777, 0o640);
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

const FAULT_POINTS: readonly InitWriteFaultPoint[] = [
	"after-temp-create",
	"after-temp-write",
	"after-temp-sync",
	"before-publish",
	"after-publish",
	"after-parent-sync",
];

test("safe init create fault windows expose either no target or the complete new bytes", async () => {
	for (const point of FAULT_POINTS) {
		await withTempDir(async (root) => {
			const target = join(root, ".pi", "workbench", "project.yaml");
			const content = `complete-${point}\n`.repeat(4_096);
			await assert.rejects(
				safelyWriteInitFile(
					{ projectRoot: root, path: target, content, action: "create" },
					{ fault: (current) => {
						if (current === point) throw new Error(`injected:${point}`);
					} },
				),
				new RegExp(`injected:${point}`),
			);
			if (point === "after-publish" || point === "after-parent-sync") {
				assert.equal(await readFile(target, "utf8"), content, point);
			} else {
				await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" }, point);
			}
		});
	}
});

test("safe init overwrite fault windows preserve all old bytes or publish all new bytes", async () => {
	for (const point of FAULT_POINTS) {
		await withTempDir(async (root) => {
			const target = join(root, "AGENTS.md");
			const original = "original-complete\n".repeat(4_096);
			const content = `updated-complete-${point}\n`.repeat(4_096);
			await writeFile(target, original, "utf8");
			const identity = await captureInitFileIdentity(root, target);
			await assert.rejects(
				safelyWriteInitFile(
					{ projectRoot: root, path: target, content, action: "overwrite", expectedIdentity: identity },
					{ fault: (current) => {
						if (current === point) throw new Error(`injected:${point}`);
					} },
				),
				new RegExp(`injected:${point}`),
			);
			assert.equal(
				await readFile(target, "utf8"),
				point === "after-publish" || point === "after-parent-sync" ? content : original,
				point,
			);
		});
	}
});

test("safe init create remains no-clobber when a target appears before publication", async () => {
	await withTempDir(async (root) => {
		const target = join(root, "AGENTS.md");
		await assert.rejects(
			safelyWriteInitFile(
				{ projectRoot: root, path: target, content: "planned\n", action: "create" },
				{ fault: async (point) => {
					if (point === "before-publish") await writeFile(target, "foreign\n", "utf8");
				} },
			),
			/EEXIST/,
		);
		assert.equal(await readFile(target, "utf8"), "foreign\n");
	});
});

test("safe init overwrite rechecks confirmed bytes after the last injectable window", async () => {
	await withTempDir(async (root) => {
		const target = join(root, "AGENTS.md");
		await writeFile(target, "confirmed\n", "utf8");
		const identity = await captureInitFileIdentity(root, target);
		await assert.rejects(
			safelyWriteInitFile(
				{ projectRoot: root, path: target, content: "planned\n", action: "overwrite", expectedIdentity: identity },
				{ fault: async (point) => {
					if (point === "before-publish") await writeFile(target, "external-change\n", "utf8");
				} },
			),
			/INIT_WRITE_TARGET_CHANGED/,
		);
		assert.equal(await readFile(target, "utf8"), "external-change\n");
	});
});

test("safe init cleanup never deletes a foreign replacement at its temporary name", async () => {
	await withTempDir(async (root) => {
		const target = join(root, "AGENTS.md");
		let foreignTemp = "";
		await assert.rejects(
			safelyWriteInitFile(
				{ projectRoot: root, path: target, content: "planned\n", action: "create" },
				{ fault: async (point, paths) => {
					if (point !== "after-temp-create") return;
					foreignTemp = paths.tempPath;
					await unlink(paths.tempPath);
					await writeFile(paths.tempPath, "foreign-temp\n", "utf8");
					throw new Error("injected-foreign-temp");
				} },
			),
			/injected-foreign-temp/,
		);
		assert.equal(await readFile(foreignTemp, "utf8"), "foreign-temp\n");
		await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
	});
});
