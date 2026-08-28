/**
 * Historical P7 delegation schema v1 — strict read compatibility, shared
 * bounded Git-fact primitives, and retained public types. Production
 * create/finish exports fail closed; current delegation writes use v2 only.
 * Pure logic with injected exec (git calls are argv-only, shell=false), no Pi
 * imports.
 *
 * Layout: `<project-root>/<CONFIG_DIR_NAME>/workbench/delegations/<id>/`
 *   manifest.json        — status + git/diff hash summary
 *   before.json          — bounded contract, git HEAD/dirty, before diff
 *                          hash and per-path status codes + content digests
 *                          (Phase 3: the resolved spend-budget profile is
 *                          recorded additively as contract.budget_profile)
 *   after.json           — success/failure outcome, pinned identity,
 *                          status/exit, TRUE paths changed since before
 *                          (including previously-dirty paths via digests),
 *                          after diff hash, usage/budget facts, bounded
 *                          redacted report summary, safe reported_paths
 *                          parsed from the worker's ## Files Changed
 *                          section, review PENDING_REVIEW (spend facts are
 *                          deliberately NOT duplicated here — usage.json /
 *                          worker-summary.json are their records)
 *   worker-report.md     — the REDACTED complete final worker text (redacted
 *                          FIRST, then bounded to MAX_WORKER_REPORT_BYTES
 *                          (512 KiB) with the explicit truncation marker
 *                          ONLY when the REDACTED report still exceeds the
 *                          bound), UTF-8-safe, mode 0600, atomic
 *                          temp+rename; persisted only — never part of any
 *                          parent result
 *   worker-summary.json  — bounded redacted worker report facts + ACTUAL
 *                          changed paths + parsed section items + parse
 *                          reliability/truncation facts + report path +
 *                          cache ratio + parse warning (the SINGLE summary
 *                          derivation the parent handoff renders); Phase 3:
 *                          carries the canonical cumulative `spend` object
 *   usage.json           — bounded structured usage/cache/budget/turn facts;
 *                          Phase 3: carries the same canonical `spend` object
 *   review.json          — bounded PENDING_REVIEW placeholder written at
 *                          finish; REPLACED by the review service
 *                          (core/diff-review.ts) with the completed record
 *
 * Security/discipline rules:
 *   - git calls go through the injected ExecFn with argv arrays only
 *     (shell=false is the caller's contract — the same exec used for
 *     recipes); no shell strings, no user-controlled flags
 *   - the exported atomic helpers remain for bounded compatibility fixtures;
 *     production lifecycle code cannot use them to create schema-v1 ledgers
 *   - the ledger's own directory is excluded from the git facts it
 *     records, so its records can never pollute the diff they describe;
 *     the P8b tool-result receipts subtree is excluded the same way
 *     (before the cap, digests and statuses), so recovery artifacts are
 *     never part of the recorded diff either
 *   - the ledger only records facts; it never computes business metrics
 *     and never modifies project files
 */

