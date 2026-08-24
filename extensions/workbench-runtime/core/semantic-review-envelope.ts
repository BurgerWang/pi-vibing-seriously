/**
 * Versioned admission/closure envelope for semantic delegation review.
 *
 * The envelope is computed before an implementation generation can be
 * published PENDING_REVIEW.  It deliberately binds the exact presentation
 * stream set and the relevance projection while keeping the durable proof
 * O(paths), never O(pages).  The pure assessment seam is also used by tests
 * to exercise capacity boundaries without allocating multi-megabyte files.
 */

import { canonicalHash } from "../cache/canonical-hash.ts";

export const SEMANTIC_REVIEW_ENVELOPE_SCHEMA_VERSION_V1 = 1 as const;
export const SEMANTIC_REVIEW_ENVELOPE_KIND_V1 = "semantic-review-envelope-v1" as const;
export const SEMANTIC_REVIEW_ENVELOPE_MAX_PATHS_V1 = 500 as const;
export const SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1 = 4 * 1024 * 1024;
export const SEMANTIC_REVIEW_ENVELOPE_MAX_AGGREGATE_BYTES_V1 = 64 * 1024 * 1024;
export const SEMANTIC_REVIEW_ENVELOPE_MAX_RECORD_BYTES_V1 = 1_048_576 as const;
/**
 * Conservative allowance for bounded patch/control/stats and JSON framing.
 * Patch text itself is bounded to 20 KiB before persistence, but JSON escaping
 * can expand hostile control bytes by up to six times.  The 256 KiB reserve
 * covers that expansion plus the bounded path stats, notes, violations,
 * acceptance/envelope fields and pretty-print framing that are not represented
 * in the variable skeleton below.
 */
export const SEMANTIC_REVIEW_RECORD_FIXED_RESERVE_BYTES_V1 = 256 * 1024;

export type SemanticReviewEnvelopeErrorCodeV1 =
	| "invalid_input"
	| "path_limit_exceeded"
	| "stream_limit_exceeded"
	| "aggregate_limit_exceeded"
	| "record_limit_exceeded";

export interface SemanticReviewEnvelopeAssessmentInputV1 {
	path_count: number;
	max_stream_bytes: number;
	aggregate_stream_bytes: number;
	projected_review_record_bytes: number;
}

export type SemanticReviewEnvelopeAssessmentV1 =
	| { ok: true }
	| { ok: false; code: SemanticReviewEnvelopeErrorCodeV1 };

export interface SemanticReviewStreamDescriptorV1 {
	path: string;
	source: "git-diff" | "file-content" | "deleted" | "compact";
	stream_bytes: number;
	stream_sha256: string;
	page_count: number;
}

export interface SemanticReviewEnvelopeV1 {
	schema_version: typeof SEMANTIC_REVIEW_ENVELOPE_SCHEMA_VERSION_V1;
	kind: typeof SEMANTIC_REVIEW_ENVELOPE_KIND_V1;
	limits: {
		max_paths: typeof SEMANTIC_REVIEW_ENVELOPE_MAX_PATHS_V1;
		max_stream_bytes: number;
		max_aggregate_bytes: number;
		max_record_bytes: typeof SEMANTIC_REVIEW_ENVELOPE_MAX_RECORD_BYTES_V1;
	};
	path_count: number;
	max_stream_bytes: number;
	aggregate_stream_bytes: number;
	projected_review_record_bytes: number;
	total_pages: number;
	stream_set_hash: string;
	relevance_projection_hash: string;
}

