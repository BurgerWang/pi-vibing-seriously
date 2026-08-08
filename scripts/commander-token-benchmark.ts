#!/usr/bin/env tsx
/**
 * P9 benchmark-preparation analyzer (commander-token-optimization plan,
 * Slice E prep) — OFFLINE, machine facts only. Harness/protocol prep: this
 * tool never writes a P9 result, phase PASS, release verdict, plan status,
 * CHANGELOG entry, or publication claim.
 *
 * Reads only:
 *   1. one strict JSON benchmark manifest (schema_version 1) that carries
 *      the frozen P9 protocol facts: the pinned milestone prompt SHA-256,
 *      the pinned expected environment (provider/model key + thinking
 *      level), the pinned P0 reference facts, the pinned P3 reference
 *      facts (including the exact frozen P3 rule), and EXACTLY six
 *      labelled Pi Session JSONL files — the three preserved P3 pre
 *      sessions (baseline: labels pre-1..pre-3 with pinned raw-byte
 *      SHA-256) and three fresh final-current sessions (current: labels
 *      final-current-1..final-current-3 whose expected SHA-256 is resolved
 *      at collection time). Session paths are resolved RELATIVE to the
 *      manifest file's directory;
 *   2. the declared Pi Session JSONL files (raw bytes hashed and enforced
 *      against each session's `expected_session_sha256`; every non-empty
 *      line parsed strictly as a JSON object).
 *
 * Never:
 *   - calls a model, sends any HTTP request, touches provider/cache/session
 *     state, or writes any file (stdout/stderr only);
 *   - renders or persists message bodies, tool arguments, raw tool-result
 *     content, thinking text, secrets, or absolute input paths — output is
 *     manifest labels, session basenames, hashes, counts and numeric facts
 *     only, under the documented hard bounds below.
 *
 * Machine facts reuse `buildCostBreakdown` from
 * extensions/workbench-runtime/core/cost-breakdown.ts (exact commander
 * requests, commander input/output/cacheRead/cacheWrite/gross/cost,
 * compactions, per-tool/total inline text bytes) with STRICT input hygiene:
 * malformed JSONL, missing user/assistant usage, missing recorded thinking
 * level, non-finite/negative/over-bound usage facts, prompt-hash mismatch,
 * session-hash mismatch, model/thinking environment mismatch, unsafe or
 * over-bound labels/basenames/paths/model keys/thinking levels/tool names,
 * duplicate labels/paths, missing files, and any cohort shape other than
 * exactly 3 baseline + 3 current all fail closed (exit 1) with no partial
 * output. Successful tool-result inline bytes count only toolResult
 * messages not marked isError=true; total inline bytes are reported
 * separately.
 *
 * Targets (frozen protocol §3.4):
 *   - P0 references: the pinned P0 long-session facts are reported, but
 *     every P0-based aspirational target is ALWAYS NOT_MEASURABLE with a
 *     fixed basis-incomparable reason. The single long-lived P0 session
 *     (187 requests, 23,603,500 gross tokens) is scale-incomparable with
 *     the short 3-session cohorts, and P0 recorded no isError split, so no
 *     ACHIEVED/MISSED classification is ever derived from comparing short
 *     cohort sums to P0 — and the larger P0 total denominator is NOT
 *     conservative toward MISS.
 *   - Comparable-milestone arithmetic: the same three aspirational
 *     thresholds (requests >= 25%, successful inline bytes >= 80%, gross
 *     tokens >= 40%) computed between exactly the three preserved P3 pre
 *     sessions and the three fresh final-current sessions (equal-size
 *     cohort totals, exact integer arithmetic, zero baseline denominator
 *     -> NOT_MEASURABLE). These are labelled historical comparable-cohort
 *     arithmetic — non-causal, not strict P0 measurement.
 *
 * usage:
 *   tsx scripts/commander-token-benchmark.ts <manifest.json> [--json]
 */

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCostBreakdown, toolResultTextBytes } from "../extensions/workbench-runtime/core/cost-breakdown.ts";

// ---------------------------------------------------------------------------
// Constants and error type
// ---------------------------------------------------------------------------

export const BENCHMARK_SCHEMA_VERSION = 1;
export const PROTOCOL_DOC = "docs/baselines/commander-token-p9-protocol.md";
export const UNKNOWN_TOOL_NAME = "(unknown)";

const SHA256_RE = /^[0-9a-f]{64}$/;
const COHORTS = ["baseline", "current"] as const;
export type CohortName = (typeof COHORTS)[number];
/** Cost is rounded to 9 decimals per run (same convention as the P3 analyzer). */
const COST_DECIMALS = 1e9;
/** Deterministic float tolerance used only for the pinned P3 ratio check. */
const RATIO_EPSILON = 1e-12;

// ---------------------------------------------------------------------------
// Documented hard bounds (protocol §3.6 — every output-facing identity
// string is strictly bounded and restricted to a safe character set)
// ---------------------------------------------------------------------------

/** Manifest file size cap (a valid manifest is a few KiB). */
export const MANIFEST_MAX_BYTES = 1_048_576;
/** Per-session file size cap (real P3 sessions are ~0.1–0.2 MiB). */
export const SESSION_MAX_BYTES = 16 * 1024 * 1024;
/** Per-session non-empty JSONL line cap. */
export const SESSION_MAX_LINES = 100_000;
/**
 * Numeric fact cap: every usage fact and every pinned reference fact must
 * be a finite non-negative integer <= this. 1e11 keeps every cohort total
 * and every exact-integer threshold product well below 2^53, so the target
 * arithmetic is always exact in IEEE-754 integer arithmetic.
 */
export const MAX_USAGE_FACT = 100_000_000_000;
/** Session label cap (chars). */
export const LABEL_MAX_CHARS = 64;
/** Declared session/manifest path cap (UTF-8 bytes). */
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
export const HUMAN_MAX_LINES = 200;
export const HUMAN_MAX_BYTES = 64 * 1024;

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/;
const THINKING_LEVEL_RE = /^[A-Za-z0-9._-]{1,32}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type BenchmarkErrorCode =
	| "IO_ERROR"
	| "INVALID_MANIFEST"
	| "COHORT_COUNT"
	| "DUPLICATE_LABEL"
	| "DUPLICATE_PATH"
	| "PATH_UNSAFE"
	| "LABEL_UNSAFE"
	| "BASENAME_UNSAFE"
	| "MODEL_UNSAFE"
	| "THINKING_UNSAFE"
	| "TOOL_NAME_UNSAFE"
	| "OVER_BOUND"
	| "FILE_MISSING"
	| "MALFORMED_JSONL"
	| "MISSING_USER_MESSAGE"
	| "MISSING_PROMPT_TEXT"
	| "MISSING_ASSISTANT_USAGE"
	| "MISSING_THINKING_LEVEL"
	| "INVALID_FACTS"
	| "PROMPT_MISMATCH"
	| "HASH_MISMATCH"
	| "MODEL_MISMATCH"
	| "THINKING_MISMATCH"
	| "P3_RULE_MISMATCH";

