/**
 * P7 worker-diff scope/integrity service — bounded actual-diff evidence for
 * the Sol commander.  Its PASS/FAIL verdict is mechanical scope/integrity
 * evidence only: it is never semantic quality acceptance or Gate authority.
 * Pure logic with injected exec (git calls are argv-only, shell=false),
 * no Pi imports.
 *
 * The review reads the CURRENT workspace authority and the delegation
 * ledger, then:
 *   - derives the worker's TRUE changed paths relative to the before
 *     snapshot (new / deleted / digest-moved, including previously-dirty
 *     paths);
 *   - checks EVERY worker-delta path W against the parent-approved
 *     allowed_paths
 *     (the exact worker-policy scope semantics) with a realpath-safe
 *     check — symlink escapes count as violations, and `include_paths`
 *     only narrows the patch output and can never hide a violation;
 *     unsafe or non-worker include_paths entries are REFUSED;
 *   - computes the generation-specific current authority binding and
 *     compares it with the recorded after binding (mismatch/drift are
 *     recorded as warnings): new tagged v2 binds the W/D/S relevance
 *     projection, while historical untagged v2/v1 binds the complete full
 *     diff. Relevant later change turns the new-v2 bound state STALE;
 *     any later full-diff change does so for legacy. Drift compares the
 *     recorded after snapshot against the current authority, so same-path
 *     later edits are detected while baseline unrelated dirty paths remain
 *     outside new-v2 relevance;
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
 *     envelope. Scope checks always cover the complete actual worker delta
 *     W; the bound authority covers W/D/S relevance for new tagged v2 or
 *     the complete full diff for historical untagged v2/v1.
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
 *     fact. Every review segment still scope-checks EVERY W path. New
 *     tagged v2 binds the current W/D/S relevance projection; historical
 *     untagged v2/v1 binds the complete current full-diff hash.
 *     `include_paths` narrows only the rendered patch.
 *   - ordinary-source continuation: when exactly one worker path is selected
 *     and its complete redacted source/diff stream is at most 4 MiB, repeated
 *     same-hash review calls resume the next contiguous UTF-8 byte page. The
 *     cursor is bound to the stream SHA-256 and advances only when the page's
 *     whole title/body fits the final bounded result; stream/binding changes
 *     reset it and ACCEPT remains blocked until the cursor reaches the total.
 *   - Phase 5 (Execution Efficiency Optimization): CURRENT REGULAR
 *     `.svg`/`.json` worker paths LARGER than the default global review
 *     byte cap (COMPACT_MIN_BYTES = DEFAULT_REVIEW_MAX_BYTES = 32 KiB),
 *     plus binary/container paths of any size (known extension or bounded
 *     invalid-UTF-8/NUL detection),
 *     render as a deterministic COMPACT entry (bounded redacted
 *     UTF-8-safe head/tail previews — never empty for a non-empty
 *     window: the head is a bounded PREFIX and the tail a bounded
 *     SUFFIX of the redacted capture, so the tail preview represents
 *     the actual end of the file even for the bounded partial-line
 *     fallback of minified/single-line JSON; binary bytes are never decoded
 *     into a text preview — plus status/size/digest/
 *     recorded-after-equality facts and generator equality
 *     NOT_VERIFIED — the review never executes or imports repository
 *     generators), counting as displayed-path coverage, with no per-path
 *     git diff capture and no additional unbounded/full-file DISPLAY or
 *     preview capture — the existing bounded content digest is preserved
 *     (it may read the complete file through MAX_DIGEST_BYTES = 4 MiB and
 *     uses prefix+size beyond for historical authority; guard-v2 reuses the
 *     bounded full-file ChangeSet hashing ceiling); ordinary source/small/
 *     deleted/unreadable paths keep the existing behavior; scope/
 *     authority-binding/include_paths/coverage/STALE invariants are
 *     unchanged.
 *   - Phase 5 hardening: a worker path the authoritative scope/realpath
 *     check finds outside the parent-approved scope is WITHHELD — the
 *     review's per-path content pipeline (git diff capture, bounded file
 *     reads, display digests, rendering) never touches it, and its patch
 *     entry is a deterministic bounded `withheld` marker instead; the
 *     path still counts as an actually displayed entry and the verdict
 *     stays FAIL. Compact reads re-verify project-root realpath
 *     containment immediately before opening, so no compact read can
 *     follow an escaping symlink. Legacy v1/historical-v2 keep the complete
 *     collectGitFacts binding; new v2 instead binds W/D/S relevance.
 *   - writes ONLY review.json in the delegation directory and returns the
 *     verdict; the runtime wiring (index.ts) is the only component that
 *     touches the delegation state entry.
 *
 * Scope/integrity verdicts: PASS when no worker-delta path W is outside the approved scope;
 * FAIL when any violation exists (the runtime then refuses to mark the
 * delegation accepted, and a scope FAIL invalidates a prior same-hash
 * REVIEWED state fail-closed via core/delegation-state.ts). The review
 * never modifies project files, never assesses semantic correctness, never
 * grants Gate authority, and never computes business metrics.
 */

import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { truncateUtf8 } from "../worker/handoff.ts";
import { canonicalHash } from "../cache/canonical-hash.ts";

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
	writeTextAtomic,
	type GitFacts,
} from "./delegation-ledger.ts";
import { realpathContained } from "./path-guard.ts";
import { redactText } from "./redact.ts";
import { captureStreamingIdentities } from "./streaming-identity.ts";
import { isWorkerPathAllowedRealpath } from "../worker/path-scope.ts";
import { readJsonFileBounded, type BoundedFileIoHooks } from "./bounded-file-io.ts";
import type { ExecFn } from "./config.ts";
import {
	REVIEW_RELEVANCE_KIND_V2,
	computeReviewRelevanceProjectionHashV2,
	validateReviewRelevanceBindingV2,
	validateReviewRelevanceProjectionV2,
	type ReviewRelevanceBindingV2,
	type ReviewRelevanceProjectionV2,
} from "./review-relevance-v2.ts";
import {
	SEMANTIC_REVIEW_ENVELOPE_MAX_AGGREGATE_BYTES_V1,
	SEMANTIC_REVIEW_ENVELOPE_MAX_RECORD_BYTES_V1,
	SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1,
	buildSemanticReviewEnvelopeV1,
	estimateSemanticReviewRecordBytesV1,
	validateSemanticReviewEnvelopeV1,
	type SemanticReviewEnvelopeErrorCodeV1,
	type SemanticReviewEnvelopeV1,
	type SemanticReviewStreamDescriptorV1,
} from "./semantic-review-envelope.ts";

export const REVIEW_SCHEMA_VERSION = 1;
export const DEFAULT_REVIEW_MAX_LINES = 400;
export const DEFAULT_REVIEW_MAX_BYTES = 32 * 1024;
/** Fixed pre-allocation cap for the authoritative persisted review record. */
export const REVIEW_RECORD_MAX_BYTES = SEMANTIC_REVIEW_ENVELOPE_MAX_RECORD_BYTES_V1;
export const REVIEW_ERROR_MAX_BYTES = 8 * 1024;
export const MAX_REVIEW_PATCH_PATHS = 50;
export const MAX_REVIEW_NOTES = 10;
export const MAX_REVIEW_VIOLATIONS = 10;
export const MAX_REVIEW_DRIFT_PATHS = 20;
export const MAX_REVIEW_PATH_BYTES = 300;
export const MAX_REVIEW_REASON_BYTES = 240;
export const MAX_REVIEW_NOTE_BYTES = 240;
export const REVIEW_CONTROL_MAX_BYTES = 8 * 1024;
export const REVIEW_PATCH_MAX_BYTES = 20 * 1024;
export const REVIEW_PATH_STATS_MAX_BYTES = 4 * 1024;
export const REVIEW_CONTROL_MAX_LINES = 100;
export const REVIEW_PATCH_MAX_LINES = 240;
export const REVIEW_PATH_STATS_MAX_LINES = 60;
/**
 * Maximum complete redacted source/diff stream eligible for automatic
 * continuation paging.  The stream is never persisted in full: only the
 * currently visible page plus a hash-bound contiguous byte cursor is kept.
 */
export const REVIEW_PAGE_SOURCE_MAX_BYTES = SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1;
/** One durable presentation proof per checked worker path. */
export const REVIEW_PRESENTATION_PROGRESS_MAX_ITEMS = 500;
/** Legacy read-only bound; new records keep one tail segment plus O(1) receipt state. */
export const REVIEW_PRESENTATION_SEGMENT_MAX_ITEMS = 4_096;
/** Bound total source bytes revalidated before semantic ACCEPT. */
export const REVIEW_PRESENTATION_VALIDATION_MAX_BYTES = SEMANTIC_REVIEW_ENVELOPE_MAX_AGGREGATE_BYTES_V1;
/** Space reserved inside the patch section for the title and fail-closed marker. */
const REVIEW_PAGE_ENVELOPE_RESERVE_BYTES = 1_152;
const REVIEW_PAGE_ENVELOPE_RESERVE_LINES = 4;
export const REVIEW_PAGE_BODY_MAX_BYTES = REVIEW_PATCH_MAX_BYTES - REVIEW_PAGE_ENVELOPE_RESERVE_BYTES;
export const REVIEW_PAGE_BODY_MAX_LINES = REVIEW_PATCH_MAX_LINES - REVIEW_PAGE_ENVELOPE_RESERVE_LINES;
/** Hard aggregate page ceiling shared by automatic structured review. */
export const STRUCTURED_REVIEW_PRESENTATION_MAX_PAGES_V1 = 512 as const;

/**
 * Compile the exact canonical payload accepted by readReviewRecord before
 * opening the atomic writer. Review authority is never silently truncated:
 * complete facts either fit the fixed reader cap byte-for-byte (including
 * the trailing newline) or persistence fails closed.
 */
export function compileReviewRecordPayload(record: ReviewRecord): string | undefined {
	try {
		const payload = `${JSON.stringify(record, null, 2)}\n`;
		return Buffer.byteLength(payload, "utf8") <= REVIEW_RECORD_MAX_BYTES ? payload : undefined;
	} catch {
		return undefined;
	}
}

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
 * Binary/container formats that are compact evidence by construction,
 * regardless of file size. Unknown extensions are still detected from
 * bounded head/tail bytes (invalid UTF-8 or NUL content).
 */
export const BINARY_COMPACT_EXTENSIONS = [
	".7z", ".a", ".apk", ".arrow", ".avi", ".bin", ".bmp", ".bz2", ".class", ".db", ".dll", ".doc",
	".docx", ".dylib", ".exe", ".feather", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mkv",
	".mov", ".mp3", ".mp4", ".npy", ".npz", ".onnx", ".parquet", ".pdf", ".pickle", ".pkl", ".png",
	".ppt", ".pptx", ".pyc", ".rar", ".so", ".sqlite", ".tar", ".tgz", ".tif", ".tiff", ".wasm",
	".wav", ".webp", ".xls", ".xlsx", ".xz", ".zip",
] as const;
const BINARY_COMPACT_EXTENSION_SET = new Set<string>(BINARY_COMPACT_EXTENSIONS);
const BINARY_PREVIEW_OMITTED = "(binary preview omitted)";
/**
 * A text SVG/JSON path is compact-eligible only when its CURRENT REGULAR
 * file is LARGER than this size. Binary compact packets are size-independent.
 * The threshold is tied to the existing default
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
 * `.json` worker path or one detected binary/container path. Additive on the review record — schema_version
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
	/** Present only for binary compact packets; absence preserves historical text compact records. */
	content_kind?: "binary";
	/** Current porcelain status code of the path (" M", "??", "A ", "D "...). */
	git_status: string;
	/** Real byte size of the current regular file. */
	size_bytes: number;
	/** Current content digest (the existing digest form — see digest_kind). */
	digest: string;
	/** Full "sha256" authority, or historical "sha256-prefix+size" display authority beyond 4 MiB. */
	digest_kind: ReviewDigestKind;
	/** Fixed byte boundary at which the historical display digest switches form (MAX_DIGEST_BYTES). */
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
	/**
	 * Additive ordinary-source page identity.  A page is one contiguous
	 * UTF-8 byte range of a complete, redacted source/diff stream.  Repeating
	 * the same single include_path automatically resumes at end_byte.
	 */
	page?: ReviewPatchPage;
}

export interface ReviewPatchPage {
	stream_sha256: string;
	start_byte: number;
	end_byte: number;
	total_bytes: number;
}

/** Durable, same-bound-hash contiguous presentation cursor for one path. */
export interface ReviewPresentationProgress {
	path: string;
	source: ReviewPatchEntry["source"];
	stream_sha256: string;
	next_byte: number;
	total_bytes: number;
	/** Contiguous page receipts from byte zero through next_byte. */
	segments: ReviewPresentationSegment[];
	/** O(paths) v1 accumulator. New writes retain only the latest segment. */
	page_count?: number;
	/** SHA-256 of the exact authoritative stream prefix [0,next_byte). */
	receipt_sha256?: string;
}

export interface ReviewPresentationSegment {
	start_byte: number;
	end_byte: number;
	page_sha256: string;
}

/** Bounded per-path patch stat (bytes of the rendered entry text; 0 when omitted). */
export interface ReviewPatchPathStat {
	path: string;
	source: ReviewPatchEntry["source"] | "omitted";
	bytes: number;
	truncated: boolean;
}

export interface SemanticAcceptanceRecord {
	decision: "ACCEPT";
	expected_bound_diff_hash: string;
	reviewer: {
		provider: "openai" | "openai-codex";
		model: "gpt-5.6-sol";
	};
	accepted_at: string;
}

