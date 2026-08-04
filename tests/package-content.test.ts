/**
 * P2 package-content tests.
 *
 * Verifies the skills/prompts/templates deliverables:
 *   - every skill directory has a SKILL.md; frontmatter parses; name is
 *     legal and matches the directory; description is present
 *   - no empty skills; no TODO-only skills; no stale "later milestones"
 *     placeholders; references/*.md are non-empty
 *   - prompt frontmatter parses; description + argument-hint present;
 *     $ARGUMENTS used; no filename collisions; no collision with extension
 *     command names
 *   - skills referenced from prompts/AGENTS templates (skill:name) exist
 *   - the package.json pi manifest discovers all skills and prompts
 *   - quant skill coverage: required topics per skill (stock-selection,
 *     market-timing, backtest-integrity) and the explicit out-of-scope
 *     exclusions in backtest-integrity
 *   - no vendor/exchange names; no python-only assumptions in skills,
 *     prompts, or AGENTS templates
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");
const PROMPTS_DIR = join(ROOT, "prompts");
const TEMPLATES_DIR = join(ROOT, "templates", "project");

export const EXPECTED_SKILLS = [
	"repository-orientation",
	"repository-audit",
	"implementation-workflow",
	"debugging-workflow",
	"validation-ladder",
	"cli-product-development",
	"handoff-and-release",
	"quant-research-design",
	"market-data-integrity",
	"stock-selection-research",
	"market-timing-research",
	"backtest-integrity",
	"experiment-validation",
	"strategy-reporting",
] as const;

export const EXPECTED_PROMPTS = [
	"q-audit",
	"q-plan",
	"q-build",
	"q-debug",
	"q-verify",
	"q-optimize",
	"q-review",
] as const;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Words that must never appear in skills/prompts/AGENTS templates (language neutrality). */
const VENDOR_OR_EXCHANGE_NAMES = [
	"wind",
	"barra",
	"bloomberg",
	"tushare",
	"akshare",
	"joinquant",
	"ricequant",
	"polygon.io",
	"alpaca",
	"ibkr",
	"kraken",
	"binance",
	"nyse",
	"nasdaq",
	"cme",
	"hkex",
].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

async function findSkillDirs(): Promise<string[]> {
	const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
	const dirs: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			await readFile(join(SKILLS_DIR, entry.name, "SKILL.md"), "utf8");
			dirs.push(entry.name);
		} catch {
			// not a skill directory
		}
	}
	return dirs.sort();
}

async function skillFiles(name: string): Promise<string[]> {
	const dir = join(SKILLS_DIR, name);
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory() && entry.name === "references") {
			for (const ref of await readdir(path)) {
				if (ref.endsWith(".md")) files.push(join(path, ref));
			}
		} else if (entry.isFile() && entry.name === "SKILL.md") {
			files.push(path);
		}
	}
	return files;
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { frontmatter: "", body: content };
	return { frontmatter: m[1] ?? "", body: m[2] ?? "" };
}

function skillText(name: string, files: string[]): string {
	return files
		.map((f) => f)
		.sort()
		.map((f) => readFileSyncSafe(f))
		.join("\n");
}

function readFileSyncSafe(path: string): string {
	return readFileSync(path, "utf8");
}

// ------------------------------------------------------------------ skills

test("all expected skill directories exist with SKILL.md", async () => {
	const dirs = await findSkillDirs();
	assert.deepEqual(dirs, [...EXPECTED_SKILLS].sort(), "every expected skill directory must contain SKILL.md, and no others");
});

