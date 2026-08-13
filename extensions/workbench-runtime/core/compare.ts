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

import { readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { canonicalHash } from "../cache/canonical-hash.ts";
import {
	readJsonFileBounded,
	type BoundedFileErrorCode,
	type BoundedFileIoHooks,
} from "./bounded-file-io.ts";
import { persistComparisonRecord } from "./comparison-record.ts";
import { runsDir } from "./config.ts";
import type { GateStatus } from "./gate-schema.ts";
import { realpathContained } from "./path-guard.ts";
import { validateQuantResult, type QuantResultValidation } from "./quant-result.ts";
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

export interface CostMetricDelta {
	file: "costs";
	field: string;
	a: number | null;
	b: number | null;
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
	costs: CostMetricDelta[];
	folds: { a: FoldCounts | null; b: FoldCounts | null };
	parameters: ParameterChange[];
	a_path: string;
	b_path: string;
}

export interface RunComparison {
	/** Durable full-record identity; attached only after atomic persistence. */
	comparison_id?: string;
	comparison_path?: string;
	comparison_bytes?: number;
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

export type CompareOutcome =
	| {
		ok: true;
		report: RunComparison;
		comparison_id: string;
		comparison_path: string;
		comparison_bytes: number;
	}
	| { ok: false; error: string };

export interface CompareRunsOptions {
	/** Input-read instrumentation only; it cannot enlarge the 512 KiB cap. */
	artifactIoHooks?: BoundedFileIoHooks;
}

/** Fixed neutrality statement — deltas are never verdicts. */
export const QUANT_NEUTRALITY_NOTE =
	"deltas are descriptive facts only — a higher return is not automatically a better strategy (no risk or significance judgement is made here)";

const MAX_ARTIFACT_METRIC_DELTAS = 12;
const MAX_NUMERIC_LEAVES = 200;
export const MAX_ARTIFACT_BYTES = 512 * 1024;

interface QuantArtifact {
	path: string;
	value: Record<string, unknown>;
	validation: QuantResultValidation;
}

type ArtifactReadResult =
	| { ok: true; value: unknown }
	| { ok: false; code: BoundedFileErrorCode | "invalid_quant" | "unsafe_path" };

function identityOf(record: RunRecord): RunIdentity {
	return { run_id: record.run_id, recipe: record.recipe, started_at: record.started_at };
}

function artifactPathsOf(record: RunRecord): string[] {
	return Array.isArray(record.artifact_paths)
		? record.artifact_paths.filter((path): path is string => typeof path === "string")
		: [];
}

const GATE_CONTROL_ARTIFACTS = new Set(["gates.json", "evidence.json", "summary.json"]);

/** Gate authority records describe execution control, not domain metrics. */
function isControlArtifact(record: RunRecord, path: string): boolean {
	return record.recipe === "gate" && GATE_CONTROL_ARTIFACTS.has(path);
}

function gateStatusMap(gates: { id: string; status: GateStatus }[]): Record<string, GateStatus> {
	const map: Record<string, GateStatus> = Object.create(null) as Record<string, GateStatus>;
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

async function readSnapshotJson(
	projectRoot: string,
	record: RunRecord,
	relPath: string,
	hooks?: BoundedFileIoHooks,
): Promise<ArtifactReadResult> {
	// Run-attributed copies only (recipe runs snapshot declared JSON artifacts
	// into <run-dir>/artifacts/). Live project files are never read here — a
	// later run overwriting the same path must not corrupt earlier records.
	const snapshot = join(runsDir(projectRoot), record.run_id, "artifacts", basename(relPath));
	try {
		const read = await readJsonFileBounded(snapshot, MAX_ARTIFACT_BYTES, hooks);
		return read.ok ? { ok: true, value: read.value.value } : { ok: false, code: read.error.code };
	} catch {
		return { ok: false, code: "io_error" };
	}
}

/** Numeric leaf deltas of JSON artifacts declared by BOTH runs. */
async function artifactMetricDeltas(
	projectRoot: string,
	a: RunRecord,
	b: RunRecord,
	hooks?: BoundedFileIoHooks,
): Promise<{ deltas: ArtifactMetricDelta[]; truncated: boolean; unavailable: Map<string, number> }> {
	const pathsA = artifactPathsOf(a);
	const bSet = new Set(artifactPathsOf(b));
	const common = pathsA.filter((p) =>
		bSet.has(p)
		&& !p.endsWith("quant-result.json")
		&& !isControlArtifact(a, p)
		&& !isControlArtifact(b, p));
	const deltas: ArtifactMetricDelta[] = [];
	const unavailable = new Map<string, number>();
	const recordUnavailable = (code: string): void => {
		unavailable.set(code, (unavailable.get(code) ?? 0) + 1);
	};
	for (const rel of common) {
		if (deltas.length >= MAX_ARTIFACT_METRIC_DELTAS) break;
		const rawA = await readSnapshotJson(projectRoot, a, rel, hooks);
		const rawB = await readSnapshotJson(projectRoot, b, rel, hooks);
		if (!rawA.ok || !rawB.ok) {
			if (!rawA.ok) recordUnavailable(rawA.code);
			if (!rawB.ok) recordUnavailable(rawB.code);
			continue;
		}
		const leavesA = new Map<string, number>();
		const leavesB = new Map<string, number>();
		numericLeaves(rawA.value, "", leavesA, 0);
		numericLeaves(rawB.value, "", leavesB, 0);
		for (const [field, valueA] of leavesA) {
			if (deltas.length >= MAX_ARTIFACT_METRIC_DELTAS) break;
			const valueB = leavesB.get(field);
			if (valueB === undefined || valueB === valueA) continue;
			deltas.push({ file: rel, field: field || "(root)", a: valueA, b: valueB });
		}
	}
	return { deltas, truncated: deltas.length >= MAX_ARTIFACT_METRIC_DELTAS, unavailable };
}

interface BoundedGateRecord {
	gates: { id: string; status: GateStatus }[];
}

async function readGateRecordBounded(
	projectRoot: string,
	runId: string,
	hooks?: BoundedFileIoHooks,
): Promise<{ ok: true; value: BoundedGateRecord } | { ok: false; code: string }> {
	const read = await readJsonFileBounded<unknown>(
		join(runsDir(projectRoot), runId, "gates.json"),
		MAX_ARTIFACT_BYTES,
		hooks,
	);
	if (!read.ok) return { ok: false, code: read.error.code };
	const parsed = read.value.value;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, code: "invalid_json" };
	}
	const root = parsed as Record<string, unknown>;
	if (root.run_id !== runId || !Array.isArray(root.gates)) return { ok: false, code: "invalid_json" };
	const gates: { id: string; status: GateStatus }[] = [];
	for (const rawGate of root.gates) {
		if (typeof rawGate !== "object" || rawGate === null || Array.isArray(rawGate)) {
			return { ok: false, code: "invalid_json" };
		}
		const gate = rawGate as Record<string, unknown>;
		if (typeof gate.id !== "string"
			|| (gate.status !== "PASS" && gate.status !== "FAIL" && gate.status !== "BLOCKED" && gate.status !== "NOT_RUN")) {
			return { ok: false, code: "invalid_json" };
		}
		gates.push({ id: gate.id, status: gate.status });
	}
	return { ok: true, value: { gates } };
}

function incrementCode(codes: Map<string, number>, code: string): void {
	codes.set(code, (codes.get(code) ?? 0) + 1);
}

async function tryReadQuantArtifactBounded(
	absolutePath: string,
	displayPath: string,
	hooks?: BoundedFileIoHooks,
): Promise<{ ok: true; value: QuantArtifact } | { ok: false; code: string }> {
	const read = await readJsonFileBounded<unknown>(absolutePath, MAX_ARTIFACT_BYTES, hooks);
	if (!read.ok) return { ok: false, code: read.error.code };
	const value = read.value.value;
	const validation = validateQuantResult(value);
	if (!validation.valid || typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, code: "invalid_quant" };
	}
	return { ok: true, value: { path: displayPath, value: value as Record<string, unknown>, validation } };
}

