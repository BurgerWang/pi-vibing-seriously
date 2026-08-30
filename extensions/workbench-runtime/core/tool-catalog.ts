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
import { EXACT_REPAIR_TOOL_NAME_V1 } from "./agent-next-action.ts";

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
	// P8b: the public read-only tool-result recovery tool was appended after
	// the original delegation tools.
	// (intentional one-tool fingerprint transition — see
	// docs/cache/stable-prefix-contract.md). It never starts a receipt for
	// itself and is excluded from the begin step of the receipt lifecycle.
	"workbench_recover_tool_result",
	// Structured Git completion is intentionally appended after every
	// established tool. It checkpoints sealed reviewed paths and may perform
	// an exact-HEAD ordinary push; history rewriting remains impossible.
	"workbench_git",
	// Exact repair is a model-callable control surface. It accepts only the
	// rejected delegation id and recovers every executable argument from
	// immutable authority; /q-repair remains a human convenience alias.
	EXACT_REPAIR_TOOL_NAME_V1,
] as const;

/** P8b: the public read-only tool-result recovery tool. */
export const RECOVERY_TOOL_NAME = "workbench_recover_tool_result";

/** Frozen governance-v1 tool-name inventory (before local commit existed). */
export const WORKBENCH_TOOL_NAMES_V1 = Object.freeze(WORKBENCH_TOOL_NAMES.slice(0, 11));

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
			"Luna xhigh per-worker quality-window profile. standard (default): soft at 32 turns / 5,440,000 total / 160,000 output and hard handoff at 64 turns / 10,880,000 total / 320,000 output. extended: soft at 64 turns / 10,880,000 total / 320,000 output and hard handoff at 96 turns / 17,408,000 total / 512,000 output. Both boundaries preserve a checkpoint and continue automatically with a fresh worker under the same delegation; lifetime usage is telemetry, not user authorization. The retired low literal is rejected for new delegations.",
		default: "standard",
	}),
);

/** Exact governance-v1 delegate input schema retained for characterization. */
export const WORKBENCH_DELEGATE_WORKER_V1_PARAMETERS = Type.Object(WORKBENCH_DELEGATE_WORKER_V1_PROPERTIES);

/** Exact governance-v1 review input schema retained for characterization. */
const WORKBENCH_REVIEW_WORKER_DIFF_V1_PROPERTIES = {
	delegation_id: Type.String({ description: "Delegation id, e.g. 20260101-120000-abcd" }),
	include_paths: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
			description: "Only these worker paths get patch content; scope checks always cover the entire worker diff and include_paths can never hide a violation",
			maxItems: 50,
		}),
	),
	max_lines: Type.Optional(Type.Integer({ description: "Whole-result line cap (default/max 400)", minimum: 1, maximum: 400 })),
	max_bytes: Type.Optional(Type.Integer({ description: "Whole-result byte cap (default/max 32 KiB)", minimum: 1, maximum: 32768 })),
} as const;

export const WORKBENCH_REVIEW_WORKER_DIFF_V1_PARAMETERS = Type.Object(WORKBENCH_REVIEW_WORKER_DIFF_V1_PROPERTIES);

/**
 * Parameter schemas, keyed by tool name. `as const` preserves the exact
 * typebox types so the extension's registerTool calls infer the params type
 * for their execute handlers. Key order here is source order (stable).
 */
