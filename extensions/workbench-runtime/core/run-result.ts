/**
 * Commander Slice B1 (commander-token-optimization plan P2 + P3): layered
 * workbench_read_run result renderer — pure, deterministic, unit-testable
 * with plain node:test.
 *
 * The parent toolResult for `workbench_read_run` is a LAYERED bounded
 * presentation of the persisted run record, never the raw run output:
 *
 *   - Summary layer: machine-derived run facts (run id, recipe, profile,
 *     mode, status, exit code, duration, started/finished, timed out,
 *     cancelled, git, execution source);
 *   - Evidence layer: artifact / evidence / declared-write paths (bounded
 *     lists with the EXACT omitted count), truncation facts, the REQUIRED
 *     logs/argv opt-in guidance line (raw content omitted + the exact
 *     `include=logs`/`include=all` instruction — its own required line,
 *     never only a tail of the truncatable aggregate), cache and
 *     quant-contract facts, omission facts (machine facts only);
 *   - Metadata layer (explicit `manifest` / `logs` / `all` includes only):
 *     cwd and argv from the manifest — NEVER in the default summary;
 *   - Persisted layer: durable project-relative paths to the run
 *     directory, manifest.json, summary.json, stdout.log and stderr.log,
 *     plus the machine-derived disclaimer;
 *   - Tail layer (explicit `logs` / `all` includes only): the existing
 *     caller-bounded stdout/stderr tails, appended verbatim — the
 *     renderer never reads logs and never re-bounds them.
 *
 * Defaults and caps:
 *   - the omitted `include` resolves to `summary` (the registered tool
 *     default changed from `all` to `summary` in Slice B1);
 *   - `summary` and `manifest` outputs are capped at <= 4096 UTF-8 bytes /
 *     40 lines (custom caps clamp to the documented safe bounds
 *     MIN_RUN_RESULT_CAPS .. MAX_RUN_RESULT_CAPS); the default summary
 *     NEVER inlines raw stdout/stderr, per-test lines, or argv;
 *   - `logs`/`all` outputs append only the existing caller-bounded tails
 *     (readLogSnippet's max_lines/max_bytes, schema-bounded) after the
 *     same metadata block; no global cap applies to the tails — they are
 *     already bounded by the caller's snippet caps.
 *
 * GUARANTEED-FIT POLICY (total over every defensive input):
 *   - every untrusted manifest field is sanitized (control characters —
 *     including newlines — are replaced, so a field can never inject
 *     extra lines) and bounded to a documented UTF-8 byte budget,
 *     code-point safe (a code point is never split) and deterministic,
 *     always with an explicit omission fact;
 *   - lists that are too large render a bounded number of items plus the
 *     EXACT omitted count (never an overflowing join, never a silent
 *     drop);
 *   - optional cache/quant facts that cannot fit the resolved caps are
 *     dropped deterministically (lowest priority first) and RECORDED in
 *     the aggregate — omission reporting never silently loses machine
 *     facts; bounded/truncated metadata/path/list displays carry an
 *     explicit durable-source fact (manifest.json / run record / disk),
 *     precomputed BEFORE the aggregate is emitted, so bounding is never
 *     discovered only after the omissions line;
 *   - the required-fact block is bounded by construction and always fits
 *     the safe minima, so the emitted `summary`/`manifest` output ALWAYS
 *     satisfies the resolved caps — `withinCaps` is always true; a
 *     defensive minimal fallback exists for unreachable pathological
 *     states and still fits the minima;
 *   - malformed values (non-string fields, non-array lists, non-finite
 *     numbers) render defensively ("(invalid)", "(none)", "?") and never
 *     throw.
 *
 * This module NEVER reads files, NEVER claims acceptance, and NEVER
 * rewrites persisted records — full logs/records stay on disk, byte-for-
 * byte unchanged, and are always referenced by project-relative path.
 *
 * Read-only batching classifier (P3): `INDEPENDENT_READ_ONLY_ALLOWLIST`
 * is the deterministic, explicit allowlist of tools that MAY be batched
 * as known-independent read-only calls in one host parallel turn (the
 * model decides independence for its concrete calls — the classifier
 * never infers it and never inspects arguments). It contains exactly
 * read/grep/find/ls and workbench_project_inspect / workbench_read_run /
 * workbench_read_gate / workbench_list_gates / workbench_compare_runs.
 * Execution, review, delegation and write tools (workbench_run_recipe,
 * workbench_run_gate, workbench_delegate_worker,
 * workbench_review_worker_diff, workbench_delegation_status, bash, edit,
 * write) are never classified. The single static prompt guideline in
 * core/tool-catalog.ts mirrors this list; the classifier is
 * machine-checkable, the guideline is prose.
 */

import { truncateUtf8Bytes, utf8Bytes } from "./result-summary.ts";
import { encodeContinuationCursor, type RunLogCursorPayloadV1 } from "./continuation-cursor.ts";
import type { RunLogPage, RunLogPageStream, RunRecord } from "./runs.ts";

// ---------------------------------------------------------------------------
// Include modes and caps
// ---------------------------------------------------------------------------

export type RunResultInclude = "summary" | "manifest" | "logs" | "all";

/** True for exactly the four declared include modes (never infers). */
export function isRunResultInclude(value: unknown): value is RunResultInclude {
	return value === "summary" || value === "manifest" || value === "logs" || value === "all";
}

export interface RunResultCaps {
	maxBytes: number;
	maxLines: number;
}

/** Slice B1 presentation caps (starting values; configurable within safe bounds). */
export const DEFAULT_RUN_RESULT_CAPS: RunResultCaps = Object.freeze({ maxBytes: 4096, maxLines: 40 });

/**
 * Documented safe MINIMUM caps: the smallest values that can always hold
 * the required-fact block (summary + evidence + persisted layers) for the
 * most adversarial defensive input, because every field is bounded and
 * every list shows bounded items plus the exact omitted count.
 */
export const MIN_RUN_RESULT_CAPS: RunResultCaps = Object.freeze({ maxBytes: 3584, maxLines: 32 });

