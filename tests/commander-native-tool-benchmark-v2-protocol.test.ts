/**
 * Hermetic pre-collection freeze test for the NRO protocol-v2 contract
 * (scripts/commander-native-tool-benchmark-v2-protocol.ts +
 * docs/baselines/commander-native-tool-benchmark-protocol-v2.md).
 *
 * Read-only and deterministic; no fixtures, no writes, no network, no
 * process spawning, no provider/model involvement. Covers:
 *
 *   - the exact frozen constants: schema/protocol versions, cohort
 *     (20/arm, ABBA, exactly 40 valid, max 60 successfully-started paid
 *     attempts, nearest-rank p90 = 18th of 20), frozen environment, the
 *     four content pins, the four efficiency thresholds and labels, and
 *     the two policy identities
 *   - v2 output paths are distinct from the v1 constants (no aliases,
 *     no reuse), while the byte-copied pins (prompt, fixture,
 *     non-treatment) and the environment reproduce the v1 values and
 *     the schema-2 rubric pin differs from v1's
 *   - 20/arm under the frozen ABBA interleave spans exactly the 40
 *     positions 1..40, and nearest-rank p90 is rank 18 of 20
 *   - the protocol module is pure data: a single erased `import type`
 *     (never loading the v1 harness), no node built-ins, no process/
 *     console/fetch usage, and no function exports — importing it has
 *     no side effects
 *   - the protocol-v2 doc exists and carries the machine-checkable
 *     normative phrases (schema/protocol versions, pins, paths,
 *     attribution/error/orphan semantics, rubric facts, thresholds,
 *     release blockers, v1 immutability, authorization, NOT_RUN
 *     constraints) and contains no contradictions: no v1 output names,
 *     no v1 rubric pin, and none of the erroneous 25%/125% threshold
 *     values
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";

import {
	ARMS,
	ATTRIBUTION_POLICY_IDENTITY,
	BENCHMARK_SCHEMA_VERSION,
	BYTES_MEDIAN_REDUCTION_MIN_PCT,
	COLLECTION_RECORD_NAME,
	COLLECTION_ROOT_NAME,
	COLLECTION_SCHEMA_VERSION,
	CORRECTNESS_POLICY_IDENTITY,
	DEVIATIONS_NAME,
	DEVIATIONS_SCHEMA_VERSION,
	EVIDENCE_DIR_NAME,
	FROZEN_ENVIRONMENT,
	FROZEN_NRO_V2_PROTOCOL,
	GROSS_MEDIAN_REDUCTION_MIN_PCT,
	GROSS_P90_MAX_CONTROL_PCT,
	INPUTS_DIR,
	INTERLEAVE,
	MANIFEST_NAME,
	MAX_PAID_ATTEMPTS,
	NRO_FACTS_MARKER,
	P90_NEAREST_RANK,
	PHASES,
	PROTOCOL_DOC,
	PROTOCOL_VERSION,
	REQUESTS_MEDIAN_NON_INCREASE,
	RUNS_PER_ARM,
	STAGING_PREFIX,
	TOTAL_VALID_RUNS,
	VERDICT_IDS,
} from "../scripts/commander-native-tool-benchmark-v2-protocol.ts";

import {
	BENCHMARK_SCHEMA_VERSION as V1_SCHEMA_VERSION,
	COLLECTION_SCHEMA_VERSION as V1_COLLECTION_SCHEMA_VERSION,
	EVIDENCE_DIR_NAME as V1_EVIDENCE_DIR_NAME,
	FROZEN_NRO_PROTOCOL,
	MANIFEST_NAME as V1_MANIFEST_NAME,
	STAGING_PREFIX as V1_STAGING_PREFIX,
} from "../scripts/commander-native-tool-benchmark.ts";

// The v1 final-collection output root (a v1 constant from the FINAL
// collector); imported for the no-alias check, never executed.
import { OUTPUT_ROOT_NAME as V1_COLLECTION_ROOT_NAME } from "../scripts/commander-native-tool-final-collect.ts";

const ROOT = process.cwd();
const PROTOCOL_SOURCE = join(ROOT, "scripts", "commander-native-tool-benchmark-v2-protocol.ts");
const PROTOCOL_V2_DOC = join(ROOT, PROTOCOL_DOC);

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Frozen v1 rubric pin — the v2 schema-2 rubric pin must differ from it. */
const V1_RUBRIC_SHA = "dccfd406a69f7582a5fc44daad420d8e177c993cf3a7110ae11c6686beab74ed";

