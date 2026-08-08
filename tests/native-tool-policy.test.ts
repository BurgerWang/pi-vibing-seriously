/**
 * NRO N1/N2 native-tool policy tests — pure `core/native-tool-policy.ts`
 * (Commander Native Tool Optimization plan §9 matrix rows 2–5, 8, 20 at the
 * policy level — the N1 read preview/facts plus the N2 grep count selectors
 * and count-line format — plus the frozen §8.4 facts-line contract and the
 * Pi-equivalent path normalization). Schema/metadata byte-parity pins use
 * the captured Pi 0.83.0 built-in definitions as the oracle.
 *
 * The integration/wiring surface (registered overrides through the real
 * workbench runtime, legacy byte-parity vs captured built-ins, images,
 * abort/errors, pagination, registered count scans) lives in
 * tests/native-tool-wiring.test.ts.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
	buildReadPreview,
	formatGrepCountLine,
	formatReadFactsLine,
	GREP_COUNT_GUIDELINE,
	IMAGE_SNIFF_BYTES,
	imageMimeFromReadNote,
	NATIVE_OVERRIDE_METADATA,
	NATIVE_OVERRIDE_NAMES,
	NATIVE_OVERRIDE_PARAMETERS,
	NRO_FACTS_MARKER,
	nativeNormalizePath,
	nativeResolvePath,
	nativeResolveReadPath,
	PREVIEW_FACTS_KEYS,
	PREVIEW_LINE_TRUNCATION_MARKER,
	PREVIEW_MAX_LINE_UTF8_BYTES,
	PREVIEW_MAX_LINES,
	PREVIEW_MAX_UTF8_BYTES,
	READ_PREVIEW_GUIDELINE,
	sniffImageMimeType,
	type NativeReadPreview,
	type ReadPreviewFacts,
} from "../extensions/workbench-runtime/core/native-tool-policy.ts";
import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import { withTempDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Facts-line parsing (mirrors the frozen analyzer contract, protocol §8.4)
// ---------------------------------------------------------------------------

/** The nine facts of a result text, parsed with the frozen analyzer semantics. */
function parseFacts(text: string): ReadPreviewFacts | null {
	const idx = text.indexOf(NRO_FACTS_MARKER);
	if (idx === -1) return null;
	let lineEnd = text.indexOf("\n", idx);
	if (lineEnd === -1) lineEnd = text.length;
	const line = text.slice(idx + NRO_FACTS_MARKER.length, lineEnd).trim();
	const tokens = line.split(/\s+/).filter((t) => t.length > 0);
	assert.equal(tokens.length, PREVIEW_FACTS_KEYS.length, "facts line must carry exactly the nine frozen key=value facts");
	const values = new Map<string, string>();
	for (const token of tokens) {
		const eq = token.indexOf("=");
		assert.ok(eq > 0, `facts token must be key=value: ${token}`);
		const key = token.slice(0, eq);
		assert.ok((PREVIEW_FACTS_KEYS as readonly string[]).includes(key), `unknown facts key ${key}`);
		assert.ok(!values.has(key), `duplicate facts key ${key}`);
		values.set(key, token.slice(eq + 1));
	}
	const boolOf = (key: string): boolean => {
		const v = values.get(key);
		assert.ok(v === "true" || v === "false", `${key} must be true or false`);
		return v === "true";
	};
	const intOf = (key: string): number => {
		const v = values.get(key);
		assert.ok(v !== undefined && /^\d+$/.test(v), `${key} must be a non-negative integer`);
		return Number(v);
	};
	return {
		complete: boolOf("complete"),
		returned_lines: intOf("returned_lines"),
		returned_bytes: intOf("returned_bytes"),
		total_lines: intOf("total_lines"),
		total_bytes: intOf("total_bytes"),
		omitted_lines: intOf("omitted_lines"),
		omitted_bytes: intOf("omitted_bytes"),
		next_offset: intOf("next_offset"),
		line_truncated: boolOf("line_truncated"),
	};
}

/** The frozen facts-line format, exactly as protocol §8.4 specifies it. */
const FACTS_LINE_RE =
	/^nro-read-facts: complete=(true|false) returned_lines=\d+ returned_bytes=\d+ total_lines=\d+ total_bytes=\d+ omitted_lines=\d+ omitted_bytes=\d+ next_offset=\d+ line_truncated=(true|false)$/;

function preview(text: string, totals?: { totalLines: number; totalBytes: number }): NativeReadPreview {
	return buildReadPreview(text, totals);
}

