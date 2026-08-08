/**
 * Hermetic freeze test for the NRO protocol-v2 input tree
 * (fixtures/commander-native-tool-benchmark-v2/inputs) — the independent
 * v2 copy of the frozen v1 benchmark inputs, machine-checked WITHOUT the
 * benchmark runner and WITHOUT the policy evaluator.
 *
 * Covers, read-only and deterministically:
 *  - v2 inputs has exactly the four pinned direct children, all regular
 *    files or directories, no symlinks
 *  - the v2 fixture tree is walked with lstat/Dirent semantics: symlinks
 *    and any non-regular/non-directory entry fail the walk
 *  - v1 and v2 inputs/fixture realpaths are distinct, while
 *    environment.txt, milestone-prompt.txt and every v2 fixture
 *    regular file are byte-identical to v1 and the fixture relative
 *    file lists are exactly equal — the v2 fixture tree is a strict
 *    byte-copy of v1
 *  - independently recomputed SHA-256 pins (milestone prompt bytes,
 *    deterministic fixture manifest over sorted "<rel>:<sha>\n" rows,
 *    rubric bytes) reproduce the hard-coded lowercase 64-hex constants:
 *    the prompt pin and the fixture manifest both equal the v1 pins
 *    (v2 fixtures are byte-copies of v1); the schema-2 rubric is a
 *    genuine revision whose pin differs from v1
 *  - rubric.json is parsed strictly: root keys exactly checks and
 *    schema_version; schema_version exactly 2; the six checks in frozen
 *    order with exactly id and pattern keys; the patterns are
 *    byte-identical to V2_RUBRIC_CHECKS, the five non-unicode patterns
 *    are byte-identical to the parsed v1 rubric and the unicode pattern
 *    differs exactly as intended; v2 rubric bytes/hash differ from v1
 *  - behavior independent of the policy evaluator: raw RegExp built from
 *    the parsed v2 patterns accept the canonical six-line answer (with
 *    and without a terminal newline) and both spaced/unspaced unicode
 *    comma variants, and reject wrong, missing, reordered and absent
 *    values per-check
 *
 * No fixtures, sources, docs or wiring are modified; no network, process
 * spawning, provider or model involvement. Importing this file pulls the
 * v2 policy module into the typecheck program (tsconfig covers tests/**,
 * not scripts/** directly); that module is a side-effect-free leaf.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";

import { V2_RUBRIC_CHECKS } from "../scripts/commander-native-tool-benchmark-v2-policy.ts";

// ---------------------------------------------------------------------------
// Hermetic paths and frozen pins
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const V1_INPUTS = join(ROOT, "fixtures", "commander-native-tool-benchmark", "inputs");
const V2_INPUTS = join(ROOT, "fixtures", "commander-native-tool-benchmark-v2", "inputs");
const V1_FIXTURE = join(V1_INPUTS, "fixture");
const V2_FIXTURE = join(V2_INPUTS, "fixture");

/** Frozen v1 pins (v1 freeze-test parity). */
const V1_MILESTONE_PROMPT_SHA = "1af10ebb1abfec5aba9744841980da66c9ee8e12720d589caa623350fb608a40";
const V1_FIXTURE_MANIFEST_SHA = "062b3c92a8a36825394f0fa80b94808f2457ca5b63e8bbf9a70ff24339c216b6";
const V1_RUBRIC_SHA = "dccfd406a69f7582a5fc44daad420d8e177c993cf3a7110ae11c6686beab74ed";

/**
 * Hard-frozen v2 pins. The milestone prompt and the fixture tree are
 * byte-copies of v1 and must reproduce the v1 pins; the schema-2 rubric
 * is a genuine revision whose pin is frozen to its actual v2 value and
 * differs from v1.
 */
const V2_MILESTONE_PROMPT_SHA = "1af10ebb1abfec5aba9744841980da66c9ee8e12720d589caa623350fb608a40";
const V2_FIXTURE_MANIFEST_SHA = "062b3c92a8a36825394f0fa80b94808f2457ca5b63e8bbf9a70ff24339c216b6";
const V2_RUBRIC_SHA = "6c223da4c117f4af857be20f1dab43b495f62eced638bfd4a9a2db80e0026046";

