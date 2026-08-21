/**
 * P6-B Workbench tool catalog — the single source of truth for the static
 * metadata of every workbench custom tool.
 *
 * Stable-prefix contract (docs/cache/stable-prefix-contract.md):
 *   - `WORKBENCH_TOOL_NAMES` is the EXPLICIT registration-order constant.
 *     The extension registers tools in exactly this order (asserted by
 *     tests/p6-b-stable-prefix.test.ts against extensions/.../index.ts).
 *   - name / label / description / promptSnippet / promptGuidelines are
 *     static at runtime: no cwd, no date, no mode, no project path, no
 *     run/task/gate id ever appears in them (audited by tests via
 *     stable-prefix.staticToolMetadataIssues).
 *   - parameter JSON schemas (WORKBENCH_TOOL_PARAMETERS) are constructed in
 *     source order (typebox preserves key insertion order), so
 *     `canonicalHash(parameters)` is stable across runs and installs.
 *
 * The catalog is pure (only typebox) so tests can hash the metadata without
 * a Pi runtime. The extension's registerTool calls spread these definitions
 * and attach their `execute` implementations.
 */

import { Type } from "typebox";

/**
 * Explicit registration order of the workbench custom tools (P6-B). The
 * `as const` tuple keeps the literal union so index access stays precise.
 */
export const WORKBENCH_TOOL_NAMES = [
	"workbench_project_inspect",
	"workbench_run_recipe",
	"workbench_read_run",
	"workbench_run_gate",
	"workbench_read_gate",
	"workbench_list_gates",
	"workbench_compare_runs",
	// P7: the three delegation tools follow the seven existing tools in the
	// exact strict-Sol order (workbench_delegate_worker →
	// workbench_review_worker_diff → workbench_delegation_status), matching
	// STRICT_SOL_DEV_ALLOWLIST (core/write-authority.ts).
	"workbench_delegate_worker",
	"workbench_review_worker_diff",
	"workbench_delegation_status",
	// P8b: the public read-only tool-result recovery tool is appended LAST
	// (intentional one-tool fingerprint transition — see
	// docs/cache/stable-prefix-contract.md). It never starts a receipt for
	// itself and is excluded from the begin step of the receipt lifecycle.
	"workbench_recover_tool_result",
] as const;

/** P8b: the public read-only tool-result recovery tool (appended LAST). */
export const RECOVERY_TOOL_NAME = "workbench_recover_tool_result";

/**
 * Read-only or idempotent-observation tools whose replay cannot duplicate an
 * external action. They deliberately bypass the two-phase result receipt;
 * current-state reads must stay current instead of being replay-blocked.
 */
export const WORKBENCH_RECEIPT_FREE_TOOL_NAMES = [
	"workbench_project_inspect",
	"workbench_read_run",
	"workbench_read_gate",
	"workbench_list_gates",
	"workbench_compare_runs",
	"workbench_delegation_status",
	RECOVERY_TOOL_NAME,
] as const;

const WORKBENCH_RECEIPT_FREE_TOOLS: ReadonlySet<string> = new Set(WORKBENCH_RECEIPT_FREE_TOOL_NAMES);

/** Unknown/native tools are outside this receipt lifecycle. */
export function workbenchToolRequiresReceipt(name: string): boolean {
	return isWorkbenchToolName(name) && !WORKBENCH_RECEIPT_FREE_TOOLS.has(name);
}

export interface WorkbenchToolMeta {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
}

/**
 * Frozen governance-v1 input properties for workbench_delegate_worker.
 *
 * Keep this source-ordered object as the single definition of the v1 shape:
 * the current schema may evolve only by appending additive optional fields.
 */