/** Deterministic cross-check: facts arithmetic must always be consistent. */
function assertFactsConsistent(p: NativeReadPreview): void {
	const f = p.facts;
	assert.equal(f.returned_lines, f.total_lines - f.omitted_lines + (f.line_truncated ? 1 : 0), "omitted_lines = total − returned + (line_truncated ? 1 : 0)");
	assert.equal(f.omitted_bytes, f.total_bytes - f.returned_bytes, "omitted_bytes = total_bytes − returned_bytes");
	assert.ok(f.omitted_lines >= 0 && f.omitted_bytes >= 0, "no negative omission facts");
	assert.ok(f.returned_bytes <= PREVIEW_MAX_UTF8_BYTES, "returned_bytes is a true bound (≤ 12 KiB)");
	assert.ok(f.returned_lines <= PREVIEW_MAX_LINES, "returned_lines ≤ 240");
	if (f.complete) {
		assert.equal(f.omitted_lines, 0, "complete ⇒ no omitted lines");
		assert.equal(f.omitted_bytes, 0, "complete ⇒ no omitted bytes");
		assert.equal(f.next_offset, 0, "complete ⇒ next_offset = 0 (not applicable)");
		assert.equal(f.line_truncated, false, "complete ⇒ no truncated line");
		assert.equal(f.returned_lines, f.total_lines, "complete ⇒ all lines returned");
		assert.equal(f.returned_bytes, f.total_bytes, "complete ⇒ all bytes returned");
	} else {
		assert.ok(f.next_offset > 0, "incomplete ⇒ next_offset identifies the first not-fully-returned line");
		assert.equal(f.next_offset, f.returned_lines + (f.line_truncated ? 0 : 1), "next_offset = returned_lines + 1, or the truncated line's own number");
	}
	// facts trailer is never part of returned_bytes (byteLength of the content
	// without the trailer must equal returned_bytes).
	const trailerStart = p.content.indexOf("\n" + NRO_FACTS_MARKER);
	assert.ok(trailerStart !== -1, "facts trailer present");
	assert.equal(Buffer.byteLength(p.content.slice(0, trailerStart), "utf8"), f.returned_bytes, "returned_bytes == byte length of the returned content (trailer excluded)");
}

// ---------------------------------------------------------------------------
// 1. Determinism (matrix row 2)
// ---------------------------------------------------------------------------

test("same file bytes + same caps → identical preview text and facts, independent of call order", () => {
	const text = "alpha\n" + "beta\n".repeat(500) + "omega";
	const a = preview(text);
	for (let i = 0; i < 5; i += 1) {
		const again = preview(text);
		assert.equal(again.content, a.content);
		assert.deepEqual(again.facts, a.facts);
		assert.deepEqual(again.details, a.details);
	}
	// identical across different builder invocations for the same input
	const b = preview(text.split("").reverse().join("")); // different input, different result
	assert.notEqual(b.content, a.content);
});

// ---------------------------------------------------------------------------
// 2. Complete small reads (matrix row 1 policy side): byte parity + facts
// ---------------------------------------------------------------------------

test("small text file: content byte-for-byte identical to the input, complete=true facts appended", () => {
	for (const text of ["line1\nline2\nline3", "line1\nline2\nline3\n", "single line", "", "\n", "a\r\nb\r\nc\r\n"]) {
		const p = preview(text);
		// byte-for-byte built-in parity: content == text, facts appended on a
		// new line (the built-in returns lines.join("\n") == text).
		const trailerStart = p.content.indexOf("\n" + NRO_FACTS_MARKER);
		assert.equal(p.content.slice(0, trailerStart), text, `content must equal the input byte-for-byte for ${JSON.stringify(text)}`);
		assert.ok(p.content.endsWith(formatReadFactsLine(p.facts)), "facts line is the trailer");
		const f = parseFacts(p.content);
		assert.ok(f, "facts parseable");
		assert.equal(f.complete, true);
		assertFactsConsistent(p);
		assert.equal(p.details, undefined, "complete ⇒ details undefined");
	}
});

test("empty file: deterministic zero facts with complete=true", () => {
	const p = preview("");
	assert.equal(p.previewContent, "");
	assert.deepEqual(p.facts, {
		complete: true,
		returned_lines: 0,
		returned_bytes: 0,
		total_lines: 0,
		total_bytes: 0,
		omitted_lines: 0,
		omitted_bytes: 0,
		next_offset: 0,
		line_truncated: false,
	});
	assert.equal(p.details, undefined);
	assertFactsConsistent(p);
});

