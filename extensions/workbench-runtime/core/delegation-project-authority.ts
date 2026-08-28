import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { canonicalHash } from "../cache/canonical-hash.ts";
import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import {
	validateDelegationCommandProvenance,
	type DelegationCommandProvenanceRecord,
} from "./delegation-command-effect-provenance.ts";
import type { ExecFn } from "./config.ts";
import { bindDelegationBoundedTaskContractV2 } from "./delegation-transaction-artifacts.ts";
import {
	collectGitFacts,
	computeDiffHash,
	delegationsDir,
	isValidDelegationId,
	readDelegationLedger,
} from "./delegation-ledger.ts";
import {
	observeDiffChange,
	type DelegationState,
} from "./delegation-state.ts";
import {
	hasDelegationSemanticRepairAuthorityV2,
	hasDelegationSemanticReviewAuthorityV2,
	isDelegationTerminalNegativeReviewEligibleFromCommittedV1,
	readDelegationCommittedGenerationV2,
	readDelegationCurrentSemanticRepairDecisionV1,
	readDelegationImmutableReviewSidecarPresenceV1,
	readDelegationReviewV2,
	readDelegationSemanticRepairDecisionV1,
	readDelegationTransactionV2,
	type DelegationSemanticRepairDecisionV1,
	type DelegationTransactionStorageErrorCode,
} from "./delegation-transaction-storage.ts";
import {
	publishDelegationCleanRepairAbandonmentV1,
	readDelegationCleanRepairAbandonmentV1,
	type DelegationCleanRepairAbandonmentV1,
} from "./delegation-repair-abandonment.ts";
import {
	publishDelegationAuthorityQuarantineV1,
	publishDelegationInactiveBlockerClosureV2,
	inactiveBlockerRelevantPathsV2,
	isDelegationEmptyRepairAttemptSupersessionV1,
	readDelegationInactiveBlockerRelevantScopeV2,
	readDelegationAuthorityInventoryFactsV1,
	readDelegationAuthorityQuarantineV1,
	readDelegationInactiveBlockerClosureV2,
	type DelegationAuthorityQuarantineV1,
	type DelegationInactiveBlockerClosureV2,
} from "./delegation-authority-closure.ts";
import {
	DELEGATION_TRANSACTION_ID_RE,
	type DelegationRepairLineageV1,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import { DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2 } from "./delegation-workspace-v2.ts";
import {
	hasStrictReleasedRepairRecoveryEnvelopeV2,
	readDelegationExecutionOwnerV2,
	recoverInterruptedDelegationV2,
	releaseOrphanedTerminalExecutionOwnerV2,
	isStrictRetryableAbortedRepairV2,
	isStrictRetryableEmptyRepairRecoveryV2,
	readStrictRetryableRawRepairEvidenceV1,
	type DelegationExecutionOwnerOptionsV2,
} from "./delegation-execution-owner.ts";
import {
	isStrictSemanticAcceptedOrZeroDelta,
	readReviewRecord,
	type ReviewRecord,
} from "./diff-review.ts";
import {
	collectReviewRelevanceV2,
	computeReviewRelevanceConflictHashV2,
	REVIEW_RELEVANCE_KIND_V2,
} from "./review-relevance-v2.ts";
import { collectWorkspaceGuard, validateWorkspaceGuard, type WorkspaceGuardRecord } from "./workspace-guard.ts";
import { readWorkerWriteJournal, type WorkerWriteJournalRecord } from "./write-journal.ts";
import { collectHistoricalSemanticMigration } from "./historical-semantic-migration.ts";
import { planReferenceHash } from "./plan-reference.ts";
import { withProjectDelegationStartLockV1 } from "./delegation-start-lock.ts";
import {
	executeDelegationLifecycleEffectV1,
	type DelegationLifecycleEffectFailureCodeV1,
} from "./delegation-lifecycle-effect.ts";
import {
	DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
	delegationLifecycleSnapshotFromCleanRepairClosureV1,
	delegationLifecycleSnapshotFromInactiveBlockerClosureV1,
	delegationLifecycleSnapshotFromInvalidDerivedReviewV1,
	resolveDelegationLifecycleV1,
	type DelegationLifecycleResolutionV1,
	type DelegationLifecycleSnapshotV1,
} from "./delegation-lifecycle-resolver.ts";

/**
 * Legacy compatibility constant retained for downstream imports. Discovery no
 * longer turns this threshold into a permanent project blocker: a trusted
 * project's complete history is audited, while individual records and files
 * remain strictly size-bounded.
 */
export const MAX_PROJECT_DELEGATION_ENTRIES_V2 = 10_000 as const;

export type ProjectDelegationAuthorityErrorCodeV2 =
	| "invalid_project_authority"
	| "storage_failure"
	| "too_many_delegations";

export type ProjectDelegationAuthorityCauseV2 = DelegationTransactionStorageErrorCode
	| "authority_quarantine_invalid"
	| "authority_not_quarantinable";

export type LatestProjectDelegationTransactionV2Result =
	| { ok: true; value: DelegationTransactionRecord | null }
	| {
		ok: false;
		error: {
			code: ProjectDelegationAuthorityErrorCodeV2;
			delegation_id?: string;
			cause?: ProjectDelegationAuthorityCauseV2;
		};
	};

export interface ProjectDelegationDispositionV2 {
	blocking: boolean;
	terminal_verdict: "PASS" | "FAIL" | null;
}

export type CurrentDelegationBindingV2 =
	| { status: "fresh"; hash: string; kind: "changeset-relevance-v2" | "legacy-full-diff" | "historical-semantic-migration-v1" }
	| { status: "conflict"; hash: string; kind: "changeset-relevance-v2" | "historical-semantic-migration-v1"; code: string }
	| { status: "unavailable" };

export type DelegationAuthorityObservationV2 =
	| {
		kind: "v2";
		transactionStatus: string;
		transactionVerdict: "PASS" | "FAIL" | null;
		review: ReviewRecord | null;
		reviewPath: string | null;
		finalized: boolean;
		semanticAccepted: boolean;
		semanticBindingHash: string | null;
		semanticSource: "embedded" | "migration" | "not_required" | null;
		semanticReviewer: string | null;
		semanticAcceptedAt: string | null;
		semanticRepair?: {
			decisionHash: string;
			reasonHash: string;
			expectedBindingHash: string;
			reviewer: string;
			decidedAt: string;
		};
		repairLineage?: {
			rootDelegationId: string;
			repairOf: string;
			rootDecisionHash: string;
			continuationDecisionDelegationId: string;
			continuationDecisionHash: string;
			lineageHash: string;
			depth: number;
			carriedPathCount: number;
		};
	}
	| { kind: "legacy"; review: ReviewRecord | null; zeroDelta: boolean }
	| {
		kind: "derived-review-invalid";
		transactionStatus: "PENDING_REVIEW";
		code: "invalid_record";
		resolution: DelegationLifecycleResolutionV1;
	}
	| { kind: "invalid-v2"; code: string };

export interface ProjectDelegationAuthorityIssueV2 {
	code: string;
	delegationId?: string;
}

export type ProjectDelegationRepairClosureV1 =
	| { ok: true; unresolvedTipId: string | null; rootCount: number; lineageCount: number }
	| { ok: false; issue: ProjectDelegationAuthorityIssueV2 };

export interface DelegationRepairObligationProjectionV1 {
	readonly schema_version: 1;
	readonly kind: "delegation-repair-obligation-projection-v1";
	readonly source_authority_hash: string;
	readonly historical_obligation_count: number;
	readonly historical_attempt_count: number;
	readonly unresolved_obligations: readonly [] | readonly [{
		readonly obligation_id: string;
		readonly current_attempt_id: string;
		readonly legacy_attempt_depth: number;
	}];
	readonly recovery_rank: {
		readonly unresolved_obligations: 0 | 1;
		readonly unresolved_attempts: 0 | 1;
	};
	readonly projection_hash: string;
}

export type ProjectDelegationRepairObligationProjectionResultV1 =
	| { ok: true; value: DelegationRepairObligationProjectionV1 }
	| { ok: false; issue: ProjectDelegationAuthorityIssueV2 };

export type ReconcileProjectDelegationAuthorityV2Result =
	| { ok: false; issue: ProjectDelegationAuthorityIssueV2 }
	| { ok: true; state: DelegationState | null };

export type AbandonCleanProjectDelegationRepairV1Result =
	| { ok: true; value: DelegationCleanRepairAbandonmentV1; lifecycle_resolution?: DelegationLifecycleResolutionV1 }
	| { ok: false; code: string; delegation_id?: string };

export type CloseInactiveProjectDelegationBlockerV2Result =
	| {
		ok: true;
		value: DelegationInactiveBlockerClosureV2;
		closed_delegation_ids: readonly string[];
		remaining_blocker_id?: string;
		lifecycle_resolution?: DelegationLifecycleResolutionV1;
	}
	| { ok: false; code: string; delegation_id?: string };

export type QuarantineProjectDelegationAuthorityV1Result =
	| { ok: true; value: DelegationAuthorityQuarantineV1 }
	| { ok: false; code: string; delegation_id?: string };

export type ProjectDelegationBlockerV2Result =
	| { ok: true; value: DelegationTransactionRecord | null }
	| { ok: false; issue: ProjectDelegationAuthorityIssueV2 };

export type RecoverableUnpublishedDelegationV2Result =
	| {
		ok: true;
		value: {
			transaction: DelegationTransactionRecord;
			journal: WorkerWriteJournalRecord;
		};
	}
	| { ok: false; error: { code: "not_found" | "not_recoverable" | "invalid_record" | "storage_failure" } };

const RECOVERABLE_ARTIFACT_FAILURE_REASONS = new Set([
	"committed artifact construction failed",
	"committed artifact construction failed: invalid_contract",
	"committed artifact construction failed: invalid_state",
	"committed artifact construction failed: binding_conflict",
	"committed artifact construction failed: invalid_facts",
	"committed artifact construction failed: invalid_report",
	"committed artifact construction failed: review_envelope_exceeded",
	"committed artifact construction failed: record_too_large",
	"committed artifact construction failed: internal_error",
]);

function failure(
	code: ProjectDelegationAuthorityErrorCodeV2,
	delegationId?: string,
	cause?: ProjectDelegationAuthorityCauseV2,
): LatestProjectDelegationTransactionV2Result {
	return {
		ok: false,
		error: {
			code,
			...(delegationId === undefined ? {} : { delegation_id: delegationId }),
			...(cause === undefined ? {} : { cause }),
		},
	};
}

function descendingAscii(left: string, right: string): number {
	return left === right ? 0 : left < right ? 1 : -1;
}

async function authorityIsQuarantinedV1(
	projectRoot: string,
	delegationId: string,
): Promise<{ ok: true; value: boolean } | { ok: false; issue: ProjectDelegationAuthorityIssueV2 }> {
	const quarantine = await readDelegationAuthorityQuarantineV1(projectRoot, delegationId);
	if (!quarantine.ok) {
		return {
			ok: false,
			issue: {
				code: quarantine.error.code === "invalid_record" ? "authority_quarantine_invalid" : quarantine.error.code,
				delegationId,
			},
		};
	}
	return { ok: true, value: quarantine.value !== undefined };
}

function repairObservation(
	transaction: DelegationTransactionRecord,
	decision?: DelegationSemanticRepairDecisionV1,
): Pick<Extract<DelegationAuthorityObservationV2, { kind: "v2" }>, "semanticRepair" | "repairLineage"> {
	const lineage: DelegationRepairLineageV1 | undefined = transaction.repair_lineage;
	return {
		...(decision === undefined ? {} : {
			semanticRepair: {
				decisionHash: decision.decision_hash,
				reasonHash: decision.repair_reason_hash,
				expectedBindingHash: decision.expected_bound_diff_hash,
				reviewer: `${decision.reviewer.provider}/${decision.reviewer.model}`,
				decidedAt: decision.decided_at,
			},
		}),
		...(lineage === undefined ? {} : {
			repairLineage: {
				rootDelegationId: lineage.root_delegation_id,
				repairOf: lineage.repair_of,
				rootDecisionHash: lineage.root_decision_hash,
				continuationDecisionDelegationId: lineage.continuation_decision_delegation_id,
				continuationDecisionHash: lineage.continuation_decision_hash,
				lineageHash: lineage.lineage_hash,
				depth: lineage.depth,
				carriedPathCount: lineage.carried_paths.length,
			},
		}),
	};
}

/**
 * Discover the newest durable v2 transaction already present in the project.
 *
 * Directory ids provide the coarse creation order. All ids in the newest
 * timestamp group are read strictly, then canonical `created_at` plus id is
 * used as a deterministic tie-break. A corrupt newest v2 record fails closed;
 * it is never skipped in favour of an older optimistic authority.
 */
export async function readLatestProjectDelegationTransactionV2(
	projectRoot: string,
): Promise<LatestProjectDelegationTransactionV2Result> {
	const root = delegationsDir(projectRoot);
	let entries: Dirent<string>[];
	try {
		const stat = await lstat(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return failure("invalid_project_authority");
		entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: null };
		return failure("storage_failure");
	}

	const candidates: string[] = [];
	for (const entry of entries) {
		if (!isValidDelegationId(entry.name)) continue;
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			return failure("invalid_project_authority", entry.name);
		}
		try {
			const stat = await lstat(join(root, entry.name));
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				return failure("invalid_project_authority", entry.name);
			}
		} catch {
			return failure("storage_failure", entry.name);
		}
		candidates.push(entry.name);
	}

	candidates.sort(descendingAscii);
	for (let offset = 0; offset < candidates.length;) {
		const timestamp = candidates[offset]!.slice(0, 15);
		const group: string[] = [];
		while (offset < candidates.length && candidates[offset]!.slice(0, 15) === timestamp) {
			group.push(candidates[offset]!);
			offset += 1;
		}

		const found: DelegationTransactionRecord[] = [];
		for (const delegationId of group) {
			const transaction = await readDelegationTransactionV2(projectRoot, delegationId);
			if (transaction.ok) {
				if (transaction.value.delegation_id !== delegationId) {
					return failure("invalid_project_authority", delegationId, "invalid_record");
				}
				found.push(transaction.value);
				continue;
			}
			const quarantine = await authorityIsQuarantinedV1(projectRoot, delegationId);
			if (!quarantine.ok) {
				const cause: ProjectDelegationAuthorityCauseV2 = quarantine.issue.code === "authority_quarantine_invalid"
					? "authority_quarantine_invalid"
					: quarantine.issue.code === "not_recoverable" ? "authority_not_quarantinable"
						: quarantine.issue.code === "storage_failure" ? "storage_failure" : "invalid_record";
				return failure("invalid_project_authority", delegationId, cause);
			}
			if (quarantine.value) continue;
			if (transaction.error.code !== "not_found") return failure("invalid_project_authority", delegationId, transaction.error.code);
		}
		if (found.length > 0) {
			found.sort((left, right) => {
				const timeOrder = descendingAscii(left.created_at, right.created_at);
				return timeOrder !== 0 ? timeOrder : descendingAscii(left.delegation_id, right.delegation_id);
			});
			return { ok: true, value: found[0]! };
		}
	}
	return { ok: true, value: null };
}