const WORKBENCH_DELEGATE_WORKER_V1_PROPERTIES = {
	task: Type.String({ description: "Bounded implementation task already planned by the Sol commander", minLength: 1, maxLength: 10000 }),
	allowed_paths: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
		description: "Parent-approved project-relative paths. Exact paths allow one file; paths ending in / or /** allow a subtree.",
		minItems: 1,
		maxItems: 50,
	}),
	acceptance_criteria: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
		description: "Observable acceptance criteria the worker must implement but cannot finally approve",
		minItems: 1,
		maxItems: 20,
	}),
	verification: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
		description: "Declared recipes or checks requested from the worker; final gates remain commander-only",
		maxItems: 20,
	})),
	timeout_seconds: Type.Optional(Type.Integer({ description: "Worker timeout in seconds (default 1800)", minimum: 60, maximum: 3600 })),
	budget_profile: Type.Optional(
		Type.Union([Type.Literal("low"), Type.Literal("standard"), Type.Literal("extended")], {
			description:
				"Cumulative delegation-spend budget profile (default: standard). low = 8/750,000/40,000 soft, 12/1,250,000/75,000 hard; standard = 24/3,000,000/120,000 soft, 36/5,000,000/200,000 hard; extended = 48/8,000,000/200,000 soft, 64/12,000,000/300,000 hard (turns / total tokens / output tokens). extended is an explicit opt-in and is never inferred.",
			default: "standard",
		}),
	),
	repair_of: Type.Optional(
		Type.String({
			minLength: 20,
			maxLength: 20,
			pattern: "^\\d{8}-\\d{6}-[A-Za-z0-9]{4}$",
			description:
				"strict prior delegation-id provenance for a known-root-cause repair; parent task must include bounded root cause/failure evidence; pointer adds no path/scope/authority and never resumes/imports old report",
		}),
	),
} as const;

/** Current Luna-xhigh profile description; the frozen v1 schema above stays byte-stable. */
const WORKBENCH_DELEGATE_WORKER_CURRENT_BUDGET_PROFILE = Type.Optional(
	Type.Union([Type.Literal("standard"), Type.Literal("extended")], {
		description:
			"Luna xhigh cumulative spend profile. standard: soft at 32 turns / 5,440,000 total / 160,000 output; advisory turn marker 64, hard total 10,880,000, hard output 320,000. extended: soft at 64 turns / 10,880,000 total / 320,000 output; advisory turn marker 96, hard total 17,408,000, hard output 512,000. Soft steer asks for a coherent handoff in the current Sol session. A turn marker remains observable but never kills healthy tool-heavy work by itself; total/output limits, per-message context, timeout, compaction rejection, and identity checks remain fail-closed. extended is the safe default; standard is explicit for clearly bounded slices. The retired low literal is rejected for new delegations.",
		default: "extended",
	}),
);

/** Exact governance-v1 delegate input schema retained for characterization. */
export const WORKBENCH_DELEGATE_WORKER_V1_PARAMETERS = Type.Object(WORKBENCH_DELEGATE_WORKER_V1_PROPERTIES);

/**
 * Parameter schemas, keyed by tool name. `as const` preserves the exact
 * typebox types so the extension's registerTool calls infer the params type
 * for their execute handlers. Key order here is source order (stable).
 */
