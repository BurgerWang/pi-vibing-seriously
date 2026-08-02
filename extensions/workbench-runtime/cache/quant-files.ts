/**
 * P6-D quant contract file operations — reading, validating and resolving
 * quant manifests on disk, and verifying declared content hashes.
 *
 * Safety rules enforced here (spec §二/§五/§六):
 *   - every manifest / artifact path is project-root restricted
 *     (realpath containment on read; lexical checks for declared paths)
 *   - only small JSON manifests are ever read into memory; data files
 *     (parquet/csv) are NEVER read — at most stream-hashed for content
 *     verification with a bounded size cap
 *   - a logical reference (latest/current/now/today) must resolve to an
 *     immutable manifest; anything unresolved refuses the quant cache
 *   - result artifact hash mismatch = corruption
 */

import { createHash } from "node:crypto";
import { globSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { realpathContained } from "../core/path-guard.ts";
import { sha256HexBytes } from "./canonical-hash.ts";
import {
	computeQuantManifestHash,
	isMutableId,
	parseQuantReferenceKey,
	quantImmutableKey,
	resolveLogicalManifest,
	validateQuantContract,
	type QuantContractDecl,
	type QuantContractRecordInfo,
	type QuantContractType,
	type QuantContractValidation,
} from "./quant-contracts.ts";

/** Refuse to hash files larger than this (keep hit validation bounded). */
export const MAX_HASH_VERIFY_BYTES = 256 * 1024 * 1024;
/** Cap on how many candidate manifests a logical resolution may scan. */
export const MAX_REGISTRY_CANDIDATES = 500;

export interface ManifestFileResult {
	ok: boolean;
	reason?: string;
	value?: Record<string, unknown>;
	validation?: QuantContractValidation;
}

/** Read + parse a manifest file (project-root contained, small JSON only). */
export async function readQuantManifestFile(projectRoot: string, relPath: string): Promise<ManifestFileResult> {
	const absolute = await realpathContained(projectRoot, relPath);
	if (absolute === undefined) {
		return { ok: false, reason: `manifest path escapes the project root: ${relPath}` };
	}
	let raw: string;
	try {
		raw = await readFile(absolute, "utf8");
	} catch {
		return { ok: false, reason: `manifest file not found: ${relPath}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { ok: false, reason: `manifest is not valid JSON: ${(error as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, reason: "manifest root must be a JSON object" };
	}
	return { ok: true, value: parsed as Record<string, unknown> };
}

/** Read + fully validate a manifest file. */
export async function validateQuantManifestFile(
	projectRoot: string,
	relPath: string,
	options: { profile?: string } = {},
): Promise<ManifestFileResult> {
	const loaded = await readQuantManifestFile(projectRoot, relPath);
	if (!loaded.ok || !loaded.value) return loaded;
	const validation = validateQuantContract(loaded.value, options);
	return { ok: validation.valid, value: loaded.value, validation };
}

/**
 * Verify a declared content hash against the on-disk file. Streams the file
 * with a bounded size cap; files larger than MAX_HASH_VERIFY_BYTES are
 * reported as "unverifiable" (never loaded into memory or the model
 * context). Returns:
 *   ok: true  — file exists and its SHA-256 equals the declared hash
 *   ok: false, corrupt: true  — hash mismatch (CORRUPTION)
 *   ok: false, corrupt: false — missing / unverifiable / read error
 */
export async function verifyDeclaredHash(
	projectRoot: string,
	relPath: string,
	expectedHash: string,
): Promise<{ ok: boolean; corrupt: boolean; reason?: string; sizeBytes?: number }> {
	const absolute = await realpathContained(projectRoot, relPath);
	if (absolute === undefined) {
		return { ok: false, corrupt: false, reason: `path escapes the project root: ${relPath}` };
	}
	let size: number;
	try {
		size = (await stat(absolute)).size;
	} catch {
		return { ok: false, corrupt: false, reason: `file not found: ${relPath}` };
	}
	if (size > MAX_HASH_VERIFY_BYTES) {
		return { ok: false, corrupt: false, reason: `file too large to verify (${size} bytes > ${MAX_HASH_VERIFY_BYTES})`, sizeBytes: size };
	}
	if (!/^[0-9a-f]{32,128}$/i.test(expectedHash)) {
		return { ok: false, corrupt: false, reason: `declared hash is not a hex hash: ${JSON.stringify(expectedHash)}` };
	}
	try {
		const content = await readFile(absolute);
		const actual = sha256HexBytes(content);
		if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
			return { ok: false, corrupt: true, reason: `hash mismatch for ${relPath}: declared ${expectedHash.slice(0, 12)}…, actual ${actual.slice(0, 12)}…`, sizeBytes: size };
		}
		return { ok: true, corrupt: false, sizeBytes: size };
	} catch (error) {
		return { ok: false, corrupt: false, reason: `read failed: ${(error as Error).message}` };
	}
}

/**
 * Verify the backtest-result artifact integrity: metricsArtifact's on-disk
 * SHA-256 must equal the declared resultArtifactHash. A mismatch is
 * CORRUPTION (the cached result can never be trusted).
 */
export async function verifyBacktestResultArtifact(projectRoot: string, manifest: Record<string, unknown>): Promise<{ ok: boolean; corrupt: boolean; reason?: string }> {
	const artifact = manifest.metricsArtifact;
	const expected = manifest.resultArtifactHash;
	if (typeof artifact !== "string" || typeof expected !== "string") {
		return { ok: false, corrupt: false, reason: "metricsArtifact / resultArtifactHash must be strings" };
	}
	return verifyDeclaredHash(projectRoot, artifact, expected);
}

// ---------------------------------------------------------------------------
// Logical reference resolution on disk
// ---------------------------------------------------------------------------

/**
 * Discover candidate immutable manifests of a contract type for logical
 * reference resolution. Sources (project-root restricted):
 *   - the same directory as the manifest (excluding the manifest itself)
 *   - <root>/.pi/workbench/quant/registry/**\/*.json
 * Candidates are read, validated and filtered to immutable ones. Bounded
 * by MAX_REGISTRY_CANDIDATES — the registry must stay small (manifests
 * only; data files are never scanned).
 */
export async function discoverCandidateManifests(
	projectRoot: string,
	type: QuantContractType,
	selfPath: string,
	options: { profile?: string } = {},
): Promise<Record<string, unknown>[]> {
	const patterns: string[] = [];
	const absolute = await realpathContained(projectRoot, selfPath);
	if (absolute !== undefined) {
		patterns.push(join(resolve(projectRoot), dirname(selfPath), "*.json"));
	}
	patterns.push(join(resolve(projectRoot), ".pi", "workbench", "quant", "registry", "**", "*.json"));
	patterns.push(join(resolve(projectRoot), "artifacts", "**", "*.json"));

	const seen = new Set<string>();
	const candidates: Record<string, unknown>[] = [];
	const selfAbsolute = absolute;
	for (const pattern of patterns) {
		for (const match of globSync(pattern, { cwd: projectRoot })) {
			if (seen.has(match)) continue;
			seen.add(match);
			const abs = await realpathContained(projectRoot, match);
			if (abs === undefined) continue;
			if (selfAbsolute !== undefined && resolve(abs) === resolve(selfAbsolute)) continue; // never resolve to itself
			const loaded = await readQuantManifestFile(projectRoot, match);
			if (!loaded.ok || !loaded.value) continue;
			if (loaded.value.contractType !== type) continue;
			if (loaded.value.schemaVersion !== 1) continue;
			if (isMutableId(loaded.value.snapshotId ?? loaded.value.featureSetId ?? loaded.value.backtestId)) continue;
			const validation = validateQuantContract(loaded.value, options);
			if (!validation.cacheEligible) continue;
			candidates.push(loaded.value);
			if (candidates.length >= MAX_REGISTRY_CANDIDATES) return candidates;
		}
	}
	return candidates;
}

export interface ResolvedQuantContract {
	manifest: Record<string, unknown>;
	validation: QuantContractValidation;
	immutableKey: string;
	manifestHash: string;
	logicalReference: string | null;
	resolvedReference: string | null;
}

/**
 * Resolve the quant contract for a recipe cache declaration:
 *   1. read + validate the declared manifest
 *   2. when the manifest is immutable and has no unresolved logical
 *      reference → use it directly
 *   3. when it carries a logical reference (mutable id or
 *      `logicalReference` field) → resolve against the registry; the
 *      resolved immutable manifest is what enters the action key
 *   4. anything unresolvable or not validated REFUSES the quant cache
 *      (returns ok:false) — normal execution continues per project policy
 */
export async function resolveQuantContract(
	projectRoot: string,
	decl: QuantContractDecl,
	options: { profile?: string } = {},
): Promise<{ ok: true; resolved: ResolvedQuantContract } | { ok: false; reason: string }> {
	const loaded = await readQuantManifestFile(projectRoot, decl.manifest);
	if (!loaded.ok || !loaded.value) {
		return { ok: false, reason: `quant contract manifest: ${loaded.reason ?? "unreadable"}` };
	}
	const value = loaded.value;
	const validation = validateQuantContract(value, options);
	const logicalField = typeof value.logicalReference === "string" && value.logicalReference.trim().length > 0 ? value.logicalReference.trim() : null;
	const mutable = isMutableId(value.snapshotId ?? value.featureSetId ?? value.backtestId);

	// Structural validity: the ONLY tolerated "error" on the logical path is
	// the mutable-id error itself (the whole point of resolution). Anything
	// else refuses the quant cache.
	const structuralErrors = validation.errors.filter((e) => !e.includes("mutable reference"));
	if (structuralErrors.length > 0) {
		return { ok: false, reason: `quant contract manifest is schema-invalid: ${structuralErrors.slice(0, 3).join("; ")}` };
	}

	if (!mutable && !logicalField) {
		if (!validation.cacheEligible) {
			return { ok: false, reason: `quant contract is not validated: ${validation.warnings.filter((w) => w.includes("validated") || w.includes("semantics")).slice(0, 3).join("; ") || "semantic requirements unmet"}` };
		}
		const key = quantImmutableKey(value);
		if (!key) return { ok: false, reason: "quant contract manifest has no immutable key" };
		return {
			ok: true,
			resolved: {
				manifest: value,
				validation,
				immutableKey: key,
				manifestHash: computeQuantManifestHash(value),
				logicalReference: null,
				resolvedReference: null,
			},
		};
	}

	// Logical reference path: resolve against the registry.
	const logicalId = mutable ? String(value.snapshotId ?? value.featureSetId ?? value.backtestId) : logicalField ?? "";
	const candidates = await discoverCandidateManifests(projectRoot, validation.contractType, decl.manifest, options);
	const outcome = resolveLogicalManifest(
		{
			id: logicalId,
			kind: validation.contractType,
			provider: typeof value.provider === "string" ? value.provider : undefined,
			dataset: typeof value.dataset === "string" ? value.dataset : undefined,
		},
		candidates,
	);
	if (!outcome.resolved) {
		return { ok: false, reason: `logical reference "${logicalId}" could not be resolved: ${outcome.reason}` };
	}
	const resolvedValidation = validateQuantContract(outcome.result.manifest, options);
	return {
		ok: true,
		resolved: {
			manifest: outcome.result.manifest,
			validation: resolvedValidation,
			immutableKey: outcome.result.resolvedReference,
			manifestHash: outcome.result.manifestHash,
			logicalReference: outcome.result.logicalReference,
			resolvedReference: outcome.result.resolvedReference,
		},
	};
}

/** Quant-contract facts to persist in an action record. */
export function quantContractInfoOf(resolved: ResolvedQuantContract, decl: QuantContractDecl): QuantContractRecordInfo {
	return {
		type: decl.type,
		manifest: decl.manifest,
		immutableKey: resolved.immutableKey,
		manifestHash: resolved.manifestHash,
		validationStatus: resolved.validation.validationStatus,
		logicalReference: resolved.logicalReference,
		resolvedReference: resolved.resolvedReference,
		warnings: [...resolved.validation.warnings],
	};
}

/** Human-readable id of a manifest (for lineage output). */
export function manifestDisplayId(manifest: Record<string, unknown>): string {
	return String(manifest.snapshotId ?? manifest.featureSetId ?? manifest.backtestId ?? "?");
}

export { parseQuantReferenceKey, basename };