// ---------------------------------------------------------------------------
// Frozen constants
// ---------------------------------------------------------------------------

test("protocol-v2: exact schema/protocol versions and cohort constants", () => {
	assert.equal(BENCHMARK_SCHEMA_VERSION, 2, "manifest schema_version must be exactly 2");
	assert.equal(COLLECTION_SCHEMA_VERSION, 2, "collection-record schema_version must be exactly 2");
	assert.equal(DEVIATIONS_SCHEMA_VERSION, 2, "deviations-record schema_version must be exactly 2");
	assert.equal(PROTOCOL_VERSION, 2, "protocol_version must be exactly 2");
	assert.equal(PROTOCOL_DOC, "docs/baselines/commander-native-tool-benchmark-protocol-v2.md", "protocol doc path drift");

	assert.equal(RUNS_PER_ARM, 20, "runs per arm must be exactly 20");
	assert.equal(TOTAL_VALID_RUNS, 40, "total valid runs must be exactly 40");
	assert.equal(MAX_PAID_ATTEMPTS, 60, "max paid attempts must be exactly 60");
	assert.equal(INTERLEAVE, "ABBA", "interleave must be ABBA");
	assert.equal(P90_NEAREST_RANK, 18, "nearest-rank p90 must be the 18th of 20");
	assert.equal(NRO_FACTS_MARKER, "nro-read-facts:", "preview facts marker drift");

	assert.deepEqual(ARMS, ["control", "treatment"], "arms drift");
	assert.deepEqual(PHASES, ["dev", "final"], "phases drift");
	assert.deepEqual(
		VERDICT_IDS,
		["bytes_median_reduction", "gross_median_reduction", "requests_median_non_increase", "gross_p90_regression"],
		"verdict ids (labels) drift",
	);
	assert.equal(ATTRIBUTION_POLICY_IDENTITY, "tool_call_id_exact_v2", "attribution policy identity drift");
	assert.equal(CORRECTNESS_POLICY_IDENTITY, "six_fact_semantic_v2", "correctness policy identity drift");
});

test("protocol-v2: exact frozen environment and the four content pins", () => {
	assert.deepEqual(FROZEN_ENVIRONMENT, {
		modelKey: "openai-codex/gpt-5.6-sol",
		thinkingLevel: "high",
		piVersion: "0.83.0",
		nodeVersion: "v26.4.0",
	}, "frozen environment drift");

	assert.equal(
		FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256,
		"1af10ebb1abfec5aba9744841980da66c9ee8e12720d589caa623350fb608a40",
		"milestone prompt pin drift",
	);
	assert.equal(
		FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256,
		"062b3c92a8a36825394f0fa80b94808f2457ca5b63e8bbf9a70ff24339c216b6",
		"fixture manifest pin drift",
	);
	assert.equal(
		FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256,
		"d8ae301a2050004b6f93da1aec9871496fe07b307d9cca8808ad4369ea365b78",
		"non-treatment bundle pin drift",
	);
	assert.equal(
		FROZEN_NRO_V2_PROTOCOL.rubricSha256,
		"6c223da4c117f4af857be20f1dab43b495f62eced638bfd4a9a2db80e0026046",
		"schema-2 rubric pin drift",
	);
	for (const pin of [
		FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256,
		FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256,
		FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256,
		FROZEN_NRO_V2_PROTOCOL.rubricSha256,
	]) {
		assert.match(pin, SHA256_RE, "every v2 pin must be a lowercase 64-hex value");
	}
	assert.equal(FROZEN_NRO_V2_PROTOCOL.runsPerArm, RUNS_PER_ARM, "frozen protocol runsPerArm must equal RUNS_PER_ARM");
	assert.equal(FROZEN_NRO_V2_PROTOCOL.interleave, INTERLEAVE, "frozen protocol interleave must equal INTERLEAVE");
	assert.deepEqual(FROZEN_NRO_V2_PROTOCOL.environment, FROZEN_ENVIRONMENT, "frozen protocol environment must equal FROZEN_ENVIRONMENT");
});

