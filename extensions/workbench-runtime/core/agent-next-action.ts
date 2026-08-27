/** Machine-callable recovery actions returned to the Sol commander. */

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