/** Documented safe MAXIMUM caps (a run summary is presentation, never unbounded). */
export const MAX_RUN_RESULT_CAPS: RunResultCaps = Object.freeze({ maxBytes: 8192, maxLines: 80 });

/**
 * Resolve effective caps, deterministically:
 *   - malformed values (non-number, NaN/±Infinity, negative) fall back to
 *     the DEFAULT caps;
 *   - valid values clamp to the documented safe bounds
 *     (MIN_RUN_RESULT_CAPS .. MAX_RUN_RESULT_CAPS), so the
 *     guaranteed-fit invariants stay satisfiable for every input;
 *   - fractional values floor to whole units.
 */
export function resolveRunResultCaps(caps?: Partial<RunResultCaps>): RunResultCaps {
	const pick = (value: number | undefined, fallback: number, min: number, max: number): number => {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
		return Math.min(max, Math.max(min, Math.floor(value)));
	};
	return {
		maxBytes: pick(caps?.maxBytes, DEFAULT_RUN_RESULT_CAPS.maxBytes, MIN_RUN_RESULT_CAPS.maxBytes, MAX_RUN_RESULT_CAPS.maxBytes),
		maxLines: pick(caps?.maxLines, DEFAULT_RUN_RESULT_CAPS.maxLines, MIN_RUN_RESULT_CAPS.maxLines, MAX_RUN_RESULT_CAPS.maxLines),
	};
}

// ---------------------------------------------------------------------------
// Field budgets (all MAX_*_CHARS constants are UTF-8 BYTE budgets;
// truncation is code-point safe and adds an explicit "…")
// ---------------------------------------------------------------------------

export const MAX_RUN_ID_CHARS = 64;
export const MAX_RECIPE_CHARS = 64;
export const MAX_PROFILE_CHARS = 64;
export const MAX_MODE_CHARS = 16;
export const MAX_STATUS_CHARS = 16;
/** Largest finite double renders in ~24 chars; exit codes are far smaller. */
export const MAX_NUMBER_CHARS = 24;
export const MAX_TIMESTAMP_CHARS = 40;
export const MAX_GIT_CHARS = 56;
export const MAX_CWD_CHARS = 160;
export const MAX_ARGV_CHARS = 240;
export const MAX_ARTIFACT_PATHS = 8;
export const MAX_ARTIFACT_PATH_CHARS = 80;
export const MAX_ARTIFACT_LINE_BYTES = 240;
export const MAX_EVIDENCE_PATHS = 8;
export const MAX_EVIDENCE_PATH_CHARS = 80;
export const MAX_EVIDENCE_LINE_BYTES = 240;
export const MAX_DECLARED_WRITES = 8;
export const MAX_DECLARED_WRITE_CHARS = 80;
export const MAX_DECLARED_WRITES_LINE_BYTES = 240;
export const MAX_TRUNCATION_CHARS = 60;
export const MAX_CACHE_LINE_BYTES = 240;
export const MAX_CACHE_KEY_CHARS = 16;
export const MAX_CACHE_RUN_ID_CHARS = 64;
export const MAX_CACHE_TIMESTAMP_CHARS = 32;
export const MAX_QUANT_LINE_BYTES = 240;
export const MAX_QUANT_TYPE_CHARS = 24;
export const MAX_QUANT_STATUS_CHARS = 16;
export const MAX_QUANT_MANIFEST_CHARS = 64;
export const MAX_PATH_CHARS = 160;
/**
 * Byte budget of the aggregate `omissions :` line. Holds the worst-case
 * machine-fact set (list counts + dropped cache/quant groups + bounded
 * metadata/persisted display), so omission reporting never silently drops
 * a machine fact; the opt-in guidance lives on its own required line and
 * is never part of this truncatable aggregate. 480 matches
 * core/result-summary.ts (P1).
 */
export const MAX_OMISSIONS_CHARS = 480;
export const MAX_NOTE_CHARS = 200;

/** Machine-derived disclaimer (same policy as core/result-summary.ts). */
const NOTE_TEXT = "machine-derived summary — full evidence is persisted at the paths above; a summary is never acceptance evidence";

/**
 * P4b: the current-state validation verdict rendered by the caller.
 * `REUSABLE` is rendered ONLY when the exact-state P4a comparison accepted
 * a successful, complete, Sol-owned binding; every other record renders
 * `RERUN_REQUIRED` with its fixed reason codes. The verdict is observation
 * only — it never skips recipe/gate execution and is never acceptance
 * evidence.
 */
export interface RunValidationRender {
	status: "REUSABLE" | "RERUN_REQUIRED";
	/** Fixed P4a reason codes — empty when REUSABLE. */
	reasons: readonly string[];
}

/**
 * Byte budget of the WHOLE required `validation :` line, INCLUDING the
 * omitted-count suffix. The line shows as many COMPLETE fixed reason codes
 * as fit and appends an exact "(+N more)" marker when codes were omitted —
 * the full code set always lives in the structured details. The budget
 * keeps the required-fact block inside the safe minima under fully
 * adversarial input (guaranteed-fit policy).
 */
export const MAX_VALIDATION_LINE_BYTES = 128;
/** Defensive per-code display bound (fixed codes are far shorter). */
const MAX_VALIDATION_CODE_CHARS = 40;

/**
 * The REQUIRED bounded validation line. Fail-closed defensive policy:
 *   - absent payload → `RERUN_REQUIRED — missing-binding` (never claim
 *     reuse without evidence);
 *   - a payload claiming REUSABLE with reasons is a contradiction →
 *     rendered RERUN_REQUIRED with those reasons;
 *   - malformed reason values are dropped; a claimed refusal with no
 *     usable reasons defaults to `missing-binding`;
 *   - the joined codes AND the exact omitted-count suffix are bounded
 *     together (complete codes only, code-point safe, exact omitted
 *     count) so the WHOLE emitted line — suffix included — always fits
 *     MAX_VALIDATION_LINE_BYTES; a code is either shown complete or not
 *     shown at all, never truncated mid-code.
 */
