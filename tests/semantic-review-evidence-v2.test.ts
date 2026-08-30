import assert from "node:assert/strict";
import test from "node:test";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	buildSemanticReviewEvidenceV2,
	computeCrossFileAssessmentHashV2,
	planSemanticReviewInheritanceV2,
	validateSemanticReviewEvidenceV2,
	verifySemanticReviewEvidenceBindingV2,
	type CrossFileAssessmentV2,
	type SemanticReviewEvidenceV2,
} from "../extensions/workbench-runtime/core/semantic-review-evidence-v2.ts";

const H = (value: string) => canonicalHash({ value });
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function cross(decision: "ACCEPT" | "REPAIR", streamSetHash: string, affected: string[] = []): CrossFileAssessmentV2 {
	const payload = {
		fresh: true as const,
		page_assessment_set_hash: H("pages"),
		reviewed_stream_set_hash: streamSetHash,
		decision,
		blocking_finding_ids: decision === "ACCEPT" ? [] : ["P1-F1"],
		affected_paths: [...affected].sort(),
		summary_hash: H("summary"),
	};
	return { ...payload, assessment_hash: computeCrossFileAssessmentHashV2(payload) };
}

function evidence(decision: "ACCEPT" | "REPAIR" = "ACCEPT", paths = ["src/a.ts", "src/b.ts"]): SemanticReviewEvidenceV2 {
	const streams = paths.map((path, index) => ({
		source: "FRESH" as const,
		stream_id: `stream-${index + 1}`,
		path,
		content_hash: H(`content-${index}`),
		page_binding_hashes: [H(`page-${index}`)],
		assessment_hash: H(`assessment-${index}`),
		verdict: decision === "REPAIR" && index === 0 ? "REPAIR" as const : "PASS" as const,
	}));
	const streamSetHash = canonicalHash(streams.map(({ stream_id, path, content_hash }) => ({ stream_id, path, content_hash })));
	const built = buildSemanticReviewEvidenceV2({
		delegation_id: "20260829-120000-abcd",
		generation: 2,
		generation_content_hash: H("generation"),
		contract_hash: H("contract"),
		bound_diff_hash: H("diff"),
		relevance_projection_hash: H("relevance"),
		review_envelope_hash: H("envelope"),
		review_policy_hash: H("policy"),
		model_identity: { provider: "openai-codex", model: "gpt-5.6-sol", api: "openai-codex-responses" },
		runtime_build_identity: H("runtime"),
		stream_set_hash: streamSetHash,
		parent_evidence_hash: null,
		streams,
		cross_file_assessment: cross(decision, streamSetHash, decision === "REPAIR" ? [paths[0]!] : []),
		final_decision: decision,
		repair_reason: decision === "REPAIR" ? "Blocking semantic defect." : null,
		nested_usage: usage,
		completed_at: "2026-08-29T12:00:00.000Z",
	});
	assert.equal(built.ok, true);
	return (built as { ok: true; value: SemanticReviewEvidenceV2 }).value;
}

