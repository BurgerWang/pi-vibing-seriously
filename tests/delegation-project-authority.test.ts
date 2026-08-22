import assert from "node:assert/strict";
import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	projectDelegationDispositionV2,
	readLatestProjectDelegationTransactionV2,
	readRecoverableUnpublishedDelegationV2,
	reconcileProjectDelegationAuthorityV2,
} from "../extensions/workbench-runtime/core/delegation-project-authority.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { emptyDelegationState } from "../extensions/workbench-runtime/core/delegation-state.ts";
import {
	persistAbortedDelegationTransaction,
	persistCommittingDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRecoveryRequiredDelegationTransaction,
	persistRunningDelegationTransaction,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import type { DelegationTransactionRecord } from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { createWorkerWriteJournal, sealWorkerWriteJournal } from "../extensions/workbench-runtime/core/write-journal.ts";
import { withTempDir } from "./helpers.ts";

const HASH = "a".repeat(64);

function at(second: number): string {
	return `2026-08-20T10:00:${String(second).padStart(2, "0")}.000Z`;
}

async function prepared(root: string, id: string, second: number): Promise<DelegationTransactionRecord> {
	const result = await persistPreparedDelegationTransaction(root, {
		delegation_id: id,
		task_kind: "implementation",
		contract_hash: HASH,
		allowed_paths: ["src/**"],
		worker_identity: {
			provider: WORKER_PROVIDER,
			model: WORKER_MODEL_ID,
			worker_id: `worker:${id}`,
		},
		generation: 1,
		now: at(second),
	});
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

async function recoverableUnpublished(root: string, id: string): Promise<DelegationTransactionRecord> {
	const initial = await prepared(root, id, 0);
	const journal = await createWorkerWriteJournal({
		project_root: root,
		delegation_id: id,
		contract_hash: initial.contract_hash,
	});
	if (!journal.ok) throw new Error(journal.error.code);
	const sealed = await sealWorkerWriteJournal({
		project_root: root,
		delegation_id: id,
		contract_hash: initial.contract_hash,
		expected_revision: journal.value.revision,
	});
	if (!sealed.ok) throw new Error(sealed.error.code);
	const cas = (state: DelegationTransactionRecord, second: number) => ({
		delegation_id: state.delegation_id,
		contract_hash: state.contract_hash,
		worker_identity: state.worker_identity,
		expected_generation: state.generation,
		expected_revision: state.revision,
		now: at(second),
	});
	const running = await persistRunningDelegationTransaction(root, cas(initial, 1));
	if (!running.ok) throw new Error(running.error.code);
	const committing = await persistCommittingDelegationTransaction(root, {
		...cas(running.value, 2),
		outcome: {
			delegation_id: id,
			task_kind: "implementation",
			worker_identity: initial.worker_identity,
			provider_success: true,
			exit_code: 0,
			report_complete: true,
			terminal_facts_complete: true,
			scope_complete: true,
			change_set_status: "ATTRIBUTED",
			changed_paths: [],
			successful_write_count: 0,
			denied_write_count: 0,
			delta_hash: "b".repeat(64),
		},
	});
	if (!committing.ok) throw new Error(committing.error.code);
	const recovery = await persistRecoveryRequiredDelegationTransaction(root, {
		...cas(committing.value, 3),
		reason: "committed artifact construction failed",
	});
	if (!recovery.ok) throw new Error(recovery.error.code);
	return recovery.value;
}

test("project authority discovery returns null when no delegation root exists", async () => {
	await withTempDir(async (root) => {
		assert.deepEqual(await readLatestProjectDelegationTransactionV2(root), { ok: true, value: null });
	});
});

test("project authority discovers the newest v2 transaction and ignores newer v1-only directories", async () => {
	await withTempDir(async (root) => {
		const older = "20260820-100000-old1";
		const sameSecondOlder = "20260820-100001-a001";
		const sameSecondNewer = "20260820-100001-z999";
		await prepared(root, older, 0);
		await prepared(root, sameSecondOlder, 1);
		await prepared(root, sameSecondNewer, 2);
		await mkdir(join(root, CONFIG_DIR_NAME, "workbench", "delegations", "20260820-100002-v1ok"), { recursive: true });

		const latest = await readLatestProjectDelegationTransactionV2(root);
		assert.equal(latest.ok, true);
		if (latest.ok) assert.equal(latest.value?.delegation_id, sameSecondNewer);
	});
});

test("project authority fails closed on a corrupt newest v2 transaction", async () => {
	await withTempDir(async (root) => {
		await prepared(root, "20260820-100000-good", 0);
		const corruptId = "20260820-100001-bad1";
		const corrupt = join(root, CONFIG_DIR_NAME, "workbench", "delegations", corruptId, "v2", "transaction.json");
		await mkdir(join(corrupt, ".."), { recursive: true });
		await writeFile(corrupt, "{\"schema_version\":2", "utf8");

		const latest = await readLatestProjectDelegationTransactionV2(root);
		assert.equal(latest.ok, false);
		if (!latest.ok) {
			assert.equal(latest.error.code, "invalid_project_authority");
			assert.equal(latest.error.delegation_id, corruptId);
			assert.equal(latest.error.cause, "invalid_record");
		}
	});
});

test("project authority rejects a valid-id symlink and classifies durable blocking state", async () => {
	await withTempDir(async (root) => {
		const safe = await prepared(root, "20260820-100000-safe", 0);
		const rootDir = join(root, CONFIG_DIR_NAME, "workbench", "delegations");
		await symlink(join(rootDir, safe.delegation_id), join(rootDir, "20260820-100001-link"));
		const latest = await readLatestProjectDelegationTransactionV2(root);
		assert.equal(latest.ok, false);
		if (!latest.ok) assert.equal(latest.error.delegation_id, "20260820-100001-link");

		assert.deepEqual(projectDelegationDispositionV2(safe), { blocking: true, terminal_verdict: null });
		const aborted = await persistAbortedDelegationTransaction(root, {
			delegation_id: safe.delegation_id,
			contract_hash: safe.contract_hash,
			worker_identity: safe.worker_identity,
			expected_generation: safe.generation,
			expected_revision: safe.revision,
			now: at(1),
			reason: "bounded test abort",
		});
		assert.equal(aborted.ok, true);
		if (aborted.ok) {
			assert.deepEqual(projectDelegationDispositionV2(aborted.value), { blocking: false, terminal_verdict: "FAIL" });
		}
	});
});

test("only an exact proof-null artifact failure with a sealed journal is recoverable by repair_of", async () => {
	await withTempDir(async (root) => {
		const id = "20260820-100003-rp01";
		const recovery = await recoverableUnpublished(root, id);
		assert.equal(recovery.status, "RECOVERY_REQUIRED");
		assert.equal(recovery.committed_proof, null);
		const accepted = await readRecoverableUnpublishedDelegationV2(root, id);
		assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error.code);
		if (accepted.ok) {
			assert.equal(accepted.value.transaction.delegation_id, id);
			assert.equal(accepted.value.journal.state, "SEALED");
		}

		const generations = join(root, CONFIG_DIR_NAME, "workbench", "delegations", id, "v2", "generations");
		await mkdir(join(generations, "g00000001"), { recursive: true });
		const refused = await readRecoverableUnpublishedDelegationV2(root, id);
		assert.deepEqual(refused, { ok: false, error: { code: "not_recoverable" } });
	});
});

test("project reconciliation terminates a legacy preboot empty RUNNING transaction and unlocks the session mirror", async () => {
	await withTempDir(async (root) => {
		const id = "20260820-100004-boot";
		const initial = await prepared(root, id, 0);
		const journal = await createWorkerWriteJournal({ project_root: root, delegation_id: id, contract_hash: HASH });
		assert.equal(journal.ok, true, journal.ok ? "" : journal.error.code);
		const running = await persistRunningDelegationTransaction(root, {
			delegation_id: id,
			contract_hash: HASH,
			worker_identity: initial.worker_identity,
			expected_generation: 1,
			expected_revision: 0,
			now: at(1),
		});
		assert.equal(running.ok, true, running.ok ? "" : running.error.code);
		if (!running.ok) return;
		const v2 = join(root, CONFIG_DIR_NAME, "workbench", "delegations", id, "v2");
		const preboot = new Date("2026-08-20T10:00:02.000Z");
		await utimes(join(v2, "transaction.json"), preboot, preboot);
		await utimes(join(v2, "write-journal.json"), preboot, preboot);
		const exec: ExecFn = async (_command, args) => args[0] === "rev-parse"
			? { stdout: "", stderr: "", code: 1, killed: false }
			: { stdout: "", stderr: "", code: 0, killed: false };
		const reconciled = await reconcileProjectDelegationAuthorityV2({
			project_root: root,
			current_state: emptyDelegationState(),
			now: "2026-08-20T10:10:00.000Z",
			exec,
			interruption_recovery_options: {
				boot_facts: {
					boot_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
					system_boot_time_ms: Date.parse("2026-08-20T10:05:00.000Z"),
					runtime_started_at: "2026-08-20T10:05:01.000Z",
				},
			},
		});
		assert.equal(reconciled.ok, true, reconciled.ok ? "" : reconciled.issue.code);
		if (!reconciled.ok) return;
		assert.equal(reconciled.state?.latestId, id);
		assert.equal(reconciled.state?.status, "REVIEWED");
		assert.equal(reconciled.state?.reviewedDiffHash, reconciled.state?.currentDiffHash);
		const durable = await readLatestProjectDelegationTransactionV2(root);
		assert.equal(durable.ok && durable.value?.status, "ABORTED");
	});
});
