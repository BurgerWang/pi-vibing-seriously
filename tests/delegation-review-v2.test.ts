import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { reviewDelegationV2 } from "../extensions/workbench-runtime/core/delegation-review-v2.ts";
import { reconcileProjectDelegationAuthorityV2 } from "../extensions/workbench-runtime/core/delegation-project-authority.ts";
import { deriveFinalizedDelegationWorkspaceFactsV2 } from "../extensions/workbench-runtime/core/delegation-workspace-v2.ts";
import { bindDelegationBoundedTaskContractV2, buildDelegationCommittedArtifactsV2 } from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import { finalizeDelegationChangeSetLifecycleV2, prepareDelegationChangeSetLifecycleV2 } from "../extensions/workbench-runtime/core/delegation-change-set-lifecycle.ts";
import {
	commitDelegationGeneration,
	createNodeDelegationTransactionStorageAdapter,
	DELEGATION_REVIEW_STORAGE_FAULT_POINTS,
	persistCommittingDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRunningDelegationTransaction,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	hasDelegationSemanticRepairAuthorityV2,
	hasDelegationSemanticReviewAuthorityV2,
	readDelegationTransactionV2,
	hashDelegationCommittedRecords,
	type DelegationCommittedRecords,
	type DelegationTransactionStorageFaultPoint,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	collectGitFacts,
	computeDiffHash,
	type LedgerWorkerFacts,
} from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import type {
	DelegationTerminalOutcome,
	DelegationTransactionRecord,
	DelegationWorkerIdentity,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import { delegationCommitMarker } from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import {
	REVIEW_PAGE_SOURCE_MAX_BYTES,
	preflightSemanticReviewEnvelopeV1,
	type ReviewPresentationProgress,
} from "../extensions/workbench-runtime/core/diff-review.ts";
import {
	buildSemanticReviewEnvelopeV1,
	estimateSemanticReviewRecordBytesV1,
} from "../extensions/workbench-runtime/core/semantic-review-envelope.ts";
import { collectReviewRelevanceV2 } from "../extensions/workbench-runtime/core/review-relevance-v2.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { beginWriteJournalOperation, completeWriteJournalOperation } from "../extensions/workbench-runtime/core/write-journal.ts";
import { spawnExec } from "./helpers.ts";

const ID = "20260817-170000-rv20";
const COMMITTED_RECORD_NAMES = [
	"after.json", "before.json", "identity.json", "review.json", "scope.json", "usage.json", "worker-report.md", "worker-summary.json",
] as const;
const IDENTITY: DelegationWorkerIdentity = {
	provider: WORKER_PROVIDER,
	model: WORKER_MODEL_ID,
	worker_id: "review-v2-worker",
};
const SOL_REVIEWER = { provider: "openai-codex", model: "gpt-5.6-sol" } as const;

function at(second: number): string {
	return `2026-08-17T17:00:${String(second).padStart(2, "0")}.000Z`;
}

function transactionDir(root: string): string {
	return join(root, CONFIG_DIR_NAME, "workbench", "delegations", ID, "v2");
}

function reviewPath(root: string): string {
	return join(transactionDir(root), "review.json");
}

function transactionPath(root: string): string {
	return join(transactionDir(root), "transaction.json");
}

function generationPath(root: string, name: string): string {
	return join(transactionDir(root), "generations", "g00000001", name);
}

function cas(state: DelegationTransactionRecord, second: number) {
	return {
		delegation_id: state.delegation_id,
		contract_hash: state.contract_hash,
		worker_identity: { ...state.worker_identity },
		expected_generation: state.generation,
		expected_revision: state.revision,
		now: at(second),
	};
}

async function git(root: string, args: string[]): Promise<void> {
	const result = await spawnExec("git", args, { cwd: root });
	assert.equal(result.code, 0, result.stderr);
}

interface ReviewFixture {
	root: string;
	state: DelegationTransactionRecord;
	records: DelegationCommittedRecords;
}

function workerFacts(report: string, spendProfile: "standard" | "extended" = "standard"): LedgerWorkerFacts {
	return {
		provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, status: "success", exitCode: 0, turns: 1,
		stopReason: "end_turn", errorMessage: null,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		cacheHitRatio: 0,
		budget: { maxContextTokens: 15, maxContextRatio: 0.001, softBudgetReached: false, hardBudgetExceeded: false, compactionCount: 0, compactionReasons: [] },
		spendProfile, spendState: { turns: 1, totalTokens: 15, outputTokens: 5 }, spendBand: "ok",
		spendReasons: [], spendSoftReached: { turns: false, totalTokens: false, outputTokens: false },
		spendHardExceeded: { turns: false, totalTokens: false, outputTokens: false }, reportSummary: report,
	};
}

async function setupReviewFixture(
	paths = ["src/a.ts"],
	preDirtyPath?: string,
	writeOrder: readonly string[] = paths,
	withPlanReference = false,
	withExtendedReason = false,
	workerContent: (path: string) => string | Buffer = (path) => `worker:${path}\n`,
	reportedPaths?: readonly string[],
	newPaths: readonly string[] = [],
): Promise<ReviewFixture> {
	const root = await mkdtemp(join(tmpdir(), "delegation-review-v2-"));
	await git(root, ["init"]);
	await git(root, ["config", "user.email", "review-v2@example.invalid"]);
	await git(root, ["config", "user.name", "Review V2 Test"]);
	const newPathSet = new Set(newPaths);
	const baselinePaths = paths.filter((path) => !newPathSet.has(path));
	for (const path of paths) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		if (!newPathSet.has(path)) await writeFile(join(root, path), `baseline:${path}\n`);
	}
	if (baselinePaths.length > 0) await git(root, ["add", "--", ...baselinePaths]);
	await git(root, ["commit", "--allow-empty", "-m", "baseline"]);
	if (preDirtyPath !== undefined) {
		await mkdir(dirname(join(root, preDirtyPath)), { recursive: true });
		await writeFile(join(root, preDirtyPath), "pre-dirty\n");
	}
	const contract = bindDelegationBoundedTaskContractV2({
		task_kind: "implementation",
		task: "change the authorized fixture paths",
		allowed_paths: ["src/**"],
		acceptance_criteria: ["all authorized paths are changed"],
		verification: ["inspect the exact worker diff"],
		timeout_seconds: 600,
		budget_profile: withExtendedReason ? "extended" : "standard",
		...(withExtendedReason ? { extended_reason: "Cross-module review fixture preserves bounded authority." } : {}),
		...(withPlanReference ? {
			repair_of: "20260817-160000-rp01",
			plan_ref: {
				schema: "workbench-plan-ref-v1",
				plan_id: "review-v2-plan",
				version: "1.0",
				plan_path: "docs/plans/review-v2.md",
				plan_sha256: "a".repeat(64),
				candidate: "CURRENT_WORKTREE",
				status: "EVIDENCED",
				criteria: [{ id: "C1", gate_id: "b1", check_ids: ["b1.1"], evidence_paths: ["tests/delegation-review-v2.test.ts"] }],
				next_action: "strictly review the persisted delegation",
			},
		} : {}),
	});
	assert.equal(contract.ok, true);
	if (!contract.ok) throw new Error("contract setup failed");
	const prepared = await persistPreparedDelegationTransaction(root, {
		delegation_id: ID,
		task_kind: "implementation",
		contract_hash: contract.value.contract_hash,
		allowed_paths: contract.value.allowed_paths,
		worker_identity: { ...IDENTITY },
		generation: 1,
		now: at(0),
	});
	assert.equal(prepared.ok, true);
	if (!prepared.ok) throw new Error("prepare failed");
	const lifecyclePrepared = await prepareDelegationChangeSetLifecycleV2({
		project_root: root, delegation_id: ID, contract_hash: contract.value.contract_hash,
		dependency_paths: [], exec: spawnExec,
	});
	assert.equal(lifecyclePrepared.ok, true);
	if (!lifecyclePrepared.ok) throw new Error("lifecycle prepare failed");
	const running = await persistRunningDelegationTransaction(root, cas(prepared.value, 1));
	assert.equal(running.ok, true);
	if (!running.ok) throw new Error("start failed");
	let revision = 0;
	for (let index = 0; index < writeOrder.length; index += 1) {
		const path = writeOrder[index]!;
		const operationId = (index + 1).toString(16).padStart(64, "0");
		const begun = await beginWriteJournalOperation({
			project_root: root, delegation_id: ID, contract_hash: contract.value.contract_hash,
			expected_revision: revision, operation_id: operationId, kind: "write", path,
		});
		assert.equal(begun.ok, true);
		if (!begun.ok) throw new Error("journal begin failed");
		revision = begun.value.revision;
		await writeFile(join(root, path), workerContent(path));
		const completed = await completeWriteJournalOperation({
			project_root: root, delegation_id: ID, contract_hash: contract.value.contract_hash,
			expected_revision: revision, operation_id: operationId, kind: "write", path, outcome: "succeeded",
		});
		assert.equal(completed.ok, true);
		if (!completed.ok) throw new Error("journal completion failed");
		revision = completed.value.revision;
	}
	const lifecycle = await finalizeDelegationChangeSetLifecycleV2({
		prepared: lifecyclePrepared.value,
		observation: { state: "complete", tool: "write", outcome: "succeeded", code: "none", revision },
		exec: spawnExec,
	});
	assert.equal(lifecycle.ok, true);
	if (!lifecycle.ok) throw new Error("lifecycle finalize failed");
	const workspace = deriveFinalizedDelegationWorkspaceFactsV2(lifecycle.value);
	assert.equal(workspace.ok, true);
	if (!workspace.ok) throw new Error("workspace fact derivation failed");
	const workerPaths = lifecycle.value.change_set.worker_delta.map((entry) => entry.path);
	const outcome: DelegationTerminalOutcome = {
		delegation_id: ID,
		task_kind: "implementation",
		worker_identity: { ...IDENTITY },
		provider_success: true,
		exit_code: 0,
		report_complete: true,
		terminal_facts_complete: true,
		scope_complete: true,
		change_set_status: lifecycle.value.change_set.status,
		changed_paths: [...workerPaths],
		successful_write_count: workerPaths.length,
		denied_write_count: 0,
		delta_hash: lifecycle.value.change_set.worker_delta_hash,
	};
	const committing = await persistCommittingDelegationTransaction(root, { ...cas(running.value, 2), outcome });
	assert.equal(committing.ok, true);
	if (!committing.ok) throw new Error("commit begin failed");
	const report = `## Completed\n- changed fixture files\n## Files Changed\n${(reportedPaths ?? workerPaths).map((path) => `- ${path}`).join("\n")}\n## Verification\n- facts\n## Remaining Risks\n- none\n`;
	const relevance = await collectReviewRelevanceV2({
		project_root: root, delegation_id: ID, contract_hash: contract.value.contract_hash,
		after_guard: lifecycle.value.after_guard, change_set: lifecycle.value.change_set, exec: spawnExec,
	});
	assert.equal(relevance.ok, true);
	if (!relevance.ok) throw new Error("review relevance setup failed");
	const envelope = await preflightSemanticReviewEnvelopeV1({
		projectRoot: root, workerPaths, allowedPaths: contract.value.allowed_paths,
		afterDigests: workspace.value.after.pathDigests, pathStatuses: workspace.value.after.pathStatuses,
		relevanceProjection: relevance.value.projection, relevanceProjectionHash: relevance.value.binding.projection_hash,
		exec: spawnExec,
	});
	assert.equal(envelope.ok, true, envelope.ok ? "" : envelope.code);
	if (!envelope.ok) throw new Error("review envelope setup failed");
	const built = buildDelegationCommittedArtifactsV2({
		transaction: committing.value, contract: contract.value, before: workspace.value.before, after: workspace.value.after,
		changeSetLifecycle: lifecycle.value, worker: workerFacts(report, withExtendedReason ? "extended" : "standard"), reportText: report,
		reviewEnvelope: envelope.value,
	});
	assert.equal(built.ok, true);
	if (!built.ok) throw new Error("artifact build failed");
	const records = built.value.records;
	const committed = await commitDelegationGeneration(root, { ...cas(committing.value, 3), records });
	assert.equal(committed.ok, true);
	if (!committed.ok) throw new Error("generation commit failed");
	return { root, state: committed.value, records };
}