export interface ReviewRecord {
	schema_version: number;
	delegation_id: string;
	reviewed_at: string;
	verdict: ReviewVerdict;
	/** The CURRENT generation-specific authority hash: new-v2 W/D/S relevance or legacy full diff. */
	bound_diff_hash: string;
	/** The worker's recorded after authority hash (compatibility field name retained). */
	recorded_after_hash: string;
	/** True when the current generation-specific authority hash differs from the recorded after hash. */
	mismatch: boolean;
	/** Relevant new-v2 or complete legacy paths that changed after the worker finished. */
	drift_paths: string[];
	/** Worker paths outside the parent-approved scope (verdict FAIL when non-empty). */
	violations: ReviewViolation[];
	/** Full domain scope remains durable; presentation renders it once as count/hash/bounded preview. */
	allowed_paths?: string[];
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
	/**
	 * Same-hash paths whose patch entry was presented without global or
	 * per-path truncation.  These additive fields are optional only for
	 * historical records; newly written records always carry all three.
	 */
	fully_presented_paths?: string[];
	presentation_remaining_paths?: string[];
	presentation_complete?: boolean;
	/**
	 * Additive automatic-page cursors. Historical records omit this field.
	 * Each cursor starts at byte zero and advances only after the complete
	 * page was present in the bounded tool result for the same bound hash.
	 */
	presentation_progress?: ReviewPresentationProgress[];
	/** New strict semantic provenance. Historical records omit both fields. */
	semantic_review?: "required" | "accepted" | "not_required";
	semantic_acceptance?: SemanticAcceptanceRecord;
	/** Durable project-relative review.json path (reviewRecordRelPath). */
	review_path: string;
	/** New-v2 only. Legacy v1 and old-v2 schema1 records omit these fields. */
	diff_identity_kind?: typeof REVIEW_RELEVANCE_KIND_V2;
	relevance_binding?: ReviewRelevanceBindingV2;
	relevance_projection?: ReviewRelevanceProjectionV2;
	/** Commit-time proof that this PENDING review lies inside the closure envelope. */
	review_envelope?: SemanticReviewEnvelopeV1;
}

export type SemanticReviewRisk = "low" | "medium" | "high";

export interface SemanticReviewClassification {
	risk: SemanticReviewRisk;
	required: boolean;
	reason: "zero_delta" | "documentation_only" | "compact_evidence" | "sensitive_or_governance" | "implementation_or_unknown";
}

const PLAIN_DOCUMENTATION_EXTENSIONS = new Set([".md", ".rst", ".txt"]);
const SENSITIVE_PATH_TOKENS = new Set([
	"api", "apis", "auth", "authorization", "config", "configs", "delegation", "delegations",
	"gate", "gates", "migration", "migrations", "permission", "permissions", "policy", "policies",
	"runtime", "schema", "schemas", "security",
]);

function pathExtension(path: string): string {
	const name = path.split("/").at(-1)?.toLowerCase() ?? "";
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot) : "";
}

function isSensitiveReviewPath(path: string): boolean {
	const lower = path.toLowerCase();
	const segments = lower.split("/");
	if (segments.some((segment) => segment.startsWith("."))) return true;
	if (["agents.md", "security.md", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(segments.at(-1) ?? "")) return true;
	return segments.some((segment) => {
		const words = segment.split(/[^a-z0-9]+/u).filter(Boolean);
		return words.some((word) => SENSITIVE_PATH_TOKENS.has(word));
	});
}

/**
 * Conservative, path-only risk hint for the commander handoff.  It cannot
 * lower authority: every non-zero implementation delta still requires an
 * explicit Sol semantic ACCEPT in the P0 policy, including low-risk docs.
 */
export function classifySemanticReviewRisk(paths: readonly string[]): SemanticReviewClassification {
	if (paths.length === 0) return { risk: "low", required: false, reason: "zero_delta" };
	// Large JSON/SVG paths may be rendered through the strict compact-facts
	// packet.  Keep the path-only hint conservative so the risk remains high
	// across segmented reviews even when the compact entry is in a prior
	// same-hash segment and is no longer present in the current patch array.
	if (paths.some(isCompactEligiblePath)) {
		return { risk: "high", required: true, reason: "compact_evidence" };
	}
	if (paths.some(isSensitiveReviewPath)) {
		return { risk: "high", required: true, reason: "sensitive_or_governance" };
	}
	if (paths.every((path) => PLAIN_DOCUMENTATION_EXTENSIONS.has(pathExtension(path)))) {
		return { risk: "low", required: true, reason: "documentation_only" };
	}
	return { risk: "medium", required: true, reason: "implementation_or_unknown" };
}

export interface ReviewResult {
	ok: boolean;
	error?: string;
	record?: ReviewRecord;
	/** Plain text lines for the tool content (print/json modes). */
	lines: string[];
}

export interface ReviewRenderCaps {
	maxBytes?: number;
	maxLines?: number;
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
 * Strict callers may supply already-authorized delegation facts.  This is
 * the common review-computation seam used by v1 and v2: scope checking,
 * current git collection, drift/diff hashing, bounded patch rendering and
 * segmented coverage remain implemented exactly once below.
 */
export interface ReviewAuthorityFacts {
	delegation_id: string;
	allowed_paths: readonly string[];
	worker_paths: readonly string[];
	/** Immutable rejected-lineage paths promoted into this successor's review scope. */
	lineage_carried_paths?: readonly string[];
	recorded_after_hash: string;
	after: GitFacts;
	reported_paths: readonly string[];
	/** New-v2 guard-native review seam; presence suppresses legacy Git collection. */
	current?: GitFacts;
	current_diff_hash?: string;
	drift_paths?: readonly string[];
	relevance_binding?: ReviewRelevanceBindingV2;
	relevance_projection?: ReviewRelevanceProjectionV2;
	review_envelope?: SemanticReviewEnvelopeV1;
}

export interface ReviewFromAuthorityInput extends ReviewInput {
	authority: ReviewAuthorityFacts;
	priorReview: ReviewRecord | null;
	reviewPath: string;
}

/**
 * Deterministic path-level compact eligibility: large `.svg`/`.json` files
 * and known binary/container extensions. Unknown-extension binary files are
 * additionally detected from bounded bytes by compactFactsFor.
 */
export function isCompactEligiblePath(path: string): boolean {
	const extension = pathExtension(path);
	return COMPACT_ELIGIBLE_EXTENSIONS.includes(extension as ".svg" | ".json") ||
		BINARY_COMPACT_EXTENSION_SET.has(extension);
}

function isTextCompactEligiblePath(path: string): boolean {
	return COMPACT_ELIGIBLE_EXTENSIONS.includes(pathExtension(path) as ".svg" | ".json");
}

function utf8SequenceBytes(lead: number): number | undefined {
	if (lead >= 0xc2 && lead <= 0xdf) return 2;
	if (lead >= 0xe0 && lead <= 0xef) return 3;
	if (lead >= 0xf0 && lead <= 0xf4) return 4;
	return undefined;
}

function isUtf8HeadWindow(buffer: Buffer, mayEndMidScalar: boolean): boolean {
	if (isUtf8(buffer)) return true;
	if (!mayEndMidScalar) return false;
	for (let suffixBytes = 1; suffixBytes <= 3 && suffixBytes <= buffer.length; suffixBytes += 1) {
		const leadIndex = buffer.length - suffixBytes;
		const sequenceBytes = utf8SequenceBytes(buffer[leadIndex]!);
		if (sequenceBytes === undefined || sequenceBytes <= suffixBytes) continue;
		if (!buffer.subarray(leadIndex + 1).every((byte) => (byte & 0xc0) === 0x80)) continue;
		if (isUtf8(buffer.subarray(0, leadIndex))) return true;
	}
	return false;
}

function isUtf8TailWindow(buffer: Buffer): boolean {
	if (isUtf8(buffer)) return true;
	let start = 0;
	while (start < Math.min(3, buffer.length) && (buffer[start]! & 0xc0) === 0x80) start += 1;
	return start > 0 && isUtf8(buffer.subarray(start));
}

function boundedBytesLookBinary(path: string, head: Buffer, tail: Buffer, size: number): boolean {
	return BINARY_COMPACT_EXTENSION_SET.has(pathExtension(path)) || head.includes(0) || tail.includes(0) ||
		!isUtf8HeadWindow(head, size > head.length) || !isUtf8TailWindow(tail);
}

/**
 * Honest label of the active digest form: 64 hex is a full SHA-256
 * (including guard-v2 streaming authority beyond 4 MiB); `sha256:size` is
 * the historical bounded prefix+size display form.
 */
export function digestKindOf(digest: string): ReviewDigestKind {
	return /^[0-9a-f]{64}:\d+$/.test(digest) ? "sha256-prefix+size" : "sha256";
}

function boundInt(raw: number | undefined, fallback: number, min: number, max: number): number {
	if (raw === undefined) return fallback;
	// Explicit malformed caps fail closed to the minimum; they never amplify
	// into a default or lift a compile-time ceiling.
	if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return min;
	return Math.min(Math.max(raw, min), max);
}

type ReviewFailureCode =
	| "invalid_delegation"
	| "delegation_not_found"
	| "delegation_incomplete"
	| "git_state_unavailable"
	| "invalid_include_path"
	| "include_path_not_in_diff"
	| "presentation_page_unavailable"
	| "review_persist_failed"
	| "runtime_failure";

const REVIEW_FAILURE_TEXT: Readonly<Record<ReviewFailureCode, string>> = Object.freeze({
	invalid_delegation: "invalid delegation id",
	delegation_not_found: "delegation not found or incomplete",
	delegation_incomplete: "delegation has no recorded result (still running or incomplete)",
	git_state_unavailable: "cannot collect the real git state; git status --porcelain failed",
	invalid_include_path: "include_paths entry is not a safe project-relative path (absolute, drive-letter, parent escape, and overlong paths are refused)",
	include_path_not_in_diff: "include_paths entry is not part of the worker diff",
	presentation_page_unavailable: "the selected ordinary source cannot advance within the authorized review envelope or fixed 4 MiB paging ceiling",
	review_persist_failed: "failed to write review record",
	runtime_failure: "diff review failed closed",
});

function reviewFailure(code: ReviewFailureCode): ReviewResult {
	const error = `${code}: ${REVIEW_FAILURE_TEXT[code]}`;
	const text = `[workbench-diff-review error code=${code}]\n${REVIEW_FAILURE_TEXT[code]}`;
	return {
		ok: false,
		error: truncateUtf8(error, REVIEW_ERROR_MAX_BYTES),
		lines: truncateUtf8(text, REVIEW_ERROR_MAX_BYTES).split("\n"),
	};
}

function unicodeScalarText(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) { output += value.slice(index, index + 2); index += 1; }
			else output += "\ufffd";
		} else if (unit >= 0xdc00 && unit <= 0xdfff) output += "\ufffd";
		else output += value[index];
	}
	return output;
}

function boundedInline(value: unknown, maxBytes: number): string {
	const source = unicodeScalarText(typeof value === "string" ? value : "(invalid)").replace(/[\u0000-\u001f\u007f]/g, " ");
	if (Buffer.byteLength(source, "utf8") <= maxBytes) return source;
	if (maxBytes < 3) return truncateUtf8(source, maxBytes);
	return `${truncateUtf8(source, maxBytes - 3)}…`;
}

function textByteLength(lines: readonly string[]): number {
	return Buffer.byteLength(lines.join("\n"), "utf8");
}

class ReviewLineBuilder {
	readonly lines: string[] = [];
	constructor(readonly maxBytes: number, readonly maxLines: number) {}

	canAdd(lines: readonly string[]): boolean {
		if (lines.length === 0) return true;
		const joined = [...this.lines, ...lines];
		return joined.length <= this.maxLines && textByteLength(joined) <= this.maxBytes;
	}

	add(lines: readonly string[]): boolean {
		if (!this.canAdd(lines)) return false;
		this.lines.push(...lines);
		return true;
	}
}

interface ReviewSectionCaps {
	controlBytes: number;
	patchBytes: number;
	statBytes: number;
	controlLines: number;
	patchLines: number;
	statLines: number;
}

/** Keep review computation and final rendering on the same exact envelope. */
function reviewSectionCaps(maxBytes: number, maxLines: number): ReviewSectionCaps {
	// Two inter-section newline bytes are reserved inside the whole cap.
	const allocatableBytes = Math.max(0, maxBytes - 2);
	const controlBytes = Math.min(REVIEW_CONTROL_MAX_BYTES, Math.max(512, Math.floor(allocatableBytes / 4)));
	const afterControlBytes = Math.max(0, allocatableBytes - controlBytes);
	const statBytes = Math.min(REVIEW_PATH_STATS_MAX_BYTES, Math.floor(afterControlBytes / 5));
	const patchBytes = Math.min(REVIEW_PATCH_MAX_BYTES, Math.max(0, afterControlBytes - statBytes));
	const controlLines = Math.min(REVIEW_CONTROL_MAX_LINES, Math.max(12, Math.floor(maxLines / 4)));
	const afterControlLines = Math.max(0, maxLines - controlLines);
	const statLines = Math.min(REVIEW_PATH_STATS_MAX_LINES, Math.floor(afterControlLines / 5));
	const patchLines = Math.min(REVIEW_PATCH_MAX_LINES, Math.max(0, afterControlLines - statLines));
	return { controlBytes, patchBytes, statBytes, controlLines, patchLines, statLines };
}

function allowedScopeLine(allowedPaths: readonly string[]): string {
	const normalized = allowedPaths.map((path) => boundedInline(path, MAX_REVIEW_PATH_BYTES));
	const hash = createHash("sha256").update(JSON.stringify(allowedPaths)).digest("hex");
	const shown: string[] = [];
	let bytes = 2;
	for (const path of normalized) {
		const encoded = JSON.stringify(path);
		const next = Buffer.byteLength(encoded, "utf8") + (shown.length > 0 ? 2 : 0);
		if (shown.length >= 5 || bytes + next > 900) break;
		shown.push(path);
		bytes += next;
	}
	return `allowed    : count=${allowedPaths.length} hash=${hash} shown=[${shown.map((path) => JSON.stringify(path)).join(", ")}] omitted=${allowedPaths.length - shown.length}`;
}

