/**
 * NRO v2 policy module tests (pure, hermetic — no fixtures, no
 * filesystem writes, no gitignored evidence). Covers:
 *
 *   - the frozen six-check rubric evaluator: spaced and unspaced
 *     unicode comma variants both accepted; wrong, missing, reordered
 *     values and absent required lines rejected per-check
 *   - pagination: normal preview + legacy continuation (offset/limit),
 *     preview-only misuse, complete=true reached-complete, fractions
 *   - strict exact-ID result attribution: reordered results, orphan
 *     calls and provider-error assistant entries never shift
 *     attribution; orphan aggregate
 *   - error results: consume their id, count errorReadResults, never
 *     parse markers and never paginate; fresh-id retries succeed
 *   - fail-closed attribution: missing/unknown/duplicate call and
 *     result ids, path/id bounds, malformed and duplicate preview-facts
 *     markers
 *   - inline content[] text items and UTF-8 byte counting
 *   - privacy: thrown messages and returned JSON never carry supplied
 *     secret ids, paths, arguments, bodies or thinking
 *
 * The module is a leaf (no imports); importing it here pulls it into
 * the typecheck program (tsconfig covers tests/**, not scripts/**
 * directly).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ID_MAX_BYTES,
	NRO_FACTS_MARKER,
	PATH_MAX_BYTES,
	V2_RUBRIC_CHECKS,
	V2PolicyError,
	computePaginationV2,
	evaluateRubricV2,
	type PaginationFactsV2,
	type V2PolicyErrorCode,
} from "../scripts/commander-native-tool-benchmark-v2-policy.ts";

// ---------------------------------------------------------------------------
// Hermetic constants and entry builders
// ---------------------------------------------------------------------------

/** Sentinels that must NEVER appear in any error message or returned fact. */
const SECRET_CALL_ID = "call-SECRET-9f2c-bb71";
const SECRET_PATH = "/private/secret-dir/SECRET-file-7c4e.txt";
const SECRET_BODY = "NROPRIVATE-TOOLRESULT-1b3d";
const SECRET_THINKING = "NROPRIVATE-THINKING-a5e8";

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

function markerLine(facts: { complete: boolean; returnedLines?: number; returnedBytes?: number; totalLines?: number; totalBytes?: number; omittedLines?: number; omittedBytes?: number; nextOffset?: number; lineTruncated?: boolean }): string {
	return `nro-read-facts: complete=${facts.complete} returned_lines=${facts.returnedLines ?? 10} returned_bytes=${facts.returnedBytes ?? 1000} total_lines=${facts.totalLines ?? 100} total_bytes=${facts.totalBytes ?? 10000} omitted_lines=${facts.omittedLines ?? 90} omitted_bytes=${facts.omittedBytes ?? 9000} next_offset=${facts.nextOffset ?? 10} line_truncated=${facts.lineTruncated ?? false}`;
}

/** Persisted-shape read tool call (assistant content toolCall item with id). */
function readCall(id: string, path: string, opts: { offset?: number; limit?: number } = {}): Record<string, unknown> {
	return {
		type: "message",
		id: `m-${id}`,
		message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path, ...opts } }] },
	};
}

/** Persisted-shape read toolResult message (toolCallId attribution). */
function readResult(toolCallId: string, content: unknown, isError?: boolean): Record<string, unknown> {
	return {
		type: "message",
		id: `m-${toolCallId}-r`,
		message: { role: "toolResult", toolName: "read", toolCallId, content, ...(isError ? { isError: true } : {}) },
	};
}

/** Provider-error assistant entry: no tool calls, must never shift attribution. */
function providerErrorEntry(): Record<string, unknown> {
	return {
		type: "message",
		id: "m-err",
		message: {
			role: "assistant",
			provider: "openai-codex",
			content: [{ type: "text", text: `provider error ${SECRET_BODY}` }],
			stopReason: "error",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } },
		},
	};
}

/** Non-message entry (session header etc.) — ignored. */
function nonMessageEntry(): Record<string, unknown> {
	return { type: "session", version: 3, id: "s-1", timestamp: "2026-09-01T10:00:00.000Z" };
}

function expectCode(thunk: () => unknown, code: V2PolicyErrorCode): V2PolicyError {
	let err: unknown;
	try {
		thunk();
	} catch (e) {
		err = e;
	}
	assert.ok(err instanceof V2PolicyError, `expected V2PolicyError ${code}, got ${String(err)}`);
	assert.equal(err.code, code);
	return err;
}