/** Structured analysis failure — fail closed, never a partial report. */
export class BenchmarkError extends Error {
	readonly code: BenchmarkErrorCode;
	constructor(code: BenchmarkErrorCode, message: string) {
		super(message);
		this.name = "BenchmarkError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Frozen protocol (the analyzer implements this exact pinned protocol)
// ---------------------------------------------------------------------------

export interface P0ReferenceFacts {
	commanderRequests: number;
	commanderInputTokens: number;
	commanderOutputTokens: number;
	commanderCacheReadTokens: number;
	commanderCacheWriteTokens: number;
	commanderGrossTokens: number;
	toolResultTextBytes: number;
}

export interface P3ReferenceFacts {
	preTotalRequests: number;
	currentTotalRequests: number;
	requestReductionRatio: number | null;
	verdict: "PASS" | "FAIL";
	rule: string;
}

/**
 * The frozen P9 protocol constants. Production analysis uses exactly this
 * table (the CLI never overrides it); tests may pass a derived table to
 * exercise the enforcement logic with fixture byte hashes.
 */
export interface FrozenProtocol {
	/** SHA-256 of the extracted first user-message text of the fixed milestone prompt. */
	milestonePromptSha256: string;
	/** Exact expected environment: model key (`provider/model`, `responseModel ?? model`) and thinking level. */
	environment: { modelKey: string; thinkingLevel: string };
	/** Pinned P0 reference facts (P0 record §1). */
	p0Reference: P0ReferenceFacts;
	/** Pinned P3 reference facts (P3 record §5.2 / analysis.json). */
	p3Reference: P3ReferenceFacts;
	/** Pinned preserved P3 pre-session labels -> raw-byte SHA-256 (P3 record §4.3). */
	pinnedPreSessions: Readonly<Record<string, string>>;
	/** Exact final-current labels (their expected hashes are resolved at collection time). */
	finalCurrentLabels: readonly string[];
}

export const FROZEN_P3_RULE = "PASS only if current total requests < pre total requests";

export const FROZEN_PROTOCOL: FrozenProtocol = {
	milestonePromptSha256: "01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f",
	environment: { modelKey: "openai-codex/gpt-5.6-sol", thinkingLevel: "high" },
	p0Reference: {
		commanderRequests: 187,
		commanderInputTokens: 1530854,
		commanderOutputTokens: 111430,
		commanderCacheReadTokens: 21961216,
		commanderCacheWriteTokens: 0,
		commanderGrossTokens: 23603500,
		toolResultTextBytes: 3276725,
	},
	p3Reference: {
		preTotalRequests: 8,
		currentTotalRequests: 8,
		requestReductionRatio: 0,
		verdict: "FAIL",
		rule: FROZEN_P3_RULE,
	},
	pinnedPreSessions: {
		"pre-1": "08b7467e3945b913d8a7e5f81cb890cc057078ed6b50973f7d4dff4c3f5744ec",
		"pre-2": "a245d51db3a030f69028af82d80ffdfb3870c9ef68c099d43b3d7df2c331a899",
		"pre-3": "93aad011fbccd7b60b380f4825c3b4d9ebb753c1fe91da424a17b412b5cd677b",
	},
	finalCurrentLabels: ["final-current-1", "final-current-2", "final-current-3"],
};

// ---------------------------------------------------------------------------
// Manifest schema (strict)
// ---------------------------------------------------------------------------

export interface ManifestSession {
	label: string;
	cohort: CohortName;
	path: string;
	/** SHA-256 of the raw session file bytes; enforced against the file. */
	expectedSessionSha256: string;
}

export interface BenchmarkManifest {
	schemaVersion: number;
	milestonePromptSha256: string;
	environment: { modelKey: string; thinkingLevel: string };
	p0Reference: P0ReferenceFacts;
	p3Reference: P3ReferenceFacts;
	sessions: ManifestSession[];
}

const MANIFEST_TOP_KEYS = ["schema_version", "milestone_prompt_sha256", "environment", "p0_reference", "p3_reference", "sessions"] as const;
const ENV_KEYS = ["model_key", "thinking_level"] as const;
const P0_KEYS = [
	"commander_requests",
	"commander_input_tokens",
	"commander_output_tokens",
	"commander_cache_read_tokens",
	"commander_cache_write_tokens",
	"commander_gross_tokens",
	"tool_result_text_bytes",
] as const;
const P3_KEYS = ["pre_total_requests", "current_total_requests", "request_reduction_ratio", "verdict", "rule"] as const;
const SESSION_KEYS = ["label", "cohort", "path", "expected_session_sha256"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function requireKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) throw new BenchmarkError("INVALID_MANIFEST", `unknown key "${key}" in ${where}`);
	}
}