function validationLine(v: RunValidationRender | null | undefined): string {
	const status = v?.status === "REUSABLE" ? "REUSABLE" : "RERUN_REQUIRED";
	const reasons = Array.isArray(v?.reasons) ? v.reasons.filter((r): r is string => typeof r === "string") : [];
	if (status === "REUSABLE" && reasons.length === 0) return "validation : REUSABLE";
	const codes = reasons.length > 0 ? reasons : ["missing-binding"];
	const prefix = "validation : RERUN_REQUIRED — ";
	const shown: string[] = [];
	for (const code of codes) {
		const bounded = boundedBytes(code, MAX_VALIDATION_CODE_CHARS);
		const candidate = [...shown, bounded];
		// The candidate is accepted only when the FULL line — prefix, every
		// complete code and the exact omitted-count suffix — fits the
		// budget. A code that would overflow is omitted entirely (never
		// partial) and the count suffix is the source of truth for it.
		const suffix = codes.length > candidate.length ? `…(+${codes.length - candidate.length} more)` : "";
		if (utf8Bytes(prefix + candidate.join(", ") + suffix) > MAX_VALIDATION_LINE_BYTES) break;
		shown.push(bounded);
	}
	// Defensive fallback: even one bounded code plus the largest suffix
	// (32 + 40 + 12 bytes) fits the budget, so `shown` is never empty for
	// any real input — the fallback still keeps the total under the budget.
	const safeShown = shown.length > 0 ? shown : [boundedBytes(codes[0]!, MAX_VALIDATION_CODE_CHARS)];
	const suffix = codes.length > safeShown.length ? `…(+${codes.length - safeShown.length} more)` : "";
	return `${prefix}${safeShown.join(", ")}${suffix}`;
}

// ---------------------------------------------------------------------------
// UTF-8 / code-point-safe helpers (mirroring core/result-summary.ts)
// ---------------------------------------------------------------------------

const CONTROL_RE = /[\x00-\x1f\x7f]/g;

/**
 * Sanitize an untrusted display field: control characters (including
 * newlines — a field must never inject extra summary lines) are replaced
 * by a single space, deterministically. Non-string values render as
 * "(invalid)" so the policy never throws on defensive input.
 */
function inline(text: unknown): string {
	if (typeof text !== "string") return "(invalid)";
	return text.replace(CONTROL_RE, " ");
}

/**
 * Bound an untrusted display field to `maxBytes` UTF-8 bytes, code-point
 * safe, with an explicit "…" marker when truncated. Newlines/control
 * characters inside the field are sanitized first.
 */
function boundedBytes(text: unknown, maxBytes: number): string {
	const cleaned = inline(text);
	const cut = truncateUtf8Bytes(cleaned, maxBytes);
	if (!cut.truncated) return cleaned;
	if (maxBytes < 3) return cut.text;
	return `${truncateUtf8Bytes(cleaned, maxBytes - 3).text}…`;
}

