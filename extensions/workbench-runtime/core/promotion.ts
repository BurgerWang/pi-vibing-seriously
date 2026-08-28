/** WP5 explicit Candidate promotion and release-provenance authority. */

import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { canonicalHash } from "../cache/canonical-hash.ts";
import { validateCommittedArtifactsV2, type ArtifactIdentityV2 } from "./artifact-contract.ts";
import { freezeCurrentCandidateV1, readCandidateVersionV1, resolveCurrentCandidateV1, writeCandidateAliasV1 } from "./candidate.ts";
import { parseGateCandidateBindingV1, type GateCandidateBindingV1 } from "./candidate-binding.ts";
import { runRuntimeIdentityIsCurrentV1 } from "./candidate-identity.ts";
import { loadProjectConfig, type ExecFn } from "./config.ts";
import { readPersistedGateRunFacts, runGates } from "./gate-engine.ts";
import type { GateStatus, WorkerFirstGateFacts } from "./gate-schema.ts";
import { assessRunValidation } from "./validation-assessment.ts";
import { parseValidationEvidenceBlock, type ValidationBinding } from "./validation-evidence.ts";
import { isValidRunId, readCommittedManifest, runDirFor } from "./runs.ts";
import type { RecipeMutationFacts } from "./worker-policy.ts";
import { readJsonFileBounded } from "./bounded-file-io.ts";

const HASH_RE = /^[0-9a-f]{64}$/u;
const PROMOTION_MAX_BYTES = 1_048_576;

export type PromotionTargetV1 = "RESEARCH_ACCEPTED" | "RELEASE_AUTHORIZED";

export interface ReleaseProvenanceV1 {
	schema_version: 1;
	kind: "workbench-release-provenance-v1";
	source: {
		candidate_identity: string;
		candidate_source_run_id: string;
		commit: string | null;
		diff_hash: string;
	};
	build: {
		run_id: string;
		recipe: string;
		definition_hash: string;
		invocation_hash: string;
		cwd: string;
		runtime_identity_hash: string;
	};
	resolved_inputs: {
		lockfiles: Record<string, string>;
		config_hash: string;
		gate_state_hash: string;
		profile: string | null;
	};
	artifact_manifest_identity: string;
	artifacts: ArtifactIdentityV2[];
}

export interface PromotionRecordV1 {
	schema_version: 1;
	kind: "workbench-candidate-promotion-v1";
	promotion_identity: string;
	target: PromotionTargetV1;
	candidate_binding: GateCandidateBindingV1;
	gate_run_id: string;
	gate_status: "PASS";
	current_preflight_identity: string;
	explicit_user_authorization: true;
	release_authority: boolean;
	profitability_authority: false;
	better_strategy_authority: false;
	release_provenance: ReleaseProvenanceV1 | null;
	created_at: string;
}

export type PromotionResultV1 =
	| { ok: true; record: PromotionRecordV1; gateRunId: string }
	| {
		ok: false;
		code:
			| "INVALID_INPUT"
			| "CANDIDATE_UNAVAILABLE"
			| "GATES_NOT_PASS"
			| "GATE_AUTHORITY_UNAVAILABLE"
			| "RELEASE_AUTHORIZATION_REQUIRED"
			| "RELEASE_ARTIFACT_UNAVAILABLE"
			| "RELEASE_SOURCE_MISMATCH"
			| "STORAGE_UNAVAILABLE";
		candidateIdentity?: string;
		gateRunId?: string;
		gateStatus?: GateStatus;
	};

function promotionVersionPath(identity: string): string {
	return `${CONFIG_DIR_NAME}/workbench/promotions/versions/${identity}.json`;
}

