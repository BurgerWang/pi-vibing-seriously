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
	isDelegationTerminalNegativeReviewEligibleV1,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationSemanticRepairDecisionV1,
	readDelegationTerminalNegativeSolAuthorityV1,
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
	readDelegationAuthorityQuarantineV1,
	readDelegationInactiveBlockerClosureV2,
	type DelegationAuthorityQuarantineV1,
	type DelegationInactiveBlockerClosureV2,
} from "./delegation-authority-closure.ts";
import {
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
import { acquireProjectDelegationStartLockV1, releaseProjectDelegationStartLockV1 } from "./delegation-start-lock.ts";

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
	| { kind: "invalid-v2"; code: string };

export interface ProjectDelegationAuthorityIssueV2 {
	code: string;
	delegationId?: string;
}

export type ProjectDelegationRepairClosureV1 =
	| { ok: true; unresolvedTipId: string | null; rootCount: number; lineageCount: number }
	| { ok: false; issue: ProjectDelegationAuthorityIssueV2 };

export type ReconcileProjectDelegationAuthorityV2Result =
	| { ok: false; issue: ProjectDelegationAuthorityIssueV2 }
	| { ok: true; state: DelegationState | null };

export type AbandonCleanProjectDelegationRepairV1Result =
	| { ok: true; value: DelegationCleanRepairAbandonmentV1 }
	| { ok: false; code: string; delegation_id?: string };

export type CloseInactiveProjectDelegationBlockerV2Result =
	| { ok: true; value: DelegationInactiveBlockerClosureV2; remaining_blocker_id?: string }
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

	const decisions = new Map<string, DelegationSemanticRepairDecisionV1>();
	for (const transaction of transactions.values()) {
		if (transaction.status === "PENDING_REVIEW") {
			const read = await readDelegationSemanticRepairDecisionV1(projectRoot, transaction.delegation_id);
			if (!read.ok) return { ok: false, issue: { code: read.error.code, delegationId: transaction.delegation_id } };
			if (read.value !== undefined) decisions.set(transaction.delegation_id, read.value);
			continue;
		}
		if (transaction.repair_lineage !== undefined ||
			!isDelegationTerminalNegativeReviewEligibleV1(transaction)) continue;
		const read = await readDelegationTerminalNegativeSolAuthorityV1(projectRoot, transaction.delegation_id);
		if (read.ok) {
			decisions.set(transaction.delegation_id, read.value.decision);
			continue;
		}
		// A standalone terminal-negative transaction without a decision is an
		// ordinary blocker, not a malformed lineage root. If a successor claims
		// it, the missing root decision below makes the whole closure fail closed.
		if (read.error.code !== "not_found") {
			return { ok: false, issue: { code: read.error.code, delegationId: transaction.delegation_id } };
		}
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
			if (parent.status === "PENDING_REVIEW") {
				if (parentDecision === undefined || lineage.continuation_decision_delegation_id !== parent.delegation_id ||
					lineage.continuation_decision_hash !== parentDecision.decision_hash) {
					return { ok: false, issue: { code: "repair_lineage_continuation_invalid", delegationId: transaction.delegation_id } };
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

	const reached = new Set<string>();
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
		if (transaction.status === "PENDING_REVIEW") {
			const decision = await readDelegationSemanticRepairDecisionV1(projectRoot, transaction.delegation_id);
			if (!decision.ok) return { ok: false, issue: { code: decision.error.code, delegationId: transaction.delegation_id } };
			if (decision.value !== undefined) continue;
		}
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
		let terminalNegativeDecision: DelegationSemanticRepairDecisionV1 | undefined;
		if (transaction.repair_lineage === undefined && isDelegationTerminalNegativeReviewEligibleV1(transaction)) {
			const terminalNegative = await readDelegationTerminalNegativeSolAuthorityV1(projectRoot, delegationId);
			if (terminalNegative.ok) terminalNegativeDecision = terminalNegative.value.decision;
			else if (terminalNegative.error.code !== "not_found") {
				return { kind: "invalid-v2", code: terminalNegative.error.code };
			}
		}
		return {
			kind: "v2", transactionStatus: transaction.status, transactionVerdict: "FAIL",
			review: null, reviewPath: null, finalized: true,
			semanticAccepted: false, semanticBindingHash: null, semanticSource: null, semanticReviewer: null, semanticAcceptedAt: null,
			...repairObservation(transaction, terminalNegativeDecision),
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
	if (root.value.repair_lineage === undefined && isDelegationTerminalNegativeReviewEligibleV1(root.value)) {
		const terminal = await readDelegationTerminalNegativeSolAuthorityV1(projectRoot, rootDelegationId);
		if (terminal.ok) return { ok: true, value: terminal.value.decision };
		if (terminal.error.code === "not_found") return { ok: true, value: undefined };
		return { ok: false, issue: { code: terminal.error.code, delegationId: rootDelegationId } };
	}
	const semantic = await readDelegationSemanticRepairDecisionV1(projectRoot, rootDelegationId);
	if (!semantic.ok) {
		return { ok: false, issue: { code: semantic.error.code, delegationId: rootDelegationId } };
	}
	return semantic;
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
export async function closeInactiveProjectDelegationBlockerV2(input: {
	project_root: string;
	expected_delegation_id?: string;
	now: string;
	exec: ExecFn;
	closed_by: DelegationInactiveBlockerClosureV2["closed_by"];
}): Promise<CloseInactiveProjectDelegationBlockerV2Result> {
	const initial = await readProjectDelegationBlockerV2(input.project_root);
	if (!initial.ok) return { ok: false, code: initial.issue.code, ...(initial.issue.delegationId === undefined ? {} : { delegation_id: initial.issue.delegationId }) };
	if (initial.value === null) return { ok: false, code: "no_unresolved_blocker" };
	if (input.expected_delegation_id !== undefined && input.expected_delegation_id !== initial.value.delegation_id) {
		return { ok: false, code: "blocker_changed", delegation_id: initial.value.delegation_id };
	}
	if (["PREPARED", "RUNNING", "COMMITTING"].includes(initial.value.status)) {
		return { ok: false, code: "blocker_execution_active", delegation_id: initial.value.delegation_id };
	}
	const initialId = initial.value.delegation_id;
	const acquired = await acquireProjectDelegationStartLockV1({
		project_root: input.project_root,
		delegation_id: initialId,
		now: input.now,
	});
	if (!acquired.ok) return { ok: false, code: `start_lock_${acquired.error.code}`, delegation_id: initialId };

	const outcome = await (async (): Promise<CloseInactiveProjectDelegationBlockerV2Result> => {
		const current = await readProjectDelegationBlockerV2(input.project_root);
		if (!current.ok) return { ok: false, code: current.issue.code, ...(current.issue.delegationId === undefined ? {} : { delegation_id: current.issue.delegationId }) };
		if (current.value === null || current.value.delegation_id !== initialId) {
			return { ok: false, code: "blocker_changed", ...(current.value === null ? {} : { delegation_id: current.value.delegation_id }) };
		}
		if (["PREPARED", "RUNNING", "COMMITTING"].includes(current.value.status)) {
			return { ok: false, code: "blocker_execution_active", delegation_id: initialId };
		}
		const owner = await readDelegationExecutionOwnerV2(input.project_root, current.value);
		if (owner.ok) return { ok: false, code: "execution_owner_present", delegation_id: initialId };
		if (owner.error.code !== "not_found") return { ok: false, code: owner.error.code, delegation_id: initialId };
		const guard = await collectWorkspaceGuard({ project_root: input.project_root, exec: input.exec });
		if (!guard.ok) return { ok: false, code: `workspace_${guard.error.code}`, delegation_id: initialId };
		const published = await publishDelegationInactiveBlockerClosureV2({
			project_root: input.project_root,
			transaction: current.value,
			workspace_guard: guard.guard,
			closed_by: input.closed_by,
			now: input.now,
		});
		if (!published.ok) {
			const code = published.error.code === "not_recoverable" ? "relevant_paths_not_clean" : `blocker_closure_${published.error.code}`;
			return { ok: false, code, delegation_id: initialId };
		}
		const verified = await readProjectDelegationBlockerV2(input.project_root);
		if (!verified.ok) return { ok: false, code: verified.issue.code, ...(verified.issue.delegationId === undefined ? {} : { delegation_id: verified.issue.delegationId }) };
		if (verified.value?.delegation_id === initialId) return { ok: false, code: "blocker_closure_not_effective", delegation_id: initialId };
		return {
			ok: true,
			value: published.value,
			...(verified.value === null ? {} : { remaining_blocker_id: verified.value.delegation_id }),
		};
	})();
	const released = await releaseProjectDelegationStartLockV1(acquired.value);
	if (!released.ok) return { ok: false, code: `start_lock_release_${released.error.code}`, delegation_id: initialId };
	return outcome;
}

/**
 * Quarantine one stable unreadable v2 envelope without moving/deleting it or
 * accepting any project delta. Receipts are inventory-versioned: later bytes
 * re-block until Sol explicitly quarantines the new stable inventory.
 */
export async function quarantineProjectDelegationAuthorityV1(input: {
	project_root: string;
	delegation_id: string;
	now: string;
	quarantined_by: DelegationAuthorityQuarantineV1["quarantined_by"];
}): Promise<QuarantineProjectDelegationAuthorityV1Result> {
	const initial = await readDelegationTransactionV2(input.project_root, input.delegation_id);
	if (initial.ok) return { ok: false, code: "authority_is_readable", delegation_id: input.delegation_id };
	if (initial.error.code === "not_found") {
		try {
			const v2 = await lstat(join(delegationsDir(input.project_root), input.delegation_id, "v2"));
			if (!v2.isDirectory() || v2.isSymbolicLink()) return { ok: false, code: "authority_not_recoverable", delegation_id: input.delegation_id };
		} catch {
			return { ok: false, code: "authority_not_found", delegation_id: input.delegation_id };
		}
	}
	const issueCode = initial.error.code === "not_found" ? "incomplete_v2_authority" : initial.error.code;
	const acquired = await acquireProjectDelegationStartLockV1({
		project_root: input.project_root,
		delegation_id: input.delegation_id,
		now: input.now,
	});
	if (!acquired.ok) return { ok: false, code: `start_lock_${acquired.error.code}`, delegation_id: input.delegation_id };
	const outcome = await (async (): Promise<QuarantineProjectDelegationAuthorityV1Result> => {
		const current = await readDelegationTransactionV2(input.project_root, input.delegation_id);
		if (current.ok || current.error.code !== initial.error.code) {
			return { ok: false, code: "authority_changed", delegation_id: input.delegation_id };
		}
		const published = await publishDelegationAuthorityQuarantineV1({
			project_root: input.project_root,
			delegation_id: input.delegation_id,
			issue_code: issueCode,
			quarantined_by: input.quarantined_by,
			now: input.now,
		});
		if (!published.ok) return { ok: false, code: `authority_quarantine_${published.error.code}`, delegation_id: input.delegation_id };
		const verified = await readDelegationAuthorityQuarantineV1(input.project_root, input.delegation_id);
		if (!verified.ok || verified.value === undefined) {
			return { ok: false, code: verified.ok ? "authority_quarantine_not_effective" : `authority_quarantine_${verified.error.code}`, delegation_id: input.delegation_id };
		}
		return { ok: true, value: published.value };
	})();
	const released = await releaseProjectDelegationStartLockV1(acquired.value);
	if (!released.ok) return { ok: false, code: `start_lock_release_${released.error.code}`, delegation_id: input.delegation_id };
	return outcome;
}

/**
 * Close one exact unresolved semantic repair after Sol observes a strictly
 * clean Git workspace. No project file or Git ref is changed; the old rejected
 * transaction remains immutable and is closed only by the new bound receipt.
 */
export async function abandonCleanProjectDelegationRepairV1(input: {
	project_root: string;
	now: string;
	exec: ExecFn;
	abandoned_by: DelegationCleanRepairAbandonmentV1["abandoned_by"];
}): Promise<AbandonCleanProjectDelegationRepairV1Result> {
	const initial = await readProjectDelegationRepairClosureV1(input.project_root);
	if (!initial.ok) return { ok: false, code: initial.issue.code, ...(initial.issue.delegationId === undefined ? {} : { delegation_id: initial.issue.delegationId }) };
	if (initial.unresolvedTipId === null) return { ok: false, code: "no_unresolved_repair" };
	const initialTipId = initial.unresolvedTipId;
	const acquired = await acquireProjectDelegationStartLockV1({
		project_root: input.project_root,
		delegation_id: initialTipId,
		now: input.now,
	});
	if (!acquired.ok) return { ok: false, code: `start_lock_${acquired.error.code}`, delegation_id: initialTipId };

	const outcome = await (async (): Promise<AbandonCleanProjectDelegationRepairV1Result> => {
		const closure = await readProjectDelegationRepairClosureV1(input.project_root);
		if (!closure.ok) return { ok: false, code: closure.issue.code, ...(closure.issue.delegationId === undefined ? {} : { delegation_id: closure.issue.delegationId }) };
		if (closure.unresolvedTipId !== initialTipId) {
			return { ok: false, code: "repair_authority_changed", ...(closure.unresolvedTipId === null ? {} : { delegation_id: closure.unresolvedTipId }) };
		}
		const tip = await readDelegationTransactionV2(input.project_root, initialTipId);
		if (!tip.ok) return { ok: false, code: tip.error.code, delegation_id: initialTipId };
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
		if (guard.guard.entries.length !== 0 || guard.guard.git_head === null) {
			return { ok: false, code: "workspace_not_clean", delegation_id: tip.value.delegation_id };
		}
		const published = await publishDelegationCleanRepairAbandonmentV1({
			project_root: input.project_root,
			tip: tip.value,
			root_decision: rootDecision.value,
			clean_guard: guard.guard,
			abandoned_by: input.abandoned_by,
			now: input.now,
		});
		if (!published.ok) return { ok: false, code: `repair_abandonment_${published.error.code}`, delegation_id: tip.value.delegation_id };
		const verified = await readProjectDelegationRepairClosureV1(input.project_root);
		if (!verified.ok || verified.unresolvedTipId !== null) {
			return {
				ok: false,
				code: verified.ok ? "repair_abandonment_not_closed" : verified.issue.code,
				...(verified.ok || verified.issue.delegationId === undefined ? {} : { delegation_id: verified.issue.delegationId }),
			};
		}
		return { ok: true, value: published.value };
	})();
	const released = await releaseProjectDelegationStartLockV1(acquired.value);
	if (!released.ok) return { ok: false, code: `start_lock_release_${released.error.code}`, delegation_id: initialTipId };
	return outcome;
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
