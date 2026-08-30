/** Strict recipe artifact contracts and current/snapshot validation. */

import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { globSync } from "node:fs";

import { realpathContained } from "./path-guard.ts";
import type { ExecFn } from "./config.ts";

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 2 as const;
export const ARTIFACT_MANIFEST_FILE = "artifact-manifest.json" as const;
export const DEFAULT_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;
export const MAX_ARTIFACT_CONTRACTS = 128 as const;
export const MAX_ARTIFACT_MATCHES = 10_000 as const;

export type ArtifactFreshnessV2 = "current" | "immutable-snapshot";
export type ArtifactRootV2 = "project" | "authorized-external";

export interface RecipeArtifactContract {
	path: string;
	required: boolean;
	min_count: number;
	max_count: number | null;
	type: "file";
	min_bytes: number;
	max_bytes: number;
	sha256: string | null;
	freshness: ArtifactFreshnessV2;
	snapshot: boolean;
	root: ArtifactRootV2;
	external_root: string | null;
	/** String globs from v1 remain runnable but never become formal artifact authority. */
	legacy_optional: boolean;
}

export interface ArtifactIdentityV2 {
	contract_index: number;
	path: string;
	bytes: number;
	sha256: string;
	freshness: ArtifactFreshnessV2;
	snapshot_path: string | null;
	root: ArtifactRootV2;
	external_root: string | null;
	root_identity: string | null;
}

export interface ArtifactContractResultV2 {
	contract_index: number;
	path: string;
	legacy_optional: boolean;
	matched_count: number;
	status: "VALID" | "INVALID" | "LEGACY_OPTIONAL";
	error_code: ArtifactValidationErrorCode | null;
}

export interface ArtifactManifestV2 {
	schema_version: 2;
	run_id: string;
	status: "VALID" | "INVALID" | "LEGACY_OPTIONAL";
	contracts: ArtifactContractResultV2[];
	artifacts: ArtifactIdentityV2[];
}

export type ArtifactValidationErrorCode =
	| "REQUIRED_ARTIFACT_MISSING"
	| "ARTIFACT_COUNT_INVALID"
	| "ARTIFACT_IDENTITY_FAILED"
	| "EXTERNAL_ROOT_UNAUTHORIZED";

export type ArtifactCollectionResult =
	| { ok: true; manifest: ArtifactManifestV2; artifactPaths: string[] }
	| { ok: false; code: ArtifactValidationErrorCode; manifest: ArtifactManifestV2; artifactPaths: string[] };

const HASH_RE = /^[0-9a-f]{64}$/;
const CONTRACT_KEYS = new Set(["path", "required", "min_count", "max_count", "type", "min_bytes", "max_bytes", "sha256", "freshness", "snapshot", "root", "external_root"]);
const EXTERNAL_ROOT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInt(value: unknown, fallback: number, field: string, label: string, errors: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		errors.push(`${label}: "${field}" must be a non-negative safe integer`);
		return fallback;
	}
	return value;
}

