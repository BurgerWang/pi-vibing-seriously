import type { BigIntStats, Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import type { CursorErrorCode, FileSourceSnapshot } from "./continuation-cursor.ts";

export const BOUNDED_FILE_MAX_BYTES = 1_048_576 as const;
/** Absolute ceiling for explicit trusted record readers; callers may only lower it. */
export const BOUNDED_FILE_AUTHORIZED_MAX_BYTES = 4_194_304 as const;
/** Unforgeable capability for the one persisted record contract above 1 MiB. */
export const COMPARISON_RECORD_READ_AUTHORITY: unique symbol = Symbol("comparison-record-read-authority");
export const BOUNDED_PAGE_MAX_BYTES = 32_768 as const;
export const BOUNDED_PAGE_MAX_LINES = 400 as const;

const UTF8_ALIGNMENT_BYTES = 4;

export type BoundedFileErrorCode =
	| CursorErrorCode
	| "invalid_pagination"
	| "source_oversized"
	| "source_not_regular"
	| "io_error"
	| "invalid_utf8"
	| "invalid_json";

export interface BoundedFileError {
	code: BoundedFileErrorCode;
	message: string;
}

export type BoundedFileResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: BoundedFileError };

/** Test instrumentation is opt-in, receives no path/content, and cannot enlarge a read. */
export interface BoundedFileIoHooks {
	afterInitialStat?: (snapshot: Readonly<FileSourceSnapshot>) => void | Promise<void>;
	onBufferAllocate?: (bytes: number) => void;
	beforeRead?: (bytes: number) => void;
	afterRead?: (snapshot: Readonly<FileSourceSnapshot>) => void | Promise<void>;
}

export interface BoundedUtf8File {
	text: string;
	bytes: number;
	source: FileSourceSnapshot;
}

export interface BoundedJsonFile<T = unknown> {
	value: T;
	bytes: number;
	source: FileSourceSnapshot;
}

export interface ReadTextPageOptions {
	startByte?: number;
	lineNumber?: number;
	/** Locate this 1-indexed line on the same open handle before paging. */
	startLine?: number;
	/** Cursor snapshot which must match the handle's first stat. */
	expectedSource?: FileSourceSnapshot;
	/** Reject, rather than silently align, a claimed byte offset. */
	verifyStartByteForLine?: boolean;
	maxBytes: number;
	maxLines: number;
	signal?: AbortSignal;
	hooks?: BoundedFileIoHooks;
}

export interface TextPage {
	text: string;
	requestedStartByte: number;
	startByte: number;
	endExclusive: number;
	shownBytes: number;
	shownLines: number;
	startLineNumber: number;
	nextByteOffset?: number;
	nextLineNumber?: number;
	completeAfter: boolean;
	lineSegment: boolean;
	startsWithinLine: boolean;
	startAligned: boolean;
	source: FileSourceSnapshot;
}

export interface ReadTailPageOptions {
	endExclusive?: number;
	maxBytes: number;
	maxLines: number;
	hooks?: BoundedFileIoHooks;
}

export interface TailPage {
	text: string;
	requestedEndExclusive: number;
	startByte: number;
	endExclusive: number;
	shownBytes: number;
	shownLines: number;
	previousEndExclusive?: number;
	completeBefore: boolean;
	lineSegment: boolean;
	endAligned: boolean;
	source: FileSourceSnapshot;
}

const ERROR_MESSAGES: Readonly<Record<BoundedFileErrorCode, string>> = Object.freeze({
	invalid_cursor: "The continuation cursor is invalid.",
	stale_cursor: "The continuation cursor is stale.",
	source_mismatch: "The continuation cursor belongs to a different source.",
	source_changed_during_read: "The source changed during the bounded read.",
	invalid_pagination: "The bounded pagination request is invalid.",
	source_oversized: "The source exceeds the bounded read limit.",
	source_not_regular: "The source is not a regular file.",
	io_error: "The bounded file read failed.",
	invalid_utf8: "The source is not valid UTF-8.",
	invalid_json: "The source is not valid JSON.",
});

