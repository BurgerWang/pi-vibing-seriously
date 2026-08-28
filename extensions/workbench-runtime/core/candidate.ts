/** WP5 immutable Candidate versions and movable aliases. */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { readArtifactManifestV2 } from "./artifact-contract.ts";
import {
	candidateVersionPathV1,
	ordinaryCandidateProjectionFromRunV1,
	type GateCandidateBindingV1,
} from "./candidate-identity.ts";
import type { ExecFn } from "./config.ts";
import { assessRunValidation } from "./validation-assessment.ts";
import { isValidRunId, readCommittedManifest, runDirFor } from "./runs.ts";
import type { RecipeMutationFacts } from "./worker-policy.ts";
import { readJsonFileBounded } from "./bounded-file-io.ts";

const HASH_RE = /^[0-9a-f]{64}$/u;
const CANDIDATE_RECORD_MAX_BYTES = 65_536;

export type CandidateAliasNameV1 = "current" | "champion" | "release-candidate";

export interface CandidateVersionV1 {
	schema_version: 1;
	kind: "workbench-candidate-version-v1";
	candidate_identity: string;
	source_run_id: string;
	validation_identity: string;
	artifact_manifest_identity: string;
	runtime_identity_hash: string;
	source_finished_at: string;
	authority_scope: "DEVELOPMENT_ONLY";
}

export interface CandidateAliasV1 {
	schema_version: 1;
	kind: "workbench-candidate-alias-v1";
	alias: CandidateAliasNameV1;
	candidate_identity: string;
	candidate_version_path: string;
	promotion_identity: string | null;
	updated_at: string;
}