test("trailing-newline phantom line: counted as content, never as a line (truncateHead parity)", () => {
	const p = preview("a\nb\n");
	// counting lines: 2; content bytes include the trailing newline (4).
	assert.equal(p.facts.total_lines, 2);
	assert.equal(p.facts.total_bytes, 4);
	assert.equal(p.facts.returned_lines, 2);
	assert.equal(p.facts.returned_bytes, 4);
	assert.equal(p.facts.complete, true);
	assert.equal(p.previewContent, "a\nb\n");
	assertFactsConsistent(p);
});

test("CRLF files: split on \\n only, \\r stays part of the line, byte accounting exact", () => {
	const text = "one\r\ntwo\r\nthree\r\n";
	const p = preview(text);
	assert.equal(p.previewContent, text, "content byte-for-byte identical");
	assert.equal(p.facts.total_lines, 3, "\\r lines count once");
	assert.equal(p.facts.total_bytes, Buffer.byteLength(text, "utf8"));
	assert.equal(p.facts.complete, true);
	assertFactsConsistent(p);
});

test("BOM file: BOM bytes are part of the first line's accounting", () => {
	const text = "\uFEFFalpha\nbeta\n";
	const p = preview(text);
	assert.equal(p.previewContent, text);
	assert.equal(p.facts.total_lines, 2);
	assert.equal(p.facts.total_bytes, Buffer.byteLength(text, "utf8"), "BOM counted as 3 bytes");
	assert.equal(p.facts.returned_bytes, p.facts.total_bytes);
	assert.equal(p.facts.complete, true);
	assertFactsConsistent(p);
});

// ---------------------------------------------------------------------------
// 3. Caps and line-boundary cuts (matrix rows 3–4)
// ---------------------------------------------------------------------------

test("line cap: ≥240-line file cuts at 240 lines, next_offset=241, omitted arithmetic exact", () => {
	const text = Array.from({ length: 250 }, (_, i) => `line-${i}`).join("\n");
	const p = preview(text);
	assert.equal(p.facts.complete, false);
	assert.equal(p.facts.returned_lines, 240);
	assert.equal(p.facts.total_lines, 250);
	assert.equal(p.facts.next_offset, 241);
	assert.equal(p.facts.omitted_lines, 10);
	assert.equal(p.facts.line_truncated, false);
	assert.equal(p.previewContent, text.split("\n").slice(0, 240).join("\n"), "line-boundary cut only");
	assertFactsConsistent(p);
	// details: exactly the valid truncation shape
	assert.ok(p.details, "truncated ⇒ details present");
	assert.deepEqual(Object.keys(p.details), ["truncation"], "no additive details keys");
	const truncation = p.details.truncation!;
	assert.equal(truncation.truncated, true);
	assert.equal(truncation.truncatedBy, "lines");
	assert.equal(truncation.totalLines, 250);
	assert.equal(truncation.outputLines, 240);
	assert.equal(truncation.maxLines, PREVIEW_MAX_LINES);
	assert.equal(truncation.maxBytes, PREVIEW_MAX_UTF8_BYTES);
	assert.equal(truncation.firstLineExceedsLimit, false);
	assert.equal(truncation.lastLinePartial, false);
	assert.equal(truncation.content, p.previewContent);
});

test("byte cap: 12 KiB cap hit first cuts at a line boundary and reports truncatedBy=bytes", () => {
	const line = "x".repeat(100); // 100 bytes + separator
	const text = Array.from({ length: 200 }, () => line).join("\n");
	const p = preview(text);
	assert.equal(p.facts.complete, false);
	assert.equal(p.facts.returned_bytes, 12220, "121 lines × 100 bytes + 120 separators = 12220 ≤ 12288");
	assert.equal(p.facts.returned_lines, 121);
	assert.equal(p.facts.next_offset, 122);
	assert.equal(p.facts.omitted_lines, 79);
	assert.equal(p.details?.truncation?.truncatedBy, "bytes");
	assertFactsConsistent(p);
});

test("exact boundary values: 240 lines and 12288 bytes are complete; one more cuts", () => {
	// exactly 240 lines, tiny bytes → complete
	const at240 = Array.from({ length: 240 }, (_, i) => `l${i}`).join("\n");
	assert.equal(preview(at240).facts.complete, true);
	// 241 lines → cut at 240
	const at241 = at240 + "\nl240";
	const p241 = preview(at241);
	assert.equal(p241.facts.complete, false);
	assert.equal(p241.facts.returned_lines, 240);
	assert.equal(p241.facts.next_offset, 241);
	// exactly 12288 bytes → complete
	const at12288 = Array.from({ length: 122 }, () => "y".repeat(99)).join("\n"); // 122*99 + 121 = 12199
	const exact = at12288 + "\n" + "z".repeat(12288 - 12199 - 1); // total 12288
	assert.equal(Buffer.byteLength(exact, "utf8"), 12288);
	assert.equal(preview(exact).facts.complete, true);
	// 12289 bytes → byte cut at a line boundary (12199 ≤ 12288)
	const over = exact + "z";
	const pOver = preview(over);
	assert.equal(pOver.facts.complete, false);
	assert.equal(pOver.facts.returned_bytes, 12199, "line-boundary cut only: 122 lines × 99 bytes + 121 separators");
	assert.equal(pOver.facts.next_offset, 123);
	assertFactsConsistent(pOver);
});

