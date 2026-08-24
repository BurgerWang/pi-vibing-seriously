import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	commitDelegationGeneration,
	computeHistoricalSemanticMigrationBindingHashV2,
	createNodeDelegationTransactionStorageAdapter,
	DELEGATION_SEMANTIC_MIGRATION_STORAGE_FAULT_POINTS,
	DELEGATION_SEMANTIC_REPAIR_STORAGE_FAULT_POINTS,
	DELEGATION_TRANSACTION_REPORT_MAX_BYTES,
	DELEGATION_TRANSACTION_SCOPE_RECORD_MAX_BYTES,
	DELEGATION_TRANSACTION_STORAGE_FAULT_POINTS,
	delegationGenerationRecordRelativePathV2,
	delegationReviewRelativePathV2,
	hashDelegationCommittedRecords,
	hasDelegationSemanticRepairAuthorityV2,
	hasDelegationSemanticReviewAuthorityV2,
	persistAbortedDelegationTransaction,
	persistCommittingDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRecoveryRequiredDelegationTransaction,
	persistReviewedDelegationTransaction,
	persistRunningDelegationTransaction,
	persistDelegationReviewProvisionalV2,
	publishDelegationReviewV2,
	publishDelegationSemanticRepairDecisionV1,
	publishHistoricalSemanticMigrationAcceptanceV2,
	publishHistoricalSemanticMigrationPresentationV2,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationSemanticMigrationV1,
	readDelegationSemanticRepairDecisionV1,
	readDelegationTransactionV2,
	verifyDelegationGenerationV2,
	type CommitDelegationGenerationInput,
	type DelegationCommittedRecords,
	type DelegationReviewArtifactV2,
	type DelegationSemanticRepairDecisionV1,
	type DelegationSemanticMigrationCandidateProjectionV1,
	type DelegationTransactionStorageAdapter,
	type DelegationTransactionStorageFaultPoint,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	DELEGATION_COMMITTED_RECORD_NAMES,
	DELEGATION_TRANSACTION_SCHEMA_VERSION,
	type DelegationTaskKind,
	type DelegationTerminalOutcome,
	type DelegationTransactionRecord,
	type DelegationWorkerIdentity,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { computeChangeSet, type ChangeSetRecord } from "../extensions/workbench-runtime/core/change-set.ts";
import type { StreamingPathIdentity } from "../extensions/workbench-runtime/core/streaming-identity.ts";
import { computeWorkspaceGuardHash, type WorkspaceGuardRecord } from "../extensions/workbench-runtime/core/workspace-guard.ts";
import { computeWorkerWriteJournalHash, type WorkerWriteJournalRecord } from "../extensions/workbench-runtime/core/write-journal.ts";
import { computeDiffHash } from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import { DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2 } from "../extensions/workbench-runtime/core/delegation-workspace-v2.ts";
import {
	computeReviewRelevanceProjectionHashV2,
	REVIEW_RELEVANCE_KIND_V2,
	type ReviewRelevanceProjectionV2,
} from "../extensions/workbench-runtime/core/review-relevance-v2.ts";
import type { ReviewRecord } from "../extensions/workbench-runtime/core/diff-review.ts";

const ID = "20260817-150000-abcd";
const ID_2 = "20260817-150001-efgh";
const HASH = "a".repeat(64);
const REVIEW_HASH = "b".repeat(64);
const DELTA_HASH = "c".repeat(64);
const IDENTITY: DelegationWorkerIdentity = {
	provider: WORKER_PROVIDER,
	model: WORKER_MODEL_ID,
	worker_id: "storage-worker-1",
};

test("storage v2 generation record locator accepts only bounded identity and exact record names", () => {
	assert.equal(
		delegationGenerationRecordRelativePathV2(ID, 1, "worker-report.md"),
		`.pi/workbench/delegations/${ID}/v2/generations/g00000001/worker-report.md`,
	);
	assert.equal(delegationGenerationRecordRelativePathV2("../escape", 1, "worker-report.md"), undefined);
	assert.equal(delegationGenerationRecordRelativePathV2(ID, 100_000_000, "worker-report.md"), undefined);
	assert.equal(delegationGenerationRecordRelativePathV2(ID, 1, "other.json" as never), undefined);
});

function at(second: number): string {
	return `2026-08-17T15:00:${String(second).padStart(2, "0")}.000Z`;
}

function transactionDir(root: string, id = ID): string {
	return join(root, CONFIG_DIR_NAME, "workbench", "delegations", id, "v2");
}

function transactionPath(root: string, id = ID): string {
	return join(transactionDir(root, id), "transaction.json");
}

function lockPath(root: string, id = ID): string {
	return join(transactionDir(root, id), "transaction.lock");
}

function reviewPath(root: string, id = ID): string {
	return join(transactionDir(root, id), "review.json");
}

function semanticMigrationPath(root: string, id = ID): string {
	return join(transactionDir(root, id), "semantic-migration.json");
}

function semanticRepairPath(root: string, id = ID): string {
	return join(transactionDir(root, id), "repair-decision.json");
}

function generationDir(root: string, generation = 1, id = ID): string {
	return join(transactionDir(root, id), "generations", `g${String(generation).padStart(8, "0")}`);
}

async function tempProject(): Promise<string> {
	return mkdtemp(join(tmpdir(), "delegation-v2-storage-"));
}

function cas(state: DelegationTransactionRecord, second: number) {
	return structuredClone({
		delegation_id: state.delegation_id,
		contract_hash: state.contract_hash,
		worker_identity: { ...state.worker_identity },
		expected_generation: state.generation,
		expected_revision: state.revision,
		now: at(second),
	});
}

function authority(kind: DelegationTaskKind, id = ID): {
	journal: WorkerWriteJournalRecord;
	beforeGuard: WorkspaceGuardRecord;
	afterGuard: WorkspaceGuardRecord;
	changeSet: ChangeSetRecord;
} {
	const path = "src/changed.ts";
	const missing: StreamingPathIdentity = { schema_version: 2, kind: "missing", path };
	const present: StreamingPathIdentity = {
		schema_version: 2, kind: "file", path, byte_size: 7, sha256: "2".repeat(64),
		stat: { dev: "1", ino: "2", mtime_ns: "3", ctime_ns: "4" },
	};
	const beforePresent: StreamingPathIdentity = {
		...present, sha256: "1".repeat(64),
		stat: { ...present.stat, mtime_ns: "2", ctime_ns: "2" },
	};
	const operations = kind === "implementation" ? [{
		sequence: 1, operation_id: "1".repeat(64), kind: "write" as const, path, status: "completed" as const,
		before: beforePresent, after: present, outcome: "succeeded" as const,
	}] : [];
	const journalBase: WorkerWriteJournalRecord = {
		schema_version: 2, delegation_id: id, contract_hash: HASH, state: "SEALED",
		revision: kind === "implementation" ? 3 : 1,
		limits: {
			max_unique_paths: 500, max_operations: 1000, max_identity_paths: 500,
			max_total_bytes: 256 * 1024 * 1024, max_file_bytes: 64 * 1024 * 1024, max_serialized_bytes: 4 * 1024 * 1024,
		},
		meter: kind === "implementation"
			? { paths_attempted: 2, paths_completed: 2, bytes_read: 14 }
			: { paths_attempted: 0, paths_completed: 0, bytes_read: 0 },
		operations, journal_hash: "0".repeat(64),
	};
	const journal = { ...journalBase, journal_hash: computeWorkerWriteJournalHash(journalBase) };
	const beforeGuard: WorkspaceGuardRecord = {
		schema_version: 2, git_head: "1".repeat(40), entries: [], irrelevant_artifact_paths: [],
		meter: { status_bytes: 0, relevant_paths: 0, irrelevant_paths: 0, stat_calls: 0, content_bytes_read: 0 },
		workspace_guard_hash: computeWorkspaceGuardHash("1".repeat(40), []),
	};
	const afterEntries = kind === "implementation" ? [{
		path, status: "??", identity: { kind: "file" as const, byte_size: 7, stat: { ...present.stat } },
	}] : [];
	const afterGuard: WorkspaceGuardRecord = {
		schema_version: 2, git_head: "1".repeat(40), entries: afterEntries, irrelevant_artifact_paths: [],
		meter: { status_bytes: afterEntries.length === 0 ? 0 : 18, relevant_paths: afterEntries.length, irrelevant_paths: 0, stat_calls: afterEntries.length * 2, content_bytes_read: 0 },
		workspace_guard_hash: computeWorkspaceGuardHash("1".repeat(40), afterEntries),
	};
	const computed = computeChangeSet({
		delegation_id: id, contract_hash: HASH, journal_hash: journal.journal_hash!, journal,
		before_guard: beforeGuard, after_guard: afterGuard, dependency_paths: [],
		final_identities: kind === "implementation" ? [present] : [],
		finalization_meter: kind === "implementation"
			? { paths_attempted: 1, paths_completed: 1, bytes_read: 7 }
			: { paths_attempted: 0, paths_completed: 0, bytes_read: 0 },
	});
	if (!computed.ok) throw new Error(computed.error.code);
	return { journal, beforeGuard, afterGuard, changeSet: computed.value as ChangeSetRecord };
}