export const WORKBENCH_TOOL_PARAMETERS = {
	workbench_project_inspect: Type.Object({}),
	workbench_run_recipe: Type.Object({
		recipe: Type.String({ description: "Name of a declared recipe in .pi/workbench/recipes.yaml" }),
		params: Type.Optional(
			Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
				description: "Recipe parameters declared in the recipe schema (substituted into argv placeholders)",
			}),
		),
		cache: Type.Optional(
			Type.Union([Type.Literal("default"), Type.Literal("no-cache"), Type.Literal("refresh-cache")], {
				description: "P6-C action-cache mode: default (read/write per the recipe's cache policy), no-cache (execute, never read or write), refresh-cache (execute and (re)write)",
			}),
		),
	}),
	workbench_read_run: Type.Object({
		run_id: Type.String({ description: "Run id, e.g. 20260101-120000-abcd" }),
		include: Type.Optional(
			Type.Union([Type.Literal("summary"), Type.Literal("manifest"), Type.Literal("logs"), Type.Literal("all")], {
				description: "What to include (default: summary)",
			}),
		),
		log_stream: Type.Optional(
			Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("both")], {
				description: "Log stream selection for logs/all (default: both)",
			}),
		),
		cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024, description: "Opaque previous-page cursor returned by logs/all" })),
		max_lines: Type.Optional(Type.Integer({ description: "Shared whole-result line cap for logs/all (default 200)", minimum: 1, maximum: 400 })),
		max_bytes: Type.Optional(Type.Integer({ description: "Shared whole-result byte cap for logs/all (default 20KB)", minimum: 1024, maximum: 32768 })),
	}),
	workbench_run_gate: Type.Object({
		gates: Type.String({ description: "Gate selector: a gate id (e.g. \"b0\"), comma-separated ids, or base|quant|all" }),
		manual_evidence: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Manual evidence notes keyed by check id — recorded as manual evidence, never as machine verification",
			}),
		),
		// Phase 3B: explicit read-only preflight opt-in on the EXISTING tool.
		// true runs ONLY preflightGateManualEvidence (same selector/evidence
		// resolution semantics, zero writes) and returns the preflight
		// details — never a formal run, never a Gate status/run id. Omitted
		// or false keeps the formal gate run exactly as before.
		preflight: Type.Optional(
			Type.Boolean({
				description:
					"Read-only preflight: resolve the selector and report exactly which required manual checks the supplied manual_evidence satisfies (provided/missing ids, readiness) with NO gate run, NO recipe execution, NO gate status assignment and NO run id. Omitted or false runs the gate formally.",
			}),
		),
	}),
	workbench_read_gate: Type.Object({
		run_id: Type.Optional(Type.String({ description: "Run id of a gate run (e.g. 20260101-120000-abcd)" })),
		gate_id: Type.Optional(Type.String({ description: "Gate id (e.g. b0, q3)" })),
		include: Type.Optional(
			Type.Union([Type.Literal("summary"), Type.Literal("failures"), Type.Literal("checks")], {
				description: "Bounded view (default failures: summary plus non-PASS rows; checks pages every check)",
			}),
		),
		cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024, description: "Opaque stale-safe gate-read continuation cursor" })),
		max_lines: Type.Optional(Type.Integer({ description: "Whole-result line cap (default/max 320)", minimum: 1, maximum: 320 })),
	}),
	workbench_list_gates: Type.Object({}),
	workbench_compare_runs: Type.Object({
		a: Type.String({ description: "First run id, e.g. 20260101-120000-abcd" }),
		b: Type.String({ description: "Second run id, e.g. 20260102-120000-efgh" }),
	}),
	workbench_review_worker_diff: Type.Object({
		delegation_id: Type.String({ description: "Delegation id, e.g. 20260101-120000-abcd" }),
		include_paths: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
				description: "Only these worker paths get patch content; scope checks always cover the entire worker diff and include_paths can never hide a violation",
				maxItems: 50,
			}),
		),
		max_lines: Type.Optional(Type.Integer({ description: "Whole-result line cap (default/max 400)", minimum: 1, maximum: 400 })),
		max_bytes: Type.Optional(Type.Integer({ description: "Whole-result byte cap (default/max 32 KiB)", minimum: 1, maximum: 32768 })),
	}),
	workbench_delegation_status: Type.Object({}),
	// P8b: public read-only recovery tool. Both params are OPTIONAL in the
	// schema, but the runtime requires EXACTLY ONE (result_id XOR
	// tool_call_id); violating that fails closed with the fixed `invalid`
	// code. result_id is the strict wtr1 shape; tool_call_id is resolved
	// against the CURRENT native Pi session identity
	// (ctx.sessionManager.getSessionId()) and fails closed when the session
	// identity is absent or invalid (legacy no-receipt sessions).
	workbench_recover_tool_result: Type.Object({
		result_id: Type.Optional(
			Type.String({
				description:
					"Strict wtr1 receipt id: wtr1- followed by exactly 64 lowercase hex characters (as shown by a blocked-replay reason or a previous recovery)",
				minLength: 5,
				maxLength: 69,
				pattern: "^wtr1-[0-9a-f]{64}$",
			}),
		),
		tool_call_id: Type.Optional(
			Type.String({
				description:
					"Pi tool call id from the CURRENT native Pi session — resolved against ctx.sessionManager.getSessionId(); fails closed when the session identity is absent or invalid",
				minLength: 1,
				maxLength: 256,
			}),
		),
	}),
	workbench_delegate_worker: Type.Object({
		...WORKBENCH_DELEGATE_WORKER_V1_PROPERTIES,
		// Current schema supersedes only the budget description/limits. The
		// frozen governance-v1 schema continues to use the original property.
		budget_profile: WORKBENCH_DELEGATE_WORKER_CURRENT_BUDGET_PROFILE,
		// S1.1 additive evolution only: governance-v1 task/bounds/budget/repair
		// fields above remain byte-equivalent through the frozen property set.
		// task_kind is appended and optional; runtime omission alone resolves
		// to implementation, while the closed union excludes mechanical.
		task_kind: Type.Optional(
			Type.Union([Type.Literal("implementation"), Type.Literal("diagnosis")], {
				description: "Delegation kind (default: implementation). diagnosis is strictly read-only and cannot edit or write project files.",
				default: "implementation",
			}),
		),
	}),
} as const;

