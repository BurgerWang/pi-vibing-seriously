/**
 * Frozen-data freeze test for the commander-native-tool benchmark inputs
 * (fixtures/commander-native-tool-benchmark/inputs).
 *
 * Machine-checks every frozen fact the benchmark relies on, independently
 * of the benchmark runner:
 *  - the four production content pins (milestone prompt, fixture-manifest,
 *    non-treatment bundle, rubric) are independently recomputed from the
 *    current files and asserted equal to the frozen FROZEN_NRO_PROTOCOL
 *  - root AGENTS.md is byte-identical to templates/project/AGENTS.generic.md
 *  - inputs/ has exactly the four pinned direct children
 *  - environment.txt is exactly the four pinned lines, no terminal newline
 *  - milestone-prompt.txt has no terminal newline and never pre-answers the
 *    needle facts before the final placeholders
 *  - rubric.json is strict schema with the canonical 140/135/4 patterns,
 *    all matching the canonical six-line answer (and rejecting the
 *    superseded 135/130 values)
 *  - no recursive fixture file contains an `nro-read-facts:` marker
 *  - payloads/large-log.txt exceeds 240 lines / 12288 bytes and its only
 *    delta-77 token occurs after line 240
 *  - meta/build.txt and meta/unicode.txt facts are exact
 *  - image.ppm is a valid ASCII P3 2x2 max-255 image with 12 components
 *  - the search/ census respecting the fixture .ignore contract (`.ignore`
 *    pins search/ignored/, `.gitignore` stays present and hides nothing) is
 *    exactly 140 occurrences / 135 matching lines / 4 files, every
 *    included matching line exceeds 500 UTF-8 bytes, and ignored matches
 *    exist under search/ignored/
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { join, relative, sep } from "node:path";

import { FROZEN_NRO_PROTOCOL, RUNS_PER_ARM, abbaArmAt, abbaPositionsOf, sessionLabel } from "../scripts/commander-native-tool-benchmark.ts";

function sha256Hex(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Recursively collect repository-relative POSIX paths of every regular file under dir. */
async function walkRel(dir: string, rel: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
		const childAbs = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walkRel(childAbs, childRel)));
		else if (entry.isFile()) out.push(childRel);
	}
	return out;
}

/** Deterministic content-manifest hash: sorted '<relPath>:<sha256>\n' rows (protocol §5.2). */
async function manifestHashOf(baseDir: string, relFiles: string[]): Promise<string> {
	const rows: string[] = [];
	for (const rel of [...relFiles].sort()) {
		rows.push(`${rel}:${sha256Hex(await readFile(join(baseDir, ...rel.split("/"))))}`);
	}
	return sha256Hex(rows.map((r) => `${r}\n`).join(""));
}

async function currentBundleHash(): Promise<string> {
	const files: string[] = ["AGENTS.md"];
	for (const sub of ["skills", "prompts", "templates"]) files.push(...(await walkRel(join(ROOT, sub), sub)));
	return manifestHashOf(ROOT, files);
}

test("production protocol is frozen: the four content pins reproduce the frozen inputs", async () => {
	const milestone = sha256Hex(await readFile(join(INPUTS, "milestone-prompt.txt")));
	const fixture = await manifestHashOf(FIXTURE, await walkRel(FIXTURE, ""));
	const bundle = await currentBundleHash();
	const rubric = sha256Hex(await readFile(join(INPUTS, "rubric.json")));

	// Independent recomputation must reproduce the frozen production pins.
	assert.equal(milestone, "1af10ebb1abfec5aba9744841980da66c9ee8e12720d589caa623350fb608a40", "milestone-prompt.txt pin drift");
	assert.equal(fixture, "062b3c92a8a36825394f0fa80b94808f2457ca5b63e8bbf9a70ff24339c216b6", "fixture-manifest pin drift");
	assert.equal(bundle, "7cbb545284d1f69aea04248b41a9466cb3aa53a39e8a6456291d410c59d28738", "non-treatment bundle pin drift");
	assert.equal(rubric, "dccfd406a69f7582a5fc44daad420d8e177c993cf3a7110ae11c6686beab74ed", "rubric.json pin drift");

	// The production protocol is frozen: every pin is a non-null lowercase
	// 64-hex value equal to the independently recomputed pin.
	const pins = [
		FROZEN_NRO_PROTOCOL.milestonePromptSha256,
		FROZEN_NRO_PROTOCOL.fixtureManifestSha256,
		FROZEN_NRO_PROTOCOL.nonTreatmentSha256,
		FROZEN_NRO_PROTOCOL.rubricSha256,
	];
	for (const pin of pins) {
		assert.ok(pin !== null, "every production content pin must be resolved (non-null)");
		assert.match(pin, /^[0-9a-f]{64}$/, "every production content pin must be a lowercase 64-hex value");
	}
	assert.equal(FROZEN_NRO_PROTOCOL.milestonePromptSha256, milestone);
	assert.equal(FROZEN_NRO_PROTOCOL.fixtureManifestSha256, fixture);
	assert.equal(FROZEN_NRO_PROTOCOL.nonTreatmentSha256, bundle);
	assert.equal(FROZEN_NRO_PROTOCOL.rubricSha256, rubric);
});