import { randomBytes } from "node:crypto";
import { open, mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { canonicalHash, sha256HexBytes } from "../cache/canonical-hash.ts";
import type { ExecFn } from "./config.ts";
import type {
	WorkerSpendBand,
	WorkerSpendDimensionFlags,
	WorkerSpendProfile,
	WorkerSpendReason,
	WorkerSpendState,
} from "./worker-spend.ts";
import type { WorkerRunFailureCode } from "./worker-run-failure.ts";
import { resolveWorkerBudgetProfile, resolveWorkerRepairOf } from "./worker-policy.ts";
import { readJsonFileBounded, type BoundedFileIoHooks } from "./bounded-file-io.ts";
import {
	MAX_WORKER_REPORT_BYTES,
	WORKER_REPORT_FILE_NAME,
} from "../worker/handoff.ts";

export const DELEGATION_SCHEMA_VERSION = 1;
/** Every JSON authority record in one delegation ledger is size-preflighted before allocation. */
export const DELEGATION_RECORD_MAX_BYTES = 1_048_576 as const;

export const DELEGATION_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/;

/** Ids share the run-id shape (time-based, random suffix), strictly validated. */
export function makeDelegationId(date: Date): string {
	const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
	const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
	return `${stamp}-${rand}`;
}

/** Validate a delegation id strictly (also protects against path traversal). */
export function isValidDelegationId(id: string): boolean {
	return DELEGATION_ID_RE.test(id);
}

/** The delegations root: <root>/<CONFIG_DIR_NAME>/workbench/delegations. */
export function delegationsDir(projectRoot: string): string {
	return join(resolve(projectRoot), CONFIG_DIR_NAME, "workbench", "delegations");
}

/** The per-delegation directory; throws on an invalid id (path traversal guard). */
export function delegationDirFor(projectRoot: string, delegationId: string): string {
	if (!isValidDelegationId(delegationId)) throw new Error(`invalid delegation id "${delegationId}"`);
	return join(delegationsDir(projectRoot), delegationId);
}

// ---------------------------------------------------------------------------
// Bounds (compact-safety: every recorded fact is bounded)
// ---------------------------------------------------------------------------

/**
 * Hard cap on the recorded changed-path set. Collection FAILS CLOSED
 * beyond this bound (see collectGitFacts) — a truncated path set must
 * never feed diff hashing or scope review.
 */
export const MAX_CHANGED_PATHS = 500;
export const MAX_PATH_LENGTH = 400;
/** Content digest reads at most this many bytes per file (size suffix beyond). */
export const MAX_DIGEST_BYTES = 4 * 1024 * 1024;
export const MAX_TASK_CHARS = 10_000;
export const MAX_ALLOWED_PATHS = 50;
export const MAX_ACCEPTANCE_CRITERIA = 20;
export const MAX_VERIFICATION_STEPS = 20;
export const MAX_REPORT_SUMMARY_CHARS = 8_000;
/**
 * Explicit scan window for parseReportedPaths: the worker report's
 * `## Files Changed` section is parsed only from the first N characters
 * of the raw report text. The window equals the durable bounded report
 * artifact bound (MAX_WORKER_REPORT_BYTES): the STORED report is capped at
 * that size by the ledger, so the whole stored report is scannable (the
 * required sections sit at the END of the report), while the raw runner
 * text (bounded by its 2 MiB JSON-event input) can never make parsing
 * unbounded. A line cut by the window is dropped, never reported partially.
 */
export const MAX_REPORTED_PATHS_SCAN_CHARS = MAX_WORKER_REPORT_BYTES;
export const MAX_AFTER_SUMMARY_CHARS = 2_000;
export const MAX_ERROR_MESSAGE_CHARS = 500;
export const MAX_STOP_REASON_CHARS = 100;

// ---------------------------------------------------------------------------
// Git facts
// ---------------------------------------------------------------------------

export interface GitFacts {
	/** HEAD commit hash, or null outside a git repo / before the first commit. */
	gitHead: string | null;
	/** True when the collected changed-path set is non-empty. */
	gitDirty: boolean;
	/** Sorted project-relative changed paths (bounded; ledger dir excluded). */
	changedPaths: string[];
	/**
	 * Raw porcelain XY status code per changed path (e.g. " M", "??", "D ",
	 * "R ") — path identity facts that make the diff state sensitive to
	 * tracked/untracked/staged/deleted/rename transitions even when content
	 * digests collide (e.g. delete + recreate with identical bytes). Only
	 * status codes and digests are ever persisted — never raw patch text.
	 */
	pathStatuses: Record<string, string>;
	/** Per-path bounded content digests for paths that are readable files. */
	pathDigests: Record<string, string>;
	/**
	 * Current porcelain rename pairing (destination -> source). This is a
	 * live checkpoint guard, not a persisted authority field: new records bind
	 * both paths through changedPaths/statuses, while legacy destination-only
	 * records can be rejected before a partial path-limited commit.
	 */
	renameSources?: Record<string, string>;
}

export interface AfterFacts extends GitFacts {
	/** TRUE paths changed since the before snapshot (digest-based, so
	 * previously-dirty paths are included when their content changed). */
	changedSinceBefore: string[];
	/** Deterministic hash of the whole current tree diff. */
	diffHash: string;
}

/** The bounded task contract recorded with a delegation. */
export interface LedgerContract {
	task: string;
	allowedPaths: readonly string[];
	acceptanceCriteria: readonly string[];
	verification: readonly string[];
	timeoutSeconds: number;
	/**
	 * Phase 3 (worker token-budget repair): the resolved cumulative
	 * spend-budget profile (additive, optional). Omitted resolves to
	 * `standard` in boundLedgerContract — new before records always carry
	 * the resolved literal.
	 */
	budgetProfile?: WorkerSpendProfile;
	/**
	 * Phase 4A (worker repair contract): optional strict repair-provenance
	 * pointer to the delegation id being repaired. Resolved by
	 * resolveWorkerRepairOf in boundLedgerContract — omitted stays absent
	 * (ordinary delegations never carry the key); anything malformed FAILS
	 * CLOSED before any ledger record or child launch.
	 */
	repairOf?: string;
}

export interface LedgerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface LedgerBudget {
	maxContextTokens: number;
	maxContextRatio: number;
	softBudgetReached: boolean;
	hardBudgetExceeded: boolean;
	compactionCount: number;
	compactionReasons: string[];
}

/**
 * Phase 3 (worker token-budget repair): the canonical cumulative spend
 * facts object persisted additively in usage.json and worker-summary.json
 * for every newly finished delegation (success AND failure). `profile` is
 * the resolved profile the run accumulated against; `reasons` entries are
 * exactly `"turns" | "total_tokens" | "output_tokens"` in the fixed
 * order. Old schema_version 1 records without this object remain readable
 * (no migration, no rewrite).
 */
export interface LedgerSpendFacts {
	profile: WorkerSpendProfile;
	turns: number;
	totalTokens: number;
	outputTokens: number;
	band: WorkerSpendBand;
	softReached: { turns: boolean; totalTokens: boolean; outputTokens: boolean };
	hardExceeded: { turns: boolean; totalTokens: boolean; outputTokens: boolean };
	reasons: WorkerSpendReason[];
}

export interface LedgerWorkerFacts {
	provider: string | null;
	model: string | null;
	status: "success" | "failure";
	/** Current v2 machine outcome; absent only for historical/legacy callers. */
	workerSuccess?: boolean;
	/** Current v2 closed failure category; null iff workerSuccess is true. */
	workerFailureCode?: WorkerRunFailureCode | null;
	exitCode: number | null;
	turns: number;
	stopReason: string | null;
	errorMessage: string | null;
	usage: LedgerUsage;
	/** cacheRead / (input + cacheRead) over the whole run; null on a zero denominator. */
	cacheHitRatio: number | null;
	budget: LedgerBudget;
	/**
	 * Phase 3 (worker token-budget repair): the cumulative spend facts of
	 * the run (profile, final state, band, fixed-order reasons, per-
	 * dimension soft/hard flags) — recorded on EVERY outcome exactly as the
	 * runner produced them, so hard spend failures are ledgered with the
	 * spend hard flags/reasons and the dimension-named error. Optional /
	 * additive: legacy callers that omit the spend facts stay source-
	 * compatible and their records keep the pre-repair shape (readable, no
	 * migration); finishDelegationLedger writes the canonical `spend`
	 * object only when ALL six facts are present.
	 */
	spendProfile?: WorkerSpendProfile;
	spendState?: WorkerSpendState;
	spendBand?: WorkerSpendBand;
	spendReasons?: WorkerSpendReason[];
	spendSoftReached?: WorkerSpendDimensionFlags["soft"];
	spendHardExceeded?: WorkerSpendDimensionFlags["hard"];
	/** Bounded final worker report text (redacted by the caller-provided secrets). */
	reportSummary: string;
}

// ---------------------------------------------------------------------------
// Records (manifest.json / before.json / after.json / worker-summary.json)
// ---------------------------------------------------------------------------

export interface DelegationManifest {
	schema_version: number;
	delegation_id: string;
	created_at: string;
	finished_at: string | null;
	status: "running" | "finished";
	review_status: "PENDING_REVIEW";
	git_head_before: string | null;
	git_dirty_before: boolean;
	diff_hash_before: string;
	diff_hash_after: string | null;
	changed_path_count_before: number;
	changed_path_count_after: number | null;
	changed_since_before_count: number | null;
}

export interface LedgerBeforeRecord {
	schema_version: number;
	delegation_id: string;
	recorded_at: string;
	contract: {
		task: string;
		allowed_paths: string[];
		acceptance_criteria: string[];
		verification: string[];
		timeout_seconds: number;
		/**
		 * Phase 3: the resolved spend-budget profile of the delegation.
		 * OPTIONAL on the record type because pre-repair schema_version 1
		 * records genuinely omit it — reads of those expose `undefined` and
		 * they are never rewritten (additive, no migration). New before
		 * records ALWAYS carry the resolved literal: boundLedgerContract
		 * resolves omitted to `standard` before any write.
		 */
		budget_profile?: string;
		/**
		 * Phase 4A: optional strict repair-provenance pointer (the
		 * delegation id being repaired). Absent on ordinary records;
		 * present ONLY when the raw contract carried a valid id —
		 * boundLedgerContract resolves it via resolveWorkerRepairOf and
		 * fails closed on anything malformed.
		 */
		repair_of?: string;
	};
	git_head: string | null;
	git_dirty: boolean;
	diff_hash: string;
	changed_paths: string[];
	path_statuses: Record<string, string>;
	path_digests: Record<string, string>;
}

export interface LedgerAfterRecord {
	schema_version: number;
	delegation_id: string;
	recorded_at: string;
	status: "success" | "failure";
	worker_success?: boolean;
	worker_failure_code?: WorkerRunFailureCode | null;
	exit_code: number | null;
	pinned_identity: {
		pinned_provider: string;
		pinned_model: string;
		provider: string | null;
		model: string | null;
	};
	git_head: string | null;
	git_dirty: boolean;
	diff_hash: string;
	changed_paths: string[];
	path_statuses: Record<string, string>;
	path_digests: Record<string, string>;
	changed_since_before: string[];
	/**
	 * Safe project-relative paths parsed from the worker report's bounded
	 * ## Files Changed section (see parseReportedPaths). Empty when the
	 * section is missing or contains no valid paths — the review then warns.
	 */
	reported_paths: string[];
	usage: LedgerUsage;
	budget: LedgerBudget;
	report_summary: string;
	review_status: "PENDING_REVIEW";
}

/**
 * Bounded PENDING_REVIEW placeholder persisted as review.json at finish
 * (before any review exists). The review service (core/diff-review.ts)
 * REPLACES it with the completed ReviewRecord; readReviewRecord treats the
 * placeholder as "no review yet".
 */
export interface PendingReviewPlaceholder {
	schema_version: number;
	delegation_id: string;
	recorded_at: string;
	review_status: "PENDING_REVIEW";
	message: string;
}

export interface LedgerWorkerSummaryRecord {
	schema_version: number;
	delegation_id: string;
	recorded_at: string;
	provider: string | null;
	model: string | null;
	status: "success" | "failure";
	worker_success?: boolean;
	worker_failure_code?: WorkerRunFailureCode | null;
	exit_code: number | null;
	turns: number;
	stop_reason: string | null;
	error_message: string | null;
	usage: LedgerUsage;
	cache_hit_ratio: number | null;
	budget: LedgerBudget;
	/** Phase 3: the canonical cumulative spend facts object (additive; absent on legacy-shaped records). */
	spend?: LedgerSpendFacts;
	report_summary: string;
	// P7 bounded-handoff additions: the ACTUAL changed paths (digest-based
	// changed_since_before — never worker prose) and the bounded parsed
	// section items plus the artifact path and a parse warning when the
	// report sections are missing/unreliable.
	changed_paths: string[];
	completed: string[];
	verification_commands: string[];
	verification_observations: string[];
	remaining_risks: string[];
	report_path: string;
	parse_warning: string | null;
	/**
	 * True when all four required report sections were found and the report
	 * is non-empty: the parsed section items are presentable. When false the
	 * parent handoff suppresses ALL parsed items (safe fallback — no partial
	 * section items, no raw fallback).
	 */
	parse_reliable: boolean;
	/** True when any section/item cap was hit (bounded-truncation fact). */
	truncated_items: boolean;
}

/**
 * Bounded structured usage/cache/budget/turn facts persisted as usage.json
 * for every finished delegation (success AND failure). The nested worker
 * usage shape is preserved exactly (top-level cost accounting).
 */
export interface DelegationUsageRecord {
	schema_version: number;
	delegation_id: string;
	recorded_at: string;
	provider: string | null;
	model: string | null;
	status: "success" | "failure";
	worker_success?: boolean;
	worker_failure_code?: WorkerRunFailureCode | null;
	exit_code: number | null;
	turns: number;
	stop_reason: string | null;
	error_message: string | null;
	usage: LedgerUsage;
	cache_hit_ratio: number | null;
	budget: LedgerBudget;
	/** Phase 3: the canonical cumulative spend facts object (additive; absent on legacy-shaped records). */
	spend?: LedgerSpendFacts;
}

/** Everything the ledger knows about one delegation (review.json excluded — the review service owns it). */
export interface DelegationLedger {
	manifest: DelegationManifest;
	before: LedgerBeforeRecord;
	after: LedgerAfterRecord | null;
	workerSummary: LedgerWorkerSummaryRecord | null;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * True when a project-relative candidate lies inside the workbench
 * delegation-records directory. The ledger never counts its own records as
 * project changes — otherwise every delegation would dirty the very diff it
 * records.
 */
export function isDelegationRecordPath(projectRoot: string, candidatePath: string): boolean {
	const rel = normalizeStatusPath(candidatePath);
	if (!rel) return false;
	const prefix = `${CONFIG_DIR_NAME}/workbench/delegations`;
	return rel === prefix || rel.startsWith(`${prefix}/`);
}

/**
 * True when a project-relative candidate is a P8b tool-result receipt
 * (`.pi/workbench/tool-results/<descendant>`, or the receipts directory
 * itself). Receipts are recovery artifacts, never project changes — the
 * ledger excludes them from the git facts it records exactly like its own
 * delegation records. The prefix match is sibling-safe by construction:
 * the trailing `/` guard means `.pi/workbench/tool-results-extra/...` and
 * `.pi/workbench/other/...` never match.
 */
export function isToolResultReceiptPath(projectRoot: string, candidatePath: string): boolean {
	const rel = normalizeStatusPath(candidatePath);
	if (!rel) return false;
	const prefix = `${CONFIG_DIR_NAME}/workbench/tool-results`;
	return rel === prefix || rel.startsWith(`${prefix}/`);
}

/**
 * True only for the fixed project delegation-start lock and the bounded,
 * token-suffixed publication/release/recovery siblings created by the lock
 * implementation. These files are workbench coordination artifacts, not
 * project changes. Keep the match exact: similarly named user files and
 * descendants remain visible to drift detection.
 */
export function isDelegationStartLockArtifactPath(_projectRoot: string, candidatePath: string): boolean {
	const rel = normalizeStatusPath(candidatePath);
	if (!rel) return false;
	const fixed = `${CONFIG_DIR_NAME}/workbench/delegation-start.lock`;
	if (rel === fixed) return true;
	if (!rel.startsWith(`${fixed}.`)) return false;
	return /^\.(?:candidate|release|recovered)\.[a-f0-9]{32}$/.test(rel.slice(fixed.length));
}

/**
 * Normalize a porcelain path to forward-slash project-relative form.
 * Absolute POSIX/Windows/backslash paths and `..` escapes are refused
 * (returns undefined). Empty and `.` segments are dropped.
 */
export function normalizeStatusPath(raw: string): string | undefined {
	if (!raw) return undefined;
	if (raw.startsWith("/") || raw.startsWith("\\")) return undefined;
	if (/^[A-Za-z]:/.test(raw)) return undefined;
	const segments = raw.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
	if (segments.length === 0) return undefined;
	for (const segment of segments) {
		if (segment === "..") return undefined;
	}
	const path = segments.join("/");
	if (path.length > MAX_PATH_LENGTH) return undefined;
	return path;
}

/**
 * Decode one Git `core.quotePath` C-quoted path. Git emits non-ASCII path
 * bytes as three-digit octal escapes, so decoding escapes directly into a
 * JavaScript string would corrupt multi-byte UTF-8 names. Build the original
 * bytes first, then perform one fatal UTF-8 decode. Unknown/incomplete
 * escapes, impossible bytes and NUL are rejected rather than fabricated.
 */
function unquotePorcelainPath(raw: string): string | undefined {
	if (!raw.startsWith('"')) return raw;
	if (!raw.endsWith('"') || raw.length < 2) return undefined;

	const bytes: number[] = [];
	const end = raw.length - 1;
	let i = 1;
	while (i < end) {
		const ch = raw[i]!;
		if (ch === '"') return undefined;
		if (ch !== "\\") {
			const codePoint = raw.codePointAt(i);
			if (codePoint === undefined) return undefined;
			const literal = String.fromCodePoint(codePoint);
			bytes.push(...Buffer.from(literal, "utf8"));
			i += literal.length;
			continue;
		}

		const next = raw[i + 1];
		if (next === undefined || i + 1 >= end) return undefined;
		const safeEscapeBytes: Readonly<Record<string, number>> = {
			a: 0x07,
			b: 0x08,
			t: 0x09,
			n: 0x0a,
			v: 0x0b,
			f: 0x0c,
			r: 0x0d,
			"\\": 0x5c,
			'"': 0x22,
		};
		const safeByte = safeEscapeBytes[next];
		if (safeByte !== undefined) {
			bytes.push(safeByte);
			i += 2;
			continue;
		}

		if (next < "0" || next > "7" || i + 3 >= end) return undefined;
		const octal = raw.slice(i + 1, i + 4);
		if (!/^[0-7]{3}$/.test(octal)) return undefined;
		const byte = Number.parseInt(octal, 8);
		if (byte > 0xff) return undefined;
		bytes.push(byte);
		i += 4;
	}

	try {
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
		return decoded.includes("\0") ? undefined : decoded;
	} catch {
		return undefined;
	}
}

/** Find the rename/copy separator outside C-quoted path atoms. */
function porcelainRenameArrow(raw: string): number {
	let quoted = false;
	let escaped = false;
	for (let i = 0; i <= raw.length - 4; i += 1) {
		const ch = raw[i]!;
		if (quoted) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') quoted = false;
			continue;
		}
		if (ch === '"') {
			quoted = true;
			continue;
		}
		if (raw.startsWith(" -> ", i)) return i;
	}
	return -1;
}

export interface PorcelainPathChange {
	path: string;
	status: string;
	renameSource?: string;
}

function renameSourceStatus(status: string): string {
	return `${status[0] === "R" ? "D" : " "}${status[1] === "R" ? "D" : " "}`;
}

/**
 * Extract every changed path represented by one porcelain record.
 *
 * A rename is one Git status line but two project changes: the source is
 * deleted and the destination is present. Keeping both paths in GitFacts is
 * required for scope review and for an atomic path-limited checkpoint. Copies
 * keep their source, so only their destination is a changed path.
 */
export function parsePorcelainPathChanges(line: string): PorcelainPathChange[] | undefined {
	if (line.length < 4) return undefined;
	const status = line.slice(0, 2);
	let rest = line.slice(3).trim();
	// Renames/copies render as "XY <source> -> <dest>": only R/C status
	// lines give the arrow structural meaning. An ordinary filename may
	// legitimately contain the same text and must remain whole.
	if (/[RC]/.test(status)) {
		const arrow = porcelainRenameArrow(rest);
		if (arrow < 0) return undefined;
		const source = unquotePorcelainPath(rest.slice(0, arrow).trim());
		if (!source) return undefined;
		rest = rest.slice(arrow + 4).trim();
		const destination = unquotePorcelainPath(rest);
		if (!destination) return undefined;
		return status.includes("R")
			? [
				{ path: source, status: renameSourceStatus(status) },
				{ path: destination, status, renameSource: source },
			]
			: [{ path: destination, status }];
	}
	const decoded = unquotePorcelainPath(rest);
	return decoded ? [{ path: decoded, status }] : undefined;
}

/** Extract the primary/destination path for legacy single-path callers. */
export function parsePorcelainPath(line: string): string | undefined {
	return parsePorcelainPathChanges(line)?.at(-1)?.path;
}

const REPORTED_SECTION_HEADING = /^##\s*files changed\s*$/i;
const REPORTED_SECTION_END = /^##\s+/;

/**
 * Parse the worker report's bounded `## Files Changed` section into safe
 * project-relative paths (the after record's `reported_paths`). Only the
 * first MAX_REPORTED_PATHS_SCAN_CHARS characters of the report are read
 * — an explicit scan window that never exceeds the bounded report
 * summary, so parsing stays bounded however large the raw report text
 * is. Bullet markers ("- ", "* ", "+ ") are stripped; the documented
 * common worker form is `- `path/to/file` — description`: the path
 * claim is the FIRST backticked segment and the description after it is
 * prose that is never parsed. A plain bullet without backticks is a
 * single path claim — only the first whitespace-delimited token is
 * taken, so an arbitrary prose suffix is dropped, never parsed into a
 * path. Every extracted claim is validated by normalizeStatusPath
 * (absolute paths, drive letters, `..` escapes and overlong paths are
 * dropped). The output is deduplicated, sorted and capped at
 * MAX_CHANGED_PATHS: the cap binds whenever the section lists more paths
 * than fit inside the scan window; a window-truncated section simply
 * yields fewer paths (the review then warns on the reported/actual
 * mismatch). A final line cut by the window is dropped, never reported
 * partially. Empty when the section is missing or contains no valid
 * paths — the review then warns that the report/actual comparison is
 * unavailable.
 */
export function parseReportedPaths(reportText: string): string[] {
	const cut = reportText.length > MAX_REPORTED_PATHS_SCAN_CHARS;
	const lines = reportText.slice(0, MAX_REPORTED_PATHS_SCAN_CHARS).split("\n");
	// The scan window may cut the final line mid-way; a partial line must
	// never be parsed into a fabricated path.
	if (cut) lines.pop();
	let inSection = false;
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		const trimmed = line.trim();
		if (!inSection) {
			if (REPORTED_SECTION_HEADING.test(trimmed)) inSection = true;
			continue;
		}
		if (REPORTED_SECTION_END.test(trimmed)) break;
		if (!trimmed) continue;
		// Bullet markers ("- ", "* ", "+ ") are stripped. The documented
		// common worker form is `- `path/to/file` — description`: the path
		// claim is the FIRST backticked segment and the description after it
		// is prose that is never parsed. A plain bullet without backticks is
		// a single path claim — only the first whitespace-delimited token is
		// taken, so an arbitrary prose suffix is dropped, never parsed into
		// a path. A line with an unmatched backtick is not a path claim.
		const bullet = trimmed.replace(/^[-*+]\s*/, "").trim();
		if (!bullet) continue;
		let claim: string;
		const backticked = /`([^`]+)`/.exec(bullet);
		if (backticked) {
			claim = backticked[1]!;
		} else if (bullet.includes("`")) {
			continue;
		} else {
			claim = bullet.split(/\s+/)[0] ?? "";
		}
		if (!claim) continue;
		const normalized = normalizeStatusPath(claim);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
		if (out.length >= MAX_CHANGED_PATHS) break;
	}
	out.sort();
	return out;
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/**
 * Bounded prefix read of a file: first maxBytes plus the real size. Used
 * for content digests AND bounded patch reads — a file is never read in
 * full just to be truncated.
 */