function outcome(kind: DelegationTaskKind, id = ID): DelegationTerminalOutcome {
	const facts = authority(kind, id);
	const changedPaths = facts.changeSet.worker_delta.map((entry) => entry.path);
	return structuredClone({
		delegation_id: id,
		task_kind: kind,
		worker_identity: { ...IDENTITY },
		provider_success: true,
		exit_code: 0,
		report_complete: true,
		terminal_facts_complete: true,
		scope_complete: true,
		change_set_status: facts.changeSet.status,
		changed_paths: changedPaths,
		successful_write_count: facts.journal.operations.filter((operation) => operation.status === "completed" && operation.outcome === "succeeded").length,
		denied_write_count: 0,
		delta_hash: kind === "implementation" ? facts.changeSet.worker_delta_hash : null,
	});
}

async function committingState(
	root: string,
	kind: DelegationTaskKind = "implementation",
	id = ID,
): Promise<DelegationTransactionRecord> {
	const prepared = await persistPreparedDelegationTransaction(root, {
		delegation_id: id,
		task_kind: kind,
		contract_hash: HASH,
		allowed_paths: ["src/**"],
		worker_identity: { ...IDENTITY },
		generation: 1,
		now: at(0),
	});
	assert.equal(prepared.ok, true);
	const running = await persistRunningDelegationTransaction(root, cas(prepared.value, 1));
	assert.equal(running.ok, true);
	const committing = await persistCommittingDelegationTransaction(root, {
		...cas(running.value, 2),
		outcome: outcome(kind, id),
	});
	assert.equal(committing.ok, true);
	return committing.value;
}

function recordsFor(state: DelegationTransactionRecord): DelegationCommittedRecords {
	assert.notEqual(state.terminal_outcome, null);
	const facts = authority(state.task_kind, state.delegation_id);
	const changedPaths = facts.changeSet.worker_delta.map((entry) => entry.path);
	const pathStatuses = Object.fromEntries(facts.afterGuard.entries.map((entry) => [entry.path, entry.status]));
	const pathDigests = Object.fromEntries(facts.afterGuard.entries.filter((entry) => entry.identity.kind === "file").map((entry) => [entry.path, "2".repeat(64)]));
	const beforePathDigests = Object.fromEntries(facts.changeSet.worker_delta
		.filter((entry) => entry.before.kind === "file")
		.map((entry) => [entry.path, entry.before.kind === "file" ? entry.before.sha256 : ""]));
	return structuredClone({
		"after.json": {
			schema_version: 2, diff_identity_kind: DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2,
			delegation_id: state.delegation_id, recorded_at: state.updated_at, status: "success", exit_code: 0,
			pinned_identity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID }, git_head: facts.afterGuard.git_head,
			git_dirty: facts.afterGuard.entries.length > 0, diff_hash: facts.afterGuard.workspace_guard_hash, changed_paths: changedPaths,
			path_statuses: pathStatuses, path_digests: pathDigests, changed_since_before: changedPaths,
			workspace_guard: facts.afterGuard, change_set_status: facts.changeSet.status,
			worker_delta_hash: facts.changeSet.worker_delta_hash, workspace_guard_hash: facts.changeSet.workspace_guard_hash,
			change_set_hash: facts.changeSet.change_set_hash, reported_paths: changedPaths, usage: {}, budget: {},
			report_summary: "storage transaction completed", review_status: "PENDING_REVIEW",
		},
		"before.json": {
			schema_version: 2, diff_identity_kind: DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2,
			delegation_id: state.delegation_id, recorded_at: state.created_at, contract: { task_kind: state.task_kind },
			git_head: facts.beforeGuard.git_head, git_dirty: false, diff_hash: facts.beforeGuard.workspace_guard_hash, changed_paths: [],
			path_statuses: {}, path_digests: beforePathDigests, workspace_guard: facts.beforeGuard,
		},
		"identity.json": {
			schema_version: 2,
			delegation_id: state.delegation_id,
			task_kind: state.task_kind,
			contract_hash: state.contract_hash,
			generation: state.generation,
			revision: state.revision,
			worker_identity: { ...state.worker_identity },
		},
		"review.json": { schema_version: 2, delegation_id: state.delegation_id, review_status: "PENDING_REVIEW" },
		"scope.json": {
			schema_version: 2,
			delegation_id: state.delegation_id,
			task_kind: state.task_kind,
			contract_hash: state.contract_hash,
			allowed_paths: [...state.allowed_paths],
			changed_paths: [...state.terminal_outcome!.changed_paths],
			write_journal: facts.journal,
			change_set: facts.changeSet,
		},
		"usage.json": { schema_version: 2, delegation_id: state.delegation_id, total_tokens: 20 },
		"worker-report.md": "## Completed\n\nStorage transaction completed.\n",
		"worker-summary.json": { schema_version: 2, delegation_id: state.delegation_id, changed_paths: changedPaths },
	});
}

function commitInput(state: DelegationTransactionRecord, records = recordsFor(state), second = 3): CommitDelegationGenerationInput {
	return { ...cas(state, second), records };
}

async function completeProvisionalSemanticReview(root: string): Promise<{
	state: DelegationTransactionRecord;
	artifact: DelegationReviewArtifactV2;
	reviewHash: string;
}> {
	const committing = await committingState(root);
	const committed = await commitDelegationGeneration(root, commitInput(committing));
	assert.equal(committed.ok, true);
	if (!committed.ok) throw new Error("commit failed");
	const facts = authority("implementation");
	const changedPaths = [...committed.value.terminal_outcome!.changed_paths];
	const relevanceProjection: ReviewRelevanceProjectionV2 = {
		schema_version: 2,
		diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
		delegation_id: ID,
		contract_hash: HASH,
		change_set_hash: facts.changeSet.change_set_hash,
		worker_delta_hash: facts.changeSet.worker_delta_hash,
		git_head: facts.afterGuard.git_head,
		entries: changedPaths.map((path) => ({
			path,
			roles: ["W"] as const,
			status: facts.afterGuard.entries.find((entry) => entry.path === path)?.status ?? "CLEAN",
			full_identity: facts.changeSet.worker_delta.find((entry) => entry.path === path)!.after,
		})),
	};
	const boundDiffHash = computeReviewRelevanceProjectionHashV2(relevanceProjection);
	const reviewedAt = at(4);
	const patchText = "changed\n";
	const patchHash = createHash("sha256").update(patchText, "utf8").digest("hex");
	const review: ReviewRecord = {
		schema_version: 2,
		delegation_id: ID,
		reviewed_at: reviewedAt,
		verdict: "PASS",
		bound_diff_hash: boundDiffHash,
		recorded_after_hash: boundDiffHash,
		mismatch: false,
		drift_paths: [],
		violations: [],
		allowed_paths: [...committed.value.allowed_paths],
		checked_paths: changedPaths,
		include_paths: [],
		patch: changedPaths.map((path) => ({ path, source: "file-content" as const, text: patchText, truncated: false })),
		patch_truncated: false,
		patch_paths: changedPaths.map((path) => ({ path, source: "file-content" as const, bytes: 8, truncated: false })),
		notes: [],
		displayed_paths: changedPaths,
		remaining_paths: [],
		coverage_complete: true,
		fully_presented_paths: changedPaths,
		presentation_remaining_paths: [],
		presentation_complete: true,
		presentation_progress: changedPaths.map((path) => ({
			path,
			source: "file-content" as const,
			stream_sha256: patchHash,
			next_byte: 8,
			total_bytes: 8,
			segments: [{ start_byte: 0, end_byte: 8, page_sha256: patchHash }],
		})),
		semantic_review: "required",
		review_path: delegationReviewRelativePathV2(ID)!,
		diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
		relevance_binding: {
			schema_version: 2,
			diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
			projection_hash: boundDiffHash,
		},
		relevance_projection: relevanceProjection,
	};
	const artifact: DelegationReviewArtifactV2 = {
		schema_version: 2,
		delegation_id: ID,
		task_kind: "implementation",
		contract_hash: HASH,
		worker_identity: { ...IDENTITY },
		generation: committed.value.generation,
		transaction_revision: 3,
		reviewed_at: reviewedAt,
		review,
	};
	const persisted = await persistDelegationReviewProvisionalV2(root, { ...cas(committed.value, 4), artifact });
	assert.equal(persisted.ok, true, persisted.ok ? "" : persisted.error.code);
	if (!persisted.ok) throw new Error("provisional review failed");
	return { state: committed.value, artifact, reviewHash: persisted.value.review_hash };
}

function repairDecisionInput(
	fixture: Awaited<ReturnType<typeof completeProvisionalSemanticReview>>,
	second = 5,
) {
	return {
		...cas(fixture.state, second),
		base_review_hash: fixture.reviewHash,
		expected_bound_diff_hash: fixture.artifact.review.bound_diff_hash,
		repair_reason: "The complete packet does not satisfy the requested behavior.",
		reviewer: { provider: "openai" as const, model: "gpt-5.6-sol" as const },
	};
}

function acceptedReviewArtifact(
	fixture: Awaited<ReturnType<typeof completeProvisionalSemanticReview>>,
	second = 6,
): DelegationReviewArtifactV2 {
	const artifact = structuredClone(fixture.artifact);
	artifact.reviewed_at = at(second);
	artifact.review.reviewed_at = at(second);
	artifact.review.semantic_review = "accepted";
	artifact.review.semantic_acceptance = {
		decision: "ACCEPT",
		expected_bound_diff_hash: artifact.review.bound_diff_hash,
		reviewer: { provider: "openai", model: "gpt-5.6-sol" },
		accepted_at: at(second),
	};
	return artifact;
}

