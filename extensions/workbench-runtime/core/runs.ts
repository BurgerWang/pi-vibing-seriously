/**
 * Workbench run records — run IDs and reading run artifacts. Pure logic.
 *
 * Each run writes to `<project-root>/<CONFIG_DIR_NAME>/workbench/runs/<run-id>/`:
 *   manifest.json, command.json, environment.json, stdout.log, stderr.log,
 *   summary.json
 *
 * Never stores API keys, tokens, or full environment values in these records.
 */

import { open, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { runsDir } from "./config.ts";
import {
	fileSourceSnapshotFromStats,
	readJsonFileBounded,
	readTailPage,
	type BoundedFileErrorCode,
	type BoundedFileIoHooks,
} from "./bounded-file-io.ts";
import {
	computeRunLogSourceId,
	computeRunLogSourceStateId,
	decodeContinuationCursor,
	validateRunLogCursorSource,
	type FileSourceSnapshot,
	type RunLogCursorPayloadV1,
	type RunLogSourceState,
} from "./continuation-cursor.ts";
import type { ValidationComponent } from "./recipe-schema.ts";
import type { ValidationEvidenceBlock } from "./validation-evidence.ts";
import type { CacheRequestMode } from "../cache/action-types.ts";

export const RUN_SCHEMA_VERSION = 1;
/** Run JSON is metadata, never an unbounded model-input channel. */
export const RUN_JSON_INPUT_MAX_BYTES = 1_048_576 as const;

export const RUN_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/;

export function makeRunId(date: Date): string {
	const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
	const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
	return `${stamp}-${rand}`;
}

/** Validate a run id strictly (also protects against path traversal). */
export function isValidRunId(runId: string): boolean {
	return RUN_ID_RE.test(runId);
}

export function runDirFor(projectRoot: string, runId: string): string {
	if (!isValidRunId(runId)) throw new Error(`invalid run id "${runId}"`);
	return join(runsDir(projectRoot), runId);
}

export interface RunRecord {
	schema_version: number;
	run_id: string;
	recipe: string;
	profile: string | undefined;
	started_at: string;
	finished_at: string;
	duration_ms: number;
	cwd: string;
	argv: string[];
	exit_code: number | null;
	timed_out: boolean;
	cancelled: boolean;
	git_commit: string | null;
	git_dirty: boolean;
	artifact_paths: string[];
	stdout_truncated: boolean;
	stderr_truncated: boolean;
	mode: string;
	expected_exit_codes: number[];
	declared_writes: string[];
	environment_names: string[];
	/**
	 * Phase 2A: the recipe's declared validation components (closed set:
	 * typecheck | unit-test | whitespace) — the exact recipe declaration,
	 * required on every manifest.
	 */
	validation_components: ValidationComponent[];
	/**
	 * P6-C: cache request mode of this run. "default" reads/writes per the
	 * recipe cache policy; "no-cache" never touches the cache;
	 * "refresh-cache" never reads but rewrites on success. Cache-hit
	 * materialized runs are always "default" — only default mode reads hits.
	 */
	cache_request_mode: CacheRequestMode;
	/** P6-C: how this run was produced. Absent = executed normally. */
	execution_source?: "exec" | "cache";
	/** P6-C: action key when execution_source === "cache". */
	action_key?: string;
	/** P6-C: hash of the executed argv (values are never stored); set for
	 * exec runs (executed-argv hash) and cache hits (action-key argv hash). */
	argv_hash?: string;
	/** P6-C: the run whose cached result was reused. */
	reused_from_run_id?: string;
	/** P6-C: when the cached result was produced / re-validated. */
	cache_created_at?: string;
	cache_validated_at?: string;
	/** P6-C: artifact restore/verification facts of a cached run. */
	artifact_validation?: {
		mode: string;
		artifacts_restored: boolean;
		hash_verified: boolean;
		status: string;
	};
	/** P6-D: quant contract facts of a cached quant-domain run. */
	quant_contract?: {
		type: string;
		manifest: string;
		immutable_key: string;
		validation_status: string;
		logical_reference: string | null;
		resolved_reference: string | null;
		warnings: string[];
	};
	/** P6-C: evidence locations recorded for this run. */
	evidence_paths?: string[];
	/**
	 * P4a: schema-versioned validation-evidence block. Absent on legacy v1
	 * records (still parseable — comparison then refuses reuse with
	 * missing-binding); a binding is present only when capture succeeded,
	 * otherwise a bounded unavailable_reason marks the record explicitly
	 * non-reusable.
	 */
	validation_evidence?: ValidationEvidenceBlock;
}

export async function readManifest(projectRoot: string, runId: string): Promise<RunRecord | null> {
	const dir = runDirFor(projectRoot, runId);
	try {
		const read = await readJsonFileBounded<RunRecord>(join(dir, "manifest.json"), RUN_JSON_INPUT_MAX_BYTES);
		if (!read.ok) return null;
		const parsed = read.value.value;
		return parsed.schema_version === RUN_SCHEMA_VERSION ? parsed : null;
	} catch {
		return null;
	}
}

export interface RunSummaryRecord {
	run_id: string;
	recipe: string;
	profile: string | undefined;
	started_at: string;
	finished_at: string;
	duration_ms: number;
	cwd: string;
	argv: string[];
	exit_code: number | null;
	timed_out: boolean;
	cancelled: boolean;
	git_commit: string | null;
	git_dirty: boolean;
	artifact_paths: string[];
	stdout_truncated: boolean;
	stderr_truncated: boolean;
	stdout: string;
	stderr: string;
	stdout_log: string;
	stderr_log: string;
}

export async function readSummary(projectRoot: string, runId: string): Promise<RunSummaryRecord | null> {
	const dir = runDirFor(projectRoot, runId);
	try {
		const read = await readJsonFileBounded<RunSummaryRecord>(join(dir, "summary.json"), RUN_JSON_INPUT_MAX_BYTES);
		return read.ok ? read.value.value : null;
	} catch {
		return null;
	}
}

/** List runs newest-first, optionally capped. */
export async function listRuns(projectRoot: string, limit = 10): Promise<RunRecord[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(runsDir(projectRoot), { withFileTypes: true });
	} catch {
		return [];
	}
	const records: RunRecord[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
		const manifest = await readManifest(projectRoot, entry.name);
		if (manifest) records.push(manifest);
	}
	records.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
	return records.slice(0, limit);
}