test("trailing-newline boundary: the terminal newline is reserved on the last real line (12288 complete without it; 12289 drops the last line)", () => {
	// fixture: six lines, EVERY one at or below the 2048-byte per-line
	// representation cap (five 2048-byte lines + one 2043-byte line), so the
	// aggregate byte cap and the terminal-newline reservation decide the
	// outcome — the per-line truncation rule never fires.
	const head = Array.from({ length: 5 }, () => "y".repeat(2048)).join("\n"); // 5×2048 + 4 separators = 10244 bytes
	const last = "z".repeat(2043);
	// 12288 bytes WITHOUT a terminal newline → complete=true, returned_bytes=12288
	const without = head + "\n" + last; // 10244 + 1 + 2043 = 12288
	assert.equal(Buffer.byteLength(without, "utf8"), 12288);
	const p1 = preview(without);
	assert.equal(p1.facts.complete, true);
	assert.equal(p1.facts.returned_bytes, 12288);
	assert.equal(p1.previewContent, without);
	assertFactsConsistent(p1);
	// the same lines + terminal newline = 12289 bytes: the last real line's
	// contribution reserves the terminal newline, so "last + \n" (2045
	// bytes) does not fit after the 10244 returned bytes — the line is NOT
	// returned, complete=false and next_offset points at it
	const withNl = without + "\n";
	assert.equal(Buffer.byteLength(withNl, "utf8"), 12289);
	const p2 = preview(withNl);
	assert.equal(p2.facts.complete, false);
	assert.equal(p2.facts.returned_lines, 5);
	assert.equal(p2.facts.next_offset, 6, "next_offset points at the last real line");
	assert.ok(p2.facts.returned_bytes <= PREVIEW_MAX_UTF8_BYTES, "returned_bytes ≤ 12 KiB");
	assert.equal(p2.facts.returned_bytes, 10244, "last line + terminal newline (2045 bytes) are not returned");
	assert.equal(p2.facts.total_bytes, 12289);
	assert.equal(p2.facts.omitted_bytes, 2045);
	assert.equal(p2.previewContent, head);
	assertFactsConsistent(p2);
	// the terminal reservation does NOT over-cut: 12288 bytes INCLUDING the
	// terminal newline is still complete (last line + newline fits exactly)
	const at12288WithNl = head + "\n" + "z".repeat(2042) + "\n"; // 10244 + 1 + 2042 + 1 = 12288
	assert.equal(Buffer.byteLength(at12288WithNl, "utf8"), 12288);
	const p3 = preview(at12288WithNl);
	assert.equal(p3.facts.complete, true);
	assert.equal(p3.facts.returned_bytes, 12288);
	assert.equal(p3.previewContent, at12288WithNl);
	assertFactsConsistent(p3);
	// reconstructability: the dropped last line stays re-readable WITH its
	// newline via the built-in's own offset semantics (allLines includes the
	// phantom empty string, so lines.slice(5).join("\n") == last + "\n")
	assert.equal(withNl.split("\n").slice(5).join("\n"), last + "\n");
});

// ---------------------------------------------------------------------------
// 4. Oversized single line (documented cap exception, matrix row 20)
// ---------------------------------------------------------------------------

test("huge single line: code-point-safe prefix + fixed marker, line_truncated=true, next_offset=1", () => {
	const text = "H".repeat(PREVIEW_MAX_LINE_UTF8_BYTES + 1) + "\ntail";
	const p = preview(text);
	assert.equal(p.facts.complete, false);
	assert.equal(p.facts.line_truncated, true);
	assert.equal(p.facts.returned_lines, 1);
	assert.equal(p.facts.next_offset, 1, "next_offset points at the truncated line itself");
	assert.equal(p.facts.total_lines, 2);
	assert.equal(p.facts.omitted_lines, 2, "total − returned + 1 (the truncated line's remainder)");
	assert.ok(p.previewContent.endsWith(PREVIEW_LINE_TRUNCATION_MARKER), "fixed inline marker present");
	assert.ok(
		Buffer.byteLength(p.previewContent, "utf8") <= PREVIEW_MAX_LINE_UTF8_BYTES,
		"prefix + marker representation stays within the per-line cap",
	);
	assertFactsConsistent(p);
});