function requireBoundedInt(value: unknown, where: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > MAX_USAGE_FACT) {
		throw new BenchmarkError("INVALID_MANIFEST", `${where} must be a finite non-negative integer no greater than ${MAX_USAGE_FACT}`);
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

/**
 * Strictly parse the benchmark manifest. Unknown keys, a wrong schema
 * version, a milestone prompt hash other than the pinned frozen hash, an
 * environment other than the pinned frozen environment, P0 reference facts
 * other than the pinned facts (with gross-identity and integer checks), P3
 * reference facts other than the pinned facts (ratio/verdict must reproduce
 * the frozen rule and the rule string must be EXACTLY the frozen P3 rule),
 * malformed sessions (label/path/basename/expected-hash rules, bounded
 * lengths and safe character sets), duplicate labels, any cohort shape
 * other than exactly the three pinned baseline sessions (pre-1..pre-3 with
 * pinned hashes) and exactly the three final-current sessions
 * (final-current-1..final-current-3) all fail closed.
 */
export function parseManifest(text: string, protocol: FrozenProtocol = FROZEN_PROTOCOL): BenchmarkManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new BenchmarkError("INVALID_MANIFEST", "manifest is not valid JSON");
	}
	const root = asRecord(raw);
	if (!root) throw new BenchmarkError("INVALID_MANIFEST", "manifest must be a JSON object");
	requireKeys(root, MANIFEST_TOP_KEYS, "manifest");
	if (root.schema_version !== BENCHMARK_SCHEMA_VERSION) {
		throw new BenchmarkError("INVALID_MANIFEST", `schema_version must be ${BENCHMARK_SCHEMA_VERSION}`);
	}
	const milestoneSha = root.milestone_prompt_sha256;
	if (typeof milestoneSha !== "string" || !SHA256_RE.test(milestoneSha)) {
		throw new BenchmarkError("INVALID_MANIFEST", "milestone_prompt_sha256 must be a 64-hex SHA-256 string");
	}
	if (milestoneSha !== protocol.milestonePromptSha256) {
		throw new BenchmarkError("INVALID_MANIFEST", `milestone_prompt_sha256 must be the frozen milestone prompt hash ${protocol.milestonePromptSha256}`);
	}

	const envRaw = asRecord(root.environment);
	if (!envRaw) throw new BenchmarkError("INVALID_MANIFEST", "environment must be an object");
	requireKeys(envRaw, ENV_KEYS, "environment");
	const modelKey = envRaw.model_key;
	if (typeof modelKey !== "string" || !MODEL_KEY_RE.test(modelKey)) {
		throw new BenchmarkError("MODEL_UNSAFE", `environment.model_key must match [A-Za-z0-9][A-Za-z0-9._/-]* with at most ${MODEL_KEY_MAX_CHARS} characters`);
	}
	if (modelKey !== protocol.environment.modelKey) {
		throw new BenchmarkError("INVALID_MANIFEST", `environment.model_key must be the frozen P3 environment model key "${protocol.environment.modelKey}"`);
	}
	const thinkingLevel = envRaw.thinking_level;
	if (typeof thinkingLevel !== "string" || !THINKING_LEVEL_RE.test(thinkingLevel)) {
		throw new BenchmarkError("THINKING_UNSAFE", `environment.thinking_level must match [A-Za-z0-9._-]* with at most ${THINKING_LEVEL_MAX_CHARS} characters`);
	}
	if (thinkingLevel !== protocol.environment.thinkingLevel) {
		throw new BenchmarkError("INVALID_MANIFEST", `environment.thinking_level must be the frozen P3 environment thinking level "${protocol.environment.thinkingLevel}"`);
	}

	const p0Raw = asRecord(root.p0_reference);
	if (!p0Raw) throw new BenchmarkError("INVALID_MANIFEST", "p0_reference must be an object");
	requireKeys(p0Raw, P0_KEYS, "p0_reference");
	const p0Reference: P0ReferenceFacts = {
		commanderRequests: requireBoundedInt(p0Raw.commander_requests, "p0_reference.commander_requests"),
		commanderInputTokens: requireBoundedInt(p0Raw.commander_input_tokens, "p0_reference.commander_input_tokens"),
		commanderOutputTokens: requireBoundedInt(p0Raw.commander_output_tokens, "p0_reference.commander_output_tokens"),
		commanderCacheReadTokens: requireBoundedInt(p0Raw.commander_cache_read_tokens, "p0_reference.commander_cache_read_tokens"),
		commanderCacheWriteTokens: requireBoundedInt(p0Raw.commander_cache_write_tokens, "p0_reference.commander_cache_write_tokens"),
		commanderGrossTokens: requireBoundedInt(p0Raw.commander_gross_tokens, "p0_reference.commander_gross_tokens"),
		toolResultTextBytes: requireBoundedInt(p0Raw.tool_result_text_bytes, "p0_reference.tool_result_text_bytes"),
	};
	if (p0Reference.commanderGrossTokens !== p0Reference.commanderInputTokens + p0Reference.commanderOutputTokens + p0Reference.commanderCacheReadTokens + p0Reference.commanderCacheWriteTokens) {
		throw new BenchmarkError("INVALID_MANIFEST", "p0_reference.commander_gross_tokens must equal input + output + cacheRead + cacheWrite");
	}
	if (!deepEqual(p0Reference, protocol.p0Reference)) {
		throw new BenchmarkError("INVALID_MANIFEST", "p0_reference must equal the pinned P0 reference facts");
	}

	const p3Raw = asRecord(root.p3_reference);
	if (!p3Raw) throw new BenchmarkError("INVALID_MANIFEST", "p3_reference must be an object");
	requireKeys(p3Raw, P3_KEYS, "p3_reference");
	const preTotalRequests = requireBoundedInt(p3Raw.pre_total_requests, "p3_reference.pre_total_requests");
	const currentTotalRequests = requireBoundedInt(p3Raw.current_total_requests, "p3_reference.current_total_requests");
	const rule = p3Raw.rule;
	if (typeof rule !== "string" || rule !== FROZEN_P3_RULE) {
		throw new BenchmarkError("P3_RULE_MISMATCH", `p3_reference.rule must be exactly the frozen P3 rule "${FROZEN_P3_RULE}"`);
	}
	const expectedRatio = preTotalRequests === 0 ? null : (preTotalRequests - currentTotalRequests) / preTotalRequests;
	const ratio = p3Raw.request_reduction_ratio;
	let requestReductionRatio: number | null;
	if (ratio === null && expectedRatio === null) {
		requestReductionRatio = null;
	} else if (typeof ratio === "number" && Number.isFinite(ratio) && expectedRatio !== null && Math.abs(ratio - expectedRatio) <= RATIO_EPSILON) {
		requestReductionRatio = ratio;
	} else {
		throw new BenchmarkError("INVALID_MANIFEST", "p3_reference.request_reduction_ratio must equal (pre_total_requests - current_total_requests) / pre_total_requests (null when pre is 0)");
	}
	const expectedVerdict = currentTotalRequests < preTotalRequests ? "PASS" : "FAIL";
	const verdict = p3Raw.verdict;
	if (verdict !== "PASS" && verdict !== "FAIL") {
		throw new BenchmarkError("INVALID_MANIFEST", 'p3_reference.verdict must be "PASS" or "FAIL"');
	}
	if (verdict !== expectedVerdict) {
		throw new BenchmarkError("INVALID_MANIFEST", `p3_reference.verdict must be "${expectedVerdict}" under the frozen rule "PASS only if current total requests < pre total requests"`);
	}
	const p3Reference: P3ReferenceFacts = {
		preTotalRequests,
		currentTotalRequests,
		requestReductionRatio,
		verdict: verdict as "PASS" | "FAIL",
		rule,
	};
	if (!deepEqual(p3Reference, protocol.p3Reference)) {
		throw new BenchmarkError("INVALID_MANIFEST", "p3_reference must equal the pinned P3 reference facts");
	}

	const sessionsRaw = root.sessions;
	if (!Array.isArray(sessionsRaw)) {
		throw new BenchmarkError("INVALID_MANIFEST", "sessions must be an array");
	}
	const sessions: ManifestSession[] = [];
	const seenLabels = new Set<string>();
	for (let i = 0; i < sessionsRaw.length; i += 1) {
		const s = asRecord(sessionsRaw[i]);
		if (!s) throw new BenchmarkError("INVALID_MANIFEST", `sessions[${i}] must be an object`);
		requireKeys(s, SESSION_KEYS, `sessions[${i}]`);
		const label = s.label;
		if (typeof label !== "string" || !LABEL_RE.test(label)) {
			throw new BenchmarkError("LABEL_UNSAFE", `sessions[${i}].label must match [A-Za-z0-9][A-Za-z0-9._-]* with at most ${LABEL_MAX_CHARS} characters`);
		}
		if (seenLabels.has(label)) throw new BenchmarkError("DUPLICATE_LABEL", `duplicate session label "${label}"`);
		seenLabels.add(label);
		const cohort = s.cohort;
		if (cohort !== "baseline" && cohort !== "current") {
			throw new BenchmarkError("INVALID_MANIFEST", `sessions[${i}].cohort must be "baseline" or "current"`);
		}
		const path = s.path;
		if (typeof path !== "string" || path.length === 0) {
			throw new BenchmarkError("INVALID_MANIFEST", `sessions[${i}].path must be a non-empty string`);
		}
		if (utf8Bytes(path) > PATH_MAX_BYTES) {
			throw new BenchmarkError("OVER_BOUND", `sessions[${i}].path exceeds ${PATH_MAX_BYTES} bytes`);
		}
		if (!BASENAME_RE.test(basename(path))) {
			throw new BenchmarkError("BASENAME_UNSAFE", `sessions[${i}].path basename must match [A-Za-z0-9][A-Za-z0-9._-]* with at most ${BASENAME_MAX_CHARS} characters`);
		}
		const expectedSha = s.expected_session_sha256;
		if (typeof expectedSha !== "string" || !SHA256_RE.test(expectedSha)) {
			throw new BenchmarkError("INVALID_MANIFEST", `sessions[${i}].expected_session_sha256 must be a 64-hex SHA-256 string`);
		}
		if (cohort === "baseline") {
			const pinned = protocol.pinnedPreSessions[label];
			if (pinned === undefined) {
				throw new BenchmarkError(
					"COHORT_COUNT",
					`baseline session "${label}" is not one of the pinned preserved P3 pre sessions (${Object.keys(protocol.pinnedPreSessions).join(", ")})`,
				);
			}
			if (expectedSha !== pinned) {
				throw new BenchmarkError("INVALID_MANIFEST", `sessions[${i}].expected_session_sha256 for "${label}" must equal its pinned preserved P3 hash ${pinned}`);
			}
		} else if (!protocol.finalCurrentLabels.includes(label)) {
			throw new BenchmarkError("COHORT_COUNT", `current session "${label}" is not one of the final-current labels (${protocol.finalCurrentLabels.join(", ")})`);
		}
		sessions.push({ label, cohort, path, expectedSessionSha256: expectedSha });
	}
	const baselineSessions = sessions.filter((s) => s.cohort === "baseline");
	const currentSessions = sessions.filter((s) => s.cohort === "current");
	if (baselineSessions.length !== 3 || currentSessions.length !== 3) {
		throw new BenchmarkError(
			"COHORT_COUNT",
			`the manifest must declare exactly three baseline sessions (${Object.keys(protocol.pinnedPreSessions).join(", ")}) and exactly three current sessions (${protocol.finalCurrentLabels.join(", ")})`,
		);
	}
	const baselineLabels = new Set(baselineSessions.map((s) => s.label));
	const pinnedLabels = new Set(Object.keys(protocol.pinnedPreSessions));
	if (baselineLabels.size !== pinnedLabels.size || [...baselineLabels].some((l) => !pinnedLabels.has(l))) {
		throw new BenchmarkError("COHORT_COUNT", `baseline labels must be exactly ${Object.keys(protocol.pinnedPreSessions).join(", ")}`);
	}
	const currentLabels = new Set(currentSessions.map((s) => s.label));
	const finalLabels = new Set(protocol.finalCurrentLabels);
	if (currentLabels.size !== finalLabels.size || [...currentLabels].some((l) => !finalLabels.has(l))) {
		throw new BenchmarkError("COHORT_COUNT", `current labels must be exactly ${protocol.finalCurrentLabels.join(", ")}`);
	}

	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		milestonePromptSha256: milestoneSha,
		environment: { modelKey, thinkingLevel },
		p0Reference,
		p3Reference,
		sessions,
	};
}