/** Parse both legacy string globs and explicit v2 object contracts. */
export function parseRecipeArtifactContracts(value: unknown, label: string, errors: string[]): RecipeArtifactContract[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		errors.push(`${label}: "artifacts" must be an array`);
		return [];
	}
	if (value.length > MAX_ARTIFACT_CONTRACTS) {
		errors.push(`${label}: "artifacts" exceeds ${MAX_ARTIFACT_CONTRACTS} contracts`);
		return [];
	}
	const contracts: RecipeArtifactContract[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		const itemLabel = `${label}: artifact #${index + 1}`;
		if (typeof item === "string") {
			if (item.length === 0) errors.push(`${itemLabel} must be non-empty`);
			else contracts.push({
				path: item,
				required: false,
				min_count: 0,
				max_count: null,
				type: "file",
				min_bytes: 0,
				max_bytes: DEFAULT_ARTIFACT_MAX_BYTES,
				sha256: null,
				freshness: "current",
				snapshot: false,
				root: "project",
				external_root: null,
				legacy_optional: true,
			});
			continue;
		}
		if (!isRecord(item)) {
			errors.push(`${itemLabel} must be a string glob or object`);
			continue;
		}
		for (const key of Object.keys(item)) if (!CONTRACT_KEYS.has(key)) errors.push(`${itemLabel}: unknown field "${key}"`);
		if (typeof item.path !== "string" || item.path.length === 0) {
			errors.push(`${itemLabel}: "path" must be a non-empty string`);
			continue;
		}
		const required = item.required === undefined ? true : item.required;
		if (typeof required !== "boolean") errors.push(`${itemLabel}: "required" must be boolean`);
		const minCount = safeInt(item.min_count, required === true ? 1 : 0, "min_count", itemLabel, errors);
		let maxCount: number | null = null;
		if (item.max_count !== undefined && item.max_count !== null) maxCount = safeInt(item.max_count, 0, "max_count", itemLabel, errors);
		if (maxCount !== null && maxCount < minCount) errors.push(`${itemLabel}: "max_count" must be >= "min_count"`);
		if (item.type !== undefined && item.type !== "file") errors.push(`${itemLabel}: "type" must be "file"`);
		const minBytes = safeInt(item.min_bytes, 0, "min_bytes", itemLabel, errors);
		const maxBytes = safeInt(item.max_bytes, DEFAULT_ARTIFACT_MAX_BYTES, "max_bytes", itemLabel, errors);
		if (maxBytes < minBytes) errors.push(`${itemLabel}: "max_bytes" must be >= "min_bytes"`);
		const expectedHash = item.sha256 === undefined ? null : item.sha256;
		if (expectedHash !== null && (typeof expectedHash !== "string" || !HASH_RE.test(expectedHash))) errors.push(`${itemLabel}: "sha256" must be 64 lowercase hex characters`);
		const freshness = item.freshness ?? "current";
		if (freshness !== "current" && freshness !== "immutable-snapshot") errors.push(`${itemLabel}: "freshness" must be "current" or "immutable-snapshot"`);
		const snapshot = item.snapshot ?? freshness === "immutable-snapshot";
		if (typeof snapshot !== "boolean") errors.push(`${itemLabel}: "snapshot" must be boolean`);
		if (freshness === "immutable-snapshot" && snapshot !== true) errors.push(`${itemLabel}: immutable-snapshot freshness requires snapshot=true`);
		const root = item.root ?? "project";
		if (root !== "project" && root !== "authorized-external") errors.push(`${itemLabel}: "root" must be "project" or "authorized-external"`);
		const externalRoot = item.external_root ?? null;
		if (root === "authorized-external" && (typeof externalRoot !== "string" || !EXTERNAL_ROOT_RE.test(externalRoot))) errors.push(`${itemLabel}: authorized-external root requires a valid "external_root" name`);
		if (root !== "authorized-external" && externalRoot !== null) errors.push(`${itemLabel}: "external_root" is only valid with root=authorized-external`);
		contracts.push({
			path: item.path,
			required: required === true,
			min_count: minCount,
			max_count: maxCount,
			type: "file",
			min_bytes: minBytes,
			max_bytes: maxBytes,
			sha256: typeof expectedHash === "string" ? expectedHash : null,
			freshness: freshness === "immutable-snapshot" ? "immutable-snapshot" : "current",
			snapshot: snapshot === true,
			root: root === "authorized-external" ? "authorized-external" : "project",
			external_root: typeof externalRoot === "string" ? externalRoot : null,
			legacy_optional: false,
		});
	}
	return contracts;
}

async function hashFile(path: string, maxBytes: number): Promise<{ bytes: number; sha256: string } | null> {
	let handle;
	try {
		handle = await open(path, "r");
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || before.size > BigInt(maxBytes)) return null;
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let bytes = 0;
		for (;;) {
			const read = await handle.read(buffer, 0, buffer.length, null);
			if (read.bytesRead === 0) break;
			bytes += read.bytesRead;
			if (bytes > maxBytes) return null;
			hash.update(buffer.subarray(0, read.bytesRead));
		}
		const after = await handle.stat({ bigint: true });
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || BigInt(bytes) !== after.size) return null;
		return { bytes, sha256: hash.digest("hex") };
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
}

