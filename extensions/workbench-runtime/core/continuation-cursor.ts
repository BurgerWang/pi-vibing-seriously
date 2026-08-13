import { createHash } from "node:crypto";

export const CONTINUATION_CURSOR_PREFIX = "wbcur1" as const;
export const CONTINUATION_CURSOR_V2_PREFIX = "wbcur2" as const;
export const CONTINUATION_CURSOR_MAX_CHARS = 1_024 as const;

const HEX_64 = /^[0-9a-f]{64}$/;
const CHECKSUM_HEX = /^[0-9a-f]{16}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const NANOSECONDS_DECIMAL = /^(?:0|[1-9][0-9]{0,31})$/;
const MAX_SOURCE_COMPONENT_CHARS = 512;
const MAX_FILE_LOGICAL_LOCATOR_BYTES = 32_768;

export type CursorErrorCode =
	| "invalid_cursor"
	| "stale_cursor"
	| "source_mismatch"
	| "source_changed_during_read";

export interface CursorError {
	code: CursorErrorCode;
	message: string;
}

export type CursorResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: CursorError };

export interface LegacyFileSourceSnapshot {
	fileSize: number;
	mtimeMs: number;
	dev?: number;
	ino?: number;
}

/**
 * High-resolution snapshots keep the legacy millisecond fact for diagnostics
 * and add the exact bigint-stat nanoseconds as a canonical decimal string.
 * A string is required because current epoch nanoseconds exceed JS safe ints.
 */
export interface FileSourceSnapshot extends LegacyFileSourceSnapshot {
	mtimeNs?: string;
}

export interface FileCursorPayloadV1 extends LegacyFileSourceSnapshot {
	v: 1;
	kind: "read" | "gate-read";
	sourceId: string;
	byteOffset: number;
	lineNumber: number;
}

/**
 * File cursors minted from bigint fs stats use v2/wbcur2. Legacy wbcur1
 * decoding stays exact and canonical, but validation fails stale when the
 * current source has `mtimeNs` because v1 cannot prove that stronger identity.
 */
export interface FileCursorPayloadV2 extends FileSourceSnapshot {
	v: 2;
	kind: "read" | "gate-read";
	sourceId: string;
	byteOffset: number;
	lineNumber: number;
	mtimeNs: string;
}

export type FileCursorPayload = FileCursorPayloadV1 | FileCursorPayloadV2;

/**
 * A run-log cursor deliberately contains logical and state identities rather
 * than a path. The two stream offsets are always present; an unused stream is
 * represented by zero so each kind has one exact, canonical field set.
 */
export interface RunLogCursorPayloadV1 {
	v: 1;
	kind: "run-log";
	sourceId: string;
	sourceStateId: string;
	stdoutEndExclusive: number;
	stderrEndExclusive: number;
}

export type CursorPayloadV1 = FileCursorPayloadV1 | RunLogCursorPayloadV1;
export type CursorPayload = FileCursorPayload | RunLogCursorPayloadV1;
export type RunLogStream = "stdout" | "stderr" | "both";

const ERROR_MESSAGES: Readonly<Record<CursorErrorCode, string>> = Object.freeze({
	invalid_cursor: "The continuation cursor is invalid.",
	stale_cursor: "The continuation cursor is stale.",
	source_mismatch: "The continuation cursor belongs to a different source.",
	source_changed_during_read: "The source changed during the bounded read.",
});

