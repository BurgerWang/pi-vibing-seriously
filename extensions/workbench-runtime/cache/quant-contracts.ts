/**
 * P6-D Quant Research Cache Contracts — the three versioned manifest
 * contracts (DATA_SNAPSHOT, FEATURE_SET, BACKTEST_RESULT) plus immutable
 * reference resolution. Pure logic, no Pi imports, no fs.
 *
 * Workbench boundary (docs/cache/quant-cache.md):
 *   - the workbench defines, validates and CONNECTS cache contracts; it
 *     never downloads market data, never computes features, never runs a
 *     backtest engine — those artifacts belong to the target project
 *   - a cache hit never bypasses Q0-Q5: cached runs are full run records
 *     and every gate re-validates them
 *   - mutable references (latest/current/now/today) can never be a final
 *     manifest id or a cache key; logical references must resolve to an
 *     immutable manifest before anything is cached
 *   - "validated" is a strict status: a manifest that parses but misses
 *     adjustment/corporate-action/delisting semantics (or any per-profile
 *     requirement) stays "unresolved" — never "validated"
 *
 * Validation status model:
 *   invalid     — required fields missing / malformed (never cacheable)
 *   unresolved  — parses, but semantic requirements are not met
 *                 (never cacheable, never "validated")
 *   validated   — structure + semantics hold (cacheable when immutable)
 */

import { canonicalHash, sha256Hex } from "./canonical-hash.ts";

export const QUANT_CONTRACT_SCHEMA_VERSION = 1;
export const QUANT_CONTRACT_TYPES = ["data-snapshot", "feature-set", "backtest-result"] as const;
export type QuantContractType = (typeof QUANT_CONTRACT_TYPES)[number];

/** Mutable reference tokens — never a final id, never a cache key. */
export const MUTABLE_ID_TOKENS = ["latest", "current", "now", "today"] as const;
const MUTABLE_ID_RE = new RegExp(`^(?:${MUTABLE_ID_TOKENS.join("|")})(?:[^a-z0-9].*)?$`, "i");

/** SHA-256 hex format for hash fields (warnings, never fatal). */
const HEX_HASH_RE = /^[0-9a-f]{32,128}$/i;

export type QuantValidationStatus = "validated" | "unresolved" | "invalid";

export interface QuantContractValidation {
	contractType: QuantContractType;
	schemaVersion: number;
	valid: boolean;
	validationStatus: QuantValidationStatus;
	/** Required (structural) fields that are missing. */
	missingFields: string[];
	errors: string[];
	/** Manifest `warnings` array preserved verbatim (never filtered). */
	warnings: string[];
	/** Dot paths of fields that were verified. */
	checked: string[];
	/** The manifest's id field is a mutable reference (latest/current/now/today). */
	mutableId: boolean;
	/** The manifest carries a logical reference that is not resolved. */
	unresolvedLogical: boolean;
	cacheEligible: boolean;
	qGateImplications: { gate: string; label: string }[];
}

export interface QuantContractDecl {
	type: QuantContractType;
	/** Project-relative path of the manifest JSON file. */
	manifest: string;
}

/** Quant-contract facts stored in an action record (for lineage/explain). */
export interface QuantContractRecordInfo {
	type: QuantContractType;
	manifest: string;
	/** quant:<type>:<id>:<revision>:<hash16> — the immutable upstream key. */
	immutableKey: string;
	manifestHash: string;
	validationStatus: QuantValidationStatus;
	logicalReference: string | null;
	resolvedReference: string | null;
	/** Manifest warnings preserved verbatim. */
	warnings: string[];
}

// ---------------------------------------------------------------------------
// Field tables (per contract type)
// ---------------------------------------------------------------------------

const DATA_SNAPSHOT_REQUIRED: readonly string[] = [
	"schemaVersion",
	"contractType",
	"snapshotId",
	"provider",
	"dataset",
	"providerDatasetVersion",
	"providerRevision",
	"acquiredAt",
	"effectiveAsOf",
	"symbols",
	"startDate",
	"endDate",
	"frequency",
	"timezone",
	"tradingCalendar",
	"schemaHash",
	"rawDataHash",
	"sourceArtifacts",
	"warnings",
];

/**
 * Semantics whose ABSENCE keeps the manifest parseable but NOT validated
 * (spec rule: missing adjustment/corporate-action/delisting semantics must
 * never yield validation status "validated").
 */
const DATA_SNAPSHOT_SEMANTIC: readonly string[] = ["adjustmentPolicy", "corporateActionVersion", "delistingPolicy"];