export type CandidateResolutionV1 =
	| { ok: true; candidate: CandidateVersionV1; binding: GateCandidateBindingV1; version_path: string }
	| { ok: false; code: "INVALID_INPUT" | "SOURCE_UNAVAILABLE" | "CANDIDATE_INCOMPLETE" | "CANDIDATE_IDENTITY_MISMATCH" | "CANDIDATE_NOT_CURRENT" | "STORAGE_UNAVAILABLE" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteIso(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseCandidateVersionV1(value: unknown): CandidateVersionV1 | null {
	if (!isRecord(value)) return null;
	const keys = Object.keys(value).sort();
	if (keys.join("\u0000") !== [
		"artifact_manifest_identity", "authority_scope", "candidate_identity", "kind", "runtime_identity_hash",
		"schema_version", "source_finished_at", "source_run_id", "validation_identity",
	].sort().join("\u0000")) return null;
	if (value.schema_version !== 1 || value.kind !== "workbench-candidate-version-v1" ||
		value.authority_scope !== "DEVELOPMENT_ONLY" ||
		typeof value.candidate_identity !== "string" || !HASH_RE.test(value.candidate_identity) ||
		typeof value.validation_identity !== "string" || !HASH_RE.test(value.validation_identity) ||
		typeof value.artifact_manifest_identity !== "string" || !HASH_RE.test(value.artifact_manifest_identity) ||
		typeof value.runtime_identity_hash !== "string" || !HASH_RE.test(value.runtime_identity_hash) ||
		typeof value.source_run_id !== "string" || !isValidRunId(value.source_run_id) ||
		!finiteIso(value.source_finished_at)) return null;
	return value as unknown as CandidateVersionV1;
}

function parseCandidateAliasV1(value: unknown): CandidateAliasV1 | null {
	if (!isRecord(value)) return null;
	const keys = Object.keys(value).sort();
	if (keys.join("\u0000") !== [
		"alias", "candidate_identity", "candidate_version_path", "kind", "promotion_identity", "schema_version", "updated_at",
	].sort().join("\u0000")) return null;
	if (value.schema_version !== 1 || value.kind !== "workbench-candidate-alias-v1" ||
		(value.alias !== "current" && value.alias !== "champion" && value.alias !== "release-candidate")) return null;
	if (typeof value.candidate_identity !== "string" || !HASH_RE.test(value.candidate_identity) ||
		value.candidate_version_path !== candidateVersionPathV1(value.candidate_identity) ||
		!(value.promotion_identity === null || typeof value.promotion_identity === "string" && HASH_RE.test(value.promotion_identity)) ||
		!finiteIso(value.updated_at)) return null;
	return value as unknown as CandidateAliasV1;
}

async function readBoundedJson(path: string): Promise<unknown | null> {
	try {
		const read = await readJsonFileBounded(path, CANDIDATE_RECORD_MAX_BYTES);
		return read.ok ? read.value.value : null;
	} catch {
		return null;
	}
}

async function ensureStorageDirs(projectRoot: string): Promise<{ versions: string; aliases: string } | null> {
	try {
		const project = await realpath(projectRoot);
		const workbench = join(projectRoot, CONFIG_DIR_NAME, "workbench");
		const workbenchStat = await lstat(workbench);
		if (!workbenchStat.isDirectory() || workbenchStat.isSymbolicLink()) return null;
		const workbenchReal = await realpath(workbench);
		const rel = relative(project, workbenchReal);
		if (rel.startsWith("..") || isAbsolute(rel)) return null;
		const root = join(workbench, "candidates");
		const versions = join(root, "versions");
		const aliases = join(root, "aliases");
		for (const path of [root, versions, aliases]) {
			try {
				await mkdir(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const stat = await lstat(path);
			if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
		}
		return { versions, aliases };
	} catch {
		return null;
	}
}

async function writeImmutableVersion(path: string, candidate: CandidateVersionV1): Promise<boolean> {
	const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
	try {
		await writeFile(path, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
		return parseCandidateVersionV1(await readBoundedJson(path))?.candidate_identity === candidate.candidate_identity;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
		const existing = parseCandidateVersionV1(await readBoundedJson(path));
		return existing !== null && JSON.stringify(existing) === JSON.stringify(candidate);
	}
}

export async function writeCandidateAliasV1(input: {
	project_root: string;
	alias: CandidateAliasNameV1;
	candidate: CandidateVersionV1;
	promotion_identity?: string;
	updated_at: string;
}): Promise<CandidateAliasV1 | null> {
	if (!finiteIso(input.updated_at) || input.promotion_identity !== undefined && !HASH_RE.test(input.promotion_identity)) return null;
	const dirs = await ensureStorageDirs(input.project_root);
	if (!dirs) return null;
	const record: CandidateAliasV1 = {
		schema_version: 1,
		kind: "workbench-candidate-alias-v1",
		alias: input.alias,
		candidate_identity: input.candidate.candidate_identity,
		candidate_version_path: candidateVersionPathV1(input.candidate.candidate_identity),
		promotion_identity: input.promotion_identity ?? null,
		updated_at: input.updated_at,
	};
	const target = join(dirs.aliases, `${input.alias}.json`);
	const temp = join(dirs.aliases, `.${input.alias}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(temp, target);
		const readback = parseCandidateAliasV1(await readBoundedJson(target));
		return readback !== null && JSON.stringify(readback) === JSON.stringify(record) ? readback : null;
	} catch {
		await unlink(temp).catch(() => {});
		return null;
	}
}

export async function readCandidateVersionV1(projectRoot: string, identity: string): Promise<CandidateVersionV1 | null> {
	if (!HASH_RE.test(identity)) return null;
	const value = parseCandidateVersionV1(await readBoundedJson(join(projectRoot, candidateVersionPathV1(identity))));
	return value?.candidate_identity === identity ? value : null;
}

export async function readCandidateAliasV1(projectRoot: string, alias: CandidateAliasNameV1): Promise<CandidateAliasV1 | null> {
	return parseCandidateAliasV1(await readBoundedJson(join(projectRoot, CONFIG_DIR_NAME, "workbench", "candidates", "aliases", `${alias}.json`)));
}

export async function resolveCurrentCandidateV1(input: {
	project_root: string;
	expected_candidate_identity: string;
	source_run_id: string;
	exec: ExecFn;
	actor_facts?: RecipeMutationFacts;
}): Promise<CandidateResolutionV1> {
	if (!HASH_RE.test(input.expected_candidate_identity) || !isValidRunId(input.source_run_id)) {
		return { ok: false, code: "INVALID_INPUT" };
	}
	const record = await readCommittedManifest(input.project_root, input.source_run_id);
	if (!record) return { ok: false, code: "SOURCE_UNAVAILABLE" };
	const artifactManifest = await readArtifactManifestV2(runDirFor(input.project_root, input.source_run_id), input.source_run_id);
	if (!artifactManifest) return { ok: false, code: "CANDIDATE_INCOMPLETE" };
	const projection = ordinaryCandidateProjectionFromRunV1(record, artifactManifest);
	if (!projection) return { ok: false, code: "CANDIDATE_INCOMPLETE" };
	if (projection.candidateIdentity !== input.expected_candidate_identity) return { ok: false, code: "CANDIDATE_IDENTITY_MISMATCH" };
	const assessment = await assessRunValidation({
		projectRoot: input.project_root,
		mode: "DEV",
		exec: input.exec,
		manifest: record,
		actorFacts: input.actor_facts,
	});
	if (assessment.status !== "REUSABLE") return { ok: false, code: "CANDIDATE_NOT_CURRENT" };
	const candidate: CandidateVersionV1 = {
		schema_version: 1,
		kind: "workbench-candidate-version-v1",
		candidate_identity: projection.candidateIdentity,
		source_run_id: projection.sourceRunId,
		validation_identity: projection.validationIdentity,
		artifact_manifest_identity: projection.artifactManifestIdentity,
		runtime_identity_hash: projection.runtimeIdentityHash,
		source_finished_at: record.finished_at,
		authority_scope: "DEVELOPMENT_ONLY",
	};
	return {
		ok: true,
		candidate,
		version_path: candidateVersionPathV1(candidate.candidate_identity),
		binding: {
			schema_version: 1,
			kind: "workbench-gate-candidate-binding-v1",
			candidate_identity: candidate.candidate_identity,
			candidate_source_run_id: candidate.source_run_id,
			candidate_version_path: candidateVersionPathV1(candidate.candidate_identity),
			validation_identity: candidate.validation_identity,
			artifact_manifest_identity: candidate.artifact_manifest_identity,
			runtime_identity_hash: candidate.runtime_identity_hash,
		},
	};
}

export async function freezeCurrentCandidateV1(input: {
	project_root: string;
	expected_candidate_identity: string;
	source_run_id: string;
	exec: ExecFn;
	actor_facts?: RecipeMutationFacts;
	now: string;
}): Promise<CandidateResolutionV1> {
	if (!finiteIso(input.now)) return { ok: false, code: "INVALID_INPUT" };
	const resolved = await resolveCurrentCandidateV1(input);
	if (!resolved.ok) return resolved;
	const dirs = await ensureStorageDirs(input.project_root);
	if (!dirs || !await writeImmutableVersion(join(dirs.versions, `${resolved.candidate.candidate_identity}.json`), resolved.candidate)) {
		return { ok: false, code: "STORAGE_UNAVAILABLE" };
	}
	if (!await writeCandidateAliasV1({
		project_root: input.project_root,
		alias: "current",
		candidate: resolved.candidate,
		updated_at: input.now,
	})) return { ok: false, code: "STORAGE_UNAVAILABLE" };
	return resolved;
}