// ---------------------------------------------------------------------------
// Path safety (relative to the manifest directory, realpath contained)
// ---------------------------------------------------------------------------

/**
 * Resolve a declared session path against the manifest directory. Absolute
 * POSIX paths, Windows drive/UNC paths, NUL bytes and ".." segments are
 * rejected; the realpath containment check in buildReport refuses any file
 * that resolves outside the manifest directory (symlink escapes included).
 */
export function resolveSessionPath(manifestDir: string, rawPath: string): string {
	if (rawPath.startsWith("/")) throw new BenchmarkError("PATH_UNSAFE", "session path must be relative (absolute path rejected)");
	if (/^[A-Za-z]:[\\/]/.test(rawPath)) throw new BenchmarkError("PATH_UNSAFE", "session path must be relative (drive path rejected)");
	if (rawPath.startsWith("\\\\")) throw new BenchmarkError("PATH_UNSAFE", "session path must be relative (UNC path rejected)");
	if (rawPath.includes("\0")) throw new BenchmarkError("PATH_UNSAFE", "session path contains a NUL byte");
	const segments = rawPath.split(/[\\/]+/);
	if (segments.some((s) => s === "..")) throw new BenchmarkError("PATH_UNSAFE", "session path must not contain '..' segments");
	return resolve(manifestDir, rawPath);
}

// ---------------------------------------------------------------------------
// Session parsing and strict validation
// ---------------------------------------------------------------------------

/**
 * Strict JSONL: every non-empty line must parse as a JSON object, and the
 * non-empty line count is bounded by SESSION_MAX_LINES (OVER_BOUND).
 */
export function parseSessionLines(text: string, label: string): unknown[] {
	const entries: unknown[] = [];
	const clean = text.replace(/^\uFEFF/, "");
	const lines = clean.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = (lines[i] ?? "").trim();
		if (line.length === 0) continue;
		if (entries.length >= SESSION_MAX_LINES) {
			throw new BenchmarkError("OVER_BOUND", `session "${label}": more than ${SESSION_MAX_LINES} non-empty JSONL lines`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new BenchmarkError("MALFORMED_JSONL", `session "${label}": line ${i + 1} is not valid JSON`);
		}
		if (!asRecord(parsed)) throw new BenchmarkError("MALFORMED_JSONL", `session "${label}": line ${i + 1} is not a JSON object`);
		entries.push(parsed);
	}
	return entries;
}

