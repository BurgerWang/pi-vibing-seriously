/**
 * NRO N1/N2 native-tool policy — deterministic `read` preview, the exact
 * `grep` count semantics, and the three fixed same-name override definitions
 * (Commander Native Tool Optimization plan,
 * `docs/plans/commander-native-tool-optimization.md` §6).
 *
 * Pure and Pi-free (only Node builtins + typebox + type-only package imports),
 * so it is unit-testable with plain `node:test` like every other `core/*`
 * module. The extension (`index.ts`) is the only Pi adapter: it registers the
 * three overrides statically (fixed `read → grep → find` order, then the 11
 * catalog tools) and delegates the legacy read branches to the captured
 * built-in `createReadToolDefinition(ctx.cwd)` execution path.
 *
 * Contract (plan §6.1, frozen in the N0 benchmark protocol §8.4):
 *   - a text `read` WITHOUT `offset`/`limit` returns either the complete
 *     file content byte-for-byte (built-in content) plus the frozen nine-fact
 *     `nro-read-facts:` line, or a deterministic preview of the first
 *     `min(240 lines, 12 KiB)` cut at line boundaries (with the documented
 *     oversized-line prefix representation) plus the same facts line;
 *   - caps: PREVIEW_MAX_LINES = 240, PREVIEW_MAX_UTF8_BYTES = 12 * 1024
 *     (12,288), PREVIEW_MAX_LINE_UTF8_BYTES = 2048 — fixed static constants;
 *   - byte accounting is UTF-8-exact and code-point-safe: returned_bytes is
 *     the byte length of the returned content (line representations plus the
 *     separating newlines), total_bytes is the byte length of the full file
 *     text, so `returned_bytes <= 12288` always holds and the facts trailer
 *     is never counted;
 *   - trailing-newline boundary: the terminal `\n` is RESERVED on the last
 *     real line — the last line's contribution includes its terminal
 *     newline, so when "last line + terminal newline" would exceed 12288
 *     the last line is NOT returned, `complete=false` and `next_offset`
 *     points at that last real line (the legacy offset re-read returns it
 *     WITH its newline, so the file stays reconstructable with no content
 *     lost); a preview built over already-truncated built-in content (a
 *     `totals` override) is NEVER complete;
 *   - line counting mirrors the built-in read tool exactly: a trailing
 *     newline's phantom empty line is part of the content but is not counted
 *     as a line (same semantics as Pi's `truncateHead`), so `total_lines`
 *     agrees with the built-in's own `TruncationResult.totalLines` on every
 *     path;
 *   - the facts trailer is a single line of the exact frozen form
 *     `nro-read-facts: complete=<true|false> returned_lines=<n> ...`
 *     (nine facts, fixed order, single spaces); `next_offset` is 0 when
 *     complete, else `returned_lines + 1` (line-boundary cut) or the
 *     truncated line's own number (`line_truncated=true`);
 *   - `details` is undefined when complete and otherwise carries exactly a
 *     valid built-in `TruncationResult`-only object (`{ truncation }`) so
 *     the inherited built-in renderer shows its standard truncation warning;
 *     no additive details keys ever appear.
 *
 * Path normalization for the second read-only reads (the >50KB-first-line
 * case, where the built-in cannot return the content, and the image-note
 * magic-byte sniff) replicates Pi 0.83.0's `resolveToCwd` +
 * `resolveReadPathAsync` semantics — unicode-space normalization, leading-`@`
 * strip, tilde expansion, `file://` handling, absolute-vs-relative
 * resolution and the macOS AM/PM / NFD / curly-quote variant fallbacks — so
 * `@`/relative/absolute parity with the built-in is preserved (proven by
 * tests) and errors are never weakened.
 *
 * Image-note disambiguation (plan §6.1 / §9 row 6): a text-only built-in
 * result whose text starts with the built-in image note (`Read image file
 * [<mime>]` — a failed decode/resize or an unprocessed BMP) is validated
 * against the source file's magic bytes; when the sniffed MIME agrees with
 * the note's MIME the result is an image-path result and passes through
 * byte-identically (the preview never applies to images). A genuine text
 * file starting with the same phrase has no matching magic bytes and still
 * gets the deterministic preview + facts.
 */

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReadToolDetails, TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Frozen preview caps (plan §6.1 — fixed static starting values, never
// derived from dynamic state)
// ---------------------------------------------------------------------------

/** Maximum number of lines returned by a preview (line-boundary cut). */
export const PREVIEW_MAX_LINES = 240;
/** Maximum bytes of returned preview content (facts trailer excluded). */
export const PREVIEW_MAX_UTF8_BYTES = 12 * 1024;
/** Maximum UTF-8 bytes of a single returned line's full representation. */
export const PREVIEW_MAX_LINE_UTF8_BYTES = 2048;
/** Fixed inline marker appended to a prefix-represented oversized line. */
export const PREVIEW_LINE_TRUNCATION_MARKER = " [line truncated]";

/** Frozen preview-facts marker (N0 benchmark protocol §8.4). */
export const NRO_FACTS_MARKER = "nro-read-facts:";

/** The nine frozen facts, in the exact frozen order (protocol §8.4). */
export const PREVIEW_FACTS_KEYS = [
	"complete",
	"returned_lines",
	"returned_bytes",
	"total_lines",
	"total_bytes",
	"omitted_lines",
	"omitted_bytes",
	"next_offset",
	"line_truncated",
] as const;

// ---------------------------------------------------------------------------
// Static override metadata (plan §7.1: no dynamic facts, ever)
// ---------------------------------------------------------------------------

/** The three fixed same-name native overrides, in the fixed registration order. */
export const NATIVE_OVERRIDE_NAMES = ["read", "grep", "find"] as const;

export type NativeOverrideName = (typeof NATIVE_OVERRIDE_NAMES)[number];

export interface NativeOverrideMeta {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
}

/**
 * The §6.4 guideline bullet — the ONE static addition to the read override's
 * re-declared built-in metadata (verbatim from the plan). The count-mode
 * phrase is actionable since the grep count mode landed in N2; it is part
 * of the single combined N1/N2 metadata transition and is static text.
 */
export const READ_PREVIEW_GUIDELINE =
	"Use read with explicit offset/limit (or follow next_offset until complete: true) when a file's complete content is required (SKILL.md, AGENTS.md, Pi docs, plans, baselines, run logs); prefer grep output=count for existence/occurrence questions.";

/**
 * The mirrored §6.4 bullet on the grep override — the SAME static
 * continuation/count guideline text (plan §6.4: the bullet is added to the
 * read override "and mirrored in the grep bullet"). Part of the single
 * combined N1/N2 metadata transition.
 */
export const GREP_COUNT_GUIDELINE = READ_PREVIEW_GUIDELINE;

/**
 * Static metadata of the three overrides. The descriptions/promptSnippet/
 * promptGuidelines are the Pi 0.83.0 built-in strings verbatim (Pi does not
 * inherit prompt metadata for overrides, plan §5.1) with the two §6.4
 * additions: read adds exactly the one continuation/count guideline bullet
 * (N1), and grep mirrors the same bullet (N2) and appends the count-mode
 * sentence to its description. find keeps the built-in metadata untouched
 * (N3 depth/count modes are not exposed). Pinned by tests against
 * `createReadToolDefinition(".")` / `createGrepToolDefinition(".")` /
 * `createFindToolDefinition(".")`.
 */
export const NATIVE_OVERRIDE_METADATA: Readonly<Record<NativeOverrideName, NativeOverrideMeta>> = {
	read: {
		name: "read",
		label: "read",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed.", READ_PREVIEW_GUIDELINE],
	},
	grep: {
		name: "grep",
		label: "grep",
		description:
			"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars. Use output=count for an exact uncapped count: the result is one line `count kind=<matches|lines> value=<n> files=<n>` (count_kind=matches counts occurrences, count_kind=lines counts matching lines, files counts distinct matching files); legacy limit/context never apply to count mode.",
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		promptGuidelines: [GREP_COUNT_GUIDELINE],
	},
	find: {
		name: "find",
		label: "find",
		description:
			"Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).",
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		promptGuidelines: [],
	},
};

/**
 * Parameter schemas of the three overrides — the Pi 0.83.0 built-in schemas
 * (legacy parameter shapes stay valid) plus, since N2, exactly the two
 * optional grep selectors `output` and `count_kind` appended in fixed source
 * order; find exposes no count/depth parameters (N3 not implemented). Built
 * in source order so `canonicalHash(parameters)` is stable across runs and
 * installs. Pinned by tests against the captured built-in definitions'
 * schemas.
 */
export const NATIVE_OVERRIDE_PARAMETERS = {
	read: Type.Object({
		path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
		offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	}),
	grep: Type.Object({
		pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
		path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
		glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
		context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
		output: Type.Optional(
			Type.Union([Type.Literal("matches"), Type.Literal("count")], {
				description: "Result shape: matches (legacy matching lines, default) or count (one exact uncapped count line `count kind=<matches|lines> value=<n> files=<n>`, never capped by limit/context)",
			}),
		),
		count_kind: Type.Optional(
			Type.Union([Type.Literal("matches"), Type.Literal("lines")], {
				description: "Count granularity when output=count: matches counts all occurrences, lines counts matching lines (default: matches)",
			}),
		),
	}),
	find: Type.Object({
		pattern: Type.String({
			description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
		}),
		path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
	}),
} as const;

// ---------------------------------------------------------------------------
// Grep count-mode semantics (plan §6.2 — exact, uncapped, compact)
// ---------------------------------------------------------------------------

/** The two count granularities (plan §6.2 `count_kind`). */
export type GrepCountKind = "matches" | "lines";

/**
 * The exact compact count result line (plan §6.2): a single line
 * `count kind=<matches|lines> value=<n> files=<n>` with non-negative
 * integers; `details` is left undefined by the caller. `value` is the sum of
 * the per-file counts over the full scan (never capped by the legacy
 * `limit`), `files` is the number of distinct matching files.
 */
export function formatGrepCountLine(kind: GrepCountKind, value: number, files: number): string {
	return `count kind=${kind} value=${value} files=${files}`;
}

// ---------------------------------------------------------------------------
// Pi-equivalent path normalization (second read-only read, plan §6.1)
// ---------------------------------------------------------------------------

/** Same unicode-space class as Pi's normalizePath (utils/paths). */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, "\u2019");
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Replicates Pi 0.83.0 `normalizePath(input, options)` for the exact options
 * the read tool uses (unicode-space normalization, leading-`@` strip, tilde
 * expansion, `file://` decoding).
 */
