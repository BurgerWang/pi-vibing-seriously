#!/usr/bin/env tsx
/**
 * NRO benchmark harness (commander-native-tool-optimization plan, slice
 * N0) — OFFLINE, machine facts only. Implements the frozen NRO benchmark
 * protocol (docs/baselines/commander-native-tool-benchmark-protocol.md,
 * plan §10–§12): a NEW independent protocol that never reuses P9/P3
 * artifacts, constants, or baselines.
 *
 * Two subcommands:
 *
 *   analyze <manifest.json> [--json]
 *     Read-only offline analyzer over the strict NRO manifest
 *     (schema_version 1): enforces the frozen pins (milestone prompt,
 *     environment, fixture-manifest hash, non-treatment bundle hash,
 *     rubric hash), the collection shape (final: exactly 20 control + 20
 *     treatment sessions in the frozen ABBA order, gapless attempt
 *     labels, all attempts retained), per-session validity (prompt hash,
 *     model/thinking identity, zero compactions, terminal stop), and
 *     derives per-run machine facts (requests, token components, gross,
 *     cost, total/successful inline bytes, per-tool calls and bytes via
 *     the reused buildCostBreakdown/toolResultTextBytes from
 *     extensions/workbench-runtime/core/cost-breakdown.ts, wall time),
 *     correctness (frozen rubric over the final assistant text),
 *     pagination facts (preview/continuation reads via the frozen
 *     `nro-read-facts:` marker contract, obligations, completion
 *     fractions, reached-complete) and the incomplete-result misuse
 *     sign, then computes the four frozen §11.2 verdicts (bytes median
 *     reduction >= 50%, gross median reduction >= 20%, requests median
 *     non-increase, gross p90 <= 1.05 x control) with exact integer
 *     arithmetic. Dev-phase manifests report facts but the verdicts are
 *     always NOT_MEASURED (development evidence is never reported).
 *     Never writes any file; never calls a model; no network; no shell.
 *
 *   prepare --inputs <dir> --collection <file> [--runs-dir <dir>]
 *     Offline evidence preparation: preflights the frozen inputs dir
 *     (fixture/, milestone-prompt.txt, environment.txt, rubric.json)
 *     against the frozen pins and the collection record (chronological
 *     log of every retained attempt and session), derives and
 *     machine-verifies final-validity facts and attempt categories,
 *     stages byte-exact copies, then commits with EXCLUSIVE create
 *     primitives (non-recursive mkdir + open("wx")) and ownership-
 *     tracked rollback (foreign pre-existing/racing outputs always
 *     survive). Writes only under the runs root; never touches source
 *     files.
 *
 * Privacy: output carries labels, basenames, hashes, counts, numeric
 * facts, model keys, arm names, categories and verdicts only — never
 * message bodies, tool arguments, raw tool-result content, thinking,
 * secrets, or absolute input paths. On failure nothing is written to
 * stdout (stderr only, bounded, basenames only).
 *
 * This harness never writes a result record, verdict, plan status,
 * CHANGELOG entry, or publication claim; dynamic results stay
 * NOT_MEASURED until the commander-owned N4 measurement.
 */

import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCostBreakdown, toolResultTextBytes } from "../extensions/workbench-runtime/core/cost-breakdown.ts";

// ---------------------------------------------------------------------------
// Frozen constants (protocol doc §3)
// ---------------------------------------------------------------------------

export const BENCHMARK_SCHEMA_VERSION = 1;
export const PROTOCOL_DOC = "docs/baselines/commander-native-tool-benchmark-protocol.md";
export const UNKNOWN_TOOL_NAME = "(unknown)";
/** Frozen preview-facts marker emitted by the N1 read override (protocol §8.4). */
export const NRO_FACTS_MARKER = "nro-read-facts:";
/** Exactly 20 valid sessions per arm (protocol §3.1; user-approved pre-final refreeze 2026-08-06 from the initial 30/arm target to the plan-permitted floor 20/arm, before any final validation collection). */
export const RUNS_PER_ARM = 20;
export const INTERLEAVE = "ABBA";
export const EVIDENCE_DIR_NAME = "commander-native-tool-benchmark";
export const MANIFEST_NAME = "commander-native-tool-benchmark-manifest.json";
export const DEVIATIONS_NAME = "collection-deviations.json";
export const COLLECTION_RECORD_NAME = "collection-record.json";
export const DEVIATIONS_SCHEMA_VERSION = 1;
export const COLLECTION_SCHEMA_VERSION = 1;
export const FIXTURE_DIR_NAME = "fixture";
export const MILESTONE_PROMPT_NAME = "milestone-prompt.txt";
export const ENVIRONMENT_NAME = "environment.txt";
export const RUBRIC_NAME = "rubric.json";
export const STAGING_PREFIX = ".nro-prepare-staging-";

export const ARMS = ["control", "treatment"] as const;
export type ArmName = (typeof ARMS)[number];
export const PHASES = ["dev", "final"] as const;
export type Phase = (typeof PHASES)[number];
/** Frozen attempt categories (protocol §8.6; "unclassified" is dev-phase only). */
export const ATTEMPT_CATEGORIES = ["prompt_mismatch", "env_drift", "compaction_present", "aborted", "errored", "nonterminal", "unclassified"] as const;
export type AttemptCategory = (typeof ATTEMPT_CATEGORIES)[number];
export const VERDICT_IDS = ["bytes_median_reduction", "gross_median_reduction", "requests_median_non_increase", "gross_p90_regression"] as const;
export type VerdictId = (typeof VERDICT_IDS)[number];
export type VerdictStatus = "ACHIEVED" | "MISSED" | "NOT_MEASURED";

// ---------------------------------------------------------------------------
// Documented hard bounds (protocol §3.1/§9/§11)
// ---------------------------------------------------------------------------

/** Manifest file size cap (a valid manifest is a few tens of KiB). */
export const MANIFEST_MAX_BYTES = 1_048_576;
/** Per-session file size cap (real sessions are ~0.1–0.2 MiB). */
export const SESSION_MAX_BYTES = 16 * 1024 * 1024;
/** Per-session non-empty JSONL line cap. */
export const SESSION_MAX_LINES = 100_000;
/**
 * Numeric fact cap: every usage fact and every parsed preview-facts
 * count must be a finite non-negative integer <= this. 1e11 keeps every
 * sum and every exact-integer threshold product well below 2^53.
 */
export const MAX_USAGE_FACT = 100_000_000_000;
/** Session label cap (chars). */
export const LABEL_MAX_CHARS = 64;
/** Declared path cap (UTF-8 bytes). */
export const PATH_MAX_BYTES = 512;
/** Output-facing basename cap (chars). */
export const BASENAME_MAX_CHARS = 128;
/** Expected model key cap (chars). */
export const MODEL_KEY_MAX_CHARS = 96;
/** Expected thinking level cap (chars). */
export const THINKING_LEVEL_MAX_CHARS = 32;
/** Tool name cap (chars) — tool names are output-facing identity strings. */
export const TOOL_NAME_MAX_CHARS = 64;
/** Human rendering caps (lines and UTF-8 bytes; deterministic marker on truncation). */
export const HUMAN_MAX_LINES = 240;
export const HUMAN_MAX_BYTES = 64 * 1024;
/** Fixture tree caps (protocol §5.2). */
export const FIXTURE_MAX_BYTES = 64 * 1024 * 1024;
export const FIXTURE_MAX_FILES = 10_000;
/** Rubric caps (protocol §6.2). */
export const RUBRIC_MAX_CHECKS = 32;
export const RUBRIC_PATTERN_MAX_BYTES = 512;
export const CHECK_ID_MAX_CHARS = 64;
/** Collection-record entry cap (protocol §4.5). */
export const COLLECTION_MAX_ENTRIES = 1_000;
/** Environment value cap (chars). */
export const ENV_VALUE_MAX_CHARS = 32;
/** Wall-time cap: non-negative diff <= 30 days, else null (descriptive). */
export const WALL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

const SHA256_RE = /^[0-9a-f]{64}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/;
const THINKING_LEVEL_RE = /^[A-Za-z0-9._-]{1,32}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHECK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** Frozen session label format: `<arm>-<NN>` with zero-padded per-arm occurrence. */
const SESSION_LABEL_RE = /^(control|treatment)-(\d{2})$/;
/** Frozen attempt label format: `attempt-<N>` with gapless 1-based N. */
const ATTEMPT_LABEL_RE = /^attempt-(\d+)$/;
/** Cost is rounded to 9 decimals per run (same convention as the P3 analyzer). */
const COST_DECIMALS = 1e9;

export type NroErrorCode =
	| "IO_ERROR"
	| "INVALID_MANIFEST"
	| "PROTOCOL_NOT_FROZEN"
	| "OVER_BOUND"
	| "LABEL_UNSAFE"
	| "BASENAME_UNSAFE"
	| "MODEL_UNSAFE"
	| "THINKING_UNSAFE"
	| "TOOL_NAME_UNSAFE"
	| "PATH_UNSAFE"
	| "RUBRIC_INVALID"
	| "DUPLICATE_LABEL"
	| "DUPLICATE_PATH"
	| "FILE_MISSING"
	| "MALFORMED_JSONL"
	| "MISSING_USER_MESSAGE"
	| "MISSING_PROMPT_TEXT"
	| "MISSING_ASSISTANT_USAGE"
	| "MISSING_THINKING_LEVEL"
	| "INVALID_FACTS"
	| "FACTS_MALFORMED"
	| "PROMPT_MISMATCH"
	| "HASH_MISMATCH"
	| "MODEL_MISMATCH"
	| "THINKING_MISMATCH"
	| "COMPACTION_PRESENT"
	| "ABORTED"
	| "ERRORED"
	| "NOT_TERMINAL_STOP"
	| "COHORT_COUNT"
	| "LABEL_MISMATCH"
	| "ARM_MISMATCH"
	| "ORDER_MISMATCH"
	| "ATTEMPT_LABELS"
	| "ATTEMPT_NOT_INVALID"
	| "CATEGORY_MISMATCH"
	| "FIXTURE_MISMATCH"
	| "FIXTURE_UNSAFE"
	| "ENV_MISMATCH"
	| "ENV_FILE_INVALID"
	| "MILESTONE_MISMATCH"
	| "RUBRIC_MISMATCH"
	| "NON_TREATMENT_MISMATCH"
	| "INPUTS_INVALID"
	| "COLLECTION_INVALID"
	| "SOURCE_UNREADABLE"
	| "SOURCE_NOT_REGULAR"
	| "SOURCE_OVER_BOUND"
	| "DUPLICATE_SOURCE"
	| "EXISTING_OUTPUT"
	| "STAGE_VERIFY"
	| "ARITY";

/** Structured failure — fail closed, never a partial report. */
export class NroError extends Error {
	readonly code: NroErrorCode;
	constructor(code: NroErrorCode, message: string) {
		super(message);
		this.name = "NroError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Frozen protocol (analyzer + prepare implement exactly this)
// ---------------------------------------------------------------------------

export interface FrozenEnvironment {
	modelKey: string;
	thinkingLevel: string;
	piVersion: string;
	nodeVersion: string;
}

export interface FrozenProtocol {
	/**
	 * Content pins — protocol constants resolved by the Sol-approved
	 * fixture-freeze step BEFORE any collection (protocol §3.2). The
	 * production protocol below carries the four resolved values; a null
	 * pin appears only in derived/unfrozen protocols, for which
	 * prepare/analyze fail closed with PROTOCOL_NOT_FROZEN (no evidence
	 * may be committed or analyzed against an unfrozen protocol).
	 */
	milestonePromptSha256: string | null;
	environment: FrozenEnvironment;
	fixtureManifestSha256: string | null;
	nonTreatmentSha256: string | null;
	rubricSha256: string | null;
	/** Exactly 20 (frozen). */
	runsPerArm: number;
	interleave: "ABBA";
}

/**
 * The frozen NRO protocol. The environment (provider/model, thinking
 * level, Pi 0.83.0, Node v26.4.0) and all structural constants are
 * frozen at N0; the four content pins are resolved at the Sol-approved
 * fixture-freeze slice (protocol §3.2) and hard-coded below — they
 * reproduce the frozen inputs (milestone-prompt.txt, fixture/,
 * rubric.json) and the frozen non-treatment bundle (AGENTS.md + skills/
 * + prompts/ + templates/) byte-for-byte.
 */
export const FROZEN_NRO_PROTOCOL: FrozenProtocol = {
	milestonePromptSha256: "1af10ebb1abfec5aba9744841980da66c9ee8e12720d589caa623350fb608a40",
	environment: { modelKey: "openai-codex/gpt-5.6-sol", thinkingLevel: "high", piVersion: "0.83.0", nodeVersion: "v26.4.0" },
	fixtureManifestSha256: "062b3c92a8a36825394f0fa80b94808f2457ca5b63e8bbf9a70ff24339c216b6",
	nonTreatmentSha256: "b7cc04cc44345f448105ab4272a9e80d795f79e663041f7b7f2276132448a2bd",
	rubricSha256: "dccfd406a69f7582a5fc44daad420d8e177c993cf3a7110ae11c6686beab74ed",
	runsPerArm: RUNS_PER_ARM,
	interleave: INTERLEAVE,
};

/** Fail closed when any content pin is still unresolved. */
export function requireFrozenProtocol(protocol: FrozenProtocol): void {
	const missing: string[] = [];
	if (protocol.milestonePromptSha256 === null) missing.push("milestone_prompt_sha256");
	if (protocol.fixtureManifestSha256 === null) missing.push("fixture_manifest_sha256");
	if (protocol.nonTreatmentSha256 === null) missing.push("non_treatment_sha256");
	if (protocol.rubricSha256 === null) missing.push("rubric_sha256");
	if (missing.length > 0) {
		throw new NroError(
			"PROTOCOL_NOT_FROZEN",
			`the NRO content pin(s) ${missing.join(", ")} are not yet resolved — the fixture-freeze step (protocol §3.2) must pin them before any collection or analysis`,
		);
	}
}

// ---------------------------------------------------------------------------
// Frozen ABBA interleave (protocol §4.2)
// ---------------------------------------------------------------------------

/** Arm at 1-based collection position i: control when (i-1) % 4 in {0, 3}. */
export function abbaArmAt(position: number): ArmName {
	const r = (position - 1) % 4;
	return r === 0 || r === 3 ? "control" : "treatment";
}

/** The 1-based positions of an arm under the frozen ABBA interleave. */
export function abbaPositionsOf(arm: ArmName, runsPerArm: number = RUNS_PER_ARM): number[] {
	const out: number[] = [];
	for (let i = 1; i <= 2 * runsPerArm; i += 1) {
		if (abbaArmAt(i) === arm) out.push(i);
	}
	return out;
}

/** Frozen session label for the n-th session of an arm (zero-padded, 2 digits). */
export function sessionLabel(arm: ArmName, n: number): string {
	return `${arm}-${String(n).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Code-point-safe UTF-8 byte truncation with an explicit "…" marker. */
function truncateUtf8(text: string, maxBytes: number): string {
	let used = 0;
	const out: string[] = [];
	for (const ch of text) {
		const bytes = utf8Bytes(ch);
		if (used + bytes > maxBytes) return out.join("");
		used += bytes;
		out.push(ch);
	}
	return text;
}

const CONTROL_RE = /[\x00-\x1f\x7f]/g;
/**
 * Non-global control-character predicate. A global regex carries `lastIndex`
 * state between `.test()` calls (alternating results on repeated use) —
 * predicates must use this stateless variant; only `.replace()` uses the
 * global one (String.replace resets lastIndex per call).
 */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/** Sanitized + bounded display form (control chars replaced; never injects lines). */
function boundedDisplay(text: unknown, maxBytes: number): { text: string; altered: boolean } {
	if (typeof text !== "string") return { text: "(invalid)", altered: true };
	const cleaned = text.replace(CONTROL_RE, " ");
	if (utf8Bytes(cleaned) <= maxBytes) return { text: cleaned, altered: cleaned !== text };
	return { text: `${truncateUtf8(cleaned, Math.max(0, maxBytes - 3))}…`, altered: true };
}

/** Sanitized value for error messages (control chars replaced, byte-bounded). */
function safeErrorValue(value: string): string {
	const cleaned = value.replace(CONTROL_RE, " ");
	if (utf8Bytes(cleaned) <= 64) return cleaned;
	return `${truncateUtf8(cleaned, 61)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Unknown-key refusal with a caller-supplied domain error code (default
 * INVALID_MANIFEST for the strict manifest; collection/rubric parsers pass
 * COLLECTION_INVALID / RUBRIC_INVALID so every domain reports its own code).
 */
function requireKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string, code: NroErrorCode = "INVALID_MANIFEST"): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) throw new NroError(code, `unknown key "${safeErrorValue(key)}" in ${where}`);
	}
}