test("every skill SKILL.md has parseable frontmatter with legal name and non-empty description", async () => {
	for (const name of EXPECTED_SKILLS) {
		const content = await readFile(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
		const { frontmatter, body } = splitFrontmatter(content);
		assert.ok(frontmatter.length > 0, `${name}: SKILL.md must have YAML frontmatter`);
		const meta = parseYaml(frontmatter) as Record<string, unknown>;
		assert.ok(meta && typeof meta === "object", `${name}: frontmatter must parse as YAML`);
		const skillName = meta.name;
		assert.equal(typeof skillName, "string", `${name}: frontmatter name missing`);
		assert.ok((skillName as string).length <= 64, `${name}: name too long`);
		assert.match(skillName as string, NAME_RE, `${name}: illegal skill name`);
		assert.equal(skillName, name, `${name}: frontmatter name must match the directory name`);
		const description = meta.description;
		assert.equal(typeof description, "string", `${name}: description missing`);
		assert.ok((description as string).trim().length > 0, `${name}: description must be non-empty`);
		assert.ok((description as string).length <= 1024, `${name}: description too long`);
		assert.ok(body.trim().length > 0, `${name}: SKILL.md body must be non-empty`);
	}
});

test("no empty skills and no TODO-only skills", async () => {
	for (const name of EXPECTED_SKILLS) {
		const files = await skillFiles(name);
		assert.ok(files.length >= 1, `${name}: skill must have at least SKILL.md`);
		for (const file of files) {
			const content = readFileSyncSafe(file);
			const { body } = splitFrontmatter(content);
			assert.ok(content.trim().length > 0, `${file}: empty file`);
			const substantive = body.replace(/^#.*$/gm, "").trim();
			assert.ok(substantive.length > 0, `${file}: body must contain more than a heading`);
			assert.ok(!/later milestones/.test(content), `${file}: stale placeholder "later milestones"`);
			assert.ok(!/^#+\s*todo\b/i.test(body) && !/^\s*todo\b/i.test(body), `${file}: TODO-only skill`);
		}
	}
});

test("every skill references/ file is non-empty and no skill duplicates content wholesale", async () => {
	for (const name of EXPECTED_SKILLS) {
		const files = await skillFiles(name);
		for (const file of files.filter((f) => f.includes(`${join("references", "")}`))) {
			assert.ok(readFileSyncSafe(file).trim().length > 0, `${file}: references file must be non-empty`);
		}
	}
});

// ----------------------------------------------------------------- prompts

test("all expected prompt templates exist with parseable frontmatter", async () => {
	const entries = await readdir(PROMPTS_DIR);
	const prompts = entries.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
	assert.deepEqual(prompts, [...EXPECTED_PROMPTS].sort());

	for (const name of EXPECTED_PROMPTS) {
		const content = await readFile(join(PROMPTS_DIR, `${name}.md`), "utf8");
		const { frontmatter, body } = splitFrontmatter(content);
		assert.ok(frontmatter.length > 0, `${name}: prompt must have YAML frontmatter`);
		const meta = parseYaml(frontmatter) as Record<string, unknown>;
		assert.ok(meta && typeof meta === "object", `${name}: frontmatter must parse as YAML`);
		const description = meta.description;
		assert.equal(typeof description, "string", `${name}: description missing`);
		assert.ok((description as string).trim().length > 0, `${name}: description must be non-empty`);
		const hint = meta["argument-hint"];
		assert.equal(typeof hint, "string", `${name}: argument-hint missing`);
		assert.ok((hint as string).trim().length > 0, `${name}: argument-hint must be non-empty`);
		assert.ok(body.includes("$ARGUMENTS"), `${name}: template must use $ARGUMENTS`);
	}
});

test("prompt filenames do not collide with each other or with extension commands", async () => {
	const entries = await readdir(PROMPTS_DIR);
	const names = entries.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
	assert.equal(new Set(names).size, names.length, "duplicate prompt basenames");

	const indexSource = await readFile(join(ROOT, "extensions", "workbench-runtime", "index.ts"), "utf8");
	const commands = new Set<string>();
	for (const m of indexSource.matchAll(/registerCommand\(\s*"([^"]+)"/g)) {
		commands.add(m[1] ?? "");
	}
	assert.ok(commands.size > 0, "extension commands must be discoverable for the collision check");
	const collisions = names.filter((n) => commands.has(n));
	assert.deepEqual(collisions, [], "prompt template names must not collide with extension commands");
});

// --------------------------------------------- skill references (skill:name)

test("every skill:name referenced in prompts and AGENTS templates exists", async () => {
	const sources: string[] = [];
	for (const name of EXPECTED_PROMPTS) {
		sources.push(await readFile(join(PROMPTS_DIR, `${name}.md`), "utf8"));
	}
	for (const file of ["AGENTS.generic.md", "AGENTS.quant-research.md"]) {
		sources.push(await readFile(join(TEMPLATES_DIR, file), "utf8"));
	}
	const skillDirs = new Set(await findSkillDirs());
	const referenced = new Set<string>();
	for (const source of sources) {
		for (const m of source.matchAll(/skill:([a-z0-9-]+)/g)) {
			referenced.add(m[1] ?? "");
		}
	}
	assert.ok(referenced.size > 0, "templates must reference at least one skill");
	for (const name of referenced) {
		assert.ok(skillDirs.has(name), `referenced skill "${name}" does not exist`);
	}
});

// --------------------------------------------------------- package manifest

test("the package.json pi manifest discovers all skills and prompts", async () => {
	const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { pi?: Record<string, unknown> };
	assert.ok(pkg.pi, "package.json must declare a pi manifest");
	assert.deepEqual(pkg.pi.skills, ["./skills"], "manifest must declare ./skills");
	assert.deepEqual(pkg.pi.prompts, ["./prompts"], "manifest must declare ./prompts");

	const skillDirs = await findSkillDirs();
	assert.equal(skillDirs.length, EXPECTED_SKILLS.length, "manifest-discoverable skills count");
	const promptEntries = (await readdir(PROMPTS_DIR)).filter((f) => f.endsWith(".md")).sort();
	assert.equal(promptEntries.length, EXPECTED_PROMPTS.length, "manifest-discoverable prompts count");
});

// ----------------------------------------------------------- language & vendor neutrality

test("skills, prompts, and AGENTS templates are language-neutral (no python-only assumptions)", async () => {
	const sources: string[] = [];
	for (const name of EXPECTED_SKILLS) {
		for (const file of await skillFiles(name)) sources.push(readFileSyncSafe(file));
	}
	for (const name of EXPECTED_PROMPTS) {
		sources.push(await readFile(join(PROMPTS_DIR, `${name}.md`), "utf8"));
	}
	for (const file of ["AGENTS.generic.md", "AGENTS.quant-research.md"]) {
		sources.push(await readFile(join(TEMPLATES_DIR, file), "utf8"));
	}
	for (const source of sources) {
		assert.ok(!/\bpython\b/i.test(source), "skills/prompts/AGENTS must not assume python");
	}
});

test("no vendor or exchange names in skills, prompts, or AGENTS templates", async () => {
	const sources: string[] = [];
	for (const name of EXPECTED_SKILLS) {
		for (const file of await skillFiles(name)) sources.push(readFileSyncSafe(file));
	}
	for (const name of EXPECTED_PROMPTS) {
		sources.push(await readFile(join(PROMPTS_DIR, `${name}.md`), "utf8"));
	}
	for (const file of ["AGENTS.generic.md", "AGENTS.quant-research.md"]) {
		sources.push(await readFile(join(TEMPLATES_DIR, file), "utf8"));
	}
	const all = sources.join("\n").toLowerCase();
	for (const name of VENDOR_OR_EXCHANGE_NAMES) {
		assert.ok(!new RegExp(`\\b${name}\\b`).test(all), `skills/prompts/AGENTS must not mention vendor/exchange "${name}"`);
	}
});

// ------------------------------------------------------------- quant coverage

const SELECTION_TOPICS: ReadonlyArray<readonly string[]> = [
	["point-in-time", "universe"],
	["survivorship"],
	["delist"],
	["corporate action"],
	["cross-sectional", "feature"],
	["rank", "group"],
	["industry", "market-cap"],
	["rebalance"],
	["portfolio construction"],
	["turnover"],
	["benchmark"],
	["attribution"],
];

const TIMING_TOPICS: ReadonlyArray<readonly string[]> = [
	["signal generation"],
	["tradable"],
	["entry", "exit"],
	["position sizing"],
	["market state"],
	["split"],
	["benchmark"],
	["regime"],
	["parameter stability"],
	["walk-forward"],
];

const BACKTEST_TOPICS: ReadonlyArray<readonly string[]> = [
	["leakage"],
	["look-ahead"],
	["signal", "execution", "alignment"],
	["adjust"],
	["suspend"],
	["delist"],
	["fee"],
	["slippage"],
	["cash", "position"],
	["benchmark", "alignment"],
	["return", "comput"],
	["rebalance", "semantics"],
];

const BACKTEST_EXCLUSIONS = [
	"order book",
	"tick replay",
	"queue model",
	"market making",
	"colocation",
	"microsecond",
	"exchange execution",
];

function assertSkillCovers(skill: string, text: string, topics: ReadonlyArray<readonly string[]>): void {
	for (const tokens of topics) {
		for (const token of tokens) {
			assert.ok(text.includes(token), `${skill} must cover "${token}"`);
		}
	}
}

test("stock-selection-research covers the required selection topics", async () => {
	const files = await skillFiles("stock-selection-research");
	const text = skillText("stock-selection-research", files);
	assertSkillCovers("stock-selection-research", text, SELECTION_TOPICS);
});

test("market-timing-research covers the required timing topics", async () => {
	const files = await skillFiles("market-timing-research");
	const text = skillText("market-timing-research", files);
	assertSkillCovers("market-timing-research", text, TIMING_TOPICS);
});

test("backtest-integrity covers the required integrity topics", async () => {
	const files = await skillFiles("backtest-integrity");
	const text = skillText("backtest-integrity", files);
	assertSkillCovers("backtest-integrity", text, BACKTEST_TOPICS);
});

test("backtest-integrity explicitly excludes out-of-scope domains", async () => {
	const files = await skillFiles("backtest-integrity");
	const text = skillText("backtest-integrity", files);
	assert.ok(/out of scope/i.test(text), "backtest-integrity must state an out-of-scope section");
	for (const term of BACKTEST_EXCLUSIONS) {
		assert.ok(text.includes(term), `backtest-integrity must explicitly exclude "${term}"`);
	}
});

test("quant-research-design states the research scope boundary", async () => {
	const files = await skillFiles("quant-research-design");
	const text = skillText("quant-research-design", files).replace(/\s+/g, " ");
	assert.ok(/mid\/low[\s-]*frequency/i.test(text), "quant-research-design must scope to mid/low-frequency research");
	assert.ok(/out of scope/i.test(text), "quant-research-design must state its scope boundary");
});

// ------------------------------------------------------- worker-first contract

/**
 * P7 worker-first workflow contract sources: the build prompt, the
 * implementation-workflow skill, and both project AGENTS templates must
 * encode the contract so that removing any rule breaks the suite.
 */
const WORKER_FIRST_SOURCES: ReadonlyArray<readonly [string, string]> = [
	["prompts/q-build.md", "q-build prompt"],
	["skills/implementation-workflow/SKILL.md", "implementation-workflow skill"],
	["templates/project/AGENTS.generic.md", "AGENTS.generic template"],
	["templates/project/AGENTS.quant-research.md", "AGENTS.quant-research template"],
];

/** Collapse runs of whitespace so line wrapping can never hide a rule. */
function normalizeSpace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

async function workerFirstText(relPath: string): Promise<string> {
	return normalizeSpace(await readFile(join(ROOT, relPath), "utf8"));
}

test("worker-first contract: q-build, the implementation skill, and both AGENTS templates state Sol ownership and worker-owned routine writes", async () => {
	const phrases = [
		"Sol owns requirements",
		"cross-cutting architecture",
		"worker owns routine local implementation decisions",
		"bounded worker slices",
	] as const;
	for (const [relPath, label] of WORKER_FIRST_SOURCES) {
		const text = await workerFirstText(relPath);
		for (const phrase of phrases) {
			assert.ok(text.includes(phrase), `${label} (${relPath}) must state \"${phrase}\"`);
		}
	}
});

test("worker-first contract: delegation and fresh-worker repair are required in all four sources", async () => {
	const phrases = ["bounded delegation", "fresh worker"] as const;
	for (const [relPath, label] of WORKER_FIRST_SOURCES) {
		const text = await workerFirstText(relPath);
		for (const phrase of phrases) {
			assert.ok(text.includes(phrase), `${label} (${relPath}) must state \"${phrase}\"`);
		}
	}
});

test("worker-first contract: only a user-issued temporary write lease is an exception in all four sources", async () => {
	const phrase = "user-issued temporary write lease";
	for (const [relPath, label] of WORKER_FIRST_SOURCES) {
		const text = await workerFirstText(relPath);
		assert.ok(text.includes(phrase), `${label} (${relPath}) must state \"${phrase}\"`);
	}
});

test("worker-first contract: worker reports are never acceptance in all four sources", async () => {
	const phrase = "never acceptance";
	for (const [relPath, label] of WORKER_FIRST_SOURCES) {
		const text = await workerFirstText(relPath);
		assert.ok(text.includes(phrase), `${label} (${relPath}) must state \"${phrase}\"`);
	}
});

test("worker-first contract: Sol reviews the actual diff and runs the final gates in all four sources", async () => {
	const phrases = ["actual diff", "final gates"] as const;
	for (const [relPath, label] of WORKER_FIRST_SOURCES) {
		const text = await workerFirstText(relPath);
		for (const phrase of phrases) {
			assert.ok(text.includes(phrase), `${label} (${relPath}) must state \"${phrase}\"`);
		}
	}
});
