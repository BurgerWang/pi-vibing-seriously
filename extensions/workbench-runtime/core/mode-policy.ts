/**
 * Workbench mode policy — pure decision logic, no Pi imports.
 *
 * Kept framework-free so it can be unit-tested with plain `node:test`.
 * The extension (`index.ts`) wires this policy into Pi's native mechanisms:
 *   - layer 1: active-tool sets via `pi.setActiveTools()`
 *   - layer 2: hard `tool_call` guard via `pi.on("tool_call")`
 *
 * Modes:
 *   AUDIT  — read-only inspection (read, grep, find, ls and the read-only
 *            workbench tools: project_inspect, read_run, read_gate,
 *            list_gates, compare_runs). bash/edit/write and
 *            workbench_run_recipe/workbench_run_gate are hard-denied.
 *   DEV    — full local development tool set (all Pi built-in dev tools plus
 *            all workbench_* tools, including controlled worker delegation).
 *            Keeps any other non-managed custom tools that are currently active.
 *   VERIFY — read-only built-ins plus verification workbench tools. NO free
 *            bash/edit/write; only exact review-gated recipes/gates config
 *            maintenance may delegate. Sol owns review and final judgment.
 *
 * Second-layer protection (P1 + P5): see core/command-guard.ts (token-based
 * destructive-command detection) and core/path-policy.ts (protected
 * credential paths with per-mode read/write rules).
 */

import {
	findCatastrophicCommand,
	CATASTROPHIC_RULES,
} from "./command-guard.ts";
import {
	bashProtectedReadReason,
	pathPolicyBlockReason,
} from "./path-policy.ts";
import { WORKBENCH_TOOL_NAMES } from "./tool-catalog.ts";
import { WORKER_TOOL_NAME } from "./worker-policy.ts";
import {
	defaultWritePolicy,
	detectActorRole,
	LEASE_TOOLS,
	STRICT_SOL_DEV_ALLOWLIST,
} from "./write-authority.ts";

/**
 * P7 actor facts for the active-tool decision. Identity comes ONLY from the
 * existing WORKBENCH_AGENT_ROLE worker env contract and the active
 * provider/model pair — never from project config or the prompt.
 */
export interface ActorToolFacts {
	roleEnv?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
}

export type WorkbenchMode = "AUDIT" | "DEV" | "VERIFY";

export const DEFAULT_MODE: WorkbenchMode = "DEV";

export const MODE_NAMES: readonly WorkbenchMode[] = ["AUDIT", "DEV", "VERIFY"];

/**
 * Workbench custom tools registered by the extension. The order is the
 * explicit registration order from core/tool-catalog.ts (P6-B) — never a
 * filesystem/YAML/glob order.
 */
export const WORKBENCH_TOOLS: readonly string[] = WORKBENCH_TOOL_NAMES;

export const AUDIT_TOOLS: readonly string[] = [
	"read",
	"grep",
	"find",
	"ls",
	"workbench_project_inspect",
	"workbench_read_run",
	"workbench_read_gate",
	"workbench_list_gates",
	"workbench_compare_runs",
	// P8b: the read-only recovery tool joins the AUDIT read-only set.
	"workbench_recover_tool_result",
];
export const DEV_TOOLS: readonly string[] = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
	...WORKBENCH_TOOLS,
];
export const VERIFY_TOOLS: readonly string[] = [
	"read",
	"grep",
	"find",
	"ls",
	"workbench_project_inspect",
	"workbench_run_recipe",
	"workbench_read_run",
	"workbench_run_gate",
	"workbench_read_gate",
	"workbench_list_gates",
	"workbench_compare_runs",
	// Narrow Sol/Luna configuration maintenance remains review-gated and is
	// the only worker delegation admitted during VERIFY.
	"workbench_delegate_worker",
	// The maintenance result and any pre-existing blocker can be inspected and
	// semantically resolved without leaving VERIFY.
	"workbench_review_worker_diff",
	"workbench_delegation_status",
	// The controller and hard guard admit only immutable non-acceptance
	// recovery actions; checkpoint and push remain DEV-only.
	"workbench_git",
	// P8b: the read-only recovery tool joins the VERIFY read-only set.
	"workbench_recover_tool_result",
];

