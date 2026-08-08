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
import { truncateUtf8Bytes, utf8Bytes } from "./result-summary.ts";
import type { ValidationComponent } from "./recipe-schema.ts";
import type { CacheRequestMode } from "../cache/action-types.ts";
import {
	isValidationRefusalReason,
	type ValidationRefusalReason,
} from "./validation-evidence.ts";

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
	/**
	 * Phase 2B: the recipe's exact declared validation components. Copied by
	 * the tool ONLY from the persisted/returned run record — absent when no
	 * record exists, so the renderer fails closed as unavailable and never
	 * infers the recipe declaration.
	 */
	validation_components?: ValidationComponent[];
	/**
	 * Phase 2B: the run's cache request mode. Copied by the tool ONLY from
	 * the persisted/returned run record — absent when no record exists, so
	 * the renderer fails closed as unavailable and never infers "default".
	 */
	cache_request_mode?: CacheRequestMode;
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

/**
 * Phase 3B: read-only preflight payload — deliberately SEPARATE from
 * GateToolDetails. It carries NO ok/status/run_id/gates and NO raw manual
 * evidence notes: the readiness flag, the exact provided/missing required
 * manual check ids and the explicit zero facts (no run created, zero
 * recipes executed, no gate status assigned) are the whole payload.
 */
export interface GatePreflightToolDetails {
	/** Exact literal true — the renderer dispatches on this and nothing else. */
	preflight: true;
	/** The selector exactly as passed. */
	selector: string;
	/** Selector-expanded requested gate ids. */
	requested: string[];
	profile: string | undefined;
	/** True iff every required manual check of the requested gates is provided. */
	manual_evidence_ready: boolean;
	/** Required manual checks (gate_id/check_id/prompt/provided) — never notes. */
	required_manual_checks: { gate_id: string; check_id: string; prompt: string | undefined; provided: boolean }[];
	/** Required manual check ids the caller's evidence satisfies. */
	provided_manual_evidence: string[];
	/** Required manual check ids with no satisfying evidence. */
	missing_manual_evidence: string[];
	/** Exact literal zero facts — preflight never creates a run/recipe/status. */
	gate_run_created: false;
	recipes_executed: 0;
	gate_status_assigned: false;
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
	/**
	 * P4b additive current-state validation verdict (status + fixed reason
	 * codes). Observation only — never claims acceptance and never skips
	 * recipe/gate execution. The renderer boundary fails closed: only the
	 * exact status/reasons consistency documented on `readRunValidation` is
	 * accepted, and every reason must be a canonical fixed refusal code from
	 * the single VALIDATION_REFUSAL_REASONS allowlist in
	 * core/validation-evidence.ts.
	 */
	validation?: { status: "REUSABLE" | "RERUN_REQUIRED"; reasons: ValidationRefusalReason[] };
}

export interface InspectToolDetails {
	project_root: string;
	/** P8: safe effective project root (project.yaml project_dir; repo root by default). */
	effective_project_root?: string;
	git: { is_git: boolean; commit: string | null; dirty: boolean; branch: string | null };
	stacks: string[];
	profile: string | undefined;
	recipes: string[];
	/**
	 * Phase 2B: recipe name -> the recipe's exact declared validation
	 * components. The FULL deterministic map — every recipe is a key,
	 * explicit empty arrays included; absent only when the payload was not
	 * populated (renderer shows unavailable).
	 */
	recipe_validation_components?: Record<string, ValidationComponent[]>;
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
	// Phase 2B: deterministic per-recipe validation coverage in map order
	// (name-sorted — the tool builds the map from the config's name-sorted
	// recipe list, never YAML declaration order; component order within each
	// array stays exactly as declared). Missing map -> unavailable; an empty
	// map -> none declared.
	const vc: unknown = d.recipe_validation_components;
	const coverageLines =
		typeof vc !== "object" || vc === null || Array.isArray(vc)
			? ["validation coverage: (n/a)"]
			: Object.keys(vc).length === 0
				? ["validation coverage: (none declared)"]
				: Object.entries(vc).map(([name, comps]) => `validation coverage: ${name}=[${(Array.isArray(comps) ? comps : []).join(", ")}]`);
	return [
		compact,
		`project root : ${d.project_root}`,
		...(d.effective_project_root && d.effective_project_root !== d.project_root
			? [`effective root: ${d.effective_project_root}`]
			: d.project_root
				? [`effective root: ${d.project_root} (repository root)`]
				: []),
		`stacks       : ${fmtList(d.stacks)}`,
		`config files : ${fmtList(d.config_files_present)}`,
		`config errors: ${fmtList(d.config_errors)}`,
		`recipes      : ${fmtList(d.recipes)}`,
		...coverageLines,
		`git          : ${d.git && d.git.is_git ? `${d.git.branch ?? "(detached)"} @ ${d.git.commit?.slice(0, 12) ?? "(no commits)"}${d.git.dirty ? " (dirty)" : ""}` : "(not a git repo)"}`,
	];
}

