import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import type { ExecFn } from "./config.ts";
import {
	collectGitFacts,
	computeDiffHash,
	delegationsDir,
	isValidDelegationId,
} from "./delegation-ledger.ts";
import {
	observeDiffChange,
	type DelegationState,
} from "./delegation-state.ts";
import {
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTransactionV2,
	type DelegationTransactionStorageErrorCode,
} from "./delegation-transaction-storage.ts";
import type { DelegationTransactionRecord } from "./delegation-transaction.ts";
import { DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2 } from "./delegation-workspace-v2.ts";
import { readReviewRecord, type ReviewRecord } from "./diff-review.ts";
import { collectReviewRelevanceV2, computeReviewRelevanceConflictHashV2 } from "./review-relevance-v2.ts";
import { validateWorkspaceGuard, type WorkspaceGuardRecord } from "./workspace-guard.ts";
import { readWorkerWriteJournal, type WorkerWriteJournalRecord } from "./write-journal.ts";

/** Bound discovery work so a hostile artifacts directory cannot stall startup. */
export const MAX_PROJECT_DELEGATION_ENTRIES_V2 = 10_000 as const;

export type ProjectDelegationAuthorityErrorCodeV2 =
	| "invalid_project_authority"
	| "storage_failure"
	| "too_many_delegations";

export type LatestProjectDelegationTransactionV2Result =
	| { ok: true; value: DelegationTransactionRecord | null }
	| {
		ok: false;
		error: {
			code: ProjectDelegationAuthorityErrorCodeV2;
			delegation_id?: string;
			cause?: DelegationTransactionStorageErrorCode;
		};
	};

export interface ProjectDelegationDispositionV2 {
	blocking: boolean;
	terminal_verdict: "PASS" | "FAIL" | null;
}

export type CurrentDelegationBindingV2 =
	| { status: "fresh"; hash: string; kind: "changeset-relevance-v2" | "legacy-full-diff" }
	| { status: "conflict"; hash: string; kind: "changeset-relevance-v2"; code: string }
	| { status: "unavailable" };

export type DelegationAuthorityObservationV2 =
	| {
		kind: "v2";
		transactionStatus: string;
		transactionVerdict: "PASS" | "FAIL" | null;
		review: ReviewRecord | null;
		reviewPath: string | null;
		finalized: boolean;
	}
	| { kind: "legacy"; review: ReviewRecord | null }
	| { kind: "invalid-v2"; code: string };

export interface ProjectDelegationAuthorityIssueV2 {
	code: string;
	delegationId?: string;
}

export type ReconcileProjectDelegationAuthorityV2Result =
	| { ok: false; issue: ProjectDelegationAuthorityIssueV2 }
	| { ok: true; state: DelegationState | null };

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
	"committed artifact construction failed: record_too_large",
	"committed artifact construction failed: internal_error",
]);

function failure(
	code: ProjectDelegationAuthorityErrorCodeV2,
	delegationId?: string,
	cause?: DelegationTransactionStorageErrorCode,
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

	if (entries.length > MAX_PROJECT_DELEGATION_ENTRIES_V2) return failure("too_many_delegations");
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
				found.push(transaction.value);
				continue;
			}
			if (transaction.error.code !== "not_found") {
				return failure("invalid_project_authority", delegationId, transaction.error.code);
			}
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
	return { ok: true, value: { transaction: state, journal: journal.value } };
}