export function nativeNormalizePath(input: string, options: { trim?: boolean; normalizeUnicodeSpaces?: boolean; stripAtPrefix?: boolean; expandTilde?: boolean; homeDir?: string } = {}): string {
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (options.expandTilde ?? true) {
		const home = options.homeDir ?? homedir();
		if (normalized === "~") return home;
		if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
			return join(home, normalized.slice(2));
		}
	}
	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized);
	}
	return normalized;
}

/**
 * Replicates Pi 0.83.0 `resolvePath(input, baseDir, options)` for the
 * `resolveToCwd` options the built-in read tool uses.
 */
export function nativeResolvePath(input: string, baseDir = process.cwd(), options: { trim?: boolean; normalizeUnicodeSpaces?: boolean; stripAtPrefix?: boolean; expandTilde?: boolean; homeDir?: string } = {}): string {
	const normalized = nativeNormalizePath(input, options);
	const normalizedBaseDir = nativeNormalizePath(baseDir);
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

/**
 * Replicates Pi 0.83.0 `resolveReadPathAsync` (path-utils): `resolveToCwd`
 * plus the macOS AM/PM (narrow no-break space), NFD and curly-quote variant
 * fallbacks, each applied only when the previous candidate does not exist.
 * Returns the base resolution when nothing exists (exactly like the
 * built-in, so the built-in's own error text governs missing files).
 */
export async function nativeResolveReadPath(filePath: string, cwd: string): Promise<string> {
	const resolved = nativeResolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
	if (await pathExists(resolved)) return resolved;
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && (await pathExists(amPmVariant))) return amPmVariant;
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && (await pathExists(nfdVariant))) return nfdVariant;
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && (await pathExists(curlyVariant))) return curlyVariant;
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) return nfdCurlyVariant;
	return resolved;
}

