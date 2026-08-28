/** Pure, dependency-light WP5 Candidate binding contract shared by run readers. */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface GateCandidateBindingV1 {
	schema_version: 1;
	kind: "workbench-gate-candidate-binding-v1";
	candidate_identity: string;
	candidate_source_run_id: string;
	candidate_version_path: string;
	validation_identity: string;
	artifact_manifest_identity: string;
	runtime_identity_hash: string;
}

const HASH_RE = /^[0-9a-f]{64}$/u;
const RUN_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/u;

export function candidateVersionPathV1(identity: string): string {
	return `${CONFIG_DIR_NAME}/workbench/candidates/versions/${identity}.json`;
}

export function parseGateCandidateBindingV1(value: unknown): GateCandidateBindingV1 | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join("\u0000") !== [
		"artifact_manifest_identity", "candidate_identity", "candidate_source_run_id", "candidate_version_path", "kind",
		"runtime_identity_hash", "schema_version", "validation_identity",
	].sort().join("\u0000")) return null;
	if (record.schema_version !== 1 || record.kind !== "workbench-gate-candidate-binding-v1" ||
		typeof record.candidate_identity !== "string" || !HASH_RE.test(record.candidate_identity) ||
		typeof record.validation_identity !== "string" || !HASH_RE.test(record.validation_identity) ||
		typeof record.artifact_manifest_identity !== "string" || !HASH_RE.test(record.artifact_manifest_identity) ||
		typeof record.runtime_identity_hash !== "string" || !HASH_RE.test(record.runtime_identity_hash) ||
		typeof record.candidate_source_run_id !== "string" || !RUN_ID_RE.test(record.candidate_source_run_id) ||
		record.candidate_version_path !== candidateVersionPathV1(record.candidate_identity)) return null;
	return record as unknown as GateCandidateBindingV1;
}

/** Stable, privacy-safe source-authority edge reproduced from persisted Gate facts. */
export function gateCandidateSourceAuthorityV1(binding: GateCandidateBindingV1): string {
	return [
		binding.candidate_identity,
		binding.candidate_source_run_id,
		binding.validation_identity,
		binding.artifact_manifest_identity,
		binding.runtime_identity_hash,
	].join(":");
}
