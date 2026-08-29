import assert from "node:assert/strict";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	abortPristinePreparedDelegationUnderStartLockV2,
	claimDelegationExecutionOwnerV2,
	INTERRUPTED_BEFORE_WORKER_WRITE_REASON_V2,
	isStrictRetryableEmptyRepairRecoveryV2,
	isStrictRetryableAbortedRepairV2,
	readStrictRetryableRawRepairEvidenceV1,
	releaseDelegationExecutionOwnerV2,
	releaseOrphanedTerminalExecutionOwnerV2,
	RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2,
	RETRYABLE_EMPTY_RECOVERY_REASONS_V2,
	readDelegationExecutionOwnerV2,
	recoverInterruptedDelegationV2,
	type DelegationExecutionBootFactsV2,
} from "../extensions/workbench-runtime/core/delegation-execution-owner.ts";
import {
	createNodeDelegationTransactionStorageAdapter,
	persistCommittingDelegationTransaction,
	persistAbortedDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRecoveryRequiredDelegationTransaction,
	persistRunningDelegationTransaction,
	readDelegationTransactionV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	bindDelegationRepairLineageV1,
	type DelegationRepairLineageV1,
	type DelegationTransactionRecord,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import {
	acquireProjectDelegationStartLockV1,
	releaseProjectDelegationStartLockV1,
} from "../extensions/workbench-runtime/core/delegation-start-lock.ts";
import {
	acquireProjectCheckoutOperationV1,
	inspectProcessCheckoutOperationV1,
	markProjectCheckoutOperationSettledV1,
} from "../extensions/workbench-runtime/core/project-checkout-operation.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import {
	beginWriteJournalOperation,
	completeWriteJournalOperation,
	createWorkerWriteJournal,
	sealWorkerWriteJournal,
} from "../extensions/workbench-runtime/core/write-journal.ts";
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

async function preparedTransactionOnly(root: string, id: string, lineage?: DelegationRepairLineageV1): Promise<DelegationTransactionRecord> {
	const result = await persistPreparedDelegationTransaction(root, {
		delegation_id: id,
		task_kind: "implementation",
		contract_hash: CONTRACT,
		allowed_paths: lineage === undefined ? ["src/**"] : ["src/rejected.ts"],
		worker_identity: {
			provider: WORKER_PROVIDER,
			model: WORKER_MODEL_ID,
			worker_id: `worker:${id}`,
		},
		generation: 1,
		now: time(40),
		...(lineage === undefined ? {} : { repair_lineage: lineage }),
	});
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

function repairLineage(rootId: string): DelegationRepairLineageV1 {
	const lineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: rootId,
		repair_of: rootId,
		root_decision_hash: "a".repeat(64),
		continuation_decision_delegation_id: rootId,
		continuation_decision_hash: "a".repeat(64),
		parent_lineage_hash: null,
		depth: 1,
		carried_paths: ["src/rejected.ts"],
	});
	if (lineage === undefined) throw new Error("invalid repair lineage fixture");
	return lineage;
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

test("same-PID settled pristine RUNNING is CAS-aborted and releases both owner and checkout lane", async () => {
	await withTempDir(async (root) => {
		const id = "20260822-172343-smp1";
		const operation = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "delegation",
			operation_id: `delegation:${id}`,
			delegation_id: id,
			now: time(39),
		});
		assert.equal(operation.ok, true);
		if (!operation.ok) return;
		const initial = await prepared(root, id);
		const owner = await claimDelegationExecutionOwnerV2(root, initial, time(41));
		assert.equal(owner.ok, true);
		const state = await persistRunningDelegationTransaction(root, {
			delegation_id: id,
			contract_hash: CONTRACT,
			worker_identity: initial.worker_identity,
			expected_generation: 1,
			expected_revision: 0,
			now: time(42),
		});
		assert.equal(state.ok, true);
		if (!state.ok) return;
		assert.equal(markProjectCheckoutOperationSettledV1(operation.value), true);
		const recovered = await recoverInterruptedDelegationV2({
			project_root: root,
			transaction: state.value,
			now: time(44),
		});
		assert.equal(recovered.status, "recovered");
		assert.equal(recovered.transaction.status, "ABORTED");
		assert.equal(inspectProcessCheckoutOperationV1(root, operation.value.token), "absent");
		assert.equal((await readDelegationExecutionOwnerV2(root, recovered.transaction)).ok, false);
		await assert.rejects(readFile(join(root, CONFIG_DIR_NAME, "workbench", "delegation-start.lock")), { code: "ENOENT" });
	});
});

