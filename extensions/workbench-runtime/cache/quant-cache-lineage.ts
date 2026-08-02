/**
 * P6-D /q-cache-lineage — trace the quant cache lineage of a run or action
 * key: data snapshot -> feature set -> backtest result, upstream
 * relationships, action keys, artifact hashes, reused runs and the
 * invalidation reason.
 *
 * Reads ONLY run records, action records and small JSON manifests — data
 * files are never read into memory or the model context. Artifact hash
 * verification is a bounded streaming SHA-256 of the declared result
 * artifact (backtest-result only).
 */

import { isValidRunId, readManifest, type RunRecord } from "../core/runs.ts";
import { ActionCacheStore } from "./action-store.ts";
import {
	quantImmutableKey,
	validateQuantContract,
	type QuantContractType,
	type QuantValidationStatus,
} from "./quant-contracts.ts";
import { readQuantManifestFile, verifyBacktestResultArtifact } from "./quant-files.ts";

export interface LineageContractNode {
	type: QuantContractType;
	manifestPath: string;
	id: string;
	revision: string;
	hash16: string;
	immutableKey: string;
	validationStatus: QuantValidationStatus;
	/** backtest-result only: verified/corrupt/unverifiable. */
	resultArtifact: { verified: boolean; corrupt: boolean; reason?: string } | null;
}

export interface QuantLineageReport {
	ok: boolean;
	error?: string;
	target: string;
	kind: "run" | "action-key" | "unknown";
	runId?: string;
	recipe?: string;
	executionSource?: string;
	reusedFromRunId?: string | null;
	actionKey?: string;
	quantContracts: LineageContractNode[];
	upstreamRelationships: string[];
	artifactHashes: { path: string; kind: string; status: string }[];
	reusedRuns: string[];
	invalidationReason: string | null;
}

const ACTION_KEY_RE = /^[0-9a-f]{64}$/;

/** Read a run record; null when the run does not exist or is not readable. */
async function loadRun(projectRoot: string, runId: string): Promise<RunRecord | null> {
	try {
		return await readManifest(projectRoot, runId);
	} catch {
		return null;
	}
}

/** Scan the run's declared artifacts for quant manifests (small JSON only). */
async function collectContracts(projectRoot: string, artifactPaths: readonly string[], profile?: string): Promise<LineageContractNode[]> {
	const nodes: LineageContractNode[] = [];
	for (const rel of artifactPaths) {
		if (!rel.endsWith(".json")) continue; // never touch parquet/csv
		const loaded = await readQuantManifestFile(projectRoot, rel);
		if (!loaded.ok || !loaded.value) continue;
		const validation = validateQuantContract(loaded.value, { profile });
		if (typeof loaded.value.contractType !== "string") continue;
		const manifest = loaded.value;
		const type = validation.contractType;
		const id = String(manifest.snapshotId ?? manifest.featureSetId ?? manifest.backtestId ?? "?");
		const revision = String(manifest.providerRevision ?? manifest.revision ?? "r0");
		const immutableKey = quantImmutableKey(manifest) ?? `quant:${type}:${id}:${revision}:unresolved`;
		const hash16 = immutableKey.split(":").pop() ?? "";
		let resultArtifact: LineageContractNode["resultArtifact"] = null;
		if (type === "backtest-result") {
			const verified = await verifyBacktestResultArtifact(projectRoot, manifest);
			resultArtifact = { verified: verified.ok, corrupt: verified.corrupt, reason: verified.reason };
		}
		nodes.push({
			type,
			manifestPath: rel,
			id,
			revision,
			hash16,
			immutableKey,
			validationStatus: validation.validationStatus,
			resultArtifact,
		});
	}
	return nodes;
}