// ---------------------------------------------------------------------------
// Rubric evaluator
// ---------------------------------------------------------------------------

const RUBRIC_FULL_TEXT = [
	"build: alpha-42",
	"unicode: α, 水, 🚀",
	"token: delta-77",
	"needle_occurrences: 140",
	"needle_lines: 135",
	"needle_files: 4",
].join("\n");

test("rubric v2: frozen check values match v1 except unicode comma whitespace", () => {
	assert.deepEqual(V2_RUBRIC_CHECKS.map((c) => c.id), ["build", "unicode", "token", "needle_occurrences", "needle_lines", "needle_files"]);
	// The five non-unicode patterns are byte-identical to the frozen v1 rubric.json values.
	assert.equal(V2_RUBRIC_CHECKS[0]?.pattern, "build:\\s*alpha-42\\b");
	assert.equal(V2_RUBRIC_CHECKS[2]?.pattern, "token:\\s*delta-77\\b");
	assert.equal(V2_RUBRIC_CHECKS[3]?.pattern, "needle_occurrences:\\s*140\\b");
	assert.equal(V2_RUBRIC_CHECKS[4]?.pattern, "needle_lines:\\s*135\\b");
	assert.equal(V2_RUBRIC_CHECKS[5]?.pattern, "needle_files:\\s*4\\b");
	// The unicode pattern is the v2 variant: optional whitespace around the commas.
	assert.equal(V2_RUBRIC_CHECKS[1]?.pattern, "unicode:\\s*α,\\s*水,\\s*🚀(?:\\s|$)");
	assert.notEqual(V2_RUBRIC_CHECKS[1]?.pattern, "unicode:\\s*α, 水, 🚀(?:\\s|$)"); // v1 requires exactly ", "
});

test("rubric v2: spaced and unspaced unicode comma variants both accepted", () => {
	for (const unicodeLine of ["unicode: α, 水, 🚀", "unicode: α,水,🚀", "unicode:α,水,🚀", "unicode: α , 水 , 🚀".replace("α ,", "α, ").replace("水 ,", "水, ")]) {
		const text = RUBRIC_FULL_TEXT.replace("unicode: α, 水, 🚀", unicodeLine);
		const r = evaluateRubricV2(text);
		assert.equal(r.passed, true, unicodeLine);
		assert.equal(r.checks.length, 6);
		assert.ok(r.checks.every((c) => c.passed), unicodeLine);
	}
});

test("rubric v2: wrong, missing, reordered and absent facts are rejected", () => {
	const cases: Array<{ text: string; failing: string; label: string }> = [
		{ text: RUBRIC_FULL_TEXT.replace("alpha-42", "alpha-43"), failing: "build", label: "wrong build value" },
		{ text: RUBRIC_FULL_TEXT.replace("alpha-42", "alpha-42x"), failing: "build", label: "build value glued to following text" },
		{ text: RUBRIC_FULL_TEXT.replace("delta-77", "delta-78"), failing: "token", label: "wrong token value" },
		{ text: RUBRIC_FULL_TEXT.replace("needle_occurrences: 140", "needle_occurrences: 141"), failing: "needle_occurrences", label: "wrong occurrences value" },
		{ text: RUBRIC_FULL_TEXT.replace("needle_lines: 135", "needle_lines: 1350"), failing: "needle_lines", label: "wrong lines value" },
		{ text: RUBRIC_FULL_TEXT.replace("needle_files: 4", "needle_files: 5"), failing: "needle_files", label: "wrong files value" },
		{ text: RUBRIC_FULL_TEXT.replace("α, 水, 🚀", "α, 水, 🍕"), failing: "unicode", label: "wrong unicode third value" },
		{ text: RUBRIC_FULL_TEXT.replace("α, 水, 🚀", "β, 水, 🚀"), failing: "unicode", label: "wrong unicode first value" },
		{ text: RUBRIC_FULL_TEXT.replace("α, 水, 🚀", "α, 水"), failing: "unicode", label: "missing unicode third value" },
		{ text: RUBRIC_FULL_TEXT.replace("α, 水, 🚀", "🚀, α, 水"), failing: "unicode", label: "reordered unicode values" },
		{ text: RUBRIC_FULL_TEXT.replace("α, 水, 🚀", "水, α, 🚀"), failing: "unicode", label: "reordered unicode values (2)" },
		{ text: RUBRIC_FULL_TEXT.replace("α, 水, 🚀", "α, 水, 🚀x"), failing: "unicode", label: "unicode value glued to following text" },
		{ text: RUBRIC_FULL_TEXT.replace("unicode: α, 水, 🚀\n", ""), failing: "unicode", label: "absent unicode line" },
		{ text: RUBRIC_FULL_TEXT.replace("build: alpha-42\n", ""), failing: "build", label: "absent build line" },
		{ text: RUBRIC_FULL_TEXT.replace("needle_lines: 135\n", ""), failing: "needle_lines", label: "absent needle_lines line" },
	];
	for (const c of cases) {
		const r = evaluateRubricV2(c.text);
		assert.equal(r.passed, false, c.label);
		assert.equal(r.checks.find((ch) => ch.id === c.failing)?.passed, false, `${c.label}: ${c.failing} must fail`);
	}
	// Empty text fails every check.
	const empty = evaluateRubricV2("");
	assert.equal(empty.passed, false);
	assert.equal(empty.checks.filter((c) => c.passed).length, 0);
});