function requireBoundedInt(value: unknown, where: string, code: NroErrorCode = "INVALID_MANIFEST"): number {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > MAX_USAGE_FACT) {
		throw new NroError(code, `${where} must be a finite non-negative integer no greater than ${MAX_USAGE_FACT}`);
	}
	return value;
}

/** Structural deep equality (key-order independent). */
function deepEqual(a: unknown, b: unknown): boolean {
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
		if (!deepEqual(ra[key], rb[key])) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Manifest schema (strict, schema_version 1 — protocol §7)
// ---------------------------------------------------------------------------

export interface ManifestEnvironment {
	modelKey: string;
	thinkingLevel: string;
	piVersion: string;
	nodeVersion: string;
}

export interface RubricCheck {
	id: string;
	pattern: string;
}

export interface ManifestFixture {
	path: string;
	manifestSha256: string;
}

export interface ManifestSession {
	label: string;
	arm: ArmName;
	orderIndex: number;
	path: string;
	expectedSessionSha256: string;
}

export interface ManifestAttempt {
	label: string;
	arm: ArmName;
	path: string;
	expectedSessionSha256: string;
	/** Extracted prompt hash; null when the attempt has no user message. */
	promptSha256: string | null;
	category: AttemptCategory;
}

export interface NroManifest {
	schemaVersion: number;
	protocolDoc: string;
	phase: Phase;
	milestonePromptSha256: string;
	environment: ManifestEnvironment;
	fixture: ManifestFixture;
	nonTreatmentSha256: string;
	rubric: { sha256: string; checks: RubricCheck[] };
	sessions: ManifestSession[];
	attempts: ManifestAttempt[];
}

const MANIFEST_TOP_KEYS = ["schema_version", "protocol_doc", "phase", "milestone_prompt_sha256", "environment", "fixture", "non_treatment_sha256", "rubric", "sessions", "attempts"] as const;
const ENV_KEYS = ["model_key", "thinking_level", "pi_version", "node_version"] as const;
const FIXTURE_KEYS = ["path", "manifest_sha256"] as const;
const RUBRIC_KEYS = ["sha256", "checks"] as const;
const CHECK_KEYS = ["id", "pattern"] as const;
const SESSION_KEYS = ["label", "arm", "order_index", "path", "expected_session_sha256"] as const;
const ATTEMPT_KEYS = ["label", "arm", "path", "expected_session_sha256", "prompt_sha256", "category"] as const;

function parseArm(value: unknown, where: string): ArmName {
	if (value !== "control" && value !== "treatment") {
		throw new NroError("INVALID_MANIFEST", `${where} must be "control" or "treatment"`);
	}
	return value;
}

function parseSha256(value: unknown, where: string): string {
	if (typeof value !== "string" || !SHA256_RE.test(value)) {
		throw new NroError("INVALID_MANIFEST", `${where} must be a 64-hex SHA-256 string`);
	}
	return value;
}

function requirePin(declared: string, pin: string | null, pinName: string): void {
	if (pin === null) {
		throw new NroError("PROTOCOL_NOT_FROZEN", `the NRO content pin ${pinName} is not yet resolved (protocol §3.2)`);
	}
	if (declared !== pin) {
		throw new NroError("INVALID_MANIFEST", `${pinName} must equal the frozen pin ${pin} (declared ${declared})`);
	}
}

function validateRubricChecks(raw: unknown, where: string): RubricCheck[] {
	if (!Array.isArray(raw)) throw new NroError("RUBRIC_INVALID", `${where} must be an array`);
	if (raw.length < 1) throw new NroError("RUBRIC_INVALID", `${where} must contain at least one check`);
	if (raw.length > RUBRIC_MAX_CHECKS) throw new NroError("RUBRIC_INVALID", `${where} must contain at most ${RUBRIC_MAX_CHECKS} checks`);
	const checks: RubricCheck[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < raw.length; i += 1) {
		const c = asRecord(raw[i]);
		if (!c) throw new NroError("RUBRIC_INVALID", `${where}[${i}] must be an object`);
		requireKeys(c, CHECK_KEYS, `${where}[${i}]`, "RUBRIC_INVALID");
		const id = c.id;
		if (typeof id !== "string" || !CHECK_ID_RE.test(id)) {
			throw new NroError("RUBRIC_INVALID", `${where}[${i}].id must match [A-Za-z0-9][A-Za-z0-9._-]* with at most ${CHECK_ID_MAX_CHARS} characters`);
		}
		if (seen.has(id)) throw new NroError("RUBRIC_INVALID", `duplicate rubric check id "${safeErrorValue(id)}"`);
		seen.add(id);
		const pattern = c.pattern;
		if (typeof pattern !== "string" || pattern.length === 0 || utf8Bytes(pattern) > RUBRIC_PATTERN_MAX_BYTES) {
			throw new NroError("RUBRIC_INVALID", `${where}[${i}].pattern must be a non-empty string of at most ${RUBRIC_PATTERN_MAX_BYTES} UTF-8 bytes`);
		}
		try {
			// eslint-disable-next-line no-new
			new RegExp(pattern);
		} catch {
			throw new NroError("RUBRIC_INVALID", `${where}[${i}].pattern must be a compilable regular expression`);
		}
		checks.push({ id, pattern });
	}
	return checks;
}

/**
 * Strictly parse the NRO manifest. Unknown keys, wrong schema version,
 * wrong protocol_doc, invalid phase, any pin drift (prompt, environment,
 * fixture, non-treatment, rubric), malformed/unsafe/bounded identities,
 * duplicate labels, final-phase count/label/arm/order drift, attempt
 * label gaps and malformed sessions/attempts all fail closed.
 */
export function parseManifest(text: string, protocol: FrozenProtocol = FROZEN_NRO_PROTOCOL): NroManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new NroError("INVALID_MANIFEST", "manifest is not valid JSON");
	}
	const root = asRecord(raw);
	if (!root) throw new NroError("INVALID_MANIFEST", "manifest must be a JSON object");
	requireKeys(root, MANIFEST_TOP_KEYS, "manifest");
	if (root.schema_version !== BENCHMARK_SCHEMA_VERSION) {
		throw new NroError("INVALID_MANIFEST", `schema_version must be ${BENCHMARK_SCHEMA_VERSION}`);
	}
	if (root.protocol_doc !== PROTOCOL_DOC) {
		throw new NroError("INVALID_MANIFEST", `protocol_doc must be exactly "${PROTOCOL_DOC}"`);
	}
	if (root.phase !== "dev" && root.phase !== "final") {
		throw new NroError("INVALID_MANIFEST", 'phase must be "dev" or "final"');
	}
	const phase: Phase = root.phase;

	const milestoneSha = parseSha256(root.milestone_prompt_sha256, "milestone_prompt_sha256");
	requirePin(milestoneSha, protocol.milestonePromptSha256, "milestone_prompt_sha256");

	const envRaw = asRecord(root.environment);
	if (!envRaw) throw new NroError("INVALID_MANIFEST", "environment must be an object");
	requireKeys(envRaw, ENV_KEYS, "environment");
	const modelKey = envRaw.model_key;
	if (typeof modelKey !== "string" || !MODEL_KEY_RE.test(modelKey)) {
		throw new NroError("MODEL_UNSAFE", `environment.model_key must match [A-Za-z0-9][A-Za-z0-9._/-]* with at most ${MODEL_KEY_MAX_CHARS} characters`);
	}
	const thinkingLevel = envRaw.thinking_level;
	if (typeof thinkingLevel !== "string" || !THINKING_LEVEL_RE.test(thinkingLevel)) {
		throw new NroError("THINKING_UNSAFE", `environment.thinking_level must match [A-Za-z0-9._-]* with at most ${THINKING_LEVEL_MAX_CHARS} characters`);
	}
	const piVersion = envRaw.pi_version;
	if (typeof piVersion !== "string" || !VERSION_RE.test(piVersion)) {
		throw new NroError("INVALID_MANIFEST", `environment.pi_version must be a bounded safe version string (at most ${ENV_VALUE_MAX_CHARS} characters)`);
	}
	const nodeVersion = envRaw.node_version;
	if (typeof nodeVersion !== "string" || !VERSION_RE.test(nodeVersion)) {
		throw new NroError("INVALID_MANIFEST", `environment.node_version must be a bounded safe version string (at most ${ENV_VALUE_MAX_CHARS} characters)`);
	}
	const environment: ManifestEnvironment = { modelKey, thinkingLevel, piVersion, nodeVersion };
	if (!deepEqual(environment, protocol.environment)) {
		throw new NroError(
			"INVALID_MANIFEST",
			`environment must be the pinned environment (model ${protocol.environment.modelKey}, thinking ${protocol.environment.thinkingLevel}, Pi ${protocol.environment.piVersion}, Node ${protocol.environment.nodeVersion})`,
		);
	}

	const fixtureRaw = asRecord(root.fixture);
	if (!fixtureRaw) throw new NroError("INVALID_MANIFEST", "fixture must be an object");
	requireKeys(fixtureRaw, FIXTURE_KEYS, "fixture");
	const fixturePath = fixtureRaw.path;
	if (typeof fixturePath !== "string" || fixturePath.length === 0) {
		throw new NroError("INVALID_MANIFEST", "fixture.path must be a non-empty string");
	}
	if (utf8Bytes(fixturePath) > PATH_MAX_BYTES) {
		throw new NroError("OVER_BOUND", `fixture.path exceeds ${PATH_MAX_BYTES} bytes`);
	}
	if (fixturePath.includes("\0")) throw new NroError("PATH_UNSAFE", "fixture.path contains a NUL byte");
	const fixtureManifestSha = parseSha256(fixtureRaw.manifest_sha256, "fixture.manifest_sha256");
	requirePin(fixtureManifestSha, protocol.fixtureManifestSha256, "fixture_manifest_sha256");
	const fixture: ManifestFixture = { path: fixturePath, manifestSha256: fixtureManifestSha };

	const nonTreatmentSha = parseSha256(root.non_treatment_sha256, "non_treatment_sha256");
	requirePin(nonTreatmentSha, protocol.nonTreatmentSha256, "non_treatment_sha256");

	const rubricRaw = asRecord(root.rubric);
	if (!rubricRaw) throw new NroError("INVALID_MANIFEST", "rubric must be an object");
	requireKeys(rubricRaw, RUBRIC_KEYS, "rubric");
	const rubricSha = parseSha256(rubricRaw.sha256, "rubric.sha256");
	requirePin(rubricSha, protocol.rubricSha256, "rubric_sha256");
	const checks = validateRubricChecks(rubricRaw.checks, "rubric.checks");

	const sessionsRaw = root.sessions;
	if (!Array.isArray(sessionsRaw)) throw new NroError("INVALID_MANIFEST", "sessions must be an array");
	const sessions: ManifestSession[] = [];
	const seenLabels = new Set<string>();
	for (let i = 0; i < sessionsRaw.length; i += 1) {
		const s = asRecord(sessionsRaw[i]);
		if (!s) throw new NroError("INVALID_MANIFEST", `sessions[${i}] must be an object`);
		requireKeys(s, SESSION_KEYS, `sessions[${i}]`);
		const label = s.label;
		if (typeof label !== "string" || !LABEL_RE.test(label)) {
			throw new NroError("LABEL_UNSAFE", `sessions[${i}].label must match [A-Za-z0-9][A-Za-z0-9._-]* with at most ${LABEL_MAX_CHARS} characters`);
		}
		if (seenLabels.has(label)) throw new NroError("DUPLICATE_LABEL", `duplicate session label "${safeErrorValue(label)}"`);
		seenLabels.add(label);
		const arm = parseArm(s.arm, `sessions[${i}].arm`);
		const orderIndex = s.order_index;
		if (typeof orderIndex !== "number" || !Number.isInteger(orderIndex) || orderIndex < 1 || orderIndex > COLLECTION_MAX_ENTRIES) {
			throw new NroError("INVALID_MANIFEST", `sessions[${i}].order_index must be a positive integer no greater than ${COLLECTION_MAX_ENTRIES}`);
		}
		const path = s.path;
		if (typeof path !== "string" || path.length === 0) {
			throw new NroError("INVALID_MANIFEST", `sessions[${i}].path must be a non-empty string`);
		}
		if (utf8Bytes(path) > PATH_MAX_BYTES) {
			throw new NroError("OVER_BOUND", `sessions[${i}].path exceeds ${PATH_MAX_BYTES} bytes`);
		}
		if (!BASENAME_RE.test(basename(path))) {
			throw new NroError("BASENAME_UNSAFE", `sessions[${i}].path basename must match [A-Za-z0-9][A-Za-z0-9._-]* with at most ${BASENAME_MAX_CHARS} characters`);
		}
		const expectedSha = parseSha256(s.expected_session_sha256, `sessions[${i}].expected_session_sha256`);
		sessions.push({ label, arm, orderIndex, path, expectedSessionSha256: expectedSha });
	}
	if (sessions.length < 1) throw new NroError("COHORT_COUNT", "the manifest must declare at least one session");

	const attemptsRaw = root.attempts;
	if (!Array.isArray(attemptsRaw)) throw new NroError("INVALID_MANIFEST", "attempts must be an array");
	if (attemptsRaw.length > COLLECTION_MAX_ENTRIES) throw new NroError("OVER_BOUND", `attempts exceeds ${COLLECTION_MAX_ENTRIES} entries`);
	const attempts: ManifestAttempt[] = [];
	const seenAttemptLabels = new Set<string>();
	for (let i = 0; i < attemptsRaw.length; i += 1) {
		const a = asRecord(attemptsRaw[i]);
		if (!a) throw new NroError("INVALID_MANIFEST", `attempts[${i}] must be an object`);
		requireKeys(a, ATTEMPT_KEYS, `attempts[${i}]`);
		const label = a.label;
		if (typeof label !== "string" || !ATTEMPT_LABEL_RE.test(label)) {
			throw new NroError("LABEL_UNSAFE", `attempts[${i}].label must be "attempt-<N>" with N a positive integer`);
		}
		if (seenAttemptLabels.has(label)) throw new NroError("DUPLICATE_LABEL", `duplicate attempt label "${safeErrorValue(label)}"`);
		seenAttemptLabels.add(label);
		const arm = parseArm(a.arm, `attempts[${i}].arm`);
		const path = a.path;
		if (typeof path !== "string" || path.length === 0) {
			throw new NroError("INVALID_MANIFEST", `attempts[${i}].path must be a non-empty string`);
		}
		if (utf8Bytes(path) > PATH_MAX_BYTES) {
			throw new NroError("OVER_BOUND", `attempts[${i}].path exceeds ${PATH_MAX_BYTES} bytes`);
		}
		if (!BASENAME_RE.test(basename(path))) {
			throw new NroError("BASENAME_UNSAFE", `attempts[${i}].path basename must match [A-Za-z0-9][A-Za-z0-9._-]* with at most ${BASENAME_MAX_CHARS} characters`);
		}
		const expectedSha = parseSha256(a.expected_session_sha256, `attempts[${i}].expected_session_sha256`);
		const promptShaRaw = a.prompt_sha256;
		let promptSha: string | null;
		if (promptShaRaw === null) {
			promptSha = null;
		} else {
			promptSha = parseSha256(promptShaRaw, `attempts[${i}].prompt_sha256`);
		}
		const category = a.category;
		if (typeof category !== "string" || !(ATTEMPT_CATEGORIES as readonly string[]).includes(category)) {
			throw new NroError("INVALID_MANIFEST", `attempts[${i}].category must be one of ${ATTEMPT_CATEGORIES.join(", ")}`);
		}
		if (phase === "final" && category === "unclassified") {
			throw new NroError("INVALID_MANIFEST", `attempts[${i}].category "unclassified" is dev-phase only`);
		}
		attempts.push({ label, arm, path, expectedSessionSha256: expectedSha, promptSha256: promptSha, category: category as AttemptCategory });
	}
	// Attempt labels must be gapless attempt-1..attempt-N in array order (protocol §4.3).
	for (let i = 0; i < attempts.length; i += 1) {
		const expected = `attempt-${i + 1}`;
		const actual = attempts[i]?.label;
		if (actual !== expected) {
			throw new NroError("ATTEMPT_LABELS", `attempt labels must be exactly attempt-1..attempt-${attempts.length} in chronological order — missing/dropped attempt "${safeErrorValue(actual ?? "(missing)")}" (expected "${expected}")`);
		}
	}

	validateSessionShape(sessions, phase, protocol.runsPerArm);

	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
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
 * Enforce the frozen session shape: per-arm occurrence labels
 * (`arm-0N`), strictly increasing order_index. Final phase additionally
 * requires exactly 2 x runsPerArm sessions (20 per arm) whose arms and
 * label numbers reproduce the frozen ABBA bijection between labels,
 * positions, and arms (protocol §4.2).
 */
