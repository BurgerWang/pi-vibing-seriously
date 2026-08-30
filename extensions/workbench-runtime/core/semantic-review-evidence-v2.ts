/**
 * Pure, storage-independent semantic acceptance authority for LCO review v2.
 *
 * Timestamps are audit metadata and deliberately stay outside the canonical
 * evidence identity. Every authority-bearing generation, policy, stream and
 * parent binding is included in that identity.
 */

import type { Usage } from "@earendil-works/pi-ai";

import { canonicalHash } from "../cache/canonical-hash.ts";

export const SEMANTIC_REVIEW_EVIDENCE_SCHEMA_VERSION_V2 = 2 as const;
export const SEMANTIC_REVIEW_EVIDENCE_KIND_V2 = "semantic-review-evidence-v2" as const;
export const SEMANTIC_REVIEW_EVIDENCE_MAX_STREAMS_V2 = 500 as const;
export const SEMANTIC_REVIEW_EVIDENCE_MAX_BYTES_V2 = 4 * 1024 * 1024;

const HASH_RE = /^[0-9a-f]{64}$/u;
const DELEGATION_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface SemanticReviewModelIdentityV2 {
	provider: "openai-codex";
	model: "gpt-5.6-sol";
	api: string;
}

export interface FreshSemanticStreamEvidenceV2 {
	source: "FRESH";
	stream_id: string;
	path: string;
	content_hash: string;
	page_binding_hashes: readonly string[];
	assessment_hash: string;
	verdict: "PASS" | "REPAIR" | "NOT_INSPECTED";
}

export interface InheritedSemanticStreamEvidenceV2 {
	source: "INHERITED";
	stream_id: string;
	path: string;
	content_hash: string;
	parent_evidence_hash: string;
	parent_stream_assessment_hash: string;
	dependency_closure_hash: string;
	inheritance_proof_hash: string;
	verdict: "PASS";
}

export type SemanticStreamEvidenceV2 = FreshSemanticStreamEvidenceV2 | InheritedSemanticStreamEvidenceV2;

export interface CrossFileAssessmentV2 {
	fresh: true;
	page_assessment_set_hash: string;
	reviewed_stream_set_hash: string;
	decision: "ACCEPT" | "REPAIR";
	blocking_finding_ids: readonly string[];
	affected_paths: readonly string[];
	summary_hash: string;
	assessment_hash: string;
}

export interface SemanticReviewEvidenceV2 {
	schema_version: typeof SEMANTIC_REVIEW_EVIDENCE_SCHEMA_VERSION_V2;
	kind: typeof SEMANTIC_REVIEW_EVIDENCE_KIND_V2;
	delegation_id: string;
	generation: number;
	generation_content_hash: string;
	contract_hash: string;
	bound_diff_hash: string;
	relevance_projection_hash: string;
	review_envelope_hash: string;
	review_policy_hash: string;
	model_identity: SemanticReviewModelIdentityV2;
	runtime_build_identity: string;
	stream_set_hash: string;
	parent_evidence_hash: string | null;
	streams: readonly SemanticStreamEvidenceV2[];
	cross_file_assessment: CrossFileAssessmentV2;
	final_decision: "ACCEPT" | "REPAIR";
	repair_reason: string | null;
	nested_usage: Readonly<Usage>;
	completed_at: string;
	evidence_hash: string;
}

export interface SemanticReviewEvidenceBindingV2 {
	delegation_id: string;
	generation: number;
	generation_content_hash: string;
	contract_hash: string;
	bound_diff_hash: string;
	relevance_projection_hash: string;
	review_envelope_hash: string;
	review_policy_hash: string;
	model_identity: SemanticReviewModelIdentityV2;
	runtime_build_identity: string;
	stream_set_hash: string;
	parent_evidence_hash: string | null;
}

export type SemanticReviewEvidenceBuildInputV2 = Omit<SemanticReviewEvidenceV2, "schema_version" | "kind" | "evidence_hash">;

export interface SemanticReviewInheritanceCurrentStreamV2 {
	stream_id: string;
	path: string;
	content_hash: string;
	roles: readonly string[];
}