function boundedPathList(prefix: string, paths: readonly string[], maxItems: number): string {
	const shown: string[] = [];
	for (const raw of paths.slice(0, maxItems)) {
		const path = boundedInline(raw, MAX_REVIEW_PATH_BYTES);
		const trial = [...shown, path];
		const omitted = paths.length - trial.length;
		const suffix = omitted > 0 ? ` …(+${omitted} more)` : "";
		if (Buffer.byteLength(`${prefix}${trial.join(", ")}${suffix}`, "utf8") > MAX_REVIEW_NOTE_BYTES) break;
		shown.push(path);
	}
	const omitted = paths.length - shown.length;
	const suffix = omitted > 0 ? ` …(+${omitted} more)` : "";
	const body = `${prefix}${shown.join(", ")}`;
	const bodyBudget = Math.max(0, MAX_REVIEW_NOTE_BYTES - Buffer.byteLength(suffix, "utf8"));
	return `${boundedInline(body, bodyBudget)}${suffix}`;
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

interface PageablePatchStream {
	text: string;
	source: "git-diff" | "file-content";
	streamSha256: string;
}

/**
 * Read one complete ordinary presentation stream only when it stays within
 * the fixed paging ceiling. This path is used solely for a single selected
 * worker path; ordinary multi-path review keeps the existing bounded-prefix
 * behavior. The complete stream is ephemeral and only its SHA-256 plus the
 * currently visible page are persisted.
 */
async function pageablePatchStreamFor(
	projectRoot: string,
	path: string,
	exec: ExecFn,
	secrets: readonly string[],
): Promise<PageablePatchStream | null> {
	try {
		const worktree = await exec("git", ["diff", "--", path], { cwd: projectRoot });
		const staged = await exec("git", ["diff", "--cached", "--", path], { cwd: projectRoot });
		const gitText = [worktree.stdout, staged.stdout].filter(Boolean).join("");
		if (gitText.trim()) {
			const text = redactText(gitText, secrets);
			if (Buffer.byteLength(text, "utf8") > REVIEW_PAGE_SOURCE_MAX_BYTES) return null;
			return {
				text,
				source: "git-diff",
				streamSha256: createHash("sha256").update(text, "utf8").digest("hex"),
			};
		}
	} catch {
		return null;
	}
	const real = await realpathContained(projectRoot, path);
	if (real === undefined) return null;
	const read = await readBoundedFilePrefix(real, REVIEW_PAGE_SOURCE_MAX_BYTES);
	if (!read || read.size > REVIEW_PAGE_SOURCE_MAX_BYTES) return null;
	const text = redactText(read.data.toString("utf8"), secrets);
	// Redaction may expand the stream (for example a short secret replaced by
	// a longer marker).  The published ceiling applies to the actual stream
	// whose hash/cursor are persisted, not merely to the pre-redaction file.
	if (Buffer.byteLength(text, "utf8") > REVIEW_PAGE_SOURCE_MAX_BYTES) return null;
	return {
		text,
		source: "file-content",
		streamSha256: createHash("sha256").update(text, "utf8").digest("hex"),
	};
}

function isUtf8Boundary(buffer: Buffer, offset: number): boolean {
	return offset === 0 || offset === buffer.length || (buffer[offset]! & 0xc0) !== 0x80;
}

/** Return the next non-empty UTF-8-safe bounded page and its exact end. */
function slicePresentationPage(
	text: string,
	startByte: number,
	maxBytes: number,
	maxLines: number,
): { text: string; endByte: number; totalBytes: number } | null {
	const encoded = Buffer.from(text, "utf8");
	if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte >= encoded.length ||
		!isUtf8Boundary(encoded, startByte) || maxBytes <= 0 || maxLines <= 0) return null;
	const suffix = encoded.subarray(startByte).toString("utf8");
	const byteBounded = truncateUtf8(suffix, maxBytes);
	let page = sliceTextToBudgets(byteBounded, maxLines, maxBytes);
	// A prior page can end immediately before a newline. Consume that scalar
	// rather than producing a zero-length page and stalling the cursor.
	if (page.length === 0 && suffix.startsWith("\n") && maxBytes >= 1) page = "\n";
	if (page.length === 0) return null;
	const pageBytes = Buffer.byteLength(page, "utf8");
	const endByte = startByte + pageBytes;
	if (endByte <= startByte || endByte > encoded.length || !isUtf8Boundary(encoded, endByte)) return null;
	return { text: page, endByte, totalBytes: encoded.length };
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
	mode: "current" | "legacy-text-only" = "current",
): Promise<ReviewCompactFacts | null> {
	const real = await realpathContained(projectRoot, path);
	if (real === undefined) return null;
	const read = await readBoundedHeadTail(real, COMPACT_READ_BYTES);
	if (!read) return null;
	const binary = mode === "current" && boundedBytesLookBinary(path, read.head, read.tail, read.size);
	if (!binary && (!isTextCompactEligiblePath(path) || read.size <= COMPACT_MIN_BYTES)) return null;
	const afterDigest = afterDigests[path];
	let digest = await contentDigest(projectRoot, path);
	if (digest === undefined) return null;
	// Guard-v2 ChangeSet authority retains a full streaming SHA-256 through
	// its 64 MiB file ceiling, while the historical display digest switches
	// to prefix+size above 4 MiB. Reuse the same bounded streaming primitive
	// when a full recorded-after digest is available so large binary packets
	// remain closable without weakening legacy digest semantics.
	if (digest.includes(":") && afterDigest !== undefined && /^[0-9a-f]{64}$/u.test(afterDigest)) {
		const captured = await captureStreamingIdentities({ project_root: projectRoot, paths: [path] });
		const identity = captured.ok ? captured.identities[0] : undefined;
		if (identity === undefined || identity.kind !== "file" || identity.byte_size !== read.size) return null;
		digest = identity.sha256;
	}
	if (binary) {
		return {
			content_kind: "binary",
			git_status: currentStatus,
			size_bytes: read.size,
			digest,
			digest_kind: digestKindOf(digest),
			digest_max_bytes: MAX_DIGEST_BYTES,
			digest_matches_after: afterDigest !== undefined && afterDigest === digest,
			generator_equality: COMPACT_GENERATOR_EQUALITY,
			head_preview: JSON.stringify(BINARY_PREVIEW_OMITTED),
			tail_preview: JSON.stringify(BINARY_PREVIEW_OMITTED),
			head_lines: 0,
			tail_lines: 0,
			head_partial_line: false,
			tail_partial_line: false,
			head_bytes: 0,
			tail_bytes: 0,
			content_truncated: read.size > 0,
		};
	}
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
	if (facts.content_kind === "binary") {
		return [
			`compact   : kind=binary status=${JSON.stringify(facts.git_status)} size=${facts.size_bytes} bytes digest=${facts.digest} (${facts.digest_kind}${digestKindNote})`,
			`digest    : ${facts.digest_matches_after ? "matches the worker's recorded-after digest" : "DIFFERS from the worker's recorded-after digest (or no recorded-after digest exists)"}`,
			`preview   : ${facts.head_preview} (binary bytes are not decoded or paged as UTF-8; shown_bytes=${facts.head_bytes + facts.tail_bytes})`,
			`truncated : binary content is represented only by bounded identity facts (content_truncated=${facts.content_truncated})`,
			`semantic  : binary contents NOT_INSPECTED; generator equality ${facts.generator_equality} — independent artifact validation is required`,
		].join("\n");
	}
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
 * Whether one visible patch entry is a complete bounded presentation unit.
 *
 * Ordinary sources must be shown without truncation.  A strict compact entry
 * is intentionally a complete *fact packet* rather than the full file bytes:
 * its current digest must match the worker's recorded-after digest, its
 * structured facts must render byte-for-byte to the visible text, and its
 * source remains explicit.  Generator equality is deliberately NOT_VERIFIED
 * and therefore remains a high-risk final-verification concern; it is never
 * upgraded into a Gate fact here.
 */
export function isCompleteReviewPresentationEntry(entry: ReviewPatchEntry): boolean {
	if (entry.source === "compact" && entry.compact !== undefined) {
		return entry.compact.digest_matches_after === true
			&& entry.compact.generator_equality === "NOT_VERIFIED"
			&& entry.text === renderCompactFacts(entry.compact);
	}
	return !entry.truncated;
}

/**
 * Bounded redacted patch entry for ONE path. Phase 5: a sufficiently
 * large CURRENT REGULAR `.svg`/`.json` worker path or detected binary takes the compact path
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
	pageRequest?: {
		prior?: ReviewPresentationProgress;
		maxBytes: number;
		maxLines: number;
	},
): Promise<RawPatchEntry> {
	const compact = await compactFactsFor(projectRoot, path, secrets, afterDigests, currentStatus);
	if (compact) {
		return { path, source: "compact", text: renderCompactFacts(compact), perPathTruncated: compact.content_truncated, compact };
	}
	if (pageRequest !== undefined) {
		const stream = await pageablePatchStreamFor(projectRoot, path, exec, secrets);
		if (stream !== null) {
			const totalBytes = Buffer.byteLength(stream.text, "utf8");
			const prior = pageRequest.prior;
			const startByte = prior !== undefined && prior.source === stream.source &&
				prior.stream_sha256 === stream.streamSha256 && prior.total_bytes === totalBytes
				? prior.next_byte
				: 0;
			if (totalBytes > 0 && startByte < totalBytes) {
				const page = slicePresentationPage(stream.text, startByte, pageRequest.maxBytes, pageRequest.maxLines);
				if (page !== null) {
					const encoded = Buffer.from(stream.text, "utf8");
					return {
						path,
						source: stream.source,
						text: page.text,
						perPathTruncated: page.endByte < page.totalBytes || startByte > 0,
						prefixReceiptSha256: createHash("sha256").update(encoded.subarray(0, page.endByte)).digest("hex"),
						page: {
							stream_sha256: stream.streamSha256,
							start_byte: startByte,
							end_byte: page.endByte,
							total_bytes: page.totalBytes,
						},
					};
				}
			}
		}
	}
	return patchTextFor(projectRoot, path, exec, secrets, maxBytes).then((entry) => ({ path, ...entry, perPathTruncated: entry.truncated }));
}

export type SemanticReviewEnvelopePreflightFailureCode =
	| SemanticReviewEnvelopeErrorCodeV1
	| "presentation_unavailable";

export type SemanticReviewEnvelopePreflightResult =
	| { ok: true; value: SemanticReviewEnvelopeV1 }
	| { ok: false; code: SemanticReviewEnvelopePreflightFailureCode };

/** Historical v1 estimate. It is not safe for new admission because byte- and line-heavy regions can be disjoint. */
function legacyProjectedPageCount(text: string): number | undefined {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes === 0) return 0;
	let lines = 1;
	for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1;
	const pages = Math.max(
		Math.ceil(bytes / REVIEW_PAGE_BODY_MAX_BYTES),
		Math.ceil(lines / REVIEW_PAGE_BODY_MAX_LINES),
	);
	return Number.isSafeInteger(pages) && pages > 0 ? pages : undefined;
}

interface IteratedPresentationPage {
	text: string;
	start_byte: number;
	end_byte: number;
	total_bytes: number;
}

/** Run the exact production slicer until EOF; estimates are never admission authority. */
function iteratePresentationPages(
	text: string,
	maxPages: number = STRUCTURED_REVIEW_PRESENTATION_MAX_PAGES_V1,
): IteratedPresentationPage[] | undefined {
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes === 0) return [];
	const pages: IteratedPresentationPage[] = [];
	let startByte = 0;
	while (startByte < totalBytes) {
		if (pages.length >= maxPages) return undefined;
		const page = slicePresentationPage(text, startByte, REVIEW_PAGE_BODY_MAX_BYTES, REVIEW_PAGE_BODY_MAX_LINES);
		if (page === null || page.totalBytes !== totalBytes || page.endByte <= startByte) return undefined;
		pages.push({ text: page.text, start_byte: startByte, end_byte: page.endByte, total_bytes: totalBytes });
		startByte = page.endByte;
	}
	return startByte === totalBytes ? pages : undefined;
}

function actualPresentationPageCount(
	text: string,
	maxPages: number = STRUCTURED_REVIEW_PRESENTATION_MAX_PAGES_V1,
): number | undefined {
	return iteratePresentationPages(text, maxPages)?.length;
}

interface RebuiltRedactedReviewStream {
	source: SemanticReviewStreamDescriptorV1["source"];
	text: string;
}

/** Shared current-state constructor used by admission and automatic presentation collection. */
async function rebuildRedactedReviewStream(input: {
	projectRoot: string;
	path: string;
	afterDigests: Readonly<Record<string, string>>;
	pathStatus: string;
	exec: ExecFn;
	secrets: readonly string[];
}): Promise<RebuiltRedactedReviewStream | undefined> {
	const compact = await compactFactsFor(
		input.projectRoot,
		input.path,
		input.secrets,
		input.afterDigests,
		input.pathStatus,
	);
	if (compact !== null) return { source: "compact", text: renderCompactFacts(compact) };
	const stream = await pageablePatchStreamFor(input.projectRoot, input.path, input.exec, input.secrets);
	if (stream !== null) return { source: stream.source, text: stream.text };
	const deleted = !(input.path in input.afterDigests) && input.pathStatus.includes("D");
	return deleted ? { source: "deleted", text: "(deleted or unreadable)" } : undefined;
}

/**
 * Compute the exact current presentation-stream admission proof before a
 * generation is published PENDING_REVIEW.  The same compact/full-stream
 * constructors are used by review itself, so oversize, aggregate and record
 * capacity failures become explicit pre-publication recovery instead of a
 * permanently uncloseable PENDING transaction.
 */
export async function preflightSemanticReviewEnvelopeV1(input: {
	projectRoot: string;
	workerPaths: readonly string[];
	allowedPaths: readonly string[];
	afterDigests: Readonly<Record<string, string>>;
	pathStatuses: Readonly<Record<string, string>>;
	relevanceProjection: ReviewRelevanceProjectionV2;
	relevanceProjectionHash: string;
	exec: ExecFn;
	secrets?: readonly string[];
}): Promise<SemanticReviewEnvelopePreflightResult> {
	try {
		const workerPaths = [...input.workerPaths];
		if (workerPaths.length > REVIEW_PRESENTATION_PROGRESS_MAX_ITEMS ||
			workerPaths.some((path, index) => index > 0 && Buffer.from(workerPaths[index - 1]!, "utf8").compare(Buffer.from(path, "utf8")) >= 0)) {
			return { ok: false, code: "invalid_input" };
		}
		const streams: SemanticReviewStreamDescriptorV1[] = [];
		let totalPages = 0;
		const secrets = input.secrets ?? [];
		for (const path of workerPaths) {
			if (!(await isWorkerPathAllowedRealpath(input.projectRoot, path, input.allowedPaths))) {
				return { ok: false, code: "presentation_unavailable" };
			}
			const rebuiltStream = await rebuildRedactedReviewStream({
				projectRoot: input.projectRoot,
				path,
				afterDigests: input.afterDigests,
				pathStatus: input.pathStatuses[path] ?? "",
				exec: input.exec,
				secrets,
			});
			if (rebuiltStream === undefined) return { ok: false, code: "stream_limit_exceeded" };
			const { source, text } = rebuiltStream;
			const streamBytes = Buffer.byteLength(text, "utf8");
			if (streamBytes > REVIEW_PAGE_SOURCE_MAX_BYTES) return { ok: false, code: "stream_limit_exceeded" };
			const pageCount = actualPresentationPageCount(text);
			if (pageCount === undefined) return { ok: false, code: "invalid_input" };
			totalPages += pageCount;
			if (!Number.isSafeInteger(totalPages) || totalPages > STRUCTURED_REVIEW_PRESENTATION_MAX_PAGES_V1) {
				return { ok: false, code: "invalid_input" };
			}
			streams.push({
				path,
				source,
				stream_bytes: streamBytes,
				stream_sha256: createHash("sha256").update(text, "utf8").digest("hex"),
				page_count: pageCount,
			});
		}
		const projectedBytes = estimateSemanticReviewRecordBytesV1({
			worker_paths: workerPaths,
			allowed_paths: input.allowedPaths,
			streams,
			relevance_projection: input.relevanceProjection,
		});
		if (projectedBytes === undefined) return { ok: false, code: "invalid_input" };
		return buildSemanticReviewEnvelopeV1({
			streams,
			projected_review_record_bytes: projectedBytes,
			relevance_projection_hash: input.relevanceProjectionHash,
		});
	} catch {
		return { ok: false, code: "presentation_unavailable" };
	}
}

