/**
 * NRO v2 policy module (commander-native-tool-optimization plan) —
 * PURE offline policy, unit-tested hermetically. Implements (1) the
 * frozen six-check rubric evaluator over final assistant text and (2)
 * the strict toolCallId-attributed pagination facts over persisted Pi
 * session entries: exact-ID result matching, fail-closed attribution,
 * privacy-safe aggregates.
 *
 * This is a leaf module: no filesystem, no network, no runtime or
 * extension imports, no side effects on import.
 *
 * Recognized persisted Pi message shapes (session JSONL entries):
 *
 *   { type: "message", message: { role: "assistant", content: [...] } }
 *     content items of shape { type: "toolCall", id, name: "read",
 *     arguments: { path, offset?, limit? } } are read calls. Every other
 *     item (text, thinking, other tool names, provider-error assistant
 *     messages) is ignored and never shifts attribution.
 *   { type: "message", message: { role: "toolResult", toolName: "read",
 *     toolCallId, content, isError? } } are read results, matched to
 *     calls STRICTLY by exact toolCallId (never FIFO order).
 *
 * Fail-closed attribution (stable V2PolicyError codes; messages are
 * always generic — they never render ids, paths, arguments, message
 * bodies or thinking):
 *
 *   INVALID_CALL_ID          read toolCall id missing / not a string /
 *                            empty / > 512 UTF-8 bytes
 *   DUPLICATE_CALL_ID        a second read call reuses an already seen id
 *   INVALID_RESULT_ID        read toolResult toolCallId missing / not a
 *                            string / empty / > 512 UTF-8 bytes
 *   UNKNOWN_RESULT_ID        toolCallId matches no read call
 *   RESULT_ALREADY_CONSUMED  a second result for an already matched id
 *   INVALID_CALL_PATH        read call path not a bounded (<= 512 UTF-8
 *                            bytes) non-empty control-free string
 *   FACTS_MALFORMED          `nro-read-facts:` marker present but not the
 *                            exact one-line nine-field v1 contract —
 *                            including more than one marker occurrence
 *   RUBRIC_INVALID           defensive: a frozen rubric pattern fails to
 *                            compile (cannot happen with frozen constants)
 *
 * A read call with no matching result is an orphan: it is counted in
 * the aggregate `orphanReadCalls` and never shifts another association.
 * A matched result with isError:true consumes the id, increments
 * `errorReadResults` and contributes nothing else (no facts parse, no
 * preview/obligation/continuation/pagination/completion). Only matched
 * successful results contribute preview/continuation/obligation/
 * completion facts and inline-text UTF-8 bytes.
 */

// ---------------------------------------------------------------------------
// Frozen constants (v1 parity)
// ---------------------------------------------------------------------------

/** The frozen preview-facts marker emitted by read previews (v1 protocol §8.4). */
export const NRO_FACTS_MARKER = "nro-read-facts:";
/** Read call id and read result toolCallId cap (UTF-8 bytes). */
export const ID_MAX_BYTES = 512;
/** Read call path cap (UTF-8 bytes). */
export const PATH_MAX_BYTES = 512;
/** Numeric fact cap (v1 parity): every parsed preview-facts count must be a finite non-negative integer <= this. */
export const MAX_USAGE_FACT = 100_000_000_000;

// ---------------------------------------------------------------------------
// Frozen rubric (v1 values; unicode permits optional comma whitespace)
// ---------------------------------------------------------------------------

export interface RubricCheckV2 {
	id: string;
	pattern: string;
}

/**
 * The six frozen v2 rubric checks — the same exact expected values as
 * the v1 rubric (fixtures/commander-native-tool-benchmark/inputs/rubric.json)
 * except the unicode pattern, which permits optional whitespace around
 * the commas: `unicode:\s*α,\s*水,\s*🚀(?:\s|$)` accepts both
 * "α, 水, 🚀" and "α,水,🚀" while still rejecting wrong, missing or
 * reordered values.
 */
export const V2_RUBRIC_CHECKS: readonly RubricCheckV2[] = [
	{ id: "build", pattern: "build:\\s*alpha-42\\b" },
	{ id: "unicode", pattern: "unicode:\\s*α,\\s*水,\\s*🚀(?:\\s|$)" },
	{ id: "token", pattern: "token:\\s*delta-77\\b" },
	{ id: "needle_occurrences", pattern: "needle_occurrences:\\s*140\\b" },
	{ id: "needle_lines", pattern: "needle_lines:\\s*135\\b" },
	{ id: "needle_files", pattern: "needle_files:\\s*4\\b" },
];