function finiteIso(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function parseReleaseProvenanceV1(value: unknown, binding: GateCandidateBindingV1): ReleaseProvenanceV1 | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!exactKeys(record, ["artifact_manifest_identity", "artifacts", "build", "kind", "resolved_inputs", "schema_version", "source"]) ||
		record.schema_version !== 1 || record.kind !== "workbench-release-provenance-v1" ||
		typeof record.artifact_manifest_identity !== "string" || !HASH_RE.test(record.artifact_manifest_identity) ||
		!Array.isArray(record.artifacts) || record.artifacts.length === 0 || record.artifacts.length > 10_000) return null;
	const source = record.source;
	const build = record.build;
	const inputs = record.resolved_inputs;
	if (typeof source !== "object" || source === null || Array.isArray(source) ||
		typeof build !== "object" || build === null || Array.isArray(build) ||
		typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) return null;
	const sourceRecord = source as Record<string, unknown>;
	const buildRecord = build as Record<string, unknown>;
	const inputRecord = inputs as Record<string, unknown>;
	if (!exactKeys(sourceRecord, ["candidate_identity", "candidate_source_run_id", "commit", "diff_hash"]) ||
		sourceRecord.candidate_identity !== binding.candidate_identity || sourceRecord.candidate_source_run_id !== binding.candidate_source_run_id ||
		!(sourceRecord.commit === null || typeof sourceRecord.commit === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceRecord.commit)) ||
		typeof sourceRecord.diff_hash !== "string" || !HASH_RE.test(sourceRecord.diff_hash)) return null;
	if (!exactKeys(buildRecord, ["cwd", "definition_hash", "invocation_hash", "recipe", "run_id", "runtime_identity_hash"]) ||
		typeof buildRecord.run_id !== "string" || !isValidRunId(buildRecord.run_id) ||
		typeof buildRecord.recipe !== "string" || buildRecord.recipe.length === 0 || buildRecord.recipe.length > 256 ||
		typeof buildRecord.definition_hash !== "string" || !HASH_RE.test(buildRecord.definition_hash) ||
		typeof buildRecord.invocation_hash !== "string" || !HASH_RE.test(buildRecord.invocation_hash) ||
		typeof buildRecord.cwd !== "string" || buildRecord.cwd.length > 4_096 ||
		typeof buildRecord.runtime_identity_hash !== "string" || !HASH_RE.test(buildRecord.runtime_identity_hash)) return null;
	if (!exactKeys(inputRecord, ["config_hash", "gate_state_hash", "lockfiles", "profile"]) ||
		typeof inputRecord.config_hash !== "string" || !HASH_RE.test(inputRecord.config_hash) ||
		typeof inputRecord.gate_state_hash !== "string" || !HASH_RE.test(inputRecord.gate_state_hash) ||
		!(inputRecord.profile === null || typeof inputRecord.profile === "string" && inputRecord.profile.length <= 256) ||
		typeof inputRecord.lockfiles !== "object" || inputRecord.lockfiles === null || Array.isArray(inputRecord.lockfiles) ||
		Object.entries(inputRecord.lockfiles as Record<string, unknown>).some(([key, item]) => key.length === 0 || key.length > 4_096 || typeof item !== "string" || item.length > 256)) return null;
	for (const artifact of record.artifacts) {
		if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) return null;
		const item = artifact as Record<string, unknown>;
		if (!exactKeys(item, ["bytes", "contract_index", "external_root", "freshness", "path", "root", "root_identity", "sha256", "snapshot_path"]) ||
			typeof item.contract_index !== "number" || !Number.isSafeInteger(item.contract_index) || item.contract_index < 0 ||
			typeof item.path !== "string" || item.path.length === 0 || item.path.length > 4_096 ||
			typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0 ||
			typeof item.sha256 !== "string" || !HASH_RE.test(item.sha256) ||
			(item.freshness !== "current" && item.freshness !== "immutable-snapshot") ||
			!(item.snapshot_path === null || typeof item.snapshot_path === "string") ||
			(item.root !== "project" && item.root !== "authorized-external") ||
			!(item.external_root === null || typeof item.external_root === "string") ||
			!(item.root_identity === null || typeof item.root_identity === "string" && HASH_RE.test(item.root_identity))) return null;
	}
	return record as unknown as ReleaseProvenanceV1;
}

async function readBoundedJson(path: string): Promise<unknown | null> {
	try {
		const read = await readJsonFileBounded(path, PROMOTION_MAX_BYTES);
		return read.ok ? read.value.value : null;
	} catch {
		return null;
	}
}