export type StructuredReviewEnvelopeCompatibilityV1 = "current" | "legacy-page-count-v1";

export interface StructuredReviewPresentationPageV1 {
	path: string;
	source: SemanticReviewStreamDescriptorV1["source"];
	stream_sha256: string;
	/** Ordinal within this stream; global review finding ids use the array index instead. */
	page_number: number;
	page_count: number;
	start_byte: number;
	end_byte: number;
	total_bytes: number;
	page_content_sha256: string;
	content: string;
}

export interface StructuredReviewPresentationV1 {
	schema_version: 1;
	kind: "structured-review-presentation-v1";
	delegation_id: string;
	envelope_compatibility: StructuredReviewEnvelopeCompatibilityV1;
	semantic_envelope: Readonly<SemanticReviewEnvelopeV1>;
	streams: readonly SemanticReviewStreamDescriptorV1[];
	pages: readonly StructuredReviewPresentationPageV1[];
	presentation_hash: string;
}

export type CollectStructuredReviewPresentationErrorCodeV1 =
	| "INVALID_AUTHORITY"
	| "PRESENTATION_UNAVAILABLE"
	| "PRESENTATION_PAGE_LIMIT_EXCEEDED"
	| "SEMANTIC_ENVELOPE_MISMATCH";

export type CollectStructuredReviewPresentationResultV1 =
	| { ok: true; value: Readonly<StructuredReviewPresentationV1> }
	| { ok: false; code: CollectStructuredReviewPresentationErrorCodeV1 };

export interface CollectStructuredReviewPresentationInputV1 {
	projectRoot: string;
	authority: Readonly<ReviewAuthorityFacts>;
	exec: ExecFn;
	secrets?: readonly string[];
}

function byteSortedUnique(values: readonly string[]): boolean {
	return values.every((value, index) => typeof value === "string" && value.length > 0
		&& (index === 0 || Buffer.from(values[index - 1]!, "utf8").compare(Buffer.from(value, "utf8")) < 0));
}

function structuredPresentationEffectivePaths(
	projection: Readonly<ReviewRelevanceProjectionV2>,
	lineageCarriedPaths: readonly string[] = [],
): string[] {
	const carried = new Set(lineageCarriedPaths);
	return [...new Set(projection.entries
		.filter((entry) => entry.roles.includes("W") || entry.roles.includes("C") ||
			(carried.has(entry.path) && entry.roles.includes("D")))
		.map((entry) => entry.path))]
		.sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")));
}

function strictStructuredPresentationAuthority(authority: Readonly<ReviewAuthorityFacts>): boolean {
	const envelope = authority.review_envelope;
	const binding = authority.relevance_binding;
	const projection = authority.relevance_projection;
	const current = authority.current;
	if (!validateSemanticReviewEnvelopeV1(envelope) || !validateReviewRelevanceBindingV2(binding)
		|| !validateReviewRelevanceProjectionV2(projection) || current === undefined
		|| authority.delegation_id !== projection.delegation_id
		|| binding.projection_hash !== computeReviewRelevanceProjectionHashV2(projection)
		|| binding.projection_hash !== envelope.relevance_projection_hash
		|| authority.recorded_after_hash !== binding.projection_hash
		|| authority.current_diff_hash !== binding.projection_hash
		|| !Array.isArray(authority.drift_paths) || authority.drift_paths.length !== 0
		|| !Array.isArray(authority.worker_paths) || !byteSortedUnique(authority.worker_paths)
		|| authority.worker_paths.length !== envelope.path_count
		|| current.gitHead !== projection.git_head
		|| canonicalHash(current.changedPaths) !== canonicalHash(authority.worker_paths)) return false;
	const lineageCarriedPaths = authority.lineage_carried_paths ?? [];
	if (!byteSortedUnique(lineageCarriedPaths)) return false;
	const effectivePaths = structuredPresentationEffectivePaths(projection, lineageCarriedPaths);
	if (canonicalHash(effectivePaths) !== canonicalHash(authority.worker_paths)) return false;
	const effectiveSet = new Set(effectivePaths);
	for (const entry of projection.entries.filter((candidate) => effectiveSet.has(candidate.path))) {
		if (current.pathStatuses[entry.path] !== entry.status) return false;
		if (entry.full_identity.kind === "file") {
			if (current.pathDigests[entry.path] !== entry.full_identity.sha256) return false;
		} else if (Object.prototype.hasOwnProperty.call(current.pathDigests, entry.path)) return false;
	}
	return true;
}

function presentationIdentity(input: {
	delegation_id: string;
	envelope_compatibility: StructuredReviewEnvelopeCompatibilityV1;
	semantic_envelope: Readonly<SemanticReviewEnvelopeV1>;
	streams: readonly SemanticReviewStreamDescriptorV1[];
	pages: readonly StructuredReviewPresentationPageV1[];
}): string {
	return canonicalHash({
		schema_version: 1,
		kind: "structured-review-presentation-identity-v1",
		delegation_id: input.delegation_id,
		envelope_compatibility: input.envelope_compatibility,
		semantic_envelope_hash: canonicalHash(input.semantic_envelope),
		streams: input.streams,
		pages: input.pages.map(({ content: _content, ...binding }) => binding),
	});
}

function rebuildPresentationEnvelope(
	authority: Readonly<ReviewAuthorityFacts>,
	streams: readonly SemanticReviewStreamDescriptorV1[],
): SemanticReviewEnvelopeV1 | undefined {
	if (authority.relevance_projection === undefined || authority.relevance_binding === undefined) return undefined;
	const projectedBytes = estimateSemanticReviewRecordBytesV1({
		worker_paths: authority.worker_paths,
		allowed_paths: authority.allowed_paths,
		streams,
		relevance_projection: authority.relevance_projection,
	});
	if (projectedBytes === undefined) return undefined;
	const rebuilt = buildSemanticReviewEnvelopeV1({
		streams,
		projected_review_record_bytes: projectedBytes,
		relevance_projection_hash: authority.relevance_binding.projection_hash,
	});
	return rebuilt.ok ? rebuilt.value : undefined;
}

/**
 * Rebuild the complete current redacted stream set and slice it with the
 * exact production UTF-8 byte+line pager. No review/session state is read or
 * written; callers receive one immutable, hash-bound presentation snapshot.
 */
export async function collectStructuredReviewPresentationV1(
	input: CollectStructuredReviewPresentationInputV1,
): Promise<CollectStructuredReviewPresentationResultV1> {
	try {
		if (!strictStructuredPresentationAuthority(input.authority)) return { ok: false, code: "INVALID_AUTHORITY" };
		const envelope = input.authority.review_envelope!;
		const current = input.authority.current!;
		const secrets = input.secrets ?? [];
		const streams: SemanticReviewStreamDescriptorV1[] = [];
		const legacyStreams: SemanticReviewStreamDescriptorV1[] = [];
		const pages: StructuredReviewPresentationPageV1[] = [];
		for (const path of input.authority.worker_paths) {
			if (!(await isWorkerPathAllowedRealpath(input.projectRoot, path, input.authority.allowed_paths))) {
				return { ok: false, code: "PRESENTATION_UNAVAILABLE" };
			}
			const rebuilt = await rebuildRedactedReviewStream({
				projectRoot: input.projectRoot,
				path,
				afterDigests: input.authority.after.pathDigests,
				pathStatus: current.pathStatuses[path] ?? "",
				exec: input.exec,
				secrets,
			});
			if (rebuilt === undefined) return { ok: false, code: "PRESENTATION_UNAVAILABLE" };
			const streamBytes = Buffer.byteLength(rebuilt.text, "utf8");
			if (streamBytes > REVIEW_PAGE_SOURCE_MAX_BYTES) return { ok: false, code: "PRESENTATION_UNAVAILABLE" };
			const slices = iteratePresentationPages(rebuilt.text, REVIEW_PAGE_SOURCE_MAX_BYTES);
			if (slices === undefined) return { ok: false, code: "PRESENTATION_UNAVAILABLE" };
			if (pages.length + slices.length > STRUCTURED_REVIEW_PRESENTATION_MAX_PAGES_V1) {
				return { ok: false, code: "PRESENTATION_PAGE_LIMIT_EXCEEDED" };
			}
			const streamHash = createHash("sha256").update(rebuilt.text, "utf8").digest("hex");
			const descriptor: SemanticReviewStreamDescriptorV1 = {
				path,
				source: rebuilt.source,
				stream_bytes: streamBytes,
				stream_sha256: streamHash,
				page_count: slices.length,
			};
			streams.push(descriptor);
			const legacyCount = rebuilt.source === "compact" || rebuilt.source === "deleted"
				? (streamBytes === 0 ? 0 : 1)
				: legacyProjectedPageCount(rebuilt.text);
			if (legacyCount === undefined) return { ok: false, code: "PRESENTATION_UNAVAILABLE" };
			legacyStreams.push({ ...descriptor, page_count: legacyCount });
			for (const [index, slice] of slices.entries()) {
				pages.push({
					path,
					source: rebuilt.source,
					stream_sha256: streamHash,
					page_number: index + 1,
					page_count: slices.length,
					start_byte: slice.start_byte,
					end_byte: slice.end_byte,
					total_bytes: slice.total_bytes,
					page_content_sha256: createHash("sha256").update(slice.text, "utf8").digest("hex"),
					content: slice.text,
				});
			}
		}
		const currentEnvelope = rebuildPresentationEnvelope(input.authority, streams);
		const legacyEnvelope = rebuildPresentationEnvelope(input.authority, legacyStreams);
		const compatibility: StructuredReviewEnvelopeCompatibilityV1 | undefined = currentEnvelope !== undefined
			&& canonicalHash(currentEnvelope) === canonicalHash(envelope)
			? "current"
			: legacyEnvelope !== undefined && canonicalHash(legacyEnvelope) === canonicalHash(envelope)
				? "legacy-page-count-v1"
				: undefined;
		if (compatibility === undefined) return { ok: false, code: "SEMANTIC_ENVELOPE_MISMATCH" };
		const base = {
			delegation_id: input.authority.delegation_id,
			envelope_compatibility: compatibility,
			semantic_envelope: structuredClone(envelope),
			streams,
			pages,
		};
		const value: StructuredReviewPresentationV1 = {
			schema_version: 1,
			kind: "structured-review-presentation-v1",
			...base,
			presentation_hash: presentationIdentity(base),
		};
		return { ok: true, value: deepFreezeReviewPresentation(value) };
	} catch {
		return { ok: false, code: "PRESENTATION_UNAVAILABLE" };
	}
}

function deepFreezeReviewPresentation<T>(value: T): Readonly<T> {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreezeReviewPresentation(child);
		Object.freeze(value);
	}
	return value;
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
	page?: ReviewPatchPage;
	/** Ephemeral, recomputable prefix proof used only when this page is visible. */
	prefixReceiptSha256?: string;
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
		out.push({
			path: entry.path,
			source: entry.source,
			text: entry.text,
			truncated: entry.perPathTruncated,
			compact: entry.compact,
			...(entry.page === undefined ? {} : { page: entry.page }),
		});
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

export interface ReviewPresentationCoverage {
	fully_presented_paths: string[];
	presentation_remaining_paths: string[];
	presentation_complete: boolean;
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
 * paths and its actually rendered patch entries. Output lists preserve the
 * trusted worker-path order (legacy order for v1, UTF-8 byte order for v2).
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
	const displayedPaths = workerPaths.filter((path) => displayed.has(path));
	const remainingPaths = workerPaths.filter((path) => !displayed.has(path));
	return {
		displayed_paths: displayedPaths,
		remaining_paths: remainingPaths,
		coverage_complete: remainingPaths.length === 0,
	};
}

/**
 * Merge only complete, untruncated patch presentations for the same bound
 * hash.  Unlike mechanical displayed-path coverage, a truncated entry never
 * advances semantic-review readiness.
 */
export function mergeReviewPresentationCoverage(
	workerPaths: readonly string[],
	fullyPresentedPaths: readonly string[],
	prior: ReviewRecord | null,
	boundDiffHash: string,
): ReviewPresentationCoverage {
	const workerSet = new Set(workerPaths);
	const fullyPresented = new Set<string>();
	for (const path of fullyPresentedPaths) {
		if (workerSet.has(path)) fullyPresented.add(path);
	}
	if (prior && prior.bound_diff_hash === boundDiffHash) {
		const priorChecked = Array.isArray(prior.checked_paths)
			? prior.checked_paths.filter((path): path is string => typeof path === "string")
			: [];
		const priorCheckedSet = new Set(priorChecked);
		// New schema-2 provisional records must prove presentation through the
		// per-path cursor.  Bare legacy fully_presented_paths are deliberately
		// ignored here so an old/tampered provisional record can be safely
		// re-presented, but can never jump directly to semantic ACCEPT.
		const priorProgress = normalizedPresentationProgress(prior);
		const priorCandidates = prior.schema_version === 2 && prior.semantic_review === "required"
			? priorProgress.filter((item) => item.next_byte === item.total_bytes).map((item) => item.path)
			: Array.isArray(prior.fully_presented_paths)
				? prior.fully_presented_paths
				: Array.isArray(prior.patch)
					? prior.patch.filter(isCompleteReviewPresentationEntry).map((entry) => entry.path)
					: [];
		for (const path of priorCandidates) {
			if (typeof path === "string" && priorCheckedSet.has(path) && workerSet.has(path)) fullyPresented.add(path);
		}
	}
	const completePaths = workerPaths.filter((path) => fullyPresented.has(path));
	const remainingPaths = workerPaths.filter((path) => !fullyPresented.has(path));
	return {
		fully_presented_paths: completePaths,
		presentation_remaining_paths: remainingPaths,
		presentation_complete: remainingPaths.length === 0,
	};
}

