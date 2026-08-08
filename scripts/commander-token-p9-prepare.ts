#!/usr/bin/env tsx
/**
 * P9 evidence preparation CLI (commander-token-optimization plan, Slice E
 * P9 prep) — OFFLINE, machine facts only. The commander has already
 * selected eleven immutable source Pi Session JSONL files: eight disclosed
 * invalid collection attempts (invalid-1..invalid-8, fixed chronological
 * order) followed by three corrected final-current sessions
 * (final-current-1..final-current-3). This tool:
 *
 *   1. PREFLIGHTS everything read-only first: the 11 sources (distinct
 *      realpaths, regular files, bounded size, strict JSONL parse) AND the
 *      preserved P3 pre-session evidence (byte-identity against the frozen
 *      pinned hashes, single safe session file per pre-N directory) —
 *      nothing is written until every input is fully validated;
 *   2. derives privacy-safe deviations metadata for the eight invalid
 *      attempts (label, runs-relative path, basename, raw SHA-256,
 *      extracted prompt SHA-256, bounded machine-derived terminal/stop/
 *      aborted facts, fixed reason category) and machine-verifies each
 *      attempt against the FIXED category/aborted expectations — fail
 *      closed on any mismatch (never message bodies, tool arguments,
 *      thinking, absolute paths or raw content);
 *   3. prevalidates the three corrected sessions with the frozen
 *      benchmark semantics (FROZEN_PROTOCOL via computeRunFacts:
 *      prompt hash, provider/model openai-codex/gpt-5.6-sol, thinking
 *      high) plus zero compactions and a terminal assistant stop response
 *      (not aborted/error);
 *   4. stages byte-exact copies under a staging directory, verifies the
 *      staged bytes, then commits with EXCLUSIVE ownership primitives:
 *      the final evidence directory
 *      `.pi/workbench/runs/commander-token-p9-benchmark/` (invalid
 *      attempts under invalid-attempts/invalid-N/, corrected sessions
 *      under sessions/final-current-N/, collection-deviations.json) is
 *      reserved with a NON-recursive mkdir — EEXIST fails on any
 *      pre-existing or racing output, including a racing EMPTY foreign
 *      directory that a rename could otherwise have replaced — ownership
 *      is marked immediately, and the staged children are moved into
 *      that invocation-owned directory; the strict manifest
 *      `.pi/workbench/runs/commander-token-p9-manifest.json` (frozen
 *      P0/P3 references, pinned baseline entries/hashes, corrected
 *      current entries with collection-time hashes — paths relative to
 *      `.pi/workbench/runs`) is created with an exclusive open("wx"),
 *      which fails with EEXIST on any pre-existing or racing foreign
 *      manifest file that a rename could otherwise have replaced.
 *
 * Fail-closed guarantees: an existing final P9 evidence directory or
 * manifest is refused (never overwritten — only ENOENT means absent,
 * every other stat failure fails closed); the commit itself never
 * replaces a foreign path (the exclusive creates refuse racing outputs
 * atomically); any preflight/stage/verify/commit failure leaves NO
 * partial final evidence (staging is removed, and ONLY the outputs this
 * invocation established ownership of are rolled back — the
 * exclusively-created evidence directory and the exclusively-created
 * manifest, each removed only while still this invocation's
 * (inode-verified), so a pre-existing/racing foreign output is never
 * deleted); the generated manifest is round-tripped through the frozen
 * analyzer's strict parseManifest before anything is committed.
 *
 * This tool never writes a P9 result, phase PASS, release verdict, plan
 * status, CHANGELOG entry, or publication claim.
 *
 * usage:
 *   tsx scripts/commander-token-p9-prepare.ts <invalid-1> ... <invalid-8> \
 *       <final-current-1> <final-current-2> <final-current-3> [--runs-dir <dir>]
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	BENCHMARK_SCHEMA_VERSION,
	FROZEN_PROTOCOL,
	PROTOCOL_DOC,
	SESSION_MAX_BYTES,
	BenchmarkError,
	computeRunFacts,
	extractPromptText,
	parseManifest,
	parseSessionLines,
	sha256Hex,
	type BenchmarkManifest,
	type FrozenProtocol,
	type ManifestSession,
} from "./commander-token-benchmark.ts";

// ---------------------------------------------------------------------------
// Fixed collection-order constants (the commander-selected immutable order)
// ---------------------------------------------------------------------------

/** Fixed chronological order of the eight disclosed invalid collection attempts. */
export const INVALID_LABELS = [
	"invalid-1",
	"invalid-2",
	"invalid-3",
	"invalid-4",
	"invalid-5",
	"invalid-6",
	"invalid-7",
	"invalid-8",
] as const;

/** Fixed labels of the three corrected final-current sessions. */
export const FINAL_CURRENT_LABELS = ["final-current-1", "final-current-2", "final-current-3"] as const;

export const SOURCE_COUNT = INVALID_LABELS.length + FINAL_CURRENT_LABELS.length; // exactly 11

/** Final P9 evidence directory name, relative to the runs root. */
export const P9_EVIDENCE_DIR = "commander-token-p9-benchmark";
/** Final strict manifest file name, relative to the runs root. */
export const P9_MANIFEST_NAME = "commander-token-p9-manifest.json";
/** Privacy-safe deviations record name, inside the P9 evidence directory. */
export const DEVIATIONS_NAME = "collection-deviations.json";
/** Preserved P3 evidence directory name, relative to the runs root. */
export const P3_EVIDENCE_DIR = "commander-token-p3-benchmark";

export const DEVIATIONS_SCHEMA_VERSION = 1;
export const PREPARE_PROTOCOL_DOC = PROTOCOL_DOC;

