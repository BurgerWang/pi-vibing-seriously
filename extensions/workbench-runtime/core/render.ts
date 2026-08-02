/**
 * P4 tool renderers — pure line builders (P4 spec §3, §6).
 *
 * These produce plain, ANSI-free lines from the tools' structured `details`
 * payloads only — the renderer never recomputes business metrics and never
 * re-reads run files. The TUI wrapper (`ui/tool-renderers.ts`) adds theme
 * colors; print/json modes use the tool `content` text instead.
 *
 * Every builder handles missing fields gracefully ("n/a", "(none)").
 */

import {
	QUANT_NEUTRALITY_NOTE,
	type RunComparison,
} from "./compare.ts";
import { formatDelta, formatDuration, formatNumber, fitToWidth } from "./format.ts";

// ---------------------------------------------------------------------------
// Structured details payloads returned by the workbench tools
// (shared by tool execute + renderers + tests)
// ---------------------------------------------------------------------------

export interface RecipeToolDetails {
	ok: boolean;
	run_id: string;
	recipe: string;
	status: string;
	exit_code: number | null;
	duration_ms: number;
	artifact_paths: string[];
	stdout_log: string;
	stderr_log: string;
	expected_exit_codes: number[];
	/** P6-C cache facts (hit/miss/refused/...). */
	cache?: {
		status: string;
		actionKey?: string;
		reusedFromRunId?: string;
		reason?: string;
	};
	phase?: string;
}

export interface GateToolDetails {
	ok: boolean;
	status: string;
	run_id: string;
	requested: string[];
	profile: string | undefined;
	gates: { id: string; status: string; title: string; failure_reason: string | null; blocked_reason: string | null; failed_checks: string[] }[];
	counts: { pass: number; fail: number; blocked: number; not_run: number };
	log_path: string;
	phase?: string;
}

export interface ReadRunToolDetails {
	run_id: string;
	recipe: string;
	kind: "recipe" | "gate";
	status: string;
	exit_code: number | null;
	duration_ms: number;
	profile: string | undefined;
	mode: string;
	started_at: string;
	finished_at: string;
	git_commit: string | null;
	git_dirty: boolean;
	artifact_paths: string[];
	stdout_log: string;
	stderr_log: string;
}

export interface InspectToolDetails {
	project_root: string;
	git: { is_git: boolean; commit: string | null; dirty: boolean; branch: string | null };
	stacks: string[];
	profile: string | undefined;
	recipes: string[];
	config_errors: string[];
	config_files_present: string[];
}

export type CompareToolDetails = { ok: true; report: RunComparison } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Tool call header line (renderCall)
// ---------------------------------------------------------------------------

/** One-line summary of a tool call, e.g. `workbench_run_recipe "npm test"`. */
export function renderToolCallLine(toolName: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	switch (toolName) {
		case "workbench_run_recipe":
			return `workbench_run_recipe ${typeof a.recipe === "string" ? a.recipe : ""}`.trim();
		case "workbench_run_gate":
			return `workbench_run_gate ${typeof a.gates === "string" ? a.gates : ""}`.trim();
		case "workbench_read_run":
			return `workbench_read_run ${typeof a.run_id === "string" ? a.run_id : ""}`.trim();
		case "workbench_compare_runs":
			return `workbench_compare_runs ${typeof a.a === "string" ? a.a : ""} vs ${typeof a.b === "string" ? a.b : ""}`.trim();
		case "workbench_read_gate": {
			const target = typeof a.run_id === "string" ? a.run_id : typeof a.gate_id === "string" ? a.gate_id : "";
			return `workbench_read_gate ${target}`.trim();
		}
		default:
			return toolName;
	}
}

/** Partial/streaming progress line. */
export function renderPartialLine(toolName: string, phase?: string): string {
	return `${toolName} ${phase ?? "working..."}`;
}

/** Error line (tool threw or returned ok:false). */
export function renderErrorLine(toolName: string, message: string): string {
	return `${toolName}: ${message}`;
}

// ---------------------------------------------------------------------------
// Result renderers (compact default, expanded detail)
// ---------------------------------------------------------------------------

const fmtExit = (code: number | null | undefined): string => (code == null ? "killed" : String(code));
const fmtArtifacts = (paths: readonly string[] | undefined): string => (paths && paths.length > 0 ? paths.join(", ") : "(none)");
const fmtList = (items: readonly string[] | undefined): string => (items && items.length > 0 ? items.join(", ") : "(none)");
const fmtMs = (ms: number | undefined): string => (Number.isFinite(ms) ? `${ms} ms` : "n/a");
const fmtPath = (p: string | undefined): string => p ?? "(n/a)";