function failure<T>(code: BoundedFileErrorCode): BoundedFileResult<T> {
	return { ok: false, error: { code, message: ERROR_MESSAGES[code] } };
}

function normalizePositiveCap(value: unknown, hardMax: number): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? Math.min(value, hardMax)
		: undefined;
}

function optionalOffset(value: unknown, fallback: number): number | undefined {
	if (value === undefined) return fallback;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalLineNumber(value: unknown): number | undefined {
	if (value === undefined) return 1;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function optionalStartLine(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function safeStatInteger(value: number | bigint): number | undefined {
	if (typeof value === "bigint") {
		return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
	}
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function exactMtime(stats: Stats | BigIntStats): { mtimeMs: number; mtimeNs: string } | undefined {
	const ns = "mtimeNs" in stats && typeof stats.mtimeNs === "bigint"
		? stats.mtimeNs
		: typeof stats.mtimeMs === "number" && Number.isFinite(stats.mtimeMs) && stats.mtimeMs >= 0
			? BigInt(Math.round(stats.mtimeMs * 1_000_000))
			: undefined;
	if (ns === undefined || ns < 0n) return undefined;
	const milliseconds = ns / 1_000_000n;
	if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
	return { mtimeMs: Number(milliseconds), mtimeNs: ns.toString(10) };
}

/** Normalize fs stat facts without discarding the source's sub-millisecond identity. */
export function fileSourceSnapshotFromStats(stats: Stats | BigIntStats): BoundedFileResult<FileSourceSnapshot> {
	try {
		const fileSize = safeStatInteger(stats.size);
		const mtime = exactMtime(stats);
		if (fileSize === undefined || mtime === undefined) return failure("io_error");
		const dev = safeStatInteger(stats.dev);
		const ino = safeStatInteger(stats.ino);
		return {
			ok: true,
			value: {
				fileSize,
				mtimeMs: mtime.mtimeMs,
				mtimeNs: mtime.mtimeNs,
				...(dev === undefined || ino === undefined ? {} : { dev, ino }),
			},
		};
	} catch {
		return failure("io_error");
	}
}

function sameSnapshot(a: FileSourceSnapshot, b: FileSourceSnapshot): boolean {
	return a.fileSize === b.fileSize
		&& a.mtimeMs === b.mtimeMs
		&& a.mtimeNs === b.mtimeNs
		&& a.dev === b.dev
		&& a.ino === b.ino;
}

async function statRegular(handle: FileHandle): Promise<BoundedFileResult<FileSourceSnapshot>> {
	try {
		const stats = await handle.stat({ bigint: true });
		if (!stats.isFile()) return failure("source_not_regular");
		return fileSourceSnapshotFromStats(stats);
	} catch {
		return failure("io_error");
	}
}

async function openForRead(path: string): Promise<BoundedFileResult<FileHandle>> {
	try {
		return { ok: true, value: await open(path, "r") };
	} catch {
		return failure("io_error");
	}
}

function allocateBounded(size: number, hooks?: BoundedFileIoHooks): Buffer {
	hooks?.onBufferAllocate?.(size);
	return Buffer.allocUnsafe(size);
}

async function readExactly(handle: FileHandle, buffer: Buffer, position: number, hooks?: BoundedFileIoHooks): Promise<boolean> {
	try {
		hooks?.beforeRead?.(buffer.length);
		let offset = 0;
		while (offset < buffer.length) {
			const result = await handle.read(buffer, offset, buffer.length - offset, position + offset);
			if (result.bytesRead <= 0) return false;
			offset += result.bytesRead;
		}
		return true;
	} catch {
		return false;
	}
}

async function verifyUnchanged(
	handle: FileHandle,
	initial: FileSourceSnapshot,
	hooks?: BoundedFileIoHooks,
): Promise<BoundedFileResult<FileSourceSnapshot>> {
	try {
		await hooks?.afterRead?.(Object.freeze({ ...initial }));
		const current = await statRegular(handle);
		if (!current.ok) return current;
		return sameSnapshot(initial, current.value) ? current : failure("source_changed_during_read");
	} catch {
		return failure("io_error");
	}
}

async function readWholeBytes(
	path: string,
	maxBytes: number,
	hardCeilingBytes: number,
	hooks?: BoundedFileIoHooks,
): Promise<BoundedFileResult<{ bytes: Buffer; source: FileSourceSnapshot }>> {
	const hardCeiling = normalizePositiveCap(hardCeilingBytes, BOUNDED_FILE_AUTHORIZED_MAX_BYTES);
	const cap = hardCeiling === undefined ? undefined : normalizePositiveCap(maxBytes, hardCeiling);
	if (cap === undefined) return failure("invalid_pagination");
	const opened = await openForRead(path);
	if (!opened.ok) return opened;
	const handle = opened.value;
	try {
		const initial = await statRegular(handle);
		if (!initial.ok) return initial;
		await hooks?.afterInitialStat?.(Object.freeze({ ...initial.value }));
		if (initial.value.fileSize > cap) return failure("source_oversized");
		const buffer = allocateBounded(initial.value.fileSize, hooks);
		if (buffer.length > 0 && !(await readExactly(handle, buffer, 0, hooks))) return failure("io_error");
		const unchanged = await verifyUnchanged(handle, initial.value, hooks);
		if (!unchanged.ok) return unchanged;
		return { ok: true, value: { bytes: buffer, source: unchanged.value } };
	} catch {
		return failure("io_error");
	} finally {
		try { await handle.close(); } catch { /* fixed result already chosen */ }
	}
}

function decodeUtf8(buffer: Uint8Array): BoundedFileResult<string> {
	try {
		return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
	} catch {
		return failure("invalid_utf8");
	}
}

export async function readUtf8FileBounded(path: string, maxBytes: number, hooks?: BoundedFileIoHooks): Promise<BoundedFileResult<BoundedUtf8File>> {
	const read = await readWholeBytes(path, maxBytes, BOUNDED_FILE_MAX_BYTES, hooks);
	if (!read.ok) return read;
	const decoded = decodeUtf8(read.value.bytes);
	if (!decoded.ok) return decoded;
	return { ok: true, value: { text: decoded.value, bytes: read.value.bytes.length, source: read.value.source } };
}

export async function readJsonFileBounded<T = unknown>(path: string, maxBytes: number, hooks?: BoundedFileIoHooks): Promise<BoundedFileResult<BoundedJsonFile<T>>> {
	const read = await readWholeBytes(path, maxBytes, BOUNDED_FILE_MAX_BYTES, hooks);
	if (!read.ok) return read;
	const decoded = decodeUtf8(read.value.bytes);
	if (!decoded.ok) return decoded;
	try {
		return { ok: true, value: { value: JSON.parse(decoded.value) as T, bytes: read.value.bytes.length, source: read.value.source } };
	} catch {
		return failure("invalid_json");
	}
}

/**
 * Whole-file UTF-8 read for a trusted record whose contract intentionally
 * exceeds the generic 1 MiB ceiling. Both the requested cap and the explicit
 * contract ceiling remain clamped by BOUNDED_FILE_AUTHORIZED_MAX_BYTES, so an
 * untrusted numeric argument can never turn this into an unbounded allocation.
 */
export async function readUtf8FileWithExplicitHardCeiling(
	path: string,
	maxBytes: number,
	authority: typeof COMPARISON_RECORD_READ_AUTHORITY,
	hooks?: BoundedFileIoHooks,
): Promise<BoundedFileResult<BoundedUtf8File>> {
	if (authority !== COMPARISON_RECORD_READ_AUTHORITY) return failure("invalid_pagination");
	const read = await readWholeBytes(path, maxBytes, BOUNDED_FILE_AUTHORIZED_MAX_BYTES, hooks);
	if (!read.ok) return read;
	const decoded = decodeUtf8(read.value.bytes);
	if (!decoded.ok) return decoded;
	return { ok: true, value: { text: decoded.value, bytes: read.value.bytes.length, source: read.value.source } };
}

function isContinuationByte(value: number | undefined): boolean {
	return value !== undefined && (value & 0xc0) === 0x80;
}

function sequenceLength(first: number): number {
	if (first <= 0x7f) return 1;
	if (first >= 0xc2 && first <= 0xdf) return 2;
	if (first >= 0xe0 && first <= 0xef) return 3;
	if (first >= 0xf0 && first <= 0xf4) return 4;
	return 0;
}

function validSequence(buffer: Buffer, index: number, length: number): boolean {
	if (length === 1) return true;
	const first = buffer[index];
	const second = buffer[index + 1];
	if (first === undefined || second === undefined || !isContinuationByte(second)) return false;
	if (length >= 3) {
		const third = buffer[index + 2];
		if (!isContinuationByte(third)) return false;
		if (first === 0xe0 && second < 0xa0) return false;
		if (first === 0xed && second > 0x9f) return false;
	}
	if (length === 4) {
		const fourth = buffer[index + 3];
		if (!isContinuationByte(fourth)) return false;
		if (first === 0xf0 && second < 0x90) return false;
		if (first === 0xf4 && second > 0x8f) return false;
	}
	return true;
}

function alignWindowStart(buffer: Buffer, mayStartInsideScalar: boolean): number | undefined {
	if (!mayStartInsideScalar || !isContinuationByte(buffer[0])) return 0;
	let index = 0;
	while (index < buffer.length && index < 3 && isContinuationByte(buffer[index])) index += 1;
	if (index < buffer.length && isContinuationByte(buffer[index])) return undefined;
	return index;
}

interface ParsedUtf8Window {
	end: number;
	boundaries: number[];
}

/** Parse only scalars eligible for the current page; bytes beyond its cap are untouched. */
function parseUtf8Window(
	buffer: Buffer,
	start: number,
	logicalEnd: number,
	logicalEndAbsolute: number,
	fileSize: number,
): BoundedFileResult<ParsedUtf8Window> {
	const boundaries = [start];
	let index = start;
	while (index < logicalEnd) {
		const first = buffer[index];
		if (first === undefined) return failure("io_error");
		const length = sequenceLength(first);
		if (length === 0) return failure("invalid_utf8");
		if (index + length > logicalEnd) {
			if (logicalEndAbsolute === fileSize) return failure("invalid_utf8");
			break;
		}
		if (index + length > buffer.length || !validSequence(buffer, index, length)) return failure("invalid_utf8");
		index += length;
		boundaries.push(index);
	}
	return { ok: true, value: { end: index, boundaries } };
}

function forwardLineBound(buffer: Buffer, start: number, end: number, maxLines: number): number {
	let newlines = 0;
	for (let index = start; index < end; index += 1) {
		if (buffer[index] === 0x0a) {
			newlines += 1;
			if (newlines === maxLines) return index + 1;
		}
	}
	return end;
}

function suffixLineBound(buffer: Buffer, start: number, end: number, maxLines: number): number {
	if (start >= end) return end;
	let newlineCount = 0;
	for (let index = start; index < end; index += 1) if (buffer[index] === 0x0a) newlineCount += 1;
	const trailingNewline = buffer[end - 1] === 0x0a;
	const allowedNewlines = trailingNewline ? maxLines : Math.max(0, maxLines - 1);
	let omit = Math.max(0, newlineCount - allowedNewlines);
	if (omit === 0) return start;
	for (let index = start; index < end; index += 1) {
		if (buffer[index] === 0x0a) {
			omit -= 1;
			if (omit === 0) return index + 1;
		}
	}
	return end;
}

function logicalLines(buffer: Buffer, start: number, end: number): number {
	if (start >= end) return 0;
	let lines = buffer[end - 1] === 0x0a ? 0 : 1;
	for (let index = start; index < end; index += 1) if (buffer[index] === 0x0a) lines += 1;
	return lines;
}

const LINE_SCAN_CHUNK_BYTES = 64 * 1024;

/** Locate a line boundary without retaining the prefix; the caller owns the handle. */
async function locateLineStart(
	handle: FileHandle,
	fileSize: number,
	targetLine: number,
	hooks: BoundedFileIoHooks | undefined,
	signal: AbortSignal | undefined,
): Promise<BoundedFileResult<number>> {
	if (targetLine === 1) return { ok: true, value: 0 };
	let line = 1;
	let position = 0;
	const buffer = allocateBounded(Math.min(LINE_SCAN_CHUNK_BYTES, fileSize), hooks);
	while (position < fileSize) {
		if (signal?.aborted) return failure("io_error");
		const length = Math.min(buffer.length, fileSize - position);
		if (length <= 0) break;
		try {
			hooks?.beforeRead?.(length);
			const { bytesRead } = await handle.read(buffer, 0, length, position);
			if (bytesRead <= 0) return failure("io_error");
			for (let index = 0; index < bytesRead; index += 1) {
				if (buffer[index] !== 0x0a) continue;
				line += 1;
				if (line === targetLine) return { ok: true, value: position + index + 1 };
			}
			position += bytesRead;
		} catch {
			return failure("io_error");
		}
	}
	return failure("invalid_pagination");
}

async function hasNewlineInRange(
	handle: FileHandle,
	start: number,
	endExclusive: number,
	hooks: BoundedFileIoHooks | undefined,
	signal: AbortSignal | undefined,
): Promise<BoundedFileResult<boolean>> {
	if (start >= endExclusive) return { ok: true, value: false };
	const buffer = allocateBounded(Math.min(LINE_SCAN_CHUNK_BYTES, endExclusive - start), hooks);
	let position = start;
	while (position < endExclusive) {
		if (signal?.aborted) return failure("io_error");
		const length = Math.min(buffer.length, endExclusive - position);
		try {
			hooks?.beforeRead?.(length);
			const { bytesRead } = await handle.read(buffer, 0, length, position);
			if (bytesRead <= 0) return failure("io_error");
			for (let index = 0; index < bytesRead; index += 1) {
				if (buffer[index] === 0x0a) return { ok: true, value: true };
			}
			position += bytesRead;
		} catch {
			return failure("io_error");
		}
	}
	return { ok: true, value: false };
}

export async function readTextPage(path: string, options: ReadTextPageOptions): Promise<BoundedFileResult<TextPage>> {
	let maxBytes: number | undefined;
	let maxLines: number | undefined;
	let requestedStart: number | undefined;
	let lineNumber: number | undefined;
	let startLine: number | undefined;
	let expectedSource: FileSourceSnapshot | undefined;
	let verifyStartByteForLine = false;
	let signal: AbortSignal | undefined;
	let startsWithinLine = false;
	let hooks: BoundedFileIoHooks | undefined;
	try {
		maxBytes = normalizePositiveCap(options.maxBytes, BOUNDED_PAGE_MAX_BYTES);
		maxLines = normalizePositiveCap(options.maxLines, BOUNDED_PAGE_MAX_LINES);
		requestedStart = optionalOffset(options.startByte, 0);
		lineNumber = optionalLineNumber(options.lineNumber);
		startLine = optionalStartLine(options.startLine);
		expectedSource = options.expectedSource;
		verifyStartByteForLine = options.verifyStartByteForLine === true;
		signal = options.signal;
		hooks = options.hooks;
	} catch {
		return failure("invalid_pagination");
	}
	if (maxBytes === undefined || maxLines === undefined || requestedStart === undefined || lineNumber === undefined) return failure("invalid_pagination");
	const opened = await openForRead(path);
	if (!opened.ok) return opened;
	const handle = opened.value;
	try {
		const initial = await statRegular(handle);
		if (!initial.ok) return initial;
		await hooks?.afterInitialStat?.(Object.freeze({ ...initial.value }));
		if (expectedSource !== undefined && !sameSnapshot(initial.value, expectedSource)) return failure("stale_cursor");
		if (signal?.aborted) return failure("io_error");
		if (startLine !== undefined) {
			const located = await locateLineStart(handle, initial.value.fileSize, startLine, hooks, signal);
			if (!located.ok) return located;
			requestedStart = located.value;
			lineNumber = startLine;
		} else if (verifyStartByteForLine) {
			const located = await locateLineStart(handle, initial.value.fileSize, lineNumber, hooks, signal);
			if (!located.ok) return located;
			if (located.value > requestedStart) return failure("invalid_cursor");
			startsWithinLine = located.value !== requestedStart;
			const intervening = await hasNewlineInRange(handle, located.value, requestedStart, hooks, signal);
			if (!intervening.ok) return intervening;
			if (intervening.value) return failure("invalid_cursor");
		}
		if (requestedStart > initial.value.fileSize) return failure("invalid_pagination");
		const readLength = Math.min(initial.value.fileSize - requestedStart, maxBytes + UTF8_ALIGNMENT_BYTES);
		const buffer = allocateBounded(readLength, hooks);
		if (readLength > 0 && !(await readExactly(handle, buffer, requestedStart, hooks))) return failure("io_error");
		const unchanged = await verifyUnchanged(handle, initial.value, hooks);
		if (!unchanged.ok) return unchanged;
		const alignedRelative = alignWindowStart(buffer, requestedStart > 0);
		if (alignedRelative === undefined) return failure("invalid_utf8");
		if (alignedRelative !== 0 && verifyStartByteForLine) return failure("invalid_cursor");
		const startByte = requestedStart + alignedRelative;
		const logicalEndRelative = Math.min(buffer.length, alignedRelative + maxBytes);
		const parsed = parseUtf8Window(buffer, alignedRelative, logicalEndRelative, requestedStart + logicalEndRelative, initial.value.fileSize);
		if (!parsed.ok) return parsed;
		const lineEnd = forwardLineBound(buffer, alignedRelative, parsed.value.end, maxLines);
		// A continuation must consume at least one complete UTF-8 scalar. A
		// caller cap smaller than the next scalar is invalid instead of
		// returning an identical cursor forever.
		if (lineEnd <= alignedRelative && startByte < initial.value.fileSize) return failure("invalid_pagination");
		const decoded = decodeUtf8(buffer.subarray(alignedRelative, lineEnd));
		if (!decoded.ok) return decoded;
		const endExclusive = requestedStart + lineEnd;
		const completeAfter = endExclusive >= initial.value.fileSize;
		const newlineCount = buffer.subarray(alignedRelative, lineEnd).reduce((sum, byte) => sum + (byte === 0x0a ? 1 : 0), 0);
		const nextLineNumber = lineNumber + newlineCount;
		return {
			ok: true,
			value: {
				text: decoded.value,
				requestedStartByte: requestedStart,
				startByte,
				endExclusive,
				shownBytes: lineEnd - alignedRelative,
				shownLines: logicalLines(buffer, alignedRelative, lineEnd),
				startLineNumber: lineNumber,
				...(completeAfter ? {} : { nextByteOffset: endExclusive, nextLineNumber }),
				completeAfter,
				lineSegment: !completeAfter && (lineEnd === alignedRelative || buffer[lineEnd - 1] !== 0x0a),
				startsWithinLine,
				startAligned: startByte !== requestedStart,
				source: unchanged.value,
			},
		};
	} catch {
		return failure("io_error");
	} finally {
		try { await handle.close(); } catch { /* fixed result already chosen */ }
	}
}

export async function readTailPage(path: string, options: ReadTailPageOptions): Promise<BoundedFileResult<TailPage>> {
	let maxBytes: number | undefined;
	let maxLines: number | undefined;
	let suppliedEnd: number | undefined;
	let hooks: BoundedFileIoHooks | undefined;
	try {
		maxBytes = normalizePositiveCap(options.maxBytes, BOUNDED_PAGE_MAX_BYTES);
		maxLines = normalizePositiveCap(options.maxLines, BOUNDED_PAGE_MAX_LINES);
		suppliedEnd = options.endExclusive;
		if (suppliedEnd !== undefined && (typeof suppliedEnd !== "number" || !Number.isSafeInteger(suppliedEnd) || suppliedEnd < 0)) return failure("invalid_pagination");
		hooks = options.hooks;
	} catch {
		return failure("invalid_pagination");
	}
	if (maxBytes === undefined || maxLines === undefined) return failure("invalid_pagination");
	const opened = await openForRead(path);
	if (!opened.ok) return opened;
	const handle = opened.value;
	try {
		const initial = await statRegular(handle);
		if (!initial.ok) return initial;
		await hooks?.afterInitialStat?.(Object.freeze({ ...initial.value }));
		const requestedEnd = suppliedEnd ?? initial.value.fileSize;
		if (requestedEnd > initial.value.fileSize) return failure("invalid_pagination");
		const windowStart = Math.max(0, requestedEnd - maxBytes - UTF8_ALIGNMENT_BYTES);
		const readLength = requestedEnd - windowStart;
		const buffer = allocateBounded(readLength, hooks);
		if (readLength > 0 && !(await readExactly(handle, buffer, windowStart, hooks))) return failure("io_error");
		const unchanged = await verifyUnchanged(handle, initial.value, hooks);
		if (!unchanged.ok) return unchanged;
		const alignedRelative = alignWindowStart(buffer, windowStart > 0);
		if (alignedRelative === undefined) return failure("invalid_utf8");
		const parsed = parseUtf8Window(buffer, alignedRelative, buffer.length, requestedEnd, initial.value.fileSize);
		if (!parsed.ok) return parsed;
		const actualEndRelative = parsed.value.end;
		const byteFloor = Math.max(alignedRelative, actualEndRelative - maxBytes);
		let selectedStart = actualEndRelative;
		for (const boundary of parsed.value.boundaries) {
			if (boundary >= byteFloor) { selectedStart = boundary; break; }
		}
		selectedStart = suffixLineBound(buffer, selectedStart, actualEndRelative, maxLines);
		// As with forward pages, a non-empty tail request may not succeed
		// with an empty interval and an unchanged continuation.
		if (selectedStart >= actualEndRelative && requestedEnd > 0) return failure("invalid_pagination");
		const decoded = decodeUtf8(buffer.subarray(selectedStart, actualEndRelative));
		if (!decoded.ok) return decoded;
		const startByte = windowStart + selectedStart;
		const endExclusive = windowStart + actualEndRelative;
		const completeBefore = startByte === 0;
		const priorIsNewline = selectedStart > 0 ? buffer[selectedStart - 1] === 0x0a : startByte === 0;
		return {
			ok: true,
			value: {
				text: decoded.value,
				requestedEndExclusive: requestedEnd,
				startByte,
				endExclusive,
				shownBytes: actualEndRelative - selectedStart,
				shownLines: logicalLines(buffer, selectedStart, actualEndRelative),
				...(completeBefore ? {} : { previousEndExclusive: startByte }),
				completeBefore,
				lineSegment: !completeBefore && !priorIsNewline,
				endAligned: endExclusive !== requestedEnd,
				source: unchanged.value,
			},
		};
	} catch {
		return failure("io_error");
	} finally {
		try { await handle.close(); } catch { /* fixed result already chosen */ }
	}
}