async function replaceCommittedEnvelopeWithLegacyBinaryPaging(
	fixture: ReviewFixture,
	path: string,
	tamperStreamHash = false,
): Promise<void> {
	const afterPath = generationPath(fixture.root, "after.json");
	const scopePath = generationPath(fixture.root, "scope.json");
	const after = JSON.parse(await readFile(afterPath, "utf8")) as Record<string, any>;
	const scope = JSON.parse(await readFile(scopePath, "utf8")) as Record<string, any>;
	const relevance = await collectReviewRelevanceV2({
		project_root: fixture.root,
		delegation_id: ID,
		contract_hash: fixture.state.contract_hash,
		after_guard: after.workspace_guard,
		change_set: scope.change_set,
		exec: spawnExec,
	});
	assert.equal(relevance.ok, true, relevance.ok ? "" : relevance.error.code);
	if (!relevance.ok) throw new Error("legacy envelope relevance failed");
	const legacyText = (await readFile(join(fixture.root, path))).toString("utf8");
	const streamBytes = Buffer.byteLength(legacyText, "utf8");
	const streams = [{
		path,
		source: "file-content" as const,
		stream_bytes: streamBytes,
		stream_sha256: tamperStreamHash
			? "0".repeat(64)
			: createHash("sha256").update(legacyText, "utf8").digest("hex"),
		page_count: streamBytes === 0 ? 0 : 1,
	}];
	const projected = estimateSemanticReviewRecordBytesV1({
		worker_paths: [path],
		allowed_paths: fixture.state.allowed_paths,
		streams,
		relevance_projection: relevance.value.projection,
	});
	assert.notEqual(projected, undefined);
	const legacy = buildSemanticReviewEnvelopeV1({
		streams,
		projected_review_record_bytes: projected!,
		relevance_projection_hash: relevance.value.binding.projection_hash,
	});
	assert.equal(legacy.ok, true, legacy.ok ? "" : legacy.code);
	if (!legacy.ok) throw new Error("legacy envelope build failed");
	after.review_envelope = legacy.value;
	await writeFile(afterPath, `${JSON.stringify(after, null, 2)}\n`);

	const compiled = new Map<any, Uint8Array>();
	for (const name of COMMITTED_RECORD_NAMES) compiled.set(name, await readFile(generationPath(fixture.root, name)));
	const transaction = JSON.parse(await readFile(transactionPath(fixture.root), "utf8")) as Record<string, any>;
	const { commit_marker: _oldMarker, ...proofWithoutMarker } = transaction.committed_proof;
	proofWithoutMarker.content_hash = hashDelegationCommittedRecords(compiled);
	transaction.committed_proof = {
		...proofWithoutMarker,
		commit_marker: delegationCommitMarker(proofWithoutMarker),
	};
	await writeFile(generationPath(fixture.root, "commit-marker.json"), `${JSON.stringify(transaction.committed_proof, null, 2)}\n`);
	await writeFile(transactionPath(fixture.root), `${JSON.stringify(transaction, null, 2)}\n`);
}

