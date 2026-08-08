/**
 * P8a — durable two-phase tool-result receipt core (pure, no Pi imports).
 *
 * Repository-owned, session-level recovery primitive for the
 * commander-token-optimization persist-first slice. Wired into the Pi
 * runtime in P8b (extensions/workbench-runtime/index.ts): every registered
 * workbench tool EXCEPT the public recovery tool begins an exclusive
 * started receipt at the END of the `tool_call` guard (after every
 * worker/commander/mode/path/lease check has allowed) and finalizes a
 * bounded/redacted receipt in the `tool_result` handler before Pi emits
 * the external final result events; the public read-only
 * `workbench_recover_tool_result` tool recovers persisted receipt facts by
 * strict result id or current-session toolCallId. This module implements
 * NO WebSocket (or any other) transport — this repository owns no
 * transport.
 *
 * Storage (project-local, additive, session-level):
 *   .pi/workbench/tool-results/<id>.started   phase 1 — exclusive-create
 *   .pi/workbench/tool-results/<id>.json      phase 2 — atomic publish
 *
 * Identity: a result id is `wtr1-` + 64 lowercase hex = SHA-256 of the
 * canonical binding of a bounded non-empty native Pi session identity and
 * a bounded non-empty Pi toolCallId (`deriveResultId`, deterministic).
 * The exact tool name and a canonical privacy-safe SHA-256 hash of the raw
 * input are persisted identity facts; raw input/arguments are NEVER
 * persisted. Identity inputs are validated (non-empty, length-bounded, no
 * control characters) before any id is derived or any path is built.
 *
 * Outcomes are fixed and fail-closed:
 *   begin    → created | completed_replay | incomplete_replay |
 *              invalid_identity | corrupt_receipt | identity_conflict |
 *              storage_error
 *   finalize → finalized | invalid_handle | missing_started |
 *              corrupt_started | identity_conflict | already_finalized |
 *              write_error
 *   recover  → completed | invalid | missing | incomplete | corrupt |
 *              conflict | storage_error
 *
 * Existing receipts are strictly parsed and cross-checked — no overwrite,
 * no guessing, no best-effort success. `completed_replay` requires BOTH
 * phases: the started phase must exist, strictly parse, and agree with
 * the finalized phase on id, tool, input_hash and created_at — a
 * finalized-only, missing-started, malformed/unsafe/oversized started,
 * or cross-phase-mismatched receipt fails closed as corrupt_receipt
 * (recover: corrupt / conflict) and is NEVER reported completed.
 * Environmental failures (unsafe pre-existing paths, mkdir/read/write/
 * publish errors) are surfaced as storage_error / write_error, never as
 * success. Temp leftovers and foreign artifacts in the directory are
 * ignored; legacy run/cache/delegation/domain records are never read,
 * migrated, or rewritten.
 *
 * Privacy and bounds: persisted summaries are extracted from the textual
 * tool result only — existing env/token redaction (core/redact.ts) runs
 * FIRST over the full content, then explicit UTF-8 byte and line caps
 * (≤ SUMMARY_MAX_BYTES / SUMMARY_MAX_LINES) apply with code-point-safe
 * truncation (core/milestone-handoff.ts helpers) and a `\n[truncated]`
 * omission marker whose own byte and line space is reserved INSIDE the
 * caps. Control characters are sanitized per line. Error facts use the
 * same discipline with smaller caps. The exported bounded-text helper
 * validates its caps explicitly (2..SUMMARY_MAX_LINES lines, marker
 * bytes + 1..SUMMARY_MAX_BYTES bytes — out-of-range caller caps throw a
 * RangeError) and marker presence exactly matches the omission facts (a
 * content suffix that merely looks like the marker is stripped when
 * nothing was omitted), so the helper can never build a record its own
 * strict parser rejects. Artifact files are capped at MAX_ARTIFACT_BYTES
 * and read through a strictly bounded fd read.
 *
 * Path safety: every artifact path is built only from a strictly validated
 * result id; the `.pi/workbench/tool-results/` directory is created mode
 * 0700 and realpath-containment-checked (core/path-guard.ts) BEFORE any
 * mkdir (an escaping symlink at `.pi`/`.pi/workbench`/`tool-results` never
 * causes a write outside the project root) and again after mkdir.
 * Artifacts are written mode 0600; existing artifacts are never
 * rewritten — a started receipt is published atomically and exclusively
 * (tmp file + hard link; a racing creator gets EEXIST and re-classifies),
 * and a finalized receipt is published atomically with no-overwrite
 * semantics (tmp file + hard link; an existing finalized artifact is
 * already_finalized, never replaced). Reads lstat each artifact and reject
 * non-regular files (symlinks, directories) and oversized files.
 */