const HASH_RE = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: object, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...fields].sort();
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function safeCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Closed capacity predicate shared by admission, parsing and boundary tests. */
export function assessSemanticReviewEnvelopeV1(
	input: Readonly<SemanticReviewEnvelopeAssessmentInputV1>,
): SemanticReviewEnvelopeAssessmentV1 {
	if (!isRecord(input) || !exactFields(input, [
		"path_count", "max_stream_bytes", "aggregate_stream_bytes", "projected_review_record_bytes",
	]) || !safeCounter(input.path_count) || !safeCounter(input.max_stream_bytes) ||
		!safeCounter(input.aggregate_stream_bytes) || !safeCounter(input.projected_review_record_bytes) ||
		input.max_stream_bytes > input.aggregate_stream_bytes ||
		(input.path_count === 0 && (input.max_stream_bytes !== 0 || input.aggregate_stream_bytes !== 0))) {
		return { ok: false, code: "invalid_input" };
	}
	if (input.path_count > SEMANTIC_REVIEW_ENVELOPE_MAX_PATHS_V1) {
		return { ok: false, code: "path_limit_exceeded" };
	}
	if (input.max_stream_bytes > SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1) {
		return { ok: false, code: "stream_limit_exceeded" };
	}
	if (input.aggregate_stream_bytes > SEMANTIC_REVIEW_ENVELOPE_MAX_AGGREGATE_BYTES_V1) {
		return { ok: false, code: "aggregate_limit_exceeded" };
	}
	if (input.projected_review_record_bytes > SEMANTIC_REVIEW_ENVELOPE_MAX_RECORD_BYTES_V1) {
		return { ok: false, code: "record_limit_exceeded" };
	}
	return { ok: true };
}

/**
 * Conservative serialized-record estimate.  It includes the exact relevance
 * projection plus worst-state repetitions of worker paths and one O(paths)
 * cumulative receipt per stream, then reserves fixed space for the globally
 * bounded visible patch/control/stat sections.
 */
export function estimateSemanticReviewRecordBytesV1(input: {
	worker_paths: readonly string[];
	allowed_paths: readonly string[];
	streams: readonly SemanticReviewStreamDescriptorV1[];
	relevance_projection: unknown;
}): number | undefined {
	try {
		const paths = [...input.worker_paths];
		const progress = input.streams.map((stream) => ({
			path: stream.path,
			source: stream.source,
			stream_sha256: stream.stream_sha256,
			next_byte: stream.stream_bytes,
			total_bytes: stream.stream_bytes,
			page_count: stream.page_count,
			receipt_sha256: "f".repeat(64),
			segments: stream.stream_bytes === 0 ? [] : [{
				start_byte: Math.max(0, stream.stream_bytes - 1),
				end_byte: stream.stream_bytes,
				page_sha256: "f".repeat(64),
			}],
		}));
		const variable = {
			allowed_paths: [...input.allowed_paths],
			checked_paths: paths,
			displayed_paths: paths,
			remaining_paths: paths,
			fully_presented_paths: paths,
			presentation_remaining_paths: paths,
			presentation_progress: progress,
			relevance_projection: input.relevance_projection,
		};
		const bytes = Buffer.byteLength(`${JSON.stringify(variable, null, 2)}\n`, "utf8");
		if (!Number.isSafeInteger(bytes) || bytes > Number.MAX_SAFE_INTEGER - SEMANTIC_REVIEW_RECORD_FIXED_RESERVE_BYTES_V1) return undefined;
		return bytes + SEMANTIC_REVIEW_RECORD_FIXED_RESERVE_BYTES_V1;
	} catch {
		return undefined;
	}
}