const FEATURE_SET_REQUIRED: readonly string[] = [
	"schemaVersion",
	"contractType",
	"featureSetId",
	"profile",
	"dataSnapshotKey",
	"featureCodeHash",
	"featureDefinitionHash",
	"parameters",
	"warmupPeriod",
	"missingValuePolicy",
	"outputSchemaHash",
	"featureArtifactHash",
	"warnings",
];

const FEATURE_SET_SEMANTIC: readonly string[] = ["universeSnapshotKey", "winsorizationPolicy", "normalizationPolicy"];

/** stock-selection feature sets additionally require (spec §三). */
const FEATURE_SET_SEMANTIC_SELECTION: readonly string[] = [
	"universeSnapshotKey", // point-in-time universe
	"industryClassificationVersion",
	"marketCapSourceVersion",
	"financialReleaseAlignmentPolicy",
	"winsorizationPolicy",
	"normalizationPolicy",
];

/** market-timing feature sets additionally require (spec §三). */
const FEATURE_SET_SEMANTIC_TIMING: readonly string[] = [
	"signalTimestampPolicy",
	"barOpenCloseSemantics",
	"resamplingPolicy",
	"timezone",
	"tradingCalendar",
];

const BACKTEST_REQUIRED: readonly string[] = [
	"schemaVersion",
	"contractType",
	"backtestId",
	"strategyType",
	"sourceCodeHash",
	"strategyConfigHash",
	"dataSnapshotKey",
	"featureSetKey",
	"universeSnapshotKey",
	"splitDefinitionHash",
	"seed",
	"engineVersion",
	"tradingCalendar",
	"feeModelHash",
	"slippageModelHash",
	"benchmarkDefinitionHash",
	"rebalanceSemanticsHash",
	"positionConstraintHash",
	"corporateActionPolicyHash",
	"resultArtifactHash",
	"metricsArtifact",
	"parametersArtifact",
	"warnings",
];

/** Fields that must be SHA-256-ish hashes (non-empty; hex format is a warning). */
const HASH_FIELDS: ReadonlySet<string> = new Set([
	"schemaHash",
	"rawDataHash",
	"featureCodeHash",
	"featureDefinitionHash",
	"outputSchemaHash",
	"featureArtifactHash",
	"sourceCodeHash",
	"strategyConfigHash",
	"splitDefinitionHash",
	"walkForwardDefinitionHash",
	"feeModelHash",
	"slippageModelHash",
	"benchmarkDefinitionHash",
	"rebalanceSemanticsHash",
	"positionConstraintHash",
	"corporateActionPolicyHash",
	"resultArtifactHash",
]);

/** Contract type -> Q gate implications (cache hits still re-validate them). */
export function qGateImplicationsFor(type: QuantContractType): { gate: string; label: string }[] {
	switch (type) {
		case "data-snapshot":
			return [{ gate: "q1", label: "Market Data Integrity (schema, point-in-time, timezone/calendar, adjustment, corporate actions, delisting)" }];
		case "feature-set":
			return [
				{ gate: "q1", label: "Market Data Integrity (source data snapshot)" },
				{ gate: "q2", label: "Backtest Semantics (signal timestamp, bar open/close, resampling, normalization)" },
			];
		case "backtest-result":
			return [
				{ gate: "q2", label: "Backtest Semantics (fee/slippage, rebalance, benchmark, result schema)" },
				{ gate: "q3", label: "Experiment Integrity (split, walk-forward, seed, trial lineage)" },
				{ gate: "q4", label: "Out-of-Sample Robustness (fold completeness, failed folds, cost sensitivity)" },
				{ gate: "q5", label: "Strategy Reporting (metrics, benchmark delta, turnover, exposure, warnings)" },
			];
	}
}

// ---------------------------------------------------------------------------
// Mutable reference detection
// ---------------------------------------------------------------------------

/**
 * True when the id is a mutable reference (latest/current/now/today, alone
 * or as a prefix, e.g. "latest" or "latest@2026-08-01"). Such ids can never
 * be a final snapshotId/featureSetId/backtestId and never a cache key.
 */
export function isMutableId(id: unknown): boolean {
	if (typeof id !== "string") return false;
	const trimmed = id.trim();
	if (trimmed.length === 0) return false;
	return MUTABLE_ID_RE.test(trimmed);
}

/** True when a manifest id field is a mutable reference. */
export function mutableIdOf(manifest: Record<string, unknown>): boolean {
	const id = manifest.snapshotId ?? manifest.featureSetId ?? manifest.backtestId;
	return isMutableId(id);
}

// ---------------------------------------------------------------------------
// Manifest content hashing + immutable keys
// ---------------------------------------------------------------------------