function requireValidUsageField(usage: Record<string, unknown>, key: string, integerRequired: boolean, where: string): void {
	const value = usage[key];
	if (value === undefined) return; // absent component contributes zero (buildCostBreakdown semantics)
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_USAGE_FACT || (integerRequired && !Number.isInteger(value))) {
		throw new BenchmarkError(
			"INVALID_FACTS",
			`${where} usage.${key} must be a finite non-negative ${integerRequired ? "integer" : "number"} no greater than ${MAX_USAGE_FACT}`,
		);
	}
}

/**
 * Strict usage validation (fail closed): a present component must be a
 * finite non-negative number (integer for token components) no greater than
 * MAX_USAGE_FACT; absent components contribute zero. Any usage present
 * anywhere in the session (assistant/toolResult messages, compaction,
 * branch_summary) is checked, so corrupt non-finite/negative/over-bound
 * facts can never be silently normalized.
 */
export function validateUsage(usage: unknown, where: string): void {
	const u = asRecord(usage);
	if (!u) throw new BenchmarkError("INVALID_FACTS", `${where} usage must be an object`);
	for (const key of ["input", "output", "cacheRead", "cacheWrite"]) requireValidUsageField(u, key, true, where);
	const cost = u.cost;
	if (cost !== undefined) {
		const c = asRecord(cost);
		if (!c) throw new BenchmarkError("INVALID_FACTS", `${where} usage.cost must be an object`);
		requireValidUsageField(c, "total", false, where);
	}
}

/** Strict session validation — see per-condition comments. */
export function validateEntries(entries: readonly unknown[], label: string): void {
	let userCount = 0;
	let assistantCount = 0;
	for (const entry of entries) {
		const e = asRecord(entry);
		if (!e) continue;
		if (e.type !== "message") {
			if ((e.type === "compaction" || e.type === "branch_summary") && e.usage !== undefined) {
				validateUsage(e.usage, `session "${label}"`);
			}
			continue;
		}
		const m = asRecord(e.message);
		if (!m) throw new BenchmarkError("MALFORMED_JSONL", `session "${label}": message entry without a message object`);
		if (m.role === "user") {
			userCount += 1;
			continue;
		}
		if (m.usage !== undefined) validateUsage(m.usage, `session "${label}"`);
		if (m.role === "assistant") {
			assistantCount += 1;
			if (m.usage === undefined || !asRecord(m.usage)) {
				throw new BenchmarkError("MISSING_ASSISTANT_USAGE", `session "${label}": assistant message has no usage object`);
			}
		}
	}
	if (userCount === 0) throw new BenchmarkError("MISSING_USER_MESSAGE", `session "${label}": no user message`);
	if (assistantCount === 0) throw new BenchmarkError("MISSING_ASSISTANT_USAGE", `session "${label}": no assistant message with usage`);
}

/**
 * Extract the first user-message text ONLY to hash it: the concatenated
 * text parts of the first user message (string content or content[] items
 * of type "text"). The text is never stored, rendered or persisted.
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
	throw new BenchmarkError("MISSING_USER_MESSAGE", "no user message found");
}

// ---------------------------------------------------------------------------
// Per-run machine facts (buildCostBreakdown-compatible)
// ---------------------------------------------------------------------------

export interface PerToolTextFacts {
	toolName: string;
	entries: number;
	textBytes: number;
	successfulEntries: number;
	successfulTextBytes: number;
}

export interface RunFacts {
	label: string;
	cohort: CohortName;
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
}

export function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Deterministic toolName for a toolResult message (same semantics as cost-breakdown). */
function successfulToolNameOf(entry: unknown): string {
	const e = asRecord(entry);
	const m = e ? asRecord(e.message) : null;
	if (!e || e.type !== "message" || !m || m.role !== "toolResult") return UNKNOWN_TOOL_NAME;
	const name = m.toolName;
	return typeof name === "string" && name.length > 0 ? name : UNKNOWN_TOOL_NAME;
}

/**
 * Compute the per-run machine facts. Reuses `buildCostBreakdown` for
 * commander requests, commander input/output/cacheRead/cacheWrite/gross/
 * cost, compactions and per-tool/total inline text bytes; adds the
 * successful-byte pass (toolResult messages NOT marked isError=true) with
 * the same UTF-8 byte semantics as `toolResultTextBytes`. Fail-closed
 * enforcement, in order:
 *   - the extracted first user-message text must hash to the manifest's
 *     frozen milestone prompt SHA-256 (PROMPT_MISMATCH);
 *   - every assistant message must carry exactly the expected environment
 *     model key (`provider/(responseModel ?? model)`) — a missing/unknown/
 *     multiple/different key fails (MODEL_MISMATCH);
 *   - a thinking_level_change entry must exist and its recorded (last)
 *     value must equal the expected thinking level exactly
 *     (MISSING_THINKING_LEVEL / THINKING_MISMATCH);
 *   - every non-empty toolResult toolName must be a bounded safe identifier
 *     (TOOL_NAME_UNSAFE) — tool names are output-facing identity strings.
 */
export function computeRunFacts(
	label: string,
	cohort: CohortName,
	sessionBasename: string,
	sessionSha256: string,
	entries: readonly unknown[],
	expectedPromptSha256: string,
	expectedModelKey: string,
	expectedThinkingLevel: string,
): RunFacts {
	validateEntries(entries, label);
	const promptText = extractPromptText(entries);
	if (promptText.length === 0) throw new BenchmarkError("MISSING_PROMPT_TEXT", `session "${label}": first user message has no extractable text`);
	const promptSha256 = sha256Hex(promptText);
	if (promptSha256 !== expectedPromptSha256) {
		throw new BenchmarkError(
			"PROMPT_MISMATCH",
			`session "${label}": extracted first user-message text SHA-256 ${promptSha256} does not match the expected milestone prompt SHA-256 ${expectedPromptSha256}`,
		);
	}

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
				if (key !== expectedModelKey) {
					throw new BenchmarkError(
						"MODEL_MISMATCH",
						`session "${label}": assistant model key "${safeErrorValue(key)}" does not match the expected environment model key "${expectedModelKey}" (every assistant message must carry the identical expected model identity)`,
					);
				}
			} else if (m.role === "toolResult") {
				const name = m.toolName;
				if (typeof name === "string" && name.length > 0 && !TOOL_NAME_RE.test(name)) {
					throw new BenchmarkError("TOOL_NAME_UNSAFE", `session "${label}": toolResult toolName is not a bounded safe identifier (${TOOL_NAME_MAX_CHARS} chars, [A-Za-z0-9._-])`);
				}
			}
		} else if (e.type === "thinking_level_change") {
			if (typeof e.thinkingLevel === "string" && e.thinkingLevel.length > 0) lastThinkingLevel = e.thinkingLevel;
		}
	}
	if (lastThinkingLevel === null) {
		throw new BenchmarkError("MISSING_THINKING_LEVEL", `session "${label}": no thinking_level_change entry — the recorded thinking level is missing`);
	}
	if (lastThinkingLevel !== expectedThinkingLevel) {
		throw new BenchmarkError("THINKING_MISMATCH", `session "${label}": recorded thinking level "${safeErrorValue(lastThinkingLevel)}" does not match the expected environment thinking level "${expectedThinkingLevel}"`);
	}

	const breakdown = buildCostBreakdown(entries);

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

	return {
		label,
		cohort,
		sessionBasename,
		sessionSha256,
		promptSha256,
		promptMatches: true,
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
		modelKeys: [expectedModelKey],
		thinkingLevel: expectedThinkingLevel,
	};
}

