import assert from "node:assert/strict";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	collectFinalizationRepairRebaseAuthorityV1,
	collectTerminalRepairRebaseAuthorityV1,
} from "../extensions/workbench-runtime/core/delegation-repair-rebase.ts";
import {
	publishDelegationInactiveBlockerClosureV2,
	readDelegationInactiveBlockerRelevantScopeV2,
} from "../extensions/workbench-runtime/core/delegation-authority-closure.ts";
import { RETRYABLE_EMPTY_RECOVERY_REASONS_V2 } from "../extensions/workbench-runtime/core/delegation-execution-owner.ts";
import { bindDelegationRepairLineageV1 } from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import {
	persistPreparedDelegationTransaction,
	persistRecoveryRequiredDelegationTransaction,
	persistRunningDelegationTransaction,
	type DelegationCommittedGenerationV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	beginWriteJournalOperation,
	completeWriteJournalOperation,
	createWorkerWriteJournal,
	sealWorkerWriteJournal,
} from "../extensions/workbench-runtime/core/write-journal.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { collectWorkspaceGuard } from "../extensions/workbench-runtime/core/workspace-guard.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

const ID = "20260827-010203-rb01";

async function initialize(root: string): Promise<void> {
	assert.equal((await spawnExec("git", ["init", "-q"], { cwd: root })).code, 0);
	await writeFile(join(root, "README.md"), "base\n", "utf8");
	assert.equal((await spawnExec("git", ["add", "README.md"], { cwd: root })).code, 0);
	assert.equal((await spawnExec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], { cwd: root })).code, 0);
	await mkdir(join(root, "src"), { recursive: true });
}

function committed(
	guard: unknown,
	carriedPaths: readonly string[],
	allowedPaths: readonly string[] = ["src/**"],
): DelegationCommittedGenerationV2 {
	const lineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: "20260827-010100-root",
		repair_of: "20260827-010100-root",
		root_decision_hash: "d".repeat(64),
		continuation_decision_delegation_id: "20260827-010100-root",
		continuation_decision_hash: "d".repeat(64),
		parent_lineage_hash: null,
		depth: 1,
		carried_paths: [...carriedPaths],
	});
	assert.ok(lineage);
	return {
		state: {
			delegation_id: ID,
			status: "FAILED",
			contract_hash: "a".repeat(64),
			allowed_paths: [...allowedPaths],
			repair_lineage: lineage,
		},
		records: { "after.json": { workspace_guard: guard } },
		proof: { content_hash: "c".repeat(64) },
	} as unknown as DelegationCommittedGenerationV2;
}

async function finalizationRecovery(root: string, allowedPaths: readonly string[] = ["src/recovered.ts"]) {
	const lineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: "20260827-010100-root",
		repair_of: "20260827-010202-p001",
		root_decision_hash: "d".repeat(64),
		continuation_decision_delegation_id: "20260827-010100-root",
		continuation_decision_hash: "d".repeat(64),
		parent_lineage_hash: "e".repeat(64),
		depth: 12,
		carried_paths: ["src/recovered.ts"],
	});
	assert.ok(lineage);
	const contractHash = "a".repeat(64);
	const workerIdentity = {
		provider: WORKER_PROVIDER,
		model: WORKER_MODEL_ID,
		worker_id: `worker:${ID}`,
	} as const;
	const prepared = await persistPreparedDelegationTransaction(root, {
		delegation_id: ID,
		task_kind: "implementation",
		contract_hash: contractHash,
		allowed_paths: [...allowedPaths],
		worker_identity: workerIdentity,
		generation: 1,
		now: "2026-08-27T01:02:03.000Z",
		repair_lineage: lineage!,
	});
	assert.equal(prepared.ok, true);
	const journal = await createWorkerWriteJournal({ project_root: root, delegation_id: ID, contract_hash: contractHash });
	assert.equal(journal.ok, true);
	const running = await persistRunningDelegationTransaction(root, {
		delegation_id: ID,
		contract_hash: contractHash,
		worker_identity: workerIdentity,
		expected_generation: 1,
		expected_revision: 0,
		now: "2026-08-27T01:02:04.000Z",
	});
	assert.equal(running.ok, true);
	const begun = await beginWriteJournalOperation({
		project_root: root,
		delegation_id: ID,
		contract_hash: contractHash,
		expected_revision: 0,
		operation_id: "f".repeat(64),
		kind: "write",
		path: "src/recovered.ts",
	});
	assert.equal(begun.ok, true);
	if (!begun.ok) throw new Error("journal begin failed");
	await writeFile(join(root, "src", "recovered.ts"), "worker final\n", "utf8");
	const completed = await completeWriteJournalOperation({
		project_root: root,
		delegation_id: ID,
		contract_hash: contractHash,
		expected_revision: begun.value.revision,
		operation_id: "f".repeat(64),
		kind: "write",
		path: "src/recovered.ts",
		outcome: "succeeded",
	});
	assert.equal(completed.ok, true);
	if (!completed.ok) throw new Error("journal completion failed");
	const sealed = await sealWorkerWriteJournal({
		project_root: root,
		delegation_id: ID,
		contract_hash: contractHash,
		expected_revision: completed.value.revision,
	});
	assert.equal(sealed.ok, true);
	const recovery = await persistRecoveryRequiredDelegationTransaction(root, {
		delegation_id: ID,
		contract_hash: contractHash,
		worker_identity: workerIdentity,
		expected_generation: 1,
		expected_revision: 1,
		now: "2026-08-27T01:02:05.000Z",
		reason: RETRYABLE_EMPTY_RECOVERY_REASONS_V2.changeSetFinalizeFailed,
	});
	assert.equal(recovery.ok, true);
	if (!recovery.ok) throw new Error("recovery persistence failed");
	return recovery.value;
}