// ---------------------------------------------------------------------------
// Fixed deviation categories and aborted expectations (frozen per slice)
// ---------------------------------------------------------------------------

export type InvalidCategory = "literal_path_prompt" | "whitespace_corrupted_prompt";

export interface InvalidExpectation {
	category: InvalidCategory;
	/** invalid-4 and invalid-5 are the ONLY invalid attempts recorded as aborted. */
	aborted: boolean;
}

/**
 * The fixed category/aborted table for the eight invalid attempts:
 * invalid-1..3 literal-path prompt; invalid-4..8 whitespace-corrupted
 * prompt; invalid-4 and invalid-5 are additionally aborted. Every
 * attempt is machine-verified against this exact table and fails closed
 * otherwise.
 */
export const INVALID_EXPECTATIONS: Readonly<Record<string, InvalidExpectation>> = {
	"invalid-1": { category: "literal_path_prompt", aborted: false },
	"invalid-2": { category: "literal_path_prompt", aborted: false },
	"invalid-3": { category: "literal_path_prompt", aborted: false },
	"invalid-4": { category: "whitespace_corrupted_prompt", aborted: true },
	"invalid-5": { category: "whitespace_corrupted_prompt", aborted: true },
	"invalid-6": { category: "whitespace_corrupted_prompt", aborted: false },
	"invalid-7": { category: "whitespace_corrupted_prompt", aborted: false },
	"invalid-8": { category: "whitespace_corrupted_prompt", aborted: false },
};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type PrepareErrorCode =
	| "ARITY"
	| "EXISTING_OUTPUT"
	| "SOURCE_UNREADABLE"
	| "SOURCE_NOT_REGULAR"
	| "SOURCE_OVER_BOUND"
	| "DUPLICATE_SOURCE"
	| "BASENAME_UNSAFE"
	| "INVALID_LABEL"
	| "PROMPT_NOT_MISMATCHED"
	| "CATEGORY_MISMATCH"
	| "TERMINAL_MISMATCH"
	| "COMPACTION_PRESENT"
	| "NOT_TERMINAL_STOP"
	| "ABORTED"
	| "ERRORED"
	| "BASELINE_MISSING"
	| "BASELINE_AMBIGUOUS"
	| "BASELINE_HASH_MISMATCH"
	| "MANIFEST_INVALID"
	| "STAGE_VERIFY"
	| "IO_ERROR";

