import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
	admitProjectDelegationPathLaneV1,
} from "../extensions/workbench-runtime/core/delegation-path-lane-admission.ts";
import {
	closeInactiveProjectDelegationBlockerV2,
	readProjectDelegationBlockerV2,
} from "../extensions/workbench-runtime/core/delegation-project-authority.ts";
import {
	persistCommittingDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRecoveryRequiredDelegationTransaction,
	persistRunningDelegationTransaction,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import type { DelegationTransactionRecord } from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import {
	readRecoverableUnpublishedPathAuthorityV1,
} from "../extensions/workbench-runtime/core/recoverable-unpublished-path-authority.ts";
import {
	beginWriteJournalOperation,
	completeWriteJournalOperation,
	createWorkerWriteJournal,
	sealWorkerWriteJournal,
} from "../extensions/workbench-runtime/core/write-journal.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

const CONTRACT_HASH = "a".repeat(64);

function at(second: number): string {
	return `2026-08-27T12:00:${String(second).padStart(2, "0")}.000Z`;
}

function cas(transaction: DelegationTransactionRecord, second: number) {
	return {
		delegation_id: transaction.delegation_id,
		contract_hash: transaction.contract_hash,
		worker_identity: transaction.worker_identity,
		expected_generation: transaction.generation,
		expected_revision: transaction.revision,
		now: at(second),
	};
}

async function prepared(root: string, id: string): Promise<DelegationTransactionRecord> {
	const result = await persistPreparedDelegationTransaction(root, {
		delegation_id: id,
		task_kind: "implementation",
		contract_hash: CONTRACT_HASH,
		allowed_paths: ["docs/**", "src/**"],
		worker_identity: {
			provider: WORKER_PROVIDER,
			model: WORKER_MODEL_ID,
			worker_id: `worker:${id}`,
		},
		generation: 1,
		now: at(0),
	});
	if (!result.ok) assert.fail(result.error.code);
	return result.value;
}

async function artifactRecovery(input: {
	root: string;
	id: string;
	journalPath: string;
	changedPaths: readonly string[];
	successfulWriteCount?: number;
}): Promise<DelegationTransactionRecord> {
	const initial = await prepared(input.root, input.id);
	const running = await persistRunningDelegationTransaction(input.root, cas(initial, 1));
	if (!running.ok) assert.fail(running.error.code);

	const journal = await createWorkerWriteJournal({
		project_root: input.root,
		delegation_id: input.id,
		contract_hash: initial.contract_hash,
	});
	if (!journal.ok) assert.fail(journal.error.code);
	const begun = await beginWriteJournalOperation({
		project_root: input.root,
		delegation_id: input.id,
		contract_hash: initial.contract_hash,
		expected_revision: journal.value.revision,
		operation_id: "1".repeat(64),
		kind: "write",
		path: input.journalPath,
	});
	if (!begun.ok) assert.fail(begun.error.code);
	await mkdir(join(input.root, ...input.journalPath.split("/").slice(0, -1)), { recursive: true });
	await writeFile(join(input.root, input.journalPath), "worker delta\n", "utf8");
	const completed = await completeWriteJournalOperation({
		project_root: input.root,
		delegation_id: input.id,
		contract_hash: initial.contract_hash,
		expected_revision: begun.value.revision,
		operation_id: "1".repeat(64),
		kind: "write",
		path: input.journalPath,
		outcome: "succeeded",
	});
	if (!completed.ok) assert.fail(completed.error.code);
	const sealed = await sealWorkerWriteJournal({
		project_root: input.root,
		delegation_id: input.id,
		contract_hash: initial.contract_hash,
		expected_revision: completed.value.revision,
	});
	assert.equal(sealed.ok, true, sealed.ok ? "" : sealed.error.code);

	const committing = await persistCommittingDelegationTransaction(input.root, {
		...cas(running.value, 2),
		outcome: {
			delegation_id: input.id,
			task_kind: "implementation",
			worker_identity: initial.worker_identity,
			provider_success: true,
			worker_success: true,
			worker_failure_code: null,
			exit_code: 0,
			report_complete: true,
			terminal_facts_complete: true,
			scope_complete: true,
			change_set_status: "ATTRIBUTED",
			changed_paths: [...input.changedPaths],
			successful_write_count: input.successfulWriteCount ?? 1,
			denied_write_count: 0,
			delta_hash: "b".repeat(64),
		},
	});
	if (!committing.ok) assert.fail(committing.error.code);
	const recovery = await persistRecoveryRequiredDelegationTransaction(input.root, {
		...cas(committing.value, 3),
		reason: "committed artifact construction failed",
	});
	if (!recovery.ok) assert.fail(recovery.error.code);
	return recovery.value;
}

async function genericRecovery(root: string, id: string): Promise<DelegationTransactionRecord> {
	const initial = await prepared(root, id);
	const running = await persistRunningDelegationTransaction(root, cas(initial, 1));
	if (!running.ok) assert.fail(running.error.code);
	const recovery = await persistRecoveryRequiredDelegationTransaction(root, {
		...cas(running.value, 2),
		reason: "bounded recovery evidence",
	});
	if (!recovery.ok) assert.fail(recovery.error.code);
	return recovery.value;
}

test("strict proof-null artifact authority localizes the conservative journal/outcome union", async () => {
	await withTempDir(async (root) => {
		const id = "20260827-120000-rp01";
		await artifactRecovery({
			root,
			id,
			journalPath: "src/journal-only.ts",
			changedPaths: ["src/command-only.ts"],
		});
		const authority = await readRecoverableUnpublishedPathAuthorityV1(root, id);
		assert.equal(authority.ok, true, authority.ok ? "" : authority.error.code);
		if (!authority.ok) return;
		assert.deepEqual(authority.value.changed_paths, ["src/command-only.ts", "src/journal-only.ts"]);
		assert.deepEqual(authority.value.relevant_paths, ["src/command-only.ts", "src/journal-only.ts"]);
		assert.deepEqual(authority.value.uncovered_baseline_paths, ["src/command-only.ts"]);
		assert.equal(authority.value.baseline_complete, false);

		const disjoint = await admitProjectDelegationPathLaneV1({
			project_root: root,
			allowed_paths: ["docs/**"],
		});
		assert.equal(disjoint.decision.decision, "ALLOW", JSON.stringify(disjoint));
		assert.deepEqual(disjoint.ordinary_blocker_ids, [id]);
		assert.equal(disjoint.blockers[0]?.kind, "known");

		const journalOverlap = await admitProjectDelegationPathLaneV1({
			project_root: root,
			allowed_paths: ["src/journal-only.ts"],
		});
		assert.equal(journalOverlap.decision.decision, "BLOCK");
		assert.deepEqual(journalOverlap.decision.block_reasons, ["PATH_OVERLAP"]);
	});
});

test("generic proof-null recovery remains unknown and counter corruption fails closed", async () => {
	await withTempDir(async (root) => {
		const id = "20260827-120001-rp02";
		await genericRecovery(root, id);
		const admission = await admitProjectDelegationPathLaneV1({
			project_root: root,
			allowed_paths: ["docs/**"],
		});
		assert.equal(admission.decision.decision, "BLOCK");
		assert.deepEqual(admission.decision.block_reasons, ["UNKNOWN_AUTHORITY"]);
		assert.equal(admission.blockers[0]?.kind, "unknown");
	});

	await withTempDir(async (root) => {
		const id = "20260827-120002-rp03";
		await artifactRecovery({
			root,
			id,
			journalPath: "src/mismatch.ts",
			changedPaths: ["src/mismatch.ts"],
			successfulWriteCount: 0,
		});
		assert.deepEqual(await readRecoverableUnpublishedPathAuthorityV1(root, id), {
			ok: false,
			error: { code: "invalid_record" },
		});
		const admission = await admitProjectDelegationPathLaneV1({
			project_root: root,
			allowed_paths: ["docs/**"],
		});
		assert.equal(admission.decision.decision, "BLOCK");
		assert.deepEqual(admission.decision.block_reasons, ["INVALID_AUTHORITY"]);
		assert.equal(admission.blockers[0]?.kind, "invalid");
	});
});

test("proof-null closure checks the sealed before identity for a Git-ignored path", async () => {
	await withTempDir(async (root) => {
		assert.equal((await spawnExec("git", ["init", "-q"], { cwd: root })).code, 0);
		await writeFile(join(root, ".gitignore"), "src/ignored-generated.ts\n", "utf8");
		await writeFile(join(root, "README.md"), "baseline\n", "utf8");
		assert.equal((await spawnExec("git", ["add", ".gitignore", "README.md"], { cwd: root })).code, 0);
		assert.equal((await spawnExec("git", [
			"-c", "user.name=Workbench Test", "-c", "user.email=test@example.invalid",
			"commit", "-q", "-m", "baseline",
		], { cwd: root })).code, 0);

		const id = "20260827-120003-rp04";
		const ignoredPath = "src/ignored-generated.ts";
		await artifactRecovery({
			root,
			id,
			journalPath: ignoredPath,
			changedPaths: [ignoredPath],
		});
		const dirty = await closeInactiveProjectDelegationBlockerV2({
			project_root: root,
			expected_delegation_id: id,
			now: at(4),
			exec: spawnExec,
			closed_by: { provider: "openai", model: "gpt-5.6-sol" },
		});
		assert.equal(dirty.ok, false);
		if (!dirty.ok) assert.equal(dirty.code, "relevant_paths_not_clean");

		await rm(join(root, ignoredPath));
		await writeFile(join(root, "unrelated-user-work.txt"), "preserve me\n", "utf8");
		const restoredAuthority = await readRecoverableUnpublishedPathAuthorityV1(root, id);
		assert.equal(restoredAuthority.ok, true, restoredAuthority.ok ? "" : restoredAuthority.error.code);
		if (!restoredAuthority.ok) return;
		assert.equal(restoredAuthority.value.baseline_complete, true);
		assert.equal(restoredAuthority.value.journal_before[0]?.kind, "missing");
		const closed = await closeInactiveProjectDelegationBlockerV2({
			project_root: root,
			expected_delegation_id: id,
			now: at(6),
			exec: spawnExec,
			closed_by: { provider: "openai", model: "gpt-5.6-sol" },
		});
		assert.equal(closed.ok, true, closed.ok ? "" : closed.code);
		if (closed.ok) assert.deepEqual(closed.value.relevant_paths, [ignoredPath]);
		assert.equal(await readFile(join(root, "unrelated-user-work.txt"), "utf8"), "preserve me\n");
		assert.deepEqual(await readProjectDelegationBlockerV2(root), { ok: true, value: null });
	});
});