async function finalizedHistoricalMechanicalReview(root: string): Promise<{
	state: DelegationTransactionRecord;
	review: ReviewRecord;
	reviewHash: string;
	projection: DelegationSemanticMigrationCandidateProjectionV1;
}> {
	const committing = await committingState(root);
	const committed = await commitDelegationGeneration(root, commitInput(committing));
	assert.equal(committed.ok, true);
	if (!committed.ok) throw new Error("commit failed");
	const facts = authority("implementation");
	const changedPaths = [...committed.value.terminal_outcome!.changed_paths];
	const relevanceProjection: ReviewRelevanceProjectionV2 = {
		schema_version: 2,
		diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
		delegation_id: ID,
		contract_hash: HASH,
		change_set_hash: facts.changeSet.change_set_hash,
		worker_delta_hash: facts.changeSet.worker_delta_hash,
		git_head: facts.afterGuard.git_head,
		entries: changedPaths.map((path) => ({
			path,
			roles: ["W"] as const,
			status: facts.afterGuard.entries.find((entry) => entry.path === path)?.status ?? "CLEAN",
			full_identity: facts.changeSet.worker_delta.find((entry) => entry.path === path)!.after,
		})),
	};
	const boundDiffHash = computeReviewRelevanceProjectionHashV2(relevanceProjection);
	const reviewedAt = at(4);
	const review: ReviewRecord = {
		schema_version: 2,
		delegation_id: ID,
		reviewed_at: reviewedAt,
		verdict: "PASS",
		bound_diff_hash: boundDiffHash,
		recorded_after_hash: boundDiffHash,
		mismatch: false,
		drift_paths: [],
		violations: [],
		allowed_paths: [...committed.value.allowed_paths],
		checked_paths: changedPaths,
		include_paths: [],
		patch: changedPaths.map((path) => ({ path, source: "file-content" as const, text: "changed\n", truncated: false })),
		patch_truncated: false,
		patch_paths: changedPaths.map((path) => ({ path, source: "file-content" as const, bytes: 8, truncated: false })),
		notes: [],
		displayed_paths: changedPaths,
		remaining_paths: [],
		coverage_complete: true,
		fully_presented_paths: changedPaths,
		presentation_remaining_paths: [],
		presentation_complete: true,
		semantic_review: "accepted",
		semantic_acceptance: {
			decision: "ACCEPT",
			expected_bound_diff_hash: boundDiffHash,
			reviewer: { provider: "openai", model: "gpt-5.6-sol" },
			accepted_at: reviewedAt,
		},
		review_path: delegationReviewRelativePathV2(ID)!,
		diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
		relevance_binding: {
			schema_version: 2,
			diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
			projection_hash: boundDiffHash,
		},
		relevance_projection: relevanceProjection,
	};
	const artifact: DelegationReviewArtifactV2 = {
		schema_version: 2,
		delegation_id: ID,
		task_kind: "implementation",
		contract_hash: HASH,
		worker_identity: { ...IDENTITY },
		generation: committed.value.generation,
		transaction_revision: 3,
		reviewed_at: reviewedAt,
		review,
	};
	const finalized = await publishDelegationReviewV2(root, { ...cas(committed.value, 4), artifact });
	assert.equal(finalized.ok, true, finalized.ok ? "" : finalized.error.code);
	if (!finalized.ok) throw new Error("review finalization failed");

	const rawArtifact = JSON.parse(await readFile(reviewPath(root), "utf8")) as Record<string, any>;
	for (const field of [
		"fully_presented_paths", "presentation_remaining_paths", "presentation_complete",
		"semantic_review", "semantic_acceptance",
	]) delete rawArtifact.review[field];
	const historicalBytes = `${JSON.stringify(rawArtifact, null, 2)}\n`;
	await writeFile(reviewPath(root), historicalBytes, "utf8");
	const rawTransaction = JSON.parse(await readFile(transactionPath(root), "utf8")) as Record<string, any>;
	const reviewHash = createHash("sha256").update(historicalBytes).digest("hex");
	rawTransaction.review.review_hash = reviewHash;
	await writeFile(transactionPath(root), `${JSON.stringify(rawTransaction, null, 2)}\n`, "utf8");
	const strict = await readDelegationReviewV2(root, ID);
	assert.equal(strict.ok, true, strict.ok ? "" : strict.error.code);
	if (!strict.ok) throw new Error("historical review strict read failed");
	assert.equal(strict.value.finalized, true);
	assert.equal(strict.value.semantic_migration, undefined);
	const migrationProjection: DelegationSemanticMigrationCandidateProjectionV1 = {
		schema_version: 1,
		kind: "historical-semantic-migration-v1",
		old_git_head: facts.afterGuard.git_head!,
		candidate_git_head: "2".repeat(40),
		head_delta_paths: changedPaths,
		head_delta_hash: "3".repeat(64),
		closed_content_hash: "4".repeat(64),
		baseline_guard_hash: facts.afterGuard.workspace_guard_hash,
		migration_binding_hash: "0".repeat(64),
	};
	migrationProjection.migration_binding_hash = computeHistoricalSemanticMigrationBindingHashV2({
		delegation_id: ID,
		contract_hash: HASH,
		base_review_hash: reviewHash,
		expected_bound_diff_hash: strict.value.review.bound_diff_hash,
		projection: migrationProjection,
	});
	return { state: strict.value.state, review: strict.value.review, reviewHash, projection: migrationProjection };
}

async function cleanup(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}

function migrationPresentationInput(
	fixture: Awaited<ReturnType<typeof finalizedHistoricalMechanicalReview>>,
	second = 5,
) {
	return {
		delegation_id: ID,
		contract_hash: HASH,
		worker_identity: { ...fixture.state.worker_identity },
		expected_generation: fixture.state.generation,
		expected_revision: 4 as const,
		base_review_hash: fixture.reviewHash,
		expected_bound_diff_hash: fixture.review.bound_diff_hash,
		projection: structuredClone(fixture.projection),
		presenter: { provider: "openai" as const, model: "gpt-5.6-sol" as const },
		now: at(second),
	};
}

function migrationAcceptanceInput(
	fixture: Awaited<ReturnType<typeof finalizedHistoricalMechanicalReview>>,
	second = 6,
) {
	return {
		delegation_id: ID,
		contract_hash: HASH,
		worker_identity: { ...fixture.state.worker_identity },
		expected_generation: fixture.state.generation,
		expected_revision: 4 as const,
		base_review_hash: fixture.reviewHash,
		expected_bound_diff_hash: fixture.review.bound_diff_hash,
		expected_migration_binding_hash: fixture.projection.migration_binding_hash,
		projection: structuredClone(fixture.projection),
		reviewer: { provider: "openai-codex" as const, model: "gpt-5.6-sol" as const },
		now: at(second),
	};
}

function reboundMigrationProjection(
	fixture: Awaited<ReturnType<typeof finalizedHistoricalMechanicalReview>>,
	updates: Partial<DelegationSemanticMigrationCandidateProjectionV1>,
): DelegationSemanticMigrationCandidateProjectionV1 {
	const projection: DelegationSemanticMigrationCandidateProjectionV1 = {
		...structuredClone(fixture.projection),
		...structuredClone(updates),
		migration_binding_hash: "0".repeat(64),
	};
	projection.migration_binding_hash = computeHistoricalSemanticMigrationBindingHashV2({
		delegation_id: ID,
		contract_hash: HASH,
		base_review_hash: fixture.reviewHash,
		expected_bound_diff_hash: fixture.review.bound_diff_hash,
		projection,
	});
	return projection;
}