function sha256Hex(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * Strict recursive walk with lstat/Dirent semantics: every entry must be
 * a regular file or a directory; a symlink or any other entry type fails
 * the walk. Returns the sorted POSIX-relative paths of all regular files.
 */
async function walkStrict(rootAbs: string): Promise<string[]> {
	const files: string[] = [];
	const walk = async (dirAbs: string, relPrefix: string): Promise<void> => {
		for (const entry of await readdir(dirAbs, { withFileTypes: true })) {
			const rel = relPrefix.length === 0 ? entry.name : `${relPrefix}/${entry.name}`;
			if (entry.isSymbolicLink()) {
				throw new Error(`fixture entry "${rel}" is a symlink`);
			}
			if (entry.isDirectory()) {
				await walk(join(dirAbs, entry.name), rel);
				continue;
			}
			if (!entry.isFile()) {
				throw new Error(`fixture entry "${rel}" is not a regular file or directory`);
			}
			files.push(rel);
		}
	};
	await walk(rootAbs, "");
	return files.sort();
}

/** Deterministic content-manifest hash: SHA-256 over sorted "<rel>:<sha>\n" rows (protocol §5.2). */
async function manifestHashOf(baseDir: string, relFiles: string[]): Promise<string> {
	const rows: string[] = [];
	for (const rel of [...relFiles].sort()) {
		rows.push(`${rel}:${sha256Hex(await readFile(join(baseDir, ...rel.split("/"))))}`);
	}
	return sha256Hex(rows.map((r) => `${r}\n`).join(""));
}

interface RubricV2 {
	schemaVersion: number;
	checks: Array<{ id: string; pattern: string }>;
}

/** Strict rubric parse: exact root keys, exact schema version, six ordered checks with exactly id,pattern keys. */
function parseRubric(raw: Buffer, expectedSchemaVersion: number): RubricV2 {
	const root = JSON.parse(raw.toString("utf8")) as unknown;
	assert.ok(typeof root === "object" && root !== null && !Array.isArray(root), "rubric root must be a JSON object");
	const rootObj = root as Record<string, unknown>;
	assert.deepEqual(
		Object.keys(rootObj).sort(),
		["checks", "schema_version"],
		"rubric root keys must be exactly checks and schema_version",
	);
	assert.equal(rootObj.schema_version, expectedSchemaVersion, `rubric schema_version must be exactly ${expectedSchemaVersion}`);
	assert.ok(Array.isArray(rootObj.checks), "rubric checks must be an array");
	const checks = rootObj.checks as unknown[];
	assert.equal(checks.length, 6, "rubric must have exactly six checks");
	const out: Array<{ id: string; pattern: string }> = [];
	for (const check of checks) {
		assert.ok(typeof check === "object" && check !== null && !Array.isArray(check), "each rubric check must be an object");
		const checkObj = check as Record<string, unknown>;
		assert.deepEqual(Object.keys(checkObj).sort(), ["id", "pattern"], "each rubric check must have exactly id and pattern keys");
		assert.equal(typeof checkObj.id, "string", "check id must be a string");
		assert.equal(typeof checkObj.pattern, "string", "check pattern must be a string");
		out.push({ id: checkObj.id as string, pattern: checkObj.pattern as string });
	}
	return { schemaVersion: rootObj.schema_version as number, checks: out };
}

/** The canonical six-line v2 final answer (no terminal newline). */
const CANONICAL_LINES = [
	"build: alpha-42",
	"unicode: α, 水, 🚀",
	"token: delta-77",
	"needle_occurrences: 140",
	"needle_lines: 135",
	"needle_files: 4",
];
const CANONICAL = CANONICAL_LINES.join("\n");

// ---------------------------------------------------------------------------
// Tree shape and v1 parity
// ---------------------------------------------------------------------------

test("v2 inputs has exactly the four pinned direct children (no symlinks, no special entries)", async () => {
	const entries = await readdir(V2_INPUTS, { withFileTypes: true });
	assert.deepEqual(
		entries
			.map((e) => e.name)
			.sort(),
		["environment.txt", "fixture", "milestone-prompt.txt", "rubric.json"],
		"v2 inputs must contain exactly the four pinned direct children",
	);
	for (const entry of entries) {
		assert.ok(!entry.isSymbolicLink(), `v2 inputs entry "${entry.name}" must not be a symlink`);
		if (entry.name === "fixture") {
			assert.ok(entry.isDirectory(), "v2 inputs \"fixture\" must be a directory");
		} else {
			assert.ok(entry.isFile(), `v2 inputs entry "${entry.name}" must be a regular file`);
		}
	}
});

test("v2 tree mirrors v1 on distinct realpaths with no symlinks or special entries", async () => {
	// Strict walk: a symlink or any non-regular/non-directory entry fails.
	const v1Files = await walkStrict(V1_FIXTURE);
	const v2Files = await walkStrict(V2_FIXTURE);

	// The v2 tree is a real independent copy, never an alias of v1.
	assert.notEqual(await realpath(V1_INPUTS), await realpath(V2_INPUTS), "v1 and v2 inputs directories must be distinct realpaths");
	assert.notEqual(await realpath(V1_FIXTURE), await realpath(V2_FIXTURE), "v1 and v2 fixture directories must be distinct realpaths");

	// The top-level copies are byte-identical.
	for (const name of ["environment.txt", "milestone-prompt.txt"]) {
		const v1Raw = await readFile(join(V1_INPUTS, name));
		const v2Raw = await readFile(join(V2_INPUTS, name));
		assert.equal(Buffer.compare(v1Raw, v2Raw), 0, `${name} must be byte-identical to v1`);
	}

	// The fixture relative file lists are exactly equal.
	assert.deepEqual(v2Files, v1Files, "v2 fixture relative file list must equal v1 exactly");

	// Every v2 fixture regular file is byte-identical to v1, with no
	// exceptions — the v2 fixture tree is a strict byte-copy of v1.
	for (const rel of v2Files) {
		const v1Raw = await readFile(join(V1_FIXTURE, ...rel.split("/")));
		const v2Raw = await readFile(join(V2_FIXTURE, ...rel.split("/")));
		assert.equal(Buffer.compare(v1Raw, v2Raw), 0, `fixture file "${rel}" must be byte-identical to v1`);
	}
});

// ---------------------------------------------------------------------------
// Independent pin recomputation
// ---------------------------------------------------------------------------

test("v2 inputs are frozen: milestone prompt, fixture manifest and rubric reproduce the hard-coded pins", async () => {
	const milestoneSha = sha256Hex(await readFile(join(V2_INPUTS, "milestone-prompt.txt")));
	const fixtureManifest = await manifestHashOf(V2_FIXTURE, await walkStrict(V2_FIXTURE));
	const rubricSha = sha256Hex(await readFile(join(V2_INPUTS, "rubric.json")));

	assert.equal(milestoneSha, V2_MILESTONE_PROMPT_SHA, "v2 milestone-prompt.txt pin drift");
	assert.equal(fixtureManifest, V2_FIXTURE_MANIFEST_SHA, "v2 fixture-manifest pin drift");
	assert.equal(rubricSha, V2_RUBRIC_SHA, "v2 rubric.json pin drift");

	for (const pin of [V2_MILESTONE_PROMPT_SHA, V2_FIXTURE_MANIFEST_SHA, V2_RUBRIC_SHA]) {
		assert.match(pin, /^[0-9a-f]{64}$/, "every v2 pin must be a lowercase 64-hex value");
	}

	// v1 parity: the copied milestone prompt and the byte-copied fixture
	// tree reproduce the v1 pins; the schema-2 rubric is a genuine v2
	// revision whose pin differs from v1.
	assert.equal(milestoneSha, V1_MILESTONE_PROMPT_SHA, "v2 milestone prompt must reproduce the v1 pin");
	assert.equal(fixtureManifest, V1_FIXTURE_MANIFEST_SHA, "v2 fixture manifest pin must equal the v1 pin");
	assert.notEqual(rubricSha, V1_RUBRIC_SHA, "v2 rubric pin must differ from the v1 rubric pin");
});

// ---------------------------------------------------------------------------
// Strict rubric schema and frozen constants
// ---------------------------------------------------------------------------

test("v2 rubric.json is strict schema-2 with the frozen six checks", async () => {
	const v1Raw = await readFile(join(V1_INPUTS, "rubric.json"));
	const v2Raw = await readFile(join(V2_INPUTS, "rubric.json"));
	const v1Rubric = parseRubric(v1Raw, 1);
	const v2Rubric = parseRubric(v2Raw, 2);

	// The six checks are exactly the frozen V2_RUBRIC_CHECKS, in order.
	assert.deepEqual(
		v2Rubric.checks.map((c) => c.id),
		["build", "unicode", "token", "needle_occurrences", "needle_lines", "needle_files"],
		"v2 checks must be the six frozen ids in frozen order",
	);
	assert.deepEqual(v2Rubric.checks, [...V2_RUBRIC_CHECKS], "v2 patterns must match V2_RUBRIC_CHECKS exactly");

	// Five non-unicode patterns are byte-identical to the parsed v1 rubric;
	// the unicode pattern differs exactly as intended (optional whitespace
	// around the commas instead of v1's mandatory ", ").
	for (const check of v2Rubric.checks) {
		const v1Check = v1Rubric.checks.find((c) => c.id === check.id);
		assert.ok(v1Check, `v1 rubric must contain check "${check.id}"`);
		if (check.id === "unicode") {
			assert.equal(
				check.pattern,
				v1Check.pattern.replace(", 水", ",\\s*水").replace(", 🚀", ",\\s*🚀"),
				"v2 unicode pattern must differ from v1 exactly as intended (optional comma whitespace)",
			);
			assert.notEqual(check.pattern, v1Check.pattern, "v2 unicode pattern must differ from v1");
		} else {
			assert.equal(check.pattern, v1Check.pattern, `v2 pattern for "${check.id}" must be byte-identical to v1`);
		}
	}

	// The v2 rubric file is a genuine revision: different bytes and hash.
	assert.notEqual(Buffer.compare(v1Raw, v2Raw), 0, "v2 rubric bytes must differ from v1");
	assert.notEqual(sha256Hex(v2Raw), sha256Hex(v1Raw), "v2 rubric hash must differ from v1");
});

// ---------------------------------------------------------------------------
// Behavior, independent of the policy evaluator (raw RegExp from the file)
// ---------------------------------------------------------------------------

test("v2 rubric behavior: canonical answers pass every check (spaced, unspaced, with and without terminal newline)", async () => {
	const regexes = new Map(
		parseRubric(await readFile(join(V2_INPUTS, "rubric.json")), 2).checks.map((c) => [c.id, new RegExp(c.pattern)]),
	);

	// Every canonical line passes its own check.
	for (const [id, re] of regexes) {
		const line = CANONICAL_LINES.find((l) => l.startsWith(`${id}:`));
		assert.ok(line !== undefined, `canonical line for check "${id}" must exist`);
		assert.equal(re.test(line), true, `check "${id}" must pass its canonical line`);
	}

	// The joined canonical answer passes all six checks, with and without a
	// terminal newline (the rubric's "(?:\s|$)" accepts both).
	for (const text of [CANONICAL, `${CANONICAL}\n`]) {
		for (const [id, re] of regexes) {
			assert.equal(re.test(text), true, `check "${id}" must pass the canonical answer`);
		}
	}

	// Both unicode comma variants pass: spaced and unspaced.
	for (const unicodeLine of ["unicode: α, 水, 🚀", "unicode: α,水,🚀"]) {
		const text = CANONICAL.replace("unicode: α, 水, 🚀", unicodeLine);
		for (const [id, re] of regexes) {
			assert.equal(re.test(text), true, `check "${id}" must pass unicode variant "${unicodeLine}"`);
		}
	}
});

test("v2 rubric behavior: wrong, missing, reordered and absent values fail exactly the relevant check", async () => {
	const regexes = new Map(
		parseRubric(await readFile(join(V2_INPUTS, "rubric.json")), 2).checks.map((c) => [c.id, new RegExp(c.pattern)]),
	);

	const cases: Array<{ label: string; failing: string; text: string }> = [
		{ label: "wrong build value", failing: "build", text: CANONICAL.replace("alpha-42", "alpha-43") },
		{ label: "build value glued to following text", failing: "build", text: CANONICAL.replace("alpha-42", "alpha-42x") },
		{ label: "wrong token value", failing: "token", text: CANONICAL.replace("delta-77", "delta-78") },
		{ label: "wrong occurrences value", failing: "needle_occurrences", text: CANONICAL.replace("needle_occurrences: 140", "needle_occurrences: 141") },
		{ label: "wrong lines value", failing: "needle_lines", text: CANONICAL.replace("needle_lines: 135", "needle_lines: 1350") },
		{ label: "wrong files value", failing: "needle_files", text: CANONICAL.replace("needle_files: 4", "needle_files: 5") },
		{ label: "wrong unicode first value", failing: "unicode", text: CANONICAL.replace("α, 水, 🚀", "β, 水, 🚀") },
		{ label: "wrong unicode third value", failing: "unicode", text: CANONICAL.replace("α, 水, 🚀", "α, 水, 🍕") },
		{ label: "missing unicode third value", failing: "unicode", text: CANONICAL.replace("α, 水, 🚀", "α, 水") },
		{ label: "reordered unicode values", failing: "unicode", text: CANONICAL.replace("α, 水, 🚀", "🚀, α, 水") },
		{ label: "reordered unicode values (2)", failing: "unicode", text: CANONICAL.replace("α, 水, 🚀", "水, α, 🚀") },
		{ label: "absent unicode line", failing: "unicode", text: CANONICAL.replace("unicode: α, 水, 🚀\n", "") },
		{ label: "absent build line", failing: "build", text: CANONICAL.replace("build: alpha-42\n", "") },
		{ label: "absent needle_lines line", failing: "needle_lines", text: CANONICAL.replace("needle_lines: 135\n", "") },
	];
	for (const c of cases) {
		for (const [id, re] of regexes) {
			const expected = id !== c.failing;
			assert.equal(re.test(c.text), expected, `${c.label}: check "${id}" must ${expected ? "pass" : "fail"}`);
		}
	}
});
