import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	commitDelegationGeneration,
	createNodeDelegationTransactionStorageAdapter,
	DELEGATION_TRANSACTION_REPORT_MAX_BYTES,
	DELEGATION_TRANSACTION_SCOPE_RECORD_MAX_BYTES,
	DELEGATION_TRANSACTION_STORAGE_FAULT_POINTS,
	delegationGenerationRecordRelativePathV2,
	hashDelegationCommittedRecords,
	persistAbortedDelegationTransaction,
	persistCommittingDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRecoveryRequiredDelegationTransaction,
	persistReviewedDelegationTransaction,
	persistRunningDelegationTransaction,
	readDelegationCommittedGenerationV2,
	readDelegationTransactionV2,
	verifyDelegationGenerationV2,
	type CommitDelegationGenerationInput,
	type DelegationCommittedRecords,
	type DelegationTransactionStorageAdapter,
	type DelegationTransactionStorageFaultPoint,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
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

async function cleanup(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}

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
