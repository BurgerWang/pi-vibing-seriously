/**
 * Controlled worker-delegation policy — pure decision logic, no Pi imports.
 *
 * The parent commander must be GPT-5.6 Sol. The only worker is the pinned
 * DeepSeek V4 Flash model at max reasoning. A child worker cannot delegate,
 * run free-form bash, or execute final validation gates. Structured edit and
 * write calls are limited to paths approved by the parent task contract.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

import type { RecipeMutation } from "./recipe-schema.ts";
import type { WorkerSpendProfile } from "./worker-spend.ts";
import { WORKER_SPEND_DEFAULT_PROFILE } from "./worker-spend.ts";

export const WORKER_TOOL_NAME = "workbench_delegate_worker";
export const WORKER_ROLE_ENV = "WORKBENCH_AGENT_ROLE";
export const WORKER_ALLOWED_PATHS_ENV = "WORKBENCH_WORKER_ALLOWED_PATHS";
export const WORKER_PROJECT_ROOT_ENV = "WORKBENCH_WORKER_PROJECT_ROOT";
export const WORKER_DEPTH_ENV = "WORKBENCH_WORKER_DEPTH";
export const WORKER_ROLE = "worker";

export const COMMANDER_MODEL_ID = "gpt-5.6-sol";
export const COMMANDER_PROVIDERS: readonly string[] = ["openai", "openai-codex"];
export const WORKER_PROVIDER = "deepseek";
export const WORKER_MODEL_ID = "deepseek-v4-flash";
export const WORKER_MODEL_SELECTOR = `${WORKER_PROVIDER}/${WORKER_MODEL_ID}:max`;
export const WORKER_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
	"bash",
	"workbench_run_gate",
	WORKER_TOOL_NAME,
]);

export interface WorkerTaskContract {
	task: string;
	allowedPaths: readonly string[];
	acceptanceCriteria: readonly string[];
	verification: readonly string[];
	/**
	 * Phase 3 (worker token-budget repair): the resolved cumulative
	 * spend-budget profile (additive, optional). Omitted resolves to
	 * `standard`; `low`/`extended` are explicit opt-ins. The profile is
	 * carried on the contract for ledger/record consistency — the runner
	 * enforces it through the fixed WORKER_SPEND_PROFILE_ENV child env
	 * contract, never through task prose (Phase 5 adds only a
	 * deterministic informational profile line to the task text; it never
	 * changes enforcement or thresholds).
	 */
	budgetProfile?: WorkerSpendProfile;
}

export interface WorkerRoleContext {
	role?: string;
	projectRoot?: string;
	allowedPaths?: readonly string[];
}

/** Only GPT-5.6 Sol on an approved first-party provider may command workers. */
export function commanderBlockReason(provider: string | undefined, model: string | undefined): string | undefined {
	if (model !== COMMANDER_MODEL_ID || !provider || !COMMANDER_PROVIDERS.includes(provider)) {
		return `Worker delegation requires commander ${COMMANDER_PROVIDERS.join("|")}/${COMMANDER_MODEL_ID}; active model is ${provider ?? "(none)"}/${model ?? "(none)"}`;
	}
	return undefined;
}

/** Parse the bounded path contract passed to a child process. Invalid input fails closed. */
export function parseWorkerAllowedPaths(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const value = JSON.parse(raw) as unknown;
		if (!Array.isArray(value)) return [];
		return value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean)
			.slice(0, 100);
	} catch {
		return [];
	}
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizeRule(root: string, rule: string): { path: string; subtree: boolean } | undefined {
	const trimmed = rule.trim();
	if (!trimmed || isAbsolute(trimmed)) return undefined;
	const subtree = trimmed.endsWith("/**") || trimmed.endsWith("/") || trimmed.endsWith(sep);
	const withoutSuffix = trimmed.endsWith("/**") ? trimmed.slice(0, -3) : trimmed.replace(/[\\/]+$/, "");
	if (!withoutSuffix) return undefined;
	const absolute = resolve(root, withoutSuffix);
	if (!isInside(root, absolute)) return undefined;
	return { path: absolute, subtree };
}