export function validateSessionShape(sessions: readonly ManifestSession[], phase: Phase, runsPerArm: number = RUNS_PER_ARM): void {
	const byArm = new Map<ArmName, number>();
	const seenOrder = new Set<number>();
	let lastOrder = 0;
	for (const s of sessions) {
		const m = SESSION_LABEL_RE.exec(s.label);
		if (!m) throw new NroError("LABEL_MISMATCH", `session label "${safeErrorValue(s.label)}" must be <arm>-<NN> with NN the zero-padded per-arm occurrence number`);
		const labelArm = m[1] as ArmName;
		const labelN = Number(m[2]);
		if (labelArm !== s.arm) {
			throw new NroError("LABEL_MISMATCH", `session "${safeErrorValue(s.label)}" declares arm ${s.arm} but its label arm is ${labelArm}`);
		}
		const occurrence = (byArm.get(s.arm) ?? 0) + 1;
		if (labelN !== occurrence) {
			throw new NroError(
				"LABEL_MISMATCH",
				`session "${safeErrorValue(s.label)}" is the ${occurrence}-th ${s.arm} session but its label number is ${labelN}`,
			);
		}
		if (labelN > 99) throw new NroError("LABEL_MISMATCH", `session label "${safeErrorValue(s.label)}" exceeds the frozen 2-digit label space`);
		byArm.set(s.arm, occurrence);
		if (seenOrder.has(s.orderIndex)) throw new NroError("ORDER_MISMATCH", `duplicate order_index ${s.orderIndex}`);
		seenOrder.add(s.orderIndex);
		if (s.orderIndex <= lastOrder) {
			throw new NroError("ORDER_MISMATCH", "sessions must be declared in strictly increasing order_index order");
		}
		lastOrder = s.orderIndex;
	}
	const firstSession = sessions[0];
	if (firstSession && firstSession.orderIndex !== 1) {
		throw new NroError("ORDER_MISMATCH", "sessions must start at order_index 1 (strictly increasing from 1)");
	}
	if (phase === "final") {
		const controlCount = byArm.get("control") ?? 0;
		const treatmentCount = byArm.get("treatment") ?? 0;
		if (sessions.length !== 2 * runsPerArm || controlCount !== runsPerArm || treatmentCount !== runsPerArm) {
			throw new NroError(
				"COHORT_COUNT",
				`a final manifest must contain exactly ${runsPerArm} control + ${runsPerArm} treatment sessions (got ${controlCount} control / ${treatmentCount} treatment / ${sessions.length} total)`,
			);
		}
		const expectedOrder = new Set<number>(Array.from({ length: 2 * runsPerArm }, (_, i) => i + 1));
		if (seenOrder.size !== expectedOrder.size || [...seenOrder].some((o) => !expectedOrder.has(o))) {
			throw new NroError("ORDER_MISMATCH", `final order_index values must be exactly 1..${2 * runsPerArm}`);
		}
		const controlPositions = abbaPositionsOf("control", runsPerArm);
		const treatmentPositions = abbaPositionsOf("treatment", runsPerArm);
		const positionArm = new Map<number, ArmName>();
		const positionLabelNumber = new Map<number, number>();
		for (let n = 1; n <= runsPerArm; n += 1) {
			const cp = controlPositions[n - 1];
			if (cp === undefined) throw new NroError("ORDER_MISMATCH", "frozen ABBA control positions are incomplete");
			positionArm.set(cp, "control");
			positionLabelNumber.set(cp, n);
			const tp = treatmentPositions[n - 1];
			if (tp === undefined) throw new NroError("ORDER_MISMATCH", "frozen ABBA treatment positions are incomplete");
			positionArm.set(tp, "treatment");
			positionLabelNumber.set(tp, n);
		}
		for (const s of sessions) {
			const expectedArm = positionArm.get(s.orderIndex);
			if (expectedArm === undefined) throw new NroError("ORDER_MISMATCH", `order_index ${s.orderIndex} is outside the frozen ABBA position set`);
			if (s.arm !== expectedArm) {
				throw new NroError("ARM_MISMATCH", `session "${safeErrorValue(s.label)}" at ABBA position ${s.orderIndex} must be ${expectedArm}, got ${s.arm}`);
			}
			const m = SESSION_LABEL_RE.exec(s.label);
			const expectedN = positionLabelNumber.get(s.orderIndex);
			if (!m || expectedN === undefined || Number(m[2]) !== expectedN) {
				throw new NroError(
					"ORDER_MISMATCH",
					`session "${safeErrorValue(s.label)}" must sit at the ${expectedN}-th ${s.arm} position of the frozen ABBA interleave`,
				);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Path safety (relative to the manifest directory, realpath contained)
// ---------------------------------------------------------------------------

/**
 * Resolve a declared path against a base directory. Absolute POSIX
 * paths, Windows drive/UNC paths, NUL bytes and ".." segments are
 * rejected; the realpath containment check in buildReport refuses any
 * file that resolves outside the base directory (symlink escapes
 * included).
 */
export function resolveSessionPath(baseDir: string, rawPath: string): string {
	if (rawPath.startsWith("/")) throw new NroError("PATH_UNSAFE", "path must be relative (absolute path rejected)");
	if (/^[A-Za-z]:[\\/]/.test(rawPath)) throw new NroError("PATH_UNSAFE", "path must be relative (drive path rejected)");
	if (rawPath.startsWith("\\\\")) throw new NroError("PATH_UNSAFE", "path must be relative (UNC path rejected)");
	if (rawPath.includes("\0")) throw new NroError("PATH_UNSAFE", "path contains a NUL byte");
	const segments = rawPath.split(/[\\/]+/);
	if (segments.some((s) => s === "..")) throw new NroError("PATH_UNSAFE", "path must not contain '..' segments");
	return resolve(baseDir, rawPath);
}

// ---------------------------------------------------------------------------
// Session parsing and strict validation
// ---------------------------------------------------------------------------

/** Strict JSONL: every non-empty line must parse as a JSON object. */
export function parseSessionLines(text: string, label: string): unknown[] {
	const entries: unknown[] = [];
	const clean = text.replace(/^\uFEFF/, "");
	const lines = clean.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = (lines[i] ?? "").trim();
		if (line.length === 0) continue;
		if (entries.length >= SESSION_MAX_LINES) {
			throw new NroError("OVER_BOUND", `session "${safeErrorValue(label)}": more than ${SESSION_MAX_LINES} non-empty JSONL lines`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new NroError("MALFORMED_JSONL", `session "${safeErrorValue(label)}": line ${i + 1} is not valid JSON`);
		}
		if (!asRecord(parsed)) throw new NroError("MALFORMED_JSONL", `session "${safeErrorValue(label)}": line ${i + 1} is not a JSON object`);
		entries.push(parsed);
	}
	return entries;
}

function requireValidUsageField(usage: Record<string, unknown>, key: string, integerRequired: boolean, where: string): void {
	const value = usage[key];
	if (value === undefined) return; // absent component contributes zero (buildCostBreakdown semantics)
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_USAGE_FACT || (integerRequired && !Number.isInteger(value))) {
		throw new NroError(
			"INVALID_FACTS",
			`${where} usage.${key} must be a finite non-negative ${integerRequired ? "integer" : "number"} no greater than ${MAX_USAGE_FACT}`,
		);
	}
}

/** Strict usage validation (fail closed) — any present-but-invalid fact rejects. */
export function validateUsage(usage: unknown, where: string): void {
	const u = asRecord(usage);
	if (!u) throw new NroError("INVALID_FACTS", `${where} usage must be an object`);
	for (const key of ["input", "output", "cacheRead", "cacheWrite"]) requireValidUsageField(u, key, true, where);
	const cost = u.cost;
	if (cost !== undefined) {
		const c = asRecord(cost);
		if (!c) throw new NroError("INVALID_FACTS", `${where} usage.cost must be an object`);
		requireValidUsageField(c, "total", false, where);
	}
}

/**
 * Strict session validation. Attempts (requireAssistant=false) skip the
 * user AND assistant presence requirements — broken sessions are the
 * point of an attempt, and an attempt with no user message carries a
 * `null` prompt hash (protocol §8.6) instead of failing — but JSONL
 * strictness and usage validation always apply.
 */
export function validateEntries(entries: readonly unknown[], label: string, requireAssistant: boolean = true): void {
	let userCount = 0;
	let assistantCount = 0;
	for (const entry of entries) {
		const e = asRecord(entry);
		if (!e) continue;
		if (e.type !== "message") {
			if ((e.type === "compaction" || e.type === "branch_summary") && e.usage !== undefined) {
				validateUsage(e.usage, `session "${safeErrorValue(label)}"`);
			}
			continue;
		}
		const m = asRecord(e.message);
		if (!m) throw new NroError("MALFORMED_JSONL", `session "${safeErrorValue(label)}": message entry without a message object`);
		if (m.role === "user") {
			userCount += 1;
			continue;
		}
		if (m.usage !== undefined) validateUsage(m.usage, `session "${safeErrorValue(label)}"`);
		if (m.role === "assistant") {
			assistantCount += 1;
			if (m.usage === undefined || !asRecord(m.usage)) {
				throw new NroError("MISSING_ASSISTANT_USAGE", `session "${safeErrorValue(label)}": assistant message has no usage object`);
			}
		}
	}
	if (requireAssistant && userCount === 0) throw new NroError("MISSING_USER_MESSAGE", `session "${safeErrorValue(label)}": no user message`);
	if (requireAssistant && assistantCount === 0) {
		throw new NroError("MISSING_ASSISTANT_USAGE", `session "${safeErrorValue(label)}": no assistant message with usage`);
	}
}

/**
 * Extract the first user-message text ONLY to hash it (concatenated text
 * parts of the first user message). The text is never stored, rendered
 * or persisted.
 */
export function extractPromptText(entries: readonly unknown[]): string {
	for (const entry of entries) {
		const e = asRecord(entry);
		if (!e || e.type !== "message") continue;
		const m = asRecord(e.message);
		if (!m || m.role !== "user") continue;
		const content = m.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			let text = "";
			for (const item of content) {
				const it = asRecord(item);
				if (it && it.type === "text" && typeof it.text === "string") text += it.text;
			}
			return text;
		}
		return "";
	}
	throw new NroError("MISSING_USER_MESSAGE", "no user message found");
}

/** Lenient variant for attempts: null when no user message exists. */
function extractPromptTextLenient(entries: readonly unknown[]): string | null {
	try {
		return extractPromptText(entries);
	} catch (error) {
		if (error instanceof NroError && error.code === "MISSING_USER_MESSAGE") return null;
		throw error;
	}
}

/** Pi session assistant stop reasons (session-format.md; frozen semantics). */
const KNOWN_STOP_REASONS = ["stop", "length", "toolUse", "error", "aborted"] as const;
/** Known Pi session entry types — identity facts are bounded to this set. */
const KNOWN_ENTRY_TYPES = ["session", "session_info", "model_change", "thinking_level_change", "message", "compaction", "branch_summary", "custom"] as const;
/** Known Pi message roles — identity facts are bounded to this set. */
const KNOWN_MESSAGE_ROLES = ["user", "assistant", "toolResult"] as const;

export interface TerminalFacts {
	messageCount: number;
	assistantMessageCount: number;
	compactionCount: number;
	lastEntryType: string | null;
	lastMessageRole: string | null;
	lastAssistantStopReason: string | null;
	/** The last message entry is an assistant message whose stopReason is exactly "stop". */
	terminalStop: boolean;
	/** The last assistant message's stopReason is "aborted". */
	aborted: boolean;
	/** The last assistant message's stopReason is "error". */
	errored: boolean;
}

/** Bounded, privacy-safe terminal facts (identity values bounded to the fixed known sets). */
export function terminalStateOf(entries: readonly unknown[]): TerminalFacts {
	let messageCount = 0;
	let assistantMessageCount = 0;
	let compactionCount = 0;
	let lastEntryType: string | null = null;
	let lastMessageRole: string | null = null;
	let lastAssistantStopReason: string | null = null;
	for (const entry of entries) {
		const e = asRecord(entry);
		if (!e) continue;
		const entryType = typeof e.type === "string" ? e.type : null;
		lastEntryType = entryType !== null && (KNOWN_ENTRY_TYPES as readonly string[]).includes(entryType) ? entryType : null;
		if (entryType === "compaction") compactionCount += 1;
		if (entryType !== "message") continue;
		messageCount += 1;
		const m = asRecord(e.message);
		if (!m) continue;
		const role = typeof m.role === "string" ? m.role : null;
		lastMessageRole = role !== null && (KNOWN_MESSAGE_ROLES as readonly string[]).includes(role) ? role : null;
		if (role === "assistant") {
			assistantMessageCount += 1;
			const stopReason = typeof m.stopReason === "string" ? m.stopReason : null;
			lastAssistantStopReason = stopReason !== null && (KNOWN_STOP_REASONS as readonly string[]).includes(stopReason) ? stopReason : null;
		}
	}
	return {
		messageCount,
		assistantMessageCount,
		compactionCount,
		lastEntryType,
		lastMessageRole,
		lastAssistantStopReason,
		terminalStop: lastMessageRole === "assistant" && lastAssistantStopReason === "stop",
		aborted: lastAssistantStopReason === "aborted",
		errored: lastAssistantStopReason === "error",
	};
}

/** Wall time in ms between the first and last entry timestamps (bounded; null when undeterminable). */
export function wallTimeMsOf(entries: readonly unknown[]): number | null {
	let first: number | null = null;
	let last: number | null = null;
	for (const entry of entries) {
		const e = asRecord(entry);
		if (!e) continue;
		const ts = e.timestamp;
		if (typeof ts !== "string") continue;
		const ms = Date.parse(ts);
		if (!Number.isFinite(ms)) continue;
		if (first === null || ms < first) first = ms;
		if (last === null || ms > last) last = ms;
	}
	if (first === null || last === null) return null;
	const diff = last - first;
	if (diff < 0 || diff > WALL_MAX_MS) return null;
	return diff;
}

export interface EnvironmentScan {
	/** Unique model keys in first-seen order (provider/(responseModel ?? model)). */
	modelKeys: string[];
	thinkingLevel: string | null;
}

/** Non-failing environment scan (model keys + last recorded thinking level). */
export function scanEnvironment(entries: readonly unknown[]): EnvironmentScan {
	const keys: string[] = [];
	const seen = new Set<string>();
	let lastThinkingLevel: string | null = null;
	for (const entry of entries) {
		const e = asRecord(entry);
		if (!e) continue;
		if (e.type === "message") {
			const m = asRecord(e.message);
			if (!m) continue;
			if (m.role === "assistant") {
				const provider = typeof m.provider === "string" ? m.provider : "unknown";
				const model = typeof m.model === "string" ? m.model : "unknown";
				const responseModel = typeof m.responseModel === "string" ? m.responseModel : undefined;
				const key = `${provider}/${responseModel ?? model}`;
				if (!seen.has(key)) {
					seen.add(key);
					keys.push(key);
				}
			}
		} else if (e.type === "thinking_level_change") {
			if (typeof e.thinkingLevel === "string" && e.thinkingLevel.length > 0) lastThinkingLevel = e.thinkingLevel;
		}
	}
	return { modelKeys: keys, thinkingLevel: lastThinkingLevel };
}

/** The final assistant message's text (string content or concatenated text parts). */
export function extractFinalAssistantText(entries: readonly unknown[]): string {
	let text = "";
	for (const entry of entries) {
		const e = asRecord(entry);
		if (!e || e.type !== "message") continue;
		const m = asRecord(e.message);
		if (!m || m.role !== "assistant") continue;
		const content = m.content;
		if (typeof content === "string") {
			text = content;
			continue;
		}
		if (!Array.isArray(content)) continue;
		let parts = "";
		for (const item of content) {
			const it = asRecord(item);
			if (it && it.type === "text" && typeof it.text === "string") parts += it.text;
		}
		text = parts;
	}
	return text;
}

// ---------------------------------------------------------------------------
// Preview facts marker and pagination (protocol §8.4–§8.5)
// ---------------------------------------------------------------------------

export interface PreviewFacts {
	complete: boolean;
	returnedLines: number;
	returnedBytes: number;
	totalLines: number;
	totalBytes: number;
	omittedLines: number;
	omittedBytes: number;
	nextOffset: number;
	lineTruncated: boolean;
}

const FACTS_KEYS = ["complete", "returned_lines", "returned_bytes", "total_lines", "total_bytes", "omitted_lines", "omitted_bytes", "next_offset", "line_truncated"] as const;

/**
 * Inline text of a toolResult message (string `content` or `content[]`
 * "text" items — the exact text that enters context, same semantics as
 * toolResultTextBytes). Used ONLY to detect the frozen preview-facts
 * marker (§8.4); the text is never stored, rendered or persisted.
 */
function toolResultInlineText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const item of content) {
		const it = asRecord(item);
		if (it && it.type === "text" && typeof it.text === "string") text += it.text;
	}
	return text;
}

/**
 * Parse the frozen preview-facts line (protocol §8.4): the substring
 * `nro-read-facts:` through the end of its line. Returns null when the
 * marker is absent; a present-but-malformed block fails closed
 * (FACTS_MALFORMED): unknown keys, missing keys, non-boolean flags,
 * non-integer or over-bound counts.
 */
