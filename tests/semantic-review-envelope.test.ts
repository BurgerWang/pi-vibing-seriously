import assert from "node:assert/strict";
import test from "node:test";

import {
	SEMANTIC_REVIEW_ENVELOPE_MAX_AGGREGATE_BYTES_V1,
	SEMANTIC_REVIEW_ENVELOPE_MAX_RECORD_BYTES_V1,
	SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1,
	assessSemanticReviewEnvelopeV1,
	buildSemanticReviewEnvelopeV1,
	validateSemanticReviewEnvelopeV1,
} from "../extensions/workbench-runtime/core/semantic-review-envelope.ts";

const HASH = "a".repeat(64);

function assessment(overrides: Partial<Parameters<typeof assessSemanticReviewEnvelopeV1>[0]> = {}) {
	return assessSemanticReviewEnvelopeV1({
		path_count: 1,
		max_stream_bytes: 1,
		aggregate_stream_bytes: 1,
		projected_review_record_bytes: 1,
		...overrides,
	});
}

test("semantic review envelope has closed 4 MiB, 64 MiB, 1 MiB and 500-path boundaries", () => {
	assert.deepEqual(assessment({
		max_stream_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1,
		aggregate_stream_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1,
	}), { ok: true });
	assert.deepEqual(assessment({
		max_stream_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1 + 1,
		aggregate_stream_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1 + 1,
	}), { ok: false, code: "stream_limit_exceeded" });

	assert.deepEqual(assessment({
		path_count: 16,
		max_stream_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1,
		aggregate_stream_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_AGGREGATE_BYTES_V1,
	}), { ok: true });
	assert.deepEqual(assessment({
		path_count: 17,
		max_stream_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_STREAM_BYTES_V1,
		aggregate_stream_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_AGGREGATE_BYTES_V1 + 1,
	}), { ok: false, code: "aggregate_limit_exceeded" });

	assert.deepEqual(assessment({ projected_review_record_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_RECORD_BYTES_V1 }), { ok: true });
	assert.deepEqual(assessment({ projected_review_record_bytes: SEMANTIC_REVIEW_ENVELOPE_MAX_RECORD_BYTES_V1 + 1 }),
		{ ok: false, code: "record_limit_exceeded" });
	assert.deepEqual(assessment({ path_count: 499 }), { ok: true });
	assert.deepEqual(assessment({ path_count: 500 }), { ok: true });
	assert.deepEqual(assessment({ path_count: 501 }), { ok: false, code: "path_limit_exceeded" });
});

test("page count is O(paths) metadata and 4095, 4096 and 4097 pages all remain admissible", () => {
	for (const pageCount of [4095, 4096, 4097]) {
		const built = buildSemanticReviewEnvelopeV1({
			streams: [{
				path: "src/short-lines.ts",
				source: "file-content",
				stream_bytes: 1_000_000,
				stream_sha256: HASH,
				page_count: pageCount,
			}],
			projected_review_record_bytes: 200_000,
			relevance_projection_hash: "b".repeat(64),
		});
		assert.equal(built.ok, true, `page count ${pageCount} stays inside the O(paths) envelope`);
		if (built.ok) {
			assert.equal(built.value.total_pages, pageCount);
			assert.equal(validateSemanticReviewEnvelopeV1(built.value), true);
		}
	}
	const impossible = buildSemanticReviewEnvelopeV1({
		streams: [{
			path: "src/one-byte.ts", source: "file-content", stream_bytes: 1,
			stream_sha256: HASH, page_count: 2,
		}],
		projected_review_record_bytes: 200_000,
		relevance_projection_hash: "b".repeat(64),
	});
	assert.deepEqual(impossible, { ok: false, code: "invalid_input" }, "every successful page must advance at least one byte");
});

test("499 and 500 stream descriptors fit while 501 is rejected without large fixtures", () => {
	const streams = Array.from({ length: 501 }, (_, index) => ({
		path: `src/p-${String(index).padStart(3, "0")}.ts`,
		source: "file-content" as const,
		stream_bytes: 1,
		stream_sha256: index.toString(16).padStart(64, "0"),
		page_count: 1,
	}));
	for (const count of [499, 500]) {
		const built = buildSemanticReviewEnvelopeV1({
			streams: streams.slice(0, count), projected_review_record_bytes: 500_000, relevance_projection_hash: HASH,
		});
		assert.equal(built.ok, true);
	}
	const over = buildSemanticReviewEnvelopeV1({
		streams, projected_review_record_bytes: 500_000, relevance_projection_hash: HASH,
	});
	assert.deepEqual(over, { ok: false, code: "path_limit_exceeded" });
});

test("stream-set authority uses canonical JSON rather than object insertion order", () => {
	const ordinary = {
		path: "src/canonical.ts", source: "file-content" as const, stream_bytes: 10,
		stream_sha256: HASH, page_count: 1,
	};
	const reordered = {
		page_count: 1, stream_sha256: HASH, stream_bytes: 10,
		source: "file-content" as const, path: "src/canonical.ts",
	};
	const first = buildSemanticReviewEnvelopeV1({
		streams: [ordinary], projected_review_record_bytes: 200_000, relevance_projection_hash: HASH,
	});
	const second = buildSemanticReviewEnvelopeV1({
		streams: [reordered], projected_review_record_bytes: 200_000, relevance_projection_hash: HASH,
	});
	assert.equal(first.ok && second.ok, true);
	if (first.ok && second.ok) assert.equal(first.value.stream_set_hash, second.value.stream_set_hash);
});
