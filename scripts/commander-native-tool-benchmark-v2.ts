/**
 * NRO protocol-v2 benchmark core (commander-native-tool-optimization
 * plan, v2 benchmark-core slice) — PURE, in-memory, hermetic. Implements
 * the frozen protocol-v2 contract (docs/baselines/commander-native-tool-
 * benchmark-protocol-v2.md): strict schema-2 collection-record and
 * manifest models with parsers/serializers, per-run machine facts over
 * persisted Pi session entries (correctness and pagination derived
 * EXCLUSIVELY through the frozen v2 policy module), frozen-priority
 * attempt classification over the attempt's own entries (protocol-v2
 * §4.3/§8.6), and the four frozen efficiency verdicts with exact
 * integer arithmetic.
 *
 * This module is a leaf core: NO CLI, NO filesystem reads/writes, NO
 * network, NO process spawning, NO provider/cache/session state, and NO
 * import-time side effects (importing it never executes anything beyond
 * module definition). Errors are privacy-safe: messages never render
 * ids, paths, arguments, message bodies or thinking — only bounded
 * labels/basenames, pin values and structural descriptors.
 *
 * Frozen v2 sources of truth (never re-derived here):
 *   - scripts/commander-native-tool-benchmark-v2-protocol.ts — the
 *     frozen v2 schema/protocol versions, doc path, cohort constants,
 *     pins, environment and thresholds;
 *   - scripts/commander-native-tool-benchmark-v2-policy.ts — the frozen
 *     six-check rubric (evaluateRubricV2) and the exact-ID read
 *     attribution (computePaginationV2). A thrown V2PolicyError always
 *     propagates UNCHANGED (its messages are already privacy-safe).
 *
 * Reused v1 primitives ONLY (safe, exported, pure): validateEntries,
 * extractPromptText, sha256Hex, scanEnvironment, terminalStateOf,
 * extractFinalAssistantText, wallTimeMsOf and resolveSessionPath (the
 * v1 relative-path contract) from the v1 harness, plus the pure core
 * buildCostBreakdown / toolResultTextBytes from cost-breakdown.ts.
 * v1's NroError thrown by those primitives (e.g. MISSING_USER_MESSAGE,
 * MALFORMED_JSONL, INVALID_FACTS, MISSING_ASSISTANT_USAGE) propagates
 * unchanged — its messages are privacy-safe. v1 computeRunFacts,
 * computePagination, the v1 rubric evaluator, the v1 manifest/collection
 * parsers and the v1 frozen protocol/constants are NEVER called or
 * imported. ABBA helpers and session labels are local to v2.
 *
 * Stable NroV2Error codes (all privacy-safe, fail closed):
 *   INVALID_JSON / INVALID_RECORD / UNKNOWN_KEY / SCHEMA_VERSION /
 *   PROTOCOL_VERSION / PROTOCOL_DOC / INVALID_PHASE / INVALID_ENTRY /
 *   PIN_MISMATCH / PROTOCOL_NOT_FROZEN / ENV_UNSAFE / ENV_MISMATCH /
 *   RUBRIC_INVALID / RUBRIC_MISMATCH / HASH_UNSAFE / OVER_BOUND /
 *   LABEL_UNSAFE / LABEL_MISMATCH / PATH_UNSAFE / BASENAME_UNSAFE /
 *   DUPLICATE_PATH / DUPLICATE_LABEL / ORDER_MISMATCH / ARM_MISMATCH /
 *   COHORT_COUNT / ATTEMPT_LABELS / INVALID_CATEGORY /
 *   MISSING_PROMPT_TEXT / PROMPT_MISMATCH / MODEL_MISMATCH /
 *   MISSING_THINKING_LEVEL / THINKING_MISMATCH / COMPACTION_PRESENT /
 *   ABORTED / ERRORED / NOT_TERMINAL_STOP / ATTEMPT_NOT_INVALID
 */

import { buildCostBreakdown, toolResultTextBytes } from "../extensions/workbench-runtime/core/cost-breakdown.ts";

import {
	extractFinalAssistantText,
	extractPromptText,
	resolveSessionPath,
	scanEnvironment,
	sha256Hex,
	terminalStateOf,
	validateEntries,
	wallTimeMsOf,
	type TerminalFacts,
} from "./commander-native-tool-benchmark.ts";

import {
	BENCHMARK_SCHEMA_VERSION,
	BYTES_MEDIAN_REDUCTION_MIN_PCT,
	COLLECTION_SCHEMA_VERSION,
	FROZEN_NRO_V2_PROTOCOL,
	GROSS_MEDIAN_REDUCTION_MIN_PCT,
	GROSS_P90_MAX_CONTROL_PCT,
	MAX_PAID_ATTEMPTS,
	PROTOCOL_DOC,
	PROTOCOL_VERSION,
	RUNS_PER_ARM,
	TOTAL_VALID_RUNS,
	VERDICT_IDS,
	type ArmName,
	type Phase,
	type VerdictId,
} from "./commander-native-tool-benchmark-v2-protocol.ts";

import {
	V2_RUBRIC_CHECKS,
	computePaginationV2,
	evaluateRubricV2,
	type PaginationFactsV2,
	type RubricCheckV2,
	type RubricEvaluationV2,
} from "./commander-native-tool-benchmark-v2-policy.ts";

// ---------------------------------------------------------------------------
// Structured error (privacy-safe, stable codes)
// ---------------------------------------------------------------------------

export type NroV2ErrorCode =
	| "INVALID_JSON"
	| "INVALID_RECORD"
	| "UNKNOWN_KEY"
	| "SCHEMA_VERSION"
	| "PROTOCOL_VERSION"
	| "PROTOCOL_DOC"
	| "INVALID_PHASE"
	| "INVALID_ENTRY"
	| "PIN_MISMATCH"
	| "PROTOCOL_NOT_FROZEN"
	| "ENV_UNSAFE"
	| "ENV_MISMATCH"
	| "RUBRIC_INVALID"
	| "RUBRIC_MISMATCH"
	| "HASH_UNSAFE"
	| "OVER_BOUND"
	| "LABEL_UNSAFE"
	| "LABEL_MISMATCH"
	| "PATH_UNSAFE"
	| "BASENAME_UNSAFE"
	| "DUPLICATE_PATH"
	| "DUPLICATE_LABEL"
	| "ORDER_MISMATCH"
	| "ARM_MISMATCH"
	| "COHORT_COUNT"
	| "ATTEMPT_LABELS"
	| "INVALID_CATEGORY"
	| "MISSING_PROMPT_TEXT"
	| "PROMPT_MISMATCH"
	| "MODEL_MISMATCH"
	| "MISSING_THINKING_LEVEL"
	| "THINKING_MISMATCH"
	| "COMPACTION_PRESENT"
	| "ABORTED"
	| "ERRORED"
	| "NOT_TERMINAL_STOP"
	| "ATTEMPT_NOT_INVALID";