/** workbench_run_recipe */
export function renderRecipeLines(d: RecipeToolDetails, expanded: boolean): string[] {
	const compact = `${d.status ?? "?"} run:${d.run_id ?? "?"} ${d.recipe ?? "?"} exit=${fmtExit(d.exit_code)} ${formatDuration(d.duration_ms)}`;
	if (!expanded) return [compact];
	// Phase 2B: the two facts come from the run record ONLY — absent facts
	// render as unavailable, never as []/default (fails closed).
	const validationComponents = Array.isArray(d.validation_components)
		? d.validation_components.length > 0
			? d.validation_components.join(", ")
			: "(none declared)"
		: "(unavailable)";
	const cacheRequestMode = typeof d.cache_request_mode === "string" ? d.cache_request_mode : "(unavailable)";
	return [
		compact,
		`recipe     : ${d.recipe ?? "?"}`,
		`duration   : ${formatDuration(d.duration_ms)} (${fmtMs(d.duration_ms)})`,
		`exit code  : ${fmtExit(d.exit_code)} (expected: ${(d.expected_exit_codes ?? []).join(", ") || "(none)"})`,
		`validation : ${validationComponents}`,
		`cache mode : ${cacheRequestMode}`,
		`artifacts  : ${fmtArtifacts(d.artifact_paths)}`,
		`stdout log : ${fmtPath(d.stdout_log)}`,
		`stderr log : ${fmtPath(d.stderr_log)}`,
	];
}

/** workbench_run_gate */
export function renderGateLines(d: GateToolDetails | GatePreflightToolDetails, expanded: boolean): string[] {
	// Phase 3B: only the EXACT literal true dispatches to the read-only
	// preflight renderer — anything absent/foreign stays on the formal path
	// below, which remains byte-identical to the pre-Phase 3B output.
	if ((d as GatePreflightToolDetails).preflight === true) {
		return renderGatePreflightLines(d as GatePreflightToolDetails, expanded);
	}
	const g = d as GateToolDetails;
	const gateSummary = (g.gates ?? []).map((item) => `${item.id}:${item.status}`).join(" ");
	const compact = `${g.status ?? "?"} run:${g.run_id ?? "?"} ${gateSummary}`;
	if (!expanded) return [compact];
	const lines = [compact, `requested   : ${fmtList(g.requested)}`, `profile     : ${g.profile ?? "(none)"}`];
	for (const item of g.gates ?? []) {
		const reason = item.failure_reason ?? item.blocked_reason ?? "";
		lines.push(`  ${item.id.padEnd(4)} ${item.status.padEnd(8)} ${item.title}${reason ? ` — ${reason}` : ""}`);
	}
	const failed = (g.gates ?? []).flatMap((item) => item.failed_checks ?? []);
	if (failed.length > 0) lines.push(`failed checks: ${failed.join(", ")}`);
	lines.push(`log path    : ${fmtPath(g.log_path)}`);
	return lines;
}

// ---------------------------------------------------------------------------
// Phase 3B: read-only preflight renderer (workbench_run_gate preflight:true,
// /q-gate --preflight) — bounded/defensive, never a formal gate rendering.
// ---------------------------------------------------------------------------

// Defensive policy (same UTF-8 primitives as core/result-summary.ts /
// core/run-result.ts): every untrusted display field is control-sanitized
// and UTF-8 byte bounded (boundedBytes); every id list is bounded with an
// EXACT omitted count (joinBounded semantics); the check-row cap is small
// enough that the WHOLE expanded output stays inside the documented
// preflight caps (4096 UTF-8 bytes / 40 lines) even when every field is an
// adversarial payload. Raw evidence notes are impossible: the payload
// carries declared manual prompts and check ids only, and the renderer
// renders exactly those fields — never a note.
// ---------------------------------------------------------------------------

/** Cap for the selector on the compact preflight line. */
const MAX_PREFLIGHT_SELECTOR_BYTES = 100;
/** Cap for the profile field. */
const MAX_PREFLIGHT_PROFILE_BYTES = 64;
/** Per-id cap inside the requested/provided/missing id lists. */
const MAX_PREFLIGHT_ID_BYTES = 60;
/** Max ids shown per id-list line (dropped ids get an exact count). */
const MAX_PREFLIGHT_IDS = 8;
/** Whole-line byte cap for each id list, omission suffix included. */
const MAX_PREFLIGHT_LIST_BYTES = 480;
/** Cap for a rendered gate id in a required-manual-checks row. */
const MAX_PREFLIGHT_GATE_ID_BYTES = 20;
/** Cap for a rendered check id in a required-manual-checks row. */
const MAX_PREFLIGHT_CHECK_ID_BYTES = 32;
/** Cap for a rendered manual-check prompt (never a raw evidence note). */
const MAX_PREFLIGHT_PROMPT_BYTES = 100;
/**
 * Max required-manual-checks rows. 8 rows keeps the WHOLE expanded output at
 * <= 40 lines (10 structural lines + 8 rows + the omission marker) and, with
 * the per-field byte caps above, at <= 4096 UTF-8 bytes for ANY payload
 * (worst case ~3.2 KB: compact + 3 bounded id lists + 8 bounded rows + the
 * zero-facts line).
 */