test("a 2048-byte line is returned in full; 2049 bytes triggers the prefix representation", () => {
	const at = "w".repeat(2048);
	assert.equal(preview(at).facts.complete, true);
	assert.equal(preview(at).facts.line_truncated, false);
	const over = "w".repeat(2049);
	const p = preview(over + "\nrest");
	assert.equal(p.facts.line_truncated, true);
	assert.equal(p.facts.next_offset, 1);
});

test("Unicode oversized line: never splits a code point, UTF-8 byte accounting exact", () => {
	// 600 four-byte emoji = 2400 bytes > 2048
	const emojiLine = "😀".repeat(600);
	const p = preview(emojiLine + "\nafter");
	assert.equal(p.facts.line_truncated, true);
	assert.equal(p.facts.total_bytes, 2400 + 1 + 5);
	const rep = p.previewContent.slice(0, -PREVIEW_LINE_TRUNCATION_MARKER.length);
	// code-point-safe: the prefix decodes without replacement characters and
	// ends on a whole code point (no lone surrogate).
	const decoded = Buffer.from(rep, "utf8").toString("utf8");
	assert.ok(!decoded.includes("\uFFFD"), "no split code point");
	assert.ok(decoded.length % 2 === 0 && decoded.endsWith("😀"), "prefix ends with a whole code point");
	assert.ok(Buffer.byteLength(rep, "utf8") + Buffer.byteLength(PREVIEW_LINE_TRUNCATION_MARKER, "utf8") <= PREVIEW_MAX_LINE_UTF8_BYTES);
	assertFactsConsistent(p);
});

test("Unicode byte accounting: multi-byte and RTL content is exact and deterministic", () => {
	const text = "مرحبا بالعالم\n日本語のテキスト\nключ=значение\n";
	const p = preview(text);
	assert.equal(p.facts.total_bytes, Buffer.byteLength(text, "utf8"));
	assert.equal(p.facts.returned_bytes, p.facts.total_bytes);
	assert.equal(p.facts.complete, true);
	assert.equal(p.previewContent, text);
	assertFactsConsistent(p);
});

// ---------------------------------------------------------------------------
// 5. Built-in truncation-totals path (delegation of already-truncated content)
// ---------------------------------------------------------------------------

test("totals override: the built-in's own total facts are preserved on the truncated-content path", () => {
	const truncatedContent = "line1\nline2\nline3";
	const p = preview(truncatedContent, { totalLines: 2500, totalBytes: 145000 });
	assert.equal(p.facts.complete, false, "a built-in-truncated file can never be complete");
	assert.equal(p.facts.total_lines, 2500);
	assert.equal(p.facts.total_bytes, 145000);
	assert.equal(p.facts.returned_lines, 3);
	assert.equal(p.facts.next_offset, 4);
	assert.equal(p.facts.omitted_lines, 2497);
	assert.equal(p.facts.omitted_bytes, 145000 - Buffer.byteLength("line1\nline2\nline3", "utf8"));
	assertFactsConsistent(p);
});

// ---------------------------------------------------------------------------
// 6. Facts-line frozen format (protocol §8.4)
// ---------------------------------------------------------------------------

test("the facts line matches the frozen §8.4 format exactly (nine facts, fixed order, single spaces)", () => {
	for (const text of ["small", "x\n".repeat(300), "H".repeat(3000), ""]) {
		const p = preview(text);
		const line = p.content.slice(p.content.lastIndexOf("\n") + 1);
		assert.match(line, FACTS_LINE_RE, `frozen facts-line shape for ${JSON.stringify(text.slice(0, 20))}`);
		const keys = line.slice(NRO_FACTS_MARKER.length).trim().split(/\s+/).map((t) => t.split("=")[0]);
		assert.deepEqual(keys, [...PREVIEW_FACTS_KEYS], "exact nine facts in the frozen order");
	}
	// round-trip: formatReadFactsLine(parseFacts(content)) is parseable and equal
	const p = preview("a\n".repeat(300));
	assert.deepEqual(parseFacts(p.content), p.facts);
	assert.deepEqual(parseFacts(formatReadFactsLine(p.facts)), p.facts);
});

// ---------------------------------------------------------------------------
// 6b. Image-note disambiguation helpers (plan §9 row 6, policy side)
// ---------------------------------------------------------------------------