test("storage v2 semantic repair: immutable packet-bound decision is strict, idempotent, and leaves transaction pending", async () => {
	const root = await tempProject();
	try {
		const fixture = await completeProvisionalSemanticReview(root);
		const transactionBytes = await readFile(transactionPath(root));
		const reviewBytes = await readFile(reviewPath(root));
		const absent = await readDelegationSemanticRepairDecisionV1(root, ID);
		assert.equal(absent.ok, true);
		if (absent.ok) assert.equal(absent.value, undefined);
		const oldAuthority = await readDelegationReviewV2(root, ID);
		assert.equal(oldAuthority.ok, true);
		if (oldAuthority.ok) assert.equal(oldAuthority.value.semantic_repair, undefined);

		const input = repairDecisionInput(fixture);
		const published = await publishDelegationSemanticRepairDecisionV1(root, input);
		assert.equal(published.ok, true, published.ok ? "" : published.error.code);
		if (!published.ok) return;
		assert.equal(published.value.decision, "REPAIR");
		assert.equal(published.value.transaction_revision, 3);
		assert.equal(published.value.generation_content_hash, fixture.state.committed_proof?.content_hash);
		assert.equal(published.value.base_review_hash, fixture.reviewHash);
		assert.equal(published.value.expected_bound_diff_hash, fixture.artifact.review.bound_diff_hash);
		assert.equal(
			published.value.repair_reason_hash,
			createHash("sha256").update(input.repair_reason, "utf8").digest("hex"),
		);
		const { decision_hash: decisionHash, ...decisionPayload } = published.value;
		assert.equal(decisionHash, canonicalHash(decisionPayload));

		const decisionBytes = await readFile(semanticRepairPath(root));
		const replay = await publishDelegationSemanticRepairDecisionV1(root, { ...input, now: at(6) });
		assert.equal(replay.ok, true, replay.ok ? "" : replay.error.code);
		if (replay.ok) assert.equal(replay.value.decided_at, input.now, "logical replay preserves immutable first decision time");
		assert.deepEqual(await readFile(semanticRepairPath(root)), decisionBytes);
		const replacement = await publishDelegationSemanticRepairDecisionV1(root, {
			...input,
			repair_reason: "A different semantic rejection reason.",
		});
		assert.equal(replacement.ok, false);
		if (!replacement.ok) assert.equal(replacement.error.code, "conflict");
		assert.deepEqual(await readFile(semanticRepairPath(root)), decisionBytes);

		const strict = await readDelegationReviewV2(root, ID);
		assert.equal(strict.ok, true, strict.ok ? "" : strict.error.code);
		if (strict.ok) {
			assert.equal(strict.value.finalized, false);
			assert.equal(strict.value.state.status, "PENDING_REVIEW");
			assert.equal(strict.value.semantic_repair?.decision_hash, decisionHash);
			assert.equal(hasDelegationSemanticRepairAuthorityV2(strict.value), true);
			assert.equal(hasDelegationSemanticReviewAuthorityV2(strict.value), false);
		}
		assert.deepEqual(await readFile(transactionPath(root)), transactionBytes);
		assert.deepEqual(await readFile(reviewPath(root)), reviewBytes);
	} finally {
		await cleanup(root);
	}
});

test("storage v2 semantic repair: invalid decisions fail closed and a decision freezes provisional review plus ACCEPT", async () => {
	const root = await tempProject();
	try {
		const fixture = await completeProvisionalSemanticReview(root);
		const input = repairDecisionInput(fixture);
		const blankReason = await publishDelegationSemanticRepairDecisionV1(root, { ...input, repair_reason: " " });
		assert.equal(blankReason.ok, false);
		if (!blankReason.ok) assert.equal(blankReason.error.code, "invalid_input");
		const multiByteOverflow = await publishDelegationSemanticRepairDecisionV1(root, {
			...input,
			repair_reason: "修".repeat(342),
		});
		assert.equal(multiByteOverflow.ok, false);
		if (!multiByteOverflow.ok) assert.equal(multiByteOverflow.error.code, "invalid_input");
		const stalePacket = await publishDelegationSemanticRepairDecisionV1(root, {
			...input,
			expected_bound_diff_hash: "9".repeat(64),
		});
		assert.equal(stalePacket.ok, false);
		if (!stalePacket.ok) assert.equal(stalePacket.error.code, "conflict");
		const nonSol = await publishDelegationSemanticRepairDecisionV1(root, {
			...input,
			reviewer: { provider: "openai", model: "gpt-5.6-luna" } as never,
		});
		assert.equal(nonSol.ok, false);
		if (!nonSol.ok) assert.equal(nonSol.error.code, "invalid_input");

		const published = await publishDelegationSemanticRepairDecisionV1(root, input);
		assert.equal(published.ok, true, published.ok ? "" : published.error.code);
		const decisionBytes = await readFile(semanticRepairPath(root));

		const replacementArtifact = structuredClone(fixture.artifact);
		replacementArtifact.reviewed_at = at(6);
		replacementArtifact.review.reviewed_at = at(6);
		const provisionalRewrite = await persistDelegationReviewProvisionalV2(root, {
			...cas(fixture.state, 6),
			artifact: replacementArtifact,
		});
		assert.equal(provisionalRewrite.ok, false);
		if (!provisionalRewrite.ok) assert.equal(provisionalRewrite.error.code, "conflict");

		const accept = await publishDelegationReviewV2(root, {
			...cas(fixture.state, 6),
			artifact: acceptedReviewArtifact(fixture),
		});
		assert.equal(accept.ok, false);
		if (!accept.ok) assert.equal(accept.error.code, "conflict");
		assert.deepEqual(await readFile(semanticRepairPath(root)), decisionBytes);
		const durable = await readDelegationTransactionV2(root, ID);
		assert.equal(durable.ok, true);
		if (durable.ok) assert.equal(durable.value.status, "PENDING_REVIEW");
	} finally {
		await cleanup(root);
	}
});

test("storage v2 semantic repair: tamper and non-canonical sidecars invalidate the whole strict authority", async () => {
	const root = await tempProject();
	try {
		const fixture = await completeProvisionalSemanticReview(root);
		const published = await publishDelegationSemanticRepairDecisionV1(root, repairDecisionInput(fixture));
		assert.equal(published.ok, true, published.ok ? "" : published.error.code);
		if (!published.ok) return;
		const canonicalBytes = await readFile(semanticRepairPath(root));
		const raw = JSON.parse(canonicalBytes.toString("utf8")) as Record<string, unknown>;
		raw.repair_reason = "tampered after publication";
		await writeFile(semanticRepairPath(root), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
		const reasonTamper = await readDelegationSemanticRepairDecisionV1(root, ID);
		assert.equal(reasonTamper.ok, false);
		if (!reasonTamper.ok) assert.equal(reasonTamper.error.code, "invalid_record");
		const authorityTamper = await readDelegationReviewV2(root, ID);
		assert.equal(authorityTamper.ok, false);
		if (!authorityTamper.ok) assert.equal(authorityTamper.error.code, "invalid_record");

		await writeFile(semanticRepairPath(root), canonicalBytes);
		const decisionHashTamper = JSON.parse(canonicalBytes.toString("utf8")) as Record<string, unknown>;
		decisionHashTamper.decision_hash = "f".repeat(64);
		await writeFile(semanticRepairPath(root), `${JSON.stringify(decisionHashTamper, null, 2)}\n`, "utf8");
		const hashTamper = await readDelegationSemanticRepairDecisionV1(root, ID);
		assert.equal(hashTamper.ok, false);
		if (!hashTamper.ok) assert.equal(hashTamper.error.code, "invalid_record");

		const canonicalRaw = JSON.parse(canonicalBytes.toString("utf8")) as DelegationSemanticRepairDecisionV1;
		await writeFile(semanticRepairPath(root), JSON.stringify(canonicalRaw), "utf8");
		const nonCanonical = await readDelegationSemanticRepairDecisionV1(root, ID);
		assert.equal(nonCanonical.ok, false);
		if (!nonCanonical.ok) assert.equal(nonCanonical.error.code, "invalid_record");

		await writeFile(semanticRepairPath(root), canonicalBytes);
		await unlink(reviewPath(root));
		const unbound = await readDelegationSemanticRepairDecisionV1(root, ID);
		assert.equal(unbound.ok, false);
		if (!unbound.ok) assert.equal(unbound.error.code, "invalid_record");
	} finally {
		await cleanup(root);
	}
});

test("storage v2 semantic migration: strict PRESENTED -> ACCEPTED supplement preserves historical authority bytes", async () => {
	const root = await tempProject();
	try {
		const fixture = await finalizedHistoricalMechanicalReview(root);
		const transactionBytes = await readFile(transactionPath(root));
		const reviewBytes = await readFile(reviewPath(root));
		const absent = await readDelegationSemanticMigrationV1(root, ID);
		assert.equal(absent.ok, true);
		if (absent.ok) assert.equal(absent.value, undefined);

		const presentationInput = migrationPresentationInput(fixture);
		const presented = await publishHistoricalSemanticMigrationPresentationV2(root, presentationInput);
		assert.equal(presented.ok, true, presented.ok ? "" : presented.error.code);
		if (!presented.ok) return;
		assert.equal(presented.value.status, "PRESENTED");
		const presentedBytes = await readFile(semanticMigrationPath(root));
		const replayedPresentation = await publishHistoricalSemanticMigrationPresentationV2(root, presentationInput);
		assert.equal(replayedPresentation.ok, true, replayedPresentation.ok ? "" : replayedPresentation.error.code);
		assert.deepEqual(await readFile(semanticMigrationPath(root)), presentedBytes);

		const replacementPresentation = await publishHistoricalSemanticMigrationPresentationV2(root, {
			...presentationInput,
			projection: reboundMigrationProjection(fixture, { candidate_git_head: "6".repeat(40) }),
		});
		assert.equal(replacementPresentation.ok, true, replacementPresentation.ok ? "" : replacementPresentation.error.code);
		assert.notDeepEqual(await readFile(semanticMigrationPath(root)), presentedBytes);
		const restoredPresentation = await publishHistoricalSemanticMigrationPresentationV2(root, presentationInput);
		assert.equal(restoredPresentation.ok, true, restoredPresentation.ok ? "" : restoredPresentation.error.code);
		assert.deepEqual(await readFile(semanticMigrationPath(root)), presentedBytes);

		const acceptanceInput = migrationAcceptanceInput(fixture);
		const accepted = await publishHistoricalSemanticMigrationAcceptanceV2(root, acceptanceInput);
		assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error.code);
		if (!accepted.ok) return;
		assert.equal(accepted.value.status, "ACCEPTED");
		if (accepted.value.status === "ACCEPTED") {
			assert.equal(accepted.value.acceptance.expected_bound_diff_hash, fixture.review.bound_diff_hash);
			assert.equal(accepted.value.acceptance.expected_migration_binding_hash, fixture.projection.migration_binding_hash);
		}
		const acceptedBytes = await readFile(semanticMigrationPath(root));
		const replayedAcceptance = await publishHistoricalSemanticMigrationAcceptanceV2(root, acceptanceInput);
		assert.equal(replayedAcceptance.ok, true, replayedAcceptance.ok ? "" : replayedAcceptance.error.code);
		assert.deepEqual(await readFile(semanticMigrationPath(root)), acceptedBytes);

		const overwrite = await publishHistoricalSemanticMigrationAcceptanceV2(root, { ...acceptanceInput, now: at(7) });
		assert.equal(overwrite.ok, false);
		if (!overwrite.ok) assert.equal(overwrite.error.code, "conflict");
		const latePresentation = await publishHistoricalSemanticMigrationPresentationV2(root, presentationInput);
		assert.equal(latePresentation.ok, false);
		assert.deepEqual(await readFile(semanticMigrationPath(root)), acceptedBytes);

		const strict = await readDelegationReviewV2(root, ID);
		assert.equal(strict.ok, true, strict.ok ? "" : strict.error.code);
		if (strict.ok) {
			assert.equal(strict.value.semantic_migration?.status, "ACCEPTED");
			assert.equal(hasDelegationSemanticReviewAuthorityV2(strict.value), true);
		}
		assert.deepEqual(await readFile(transactionPath(root)), transactionBytes);
		assert.deepEqual(await readFile(reviewPath(root)), reviewBytes);
	} finally {
		await cleanup(root);
	}
});