test("review v2 fixture: reverse journal order builds, commits, and strict-reads canonical W digests", async () => {
	const fixture = await setupReviewFixture(["src/a.ts", "src/b.ts"], undefined, ["src/b.ts", "src/a.ts"]);
	try {
		assert.deepEqual(fixture.state.terminal_outcome?.changed_paths, ["src/a.ts", "src/b.ts"]);
		const before = fixture.records["before.json"] as Record<string, any>;
		const after = fixture.records["after.json"] as Record<string, any>;
		assert.deepEqual(Object.keys(before.path_digests), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(Object.keys(after.path_digests), ["src/a.ts", "src/b.ts"]);
		const strict = await readDelegationCommittedGenerationV2(fixture.root, ID);
		assert.equal(strict.ok, true, strict.ok ? "" : JSON.stringify(strict.error));
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: report-only path notes reserve their omitted suffix and persist within the UTF-8 record bound", async () => {
	const workerPaths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
	const reportOnlyPaths = [
		"config/scheduler/a5.0.yaml",
		"scripts/checks/failure_propagation.py",
		"scripts/checks/idempotency_report.py",
		"scripts/checks/orchestration_e2e.py",
		"src/ueras/orchestration/__init__.py",
		"src/ueras/orchestration/artifacts.py",
		"src/ueras/orchestration/contracts.py",
		"src/ueras/orchestration/job_registry.py",
		"src/ueras/orchestration/run_cli.py",
		"src/ueras/orchestration/scheduler.py",
		"tests/orchestration/test_failure_propagation.py",
		"tests/orchestration/test_idempotency.py",
	];
	const fixture = await setupReviewFixture(
		workerPaths,
		undefined,
		workerPaths,
		false,
		false,
		(path) => `worker:${path}\n`,
		[...workerPaths, ...reportOnlyPaths],
	);
	try {
		const reviewed = await reviewDelegationV2({
			projectRoot: fixture.root,
			delegationId: ID,
			exec: spawnExec,
			maxLines: 400,
			maxBytes: 32_768,
			now: at(4),
		});
		assert.equal(reviewed.ok, true, reviewed.ok ? "" : JSON.stringify(reviewed.error));
		if (!reviewed.ok || reviewed.review.record === undefined) return;
		const mismatchNote = reviewed.review.record.notes.find((note) => note.startsWith("worker report lists 12 path(s)"));
		assert.ok(mismatchNote, JSON.stringify(reviewed.review.record.notes));
		assert.ok(Buffer.byteLength(mismatchNote, "utf8") <= 240, mismatchNote);
		assert.match(mismatchNote, /…\(\+\d+ more\)$/u, "the exact omitted count remains visible inside the bound");
		const persisted = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(persisted.ok, true, persisted.ok ? "" : JSON.stringify(persisted.error));
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: plan_ref, repair_of, and extended_reason coexist and strict review rebinds their hash", async () => {
	const fixture = await setupReviewFixture(["src/a.ts"], undefined, ["src/a.ts"], true, true);
	try {
		const strict = await readDelegationCommittedGenerationV2(fixture.root, ID);
		assert.equal(strict.ok, true, strict.ok ? "" : strict.error.code);
		if (!strict.ok) return;
		const before = strict.value.records["before.json"] as Record<string, unknown>;
		const contract = before.contract as Record<string, unknown>;
		assert.equal((contract.plan_ref as Record<string, unknown>).plan_id, "review-v2-plan");
		assert.equal(contract.repair_of, "20260817-160000-rp01");
		assert.equal(contract.extended_reason, "Cross-module review fixture preserves bounded authority.");
		assert.equal(contract.contract_hash, strict.value.state.contract_hash, "extended reason remains in strict hash authority");
		const reviewed = await reviewDelegationV2({
			projectRoot: fixture.root,
			delegationId: ID,
			exec: spawnExec,
			includePaths: ["src/a.ts"],
			now: at(4),
		});
		assert.equal(reviewed.ok, true, reviewed.ok ? "" : JSON.stringify(reviewed.error));
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: full pre-dirty after snapshot stays diagnostic while worker paths remain ChangeSet delta", async () => {
	const fixture = await setupReviewFixture(["src/a.ts"], "src/pre-dirty.ts");
	try {
		const afterRecord = fixture.records["after.json"] as Record<string, any>;
		assert.deepEqual(afterRecord.changed_paths, ["src/a.ts"]);
		assert.deepEqual(Object.keys(afterRecord.path_statuses).sort(), ["src/a.ts", "src/pre-dirty.ts"]);
		const reviewed = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: ["src/a.ts"], now: at(4),
		});
		assert.equal(reviewed.ok, true, reviewed.ok ? "" : JSON.stringify(reviewed.error));
		if (reviewed.ok) assert.deepEqual(reviewed.review.record?.checked_paths, ["src/a.ts"]);
	} finally {
		await cleanup(fixture);
	}
});

async function cleanup(fixture: ReviewFixture): Promise<void> {
	await rm(fixture.root, { recursive: true, force: true });
}

async function acceptPresentedReview(
	fixture: ReviewFixture,
	boundDiffHash: string,
	second: number,
	storage?: Parameters<typeof reviewDelegationV2>[0]["storage"],
) {
	return reviewDelegationV2({
		projectRoot: fixture.root,
		delegationId: ID,
		exec: spawnExec,
		now: at(second),
		semanticDecision: "ACCEPT",
		expectedBoundDiffHash: boundDiffHash,
		reviewer: SOL_REVIEWER,
		...(storage === undefined ? {} : { storage }),
	});
}

async function repairPresentedReview(
	fixture: ReviewFixture,
	boundDiffHash: string,
	repairReason: string,
	second: number,
) {
	return reviewDelegationV2({
		projectRoot: fixture.root,
		delegationId: ID,
		exec: spawnExec,
		now: at(second),
		semanticDecision: "REPAIR",
		expectedBoundDiffHash: boundDiffHash,
		repairReason,
		reviewer: SOL_REVIEWER,
	});
}

async function presentAndAcceptReview(fixture: ReviewFixture, second = 4) {
	const presented = await reviewDelegationV2({
		projectRoot: fixture.root, delegationId: ID, exec: spawnExec, now: at(second),
	});
	assert.equal(presented.ok, true, presented.ok ? "" : JSON.stringify(presented.error));
	if (!presented.ok || presented.review.record === undefined) throw new Error("presentation failed");
	assert.equal(presented.finalized, false);
	const accepted = await acceptPresentedReview(fixture, presented.review.record.bound_diff_hash, second + 1);
	assert.equal(accepted.ok, true, accepted.ok ? "" : JSON.stringify(accepted.error));
	if (!accepted.ok) throw new Error("acceptance failed");
	return accepted;
}

test("review v2: complete scope packet stays provisional until a second bound Sol ACCEPT, then immutable replay refuses drift", async () => {
	const fixture = await setupReviewFixture();
	try {
		const input = { projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: ["src/a.ts"], secrets: ["test-secret"], now: at(4) };
		const inputSnapshot = { ...input, includePaths: [...input.includePaths], secrets: [...input.secrets] };
		const result = await reviewDelegationV2(input);
		assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
		if (!result.ok) return;
		assert.deepEqual(input, inputSnapshot, "review does not mutate caller-owned input arrays");
		assert.equal(result.finalized, false);
		assert.equal(result.transaction.status, "PENDING_REVIEW");
		assert.equal(result.review.record?.semantic_review, "required");
		assert.equal(result.review.record?.semantic_acceptance, undefined);
		assert.deepEqual(result.review.record?.presentation_progress?.map((item) => ({
			path: item.path,
			complete: item.next_byte === item.total_bytes,
		})), [{ path: "src/a.ts", complete: true }], "even a one-page source carries an exact presentation proof");
		const boundHash = result.review.record?.bound_diff_hash;
		assert.equal(typeof boundHash, "string");
		const accepted = await acceptPresentedReview(fixture, boundHash!, 5);
		assert.equal(accepted.ok, true, accepted.ok ? "" : JSON.stringify(accepted.error));
		if (!accepted.ok) return;
		assert.equal(accepted.finalized, true);
		assert.equal(accepted.transaction.status, "REVIEWED");
		assert.equal(accepted.review.record?.semantic_review, "accepted");
		assert.deepEqual(accepted.review.record?.semantic_acceptance, {
			decision: "ACCEPT",
			expected_bound_diff_hash: boundHash,
			reviewer: SOL_REVIEWER,
			accepted_at: at(5),
		});
		const bytes = await readFile(reviewPath(fixture.root));
		const hash = createHash("sha256").update(bytes).digest("hex");
		assert.equal(accepted.review_hash, hash);
		assert.equal(accepted.transaction.review?.review_hash, hash);
		const strict = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(strict.ok, true);
		if (strict.ok) assert.deepEqual(accepted.review.record, strict.value.review, "returned and exact persisted records share one canonical shape");
		const explicitReplay = await acceptPresentedReview(fixture, boundHash!, 6);
		assert.equal(explicitReplay.ok, true, explicitReplay.ok ? "" : JSON.stringify(explicitReplay.error));
		assert.deepEqual(await readFile(reviewPath(fixture.root)), bytes, "matching explicit ACCEPT replay is idempotent");
		const wrongReplayIdentity = await reviewDelegationV2({
			projectRoot: fixture.root,
			delegationId: ID,
			exec: spawnExec,
			now: at(6),
			semanticDecision: "ACCEPT",
			expectedBoundDiffHash: boundHash!,
			reviewer: { provider: "openai", model: "gpt-5.6-sol" },
		});
		assert.equal(wrongReplayIdentity.ok, false);
		if (!wrongReplayIdentity.ok) assert.equal(wrongReplayIdentity.error.code, "review_conflict");
		const wrongReplayHash = await acceptPresentedReview(fixture, "f".repeat(64), 6);
		assert.equal(wrongReplayHash.ok, false);
		if (!wrongReplayHash.ok) assert.equal(wrongReplayHash.error.code, "review_conflict");
		const replay = await reviewDelegationV2({ ...input, now: at(6) });
		assert.equal(replay.ok, true);
		assert.deepEqual(await readFile(reviewPath(fixture.root)), bytes, "finalized bytes never change on replay");
		await writeFile(join(fixture.root, "src/a.ts"), "post-review drift\n");
		const drift = await reviewDelegationV2({ ...input, now: at(7) });
		assert.equal(drift.ok, false);
		if (!drift.ok) assert.equal(drift.error.code, "review_conflict");
		assert.deepEqual(await readFile(reviewPath(fixture.root)), bytes);
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: a default multi-path bounded presentation persists only fully visible entries as progress", async () => {
	const fixture = await setupReviewFixture(
		["src/a-small.ts", "src/b-large.ts"],
		undefined,
		["src/a-small.ts", "src/b-large.ts"],
		false,
		false,
		(path) => path.endsWith("a-small.ts") ? "export const small = true;\n" : "export const value = 1;\n".repeat(120),
	);
	try {
		const result = await reviewDelegationV2({
			projectRoot: fixture.root,
			delegationId: ID,
			exec: spawnExec,
			maxBytes: 3_000,
			maxLines: 80,
			now: at(4),
		});
		assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
		if (!result.ok) return;
		assert.equal(result.finalized, false);
		assert.equal(result.review.record?.presentation_complete, false);
		assert.ok(result.review.record?.patch.some((entry) => entry.truncated));
		const strict = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(strict.ok, true, strict.ok ? "" : JSON.stringify(strict.error));
		if (!strict.ok) return;
		for (const entry of strict.value.review.patch.filter((candidate) => !candidate.truncated)) {
			const progress: ReviewPresentationProgress | undefined = strict.value.review.presentation_progress
				?.find((item) => item.path === entry.path);
			assert.ok(progress, `complete entry ${entry.path} has strict persisted progress`);
			assert.equal(progress.next_byte, progress.total_bytes);
		}
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: first-call ACCEPT, wrong hash, non-Sol identity, and incomplete packet all fail closed", async () => {
	const fixture = await setupReviewFixture(["src/a.ts", "src/b.ts"]);
	try {
		const firstAccept = await acceptPresentedReview(fixture, "a".repeat(64), 4);
		assert.equal(firstAccept.ok, false);
		if (!firstAccept.ok) assert.equal(firstAccept.error.code, "review_invalid");
		const first = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: ["src/a.ts"], now: at(5),
		});
		assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
		if (!first.ok || first.review.record === undefined) return;
		assert.equal(first.review.record.presentation_complete, false);
		const incompleteAccept = await acceptPresentedReview(fixture, first.review.record.bound_diff_hash, 6);
		assert.equal(incompleteAccept.ok, false);
		if (!incompleteAccept.ok) assert.equal(incompleteAccept.error.code, "review_invalid");
		const second = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: ["src/b.ts"], now: at(7),
		});
		assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.error));
		if (!second.ok || second.review.record === undefined) return;
		assert.equal(second.review.record.presentation_complete, true);
		const wrongHash = await acceptPresentedReview(fixture, "f".repeat(64), 8);
		assert.equal(wrongHash.ok, false);
		if (!wrongHash.ok) assert.equal(wrongHash.error.code, "review_conflict");
		const wrongIdentity = await reviewDelegationV2({
			projectRoot: fixture.root,
			delegationId: ID,
			exec: spawnExec,
			now: at(8),
			semanticDecision: "ACCEPT",
			expectedBoundDiffHash: second.review.record.bound_diff_hash,
			reviewer: { provider: "openai-codex", model: "gpt-5.6-luna" },
		});
		assert.equal(wrongIdentity.ok, false);
		if (!wrongIdentity.ok) assert.equal(wrongIdentity.error.code, "review_invalid");
		const durable = await readDelegationTransactionV2(fixture.root, ID);
		assert.equal(durable.ok, true);
		if (durable.ok) assert.equal(durable.value.status, "PENDING_REVIEW");
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: REPAIR requires a prior complete current packet, exact hash, and active Sol", async () => {
	const fixture = await setupReviewFixture(["src/a.ts", "src/b.ts"]);
	const repairReason = "Canonicalize JSON before hashing and use max normalized latency; fix the Rust float type.";
	try {
		const firstRepair = await repairPresentedReview(fixture, "a".repeat(64), repairReason, 4);
		assert.equal(firstRepair.ok, false);
		if (!firstRepair.ok) assert.equal(firstRepair.error.code, "review_invalid");

		const partial = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: ["src/a.ts"], now: at(5),
		});
		assert.equal(partial.ok, true, partial.ok ? "" : JSON.stringify(partial.error));
		if (!partial.ok || partial.review.record === undefined) return;
		assert.equal(partial.review.record.presentation_complete, false);
		const incomplete = await repairPresentedReview(fixture, partial.review.record.bound_diff_hash, repairReason, 6);
		assert.equal(incomplete.ok, false);
		if (!incomplete.ok) assert.equal(incomplete.error.code, "review_invalid");

		const complete = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: ["src/b.ts"], now: at(7),
		});
		assert.equal(complete.ok, true, complete.ok ? "" : JSON.stringify(complete.error));
		if (!complete.ok || complete.review.record === undefined) return;
		assert.equal(complete.review.record.presentation_complete, true);
		const boundHash = complete.review.record.bound_diff_hash;

		const wrongHash = await repairPresentedReview(fixture, "f".repeat(64), repairReason, 8);
		assert.equal(wrongHash.ok, false);
		if (!wrongHash.ok) assert.equal(wrongHash.error.code, "review_conflict");
		const nonSol = await reviewDelegationV2({
			projectRoot: fixture.root,
			delegationId: ID,
			exec: spawnExec,
			now: at(8),
			semanticDecision: "REPAIR",
			expectedBoundDiffHash: boundHash,
			repairReason,
			reviewer: { provider: "openai-codex", model: "gpt-5.6-luna" },
		});
		assert.equal(nonSol.ok, false);
		if (!nonSol.ok) assert.equal(nonSol.error.code, "review_invalid");

		await writeFile(join(fixture.root, "src/a.ts"), "post-presentation drift\n");
		const drifted = await repairPresentedReview(fixture, boundHash, repairReason, 9);
		assert.equal(drifted.ok, false);
		if (!drifted.ok) assert.equal(drifted.error.code, "review_conflict");
		await writeFile(join(fixture.root, "src/a.ts"), "worker:src/a.ts\n");

		const strict = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(strict.ok, true, strict.ok ? "" : JSON.stringify(strict.error));
		if (strict.ok) assert.equal(strict.value.semantic_repair, undefined, "refused decisions publish no negative authority");
		const durable = await readDelegationTransactionV2(fixture.root, ID);
		assert.equal(durable.ok, true);
		if (durable.ok) {
			assert.equal(durable.value.status, "PENDING_REVIEW");
			assert.equal(durable.value.revision, 3);
			assert.equal(durable.value.review, null);
		}
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: complete Sol REPAIR is immutable negative authority, remains Gate-blocking, and replays logically", async () => {
	const fixture = await setupReviewFixture();
	const repairReason = "Canonicalize JSON before hashing and use max normalized latency; fix the Rust float type.";
	try {
		const presented = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec, now: at(4),
		});
		assert.equal(presented.ok, true, presented.ok ? "" : JSON.stringify(presented.error));
		if (!presented.ok || presented.review.record === undefined) return;
		assert.equal(presented.review.record.presentation_complete, true);
		const boundHash = presented.review.record.bound_diff_hash;
		const reviewBytes = await readFile(reviewPath(fixture.root));

		const repaired = await repairPresentedReview(fixture, boundHash, repairReason, 5);
		assert.equal(repaired.ok, true, repaired.ok ? "" : JSON.stringify(repaired.error));
		if (!repaired.ok) return;
		assert.equal(repaired.finalized, false);
		assert.equal(repaired.transaction.status, "PENDING_REVIEW");
		assert.equal(repaired.transaction.revision, 3);
		assert.equal(repaired.transaction.review, null);
		assert.equal(repaired.semantic_authority, "repair_required");
		assert.match(repaired.repair_decision_hash ?? "", /^[0-9a-f]{64}$/u);
		assert.match(repaired.repair_reason_hash ?? "", /^[0-9a-f]{64}$/u);
		assert.deepEqual(await readFile(reviewPath(fixture.root)), reviewBytes, "REPAIR never rewrites the presented review packet");

		const strict = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(strict.ok, true, strict.ok ? "" : JSON.stringify(strict.error));
		if (!strict.ok) return;
		assert.equal(strict.value.finalized, false);
		assert.equal(strict.value.state.status, "PENDING_REVIEW");
		assert.equal(strict.value.review.semantic_review, "required");
		assert.equal(strict.value.semantic_repair?.decision, "REPAIR");
		assert.equal(strict.value.semantic_repair?.repair_reason, repairReason);
		assert.equal(strict.value.semantic_repair?.expected_bound_diff_hash, boundHash);
		assert.equal(strict.value.semantic_repair?.decision_hash, repaired.repair_decision_hash);
		assert.equal(hasDelegationSemanticRepairAuthorityV2(strict.value), true);
		assert.equal(hasDelegationSemanticReviewAuthorityV2(strict.value), false, "negative authority can never satisfy review or Gate authority");

		const repairBytes = await readFile(join(transactionDir(fixture.root), "repair-decision.json"));
		const replay = await repairPresentedReview(fixture, boundHash, repairReason, 6);
		assert.equal(replay.ok, true, replay.ok ? "" : JSON.stringify(replay.error));
		if (replay.ok) {
			assert.equal(replay.semantic_authority, "repair_required");
			assert.equal(replay.repair_decision_hash, repaired.repair_decision_hash);
		}
		assert.deepEqual(await readFile(join(transactionDir(fixture.root), "repair-decision.json")), repairBytes,
			"same binding, reason, and Sol identity replay immutable authority even when invocation time advances");

		const changedReason = await repairPresentedReview(fixture, boundHash, `${repairReason} Also update snapshots.`, 7);
		assert.equal(changedReason.ok, false);
		if (!changedReason.ok) assert.equal(changedReason.error.code, "review_conflict");
		const acceptAfterRepair = await acceptPresentedReview(fixture, boundHash, 7);
		assert.equal(acceptAfterRepair.ok, false);
		if (!acceptAfterRepair.ok) assert.equal(acceptAfterRepair.error.code, "review_conflict");
		assert.deepEqual(await readFile(join(transactionDir(fixture.root), "repair-decision.json")), repairBytes,
			"conflicting semantic decisions cannot mutate the immutable REPAIR record");
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: strict compact SVG/JSON fact packets can terminate through Sol ACCEPT while ordinary truncated source cannot", async () => {
	const compactFixture = await setupReviewFixture(
		["src/large.svg", "src/bundle.json"],
		undefined,
		["src/large.svg", "src/bundle.json"],
		false,
		false,
		(path) => path.endsWith(".svg")
			? `<svg>${"<path d=\"M0 0\"/>".repeat(3_000)}</svg>\n`
			: JSON.stringify({ payload: "x".repeat(40_000), tail: "done" }),
	);
	try {
		const presented = await reviewDelegationV2({
			projectRoot: compactFixture.root, delegationId: ID, exec: spawnExec, now: at(4),
		});
		assert.equal(presented.ok, true, presented.ok ? "" : JSON.stringify(presented.error));
		if (!presented.ok || presented.review.record === undefined) return;
		assert.equal(presented.finalized, false);
		assert.equal(presented.review.record.patch_truncated, true, "compact content remains honestly summarized");
		assert.deepEqual(presented.review.record.patch.map((entry) => entry.source), ["compact", "compact"]);
		assert.deepEqual(presented.review.record.fully_presented_paths, ["src/bundle.json", "src/large.svg"]);
		assert.equal(presented.review.record.presentation_complete, true, "strict compact facts are a complete bounded presentation unit");
		assert.match(presented.review.lines.join("\n"), /high risk/);
		assert.match(presented.review.lines.join("\n"), /generator equality remains NOT_VERIFIED/);
		const accepted = await acceptPresentedReview(compactFixture, presented.review.record.bound_diff_hash, 5);
		assert.equal(accepted.ok, true, accepted.ok ? "" : JSON.stringify(accepted.error));
		if (accepted.ok) {
			assert.equal(accepted.finalized, true);
			assert.equal(accepted.transaction.status, "REVIEWED");
			assert.equal(accepted.review.record?.semantic_review, "accepted");
		}
	} finally {
		await cleanup(compactFixture);
	}

	const sourceFixture = await setupReviewFixture(
		["src/large.ts"],
		undefined,
		["src/large.ts"],
		false,
		false,
		() => "const value = 1;\n".repeat(4_000),
	);
	try {
		const presented = await reviewDelegationV2({
			projectRoot: sourceFixture.root, delegationId: ID, exec: spawnExec, maxBytes: 4_096, maxLines: 56, now: at(4),
		});
		assert.equal(presented.ok, true, presented.ok ? "" : JSON.stringify(presented.error));
		if (!presented.ok || presented.review.record === undefined) return;
		assert.equal(presented.review.record.patch[0]?.source, "git-diff");
		assert.equal(presented.review.record.patch[0]?.truncated, true);
		assert.equal(presented.review.record.presentation_complete, false);
		const refused = await acceptPresentedReview(sourceFixture, presented.review.record.bound_diff_hash, 5);
		assert.equal(refused.ok, false);
		if (!refused.ok) assert.equal(refused.error.code, "review_invalid");
		const durable = await readDelegationTransactionV2(sourceFixture.root, ID);
		assert.equal(durable.ok, true);
		if (durable.ok) assert.equal(durable.value.status, "PENDING_REVIEW");
	} finally {
		await cleanup(sourceFixture);
	}
});