test("evidence construction isolates every nested input with one owned snapshot", () => {
	const streams = ["src/b.ts", "src/a.ts"].map((path, index) => ({
		source: "FRESH" as const,
		stream_id: `stream-${index + 1}`,
		path,
		content_hash: H(`owned-content-${index}`),
		page_binding_hashes: [H(`owned-page-${index}`)],
		assessment_hash: H(`owned-assessment-${index}`),
		verdict: "PASS" as const,
	}));
	const streamSetHash = canonicalHash(streams.map(({ stream_id, path, content_hash }) => ({ stream_id, path, content_hash })));
	const modelIdentity = { provider: "openai-codex" as const, model: "gpt-5.6-sol" as const, api: "openai-codex-responses" };
	const crossFileAssessment = cross("ACCEPT", streamSetHash);
	const nestedUsage = structuredClone(usage);
	const built = buildSemanticReviewEvidenceV2({
		delegation_id: "20260829-120000-abcd",
		generation: 2,
		generation_content_hash: H("owned-generation"),
		contract_hash: H("owned-contract"),
		bound_diff_hash: H("owned-diff"),
		relevance_projection_hash: H("owned-relevance"),
		review_envelope_hash: H("owned-envelope"),
		review_policy_hash: H("owned-policy"),
		model_identity: modelIdentity,
		runtime_build_identity: H("owned-runtime"),
		stream_set_hash: streamSetHash,
		parent_evidence_hash: null,
		streams,
		cross_file_assessment: crossFileAssessment,
		final_decision: "ACCEPT",
		repair_reason: null,
		nested_usage: nestedUsage,
		completed_at: "2026-08-29T12:00:00.000Z",
	});
	assert.equal(built.ok, true);
	if (!built.ok) return;
	const snapshot = structuredClone(built.value);
	(modelIdentity as { model: string }).model = "mutated";
	streams[0]!.path = "src/mutated.ts";
	streams[0]!.page_binding_hashes[0] = H("mutated-page");
	(crossFileAssessment.affected_paths as string[]).push("src/mutated.ts");
	nestedUsage.cost.total = 999;
	assert.deepEqual(built.value, snapshot);
	assert.deepEqual(built.value.streams.map((stream) => stream.path), ["src/a.ts", "src/b.ts"]);
	assert.equal(validateSemanticReviewEvidenceV2(built.value), true);
});

test("SemanticReviewEvidenceV2 accepts a complete fresh authority and rejects every binding drift", () => {
	const value = evidence();
	assert.equal(validateSemanticReviewEvidenceV2(value), true);
	const binding = {
		delegation_id: value.delegation_id,
		generation: value.generation,
		generation_content_hash: value.generation_content_hash,
		contract_hash: value.contract_hash,
		bound_diff_hash: value.bound_diff_hash,
		relevance_projection_hash: value.relevance_projection_hash,
		review_envelope_hash: value.review_envelope_hash,
		review_policy_hash: value.review_policy_hash,
		model_identity: value.model_identity,
		runtime_build_identity: value.runtime_build_identity,
		stream_set_hash: value.stream_set_hash,
		parent_evidence_hash: value.parent_evidence_hash,
	};
	assert.equal(verifySemanticReviewEvidenceBindingV2(value, binding), true);
	for (const field of ["generation_content_hash", "contract_hash", "bound_diff_hash", "review_policy_hash", "runtime_build_identity"] as const) {
		assert.equal(verifySemanticReviewEvidenceBindingV2(value, { ...binding, [field]: H(`tamper-${field}`) }), false, field);
	}
	const missing = structuredClone(value) as any;
	delete missing.review_policy_hash;
	assert.equal(validateSemanticReviewEvidenceV2(missing), false);
	const forged = structuredClone(value);
	forged.streams[0]!.content_hash = H("forged");
	assert.equal(validateSemanticReviewEvidenceV2(forged), false);
});

test("inheritance reviews one changed leaf and its declared closure, not all streams", () => {
	const parent = evidence("ACCEPT", ["schema/public.json", "src/consumer.ts", "src/leaf.ts", "tests/consumer.test.ts"]);
	const current = parent.streams.map((stream) => ({ stream_id: stream.stream_id, path: stream.path, content_hash: stream.content_hash, roles: ["W"] }));
	current[2] = { ...current[2]!, content_hash: H("leaf-repaired") };
	const plan = planSemanticReviewInheritanceV2({
		current_streams: current,
		parent_evidence: parent,
		direct_parent_evidence_hash: parent.evidence_hash,
		contract_hash: parent.contract_hash,
		review_policy_hash: parent.review_policy_hash,
		model_identity: parent.model_identity,
		runtime_build_identity: parent.runtime_build_identity,
		declared_dependencies: [{ from: "schema/public.json", to: "src/consumer.ts" }, { from: "src/consumer.ts", to: "tests/consumer.test.ts" }],
	});
	assert.deepEqual(plan.changed_paths, ["src/leaf.ts"]);
	assert.deepEqual(plan.fresh_stream_ids, ["stream-3"]);
	assert.deepEqual(plan.inherited_streams.map((stream) => stream.path), ["schema/public.json", "src/consumer.ts", "tests/consumer.test.ts"]);
});