test("terminal repair rebase admits Git-visibility drift wholly inside the immutable lineage", async () => {
	await withTempDir(async (root) => {
		await initialize(root);
		await writeFile(join(root, "src", "visible.ts"), "visible\n", "utf8");
		await writeFile(join(root, "src", "later-ignored.ts"), "ignored later\n", "utf8");
		const sealed = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(sealed.ok, true);
		if (!sealed.ok) return;
		await writeFile(join(root, ".git", "info", "exclude"), "src/later-ignored.ts\n", "utf8");

		const result = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/later-ignored.ts", "src/visible.ts"]),
			exec: spawnExec,
		});
		assert.equal(result.ok, true, result.ok ? "" : result.code);
		if (!result.ok) return;
		assert.deepEqual(result.value.relevant_paths, ["src/visible.ts"]);
		assert.match(result.value.rebase_hash, /^[0-9a-f]{64}$/u);

		const replay = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/later-ignored.ts", "src/visible.ts"]),
			exec: spawnExec,
		});
		assert.equal(replay.ok, true);
		if (replay.ok) assert.equal(replay.value.rebase_hash, result.value.rebase_hash, "unchanged snapshot is idempotent");
	});
});

test("terminal repair rebase rejects clean, out-of-lineage and changed-HEAD workspaces", async () => {
	await withTempDir(async (root) => {
		await initialize(root);
		await writeFile(join(root, "src", "carried.ts"), "carried\n", "utf8");
		const sealed = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(sealed.ok, true);
		if (!sealed.ok) return;
		const authority = committed(sealed.guard, ["src/carried.ts"]);

		await writeFile(join(root, "src", "outside.ts"), "outside\n", "utf8");
		const outside = await collectTerminalRepairRebaseAuthorityV1({ projectRoot: root, committed: authority, exec: spawnExec });
		assert.deepEqual(outside, { ok: false, code: "path_outside_lineage", path: "src/outside.ts" });

		assert.equal((await spawnExec("git", ["add", "src/carried.ts", "src/outside.ts"], { cwd: root })).code, 0);
		assert.equal((await spawnExec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "advance"], { cwd: root })).code, 0);
		await writeFile(join(root, "src", "carried.ts"), "changed after head\n", "utf8");
		const head = await collectTerminalRepairRebaseAuthorityV1({ projectRoot: root, committed: authority, exec: spawnExec });
		assert.deepEqual(head, { ok: false, code: "head_changed" });
	});

	await withTempDir(async (root) => {
		await initialize(root);
		await writeFile(join(root, "src", "discarded.ts"), "discarded\n", "utf8");
		const sealed = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(sealed.ok, true);
		if (!sealed.ok) return;
		await writeFile(join(root, ".git", "info", "exclude"), "src/discarded.ts\n", "utf8");
		const clean = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/discarded.ts"]),
			exec: spawnExec,
		});
		assert.deepEqual(clean, { ok: false, code: "clean_workspace" });
	});
});

test("terminal repair rebase ignores disjoint dirt but still binds only carried paths", async () => {
	await withTempDir(async (root) => {
		await initialize(root);
		await writeFile(join(root, "src", "carried.ts"), "carried\n", "utf8");
		const sealed = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(sealed.ok, true);
		if (!sealed.ok) return;
		await mkdir(join(root, "notes"), { recursive: true });
		await writeFile(join(root, "notes", "unrelated.md"), "outside worker authority\n", "utf8");

		const result = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/carried.ts"]),
			exec: spawnExec,
		});
		assert.equal(result.ok, true, result.ok ? "" : result.code);
		if (!result.ok) return;
		assert.deepEqual(result.value.relevant_paths, ["src/carried.ts"]);

		await writeFile(join(root, "notes", "unrelated.md"), "changed again\n", "utf8");
		const replay = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/carried.ts"]),
			exec: spawnExec,
		});
		assert.equal(replay.ok, true);
		if (replay.ok) assert.equal(replay.value.rebase_hash, result.value.rebase_hash);
	});
});