test("review v2: known and unknown-extension binaries are complete size/digest compact packets and can terminate through bound Sol ACCEPT", async () => {
	const path = "src/authority-data.zip";
	const largePath = "src/large-model.bin";
	const opaquePath = "src/opaque.payload";
	const textPath = "src/text.payload";
	const zipBytes = Buffer.concat([
		Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x00]),
		Buffer.alloc(8_192, 0xa5),
	]);
	const largeBytes = Buffer.concat([Buffer.from([0x00, 0xff]), Buffer.alloc(4 * 1024 * 1024 + 257, 0x82)]);
	const opaqueBytes = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0xfd]), Buffer.alloc(2_048, 0x81)]);
	const validUtf8Text = `${"a".repeat(8_191)}😀${"b".repeat(500)}`;
	const fixture = await setupReviewFixture(
		[path, largePath, opaquePath, textPath], undefined, [path, largePath, opaquePath, textPath], false, false,
		(candidate) => candidate === path ? zipBytes
			: candidate === largePath ? largeBytes
				: candidate === opaquePath ? opaqueBytes : validUtf8Text,
		undefined, [path, largePath, opaquePath, textPath],
	);
	try {
		const presented = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec, now: at(4),
		});
		assert.equal(presented.ok, true, presented.ok ? "" : JSON.stringify(presented.error));
		if (!presented.ok || presented.review.record === undefined) return;
		const entries = new Map(presented.review.record.patch.map((entry) => [entry.path, entry]));
		const entry = entries.get(path)!;
		assert.equal(entry.source, "compact");
		assert.equal(entry.compact?.content_kind, "binary");
		assert.equal(entry.compact?.size_bytes, zipBytes.length);
		assert.equal(entry.compact?.digest_kind, "sha256");
		assert.equal(entry.compact?.digest_matches_after, true);
		assert.equal(entry.compact?.head_bytes, 0);
		assert.equal(entry.compact?.tail_bytes, 0);
		assert.match(entry.text, /binary bytes are not decoded or paged as UTF-8/u);
		assert.doesNotMatch(entry.text, /�/u, "binary bytes never enter the text presentation");
		const opaque = entries.get(opaquePath)!;
		assert.equal(opaque.source, "compact", "bounded byte inspection detects binary content without a known extension");
		assert.equal(opaque.compact?.content_kind, "binary");
		assert.equal(opaque.compact?.size_bytes, opaqueBytes.length);
		const large = entries.get(largePath)!;
		assert.equal(large.source, "compact");
		assert.equal(large.compact?.content_kind, "binary");
		assert.equal(large.compact?.size_bytes, largeBytes.length);
		assert.equal(large.compact?.digest_kind, "sha256", "guard-v2 keeps the full streaming digest beyond the legacy 4 MiB display threshold");
		assert.equal(large.compact?.digest_matches_after, true);
		const text = entries.get(textPath)!;
		assert.equal(text.source, "file-content", "a valid UTF-8 scalar split at the bounded head window is not misclassified as binary");
		assert.equal(text.compact, undefined);
		assert.equal(presented.review.record.presentation_complete, true);
		const accepted = await acceptPresentedReview(fixture, presented.review.record.bound_diff_hash, 5);
		assert.equal(accepted.ok, true, accepted.ok ? "" : JSON.stringify(accepted.error));
		if (accepted.ok) assert.equal(accepted.transaction.status, "REVIEWED");
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: a pre-upgrade binary paging envelope can migrate in place to compact evidence and publish REPAIR", async () => {
	const path = "src/legacy-authority.zip";
	const zipBytes = Buffer.concat([
		Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x00]),
		Buffer.alloc(4_096, 0x93),
	]);
	const fixture = await setupReviewFixture(
		[path], undefined, [path], false, false, () => zipBytes, undefined, [path],
	);
	try {
		await replaceCommittedEnvelopeWithLegacyBinaryPaging(fixture, path, true);
		const strict = await readDelegationCommittedGenerationV2(fixture.root, ID);
		assert.equal(strict.ok, true, strict.ok ? "" : JSON.stringify(strict.error));

		const presented = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: [path], now: at(4),
		});
		assert.equal(presented.ok, true, presented.ok ? "" : JSON.stringify(presented.error));
		if (!presented.ok || presented.review.record === undefined) return;
		assert.equal(presented.review.record.patch[0]?.source, "compact");
		assert.equal(presented.review.record.patch[0]?.compact?.content_kind, "binary");
		assert.equal(presented.review.record.presentation_complete, true);
		const refused = await repairPresentedReview(
			fixture,
			presented.review.record.bound_diff_hash,
			"This must remain blocked because the legacy envelope stream hash does not match current bytes.",
			5,
		);
		assert.equal(refused.ok, false, "legacy compatibility never accepts a merely well-formed but non-reproducible envelope");
		if (!refused.ok) assert.equal(refused.error.code, "review_invalid");

		await replaceCommittedEnvelopeWithLegacyBinaryPaging(fixture, path);
		const recovered = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: [path], now: at(6),
		});
		assert.equal(recovered.ok, true, recovered.ok ? "" : JSON.stringify(recovered.error));
		if (!recovered.ok || recovered.review.record === undefined) return;

		const repaired = await repairPresentedReview(
			fixture,
			recovered.review.record.bound_diff_hash,
			"Rebuild the sealed ZIP from the corrected authority inputs and re-run its independent artifact checks.",
			7,
		);
		assert.equal(repaired.ok, true, repaired.ok ? "" : JSON.stringify(repaired.error));
		if (repaired.ok) assert.equal(repaired.semantic_authority, "repair_required");
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: a 14 KiB ordinary source file advances contiguous hash-bound pages and then accepts", async () => {
	const source = Array.from({ length: 357 }, (_, index) =>
		`def test_page_${String(index).padStart(3, "0")}(): assert ${index} >= 0  # page`,
	).join("\n") + "\n";
	assert.ok(Buffer.byteLength(source, "utf8") > 14_000);
	const fixture = await setupReviewFixture(
		["src/large.py"],
		undefined,
		["src/large.py"],
		false,
		false,
		() => source,
	);
	try {
		const first = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec,
			includePaths: ["src/large.py"], maxBytes: 32_000, maxLines: 398, now: at(4),
		});
		assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
		if (!first.ok || first.review.record === undefined) return;
		const firstEntry = first.review.record.patch[0]!;
		assert.equal(firstEntry.source, "git-diff");
		assert.ok(firstEntry.page, "the first bounded page carries its exact byte range");
		assert.equal(firstEntry.page?.start_byte, 0);
		assert.ok((firstEntry.page?.end_byte ?? 0) < (firstEntry.page?.total_bytes ?? 0));
		assert.equal(first.review.record.presentation_complete, false);
		assert.deepEqual(first.review.record.presentation_remaining_paths, ["src/large.py"]);
		assert.equal(first.review.record.presentation_progress?.[0]?.next_byte, firstEntry.page?.end_byte);

		const second = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec,
			includePaths: ["src/large.py"], maxBytes: 32_000, maxLines: 398, now: at(5),
		});
		assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.error));
		if (!second.ok || second.review.record === undefined) return;
		const secondEntry = second.review.record.patch[0]!;
		assert.ok(secondEntry.page);
		assert.equal(secondEntry.page?.start_byte, firstEntry.page?.end_byte, "the second page resumes without a gap or overlap");
		assert.equal(secondEntry.page?.end_byte, secondEntry.page?.total_bytes);
		assert.equal(second.review.record.presentation_complete, true);
		assert.deepEqual(second.review.record.presentation_remaining_paths, []);
		assert.equal(second.review.record.presentation_progress?.[0]?.next_byte, secondEntry.page?.total_bytes);
		const expectedDiff = await spawnExec("git", ["diff", "--", "src/large.py"], { cwd: fixture.root });
		assert.equal(expectedDiff.code, 0, expectedDiff.stderr);
		const reconstructed = `${firstEntry.text}${secondEntry.text}`;
		assert.equal(createHash("sha256").update(reconstructed, "utf8").digest("hex"), firstEntry.page?.stream_sha256);
		assert.equal(reconstructed, expectedDiff.stdout, "the visible pages reconstruct the complete redacted diff stream exactly");

		const accepted = await acceptPresentedReview(fixture, second.review.record.bound_diff_hash, 6);
		assert.equal(accepted.ok, true, accepted.ok ? "" : JSON.stringify(accepted.error));
		if (accepted.ok) {
			assert.equal(accepted.finalized, true);
			assert.equal(accepted.transaction.status, "REVIEWED");
			assert.equal(accepted.review.record?.semantic_review, "accepted");
		}
		const artifact = JSON.parse(await readFile(reviewPath(fixture.root), "utf8")) as Record<string, any>;
		artifact.review.presentation_progress[0].next_byte -= 1;
		const tamperedBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
		await writeFile(reviewPath(fixture.root), tamperedBytes);
		const transaction = JSON.parse(await readFile(transactionPath(fixture.root), "utf8")) as Record<string, any>;
		transaction.review.review_hash = createHash("sha256").update(tamperedBytes).digest("hex");
		await writeFile(transactionPath(fixture.root), `${JSON.stringify(transaction, null, 2)}\n`);
		const tampered = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(tampered.ok, false, "a cursor that no longer reaches the accepted complete stream fails strict read");
		if (!tampered.ok) assert.equal(tampered.error.code, "invalid_record");
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: provisional presentation fields cannot forge page completion or bypass Sol review", async () => {
	const source = Array.from({ length: 357 }, (_, index) =>
		`def test_guard_${String(index).padStart(3, "0")}(): assert ${index} >= 0  # guard`,
	).join("\n") + "\n";
	const fixture = await setupReviewFixture(
		["src/large.py"], undefined, ["src/large.py"], false, false, () => source,
	);
	try {
		const first = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec,
			includePaths: ["src/large.py"], maxBytes: 32_000, maxLines: 398, now: at(4),
		});
		assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
		if (!first.ok || first.review.record === undefined) return;
		const original = JSON.parse(await readFile(reviewPath(fixture.root), "utf8")) as Record<string, any>;

		// Compatibility keeps an old schema-2 provisional record readable, but
		// bare coverage flags and a truncated ordinary entry never satisfy the
		// semantic ACCEPT predicate. A fresh no-decision call rebuilds proof.
		const bare = structuredClone(original);
		delete bare.review.presentation_progress;
		for (const entry of bare.review.patch) delete entry.page;
		bare.review.fully_presented_paths = ["src/large.py"];
		bare.review.presentation_remaining_paths = [];
		bare.review.presentation_complete = true;
		await writeFile(reviewPath(fixture.root), `${JSON.stringify(bare, null, 2)}\n`);
		const readableCompatibility = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(readableCompatibility.ok, true, readableCompatibility.ok ? "" : JSON.stringify(readableCompatibility.error));
		const refused = await acceptPresentedReview(fixture, first.review.record.bound_diff_hash, 5);
		assert.equal(refused.ok, false, "bare fully-presented fields cannot authorize semantic ACCEPT");
		if (!refused.ok) assert.equal(refused.error.code, "review_invalid");
		const selfAccepted = structuredClone(bare);
		selfAccepted.review.semantic_review = "accepted";
		selfAccepted.review.semantic_acceptance = {
			decision: "ACCEPT",
			expected_bound_diff_hash: first.review.record.bound_diff_hash,
			reviewer: SOL_REVIEWER,
			accepted_at: selfAccepted.review.reviewed_at,
		};
		await writeFile(reviewPath(fixture.root), `${JSON.stringify(selfAccepted, null, 2)}\n`);
		const provisionalAccepted = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(provisionalAccepted.ok, true, provisionalAccepted.ok ? "" : JSON.stringify(provisionalAccepted.error));
		if (provisionalAccepted.ok) assert.equal(hasDelegationSemanticReviewAuthorityV2(provisionalAccepted.value), false,
			"a PENDING transaction never gains authority from a self-asserted accepted review file");
		const refusedSelfAcceptance = await acceptPresentedReview(fixture, first.review.record.bound_diff_hash, 5);
		assert.equal(refusedSelfAcceptance.ok, false);
		if (!refusedSelfAcceptance.ok) assert.equal(refusedSelfAcceptance.error.code, "review_invalid");
		const rebuilt = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec,
			includePaths: ["src/large.py"], maxBytes: 32_000, maxLines: 398, now: at(6),
		});
		assert.equal(rebuilt.ok, true, rebuilt.ok ? "" : JSON.stringify(rebuilt.error));
		if (rebuilt.ok) {
			assert.ok(rebuilt.review.record?.presentation_progress?.length);
			assert.equal(rebuilt.review.record?.presentation_complete, false, "forged legacy completeness is discarded");
		}

		const pageWithoutProgress = structuredClone(original);
		delete pageWithoutProgress.review.presentation_progress;
		await writeFile(reviewPath(fixture.root), `${JSON.stringify(pageWithoutProgress, null, 2)}\n`);
		const missingProgress = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(missingProgress.ok, false, "a page always requires its durable cursor");
		if (!missingProgress.ok) assert.equal(missingProgress.error.code, "invalid_record");

		const forgedLength = structuredClone(original);
		const forgedPage = forgedLength.review.patch[0].page;
		forgedPage.end_byte = forgedPage.total_bytes;
		forgedLength.review.presentation_progress[0].next_byte = forgedPage.total_bytes;
		forgedLength.review.fully_presented_paths = ["src/large.py"];
		forgedLength.review.presentation_remaining_paths = [];
		forgedLength.review.presentation_complete = true;
		await writeFile(reviewPath(fixture.root), `${JSON.stringify(forgedLength, null, 2)}\n`);
		const mismatchedLength = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(mismatchedLength.ok, false, "declared page bytes must equal the visible UTF-8 body bytes");
		if (!mismatchedLength.ok) assert.equal(mismatchedLength.error.code, "invalid_record");

		// A structurally valid O(paths) accumulator still cannot jump to a real
		// tail: ACCEPT rebuilds the authoritative [0,next_byte) prefix receipt,
		// so even an exact visible tail cannot replace all preceding pages.
		const forgedTail = structuredClone(original);
		const tailEntry = forgedTail.review.patch[0];
		const tailPage = tailEntry.page;
		const visibleBytes = Buffer.byteLength(tailEntry.text, "utf8");
		const tailStart = tailPage.total_bytes - visibleBytes;
		const expectedDiff = await spawnExec("git", ["diff", "--", "src/large.py"], { cwd: fixture.root });
		assert.equal(expectedDiff.code, 0, expectedDiff.stderr);
		tailEntry.text = Buffer.from(expectedDiff.stdout, "utf8").subarray(tailStart).toString("utf8");
		tailPage.start_byte = tailStart;
		tailPage.end_byte = tailPage.total_bytes;
		tailEntry.truncated = true;
		forgedTail.review.presentation_progress[0].next_byte = tailPage.total_bytes;
		forgedTail.review.presentation_progress[0].segments = [
			{ start_byte: tailStart, end_byte: tailPage.total_bytes, page_sha256: createHash("sha256").update(tailEntry.text, "utf8").digest("hex") },
		];
		forgedTail.review.presentation_progress[0].page_count = 2;
		forgedTail.review.presentation_progress[0].receipt_sha256 = "f".repeat(64);
		forgedTail.review.fully_presented_paths = ["src/large.py"];
		forgedTail.review.presentation_remaining_paths = [];
		forgedTail.review.presentation_complete = true;
		await writeFile(reviewPath(fixture.root), `${JSON.stringify(forgedTail, null, 2)}\n`);
		const structurallyReadableTail = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(structurallyReadableTail.ok, true, structurallyReadableTail.ok ? "" : JSON.stringify(structurallyReadableTail.error));
		const refusedTail = await acceptPresentedReview(fixture, first.review.record.bound_diff_hash, 7);
		assert.equal(refusedTail.ok, false, "actual-source validation rejects a fabricated contiguous tail chain");
		if (!refusedTail.ok) assert.equal(refusedTail.error.code, "review_invalid");

		const oversized = structuredClone(original);
		oversized.review.patch[0].page.total_bytes = REVIEW_PAGE_SOURCE_MAX_BYTES + 1;
		oversized.review.presentation_progress[0].total_bytes = REVIEW_PAGE_SOURCE_MAX_BYTES + 1;
		await writeFile(reviewPath(fixture.root), `${JSON.stringify(oversized, null, 2)}\n`);
		const aboveCeiling = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(aboveCeiling.ok, false, "page streams above the fixed ceiling fail closed");
		if (!aboveCeiling.ok) assert.equal(aboveCeiling.error.code, "invalid_record");
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: strict schema2 read rejects canonical role, set, hash, identity, and schema tampering", async () => {
	const variants: Array<(artifact: Record<string, any>) => void> = [
		(artifact) => { artifact.review.schema_version = 3; },
		(artifact) => { artifact.review.relevance_projection.entries[0].roles = ["D"]; },
		(artifact) => { artifact.review.relevance_projection.entries[0].path = "src/other.ts"; },
		(artifact) => { artifact.review.relevance_binding.projection_hash = "f".repeat(64); },
		(artifact) => { artifact.review.relevance_projection.entries[0].full_identity.sha256 = "e".repeat(64); },
		(artifact) => { artifact.review.semantic_review = "required"; },
		(artifact) => { artifact.review.semantic_acceptance.expected_bound_diff_hash = "f".repeat(64); },
		(artifact) => { artifact.review.semantic_acceptance.reviewer.model = "gpt-5.6-luna"; },
		(artifact) => { artifact.review.semantic_acceptance.accepted_at = at(59); },
		(artifact) => { delete artifact.review.semantic_acceptance; },
	];
	for (const mutate of variants) {
		const fixture = await setupReviewFixture();
		try {
			await presentAndAcceptReview(fixture);
			const artifact = JSON.parse(await readFile(reviewPath(fixture.root), "utf8")) as Record<string, any>;
			mutate(artifact);
			const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
			await writeFile(reviewPath(fixture.root), bytes);
			const transaction = JSON.parse(await readFile(transactionPath(fixture.root), "utf8")) as Record<string, any>;
			transaction.review.review_hash = createHash("sha256").update(bytes).digest("hex");
			await writeFile(transactionPath(fixture.root), `${JSON.stringify(transaction, null, 2)}\n`);
			const strict = await readDelegationReviewV2(fixture.root, ID);
			assert.equal(strict.ok, false);
			if (!strict.ok) assert.equal(strict.error.code, "invalid_record");
		} finally {
			await cleanup(fixture);
		}
	}
});

