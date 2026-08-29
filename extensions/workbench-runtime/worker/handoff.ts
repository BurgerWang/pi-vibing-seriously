/**
 * P7 bounded worker handoff — pure logic, no Pi imports.
 *
 * Root cause this module fixes: `workbench_delegate_worker` used to embed
 * the worker's complete final text (`result.output`) inside ONE parent
 * toolResult. Pi cannot split a toolResult, and `prepareCompaction` can
 * have no compactable prefix when the delegation tool-result turn is the
 * only post-compaction turn — the oversized embedded handoff then cannot
 * be compacted away.
 *
 * Replacement contract:
 *   - the COMPLETE final worker report is persisted as a durable bounded
 *     artifact (`worker-report.md`, max MAX_WORKER_REPORT_BYTES, redacted,
 *     UTF-8-safe, atomic, mode 0600) plus bounded structured
 *     `worker-summary.json` / `usage.json` in the delegation directory;
 *   - the parent toolResult is a STRICTLY BOUNDED structured summary
 *     (max MAX_PARENT_HANDOFF_LINES lines and MAX_PARENT_HANDOFF_BYTES
 *     UTF-8 bytes after rendering) that never concatenates the worker's
 *     report text, patch, or test logs; the renderer reserves every
 *     required fact line (identity/status/turns, bounded actual changed
 *     paths with an omission count, usage/cache/budget, report/summary/
 *     usage artifact paths, parse/review/failure facts) and drops optional
 *     summary items only as WHOLE sanitized lines until both global caps
 *     hold — a rendered line is never cut mid-item or mid-code-point;
 *   - UTF-8 BYTES govern every byte cap (never JS chars); truncation never
 *     splits a multibyte sequence (code-point safe — never a lone
 *     surrogate);
 *   - parsing extracts exactly the required final headings (## Completed /
 *     ## Files Changed / ## Verification / ## Remaining Risks) into bounded
 *     items (max MAX_SUMMARY_ITEMS_PER_SECTION items per section,
 *     MAX_SUMMARY_ITEM_CHARS characters per item) with an explicit parse
 *     warning when parsing is unreliable — never a raw-text fallback.
 *     Missing required sections (or an empty report) make parsing
 *     UNRELIABLE and suppress ALL parsed items in the parent handoff;
 *     item-cap hits alone keep otherwise-present sections RELIABLE and
 *     render as bounded items plus an explicit truncation fact.
 *   - the parent renders the SAME bounded summary/parse-warning facts the
 *     ledger persists in worker-summary.json (single derivation — the
 *     runtime never re-parses the report for the parent handoff).
 *
 * Phase 3 (worker token-budget repair) adds the deterministic cumulative
 * spend summary line (`spend budget : turns N/M | total X/Y | output A/B |
 * profile P` via core/worker-spend.ts) and the tightly bounded nested
 * `spend` details, both derived from the SAME canonical spend object the
 * ledger persists in worker-summary.json/usage.json — never recomputed
 * from runner internals or worker prose. The additive `spend` input is
 * optional, so pre-Phase-3 callers keep the exact prior handoff shape;
 * all line/byte caps and trust boundaries are unchanged.
 *
 * This module owns the constants and the pure parsing/rendering; the
 * ledger (core/delegation-ledger.ts) persists the artifacts; the runtime
 * (index.ts) wires the tool result and the /q-status diagnostics.
 */

import { formatWorkerBudgetSummary } from "../core/worker-budget.ts";
import { formatWorkerSpendSummary } from "../core/worker-spend.ts";
import type { WorkerSpendBand, WorkerSpendProfile, WorkerSpendReason } from "../core/worker-spend.ts";

// ---------------------------------------------------------------------------
// Bounds (P7 bounded worker handoff — single source of truth)
// ---------------------------------------------------------------------------

/** Parent toolResult content cap: UTF-8 bytes (never JS chars). */
export const MAX_PARENT_HANDOFF_BYTES = 12 * 1024;
/** Parent toolResult content cap: rendered lines. */
export const MAX_PARENT_HANDOFF_LINES = 120;
/** Durable worker-report.md artifact cap: UTF-8 bytes. */
export const MAX_WORKER_REPORT_BYTES = 512 * 1024;
/** Parsed section item cap per section (Completed/Verification/Remaining Risks). */
export const MAX_SUMMARY_ITEMS_PER_SECTION = 8;
/** Parsed item cap: characters per item. */
export const MAX_SUMMARY_ITEM_CHARS = 500;

