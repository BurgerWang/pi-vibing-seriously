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
 * - The refreshed (v0.9) design is pinned by stable semantic checks — mode
 *   chips, title cursor, tagline/version chip, README/alt consistency —
 *   and importing the generator is side-effect free (no CLI on import).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();

test("LICENSE is MIT and matches package.json", async () => {
	const license = await readFile(join(ROOT, "LICENSE"), "utf8");
	assert.ok(license.startsWith("MIT License"), "LICENSE starts with the MIT title");
	assert.ok(license.includes("Copyright (c) 2026 BurgerWang"), "copyright line present");
	assert.ok(license.includes('THE SOFTWARE IS PROVIDED "AS IS"'), "MIT warranty clause present");
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

test("refreshed banner design: mode chips, title cursor, tagline and version chip", async () => {
	const svg = await readFile(join(ROOT, "assets", "banner.svg"), "utf8");
	const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string };

	// Accessible label names the workbench identity and the package version.
	const ariaMatch = svg.match(/aria-label="([^"]*)"/);
	assert.ok(ariaMatch, "aria-label present");
	const ariaLabel = ariaMatch[1] ?? "";
	assert.ok(ariaLabel.includes("AUDIT / DEV / VERIFY"), "aria-label names the three modes");
	assert.ok(ariaLabel.includes("recipes, gates and evidence"), "aria-label names recipes/gates/evidence");
	assert.ok(ariaLabel.includes(`v${pkg.version}`), "aria-label carries the package version");

	// Three mode chips, each stroked in its own mode color.
	for (const color of ["#7d93b5", "#e8b64c", "#8abeb7"]) {
		assert.ok(svg.includes(`stroke="${color}"`), `mode chip stroke ${color} present`);
	}

	// Terminal cursor block (amber, title-scale 18x63) after the WORKBENCH title.
	assert.ok(/width="18" height="63" fill="#e8b64c"/.test(svg), "title cursor block present");

	// Bottom row: slate tagline, teal checkmark, amber version chip.
	assert.ok(svg.includes('fill="#7d93b5"'), "tagline/AUDIT glyph color present");
	assert.ok(svg.includes('fill="#8abeb7"'), "accent (title/bars/checkmark) color present");
	assert.ok(svg.includes('fill="#e8b64c"'), "cursor/DEV/version glyph color present");
});

test("README banner reference matches the generated banner (alt text and width)", async () => {
	const svg = await readFile(join(ROOT, "assets", "banner.svg"), "utf8");
	const readme = await readFile(join(ROOT, "README.md"), "utf8");

	assert.ok(readme.split("\n").length <= 500, "README stays within the concise 500-line target");

	const svgWidth = svg.match(/<svg[^>]*width="(\d+)"/);
	const aria = svg.match(/aria-label="([^"]*)"/);
	assert.ok(svgWidth && aria, "SVG exposes width and aria-label");

	const img = readme.match(/<img src="assets\/banner\.svg" alt="([^"]*)" width="(\d+)" \/>/);
	assert.ok(img, "README embeds the banner image with alt and width");
	assert.equal(img[1], aria[1], "README alt text equals the SVG aria-label");
	assert.equal(Number(img[2]), Number(svgWidth[1]), "README display width equals the SVG width");
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

test("importing tools/make-banner.mjs is side-effect free; buildBanner matches the banner", () => {
	// A direct import must not execute the CLI (which would write the default
	// output path and print its own line); only `node tools/make-banner.mjs`
	// runs main(). The child also compares fresh buildBanner output against
	// the committed banner (byte-identity — the banner can never drift).
	const script = [
		'import { readFileSync } from "node:fs";',
		'import { join } from "node:path";',
		`import { buildBanner } from ${JSON.stringify(fileURLToPath(new URL("../tools/make-banner.mjs", import.meta.url)))};`,
		'const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));',
		'const committed = readFileSync(join(process.cwd(), "assets", "banner.svg"), "utf8");',
		'const fresh = buildBanner(pkg.version).svg;',
		'const ok = typeof buildBanner === "function" && fresh === committed;',
		'process.stdout.write(ok ? "imported-ok" : "MISMATCH");',
	].join("\n");
	const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 30000,
	});
	assert.equal(run.status, 0, run.stderr || "import exits 0");
	assert.equal(
		run.stdout.trim(),
		"imported-ok",
		"module import must not run the CLI and must match the committed banner",
	);
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
