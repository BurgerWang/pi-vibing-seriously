/** Read-only projection of durable semantic-repair authority for status and compact guidance. */

import type { ExecFn } from "./config.ts";
import {
	collectCurrentDelegationBindingV2,
	readDelegationAuthorityObservationV2,
	readProjectDelegationRepairClosureV1,
	type CurrentDelegationBindingV2,
	type DelegationAuthorityObservationV2,
} from "./delegation-project-authority.ts";
import type { DelegationState } from "./delegation-state.ts";
import { readWorkerRepairCapsule } from "./worker-repair-authority.ts";

export interface DelegationRepairStatusReaderServicesV1 {
	readAuthority: typeof readDelegationAuthorityObservationV2;
	collectBinding: typeof collectCurrentDelegationBindingV2;
	readRepairCapsule: typeof readWorkerRepairCapsule;
	readRepairClosure?: typeof readProjectDelegationRepairClosureV1;
}

const DEFAULT_READER_SERVICES = Object.freeze({
	readAuthority: readDelegationAuthorityObservationV2,
	collectBinding: collectCurrentDelegationBindingV2,
	readRepairCapsule: readWorkerRepairCapsule,
	readRepairClosure: readProjectDelegationRepairClosureV1,
}) satisfies DelegationRepairStatusReaderServicesV1;

type V2Observation = Extract<DelegationAuthorityObservationV2, { kind: "v2" }>;

export type DelegationRepairStatusV1 =
	| { kind: "none" }
	| { kind: "authority_invalid"; delegationId: string | null; code: string }
	| {
		kind: "repair_required";
		delegationId: string;
		binding: "fresh" | "conflict" | "unavailable";
		decisionHash: string;
		reasonHash: string;
		expectedBindingHash: string;
	}
	| {
		kind: "repair_retry";
		delegationId: string;
		binding: "fresh" | "conflict" | "unavailable";
		decisionHash: string;
		reasonHash: string;
		expectedBindingHash: string;
		lineageHash: string;
		depth: number;
	}
	| {
		kind: "repair_terminal_retry";
		delegationId: string;
		binding: "fresh" | "conflict" | "unavailable";
		transactionStatus: string;
		rootDelegationId: string;
		rootDecisionHash: string;
		lineageHash: string;
		depth: number;
	}
	| {
		kind: "repair_review";
		delegationId: string;
		transactionStatus: string;
		rootDelegationId: string;
		lineageHash: string;
		depth: number;
	}
	| {
		kind: "repair_active";
		delegationId: string;
		transactionStatus: string;
		rootDelegationId: string;
		lineageHash: string;
		depth: number;
	}
	| {
		kind: "repair_recovery";
		delegationId: string;
		transactionStatus: string;
		rootDelegationId: string;
		lineageHash: string;
		depth: number;
	};

/** Project-level reconcile failures override every session-local hint. */
export function delegationProjectIssueRepairStatusV1(
	issue: { code: string; delegationId?: string } | undefined,
): DelegationRepairStatusV1 | undefined {
	return issue === undefined
		? undefined
		: { kind: "authority_invalid", delegationId: issue.delegationId ?? null, code: issue.code };
}

function bindingStatus(
	binding: CurrentDelegationBindingV2,
	expectedHash: string,
): "fresh" | "conflict" | "unavailable" {
	if (binding.status === "unavailable") return "unavailable";
	return binding.status === "fresh" && binding.hash === expectedHash ? "fresh" : "conflict";
}

/**
 * Classify only strict facts already read from project authority.  This is a
 * diagnostic projection: it never grants review, repair, successor, or Gate
 * authority, and callers must still revalidate at the mutating boundary.
 */
