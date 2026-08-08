/**
 * P7 worker-diff review service — the Sol commander's actual-diff review.
 * Pure logic with injected exec (git calls are argv-only, shell=false),
 * no Pi imports.
 *
 * The review reads REAL git state and the delegation ledger, then:
 *   - derives the worker's TRUE changed paths relative to the before
 *     snapshot (new / deleted / digest-moved, including previously-dirty
 *     paths);
 *   - checks EVERY worker path against the parent-approved allowed_paths
 *     (the exact worker-policy scope semantics) with a realpath-safe
 *     check — symlink escapes count as violations, and `include_paths`
 *     only narrows the patch output and can never hide a violation;
 *     unsafe or non-worker include_paths entries are REFUSED;
 *   - computes the current diff hash and compares it with the recorded
 *     after hash (mismatch/drift are recorded as warnings — the review
 *     binds the CURRENT hash, and any later change turns the bound state
 *     STALE via core/delegation-state.ts); drift compares the recorded
 *     after snapshot against the current tree, so same-path later edits
 *     are detected while untouched preexisting dirty paths are ignored;
 *   - warns when the worker report's bounded ## Files Changed section is
 *     missing or does not match the actual diff (reported_paths is parsed
 *     into the ledger at finish);
 *   - renders a globally bounded, redacted patch (git diff + staged diff
 *     for tracked paths, bounded-prefix file content for untracked files,
 *     "(deleted)" markers for deletions): the line AND byte caps (default
 *     400 lines / 32 KiB) are enforced over the WHOLE rendered patch
 *     content, never independently per path; per-path stats and an
 *     explicit segmented include_paths review instruction are returned
 *     when content is truncated or omitted — ANY per-path truncated entry
 *     also sets patch_truncated, even when every entry fits the global
 *     envelope. Scope checks and the bound hash always cover the complete
 *     actual worker diff.
 *   - tracks displayed-path COVERAGE (Slice B2): a path is displayed
 *     only when it appears in an actually rendered patch entry (a
 *     globally omitted path never counts; a bounded/per-path-truncated
 *     entry DOES count as that path's bounded evidence segment); prior
 *     displayed coverage merges ONLY from the persisted review.json with
 *     the SAME bound_diff_hash and valid worker-path membership — a hash
 *     change resets coverage (only prior-hash coverage is dropped; THIS
 *     call's actually rendered paths stay displayed under the new hash);
 *     legacy schema_version-1 records without the additive coverage
 *     fields infer prior coverage ONLY from their persisted patch
 *     entries, and rendering always recomputes displayed/remaining from
 *     the record's valid checked worker paths (absent or malformed
 *     persisted coverage arrays or coverage_complete flags never render
 *     a false COMPLETE); the record carries displayed_paths /
 *     remaining_paths / coverage_complete and the durable review.json
 *     path, and the render shows deterministic counts, a bounded next
 *     include_paths guidance (max 50 paths AND a fixed UTF-8 byte cap,
 *     complete paths only, exact omitted count) and the review-complete
 *     fact. Every review segment still scope-checks EVERY worker path and
 *     binds the COMPLETE current diff hash — include_paths narrows only
 *     the rendered patch.
 *   - Phase 5 (Execution Efficiency Optimization): CURRENT REGULAR
 *     `.svg`/`.json` worker paths LARGER than the default global review
 *     byte cap (COMPACT_MIN_BYTES = DEFAULT_REVIEW_MAX_BYTES = 32 KiB)
 *     render as a deterministic COMPACT entry (bounded redacted
 *     UTF-8-safe head/tail previews — never empty for a non-empty
 *     window: the head is a bounded PREFIX and the tail a bounded
 *     SUFFIX of the redacted capture, so the tail preview represents
 *     the actual end of the file even for the bounded partial-line
 *     fallback of minified/single-line JSON — plus status/size/digest/
 *     recorded-after-equality facts and generator equality
 *     NOT_VERIFIED — the review never executes or imports repository
 *     generators), counting as displayed-path coverage, with no per-path
 *     git diff capture and no additional unbounded/full-file DISPLAY or
 *     preview capture — the existing bounded content digest is preserved
 *     (it may read the complete file through MAX_DIGEST_BYTES = 4 MiB and
 *     uses prefix+size beyond); ordinary source/small/
 *     deleted/unreadable paths keep the existing behavior; scope/hash/
 *     include_paths/coverage/STALE invariants are unchanged.
 *   - Phase 5 hardening: a worker path the authoritative scope/realpath
 *     check finds outside the parent-approved scope is WITHHELD — the
 *     review's per-path content pipeline (git diff capture, bounded file
 *     reads, display digests, rendering) never touches it, and its patch
 *     entry is a deterministic bounded `withheld` marker instead; the
 *     path still counts as an actually displayed entry and the verdict
 *     stays FAIL. Compact reads re-verify project-root realpath
 *     containment immediately before opening, so no compact read can
 *     follow an escaping symlink; the whole-diff hash binding
 *     (collectGitFacts) is unchanged and still covers the complete
 *     actual diff.
 *   - writes ONLY review.json in the delegation directory and returns the
 *     verdict; the runtime wiring (index.ts) is the only component that
 *     touches the delegation state entry.
 *
 * Verdicts: PASS when no worker path is outside the approved scope;
 * FAIL when any violation exists (the runtime then refuses to mark the
 * delegation REVIEWED, and a scope FAIL invalidates a prior same-hash
 * REVIEWED state fail-closed via core/delegation-state.ts). The review
 * never modifies project files and never computes business metrics.
 */