import { randomBytes } from "node:crypto";
import { lstat, link, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { canonicalHash } from "../cache/canonical-hash.ts";
import { truncateUtf8, utf8ByteLength } from "./milestone-handoff.ts";
import { realpathContained } from "./path-guard.ts";
import { redactText } from "./redact.ts";

// ---------------------------------------------------------------------------
// Fixed constants (public for tests and P8b wiring)
// ---------------------------------------------------------------------------

/** Pi config directory name (native default; this module never imports Pi). */
export const PI_CONFIG_DIR_NAME = ".pi";
/** Directory holding the two-phase receipts, relative to the config dir. */
export const TOOL_RESULTS_DIR = "tool-results";

export const SCHEMA_NAME = "wtr1";
export const SCHEMA_VERSION = 1;

export const RESULT_ID_PREFIX = "wtr1-";
/** Strict result-id shape: prefix + exactly 64 lowercase hex chars. */
export const RESULT_ID_RE = /^wtr1-[0-9a-f]{64}$/;
export const INPUT_HASH_RE = /^[0-9a-f]{64}$/;
/** 16 random bytes as hex — the finalize capability stored in the started phase. */
export const NONCE_RE = /^[0-9a-f]{32}$/;

export const STARTED_FILE_SUFFIX = ".started";
export const FINALIZED_FILE_SUFFIX = ".json";

/** Identity input caps (bounded non-empty session identity / Pi toolCallId). */
export const MAX_SESSION_IDENTITY_CHARS = 512;
export const MAX_TOOL_CALL_ID_CHARS = 256;
export const MAX_TOOL_NAME_CHARS = 128;

/** Absolute cap for any artifact file; oversized files fail closed. */
export const MAX_ARTIFACT_BYTES = 64 * 1024;
/** Per-string field cap at strict-parse time (never reached by our own writes). */
export const MAX_FIELD_CHARS = 4096;
/** ISO-8601 timestamp string cap. */
export const MAX_ISO_CHARS = 40;

/** Summary caps (explicit UTF-8 byte and line caps; marker space reserved inside). */
export const SUMMARY_MAX_LINES = 20;
export const SUMMARY_MAX_BYTES = 2048;
/** Error-fact caps (same discipline, smaller). */
export const ERROR_MAX_LINES = 8;
export const ERROR_MAX_BYTES = 512;

/** Omission marker; its own byte and line space is reserved INSIDE the caps. */
export const OMISSION_MARKER = "\n[truncated]";

/** Rendered recovery is globally bounded; parse caps make this unreachable. */
export const RENDER_MAX_LINES = 40;
export const RENDER_MAX_BYTES = 4096;

/**
 * P8b: bound for the in-memory handle map (handles newly created by THIS
 * runtime only, toolCallId → handle+projectRoot). CAPACITY-BLOCKING: when
 * the map is already at this bound, a new registered workbench call is
 * blocked fail-closed BEFORE beginReceipt/execution with a fixed bounded
 * reason — an existing pending handle is NEVER evicted, and nothing is
 * begun for the blocked call (so no started receipt is left incomplete).
 */
export const MAX_IN_FLIGHT_RECEIPTS = 256;

/** Fixed disclaimer line of the bounded renderer. */
export const RECEIPT_DISCLAIMER = "persisted presentation, never acceptance evidence";

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** Control characters that may never appear in a persisted text field (only \n allowed). */
const PERSISTED_TEXT_FORBIDDEN_RE = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const SANITIZE_CONTROL_RE = /[\u0000-\u001f\u007f]/g;

// ---------------------------------------------------------------------------
// Records and outcomes
// ---------------------------------------------------------------------------

/** Handle returned by a successful begin; the only capability finalize accepts. */
export interface ReceiptHandle {
	id: string;
	toolName: string;
	inputHash: string;
	/** Opaque per-receipt capability persisted in the started artifact. */
	nonce: string;
}

/** Phase-1 artifact content (strictly validated on every read). */
export interface StartedReceipt {
	schema: "wtr1";
	schema_version: 1;
	id: string;
	tool: string;
	input_hash: string;
	nonce: string;
	status: "started";
	created_at: string;
}

/** Phase-2 artifact content (strictly validated on every read). */
export interface FinalizedReceipt {
	schema: "wtr1";
	schema_version: 1;
	id: string;
	tool: string;
	input_hash: string;
	status: "success" | "error";
	/** Bounded, redacted error fact; null when status is "success". */
	error: string | null;
	/** Bounded, redacted summary extracted from the textual result content. */
	summary: string;
	summary_omitted_lines: number;
	summary_omitted_bytes: number;
	created_at: string;
	finalized_at: string;
}

export type StorageFailureReason = "unsafe_dir" | "mkdir_failed" | "write_failed" | "read_failed";
export type WriteFailureReason = "unsafe_dir" | "read_failed" | "unsafe_target" | "tmp_write_failed" | "publish_failed";

export type BeginOutcome =
	| { ok: true; kind: "created"; handle: ReceiptHandle }
	| { ok: false; kind: "completed_replay"; receipt: FinalizedReceipt }
	| { ok: false; kind: "incomplete_replay"; started: StartedReceipt }
	| { ok: false; kind: "invalid_identity" }
	| { ok: false; kind: "corrupt_receipt" }
	| { ok: false; kind: "identity_conflict" }
	| { ok: false; kind: "storage_error"; reason: StorageFailureReason };

export type FinalizeOutcome =
	| { ok: true; kind: "finalized"; receipt: FinalizedReceipt }
	| { ok: false; kind: "invalid_handle" }
	| { ok: false; kind: "missing_started" }
	| { ok: false; kind: "corrupt_started" }
	| { ok: false; kind: "identity_conflict" }
	| { ok: false; kind: "already_finalized" }
	| { ok: false; kind: "write_error"; reason: WriteFailureReason };

export type RecoverOutcome =
	| { ok: true; kind: "completed"; receipt: FinalizedReceipt }
	| { ok: false; kind: "invalid" }
	| { ok: false; kind: "missing" }
	| { ok: false; kind: "incomplete"; started: StartedReceipt }
	| { ok: false; kind: "corrupt" }
	| { ok: false; kind: "conflict" }
	| { ok: false; kind: "storage_error"; reason: StorageFailureReason };

export interface BeginReceiptInput {
	projectRoot: string;
	/** Bounded non-empty native Pi session identity (never persisted raw). */
	sessionIdentity: string;
	/** Bounded non-empty Pi toolCallId (never persisted raw). */
	toolCallId: string;
	/** Exact tool name — persisted identity fact. */
	toolName: string;
	/** Raw tool input/arguments — ONLY canonically hashed, never persisted. */
	rawInput: unknown;
}

export interface FinalizeReceiptInput {
	projectRoot: string;
	/** A handle returned by a successful begin; nothing else is accepted. */
	handle: ReceiptHandle;
	status: "success" | "error";
	/** Textual tool result content — redacted, bounded, never persisted raw. */
	content: string;
	/** Optional error fact — redacted and bounded before persistence. */
	error?: string;
	/** Env secret values to scrub (wiring collects them; never persisted). */
	secrets?: readonly string[];
}

export interface RecoverReceiptInput {
	projectRoot: string;
	/** Strictly validated result id — takes precedence when both are given. */
	id?: string;
	/** Current-session identity + bounded toolCallId derivation. */
	sessionIdentity?: string;
	toolCallId?: string;
}

// ---------------------------------------------------------------------------
// Identity derivation and validation
// ---------------------------------------------------------------------------

/**
 * Deterministic `wtr1-<64 lowercase hex>` result id for a session identity +
 * Pi toolCallId pair. Callers must validate the inputs first
 * (begin/recover do); this function is a pure hash binding.
 */
export function deriveResultId(sessionIdentity: string, toolCallId: string): string {
	return `${RESULT_ID_PREFIX}${canonicalHash({ session: sessionIdentity, toolCallId })}`;
}

function isValidProjectRoot(projectRoot: unknown): projectRoot is string {
	return typeof projectRoot === "string" && projectRoot.trim().length > 0;
}

/**
 * Exact shared identity validation (P8b wiring and this core use the SAME
 * rules): a valid session identity / toolCallId pair is non-empty after
 * trim, length-bounded (MAX_SESSION_IDENTITY_CHARS / MAX_TOOL_CALL_ID_CHARS)
 * and free of control characters. Only a valid pair may ever be hashed
 * into a result id — callers must validate before deriveResultId.
 */
export function isValidIdentity(sessionIdentity: string, toolCallId: string): boolean {
	return (
		typeof sessionIdentity === "string" &&
		sessionIdentity.trim().length > 0 &&
		sessionIdentity.length <= MAX_SESSION_IDENTITY_CHARS &&
		!CONTROL_RE.test(sessionIdentity) &&
		typeof toolCallId === "string" &&
		toolCallId.trim().length > 0 &&
		toolCallId.length <= MAX_TOOL_CALL_ID_CHARS &&
		!CONTROL_RE.test(toolCallId)
	);
}

function isValidToolName(toolName: unknown): toolName is string {
	return (
		typeof toolName === "string" &&
		toolName.trim().length > 0 &&
		toolName.length <= MAX_TOOL_NAME_CHARS &&
		!CONTROL_RE.test(toolName)
	);
}

function isValidHandle(handle: unknown): handle is ReceiptHandle {
	if (typeof handle !== "object" || handle === null) return false;
	const h = handle as Record<string, unknown>;
	return (
		typeof h.id === "string" &&
		RESULT_ID_RE.test(h.id) &&
		isValidToolName(h.toolName) &&
		typeof h.inputHash === "string" &&
		INPUT_HASH_RE.test(h.inputHash) &&
		typeof h.nonce === "string" &&
		NONCE_RE.test(h.nonce)
	);
}

function isValidIso(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_ISO_CHARS &&
		!Number.isNaN(Date.parse(value))
	);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Strict result-id precondition for every exported path builder: an unsafe
 * (non-`wtr1-` shaped) id can never be turned into a filesystem path.
 */
function assertValidResultId(id: string): void {
	if (!RESULT_ID_RE.test(id)) {
		throw new RangeError(`invalid result id: expected ${RESULT_ID_RE.source}`);
	}
}

/** Absolute path of the receipt directory under the project root. */
export function toolResultsDir(projectRoot: string): string {
	if (!isValidProjectRoot(projectRoot)) throw new RangeError("invalid project root");
	return join(resolve(projectRoot), PI_CONFIG_DIR_NAME, "workbench", TOOL_RESULTS_DIR);
}

/** Absolute path of the phase-1 started artifact (validated ids only). */
export function startedPathFor(projectRoot: string, id: string): string {
	assertValidResultId(id);
	return join(toolResultsDir(projectRoot), `${id}${STARTED_FILE_SUFFIX}`);
}

/** Absolute path of the phase-2 finalized artifact (validated ids only). */
export function finalizedPathFor(projectRoot: string, id: string): string {
	assertValidResultId(id);
	return join(toolResultsDir(projectRoot), `${id}${FINALIZED_FILE_SUFFIX}`);
}

/** Project-relative receipt path (forward slashes, never escaping the root). */
export function receiptRelativePath(projectRoot: string, id: string): string {
	assertValidResultId(id);
	const rel = relative(resolve(projectRoot), finalizedPathFor(projectRoot, id)).split("\\").join("/");
	if (!rel || rel === ".." || rel.startsWith("../")) return `${id}${FINALIZED_FILE_SUFFIX}`;
	return rel;
}

/**
 * Realpath containment of the receipt directory inside the project root.
 * Rejects symlinked/escaping pre-existing paths BEFORE any mkdir, so an
 * unsafe `.pi`/`.pi/workbench`/`tool-results` can never redirect a write
 * outside the project.
 */
async function isToolResultsDirContained(projectRoot: string): Promise<boolean> {
	return (await realpathContained(projectRoot, toolResultsDir(projectRoot))) !== undefined;
}

function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

// ---------------------------------------------------------------------------
// Bounded artifact reads (fail closed: symlinks, directories, oversized)
// ---------------------------------------------------------------------------

type ArtifactRead =
	| { ok: "absent" }
	| { ok: "read"; raw: string }
	| { ok: "unsafe" }
	| { ok: "oversize" }
	| { ok: "io_error" };

const READ_CHUNK_BYTES = 8192;

async function readArtifact(absolutePath: string): Promise<ArtifactRead> {
	let st;
	try {
		st = await lstat(absolutePath);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return { ok: "absent" };
		return { ok: "io_error" };
	}
	if (!st.isFile()) return { ok: "unsafe" };
	try {
		const fh = await open(absolutePath, "r");
		try {
			const chunks: Buffer[] = [];
			let total = 0;
			const buf = Buffer.alloc(READ_CHUNK_BYTES);
			for (;;) {
				const { bytesRead } = await fh.read(buf, 0, buf.length, total);
				if (bytesRead === 0) break;
				total += bytesRead;
				if (total > MAX_ARTIFACT_BYTES) return { ok: "oversize" };
				chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
			}
			return { ok: "read", raw: Buffer.concat(chunks).toString("utf8") };
		} finally {
			await fh.close();
		}
	} catch {
		return { ok: "io_error" };
	}
}

// ---------------------------------------------------------------------------
// Strict receipt parsing (exact field sets, no extra/malformed fields)
// ---------------------------------------------------------------------------

const STARTED_FIELDS = ["schema", "schema_version", "id", "tool", "input_hash", "nonce", "status", "created_at"];
const FINALIZED_FIELDS = [
	"schema",
	"schema_version",
	"id",
	"tool",
	"input_hash",
	"status",
	"error",
	"summary",
	"summary_omitted_lines",
	"summary_omitted_bytes",
	"created_at",
	"finalized_at",
];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseCommon(data: unknown, expectedId: string): { ok: true; base: { id: string; tool: string; input_hash: string } } | { ok: false; reason: string } {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, reason: "not_object" };
	const o = data as Record<string, unknown>;
	if (o.schema !== SCHEMA_NAME) return { ok: false, reason: "schema" };
	if (o.schema_version !== SCHEMA_VERSION) return { ok: false, reason: "schema_version" };
	if (typeof o.id !== "string" || o.id !== expectedId || !RESULT_ID_RE.test(o.id)) return { ok: false, reason: "id" };
	if (!isValidToolName(o.tool)) return { ok: false, reason: "tool" };
	if (typeof o.input_hash !== "string" || !INPUT_HASH_RE.test(o.input_hash)) return { ok: false, reason: "input_hash" };
	return { ok: true, base: { id: o.id, tool: o.tool, input_hash: o.input_hash } };
}