// ---------------------------------------------------------------------------
// Deterministic preview + facts (plan §6.1)
// ---------------------------------------------------------------------------

/** The nine frozen preview facts (protocol §8.4 key order). */
export interface ReadPreviewFacts {
	complete: boolean;
	returned_lines: number;
	returned_bytes: number;
	total_lines: number;
	total_bytes: number;
	omitted_lines: number;
	omitted_bytes: number;
	next_offset: number;
	line_truncated: boolean;
}

/** Optional totals override — used when the built-in already head-truncated. */
export interface ReadPreviewTotals {
	totalLines: number;
	totalBytes: number;
}

/** Result of the deterministic preview builder. */
export interface NativeReadPreview {
	/** The full result text: preview content + "\n" + the frozen facts line. */
	content: string;
	/** The nine frozen facts. */
	facts: ReadPreviewFacts;
	/** The preview content WITHOUT the facts trailer (truncation.content). */
	previewContent: string;
	/**
	 * Built-in ReadToolDetails: undefined when complete; exactly
	 * `{ truncation }` (a valid TruncationResult) when truncated. No
	 * additive keys ever.
	 */
	details: ReadToolDetails | undefined;
}

/** Longest UTF-8-safe prefix of `s` within `maxBytes`, never splitting a code point. */
function utf8PrefixWithinBytes(s: string, maxBytes: number): string {
	if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
	let out = "";
	let bytes = 0;
	for (const ch of s) {
		const chBytes = Buffer.byteLength(ch, "utf8");
		if (bytes + chBytes > maxBytes) break;
		out += ch;
		bytes += chBytes;
	}
	return out;
}