// ---------------------------------------------------------------------------
// Cohort totals and target classification
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

export type TargetStatus = "ACHIEVED" | "MISSED" | "NOT_MEASURABLE";
export type TargetKind = "p0_reference" | "comparable_cohort";

export interface TargetResult {
	id: string;
	kind: TargetKind;
	metricLabel: string;
	threshold: number;
	thresholdDisplay: string;
	reductionRatio: number | null;
	status: TargetStatus;
	reason: string;
}

export interface P0TargetDefinition {
	id: string;
	metricLabel: string;
	threshold: number;
	thresholdDisplay: string;
	/** Fixed basis-incomparable reason (frozen protocol text — never derived from current facts). */
	fixedReason: string;
}

/**
 * Frozen §10.2 aspirational targets vs the P0 reference. Every one is
 * ALWAYS NOT_MEASURABLE with a fixed basis-incomparable reason: P0 is one
 * long-lived commander session (scale-incomparable with the short
 * 3-session cohorts), and P0 recorded no isError split — so the larger P0
 * total denominator is NOT conservative toward MISS and no ACHIEVED/MISSED
 * classification is ever derived from comparing short cohort sums to P0.
 */
export const P0_TARGET_DEFINITIONS: readonly P0TargetDefinition[] = [
	{
		id: "requests",
		metricLabel: "commander requests",
		threshold: 0.25,
		thresholdDisplay: "25%",
		fixedReason:
			"P0 is one long-lived commander session (187 requests, 23,603,500 gross tokens); the 3-session final-current cohort is a different scale and basis, so comparing a short cohort sum to the P0 session is not a comparable measurement (frozen basis-incomparable).",
	},
	{
		id: "successful_inline_bytes",
		metricLabel: "successful tool-result inline bytes",
		threshold: 0.8,
		thresholdDisplay: "80%",
		fixedReason:
			"P0 recorded no isError split — its tool-result byte fact (3,276,725 bytes) is the total of all tool results, so the successful-bytes target has no matched basis against P0 (frozen basis-incomparable).",
	},
	{
		id: "gross_tokens",
		metricLabel: "commander gross tokens",
		threshold: 0.4,
		thresholdDisplay: "40%",
		fixedReason:
			"P0 is one long-lived commander session (23,603,500 gross tokens); the 3-session final-current cohort is a different scale and basis, so comparing a short cohort sum to the P0 session is not a comparable measurement (frozen basis-incomparable).",
	},
];

/** Every P0-based aspirational target is NOT_MEASURABLE — pinned reference only. */
export function p0TargetResults(): TargetResult[] {
	return P0_TARGET_DEFINITIONS.map((def) => ({
		id: `p0_${def.id}`,
		kind: "p0_reference",
		metricLabel: def.metricLabel,
		threshold: def.threshold,
		thresholdDisplay: def.thresholdDisplay,
		reductionRatio: null,
		status: "NOT_MEASURABLE",
		reason: def.fixedReason,
	}));
}

export interface ComparableTargetDefinition {
	id: string;
	metricLabel: string;
	threshold: number;
	thresholdDisplay: string;
	/** threshold * 1000 — exact integer basis for the comparison. */
	thresholdBasis1000: number;
	/** Baseline cohort field (the three preserved P3 pre sessions). */
	preField: keyof CohortTotals;
	/** Current cohort field (the three fresh final-current sessions). */
	currentField: keyof CohortTotals;
}

/**
 * Frozen §10.2 aspirational thresholds applied to the comparable-milestone
 * cohorts: exactly the three preserved P3 pre sessions vs exactly the
 * three fresh final-current sessions (equal-size cohort totals). These are
 * historical comparable-cohort arithmetic — non-causal, not strict P0
 * measurement.
 */
export const COMPARABLE_TARGET_DEFINITIONS: readonly ComparableTargetDefinition[] = [
	{
		id: "requests",
		metricLabel: "commander requests",
		threshold: 0.25,
		thresholdDisplay: "25%",
		thresholdBasis1000: 250,
		preField: "requests",
		currentField: "requests",
	},
	{
		id: "successful_inline_bytes",
		metricLabel: "successful tool-result inline bytes",
		threshold: 0.8,
		thresholdDisplay: "80%",
		thresholdBasis1000: 800,
		preField: "successfulTextBytes",
		currentField: "successfulTextBytes",
	},
	{
		id: "gross_tokens",
		metricLabel: "commander gross tokens",
		threshold: 0.4,
		thresholdDisplay: "40%",
		thresholdBasis1000: 400,
		preField: "gross",
		currentField: "gross",
	},
];

/**
 * Classify the three comparable-milestone targets. reduction = (pre −
 * current) / pre with the preserved P3 pre cohort as denominator; the
 * threshold comparison is exact integer arithmetic ((pre − current) * 1000
 * >= thresholdBasis * pre — all quantities bounded non-negative integers).
 * A zero pre denominator is NOT_MEASURABLE — never PASS. Every reason is
 * explicitly labelled historical comparable-cohort arithmetic (non-causal,
 * not strict P0 measurement).
 */