export function parsePreviewFacts(text: string): PreviewFacts | null {
	const idx = text.indexOf(NRO_FACTS_MARKER);
	if (idx === -1) return null;
	let lineEnd = text.indexOf("\n", idx);
	if (lineEnd === -1) lineEnd = text.length;
	const line = text.slice(idx + NRO_FACTS_MARKER.length, lineEnd).trim();
	const tokens = line.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length !== FACTS_KEYS.length) {
		throw new NroError("FACTS_MALFORMED", "preview facts line must carry exactly the nine frozen key=value facts");
	}
	const values = new Map<string, string>();
	for (const token of tokens) {
		const eq = token.indexOf("=");
		if (eq <= 0) throw new NroError("FACTS_MALFORMED", "preview facts token must be key=value");
		const key = token.slice(0, eq);
		if (!(FACTS_KEYS as readonly string[]).includes(key)) {
			throw new NroError("FACTS_MALFORMED", `unknown preview facts key "${safeErrorValue(key)}"`);
		}
		if (values.has(key)) throw new NroError("FACTS_MALFORMED", `duplicate preview facts key "${safeErrorValue(key)}"`);
		values.set(key, token.slice(eq + 1));
	}
	const boolOf = (key: string, where: string): boolean => {
		const v = values.get(key);
		if (v !== "true" && v !== "false") throw new NroError("FACTS_MALFORMED", `${where} must be true or false`);
		return v === "true";
	};
	const intOf = (key: string, where: string): number => {
		const v = values.get(key);
		if (v === undefined || !/^\d+$/.test(v)) throw new NroError("FACTS_MALFORMED", `${where} must be a non-negative integer`);
		const n = Number(v);
		if (!Number.isSafeInteger(n) || n > MAX_USAGE_FACT) throw new NroError("FACTS_MALFORMED", `${where} exceeds the documented bound`);
		return n;
	};
	return {
		complete: boolOf("complete", "facts complete"),
		returnedLines: intOf("returned_lines", "facts returned_lines"),
		returnedBytes: intOf("returned_bytes", "facts returned_bytes"),
		totalLines: intOf("total_lines", "facts total_lines"),
		totalBytes: intOf("total_bytes", "facts total_bytes"),
		omittedLines: intOf("omitted_lines", "facts omitted_lines"),
		omittedBytes: intOf("omitted_bytes", "facts omitted_bytes"),
		nextOffset: intOf("next_offset", "facts next_offset"),
		lineTruncated: boolOf("line_truncated", "facts line_truncated"),
	};
}

export interface PaginationFacts {
	/** Read results carrying the marker with complete=false. */
	previewResults: number;
	previewBytes: number;
	/** Read calls with explicit offset/limit whose path had an earlier preview. */
	continuationReads: number;
	continuationBytes: number;
	obligations: number;
	obligationsPaginated: number;
	/** Obligations followed by a read result of the same path with complete=true. */
	reachedComplete: number;
	completionFraction: number | null;
	reachedFraction: number | null;
	unpaginatedPreviews: number;
	/** Machine sign: obligations > 0 and obligationsPaginated < obligations. */
	misuse: boolean;
}

const UNKNOWN_PATH = "(unknown-path)";

interface ReadCall {
	path: string;
	hasOffset: boolean;
	hasLimit: boolean;
	callIndex: number;
}

interface Obligation {
	path: string;
	resultIndex: number;
}

/**
 * Derive the pagination facts over read calls and read results (protocol
 * §8.5). Read tool calls are matched to read toolResults in FIFO order;
 * a result whose call is unattributable gets the unknown path (never
 * matched for continuation). Arguments are inspected for path/offset/
 * limit presence only and are never rendered.
 */
export function computePagination(entries: readonly unknown[]): PaginationFacts {
	const queue: ReadCall[] = [];
	const previewPaths = new Set<string>();
	const obligations: Obligation[] = [];
	const calls: Array<{ path: string; offsetOrLimit: boolean; index: number }> = [];
	const results: Array<{ path: string; completeTrue: boolean; index: number }> = [];
	let previewResults = 0;
	let previewBytes = 0;
	let continuationReads = 0;
	let continuationBytes = 0;
	let entryIndex = 0;
	for (const entry of entries) {
		const e = asRecord(entry);
		if (!e) continue;
		if (e.type === "message") {
			const m = asRecord(e.message);
			if (!m) continue;
			if (m.role === "assistant") {
				const content = m.content;
				if (Array.isArray(content)) {
					for (const item of content) {
						const it = asRecord(item);
						if (!it || it.type !== "toolCall" || it.name !== "read") continue;
						const args = asRecord(it.arguments);
						const path = args && typeof args.path === "string" ? args.path : UNKNOWN_PATH;
						queue.push({ path, hasOffset: args ? typeof args.offset === "number" : false, hasLimit: args ? typeof args.limit === "number" : false, callIndex: entryIndex });
					}
				}
			} else if (m.role === "toolResult" && m.toolName === "read") {
				const call = queue.shift();
				const path = call?.path ?? UNKNOWN_PATH;
				const bytes = toolResultTextBytes(entry);
				// The inline text is exactly what enters context: a string
				// `content`, or `content[]` "text" items (same semantics as
				// toolResultTextBytes) — marker detection must see both.
				const text = toolResultInlineText(m.content);
				const facts = parsePreviewFacts(text);
				if (facts !== null && facts.complete === false) {
					previewResults += 1;
					previewBytes += bytes;
					obligations.push({ path, resultIndex: entryIndex });
				}
				if (path !== UNKNOWN_PATH && facts !== null && facts.complete === false) previewPaths.add(path);
				calls.push({ path: call?.path ?? UNKNOWN_PATH, offsetOrLimit: (call?.hasOffset ?? false) || (call?.hasLimit ?? false), index: entryIndex });
				results.push({ path, completeTrue: facts !== null && facts.complete === true, index: entryIndex });
				if (call && (call.hasOffset || call.hasLimit) && previewPaths.has(call.path)) {
					continuationReads += 1;
					continuationBytes += bytes;
				}
			}
		}
		entryIndex += 1;
	}
	let obligationsPaginated = 0;
	let reachedComplete = 0;
	for (const obligation of obligations) {
		if (calls.some((c) => c.path === obligation.path && c.offsetOrLimit && c.index > obligation.resultIndex)) obligationsPaginated += 1;
		if (results.some((r) => r.path === obligation.path && r.completeTrue && r.index > obligation.resultIndex)) reachedComplete += 1;
	}
	const unpaginatedPreviews = obligations.length - obligationsPaginated;
	return {
		previewResults,
		previewBytes,
		continuationReads,
		continuationBytes,
		obligations: obligations.length,
		obligationsPaginated,
		reachedComplete,
		completionFraction: obligations.length === 0 ? null : obligationsPaginated / obligations.length,
		reachedFraction: obligations.length === 0 ? null : reachedComplete / obligations.length,
		unpaginatedPreviews,
		misuse: obligations.length > 0 && obligationsPaginated < obligations.length,
	};
}

// ---------------------------------------------------------------------------
// Per-run machine facts
// ---------------------------------------------------------------------------

export interface PerToolTextFacts {
	toolName: string;
	entries: number;
	textBytes: number;
	successfulEntries: number;
	successfulTextBytes: number;
}

export interface CorrectnessFacts {
	passed: boolean;
	checks: Array<{ id: string; passed: boolean }>;
}

export interface RunFacts {
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
	perTool: PerToolTextFacts[];
	modelKeys: string[];
	thinkingLevel: string | null;
	wallTimeMs: number | null;
	terminal: TerminalFacts;
	correctness: CorrectnessFacts;
	pagination: PaginationFacts;
	misuse: boolean;
}

/** Deterministic toolName for a toolResult message (same semantics as cost-breakdown). */
function successfulToolNameOf(entry: unknown): string {
	const e = asRecord(entry);
	const m = e ? asRecord(e.message) : null;
	if (!e || e.type !== "message" || !m || m.role !== "toolResult") return UNKNOWN_TOOL_NAME;
	const name = m.toolName;
	return typeof name === "string" && name.length > 0 ? name : UNKNOWN_TOOL_NAME;
}

export interface RunFactsOptions {
	/** Final-phase validity enforcement (protocol §8.2–§8.3). */
	enforceValidity: boolean;
}

/**
 * Compute the per-run machine facts. Reuses `buildCostBreakdown` for
 * requests, token components, gross, cost, compactions and per-tool/
 * total inline text bytes, plus the successful-byte pass (toolResult
 * messages NOT marked isError=true). Fail-closed enforcement when
 * enforceValidity is set: prompt hash pin, per-assistant model key,
 * recorded thinking level, zero compactions, terminal stop. For dev
 * sessions the same facts are recorded but not enforced.
 */
