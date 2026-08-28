/** Machine-callable recovery actions returned to the Sol commander. */

import type { DelegationLifecyclePrimaryActionV1 } from "./delegation-lifecycle-resolver.ts";

export const EXACT_REPAIR_TOOL_NAME_V1 = "workbench_repair_delegation" as const;

export function reviewDelegationToolActionV1(delegationId: string): string {
	return `call workbench_review_worker_diff with delegation_id=${delegationId}`;
}

export function repairDelegationToolActionV1(delegationId: string): string {
	return `call ${EXACT_REPAIR_TOOL_NAME_V1} with delegation_id=${delegationId}`;
}

export function delegationStatusToolActionV1(): string {
	return "call workbench_delegation_status";
}

/** Exact machine-call compatibility surface for one resolved action. */
export function delegationLifecycleActionCommandV1(action: DelegationLifecyclePrimaryActionV1): string | null {
	switch (action.action) {
		case "REVIEW_CANDIDATE":
		case "REGENERATE_DERIVED_REVIEW":
			return reviewDelegationToolActionV1(action.exact_target.id);
		case "EXECUTE_EXACT_REPAIR":
			return repairDelegationToolActionV1(action.exact_target.id);
		case "WAIT_FOR_ACTIVE_WRITER":
		case "BLOCK_OVERLAPPING_PATHS":
		case "REPORT_STORAGE_FAILURE":
			return delegationStatusToolActionV1();
		case "QUARANTINE_CORRUPT_AUTHORITY":
			return action.exact_target.kind === "DELEGATION"
				? `call workbench_git action=quarantine_unreadable_authority delegation_id=${action.exact_target.id}`
				: delegationStatusToolActionV1();
		case "CONTINUE_DEVELOPMENT":
		case "CLOSE_SATISFIED_NO_DELTA":
		case "SUPERSEDE_EMPTY_ATTEMPT":
		case "CLOSE_ACCEPTED_OBLIGATION":
		case "REBASE_CURRENT_BINDING":
		case "RECLAIM_STALE_LOCK":
		case "PROMOTE_CANDIDATE":
		case "BLOCK_PROMOTION":
			return null;
		default:
			return assertNever(action.action);
	}
}

function assertNever(value: never): never {
	throw new Error(`unreachable lifecycle action: ${String(value)}`);
}

/** Render guidance from the resolver's one typed action; never reclassify status. */
export function delegationLifecycleActionTextV1(action: DelegationLifecyclePrimaryActionV1): string {
	const id = action.exact_target.id;
	switch (action.action) {
		case "CONTINUE_DEVELOPMENT":
			return "continue ordinary development; no lifecycle command is required";
		case "WAIT_FOR_ACTIVE_WRITER":
			return `delegation ${id} has an active writer; wait for its durable result or let Workbench recover the owner at the next mutation boundary`;
		case "REVIEW_CANDIDATE":
			return `${reviewDelegationToolActionV1(id)} to resume the exact durable semantic review`;
		case "EXECUTE_EXACT_REPAIR":
			return `${repairDelegationToolActionV1(id)} to execute the exact repair from durable authority`;
		case "CLOSE_SATISFIED_NO_DELTA":
			return "continue ordinary development; Workbench will close the satisfied no-delta obligation automatically";
		case "SUPERSEDE_EMPTY_ATTEMPT":
			return "continue ordinary development; Workbench will supersede the empty attempt automatically";
		case "CLOSE_ACCEPTED_OBLIGATION":
			return "continue ordinary development; Workbench will close the accepted obligation automatically";
		case "REGENERATE_DERIVED_REVIEW":
			return `${reviewDelegationToolActionV1(id)} to regenerate derived review evidence; do not quarantine the readable transaction`;
		case "QUARANTINE_CORRUPT_AUTHORITY":
			return action.exact_target.kind === "DELEGATION"
				? `call workbench_git action=quarantine_unreadable_authority delegation_id=${id}; source bytes and Git remain preserved`
				: "select and quarantine the exact unreadable project authority; development and VERIFY remain fail-closed until then";
		case "REBASE_CURRENT_BINDING":
			return `retry the exact ${id} operation; Workbench will rebase the current binding under the writer lock`;
		case "BLOCK_OVERLAPPING_PATHS":
			return "resolve the overlapping or unknown path authority; ordinary delegation and VERIFY remain blocked for that scope";
		case "RECLAIM_STALE_LOCK":
			return "retry the operation; Workbench will reclaim the proven stale writer lock automatically";
		case "PROMOTE_CANDIDATE":
			return `request explicit promotion of Candidate ${id}`;
		case "BLOCK_PROMOTION":
			return `complete the missing current Candidate evidence before promoting ${id}`;
		case "REPORT_STORAGE_FAILURE":
			return "report and repair the authority storage failure; no lifecycle success is inferred";
		default:
			return assertNever(action.action);
	}
}
