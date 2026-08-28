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
import { canonicalJsonWithin } from "./comparison-record.ts";
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
	/** Fixed machine failure code for a committed diagnostic run. */
	error?: string;
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
	/** WP4 DEV final-verification reuse; distinct from the action cache. */
	validation_reuse?: {
		status: "REUSED_CURRENT_CANDIDATE";
		source_run_id: string;
		validation_identity: string;
		execution_skipped: true;
	};
	ordinary_candidate?: {
		schema_version: 1;
		status: "VERIFIED";
		candidate_identity: string;
		validation_identity: string;
		source_run_id: string;
		authority_scope: "DEVELOPMENT_ONLY";
		gate_authority: false;
		research_authority: false;
		release_authority: false;
		profit_authority: false;
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
	command_effect_status?: string;
	command_effect_path?: string;
	command_effect_warning?: string;
	phase?: string;
}

export interface GateToolDetails {
	ok: boolean;
	status: string;
	run_id: string;
	requested: string[];
	profile: string | undefined;
	gates: {
		id: string;
		status: string;
		title: string;
		failure_reason: string | null;
		blocked_reason: string | null;
		failed_checks: string[];
		failed_check_count?: number;
		failed_checks_omitted?: number;
	}[];
	counts: {
		pass: number;
		fail: number;
		blocked: number;
		not_run: number;
		total?: number;
		shown?: number;
		omitted?: number;
	};
	log_path: string;
	phase?: string;
}

/** Session-safe exact-count list accepted alongside legacy arrays. */
export interface BoundedStringListDetails {
	items: string[];
	original_items: number;
	shown_items: number;
	omitted_items: number;
}

export type StringListDetails = string[] | BoundedStringListDetails;

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
	stacks: StringListDetails;
	profile: string | undefined;
	recipes: StringListDetails;
	/** Exact lookup result when workbench_project_inspect receives recipe. */
	recipe_query?: string;
	recipe_found?: boolean;
	/**
	 * Phase 2B: recipe name -> the recipe's exact declared validation
	 * components. The FULL deterministic map — every recipe is a key,
	 * explicit empty arrays included; absent only when the payload was not
	 * populated (renderer shows unavailable).
	 */
	recipe_validation_components?: Record<string, ValidationComponent[] | number>;
	config_errors: StringListDetails;
	config_files_present: StringListDetails;
}

export type CompareToolDetails =
	| {
		ok: true;
		comparison_id: string;
		a_run_id: string;
		b_run_id: string;
		compatible: boolean;
		artifact_added_count: number;
		artifact_removed_count: number;
		gate_changed_count: number;
		quant_changed_count: number;
		parameter_changed_count: number;
		comparison_path: string;
	}
	| { ok: false; error: string };

// ---------------------------------------------------------------------------
// Tool call header line (renderCall)
// ---------------------------------------------------------------------------

