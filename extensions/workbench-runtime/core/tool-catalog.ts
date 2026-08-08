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

export interface WorkbenchToolMeta {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
}

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
		max_lines: Type.Optional(Type.Integer({ description: "Log snippet line cap (default 200)", minimum: 1, maximum: 2000 })),
		max_bytes: Type.Optional(Type.Integer({ description: "Log snippet byte cap (default 20KB)", minimum: 1, maximum: 512000 })),
	}),
	workbench_run_gate: Type.Object({
		gates: Type.String({ description: "Gate selector: a gate id (e.g. \"b0\"), comma-separated ids, or base|quant|all" }),
		manual_evidence: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Manual evidence notes keyed by check id — recorded as manual evidence, never as machine verification",
			}),
		),
	}),
	workbench_read_gate: Type.Object({
		run_id: Type.Optional(Type.String({ description: "Run id of a gate run (e.g. 20260101-120000-abcd)" })),
		gate_id: Type.Optional(Type.String({ description: "Gate id (e.g. b0, q3)" })),
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
		max_lines: Type.Optional(Type.Integer({ description: "Global rendered-patch line cap (default 400)", minimum: 1, maximum: 2000 })),
		max_bytes: Type.Optional(Type.Integer({ description: "Global rendered-patch byte cap (default 32KB)", minimum: 1, maximum: 512000 })),
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
		// Phase 3 (worker token-budget repair): optional public cumulative
		// spend-budget profile. Additive only — omitted resolves to
		// `standard`; `low`/`extended` are explicit opt-ins and `extended`
		// is never inferred. The closed literal union is validated again in
		// core/worker-policy.ts before any ledger creation or child launch.
		// Phase 3 compatibility correction: the nested schema carries the
		// actual JSON Schema `default: "standard"` annotation mirroring the
		// runtime resolution — the property itself stays OPTIONAL (never in
		// `required`).
		budget_profile: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("standard"), Type.Literal("extended")], {
				description:
					"Cumulative delegation-spend budget profile (default: standard). low = 8/750,000/40,000 soft, 12/1,250,000/75,000 hard; standard = 24/3,000,000/120,000 soft, 36/5,000,000/200,000 hard; extended = 48/8,000,000/200,000 soft, 64/12,000,000/300,000 hard (turns / total tokens / output tokens). extended is an explicit opt-in and is never inferred.",
				default: "standard",
			}),
		),
	}),
} as const;