export const MODE_TOOLS: Readonly<Record<WorkbenchMode, readonly string[]>> = {
	AUDIT: AUDIT_TOOLS,
	DEV: DEV_TOOLS,
	VERIFY: VERIFY_TOOLS,
};

/**
 * Built-in tools whose active state the workbench manages.
 * Anything outside this set (e.g. custom tools from other extensions) is
 * preserved in DEV mode and filtered out by the strict AUDIT/VERIFY tool sets.
 */
export const MANAGED_TOOLS: ReadonlySet<string> = new Set<string>([...DEV_TOOLS]);

/** Any value that is not a known mode falls back to DEV. */
export function normalizeMode(raw: unknown): WorkbenchMode {
	if (raw === "AUDIT" || raw === "DEV" || raw === "VERIFY") return raw;
	return DEFAULT_MODE;
}

/** The canonical active-tool set advertised for a mode. */
export function isToolAllowedInMode(mode: WorkbenchMode, toolName: string): boolean {
	return MODE_TOOLS[mode].includes(toolName);
}

/**
 * Hard denial applied at the `tool_call` guard, independent of whatever
 * active-tool set is currently configured. This is the second layer that
 * still protects even if other logic re-enables a tool.
 *
 * P1 semantics:
 *   AUDIT  — bash, edit, write, workbench_run_recipe (the only mutating
 *            workbench tool) are denied.
 * P3: workbench_run_gate is also mutating (writes gate runs) and is denied
 *     in AUDIT.
 *   VERIFY — free bash/edit/write and worker delegation are denied. Gate runs
 *            are allowed: they only execute declared recipes.
 */
export function isToolHardDenied(mode: WorkbenchMode, toolName: string): boolean {
	if (mode === "AUDIT") {
		return (
			toolName === "bash" ||
			toolName === "edit" ||
			toolName === "write" ||
			toolName === "workbench_run_recipe" ||
			toolName === "workbench_run_gate" ||
			toolName === WORKER_TOOL_NAME ||
			toolName === "workbench_repair_delegation" ||
			toolName === "workbench_git"
		);
	}
	if (mode === "VERIFY") {
		return toolName === "bash" || toolName === "edit" || toolName === "write" || toolName === WORKER_TOOL_NAME
			|| toolName === "workbench_repair_delegation"
			|| toolName === "workbench_git";
	}
	return false;
}

/**
 * Active-tool set to configure for a mode, based on the currently active set.
 *
 * Worker-first Sol DEV: the approved GPT-5.6 Sol identity receives the
 * canonical 16-tool read/control/delegation/Git-completion surface. Bash and foreign tools
 * remain excluded. An ACTIVE human-issued lease adds only its exact
 * edit/write subset, and the second-layer guard still checks path/tool scope.
 * Delegated workers and
 * other controllers remain outside this policy and keep the role-specific
 * behavior below. AUDIT and VERIFY remain strict for every actor.
 *
 * Otherwise (existing P5 semantics): DEV preserves non-managed custom tools
 * in DETERMINISTIC order — sorted by name so the active set never depends
 * on the order another extension or Pi reports them in (P6-B stable
 * prefix). AUDIT and VERIFY are strict.
 */