/** One-line summary of a tool call, e.g. `workbench_run_recipe "npm test"`. */
export function renderToolCallLine(toolName: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	switch (toolName) {
		case "workbench_run_recipe":
			return `workbench_run_recipe ${boundedBytes(typeof a.recipe === "string" ? a.recipe : "", 256)}`.trim();
		case "workbench_run_gate":
			return `workbench_run_gate ${boundedBytes(typeof a.gates === "string" ? a.gates : "", 256)}`.trim();
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
const INSPECT_RENDER_MAX_BYTES = 16_384;
const INSPECT_RENDER_MAX_LINES = 240;
const GATE_RENDER_MAX_BYTES = 16_384;
const GATE_RENDER_MAX_LINES = 240;

function listFacts(value: StringListDetails | undefined): { items: string[]; original: number; shown: number; omitted: number } {
	if (Array.isArray(value)) return { items: value.filter((item): item is string => typeof item === "string"), original: value.length, shown: value.length, omitted: 0 };
	if (!value || typeof value !== "object" || !Array.isArray(value.items)) return { items: [], original: 0, shown: 0, omitted: 0 };
	const items = value.items.filter((item): item is string => typeof item === "string");
	const original = Number.isSafeInteger(value.original_items) && value.original_items >= 0 ? value.original_items : items.length;
	const shown = Math.min(items.length, Number.isSafeInteger(value.shown_items) && value.shown_items >= 0 ? value.shown_items : items.length);
	const omitted = Math.max(0, Number.isSafeInteger(value.omitted_items) && value.omitted_items >= 0 ? value.omitted_items : original - shown);
	return { items: items.slice(0, shown), original, shown, omitted };
}

function boundedJoinedList(value: StringListDetails | undefined, itemBytes = 192): string {
	const facts = listFacts(value);
	const shown = facts.items.map((item) => boundedBytes(item, itemBytes)).join(", ");
	return `${shown || "(none)"}${facts.omitted > 0 ? ` (+${facts.omitted} omitted)` : ""}`;
}

function capRendererLines(lines: string[], maxBytes: number, maxLines: number): string[] {
	const normalized = lines.map((line) => boundedBytes(line, 1_024));
	if (normalized.length <= maxLines && utf8Bytes(normalized.join("\n")) <= maxBytes) return normalized;
	const maximum = Math.min(normalized.length, maxLines - 1);
	for (let keep = maximum; keep >= 0; keep -= 1) {
		const marker = `... ${normalized.length - keep} renderer line(s) omitted`;
		const candidate = [...normalized.slice(0, keep), marker];
		if (utf8Bytes(candidate.join("\n")) <= maxBytes) return candidate;
	}
	return ["bounded renderer unavailable"];
}

const fmtArtifacts = (paths: readonly string[] | undefined): string => boundedJoinedList(paths ? [...paths] : undefined, 256);
const fmtList = (items: StringListDetails | undefined): string => boundedJoinedList(items);
const fmtMs = (ms: number | undefined): string => (Number.isFinite(ms) ? `${ms} ms` : "n/a");
const fmtPath = (p: string | undefined): string => boundedBytes(p ?? "(n/a)", 512);

/** workbench_project_inspect */
export function renderInspectLines(d: InspectToolDetails, expanded: boolean): string[] {
	const recipes = listFacts(d.recipes);
	const errors = listFacts(d.config_errors);
	const compact = `profile:${boundedBytes(d.profile ?? "not set", 128)} recipes:${recipes.original} errors:${errors.original}`;
	if (!expanded) return [compact];
	// Phase 2B: deterministic per-recipe validation coverage in map order
	// (name-sorted — the tool builds the map from the config's name-sorted
	// recipe list, never YAML declaration order; component order within each
	// array stays exactly as declared). Missing map -> unavailable; an empty
	// map -> none declared.
	const vc: unknown = d.recipe_validation_components;
	const omittedValidationItems = typeof vc === "object" && vc !== null && !Array.isArray(vc)
		? (vc as Record<string, unknown>).__omitted_items__
		: undefined;
	const coverageLines =
		typeof vc !== "object" || vc === null || Array.isArray(vc)
			? ["validation coverage: (n/a)"]
			: Object.keys(vc).filter((key) => !key.startsWith("__")).length === 0
				? ["validation coverage: (none declared)"]
				: [
					...Object.entries(vc)
						.filter(([name, comps]) => !name.startsWith("__") && Array.isArray(comps))
						.map(([name, comps]) => `validation coverage: ${boundedBytes(name, 128)}=[${(comps as unknown[]).filter((item): item is string => typeof item === "string").map((item) => boundedBytes(item, 64)).join(", ")}]`),
					...(typeof omittedValidationItems === "number" && omittedValidationItems > 0
						? [`validation coverage: ... ${omittedValidationItems} recipe(s) omitted`]
						: []),
				];
	const stacks = listFacts(d.stacks);
	const configFiles = listFacts(d.config_files_present);
	const lines = [
		compact,
		`project root : ${boundedBytes(d.project_root, 512)}`,
		...(d.effective_project_root && d.effective_project_root !== d.project_root
			? [`effective root: ${boundedBytes(d.effective_project_root, 512)}`]
			: d.project_root
				? [`effective root: ${boundedBytes(d.project_root, 512)} (repository root)`]
				: []),
		`stacks (${stacks.original}; shown=${stacks.shown}; omitted=${stacks.omitted}):`,
		...stacks.items.map((item) => `  - ${boundedBytes(item, 256)}`),
		`config files (${configFiles.original}; shown=${configFiles.shown}; omitted=${configFiles.omitted}):`,
		...configFiles.items.map((item) => `  - ${boundedBytes(item, 256)}`),
		`config errors (${errors.original}; shown=${errors.shown}; omitted=${errors.omitted}):`,
		...(errors.items.length > 0 ? errors.items.map((item) => `  - ${boundedBytes(item, 512)}`) : ["  (none)"]),
		...(d.recipe_query === undefined ? [] : [`exact recipe: ${boundedBytes(d.recipe_query, 200)} found=${d.recipe_found === true ? "yes" : "no"}`]),
		`recipes (${recipes.original}; shown=${recipes.shown}; omitted=${recipes.omitted}):`,
		...(recipes.items.length > 0 ? recipes.items.map((item) => `  - ${boundedBytes(item, 256)}`) : ["  (none)"]),
		...coverageLines,
		`git          : ${d.git && d.git.is_git ? `${boundedBytes(d.git.branch ?? "(detached)", 128)} @ ${d.git.commit?.slice(0, 12) ?? "(no commits)"}${d.git.dirty ? " (dirty)" : ""}` : "(not a git repo)"}`,
	];
	return capRendererLines(lines, INSPECT_RENDER_MAX_BYTES, INSPECT_RENDER_MAX_LINES);
}

/** workbench_run_recipe */
export function renderRecipeLines(d: RecipeToolDetails, expanded: boolean): string[] {
	const compact = `${boundedBytes(d.status ?? "?", 64)} run:${boundedBytes(d.run_id ?? "?", 128)} ${boundedBytes(d.recipe ?? "?", 256)} exit=${fmtExit(d.exit_code)} ${formatDuration(d.duration_ms)}`;
	if (!expanded) return [compact];
	// Phase 2B: the two facts come from the run record ONLY — absent facts
	// render as unavailable, never as []/default (fails closed).
	const validationComponents = Array.isArray(d.validation_components)
		? d.validation_components.length > 0
			? d.validation_components.join(", ")
			: "(none declared)"
		: "(unavailable)";
	const cacheRequestMode = typeof d.cache_request_mode === "string" ? d.cache_request_mode : "(unavailable)";
	return capRendererLines([
		compact,
		`recipe     : ${boundedBytes(d.recipe ?? "?", 256)}`,
		`duration   : ${formatDuration(d.duration_ms)} (${fmtMs(d.duration_ms)})`,
		`exit code  : ${fmtExit(d.exit_code)} (expected: ${(d.expected_exit_codes ?? []).join(", ") || "(none)"})`,
		`validation : ${validationComponents}`,
		`cache mode : ${cacheRequestMode}`,
		...(d.validation_reuse === undefined ? [] : [
			`verify reuse: ${boundedBytes(d.validation_reuse.status, 64)}; execution=${d.validation_reuse.execution_skipped ? "SKIPPED" : "UNKNOWN"}; source=${boundedBytes(d.validation_reuse.source_run_id, 128)}; identity=${boundedBytes(d.validation_reuse.validation_identity, 64)}`,
		]),
		...(d.ordinary_candidate === undefined ? [] : [
			`candidate   : ${boundedBytes(d.ordinary_candidate.status, 32)} id=${boundedBytes(d.ordinary_candidate.candidate_identity, 64)} authority=${d.ordinary_candidate.authority_scope}; Gate/research/release/profit=NOT_GRANTED`,
		]),
		...(d.command_effect_status || d.command_effect_warning
			? [`cmd effect : ${boundedBytes(d.command_effect_status ?? "EVIDENCE_UNAVAILABLE", 128)}${d.command_effect_warning ? `; ${boundedBytes(d.command_effect_warning, 256)}` : ""}`]
			: []),
		...(d.command_effect_path ? [`effect file: ${fmtPath(d.command_effect_path)}`] : []),
		`artifacts  : ${fmtArtifacts(d.artifact_paths)}`,
		`stdout log : ${fmtPath(d.stdout_log)}`,
		`stderr log : ${fmtPath(d.stderr_log)}`,
	], INSPECT_RENDER_MAX_BYTES, INSPECT_RENDER_MAX_LINES);
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
	const allGates = Array.isArray(g.gates) ? g.gates : [];
	const gates = allGates.slice(0, 24);
	const gateSummary = gates.map((item) => `${boundedBytes(item.id, 96)}:${boundedBytes(item.status, 32)}`).join(" ");
	const declaredOmitted = Number.isSafeInteger(g.counts?.omitted) && (g.counts?.omitted ?? 0) > 0 ? g.counts!.omitted! : 0;
	const omitted = declaredOmitted + Math.max(0, allGates.length - gates.length);
	const compact = `${boundedBytes(g.status ?? "?", 64)} run:${boundedBytes(g.run_id ?? "?", 128)} ${gateSummary}${omitted > 0 ? ` (+${omitted} gates omitted)` : ""}`;
	if (!expanded) return capRendererLines([compact], GATE_RENDER_MAX_BYTES, GATE_RENDER_MAX_LINES);
	const total = Number.isSafeInteger(g.counts?.total) ? g.counts!.total! : allGates.length + declaredOmitted;
	const lines = [
		compact,
		`requested   : ${fmtList(g.requested)}`,
		`profile     : ${boundedBytes(g.profile ?? "(none)", 128)}`,
		`gate counts : total=${total} shown=${gates.length} omitted=${omitted} pass=${g.counts?.pass ?? 0} fail=${g.counts?.fail ?? 0} blocked=${g.counts?.blocked ?? 0} not_run=${g.counts?.not_run ?? 0}`,
	];
	for (const item of gates) {
		const reason = item.failure_reason ?? item.blocked_reason ?? "";
		lines.push(`  ${boundedBytes(item.id, 96).padEnd(4)} ${boundedBytes(item.status, 32).padEnd(8)} ${boundedBytes(item.title, 256)}${reason ? ` — ${boundedBytes(reason, 512)}` : ""}`);
	}
	const failed = gates.flatMap((item) => Array.isArray(item.failed_checks) ? item.failed_checks : []);
	const failedOmitted = gates.reduce((sum, item) => sum + (Number.isSafeInteger(item.failed_checks_omitted) ? item.failed_checks_omitted ?? 0 : 0), 0);
	if (failed.length > 0 || failedOmitted > 0) lines.push(`failed checks: ${failed.map((item) => boundedBytes(item, 128)).join(", ") || "(none shown)"}${failedOmitted > 0 ? ` (+${failedOmitted} omitted)` : ""}`);
	lines.push(`log path    : ${fmtPath(g.log_path)}`);
	return capRendererLines(lines, GATE_RENDER_MAX_BYTES, GATE_RENDER_MAX_LINES);
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

export const COMPARE_SUMMARY_MAX_BYTES = 32_768 as const;
export const COMPARE_SUMMARY_MAX_LINES = 400 as const;

const MAX_COMPARE_LIST_ITEMS = 8;
const MAX_COMPARE_GATE_ROWS = 24;
const MAX_COMPARE_COST_ROWS = 24;
const MAX_COMPARE_PARAMETER_ROWS = 16;
const MAX_COMPARE_NOTE_ROWS = 8;
const MAX_COMPARE_PATH_BYTES = 192;
const MAX_COMPARE_FIELD_BYTES = 128;
const MAX_COMPARE_NOTE_BYTES = 384;
const MAX_COMPARE_PARAMETER_JSON_BYTES = 256;

function compareInline(value: unknown, maxBytes: number): string {
	return boundedBytes(typeof value === "string" ? value : "(invalid)", maxBytes);
}

function compareList(items: readonly string[], label: string, fullPath: string | undefined): string {
	if (items.length === 0) return "(none)";
	const shown = items.slice(0, MAX_COMPARE_LIST_ITEMS).map((item) => compareInline(item, MAX_COMPARE_PATH_BYTES));
	const omitted = items.length - shown.length;
	return `${shown.join(", ")}${omitted > 0
		? ` (+${omitted} more ${label} omitted; full comparison: ${compareInline(fullPath ?? "(n/a)", MAX_COMPARE_PATH_BYTES)})`
		: ""}`;
}

function projectionType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function boundedParameterProjection(value: unknown, depth: number, active: WeakSet<object>): unknown {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : "n/a";
	if (typeof value === "string") {
		const shown = truncateUtf8Bytes(value, 128);
		if (!shown.truncated) return value;
		return {
			comparison_string_prefix: shown.text,
			original_bytes: utf8Bytes(value),
			shown_bytes: utf8Bytes(shown.text),
			omitted_bytes: utf8Bytes(value) - utf8Bytes(shown.text),
		};
	}
	if (typeof value !== "object" || value === null) return { comparison_value_omitted: true, type: projectionType(value) };
	if (active.has(value)) return { comparison_value_omitted: true, type: "circular" };
	if (depth >= 4) {
		return Array.isArray(value)
			? { comparison_value_omitted: true, type: "array", original_items: value.length }
			: { comparison_value_omitted: true, type: "object", original_keys: Object.keys(value).length };
	}
	active.add(value);
	try {
		if (Array.isArray(value)) {
			const shownCount = Math.min(value.length, 7);
			const output = value.slice(0, shownCount).map((item) => boundedParameterProjection(item, depth + 1, active));
			if (shownCount < value.length) {
				output.push({
					comparison_items_omitted: true,
					original_items: value.length,
					shown_items: shownCount,
					omitted_items: value.length - shownCount,
				});
			}
			return output;
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Object.keys(descriptors)
			.filter((key) => descriptors[key]?.enumerable === true)
			.sort();
		const shownKeys = keys.slice(0, 7);
		const entries = shownKeys.map((key) => {
			const descriptor = descriptors[key];
			return {
				key: compareInline(key, MAX_COMPARE_FIELD_BYTES),
				value: descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
					? boundedParameterProjection(descriptor.value, depth + 1, active)
					: { comparison_value_omitted: true, type: "accessor" },
			};
		});
		return {
			comparison_object_entries: entries,
			original_keys: keys.length,
			shown_keys: shownKeys.length,
			omitted_keys: keys.length - shownKeys.length,
		};
	} catch {
		return { comparison_value_omitted: true, type: "unavailable" };
	} finally {
		active.delete(value);
	}
}

function boundedParameterJson(value: unknown): string {
	const projected = boundedParameterProjection(value, 0, new WeakSet<object>());
	const encoded = canonicalJsonWithin(projected, MAX_COMPARE_PARAMETER_JSON_BYTES);
	if (encoded) return encoded.text;
	const fallback = canonicalJsonWithin({
		comparison_value_omitted: true,
		type: projectionType(value),
		...(Array.isArray(value) ? { original_items: value.length } : {}),
		...(value !== null && typeof value === "object" && !Array.isArray(value)
			? { original_keys: Object.keys(value).length }
			: {}),
	}, MAX_COMPARE_PARAMETER_JSON_BYTES);
	return fallback?.text ?? "{\"comparison_value_omitted\":true}";
}

function nullableDelta(a: number | null, b: number | null): string {
	if (a !== null && b !== null) return formatDelta(a, b);
	return `${a === null ? "n/a" : formatNumber(a)} -> ${b === null ? "n/a" : formatNumber(b)}`;
}

function capCompareSummary(lines: string[], fullPath: string | undefined): string[] {
	const joinedBytes = (value: readonly string[]): number => utf8Bytes(value.join("\n"));
	if (lines.length <= COMPARE_SUMMARY_MAX_LINES && joinedBytes(lines) <= COMPARE_SUMMARY_MAX_BYTES) return lines;
	const maxPrefix = Math.min(lines.length, COMPARE_SUMMARY_MAX_LINES - 1);
	for (let keep = maxPrefix; keep >= 0; keep -= 1) {
		const omitted = lines.length - keep;
		const marker = `... ${omitted} summary line(s) omitted; full comparison: ${compareInline(fullPath ?? "(n/a)", MAX_COMPARE_PATH_BYTES)}`;
		const candidate = [...lines.slice(0, keep), marker];
		if (joinedBytes(candidate) <= COMPARE_SUMMARY_MAX_BYTES) return candidate;
	}
	return ["comparison summary unavailable; use the persisted comparison artifact"];
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
		`run a      : ${compareInline(report.a.run_id, MAX_COMPARE_FIELD_BYTES)} (${compareInline(report.a.recipe, MAX_COMPARE_FIELD_BYTES)})`,
		`run b      : ${compareInline(report.b.run_id, MAX_COMPARE_FIELD_BYTES)} (${compareInline(report.b.recipe, MAX_COMPARE_FIELD_BYTES)})`,
		`compatible : ${report.compatible ? "yes" : "no — see notes"}`,
		`comparison : ${compareInline(report.comparison_id ?? "(n/a)", MAX_COMPARE_PATH_BYTES)}`,
		`full record: ${compareInline(report.comparison_path ?? "(n/a)", MAX_COMPARE_PATH_BYTES)}`,
		`exit code  : ${fmtExit(g.exit_code.a)} -> ${fmtExit(g.exit_code.b)}`,
		`duration   : ${formatDuration(g.duration_ms.a)} -> ${formatDuration(g.duration_ms.b)}`,
	];
	const changes: string[] = [];
	if (g.artifacts.added.length > 0) changes.push(`+${compareList(g.artifacts.added, "added artifact(s)", report.comparison_path)}`);
	if (g.artifacts.removed.length > 0) changes.push(`-${compareList(g.artifacts.removed, "removed artifact(s)", report.comparison_path)}`);
	lines.push(`artifacts  : ${changes.length > 0 ? changes.join(" ") : "(no changes)"} (common: ${compareList(g.artifacts.common, "common artifact(s)", report.comparison_path)})`);
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
		for (const change of g.gate_delta.changed.slice(0, MAX_COMPARE_GATE_ROWS)) {
			lines.push(`  ${compareInline(change.gate, MAX_COMPARE_FIELD_BYTES)}: ${change.a} -> ${change.b}`);
		}
		if (g.gate_delta.changed.length === 0) lines.push("  (no gate status changed)");
		if (g.gate_delta.changed.length > MAX_COMPARE_GATE_ROWS) {
			lines.push(`  ... ${g.gate_delta.changed.length - MAX_COMPARE_GATE_ROWS} more gate change(s) omitted; full comparison: ${compareInline(report.comparison_path ?? "(n/a)", MAX_COMPARE_PATH_BYTES)}`);
		}
	} else {
		lines.push("gate delta : n/a (neither run is a gate run)");
	}
	if (g.artifact_metrics.length > 0) {
		lines.push("artifact metrics:");
		for (const m of g.artifact_metrics) {
			lines.push(`  ${compareInline(m.file, MAX_COMPARE_PATH_BYTES)}#${compareInline(m.field, MAX_COMPARE_FIELD_BYTES)}: ${formatDelta(m.a, m.b)}`);
		}
	}
	if (report.quant) {
		const q = report.quant;
		lines.push("quant metrics:");
		lines.push(`  return          : ${nullableDelta(q.return.a, q.return.b)}`);
		lines.push(`  benchmark delta : ${nullableDelta(q.benchmark_delta.a, q.benchmark_delta.b)}`);
		lines.push(`  drawdown        : ${nullableDelta(q.drawdown.a, q.drawdown.b)}`);
		lines.push(`  turnover        : ${nullableDelta(q.turnover.a, q.turnover.b)}`);
		for (const c of q.costs.slice(0, MAX_COMPARE_COST_ROWS)) {
			lines.push(`  costs.${compareInline(c.field, MAX_COMPARE_FIELD_BYTES)}    : ${nullableDelta(c.a, c.b)}`);
		}
		if (q.costs.length > MAX_COMPARE_COST_ROWS) lines.push(`  ... ${q.costs.length - MAX_COMPARE_COST_ROWS} more cost change(s) omitted; full comparison: ${compareInline(report.comparison_path ?? "(n/a)", MAX_COMPARE_PATH_BYTES)}`);
		const fmtFolds = (f: { passed: number; failed: number; skipped: number; pending: number } | null): string =>
			f ? `${f.passed} passed / ${f.failed} failed / ${f.skipped} skipped / ${f.pending} pending` : "n/a";
		lines.push(`  folds           : ${fmtFolds(q.folds.a)} -> ${fmtFolds(q.folds.b)}`);
		for (const p of q.parameters.slice(0, MAX_COMPARE_PARAMETER_ROWS)) {
			lines.push(`  parameter ${compareInline(p.field, MAX_COMPARE_FIELD_BYTES)}: ${boundedParameterJson(p.a)} -> ${boundedParameterJson(p.b)}`);
		}
		if (q.parameters.length === 0) lines.push("  parameters      : (no parameter changes)");
		if (q.parameters.length > MAX_COMPARE_PARAMETER_ROWS) lines.push(`  ... ${q.parameters.length - MAX_COMPARE_PARAMETER_ROWS} more parameter change(s) omitted; full comparison: ${compareInline(report.comparison_path ?? "(n/a)", MAX_COMPARE_PATH_BYTES)}`);
	}
	if (report.notes.length > 0) {
		lines.push("notes:");
		for (const note of report.notes.slice(0, MAX_COMPARE_NOTE_ROWS)) lines.push(`  - ${compareInline(note, MAX_COMPARE_NOTE_BYTES)}`);
		if (report.notes.length > MAX_COMPARE_NOTE_ROWS) lines.push(`  - ... ${report.notes.length - MAX_COMPARE_NOTE_ROWS} more note(s) omitted; full comparison: ${compareInline(report.comparison_path ?? "(n/a)", MAX_COMPARE_PATH_BYTES)}`);
		if (report.quant) lines.push(`  - ${QUANT_NEUTRALITY_NOTE}`);
	} else if (report.quant) {
		lines.push(`note: ${QUANT_NEUTRALITY_NOTE}`);
	}
	return capCompareSummary(lines, report.comparison_path).map(fit);
}

// ---------------------------------------------------------------------------
// Value formatting (shared with tests)
// ---------------------------------------------------------------------------

export { formatDelta, formatDuration, formatNumber };