test("same-PID settled RUNNING with worker evidence becomes RECOVERY_REQUIRED and releases the lane", async () => {
	await withTempDir(async (root) => {
		const id = "20260822-172343-smp2";
		const operation = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "delegation",
			operation_id: `delegation:${id}`,
			delegation_id: id,
			now: time(39),
		});
		assert.equal(operation.ok, true);
		if (!operation.ok) return;
		const initial = await prepared(root, id);
		const owner = await claimDelegationExecutionOwnerV2(root, initial, time(41));
		assert.equal(owner.ok, true);
		const state = await persistRunningDelegationTransaction(root, {
			delegation_id: id,
			contract_hash: CONTRACT,
			worker_identity: initial.worker_identity,
			expected_generation: 1,
			expected_revision: 0,
			now: time(42),
		});
		assert.equal(state.ok, true);
		if (!state.ok) return;
		const begun = await beginWriteJournalOperation({
			project_root: root,
			delegation_id: id,
			contract_hash: CONTRACT,
			expected_revision: 0,
			operation_id: "a".repeat(64),
			kind: "write",
			path: "src/worker.ts",
		});
		assert.equal(begun.ok, true);
		assert.equal(markProjectCheckoutOperationSettledV1(operation.value), true);
		const recovered = await recoverInterruptedDelegationV2({
			project_root: root,
			transaction: state.value,
			now: time(44),
		});
		assert.equal(recovered.status, "recovered");
		assert.equal(recovered.transaction.status, "RECOVERY_REQUIRED");
		assert.equal(inspectProcessCheckoutOperationV1(root, operation.value.token), "absent");
		await assert.rejects(readFile(join(root, CONFIG_DIR_NAME, "workbench", "delegation-start.lock")), { code: "ENOENT" });
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

test("a dead project start lock closes the same-boot PREPARED-before-execution-owner crash window", async () => {
	await withTempDir(async (root) => {
		const id = "20260822-172343-slk1";
		const start = await acquireProjectDelegationStartLockV1(
			{ project_root: root, delegation_id: id, now: time(39) },
			{
				process_id: 454_545,
				read_boot_id: async () => BOOT.boot_id,
				read_process_start_ticks: async (processId) => processId === 454_545 ? "100" : null,
			},
		);
		assert.equal(start.ok, true);
		const state = await preparedTransactionOnly(root, id);
		const recovered = await recoverInterruptedDelegationV2({
			project_root: root,
			transaction: state,
			now: time(44),
			options: {
				boot_facts: { ...BOOT, system_boot_time_ms: Date.parse("2026-08-22T10:00:00.000Z") },
				start_lock_options: {
					is_process_alive: () => false,
					read_boot_id: async () => BOOT.boot_id,
					read_process_start_ticks: async (processId) => processId === 454_545 ? "100" : null,
				},
			},
		});
		assert.equal(recovered.status, "recovered");
		assert.equal(recovered.transaction.status, "ABORTED");
		await assert.rejects(readFile(join(root, CONFIG_DIR_NAME, "workbench", "delegation-start.lock")), { code: "ENOENT" });
	});
});

test("an exact live start-lock lease closes an ownerless pristine PREPARED record and permits same-process retry", async () => {
	await withTempDir(async (root) => {
		const firstId = "20260822-172343-ownp";
		const start = await acquireProjectDelegationStartLockV1({
			project_root: root,
			delegation_id: firstId,
			now: time(39),
		});
		assert.equal(start.ok, true, start.ok ? "" : start.error.code);
		if (!start.ok) return;
		const state = await preparedTransactionOnly(root, firstId);
		const recovered = await abortPristinePreparedDelegationUnderStartLockV2({
			project_root: root,
			transaction: state,
			start_lock_lease: start.value,
			now: time(44),
		});
		assert.equal(recovered.status, "recovered", recovered.status === "blocked" ? recovered.code : "");
		assert.equal(recovered.transaction.status, "ABORTED");
		assert.equal(recovered.transaction.abort_reason,
			RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.executionOwnerClaimFailed);
		assert.equal((await releaseProjectDelegationStartLockV1(start.value)).ok, true);

		const retry = await acquireProjectDelegationStartLockV1({
			project_root: root,
			delegation_id: "20260822-172344-rtry",
			now: time(45),
		});
		assert.equal(retry.ok, true, retry.ok ? "" : retry.error.code);
		if (retry.ok) assert.equal((await releaseProjectDelegationStartLockV1(retry.value)).ok, true);
	});
});

test("owned PREPARED abort rejects a foreign start token, a present owner, and worker-write evidence", async () => {
	await withTempDir(async (root) => {
		const id = "20260822-172343-frgn";
		const original = await acquireProjectDelegationStartLockV1({ project_root: root, delegation_id: id, now: time(39) });
		assert.equal(original.ok, true, original.ok ? "" : original.error.code);
		if (!original.ok) return;
		const state = await preparedTransactionOnly(root, id);
		assert.equal((await releaseProjectDelegationStartLockV1(original.value)).ok, true);
		const foreign = await acquireProjectDelegationStartLockV1(
			{ project_root: root, delegation_id: id, now: time(40) },
			{ random_token: () => original.value.token === "f".repeat(32) ? "e".repeat(32) : "f".repeat(32) },
		);
		assert.equal(foreign.ok, true, foreign.ok ? "" : foreign.error.code);
		if (!foreign.ok) return;
		const refused = await abortPristinePreparedDelegationUnderStartLockV2({
			project_root: root,
			transaction: state,
			start_lock_lease: original.value,
			now: time(44),
		});
		assert.deepEqual(refused, { status: "blocked", transaction: state, code: "start_lock_conflict" });
		assert.equal((await readDelegationTransactionV2(root, id)).ok, true);
		assert.equal((await releaseProjectDelegationStartLockV1(original.value)).ok, false,
			"the stale caller token cannot remove the replacement owner");
		assert.equal((await releaseProjectDelegationStartLockV1(foreign.value)).ok, true);
	});

	await withTempDir(async (root) => {
		const id = "20260822-172343-live";
		const start = await acquireProjectDelegationStartLockV1({ project_root: root, delegation_id: id, now: time(39) });
		assert.equal(start.ok, true, start.ok ? "" : start.error.code);
		if (!start.ok) return;
		const state = await preparedTransactionOnly(root, id);
		const owner = await claimDelegationExecutionOwnerV2(root, state, time(41));
		assert.equal(owner.ok, true, owner.ok ? "" : owner.error.code);
		const refused = await abortPristinePreparedDelegationUnderStartLockV2({
			project_root: root,
			transaction: state,
			start_lock_lease: start.value,
			now: time(44),
		});
		assert.equal(refused.status, "blocked");
		if (refused.status === "blocked") assert.equal(refused.code, "invalid_owner");
		const durable = await readDelegationTransactionV2(root, id);
		assert.equal(durable.ok && durable.value.status, "PREPARED");
		if (owner.ok) assert.equal((await releaseDelegationExecutionOwnerV2(root, state, owner.value.token)).ok, true);
		assert.equal((await releaseProjectDelegationStartLockV1(start.value)).ok, true,
			"the helper never removes even the caller's lock on ambiguous owner evidence");
	});

	await withTempDir(async (root) => {
		const id = "20260822-172343-writ";
		const start = await acquireProjectDelegationStartLockV1({ project_root: root, delegation_id: id, now: time(39) });
		assert.equal(start.ok, true, start.ok ? "" : start.error.code);
		if (!start.ok) return;
		const state = await preparedTransactionOnly(root, id);
		const journal = await createWorkerWriteJournal({ project_root: root, delegation_id: id, contract_hash: CONTRACT });
		assert.equal(journal.ok, true, journal.ok ? "" : journal.error.code);
		if (!journal.ok) return;
		const begun = await beginWriteJournalOperation({
			project_root: root,
			delegation_id: id,
			contract_hash: CONTRACT,
			expected_revision: journal.value.revision,
			operation_id: "f".repeat(64),
			kind: "write",
			path: "src/write-evidence.ts",
		});
		assert.equal(begun.ok, true, begun.ok ? "" : begun.error.code);
		const refused = await abortPristinePreparedDelegationUnderStartLockV2({
			project_root: root,
			transaction: state,
			start_lock_lease: start.value,
			now: time(44),
		});
		assert.equal(refused.status, "blocked");
		if (refused.status === "blocked") assert.equal(refused.code, "nonempty_journal");
		const durable = await readDelegationTransactionV2(root, id);
		assert.equal(durable.ok && durable.value.status, "PREPARED");
		assert.equal((await releaseProjectDelegationStartLockV1(start.value)).ok, true);
	});
});

test("only the exact before-write lineaged ABORTED shape is retryable", async () => {
	await withTempDir(async (root) => {
		const rootId = "20260822-172342-root";
		const id = "20260822-172343-rpr1";
		const start = await acquireProjectDelegationStartLockV1(
			{ project_root: root, delegation_id: id, now: time(39) },
			{
				process_id: 454_546,
				read_boot_id: async () => BOOT.boot_id,
				read_process_start_ticks: async (processId) => processId === 454_546 ? "101" : null,
			},
		);
		assert.equal(start.ok, true);
		const state = await preparedTransactionOnly(root, id, repairLineage(rootId));
		const recovered = await recoverInterruptedDelegationV2({
			project_root: root,
			transaction: state,
			now: time(44),
			options: {
				boot_facts: { ...BOOT, system_boot_time_ms: Date.parse("2026-08-22T10:00:00.000Z") },
				start_lock_options: {
					is_process_alive: () => false,
					read_boot_id: async () => BOOT.boot_id,
					read_process_start_ticks: async (processId) => processId === 454_546 ? "101" : null,
				},
			},
		});
		assert.equal(recovered.status, "recovered");
		assert.equal(await isStrictRetryableAbortedRepairV2(root, recovered.transaction), true);
		const evidence = await readStrictRetryableRawRepairEvidenceV1(root, recovered.transaction);
		assert.equal(evidence.ok, true, evidence.ok ? "" : evidence.code);
		if (evidence.ok) {
			assert.equal(evidence.value.retry_kind, "ABORTED");
			assert.equal(evidence.value.journal_present, false);
			assert.deepEqual(evidence.value.inventory, ["transaction.json:file"]);
			assert.match(evidence.value.evidence_hash, /^[a-f0-9]{64}$/u);
		}
		await writeFile(join(paths(root, id).v2, "unexpected.json"), "{}\n", "utf8");
		assert.equal(await isStrictRetryableAbortedRepairV2(root, recovered.transaction), false,
			"extra artifacts revoke retry authority");
		assert.deepEqual(await readStrictRetryableRawRepairEvidenceV1(root, recovered.transaction), {
			ok: false,
			code: "NOT_RETRYABLE",
		});
	});
	await withTempDir(async (root) => {
		const rootId = "20260822-172342-root";
		const id = "20260822-172343-bad1";
		const state = await preparedTransactionOnly(root, id, repairLineage(rootId));
		const aborted = await persistAbortedDelegationTransaction(root, {
			delegation_id: id,
			contract_hash: state.contract_hash,
			worker_identity: state.worker_identity,
			expected_generation: state.generation,
			expected_revision: state.revision,
			now: time(44),
			reason: "caller-declared abort without recovery proof",
		});
		assert.equal(aborted.ok, true);
		if (aborted.ok) assert.equal(await isStrictRetryableAbortedRepairV2(root, aborted.value), false);
	});
	await withTempDir(async (root) => {
		const rootId = "20260822-172342-root";
		const id = "20260822-172343-okp1";
		const state = await preparedTransactionOnly(root, id, repairLineage(rootId));
		const aborted = await persistAbortedDelegationTransaction(root, {
			delegation_id: id,
			contract_hash: state.contract_hash,
			worker_identity: state.worker_identity,
			expected_generation: state.generation,
			expected_revision: state.revision,
			now: time(44),
			reason: RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.changeSetPreparationFailed,
		});
		assert.equal(aborted.ok, true);
		if (aborted.ok) assert.equal(await isStrictRetryableAbortedRepairV2(root, aborted.value), true);
	});
});

test("lineaged empty recovery requires released owner, known reason, and exact inventory", async () => {
	await withTempDir(async (root) => {
		const rootId = "20260822-172342-root";
		const id = "20260822-172343-rcv1";
		const initial = await preparedTransactionOnly(root, id, repairLineage(rootId));
		const journal = await createWorkerWriteJournal({ project_root: root, delegation_id: id, contract_hash: CONTRACT });
		assert.equal(journal.ok, true);
		let alive = true;
		const adapter = {
			...createNodeDelegationTransactionStorageAdapter(),
			processId: 565_656,
			isProcessAlive: () => alive,
		};
		const options = { storage_options: { adapter }, boot_facts: BOOT };
		const owner = await claimDelegationExecutionOwnerV2(root, initial, time(41), options);
		assert.equal(owner.ok, true, owner.ok ? "" : owner.error.code);
		const runningState = await persistRunningDelegationTransaction(root, {
			delegation_id: id,
			contract_hash: CONTRACT,
			worker_identity: initial.worker_identity,
			expected_generation: 1,
			expected_revision: 0,
			now: time(42),
		});
		assert.equal(runningState.ok, true);
		if (!runningState.ok) return;
		const recovery = await persistRecoveryRequiredDelegationTransaction(root, {
			delegation_id: id,
			contract_hash: CONTRACT,
			worker_identity: initial.worker_identity,
			expected_generation: 1,
			expected_revision: 1,
			now: time(43),
			reason: RETRYABLE_EMPTY_RECOVERY_REASONS_V2.workerRunnerFailed,
		});
		assert.equal(recovery.ok, true);
		if (!recovery.ok) return;
		assert.equal(await isStrictRetryableEmptyRepairRecoveryV2(root, recovery.value, options), false,
			"a live owner blocks retry");
		alive = false;
		assert.equal(await isStrictRetryableEmptyRepairRecoveryV2(root, recovery.value, options), false,
			"a dead but not yet released owner remains blocking");
		assert.deepEqual(await releaseOrphanedTerminalExecutionOwnerV2(root, recovery.value, options), { status: "released" });
		assert.equal(await isStrictRetryableEmptyRepairRecoveryV2(root, recovery.value, options), true);
		const evidence = await readStrictRetryableRawRepairEvidenceV1(root, recovery.value, options);
		assert.equal(evidence.ok, true, evidence.ok ? "" : evidence.code);
		if (evidence.ok) {
			assert.equal(evidence.value.retry_kind, "EMPTY_RECOVERY");
			assert.equal(evidence.value.journal_present, true);
			assert.deepEqual(evidence.value.inventory, ["transaction.json:file", "write-journal.json:file"]);
			assert.match(evidence.value.evidence_hash, /^[a-f0-9]{64}$/u);
		}
		await writeFile(join(paths(root, id).v2, "unexpected.json"), "{}\n", "utf8");
		assert.equal(await isStrictRetryableEmptyRepairRecoveryV2(root, recovery.value, options), false,
			"extra recovery artifacts revoke retry authority");
		assert.deepEqual(await readStrictRetryableRawRepairEvidenceV1(root, recovery.value, options), {
			ok: false,
			code: "NOT_RETRYABLE",
		});
	});
});

test("lineaged post-worker finalization recovery binds a non-empty sealed journal", async () => {
	await withTempDir(async (root) => {
		const rootId = "20260822-172342-root";
		const id = "20260822-172343-fin1";
		const initial = await preparedTransactionOnly(root, id, repairLineage(rootId));
		const created = await createWorkerWriteJournal({ project_root: root, delegation_id: id, contract_hash: CONTRACT });
		assert.equal(created.ok, true);
		const runningState = await persistRunningDelegationTransaction(root, {
			delegation_id: id,
			contract_hash: CONTRACT,
			worker_identity: initial.worker_identity,
			expected_generation: 1,
			expected_revision: 0,
			now: time(42),
		});
		assert.equal(runningState.ok, true);
		const begun = await beginWriteJournalOperation({
			project_root: root,
			delegation_id: id,
			contract_hash: CONTRACT,
			expected_revision: 0,
			operation_id: "f".repeat(64),
			kind: "write",
			path: "src/rejected.ts",
		});
		assert.equal(begun.ok, true);
		if (!begun.ok) return;
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "rejected.ts"), "worker-final\n", "utf8");
		const completed = await completeWriteJournalOperation({
			project_root: root,
			delegation_id: id,
			contract_hash: CONTRACT,
			expected_revision: begun.value.revision,
			operation_id: "f".repeat(64),
			kind: "write",
			path: "src/rejected.ts",
			outcome: "succeeded",
		});
		assert.equal(completed.ok, true);
		if (!completed.ok) return;
		const sealed = await sealWorkerWriteJournal({
			project_root: root,
			delegation_id: id,
			contract_hash: CONTRACT,
			expected_revision: completed.value.revision,
		});
		assert.equal(sealed.ok, true);
		const recovery = await persistRecoveryRequiredDelegationTransaction(root, {
			delegation_id: id,
			contract_hash: CONTRACT,
			worker_identity: initial.worker_identity,
			expected_generation: 1,
			expected_revision: 1,
			now: time(43),
			reason: RETRYABLE_EMPTY_RECOVERY_REASONS_V2.changeSetFinalizeFailed,
		});
		assert.equal(recovery.ok, true);
		if (!recovery.ok) return;
		const evidence = await readStrictRetryableRawRepairEvidenceV1(root, recovery.value);
		assert.equal(evidence.ok, true, evidence.ok ? "" : evidence.code);
		if (evidence.ok) {
			assert.equal(evidence.value.retry_kind, "FINALIZATION_RECOVERY");
			assert.equal(evidence.value.journal_present, true);
			assert.match(evidence.value.evidence_hash, /^[a-f0-9]{64}$/u);
		}
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