/** Changed-path display caps in the parent handoff (whole paths only). */
export const MAX_HANDOFF_SHOWN_PATHS = 12;
export const MAX_HANDOFF_PATHS_LINE_BYTES = 1500;
/** Structured-details changed-path cap (tightly bounded details). */
export const MAX_HANDOFF_DETAIL_PATHS = 50;
/** Bounded failure/error string in the parent handoff and details. */
export const MAX_HANDOFF_FAILURE_CHARS = 500;
/** Bounded identity (provider/model) strings in the parent handoff. */
export const MAX_HANDOFF_IDENTITY_CHARS = 100;
/** Bounded stop-reason string in the parent handoff. */
export const MAX_HANDOFF_STOP_REASON_CHARS = 100;

/** Artifact file names inside the delegation directory. */
export const WORKER_REPORT_FILE_NAME = "worker-report.md";
export const WORKER_SUMMARY_FILE_NAME = "worker-summary.json";
export const WORKER_USAGE_FILE_NAME = "usage.json";

/**
 * Explicit truncation marker appended to worker-report.md when the final
 * worker text exceeds MAX_WORKER_REPORT_BYTES. ASCII-only, so it can never
 * be split across a multibyte boundary itself.
 */
export const WORKER_REPORT_TRUNCATION_MARKER =
	"\n\n[WORKER REPORT TRUNCATED — the final worker text exceeds the 524288-byte artifact bound; only this bounded redacted prefix is persisted.]\n";

// ---------------------------------------------------------------------------
// UTF-8-safe truncation
// ---------------------------------------------------------------------------

/**
 * Largest UTF-8-safe prefix of `text` whose byte length does not exceed
 * `maxBytes`. The binary search runs over CODE POINTS (Array.from — one
 * element per code point), never UTF-16 code units, so the cut can never
 * land between the two units of a surrogate pair: a lone high/low
 * surrogate (which Buffer would encode as U+FFFD) is impossible and no
 * replacement character can appear in the result. Malformed inputs
 * (non-string text, non-finite or negative maxBytes) fail safe and return
 * the input unchanged / an empty string respectively — never a throw,
 * never a partial code point.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
	if (typeof text !== "string") return "";
	const limit = Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : 0;
	if (limit <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= limit) return text;
	// Binary search over code-point boundaries (Buffer.byteLength is O(n),
	// so the search is O(n log n) — fine for the 512 KiB report bound).
	const codePoints = Array.from(text);
	let lo = 0;
	let hi = codePoints.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (Buffer.byteLength(codePoints.slice(0, mid).join(""), "utf8") <= limit) lo = mid;
		else hi = mid - 1;
	}
	return codePoints.slice(0, lo).join("");
}

/**
 * Bound one summary item: flatten newlines to spaces, collapse whitespace,
 * trim, and cap at `maxChars` CHARACTERS without splitting surrogate pairs.
 */
export function sanitizeSummaryItem(raw: string, maxChars: number = MAX_SUMMARY_ITEM_CHARS): { text: string; truncated: boolean } {
	const flat = (typeof raw === "string" ? raw : "").replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	if (chars.length <= maxChars) return { text: flat, truncated: false };
	return { text: chars.slice(0, maxChars).join(""), truncated: true };
}

// ---------------------------------------------------------------------------
// Worker cache summary formatters (moved here from worker/runner.ts so the
// handoff module owns the deterministic presentation; runner re-exports)
// ---------------------------------------------------------------------------

export interface WorkerCacheUsage {
	input: number;
	cacheRead: number;
}

/**
 * cacheRead / (input + cacheRead) over the aggregated worker usage;
 * `null` on a zero denominator — never NaN or Infinity.
 */
export function workerCacheHitRatio(usage: WorkerCacheUsage): number | null {
	const denominator = usage.input + usage.cacheRead;
	if (!Number.isFinite(denominator) || denominator <= 0) return null;
	return usage.cacheRead / denominator;
}

/**
 * Deterministic worker cache summary line — same inputs always produce the
 * same string (no locale/formatting dependence). The hit ratio renders N/A
 * when there is no input to hit against (zero denominator).
 */
export function formatWorkerCacheSummary(usage: WorkerCacheUsage): string {
	const ratio = workerCacheHitRatio(usage);
	const hit = ratio === null ? "N/A" : `${Math.round(ratio * 100)}%`;
	return `uncached input ${usage.input} | cache read ${usage.cacheRead} | hit ratio ${hit}`;
}

// ---------------------------------------------------------------------------
// Report section parser (## Completed / ## Files Changed / ## Verification /
// ## Remaining Risks)
// ---------------------------------------------------------------------------

/** The exact final headings the worker prompt requires. */
export const REQUIRED_REPORT_SECTIONS = ["completed", "files changed", "verification", "remaining risks"] as const;