test("review v2: historical untagged schema1 authority is full-diff replay-only and never rewritten", async () => {
	const fixture = await setupReviewFixture();
	try {
		await presentAndAcceptReview(fixture);
		const current = await collectGitFacts(fixture.root, spawnExec);
		const legacyHash = computeDiffHash(current.changedPaths, current.pathDigests, current.pathStatuses);

		const beforePath = generationPath(fixture.root, "before.json");
		const afterPath = generationPath(fixture.root, "after.json");
		const before = JSON.parse(await readFile(beforePath, "utf8")) as Record<string, any>;
		const after = JSON.parse(await readFile(afterPath, "utf8")) as Record<string, any>;
		delete before.diff_identity_kind;
		before.path_digests = {};
		before.diff_hash = computeDiffHash(before.changed_paths, before.path_digests, before.path_statuses);
		delete after.diff_identity_kind;
		delete after.review_envelope;
		after.path_digests = { ...current.pathDigests };
		after.diff_hash = legacyHash;
		await writeFile(beforePath, `${JSON.stringify(before, null, 2)}\n`);
		await writeFile(afterPath, `${JSON.stringify(after, null, 2)}\n`);

		const compiled = new Map<any, Uint8Array>();
		for (const name of COMMITTED_RECORD_NAMES) {
			compiled.set(name, await readFile(generationPath(fixture.root, name)));
		}
		const transaction = JSON.parse(await readFile(transactionPath(fixture.root), "utf8")) as Record<string, any>;
		const { commit_marker: _oldMarker, ...proofWithoutMarker } = transaction.committed_proof;
		proofWithoutMarker.content_hash = hashDelegationCommittedRecords(compiled);
		transaction.committed_proof = {
			...proofWithoutMarker,
			commit_marker: delegationCommitMarker(proofWithoutMarker),
		};
		await writeFile(generationPath(fixture.root, "commit-marker.json"), `${JSON.stringify(transaction.committed_proof, null, 2)}\n`);

		const artifact = JSON.parse(await readFile(reviewPath(fixture.root), "utf8")) as Record<string, any>;
		artifact.review.schema_version = 1;
		delete artifact.review.diff_identity_kind;
		delete artifact.review.relevance_binding;
		delete artifact.review.relevance_projection;
		delete artifact.review.review_envelope;
		delete artifact.review.fully_presented_paths;
		delete artifact.review.presentation_remaining_paths;
		delete artifact.review.presentation_complete;
		delete artifact.review.presentation_progress;
		for (const entry of artifact.review.patch ?? []) delete entry.page;
		delete artifact.review.semantic_review;
		delete artifact.review.semantic_acceptance;
		artifact.review.bound_diff_hash = legacyHash;
		artifact.review.recorded_after_hash = legacyHash;
		artifact.review.mismatch = false;
		const legacyReviewBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
		await writeFile(reviewPath(fixture.root), legacyReviewBytes);
		transaction.review.review_hash = createHash("sha256").update(legacyReviewBytes).digest("hex");
		await writeFile(transactionPath(fixture.root), `${JSON.stringify(transaction, null, 2)}\n`);

		const strictGeneration = await readDelegationCommittedGenerationV2(fixture.root, ID);
		assert.equal(strictGeneration.ok, true, strictGeneration.ok ? "" : JSON.stringify(strictGeneration.error));
		const strictReview = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(strictReview.ok, true, strictReview.ok ? "" : JSON.stringify(strictReview.error));
		if (strictReview.ok) assert.equal(strictReview.value.review.schema_version, 1);
		const replay = await reviewDelegationV2({ projectRoot: fixture.root, delegationId: ID, exec: spawnExec, now: at(5) });
		assert.equal(replay.ok, true, replay.ok ? "" : JSON.stringify(replay.error));
		if (replay.ok) assert.equal(replay.review.record?.schema_version, 1);
		const reconciled = await reconcileProjectDelegationAuthorityV2({
			project_root: fixture.root,
			current_state: {
				latestId: ID,
				status: "REVIEWED",
				currentDiffHash: legacyHash,
				reviewedDiffHash: legacyHash,
				blockedWriteAttempts: 0,
				updatedAt: at(5),
			},
			now: at(6),
			exec: spawnExec,
		});
		assert.equal(reconciled.ok, true, reconciled.ok ? "" : JSON.stringify(reconciled.issue));
		if (reconciled.ok) {
			assert.equal(reconciled.state?.status, "PENDING_REVIEW", "historical non-zero mechanical REVIEWED cannot survive reconciliation");
			assert.equal(reconciled.state?.reviewedDiffHash, undefined);
		}
		const upgradeRefused = await acceptPresentedReview(fixture, legacyHash, 6);
		assert.equal(upgradeRefused.ok, false);
		if (!upgradeRefused.ok) assert.equal(upgradeRefused.error.code, "authority_invalid");
		assert.deepEqual(await readFile(reviewPath(fixture.root)), legacyReviewBytes);
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: realpath scope failure precedes identity capture and publishes no review", async () => {
	const fixture = await setupReviewFixture();
	try {
		const outside = join(fixture.root, "outside.ts");
		await writeFile(outside, "outside\n");
		await unlink(join(fixture.root, "src/a.ts"));
		await symlink(outside, join(fixture.root, "src/a.ts"));
		let execCalls = 0;
		const forbiddenExec: typeof spawnExec = async () => {
			execCalls += 1;
			throw new Error("scope preflight must precede relevance and patch collection");
		};
		const result = await reviewDelegationV2({ projectRoot: fixture.root, delegationId: ID, exec: forbiddenExec, now: at(4) });
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.code, "review_invalid");
		assert.equal(execCalls, 0);
		const strict = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(strict.ok, false);
		if (!strict.ok) assert.equal(strict.error.code, "not_found");
		const state = await readDelegationTransactionV2(fixture.root, ID);
		assert.equal(state.ok, true);
		if (state.ok) assert.equal(state.value.status, "PENDING_REVIEW");
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: segmented relevance ignores baseline and artifact drift and replays exact finalized bytes", async () => {
	const fixture = await setupReviewFixture(["src/a.ts", "src/b.ts"], "src/pre-dirty.ts");
	try {
		const first = await reviewDelegationV2({ projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: ["src/a.ts"], now: at(4) });
		assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
		if (!first.ok) return;
		assert.equal(first.finalized, false);
		assert.equal(first.transaction.status, "PENDING_REVIEW");
		assert.equal(first.review.record?.coverage_complete, false);
		const provisional = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(provisional.ok, true);
		if (provisional.ok) assert.equal(provisional.value.finalized, false);
		await writeFile(join(fixture.root, "src/pre-dirty.ts"), "between-segments\n");
		await writeFile(join(fixture.root, "src/pre-dirty.ts"), "pre-dirty\n");
		const second = await reviewDelegationV2({ projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: ["src/b.ts"], now: at(5) });
		assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.error));
		if (second.ok) {
			assert.equal(second.finalized, false);
			assert.equal(second.review.record?.coverage_complete, true);
			assert.equal(second.review.record?.presentation_complete, true);
			assert.equal(second.transaction.status, "PENDING_REVIEW");
			assert.equal(second.review.record?.bound_diff_hash, first.review.record?.bound_diff_hash);
		}
		const accepted = await acceptPresentedReview(fixture, second.ok ? second.review.record!.bound_diff_hash : "", 6);
		assert.equal(accepted.ok, true, accepted.ok ? "" : JSON.stringify(accepted.error));
		const finalizedBytes = await readFile(reviewPath(fixture.root));
		await writeFile(join(fixture.root, "src/pre-dirty.ts"), "after-finalized\n");
		const artifactPath = join(fixture.root, CONFIG_DIR_NAME, "workbench", "runs", "review-relevance", "report.json");
		await mkdir(dirname(artifactPath), { recursive: true });
		await writeFile(artifactPath, "{}\n");
		const replay = await reviewDelegationV2({ projectRoot: fixture.root, delegationId: ID, exec: spawnExec, now: at(7) });
		assert.equal(replay.ok, true, replay.ok ? "" : JSON.stringify(replay.error));
		if (replay.ok) {
			assert.equal(replay.finalized, true);
			assert.equal(replay.review.record?.bound_diff_hash, accepted.ok ? accepted.review.record?.bound_diff_hash : undefined);
		}
		assert.deepEqual(await readFile(reviewPath(fixture.root)), finalizedBytes);
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: Unicode byte-canonical worker paths survive segmented finalization and strict read", async () => {
	const byteFirst = "src/\uE000.ts";
	const byteSecond = "src/😀.ts";
	const workerPaths = [byteFirst, byteSecond];
	assert.ok(Buffer.from(byteFirst).compare(Buffer.from(byteSecond)) < 0);
	assert.ok(byteFirst > byteSecond, "fixture must distinguish UTF-8 byte order from JavaScript default order");
	const fixture = await setupReviewFixture(workerPaths);
	try {
		const first = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: [byteSecond], now: at(4),
		});
		assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
		if (!first.ok) return;
		assert.equal(first.finalized, false);
		assert.deepEqual(first.review.record?.checked_paths, workerPaths);
		assert.deepEqual(first.review.record?.displayed_paths, [byteSecond]);
		assert.deepEqual(first.review.record?.remaining_paths, [byteFirst]);
		const provisional = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(provisional.ok, true, provisional.ok ? "" : JSON.stringify(provisional.error));

		const second = await reviewDelegationV2({
			projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: [byteFirst], now: at(5),
		});
		assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.error));
		if (!second.ok) return;
		assert.equal(second.finalized, false);
		assert.deepEqual(second.review.record?.checked_paths, workerPaths);
		assert.deepEqual(second.review.record?.displayed_paths, workerPaths);
		assert.deepEqual(second.review.record?.remaining_paths, []);
		assert.deepEqual(second.review.record?.fully_presented_paths, workerPaths);
		const accepted = await acceptPresentedReview(fixture, second.review.record!.bound_diff_hash, 6);
		assert.equal(accepted.ok, true, accepted.ok ? "" : JSON.stringify(accepted.error));
		const strict = await readDelegationReviewV2(fixture.root, ID);
		assert.equal(strict.ok, true, strict.ok ? "" : JSON.stringify(strict.error));
		if (strict.ok) {
			assert.equal(strict.value.finalized, true);
			assert.deepEqual(strict.value.review.checked_paths, workerPaths);
			assert.deepEqual(strict.value.review.displayed_paths, workerPaths);
		}
	} finally {
		await cleanup(fixture);
	}
});

