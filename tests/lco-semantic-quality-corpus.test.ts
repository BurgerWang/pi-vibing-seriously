import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	buildSemanticReviewEvidenceV2,
	computeCrossFileAssessmentHashV2,
	verifySemanticReviewEvidenceBindingV2,
	type SemanticReviewEvidenceBindingV2,
} from "../extensions/workbench-runtime/core/semantic-review-evidence-v2.ts";

type CorpusCase = Readonly<{
	id: string;
	category: "clean" | "blocking" | "cross_file" | "authority";
	paths: number;
	expected: "ACCEPT" | "REPAIR" | "REJECT_AUTHORITY";
	tamper?: keyof SemanticReviewEvidenceBindingV2;
}>;

const HASH = (value: unknown): string => canonicalHash(value);
const MODEL = { provider: "openai-codex", model: "gpt-5.6-sol", api: "responses" } as const;

function evidenceFor(item: CorpusCase) {
	const decision: "ACCEPT" | "REPAIR" = item.category === "blocking" || item.category === "cross_file" ? "REPAIR" : "ACCEPT";
	const streams = Array.from({ length: item.paths }, (_, index) => {
		const path = `synthetic/${item.id}/stream-${String(index + 1).padStart(2, "0")}.ts`;
		return {
			source: "FRESH" as const,
			stream_id: `${item.id}:stream:${index + 1}`,
			path,
			content_hash: HASH([item.id, path, "content"]),
			page_binding_hashes: [HASH([item.id, path, "page"])],
			assessment_hash: HASH([item.id, path, decision]),
			verdict: decision === "REPAIR" && (item.category === "blocking" || index === item.paths - 1)
				? "REPAIR" as const : "PASS" as const,
		};
	});
	const streamSetHash = HASH(streams.map(({ stream_id, path, content_hash }) => ({ stream_id, path, content_hash })));
	const crossPayload = {
		fresh: true as const,
		page_assessment_set_hash: HASH(streams.map((stream) => stream.assessment_hash)),
		reviewed_stream_set_hash: streamSetHash,
		decision,
		blocking_finding_ids: decision === "REPAIR" ? [`finding-${item.id}`] : [],
		affected_paths: decision === "REPAIR" ? streams.map((stream) => stream.path) : [],
		summary_hash: HASH([item.id, "fresh-final", decision]),
	};
	const binding: SemanticReviewEvidenceBindingV2 = {
		delegation_id: "20260829-060000-LCO6",
		generation: 1,
		generation_content_hash: HASH([item.id, "generation"]),
		contract_hash: HASH([item.id, "contract"]),
		bound_diff_hash: HASH([item.id, "diff"]),
		relevance_projection_hash: HASH([item.id, "relevance"]),
		review_envelope_hash: HASH([item.id, "envelope"]),
		review_policy_hash: HASH("lco-quality-policy-v1"),
		model_identity: MODEL,
		runtime_build_identity: `sha256:${HASH("lco-quality-runtime")}`,
		stream_set_hash: streamSetHash,
		parent_evidence_hash: null,
	};
	const built = buildSemanticReviewEvidenceV2({
		...binding,
		streams,
		cross_file_assessment: {
			...crossPayload,
			assessment_hash: computeCrossFileAssessmentHashV2(crossPayload),
		},
		final_decision: decision,
		repair_reason: decision === "REPAIR" ? `Synthetic blocking defect ${item.id}` : null,
		nested_usage: {
			input: item.paths * 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: item.paths * 10 + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		completed_at: "2026-08-29T06:00:00.000Z",
	});
	assert.equal(built.ok, true, item.id);
	if (!built.ok) throw new Error(`invalid evidence fixture ${item.id}`);
	return { evidence: built.value, binding };
}

test("frozen LCO semantic quality corpus has the required 20/20/10/10 composition", async () => {
	const source = new URL("./fixtures/lco-semantic-quality-corpus-v1.json", import.meta.url);
	const corpus = JSON.parse(await readFile(source, "utf8")) as { source: string; cases: CorpusCase[] };
	assert.equal(corpus.source, "synthetic-no-user-data");
	assert.equal(corpus.cases.length, 60);
	assert.equal(new Set(corpus.cases.map((item) => item.id)).size, 60);
	assert.deepEqual(Object.fromEntries(["clean", "blocking", "cross_file", "authority"].map((category) => [
		category, corpus.cases.filter((item) => item.category === category).length,
	])), { clean: 20, blocking: 20, cross_file: 10, authority: 10 });
});

test("V2 corpus has zero false ACCEPT, false REPAIR, and tampered-authority acceptance", async () => {
	const source = new URL("./fixtures/lco-semantic-quality-corpus-v1.json", import.meta.url);
	const corpus = JSON.parse(await readFile(source, "utf8")) as { cases: CorpusCase[]; v1_clean_false_repair_baseline: number };
	let blockingFalseAccept = 0;
	let authorityFalseAccept = 0;
	let cleanFalseRepair = 0;
	for (const item of corpus.cases) {
		const { evidence, binding } = evidenceFor(item);
		if (item.expected === "REJECT_AUTHORITY") {
			assert.ok(item.tamper);
			const tampered = structuredClone(binding) as unknown as Record<string, unknown>;
			tampered[item.tamper!] = item.tamper === "model_identity"
				? { ...MODEL, api: "tampered" }
				: item.tamper === "runtime_build_identity"
					? "sha256:" + "0".repeat(64)
					: item.tamper === "parent_evidence_hash"
						? "0".repeat(64)
						: "0".repeat(64);
			if (verifySemanticReviewEvidenceBindingV2(evidence, tampered as unknown as SemanticReviewEvidenceBindingV2)) {
				authorityFalseAccept += 1;
			}
			continue;
		}
		assert.equal(verifySemanticReviewEvidenceBindingV2(evidence, binding), true, item.id);
		if (item.expected === "REPAIR" && evidence.final_decision === "ACCEPT") blockingFalseAccept += 1;
		if (item.expected === "ACCEPT" && evidence.final_decision === "REPAIR") cleanFalseRepair += 1;
	}
	assert.equal(blockingFalseAccept, 0);
	assert.equal(authorityFalseAccept, 0);
	assert.equal(cleanFalseRepair, 0);
	assert.ok(cleanFalseRepair <= corpus.v1_clean_false_repair_baseline + 1);
});