/** Link contracts: backtest-result keys -> snapshot/feature nodes. */
function linkRelationships(nodes: readonly LineageContractNode[], manifests: Record<string, Record<string, unknown>>): string[] {
	const rels: string[] = [];
	const byKey = new Map<string, LineageContractNode>();
	for (const node of nodes) byKey.set(node.immutableKey, node);
	for (const node of nodes) {
		const manifest = manifests[node.manifestPath];
		if (!manifest) continue;
		if (node.type === "feature-set") {
			const snap = manifest.dataSnapshotKey;
			if (typeof snap === "string") rels.push(`feature-set ${node.id} -> data-snapshot key ${snap}`);
		}
		if (node.type === "backtest-result") {
			for (const field of ["dataSnapshotKey", "featureSetKey", "universeSnapshotKey"] as const) {
				const value = manifest[field];
				if (typeof value === "string") rels.push(`backtest-result ${node.id} -> ${field} ${value}`);
			}
		}
	}
	return rels;
}

export async function buildQuantLineage(projectRoot: string, target: string): Promise<QuantLineageReport> {
	const report: QuantLineageReport = {
		ok: false,
		target,
		kind: "unknown",
		quantContracts: [],
		upstreamRelationships: [],
		artifactHashes: [],
		reusedRuns: [],
		invalidationReason: null,
	};

	// ---- action-key target ------------------------------------------------
	if (ACTION_KEY_RE.test(target)) {
		report.kind = "action-key";
		report.actionKey = target;
		const store = new ActionCacheStore(projectRoot);
		const { record } = await store.readRecord(target);
		if (!record) {
			report.invalidationReason = "no action record for this key — never written, pruned, cleared, expired, or the key changed (recompute the key by running the recipe)";
			report.ok = true;
			return report;
		}
		report.ok = true;
		report.recipe = record.recipe;
		report.runId = record.sourceRunId;
		report.executionSource = "exec (source run of the action record)";
		report.invalidationReason = null; // record exists for this key
		const run = await loadRun(projectRoot, record.sourceRunId);
		if (run) {
			report.quantContracts = await collectContracts(projectRoot, run.artifact_paths, run.profile ?? undefined);
		}
		if (record.quantContractInfo) {
			report.invalidationReason = report.invalidationReason ?? "record matches the immutable quant contract key";
		}
		return report;
	}

	// ---- run-id target ----------------------------------------------------
	if (isValidRunId(target)) {
		report.kind = "run";
		report.runId = target;
		const run = await loadRun(projectRoot, target);
		if (!run) {
			report.error = `run ${target} not found`;
			return report;
		}
		report.ok = true;
		report.recipe = run.recipe;
		report.executionSource = run.execution_source ?? "exec";
		report.reusedFromRunId = run.reused_from_run_id ?? null;
		report.actionKey = run.action_key;

		report.quantContracts = await collectContracts(projectRoot, run.artifact_paths, run.profile ?? undefined);

		// P6-D: cached runs carry the quant contract facts directly on the
		// manifest — lineage works even after the action record is pruned.
		if (run.quant_contract) {
			const qc = run.quant_contract;
			const type = (["data-snapshot", "feature-set", "backtest-result"] as const).includes(qc.type as QuantContractType)
				? (qc.type as QuantContractType)
				: "data-snapshot";
			const parts = qc.immutable_key.split(":");
			const existing = report.quantContracts.some((n) => n.manifestPath === qc.manifest);
			if (!existing) {
				report.quantContracts.push({
					type,
					manifestPath: qc.manifest,
					id: parts[2] ?? "?",
					revision: parts[3] ?? "r0",
					hash16: parts[4] ?? "",
					immutableKey: qc.immutable_key,
					validationStatus: qc.validation_status === "validated" || qc.validation_status === "unresolved" || qc.validation_status === "invalid" ? qc.validation_status : "unresolved",
					resultArtifact: null,
				});
			}
		}

		const manifests: Record<string, Record<string, unknown>> = {};
		for (const node of report.quantContracts) {
			const loaded = await readQuantManifestFile(projectRoot, node.manifestPath);
			if (loaded.ok && loaded.value) manifests[node.manifestPath] = loaded.value;
		}
		report.upstreamRelationships = linkRelationships(report.quantContracts, manifests);

		// artifact hash facts (backtest-result result artifacts).
		for (const node of report.quantContracts) {
			if (node.resultArtifact) {
				report.artifactHashes.push({
					path: node.manifestPath,
					kind: "resultArtifactHash",
					status: node.resultArtifact.corrupt
						? `CORRUPT (${node.resultArtifact.reason ?? "hash mismatch"})`
						: node.resultArtifact.verified
							? "verified"
							: `unverifiable (${node.resultArtifact.reason ?? "?"})`,
				});
			}
		}

		// reused runs (cache-hit chain).
		if (run.execution_source === "cache" && run.reused_from_run_id) {
			report.reusedRuns.push(run.reused_from_run_id);
			const source = await loadRun(projectRoot, run.reused_from_run_id);
			if (source) {
				report.reusedRuns.push(...source.artifact_paths.filter((p) => p.endsWith(".json")).slice(0, 5));
			}
		}

		// invalidation reason: a cache-hit run whose action record is gone.
		if (run.execution_source === "cache" && run.action_key) {
			const store = new ActionCacheStore(projectRoot);
			const { record } = await store.readRecord(run.action_key);
			if (!record) {
				report.invalidationReason = "this cached run's action record no longer exists — pruned, cleared, or the key changed (a future run re-executes)";
			} else if (record.quantContractInfo) {
				report.invalidationReason = `action record exists and the quant contract matches (immutable key ${record.quantContractInfo.immutableKey}) — valid cache hit`;
			}
		}
		return report;
	}

	report.error = `unknown target "${target}" (expected a run id like 20260101-120000-abcd or a 64-hex action key)`;
	return report;
}