function hasForbiddenPersistedControl(text: string): boolean {
	return PERSISTED_TEXT_FORBIDDEN_RE.test(text);
}

/** Strict parse of a phase-1 artifact; the persisted id must equal the filename id. */
export function parseStartedArtifact(raw: string, expectedId: string): ParseResult<StartedReceipt> {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "not_json" };
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, reason: "not_object" };
	const o = data as Record<string, unknown>;
	const keys = Object.keys(o);
	if (keys.length !== STARTED_FIELDS.length || keys.some((k) => !STARTED_FIELDS.includes(k))) {
		return { ok: false, reason: "field_set" };
	}
	const common = parseCommon(data, expectedId);
	if (!common.ok) return common;
	if (typeof o.nonce !== "string" || !NONCE_RE.test(o.nonce)) return { ok: false, reason: "nonce" };
	if (o.status !== "started") return { ok: false, reason: "status" };
	if (!isValidIso(o.created_at)) return { ok: false, reason: "created_at" };
	return {
		ok: true,
		value: {
			schema: SCHEMA_NAME,
			schema_version: SCHEMA_VERSION,
			id: common.base.id,
			tool: common.base.tool,
			input_hash: common.base.input_hash,
			nonce: o.nonce,
			status: "started",
			created_at: o.created_at,
		},
	};
}