/**
 * Strictly recognize the one unpublished recovery shape that may be
 * superseded by an explicit `repair_of` delegation.  The old transaction and
 * sealed journal remain immutable evidence; this helper never marks them as
 * reviewed and never reconstructs missing worker/report facts.
 */
export async function readRecoverableUnpublishedDelegationV2(
	projectRoot: string,
	delegationId: string,
): Promise<RecoverableUnpublishedDelegationV2Result> {
	const transaction = await readDelegationTransactionV2(projectRoot, delegationId);
	if (!transaction.ok) {
		return {
			ok: false,
			error: {
				code: transaction.error.code === "not_found"
					? "not_found"
					: transaction.error.code === "storage_failure"
						? "storage_failure"
						: "invalid_record",
			},
		};
	}
	const state = transaction.value;
	const outcome = state.terminal_outcome;
	if (state.status !== "RECOVERY_REQUIRED" || state.revision !== 3 || state.committed_proof !== null ||
		state.review !== null || outcome === null || !outcome.terminal_facts_complete || !outcome.scope_complete ||
		state.recovery_reason === null || !RECOVERABLE_ARTIFACT_FAILURE_REASONS.has(state.recovery_reason)) {
		return { ok: false, error: { code: "not_recoverable" } };
	}

	const journal = await readWorkerWriteJournal({
		project_root: projectRoot,
		delegation_id: delegationId,
		contract_hash: state.contract_hash,
	});
	if (!journal.ok) {
		return {
			ok: false,
			error: {
				code: journal.error.code === "not_found"
					? "not_found"
					: journal.error.code === "storage_failure"
						? "storage_failure"
						: "invalid_record",
			},
		};
	}
	if (journal.value.state !== "SEALED" || journal.value.journal_hash === null ||
		journal.value.operations.some((operation) => operation.status !== "completed")) {
		return { ok: false, error: { code: "not_recoverable" } };
	}

	const generations = join(delegationsDir(projectRoot), delegationId, "v2", "generations");
	try {
		const stat = await lstat(generations);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			return { ok: false, error: { code: "invalid_record" } };
		}
		if ((await readdir(generations)).length !== 0) {
			return { ok: false, error: { code: "not_recoverable" } };
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return { ok: false, error: { code: "storage_failure" } };
		}
	}
	if (!await hasStrictReleasedRepairRecoveryEnvelopeV2(projectRoot, state)) {
		return { ok: false, error: { code: "not_recoverable" } };
	}
	return { ok: true, value: { transaction: state, journal: journal.value } };
}

function pathSubset(left: readonly string[], right: readonly string[]): boolean {
	const available = new Set(right);
	return left.every((path) => available.has(path));
}