export interface ParsedWorkerReport {
	/** Bounded items of the ## Completed section. */
	completed: string[];
	/**
	 * Bounded item CLAIMS of the ## Files Changed section — prose only.
	 * NEVER used as actual changed paths (those come from the ledger's
	 * digest-based changed_since_before); used only for the parse-warning
	 * divergence check.
	 */
	filesChangedClaims: string[];
	/** Verification items whose first token looks like a command (see isVerificationCommand). */
	verificationCommands: string[];
	/** Remaining verification items (observed results / prose). */
	verificationObservations: string[];
	/** Bounded items of the ## Remaining Risks section. */
	remainingRisks: string[];
	/**
	 * Bounded reliability warning (missing sections, item caps hit,
	 * divergence with the actual diff is appended by the ledger caller);
	 * null when parsing is fully reliable.
	 */
	parseWarning: string | null;
	/** Lower-cased section names actually found. */
	foundSections: string[];
	/** True when any item/section cap was hit (items were truncated). */
	truncatedItems: boolean;
	/**
	 * True when all four required sections are present AND the report is
	 * non-empty: the parsed items can be presented as a summary of the
	 * report. MISSING sections (or an empty report) make parsing
	 * UNRELIABLE and the parent handoff then suppresses ALL parsed items
	 * (no partial section items, no raw fallback). Item-cap hits alone do
	 * NOT flip this flag — capped-but-present sections stay reliable and
	 * render as bounded items plus the explicit truncatedItems fact.
	 */
	reliable: boolean;
}

const REPORT_SECTION_HEADING_RE = /^##\s+([a-z ]+)\s*$/i;
const PARSE_WARNING_MAX_CHARS = 500;

/**
 * Parse the worker's final report into bounded section items. The whole
 * bounded report text (≤ the 2 MiB JSON-event input by construction) is
 * scanned — the sections are required to be at the END of the report, so a
 * head-only scan would miss them on long reports. Every item is sanitized
 * (single-line, ≤ MAX_SUMMARY_ITEM_CHARS characters) and capped at
 * MAX_SUMMARY_ITEMS_PER_SECTION items; caps hit produce a parse warning.
 * Missing required sections, an empty report, or cap hits make parsing
 * unreliable and set parseWarning — callers then degrade to warning +
 * report path + actual changed paths, never a raw-text fallback. The
 * `reliable` flag distinguishes MISSING sections (all parsed items
 * suppressed in the parent) from item-cap truncation (bounded items plus
 * an explicit truncation fact). Malformed input (non-string) yields an
 * empty result with a warning.
 */
export function parseWorkerReport(reportText: unknown): ParsedWorkerReport {
	const text = typeof reportText === "string" ? reportText : "";
	const warnings: string[] = [];
	const found = new Set<string>();
	let truncatedItems = false;
	const sections: Record<string, string[]> = {
		completed: [],
		"files changed": [],
		verification: [],
		"remaining risks": [],
	};
	if (!text.trim()) warnings.push("worker report is empty");
	let current: string | null = null;
	for (const rawLine of text.split("\n")) {
		const trimmed = rawLine.trim();
		const heading = REPORT_SECTION_HEADING_RE.exec(trimmed);
		if (heading) {
			const name = heading[1]!.toLowerCase();
			if ((REQUIRED_REPORT_SECTIONS as readonly string[]).includes(name)) {
				current = name;
				found.add(name);
				continue;
			}
			// Unknown ## heading ends the section being collected.
			current = null;
			continue;
		}
		if (current === null || !trimmed || trimmed.startsWith("```")) continue;
		const bullet = trimmed.replace(/^[-*+]\s+/, "").trim();
		if (!bullet) continue;
		const item = sanitizeSummaryItem(bullet);
		if (item.truncated) truncatedItems = true;
		const list = sections[current]!;
		if (list.length >= MAX_SUMMARY_ITEMS_PER_SECTION) {
			truncatedItems = true;
			continue;
		}
		list.push(item.text);
	}
	const missing = REQUIRED_REPORT_SECTIONS.filter((name) => !found.has(name));
	if (missing.length > 0) warnings.push(`missing required section(s): ${missing.join(", ")}`);
	if (truncatedItems) {
		warnings.push(`section item cap (${MAX_SUMMARY_ITEMS_PER_SECTION} items / ${MAX_SUMMARY_ITEM_CHARS} chars per item) hit; items truncated`);
	}
	const verification = sections["verification"]!;
	const verificationCommands: string[] = [];
	const verificationObservations: string[] = [];
	for (const item of verification) {
		if (isVerificationCommand(item)) verificationCommands.push(item);
		else verificationObservations.push(item);
	}
	return {
		completed: sections["completed"]!,
		filesChangedClaims: sections["files changed"]!,
		verificationCommands,
		verificationObservations,
		remainingRisks: sections["remaining risks"]!,
		parseWarning: warnings.length > 0 ? warnings.join("; ").slice(0, PARSE_WARNING_MAX_CHARS) : null,
		foundSections: [...found],
		truncatedItems,
		reliable: text.trim() !== "" && missing.length === 0,
	};
}