/** Strict parse of a phase-2 artifact; caps, controls and marker consistency are enforced. */
export function parseFinalizedArtifact(raw: string, expectedId: string): ParseResult<FinalizedReceipt> {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "not_json" };
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, reason: "not_object" };
	const o = data as Record<string, unknown>;
	const keys = Object.keys(o);
	if (keys.length !== FINALIZED_FIELDS.length || keys.some((k) => !FINALIZED_FIELDS.includes(k))) {
		return { ok: false, reason: "field_set" };
	}
	const common = parseCommon(data, expectedId);
	if (!common.ok) return common;
	if (o.status !== "success" && o.status !== "error") return { ok: false, reason: "status" };
	if (o.error !== null) {
		if (typeof o.error !== "string" || utf8ByteLength(o.error) > ERROR_MAX_BYTES || o.error.split("\n").length > ERROR_MAX_LINES || hasForbiddenPersistedControl(o.error)) {
			return { ok: false, reason: "error" };
		}
	}
	if (typeof o.summary !== "string" || utf8ByteLength(o.summary) > SUMMARY_MAX_BYTES || o.summary.split("\n").length > SUMMARY_MAX_LINES || hasForbiddenPersistedControl(o.summary)) {
		return { ok: false, reason: "summary" };
	}
	if (
		typeof o.summary_omitted_lines !== "number" ||
		!Number.isSafeInteger(o.summary_omitted_lines) ||
		o.summary_omitted_lines < 0 ||
		typeof o.summary_omitted_bytes !== "number" ||
		!Number.isSafeInteger(o.summary_omitted_bytes) ||
		o.summary_omitted_bytes < 0
	) {
		return { ok: false, reason: "omissions" };
	}
	// Marker presence must exactly match the omission facts (extraction invariant).
	const omitted = o.summary_omitted_lines > 0 || o.summary_omitted_bytes > 0;
	if (omitted !== o.summary.endsWith(OMISSION_MARKER)) return { ok: false, reason: "marker" };
	if (!isValidIso(o.created_at)) return { ok: false, reason: "created_at" };
	if (!isValidIso(o.finalized_at)) return { ok: false, reason: "finalized_at" };
	if (Date.parse(o.finalized_at) < Date.parse(o.created_at)) return { ok: false, reason: "timestamp_order" };
	return {
		ok: true,
		value: {
			schema: SCHEMA_NAME,
			schema_version: SCHEMA_VERSION,
			id: common.base.id,
			tool: common.base.tool,
			input_hash: common.base.input_hash,
			status: o.status,
			error: o.error,
			summary: o.summary,
			summary_omitted_lines: o.summary_omitted_lines,
			summary_omitted_bytes: o.summary_omitted_bytes,
			created_at: o.created_at,
			finalized_at: o.finalized_at,
		},
	};
}

// ---------------------------------------------------------------------------
// Bounded redacted summary extraction (redact first, then cap)
// ---------------------------------------------------------------------------

/** Result of bounded text extraction (used for summaries and error facts). */
export interface BoundedText {
	text: string;
	/** Final UTF-8 byte count (marker included when present). */
	bytes: number;
	/** Final line count (marker included when present). */
	lines: number;
	omittedLines: number;
	omittedBytes: number;
}