test("review v2: committed-record tamper and unsafe mutable review paths fail closed", async () => {
	const fixture = await setupReviewFixture();
	try {
		await writeFile(generationPath(fixture.root, "after.json"), "{}\n");
		const generation = await readDelegationCommittedGenerationV2(fixture.root, ID);
		assert.equal(generation.ok, false);
		const refused = await reviewDelegationV2({ projectRoot: fixture.root, delegationId: ID, exec: spawnExec, now: at(4) });
		assert.equal(refused.ok, false);
		if (!refused.ok) assert.equal(refused.error.code, "authority_invalid");
	} finally {
		await cleanup(fixture);
	}

	const symlinkFixture = await setupReviewFixture();
	try {
		await writeFile(join(symlinkFixture.root, "foreign-review.json"), "{}\n");
		await symlink(join(symlinkFixture.root, "foreign-review.json"), reviewPath(symlinkFixture.root));
		const refused = await reviewDelegationV2({ projectRoot: symlinkFixture.root, delegationId: ID, exec: spawnExec, now: at(4) });
		assert.equal(refused.ok, false);
		const state = await readDelegationTransactionV2(symlinkFixture.root, ID);
		assert.equal(state.ok, true);
		if (state.ok) assert.equal(state.value.status, "PENDING_REVIEW");
	} finally {
		await cleanup(symlinkFixture);
	}
});