/** Structured v2 failure — fail closed, message never carries entry content. */
export class NroV2Error extends Error {
	readonly code: NroV2ErrorCode;
	constructor(code: NroV2ErrorCode, message: string) {
		super(message);
		this.name = "NroV2Error";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Documented bounds (v1 parity where the v2 doc defers to v1)
// ---------------------------------------------------------------------------

/** Collection-record entry cap (protocol-v2 §4.5/§5): at most 60 total session+attempt entries (the frozen cap on successfully-started paid attempts). */
export const COLLECTION_ENTRY_CAP = MAX_PAID_ATTEMPTS;
/** order_index domain cap (protocol-v2 §5 "at most 1000 entries" — v1 parity). */
const ORDER_INDEX_MAX = 1000;
/** Declared path cap (UTF-8 bytes). */
const PATH_MAX_BYTES = 512;
/** Label cap (chars). */
const LABEL_MAX_CHARS = 64;
/** Output-facing basename cap (chars). */
const BASENAME_MAX_CHARS = 128;
/** Model key cap (chars). */
const MODEL_KEY_MAX_CHARS = 96;
/** Thinking level cap (chars). */
const THINKING_LEVEL_MAX_CHARS = 32;
/** Rubric pattern cap (UTF-8 bytes). */
const RUBRIC_PATTERN_MAX_BYTES = 512;
/** Rubric check id cap (chars). */
const CHECK_ID_MAX_CHARS = 64;
/** Cost is rounded to 9 decimals per run (same convention as the v1 analyzer). */
const COST_DECIMALS = 1e9;
/** Deterministic toolName for malformed toolResult messages (v1 parity). */
const UNKNOWN_TOOL_NAME = "(unknown)";

const SHA256_RE = /^[0-9a-f]{64}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/;
const THINKING_LEVEL_RE = /^[A-Za-z0-9._-]{1,32}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const CHECK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Frozen session label format: `<arm>-<NN>` with zero-padded per-arm occurrence. */
const SESSION_LABEL_RE = /^(control|treatment)-(\d{2})$/;
/** Frozen attempt label format: `attempt-<N>` with gapless 1-based N. */
const ATTEMPT_LABEL_RE = /^attempt-(\d+)$/;

/** Frozen attempt categories (protocol-v2 §4.3 — the v1 frozen values; "unclassified" is dev-phase only). */
export const V2_ATTEMPT_CATEGORIES = ["prompt_mismatch", "env_drift", "compaction_present", "aborted", "errored", "nonterminal", "unclassified"] as const;
export type AttemptCategoryV2 = (typeof V2_ATTEMPT_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Non-global control-character predicate (a /g regex would carry lastIndex state). */
const CONTROL_RE = /[\x00-\x1f\x7f]/g;

/** Sanitized value for error messages (control chars replaced, byte-bounded). */
function safeErrorValue(value: string): string {
	const cleaned = value.replace(CONTROL_RE, " ");
	if (utf8Bytes(cleaned) <= 64) return cleaned;
	return `${cleaned.slice(0, 61)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Strict unknown-key refusal (fail closed with the stable UNKNOWN_KEY code). */
function requireKeysV2(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) throw new NroV2Error("UNKNOWN_KEY", `unknown key "${safeErrorValue(key)}" in ${where}`);
	}
}

/** Structural deep equality (key-order independent). */
function deepEqualV2(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ra = a as Record<string, unknown>;
	const rb = b as Record<string, unknown>;
	const ka = Object.keys(ra);
	const kb = Object.keys(rb);
	if (ka.length !== kb.length) return false;
	for (const key of ka) {
		if (!Object.prototype.hasOwnProperty.call(rb, key)) return false;
		if (!deepEqualV2(ra[key], rb[key])) return false;
	}
	return true;
}

/** Strict 64-lowercase-hex SHA-256 (fail closed HASH_UNSAFE). */
function parseSha256V2(value: unknown, where: string): string {
	if (typeof value !== "string" || !SHA256_RE.test(value)) {
		throw new NroV2Error("HASH_UNSAFE", `${where} must be a 64-lowercase-hex SHA-256 string`);
	}
	return value;
}

function parseArmV2(value: unknown, where: string): ArmName {
	if (value !== "control" && value !== "treatment") {
		throw new NroV2Error("INVALID_ENTRY", `${where} must be "control" or "treatment"`);
	}
	return value;
}

/** Fail closed when a declared pin drifts from the frozen protocol pin. */
function requirePinV2(declared: string, pin: string | null, pinName: string, where: string): void {
	if (pin === null) {
		throw new NroV2Error("PROTOCOL_NOT_FROZEN", `the v2 content pin ${pinName} is not yet resolved (protocol-v2 §3.2)`);
	}
	if (declared !== pin) {
		throw new NroV2Error("PIN_MISMATCH", `${where} ${pinName} must equal the frozen pin ${pin} (declared ${declared})`);
	}
}

export interface ManifestEnvironmentV2 {
	modelKey: string;
	thinkingLevel: string;
	piVersion: string;
	nodeVersion: string;
}

/** The frozen v2 protocol shape (same fields as the v1 type; pins may be null only in derived/unfrozen protocols). */
export interface V2FrozenProtocol {
	milestonePromptSha256: string | null;
	environment: ManifestEnvironmentV2;
	fixtureManifestSha256: string | null;
	nonTreatmentSha256: string | null;
	rubricSha256: string | null;
	runsPerArm: number;
	interleave: "ABBA";
}

const ENV_KEYS = ["model_key", "thinking_level", "pi_version", "node_version"] as const;

/** Strict environment parse: exact four bounded safe fields (fail closed ENV_UNSAFE). */
function parseEnvironmentV2(raw: unknown, where: string): ManifestEnvironmentV2 {
	const obj = asRecord(raw);
	if (!obj) throw new NroV2Error("INVALID_RECORD", `${where} must be an object`);
	requireKeysV2(obj, ENV_KEYS, where);
	const modelKey = obj.model_key;
	if (typeof modelKey !== "string" || !MODEL_KEY_RE.test(modelKey)) {
		throw new NroV2Error("ENV_UNSAFE", `${where}.model_key must match [A-Za-z0-9][A-Za-z0-9._/-]* with at most ${MODEL_KEY_MAX_CHARS} characters`);
	}
	const thinkingLevel = obj.thinking_level;
	if (typeof thinkingLevel !== "string" || !THINKING_LEVEL_RE.test(thinkingLevel)) {
		throw new NroV2Error("ENV_UNSAFE", `${where}.thinking_level must match [A-Za-z0-9._-]* with at most ${THINKING_LEVEL_MAX_CHARS} characters`);
	}
	const piVersion = obj.pi_version;
	if (typeof piVersion !== "string" || !VERSION_RE.test(piVersion)) {
		throw new NroV2Error("ENV_UNSAFE", `${where}.pi_version must be a bounded safe version string (at most 32 characters)`);
	}
	const nodeVersion = obj.node_version;
	if (typeof nodeVersion !== "string" || !VERSION_RE.test(nodeVersion)) {
		throw new NroV2Error("ENV_UNSAFE", `${where}.node_version must be a bounded safe version string (at most 32 characters)`);
	}
	return { modelKey, thinkingLevel, piVersion, nodeVersion };
}

/** Fail closed when the declared environment drifts from the pinned environment. */
function requirePinnedEnvironmentV2(environment: ManifestEnvironmentV2, protocol: V2FrozenProtocol, where: string): void {
	if (!deepEqualV2(environment, protocol.environment)) {
		throw new NroV2Error(
			"ENV_MISMATCH",
			`${where} environment must be the pinned environment (model ${protocol.environment.modelKey}, thinking ${protocol.environment.thinkingLevel}, Pi ${protocol.environment.piVersion}, Node ${protocol.environment.nodeVersion})`,
		);
	}
}

/**
 * The existing v1 relative-path contract (protocol-v2 §5): relative only
 * (absolute/drive/UNC/NUL/".." rejected), bounded to 512 UTF-8 bytes,
 * safe basename. Reuses the v1 resolveSessionPath primitive; its
 * privacy-safe NroError is re-raised as NroV2Error so this module's
 * whole error surface is the stable v2 codes.
 */
function validateSafeRelativePathV2(path: string, where: string): string {
	try {
		return resolveSessionPath("", path);
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		throw new NroV2Error(code === "OVER_BOUND" ? "OVER_BOUND" : "PATH_UNSAFE", `${where} must be a bounded safe relative path (absolute/drive/UNC/NUL/".." paths are rejected)`);
	}
}

// ---------------------------------------------------------------------------
// Frozen ABBA interleave and session labels (local to v2 — never v1 imports)
// ---------------------------------------------------------------------------

/** Arm at 1-based collection position i: control when (i-1) % 4 in {0, 3} (protocol-v2 §3.1/§4.2). */
export function abbaArmAtV2(position: number): ArmName {
	const r = (position - 1) % 4;
	return r === 0 || r === 3 ? "control" : "treatment";
}

/** The 1-based positions of an arm under the frozen ABBA interleave. */
export function abbaPositionsOfV2(arm: ArmName, runsPerArm: number = RUNS_PER_ARM): number[] {
	const out: number[] = [];
	for (let i = 1; i <= 2 * runsPerArm; i += 1) {
		if (abbaArmAtV2(i) === arm) out.push(i);
	}
	return out;
}

/** Frozen session label for the n-th session of an arm (zero-padded, 2 digits). */
export function sessionLabelV2(arm: ArmName, n: number): string {
	return `${arm}-${String(n).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Collection record (schema_version 2, protocol_version 2 — protocol-v2 §5)
// ---------------------------------------------------------------------------

const COLLECTION_TOP_KEYS = [
	"schema_version",
	"protocol_version",
	"protocol_doc",
	"phase",
	"milestone_prompt_sha256",
	"fixture_manifest_sha256",
	"non_treatment_sha256",
	"rubric_sha256",
	"environment",
	"entries",
] as const;
const COLLECTION_ENTRY_KEYS = ["kind", "arm", "path", "expected_session_sha256"] as const;

export type CollectionEntryKindV2 = "session" | "attempt";

export interface CollectionEntryV2 {
	kind: CollectionEntryKindV2;
	arm: ArmName;
	/** Path relative to the collection record's directory (safe, bounded — the v1 path contract). */
	path: string;
	expectedSessionSha256: string;
}

export interface CollectionRecordV2 {
	schemaVersion: number;
	protocolVersion: number;
	protocolDoc: string;
	phase: Phase;
	milestonePromptSha256: string;
	fixtureManifestSha256: string;
	nonTreatmentSha256: string;
	rubricSha256: string;
	environment: ManifestEnvironmentV2;
	entries: CollectionEntryV2[];
}

/**
 * Strict collection-record parsing (protocol-v2 §4.5/§5): exact root
 * keys, schema_version 2, protocol_version 2, exact protocol_doc,
 * dev/final phase, all four frozen pins, pinned environment, safe
 * bounded relative paths (duplicates rejected), 64-hex lowercase
 * hashes, at most 60 entries total. Final records may be truthful
 * chronological prefixes: the initial pre-collection record is the
 * empty entry list, and in every non-empty prefix each entry (attempt
 * or session) must declare the arm of the next not-yet-filled ABBA
 * session position — attempts retry that position without advancing
 * it, a session fills and advances it, and no entry of either kind may
 * follow the 40th session. Dev records are ABBA-free but must declare
 * at least one session entry.
 */
export function parseCollectionRecordV2(text: string, where: string = "collection record", protocol: V2FrozenProtocol = FROZEN_NRO_V2_PROTOCOL): CollectionRecordV2 {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new NroV2Error("INVALID_JSON", `${where} is not valid JSON`);
	}
	const root = asRecord(raw);
	if (!root) throw new NroV2Error("INVALID_RECORD", `${where} must be a JSON object`);
	requireKeysV2(root, COLLECTION_TOP_KEYS, where);
	if (root.schema_version !== COLLECTION_SCHEMA_VERSION) {
		throw new NroV2Error("SCHEMA_VERSION", `${where}.schema_version must be ${COLLECTION_SCHEMA_VERSION}`);
	}
	if (root.protocol_version !== PROTOCOL_VERSION) {
		throw new NroV2Error("PROTOCOL_VERSION", `${where}.protocol_version must be ${PROTOCOL_VERSION}`);
	}
	if (root.protocol_doc !== PROTOCOL_DOC) {
		throw new NroV2Error("PROTOCOL_DOC", `${where}.protocol_doc must be exactly "${PROTOCOL_DOC}"`);
	}
	if (root.phase !== "dev" && root.phase !== "final") {
		throw new NroV2Error("INVALID_PHASE", `${where}.phase must be "dev" or "final"`);
	}
	const phase: Phase = root.phase;

	const milestoneSha = parseSha256V2(root.milestone_prompt_sha256, `${where}.milestone_prompt_sha256`);
	requirePinV2(milestoneSha, protocol.milestonePromptSha256, "milestone_prompt_sha256", where);
	const fixtureSha = parseSha256V2(root.fixture_manifest_sha256, `${where}.fixture_manifest_sha256`);
	requirePinV2(fixtureSha, protocol.fixtureManifestSha256, "fixture_manifest_sha256", where);
	const nonTreatmentSha = parseSha256V2(root.non_treatment_sha256, `${where}.non_treatment_sha256`);
	requirePinV2(nonTreatmentSha, protocol.nonTreatmentSha256, "non_treatment_sha256", where);
	const rubricSha = parseSha256V2(root.rubric_sha256, `${where}.rubric_sha256`);
	requirePinV2(rubricSha, protocol.rubricSha256, "rubric_sha256", where);
	const environment = parseEnvironmentV2(root.environment, `${where}.environment`);
	requirePinnedEnvironmentV2(environment, protocol, where);

	const entriesRaw = root.entries;
	if (!Array.isArray(entriesRaw)) throw new NroV2Error("INVALID_RECORD", `${where}.entries must be an array`);
	// A final record is valid from the initial empty state (the collector
	// writes and verifies it before any paid process); dev still requires
	// at least one session entry (enforced below).
	if (phase === "dev" && entriesRaw.length < 1) {
		throw new NroV2Error("COHORT_COUNT", `${where} must contain at least one entry`);
	}
	if (entriesRaw.length > COLLECTION_ENTRY_CAP) {
		throw new NroV2Error("OVER_BOUND", `${where}.entries exceeds ${COLLECTION_ENTRY_CAP} entries (the frozen cap on successfully-started paid attempts)`);
	}
	const entries: CollectionEntryV2[] = [];
	const seenPaths = new Set<string>();
	let sessionPosition = 0;
	for (let i = 0; i < entriesRaw.length; i += 1) {
		const e = asRecord(entriesRaw[i]);
		if (!e) throw new NroV2Error("INVALID_RECORD", `${where}.entries[${i}] must be an object`);
		requireKeysV2(e, COLLECTION_ENTRY_KEYS, `${where}.entries[${i}]`);
		const kind = e.kind;
		if (kind !== "session" && kind !== "attempt") {
			throw new NroV2Error("INVALID_ENTRY", `${where}.entries[${i}].kind must be "session" or "attempt"`);
		}
		const arm = parseArmV2(e.arm, `${where}.entries[${i}].arm`);
		const path = e.path;
		if (typeof path !== "string" || path.length === 0) {
			throw new NroV2Error("INVALID_ENTRY", `${where}.entries[${i}].path must be a non-empty string`);
		}
		if (utf8Bytes(path) > PATH_MAX_BYTES) {
			throw new NroV2Error("OVER_BOUND", `${where}.entries[${i}].path exceeds ${PATH_MAX_BYTES} bytes`);
		}
		const safeName = path.split(/[\\/]+/).pop() ?? path;
		if (!BASENAME_RE.test(safeName)) {
			throw new NroV2Error("BASENAME_UNSAFE", `${where}.entries[${i}].path basename must be a bounded safe file name ([A-Za-z0-9][A-Za-z0-9._-]*, at most ${BASENAME_MAX_CHARS} chars)`);
		}
		const resolved = validateSafeRelativePathV2(path, `${where}.entries[${i}].path`);
		if (seenPaths.has(resolved)) {
			throw new NroV2Error("DUPLICATE_PATH", `${where}.entries[${i}].path duplicates another declared path`);
		}
		seenPaths.add(resolved);
		const expectedSha = parseSha256V2(e.expected_session_sha256, `${where}.entries[${i}].expected_session_sha256`);
		if (phase === "final") {
			if (sessionPosition >= TOTAL_VALID_RUNS) {
				throw new NroV2Error(
					"COHORT_COUNT",
					`${where} declares entries beyond the ${TOTAL_VALID_RUNS} frozen ABBA session positions — no entry of either kind may follow the ${TOTAL_VALID_RUNS}-th session`,
				);
			}
			// Every entry (attempt or session) binds the arm of the next
			// not-yet-filled ABBA session position: attempts retry that
			// position without advancing it; a session fills and advances it.
			const expectedArm = abbaArmAtV2(sessionPosition + 1);
			if (arm !== expectedArm) {
				throw new NroV2Error(
					"ARM_MISMATCH",
					`${where} entry at ABBA position ${sessionPosition + 1} must be ${expectedArm} under the frozen ABBA interleave, got ${arm}`,
				);
			}
		}
		if (kind === "session") {
			sessionPosition += 1;
		}
		entries.push({ kind, arm, path, expectedSessionSha256: expectedSha });
	}
	if (phase === "dev" && !entries.some((e) => e.kind === "session")) {
		throw new NroV2Error("COHORT_COUNT", "a dev collection record must contain at least one session entry");
	}
	return {
		schemaVersion: COLLECTION_SCHEMA_VERSION,
		protocolVersion: PROTOCOL_VERSION,
		protocolDoc: PROTOCOL_DOC,
		phase,
		milestonePromptSha256: milestoneSha,
		fixtureManifestSha256: fixtureSha,
		nonTreatmentSha256: nonTreatmentSha,
		rubricSha256: rubricSha,
		environment,
		entries,
	};
}

/** Serialize the strict collection record (canonical pretty JSON + LF, frozen key order). */
export function collectionRecordToJsonV2(record: CollectionRecordV2): string {
	return `${JSON.stringify(
		{
			schema_version: record.schemaVersion,
			protocol_version: record.protocolVersion,
			protocol_doc: record.protocolDoc,
			phase: record.phase,
			milestone_prompt_sha256: record.milestonePromptSha256,
			fixture_manifest_sha256: record.fixtureManifestSha256,
			non_treatment_sha256: record.nonTreatmentSha256,
			rubric_sha256: record.rubricSha256,
			environment: {
				model_key: record.environment.modelKey,
				thinking_level: record.environment.thinkingLevel,
				pi_version: record.environment.piVersion,
				node_version: record.environment.nodeVersion,
			},
			entries: record.entries.map((e) => ({
				kind: e.kind,
				arm: e.arm,
				path: e.path,
				expected_session_sha256: e.expectedSessionSha256,
			})),
		},
		null,
		2,
	)}\n`;
}

// ---------------------------------------------------------------------------
// Manifest (exact v1 shape + required top-level protocol_version — protocol-v2 §5)
// ---------------------------------------------------------------------------

export interface ManifestFixtureV2 {
	path: string;
	manifestSha256: string;
}

export interface ManifestSessionV2 {
	label: string;
	arm: ArmName;
	orderIndex: number;
	path: string;
	expectedSessionSha256: string;
}

export interface ManifestAttemptV2 {
	label: string;
	arm: ArmName;
	path: string;
	expectedSessionSha256: string;
	/** Extracted prompt hash; null when the attempt has no user message. */
	promptSha256: string | null;
	category: AttemptCategoryV2;
}

export interface NroManifestV2 {
	schemaVersion: number;
	protocolVersion: number;
	protocolDoc: string;
	phase: Phase;
	milestonePromptSha256: string;
	environment: ManifestEnvironmentV2;
	fixture: ManifestFixtureV2;
	nonTreatmentSha256: string;
	rubric: { sha256: string; checks: RubricCheckV2[] };
	sessions: ManifestSessionV2[];
	attempts: ManifestAttemptV2[];
}

const MANIFEST_TOP_KEYS = [
	"schema_version",
	"protocol_version",
	"protocol_doc",
	"phase",
	"milestone_prompt_sha256",
	"environment",
	"fixture",
	"non_treatment_sha256",
	"rubric",
	"sessions",
	"attempts",
] as const;
const FIXTURE_KEYS = ["path", "manifest_sha256"] as const;
const RUBRIC_KEYS = ["sha256", "checks"] as const;
const CHECK_KEYS = ["id", "pattern"] as const;
const SESSION_KEYS = ["label", "arm", "order_index", "path", "expected_session_sha256"] as const;
const ATTEMPT_KEYS = ["label", "arm", "path", "expected_session_sha256", "prompt_sha256", "category"] as const;

/**
 * The frozen schema-2 rubric must be EXACTLY the six ordered
 * V2_RUBRIC_CHECKS (protocol-v2 §7): any count, id, pattern or order
 * drift fails closed (RUBRIC_MISMATCH); malformed shapes fail closed
 * (RUBRIC_INVALID).
 */
function validateRubricChecksV2(raw: unknown, where: string): RubricCheckV2[] {
	if (!Array.isArray(raw)) throw new NroV2Error("RUBRIC_INVALID", `${where} must be an array`);
	if (raw.length !== V2_RUBRIC_CHECKS.length) {
		throw new NroV2Error("RUBRIC_MISMATCH", `${where} must carry exactly the ${V2_RUBRIC_CHECKS.length} frozen v2 checks in frozen order (got ${raw.length})`);
	}
	const checks: RubricCheckV2[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < raw.length; i += 1) {
		const c = asRecord(raw[i]);
		if (!c) throw new NroV2Error("RUBRIC_INVALID", `${where}[${i}] must be an object`);
		requireKeysV2(c, CHECK_KEYS, `${where}[${i}]`);
		const frozen = V2_RUBRIC_CHECKS[i];
		if (!frozen) throw new NroV2Error("RUBRIC_INVALID", `${where}[${i}] is outside the frozen check list`);
		const id = c.id;
		if (typeof id !== "string" || !CHECK_ID_RE.test(id)) {
			throw new NroV2Error("RUBRIC_INVALID", `${where}[${i}].id must match [A-Za-z0-9][A-Za-z0-9._-]* with at most ${CHECK_ID_MAX_CHARS} characters`);
		}
		if (seen.has(id)) throw new NroV2Error("RUBRIC_INVALID", `duplicate rubric check id "${safeErrorValue(id)}"`);
		seen.add(id);
		if (id !== frozen.id) {
			throw new NroV2Error("RUBRIC_MISMATCH", `${where}[${i}].id must be the frozen check id "${frozen.id}" at frozen position ${i}`);
		}
		const pattern = c.pattern;
		if (typeof pattern !== "string" || pattern.length === 0 || utf8Bytes(pattern) > RUBRIC_PATTERN_MAX_BYTES) {
			throw new NroV2Error("RUBRIC_INVALID", `${where}[${i}].pattern must be a non-empty string of at most ${RUBRIC_PATTERN_MAX_BYTES} UTF-8 bytes`);
		}
		if (pattern !== frozen.pattern) {
			throw new NroV2Error("RUBRIC_MISMATCH", `${where}[${i}].pattern must be the frozen v2 pattern for check "${frozen.id}"`);
		}
		try {
			// eslint-disable-next-line no-new
			new RegExp(pattern);
		} catch {
			throw new NroV2Error("RUBRIC_INVALID", `${where}[${i}].pattern must be a compilable regular expression`);
		}
		checks.push({ id, pattern });
	}
	return checks;
}

/**
 * Strictly parse the v2 manifest (exact v1 shape plus top-level
 * protocol_version). Unknown keys, wrong schema/protocol/doc, invalid
 * phase, any pin drift (prompt, environment, fixture, non-treatment,
 * rubric), a drifted/malformed frozen rubric, malformed/unsafe/bounded
 * identities, duplicate labels, duplicate paths, the final-phase
 * combined paid-attempt cap (sessions + attempts <= 60),
 * count/label/arm/order drift, attempt label gaps and malformed
 * sessions/attempts all fail closed.
 */
export function parseManifestV2(text: string, protocol: V2FrozenProtocol = FROZEN_NRO_V2_PROTOCOL): NroManifestV2 {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new NroV2Error("INVALID_JSON", "manifest is not valid JSON");
	}
	const root = asRecord(raw);
	if (!root) throw new NroV2Error("INVALID_RECORD", "manifest must be a JSON object");
	requireKeysV2(root, MANIFEST_TOP_KEYS, "manifest");
	if (root.schema_version !== BENCHMARK_SCHEMA_VERSION) {
		throw new NroV2Error("SCHEMA_VERSION", `manifest schema_version must be ${BENCHMARK_SCHEMA_VERSION}`);
	}
	if (root.protocol_version !== PROTOCOL_VERSION) {
		throw new NroV2Error("PROTOCOL_VERSION", `manifest protocol_version must be ${PROTOCOL_VERSION}`);
	}
	if (root.protocol_doc !== PROTOCOL_DOC) {
		throw new NroV2Error("PROTOCOL_DOC", `manifest protocol_doc must be exactly "${PROTOCOL_DOC}"`);
	}
	if (root.phase !== "dev" && root.phase !== "final") {
		throw new NroV2Error("INVALID_PHASE", 'manifest phase must be "dev" or "final"');
	}
	const phase: Phase = root.phase;

	const milestoneSha = parseSha256V2(root.milestone_prompt_sha256, "manifest milestone_prompt_sha256");
	requirePinV2(milestoneSha, protocol.milestonePromptSha256, "milestone_prompt_sha256", "manifest");
	const environment = parseEnvironmentV2(root.environment, "manifest environment");
	requirePinnedEnvironmentV2(environment, protocol, "manifest");

	const fixtureRaw = asRecord(root.fixture);
	if (!fixtureRaw) throw new NroV2Error("INVALID_RECORD", "fixture must be an object");
	requireKeysV2(fixtureRaw, FIXTURE_KEYS, "fixture");
	const fixturePath = fixtureRaw.path;
	if (typeof fixturePath !== "string" || fixturePath.length === 0) {
		throw new NroV2Error("INVALID_ENTRY", "fixture.path must be a non-empty string");
	}
	if (utf8Bytes(fixturePath) > PATH_MAX_BYTES) {
		throw new NroV2Error("OVER_BOUND", `fixture.path exceeds ${PATH_MAX_BYTES} bytes`);
	}
	const fixtureResolved = validateSafeRelativePathV2(fixturePath, "fixture.path");
	const fixtureManifestSha = parseSha256V2(fixtureRaw.manifest_sha256, "fixture.manifest_sha256");
	requirePinV2(fixtureManifestSha, protocol.fixtureManifestSha256, "fixture_manifest_sha256", "manifest");
	const fixture: ManifestFixtureV2 = { path: fixturePath, manifestSha256: fixtureManifestSha };

	const nonTreatmentSha = parseSha256V2(root.non_treatment_sha256, "manifest non_treatment_sha256");
	requirePinV2(nonTreatmentSha, protocol.nonTreatmentSha256, "non_treatment_sha256", "manifest");

	const rubricRaw = asRecord(root.rubric);
	if (!rubricRaw) throw new NroV2Error("RUBRIC_INVALID", "rubric must be an object");
	requireKeysV2(rubricRaw, RUBRIC_KEYS, "rubric");
	const rubricSha = parseSha256V2(rubricRaw.sha256, "rubric.sha256");
	requirePinV2(rubricSha, protocol.rubricSha256, "rubric_sha256", "manifest");
	const checks = validateRubricChecksV2(rubricRaw.checks, "rubric.checks");

	const sessionsRaw = root.sessions;
	if (!Array.isArray(sessionsRaw)) throw new NroV2Error("INVALID_RECORD", "sessions must be an array");
	const sessions: ManifestSessionV2[] = [];
	const seenLabels = new Set<string>();
	const seenPaths = new Set<string>([fixtureResolved]);
	for (let i = 0; i < sessionsRaw.length; i += 1) {
		const s = asRecord(sessionsRaw[i]);
		if (!s) throw new NroV2Error("INVALID_RECORD", `sessions[${i}] must be an object`);
		requireKeysV2(s, SESSION_KEYS, `sessions[${i}]`);
		const label = s.label;
		if (typeof label !== "string" || !LABEL_RE.test(label)) {
			throw new NroV2Error("LABEL_UNSAFE", `sessions[${i}].label must match [A-Za-z0-9][A-Za-z0-9._-]* with at most ${LABEL_MAX_CHARS} characters`);
		}
		if (seenLabels.has(label)) throw new NroV2Error("DUPLICATE_LABEL", `duplicate session label "${safeErrorValue(label)}"`);
		seenLabels.add(label);
		const arm = parseArmV2(s.arm, `sessions[${i}].arm`);
		const orderIndex = s.order_index;
		if (typeof orderIndex !== "number" || !Number.isInteger(orderIndex) || orderIndex < 1 || orderIndex > ORDER_INDEX_MAX) {
			throw new NroV2Error("INVALID_ENTRY", `sessions[${i}].order_index must be a positive integer no greater than ${ORDER_INDEX_MAX}`);
		}
		const path = s.path;
		if (typeof path !== "string" || path.length === 0) {
			throw new NroV2Error("INVALID_ENTRY", `sessions[${i}].path must be a non-empty string`);
		}
		if (utf8Bytes(path) > PATH_MAX_BYTES) {
			throw new NroV2Error("OVER_BOUND", `sessions[${i}].path exceeds ${PATH_MAX_BYTES} bytes`);
		}
		const safeName = path.split(/[\\/]+/).pop() ?? path;
		if (!BASENAME_RE.test(safeName)) {
			throw new NroV2Error("BASENAME_UNSAFE", `sessions[${i}].path basename must be a bounded safe file name ([A-Za-z0-9][A-Za-z0-9._-]*, at most ${BASENAME_MAX_CHARS} chars)`);
		}
		const resolved = validateSafeRelativePathV2(path, `sessions[${i}].path`);
		if (seenPaths.has(resolved)) {
			throw new NroV2Error("DUPLICATE_PATH", `sessions[${i}].path duplicates another declared path`);
		}
		seenPaths.add(resolved);
		const expectedSha = parseSha256V2(s.expected_session_sha256, `sessions[${i}].expected_session_sha256`);
		sessions.push({ label, arm, orderIndex, path, expectedSessionSha256: expectedSha });
	}
	if (sessions.length < 1) throw new NroV2Error("COHORT_COUNT", "the manifest must declare at least one session");

	const attemptsRaw = root.attempts;
	if (!Array.isArray(attemptsRaw)) throw new NroV2Error("INVALID_RECORD", "attempts must be an array");
	if (attemptsRaw.length > MAX_PAID_ATTEMPTS) {
		throw new NroV2Error("OVER_BOUND", `attempts exceeds ${MAX_PAID_ATTEMPTS} entries (the frozen cap on successfully-started paid attempts)`);
	}
	// Final paid-attempt cap (protocol-v2 §3.1/§4): sessions + attempts
	// together may not exceed 60 successfully-started paid attempts.
	if (phase === "final" && sessions.length + attemptsRaw.length > MAX_PAID_ATTEMPTS) {
		throw new NroV2Error(
			"OVER_BOUND",
			`a final manifest must total at most ${MAX_PAID_ATTEMPTS} paid attempts — ${sessions.length} sessions + ${attemptsRaw.length} attempts exceeds the frozen cap on successfully-started paid attempts`,
		);
	}
	const attempts: ManifestAttemptV2[] = [];
	const seenAttemptLabels = new Set<string>();
	for (let i = 0; i < attemptsRaw.length; i += 1) {
		const a = asRecord(attemptsRaw[i]);
		if (!a) throw new NroV2Error("INVALID_RECORD", `attempts[${i}] must be an object`);
		requireKeysV2(a, ATTEMPT_KEYS, `attempts[${i}]`);
		const label = a.label;
		if (typeof label !== "string" || !ATTEMPT_LABEL_RE.test(label)) {
			throw new NroV2Error("LABEL_UNSAFE", `attempts[${i}].label must be "attempt-<N>" with N a positive integer`);
		}
		if (seenAttemptLabels.has(label)) throw new NroV2Error("DUPLICATE_LABEL", `duplicate attempt label "${safeErrorValue(label)}"`);
		seenAttemptLabels.add(label);
		const arm = parseArmV2(a.arm, `attempts[${i}].arm`);
		const path = a.path;
		if (typeof path !== "string" || path.length === 0) {
			throw new NroV2Error("INVALID_ENTRY", `attempts[${i}].path must be a non-empty string`);
		}
		if (utf8Bytes(path) > PATH_MAX_BYTES) {
			throw new NroV2Error("OVER_BOUND", `attempts[${i}].path exceeds ${PATH_MAX_BYTES} bytes`);
		}
		const safeName = path.split(/[\\/]+/).pop() ?? path;
		if (!BASENAME_RE.test(safeName)) {
			throw new NroV2Error("BASENAME_UNSAFE", `attempts[${i}].path basename must be a bounded safe file name ([A-Za-z0-9][A-Za-z0-9._-]*, at most ${BASENAME_MAX_CHARS} chars)`);
		}
		const resolved = validateSafeRelativePathV2(path, `attempts[${i}].path`);
		if (seenPaths.has(resolved)) {
			throw new NroV2Error("DUPLICATE_PATH", `attempts[${i}].path duplicates another declared path`);
		}
		seenPaths.add(resolved);
		const expectedSha = parseSha256V2(a.expected_session_sha256, `attempts[${i}].expected_session_sha256`);
		const promptShaRaw = a.prompt_sha256;
		let promptSha: string | null;
		if (promptShaRaw === null) {
			promptSha = null;
		} else {
			promptSha = parseSha256V2(promptShaRaw, `attempts[${i}].prompt_sha256`);
		}
		const category = a.category;
		if (typeof category !== "string" || !(V2_ATTEMPT_CATEGORIES as readonly string[]).includes(category)) {
			throw new NroV2Error("INVALID_CATEGORY", `attempts[${i}].category must be one of ${V2_ATTEMPT_CATEGORIES.join(", ")}`);
		}
		if (phase === "final" && category === "unclassified") {
			throw new NroV2Error("INVALID_CATEGORY", `attempts[${i}].category "unclassified" is dev-phase only`);
		}
		attempts.push({ label, arm, path, expectedSessionSha256: expectedSha, promptSha256: promptSha, category: category as AttemptCategoryV2 });
	}
	// Attempt labels must be gapless attempt-1..attempt-N in array order (protocol-v2 §3.1/§4.3).
	for (let i = 0; i < attempts.length; i += 1) {
		const expected = `attempt-${i + 1}`;
		const actual = attempts[i]?.label;
		if (actual !== expected) {
			throw new NroV2Error(
				"ATTEMPT_LABELS",
				`attempt labels must be exactly attempt-1..attempt-${attempts.length} in chronological order — missing/dropped attempt "${safeErrorValue(actual ?? "(missing)")}" (expected "${expected}")`,
			);
		}
	}

	validateSessionShapeV2(sessions, phase, protocol.runsPerArm);

	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		protocolVersion: PROTOCOL_VERSION,
		protocolDoc: PROTOCOL_DOC,
		phase,
		milestonePromptSha256: milestoneSha,
		environment,
		fixture,
		nonTreatmentSha256: nonTreatmentSha,
		rubric: { sha256: rubricSha, checks },
		sessions,
		attempts,
	};
}

/**
 * Enforce the frozen session shape (protocol-v2 §4.2/§5): per-arm
 * occurrence labels (`arm-0N`), strictly increasing order_index from 1.
 * Final phase additionally requires exactly 2 x runsPerArm sessions (20
 * per arm) whose arms and label numbers reproduce the frozen ABBA
 * bijection between labels, positions, and arms; dev manifests are
 * relaxed on ABBA/counts.
 */
export function validateSessionShapeV2(sessions: readonly ManifestSessionV2[], phase: Phase, runsPerArm: number = RUNS_PER_ARM): void {
	const byArm = new Map<ArmName, number>();
	const seenOrder = new Set<number>();
	let lastOrder = 0;
	for (const s of sessions) {
		const m = SESSION_LABEL_RE.exec(s.label);
		if (!m) {
			throw new NroV2Error("LABEL_MISMATCH", `session label "${safeErrorValue(s.label)}" must be <arm>-<NN> with NN the zero-padded per-arm occurrence number`);
		}
		const labelArm = m[1] as ArmName;
		const labelN = Number(m[2]);
		if (labelArm !== s.arm) {
			throw new NroV2Error("LABEL_MISMATCH", `session "${safeErrorValue(s.label)}" declares arm ${s.arm} but its label arm is ${labelArm}`);
		}
		const occurrence = (byArm.get(s.arm) ?? 0) + 1;
		if (labelN !== occurrence) {
			throw new NroV2Error(
				"LABEL_MISMATCH",
				`session "${safeErrorValue(s.label)}" is the ${occurrence}-th ${s.arm} session but its label number is ${labelN}`,
			);
		}
		if (labelN > 99) throw new NroV2Error("LABEL_MISMATCH", `session label "${safeErrorValue(s.label)}" exceeds the frozen 2-digit label space`);
		byArm.set(s.arm, occurrence);
		if (seenOrder.has(s.orderIndex)) throw new NroV2Error("ORDER_MISMATCH", `duplicate order_index ${s.orderIndex}`);
		seenOrder.add(s.orderIndex);
		if (s.orderIndex <= lastOrder) {
			throw new NroV2Error("ORDER_MISMATCH", "sessions must be declared in strictly increasing order_index order");
		}
		lastOrder = s.orderIndex;
	}
	const firstSession = sessions[0];
	if (firstSession && firstSession.orderIndex !== 1) {
		throw new NroV2Error("ORDER_MISMATCH", "sessions must start at order_index 1 (strictly increasing from 1)");
	}
	if (phase === "final") {
		const controlCount = byArm.get("control") ?? 0;
		const treatmentCount = byArm.get("treatment") ?? 0;
		if (sessions.length !== 2 * runsPerArm || controlCount !== runsPerArm || treatmentCount !== runsPerArm) {
			throw new NroV2Error(
				"COHORT_COUNT",
				`a final manifest must contain exactly ${runsPerArm} control + ${runsPerArm} treatment sessions (got ${controlCount} control / ${treatmentCount} treatment / ${sessions.length} total)`,
			);
		}
		const expectedOrder = new Set<number>(Array.from({ length: 2 * runsPerArm }, (_, i) => i + 1));
		if (seenOrder.size !== expectedOrder.size || [...seenOrder].some((o) => !expectedOrder.has(o))) {
			throw new NroV2Error("ORDER_MISMATCH", `final order_index values must be exactly 1..${2 * runsPerArm}`);
		}
		const controlPositions = abbaPositionsOfV2("control", runsPerArm);
		const treatmentPositions = abbaPositionsOfV2("treatment", runsPerArm);
		const positionArm = new Map<number, ArmName>();
		const positionLabelNumber = new Map<number, number>();
		for (let n = 1; n <= runsPerArm; n += 1) {
			const cp = controlPositions[n - 1];
			if (cp === undefined) throw new NroV2Error("ORDER_MISMATCH", "frozen ABBA control positions are incomplete");
			positionArm.set(cp, "control");
			positionLabelNumber.set(cp, n);
			const tp = treatmentPositions[n - 1];
			if (tp === undefined) throw new NroV2Error("ORDER_MISMATCH", "frozen ABBA treatment positions are incomplete");
			positionArm.set(tp, "treatment");
			positionLabelNumber.set(tp, n);
		}
		for (const s of sessions) {
			const expectedArm = positionArm.get(s.orderIndex);
			if (expectedArm === undefined) throw new NroV2Error("ORDER_MISMATCH", `order_index ${s.orderIndex} is outside the frozen ABBA position set`);
			if (s.arm !== expectedArm) {
				throw new NroV2Error("ARM_MISMATCH", `session "${safeErrorValue(s.label)}" at ABBA position ${s.orderIndex} must be ${expectedArm}, got ${s.arm}`);
			}
			const m = SESSION_LABEL_RE.exec(s.label);
			const expectedN = positionLabelNumber.get(s.orderIndex);
			if (!m || expectedN === undefined || Number(m[2]) !== expectedN) {
				throw new NroV2Error(
					"ORDER_MISMATCH",
					`session "${safeErrorValue(s.label)}" must sit at the ${expectedN}-th ${s.arm} position of the frozen ABBA interleave`,
				);
			}
		}
	}
}

/** Serialize the strict manifest (snake_case wire form, canonical pretty JSON + LF, frozen key order). */
export function manifestToJsonV2(manifest: NroManifestV2): string {
	return `${JSON.stringify(
		{
			schema_version: manifest.schemaVersion,
			protocol_version: manifest.protocolVersion,
			protocol_doc: manifest.protocolDoc,
			phase: manifest.phase,
			milestone_prompt_sha256: manifest.milestonePromptSha256,
			environment: {
				model_key: manifest.environment.modelKey,
				thinking_level: manifest.environment.thinkingLevel,
				pi_version: manifest.environment.piVersion,
				node_version: manifest.environment.nodeVersion,
			},
			fixture: { path: manifest.fixture.path, manifest_sha256: manifest.fixture.manifestSha256 },
			non_treatment_sha256: manifest.nonTreatmentSha256,
			rubric: { sha256: manifest.rubric.sha256, checks: manifest.rubric.checks },
			sessions: manifest.sessions.map((s) => ({
				label: s.label,
				arm: s.arm,
				order_index: s.orderIndex,
				path: s.path,
				expected_session_sha256: s.expectedSessionSha256,
			})),
			attempts: manifest.attempts.map((a) => ({
				label: a.label,
				arm: a.arm,
				path: a.path,
				expected_session_sha256: a.expectedSessionSha256,
				prompt_sha256: a.promptSha256,
				category: a.category,
			})),
		},
		null,
		2,
	)}\n`;
}

// ---------------------------------------------------------------------------
// Per-run machine facts (protocol-v2 §6) — correctness/pagination via the
// frozen v2 policy module only; cost/bytes via the reused pure v1 core
// ---------------------------------------------------------------------------

export interface PerToolTextFactsV2 {
	toolName: string;
	entries: number;
	textBytes: number;
	successfulEntries: number;
	successfulTextBytes: number;
}

export interface RunFactsV2 {
	label: string;
	arm: ArmName;
	orderIndex: number;
	sessionBasename: string;
	sessionSha256: string;
	promptSha256: string;
	promptMatches: boolean;
	requests: number;
	compactions: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	gross: number;
	toolResultEntries: number;
	successfulToolResultEntries: number;
	totalTextBytes: number;
	successfulTextBytes: number;
	perTool: PerToolTextFactsV2[];
	modelKeys: string[];
	thinkingLevel: string | null;
	wallTimeMs: number | null;
	terminal: TerminalFacts;
	correctness: RubricEvaluationV2;
	pagination: PaginationFactsV2;
	misuse: boolean;
	/** Exact count of assistant toolCall items whose name is exactly "edit" or "write" (protocol-v2 §8 release blocker 4). */
	editWriteToolCalls: number;
}

export interface RunFactsV2Options {
	/** Final-phase validity enforcement (protocol-v2 §6.2). */
	enforceValidity: boolean;
}

/** Deterministic toolName for a toolResult message (same semantics as cost-breakdown). */
function successfulToolNameOfV2(entry: unknown): string {
	const e = asRecord(entry);
	const m = e ? asRecord(e.message) : null;
	if (!e || e.type !== "message" || !m || m.role !== "toolResult") return UNKNOWN_TOOL_NAME;
	const name = m.toolName;
	return typeof name === "string" && name.length > 0 ? name : UNKNOWN_TOOL_NAME;
}

/** Exact edit/write toolCall count over assistant content items (names exactly "edit" or "write"). */
export function countEditWriteToolCallsV2(entries: readonly unknown[]): number {
	let count = 0;
	for (const entry of entries) {
		const e = asRecord(entry);
		if (!e || e.type !== "message") continue;
		const m = asRecord(e.message);
		if (!m || m.role !== "assistant") continue;
		if (!Array.isArray(m.content)) continue;
		for (const item of m.content) {
			const it = asRecord(item);
			if (!it || it.type !== "toolCall") continue;
			if (it.name === "edit" || it.name === "write") count += 1;
		}
	}
	return count;
}

/**
 * Compute the per-run v2 machine facts. Reuses the v1 core
 * buildCostBreakdown for requests, token components, gross, cost,
 * compactions and per-tool/total inline text bytes, plus the
 * successful-byte pass (toolResult messages NOT marked isError=true).
 * Correctness comes exclusively from the frozen evaluateRubricV2 and
 * pagination exclusively from the frozen computePaginationV2 (a
 * V2PolicyError propagates unchanged). Fail-closed enforcement when
 * enforceValidity is set: prompt hash pin, per-assistant model key,
 * recorded thinking level, zero compactions, terminal stop (no
 * abort/error). For dev sessions the same facts are recorded but not
 * enforced.
 */
export function computeRunFactsV2(
	label: string,
	arm: ArmName,
	orderIndex: number,
	sessionBasename: string,
	sessionSha256: string,
	entries: readonly unknown[],
	expectedPromptSha256: string,
	expectedEnvironment: ManifestEnvironmentV2,
	opts: RunFactsV2Options,
): RunFactsV2 {
	validateEntries(entries, label, true);
	const promptText = extractPromptText(entries);
	if (promptText.length === 0) {
		throw new NroV2Error("MISSING_PROMPT_TEXT", `session "${safeErrorValue(label)}": first user message has no extractable text`);
	}
	const promptSha256 = sha256Hex(promptText);
	if (opts.enforceValidity && promptSha256 !== expectedPromptSha256) {
		throw new NroV2Error(
			"PROMPT_MISMATCH",
			`session "${safeErrorValue(label)}": extracted first user-message text SHA-256 ${promptSha256} does not match the frozen milestone prompt SHA-256 ${expectedPromptSha256}`,
		);
	}

	const envScan = scanEnvironment(entries);
	if (opts.enforceValidity) {
		if (envScan.modelKeys.length === 0) {
			throw new NroV2Error(
				"MODEL_MISMATCH",
				`session "${safeErrorValue(label)}": no assistant message carries a model identity — the pinned model key "${expectedEnvironment.modelKey}" was never observed (missing identity fails closed)`,
			);
		}
		if (envScan.modelKeys.some((k) => k !== expectedEnvironment.modelKey)) {
			throw new NroV2Error(
				"MODEL_MISMATCH",
				`session "${safeErrorValue(label)}": assistant model key does not match the pinned environment model key "${expectedEnvironment.modelKey}" (every assistant message must carry the identical expected model identity)`,
			);
		}
		if (envScan.thinkingLevel === null) {
			throw new NroV2Error("MISSING_THINKING_LEVEL", `session "${safeErrorValue(label)}": no thinking_level_change entry — the recorded thinking level is missing`);
		}
		if (envScan.thinkingLevel !== expectedEnvironment.thinkingLevel) {
			throw new NroV2Error(
				"THINKING_MISMATCH",
				`session "${safeErrorValue(label)}": recorded thinking level "${safeErrorValue(envScan.thinkingLevel)}" does not match the pinned environment thinking level "${expectedEnvironment.thinkingLevel}"`,
			);
		}
	}

	const breakdown = buildCostBreakdown(entries);
	if (opts.enforceValidity && breakdown.compactions !== 0) {
		throw new NroV2Error("COMPACTION_PRESENT", `session "${safeErrorValue(label)}": ${breakdown.compactions} compaction(s) — final sessions require zero compactions`);
	}
	const terminal = terminalStateOf(entries);
	if (opts.enforceValidity) {
		if (terminal.aborted) throw new NroV2Error("ABORTED", `session "${safeErrorValue(label)}": terminal assistant response is aborted`);
		if (terminal.errored) throw new NroV2Error("ERRORED", `session "${safeErrorValue(label)}": terminal assistant response errored`);
		if (!terminal.terminalStop) {
			throw new NroV2Error(
				"NOT_TERMINAL_STOP",
				`session "${safeErrorValue(label)}": no terminal assistant stop response (last message role ${terminal.lastMessageRole ?? "none"}, last assistant stop reason ${terminal.lastAssistantStopReason ?? "none"})`,
			);
		}
	}

	// Successful inline-text pass: only toolResult messages not marked
	// isError=true, byte-counted with toolResultTextBytes semantics.
	const successByName = new Map<string, { entries: number; bytes: number }>();
	for (const entry of entries) {
		const e = asRecord(entry);
		const m = e ? asRecord(e.message) : null;
		if (!e || e.type !== "message" || !m || m.role !== "toolResult") continue;
		if (m.isError === true) continue;
		const name = successfulToolNameOfV2(entry);
		const slot = successByName.get(name) ?? { entries: 0, bytes: 0 };
		slot.entries += 1;
		slot.bytes += toolResultTextBytes(entry);
		successByName.set(name, slot);
	}

	const totalByName = new Map<string, { count: number; textBytes: number }>();
	for (const row of breakdown.toolTextBytes) totalByName.set(row.toolName, row);
	const allNames = new Set<string>([...totalByName.keys(), ...successByName.keys()]);
	const perTool: PerToolTextFactsV2[] = [];
	let successfulToolResultEntries = 0;
	let successfulTextBytes = 0;
	for (const name of [...allNames].sort()) {
		const total = totalByName.get(name);
		const success = successByName.get(name);
		const row: PerToolTextFactsV2 = {
			toolName: name,
			entries: total?.count ?? 0,
			textBytes: total?.textBytes ?? 0,
			successfulEntries: success?.entries ?? 0,
			successfulTextBytes: success?.bytes ?? 0,
		};
		perTool.push(row);
		successfulToolResultEntries += row.successfulEntries;
		successfulTextBytes += row.successfulTextBytes;
	}

	const finalText = extractFinalAssistantText(entries);
	const correctness = evaluateRubricV2(finalText);
	const pagination = computePaginationV2(entries);

	return {
		label,
		arm,
		orderIndex,
		sessionBasename,
		sessionSha256,
		promptSha256,
		promptMatches: promptSha256 === expectedPromptSha256,
		requests: breakdown.commanderRequests,
		compactions: breakdown.compactions,
		cost: Math.round(breakdown.commander.cost * COST_DECIMALS) / COST_DECIMALS,
		input: breakdown.commander.input,
		output: breakdown.commander.output,
		cacheRead: breakdown.commander.cacheRead,
		cacheWrite: breakdown.commander.cacheWrite,
		gross: breakdown.commander.tokens,
		toolResultEntries: breakdown.toolResultEntries,
		successfulToolResultEntries,
		totalTextBytes: breakdown.toolTextBytesTotal,
		successfulTextBytes,
		perTool,
		modelKeys: envScan.modelKeys,
		thinkingLevel: envScan.thinkingLevel,
		wallTimeMs: wallTimeMsOf(entries),
		terminal,
		correctness,
		pagination,
		misuse: pagination.misuse,
		editWriteToolCalls: countEditWriteToolCallsV2(entries),
	};
}

// ---------------------------------------------------------------------------
// Attempt classification (protocol-v2 §4.3/§8.6 — the frozen seven-way
// priority over the attempt's own entries; aggregate-only facts)
// ---------------------------------------------------------------------------

export interface AttemptFactsV2 {
	label: string;
	arm: ArmName;
	/** Bounded caller-provided basename — never a full path. */
	sessionBasename: string;
	rawSha256: string;
	/** Extracted first-user-message SHA-256; null when the attempt has no user message (never preempts lower categories). */
	promptSha256: string | null;
	category: AttemptCategoryV2;
	/** Exact count of assistant-message entries (v1 buildCostBreakdown commanderRequests semantics). */
	requests: number;
	/** Exact count of compaction entries (usage-independent). */
	compactions: number;
	/** Unique observed model keys in first-seen order (scanEnvironment semantics). */
	modelKeys: string[];
	/** Last recorded thinking level; null when none was recorded. */
	thinkingLevel: string | null;
	terminal: TerminalFacts;
}

export interface DeriveAttemptOptionsV2 {
	/** Final-phase strictness: a machine-observably valid attempt fails (ATTEMPT_NOT_INVALID). */
	strict: boolean;
}

/**
 * Lenient first-user-message extraction for attempts: the text is hashed
 * only and a missing user message yields null (protocol-v2 §4.3) instead
 * of failing — lower-priority categories still classify. Wraps the
 * exported v1 extractPromptText primitive; any other NroError propagates
 * unchanged (its messages are privacy-safe).
 */
function extractPromptTextLenientV2(entries: readonly unknown[]): string | null {
	try {
		return extractPromptText(entries);
	} catch (error) {
		if ((error as { code?: unknown }).code === "MISSING_USER_MESSAGE") return null;
		throw error;
	}
}

/**
 * Derive the frozen-priority attempt category (protocol-v2 §4.3/§8.6)
 * from the attempt's own entries, using ONLY the safe reused pure
 * primitives (lenient prompt extraction, scanEnvironment,
 * terminalStateOf, buildCostBreakdown) — never the v1 attempt
 * classifier or any v1 manifest/analyzer/prepare implementation.
 * Attempts skip the user/assistant presence requirements but keep
 * strict JSONL/usage validation (validateEntries).
 *
 * Frozen priority: (1) non-null wrong prompt hash → prompt_mismatch;
 * (2) any observed model mismatch or observed thinking mismatch →
 * env_drift; (3) any compaction → compaction_present; (4) terminal
 * abort → aborted; (5) terminal error → errored; (6) no terminal stop
 * → nonterminal; (7) machine-observably valid → strict final mode
 * throws the privacy-safe ATTEMPT_NOT_INVALID (attempts can never hide
 * valid runs), non-strict dev mode records unclassified. A missing
 * user message yields a null prompt hash and never preempts lower
 * categories.
 */
export function deriveAttemptFactsV2(
	label: string,
	arm: ArmName,
	sessionBasename: string,
	rawSha256: string,
	entries: readonly unknown[],
	expectedPromptSha256: string,
	expectedEnvironment: ManifestEnvironmentV2,
	opts: DeriveAttemptOptionsV2,
): AttemptFactsV2 {
	validateEntries(entries, label, false);
	const promptText = extractPromptTextLenientV2(entries);
	const promptSha256 = promptText === null ? null : sha256Hex(promptText);
	const envScan = scanEnvironment(entries);
	const terminal = terminalStateOf(entries);
	const breakdown = buildCostBreakdown(entries);
	let category: AttemptCategoryV2;
	if (promptSha256 !== null && promptSha256 !== expectedPromptSha256) {
		category = "prompt_mismatch";
	} else if (
		envScan.modelKeys.some((k) => k !== expectedEnvironment.modelKey) ||
		(envScan.thinkingLevel !== null && envScan.thinkingLevel !== expectedEnvironment.thinkingLevel)
	) {
		category = "env_drift";
	} else if (breakdown.compactions !== 0) {
		category = "compaction_present";
	} else if (terminal.aborted) {
		category = "aborted";
	} else if (terminal.errored) {
		category = "errored";
	} else if (!terminal.terminalStop) {
		category = "nonterminal";
	} else if (opts.strict) {
		throw new NroV2Error(
			"ATTEMPT_NOT_INVALID",
			`attempt "${safeErrorValue(label)}" is machine-observably a valid final session (prompt hash, environment, zero compactions, terminal stop) — attempts cannot hide valid runs`,
		);
	} else {
		category = "unclassified";
	}
	return {
		label,
		arm,
		sessionBasename,
		rawSha256,
		promptSha256,
		category,
		requests: breakdown.commanderRequests,
		compactions: breakdown.compactions,
		modelKeys: envScan.modelKeys,
		thinkingLevel: envScan.thinkingLevel,
		terminal,
	};
}

// ---------------------------------------------------------------------------
// Arm aggregation and the four frozen verdicts (protocol-v2 §8 — exact
// integer arithmetic, thresholds unchanged from v1)
// ---------------------------------------------------------------------------

export interface CohortTotalsV2 {
	requests: number;
	compactions: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	gross: number;
	toolResultEntries: number;
	successfulToolResultEntries: number;
	totalTextBytes: number;
	successfulTextBytes: number;
}

export function emptyCohortTotalsV2(): CohortTotalsV2 {
	return {
		requests: 0,
		compactions: 0,
		cost: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		gross: 0,
		toolResultEntries: 0,
		successfulToolResultEntries: 0,
		totalTextBytes: 0,
		successfulTextBytes: 0,
	};
}

function addRunToTotalsV2(totals: CohortTotalsV2, run: RunFactsV2): void {
	totals.requests += run.requests;
	totals.compactions += run.compactions;
	totals.cost += run.cost;
	totals.input += run.input;
	totals.output += run.output;
	totals.cacheRead += run.cacheRead;
	totals.cacheWrite += run.cacheWrite;
	totals.gross += run.gross;
	totals.toolResultEntries += run.toolResultEntries;
	totals.successfulToolResultEntries += run.successfulToolResultEntries;
	totals.totalTextBytes += run.totalTextBytes;
	totals.successfulTextBytes += run.successfulTextBytes;
}

/** Median of a sorted list (even n: mean of the two middle values). */
export function medianOfV2(sorted: readonly number[]): number | null {
	if (sorted.length === 0) return null;
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid] ?? null;
	return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Sum of the two middle values (median x 2); 2 x middle value for odd n. */
export function middleTwoSumV2(sorted: readonly number[]): number | null {
	if (sorted.length === 0) return null;
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return 2 * (sorted[mid] ?? 0);
	return (sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0);
}

/** Nearest-rank p90: rank = ceil(0.9 x n) (1-based), e.g. rank 18 of 20 (protocol-v2 §3.1). */
export function nearestRankP90V2(sorted: readonly number[]): number | null {
	if (sorted.length === 0) return null;
	const rank = Math.ceil(0.9 * sorted.length);
	return sorted[Math.max(0, rank - 1)] ?? null;
}

export interface ArmFactsV2 {
	arm: ArmName;
	runCount: number;
	requestsMedian: number | null;
	grossMedian: number | null;
	successfulTextBytesMedian: number | null;
	grossP90: number | null;
	totals: CohortTotalsV2;
}

export function buildArmFactsV2(arm: ArmName, runs: readonly RunFactsV2[]): ArmFactsV2 {
	const requests = runs.map((r) => r.requests).sort((a, b) => a - b);
	const gross = runs.map((r) => r.gross).sort((a, b) => a - b);
	const bytes = runs.map((r) => r.successfulTextBytes).sort((a, b) => a - b);
	const totals = emptyCohortTotalsV2();
	for (const run of runs) addRunToTotalsV2(totals, run);
	totals.cost = Math.round(totals.cost * COST_DECIMALS) / COST_DECIMALS;
	return {
		arm,
		runCount: runs.length,
		requestsMedian: medianOfV2(requests),
		grossMedian: medianOfV2(gross),
		successfulTextBytesMedian: medianOfV2(bytes),
		grossP90: nearestRankP90V2(gross),
		totals,
	};
}

export type VerdictStatusV2 = "ACHIEVED" | "MISSED" | "NOT_MEASURED";

export interface VerdictV2 {
	id: VerdictId;
	metricLabel: string;
	thresholdDisplay: string;
	control: number | null;
	treatment: number | null;
	/** Reduction ratio (control - treatment) / control for #1–#3; treatment/control for #4. */
	ratio: number | null;
	status: VerdictStatusV2;
	reason: string;
}

export const VERDICT_LABELS_V2: Record<VerdictId, string> = {
	bytes_median_reduction: "successful inline bytes median reduction",
	gross_median_reduction: "commander gross tokens median reduction",
	requests_median_non_increase: "commander requests median non-increase",
	gross_p90_regression: "commander gross p90 regression",
};

export const VERDICT_THRESHOLDS_V2: Record<VerdictId, string> = {
	bytes_median_reduction: ">= 50%",
	gross_median_reduction: ">= 20%",
	requests_median_non_increase: "treatment median <= control median",
	gross_p90_regression: "treatment p90 <= 1.05 x control p90",
};

const DEV_VERDICT_REASON_V2 =
	"development-phase manifest: development evidence is development evidence only and is never reported (protocol-v2 §4.4); the §8 adoption verdicts are computed exclusively over a final-validation manifest";

function notMeasuredReasonV2(metricLabel: string, why: string): string {
	return `frozen v2 §8 ${metricLabel}: ${why} — verdict NOT_MEASURED (never PASS)`;
}

/** Median-based verdict from middle-two sums (exact integer arithmetic). */
function medianReductionVerdictV2(
	id: VerdictId,
	metricLabel: string,
	thresholdDisplay: string,
	thresholdBasis1000: number,
	controlSum: number | null,
	treatmentSum: number | null,
	controlMedian: number | null,
	treatmentMedian: number | null,
	armLabel: string,
): VerdictV2 {
	if (controlSum === null || treatmentSum === null || controlMedian === null || treatmentMedian === null) {
		return {
			id,
			metricLabel,
			thresholdDisplay,
			control: controlMedian,
			treatment: treatmentMedian,
			ratio: null,
			status: "NOT_MEASURED",
			reason: notMeasuredReasonV2(metricLabel, `no valid runs in the ${armLabel} arm`),
		};
	}
	if (controlSum === 0) {
		return {
			id,
			metricLabel,
			thresholdDisplay,
			control: controlMedian,
			treatment: treatmentMedian,
			ratio: null,
			status: "NOT_MEASURED",
			reason: notMeasuredReasonV2(metricLabel, `the control ${armLabel} median is 0 — zero denominator`),
		};
	}
	const achieved = (controlSum - treatmentSum) * 1000 >= thresholdBasis1000 * controlSum;
	const ratio = (controlSum - treatmentSum) / controlSum;
	const reason =
		id === "requests_median_non_increase"
			? `frozen v2 §8 ${metricLabel} (${thresholdDisplay}): treatment median ${treatmentMedian} ${achieved ? "<=" : ">"} control median ${controlMedian} (median reduction ${ratio.toFixed(4)})`
			: `frozen v2 §8 ${metricLabel} ${thresholdDisplay}: median reduction ${ratio.toFixed(4)} (treatment median ${treatmentMedian} vs control median ${controlMedian}) ${achieved ? ">=" : "<"} threshold`;
	return {
		id,
		metricLabel,
		thresholdDisplay,
		control: controlMedian,
		treatment: treatmentMedian,
		ratio,
		status: achieved ? "ACHIEVED" : "MISSED",
		reason,
	};
}

/**
 * The four frozen §8 verdicts computed directly from the per-run values
 * with exact integer arithmetic: bytes median reduction >= 50%
 * ((Σc − Σt) × 1000 >= 500 × Σc), gross median reduction >= 20%
 * ((Σc − Σt) × 1000 >= 200 × Σc), requests median non-increase
 * (Σt <= Σc), gross nearest-rank p90 <= 105% of control
 * (100 × t <= 105 × c — exactly 20 × t <= 21 × c). Boundary included;
 * dev manifests and zero denominators are always NOT_MEASURED.
 */
export function computeVerdictsFromRunsV2(controlRuns: readonly RunFactsV2[], treatmentRuns: readonly RunFactsV2[], phase: Phase): VerdictV2[] {
	if (phase !== "final") {
		return (VERDICT_IDS as readonly VerdictId[]).map((id) => ({
			id,
			metricLabel: VERDICT_LABELS_V2[id],
			thresholdDisplay: VERDICT_THRESHOLDS_V2[id],
			control: null,
			treatment: null,
			ratio: null,
			status: "NOT_MEASURED" as VerdictStatusV2,
			reason: DEV_VERDICT_REASON_V2,
		}));
	}
	const cBytes = controlRuns.map((r) => r.successfulTextBytes).sort((a, b) => a - b);
	const tBytes = treatmentRuns.map((r) => r.successfulTextBytes).sort((a, b) => a - b);
	const cGross = controlRuns.map((r) => r.gross).sort((a, b) => a - b);
	const tGross = treatmentRuns.map((r) => r.gross).sort((a, b) => a - b);
	const cReq = controlRuns.map((r) => r.requests).sort((a, b) => a - b);
	const tReq = treatmentRuns.map((r) => r.requests).sort((a, b) => a - b);

	const bytes = medianReductionVerdictV2(
		"bytes_median_reduction",
		VERDICT_LABELS_V2.bytes_median_reduction,
		VERDICT_THRESHOLDS_V2.bytes_median_reduction,
		BYTES_MEDIAN_REDUCTION_MIN_PCT * 10,
		middleTwoSumV2(cBytes),
		middleTwoSumV2(tBytes),
		medianOfV2(cBytes),
		medianOfV2(tBytes),
		"successful inline bytes",
	);
	const gross = medianReductionVerdictV2(
		"gross_median_reduction",
		VERDICT_LABELS_V2.gross_median_reduction,
		VERDICT_THRESHOLDS_V2.gross_median_reduction,
		GROSS_MEDIAN_REDUCTION_MIN_PCT * 10,
		middleTwoSumV2(cGross),
		middleTwoSumV2(tGross),
		medianOfV2(cGross),
		medianOfV2(tGross),
		"gross",
	);
	const requests = medianReductionVerdictV2(
		"requests_median_non_increase",
		VERDICT_LABELS_V2.requests_median_non_increase,
		VERDICT_THRESHOLDS_V2.requests_median_non_increase,
		0,
		middleTwoSumV2(cReq),
		middleTwoSumV2(tReq),
		medianOfV2(cReq),
		medianOfV2(tReq),
		"requests",
	);
	// #4: gross p90 tail guard — 100 x treatment <= 105 x control (exactly 20 x t <= 21 x c).
	const cP90 = nearestRankP90V2(cGross);
	const tP90 = nearestRankP90V2(tGross);
	let p90: VerdictV2;
	if (cP90 === null || tP90 === null) {
		p90 = {
			id: "gross_p90_regression",
			metricLabel: VERDICT_LABELS_V2.gross_p90_regression,
			thresholdDisplay: VERDICT_THRESHOLDS_V2.gross_p90_regression,
			control: cP90,
			treatment: tP90,
			ratio: null,
			status: "NOT_MEASURED",
			reason: notMeasuredReasonV2(VERDICT_LABELS_V2.gross_p90_regression, "an arm has no runs"),
		};
	} else if (cP90 === 0) {
		p90 = {
			id: "gross_p90_regression",
			metricLabel: VERDICT_LABELS_V2.gross_p90_regression,
			thresholdDisplay: VERDICT_THRESHOLDS_V2.gross_p90_regression,
			control: cP90,
			treatment: tP90,
			ratio: null,
			status: "NOT_MEASURED",
			reason: notMeasuredReasonV2(VERDICT_LABELS_V2.gross_p90_regression, "the control gross p90 is 0 — zero denominator"),
		};
	} else {
		const achieved = 100 * tP90 <= GROSS_P90_MAX_CONTROL_PCT * cP90;
		const ratio = tP90 / cP90;
		p90 = {
			id: "gross_p90_regression",
			metricLabel: VERDICT_LABELS_V2.gross_p90_regression,
			thresholdDisplay: VERDICT_THRESHOLDS_V2.gross_p90_regression,
			control: cP90,
			treatment: tP90,
			ratio,
			status: achieved ? "ACHIEVED" : "MISSED",
			reason: `frozen v2 §8 ${VERDICT_LABELS_V2.gross_p90_regression} ${VERDICT_THRESHOLDS_V2.gross_p90_regression}: treatment p90 ${tP90} ${achieved ? "<=" : ">"} 1.05 x control p90 ${cP90} (ratio ${ratio.toFixed(4)})`,
		};
	}
	return [bytes, gross, requests, p90];
}
