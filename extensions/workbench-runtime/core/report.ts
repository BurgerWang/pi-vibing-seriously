/**
 * P4 run reports — the single reader for run facts (`/q-report`,
 * `workbench_read_run`, status bar and widget data).
 *
 * All facts come from the persisted run records only: manifest.json,
 * summary.json, gates.json and (for quant runs) the run-attributed
 * quant-result.json artifact. Nothing is recomputed from logs or stdout.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { runsDir } from "./config.ts";
import { validateQuantResult, type QuantResultValidation } from "./quant-result.ts";
import {
	isValidRunId,
	listRuns,
	readManifest,
	type RunRecord,
} from "./runs.ts";
import { runStatusLabel } from "./format.ts";
import type { GateStatus } from "./gate-schema.ts";
import { GATE_SCHEMA_VERSION } from "./gate-engine.ts";
import { displayRelative } from "./recipe-runner.ts";

// ---------------------------------------------------------------------------
// Gate run records
// ---------------------------------------------------------------------------

export interface GateRunSummary {
	run_id: string;
	status: GateStatus;
	requested: string[];
	profile: string | undefined;
	counts: { pass: number; fail: number; blocked: number; not_run: number };
	/** Per-gate statuses of the run. */
	gates: { id: string; status: GateStatus; title: string; failure_reason: string | null; blocked_reason: string | null }[];
	/** The most relevant gate: worst status, first in run order. */
	worst_gate: { id: string; status: GateStatus } | null;
	/** Blocking/failure reason of the worst gate, if any. */
	blocking_reason: string | null;
}

const GATE_STATUS_ORDER: Record<GateStatus, number> = { PASS: 0, NOT_RUN: 1, BLOCKED: 2, FAIL: 3 };

/** Read gates.json of a gate run (validated against the run id). */
export async function readGateFileRecord(projectRoot: string, runId: string): Promise<{ schema_version: number; run_id: string; requested: string[]; profile: string | undefined; mode: string; gates: { id: string; status: GateStatus; title: string; failure_reason: string | null; blocked_reason: string | null }[] } | null> {
	try {
		const raw = await readFile(join(runsDir(projectRoot), runId, "gates.json"), "utf8");
		const parsed = JSON.parse(raw) as {
			schema_version?: number;
			run_id?: unknown;
			requested?: unknown;
			profile?: unknown;
			mode?: unknown;
			gates?: unknown;
		};
		if (parsed.run_id !== runId || !Array.isArray(parsed.gates)) return null;
		const gates = parsed.gates as { id: string; status: GateStatus; title: string; failure_reason: string | null; blocked_reason: string | null }[];
		return {
			schema_version: parsed.schema_version ?? GATE_SCHEMA_VERSION,
			run_id: runId,
			requested: Array.isArray(parsed.requested) ? (parsed.requested as string[]) : [],
			profile: typeof parsed.profile === "string" ? parsed.profile : undefined,
			mode: typeof parsed.mode === "string" ? parsed.mode : "?",
			gates,
		};
	} catch {
		return null;
	}
}

/** Summary of the most recent gate run, if any (newest run with recipe "gate"). */
export async function latestGateRunSummary(projectRoot: string): Promise<GateRunSummary | null> {
	const runs = await listRuns(projectRoot, 10);
	for (const run of runs) {
		if (run.recipe !== "gate") continue;
		const record = await readGateFileRecord(projectRoot, run.run_id);
		if (!record) continue;
		const gates = record.gates;
		const counts = {
			pass: gates.filter((g) => g.status === "PASS").length,
			fail: gates.filter((g) => g.status === "FAIL").length,
			blocked: gates.filter((g) => g.status === "BLOCKED").length,
			not_run: gates.filter((g) => g.status === "NOT_RUN").length,
		};
		let worst: { id: string; status: GateStatus } | null = null;
		for (const gate of gates) {
			if (worst === null || GATE_STATUS_ORDER[gate.status] > GATE_STATUS_ORDER[worst.status]) {
				worst = { id: gate.id, status: gate.status };
			}
		}
		const worstGate = worst ? gates.find((g) => g.id === worst.id) : null;
		return {
			run_id: run.run_id,
			status: counts.fail > 0 ? "FAIL" : counts.blocked > 0 ? "BLOCKED" : gates.some((g) => g.status === "NOT_RUN") ? "NOT_RUN" : "PASS",
			requested: record.requested,
			profile: record.profile,
			counts,
			gates,
			worst_gate: worst,
			blocking_reason: worstGate?.blocked_reason ?? worstGate?.failure_reason ?? null,
		};
	}
	return null;
}

// ---------------------------------------------------------------------------
// Quant artifacts (run-attributed only)
// ---------------------------------------------------------------------------

export interface QuantArtifact {
	/** Project-relative path of the artifact that was read. */
	path: string;
	value: Record<string, unknown>;
	validation: QuantResultValidation;
}

async function tryReadQuantArtifact(absolutePath: string): Promise<{ path: string; value: Record<string, unknown>; validation: QuantResultValidation } | null> {
	try {
		const raw = await readFile(absolutePath, "utf8");
		if (raw.length > 512 * 1024) return null;
		const value = JSON.parse(raw) as unknown;
		const validation = validateQuantResult(value);
		if (!validation.valid) return null;
		return { path: absolutePath, value: value as Record<string, unknown>, validation };
	} catch {
		return null;
	}
}

