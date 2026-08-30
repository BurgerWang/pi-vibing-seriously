/** Machine-callable recovery actions returned to the Sol commander. */

import {
	validateLifecycleActionSnapshotV2,
	type DelegationLifecyclePrimaryActionV1,
	type LifecycleActionSnapshotV2,
} from "./delegation-lifecycle-resolver.ts";

export const EXACT_REPAIR_TOOL_NAME_V1 = "workbench_repair_delegation" as const;
export const LIFECYCLE_ACTION_TURN_MESSAGE_TYPE_V2 = "workbench-lifecycle-action-turn-v2" as const;

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
			return `start a fresh bounded successor delegation for ${id}; the finalized immutable slice cannot be rebound in place`;
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

/** Render the exact machine-selected V2 command without reclassifying lifecycle state. */
export function lifecycleActionSnapshotCommandV2(snapshot: unknown): string | null {
	if (!validateLifecycleActionSnapshotV2(snapshot) || snapshot.tool === null) return null;
	const argumentsText = snapshot.arguments === null || Object.keys(snapshot.arguments).length === 0
		? ""
		: ` ${Object.entries(snapshot.arguments).map(([key, value]) => `${key}=${String(value)}`).join(" ")}`;
	return `call ${snapshot.tool}${argumentsText}`;
}

/** One bounded human guidance line sourced only from LifecycleActionSnapshotV2. */
export function lifecycleActionSnapshotTextV2(snapshot: Readonly<LifecycleActionSnapshotV2>): string {
	if (!validateLifecycleActionSnapshotV2(snapshot)) return "recover lifecycle authority; the current action snapshot is invalid";
	const command = lifecycleActionSnapshotCommandV2(snapshot);
	switch (snapshot.action) {
		case "NONE": return snapshot.reason_code === "OVERLAPPING_PATHS" || snapshot.reason_code === "INVALID_PATH_REQUEST"
			? "overlapping or unknown path authority remains blocked; use strict path-lane admission"
			: "no lifecycle action is currently eligible";
		case "CONTINUE_DIRECT_DEVELOPMENT": return "continue ordinary direct development; no lifecycle command is required";
		case "START_DELEGATION": return command ?? "start only the snapshot-bound delegation";
		case "CONTINUE_CHECKPOINT": return `continue the exact checkpoint ${snapshot.exact_target.bound_hash ?? "(unavailable)"}; do not resume prior conversation state`;
		case "REVIEW_CANDIDATE": return command ?? "review only the snapshot-bound candidate";
		case "RETRY_REVIEW_JOB": return command ?? "retry only the snapshot-bound review job";
		case "START_EXACT_REPAIR": return command ?? "start only the exact snapshot-bound repair";
		case "PAUSED_BUDGET": return snapshot.reason_code === "PAUSED_BUDGET_EXTENDED_SPLIT_REQUIRED"
			? "the cumulative extended budget is exhausted; report that the remaining objective needs a new bounded task split and do not request another budget renewal"
			: "the cumulative standard budget is paused; one ordinary explicit continue/authorize instruction promotes this exact checkpoint to the finite extended profile without resetting spend";
		case "PROMOTE_CANDIDATE": return `request explicit promotion of Candidate ${snapshot.exact_target.candidate_id ?? "(unavailable)"}`;
		case "RUN_GATE": return command ?? "run only the snapshot-bound Gate";
		case "RECOVER_AUTHORITY": return command ?? "recover the exact snapshot-bound authority";
		default: return assertNever(snapshot.action);
	}
}

/** Canonical status projection sourced from the same V2 snapshot as tool selection. */
export function lifecycleActionStatusLinesV2(snapshot: unknown): string[] {
	if (!validateLifecycleActionSnapshotV2(snapshot)) return [
		"lifecycle v2 : UNAVAILABLE (INVALID_ACTION_SNAPSHOT)",
		"typed action : UNAVAILABLE (INVALID_ACTION_SNAPSHOT)",
		"next action  : recover lifecycle authority; do not infer an action from legacy status labels",
	];
	return [
		`lifecycle v2 : ${snapshot.state}`,
		`typed action : ${snapshot.action} (${snapshot.reason_code})`,
		`next action  : ${lifecycleActionSnapshotTextV2(snapshot)}`,
	];
}

/** Replace compatibility action lines without discarding their durable evidence. */
export function mergeLifecycleActionStatusLinesV2(baseLines: readonly string[], snapshot: unknown): string[] {
	const base = baseLines.filter((line) => !line.startsWith("typed action :") && !line.startsWith("next action  :"));
	const action = lifecycleActionStatusLinesV2(snapshot);
	return base.length === 0 ? action : [base[0]!, ...action, ...base.slice(1)];
}