export function classifyComparableTargets(pre: CohortTotals, current: CohortTotals, preCount: number, currentCount: number): TargetResult[] {
	const basis = `historical comparable-cohort arithmetic (${preCount} preserved P3 pre sessions vs ${currentCount} fresh final-current sessions; equal-size cohort totals; non-causal, not strict P0 measurement)`;
	return COMPARABLE_TARGET_DEFINITIONS.map((def) => {
		const denominator = pre[def.preField];
		const numerator = current[def.currentField];
		if (denominator === 0) {
			return {
				id: `comparable_${def.id}`,
				kind: "comparable_cohort",
				metricLabel: def.metricLabel,
				threshold: def.threshold,
				thresholdDisplay: def.thresholdDisplay,
				reductionRatio: null,
				status: "NOT_MEASURABLE",
				reason: `${basis}: pre cohort ${def.preField} is 0 — zero denominator; target not measurable (never PASS)`,
			};
		}
		const ratio = (denominator - numerator) / denominator;
		const achieved = (denominator - numerator) * 1000 >= def.thresholdBasis1000 * denominator;
		const status: TargetStatus = achieved ? "ACHIEVED" : "MISSED";
		const reason = `${basis}: reduction ${ratio.toFixed(4)} (current ${numerator} vs pre ${denominator}) ${achieved ? ">=" : "<"} threshold ${def.thresholdDisplay}`;
		return {
			id: `comparable_${def.id}`,
			kind: "comparable_cohort",
			metricLabel: def.metricLabel,
			threshold: def.threshold,
			thresholdDisplay: def.thresholdDisplay,
			reductionRatio: ratio,
			status,
			reason,
		};
	});
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export interface BenchmarkReport {
	schemaVersion: number;
	protocolDoc: string;
	manifest: {
		basename: string;
		milestonePromptSha256: string;
		environment: { modelKey: string; thinkingLevel: string };
		p0Reference: P0ReferenceFacts;
		p3Reference: P3ReferenceFacts;
		sessionCount: number;
		baselineSessionCount: number;
		currentSessionCount: number;
	};
	runs: RunFacts[];
	cohorts: { baseline: CohortTotals; current: CohortTotals };
	targets: {
		/** P0 references — always NOT_MEASURABLE (fixed basis-incomparable reasons). */
		p0Reference: TargetResult[];
		/** Comparable-milestone arithmetic — the only measured target statuses. */
		comparableCohort: TargetResult[];
	};
}

/**
 * Analyze every declared session (all runs retained, none excluded) with
 * realpath containment, strict JSONL parsing, raw-byte hash enforcement and
 * fail-closed validation, then aggregate cohort totals and classify the
 * targets. Read-only: no file is written.
 */
export async function buildReport(manifest: BenchmarkManifest, manifestDir: string, manifestBasename: string): Promise<BenchmarkReport> {
	const dirReal = await realpath(manifestDir);
	const runs: RunFacts[] = [];
	const seenRealPaths = new Set<string>();
	for (const session of manifest.sessions) {
		const safeName = basename(session.path);
		const resolved = resolveSessionPath(manifestDir, session.path);
		let fileReal: string;
		try {
			fileReal = await realpath(resolved);
		} catch {
			throw new BenchmarkError("FILE_MISSING", `session file "${safeName}" (label "${session.label}") is missing or unreadable`);
		}
		if (fileReal !== dirReal && !fileReal.startsWith(dirReal + sep)) {
			throw new BenchmarkError("PATH_UNSAFE", `session file "${safeName}" (label "${session.label}") resolves outside the manifest directory`);
		}
		if (seenRealPaths.has(fileReal)) {
			throw new BenchmarkError("DUPLICATE_PATH", `session file "${safeName}" (label "${session.label}") duplicates another declared session file`);
		}
		seenRealPaths.add(fileReal);
		let info;
		try {
			info = await stat(fileReal);
		} catch {
			throw new BenchmarkError("FILE_MISSING", `session file "${safeName}" (label "${session.label}") is not readable`);
		}
		if (!info.isFile()) throw new BenchmarkError("FILE_MISSING", `session path "${safeName}" (label "${session.label}") is not a regular file`);
		if (info.size > SESSION_MAX_BYTES) {
			throw new BenchmarkError("OVER_BOUND", `session file "${safeName}" (label "${session.label}") exceeds ${SESSION_MAX_BYTES} bytes`);
		}
		let raw: Buffer;
		try {
			raw = await readFile(fileReal);
		} catch {
			throw new BenchmarkError("FILE_MISSING", `session file "${safeName}" (label "${session.label}") could not be read`);
		}
		const sessionSha256 = sha256Hex(raw);
		if (sessionSha256 !== session.expectedSessionSha256) {
			throw new BenchmarkError(
				"HASH_MISMATCH",
				`session "${session.label}": raw byte SHA-256 ${sessionSha256} does not match expected_session_sha256 ${session.expectedSessionSha256}`,
			);
		}
		const entries = parseSessionLines(raw.toString("utf8"), session.label);
		runs.push(
			computeRunFacts(
				session.label,
				session.cohort,
				safeName,
				sessionSha256,
				entries,
				manifest.milestonePromptSha256,
				manifest.environment.modelKey,
				manifest.environment.thinkingLevel,
			),
		);
	}

	const baseline = emptyCohortTotals();
	const current = emptyCohortTotals();
	for (const run of runs) addRunToTotals(run.cohort === "baseline" ? baseline : current, run);
	// Cohort cost is the sum of the per-run rounded costs, rounded once more
	// to the same 9-decimal convention (deterministic, no float artifacts).
	for (const totals of [baseline, current]) totals.cost = Math.round(totals.cost * COST_DECIMALS) / COST_DECIMALS;

	const baselineCount = manifest.sessions.filter((s) => s.cohort === "baseline").length;
	const currentCount = manifest.sessions.filter((s) => s.cohort === "current").length;

	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		protocolDoc: PROTOCOL_DOC,
		manifest: {
			basename: manifestBasename,
			milestonePromptSha256: manifest.milestonePromptSha256,
			environment: manifest.environment,
			p0Reference: manifest.p0Reference,
			p3Reference: manifest.p3Reference,
			sessionCount: manifest.sessions.length,
			baselineSessionCount: baselineCount,
			currentSessionCount: currentCount,
		},
		runs,
		cohorts: { baseline, current },
		targets: {
			p0Reference: p0TargetResults(),
			comparableCohort: classifyComparableTargets(baseline, current, baselineCount, currentCount),
		},
	};
}