/**
 * Canonical content hash of a manifest. Normalizations (documented):
 *   - `symbols` is sorted (spec rule: stable sort) — symbol ORDER never
 *     changes the hash
 *   - `sourceArtifacts` / fold artifact lists are sorted by id
 *   - `logicalReference` / `resolvedReference` are resolution metadata and
 *     are EXCLUDED from the content hash (the resolved manifest is what is
 *     hashed)
 * Everything else (provider revision, acquiredAt, policies, hashes, ...)
 * is content: any change produces a new hash → new immutable key.
 */
export function computeQuantManifestHash(manifest: Record<string, unknown>): string {
	const normalized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(manifest)) {
		if (key === "logicalReference" || key === "resolvedReference") continue;
		if (key === "symbols" && Array.isArray(value)) {
			normalized[key] = [...value].sort();
			continue;
		}
		if (key === "sourceArtifacts" && Array.isArray(value)) {
			normalized[key] = [...value].sort();
			continue;
		}
		if (key === "foldArtifacts" && Array.isArray(value)) {
			normalized[key] = [...value].sort((a, b) => {
				const ai = (a as { id?: unknown })?.id;
				const bi = (b as { id?: unknown })?.id;
				return String(ai ?? "").localeCompare(String(bi ?? ""));
			});
			continue;
		}
		normalized[key] = value;
	}
	return canonicalHash(normalized);
}

/** The id field of a manifest (snapshotId / featureSetId / backtestId). */
export function manifestIdOf(manifest: Record<string, unknown>): string {
	return String(manifest.snapshotId ?? manifest.featureSetId ?? manifest.backtestId ?? "");
}

/** The revision field of a manifest (providerRevision / ""). */
export function manifestRevisionOf(manifest: Record<string, unknown>): string {
	return String(manifest.providerRevision ?? manifest.revision ?? "");
}

/**
 * The immutable quant reference key — the upstream key that enters action
 * keys: quant:<type>:<id>:<revision>:<hash16>. Built from the RESOLVED
 * immutable manifest only; a mutable id is refused (returns null).
 */
export function quantImmutableKey(manifest: Record<string, unknown>): string | null {
	const type = typeof manifest.contractType === "string" ? (manifest.contractType as QuantContractType) : null;
	if (!type || !QUANT_CONTRACT_TYPES.includes(type)) return null;
	const id = manifestIdOf(manifest);
	if (id.length === 0 || isMutableId(id)) return null;
	const revision = manifestRevisionOf(manifest);
	const hash = computeQuantManifestHash(manifest);
	return `quant:${type}:${id}:${revision || "r0"}:${hash.slice(0, 16)}`;
}

export interface ParsedQuantReferenceKey {
	type: QuantContractType;
	id: string;
	revision: string;
	hash16: string;
}

/** Split a quant reference key back into its parts (lineage display). */
export function parseQuantReferenceKey(key: string): ParsedQuantReferenceKey | null {
	const match = /^quant:(data-snapshot|feature-set|backtest-result):(.+):([^:]+):([0-9a-f]{16})$/.exec(key);
	if (!match) return null;
	return { type: match[1] as QuantContractType, id: match[2] ?? "", revision: match[3] ?? "", hash16: match[4] ?? "" };
}

// ---------------------------------------------------------------------------
// Path safety (pure lexical check; realpath containment happens on read)
// ---------------------------------------------------------------------------

/**
 * True when a declared artifact path is project-relative and cannot lexically
 * escape the project root (no absolute forms, no ".." segments). The spec
 * requires source artifact paths to be project-root restricted; the fs-level
 * readers additionally run realpath containment.
 */
export function isSafeRelativePath(path: unknown): boolean {
	if (typeof path !== "string" || path.trim().length === 0) return false;
	const trimmed = path.trim();
	if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) return false;
	if (trimmed.includes("\0")) return false;
	const segments = trimmed.split("/");
	return !segments.some((s) => s === "..");
}

// ---------------------------------------------------------------------------
// Logical reference resolution (pure)
// ---------------------------------------------------------------------------

export interface LogicalManifestReference {
	/** e.g. "latest", or a concrete immutable id. */
	id: string;
	kind?: QuantContractType;
	provider?: string;
	dataset?: string;
}

export interface ResolvedManifest {
	manifest: Record<string, unknown>;
	logicalReference: string;
	/** The immutable reference key of the resolved manifest. */
	resolvedReference: string;
	manifestHash: string;
}

