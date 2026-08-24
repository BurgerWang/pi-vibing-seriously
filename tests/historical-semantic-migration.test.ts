import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { ReviewRecord } from "../extensions/workbench-runtime/core/diff-review.ts";
import {
	collectHistoricalSemanticMigration,
	HISTORICAL_SEMANTIC_MIGRATION_KIND,
} from "../extensions/workbench-runtime/core/historical-semantic-migration.ts";
import {
	computeReviewRelevanceProjectionHashV2,
	REVIEW_RELEVANCE_KIND_V2,
	type ReviewRelevanceProjectionV2,
} from "../extensions/workbench-runtime/core/review-relevance-v2.ts";
import { captureStreamingIdentities } from "../extensions/workbench-runtime/core/streaming-identity.ts";
import { collectWorkspaceGuard, type WorkspaceGuardRecord } from "../extensions/workbench-runtime/core/workspace-guard.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

const ID = "20260823-190000-hsm1";
const CONTRACT = "a".repeat(64);
const REVIEW_HASH = "b".repeat(64);
const W = "src/worker.ts";

interface MigrationFixture {
	root: string;
	oldHead: string;
	currentHead: string;
	afterGuard: WorkspaceGuardRecord;
	review: ReviewRecord;
}

async function git(root: string, args: string[]): Promise<string> {
	const result = await spawnExec("git", args, { cwd: root });
	assert.equal(result.killed, false, `git ${args.join(" ")} was killed`);
	assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

async function writeWorker(root: string, text: string): Promise<void> {
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, W), text, "utf8");
}

async function setupMigrationFixture(root: string, extraCommittedPath?: string): Promise<MigrationFixture> {
	await git(root, ["init", "-q"]);
	await git(root, ["config", "user.email", "migration@test.invalid"]);
	await git(root, ["config", "user.name", "migration-test"]);
	await writeFile(join(root, "seed.txt"), "shared ancestor\n", "utf8");
	await git(root, ["add", "--", "seed.txt"]);
	await git(root, ["commit", "-qm", "seed"]);
	await writeWorker(root, "before\n");
	await git(root, ["add", "--", W]);
	await git(root, ["commit", "-qm", "base"]);
	const oldHead = await git(root, ["rev-parse", "HEAD"]);

	await writeWorker(root, "reviewed worker bytes\n");
	const guardResult = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
	if (!guardResult.ok) throw new Error("historical migration fixture guard collection failed");
	const captured = await captureStreamingIdentities({ project_root: root, paths: [W] });
	if (!captured.ok) throw new Error("historical migration fixture identity capture failed");
	const workerIdentity = captured.identities[0]!;
	const status = guardResult.guard.entries.find((entry) => entry.path === W)?.status;
	assert.equal(typeof status, "string");
	const projection: ReviewRelevanceProjectionV2 = {
		schema_version: 2,
		diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
		delegation_id: ID,
		contract_hash: CONTRACT,
		change_set_hash: "c".repeat(64),
		worker_delta_hash: "d".repeat(64),
		git_head: oldHead,
		entries: [{ path: W, roles: ["W"], status: status!, full_identity: workerIdentity }],
	};
	const boundHash = computeReviewRelevanceProjectionHashV2(projection);
	const review: ReviewRecord = {
		schema_version: 2,
		delegation_id: ID,
		reviewed_at: "2026-08-23T12:00:00.000Z",
		verdict: "PASS",
		bound_diff_hash: boundHash,
		recorded_after_hash: boundHash,
		mismatch: false,
		drift_paths: [],
		violations: [],
		allowed_paths: ["src"],
		checked_paths: [W],
		include_paths: [],
		patch: [{ path: W, source: "git-diff", text: "reviewed worker bytes\n", truncated: false }],
		patch_truncated: false,
		patch_paths: [{ path: W, source: "git-diff", bytes: 22, truncated: false }],
		notes: [],
		displayed_paths: [W],
		remaining_paths: [],
		coverage_complete: true,
		review_path: `.pi/workbench/delegations/${ID}/v2/review.json`,
		diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
		relevance_binding: {
			schema_version: 2,
			diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
			projection_hash: boundHash,
		},
		relevance_projection: projection,
	};

	if (extraCommittedPath !== undefined) {
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, extraCommittedPath), "unreviewed\n", "utf8");
	}
	await git(root, ["add", "--", W, ...(extraCommittedPath === undefined ? [] : [extraCommittedPath])]);
	await git(root, ["commit", "-qm", "materialize reviewed bytes"]);
	const currentHead = await git(root, ["rev-parse", "HEAD"]);
	return { root, oldHead, currentHead, afterGuard: guardResult.guard, review };
}

async function collect(fixture: MigrationFixture) {
	return collectHistoricalSemanticMigration({
		projectRoot: fixture.root,
		delegationId: ID,
		contractHash: CONTRACT,
		baseReviewHash: REVIEW_HASH,
		review: fixture.review,
		afterGuard: fixture.afterGuard,
		exec: spawnExec,
	});
}