const MAX_PREFLIGHT_CHECK_ROWS = 8;

const PREFLIGHT_CONTROL_RE = /[\x00-\x1f\x7f]/g;

/** Sanitize an untrusted display field: control chars -> single space. */
function preflightInline(text: unknown): string {
	if (typeof text !== "string") return "(invalid)";
	return text.replace(PREFLIGHT_CONTROL_RE, " ");
}

/**
 * Bound an untrusted display field to `maxBytes` UTF-8 bytes, code-point
 * safe, with an explicit "…" marker when truncated (mirrors the boundedBytes
 * helpers in core/result-summary.ts / core/run-result.ts).
 */
function boundedBytes(text: unknown, maxBytes: number): string {
	const cleaned = preflightInline(text);
	const cut = truncateUtf8Bytes(cleaned, maxBytes);
	if (!cut.truncated) return cleaned;
	if (maxBytes < 3) return cut.text;
	return `${truncateUtf8Bytes(cleaned, maxBytes - 3).text}…`;
}

/**
 * Join display ids into ONE inline line bounded to `maxBytes` bytes: at most
 * `maxItems` items (each bounded to `itemMaxBytes`); dropped ids are
 * accounted with an EXACT "(+N more ... omitted)" suffix that always
 * survives (mirrors the joinBounded helpers in core/result-summary.ts /
 * core/run-result.ts). Non-array payloads render as n/a.
 */
function preflightIdList(items: unknown, moreLabel: string, moreWhere: string): string {
	if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) return "(n/a)";
	if (items.length === 0) return "(none)";
	const boundedItems = items.slice(0, MAX_PREFLIGHT_IDS).map((item) => boundedBytes(item, MAX_PREFLIGHT_ID_BYTES));
	let shown = boundedItems.length;
	for (;;) {
		let line = boundedItems.slice(0, shown).join(", ");
		if (items.length > shown) line += ` (+${items.length - shown} more ${moreLabel} omitted — ${moreWhere})`;
		if (utf8Bytes(line) <= MAX_PREFLIGHT_LIST_BYTES || shown === 0) return line;
		shown--;
	}
}

/**
 * One bounded required-manual-checks row: gate_id/check_id/prompt are
 * control-sanitized and byte capped; `provided` renders as an explicit
 * yes/no fact. Prompts are the DECLARED manual_prompt — raw evidence notes
 * never exist in the payload and can never reach this row.
 */
function preflightCheckRow(check: unknown): string {
	const row = (check ?? {}) as { gate_id?: unknown; check_id?: unknown; prompt?: unknown; provided?: unknown };
	const gateId = boundedBytes(typeof row.gate_id === "string" ? row.gate_id : "?", MAX_PREFLIGHT_GATE_ID_BYTES);
	const checkId = boundedBytes(typeof row.check_id === "string" ? row.check_id : "?", MAX_PREFLIGHT_CHECK_ID_BYTES);
	const prompt = boundedBytes(typeof row.prompt === "string" ? row.prompt : "(no prompt)", MAX_PREFLIGHT_PROMPT_BYTES);
	return `  ${gateId.padEnd(4)} ${checkId.padEnd(8)} provided:${row.provided === true ? "yes" : "no"} — ${prompt}`;
}

/**
 * Bounded/defensive read-only preflight lines: selector, requested ids,
 * profile, readiness, exact provided/missing required manual check ids, the
 * required manual checks (gate_id/check_id/prompt/provided — prompts capped,
 * raw evidence notes never rendered) and the explicit zero facts. Never
 * renders ok/status/run_id/gates. The whole expanded output is <= 4096
 * UTF-8 bytes and <= 40 lines for ANY payload.
 */