// ---------------------------------------------------------------------------
// Pagination: preview / continuation / completion
// ---------------------------------------------------------------------------

test("computePaginationV2: preview + legacy continuation (offset and limit)", () => {
	const preview = markerLine({ complete: false });
	const legacy = "legacy full content";
	const p1 = computePaginationV2([readCall("c1", "f.txt"), readResult("c1", preview), readCall("c2", "f.txt", { offset: 100 }), readResult("c2", legacy)]);
	assert.equal(p1.previewResults, 1);
	assert.equal(p1.previewBytes, utf8Bytes(preview));
	assert.equal(p1.obligations, 1);
	assert.equal(p1.obligationsPaginated, 1);
	assert.equal(p1.continuationReads, 1);
	assert.equal(p1.continuationBytes, utf8Bytes(legacy));
	assert.equal(p1.reachedComplete, 0);
	assert.equal(p1.completionFraction, 1);
	assert.equal(p1.reachedFraction, 0);
	assert.equal(p1.unpaginatedPreviews, 0);
	assert.equal(p1.misuse, false);
	assert.equal(p1.orphanReadCalls, 0);
	assert.equal(p1.errorReadResults, 0);

	// limit-only continuation behaves identically.
	const p2 = computePaginationV2([readCall("c1", "g.txt"), readResult("c1", preview), readCall("c2", "g.txt", { limit: 50 }), readResult("c2", legacy)]);
	assert.equal(p2.continuationReads, 1);
	assert.equal(p2.obligationsPaginated, 1);
	assert.equal(p2.completionFraction, 1);
	assert.equal(p2.misuse, false);

	// offset 0 is a finite integer and counts as a continuation.
	const p3 = computePaginationV2([readCall("c1", "h.txt"), readResult("c1", preview), readCall("c2", "h.txt", { offset: 0 }), readResult("c2", legacy)]);
	assert.equal(p3.continuationReads, 1);
	assert.equal(p3.obligationsPaginated, 1);
});

test("computePaginationV2: preview-only obligation is misuse; complete=true reaches complete", () => {
	const preview = markerLine({ complete: false });
	const p1 = computePaginationV2([readCall("c1", "f.txt"), readResult("c1", preview)]);
	assert.equal(p1.previewResults, 1);
	assert.equal(p1.obligations, 1);
	assert.equal(p1.obligationsPaginated, 0);
	assert.equal(p1.continuationReads, 0);
	assert.equal(p1.unpaginatedPreviews, 1);
	assert.equal(p1.completionFraction, 0);
	assert.equal(p1.reachedFraction, 0);
	assert.equal(p1.misuse, true);

	const complete = markerLine({ complete: true });
	const p2 = computePaginationV2([readCall("c1", "f.txt"), readResult("c1", preview), readCall("c2", "f.txt", { offset: 100 }), readResult("c2", complete)]);
	assert.equal(p2.obligationsPaginated, 1);
	assert.equal(p2.reachedComplete, 1);
	assert.equal(p2.completionFraction, 1);
	assert.equal(p2.reachedFraction, 1);
	assert.equal(p2.continuationReads, 1);
	assert.equal(p2.misuse, false);

	// No obligations at all: fractions are null, never misuse.
	const p3 = computePaginationV2([readCall("c1", "f.txt"), readResult("c1", "plain legacy text")]);
	assert.equal(p3.obligations, 0);
	assert.equal(p3.completionFraction, null);
	assert.equal(p3.reachedFraction, null);
	assert.equal(p3.misuse, false);
});