/**
 * Resolve a logical reference against validated immutable candidate
 * manifests. Rules (spec §五):
 *   - a mutable logical id (latest/current/now/today) resolves to the
 *     NEWEST immutable candidate (by acquiredAt, then createdAt, then id)
 *     matching the optional kind/provider/dataset filters
 *   - a concrete immutable id resolves only to an exact id match
 *   - candidates must already be validated + immutable (the caller
 *     validates; this function re-checks mutability and id integrity)
 *   - unresolved → { resolved: false, reason } → the cache is refused
 */
export function resolveLogicalManifest(
	logical: LogicalManifestReference,
	candidates: readonly Record<string, unknown>[],
): { resolved: true; result: ResolvedManifest } | { resolved: false; reason: string } {
	const id = logical.id.trim();
	if (id.length === 0) return { resolved: false, reason: "logical reference id is empty" };

	const eligible = candidates.filter((m) => {
		if (mutableIdOf(m)) return false;
		if (typeof m.contractType !== "string") return false;
		if (logical.kind !== undefined && m.contractType !== logical.kind) return false;
		if (logical.provider !== undefined && m.provider !== logical.provider) return false;
		if (logical.dataset !== undefined && m.dataset !== logical.dataset) return false;
		return true;
	});

	if (isMutableId(id)) {
		if (eligible.length === 0) {
			return { resolved: false, reason: `no immutable ${logical.kind ?? "manifest"} candidates to resolve "${id}" (registry empty or all mutable/invalid)` };
		}
		const sorted = [...eligible].sort((a, b) => {
			const ta = manifestTimestamp(a);
			const tb = manifestTimestamp(b);
			if (ta !== tb) return ta < tb ? 1 : -1; // newest first
			return manifestIdOf(a).localeCompare(manifestIdOf(b));
		});
		const best = sorted[0] as Record<string, unknown>;
		const key = quantImmutableKey(best);
		if (!key) return { resolved: false, reason: `candidate "${manifestIdOf(best)}" is not immutable` };
		return {
			resolved: true,
			result: { manifest: best, logicalReference: id, resolvedReference: key, manifestHash: computeQuantManifestHash(best) },
		};
	}

	const exact = eligible.find((m) => manifestIdOf(m) === id);
	if (!exact) {
		return { resolved: false, reason: `no immutable ${logical.kind ?? "manifest"} with id "${id}"` };
	}
	const key = quantImmutableKey(exact);
	if (!key) return { resolved: false, reason: `candidate "${id}" is not immutable` };
	return {
		resolved: true,
		result: { manifest: exact, logicalReference: id, resolvedReference: key, manifestHash: computeQuantManifestHash(exact) },
	};
}

/** Timestamp used for "newest" resolution (acquiredAt > createdAt > id). */
function manifestTimestamp(manifest: Record<string, unknown>): string {
	const acquired = typeof manifest.acquiredAt === "string" ? manifest.acquiredAt : "";
	if (acquired.length > 0) return acquired;
	const created = typeof manifest.createdAt === "string" ? manifest.createdAt : "";
	if (created.length > 0) return created;
	return manifestIdOf(manifest);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

interface ValidationContext {
	v: QuantContractValidation;
	options: { profile?: string };
	/** Set when a semantic requirement is missing — blocks "validated". */
	semanticUnresolved: boolean;
}

function addError(v: QuantContractValidation, message: string): void {
	v.errors.push(message);
}

function checkString(v: QuantContractValidation, value: unknown, path: string): boolean {
	if (!isNonEmptyString(value)) {
		addError(v, `${path} must be a non-empty string`);
		return false;
	}
	v.checked.push(path);
	return true;
}

function checkRequired(v: QuantContractValidation, manifest: Record<string, unknown>, fields: readonly string[], missing: string[]): void {
	for (const field of fields) {
		if (manifest[field] === undefined) missing.push(field);
		else v.checked.push(field);
	}
}

function checkDateString(v: QuantContractValidation, value: unknown, path: string): boolean {
	if (!checkString(v, value, path)) return false;
	if (Number.isNaN(Date.parse(value as string))) {
		addError(v, `${path} is not a parseable date: ${JSON.stringify(value)}`);
		return false;
	}
	return true;
}

function checkStringArray(v: QuantContractValidation, value: unknown, path: string): boolean {
	if (!Array.isArray(value) || value.length === 0 || value.some((item) => !isNonEmptyString(item))) {
		addError(v, `${path} must be a non-empty array of non-empty strings`);
		return false;
	}
	v.checked.push(path);
	return true;
}

/** Symbol list: non-empty strings; must be stably sorted (spec rule 5). */
function checkSymbols(v: QuantContractValidation, value: unknown, path: string): boolean {
	if (!checkStringArray(v, value, path)) return false;
	const symbols = value as string[];
	const sorted = [...symbols].sort();
	if (symbols.some((s, i) => s !== sorted[i])) {
		v.warnings.push(`${path} is not stably sorted — the workbench hashes symbols in sorted order; sort the manifest list for determinism`);
	}
	const unique = new Set(symbols);
	if (unique.size !== symbols.length) {
		v.warnings.push(`${path} contains duplicate symbols (${symbols.length} entries, ${unique.size} unique)`);
	}
	return true;
}

/** Source artifacts: non-empty strings, project-root restricted. */
function checkSourceArtifacts(v: QuantContractValidation, value: unknown, path: string): boolean {
	if (!Array.isArray(value) || value.length === 0) {
		addError(v, `${path} must be a non-empty array of project-relative paths`);
		return false;
	}
	let ok = true;
	value.forEach((item, index) => {
		if (!isSafeRelativePath(item)) {
			addError(v, `${path}[${index}] must be a project-relative path (no absolute paths, no ".." escapes): ${JSON.stringify(item)}`);
			ok = false;
		}
	});
	if (ok) v.checked.push(path);
	return ok;
}

function checkHashField(v: QuantContractValidation, value: unknown, path: string): boolean {
	if (!isNonEmptyString(value)) {
		addError(v, `${path} must be a non-empty hash string`);
		return false;
	}
	if (!HEX_HASH_RE.test(value as string)) {
		v.warnings.push(`${path} is not a hex hash (expected /^[0-9a-f]{32,128}$/i): ${JSON.stringify(value)} — accepted but flagged`);
	}
	v.checked.push(path);
	return true;
}

/** manifest warnings: array of strings, preserved verbatim. */
function checkWarnings(v: QuantContractValidation, value: unknown): void {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.some((w) => typeof w !== "string")) {
		addError(v, "warnings must be an array of strings");
		return;
	}
	v.warnings.push(...(value as string[]));
	v.checked.push("warnings");
}