export function renderGatePreflightLines(d: GatePreflightToolDetails, expanded: boolean): string[] {
	const missing = Array.isArray(d.missing_manual_evidence) ? d.missing_manual_evidence : [];
	const ready = d.manual_evidence_ready === true ? "yes" : "no";
	const compact = `preflight ${boundedBytes(typeof d.selector === "string" ? d.selector : "?", MAX_PREFLIGHT_SELECTOR_BYTES)} ready=${ready} missing=${missing.length}`;
	if (!expanded) return [compact];
	const checks = Array.isArray(d.required_manual_checks) ? d.required_manual_checks : [];
	const lines = [
		compact,
		`requested   : ${preflightIdList(d.requested, "requested id(s)", "full list in the preflight details")}`,
		`profile     : ${typeof d.profile === "string" ? boundedBytes(d.profile, MAX_PREFLIGHT_PROFILE_BYTES) : "(none)"}`,
		`ready       : ${ready}`,
		`provided    : ${preflightIdList(d.provided_manual_evidence, "provided id(s)", "full list in the preflight details")}`,
		`missing     : ${preflightIdList(d.missing_manual_evidence, "missing id(s)", "full list in the preflight details")}`,
		"required manual checks:",
	];
	if (checks.length === 0) {
		lines.push("  (none)");
	} else {
		for (const check of checks.slice(0, MAX_PREFLIGHT_CHECK_ROWS)) lines.push(preflightCheckRow(check));
		if (checks.length > MAX_PREFLIGHT_CHECK_ROWS) lines.push(`  ... ${checks.length - MAX_PREFLIGHT_CHECK_ROWS} more`);
	}
	lines.push("no run created; 0 recipes executed; no gate status assigned");
	return lines;
}

/** workbench_read_run */
const MAX_VALIDATION_DISPLAY_CHARS = 160;

/**
 * P4b: bounded validation segment from the structured details. FAILS
 * CLOSED at the renderer boundary — a payload is accepted ONLY when it is
 * internally consistent:
 *   - exact status REUSABLE with an actually-empty reasons array; or
 *   - exact status RERUN_REQUIRED with a non-empty reasons array in which
 *     EVERY entry is a canonical fixed refusal code (exact membership in
 *     the single VALIDATION_REFUSAL_REASONS allowlist — the set is never
 *     duplicated here, and a reason can never carry prose, newlines,
 *     control characters or secret-like text).
 * Anything absent, contradictory, unknown, non-array, non-string,
 * control-containing or otherwise malformed renders as unavailable: the
 * compact line omits the validation segment and the expanded view shows
 * `(n/a)` — a malformed payload never fabricates a verdict.
 */
function readRunValidation(d: ReadRunToolDetails): { status: "REUSABLE" | "RERUN_REQUIRED"; reasons: ValidationRefusalReason[] } | null {
	const v: unknown = d.validation;
	// Absent or non-object payloads (including arrays) are unavailable.
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const record = v as Record<string, unknown>;
	// Exact verdict tokens only — casing/whitespace/foreign statuses never match.
	if (record.status !== "REUSABLE" && record.status !== "RERUN_REQUIRED") return null;
	// reasons must be an ACTUAL array...
	const rawReasons: unknown = record.reasons;
	if (!Array.isArray(rawReasons)) return null;
	// ...of canonical fixed refusal codes ONLY. Exact membership means a
	// non-string, unknown, control-containing or secret-like entry voids the
	// WHOLE payload — nothing is filtered or partially rendered.
	if (!rawReasons.every(isValidationRefusalReason)) return null;
	// Internal consistency: REUSABLE is reason-less; RERUN_REQUIRED is never empty.
	if (record.status === "REUSABLE" && rawReasons.length !== 0) return null;
	if (record.status === "RERUN_REQUIRED" && rawReasons.length === 0) return null;
	return { status: record.status, reasons: rawReasons as ValidationRefusalReason[] };
}

export function renderReadRunLines(d: ReadRunToolDetails, expanded: boolean): string[] {
	const validation = readRunValidation(d);
	const compact = `${(d.kind ?? "run").toUpperCase()} run:${d.run_id ?? "?"} ${d.recipe ?? "?"} ${d.status ?? "?"} exit=${fmtExit(d.exit_code)} ${formatDuration(d.duration_ms)}${validation ? ` validation=${validation.status}` : ""}`;
	if (!expanded) return [compact];
	const validationLine = validation
		? `validation : ${validation.status}${validation.reasons.length > 0 ? ` — ${validation.reasons.join(", ").slice(0, MAX_VALIDATION_DISPLAY_CHARS)}` : ""}`
		: "validation : (n/a)";
	return [
		compact,
		`profile    : ${d.profile ?? "(none)"}`,
		`mode       : ${d.mode ?? "(n/a)"}`,
		`started    : ${d.started_at ?? "(n/a)"}`,
		`finished   : ${d.finished_at ?? "(n/a)"}`,
		`duration   : ${formatDuration(d.duration_ms)} (${fmtMs(d.duration_ms)})`,
		`exit code  : ${fmtExit(d.exit_code)}`,
		`status     : ${d.status ?? "?"}`,
		validationLine,
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