export function computeActiveTools(
	mode: WorkbenchMode,
	currentlyActive: readonly string[],
	facts?: ActorToolFacts,
	/** Exact edit/write subset from an ACTIVE user-issued lease. */
	leaseTools: readonly string[] = [],
): string[] {
	if (mode === "DEV" && facts) {
		const actor = detectActorRole(facts);
		const policy = defaultWritePolicy(facts.provider, facts.model);
		if (actor === "sol-commander" && policy === "worker-first-strict") {
			// The fixed worker-first surface is advertised (every tool is a
			// Pi builtin or a statically registered workbench tool); foreign
			// tools are dropped by construction. Intersecting with the current
			// active set would lose tools when switching back from a stricter
			// mode, so the canonical list is returned directly. Only the fixed
			// lease-tool order may extend it; malformed/foreign names are ignored.
			return [
				...STRICT_SOL_DEV_ALLOWLIST,
				...LEASE_TOOLS.filter((tool) => leaseTools.includes(tool)),
			];
		}
	}
	const active = new Set<string>();
	for (const tool of MODE_TOOLS[mode]) active.add(tool);
	if (mode === "DEV") {
		const foreign: string[] = [];
		for (const tool of currentlyActive) {
			if (!MANAGED_TOOLS.has(tool)) foreign.push(tool);
		}
		// Stable order: sorted by name, deduplicated.
		foreign.sort();
		for (const tool of foreign) active.add(tool);
	}
	return [...active];
}

// ---------------------------------------------------------------------------
// Combined tool-call check (mode guard + command guard + path policy)
// ---------------------------------------------------------------------------

export interface ToolCallCheck {
	allowed: boolean;
	reason?: string;
}

const VERIFY_CONFIG_MAINTENANCE_PATHS = new Set([
	".pi/workbench/recipes.yaml",
	".pi/workbench/gates.yaml",
]);

/** Exact, review-gated config maintenance lane allowed while VERIFY is blocked. */
export function isVerifyConfigMaintenanceDelegation(input: unknown): boolean {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
	const record = input as Record<string, unknown>;
	if (record.task_kind !== undefined && record.task_kind !== "implementation") return false;
	if (!Array.isArray(record.allowed_paths) || record.allowed_paths.length === 0 ||
		!record.allowed_paths.every((path) => typeof path === "string" && VERIFY_CONFIG_MAINTENANCE_PATHS.has(path))) return false;
	if (record.verification !== undefined && (!Array.isArray(record.verification) || record.verification.length !== 0)) return false;
	return true;
}

/**
 * Decide whether a tool call may execute.
 * 1. Hard mode denial (mutation/run/delegation in AUDIT;
 *    bash/edit/write/delegation in VERIFY).
 * 2. Catastrophic command guard for bash input (all modes where bash can
 *    run) — token-based, see core/command-guard.ts.
 * 3. Path policy for structured tools and bash display-reads — protected
 *    credential files, per-mode read/write rules, see core/path-policy.ts.
 */
export function checkToolCall(mode: WorkbenchMode, toolName: string, input: unknown): ToolCallCheck {
	const verifyAuthorityRecovery = mode === "VERIFY" && toolName === "workbench_git" &&
		typeof input === "object" && input !== null && "action" in input &&
		((input as { action?: unknown }).action === "close_clean_repair" ||
			(input as { action?: unknown }).action === "close_inactive_blocker" ||
			(input as { action?: unknown }).action === "quarantine_unreadable_authority");
	const verifyConfigMaintenance = mode === "VERIFY" && toolName === WORKER_TOOL_NAME && isVerifyConfigMaintenanceDelegation(input);
	if (!verifyAuthorityRecovery && !verifyConfigMaintenance && isToolHardDenied(mode, toolName)) {
		return { allowed: false, reason: `Workbench ${mode} mode blocks tool "${toolName}"` };
	}
	if (toolName === "bash") {
		const command =
			typeof input === "object" && input !== null && "command" in input
				? (input as { command?: unknown }).command
				: undefined;
		if (typeof command === "string") {
			const rule = findCatastrophicCommand(command);
			if (rule) {
				return {
					allowed: false,
					reason: `Workbench blocked catastrophic command [${rule}]: ${command}`,
				};
			}
			const pathReason = bashProtectedReadReason(mode, command);
			if (pathReason) return { allowed: false, reason: pathReason };
		}
		return { allowed: true };
	}
	const pathReason = pathPolicyBlockReason(mode, toolName, input);
	if (pathReason) return { allowed: false, reason: pathReason };
	return { allowed: true };
}

export { CATASTROPHIC_RULES, findCatastrophicCommand };