function parsePromotionRecordV1(value: unknown): PromotionRecordV1 | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!exactKeys(record, [
		"better_strategy_authority", "candidate_binding", "created_at", "current_preflight_identity", "explicit_user_authorization",
		"gate_run_id", "gate_status", "kind", "profitability_authority", "promotion_identity", "release_authority",
		"release_provenance", "schema_version", "target",
	]) || record.schema_version !== 1 || record.kind !== "workbench-candidate-promotion-v1" ||
		typeof record.promotion_identity !== "string" || !HASH_RE.test(record.promotion_identity) ||
		(record.target !== "RESEARCH_ACCEPTED" && record.target !== "RELEASE_AUTHORIZED") ||
		record.gate_status !== "PASS" || typeof record.gate_run_id !== "string" || !isValidRunId(record.gate_run_id) ||
		typeof record.current_preflight_identity !== "string" || !HASH_RE.test(record.current_preflight_identity) ||
		record.explicit_user_authorization !== true || typeof record.release_authority !== "boolean" ||
		record.profitability_authority !== false || record.better_strategy_authority !== false ||
		!finiteIso(record.created_at)) return null;
	const binding = parseGateCandidateBindingV1(record.candidate_binding);
	if (!binding) return null;
	const provenance = record.release_provenance === null ? null : parseReleaseProvenanceV1(record.release_provenance, binding);
	if (record.target === "RESEARCH_ACCEPTED" && (record.release_authority !== false || provenance !== null)) return null;
	if (record.target === "RELEASE_AUTHORIZED" && (record.release_authority !== true || provenance === null)) return null;
	const { promotion_identity: ignored, ...identityInput } = record;
	if (canonicalHash(identityInput) !== record.promotion_identity) return null;
	return record as unknown as PromotionRecordV1;
}