// ---------------------------------------------------------------------------
// Pagination: strict exact-ID attribution
// ---------------------------------------------------------------------------

test("computePaginationV2: strict ID matching — reordered results cannot shift attribution", () => {
	// Results arrive out of FIFO order; an error result must stay glued to its own call.
	// Under FIFO, rErr would attach to cA (f) and rPrev to cB (g), making the later
	// offset call on g a continuation. Under exact-ID matching only f is previewed.
	const entries = [
		readCall("cA", "f.txt"),
		readCall("cB", "g.txt"),
		readResult("cB", SECRET_BODY, true), // error for g — arrives first
		readResult("cA", markerLine({ complete: false })), // preview for f — arrives second
		readCall("cC", "g.txt", { offset: 100 }),
		readResult("cC", "legacy"),
	];
	const p = computePaginationV2(entries);
	assert.equal(p.previewResults, 1);
	assert.equal(p.obligations, 1);
	assert.equal(p.errorReadResults, 1);
	assert.equal(p.continuationReads, 0); // g was never previewed — no continuation
	assert.equal(p.obligationsPaginated, 0);
	assert.equal(p.unpaginatedPreviews, 1);
	assert.equal(p.misuse, true);
	assert.equal(p.orphanReadCalls, 0);

	// Both previews attributed to the right paths (swap order of two previews).
	const p2 = computePaginationV2([
		readCall("c1", "f.txt"),
		readCall("c2", "g.txt"),
		readResult("c2", markerLine({ complete: false })),
		readResult("c1", markerLine({ complete: false })),
		readCall("c3", "f.txt", { offset: 100 }),
		readResult("c3", "legacy"),
	]);
	assert.equal(p2.previewResults, 2);
	assert.equal(p2.obligations, 2);
	assert.equal(p2.continuationReads, 1); // only the f continuation
	assert.equal(p2.obligationsPaginated, 1);
	assert.equal(p2.completionFraction, 0.5);
	assert.equal(p2.misuse, true);
});

test("computePaginationV2: orphan calls and provider-error entries never shift attribution", () => {
	const preview = markerLine({ complete: false });
	const entries = [
		readCall("c1", "f.txt"),
		providerErrorEntry(), // between a call and its own result — ignored
		readResult("c1", preview),
		readCall("c2", "f.txt", { offset: 100 }), // orphan — no result ever arrives
		providerErrorEntry(),
		readCall("c3", "f.txt", { limit: 50 }),
		readResult("c3", "legacy"),
		readCall("c4", "g.txt"), // orphan
		readCall("c5", "h.txt"), // orphan
		nonMessageEntry(),
	];
	const p = computePaginationV2(entries);
	assert.equal(p.previewResults, 1);
	assert.equal(p.obligations, 1);
	assert.equal(p.obligationsPaginated, 1); // c3 continuation attributed to c1's preview
	assert.equal(p.continuationReads, 1);
	assert.equal(p.orphanReadCalls, 3); // c2, c4, c5
	assert.equal(p.misuse, false);
	assert.equal(p.errorReadResults, 0);
});