test("production protocol is frozen: exactly 20 runs per arm in the fixed ABBA order (pre-final refreeze)", () => {
	// The production cohort was refrozen on 2026-08-06 (user-approved, after
	// the DEV pilot and before any final validation collection) from the
	// initial 30/arm target to exactly 20/arm — the plan-permitted floor:
	// 40 final sessions total, fixed ABBA order.
	assert.equal(RUNS_PER_ARM, 20, "RUNS_PER_ARM must be exactly 20");
	assert.equal(FROZEN_NRO_PROTOCOL.runsPerArm, 20, "frozen protocol runsPerArm must be exactly 20");
	assert.equal(FROZEN_NRO_PROTOCOL.interleave, "ABBA", "frozen protocol interleave must be ABBA");
	const control = abbaPositionsOf("control");
	const treatment = abbaPositionsOf("treatment");
	assert.equal(control.length, 20, "ABBA control positions must be exactly 20");
	assert.equal(treatment.length, 20, "ABBA treatment positions must be exactly 20");
	assert.deepEqual(
		[...control, ...treatment].sort((a, b) => a - b),
		Array.from({ length: 40 }, (_, i) => i + 1),
		"ABBA must span exactly the 40 final positions 1..40",
	);
	assert.equal(abbaArmAt(1), "control");
	assert.equal(abbaArmAt(2), "treatment");
	assert.equal(abbaArmAt(3), "treatment");
	assert.equal(abbaArmAt(4), "control");
	assert.equal(abbaArmAt(39), "treatment");
	assert.equal(abbaArmAt(40), "control");
	assert.equal(sessionLabel("control", 20), "control-20");
	assert.equal(sessionLabel("treatment", 20), "treatment-20");
});

const ROOT = process.cwd();
const INPUTS = join(ROOT, "fixtures", "commander-native-tool-benchmark", "inputs");
const FIXTURE = join(INPUTS, "fixture");
const SEARCH = join(FIXTURE, "search");

const NEEDLE = "needle";

/** Recursively list all files under dir (full paths). */
async function walkFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await walkFiles(p)));
		else if (entry.isFile()) files.push(p);
	}
	return files;
}

/** Count non-overlapping literal occurrences of `sub` in `text`. */
function countLiteral(text: string, sub: string): number {
	let n = 0;
	let from = 0;
	for (;;) {
		const i = text.indexOf(sub, from);
		if (i === -1) return n;
		n += 1;
		from = i + sub.length;
	}
}

interface Census {
	occurrences: number;
	matchingLines: number;
	files: number;
	matchingLineBytes: number[];
}

/** Literal needle census over the given files (reads them fully). */
async function census(files: string[]): Promise<Census> {
	const result: Census = { occurrences: 0, matchingLines: 0, files: 0, matchingLineBytes: [] };
	for (const file of files) {
		const text = await readFile(file, "utf8");
		const occurrences = countLiteral(text, NEEDLE);
		if (occurrences === 0) continue;
		result.occurrences += occurrences;
		result.files += 1;
		for (const line of text.split("\n")) {
			if (line.includes(NEEDLE)) {
				result.matchingLines += 1;
				result.matchingLineBytes.push(Buffer.byteLength(line, "utf8"));
			}
		}
	}
	return result;
}

/** Fixture-relative path segments of a file inside the fixture tree. */
function fixtureSegments(p: string): string[] {
	return relative(FIXTURE, p).split(sep);
}

/** True when the path sits under search/ignored/ (the .ignore contract). */
function isIgnored(p: string): boolean {
	const segs = fixtureSegments(p);
	return segs[0] === "search" && segs[1] === "ignored";
}

