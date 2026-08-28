import assert from "node:assert/strict";
import { mkdir, readFile, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	closeInactiveProjectDelegationBlockerV2,
	projectDelegationDispositionV2,
	quarantineProjectDelegationAuthorityV1,
	readProjectDelegationBlockerV2,
	readProjectDelegationRepairClosureV1,
	readLatestProjectDelegationTransactionV2,
	readRecoverableUnpublishedDelegationV2,
	reconcileProjectDelegationAuthorityV2,
} from "../extensions/workbench-runtime/core/delegation-project-authority.ts";
import {
	inactiveBlockerRelevantPathsV2,
	publishDelegationInactiveBlockerClosureV2,
} from "../extensions/workbench-runtime/core/delegation-authority-closure.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { emptyDelegationState } from "../extensions/workbench-runtime/core/delegation-state.ts";
import {
	claimDelegationExecutionOwnerV2,
	readDelegationExecutionOwnerV2,
	type DelegationExecutionOwnerOptionsV2,
} from "../extensions/workbench-runtime/core/delegation-execution-owner.ts";
import {
	createNodeDelegationTransactionStorageAdapter,
	persistAbortedDelegationTransaction,
	persistCommittingDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRecoveryRequiredDelegationTransaction,
	persistRunningDelegationTransaction,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	beginDelegationCommit,
	bindDelegationRepairLineageV1,
	DELEGATION_COMMITTED_RECORD_NAMES,
	delegationCommitMarker,
	publishDelegationCommit,
	startDelegationTransaction,
	type DelegationCasInput,
	type DelegationCommittedGenerationProof,
	type DelegationRepairLineageV1,
	type DelegationTransactionRecord,
	type DelegationTransactionResult,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import {
	beginWriteJournalOperation,
	completeWriteJournalOperation,
	createWorkerWriteJournal,
	sealWorkerWriteJournal,
} from "../extensions/workbench-runtime/core/write-journal.ts";
import { collectWorkspaceGuard } from "../extensions/workbench-runtime/core/workspace-guard.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

const HASH = "a".repeat(64);

function at(second: number): string {
	return `2026-08-20T10:00:${String(second).padStart(2, "0")}.000Z`;
}

function repairLineage(parent: string): DelegationRepairLineageV1 {
	const lineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: parent,
		repair_of: parent,
		root_decision_hash: "b".repeat(64),
		continuation_decision_delegation_id: parent,
		continuation_decision_hash: "b".repeat(64),
		parent_lineage_hash: null,
		depth: 1,
		carried_paths: ["src/rejected.ts"],
	});
	if (lineage === undefined) throw new Error("invalid repair-lineage test fixture");
	return lineage;
}

async function prepared(root: string, id: string, second: number, lineage?: DelegationRepairLineageV1): Promise<DelegationTransactionRecord> {
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
		...(lineage === undefined ? {} : { repair_lineage: lineage }),
	});
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

function transactionState(result: DelegationTransactionResult): DelegationTransactionRecord {
	assert.equal(result.ok, true, result.ok ? "" : result.error);
	return result.state;
}

function transactionCas(state: DelegationTransactionRecord, second: number): DelegationCasInput {
	return {
		delegation_id: state.delegation_id,
		contract_hash: state.contract_hash,
		worker_identity: state.worker_identity,
		expected_generation: state.generation,
		expected_revision: state.revision,
		now: at(second),
	};
}

function committedProof(state: DelegationTransactionRecord): DelegationCommittedGenerationProof {
	const payload: Omit<DelegationCommittedGenerationProof, "commit_marker"> = {
		schema_version: 2,
		delegation_id: state.delegation_id,
		task_kind: state.task_kind,
		contract_hash: state.contract_hash,
		worker_identity: state.worker_identity,
		generation: state.generation,
		revision: state.revision,
		record_names: [...DELEGATION_COMMITTED_RECORD_NAMES],
		record_count: DELEGATION_COMMITTED_RECORD_NAMES.length,
		content_hash: "e".repeat(64),
	};
	return { ...payload, commit_marker: delegationCommitMarker(payload) };
}