test("historical semantic migration accepts a W-only descendant that materializes the reviewed bytes", async () => {
	await withTempDir(async (root) => {
		const fixture = await setupMigrationFixture(root);
		const result = await collect(fixture);
		assert.equal(result.ok, true, result.ok ? "" : `${result.code}:${result.path ?? ""}`);
		if (!result.ok) return;
		assert.equal(result.projection.kind, HISTORICAL_SEMANTIC_MIGRATION_KIND);
		assert.equal(result.projection.old_git_head, fixture.oldHead);
		assert.equal(result.projection.candidate_git_head, fixture.currentHead);
		assert.deepEqual(result.projection.head_delta_paths, [W]);
		assert.match(result.projection.migration_binding_hash, /^[0-9a-f]{64}$/u);
		assert.notEqual(result.projection.migration_binding_hash, fixture.review.bound_diff_hash);

		const replay = await collect(fixture);
		assert.deepEqual(replay, result, "unchanged current facts produce one stable migration binding");
	});
});

test("historical semantic migration rejects any committed HEAD path outside W", async () => {
	await withTempDir(async (root) => {
		const extra = "src/unreviewed.ts";
		const fixture = await setupMigrationFixture(root, extra);
		const result = await collect(fixture);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "head_delta_out_of_scope");
			assert.equal(result.path, extra);
		}
	});
});

test("historical semantic migration requires the committed HEAD delta to cover every reviewed W path", async () => {
	await withTempDir(async (root) => {
		const fixture = await setupMigrationFixture(root);
		const missingWorkerPath = "src/z-unchanged.ts";
		const projection: ReviewRelevanceProjectionV2 = {
			...fixture.review.relevance_projection!,
			entries: [
				...fixture.review.relevance_projection!.entries,
				{
					path: missingWorkerPath,
					roles: ["W"],
					status: "CLEAN",
					full_identity: { schema_version: 2, kind: "missing", path: missingWorkerPath },
				},
			],
		};
		const boundHash = computeReviewRelevanceProjectionHashV2(projection);
		fixture.review = {
			...fixture.review,
			bound_diff_hash: boundHash,
			recorded_after_hash: boundHash,
			checked_paths: [W, missingWorkerPath],
			patch: [
				...fixture.review.patch,
				{ path: missingWorkerPath, source: "git-diff", text: "deleted worker path\n", truncated: false },
			],
			patch_paths: [
				...fixture.review.patch_paths,
				{ path: missingWorkerPath, source: "git-diff", bytes: 20, truncated: false },
			],
			displayed_paths: [W, missingWorkerPath],
			relevance_binding: {
				schema_version: 2,
				diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
				projection_hash: boundHash,
			},
			relevance_projection: projection,
		};
		const result = await collect(fixture);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "head_delta_invalid");
			assert.equal(result.path, missingWorkerPath);
		}
	});
});

test("historical semantic migration rejects current content drift even when HEAD is the accepted descendant", async () => {
	await withTempDir(async (root) => {
		const fixture = await setupMigrationFixture(root);
		const beforeDrift = await collect(fixture);
		assert.equal(beforeDrift.ok, true, "the migration binding must exist before byte drift");
		await writeWorker(root, "unreviewed current bytes\n");
		const result = await collect(fixture);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "worker_not_clean");
			assert.equal(result.path, W);
		}
	});
});

test("historical semantic migration rejects an uncommitted executable-mode change after the eligible descendant", async () => {
	await withTempDir(async (root) => {
		const fixture = await setupMigrationFixture(root);
		const beforeDrift = await collect(fixture);
		assert.equal(beforeDrift.ok, true, "the migration binding must exist before mode drift");
		await chmod(join(root, W), 0o755);
		const result = await collect(fixture);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "worker_not_clean");
			assert.equal(result.path, W);
		}
	});
});

test("historical semantic migration rejects a non-descendant candidate HEAD", async () => {
	await withTempDir(async (root) => {
		const fixture = await setupMigrationFixture(root);
		await git(root, ["checkout", "-q", "--detach", `${fixture.oldHead}^`]);
		await writeFile(join(root, "alternate.txt"), "alternate history\n", "utf8");
		await git(root, ["add", "--", "alternate.txt"]);
		await git(root, ["commit", "-qm", "alternate"]);
		const result = await collect(fixture);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "head_not_descendant");
	});
});

test("historical semantic migration rejects an executable-mode change hidden behind equal content", async () => {
	await withTempDir(async (root) => {
		const fixture = await setupMigrationFixture(root);
		await git(root, ["reset", "--hard", "-q", fixture.oldHead]);
		await writeWorker(root, "reviewed worker bytes\n");
		await chmod(join(root, W), 0o755);
		await git(root, ["add", "--", W]);
		await git(root, ["commit", "-qm", "materialize with unsafe mode change"]);
		const result = await collect(fixture);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "head_delta_invalid");
	});
});