/** workbench_project_inspect */
export function renderInspectLines(d: InspectToolDetails, expanded: boolean): string[] {
	const compact = `profile:${d.profile ?? "not set"} recipes:${(d.recipes ?? []).length} errors:${(d.config_errors ?? []).length}`;
	if (!expanded) return [compact];
	return [
		compact,
		`project root : ${d.project_root}`,
		`stacks       : ${fmtList(d.stacks)}`,
		`config files : ${fmtList(d.config_files_present)}`,
		`config errors: ${fmtList(d.config_errors)}`,
		`recipes      : ${fmtList(d.recipes)}`,
		`git          : ${d.git && d.git.is_git ? `${d.git.branch ?? "(detached)"} @ ${d.git.commit?.slice(0, 12) ?? "(no commits)"}${d.git.dirty ? " (dirty)" : ""}` : "(not a git repo)"}`,
	];
}

/** workbench_run_recipe */
export function renderRecipeLines(d: RecipeToolDetails, expanded: boolean): string[] {
	const compact = `${d.status ?? "?"} run:${d.run_id ?? "?"} ${d.recipe ?? "?"} exit=${fmtExit(d.exit_code)} ${formatDuration(d.duration_ms)}`;
	if (!expanded) return [compact];
	return [
		compact,
		`recipe     : ${d.recipe ?? "?"}`,
		`duration   : ${formatDuration(d.duration_ms)} (${fmtMs(d.duration_ms)})`,
		`exit code  : ${fmtExit(d.exit_code)} (expected: ${(d.expected_exit_codes ?? []).join(", ") || "(none)"})`,
		`artifacts  : ${fmtArtifacts(d.artifact_paths)}`,
		`stdout log : ${fmtPath(d.stdout_log)}`,
		`stderr log : ${fmtPath(d.stderr_log)}`,
	];
}

/** workbench_run_gate */
export function renderGateLines(d: GateToolDetails, expanded: boolean): string[] {
	const gateSummary = (d.gates ?? []).map((g) => `${g.id}:${g.status}`).join(" ");
	const compact = `${d.status ?? "?"} run:${d.run_id ?? "?"} ${gateSummary}`;
	if (!expanded) return [compact];
	const lines = [compact, `requested   : ${fmtList(d.requested)}`, `profile     : ${d.profile ?? "(none)"}`];
	for (const g of d.gates ?? []) {
		const reason = g.failure_reason ?? g.blocked_reason ?? "";
		lines.push(`  ${g.id.padEnd(4)} ${g.status.padEnd(8)} ${g.title}${reason ? ` — ${reason}` : ""}`);
	}
	const failed = (d.gates ?? []).flatMap((g) => g.failed_checks ?? []);
	if (failed.length > 0) lines.push(`failed checks: ${failed.join(", ")}`);
	lines.push(`log path    : ${fmtPath(d.log_path)}`);
	return lines;
}

/** workbench_read_run */
export function renderReadRunLines(d: ReadRunToolDetails, expanded: boolean): string[] {
	const compact = `${(d.kind ?? "run").toUpperCase()} run:${d.run_id ?? "?"} ${d.recipe ?? "?"} ${d.status ?? "?"} exit=${fmtExit(d.exit_code)} ${formatDuration(d.duration_ms)}`;
	if (!expanded) return [compact];
	return [
		compact,
		`profile    : ${d.profile ?? "(none)"}`,
		`mode       : ${d.mode ?? "(n/a)"}`,
		`started    : ${d.started_at ?? "(n/a)"}`,
		`finished   : ${d.finished_at ?? "(n/a)"}`,
		`duration   : ${formatDuration(d.duration_ms)} (${fmtMs(d.duration_ms)})`,
		`exit code  : ${fmtExit(d.exit_code)}`,
		`status     : ${d.status ?? "?"}`,
		`git        : ${d.git_commit ? d.git_commit.slice(0, 12) : "(no git)"}${d.git_dirty ? " (dirty)" : ""}`,
		`artifacts  : ${fmtArtifacts(d.artifact_paths)}`,
		`stdout log : ${fmtPath(d.stdout_log)}`,
		`stderr log : ${fmtPath(d.stderr_log)}`,
	];
}

/** Count of changed quant metric slots (for the compact line). */
function quantChangedCount(quant: NonNullable<RunComparison["quant"]>): number {
	let n = 0;
	for (const slot of [quant.benchmark_delta, quant.return, quant.drawdown, quant.turnover]) {
		if (slot.changed) n++;
	}
	return n + quant.costs.length + quant.parameters.length;
}