test("protocol-v2: byte-copied pins and environment reproduce v1; schema-2 rubric pin differs", () => {
	assert.equal(FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256, FROZEN_NRO_PROTOCOL.milestonePromptSha256, "v2 prompt is a byte-copy of v1");
	assert.equal(FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256, FROZEN_NRO_PROTOCOL.fixtureManifestSha256, "v2 fixture tree is a byte-copy of v1");
	assert.equal(FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256, FROZEN_NRO_PROTOCOL.nonTreatmentSha256, "v2 non-treatment bundle equals v1");
	assert.notEqual(FROZEN_NRO_V2_PROTOCOL.rubricSha256, FROZEN_NRO_PROTOCOL.rubricSha256, "the schema-2 rubric pin must differ from the v1 rubric pin");
	assert.notEqual(FROZEN_NRO_V2_PROTOCOL.rubricSha256, V1_RUBRIC_SHA, "the schema-2 rubric pin must differ from the frozen v1 rubric pin value");
	assert.deepEqual(FROZEN_NRO_V2_PROTOCOL.environment, FROZEN_NRO_PROTOCOL.environment, "the frozen environment is identical to v1");
	assert.equal(FROZEN_NRO_V2_PROTOCOL.runsPerArm, FROZEN_NRO_PROTOCOL.runsPerArm, "runs per arm unchanged from v1");
	assert.equal(FROZEN_NRO_V2_PROTOCOL.interleave, FROZEN_NRO_PROTOCOL.interleave, "interleave unchanged from v1");
});

test("protocol-v2: the four efficiency thresholds and labels", () => {
	assert.equal(BYTES_MEDIAN_REDUCTION_MIN_PCT, 50, "successful-inline-byte median reduction threshold must be >= 50%");
	assert.equal(GROSS_MEDIAN_REDUCTION_MIN_PCT, 20, "gross-token median reduction threshold must be >= 20%");
	assert.equal(REQUESTS_MEDIAN_NON_INCREASE, "treatment_median_le_control", "requests median rule must be treatment <= control");
	assert.equal(GROSS_P90_MAX_CONTROL_PCT, 105, "treatment gross p90 must be <= 105% of control");
	assert.equal(VERDICT_IDS.length, 4, "exactly four verdict labels");
});

// ---------------------------------------------------------------------------
// v2 output path isolation (no aliases to v1)
// ---------------------------------------------------------------------------

test("protocol-v2: exact v2 output paths and inputs path", () => {
	assert.equal(COLLECTION_ROOT_NAME, "commander-native-tool-v2-final-collection", "v2 collection root drift");
	assert.equal(EVIDENCE_DIR_NAME, "commander-native-tool-benchmark-v2", "v2 evidence root drift");
	assert.equal(MANIFEST_NAME, "commander-native-tool-benchmark-v2-manifest.json", "v2 manifest name drift");
	assert.equal(STAGING_PREFIX, ".nro-v2-prepare-staging-", "v2 staging prefix drift");
	assert.equal(COLLECTION_RECORD_NAME, "collection-record.json", "v2 collection record name drift");
	assert.equal(DEVIATIONS_NAME, "collection-deviations.json", "v2 deviations record name drift");
	assert.equal(INPUTS_DIR, "fixtures/commander-native-tool-benchmark-v2/inputs", "v2 inputs path drift");
});

