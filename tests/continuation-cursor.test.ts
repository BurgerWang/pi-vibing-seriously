import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
	CONTINUATION_CURSOR_MAX_CHARS,
	CONTINUATION_CURSOR_V2_PREFIX,
	computeFileSourceId,
	computeRunLogSourceId,
	computeRunLogSourceStateId,
	decodeContinuationCursor,
	encodeContinuationCursor,
	validateFileCursorSource,
	validateRunLogCursorSource,
	validateSourceSnapshot,
	type CursorPayloadV1,
	type FileCursorPayloadV2,
	type FileSourceSnapshot,
} from "../extensions/workbench-runtime/core/continuation-cursor.ts";

const SNAPSHOT: FileSourceSnapshot = { fileSize: 123, mtimeMs: 456, dev: 7, ino: 8 };
const OTHER_SNAPSHOT: FileSourceSnapshot = { fileSize: 124, mtimeMs: 456, dev: 7, ino: 8 };
const HIGH_RES_SNAPSHOT: FileSourceSnapshot = { fileSize: 123, mtimeMs: 456, mtimeNs: "456000100", dev: 7, ino: 8 };
const HIGH_RES_REWRITE: FileSourceSnapshot = { fileSize: 123, mtimeMs: 456, mtimeNs: "456000900", dev: 7, ino: 8 };

function expectValue<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("expected success");
	return result.value;
}

function expectCode(result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }, code: string): void {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected failure");
	assert.equal(result.error.code, code);
	assert.ok(Buffer.byteLength(result.error.message, "utf8") < 128);
}

function sourceId(): string {
	return expectValue(computeFileSourceId("read", "src/example.ts"));
}

function readPayload(): CursorPayloadV1 {
	return { v: 1, kind: "read", sourceId: sourceId(), byteOffset: 24, lineNumber: 3, ...SNAPSHOT };
}

function rawCursor(json: string): string {
	const payload = Buffer.from(json, "utf8").toString("base64url");
	const signed = `wbcur1.${payload}`;
	const checksum = createHash("sha256").update(signed, "utf8").digest("hex").slice(0, 16);
	return `${signed}.${checksum}`;
}

test("cursor encoding is deterministic, canonical, bounded, and round-trips both strict kind variants", () => {
	const payload = readPayload();
	const first = expectValue(encodeContinuationCursor(payload));
	const second = expectValue(encodeContinuationCursor(payload));
	assert.equal(first, second);
	assert.ok(first.startsWith("wbcur1."));
	assert.ok(first.length <= CONTINUATION_CURSOR_MAX_CHARS);
	assert.deepEqual(expectValue(decodeContinuationCursor(first)), payload);

	const stateId = expectValue(computeRunLogSourceStateId({ stdout: SNAPSHOT, stderr: null }));
	const runPayload: CursorPayloadV1 = {
		v: 1,
		kind: "run-log",
		sourceId: expectValue(computeRunLogSourceId("run-01", "both")),
		sourceStateId: stateId,
		stdoutEndExclusive: 100,
		stderrEndExclusive: 0,
	};
	const runCursor = expectValue(encodeContinuationCursor(runPayload));
	assert.deepEqual(expectValue(decodeContinuationCursor(runCursor)), runPayload);
});

test("high-resolution file cursors use an explicit v2 wire form while wbcur1 stays strict", () => {
	const payload: FileCursorPayloadV2 = {
		v: 2,
		kind: "read",
		sourceId: sourceId(),
		byteOffset: 24,
		lineNumber: 3,
		...HIGH_RES_SNAPSHOT,
		mtimeNs: HIGH_RES_SNAPSHOT.mtimeNs!,
	};
	const encoded = expectValue(encodeContinuationCursor(payload));
	assert.ok(encoded.startsWith(`${CONTINUATION_CURSOR_V2_PREFIX}.`));
	assert.deepEqual(expectValue(decodeContinuationCursor(encoded)), payload);
	expectCode(decodeContinuationCursor(encoded.replace(/^wbcur2/, "wbcur1")), "invalid_cursor");
	expectCode(encodeContinuationCursor({ ...readPayload(), mtimeNs: HIGH_RES_SNAPSHOT.mtimeNs }), "invalid_cursor");
	expectCode(encodeContinuationCursor({ ...payload, mtimeNs: "0456000100" }), "invalid_cursor");
	expectCode(validateFileCursorSource({
		payload,
		expectedKind: "read",
		expectedSourceId: payload.sourceId,
		currentSnapshot: HIGH_RES_REWRITE,
	}), "stale_cursor");
	assert.equal(validateFileCursorSource({
		payload,
		expectedKind: "read",
		expectedSourceId: payload.sourceId,
		currentSnapshot: HIGH_RES_SNAPSHOT,
	}).ok, true);
	// Legacy cursors remain decodable with their exact v1 keys, but fail safe
	// against a source whose current identity has stronger facts they lack.
	expectCode(validateFileCursorSource({
		payload: readPayload(),
		expectedKind: "read",
		expectedSourceId: sourceId(),
		currentSnapshot: HIGH_RES_SNAPSHOT,
	}), "stale_cursor");
});

test("checksum, prefix, base64 canonicality, length, and hostile inputs fail closed", () => {
	const encoded = expectValue(encodeContinuationCursor(readPayload()));
	expectCode(decodeContinuationCursor(`${encoded.slice(0, -1)}${encoded.endsWith("0") ? "1" : "0"}`), "invalid_cursor");
	expectCode(decodeContinuationCursor(encoded.replace(/^wbcur1/, "wbcur2")), "invalid_cursor");
	expectCode(decodeContinuationCursor("wbcur1.====.0000000000000000"), "invalid_cursor");
	expectCode(decodeContinuationCursor("x".repeat(CONTINUATION_CURSOR_MAX_CHARS + 1)), "invalid_cursor");
	expectCode(decodeContinuationCursor(new Proxy({}, { get(): never { throw new Error("secret"); } })), "invalid_cursor");
	expectCode(encodeContinuationCursor(new Proxy({}, { get(): never { throw new Error("secret"); } })), "invalid_cursor");
});

