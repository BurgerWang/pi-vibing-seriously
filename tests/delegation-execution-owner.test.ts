import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	claimDelegationExecutionOwnerV2,
	INTERRUPTED_BEFORE_WORKER_WRITE_REASON_V2,
	readDelegationExecutionOwnerV2,
	recoverInterruptedDelegationV2,
	type DelegationExecutionBootFactsV2,
} from "../extensions/workbench-runtime/core/delegation-execution-owner.ts";
import {
	createNodeDelegationTransactionStorageAdapter,
	persistCommittingDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRunningDelegationTransaction,
	readDelegationTransactionV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import type { DelegationTransactionRecord } from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { beginWriteJournalOperation, createWorkerWriteJournal } from "../extensions/workbench-runtime/core/write-journal.ts";
import { withTempDir } from "./helpers.ts";

const CONTRACT = "c".repeat(64);
const BOOT_TIME = Date.parse("2026-08-22T10:30:03.000Z");
const BOOT: DelegationExecutionBootFactsV2 = {
	boot_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
	system_boot_time_ms: BOOT_TIME,
	runtime_started_at: "2026-08-22T10:31:00.000Z",
};

function time(second: number): string {
	return `2026-08-22T10:23:${String(second).padStart(2, "0")}.000Z`;
}

function paths(root: string, id: string): { transaction: string; journal: string; v2: string } {
	const v2 = join(root, CONFIG_DIR_NAME, "workbench", "delegations", id, "v2");
	return { v2, transaction: join(v2, "transaction.json"), journal: join(v2, "write-journal.json") };
}

async function prepared(root: string, id: string): Promise<DelegationTransactionRecord> {
	const result = await preparedTransactionOnly(root, id);
	const journal = await createWorkerWriteJournal({ project_root: root, delegation_id: id, contract_hash: CONTRACT });
	assert.equal(journal.ok, true, journal.ok ? "" : journal.error.code);
	return result;
}

async function preparedTransactionOnly(root: string, id: string): Promise<DelegationTransactionRecord> {
	const result = await persistPreparedDelegationTransaction(root, {
		delegation_id: id,
		task_kind: "implementation",
		contract_hash: CONTRACT,
		allowed_paths: ["src/**"],
		worker_identity: {
			provider: WORKER_PROVIDER,
			model: WORKER_MODEL_ID,
			worker_id: `worker:${id}`,
		},
		generation: 1,
		now: time(40),
	});
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

async function running(root: string, id: string): Promise<DelegationTransactionRecord> {
	const initial = await prepared(root, id);
	const result = await persistRunningDelegationTransaction(root, {
		delegation_id: id,
		contract_hash: CONTRACT,
		worker_identity: initial.worker_identity,
		expected_generation: 1,
		expected_revision: 0,
		now: time(43),
	});
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

async function markLegacyFilesPreboot(root: string, id: string): Promise<void> {
	const preboot = new Date("2026-08-22T10:23:43.960Z");
	const target = paths(root, id);
	await utimes(target.transaction, preboot, preboot);
	await utimes(target.journal, preboot, preboot);
}

test("execution owner is exclusive, strictly bound, live while its process lives, and recoverable after death", async () => {
	await withTempDir(async (root) => {
		const id = "20260822-172343-own1";
		const state = await prepared(root, id);
		let alive = true;
		const adapter = {
			...createNodeDelegationTransactionStorageAdapter(),
			processId: 424_242,
			isProcessAlive: (pid: number) => alive && pid === 424_242,
		};
		const options = { storage_options: { adapter }, boot_facts: BOOT };
		const claimed = await claimDelegationExecutionOwnerV2(root, state, time(43), options);
		assert.equal(claimed.ok, true, claimed.ok ? "" : claimed.error.code);
		if (!claimed.ok) return;
		assert.equal(claimed.value.process_id, 424_242);
		assert.equal(claimed.value.boot_id, BOOT.boot_id);
		assert.deepEqual(await claimDelegationExecutionOwnerV2(root, state, time(44), options), {
			ok: false,
			error: { code: "conflict" },
		});
		assert.deepEqual((await readDelegationExecutionOwnerV2(root, state, options)).ok, true);

		const active = await recoverInterruptedDelegationV2({ project_root: root, transaction: state, now: time(45), options });
		assert.equal(active.status, "active");
		alive = false;
		const recovered = await recoverInterruptedDelegationV2({ project_root: root, transaction: state, now: time(46), options });
		assert.equal(recovered.status, "recovered");
		assert.equal(recovered.transaction.status, "ABORTED");
		assert.equal(recovered.transaction.abort_reason, INTERRUPTED_BEFORE_WORKER_WRITE_REASON_V2);
		assert.equal((await readDelegationExecutionOwnerV2(root, recovered.transaction, options)).ok, false);
	});
});

test("legacy RUNNING from before the current boot with a pristine journal becomes durable ABORTED", async () => {
	await withTempDir(async (root) => {
		const id = "20260822-172343-leg1";
		const state = await running(root, id);
		await markLegacyFilesPreboot(root, id);
		const recovered = await recoverInterruptedDelegationV2({
			project_root: root,
			transaction: state,
			now: "2026-08-22T11:00:00.000Z",
			options: { boot_facts: BOOT },
		});
		assert.equal(recovered.status, "recovered");
		if (recovered.status !== "recovered") return;
		assert.equal(recovered.legacy_reboot_proof, true);
		const durable = await readDelegationTransactionV2(root, id);
		assert.equal(durable.ok, true);
		if (durable.ok) {
			assert.equal(durable.value.status, "ABORTED");
			assert.equal(durable.value.revision, 2);
			assert.equal(durable.value.committed_proof, null);
			assert.equal(durable.value.review, null);
		}
	});
});

test("a dead owner closes the PREPARED crash window before journal creation", async () => {
	await withTempDir(async (root) => {
		const id = "20260822-172343-prej";
		const state = await preparedTransactionOnly(root, id);
		const adapter = {
			...createNodeDelegationTransactionStorageAdapter(),
			processId: 434_343,
			isProcessAlive: () => false,
		};
		const options = { storage_options: { adapter }, boot_facts: BOOT };
		const owner = await claimDelegationExecutionOwnerV2(root, state, time(43), options);
		assert.equal(owner.ok, true, owner.ok ? "" : owner.error.code);
		const recovered = await recoverInterruptedDelegationV2({
			project_root: root, transaction: state, now: time(44), options,
		});
		assert.equal(recovered.status, "recovered");
		assert.equal(recovered.transaction.status, "ABORTED");
	});
});

test("a legacy PREPARED record and transaction file from before boot may be aborted before journal creation", async () => {
	await withTempDir(async (root) => {
		const id = "20260822-172343-lpre";
		const state = await preparedTransactionOnly(root, id);
		const preboot = new Date("2026-08-22T10:23:43.960Z");
		await utimes(paths(root, id).transaction, preboot, preboot);
		const recovered = await recoverInterruptedDelegationV2({
			project_root: root,
			transaction: state,
			now: "2026-08-22T11:00:00.000Z",
			options: { boot_facts: BOOT },
		});
		assert.equal(recovered.status, "recovered");
		assert.equal(recovered.transaction.status, "ABORTED");
	});
});

test("same-boot PID reuse is rejected by the persisted process-start identity", async () => {
	await withTempDir(async (root) => {
		const id = "20260822-172343-reus";
		const state = await prepared(root, id);
		let startTicks = "100";
		const adapter = {
			...createNodeDelegationTransactionStorageAdapter(),
			processId: 444_444,
			isProcessAlive: () => true,
		};
		const options = {
			storage_options: { adapter },
			boot_facts: BOOT,
			read_process_start_ticks: async () => startTicks,
		};
		const owner = await claimDelegationExecutionOwnerV2(root, state, time(43), options);
		assert.equal(owner.ok, true, owner.ok ? "" : owner.error.code);
		if (owner.ok) assert.equal(owner.value.process_start_ticks, "100");
		startTicks = "101";
		const recovered = await recoverInterruptedDelegationV2({
			project_root: root, transaction: state, now: time(44), options,
		});
		assert.equal(recovered.status, "recovered");
		assert.equal(recovered.transaction.status, "ABORTED");
	});
});

test("a missing owner created in the current boot is unproven and never auto-aborted", async () => {
	await withTempDir(async (root) => {
		const id = "20260822-172343-new1";
		const state = await running(root, id);
		const result = await recoverInterruptedDelegationV2({
			project_root: root,
			transaction: state,
			now: "2026-08-22T11:00:00.000Z",
			options: {
				boot_facts: { ...BOOT, system_boot_time_ms: Date.parse("2026-08-22T10:00:00.000Z") },
			},
		});
		assert.equal(result.status, "unproven");
		const durable = await readDelegationTransactionV2(root, id);
		assert.equal(durable.ok && durable.value.status, "RUNNING");
	});
});

test("proven orphan with any write evidence remains blocking", async () => {
	await withTempDir(async (root) => {
		const id = "20260822-172343-writ";
		const state = await running(root, id);
		await writeFile(join(root, "worker.txt"), "worker data\n", "utf8");
		const begun = await beginWriteJournalOperation({
			project_root: root,
			delegation_id: id,
			contract_hash: CONTRACT,
			expected_revision: 0,
			operation_id: "d".repeat(64),
			kind: "write",
			path: "worker.txt",
		});
		assert.equal(begun.ok, true, begun.ok ? "" : begun.error.code);
		await markLegacyFilesPreboot(root, id);
		const result = await recoverInterruptedDelegationV2({
			project_root: root, transaction: state, now: "2026-08-22T11:00:00.000Z", options: { boot_facts: BOOT },
		});
		assert.equal(result.status, "blocked");
		if (result.status === "blocked") assert.equal(result.code, "nonempty_journal");
		const durable = await readDelegationTransactionV2(root, id);
		assert.equal(durable.ok && durable.value.status, "RUNNING");
	});
});

test("COMMITTING is never auto-aborted even when its process is gone", async () => {
	await withTempDir(async (root) => {
		const id = "20260822-172343-com1";
		const state = await running(root, id);
		const committing = await persistCommittingDelegationTransaction(root, {
			delegation_id: id,
			contract_hash: CONTRACT,
			worker_identity: state.worker_identity,
			expected_generation: 1,
			expected_revision: 1,
			now: time(45),
			outcome: {
				delegation_id: id,
				task_kind: "implementation",
				worker_identity: state.worker_identity,
				provider_success: true,
				exit_code: 0,
				report_complete: true,
				terminal_facts_complete: true,
				scope_complete: true,
				change_set_status: "ATTRIBUTED",
				changed_paths: ["worker.txt"],
				successful_write_count: 1,
				denied_write_count: 0,
				delta_hash: "e".repeat(64),
			},
		});
		assert.equal(committing.ok, true, committing.ok ? "" : committing.error.code);
		if (!committing.ok) return;
		const result = await recoverInterruptedDelegationV2({
			project_root: root, transaction: committing.value, now: "2026-08-22T11:00:00.000Z", options: { boot_facts: BOOT },
		});
		assert.equal(result.status, "not_applicable");
		assert.equal(result.transaction.status, "COMMITTING");
	});
});

test("unexpected generation/review artifacts and malformed owner evidence fail closed", async () => {
	await withTempDir(async (root) => {
		const unsafeId = "20260822-172343-art1";
		const unsafe = await running(root, unsafeId);
		await markLegacyFilesPreboot(root, unsafeId);
		await mkdir(join(paths(root, unsafeId).v2, "generations"));
		const artifactResult = await recoverInterruptedDelegationV2({
			project_root: root, transaction: unsafe, now: "2026-08-22T11:00:00.000Z", options: { boot_facts: BOOT },
		});
		assert.equal(artifactResult.status, "blocked");
		if (artifactResult.status === "blocked") assert.equal(artifactResult.code, "unsafe_artifacts");

		const corruptId = "20260822-172343-bad1";
		const corrupt = await running(root, corruptId);
		await writeFile(join(paths(root, corruptId).v2, "execution-owner.json"), "{}\n", "utf8");
		const corruptResult = await recoverInterruptedDelegationV2({
			project_root: root, transaction: corrupt, now: "2026-08-22T11:00:00.000Z", options: { boot_facts: BOOT },
		});
		assert.equal(corruptResult.status, "blocked");
		if (corruptResult.status === "blocked") assert.equal(corruptResult.code, "invalid_owner");
	});
});
