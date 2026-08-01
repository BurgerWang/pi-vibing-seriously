/**
 * P4 run comparison (`/q-compare`, `workbench_compare_runs`) — P4 spec §5.
 *
 * Rules:
 *   - all facts come from the runs' own JSON records (manifest.json,
 *     gates.json, summary-derived counts, run-attributed quant-result.json)
 *   - the comparator never recomputes business metrics — it only diffs
 *     values the runs themselves declared
 *   - deltas are descriptive: a higher return is NEVER automatically
 *     interpreted as a better strategy (neutrality note in the report)
 *   - incompatible schemas (recipe run vs gate run, quant vs non-quant) are
 *     reported as incompatible with a note; generic facts are still compared
 */

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { runsDir } from "./config.ts";
import type { GateStatus } from "./gate-schema.ts";
import { loadQuantArtifact, readGateFileRecord, type QuantArtifact } from "./report.ts";
import { isValidRunId, readManifest, type RunRecord } from "./runs.ts";

export interface ValueDelta<T> {
	a: T;
	b: T;
	changed: boolean;
}

export interface ArtifactMetricDelta {
	file: string;
	field: string;
	a: number;
	b: number;
}

export interface GateStatusDelta {
	gate: string;
	a: GateStatus;
	b: GateStatus;
}

export interface FoldCounts {
	passed: number;
	failed: number;
	skipped: number;
	pending: number;
}

export interface ParameterChange {
	field: string;
	a: unknown;
	b: unknown;
}

export interface RunIdentity {
	run_id: string;
	recipe: string;
	started_at: string;
}

export interface QuantComparison {
	benchmark_delta: ValueDelta<number | null>;
	return: ValueDelta<number | null>;
	drawdown: ValueDelta<number | null>;
	turnover: ValueDelta<number | null>;
	costs: ArtifactMetricDelta[];
	folds: { a: FoldCounts | null; b: FoldCounts | null };
	parameters: ParameterChange[];
	a_path: string;
	b_path: string;
}

export interface RunComparison {
	/** False when record schemas differ in a way that blocks a section. */
	compatible: boolean;
	notes: string[];
	a: RunIdentity;
	b: RunIdentity;
	generic: {
		exit_code: ValueDelta<number | null>;
		duration_ms: ValueDelta<number>;
		artifacts: { added: string[]; removed: string[]; common: string[] };
		/** Per-gate status delta; null when neither run is a gate run. */
		gate_delta: { changed: GateStatusDelta[]; a: Record<string, GateStatus>; b: Record<string, GateStatus> } | null;
		/** Gate check counts; null when a run is not a gate run. */
		test_counts: {
			a: { passed: number; failed: number; blocked: number; not_run: number } | null;
			b: { passed: number; failed: number; blocked: number; not_run: number } | null;
		} | null;
		/** Numeric leaf deltas of JSON artifacts shared by both runs. */
		artifact_metrics: ArtifactMetricDelta[];
	};
	quant: QuantComparison | null;
}

export type CompareOutcome = { ok: true; report: RunComparison } | { ok: false; error: string };

/** Fixed neutrality statement — deltas are never verdicts. */
export const QUANT_NEUTRALITY_NOTE =
	"deltas are descriptive facts only — a higher return is not automatically a better strategy (no risk or significance judgement is made here)";

const MAX_ARTIFACT_METRIC_DELTAS = 12;
const MAX_NUMERIC_LEAVES = 200;
const MAX_ARTIFACT_BYTES = 512 * 1024;

function identityOf(record: RunRecord): RunIdentity {
	return { run_id: record.run_id, recipe: record.recipe, started_at: record.started_at };
}

function gateStatusMap(record: RunRecord, gates: { id: string; status: GateStatus }[]): Record<string, GateStatus> {
	const map: Record<string, GateStatus> = {};
	for (const g of gates) map[g.id] = g.status;
	return map;
}

function countStatuses(gates: { status: GateStatus }[]): { passed: number; failed: number; blocked: number; not_run: number } {
	return {
		passed: gates.filter((g) => g.status === "PASS").length,
		failed: gates.filter((g) => g.status === "FAIL").length,
		blocked: gates.filter((g) => g.status === "BLOCKED").length,
		not_run: gates.filter((g) => g.status === "NOT_RUN").length,
	};
}

