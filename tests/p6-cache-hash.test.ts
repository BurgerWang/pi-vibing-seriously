/**
 * P6-A canonical hashing tests — determinism, key sorting, array order,
 * undefined normalization, Date/non-JSON rejection.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	canonicalHash,
	canonicalJson,
	hashSessionId,
	NonSerializableValueError,
	sha256Hex,
} from "../extensions/workbench-runtime/cache/canonical-hash.ts";

test("canonical hash is deterministic across runs", () => {
	const value = { a: 1, b: "x", c: [1, 2, { d: null }] };
	const h1 = canonicalHash(value);
	const h2 = canonicalHash(structuredClone(value));
	assert.equal(h1, h2);
	assert.match(h1, /^[0-9a-f]{64}$/);
});

test("object key reorder produces the same hash", () => {
	const a = { alpha: 1, beta: 2, gamma: 3 };
	const b = { gamma: 3, alpha: 1, beta: 2 };
	assert.equal(canonicalHash(a), canonicalHash(b));
	assert.equal(canonicalJson(a), canonicalJson(b));
});

test("array order is preserved (reordering changes the hash)", () => {
	const a = ["read", "grep", "find"];
	const b = ["grep", "read", "find"];
	assert.notEqual(canonicalHash(a), canonicalHash(b));
	// identical arrays hash identically
	assert.equal(canonicalHash(["x", "y"]), canonicalHash(["x", "y"]));
});

test("undefined has an explicit normalization rule", () => {
	// undefined -> bare `undefined` token; deterministic
	assert.equal(canonicalHash({ a: undefined }), canonicalHash({ a: undefined }));
	assert.equal(canonicalJson({ a: undefined }), '{"a":undefined}');
	// undefined vs null vs missing key are all DISTINCT (no collisions)
	assert.notEqual(canonicalHash({ a: undefined }), canonicalHash({ a: null }));
	assert.notEqual(canonicalHash({ a: undefined }), canonicalHash({}));
	assert.notEqual(canonicalHash({ a: null }), canonicalHash({}));
	// a real string can never collide with the marker (JSON always quotes)
	assert.notEqual(canonicalHash({ a: "undefined" }), canonicalHash({ a: undefined }));
	assert.notEqual(canonicalHash({ a: "\u0000undef\u0000" }), canonicalHash({ a: undefined }));
	assert.notEqual(canonicalHash({ a: ["undefined"] }), canonicalHash({ a: [undefined] }));
});

test("Date is rejected — no implicit locale serialization", () => {
	assert.throws(() => canonicalJson(new Date("2026-01-01T00:00:00Z")), NonSerializableValueError);
	assert.throws(() => canonicalHash({ at: new Date() }), NonSerializableValueError);
	// callers must convert to ISO strings explicitly
	const iso = new Date("2026-01-01T00:00:00Z").toISOString();
	assert.equal(canonicalHash({ at: iso }), canonicalHash({ at: "2026-01-01T00:00:00.000Z" }));
});

test("non-JSON values are rejected, never silently coerced", () => {
	assert.throws(() => canonicalHash(Number.NaN), NonSerializableValueError);
	assert.throws(() => canonicalHash(Number.POSITIVE_INFINITY), NonSerializableValueError);
	assert.throws(() => canonicalHash(1n), NonSerializableValueError);
	assert.throws(() => canonicalHash(() => 1), NonSerializableValueError);
	assert.throws(() => canonicalHash(Symbol("x")), NonSerializableValueError);
	assert.throws(() => canonicalHash(new Map([["a", 1]])), NonSerializableValueError);
	assert.throws(() => canonicalHash(new Set([1])), NonSerializableValueError);
	assert.throws(() => canonicalHash(new Uint8Array([1])), NonSerializableValueError);
});

test("nested structures, unicode and -0 are canonical", () => {
	assert.equal(canonicalHash({ n: -0 }), canonicalHash({ n: 0 }));
	assert.equal(canonicalJson(-0), "0");
	assert.equal(canonicalHash({ s: "héllo 世界" }), canonicalHash({ s: "héllo 世界" }));
	assert.equal(canonicalHash({ deep: { list: [{ x: 1 }, [true, null]] } }), canonicalHash({ deep: { list: [{ x: 1 }, [true, null]] } }));
});

test("sha256Hex and hashSessionId", () => {
	assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	assert.equal(hashSessionId("abc").length, 16);
	assert.match(hashSessionId("abc"), /^[0-9a-f]{16}$/);
	assert.notEqual(hashSessionId("abc"), hashSessionId("abd"));
});