test("computePaginationV2: error results consume ids; fresh-id retries succeed; errors never paginate", () => {
	// Error on an offset call, then a fresh-id retry that succeeds.
	const p1 = computePaginationV2([
		readCall("c1", "f.txt"),
		readResult("c1", markerLine({ complete: false })),
		readCall("c2", "f.txt", { offset: 100 }),
		readResult("c2", "boom", true), // consumes c2, errorReadResults only
		readCall("c3", "f.txt", { offset: 200 }),
		readResult("c3", "legacy"),
	]);
	assert.equal(p1.errorReadResults, 1);
	assert.equal(p1.previewResults, 1);
	assert.equal(p1.continuationReads, 1); // only c3
	assert.equal(p1.obligationsPaginated, 1);
	assert.equal(p1.misuse, false);

	// Error result alone never paginates an obligation.
	const p2 = computePaginationV2([
		readCall("c1", "f.txt"),
		readResult("c1", markerLine({ complete: false })),
		readCall("c2", "f.txt", { offset: 100 }),
		readResult("c2", "boom", true),
	]);
	assert.equal(p2.continuationReads, 0);
	assert.equal(p2.obligationsPaginated, 0);
	assert.equal(p2.unpaginatedPreviews, 1);
	assert.equal(p2.misuse, true);
	assert.equal(p2.errorReadResults, 1);
	assert.equal(p2.previewResults, 1);

	// An error result never parses the marker: even a malformed marker or a
	// complete=true marker inside an error result is ignored.
	const p3 = computePaginationV2([
		readCall("c1", "f.txt"),
		readResult("c1", markerLine({ complete: false })),
		readCall("c2", "f.txt", { offset: 100 }),
		readResult("c2", `${NRO_FACTS_MARKER} complete=true bogus`, true),
	]);
	assert.equal(p3.errorReadResults, 1);
	assert.equal(p3.reachedComplete, 0);
	assert.equal(p3.obligationsPaginated, 0);
	assert.equal(p3.misuse, true);

	// No throw for an error result carrying a malformed marker.
	expectNoThrow(() => computePaginationV2([readCall("c1", "f.txt"), readResult("c1", `${NRO_FACTS_MARKER} complete=false bogus`, true)]));
});

function expectNoThrow(thunk: () => unknown): void {
	try {
		thunk();
	} catch (e) {
		assert.fail(`expected no throw, got ${String(e)}`);
	}
}

// ---------------------------------------------------------------------------
// Pagination: fail-closed attribution
// ---------------------------------------------------------------------------

test("computePaginationV2: missing, unknown and duplicate call/result ids fail closed", () => {
	const rawCall = (overrides: Record<string, unknown>): Record<string, unknown> => ({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "f.txt" }, ...overrides }] },
	});
	const rawResult = (overrides: Record<string, unknown>): Record<string, unknown> => ({
		type: "message",
		message: { role: "toolResult", toolName: "read", toolCallId: "c1", content: "x", ...overrides },
	});

	expectCode(() => computePaginationV2([rawCall({ id: undefined })]), "INVALID_CALL_ID");
	expectCode(() => computePaginationV2([rawCall({ id: "" })]), "INVALID_CALL_ID");
	expectCode(() => computePaginationV2([rawCall({ id: 42 })]), "INVALID_CALL_ID");
	expectCode(() => computePaginationV2([rawCall({ id: "x".repeat(ID_MAX_BYTES + 1) })]), "INVALID_CALL_ID");
	expectCode(() => computePaginationV2([readCall("c1", "f.txt"), readCall("c1", "g.txt")]), "DUPLICATE_CALL_ID");
	expectCode(() => computePaginationV2([rawCall({ id: "c1" }), rawCall({ id: "c1" })]), "DUPLICATE_CALL_ID");

	expectCode(() => computePaginationV2([readCall("c1", "f.txt"), rawResult({ toolCallId: undefined })]), "INVALID_RESULT_ID");
	expectCode(() => computePaginationV2([readCall("c1", "f.txt"), rawResult({ toolCallId: "" })]), "INVALID_RESULT_ID");
	expectCode(() => computePaginationV2([readCall("c1", "f.txt"), rawResult({ toolCallId: 7 })]), "INVALID_RESULT_ID");
	expectCode(() => computePaginationV2([readCall("c1", "f.txt"), rawResult({ toolCallId: "x".repeat(ID_MAX_BYTES + 1) })]), "INVALID_RESULT_ID");

	expectCode(() => computePaginationV2([readResult("nope", "x")]), "UNKNOWN_RESULT_ID");
	expectCode(() => computePaginationV2([readCall("c1", "f.txt"), readResult("c2", "x")]), "UNKNOWN_RESULT_ID");

	// Second result for an already consumed id fails — after a success and after an error.
	expectCode(() => computePaginationV2([readCall("c1", "f.txt"), readResult("c1", "x"), readResult("c1", "y")]), "RESULT_ALREADY_CONSUMED");
	expectCode(() => computePaginationV2([readCall("c1", "f.txt"), readResult("c1", "x", true), readResult("c1", "y")]), "RESULT_ALREADY_CONSUMED");

	// Non-read tools and malformed content items are ignored entirely.
	const ignored = computePaginationV2([
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { path: "x" } }] } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "unknown", content: SECRET_BODY } },
		{ type: "message", message: { role: "assistant", content: ["not-an-object", { type: "text", text: "plain" }, { type: "thinking", text: SECRET_THINKING }] } },
	]);
	assert.equal(ignored.orphanReadCalls, 0);
	assert.equal(ignored.errorReadResults, 0);
});