/**
 * Locate the quant-result artifact attributed to a run:
 *   1. run-dir snapshots/evidence copies — recipe runs snapshot declared
 *      JSON artifacts into artifacts/ (P4); gate runs copy schema evidence
 *      there too. These are run-attributed and always preferred.
 *   2. manifest artifact paths ending in "quant-result.json" — a live-file
 *      fallback for runs recorded before P4 snapshots existed (the file may
 *      have been overwritten by later runs; stale-read risk is documented).
 * Only artifacts that validate against the quant contract count.
 */
export async function loadQuantArtifact(projectRoot: string, manifest: RunRecord): Promise<QuantArtifact | null> {
	const dir = join(runsDir(projectRoot), manifest.run_id, "artifacts");
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith("quant-result.json")) continue;
			const found = await tryReadQuantArtifact(join(dir, entry.name));
			if (found) return found;
		}
	} catch {
		// no artifacts dir
	}
	for (const rel of manifest.artifact_paths) {
		if (!rel.endsWith("quant-result.json")) continue;
		const found = await tryReadQuantArtifact(join(projectRoot, rel));
		if (found) return found;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Resolve a report target: "latest" → newest run id; otherwise a valid,
 * existing run id. Returns null when nothing matches.
 */
export async function resolveRunTarget(projectRoot: string, arg: string): Promise<string | null> {
	const target = arg.trim();
	if (target === "latest") {
		const runs = await listRuns(projectRoot, 1);
		return runs[0]?.run_id ?? null;
	}
	if (!isValidRunId(target)) return null;
	return (await readManifest(projectRoot, target)) ? target : null;
}

/**
 * Build a full run report (the body of `/q-report <run-id>`).
 * Returns null when the run does not exist. Every line is a fact from the
 * run's own JSON records.
 */
export async function buildRunReport(projectRoot: string, runId: string): Promise<string[] | null> {
	const manifest = await readManifest(projectRoot, runId);
	if (!manifest) return null;

	const rel = (p: string): string => displayRelative(projectRoot, p);
	const logBase = join(runsDir(projectRoot), runId);
	const lines = [
		`run       : ${manifest.run_id}`,
		`recipe    : ${manifest.recipe}${manifest.recipe === "gate" ? " (gate run)" : ""}`,
		`profile   : ${manifest.profile ?? "(none)"}`,
		`mode      : ${manifest.mode}`,
		`started   : ${manifest.started_at}`,
		`finished  : ${manifest.finished_at}`,
		`duration  : ${manifest.duration_ms} ms`,
		`exit code : ${manifest.exit_code ?? "killed"}`,
		`status    : ${runStatusLabel(manifest)}`,
		`git       : ${manifest.git_commit ? manifest.git_commit.slice(0, 12) : "(no git)"}${manifest.git_dirty ? " (dirty)" : ""}`,
		`artifacts : ${manifest.artifact_paths.length > 0 ? manifest.artifact_paths.join(", ") : "(none)"}`,
		`stdout log: ${rel(join(logBase, "stdout.log"))}`,
		`stderr log: ${rel(join(logBase, "stderr.log"))}`,
	];

	if (manifest.recipe === "gate") {
		const record = await readGateFileRecord(projectRoot, runId);
		if (record) {
			lines.push("", `gates (${record.gates.length}):`);
			for (const g of record.gates) {
				const reason = g.failure_reason ?? g.blocked_reason ?? "";
				lines.push(`  ${g.id.padEnd(4)} ${g.status.padEnd(8)} ${g.title}${reason ? ` — ${reason}` : ""}`);
			}
			const failedChecks = record.gates.flatMap((g) =>
				g.failure_reason ? [`${g.id}: ${g.failure_reason}`] : [],
			);
			if (failedChecks.length > 0) {
				lines.push("", "failed checks:", ...failedChecks.map((f) => `  ${f}`));
			}
		}
	}

	const quant = await loadQuantArtifact(projectRoot, manifest);
	if (quant) {
		const m = quant.value.metrics as Record<string, unknown> | undefined;
		const folds = quant.value.folds as { id: string; status: string }[] | undefined;
		lines.push("", `quant result (${quant.path}):`);
		lines.push(`  return          : ${typeof m?.return === "number" ? m.return : "n/a"}`);
		lines.push(`  benchmark delta : ${typeof m?.benchmark_delta === "number" ? m.benchmark_delta : "n/a"}`);
		lines.push(`  drawdown        : ${typeof m?.drawdown === "number" ? m.drawdown : "n/a"}`);
		lines.push(`  turnover        : ${typeof m?.turnover === "number" ? m.turnover : "n/a"}`);
		if (folds) {
			const failed = folds.filter((f) => f.status === "failed").map((f) => f.id);
			const passed = folds.filter((f) => f.status === "passed").length;
			lines.push(`  folds           : ${passed} passed, ${folds.length - passed} not passed${failed.length > 0 ? ` (failed: ${failed.join(", ")})` : ""}`);
		}
		lines.push(`  parameters      : ${Object.keys((quant.value.parameters as Record<string, unknown>) ?? {}).join(", ") || "(none)"}`);
	}

	lines.push("", `full record: ${rel(join(logBase, "manifest.json"))}`);
	return lines;
}