export function computeRunFacts(
	label: string,
	arm: ArmName,
	orderIndex: number,
	sessionBasename: string,
	sessionSha256: string,
	entries: readonly unknown[],
	expectedPromptSha256: string,
	expectedEnvironment: FrozenEnvironment,
	rubric: { sha256: string; checks: RubricCheck[] },
	opts: RunFactsOptions,
): RunFacts {
	validateEntries(entries, label, true);
	const promptText = extractPromptText(entries);
	if (promptText.length === 0) throw new NroError("MISSING_PROMPT_TEXT", `session "${safeErrorValue(label)}": first user message has no extractable text`);
	const promptSha256 = sha256Hex(promptText);
	if (opts.enforceValidity && promptSha256 !== expectedPromptSha256) {
		throw new NroError(
			"PROMPT_MISMATCH",
			`session "${safeErrorValue(label)}": extracted first user-message text SHA-256 ${promptSha256} does not match the frozen milestone prompt SHA-256 ${expectedPromptSha256}`,
		);
	}

	const envScan = scanEnvironment(entries);
	if (opts.enforceValidity) {
		if (envScan.modelKeys.length === 0) {
			throw new NroError(
				"MODEL_MISMATCH",
				`session "${safeErrorValue(label)}": no assistant message carries a model identity — the pinned model key "${expectedEnvironment.modelKey}" was never observed (missing identity fails closed)`,
			);
		}
		if (envScan.modelKeys.some((k) => k !== expectedEnvironment.modelKey)) {
			throw new NroError(
				"MODEL_MISMATCH",
				`session "${safeErrorValue(label)}": assistant model key does not match the pinned environment model key "${expectedEnvironment.modelKey}" (every assistant message must carry the identical expected model identity)`,
			);
		}
		if (envScan.thinkingLevel === null) {
			throw new NroError("MISSING_THINKING_LEVEL", `session "${safeErrorValue(label)}": no thinking_level_change entry — the recorded thinking level is missing`);
		}
		if (envScan.thinkingLevel !== expectedEnvironment.thinkingLevel) {
			throw new NroError(
				"THINKING_MISMATCH",
				`session "${safeErrorValue(label)}": recorded thinking level "${safeErrorValue(envScan.thinkingLevel)}" does not match the pinned environment thinking level "${expectedEnvironment.thinkingLevel}"`,
			);
		}
	}

	const breakdown = buildCostBreakdown(entries);
	if (opts.enforceValidity && breakdown.compactions !== 0) {
		throw new NroError("COMPACTION_PRESENT", `session "${safeErrorValue(label)}": ${breakdown.compactions} compaction(s) — final sessions require zero compactions`);
	}
	const terminal = terminalStateOf(entries);
	if (opts.enforceValidity) {
		if (terminal.aborted) throw new NroError("ABORTED", `session "${safeErrorValue(label)}": terminal assistant response is aborted`);
		if (terminal.errored) throw new NroError("ERRORED", `session "${safeErrorValue(label)}": terminal assistant response errored`);
		if (!terminal.terminalStop) {
			throw new NroError(
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
		const name = successfulToolNameOf(entry);
		const slot = successByName.get(name) ?? { entries: 0, bytes: 0 };
		slot.entries += 1;
		slot.bytes += toolResultTextBytes(entry);
		successByName.set(name, slot);
	}

	const totalByName = new Map<string, { count: number; textBytes: number }>();
	for (const row of breakdown.toolTextBytes) totalByName.set(row.toolName, row);
	const allNames = new Set<string>([...totalByName.keys(), ...successByName.keys()]);
	const perTool: PerToolTextFacts[] = [];
	let successfulToolResultEntries = 0;
	let successfulTextBytes = 0;
	for (const name of [...allNames].sort()) {
		const total = totalByName.get(name);
		const success = successByName.get(name);
		const row: PerToolTextFacts = {
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
	let passed = true;
	const checks: Array<{ id: string; passed: boolean }> = [];
	for (const check of rubric.checks) {
		let ok = false;
		try {
			ok = new RegExp(check.pattern).test(finalText);
		} catch {
			throw new NroError("RUBRIC_INVALID", `rubric check "${safeErrorValue(check.id)}" pattern is not compilable`);
		}
		checks.push({ id: check.id, passed: ok });
		if (!ok) passed = false;
	}

	const pagination = computePagination(entries);

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
		correctness: { passed, checks },
		pagination,
		misuse: pagination.misuse,
	};
}

// ---------------------------------------------------------------------------
// Attempt classification (protocol §8.6)
// ---------------------------------------------------------------------------

export interface AttemptFacts {
	label: string;
	arm: ArmName;
	sessionBasename: string;
	rawSha256: string;
	promptSha256: string | null;
	category: AttemptCategory;
	requests: number;
	compactions: number;
	modelKeys: string[];
	thinkingLevel: string | null;
	terminal: TerminalFacts;
}

export interface DeriveAttemptOptions {
	/** Final-phase strictness: a machine-observably valid attempt fails (ATTEMPT_NOT_INVALID). */
	strict: boolean;
}

/**
 * Derive the frozen-priority attempt category (protocol §8.6) from the
 * attempt's own entries. Attempts skip the user/assistant presence
 * requirements but keep strict JSONL/usage validation.
 */
export function deriveAttemptFacts(
	label: string,
	arm: ArmName,
	sessionBasename: string,
	rawSha256: string,
	entries: readonly unknown[],
	expectedPromptSha256: string,
	expectedEnvironment: FrozenEnvironment,
	opts: DeriveAttemptOptions,
): AttemptFacts {
	validateEntries(entries, label, false);
	const promptText = extractPromptTextLenient(entries);
	const promptSha256 = promptText === null ? null : sha256Hex(promptText);
	const envScan = scanEnvironment(entries);
	const terminal = terminalStateOf(entries);
	const breakdown = buildCostBreakdown(entries);
	let category: AttemptCategory;
	if (promptSha256 !== null && promptSha256 !== expectedPromptSha256) {
		category = "prompt_mismatch";
	} else if (envScan.modelKeys.some((k) => k !== expectedEnvironment.modelKey) || (envScan.thinkingLevel !== null && envScan.thinkingLevel !== expectedEnvironment.thinkingLevel)) {
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
		throw new NroError(
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
// Fixture-manifest hash (protocol §5.2)
// ---------------------------------------------------------------------------

export interface FixtureManifestResult {
	manifestSha256: string;
	/** Files as relative POSIX paths (sorted). */
	files: string[];
	totalBytes: number;
}

/**
 * Deterministic fixture-manifest hash over a tree: regular files and
 * directories only (symlinks and other entry types fail closed), sorted
 * relative paths, SHA-256 over `"<relPath>:<fileSha>\n"` per file.
 * Bounded: FIXTURE_MAX_BYTES total, FIXTURE_MAX_FILES, PATH_MAX_BYTES
 * per path, no control characters in any segment.
 */
export async function fixtureManifestHash(dir: string): Promise<FixtureManifestResult> {
	const rows: Array<{ rel: string; sha: string }> = [];
	let totalBytes = 0;
	const walk = async (current: string, relPrefix: string): Promise<void> => {
		let names: Dirent[];
		try {
			names = await readdir(current, { withFileTypes: true });
		} catch {
			throw new NroError("FIXTURE_UNSAFE", `fixture directory "${safeErrorValue(basename(current))}" cannot be read`);
		}
		names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const dirent of names) {
			const rel = relPrefix.length === 0 ? dirent.name : `${relPrefix}/${dirent.name}`;
			if (utf8Bytes(rel) > PATH_MAX_BYTES) throw new NroError("OVER_BOUND", `fixture path exceeds ${PATH_MAX_BYTES} bytes`);
			if (CONTROL_CHAR_RE.test(rel)) throw new NroError("FIXTURE_UNSAFE", "fixture path contains control characters");
			if (dirent.isSymbolicLink()) throw new NroError("FIXTURE_UNSAFE", `fixture entry "${safeErrorValue(rel)}" is a symlink`);
			if (dirent.isDirectory()) {
				await walk(join(current, dirent.name), rel);
				continue;
			}
			if (!dirent.isFile()) throw new NroError("FIXTURE_UNSAFE", `fixture entry "${safeErrorValue(rel)}" is not a regular file`);
			if (rows.length >= FIXTURE_MAX_FILES) throw new NroError("OVER_BOUND", `fixture exceeds ${FIXTURE_MAX_FILES} files`);
			const full = join(current, dirent.name);
			let info;
			try {
				info = await stat(full);
			} catch {
				throw new NroError("FIXTURE_UNSAFE", `fixture file "${safeErrorValue(rel)}" cannot be inspected`);
			}
			if (!info.isFile()) throw new NroError("FIXTURE_UNSAFE", `fixture entry "${safeErrorValue(rel)}" is not a regular file`);
			if (info.size > FIXTURE_MAX_BYTES - totalBytes) throw new NroError("OVER_BOUND", `fixture exceeds ${FIXTURE_MAX_BYTES} bytes total`);
			let raw: Buffer;
			try {
				raw = await readFile(full);
			} catch {
				throw new NroError("FIXTURE_UNSAFE", `fixture file "${safeErrorValue(rel)}" cannot be read`);
			}
			totalBytes += raw.length;
			rows.push({ rel, sha: sha256Hex(raw) });
		}
	};
	await walk(dir, "");
	rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	const joined = rows.map((r) => `${r.rel}:${r.sha}\n`).join("");
	return { manifestSha256: sha256Hex(joined), files: rows.map((r) => r.rel), totalBytes };
}

// ---------------------------------------------------------------------------
// Arm statistics and the four frozen verdicts (protocol §10)
// ---------------------------------------------------------------------------

export interface CohortTotals {
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

export function emptyCohortTotals(): CohortTotals {
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

function addRunToTotals(totals: CohortTotals, run: RunFacts): void {
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
export function medianOf(sorted: readonly number[]): number | null {
	if (sorted.length === 0) return null;
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid] ?? null;
	return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Sum of the two middle values (median x 2); 2 x middle value for odd n. */
export function middleTwoSum(sorted: readonly number[]): number | null {
	if (sorted.length === 0) return null;
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return 2 * (sorted[mid] ?? 0);
	return (sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0);
}

/** Nearest-rank p90: rank = ceil(0.9 x n) (1-based), e.g. rank 18 of 20. */
export function nearestRankP90(sorted: readonly number[]): number | null {
	if (sorted.length === 0) return null;
	const rank = Math.ceil(0.9 * sorted.length);
	return sorted[Math.max(0, rank - 1)] ?? null;
}

export interface ArmFacts {
	arm: ArmName;
	runCount: number;
	requestsMedian: number | null;
	grossMedian: number | null;
	successfulTextBytesMedian: number | null;
	grossP90: number | null;
	totals: CohortTotals;
}

export function buildArmFacts(arm: ArmName, runs: readonly RunFacts[]): ArmFacts {
	const requests = runs.map((r) => r.requests).sort((a, b) => a - b);
	const gross = runs.map((r) => r.gross).sort((a, b) => a - b);
	const bytes = runs.map((r) => r.successfulTextBytes).sort((a, b) => a - b);
	const totals = emptyCohortTotals();
	for (const run of runs) addRunToTotals(totals, run);
	totals.cost = Math.round(totals.cost * COST_DECIMALS) / COST_DECIMALS;
	return {
		arm,
		runCount: runs.length,
		requestsMedian: medianOf(requests),
		grossMedian: medianOf(gross),
		successfulTextBytesMedian: medianOf(bytes),
		grossP90: nearestRankP90(gross),
		totals,
	};
}

export interface Verdict {
	id: VerdictId;
	metricLabel: string;
	thresholdDisplay: string;
	control: number | null;
	treatment: number | null;
	/** Reduction ratio (control - treatment) / control for #1–#3; treatment/control for #4. */
	ratio: number | null;
	status: VerdictStatus;
	reason: string;
}

const DEV_VERDICT_REASON =
	"development-phase manifest: development evidence is development evidence only and is never reported (protocol §4.4); the §11.2 adoption verdicts are computed exclusively over a final-validation manifest";

function notMeasuredReason(metricLabel: string, why: string): string {
	return `frozen §11.2 ${metricLabel}: ${why} — verdict NOT_MEASURED (never PASS)`;
}

/** Median-based verdict from middle-two sums (exact integer arithmetic). */
function medianReductionVerdict(
	id: VerdictId,
	metricLabel: string,
	thresholdDisplay: string,
	thresholdBasis1000: number,
	controlSum: number | null,
	treatmentSum: number | null,
	controlMedian: number | null,
	treatmentMedian: number | null,
	armLabel: string,
): Verdict {
	if (controlSum === null || treatmentSum === null || controlMedian === null || treatmentMedian === null) {
		return {
			id,
			metricLabel,
			thresholdDisplay,
			control: controlMedian,
			treatment: treatmentMedian,
			ratio: null,
			status: "NOT_MEASURED",
			reason: notMeasuredReason(metricLabel, `no valid runs in the ${armLabel} arm`),
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
			reason: notMeasuredReason(metricLabel, `the control ${armLabel} median is 0 — zero denominator`),
		};
	}
	const achieved = (controlSum - treatmentSum) * 1000 >= thresholdBasis1000 * controlSum;
	const ratio = (controlSum - treatmentSum) / controlSum;
	const reason =
		id === "requests_median_non_increase"
			? `frozen §11.2 ${metricLabel} (${thresholdDisplay}): treatment median ${treatmentMedian} ${achieved ? "<=" : ">"} control median ${controlMedian} (median reduction ${ratio.toFixed(4)})`
			: `frozen §11.2 ${metricLabel} ${thresholdDisplay}: median reduction ${ratio.toFixed(4)} (treatment median ${treatmentMedian} vs control median ${controlMedian}) ${achieved ? ">=" : "<"} threshold`;
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

export const VERDICT_LABELS: Record<VerdictId, string> = {
	bytes_median_reduction: "successful inline bytes median reduction",
	gross_median_reduction: "commander gross tokens median reduction",
	requests_median_non_increase: "commander requests median non-increase",
	gross_p90_regression: "commander gross p90 regression",
};

export const VERDICT_THRESHOLDS: Record<VerdictId, string> = {
	bytes_median_reduction: ">= 50%",
	gross_median_reduction: ">= 20%",
	requests_median_non_increase: "treatment median <= control median",
	gross_p90_regression: "treatment p90 <= 1.05 x control p90",
};

/** The four frozen §11.2 verdicts computed directly from the per-run values. */
export function computeVerdictsFromRuns(controlRuns: readonly RunFacts[], treatmentRuns: readonly RunFacts[], phase: Phase): Verdict[] {
	if (phase !== "final") {
		return (VERDICT_IDS as readonly VerdictId[]).map((id) => ({
			id,
			metricLabel: VERDICT_LABELS[id],
			thresholdDisplay: VERDICT_THRESHOLDS[id],
			control: null,
			treatment: null,
			ratio: null,
			status: "NOT_MEASURED" as VerdictStatus,
			reason: DEV_VERDICT_REASON,
		}));
	}
	const cBytes = controlRuns.map((r) => r.successfulTextBytes).sort((a, b) => a - b);
	const tBytes = treatmentRuns.map((r) => r.successfulTextBytes).sort((a, b) => a - b);
	const cGross = controlRuns.map((r) => r.gross).sort((a, b) => a - b);
	const tGross = treatmentRuns.map((r) => r.gross).sort((a, b) => a - b);
	const cReq = controlRuns.map((r) => r.requests).sort((a, b) => a - b);
	const tReq = treatmentRuns.map((r) => r.requests).sort((a, b) => a - b);

	const bytes = medianReductionVerdict(
		"bytes_median_reduction",
		VERDICT_LABELS.bytes_median_reduction,
		VERDICT_THRESHOLDS.bytes_median_reduction,
		500,
		middleTwoSum(cBytes),
		middleTwoSum(tBytes),
		medianOf(cBytes),
		medianOf(tBytes),
		"successful inline bytes",
	);
	const gross = medianReductionVerdict(
		"gross_median_reduction",
		VERDICT_LABELS.gross_median_reduction,
		VERDICT_THRESHOLDS.gross_median_reduction,
		200,
		middleTwoSum(cGross),
		middleTwoSum(tGross),
		medianOf(cGross),
		medianOf(tGross),
		"gross",
	);
	const requests = medianReductionVerdict(
		"requests_median_non_increase",
		VERDICT_LABELS.requests_median_non_increase,
		VERDICT_THRESHOLDS.requests_median_non_increase,
		0,
		middleTwoSum(cReq),
		middleTwoSum(tReq),
		medianOf(cReq),
		medianOf(tReq),
		"requests",
	);
	// #4: gross p90 tail guard — 20 x treatment <= 21 x control.
	const cP90 = nearestRankP90(cGross);
	const tP90 = nearestRankP90(tGross);
	let p90: Verdict;
	if (cP90 === null || tP90 === null) {
		p90 = {
			id: "gross_p90_regression",
			metricLabel: VERDICT_LABELS.gross_p90_regression,
			thresholdDisplay: VERDICT_THRESHOLDS.gross_p90_regression,
			control: cP90,
			treatment: tP90,
			ratio: null,
			status: "NOT_MEASURED",
			reason: notMeasuredReason(VERDICT_LABELS.gross_p90_regression, "an arm has no runs"),
		};
	} else if (cP90 === 0) {
		p90 = {
			id: "gross_p90_regression",
			metricLabel: VERDICT_LABELS.gross_p90_regression,
			thresholdDisplay: VERDICT_THRESHOLDS.gross_p90_regression,
			control: cP90,
			treatment: tP90,
			ratio: null,
			status: "NOT_MEASURED",
			reason: notMeasuredReason(VERDICT_LABELS.gross_p90_regression, "the control gross p90 is 0 — zero denominator"),
		};
	} else {
		const achieved = 20 * tP90 <= 21 * cP90;
		const ratio = tP90 / cP90;
		p90 = {
			id: "gross_p90_regression",
			metricLabel: VERDICT_LABELS.gross_p90_regression,
			thresholdDisplay: VERDICT_THRESHOLDS.gross_p90_regression,
			control: cP90,
			treatment: tP90,
			ratio,
			status: achieved ? "ACHIEVED" : "MISSED",
			reason: `frozen §11.2 ${VERDICT_LABELS.gross_p90_regression} ${VERDICT_THRESHOLDS.gross_p90_regression}: treatment p90 ${tP90} ${achieved ? "<=" : ">"} 1.05 x control p90 ${cP90} (ratio ${ratio.toFixed(4)})`,
		};
	}
	return [bytes, gross, requests, p90];
}

// ---------------------------------------------------------------------------
// Report model (protocol §9.2)
// ---------------------------------------------------------------------------

export interface FixtureVerificationFacts {
	/** Manifest-declared relative fixture path (privacy-safe). */
	path: string;
	manifestSha256: string;
	verified: boolean;
	files: number;
	totalBytes: number;
}

export interface ReportManifestFacts {
	basename: string;
	protocolDoc: string;
	schemaVersion: number;
	phase: Phase;
	milestonePromptSha256: string;
	environment: ManifestEnvironment;
	fixture: FixtureVerificationFacts;
	nonTreatmentSha256: string;
	rubricSha256: string;
	rubricChecks: number;
	sessionCount: number;
	attemptCount: number;
}

export interface BenchmarkReport {
	schemaVersion: number;
	protocolDoc: string;
	manifest: ReportManifestFacts;
	runs: RunFacts[];
	arms: Record<ArmName, ArmFacts>;
	attempts: AttemptFacts[];
	verdicts: Verdict[];
}

// ---------------------------------------------------------------------------
// Analyzer pipeline (protocol §9) — read-only, deterministic
// ---------------------------------------------------------------------------

/**
 * Analyze every declared session and attempt (all runs retained, none
 * excluded) with realpath containment, duplicate-realpath refusal, strict
 * JSONL parsing, raw-byte hash enforcement and fail-closed validation;
 * re-verify the declared fixture tree against its manifest hash; then
 * aggregate arm facts and compute the four frozen verdicts. Read-only:
 * no file is written, no model is called, no network/shell is used.
 */
export async function buildReport(manifest: NroManifest, manifestDir: string, manifestBasename: string): Promise<BenchmarkReport> {
	let dirReal: string;
	try {
		dirReal = await realpath(manifestDir);
	} catch {
		throw new NroError("IO_ERROR", "the manifest directory cannot be resolved");
	}
	const seenRealPaths = new Set<string>();

	/**
	 * Resolve + contain + dedupe one declared path, then read it
	 * (size-bounded). Basename-only error messages (privacy boundary).
	 */
	const readDeclaredFile = async (rawPath: string, what: string): Promise<Buffer> => {
		const safeName = basename(rawPath);
		const resolved = resolveSessionPath(manifestDir, rawPath);
		let real: string;
		try {
			real = await realpath(resolved);
		} catch {
			throw new NroError("FILE_MISSING", `${what} "${safeErrorValue(safeName)}" is missing or unreadable`);
		}
		if (real !== dirReal && !real.startsWith(dirReal + sep)) {
			throw new NroError("PATH_UNSAFE", `${what} "${safeErrorValue(safeName)}" resolves outside the manifest directory`);
		}
		if (seenRealPaths.has(real)) {
			throw new NroError("DUPLICATE_PATH", `${what} "${safeErrorValue(safeName)}" duplicates another declared path (identical realpath)`);
		}
		seenRealPaths.add(real);
		let info;
		try {
			info = await stat(real);
		} catch {
			throw new NroError("FILE_MISSING", `${what} "${safeErrorValue(safeName)}" is not readable`);
		}
		if (!info.isFile()) throw new NroError("FILE_MISSING", `${what} "${safeErrorValue(safeName)}" is not a regular file`);
		if (info.size > SESSION_MAX_BYTES) {
			throw new NroError("OVER_BOUND", `${what} "${safeErrorValue(safeName)}" exceeds ${SESSION_MAX_BYTES} bytes`);
		}
		try {
			return await readFile(real);
		} catch {
			throw new NroError("FILE_MISSING", `${what} "${safeErrorValue(safeName)}" could not be read`);
		}
	};

	const runs: RunFacts[] = [];
	for (const session of manifest.sessions) {
		const raw = await readDeclaredFile(session.path, "session file");
		const sessionSha256 = sha256Hex(raw);
		if (sessionSha256 !== session.expectedSessionSha256) {
			throw new NroError(
				"HASH_MISMATCH",
				`session "${safeErrorValue(session.label)}": raw byte SHA-256 ${sessionSha256} does not match expected_session_sha256 ${session.expectedSessionSha256}`,
			);
		}
		const entries = parseSessionLines(raw.toString("utf8"), session.label);
		runs.push(
			computeRunFacts(
				session.label,
				session.arm,
				session.orderIndex,
				basename(session.path),
				sessionSha256,
				entries,
				manifest.milestonePromptSha256,
				manifest.environment,
				manifest.rubric,
				{ enforceValidity: manifest.phase === "final" },
			),
		);
	}

	const attempts: AttemptFacts[] = [];
	for (const attempt of manifest.attempts) {
		const raw = await readDeclaredFile(attempt.path, "attempt file");
		const rawSha256 = sha256Hex(raw);
		if (rawSha256 !== attempt.expectedSessionSha256) {
			throw new NroError(
				"HASH_MISMATCH",
				`attempt "${safeErrorValue(attempt.label)}": raw byte SHA-256 ${rawSha256} does not match expected_session_sha256 ${attempt.expectedSessionSha256}`,
			);
		}
		const entries = parseSessionLines(raw.toString("utf8"), attempt.label);
		const derived = deriveAttemptFacts(
			attempt.label,
			attempt.arm,
			basename(attempt.path),
			rawSha256,
			entries,
			manifest.milestonePromptSha256,
			manifest.environment,
			{ strict: manifest.phase === "final" },
		);
		if (derived.category !== attempt.category) {
			throw new NroError(
				"CATEGORY_MISMATCH",
				`attempt "${safeErrorValue(attempt.label)}": declared category ${attempt.category} does not reproduce the frozen derivation (derived ${derived.category})`,
			);
		}
		if (derived.promptSha256 !== attempt.promptSha256) {
			throw new NroError(
				"CATEGORY_MISMATCH",
				`attempt "${safeErrorValue(attempt.label)}": declared prompt SHA-256 ${attempt.promptSha256 ?? "null"} does not equal the derived value ${derived.promptSha256 ?? "null"}`,
			);
		}
		attempts.push(derived);
	}

	// Fixture tree: resolve, contain, dedupe, re-verify the manifest hash.
	const fixtureResolved = resolveSessionPath(manifestDir, manifest.fixture.path);
	let fixtureReal: string;
	try {
		fixtureReal = await realpath(fixtureResolved);
	} catch {
		throw new NroError("FILE_MISSING", `fixture directory "${safeErrorValue(basename(manifest.fixture.path))}" is missing or unreadable`);
	}
	if (fixtureReal !== dirReal && !fixtureReal.startsWith(dirReal + sep)) {
		throw new NroError("PATH_UNSAFE", `fixture directory "${safeErrorValue(basename(manifest.fixture.path))}" resolves outside the manifest directory`);
	}
	if (seenRealPaths.has(fixtureReal)) {
		throw new NroError("DUPLICATE_PATH", `fixture directory "${safeErrorValue(basename(manifest.fixture.path))}" duplicates another declared path (identical realpath)`);
	}
	seenRealPaths.add(fixtureReal);
	const fixture = await fixtureManifestHash(fixtureReal);
	if (fixture.manifestSha256 !== manifest.fixture.manifestSha256) {
		throw new NroError(
			"FIXTURE_MISMATCH",
			`fixture tree SHA-256 ${fixture.manifestSha256} does not match the manifest-declared fixture manifest hash ${manifest.fixture.manifestSha256}`,
		);
	}

	const controlRuns = runs.filter((r) => r.arm === "control");
	const treatmentRuns = runs.filter((r) => r.arm === "treatment");
	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		protocolDoc: PROTOCOL_DOC,
		manifest: {
			basename: manifestBasename,
			protocolDoc: manifest.protocolDoc,
			schemaVersion: manifest.schemaVersion,
			phase: manifest.phase,
			milestonePromptSha256: manifest.milestonePromptSha256,
			environment: manifest.environment,
			fixture: {
				path: manifest.fixture.path,
				manifestSha256: fixture.manifestSha256,
				verified: true,
				files: fixture.files.length,
				totalBytes: fixture.totalBytes,
			},
			nonTreatmentSha256: manifest.nonTreatmentSha256,
			rubricSha256: manifest.rubric.sha256,
			rubricChecks: manifest.rubric.checks.length,
			sessionCount: manifest.sessions.length,
			attemptCount: manifest.attempts.length,
		},
		runs,
		arms: {
			control: buildArmFacts("control", controlRuns),
			treatment: buildArmFacts("treatment", treatmentRuns),
		},
		attempts,
		verdicts: computeVerdictsFromRuns(controlRuns, treatmentRuns, manifest.phase),
	};
}

/**
 * Read the manifest file (size-bounded, safe basename) and run the full
 * offline analysis pipeline. Read-only: reads the manifest, the declared
 * session/attempt files and the declared fixture tree only — no file
 * writes, no model call, no network, no provider/cache/session state.
 */
export async function analyzeManifestFile(manifestPath: string, protocol: FrozenProtocol = FROZEN_NRO_PROTOCOL): Promise<BenchmarkReport> {
	const name = basename(manifestPath);
	let info;
	try {
		info = await stat(manifestPath);
	} catch {
		throw new NroError("IO_ERROR", `cannot read manifest "${safeErrorValue(name)}": missing or unreadable`);
	}
	if (!info.isFile()) throw new NroError("IO_ERROR", `manifest "${safeErrorValue(name)}" is not a regular file`);
	if (info.size > MANIFEST_MAX_BYTES) {
		throw new NroError("OVER_BOUND", `manifest "${safeErrorValue(name)}" exceeds ${MANIFEST_MAX_BYTES} bytes`);
	}
	if (!BASENAME_RE.test(name)) {
		throw new NroError("BASENAME_UNSAFE", "manifest basename must be a bounded safe file name ([A-Za-z0-9][A-Za-z0-9._-]*, at most 128 chars)");
	}
	let text: string;
	try {
		text = await readFile(manifestPath, "utf8");
	} catch {
		throw new NroError("IO_ERROR", `cannot read manifest "${safeErrorValue(name)}": unreadable`);
	}
	const manifest = parseManifest(text, protocol);
	return buildReport(manifest, dirname(resolve(manifestPath)), name);
}

// ---------------------------------------------------------------------------
// Deterministic bounded rendering (protocol §9.1–§9.2; privacy §9.4)
// ---------------------------------------------------------------------------

/**
 * Deterministic output caps: keep whole lines while under both caps; on
 * overflow the last kept line is replaced by an explicit marker line so the
 * result is always <= maxLines lines and stays deterministic.
 */
export function applyCaps(lines: readonly string[], maxLines: number, maxBytes: number): string[] {
	const marker = `... (output capped: ${maxLines} lines / ${maxBytes} bytes — deterministic bound)`;
	const out: string[] = [];
	let total = 0;
	for (const line of lines) {
		const bytes = utf8Bytes(line);
		if (out.length > 0 && (out.length >= maxLines || total + bytes > maxBytes)) {
			return [...out.slice(0, out.length - 1), marker];
		}
		if (out.length === 0 && bytes > maxBytes) {
			return [truncateUtf8(line, Math.max(0, maxBytes - utf8Bytes(marker) - 1)), marker];
		}
		out.push(line);
		total += bytes;
	}
	return out;
}

/** Deterministic, bounded, ASCII-safe human rendering of the report. */
export function renderReport(report: BenchmarkReport): string[] {
	const m = report.manifest;
	const lines: string[] = [
		"commander native tool benchmark (NRO protocol) — offline analyzer, machine facts only",
		`protocol doc  : ${PROTOCOL_DOC}`,
		`manifest      : ${boundedDisplay(m.basename, BASENAME_MAX_CHARS).text} (schema ${m.schemaVersion}, phase ${m.phase}, ${m.sessionCount} sessions / ${m.attemptCount} attempts)`,
		`milestone prompt sha256 : ${m.milestonePromptSha256}`,
		`environment   : model ${m.environment.modelKey} | thinking ${m.environment.thinkingLevel} | Pi ${m.environment.piVersion} | Node ${m.environment.nodeVersion} (pinned — enforced for every final session)`,
		`fixture       : ${boundedDisplay(m.fixture.path, PATH_MAX_BYTES).text} | manifest sha256 ${m.fixture.manifestSha256} | verified ${m.fixture.verified} | ${m.fixture.files} files | ${m.fixture.totalBytes} bytes`,
		`non-treatment bundle sha256 : ${m.nonTreatmentSha256}`,
		`rubric        : sha256 ${m.rubricSha256} | ${m.rubricChecks} checks (executed over the final assistant text)`,
		"",
		"per-run facts (every declared run retained; prompt/environment/compaction/terminal enforced for final sessions):",
	];
	for (const run of report.runs) {
		const label = boundedDisplay(run.label, LABEL_MAX_CHARS).text;
		const model = boundedDisplay(run.modelKeys.length > 0 ? run.modelKeys.join(",") : "(none)", MODEL_KEY_MAX_CHARS).text;
		const thinking = run.thinkingLevel === null ? "n/a" : boundedDisplay(run.thinkingLevel, THINKING_LEVEL_MAX_CHARS).text;
		const wall = run.wallTimeMs === null ? "n/a" : `${run.wallTimeMs}ms`;
		lines.push(
			`  ${label.padEnd(12)} [#${String(run.orderIndex).padStart(2, "0")}] requests ${run.requests} | gross ${run.gross} (in ${run.input} / out ${run.output} / cr ${run.cacheRead} / cw ${run.cacheWrite}) | compactions ${run.compactions} | cost $${run.cost.toFixed(6)} | inline ${run.successfulTextBytes}/${run.totalTextBytes} succ/total | wall ${wall} | model ${model} | thinking ${thinking} | stop ${run.terminal.lastAssistantStopReason ?? "none"} | correct ${run.correctness.passed ? "pass" : "FAIL"} | previews ${run.pagination.previewResults} | obligations ${run.pagination.obligationsPaginated}/${run.pagination.obligations} | reached ${run.pagination.reachedComplete} | misuse ${run.pagination.misuse ? "yes" : "no"} | session ${boundedDisplay(run.sessionBasename, BASENAME_MAX_CHARS).text} | sha256 ${run.sessionSha256}`,
		);
	}
	lines.push("", "arm facts (medians over the arm's valid runs; gross p90 = nearest-rank p90):");
	for (const arm of ARMS) {
		const a = report.arms[arm];
		lines.push(
			`  ${arm.padEnd(9)} n=${a.runCount} | requests median ${a.requestsMedian ?? "n/a"} | gross median ${a.grossMedian ?? "n/a"} | successful inline bytes median ${a.successfulTextBytesMedian ?? "n/a"} | gross p90 ${a.grossP90 ?? "n/a"} | totals requests ${a.totals.requests} gross ${a.totals.gross} inline ${a.totals.successfulTextBytes}/${a.totals.totalTextBytes} succ/total cost $${a.totals.cost.toFixed(6)}`,
		);
	}
	if (report.attempts.length > 0) {
		lines.push("", "attempts (all retained; categories machine-verified against the frozen derivation):");
		for (const attempt of report.attempts) {
			lines.push(
				`  ${attempt.label.padEnd(10)} [${attempt.arm}] category ${attempt.category.padEnd(18)} | prompt ${attempt.promptSha256 ?? "null"} | requests ${attempt.requests} | compactions ${attempt.compactions} | stop ${attempt.terminal.lastAssistantStopReason ?? "none"} | session ${boundedDisplay(attempt.sessionBasename, BASENAME_MAX_CHARS).text} | sha256 ${attempt.rawSha256}`,
			);
		}
	}
	lines.push("", "frozen §11.2 adoption verdicts (final-validation cohort only; dev manifests are always NOT_MEASURED):");
	for (const verdict of report.verdicts) {
		lines.push(`  ${verdict.metricLabel.padEnd(44)} ${verdict.status} — ${verdict.reason}`);
	}
	lines.push(
		"privacy : this output carries hashes, labels, basenames, counts and numeric facts only — never message bodies, tool arguments, raw tool-result content, preview facts values, secrets, or absolute paths",
	);
	return applyCaps(lines, HUMAN_MAX_LINES, HUMAN_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// Collection record (protocol §4.5) and frozen inputs (protocol §11.1)
// ---------------------------------------------------------------------------

export const RUBRIC_SCHEMA_VERSION = 1;

const COLLECTION_TOP_KEYS = ["schema_version", "phase", "non_treatment_sha256", "entries"] as const;
const COLLECTION_ENTRY_KEYS = ["kind", "arm", "path"] as const;
const RUBRIC_FILE_KEYS = ["schema_version", "checks"] as const;

export type CollectionEntryKind = "session" | "attempt";

export interface CollectionEntry {
	kind: CollectionEntryKind;
	arm: ArmName;
	/** Path relative to the collection record's directory (safe, bounded). */
	path: string;
}

export interface CollectionRecord {
	schemaVersion: number;
	phase: Phase;
	nonTreatmentSha256: string;
	entries: CollectionEntry[];
}

/** Strict collection-record parsing (protocol §4.5): schema, phase, safe relative paths, bounded entries. */
export function parseCollectionRecord(text: string, where: string): CollectionRecord {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new NroError("COLLECTION_INVALID", `${where} is not valid JSON`);
	}
	const root = asRecord(raw);
	if (!root) throw new NroError("COLLECTION_INVALID", `${where} must be a JSON object`);
	requireKeys(root, COLLECTION_TOP_KEYS, where, "COLLECTION_INVALID");
	if (root.schema_version !== COLLECTION_SCHEMA_VERSION) {
		throw new NroError("COLLECTION_INVALID", `${where}.schema_version must be ${COLLECTION_SCHEMA_VERSION}`);
	}
	if (root.phase !== "dev" && root.phase !== "final") {
		throw new NroError("COLLECTION_INVALID", `${where}.phase must be "dev" or "final"`);
	}
	const phase: Phase = root.phase;
	const nonTreatmentSha256 = parseSha256(root.non_treatment_sha256, `${where}.non_treatment_sha256`);
	const entriesRaw = root.entries;
	if (!Array.isArray(entriesRaw)) throw new NroError("COLLECTION_INVALID", `${where}.entries must be an array`);
	if (entriesRaw.length > COLLECTION_MAX_ENTRIES) {
		throw new NroError("OVER_BOUND", `${where}.entries exceeds ${COLLECTION_MAX_ENTRIES} entries`);
	}
	const entries: CollectionEntry[] = [];
	for (let i = 0; i < entriesRaw.length; i += 1) {
		const e = asRecord(entriesRaw[i]);
		if (!e) throw new NroError("COLLECTION_INVALID", `${where}.entries[${i}] must be an object`);
		requireKeys(e, COLLECTION_ENTRY_KEYS, `${where}.entries[${i}]`, "COLLECTION_INVALID");
		const kind = e.kind;
		if (kind !== "session" && kind !== "attempt") {
			throw new NroError("COLLECTION_INVALID", `${where}.entries[${i}].kind must be "session" or "attempt"`);
		}
		const arm = parseArm(e.arm, `${where}.entries[${i}].arm`);
		const path = e.path;
		if (typeof path !== "string" || path.length === 0) {
			throw new NroError("COLLECTION_INVALID", `${where}.entries[${i}].path must be a non-empty string`);
		}
		if (utf8Bytes(path) > PATH_MAX_BYTES) {
			throw new NroError("OVER_BOUND", `${where}.entries[${i}].path exceeds ${PATH_MAX_BYTES} bytes`);
		}
		if (!BASENAME_RE.test(basename(path))) {
			throw new NroError("BASENAME_UNSAFE", `${where}.entries[${i}].path basename must be a bounded safe file name ([A-Za-z0-9][A-Za-z0-9._-]*, at most 128 chars)`);
		}
		// Rejects absolute/drive/UNC/NUL/".." (path-safety contract §4.5/§9.1).
		resolveSessionPath("", path);
		entries.push({ kind, arm, path });
	}
	return { schemaVersion: COLLECTION_SCHEMA_VERSION, phase, nonTreatmentSha256, entries };
}

/** The frozen rubric.json file shape (§6.2): schema_version 1 + strict checks. */
function parseRubricFile(text: string, where: string): RubricCheck[] {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new NroError("RUBRIC_INVALID", `${where} is not valid JSON`);
	}
	const root = asRecord(raw);
	if (!root) throw new NroError("RUBRIC_INVALID", `${where} must be a JSON object`);
	requireKeys(root, RUBRIC_FILE_KEYS, where, "RUBRIC_INVALID");
	if (root.schema_version !== RUBRIC_SCHEMA_VERSION) {
		throw new NroError("RUBRIC_INVALID", `${where}.schema_version must be ${RUBRIC_SCHEMA_VERSION}`);
	}
	return validateRubricChecks(root.checks, `${where}.checks`);
}

function fsErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: undefined;
}

function isAbsentError(error: unknown): boolean {
	return fsErrorCode(error) === "ENOENT";
}

/** Refuse existing outputs; only ENOENT means absent — any other stat failure fails closed. */
async function assertOutputAbsent(path: string, what: string): Promise<void> {
	try {
		await stat(path);
	} catch (error) {
		if (isAbsentError(error)) return;
		throw new NroError("IO_ERROR", `${what} cannot be inspected (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed: only ENOENT means absent`);
	}
	throw new NroError("EXISTING_OUTPUT", `${what} already exists — refusing to overwrite`);
}

/** Canonical environment.txt content (protocol §11.1 — exactly four lines in fixed order, no extra content). */
export function canonicalEnvironmentFile(env: FrozenEnvironment): string {
	return [
		`model_key: ${env.modelKey}`,
		`thinking_level: ${env.thinkingLevel}`,
		`pi_version: ${env.piVersion}`,
		`node_version: ${env.nodeVersion}`,
	].join("\n");
}

export interface FrozenInputsFacts {
	fixture: FixtureManifestResult;
	milestonePromptSha256: string;
	environment: FrozenEnvironment;
	rubricSha256: string;
	rubricChecks: RubricCheck[];
	/** Raw bytes captured at preflight — the staged copies are written from these (byte-exact by construction). */
	milestonePromptRaw: Buffer;
	environmentRaw: Buffer;
	rubricRaw: Buffer;
}

/**
 * Preflight the frozen inputs directory (protocol §11.1–§11.2): exactly
 * fixture/, milestone-prompt.txt, environment.txt and rubric.json, each
 * verified against the frozen pins. Read-only: nothing is written.
 */
export async function preflightInputs(inputsDir: string, protocol: FrozenProtocol): Promise<FrozenInputsFacts> {
	requireFrozenProtocol(protocol);
	const env = protocol.environment;
	let names: string[];
	try {
		names = await readdir(inputsDir);
	} catch {
		throw new NroError("INPUTS_INVALID", `inputs directory "${safeErrorValue(basename(inputsDir))}" cannot be read`);
	}
	const expected = new Set([FIXTURE_DIR_NAME, MILESTONE_PROMPT_NAME, ENVIRONMENT_NAME, RUBRIC_NAME]);
	for (const name of names) {
		if (!expected.has(name)) {
			throw new NroError("INPUTS_INVALID", `inputs directory must contain exactly fixture/, milestone-prompt.txt, environment.txt and rubric.json — unexpected entry "${safeErrorValue(name)}"`);
		}
	}
	if (names.length !== expected.size) {
		throw new NroError("INPUTS_INVALID", `inputs directory must contain exactly fixture/, milestone-prompt.txt, environment.txt and rubric.json (got ${names.length} entries)`);
	}

	const fixture = await fixtureManifestHash(join(inputsDir, FIXTURE_DIR_NAME));
	if (fixture.manifestSha256 !== protocol.fixtureManifestSha256) {
		throw new NroError("FIXTURE_MISMATCH", `fixture tree SHA-256 ${fixture.manifestSha256} does not match the frozen pin ${protocol.fixtureManifestSha256}`);
	}

	let promptRaw: Buffer;
	try {
		promptRaw = await readFile(join(inputsDir, MILESTONE_PROMPT_NAME));
	} catch {
		throw new NroError("INPUTS_INVALID", `inputs "${MILESTONE_PROMPT_NAME}" cannot be read`);
	}
	if (promptRaw.length > SESSION_MAX_BYTES) {
		throw new NroError("OVER_BOUND", `inputs "${MILESTONE_PROMPT_NAME}" exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	const promptSha = sha256Hex(promptRaw);
	if (promptSha !== protocol.milestonePromptSha256) {
		throw new NroError("MILESTONE_MISMATCH", `milestone-prompt.txt SHA-256 ${promptSha} does not match the frozen pin ${protocol.milestonePromptSha256}`);
	}

	let environmentRaw: Buffer;
	try {
		environmentRaw = await readFile(join(inputsDir, ENVIRONMENT_NAME));
	} catch {
		throw new NroError("INPUTS_INVALID", `inputs "${ENVIRONMENT_NAME}" cannot be read`);
	}
	if (environmentRaw.toString("utf8") !== canonicalEnvironmentFile(env)) {
		throw new NroError(
			"ENV_FILE_INVALID",
			"environment.txt must be exactly the four pinned lines in fixed order (model_key, thinking_level, pi_version, node_version) with no extra content",
		);
	}

	let rubricRaw: Buffer;
	try {
		rubricRaw = await readFile(join(inputsDir, RUBRIC_NAME));
	} catch {
		throw new NroError("INPUTS_INVALID", `inputs "${RUBRIC_NAME}" cannot be read`);
	}
	if (rubricRaw.length > SESSION_MAX_BYTES) {
		throw new NroError("OVER_BOUND", `inputs "${RUBRIC_NAME}" exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	// Strict rubric parse FIRST (protocol §6.2): a malformed rubric fails
	// closed as RUBRIC_INVALID regardless of its hash; only a structurally
	// valid rubric is then compared against the frozen content pin (content
	// drift stays RUBRIC_MISMATCH).
	const rubricChecks = parseRubricFile(rubricRaw.toString("utf8"), "rubric.json");
	const rubricSha = sha256Hex(rubricRaw);
	if (rubricSha !== protocol.rubricSha256) {
		throw new NroError("RUBRIC_MISMATCH", `rubric.json SHA-256 ${rubricSha} does not match the frozen pin ${protocol.rubricSha256}`);
	}
	return {
		fixture,
		milestonePromptSha256: promptSha,
		environment: env,
		rubricSha256: rubricSha,
		rubricChecks,
		milestonePromptRaw: promptRaw,
		environmentRaw,
		rubricRaw,
	};
}

export interface PreflightedSource {
	label: string;
	arm: ArmName;
	kind: CollectionEntryKind;
	basename: string;
	raw: Buffer;
	rawSha256: string;
	entries: unknown[];
}

export interface PreparedSession {
	label: string;
	arm: ArmName;
	orderIndex: number;
	basename: string;
	rawSha256: string;
	requests: number;
	compactions: number;
}

export interface PreflightCollectionResult {
	record: CollectionRecord;
	recordRaw: Buffer;
	sessions: PreparedSession[];
	attempts: AttemptFacts[];
	sources: PreflightedSource[];
}

/**
 * Preflight the collection record against the frozen protocol: schema,
 * phase, non-treatment pin, ABBA session order (final), safe relative
 * paths, distinct realpaths, regular bounded files, strict JSONL, final
 * session validity (prompt hash, environment, zero compactions, terminal
 * stop) and attempt classification by the frozen priority (§8.6).
 * Read-only: nothing is written.
 */
export async function preflightCollection(collectionFile: string, inputs: FrozenInputsFacts, protocol: FrozenProtocol): Promise<PreflightCollectionResult> {
	requireFrozenProtocol(protocol);
	const collectionDir = dirname(resolve(collectionFile));
	let dirReal: string;
	try {
		dirReal = await realpath(collectionDir);
	} catch {
		throw new NroError("IO_ERROR", "the collection record's directory cannot be resolved");
	}
	let info;
	try {
		info = await stat(collectionFile);
	} catch (error) {
		if (isAbsentError(error)) throw new NroError("COLLECTION_INVALID", "collection record is missing or unreadable");
		throw new NroError("IO_ERROR", `collection record cannot be inspected (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed`);
	}
	if (!info.isFile()) throw new NroError("COLLECTION_INVALID", "collection record is not a regular file");
	if (info.size > SESSION_MAX_BYTES) {
		throw new NroError("OVER_BOUND", `collection record exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	let recordRaw: Buffer;
	try {
		recordRaw = await readFile(collectionFile);
	} catch {
		throw new NroError("COLLECTION_INVALID", "collection record is unreadable");
	}
	const record = parseCollectionRecord(recordRaw.toString("utf8"), "collection record");
	if (record.nonTreatmentSha256 !== protocol.nonTreatmentSha256) {
		throw new NroError(
			"NON_TREATMENT_MISMATCH",
			`collection record non_treatment_sha256 ${record.nonTreatmentSha256} does not match the frozen pin ${protocol.nonTreatmentSha256}`,
		);
	}

	const sessions: PreparedSession[] = [];
	const attempts: AttemptFacts[] = [];
	const sources: PreflightedSource[] = [];
	const seenRealPaths = new Set<string>();
	const armOccurrence = new Map<ArmName, number>();
	let sessionPosition = 0;
	let attemptNumber = 0;
	for (const entry of record.entries) {
		let label: string;
		if (entry.kind === "session") {
			sessionPosition += 1;
			const n = (armOccurrence.get(entry.arm) ?? 0) + 1;
			armOccurrence.set(entry.arm, n);
			label = sessionLabel(entry.arm, n);
			if (record.phase === "final" && abbaArmAt(sessionPosition) !== entry.arm) {
				throw new NroError(
					"COLLECTION_INVALID",
					`collection session ${label} (position ${sessionPosition}) must be ${abbaArmAt(sessionPosition)} under the frozen ABBA interleave, got ${entry.arm}`,
				);
			}
		} else {
			attemptNumber += 1;
			label = `attempt-${attemptNumber}`;
		}
		const safeName = basename(entry.path);
		let real: string;
		try {
			real = await realpath(resolve(collectionDir, entry.path));
		} catch (error) {
			if (!isAbsentError(error)) {
				throw new NroError("IO_ERROR", `collection source "${label}" cannot be resolved (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed`);
			}
			throw new NroError("SOURCE_UNREADABLE", `collection source "${label}" (${safeErrorValue(safeName)}) is missing`);
		}
		if (real !== dirReal && !real.startsWith(dirReal + sep)) {
			throw new NroError("PATH_UNSAFE", `collection source "${label}" (${safeErrorValue(safeName)}) resolves outside the collection record's directory`);
		}
		if (seenRealPaths.has(real)) {
			throw new NroError("DUPLICATE_SOURCE", `collection source "${label}" duplicates another declared source (identical realpath — every source must be a distinct file)`);
		}
		seenRealPaths.add(real);
		try {
			info = await stat(real);
		} catch (error) {
			if (!isAbsentError(error)) {
				throw new NroError("IO_ERROR", `collection source "${label}" (${safeErrorValue(safeName)}) cannot be inspected (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed`);
			}
			throw new NroError("SOURCE_UNREADABLE", `collection source "${label}" (${safeErrorValue(safeName)}) is missing`);
		}
		if (!info.isFile()) throw new NroError("SOURCE_NOT_REGULAR", `collection source "${label}" (${safeErrorValue(safeName)}) is not a regular file`);
		if (info.size > SESSION_MAX_BYTES) {
			throw new NroError("SOURCE_OVER_BOUND", `collection source "${label}" (${safeErrorValue(safeName)}) exceeds ${SESSION_MAX_BYTES} bytes`);
		}
		let raw: Buffer;
		try {
			raw = await readFile(real);
		} catch {
			throw new NroError("SOURCE_UNREADABLE", `collection source "${label}" (${safeErrorValue(safeName)}) is missing`);
		}
		const rawSha256 = sha256Hex(raw);
		const entries = parseSessionLines(raw.toString("utf8"), label);
		sources.push({ label, arm: entry.arm, kind: entry.kind, basename: safeName, raw, rawSha256, entries });
		if (entry.kind === "session") {
			const run = computeRunFacts(
				label,
				entry.arm,
				sessionPosition,
				safeName,
				rawSha256,
				entries,
				protocol.milestonePromptSha256 as string,
				inputs.environment,
				{ sha256: inputs.rubricSha256, checks: inputs.rubricChecks },
				{ enforceValidity: record.phase === "final" },
			);
			sessions.push({ label, arm: entry.arm, orderIndex: sessionPosition, basename: safeName, rawSha256, requests: run.requests, compactions: run.compactions });
		} else {
			attempts.push(
				deriveAttemptFacts(label, entry.arm, safeName, rawSha256, entries, protocol.milestonePromptSha256 as string, inputs.environment, {
					strict: record.phase === "final",
				}),
			);
		}
	}
	if (record.phase === "final") {
		if (sessions.length !== 2 * protocol.runsPerArm) {
			throw new NroError("COHORT_COUNT", `a final collection record must contain exactly ${protocol.runsPerArm} control + ${protocol.runsPerArm} treatment session entries (got ${sessions.length})`);
		}
	} else if (sessions.length < 1) {
		throw new NroError("COHORT_COUNT", "a dev collection record must contain at least one session entry");
	}
	return { record, recordRaw, sessions, attempts, sources };
}

// ---------------------------------------------------------------------------
// Full preparation pipeline (preflight -> stage -> verify -> commit)
// ---------------------------------------------------------------------------

export interface DeviationsAttempt {
	label: string;
	arm: ArmName;
	/** Runs-root-relative evidence path of the staged attempt copy. */
	path: string;
	basename: string;
	rawSha256: string;
	promptSha256: string | null;
	category: AttemptCategory;
	terminal: TerminalFacts;
}

export interface DeviationsDocument {
	schema_version: number;
	protocol_doc: string;
	phase: Phase;
	milestone_prompt_sha256: string;
	attempts: DeviationsAttempt[];
}

/** Serialize the strict manifest (snake_case wire form, protocol §7). */
export function manifestToJson(manifest: NroManifest): string {
	return `${JSON.stringify(
		{
			schema_version: manifest.schemaVersion,
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

export interface PrepareHooks {
	/** TEST SEAM ONLY — invoked after staging is fully populated and byte-verified, before the final output re-checks and exclusive commits. */
	beforeEvidenceCommit?: () => void | Promise<void>;
	/** TEST SEAM ONLY — invoked immediately after the evidence directory was EXCLUSIVELY created, before the staged tree is moved in. */
	afterEvidenceReserve?: () => void | Promise<void>;
	/** TEST SEAM ONLY — invoked after the staged tree moved into the owned evidence directory, before the manifest commit. */
	afterEvidenceCommit?: () => void | Promise<void>;
	/** TEST SEAM ONLY — invoked immediately after the manifest was EXCLUSIVELY created with open("wx"), before its bytes are written. */
	afterManifestOpen?: () => void | Promise<void>;
	/** TEST SEAM ONLY — invoked after the manifest commit, before the post-commit verification reads. */
	afterManifestCommit?: () => void | Promise<void>;
}

export interface PrepareOptions {
	/** Runs root (default `<cwd>/.pi/workbench/runs` at the CLI). */
	runsDir: string;
	/** Frozen inputs directory (fixture/, milestone-prompt.txt, environment.txt, rubric.json). */
	inputsDir: string;
	/** Immutable collection record (chronological log of every retained attempt and session). */
	collectionFile: string;
	protocol?: FrozenProtocol;
	/** Test-only failure seams (documented above); absent in production runs. */
	hooks?: PrepareHooks;
}

export interface PrepareResult {
	/** Absolute path of the committed evidence directory. */
	evidenceDir: string;
	/** Absolute path of the committed strict manifest. */
	manifestPath: string;
	manifest: NroManifest;
	record: CollectionRecord;
	sessions: PreparedSession[];
	attempts: AttemptFacts[];
}

/** Recursive byte-exact fixture copy (regular files and directories only; symlinks fail closed). */
async function copyFixtureTree(source: string, dest: string): Promise<void> {
	const walk = async (current: string, relPrefix: string): Promise<void> => {
		let names;
		try {
			names = await readdir(current, { withFileTypes: true });
		} catch {
			throw new NroError("FIXTURE_UNSAFE", `fixture directory "${safeErrorValue(basename(current))}" cannot be read`);
		}
		names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const dirent of names) {
			const rel = relPrefix.length === 0 ? dirent.name : `${relPrefix}/${dirent.name}`;
			if (utf8Bytes(rel) > PATH_MAX_BYTES) throw new NroError("OVER_BOUND", `fixture path exceeds ${PATH_MAX_BYTES} bytes`);
			if (CONTROL_CHAR_RE.test(rel)) throw new NroError("FIXTURE_UNSAFE", "fixture path contains control characters");
			if (dirent.isSymbolicLink()) throw new NroError("FIXTURE_UNSAFE", `fixture entry "${safeErrorValue(rel)}" is a symlink`);
			const src = join(current, dirent.name);
			const dst = join(dest, rel);
			if (dirent.isDirectory()) {
				await mkdir(dst);
				await walk(src, rel);
				continue;
			}
			if (!dirent.isFile()) throw new NroError("FIXTURE_UNSAFE", `fixture entry "${safeErrorValue(rel)}" is not a regular file`);
			await writeFile(dst, await readFile(src));
		}
	};
	await mkdir(dest);
	await walk(source, "");
}

const EVIDENCE_CHILDREN = [
	FIXTURE_DIR_NAME,
	MILESTONE_PROMPT_NAME,
	ENVIRONMENT_NAME,
	RUBRIC_NAME,
	COLLECTION_RECORD_NAME,
	"sessions",
	"attempts",
	DEVIATIONS_NAME,
] as const;

/**
 * Read and fully preflight every input BEFORE any output is created:
 * existing-output refusal, frozen inputs against the pins, collection
 * record with final session validity and attempt classification. All
 * derivation happens in memory; only then is a staging directory
 * populated, byte-verified, and committed with EXCLUSIVE create
 * primitives (non-recursive mkdir + open("wx")) and ownership-tracked
 * rollback (device+inode identity). Any failure removes the staging
 * directory and only the outputs this invocation owns — never partial
 * final evidence, never a foreign path. Purely offline: no model calls,
 * no network, no shell, no provider/cache/session state.
 */
export async function prepareEvidence(options: PrepareOptions): Promise<PrepareResult> {
	const protocol = options.protocol ?? FROZEN_NRO_PROTOCOL;
	const hooks = options.hooks;
	const runsDir = resolve(options.runsDir);
	const evidenceDirPath = join(runsDir, EVIDENCE_DIR_NAME);
	const manifestPath = join(runsDir, MANIFEST_NAME);

	// Refuse to overwrite existing final outputs (before any read/write).
	await assertOutputAbsent(evidenceDirPath, "NRO evidence directory");
	await assertOutputAbsent(manifestPath, "NRO manifest");

	// Preflight everything read-only first (protocol §11.2.1).
	const inputsDir = resolve(options.inputsDir);
	const collectionFile = resolve(options.collectionFile);
	const inputs = await preflightInputs(inputsDir, protocol);
	const { record, recordRaw, sessions, attempts, sources } = await preflightCollection(collectionFile, inputs, protocol);

	// Assemble the strict manifest (runs-root-relative evidence paths).
	const evidencePrefix = `${EVIDENCE_DIR_NAME}/`;
	const manifest: NroManifest = {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		protocolDoc: PROTOCOL_DOC,
		phase: record.phase,
		milestonePromptSha256: protocol.milestonePromptSha256 as string,
		environment: {
			modelKey: protocol.environment.modelKey,
			thinkingLevel: protocol.environment.thinkingLevel,
			piVersion: protocol.environment.piVersion,
			nodeVersion: protocol.environment.nodeVersion,
		},
		fixture: { path: `${evidencePrefix}${FIXTURE_DIR_NAME}`, manifestSha256: protocol.fixtureManifestSha256 as string },
		nonTreatmentSha256: protocol.nonTreatmentSha256 as string,
		rubric: { sha256: protocol.rubricSha256 as string, checks: inputs.rubricChecks },
		sessions: sessions.map((s) => ({
			label: s.label,
			arm: s.arm,
			orderIndex: s.orderIndex,
			path: `${evidencePrefix}sessions/${s.label}/${s.basename}`,
			expectedSessionSha256: s.rawSha256,
		})),
		attempts: attempts.map((a) => ({
			label: a.label,
			arm: a.arm,
			path: `${evidencePrefix}attempts/${a.label}/${a.sessionBasename}`,
			expectedSessionSha256: a.rawSha256,
			promptSha256: a.promptSha256,
			category: a.category,
		})),
	};
	const manifestJson = manifestToJson(manifest);
	// Round-trip the generated manifest through the strict parser before
	// anything is committed (protocol §11.2.3).
	try {
		parseManifest(manifestJson, protocol);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new NroError("INVALID_MANIFEST", `generated manifest failed the strict manifest validation: ${detail}`);
	}
	const deviations: DeviationsDocument = {
		schema_version: DEVIATIONS_SCHEMA_VERSION,
		protocol_doc: PROTOCOL_DOC,
		phase: record.phase,
		milestone_prompt_sha256: protocol.milestonePromptSha256 as string,
		attempts: attempts.map((a) => ({
			label: a.label,
			arm: a.arm,
			path: `${evidencePrefix}attempts/${a.label}/${a.sessionBasename}`,
			basename: a.sessionBasename,
			rawSha256: a.rawSha256,
			promptSha256: a.promptSha256,
			category: a.category,
			terminal: a.terminal,
		})),
	};
	const deviationsJson = `${JSON.stringify(deviations, null, 2)}\n`;

	// Stage (writes go ONLY under the staging directory), verify, commit.
	const staging = join(runsDir, `${STAGING_PREFIX}${randomUUID().slice(0, 8)}`);
	let evidenceOwned = false;
	let manifestOwned = false;
	let evidenceDirStat: { dev: number; ino: number } | null = null;
	let manifestStat: { dev: number; ino: number } | null = null;
	try {
		await mkdir(runsDir, { recursive: true });
		await mkdir(staging, { recursive: true });
		await copyFixtureTree(join(inputsDir, FIXTURE_DIR_NAME), join(staging, FIXTURE_DIR_NAME));
		await writeFile(join(staging, MILESTONE_PROMPT_NAME), inputs.milestonePromptRaw);
		await writeFile(join(staging, ENVIRONMENT_NAME), inputs.environmentRaw);
		await writeFile(join(staging, RUBRIC_NAME), inputs.rubricRaw);
		await writeFile(join(staging, COLLECTION_RECORD_NAME), recordRaw);
		for (const s of sources) {
			const dest = s.kind === "session" ? join(staging, "sessions", s.label, s.basename) : join(staging, "attempts", s.label, s.basename);
			await mkdir(dirname(dest), { recursive: true });
			await writeFile(dest, s.raw);
		}
		await writeFile(join(staging, DEVIATIONS_NAME), deviationsJson, "utf8");

		// Verify every staged byte before anything is committed.
		const stagedFixture = await fixtureManifestHash(join(staging, FIXTURE_DIR_NAME));
		if (stagedFixture.manifestSha256 !== (protocol.fixtureManifestSha256 as string)) {
			throw new NroError("STAGE_VERIFY", "staged fixture tree does not reproduce the frozen fixture manifest hash");
		}
		if (sha256Hex(await readFile(join(staging, MILESTONE_PROMPT_NAME))) !== (protocol.milestonePromptSha256 as string)) {
			throw new NroError("STAGE_VERIFY", "staged milestone-prompt.txt is not byte-identical to the frozen prompt");
		}
		if ((await readFile(join(staging, ENVIRONMENT_NAME), "utf8")) !== canonicalEnvironmentFile(protocol.environment)) {
			throw new NroError("STAGE_VERIFY", "staged environment.txt is not the canonical pinned environment file");
		}
		if (sha256Hex(await readFile(join(staging, RUBRIC_NAME))) !== (protocol.rubricSha256 as string)) {
			throw new NroError("STAGE_VERIFY", "staged rubric.json is not byte-identical to the frozen rubric");
		}
		if (!(await readFile(join(staging, COLLECTION_RECORD_NAME))).equals(recordRaw)) {
			throw new NroError("STAGE_VERIFY", "staged collection record is not byte-identical to the collection record");
		}
		for (const s of sources) {
			const staged = await readFile(join(staging, s.kind === "session" ? "sessions" : "attempts", s.label, s.basename));
			if (!staged.equals(s.raw)) {
				throw new NroError("STAGE_VERIFY", `staged copy of source "${s.label}" is not byte-identical to the source file`);
			}
		}

		// Re-check BOTH final outputs immediately before the commits: a
		// racing foreign output that appeared since preflight is refused
		// (never overwritten). Only ENOENT means absent. The exclusive
		// creates below are the actual no-clobber guarantee — these
		// re-checks only classify the common pre-existing case early.
		await hooks?.beforeEvidenceCommit?.();
		await assertOutputAbsent(evidenceDirPath, "NRO evidence directory");
		await assertOutputAbsent(manifestPath, "NRO manifest");

		// Commit 1: EXCLUSIVELY reserve the evidence directory with a
		// NON-recursive mkdir (EEXIST refuses any pre-existing or racing
		// output, including a racing EMPTY foreign directory that a rename
		// would silently replace). Ownership is marked immediately after
		// the exclusive create and the identity is captured for the
		// ownership-verified rollback (re-captured after the move).
		try {
			await mkdir(evidenceDirPath);
		} catch (error) {
			if (fsErrorCode(error) === "EEXIST") {
				throw new NroError("EXISTING_OUTPUT", `NRO evidence directory ${basename(evidenceDirPath)} appeared during commit — refusing to overwrite`);
			}
			throw error;
		}
		evidenceOwned = true;
		const reservedStat = await stat(evidenceDirPath);
		evidenceDirStat = { dev: reservedStat.dev, ino: reservedStat.ino };
		await hooks?.afterEvidenceReserve?.();

		// Move the staged tree into the invocation-owned directory (POSIX
		// rename replaces the empty directory we exclusively created; a
		// racing foreign entry inside makes the rename fail — ENOTEMPTY —
		// and fails closed). The post-move identity is re-captured.
		try {
			await rename(staging, evidenceDirPath);
		} catch (error) {
			if (fsErrorCode(error) === "EEXIST" || fsErrorCode(error) === "ENOTEMPTY" || fsErrorCode(error) === "ENOTDIR") {
				throw new NroError("EXISTING_OUTPUT", `NRO evidence directory ${basename(evidenceDirPath)} appeared during commit — refusing to overwrite`);
			}
			throw error;
		}
		const movedStat = await stat(evidenceDirPath);
		evidenceDirStat = { dev: movedStat.dev, ino: movedStat.ino };
		await hooks?.afterEvidenceCommit?.();

		// Commit 2: the strict manifest via an EXCLUSIVE open("wx") —
		// EEXIST means a pre-existing or racing foreign manifest occupies
		// the path and is refused, never overwritten. Ownership is marked
		// after the open; the bytes are then written, synced and closed,
		// and any failure — including a failure while writing — rolls the
		// owned manifest back.
		try {
			await assertOutputAbsent(manifestPath, "NRO manifest");
			const handle = await open(manifestPath, "wx");
			manifestOwned = true;
			const openedStat = await handle.stat();
			manifestStat = { dev: openedStat.dev, ino: openedStat.ino };
			try {
				await hooks?.afterManifestOpen?.();
				await handle.writeFile(manifestJson, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (fsErrorCode(error) === "EEXIST") {
				throw new NroError("EXISTING_OUTPUT", `NRO manifest ${basename(manifestPath)} appeared during commit — refusing to overwrite`);
			}
			throw error;
		}
		await hooks?.afterManifestCommit?.();

		// Post-commit verification: committed manifest byte-identity and
		// committed fixture tree hash (the rename was atomic — this
		// re-checks the committed bytes).
		const writtenManifest = await readFile(manifestPath, "utf8");
		if (writtenManifest !== manifestJson) {
			throw new NroError("STAGE_VERIFY", "committed manifest content is not byte-identical to the generated manifest");
		}
		const committedFixture = await fixtureManifestHash(join(evidenceDirPath, FIXTURE_DIR_NAME));
		if (committedFixture.manifestSha256 !== (protocol.fixtureManifestSha256 as string)) {
			throw new NroError("STAGE_VERIFY", "committed fixture tree does not reproduce the frozen fixture manifest hash");
		}
	} catch (error) {
		// Fail closed: remove the staging directory (owned by
		// construction) plus ONLY the outputs this invocation established
		// ownership of, each removed only while it is STILL this
		// invocation's (device+inode identity): the evidence directory's
		// known children are removed and the directory itself rmdir'ed (a
		// foreign entry that somehow appeared inside makes the rmdir fail
		// and survives); the manifest is unlinked only while it is still
		// the file the exclusive open created. Pre-existing or racing
		// foreign outputs — and foreign replacements of an owned path —
		// are never deleted.
		await rm(staging, { recursive: true, force: true }).catch(() => {});
		if (evidenceOwned && evidenceDirStat) {
			try {
				const now = await stat(evidenceDirPath);
				if (now.dev === evidenceDirStat.dev && now.ino === evidenceDirStat.ino) {
					for (const child of EVIDENCE_CHILDREN) {
						await rm(join(evidenceDirPath, child), { recursive: true, force: true }).catch(() => {});
					}
					await rmdir(evidenceDirPath).catch(() => {});
				}
			} catch {
				// Already gone or unreadable — never delete a path whose
				// ownership cannot be verified as this invocation's.
			}
		}
		if (manifestOwned && manifestStat) {
			try {
				const now = await stat(manifestPath);
				if (now.dev === manifestStat.dev && now.ino === manifestStat.ino) {
					await rm(manifestPath, { force: true });
				}
			} catch {
				// Already gone or unreadable — never delete a manifest whose
				// ownership cannot be verified as this invocation's.
			}
		}
		throw error;
	}

	return { evidenceDir: evidenceDirPath, manifestPath, manifest, record, sessions, attempts };
}

// ---------------------------------------------------------------------------
// CLI (protocol §9.1, §11.1) — exit 0 success, 1 fail-closed (stderr only,
// no partial stdout), 2 usage error
// ---------------------------------------------------------------------------

function usage(): string {
	return [
		"commander-native-tool-benchmark — NRO benchmark harness (offline, machine facts only)",
		"",
		"usage:",
		"  tsx scripts/commander-native-tool-benchmark.ts analyze <manifest.json> [--json]",
		"  tsx scripts/commander-native-tool-benchmark.ts prepare --inputs <dir> --collection <file> [--runs-dir <dir>]",
		"",
		"analyze — read-only offline analyzer over the strict NRO manifest (schema_version 1):",
		"  session/attempt/fixture paths inside the manifest are relative to the manifest file's directory",
		"  (absolute/drive/UNC/NUL/'..' paths, symlink escapes and duplicate realpaths are rejected);",
		"  --json emits the deterministic JSON report; without it the bounded human rendering is emitted",
		"  reads only: the manifest, the declared session/attempt files and the declared fixture tree",
		"  never: model calls, network, provider/cache/session state, file writes, absolute paths in output",
		"",
		"prepare — offline evidence preparation (fail-closed, exclusive commit, refuses existing outputs):",
		"  --inputs <dir>       frozen inputs directory (fixture/, milestone-prompt.txt, environment.txt, rubric.json)",
		"  --collection <file>  immutable collection record (chronological log of every retained attempt and session)",
		"  --runs-dir <dir>     evidence/manifest runs root (default: <cwd>/.pi/workbench/runs)",
		"  writes only: <runs-dir>/commander-native-tool-benchmark/ (byte-exact copies) + the strict manifest",
		"  never: model calls, network, shell, provider/cache/session state, repository source files",
		"",
		"exit codes: 0 success | 1 any fail-closed error (stderr only, no partial stdout) | 2 usage error",
	].join("\n");
}

export interface PrepareCliArgs {
	help: boolean;
	/** null => usage error. */
	inputsDir: string | null;
	/** null => usage error. */
	collectionFile: string | null;
	runsDir: string;
}

/** Strict `prepare` option parsing: --inputs/--collection required, --runs-dir optional; anything else is a usage error. */
export function parsePrepareArgs(argv: readonly string[]): PrepareCliArgs {
	let runsDir = join(process.cwd(), ".pi", "workbench", "runs");
	let inputsDir: string | null = null;
	let collectionFile: string | null = null;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string;
		if (arg === "--help" || arg === "-h") return { help: true, inputsDir: null, collectionFile: null, runsDir };
		if (arg === "--inputs" || arg === "--collection" || arg === "--runs-dir") {
			const value = argv[i + 1];
			if (value === undefined) return { help: false, inputsDir: null, collectionFile: null, runsDir };
			if (arg === "--inputs") inputsDir = value;
			else if (arg === "--collection") collectionFile = value;
			else runsDir = value;
			i += 1;
			continue;
		}
		return { help: false, inputsDir: null, collectionFile: null, runsDir };
	}
	if (inputsDir === null || collectionFile === null) return { help: false, inputsDir: null, collectionFile: null, runsDir };
	return { help: false, inputsDir, collectionFile, runsDir };
}

export function renderPrepareSummary(result: PrepareResult): string[] {
	const m = result.manifest;
	const lines = [
		"commander-native-tool-benchmark prepare: evidence committed (offline, machine facts only)",
		`  evidence dir : ${EVIDENCE_DIR_NAME}/ (fixture + 4 frozen inputs + ${result.sessions.length} sessions + ${result.attempts.length} attempts, byte-exact copies)`,
		`  manifest     : ${MANIFEST_NAME} (schema ${m.schemaVersion}, phase ${m.phase}, ${m.sessions.length} sessions, ${m.attempts.length} attempts; paths relative to the runs root)`,
		`  fixture      : manifest sha256 ${m.fixture.manifestSha256} | prompt sha256 ${m.milestonePromptSha256} | non-treatment sha256 ${m.nonTreatmentSha256} | rubric sha256 ${m.rubric.sha256}`,
	];
	for (const attempt of result.attempts) {
		lines.push(`attempt ${attempt.label} | [${attempt.arm}] category ${attempt.category} | prompt ${attempt.promptSha256 ?? "null"} | raw ${attempt.rawSha256} | basename ${attempt.sessionBasename}`);
	}
	lines.push("privacy : hashes, labels, basenames and bounded machine facts only — never message bodies, tool arguments, thinking, or absolute paths");
	return lines;
}

async function mainAnalyze(args: readonly string[]): Promise<number> {
	const manifestArg = args[0];
	if (manifestArg === undefined) {
		process.stderr.write(`${usage()}\n`);
		return 2;
	}
	const unknown = args.slice(1).filter((a) => a !== "--json");
	if (unknown.length > 0) {
		process.stderr.write(`commander-native-tool-benchmark analyze: unknown option(s): ${unknown.join(", ")}\n${usage()}\n`);
		return 2;
	}
	const json = args.includes("--json");
	try {
		const report = await analyzeManifestFile(manifestArg);
		if (json) {
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		} else {
			for (const line of renderReport(report)) process.stdout.write(`${line}\n`);
		}
		return 0;
	} catch (error) {
		if (error instanceof NroError) {
			process.stderr.write(`commander-native-tool-benchmark analyze: ${error.code}: ${error.message}\n`);
		} else {
			process.stderr.write("commander-native-tool-benchmark analyze: unexpected failure (details withheld — see privacy boundary)\n");
		}
		return 1;
	}
}

async function mainPrepare(args: readonly string[]): Promise<number> {
	const parsed = parsePrepareArgs(args);
	if (parsed.help) {
		process.stdout.write(`${usage()}\n`);
		return 0;
	}
	if (parsed.inputsDir === null || parsed.collectionFile === null) {
		process.stderr.write(`${usage()}\n`);
		return 2;
	}
	try {
		const result = await prepareEvidence({ runsDir: parsed.runsDir, inputsDir: parsed.inputsDir, collectionFile: parsed.collectionFile });
		for (const line of renderPrepareSummary(result)) process.stdout.write(`${line}\n`);
		return 0;
	} catch (error) {
		if (error instanceof NroError) {
			process.stderr.write(`commander-native-tool-benchmark prepare: ${error.code}: ${error.message}\n`);
		} else {
			process.stderr.write("commander-native-tool-benchmark prepare: unexpected failure (details withheld — see privacy boundary)\n");
		}
		return 1;
	}
}

export async function main(argv: readonly string[]): Promise<number> {
	const subcommand = argv[0];
	if (subcommand === undefined) {
		process.stderr.write(`${usage()}\n`);
		return 2;
	}
	if (subcommand === "--help" || subcommand === "-h") {
		process.stdout.write(`${usage()}\n`);
		return 0;
	}
	if (subcommand === "analyze") return mainAnalyze(argv.slice(1));
	if (subcommand === "prepare") return mainPrepare(argv.slice(1));
	process.stderr.write(`commander-native-tool-benchmark: unknown subcommand "${safeErrorValue(subcommand)}"\n${usage()}\n`);
	return 2;
}

// Run only when executed directly (tsx scripts/commander-native-tool-benchmark.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const exitCode = await main(process.argv.slice(2));
	process.exit(exitCode);
}