/**
 * Exact paths allow one file. Rules ending in `/` or `/**` allow a subtree.
 * Both the candidate and every rule must remain inside the project root.
 */
export function isWorkerPathAllowed(projectRoot: string, candidatePath: string, allowedPaths: readonly string[]): boolean {
	const root = resolve(projectRoot);
	if (isAbsolute(candidatePath)) return false;
	const candidate = resolve(root, candidatePath);
	if (!isInside(root, candidate)) return false;
	for (const rawRule of allowedPaths) {
		const rule = normalizeRule(root, rawRule);
		if (!rule) continue;
		if (candidate === rule.path) return true;
		if (rule.subtree && isInside(rule.path, candidate)) return true;
	}
	return false;
}

/** Fixed worker-role tool matrix: hide denied tools while preserving order. */
export function computeRoleActiveTools(tools: readonly string[], role: string | undefined): string[] {
	if (role !== WORKER_ROLE) return [...tools];
	return tools.filter((tool) => !WORKER_HIDDEN_TOOLS.has(tool));
}

/**
 * Extra hard guard used only inside a delegated worker process.
 *
 * Workers may inspect freely and may run declared recipes, but they cannot
 * recursively delegate, use free-form bash, or create final gate evidence.
 * edit/write are constrained to the parent-approved path contract.
 */
export function workerRoleToolCallBlockReason(
	context: WorkerRoleContext,
	toolName: string,
	input: unknown,
): string | undefined {
	if (context.role !== WORKER_ROLE) return undefined;
	if (toolName === WORKER_TOOL_NAME) return "Delegated workers cannot recursively delegate another worker";
	if (toolName === "workbench_run_gate") return "Delegated workers cannot run final validation gates; the Sol commander owns verification";
	if (toolName === "bash") return "Delegated workers cannot use free-form bash; use declared workbench recipes for project commands";
	if (toolName !== "edit" && toolName !== "write") return undefined;

	const path =
		typeof input === "object" && input !== null && "path" in input
			? (input as { path?: unknown }).path
			: undefined;
	if (typeof path !== "string" || !path.trim()) {
		return `Delegated worker ${toolName} requires a non-empty path`;
	}
	if (!context.projectRoot || !context.allowedPaths || context.allowedPaths.length === 0) {
		return "Delegated worker has no valid parent-approved path contract";
	}
	if (!isWorkerPathAllowed(context.projectRoot, path, context.allowedPaths)) {
		return `Delegated worker path is outside the parent-approved scope: ${path}`;
	}
	return undefined;
}

