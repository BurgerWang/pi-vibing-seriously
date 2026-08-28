/** Read-only projection of durable semantic-repair authority for status and compact guidance. */

import {
	delegationLifecycleActionTextV1,
} from "./agent-next-action.ts";

import type { ExecFn } from "./config.ts";
import {
	collectCurrentDelegationBindingV2,
	readDelegationAuthorityObservationV2,
	readInactiveProjectDelegationBlockerLifecycleResolutionV1,
	readProjectDelegationRepairClosureV1,
	type CurrentDelegationBindingV2,
	type DelegationAuthorityObservationV2,
} from "./delegation-project-authority.ts";
import { emptyDelegationState, type DelegationState } from "./delegation-state.ts";
import {
	isDelegationPathLaneBypassableProjectIssueV1,
	type DelegationPathLaneBypassableProjectIssueV1,
} from "./delegation-path-lane-admission.ts";
import {
	isDelegationTerminalNegativeReviewEligibleFromCommittedV1,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTerminalNegativeSolAuthorityV1,
} from "./delegation-transaction-storage.ts";
import { recoverExactRepairCommandAuthorityV1 } from "./exact-repair-authority.ts";
import { recoverRawLineageExactRepairAuthorityV1 } from "./exact-repair-raw-lineage-authority.ts";
import {
	DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	delegationLifecycleSnapshotFromCompatibilityProjectionV1,
	delegationLifecycleSnapshotFromExactRepairAuthorityV1,
	delegationLifecycleSnapshotFromReviewCandidateV1,
	resolveDelegationLifecycleV1,
	type DelegationLifecycleAttemptV1,
	type DelegationLifecycleAuthorityDispositionV1,
	type DelegationLifecycleAuthorityHealthV1,
	type DelegationLifecycleBindingV1,
	type DelegationLifecycleResolutionV1,
	type DelegationLifecycleWriterLockV1,
} from "./delegation-lifecycle-resolver.ts";

export interface DelegationRepairStatusReaderServicesV1 {
	readAuthority: typeof readDelegationAuthorityObservationV2;
	collectBinding: typeof collectCurrentDelegationBindingV2;
	readRepairClosure?: typeof readProjectDelegationRepairClosureV1;
	readInactiveLifecycle?: typeof readInactiveProjectDelegationBlockerLifecycleResolutionV1;
	readCommittedGeneration?: typeof readDelegationCommittedGenerationV2;
	readReview?: typeof readDelegationReviewV2;
	readTerminalNegativeRepair?: typeof readDelegationTerminalNegativeSolAuthorityV1;
}

const DEFAULT_READER_SERVICES = Object.freeze({
	readAuthority: readDelegationAuthorityObservationV2,
	collectBinding: collectCurrentDelegationBindingV2,
	readRepairClosure: readProjectDelegationRepairClosureV1,
	readInactiveLifecycle: readInactiveProjectDelegationBlockerLifecycleResolutionV1,
	readCommittedGeneration: readDelegationCommittedGenerationV2,
	readReview: readDelegationReviewV2,
	readTerminalNegativeRepair: readDelegationTerminalNegativeSolAuthorityV1,
}) satisfies DelegationRepairStatusReaderServicesV1;

type V2Observation = Extract<DelegationAuthorityObservationV2, { kind: "v2" }>;

type DelegationRepairStatusShapeV1 =
	| { kind: "none" }
	| { kind: "authority_invalid"; delegationId: string | null; code: string }
	| {
		kind: "derived_review_invalid";
		delegationId: string;
		code: "invalid_record";
		resolution: DelegationLifecycleResolutionV1;
	}
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