function exactByteSortedUnion(...groups: readonly (readonly string[])[]): string[] {
	return [...new Set(groups.flat())].sort((left, right) =>
		Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function strictLineageChangeSet(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
): Promise<{ ok: true; value: ChangeSetRecord | null } | { ok: false }> {
	if (transaction.committed_proof === null) return { ok: true, value: null };
	const committed = await readDelegationCommittedGenerationV2(projectRoot, transaction.delegation_id);
	if (!committed.ok) return { ok: false };
	const scope = committed.value.records["scope.json"];
	if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return { ok: false };
	const changeSet = (scope as Record<string, unknown>).change_set;
	if (!validateChangeSet(changeSet)) return { ok: false };
	const typed = changeSet as ChangeSetRecord;
	const command = Object.prototype.hasOwnProperty.call(scope, "command_provenance")
		? (scope as Record<string, unknown>).command_provenance as DelegationCommandProvenanceRecord
		: undefined;
	if (command !== undefined && !validateDelegationCommandProvenance(command, typed)) return { ok: false };
	if (typed.delegation_id !== transaction.delegation_id || typed.contract_hash !== transaction.contract_hash ||
		transaction.terminal_outcome === null || transaction.terminal_outcome.delta_hash !== (command?.effective_delta_hash ?? typed.worker_delta_hash) ||
		transaction.terminal_outcome.change_set_status !== (command?.effective_status ?? typed.status)) return { ok: false };
	return { ok: true, value: typed };
}

async function strictCommittedPlanHash(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
): Promise<{ ok: true; value: string | null } | { ok: false }> {
	if (transaction.committed_proof === null) return { ok: false };
	const committed = await readDelegationCommittedGenerationV2(projectRoot, transaction.delegation_id);
	if (!committed.ok) return { ok: false };
	const before = committed.value.records["before.json"];
	if (before === null || typeof before !== "object" || Array.isArray(before)) return { ok: false };
	const contract = (before as Record<string, unknown>).contract;
	if (contract === null || typeof contract !== "object" || Array.isArray(contract)) return { ok: false };
	const { contract_hash: suppliedHash, ...payload } = contract as Record<string, unknown>;
	const rebound = bindDelegationBoundedTaskContractV2(payload);
	if (!rebound.ok || suppliedHash !== rebound.value.contract_hash || suppliedHash !== transaction.contract_hash) return { ok: false };
	if (rebound.value.plan_ref === undefined) return { ok: true, value: null };
	const hash = planReferenceHash(rebound.value.plan_ref);
	return hash === null ? { ok: false } : { ok: true, value: hash };
}

async function validRepairParentState(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
	semanticRepairPresent: boolean,
): Promise<boolean> {
	if (transaction.status === "PENDING_REVIEW") return semanticRepairPresent;
	if (transaction.status === "ABORTED") return isStrictRetryableAbortedRepairV2(projectRoot, transaction);
	if (transaction.status === "INTERRUPTED") {
		return semanticRepairPresent && (await strictLineageChangeSet(projectRoot, transaction)).ok;
	}
	if (transaction.status === "FAILED") {
		return (semanticRepairPresent || transaction.repair_lineage !== undefined)
			&& (await strictLineageChangeSet(projectRoot, transaction)).ok;
	}
	if (transaction.status !== "RECOVERY_REQUIRED" || transaction.repair_lineage === undefined) return false;
	if (transaction.committed_proof !== null) return (await strictLineageChangeSet(projectRoot, transaction)).ok;
	if (await isStrictRetryableEmptyRepairRecoveryV2(projectRoot, transaction)) return true;
	return (await readRecoverableUnpublishedDelegationV2(projectRoot, transaction.delegation_id)).ok;
}

/**
 * Prove that an unrelated v2 transaction created after an unresolved repair
 * tip cannot itself require recovery, review, or repair. This deliberately
 * avoids readDelegationAuthorityObservationV2 because that reader audits this
 * closure and would recurse.
 */
async function isStrictNonBlockingUnrelatedTransactionV2(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
): Promise<boolean> {
	const closed = await readDelegationInactiveBlockerClosureV2(projectRoot, transaction);
	if (!closed.ok) return false;
	if (closed.value !== undefined) return true;
	if (transaction.repair_lineage !== undefined) return false;
	if (transaction.status === "ABORTED") return true;
	if (transaction.status === "FINISHED") {
		const committed = await readDelegationCommittedGenerationV2(projectRoot, transaction.delegation_id);
		return committed.ok
			&& committed.value.state.task_kind === "diagnosis"
			&& committed.value.state.status === "FINISHED"
			&& committed.value.state.terminal_outcome !== null
			&& committed.value.state.postcondition_reasons.length === 0;
	}
	if (transaction.status === "REVIEWED") {
		const review = await readDelegationReviewV2(projectRoot, transaction.delegation_id);
		return review.ok && review.value.finalized && hasDelegationSemanticReviewAuthorityV2(review.value);
	}
	if (transaction.status === "FAILED"
		&& transaction.terminal_outcome?.change_set_status === "ATTRIBUTED"
		&& transaction.terminal_outcome.changed_paths.length === 0) {
		const committed = await readDelegationCommittedGenerationV2(projectRoot, transaction.delegation_id);
		return committed.ok && committed.value.state.status === "FAILED";
	}
	return false;
}

/**
 * Audit every durable semantic-repair obligation, not only the newest id.
 * A unique linear chain may leave exactly one unresolved latest tip. Any
 * hidden root, fork, broken edge, missing continuation decision, or sibling
 * remains project-blocking so a newer optimistic record cannot launder it.
 */
export async function readProjectDelegationRepairClosureV1(
	projectRoot: string,
): Promise<ProjectDelegationRepairClosureV1> {
	const root = delegationsDir(projectRoot);
	let entries: Dirent<string>[];
	try {
		const stat = await lstat(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, issue: { code: "invalid_project_authority" } };
		entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { ok: true, unresolvedTipId: null, rootCount: 0, lineageCount: 0 }
			: { ok: false, issue: { code: "storage_failure" } };
	}
	const transactions = new Map<string, DelegationTransactionRecord>();
	for (const entry of entries) {
		if (!isValidDelegationId(entry.name)) continue;
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			return { ok: false, issue: { code: "invalid_project_authority", delegationId: entry.name } };
		}
		const transaction = await readDelegationTransactionV2(projectRoot, entry.name);
		if (transaction.ok && transaction.value.delegation_id === entry.name) transactions.set(entry.name, transaction.value);
		else if (transaction.ok) {
			return { ok: false, issue: { code: "repair_lineage_identity_mismatch", delegationId: entry.name } };
		}
		else {
			const quarantine = await authorityIsQuarantinedV1(projectRoot, entry.name);
			if (!quarantine.ok) return { ok: false, issue: quarantine.issue };
			if (quarantine.value) continue;
			if (transaction.error.code !== "not_found") {
				return { ok: false, issue: { code: transaction.error.code, delegationId: entry.name } };
			}
			try {
				const v2 = await lstat(join(root, entry.name, "v2"));
				if (v2.isDirectory() || v2.isFile() || v2.isSymbolicLink()) {
					return { ok: false, issue: { code: "incomplete_v2_authority", delegationId: entry.name } };
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					return { ok: false, issue: { code: "storage_failure", delegationId: entry.name } };
				}
			}
		}
	}
	if (transactions.size === 0) return { ok: true, unresolvedTipId: null, rootCount: 0, lineageCount: 0 };

	// A hash-bound zero-write supersession removes only the obsolete attempt
	// from lineage authority. Classify it before current-decision validation:
	// a parent may acquire a newer semantic decision after this attempt closed,
	// and that later decision must not make the already-superseded attempt a
	// permanent project blocker. The strict closure reader still revalidates the
	// exact terminal transaction and its no-write inventory.
	const supersededAttempts = new Set<string>();
	for (const transaction of transactions.values()) {
		if (transaction.repair_lineage === undefined) continue;
		const inactiveClosure = await readDelegationInactiveBlockerClosureV2(projectRoot, transaction);
		if (!inactiveClosure.ok) {
			return {
				ok: false,
				issue: {
					code: inactiveClosure.error.code === "invalid_record" ? "blocker_closure_invalid" : inactiveClosure.error.code,
					delegationId: transaction.delegation_id,
				},
			};
		}
		if (inactiveClosure.value !== undefined &&
			isDelegationEmptyRepairAttemptSupersessionV1(transaction, inactiveClosure.value)) {
			supersededAttempts.add(transaction.delegation_id);
		}
	}

	const decisions = new Map<string, DelegationSemanticRepairDecisionV1>();
	for (const transaction of transactions.values()) {
		if (transaction.status !== "PENDING_REVIEW"
			&& transaction.status !== "FAILED" && transaction.status !== "INTERRUPTED") continue;
		const committed = await readDelegationCommittedGenerationV2(projectRoot, transaction.delegation_id);
		if (!committed.ok) {
			return { ok: false, issue: { code: committed.error.code, delegationId: transaction.delegation_id } };
		}
		if (canonicalHash(committed.value.state) !== canonicalHash(transaction)) {
			return { ok: false, issue: { code: "invalid_record", delegationId: transaction.delegation_id } };
		}
		const read = await readDelegationCurrentSemanticRepairDecisionV1(projectRoot, committed.value);
		if (!read.ok) {
			return { ok: false, issue: { code: read.error.code, delegationId: transaction.delegation_id } };
		}
		if (read.value !== undefined) decisions.set(transaction.delegation_id, read.value);
	}
	const roots = new Map<string, DelegationTransactionRecord>();
	const lineaged = new Map<string, DelegationTransactionRecord>();
	for (const transaction of transactions.values()) {
		if (transaction.repair_lineage !== undefined) lineaged.set(transaction.delegation_id, transaction);
		else if (decisions.has(transaction.delegation_id)) roots.set(transaction.delegation_id, transaction);
	}
	if (roots.size === 0 && lineaged.size === 0) {
		return { ok: true, unresolvedTipId: null, rootCount: 0, lineageCount: 0 };
	}
	for (const transaction of lineaged.values()) {
		if (!supersededAttempts.has(transaction.delegation_id) &&
			supersededAttempts.has(transaction.repair_lineage!.repair_of)) {
			return {
				ok: false,
				issue: {
					code: "repair_lineage_superseded_attempt_has_child",
					delegationId: transaction.repair_lineage!.repair_of,
				},
			};
		}
	}
	for (const transaction of [...roots.values(), ...lineaged.values()]) {
		if (["PREPARED", "RUNNING", "COMMITTING"].includes(transaction.status)) continue;
		const owner = await readDelegationExecutionOwnerV2(projectRoot, transaction);
		if (owner.ok) {
			return { ok: false, issue: { code: "repair_lineage_execution_owner_present", delegationId: transaction.delegation_id } };
		}
		if (owner.error.code !== "not_found") {
			return { ok: false, issue: { code: owner.error.code, delegationId: transaction.delegation_id } };
		}
	}

	const children = new Map<string, string[]>();
	for (const transaction of lineaged.values()) {
		if (supersededAttempts.has(transaction.delegation_id)) continue;
		const lineage = transaction.repair_lineage!;
		const rootTransaction = roots.get(lineage.root_delegation_id);
		const rootDecision = decisions.get(lineage.root_delegation_id);
		const parent = transactions.get(lineage.repair_of);
		if (rootTransaction === undefined || rootDecision === undefined || parent === undefined ||
			rootDecision.decision_hash !== lineage.root_decision_hash) {
			return { ok: false, issue: { code: "repair_lineage_root_invalid", delegationId: transaction.delegation_id } };
		}
		const rootPlan = await strictCommittedPlanHash(projectRoot, rootTransaction);
		if (!rootPlan.ok) return { ok: false, issue: { code: "repair_lineage_plan_invalid", delegationId: transaction.delegation_id } };
		if (transaction.committed_proof !== null) {
			const childPlan = await strictCommittedPlanHash(projectRoot, transaction);
			if (!childPlan.ok || childPlan.value !== rootPlan.value) {
				return { ok: false, issue: { code: "repair_lineage_plan_invalid", delegationId: transaction.delegation_id } };
			}
		}
		const continuation = decisions.get(lineage.continuation_decision_delegation_id);
		if (continuation === undefined || continuation.decision_hash !== lineage.continuation_decision_hash) {
			return { ok: false, issue: { code: "repair_lineage_continuation_invalid", delegationId: transaction.delegation_id } };
		}
		if (parent.created_at > transaction.created_at || rootDecision.decided_at > transaction.created_at ||
			continuation.decided_at > transaction.created_at) {
			return { ok: false, issue: { code: "repair_lineage_order_invalid", delegationId: transaction.delegation_id } };
		}
		if (lineage.depth === 1) {
			if (parent.delegation_id !== lineage.root_delegation_id || parent.repair_lineage !== undefined ||
				lineage.parent_lineage_hash !== null || lineage.continuation_decision_delegation_id !== parent.delegation_id ||
				lineage.continuation_decision_hash !== rootDecision.decision_hash) {
				return { ok: false, issue: { code: "repair_lineage_edge_invalid", delegationId: transaction.delegation_id } };
			}
		} else {
			const parentLineage = parent.repair_lineage;
			if (parentLineage === undefined || lineage.parent_lineage_hash !== parentLineage.lineage_hash ||
				parentLineage.root_delegation_id !== lineage.root_delegation_id ||
				lineage.depth !== Math.min(parentLineage.depth + 1, 16) ||
				!pathSubset(parentLineage.carried_paths, lineage.carried_paths)) {
				return { ok: false, issue: { code: "repair_lineage_edge_invalid", delegationId: transaction.delegation_id } };
			}
			const parentDecision = decisions.get(parent.delegation_id);
			if (parentDecision !== undefined) {
				const bindsCurrentParent = lineage.continuation_decision_delegation_id === parent.delegation_id &&
					lineage.continuation_decision_hash === parentDecision.decision_hash;
				if (!bindsCurrentParent) {
					const inheritsPriorParentAuthority =
						lineage.continuation_decision_delegation_id === parentLineage.continuation_decision_delegation_id &&
						lineage.continuation_decision_hash === parentLineage.continuation_decision_hash;
					let hasOwnSemanticAuthority = decisions.has(transaction.delegation_id);
					if (!hasOwnSemanticAuthority && transaction.status === "REVIEWED") {
						const review = await readDelegationReviewV2(projectRoot, transaction.delegation_id);
						if (!review.ok) {
							return { ok: false, issue: { code: review.error.code, delegationId: transaction.delegation_id } };
						}
						hasOwnSemanticAuthority = hasDelegationSemanticReviewAuthorityV2(review.value);
					}
					// Historical runtimes could create a child from the parent's
					// inherited continuation even after the parent received a newer
					// decision. The exact child becomes recoverable only after Sol
					// independently binds that child with REPAIR or ACCEPT authority.
					if (!inheritsPriorParentAuthority || !hasOwnSemanticAuthority) {
						return { ok: false, issue: { code: "repair_lineage_continuation_invalid", delegationId: transaction.delegation_id } };
					}
				}
			} else if (lineage.continuation_decision_delegation_id !== parentLineage.continuation_decision_delegation_id ||
				lineage.continuation_decision_hash !== parentLineage.continuation_decision_hash) {
				return { ok: false, issue: { code: "repair_lineage_continuation_invalid", delegationId: transaction.delegation_id } };
			}
		}
		if (!await validRepairParentState(projectRoot, parent, decisions.has(parent.delegation_id))) {
			return { ok: false, issue: { code: "repair_lineage_parent_invalid", delegationId: transaction.delegation_id } };
		}
		const parentChangeSet = await strictLineageChangeSet(projectRoot, parent);
		if (!parentChangeSet.ok) return { ok: false, issue: { code: "repair_lineage_parent_invalid", delegationId: transaction.delegation_id } };
		const required = exactByteSortedUnion(
			parent.repair_lineage?.carried_paths ?? [],
			parentChangeSet.value?.dependency_paths ?? [],
			parent.terminal_outcome?.changed_paths ?? [],
		);
		// carried_paths are immutable review/conflict dependencies, not worker
		// write capabilities. Historical writers conservatively included the
		// exact repair targets as well as W/D, so a hash-bound superset is valid.
		// Missing a required parent path remains fail-closed.
		if (!pathSubset(required, lineage.carried_paths)) {
			return { ok: false, issue: { code: "repair_lineage_scope_invalid", delegationId: transaction.delegation_id } };
		}
		const siblings = children.get(parent.delegation_id) ?? [];
		siblings.push(transaction.delegation_id);
		children.set(parent.delegation_id, siblings);
		if (siblings.length > 1) {
			return { ok: false, issue: { code: "repair_lineage_fork", delegationId: parent.delegation_id } };
		}
	}

	const reached = new Set<string>(supersededAttempts);
	const unresolved: string[] = [];
	for (const rootTransaction of roots.values()) {
		let current = rootTransaction;
		const seen = new Set<string>();
		while (true) {
			if (seen.has(current.delegation_id)) {
				return { ok: false, issue: { code: "repair_lineage_cycle", delegationId: current.delegation_id } };
			}
			seen.add(current.delegation_id);
			if (current.repair_lineage !== undefined) reached.add(current.delegation_id);
			const next = children.get(current.delegation_id)?.[0];
			if (next === undefined) break;
			const child = lineaged.get(next);
			if (child === undefined) return { ok: false, issue: { code: "repair_lineage_edge_invalid", delegationId: next } };
			current = child;
		}
		const rootDecision = decisions.get(rootTransaction.delegation_id);
		if (rootDecision === undefined) {
			return { ok: false, issue: { code: "repair_lineage_root_invalid", delegationId: rootTransaction.delegation_id } };
		}
		const abandonment = await readDelegationCleanRepairAbandonmentV1(projectRoot, current, rootDecision);
		if (!abandonment.ok) {
			return {
				ok: false,
				issue: {
					code: abandonment.error.code === "invalid_record" ? "repair_abandonment_invalid" : abandonment.error.code,
					delegationId: current.delegation_id,
				},
			};
		}
		let closed = abandonment.value !== undefined;
		const inactiveClosure = await readDelegationInactiveBlockerClosureV2(projectRoot, current);
		if (!inactiveClosure.ok) {
			return {
				ok: false,
				issue: {
					code: inactiveClosure.error.code === "invalid_record" ? "blocker_closure_invalid" : inactiveClosure.error.code,
					delegationId: current.delegation_id,
				},
			};
		}
		closed ||= inactiveClosure.value !== undefined;
		if (current.repair_lineage !== undefined && current.status === "REVIEWED") {
			const review = await readDelegationReviewV2(projectRoot, current.delegation_id);
			closed ||= review.ok && hasDelegationSemanticReviewAuthorityV2(review.value);
		}
		if (!closed) unresolved.push(current.delegation_id);
	}
	if (reached.size !== lineaged.size) {
		const hidden = [...lineaged.keys()].find((id) => !reached.has(id));
		return { ok: false, issue: { code: "repair_lineage_unreachable", ...(hidden === undefined ? {} : { delegationId: hidden }) } };
	}
	if (unresolved.length > 1) {
		return { ok: false, issue: { code: "repair_lineage_multiple_unresolved", delegationId: unresolved[0] } };
	}
	const unresolvedTipId = unresolved[0];
	if (unresolvedTipId !== undefined) {
		const tip = transactions.get(unresolvedTipId);
		if (tip === undefined) {
			return { ok: false, issue: { code: "repair_lineage_edge_invalid", delegationId: unresolvedTipId } };
		}
		const obligationIds = new Set([...roots.keys(), ...reached]);
		for (const transaction of transactions.values()) {
			if (obligationIds.has(transaction.delegation_id) || transaction.created_at < tip.created_at) continue;
			if (!await isStrictNonBlockingUnrelatedTransactionV2(projectRoot, transaction)) {
				return {
					ok: false,
					issue: { code: "additional_unresolved_authority", delegationId: transaction.delegation_id },
				};
			}
		}
	}
	return {
		ok: true,
		unresolvedTipId: unresolvedTipId ?? null,
		rootCount: roots.size,
		lineageCount: lineaged.size,
	};
}

/**
 * Normalize the validated legacy repair-lineage graph into at most one current
 * obligation. Historical roots and attempts remain immutable audit counts;
 * retries do not become new obligations in this read-only projection.
 */
export async function readProjectDelegationRepairObligationProjectionV1(
	projectRoot: string,
): Promise<ProjectDelegationRepairObligationProjectionResultV1> {
	const closure = await readProjectDelegationRepairClosureV1(projectRoot);
	if (!closure.ok) return closure;
	let current:
		| { obligation_id: string; current_attempt_id: string; legacy_attempt_depth: number }
		| undefined;
	if (closure.unresolvedTipId !== null) {
		const tip = await readDelegationTransactionV2(projectRoot, closure.unresolvedTipId);
		if (!tip.ok) {
			return { ok: false, issue: { code: tip.error.code, delegationId: closure.unresolvedTipId } };
		}
		current = {
			obligation_id: tip.value.repair_lineage?.root_delegation_id ?? tip.value.delegation_id,
			current_attempt_id: tip.value.delegation_id,
			legacy_attempt_depth: tip.value.repair_lineage?.depth ?? 0,
		};
	}
	const unresolvedObligations = current === undefined ? [] as const : [current] as const;
	const recoveryRank = {
		unresolved_obligations: (current === undefined ? 0 : 1) as 0 | 1,
		unresolved_attempts: (current === undefined ? 0 : 1) as 0 | 1,
	};
	const sourceAuthorityHash = canonicalHash({
		kind: "delegation-repair-obligation-source-v1",
		closure,
		current: current ?? null,
	});
	const projection = {
		schema_version: 1 as const,
		kind: "delegation-repair-obligation-projection-v1" as const,
		source_authority_hash: sourceAuthorityHash,
		historical_obligation_count: closure.rootCount,
		historical_attempt_count: closure.rootCount + closure.lineageCount,
		unresolved_obligations: unresolvedObligations,
		recovery_rank: recoveryRank,
	};
	return { ok: true, value: { ...projection, projection_hash: canonicalHash(projection) } };
}

/**
 * Return the newest unresolved project blocker, including ordinary failed or
 * pending transactions that are outside a semantic-repair chain. A valid
 * non-acceptance closure removes only its exact inactive transaction from the
 * blocking set; malformed closures continue to fail closed.
 */
export async function readProjectDelegationBlockerV2(
	projectRoot: string,
): Promise<ProjectDelegationBlockerV2Result> {
	const repair = await readProjectDelegationRepairClosureV1(projectRoot);
	if (!repair.ok) {
		if (repair.issue.code === "additional_unresolved_authority" && repair.issue.delegationId !== undefined) {
			const additional = await readDelegationTransactionV2(projectRoot, repair.issue.delegationId);
			return additional.ok
				? { ok: true, value: additional.value }
				: { ok: false, issue: { code: additional.error.code, delegationId: repair.issue.delegationId } };
		}
		return { ok: false, issue: repair.issue };
	}
	if (repair.unresolvedTipId !== null) {
		const tip = await readDelegationTransactionV2(projectRoot, repair.unresolvedTipId);
		return tip.ok
			? { ok: true, value: tip.value }
			: { ok: false, issue: { code: tip.error.code, delegationId: repair.unresolvedTipId } };
	}

	const root = delegationsDir(projectRoot);
	let entries: Dirent<string>[];
	try {
		const stat = await lstat(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, issue: { code: "invalid_project_authority" } };
		entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { ok: true, value: null }
			: { ok: false, issue: { code: "storage_failure" } };
	}
	const blockers: DelegationTransactionRecord[] = [];
	for (const entry of entries) {
		if (!isValidDelegationId(entry.name)) continue;
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			return { ok: false, issue: { code: "invalid_project_authority", delegationId: entry.name } };
		}
		const read = await readDelegationTransactionV2(projectRoot, entry.name);
		if (!read.ok) {
			const quarantine = await authorityIsQuarantinedV1(projectRoot, entry.name);
			if (!quarantine.ok) return { ok: false, issue: quarantine.issue };
			if (quarantine.value || read.error.code === "not_found") continue;
			return { ok: false, issue: { code: read.error.code, delegationId: entry.name } };
		}
		const transaction = read.value;
		// A fully validated semantic-repair graph with no unresolved tip has
		// already proved all of its root/lineage records closed.
		if (transaction.repair_lineage !== undefined) continue;
		const closedRootDecision = await readRepairRootDecisionV1(projectRoot, transaction.delegation_id);
		if (!closedRootDecision.ok) return { ok: false, issue: closedRootDecision.issue };
		if (closedRootDecision.value !== undefined) continue;
		if (!projectDelegationDispositionV2(transaction).blocking) continue;
		const closure = await readDelegationInactiveBlockerClosureV2(projectRoot, transaction);
		if (!closure.ok) {
			return {
				ok: false,
				issue: {
					code: closure.error.code === "invalid_record" ? "blocker_closure_invalid" : closure.error.code,
					delegationId: transaction.delegation_id,
				},
			};
		}
		if (closure.value === undefined) blockers.push(transaction);
	}
	blockers.sort((left, right) => {
		const time = descendingAscii(left.created_at, right.created_at);
		return time !== 0 ? time : descendingAscii(left.delegation_id, right.delegation_id);
	});
	return { ok: true, value: blockers[0] ?? null };
}

