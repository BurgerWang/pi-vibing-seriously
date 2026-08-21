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

const DEFAULT_VISIBLE_SKILLS = [
	"implementation-workflow",
	"debugging-workflow",
	"validation-ladder",
	"repository-audit",
	"quant-research-design",
] as const;

const EXPLICIT_ONLY_SKILLS = [
	"repository-orientation",
	"cli-product-development",
	"handoff-and-release",
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

test("only the five workflow routers are model-visible; specialists are explicit-only", async () => {
	const visible: string[] = [];
	const explicit: string[] = [];
	for (const name of EXPECTED_SKILLS) {
		const content = await readFile(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
		const meta = parseYaml(splitFrontmatter(content).frontmatter) as Record<string, unknown>;
		if (meta["disable-model-invocation"] === true) explicit.push(name);
		else visible.push(name);
	}
	assert.deepEqual(visible.sort(), [...DEFAULT_VISIBLE_SKILLS].sort());
	assert.deepEqual(explicit.sort(), [...EXPLICIT_ONLY_SKILLS].sort());
});

test("main skill instructions stay concise and rely on conditional references", async () => {
	for (const name of EXPECTED_SKILLS) {
		const content = await readFile(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
		const lines = content.split(/\r?\n/).length;
		const words = content.trim().split(/\s+/).length;
		assert.ok(lines <= 55, `${name}: main skill must stay at or below 55 lines (got ${lines})`);
		assert.ok(words <= 350, `${name}: main skill must stay at or below 350 words (got ${words})`);
	}
});

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

test("default skill catalog stays below the prompt budget", async () => {
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const name of DEFAULT_VISIBLE_SKILLS) {
		const filePath = join(SKILLS_DIR, name, "SKILL.md");
		const meta = parseYaml(splitFrontmatter(await readFile(filePath, "utf8")).frontmatter) as Record<string, unknown>;
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(String(meta.name))}</name>`);
		lines.push(`    <description>${escapeXml(String(meta.description))}</description>`);
		lines.push(`    <location>${escapeXml(filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	const catalog = lines.join("\n");
	assert.ok(Buffer.byteLength(catalog, "utf8") <= 3_000, `default skill catalog exceeds 3 KiB (${Buffer.byteLength(catalog, "utf8")} bytes)`);
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

test("prompt templates choose a primary route instead of preloading workflows", async () => {
	for (const name of EXPECTED_PROMPTS) {
		const content = await readFile(join(PROMPTS_DIR, `${name}.md`), "utf8");
		const references = [...content.matchAll(/skill:([a-z0-9-]+)/g)].map((match) => match[1]);
		assert.ok(new Set(references).size <= 2, `${name}: prompt may route to at most two skills`);
	}
});

test("ordinary build and debug prompts never require an unconditional full suite", async () => {
	for (const name of ["q-build", "q-debug"] as const) {
		const text = normalizeSpace(await readFile(join(PROMPTS_DIR, `${name}.md`), "utf8"));
		assert.ok(!/then the full suite|run the full suite\.?$/i.test(text), `${name}: must not require a full suite after every change`);
	}
});

test("prompt filenames do not collide with each other or with extension commands", async () => {
	const entries = await readdir(PROMPTS_DIR);
	const names = entries.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
	assert.equal(new Set(names).size, names.length, "duplicate prompt basenames");

	const runtimeRoot = join(ROOT, "extensions", "workbench-runtime");
	const coreRoot = join(runtimeRoot, "core");
	const runtimeSource = [
		await readFile(join(runtimeRoot, "index.ts"), "utf8"),
		...await Promise.all(
			(await readdir(coreRoot))
				.filter((name) => name.endsWith(".ts"))
				.sort()
				.map((name) => readFile(join(coreRoot, name), "utf8")),
		),
	].join("\n");
	const commands = new Set<string>();
	for (const m of runtimeSource.matchAll(/registerCommand\(\s*"([^"]+)"/g)) {
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

// ----------------------------------------------- fixed Sol -> Luna contract

/** Project templates own the complete policy; workflow resources carry only
 * a hard pointer so the same governance prose is not injected repeatedly. */
const FIXED_SOL_LUNA_AUTHORITIES: ReadonlyArray<readonly [string, string]> = [
	["templates/project/AGENTS.generic.md", "AGENTS.generic template"],
	["templates/project/AGENTS.quant-research.md", "AGENTS.quant-research template"],
];

const FIXED_SOL_LUNA_POINTERS: ReadonlyArray<readonly [string, string]> = [
	["prompts/q-build.md", "q-build prompt"],
	["skills/implementation-workflow/SKILL.md", "implementation-workflow skill"],
];

/** Collapse runs of whitespace so line wrapping can never hide a rule. */
function normalizeSpace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

async function fixedSolLunaText(relPath: string): Promise<string> {
	return normalizeSpace(await readFile(join(ROOT, relPath), "utf8"));
}

test("fixed collaboration authority: routine writes belong to one bounded Luna delegation", async () => {
	const phrases = [
		"Sol owns requirements",
		"Routine source, test, and documentation writes in DEV belong to one bounded Luna delegation",
		"Use one bounded delegation call",
	] as const;
	for (const [relPath, label] of FIXED_SOL_LUNA_AUTHORITIES) {
		const text = await fixedSolLunaText(relPath);
		for (const phrase of phrases) {
			assert.ok(text.includes(phrase), `${label} (${relPath}) must state \"${phrase}\"`);
		}
	}
});

test("fixed collaboration authority: delegation auto-closes and explicit review is recovery-only", async () => {
	const phrases = ["reviewed and closed automatically", "explicit review/status", "recovery", "never acceptance"] as const;
	for (const [relPath, label] of FIXED_SOL_LUNA_AUTHORITIES) {
		const text = await fixedSolLunaText(relPath);
		for (const phrase of phrases) {
			assert.ok(text.includes(phrase), `${label} (${relPath}) must state \"${phrase}\"`);
		}
	}
});

test("fixed collaboration authority: direct Sol writes require an explicit bounded temporary lease", async () => {
	const phrase = "Sol may edit/write directly only through an active user-issued temporary lease";
	for (const [relPath, label] of FIXED_SOL_LUNA_AUTHORITIES) {
		const text = await fixedSolLunaText(relPath);
		assert.ok(text.includes(phrase), `${label} (${relPath}) must state \"${phrase}\"`);
	}
});

test("fixed collaboration authority: focused feedback and one stable-candidate gate pass replace micro-step full verification", async () => {
	const phrases = ["focused tests", "stable candidate", "final gates once"] as const;
	for (const [relPath, label] of FIXED_SOL_LUNA_AUTHORITIES) {
		const text = await fixedSolLunaText(relPath);
		for (const phrase of phrases) {
			assert.ok(text.includes(phrase), `${label} (${relPath}) must state \"${phrase}\"`);
		}
		assert.ok(!text.includes("Delegation is optional"), `${label} must not make routine delegation optional`);
		assert.ok(!text.includes("Ordinary source, test, and documentation edits are direct"), `${label} must not restore direct routine writes`);
	}
});

test("workflow resources point to the fixed collaboration contract without duplicating it", async () => {
	for (const [relPath, label] of FIXED_SOL_LUNA_POINTERS) {
		const text = await fixedSolLunaText(relPath);
		assert.ok(text.includes("fixed Sol -> Luna") || text.includes("fixed Sol → Luna"), `${label} must retain the fixed collaboration pointer`);
		assert.ok(text.includes("mandatory"), `${label} must state that fixed delivery is mandatory`);
		assert.ok(!text.includes("Sol may edit/write directly only through an active user-issued temporary lease"), `${label} must not duplicate the full lease policy`);
		assert.ok(!text.includes("reviewed and closed automatically"), `${label} must not duplicate the full review policy`);
	}
});

test("human documentation cannot become progress or execution authority", async () => {
	const readme = normalizeSpace(await readFile(join(ROOT, "README.md"), "utf8"));
	const delegationDoc = normalizeSpace(await readFile(join(ROOT, "docs/worker-delegation.md"), "utf8"));
	assert.ok(readme.includes("The current runtime and its committed transaction/run records are the product authority"));
	assert.ok(readme.includes("Historical plans, handoffs, benchmark narratives, and compatibility notes"));
	assert.ok(readme.includes("never override current code or create a required development step"));
	assert.ok(delegationDoc.includes("not a progress mirror and records no run ids or verification status"));
	assert.ok(delegationDoc.includes("Current committed transaction/run records and current test output determine observed state"));
});