/**
 * Hidden, per-turn machine facts for an actionable lifecycle snapshot.
 *
 * Long conversations may contain an older assistant claim that a tool was not
 * available.  The runtime-selected tool list is newer and authoritative, so
 * the model must not use conversation memory to veto a tool that Pi actually
 * exposed for this turn.  This remains guidance rather than an automatic
 * mutation: report-only requests stay report-only and USER_REQUIRED actions
 * still stop for explicit authorization.
 */
export function lifecycleActionTurnDirectiveV2(
	snapshot: Readonly<LifecycleActionSnapshotV2>,
	activeTools: readonly string[],
): string | undefined {
	if (!validateLifecycleActionSnapshotV2(snapshot) ||
		["NONE", "CONTINUE_DIRECT_DEVELOPMENT"].includes(snapshot.action)) return undefined;
	const tools = [...new Set(activeTools)].sort();
	const toolActive = snapshot.tool !== null && tools.includes(snapshot.tool);
	const facts = JSON.stringify({
		snapshot_hash: snapshot.snapshot_hash,
		action: snapshot.action,
		exact_target: snapshot.exact_target,
		tool: snapshot.tool,
		arguments: snapshot.arguments,
		authorization: snapshot.authorization,
		reason_code: snapshot.reason_code,
		tool_active: toolActive,
		active_tools: tools,
	});
	const execution = snapshot.authorization === "USER_REQUIRED"
		? "Stop execution and request the exact explicit user authorization described by next_action; do not execute, replace, or work around this action until authorization is granted."
		: snapshot.tool === null
			? "No executable tool is selected; report the exact lifecycle state without inventing a different action."
		: toolActive
			? "If the current user message asks to continue, fix, or complete the work, execute this action in this turn before declaring a block. For a report-only request, report these facts without mutating."
			: "The selected tool is not active in this mode; report the exact mode/tool mismatch without inventing a different action.";
	const delegation = snapshot.action === "START_DELEGATION"
		? " For START_DELEGATION, derive one fresh bounded contract from the current objective and repository evidence, then call the listed tool without repair_of. An implementation contract must require a real in-scope delta and must not describe zero delta as success; use task_kind=diagnosis when the bounded objective is only to verify that the current baseline already satisfies the criteria."
		: snapshot.action === "CONTINUE_CHECKPOINT"
			? " For CONTINUE_CHECKPOINT, call the listed exact tool with the supplied delegation_id; do not invent or reconstruct a new contract."
			: "";
	const budgetPause = snapshot.action === "PAUSED_BUDGET"
		? snapshot.reason_code === "PAUSED_BUDGET_EXTENDED_SPLIT_REQUIRED"
			? " PAUSED_BUDGET has exhausted the cumulative extended profile. Do not call status, request another budget renewal, reset counters, or silently create a successor. Report SPLIT_REQUIRED and the exact remaining objective so the next bounded task can be authorized deliberately."
			: " PAUSED_BUDGET has exhausted the cumulative standard profile. Do not call status as a substitute for authorization and do not create a successor. Tell the user that one ordinary explicit continue/authorize instruction will be consumed on the next turn to promote this exact checkpoint once to the finite extended profile; cumulative counters do not reset and no hash incantation is required."
		: "";
	return [
		"Fresh Workbench lifecycle facts for this turn override older conversation assumptions about lifecycle state and tool availability.",
		facts,
		"Never claim a tool listed in active_tools is unavailable. Use only the snapshot-selected action and exact target.",
		`${execution}${delegation}${budgetPause}`,
		"After the tool result, follow its machine next_action and re-check lifecycle status; do not substitute unrelated cleanup.",
	].join("\n");
}

/** Build the hidden runtime message without coupling the composition root to its schema. */
export function lifecycleActionTurnMessageV2(
	snapshot: Readonly<LifecycleActionSnapshotV2>,
	activeTools: readonly string[],
): Readonly<{
	customType: typeof LIFECYCLE_ACTION_TURN_MESSAGE_TYPE_V2;
	content: string;
	display: false;
	details: { snapshot_hash: string; action: string; tool: string | null };
}> | undefined {
	const content = lifecycleActionTurnDirectiveV2(snapshot, activeTools);
	return content === undefined ? undefined : Object.freeze({
		customType: LIFECYCLE_ACTION_TURN_MESSAGE_TYPE_V2,
		content,
		display: false as const,
		details: {
			snapshot_hash: snapshot.snapshot_hash,
			action: snapshot.action,
			tool: snapshot.tool,
		},
	});
}