/** Map durable transaction state to the session-level blocking disposition. */
export function projectDelegationDispositionV2(
	transaction: DelegationTransactionRecord,
): ProjectDelegationDispositionV2 {
	// A repair attempt inherits an unresolved semantic obligation. No
	// mechanical terminal (including an abort or exact zero-delta failure) may
	// hide its parent by becoming the newest non-blocking project record. Only
	// strict REVIEWED authority clears the carried lineage.
	if (transaction.repair_lineage !== undefined && transaction.status !== "REVIEWED") {
		return {
			blocking: true,
			terminal_verdict: transaction.status === "FAILED" || transaction.status === "INTERRUPTED" ||
				transaction.status === "ABORTED" ? "FAIL" : null,
		};
	}
	if (transaction.status === "ABORTED") return { blocking: false, terminal_verdict: "FAIL" };
	if (transaction.status === "FINISHED") return { blocking: false, terminal_verdict: "PASS" };
	if (transaction.status === "REVIEWED") return { blocking: false, terminal_verdict: null };
	if (
		transaction.status === "FAILED"
		&& transaction.terminal_outcome?.change_set_status === "ATTRIBUTED"
		&& transaction.terminal_outcome.changed_paths.length === 0
	) {
		return { blocking: false, terminal_verdict: "FAIL" };
	}
	return {
		blocking: true,
		terminal_verdict: transaction.status === "FAILED" || transaction.status === "INTERRUPTED" ? "FAIL" : null,
	};
}

async function collectLegacyFullDiffBindingV2(projectRoot: string, exec: ExecFn): Promise<CurrentDelegationBindingV2> {
	try {
		const git = await collectGitFacts(projectRoot, exec);
		return {
			status: "fresh",
			hash: computeDiffHash(git.changedPaths, git.pathDigests, git.pathStatuses),
			kind: "legacy-full-diff",
		};
	} catch {
		return { status: "unavailable" };
	}
}

/** Resolve current relevance for new v2 and full-diff compatibility for old v2/v1. */
export async function collectCurrentDelegationBindingV2(
	projectRoot: string,
	delegationId: string | undefined,
	exec: ExecFn,
): Promise<CurrentDelegationBindingV2> {
	if (delegationId === undefined) return collectLegacyFullDiffBindingV2(projectRoot, exec);
	const transaction = await readDelegationTransactionV2(projectRoot, delegationId);
	if (!transaction.ok) {
		return transaction.error.code === "not_found"
			? collectLegacyFullDiffBindingV2(projectRoot, exec)
			: { status: "unavailable" };
	}
	if (transaction.value.committed_proof === null) return collectLegacyFullDiffBindingV2(projectRoot, exec);

	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	if (!committed.ok) return { status: "unavailable" };
	const after = committed.value.records["after.json"];
	const scope = committed.value.records["scope.json"];
	if (typeof after !== "object" || after === null || Array.isArray(after)
		|| typeof scope !== "object" || scope === null || Array.isArray(scope)) return { status: "unavailable" };
	const tagged = (after as Record<string, unknown>).diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2;
	if (!tagged) return collectLegacyFullDiffBindingV2(projectRoot, exec);
	const afterGuard = (after as Record<string, unknown>).workspace_guard;
	const changeSet = (scope as Record<string, unknown>).change_set;
	if (!validateWorkspaceGuard(afterGuard) || !validateChangeSet(changeSet)) return { status: "unavailable" };
	const commandProvenance = Object.prototype.hasOwnProperty.call(scope, "command_provenance")
		? (scope as Record<string, unknown>).command_provenance as DelegationCommandProvenanceRecord
		: undefined;
	if (commandProvenance !== undefined && !validateDelegationCommandProvenance(commandProvenance, changeSet)) {
		return { status: "unavailable" };
	}
	// The additive migration receipt exists only for finalized implementation
	// reviews.  Diagnosis and failed/unfinished implementations keep their
	// existing transaction-derived binding and must not be forced through a
	// review reader that is intentionally invalid for those states.
	const reviewAuthority = committed.value.state.task_kind === "implementation"
		&& (committed.value.state.status === "PENDING_REVIEW" || committed.value.state.status === "REVIEWED")
		? await readDelegationReviewV2(projectRoot, delegationId)
		: undefined;
	if (reviewAuthority?.ok && reviewAuthority.value.semantic_migration?.status === "ACCEPTED") {
		const migration = await collectHistoricalSemanticMigration({
			projectRoot,
			delegationId,
			contractHash: committed.value.state.contract_hash,
			baseReviewHash: reviewAuthority.value.review_hash,
			review: reviewAuthority.value.review,
			afterGuard: afterGuard as WorkspaceGuardRecord,
			exec,
		});
		const acceptedHash = reviewAuthority.value.semantic_migration.migration_projection.migration_binding_hash;
		if (migration.ok && migration.projection.migration_binding_hash === acceptedHash) {
			return { status: "fresh", hash: acceptedHash, kind: "historical-semantic-migration-v1" };
		}
		return {
			status: "conflict",
			kind: "historical-semantic-migration-v1",
			code: migration.ok ? "binding_conflict" : migration.code,
			hash: canonicalHash({
				schema_version: 1,
				kind: "historical-semantic-migration-conflict-v1",
				delegation_id: delegationId,
				accepted_binding_hash: acceptedHash,
				current: migration.ok ? migration.projection.migration_binding_hash : migration.code,
				...(migration.ok || migration.path === undefined ? {} : { path: migration.path }),
			}),
		};
	}
	if (reviewAuthority !== undefined && !reviewAuthority.ok && reviewAuthority.error.code !== "not_found") {
		return { status: "unavailable" };
	}
	const expectedProjection = reviewAuthority?.ok
		&& reviewAuthority.value.review.diff_identity_kind === REVIEW_RELEVANCE_KIND_V2
		? reviewAuthority.value.review.relevance_projection
		: undefined;
	const relevance = await collectReviewRelevanceV2({
		project_root: projectRoot,
		delegation_id: committed.value.state.delegation_id,
		contract_hash: committed.value.state.contract_hash,
		after_guard: afterGuard as WorkspaceGuardRecord,
		change_set: changeSet as ChangeSetRecord,
		...(commandProvenance === undefined ? {} : { command_provenance: commandProvenance }),
		exec,
		...(isDelegationTerminalNegativeReviewEligibleFromCommittedV1(
			committed.value.state,
			committed.value.records,
		) ? { allow_control_rebase: true } : {}),
		...(expectedProjection === undefined ? {} : { expected_projection: expectedProjection }),
	});
	if (relevance.ok) {
		return { status: "fresh", hash: relevance.value.binding.projection_hash, kind: "changeset-relevance-v2" };
	}
	if (["head_conflict", "relevant_conflict", "unknown_origin", "binding_conflict"].includes(relevance.error.code)) {
		return {
			status: "conflict",
			kind: "changeset-relevance-v2",
			code: relevance.error.code,
			hash: computeReviewRelevanceConflictHashV2({
				delegation_id: committed.value.state.delegation_id,
				contract_hash: committed.value.state.contract_hash,
				change_set_hash: (changeSet as ChangeSetRecord).change_set_hash,
				error_code: relevance.error.code as "head_conflict" | "relevant_conflict" | "unknown_origin" | "binding_conflict",
				...(relevance.error.path === undefined ? {} : { path: relevance.error.path }),
			}),
		};
	}
	return { status: "unavailable" };
}