export interface RubricEvaluationV2 {
	/** True only when every frozen check passes. */
	passed: boolean;
	/** Per-check results in frozen V2_RUBRIC_CHECKS order. */
	checks: Array<{ id: string; passed: boolean }>;
}

/**
 * Evaluate the frozen six-check rubric over the final assistant text.
 * Every check is independent: a wrong value, a missing fact, a
 * reordered unicode sequence or an absent required line fails exactly
 * that check and the overall result.
 */
export function evaluateRubricV2(finalText: string): RubricEvaluationV2 {
	const checks: Array<{ id: string; passed: boolean }> = [];
	let passed = true;
	for (const check of V2_RUBRIC_CHECKS) {
		let ok: boolean;
		try {
			ok = new RegExp(check.pattern).test(finalText);
		} catch {
			throw new V2PolicyError("RUBRIC_INVALID", "a frozen rubric pattern is not compilable");
		}
		checks.push({ id: check.id, passed: ok });
		if (!ok) passed = false;
	}
	return { passed, checks };
}

// ---------------------------------------------------------------------------
// Policy error (privacy-safe, stable codes)
// ---------------------------------------------------------------------------

export type V2PolicyErrorCode =
	| "INVALID_CALL_ID"
	| "DUPLICATE_CALL_ID"
	| "INVALID_RESULT_ID"
	| "UNKNOWN_RESULT_ID"
	| "RESULT_ALREADY_CONSUMED"
	| "INVALID_CALL_PATH"
	| "FACTS_MALFORMED"
	| "RUBRIC_INVALID";

/** Structured policy failure — fail closed, message never carries entry content. */
export class V2PolicyError extends Error {
	readonly code: V2PolicyErrorCode;
	constructor(code: V2PolicyErrorCode, message: string) {
		super(message);
		this.name = "V2PolicyError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** UTF-8 byte length (TextEncoder is a global — no imports needed). */
function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Non-global control-character predicate (a /g regex would carry lastIndex state). */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Preview-facts marker (exact v1 contract)
// ---------------------------------------------------------------------------

export interface PreviewFactsV2 {
	complete: boolean;
	returnedLines: number;
	returnedBytes: number;
	totalLines: number;
	totalBytes: number;
	omittedLines: number;
	omittedBytes: number;
	nextOffset: number;
	lineTruncated: boolean;
}

const FACTS_KEYS = ["complete", "returned_lines", "returned_bytes", "total_lines", "total_bytes", "omitted_lines", "omitted_bytes", "next_offset", "line_truncated"] as const;

/**
 * Inline text of a toolResult message (string `content` or `content[]`
 * "text" items — the exact text that enters context, same semantics as
 * v1's toolResultTextBytes). Used ONLY to detect the preview-facts
 * marker and to count inline bytes; the text is never stored, rendered
 * or returned.
 */
function toolResultInlineText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const item of content) {
		const it = asRecord(item);
		if (it && it.type === "text" && typeof it.text === "string") text += it.text;
	}
	return text;
}

/**
 * Parse the exact one-line nine-field `nro-read-facts:` contract (v1
 * protocol §8.4): the substring `nro-read-facts:` through the end of
 * its line. Returns null when the marker is absent; a present-but-
 * malformed block fails closed (FACTS_MALFORMED, generic message):
 * wrong token count, unknown keys, duplicate keys, non-boolean flags,
 * non-integer or over-bound counts. The marker must occur exactly
 * once in the read-result inline text — a second occurrence anywhere
 * (same line, later line, or a later concatenated content[] text
 * item) is itself FACTS_MALFORMED, so two individually valid marker
 * lines never silently collapse into the first.
 */