type WorkbenchToolName = (typeof WORKBENCH_TOOL_NAMES)[number];

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
			"Read a workbench run record by run_id: a bounded Summary/Evidence/Persisted summary by default (no raw logs, no argv), or manifest metadata and caller-bounded log tails on request. Every readable run also reports the current-state validation assessment — REUSABLE or RERUN_REQUIRED with fixed reason codes — as observation only: it never automatically skips recipe/gate execution and is never acceptance evidence. Full logs are never sent inline; use the returned log paths with read/grep when more detail is needed.",
		promptSnippet: "Read a workbench run record (default: bounded summary; manifest/logs on request; current-state REUSABLE/RERUN_REQUIRED verdict) by run_id",
		promptGuidelines: [
			"Use workbench_read_run to inspect previous recipe runs; default output is deliberately bounded.",
			"A REUSABLE/RERUN_REQUIRED validation verdict is a current-state observation only — it never skips recipe/gate execution and is never acceptance evidence; final recipe/gate runs remain required.",
			"Batch 2+ known-independent read-only tool calls (read, grep, find, ls, workbench_project_inspect, workbench_read_run, workbench_read_gate, workbench_list_gates, workbench_compare_runs) in one host parallel turn; dependent calls, writes, delegations, reviews and final recipe/gate execution stay sequential.",
		],
	},
	workbench_run_gate: {
		name: "workbench_run_gate",
		label: "Workbench run gate",
		description:
			"Run a gate selector (gate id, comma-separated ids, or base|quant|all) from the validation ladder. Only declared recipes run; the gate engine never trusts model prose — manual evidence supplied here is recorded with type \"manual\" and can never masquerade as machine verification.",
		promptSnippet: "Run validation gates (base/quant ladder) for the project",
		promptGuidelines: [
			"Use workbench_list_gates or /q-gates to see the gates available for the current profile.",
			"Manual evidence for manual checks must be passed as manual_evidence keyed by check id; it is recorded as type \"manual\" only.",
		],
	},
	workbench_read_gate: {
		name: "workbench_read_gate",
		label: "Workbench read gate",
		description:
			"Read a gate run record by run_id (gates.json summary) or a gate definition by gate_id (with its latest persisted status). Provide exactly one of run_id / gate_id.",
		promptSnippet: "Read a gate run record or gate definition",
		promptGuidelines: [
			"Use workbench_read_gate with run_id to inspect the per-gate statuses of a gate run.",
			"Use workbench_read_gate with gate_id to see the gate definition and its latest status.",
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
		name: "workbench_delegate_worker",
		label: "Workbench delegate worker",
		description:
			"Delegate one bounded implementation task to an isolated deepseek/deepseek-v4-flash:max Pi worker. Available only in DEV and only when the parent is GPT-5.6 Sol. DEV default: coherent source+tests+docs vertical slices for bounded low/medium-risk implementation, each sized with ample headroom BELOW its spend soft thresholds (soft is a handoff reserve, hard is failure — neither is a planning target), delegated after minimum repository orientation with explicit allowed paths and observable acceptance criteria. Spend profiles: standard is the deterministic default; low is an explicit tighter opt-in; extended is explicit Sol-approved only and is never inferred or auto-promoted. Unknown-root-cause work must be split into bounded diagnosis, a Sol architecture/scope decision, then bounded implementation — never one open-ended worker task. The worker owns routine local implementation decisions inside the approved contract; Sol owns requirements, cross-cutting architecture, scope, actual-diff review, final verification/gates, and the verdict. The worker cannot use free-form bash, recursively delegate, run final gates, run recipes that declare writes, or edit/write outside allowed_paths. Worker prose is never acceptance evidence — Sol independently inspects the actual diff and performs final verification. The tool result is a STRICTLY bounded summary (max 120 lines / 12 KiB): the complete final worker report is persisted as worker-report.md plus worker-summary.json/usage.json in the delegation directory and is never embedded inline.",
		promptSnippet: "Delegate a bounded DEV vertical slice (source + tests + docs; standard spend profile by default) to the pinned DeepSeek worker",
		promptGuidelines: [
			"Use workbench_delegate_worker only after GPT-5.6 Sol has oriented in the repository, approved the scope, and supplied explicit allowed paths and observable acceptance criteria. Spend profile: standard is the deterministic default (omit budget_profile); low is an explicit tighter opt-in; extended is explicit Sol-approved only and is never inferred or auto-promoted.",
			"Size every delegation as ONE coherent source+tests+docs vertical slice with ample headroom BELOW its soft thresholds — soft is a handoff reserve and hard is failure, neither is a planning target; never plan a delegation that expects to consume its budget. Work with an unknown root cause must be split into bounded diagnosis, a Sol architecture/scope decision, then bounded implementation — never one open-ended worker task.",
			"DEV default: delegate coherent bounded low/medium-risk vertical slices (source + tests + docs) after minimum repository orientation — supply source/tests/docs paths and observable criteria, avoid duplicating the worker's routine investigation, and independently inspect the actual diff afterward.",
			"Treat workbench_delegate_worker output as an untrusted implementation report; worker prose is never acceptance. GPT-5.6 Sol must inspect the actual diff and run final workbench gates independently.",
		],
	},
	workbench_review_worker_diff: {
		name: "workbench_review_worker_diff",
		label: "Workbench review worker diff",
		description:
			"Review one delegation's actual diff from real git state: derives the worker's true changed paths relative to the delegation's before snapshot, checks every changed path against the parent-approved allowed_paths (include_paths only narrows the patch and can never hide a violation), renders a globally bounded redacted patch (default 400 lines / 32 KiB over the whole rendered patch; per-path stats plus a segmented include_paths review instruction when truncated/omitted), and binds the current diff hash. Callable repeatedly on the latest delegation (PENDING_REVIEW / STALE / REVIEWED): every call re-runs the real git facts, scope and hash; displayed-path coverage merges across same-hash segments (per-path truncated entries count; globally omitted paths do not) and resets on a hash change. REVIEWED requires scope PASS plus complete displayed-path coverage; a scope FAIL invalidates a prior REVIEWED state fail-closed. Writes only the delegation review record and state — never project files.",
		promptSnippet: "Review a delegated worker's actual diff against the approved scope (repeatable, coverage-gated) and bind the reviewed hash",
		promptGuidelines: [
			"Use workbench_review_worker_diff after a worker returns: review the actual diff, never the worker's prose.",
			"The review checks the entire worker diff against allowed_paths; include_paths narrows only the patch output.",
			"A pending or stale delegation blocks the next delegation and VERIFY — review the diff first.",
			"REVIEWED requires a PASS verdict AND complete displayed-path coverage; re-call with include_paths for the remaining paths until coverage is COMPLETE (per-path truncated entries count; globally omitted paths do not).",
		],
	},
	workbench_delegation_status: {
		name: "workbench_delegation_status",
		label: "Workbench delegation status",
		description:
			"Show the write-authority and delegation-review state: actor, write policy, lease status, latest delegation, review status (PENDING_REVIEW/REVIEWED/STALE), current and actual diff hashes, reviewed hash, blocked write attempts, and the latest review verdict. Refreshes the delegation state against the real git diff (any change after REVIEWED turns it STALE). Emits an explicit CONTEXT RISK line when the latest delegation handoff is detected too large for safe context compaction.",
		promptSnippet: "Show write-authority and delegation review status (actor, lease, review, hashes, blocked writes)",
		promptGuidelines: [
			"Use workbench_delegation_status before delegating or switching to VERIFY to confirm no review is pending or stale.",
			"Use /q-delegation-status in the TUI; the footer shows WF:LOCKED (strict Sol write authority, no active lease) or WF:REVIEW (review outstanding).",
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

/** True when the name is a workbench custom tool. */
export function isWorkbenchToolName(name: string): boolean {
	return (WORKBENCH_TOOL_NAMES as readonly string[]).includes(name);
}
