/**
 * Release-asset tests (P5 follow-up): MIT license and the pixel-art README
 * banner.
 *
 * - LICENSE exists, is MIT, and matches the package.json license field.
 * - assets/banner.svg is deterministic: regenerating it with
 *   tools/make-banner.mjs must produce byte-identical output, so the banner
 *   can never drift from package.json (it reads the version from there).
 * - The SVG is safe for GitHub rendering: no scripts, no external
 *   references, no foreignObject.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();

test("LICENSE is MIT and matches package.json", async () => {
	const license = await readFile(join(ROOT, "LICENSE"), "utf8");
	assert.ok(license.startsWith("MIT License"), "LICENSE starts with the MIT title");
	assert.ok(license.includes("Copyright (c) 2026 BurgerWang"), "copyright line present");
	assert.ok(license.includes("THE SOFTWARE IS PROVIDED \"AS IS\""), "MIT warranty clause present");
	const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
	assert.equal(pkg.license, "MIT");
});

test("package-lock root entry is consistent with package.json", async () => {
	const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
	const lock = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf8"));
	assert.equal(lock.version, pkg.version);
	assert.equal(lock.packages[""].version, pkg.version);
	assert.equal(lock.packages[""].license, pkg.license);
});

test("EXTENSION_VERSION stays in sync with package.json (version bump guard)", async () => {
	const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string };
	const { EXTENSION_VERSION } = await import("../extensions/workbench-runtime/cache/cache-types.ts");
	assert.equal(
		EXTENSION_VERSION,
		pkg.version,
		"cache-types.ts EXTENSION_VERSION must equal package.json version — telemetry records it per request",
	);
});

test("banner.svg exists, is referenced by the README, and is renderer-safe", async () => {
	const svg = await readFile(join(ROOT, "assets", "banner.svg"), "utf8");
	const readme = await readFile(join(ROOT, "README.md"), "utf8");
	assert.ok(readme.includes("assets/banner.svg"), "README references the banner");
	assert.ok(readme.indexOf("assets/banner.svg") < 1500, "banner is near the top of the README");
	assert.ok(svg.startsWith("<svg"), "SVG root element");
	assert.ok(svg.includes('viewBox="0 0 '), "viewBox present");
	assert.ok(svg.includes('role="img"'), "accessible role");
	assert.ok(!/<script/i.test(svg), "no scripts");
	assert.ok(!/foreignObject/i.test(svg), "no foreignObject");
	assert.ok(!/xlink:href|href="http/i.test(svg), "no external references");
	assert.ok(!/on\w+="/i.test(svg), "no event handlers");
	const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
	assert.ok(svg.includes(`v${pkg.version}`), `banner carries the package version v${pkg.version}`);
});

test("banner generation is deterministic (byte-identical regeneration)", async () => {
	const committed = await readFile(join(ROOT, "assets", "banner.svg"), "utf8");
	const dir = await mkdtemp(join(tmpdir(), "workbench-banner-"));
	try {
		const out = join(dir, "banner.svg");
		const run = spawnSync("node", [join(ROOT, "tools", "make-banner.mjs"), "--out", out], {
			cwd: ROOT,
			encoding: "utf8",
			timeout: 30000,
		});
		assert.equal(run.status, 0, run.stderr || "generator exits 0");
		const regenerated = await readFile(out, "utf8");
		assert.equal(regenerated, committed, "regenerated banner must be byte-identical to the committed one");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("generator preview mode works (--preview) and needs no network", () => {
	const run = spawnSync("node", [join(ROOT, "tools", "make-banner.mjs"), "--preview"], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 30000,
	});
	assert.equal(run.status, 0, run.stderr || "preview exits 0");
	const lines = run.stdout.split("\n");
	assert.ok(lines.length > 10, "preview renders multiple pixel rows");
	assert.ok(run.stdout.includes("####"), "preview contains lit pixel runs");
	assert.ok(run.stdout.includes("#####"), "preview contains full-width glyph rows");
	assert.ok(run.stdout.trim().length > 200, "preview is substantial");
});