test("computePaginationV2: path and offset/limit bounds", () => {
	const rawCall = (args: unknown): Record<string, unknown> => ({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: args }] },
	});

	expectCode(() => computePaginationV2([rawCall(undefined)]), "INVALID_CALL_PATH");
	expectCode(() => computePaginationV2([rawCall({})]), "INVALID_CALL_PATH");
	expectCode(() => computePaginationV2([rawCall({ path: "" })]), "INVALID_CALL_PATH");
	expectCode(() => computePaginationV2([rawCall({ path: 42 })]), "INVALID_CALL_PATH");
	expectCode(() => computePaginationV2([rawCall({ path: `ok\x00${SECRET_PATH}` })]), "INVALID_CALL_PATH");
	expectCode(() => computePaginationV2([rawCall({ path: "ok\x1fbad" })]), "INVALID_CALL_PATH");
	expectCode(() => computePaginationV2([rawCall({ path: "ok\x7fbad" })]), "INVALID_CALL_PATH");
	expectCode(() => computePaginationV2([rawCall({ path: "x".repeat(PATH_MAX_BYTES + 1) })]), "INVALID_CALL_PATH");
	expectCode(() => computePaginationV2([rawCall({ path: `${"α".repeat(256)}x` })]), "INVALID_CALL_PATH"); // 513 UTF-8 bytes

	// Exactly at the bounds: 512-byte ASCII and 512-byte multibyte paths are accepted.
	expectNoThrow(() => computePaginationV2([rawCall({ path: "x".repeat(PATH_MAX_BYTES) })]));
	expectNoThrow(() => computePaginationV2([rawCall({ path: "α".repeat(256) })]));

	// Only finite integers count as offset/limit presence.
	const preview = markerLine({ complete: false });
	const badCalls: Array<Record<string, unknown>> = [{ offset: 1.5 }, { limit: "100" }, { offset: Number.NaN }, { limit: Number.POSITIVE_INFINITY }];
	for (const bad of badCalls) {
		const p = computePaginationV2([
			readCall("c1", "f.txt"),
			readResult("c1", preview),
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "f.txt", ...bad } }] } },
			readResult("c2", "legacy"),
		]);
		assert.equal(p.continuationReads, 0, JSON.stringify(bad));
		assert.equal(p.obligationsPaginated, 0, JSON.stringify(bad));
		assert.equal(p.misuse, true, JSON.stringify(bad));
	}
	// A finite integer offset does count.
	const ok = computePaginationV2([readCall("c1", "f.txt"), readResult("c1", preview), readCall("c2", "f.txt", { offset: 10 }), readResult("c2", "legacy")]);
	assert.equal(ok.continuationReads, 1);
	assert.equal(ok.obligationsPaginated, 1);
});

test("computePaginationV2: inline content[] text items and UTF-8 byte counting", () => {
	const preview = markerLine({ complete: false });
	const parts = [`head ${SECRET_BODY}\n`, preview, "\ntail"];
	const contentItems = [
		{ type: "text", text: parts[0] },
		{ type: "image", imageUrl: "https://example.invalid/x.png" }, // non-text item skipped
		{ type: "text", text: parts[1] },
		{ type: "text", text: parts[2] },
	];
	const p = computePaginationV2([readCall("c1", "f.txt"), readResult("c1", contentItems), readCall("c2", "f.txt", { offset: 100 }), readResult("c2", [{ type: "text", text: "legacy " }, { type: "text", text: "content" }])]);
	assert.equal(p.previewResults, 1);
	assert.equal(p.previewBytes, utf8Bytes(parts.join(""))); // concatenated text items only
	assert.equal(p.continuationReads, 1);
	assert.equal(p.continuationBytes, utf8Bytes("legacy content"));
	assert.equal(p.obligationsPaginated, 1);

	// String content path counts the same bytes.
	const p2 = computePaginationV2([readCall("c1", "f.txt"), readResult("c1", preview)]);
	assert.equal(p2.previewBytes, utf8Bytes(preview));

	// Missing/empty content is a legacy success with zero bytes.
	const p3 = computePaginationV2([readCall("c1", "f.txt"), readResult("c1", undefined), readCall("c2", "f.txt", { offset: 1 }), readResult("c2", "x")]);
	assert.equal(p3.previewResults, 0);
	assert.equal(p3.previewBytes, 0);
	assert.equal(p3.obligations, 0);
	assert.equal(p3.continuationReads, 0); // no preview on f — not a continuation
	assert.equal(p3.orphanReadCalls, 0);
});