test("sniffImageMimeType: magic bytes agree with the built-in for JPEG/PNG/GIF/WEBP/BMP; text and bad magic return null", () => {
	// JPEG: FF D8 FF, marker byte 0xF7 excluded exactly like the built-in
	assert.equal(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])), "image/jpeg");
	assert.equal(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xf7, 0x00])), null, "JPEG with the 0xF7 marker byte is not supported by the built-in");
	// real 1x1 PNG and a PNG-signature file whose payload is garbage
	assert.equal(sniffImageMimeType(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")), "image/png");
	const corruptPng = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		Buffer.from([0x00, 0x00, 0x00, 0x0d]),
		Buffer.from("IHDR"),
		Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00]),
		Buffer.from("not a real png payload".repeat(8)),
	]);
	assert.equal(sniffImageMimeType(corruptPng), "image/png");
	// GIF / WEBP magic
	assert.equal(sniffImageMimeType(Buffer.from("GIF89a....")), "image/gif");
	assert.equal(sniffImageMimeType(Buffer.from("RIFF....WEBP....")), "image/webp");
	// BMP: header-valid only (same checks as the built-in)
	const bmp = Buffer.alloc(60);
	bmp.write("BM", 0, "ascii");
	bmp.writeUInt32LE(0, 2); // declared file size 0 → size checks skipped
	bmp.writeUInt32LE(54, 10); // pixel data offset
	bmp.writeUInt32LE(40, 14); // DIB header size
	bmp.writeUInt16LE(1, 26); // color planes
	bmp.writeUInt16LE(24, 28); // bits per pixel
	assert.equal(sniffImageMimeType(bmp), "image/bmp");
	assert.equal(sniffImageMimeType(Buffer.from("BM")), null, "BM alone is not a valid BMP");
	// text (including text starting with the image note) never sniffs as an image
	assert.equal(sniffImageMimeType(Buffer.from("Read image file [image/jpeg]\nThis is text.\n")), null);
	assert.equal(sniffImageMimeType(Buffer.from("")), null);
});

test("imageMimeFromReadNote: parses the built-in note MIME; non-notes and unknown MIMEs return null", () => {
	assert.equal(imageMimeFromReadNote("Read image file [image/jpeg]"), "image/jpeg");
	assert.equal(imageMimeFromReadNote("Read image file [image/png]\n[Image omitted: could not be converted.]"), "image/png");
	assert.equal(imageMimeFromReadNote("Read image file [image/bmp]\n[Image omitted: configure an imageProcessor to convert BMP images.]"), "image/bmp");
	assert.equal(imageMimeFromReadNote("Read image file [image/gif]"), "image/gif");
	assert.equal(imageMimeFromReadNote("Read image file [image/webp]"), "image/webp");
	assert.equal(imageMimeFromReadNote("Read image file [image/jpeg] is genuine text"), "image/jpeg", "the note prefix decides, not the whole line");
	assert.equal(imageMimeFromReadNote("Read image file [image/svg+xml]"), null, "unsupported MIME is not a built-in note MIME");
	assert.equal(imageMimeFromReadNote("Read image file []"), null);
	assert.equal(imageMimeFromReadNote("Read image file [image/jpeg"), null, "unterminated bracket");
	assert.equal(imageMimeFromReadNote("ordinary text"), null);
	assert.equal(imageMimeFromReadNote("Read image file without a bracket"), null);
});

// ---------------------------------------------------------------------------
// 7. Pi-equivalent path normalization (second read, plan §6.1)
// ---------------------------------------------------------------------------

test("nativeResolvePath: @-prefix strip, relative/absolute, tilde, unicode spaces, file://", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "a.txt");
		await writeFile(file, "x", "utf8");
		// leading @ and relative forms resolve identically to the plain path
		assert.equal(await nativeResolveReadPath("a.txt", dir), file);
		assert.equal(await nativeResolveReadPath("@a.txt", dir), file, "@-prefix parity");
		assert.equal(await nativeResolveReadPath("@./a.txt", dir), file);
		assert.equal(await nativeResolveReadPath(file, dir), file, "absolute parity");
		assert.equal(await nativeResolveReadPath(join(dir, "sub", "..", "a.txt"), dir), file, "dot-segment normalization");
		// unicode-space normalization (Pi normalizeUnicodeSpaces)
		assert.equal(nativeNormalizePath("a\u00A0b.txt", { normalizeUnicodeSpaces: true }), "a b.txt");
		assert.equal(nativeNormalizePath("@a.txt", { stripAtPrefix: true }), "a.txt");
		// tilde expansion matches os.homedir()
		assert.equal(nativeNormalizePath("~"), homedir());
		assert.equal(nativeResolvePath("~", dir), homedir());
		// file:// decoding
		assert.equal(nativeNormalizePath(`file://${file}`), file);
		// missing files fall back to the base resolution (never throw), so the
		// built-in's own access error text governs
		assert.equal(await nativeResolveReadPath("missing.txt", dir), join(dir, "missing.txt"));
		assert.equal(await nativeResolveReadPath("@missing.txt", dir), join(dir, "missing.txt"));
	});
});