test("protocol-v2: v2 output paths differ from the v1 constants (no aliases, no reuse)", () => {
	assert.notEqual(COLLECTION_ROOT_NAME, V1_COLLECTION_ROOT_NAME, "v2 collection root must differ from the v1 collection root");
	assert.notEqual(EVIDENCE_DIR_NAME, V1_EVIDENCE_DIR_NAME, "v2 evidence root must differ from the v1 evidence root");
	assert.notEqual(MANIFEST_NAME, V1_MANIFEST_NAME, "v2 manifest name must differ from the v1 manifest name");
	assert.notEqual(STAGING_PREFIX, V1_STAGING_PREFIX, "v2 staging prefix must differ from the v1 staging prefix");

	// Stronger than inequality for the prefix: the v2 prefix must not even
	// contain the v1 prefix, so staged paths can never collide.
	assert.ok(!STAGING_PREFIX.includes(V1_STAGING_PREFIX), "v2 staging prefix must not contain the v1 staging prefix");
	assert.ok(!MANIFEST_NAME.includes(V1_MANIFEST_NAME), "v2 manifest name must not contain the v1 manifest name");
	assert.ok(!COLLECTION_ROOT_NAME.includes(V1_COLLECTION_ROOT_NAME), "v2 collection root must not contain the v1 collection root");

	// The v2 schema version is a fresh version, never the v1 schema.
	assert.notEqual(BENCHMARK_SCHEMA_VERSION, V1_SCHEMA_VERSION, "v2 manifest schema_version must differ from v1");
	assert.notEqual(COLLECTION_SCHEMA_VERSION, V1_COLLECTION_SCHEMA_VERSION, "v2 collection schema_version must differ from v1");
	assert.notEqual(PROTOCOL_DOC, "docs/baselines/commander-native-tool-benchmark-protocol.md", "v2 protocol doc must differ from the v1 doc path");
});

// ---------------------------------------------------------------------------
// ABBA cohort and nearest-rank p90 (independently recomputed)
// ---------------------------------------------------------------------------

test("protocol-v2: 20/arm under frozen ABBA spans exactly the 40 positions; nearest-rank p90 is 18/20", () => {
	assert.equal(INTERLEAVE, "ABBA", "the frozen interleave is ABBA");
	const armAt = (position: number): "control" | "treatment" => {
		const r = (position - 1) % 4;
		return r === 0 || r === 3 ? "control" : "treatment";
	};
	const control: number[] = [];
	const treatment: number[] = [];
	for (let i = 1; i <= 2 * RUNS_PER_ARM; i += 1) {
		if (armAt(i) === "control") control.push(i);
		else treatment.push(i);
	}
	assert.equal(control.length, RUNS_PER_ARM, "ABBA control positions must be exactly 20");
	assert.equal(treatment.length, RUNS_PER_ARM, "ABBA treatment positions must be exactly 20");
	assert.equal(control.length + treatment.length, TOTAL_VALID_RUNS, "ABBA must span exactly 40 positions");
	assert.deepEqual(
		[...control, ...treatment].sort((a, b) => a - b),
		Array.from({ length: TOTAL_VALID_RUNS }, (_, i) => i + 1),
		"ABBA must cover exactly the 40 positions 1..40",
	);
	assert.equal(armAt(1), "control");
	assert.equal(armAt(2), "treatment");
	assert.equal(armAt(3), "treatment");
	assert.equal(armAt(4), "control");
	assert.equal(armAt(39), "treatment");
	assert.equal(armAt(40), "control");
	assert.equal(Math.ceil(0.9 * RUNS_PER_ARM), 18, "nearest-rank p90 rank is ceil(0.9 x 20) = 18");
	assert.equal(P90_NEAREST_RANK, 18, "the frozen p90 rank is the 18th smallest of 20");
});

// ---------------------------------------------------------------------------
// Import purity: the module is constants/types only
// ---------------------------------------------------------------------------