export function buildSemanticReviewEnvelopeV1(input: {
	streams: readonly SemanticReviewStreamDescriptorV1[];
	projected_review_record_bytes: number;
	relevance_projection_hash: string;
}): { ok: true; value: SemanticReviewEnvelopeV1 } | { ok: false; code: SemanticReviewEnvelopeErrorCodeV1 } {
	if (!Array.isArray(input.streams) || !safeCounter(input.projected_review_record_bytes) ||
		!HASH_RE.test(input.relevance_projection_hash)) return { ok: false, code: "invalid_input" };
	let previous = "";
	let aggregate = 0;
	let maxStream = 0;
	let totalPages = 0;
	for (const stream of input.streams) {
		if (!isRecord(stream)) return { ok: false, code: "invalid_input" };
		if (!exactFields(stream, ["path", "source", "stream_bytes", "stream_sha256", "page_count"]) ||
			typeof stream.path !== "string" || stream.path.length === 0 || stream.path.length > 400 ||
			(previous !== "" && Buffer.from(previous, "utf8").compare(Buffer.from(stream.path, "utf8")) >= 0) ||
			typeof stream.source !== "string" || !["git-diff", "file-content", "deleted", "compact"].includes(stream.source) ||
			!safeCounter(stream.stream_bytes) || typeof stream.stream_sha256 !== "string" || !HASH_RE.test(stream.stream_sha256) ||
			!safeCounter(stream.page_count) || (stream.stream_bytes === 0) !== (stream.page_count === 0) ||
			stream.page_count > stream.stream_bytes ||
			aggregate > Number.MAX_SAFE_INTEGER - stream.stream_bytes || totalPages > Number.MAX_SAFE_INTEGER - stream.page_count) {
			return { ok: false, code: "invalid_input" };
		}
		previous = stream.path;
		aggregate += stream.stream_bytes;
		maxStream = Math.max(maxStream, stream.stream_bytes);
		totalPages += stream.page_count;
	}
	const assessment = assessSemanticReviewEnvelopeV1({
		path_count: input.streams.length,
		max_stream_bytes: maxStream,
		aggregate_stream_bytes: aggregate,
		projected_review_record_bytes: input.projected_review_record_bytes,
	});
	if (!assessment.ok) return assessment;
	return {
		ok: true,
		value: {
			schema_version: SEMANTIC_REVIEW_ENVELOPE_SCHEMA_VERSION_V1,
			kind: SEMANTIC_REVIEW_ENVELOPE_KIND_V1,
			limits: {
				max_paths: SEMANTIC_REVIEW_ENVELOPE_MAX_PATHS_V1,
				max_stream_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1,
				max_aggregate_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_AGGREGATE_BYTES_V1,
				max_record_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_RECORD_BYTES_V1,
			},
			path_count: input.streams.length,
			max_stream_bytes: maxStream,
			aggregate_stream_bytes: aggregate,
			projected_review_record_bytes: input.projected_review_record_bytes,
			total_pages: totalPages,
			stream_set_hash: canonicalHash(input.streams),
			relevance_projection_hash: input.relevance_projection_hash,
		},
	};
}

export function validateSemanticReviewEnvelopeV1(value: unknown): value is SemanticReviewEnvelopeV1 {
	if (!isRecord(value) || !exactFields(value, [
		"schema_version", "kind", "limits", "path_count", "max_stream_bytes", "aggregate_stream_bytes",
		"projected_review_record_bytes", "total_pages", "stream_set_hash", "relevance_projection_hash",
	]) || value.schema_version !== SEMANTIC_REVIEW_ENVELOPE_SCHEMA_VERSION_V1 ||
		value.kind !== SEMANTIC_REVIEW_ENVELOPE_KIND_V1 || !isRecord(value.limits) ||
		!exactFields(value.limits, ["max_paths", "max_stream_bytes", "max_aggregate_bytes", "max_record_bytes"]) ||
		value.limits.max_paths !== SEMANTIC_REVIEW_ENVELOPE_MAX_PATHS_V1 ||
		value.limits.max_stream_bytes !== SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1 ||
		value.limits.max_aggregate_bytes !== SEMANTIC_REVIEW_ENVELOPE_MAX_AGGREGATE_BYTES_V1 ||
		value.limits.max_record_bytes !== SEMANTIC_REVIEW_ENVELOPE_MAX_RECORD_BYTES_V1 ||
		!safeCounter(value.path_count) || !safeCounter(value.max_stream_bytes) || !safeCounter(value.aggregate_stream_bytes) ||
		!safeCounter(value.projected_review_record_bytes) || !safeCounter(value.total_pages) ||
		value.total_pages > value.aggregate_stream_bytes ||
		typeof value.stream_set_hash !== "string" || !HASH_RE.test(value.stream_set_hash) ||
		typeof value.relevance_projection_hash !== "string" || !HASH_RE.test(value.relevance_projection_hash)) return false;
	return assessSemanticReviewEnvelopeV1({
		path_count: value.path_count,
		max_stream_bytes: value.max_stream_bytes,
		aggregate_stream_bytes: value.aggregate_stream_bytes,
		projected_review_record_bytes: value.projected_review_record_bytes,
	}).ok;
}