test("storage v2 semantic migration: malformed, unbound, and projection-swapping records fail closed", async () => {
	const root = await tempProject();
	try {
		const fixture = await finalizedHistoricalMechanicalReview(root);
		const outside = await publishHistoricalSemanticMigrationPresentationV2(root, {
			...migrationPresentationInput(fixture),
			projection: { ...fixture.projection, head_delta_paths: ["outside.ts"] },
		});
		assert.equal(outside.ok, false);
		if (!outside.ok) assert.equal(outside.error.code, "invalid_input");
		const subset = await publishHistoricalSemanticMigrationPresentationV2(root, {
			...migrationPresentationInput(fixture),
			projection: reboundMigrationProjection(fixture, { head_delta_paths: [] }),
		});
		assert.equal(subset.ok, false);
		if (!subset.ok) assert.equal(subset.error.code, "invalid_input");
		const staleBinding = await publishHistoricalSemanticMigrationPresentationV2(root, {
			...migrationPresentationInput(fixture),
			projection: { ...fixture.projection, closed_content_hash: "9".repeat(64) },
		});
		assert.equal(staleBinding.ok, false);
		if (!staleBinding.ok) assert.equal(staleBinding.error.code, "invalid_input");
		const wrongWorker = await publishHistoricalSemanticMigrationPresentationV2(root, {
			...migrationPresentationInput(fixture),
			worker_identity: { ...fixture.state.worker_identity, worker_id: "foreign-worker" },
		});
		assert.equal(wrongWorker.ok, false);
		if (!wrongWorker.ok) assert.equal(wrongWorker.error.code, "conflict");
		const staleRevision = await publishHistoricalSemanticMigrationPresentationV2(root, {
			...migrationPresentationInput(fixture), expected_revision: 3,
		});
		assert.equal(staleRevision.ok, false);
		if (!staleRevision.ok) assert.equal(staleRevision.error.code, "conflict");

		const presented = await publishHistoricalSemanticMigrationPresentationV2(root, migrationPresentationInput(fixture));
		assert.equal(presented.ok, true);
		const presentedBytes = await readFile(semanticMigrationPath(root));
		const swapped = await publishHistoricalSemanticMigrationAcceptanceV2(root, {
			...migrationAcceptanceInput(fixture),
			expected_migration_binding_hash: "6".repeat(64),
		});
		assert.equal(swapped.ok, false);
		if (!swapped.ok) assert.equal(swapped.error.code, "conflict");
		assert.deepEqual(await readFile(semanticMigrationPath(root)), presentedBytes);

		const raw = JSON.parse(presentedBytes.toString("utf8")) as Record<string, any>;
		raw.migration_projection.closed_content_hash = "8".repeat(64);
		await writeFile(semanticMigrationPath(root), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
		const projectionTamper = await readDelegationSemanticMigrationV1(root, ID);
		assert.equal(projectionTamper.ok, false);
		if (!projectionTamper.ok) assert.equal(projectionTamper.error.code, "invalid_record");

		await writeFile(semanticMigrationPath(root), presentedBytes);
		const boundTamper = JSON.parse(presentedBytes.toString("utf8")) as Record<string, any>;
		boundTamper.expected_bound_diff_hash = "7".repeat(64);
		await writeFile(semanticMigrationPath(root), `${JSON.stringify(boundTamper, null, 2)}\n`, "utf8");
		const unbound = await readDelegationSemanticMigrationV1(root, ID);
		assert.equal(unbound.ok, false);
		if (!unbound.ok) assert.equal(unbound.error.code, "invalid_record");

		const canonicalRaw = JSON.parse(presentedBytes.toString("utf8")) as Record<string, any>;
		await writeFile(semanticMigrationPath(root), JSON.stringify(canonicalRaw), "utf8");
		const nonCanonical = await readDelegationSemanticMigrationV1(root, ID);
		assert.equal(nonCanonical.ok, false);
		if (!nonCanonical.ok) assert.equal(nonCanonical.error.code, "invalid_record");
	} finally {
		await cleanup(root);
	}
});

test("storage v2: implementation commits exact immutable generation and arbitrary review hashes fail closed", async () => {
	const root = await tempProject();
	try {
		const committing = await committingState(root);
		const records = recordsFor(committing);
		const inputSnapshot = structuredClone(records);
		const committed = await commitDelegationGeneration(root, commitInput(committing, records));
		assert.equal(committed.ok, true);
		if (!committed.ok) return;
		assert.equal(committed.value.status, "PENDING_REVIEW");
		assert.deepEqual(records, inputSnapshot, "storage must not mutate caller records");
		assert.ok(committed.value.committed_proof);

		const inventory = await readdir(generationDir(root));
		assert.deepEqual(inventory.sort(), [...DELEGATION_COMMITTED_RECORD_NAMES, "commit-marker.json"].sort());
		const verified = await verifyDelegationGenerationV2(root, ID, committed.value.committed_proof!);
		assert.equal(verified.ok, true);

		const reviewed = await persistReviewedDelegationTransaction(root, {
			...cas(committed.value, 4),
			review_hash: REVIEW_HASH,
		});
		assert.equal(reviewed.ok, false, "a caller-provided hash is never review authority");
		const reread = await readDelegationTransactionV2(root, ID);
		assert.equal(reread.ok, true);
		if (reread.ok) assert.equal(reread.value.status, "PENDING_REVIEW");
	} finally {
		await cleanup(root);
	}
});

test("storage v2: diagnosis with zero writes publishes FINISHED", async () => {
	const root = await tempProject();
	try {
		const committing = await committingState(root, "diagnosis");
		const committed = await commitDelegationGeneration(root, commitInput(committing));
		assert.equal(committed.ok, true);
		if (committed.ok) assert.equal(committed.value.status, "FINISHED");
	} finally {
		await cleanup(root);
	}
});

test("storage v2 committed reader returns the exact verified implementation and diagnosis generations", async () => {
	for (const kind of ["implementation", "diagnosis"] as const) {
		const root = await tempProject();
		try {
			const committing = await committingState(root, kind);
			const sourceRecords = recordsFor(committing);
			const committed = await commitDelegationGeneration(root, commitInput(committing, sourceRecords));
			assert.equal(committed.ok, true);
			const read = await readDelegationCommittedGenerationV2(root, ID);
			assert.equal(read.ok, true);
			if (!read.ok) continue;
			assert.equal(read.value.state.status, kind === "implementation" ? "PENDING_REVIEW" : "FINISHED");
			assert.deepEqual(read.value.records, sourceRecords);
			assert.deepEqual(read.value.proof, committed.ok && committed.value.committed_proof);
			assert.deepEqual(read.value.inventory.proof, read.value.proof);
			assert.deepEqual(read.value.inventory.record_names.sort(), [...DELEGATION_COMMITTED_RECORD_NAMES, "commit-marker.json"].sort());
		} finally {
			await cleanup(root);
		}
	}
});

test("storage v2 committed reader rejects PREPARED, RUNNING, COMMITTING, and proofless terminal-shaped records", async () => {
	for (const stage of ["PREPARED", "RUNNING", "COMMITTING"] as const) {
		const root = await tempProject();
		try {
			const prepared = await persistPreparedDelegationTransaction(root, {
				delegation_id: ID, task_kind: "implementation", contract_hash: HASH, allowed_paths: ["src/**"],
				worker_identity: { ...IDENTITY }, generation: 1, now: at(0),
			});
			assert.equal(prepared.ok, true);
			if (!prepared.ok) continue;
			let state = prepared.value;
			if (stage !== "PREPARED") {
				const running = await persistRunningDelegationTransaction(root, cas(state, 1));
				assert.equal(running.ok, true);
				if (!running.ok) continue;
				state = running.value;
			}
			if (stage === "COMMITTING") {
				const committing = await persistCommittingDelegationTransaction(root, { ...cas(state, 2), outcome: outcome("implementation") });
				assert.equal(committing.ok, true);
			}
			assert.equal((await readDelegationCommittedGenerationV2(root, ID)).ok, false);
		} finally {
			await cleanup(root);
		}
	}

	const root = await tempProject();
	try {
		const state = await committingState(root);
		const committed = await commitDelegationGeneration(root, commitInput(state));
		assert.equal(committed.ok, true);
		if (!committed.ok) return;
		await writeFile(transactionPath(root), `${JSON.stringify({ ...committed.value, committed_proof: null })}\n`);
		assert.equal((await readDelegationCommittedGenerationV2(root, ID)).ok, false);
	} finally {
		await cleanup(root);
	}
});

test("storage v2 committed reader never falls back to legacy v1 records", async () => {
	const root = await tempProject();
	try {
		const legacy = join(root, CONFIG_DIR_NAME, "workbench", "delegations", ID);
		await mkdir(legacy, { recursive: true });
		await writeFile(join(legacy, "manifest.json"), `${JSON.stringify({ schema_version: 1, delegation_id: ID, status: "finished" })}\n`);
		await writeFile(join(legacy, "worker-report.md"), "legacy report");
		const read = await readDelegationCommittedGenerationV2(root, ID);
		assert.equal(read.ok, false);
		if (!read.ok) assert.equal(read.error.code, "not_found");
	} finally {
		await cleanup(root);
	}
});

test("storage v2: abort and recovery wrappers use the same durable locked transition", async () => {
	const root = await tempProject();
	const root2 = await tempProject();
	try {
		const prepared = await persistPreparedDelegationTransaction(root, {
			delegation_id: ID, task_kind: "diagnosis", contract_hash: HASH, allowed_paths: ["src/**"],
			worker_identity: { ...IDENTITY }, generation: 1, now: at(0),
		});
		assert.equal(prepared.ok, true);
		if (!prepared.ok) return;
		const aborted = await persistAbortedDelegationTransaction(root, { ...cas(prepared.value, 1), reason: "child was not launched" });
		assert.equal(aborted.ok, true);
		if (aborted.ok) assert.equal(aborted.value.status, "ABORTED");

		const running = await committingState(root2, "diagnosis", ID_2);
		const recovery = await persistRecoveryRequiredDelegationTransaction(root2, {
			...cas(running, 3), reason: "generation recovery rehearsal",
		});
		assert.equal(recovery.ok, true);
		if (recovery.ok) assert.equal(recovery.value.status, "RECOVERY_REQUIRED");
	} finally {
		await Promise.all([cleanup(root), cleanup(root2)]);
	}
});

test("storage v2: exact record inventory, identity/scope bindings, complete report, and caller inputs fail closed", async () => {
	const variants: Array<(records: DelegationCommittedRecords) => unknown> = [
		(records) => { delete (records as unknown as Record<string, unknown>)["usage.json"]; },
		(records) => { (records as unknown as Record<string, unknown>)["extra.json"] = {}; },
		(records) => { (records["identity.json"] as Record<string, unknown>).contract_hash = "d".repeat(64); },
		(records) => { ((records["identity.json"] as Record<string, unknown>).worker_identity as Record<string, unknown>).extra = true; },
		(records) => { (records["scope.json"] as Record<string, unknown>).changed_paths = ["outside.ts"]; },
		(records) => { delete (records["scope.json"] as Record<string, unknown>).write_journal; },
		(records) => { ((records["scope.json"] as Record<string, any>).write_journal as Record<string, unknown>).journal_hash = "f".repeat(64); },
		(records) => { ((records["scope.json"] as Record<string, any>).change_set as Record<string, unknown>).change_set_hash = "f".repeat(64); },
		(records) => { ((records["before.json"] as Record<string, any>).workspace_guard as Record<string, unknown>).workspace_guard_hash = "f".repeat(64); },
		(records) => { ((records["after.json"] as Record<string, any>).workspace_guard as Record<string, unknown>).workspace_guard_hash = "f".repeat(64); },
		(records) => { (records["after.json"] as Record<string, unknown>).worker_delta_hash = "f".repeat(64); },
		(records) => { (records["after.json"] as Record<string, unknown>).workspace_guard_hash = "f".repeat(64); },
		(records) => { (records["after.json"] as Record<string, unknown>).change_set_hash = "f".repeat(64); },
		(records) => { (records["before.json"] as Record<string, unknown>).diff_hash = "f".repeat(64); },
		(records) => { (records["after.json"] as Record<string, unknown>).diff_hash = "f".repeat(64); },
		(records) => { delete ((records["before.json"] as Record<string, any>).path_digests as Record<string, string>)["src/changed.ts"]; },
		(records) => { ((records["before.json"] as Record<string, any>).path_digests as Record<string, string>)["src/extra.ts"] = "e".repeat(64); },
		(records) => { ((records["before.json"] as Record<string, any>).path_digests as Record<string, string>)["src/changed.ts"] = "f".repeat(64); },
		(records) => { ((records["after.json"] as Record<string, any>).path_statuses as Record<string, string>)["src/changed.ts"] = " M"; },
		(records) => { delete ((records["after.json"] as Record<string, any>).path_digests as Record<string, string>)["src/changed.ts"]; },
		(records) => { ((records["after.json"] as Record<string, any>).path_digests as Record<string, string>)["src/extra.ts"] = "e".repeat(64); },
		(records) => { ((records["after.json"] as Record<string, any>).path_digests as Record<string, string>)["src/changed.ts"] = "f".repeat(64); },
		(records) => { records["worker-report.md"] = "   \n"; },
		(records) => { records["worker-report.md"] = "invalid-surrogate-\ud800"; },
	];
	for (const mutate of variants) {
		const root = await tempProject();
		try {
			const state = await committingState(root);
			const records = recordsFor(state);
			mutate(records);
			const snapshot = structuredClone(records);
			const result = await commitDelegationGeneration(root, commitInput(state, records));
			assert.equal(result.ok, false);
			assert.deepEqual(records, snapshot);
			const durable = await readDelegationTransactionV2(root, ID);
			assert.equal(durable.ok, true);
			if (durable.ok) assert.equal(durable.value.status, "COMMITTING");
		} finally {
			await cleanup(root);
		}
	}
});

test("storage v2: full bytes, including same-size tail changes, affect the committed content hash", () => {
	const prefix = Buffer.alloc(DELEGATION_TRANSACTION_REPORT_MAX_BYTES - 1, 0x61);
	const left = new Map();
	const right = new Map();
	for (const name of DELEGATION_COMMITTED_RECORD_NAMES) {
		const base = name === "worker-report.md" ? Buffer.concat([prefix, Buffer.from("x")]) : Buffer.from(name);
		left.set(name, base);
		right.set(name, name === "worker-report.md" ? Buffer.concat([prefix, Buffer.from("y")]) : Buffer.from(name));
	}
	assert.notEqual(hashDelegationCommittedRecords(left), hashDelegationCommittedRecords(right));
});

test("storage v2: dedicated scope cap rejects oversized commit input and strict reads", async () => {
	const commitRoot = await tempProject();
	const readRoot = await tempProject();
	try {
		const committing = await committingState(commitRoot);
		const oversized = recordsFor(committing);
		(oversized["scope.json"] as Record<string, unknown>).padding = "x".repeat(DELEGATION_TRANSACTION_SCOPE_RECORD_MAX_BYTES);
		assert.equal((await commitDelegationGeneration(commitRoot, commitInput(committing, oversized))).ok, false);

		const readState = await committingState(readRoot);
		const committed = await commitDelegationGeneration(readRoot, commitInput(readState));
		assert.equal(committed.ok, true);
		if (!committed.ok) return;
		await writeFile(join(generationDir(readRoot), "scope.json"), Buffer.alloc(DELEGATION_TRANSACTION_SCOPE_RECORD_MAX_BYTES + 1, 0x20));
		assert.equal((await readDelegationCommittedGenerationV2(readRoot, ID)).ok, false);
	} finally {
		await Promise.all([cleanup(commitRoot), cleanup(readRoot)]);
	}
});

test("storage v2: duplicate and concurrent finish allow exactly one committed publisher", async () => {
	const root = await tempProject();
	try {
		const state = await committingState(root);
		const [one, two] = await Promise.all([
			commitDelegationGeneration(root, commitInput(state, recordsFor(state))),
			commitDelegationGeneration(root, commitInput(state, recordsFor(state))),
		]);
		assert.equal([one, two].filter((result) => result.ok).length, 1);
		const repeated = await commitDelegationGeneration(root, commitInput(state, recordsFor(state), 4));
		assert.equal(repeated.ok, false);
		const generations = await readdir(join(transactionDir(root), "generations"));
		assert.equal(generations.filter((name) => name === "g00000001").length, 1);
	} finally {
		await cleanup(root);
	}
});

test("storage v2: stale CAS, wrong delegation id, and wrong worker fail without changing durable state", async () => {
	const root = await tempProject();
	try {
		const state = await committingState(root);
		const stale = await commitDelegationGeneration(root, { ...commitInput(state), expected_revision: 1 });
		assert.equal(stale.ok, false);
		const wrongId = await commitDelegationGeneration(root, { ...commitInput(state), delegation_id: ID_2 });
		assert.equal(wrongId.ok, false);
		const wrongWorker = await commitDelegationGeneration(root, {
			...commitInput(state), worker_identity: { ...IDENTITY, worker_id: "other-worker" },
		});
		assert.equal(wrongWorker.ok, false);
		const durable = await readDelegationTransactionV2(root, ID);
		assert.equal(durable.ok, true);
		if (durable.ok) assert.equal(durable.value.status, "COMMITTING");
	} finally {
		await cleanup(root);
	}
});

test("storage v2: an existing final generation is never overwritten", async () => {
	const root = await tempProject();
	try {
		const state = await committingState(root);
		await mkdir(generationDir(root), { recursive: true });
		await writeFile(join(generationDir(root), "foreign.txt"), "preserve me");
		const result = await commitDelegationGeneration(root, commitInput(state));
		assert.equal(result.ok, false);
		assert.equal(await readFile(join(generationDir(root), "foreign.txt"), "utf8"), "preserve me");
		const durable = await readDelegationTransactionV2(root, ID);
		assert.equal(durable.ok, true);
		if (durable.ok) assert.equal(durable.value.status, "COMMITTING");
	} finally {
		await cleanup(root);
	}
});

function faultAdapter(target: DelegationTransactionStorageFaultPoint): { adapter: DelegationTransactionStorageAdapter; tripped: () => boolean } {
	let didTrip = false;
	const adapter = createNodeDelegationTransactionStorageAdapter(async (point, bytes) => {
		if (point !== target || didTrip) return bytes === undefined ? undefined : Uint8Array.from(bytes);
		didTrip = true;
		if (point.endsWith(".read") && bytes !== undefined) return Buffer.from("{", "utf8");
		throw new Error(`injected ${point}`);
	});
	return { adapter, tripped: () => didTrip };
}

test("storage v2 semantic repair: every dedicated atomic-publication fault point fails closed", async () => {
	for (const point of DELEGATION_SEMANTIC_REPAIR_STORAGE_FAULT_POINTS) {
		const root = await tempProject();
		try {
			const fixture = await completeProvisionalSemanticReview(root);
			const transactionBytes = await readFile(transactionPath(root));
			const reviewBytes = await readFile(reviewPath(root));
			const injected = faultAdapter(point);
			const result = await publishDelegationSemanticRepairDecisionV1(
				root,
				repairDecisionInput(fixture),
				{ adapter: injected.adapter },
			);
			assert.equal(injected.tripped(), true, `${point} must be reached`);
			assert.equal(result.ok, false, `${point} must not report unverified success`);
			const durable = await readDelegationSemanticRepairDecisionV1(root, ID);
			assert.equal(durable.ok, true, durable.ok ? "" : durable.error.code);
			if (durable.ok) {
				if (point === "repair_decision.final.read") assert.equal(durable.value?.decision, "REPAIR");
				else assert.equal(durable.value, undefined);
			}
			assert.deepEqual(await readFile(transactionPath(root)), transactionBytes);
			assert.deepEqual(await readFile(reviewPath(root)), reviewBytes);
		} finally {
			await cleanup(root);
		}
	}
});

test("storage v2 semantic migration: every dedicated atomic-publication fault point fails closed", async () => {
	for (const point of DELEGATION_SEMANTIC_MIGRATION_STORAGE_FAULT_POINTS) {
		const root = await tempProject();
		try {
			const fixture = await finalizedHistoricalMechanicalReview(root);
			const injected = faultAdapter(point);
			const result = await publishHistoricalSemanticMigrationPresentationV2(
				root,
				migrationPresentationInput(fixture),
				{ adapter: injected.adapter },
			);
			assert.equal(injected.tripped(), true, `${point} must be reached`);
			assert.equal(result.ok, false, `${point} must not report unverified success`);
			const durable = await readDelegationSemanticMigrationV1(root, ID);
			if (point === "semantic_migration.final.read") {
				assert.equal(durable.ok, true, durable.ok ? "" : durable.error.code);
				if (durable.ok) assert.equal(durable.value?.status, "PRESENTED");
			} else {
				assert.equal(durable.ok, true, durable.ok ? "" : durable.error.code);
				if (durable.ok) assert.equal(durable.value, undefined);
			}
		} finally {
			await cleanup(root);
		}
	}
});

async function installInvalidStaleLock(root: string): Promise<void> {
	await mkdir(transactionDir(root), { recursive: true });
	await writeFile(lockPath(root), "{invalid", { mode: 0o600 });
}

test("storage v2: every declared fault point is exercised; no pre-commit fault publishes a completed transaction", async () => {
	assert.ok(DELEGATION_TRANSACTION_STORAGE_FAULT_POINTS.length >= 35);
	for (const point of DELEGATION_TRANSACTION_STORAGE_FAULT_POINTS) {
		const root = await tempProject();
		try {
			let state: DelegationTransactionRecord | undefined;
			if (point === "lock.recover.rename") await installInvalidStaleLock(root);
			else if (point === "state.read" || point.startsWith("generation.") || point.startsWith("publish_state.")) {
				if (point === "state.read") {
					const prepared = await persistPreparedDelegationTransaction(root, {
						delegation_id: ID, task_kind: "implementation", contract_hash: HASH, allowed_paths: ["src/**"],
						worker_identity: { ...IDENTITY }, generation: 1, now: at(0),
					});
					assert.equal(prepared.ok, true);
					state = prepared.value;
				} else {
					state = await committingState(root);
				}
			}
			const injected = faultAdapter(point);
			let result;
			if (point === "state.read") {
				assert.ok(state);
				result = await persistRunningDelegationTransaction(root, cas(state!, 1), { adapter: injected.adapter });
			} else if (point.startsWith("generation.") || point.startsWith("publish_state.")) {
				result = await commitDelegationGeneration(root, commitInput(state!), { adapter: injected.adapter });
			} else {
				result = await persistPreparedDelegationTransaction(root, {
					delegation_id: ID, task_kind: "implementation", contract_hash: HASH, allowed_paths: ["src/**"],
					worker_identity: { ...IDENTITY }, generation: 1, now: at(0),
				}, { adapter: injected.adapter });
			}
			assert.equal(injected.tripped(), true, `fault point ${point} must be reached`);
			const releasePoint = point.startsWith("lock.release.");
			assert.equal(result.ok, releasePoint, `${point} result semantics`);
			const durable = await readDelegationTransactionV2(root, ID);
			if (durable.ok) {
				assert.ok(!["FINISHED", "PENDING_REVIEW", "REVIEWED", "FAILED"].includes(durable.value.status), `${point} published ${durable.value.status}`);
			}
		} finally {
			await cleanup(root);
		}
	}
});

test("storage v2: foreign token during release is never deleted and cannot downgrade the already-published result", async () => {
	const root = await tempProject();
	try {
		const base = createNodeDelegationTransactionStorageAdapter();
		const adapter: DelegationTransactionStorageAdapter = {
			...base,
			async fault(point, bytes) {
				if (point !== "lock.release.owner.read" || bytes === undefined) return bytes === undefined ? undefined : Uint8Array.from(bytes);
				const owner = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
				owner.token = "f".repeat(32);
				return Buffer.from(`${JSON.stringify(owner)}\n`);
			},
		};
		const prepared = await persistPreparedDelegationTransaction(root, {
			delegation_id: ID, task_kind: "implementation", contract_hash: HASH, allowed_paths: ["src/**"],
			worker_identity: { ...IDENTITY }, generation: 1, now: at(0),
		}, { adapter });
		assert.equal(prepared.ok, true, "published state remains the result even if cleanup detects a foreign token");
		const reread = await readDelegationTransactionV2(root, ID);
		assert.equal(reread.ok, true);
		if (reread.ok) {
			const running = await persistRunningDelegationTransaction(root, cas(reread.value, 1));
			assert.equal(running.ok, true, "best-effort non-fault cleanup must permit the next locked transition");
		}
	} finally {
		await cleanup(root);
	}
});

test("storage v2: exclusive lock write failure after file creation cleans only its own token; active owner is never broken", async () => {
	const root = await tempProject();
	const activeRoot = await tempProject();
	try {
		const base = createNodeDelegationTransactionStorageAdapter();
		let injected = false;
		const partialWrite: DelegationTransactionStorageAdapter = {
			...base,
			async write(path, bytes, exclusive) {
				await base.write(path, bytes, exclusive);
				if (path.endsWith("transaction.lock") && !injected) {
					injected = true;
					throw new Error("write failed after exclusive creation");
				}
			},
		};
		const failed = await persistPreparedDelegationTransaction(root, {
			delegation_id: ID, task_kind: "diagnosis", contract_hash: HASH, allowed_paths: ["src/**"],
			worker_identity: { ...IDENTITY }, generation: 1, now: at(0),
		}, { adapter: partialWrite });
		assert.equal(failed.ok, false);
		const retry = await persistPreparedDelegationTransaction(root, {
			delegation_id: ID, task_kind: "diagnosis", contract_hash: HASH, allowed_paths: ["src/**"],
			worker_identity: { ...IDENTITY }, generation: 1, now: at(0),
		});
		assert.equal(retry.ok, true, "own partially-created lock must not become a permanent active lock");

		await mkdir(transactionDir(activeRoot), { recursive: true });
		const activeOwner = {
			schema_version: 1,
			delegation_id: ID,
			token: "e".repeat(32),
			process_id: process.pid,
			created_at: at(0),
		};
		await writeFile(lockPath(activeRoot), `${JSON.stringify(activeOwner)}\n`, { flag: "wx", mode: 0o600 });
		const conflicted = await persistPreparedDelegationTransaction(activeRoot, {
			delegation_id: ID, task_kind: "diagnosis", contract_hash: HASH, allowed_paths: ["src/**"],
			worker_identity: { ...IDENTITY }, generation: 1, now: at(0),
		});
		assert.equal(conflicted.ok, false);
		assert.equal((await readFile(lockPath(activeRoot), "utf8")).includes("e".repeat(32)), true);
	} finally {
		await Promise.all([cleanup(root), cleanup(activeRoot)]);
	}
});

test("storage v2: terminal publish release fault stays successful and best-effort cleanup permits locked follow-up", async () => {
	const root = await tempProject();
	try {
		const state = await committingState(root);
		let tripped = false;
		const adapter = createNodeDelegationTransactionStorageAdapter((point, bytes) => {
			if (point === "lock.release.owner.rename" && !tripped) {
				tripped = true;
				throw new Error("release rename fault");
			}
			return bytes === undefined ? undefined : Uint8Array.from(bytes);
		});
		const committed = await commitDelegationGeneration(root, commitInput(state), { adapter });
		assert.equal(tripped, true);
		assert.equal(committed.ok, true);
		if (!committed.ok) return;
		assert.equal(committed.value.status, "PENDING_REVIEW");
		const reviewed = await persistReviewedDelegationTransaction(root, { ...cas(committed.value, 4), review_hash: REVIEW_HASH });
		assert.equal(reviewed.ok, false, "legacy hash-only review path remains fail closed");
		const reread = await readDelegationTransactionV2(root, ID);
		assert.equal(reread.ok, true);
		if (reread.ok) assert.equal(reread.value.status, "PENDING_REVIEW");
	} finally {
		await cleanup(root);
	}
});

test("storage v2: unknown version, corrupt/truncated/oversized/symlink transaction records fail closed and never fall back to v1", async () => {
	const cases: Array<(root: string) => Promise<void>> = [
		async (root) => { await writeFile(transactionPath(root), `${JSON.stringify({ schema_version: 99 })}\n`); },
		async (root) => { await writeFile(transactionPath(root), "{"); },
		async (root) => { await writeFile(transactionPath(root), Buffer.alloc(1_048_577, 0x61)); },
		async (root) => {
			await unlink(transactionPath(root));
			await writeFile(join(root, "outside.json"), "{}\n");
			await symlink(join(root, "outside.json"), transactionPath(root));
		},
	];
	for (const install of cases) {
		const root = await tempProject();
		try {
			const prepared = await persistPreparedDelegationTransaction(root, {
				delegation_id: ID, task_kind: "diagnosis", contract_hash: HASH, allowed_paths: ["src/**"],
				worker_identity: { ...IDENTITY }, generation: 1, now: at(0),
			});
			assert.equal(prepared.ok, true);
			await writeFile(join(transactionDir(root), "..", "manifest.json"), "{\"schema_version\":1}\n");
			await install(root);
			const read = await readDelegationTransactionV2(root, ID);
			assert.equal(read.ok, false);
			assert.equal((await readDelegationCommittedGenerationV2(root, ID)).ok, false);
		} finally {
			await cleanup(root);
		}
	}
});

test("storage v2: partial staging remains diagnosable but is not a committed generation", async () => {
	const root = await tempProject();
	try {
		const state = await committingState(root);
		const staging = join(transactionDir(root), "generations", ".g00000001.attempt-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.staging");
		await mkdir(staging, { recursive: true });
		await writeFile(join(staging, "before.json"), "{}\n");
		const durable = await readDelegationTransactionV2(root, ID);
		assert.equal(durable.ok, true);
		if (durable.ok) assert.equal(durable.value.status, "COMMITTING");
		const fakeProof = {
			schema_version: DELEGATION_TRANSACTION_SCHEMA_VERSION,
			delegation_id: ID,
			task_kind: "implementation" as const,
			contract_hash: HASH,
			worker_identity: { ...IDENTITY },
			generation: 1,
			revision: 2,
			record_names: [...DELEGATION_COMMITTED_RECORD_NAMES],
			record_count: DELEGATION_COMMITTED_RECORD_NAMES.length,
			content_hash: HASH,
			commit_marker: "not-a-valid-marker",
		};
		const verified = await verifyDelegationGenerationV2(root, ID, fakeProof);
		assert.equal(verified.ok, false);
	} finally {
		await cleanup(root);
	}
});

test("storage v2: committed generation tampering in record, identity, scope, hash, marker, or inventory is detected", async () => {
	const corruptions: Array<(directory: string) => Promise<void>> = [
		async (directory) => { await unlink(join(directory, "usage.json")); },
		async (directory) => { await writeFile(join(directory, "before.json"), "{"); },
		async (directory) => {
			const usage = JSON.parse(await readFile(join(directory, "usage.json"), "utf8"));
			usage.schema_version = 99;
			await writeFile(join(directory, "usage.json"), `${JSON.stringify(usage)}\n`);
		},
		async (directory) => {
			const identity = JSON.parse(await readFile(join(directory, "identity.json"), "utf8"));
			identity.worker_identity.worker_id = "intruder";
			await writeFile(join(directory, "identity.json"), `${JSON.stringify(identity)}\n`);
		},
		async (directory) => {
			const scope = JSON.parse(await readFile(join(directory, "scope.json"), "utf8"));
			scope.changed_paths = ["outside.ts"];
			await writeFile(join(directory, "scope.json"), `${JSON.stringify(scope)}\n`);
		},
		async (directory) => {
			const after = JSON.parse(await readFile(join(directory, "after.json"), "utf8"));
			after.diff_hash = "f".repeat(64);
			await writeFile(join(directory, "after.json"), `${JSON.stringify(after)}\n`);
		},
		async (directory) => {
			const after = JSON.parse(await readFile(join(directory, "after.json"), "utf8"));
			after.path_statuses["src/changed.ts"] = " M";
			await writeFile(join(directory, "after.json"), `${JSON.stringify(after)}\n`);
		},
		async (directory) => { await writeFile(join(directory, "worker-report.md"), "different tail"); },
		async (directory) => { await writeFile(join(directory, "commit-marker.json"), "{}\n"); },
		async (directory) => { await writeFile(join(directory, "extra.json"), "{}\n"); },
	];
	for (const corrupt of corruptions) {
		const root = await tempProject();
		try {
			const state = await committingState(root);
			const committed = await commitDelegationGeneration(root, commitInput(state));
			assert.equal(committed.ok, true);
			if (!committed.ok || committed.value.committed_proof === null) continue;
			await corrupt(generationDir(root));
			const verified = await verifyDelegationGenerationV2(root, ID, committed.value.committed_proof);
			assert.equal(verified.ok, false);
			const read = await readDelegationCommittedGenerationV2(root, ID);
			assert.equal(read.ok, false, "strict decoded reader must detect the same generation corruption");
		} finally {
			await cleanup(root);
		}
	}
});

test("storage v2: adapter tokens and fault-replacement bytes cannot escape paths or bypass bounds; unsupported generation is refused before persistence", async () => {
	const root = await tempProject();
	try {
		const base = createNodeDelegationTransactionStorageAdapter();
		const badToken = { ...base, randomToken: () => "../../escape" };
		const bad = await persistPreparedDelegationTransaction(root, {
			delegation_id: ID, task_kind: "implementation", contract_hash: HASH, allowed_paths: ["src/**"],
			worker_identity: { ...IDENTITY }, generation: 1, now: at(0),
		}, { adapter: badToken });
		assert.equal(bad.ok, false);
		const absent = await readDelegationTransactionV2(root, ID);
		assert.equal(absent.ok, false);

		const hugeGeneration = await persistPreparedDelegationTransaction(root, {
			delegation_id: ID_2, task_kind: "implementation", contract_hash: HASH, allowed_paths: ["src/**"],
			worker_identity: { ...IDENTITY }, generation: 100_000_000, now: at(0),
		});
		assert.equal(hugeGeneration.ok, false);

		const prepared = await persistPreparedDelegationTransaction(root, {
			delegation_id: ID, task_kind: "implementation", contract_hash: HASH, allowed_paths: ["src/**"],
			worker_identity: { ...IDENTITY }, generation: 1, now: at(0),
		});
		assert.equal(prepared.ok, true);
		const oversizeHook = createNodeDelegationTransactionStorageAdapter((point, bytes) =>
			point === "state.read" && bytes !== undefined ? Buffer.alloc(1_048_577) : bytes === undefined ? undefined : Uint8Array.from(bytes));
		const read = await readDelegationTransactionV2(root, ID, { adapter: oversizeHook });
		assert.equal(read.ok, false);
	} finally {
		await cleanup(root);
	}
});