/**
 * Extract a bounded, redacted text summary from raw text result content.
 *
 * Discipline: env/token redaction runs FIRST over the full content (a
 * secret at the truncation boundary is already replaced, so no secret
 * fragment can survive), control characters are sanitized per line, then
 * explicit line and UTF-8 byte caps apply. The `\n[truncated]` omission
 * marker's own byte AND line space is reserved inside the caps (one
 * content line and MARKER_BYTES are subtracted up front), so the final
 * text never exceeds `maxLines` lines or `maxBytes` bytes and a
 * truncation is never silent. Truncation is code-point safe (existing
 * UTF-8 helpers), so multibyte characters are never split.
 *
 * Supported caps are validated EXPLICITLY: `maxLines` must be an integer
 * within [2, SUMMARY_MAX_LINES] and `maxBytes` within [markerBytes + 1,
 * SUMMARY_MAX_BYTES] — out-of-range caller caps throw a RangeError (the
 * marker's space cannot be reserved, or the result could never pass the
 * strict parser's persisted caps). Within the supported range the output
 * ALWAYS satisfies the strict parser's invariants: line/byte caps, no
 * forbidden control characters, and marker presence exactly matching the
 * omission facts — a content suffix that merely looks like the marker is
 * stripped when nothing was omitted, so the helper can never build a
 * record that `parseFinalizedArtifact` rejects.
 */
export function extractBoundedSummary(content: string, secrets: readonly string[], maxLines: number, maxBytes: number): BoundedText {
	const markerBytes = utf8ByteLength(OMISSION_MARKER);
	if (!Number.isSafeInteger(maxLines) || maxLines < 2 || maxLines > SUMMARY_MAX_LINES) {
		throw new RangeError(`extractBoundedSummary: maxLines must be an integer within [2, ${SUMMARY_MAX_LINES}]`);
	}
	if (!Number.isSafeInteger(maxBytes) || maxBytes < markerBytes + 1 || maxBytes > SUMMARY_MAX_BYTES) {
		throw new RangeError(`extractBoundedSummary: maxBytes must be an integer within [${markerBytes + 1}, ${SUMMARY_MAX_BYTES}]`);
	}
	const effectiveBytes = maxBytes - markerBytes;
	const contentLineCap = maxLines - 1;
	// Redaction FIRST over the full content (a secret spanning lines or
	// sitting at the truncation boundary is already replaced), then
	// per-line control sanitization, then the explicit caps.
	const lines = redactText(content, secrets).split("\n").map(sanitizeLine);
	const totalRedactedBytes = utf8ByteLength(lines.join("\n"));
	let omittedLines = 0;
	let kept = lines;
	if (lines.length > contentLineCap) {
		omittedLines = lines.length - contentLineCap;
		kept = lines.slice(0, contentLineCap);
	}
	let text = kept.join("\n");
	const truncated = utf8ByteLength(text) > effectiveBytes;
	if (truncated) text = truncateUtf8(text, effectiveBytes);
	const omittedBytes = Math.max(0, totalRedactedBytes - utf8ByteLength(text));
	if (omittedLines > 0 || truncated) {
		// The marker's line and byte space was reserved inside the caps up
		// front, so the final text stays within maxLines lines and maxBytes
		// bytes and the truncation is never silent.
		text += OMISSION_MARKER;
	} else {
		// Marker discipline: the strict parser requires marker presence to
		// EXACTLY match the omission facts, so a content suffix that merely
		// looks like the marker is stripped when nothing was omitted (the
		// presentation never misleads and the record always parses).
		while (text.endsWith(OMISSION_MARKER)) text = text.slice(0, -OMISSION_MARKER.length);
	}
	return { text, bytes: utf8ByteLength(text), lines: text.split("\n").length, omittedLines, omittedBytes };
}

function sanitizeLine(line: string): string {
	return line.replace(SANITIZE_CONTROL_RE, " ");
}

// ---------------------------------------------------------------------------
// begin — exclusive phase-1 creation with strict replay/conflict classification
// ---------------------------------------------------------------------------

async function classifyExisting(projectRoot: string, id: string, toolName: string, inputHash: string): Promise<BeginOutcome | null> {
	const started = await readArtifact(startedPathFor(projectRoot, id));
	const finalized = await readArtifact(finalizedPathFor(projectRoot, id));
	if (started.ok === "io_error" || finalized.ok === "io_error") return { ok: false, kind: "storage_error", reason: "read_failed" };
	if (started.ok === "unsafe" || started.ok === "oversize" || finalized.ok === "unsafe" || finalized.ok === "oversize") {
		return { ok: false, kind: "corrupt_receipt" };
	}
	if (finalized.ok === "read") {
		const finalizedParsed = parseFinalizedArtifact(finalized.raw, id);
		if (!finalizedParsed.ok) return { ok: false, kind: "corrupt_receipt" };
		// Two-phase invariant: a finalized artifact is NEVER a completed
		// replay unless the started phase also exists, strictly parses and
		// agrees with it on id/tool/input_hash/created_at. Final-only,
		// missing-started, malformed/unsafe/oversized started and
		// cross-phase mismatches fail closed — never completed_replay.
		if (started.ok !== "read") return { ok: false, kind: "corrupt_receipt" };
		const startedParsed = parseStartedArtifact(started.raw, id);
		if (!startedParsed.ok) return { ok: false, kind: "corrupt_receipt" };
		const s = startedParsed.value;
		const f = finalizedParsed.value;
		// The persisted id equals the filename id in BOTH phases by strict
		// parse, so the cross-phase check covers tool/input_hash/created_at.
		if (s.tool !== f.tool || s.input_hash !== f.input_hash || s.created_at !== f.created_at) {
			return { ok: false, kind: "corrupt_receipt" };
		}
		// Both phases agree with each other; only now compare against the
		// requested identity (a receipt from another identity is a conflict,
		// not corruption).
		if (f.tool !== toolName || f.input_hash !== inputHash) return { ok: false, kind: "identity_conflict" };
		return { ok: false, kind: "completed_replay", receipt: f };
	}
	if (started.ok === "read") {
		const parsed = parseStartedArtifact(started.raw, id);
		if (!parsed.ok) return { ok: false, kind: "corrupt_receipt" };
		if (parsed.value.tool !== toolName || parsed.value.input_hash !== inputHash) return { ok: false, kind: "identity_conflict" };
		return { ok: false, kind: "incomplete_replay", started: parsed.value };
	}
	return null;
}