type WorkbenchToolName = (typeof WORKBENCH_TOOL_NAMES)[number];

/** Frozen v1 delegate metadata, independent of future current-catalog copy changes. */
export const WORKBENCH_DELEGATE_WORKER_V1_METADATA = Object.freeze({
	name: "workbench_delegate_worker",
	label: "Workbench delegate worker",
	description:
		"Delegate one bounded implementation task to an isolated deepseek/deepseek-v4-flash:max Pi worker. Available only in DEV and only when the parent is GPT-5.6 Sol. DEV default: coherent source+tests+docs vertical slices for bounded low/medium-risk implementation, each sized with ample headroom BELOW its spend soft thresholds (soft is a handoff reserve, hard is failure — neither is a planning target), delegated after minimum repository orientation with explicit allowed paths and observable acceptance criteria. Spend profiles: standard is the deterministic default; low is an explicit tighter opt-in; extended is explicit Sol-approved only and is never inferred or auto-promoted. Unknown-root-cause work must be split into bounded diagnosis, a Sol architecture/scope decision, then bounded implementation — never one open-ended worker task. Optional repair_of is a strict prior delegation-id provenance pointer for repairs of a KNOWN root cause: use it only after Sol has fixed the root cause and decided the scope, the task itself carries the bounded failure evidence, and the runtime verifies the referenced prior delegation ledger is finished before any new ledger is created or any worker is launched. It adds no path/scope/authority, never resumes the prior worker, and the fresh worker inherits no prior report, session, scope, or contract — an unknown root cause still requires bounded diagnosis, then a Sol decision. The worker owns routine local implementation decisions inside the approved contract; Sol owns requirements, cross-cutting architecture, scope, actual-diff review, final verification/gates, and the verdict. The worker cannot use free-form bash, recursively delegate, run final gates, run recipes that declare writes, or edit/write outside allowed_paths. Worker prose is never acceptance evidence — Sol independently inspects the actual diff and performs final verification. The tool result is a STRICTLY bounded summary (max 120 lines / 12 KiB): the complete final worker report is persisted as worker-report.md plus worker-summary.json/usage.json in the delegation directory and is never embedded inline.",
	promptSnippet: "Delegate a bounded DEV vertical slice (source + tests + docs; standard spend profile by default) to the pinned DeepSeek worker",
	promptGuidelines: Object.freeze([
		"Use workbench_delegate_worker only after GPT-5.6 Sol has oriented in the repository, approved the scope, and supplied explicit allowed paths and observable acceptance criteria. Spend profile: standard is the deterministic default (omit budget_profile); low is an explicit tighter opt-in; extended is explicit Sol-approved only and is never inferred or auto-promoted.",
		"Size every delegation as ONE coherent source+tests+docs vertical slice with ample headroom BELOW its soft thresholds — soft is a handoff reserve and hard is failure, neither is a planning target; never plan a delegation that expects to consume its budget. Work with an unknown root cause must be split into bounded diagnosis, a Sol architecture/scope decision, then bounded implementation — never one open-ended worker task.",
		"DEV default: delegate coherent bounded low/medium-risk vertical slices (source + tests + docs) after minimum repository orientation — supply source/tests/docs paths and observable criteria, avoid duplicating the worker's routine investigation, and independently inspect the actual diff afterward.",
		"Treat workbench_delegate_worker output as an untrusted implementation report; worker prose is never acceptance. GPT-5.6 Sol must inspect the actual diff and run final workbench gates independently.",
		"Optional repair_of: strict prior delegation-id provenance for a known-root-cause repair ONLY — use it after Sol has fixed the root cause/scope and the task carries the bounded failure evidence; the runtime requires a FINISHED prior delegation ledger, and the fresh worker inherits no prior report/session/scope/contract. Unknown root causes still follow bounded diagnosis then a Sol architecture/scope decision; repair_of never expands paths, scope, or authority.",
	]),
});