test("root AGENTS.md is byte-identical to templates/project/AGENTS.generic.md", async () => {
	const rootAgents = await readFile(join(ROOT, "AGENTS.md"));
	const template = await readFile(join(ROOT, "templates", "project", "AGENTS.generic.md"));
	assert.equal(
		Buffer.compare(rootAgents, template),
		0,
		"AGENTS.md must equal templates/project/AGENTS.generic.md byte-for-byte",
	);
});

test("inputs has exactly the four pinned direct children", async () => {
	const children = (await readdir(INPUTS)).sort();
	assert.deepEqual(children, ["environment.txt", "fixture", "milestone-prompt.txt", "rubric.json"]);
});

test("environment.txt is exactly the four pinned lines with no terminal newline", async () => {
	const env = await readFile(join(INPUTS, "environment.txt"), "utf8");
	assert.equal(
		env,
		"model_key: openai-codex/gpt-5.6-sol\n" +
			"thinking_level: high\n" +
			"pi_version: 0.83.0\n" +
			"node_version: v26.4.0",
	);
});

test("milestone-prompt.txt has no terminal newline and does not pre-answer the needle facts", async () => {
	const prompt = await readFile(join(INPUTS, "milestone-prompt.txt"), "utf8");
	assert.ok(!prompt.endsWith("\n"), "milestone-prompt.txt must not end with a newline");
	const templateLines = [
		"build: <value from step 1>",
		"unicode: <values from step 2, comma-separated, in file order>",
		"token: <value from step 3>",
		"needle_occurrences: <exact occurrence count from step 4>",
		"needle_lines: <exact matching-line count from step 4>",
		"needle_files: <exact distinct-file count from step 4>",
	];
	const lines = prompt.split("\n");
	for (const t of templateLines) {
		assert.ok(lines.includes(t), `prompt must contain the final-answer template line: ${t}`);
	}
	// The needle facts must be discovered by the model, never stated up front.
	assert.ok(
		!/needle_(?:occurrences|lines|files):\s*\d/.test(prompt),
		"prompt must not pre-answer the needle facts before the final placeholders",
	);
});

test("rubric.json is strict schema with canonical 140/135/4 patterns matching the six-line answer", async () => {
	const raw = await readFile(join(INPUTS, "rubric.json"), "utf8");
	const rubric = JSON.parse(raw) as { schema_version: number; checks: Array<{ id: string; pattern: string }> };
	assert.deepEqual(Object.keys(rubric).sort(), ["checks", "schema_version"]);
	assert.equal(rubric.schema_version, 1);
	assert.ok(Array.isArray(rubric.checks));
	assert.equal(rubric.checks.length, 6);
	const ids = ["build", "unicode", "token", "needle_occurrences", "needle_lines", "needle_files"];
	assert.deepEqual(
		rubric.checks.map((c) => c.id),
		ids,
	);
	for (const check of rubric.checks) {
		assert.deepEqual(Object.keys(check).sort(), ["id", "pattern"], `check ${check.id} must be strict`);
	}
	const canonical: Record<string, string> = {
		build: "build: alpha-42",
		unicode: "unicode: α, 水, 🚀",
		token: "token: delta-77",
		needle_occurrences: "needle_occurrences: 140",
		needle_lines: "needle_lines: 135",
		needle_files: "needle_files: 4",
	};
	for (const check of rubric.checks) {
		const line = canonical[check.id];
		assert.ok(line !== undefined, `canonical line missing for check ${check.id}`);
		assert.ok(new RegExp(check.pattern).test(line), `pattern for ${check.id} must match the canonical line`);
	}
	// The corrected canonical values: occurrences accepts 140 and rejects the
	// superseded 135; lines accepts 135 and rejects the superseded 130.
	const superseded: Record<string, string> = {
		needle_occurrences: "needle_occurrences: 135",
		needle_lines: "needle_lines: 130",
	};
	for (const check of rubric.checks) {
		const bad = superseded[check.id];
		if (bad === undefined) continue;
		assert.ok(!new RegExp(check.pattern).test(bad), `pattern for ${check.id} must reject the superseded value`);
	}
});

test("no recursive fixture file contains an nro-read-facts marker", async () => {
	for (const file of await walkFiles(FIXTURE)) {
		const text = await readFile(file, "utf8");
		assert.ok(
			!text.includes("nro-read-facts:"),
			`${relative(FIXTURE, file)} must not contain a continuation-facts marker`,
		);
	}
});