/** workbench_compare_runs — full comparison display (also used by /q-compare). */
export function renderCompareLines(report: RunComparison, expanded: boolean, width?: number): string[] {
	const g = report.generic;
	const fit = (line: string): string => (width !== undefined ? fitToWidth(line, width) : line);

	const parts = [`exit ${fmtExit(g.exit_code.a)} -> ${fmtExit(g.exit_code.b)}`];
	parts.push(`${formatDuration(g.duration_ms.a)} -> ${formatDuration(g.duration_ms.b)}`);
	if (g.artifacts.added.length > 0 || g.artifacts.removed.length > 0) {
		parts.push(`artifacts +${g.artifacts.added.length}/-${g.artifacts.removed.length}`);
	}
	if (g.gate_delta) parts.push(`gates ${g.gate_delta.changed.length} changed`);
	if (report.quant) parts.push(`quant ${quantChangedCount(report.quant)} changed`);
	const compact = parts.join(" | ");
	if (!expanded) return [fit(compact)];

	const lines: string[] = [
		fit(compact),
		`run a      : ${report.a.run_id} (${report.a.recipe})`,
		`run b      : ${report.b.run_id} (${report.b.recipe})`,
		`compatible : ${report.compatible ? "yes" : "no — see notes"}`,
		`exit code  : ${fmtExit(g.exit_code.a)} -> ${fmtExit(g.exit_code.b)}`,
		`duration   : ${formatDuration(g.duration_ms.a)} -> ${formatDuration(g.duration_ms.b)}`,
	];
	const changes: string[] = [];
	if (g.artifacts.added.length > 0) changes.push(`+${g.artifacts.added.join(", ")}`);
	if (g.artifacts.removed.length > 0) changes.push(`-${g.artifacts.removed.join(", ")}`);
	lines.push(`artifacts  : ${changes.length > 0 ? changes.join(" ") : "(no changes)"} (common: ${fmtList(g.artifacts.common)})`);
	if (g.test_counts) {
		const tc = g.test_counts;
		const fmtCounts = (c: { passed: number; failed: number; blocked: number; not_run: number } | null): string =>
			c ? `${c.passed} passed / ${c.failed} failed / ${c.blocked} blocked / ${c.not_run} not_run` : "n/a";
		lines.push(`test counts: ${fmtCounts(tc.a)} -> ${fmtCounts(tc.b)}`);
	} else {
		lines.push("test counts: n/a (not recorded in run JSON for recipe runs)");
	}
	if (g.gate_delta) {
		lines.push("gate delta :");
		for (const change of g.gate_delta.changed) {
			lines.push(`  ${change.gate}: ${change.a} -> ${change.b}`);
		}
		if (g.gate_delta.changed.length === 0) lines.push("  (no gate status changed)");
	} else {
		lines.push("gate delta : n/a (neither run is a gate run)");
	}
	if (g.artifact_metrics.length > 0) {
		lines.push("artifact metrics:");
		for (const m of g.artifact_metrics) {
			lines.push(`  ${m.file}#${m.field}: ${formatDelta(m.a, m.b)}`);
		}
	}
	if (report.quant) {
		const q = report.quant;
		lines.push("quant metrics:");
		lines.push(`  return          : ${formatDelta(q.return.a ?? 0, q.return.b ?? 0)}`);
		lines.push(`  benchmark delta : ${formatDelta(q.benchmark_delta.a ?? 0, q.benchmark_delta.b ?? 0)}`);
		lines.push(`  drawdown        : ${formatDelta(q.drawdown.a ?? 0, q.drawdown.b ?? 0)}`);
		lines.push(`  turnover        : ${formatDelta(q.turnover.a ?? 0, q.turnover.b ?? 0)}`);
		for (const c of q.costs) {
			lines.push(`  costs.${c.field}    : ${formatDelta(c.a, c.b)}`);
		}
		const fmtFolds = (f: { passed: number; failed: number; skipped: number; pending: number } | null): string =>
			f ? `${f.passed} passed / ${f.failed} failed / ${f.skipped} skipped / ${f.pending} pending` : "n/a";
		lines.push(`  folds           : ${fmtFolds(q.folds.a)} -> ${fmtFolds(q.folds.b)}`);
		for (const p of q.parameters) {
			lines.push(`  parameter ${p.field}: ${JSON.stringify(p.a)} -> ${JSON.stringify(p.b)}`);
		}
		if (q.parameters.length === 0) lines.push("  parameters      : (no parameter changes)");
	}
	if (report.notes.length > 0) {
		lines.push("notes:");
		for (const note of report.notes) lines.push(`  - ${note}`);
		if (report.quant) lines.push(`  - ${QUANT_NEUTRALITY_NOTE}`);
	} else if (report.quant) {
		lines.push(`note: ${QUANT_NEUTRALITY_NOTE}`);
	}
	return lines.map(fit);
}

// ---------------------------------------------------------------------------
// Value formatting (shared with tests)
// ---------------------------------------------------------------------------

export { formatDelta, formatDuration, formatNumber };