function parsePreviewFactsV2(text: string): PreviewFactsV2 | null {
	const idx = text.indexOf(NRO_FACTS_MARKER);
	if (idx === -1) return null;
	if (text.indexOf(NRO_FACTS_MARKER, idx + NRO_FACTS_MARKER.length) !== -1) {
		throw new V2PolicyError("FACTS_MALFORMED", "read result text carries more than one preview facts marker");
	}
	let lineEnd = text.indexOf("\n", idx);
	if (lineEnd === -1) lineEnd = text.length;
	const line = text.slice(idx + NRO_FACTS_MARKER.length, lineEnd).trim();
	const tokens = line.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length !== FACTS_KEYS.length) {
		throw new V2PolicyError("FACTS_MALFORMED", "preview facts line must carry exactly the nine frozen key=value facts");
	}
	const values = new Map<string, string>();
	for (const token of tokens) {
		const eq = token.indexOf("=");
		if (eq <= 0) throw new V2PolicyError("FACTS_MALFORMED", "preview facts token must be key=value");
		const key = token.slice(0, eq);
		if (!(FACTS_KEYS as readonly string[]).includes(key)) {
			throw new V2PolicyError("FACTS_MALFORMED", "preview facts line carries an unknown key");
		}
		if (values.has(key)) throw new V2PolicyError("FACTS_MALFORMED", "preview facts line repeats a key");
		values.set(key, token.slice(eq + 1));
	}
	const boolOf = (key: string, where: string): boolean => {
		const v = values.get(key);
		if (v !== "true" && v !== "false") throw new V2PolicyError("FACTS_MALFORMED", `${where} must be true or false`);
		return v === "true";
	};
	const intOf = (key: string, where: string): number => {
		const v = values.get(key);
		if (v === undefined || !/^\d+$/.test(v)) throw new V2PolicyError("FACTS_MALFORMED", `${where} must be a non-negative integer`);
		const n = Number(v);
		if (!Number.isSafeInteger(n) || n > MAX_USAGE_FACT) throw new V2PolicyError("FACTS_MALFORMED", `${where} exceeds the documented bound`);
		return n;
	};
	return {
		complete: boolOf("complete", "facts complete"),
		returnedLines: intOf("returned_lines", "facts returned_lines"),
		returnedBytes: intOf("returned_bytes", "facts returned_bytes"),
		totalLines: intOf("total_lines", "facts total_lines"),
		totalBytes: intOf("total_bytes", "facts total_bytes"),
		omittedLines: intOf("omitted_lines", "facts omitted_lines"),
		omittedBytes: intOf("omitted_bytes", "facts omitted_bytes"),
		nextOffset: intOf("next_offset", "facts next_offset"),
		lineTruncated: boolOf("line_truncated", "facts line_truncated"),
	};
}

// ---------------------------------------------------------------------------
// Pagination facts (v2 exact-ID attribution)
// ---------------------------------------------------------------------------

export interface PaginationFactsV2 {
	/** Matched successful results carrying complete=false markers. */
	previewResults: number;
	/** Inline UTF-8 bytes of the preview results' text. */
	previewBytes: number;
	/** Successful matched calls with integer offset/limit on an earlier-previewed path. */
	continuationReads: number;
	/** Inline UTF-8 bytes of the continuation results' text. */
	continuationBytes: number;
	/** Preview results (one obligation per complete=false marker). */
	obligations: number;
	/** Obligations followed by a later successful continuation on the same path. */
	obligationsPaginated: number;
	/** Obligations followed by a later successful complete=true marker on the same path. */
	reachedComplete: number;
	completionFraction: number | null;
	reachedFraction: number | null;
	/** obligations - obligationsPaginated. */
	unpaginatedPreviews: number;
	/** Machine sign: obligations > 0 and obligationsPaginated < obligations. */
	misuse: boolean;
	/** Read calls never matched by any result. */
	orphanReadCalls: number;
	/** Matched results with isError:true. */
	errorReadResults: number;
}

interface ReadCallRec {
	path: string;
	hasOffset: boolean;
	hasLimit: boolean;
	/** Entry index of the toolCall (ordering vs preview results). */
	callIndex: number;
	matched: boolean;
	/** offset/limit present AND an earlier successful preview existed on the path at call time. */
	continuationCandidate: boolean;
}

interface Obligation {
	path: string;
	/** Entry index of the preview toolResult. */
	resultIndex: number;
}

/**
 * Derive the v2 pagination facts over persisted Pi session entries.
 * Read results associate to read calls STRICTLY by exact toolCallId:
 * orphan calls, provider-error assistant entries and reordered results
 * never shift attribution. A successful matched call carrying a finite
 * integer offset and/or limit is a continuation only when the same path
 * had an earlier successful complete=false preview; per obligation a
 * later successful continuation on the same path counts as paginated,
 * and a later successful complete=true marker on the same path counts
 * as reached-complete. Error results consume their id and contribute
 * only the errorReadResults aggregate. Arguments are inspected for
 * path/offset/limit presence only and are never rendered; the returned
 * facts carry no ids, paths or bodies.
 */