/** Workers may run validation recipes only when they declare no writes. */
export function workerRecipeBlockReason(role: string | undefined, recipeName: string, declaredWrites: readonly string[]): string | undefined {
	if (role !== WORKER_ROLE || declaredWrites.length === 0) return undefined;
	return `Delegated worker cannot run recipe "${recipeName}" because it declares writes: ${declaredWrites.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Phase 3: budget-profile contract validation (worker token-budget repair)
// ---------------------------------------------------------------------------

/**
 * Strict deterministic budget-profile validation/resolution for the
 * delegation task contract (Phase 3 of the worker token-budget repair):
 *
 *   - omitted/undefined → `standard` (the only default path);
 *   - exactly `low` | `standard` | `extended` accepted;
 *   - everything else (unknown strings, empty strings, case variants,
 *     null, numbers, objects, arrays) FAILS CLOSED with a bounded useful
 *     error — before any ledger creation or child launch. `extended` is
 *     never inferred.
 *
 * The tool schema enforces the same closed union at the boundary; this
 * pure check is the contract layer's own fail-closed decision (defense in
 * depth for any caller, schema or not). The error preview is bounded so a
 * pathological value can never produce an unbounded message.
 */
export function resolveWorkerBudgetProfile(value: unknown): { ok: true; profile: WorkerSpendProfile } | { ok: false; error: string } {
	if (value === undefined) return { ok: true, profile: WORKER_SPEND_DEFAULT_PROFILE };
	if (value === "low" || value === "standard" || value === "extended") return { ok: true, profile: value };
	if (typeof value === "string") {
		const preview = value.length > 60 ? `${value.slice(0, 60)}…` : value;
		return { ok: false, error: `budget_profile must be one of "low" | "standard" | "extended" (received string ${JSON.stringify(preview)})` };
	}
	const kind = value === null ? "null" : typeof value;
	return { ok: false, error: `budget_profile must be one of "low" | "standard" | "extended" (received ${kind})` };
}

// ---------------------------------------------------------------------------
// P7 shared recipe mutation policy (used by direct recipe execution AND by
// gate-engine recipe checks — one pure decision, two enforcement points)
// ---------------------------------------------------------------------------

/**
 * Actor facts for the recipe mutation decision. Identity comes ONLY from
 * the WORKBENCH_AGENT_ROLE worker env contract and the provider/model
 * pair — never from project config or the prompt (same sources as
 * write-authority.ts, kept dependency-free here to avoid an import cycle).
 */
export interface RecipeMutationFacts {
	/** WORKBENCH_AGENT_ROLE value (worker child only). */
	role?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
}

/**
 * The single shared mutation-policy decision (P7 slice 3):
 *   - strict Sol (approved GPT-5.6 Sol under worker-first-strict) may run
 *     recipes declaring mutation none or artifacts; mutation source is
 *     DENIED (source-mutating work is delegated to a worker);
 *   - delegated workers may run ONLY mutation none (write-free) recipes;
 *   - every other controller retains prior behavior (no restriction);
 *   - missing/unknown actor facts impose no restriction (backward
 *     compatible with all pre-P7 callers).
 * Legacy inference (recipe-schema.ts) maps non-empty writes to source, so
 * this decision is exactly as strict as the declared writes for legacy
 * recipes and additionally denies artifact-producing recipes to workers.
 */
export function recipeMutationBlockReason(
	facts: RecipeMutationFacts | undefined,
	recipeName: string,
	mutation: RecipeMutation,
): string | undefined {
	if (facts?.role === WORKER_ROLE) {
		if (mutation !== "none") {
			return `Delegated worker cannot run recipe "${recipeName}": it declares mutation: ${mutation}; workers run only mutation: none (write-free) recipes`;
		}
		return undefined;
	}
	const approvedSol =
		facts !== undefined &&
		facts.model === COMMANDER_MODEL_ID &&
		facts.provider !== undefined &&
		COMMANDER_PROVIDERS.includes(facts.provider);
	if (approvedSol && mutation === "source") {
		return `Worker-first write authority denies recipe "${recipeName}" for the strict Sol commander: it declares mutation: source; strict Sol runs only mutation: none and mutation: artifacts recipes — delegate source-mutating implementation to workbench_delegate_worker`;
	}
	return undefined;
}

/**
 * Stable task text: fixed instructions plus dynamic contract in the user
 * message. Phase 5: the text includes one short deterministic
 * spend-profile line naming the resolved `budgetProfile` (omitted →
 * `standard`; explicit `low`/`extended` named when supplied) and stating
 * that the profile bounds cumulative spend only — it never expands the
 * parent-approved path/scope authority. The line is informational
 * wording: enforcement stays in the runner and the fixed child env
 * contract, and thresholds are unchanged.
 */
export function formatWorkerTask(contract: WorkerTaskContract): string {
	const profile = contract.budgetProfile ?? WORKER_SPEND_DEFAULT_PROFILE;
	const lines = [
		"Delegated implementation task:",
		contract.task.trim(),
		"",
		`Worker spend-budget profile: ${profile} — bounds cumulative spend only; never expands parent-approved path/scope authority.`,
		"",
		"Parent-approved paths (exact path, or subtree ending in / or /**):",
		...contract.allowedPaths.map((path) => `- ${path}`),
		"",
		"Acceptance criteria:",
		...contract.acceptanceCriteria.map((criterion) => `- ${criterion}`),
	];
	if (contract.verification.length > 0) {
		lines.push("", "Requested verification:", ...contract.verification.map((step) => `- ${step}`));
	}
	return lines.join("\n");
}