export function classifyDelegationRepairStatusV1(input: {
	delegationId: string;
	authority: DelegationAuthorityObservationV2;
	binding: CurrentDelegationBindingV2;
	retryable?: boolean;
}): DelegationRepairStatusV1 {
	if (input.authority.kind === "invalid-v2") {
		return { kind: "authority_invalid", delegationId: input.delegationId, code: input.authority.code };
	}
	if (input.authority.kind !== "v2") return { kind: "none" };
	const authority: V2Observation = input.authority;
	const decision = authority.semanticRepair;
	if (decision !== undefined) {
		const common = {
			delegationId: input.delegationId,
			binding: bindingStatus(input.binding, decision.expectedBindingHash),
			decisionHash: decision.decisionHash,
			reasonHash: decision.reasonHash,
			expectedBindingHash: decision.expectedBindingHash,
		};
		return authority.repairLineage === undefined
			? { kind: "repair_required", ...common }
			: {
				kind: "repair_retry",
				...common,
				lineageHash: authority.repairLineage.lineageHash,
				depth: authority.repairLineage.depth,
			};
	}
	const lineage = authority.repairLineage;
	if (lineage === undefined || authority.transactionStatus === "REVIEWED") return { kind: "none" };
	if (authority.transactionStatus === "PENDING_REVIEW") {
		return {
			kind: "repair_review",
			delegationId: input.delegationId,
			transactionStatus: authority.transactionStatus,
			rootDelegationId: lineage.rootDelegationId,
			lineageHash: lineage.lineageHash,
			depth: lineage.depth,
		};
	}
	if (["PREPARED", "RUNNING", "COMMITTING"].includes(authority.transactionStatus)) {
		return {
			kind: "repair_active",
			delegationId: input.delegationId,
			transactionStatus: authority.transactionStatus,
			rootDelegationId: lineage.rootDelegationId,
			lineageHash: lineage.lineageHash,
			depth: lineage.depth,
		};
	}
	if (input.retryable === true) {
		return {
			kind: "repair_terminal_retry",
			delegationId: input.delegationId,
			binding: input.binding.status,
			transactionStatus: authority.transactionStatus,
			rootDelegationId: lineage.rootDelegationId,
			rootDecisionHash: lineage.rootDecisionHash,
			lineageHash: lineage.lineageHash,
			depth: lineage.depth,
		};
	}
	return {
		kind: "repair_recovery",
		delegationId: input.delegationId,
		transactionStatus: authority.transactionStatus,
		rootDelegationId: lineage.rootDelegationId,
		lineageHash: lineage.lineageHash,
		depth: lineage.depth,
	};
}

export async function readDelegationRepairStatusV1(
	projectRoot: string,
	state: DelegationState,
	exec: ExecFn,
	services: DelegationRepairStatusReaderServicesV1 = DEFAULT_READER_SERVICES,
): Promise<DelegationRepairStatusV1> {
	try {
		const closure = await (services.readRepairClosure ?? readProjectDelegationRepairClosureV1)(projectRoot);
		if (!closure.ok) {
			return { kind: "authority_invalid", delegationId: state.latestId ?? null, code: closure.issue.code };
		}
		const delegationId = closure.unresolvedTipId ?? state.latestId;
		if (delegationId === undefined) return { kind: "none" };
		const [authority, binding] = await Promise.all([
			services.readAuthority(projectRoot, delegationId),
			services.collectBinding(projectRoot, delegationId, exec),
		]);
		const retryable = authority.kind === "v2" && authority.repairLineage !== undefined &&
			["ABORTED", "FAILED", "RECOVERY_REQUIRED"].includes(authority.transactionStatus)
			? (await services.readRepairCapsule(projectRoot, delegationId)).ok
			: false;
		return classifyDelegationRepairStatusV1({ delegationId, authority, binding, retryable });
	} catch {
		return { kind: "authority_invalid", delegationId: state.latestId ?? null, code: "status_unavailable" };
	}
}