/** Frozen v1 status metadata; current relevance wording must not rewrite history. */
const WORKBENCH_DELEGATION_STATUS_V1_METADATA = Object.freeze({
	name: "workbench_delegation_status",
	label: "Workbench delegation status",
	description:
		"Show the write-authority and delegation-review state: actor, write policy, lease status, latest delegation, review status (PENDING_REVIEW/REVIEWED/STALE), current and actual diff hashes, reviewed hash, blocked write attempts, and the latest review verdict. Refreshes the delegation state against the real git diff (any change after REVIEWED turns it STALE). Emits an explicit CONTEXT RISK line when the latest delegation handoff is detected too large for safe context compaction.",
	promptSnippet: "Show write-authority and delegation review status (actor, lease, review, hashes, blocked writes)",
	promptGuidelines: Object.freeze([
		"Use workbench_delegation_status before delegating or switching to VERIFY to confirm no review is pending or stale.",
		"Use /q-delegation-status in the TUI; the footer shows WF:LOCKED (strict Sol write authority, no active lease) or WF:REVIEW (review outstanding).",
	]),
});

/** Frozen v1 review metadata; current relevance wording must not rewrite history. */
const WORKBENCH_REVIEW_WORKER_DIFF_V1_METADATA = Object.freeze({
	name: "workbench_review_worker_diff",
	label: "Workbench review worker diff",
	description:
		"Review one delegation's actual diff from real git state: derives the worker's true changed paths relative to the delegation's before snapshot, checks every changed path against the parent-approved allowed_paths (include_paths only narrows the patch and can never hide a violation), renders a globally bounded redacted patch (default 400 lines / 32 KiB over the whole rendered patch; per-path stats plus a segmented include_paths review instruction when truncated/omitted), and binds the current diff hash. Callable repeatedly on the latest delegation (PENDING_REVIEW / STALE / REVIEWED): every call re-runs the real git facts, scope and hash; displayed-path coverage merges across same-hash segments (per-path truncated entries count; globally omitted paths do not) and resets on a hash change. REVIEWED requires scope PASS plus complete displayed-path coverage; a scope FAIL invalidates a prior REVIEWED state fail-closed. Writes only the delegation review record and state — never project files.",
	promptSnippet: "Review a delegated worker's actual diff against the approved scope (repeatable, coverage-gated) and bind the reviewed hash",
	promptGuidelines: Object.freeze([
		"Use workbench_review_worker_diff after a worker returns: review the actual diff, never the worker's prose.",
		"The review checks the entire worker diff against allowed_paths; include_paths narrows only the patch output.",
		"A pending or stale delegation blocks the next delegation and VERIFY — review the diff first.",
		"REVIEWED requires a PASS verdict AND complete displayed-path coverage; re-call with include_paths for the remaining paths until coverage is COMPLETE (per-path truncated entries count; globally omitted paths do not).",
	]),
});