/** The frozen facts line: `nro-read-facts: <nine key=value facts, single spaces>`. */
export function formatReadFactsLine(facts: ReadPreviewFacts): string {
	return (
		`${NRO_FACTS_MARKER} complete=${String(facts.complete)} ` +
		`returned_lines=${facts.returned_lines} returned_bytes=${facts.returned_bytes} ` +
		`total_lines=${facts.total_lines} total_bytes=${facts.total_bytes} ` +
		`omitted_lines=${facts.omitted_lines} omitted_bytes=${facts.omitted_bytes} ` +
		`next_offset=${facts.next_offset} line_truncated=${String(facts.line_truncated)}`
	);
}

/**
 * Build the deterministic read preview over the full text (or, when `totals`
 * is supplied, over the built-in's head-truncated content with the built-in's
 * own total facts — the preview window is always inside the built-in's
 * 50KB/2000-line window, plan §6.1).
 *
 * Semantics:
 *   - lines are the file's content lines; a trailing newline's phantom empty
 *     line is content but never counted as a line (truncateHead parity);
 *   - a line longer than PREVIEW_MAX_LINE_UTF8_BYTES is represented by the
 *     longest code-point-safe prefix plus the fixed marker, becomes the last
 *     returned line and stops the walk (line_truncated=true,
 *     next_offset = its own number);
 *   - otherwise the walk stops at 240 lines or 12288 returned bytes
 *     (content + separators, exactly the built-in's own accounting basis),
 *     cutting at line boundaries; the terminal newline of a trailing-newline
 *     file is RESERVED on the last real line, so "last line + terminal
 *     newline" must fit inside the cap — when it does not the last line is
 *     not returned, complete=false and next_offset points at it (the legacy
 *     offset re-read returns line + newline);
 *   - a `totals` override means the built-in already truncated the content:
 *     the preview is NEVER complete on that path, whatever the window;
 *   - same input + same caps → identical preview and facts, always.
 */