/** Map durable transaction state to the session-level blocking disposition. */
export function projectDelegationDispositionV2(
	transaction: DelegationTransactionRecord,
): ProjectDelegationDispositionV2 {
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
		terminal_verdict: transaction.status === "FAILED" ? "FAIL" : null,
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
	const relevance = await collectReviewRelevanceV2({
		project_root: projectRoot,
		delegation_id: committed.value.state.delegation_id,
		contract_hash: committed.value.state.contract_hash,
		after_guard: afterGuard as WorkspaceGuardRecord,
		change_set: changeSet as ChangeSetRecord,
		exec,
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
	const raw = await readDelegationTransactionV2(projectRoot, delegationId);
	if (!raw.ok) {
		if (raw.error.code !== "not_found") return { kind: "invalid-v2", code: raw.error.code };
		try {
			return { kind: "legacy", review: await readReviewRecord(projectRoot, delegationId) };
		} catch {
			return { kind: "legacy", review: null };
		}
	}

	const rawTransaction = raw.value;
	if (rawTransaction.status === "ABORTED") {
		return {
			kind: "v2", transactionStatus: rawTransaction.status, transactionVerdict: "FAIL",
			review: null, reviewPath: null, finalized: true,
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
		};
	}

	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId);
	if (!committed.ok) return { kind: "invalid-v2", code: committed.error.code };
	const transaction = committed.value.state;
	if (transaction.status === "FAILED") {
		return {
			kind: "v2", transactionStatus: transaction.status, transactionVerdict: "FAIL",
			review: null, reviewPath: null, finalized: true,
		};
	}
	if (transaction.task_kind === "diagnosis") {
		const completed = transaction.status === "FINISHED"
			&& transaction.terminal_outcome !== null
			&& transaction.postcondition_reasons.length === 0;
		return {
			kind: "v2", transactionStatus: transaction.status, transactionVerdict: completed ? "PASS" : null,
			review: null, reviewPath: null, finalized: completed,
		};
	}
	const review = await readDelegationReviewV2(projectRoot, delegationId);
	if (!review.ok) {
		if (review.error.code === "not_found" && transaction.status === "PENDING_REVIEW") {
			return {
				kind: "v2", transactionStatus: transaction.status, transactionVerdict: null,
				review: null, reviewPath: null, finalized: false,
			};
		}
		return { kind: "invalid-v2", code: review.error.code };
	}
	return {
		kind: "v2",
		transactionStatus: transaction.status,
		transactionVerdict: null,
		review: review.value.review,
		reviewPath: review.value.review_path,
		finalized: review.value.finalized,
	};
}

function sameDelegationMirror(left: DelegationState, right: DelegationState): boolean {
	return left.latestId === right.latestId
		&& left.status === right.status
		&& left.currentDiffHash === right.currentDiffHash
		&& left.reviewedDiffHash === right.reviewedDiffHash
		&& left.blockedWriteAttempts === right.blockedWriteAttempts;
}

/** Pure-result reconciliation over strict project authority; persistence remains caller-owned. */
export async function reconcileProjectDelegationAuthorityV2(input: {
	project_root: string;
	current_state: DelegationState;
	now: string;
	exec: ExecFn;
	terminal_mirror_blocked?: boolean;
	defer_reviewed_freshness?: boolean;
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
	if (latest.value === null) return { ok: true, state: null };
	const transaction = latest.value;
	const authority = await readDelegationAuthorityObservationV2(input.project_root, transaction.delegation_id);
	if (authority.kind === "invalid-v2") {
		return { ok: false, issue: { code: authority.code, delegationId: transaction.delegation_id } };
	}
	const disposition = projectDelegationDispositionV2(transaction);
	if (transaction.status === "REVIEWED" && input.defer_reviewed_freshness === true) {
		if (authority.kind !== "v2" || authority.review === null || !authority.finalized) {
			return { ok: false, issue: { code: "invalid_record", delegationId: transaction.delegation_id } };
		}
		if (input.current_state.latestId === transaction.delegation_id) return { ok: true, state: input.current_state };
		return {
			ok: true,
			state: {
				latestId: transaction.delegation_id,
				status: "REVIEWED",
				currentDiffHash: authority.review.bound_diff_hash,
				reviewedDiffHash: authority.review.bound_diff_hash,
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
		reviewedDiffHash = authority.review.bound_diff_hash;
		status = binding.status === "fresh" && binding.hash === reviewedDiffHash ? "REVIEWED" : "STALE";
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
