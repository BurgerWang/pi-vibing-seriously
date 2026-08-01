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
 *            all workbench_* tools). Keeps any other non-managed custom tools
 *            that are currently active.
 *   VERIFY — P1: read, grep, find, ls plus workbench_project_inspect,
 *            workbench_run_recipe, workbench_read_run. NO free bash (P1
 *            replaced free model bash with the declarative Recipe Runner),
 *            no edit/write.
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

export type WorkbenchMode = "AUDIT" | "DEV" | "VERIFY";

export const DEFAULT_MODE: WorkbenchMode = "DEV";

export const MODE_NAMES: readonly WorkbenchMode[] = ["AUDIT", "DEV", "VERIFY"];

/** Workbench custom tools registered by the extension. */
export const WORKBENCH_TOOLS: readonly string[] = [
	"workbench_project_inspect",
	"workbench_run_recipe",
	"workbench_read_run",
	"workbench_run_gate",
	"workbench_read_gate",
	"workbench_list_gates",
	"workbench_compare_runs",
] as const;

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
	...WORKBENCH_TOOLS,
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
 *   VERIFY — free bash is denied (P1 replaced free model bash with the
 *            declarative Recipe Runner), plus edit and write. Gate runs are
 *            allowed: they only execute declared recipes.
 */
export function isToolHardDenied(mode: WorkbenchMode, toolName: string): boolean {
	if (mode === "AUDIT") {
		return (
			toolName === "bash" ||
			toolName === "edit" ||
			toolName === "write" ||
			toolName === "workbench_run_recipe" ||
			toolName === "workbench_run_gate"
		);
	}
	if (mode === "VERIFY") {
		return toolName === "bash" || toolName === "edit" || toolName === "write";
	}
	return false;
}

/**
 * Active-tool set to configure for a mode, based on the currently active set.
 * DEV preserves non-managed custom tools; AUDIT and VERIFY are strict.
 */
export function computeActiveTools(mode: WorkbenchMode, currentlyActive: readonly string[]): string[] {
	const active = new Set<string>();
	for (const tool of MODE_TOOLS[mode]) active.add(tool);
	if (mode === "DEV") {
		for (const tool of currentlyActive) {
			if (!MANAGED_TOOLS.has(tool)) active.add(tool);
		}
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

/**
 * Decide whether a tool call may execute.
 * 1. Hard mode denial (P1: bash/edit/write/workbench_run_recipe in AUDIT;
 *    bash/edit/write in VERIFY).
 * 2. Catastrophic command guard for bash input (all modes where bash can
 *    run) — token-based, see core/command-guard.ts.
 * 3. Path policy for structured tools and bash display-reads — protected
 *    credential files, per-mode read/write rules, see core/path-policy.ts.
 */
export function checkToolCall(mode: WorkbenchMode, toolName: string, input: unknown): ToolCallCheck {
	if (isToolHardDenied(mode, toolName)) {
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