async function recoverableUnpublished(
	root: string,
	id: string,
	ownerOptions?: DelegationExecutionOwnerOptionsV2,
): Promise<DelegationTransactionRecord> {
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
	if (ownerOptions !== undefined) {
		const owner = await claimDelegationExecutionOwnerV2(root, initial, at(1), ownerOptions);
		if (!owner.ok) throw new Error(owner.error.code);
	}
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

test("repair closure distinguishes v1-only history from incomplete or identity-mismatched v2 authority", async () => {
	await withTempDir(async (root) => {
		const legacyId = "20260820-095959-v1ok";
		await mkdir(join(root, CONFIG_DIR_NAME, "workbench", "delegations", legacyId), { recursive: true });
		assert.deepEqual(await readProjectDelegationRepairClosureV1(root), {
			ok: true, unresolvedTipId: null, rootCount: 0, lineageCount: 0,
		});

		const incompleteId = "20260820-100000-inc1";
		await mkdir(join(root, CONFIG_DIR_NAME, "workbench", "delegations", incompleteId, "v2"), { recursive: true });
		const incomplete = await readProjectDelegationRepairClosureV1(root);
		assert.equal(incomplete.ok, false);
		if (!incomplete.ok) assert.equal(incomplete.issue.code, "incomplete_v2_authority");
	});
	await withTempDir(async (root) => {
		const sourceId = "20260820-100000-src1";
		const foreignId = "20260820-100001-frn1";
		await prepared(root, sourceId, 0);
		const source = join(root, CONFIG_DIR_NAME, "workbench", "delegations", sourceId, "v2", "transaction.json");
		const foreign = join(root, CONFIG_DIR_NAME, "workbench", "delegations", foreignId, "v2", "transaction.json");
		await mkdir(join(root, CONFIG_DIR_NAME, "workbench", "delegations", foreignId, "v2"), { recursive: true });
		await writeFile(foreign, await readFile(source));
		const latestMismatch = await readLatestProjectDelegationTransactionV2(root);
		assert.equal(latestMismatch.ok, false);
		if (!latestMismatch.ok) assert.equal(latestMismatch.error.delegation_id, foreignId);
		const mismatch = await readProjectDelegationRepairClosureV1(root);
		assert.equal(mismatch.ok, false);
		if (!mismatch.ok) assert.equal(mismatch.issue.code, "repair_lineage_identity_mismatch");
	});
});

test("reconcile never treats an incomplete v2-only project as having no delegation authority", async () => {
	await withTempDir(async (root) => {
		const incompleteId = "20260820-100000-inc2";
		await mkdir(join(root, CONFIG_DIR_NAME, "workbench", "delegations", incompleteId, "v2"), { recursive: true });
		const reconciled = await reconcileProjectDelegationAuthorityV2({
			project_root: root,
			current_state: emptyDelegationState(),
			now: "2026-08-20T10:00:01.000Z",
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		});
		assert.equal(reconciled.ok, false);
		if (!reconciled.ok) {
			assert.equal(reconciled.issue.code, "incomplete_v2_authority");
			assert.equal(reconciled.issue.delegationId, incompleteId);
		}
	});
});

test("an unreadable ownerless v2 envelope can be quarantined without deleting it and later bytes require a new receipt", async () => {
	await withTempDir(async (root) => {
		const id = "20260820-100000-qrn1";
		const v2 = join(root, CONFIG_DIR_NAME, "workbench", "delegations", id, "v2");
		await mkdir(v2, { recursive: true });
		const before = await readProjectDelegationRepairClosureV1(root);
		assert.equal(before.ok, false);
		if (!before.ok) assert.equal(before.issue.code, "incomplete_v2_authority");

		const quarantined = await quarantineProjectDelegationAuthorityV1({
			project_root: root,
			delegation_id: id,
			now: at(1),
			quarantined_by: { provider: "openai", model: "gpt-5.6-sol" },
		});
		assert.equal(quarantined.ok, true, quarantined.ok ? "" : quarantined.code);
		assert.equal(quarantined.ok && (await readFile(join(
			root, CONFIG_DIR_NAME, "workbench", "delegation-authority-quarantine-v1", id,
			`${quarantined.value.inventory_hash}.json`,
		), "utf8")).includes(id), true);
		assert.deepEqual(await readLatestProjectDelegationTransactionV2(root), { ok: true, value: null });
		assert.deepEqual(await readProjectDelegationRepairClosureV1(root), {
			ok: true, unresolvedTipId: null, rootCount: 0, lineageCount: 0,
		});
		const replayed = await quarantineProjectDelegationAuthorityV1({
			project_root: root,
			delegation_id: id,
			now: at(2),
			quarantined_by: { provider: "openai", model: "gpt-5.6-sol" },
		});
		assert.deepEqual(replayed, quarantined);

		await writeFile(join(v2, "late.tmp"), "changed after quarantine\n", "utf8");
		const changed = await readProjectDelegationRepairClosureV1(root);
		assert.equal(changed.ok, false);
		if (!changed.ok) assert.equal(changed.issue.code, "incomplete_v2_authority");
		const requarantined = await quarantineProjectDelegationAuthorityV1({
			project_root: root,
			delegation_id: id,
			now: at(3),
			quarantined_by: { provider: "openai", model: "gpt-5.6-sol" },
		});
		assert.equal(requarantined.ok, true, requarantined.ok ? "" : requarantined.code);
		assert.equal(requarantined.ok && quarantined.ok && requarantined.value.inventory_hash !== quarantined.value.inventory_hash, true);
		assert.deepEqual(await readLatestProjectDelegationTransactionV2(root), { ok: true, value: null });
	});
});

test("quarantine preserves the public not-found refusal for an absent authority envelope", async () => {
	await withTempDir(async (root) => {
		const id = "20260820-100000-qnil";
		assert.deepEqual(await quarantineProjectDelegationAuthorityV1({
			project_root: root,
			delegation_id: id,
			now: at(1),
			quarantined_by: { provider: "openai", model: "gpt-5.6-sol" },
		}), { ok: false, code: "authority_not_found", delegation_id: id });
	});
});

test("an unreadable envelope with an active lock stays fail-closed and is never advertised as quarantinable", async () => {
	await withTempDir(async (root) => {
		const id = "20260820-100000-qact";
		const v2 = join(root, CONFIG_DIR_NAME, "workbench", "delegations", id, "v2");
		await mkdir(v2, { recursive: true });
		await writeFile(join(v2, "transaction.lock"), "{}\n", "utf8");
		const latest = await readLatestProjectDelegationTransactionV2(root);
		assert.equal(latest.ok, false);
		if (!latest.ok) assert.equal(latest.error.cause, "authority_not_quarantinable");
		const quarantined = await quarantineProjectDelegationAuthorityV1({
			project_root: root,
			delegation_id: id,
			now: at(1),
			quarantined_by: { provider: "openai", model: "gpt-5.6-sol" },
		});
		assert.deepEqual(quarantined, { ok: false, code: "authority_quarantine_not_recoverable", delegation_id: id });
	});
});

test("inactive blocker closure requires only its exact changed paths clean and preserves unrelated dirt", async () => {
	await withTempDir(async (root) => {
		assert.equal((await spawnExec("git", ["init", "-q"], { cwd: root })).code, 0);
		await writeFile(join(root, "README.md"), "baseline\n", "utf8");
		assert.equal((await spawnExec("git", ["add", "README.md"], { cwd: root })).code, 0);
		assert.equal((await spawnExec("git", ["-c", "user.name=Workbench Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "baseline"], { cwd: root })).code, 0);
		const id = "20260820-100000-cls1";
		const initial = await prepared(root, id, 0);
		const journal = await createWorkerWriteJournal({ project_root: root, delegation_id: id, contract_hash: initial.contract_hash });
		assert.equal(journal.ok, true, journal.ok ? "" : journal.error.code);
		if (!journal.ok) return;
		const running = await persistRunningDelegationTransaction(root, {
			delegation_id: id, contract_hash: initial.contract_hash, worker_identity: initial.worker_identity,
			expected_generation: initial.generation, expected_revision: initial.revision, now: at(1),
		});
		assert.equal(running.ok, true, running.ok ? "" : running.error.code);
		if (!running.ok) return;
		const begun = await beginWriteJournalOperation({
			project_root: root,
			delegation_id: id,
			contract_hash: initial.contract_hash,
			expected_revision: journal.value.revision,
			operation_id: "1".repeat(64),
			kind: "write",
			path: "src/rejected.ts",
		});
		assert.equal(begun.ok, true, begun.ok ? "" : begun.error.code);
		if (!begun.ok) return;
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "rejected.ts"), "discard me\n", "utf8");
		const completed = await completeWriteJournalOperation({
			project_root: root,
			delegation_id: id,
			contract_hash: initial.contract_hash,
			expected_revision: begun.value.revision,
			operation_id: "1".repeat(64),
			kind: "write",
			path: "src/rejected.ts",
			outcome: "succeeded",
		});
		assert.equal(completed.ok, true, completed.ok ? "" : completed.error.code);
		if (!completed.ok) return;
		const sealed = await sealWorkerWriteJournal({
			project_root: root,
			delegation_id: id,
			contract_hash: initial.contract_hash,
			expected_revision: completed.value.revision,
		});
		assert.equal(sealed.ok, true, sealed.ok ? "" : sealed.error.code);
		const committing = await persistCommittingDelegationTransaction(root, {
			delegation_id: id, contract_hash: running.value.contract_hash, worker_identity: running.value.worker_identity,
			expected_generation: running.value.generation, expected_revision: running.value.revision, now: at(2),
			outcome: {
				delegation_id: id, task_kind: "implementation", worker_identity: running.value.worker_identity,
				provider_success: true, exit_code: 0, report_complete: true, terminal_facts_complete: true,
				scope_complete: true, change_set_status: "ATTRIBUTED", changed_paths: ["src/rejected.ts"],
				successful_write_count: 1, denied_write_count: 0, delta_hash: "d".repeat(64),
			},
		});
		assert.equal(committing.ok, true, committing.ok ? "" : committing.error.code);
		if (!committing.ok) return;
		const recovery = await persistRecoveryRequiredDelegationTransaction(root, {
			delegation_id: id, contract_hash: committing.value.contract_hash, worker_identity: committing.value.worker_identity,
			expected_generation: committing.value.generation, expected_revision: committing.value.revision,
			now: at(3), reason: "committed artifact construction failed",
		});
		assert.equal(recovery.ok, true, recovery.ok ? "" : recovery.error.code);
		await writeFile(join(root, "notes.txt"), "unrelated user work\n", "utf8");

		const dirty = await closeInactiveProjectDelegationBlockerV2({
			project_root: root, expected_delegation_id: id, now: at(4), exec: spawnExec,
			closed_by: { provider: "openai", model: "gpt-5.6-sol" },
		});
		assert.equal(dirty.ok, false);
		if (!dirty.ok) assert.equal(dirty.code, "relevant_paths_not_clean");

		await unlink(join(root, "src", "rejected.ts"));
		const closed = await closeInactiveProjectDelegationBlockerV2({
			project_root: root, expected_delegation_id: id, now: at(5), exec: spawnExec,
			closed_by: { provider: "openai", model: "gpt-5.6-sol" },
		});
		assert.equal(closed.ok, true, closed.ok ? "" : closed.code);
		assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "unrelated user work\n");
		assert.deepEqual(await readProjectDelegationBlockerV2(root), { ok: true, value: null });
	});
});

test("inactive blocker closure accepts committed zero delta under directory scope but keeps unknown delta fail-closed", async () => {
	await withTempDir(async (root) => {
		assert.equal((await spawnExec("git", ["init", "-q"], { cwd: root })).code, 0);
		await writeFile(join(root, "README.md"), "baseline\n", "utf8");
		assert.equal((await spawnExec("git", ["add", "README.md"], { cwd: root })).code, 0);
		assert.equal((await spawnExec("git", ["-c", "user.name=Workbench Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "baseline"], { cwd: root })).code, 0);

		const failedState = async (
			id: string,
			changeSetStatus: "ATTRIBUTED" | "WORKSPACE_DRIFT" | "CONFLICT",
			terminalFactsComplete = true,
		): Promise<DelegationTransactionRecord> => {
			const initial = await prepared(root, id, 0);
			const running = transactionState(startDelegationTransaction(initial, transactionCas(initial, 1)));
			const committing = transactionState(beginDelegationCommit(running, {
				...transactionCas(running, 2),
				outcome: {
					delegation_id: id,
					task_kind: "implementation",
					worker_identity: running.worker_identity,
					provider_success: true,
					exit_code: 0,
					report_complete: true,
					terminal_facts_complete: terminalFactsComplete,
					scope_complete: true,
					change_set_status: changeSetStatus,
					changed_paths: [],
					successful_write_count: 0,
					denied_write_count: 0,
					delta_hash: "d".repeat(64),
				},
			}));
			return transactionState(publishDelegationCommit(committing, {
				...transactionCas(committing, 3),
				proof: committedProof(committing),
			}));
		};

		const attributed = await failedState("20260820-100000-zd01", "ATTRIBUTED");
		assert.equal(attributed.status, "FAILED");
		assert.deepEqual(attributed.allowed_paths, ["src/**"]);
		assert.deepEqual(inactiveBlockerRelevantPathsV2(attributed), []);

		const drift = await failedState("20260820-100001-zd02", "WORKSPACE_DRIFT");
		assert.equal(drift.status, "FAILED");
		assert.deepEqual(inactiveBlockerRelevantPathsV2(drift), []);
		await writeFile(join(root, "notes.txt"), "unrelated user work\n", "utf8");
		const guard = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(guard.ok, true, guard.ok ? "" : guard.error.code);
		if (!guard.ok) return;
		const closed = await publishDelegationInactiveBlockerClosureV2({
			project_root: root,
			transaction: drift,
			workspace_guard: guard.guard,
			closed_by: { provider: "openai", model: "gpt-5.6-sol" },
			now: at(4),
		});
		assert.equal(closed.ok, true, closed.ok ? "" : closed.error.code);
		if (closed.ok) assert.deepEqual(closed.value.relevant_paths, []);
		assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "unrelated user work\n");

		const conflicted = await failedState("20260820-100002-zd03", "CONFLICT");
		assert.equal(conflicted.status, "FAILED");
		assert.equal(inactiveBlockerRelevantPathsV2(conflicted), undefined);
		const incomplete = await failedState("20260820-100003-zd04", "ATTRIBUTED", false);
		assert.equal(incomplete.status, "RECOVERY_REQUIRED");
		assert.equal(inactiveBlockerRelevantPathsV2(incomplete), undefined);
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

test("an aborted repair attempt remains blocking so it cannot hide its unresolved parent", async () => {
	await withTempDir(async (root) => {
		const parent = "20260820-100001-prnt";
		const repair = await prepared(root, "20260820-100002-rpr1", 0, repairLineage(parent));
		const aborted = await persistAbortedDelegationTransaction(root, {
			delegation_id: repair.delegation_id,
			contract_hash: repair.contract_hash,
			worker_identity: repair.worker_identity,
			expected_generation: repair.generation,
			expected_revision: repair.revision,
			now: at(1),
			reason: "repair process ended before launch",
		});
		assert.equal(aborted.ok, true);
		if (!aborted.ok) return;
		assert.deepEqual(projectDelegationDispositionV2(aborted.value), { blocking: true, terminal_verdict: "FAIL" });
		const latest = await readLatestProjectDelegationTransactionV2(root);
		assert.equal(latest.ok, true);
		if (latest.ok) assert.equal(latest.value?.repair_lineage?.root_delegation_id, parent);
	});
});

test("a zero-delta failed repair remains blocking while an ordinary zero-delta failure stays compatible", async () => {
	await withTempDir(async (root) => {
		const parent = "20260820-100001-prnt";
		const repair = await prepared(root, "20260820-100002-rpr2", 0, repairLineage(parent));
		const zeroDeltaFailure = {
			...repair,
			status: "FAILED" as const,
			terminal_outcome: {
				delegation_id: repair.delegation_id,
				task_kind: "implementation" as const,
				worker_identity: repair.worker_identity,
				provider_success: false,
				exit_code: 1,
				report_complete: false,
				terminal_facts_complete: true,
				scope_complete: true,
				change_set_status: "ATTRIBUTED" as const,
				changed_paths: [],
				successful_write_count: 0,
				denied_write_count: 0,
				delta_hash: "c".repeat(64),
			},
		};
		assert.deepEqual(projectDelegationDispositionV2(zeroDeltaFailure), { blocking: true, terminal_verdict: "FAIL" });
		const { repair_lineage: _lineage, ...ordinaryZeroDeltaFailure } = zeroDeltaFailure;
		assert.deepEqual(projectDelegationDispositionV2(ordinaryZeroDeltaFailure), {
			blocking: false,
			terminal_verdict: "FAIL",
		});
	});
});

test("attributed interrupted partial work remains a fail-closed project blocker", async () => {
	await withTempDir(async (root) => {
		const initial = await prepared(root, "20260820-100010-int1", 0);
		const running = transactionState(startDelegationTransaction(initial, transactionCas(initial, 1)));
		const committing = transactionState(beginDelegationCommit(running, {
			...transactionCas(running, 2),
			outcome: {
				delegation_id: running.delegation_id,
				task_kind: "implementation",
				worker_identity: running.worker_identity,
				provider_success: true,
				worker_success: false,
				worker_failure_code: "TIMED_OUT",
				exit_code: 0,
				report_complete: true,
				terminal_facts_complete: true,
				scope_complete: true,
				change_set_status: "ATTRIBUTED",
				changed_paths: ["src/interrupted.ts"],
				successful_write_count: 1,
				denied_write_count: 0,
				delta_hash: "c".repeat(64),
			},
		}));
		const interrupted = transactionState(publishDelegationCommit(committing, {
			...transactionCas(committing, 3),
			proof: committedProof(committing),
		}));
		assert.equal(interrupted.status, "INTERRUPTED");
		assert.deepEqual(projectDelegationDispositionV2(interrupted), {
			blocking: true,
			terminal_verdict: "FAIL",
		});
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

test("a proof-null inactive recovery closes from its sealed empty journal under directory scope", async () => {
	await withTempDir(async (root) => {
		assert.equal((await spawnExec("git", ["init", "-q"], { cwd: root })).code, 0);
		await writeFile(join(root, "README.md"), "baseline\n", "utf8");
		assert.equal((await spawnExec("git", ["add", "README.md"], { cwd: root })).code, 0);
		assert.equal((await spawnExec("git", ["-c", "user.name=Workbench Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "baseline"], { cwd: root })).code, 0);
		const id = "20260820-100003-rp02";
		const recovery = await recoverableUnpublished(root, id);
		assert.equal(recovery.status, "RECOVERY_REQUIRED");
		assert.equal(recovery.committed_proof, null);
		await writeFile(join(root, "notes.txt"), "unrelated user work\n", "utf8");

		const closed = await closeInactiveProjectDelegationBlockerV2({
			project_root: root,
			expected_delegation_id: id,
			now: at(4),
			exec: spawnExec,
			closed_by: { provider: "openai", model: "gpt-5.6-sol" },
		});
		assert.equal(closed.ok, true, closed.ok ? "" : closed.code);
		if (closed.ok) assert.deepEqual(closed.value.relevant_paths, []);
		assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "unrelated user work\n");
		assert.deepEqual(await readProjectDelegationBlockerV2(root), { ok: true, value: null });
	});
});

test("reconcile releases a provably dead terminal owner before exposing unpublished repair authority", async () => {
	await withTempDir(async (root) => {
		const id = "20260820-100003-own1";
		let alive = true;
		const adapter = {
			...createNodeDelegationTransactionStorageAdapter(),
			processId: 787_878,
			isProcessAlive: () => alive,
		};
		const ownerOptions: DelegationExecutionOwnerOptionsV2 = {
			storage_options: { adapter },
			boot_facts: {
				boot_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				system_boot_time_ms: Date.parse("2026-08-20T09:00:00.000Z"),
				runtime_started_at: "2026-08-20T09:00:01.000Z",
			},
			read_process_start_ticks: async () => "500",
		};
		const recovery = await recoverableUnpublished(root, id, ownerOptions);
		assert.equal((await readDelegationExecutionOwnerV2(root, recovery, ownerOptions)).ok, true);

		const live = await reconcileProjectDelegationAuthorityV2({
			project_root: root,
			current_state: emptyDelegationState(),
			now: at(10),
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			interruption_recovery_options: ownerOptions,
		});
		assert.equal(live.ok, false);
		if (!live.ok) assert.equal(live.issue.code, "execution_owner_active");

		alive = false;
		const reconciled = await reconcileProjectDelegationAuthorityV2({
			project_root: root,
			current_state: emptyDelegationState(),
			now: at(11),
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			interruption_recovery_options: ownerOptions,
		});
		assert.equal(reconciled.ok, true, reconciled.ok ? "" : reconciled.issue.code);
		assert.equal((await readDelegationExecutionOwnerV2(root, recovery, ownerOptions)).ok, false);
		assert.equal((await readRecoverableUnpublishedDelegationV2(root, id)).ok, true);
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