export const WORKBENCH_TOOL_PARAMETERS = {
	workbench_project_inspect: Type.Object({
		recipe: Type.Optional(Type.String({
			description: "Optional exact recipe name lookup; returns an authoritative found/not-found result even when the project has more recipes than the bounded overview can display",
			minLength: 1,
			maxLength: 200,
			pattern: "^[^\\r\\n\\u0000-\\u001f\\u007f]+$",
		})),
	}),
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
				description: "Advisory model notes keyed by check id. They may be used by read-only preflight but cannot satisfy a formal human manual check; only explicit user-command evidence can do that",
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
		delegation_id: Type.Optional(Type.String({
			pattern: "^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$",
			description:
				"Omit for a read-only presentation of the durable latest delegation. For ACCEPT or REPAIR, pass the exact delegation_id returned by that complete packet; never guess an id.",
		})),
		include_paths: WORKBENCH_REVIEW_WORKER_DIFF_V1_PROPERTIES.include_paths,
		max_lines: WORKBENCH_REVIEW_WORKER_DIFF_V1_PROPERTIES.max_lines,
		max_bytes: WORKBENCH_REVIEW_WORKER_DIFF_V1_PROPERTIES.max_bytes,
		semantic_decision: Type.Optional(
			Type.Union([Type.Literal("ACCEPT"), Type.Literal("REPAIR")], {
				description:
					"Explicit Sol decision after the complete packet is presented. ACCEPT grants hash-bound semantic review authority. REPAIR rejects the current delta, grants no Gate authority, requires repair_reason, and only enables an exact fresh repair_of lineage.",
			}),
		),
		expected_bound_diff_hash: Type.Optional(
			Type.String({
				pattern: "^[a-f0-9]{64}$",
				minLength: 64,
				maxLength: 64,
				description:
					"Exact packet-bound diff hash paired with semantic_decision=ACCEPT or REPAIR after Sol inspects the complete packet. It prevents deciding against drift; the hash alone grants no authority.",
			}),
		),
		repair_reason: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 1024,
				description:
					"Required only with semantic_decision=REPAIR: a bounded, non-empty Sol diagnosis of what the fresh repair worker must correct. It is persisted in immutable negative authority and never grants Gate authority.",
			}),
		),
		expected_migration_binding_hash: Type.Optional(
			Type.String({
				pattern: "^[a-f0-9]{64}$",
				minLength: 64,
				maxLength: 64,
				description:
					"Required only for the second-call ACCEPT of an upgrade-era finalized schema-2 packet. It must exactly match the migration binding shown by the preceding call and must accompany semantic_decision plus expected_bound_diff_hash.",
			}),
		),
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
	workbench_git: Type.Union([
		Type.Object({
			action: Type.Literal("close_clean_repair"),
		}),
		Type.Object({
			action: Type.Literal("close_inactive_blocker"),
			delegation_id: Type.String({
				description: "Exact blocker id returned by workbench_delegation_status",
				minLength: 20,
				maxLength: 20,
				pattern: "^\\d{8}-\\d{6}-[A-Za-z0-9]{4}$",
			}),
		}),
		Type.Object({
			action: Type.Literal("quarantine_unreadable_authority"),
			delegation_id: Type.String({
				description: "Exact unreadable or incomplete v2 authority id returned by workbench_delegation_status",
				minLength: 20,
				maxLength: 20,
				pattern: "^\\d{8}-\\d{6}-[A-Za-z0-9]{4}$",
			}),
		}),
		Type.Object({
			action: Type.Literal("checkpoint"),
			message: Type.String({
				description:
					"Single-line local Git commit message. One checkpoint batches every still-present compatible finalized semantic review whose exact sealed path bytes remain present.",
				minLength: 1,
				maxLength: 240,
				pattern: "^[^\\r\\n\\u0000-\\u001f\\u007f]+$",
			}),
		}),
		Type.Object({
			action: Type.Literal("push"),
			expected_head: Type.String({
				description: "Exact current 40- or 64-character lowercase Git commit hash authorized for an ordinary push",
				pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$",
			}),
			remote: Type.Optional(Type.String({
				description: "Simple existing Git remote name (default origin)",
				minLength: 1,
				maxLength: 64,
				pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
			})),
		}),
	]),
	workbench_repair_delegation: Type.Object({
		delegation_id: Type.String({
			description:
				"Exact rejected or lineaged terminal delegation id. The runtime recovers the complete successor contract from immutable authority; no caller-supplied task, path, acceptance, budget, or repair content is accepted.",
			minLength: 20,
			maxLength: 20,
			pattern: "^\\d{8}-\\d{6}-[A-Za-z0-9]{4}$",
		}),
	}),
	workbench_delegate_worker: Type.Object({
		...WORKBENCH_DELEGATE_WORKER_V1_PROPERTIES,
		verification: Type.Optional(Type.Array(Type.String({
			minLength: 8,
			maxLength: 207,
			pattern: "^recipe:[^\\r\\n\\u0000-\\u001f\\u007f]{1,200}$",
		}), {
			description:
				"Machine-readable references to declared write-free recipes, each exactly recipe:<declared-name>. The runtime validates existence, mutation:none and parameter compatibility before launch; final Gates remain commander-only.",
			maxItems: 20,
		})),
		// Current schema supersedes only the budget description/limits. The
		// frozen governance-v1 schema continues to use the original property.
		budget_profile: WORKBENCH_DELEGATE_WORKER_CURRENT_BUDGET_PROFILE,
		repair_of: Type.Optional(
			Type.String({
				minLength: 20,
				maxLength: 20,
				pattern: "^\\d{8}-\\d{6}-[A-Za-z0-9]{4}$",
				description:
					"Exact prior delegation id for a known repair. A PENDING_REVIEW implementation is referenceable only after Sol publishes an immutable current-binding semantic REPAIR decision; lineaged terminal retries require strict continuation authority. The fresh worker receives the rejected W/D closure, exact scope, plan identity, and repair decision, never the old session or Gate authority.",
			}),
		),
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
		plan_ref: Type.Optional(
			Type.Object({
				schema: Type.Literal("workbench-plan-ref-v1"),
				plan_id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }),
				version: Type.String({ minLength: 1, maxLength: 64 }),
				plan_path: Type.String({ minLength: 1, maxLength: 400 }),
				plan_sha256: Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" }),
				candidate: Type.String({ minLength: 1, maxLength: 128 }),
				status: Type.Union([
					Type.Literal("NOT_STARTED"), Type.Literal("IN_PROGRESS"), Type.Literal("BLOCKED"), Type.Literal("EVIDENCED"),
				]),
				criteria: Type.Array(Type.Object({
					id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }),
					gate_id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z][A-Za-z0-9._:-]{0,127}$" }),
					check_ids: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 }),
					evidence_paths: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 20 }),
				}, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
				next_action: Type.String({ minLength: 1, maxLength: 500 }),
			}, {
				additionalProperties: false,
				description: "Optional immutable plan snapshot traceability. Current project bytes must match plan_sha256; it adds no scope, review, or Gate authority.",
			}),
		),
		extended_reason: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 500,
				description:
					"Canonical one-line reason for a contract above the 12 KiB ordinary soft limit. Such a call must also set budget_profile explicitly to extended. Every contract remains subject to the absolute 64 KiB limit.",
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
			"Inspect the current project's workbench setup: project root, git state, detected language/package manager, workbench profile, declared recipes, and configuration errors. Pass recipe for an exact found/not-found lookup that is never hidden by bounded overview omissions. Never outputs secrets.",
		promptSnippet: "Inspect workbench project configuration (root, git, stack, profile, recipes, config errors)",
		promptGuidelines: [
			"Use workbench_project_inspect before running or designing recipes. When checking one name, pass recipe for an exact lookup instead of relying on the bounded overview.",
		],
	},
	workbench_run_recipe: {
		name: "workbench_run_recipe",
		label: "Workbench run recipe",
		description:
			"Resolve a declared recipe from .pi/workbench/recipes.yaml by name with schema-approved parameters. Only declared recipes run — arbitrary commands are never accepted. In DEV, an unchanged complete Sol final-check Candidate may reuse its exact current validation without a subprocess or duplicate run; no-cache/refresh and every uncertainty execute. Full executed output is written to the run directory; a bounded summary is returned. Use workbench_project_inspect to list recipes.",
		promptSnippet: "Run a declared workbench recipe by name (controlled execution)",
		promptGuidelines: [
			"Use workbench_run_recipe instead of bash for project commands that are declared as recipes — the model must not improvise shell commands in VERIFY mode.",
			"Only pass parameters declared in the recipe's params schema.",
			"Focused recipes remain development feedback. A DEV recipe declaring the complete typecheck/unit-test/whitespace set returns a DEVELOPMENT_ONLY Candidate; an exact unchanged repeat may report REUSED_CURRENT_CANDIDATE with execution skipped. This never grants Gate, research, release, or profit authority.",
			"recipe_not_found and config_invalid return a structured agent-owned next action. Use the narrow review-gated recipes.yaml maintenance delegation in DEV or VERIFY; do not ask the user to edit the file or change worktrees.",
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
			"Run a gate selector (gate id, comma-separated ids, or base|quant|all) from the validation ladder. Only declared recipes run. Model-supplied manual_evidence is advisory: it may populate read-only preflight readiness but can never satisfy a formal human manual check. Formal human evidence must arrive through the explicit user /q-gate command. With preflight:true the SAME tool becomes READ-ONLY and creates NO gate run, executes NO recipe, assigns NO gate status and returns NO run id.",
		promptSnippet: "Run validation gates (base/quant ladder) for the project; preflight:true checks required manual evidence readiness read-only",
		promptGuidelines: [
			"Use workbench_list_gates or /q-gates to see the gates available for the current profile.",
			"manual_evidence on this model-callable tool is advisory only and never creates human authority; ask the user to invoke /q-gate with manual:<check-id>=<evidence> for formal human checks.",
			"Phase 3B: pass preflight:true (or /q-gate <selector> --preflight) to check required manual-evidence readiness READ-ONLY before a formal run — it never creates a run, executes a recipe, assigns a gate status or returns a run id; omit it (or false) to run the gate formally.",
			"Gate setup, selector, missing-recipe, and invalid-config failures return structured recovery facts. recipes.yaml/gates.yaml maintenance may be delegated in VERIFY only on those exact paths and remains blocked until semantic review completes.",
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
			"Use workbench_list_gates before running gates to see which gates the current profile loads (base b0-b6 always; quant q0-q5 only for quant-research profiles).",
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
			"Run one bounded delegation-v2 task on pinned GPT-5.6 Luna xhigh. Implementation may write only approved paths; diagnosis is strictly read-only. New contracts are canonicalized, verification names only declared mutation:none recipes, and contracts above 12 KiB require explicit extended budget plus extended_reason; 64 KiB is absolute. The worker runs in a fresh no-session process and cannot delegate, use free-form bash, or run final Gates. Immutable transaction, ChangeSet, journal, report and usage facts are retained; ambiguous authority fails closed. Exact repair_of can consume strict terminal failure authority or a PENDING_REVIEW implementation with an immutable Sol REPAIR decision. Its lineage preserves rejected W/D paths, exact scope, root plan identity, and the latest continuation decision while a project lock prevents sibling starts. In VERIFY, only exact recipes.yaml/gates.yaml maintenance with verification omitted is admitted, and its delta still requires normal semantic review before Gate execution resumes. It never resumes a session or imports prior prose, and stays Gate-blocking until the corrected implementation receives strict semantic acceptance. Sol retains architecture, semantic review, final verification, Gates and verdict authority.",
		promptSnippet:
			"Run one bounded Luna xhigh implementation or read-only diagnosis under an immutable contract",
		promptGuidelines: [
			"Delegate one coherent slice with the smallest useful allowed_paths and observable criteria; use diagnosis only when the root cause or scope is genuinely unknown.",
			"Verification entries are exact recipe:<declared-name> references. Omit budget_profile for the bounded standard default; choose extended explicitly only for a justified larger slice. A contract above 12 KiB must set extended and provide extended_reason.",
			"For a complete current PENDING_REVIEW packet that is known wrong, first use workbench_review_worker_diff with semantic_decision=REPAIR, the exact shown bound hash, and repair_reason; then use only the exact repair_of action reported by status. Historical mechanical FINAL remains ACCEPT-migration-only. The fresh worker receives bounded immutable repair/lineage facts, not the old session or report.",
			"Treat worker output as implementation evidence only. Sol owns semantic acceptance, final verification, Gates, permissions and the final verdict.",
		],
	},
	workbench_review_worker_diff: {
		...WORKBENCH_REVIEW_WORKER_DIFF_V1_METADATA,
		description:
			"Inspect the immutable worker delta and its scope/integrity binding. Omit delegation_id for a read-only presentation of the durable latest delegation; this removes guessed/stale IDs. A semantic ACCEPT or REPAIR must explicitly repeat the exact delegation_id and bound hash returned by the complete packet. A call without semantic fields produces only provisional presentation and grants no review or Gate authority. Binary/container changes use bounded size/digest compact packets instead of UTF-8 paging; known formats and bounded byte detection are supported, including upgrade recovery for already-pending v1 paging envelopes. If one ordinary source path is larger than the bounded packet, repeat that single include_path: the runtime resumes the next contiguous UTF-8 page only for the same diff and redacted-stream hashes. semantic_decision=ACCEPT grants exact hash-bound semantic authority; semantic_decision=REPAIR plus a bounded repair_reason publishes immutable negative authority and enables only an exact fresh repair_of lineage. REPAIR never grants Gate authority. Historical migration supports ACCEPT only. include_paths narrows rendering only, never scope checks. Workspace drift invalidates either decision.",
		promptSnippet: "Inspect a bound worker diff, then explicitly ACCEPT it or require an exact fresh REPAIR",
		promptGuidelines: [
			"First call without semantic fields and normally without delegation_id; the runtime selects the durable latest delegation and returns its exact id. This provisional presentation cannot finalize review.",
			"Only after Sol inspects the complete packet, call with that exact delegation_id plus semantic_decision=ACCEPT or REPAIR and its exact expected_bound_diff_hash. REPAIR also requires repair_reason, stays Gate-blocking, and permits only exact repair_of. For an explicitly reported historical migration, only ACCEPT is valid and also requires expected_migration_binding_hash. Never guess an id or hash.",
			"include_paths changes presentation only. Binary/container paths are complete bounded size/digest packets and require independent artifact validation; when one ordinary source path remains, repeat that single path until its hash-bound page range reaches the total. Never accept after drift, incomplete packet coverage, unresolved semantic risk, or an unverified hash.",
			"Review authority never substitutes for final verification or Gate authority.",
		],
	},
	workbench_delegation_status: {
		...WORKBENCH_DELEGATION_STATUS_V1_METADATA,
		description:
				"Show the write-authority and delegation-review state: actor, write policy, lease status, latest delegation, review status, current and reviewed hashes, blocked writes, latest verdict, and durable repair state. REPAIR_REQUIRED reports exact repair_of only while fresh. An inactive discarded blocker reports close_inactive_blocker, which requires only its exact changed, journal-touched, or carried paths clean, preserves unrelated work, writes immutable non-acceptance, and is available in DEV or VERIFY. An incomplete or unreadable ownerless v2 envelope reports quarantine_unreadable_authority; its source bytes remain in place, and later bytes re-block until the new stable inventory is explicitly quarantined. Active execution and ambiguous/corrupt recovery remain fail-closed. Tagged v2 uses W/D/S relevance; historical v2/v1 retains complete-diff binding. Emits an explicit CONTEXT RISK line when the latest handoff is too large for safe context compaction.",
		promptGuidelines: [
			"Successful ordinary implementation delivery performs its bounded scope/integrity and Sol semantic review internally. ACCEPT or zero-delta closure returns one DEV Candidate ready for final verification, with no manual review/status/repair chain. Only an unresolved result exposes its single durable recovery action; status remains diagnostic/recovery-only.",
			"If a complete packet is wrong, publish semantic_decision=REPAIR with the exact bound hash and a bounded reason, then follow only the exact repair_of shown by status. A fresh exact repair route is executable even though ordinary/new delegations and VERIFY remain blocked; call it next without repeating status/review. REPAIR and every unresolved lineage remain Gate-blocking.",
			"Use workbench_recover_tool_result only with an exact receipt id returned by a real tool result. If no workbench_delegate_worker call occurred, never describe the unchanged delegation state as a registry reload or persistence failure.",
			"If rejected changes were deliberately discarded, use the exact close_inactive_blocker action reported by status. It checks only the delegation's changed, journal-touched, or carried paths, preserves unrelated work, never accepts rejected code, and must not be replaced with a new worktree.",
			"When STALE is backed by strict v2 FINAL/PASS plus explicit Sol semantic authority, follow the reported successor action instead of retrying immutable review; a mechanical FINAL/PASS remains blocked and VERIFY stays blocked until a valid successor is reviewed.",
			"In the TUI, WF:DIRECT means ordinary edits are available, WF:LEASE means a high-risk scope is authorized, and WF:REVIEW means recovery review is outstanding.",
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
	workbench_git: {
		name: "workbench_git",
		label: "Workbench Git recovery, checkpoint or push",
		description:
			"Complete bounded recovery and Git work without a shell. close_inactive_blocker writes immutable non-acceptance for the exact newest inactive blocker after only its changed, journal-touched, or carried paths are clean; unrelated work is preserved. quarantine_unreadable_authority binds the complete bounded bytes of an ownerless unreadable v2 envelope without moving them; later changes re-block until explicitly quarantined again. close_clean_repair remains a strict-clean compatibility action. All three recovery actions are Sol-only in DEV or VERIFY and never change Git. checkpoint batches compatible finalized semantic ACCEPT slices and preserves unrelated staged entries. push requires an exact current HEAD and ordinary non-force semantics. Checkpoint/push remain Sol-only DEV. No action can reset, clean, stash, amend, force-push, delete refs, switch branches, accept arbitrary paths, or bypass semantic review.",
		promptSnippet: "Recover an inactive or unreadable delegation without changing Git, checkpoint reviewed paths, or push an authorized exact HEAD",
		promptGuidelines: [
			"When status reports an inactive discarded blocker, call close_inactive_blocker with its exact id. When it reports incomplete/unreadable ownerless authority, call quarantine_unreadable_authority with its exact id. Both work in DEV or VERIFY, preserve source/Git bytes, and never accept code.",
			"After non-zero implementation diffs have complete semantic ACCEPT authority and relevant checks are done, call action=checkpoint once with a concise message. The runtime batches every compatible reviewed slice and preserves unrelated dirty or staged work.",
			"Call action=push only after the user explicitly requests publication and the exact current HEAD is known. Pass that hash as expected_head; ordinary push can fail on non-fast-forward and never permits force or ref deletion.",
			"A checkpoint or push never grants review, release, Gate, Formal, or production authority. Remaining changes after checkpoint need review or belong to unrelated work; do not loop blindly.",
		],
	},
	workbench_repair_delegation: {
		name: EXACT_REPAIR_TOOL_NAME_V1,
		label: "Workbench repair delegation",
		description:
			"Execute or replay one exact repair successor from strict durable authority. The only input is the rejected delegation id. The runtime recovers the immutable task, exact paths, acceptance criteria, verification, budget, plan binding, repair reason and lineage; model-supplied replacements are impossible. Existing successors are replayed idempotently and a fresh worker is started at most once. Available only to the approved Sol commander in DEV. Every resulting delta still requires ordinary semantic review and final verification. /q-repair is the equivalent user-only convenience command.",
		promptSnippet: "Execute or replay the exact authority-bound repair for one delegation id",
		promptGuidelines: [
			"Use this tool whenever a review, status, failure, or continuation result reports an exact repair action. Pass only that returned delegation_id; never reconstruct the rejected task or paths.",
			"A replayed existing successor is not a second attempt. Follow the returned machine-callable next_action and never infer success without the durable successor disposition.",
			"Repair execution preserves the original scope and lineage and grants no semantic, Gate, release, production, or profitability authority.",
		],
	},
};

/** Frozen v1 inspect metadata/schema; exact lookup is a current additive field. */
const WORKBENCH_PROJECT_INSPECT_V1_METADATA = Object.freeze({
	name: "workbench_project_inspect",
	label: "Workbench project inspect",
	description:
		"Inspect the current project's workbench setup: project root, git state, detected language/package manager, workbench profile, declared recipes, and configuration errors. Never outputs secrets.",
	promptSnippet: "Inspect workbench project configuration (root, git, stack, profile, recipes, config errors)",
	promptGuidelines: Object.freeze([
		"Use workbench_project_inspect before running or designing recipes to learn the project profile and available recipe names.",
	]),
});

const WORKBENCH_PROJECT_INSPECT_V1_PARAMETERS = Type.Object({});

const WORKBENCH_RUN_RECIPE_V1_METADATA = Object.freeze({
	name: "workbench_run_recipe",
	label: "Workbench run recipe",
	description:
		"Run a declared recipe from .pi/workbench/recipes.yaml by name with schema-approved parameters. Only declared recipes run — arbitrary commands are never accepted. Full output is written to the run directory; a truncated summary is returned. Use workbench_project_inspect to list recipes.",
	promptSnippet: "Run a declared workbench recipe by name (controlled execution)",
	promptGuidelines: Object.freeze([
		"Use workbench_run_recipe instead of bash for project commands that are declared as recipes — the model must not improvise shell commands in VERIFY mode.",
		"Only pass parameters declared in the recipe's params schema.",
	]),
});

/** Frozen v1 Gate-tool metadata and schema; repaired human provenance must not rewrite history. */
const WORKBENCH_RUN_GATE_V1_METADATA = Object.freeze({
	name: "workbench_run_gate",
	label: "Workbench run gate",
	description:
		"Run a gate selector (gate id, comma-separated ids, or base|quant|all) from the validation ladder. Only declared recipes run; the gate engine never trusts model prose — manual evidence supplied here is recorded with type \"manual\" and can never masquerade as machine verification. With preflight:true the SAME tool becomes READ-ONLY — it resolves the selector and reports exactly which required manual checks the supplied manual_evidence satisfies (provided/missing ids, readiness) and creates NO gate run, executes NO recipe, assigns NO gate status and returns NO run id; manual evidence stays manual in both modes.",
	promptSnippet: "Run validation gates (base/quant ladder) for the project; preflight:true checks required manual evidence readiness read-only",
	promptGuidelines: Object.freeze([
		"Use workbench_list_gates or /q-gates to see the gates available for the current profile.",
		"Manual evidence for manual checks must be passed as manual_evidence keyed by check id; it is recorded as type \"manual\" only.",
		"Phase 3B: pass preflight:true (or /q-gate <selector> --preflight) to check required manual-evidence readiness READ-ONLY before a formal run — it never creates a run, executes a recipe, assigns a gate status or returns a run id; omit it (or false) to run the gate formally.",
	]),
});

const WORKBENCH_LIST_GATES_V1_METADATA = Object.freeze({
	name: "workbench_list_gates",
	label: "Workbench list gates",
	description: "List the validation gates available for the current project/profile with their latest persisted status.",
	promptSnippet: "List available validation gates and their latest status",
	promptGuidelines: Object.freeze([
		"Use workbench_list_gates before running gates to see which gates the current profile loads (base b0-b5 always; quant q0-q5 only for quant-research profiles).",
	]),
});

const WORKBENCH_RUN_GATE_V1_PARAMETERS = Object.freeze({
	...WORKBENCH_TOOL_PARAMETERS.workbench_run_gate,
	properties: Object.freeze({
		...WORKBENCH_TOOL_PARAMETERS.workbench_run_gate.properties,
		manual_evidence: Object.freeze({
			...WORKBENCH_TOOL_PARAMETERS.workbench_run_gate.properties.manual_evidence,
			description: "Manual evidence notes keyed by check id — recorded as manual evidence, never as machine verification",
		}),
	}),
});

/** Metadata + parameter schema in the explicit registration order. */
export function workbenchToolMetadataOrdered(): readonly (WorkbenchToolMeta & { parameters: unknown })[] {
	return WORKBENCH_TOOL_NAMES.map((name) => ({
		...(WORKBENCH_TOOL_METADATA[name] as WorkbenchToolMeta),
		parameters: WORKBENCH_TOOL_PARAMETERS[name],
	}));
}

/** Frozen governance-v1 catalog view; current additive fields never rewrite history. */
export function workbenchToolMetadataV1Ordered(): readonly (WorkbenchToolMeta & { parameters: unknown })[] {
	return WORKBENCH_TOOL_NAMES_V1.map((name) => ({
		...(name === "workbench_project_inspect"
			? {
				...WORKBENCH_PROJECT_INSPECT_V1_METADATA,
				promptGuidelines: [...WORKBENCH_PROJECT_INSPECT_V1_METADATA.promptGuidelines],
			}
			: name === "workbench_run_recipe"
				? {
					...WORKBENCH_RUN_RECIPE_V1_METADATA,
					promptGuidelines: [...WORKBENCH_RUN_RECIPE_V1_METADATA.promptGuidelines],
				}
			: name === "workbench_delegate_worker"
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
					: name === "workbench_run_gate"
						? {
							...WORKBENCH_RUN_GATE_V1_METADATA,
							promptGuidelines: [...WORKBENCH_RUN_GATE_V1_METADATA.promptGuidelines],
						}
						: name === "workbench_list_gates"
							? {
								...WORKBENCH_LIST_GATES_V1_METADATA,
								promptGuidelines: [...WORKBENCH_LIST_GATES_V1_METADATA.promptGuidelines],
							}
							: (WORKBENCH_TOOL_METADATA[name] as WorkbenchToolMeta)),
		parameters: name === "workbench_project_inspect"
			? WORKBENCH_PROJECT_INSPECT_V1_PARAMETERS
			: name === "workbench_delegate_worker"
			? WORKBENCH_DELEGATE_WORKER_V1_PARAMETERS
			: name === "workbench_review_worker_diff"
				? WORKBENCH_REVIEW_WORKER_DIFF_V1_PARAMETERS
			: name === "workbench_run_gate"
				? WORKBENCH_RUN_GATE_V1_PARAMETERS
				: WORKBENCH_TOOL_PARAMETERS[name],
	}));
}

/** True when the name is a workbench custom tool. */
export function isWorkbenchToolName(name: string): boolean {
	return (WORKBENCH_TOOL_NAMES as readonly string[]).includes(name);
}
