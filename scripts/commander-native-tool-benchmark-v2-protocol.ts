/**
 * NRO protocol-v2 frozen constants (commander-native-tool-optimization
 * plan) — PURE offline constants/types only, no behavior.
 *
 * This module freezes the pre-collection protocol-v2 contract defined
 * normatively in `docs/baselines/commander-native-tool-benchmark-
 * protocol-v2.md`: the schema/protocol version, the cohort shape (20/arm
 * ABBA, exactly 40 valid, max 60 successfully-started paid attempts),
 * the frozen environment, the four content pins, the four efficiency
 * thresholds, the two policy identities, and the independent v2 output
 * paths (collection root, evidence root, manifest, staging prefix).
 *
 * Side-effect-free by construction: the only import is a TYPE import
 * from the v1 protocol module — `import type` is erased at compile
 * time, so the v1 harness module is never loaded or executed when this
 * module is imported. This module performs no filesystem, network, or
 * process work and exports only data constants and types (no
 * functions, no classes, no CLI, no top-level executable statements).
 *
 * v1 preservation: protocol v2 never modifies, renames, reuses, or
 * aliases any v1 protocol constant, evidence path, result record, or
 * plan; the v1 N4 FAIL / DO NOT ADOPT result stays immutable and is
 * never reinterpreted or promoted.
 */

import type { FrozenEnvironment, FrozenProtocol } from "./commander-native-tool-benchmark.ts";

// ---------------------------------------------------------------------------
// Schema / protocol version (protocol-v2 doc §3.1)
// ---------------------------------------------------------------------------

/** Strict v2 manifest schema version — exactly 2 (protocol-v2 doc §5). */
export const BENCHMARK_SCHEMA_VERSION = 2;
/** Strict v2 collection-record schema version — exactly 2 (protocol-v2 doc §5). */
export const COLLECTION_SCHEMA_VERSION = 2;
/** v2 deviations-record schema version — exactly 2. */
export const DEVIATIONS_SCHEMA_VERSION = 2;
/** Normative protocol version carried by both v2 records — exactly 2. */
export const PROTOCOL_VERSION = 2;
/** Normative protocol-v2 document path (the `protocol_doc` value in v2 records). */
export const PROTOCOL_DOC = "docs/baselines/commander-native-tool-benchmark-protocol-v2.md";

// ---------------------------------------------------------------------------
// Cohort (protocol-v2 doc §3.1/§4)
// ---------------------------------------------------------------------------

/** Exactly 20 valid sessions per arm (frozen). */
export const RUNS_PER_ARM = 20;
/** Exactly 40 valid final sessions (20 control + 20 treatment, frozen). */
export const TOTAL_VALID_RUNS = 40;
/** Hard cap: at most 60 successfully-started paid attempts (frozen). */
export const MAX_PAID_ATTEMPTS = 60;
/** Frozen interleave: ABBA repeated 10 times over positions 1..40. */
export const INTERLEAVE = "ABBA" as const;
/** Nearest-rank gross p90 rank: ceil(0.9 × 20) = the 18th smallest of 20 (frozen). */
export const P90_NEAREST_RANK = 18;
/** Frozen preview-facts marker (the v1 §8.4 contract, shared with the v2 policy module). */
export const NRO_FACTS_MARKER = "nro-read-facts:";

export const ARMS = ["control", "treatment"] as const;
export type ArmName = (typeof ARMS)[number];
export const PHASES = ["dev", "final"] as const;
export type Phase = (typeof PHASES)[number];

// ---------------------------------------------------------------------------
// Independent v2 output paths (protocol-v2 doc §3.1/§5) — never aliases of v1
// ---------------------------------------------------------------------------