export interface LogSnippetOptions {
	maxLines?: number;
	maxBytes?: number;
}

export const DEFAULT_SNIPPET_LINES = 200;
export const DEFAULT_SNIPPET_BYTES = 20 * 1024;
export const RUN_LOG_MAX_LINES = 400 as const;
export const RUN_LOG_MAX_BYTES = 32_768 as const;
export const RUN_LOG_MIN_BYTES = 1_024 as const;

export type RunLogSelection = "stdout" | "stderr" | "both";
export type RunLogStreamName = "stdout" | "stderr";
export type RunLogStreamState = "missing" | "empty" | "content";

export interface RunLogPageStream {
	stream: RunLogStreamName;
	path: string;
	state: RunLogStreamState;
	text: string;
	startByte: number;
	endExclusive: number;
	fileSize: number;
	shownBytes: number;
	shownLines: number;
	completeBefore: boolean;
	lineSegment: boolean;
}

export interface RunLogPage {
	runId: string;
	selection: RunLogSelection;
	sourceId: string;
	sourceStateId: string;
	stdout: RunLogPageStream;
	stderr: RunLogPageStream;
	maxBytes: number;
	maxLines: number;
}

export type RunLogPageErrorCode = BoundedFileErrorCode;
export type RunLogPageResult =
	| { ok: true; value: RunLogPage }
	| { ok: false; error: { code: RunLogPageErrorCode; message: string } };

export interface ReadRunLogPageOptions {
	logStream?: RunLogSelection;
	cursor?: string;
	maxBytes?: number;
	maxLines?: number;
	/** Failed/timed-out/cancelled/killed runs give stderr the 60% share. */
	preferStderr?: boolean;
	hooks?: Partial<Record<RunLogStreamName, BoundedFileIoHooks>>;
}