/** Read raw transaction state first; require a generation only where one must exist. */
export async function readDelegationAuthorityObservationV2(
	projectRoot: string,
	delegationId: string,
): Promise<DelegationAuthorityObservationV2> {
	const repairClosure = await readProjectDelegationRepairClosureV1(projectRoot);
	if (!repairClosure.ok) return { kind: "invalid-v2", code: repairClosure.issue.code };
	const raw = await readDelegationTransactionV2(projectRoot, delegationId);
	if (!raw.ok) {
		if (raw.error.code !== "not_found") return { kind: "invalid-v2", code: raw.error.code };
		try {
			const [review, ledger] = await Promise.all([
				readReviewRecord(projectRoot, delegationId),
				readDelegationLedger(projectRoot, delegationId),
			]);
			return {
				kind: "legacy",
				review,
				zeroDelta: ledger?.after !== null
					&& ledger?.after !== undefined
					&& ledger.after.changed_since_before.length === 0,
			};
		} catch {
			return { kind: "legacy", review: null, zeroDelta: false };
		}
	}

	const rawTransaction = raw.value;
	if (rawTransaction.repair_lineage !== undefined) {
		const root = await readRepairRootDecisionV1(projectRoot, rawTransaction.repair_lineage.root_delegation_id);
		if (!root.ok || root.value === undefined ||
			root.value.decision_hash !== rawTransaction.repair_lineage.root_decision_hash) {
			return { kind: "invalid-v2", code: root.ok ? "invalid_record" : root.issue.code };
		}
	}
	if (rawTransaction.status === "ABORTED") {
		return {
			kind: "v2", transactionStatus: rawTransaction.status, transactionVerdict: "FAIL",
			review: null, reviewPath: null, finalized: true,
			semanticAccepted: false, semanticBindingHash: null, semanticSource: null, semanticReviewer: null, semanticAcceptedAt: null,
			...repairObservation(rawTransaction),
		};
	}
	if (["PREPARED", "RUNNING", "COMMITTING", "RECOVERY_REQUIRED"].includes(rawTransaction.status)) {
		if (rawTransaction.committed_proof !== null) {
			const verified = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
			if (!verified.ok) return { kind: "invalid-v2", code: verified.error.code };
		}
		return {
			kind: "v2", transactionStatus: rawTransaction.status, transactionVerdict: null,
			review: null, reviewPath: null, finalized: false,
			semanticAccepted: false, semanticBindingHash: null, semanticSource: null, semanticReviewer: null, semanticAcceptedAt: null,
			...repairObservation(rawTransaction),
		};
	}

	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	if (!committed.ok) return { kind: "invalid-v2", code: committed.error.code };
	const transaction = committed.value.state;
	if (transaction.status === "FAILED" || transaction.status === "INTERRUPTED") {
		const currentDecision = await readDelegationCurrentSemanticRepairDecisionV1(projectRoot, committed.value);
		if (!currentDecision.ok) return { kind: "invalid-v2", code: currentDecision.error.code };
		return {
			kind: "v2", transactionStatus: transaction.status, transactionVerdict: "FAIL",
			review: null, reviewPath: null, finalized: true,
			semanticAccepted: false, semanticBindingHash: null, semanticSource: null, semanticReviewer: null, semanticAcceptedAt: null,
			...repairObservation(transaction, currentDecision.value),
		};
	}
	if (transaction.task_kind === "diagnosis") {
		const completed = transaction.status === "FINISHED"
			&& transaction.terminal_outcome !== null
			&& transaction.postcondition_reasons.length === 0;
		return {
			kind: "v2", transactionStatus: transaction.status, transactionVerdict: completed ? "PASS" : null,
			review: null, reviewPath: null, finalized: completed,
			semanticAccepted: false, semanticBindingHash: null, semanticSource: null, semanticReviewer: null, semanticAcceptedAt: null,
		};
	}
	const review = await readDelegationReviewV2(projectRoot, delegationId);
	if (!review.ok) {
		if (review.error.code === "not_found" && transaction.status === "PENDING_REVIEW") {
			return {
				kind: "v2", transactionStatus: transaction.status, transactionVerdict: null,
				review: null, reviewPath: null, finalized: false,
				semanticAccepted: false, semanticBindingHash: null, semanticSource: null, semanticReviewer: null, semanticAcceptedAt: null,
				...repairObservation(transaction),
			};
		}
		if (review.error.code === "invalid_record" && transaction.status === "PENDING_REVIEW" && transaction.review === null) {
			const sidecars = await readDelegationImmutableReviewSidecarPresenceV1(projectRoot, delegationId);
			if (sidecars.ok && !sidecars.value.semantic_repair && !sidecars.value.semantic_migration) {
				const resolution = resolveDelegationLifecycleV1(
					delegationLifecycleSnapshotFromInvalidDerivedReviewV1(delegationId, transaction),
					{
						schema_version: 1,
						kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
						event: "OBSERVE",
						expected_snapshot_hash: null,
					},
				);
				if (resolution.primary_action.action === "REGENERATE_DERIVED_REVIEW") {
					return { kind: "derived-review-invalid", transactionStatus: "PENDING_REVIEW", code: "invalid_record", resolution };
				}
			}
		}
		return { kind: "invalid-v2", code: review.error.code };
	}
	const migration = review.value.semantic_migration?.status === "ACCEPTED" ? review.value.semantic_migration : undefined;
	const embedded = review.value.review.semantic_review === "accepted" ? review.value.review.semantic_acceptance : undefined;
	const zeroDelta = review.value.review.checked_paths.length === 0 && isStrictSemanticAcceptedOrZeroDelta(review.value.review);
	return {
		kind: "v2",
		transactionStatus: transaction.status,
		transactionVerdict: null,
		review: review.value.review,
		reviewPath: review.value.review_path,
		finalized: review.value.finalized,
		semanticAccepted: hasDelegationSemanticReviewAuthorityV2(review.value),
		semanticBindingHash: migration?.migration_projection.migration_binding_hash ??
			(hasDelegationSemanticReviewAuthorityV2(review.value) ? review.value.review.bound_diff_hash : null),
		semanticSource: migration !== undefined ? "migration" : embedded !== undefined ? "embedded" : zeroDelta ? "not_required" : null,
		semanticReviewer: migration !== undefined
			? `${migration.acceptance.reviewer.provider}/${migration.acceptance.reviewer.model}`
			: embedded === undefined ? null : `${embedded.reviewer.provider}/${embedded.reviewer.model}`,
		semanticAcceptedAt: migration?.acceptance.accepted_at ?? embedded?.accepted_at ?? null,
		...repairObservation(transaction, review.value.semantic_repair),
	};
}

function sameDelegationMirror(left: DelegationState, right: DelegationState): boolean {
	return left.latestId === right.latestId
		&& left.status === right.status
		&& left.currentDiffHash === right.currentDiffHash
		&& left.reviewedDiffHash === right.reviewedDiffHash
		&& left.blockedWriteAttempts === right.blockedWriteAttempts;
}

async function readRepairRootDecisionV1(
	projectRoot: string,
	rootDelegationId: string,
): Promise<
	| { ok: true; value: DelegationSemanticRepairDecisionV1 | undefined }
	| { ok: false; issue: ProjectDelegationAuthorityIssueV2 }
> {
	const root = await readDelegationTransactionV2(projectRoot, rootDelegationId);
	if (!root.ok) {
		return { ok: false, issue: { code: root.error.code, delegationId: rootDelegationId } };
	}
	if (root.value.status !== "PENDING_REVIEW"
		&& root.value.status !== "FAILED" && root.value.status !== "INTERRUPTED") {
		const semantic = await readDelegationSemanticRepairDecisionV1(projectRoot, rootDelegationId);
		return semantic.ok
			? semantic
			: { ok: false, issue: { code: semantic.error.code, delegationId: rootDelegationId } };
	}
	const committed = await readDelegationCommittedGenerationV2(projectRoot, rootDelegationId);
	if (!committed.ok) {
		return { ok: false, issue: { code: committed.error.code, delegationId: rootDelegationId } };
	}
	if (canonicalHash(committed.value.state) !== canonicalHash(root.value)) {
		return { ok: false, issue: { code: "invalid_record", delegationId: rootDelegationId } };
	}
	const current = await readDelegationCurrentSemanticRepairDecisionV1(projectRoot, committed.value);
	return current.ok
		? current
		: { ok: false, issue: { code: current.error.code, delegationId: rootDelegationId } };
}

async function readTransactionRepairAbandonmentV1(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
): Promise<
	| { ok: true; value: DelegationCleanRepairAbandonmentV1 | undefined }
	| { ok: false; issue: ProjectDelegationAuthorityIssueV2 }
> {
	const rootDelegationId = transaction.repair_lineage?.root_delegation_id ?? transaction.delegation_id;
	const decision = await readRepairRootDecisionV1(projectRoot, rootDelegationId);
	if (!decision.ok) {
		return decision;
	}
	if (decision.value === undefined) return { ok: true, value: undefined };
	const abandonment = await readDelegationCleanRepairAbandonmentV1(projectRoot, transaction, decision.value);
	if (!abandonment.ok) {
		return {
			ok: false,
			issue: {
				code: abandonment.error.code === "invalid_record" ? "repair_abandonment_invalid" : abandonment.error.code,
				delegationId: transaction.delegation_id,
			},
		};
	}
	return abandonment;
}

/**
 * Close the exact newest inactive blocker after proving only its relevant
 * paths are clean. Unrelated worktree/index changes are retained untouched.
 */
type InactiveBlockerLifecycleObservationV1 =
	| {
		ok: true;
		delegation_id: string;
		closed: boolean;
		execution_owner_present: boolean;
		transaction: DelegationTransactionRecord;
		closure?: DelegationInactiveBlockerClosureV2;
		workspace_guard?: WorkspaceGuardRecord;
		snapshot: DelegationLifecycleSnapshotV1;
		resolution: DelegationLifecycleResolutionV1;
	}
	| { ok: false; code: string; delegation_id?: string };

export type InactiveProjectDelegationBlockerLifecycleResolutionV1 =
	| { ok: true; delegation_id: string; resolution: DelegationLifecycleResolutionV1 }
	| { ok: false; code: string; delegation_id?: string };

async function readInactiveBlockerLifecycleObservationV1(input: {
	project_root: string;
	exec: ExecFn;
	expected_delegation_id?: string;
}): Promise<InactiveBlockerLifecycleObservationV1> {
	const blocker = await readProjectDelegationBlockerV2(input.project_root);
	if (!blocker.ok) {
		return { ok: false, code: blocker.issue.code, ...(blocker.issue.delegationId === undefined ? {} : { delegation_id: blocker.issue.delegationId }) };
	}
	const delegationId = input.expected_delegation_id ?? blocker.value?.delegation_id;
	if (delegationId === undefined) return { ok: false, code: "no_unresolved_blocker" };
	let transaction: DelegationTransactionRecord;
	if (blocker.value?.delegation_id === delegationId) {
		transaction = blocker.value;
	} else {
		const exact = await readDelegationTransactionV2(input.project_root, delegationId);
		if (!exact.ok) {
			return exact.error.code === "not_found"
				? { ok: false, code: "no_unresolved_blocker" }
				: { ok: false, code: exact.error.code, delegation_id: delegationId };
		}
		transaction = exact.value;
	}
	const closure = await readDelegationInactiveBlockerClosureV2(input.project_root, transaction);
	if (!closure.ok) return { ok: false, code: closure.error.code, delegation_id: delegationId };
	if (closure.value !== undefined) {
		const snapshot = delegationLifecycleSnapshotFromInactiveBlockerClosureV1({
			delegation_id: delegationId,
			source_authority: { transaction, closure: closure.value },
			affected_paths: closure.value.relevant_paths,
			relevant_paths_clean: true,
			execution_active: false,
			empty_attempt: isDelegationEmptyRepairAttemptSupersessionV1(transaction, closure.value),
			closed: true,
		});
		return {
			ok: true,
			delegation_id: delegationId,
			closed: true,
			execution_owner_present: false,
			transaction,
			closure: closure.value,
			snapshot,
			resolution: resolveDelegationLifecycleV1(snapshot, {
				schema_version: 1,
				kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
				event: "OBSERVE",
				expected_snapshot_hash: null,
			}),
		};
	}
	if (blocker.value?.delegation_id !== delegationId) {
		return { ok: false, code: blocker.value === null ? "no_unresolved_blocker" : "blocker_changed", ...(blocker.value === null ? {} : { delegation_id: blocker.value.delegation_id }) };
	}
	const statusActive = ["PREPARED", "RUNNING", "COMMITTING"].includes(transaction.status);
	let executionOwnerPresent = false;
	if (!statusActive) {
		const owner = await readDelegationExecutionOwnerV2(input.project_root, transaction);
		if (owner.ok) executionOwnerPresent = true;
		else if (owner.error.code !== "not_found") return { ok: false, code: owner.error.code, delegation_id: delegationId };
	}
	const executionActive = statusActive || executionOwnerPresent;
	if (executionActive) {
		const relevantPaths = inactiveBlockerRelevantPathsV2(transaction);
		const snapshot = delegationLifecycleSnapshotFromInactiveBlockerClosureV1({
			delegation_id: delegationId,
			source_authority: { transaction, execution_owner_present: executionOwnerPresent },
			affected_paths: relevantPaths ?? [],
			relevant_paths_clean: false,
			execution_active: true,
			empty_attempt: false,
			closed: false,
			scope_unknown: relevantPaths === undefined,
		});
		return {
			ok: true,
			delegation_id: delegationId,
			closed: false,
			execution_owner_present: executionOwnerPresent,
			transaction,
			snapshot,
			resolution: resolveDelegationLifecycleV1(snapshot, {
				schema_version: 1,
				kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
				event: "OBSERVE",
				expected_snapshot_hash: null,
			}),
		};
	}
	const guard = await collectWorkspaceGuard({ project_root: input.project_root, exec: input.exec });
	if (!guard.ok) return { ok: false, code: `workspace_${guard.error.code}`, delegation_id: delegationId };
	const scope = await readDelegationInactiveBlockerRelevantScopeV2({
		project_root: input.project_root,
		transaction,
		workspace_guard: guard.guard,
	});
	if (!scope.ok) {
		return {
			ok: false,
			code: scope.error.code === "not_recoverable" ? "relevant_paths_not_clean" : `blocker_scope_${scope.error.code}`,
			delegation_id: delegationId,
		};
	}
	const relevant = new Set(scope.value.relevant_paths);
	const relevantEntries = guard.guard.entries.filter((entry) => relevant.has(entry.path));
	const emptyAttempt = transaction.repair_lineage !== undefined && transaction.committed_proof === null &&
		transaction.terminal_outcome === null && transaction.review === null &&
		(transaction.status === "ABORTED" || transaction.status === "RECOVERY_REQUIRED") &&
		scope.value.relevant_paths.length === 0;
	const snapshot = delegationLifecycleSnapshotFromInactiveBlockerClosureV1({
		delegation_id: delegationId,
		source_authority: {
			transaction,
			observed_git_head: guard.guard.git_head,
			relevant_entries: relevantEntries,
			relevant_paths_clean: scope.value.clean,
		},
		affected_paths: scope.value.relevant_paths,
		relevant_paths_clean: scope.value.clean,
		execution_active: false,
		empty_attempt: emptyAttempt,
		closed: false,
	});
	return {
		ok: true,
		delegation_id: delegationId,
		closed: false,
		execution_owner_present: false,
		transaction,
		workspace_guard: guard.guard,
		snapshot,
		resolution: resolveDelegationLifecycleV1(snapshot, {
			schema_version: 1,
			kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
			event: "OBSERVE",
			expected_snapshot_hash: null,
		}),
	};
}