export function renderQuantLineage(report: QuantLineageReport): string[] {
	if (!report.ok) {
		return [`/q-cache-lineage: ${report.error ?? "unknown error"}`];
	}
	const lines = [
		`target               : ${report.target}`,
		`kind                 : ${report.kind}`,
		`run                  : ${report.runId ?? "—"}`,
		`recipe               : ${report.recipe ?? "—"}`,
		`execution source     : ${report.executionSource ?? "—"}${report.reusedFromRunId ? ` (reused ${report.reusedFromRunId})` : ""}`,
		`action key           : ${report.actionKey ? `${report.actionKey.slice(0, 16)}…` : "—"}`,
		`invalidation reason  : ${report.invalidationReason ?? "(none — key matches)"}`,
		"",
		"quant contracts (data snapshot -> feature set -> backtest result):",
	];
	if (report.quantContracts.length === 0) {
		lines.push("  (none found among this run's JSON artifacts)");
	}
	for (const node of report.quantContracts) {
		const artifact = node.resultArtifact
			? node.resultArtifact.corrupt
				? " | result artifact CORRUPT"
				: node.resultArtifact.verified
					? " | result artifact hash verified"
					: " | result artifact unverifiable"
			: "";
		lines.push(`  - ${node.type.padEnd(14)} ${node.id} (rev ${node.revision}, hash ${node.hash16}) [${node.validationStatus}]${artifact}`);
		lines.push(`      manifest: ${node.manifestPath}`);
		lines.push(`      key     : ${node.immutableKey}`);
	}
	if (report.upstreamRelationships.length > 0) {
		lines.push("", "upstream relationships:");
		for (const rel of report.upstreamRelationships) lines.push(`  - ${rel}`);
	}
	if (report.artifactHashes.length > 0) {
		lines.push("", "artifact hashes:");
		for (const h of report.artifactHashes) lines.push(`  - ${h.path}: ${h.kind} ${h.status}`);
	}
	if (report.reusedRuns.length > 0) {
		lines.push("", "reused runs:", ...report.reusedRuns.map((r) => `  - ${r}`));
	}
	return lines;
}
