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
 *   - writes ONLY review.json in the delegation directory and returns the
 *     verdict; the runtime wiring (index.ts) is the only component that
 *     touches the delegation state entry.
 *
 * Verdicts: PASS when no worker path is outside the approved scope;
 * FAIL when any violation exists (the runtime then refuses to mark the
 * delegation REVIEWED). The review never modifies project files and never
 * computes business metrics.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { truncateUtf8 } from "../worker/handoff.ts";

import {
	changedSinceBefore,
	collectGitFacts,
	computeDiffHash,
	contentDigest,
	delegationDirFor,
	isValidDelegationId,
	normalizeStatusPath,
	readBoundedFilePrefix,
	readDelegationLedger,
	writeJsonAtomic,
	type GitFacts,
} from "./delegation-ledger.ts";
import { redactText } from "./redact.ts";
import { isWorkerPathAllowedRealpath } from "../worker/path-scope.ts";
import type { ExecFn } from "./config.ts";

export const REVIEW_SCHEMA_VERSION = 1;
export const DEFAULT_REVIEW_MAX_LINES = 400;
export const DEFAULT_REVIEW_MAX_BYTES = 32 * 1024;
export const MAX_REVIEW_PATCH_PATHS = 50;
export const MAX_REVIEW_NOTES = 20;

export type ReviewVerdict = "PASS" | "FAIL";

export interface ReviewViolation {
	path: string;
	reason: string;
}

export interface ReviewPatchEntry {
	path: string;
	source: "git-diff" | "file-content" | "deleted";
	text: string;
	truncated: boolean;
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

function boundInt(raw: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof raw !== "number" || !Number.isInteger(raw)) return fallback;
	return Math.min(Math.max(raw, min), max);
}

/**
 * Bounded redacted patch text for one path: git diff + staged diff for
 * tracked changes; bounded-prefix file content for untracked files
 * (the file is never read in full — first maxBytes bytes plus the real
 * size, exactly like the digest reads); "(deleted)" marker when the path
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
): Promise<{ text: string; source: ReviewPatchEntry["source"]; truncated: boolean }> {
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
			out.push({ path: entry.path, source: entry.source, text: cut, truncated: true });
			break;
		}
		out.push({ path: entry.path, source: entry.source, text: entry.text, truncated: entry.perPathTruncated });
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

	// Real git state NOW — the review inspects the actual tree, never the
	// ledger's claims. Fail closed: an unavailable `git status` (thrown exec
	// error or non-zero exit) returns a structured failure and writes NO
	// review record — a fabricated clean tree could never be reviewed as
	// PASS.
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

	// Worker paths = TRUE paths changed between before and after (the ledger
	// derived them digest-based; previously-dirty paths are included).
	const workerPaths = [...ledger.after.changed_since_before].sort();
	const allowedPaths = ledger.before.contract.allowed_paths;

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

	// Scope check over ALL worker paths — include_paths can never hide a
	// violation. The check is realpath-safe: a symlink inside an approved
	// subtree that resolves OUTSIDE the subtree (or the project) is a
	// violation.
	const violations: ReviewViolation[] = [];
	for (const path of workerPaths) {
		if (!(await isWorkerPathAllowedRealpath(projectRoot, path, allowedPaths))) {
			violations.push({
				path,
				reason: `changed path "${path}" is outside the parent-approved scope (realpath/symlink check): ${allowedPaths.join(", ")}`,
			});
		}
	}

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
	const rawEntries: RawPatchEntry[] = [];
	for (const path of patchPaths.slice(0, MAX_REVIEW_PATCH_PATHS)) {
		const { text, source, truncated } = await patchTextFor(projectRoot, path, input.exec, secrets, maxBytes);
		rawEntries.push({ path, source, text, perPathTruncated: truncated });
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
	};

	try {
		await writeJsonAtomic(delegationDirFor(projectRoot, delegationId), "review.json", record);
	} catch (error) {
		return { ok: false, error: `failed to write review record: ${(error as Error).message}`, lines: [] };
	}

	return { ok: true, record, lines: renderReviewLines(record) };
}

/** Plain-text rendering of a review record (print/json mode content). */
export function renderReviewLines(record: ReviewRecord): string[] {
	const lines = [
		`delegation : ${record.delegation_id}`,
		`verdict    : ${record.verdict}`,
		`reviewed   : ${record.reviewed_at}`,
		`bound hash : ${record.bound_diff_hash}`,
		`after hash : ${record.recorded_after_hash}${record.mismatch ? " (MISMATCH)" : ""}`,
		`checked    : ${record.checked_paths.length} worker path(s)${record.include_paths.length > 0 && record.include_paths.length !== record.checked_paths.length ? `, patch narrowed to ${record.include_paths.length} path(s)` : ""}`,
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
	if (record.patch_truncated || record.patch.length === 0) {
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