export function computePaginationV2(entries: readonly unknown[]): PaginationFactsV2 {
	const calls = new Map<string, ReadCallRec>();
	const previewPaths = new Set<string>();
	const obligations: Obligation[] = [];
	const continuations: Array<{ path: string; callIndex: number }> = [];
	const completed: Array<{ path: string; resultIndex: number }> = [];
	let previewResults = 0;
	let previewBytes = 0;
	let continuationReads = 0;
	let continuationBytes = 0;
	let errorReadResults = 0;
	let entryIndex = 0;
	for (const entry of entries) {
		const e = asRecord(entry);
		if (!e || e.type !== "message") {
			entryIndex += 1;
			continue;
		}
		const m = asRecord(e.message);
		if (!m) {
			entryIndex += 1;
			continue;
		}
		if (m.role === "assistant") {
			const content = m.content;
			if (Array.isArray(content)) {
				for (const item of content) {
					const it = asRecord(item);
					if (!it || it.type !== "toolCall" || it.name !== "read") continue;
					const id = it.id;
					if (typeof id !== "string" || id.length === 0 || utf8Bytes(id) > ID_MAX_BYTES) {
						throw new V2PolicyError("INVALID_CALL_ID", "read tool call must carry a non-empty id of at most 512 UTF-8 bytes");
					}
					if (calls.has(id)) throw new V2PolicyError("DUPLICATE_CALL_ID", "read tool call id is already in use");
					const args = asRecord(it.arguments);
					if (!args) throw new V2PolicyError("INVALID_CALL_PATH", "read tool call arguments are missing");
					const path = args.path;
					if (typeof path !== "string" || path.length === 0 || utf8Bytes(path) > PATH_MAX_BYTES || CONTROL_CHAR_RE.test(path)) {
						throw new V2PolicyError("INVALID_CALL_PATH", "read tool call path is not a valid bounded string");
					}
					const hasOffset = typeof args.offset === "number" && Number.isInteger(args.offset);
					const hasLimit = typeof args.limit === "number" && Number.isInteger(args.limit);
					calls.set(id, {
						path,
						hasOffset,
						hasLimit,
						callIndex: entryIndex,
						matched: false,
						continuationCandidate: (hasOffset || hasLimit) && previewPaths.has(path),
					});
				}
			}
		} else if (m.role === "toolResult" && m.toolName === "read") {
			const id = m.toolCallId;
			if (typeof id !== "string" || id.length === 0 || utf8Bytes(id) > ID_MAX_BYTES) {
				throw new V2PolicyError("INVALID_RESULT_ID", "read tool result must carry a non-empty toolCallId of at most 512 UTF-8 bytes");
			}
			const call = calls.get(id);
			if (!call) throw new V2PolicyError("UNKNOWN_RESULT_ID", "read tool result references an unknown tool call id");
			if (call.matched) throw new V2PolicyError("RESULT_ALREADY_CONSUMED", "read tool result references an already consumed tool call id");
			call.matched = true;
			if (m.isError === true) {
				// Error result: consumes the id; contributes nothing but the aggregate.
				errorReadResults += 1;
			} else {
				const text = toolResultInlineText(m.content);
				const bytes = utf8Bytes(text);
				if (call.continuationCandidate) {
					continuationReads += 1;
					continuationBytes += bytes;
					continuations.push({ path: call.path, callIndex: call.callIndex });
				}
				const facts = parsePreviewFactsV2(text);
				if (facts !== null && facts.complete === false) {
					previewResults += 1;
					previewBytes += bytes;
					previewPaths.add(call.path);
					obligations.push({ path: call.path, resultIndex: entryIndex });
				} else if (facts !== null && facts.complete === true) {
					completed.push({ path: call.path, resultIndex: entryIndex });
				}
			}
		}
		entryIndex += 1;
	}
	let obligationsPaginated = 0;
	let reachedComplete = 0;
	for (const obligation of obligations) {
		if (continuations.some((c) => c.path === obligation.path && c.callIndex > obligation.resultIndex)) obligationsPaginated += 1;
		if (completed.some((r) => r.path === obligation.path && r.resultIndex > obligation.resultIndex)) reachedComplete += 1;
	}
	let orphanReadCalls = 0;
	for (const call of calls.values()) {
		if (!call.matched) orphanReadCalls += 1;
	}
	const unpaginatedPreviews = obligations.length - obligationsPaginated;
	return {
		previewResults,
		previewBytes,
		continuationReads,
		continuationBytes,
		obligations: obligations.length,
		obligationsPaginated,
		reachedComplete,
		completionFraction: obligations.length === 0 ? null : obligationsPaginated / obligations.length,
		reachedFraction: obligations.length === 0 ? null : reachedComplete / obligations.length,
		unpaginatedPreviews,
		misuse: obligations.length > 0 && obligationsPaginated < obligations.length,
		orphanReadCalls,
		errorReadResults,
	};
}