/** Bounded next action shared by live status and the compact mirror. */
export function delegationNextActionTextV1(
	state: DelegationState,
	repair: DelegationRepairStatusV1 = { kind: "none" },
): string | undefined {
	if (repair.kind === "authority_invalid") {
		const subject = repair.delegationId === null ? "project delegation" : `delegation ${repair.delegationId}`;
		return `${subject} authority is ${repair.code}; repair, delegation, and VERIFY remain fail-closed`;
	}
	if (repair.kind === "repair_required" || repair.kind === "repair_retry") {
		if (repair.binding !== "fresh") {
			return `delegation ${repair.delegationId} has REPAIR_REQUIRED authority but its current binding is ${repair.binding}; do not delegate until the exact bound workspace is restored`;
		}
		return `start the exact semantic repair with workbench_delegate_worker repair_of=${repair.delegationId}`;
	}
	if (repair.kind === "repair_terminal_retry") {
		return repair.binding === "fresh"
			? `continue the unresolved semantic repair with workbench_delegate_worker repair_of=${repair.delegationId}`
			: `repair delegation ${repair.delegationId} is retryable but its current binding is ${repair.binding}; restore the exact workspace before retry`;
	}
	if (repair.kind === "repair_review") {
		return `review repair delegation ${repair.delegationId}; explicitly ACCEPT the corrected delta or issue another REPAIR`;
	}
	if (repair.kind === "repair_active") {
		return `repair delegation ${repair.delegationId} is ${repair.transactionStatus}; wait for it or recover its durable transaction`;
	}
	if (repair.kind === "repair_recovery") {
		return `repair delegation ${repair.delegationId} is ${repair.transactionStatus}; inspect strict recovery authority before an exact repair_of retry`;
	}
	if (state.latestId === undefined) return "start the first worker delegation (no delegation yet)";
	if (state.status === "PENDING_REVIEW") {
		return `review delegation ${state.latestId} (PENDING_REVIEW) before the next delegation or VERIFY`;
	}
	if (state.status === "STALE") {
		return `delegation ${state.latestId} is STALE — inspect status; only prior v2 FINAL/PASS with explicit Sol semantic authority permits a fresh successor; otherwise recover the outstanding review; VERIFY remains blocked`;
	}
	return `delegation ${state.latestId} REVIEWED — start the next delegation or run final verification`;
}

/** Human-readable strict repair facts; hashes are shown, free-form reasons are not. */
export function delegationRepairStatusLinesV1(status: DelegationRepairStatusV1): string[] {
	if (status.kind === "none") return [];
	if (status.kind === "authority_invalid") {
		return [`repair state : INVALID (${status.code}); no repair or Gate authority is inferred`];
	}
	if (status.kind === "repair_required" || status.kind === "repair_retry") {
		const lines = [
			`semantic v2  : REPAIR_REQUIRED (negative authority; Gate remains BLOCKED)`,
			`repair bind  : ${status.expectedBindingHash} (${status.binding})`,
			`decision hash: ${status.decisionHash}`,
			`reason hash  : ${status.reasonHash}`,
		];
		if (status.kind === "repair_retry") lines.push(`repair lineage: depth ${status.depth} ${status.lineageHash}`);
		lines.push(status.binding === "fresh"
			? `next action  : call workbench_delegate_worker with repair_of=${status.delegationId}`
			: "next action  : restore the exact reviewed binding; repair delegation remains fail-closed");
		return lines;
	}
	if (status.kind === "repair_terminal_retry") {
		return [
			`semantic v2  : UNRESOLVED REPAIR (${status.transactionStatus}); Gate remains BLOCKED`,
			`repair lineage: depth ${status.depth} ${status.lineageHash}`,
			`root decision : ${status.rootDecisionHash}`,
			status.binding === "fresh"
				? `next action  : call workbench_delegate_worker with repair_of=${status.delegationId}`
				: `next action  : current binding is ${status.binding}; exact repair retry remains fail-closed`,
		];
	}
	const lines = [
		`repair lineage: depth ${status.depth} ${status.lineageHash}`,
		`repair root   : ${status.rootDelegationId}`,
	];
	if (status.kind === "repair_review") {
		lines.push("semantic v2  : REPAIR CHILD PENDING_REVIEW — inspect the corrected packet, then ACCEPT or REPAIR");
	} else if (status.kind === "repair_active") {
		lines.push(`semantic v2  : REPAIR ACTIVE (${status.transactionStatus}); Gate remains BLOCKED`);
	} else {
		lines.push(
			`semantic v2  : UNRESOLVED REPAIR (${status.transactionStatus}); Gate remains BLOCKED`,
			`next action  : strict recovery must validate before repair_of=${status.delegationId} can retry`,
		);
	}
	return lines;
}