test("nativeResolveReadPath macOS variants: AM/PM narrow no-break space, NFD and curly quote", async () => {
	await withTempDir(async (dir) => {
		// AM/PM screenshot: narrow no-break space before AM/PM
		const amPm = join(dir, "Screenshot 2026-08-06 at 10.30.00 AM.png");
		await writeFile(amPm, "x", "utf8");
		assert.equal(await nativeResolveReadPath("Screenshot 2026-08-06 at 10.30.00 AM.png", dir), amPm);
		// NFD-stored file (macOS stores filenames in NFD) found from an NFC
		// input via the NFD fallback
		const nfdStored = join(dir, "Photo d'e\u0301cran.png");
		await writeFile(nfdStored, "x", "utf8");
		assert.equal(await nativeResolveReadPath("Photo d'\u00E9cran.png", dir), nfdStored, "NFD fallback (NFC input → NFD-stored file)");
		// an NFC-stored file resolves from its own NFC spelling (no rewrite)
		const nfcStored = join(dir, "Capture d'\u00E9cran.png");
		await writeFile(nfcStored, "x", "utf8");
		assert.equal(await nativeResolveReadPath("Capture d'\u00E9cran.png", dir), nfcStored);
		// curly-quote variant: a U+2019-stored file is found from an
		// apostrophe input via the curly-quote fallback
		const curlyStored = join(dir, "Vue d\u2019\u00E9cran.png");
		await writeFile(curlyStored, "x", "utf8");
		assert.equal(await nativeResolveReadPath("Vue d'\u00E9cran.png", dir), curlyStored, "curly-quote fallback");
	});
});

// ---------------------------------------------------------------------------
// 8. Static metadata + schemas (matrix rows 16, 19 policy side; the N2 grep
// count selectors pinned against the captured Pi 0.83.0 built-in schemas)
// ---------------------------------------------------------------------------

/** The seven Pi 0.83.0 built-in grep properties, in the built-in source order. */
const BUILTIN_GREP_KEYS = ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"] as const;

interface BuiltinToolShape {
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: { type: string; required?: string[]; properties: Record<string, unknown> };
}

/** The captured Pi 0.83.0 built-in definitions (the byte-parity oracle). */
function builtinDefinitions(): { read: BuiltinToolShape; grep: BuiltinToolShape; find: BuiltinToolShape } {
	return {
		read: createReadToolDefinition(".") as unknown as BuiltinToolShape,
		grep: createGrepToolDefinition(".") as unknown as BuiltinToolShape,
		find: createFindToolDefinition(".") as unknown as BuiltinToolShape,
	};
}

test("override names are the fixed read → grep → find order; metadata is static; schemas hash stably", () => {
	assert.deepEqual([...NATIVE_OVERRIDE_NAMES], ["read", "grep", "find"]);
	for (const name of NATIVE_OVERRIDE_NAMES) {
		const meta = NATIVE_OVERRIDE_METADATA[name];
		assert.equal(meta.name, name);
		assert.ok(meta.description.length > 0, name);
		assert.ok(meta.promptSnippet.length > 0, name);
		// schema construction order is stable across builds
		assert.equal(canonicalHash(NATIVE_OVERRIDE_PARAMETERS[name]), canonicalHash(NATIVE_OVERRIDE_PARAMETERS[name]), name);
	}
});

test("read schema stays byte-identical to the built-in; read carries the built-in guideline plus the ONE §6.4 bullet", () => {
	const builtin = builtinDefinitions().read;
	assert.deepEqual(NATIVE_OVERRIDE_PARAMETERS.read, builtin.parameters, "read parameter schema byte-identical to the Pi 0.83.0 built-in");
	assert.deepEqual(NATIVE_OVERRIDE_METADATA.read.promptGuidelines.slice(0, 1), [...builtin.promptGuidelines], "read keeps the built-in guideline verbatim");
	assert.equal(NATIVE_OVERRIDE_METADATA.read.promptGuidelines[1], READ_PREVIEW_GUIDELINE);
	assert.equal(NATIVE_OVERRIDE_METADATA.read.promptGuidelines.length, 2);
});