test("review v2: wrong id, foreign identity state, unknown state, and truncated provisional review fail closed", async () => {
	const fixture = await setupReviewFixture(["src/a.ts", "src/b.ts"]);
	try {
		const wrongId = await reviewDelegationV2({ projectRoot: fixture.root, delegationId: "20260817-170001-nope", exec: spawnExec, now: at(4) });
		assert.equal(wrongId.ok, false);
		const first = await reviewDelegationV2({ projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: ["src/a.ts"], now: at(4) });
		assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
		await writeFile(reviewPath(fixture.root), "{\n");
		const truncated = await reviewDelegationV2({ projectRoot: fixture.root, delegationId: ID, exec: spawnExec, includePaths: ["src/b.ts"], now: at(5) });
		assert.equal(truncated.ok, false);
		if (!truncated.ok) assert.equal(truncated.error.code, "authority_invalid");
		const durable = await readDelegationTransactionV2(fixture.root, ID);
		assert.equal(durable.ok, true);
		if (durable.ok) assert.equal(durable.value.status, "PENDING_REVIEW");
	} finally {
		await cleanup(fixture);
	}

	for (const mutate of [
		(state: Record<string, unknown>) => {
			((state.worker_identity as Record<string, unknown>)).worker_id = "foreign-worker";
		},
		(state: Record<string, unknown>) => { state.status = "UNKNOWN_REVIEW_STATE"; },
	]) {
		const corrupted = await setupReviewFixture();
		try {
			const state = JSON.parse(await readFile(transactionPath(corrupted.root), "utf8")) as Record<string, unknown>;
			mutate(state);
			await writeFile(transactionPath(corrupted.root), `${JSON.stringify(state, null, 2)}\n`);
			const refused = await reviewDelegationV2({ projectRoot: corrupted.root, delegationId: ID, exec: spawnExec, now: at(4) });
			assert.equal(refused.ok, false);
			assert.equal(await readFile(reviewPath(corrupted.root)).catch(() => null), null);
		} finally {
			await cleanup(corrupted);
		}
	}
});