/** v2 final-collection output root basename under `<runs dir>` (future v2 collector, exclusive create). */
export const COLLECTION_ROOT_NAME = "commander-native-tool-v2-final-collection";
/** v2 evidence directory basename under `<runs dir>` (future v2 prepare). */
export const EVIDENCE_DIR_NAME = "commander-native-tool-benchmark-v2";
/** v2 strict manifest basename under `<runs dir>` (future v2 prepare). */
export const MANIFEST_NAME = "commander-native-tool-benchmark-v2-manifest.json";
/** v2 prepare staging prefix — distinct from the v1 `.nro-prepare-staging-` prefix. */
export const STAGING_PREFIX = ".nro-v2-prepare-staging-";
/** v2 collection record basename (inside the v2 collection root). */
export const COLLECTION_RECORD_NAME = "collection-record.json";
/** v2 deviations record basename (inside the v2 evidence directory). */
export const DEVIATIONS_NAME = "collection-deviations.json";
/** Frozen v2 inputs tree (project-relative): byte-copy prompt/fixture/environment + schema-2 rubric. */
export const INPUTS_DIR = "fixtures/commander-native-tool-benchmark-v2/inputs";
export const FIXTURE_DIR_NAME = "fixture";
export const MILESTONE_PROMPT_NAME = "milestone-prompt.txt";
export const ENVIRONMENT_NAME = "environment.txt";
export const RUBRIC_NAME = "rubric.json";

// ---------------------------------------------------------------------------
// Policy identities (protocol-v2 doc §6.4/§7)
// ---------------------------------------------------------------------------

/** v2 read-attribution policy identity: strict exact toolCallId matching, fail closed (v2 policy module). */
export const ATTRIBUTION_POLICY_IDENTITY = "tool_call_id_exact_v2";
/** v2 correctness policy identity: the frozen six-fact semantic rubric (v2 policy module). */
export const CORRECTNESS_POLICY_IDENTITY = "six_fact_semantic_v2";

// ---------------------------------------------------------------------------
// Efficiency thresholds (protocol-v2 doc §8) — the same four metrics/labels as v1
// ---------------------------------------------------------------------------

/** Frozen verdict ids (labels) — identical to the v1 four. */
export const VERDICT_IDS = ["bytes_median_reduction", "gross_median_reduction", "requests_median_non_increase", "gross_p90_regression"] as const;
export type VerdictId = (typeof VERDICT_IDS)[number];

/** Successful inline bytes median reduction threshold: >= 50% (exact comparison (Σc − Σt) × 1000 >= 500 × Σc). */
export const BYTES_MEDIAN_REDUCTION_MIN_PCT = 50;
/** Gross tokens median reduction threshold: >= 20% (exact comparison (Σc − Σt) × 1000 >= 200 × Σc). */
export const GROSS_MEDIAN_REDUCTION_MIN_PCT = 20;
/** Requests median rule: treatment median <= control median (exact comparison Σt <= Σc). */
export const REQUESTS_MEDIAN_NON_INCREASE = "treatment_median_le_control" as const;
/** Gross p90 tail guard: treatment p90 <= 105% of control (exact comparison 20 × t <= 21 × c). */
export const GROSS_P90_MAX_CONTROL_PCT = 105;

// ---------------------------------------------------------------------------
// Frozen environment and content pins (protocol-v2 doc §3.1/§3.2)
// ---------------------------------------------------------------------------

/** The frozen v2 environment — identical to the v1 pinned environment. */
export const FROZEN_ENVIRONMENT: FrozenEnvironment = {
	modelKey: "openai-codex/gpt-5.6-sol",
	thinkingLevel: "high",
	piVersion: "0.83.0",
	nodeVersion: "v26.4.0",
};

/**
 * The frozen v2 protocol — same shape as v1 (typed by the v1
 * FrozenProtocol type). The milestone prompt, fixture tree, and
 * non-treatment bundle are byte-copies of the v1 inputs and reproduce
 * the v1 pins; the schema-2 rubric is a genuine v2 revision whose pin
 * differs from the v1 rubric pin.
 */
export const FROZEN_NRO_V2_PROTOCOL: FrozenProtocol = {
	milestonePromptSha256: "1af10ebb1abfec5aba9744841980da66c9ee8e12720d589caa623350fb608a40",
	environment: FROZEN_ENVIRONMENT,
	fixtureManifestSha256: "062b3c92a8a36825394f0fa80b94808f2457ca5b63e8bbf9a70ff24339c216b6",
	nonTreatmentSha256: "7cbb545284d1f69aea04248b41a9466cb3aa53a39e8a6456291d410c59d28738",
	rubricSha256: "6c223da4c117f4af857be20f1dab43b495f62eced638bfd4a9a2db80e0026046",
	runsPerArm: RUNS_PER_ARM,
	interleave: INTERLEAVE,
};