function failure<T>(code: CursorErrorCode): CursorResult<T> {
	return { ok: false, error: { code, message: ERROR_MESSAGES[code] } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isSourceId(value: unknown): value is string {
	return typeof value === "string" && HEX_64.test(value);
}

function isNanosecondsDecimal(value: unknown): value is string {
	return typeof value === "string" && NANOSECONDS_DECIMAL.test(value);
}

function readFilePayload(value: Record<string, unknown>): FileCursorPayloadV1 | undefined {
	const withoutDevice = ["v", "kind", "sourceId", "byteOffset", "lineNumber", "fileSize", "mtimeMs"] as const;
	const withDevice = [...withoutDevice, "dev", "ino"] as const;
	const exactPortable = hasExactKeys(value, withoutDevice);
	const exactDevice = hasExactKeys(value, withDevice);
	if (!exactPortable && !exactDevice) return undefined;
	if (value.v !== 1 || (value.kind !== "read" && value.kind !== "gate-read")) return undefined;
	if (!isSourceId(value.sourceId) || !isNonNegativeSafeInteger(value.byteOffset) || !isPositiveSafeInteger(value.lineNumber)) return undefined;
	if (!isNonNegativeSafeInteger(value.fileSize) || !isNonNegativeSafeInteger(value.mtimeMs)) return undefined;
	if (value.byteOffset > value.fileSize) return undefined;
	if (exactDevice && (!isNonNegativeSafeInteger(value.dev) || !isNonNegativeSafeInteger(value.ino))) return undefined;
	return {
		v: 1,
		kind: value.kind,
		sourceId: value.sourceId,
		byteOffset: value.byteOffset,
		lineNumber: value.lineNumber,
		fileSize: value.fileSize,
		mtimeMs: value.mtimeMs,
		...(exactDevice ? { dev: value.dev as number, ino: value.ino as number } : {}),
	};
}

function readFilePayloadV2(value: Record<string, unknown>): FileCursorPayloadV2 | undefined {
	const withoutDevice = ["v", "kind", "sourceId", "byteOffset", "lineNumber", "fileSize", "mtimeMs", "mtimeNs"] as const;
	const withDevice = [...withoutDevice, "dev", "ino"] as const;
	const exactPortable = hasExactKeys(value, withoutDevice);
	const exactDevice = hasExactKeys(value, withDevice);
	if (!exactPortable && !exactDevice) return undefined;
	if (value.v !== 2 || (value.kind !== "read" && value.kind !== "gate-read")) return undefined;
	if (!isSourceId(value.sourceId) || !isNonNegativeSafeInteger(value.byteOffset) || !isPositiveSafeInteger(value.lineNumber)) return undefined;
	if (!isNonNegativeSafeInteger(value.fileSize) || !isNonNegativeSafeInteger(value.mtimeMs) || !isNanosecondsDecimal(value.mtimeNs)) return undefined;
	if (value.byteOffset > value.fileSize) return undefined;
	if (exactDevice && (!isNonNegativeSafeInteger(value.dev) || !isNonNegativeSafeInteger(value.ino))) return undefined;
	return {
		v: 2,
		kind: value.kind,
		sourceId: value.sourceId,
		byteOffset: value.byteOffset,
		lineNumber: value.lineNumber,
		fileSize: value.fileSize,
		mtimeMs: value.mtimeMs,
		mtimeNs: value.mtimeNs,
		...(exactDevice ? { dev: value.dev as number, ino: value.ino as number } : {}),
	};
}

function readRunLogPayload(value: Record<string, unknown>): RunLogCursorPayloadV1 | undefined {
	const keys = ["v", "kind", "sourceId", "sourceStateId", "stdoutEndExclusive", "stderrEndExclusive"] as const;
	if (!hasExactKeys(value, keys) || value.v !== 1 || value.kind !== "run-log") return undefined;
	if (!isSourceId(value.sourceId) || !isSourceId(value.sourceStateId)) return undefined;
	if (!isNonNegativeSafeInteger(value.stdoutEndExclusive) || !isNonNegativeSafeInteger(value.stderrEndExclusive)) return undefined;
	return {
		v: 1,
		kind: "run-log",
		sourceId: value.sourceId,
		sourceStateId: value.sourceStateId,
		stdoutEndExclusive: value.stdoutEndExclusive,
		stderrEndExclusive: value.stderrEndExclusive,
	};
}

function normalizeVersionedPayload(value: unknown): CursorPayload | undefined {
	if (!isPlainRecord(value)) return undefined;
	if (value.kind === "run-log") return readRunLogPayload(value);
	return value.v === 2 ? readFilePayloadV2(value) : readFilePayload(value);
}

function canonicalPayloadJson(payload: CursorPayload): string {
	if (payload.kind === "run-log") {
		return JSON.stringify({
			v: 1,
			kind: payload.kind,
			sourceId: payload.sourceId,
			sourceStateId: payload.sourceStateId,
			stdoutEndExclusive: payload.stdoutEndExclusive,
			stderrEndExclusive: payload.stderrEndExclusive,
		});
	}
	if (payload.v === 2) {
		return JSON.stringify({
			v: 2,
			kind: payload.kind,
			sourceId: payload.sourceId,
			byteOffset: payload.byteOffset,
			lineNumber: payload.lineNumber,
			fileSize: payload.fileSize,
			mtimeMs: payload.mtimeMs,
			mtimeNs: payload.mtimeNs,
			...(payload.dev === undefined ? {} : { dev: payload.dev, ino: payload.ino }),
		});
	}
	return JSON.stringify({
		v: 1,
		kind: payload.kind,
		sourceId: payload.sourceId,
		byteOffset: payload.byteOffset,
		lineNumber: payload.lineNumber,
		fileSize: payload.fileSize,
		mtimeMs: payload.mtimeMs,
		...(payload.dev === undefined ? {} : { dev: payload.dev, ino: payload.ino }),
	});
}

function checksum(prefixAndPayload: string): string {
	return createHash("sha256").update(prefixAndPayload, "utf8").digest("hex").slice(0, 16);
}

export function encodeContinuationCursor(input: unknown): CursorResult<string> {
	try {
		const payload = normalizeVersionedPayload(input);
		if (!payload) return failure("invalid_cursor");
		const payloadSegment = Buffer.from(canonicalPayloadJson(payload), "utf8").toString("base64url");
		const prefix = payload.kind !== "run-log" && payload.v === 2
			? CONTINUATION_CURSOR_V2_PREFIX
			: CONTINUATION_CURSOR_PREFIX;
		const signed = `${prefix}.${payloadSegment}`;
		const cursor = `${signed}.${checksum(signed)}`;
		return cursor.length <= CONTINUATION_CURSOR_MAX_CHARS ? { ok: true, value: cursor } : failure("invalid_cursor");
	} catch {
		return failure("invalid_cursor");
	}
}

export function decodeContinuationCursor(input: unknown): CursorResult<CursorPayload> {
	try {
		if (typeof input !== "string" || input.length === 0 || input.length > CONTINUATION_CURSOR_MAX_CHARS) return failure("invalid_cursor");
		const parts = input.split(".");
		if (parts.length !== 3 || (parts[0] !== CONTINUATION_CURSOR_PREFIX && parts[0] !== CONTINUATION_CURSOR_V2_PREFIX)) return failure("invalid_cursor");
		const payloadSegment = parts[1];
		const suppliedChecksum = parts[2];
		if (!payloadSegment || !BASE64URL.test(payloadSegment) || !suppliedChecksum || !CHECKSUM_HEX.test(suppliedChecksum)) return failure("invalid_cursor");
		const signed = `${parts[0]}.${payloadSegment}`;
		if (checksum(signed) !== suppliedChecksum) return failure("invalid_cursor");
		const decoded = Buffer.from(payloadSegment, "base64url");
		if (decoded.toString("base64url") !== payloadSegment) return failure("invalid_cursor");
		const json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
		const parsed: unknown = JSON.parse(json);
		const payload = normalizeVersionedPayload(parsed);
		const expectedPrefix = payload?.kind !== "run-log" && payload?.v === 2
			? CONTINUATION_CURSOR_V2_PREFIX
			: CONTINUATION_CURSOR_PREFIX;
		if (!payload || parts[0] !== expectedPrefix || canonicalPayloadJson(payload) !== json) return failure("invalid_cursor");
		return { ok: true, value: payload };
	} catch {
		return failure("invalid_cursor");
	}
}

function validSnapshot(value: unknown): value is FileSourceSnapshot {
	if (!isPlainRecord(value)) return false;
	const portableV1 = hasExactKeys(value, ["fileSize", "mtimeMs"]);
	const deviceV1 = hasExactKeys(value, ["fileSize", "mtimeMs", "dev", "ino"]);
	const portableV2 = hasExactKeys(value, ["fileSize", "mtimeMs", "mtimeNs"]);
	const deviceV2 = hasExactKeys(value, ["fileSize", "mtimeMs", "mtimeNs", "dev", "ino"]);
	return (portableV1 || deviceV1 || portableV2 || deviceV2)
		&& isNonNegativeSafeInteger(value.fileSize)
		&& isNonNegativeSafeInteger(value.mtimeMs)
		&& (!(portableV2 || deviceV2) || isNanosecondsDecimal(value.mtimeNs))
		&& (!(deviceV1 || deviceV2) || (isNonNegativeSafeInteger(value.dev) && isNonNegativeSafeInteger(value.ino)));
}

function canonicalSnapshot(snapshot: FileSourceSnapshot): string {
	return JSON.stringify({
		fileSize: snapshot.fileSize,
		mtimeMs: snapshot.mtimeMs,
		...(snapshot.mtimeNs === undefined ? {} : { mtimeNs: snapshot.mtimeNs }),
		...(snapshot.dev === undefined ? {} : { dev: snapshot.dev, ino: snapshot.ino }),
	});
}

function sameSnapshot(a: FileSourceSnapshot, b: FileSourceSnapshot): boolean {
	return a.fileSize === b.fileSize
		&& a.mtimeMs === b.mtimeMs
		&& a.mtimeNs === b.mtimeNs
		&& a.dev === b.dev
		&& a.ino === b.ino;
}

export function validateSourceSnapshot(expected: unknown, current: unknown): CursorResult<FileSourceSnapshot> {
	try {
		if (!validSnapshot(expected) || !validSnapshot(current)) return failure("stale_cursor");
		return sameSnapshot(expected, current) ? { ok: true, value: current } : failure("stale_cursor");
	} catch {
		return failure("stale_cursor");
	}
}

export function validateFileCursorSource(input: {
	payload: unknown;
	expectedKind: "read" | "gate-read";
	expectedSourceId: string;
	currentSnapshot: unknown;
}): CursorResult<FileCursorPayload> {
	try {
		const payload = normalizeVersionedPayload(input.payload);
		if (!payload || payload.kind === "run-log" || payload.kind !== input.expectedKind) return failure("invalid_cursor");
		if (!isSourceId(input.expectedSourceId) || payload.sourceId !== input.expectedSourceId) return failure("source_mismatch");
		const expected: FileSourceSnapshot = {
			fileSize: payload.fileSize,
			mtimeMs: payload.mtimeMs,
			...(payload.v === 2 ? { mtimeNs: payload.mtimeNs } : {}),
			...(payload.dev === undefined ? {} : { dev: payload.dev, ino: payload.ino }),
		};
		if (!validateSourceSnapshot(expected, input.currentSnapshot).ok) return failure("stale_cursor");
		return { ok: true, value: payload };
	} catch {
		return failure("invalid_cursor");
	}
}

export function validateRunLogCursorSource(input: {
	payload: unknown;
	expectedSourceId: string;
	currentSourceStateId: string;
}): CursorResult<RunLogCursorPayloadV1> {
	try {
		const payload = normalizeVersionedPayload(input.payload);
		if (!payload || payload.kind !== "run-log") return failure("invalid_cursor");
		if (!isSourceId(input.expectedSourceId) || payload.sourceId !== input.expectedSourceId) return failure("source_mismatch");
		if (!isSourceId(input.currentSourceStateId) || payload.sourceStateId !== input.currentSourceStateId) return failure("stale_cursor");
		return { ok: true, value: payload };
	} catch {
		return failure("invalid_cursor");
	}
}

function boundedIdentityComponent(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_SOURCE_COMPONENT_CHARS;
}

function boundedFileLogicalLocator(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& Buffer.byteLength(value, "utf8") <= MAX_FILE_LOGICAL_LOCATOR_BYTES;
}

function hashCanonicalJson(json: string): string {
	return createHash("sha256").update(json, "utf8").digest("hex");
}

/** Logical file identity. The path-like locator is hashed and never stored in a cursor. */
export function computeFileSourceId(kind: "read" | "gate-read", logicalLocator: unknown): CursorResult<string> {
	try {
		if ((kind !== "read" && kind !== "gate-read") || !boundedFileLogicalLocator(logicalLocator)) return failure("invalid_cursor");
		return { ok: true, value: hashCanonicalJson(JSON.stringify({ kind, logicalLocator })) };
	} catch {
		return failure("invalid_cursor");
	}
}

/** Logical run/stream identity, independent of the current files' stat state. */
export function computeRunLogSourceId(runId: unknown, logStream: unknown): CursorResult<string> {
	try {
		if (!boundedIdentityComponent(runId) || (logStream !== "stdout" && logStream !== "stderr" && logStream !== "both")) return failure("invalid_cursor");
		return { ok: true, value: hashCanonicalJson(JSON.stringify({ runId, logStream })) };
	} catch {
		return failure("invalid_cursor");
	}
}

export interface RunLogSourceState {
	stdout: FileSourceSnapshot | null;
	stderr: FileSourceSnapshot | null;
}

/** Missing and present stream states intentionally hash differently. */
export function computeRunLogSourceStateId(input: unknown): CursorResult<string> {
	try {
		if (!isPlainRecord(input) || !hasExactKeys(input, ["stdout", "stderr"])) return failure("invalid_cursor");
		const stdout = input.stdout;
		const stderr = input.stderr;
		if (!(stdout === null || validSnapshot(stdout)) || !(stderr === null || validSnapshot(stderr))) return failure("invalid_cursor");
		const json = `{"stdout":${stdout === null ? "null" : canonicalSnapshot(stdout)},"stderr":${stderr === null ? "null" : canonicalSnapshot(stderr)}}`;
		return { ok: true, value: hashCanonicalJson(json) };
	} catch {
		return failure("invalid_cursor");
	}
}