function validateDataSnapshot(manifest: Record<string, unknown>, ctx: ValidationContext): void {
	const { v, options } = ctx;
	const missing: string[] = [];
	checkRequired(v, manifest, DATA_SNAPSHOT_REQUIRED, missing);
	checkString(v, manifest.snapshotId, "snapshotId");
	checkString(v, manifest.provider, "provider");
	checkString(v, manifest.dataset, "dataset");
	checkString(v, manifest.providerDatasetVersion, "providerDatasetVersion");
	checkString(v, manifest.providerRevision, "providerRevision");
	checkDateString(v, manifest.acquiredAt, "acquiredAt");
	checkDateString(v, manifest.effectiveAsOf, "effectiveAsOf");
	checkSymbols(v, manifest.symbols, "symbols");
	checkDateString(v, manifest.startDate, "startDate");
	checkDateString(v, manifest.endDate, "endDate");
	checkString(v, manifest.frequency, "frequency");
	checkString(v, manifest.timezone, "timezone");
	checkString(v, manifest.tradingCalendar, "tradingCalendar");
	checkSourceArtifacts(v, manifest.sourceArtifacts, "sourceArtifacts");
	checkWarnings(v, manifest.warnings);
	for (const field of HASH_FIELDS) {
		if (manifest[field] !== undefined) checkHashField(v, manifest[field], field);
	}

	// semantic (unresolved when missing — never validated):
	for (const field of DATA_SNAPSHOT_SEMANTIC) {
		if (manifest[field] === undefined) {
			ctx.semanticUnresolved = true;
			v.warnings.push(`semantics missing: ${field} — the contract parses but its validation status can never be "validated" without ${field}`);
			continue;
		}
		if (field === "adjustmentPolicy" || field === "delistingPolicy") checkString(v, manifest[field], field);
		else checkString(v, manifest[field], field);
	}
	// stock-selection forces a point-in-time universe id (spec rule 7).
	if (options.profile === "quant-research/stock-selection" && manifest.pointInTimeUniverseId === undefined) {
		ctx.semanticUnresolved = true;
		v.warnings.push("stock-selection requires pointInTimeUniverseId — a data snapshot without a point-in-time universe id can never be validated");
	}
	if (manifest.pointInTimeUniverseId !== undefined) {
		if (isMutableId(manifest.pointInTimeUniverseId)) addError(v, "pointInTimeUniverseId must reference an immutable universe, not a mutable id");
		else v.checked.push("pointInTimeUniverseId");
	}
	v.missingFields.push(...missing);
}