test("find schema and metadata stay fully built-in-compatible (N3 count/depth not implemented)", () => {
	const builtin = builtinDefinitions().find;
	assert.deepEqual(NATIVE_OVERRIDE_PARAMETERS.find, builtin.parameters, "find parameter schema byte-identical to the Pi 0.83.0 built-in");
	assert.equal(NATIVE_OVERRIDE_METADATA.find.description, builtin.description, "find description built-in verbatim");
	assert.equal(NATIVE_OVERRIDE_METADATA.find.promptSnippet, builtin.promptSnippet, "find promptSnippet built-in verbatim");
	assert.deepEqual(NATIVE_OVERRIDE_METADATA.find.promptGuidelines, builtin.promptGuidelines ?? [], "find promptGuidelines unchanged (built-in has none)");
});

test("grep N2: byte-identical legacy property prefix, then exactly optional output matches|count and count_kind matches|lines; intended static count description; one mirrored guideline", () => {
	const builtin = builtinDefinitions().grep;
	const overrideProps = (NATIVE_OVERRIDE_PARAMETERS.grep as unknown as { properties: Record<string, unknown> }).properties;
	const builtinProps = builtin.parameters.properties;
	// the legacy property prefix stays byte-identical and in the SAME order
	assert.deepEqual(Object.keys(builtinProps), [...BUILTIN_GREP_KEYS], "built-in grep property order (oracle sanity)");
	assert.deepEqual(
		Object.keys(overrideProps),
		[...BUILTIN_GREP_KEYS, "output", "count_kind"],
		"exactly the two N2 selectors follow the byte-identical legacy prefix",
	);
	for (const key of BUILTIN_GREP_KEYS) {
		assert.deepEqual(overrideProps[key], builtinProps[key], `grep legacy property ${key} byte-identical`);
	}
	// both selectors are OPTIONAL (absent from required) with the exact unions
	const required = (NATIVE_OVERRIDE_PARAMETERS.grep as unknown as { required?: string[] }).required ?? [];
	assert.ok(!required.includes("output"), "output optional");
	assert.ok(!required.includes("count_kind"), "count_kind optional");
	const output = overrideProps.output as { anyOf?: Array<{ const?: string }> };
	assert.deepEqual((output.anyOf ?? []).map((a) => a.const), ["matches", "count"], "output union = matches|count in fixed order");
	const countKind = overrideProps.count_kind as { anyOf?: Array<{ const?: string }> };
	assert.deepEqual((countKind.anyOf ?? []).map((a) => a.const), ["matches", "lines"], "count_kind union = matches|lines in fixed order");
	// the intended static count description: the built-in verbatim plus the
	// count-mode sentence (the documented §6.2 wording, nothing else)
	assert.equal(
		NATIVE_OVERRIDE_METADATA.grep.description,
		`${builtin.description} Use output=count for an exact uncapped count: the result is one line \`count kind=<matches|lines> value=<n> files=<n>\` (count_kind=matches counts occurrences, count_kind=lines counts matching lines, files counts distinct matching files); legacy limit/context never apply to count mode.`,
		"grep description = the built-in verbatim prefix plus the intended static count-mode sentence",
	);
	assert.equal(NATIVE_OVERRIDE_METADATA.grep.promptSnippet, builtin.promptSnippet, "grep promptSnippet built-in verbatim");
	assert.deepEqual(NATIVE_OVERRIDE_METADATA.grep.promptGuidelines, [GREP_COUNT_GUIDELINE], "grep carries exactly the one mirrored §6.4 guideline bullet");
});

test("formatGrepCountLine: exact compact line for both kinds and non-negative values", () => {
	assert.equal(formatGrepCountLine("matches", 3, 1), "count kind=matches value=3 files=1");
	assert.equal(formatGrepCountLine("lines", 2, 1), "count kind=lines value=2 files=1");
	assert.equal(formatGrepCountLine("matches", 0, 0), "count kind=matches value=0 files=0");
	assert.equal(formatGrepCountLine("lines", 0, 0), "count kind=lines value=0 files=0");
	assert.equal(formatGrepCountLine("matches", 12, 0), "count kind=matches value=12 files=0");
	assert.equal(formatGrepCountLine("lines", 9007199254740991, 123456), "count kind=lines value=9007199254740991 files=123456");
	// the line is exactly one line: no newline, no surrounding whitespace
	for (const line of [formatGrepCountLine("matches", 1, 1), formatGrepCountLine("lines", 7, 3)]) {
		assert.equal(line.trim(), line, "no surrounding whitespace");
		assert.ok(!line.includes("\n"), "exactly one line");
	}
});