/**
 * Begin a receipt: validate identity, derive the deterministic id, then
 * publish the phase-1 started artifact EXCLUSIVELY (tmp file + hard link —
 * the artifact appears complete atomically, so parallel creators can never
 * observe a partial receipt; a racing creator gets EEXIST and re-classifies
 * the existing state). Existing receipts are strictly parsed and
 * cross-checked — never overwritten, never guessed at.
 *
 * Environmental failures (unsafe pre-existing paths, mkdir/read/write
 * errors) are surfaced as `storage_error`; they are never converted into a
 * success.
 */
export async function beginReceipt(input: BeginReceiptInput): Promise<BeginOutcome> {
	if (!isValidProjectRoot(input.projectRoot)) return { ok: false, kind: "storage_error", reason: "unsafe_dir" };
	if (!isValidIdentity(input.sessionIdentity, input.toolCallId) || !isValidToolName(input.toolName)) {
		return { ok: false, kind: "invalid_identity" };
	}
	let inputHash: string;
	try {
		inputHash = canonicalHash(input.rawInput);
	} catch {
		// Non-JSON input cannot yield a canonical privacy-safe identity fact.
		return { ok: false, kind: "invalid_identity" };
	}
	const id = deriveResultId(input.sessionIdentity, input.toolCallId);
	if (!(await isToolResultsDirContained(input.projectRoot))) return { ok: false, kind: "storage_error", reason: "unsafe_dir" };
	const existing = await classifyExisting(input.projectRoot, id, input.toolName, inputHash);
	if (existing !== null) return existing;
	try {
		await mkdir(toolResultsDir(input.projectRoot), { recursive: true, mode: 0o700 });
	} catch {
		return { ok: false, kind: "storage_error", reason: "mkdir_failed" };
	}
	if (!(await isToolResultsDirContained(input.projectRoot))) return { ok: false, kind: "storage_error", reason: "unsafe_dir" };
	const nonce = randomBytes(16).toString("hex");
	const started: StartedReceipt = {
		schema: SCHEMA_NAME,
		schema_version: SCHEMA_VERSION,
		id,
		tool: input.toolName,
		input_hash: inputHash,
		nonce,
		status: "started",
		created_at: new Date().toISOString(),
	};
	const payload = `${JSON.stringify(started, null, 2)}\n`;
	const dir = toolResultsDir(input.projectRoot);
	const tmp = join(dir, `.${id}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
	} catch {
		return { ok: false, kind: "storage_error", reason: "write_failed" };
	}
	try {
		await link(tmp, startedPathFor(input.projectRoot, id));
	} catch (error) {
		await unlink(tmp).catch(() => {});
		if (isNodeError(error, "EEXIST")) {
			const raced = await classifyExisting(input.projectRoot, id, input.toolName, inputHash);
			if (raced !== null) return raced;
		}
		return { ok: false, kind: "storage_error", reason: "write_failed" };
	}
	await unlink(tmp).catch(() => {});
	return { ok: true, kind: "created", handle: { id, toolName: input.toolName, inputHash, nonce } };
}

// ---------------------------------------------------------------------------
// finalize — atomic phase-2 publish, created-handle only, no overwrite
// ---------------------------------------------------------------------------

/**
 * Finalize a receipt created by begin. Accepts ONLY a created handle:
 * the started artifact is strictly parsed and cross-checked against the
 * handle (id, tool name, input hash, and the opaque nonce capability), and
 * the phase-2 artifact is published atomically with no-overwrite semantics
 * (tmp file + hard link; an existing finalized artifact is
 * `already_finalized`, never replaced). Only status/error facts and a
 * redacted bounded text summary are persisted — never raw content, argv,
 * full logs, image bytes, or secrets. Failures are distinguishable and
 * leave recovery incomplete; the started receipt is never deleted or
 * replaced.
 */
export async function finalizeReceipt(input: FinalizeReceiptInput): Promise<FinalizeOutcome> {
	if (!isValidProjectRoot(input.projectRoot)) return { ok: false, kind: "write_error", reason: "unsafe_dir" };
	if (!isValidHandle(input.handle)) return { ok: false, kind: "invalid_handle" };
	if (input.status !== "success" && input.status !== "error") return { ok: false, kind: "invalid_handle" };
	const { id, toolName, inputHash, nonce } = input.handle;
	if (!(await isToolResultsDirContained(input.projectRoot))) return { ok: false, kind: "write_error", reason: "unsafe_dir" };
	const started = await readArtifact(startedPathFor(input.projectRoot, id));
	if (started.ok === "absent") return { ok: false, kind: "missing_started" };
	if (started.ok === "io_error") return { ok: false, kind: "write_error", reason: "read_failed" };
	if (started.ok !== "read") return { ok: false, kind: "corrupt_started" };
	const parsed = parseStartedArtifact(started.raw, id);
	if (!parsed.ok) return { ok: false, kind: "corrupt_started" };
	if (parsed.value.tool !== toolName || parsed.value.input_hash !== inputHash) return { ok: false, kind: "identity_conflict" };
	if (parsed.value.nonce !== nonce) return { ok: false, kind: "invalid_handle" };
	const existing = await readArtifact(finalizedPathFor(input.projectRoot, id));
	if (existing.ok === "io_error") return { ok: false, kind: "write_error", reason: "read_failed" };
	if (existing.ok === "read") return { ok: false, kind: "already_finalized" };
	if (existing.ok !== "absent") return { ok: false, kind: "write_error", reason: "unsafe_target" };

	const secrets = (input.secrets ?? []).filter((s): s is string => typeof s === "string");
	const summary = extractBoundedSummary(input.content, secrets, SUMMARY_MAX_LINES, SUMMARY_MAX_BYTES);
	const errorText = input.status === "error" ? extractBoundedSummary(input.error ?? "", secrets, ERROR_MAX_LINES, ERROR_MAX_BYTES) : null;
	const receipt: FinalizedReceipt = {
		schema: SCHEMA_NAME,
		schema_version: SCHEMA_VERSION,
		id,
		tool: toolName,
		input_hash: inputHash,
		status: input.status,
		error: errorText === null || errorText.text === "" ? null : errorText.text,
		summary: summary.text,
		summary_omitted_lines: summary.omittedLines,
		summary_omitted_bytes: summary.omittedBytes,
		created_at: parsed.value.created_at,
		finalized_at: new Date().toISOString(),
	};
	const payload = `${JSON.stringify(receipt, null, 2)}\n`;
	const dir = toolResultsDir(input.projectRoot);
	const tmp = join(dir, `.${id}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
	} catch {
		return { ok: false, kind: "write_error", reason: "tmp_write_failed" };
	}
	try {
		await link(tmp, finalizedPathFor(input.projectRoot, id));
	} catch (error) {
		await unlink(tmp).catch(() => {});
		if (isNodeError(error, "EEXIST")) return { ok: false, kind: "already_finalized" };
		return { ok: false, kind: "write_error", reason: "publish_failed" };
	}
	await unlink(tmp).catch(() => {});
	return { ok: true, kind: "finalized", receipt };
}