function isPresentationProgressSource(value: unknown): value is ReviewPatchEntry["source"] {
	return value === "git-diff" || value === "file-content" || value === "deleted" || value === "compact" || value === "withheld";
}

/** Hostile-safe normalization used by merge/readiness paths. */
function normalizedPresentationProgress(record: ReviewRecord): ReviewPresentationProgress[] {
	if (!Array.isArray(record.presentation_progress) || record.presentation_progress.length > REVIEW_PRESENTATION_PROGRESS_MAX_ITEMS) return [];
	const checked = new Set(Array.isArray(record.checked_paths) ? record.checked_paths : []);
	const seen = new Set<string>();
	const normalized: ReviewPresentationProgress[] = [];
	for (const item of record.presentation_progress) {
		if (typeof item !== "object" || item === null || Array.isArray(item) ||
			typeof item.path !== "string" || !checked.has(item.path) || seen.has(item.path) ||
			!isPresentationProgressSource(item.source) || !/^[0-9a-f]{64}$/u.test(item.stream_sha256) ||
			!Number.isSafeInteger(item.next_byte) || item.next_byte < 0 ||
			!Number.isSafeInteger(item.total_bytes) || item.total_bytes < 0 ||
			item.total_bytes > REVIEW_PAGE_SOURCE_MAX_BYTES || item.next_byte > item.total_bytes ||
			((item.source === "deleted" || item.source === "compact" || item.source === "withheld") && item.next_byte !== item.total_bytes)) return [];
		const hasPageCount = Object.prototype.hasOwnProperty.call(item, "page_count");
		const hasReceipt = Object.prototype.hasOwnProperty.call(item, "receipt_sha256");
		if (hasPageCount !== hasReceipt || !Array.isArray(item.segments)) return [];
		if (hasPageCount) {
			if (!Number.isSafeInteger(item.page_count) || item.page_count! < 0 ||
				item.page_count! > item.next_byte ||
				typeof item.receipt_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(item.receipt_sha256) ||
				item.segments.length > 1 || (item.next_byte === 0) !== (item.page_count === 0) ||
				(item.next_byte === 0) !== (item.segments.length === 0)) return [];
			const segment = item.segments[0];
			if (segment !== undefined && (typeof segment !== "object" || segment === null || Array.isArray(segment) ||
				!Number.isSafeInteger(segment.start_byte) || segment.start_byte < 0 ||
				!Number.isSafeInteger(segment.end_byte) || segment.end_byte !== item.next_byte ||
				segment.end_byte <= segment.start_byte || segment.end_byte > item.total_bytes ||
				typeof segment.page_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(segment.page_sha256))) return [];
		} else {
			if (item.segments.length > REVIEW_PRESENTATION_SEGMENT_MAX_ITEMS) return [];
			let segmentCursor = 0;
			for (const segment of item.segments) {
				if (typeof segment !== "object" || segment === null || Array.isArray(segment) ||
					!Number.isSafeInteger(segment.start_byte) || segment.start_byte !== segmentCursor ||
					!Number.isSafeInteger(segment.end_byte) || segment.end_byte <= segment.start_byte || segment.end_byte > item.total_bytes ||
					typeof segment.page_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(segment.page_sha256)) return [];
				segmentCursor = segment.end_byte;
			}
			if (segmentCursor !== item.next_byte || (item.total_bytes === 0 && item.segments.length !== 0) ||
				(item.total_bytes > 0 && item.next_byte > 0 && item.segments.length === 0)) return [];
		}
		seen.add(item.path);
		normalized.push({ ...item, segments: item.segments.map((segment) => ({ ...segment })) });
	}
	return normalized.sort((left, right) => Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")));
}

function priorPresentationProgress(
	workerPaths: readonly string[],
	prior: ReviewRecord | null,
	boundDiffHash: string,
): ReviewPresentationProgress[] {
	if (prior === null || prior.bound_diff_hash !== boundDiffHash) return [];
	const workerSet = new Set(workerPaths);
	const progress = normalizedPresentationProgress(prior).filter((item) => workerSet.has(item.path));
	return workerPaths.flatMap((path) => {
		const item = progress.find((candidate) => candidate.path === path);
		return item === undefined ? [] : [item];
	}).sort((left, right) => Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")));
}

function mergeReviewPresentationProgress(
	workerPaths: readonly string[],
	prior: readonly ReviewPresentationProgress[],
	fullyVisibleEntries: readonly ReviewPatchEntry[],
	prefixReceipts: ReadonlyMap<string, string>,
): ReviewPresentationProgress[] {
	const byPath = new Map(prior.map((item) => [item.path, { ...item }]));
	for (const entry of fullyVisibleEntries) {
		const page = entry.page;
		if (page === undefined) {
			if (!isCompleteReviewPresentationEntry(entry)) continue;
			const bytes = Buffer.byteLength(entry.text, "utf8");
			if (bytes > REVIEW_PAGE_SOURCE_MAX_BYTES) continue;
			const segment = bytes === 0 ? undefined : {
				start_byte: 0,
				end_byte: bytes,
				page_sha256: createHash("sha256").update(entry.text, "utf8").digest("hex"),
			};
			const streamHash = createHash("sha256").update(entry.text, "utf8").digest("hex");
			byPath.set(entry.path, {
				path: entry.path,
				source: entry.source,
				stream_sha256: streamHash,
				next_byte: bytes,
				total_bytes: bytes,
				segments: segment === undefined ? [] : [segment],
				page_count: segment === undefined ? 0 : 1,
				receipt_sha256: streamHash,
			});
			continue;
		}
		if (entry.source !== "git-diff" && entry.source !== "file-content" ||
			Buffer.byteLength(entry.text, "utf8") !== page.end_byte - page.start_byte ||
			page.total_bytes > REVIEW_PAGE_SOURCE_MAX_BYTES) continue;
		const existing = byPath.get(entry.path);
		const sameStream = existing !== undefined && existing.source === entry.source &&
			existing.stream_sha256 === page.stream_sha256 && existing.total_bytes === page.total_bytes;
		const expectedStart = sameStream ? existing.next_byte : 0;
		if (page.start_byte !== expectedStart || page.end_byte <= page.start_byte || page.end_byte > page.total_bytes) continue;
		const priorPageCount = sameStream
			? existing.page_count ?? existing.segments.length
			: 0;
		if (!Number.isSafeInteger(priorPageCount) || priorPageCount >= Number.MAX_SAFE_INTEGER) continue;
		const prefixReceipt = prefixReceipts.get(entry.path);
		if (prefixReceipt === undefined || !/^[0-9a-f]{64}$/u.test(prefixReceipt)) continue;
		const segment = {
			start_byte: page.start_byte,
			end_byte: page.end_byte,
			page_sha256: createHash("sha256").update(entry.text, "utf8").digest("hex"),
		};
		byPath.set(entry.path, {
			path: entry.path,
			source: entry.source,
			stream_sha256: page.stream_sha256,
			next_byte: page.end_byte,
			total_bytes: page.total_bytes,
			segments: [segment],
			page_count: priorPageCount + 1,
			receipt_sha256: prefixReceipt,
		});
	}
	return workerPaths.flatMap((path) => {
		const item = byPath.get(path);
		return item === undefined ? [] : [item];
	}).sort((left, right) => Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")));
}

interface ReviewPresentationValidationInput {
	projectRoot: string;
	record: ReviewRecord;
	authority: ReviewAuthorityFacts;
	exec: ExecFn;
	secrets?: readonly string[];
}

/**
 * Rebuild the exact pre-binary-compaction v1 envelope for a generation that
 * entered PENDING_REVIEW before this runtime learned binary compact packets.
 * This is validation-only compatibility: current presentation still has to
 * validate byte-for-byte from fresh authority, and the immutable legacy
 * envelope must also reproduce exactly.
 */
async function rebuildLegacySemanticReviewEnvelopeV1(input: {
	projectRoot: string;
	paths: readonly string[];
	authority: ReviewAuthorityFacts;
	current: GitFacts;
	exec: ExecFn;
	secrets: readonly string[];
}): Promise<SemanticReviewEnvelopeV1 | undefined> {
	if (input.authority.relevance_projection === undefined || input.authority.relevance_binding === undefined) return undefined;
	const streams: SemanticReviewStreamDescriptorV1[] = [];
	for (const path of input.paths) {
		let source: SemanticReviewStreamDescriptorV1["source"];
		let text: string;
		const compact = await compactFactsFor(
			input.projectRoot,
			path,
			input.secrets,
			input.authority.after.pathDigests,
			input.current.pathStatuses[path] ?? "",
			"legacy-text-only",
		);
		if (compact !== null) {
			source = "compact";
			text = renderCompactFacts(compact);
		} else {
			const stream = await pageablePatchStreamFor(input.projectRoot, path, input.exec, input.secrets);
			if (stream === null) {
				const deleted = !(path in input.authority.after.pathDigests) &&
					(input.current.pathStatuses[path] ?? "").includes("D");
				if (!deleted) return undefined;
				source = "deleted";
				text = "(deleted or unreadable)";
			} else {
				source = stream.source;
				text = stream.text;
			}
		}
		const streamBytes = Buffer.byteLength(text, "utf8");
		if (streamBytes > REVIEW_PAGE_SOURCE_MAX_BYTES) return undefined;
		const pageCount = source === "compact" || source === "deleted"
			? (streamBytes === 0 ? 0 : 1)
			: legacyProjectedPageCount(text);
		if (pageCount === undefined) return undefined;
		streams.push({
			path,
			source,
			stream_bytes: streamBytes,
			stream_sha256: createHash("sha256").update(text, "utf8").digest("hex"),
			page_count: pageCount,
		});
	}
	const projectedBytes = estimateSemanticReviewRecordBytesV1({
		worker_paths: input.paths,
		allowed_paths: input.authority.allowed_paths,
		streams,
		relevance_projection: input.authority.relevance_projection,
	});
	if (projectedBytes === undefined) return undefined;
	const rebuilt = buildSemanticReviewEnvelopeV1({
		streams,
		projected_review_record_bytes: projectedBytes,
		relevance_projection_hash: input.authority.relevance_binding.projection_hash,
	});
	return rebuilt.ok ? rebuilt.value : undefined;
}

/**
 * Rebuild every completed presentation stream from the current bound
 * authority before semantic ACCEPT.  review.json is provisional and cannot
 * self-attest its stream hash, byte total, or final-page slice.
 */
export async function validateReviewPresentationAgainstAuthority(
	input: ReviewPresentationValidationInput,
): Promise<boolean> {
	try {
		const checked = Array.isArray(input.record.checked_paths) ? input.record.checked_paths : [];
		if (checked.length === 0) return true;
		const progress = normalizedPresentationProgress(input.record);
		if (progress.length === 0 || progress.length > checked.length) return false;
		const completed = progress.filter((item) => item.next_byte === item.total_bytes);
		if (completed.length !== checked.length || !checked.every((path, index) => completed[index]?.path === path)) return false;
		const current = input.authority.current ?? await collectGitFacts(input.projectRoot, input.exec);
		const secrets = input.secrets ?? [];
		let validatedBytes = 0;
		const actualByPath = new Map<string, { source: ReviewPatchEntry["source"]; text: string; hash: string; total: number }>();
		const envelopeStreams: SemanticReviewStreamDescriptorV1[] = [];
		for (const item of progress) {
			let source: ReviewPatchEntry["source"];
			let text: string;
			if (item.source === "git-diff" || item.source === "file-content") {
				const stream = await pageablePatchStreamFor(input.projectRoot, item.path, input.exec, secrets);
				if (stream === null) return false;
				source = stream.source;
				text = stream.text;
			} else if (item.source === "compact") {
				const facts = await compactFactsFor(
					input.projectRoot,
					item.path,
					secrets,
					input.authority.after.pathDigests,
					current.pathStatuses[item.path] ?? "",
				);
				if (facts === null) return false;
				source = "compact";
				text = renderCompactFacts(facts);
			} else if (item.source === "deleted") {
				if (await contentDigest(input.projectRoot, item.path) !== undefined) return false;
				source = "deleted";
				text = "(deleted or unreadable)";
			} else {
				// A withheld path necessarily makes the scope verdict FAIL and can
				// never be part of a semantic PASS authority.
				return false;
			}
			const total = Buffer.byteLength(text, "utf8");
			validatedBytes += total;
			if (validatedBytes > REVIEW_PRESENTATION_VALIDATION_MAX_BYTES || source !== item.source ||
				total !== item.total_bytes || createHash("sha256").update(text, "utf8").digest("hex") !== item.stream_sha256) return false;
			actualByPath.set(item.path, { source, text, hash: item.stream_sha256, total });
			const actualBytes = Buffer.from(text, "utf8");
			if (item.receipt_sha256 !== undefined &&
				createHash("sha256").update(actualBytes.subarray(0, item.next_byte)).digest("hex") !== item.receipt_sha256) return false;
			for (const segment of item.segments) {
				if (createHash("sha256").update(actualBytes.subarray(segment.start_byte, segment.end_byte)).digest("hex") !== segment.page_sha256) return false;
			}
			const pageCount = actualPresentationPageCount(text, REVIEW_PAGE_SOURCE_MAX_BYTES);
			if (pageCount === undefined) return false;
			envelopeStreams.push({
				path: item.path,
				source,
				stream_bytes: total,
				stream_sha256: item.stream_sha256,
				page_count: pageCount,
			});
		}
		for (const entry of input.record.patch) {
			const actual = actualByPath.get(entry.path);
			if (actual === undefined || actual.source !== entry.source) continue;
			if (entry.page !== undefined) {
				const bytes = Buffer.from(actual.text, "utf8");
				if (entry.page.stream_sha256 !== actual.hash || entry.page.total_bytes !== actual.total ||
					entry.page.end_byte > bytes.length ||
					bytes.subarray(entry.page.start_byte, entry.page.end_byte).toString("utf8") !== entry.text) return false;
			} else if (isCompleteReviewPresentationEntry(entry) && entry.text !== actual.text) {
				return false;
			}
		}
		const authorityEnvelope = input.authority.review_envelope;
		const recordEnvelope = input.record.review_envelope;
		if ((authorityEnvelope === undefined) !== (recordEnvelope === undefined)) return false;
		if (authorityEnvelope !== undefined) {
			if (input.authority.relevance_projection === undefined || input.authority.relevance_binding === undefined ||
				canonicalHash(authorityEnvelope) !== canonicalHash(recordEnvelope)) return false;
			const projectedBytes = estimateSemanticReviewRecordBytesV1({
				worker_paths: checked,
				allowed_paths: input.authority.allowed_paths,
				streams: envelopeStreams,
				relevance_projection: input.authority.relevance_projection,
			});
			if (projectedBytes === undefined) return false;
			const rebuilt = buildSemanticReviewEnvelopeV1({
				streams: envelopeStreams,
				projected_review_record_bytes: projectedBytes,
				relevance_projection_hash: input.authority.relevance_binding.projection_hash,
			});
			if (!rebuilt.ok) return false;
			if (canonicalHash(rebuilt.value) !== canonicalHash(authorityEnvelope)) {
				const legacy = await rebuildLegacySemanticReviewEnvelopeV1({
					projectRoot: input.projectRoot,
					paths: checked,
					authority: input.authority,
					current,
					exec: input.exec,
					secrets,
				});
				if (legacy === undefined || canonicalHash(legacy) !== canonicalHash(authorityEnvelope)) return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Review one delegation against the real git state. Writes review.json
 * (atomic) and returns the verdict + bounded redacted patch. Never touches
 * the delegation state entry — the runtime does that.
 */
async function reviewDelegationInner(
	input: ReviewInput,
	override?: Pick<ReviewFromAuthorityInput, "authority" | "priorReview" | "reviewPath">,
): Promise<ReviewResult> {
	const projectRoot = input.projectRoot;
	const delegationId = typeof input.delegationId === "string" ? input.delegationId.trim() : "";
	const now = input.now ?? new Date().toISOString();
	const maxLines = boundInt(input.maxLines, DEFAULT_REVIEW_MAX_LINES, 1, DEFAULT_REVIEW_MAX_LINES);
	const maxBytes = boundInt(input.maxBytes, DEFAULT_REVIEW_MAX_BYTES, 1, DEFAULT_REVIEW_MAX_BYTES);
	const secrets = input.secrets ?? [];

	if (!isValidDelegationId(delegationId)) {
		return reviewFailure("invalid_delegation");
	}
	let authority: ReviewAuthorityFacts;
	let priorReview: ReviewRecord | null;
	let reviewPath: string;
	if (override === undefined) {
		const ledger = await readDelegationLedger(projectRoot, delegationId);
		if (!ledger) return reviewFailure("delegation_not_found");
		if (!ledger.after) return reviewFailure("delegation_incomplete");
		authority = {
			delegation_id: delegationId,
			allowed_paths: [...ledger.before.contract.allowed_paths],
			worker_paths: [...ledger.after.changed_since_before],
			recorded_after_hash: ledger.after.diff_hash,
			after: {
				gitHead: ledger.after.git_head,
				gitDirty: ledger.after.git_dirty,
				changedPaths: [...ledger.after.changed_paths],
				pathStatuses: { ...ledger.after.path_statuses },
				pathDigests: { ...ledger.after.path_digests },
			},
			reported_paths: [...ledger.after.reported_paths],
		};
		// Slice B2: read the PRIOR persisted review record BEFORE this call
		// overwrites it — same-hash segments merge displayed coverage.
		priorReview = await readReviewRecord(projectRoot, delegationId);
		reviewPath = reviewRecordRelPath(delegationId);
	} else {
		authority = override.authority;
		priorReview = override.priorReview;
		reviewPath = override.reviewPath;
	}
	if (authority.delegation_id !== delegationId) return reviewFailure("delegation_incomplete");

	// Worker paths are the authority-specific review scope: v1 supplies its
	// legacy changed-since-before order, while v2 supplies the byte-canonical
	// ChangeSet-attributed worker delta after strict generation validation.
	const workerPaths = [...authority.worker_paths];
	const allowedPaths = [...authority.allowed_paths];

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
				reason: "outside the parent-approved scope (realpath/symlink check)",
			});
		}
	}
	const violationSet = new Set(violations.map((v) => v.path));

	// Real git state NOW — the review inspects the actual tree, never the
	// ledger's claims. Fail closed: an unavailable `git status` (thrown exec
	// error or non-zero exit) returns a structured failure and writes NO
	// review record — a fabricated clean tree could never be reviewed as
	// PASS. New-v2 receives a pre-collected W/D/S relevance binding; legacy
	// v1 and historical v2 retain collectGitFacts over the complete diff.
	let current: GitFacts;
	let boundDiffHash: string;
	const relevanceSupplied = authority.relevance_binding !== undefined || authority.relevance_projection !== undefined ||
		authority.current !== undefined || authority.current_diff_hash !== undefined || authority.drift_paths !== undefined;
	if (relevanceSupplied) {
		if (authority.relevance_binding === undefined || authority.relevance_projection === undefined || authority.current === undefined ||
			authority.current_diff_hash === undefined || authority.drift_paths === undefined ||
			authority.relevance_binding.diff_identity_kind !== REVIEW_RELEVANCE_KIND_V2 ||
			authority.relevance_projection.diff_identity_kind !== REVIEW_RELEVANCE_KIND_V2 ||
			authority.relevance_binding.projection_hash !== authority.current_diff_hash) return reviewFailure("git_state_unavailable");
		current = {
			gitHead: authority.current.gitHead,
			gitDirty: authority.current.gitDirty,
			changedPaths: [...authority.current.changedPaths],
			pathStatuses: { ...authority.current.pathStatuses },
			pathDigests: { ...authority.current.pathDigests },
		};
		boundDiffHash = authority.current_diff_hash;
	} else {
		try {
			current = await collectGitFacts(projectRoot, input.exec);
		} catch {
			return reviewFailure("git_state_unavailable");
		}
		boundDiffHash = computeDiffHash(current.changedPaths, current.pathDigests, current.pathStatuses);
	}
	const recordedAfterHash = authority.recorded_after_hash;
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
			return reviewFailure("invalid_include_path");
		}
		if (!workerPaths.includes(normalized)) {
			return reviewFailure("include_path_not_in_diff");
		}
		includeSet.add(normalized);
	}
	const patchPaths = includeSet.size > 0 ? [...includeSet] : workerPaths;

	// Drift: paths whose state differs from the recorded-after snapshot
	// (new paths, same-path later edits via digest/status comparison,
	// deletions) — recorded as warnings; the generation-specific authority
	// hash covers them.
	// Untouched preexisting dirty paths (already dirty before the
	// delegation and still identical) are NOT drift.
	const afterFacts: GitFacts = {
		gitHead: authority.after.gitHead,
		gitDirty: authority.after.gitDirty,
		changedPaths: [...authority.after.changedPaths],
		pathStatuses: { ...authority.after.pathStatuses },
		pathDigests: { ...authority.after.pathDigests },
	};
	const driftPaths = relevanceSupplied ? [...authority.drift_paths!] : changedSinceBefore(afterFacts, current);

	const notes: string[] = [];
	if (mismatch) {
		notes.push(`current authority binding differs from the worker's recorded binding (${boundDiffHash.slice(0, 12)} vs ${recordedAfterHash.slice(0, 12)}) — later relevant new-v2 drift, or any legacy full-diff change, turns the delegation STALE`);
	}
	if (driftPaths.length > 0) {
		notes.push(boundedPathList(`${driftPaths.length} path(s) changed after the worker finished: `, driftPaths, 10));
	}
	// Worker report vs actual diff: the ledger records the safe paths the
	// worker listed in its bounded ## Files Changed section. A missing
	// section or a mismatch with the actual diff is a warning — the verdict
	// stays driven by the REAL diff, never the report.
	const reportedPaths = [...authority.reported_paths];
	if (reportedPaths.length === 0) {
		notes.push("worker report has no parseable ## Files Changed section — reported/actual path comparison unavailable");
	} else {
		const reportedSet = new Set(reportedPaths);
		const actualSet = new Set(workerPaths);
		const onlyReported = reportedPaths.filter((p) => !actualSet.has(p));
		const onlyActual = workerPaths.filter((p) => !reportedSet.has(p));
		if (onlyReported.length > 0) {
			notes.push(boundedPathList(`worker report lists ${onlyReported.length} path(s) not present in the actual diff: `, onlyReported, 10));
		}
		if (onlyActual.length > 0) {
			notes.push(boundedPathList(`worker report misses ${onlyActual.length} actual diff path(s): `, onlyActual, 10));
		}
	}

	// Patch: include_paths narrows the OUTPUT only (entries were validated
	// above against the worker diff). Per-path reads are bounded; the GLOBAL
	// line AND byte caps are enforced over the whole rendered patch content
	// (never independently per path). Scope checks cover every W path; the
	// bound hash covers new-v2 W/D/S relevance or the complete legacy diff.
	// Fail closed: a violating path is withheld BEFORE any content open/
	// read/digest/display — its entry is the deterministic bounded marker,
	// never a git diff, file read, digest or rendered content.
	const sectionCaps = reviewSectionCaps(maxBytes, maxLines);
	const priorProgress = priorPresentationProgress(workerPaths, priorReview, boundDiffHash);
	const priorProgressByPath = new Map(priorProgress.map((item) => [item.path, item]));
	// Paging is deliberately single-path: the persisted cursor is contiguous
	// and repeating the same include_path has one deterministic meaning. A
	// multi-path call keeps the existing bounded segment behavior and directs
	// the reviewer to select one remaining path on the next call.
	const pageMaxBytes = Math.max(0, sectionCaps.patchBytes - REVIEW_PAGE_ENVELOPE_RESERVE_BYTES);
	const pageMaxLines = Math.max(0, sectionCaps.patchLines - REVIEW_PAGE_ENVELOPE_RESERVE_LINES);
	const pageOnePath = patchPaths.length === 1 && pageMaxBytes > 0 && pageMaxLines > 0;
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
		const entry = await patchEntryFor(
			projectRoot,
			path,
			input.exec,
			secrets,
			Math.min(maxBytes, REVIEW_PATCH_MAX_BYTES),
			authority.after.pathDigests,
			current.pathStatuses[path] ?? "",
			pageOnePath ? {
				prior: priorProgressByPath.get(path),
				maxBytes: pageMaxBytes,
				maxLines: pageMaxLines,
			} : undefined,
		);
		rawEntries.push(entry);
	}
	const bounded = boundPatchEntries(
		rawEntries,
		Math.min(maxLines, REVIEW_PATCH_MAX_LINES),
		Math.min(maxBytes, REVIEW_PATCH_MAX_BYTES),
	);
	const candidatePatch = bounded.entries;
	const verdict: ReviewVerdict = violations.length > 0 ? "FAIL" : "PASS";
	const semanticClassification = classifySemanticReviewRisk(workerPaths);
	const priorCoverage = mergeReviewCoverage(workerPaths, [], priorReview, boundDiffHash);
	const priorPresentationCoverage = mergeReviewPresentationCoverage(workerPaths, [], priorReview, boundDiffHash);
	const provisionalRecord: ReviewRecord = {
		schema_version: relevanceSupplied ? 2 : REVIEW_SCHEMA_VERSION,
		delegation_id: delegationId,
		reviewed_at: now,
		verdict,
		bound_diff_hash: boundDiffHash,
		recorded_after_hash: recordedAfterHash,
		mismatch,
		drift_paths: [...driftPaths],
		violations,
		allowed_paths: [...allowedPaths],
		checked_paths: workerPaths,
		include_paths: patchPaths,
		patch: candidatePatch,
		patch_truncated: bounded.truncated || patchPaths.length > candidatePatch.length,
		patch_paths: [],
		notes,
		displayed_paths: priorCoverage.displayed_paths,
		remaining_paths: priorCoverage.remaining_paths,
		coverage_complete: priorCoverage.coverage_complete,
		fully_presented_paths: priorPresentationCoverage.fully_presented_paths,
		presentation_remaining_paths: priorPresentationCoverage.presentation_remaining_paths,
		presentation_complete: priorPresentationCoverage.presentation_complete,
		...(priorProgress.length === 0 ? {} : { presentation_progress: priorProgress }),
		semantic_review: semanticClassification.required ? "required" : "not_required",
		review_path: reviewPath,
		...(relevanceSupplied ? {
			diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
			relevance_binding: structuredClone(authority.relevance_binding!),
			relevance_projection: structuredClone(authority.relevance_projection!),
			...(authority.review_envelope === undefined ? {} : { review_envelope: structuredClone(authority.review_envelope) }),
		} : {}),
	};

	// Presentation is part of review authority: determine which candidate
	// patch entries fit the exact whole-result caps BEFORE coverage/state is
	// advanced or review.json is written. The generic tool_result envelope
	// therefore receives already-bounded content and remains a no-op.
	const provisionalPresentation = renderReviewPresentationInner(provisionalRecord, { maxBytes, maxLines });
	const visibleSet = new Set(provisionalPresentation.visiblePatchPaths);
	const fullyVisibleSet = new Set(provisionalPresentation.fullyVisiblePatchPaths);
	const patch = candidatePatch
		.filter((entry) => visibleSet.has(entry.path))
		.map((entry) => fullyVisibleSet.has(entry.path)
			? entry
			: { path: entry.path, source: entry.source, text: entry.text, truncated: true, ...(entry.compact === undefined ? {} : { compact: entry.compact }) });
	const patchTruncated = bounded.truncated || patchPaths.length > patch.length;
	const patchPathsStat: ReviewPatchPathStat[] = patchPaths.map((path) => {
		const entry = patch.find((candidate) => candidate.path === path);
		return {
			path,
			source: entry?.source ?? "omitted",
			bytes: entry ? Buffer.byteLength(entry.text, "utf8") : 0,
			truncated: entry ? entry.truncated : true,
		};
	});
	// Slice B2 coverage: only patch entries present in the final bounded
	// content advance this call; prior same-hash durable coverage still
	// merges normally (legacy records infer it from their persisted patch).
	const coverage = mergeReviewCoverage(workerPaths, patch.map((entry) => entry.path), priorReview, boundDiffHash);
	const prefixReceipts = new Map(rawEntries.flatMap((entry) =>
		entry.prefixReceiptSha256 === undefined ? [] : [[entry.path, entry.prefixReceiptSha256] as const]));
	const presentationProgress = mergeReviewPresentationProgress(
		workerPaths,
		priorProgress,
		patch.filter((entry) => fullyVisibleSet.has(entry.path)),
		prefixReceipts,
	);
	const completedPagedPaths = presentationProgress
		.filter((item) => item.next_byte === item.total_bytes)
		.map((item) => item.path);
	const presentationCoverage = mergeReviewPresentationCoverage(
		workerPaths,
		completedPagedPaths,
		null,
		boundDiffHash,
	);
	if (patchPaths.length === 1) {
		const selectedPath = patchPaths[0]!;
		const selectedEntry = patch.find((entry) => entry.path === selectedPath);
		const selectedRawEntry = rawEntries.find((entry) => entry.path === selectedPath);
		const priorItem = priorProgressByPath.get(selectedPath);
		const currentItem = presentationProgress.find((item) => item.path === selectedPath);
		const priorCursor = priorItem !== undefined && currentItem !== undefined &&
			priorItem.source === currentItem.source && priorItem.stream_sha256 === currentItem.stream_sha256 &&
			priorItem.total_bytes === currentItem.total_bytes ? priorItem.next_byte : 0;
		const currentCursor = currentItem?.next_byte ?? 0;
		if (presentationCoverage.presentation_remaining_paths.includes(selectedPath) &&
			selectedRawEntry !== undefined && (selectedRawEntry.source === "git-diff" || selectedRawEntry.source === "file-content") &&
			(selectedEntry === undefined || selectedEntry.truncated || selectedRawEntry.perPathTruncated) && currentCursor <= priorCursor) {
			return reviewFailure("presentation_page_unavailable");
		}
	}
	const record: ReviewRecord = {
		...provisionalRecord,
		patch,
		patch_truncated: patchTruncated,
		patch_paths: patchPathsStat,
		displayed_paths: coverage.displayed_paths,
		remaining_paths: coverage.remaining_paths,
		coverage_complete: coverage.coverage_complete,
		fully_presented_paths: presentationCoverage.fully_presented_paths,
		presentation_remaining_paths: presentationCoverage.presentation_remaining_paths,
		presentation_complete: presentationCoverage.presentation_complete,
		...(presentationProgress.length === 0 ? {} : { presentation_progress: presentationProgress }),
	};
	const presentation = renderReviewPresentationInner(record, { maxBytes, maxLines });
	if (
		presentation.visiblePatchPaths.length !== patch.length
		|| presentation.visiblePatchPaths.some((path, index) => path !== patch[index]?.path)
		|| patch.some((entry) => entry.page !== undefined && !presentation.fullyVisiblePatchPaths.includes(entry.path))
	) {
		return reviewFailure("runtime_failure");
	}

	const reviewPayload = compileReviewRecordPayload(record);
	if (reviewPayload === undefined) return reviewFailure("review_persist_failed");
	if (override === undefined) {
		try {
			await writeTextAtomic(delegationDirFor(projectRoot, delegationId), "review.json", reviewPayload);
		} catch {
			return reviewFailure("review_persist_failed");
		}
	}

	return { ok: true, record, lines: presentation.lines };
}

