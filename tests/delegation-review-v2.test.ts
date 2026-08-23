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
): Promise<ReviewFixture> {
	const root = await mkdtemp(join(tmpdir(), "delegation-review-v2-"));
	await git(root, ["init"]);
	await git(root, ["config", "user.email", "review-v2@example.invalid"]);
	await git(root, ["config", "user.name", "Review V2 Test"]);
	for (const path of paths) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), `baseline:${path}\n`);
	}
	await git(root, ["add", "--", ...paths]);
	await git(root, ["commit", "-m", "baseline"]);
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
	const report = `## Completed\n- changed fixture files\n## Files Changed\n${workerPaths.map((path) => `- ${path}`).join("\n")}\n## Verification\n- facts\n## Remaining Risks\n- none\n`;
	const built = buildDelegationCommittedArtifactsV2({
		transaction: committing.value, contract: contract.value, before: workspace.value.before, after: workspace.value.after,
		changeSetLifecycle: lifecycle.value, worker: workerFacts(report, withExtendedReason ? "extended" : "standard"), reportText: report,
	});
	assert.equal(built.ok, true);
	if (!built.ok) throw new Error("artifact build failed");
	const records = built.value.records;
	const committed = await commitDelegationGeneration(root, { ...cas(committing.value, 3), records });
	assert.equal(committed.ok, true);
	if (!committed.ok) throw new Error("generation commit failed");
	return { root, state: committed.value, records };
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
		delete artifact.review.fully_presented_paths;
		delete artifact.review.presentation_remaining_paths;
		delete artifact.review.presentation_complete;
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