test("protocol-v2 module import has no side effects: type-only import, no IO, data exports only", async () => {
	const source = await readFile(PROTOCOL_SOURCE, "utf8");

	// The only import is a single erased `import type` from the v1
	// protocol module — the v1 harness is never loaded or executed.
	assert.match(
		source,
		/^import type \{ FrozenEnvironment, FrozenProtocol \} from "\.\/commander-native-tool-benchmark\.ts";$/m,
		"the module must import only the FrozenEnvironment/FrozenProtocol types from v1",
	);
	assert.doesNotMatch(source, /^import\s+(?!type\b)/m, "every import statement must be `import type` (no runtime imports)");
	assert.doesNotMatch(source, /from "node:/, "no node built-in imports");
	assert.doesNotMatch(source, /process\.|console\.|require\(|fetch\(|import\.meta|child_process/, "no process/console/network/child-process usage");

	// Every exported value is data (string | number | object): the module
	// exports no functions, classes, or executable behavior.
	const exports_: unknown[] = [
		BENCHMARK_SCHEMA_VERSION,
		COLLECTION_SCHEMA_VERSION,
		DEVIATIONS_SCHEMA_VERSION,
		PROTOCOL_VERSION,
		PROTOCOL_DOC,
		RUNS_PER_ARM,
		TOTAL_VALID_RUNS,
		MAX_PAID_ATTEMPTS,
		INTERLEAVE,
		P90_NEAREST_RANK,
		NRO_FACTS_MARKER,
		ARMS,
		PHASES,
		COLLECTION_ROOT_NAME,
		EVIDENCE_DIR_NAME,
		MANIFEST_NAME,
		STAGING_PREFIX,
		COLLECTION_RECORD_NAME,
		DEVIATIONS_NAME,
		INPUTS_DIR,
		ATTRIBUTION_POLICY_IDENTITY,
		CORRECTNESS_POLICY_IDENTITY,
		VERDICT_IDS,
		BYTES_MEDIAN_REDUCTION_MIN_PCT,
		GROSS_MEDIAN_REDUCTION_MIN_PCT,
		REQUESTS_MEDIAN_NON_INCREASE,
		GROSS_P90_MAX_CONTROL_PCT,
		FROZEN_ENVIRONMENT,
		FROZEN_NRO_V2_PROTOCOL,
	];
	for (const value of exports_) {
		assert.ok(
			typeof value === "string" || typeof value === "number" || typeof value === "object",
			"every protocol-v2 export must be a data value, never a function",
		);
	}
});

// ---------------------------------------------------------------------------
// Normative doc: coverage (required phrases) and contradiction absence
// ---------------------------------------------------------------------------

test("protocol-v2 doc exists and freezes the normative contract (required phrases)", async () => {
	const doc = await readFile(PROTOCOL_V2_DOC, "utf8");

	const required: string[] = [
		// Status: offline freeze only; no cohort; this phase.
		"no v2 cohort has been collected",
		"prepared and frozen offline only",
		"collection, prepare, and formal analyze are not run in this phase",
		// v1 immutability.
		"N4 FAIL",
		"DO NOT ADOPT",
		"never reinterpreted",
		"never promoted",
		"cannot be re-analyzed under v2",
		"fresh v2 cohort",
		// Authorization and NOT_RUN constraints.
		"explicit user authorization",
		"N2b",
		"N3",
		"NOT_RUN",
		// Schema/protocol versions in both records.
		'"schema_version": 2',
		'"protocol_version": 2',
		"strict unknown-key rejection",
		// Paths and inputs.
		PROTOCOL_DOC,
		COLLECTION_ROOT_NAME,
		EVIDENCE_DIR_NAME,
		MANIFEST_NAME,
		STAGING_PREFIX,
		COLLECTION_RECORD_NAME,
		DEVIATIONS_NAME,
		INPUTS_DIR,
		// Environment.
		"openai-codex/gpt-5.6-sol",
		"0.83.0",
		"v26.4.0",
		// Pins.
		FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256 as string,
		FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256 as string,
		FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256 as string,
		FROZEN_NRO_V2_PROTOCOL.rubricSha256 as string,
		// Cohort shape.
		"20 per arm",
		"exactly 40 valid",
		"ABBA repeated 10 times",
		"18th smallest",
		"zero compactions",
		"same current runtime source",
		"unrepresentable",
		"hard-fail",
		// Attribution / error / orphan semantics.
		ATTRIBUTION_POLICY_IDENTITY,
		"toolCallId",
		"orphan_read_calls",
		"error_read_results",
		"isError",
		"fresh ID",
		"fail closed",
		"exactly once",
		"nine fields",
		"complete=false",
		"complete=true",
		"reached complete",
		"misuse",
		// Marker contract.
		NRO_FACTS_MARKER,
		// Correctness rubric.
		CORRECTNESS_POLICY_IDENTITY,
		"alpha-42",
		"delta-77",
		"needle_occurrences: 140",
		"needle_lines: 135",
		"needle_files: 4",
		"α, 水, 🚀",
		"α,水,🚀",
		"reordered",
		"all 20 treatment runs must pass",
		"20/20",
		// Thresholds and release blockers.
		"≥ 50%",
		"≥ 20%",
		"≤ 105%",
		"20 × t ≤ 21 × c",
		"treatment ≤ control",
		"edit/write tool calls",
		"release blockers",
		// Descriptive-only claims.
		"no causal",
		"significance",
		// Verdict labels.
		...VERDICT_IDS,
	];

	// Whitespace-normalized for matching: markdown line wraps inside a
	// phrase (e.g. "fresh\nID") must not break the check.
	const docNorm = doc.replace(/\s+/g, " ").toLowerCase();

	for (const phrase of required) {
		assert.ok(
			docNorm.includes(phrase.toLowerCase()),
			`protocol-v2 doc must contain the normative phrase: ${phrase}`,
		);
	}
});

test("protocol-v2 doc contains no v1 output names, no v1 rubric pin, and no erroneous 25%/125% threshold values", async () => {
	const doc = await readFile(PROTOCOL_V2_DOC, "utf8");
	// Whitespace-normalized form catches line-wrapped v1 names too.
	const docNorm = doc.replace(/\s+/g, " ");

	// v1 output names must never appear (v2 paths are independent).
	for (const v1Name of [
		V1_MANIFEST_NAME,
		V1_COLLECTION_ROOT_NAME,
		V1_STAGING_PREFIX,
		V1_EVIDENCE_DIR_NAME + "/",
	]) {
		assert.ok(!docNorm.includes(v1Name), `protocol-v2 doc must not contain the v1 output name: ${v1Name}`);
	}
	// The v1 evidence-dir token, when not part of a v2/-protocol name.
	assert.doesNotMatch(doc, /commander-native-tool-benchmark(?![-\w])/, "protocol-v2 doc must not contain the bare v1 evidence-dir token");
	// The v1 rubric pin (schema-1) must never be cited.
	assert.ok(!docNorm.includes(V1_RUBRIC_SHA), "protocol-v2 doc must not contain the v1 rubric pin");
	// The erroneous v2 threshold values (gross >= 25%, p90 <= 125%) must
	// not appear — the frozen v2 values are the unchanged v1 values
	// (gross >= 20% with exact (Σc − Σt) × 1000 >= 200 × Σc, p90 <= 105%
	// with exact 20 × t <= 21 × c).
	assert.ok(!docNorm.includes("25%"), "protocol-v2 doc must not contain the erroneous 25% gross threshold");
	assert.ok(!docNorm.includes("125%"), "protocol-v2 doc must not contain the erroneous 125% p90 threshold");
	assert.ok(!docNorm.includes("250 × Σc"), "protocol-v2 doc must not contain the erroneous 250 × Σc gross arithmetic");
	assert.ok(!docNorm.includes("4 × t ≤ 5 × c"), "protocol-v2 doc must not contain the erroneous 4 × t ≤ 5 × c p90 arithmetic");
	// The doc must never claim that a v2 collection was performed, dated,
	// or measured (only the frozen negative statements are allowed).
	assert.doesNotMatch(docNorm, /\b(was|were)\s+collected\b/, "protocol-v2 doc must not claim a completed collection");
	assert.ok(!docNorm.includes("collected on "), "protocol-v2 doc must not date a collection");
});