test("computePaginationV2: malformed and duplicate preview-facts markers fail closed", () => {
	const bad = [
		`${NRO_FACTS_MARKER} complete=false`, // too few facts
		`${NRO_FACTS_MARKER} complete=false returned_lines=10 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false extra=1`, // too many facts
		`${NRO_FACTS_MARKER} complete=false returned_lines=10 returned_lines=20 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`, // duplicate key
		`${NRO_FACTS_MARKER} complete=false SECRETKEY-9f2c=1 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`, // unknown key
		`${NRO_FACTS_MARKER} complete=maybe returned_lines=10 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`, // non-boolean
		`${NRO_FACTS_MARKER} complete=false returned_lines=-1 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`, // negative
		`${NRO_FACTS_MARKER} complete=false returned_lines=1.5 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`, // non-integer
		`${NRO_FACTS_MARKER} complete=false returned_lines=200000000000 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`, // over bound
		`${NRO_FACTS_MARKER} complete=false returned_lines=10 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false line_truncated=true`, // 10 tokens: duplicate
	];
	for (const line of bad) {
		expectCode(() => computePaginationV2([readCall("c1", "f.txt"), readResult("c1", line)]), "FACTS_MALFORMED");
	}
	// A malformed marker in a continuation-position result fails closed too.
	expectCode(
		() => computePaginationV2([readCall("c1", "f.txt"), readResult("c1", markerLine({ complete: false })), readCall("c2", "f.txt", { offset: 100 }), readResult("c2", `${NRO_FACTS_MARKER} complete=false bogus`)]),
		"FACTS_MALFORMED",
	);
});

test("computePaginationV2: two individually valid preview-facts markers fail closed", () => {
	const valid = markerLine({ complete: false });
	// Two valid marker lines in one string result: the second occurrence must
	// not be silently ignored — fail closed.
	expectCode(() => computePaginationV2([readCall("c1", "f.txt"), readResult("c1", `${valid}\n${valid}`)]), "FACTS_MALFORMED");
	// Two markers on the same line fail closed too.
	expectCode(() => computePaginationV2([readCall("c1", "f.txt"), readResult("c1", `${valid} ${valid}`)]), "FACTS_MALFORMED");
	// content[]: one marker in each of two text items — concatenation yields
	// two occurrences and must fail closed.
	expectCode(
		() => computePaginationV2([readCall("c1", "f.txt"), readResult("c1", [{ type: "text", text: `head\n${valid}` }, { type: "text", text: `${valid}\ntail` }])]),
		"FACTS_MALFORMED",
	);
	// content[]: markers split across a non-text item boundary still concatenate.
	expectCode(
		() => computePaginationV2([readCall("c1", "f.txt"), readResult("c1", [{ type: "text", text: valid }, { type: "image", imageUrl: "https://example.invalid/x.png" }, { type: "text", text: valid }])]),
		"FACTS_MALFORMED",
	);
	// Exactly one valid marker and no marker at all are unchanged.
	const p1 = computePaginationV2([readCall("c1", "f.txt"), readResult("c1", valid), readCall("c2", "f.txt", { offset: 100 }), readResult("c2", "legacy")]);
	assert.equal(p1.previewResults, 1);
	assert.equal(p1.obligationsPaginated, 1);
	const p2 = computePaginationV2([readCall("c1", "f.txt"), readResult("c1", "legacy text")]);
	assert.equal(p2.previewResults, 0);
	assert.equal(p2.obligations, 0);
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

test("privacy: thrown error messages never carry ids, paths, arguments, bodies or thinking", () => {
	const secrets = [SECRET_CALL_ID, SECRET_PATH, SECRET_BODY, SECRET_THINKING];
	const assertSafe = (thunk: () => unknown, code: V2PolicyErrorCode): void => {
		const err = expectCode(thunk, code);
		for (const s of secrets) {
			assert.ok(!err.message.includes(s), `error message leaks "${s}": ${err.message}`);
		}
	};

	assertSafe(() => computePaginationV2([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: SECRET_PATH } }] } }]), "INVALID_CALL_ID");
	assertSafe(() => computePaginationV2([readCall(SECRET_CALL_ID, SECRET_PATH), readCall(SECRET_CALL_ID, "g.txt")]), "DUPLICATE_CALL_ID");
	assertSafe(() => computePaginationV2([readCall(SECRET_CALL_ID, SECRET_PATH), { type: "message", message: { role: "toolResult", toolName: "read", content: SECRET_BODY } }]), "INVALID_RESULT_ID");
	assertSafe(() => computePaginationV2([readResult(SECRET_CALL_ID, SECRET_BODY)]), "UNKNOWN_RESULT_ID");
	assertSafe(() => computePaginationV2([readCall(SECRET_CALL_ID, SECRET_PATH), readResult(SECRET_CALL_ID, SECRET_BODY), readResult(SECRET_CALL_ID, SECRET_BODY)]), "RESULT_ALREADY_CONSUMED");
	assertSafe(() => computePaginationV2([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: `${SECRET_PATH}\x00` } }] } }]), "INVALID_CALL_PATH");
	assertSafe(() => computePaginationV2([readCall("c1", SECRET_PATH), readResult("c1", `${NRO_FACTS_MARKER} complete=false SECRETKEY-9f2c=1 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`)]), "FACTS_MALFORMED");
	// Duplicate-marker FACTS_MALFORMED: the error must not leak the secret
	// body/ID/path sitting between or adjacent to the two valid marker lines.
	assertSafe(
		() => computePaginationV2([readCall(SECRET_CALL_ID, SECRET_PATH), readResult(SECRET_CALL_ID, `${markerLine({ complete: false })}\n${SECRET_BODY}\n${markerLine({ complete: false })}`)]),
		"FACTS_MALFORMED",
	);
	assertSafe(
		() => computePaginationV2([readCall(SECRET_CALL_ID, SECRET_PATH), readResult(SECRET_CALL_ID, [{ type: "text", text: `${markerLine({ complete: false })}\n${SECRET_BODY}` }, { type: "text", text: markerLine({ complete: false }) }])]),
		"FACTS_MALFORMED",
	);
});