export function buildReadPreview(text: string, totals?: ReadPreviewTotals): NativeReadPreview {
	const allLines = text.split("\n");
	// truncateHead parity: the phantom trailing "" of a trailing-newline file
	// is content but not a counted line (empty text has no lines at all).
	const lines = text.length === 0 ? [] : text.endsWith("\n") ? allLines.slice(0, -1) : allLines;
	const totalLines = totals?.totalLines ?? lines.length;
	const totalBytes = totals?.totalBytes ?? Buffer.byteLength(text, "utf8");

	const returned: string[] = [];
	let returnedBytes = 0;
	let lineTruncated = false;
	let stoppedBy: "lines" | "bytes" | null = null;

	const hasTrailingNewline = text.length > 0 && text.endsWith("\n");
	for (let i = 0; i < lines.length; i += 1) {
		if (returned.length >= PREVIEW_MAX_LINES) {
			stoppedBy = "lines";
			break;
		}
		const line = lines[i]!;
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (lineBytes > PREVIEW_MAX_LINE_UTF8_BYTES) {
			const representation =
				utf8PrefixWithinBytes(line, PREVIEW_MAX_LINE_UTF8_BYTES - Buffer.byteLength(PREVIEW_LINE_TRUNCATION_MARKER, "utf8")) +
				PREVIEW_LINE_TRUNCATION_MARKER;
			const representationBytes = Buffer.byteLength(representation, "utf8");
			const contribution = representationBytes + (returned.length > 0 ? 1 : 0);
			if (returnedBytes + contribution > PREVIEW_MAX_UTF8_BYTES) {
				stoppedBy = "bytes";
				break;
			}
			returned.push(representation);
			returnedBytes += contribution;
			lineTruncated = true;
			stoppedBy = "lines";
			break;
		}
		// Trailing-newline boundary: the terminal "\n" is reserved on the
		// LAST real line, so "last line + terminal newline" must fit inside
		// the cap. When it does not, the last line is NOT returned:
		// complete=false and next_offset points at that last real line, so
		// the legacy offset re-read returns it WITH its newline and the file
		// stays reconstructable with no content lost.
		const terminalNewlineBytes = hasTrailingNewline && i === lines.length - 1 ? 1 : 0;
		const contribution = lineBytes + (returned.length > 0 ? 1 : 0) + terminalNewlineBytes;
		if (returnedBytes + contribution > PREVIEW_MAX_UTF8_BYTES) {
			stoppedBy = "bytes";
			break;
		}
		returned.push(line);
		returnedBytes += contribution;
	}

	const complete = stoppedBy === null && !lineTruncated && totals === undefined;
	// The phantom trailing newline is part of the returned content only when
	// the whole file was returned (byte-for-byte built-in parity). Its byte
	// is already reserved inside the last real line's contribution, so
	// returnedBytes includes it and no phantom addition is ever needed.
	const phantomBytes = complete && hasTrailingNewline ? 1 : 0;
	const previewContent = returned.join("\n") + (phantomBytes === 1 ? "\n" : "");
	const returnedBytesTotal = returnedBytes;
	const returnedLines = returned.length;
	const omittedLines = totalLines - returnedLines + (lineTruncated ? 1 : 0);
	const omittedBytes = totalBytes - returnedBytesTotal;
	const nextOffset = complete ? 0 : returnedLines + (lineTruncated ? 0 : 1);

	const facts: ReadPreviewFacts = {
		complete,
		returned_lines: returnedLines,
		returned_bytes: returnedBytesTotal,
		total_lines: totalLines,
		total_bytes: totalBytes,
		omitted_lines: omittedLines,
		omitted_bytes: omittedBytes,
		next_offset: nextOffset,
		line_truncated: lineTruncated,
	};

	let details: ReadToolDetails | undefined;
	if (!complete) {
		const truncation: TruncationResult = {
			content: previewContent,
			truncated: true,
			truncatedBy: stoppedBy === "bytes" ? "bytes" : "lines",
			totalLines,
			totalBytes,
			outputLines: returnedLines,
			outputBytes: returnedBytesTotal,
			lastLinePartial: lineTruncated,
			firstLineExceedsLimit: false,
			maxLines: PREVIEW_MAX_LINES,
			maxBytes: PREVIEW_MAX_UTF8_BYTES,
		};
		details = { truncation };
	}

	return {
		content: previewContent + "\n" + formatReadFactsLine(facts),
		facts,
		previewContent,
		details,
	};
}

