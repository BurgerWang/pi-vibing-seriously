/** Read-only projection of durable semantic-repair authority for status and compact guidance. */

import {
	repairDelegationToolActionV1,
	reviewDelegationToolActionV1,
} from "./agent-next-action.ts";

import type { ExecFn } from "./config.ts";
import {
	collectCurrentDelegationBindingV2,
	readDelegationAuthorityObservationV2,
	readProjectDelegationRepairClosureV1,
	type CurrentDelegationBindingV2,
	type DelegationAuthorityObservationV2,
} from "./delegation-project-authority.ts";
import type { DelegationState } from "./delegation-state.ts";
import {
	isDelegationPathLaneBypassableProjectIssueV1,
	type DelegationPathLaneBypassableProjectIssueV1,
} from "./delegation-path-lane-admission.ts";
import {
	isDelegationTerminalNegativeReviewEligibleFromCommittedV1,
	readDelegationCommittedGenerationV2,
	readDelegationTerminalNegativeSolAuthorityV1,
} from "./delegation-transaction-storage.ts";
import { recoverExactRepairCommandAuthorityV1 } from "./exact-repair-authority.ts";
import { recoverRawLineageExactRepairAuthorityV1 } from "./exact-repair-raw-lineage-authority.ts";
import { readWorkerRepairCapsule } from "./worker-repair-authority.ts";

export interface DelegationRepairStatusReaderServicesV1 {
	readAuthority: typeof readDelegationAuthorityObservationV2;
	collectBinding: typeof collectCurrentDelegationBindingV2;
	readRepairCapsule: typeof readWorkerRepairCapsule;
	readRepairClosure?: typeof readProjectDelegationRepairClosureV1;
	readCommittedGeneration?: typeof readDelegationCommittedGenerationV2;
	readTerminalNegativeRepair?: typeof readDelegationTerminalNegativeSolAuthorityV1;
}

const DEFAULT_READER_SERVICES = Object.freeze({
	readAuthority: readDelegationAuthorityObservationV2,
	collectBinding: collectCurrentDelegationBindingV2,
	readRepairCapsule: readWorkerRepairCapsule,
	readRepairClosure: readProjectDelegationRepairClosureV1,
	readCommittedGeneration: readDelegationCommittedGenerationV2,
	readTerminalNegativeRepair: readDelegationTerminalNegativeSolAuthorityV1,
}) satisfies DelegationRepairStatusReaderServicesV1;

type V2Observation = Extract<DelegationAuthorityObservationV2, { kind: "v2" }>;

export type DelegationRepairStatusV1 =
	| { kind: "none" }
	| { kind: "authority_invalid"; delegationId: string | null; code: string }
	| {
		kind: "historical_multiplicity";
		delegationId: string | null;
		code: DelegationPathLaneBypassableProjectIssueV1;
	}
	| { kind: "delegation_active"; delegationId: string; transactionStatus: string }
	| {
		kind: "delegation_retry";
		delegationId: string;
		transactionStatus: string;
		binding: "fresh" | "conflict" | "unavailable";
	}
	| { kind: "delegation_recovery"; delegationId: string; transactionStatus: string }
	| {
		kind: "terminal_negative_review";
		delegationId: string;
		transactionStatus: "INTERRUPTED" | "FAILED";
	}
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

/**
 * Project-level corruption overrides every session-local hint.  The two
 * multiplicity projections are different: they describe multiple readable
 * historical blockers and are resolved per request only by the strict,
 * full-project path-lane admission scan.
 */
export function delegationProjectIssueRepairStatusV1(
	issue: { code: string; delegationId?: string } | undefined,
): DelegationRepairStatusV1 | undefined {
	if (issue === undefined) return undefined;
	return isDelegationPathLaneBypassableProjectIssueV1(issue.code)
		? { kind: "historical_multiplicity", delegationId: issue.delegationId ?? null, code: issue.code }
		: { kind: "authority_invalid", delegationId: issue.delegationId ?? null, code: issue.code };
}