/** Deterministic number rendering for display; anything else renders "?". */
function num(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

/**
 * Join display items into ONE inline line bounded to `maxBytes` bytes:
 * shows at most `maxItems` items (each bounded to `itemMaxBytes`); when
 * items were dropped, appends the EXACT omitted count ("(+N more …)").
 * Items are dropped (never the count suffix) until the line fits, so the
 * exact omitted count always survives.
 */
function joinBounded(
	items: readonly unknown[],
	maxBytes: number,
	maxItems: number,
	itemMaxBytes: number,
	moreLabel: string,
	moreWhere: string,
): { line: string; shown: number } {
	const boundedItems = items.slice(0, maxItems).map((item) => boundedBytes(item, itemMaxBytes));
	let shown = boundedItems.length;
	for (;;) {
		let line = boundedItems.slice(0, shown).join(", ");
		if (items.length > shown) line += ` (+${items.length - shown} more ${moreLabel} omitted — ${moreWhere})`;
		if (utf8Bytes(line) <= maxBytes || shown === 0) return { line, shown };
		shown--;
	}
}

/**
 * A line accumulator with EXACT accounting: `usedBytes` counts the UTF-8
 * bytes of every line PLUS one byte per newline separator (the final text
 * is `lines.join("\n")`). Required lines are added unconditionally (they
 * are bounded by construction and always fit the resolved caps); optional
 * lines (metadata, cache/quant facts) are added only when BOTH caps still
 * have room.
 */
class LineBudget {
	readonly lines: string[] = [];
	private bytes = 0;
	constructor(
		private readonly maxBytes: number,
		private readonly maxLines: number,
	) {}

	addRequired(line: string): void {
		this.bytes += utf8Bytes(line) + (this.lines.length > 0 ? 1 : 0);
		this.lines.push(line);
	}

	tryAdd(line: string): boolean {
		const lineBytes = utf8Bytes(line);
		if (this.lines.length + 1 > this.maxLines) return false;
		if (this.bytes + lineBytes + (this.lines.length > 0 ? 1 : 0) > this.maxBytes) return false;
		this.bytes += lineBytes + (this.lines.length > 0 ? 1 : 0);
		this.lines.push(line);
		return true;
	}

	get usedBytes(): number {
		return this.bytes;
	}
}

/**
 * Defensive status label mirroring runStatusLabel (core/format.ts):
 * TIMED OUT / CANCELLED / KILLED / OK / FAILED. Never throws on
 * adversarial record fields (missing arrays, non-finite exit codes).
 */
function statusOf(m: RunRecord): string {
	if (m.timed_out === true) return "TIMED OUT";
	if (m.cancelled === true) return "CANCELLED";
	if (m.run_outcome === "ARTIFACT_FAILED" || m.run_outcome === "PROCESS_FAILED" || m.run_outcome === "COMMAND_EFFECT_FAILED") return "FAILED";
	const code = typeof m.exit_code === "number" && Number.isFinite(m.exit_code) ? m.exit_code : null;
	if (code === null) return "KILLED";
	const expected = Array.isArray(m.expected_exit_codes) ? m.expected_exit_codes : [];
	return expected.includes(code) ? "OK" : "FAILED";
}

// ---------------------------------------------------------------------------
// Layered renderer
// ---------------------------------------------------------------------------

export interface RunLogTail {
	/** Caller-bounded tail content (already bounded by readLogSnippet). */
	content: string;
	truncated: boolean;
}

export interface RunResultRenderInput {
	/** Omitted/unknown values resolve to "summary" (the registered default). */
	include?: RunResultInclude;
	manifest: RunRecord;
	/**
	 * P4b: current-state validation verdict (built by the caller from
	 * core/validation-assessment.ts — the renderer never assesses). Absent
	 * payloads render the fail-closed `RERUN_REQUIRED — missing-binding`.
	 */
	validation?: RunValidationRender | null;
	/** Present only for the explicit logs/all includes. */
	stdoutSnippet?: RunLogTail | null;
	stderrSnippet?: RunLogTail | null;
	/** Project-relative durable display paths. */
	runDir: string;
	manifestPath: string;
	summaryPath: string;
	stdoutPath: string;
	stderrPath: string;
	caps?: Partial<RunResultCaps>;
}

export interface RunResultRender {
	lines: string[];
	text: string;
	utf8Bytes: number;
	/**
	 * Always true: capped includes fit by construction; logs/all are
	 * caller-bounded.
	 */
	withinCaps: boolean;
	/** Whether a global byte/line cap applies (summary/manifest). */
	capped: boolean;
	/** The resolved (clamped) caps used for capped includes. */
	caps: RunResultCaps;
	include: RunResultInclude;
	/** Line counts per layer, in emit order (metadata/omissions included). */
	layers: { summary: number; evidence: number; metadata: number; persisted: number; tails: number };
	artifactsShown: number;
	artifactsOmitted: number;
	evidencePathsShown: number;
	evidencePathsOmitted: number;
	declaredWritesShown: number;
	declaredWritesOmitted: number;
	argvShown: boolean;
	cwdShown: boolean;
	stdoutTailShown: boolean;
	stderrTailShown: boolean;
	/** The individual facts joined into the `omissions :` line. */
	omissionFacts: readonly string[];
}

/**
 * Defensive minimal summary, used ONLY when the required-fact block does
 * not fit (unreachable under clamped caps — every field is bounded and
 * the minima are chosen to hold the worst-case required block). Fits the
 * safe minima by construction, so the bounded-output invariant is total.
 */
function buildMinimalFallback(input: RunResultRenderInput, caps: RunResultCaps): RunResultRender {
	const m = input.manifest;
	const lines = [
		"--- summary ---",
		`run_id     : ${boundedBytes(m.run_id, MAX_RUN_ID_CHARS)}`,
		`recipe     : ${boundedBytes(m.recipe, MAX_RECIPE_CHARS)}`,
		`status     : ${boundedBytes(statusOf(m), MAX_STATUS_CHARS)}`,
		validationLine(input.validation),
		`exit code  : ${m.exit_code === null ? "killed" : num(m.exit_code)}`,
		"--- persisted ---",
		`run dir    : ${boundedBytes(input.runDir, MAX_PATH_CHARS)}`,
		`manifest   : ${boundedBytes(input.manifestPath, MAX_PATH_CHARS)}`,
		`summary    : ${boundedBytes(input.summaryPath, MAX_PATH_CHARS)}`,
		`stdout log : ${boundedBytes(input.stdoutPath, MAX_PATH_CHARS)} (full log on disk)`,
		`stderr log : ${boundedBytes(input.stderrPath, MAX_PATH_CHARS)} (full log on disk)`,
		"omissions  : summary degraded to the minimal form — raw logs/tails/argv omitted; bounded tails on request: include=logs or include=all; full evidence in the persisted run record",
		`note       : ${boundedBytes(NOTE_TEXT, MAX_NOTE_CHARS)}`,
	];
	const text = lines.join("\n");
	return {
		lines,
		text,
		utf8Bytes: utf8Bytes(text),
		withinCaps: true,
		capped: true,
		caps,
		include: isRunResultInclude(input.include) ? input.include : "summary",
		layers: { summary: 0, evidence: 0, metadata: 0, persisted: lines.length, tails: 0 },
		artifactsShown: 0,
		artifactsOmitted: 0,
		evidencePathsShown: 0,
		evidencePathsOmitted: 0,
		declaredWritesShown: 0,
		declaredWritesOmitted: 0,
		argvShown: false,
		cwdShown: false,
		stdoutTailShown: false,
		stderrTailShown: false,
		omissionFacts: [
			"summary degraded to the minimal form — raw logs/tails/argv omitted; bounded tails on request: include=logs or include=all; full evidence in the persisted run record",
		],
	};
}

/**
 * REQUIRED Evidence-layer guidance line (a fixed string, bounded by
 * construction — never truncatable): always states the raw-content policy
 * AND the exact opt-in instruction for bounded tails. For the default
 * `summary` this is the high-priority opt-in guidance that must survive
 * adversarial fields/lists and the byte/line caps; it never lives only at
 * the tail of the truncatable aggregate omissions line.
 */
function logsGuidanceLine(include: RunResultInclude): string {
	if (include === "summary") {
		return "logs/argv  : raw stdout/stderr/tails and argv are omitted — bounded tails on request: include=logs or include=all";
	}
	if (include === "manifest") {
		return "logs       : no raw logs and no tails — bounded tails on request: include=logs or include=all";
	}
	return "tails      : caller-bounded tails below (max_lines / max_bytes) — full logs stay on disk at the persisted paths";
}

/** Aggregate omission facts — machine facts only (the guidance has its own required line). */
const FACT_CACHE_OMITTED = "some cache facts omitted (display caps) — full values in manifest.json";
const FACT_QUANT_OMITTED = "quant facts omitted (display caps) — full values in manifest.json";
const FACT_METADATA_BOUNDED = "cwd/argv metadata bounded (display) — full values in manifest.json";
const FACT_FIELDS_BOUNDED = "run fields bounded (display) — full values in manifest.json";

/**
 * Build the layered bounded presentation of a workbench run record.
 * Ordered Summary → Evidence → [Metadata] → Persisted → [Tails]; the
 * default `summary` include NEVER inlines raw stdout/stderr, per-test
 * lines, or argv; explicit `manifest` adds bounded cwd/argv metadata
 * without tails; explicit `logs`/`all` additionally append the existing
 * caller-bounded log tails verbatim. Every untrusted field is sanitized
 * and bounded with explicit omission facts; lists render bounded items
 * plus the exact omitted count; optional cache/quant lines that cannot
 * fit the resolved caps are dropped (lowest priority first) and recorded
 * in the aggregate; metadata/persisted bounding facts are precomputed
 * before the aggregate is emitted; the emitted summary/manifest output
 * ALWAYS fits the resolved caps.
 */
export function renderRunResult(input: RunResultRenderInput): RunResultRender {
	const include = isRunResultInclude(input.include) ? input.include : "summary";
	const caps = resolveRunResultCaps(input.caps);
	const capped = include === "summary" || include === "manifest";
	// logs/all: no global cap — the metadata block is per-field bounded and
	// the tails are already caller-bounded.
	const budget = new LineBudget(capped ? caps.maxBytes : Number.MAX_SAFE_INTEGER, capped ? caps.maxLines : Number.MAX_SAFE_INTEGER);
	const omissionFacts: string[] = [];
	const m = input.manifest;
	/** Records whether any manifest/path field was actually truncated. */
	let anyFieldBounded = false;
	const field = (value: unknown, maxBytes: number): string => {
		const out = boundedBytes(value, maxBytes);
		if (out.endsWith("…")) anyFieldBounded = true;
		return out;
	};

	// ---- Summary layer content (required) --------------------------------
	const summaryLines = [
		"--- summary ---",
		`run_id     : ${field(m.run_id, MAX_RUN_ID_CHARS)}`,
		`recipe     : ${field(m.recipe, MAX_RECIPE_CHARS)}`,
		`profile    : ${field(m.profile ?? "(none)", MAX_PROFILE_CHARS)}`,
		`mode       : ${field(m.mode, MAX_MODE_CHARS)}`,
		`status     : ${field(statusOf(m), MAX_STATUS_CHARS)}`,
		// P4b: REQUIRED current-state validation line — bounded by
		// construction (MAX_VALIDATION_LINE_BYTES) and always emitted in
		// every include mode. Observation only: it never skips execution.
		validationLine(input.validation),
		`exit code  : ${m.exit_code === null ? "killed" : num(m.exit_code)}`,
		`duration   : ${num(m.duration_ms)} ms`,
		`started    : ${field(m.started_at, MAX_TIMESTAMP_CHARS)}`,
		`finished   : ${field(m.finished_at, MAX_TIMESTAMP_CHARS)}`,
		`timed out  : ${m.timed_out === true ? "yes" : "no"}`,
		`cancelled  : ${m.cancelled === true ? "yes" : "no"}`,
	];
	const commit = typeof m.git_commit === "string" && m.git_commit.length > 0 ? m.git_commit.slice(0, 12) : "(no git)";
	summaryLines.push(`git        : ${field(commit, MAX_GIT_CHARS)}${m.git_dirty === true ? " (dirty)" : ""}`);
	// P6-C execution source (optional — absent on legacy/exec runs).
	const executionLine = m.execution_source !== undefined ? `execution  : ${field(m.execution_source, MAX_STATUS_CHARS)}` : null;

	// ---- Evidence layer content: required facts + bounded lists ----------
	const artifacts = Array.isArray(m.artifact_paths) ? m.artifact_paths : [];
	const artifactsLine = joinBounded(artifacts, MAX_ARTIFACT_LINE_BYTES, MAX_ARTIFACT_PATHS, MAX_ARTIFACT_PATH_CHARS, "artifact path(s)", "full list in the run record");
	const artifactsOmitted = artifacts.length - artifactsLine.shown;
	if (artifactsOmitted > 0) omissionFacts.push(`${artifactsOmitted} artifact path(s) omitted (bounded display)`);

	const evidencePaths = Array.isArray(m.evidence_paths) ? m.evidence_paths : [];
	const evidenceLine = joinBounded(evidencePaths, MAX_EVIDENCE_LINE_BYTES, MAX_EVIDENCE_PATHS, MAX_EVIDENCE_PATH_CHARS, "evidence path(s)", "full list in the run record");
	const evidencePathsOmitted = evidencePaths.length - evidenceLine.shown;
	if (evidencePathsOmitted > 0) omissionFacts.push(`${evidencePathsOmitted} evidence path(s) omitted (bounded display)`);

	const declaredWrites = Array.isArray(m.declared_writes) ? m.declared_writes : [];
	const writesLine = joinBounded(declaredWrites, MAX_DECLARED_WRITES_LINE_BYTES, MAX_DECLARED_WRITES, MAX_DECLARED_WRITE_CHARS, "declared write(s)", "full list in the run record");
	const declaredWritesOmitted = declaredWrites.length - writesLine.shown;
	if (declaredWritesOmitted > 0) omissionFacts.push(`${declaredWritesOmitted} declared write(s) omitted (bounded display)`);

	const evidenceRequired = [
		"--- evidence ---",
		`artifacts  : ${artifacts.length > 0 ? artifactsLine.line : "(none)"}`,
		`evidence   : ${evidencePaths.length > 0 ? evidenceLine.line : "(none)"}`,
		`declared writes: ${declaredWrites.length > 0 ? writesLine.line : "(none)"}`,
		`truncation : ${field(`stdout ${m.stdout_truncated === true ? "yes" : "no"}, stderr ${m.stderr_truncated === true ? "yes" : "no"}`, MAX_TRUNCATION_CHARS)}`,
		logsGuidanceLine(include),
	];

	// ---- Optional cache/quant candidate lines (priority order) -----------
	const optionalCandidates: Array<{ line: string; group: "cache" | "quant"; where: "summary" | "evidence" }> = [];
	if (executionLine !== null) optionalCandidates.push({ line: executionLine, group: "cache", where: "summary" });
	if (m.execution_source === "cache") {
		const parts = ["CACHE"];
		if (m.reused_from_run_id) parts.push(`reused ${field(m.reused_from_run_id, MAX_CACHE_RUN_ID_CHARS)}`);
		if (m.action_key) parts.push(`key ${field(m.action_key, MAX_CACHE_KEY_CHARS)}`);
		optionalCandidates.push({ line: `cache      : ${field(parts.join(" — "), MAX_CACHE_LINE_BYTES)}`, group: "cache", where: "evidence" });
		const valid = [m.cache_created_at, m.cache_validated_at].filter((v): v is string => typeof v === "string" && v.length > 0);
		if (valid.length > 0) {
			optionalCandidates.push({ line: `cache valid: ${field(valid.map((v) => field(v, MAX_CACHE_TIMESTAMP_CHARS)).join(" — "), MAX_CACHE_LINE_BYTES)}`, group: "cache", where: "evidence" });
		}
		if (m.artifact_validation && typeof m.artifact_validation === "object") {
			const av = m.artifact_validation as { status?: unknown; mode?: unknown; artifacts_restored?: unknown; hash_verified?: unknown };
			const avParts = [field(av.status ?? "?", MAX_QUANT_STATUS_CHARS)];
			if (av.mode !== undefined) avParts.push(field(av.mode, MAX_MODE_CHARS));
			avParts.push(`restored ${av.artifacts_restored === true ? "yes" : "no"}`, `hash ${av.hash_verified === true ? "verified" : "not"}`);
			optionalCandidates.push({ line: `artifact validation: ${field(avParts.join(" "), MAX_CACHE_LINE_BYTES)}`, group: "cache", where: "evidence" });
		}
	}
	if (m.quant_contract && typeof m.quant_contract === "object") {
		const q = m.quant_contract as { type?: unknown; manifest?: unknown; validation_status?: unknown; warnings?: unknown };
		const qParts = [field(q.type ?? "?", MAX_QUANT_TYPE_CHARS), field(q.validation_status ?? "?", MAX_QUANT_STATUS_CHARS)];
		if (q.manifest !== undefined) qParts.push(`manifest ${field(q.manifest, MAX_QUANT_MANIFEST_CHARS)}`);
		if (Array.isArray(q.warnings)) qParts.push(`warnings ${num(q.warnings.length)}`);
		optionalCandidates.push({ line: `quant      : ${field(qParts.join(" "), MAX_QUANT_LINE_BYTES)}`, group: "quant", where: "evidence" });
	}

	// ---- Metadata layer content (explicit manifest/logs/all only) --------
	// Precomputed BEFORE the aggregate omissions line is built, so a bounded
	// metadata display is never discovered only after the aggregate was
	// already emitted. cwd/argv are required for explicit includes and
	// always fit the safe minima together with the required block.
	const metadataLines: string[] = [];
	let metadataBounded = false;
	if (include !== "summary") {
		const cwdOut = field(m.cwd, MAX_CWD_CHARS);
		if (cwdOut.endsWith("…")) metadataBounded = true;
		metadataLines.push(`cwd        : ${cwdOut}`);
		const argvOut = field(Array.isArray(m.argv) ? m.argv.join(" ") : m.argv, MAX_ARGV_CHARS);
		if (argvOut.endsWith("…")) metadataBounded = true;
		metadataLines.push(`argv       : ${argvOut}`);
	}
	if (metadataBounded) omissionFacts.push(FACT_METADATA_BOUNDED);

	// ---- Persisted layer content (required; bounded forms precomputed) ---
	const persistedLines = [
		"--- persisted ---",
		`run dir    : ${field(input.runDir, MAX_PATH_CHARS)}`,
		`manifest   : ${field(input.manifestPath, MAX_PATH_CHARS)}`,
		`summary    : ${field(input.summaryPath, MAX_PATH_CHARS)}`,
		`stdout log : ${field(input.stdoutPath, MAX_PATH_CHARS)} (full log on disk)`,
		`stderr log : ${field(input.stderrPath, MAX_PATH_CHARS)} (full log on disk)`,
		`note       : ${field(NOTE_TEXT, MAX_NOTE_CHARS)}`,
	];
	if (anyFieldBounded) omissionFacts.push(FACT_FIELDS_BOUNDED);

	// ---- Selection: fit the optional lines under the resolved caps -------
	// Deterministic: start with every optional line selected and drop from
	// the lowest priority until the required + selected block fits; every
	// dropped group is recorded in the aggregate (built BEFORE emission, so
	// the aggregate also reflects metadata/persisted bounding). The required
	// block alone always fits the safe minima, so the loop terminates with
	// at most all optional lines dropped.
	const selected = optionalCandidates.map(() => true);
	const factsFor = (): string[] => {
		const facts = [...omissionFacts];
		if (optionalCandidates.some((c, i) => c.group === "cache" && !selected[i])) facts.push(FACT_CACHE_OMITTED);
		if (optionalCandidates.some((c, i) => c.group === "quant" && !selected[i])) facts.push(FACT_QUANT_OMITTED);
		return facts;
	};
	const bytesOf = (lines: readonly string[]): number => lines.reduce((acc, l) => acc + utf8Bytes(l), 0) + Math.max(0, lines.length - 1);

	let facts: string[] = [];
	let ordered: string[] = [];
	for (;;) {
		facts = factsFor();
		const omissionsLine = `omissions  : ${field(facts.join("; "), MAX_OMISSIONS_CHARS)}`;
		ordered = [
			...summaryLines,
			...optionalCandidates.filter((c, i) => selected[i] && c.where === "summary").map((c) => c.line),
			...evidenceRequired,
			...optionalCandidates.filter((c, i) => selected[i] && c.where === "evidence").map((c) => c.line),
			omissionsLine,
			...metadataLines,
			...persistedLines,
		];
		if (!capped || (ordered.length <= caps.maxLines && bytesOf(ordered) <= caps.maxBytes)) break;
		const drop = [...selected.keys()].reverse().find((i) => selected[i]);
		if (drop === undefined) break;
		selected[drop] = false;
	}
	const shownOptional = optionalCandidates.filter((_, i) => selected[i]);

	// ---- Emit in the fixed layer order -----------------------------------
	for (const line of ordered) budget.addRequired(line);
	const summaryLayerCount = summaryLines.length + shownOptional.filter((c) => c.where === "summary").length;
	const evidenceLayerCount = evidenceRequired.length + shownOptional.filter((c) => c.where === "evidence").length + 1;
	const metadataLayerCount = metadataLines.length;
	const persistedLayerCount = persistedLines.length;

	// ---- Guaranteed fit (unreachable under clamped caps; total defense) --
	if (capped && (budget.lines.length > caps.maxLines || budget.usedBytes > caps.maxBytes)) {
		return buildMinimalFallback(input, caps);
	}

	// ---- Tail layer (explicit logs/all only, caller-bounded, verbatim) ---
	let stdoutTailShown = false;
	let stderrTailShown = false;
	if (include === "logs" || include === "all") {
		if (input.stdoutSnippet) {
			budget.addRequired(`--- stdout tail (${input.stdoutSnippet.truncated ? "truncated" : "full"}): ${field(input.stdoutPath, MAX_PATH_CHARS)} ---`);
			const content = input.stdoutSnippet.content ?? "";
			if (content.length > 0) {
				// Verbatim append: splitting and rejoining on "\n" is byte-exact.
				for (const line of content.split("\n")) budget.addRequired(line);
			} else {
				budget.addRequired("(empty)");
			}
			stdoutTailShown = true;
		}
		if (input.stderrSnippet) {
			budget.addRequired(`--- stderr tail (${input.stderrSnippet.truncated ? "truncated" : "full"}): ${field(input.stderrPath, MAX_PATH_CHARS)} ---`);
			const content = input.stderrSnippet.content ?? "";
			if (content.length > 0) {
				for (const line of content.split("\n")) budget.addRequired(line);
			} else {
				budget.addRequired("(empty)");
			}
			stderrTailShown = true;
		}
	}
	const tailLayerCount = budget.lines.length - summaryLayerCount - evidenceLayerCount - metadataLayerCount - persistedLayerCount;

	const text = budget.lines.join("\n");
	return {
		lines: budget.lines,
		text,
		utf8Bytes: utf8Bytes(text),
		withinCaps: true,
		capped,
		caps,
		include,
		layers: {
			summary: summaryLayerCount,
			evidence: evidenceLayerCount,
			metadata: metadataLayerCount,
			persisted: persistedLayerCount,
			tails: tailLayerCount,
		},
		artifactsShown: artifactsLine.shown,
		artifactsOmitted,
		evidencePathsShown: evidenceLine.shown,
		evidencePathsOmitted,
		declaredWritesShown: writesLine.shown,
		declaredWritesOmitted,
		argvShown: include !== "summary",
		cwdShown: include !== "summary",
		stdoutTailShown,
		stderrTailShown,
		omissionFacts: facts,
	};
}

// ---------------------------------------------------------------------------
// Run-log reverse-page renderer (R5)
// ---------------------------------------------------------------------------

export const RUN_LOG_PROTOCOL = "workbench-run-log-page-v1" as const;
export const RUN_LOG_OUTPUT_MAX_BYTES = 32_768 as const;
export const RUN_LOG_OUTPUT_MAX_LINES = 400 as const;

export interface RunLogRenderInput {
	manifest: RunRecord;
	page: RunLogPage;
	validation?: RunValidationRender | null;
	stdoutPath: string;
	stderrPath: string;
	/** Trusted turn reservation; omitted direct calls retain the hard cap. */
	maxOutputBytes?: number;
	maxOutputLines?: number;
}

export interface RunLogRenderResult {
	text: string;
	utf8Bytes: number;
	lines: number;
	shownBytes: number;
	shownLines: number;
	omittedBeforeBytes: number;
	completeBefore: boolean;
	previousCursor?: string;
	continuation?: { kind: "run-log"; value: string };
}

function validOutputCap(value: unknown, fallback: number, hardMax: number): number {
	return value === undefined
		? fallback
		: typeof value === "number" && Number.isSafeInteger(value) && value > 0
			? Math.min(value, hardMax)
			: 0;
}

function utf8Suffix(buffer: Buffer, requestedBytes: number): Buffer {
	if (requestedBytes >= buffer.length) return buffer;
	if (requestedBytes <= 0) return buffer.subarray(buffer.length);
	let start = buffer.length - requestedBytes;
	while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
	return buffer.subarray(start);
}

function quotedLogContent(text: string): string {
	if (text.length === 0) return "";
	return text.split("\n").map((line) => `| ${line}`).join("\n");
}

function boundedLogPath(value: string): string {
	return boundedBytes(value, 120);
}

/**
 * Count logical source lines, matching bounded-file-io's byte-level facts:
 * a trailing LF terminates the last line and never invents an extra empty
 * source line. CRLF is one line ending because LF is the delimiter.
 */
function sourceLineCount(text: string): number {
	if (text.length === 0) return 0;
	let lines = text.endsWith("\n") ? 0 : 1;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === 0x0a) lines += 1;
	}
	return lines;
}