function validateFeatureSet(manifest: Record<string, unknown>, ctx: ValidationContext): void {
	const { v, options } = ctx;
	const missing: string[] = [];
	checkRequired(v, manifest, FEATURE_SET_REQUIRED, missing);
	checkString(v, manifest.featureSetId, "featureSetId");
	checkString(v, manifest.profile, "profile");
	checkString(v, manifest.dataSnapshotKey, "dataSnapshotKey");
	checkString(v, manifest.featureCodeHash, "featureCodeHash");
	checkString(v, manifest.featureDefinitionHash, "featureDefinitionHash");
	if (manifest.parameters !== undefined && !isRecord(manifest.parameters)) {
		addError(v, "parameters must be an object");
	} else if (manifest.parameters !== undefined) {
		v.checked.push("parameters");
	}
	if (typeof manifest.warmupPeriod === "number" && Number.isFinite(manifest.warmupPeriod) && manifest.warmupPeriod >= 0) {
		v.checked.push("warmupPeriod");
	} else {
		addError(v, "warmupPeriod must be a non-negative finite number");
	}
	checkString(v, manifest.missingValuePolicy, "missingValuePolicy");
	checkString(v, manifest.outputSchemaHash, "outputSchemaHash");
	checkString(v, manifest.featureArtifactHash, "featureArtifactHash");
	checkWarnings(v, manifest.warnings);
	for (const field of HASH_FIELDS) {
		if (manifest[field] !== undefined) checkHashField(v, manifest[field], field);
	}

	const profile = options.profile ?? (typeof manifest.profile === "string" ? manifest.profile : undefined);
	if (profile === "quant-research/stock-selection") {
		// point-in-time universe, industry classification version, market-cap
		// source version, financial publication-time alignment, cross-sectional
		// normalization, winsorization, missing-value policy (spec §三).
		for (const field of FEATURE_SET_SEMANTIC_SELECTION) {
			if (manifest[field] === undefined) {
				ctx.semanticUnresolved = true;
				v.warnings.push(`stock-selection feature set is missing "${field}" — parses, but can never be validated`);
			} else if (typeof manifest[field] === "object" || typeof manifest[field] === "string") {
				v.checked.push(field);
			}
		}
	} else if (profile === "quant-research/market-timing") {
		// signal timestamp policy, bar open/close semantics, resampling
		// policy, warmup period, timezone/calendar, source snapshot (spec §三).
		for (const field of FEATURE_SET_SEMANTIC_TIMING) {
			if (manifest[field] === undefined) {
				ctx.semanticUnresolved = true;
				v.warnings.push(`market-timing feature set is missing "${field}" — parses, but can never be validated`);
			} else if (typeof manifest[field] === "string") {
				v.checked.push(field);
			}
		}
	} else {
		// Generic profile: semantic fields validated when present.
		for (const field of [...FEATURE_SET_SEMANTIC, ...FEATURE_SET_SEMANTIC_TIMING]) {
			if (manifest[field] !== undefined) v.checked.push(field);
		}
	}
	v.missingFields.push(...missing);
}

