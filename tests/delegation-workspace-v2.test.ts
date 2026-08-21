import assert from "node:assert/strict";
import test from "node:test";

import { computeChangeSet, type ChangeSetRecord } from "../extensions/workbench-runtime/core/change-set.ts";
import type {
	FinalizedDelegationChangeSetLifecycleV2,
	PreparedDelegationChangeSetLifecycleV2,
} from "../extensions/workbench-runtime/core/delegation-change-set-lifecycle.ts";
import {
	DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2,
	deriveFinalizedDelegationWorkspaceFactsV2,
	derivePreparedDelegationWorkspaceBeforeV2,
} from "../extensions/workbench-runtime/core/delegation-workspace-v2.ts";
import type { StreamingPathIdentity } from "../extensions/workbench-runtime/core/streaming-identity.ts";
import { computeWorkspaceGuardHash, type WorkspaceGuardEntry, type WorkspaceGuardRecord } from "../extensions/workbench-runtime/core/workspace-guard.ts";
import { computeWorkerWriteJournalHash, type WorkerWriteJournalRecord } from "../extensions/workbench-runtime/core/write-journal.ts";

const ID = "20260820-150000-ws01";
const CONTRACT = "a".repeat(64);
const HEAD = "b".repeat(40);
const W = "src/worker.ts";
type FileIdentity = Extract<StreamingPathIdentity, { kind: "file" }>;

function missing(path: string): StreamingPathIdentity {
	return { schema_version: 2, kind: "missing", path };
}

function file(path: string, sha = "c".repeat(64), size = 11, ino = "2"): FileIdentity {
	return {
		schema_version: 2,
		kind: "file",
		path,
		byte_size: size,
		sha256: sha,
		stat: { dev: "1", ino, mtime_ns: "3", ctime_ns: "4" },
	};
}

function entry(identity: StreamingPathIdentity, status = "??"): WorkspaceGuardEntry {
	return {
		path: identity.path,
		status,
		identity: identity.kind === "missing"
			? { kind: "missing" }
			: { kind: "file", byte_size: identity.byte_size, stat: { ...identity.stat } },
	};
}

function guard(entries: readonly WorkspaceGuardEntry[]): WorkspaceGuardRecord {
	const ordered = [...entries].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
	return {
		schema_version: 2,
		git_head: HEAD,
		entries: ordered,
		irrelevant_artifact_paths: [],
		meter: {
			status_bytes: ordered.length * 16,
			relevant_paths: ordered.length,
			irrelevant_paths: 0,
			stat_calls: ordered.length * 2,
			content_bytes_read: 0,
		},
		workspace_guard_hash: computeWorkspaceGuardHash(HEAD, ordered),
	};
}

function lifecycle(preDirtyCount = 0, unsafe: "none" | "drift" | "conflict" = "none"):
	Readonly<FinalizedDelegationChangeSetLifecycleV2> {
	const beforeW = missing(W);
	const afterW = file(W);
	const preDirty = Array.from({ length: preDirtyCount }, (_, index) => {
		const path = `predirty/${String(index).padStart(3, "0")}.ts`;
		return entry(file(path, "d".repeat(64), 7, String(100 + index)), " M");
	});
	const beforeGuard = guard(preDirty);
	const afterEntries = [...preDirty, entry(afterW)];
	if (unsafe === "drift") afterEntries.push(entry(file("foreign.ts", "e".repeat(64), 5, "900"), "??"));
	const afterGuard = guard(afterEntries);
	const limits = {
		max_unique_paths: 500,
		max_operations: 1000,
		max_identity_paths: 500,
		max_total_bytes: 256 * 1024 * 1024,
		max_file_bytes: 64 * 1024 * 1024,
		max_serialized_bytes: 4 * 1024 * 1024,
	};
	const open: WorkerWriteJournalRecord = {
		schema_version: 2,
		delegation_id: ID,
		contract_hash: CONTRACT,
		state: "OPEN",
		revision: 0,
		limits,
		meter: { paths_attempted: 0, paths_completed: 0, bytes_read: 0 },
		operations: [],
		journal_hash: null,
	};
	const sealedBase: WorkerWriteJournalRecord = {
		...open,
		state: "SEALED",
		revision: 3,
		meter: { paths_attempted: 2, paths_completed: 2, bytes_read: afterW.byte_size },
		operations: [{
			sequence: 1,
			operation_id: "f".repeat(64),
			kind: "write",
			path: W,
			status: "completed",
			before: beforeW,
			after: afterW,
			outcome: "succeeded",
		}],
		journal_hash: "0".repeat(64),
	};
	const sealed = { ...sealedBase, journal_hash: computeWorkerWriteJournalHash(sealedBase) };
	const finalIdentity = unsafe === "conflict" ? file(W, "9".repeat(64), 11, "77") : afterW;
	const computed = computeChangeSet({
		delegation_id: ID,
		contract_hash: CONTRACT,
		journal_hash: sealed.journal_hash!,
		journal: sealed,
		before_guard: beforeGuard,
		after_guard: afterGuard,
		dependency_paths: [],
		final_identities: [finalIdentity],
		finalization_meter: { paths_attempted: 1, paths_completed: 1, bytes_read: finalIdentity.byte_size },
	});
	if (!computed.ok) throw new Error(computed.error.code);
	const prepared: PreparedDelegationChangeSetLifecycleV2 = {
		schema_version: 2,
		project_root: "/tmp/delegation-workspace-v2",
		delegation_id: ID,
		contract_hash: CONTRACT,
		dependency_paths: [],
		before_guard: beforeGuard,
		journal: open,
	};
	return { prepared, sealed_journal: sealed, after_guard: afterGuard, change_set: computed.value as ChangeSetRecord };
}

test("guard-v2 prepared facts use the immutable guard hash and read zero content", () => {
	const prepared = lifecycle(200).prepared;
	const result = derivePreparedDelegationWorkspaceBeforeV2(prepared);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.diffIdentityKind, DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2);
	assert.equal(result.value.diffHash, prepared.before_guard.workspace_guard_hash);
	assert.equal(prepared.before_guard.meter.content_bytes_read, 0);
	assert.equal(result.value.changedPaths.length, 200);
	assert.deepEqual(result.value.pathDigests, {});
});

test("0 vs 200 pre-dirty paths never add source-content reads and after exposes only W", () => {
	for (const count of [0, 200]) {
		const source = lifecycle(count);
		const result = deriveFinalizedDelegationWorkspaceFactsV2(source);
		assert.equal(result.ok, true);
		if (!result.ok) continue;
		assert.deepEqual(result.value.after.changedPaths, [W]);
		assert.deepEqual(Object.keys(result.value.after.pathDigests), [W]);
		assert.equal(source.prepared.before_guard.meter.content_bytes_read, 0);
		assert.equal(source.after_guard.meter.content_bytes_read, 0);
		assert.equal(source.sealed_journal.meter.bytes_read + source.change_set.finalization_meter.bytes_read, 22);
	}
});

test("workspace drift and conflict remain nonzero in changedSinceBefore", () => {
	for (const unsafe of ["drift", "conflict"] as const) {
		const source = lifecycle(0, unsafe);
		const result = deriveFinalizedDelegationWorkspaceFactsV2(source);
		assert.equal(result.ok, true, unsafe);
		if (!result.ok) continue;
		assert.notEqual(source.change_set.status, "ATTRIBUTED");
		assert.ok(result.value.after.changedSinceBefore.length > 0);
		assert.ok(result.value.after.changedSinceBefore.includes(W));
		if (unsafe === "drift") assert.ok(result.value.after.changedSinceBefore.includes("foreign.ts"));
	}
});