/** Public fail-closed boundary: hostile values/errors never expose stacks or arguments. */
export async function reviewDelegation(input: ReviewInput): Promise<ReviewResult> {
	try {
		return await reviewDelegationInner(input);
	} catch {
		return reviewFailure("runtime_failure");
	}
}

/**
 * Compute a review from caller-supplied strict authority facts without
 * writing an artifact.  Persistence and lifecycle publication remain the
 * responsibility of the authority-specific adapter.
 */
export async function reviewDelegationFromAuthority(input: ReviewFromAuthorityInput): Promise<ReviewResult> {
	try {
		return await reviewDelegationInner(input, {
			authority: input.authority,
			priorReview: input.priorReview,
			reviewPath: input.reviewPath,
		});
	} catch {
		return reviewFailure("runtime_failure");
	}
}

/** Shared current-tree binding used for immutable finalized-review replay. */
export async function collectReviewBoundDiffHash(projectRoot: string, exec: ExecFn): Promise<string | null> {
	try {
		const current = await collectGitFacts(projectRoot, exec);
		return computeDiffHash(current.changedPaths, current.pathDigests, current.pathStatuses);
	} catch {
		return null;
	}
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
		const displayedPaths = checked.filter((path) => displayedSet.has(path));
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
		? record.displayed_paths.filter((p): p is string => typeof p === "string")
		: [];
	const remainingPaths = hasRemaining
		? record.remaining_paths.filter((p): p is string => typeof p === "string")
		: [];
	return {
		displayed_paths: displayedPaths,
		remaining_paths: remainingPaths,
		coverage_complete: hasDisplayed && hasRemaining && displayedPaths.length > 0 && remainingPaths.length === 0,
	};
}