/** Prefer durable execution state, except where a terminal success still needs session completion/freshness. */
export function delegationDisplayedStatusV1(
	sessionStatus: DelegationState["status"],
	transactionStatus: string | undefined,
): string {
	if (transactionStatus === undefined) return sessionStatus;
	return ["REVIEWED", "FINISHED"].includes(transactionStatus) && sessionStatus !== "REVIEWED"
		? sessionStatus
		: transactionStatus;
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
	terminalNegativeReviewEligible?: boolean;
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
	if (input.terminalNegativeReviewEligible === true) {
		if (authority.repairLineage !== undefined ||
			(authority.transactionStatus !== "INTERRUPTED" && authority.transactionStatus !== "FAILED")) {
			return { kind: "authority_invalid", delegationId: input.delegationId, code: "terminal_negative_authority_mismatch" };
		}
		return {
			kind: "terminal_negative_review",
			delegationId: input.delegationId,
			transactionStatus: authority.transactionStatus,
		};
	}
	const lineage = authority.repairLineage;
	if (lineage === undefined) {
		if (["PREPARED", "RUNNING", "COMMITTING"].includes(authority.transactionStatus)) {
			return { kind: "delegation_active", delegationId: input.delegationId, transactionStatus: authority.transactionStatus };
		}
		if (["FAILED", "INTERRUPTED", "RECOVERY_REQUIRED"].includes(authority.transactionStatus)) {
			return input.retryable === true
				? {
					kind: "delegation_retry",
					delegationId: input.delegationId,
					transactionStatus: authority.transactionStatus,
					binding: input.binding.status,
				}
				: { kind: "delegation_recovery", delegationId: input.delegationId, transactionStatus: authority.transactionStatus };
		}
		return { kind: "none" };
	}
	if (authority.transactionStatus === "REVIEWED") return { kind: "none" };
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

async function hasExecutableExactRepairAuthorityV1(input: {
	projectRoot: string;
	delegationId: string;
	exec: ExecFn;
	services: DelegationRepairStatusReaderServicesV1;
}): Promise<boolean> {
	const readCommitted = input.services.readCommittedGeneration ?? readDelegationCommittedGenerationV2;
	const committed = await readCommitted(input.projectRoot, input.delegationId);
	if (committed.ok) {
		if (committed.value.state.status === "INTERRUPTED") {
			const negative = await (input.services.readTerminalNegativeRepair ?? readDelegationTerminalNegativeSolAuthorityV1)(
				input.projectRoot,
				input.delegationId,
			);
			if (!negative.ok) return false;
			const binding = await input.services.collectBinding(input.projectRoot, input.delegationId, input.exec);
			return binding.status === "fresh" && recoverExactRepairCommandAuthorityV1({
				repairOf: input.delegationId,
				committed: committed.value,
				terminalNegativeRepair: negative.value,
				currentBindingHash: binding.hash,
			}).ok;
		}
		return recoverExactRepairCommandAuthorityV1({
			repairOf: input.delegationId,
			committed: committed.value,
		}).ok;
	}
	if (committed.error.code === "storage_failure") return false;
	return (await recoverRawLineageExactRepairAuthorityV1({
		project_root: input.projectRoot,
		repair_of: input.delegationId,
		collectCurrentBinding: (root, id) => input.services.collectBinding(root, id, input.exec),
	})).ok;
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
			return delegationProjectIssueRepairStatusV1(closure.issue)!;
		}
		const delegationId = closure.unresolvedTipId ?? state.latestId;
		if (delegationId === undefined) return { kind: "none" };
		const [authority, binding] = await Promise.all([
			services.readAuthority(projectRoot, delegationId),
			services.collectBinding(projectRoot, delegationId, exec),
		]);
		let terminalNegativeReviewEligible = false;
		if (authority.kind === "v2" && authority.repairLineage === undefined &&
			(authority.transactionStatus === "INTERRUPTED" || authority.transactionStatus === "FAILED")) {
			const committed = await (services.readCommittedGeneration ?? readDelegationCommittedGenerationV2)(projectRoot, delegationId);
			if (!committed.ok || committed.value.state.delegation_id !== delegationId ||
				committed.value.state.status !== authority.transactionStatus || committed.value.state.repair_lineage !== undefined) {
				return { kind: "authority_invalid", delegationId, code: committed.ok ? "terminal_negative_authority_mismatch" : committed.error.code };
			}
			terminalNegativeReviewEligible = isDelegationTerminalNegativeReviewEligibleFromCommittedV1(
				committed.value.state,
				committed.value.records,
			);
		}
			const retryable = !terminalNegativeReviewEligible && authority.kind === "v2" &&
				["ABORTED", "FAILED", "INTERRUPTED", "RECOVERY_REQUIRED"].includes(authority.transactionStatus)
				? await hasExecutableExactRepairAuthorityV1({ projectRoot, delegationId, exec, services })
				: false;
		return classifyDelegationRepairStatusV1({
			delegationId,
			authority,
			binding,
			retryable,
			terminalNegativeReviewEligible,
		});
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
		if (repair.delegationId !== null && ["incomplete_v2_authority", "invalid_record", "unsupported_version"].includes(repair.code)) {
			return `${subject} authority is ${repair.code}; call workbench_git action=quarantine_unreadable_authority delegation_id=${repair.delegationId} in DEV or VERIFY; source bytes and Git remain preserved`;
		}
		return `${subject} authority is ${repair.code}; repair, delegation, and VERIFY remain fail-closed`;
	}
	if (repair.kind === "historical_multiplicity") {
		const exactTip = repair.delegationId === null
			? "select an exact current repair tip before calling workbench_repair_delegation"
			: `${repairDelegationToolActionV1(repair.delegationId)} only when selecting that strict current repair tip`;
		return `project has readable historical blocker multiplicity (${repair.code}); ordinary delegation requires strict full-project path-lane admission proving every blocker known and non-overlapping; overlap or unknown authority remains blocked; ${exactTip}; VERIFY remains blocked`;
	}
	if (repair.kind === "delegation_active") {
		return `delegation ${repair.delegationId} is ${repair.transactionStatus}; wait for the worker result before review or another delegation`;
	}
	if (repair.kind === "delegation_retry") {
		return repair.binding === "fresh"
			? `delegation ${repair.delegationId} is ${repair.transactionStatus}, but has no committed repair lineage for deterministic exact repair; inspect strict recovery authority before any compatibility repair and do not retry review`
			: `delegation ${repair.delegationId} is ${repair.transactionStatus}, but its binding is ${repair.binding}; if its delta was discarded call workbench_git action=close_inactive_blocker delegation_id=${repair.delegationId}; unrelated work is preserved`;
	}
	if (repair.kind === "delegation_recovery") {
		return `delegation ${repair.delegationId} is ${repair.transactionStatus}; if execution is inactive and its delta was discarded call workbench_git action=close_inactive_blocker delegation_id=${repair.delegationId}; do not retry review`;
	}
	if (repair.kind === "terminal_negative_review") {
		return `${reviewDelegationToolActionV1(repair.delegationId)} to publish the strict REPAIR-only Sol decision for the committed ${repair.transactionStatus} delta`;
	}
	if (repair.kind === "repair_required" || repair.kind === "repair_retry") {
		if (repair.binding !== "fresh") {
			return `delegation ${repair.delegationId} has REPAIR_REQUIRED authority but its current binding is ${repair.binding}; restore the exact bound workspace to repair, or if the rejected delta was deliberately discarded call workbench_git action=close_inactive_blocker delegation_id=${repair.delegationId}; unrelated work is preserved and no new worktree is required`;
		}
		return `${repairDelegationToolActionV1(repair.delegationId)} to execute the exact semantic repair directly from strict durable authority`;
	}
	if (repair.kind === "repair_terminal_retry") {
		return `${repairDelegationToolActionV1(repair.delegationId)} for the deterministic lineaged terminal repair${repair.binding === "fresh" ? "" : `; current binding is ${repair.binding}, so the tool will perform strict lineage-contained terminal rebase eligibility checks`}; it fails closed before worker start if authority or rebase is invalid`;
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
	if (status.kind === "historical_multiplicity") {
		return [
			`repair state : HISTORICAL_MULTIPLICITY (${status.code}); authority corruption is not inferred`,
			"delegation   : ordinary starts require strict full-project path-lane admission; overlap or unknown authority remains BLOCKED",
			status.delegationId === null
				? "exact repair : select a strict current repair tip before calling workbench_repair_delegation"
				: `exact repair : ${repairDelegationToolActionV1(status.delegationId)} only for that strict current repair tip`,
			"verify block : VERIFY remains BLOCKED while any historical blocker is unresolved",
		];
	}
	if (status.kind === "delegation_active") {
		return [
			`execution v2 : ${status.transactionStatus} — review is not available yet`,
			"next action  : wait for the current worker result",
		];
	}
	if (status.kind === "delegation_retry") {
		return [
			`completion v2: ${status.transactionStatus} — review is not the recovery path`,
			status.binding === "fresh"
				? "next action  : inspect strict recovery authority; deterministic exact repair requires a committed repair lineage"
				: `next action  : binding is ${status.binding}; inspect status before repair`,
		];
	}
	if (status.kind === "delegation_recovery") {
		return [
			`completion v2: ${status.transactionStatus} — strict recovery is required`,
			"next action  : inspect workbench_delegation_status; do not retry review",
		];
	}
	if (status.kind === "terminal_negative_review") {
		return [
			`completion v2: ${status.transactionStatus} — committed attributed delta requires REPAIR-only Sol review`,
			`next action  : ${reviewDelegationToolActionV1(status.delegationId)}`,
		];
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
			? `next action  : ${repairDelegationToolActionV1(status.delegationId)}`
			: "next action  : restore the exact reviewed binding; repair delegation remains fail-closed");
		return lines;
	}
	if (status.kind === "repair_terminal_retry") {
		return [
			`semantic v2  : UNRESOLVED REPAIR (${status.transactionStatus}); Gate remains BLOCKED`,
			`repair lineage: depth ${status.depth} ${status.lineageHash}`,
			`root decision : ${status.rootDecisionHash}`,
			status.binding === "fresh"
				? `next action  : ${repairDelegationToolActionV1(status.delegationId)}`
				: `next action  : ${repairDelegationToolActionV1(status.delegationId)}; current binding is ${status.binding}, so strict lineage-contained terminal rebase eligibility will be checked before worker start`,
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

/** Clarify the exact semantic-repair exception to the ordinary pending-review blocker. */
export function delegationExactRepairRouteLineV1(status: DelegationRepairStatusV1): string | undefined {
	if (status.kind === "historical_multiplicity" && status.delegationId !== null) {
		return `repair route : ${repairDelegationToolActionV1(status.delegationId)} only for that strict current tip; ordinary delegation requires path-lane admission and VERIFY remains blocked`;
	}
	if ((status.kind !== "repair_required" && status.kind !== "repair_retry") || status.binding !== "fresh") return undefined;
	return `repair route : ALLOWED — ordinary/new delegations remain blocked; ${repairDelegationToolActionV1(status.delegationId)}`;
}