test("strict payload validation rejects unknown, missing, reordered, wrong-type, and unsafe numeric fields", () => {
	const id = sourceId();
	const canonical = { v: 1, kind: "read", sourceId: id, byteOffset: 0, lineNumber: 1, fileSize: 1, mtimeMs: 2 };
	expectCode(decodeContinuationCursor(rawCursor(JSON.stringify({ ...canonical, path: "/secret" }))), "invalid_cursor");
	expectCode(decodeContinuationCursor(rawCursor(JSON.stringify({ v: 1, kind: "read", sourceId: id, byteOffset: 0, fileSize: 1, mtimeMs: 2 }))), "invalid_cursor");
	expectCode(decodeContinuationCursor(rawCursor(JSON.stringify({ ...canonical, byteOffset: "0" }))), "invalid_cursor");
	expectCode(decodeContinuationCursor(rawCursor(JSON.stringify({ ...canonical, byteOffset: Number.MAX_SAFE_INTEGER + 1 }))), "invalid_cursor");
	expectCode(decodeContinuationCursor(rawCursor(JSON.stringify({ ...canonical, lineNumber: 0 }))), "invalid_cursor");
	expectCode(decodeContinuationCursor(rawCursor(JSON.stringify({ ...canonical, byteOffset: 2 }))), "invalid_cursor");
	// A valid field set in a non-canonical order does not get a second wire form.
	expectCode(decodeContinuationCursor(rawCursor(JSON.stringify({ kind: "read", v: 1, sourceId: id, byteOffset: 0, lineNumber: 1, fileSize: 1, mtimeMs: 2 }))), "invalid_cursor");

	const run = { v: 1, kind: "run-log", sourceId: id, sourceStateId: id, stdoutEndExclusive: 0, stderrEndExclusive: 0 };
	expectCode(decodeContinuationCursor(rawCursor(JSON.stringify({ ...run, byteOffset: 0 }))), "invalid_cursor");
	expectCode(encodeContinuationCursor({ ...run, stdoutEndExclusive: -1 }), "invalid_cursor");
});

test("logical source mismatch is distinct from stat/state staleness", () => {
	const payload = readPayload();
	const otherSource = expectValue(computeFileSourceId("read", "src/other.ts"));
	expectCode(validateFileCursorSource({ payload, expectedKind: "read", expectedSourceId: otherSource, currentSnapshot: SNAPSHOT }), "source_mismatch");
	expectCode(validateFileCursorSource({ payload, expectedKind: "read", expectedSourceId: payload.sourceId, currentSnapshot: OTHER_SNAPSHOT }), "stale_cursor");
	assert.equal(validateFileCursorSource({ payload, expectedKind: "read", expectedSourceId: payload.sourceId, currentSnapshot: SNAPSHOT }).ok, true);
	expectCode(validateFileCursorSource({ payload, expectedKind: "gate-read", expectedSourceId: payload.sourceId, currentSnapshot: SNAPSHOT }), "invalid_cursor");
});

test("run-log source state covers both streams and missing-present transitions", () => {
	const logical = expectValue(computeRunLogSourceId("run-01", "both"));
	const initialState = expectValue(computeRunLogSourceStateId({ stdout: SNAPSHOT, stderr: null }));
	const presentState = expectValue(computeRunLogSourceStateId({ stdout: SNAPSHOT, stderr: SNAPSHOT }));
	assert.notEqual(initialState, presentState);
	const payload: CursorPayloadV1 = { v: 1, kind: "run-log", sourceId: logical, sourceStateId: initialState, stdoutEndExclusive: 12, stderrEndExclusive: 0 };
	assert.equal(validateRunLogCursorSource({ payload, expectedSourceId: logical, currentSourceStateId: initialState }).ok, true);
	expectCode(validateRunLogCursorSource({ payload, expectedSourceId: expectValue(computeRunLogSourceId("run-02", "both")), currentSourceStateId: initialState }), "source_mismatch");
	expectCode(validateRunLogCursorSource({ payload, expectedSourceId: logical, currentSourceStateId: presentState }), "stale_cursor");
	assert.notEqual(
		expectValue(computeRunLogSourceStateId({ stdout: HIGH_RES_SNAPSHOT, stderr: null })),
		expectValue(computeRunLogSourceStateId({ stdout: HIGH_RES_REWRITE, stderr: null })),
		"sub-millisecond rewrites change the run-log state hash",
	);
});

test("snapshot and identity helpers are deterministic, exact, and reject invalid components", () => {
	assert.equal(validateSourceSnapshot(SNAPSHOT, { ...SNAPSHOT }).ok, true);
	expectCode(validateSourceSnapshot(SNAPSHOT, OTHER_SNAPSHOT), "stale_cursor");
	expectCode(validateSourceSnapshot({ ...SNAPSHOT, extra: 1 }, SNAPSHOT), "stale_cursor");
	assert.equal(expectValue(computeFileSourceId("read", "same")), expectValue(computeFileSourceId("read", "same")));
	assert.notEqual(expectValue(computeFileSourceId("read", "same")), expectValue(computeFileSourceId("gate-read", "same")));
	expectCode(computeFileSourceId("read", ""), "invalid_cursor");
	expectCode(computeRunLogSourceId("run", "unknown"), "invalid_cursor");
	expectCode(computeRunLogSourceStateId({ stdout: SNAPSHOT, stderr: null, path: "/secret" }), "invalid_cursor");
});
