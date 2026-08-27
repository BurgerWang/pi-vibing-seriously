/** Closed checkout-mutation classification shared by freshness and lane guards. */

/**
 * A tool is read-only only when it is explicitly named here.  Keep this list
 * closed: extension and third-party tools default to mutation-capable, so an
 * older loaded runtime cannot bypass either the stale-build guard or the
 * shared-checkout writer lane merely because it has never seen their name.
 *
 * `workbench_delegation_status` is the one recovery-aware diagnostic.  Its
 * project reconciliation may close an exact, process-settled orphan, but only
 * through the transaction CAS + exact retained start-lock token path.  It does
 * not grant a general writer lane or execute user/project mutations.
 */
export const WORKBENCH_CHECKOUT_READ_ONLY_TOOLS_V1 = Object.freeze([
	"read",
	"grep",
	"find",
	"ls",
	"workbench_project_inspect",
	"workbench_read_run",
	"workbench_read_gate",
	"workbench_list_gates",
	"workbench_compare_runs",
	"workbench_delegation_status",
	"workbench_recover_tool_result",
] as const);

export function workbenchToolRequiresCheckoutLaneV1(toolName: unknown, input?: unknown): boolean {
	if (toolName === "workbench_run_gate" && input && typeof input === "object"
		&& (input as { preflight?: unknown }).preflight === true) return false;
	if (typeof toolName !== "string") return true;
	return !(WORKBENCH_CHECKOUT_READ_ONLY_TOOLS_V1 as readonly string[]).includes(toolName);
}

/**
 * Exact-repair public calls are control routers, not checkout writers by
 * themselves. Their private authority-bound delegation kernel acquires the
 * real delegation lane. Skipping only the outer lane prevents self-deadlock;
 * runtime freshness and receipt checks still classify both tools as mutating.
 */
export function workbenchToolRoutesExactRepairV1(toolName: unknown, input: unknown): boolean {
	if (toolName === "workbench_repair_delegation") return true;
	return toolName === "workbench_delegate_worker" && typeof input === "object" && input !== null &&
		"repair_of" in input && typeof (input as { repair_of?: unknown }).repair_of === "string";
}