/** Read-only public adapter used by status; it never acquires a lock or writes closure authority. */
export async function readInactiveProjectDelegationBlockerLifecycleResolutionV1(input: {
	project_root: string;
	exec: ExecFn;
	expected_delegation_id?: string;
}): Promise<InactiveProjectDelegationBlockerLifecycleResolutionV1> {
	const observed = await readInactiveBlockerLifecycleObservationV1(input);
	return observed.ok
		? { ok: true, delegation_id: observed.delegation_id, resolution: observed.resolution }
		: observed;
}

function inactiveBlockerEffectFailureCodeV1(code: DelegationLifecycleEffectFailureCodeV1): string {
	if (code === "ACTION_CHANGED") return "blocker_changed";
	if (code === "LOCK_CONFLICT") return "start_lock_conflict";
	if (code === "LOCK_STORAGE_FAILURE") return "start_lock_storage_failure";
	if (code === "SNAPSHOT_READ_FAILED" || code === "SNAPSHOT_INVALID") return "blocker_snapshot_unavailable";
	if (code === "POSTCONDITION_FAILED" || code === "RECOVERY_RANK_NOT_DECREASED") return "blocker_closure_not_effective";
	return `lifecycle_${code.toLowerCase()}`;
}

export async function closeInactiveProjectDelegationBlockerV2(input: {
	project_root: string;
	expected_delegation_id?: string;
	now: string;
	exec: ExecFn;
	closed_by: DelegationInactiveBlockerClosureV2["closed_by"];
}): Promise<CloseInactiveProjectDelegationBlockerV2Result> {
	const initial = await readInactiveBlockerLifecycleObservationV1({
		project_root: input.project_root,
		exec: input.exec,
		...(input.expected_delegation_id === undefined ? {} : { expected_delegation_id: input.expected_delegation_id }),
	});
	if (!initial.ok) return initial;
	if (initial.closed) {
		const blocker = await readProjectDelegationBlockerV2(input.project_root);
		return blocker.ok && initial.closure !== undefined
			? {
				ok: true,
				value: initial.closure,
				closed_delegation_ids: Object.freeze([initial.delegation_id]),
				...(blocker.value === null ? {} : { remaining_blocker_id: blocker.value.delegation_id }),
				lifecycle_resolution: initial.resolution,
			}
			: { ok: false, code: blocker.ok ? "blocker_closure_not_effective" : blocker.issue.code, delegation_id: initial.delegation_id };
	}
	if (initial.resolution.primary_action.action === "WAIT_FOR_ACTIVE_WRITER") {
		return {
			ok: false,
			code: initial.execution_owner_present ? "execution_owner_present" : "blocker_execution_active",
			delegation_id: initial.delegation_id,
		};
	}
	if (initial.resolution.primary_action.action === "REBASE_CURRENT_BINDING") {
		return { ok: false, code: "relevant_paths_not_clean", delegation_id: initial.delegation_id };
	}
	if (initial.resolution.primary_action.action !== "CLOSE_SATISFIED_NO_DELTA" &&
		initial.resolution.primary_action.action !== "SUPERSEDE_EMPTY_ATTEMPT") {
		return { ok: false, code: "blocker_changed", delegation_id: initial.delegation_id };
	}
	let current = initial;
	let firstClosure: DelegationInactiveBlockerClosureV2 | undefined;
	const closedIds: string[] = [];
	let exactFailureCode: string | undefined;
	const executed = await executeDelegationLifecycleEffectV1({
		project_root: input.project_root,
		resolution: initial.resolution,
		expected_snapshot_hash: initial.resolution.primary_action.snapshot_hash,
		execution_mode: "EXPLICIT",
		user_authorized: true,
		now: input.now,
	}, {
		with_writer_lock: async (request, operation) => {
			const locked = await withProjectDelegationStartLockV1({
				project_root: request.project_root,
				delegation_id: initial.delegation_id,
				now: request.now,
			}, async (lease) => operation({ owner: lease }));
			if (locked.ok) return locked;
			exactFailureCode = `start_lock_${locked.error.code}`;
			return {
				ok: false,
				code: locked.error.code === "conflict" ? "CONFLICT" as const
					: locked.error.code === "storage_failure" ? "STORAGE_FAILURE" as const
						: "FAILED" as const,
			};
		},
		read_snapshot: async () => {
			const observed = await readInactiveBlockerLifecycleObservationV1({
				project_root: input.project_root,
				exec: input.exec,
				expected_delegation_id: initial.delegation_id,
			});
			if (!observed.ok) {
				exactFailureCode = observed.code;
				throw new Error("inactive blocker lifecycle snapshot unavailable");
			}
			current = observed;
			return observed.snapshot;
		},
		handlers: {
			[initial.resolution.primary_action.action]: {
				is_complete: ({ snapshot }: { snapshot: DelegationLifecycleSnapshotV1 }) => snapshot.attempt === "TERMINAL" &&
					snapshot.recovery_rank?.unresolved_obligations === 0,
				execute: async () => {
					if (current.closed || current.workspace_guard === undefined) return { ok: false, code: "CONFLICT" as const };
					let transaction = current.transaction;
					while (true) {
						const owner = await readDelegationExecutionOwnerV2(input.project_root, transaction);
						if (owner.ok) {
							exactFailureCode = "execution_owner_present";
							return { ok: false, code: "CONFLICT" as const };
						}
						if (owner.error.code !== "not_found") {
							exactFailureCode = owner.error.code;
							return { ok: false, code: owner.error.code === "storage_failure" ? "STORAGE_FAILURE" as const : "FAILED" as const };
						}
						const published = await publishDelegationInactiveBlockerClosureV2({
							project_root: input.project_root,
							transaction,
							workspace_guard: current.workspace_guard,
							closed_by: input.closed_by,
							now: input.now,
						});
						if (!published.ok) {
							exactFailureCode = published.error.code === "not_recoverable"
								? "relevant_paths_not_clean" : `blocker_closure_${published.error.code}`;
							return {
								ok: false,
								code: published.error.code === "conflict" ? "CONFLICT" as const
									: published.error.code === "storage_failure" ? "STORAGE_FAILURE" as const
										: published.error.code === "not_recoverable" ? "UNAVAILABLE" as const : "FAILED" as const,
							};
						}
						firstClosure ??= published.value;
						closedIds.push(transaction.delegation_id);
						const closedEmptyAttempt = isDelegationEmptyRepairAttemptSupersessionV1(transaction, published.value);
						const verified = await readProjectDelegationBlockerV2(input.project_root);
						if (!verified.ok) {
							exactFailureCode = verified.issue.code;
							return { ok: false, code: verified.issue.code === "storage_failure" ? "STORAGE_FAILURE" as const : "FAILED" as const };
						}
						if (verified.value?.delegation_id === transaction.delegation_id) {
							exactFailureCode = "blocker_closure_not_effective";
							return { ok: false, code: "FAILED" as const };
						}
						if (!closedEmptyAttempt || verified.value === null) return { ok: true };
						const next = verified.value;
						const retryableEmpty = next.repair_lineage !== undefined && next.committed_proof === null &&
							next.terminal_outcome === null && next.review === null &&
							(next.status === "ABORTED" || next.status === "RECOVERY_REQUIRED") &&
							(await readStrictRetryableRawRepairEvidenceV1(input.project_root, next)).ok;
						if (!retryableEmpty) return { ok: true };
						transaction = next;
					}
				},
			},
		},
	});
	if (!executed.ok) {
		const changedToRebase = executed.code === "ACTION_CHANGED" &&
			executed.observed?.primary_action.action === "REBASE_CURRENT_BINDING";
		return {
			ok: false,
			code: exactFailureCode ?? (changedToRebase ? "relevant_paths_not_clean" : inactiveBlockerEffectFailureCodeV1(executed.code)),
			delegation_id: initial.delegation_id,
		};
	}
	if (firstClosure === undefined) {
		const replay = await readDelegationInactiveBlockerClosureV2(input.project_root, initial.transaction);
		if (!replay.ok || replay.value === undefined) {
			return { ok: false, code: replay.ok ? "blocker_closure_not_effective" : `blocker_closure_${replay.error.code}`, delegation_id: initial.delegation_id };
		}
		firstClosure = replay.value;
	}
	const remaining = await readProjectDelegationBlockerV2(input.project_root);
	if (!remaining.ok) return { ok: false, code: remaining.issue.code, ...(remaining.issue.delegationId === undefined ? {} : { delegation_id: remaining.issue.delegationId }) };
	return {
		ok: true,
		value: firstClosure,
		closed_delegation_ids: Object.freeze(closedIds.length === 0 ? [initial.delegation_id] : [...closedIds]),
		...(remaining.value === null ? {} : { remaining_blocker_id: remaining.value.delegation_id }),
		lifecycle_resolution: initial.resolution,
	};
}

interface DelegationQuarantineLifecycleObservationV1 {
	snapshot: DelegationLifecycleSnapshotV1;
	resolution: DelegationLifecycleResolutionV1;
	quarantine?: DelegationAuthorityQuarantineV1;
	readable: boolean;
	issue_code: string;
}

async function readDelegationQuarantineLifecycleObservationV1(
	projectRoot: string,
	delegationId: string,
): Promise<DelegationQuarantineLifecycleObservationV1 | undefined> {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	const inventory = await readDelegationAuthorityInventoryFactsV1(projectRoot, delegationId);
	const base = {
		schema_version: 1 as const,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		operation_intent: "DEV" as const,
		writer_lock: "ABSENT" as const,
		binding: "CURRENT" as const,
		candidate: "NONE" as const,
		runtime_identity: "NOT_REQUIRED" as const,
		request_valid: true,
		target: { kind: "DELEGATION" as const, id: delegationId },
		affected_paths: [] as readonly string[],
		recovery_rank: null,
	};
	let snapshot: DelegationLifecycleSnapshotV1;
	let quarantine: DelegationAuthorityQuarantineV1 | undefined;
	let readable = false;
	let issueCode: string = inventory.ok ? "invalid_record" : inventory.error.code;
	if (!inventory.ok) {
		snapshot = {
			...base,
			source_authority_hash: canonicalHash({ delegation_id: delegationId, inventory_error: inventory.error.code }),
			authority: {
				health: inventory.error.code === "storage_failure" ? "STORAGE_FAILURE" : "CORRUPT",
				disposition: inventory.error.code === "not_recoverable" ? "ACTIVE" : "UNKNOWN",
			},
			attempt: "TERMINAL",
			scope_unknown: true,
		};
	} else {
		const quarantined = await readDelegationAuthorityQuarantineV1(projectRoot, delegationId);
		if (!quarantined.ok) {
			issueCode = `quarantine_${quarantined.error.code}`;
			snapshot = {
				...base,
				source_authority_hash: canonicalHash({ inventory: inventory.value, quarantine_error: quarantined.error.code }),
				authority: {
					health: quarantined.error.code === "storage_failure" ? "STORAGE_FAILURE" : "CORRUPT",
					disposition: "INACTIVE",
				},
				attempt: "TERMINAL",
				scope_unknown: true,
				recovery_rank: { unresolved_obligations: 1, unresolved_attempts: 1 },
			};
		} else if (quarantined.value !== undefined) {
			quarantine = quarantined.value;
			issueCode = quarantined.value.issue_code;
			snapshot = {
				...base,
				source_authority_hash: canonicalHash({ inventory: inventory.value, quarantine_hash: quarantine.quarantine_hash }),
				authority: { health: "VALID", disposition: "INACTIVE" },
				attempt: "TERMINAL",
				scope_unknown: false,
				recovery_rank: { unresolved_obligations: 0, unresolved_attempts: 1 },
			};
		} else {
			const transaction = await readDelegationTransactionV2(projectRoot, delegationId);
			if (transaction.ok) {
				readable = true;
				issueCode = "authority_is_readable";
				snapshot = {
					...base,
					source_authority_hash: canonicalHash({ inventory: inventory.value, transaction: transaction.value }),
					authority: { health: "VALID", disposition: "ACTIVE" },
					attempt: "TERMINAL",
					scope_unknown: false,
					recovery_rank: { unresolved_obligations: 0, unresolved_attempts: 1 },
				};
			} else {
				issueCode = transaction.error.code === "not_found" ? "incomplete_v2_authority" : transaction.error.code;
				snapshot = {
					...base,
					source_authority_hash: canonicalHash({
						inventory: inventory.value,
						transaction_error: transaction.error.code,
					}),
					authority: {
						health: transaction.error.code === "storage_failure" ? "STORAGE_FAILURE" : "CORRUPT",
						disposition: "INACTIVE",
					},
					attempt: "TERMINAL",
					scope_unknown: true,
					recovery_rank: { unresolved_obligations: 1, unresolved_attempts: 1 },
				};
			}
		}
	}
	return {
		snapshot,
		resolution: resolveDelegationLifecycleV1(snapshot, {
			schema_version: 1,
			kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
			event: "OBSERVE",
			expected_snapshot_hash: null,
		}),
		...(quarantine === undefined ? {} : { quarantine }),
		readable,
		issue_code: issueCode,
	};
}