const RUN_LOG_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
	invalid_cursor: "The run-log cursor is invalid.",
	stale_cursor: "The run-log cursor is stale.",
	source_mismatch: "The run-log cursor belongs to a different run or stream selection.",
	source_changed_during_read: "A run log changed during the bounded read.",
	invalid_pagination: "The run-log pagination request is invalid.",
	source_oversized: "The run log exceeds the bounded input limit.",
	source_not_regular: "A run log is not a regular file.",
	io_error: "The bounded run-log read failed.",
	invalid_utf8: "A run log is not valid UTF-8.",
	invalid_json: "The run-log source is not valid JSON.",
});

function runLogFailure(code: RunLogPageErrorCode): RunLogPageResult {
	return { ok: false, error: { code, message: RUN_LOG_ERROR_MESSAGES[code] ?? "The bounded run-log read failed." } };
}

function exactSnapshot(a: FileSourceSnapshot | null, b: FileSourceSnapshot | null): boolean {
	if (a === null || b === null) return a === b;
	return a.fileSize === b.fileSize && a.mtimeMs === b.mtimeMs && a.mtimeNs === b.mtimeNs && a.dev === b.dev && a.ino === b.ino;
}

async function snapshotLog(path: string): Promise<{ ok: true; value: FileSourceSnapshot | null } | { ok: false }> {
	let handle;
	try {
		handle = await open(path, "r");
		const stats = await handle.stat({ bigint: true });
		if (!stats.isFile()) return { ok: false };
		const snapshot = fileSourceSnapshotFromStats(stats);
		return snapshot.ok ? { ok: true, value: snapshot.value } : { ok: false };
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { ok: true, value: null } : { ok: false };
	} finally {
		try { await handle?.close(); } catch { /* read-only snapshot already failed/succeeded */ }
	}
}

async function snapshotPair(stdoutPath: string, stderrPath: string): Promise<{ ok: true; value: RunLogSourceState } | { ok: false }> {
	const [stdout, stderr] = await Promise.all([snapshotLog(stdoutPath), snapshotLog(stderrPath)]);
	if (!stdout.ok || !stderr.ok) return { ok: false };
	return { ok: true, value: { stdout: stdout.value, stderr: stderr.value } };
}