test("privacy: returned facts JSON never carries ids, paths, bodies or thinking", () => {
	const entries = [
		readCall(SECRET_CALL_ID, SECRET_PATH),
		readResult(SECRET_CALL_ID, `${markerLine({ complete: false })}\n${SECRET_BODY}`),
		readCall("c2", SECRET_PATH, { offset: 100 }),
		readResult("c2", `${SECRET_BODY} legacy`),
		readCall("c3", SECRET_PATH),
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", text: SECRET_THINKING }] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: SECRET_BODY }] } },
	];
	const facts = computePaginationV2(entries);
	const json = JSON.stringify(facts);
	for (const s of [SECRET_CALL_ID, SECRET_PATH, SECRET_BODY, SECRET_THINKING]) {
		assert.ok(!json.includes(s), `returned facts JSON leaks "${s}": ${json}`);
	}
	// The facts object is aggregate-only: numbers, booleans and null.
	assert.deepEqual(facts, {
		previewResults: 1,
		previewBytes: utf8Bytes(`${markerLine({ complete: false })}\n${SECRET_BODY}`),
		continuationReads: 1,
		continuationBytes: utf8Bytes(`${SECRET_BODY} legacy`),
		obligations: 1,
		obligationsPaginated: 1,
		reachedComplete: 0,
		completionFraction: 1,
		reachedFraction: 0,
		unpaginatedPreviews: 0,
		misuse: false,
		orphanReadCalls: 1,
		errorReadResults: 0,
	} satisfies PaginationFactsV2);

	// Rubric evaluation over secret-bearing text leaks nothing either.
	const rubricJson = JSON.stringify(evaluateRubricV2(`${SECRET_BODY}\n${RUBRIC_FULL_TEXT}\n${SECRET_THINKING}`));
	for (const s of [SECRET_CALL_ID, SECRET_PATH, SECRET_BODY, SECRET_THINKING]) {
		assert.ok(!rubricJson.includes(s), `rubric JSON leaks "${s}": ${rubricJson}`);
	}
	assert.deepEqual(evaluateRubricV2(RUBRIC_FULL_TEXT).checks.map((c) => c.id), V2_RUBRIC_CHECKS.map((c) => c.id));
});