/** Normalize additive untruncated-presentation facts; historical records
 * fail closed to the untruncated entries physically present in their patch. */
export function normalizeReviewPresentationCoverage(record: ReviewRecord): ReviewPresentationCoverage {
	const checked = Array.isArray(record.checked_paths)
		? record.checked_paths.filter((path): path is string => typeof path === "string")
		: [];
	const checkedSet = new Set(checked);
	const progress = normalizedPresentationProgress(record);
	const candidates = record.schema_version === 2 && record.semantic_review === "required"
		? progress.filter((item) => item.next_byte === item.total_bytes).map((item) => item.path)
		: Array.isArray(record.fully_presented_paths)
			? record.fully_presented_paths
			: Array.isArray(record.patch)
				? record.patch.filter(isCompleteReviewPresentationEntry).map((entry) => entry.path)
				: [];
	const completeSet = new Set(candidates.filter((path): path is string => typeof path === "string" && checkedSet.has(path)));
	const fullyPresentedPaths = checked.filter((path) => completeSet.has(path));
	const remainingPaths = checked.filter((path) => !completeSet.has(path));
	return {
		fully_presented_paths: fullyPresentedPaths,
		presentation_remaining_paths: remainingPaths,
		presentation_complete: remainingPaths.length === 0,
	};
}

/**
 * Strict packet readiness used before semantic ACCEPT.  A scope PASS alone
 * is insufficient; the packet must bind the recorded state, have no drift,
 * and have presented every worker path without truncation across same-hash
 * segments.  This remains presentation evidence, never Gate authority.
 */
export function isScopeIntegrityPacketComplete(record: ReviewRecord): boolean {
	const coverage = normalizeReviewCoverage(record);
	const presentation = normalizeReviewPresentationCoverage(record);
	const requiresStrictProgress = record.schema_version === 2 && record.semantic_review === "required" &&
		Array.isArray(record.checked_paths) && record.checked_paths.length > 0;
	const completedProgress = normalizedPresentationProgress(record)
		.filter((item) => item.next_byte === item.total_bytes)
		.map((item) => item.path);
	const strictProgressMatches = !requiresStrictProgress || (
		Array.isArray(record.presentation_progress) &&
		Array.isArray(record.fully_presented_paths) &&
		new Set(completedProgress).size === completedProgress.length &&
		completedProgress.length === record.fully_presented_paths.length &&
		completedProgress.every((path, index) => path === record.fully_presented_paths![index])
	);
	return record.verdict === "PASS"
		&& record.mismatch === false
		&& Array.isArray(record.violations) && record.violations.length === 0
		&& Array.isArray(record.drift_paths) && record.drift_paths.length === 0
		&& coverage.coverage_complete
		&& coverage.remaining_paths.length === 0
		&& presentation.presentation_complete
		&& presentation.presentation_remaining_paths.length === 0
		&& strictProgressMatches;
}

/**
 * Final review-authority predicate shared by persistence, reconciliation and
 * Gate projection. Historical mechanical REVIEWED records remain readable,
 * but a non-zero delta is authoritative only when a current schema-2 packet
 * carries the exact hash-bound Sol acceptance. An actually empty delta needs
 * no semantic decision and remains compatible with historical records.
 */
export function isStrictSemanticAcceptedOrZeroDelta(record: ReviewRecord): boolean {
	try {
		if (!isScopeIntegrityPacketComplete(record)) return false;
		const checkedPaths = Array.isArray(record.checked_paths) ? record.checked_paths : [];
		if (checkedPaths.length === 0) {
			return record.semantic_acceptance === undefined
				&& (record.semantic_review === undefined || record.semantic_review === "not_required");
		}
		if (record.schema_version !== 2 || record.semantic_review !== "accepted") return false;
		const acceptance = exactOwnDataRecord(record.semantic_acceptance, [
			"decision", "expected_bound_diff_hash", "reviewer", "accepted_at",
		]);
		if (acceptance === undefined) return false;
		const reviewer = exactOwnDataRecord(acceptance.reviewer, ["provider", "model"]);
		return reviewer !== undefined
			&& acceptance.decision === "ACCEPT"
			&& acceptance.expected_bound_diff_hash === record.bound_diff_hash
			&& acceptance.accepted_at === record.reviewed_at
			&& (reviewer.provider === "openai" || reviewer.provider === "openai-codex")
			&& reviewer.model === "gpt-5.6-sol";
	} catch {
		return false;
	}
}

function exactOwnDataRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Object.keys(descriptors);
		if (keys.length !== fields.length || fields.some((field) => !Object.prototype.hasOwnProperty.call(descriptors, field))) return undefined;
		const result: Record<string, unknown> = {};
		for (const field of fields) {
			const descriptor = descriptors[field];
			if (descriptor === undefined || !("value" in descriptor)) return undefined;
			result[field] = descriptor.value;
		}
		return result;
	} catch {
		return undefined;
	}
}

interface ReviewSectionFacts {
	original: number;
	shown: number;
	omitted: number;
	truncated: boolean;
	/** Complete patch-entry paths that are actually present in final content. */
	visiblePaths?: string[];
	/** Paths whose title and complete current entry body both fit. */
	fullyVisiblePaths?: string[];
}

function selectedPatchCount(record: ReviewRecord): number {
	// Empty include_paths is the legacy/domain spelling for "all checked
	// paths"; only a non-empty list represents an explicit narrowed page.
	if (Array.isArray(record.include_paths) && record.include_paths.length > 0) return record.include_paths.length;
	return Array.isArray(record.checked_paths) ? record.checked_paths.length : 0;
}

function reviewPathOf(record: ReviewRecord): string {
	const raw = typeof record.review_path === "string" && record.review_path
		? record.review_path
		: reviewRecordRelPath(record.delegation_id);
	return boundedInline(raw, MAX_REVIEW_PATH_BYTES);
}

function renderPatchSection(record: ReviewRecord, maxBytes: number, maxLines: number): { lines: string[]; facts: ReviewSectionFacts } {
	const original = selectedPatchCount(record);
	if (maxBytes <= 0 || maxLines <= 0) return { lines: [], facts: { original, shown: 0, omitted: original, truncated: original > 0 || record.patch_truncated, visiblePaths: [], fullyVisiblePaths: [] } };
	const presentation = normalizeReviewPresentationCoverage(record);
	const hasPagedSource = Array.isArray(record.presentation_progress) && record.presentation_progress.some((item) =>
		item.source === "git-diff" || item.source === "file-content");
	const marker = presentation.presentation_complete
		? hasPagedSource
			? `Ordinary source presentation is complete across contiguous hash-bound pages; each page advanced only after its whole bounded entry was visible. Scope/integrity artifact: ${reviewPathOf(record)}.`
			: `Compact content is intentionally summarized — strict identity and bounded preview/omission facts form the complete evidence packet; semantic contents and generator equality remain NOT_VERIFIED for independent final verification. Scope/integrity artifact: ${reviewPathOf(record)}.`
		: `Patch content truncated or omitted — scope/integrity artifact: ${reviewPathOf(record)}; request bounded presentation segments via workbench_review_worker_diff include_paths (max ${MAX_REVIEW_PATCH_PATHS} paths per call). Semantic ACCEPT remains blocked until presentation is complete.`;
	const markerReserveBytes = Buffer.byteLength(marker, "utf8") + 1;
	const content = new ReviewLineBuilder(Math.max(0, maxBytes - markerReserveBytes), Math.max(0, maxLines - 1));
	const placeholder = `patch (${original} path(s), shown ${original}, omitted ${original}${record.patch_truncated ? ", truncated" : ""}):`;
	if (!content.add([placeholder])) return { lines: [], facts: { original, shown: 0, omitted: original, truncated: true, visiblePaths: [] } };
	let shown = 0;
	let cut = false;
	const visiblePaths: string[] = [];
	const fullyVisiblePaths: string[] = [];
	for (const entry of Array.isArray(record.patch) ? record.patch : []) {
		const path = boundedInline(entry.path, MAX_REVIEW_PATH_BYTES);
		const page = entry.page;
		const pageLabel = page === undefined ? "" : `, page bytes ${page.start_byte}-${page.end_byte}/${page.total_bytes}, stream_sha256=${page.stream_sha256}`;
		const title = `--- ${path} (${entry.source}${pageLabel}${entry.truncated ? ", truncated" : ""}) ---`;
		const normalized = unicodeScalarText(typeof entry.text === "string" ? entry.text : "(invalid)")
			.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "\ufffd");
		const body = normalized.split("\n");
		if (content.add([title, ...body])) {
			shown += 1;
			visiblePaths.push(entry.path);
			fullyVisiblePaths.push(entry.path);
			continue;
		}
		// Preserve one deterministic bounded segment of the straddling entry;
		// the final omission marker is reserved outside this builder.
		if (!content.add([title])) { cut = true; break; }
		// The complete bounded title is itself a visible entry boundary. Even
		// if no body scalar fits, the final content visibly identifies this
		// path/source as the straddling evidence segment.
		shown += 1;
		visiblePaths.push(entry.path);
		for (const line of body) {
			if (content.add([line])) continue;
			const newlineCost = content.lines.length > 0 ? 1 : 0;
			const remainingBytes = content.maxBytes - textByteLength(content.lines) - newlineCost;
			const bounded = truncateUtf8(line, Math.max(0, remainingBytes));
			if (bounded.length > 0) content.add([bounded]);
			break;
		}
		cut = true;
		break;
	}
	const omitted = Math.max(0, original - shown);
	const truncated = cut || omitted > 0 || record.patch_truncated;
	content.lines[0] = `patch (${original} path(s), shown ${shown}, omitted ${omitted}${truncated ? ", truncated" : ""}):`;
	const lines = [...content.lines];
	if (truncated && lines.length < maxLines && textByteLength([...lines, marker]) <= maxBytes) lines.push(marker);
	return { lines, facts: { original, shown, omitted, truncated, visiblePaths, fullyVisiblePaths } };
}

