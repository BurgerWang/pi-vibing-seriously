/**
 * P6-D /q-cache-validate — validate one quant cache contract manifest.
 *
 * Reads ONLY the small JSON manifest (never data files); for
 * backtest-result manifests the declared resultArtifactHash is verified
 * against the on-disk artifact (bounded streaming hash).
 *
 * Output (spec §八): contract type, schema version, immutable/mutable
 * status, content hash, upstream keys, missing fields, validation warnings,
 * cache eligibility, Q Gate implications.
 */

import { quantImmutableKey, computeQuantManifestHash, validateQuantContract, type QuantContractType, type QuantValidationStatus } from "./quant-contracts.ts";
import { readQuantManifestFile, resolveQuantContract, verifyBacktestResultArtifact, type ResolvedQuantContract } from "./quant-files.ts";

export interface QuantCacheValidateReport {
	ok: boolean;
	error?: string;
	path: string;
	contractType: QuantContractType | null;
	schemaVersion: number | null;
	immutable: boolean;
	mutableId: boolean;
	contentHash: string | null;
	upstreamKey: string | null;
	logicalReference: string | null;
	resolvedReference: string | null;
	missingFields: string[];
	errors: string[];
	warnings: string[];
	validationStatus: QuantValidationStatus | null;
	cacheEligible: boolean;
	qGateImplications: { gate: string; label: string }[];
	/** Result artifact hash verification (backtest-result only). */
	resultArtifact: { path: string | null; verified: boolean; corrupt: boolean; reason?: string } | null;
	/** Logical resolution attempt (only when the manifest is mutable/unresolved). */
	resolution: { attempted: boolean; ok: boolean; reason?: string; resolved?: ResolvedQuantContract } | null;
}

export async function validateQuantManifestCommand(projectRoot: string, manifestPath: string): Promise<QuantCacheValidateReport> {
	const report: QuantCacheValidateReport = {
		ok: false,
		path: manifestPath,
		contractType: null,
		schemaVersion: null,
		immutable: false,
		mutableId: false,
		contentHash: null,
		upstreamKey: null,
		logicalReference: null,
		resolvedReference: null,
		missingFields: [],
		errors: [],
		warnings: [],
		validationStatus: null,
		cacheEligible: false,
		qGateImplications: [],
		resultArtifact: null,
		resolution: null,
	};

	const loaded = await readQuantManifestFile(projectRoot, manifestPath);
	if (!loaded.ok || !loaded.value) {
		report.error = loaded.reason ?? "unreadable manifest";
		return report;
	}
	const manifest = loaded.value;
	const validation = validateQuantContract(manifest);
	report.ok = true;
	report.contractType = validation.contractType;
	report.schemaVersion = validation.schemaVersion;
	report.mutableId = validation.mutableId;
	report.immutable = !validation.mutableId;
	report.contentHash = computeQuantManifestHash(manifest);
	report.upstreamKey = quantImmutableKey(manifest);
	report.logicalReference = typeof manifest.logicalReference === "string" ? manifest.logicalReference : null;
	report.resolvedReference = typeof manifest.resolvedReference === "string" ? manifest.resolvedReference : null;
	report.missingFields = validation.missingFields;
	report.errors = validation.errors;
	report.warnings = validation.warnings;
	report.validationStatus = validation.validationStatus;
	report.cacheEligible = validation.cacheEligible;
	report.qGateImplications = validation.qGateImplications;

	if (validation.contractType === "backtest-result") {
		const verified = await verifyBacktestResultArtifact(projectRoot, manifest);
		report.resultArtifact = {
			path: typeof manifest.metricsArtifact === "string" ? manifest.metricsArtifact : null,
			verified: verified.ok,
			corrupt: verified.corrupt,
			reason: verified.reason,
		};
	}

	// Logical resolution attempt: the manifest is mutable or carries an
	// unresolved logical reference → try to resolve it against the registry.
	if (validation.mutableId || (report.logicalReference !== null && report.resolvedReference === null)) {
		const resolved = await resolveQuantContract(projectRoot, {
			type: validation.contractType,
			manifest: manifestPath,
		});
		if (resolved.ok) {
			report.resolution = { attempted: true, ok: true, resolved: resolved.resolved };
		} else {
			report.resolution = { attempted: true, ok: false, reason: resolved.reason };
		}
	}
	return report;
}

export function renderQuantCacheValidate(report: QuantCacheValidateReport): string[] {
	if (!report.ok) {
		return [`/q-cache-validate: ${report.error ?? "invalid manifest"}`, `manifest      : ${report.path}`];
	}
	const lines = [
		`contract type      : ${report.contractType ?? "?"}`,
		`schema version     : ${report.schemaVersion ?? "?"}`,
		`manifest path      : ${report.path}`,
		`immutable/mutable  : ${report.mutableId ? "MUTABLE (not cacheable as-is)" : "immutable"}`,
		`content hash       : sha256:${report.contentHash ?? "?"}`,
		`upstream key       : ${report.upstreamKey ?? "(none — mutable id cannot key)"}`,
		`logical reference  : ${report.logicalReference ?? "(none)"}`,
		`resolved reference : ${report.resolvedReference ?? "(none)"}`,
		`missing fields     : ${report.missingFields.length > 0 ? report.missingFields.join(", ") : "(none)"}`,
		`validation status  : ${report.validationStatus ?? "?"}`,
		`cache eligibility  : ${report.cacheEligible ? "ELIGIBLE" : "NOT ELIGIBLE"}`,
		`Q gate implications: ${report.qGateImplications.length > 0 ? report.qGateImplications.map((g) => `${g.gate} (${g.label})`).join("; ") : "(none)"}`,
	];
	if (report.resultArtifact) {
		const ra = report.resultArtifact;
		const status = ra.corrupt ? `CORRUPT — ${ra.reason ?? "hash mismatch"}` : ra.verified ? "verified (SHA-256 matches resultArtifactHash)" : `unverifiable — ${ra.reason ?? "?"}`;
		lines.push(`result artifact    : ${ra.path ?? "?"} — ${status}`);
	}
	if (report.resolution) {
		const r = report.resolution;
		if (r.ok && r.resolved) {
			lines.push(
				`resolution         : OK — resolved "${report.logicalReference ?? report.path}" -> ${r.resolved.resolvedReference}`,
				`resolved content   : sha256:${r.resolved.manifestHash}`,
				`resolved status    : ${r.resolved.validation.validationStatus}${r.resolved.validation.cacheEligible ? " (cache-eligible)" : ""}`,
			);
		} else {
			lines.push(`resolution         : FAILED — ${r.reason ?? "unresolved"} (no quant cache read or written; normal execution per project policy)`);
		}
	}
	if (report.errors.length > 0) {
		lines.push("", "errors:", ...report.errors.map((e) => `  - ${e}`));
	}
	if (report.warnings.length > 0) {
		lines.push("", "warnings (manifest warnings preserved verbatim):", ...report.warnings.map((w) => `  - ${w}`));
	}
	return lines;
}