export type DelegationRepairStatusV1 = DelegationRepairStatusShapeV1 & {
	readonly resolution?: DelegationLifecycleResolutionV1;
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
	const status: DelegationRepairStatusV1 = isDelegationPathLaneBypassableProjectIssueV1(issue.code)
		? { kind: "historical_multiplicity", delegationId: issue.delegationId ?? null, code: issue.code }
		: { kind: "authority_invalid", delegationId: issue.delegationId ?? null, code: issue.code };
	return withCompatibilityResolutionV1(status);
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

function observeLifecycle(snapshot: ReturnType<typeof delegationLifecycleSnapshotFromCompatibilityProjectionV1>): DelegationLifecycleResolutionV1 {
	return resolveDelegationLifecycleV1(snapshot, {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
		event: "OBSERVE",
		expected_snapshot_hash: null,
	});
}

/**
 * Read-only v1 projection adapter. Historical labels remain available for
 * diagnostics, but only the canonical resolver chooses the action.
 */
function compatibilityLifecycleResolutionV1(
	status: DelegationRepairStatusV1,
	state?: DelegationState,
): DelegationLifecycleResolutionV1 {
	if (status.kind === "derived_review_invalid") return status.resolution;
	const statusId = status.kind === "none" ? state?.latestId : status.delegationId;
	const target = statusId === undefined || statusId === null
		? { kind: "PROJECT_AUTHORITY" as const, id: "project-authority" }
		: { kind: "DELEGATION" as const, id: statusId };
	let authorityHealth: DelegationLifecycleAuthorityHealthV1 = "VALID";
	let authorityDisposition: DelegationLifecycleAuthorityDispositionV1 = "INACTIVE";
	let writerLock: DelegationLifecycleWriterLockV1 = "ABSENT";
	let binding: DelegationLifecycleBindingV1 = "CURRENT";
	let attempt: DelegationLifecycleAttemptV1 = "TERMINAL";
	let scopeUnknown = false;
	let recoveryRank: { unresolved_obligations: number; unresolved_attempts: number } | null =
		{ unresolved_obligations: 0, unresolved_attempts: 0 };

	switch (status.kind) {
		case "none":
			if (state?.latestId !== undefined && state.status === "PENDING_REVIEW") attempt = "AWAITING_REVIEW";
			else if (state?.latestId !== undefined && state.status === "STALE") {
				attempt = "AWAITING_REVIEW";
				binding = "REBASEABLE";
			}
			break;
		case "authority_invalid":
			authorityHealth = /(?:storage|unavailable)/u.test(status.code) ? "STORAGE_FAILURE" : "CORRUPT";
			authorityDisposition = "UNKNOWN";
			scopeUnknown = true;
			recoveryRank = null;
			break;
		case "historical_multiplicity":
			binding = "OVERLAPPING";
			scopeUnknown = true;
			recoveryRank = { unresolved_obligations: 1, unresolved_attempts: 1 };
			break;
		case "delegation_active":
		case "repair_active":
			attempt = "ACTIVE";
			authorityDisposition = "ACTIVE";
			writerLock = "LIVE";
			recoveryRank = { unresolved_obligations: 1, unresolved_attempts: 1 };
			break;
		case "delegation_recovery":
		case "repair_recovery":
			authorityDisposition = "UNKNOWN";
			binding = "OVERLAPPING";
			scopeUnknown = true;
			recoveryRank = { unresolved_obligations: 1, unresolved_attempts: 1 };
			break;
		case "terminal_negative_review":
		case "repair_review":
			attempt = "AWAITING_REVIEW";
			recoveryRank = { unresolved_obligations: 1, unresolved_attempts: 1 };
			break;
		case "delegation_retry":
		case "repair_required":
		case "repair_retry":
		case "repair_terminal_retry": {
			attempt = "REPAIRABLE";
			recoveryRank = { unresolved_obligations: 1, unresolved_attempts: 1 };
			if (status.binding === "conflict") binding = "REBASEABLE";
			else if (status.binding === "unavailable") authorityHealth = "STORAGE_FAILURE";
			break;
		}
	}

	return observeLifecycle(delegationLifecycleSnapshotFromCompatibilityProjectionV1({
		source_authority: { status, state },
		authority_health: authorityHealth,
		authority_disposition: authorityDisposition,
		writer_lock: writerLock,
		binding,
		attempt,
		target,
		scope_unknown: scopeUnknown,
		recovery_rank: recoveryRank,
	}));
}

function withCompatibilityResolutionV1(status: DelegationRepairStatusV1): DelegationRepairStatusV1 {
	return status.kind === "none" || status.resolution !== undefined
		? status
		: { ...status, resolution: compatibilityLifecycleResolutionV1(status) };
}

/**
 * Classify only strict facts already read from project authority.  This is a
 * diagnostic projection: it never grants review, repair, successor, or Gate
 * authority, and callers must still revalidate at the mutating boundary.
 */
function classifyDelegationRepairFactsV1(input: {
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
		if ((authority.transactionStatus !== "INTERRUPTED" && authority.transactionStatus !== "FAILED")
			|| (authority.repairLineage !== undefined && authority.transactionStatus !== "INTERRUPTED")) {
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

/** @deprecated Compatibility diagnostic; lifecycle action ownership is canonical resolver v1. */
export function classifyDelegationRepairStatusV1(input: {
	delegationId: string;
	authority: DelegationAuthorityObservationV2;
	binding: CurrentDelegationBindingV2;
	retryable?: boolean;
	terminalNegativeReviewEligible?: boolean;
}): DelegationRepairStatusV1 {
	return withCompatibilityResolutionV1(classifyDelegationRepairFactsV1(input));
}

async function hasExecutableExactRepairAuthorityV1(input: {
	projectRoot: string;
	delegationId: string;
	exec: ExecFn;
	services: DelegationRepairStatusReaderServicesV1;
}): Promise<DelegationLifecycleResolutionV1 | undefined> {
	const fromAuthority = (authority: { repair_of: string; arguments: { allowed_paths: readonly string[] } }): DelegationLifecycleResolutionV1 | undefined => {
		const snapshot = delegationLifecycleSnapshotFromExactRepairAuthorityV1({
			repair_of: authority.repair_of,
			source_authority: authority,
			affected_paths: authority.arguments.allowed_paths,
		});
		const resolution = resolveDelegationLifecycleV1(snapshot, {
			schema_version: 1,
			kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
			event: "OBSERVE",
			expected_snapshot_hash: null,
		});
		return resolution.primary_action.action === "EXECUTE_EXACT_REPAIR" ? resolution : undefined;
	};
	const readCommitted = input.services.readCommittedGeneration ?? readDelegationCommittedGenerationV2;
	const committed = await readCommitted(input.projectRoot, input.delegationId);
	if (committed.ok) {
		if (committed.value.state.status === "PENDING_REVIEW") {
			const review = await (input.services.readReview ?? readDelegationReviewV2)(
				input.projectRoot,
				input.delegationId,
			);
			if (!review.ok) return undefined;
			const recovered = recoverExactRepairCommandAuthorityV1({
				repairOf: input.delegationId,
				committed: committed.value,
				review: review.value,
			});
			return recovered.ok ? fromAuthority(recovered.value) : undefined;
		}
		if (committed.value.state.status === "INTERRUPTED") {
			const negative = await (input.services.readTerminalNegativeRepair ?? readDelegationTerminalNegativeSolAuthorityV1)(
				input.projectRoot,
				input.delegationId,
			);
			if (!negative.ok) return undefined;
			const binding = await input.services.collectBinding(input.projectRoot, input.delegationId, input.exec);
			if (binding.status !== "fresh") return undefined;
			const recovered = recoverExactRepairCommandAuthorityV1({
				repairOf: input.delegationId,
				committed: committed.value,
				terminalNegativeRepair: negative.value,
				currentBindingHash: binding.hash,
			});
			return recovered.ok ? fromAuthority(recovered.value) : undefined;
		}
		const recovered = recoverExactRepairCommandAuthorityV1({
			repairOf: input.delegationId,
			committed: committed.value,
		});
		return recovered.ok ? fromAuthority(recovered.value) : undefined;
	}
	if (committed.error.code === "storage_failure") return undefined;
	const recovered = await recoverRawLineageExactRepairAuthorityV1({
		project_root: input.projectRoot,
		repair_of: input.delegationId,
		collectCurrentBinding: (root, id) => input.services.collectBinding(root, id, input.exec),
	});
	return recovered.ok ? fromAuthority(recovered.value) : undefined;
}

async function reviewLifecycleResolutionV1(input: {
	projectRoot: string;
	delegationId: string;
	services: DelegationRepairStatusReaderServicesV1;
}): Promise<DelegationLifecycleResolutionV1 | undefined> {
	const committed = await (input.services.readCommittedGeneration ?? readDelegationCommittedGenerationV2)(
		input.projectRoot,
		input.delegationId,
	);
	if (!committed.ok) return undefined;
	const state = committed.value.state;
	const snapshot = delegationLifecycleSnapshotFromReviewCandidateV1({
		delegation_id: state.delegation_id,
		source_authority: { state, proof: committed.value.proof },
		affected_paths: [...state.allowed_paths].sort((left, right) =>
			Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")),
		),
		review_required: true,
	});
	const resolution = resolveDelegationLifecycleV1(snapshot, {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
		event: "OBSERVE",
		expected_snapshot_hash: null,
	});
	return resolution.primary_action.action === "REVIEW_CANDIDATE" ? resolution : undefined;
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
		if (authority.kind === "derived-review-invalid") {
			return {
				kind: "derived_review_invalid",
				delegationId,
				code: authority.code,
				resolution: authority.resolution,
			};
		}
		let terminalNegativeReviewEligible = false;
		if (authority.kind === "v2"
			&& (authority.transactionStatus === "INTERRUPTED"
				|| (authority.transactionStatus === "FAILED" && authority.repairLineage === undefined))) {
			const committed = await (services.readCommittedGeneration ?? readDelegationCommittedGenerationV2)(projectRoot, delegationId);
			if (!committed.ok || committed.value.state.delegation_id !== delegationId ||
				committed.value.state.status !== authority.transactionStatus
				|| (committed.value.state.repair_lineage === undefined) !== (authority.repairLineage === undefined)) {
				return withCompatibilityResolutionV1({
					kind: "authority_invalid",
					delegationId,
					code: committed.ok ? "terminal_negative_authority_mismatch" : committed.error.code,
				});
			}
			terminalNegativeReviewEligible = isDelegationTerminalNegativeReviewEligibleFromCommittedV1(
				committed.value.state,
				committed.value.records,
			);
		}
		const exactRepairResolution = authority.kind === "v2" &&
			(authority.semanticRepair !== undefined ||
				(!terminalNegativeReviewEligible &&
					["ABORTED", "FAILED", "INTERRUPTED", "RECOVERY_REQUIRED"].includes(authority.transactionStatus)))
			? await hasExecutableExactRepairAuthorityV1({ projectRoot, delegationId, exec, services })
			: undefined;
		const classified = classifyDelegationRepairStatusV1({
			delegationId,
			authority,
			binding,
			retryable: exactRepairResolution !== undefined,
			terminalNegativeReviewEligible,
		});
		let resolution = exactRepairResolution;
		if (resolution === undefined &&
			(classified.kind === "terminal_negative_review" || classified.kind === "repair_review")) {
			resolution = await reviewLifecycleResolutionV1({ projectRoot, delegationId, services });
		}
		if (resolution === undefined && services.readInactiveLifecycle !== undefined && [
			"delegation_active",
			"delegation_retry",
			"delegation_recovery",
			"repair_required",
			"repair_retry",
			"repair_active",
			"repair_recovery",
		].includes(classified.kind)) {
			const inactive = await services.readInactiveLifecycle({
				project_root: projectRoot,
				exec,
				expected_delegation_id: delegationId,
			});
			if (inactive.ok) resolution = inactive.resolution;
		}
		return resolution === undefined ? classified : { ...classified, resolution };
	} catch {
		return withCompatibilityResolutionV1({
			kind: "authority_invalid",
			delegationId: state.latestId ?? null,
			code: "status_unavailable",
		});
	}
}

/** Bounded next action shared by live status and the compact mirror. */
export function delegationNextActionTextV1(
	state: DelegationState,
	repair: DelegationRepairStatusV1 = { kind: "none" },
): string | undefined {
	const resolution = delegationLifecycleResolutionForStatusV1(state, repair);
	return delegationLifecycleActionTextV1(resolution.primary_action);
}

/** One canonical lifecycle projection shared by status, mode and Gate boundaries. */
export function delegationLifecycleResolutionForStatusV1(
	state: DelegationState,
	repair: DelegationRepairStatusV1 = { kind: "none" },
): DelegationLifecycleResolutionV1 {
	return repair.kind === "none"
		? compatibilityLifecycleResolutionV1(repair, state)
		: repair.resolution ?? compatibilityLifecycleResolutionV1(repair, state);
}

/** VERIFY blocks on the resolver action, never on a stale session-status label. */
export function delegationVerifyBlockReasonV1(
	state: DelegationState,
	repair: DelegationRepairStatusV1 = { kind: "none" },
): string | undefined {
	const action = delegationLifecycleResolutionForStatusV1(state, repair).primary_action;
	if (action.action === "CONTINUE_DEVELOPMENT") return undefined;
	const target = action.exact_target.kind === "DELEGATION"
		? `delegation ${action.exact_target.id}`
		: `project authority ${action.exact_target.id}`;
	return `VERIFY mode / final gate verification is blocked by canonical lifecycle action ${action.action} (${action.reason}) for ${target}; ${delegationLifecycleActionTextV1(action)}`;
}

/** Human-readable strict repair facts; hashes are shown, free-form reasons are not. */
function delegationRepairStatusBaseLinesV1(status: DelegationRepairStatusV1): string[] {
	if (status.kind === "none") return [];
	if (status.kind === "derived_review_invalid") {
		return [
			`review state : DERIVED_INVALID (${status.code}); transaction and committed generation remain readable`,
		];
	}
	if (status.kind === "authority_invalid") {
		return [`repair state : INVALID (${status.code}); no repair or Gate authority is inferred`];
	}
	if (status.kind === "historical_multiplicity") {
		return [
			`repair state : HISTORICAL_MULTIPLICITY (${status.code}); authority corruption is not inferred`,
			"delegation   : ordinary starts require strict full-project path-lane admission; overlap or unknown authority remains BLOCKED",
			"verify block : VERIFY remains BLOCKED while any historical blocker is unresolved",
		];
	}
	if (status.kind === "delegation_active") {
		return [
			`execution v2 : ${status.transactionStatus} — review is not available yet`,
		];
	}
	if (status.kind === "delegation_retry") {
		return [
			`completion v2: ${status.transactionStatus} — review is not the recovery path`,
			`repair bind  : ${status.binding}`,
		];
	}
	if (status.kind === "delegation_recovery") {
		return [
			`completion v2: ${status.transactionStatus} — strict recovery is required`,
		];
	}
	if (status.kind === "terminal_negative_review") {
		return [
			`completion v2: ${status.transactionStatus} — committed non-empty delta requires REPAIR-only Sol review`,
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
		return lines;
	}
	if (status.kind === "repair_terminal_retry") {
		return [
			`semantic v2  : UNRESOLVED REPAIR (${status.transactionStatus}); Gate remains BLOCKED`,
			`repair lineage: depth ${status.depth} ${status.lineageHash}`,
			`root decision : ${status.rootDecisionHash}`,
			`repair bind  : ${status.binding}`,
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
		lines.push(`semantic v2  : UNRESOLVED REPAIR (${status.transactionStatus}); Gate remains BLOCKED`);
	}
	return lines;
}

/** Render exactly one canonical typed action and one derived instruction. */
export function delegationRepairStatusLinesV1(
	status: DelegationRepairStatusV1,
	state?: DelegationState,
): string[] {
	const lines = delegationRepairStatusBaseLinesV1(status);
	if (status.kind === "none" && state === undefined) return lines;
	const resolution = delegationLifecycleResolutionForStatusV1(state ?? emptyDelegationState(), status);
	const actionLines = [
		`typed action : ${resolution.primary_action.action} (${resolution.primary_action.reason})`,
		`next action  : ${delegationLifecycleActionTextV1(resolution.primary_action)}`,
	];
	if (lines.length === 0) return actionLines;
	return [
		lines[0]!,
		...actionLines,
		...lines.slice(1),
	];
}

/** v1 compatibility line derived only from the resolver's exact-repair action. */
export function delegationExactRepairRouteLineV1(status: DelegationRepairStatusV1): string | undefined {
	if (status.kind === "none") return undefined;
	const resolution = delegationLifecycleResolutionForStatusV1(emptyDelegationState(), status);
	return resolution.primary_action.action === "EXECUTE_EXACT_REPAIR"
		? `repair route : ALLOWED — ordinary/new delegations remain blocked; ${delegationLifecycleActionTextV1(resolution.primary_action)}`
		: undefined;
}