function renderPathStatsSection(record: ReviewRecord, maxBytes: number, maxLines: number): { lines: string[]; facts: ReviewSectionFacts } {
	const original = selectedPatchCount(record);
	if (maxBytes <= 0 || maxLines <= 0) return { lines: [], facts: { original, shown: 0, omitted: original, truncated: original > 0 } };
	const scopeLine = "Scope checks always cover the entire worker diff; include_paths only narrows the bounded patch above.";
	const reserveBytes = Buffer.byteLength(scopeLine, "utf8") + 1;
	const builder = new ReviewLineBuilder(Math.max(0, maxBytes - reserveBytes), Math.max(0, maxLines - 1));
	const placeholder = `patch paths (${original}): original=${original} shown=${original} omitted=${original}`;
	if (!builder.add([placeholder])) return { lines: [], facts: { original, shown: 0, omitted: original, truncated: true } };
	let shown = 0;
	const pathStats = Array.isArray(record.patch_paths)
		? record.patch_paths
		: (Array.isArray(record.patch) ? record.patch : []).map((entry) => ({
			path: entry.path, source: entry.source, bytes: Buffer.byteLength(entry.text, "utf8"), truncated: entry.truncated,
		}));
	for (const stat of pathStats.slice(0, MAX_REVIEW_PATCH_PATHS)) {
		const line = `  - ${boundedInline(stat.path, MAX_REVIEW_PATH_BYTES)} (${stat.source}, ${Number.isSafeInteger(stat.bytes) && stat.bytes >= 0 ? stat.bytes : 0} bytes${stat.truncated ? ", truncated" : ""})`;
		if (!builder.add([line])) break;
		shown += 1;
	}
	const omitted = Math.max(0, original - shown);
	builder.lines[0] = `patch paths (${original}): original=${original} shown=${shown} omitted=${omitted}`;
	const lines = [...builder.lines];
	if (lines.length < maxLines && textByteLength([...lines, scopeLine]) <= maxBytes) lines.push(scopeLine);
	return { lines, facts: { original, shown, omitted, truncated: omitted > 0 } };
}

function nextIncludeLine(remainingPaths: readonly string[]): string {
	const nextInclude: string[] = [];
	let guidanceBytes = 0;
	for (const raw of remainingPaths) {
		if (nextInclude.length >= MAX_REVIEW_PATCH_PATHS) break;
		// Continuation guidance is executable input, so paths are never
		// abbreviated. A path that cannot be shown whole is omitted and is
		// still included in the exact omitted count.
		if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_REVIEW_PATH_BYTES) break;
		const path = unicodeScalarText(raw);
		if (path !== raw || /[\u0000-\u001f\u007f]/.test(path)) break;
		const quoted = JSON.stringify(path);
		const entryBytes = Buffer.byteLength(quoted, "utf8") + (nextInclude.length > 0 ? 2 : 0);
		if (guidanceBytes + entryBytes > MAX_REVIEW_GUIDANCE_BYTES) break;
		nextInclude.push(path);
		guidanceBytes += entryBytes;
	}
	const omitted = remainingPaths.length - nextInclude.length;
	const text = remainingPaths.length === 0
		? "(none — every worker path displayed for this bound hash)"
		: `[${nextInclude.map((path) => JSON.stringify(path)).join(", ")}]${omitted > 0 ? `, … +${omitted} more` : ""} (max ${MAX_REVIEW_PATCH_PATHS} paths per call; ≤ ${MAX_REVIEW_GUIDANCE_BYTES} bytes)`;
	return `next incl. : ${text}`;
}

function renderControlSection(
	record: ReviewRecord,
	patchFacts: ReviewSectionFacts,
	statFacts: ReviewSectionFacts,
	maxBytes: number,
	maxLines: number,
): string[] {
	if (maxBytes <= 0 || maxLines <= 0) return [];
	const coverage = normalizeReviewCoverage(record);
	const presentationCoverage = normalizeReviewPresentationCoverage(record);
	const semantic = classifySemanticReviewRisk(Array.isArray(record.checked_paths) ? record.checked_paths : []);
	const checkedCount = Array.isArray(record.checked_paths) ? record.checked_paths.length : 0;
	const violations = Array.isArray(record.violations) ? record.violations : [];
	const notes = Array.isArray(record.notes) ? record.notes : [];
	const drift = Array.isArray(record.drift_paths) ? record.drift_paths : [];
	const allowedPaths = Array.isArray(record.allowed_paths) ? record.allowed_paths.filter((path): path is string => typeof path === "string") : [];
	const countText = (value: number): string => (Number.isSafeInteger(value) && value >= 0 ? String(value) : "0");
	const violationCount = countText(violations.length);
	const noteCount = countText(notes.length);
	const driftCount = countText(drift.length);
	const patchOriginal = countText(patchFacts.original);
	const patchShown = countText(patchFacts.shown);
	const patchOmitted = countText(patchFacts.omitted);
	const statOriginal = countText(statFacts.original);
	const statShown = countText(statFacts.shown);
	const statOmitted = countText(statFacts.omitted);
	const summaryReserve = `packet stats: violations=${violationCount}/${violationCount}/${violationCount}; notes=${noteCount}/${noteCount}/${noteCount}; drift=${driftCount}/${driftCount}/${driftCount}; patch=${patchOriginal}/${patchShown}/${patchOmitted}; stats=${statOriginal}/${statShown}/${statOmitted}; full=${reviewPathOf(record)}; scope/integrity evidence is not semantic acceptance or Gate authority`;
	const base = [
		"review kind: scope_integrity (mechanical; no semantic-quality or Gate authority)",
		`delegation : ${boundedInline(record.delegation_id, 64)}`,
		`scope check: ${record.verdict === "FAIL" ? "FAIL" : "PASS"}`,
		`inspected  : ${boundedInline(record.reviewed_at, 40)}`,
		`bound hash : ${boundedInline(record.bound_diff_hash, 64)}`,
		`after hash : ${boundedInline(record.recorded_after_hash, 64)}${record.mismatch ? " (MISMATCH)" : ""}`,
		`checked    : ${checkedCount} worker path(s)${Array.isArray(record.include_paths) && record.include_paths.length > 0 && record.include_paths.length !== checkedCount ? `, patch narrowed to ${record.include_paths.length} path(s)` : ""}`,
		`displayed  : ${coverage.displayed_paths.length} of ${checkedCount} worker path(s)`,
		`remaining  : ${coverage.remaining_paths.length} worker path(s)`,
		`coverage   : ${coverage.coverage_complete ? "COMPLETE — every worker path has a bounded scope/integrity segment" : "INCOMPLETE — scope/integrity packet needs the remaining worker paths"}`,
		`evidence   : ${presentationCoverage.presentation_complete ? "COMPLETE — each worker path has a full patch or strict compact fact packet" : `INCOMPLETE — ${presentationCoverage.presentation_remaining_paths.length} path(s) still need a full patch or strict compact fact packet`}`,
		`semantic   : ${semantic.required ? `REQUIRED (${semantic.risk} risk; explicit Sol ACCEPT must bind this hash${semantic.risk === "high" && Array.isArray(record.checked_paths) && record.checked_paths.some(isCompactEligiblePath) ? "; generator equality remains NOT_VERIFIED and compact semantic contents require independent final verification" : ""})` : "NOT_REQUIRED (zero actual delta)"}`,
		summaryReserve,
	];
	const builder = new ReviewLineBuilder(maxBytes, maxLines);
	if (!builder.add(base)) {
		const fallback = new ReviewLineBuilder(maxBytes, maxLines);
		for (const line of [
			"[workbench-scope-integrity-review v1; mechanical; no Gate authority]",
			`delegation=${boundedInline(record.delegation_id, 64)} scope_integrity=${record.verdict === "FAIL" ? "FAIL" : "PASS"}`,
			`coverage=${coverage.coverage_complete ? "COMPLETE" : "INCOMPLETE"} checked=${checkedCount} displayed=${coverage.displayed_paths.length} remaining=${coverage.remaining_paths.length}`,
			`full_patch=${presentationCoverage.presentation_complete ? "COMPLETE" : "INCOMPLETE"}; full=${reviewPathOf(record)}; packet is not semantic acceptance or Gate authority`,
		]) {
			if (!fallback.add([line])) break;
		}
		return fallback.lines;
	}
	for (const line of [nextIncludeLine(presentationCoverage.presentation_remaining_paths), `scope artifact: ${reviewPathOf(record)}`, allowedScopeLine(allowedPaths)]) {
		builder.add([line]);
	}
	let violationsShown = 0;
	for (const violation of violations.slice(0, MAX_REVIEW_VIOLATIONS)) {
		const line = `violation  : path=${JSON.stringify(boundedInline(violation.path, MAX_REVIEW_PATH_BYTES))} reason=${JSON.stringify(boundedInline(violation.reason, MAX_REVIEW_REASON_BYTES))}`;
		if (!builder.add([line])) break;
		violationsShown += 1;
	}
	let notesShown = 0;
	for (const note of notes.slice(0, MAX_REVIEW_NOTES)) {
		if (!builder.add([`note       : ${boundedInline(note, MAX_REVIEW_NOTE_BYTES)}`])) break;
		notesShown += 1;
	}
	let driftShown = 0;
	for (const path of drift) {
		if (driftShown >= MAX_REVIEW_DRIFT_PATHS) break;
		// Drift paths, like continuation paths, are only counted as shown
		// when the complete project-relative value is present.
		if (typeof path !== "string" || Buffer.byteLength(path, "utf8") > MAX_REVIEW_PATH_BYTES) continue;
		const complete = unicodeScalarText(path);
		if (complete !== path || /[\u0000-\u001f\u007f]/.test(complete)) continue;
		if (!builder.add([`drift      : ${complete}`])) break;
		driftShown += 1;
	}
	const summary = `packet stats: violations=${violationCount}/${violationsShown}/${violations.length - violationsShown}; notes=${noteCount}/${notesShown}/${notes.length - notesShown}; drift=${driftCount}/${driftShown}/${drift.length - driftShown}; patch=${patchOriginal}/${patchShown}/${patchOmitted}; stats=${statOriginal}/${statShown}/${statOmitted}; full=${reviewPathOf(record)}; scope/integrity evidence is not semantic acceptance or Gate authority`;
	const summaryIndex = builder.lines.indexOf(summaryReserve);
	if (summaryIndex >= 0) builder.lines[summaryIndex] = summary;
	return builder.lines;
}

interface ReviewPresentation {
	lines: string[];
	/** Paths whose bounded patch entry is actually present in `lines`. */
	visiblePatchPaths: string[];
	/** Paths whose complete current patch entry, not only its title/prefix, is present. */
	fullyVisiblePatchPaths: string[];
}

function renderReviewPresentationInner(record: ReviewRecord, caps: ReviewRenderCaps): ReviewPresentation {
	const maxBytes = boundInt(caps.maxBytes, DEFAULT_REVIEW_MAX_BYTES, 1, DEFAULT_REVIEW_MAX_BYTES);
	const maxLines = boundInt(caps.maxLines, DEFAULT_REVIEW_MAX_LINES, 1, DEFAULT_REVIEW_MAX_LINES);
	if (maxBytes < 1024 || maxLines < 16) {
		const fallback = [
			"[workbench-scope-integrity-review v1; mechanical; no Gate authority]",
			`delegation=${boundedInline(record.delegation_id, 64)} scope_integrity=${record.verdict === "FAIL" ? "FAIL" : "PASS"}`,
			`full=${reviewPathOf(record)}; bounded packet is not semantic acceptance`,
		];
		const builder = new ReviewLineBuilder(maxBytes, maxLines);
		for (const line of fallback) if (!builder.add([line])) break;
		return { lines: builder.lines, visiblePatchPaths: [], fullyVisiblePatchPaths: [] };
	}
	const sectionCaps = reviewSectionCaps(maxBytes, maxLines);
	const patch = renderPatchSection(record, sectionCaps.patchBytes, sectionCaps.patchLines);
	const stats = renderPathStatsSection(record, sectionCaps.statBytes, sectionCaps.statLines);
	const control = renderControlSection(record, patch.facts, stats.facts, sectionCaps.controlBytes, sectionCaps.controlLines);
	const lines = [...control, ...patch.lines, ...stats.lines];
	if (lines.length <= maxLines && textByteLength(lines) <= maxBytes) {
		return {
			lines,
			visiblePatchPaths: patch.facts.visiblePaths ?? [],
			fullyVisiblePatchPaths: patch.facts.fullyVisiblePaths ?? [],
		};
	}
	// Defensive fail-closed boundary; allocations above make this unreachable.
	return {
		lines: truncateUtf8("[workbench-diff-review error code=runtime_failure]", maxBytes).split("\n").slice(0, maxLines),
		visiblePatchPaths: [],
		fullyVisiblePatchPaths: [],
	};
}

/** Whole-result renderer: title, facts, patch, stats and markers share one cap. */
export function renderReviewLines(record: ReviewRecord, caps: ReviewRenderCaps = {}): string[] {
	try {
		return renderReviewPresentationInner(record, caps).lines;
	} catch {
		return reviewFailure("runtime_failure").lines;
	}
}

/**
 * True only when the bounded renderer actually includes every path whose
 * persisted patch/compact facts constitute the record's complete semantic
 * presentation. This closes the outer-envelope gap for historical migration:
 * durable packet completeness alone does not prove that this call showed it.
 */
export function isReviewPresentationFullyVisible(record: ReviewRecord, caps: ReviewRenderCaps = {}): boolean {
	try {
		const expected = normalizeReviewPresentationCoverage(record);
		if (!expected.presentation_complete) return false;
		const rendered = renderReviewPresentationInner(record, caps);
		const visible = new Set(rendered.visiblePatchPaths);
		return expected.fully_presented_paths.every((path) => visible.has(path));
	} catch {
		return false;
	}
}

/**
 * Read the persisted review record of a delegation (null when absent or
 * corrupt). The delegation state entry stays owned by the runtime.
 */
export async function readReviewRecord(
	projectRoot: string,
	delegationId: string,
	hooks?: BoundedFileIoHooks,
): Promise<ReviewRecord | null> {
	if (!isValidDelegationId(delegationId)) return null;
	try {
		const read = await readJsonFileBounded<ReviewRecord>(
			join(delegationDirFor(projectRoot, delegationId), "review.json"),
			REVIEW_RECORD_MAX_BYTES,
			hooks,
		);
		if (!read.ok) return null;
		const parsed = read.value.value;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		if (parsed.schema_version !== REVIEW_SCHEMA_VERSION || parsed.delegation_id !== delegationId) return null;
		// The finish-time PENDING_REVIEW placeholder (core/delegation-ledger.ts)
		// is not a completed review — treat it as "no review yet".
		if ((parsed as { review_status?: unknown }).review_status === "PENDING_REVIEW") return null;
		return parsed;
	} catch {
		return null;
	}
}