export interface SemanticReviewDependencyEdgeV2 {
	from: string;
	to: string;
}

export interface PlanSemanticReviewInheritanceV2Input {
	current_streams: readonly SemanticReviewInheritanceCurrentStreamV2[];
	parent_evidence: Readonly<SemanticReviewEvidenceV2> | null;
	direct_parent_evidence_hash: string | null;
	contract_hash: string;
	review_policy_hash: string;
	model_identity: Readonly<SemanticReviewModelIdentityV2>;
	runtime_build_identity: string;
	lineage_contract_compatible?: boolean;
	declared_dependencies?: readonly SemanticReviewDependencyEdgeV2[];
	finding_paths?: readonly string[];
	scope_expansion?: boolean;
	unknown_paths?: readonly string[];
	binary_semantic_gaps?: readonly string[];
	relevance_projection_compatible?: boolean;
	review_envelope_compatible?: boolean;
}

export interface SemanticReviewInheritancePlanV2 {
	changed_paths: readonly string[];
	affected_paths: readonly string[];
	fresh_stream_ids: readonly string[];
	inherited_streams: readonly InheritedSemanticStreamEvidenceV2[];
	reasons: Readonly<Record<string, string>>;
	dependency_closure_hash: string;
	plan_hash: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: object, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...fields].sort();
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function hash(value: unknown): value is string {
	return typeof value === "string" && HASH_RE.test(value);
}

function validPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 400) return false;
	if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || value.startsWith("./") || value.endsWith("/")) return false;
	return !value.includes("//") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validText(value: unknown, maximum: number, allowEmpty = false): value is string {
	return typeof value === "string" && (allowEmpty || value.length > 0) && Buffer.byteLength(value, "utf8") <= maximum
		&& !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validUsage(value: unknown): value is Usage {
	if (!record(value) || !exactFields(value, [
		"input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost",
		...(value.cacheWrite1h === undefined ? [] : ["cacheWrite1h"]),
		...(value.reasoning === undefined ? [] : ["reasoning"]),
	]) || !safeCounter(value.input) || !safeCounter(value.output) || !safeCounter(value.cacheRead)
		|| !safeCounter(value.cacheWrite) || !safeCounter(value.totalTokens)
		|| !(value.cacheWrite1h === undefined || safeCounter(value.cacheWrite1h))
		|| !(value.reasoning === undefined || safeCounter(value.reasoning))
		|| !record(value.cost) || !exactFields(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"])
		|| !Object.values(value.cost).every(finiteNonNegative)) return false;
	const total = value.input + value.output + value.cacheRead + value.cacheWrite;
	return Number.isSafeInteger(total) && value.totalTokens === total;
}

function validModelIdentity(value: unknown): value is SemanticReviewModelIdentityV2 {
	return record(value) && exactFields(value, ["provider", "model", "api"])
		&& value.provider === "openai-codex" && value.model === "gpt-5.6-sol"
		&& validText(value.api, 120);
}

function compareUtf8(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function uniqueSortedStrings(value: unknown, validate: (item: unknown) => item is string, maximum: number): value is string[] {
	if (!Array.isArray(value) || value.length > maximum || !value.every(validate)) return false;
	return value.every((item, index) => index === 0 || compareUtf8(value[index - 1] as string, item as string) < 0);
}

function crossFileAssessmentProjection(value: Omit<CrossFileAssessmentV2, "assessment_hash">): unknown {
	return value;
}

export function computeCrossFileAssessmentHashV2(value: Omit<CrossFileAssessmentV2, "assessment_hash">): string {
	return canonicalHash(crossFileAssessmentProjection(value));
}

export function validateCrossFileAssessmentV2(value: unknown): value is CrossFileAssessmentV2 {
	if (!record(value) || !exactFields(value, [
		"fresh", "page_assessment_set_hash", "reviewed_stream_set_hash", "decision", "blocking_finding_ids",
		"affected_paths", "summary_hash", "assessment_hash",
	]) || value.fresh !== true || !hash(value.page_assessment_set_hash) || !hash(value.reviewed_stream_set_hash)
		|| (value.decision !== "ACCEPT" && value.decision !== "REPAIR")
		|| !uniqueSortedStrings(value.blocking_finding_ids, (item): item is string => validText(item, 80), 512)
		|| !uniqueSortedStrings(value.affected_paths, validPath, SEMANTIC_REVIEW_EVIDENCE_MAX_STREAMS_V2)
		|| !hash(value.summary_hash) || !hash(value.assessment_hash)) return false;
	const { assessment_hash: supplied, ...payload } = value;
	return supplied === computeCrossFileAssessmentHashV2(payload as Omit<CrossFileAssessmentV2, "assessment_hash">)
		&& (value.decision === "ACCEPT" ? value.blocking_finding_ids.length === 0 : true);
}

function validFreshStream(value: Record<string, unknown>): value is Record<string, unknown> & FreshSemanticStreamEvidenceV2 {
	return exactFields(value, [
		"source", "stream_id", "path", "content_hash", "page_binding_hashes", "assessment_hash", "verdict",
	]) && value.source === "FRESH" && validText(value.stream_id, 400) && validPath(value.path) && hash(value.content_hash)
		&& uniqueSortedStrings(value.page_binding_hashes, hash, 512) && hash(value.assessment_hash)
		&& ["PASS", "REPAIR", "NOT_INSPECTED"].includes(String(value.verdict));
}

function validInheritedStream(value: Record<string, unknown>): value is Record<string, unknown> & InheritedSemanticStreamEvidenceV2 {
	if (!exactFields(value, [
		"source", "stream_id", "path", "content_hash", "parent_evidence_hash", "parent_stream_assessment_hash",
		"dependency_closure_hash", "inheritance_proof_hash", "verdict",
	]) || value.source !== "INHERITED" || value.verdict !== "PASS" || !validText(value.stream_id, 400)
		|| !validPath(value.path) || !hash(value.content_hash) || !hash(value.parent_evidence_hash)
		|| !hash(value.parent_stream_assessment_hash) || !hash(value.dependency_closure_hash)
		|| !hash(value.inheritance_proof_hash)) return false;
	return value.inheritance_proof_hash === computeSemanticStreamInheritanceProofHashV2({
		stream_id: value.stream_id,
		path: value.path,
		content_hash: value.content_hash,
		parent_evidence_hash: value.parent_evidence_hash,
		parent_stream_assessment_hash: value.parent_stream_assessment_hash,
		dependency_closure_hash: value.dependency_closure_hash,
	});
}

export function validateSemanticStreamEvidenceV2(value: unknown): value is SemanticStreamEvidenceV2 {
	return record(value) && (value.source === "FRESH" ? validFreshStream(value) : validInheritedStream(value));
}

function evidenceHashProjection(value: Omit<SemanticReviewEvidenceV2, "evidence_hash">): unknown {
	const { completed_at: _completedAt, ...authority } = value;
	return authority;
}

export function computeSemanticReviewEvidenceHashV2(value: Omit<SemanticReviewEvidenceV2, "evidence_hash">): string {
	return canonicalHash(evidenceHashProjection(value));
}

export function validateSemanticReviewEvidenceV2(value: unknown): value is SemanticReviewEvidenceV2 {
	if (!record(value) || !exactFields(value, [
		"schema_version", "kind", "delegation_id", "generation", "generation_content_hash", "contract_hash",
		"bound_diff_hash", "relevance_projection_hash", "review_envelope_hash", "review_policy_hash", "model_identity",
		"runtime_build_identity", "stream_set_hash", "parent_evidence_hash", "streams", "cross_file_assessment",
		"final_decision", "repair_reason", "nested_usage", "completed_at", "evidence_hash",
	]) || value.schema_version !== SEMANTIC_REVIEW_EVIDENCE_SCHEMA_VERSION_V2
		|| value.kind !== SEMANTIC_REVIEW_EVIDENCE_KIND_V2 || typeof value.delegation_id !== "string"
		|| !DELEGATION_ID_RE.test(value.delegation_id) || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
		|| !hash(value.generation_content_hash) || !hash(value.contract_hash) || !hash(value.bound_diff_hash)
		|| !hash(value.relevance_projection_hash) || !hash(value.review_envelope_hash) || !hash(value.review_policy_hash)
		|| !validModelIdentity(value.model_identity) || !validText(value.runtime_build_identity, 240)
		|| !hash(value.stream_set_hash) || !(value.parent_evidence_hash === null || hash(value.parent_evidence_hash))
		|| !Array.isArray(value.streams) || value.streams.length > SEMANTIC_REVIEW_EVIDENCE_MAX_STREAMS_V2
		|| !value.streams.every(validateSemanticStreamEvidenceV2) || !validateCrossFileAssessmentV2(value.cross_file_assessment)
		|| (value.final_decision !== "ACCEPT" && value.final_decision !== "REPAIR")
		|| !(value.repair_reason === null || validText(value.repair_reason, 1_200)) || !validUsage(value.nested_usage)
		|| typeof value.completed_at !== "string" || !ISO_RE.test(value.completed_at)
		|| new Date(value.completed_at).toISOString() !== value.completed_at || !hash(value.evidence_hash)) return false;
	let priorPath: string | undefined;
	const streamIds = new Set<string>();
	for (const stream of value.streams) {
		if (priorPath !== undefined && compareUtf8(priorPath, stream.path) >= 0) return false;
		if (streamIds.has(stream.stream_id)) return false;
		priorPath = stream.path;
		streamIds.add(stream.stream_id);
		if (stream.source === "INHERITED" && stream.parent_evidence_hash !== value.parent_evidence_hash) return false;
	}
	if (value.cross_file_assessment.reviewed_stream_set_hash !== value.stream_set_hash
		|| value.cross_file_assessment.decision !== value.final_decision) return false;
	if (value.final_decision === "ACCEPT") {
		if (value.repair_reason !== null || value.cross_file_assessment.blocking_finding_ids.length !== 0
			|| value.streams.some((stream) => stream.verdict !== "PASS")) return false;
	} else if (value.repair_reason === null) return false;
	const { evidence_hash: supplied, ...payload } = value;
	return supplied === computeSemanticReviewEvidenceHashV2(payload as Omit<SemanticReviewEvidenceV2, "evidence_hash">)
		&& Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8") <= SEMANTIC_REVIEW_EVIDENCE_MAX_BYTES_V2;
}

export function buildSemanticReviewEvidenceV2(
	input: Readonly<SemanticReviewEvidenceBuildInputV2>,
): { ok: true; value: Readonly<SemanticReviewEvidenceV2> } | { ok: false; code: "INVALID_EVIDENCE" } {
	try {
		const cloned = structuredClone(input);
		const streams = [...cloned.streams].sort((left, right) => compareUtf8(left.path, right.path));
		const payload: Omit<SemanticReviewEvidenceV2, "evidence_hash"> = {
			schema_version: SEMANTIC_REVIEW_EVIDENCE_SCHEMA_VERSION_V2,
			kind: SEMANTIC_REVIEW_EVIDENCE_KIND_V2,
			...cloned,
			streams,
		};
		const value: SemanticReviewEvidenceV2 = { ...payload, evidence_hash: computeSemanticReviewEvidenceHashV2(payload) };
		return validateSemanticReviewEvidenceV2(value)
			? { ok: true, value: Object.freeze(value) }
			: { ok: false, code: "INVALID_EVIDENCE" };
	} catch {
		return { ok: false, code: "INVALID_EVIDENCE" };
	}
}

export function verifySemanticReviewEvidenceBindingV2(
	value: unknown,
	binding: Readonly<SemanticReviewEvidenceBindingV2>,
): value is SemanticReviewEvidenceV2 {
	if (!validateSemanticReviewEvidenceV2(value)) return false;
	return value.delegation_id === binding.delegation_id && value.generation === binding.generation
		&& value.generation_content_hash === binding.generation_content_hash && value.contract_hash === binding.contract_hash
		&& value.bound_diff_hash === binding.bound_diff_hash && value.relevance_projection_hash === binding.relevance_projection_hash
		&& value.review_envelope_hash === binding.review_envelope_hash && value.review_policy_hash === binding.review_policy_hash
		&& canonicalHash(value.model_identity) === canonicalHash(binding.model_identity)
		&& value.runtime_build_identity === binding.runtime_build_identity && value.stream_set_hash === binding.stream_set_hash
		&& value.parent_evidence_hash === binding.parent_evidence_hash;
}

/** Recompute every inherited stream proof from the exact immutable parent. */
export function verifySemanticReviewParentEvidenceV2(
	value: Readonly<SemanticReviewEvidenceV2>,
	parent: Readonly<SemanticReviewEvidenceV2> | null,
): boolean {
	if (!validateSemanticReviewEvidenceV2(value)) return false;
	const inherited = value.streams.filter((stream): stream is InheritedSemanticStreamEvidenceV2 => stream.source === "INHERITED");
	if (value.parent_evidence_hash === null) return parent === null && inherited.length === 0;
	if (parent === null || !validateSemanticReviewEvidenceV2(parent) || parent.evidence_hash !== value.parent_evidence_hash) return false;
	const parentByPath = new Map(parent.streams.map((stream) => [stream.path, stream]));
	return inherited.every((stream) => {
		const source = parentByPath.get(stream.path);
		return source !== undefined && source.stream_id === stream.stream_id && source.content_hash === stream.content_hash
			&& source.verdict === "PASS" && parentStreamAssessmentHash(source) === stream.parent_stream_assessment_hash
			&& stream.inheritance_proof_hash === computeSemanticStreamInheritanceProofHashV2({
				stream_id: stream.stream_id,
				path: stream.path,
				content_hash: stream.content_hash,
				parent_evidence_hash: parent.evidence_hash,
				parent_stream_assessment_hash: stream.parent_stream_assessment_hash,
				dependency_closure_hash: stream.dependency_closure_hash,
			});
	});
}

export function computeSemanticStreamInheritanceProofHashV2(input: {
	stream_id: string;
	path: string;
	content_hash: string;
	parent_evidence_hash: string;
	parent_stream_assessment_hash: string;
	dependency_closure_hash: string;
}): string {
	return canonicalHash({ schema_version: 2, kind: "semantic-stream-inheritance-proof-v2", ...input });
}

function parentStreamAssessmentHash(stream: SemanticStreamEvidenceV2): string {
	return stream.source === "FRESH" ? stream.assessment_hash : stream.inheritance_proof_hash;
}

function closure(seed: ReadonlySet<string>, edges: readonly SemanticReviewDependencyEdgeV2[]): Set<string> {
	const graph = new Map<string, Set<string>>();
	for (const edge of edges) {
		const left = graph.get(edge.from) ?? new Set<string>();
		const right = graph.get(edge.to) ?? new Set<string>();
		left.add(edge.to);
		right.add(edge.from);
		graph.set(edge.from, left);
		graph.set(edge.to, right);
	}
	const result = new Set(seed);
	const queue = [...seed];
	while (queue.length > 0) {
		for (const path of graph.get(queue.shift()!) ?? []) {
			if (!result.has(path)) { result.add(path); queue.push(path); }
		}
	}
	return result;
}

export function planSemanticReviewInheritanceV2(
	input: Readonly<PlanSemanticReviewInheritanceV2Input>,
): Readonly<SemanticReviewInheritancePlanV2> {
	const current = [...input.current_streams].sort((left, right) => compareUtf8(left.path, right.path));
	const parentValid = input.parent_evidence !== null && validateSemanticReviewEvidenceV2(input.parent_evidence)
		&& input.direct_parent_evidence_hash !== null && input.parent_evidence.evidence_hash === input.direct_parent_evidence_hash;
	const parentByPath = new Map((parentValid ? input.parent_evidence!.streams : []).map((stream) => [stream.path, stream]));
	const currentPaths = new Set(current.map((stream) => stream.path));
	const changed = new Set<string>();
	for (const stream of current) {
		const parent = parentByPath.get(stream.path);
		if (parent === undefined || parent.content_hash !== stream.content_hash || parent.stream_id !== stream.stream_id) changed.add(stream.path);
	}
	for (const path of parentByPath.keys()) if (!currentPaths.has(path)) changed.add(path);
	for (const path of input.unknown_paths ?? []) changed.add(path);
	for (const path of input.binary_semantic_gaps ?? []) changed.add(path);
	const findingSeeds = new Set([
		...(input.finding_paths ?? []),
		...(parentValid ? input.parent_evidence!.cross_file_assessment.affected_paths : []),
	]);
	const affected = closure(new Set([...changed, ...findingSeeds]), input.declared_dependencies ?? []);
	const dependencyClosureHash = canonicalHash({
		edges: [...(input.declared_dependencies ?? [])].map((edge) => [edge.from, edge.to]).sort((left, right) =>
			compareUtf8(`${left[0]}\0${left[1]}`, `${right[0]}\0${right[1]}`)),
		affected_paths: [...affected].sort(compareUtf8),
	});
	const globallyCompatible = parentValid
		&& (input.parent_evidence!.contract_hash === input.contract_hash || input.lineage_contract_compatible === true)
		&& input.parent_evidence!.review_policy_hash === input.review_policy_hash
		&& canonicalHash(input.parent_evidence!.model_identity) === canonicalHash(input.model_identity)
		&& input.parent_evidence!.runtime_build_identity === input.runtime_build_identity
		&& input.scope_expansion !== true && input.relevance_projection_compatible !== false
		&& input.review_envelope_compatible !== false;
	const inherited: InheritedSemanticStreamEvidenceV2[] = [];
	const fresh: string[] = [];
	const reasons: Record<string, string> = {};
	for (const stream of current) {
		const parent = parentByPath.get(stream.path);
		let reason = "INHERITED";
		if (!globallyCompatible) reason = parentValid ? "GLOBAL_BINDING_DRIFT" : "PARENT_EVIDENCE_INVALID";
		else if (parent === undefined || parent.content_hash !== stream.content_hash || parent.stream_id !== stream.stream_id) reason = "CONTENT_CHANGED";
		else if (affected.has(stream.path)) reason = changed.has(stream.path) ? "CONTENT_CHANGED" : "DEPENDENCY_OR_FINDING_AFFECTED";
		else if (parent.verdict !== "PASS") reason = "PARENT_STREAM_NOT_PASS";
		if (reason !== "INHERITED" || parent === undefined || input.direct_parent_evidence_hash === null) {
			fresh.push(stream.stream_id);
			reasons[stream.stream_id] = reason;
			continue;
		}
		const parentAssessmentHash = parentStreamAssessmentHash(parent);
		const proof = {
			source: "INHERITED" as const,
			stream_id: stream.stream_id,
			path: stream.path,
			content_hash: stream.content_hash,
			parent_evidence_hash: input.direct_parent_evidence_hash,
			parent_stream_assessment_hash: parentAssessmentHash,
			dependency_closure_hash: dependencyClosureHash,
			inheritance_proof_hash: computeSemanticStreamInheritanceProofHashV2({
				stream_id: stream.stream_id,
				path: stream.path,
				content_hash: stream.content_hash,
				parent_evidence_hash: input.direct_parent_evidence_hash,
				parent_stream_assessment_hash: parentAssessmentHash,
				dependency_closure_hash: dependencyClosureHash,
			}),
			verdict: "PASS" as const,
		};
		inherited.push(proof);
		reasons[stream.stream_id] = reason;
	}
	const payload = {
		changed_paths: [...changed].sort(compareUtf8),
		affected_paths: [...affected].sort(compareUtf8),
		fresh_stream_ids: fresh.sort(compareUtf8),
		inherited_streams: inherited.sort((left, right) => compareUtf8(left.path, right.path)),
		reasons: Object.fromEntries(Object.entries(reasons).sort(([left], [right]) => compareUtf8(left, right))),
		dependency_closure_hash: dependencyClosureHash,
	};
	return Object.freeze({ ...payload, plan_hash: canonicalHash(payload) });
}