function byteSort(values: string[]): string[] {
	return values.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

const EXTERNAL_ARTIFACT_PROBE_SOURCE = String.raw`
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
(async () => {
  const path = process.argv[1];
  const expectedHash = process.argv[2];
  const expectedBytes = Number(process.argv[3]);
  const handle = await fs.open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expectedBytes)) process.exit(20);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(65536);
    let bytes = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) process.exit(21);
    if (bytes !== expectedBytes || hash.digest("hex") !== expectedHash) process.exit(22);
    // The probe is an authority boundary: emit its fixed acknowledgement
    // synchronously so a fast child-process exit cannot drop buffered stdout.
    require("node:fs").writeSync(1, "OK");
  } finally { await handle.close(); }
})().catch(() => process.exit(23));`;

async function probeExternalArtifact(exec: ExecFn, cwd: string, absolute: string, identity: { bytes: number; sha256: string }): Promise<boolean> {
	try {
		const result = await exec(process.execPath, ["-e", EXTERNAL_ARTIFACT_PROBE_SOURCE, absolute, identity.sha256, String(identity.bytes)], { cwd });
		return result.code === 0 && !result.killed && result.stdout === "OK";
	} catch {
		return false;
	}
}

export async function collectRecipeArtifactsV2(input: {
	projectRoot: string;
	runId: string;
	stagingRunDir: string;
	contracts: readonly RecipeArtifactContract[];
	authorizedExternalRoots?: Readonly<Record<string, string>>;
	exec?: ExecFn;
}): Promise<ArtifactCollectionResult> {
	const artifacts: ArtifactIdentityV2[] = [];
	const results: ArtifactContractResultV2[] = [];
	let firstError: ArtifactValidationErrorCode | null = null;
	for (let index = 0; index < input.contracts.length; index += 1) {
		const contract = input.contracts[index]!;
		const baseRoot = contract.root === "project" ? input.projectRoot : contract.external_root ? input.authorizedExternalRoots?.[contract.external_root] : undefined;
		if (!baseRoot || (contract.root === "authorized-external" && !input.exec)) {
			firstError ??= "EXTERNAL_ROOT_UNAUTHORIZED";
			results.push({ contract_index: index, path: contract.path, legacy_optional: contract.legacy_optional, matched_count: 0, status: "INVALID", error_code: "EXTERNAL_ROOT_UNAUTHORIZED" });
			continue;
		}
		const rawMatches = byteSort([...new Set(globSync(contract.path, { cwd: baseRoot }))]);
		if (rawMatches.length > MAX_ARTIFACT_MATCHES) {
			firstError ??= "ARTIFACT_COUNT_INVALID";
			results.push({ contract_index: index, path: contract.path, legacy_optional: contract.legacy_optional, matched_count: rawMatches.length, status: "INVALID", error_code: "ARTIFACT_COUNT_INVALID" });
			continue;
		}
		const accepted: ArtifactIdentityV2[] = [];
		let identityFailed = false;
		for (const rel of rawMatches) {
			const absolute = join(baseRoot, rel);
			try {
				const info = await lstat(absolute);
				// Glob implementations commonly return the directory prefix for
				// patterns such as `results/**`; type=file means directories are
				// non-matches, not identity failures. Symlinks/special files fail.
				if (info.isDirectory() && !info.isSymbolicLink()) continue;
				if (!info.isFile() || info.isSymbolicLink()) { identityFailed = true; break; }
				const contained = await realpathContained(baseRoot, rel);
				if (!contained || (await realpath(absolute)) !== contained) { identityFailed = true; break; }
				const identity = await hashFile(absolute, contract.max_bytes);
				if (!identity || identity.bytes < contract.min_bytes || identity.bytes > contract.max_bytes || (contract.sha256 !== null && identity.sha256 !== contract.sha256)) {
					identityFailed = true;
					break;
				}
				if (contract.root === "authorized-external" && !(await probeExternalArtifact(input.exec!, baseRoot, absolute, identity))) {
					identityFailed = true;
					break;
				}
				let snapshotPath: string | null = null;
				const legacyJsonSnapshot = contract.legacy_optional && rel.endsWith(".json") && identity.bytes <= 1024 * 1024;
				if (contract.snapshot || legacyJsonSnapshot) {
					snapshotPath = legacyJsonSnapshot ? `artifacts/${basename(rel)}` : `artifact-snapshots/${identity.sha256}`;
					const target = join(input.stagingRunDir, snapshotPath);
					await mkdir(dirname(target), { recursive: true });
					try {
						await lstat(target);
					} catch {
						await copyFile(absolute, target);
					}
					const snapshotIdentity = await hashFile(target, contract.max_bytes);
					if (!snapshotIdentity || snapshotIdentity.bytes !== identity.bytes || snapshotIdentity.sha256 !== identity.sha256) { identityFailed = true; break; }
				}
				accepted.push({
					contract_index: index,
					path: rel.split(sep).join("/"),
					bytes: identity.bytes,
					sha256: identity.sha256,
					freshness: contract.freshness,
					snapshot_path: snapshotPath,
					root: contract.root,
					external_root: contract.external_root,
					root_identity: contract.root === "authorized-external" ? createHash("sha256").update(baseRoot).digest("hex") : null,
				});
			} catch {
				identityFailed = true;
				break;
			}
		}
		let error: ArtifactValidationErrorCode | null = null;
		if (identityFailed) error = "ARTIFACT_IDENTITY_FAILED";
		else if (accepted.length < contract.min_count) error = contract.required && accepted.length === 0 ? "REQUIRED_ARTIFACT_MISSING" : "ARTIFACT_COUNT_INVALID";
		else if (contract.max_count !== null && accepted.length > contract.max_count) error = "ARTIFACT_COUNT_INVALID";
		if (error) firstError ??= error;
		artifacts.push(...accepted);
		results.push({
			contract_index: index,
			path: contract.path,
			legacy_optional: contract.legacy_optional,
			matched_count: accepted.length,
			status: error ? "INVALID" : contract.legacy_optional ? "LEGACY_OPTIONAL" : "VALID",
			error_code: error,
		});
	}
	const hasFormal = results.some((result) => !result.legacy_optional);
	const manifest: ArtifactManifestV2 = {
		schema_version: 2,
		run_id: input.runId,
		status: firstError ? "INVALID" : hasFormal ? "VALID" : "LEGACY_OPTIONAL",
		contracts: results,
		artifacts,
	};
	const artifactPaths = byteSort([...new Set(artifacts.map((artifact) => artifact.root === "project" ? artifact.path : `external:${artifact.external_root}/${artifact.path}`))]);
	return firstError ? { ok: false, code: firstError, manifest, artifactPaths } : { ok: true, manifest, artifactPaths };
}

export async function writeArtifactManifestV2(runDir: string, manifest: ArtifactManifestV2): Promise<void> {
	await writeFile(join(runDir, ARTIFACT_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function parseArtifactManifest(value: unknown, runId: string): ArtifactManifestV2 | null {
	if (!isRecord(value) || value.schema_version !== 2 || value.run_id !== runId) return null;
	if (value.status !== "VALID" && value.status !== "INVALID" && value.status !== "LEGACY_OPTIONAL") return null;
	if (!Array.isArray(value.contracts) || !Array.isArray(value.artifacts)) return null;
	// The producer's full strictness is backed by the committed file hash. The
	// consumer still validates every field it uses before granting authority.
	const artifacts: ArtifactIdentityV2[] = [];
	for (const item of value.artifacts) {
		if (!isRecord(item) || typeof item.contract_index !== "number" || !Number.isSafeInteger(item.contract_index) || item.contract_index < 0) return null;
		if (typeof item.path !== "string" || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0) return null;
		if (typeof item.sha256 !== "string" || !HASH_RE.test(item.sha256)) return null;
		if (item.freshness !== "current" && item.freshness !== "immutable-snapshot") return null;
		if (item.snapshot_path !== null && typeof item.snapshot_path !== "string") return null;
		if (item.root !== "project" && item.root !== "authorized-external") return null;
		if (item.root === "authorized-external" && (typeof item.external_root !== "string" || !EXTERNAL_ROOT_RE.test(item.external_root))) return null;
		if (item.root === "project" && item.external_root !== null) return null;
		if (item.root === "authorized-external" && (typeof item.root_identity !== "string" || !HASH_RE.test(item.root_identity))) return null;
		if (item.root === "project" && item.root_identity !== null) return null;
		artifacts.push(item as unknown as ArtifactIdentityV2);
	}
	return value as unknown as ArtifactManifestV2;
}

export async function readArtifactManifestV2(runDir: string, runId: string): Promise<ArtifactManifestV2 | null> {
	try {
		const raw = await readFile(join(runDir, ARTIFACT_MANIFEST_FILE), "utf8");
		return parseArtifactManifest(JSON.parse(raw), runId);
	} catch {
		return null;
	}
}

export type CurrentArtifactValidationResult =
	| { ok: true; manifest: ArtifactManifestV2 }
	| { ok: false; code: "LEGACY_OPTIONAL" | "ARTIFACT_MANIFEST_INVALID" | "ARTIFACT_IDENTITY_FAILED" };

/** Revalidate current files and immutable snapshots at the point of use. */
export async function validateCommittedArtifactsV2(
	projectRoot: string,
	runDir: string,
	runId: string,
	options: { authorizedExternalRoots?: Readonly<Record<string, string>>; exec?: ExecFn } = {},
): Promise<CurrentArtifactValidationResult> {
	const manifest = await readArtifactManifestV2(runDir, runId);
	if (!manifest) return { ok: false, code: "ARTIFACT_MANIFEST_INVALID" };
	if (manifest.status !== "VALID") return { ok: false, code: manifest.status === "LEGACY_OPTIONAL" ? "LEGACY_OPTIONAL" : "ARTIFACT_IDENTITY_FAILED" };
	for (const artifact of manifest.artifacts) {
		const currentRoot = artifact.root === "project" ? projectRoot : artifact.external_root ? options.authorizedExternalRoots?.[artifact.external_root] : undefined;
		if (artifact.root === "authorized-external" && (!currentRoot || createHash("sha256").update(currentRoot).digest("hex") !== artifact.root_identity)) return { ok: false, code: "ARTIFACT_IDENTITY_FAILED" };
		const source = artifact.freshness === "immutable-snapshot"
			? artifact.snapshot_path && join(runDir, artifact.snapshot_path)
			: currentRoot && join(currentRoot, artifact.path);
		if (!source) return { ok: false, code: "ARTIFACT_IDENTITY_FAILED" };
		if (artifact.freshness === "current" && (!currentRoot || !(await realpathContained(currentRoot, artifact.path)))) return { ok: false, code: "ARTIFACT_IDENTITY_FAILED" };
		if (artifact.freshness === "current") {
			try {
				const sourceStats = await lstat(source);
				if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) return { ok: false, code: "ARTIFACT_IDENTITY_FAILED" };
			} catch {
				return { ok: false, code: "ARTIFACT_IDENTITY_FAILED" };
			}
		}
		const current = await hashFile(source, Math.max(artifact.bytes, 1));
		if (!current || current.bytes !== artifact.bytes || current.sha256 !== artifact.sha256) return { ok: false, code: "ARTIFACT_IDENTITY_FAILED" };
		if (artifact.freshness === "current" && artifact.root === "authorized-external") {
			if (!currentRoot || !options.exec || !(await probeExternalArtifact(options.exec, currentRoot, source, current))) return { ok: false, code: "ARTIFACT_IDENTITY_FAILED" };
		}
	}
	return { ok: true, manifest };
}

export function artifactPatterns(contracts: readonly RecipeArtifactContract[]): string[] {
	return contracts.map((contract) => contract.path);
}