function quarantineEffectFailureCodeV1(code: DelegationLifecycleEffectFailureCodeV1): string {
	if (code === "ACTION_CHANGED") return "authority_changed";
	if (code === "LOCK_CONFLICT") return "start_lock_conflict";
	if (code === "LOCK_STORAGE_FAILURE") return "start_lock_storage_failure";
	if (code === "SNAPSHOT_READ_FAILED" || code === "SNAPSHOT_INVALID") return "authority_snapshot_unavailable";
	if (code === "POSTCONDITION_FAILED") return "authority_quarantine_not_effective";
	return `lifecycle_${code.toLowerCase()}`;
}

/**
 * Quarantine one stable unreadable v2 envelope without moving/deleting it or
 * accepting any project delta. The public command now consumes one canonical
 * resolver action; exact inventory bytes are re-read under the writer lock.
 */
export async function quarantineProjectDelegationAuthorityV1(input: {
	project_root: string;
	delegation_id: string;
	now: string;
	quarantined_by: DelegationAuthorityQuarantineV1["quarantined_by"];
}): Promise<QuarantineProjectDelegationAuthorityV1Result> {
	const initial = await readDelegationQuarantineLifecycleObservationV1(input.project_root, input.delegation_id);
	if (initial === undefined) return { ok: false, code: "invalid_input", delegation_id: input.delegation_id };
	if (initial.quarantine !== undefined) return { ok: true, value: initial.quarantine };
	if (initial.readable) return { ok: false, code: "authority_is_readable", delegation_id: input.delegation_id };
	if (initial.issue_code === "not_found") {
		return { ok: false, code: "authority_not_found", delegation_id: input.delegation_id };
	}
	if (initial.issue_code === "not_recoverable") {
		return { ok: false, code: "authority_quarantine_not_recoverable", delegation_id: input.delegation_id };
	}
	if (initial.resolution.primary_action.action !== "QUARANTINE_CORRUPT_AUTHORITY") {
		return {
			ok: false,
			code: initial.resolution.primary_action.action === "REPORT_STORAGE_FAILURE"
				? "authority_quarantine_storage_failure"
				: "authority_not_recoverable",
			delegation_id: input.delegation_id,
		};
	}
	let exactFailureCode: string | undefined;
	const executed = await executeDelegationLifecycleEffectV1({
		project_root: input.project_root,
		resolution: initial.resolution,
		expected_snapshot_hash: initial.resolution.primary_action.snapshot_hash,
		execution_mode: "EXPLICIT",
		user_authorized: true,
		now: input.now,
	}, {
		with_writer_lock: async (request, operation) => {
			const locked = await withProjectDelegationStartLockV1({
				project_root: request.project_root,
				delegation_id: input.delegation_id,
				now: request.now,
			}, async (lease) => operation({ owner: lease }));
			if (locked.ok) return locked;
			exactFailureCode = `start_lock_${locked.error.code}`;
			return {
				ok: false,
				code: locked.error.code === "conflict" ? "CONFLICT" as const
					: locked.error.code === "storage_failure" ? "STORAGE_FAILURE" as const
						: "FAILED" as const,
			};
		},
		read_snapshot: async () => {
			const observed = await readDelegationQuarantineLifecycleObservationV1(input.project_root, input.delegation_id);
			if (observed === undefined) throw new Error("invalid quarantine snapshot target");
			return observed.snapshot;
		},
		handlers: {
			QUARANTINE_CORRUPT_AUTHORITY: {
				is_complete: ({ snapshot }) => snapshot.authority.health === "VALID" &&
					snapshot.authority.disposition === "INACTIVE" && snapshot.attempt === "TERMINAL" && !snapshot.scope_unknown,
				execute: async () => {
					const published = await publishDelegationAuthorityQuarantineV1({
						project_root: input.project_root,
						delegation_id: input.delegation_id,
						issue_code: initial.issue_code,
						quarantined_by: input.quarantined_by,
						now: input.now,
					});
					if (published.ok) return { ok: true };
					exactFailureCode = `authority_quarantine_${published.error.code}`;
					return {
						ok: false,
						code: published.error.code === "conflict" ? "CONFLICT" as const
							: published.error.code === "storage_failure" ? "STORAGE_FAILURE" as const
								: published.error.code === "not_recoverable" ? "UNAVAILABLE" as const
									: "FAILED" as const,
					};
				},
			},
		},
	});
	if (!executed.ok) {
		return {
			ok: false,
			code: exactFailureCode ?? quarantineEffectFailureCodeV1(executed.code),
			delegation_id: input.delegation_id,
		};
	}
	const verified = await readDelegationAuthorityQuarantineV1(input.project_root, input.delegation_id);
	if (!verified.ok || verified.value === undefined) {
		return {
			ok: false,
			code: verified.ok ? "authority_quarantine_not_effective" : `authority_quarantine_${verified.error.code}`,
			delegation_id: input.delegation_id,
		};
	}
	return { ok: true, value: verified.value };
}

type CleanRepairLifecycleObservationV1 =
	| {
		ok: true;
		closed: boolean;
		delegation_id: string;
		snapshot: DelegationLifecycleSnapshotV1;
		resolution: DelegationLifecycleResolutionV1;
		tip?: DelegationTransactionRecord;
		root_decision?: DelegationSemanticRepairDecisionV1;
		clean_guard?: WorkspaceGuardRecord;
	}
	| { ok: false; code: string; delegation_id?: string };

async function readCleanRepairLifecycleObservationV1(input: {
	project_root: string;
	exec: ExecFn;
	expected_tip_id?: string;
}): Promise<CleanRepairLifecycleObservationV1> {
	const closure = await readProjectDelegationRepairClosureV1(input.project_root);
	if (!closure.ok) {
		return { ok: false, code: closure.issue.code, ...(closure.issue.delegationId === undefined ? {} : { delegation_id: closure.issue.delegationId }) };
	}
	if (closure.unresolvedTipId === null) {
		if (input.expected_tip_id === undefined) return { ok: false, code: "no_unresolved_repair" };
		const snapshot = delegationLifecycleSnapshotFromCleanRepairClosureV1({
			delegation_id: input.expected_tip_id,
			source_authority: closure,
			workspace_clean: true,
			closed: true,
		});
		return {
			ok: true,
			closed: true,
			delegation_id: input.expected_tip_id,
			snapshot,
			resolution: resolveDelegationLifecycleV1(snapshot, {
				schema_version: 1,
				kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
				event: "OBSERVE",
				expected_snapshot_hash: null,
			}),
		};
	}
	if (input.expected_tip_id !== undefined && closure.unresolvedTipId !== input.expected_tip_id) {
		return { ok: false, code: "repair_authority_changed", delegation_id: closure.unresolvedTipId };
	}
	const tip = await readDelegationTransactionV2(input.project_root, closure.unresolvedTipId);
	if (!tip.ok) return { ok: false, code: tip.error.code, delegation_id: closure.unresolvedTipId };
	const rootDelegationId = tip.value.repair_lineage?.root_delegation_id ?? tip.value.delegation_id;
	const rootDecision = await readRepairRootDecisionV1(input.project_root, rootDelegationId);
	if (!rootDecision.ok || rootDecision.value === undefined) {
		return {
			ok: false,
			code: rootDecision.ok ? "repair_decision_missing" : rootDecision.issue.code,
			delegation_id: rootDelegationId,
		};
	}
	const guard = await collectWorkspaceGuard({ project_root: input.project_root, exec: input.exec });
	if (!guard.ok) return { ok: false, code: `workspace_${guard.error.code}`, delegation_id: tip.value.delegation_id };
	const workspaceClean = guard.guard.entries.length === 0 && guard.guard.git_head !== null;
	const snapshot = delegationLifecycleSnapshotFromCleanRepairClosureV1({
		delegation_id: tip.value.delegation_id,
		source_authority: { closure, tip: tip.value, root_decision: rootDecision.value, guard: guard.guard },
		workspace_clean: workspaceClean,
		closed: false,
	});
	return {
		ok: true,
		closed: false,
		delegation_id: tip.value.delegation_id,
		snapshot,
		resolution: resolveDelegationLifecycleV1(snapshot, {
			schema_version: 1,
			kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
			event: "OBSERVE",
			expected_snapshot_hash: null,
		}),
		tip: tip.value,
		root_decision: rootDecision.value,
		clean_guard: guard.guard,
	};
}

/**
 * Close one exact unresolved semantic repair after Sol observes a strictly
 * clean Git workspace. The public action now executes through the canonical
 * lifecycle effect boundary and must lower the logical recovery rank.
 */
export async function abandonCleanProjectDelegationRepairV1(input: {
	project_root: string;
	now: string;
	exec: ExecFn;
	abandoned_by: DelegationCleanRepairAbandonmentV1["abandoned_by"];
}): Promise<AbandonCleanProjectDelegationRepairV1Result> {
	const initial = await readCleanRepairLifecycleObservationV1({ project_root: input.project_root, exec: input.exec });
	if (!initial.ok) return initial;
	if (initial.closed || initial.tip === undefined || initial.root_decision === undefined || initial.clean_guard === undefined) {
		return { ok: false, code: "no_unresolved_repair" };
	}
	if (initial.resolution.primary_action.action !== "CLOSE_SATISFIED_NO_DELTA") {
		return {
			ok: false,
			code: initial.resolution.primary_action.action === "REBASE_CURRENT_BINDING"
				? "workspace_not_clean"
				: "repair_authority_changed",
			delegation_id: initial.delegation_id,
		};
	}
	let current = initial;
	let published: DelegationCleanRepairAbandonmentV1 | undefined;
	let exactFailureCode: string | undefined;
	const executed = await executeDelegationLifecycleEffectV1({
		project_root: input.project_root,
		resolution: initial.resolution,
		expected_snapshot_hash: initial.resolution.primary_action.snapshot_hash,
		execution_mode: "EXPLICIT",
		user_authorized: true,
		now: input.now,
	}, {
		with_writer_lock: async (request, operation) => {
			const locked = await withProjectDelegationStartLockV1({
				project_root: request.project_root,
				delegation_id: initial.delegation_id,
				now: request.now,
			}, async (lease) => operation({ owner: lease }));
			if (locked.ok) return locked;
			exactFailureCode = `start_lock_${locked.error.code}`;
			return {
				ok: false,
				code: locked.error.code === "conflict" ? "CONFLICT" as const
					: locked.error.code === "storage_failure" ? "STORAGE_FAILURE" as const
						: "FAILED" as const,
			};
		},
		read_snapshot: async () => {
			const observed = await readCleanRepairLifecycleObservationV1({
				project_root: input.project_root,
				exec: input.exec,
				expected_tip_id: initial.delegation_id,
			});
			if (!observed.ok) {
				exactFailureCode = observed.code;
				throw new Error("clean repair lifecycle snapshot unavailable");
			}
			current = observed;
			return observed.snapshot;
		},
		handlers: {
			CLOSE_SATISFIED_NO_DELTA: {
				is_complete: ({ snapshot }) => snapshot.attempt === "TERMINAL" &&
					snapshot.recovery_rank?.unresolved_obligations === 0,
				execute: async () => {
					if (current.closed || current.tip === undefined || current.root_decision === undefined || current.clean_guard === undefined) {
						return { ok: false, code: "CONFLICT" as const };
					}
					const write = await publishDelegationCleanRepairAbandonmentV1({
						project_root: input.project_root,
						tip: current.tip,
						root_decision: current.root_decision,
						clean_guard: current.clean_guard,
						abandoned_by: input.abandoned_by,
						now: input.now,
					});
					if (write.ok) {
						published = write.value;
						return { ok: true };
					}
					exactFailureCode = `repair_abandonment_${write.error.code}`;
					return {
						ok: false,
						code: write.error.code === "conflict" ? "CONFLICT" as const
							: write.error.code === "storage_failure" ? "STORAGE_FAILURE" as const
								: "FAILED" as const,
					};
				},
			},
		},
	});
	if (!executed.ok) {
		const changedToRebase = executed.code === "ACTION_CHANGED" &&
			executed.observed?.primary_action.action === "REBASE_CURRENT_BINDING";
		return {
			ok: false,
			code: exactFailureCode ?? (changedToRebase ? "workspace_not_clean" : `lifecycle_${executed.code.toLowerCase()}`),
			delegation_id: initial.delegation_id,
		};
	}
	if (published === undefined) {
		const replay = await readDelegationCleanRepairAbandonmentV1(
			input.project_root,
			initial.tip,
			initial.root_decision,
		);
		if (!replay.ok || replay.value === undefined) {
			return {
				ok: false,
				code: replay.ok ? "repair_abandonment_not_closed" : `repair_abandonment_${replay.error.code}`,
				delegation_id: initial.delegation_id,
			};
		}
		published = replay.value;
	}
	return { ok: true, value: published, lifecycle_resolution: initial.resolution };
}