/** Keyed by tool name; literal access is precisely typed (no undefined). */
export const WORKBENCH_TOOL_METADATA: { [K in WorkbenchToolName]: WorkbenchToolMeta } = {
	workbench_project_inspect: {
		name: "workbench_project_inspect",
		label: "Workbench project inspect",
		description:
			"Inspect the current project's workbench setup: project root, git state, detected language/package manager, workbench profile, declared recipes, and configuration errors. Never outputs secrets.",
		promptSnippet: "Inspect workbench project configuration (root, git, stack, profile, recipes, config errors)",
		promptGuidelines: [
			"Use workbench_project_inspect before running or designing recipes to learn the project profile and available recipe names.",
		],
	},
	workbench_run_recipe: {
		name: "workbench_run_recipe",
		label: "Workbench run recipe",
		description:
			"Run a declared recipe from .pi/workbench/recipes.yaml by name with schema-approved parameters. Only declared recipes run — arbitrary commands are never accepted. Full output is written to the run directory; a truncated summary is returned. Use workbench_project_inspect to list recipes.",
		promptSnippet: "Run a declared workbench recipe by name (controlled execution)",
		promptGuidelines: [
			"Use workbench_run_recipe instead of bash for project commands that are declared as recipes — the model must not improvise shell commands in VERIFY mode.",
			"Only pass parameters declared in the recipe's params schema.",
		],
	},
	workbench_read_run: {
		name: "workbench_read_run",
		label: "Workbench read run",
		description:
			"Read a workbench run record by run_id: a bounded Summary/Evidence/Persisted summary by default (no raw logs, no argv), or a seek-based quoted stdout/stderr reverse page on logs/all. Log pages share one 32 KiB/400-line ceiling and return a stale-safe previous cursor; full logs stay on disk. Every readable run also reports the current-state validation assessment — REUSABLE or RERUN_REQUIRED with fixed reason codes — as observation only: it never automatically skips recipe/gate execution and is never acceptance evidence.",
		promptSnippet: "Read a workbench run record (default: bounded summary; manifest/logs on request; current-state REUSABLE/RERUN_REQUIRED verdict) by run_id",
		promptGuidelines: [
			"Use workbench_read_run to inspect previous recipe runs; default output is deliberately bounded.",
			"For logs/all, choose log_stream and follow previous_cursor for older pages; max_bytes is shared by stdout and stderr and never raises the 32 KiB hard ceiling.",
			"A REUSABLE/RERUN_REQUIRED validation verdict is a current-state observation only — it never skips recipe/gate execution and is never acceptance evidence; final recipe/gate runs remain required.",
			"Batch 2+ known-independent read-only calls only when every call is read, grep, find, ls, workbench_project_inspect, workbench_read_run, workbench_read_gate, workbench_list_gates, or workbench_compare_runs and the runtime turn budget authorizes every call; dependent calls, writes, delegations, reviews, and final recipe/gate execution stay sequential.",
		],
	},
	workbench_run_gate: {
		name: "workbench_run_gate",
		label: "Workbench run gate",
		description:
			"Run a gate selector (gate id, comma-separated ids, or base|quant|all) from the validation ladder. Only declared recipes run; the gate engine never trusts model prose — manual evidence supplied here is recorded with type \"manual\" and can never masquerade as machine verification. With preflight:true the SAME tool becomes READ-ONLY — it resolves the selector and reports exactly which required manual checks the supplied manual_evidence satisfies (provided/missing ids, readiness) and creates NO gate run, executes NO recipe, assigns NO gate status and returns NO run id; manual evidence stays manual in both modes.",
		promptSnippet: "Run validation gates (base/quant ladder) for the project; preflight:true checks required manual evidence readiness read-only",
		promptGuidelines: [
			"Use workbench_list_gates or /q-gates to see the gates available for the current profile.",
			"Manual evidence for manual checks must be passed as manual_evidence keyed by check id; it is recorded as type \"manual\" only.",
			"Phase 3B: pass preflight:true (or /q-gate <selector> --preflight) to check required manual-evidence readiness READ-ONLY before a formal run — it never creates a run, executes a recipe, assigns a gate status or returns a run id; omit it (or false) to run the gate formally.",
		],
	},
	workbench_read_gate: {
		name: "workbench_read_gate",
		label: "Workbench read gate",
		description:
			"Read exactly one gate run record or gate definition through a bounded 24 KiB/320-line view. The default returns summary plus non-PASS rows; include=checks pages all checks with a stale-safe cursor. Full gates.json remains authoritative on disk.",
		promptSnippet: "Read a gate run record or gate definition",
		promptGuidelines: [
			"Provide exactly one of run_id or gate_id. Use the default failures view first; request include=checks only when full check detail is needed.",
			"Follow next_cursor to continue the same source/include view. A changed source returns stale_cursor; a cursor from another run/gate/include returns source_mismatch.",
		],
	},
	workbench_list_gates: {
		name: "workbench_list_gates",
		label: "Workbench list gates",
		description: "List the validation gates available for the current project/profile with their latest persisted status.",
		promptSnippet: "List available validation gates and their latest status",
		promptGuidelines: [
			"Use workbench_list_gates before running gates to see which gates the current profile loads (base b0-b5 always; quant q0-q5 only for quant-research profiles).",
		],
	},
	workbench_compare_runs: {
		name: "workbench_compare_runs",
		label: "Workbench compare runs",
		description:
			"Compare two workbench run records by run_id: exit code, duration, artifact changes, gate delta, and (when both runs carry a valid quant-result artifact) benchmark/return/drawdown/turnover/cost/fold deltas and parameter changes. All facts come from the runs' own JSON records; deltas are descriptive — a higher return is never automatically interpreted as a better strategy.",
		promptSnippet: "Compare two workbench run records (exit code, duration, artifacts, gates, quant metrics)",
		promptGuidelines: [
			"Use workbench_compare_runs to diff two persisted run records; use /q-runs or workbench_read_run to discover run ids first.",
			"Deltas are descriptive facts — do not treat a higher return as automatically better without risk-adjusted and out-of-sample evidence.",
		],
	},
	workbench_delegate_worker: {
		...WORKBENCH_DELEGATE_WORKER_V1_METADATA,
		description:
			"Deliver one bounded development task to the pinned GPT-5.6 Luna xhigh worker through the committed delegation-v2 transaction. The normal implementation path executes the worker, checks the immutable ChangeSet and approved scope, automatically continues bounded segmented actual-diff review, and closes the session as REVIEWED in this same call when coverage is complete; the parent should continue development without a routine review/status chain. Only a review conflict, persistence failure, no-progress condition, or the 32-segment safety cap leaves explicit review recovery required. Diagnosis is strictly read-only and closes only with zero changed paths, zero successful or denied writes, and a complete report. The current spend profiles are extended (safe default) and standard (explicit small bounded slices); retired low is historical-read-only. This default path never bypasses explicit permission, destructive-action confirmation, or final verification gates. Historical v1 ledgers remain read-only repair provenance only.",
		promptSnippet:
			"Deliver a bounded implementation to GPT-5.6 Luna xhigh in one call with automatic diff review and session close, or run a read-only diagnosis",
		promptGuidelines: [
			"Use one workbench_delegate_worker call for an ordinary bounded implementation; after a successful REVIEWED result, continue directly to the next development step without calling review or status.",
			"Provide a concrete task, the smallest useful allowed_paths set, and observable acceptance criteria. Omit task_kind for implementation; choose diagnosis explicitly for read-only investigation. Omit budget_profile for the safe extended default; select standard explicitly only for a clearly small bounded slice. Retired low is rejected.",
			"Call workbench_review_worker_diff only when this tool reports explicit review required after a conflict, persistence failure, no-progress condition, the 32-segment safety cap, or a pending/stale recovery state.",
			"A successful diagnosis requires zero actual delta, zero successful or denied writes, and a complete four-section report. High-risk permission and final verification remain explicit boundaries.",
		],
	},
	workbench_review_worker_diff: {
		...WORKBENCH_REVIEW_WORKER_DIFF_V1_METADATA,
		description:
			"Recovery review for a delegation that could not complete the default one-call delivery. It checks the entire attributed worker delta W against allowed_paths while include_paths narrows only rendered output, and binds full streaming identities for W, the explicit dependency closure D, and relevant controls S. Use segmented calls for large diffs until coverage is complete. Baseline unrelated dirty paths and recognized workbench artifacts do not stale new tagged v2; Git HEAD, W/D/S drift, or a new unknown-origin path fails closed. Historical untagged v2/v1 retain full-diff binding. This tool writes only review authority and the session mirror, never project files.",
		promptSnippet: "Recover an incomplete, pending, stale, or conflicted delegation review",
		promptGuidelines: [
			"Do not call this after an ordinary successful REVIEWED delegation; the default delivery already completed the actual-diff review.",
			"Use it only when delegation output reports explicit review required, incomplete coverage, or status shows PENDING_REVIEW/STALE.",
			"The review always checks the entire worker delta against allowed_paths; include_paths narrows only the bounded patch presentation.",
			"Repeat segmented review only for remaining paths until PASS and complete coverage close the session.",
		],
	},
	workbench_delegation_status: {
		...WORKBENCH_DELEGATION_STATUS_V1_METADATA,
		description:
			"Show the write-authority and delegation-review state: actor, write policy, lease status, latest delegation, review status (PENDING_REVIEW/REVIEWED/STALE), current and actual diff hashes, reviewed hash, blocked write attempts, and the latest review verdict. The existing hash field names are retained for compatibility: a new tagged v2 delegation refreshes a ChangeSet relevance binding over W (the attributed worker delta), D (the explicit dependency closure), and S (relevant controls); baseline unrelated dirty paths and recognized workbench artifacts do not stale it, while Git HEAD, W/D/S drift, or a new unknown-origin path fails closed and makes a reviewed delegation STALE. Historical untagged v2 and v1 authority retain the complete full-diff binding, where any diff change makes a reviewed delegation STALE. Emits an explicit CONTEXT RISK line when the latest delegation handoff is detected too large for safe context compaction.",
		promptGuidelines: [
			"Routine successful delivery closes as REVIEWED in the delegate call; use status only for diagnostics or recovery.",
			"In the TUI, WF:LOCKED means routine writes belong to Luna, WF:LEASE means a bounded temporary Sol write exception is active, and WF:REVIEW means recovery review is outstanding.",
		],
	},
	workbench_recover_tool_result: {
		name: "workbench_recover_tool_result",
		label: "Workbench recover tool result",
		description:
			"Recover a persisted two-phase tool-result receipt (schema wtr1) for a workbench tool call in THIS native Pi session: provide EXACTLY ONE of result_id (strict wtr1-<64 lowercase hex>) or tool_call_id (resolved against the current session id; fails closed when the session identity is absent or invalid). Returns only the bounded persisted receipt facts (id, tool, status, project-relative receipt path, redacted bounded summary, omission facts) with a fixed disclaimer — the persisted summary is presentation, never acceptance evidence. Read-only and deterministic: never re-executes the original tool call, never reads raw logs or domain records, never refreshes any state, and never creates a receipt for itself. Fixed fail-closed codes: invalid, missing, incomplete, corrupt, conflict, storage_error.",
		promptSnippet: "Recover a persisted tool-result receipt by result_id or current-session tool_call_id (exactly one; bounded, read-only, fail-closed)",
		promptGuidelines: [
			"Use workbench_recover_tool_result after a blocked replay or a reconnect/resume of the SAME native Pi session: pass exactly one of result_id or tool_call_id (never both, never neither — anything else is the fixed invalid code).",
			"Recovery returns only the bounded persisted summary, never the original full output, and is never acceptance evidence; it never re-executes the original tool call.",
		],
	},
};

