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
 * - The refreshed banner design is pinned by stable semantic checks — mode
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
import { parse as parseYaml } from "yaml";

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

test("v0.10.0 release metadata, compatibility and control-plane docs stay synchronized", async () => {
	const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
		version: string;
		scripts: Record<string, string>;
		devDependencies: Record<string, string>;
	};
	const compatibility = JSON.parse(await readFile(join(ROOT, "compatibility", "pi.json"), "utf8")) as {
		package: { version: string };
		pi: { tested_version: string; current_source_target: string };
		current_source_dependencies: Record<string, string>;
		current_source_runtime: { node: string; ci_node_target: string };
	};
	const readme = await readFile(join(ROOT, "README.md"), "utf8");
	const changelog = await readFile(join(ROOT, "CHANGELOG.md"), "utf8");
	const controlPlane = await readFile(join(ROOT, "docs", "context-output-control-plane.md"), "utf8");
	const compatibilityDoc = await readFile(join(ROOT, "docs", "compatibility.md"), "utf8");
	const stablePrefix = await readFile(join(ROOT, "docs", "cache", "stable-prefix-contract.md"), "utf8");
	assert.equal(pkg.version, "0.10.0");
	assert.equal(compatibility.package.version, pkg.version);
	assert.equal(compatibility.pi.tested_version, "0.83.0", "released live baseline remains explicit");
	assert.equal(compatibility.pi.current_source_target, pkg.devDependencies["@earendil-works/pi-coding-agent"]);
	assert.equal(compatibility.current_source_dependencies["@earendil-works/pi-tui"], pkg.devDependencies["@earendil-works/pi-tui"]);
	assert.match(compatibility.current_source_runtime.node, /^v\d+\.\d+\.\d+$/);
	assert.match(compatibility.current_source_runtime.ci_node_target, /configuration only/i);
	assert.match(readme, /pi-dev-workbench v0\.10\.0/);
	assert.match(changelog, /## \[0\.10\.0\] — Context Output Control Plane/);
	assert.match(controlPlane, /12,288 UTF-8 bytes/);
	assert.match(compatibilityDoc, /v0\.10\.0 \(Context Output Control Plane\)/);
	assert.match(compatibilityDoc, /Pi 0\.83\.0/);
	assert.match(controlPlane, /context-output-stress\/context-output-evidence\.json/);
	assert.match(stablePrefix, /1c82f913f7dc0fe6c999ca982db1d714df940dfa09a75165aca5b6a01cd1f8dd/);
	assert.match(stablePrefix, /f58f921761395f57fa4d1c22a9cf7cc2d068fd3bfbd03e16a132a316793cef16/);
	assert.equal(pkg.scripts["test:context-output-stress"], "tsx --test tests/context-output-stress.test.ts");
});

test("ctx1 release gate pins current base prerequisites and final evidence checks", async () => {
	const document = parseYaml(await readFile(join(ROOT, ".pi", "workbench", "gates.yaml"), "utf8")) as {
		gates: Array<{ id: string; prerequisites?: string[]; checks?: Array<{ id: string; kind: string; recipes?: string[]; required?: boolean; blocking?: boolean }> }>;
	};
	const gate = document.gates.find((item) => item.id === "ctx1");
	assert.ok(gate);
	assert.deepEqual(gate.prerequisites, ["b1", "b2", "b3"]);
	assert.deepEqual(gate.checks?.map((check) => [check.id, check.kind, check.recipes ?? [], check.required, check.blocking]), [
		["ctx1.1", "recipe", ["context-output-core-test"], true, true],
		["ctx1.2", "recipe", ["context-output-integration-test"], true, true],
		["ctx1.3", "recipe", ["context-output-stress"], true, true],
		["ctx1.4", "manual", [], true, true],
	]);
});

test("CI uses least privilege and immutable current action revisions", async () => {
	const workflow = await readFile(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
	assert.match(workflow, /permissions:\s*\n\s*contents: read/);
	assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/);
	assert.match(workflow, /persist-credentials: false/);
	assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/);
	assert.match(workflow, /node-version: 24\.x/);
	assert.match(workflow, /npm ci/);
	assert.match(workflow, /npm run check/);
	const dependabot = await readFile(join(ROOT, ".github", "dependabot.yml"), "utf8");
	assert.match(dependabot, /package-ecosystem: github-actions/);
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

test("product banner design: Pi tile, development-first title, delivery line and status chips", async () => {
	const svg = await readFile(join(ROOT, "assets", "banner.svg"), "utf8");
	const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string };

	// Accessible label names the workbench identity and the package version.
	const ariaMatch = svg.match(/aria-label="([^"]*)"/);
	assert.ok(ariaMatch, "aria-label present");
	const ariaLabel = ariaMatch[1] ?? "";
	assert.ok(ariaLabel.includes("development-first Pi workbench"), "aria-label states the product position");
	assert.ok(ariaLabel.includes("Sol and Luna"), "aria-label names the collaboration model");
	assert.ok(ariaLabel.includes("evidence-backed delivery"), "aria-label names the product outcome");
	assert.ok(ariaLabel.includes(`v${pkg.version}`), "aria-label carries the package version");

	assert.ok(/x="32" y="32" width="146" height="150" fill="#121c33"/.test(svg), "Pi product tile present");
	assert.ok(/x="606" y="67" width="14" height="49" fill="#e8b64c"/.test(svg), "terminal cursor present");
	assert.equal((svg.match(/y="190"/g) ?? []).length, 4, "four compact status chips present");
	assert.ok(svg.includes('stroke="#7d93b5"'), "AUDIT/DEV/VERIFY pipeline stroke present");
	assert.ok(svg.includes('stroke="#8abeb7"'), "Pi/Sol/Luna/PASS stroke present");
	assert.ok(svg.includes('stroke="#e8b64c"'), "version stroke present");
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