function numericLeaves(value: unknown, path: string, out: Map<string, number>, depth: number): void {
	if (out.size >= MAX_NUMERIC_LEAVES) return;
	if (typeof value === "number" && Number.isFinite(value)) {
		out.set(path, value);
		return;
	}
	if (depth >= 2) return;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length && out.size < MAX_NUMERIC_LEAVES; i++) {
			numericLeaves(value[i], `${path}[${i}]`, out, depth + 1);
		}
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (out.size >= MAX_NUMERIC_LEAVES) break;
			numericLeaves(item, path.length > 0 ? `${path}.${key}` : key, out, depth + 1);
		}
	}
}

async function readSnapshotJson(projectRoot: string, record: RunRecord, relPath: string): Promise<unknown | null> {
	// Run-attributed copies only (recipe runs snapshot declared JSON artifacts
	// into <run-dir>/artifacts/). Live project files are never read here — a
	// later run overwriting the same path must not corrupt earlier records.
	const snapshot = join(runsDir(projectRoot), record.run_id, "artifacts", basename(relPath));
	try {
		const raw = await readFile(snapshot, "utf8");
		if (raw.length > MAX_ARTIFACT_BYTES) return null;
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

/** Numeric leaf deltas of JSON artifacts declared by BOTH runs. */
async function artifactMetricDeltas(projectRoot: string, a: RunRecord, b: RunRecord): Promise<{ deltas: ArtifactMetricDelta[]; truncated: boolean }> {
	const bSet = new Set(b.artifact_paths);
	const common = a.artifact_paths.filter((p) => bSet.has(p) && !p.endsWith("quant-result.json"));
	const deltas: ArtifactMetricDelta[] = [];
	for (const rel of common) {
		if (deltas.length >= MAX_ARTIFACT_METRIC_DELTAS) break;
		const rawA = await readSnapshotJson(projectRoot, a, rel);
		const rawB = await readSnapshotJson(projectRoot, b, rel);
		if (rawA === null || rawB === null) continue;
		const leavesA = new Map<string, number>();
		const leavesB = new Map<string, number>();
		numericLeaves(rawA, "", leavesA, 0);
		numericLeaves(rawB, "", leavesB, 0);
		for (const [field, valueA] of leavesA) {
			if (deltas.length >= MAX_ARTIFACT_METRIC_DELTAS) break;
			const valueB = leavesB.get(field);
			if (valueB === undefined || valueB === valueA) continue;
			deltas.push({ file: rel, field: field || "(root)", a: valueA, b: valueB });
		}
	}
	return { deltas, truncated: deltas.length >= MAX_ARTIFACT_METRIC_DELTAS };
}

function numMetric(value: Record<string, unknown> | undefined, key: string): number | null {
	const n = value?.[key];
	return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function foldCounts(artifact: QuantArtifact): FoldCounts {
	const statuses = Object.values(artifact.validation.fold_statuses);
	return {
		passed: statuses.filter((s) => s === "passed").length,
		failed: statuses.filter((s) => s === "failed").length,
		skipped: statuses.filter((s) => s === "skipped").length,
		pending: statuses.filter((s) => s === "pending").length,
	};
}

function buildQuantComparison(a: QuantArtifact, b: QuantArtifact): QuantComparison {
	const metricsA = a.value.metrics as Record<string, unknown> | undefined;
	const metricsB = b.value.metrics as Record<string, unknown> | undefined;
	const delta = (key: string): ValueDelta<number | null> => {
		const av = numMetric(metricsA, key);
		const bv = numMetric(metricsB, key);
		return { a: av, b: bv, changed: av !== bv };
	};

	const costs: ArtifactMetricDelta[] = [];
	const costsA = (a.value.costs as Record<string, unknown> | undefined) ?? {};
	const costsB = (b.value.costs as Record<string, unknown> | undefined) ?? {};
	for (const key of new Set([...Object.keys(costsA), ...Object.keys(costsB)])) {
		const av = costsA[key];
		const bv = costsB[key];
		if (typeof av === "number" && Number.isFinite(av) && typeof bv === "number" && Number.isFinite(bv) && av !== bv) {
			costs.push({ file: "costs", field: key, a: av, b: bv });
		}
	}

	const parameters: ParameterChange[] = [];
	const paramsA = (a.value.parameters as Record<string, unknown> | undefined) ?? {};
	const paramsB = (b.value.parameters as Record<string, unknown> | undefined) ?? {};
	for (const key of new Set([...Object.keys(paramsA), ...Object.keys(paramsB)])) {
		if (!isDeepStrictEqual(paramsA[key], paramsB[key])) {
			parameters.push({ field: key, a: paramsA[key], b: paramsB[key] });
		}
	}

	return {
		benchmark_delta: delta("benchmark_delta"),
		return: delta("return"),
		drawdown: delta("drawdown"),
		turnover: delta("turnover"),
		costs,
		folds: { a: foldCounts(a), b: foldCounts(b) },
		parameters,
		a_path: a.path,
		b_path: b.path,
	};
}

/**
 * Compare two run records. `ok: false` with an error when a run id is
 * unknown or malformed; otherwise the comparison report (with `compatible`
 * and `notes` describing any schema mismatches).
 */
export async function compareRuns(projectRoot: string, runIdA: string, runIdB: string): Promise<CompareOutcome> {
	if (!isValidRunId(runIdA)) return { ok: false, error: `invalid run id "${runIdA}"` };
	if (!isValidRunId(runIdB)) return { ok: false, error: `invalid run id "${runIdB}"` };
	const a = await readManifest(projectRoot, runIdA);
	if (!a) return { ok: false, error: `run ${runIdA} not found` };
	const b = await readManifest(projectRoot, runIdB);
	if (!b) return { ok: false, error: `run ${runIdB} not found` };

	const kindA = a.recipe === "gate" ? "gate" : "recipe";
	const kindB = b.recipe === "gate" ? "gate" : "recipe";
	const notes: string[] = [];
	if (kindA !== kindB) {
		notes.push(
			`run ${a.run_id} is a ${kindA} run and run ${b.run_id} is a ${kindB} run — record schemas differ; only generic facts are compared`,
		);
	}

	// ---- gate delta + test counts (gate runs only) -------------------------
	let gateDelta: RunComparison["generic"]["gate_delta"] = null;
	let testCounts: RunComparison["generic"]["test_counts"] = null;
	if (kindA === "gate" && kindB === "gate") {
		const recordA = await readGateFileRecord(projectRoot, a.run_id);
		const recordB = await readGateFileRecord(projectRoot, b.run_id);
		if (recordA && recordB) {
			const statusA = gateStatusMap(a, recordA.gates);
			const statusB = gateStatusMap(b, recordB.gates);
			const changed: GateStatusDelta[] = [];
			for (const gate of new Set([...Object.keys(statusA), ...Object.keys(statusB)])) {
				const sa = statusA[gate] ?? "NOT_RUN";
				const sb = statusB[gate] ?? "NOT_RUN";
				if (sa !== sb) changed.push({ gate, a: sa, b: sb });
			}
			gateDelta = { changed, a: statusA, b: statusB };
			testCounts = { a: countStatuses(recordA.gates), b: countStatuses(recordB.gates) };
		}
	} else if (kindA === "gate" || kindB === "gate") {
		notes.push("gate delta and test counts are not comparable across a gate run and a recipe run");
	}

	// ---- quant metrics ------------------------------------------------------
	const quantA = await loadQuantArtifact(projectRoot, a);
	const quantB = await loadQuantArtifact(projectRoot, b);
	let quant: QuantComparison | null = null;
	if (quantA && quantB) {
		quant = buildQuantComparison(quantA, quantB);
	} else if (quantA || quantB) {
		const missing = quantA ? b.run_id : a.run_id;
		notes.push(`quant metrics not compared: run ${missing} has no valid quant-result artifact`);
	} else {
		notes.push("quant metrics not compared: neither run has a valid quant-result artifact");
	}

	// ---- generic deltas ------------------------------------------------------
	const artifactsA = new Set(a.artifact_paths);
	const artifactsB = new Set(b.artifact_paths);
	const common = a.artifact_paths.filter((p) => artifactsB.has(p));
	const added = b.artifact_paths.filter((p) => !artifactsA.has(p));
	const removed = a.artifact_paths.filter((p) => !artifactsB.has(p));
	const artifactMetrics = await artifactMetricDeltas(projectRoot, a, b);
	if (artifactMetrics.truncated) notes.push("artifact metric deltas truncated at 12 changed fields");

	const report: RunComparison = {
		compatible: kindA === kindB && (quant !== null || (quantA === null && quantB === null)),
		notes,
		a: identityOf(a),
		b: identityOf(b),
		generic: {
			exit_code: { a: a.exit_code, b: b.exit_code, changed: a.exit_code !== b.exit_code },
			duration_ms: { a: a.duration_ms, b: b.duration_ms, changed: a.duration_ms !== b.duration_ms },
			artifacts: { added, removed, common },
			gate_delta: gateDelta,
			test_counts: testCounts,
			artifact_metrics: artifactMetrics.deltas,
		},
		quant,
	};
	return { ok: true, report };
}