test("large-log.txt exceeds 240 lines / 12288 bytes with a single delta-77 token after line 240", async () => {
	const text = await readFile(join(FIXTURE, "payloads", "large-log.txt"), "utf8");
	const lines = text.split("\n");
	assert.ok(lines.length > 240, `large-log.txt must have more than 240 lines (got ${lines.length})`);
	assert.ok(Buffer.byteLength(text, "utf8") > 12288, "large-log.txt must exceed 12288 bytes");
	assert.equal(countLiteral(text, "delta-77"), 1, "delta-77 must occur exactly once");
	const hit = lines.findIndex((l) => l.includes("delta-77")) + 1;
	assert.ok(hit > 240, `delta-77 must occur after line 240 (found at line ${hit})`);
});

test("build and unicode facts are exact", async () => {
	const build = await readFile(join(FIXTURE, "meta", "build.txt"), "utf8");
	assert.deepEqual(
		build.split("\n").filter((l) => l.length > 0),
		["alpha-42"],
	);
	const unicode = await readFile(join(FIXTURE, "meta", "unicode.txt"), "utf8");
	assert.deepEqual(
		unicode.split("\n").filter((l) => l.length > 0),
		["greek_alpha: α", "cjk_water: 水", "emoji_rocket: 🚀"],
	);
});

test("image.ppm is a valid ASCII P3 2x2 max-255 image with 12 pixel components", async () => {
	const ppm = await readFile(join(FIXTURE, "image.ppm"), "utf8");
	const tokens = ppm.trim().split(/\s+/);
	assert.equal(tokens.length, 16, "P3 header (4 tokens) plus 12 pixel components");
	assert.equal(tokens[0], "P3");
	assert.equal(tokens[1], "2");
	assert.equal(tokens[2], "2");
	assert.equal(tokens[3], "255");
	const pixels = tokens.slice(4);
	assert.equal(pixels.length, 12);
	for (const v of pixels) {
		assert.match(v, /^(?:0|[1-9]\d*)$/, `pixel component must be an integer, got ${v}`);
		assert.ok(Number(v) <= 255, `pixel component ${v} must not exceed maxval 255`);
	}
	assert.deepEqual(pixels, ["255", "0", "0", "0", "255", "0", "0", "0", "255", "255", "255", "255"]);
});

test("search census: exactly 140 occurrences / 135 matching lines / 4 files, long lines, ignored matches exist", async () => {
	const ignoreFile = await readFile(join(FIXTURE, ".ignore"), "utf8");
	assert.ok(
		ignoreFile.split("\n").includes("search/ignored/"),
		"fixture .ignore must pin search/ignored/",
	);
	const gitignore = await readFile(join(FIXTURE, ".gitignore"), "utf8");
	assert.ok(
		!gitignore.split("\n").includes("search/ignored/"),
		"fixture .gitignore must not hide the search/ignored/ corpus",
	);

	const allTxt = (await walkFiles(SEARCH)).filter((p) => p.endsWith(".txt"));
	const includedFiles: string[] = [];
	const ignoredFiles: string[] = [];
	for (const p of allTxt) (isIgnored(p) ? ignoredFiles : includedFiles).push(p);

	assert.equal(includedFiles.length, 4, "search/ must contain exactly four nonignored .txt files");
	const included = await census(includedFiles);
	assert.equal(included.occurrences, 140, "nonignored search files must contain exactly 140 needle occurrences");
	assert.equal(included.matchingLines, 135, "nonignored search files must contain exactly 135 matching lines");
	assert.equal(included.files, 4, "needle matches must span exactly four files");
	for (const bytes of included.matchingLineBytes) {
		assert.ok(bytes > 500, `every included matching line must exceed 500 UTF-8 bytes (got ${bytes})`);
	}

	assert.ok(ignoredFiles.length >= 1, "ignored matches must exist under search/ignored/");
	const ignored = await census(ignoredFiles);
	assert.ok(ignored.occurrences > 0, "ignored files must contain needle matches");
	assert.ok(ignored.matchingLines > 0, "ignored files must contain matching lines");

	const hidden = join(FIXTURE, "search", "ignored", "hidden.txt");
	const hiddenText = await readFile(hidden, "utf8");
	const hiddenLines = hiddenText.split("\n").filter((l) => l.length > 0);
	assert.ok(hiddenLines.length >= 10, `hidden.txt must have at least 10 lines (got ${hiddenLines.length})`);
	assert.ok(countLiteral(hiddenText, NEEDLE) > 10, "hidden.txt must contain more than 10 needle occurrences");
});