// ---------------------------------------------------------------------------
// Image-note disambiguation (plan §6.1 / §9 row 6: the preview never applies
// to image-path results, even when the built-in result is text-only)
// ---------------------------------------------------------------------------

/** Same sniff window as Pi 0.83.0's detectSupportedImageMimeTypeFromFile. */
export const IMAGE_SNIFF_BYTES = 4100;

const IMAGE_PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWithBytes(buffer: Uint8Array, bytes: readonly number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index += 1) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) +
		((buffer[offset + 1] ?? 0) << 8) +
		((buffer[offset + 2] ?? 0) << 16) +
		(buffer[offset + 3] ?? 0) * 0x1000000
	);
}

function isPng(buffer: Uint8Array): boolean {
	return buffer.length >= 16 && readUint32BE(buffer, IMAGE_PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR");
}

function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = IMAGE_PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

function isBmp(buffer: Uint8Array): boolean {
	if (buffer.length < 26) return false;
	const declaredFileSize = readUint32LE(buffer, 2);
	const pixelDataOffset = readUint32LE(buffer, 10);
	const dibHeaderSize = readUint32LE(buffer, 14);
	if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
	if (pixelDataOffset < 14 + dibHeaderSize) return false;
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;
	let colorPlanes: number;
	let bitsPerPixel: number;
	if (dibHeaderSize === 12) {
		colorPlanes = readUint16LE(buffer, 22);
		bitsPerPixel = readUint16LE(buffer, 24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		if (buffer.length < 30) return false;
		colorPlanes = readUint16LE(buffer, 26);
		bitsPerPixel = readUint16LE(buffer, 28);
	} else {
		return false;
	}
	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

/**
 * Magic-byte MIME sniffing with the EXACT same rules as Pi 0.83.0's built-in
 * `detectSupportedImageMimeType` (JPEG/PNG/GIF/WEBP/BMP, incl. the
 * animated-PNG and BMP-header validity checks). Pure; used to validate a
 * text-only built-in image note against the source file.
 */
export function sniffImageMimeType(buffer: Uint8Array): string | null {
	if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) {
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	if (startsWithBytes(buffer, IMAGE_PNG_SIGNATURE)) {
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	if (startsWithAscii(buffer, 0, "GIF")) {
		return "image/gif";
	}
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}
	if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
		return "image/bmp";
	}
	return null;
}

/** The built-in's image-note prefix (`Read image file [<mime>]`). */
export const READ_IMAGE_NOTE_PREFIX = "Read image file [";

/**
 * Parse the MIME out of a built-in read image note ("Read image file
 * [<mime>]") or return null when the text is not such a note. The MIME is
 * restricted to the five supported image types the built-in can produce.
 */
export function imageMimeFromReadNote(text: string): string | null {
	if (!text.startsWith(READ_IMAGE_NOTE_PREFIX)) return null;
	const rest = text.slice(READ_IMAGE_NOTE_PREFIX.length);
	const bracket = rest.indexOf("]");
	if (bracket === -1) return null;
	const mime = rest.slice(0, bracket);
	return /^image\/(jpeg|png|gif|webp|bmp)$/.test(mime) ? mime : null;
}