// ---------------------------------------------------------------------------
// recover — strictly read-only, deterministic, fail-closed
// ---------------------------------------------------------------------------

/**
 * Read/recover a receipt by strictly validated result id OR by
 * current-session identity + bounded toolCallId derivation. When BOTH are
 * given the explicit id takes precedence (core rule, tested); requiring
 * EXACTLY one of them is a P8b public-tool runtime rule, not a core rule.
 * Both phases are strictly parsed and cross-checked (id, tool, input hash,
 * created_at must agree; the persisted id must equal the filename id;
 * finalization must not precede creation).
 * Fixed fail-closed codes: `invalid`, `missing`, `incomplete`, `corrupt`,
 * `conflict` (plus `storage_error` for environmental failures). Reads are
 * strictly read-only and repeated reads are deterministic.
 */
export async function recoverReceipt(input: RecoverReceiptInput): Promise<RecoverOutcome> {
	if (!isValidProjectRoot(input.projectRoot)) return { ok: false, kind: "storage_error", reason: "unsafe_dir" };
	let id: string;
	if (input.id !== undefined) {
		if (typeof input.id !== "string" || !RESULT_ID_RE.test(input.id)) return { ok: false, kind: "invalid" };
		id = input.id;
	} else if (isValidIdentity(input.sessionIdentity ?? "", input.toolCallId ?? "")) {
		id = deriveResultId(input.sessionIdentity!, input.toolCallId!);
	} else {
		return { ok: false, kind: "invalid" };
	}
	if (!(await isToolResultsDirContained(input.projectRoot))) return { ok: false, kind: "storage_error", reason: "unsafe_dir" };
	const started = await readArtifact(startedPathFor(input.projectRoot, id));
	const finalized = await readArtifact(finalizedPathFor(input.projectRoot, id));
	if (started.ok === "io_error" || finalized.ok === "io_error") return { ok: false, kind: "storage_error", reason: "read_failed" };
	if (started.ok === "absent" && finalized.ok === "absent") return { ok: false, kind: "missing" };
	if (started.ok === "unsafe" || started.ok === "oversize" || finalized.ok === "unsafe" || finalized.ok === "oversize") {
		return { ok: false, kind: "corrupt" };
	}
	const startedParsed = started.ok === "read" ? parseStartedArtifact(started.raw, id) : null;
	const finalizedParsed = finalized.ok === "read" ? parseFinalizedArtifact(finalized.raw, id) : null;
	if (startedParsed !== null && !startedParsed.ok) return { ok: false, kind: "corrupt" };
	if (finalizedParsed !== null && !finalizedParsed.ok) return { ok: false, kind: "corrupt" };
	if (finalizedParsed !== null) {
		// A finalized artifact without a valid started phase breaks the
		// two-phase invariant — fail closed.
		if (startedParsed === null || !startedParsed.ok) return { ok: false, kind: "corrupt" };
		const s = startedParsed.value;
		const f = finalizedParsed.value;
		if (s.id !== f.id || s.tool !== f.tool || s.input_hash !== f.input_hash || s.created_at !== f.created_at) {
			return { ok: false, kind: "conflict" };
		}
		return { ok: true, kind: "completed", receipt: f };
	}
	if (startedParsed === null || !startedParsed.ok) return { ok: false, kind: "corrupt" };
	return { ok: false, kind: "incomplete", started: startedParsed.value };
}

// ---------------------------------------------------------------------------
// Bounded renderer (project-relative paths only, fixed disclaimer)
// ---------------------------------------------------------------------------

/**
 * Render a recovered receipt as a bounded presentation: durable id,
 * tool/status (plus the bounded error fact on error), the project-relative
 * receipt path, the persisted summary, omission facts, and the fixed
 * disclaimer line. Never renders an absolute project or session path.
 * Global caps (RENDER_MAX_LINES / RENDER_MAX_BYTES) are guaranteed by the
 * strict parse caps; a defensive fallback keeps the render bounded even
 * against a hypothetical non-conforming record.
 */