import { open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { truncateUtf8 } from "../worker/handoff.ts";

import {
	changedSinceBefore,
	collectGitFacts,
	computeDiffHash,
	contentDigest,
	delegationDirFor,
	isValidDelegationId,
	MAX_DIGEST_BYTES,
	normalizeStatusPath,
	readBoundedFilePrefix,
	readDelegationLedger,
	writeJsonAtomic,
	type GitFacts,
} from "./delegation-ledger.ts";
import { realpathContained } from "./path-guard.ts";
import { redactText } from "./redact.ts";
import { isWorkerPathAllowedRealpath } from "../worker/path-scope.ts";
import type { ExecFn } from "./config.ts";

export const REVIEW_SCHEMA_VERSION = 1;
export const DEFAULT_REVIEW_MAX_LINES = 400;
export const DEFAULT_REVIEW_MAX_BYTES = 32 * 1024;
export const MAX_REVIEW_PATCH_PATHS = 50;
export const MAX_REVIEW_NOTES = 20;

/**
 * Fixed UTF-8 byte cap for the rendered next-include guidance path list.
 * The guidance is bounded by BOTH MAX_REVIEW_PATCH_PATHS and this byte
 * cap, so an overlong (but valid) remaining path can never produce an
 * unbounded 50-path line. Paths are only ever included WHOLE (a path
 * that does not fit is omitted entirely and counted in the exact omitted
 * count) — no path is ever truncated into the guidance.
 */
export const MAX_REVIEW_GUIDANCE_BYTES = 1024;

// ---------------------------------------------------------------------------
// Phase 5 (Execution Efficiency Optimization): compact review bounds
// ---------------------------------------------------------------------------

/**
 * Deterministic compact-eligibility rule (internal presentation, no public
 * tool parameter/schema change): the path must end in one of these
 * extensions (case-insensitive). Ordinary source/text files are never
 * eligible — their diffs are never hidden.
 */
export const COMPACT_ELIGIBLE_EXTENSIONS = [".svg", ".json"] as const;
/**
 * A path is compact-eligible only when its CURRENT REGULAR file is
 * LARGER than this size. The threshold is tied to the existing default
 * global review byte cap (DEFAULT_REVIEW_MAX_BYTES = 32 KiB): a file at
 * or above the default review envelope could never fit a global-budget
 * git diff, so the compact form is the deterministic bounded
 * presentation for it.
 */
export const COMPACT_MIN_BYTES = DEFAULT_REVIEW_MAX_BYTES;
/**
 * Bounded head/tail read windows — display capture is stat + two bounded
 * 8 KiB window reads, with no additional unbounded/full-file DISPLAY or
 * preview capture. The existing bounded content digest is computed
 * separately and may read the complete file through MAX_DIGEST_BYTES
 * (4 MiB), with bounded prefix+size beyond — the digest bound is
 * unchanged.
 */
export const COMPACT_READ_BYTES = 8 * 1024;
/** Maximum complete lines captured per preview. */
export const COMPACT_PREVIEW_LINES = 12;
/** Maximum UTF-8 bytes of each redacted preview text (before JSON escaping). */
export const COMPACT_PREVIEW_MAX_BYTES = 1024;
/**
 * Generator equality is NEVER verified by the diff-review service — it
 * never executes or imports repository generators. The compact entry
 * always states this literal; MATCH is never fabricated.
 */
export const COMPACT_GENERATOR_EQUALITY = "NOT_VERIFIED";

/**
 * Deterministic bounded marker text rendered as the COMPLETE patch entry
 * of a worker path the authoritative scope/realpath check found outside
 * the parent-approved scope. The review fails closed BEFORE any content
 * open/read/digest/display of the path: the entry carries no git diff, no
 * file content and no digest — only this fixed literal. The path still
 * counts as an actually displayed entry (coverage) and the verdict stays
 * FAIL; the full reason is recorded in the review's `violations`.
 */
export const WITHHELD_MARKER = "(withheld: content not rendered — the path is outside the parent-approved scope; the review fails closed and presents no git diff, file content or per-path digest for this path)";

/**
 * Durable project-relative review record path, e.g.
 * `.pi/workbench/delegations/<id>/review.json` — the deterministic
 * location reviewDelegation writes and reads (Slice B2 renders it).
 * Throws on an invalid delegation id (path-traversal guard, same as
 * delegationDirFor).
 */
export function reviewRecordRelPath(delegationId: string): string {
	if (!isValidDelegationId(delegationId)) throw new Error(`invalid delegation id "${delegationId}"`);
	return `${CONFIG_DIR_NAME}/workbench/delegations/${delegationId}/review.json`;
}

export type ReviewVerdict = "PASS" | "FAIL";

export interface ReviewViolation {
	path: string;
	reason: string;
}

export type ReviewDigestKind = "sha256" | "sha256-prefix+size";

/**
 * Phase 5 (Execution Efficiency Optimization): deterministic structured
 * compact facts for one sufficiently large current regular `.svg` /
 * `.json` worker path. Additive on the review record — schema_version
 * stays 1; legacy records without the field remain readable. The digest
 * is the EXISTING bounded current path content digest (full SHA-256 up to
 * 4 MiB, bounded-prefix+size beyond — never weakened, honestly labelled
 * via digest_kind). Preview texts are redacted, UTF-8-safe, stored as
 * JSON-escaped single lines (they can never defeat the global line caps)
 * and NEVER empty for a non-empty window: a window that holds no
 * complete line (minified/single-line JSON) falls back to its bounded
 * text as a partial-line preview, and every byte/line/window field
 * describes exactly the SHOWN preview text. generator_equality is always
 * NOT_VERIFIED: the review never executes or imports repository
 * generators, so generator equality is never claimed and requires
 * independent current-state generator validation.
 */
export interface ReviewCompactFacts {
	/** Current porcelain status code of the path (" M", "??", "A ", "D "...). */
	git_status: string;
	/** Real byte size of the current regular file. */
	size_bytes: number;
	/** Current content digest (the existing digest form — see digest_kind). */
	digest: string;
	/** "sha256" full form (≤ 4 MiB) or "sha256-prefix+size" bounded form (> 4 MiB). */
	digest_kind: ReviewDigestKind;
	/** Fixed byte boundary of the existing digest form (MAX_DIGEST_BYTES). */
	digest_max_bytes: number;
	/** True when the current digest exactly equals the worker's recorded-after digest. */
	digest_matches_after: boolean;
	/** Always "NOT_VERIFIED" — never fabricated, never claimed by review. */
	generator_equality: "NOT_VERIFIED";
	/** JSON-escaped single-line head preview (redacted, UTF-8-safe, bounded). */
	head_preview: string;
	/**
	 * JSON-escaped single-line tail preview (redacted, UTF-8-safe,
	 * bounded) — a UTF-8-safe bounded SUFFIX of the redacted tail
	 * capture, so it represents the actual end of the file for both
	 * complete-line captures and the partial-line minified/single-line
	 * JSON fallback.
	 */
	tail_preview: string;
	/** Complete head lines in the preview; 0 when the head window held no complete line (head_partial_line). */
	head_lines: number;
	/** Complete tail lines in the preview; 0 when the tail window held no complete line (tail_partial_line). */
	tail_lines: number;
	/**
	 * True when the head preview is the head window's bounded partial-line
	 * text (the window held NO complete line — e.g. minified/single-line
	 * JSON); false when the preview consists of head_lines complete lines.
	 */
	head_partial_line: boolean;
	/**
	 * True when the tail preview is the tail window's bounded partial-line
	 * text (the window held NO complete line — e.g. minified/single-line
	 * JSON); false when the preview consists of tail_lines complete lines.
	 */
	tail_partial_line: boolean;
	/** Byte size of the SHOWN head preview text (redacted, truncated to the preview bound, before JSON escaping). */
	head_bytes: number;
	/** Byte size of the SHOWN tail preview text (redacted, truncated to the preview bound, before JSON escaping). */
	tail_bytes: number;
	/**
	 * True exactly when the file holds content beyond the shown head+tail
	 * preview bytes or a line cap cut complete lines — exact, and always
	 * true for eligible files (their size exceeds the shown preview bytes).
	 */
	content_truncated: boolean;
}

export interface ReviewPatchEntry {
	path: string;
	/** "compact" and "withheld" are Phase 5 additive source literals. */
	source: "git-diff" | "file-content" | "deleted" | "compact" | "withheld";
	text: string;
	truncated: boolean;
	/**
	 * Phase 5: additive structured compact facts — present exactly when
	 * source === "compact"; legacy records without the field stay readable.
	 */
	compact?: ReviewCompactFacts;
}

/** Bounded per-path patch stat (bytes of the rendered entry text; 0 when omitted). */
export interface ReviewPatchPathStat {
	path: string;
	source: ReviewPatchEntry["source"] | "omitted";
	bytes: number;
	truncated: boolean;
}

export interface ReviewRecord {
	schema_version: number;
	delegation_id: string;
	reviewed_at: string;
	verdict: ReviewVerdict;
	/** The CURRENT diff hash (what the review actually inspected and binds). */
	bound_diff_hash: string;
	/** The diff hash the worker's after record reported. */
	recorded_after_hash: string;
	/** True when the current diff hash differs from the recorded after hash. */
	mismatch: boolean;
	/** Current changed paths that appeared after the worker finished. */
	drift_paths: string[];
	/** Worker paths outside the parent-approved scope (verdict FAIL when non-empty). */
	violations: ReviewViolation[];
	/** Every worker path that was scope-checked (all of them, regardless of include_paths). */
	checked_paths: string[];
	/** Patch narrowing requested by the caller (empty = all worker paths). */
	include_paths: string[];
	/** Bounded redacted patch, in include_paths order or sorted worker-path order. */
	patch: ReviewPatchEntry[];
	patch_truncated: boolean;
	/**
	 * Bounded path/stat info for every patch path (source, rendered bytes,
	 * truncated/omitted) — kept when patch content is omitted/truncated so
	 * the reviewer can drive segmented include_paths re-reviews.
	 */
	patch_paths: ReviewPatchPathStat[];
	/** Bounded human notes (mismatch/drift/not-in-diff path warnings). */
	notes: string[];
	/**
	 * Slice B2 coverage facts (additive — schema_version stays 1; legacy
	 * schema_version-1 records without these fields remain readable and
	 * infer prior coverage ONLY from their persisted patch entries).
	 * displayed_paths are the worker paths that appeared in an ACTUALLY
	 * rendered patch entry (this segment merged with prior same-hash
	 * persisted coverage); a globally omitted path never counts, while a
	 * bounded/per-path-truncated entry counts as that path's bounded
	 * evidence segment. remaining_paths are the not-yet-displayed worker
	 * paths; coverage_complete is true exactly when remaining is empty.
	 */
	displayed_paths: string[];
	remaining_paths: string[];
	coverage_complete: boolean;
	/** Durable project-relative review.json path (reviewRecordRelPath). */
	review_path: string;
}

export interface ReviewResult {
	ok: boolean;
	error?: string;
	record?: ReviewRecord;
	/** Plain text lines for the tool content (print/json modes). */
	lines: string[];
}

export interface ReviewInput {
	projectRoot: string;
	delegationId: string;
	exec: ExecFn;
	/** Narrow the patch only — scope checks always cover the whole worker diff. */
	includePaths?: readonly string[];
	maxLines?: number;
	maxBytes?: number;
	/** Secret values to scrub from the patch (collectSecretValues(process.env)). */
	secrets?: readonly string[];
	now?: string;
}

/**
 * Deterministic compact eligibility: the project-relative worker path ends
 * in `.svg` or `.json` (case-insensitive). Ordinary source/text files are
 * never eligible — their diffs are never hidden by compactness.
 */
export function isCompactEligiblePath(path: string): boolean {
	const lower = path.toLowerCase();
	return COMPACT_ELIGIBLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Honest label of the existing digest form: a 64-hex SHA-256 is the full
 * form (file ≤ MAX_DIGEST_BYTES); `sha256:size` is the bounded
 * prefix+size form (file > MAX_DIGEST_BYTES). The 4 MiB digest semantics
 * are unchanged — only the label is explicit.
 */
export function digestKindOf(digest: string): ReviewDigestKind {
	return /^[0-9a-f]{64}:\d+$/.test(digest) ? "sha256-prefix+size" : "sha256";
}

function boundInt(raw: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof raw !== "number" || !Number.isInteger(raw)) return fallback;
	return Math.min(Math.max(raw, min), max);
}

/**
 * Largest UTF-8-safe SUFFIX of `text` whose byte length does not exceed
 * `maxBytes` — the tail mirror of truncateUtf8 (prefix): the cut walks
 * CODE POINTS from the end (never UTF-16 code units), so it can never
 * split a surrogate pair — a lone high/low surrogate (which Buffer would
 * encode as U+FFFD) is impossible and no replacement character can
 * appear in the result. Malformed inputs (non-string text, non-finite or
 * negative maxBytes) fail safe and return the input unchanged / an empty
 * string respectively — never a throw, never a partial code point. Each
 * examined code point is O(1) and the walk stops once the limit is
 * reached, so the bound is deterministic and cheap for the fixed
 * 1024-byte preview bound.
 */
export function suffixUtf8(text: string, maxBytes: number): string {
	if (typeof text !== "string") return "";
	const limit = Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : 0;
	if (limit <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= limit) return text;
	let end = text.length;
	let used = 0;
	while (end > 0) {
		let codePointLength = 1;
		const last = text.charCodeAt(end - 1);
		if (last >= 0xdc00 && last <= 0xdfff && end >= 2) {
			const prev = text.charCodeAt(end - 2);
			if (prev >= 0xd800 && prev <= 0xdbff) codePointLength = 2;
		}
		const bytes = Buffer.byteLength(text.slice(end - codePointLength, end), "utf8");
		if (used + bytes > limit) break;
		used += bytes;
		end -= codePointLength;
	}
	return text.slice(end);
}

/**
 * Bounded redacted patch text for one path: git diff + staged diff for
 * tracked changes; bounded-prefix file content for untracked files
 * (the display capture never reads beyond the first maxBytes bytes —
 * stat reports the real size; the existing bounded content digest
 * computed for the path may read the complete file through 4 MiB and
 * uses prefix+size beyond); "(deleted)" marker when the path
 * is gone. Per-path text is redacted and pre-bounded to maxBytes; the
 * GLOBAL line/byte caps over the rendered patch are enforced later by
 * boundPatchEntries (never independently per path).
 */
async function patchTextFor(
	projectRoot: string,
	path: string,
	exec: ExecFn,
	secrets: readonly string[],
	maxBytes: number,
): Promise<{ text: string; source: ReviewPatchEntry["source"]; truncated: boolean; compact?: ReviewCompactFacts }> {
	try {
		const worktree = await exec("git", ["diff", "--", path], { cwd: projectRoot });
		const staged = await exec("git", ["diff", "--cached", "--", path], { cwd: projectRoot });
		const gitText = [worktree.stdout, staged.stdout].filter(Boolean).join("");
		if (gitText.trim()) {
			const redacted = redactText(gitText, secrets);
			return {
				text: truncateUtf8(redacted, maxBytes),
				source: "git-diff",
				truncated: Buffer.byteLength(redacted, "utf8") > maxBytes,
			};
		}
	} catch {
		// fall through to the content path
	}
	const digest = await contentDigest(projectRoot, path);
	if (digest === undefined) {
		return { text: "(deleted or unreadable)", source: "deleted", truncated: false };
	}
	// Untracked files are not covered by git diff; show a bounded prefix of
	// the content instead (the real size is reported for truncation).
	const absolute = resolve(resolve(projectRoot), path);
	const read = await readBoundedFilePrefix(absolute, maxBytes);
	if (!read) return { text: "(unreadable)", source: "deleted", truncated: false };
	// UTF-8-safe: never split a multibyte sequence at the buffer boundary.
	const prefix = truncateUtf8(read.data.toString("utf8"), maxBytes);
	return {
		text: redactText(prefix, secrets),
		source: "file-content",
		truncated: read.size > read.data.length,
	};
}

/**
 * Bounded head+tail read of a regular file: two window reads plus stat —
 * this display capture NEVER reads the file in full (the existing
 * bounded content digest, computed separately, may read the complete
 * file through 4 MiB and uses prefix+size beyond). Returns null for
 * missing/unreadable/non-regular paths; the caller then falls back to the
 * existing git-diff/content behavior. headEndsAtLineBoundary is true when
 * the byte right after the head window is a newline or the file ends
 * inside the window (the window's final line is complete);
 * tailStartsAtLineBoundary is true when the byte right before the tail
 * window is a newline (the window starts at a line boundary).
 */
async function readBoundedHeadTail(
	absolutePath: string,
	windowBytes: number,
): Promise<{ head: Buffer; tail: Buffer; headEndsAtLineBoundary: boolean; tailStartsAtLineBoundary: boolean; size: number } | null> {
	try {
		const handle = await open(absolutePath, "r");
		try {
			const st = await handle.stat();
			if (!st.isFile()) return null;
			const size = st.size;
			const headBuf = Buffer.alloc(Math.min(size, windowBytes));
			let head = headBuf;
			if (headBuf.length > 0) {
				const { bytesRead } = await handle.read(headBuf, 0, headBuf.length, 0);
				// The file may have shrunk between stat and read — never render
				// zero-filled bytes beyond the actual read.
				if (bytesRead < headBuf.length) head = headBuf.subarray(0, bytesRead);
			}
			// The head window's final line is complete exactly when the file
			// ends inside the window or the byte right after the window is a
			// newline — a one-byte probe read, never a full read.
			let headEndsAtLineBoundary = true;
			if (size > head.length) {
				const next = Buffer.alloc(1);
				const { bytesRead } = await handle.read(next, 0, 1, head.length);
				headEndsAtLineBoundary = bytesRead === 0 || next[0] === 0x0a;
			}
			let tail = Buffer.alloc(0);
			let tailStartsAtLineBoundary = true;
			if (size > windowBytes) {
				const tailBuf = Buffer.alloc(windowBytes);
				const { bytesRead } = await handle.read(tailBuf, 0, windowBytes, size - windowBytes);
				tail = bytesRead < tailBuf.length ? tailBuf.subarray(0, bytesRead) : tailBuf;
				if (size > windowBytes + 1) {
					const lead = Buffer.alloc(1);
					await handle.read(lead, 0, 1, size - windowBytes - 1);
					tailStartsAtLineBoundary = lead[0] === 0x0a;
				}
			}
			return { head, tail, headEndsAtLineBoundary, tailStartsAtLineBoundary, size };
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

/**
 * One bounded preview window capture. `lines` holds the complete lines
 * captured (bounded by the line cap); `partial` is the window's partial
 * line — non-empty exactly when the window holds NO complete line
 * (minified/single-line JSON) — so the preview is never empty for a
 * non-empty window; `moreLines` reports complete lines cut by the line
 * cap.
 */
interface CapturedPreview {
	lines: string[];
	partial: string;
	moreLines: boolean;
}

/**
 * Complete lines captured from the HEAD window with the exact boundary
 * fact: the window's final fragment is a complete line exactly when the
 * file ends inside the window or the byte right after the window is a
 * newline (headEndsAtLineBoundary). A partial final fragment is dropped
 * (its content belongs to the middle), a trailing empty element after a
 * final newline is dropped. When the window holds NO complete line, the
 * bounded window text itself is returned as `partial`. Returns the first
 * `maxLines` complete lines and whether more complete lines were cut by
 * the line cap.
 */
function captureHeadLines(text: string, headEndsAtLineBoundary: boolean, maxLines: number): CapturedPreview {
	if (text.length === 0) return { lines: [], partial: "", moreLines: false };
	const parts = text.split("\n");
	if (text.endsWith("\n")) {
		parts.pop();
	} else if (!headEndsAtLineBoundary) {
		// The window cut the final fragment — it is a partial line whose
		// content belongs to the middle.
		parts.pop();
	}
	if (parts.length === 0) return { lines: [], partial: text, moreLines: false };
	const lines = parts.slice(0, maxLines);
	return { lines, partial: "", moreLines: parts.length > maxLines };
}

/**
 * Complete lines captured from the TAIL window: a leading partial-line
 * fragment (the window starts mid-line) is dropped, a trailing empty
 * element after a final newline is dropped, and the file's final line
 * (even without a trailing newline) is kept. When the window holds NO
 * complete line, the bounded window text itself is returned as
 * `partial`. Returns the last `maxLines` complete lines and whether more
 * complete lines were cut by the line cap. The caller applies a
 * UTF-8-safe SUFFIX bound to the tail preview, so the partial-line
 * fallback shows the window's END fragment — the actual end of the file.
 */
function captureTailLines(text: string, startsAtLineBoundary: boolean, maxLines: number): CapturedPreview {
	if (text.length === 0) return { lines: [], partial: "", moreLines: false };
	const parts = text.split("\n");
	if (!startsAtLineBoundary) parts.shift();
	if (text.endsWith("\n")) parts.pop();
	if (parts.length === 0) return { lines: [], partial: text, moreLines: false };
	const lines = parts.slice(-maxLines);
	return { lines, partial: "", moreLines: parts.length > maxLines };
}

/**
 * Deterministic compact facts for one eligible path, or null when the
 * path is not a current readable regular file, not large enough, or not
 * project-root realpath-contained — the caller then falls back to the
 * existing git-diff/content behavior. Only bounded head/tail window reads
 * plus the existing bounded content digest are performed: no per-path git
 * diff capture, no additional unbounded/full-file DISPLAY or preview
 * capture, and no repository generator is ever executed or imported. The
 * existing digest itself may read the complete file through 4 MiB
 * (bounded prefix+size beyond) — the digest bound is unchanged. The
 * project-root realpath containment defense is
 * re-verified immediately before the reads: the path already passed the
 * authoritative scope/realpath check, and a compact read must never
 * follow an escaping symlink (e.g. a path swapped after the scope
 * check). Preview texts are redacted, UTF-8-safe and non-empty for
 * non-empty windows: a window with no complete line (minified/
 * single-line JSON) shows its bounded text as a partial-line preview;
 * the head preview is a bounded PREFIX of the redacted head capture and
 * the tail preview a bounded SUFFIX of the redacted tail capture, so the
 * shown tail text is the window's END — the actual end of the file. The
 * structured byte/line/window fields describe exactly the SHOWN preview
 * text (content_truncated is exact: shown bytes + line caps vs file
 * size).
 */
async function compactFactsFor(
	projectRoot: string,
	path: string,
	secrets: readonly string[],
	afterDigests: Readonly<Record<string, string>>,
	currentStatus: string,
): Promise<ReviewCompactFacts | null> {
	const real = await realpathContained(projectRoot, path);
	if (real === undefined) return null;
	const read = await readBoundedHeadTail(real, COMPACT_READ_BYTES);
	if (!read || read.size <= COMPACT_MIN_BYTES) return null;
	const digest = await contentDigest(projectRoot, path);
	if (digest === undefined) return null;
	const head = captureHeadLines(read.head.toString("utf8"), read.headEndsAtLineBoundary, COMPACT_PREVIEW_LINES);
	const tail = captureTailLines(read.tail.toString("utf8"), read.tailStartsAtLineBoundary, COMPACT_PREVIEW_LINES);
	const headRaw = head.lines.length > 0 ? head.lines.join("\n") : head.partial;
	const tailRaw = tail.lines.length > 0 ? tail.lines.join("\n") : tail.partial;
	// Head preview: UTF-8-safe bounded PREFIX of the redacted head capture.
	const headShown = truncateUtf8(redactText(headRaw, secrets), COMPACT_PREVIEW_MAX_BYTES);
	// Tail preview: UTF-8-safe bounded SUFFIX of the redacted tail capture
	// — the shown text is the END of the window, so it represents the
	// actual end of the file for BOTH complete-line captures and the
	// partial-line minified/single-line JSON fallback.
	const tailShown = suffixUtf8(redactText(tailRaw, secrets), COMPACT_PREVIEW_MAX_BYTES);
	const headBytes = Buffer.byteLength(headShown, "utf8");
	const tailBytes = Buffer.byteLength(tailShown, "utf8");
	const afterDigest = afterDigests[path];
	return {
		git_status: currentStatus,
		size_bytes: read.size,
		digest,
		digest_kind: digestKindOf(digest),
		digest_max_bytes: MAX_DIGEST_BYTES,
		digest_matches_after: afterDigest !== undefined && afterDigest === digest,
		generator_equality: COMPACT_GENERATOR_EQUALITY,
		head_preview: JSON.stringify(headShown),
		tail_preview: JSON.stringify(tailShown),
		head_lines: head.lines.length,
		tail_lines: tail.lines.length,
		head_partial_line: head.lines.length === 0 && head.partial.length > 0,
		tail_partial_line: tail.lines.length === 0 && tail.partial.length > 0,
		head_bytes: headBytes,
		tail_bytes: tailBytes,
		content_truncated: read.size > headBytes + tailBytes || head.moreLines || tail.moreLines,
	};
}

/**
 * Deterministic bounded rendered text of one compact entry — the rendered
 * facts mirror the persisted structured facts exactly, and the head/tail
 * previews are JSON-escaped single lines that can never defeat the global
 * line caps.
 */
export function renderCompactFacts(facts: ReviewCompactFacts): string {
	const digestKindNote = facts.digest_kind === "sha256-prefix+size" ? ` beyond ${facts.digest_max_bytes} bytes` : "";
	const headDetail = facts.head_partial_line ? "partial line — no complete line in the head window" : `${facts.head_lines} complete line(s)`;
	const tailDetail = facts.tail_partial_line ? "partial line — no complete line in the tail window" : `${facts.tail_lines} complete line(s)`;
	return [
		`compact   : status=${JSON.stringify(facts.git_status)} size=${facts.size_bytes} bytes digest=${facts.digest} (${facts.digest_kind}${digestKindNote})`,
		`digest    : ${facts.digest_matches_after ? "matches the worker's recorded-after digest" : "DIFFERS from the worker's recorded-after digest (or no recorded-after digest exists)"}`,
		`head      : ${facts.head_preview} (${headDetail}, ${facts.head_bytes} bytes)`,
		`tail      : ${facts.tail_preview} (${tailDetail}, ${facts.tail_bytes} bytes)`,
		`truncated : content beyond the shown head+tail preview bytes is not rendered (content_truncated=${facts.content_truncated})`,
		`generator : generator equality ${facts.generator_equality} — the diff-review service never executes or imports repository generators; independent current-state generator validation is required`,
	].join("\n");
}

/**
 * Bounded redacted patch entry for ONE path. Phase 5: a sufficiently
 * large CURRENT REGULAR `.svg`/`.json` worker path takes the compact path
 * FIRST — no per-path git diff capture and no additional unbounded/
 * full-file DISPLAY or preview capture (the existing bounded content
 * digest may read the complete file through 4 MiB and uses prefix+size
 * beyond); every other path (ordinary source, small files,
 * deleted/unreadable/non-regular) keeps the existing
 * git-diff/content/deleted behavior. Scope-violating
 * paths are withheld by the review loop BEFORE this function is reached —
 * no content operation (git diff, open, read, digest, render) ever runs
 * for them.
 */
async function patchEntryFor(
	projectRoot: string,
	path: string,
	exec: ExecFn,
	secrets: readonly string[],
	maxBytes: number,
	afterDigests: Readonly<Record<string, string>>,
	currentStatus: string,
): Promise<RawPatchEntry> {
	if (isCompactEligiblePath(path)) {
		const compact = await compactFactsFor(projectRoot, path, secrets, afterDigests, currentStatus);
		if (compact) {
			return { path, source: "compact", text: renderCompactFacts(compact), perPathTruncated: compact.content_truncated, compact };
		}
	}
	return patchTextFor(projectRoot, path, exec, secrets, maxBytes).then((entry) => ({ path, ...entry, perPathTruncated: entry.truncated }));
}

/**
 * Slice one patch text to a remaining line AND byte budget (UTF-8-safe;
 * the line cut wins, then the byte cut may end the last kept line early).
 */
function sliceTextToBudgets(text: string, maxLines: number, maxBytes: number): string {
	const lines = text.split("\n").slice(0, Math.max(maxLines, 0));
	return truncateUtf8(lines.join("\n"), Math.max(maxBytes, 0));
}

interface RawPatchEntry {
	path: string;
	source: ReviewPatchEntry["source"];
	text: string;
	perPathTruncated: boolean;
	/** Phase 5: additive structured compact facts (source === "compact"). */
	compact?: ReviewCompactFacts;
}

/**
 * Enforce the GLOBAL line AND byte caps over the rendered patch content
 * (marker lines included) — never independently per path. Entries that do
 * not fit are dropped entirely; the entry that straddles a cap is cut to
 * the remaining budget and marked truncated.
 */
function boundPatchEntries(
	entries: readonly RawPatchEntry[],
	maxLines: number,
	maxBytes: number,
): { entries: ReviewPatchEntry[]; truncated: boolean } {
	const out: ReviewPatchEntry[] = [];
	let lines = 0;
	let bytes = 0;
	let truncated = false;
	for (const entry of entries) {
		const entryLines = entry.text.split("\n").length;
		const entryBytes = Buffer.byteLength(entry.text, "utf8");
		const markerBytes = Buffer.byteLength(`--- ${entry.path} (${entry.source}) ---\n`, "utf8");
		if (lines + entryLines + 1 > maxLines || bytes + entryBytes + markerBytes > maxBytes) {
			const remainingLines = Math.max(maxLines - lines - 1, 0);
			const remainingBytes = Math.max(maxBytes - bytes - markerBytes, 0);
			if (remainingLines <= 0 || remainingBytes <= 0) {
				truncated = true;
				break;
			}
			const cut = sliceTextToBudgets(entry.text, remainingLines, remainingBytes);
			if (cut !== entry.text || entry.perPathTruncated) truncated = true;
			out.push({ path: entry.path, source: entry.source, text: cut, truncated: true, compact: entry.compact });
			break;
		}
		out.push({ path: entry.path, source: entry.source, text: entry.text, truncated: entry.perPathTruncated, compact: entry.compact });
		lines += entryLines + 1;
		bytes += entryBytes + markerBytes;
		// ANY per-path truncation makes the rendered patch incomplete, even
		// when the (redaction-shrunk) entry fits the global envelope: the
		// reviewer must see patch_truncated and the segmented include_paths
		// guidance.
		if (entry.perPathTruncated) truncated = true;
	}
	if (out.length < entries.length) truncated = true;
	return { entries: out, truncated };
}

/**
 * Slice B2 coverage facts for one review segment (deterministic).
 */
export interface ReviewCoverage {
	/** Worker paths that appeared in an actually rendered patch entry (sorted). */
	displayed_paths: string[];
	/** Worker paths not yet displayed (sorted). */
	remaining_paths: string[];
	/** True exactly when every worker path has been displayed. */
	coverage_complete: boolean;
}

/**
 * Merge the displayed-path coverage of one review segment: the paths
 * ACTUALLY rendered in this call's patch (a globally omitted path never
 * counts; a bounded/per-path-truncated entry DOES count as that path's
 * bounded evidence segment) merged with prior persisted coverage that
 * binds the SAME bound diff hash. Prior coverage is adopted only when the
 * persisted review.json carries the same bound_diff_hash and its paths
 * are valid worker paths — on a hash change the coverage resets to this
 * call's rendered paths only (this call's rendered paths are never
 * discarded). Legacy schema_version-1 records without the additive
 * displayed_paths field infer their prior coverage ONLY from their
 * persisted patch entries; malformed persisted coverage arrays are never
 * trusted over recomputation from the prior record's valid checked worker
 * paths and its actually rendered patch entries. Output lists are sorted
 * deterministically.
 */
export function mergeReviewCoverage(
	workerPaths: readonly string[],
	renderedPaths: readonly string[],
	prior: ReviewRecord | null,
	boundDiffHash: string,
): ReviewCoverage {
	const workerSet = new Set(workerPaths);
	const displayed = new Set<string>();
	for (const path of renderedPaths) {
		if (workerSet.has(path)) displayed.add(path);
	}
	if (prior && prior.bound_diff_hash === boundDiffHash) {
		// Prior coverage is RECOMPUTED from the prior record's valid worker
		// paths: the union of its persisted displayed_paths (when present)
		// and its ACTUALLY rendered patch entries, each filtered to the
		// prior record's checked worker paths AND this call's worker paths.
		// Malformed persisted coverage arrays are never trusted over this
		// recomputation; a well-formed record is unaffected because its
		// patch entries are always a subset of its displayed_paths. The
		// merge stays same-hash only (checked above).
		const priorChecked = Array.isArray(prior.checked_paths)
			? prior.checked_paths.filter((p): p is string => typeof p === "string")
			: [];
		const priorCheckedSet = new Set(priorChecked);
		const priorCandidates = Array.isArray(prior.displayed_paths)
			? [
					...prior.displayed_paths,
					...(Array.isArray(prior.patch) ? prior.patch.map((entry) => entry.path) : []),
				]
			: // Legacy schema_version-1 record without the additive field:
			  // prior coverage is inferred ONLY from its persisted patch
			  // entries (the actually rendered ones).
			  Array.isArray(prior.patch)
				? prior.patch.map((entry) => entry.path)
				: [];
		for (const path of priorCandidates) {
			if (typeof path === "string" && priorCheckedSet.has(path) && workerSet.has(path)) displayed.add(path);
		}
	}
	const displayedPaths = [...displayed].sort();
	const remainingPaths = workerPaths.filter((path) => !displayed.has(path));
	return {
		displayed_paths: displayedPaths,
		remaining_paths: remainingPaths,
		coverage_complete: remainingPaths.length === 0,
	};
}

/**
 * Review one delegation against the real git state. Writes review.json
 * (atomic) and returns the verdict + bounded redacted patch. Never touches
 * the delegation state entry — the runtime does that.
 */
export async function reviewDelegation(input: ReviewInput): Promise<ReviewResult> {
	const projectRoot = input.projectRoot;
	const delegationId = input.delegationId.trim();
	const now = input.now ?? new Date().toISOString();
	const maxLines = boundInt(input.maxLines, DEFAULT_REVIEW_MAX_LINES, 1, 2000);
	const maxBytes = boundInt(input.maxBytes, DEFAULT_REVIEW_MAX_BYTES, 1, 512_000);
	const secrets = input.secrets ?? [];

	if (!isValidDelegationId(delegationId)) {
		return { ok: false, error: `invalid delegation id "${delegationId}"`, lines: [] };
	}
	const ledger = await readDelegationLedger(projectRoot, delegationId);
	if (!ledger) {
		return { ok: false, error: `delegation ${delegationId} not found or incomplete`, lines: [] };
	}
	if (!ledger.after) {
		return { ok: false, error: `delegation ${delegationId} has no recorded result (still running or incomplete)`, lines: [] };
	}

	// Slice B2: read the PRIOR persisted review record BEFORE this call
	// overwrites it — same-hash segments merge displayed coverage; a hash
	// change resets it. The finish-time PENDING_REVIEW placeholder and
	// corrupt/foreign records read as null (no prior coverage).
	const priorReview = await readReviewRecord(projectRoot, delegationId);

	// Worker paths = TRUE paths changed between before and after (the ledger
	// derived them digest-based; previously-dirty paths are included).
	const workerPaths = [...ledger.after.changed_since_before].sort();
	const allowedPaths = ledger.before.contract.allowed_paths;

	// Scope check over ALL worker paths — include_paths can never hide a
	// violation. The check is realpath-safe: a symlink inside an approved
	// subtree that resolves OUTSIDE the subtree (or the project) is a
	// violation. It runs FIRST — before any git/content collection —
	// because it gates the review's entire per-path content pipeline: a
	// violating path is withheld below (deterministic bounded marker) and
	// is never git-diffed, opened, read, digested or rendered.
	const violations: ReviewViolation[] = [];
	for (const path of workerPaths) {
		if (!(await isWorkerPathAllowedRealpath(projectRoot, path, allowedPaths))) {
			violations.push({
				path,
				reason: `changed path "${path}" is outside the parent-approved scope (realpath/symlink check): ${allowedPaths.join(", ")}`,
			});
		}
	}
	const violationSet = new Set(violations.map((v) => v.path));

	// Real git state NOW — the review inspects the actual tree, never the
	// ledger's claims. Fail closed: an unavailable `git status` (thrown exec
	// error or non-zero exit) returns a structured failure and writes NO
	// review record — a fabricated clean tree could never be reviewed as
	// PASS. The whole-diff hash binding (collectGitFacts) is unchanged and
	// always covers the complete actual diff, violating paths included.
	let current: GitFacts;
	try {
		current = await collectGitFacts(projectRoot, input.exec);
	} catch (error) {
		return {
			ok: false,
			error: `cannot collect the real git state for the review: ${(error as Error).message}`,
			lines: [],
		};
	}
	const boundDiffHash = computeDiffHash(current.changedPaths, current.pathDigests, current.pathStatuses);
	const recordedAfterHash = ledger.after.diff_hash;
	const mismatch = boundDiffHash !== recordedAfterHash;

	// Include paths narrow only the patch and may name ONLY worker-diff
	// paths. Unsafe entries (absolute, drive-letter, ".." escape, overlong)
	// and entries outside the worker diff are REFUSED — a typo or hostile
	// entry must never shrink the inspected patch or read outside the
	// project.
	const includeSet = new Set<string>();
	for (const raw of input.includePaths ?? []) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const normalized = normalizeStatusPath(trimmed);
		if (!normalized) {
			return {
				ok: false,
				error: `include_paths entry "${trimmed}" is not a safe project-relative path (absolute, drive-letter, ".." escape and overlong paths are refused)`,
				lines: [],
			};
		}
		if (!workerPaths.includes(normalized)) {
			return {
				ok: false,
				error: `include_paths entry "${normalized}" is not part of the worker diff (${workerPaths.length === 0 ? "the worker changed no paths" : workerPaths.join(", ")})`,
				lines: [],
			};
		}
		includeSet.add(normalized);
	}
	const patchPaths = includeSet.size > 0 ? [...includeSet] : workerPaths;

	// Drift: paths whose state differs from the recorded-after snapshot
	// (new paths, same-path later edits via digest/status comparison,
	// deletions) — recorded as warnings; the bound hash covers them.
	// Untouched preexisting dirty paths (already dirty before the
	// delegation and still identical) are NOT drift.
	const afterFacts: GitFacts = {
		gitHead: ledger.after.git_head,
		gitDirty: ledger.after.git_dirty,
		changedPaths: [...ledger.after.changed_paths],
		pathStatuses: { ...ledger.after.path_statuses },
		pathDigests: { ...ledger.after.path_digests },
	};
	const driftPaths = changedSinceBefore(afterFacts, current);

	const notes: string[] = [];
	if (mismatch) {
		notes.push(`current diff hash differs from the worker's recorded after hash (${boundDiffHash.slice(0, 12)} vs ${recordedAfterHash.slice(0, 12)}) — the review binds the CURRENT hash; any further change turns the delegation STALE`);
	}
	if (driftPaths.length > 0) {
		notes.push(`${driftPaths.length} path(s) changed after the worker finished: ${driftPaths.slice(0, 10).join(", ")}${driftPaths.length > 10 ? "…" : ""}`);
	}
	// Worker report vs actual diff: the ledger records the safe paths the
	// worker listed in its bounded ## Files Changed section. A missing
	// section or a mismatch with the actual diff is a warning — the verdict
	// stays driven by the REAL diff, never the report.
	const reportedPaths = [...ledger.after.reported_paths];
	if (reportedPaths.length === 0) {
		notes.push("worker report has no parseable ## Files Changed section — reported/actual path comparison unavailable");
	} else {
		const reportedSet = new Set(reportedPaths);
		const actualSet = new Set(workerPaths);
		const onlyReported = reportedPaths.filter((p) => !actualSet.has(p));
		const onlyActual = workerPaths.filter((p) => !reportedSet.has(p));
		if (onlyReported.length > 0) {
			notes.push(`worker report lists ${onlyReported.length} path(s) not present in the actual diff: ${onlyReported.slice(0, 10).join(", ")}${onlyReported.length > 10 ? "…" : ""}`);
		}
		if (onlyActual.length > 0) {
			notes.push(`worker report misses ${onlyActual.length} actual diff path(s): ${onlyActual.slice(0, 10).join(", ")}${onlyActual.length > 10 ? "…" : ""}`);
		}
	}

	// Patch: include_paths narrows the OUTPUT only (entries were validated
	// above against the worker diff). Per-path reads are bounded; the GLOBAL
	// line AND byte caps are enforced over the whole rendered patch content
	// (never independently per path). Scope checks and the bound hash always
	// cover the complete actual diff — truncation affects only the display.
	// Fail closed: a violating path is withheld BEFORE any content open/
	// read/digest/display — its entry is the deterministic bounded marker,
	// never a git diff, file read, digest or rendered content.
	const rawEntries: RawPatchEntry[] = [];
	for (const path of patchPaths.slice(0, MAX_REVIEW_PATCH_PATHS)) {
		if (violationSet.has(path)) {
			// Fail closed BEFORE any content open/read/digest/display: the
			// authoritative scope/realpath check found this worker path
			// outside the parent-approved scope — no git diff capture, no
			// file open/read, no digest, no content render. The deterministic
			// bounded withheld marker is the path's COMPLETE evidence
			// segment: it still counts as an actually displayed entry
			// (coverage) and the verdict stays FAIL.
			rawEntries.push({ path, source: "withheld", text: WITHHELD_MARKER, perPathTruncated: false });
			continue;
		}
		const entry = await patchEntryFor(projectRoot, path, input.exec, secrets, maxBytes, ledger.after.path_digests, current.pathStatuses[path] ?? "");
		rawEntries.push(entry);
	}
	const bounded = boundPatchEntries(rawEntries, maxLines, maxBytes);
	const patch = bounded.entries;
	const patchTruncated = bounded.truncated || patchPaths.length > patch.length;
	const patchPathsStat: ReviewPatchPathStat[] = patchPaths.slice(0, MAX_REVIEW_PATCH_PATHS).map((path) => {
		const entry = patch.find((p) => p.path === path);
		return {
			path,
			source: entry?.source ?? "omitted",
			bytes: entry ? Buffer.byteLength(entry.text, "utf8") : 0,
			truncated: entry ? entry.truncated : true,
		};
	});

	const verdict: ReviewVerdict = violations.length > 0 ? "FAIL" : "PASS";
	// Slice B2 coverage: displayed = actually rendered patch entries this
	// call, merged with prior same-hash persisted coverage (valid worker
	// paths only; legacy records infer from their patch entries).
	const coverage = mergeReviewCoverage(workerPaths, patch.map((entry) => entry.path), priorReview, boundDiffHash);
	const record: ReviewRecord = {
		schema_version: REVIEW_SCHEMA_VERSION,
		delegation_id: delegationId,
		reviewed_at: now,
		verdict,
		bound_diff_hash: boundDiffHash,
		recorded_after_hash: recordedAfterHash,
		mismatch,
		drift_paths: [...driftPaths],
		violations,
		checked_paths: workerPaths,
		include_paths: patchPaths,
		patch,
		patch_truncated: patchTruncated,
		patch_paths: patchPathsStat,
		notes: notes.slice(0, MAX_REVIEW_NOTES),
		displayed_paths: coverage.displayed_paths,
		remaining_paths: coverage.remaining_paths,
		coverage_complete: coverage.coverage_complete,
		review_path: reviewRecordRelPath(delegationId),
	};

	try {
		await writeJsonAtomic(delegationDirFor(projectRoot, delegationId), "review.json", record);
	} catch (error) {
		return { ok: false, error: `failed to write review record: ${(error as Error).message}`, lines: [] };
	}

	return { ok: true, record, lines: renderReviewLines(record) };
}

/**
 * Normalize a review record's coverage facts for rendering — the record's
 * OWN fields are never trusted blindly: displayed coverage is derived from
 * the union of its persisted displayed_paths (when present) and its
 * ACTUALLY rendered patch entries, filtered to the record's valid checked
 * worker paths; remaining is recomputed from those checked worker paths;
 * coverage_complete is true exactly when remaining is empty. Legacy
 * schema_version-1 records without the additive fields therefore render
 * their persisted patch entries as displayed coverage and their checked
 * paths as the full set — absent fields NEVER render as zero/zero
 * COMPLETE, and a persisted coverage_complete flag never overrides the
 * recomputation. When checked_paths itself is unusable, the persisted
 * arrays degrade as-is and completeness is only claimed when BOTH arrays
 * are present and coherent (never invented from absent fields).
 */
export function normalizeReviewCoverage(record: ReviewRecord): ReviewCoverage {
	const checked = Array.isArray(record.checked_paths)
		? record.checked_paths.filter((p): p is string => typeof p === "string")
		: null;
	if (checked !== null) {
		const checkedSet = new Set(checked);
		const rawDisplayed = Array.isArray(record.displayed_paths)
			? [
					...record.displayed_paths,
					...(Array.isArray(record.patch) ? record.patch.map((entry) => entry.path) : []),
				]
			: // Legacy schema_version-1 record: displayed coverage is inferred
			  // ONLY from its persisted patch entries (the actually rendered
			  // ones).
			  Array.isArray(record.patch)
				? record.patch.map((entry) => entry.path)
				: [];
		const displayedSet = new Set<string>();
		for (const path of rawDisplayed) {
			if (typeof path === "string" && checkedSet.has(path)) displayedSet.add(path);
		}
		const displayedPaths = [...displayedSet].sort();
		const remainingPaths = checked.filter((path) => !displayedSet.has(path));
		return {
			displayed_paths: displayedPaths,
			remaining_paths: remainingPaths,
			coverage_complete: remainingPaths.length === 0,
		};
	}
	// checked_paths unusable: degrade to the persisted arrays when present,
	// but never claim COMPLETE from absent fields.
	const hasDisplayed = Array.isArray(record.displayed_paths);
	const hasRemaining = Array.isArray(record.remaining_paths);
	const displayedPaths = hasDisplayed
		? record.displayed_paths.filter((p): p is string => typeof p === "string").sort()
		: [];
	const remainingPaths = hasRemaining
		? record.remaining_paths.filter((p): p is string => typeof p === "string").sort()
		: [];
	return {
		displayed_paths: displayedPaths,
		remaining_paths: remainingPaths,
		coverage_complete: hasDisplayed && hasRemaining && displayedPaths.length > 0 && remainingPaths.length === 0,
	};
}

/** Plain-text rendering of a review record (print/json mode content). */
export function renderReviewLines(record: ReviewRecord): string[] {
	// Slice B2 coverage facts — normalized from the record's VALID checked
	// worker paths: legacy records without the additive fields render their
	// persisted patch entries as displayed and checked_paths as the full
	// set; malformed persisted coverage arrays or a persisted
	// coverage_complete flag are never trusted over the recomputation
	// (absent fields never render zero/zero COMPLETE).
	const coverage = normalizeReviewCoverage(record);
	const displayedPaths = coverage.displayed_paths;
	const remainingPaths = coverage.remaining_paths;
	const coverageComplete = coverage.coverage_complete;
	const checkedCount = Array.isArray(record.checked_paths) ? record.checked_paths.length : 0;
	// Next-include guidance bounded by BOTH the path-count cap AND a fixed
	// UTF-8 byte cap: paths are included WHOLE (never truncated mid-string)
	// in remaining order while they fit; every path not listed — whether
	// beyond the count cap or beyond the byte cap — is counted exactly in
	// the omitted count.
	const nextInclude: string[] = [];
	let guidanceBytes = 0;
	for (const path of remainingPaths) {
		if (nextInclude.length >= MAX_REVIEW_PATCH_PATHS) break;
		const quoted = JSON.stringify(path);
		const entryBytes = Buffer.byteLength(quoted, "utf8") + (nextInclude.length > 0 ? 2 : 0);
		if (guidanceBytes + entryBytes > MAX_REVIEW_GUIDANCE_BYTES) break;
		nextInclude.push(path);
		guidanceBytes += entryBytes;
	}
	const nextIncludeOmitted = remainingPaths.length - nextInclude.length;
	const nextIncludeText =
		remainingPaths.length === 0
			? "(none — every worker path displayed for this bound hash)"
			: `[${nextInclude.map((path) => JSON.stringify(path)).join(", ")}]${nextIncludeOmitted > 0 ? `, … +${nextIncludeOmitted} more` : ""} (max ${MAX_REVIEW_PATCH_PATHS} paths per call; ≤ ${MAX_REVIEW_GUIDANCE_BYTES} bytes)`;
	const lines = [
		`delegation : ${record.delegation_id}`,
		`verdict    : ${record.verdict}`,
		`reviewed   : ${record.reviewed_at}`,
		`bound hash : ${record.bound_diff_hash}`,
		`after hash : ${record.recorded_after_hash}${record.mismatch ? " (MISMATCH)" : ""}`,
		`checked    : ${checkedCount} worker path(s)${record.include_paths.length > 0 && record.include_paths.length !== checkedCount ? `, patch narrowed to ${record.include_paths.length} path(s)` : ""}`,
		`displayed  : ${displayedPaths.length} of ${checkedCount} worker path(s)`,
		`remaining  : ${remainingPaths.length} worker path(s)`,
		`coverage   : ${coverageComplete ? "COMPLETE" : "INCOMPLETE"}${coverageComplete ? " — every worker path displayed for this bound hash" : " — review incomplete until every worker path is displayed (per-path truncated entries count; globally omitted paths do not)"}`,
		`next incl. : ${nextIncludeText}`,
		`review path: ${typeof record.review_path === "string" && record.review_path ? record.review_path : reviewRecordRelPath(record.delegation_id)}`,
	];
	if (record.violations.length > 0) {
		lines.push(`violations : ${record.violations.length}`);
		for (const v of record.violations) lines.push(`  - ${v.reason}`);
	}
	if (record.notes.length > 0) {
		for (const note of record.notes) lines.push(`note       : ${note}`);
	}
	if (record.drift_paths.length > 0) {
		lines.push(`drift      : ${record.drift_paths.join(", ")}`);
	}
	lines.push("", `patch (${record.patch.length} path(s)${record.patch_truncated ? ", truncated" : ""}):`, "");
	for (const entry of record.patch) {
		lines.push(`--- ${entry.path} (${entry.source}${entry.truncated ? ", truncated" : ""}) ---`);
		lines.push(entry.text);
	}
	if (record.patch_truncated || record.patch.length === 0 || remainingPaths.length > 0) {
		lines.push(
			"",
			"Patch content truncated or omitted — review segments via workbench_review_worker_diff include_paths (max 50 paths per call); scope checks and the bound hash always cover the complete actual diff.",
		);
	}
	// Bounded path/stat info for every patch path (kept even when content is
	// omitted/truncated so the reviewer can drive segmented re-reviews).
	const pathStats = record.patch_paths ?? record.patch.map((entry) => ({
		path: entry.path,
		source: entry.source,
		bytes: Buffer.byteLength(entry.text, "utf8"),
		truncated: entry.truncated,
	}));
	lines.push("", `patch paths (${pathStats.length}):`);
	for (const stat of pathStats) {
		lines.push(`  - ${stat.path} (${stat.source}, ${stat.bytes} bytes${stat.truncated ? ", truncated" : ""})`);
	}
	lines.push("", "Scope checks always cover the entire worker diff; include_paths only narrows the patch above.");
	return lines;
}

/**
 * Read the persisted review record of a delegation (null when absent or
 * corrupt). The delegation state entry stays owned by the runtime.
 */
export async function readReviewRecord(projectRoot: string, delegationId: string): Promise<ReviewRecord | null> {
	if (!isValidDelegationId(delegationId)) return null;
	try {
		const raw = await readFile(join(delegationDirFor(projectRoot, delegationId), "review.json"), "utf8");
		const parsed = JSON.parse(raw) as ReviewRecord;
		if (parsed.schema_version !== REVIEW_SCHEMA_VERSION || parsed.delegation_id !== delegationId) return null;
		// The finish-time PENDING_REVIEW placeholder (core/delegation-ledger.ts)
		// is not a completed review — treat it as "no review yet".
		if ((parsed as { review_status?: unknown }).review_status === "PENDING_REVIEW") return null;
		return parsed;
	} catch {
		return null;
	}
}