/** Metadata + parameter schema in the explicit registration order. */
export function workbenchToolMetadataOrdered(): readonly (WorkbenchToolMeta & { parameters: unknown })[] {
	return WORKBENCH_TOOL_NAMES.map((name) => ({
		...(WORKBENCH_TOOL_METADATA[name] as WorkbenchToolMeta),
		parameters: WORKBENCH_TOOL_PARAMETERS[name],
	}));
}

/** Frozen governance-v1 catalog view; current additive fields never rewrite history. */
export function workbenchToolMetadataV1Ordered(): readonly (WorkbenchToolMeta & { parameters: unknown })[] {
	return WORKBENCH_TOOL_NAMES.map((name) => ({
		...(name === "workbench_delegate_worker"
			? {
				...WORKBENCH_DELEGATE_WORKER_V1_METADATA,
				promptGuidelines: [...WORKBENCH_DELEGATE_WORKER_V1_METADATA.promptGuidelines],
			}
			: name === "workbench_delegation_status"
				? {
					...WORKBENCH_DELEGATION_STATUS_V1_METADATA,
					promptGuidelines: [...WORKBENCH_DELEGATION_STATUS_V1_METADATA.promptGuidelines],
				}
				: name === "workbench_review_worker_diff"
					? {
						...WORKBENCH_REVIEW_WORKER_DIFF_V1_METADATA,
						promptGuidelines: [...WORKBENCH_REVIEW_WORKER_DIFF_V1_METADATA.promptGuidelines],
					}
				: (WORKBENCH_TOOL_METADATA[name] as WorkbenchToolMeta)),
		parameters: name === "workbench_delegate_worker" ? WORKBENCH_DELEGATE_WORKER_V1_PARAMETERS : WORKBENCH_TOOL_PARAMETERS[name],
	}));
}

/** True when the name is a workbench custom tool. */
export function isWorkbenchToolName(name: string): boolean {
	return (WORKBENCH_TOOL_NAMES as readonly string[]).includes(name);
}