/**
 * Prose stems that never classify a verification item as a command (e.g.
 * "ran unit-test", "exit 0, 10 tests passed", "Run the unit-test recipe").
 */
const PROSE_STEM_STOP: ReadonlySet<string> = new Set([
	"run", "ran", "runs", "ok", "exit", "exited", "passed", "failed", "error", "errors",
	"none", "done", "observed", "results", "result", "see", "checked", "verify", "verified",
	"test", "tests", "passing", "failing", "all", "no", "yes", "and", "the", "with",
	"summary", "note", "notes", "status",
]);

/**
 * Classify one bounded verification item: a COMMAND when it starts with a
 * backticked command claim (the documented `` `npm run typecheck` — exit 0``
 * form) or its first token looks like a command stem followed by at least
 * one argument and is not a prose verb; everything else is an OBSERVATION.
 */
export function isVerificationCommand(item: string): boolean {
	if (/^`[^`]+`/.test(item)) return true;
	const tokens = item.split(/\s+/);
	if (tokens.length < 2) return false;
	const first = tokens[0] ?? "";
	if (!/^[a-zA-Z][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.-]+)*$/.test(first)) return false;
	return !PROSE_STEM_STOP.has(first.toLowerCase());
}

// ---------------------------------------------------------------------------
// Parent handoff builder (NEVER concatenates result.output)
// ---------------------------------------------------------------------------

export interface HandoffUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface HandoffBudgetFacts {
	maxContextTokens: number;
	maxContextRatio: number;
	softBudgetReached: boolean;
	hardBudgetExceeded: boolean;
	compactionCount: number;
	compactionReasons: readonly string[];
}

/**
 * Phase 3 (worker token-budget repair): the canonical cumulative spend
 * facts the parent handoff renders — the SAME object the ledger persists
 * in worker-summary.json/usage.json (single derivation). The runtime
 * passes the ledger's returned worker-summary `spend` object here
 * directly; the renderer never recomputes spend from runner internals or
 * worker prose. Every field is bounded by construction (three fixed
 * literals, finite counters, three boolean pairs, ≤ 3 fixed reason
 * strings).
 */
export interface HandoffSpendFacts {
	profile: WorkerSpendProfile;
	turns: number;
	totalTokens: number;
	outputTokens: number;
	band: WorkerSpendBand;
	softReached: { turns: boolean; totalTokens: boolean; outputTokens: boolean };
	hardExceeded: { turns: boolean; totalTokens: boolean; outputTokens: boolean };
	reasons: readonly WorkerSpendReason[];
}

export type HandoffReviewStatus = "PENDING_REVIEW" | "REVIEWED" | "STALE";
export type HandoffSemanticReview = "accepted" | "repair_required" | "required" | "not_required";

export interface HandoffScopeIntegrityPacket {
	/** Existing bounded/redacted actual-diff presentation from diff-review.ts. */
	lines: readonly string[];
	review_kind: "scope_integrity";
	scope_integrity_verdict: "PASS" | "FAIL";
	bound_diff_hash: string;
	review_record: string;
	presentation_complete: boolean;
	patch_truncated: boolean;
	semantic_review: HandoffSemanticReview;
	semantic_risk: "low" | "medium" | "high";
}

/**
 * The bounded summary facts the parent handoff renders — the subset of the
 * worker-summary.json record the parent uses (the ledger's single
 * derivation). The runtime passes the ledger's returned worker-summary
 * record here directly; it never re-parses the report text for the parent
 * handoff.
 */
export interface HandoffSummary {
	completed: string[];
	verification_commands: string[];
	verification_observations: string[];
	remaining_risks: string[];
	/** Bounded parse warning (missing sections, caps, reported/actual divergence) or null. */
	parse_warning: string | null;
	/**
	 * True when all required report sections were found and the report is
	 * non-empty: parsed items are presentable. When false the parent handoff
	 * suppresses ALL parsed items (safe fallback — no partial section items).
	 */
	parse_reliable: boolean;
	/** True when any section/item cap was hit (bounded-truncation fact). */
	truncated_items: boolean;
}

/** Convert a parsed report into the persisted parent-handoff summary shape. */
export function parsedReportToHandoffSummary(parsed: ParsedWorkerReport): HandoffSummary {
	return {
		completed: [...parsed.completed],
		verification_commands: [...parsed.verificationCommands],
		verification_observations: [...parsed.verificationObservations],
		remaining_risks: [...parsed.remainingRisks],
		parse_warning: parsed.parseWarning,
		parse_reliable: parsed.reliable,
		truncated_items: parsed.truncatedItems,
	};
}

export interface BuildDelegateWorkerResultInput {
	delegationId: string;
	provider?: string | null;
	model?: string | null;
	status: "success" | "failure";
	turns: number;
	exitCode: number | null;
	stopReason?: string | null;
	/** ACTUAL changed paths from collectAfterFacts/ledger — never worker prose. */
	changedPaths: readonly string[];
	usage: HandoffUsage;
	cacheHitRatio: number | null;
	budget: HandoffBudgetFacts;
	/**
	 * Phase 3: the canonical cumulative spend facts object from the
	 * persisted worker-summary record (optional additive — omitted keeps
	 * the pre-Phase-3 handoff shape). When present, the deterministic
	 * `spend budget : …` summary line becomes a required fact line and the
	 * nested bounded `spend` details are rendered.
	 */
	spend?: HandoffSpendFacts;
	/** Project-relative, normalized, contained in the validated delegation directory. */
	reportPath: string;
	/** The SAME bounded summary facts persisted in worker-summary.json (single derivation). */
	summary: HandoffSummary;
	reviewStatus: HandoffReviewStatus;
	/** Present for implementation deliveries; diagnosis/legacy callers may omit it. */
	scopeIntegrityPacket?: HandoffScopeIntegrityPacket;
	failureMessage?: string | null;
}

export interface WorkerHandoffToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	usage: HandoffUsage;
}

/** Recovery tail for a delivery that still needs explicit review. */
export const HANDOFF_COMMANDER_ACTION_LINES = [
	"",
	"--- Commander action required ---",
	"This is an untrusted worker handoff SUMMARY. The complete final worker report is the durable artifact above and is never embedded in this result.",
	"Inspect the scope/integrity actual-diff packet above. If it is complete and correct, use workbench_review_worker_diff with semantic_decision=ACCEPT and the exact expected_bound_diff_hash shown above. If it is complete but wrong, call the same tool with semantic_decision=REPAIR, that exact hash, and a bounded repair_reason; only then follow the reported exact repair_of action. Otherwise request the indicated bounded segments. Neither ACCEPT nor REPAIR is Gate authority; run final verification and gates independently.",
];

/** Completion tail for the ordinary one-call delivery path. */
export const HANDOFF_DEFAULT_DELIVERY_COMPLETE_LINES = [
	"",
	"--- Ordinary delivery complete ---",
	"Internal scope/review closure is complete; no manual review/status/repair command is required.",
	"This is DEV evidence only; applicable final verification, Gates, research, release, and profit authority remain separate.",
];

/** Project-relative sibling artifact path derived from the report path. */
export function reportPathSibling(reportPath: string, fileName: string): string {
	return reportPath.replace(/worker-report\.md$/, fileName);
}

/**
 * Bounded changed-path display line: whole paths only (never cut mid-path),
 * at most MAX_HANDOFF_SHOWN_PATHS and MAX_HANDOFF_PATHS_LINE_BYTES bytes,
 * with an explicit omission count when paths are not shown.
 */
export function changedPathsLine(paths: readonly string[]): string {
	if (paths.length === 0) return "changed paths : (none) (actual diff from the ledger — never worker prose)";
	const shown: string[] = [];
	// Cumulative byte accounting over the WHOLE line — whole paths only.
	let bytes = Buffer.byteLength("changed paths : ", "utf8");
	for (const path of paths) {
		if (shown.length >= MAX_HANDOFF_SHOWN_PATHS) break;
		const separatorBytes = shown.length === 0 ? 0 : 2;
		const pathBytes = Buffer.byteLength(path, "utf8");
		if (bytes + separatorBytes + pathBytes > MAX_HANDOFF_PATHS_LINE_BYTES) break;
		shown.push(path);
		bytes += separatorBytes + pathBytes;
	}
	const omitted = paths.length - shown.length;
	const suffix = omitted > 0 ? ` … (${omitted} more omitted)` : "";
	return `changed paths : ${shown.join(", ")}${suffix} (actual diff from the ledger — never worker prose)`;
}

/**
 * Build the bounded parent toolResult for a finished delegation.
 *
 * NEVER concatenates result.output / report / patch / test logs. The
 * rendered content is capped to ≤ MAX_PARENT_HANDOFF_LINES lines and ≤
 * MAX_PARENT_HANDOFF_BYTES UTF-8 bytes by reserving EVERY required fact
 * line (delegation/status/identity/turns, bounded actual changed paths
 * with an omission count, usage/cache/budget, the worker-report /
 * worker-summary / usage artifact paths, parse-warning / failure / review
 * facts) and dropping optional summary items only as WHOLE sanitized lines
 * until both global caps hold — a rendered line is never cut mid-item or
 * mid-code-point. The fixed commander-action tail is always preserved.
 * When the report sections are missing/unreliable (parse_reliable false)
 * the parent contains NO partial parsed section items — only the parse
 * warning, the durable artifact paths, the actual changed paths, the
 * status/identity/turn/usage/cache/budget/review facts, and the commander
 * action. Structured details are tightly bounded (changed paths capped,
 * failure/identity/stop strings bounded) and carry no
 * output/full_report/transcript/patch/log content and no allowed_paths.
 * Top-level nested worker usage is preserved for the cost accounting
 * split (core/cost-breakdown.ts).
 */
export function buildDelegateWorkerResult(input: BuildDelegateWorkerResultInput): WorkerHandoffToolResult {
	const items = (list: readonly string[]): string[] => list.map((raw) => sanitizeSummaryItem(raw).text);
	// Required fact lines — ALWAYS preserved by the caps below.
	const required: string[] = [];
	required.push(`delegation    : ${input.delegationId} — ${input.status.toUpperCase()}`);
	const identity = sanitizeSummaryItem(`${input.provider ?? "(none)"}/${input.model ?? "(none)"}`, MAX_HANDOFF_IDENTITY_CHARS).text;
	required.push(`provider/model: ${identity}`);
	const stop = input.stopReason ? sanitizeSummaryItem(input.stopReason, MAX_HANDOFF_STOP_REASON_CHARS).text : "";
	required.push(`turns         : ${input.turns}${input.exitCode !== null ? ` | exit code: ${input.exitCode}` : ""}${stop ? ` | stop: ${stop}` : ""}`);
	required.push(changedPathsLine(input.changedPaths));
	required.push(`worker cache  : ${formatWorkerCacheSummary(input.usage)}`);
	required.push(`worker budget : ${formatWorkerBudgetSummary(input.budget.maxContextTokens, input.budget.maxContextRatio)}`);
	// Phase 3: the deterministic spend summary line, derived from the SAME
	// persisted worker-summary spend object (never recomputed, never from
	// worker prose). The deterministic formatter renders the profile's HARD
	// limits as denominators.
	if (input.spend) {
		required.push(formatWorkerSpendSummary({ turns: input.spend.turns, totalTokens: input.spend.totalTokens, outputTokens: input.spend.outputTokens }, input.spend.profile));
	}
	required.push(`report        : ${input.reportPath} (complete final worker report; bounded ${MAX_WORKER_REPORT_BYTES}-byte artifact, never embedded here)`);
	required.push(`summary       : ${reportPathSibling(input.reportPath, WORKER_SUMMARY_FILE_NAME)}`);
	required.push(`usage facts   : ${reportPathSibling(input.reportPath, WORKER_USAGE_FILE_NAME)}`);
	if (input.summary.parse_warning) {
		required.push(`PARSE WARNING : ${sanitizeSummaryItem(input.summary.parse_warning, PARSE_WARNING_MAX_CHARS).text}`);
	}
	if (input.failureMessage) {
		required.push(`failure       : ${sanitizeSummaryItem(input.failureMessage, MAX_HANDOFF_FAILURE_CHARS).text}`);
	}
	const scopePacket = input.scopeIntegrityPacket;
	const ordinaryCandidateReady = input.reviewStatus === "REVIEWED" && scopePacket !== undefined &&
		(scopePacket.semantic_review === "accepted" || scopePacket.semantic_review === "not_required");
	let packetStatusIndex = -1;
	if (scopePacket) {
		required.push(`review kind   : ${scopePacket.review_kind} — mechanical scope/integrity only; not semantic quality or Gate authority`);
		required.push(`scope result  : ${scopePacket.scope_integrity_verdict}`);
		required.push(`bound diff    : ${scopePacket.bound_diff_hash}`);
		required.push(`scope artifact: ${scopePacket.review_record}`);
		required.push(`semantic review: ${scopePacket.semantic_review} | risk=${scopePacket.semantic_risk}`);
		if (ordinaryCandidateReady) {
			required.push(`candidate     : READY_FOR_FINAL_VERIFICATION | binding=${scopePacket.bound_diff_hash} | authority=DEVELOPMENT_ONLY`);
		}
		packetStatusIndex = required.length;
		required.push("packet display: PENDING");
	}
	if (input.reviewStatus === "PENDING_REVIEW") {
		required.push(`review        : PENDING_REVIEW — scope/integrity presentation is not semantic ACCEPT; the next delegation and VERIFY stay blocked`);
	} else if (input.reviewStatus === "STALE") {
		required.push(`review        : STALE — the accepted hash drifted; fresh scope/integrity evidence is required before the next delegation or VERIFY`);
	} else {
		required.push(`review        : REVIEWED — semantic acceptance recorded or zero-delta closure; this is not Gate authority`);
	}

	// Optional summary items — dropped only as whole sanitized lines.
	const optional: string[] = [];
	if (input.summary.parse_reliable) {
		if (input.summary.truncated_items) {
			required.push(`item caps     : hit (max ${MAX_SUMMARY_ITEMS_PER_SECTION} items / ${MAX_SUMMARY_ITEM_CHARS} chars per item) — overflow items dropped`);
		}
		const completed = items(input.summary.completed);
		if (completed.length > 0) {
			optional.push("completed     :");
			for (const item of completed) optional.push(`  - ${item}`);
		}
		const verification = [...items(input.summary.verification_commands), ...items(input.summary.verification_observations)].slice(
			0,
			MAX_SUMMARY_ITEMS_PER_SECTION,
		);
		if (verification.length > 0) {
			optional.push("verification  :");
			for (const item of verification) optional.push(`  - ${item}`);
		}
		const risks = items(input.summary.remaining_risks);
		if (risks.length > 0) {
			optional.push("remaining risk:");
			for (const item of risks) optional.push(`  - ${item}`);
		}
	} else {
		required.push(`parsed items  : suppressed — report sections missing/unreliable (the durable report artifact above is the source of truth)`);
	}

	// Assemble: actual-diff scope/integrity evidence has priority over worker
	// summary prose.  Keep whole packet lines only; if the 12 KiB/120-line
	// handoff envelope cannot carry them all, preserve PENDING_REVIEW and add
	// an explicit recovery marker rather than cutting a diff line.
	const tailLines = input.reviewStatus === "REVIEWED"
		? HANDOFF_DEFAULT_DELIVERY_COMPLETE_LINES
		: HANDOFF_COMMANDER_ACTION_LINES;
	const tailText = tailLines.join("\n");
	const tailBytes = Buffer.byteLength(tailText, "utf8");
	const bodyBudget = Math.max(MAX_PARENT_HANDOFF_BYTES - tailBytes, 0);
	const maxBodyLines = MAX_PARENT_HANDOFF_LINES - tailLines.length;
	const packetHeader = scopePacket && !ordinaryCandidateReady ? ["", "--- Scope/integrity actual-diff packet (bounded/redacted) ---"] : [];
	const rawPacketLines = scopePacket && !ordinaryCandidateReady
		? scopePacket.lines.flatMap((line) => (typeof line === "string" ? line : "(invalid)").split("\n"))
		: [];
	let keptPacket = [...rawPacketLines];
	const packetClipMarker = "[handoff packet clipped by the 12 KiB/120-line envelope — call workbench_review_worker_diff without semantic_decision for bounded presentation; PENDING_REVIEW is preserved]";
	let packetClipped = false;
	let bodyLines = [...required, ...packetHeader, ...keptPacket];
	while (
		keptPacket.length > 0
		&& (bodyLines.length > maxBodyLines || Buffer.byteLength(bodyLines.join("\n"), "utf8") > bodyBudget)
	) {
		keptPacket = keptPacket.slice(0, -1);
		packetClipped = true;
		bodyLines = [...required, ...packetHeader, ...keptPacket];
	}
	if (packetClipped) {
		while (
			keptPacket.length > 0
			&& (
				bodyLines.length + 1 > maxBodyLines
				|| Buffer.byteLength([...bodyLines, packetClipMarker].join("\n"), "utf8") > bodyBudget
			)
		) {
			keptPacket = keptPacket.slice(0, -1);
			bodyLines = [...required, ...packetHeader, ...keptPacket];
		}
		if (bodyLines.length < maxBodyLines && Buffer.byteLength([...bodyLines, packetClipMarker].join("\n"), "utf8") <= bodyBudget) {
			bodyLines.push(packetClipMarker);
		}
	}
	const embeddedPresentationComplete = scopePacket !== undefined
		&& scopePacket.presentation_complete
		&& !packetClipped
		&& keptPacket.length === rawPacketLines.length;
	if (packetStatusIndex >= 0) {
		const packetQualifier = packetClipped
			? " (handoff envelope clipped)"
			: scopePacket?.patch_truncated
				? embeddedPresentationComplete
					? " (strict compact facts complete; source content summarized)"
					: " (ordinary source patch truncated)"
				: "";
		required[packetStatusIndex] = `packet display: ${embeddedPresentationComplete ? "COMPLETE" : "INCOMPLETE"}${packetQualifier}`;
		bodyLines[packetStatusIndex] = required[packetStatusIndex]!;
	}
	const optionalForHandoff = ordinaryCandidateReady ? [] : optional;
	let kept = [...optionalForHandoff];
	bodyLines = [...bodyLines, ...kept];
	while (
		kept.length > 0 &&
		(bodyLines.length > maxBodyLines || Buffer.byteLength(bodyLines.join("\n"), "utf8") > bodyBudget)
	) {
		kept = kept.slice(0, -1);
		bodyLines = [
			...required,
			...packetHeader,
			...keptPacket,
			...(packetClipped && bodyLines.includes(packetClipMarker) ? [packetClipMarker] : []),
			...kept,
		];
	}
	const dropped = optionalForHandoff.length - kept.length;
	if (dropped > 0) {
		const marker = `… (${dropped} optional summary line(s) omitted to fit the bounded handoff)`;
		if (bodyLines.length < maxBodyLines && Buffer.byteLength([...bodyLines, marker].join("\n"), "utf8") <= bodyBudget) {
			bodyLines = [...bodyLines, marker];
		}
	}
	const text = `${bodyLines.join("\n")}${tailText}`;

	const details: Record<string, unknown> = {
		delegation_id: input.delegationId,
		status: input.status,
		report_path: input.reportPath,
		summary: {
			completed: input.summary.parse_reliable ? items(input.summary.completed) : [],
			verification_commands: input.summary.parse_reliable ? items(input.summary.verification_commands) : [],
			verification_observations: input.summary.parse_reliable ? items(input.summary.verification_observations) : [],
			remaining_risks: input.summary.parse_reliable ? items(input.summary.remaining_risks) : [],
			parse_warning: input.summary.parse_warning,
			parse_reliable: input.summary.parse_reliable,
			truncated_items: input.summary.truncated_items,
		},
		changed_paths: input.changedPaths.slice(0, MAX_HANDOFF_DETAIL_PATHS),
		provider: input.provider ? sanitizeSummaryItem(input.provider, MAX_HANDOFF_IDENTITY_CHARS).text : null,
		model: input.model ? sanitizeSummaryItem(input.model, MAX_HANDOFF_IDENTITY_CHARS).text : null,
		turns: input.turns,
		exit_code: input.exitCode,
		stop_reason: input.stopReason ? sanitizeSummaryItem(input.stopReason, MAX_HANDOFF_STOP_REASON_CHARS).text : null,
		usage: input.usage,
		cache_hit_ratio: input.cacheHitRatio,
		max_context_tokens: input.budget.maxContextTokens,
		max_context_ratio: input.budget.maxContextRatio,
		soft_budget_reached: input.budget.softBudgetReached,
		hard_budget_exceeded: input.budget.hardBudgetExceeded,
		compaction_count: input.budget.compactionCount,
		compaction_reasons: [...input.budget.compactionReasons],
		review_status: input.reviewStatus,
		failure_message: input.failureMessage ? sanitizeSummaryItem(input.failureMessage, MAX_HANDOFF_FAILURE_CHARS).text : null,
	};
	if (scopePacket) {
		details.review_kind = scopePacket.review_kind;
		details.scope_integrity_verdict = scopePacket.scope_integrity_verdict;
		details.bound_diff_hash = scopePacket.bound_diff_hash;
		details.review_record = scopePacket.review_record;
		details.presentation_complete = embeddedPresentationComplete;
		details.patch_truncated = scopePacket.patch_truncated || packetClipped;
		details.semantic_review = scopePacket.semantic_review;
		details.semantic_risk = scopePacket.semantic_risk;
		details.gate_authority = false;
		if (ordinaryCandidateReady) {
			details.ordinary_candidate = {
				status: "READY_FOR_FINAL_VERIFICATION",
				binding_hash: scopePacket.bound_diff_hash,
				authority_scope: "DEVELOPMENT_ONLY",
				gate_authority: false,
				research_authority: false,
				release_authority: false,
				profit_authority: false,
			};
		}
	}
	// Phase 3: the nested bounded spend details — the exact canonical spend
	// object persisted in worker-summary.json (same fields, same values,
	// single derivation). Only present when the ledger record carried it.
	if (input.spend) {
		details.spend = {
			profile: input.spend.profile,
			turns: input.spend.turns,
			totalTokens: input.spend.totalTokens,
			outputTokens: input.spend.outputTokens,
			band: input.spend.band,
			softReached: { ...input.spend.softReached },
			hardExceeded: { ...input.spend.hardExceeded },
			reasons: [...input.spend.reasons],
		};
	}

	return {
		content: [{ type: "text", text }],
		details,
		usage: input.usage,
	};
}