/** Display-line accounting is deliberately independent of source facts. */
function displayLineCount(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

function renderLogCandidate(input: RunLogRenderInput, stdout: Buffer, stderr: Buffer): RunLogRenderResult {
	const selected = input.page.selection === "both" ? ["stdout", "stderr"] as const : [input.page.selection] as const;
	const adjusted = (stream: "stdout" | "stderr", bytes: Buffer): RunLogPageStream & { renderedText: string } => {
		const source = input.page[stream];
		const renderedText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const removed = source.shownBytes - bytes.length;
		return {
			...source,
			text: renderedText,
			renderedText,
			startByte: source.startByte + removed,
			shownBytes: bytes.length,
			shownLines: sourceLineCount(renderedText),
			completeBefore: source.completeBefore && removed === 0,
			lineSegment: source.lineSegment || removed > 0,
		};
	};
	const pages = { stdout: adjusted("stdout", stdout), stderr: adjusted("stderr", stderr) };
	const completeBefore = selected.every((stream) => pages[stream].completeBefore);
	let previousCursor: string | undefined;
	if (!completeBefore) {
		const payload: RunLogCursorPayloadV1 = {
			v: 1,
			kind: "run-log",
			sourceId: input.page.sourceId,
			sourceStateId: input.page.sourceStateId,
			stdoutEndExclusive: input.page.selection === "stderr" || pages.stdout.completeBefore ? 0 : pages.stdout.startByte,
			stderrEndExclusive: input.page.selection === "stdout" || pages.stderr.completeBefore ? 0 : pages.stderr.startByte,
		};
		const encoded = encodeContinuationCursor(payload);
		if (!encoded.ok) throw new Error(encoded.error.code);
		previousCursor = encoded.value;
	}
	const shownBytes = selected.reduce((sum, stream) => sum + pages[stream].shownBytes, 0);
	const shownLines = selected.reduce((sum, stream) => sum + pages[stream].shownLines, 0);
	const omittedBeforeBytes = selected.reduce((sum, stream) => sum + pages[stream].startByte, 0);
	const header = [
		"[workbench-run-log-page v1]",
		`protocol=${JSON.stringify(RUN_LOG_PROTOCOL)}`,
		`run_id=${JSON.stringify(boundedBytes(input.manifest.run_id, MAX_RUN_ID_CHARS))}`,
		`status=${JSON.stringify(boundedBytes(statusOf(input.manifest), MAX_STATUS_CHARS))}`,
		validationLine(input.validation),
		`stream=${JSON.stringify(input.page.selection)}`,
		...selected.map((stream) => {
			const page = pages[stream];
			const path = stream === "stdout" ? input.stdoutPath : input.stderrPath;
			return `${stream}=${JSON.stringify({ path: boundedLogPath(path), state: page.state, byte_range: [page.startByte, page.endExclusive], file_size: page.fileSize, shown_bytes: page.shownBytes, shown_lines: page.shownLines, line_segment: page.lineSegment })}`;
		}),
		`shown_bytes=${shownBytes}`,
		`shown_lines=${shownLines}`,
		`omitted_before_bytes=${omittedBeforeBytes}`,
		`omitted_before_lines=${JSON.stringify("not_scanned")}`,
		`complete_before=${String(completeBefore)}`,
		...(previousCursor ? [`previous_cursor=${JSON.stringify(previousCursor)}`] : []),
		"full_log_inlined=false",
		"[/workbench-run-log-page]",
	];
	const sections: string[] = [];
	for (const stream of selected) {
		sections.push(`--- BEGIN QUOTED ${stream.toUpperCase()} CONTENT ---`);
		if (pages[stream].state === "missing") sections.push("| (missing)");
		else if (pages[stream].state === "empty") sections.push("| (empty)");
		else sections.push(quotedLogContent(pages[stream].renderedText));
		sections.push(`--- END QUOTED ${stream.toUpperCase()} CONTENT ---`);
	}
	const text = [...header, ...sections].join("\n");
	return {
		text,
		utf8Bytes: utf8Bytes(text),
		lines: displayLineCount(text),
		shownBytes,
		shownLines,
		omittedBeforeBytes,
		completeBefore,
		...(previousCursor ? { previousCursor, continuation: { kind: "run-log" as const, value: previousCursor } } : {}),
	};
}

/**
 * Quote and fit one shared stdout/stderr page. Binary search only removes a
 * UTF-8-safe prefix from the already bounded tail, so a previous cursor can
 * replay every omitted older byte and protocol-like log text stays data.
 */
export function renderRunLogPage(input: RunLogRenderInput): RunLogRenderResult {
	const maxBytes = validOutputCap(input.maxOutputBytes, RUN_LOG_OUTPUT_MAX_BYTES, RUN_LOG_OUTPUT_MAX_BYTES);
	const maxLines = validOutputCap(input.maxOutputLines, RUN_LOG_OUTPUT_MAX_LINES, RUN_LOG_OUTPUT_MAX_LINES);
	const stdoutFull = Buffer.from(input.page.stdout.text, "utf8");
	const stderrFull = Buffer.from(input.page.stderr.text, "utf8");
	let low = 0;
	let high = 1_000_000;
	let best: RunLogRenderResult | undefined;
	while (low <= high) {
		const ratio = Math.floor((low + high) / 2);
		const stdout = utf8Suffix(stdoutFull, Math.floor(stdoutFull.length * ratio / 1_000_000));
		const stderr = utf8Suffix(stderrFull, Math.floor(stderrFull.length * ratio / 1_000_000));
		const candidate = renderLogCandidate(input, stdout, stderr);
		if (candidate.utf8Bytes <= maxBytes && candidate.lines <= maxLines) {
			best = candidate;
			low = ratio + 1;
		} else {
			high = ratio - 1;
		}
	}
	if (!best || ((stdoutFull.length > 0 || stderrFull.length > 0) && best.shownBytes === 0)) {
		const error = "workbench_read_run: output_allocation_too_small";
		const text = boundedBytes(error, Math.max(0, maxBytes));
		return { text, utf8Bytes: utf8Bytes(text), lines: displayLineCount(text), shownBytes: 0, shownLines: 0, omittedBeforeBytes: 0, completeBefore: false };
	}
	return best;
}

// ---------------------------------------------------------------------------
// Read-only batching classifier (P3)
// ---------------------------------------------------------------------------

/**
 * Deterministic, explicit allowlist of tools that MAY be batched as
 * known-independent read-only calls in one host parallel turn. Exactly the
 * four read built-ins plus the five read-only workbench tools — the same
 * set as the AUDIT mode matrix (core/mode-policy.ts). Execution, review,
 * delegation and write tools are never listed (workbench_delegation_status
 * is excluded even though it only "reads": it refreshes persisted
 * delegation state, so it is not batchable). The classifier never infers
 * independence for concrete calls — it only answers membership.
 */
export const INDEPENDENT_READ_ONLY_ALLOWLIST = Object.freeze([
	"read",
	"grep",
	"find",
	"ls",
	"workbench_project_inspect",
	"workbench_read_run",
	"workbench_read_gate",
	"workbench_list_gates",
	"workbench_compare_runs",
] as const);

export type IndependentReadOnlyTool = (typeof INDEPENDENT_READ_ONLY_ALLOWLIST)[number];

/** Membership test against the explicit allowlist (never infers). */
export function isIndependentReadOnlyTool(name: string): boolean {
	return (INDEPENDENT_READ_ONLY_ALLOWLIST as readonly string[]).includes(name);
}