function normalizedInt(value: unknown, fallback: number, min: number, max: number): number | undefined {
	if (value === undefined) return fallback;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function emptyStream(stream: RunLogStreamName, path: string, snapshot: FileSourceSnapshot | null): RunLogPageStream {
	return {
		stream,
		path,
		state: snapshot === null ? "missing" : snapshot.fileSize === 0 ? "empty" : "content",
		text: "",
		startByte: 0,
		endExclusive: 0,
		fileSize: snapshot?.fileSize ?? 0,
		shownBytes: 0,
		shownLines: 0,
		completeBefore: true,
		lineSegment: false,
	};
}

async function pageOne(input: {
	stream: RunLogStreamName;
	path: string;
	snapshot: FileSourceSnapshot | null;
	endExclusive: number;
	maxBytes: number;
	maxLines: number;
	hooks?: BoundedFileIoHooks;
}): Promise<RunLogPageResult | RunLogPageStream> {
	if (input.snapshot === null || input.snapshot.fileSize === 0 || input.endExclusive === 0) return emptyStream(input.stream, input.path, input.snapshot);
	const page = await readTailPage(input.path, {
		endExclusive: input.endExclusive,
		maxBytes: Math.max(1, input.maxBytes),
		maxLines: Math.max(1, input.maxLines),
		...(input.hooks ? { hooks: input.hooks } : {}),
	});
	if (!page.ok) return runLogFailure(page.error.code);
	if (!exactSnapshot(input.snapshot, page.value.source)) return runLogFailure("source_changed_during_read");
	return {
		stream: input.stream,
		path: input.path,
		state: "content",
		text: page.value.text,
		startByte: page.value.startByte,
		endExclusive: page.value.endExclusive,
		fileSize: page.value.source.fileSize,
		shownBytes: page.value.shownBytes,
		shownLines: page.value.shownLines,
		completeBefore: page.value.completeBefore,
		lineSegment: page.value.lineSegment,
	};
}

function isPageFailure(value: RunLogPageResult | RunLogPageStream): value is Extract<RunLogPageResult, { ok: false }> {
	return "ok" in value && value.ok === false;
}

/**
 * Seek-based, shared-budget reverse page over stdout/stderr. The function
 * allocates at most maxBytes plus a four-byte UTF-8 alignment window per
 * stream, validates one combined cursor state, and performs at most one
 * bounded redistribution reread when a stream cannot use its share.
 */
export async function readRunLogPage(projectRoot: string, runId: string, options: ReadRunLogPageOptions = {}): Promise<RunLogPageResult> {
	const selection = options.logStream ?? "both";
	const maxBytes = normalizedInt(options.maxBytes, DEFAULT_SNIPPET_BYTES, 1, RUN_LOG_MAX_BYTES);
	const maxLines = normalizedInt(options.maxLines, DEFAULT_SNIPPET_LINES, 1, RUN_LOG_MAX_LINES);
	if ((selection !== "stdout" && selection !== "stderr" && selection !== "both") || maxBytes === undefined || maxLines === undefined) {
		return runLogFailure("invalid_pagination");
	}
	const dir = runDirFor(projectRoot, runId);
	const stdoutPath = join(dir, "stdout.log");
	const stderrPath = join(dir, "stderr.log");
	const before = await snapshotPair(stdoutPath, stderrPath);
	if (!before.ok) return runLogFailure("io_error");
	const sourceId = computeRunLogSourceId(runId, selection);
	const sourceStateId = computeRunLogSourceStateId(before.value);
	if (!sourceId.ok || !sourceStateId.ok) return runLogFailure("invalid_cursor");

	let cursorPayload: RunLogCursorPayloadV1 | undefined;
	if (options.cursor !== undefined) {
		const decoded = decodeContinuationCursor(options.cursor);
		if (!decoded.ok) return runLogFailure(decoded.error.code);
		const valid = validateRunLogCursorSource({ payload: decoded.value, expectedSourceId: sourceId.value, currentSourceStateId: sourceStateId.value });
		if (!valid.ok) return runLogFailure(valid.error.code);
		cursorPayload = valid.value;
	}
	const endFor = (stream: RunLogStreamName): number => {
		if ((selection === "stdout" && stream === "stderr") || (selection === "stderr" && stream === "stdout")) return 0;
		const fromCursor = stream === "stdout" ? cursorPayload?.stdoutEndExclusive : cursorPayload?.stderrEndExclusive;
		return fromCursor ?? before.value[stream]?.fileSize ?? 0;
	};
	const stdoutEnd = endFor("stdout");
	const stderrEnd = endFor("stderr");
	if (stdoutEnd > (before.value.stdout?.fileSize ?? 0) || stderrEnd > (before.value.stderr?.fileSize ?? 0)) return runLogFailure("invalid_cursor");

	const only = selection === "stdout" || selection === "stderr";
	const stderrShare = options.preferStderr === true ? 0.6 : 0.5;
	const stdoutByteCap = only ? (selection === "stdout" ? maxBytes : 0) : Math.floor(maxBytes * (1 - stderrShare));
	const stderrByteCap = only ? (selection === "stderr" ? maxBytes : 0) : maxBytes - stdoutByteCap;
	const stdoutLineCap = only ? (selection === "stdout" ? maxLines : 0) : Math.floor(maxLines * (1 - stderrShare));
	const stderrLineCap = only ? (selection === "stderr" ? maxLines : 0) : maxLines - stdoutLineCap;

	let stdout: RunLogPageStream = emptyStream("stdout", stdoutPath, before.value.stdout);
	let stderr: RunLogPageStream = emptyStream("stderr", stderrPath, before.value.stderr);
	if (stdoutByteCap > 0 && stdoutLineCap > 0) {
		const page = await pageOne({ stream: "stdout", path: stdoutPath, snapshot: before.value.stdout, endExclusive: stdoutEnd, maxBytes: stdoutByteCap, maxLines: stdoutLineCap, hooks: options.hooks?.stdout });
		if (isPageFailure(page)) return page;
		stdout = page as RunLogPageStream;
	}
	if (stderrByteCap > 0 && stderrLineCap > 0) {
		const page = await pageOne({ stream: "stderr", path: stderrPath, snapshot: before.value.stderr, endExclusive: stderrEnd, maxBytes: stderrByteCap, maxLines: stderrLineCap, hooks: options.hooks?.stderr });
		if (isPageFailure(page)) return page;
		stderr = page as RunLogPageStream;
	}

	// One deterministic bounded redistribution: an under-used share is lent
	// to the other, still from the same cursor endpoint and under global caps.
	if (selection === "both") {
		const target = options.preferStderr === true
			? (!stderr.completeBefore ? "stderr" : !stdout.completeBefore ? "stdout" : undefined)
			: (!stdout.completeBefore ? "stdout" : !stderr.completeBefore ? "stderr" : undefined);
		const lentBytes = target === "stdout"
			? Math.max(0, stderrByteCap - stderr.shownBytes)
			: target === "stderr" ? Math.max(0, stdoutByteCap - stdout.shownBytes) : 0;
		const lentLines = target === "stdout"
			? Math.max(0, stderrLineCap - stderr.shownLines)
			: target === "stderr" ? Math.max(0, stdoutLineCap - stdout.shownLines) : 0;
		if (target && (lentBytes > 0 || lentLines > 0)) {
			const originalByteCap = target === "stdout" ? stdoutByteCap : stderrByteCap;
			const originalLineCap = target === "stdout" ? stdoutLineCap : stderrLineCap;
			const page = await pageOne({
				stream: target,
				path: target === "stdout" ? stdoutPath : stderrPath,
				snapshot: before.value[target],
				endExclusive: target === "stdout" ? stdoutEnd : stderrEnd,
				maxBytes: Math.min(maxBytes, originalByteCap + lentBytes),
				maxLines: Math.min(maxLines, originalLineCap + lentLines),
				hooks: options.hooks?.[target],
			});
			if (isPageFailure(page)) return page;
			if (target === "stdout") stdout = page as RunLogPageStream;
			else stderr = page as RunLogPageStream;
		}
	}

	const after = await snapshotPair(stdoutPath, stderrPath);
	if (!after.ok || !exactSnapshot(before.value.stdout, after.value.stdout) || !exactSnapshot(before.value.stderr, after.value.stderr)) {
		return runLogFailure("source_changed_during_read");
	}
	if (stdout.shownBytes + stderr.shownBytes > maxBytes || stdout.shownLines + stderr.shownLines > maxLines) return runLogFailure("invalid_pagination");
	return { ok: true, value: { runId, selection, sourceId: sourceId.value, sourceStateId: sourceStateId.value, stdout, stderr, maxBytes, maxLines } };
}

/**
 * Read a bounded tail of a run log — never the full log — for model/UI
 * display. The full log stays on disk at the returned path.
 */
export async function readLogSnippet(
	projectRoot: string,
	runId: string,
	stream: "stdout" | "stderr",
	options?: LogSnippetOptions,
): Promise<{ content: string; truncated: boolean; path: string }> {
	const path = join(runDirFor(projectRoot, runId), `${stream}.log`);
	const result = await readRunLogPage(projectRoot, runId, {
		logStream: stream,
		maxLines: Math.min(RUN_LOG_MAX_LINES, Math.max(1, Math.floor(options?.maxLines ?? DEFAULT_SNIPPET_LINES))),
		maxBytes: Math.min(RUN_LOG_MAX_BYTES, Math.max(1, Math.floor(options?.maxBytes ?? DEFAULT_SNIPPET_BYTES))),
	});
	if (!result.ok) return { content: "", truncated: false, path };
	const page = result.value[stream];
	return { content: page.text, truncated: !page.completeBefore, path };
}