async function ensurePromotionStorage(projectRoot: string): Promise<string | null> {
	try {
		const project = await realpath(projectRoot);
		const workbench = join(projectRoot, CONFIG_DIR_NAME, "workbench");
		const workbenchStat = await lstat(workbench);
		if (!workbenchStat.isDirectory() || workbenchStat.isSymbolicLink()) return null;
		const rel = relative(project, await realpath(workbench));
		if (rel.startsWith("..") || isAbsolute(rel)) return null;
		const root = join(workbench, "promotions");
		const versions = join(root, "versions");
		for (const path of [root, versions]) {
			try {
				await mkdir(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const stat = await lstat(path);
			if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
		}
		return versions;
	} catch {
		return null;
	}
}

async function persistPromotion(projectRoot: string, record: PromotionRecordV1): Promise<boolean> {
	const versions = await ensurePromotionStorage(projectRoot);
	if (!versions) return false;
	const path = join(versions, `${record.promotion_identity}.json`);
	const bytes = `${JSON.stringify(record, null, 2)}\n`;
	try {
		await writeFile(path, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
	}
	return isDeepStrictEqual(parsePromotionRecordV1(await readBoundedJson(path)), record);
}

export async function readPromotionRecordV1(projectRoot: string, identity: string): Promise<PromotionRecordV1 | null> {
	if (!HASH_RE.test(identity)) return null;
	const record = parsePromotionRecordV1(await readBoundedJson(join(projectRoot, promotionVersionPath(identity))));
	return record?.promotion_identity === identity ? record : null;
}

function sameSourceState(candidate: ValidationBinding, build: ValidationBinding): boolean {
	return candidate.commit === build.commit && candidate.diff_hash === build.diff_hash &&
		isDeepStrictEqual(candidate.lockfiles, build.lockfiles) && candidate.config_hash === build.config_hash &&
		candidate.gate_state_hash === build.gate_state_hash && (candidate.profile ?? null) === (build.profile ?? null);
}

async function releaseProvenance(input: {
	projectRoot: string;
	artifactRunId: string;
	binding: GateCandidateBindingV1;
	exec: ExecFn;
	actorFacts?: RecipeMutationFacts;
}): Promise<ReleaseProvenanceV1 | null> {
	const candidateRun = await readCommittedManifest(input.projectRoot, input.binding.candidate_source_run_id);
	const buildRun = await readCommittedManifest(input.projectRoot, input.artifactRunId);
	if (!candidateRun || !buildRun || buildRun.recipe === "gate" || buildRun.mode !== "VERIFY" ||
		!runRuntimeIdentityIsCurrentV1(buildRun.runtime_identity) || typeof buildRun.argv_hash !== "string") return null;
	const candidateBlock = parseValidationEvidenceBlock(candidateRun.validation_evidence);
	const buildBlock = parseValidationEvidenceBlock(buildRun.validation_evidence);
	if (!candidateBlock.ok || !buildBlock.ok || candidateBlock.block.binding === null || buildBlock.block.binding === null) return null;
	const candidateValidation = candidateBlock.block.binding;
	const buildValidation = buildBlock.block.binding;
	if (buildValidation.kind !== "recipe" || buildValidation.target.kind !== "recipe" ||
		buildValidation.owner !== "sol" || !buildValidation.outcome.successful || !buildValidation.outcome.complete ||
		!sameSourceState(candidateValidation, buildValidation)) return null;
	const assessment = await assessRunValidation({
		projectRoot: input.projectRoot,
		mode: "VERIFY",
		exec: input.exec,
		manifest: buildRun,
		actorFacts: input.actorFacts,
	});
	if (assessment.status !== "REUSABLE") return null;
	const config = await loadProjectConfig(input.projectRoot, { trusted: true });
	const artifacts = await validateCommittedArtifactsV2(
		input.projectRoot,
		runDirFor(input.projectRoot, input.artifactRunId),
		input.artifactRunId,
		{ authorizedExternalRoots: config.artifactExternalRoots, exec: input.exec },
	);
	if (!artifacts.ok || artifacts.manifest.artifacts.length === 0) return null;
	return {
		schema_version: 1,
		kind: "workbench-release-provenance-v1",
		source: {
			candidate_identity: input.binding.candidate_identity,
			candidate_source_run_id: input.binding.candidate_source_run_id,
			commit: candidateValidation.commit,
			diff_hash: candidateValidation.diff_hash,
		},
		build: {
			run_id: buildRun.run_id,
			recipe: buildRun.recipe,
			definition_hash: buildValidation.target.definition_hash,
			invocation_hash: buildRun.argv_hash,
			cwd: buildValidation.target.cwd,
			runtime_identity_hash: canonicalHash(buildRun.runtime_identity),
		},
		resolved_inputs: {
			lockfiles: candidateValidation.lockfiles,
			config_hash: candidateValidation.config_hash,
			gate_state_hash: candidateValidation.gate_state_hash,
			profile: candidateValidation.profile ?? null,
		},
		artifact_manifest_identity: canonicalHash(artifacts.manifest),
		artifacts: artifacts.manifest.artifacts,
	};
}

/**
 * Freeze the current ordinary Candidate, execute one complete VERIFY Gate run,
 * then publish an immutable promotion record. Failure never blocks DEV or
 * mutates the frozen Candidate; only the requested movable alias is withheld.
 */
export async function promoteCandidateV1(input: {
	projectRoot: string;
	target: PromotionTargetV1;
	expectedCandidateIdentity: string;
	sourceRunId: string;
	artifactRunId?: string;
	releaseAuthorized?: boolean;
	authorizationProvenance: "user-command";
	manualEvidence?: Record<string, string>;
	workerFirstFacts?: WorkerFirstGateFacts;
	actorFacts?: RecipeMutationFacts;
	exec: ExecFn;
	signal?: AbortSignal;
	now?: () => Date;
}): Promise<PromotionResultV1> {
	if (input.authorizationProvenance !== "user-command" || !HASH_RE.test(input.expectedCandidateIdentity) ||
		(input.target !== "RESEARCH_ACCEPTED" && input.target !== "RELEASE_AUTHORIZED")) return { ok: false, code: "INVALID_INPUT" };
	if (input.target === "RELEASE_AUTHORIZED" && input.releaseAuthorized !== true) {
		return { ok: false, code: "RELEASE_AUTHORIZATION_REQUIRED", candidateIdentity: input.expectedCandidateIdentity };
	}
	const now = input.now ?? (() => new Date());
	const startedAt = now();
	const frozen = await freezeCurrentCandidateV1({
		project_root: input.projectRoot,
		expected_candidate_identity: input.expectedCandidateIdentity,
		source_run_id: input.sourceRunId,
		exec: input.exec,
		actor_facts: input.actorFacts,
		now: startedAt.toISOString(),
	});
	if (!frozen.ok) return { ok: false, code: "CANDIDATE_UNAVAILABLE", candidateIdentity: input.expectedCandidateIdentity };

	const gateResult = await runGates({
		projectRoot: input.projectRoot,
		selector: "all",
		mode: "VERIFY",
		exec: input.exec,
		signal: input.signal,
		now,
		manualEvidence: input.manualEvidence,
		manualEvidenceProvenance: "user-command",
		workerFirstFacts: input.workerFirstFacts,
		actorFacts: input.actorFacts,
		candidateBinding: frozen.binding,
	});
	if (!gateResult.ok || gateResult.status !== "PASS") {
		return {
			ok: false,
			code: "GATES_NOT_PASS",
			candidateIdentity: frozen.candidate.candidate_identity,
			gateRunId: gateResult.runId,
			gateStatus: gateResult.status,
		};
	}
	const gateManifest = await readCommittedManifest(input.projectRoot, gateResult.runId);
	const gateFacts = gateManifest && await readPersistedGateRunFacts(input.projectRoot, gateResult.runId, gateManifest);
	const gateAssessment = gateManifest && await assessRunValidation({
		projectRoot: input.projectRoot,
		mode: "VERIFY",
		exec: input.exec,
		manifest: gateManifest,
		actorFacts: input.actorFacts,
		workerFirstFacts: input.workerFirstFacts,
	});
	if (!gateManifest || !gateFacts || !isDeepStrictEqual(gateFacts.candidateBinding, frozen.binding) || gateAssessment?.status !== "REUSABLE") {
		return { ok: false, code: "GATE_AUTHORITY_UNAVAILABLE", candidateIdentity: frozen.candidate.candidate_identity, gateRunId: gateResult.runId };
	}
	const current = await resolveCurrentCandidateV1({
		project_root: input.projectRoot,
		expected_candidate_identity: frozen.candidate.candidate_identity,
		source_run_id: frozen.candidate.source_run_id,
		exec: input.exec,
		actor_facts: input.actorFacts,
	});
	const immutableCandidate = await readCandidateVersionV1(input.projectRoot, frozen.candidate.candidate_identity);
	if (!current.ok || !immutableCandidate || !isDeepStrictEqual(current.candidate, immutableCandidate)) {
		return { ok: false, code: "CANDIDATE_UNAVAILABLE", candidateIdentity: frozen.candidate.candidate_identity, gateRunId: gateResult.runId };
	}

	let provenance: ReleaseProvenanceV1 | null = null;
	if (input.target === "RELEASE_AUTHORIZED") {
		if (!input.artifactRunId) {
			return { ok: false, code: "RELEASE_ARTIFACT_UNAVAILABLE", candidateIdentity: frozen.candidate.candidate_identity, gateRunId: gateResult.runId };
		}
		provenance = await releaseProvenance({
			projectRoot: input.projectRoot,
			artifactRunId: input.artifactRunId,
			binding: frozen.binding,
			exec: input.exec,
			actorFacts: input.actorFacts,
		});
		if (!provenance) {
			return { ok: false, code: "RELEASE_SOURCE_MISMATCH", candidateIdentity: frozen.candidate.candidate_identity, gateRunId: gateResult.runId };
		}
	}

	const createdAt = now().toISOString();
	const identityInput = {
		schema_version: 1 as const,
		kind: "workbench-candidate-promotion-v1" as const,
		target: input.target,
		candidate_binding: frozen.binding,
		gate_run_id: gateResult.runId,
		gate_status: "PASS" as const,
		current_preflight_identity: canonicalHash({ candidate: current.candidate, gate_run_id: gateResult.runId }),
		explicit_user_authorization: true as const,
		release_authority: input.target === "RELEASE_AUTHORIZED",
		profitability_authority: false as const,
		better_strategy_authority: false as const,
		release_provenance: provenance,
		created_at: createdAt,
	};
	const record: PromotionRecordV1 = {
		...identityInput,
		promotion_identity: canonicalHash(identityInput),
	};
	if (!await persistPromotion(input.projectRoot, record)) {
		return { ok: false, code: "STORAGE_UNAVAILABLE", candidateIdentity: frozen.candidate.candidate_identity, gateRunId: gateResult.runId };
	}
	const alias = await writeCandidateAliasV1({
		project_root: input.projectRoot,
		alias: input.target === "RELEASE_AUTHORIZED" ? "release-candidate" : "champion",
		candidate: frozen.candidate,
		promotion_identity: record.promotion_identity,
		updated_at: createdAt,
	});
	if (!alias) return { ok: false, code: "STORAGE_UNAVAILABLE", candidateIdentity: frozen.candidate.candidate_identity, gateRunId: gateResult.runId };
	return { ok: true, record, gateRunId: gateResult.runId };
}