test("terminal repair rebase rejects unmerged status even on a carried path", async () => {
	await withTempDir(async (root) => {
		await initialize(root);
		await writeFile(join(root, "src", "conflict.ts"), "conflict\n", "utf8");
		const sealed = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(sealed.ok, true);
		if (!sealed.ok || sealed.guard.git_head === null) return;
		const conflictExec = async (command: string, args: string[]) => {
			assert.equal(command, "git");
			if (args[0] === "rev-parse") return { stdout: `${sealed.guard.git_head}\n`, stderr: "", code: 0, killed: false };
			return { stdout: "UU src/conflict.ts\0", stderr: "", code: 0, killed: false };
		};
		const result = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/conflict.ts"]),
			exec: conflictExec,
		});
		assert.deepEqual(result, { ok: false, code: "unmerged_path", path: "src/conflict.ts" });
	});
});

test("terminal repair rebase keeps carried review paths separate from immutable write scope", async () => {
	await withTempDir(async (root) => {
		await initialize(root);
		await writeFile(join(root, "src", "child.ts"), "child\n", "utf8");
		const sealed = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(sealed.ok, true);
		if (!sealed.ok) return;

		const subtree = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/child.ts"], ["src/**"]),
			exec: spawnExec,
		});
		assert.equal(subtree.ok, true, subtree.ok ? "" : subtree.code);

		const exactParent = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/child.ts"], ["src"]),
			exec: spawnExec,
		});
		assert.equal(exactParent.ok, true, exactParent.ok ? "" : exactParent.code);
		if (!exactParent.ok) return;
		assert.deepEqual(exactParent.value.relevant_paths, ["src/child.ts"]);
		assert.deepEqual(exactParent.value.relevant_paths, subtree.ok ? subtree.value.relevant_paths : [],
			"the read-only rebase is bound to carried paths, never to Luna's write rule");
	});
});

test("post-worker finalization rebase admits only the journal-exact dirty bytes", async () => {
	await withTempDir(async (root) => {
		await initialize(root);
		const transaction = await finalizationRecovery(root);
		const accepted = await collectFinalizationRepairRebaseAuthorityV1({
			projectRoot: root,
			transaction,
			exec: spawnExec,
		});
		assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.code);
		if (accepted.ok) {
			assert.deepEqual(accepted.value.relevant_paths, ["src/recovered.ts"]);
			assert.match(accepted.value.rebase_hash, /^[a-f0-9]{64}$/u);
		}

		await writeFile(join(root, "src", "same-bytes.tmp"), "worker final\n", "utf8");
		await rename(join(root, "src", "same-bytes.tmp"), join(root, "src", "recovered.ts"));
		const sameBytesNewInode = await collectFinalizationRepairRebaseAuthorityV1({
			projectRoot: root,
			transaction,
			exec: spawnExec,
		});
		assert.equal(sameBytesNewInode.ok, true, sameBytesNewInode.ok ? "" : sameBytesNewInode.code);

		await writeFile(join(root, "src", "recovered.ts"), "external mutation\n", "utf8");
		const changed = await collectFinalizationRepairRebaseAuthorityV1({ projectRoot: root, transaction, exec: spawnExec });
		assert.deepEqual(changed, { ok: false, code: "final_identity_mismatch", path: "src/recovered.ts" });
	});

	await withTempDir(async (root) => {
		await initialize(root);
		const transaction = await finalizationRecovery(root, ["src/"]);
		await writeFile(join(root, "src", "outside.ts"), "outside\n", "utf8");
		const outside = await collectFinalizationRepairRebaseAuthorityV1({ projectRoot: root, transaction, exec: spawnExec });
		assert.deepEqual(outside, { ok: false, code: "path_set_mismatch", path: "src/outside.ts" });
	});

	await withTempDir(async (root) => {
		await initialize(root);
		const transaction = await finalizationRecovery(root);
		await mkdir(join(root, "notes"), { recursive: true });
		await writeFile(join(root, "notes", "unrelated.md"), "disjoint dirt\n", "utf8");
		const disjoint = await collectFinalizationRepairRebaseAuthorityV1({ projectRoot: root, transaction, exec: spawnExec });
		assert.equal(disjoint.ok, true, disjoint.ok ? "" : disjoint.code);
	});
});

test("post-worker finalization recovery cannot be superseded as a zero-write attempt", async () => {
	await withTempDir(async (root) => {
		await initialize(root);
		const transaction = await finalizationRecovery(root);
		const guard = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(guard.ok, true);
		if (!guard.ok) return;
		const scope = await readDelegationInactiveBlockerRelevantScopeV2({
			project_root: root,
			transaction,
			workspace_guard: guard.guard,
		});
		assert.deepEqual(scope, {
			ok: true,
			value: {
				relevant_paths: ["src/recovered.ts"],
				clean: false,
			},
		});
		const closed = await publishDelegationInactiveBlockerClosureV2({
			project_root: root,
			transaction,
			workspace_guard: guard.guard,
			closed_by: { provider: "openai-codex", model: "gpt-5.6-sol" },
			now: "2026-08-27T01:02:06.000Z",
		});
		assert.deepEqual(closed, { ok: false, error: { code: "not_recoverable" } });
	});
});