test("review v2: every review fault point fails without strict-readable REVIEWED authority", async () => {
	for (const point of DELEGATION_REVIEW_STORAGE_FAULT_POINTS) {
		const fixture = await setupReviewFixture();
		try {
			const presented = await reviewDelegationV2({ projectRoot: fixture.root, delegationId: ID, exec: spawnExec, now: at(4) });
			assert.equal(presented.ok, true, presented.ok ? "" : JSON.stringify(presented.error));
			if (!presented.ok || presented.review.record === undefined) continue;
			let tripped = false;
			const adapter = createNodeDelegationTransactionStorageAdapter((actual, bytes) => {
				if (actual !== point || tripped) return bytes === undefined ? undefined : Uint8Array.from(bytes);
				tripped = true;
				if (actual.endsWith(".read") && bytes !== undefined) return Buffer.from("{", "utf8");
				throw new Error(`injected ${actual}`);
			});
			const result = await acceptPresentedReview(fixture, presented.review.record.bound_diff_hash, 5, { adapter });
			assert.equal(tripped, true, point);
			assert.equal(result.ok, false, point);
			const state = await readDelegationTransactionV2(fixture.root, ID);
			assert.equal(state.ok, true);
			if (state.ok) assert.equal(state.value.status, "PENDING_REVIEW", point);
			const strict = await readDelegationCommittedGenerationV2(fixture.root, ID);
			assert.equal(strict.ok, true, `${point}: PENDING generation remains readable but never REVIEWED`);
			if (point.startsWith("review_state.")) {
				const provisional = await readDelegationReviewV2(fixture.root, ID);
				assert.equal(provisional.ok, true, `${point}: renamed review remains diagnosable provisional evidence`);
				if (provisional.ok) assert.equal(provisional.value.finalized, false);
			}
		} finally {
			await cleanup(fixture);
		}
	}
});

test("review v2: missing or tampered final review invalidates strict REVIEWED reads", async () => {
	for (const mode of ["missing", "tampered"] as const) {
		const fixture = await setupReviewFixture();
		try {
			await presentAndAcceptReview(fixture);
			if (mode === "missing") await unlink(reviewPath(fixture.root));
			else await writeFile(reviewPath(fixture.root), "{}\n");
			const strict = await readDelegationCommittedGenerationV2(fixture.root, ID);
			assert.equal(strict.ok, false);
			if (!strict.ok) assert.equal(strict.error.code, "invalid_record");
			const state = await readDelegationTransactionV2(fixture.root, ID);
			assert.equal(state.ok, true);
			if (state.ok) assert.equal(state.value.status, "REVIEWED", "state remains diagnostic but lacks valid authority");
		} finally {
			await cleanup(fixture);
		}
	}
});