test("repair lineage metadata does not force full fresh review, while unproven contract drift does", () => {
	const parent = evidence("ACCEPT", ["src/a.ts", "src/b.ts"]);
	const current = parent.streams.map((stream) => ({
		stream_id: stream.stream_id,
		path: stream.path,
		content_hash: stream.content_hash,
		roles: ["W"],
	}));
	current[1] = { ...current[1]!, content_hash: H("repaired-b") };
	const driftedContractHash = H("same-business-contract-with-repair-of");
	const withoutProof = planSemanticReviewInheritanceV2({
		current_streams: current,
		parent_evidence: parent,
		direct_parent_evidence_hash: parent.evidence_hash,
		contract_hash: driftedContractHash,
		review_policy_hash: parent.review_policy_hash,
		model_identity: parent.model_identity,
		runtime_build_identity: parent.runtime_build_identity,
	});
	assert.equal(withoutProof.fresh_stream_ids.length, 2);
	const lineaged = planSemanticReviewInheritanceV2({
		current_streams: current,
		parent_evidence: parent,
		direct_parent_evidence_hash: parent.evidence_hash,
		contract_hash: driftedContractHash,
		lineage_contract_compatible: true,
		review_policy_hash: parent.review_policy_hash,
		model_identity: parent.model_identity,
		runtime_build_identity: parent.runtime_build_identity,
	});
	assert.deepEqual(lineaged.fresh_stream_ids, ["stream-2"]);
	assert.deepEqual(lineaged.inherited_streams.map((stream) => stream.path), ["src/a.ts"]);
});

test("schema dependency closure and parent REPAIR findings force fresh review", () => {
	const parent = evidence("REPAIR", ["schema/public.json", "src/consumer.ts", "src/unrelated.ts", "tests/consumer.test.ts"]);
	const current = parent.streams.map((stream) => ({ stream_id: stream.stream_id, path: stream.path, content_hash: stream.content_hash, roles: ["W"] }));
	current[0] = { ...current[0]!, content_hash: H("schema-changed") };
	const plan = planSemanticReviewInheritanceV2({
		current_streams: current,
		parent_evidence: parent,
		direct_parent_evidence_hash: parent.evidence_hash,
		contract_hash: parent.contract_hash,
		review_policy_hash: parent.review_policy_hash,
		model_identity: parent.model_identity,
		runtime_build_identity: parent.runtime_build_identity,
		declared_dependencies: [{ from: "schema/public.json", to: "src/consumer.ts" }, { from: "src/consumer.ts", to: "tests/consumer.test.ts" }],
		finding_paths: ["schema/public.json"],
	});
	assert.deepEqual(plan.fresh_stream_ids, ["stream-1", "stream-2", "stream-4"]);
	assert.deepEqual(plan.inherited_streams.map((stream) => stream.path), ["src/unrelated.ts"]);
	assert.equal(plan.inherited_streams.every((stream) => stream.verdict === "PASS"), true);
});

test("legacy, policy drift, binary gaps, and absent fresh final assessment fail closed", () => {
	const parent = evidence();
	const current = parent.streams.map((stream) => ({ stream_id: stream.stream_id, path: stream.path, content_hash: stream.content_hash, roles: ["W"] }));
	assert.equal(planSemanticReviewInheritanceV2({
		current_streams: current,
		parent_evidence: null,
		direct_parent_evidence_hash: null,
		contract_hash: parent.contract_hash,
		review_policy_hash: parent.review_policy_hash,
		model_identity: parent.model_identity,
		runtime_build_identity: parent.runtime_build_identity,
	}).fresh_stream_ids.length, 2);
	assert.equal(planSemanticReviewInheritanceV2({
		current_streams: current,
		parent_evidence: parent,
		direct_parent_evidence_hash: parent.evidence_hash,
		contract_hash: parent.contract_hash,
		review_policy_hash: H("changed-policy"),
		model_identity: parent.model_identity,
		runtime_build_identity: parent.runtime_build_identity,
		binary_semantic_gaps: ["src/a.ts"],
	}).fresh_stream_ids.length, 2);
	const invalid = structuredClone(parent);
	(invalid.cross_file_assessment as any).fresh = false;
	assert.equal(validateSemanticReviewEvidenceV2(invalid), false);
});