async function loadQuantArtifactBounded(
	projectRoot: string,
	manifest: RunRecord,
	hooks?: BoundedFileIoHooks,
): Promise<{ artifact: QuantArtifact | null; unavailable: Map<string, number> }> {
	const unavailable = new Map<string, number>();
	const snapshotsDir = join(runsDir(projectRoot), manifest.run_id, "artifacts");
	try {
		const entries = (await readdir(snapshotsDir, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith("quant-result.json"))
			.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		for (const entry of entries) {
			const absolute = join(snapshotsDir, entry.name);
			const display = relative(resolve(projectRoot), absolute).split("\\").join("/");
			const found = await tryReadQuantArtifactBounded(absolute, display, hooks);
			if (found.ok) return { artifact: found.value, unavailable: new Map() };
			incrementCode(unavailable, found.code);
		}
	} catch {
		// A missing snapshot directory is normal for legacy runs.
	}
	for (const rel of artifactPathsOf(manifest)) {
		if (typeof rel !== "string" || !rel.endsWith("quant-result.json")) continue;
		const contained = await realpathContained(projectRoot, rel);
		if (contained === undefined) {
			incrementCode(unavailable, "unsafe_path");
			continue;
		}
		const found = await tryReadQuantArtifactBounded(contained, rel, hooks);
		if (found.ok) return { artifact: found.value, unavailable: new Map() };
		incrementCode(unavailable, found.code);
	}
	return { artifact: null, unavailable };
}

function unavailableSummary(codes: Map<string, number>): string {
	return [...codes.entries()]
		.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
		.map(([code, count]) => `${code}:${count}`)
		.join(", ");
}

function comparisonSummaryRecord(report: RunComparison): Record<string, unknown> {
	const gateChanged = report.generic.gate_delta?.changed.length ?? 0;
	const quantChanged = report.quant
		? [report.quant.benchmark_delta, report.quant.return, report.quant.drawdown, report.quant.turnover]
			.filter((delta) => delta.changed).length + report.quant.costs.length + report.quant.parameters.length
		: 0;
	return {
		compatible: report.compatible,
		a_run_id: report.a.run_id,
		b_run_id: report.b.run_id,
		exit_code: report.generic.exit_code,
		duration_ms: report.generic.duration_ms,
		artifacts: {
			added_count: report.generic.artifacts.added.length,
			removed_count: report.generic.artifacts.removed.length,
			common_count: report.generic.artifacts.common.length,
		},
		gate_changed_count: gateChanged,
		artifact_metric_changed_count: report.generic.artifact_metrics.length,
		quant_changed_count: quantChanged,
		parameter_changed_count: report.quant?.parameters.length ?? 0,
		cost_changed_count: report.quant?.costs.length ?? 0,
		quant_metrics: report.quant === null ? null : {
			benchmark_delta: report.quant.benchmark_delta,
			return: report.quant.return,
			drawdown: report.quant.drawdown,
			turnover: report.quant.turnover,
		},
		note_count: report.notes.length,
		neutrality_note: report.quant === null ? null : QUANT_NEUTRALITY_NOTE,
	};
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

	const costs: CostMetricDelta[] = [];
	const costsA = (a.value.costs as Record<string, unknown> | undefined) ?? {};
	const costsB = (b.value.costs as Record<string, unknown> | undefined) ?? {};
	for (const key of new Set([...Object.keys(costsA), ...Object.keys(costsB)])) {
		const rawA = costsA[key];
		const rawB = costsB[key];
		const av = typeof rawA === "number" && Number.isFinite(rawA) ? rawA : null;
		const bv = typeof rawB === "number" && Number.isFinite(rawB) ? rawB : null;
		if (av !== bv) {
			costs.push({ file: "costs", field: key, a: av, b: bv });
		}
	}

	const parameters: ParameterChange[] = [];
	const paramsA = (a.value.parameters as Record<string, unknown> | undefined) ?? {};
	const paramsB = (b.value.parameters as Record<string, unknown> | undefined) ?? {};
	for (const key of new Set([...Object.keys(paramsA), ...Object.keys(paramsB)])) {
		const hasA = Object.prototype.hasOwnProperty.call(paramsA, key);
		const hasB = Object.prototype.hasOwnProperty.call(paramsB, key);
		let equal = false;
		try { equal = hasA === hasB && isDeepStrictEqual(paramsA[key], paramsB[key]); } catch { equal = false; }
		if (!equal) {
			parameters.push({
				field: key,
				a: hasA ? paramsA[key] : { comparison_parameter_available: false },
				b: hasB ? paramsB[key] : { comparison_parameter_available: false },
			});
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
export async function compareRuns(
	projectRoot: string,
	runIdA: string,
	runIdB: string,
	options: CompareRunsOptions = {},
): Promise<CompareOutcome> {
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
		const recordA = await readGateRecordBounded(projectRoot, a.run_id, options.artifactIoHooks);
		const recordB = await readGateRecordBounded(projectRoot, b.run_id, options.artifactIoHooks);
		if (recordA.ok && recordB.ok) {
			const statusA = gateStatusMap(recordA.value.gates);
			const statusB = gateStatusMap(recordB.value.gates);
			const changed: GateStatusDelta[] = [];
			for (const gate of new Set([...Object.keys(statusA), ...Object.keys(statusB)])) {
				const sa = statusA[gate] ?? "NOT_RUN";
				const sb = statusB[gate] ?? "NOT_RUN";
				if (sa !== sb) changed.push({ gate, a: sa, b: sb });
			}
			gateDelta = { changed, a: statusA, b: statusB };
			testCounts = { a: countStatuses(recordA.value.gates), b: countStatuses(recordB.value.gates) };
		} else {
			notes.push(`gate comparison unavailable (${recordA.ok ? "a:ok" : `a:${recordA.code}`}, ${recordB.ok ? "b:ok" : `b:${recordB.code}`})`);
		}
	} else if (kindA === "gate" || kindB === "gate") {
		notes.push("gate delta and test counts are not comparable across a gate run and a recipe run");
	}

	// ---- quant metrics ------------------------------------------------------
	const quantReadA = await loadQuantArtifactBounded(projectRoot, a, options.artifactIoHooks);
	const quantReadB = await loadQuantArtifactBounded(projectRoot, b, options.artifactIoHooks);
	const quantA = quantReadA.artifact;
	const quantB = quantReadB.artifact;
	let quant: QuantComparison | null = null;
	if (quantA && quantB) {
		quant = buildQuantComparison(quantA, quantB);
	} else if (quantA || quantB) {
		const missing = quantA ? b.run_id : a.run_id;
		const unavailable = quantA ? quantReadB.unavailable : quantReadA.unavailable;
		const suffix = unavailable.size > 0 ? ` (unavailable: ${unavailableSummary(unavailable)})` : "";
		notes.push(`quant metrics not compared: run ${missing} has no valid quant-result artifact${suffix}`);
	} else {
		const unavailable = new Map<string, number>();
		for (const [code, count] of [...quantReadA.unavailable, ...quantReadB.unavailable]) {
			unavailable.set(code, (unavailable.get(code) ?? 0) + count);
		}
		const suffix = unavailable.size > 0 ? ` (unavailable: ${unavailableSummary(unavailable)})` : "";
		notes.push(`quant metrics not compared: neither run has a valid quant-result artifact${suffix}`);
	}

	// ---- generic deltas ------------------------------------------------------
	const pathsA = artifactPathsOf(a);
	const pathsB = artifactPathsOf(b);
	const artifactsA = new Set(pathsA);
	const artifactsB = new Set(pathsB);
	const common = pathsA.filter((p) => artifactsB.has(p));
	const added = pathsB.filter((p) => !artifactsA.has(p));
	const removed = pathsA.filter((p) => !artifactsB.has(p));
	const artifactMetrics = await artifactMetricDeltas(projectRoot, a, b, options.artifactIoHooks);
	if (artifactMetrics.truncated) notes.push("artifact metric deltas truncated at 12 changed fields");
	if (artifactMetrics.unavailable.size > 0) {
		notes.push(`artifact metric inputs unavailable (${unavailableSummary(artifactMetrics.unavailable)})`);
	}

	const reportWithoutRecord: RunComparison = {
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
	let manifestDigestA: string;
	let manifestDigestB: string;
	try {
		manifestDigestA = canonicalHash(a);
		manifestDigestB = canonicalHash(b);
	} catch {
		return { ok: false, error: "comparison_persist_error" };
	}
	const persisted = await persistComparisonRecord(projectRoot, {
		a_identity: identityOf(a),
		b_identity: identityOf(b),
		a_manifest_digest: manifestDigestA,
		b_manifest_digest: manifestDigestB,
		report: reportWithoutRecord,
		summary: comparisonSummaryRecord(reportWithoutRecord),
	});
	if (!persisted.ok) return { ok: false, error: persisted.code };
	const report: RunComparison = {
		...reportWithoutRecord,
		comparison_id: persisted.comparison_id,
		comparison_path: persisted.comparison_path,
		comparison_bytes: persisted.bytes,
	};
	return {
		ok: true,
		report,
		comparison_id: persisted.comparison_id,
		comparison_path: persisted.comparison_path,
		comparison_bytes: persisted.bytes,
	};
}