export function renderReceiptRecovery(projectRoot: string, receipt: FinalizedReceipt): string {
	const lines: string[] = [
		"tool-result receipt (schema wtr1)",
		`id: ${receipt.id}`,
		`tool: ${receipt.tool}`,
		`status: ${receipt.status}`,
	];
	if (receipt.status === "error" && receipt.error !== null) lines.push(`error: ${receipt.error}`);
	lines.push(`receipt path: ${receiptRelativePath(projectRoot, receipt.id)}`, "summary:");
	for (const line of receipt.summary.split("\n")) lines.push(line);
	lines.push(
		`omissions: ${receipt.summary_omitted_lines} line(s), ${receipt.summary_omitted_bytes} byte(s)`,
		RECEIPT_DISCLAIMER,
	);
	const text = lines.join("\n");
	if (utf8ByteLength(text) > RENDER_MAX_BYTES || text.split("\n").length > RENDER_MAX_LINES) {
		return [
			"tool-result receipt (schema wtr1)",
			`id: ${receipt.id}`,
			`tool: ${receipt.tool}`,
			`status: ${receipt.status}`,
			"summary exceeds render bounds",
			RECEIPT_DISCLAIMER,
		].join("\n");
	}
	return text;
}

// ---------------------------------------------------------------------------
// P8b wiring helpers (pure; used by index.ts and the wiring tests)
// ---------------------------------------------------------------------------

/**
 * Short fixed block reason for the `tool_call` guard when beginReceipt did
 * not create a fresh receipt. `completed_replay` carries the durable result
 * id and an explicit instruction to recover; every other fail-closed
 * outcome (incomplete/corrupt/conflict/invalid/storage) blocks execution
 * and never runs the tool.
 */
export function beginBlockReason(outcome: BeginOutcome): string {
	switch (outcome.kind) {
		case "completed_replay":
			return `workbench tool-result receipt replay blocked: result ${outcome.receipt.id} is already finalized — recover it with workbench_recover_tool_result (result_id=${outcome.receipt.id}) and do NOT re-execute this tool call`;
		case "incomplete_replay":
			return `workbench tool-result receipt replay blocked: an incomplete receipt (${outcome.started.id}) exists for this exact tool call — recover it with workbench_recover_tool_result and do NOT re-execute`;
		case "corrupt_receipt":
			return "workbench tool-result receipt replay blocked: the persisted receipt for this tool call is corrupt and fails closed — do NOT re-execute; recover with workbench_recover_tool_result";
		case "identity_conflict":
			return "workbench tool-result receipt replay blocked: receipt identity conflict for this tool call — do NOT re-execute; recover with workbench_recover_tool_result";
		case "invalid_identity":
			return "workbench tool-result receipt identity unavailable: no valid native Pi session id / tool call id in this session — workbench tool calls fail closed without a receipt identity; recover by result_id with workbench_recover_tool_result";
		case "storage_error":
			return "workbench tool-result receipt storage unavailable: the receipt directory is unsafe or unreadable — workbench tool calls fail closed";
		case "created":
			// A fresh `created` outcome never reaches this block helper (the
			// wiring calls beginBlockReason only for non-created outcomes).
			// Compile-time totality: every BeginOutcome kind needs an
			// explicit case — a new kind is a compile error (the switch
			// would lack an ending return). Fail closed rather than claim
			// availability.
			return unexpectedOutcome("beginBlockReason", outcome);
	}
}

/**
 * Bounded fixed `unavailable` code for the tool_result details merge when
 * finalizeReceipt did not finalize (kind verbatim: invalid_handle /
 * missing_started / corrupt_started / identity_conflict /
 * already_finalized / write_error; unexpected exceptions map to
 * storage_error in the wiring). Never claims availability.
 */
export function finalizeUnavailableCode(outcome: FinalizeOutcome): string {
	switch (outcome.kind) {
		case "invalid_handle":
			return "invalid_handle";
		case "missing_started":
			return "missing_started";
		case "corrupt_started":
			return "corrupt_started";
		case "identity_conflict":
			return "identity_conflict";
		case "already_finalized":
			return "already_finalized";
		case "write_error":
			return "write_error";
		case "finalized":
			// A `finalized` success never reaches this unavailable helper
			// (the wiring calls finalizeUnavailableCode only for non-ok
			// outcomes). Compile-time totality: every FinalizeOutcome kind
			// needs an explicit case — a new kind is a compile error (the
			// switch would lack an ending return). Fail closed rather than
			// claim availability.
			return unexpectedOutcome("finalizeUnavailableCode", outcome);
	}
}

/**
 * Fail-closed fallback for the fixed-outcome switches (assertNever-style):
 * every outcome kind is handled by an explicit case, so a new kind is a
 * compile error (the switch would lack an ending return). The success
 * kinds (`created` / `finalized`) are runtime-impossible at the wiring call
 * sites; the fallback throws and can never claim availability.
 */
function unexpectedOutcome(context: string, outcome: BeginOutcome | FinalizeOutcome): never {
	throw new RangeError(`${context}: unexpected outcome ${JSON.stringify(outcome)}`);
}

/**
 * P8b: fixed bounded block reason when the in-memory handle map is already
 * at MAX_IN_FLIGHT_RECEIPTS. A new registered workbench call is blocked
 * BEFORE beginReceipt/execution; existing pending handles are never
 * evicted and nothing is begun for the blocked call.
 */
export function capacityBlockReason(): string {
	return "workbench tool-result receipt capacity blocked: the in-memory receipt handle map is full (MAX_IN_FLIGHT_RECEIPTS) — existing receipts are never evicted; retry after outstanding tool results finalize";
}

/** Fixed one-line explanation per fixed recovery code (bounded). */
const RECOVERY_CODE_TEXT: Readonly<Record<string, string>> = {
	invalid:
		"provide exactly one of result_id (wtr1- followed by 64 lowercase hex) or tool_call_id (a bounded id from the CURRENT native Pi session)",
	missing: "no receipt exists for this id",
	incomplete: "the receipt was started but never finalized — recovery is unavailable",
	corrupt: "the persisted receipt is malformed, unsafe or oversized and fails closed",
	conflict: "the persisted receipt phases disagree — recovery is unavailable",
	storage_error: "the receipt directory is unsafe or unreadable — recovery is unavailable",
};

/** Fixed bounded failure line of the public recovery tool (one line). */
export function recoverFailureText(code: string): string {
	return `tool-result receipt recovery: ${code} — ${RECOVERY_CODE_TEXT[code] ?? "unavailable"}`;
}