export async function readBoundedFilePrefix(absolutePath: string, maxBytes: number): Promise<{ data: Buffer; size: number } | null> {
	try {
		const handle = await open(absolutePath, "r");
		try {
			const st = await handle.stat();
			if (!st.isFile()) return null;
			const size = Math.min(st.size, maxBytes);
			const buf = Buffer.alloc(size);
			if (size > 0) await handle.read(buf, 0, size, 0);
			return { data: buf, size: st.size };
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

/** Deterministic content digest: full hash up to MAX_DIGEST_BYTES, size-suffixed beyond. */
export function digestFromPrefix(data: Buffer, size: number): string {
	return size <= MAX_DIGEST_BYTES ? sha256HexBytes(data) : `${sha256HexBytes(data)}:${size}`;
}

/**
 * Bounded content digest for a project-relative path, or undefined when the
 * path is missing, unreadable, or not a regular file (deleted directories,
 * collapsed untracked directories, permission errors).
 */
	export async function contentDigest(projectRoot: string, path: string): Promise<string | undefined> {
	const root = resolve(projectRoot);
	const normalized = normalizeStatusPath(path);
	if (!normalized) return undefined;
	const absolute = resolve(root, normalized);
	const rel = relative(root, absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
	const read = await readBoundedFilePrefix(absolute, MAX_DIGEST_BYTES);
	if (!read) return undefined;
	return digestFromPrefix(read.data, read.size);
}

// ---------------------------------------------------------------------------
// Git-facts collection (argv-only exec; the ledger dir is self-excluded)
// ---------------------------------------------------------------------------

/**
 * Collect the bounded current git facts for a project root. FAILS CLOSED:
 * an unavailable `git status` (thrown exec error or non-zero exit) REJECTS
 * collection — a failed status must never fabricate an empty clean-tree
 * fact set that could pass as "nothing changed". A changed-path count
 * beyond MAX_CHANGED_PATHS also REJECTS collection — a silently truncated
 * path set could let diff hashing and scope review PASS on a partial diff.
 * Only `git rev-parse HEAD` stays tolerant: an unborn repository (valid
 * status, no HEAD commit yet) is a legitimate clean fact set with a null
 * gitHead.
 */
export async function collectGitFacts(projectRoot: string, exec: ExecFn): Promise<GitFacts> {
	const root = resolve(projectRoot);
	let gitHead: string | null = null;
	try {
		const head = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
		if (head.code === 0) gitHead = head.stdout.trim() || null;
	} catch {
		gitHead = null;
	}
	// --untracked-files=all lists every untracked file individually so
	// per-path digests cover new files inside new directories — a
	// collapsed "?? dir/" entry would make new files invisible to the
	// digest-based change detection (and thus to the diff review).
	let status: { stdout: string; stderr: string; code: number };
	try {
		status = await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root });
	} catch (error) {
		throw new Error(`git status --porcelain failed: ${String((error as Error).message ?? error).slice(0, MAX_ERROR_MESSAGE_CHARS)}`);
	}
	if (status.code !== 0) {
		const detail = (status.stderr || status.stdout).trim().slice(0, MAX_ERROR_MESSAGE_CHARS);
		throw new Error(`git status --porcelain failed (exit ${status.code})${detail ? `: ${detail}` : ""}`);
	}
	const lines = status.stdout.split("\n").filter(Boolean);
	const changedPaths: string[] = [];
	const pathStatuses: Record<string, string> = {};
	const pathDigests: Record<string, string> = {};
	const renameSources: Record<string, string> = {};
	const seen = new Set<string>();
	for (const line of lines) {
		const changes = parsePorcelainPathChanges(line);
		if (!changes) throw new Error("git status --porcelain returned an invalid or undecodable path");
		const normalizedChanges = changes.map((change) => {
			const path = normalizeStatusPath(change.path);
			if (!path) throw new Error("git status --porcelain returned an unsafe path");
			return { change, path };
		});
		const ignored = normalizedChanges.map(({ path }) => isDelegationRecordPath(root, path)
			|| isToolResultReceiptPath(root, path) || isDelegationStartLockArtifactPath(root, path));
		if (normalizedChanges.length === 2 && ignored.some(Boolean) && !ignored.every(Boolean)) {
			throw new Error("git status --porcelain rename crosses the workbench artifact boundary");
		}
		for (const [{ change, path: normalized }, isIgnored] of normalizedChanges.map((value, index) => [value, ignored[index]!] as const)) {
			if (seen.has(normalized)) {
				throw new Error("git status --porcelain returned overlapping records for one path");
			}
			// Delegation records, P8b receipts, and the exact delegation-start
			// lock artifacts are excluded before the cap. A rename cannot cross
			// this boundary because dropping either half would fabricate a
			// partial project change.
			if (isIgnored) continue;
			// FAIL CLOSED on overflow: a silently truncated path set could let
			// diff hashing and scope review PASS on a partial diff, so a
			// distinct non-ledger path beyond MAX_CHANGED_PATHS REJECTS
			// collection — never a partial fact set.
			if (changedPaths.length >= MAX_CHANGED_PATHS) {
				throw new Error(
					`git status --porcelain reports more than ${MAX_CHANGED_PATHS} changed paths; refusing to record a truncated diff (diff hashing and scope review must never run on a partial path set)`,
				);
			}
			seen.add(normalized);
			changedPaths.push(normalized);
			pathStatuses[normalized] = change.status;
			if (change.renameSource !== undefined) {
				const source = normalizeStatusPath(change.renameSource);
				if (!source) throw new Error("git status --porcelain returned an unsafe rename source");
				renameSources[normalized] = source;
			}
			const digest = await contentDigest(root, normalized);
			if (digest) pathDigests[normalized] = digest;
		}
	}
	changedPaths.sort();
	return { gitHead, gitDirty: changedPaths.length > 0, changedPaths, pathStatuses, pathDigests, renameSources };
}

/**
 * Deterministic diff hash over the current changed paths, their content
 * digests and their porcelain status codes (missing digests —
 * deleted/unreadable paths — hash as the marker "missing"). Same inputs
 * always produce the same hash; a status transition (e.g. " M" → "M "
 * after `git add`, or "D " → "??" after delete + recreate) changes the
 * hash even when the content digest collides.
 */
export function computeDiffHash(
	changedPaths: readonly string[],
	pathDigests: Readonly<Record<string, string>>,
	pathStatuses: Readonly<Record<string, string>>,
): string {
	const pairs = [...new Set(changedPaths)]
		.sort()
		.map((p) => [p, pathDigests[p] ?? "missing", pathStatuses[p] ?? ""] as const);
	return canonicalHash({ paths: pairs });
}

/**
 * True paths changed between two snapshots: new, deleted, digest-moved,
 * or same-content paths whose porcelain status changed (staged/unstaged/
 * untracked/deleted/rename transitions). Untouched paths — including
 * preexisting dirty paths whose digest AND status are identical — are NOT
 * changes.
 */
export function changedSinceBefore(before: GitFacts, after: GitFacts): string[] {
	const paths = new Set([...before.changedPaths, ...after.changedPaths]);
	const out: string[] = [];
	for (const path of [...paths].sort()) {
		const inBefore = before.changedPaths.includes(path);
		const inAfter = after.changedPaths.includes(path);
		if (inBefore && !inAfter) {
			out.push(path);
			continue;
		}
		if (inAfter && !inBefore) {
			out.push(path);
			continue;
		}
		if (before.pathDigests[path] !== after.pathDigests[path]) {
			out.push(path);
			continue;
		}
		if (before.pathStatuses[path] !== after.pathStatuses[path]) out.push(path);
	}
	return out;
}

/**
 * After snapshot: current git facts + the true changes since before + the
 * diff hash. Rejects (fail closed) when the current git facts cannot be
 * collected — an unavailable `git status` never yields an after record.
 */
export async function collectAfterFacts(projectRoot: string, before: GitFacts, exec: ExecFn): Promise<AfterFacts> {
	const current = await collectGitFacts(projectRoot, exec);
	const changed = changedSinceBefore(before, current);
	return {
		...current,
		changedSinceBefore: changed,
		diffHash: computeDiffHash(current.changedPaths, current.pathDigests, current.pathStatuses),
	};
}

// ---------------------------------------------------------------------------
// Atomic bounded JSON writes
// ---------------------------------------------------------------------------

/**
 * The project-relative, normalized, contained path of the delegation's
 * worker-report.md artifact (e.g. `.pi/workbench/delegations/<id>/worker-report.md`).
 * Throws on an invalid delegation id (path-traversal guard); containment in
 * the validated delegation directory is by construction of delegationDirFor
 * and asserted here (the relative path must never escape the project root).
 */
export function delegationReportPath(projectRoot: string, delegationId: string): string {
	const dir = delegationDirFor(projectRoot, delegationId);
	const rel = relative(resolve(projectRoot), dir).split("\\").join("/");
	if (!rel || rel === ".." || rel.startsWith("../")) {
		throw new Error(`delegation directory escapes the project root: ${rel}`);
	}
	return `${rel}/${WORKER_REPORT_FILE_NAME}`;
}

/** Atomic JSON write (tmp + rename), mode 0600, bounded by the caller's data. */
export async function writeJsonAtomic(dir: string, fileName: string, value: unknown): Promise<void> {
	await mkdir(dir, { recursive: true });
	const payload = `${JSON.stringify(value, null, 2)}\n`;
	const tmp = join(dir, `.${fileName}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	await writeFile(tmp, payload, { mode: 0o600 });
	await rename(tmp, join(dir, fileName));
}

/** Atomic UTF-8 text write (tmp + rename), mode 0600. Leaves no temp file on success. */
export async function writeTextAtomic(dir: string, fileName: string, text: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.${fileName}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
	await rename(tmp, join(dir, fileName));
}

async function readJson<T>(dir: string, fileName: string, hooks?: BoundedFileIoHooks): Promise<T | null> {
	try {
		const read = await readJsonFileBounded<T>(join(dir, fileName), DELEGATION_RECORD_MAX_BYTES, hooks);
		return read.ok ? read.value.value : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Contract bounding
// ---------------------------------------------------------------------------

/** Slice a raw contract to the bounded ledger shape (fail-closed on empty task). */
export function boundLedgerContract(raw: LedgerContract): { ok: true; contract: LedgerBeforeRecord["contract"] } | { ok: false; error: string } {
	const task = typeof raw.task === "string" ? raw.task.trim().slice(0, MAX_TASK_CHARS) : "";
	if (!task) return { ok: false, error: "delegation task must be a non-empty string" };
	const allowedPaths = (Array.isArray(raw.allowedPaths) ? raw.allowedPaths : [])
		.filter((p): p is string => typeof p === "string")
		.map((p) => p.trim().slice(0, MAX_PATH_LENGTH))
		.filter(Boolean)
		.slice(0, MAX_ALLOWED_PATHS);
	if (allowedPaths.length === 0) return { ok: false, error: "delegation requires at least one allowed path" };
	const acceptanceCriteria = (Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria : [])
		.filter((c): c is string => typeof c === "string")
		.map((c) => c.trim().slice(0, 1000))
		.filter(Boolean)
		.slice(0, MAX_ACCEPTANCE_CRITERIA);
	const verification = (Array.isArray(raw.verification) ? raw.verification : [])
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.trim().slice(0, 500))
		.filter(Boolean)
		.slice(0, MAX_VERIFICATION_STEPS);
	const timeoutSeconds = Number.isInteger(raw.timeoutSeconds) && raw.timeoutSeconds >= 60 && raw.timeoutSeconds <= 3600 ? raw.timeoutSeconds : 1800;
	// Phase 3: resolve the spend-budget profile deterministically — omitted
	// resolves to `standard`; any other value must be exactly one of the two
	// active literals or the contract FAILS CLOSED (retired low/unknown/empty/wrong-
	// typed profile must never reach a ledger record or a child launch).
	const profile = resolveWorkerBudgetProfile(raw.budgetProfile);
	if (!profile.ok) return profile;
	// Phase 4A: resolve the repair-provenance pointer AFTER the budget
	// profile. Omitted stays undefined — the key is spread conditionally
	// so ordinary records omit `repair_of` entirely; any malformed value
	// FAILS CLOSED exactly like the profile.
	const repair = resolveWorkerRepairOf(raw.repairOf);
	if (!repair.ok) return repair;
	return {
		ok: true,
		contract: {
			task,
			allowed_paths: allowedPaths,
			acceptance_criteria: acceptanceCriteria,
			verification,
			timeout_seconds: timeoutSeconds,
			budget_profile: profile.profile,
			...(repair.repairOf !== undefined ? { repair_of: repair.repairOf } : {}),
		},
	};
}

// ---------------------------------------------------------------------------
// Ledger lifecycle
// ---------------------------------------------------------------------------

export type LedgerResult = { ok: true; dir: string } | { ok: false; error: string };
/** @deprecated Historical schema v1 is read-only; production writes v2 only. */
export async function createDelegationLedger(
	_projectRoot: string,
	_delegationId: string,
	_rawContract: LedgerContract,
	_before: GitFacts,
	_now: string,
): Promise<LedgerResult> {
	return { ok: false, error: "historical delegation schema v1 is read-only" };
}

export interface FinishDelegationInput {
	after: AfterFacts;
	worker: LedgerWorkerFacts;
	/** Secret values to scrub from the report summaries (collectSecretValues(process.env)). */
	secrets?: readonly string[];
	now: string;
	/**
	 * The COMPLETE final worker text (the runner retains it bounded only by
	 * its 2 MiB JSON-event input — never pre-truncated). The ledger redacts
	 * it FIRST, then caps it to MAX_WORKER_REPORT_BYTES and appends the
	 * explicit truncation marker ONLY when the REDACTED report still
	 * exceeds the bound, so post-secret tail content survives when
	 * redaction makes the report fit. Falls back to worker.reportSummary
	 * when absent.
	 */
	reportText?: string;
}

export type FinishLedgerResult = { ok: true; dir: string; workerSummary: LedgerWorkerSummaryRecord } | { ok: false; error: string };

/** @deprecated Historical schema v1 is read-only; production writes v2 only. */
export async function finishDelegationLedger(
	_projectRoot: string,
	_delegationId: string,
	_input: FinishDelegationInput,
): Promise<FinishLedgerResult> {
	return { ok: false, error: "historical delegation schema v1 is read-only" };
}

/**
 * Read the full ledger (manifest/before/after/worker-summary). Returns null
 * when the id is invalid or any core record is missing/corrupt. review.json
 * is owned by core/diff-review.ts.
 */
export async function readDelegationLedger(projectRoot: string, delegationId: string, hooks?: BoundedFileIoHooks): Promise<DelegationLedger | null> {
	if (!isValidDelegationId(delegationId)) return null;
	const dir = delegationDirFor(projectRoot, delegationId);
	const manifest = await readJson<DelegationManifest>(dir, "manifest.json", hooks);
	if (!manifest || manifest.delegation_id !== delegationId) return null;
	const before = await readJson<LedgerBeforeRecord>(dir, "before.json", hooks);
	if (!before || before.delegation_id !== delegationId) return null;
	const after = await readJson<LedgerAfterRecord>(dir, "after.json", hooks);
	if (after && after.delegation_id !== delegationId) return null;
	const workerSummary = await readJson<LedgerWorkerSummaryRecord>(dir, "worker-summary.json", hooks);
	if (workerSummary && workerSummary.delegation_id !== delegationId) return null;
	return { manifest, before, after, workerSummary };
}