/** Read the manifest file (size-bounded) and run the full offline analysis pipeline. */
export async function analyzeManifestFile(manifestPath: string, protocol: FrozenProtocol = FROZEN_PROTOCOL): Promise<BenchmarkReport> {
	const name = basename(manifestPath);
	let info;
	try {
		info = await stat(manifestPath);
	} catch {
		throw new BenchmarkError("IO_ERROR", `cannot read manifest "${safeErrorValue(name)}": missing or unreadable`);
	}
	if (!info.isFile()) throw new BenchmarkError("IO_ERROR", `manifest "${safeErrorValue(name)}" is not a regular file`);
	if (info.size > MANIFEST_MAX_BYTES) {
		throw new BenchmarkError("OVER_BOUND", `manifest "${safeErrorValue(name)}" exceeds ${MANIFEST_MAX_BYTES} bytes`);
	}
	if (!BASENAME_RE.test(name)) {
		throw new BenchmarkError("BASENAME_UNSAFE", "manifest basename must be a bounded safe file name ([A-Za-z0-9][A-Za-z0-9._-]*, at most 128 chars)");
	}
	let text: string;
	try {
		text = await readFile(manifestPath, "utf8");
	} catch {
		throw new BenchmarkError("IO_ERROR", `cannot read manifest "${safeErrorValue(name)}": unreadable`);
	}
	const manifest = parseManifest(text, protocol);
	return buildReport(manifest, dirname(resolve(manifestPath)), name);
}

// ---------------------------------------------------------------------------
// Deterministic bounded human rendering (facts only — no raw content)
// ---------------------------------------------------------------------------

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

const LABEL_MAX_BYTES = 64;
const BASENAME_MAX_BYTES = 128;
const MODEL_KEY_MAX_BYTES = 96;
const THINKING_MAX_BYTES = 32;

function renderTotalsLine(name: string, totals: CohortTotals): string {
	return `${name.padEnd(9)} requests ${totals.requests} | gross ${totals.gross} | inline bytes ${totals.successfulTextBytes}/${totals.totalTextBytes} succ/total | compactions ${totals.compactions} | cost $${totals.cost.toFixed(6)}`;
}

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
	const p0 = m.p0Reference;
	const p3 = m.p3Reference;
	const lines: string[] = [
		"commander token benchmark (P9 protocol prep) — offline analyzer, machine facts only",
		`protocol doc  : ${PROTOCOL_DOC}`,
		`manifest      : ${boundedDisplay(m.basename, BASENAME_MAX_BYTES).text} (schema ${report.schemaVersion}, ${m.sessionCount} sessions: ${m.baselineSessionCount} baseline / ${m.currentSessionCount} current)`,
		`milestone prompt sha256 : ${m.milestonePromptSha256}`,
		`environment   : model ${m.environment.modelKey} | thinking ${m.environment.thinkingLevel} (frozen P3 environment — enforced for every assistant run)`,
		`p0 reference  : requests ${p0.commanderRequests} | gross tokens ${p0.commanderGrossTokens} | tool-result text bytes ${p0.toolResultTextBytes} (pinned; scale-incomparable with the short cohorts — P0 targets are NOT_MEASURABLE)`,
		`p3 reference  : pre requests ${p3.preTotalRequests} | current requests ${p3.currentTotalRequests} | reduction ${p3.requestReductionRatio === null ? "n/a" : p3.requestReductionRatio.toFixed(4)} | verdict ${p3.verdict} (preserved historical fact — reported by P9; exact frozen rule enforced)`,
		"",
		"per-run facts (every declared run retained; session/prompt hashes and environment enforced):",
	];
	for (const run of report.runs) {
		const label = boundedDisplay(run.label, LABEL_MAX_BYTES).text;
		const model = boundedDisplay(run.modelKeys.length > 0 ? run.modelKeys.join(",") : "(none)", MODEL_KEY_MAX_BYTES).text;
		const thinking = run.thinkingLevel === null ? "n/a" : boundedDisplay(run.thinkingLevel, THINKING_MAX_BYTES).text;
		lines.push(
			`  ${label.padEnd(34)} [${run.cohort}] requests ${run.requests} | gross ${run.gross} | inline bytes ${run.successfulTextBytes}/${run.totalTextBytes} succ/total | compactions ${run.compactions} | cost $${run.cost.toFixed(6)} | model ${model} | thinking ${thinking} | session ${boundedDisplay(run.sessionBasename, BASENAME_MAX_BYTES).text} | sha256 ${run.sessionSha256}`,
		);
	}
	lines.push("", "cohort totals:");
	lines.push(`  ${renderTotalsLine("baseline", report.cohorts.baseline)}`);
	lines.push(`  ${renderTotalsLine("current", report.cohorts.current)}`);
	lines.push("", "targets — P0 references (pinned long-session facts; basis-incomparable with the short cohorts — every strict P0 target is always NOT_MEASURABLE):");
	for (const target of report.targets.p0Reference) {
		lines.push(`  ${target.metricLabel.padEnd(42)} ${target.status} — ${target.reason}`);
	}
	lines.push(
		"",
		`targets — comparable-milestone arithmetic (equal-size cohort totals: ${m.baselineSessionCount} preserved P3 pre sessions vs ${m.currentSessionCount} fresh final-current sessions; historical non-causal control arithmetic, NOT strict P0 measurement):`,
	);
	for (const target of report.targets.comparableCohort) {
		lines.push(`  ${target.metricLabel.padEnd(42)} ${target.status} — ${target.reason}`);
	}
	lines.push(
		"privacy : this output carries hashes, labels, basenames, counts and numeric facts only — never message bodies, tool arguments, raw tool-result content, secrets, or absolute paths",
	);
	return applyCaps(lines, HUMAN_MAX_LINES, HUMAN_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(): string {
	return [
		"commander-token-benchmark — offline P9 benchmark-preparation analyzer (machine facts only)",
		"",
		"usage:",
		"  tsx scripts/commander-token-benchmark.ts <manifest.json> [--json]",
		"",
		"reads only: the strict JSON manifest (frozen P9 protocol, schema_version 1) and the six declared Pi Session JSONL files (relative paths)",
		"never: model calls, network, provider/cache/session state, file writes, or absolute paths in output",
	].join("\n");
}

export async function main(argv: readonly string[]): Promise<number> {
	const args = [...argv];
	const manifestArg = args[0];
	if (manifestArg === undefined) {
		process.stderr.write(`${usage()}\n`);
		return 2;
	}
	if (manifestArg === "--help" || manifestArg === "-h") {
		process.stdout.write(`${usage()}\n`);
		return 0;
	}
	const unknown = args.slice(1).filter((a) => a !== "--json");
	if (unknown.length > 0) {
		process.stderr.write(`commander-token-benchmark: unknown option(s): ${unknown.join(", ")}\n${usage()}\n`);
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
		if (error instanceof BenchmarkError) {
			process.stderr.write(`commander-token-benchmark: ${error.code}: ${error.message}\n`);
		} else {
			process.stderr.write("commander-token-benchmark: unexpected failure (details withheld — see privacy boundary)\n");
		}
		return 1;
	}
}

// Run only when executed directly (npm run commander:benchmark).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const exitCode = await main(process.argv.slice(2));
	process.exit(exitCode);
}