/** Structured preparation failure — fail closed, never partial final evidence. */
export class PrepareError extends Error {
	readonly code: PrepareErrorCode;
	constructor(code: PrepareErrorCode, message: string) {
		super(message);
		this.name = "PrepareError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Bounded identity constants (mirror the analyzer's output-facing rules)
// ---------------------------------------------------------------------------

/**
 * Mirrors the analyzer's BASENAME_RE (scripts/commander-token-benchmark.ts)
 * — every copied basename must be a bounded safe file name because it
 * becomes an output-facing identity string in the manifest. The generated
 * manifest is additionally round-tripped through the analyzer's
 * parseManifest, which re-enforces this exact rule.
 */
const SAFE_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Pi session assistant stop reasons (session-format.md; frozen semantics). */
const KNOWN_STOP_REASONS = ["stop", "length", "toolUse", "error", "aborted"] as const;
/** Known Pi session entry types — identity facts are bounded to this set. */
const KNOWN_ENTRY_TYPES = ["session", "session_info", "model_change", "thinking_level_change", "message", "compaction", "branch_summary", "custom"] as const;
/** Known Pi message roles — identity facts are bounded to this set. */
const KNOWN_MESSAGE_ROLES = ["user", "assistant", "toolResult"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Fail-closed filesystem classification
// ---------------------------------------------------------------------------

/**
 * The errno code of a filesystem failure (undefined for non-FS failures).
 * ONLY "ENOENT" means a path is ABSENT: every other failure (EACCES,
 * EPERM, ENOTDIR, ELOOP, EIO, ...) leaves the path state undetermined and
 * the operation must fail closed instead of assuming the clean absent
 * state — an unreadable existing output must never be treated as absent
 * (that could overwrite or delete it later).
 */
function fsErrorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

function isAbsentError(error: unknown): boolean {
	return fsErrorCode(error) === "ENOENT";
}

/**
 * Refuse to proceed when a final output already exists. Only ENOENT
 * (absent) is the clean state; a permission or any other stat failure
 * fails closed with IO_ERROR because the output may exist unreadable.
 */
async function assertOutputAbsent(path: string, label: string): Promise<void> {
	try {
		await stat(path);
	} catch (error) {
		if (isAbsentError(error)) return;
		throw new PrepareError("IO_ERROR", `${label} ${basename(path)} cannot be inspected (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed: only ENOENT means absent`);
	}
	throw new PrepareError("EXISTING_OUTPUT", `${label} ${basename(path)} already exists under the runs root — refusing to overwrite`);
}

// ---------------------------------------------------------------------------
// Pure prompt-deviation classification
// ---------------------------------------------------------------------------

/**
 * Collapse every whitespace run to a single space and trim. Used to detect
 * whitespace-corrupted prompts WITHOUT persisting or rendering any prompt
 * content: two texts are whitespace-equivalent exactly when their
 * normalized forms are identical.
 */
export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * The single fixed project-relative milestone-prompt path literal. The
 * disclosed invalid-1..3 attempts each replace the milestone prompt with
 * EXACTLY this one project-relative literal (a "point me at the milestone
 * prompt file" attempt) — never an absolute path. The literal-path
 * category is recognized ONLY for this exact literal, so unrelated text
 * (absolute paths, quoted paths, instructions that merely mention the
 * path, any other path) is rejected and fails closed.
 */
export const MILESTONE_PROMPT_PATH_LITERAL = ".pi/workbench/runs/commander-token-p3-benchmark/milestone-prompt.txt";

/**
 * Exact/safe single relative-path prompt semantics: true exactly when the
 * observed prompt text IS the single fixed project-relative milestone-
 * prompt path literal (up to surrounding whitespace, collapsed by the
 * same normalization used for the whitespace-corrupted category). The
 * whole prompt must be that one literal — the path embedded in any other
 * text, quoted, prefixed ("." or "/") or followed by anything is NOT a
 * literal-path prompt.
 */
export function isLiteralPathPrompt(text: string): boolean {
	return normalizeWhitespace(text) === MILESTONE_PROMPT_PATH_LITERAL;
}

/**
 * Classify the observed prompt deviation of an invalid attempt against
 * the milestone prompt text (extracted from the validated corrected
 * session). Returns null when the observed text supports neither fixed
 * category — the caller fails closed.
 */
export function promptMismatchKind(promptText: string, milestonePromptText: string): InvalidCategory | null {
	if (normalizeWhitespace(promptText) === normalizeWhitespace(milestonePromptText)) return "whitespace_corrupted_prompt";
	if (isLiteralPathPrompt(promptText)) return "literal_path_prompt";
	return null;
}

// ---------------------------------------------------------------------------
// Bounded machine-derived terminal facts (never raw content)
// ---------------------------------------------------------------------------

export interface TerminalFacts {
	messageCount: number;
	assistantMessageCount: number;
	compactionCount: number;
	/** Type of the last entry, bounded to the known Pi entry-type set (null when unbound). */
	lastEntryType: string | null;
	/** Role of the last message entry, bounded to the known Pi roles (null when none/unbound). */
	lastMessageRole: string | null;
	/** stopReason of the last assistant message, bounded to the known Pi stop reasons (null when none/unbound). */
	lastAssistantStopReason: string | null;
	/** The last message entry is an assistant message whose stopReason is exactly "stop". */
	terminalStop: boolean;
	/** The last assistant message's stopReason is "aborted". */
	aborted: boolean;
	/** The last assistant message's stopReason is "error". */
	errored: boolean;
}

/**
 * Derive bounded, privacy-safe terminal facts from strictly parsed session
 * entries. Only counts and identity values from the fixed known sets are
 * ever surfaced; unknown identity strings become null (fail-closed toward
 * "no claim").
 */
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

// ---------------------------------------------------------------------------
// Pure derivation of invalid-attempt deviations and corrected sessions
// ---------------------------------------------------------------------------

export interface PreparedInvalidAttempt {
	label: string;
	category: InvalidCategory;
	aborted: boolean;
	/** Runs-relative copied path (forward slashes, no absolute paths). */
	path: string;
	basename: string;
	rawSha256: string;
	promptSha256: string;
	terminal: TerminalFacts;
}

export interface PreparedCurrentSession {
	label: string;
	/** Runs-relative copied path (forward slashes, no absolute paths). */
	path: string;
	basename: string;
	rawSha256: string;
	promptSha256: string;
	requests: number;
	compactions: number;
	terminal: TerminalFacts;
}

/** Runs-relative copied path for an invalid attempt. */
export function invalidAttemptPath(label: string, basename: string): string {
	return `${P9_EVIDENCE_DIR}/invalid-attempts/${label}/${basename}`;
}

/** Runs-relative copied path for a corrected final-current session. */
export function currentSessionPath(label: string, basename: string): string {
	return `${P9_EVIDENCE_DIR}/sessions/${label}/${basename}`;
}

/**
 * Derive the privacy-safe deviations record for one invalid attempt and
 * machine-verify it against the FIXED category/aborted expectation table.
 * Fail-closed conditions (PrepareError):
 *   - the extracted prompt hash must DIFFER from the frozen milestone
 *     prompt hash (PROMPT_NOT_MISMATCHED) — an "invalid" attempt that
 *     reproduces the milestone prompt cannot be classified as a disclosed
 *     deviation;
 *   - the observed prompt deviation kind must equal the fixed category
 *     (CATEGORY_MISMATCH) — observed facts must support the category;
 *   - the observed aborted fact must equal the fixed expectation
 *     (TERMINAL_MISMATCH) — invalid-4 and invalid-5 must be
 *     machine-observably aborted and every other attempt must not be.
 * Only the bounded record fields below are produced — never message
 * bodies, tool arguments, thinking, absolute paths or raw content.
 */
export function deriveInvalidAttempt(
	label: string,
	entries: readonly unknown[],
	milestonePromptText: string,
	milestonePromptSha256: string,
	basename: string,
	rawSha256: string,
): PreparedInvalidAttempt {
	const expected = INVALID_EXPECTATIONS[label];
	if (!expected) throw new PrepareError("INVALID_LABEL", `unknown invalid-attempt label "${label}"`);
	const promptText = extractPromptText(entries); // BenchmarkError MISSING_USER_MESSAGE fails closed
	const promptSha256 = sha256Hex(promptText);
	if (promptSha256 === milestonePromptSha256) {
		throw new PrepareError(
			"PROMPT_NOT_MISMATCHED",
			`invalid attempt "${label}": extracted prompt hash equals the frozen milestone prompt hash — the observed facts do not record a disclosed prompt deviation`,
		);
	}
	const kind = promptMismatchKind(promptText, milestonePromptText);
	if (kind !== expected.category) {
		throw new PrepareError(
			"CATEGORY_MISMATCH",
			`invalid attempt "${label}": observed prompt deviation (${kind ?? "none"}) does not support the fixed category "${expected.category}"`,
		);
	}
	const terminal = terminalStateOf(entries);
	if (terminal.aborted !== expected.aborted) {
		throw new PrepareError(
			"TERMINAL_MISMATCH",
			`invalid attempt "${label}": observed aborted=${terminal.aborted} does not match the fixed expectation aborted=${expected.aborted}`,
		);
	}
	return {
		label,
		category: expected.category,
		aborted: expected.aborted,
		path: invalidAttemptPath(label, basename),
		basename,
		rawSha256,
		promptSha256,
		terminal,
	};
}

/**
 * Prevalidate one corrected final-current session with the EXISTING frozen
 * benchmark semantics (computeRunFacts/parseSessionLines/FROZEN_PROTOCOL):
 * exact milestone prompt hash, every assistant message on the pinned
 * provider/model key (openai-codex/gpt-5.6-sol), recorded thinking level
 * exactly "high", bounded usage facts. On top of the frozen semantics the
 * corrected cohort additionally requires:
 *   - zero compactions (COMPACTION_PRESENT);
 *   - a terminal assistant stop response — the last message entry is an
 *     assistant message with stopReason "stop" (NOT_TERMINAL_STOP);
 *   - not aborted / not errored (ABORTED / ERRORED).
 * computeRunFacts failures surface as BenchmarkError (PROMPT_MISMATCH,
 * MODEL_MISMATCH, THINKING_MISMATCH, MISSING_*).
 */
export function deriveCurrentSession(
	label: string,
	entries: readonly unknown[],
	basename: string,
	rawSha256: string,
	protocol: FrozenProtocol = FROZEN_PROTOCOL,
): PreparedCurrentSession {
	const facts = computeRunFacts(
		label,
		"current",
		basename,
		rawSha256,
		entries,
		protocol.milestonePromptSha256,
		protocol.environment.modelKey,
		protocol.environment.thinkingLevel,
	);
	const terminal = terminalStateOf(entries);
	if (facts.compactions !== 0) {
		throw new PrepareError("COMPACTION_PRESENT", `final-current session "${label}": ${facts.compactions} compaction(s) — the corrected cohort requires zero compactions`);
	}
	if (terminal.aborted) {
		throw new PrepareError("ABORTED", `final-current session "${label}": terminal assistant response is aborted — the corrected cohort requires a completed stop response`);
	}
	if (terminal.errored) {
		throw new PrepareError("ERRORED", `final-current session "${label}": terminal assistant response errored — the corrected cohort requires a completed stop response`);
	}
	if (!terminal.terminalStop) {
		throw new PrepareError(
			"NOT_TERMINAL_STOP",
			`final-current session "${label}": no terminal assistant stop response (last message role ${terminal.lastMessageRole ?? "none"}, last assistant stop reason ${terminal.lastAssistantStopReason ?? "none"})`,
		);
	}
	return {
		label,
		path: currentSessionPath(label, basename),
		basename,
		rawSha256: facts.sessionSha256,
		promptSha256: facts.promptSha256,
		requests: facts.requests,
		compactions: facts.compactions,
		terminal,
	};
}

// ---------------------------------------------------------------------------
// Persisted documents (strict shapes)
// ---------------------------------------------------------------------------

/** collection-deviations.json — privacy-safe deviations record. */
export interface DeviationsDocument {
	schema_version: number;
	protocol_doc: string;
	milestone_prompt_sha256: string;
	invalid_attempts: PreparedInvalidAttempt[];
}

/** Serialize the strict manifest (snake_case on-disk schema, protocol §3.2). */
export function manifestToJson(manifest: BenchmarkManifest): string {
	const p0 = manifest.p0Reference;
	const p3 = manifest.p3Reference;
	return (
		JSON.stringify(
			{
				schema_version: manifest.schemaVersion,
				milestone_prompt_sha256: manifest.milestonePromptSha256,
				environment: {
					model_key: manifest.environment.modelKey,
					thinking_level: manifest.environment.thinkingLevel,
				},
				p0_reference: {
					commander_requests: p0.commanderRequests,
					commander_input_tokens: p0.commanderInputTokens,
					commander_output_tokens: p0.commanderOutputTokens,
					commander_cache_read_tokens: p0.commanderCacheReadTokens,
					commander_cache_write_tokens: p0.commanderCacheWriteTokens,
					commander_gross_tokens: p0.commanderGrossTokens,
					tool_result_text_bytes: p0.toolResultTextBytes,
				},
				p3_reference: {
					pre_total_requests: p3.preTotalRequests,
					current_total_requests: p3.currentTotalRequests,
					request_reduction_ratio: p3.requestReductionRatio,
					verdict: p3.verdict,
					rule: p3.rule,
				},
				sessions: manifest.sessions.map((s) => ({
					label: s.label,
					cohort: s.cohort,
					path: s.path,
					expected_session_sha256: s.expectedSessionSha256,
				})),
			},
			null,
			2,
		) + "\n"
	);
}

// ---------------------------------------------------------------------------
// Preflight (read-only) helpers
// ---------------------------------------------------------------------------

interface BaselinePreflight {
	label: string;
	basename: string;
	sha256: string;
}

/**
 * Preflight the preserved P3 pre-session evidence under the runs root:
 * each pre-N directory must contain exactly one regular session file whose
 * basename is a bounded safe name, whose size is bounded and whose raw
 * bytes hash EXACTLY to the frozen pinned preserved P3 hash. This verifies
 * the byte-identity of the baseline evidence at collection time so the
 * manifest's pinned baseline entries point at intact files (the analyzer
 * re-verifies at benchmark time).
 */
export async function preflightBaselineSessions(runsDir: string, protocol: FrozenProtocol = FROZEN_PROTOCOL): Promise<BaselinePreflight[]> {
	const out: BaselinePreflight[] = [];
	for (const label of Object.keys(protocol.pinnedPreSessions)) {
		const dir = join(runsDir, P3_EVIDENCE_DIR, "sessions", label);
		let names: string[];
		try {
			names = await readdir(dir);
		} catch (error) {
			if (!isAbsentError(error)) {
				throw new PrepareError("IO_ERROR", `preserved P3 pre session "${label}" evidence directory cannot be inspected (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed: only ENOENT means absent`);
			}
			throw new PrepareError("BASELINE_MISSING", `preserved P3 pre session "${label}" evidence directory is missing`);
		}
		const files: Array<{ name: string; full: string }> = [];
		for (const name of names) {
			const full = join(dir, name);
			let info;
			try {
				info = await stat(full);
			} catch (error) {
				if (!isAbsentError(error)) {
					throw new PrepareError("IO_ERROR", `preserved P3 pre session "${label}" entry "${name}" cannot be inspected (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed`);
				}
				throw new PrepareError("BASELINE_MISSING", `preserved P3 pre session "${label}" entry "${name}" is missing`);
			}
			if (info.isFile()) files.push({ name, full });
		}
		if (files.length === 0) {
			throw new PrepareError("BASELINE_MISSING", `preserved P3 pre session "${label}" evidence directory contains no session file`);
		}
		if (files.length !== 1) {
			throw new PrepareError("BASELINE_AMBIGUOUS", `preserved P3 pre session "${label}" evidence directory contains ${files.length} files — exactly one session file is expected`);
		}
		const file = files[0] as { name: string; full: string };
		if (!SAFE_BASENAME_RE.test(file.name) || !file.name.endsWith(".jsonl")) {
			throw new PrepareError("BASENAME_UNSAFE", `preserved P3 pre session "${label}" basename is not a bounded safe session file name`);
		}
		let info;
		try {
			info = await stat(file.full);
		} catch (error) {
			if (!isAbsentError(error)) {
				throw new PrepareError("IO_ERROR", `preserved P3 pre session "${label}" file cannot be inspected (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed`);
			}
			throw new PrepareError("BASELINE_MISSING", `preserved P3 pre session "${label}" file is missing`);
		}
		if (info.size > SESSION_MAX_BYTES) {
			throw new PrepareError("SOURCE_OVER_BOUND", `preserved P3 pre session "${label}" exceeds ${SESSION_MAX_BYTES} bytes`);
		}
		let raw: Buffer;
		try {
			raw = await readFile(file.full);
		} catch (error) {
			if (!isAbsentError(error)) {
				throw new PrepareError("IO_ERROR", `preserved P3 pre session "${label}" file could not be read (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed`);
			}
			throw new PrepareError("BASELINE_MISSING", `preserved P3 pre session "${label}" file is missing`);
		}
		const hash = sha256Hex(raw);
		const pinned = protocol.pinnedPreSessions[label];
		if (pinned === undefined || hash !== pinned) {
			throw new PrepareError("BASELINE_HASH_MISMATCH", `preserved P3 pre session "${label}" raw SHA-256 ${hash} does not match the pinned preserved P3 hash ${pinned ?? "(unset)"}`);
		}
		out.push({ label, basename: file.name, sha256: hash });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Full preparation pipeline (preflight -> stage -> verify -> commit)
// ---------------------------------------------------------------------------

export interface PrepareHooks {
	/**
	 * TEST SEAM ONLY — never used by the CLI. Invoked after staging is
	 * fully populated and byte-verified, immediately before the final
	 * output re-checks and the exclusive commits. Throwing here (or
	 * creating a racing foreign output) exercises the ownership-tracked
	 * rollback deterministically.
	 */
	beforeEvidenceCommit?: () => void | Promise<void>;
	/**
	 * TEST SEAM ONLY — invoked immediately after the final evidence
	 * directory was EXCLUSIVELY created (this invocation owns it), before
	 * the staged children are moved in. A failure here rolls back the
	 * owned-but-empty evidence directory.
	 */
	afterEvidenceReserve?: () => void | Promise<void>;
	/** TEST SEAM ONLY — invoked after the staged children moved into the owned evidence directory, before the manifest commit. */
	afterEvidenceCommit?: () => void | Promise<void>;
	/**
	 * TEST SEAM ONLY — invoked immediately after the manifest file was
	 * EXCLUSIVELY created with open("wx") (this invocation owns it),
	 * before the manifest bytes are written. A failure here rolls the
	 * owned manifest back even though the write never completed.
	 */
	afterManifestOpen?: () => void | Promise<void>;
	/** TEST SEAM ONLY — invoked after the manifest commit, before the post-commit verification read. */
	afterManifestCommit?: () => void | Promise<void>;
}

export interface PrepareOptions {
	/** Runs root (default `<cwd>/.pi/workbench/runs` at the CLI). */
	runsDir: string;
	/** Exactly 11 source paths in fixed chronological order (invalid-1..invalid-8, final-current-1..final-current-3). */
	sources: readonly string[];
	protocol?: FrozenProtocol;
	/** Test-only failure seams (documented above); absent in production runs. */
	hooks?: PrepareHooks;
}

export interface PrepareResult {
	/** Absolute path of the committed P9 evidence directory. */
	evidenceDir: string;
	/** Absolute path of the committed strict manifest. */
	manifestPath: string;
	manifest: BenchmarkManifest;
	deviations: DeviationsDocument;
	invalidAttempts: PreparedInvalidAttempt[];
	currentEntries: PreparedCurrentSession[];
}

interface PreflightedSource {
	label: string;
	basename: string;
	raw: Buffer;
	rawSha256: string;
	entries: unknown[];
}

/**
 * Read and fully preflight every input BEFORE any output is created:
 * existing-output refusal, preserved-P3 baseline byte-identity, then the
 * eleven sources (distinct realpaths, regular files, bounded size, safe
 * basenames, strict JSONL parse). All derivation happens in memory; only
 * then is a staging directory populated, byte-verified, and committed
 * with EXCLUSIVE create primitives (see the commit block below). Any
 * failure removes the staging directory and only the outputs this
 * invocation owns — never partial final evidence, never a foreign path.
 */
export async function prepareEvidence(options: PrepareOptions): Promise<PrepareResult> {
	const protocol = options.protocol ?? FROZEN_PROTOCOL;
	const hooks = options.hooks;
	const runsDir = resolve(options.runsDir);
	if (options.sources.length !== SOURCE_COUNT) {
		throw new PrepareError("ARITY", `exactly ${SOURCE_COUNT} source paths are required (8 invalid attempts + 3 final-current sessions), got ${options.sources.length}`);
	}
	const evidenceDirPath = join(runsDir, P9_EVIDENCE_DIR);
	const manifestPath = join(runsDir, P9_MANIFEST_NAME);

	// Refuse to overwrite existing final P9 evidence (before any read/write).
	// Only ENOENT means absent — permission/other stat failures fail closed.
	await assertOutputAbsent(evidenceDirPath, "P9 evidence directory");
	await assertOutputAbsent(manifestPath, "P9 manifest");

	// Preflight the preserved P3 baseline evidence (byte-identity vs pinned hashes).
	const baselines = await preflightBaselineSessions(runsDir, protocol);

	// Preflight the 11 sources in fixed chronological order.
	const preflighted: PreflightedSource[] = [];
	const seenRealPaths = new Set<string>();
	for (let i = 0; i < SOURCE_COUNT; i += 1) {
		const label = i < INVALID_LABELS.length ? (INVALID_LABELS[i] as string) : (FINAL_CURRENT_LABELS[i - INVALID_LABELS.length] as string);
		const source = options.sources[i] as string;
		let real: string;
		try {
			real = await realpath(source);
		} catch (error) {
			if (!isAbsentError(error)) {
				throw new PrepareError("IO_ERROR", `source "${label}" cannot be resolved (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed: only ENOENT means absent`);
			}
			throw new PrepareError("SOURCE_UNREADABLE", `source "${label}" is missing`);
		}
		if (seenRealPaths.has(real)) {
			throw new PrepareError("DUPLICATE_SOURCE", `source "${label}" duplicates another declared source (identical realpath — every source must be a distinct file)`);
		}
		seenRealPaths.add(real);
		let info;
		try {
			info = await stat(real);
		} catch (error) {
			if (!isAbsentError(error)) {
				throw new PrepareError("IO_ERROR", `source "${label}" (${basename(real)}) cannot be inspected (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed`);
			}
			throw new PrepareError("SOURCE_UNREADABLE", `source "${label}" (${basename(real)}) is missing`);
		}
		if (!info.isFile()) {
			throw new PrepareError("SOURCE_NOT_REGULAR", `source "${label}" (${basename(real)}) is not a regular file`);
		}
		if (info.size > SESSION_MAX_BYTES) {
			throw new PrepareError("SOURCE_OVER_BOUND", `source "${label}" (${basename(real)}) exceeds ${SESSION_MAX_BYTES} bytes`);
		}
		const safeName = basename(real);
		if (!SAFE_BASENAME_RE.test(safeName)) {
			throw new PrepareError("BASENAME_UNSAFE", `source "${label}" basename is not a bounded safe file name ([A-Za-z0-9][A-Za-z0-9._-]*, at most 128 chars)`);
		}
		let raw: Buffer;
		try {
			raw = await readFile(real);
		} catch (error) {
			if (!isAbsentError(error)) {
				throw new PrepareError("IO_ERROR", `source "${label}" (${safeName}) could not be read (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed`);
			}
			throw new PrepareError("SOURCE_UNREADABLE", `source "${label}" (${safeName}) is missing`);
		}
		const entries = parseSessionLines(raw.toString("utf8"), label); // BenchmarkError MALFORMED_JSONL/OVER_BOUND fails closed
		preflighted.push({ label, basename: safeName, raw, rawSha256: sha256Hex(raw), entries });
	}

	// Derive the corrected sessions FIRST (frozen semantics validate the
	// milestone prompt hash), then use the validated milestone prompt text
	// to machine-verify the invalid-attempt deviation categories.
	const corrected = preflighted.slice(INVALID_LABELS.length);
	const currentEntries: PreparedCurrentSession[] = corrected.map((s) => deriveCurrentSession(s.label, s.entries, s.basename, s.rawSha256, protocol));
	const firstCorrected = corrected[0];
	if (!firstCorrected) throw new PrepareError("ARITY", "no corrected final-current session was supplied");
	const milestonePromptText = extractPromptText(firstCorrected.entries);
	const invalidAttempts: PreparedInvalidAttempt[] = preflighted.slice(0, INVALID_LABELS.length).map((s) =>
		deriveInvalidAttempt(s.label, s.entries, milestonePromptText, protocol.milestonePromptSha256, s.basename, s.rawSha256),
	);

	// Assemble the strict documents.
	const deviations: DeviationsDocument = {
		schema_version: DEVIATIONS_SCHEMA_VERSION,
		protocol_doc: PREPARE_PROTOCOL_DOC,
		milestone_prompt_sha256: protocol.milestonePromptSha256,
		invalid_attempts: invalidAttempts,
	};
	const manifest: BenchmarkManifest = {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		milestonePromptSha256: protocol.milestonePromptSha256,
		environment: { modelKey: protocol.environment.modelKey, thinkingLevel: protocol.environment.thinkingLevel },
		p0Reference: { ...protocol.p0Reference },
		p3Reference: { ...protocol.p3Reference },
		sessions: [
			...baselines.map(
				(b): ManifestSession => ({
					label: b.label,
					cohort: "baseline",
					path: `${P3_EVIDENCE_DIR}/sessions/${b.label}/${b.basename}`,
					expectedSessionSha256: b.sha256,
				}),
			),
			...currentEntries.map(
				(c): ManifestSession => ({
					label: c.label,
					cohort: "current",
					path: c.path,
					expectedSessionSha256: c.rawSha256,
				}),
			),
		],
	};

	// Round-trip the generated manifest through the frozen analyzer's
	// strict parser — the manifest is guaranteed analyzer-parseable before
	// anything is committed.
	const manifestJson = manifestToJson(manifest);
	try {
		parseManifest(manifestJson, protocol);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new PrepareError("MANIFEST_INVALID", `generated manifest failed the frozen analyzer's strict manifest validation: ${detail}`);
	}
	const deviationsJson = `${JSON.stringify(deviations, null, 2)}\n`;

	// Stage (writes go ONLY under the staging directory), verify, commit.
	const staging = join(runsDir, `.p9-prepare-staging-${randomUUID().slice(0, 8)}`);
	// The staged children moved into the final evidence directory. The
	// evidence directory itself is EXCLUSIVELY created (non-recursive
	// mkdir — EEXIST on any pre-existing or racing output, including a
	// racing EMPTY foreign directory that a rename could replace), so
	// every destination below lives inside a directory only this
	// invocation could have created: no foreign path is ever replaced.
	const evidenceChildren = ["invalid-attempts", "sessions", DEVIATIONS_NAME] as const;
	// Commit ownership: a final output is rolled back ONLY when THIS
	// invocation established ownership of it — the evidence directory via
	// its exclusive non-recursive mkdir (ownership marked immediately
	// after the exclusive create), the manifest via its exclusive
	// open("wx") (ownership marked after the successful open). Each owned
	// path is removed only while it is STILL this invocation's
	// (device+inode identity), so pre-existing/racing foreign outputs —
	// and foreign replacements of an owned path — are never deleted.
	let evidenceOwned = false;
	let manifestOwned = false;
	let evidenceDirStat: { dev: number; ino: number } | null = null;
	let manifestStat: { dev: number; ino: number } | null = null;
	try {
		await mkdir(staging, { recursive: true });
		for (const s of preflighted) {
			const dest = s.label.startsWith("invalid-") ? join(staging, "invalid-attempts", s.label, s.basename) : join(staging, "sessions", s.label, s.basename);
			await mkdir(dirname(dest), { recursive: true });
			await writeFile(dest, s.raw);
			const written = await readFile(dest);
			if (!written.equals(s.raw)) {
				throw new PrepareError("STAGE_VERIFY", `staged copy of source "${s.label}" is not byte-identical to the source file`);
			}
		}
		await writeFile(join(staging, DEVIATIONS_NAME), deviationsJson, "utf8");

		// Re-check BOTH final outputs immediately before the commits: a
		// racing foreign output that appeared since preflight is refused
		// (never overwritten). Only ENOENT means absent. The exclusive
		// creates below are the actual no-clobber guarantee — these
		// re-checks only classify the common pre-existing case early.
		await hooks?.beforeEvidenceCommit?.();
		await assertOutputAbsent(evidenceDirPath, "P9 evidence directory");
		await assertOutputAbsent(manifestPath, "P9 manifest");

		// Commit 1: EXCLUSIVELY reserve the final evidence directory. A
		// NON-recursive mkdir fails with EEXIST when ANY path (file or
		// directory — including a racing EMPTY foreign directory, which a
		// rename would silently replace) occupies the destination. Only
		// ENOENT-absence allows the create; ownership is marked immediately
		// after the exclusive create succeeds, and the identity of the
		// created directory is captured for the ownership-verified
		// rollback.
		try {
			await mkdir(evidenceDirPath);
		} catch (error) {
			if (fsErrorCode(error) === "EEXIST") {
				throw new PrepareError("EXISTING_OUTPUT", `P9 evidence directory ${basename(evidenceDirPath)} appeared during commit — refusing to overwrite`);
			}
			throw error;
		}
		evidenceOwned = true;
		const reservedStat = await stat(evidenceDirPath);
		evidenceDirStat = { dev: reservedStat.dev, ino: reservedStat.ino };
		await hooks?.afterEvidenceReserve?.();

		// Move the staged children into the invocation-owned directory.
		for (const child of evidenceChildren) {
			await rename(join(staging, child), join(evidenceDirPath, child));
		}
		await hooks?.afterEvidenceCommit?.();

		// Commit 2: the manifest via an EXCLUSIVE open ("wx") — EEXIST
		// means a pre-existing or racing foreign manifest occupies the
		// path and it is refused, never overwritten (a rename would
		// replace it). Ownership is marked only after the open succeeds;
		// the bytes are then written, synced and closed, and any failure —
		// including a failure while writing — rolls the owned manifest
		// back.
		try {
			await assertOutputAbsent(manifestPath, "P9 manifest");
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
				throw new PrepareError("EXISTING_OUTPUT", `P9 manifest ${basename(manifestPath)} appeared during commit — refusing to overwrite`);
			}
			throw error;
		}
		await hooks?.afterManifestCommit?.();
		const writtenManifest = await readFile(manifestPath, "utf8");
		if (writtenManifest !== manifestJson) {
			throw new PrepareError("STAGE_VERIFY", "committed manifest content is not byte-identical to the generated manifest");
		}
		// All staged children moved out — remove the empty staging
		// directory (owned by construction).
		await rmdir(staging).catch(() => {});
	} catch (error) {
		// Fail closed: remove the staging directory (owned by construction),
		// plus ONLY the final outputs this invocation established ownership
		// of. Each owned path is removed only while it is STILL this
		// invocation's (device+inode identity): the evidence directory's
		// known children are removed and the directory itself rmdir'ed (a
		// foreign entry that somehow appeared inside makes the rmdir fail
		// and survives); the manifest is unlinked only while it is still
		// the file the exclusive open created (so a pre-existing or racing
		// foreign manifest — or a foreign replacement of an owned path — is
		// never deleted).
		await rm(staging, { recursive: true, force: true }).catch(() => {});
		if (evidenceOwned && evidenceDirStat) {
			try {
				const now = await stat(evidenceDirPath);
				if (now.dev === evidenceDirStat.dev && now.ino === evidenceDirStat.ino) {
					for (const child of evidenceChildren) {
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

	return { evidenceDir: evidenceDirPath, manifestPath, manifest, deviations, invalidAttempts, currentEntries };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(): string {
	return [
		"commander-token-p9-prepare — offline P9 evidence preparation (machine facts only)",
		"",
		"usage:",
		`  tsx scripts/commander-token-p9-prepare.ts <invalid-1> ... <invalid-8> <final-current-1> <final-current-2> <final-current-3> [--runs-dir <dir>]`,
		"",
		"exactly 11 positional source paths, fixed chronological order:",
		"  invalid-1..invalid-8  the eight disclosed invalid collection attempts (Pi Session JSONL)",
		"  final-current-1..3    the three corrected final-current sessions (Pi Session JSONL)",
		"",
		"options:",
		"  --runs-dir <dir>   evidence/manifest runs root (default: <cwd>/.pi/workbench/runs)",
		"  -h, --help         show this help",
		"",
		"writes (fail-closed, staging + exclusive commit, refuses existing outputs):",
		`  ${P9_EVIDENCE_DIR}/ (11 raw sessions copied byte-for-byte + ${DEVIATIONS_NAME})`,
		`  ${P9_MANIFEST_NAME} (strict frozen-protocol manifest, paths relative to the runs root)`,
		"never: model calls, network, provider/cache/session state, message bodies, tool",
		"arguments, thinking, absolute paths or raw content in metadata/output",
	].join("\n");
}

interface CliArgs {
	help: boolean;
	/** null => usage error. */
	sources: string[] | null;
	runsDir: string;
}

export function parseArgs(argv: readonly string[]): CliArgs {
	let runsDir = join(process.cwd(), ".pi", "workbench", "runs");
	const sources: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string;
		if (arg === "--help" || arg === "-h") return { help: true, sources: null, runsDir };
		if (arg === "--runs-dir") {
			const value = argv[i + 1];
			if (value === undefined) return { help: false, sources: null, runsDir };
			runsDir = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("-")) return { help: false, sources: null, runsDir };
		sources.push(arg);
	}
	if (sources.length !== SOURCE_COUNT) return { help: false, sources: null, runsDir };
	return { help: false, sources, runsDir };
}

function renderSummary(result: PrepareResult): string[] {
	const lines = [
		"commander-token-p9-prepare: P9 evidence prepared (offline, machine facts only)",
		`  evidence dir : ${P9_EVIDENCE_DIR}/ (11 raw sessions copied byte-for-byte)`,
		`  deviations   : ${P9_EVIDENCE_DIR}/${DEVIATIONS_NAME} (8 invalid attempts retained)`,
		`  manifest     : ${P9_MANIFEST_NAME} (3 baseline / 3 current sessions; paths relative to the runs root)`,
	];
	for (const inv of result.invalidAttempts) {
		lines.push(`invalid-attempt ${inv.label} | category ${inv.category} | aborted ${inv.aborted} | raw ${inv.rawSha256} | prompt ${inv.promptSha256} | basename ${inv.basename}`);
	}
	for (const cur of result.currentEntries) {
		lines.push(`final-current ${cur.label} | requests ${cur.requests} | compactions ${cur.compactions} | terminal stop | session ${cur.rawSha256} | basename ${cur.basename}`);
	}
	lines.push("privacy : hashes, labels, basenames and bounded machine facts only — never message bodies, tool arguments, thinking, or absolute paths");
	return lines;
}

export async function main(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	if (args.help) {
		process.stdout.write(`${usage()}\n`);
		return 0;
	}
	if (args.sources === null) {
		process.stderr.write(`${usage()}\n`);
		return 2;
	}
	try {
		const result = await prepareEvidence({ runsDir: args.runsDir, sources: args.sources });
		for (const line of renderSummary(result)) process.stdout.write(`${line}\n`);
		return 0;
	} catch (error) {
		if (error instanceof PrepareError || error instanceof BenchmarkError) {
			process.stderr.write(`commander-token-p9-prepare: ${error.code}: ${error.message}\n`);
		} else {
			process.stderr.write("commander-token-p9-prepare: unexpected failure (details withheld — see privacy boundary)\n");
		}
		return 1;
	}
}

// Run only when executed directly (npm run commander:prepare).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const exitCode = await main(process.argv.slice(2));
	process.exit(exitCode);
}