/** Pure-result reconciliation over strict project authority; persistence remains caller-owned. */
export async function reconcileProjectDelegationAuthorityV2(input: {
	project_root: string;
	current_state: DelegationState;
	now: string;
	exec: ExecFn;
	terminal_mirror_blocked?: boolean;
	defer_reviewed_freshness?: boolean;
	interruption_recovery_options?: DelegationExecutionOwnerOptionsV2;
}): Promise<ReconcileProjectDelegationAuthorityV2Result> {
	const latest = await readLatestProjectDelegationTransactionV2(input.project_root);
	if (!latest.ok) {
		return {
			ok: false,
			issue: {
				code: latest.error.cause ?? latest.error.code,
				...(latest.error.delegation_id === undefined ? {} : { delegationId: latest.error.delegation_id }),
			},
		};
	}
	if (latest.value === null) {
		// `readLatestProjectDelegationTransactionV2` intentionally skips genuine
		// v1-only directories.  It must not, however, let an incomplete v2
		// directory look like an empty project: that would clear the session
		// blocker and allow a fresh delegation beside unreadable authority.
		const repairClosure = await readProjectDelegationRepairClosureV1(input.project_root);
		if (!repairClosure.ok) return { ok: false, issue: repairClosure.issue };
		if (repairClosure.unresolvedTipId !== null) {
			return {
				ok: false,
				issue: { code: "invalid_project_authority", delegationId: repairClosure.unresolvedTipId },
			};
		}
		// A v1-only delegation is represented by the durable legacy ledger plus
		// the session mirror.  Absence of a v2 transaction is therefore not proof
		// that the mirror is disposable: clearing PENDING_REVIEW/STALE here makes
		// the registered legacy review tool lose its exact target on reload.
		if (input.current_state.latestId !== undefined) {
			const quarantine = await authorityIsQuarantinedV1(input.project_root, input.current_state.latestId);
			if (!quarantine.ok) return { ok: false, issue: quarantine.issue };
			if (quarantine.value) return { ok: true, state: null };
			const legacy = await readDelegationAuthorityObservationV2(input.project_root, input.current_state.latestId);
			if (legacy.kind === "legacy") {
				const binding = await collectCurrentDelegationBindingV2(
					input.project_root,
					input.current_state.latestId,
					input.exec,
				);
				if (binding.status === "unavailable") {
					return { ok: false, issue: { code: "binding_unavailable", delegationId: input.current_state.latestId } };
				}
				// Historical mechanical REVIEWED is not semantic authority for a
				// non-zero delta.  Demote only that unsafe projection; otherwise retain
				// the legacy lifecycle and refresh its exact current binding.
				if (input.current_state.status === "REVIEWED" &&
					(legacy.review === null || !legacy.zeroDelta || !isStrictSemanticAcceptedOrZeroDelta(legacy.review))) {
					return {
						ok: true,
						state: {
							latestId: input.current_state.latestId,
							status: "PENDING_REVIEW",
							currentDiffHash: binding.hash,
							blockedWriteAttempts: input.current_state.blockedWriteAttempts,
							updatedAt: input.now,
						},
					};
				}
				return { ok: true, state: observeDiffChange(input.current_state, binding.hash, input.now) };
			}
			if (legacy.kind === "invalid-v2") {
				return { ok: false, issue: { code: legacy.code, delegationId: input.current_state.latestId } };
			}
		}
		return { ok: true, state: null };
	}
	let transaction = latest.value;
	const latestInterruption = await recoverInterruptedDelegationV2({
		project_root: input.project_root,
		transaction,
		now: input.now,
		...(input.interruption_recovery_options === undefined
			? {}
			: { options: input.interruption_recovery_options }),
	});
	if (latestInterruption.status === "recovered") transaction = latestInterruption.transaction;
	if (!["PREPARED", "RUNNING", "COMMITTING"].includes(transaction.status)) {
		const cleanup = await releaseOrphanedTerminalExecutionOwnerV2(
			input.project_root,
			transaction,
			input.interruption_recovery_options,
		);
		if (cleanup.status === "active") {
			return { ok: false, issue: { code: "execution_owner_active", delegationId: transaction.delegation_id } };
		}
		if (cleanup.status === "blocked") {
			return { ok: false, issue: { code: cleanup.code, delegationId: transaction.delegation_id } };
		}
	}
	let repairClosure = await readProjectDelegationRepairClosureV1(input.project_root);
	if (!repairClosure.ok && repairClosure.issue.code === "repair_lineage_execution_owner_present"
		&& repairClosure.issue.delegationId !== undefined) {
		const orphan = await readDelegationTransactionV2(input.project_root, repairClosure.issue.delegationId);
		if (orphan.ok) {
			const cleanup = await releaseOrphanedTerminalExecutionOwnerV2(
				input.project_root,
				orphan.value,
				input.interruption_recovery_options,
			);
			if (cleanup.status === "released" || cleanup.status === "absent") {
				repairClosure = await readProjectDelegationRepairClosureV1(input.project_root);
			}
		}
	}
	if (!repairClosure.ok && repairClosure.issue.code !== "additional_unresolved_authority") {
		return { ok: false, issue: repairClosure.issue };
	}
	const projectBlocker = await readProjectDelegationBlockerV2(input.project_root);
	if (!projectBlocker.ok) return { ok: false, issue: projectBlocker.issue };
	if (projectBlocker.value !== null && projectBlocker.value.delegation_id !== transaction.delegation_id) {
		transaction = projectBlocker.value;
		const interruption = await recoverInterruptedDelegationV2({
			project_root: input.project_root,
			transaction,
			now: input.now,
			...(input.interruption_recovery_options === undefined
				? {}
				: { options: input.interruption_recovery_options }),
		});
		if (interruption.status === "recovered") transaction = interruption.transaction;
		if (!["PREPARED", "RUNNING", "COMMITTING"].includes(transaction.status)) {
			const cleanup = await releaseOrphanedTerminalExecutionOwnerV2(
				input.project_root,
				transaction,
				input.interruption_recovery_options,
			);
			if (cleanup.status === "active") return { ok: false, issue: { code: "execution_owner_active", delegationId: transaction.delegation_id } };
			if (cleanup.status === "blocked") return { ok: false, issue: { code: cleanup.code, delegationId: transaction.delegation_id } };
		}
	}
	if (repairClosure.ok && repairClosure.unresolvedTipId === null) {
		const abandonment = await readTransactionRepairAbandonmentV1(input.project_root, transaction);
		if (!abandonment.ok) return { ok: false, issue: abandonment.issue };
		if (abandonment.value !== undefined) return { ok: true, state: null };
	}
	const inactiveClosure = await readDelegationInactiveBlockerClosureV2(input.project_root, transaction);
	if (!inactiveClosure.ok) {
		return {
			ok: false,
			issue: {
				code: inactiveClosure.error.code === "invalid_record" ? "blocker_closure_invalid" : inactiveClosure.error.code,
				delegationId: transaction.delegation_id,
			},
		};
	}
	if (inactiveClosure.value !== undefined) return { ok: true, state: null };
	const authority = await readDelegationAuthorityObservationV2(input.project_root, transaction.delegation_id);
	if (authority.kind === "invalid-v2") {
		return { ok: false, issue: { code: authority.code, delegationId: transaction.delegation_id } };
	}
	const disposition = projectDelegationDispositionV2(transaction);
	if (transaction.status === "REVIEWED" && input.defer_reviewed_freshness === true) {
		if (authority.kind !== "v2" || authority.review === null || !authority.finalized) {
			return { ok: false, issue: { code: "invalid_record", delegationId: transaction.delegation_id } };
		}
		if (!authority.semanticAccepted || authority.semanticBindingHash === null) {
			return {
				ok: true,
				state: {
					latestId: transaction.delegation_id,
					status: "PENDING_REVIEW",
					currentDiffHash: authority.review.bound_diff_hash,
					blockedWriteAttempts: input.current_state.blockedWriteAttempts,
					updatedAt: input.now,
				},
			};
		}
		// The review tool owns the freshness check for a finalized packet.  Keep
		// an exact blocking mirror blocking until that check succeeds, and never
		// promote an already-STALE mirror merely because immutable acceptance
		// authority exists.  This also makes a retry idempotent after drift.
		if (input.current_state.latestId === transaction.delegation_id &&
			(input.current_state.status === "PENDING_REVIEW" || input.current_state.status === "STALE")) {
			return { ok: true, state: input.current_state };
		}
		if (input.current_state.latestId === transaction.delegation_id &&
			input.current_state.status === "REVIEWED" && input.current_state.reviewedDiffHash === authority.semanticBindingHash) {
			return { ok: true, state: input.current_state };
		}
		// A different or otherwise unbound session mirror has not yet passed the
		// review tool's owned freshness check.  Project it blocking; that tool may
		// promote the exact binding only after its current packet succeeds.
		return {
			ok: true,
			state: {
				latestId: transaction.delegation_id,
				status: "PENDING_REVIEW",
				currentDiffHash: authority.semanticBindingHash,
				blockedWriteAttempts: input.current_state.blockedWriteAttempts,
				updatedAt: input.now,
			},
		};
	}

	let binding = await collectCurrentDelegationBindingV2(input.project_root, transaction.delegation_id, input.exec);
	if (binding.status === "unavailable" && disposition.blocking) {
		binding = await collectLegacyFullDiffBindingV2(input.project_root, input.exec);
	}
	if (binding.status === "unavailable") {
		return { ok: false, issue: { code: "binding_unavailable", delegationId: transaction.delegation_id } };
	}
	if (input.terminal_mirror_blocked === true
		&& input.current_state.latestId === transaction.delegation_id
		&& input.current_state.status !== "REVIEWED"
		&& !disposition.blocking) return { ok: true, state: input.current_state };
	if (disposition.blocking
		&& input.current_state.latestId === transaction.delegation_id
		&& (input.current_state.status === "PENDING_REVIEW" || input.current_state.status === "STALE")) {
		return { ok: true, state: observeDiffChange(input.current_state, binding.hash, input.now) };
	}

	let status: DelegationState["status"];
	let reviewedDiffHash: string | undefined;
	if (transaction.status === "REVIEWED") {
		if (authority.kind !== "v2" || authority.review === null || !authority.finalized) {
			return { ok: false, issue: { code: "invalid_record", delegationId: transaction.delegation_id } };
		}
		if (!authority.semanticAccepted || authority.semanticBindingHash === null) {
			status = "PENDING_REVIEW";
		} else {
			reviewedDiffHash = authority.semanticBindingHash;
			status = binding.status === "fresh" && binding.hash === reviewedDiffHash ? "REVIEWED" : "STALE";
		}
	} else if (!disposition.blocking) {
		status = "REVIEWED";
		reviewedDiffHash = binding.hash;
	} else {
		status = "PENDING_REVIEW";
	}
	const state: DelegationState = {
		latestId: transaction.delegation_id,
		status,
		currentDiffHash: binding.hash,
		...(reviewedDiffHash === undefined ? {} : { reviewedDiffHash }),
		blockedWriteAttempts: input.current_state.blockedWriteAttempts,
		updatedAt: input.now,
	};
	return { ok: true, state: sameDelegationMirror(input.current_state, state) ? input.current_state : state };
}