function validateBacktestResult(manifest: Record<string, unknown>, ctx: ValidationContext): void {
	const { v } = ctx;
	const missing: string[] = [];
	checkRequired(v, manifest, BACKTEST_REQUIRED, missing);
	checkString(v, manifest.backtestId, "backtestId");
	checkString(v, manifest.strategyType, "strategyType");
	checkString(v, manifest.sourceCodeHash, "sourceCodeHash");
	checkString(v, manifest.strategyConfigHash, "strategyConfigHash");
	checkString(v, manifest.dataSnapshotKey, "dataSnapshotKey");
	checkString(v, manifest.featureSetKey, "featureSetKey");
	checkString(v, manifest.universeSnapshotKey, "universeSnapshotKey");
	checkString(v, manifest.splitDefinitionHash, "splitDefinitionHash");
	if (typeof manifest.seed !== "number" && typeof manifest.seed !== "string") {
		addError(v, "seed must be a finite number or a string");
	} else {
		v.checked.push("seed");
	}
	checkString(v, manifest.engineVersion, "engineVersion");
	checkString(v, manifest.tradingCalendar, "tradingCalendar");
	checkString(v, manifest.feeModelHash, "feeModelHash");
	checkString(v, manifest.slippageModelHash, "slippageModelHash");
	checkString(v, manifest.benchmarkDefinitionHash, "benchmarkDefinitionHash");
	checkString(v, manifest.rebalanceSemanticsHash, "rebalanceSemanticsHash");
	checkString(v, manifest.positionConstraintHash, "positionConstraintHash");
	checkString(v, manifest.corporateActionPolicyHash, "corporateActionPolicyHash");
	checkString(v, manifest.resultArtifactHash, "resultArtifactHash");
	checkSourceArtifacts(v, [manifest.metricsArtifact, manifest.parametersArtifact].filter((p) => p !== undefined), "metricsArtifact|parametersArtifact");
	if (!isSafeRelativePath(manifest.metricsArtifact)) addError(v, "metricsArtifact must be a project-relative path");
	else v.checked.push("metricsArtifact");
	if (!isSafeRelativePath(manifest.parametersArtifact)) addError(v, "parametersArtifact must be a project-relative path");
	else v.checked.push("parametersArtifact");
	checkWarnings(v, manifest.warnings);
	for (const field of HASH_FIELDS) {
		if (manifest[field] !== undefined) checkHashField(v, manifest[field], field);
	}

	// folds: every fold is recorded — failed folds are never filtered.
	const folds = manifest.foldArtifacts;
	if (folds !== undefined) {
		if (!Array.isArray(folds)) {
			addError(v, "foldArtifacts must be an array");
		} else {
			v.checked.push("foldArtifacts");
			const seen = new Set<string>();
			const foldIds: string[] = [];
			folds.forEach((fold, index) => {
				const path = `foldArtifacts[${index}]`;
				if (typeof fold === "string") {
					if (!isSafeRelativePath(fold)) addError(v, `${path} must be a project-relative path`);
					const id = `fold-${index + 1}`;
					seen.add(id);
					foldIds.push(id);
					return;
				}
				if (!isRecord(fold)) {
					addError(v, `${path} must be an object or a relative path string`);
					return;
				}
				const id: unknown = fold.id;
				if (!isNonEmptyString(id)) {
					addError(v, `${path}.id must be a non-empty string`);
					return;
				}
				if (seen.has(id)) addError(v, `${path}.id "${id}" is duplicated across folds`);
				seen.add(id);
				foldIds.push(id);
				if (fold.artifact !== undefined && !isSafeRelativePath(fold.artifact)) {
					addError(v, `${path}.artifact must be a project-relative path`);
				}
				if (fold.status !== undefined && typeof fold.status !== "string") {
					addError(v, `${path}.status must be a string (passed/failed/skipped/pending)`);
				}
			});
			// failed folds must be retained in foldArtifacts AND reported.
			const failedFolds = manifest.failedFolds;
			if (failedFolds !== undefined) {
				if (!Array.isArray(failedFolds) || failedFolds.some((f: unknown) => !isNonEmptyString(f))) {
					addError(v, "failedFolds must be an array of non-empty strings");
				} else {
					v.checked.push("failedFolds");
					for (const failed of failedFolds as string[]) {
						if (!seen.has(failed)) {
							addError(v, `failed fold "${failed}" is reported in failedFolds but has no foldArtifacts entry — failed folds must never be filtered`);
						}
					}
				}
			}
		}
	}

	// walk-forward declared but foldArtifacts empty → never validated.
	if (manifest.walkForwardDefinitionHash !== undefined) {
		checkHashField(v, manifest.walkForwardDefinitionHash, "walkForwardDefinitionHash");
		if (folds === undefined || !Array.isArray(folds) || folds.length === 0) {
			ctx.semanticUnresolved = true;
			v.warnings.push("walk-forward is declared (walkForwardDefinitionHash) but foldArtifacts is empty — parses, but can never be validated without folds");
		}
	}

	// parameter search must keep trial lineage or its immutable digest.
	if (manifest.parameterSearch === true) {
		const lineage = manifest.trialLineage;
		const retained = isRecord(lineage) && lineage.retained === true;
		const digest = isRecord(lineage) && typeof lineage.digest === "string" && lineage.digest.length > 0;
		if (!retained && !digest) {
			ctx.semanticUnresolved = true;
			v.warnings.push("parameterSearch is declared but trialLineage is missing (need { retained: true } or { digest }) — full trial reporting is required, best-trial-only caching is never valid");
		} else {
			v.checked.push("trialLineage");
		}
	}
	if (manifest.bestTrialOnly === true) {
		ctx.semanticUnresolved = true;
		v.warnings.push('bestTrialOnly: true is declared — caching only the best trial is never valid (full trial reporting required)');
	}
	v.missingFields.push(...missing);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate a parsed quant contract manifest. `value` must already be the
 * result of JSON.parse. The result carries:
 *   - valid / validationStatus ("validated" only when structure AND
 *     semantics hold)
 *   - missingFields, errors, warnings (manifest warnings preserved verbatim)
 *   - mutableId / unresolvedLogical / cacheEligible
 *   - qGateImplications (gates that must still re-validate on a cache hit)
 */
export function validateQuantContract(value: unknown, options: { profile?: string } = {}): QuantContractValidation {
	const v: QuantContractValidation = {
		contractType: "data-snapshot",
		schemaVersion: QUANT_CONTRACT_SCHEMA_VERSION,
		valid: false,
		validationStatus: "invalid",
		missingFields: [],
		errors: [],
		warnings: [],
		checked: [],
		mutableId: false,
		unresolvedLogical: false,
		cacheEligible: false,
		qGateImplications: [],
	};
	if (!isRecord(value)) {
		addError(v, "quant contract manifest root must be a JSON object");
		return v;
	}
	const contractType = value.contractType;
	if (typeof contractType !== "string" || !(QUANT_CONTRACT_TYPES as readonly string[]).includes(contractType)) {
		addError(v, `contractType must be one of ${QUANT_CONTRACT_TYPES.join(", ")}`);
		return v;
	}
	if (value.schemaVersion !== QUANT_CONTRACT_SCHEMA_VERSION) {
		addError(v, `schemaVersion must be ${QUANT_CONTRACT_SCHEMA_VERSION} (got ${JSON.stringify(value.schemaVersion)})`);
		return v;
	}
	v.contractType = contractType as QuantContractType;
	v.schemaVersion = QUANT_CONTRACT_SCHEMA_VERSION;
	v.qGateImplications = qGateImplicationsFor(v.contractType);

	const ctx: ValidationContext = { v, options, semanticUnresolved: false };
	switch (v.contractType) {
		case "data-snapshot":
			validateDataSnapshot(value, ctx);
			break;
		case "feature-set":
			validateFeatureSet(value, ctx);
			break;
		case "backtest-result":
			validateBacktestResult(value, ctx);
			break;
	}

	// immutable/mutable status + logical reference bookkeeping.
	v.mutableId = mutableIdOf(value);
	if (v.mutableId) {
		addError(v, `${v.contractType === "data-snapshot" ? "snapshotId" : v.contractType === "feature-set" ? "featureSetId" : "backtestId"} is a mutable reference (${MUTABLE_ID_TOKENS.join("/")}) — it can never be a final id or a cache key; resolve it to an immutable revision first`);
	}
	if (typeof value.logicalReference === "string" && value.logicalReference.trim().length > 0) {
		v.checked.push("logicalReference");
		if (typeof value.resolvedReference !== "string" || value.resolvedReference.trim().length === 0) {
			v.unresolvedLogical = true;
			ctx.semanticUnresolved = true;
			v.warnings.push(`logicalReference "${value.logicalReference}" is not resolved (no resolvedReference) — not cacheable until resolved to an immutable manifest`);
		}
	}
	if (typeof value.resolvedReference === "string" && value.resolvedReference.trim().length > 0) {
		v.checked.push("resolvedReference");
	}

	v.valid = v.errors.length === 0;
	v.validationStatus = v.valid ? (ctx.semanticUnresolved ? "unresolved" : "validated") : "invalid";

	// Cache eligibility: structure + semantics + immutable + resolved.
	v.cacheEligible = v.valid && v.validationStatus === "validated" && !v.mutableId && !v.unresolvedLogical;

	return v;
}

/**
 * A short human label for the id field of a contract type.
 * (used by commands/docs)
 */
export function idFieldOf(type: QuantContractType): string {
	switch (type) {
		case "data-snapshot":
			return "snapshotId";
		case "feature-set":
			return "featureSetId";
		case "backtest-result":
			return "backtestId";
	}
}

/** Parse the recipe `cache.quantContract:` declaration. */
export function parseQuantContractDecl(raw: unknown): { decl: QuantContractDecl | null; issues: string[] } {
	const issues: string[] = [];
	if (raw === undefined || raw === null) return { decl: null, issues };
	if (!isRecord(raw)) {
		return { decl: null, issues: ['"cache.quantContract" must be a mapping { type, manifest }'] };
	}
	const type = raw.type;
	if (typeof type !== "string" || !(QUANT_CONTRACT_TYPES as readonly string[]).includes(type)) {
		issues.push(`"cache.quantContract.type" must be one of ${QUANT_CONTRACT_TYPES.join(", ")}`);
		return { decl: null, issues };
	}
	const manifest = raw.manifest;
	if (typeof manifest !== "string" || manifest.trim().length === 0) {
		issues.push('"cache.quantContract.manifest" must be a non-empty project-relative path');
		return { decl: null, issues };
	}
	if (!isSafeRelativePath(manifest)) {
		issues.push('"cache.quantContract.manifest" must be a project-relative path (no absolute paths, no ".." escapes)');
		return { decl: null, issues };
	}
	return { decl: { type: type as QuantContractType, manifest: manifest.trim() }, issues };
}

/** Sanity helper: sha256 of a string (re-export for command output). */
export { sha256Hex };
