import assert from "node:assert/strict";
import test from "node:test";

import {
	computeChangeSet,
	computeChangeSetHash,
	computeWorkerDeltaHash,
	validateChangeSet,
	type ChangeSetAttributedEntry,
	type ChangeSetRecord,
	type ComputeChangeSetInput,
} from "../extensions/workbench-runtime/core/change-set.ts";
import {
	computeWorkerWriteJournalHash,
	type CompletedWriteJournalOperation,
	type WorkerWriteJournalRecord,
} from "../extensions/workbench-runtime/core/write-journal.ts";
import {
	type StreamingPathIdentity,
} from "../extensions/workbench-runtime/core/streaming-identity.ts";
import {
	computeWorkspaceGuardHash,
	type WorkspaceGuardEntry,
	type WorkspaceGuardRecord,
} from "../extensions/workbench-runtime/core/workspace-guard.ts";

const ID = "20260820-120000-a1B2";
const CONTRACT = "1".repeat(64);
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function missing(path: string): StreamingPathIdentity {
	return { schema_version: 2, kind: "missing", path };
}

function file(path: string, sha256 = SHA_A, byteSize = 5, statSeed = 1): StreamingPathIdentity {
	return {
		schema_version: 2,
		kind: "file",
		path,
		byte_size: byteSize,
		sha256,
		stat: {
			dev: String(statSeed),
			ino: String(statSeed + 1),
			mtime_ns: String(statSeed + 2),
			ctime_ns: String(statSeed + 3),
		},
	};
}

function operation(
	sequence: number,
	path: string,
	before: StreamingPathIdentity,
	after: StreamingPathIdentity,
): CompletedWriteJournalOperation {
	return {
		sequence,
		operation_id: sequence.toString(16).padStart(64, "0"),
		kind: "write",
		path,
		status: "completed",
		before,
		after,
		outcome: "succeeded",
	};
}

function journal(operations: readonly CompletedWriteJournalOperation[]): WorkerWriteJournalRecord {
	const bytes = operations.reduce((sum, item) => sum
		+ (item.before.kind === "file" ? item.before.byte_size : 0)
		+ (item.after.kind === "file" ? item.after.byte_size : 0), 0);
	const withoutHash: WorkerWriteJournalRecord = {
		schema_version: 2,
		delegation_id: ID,
		contract_hash: CONTRACT,
		state: "SEALED",
		revision: operations.length * 2 + 1,
		limits: {
			max_unique_paths: 500,
			max_operations: 1000,
			max_identity_paths: 500,
			max_total_bytes: 256 * 1024 * 1024,
			max_file_bytes: 64 * 1024 * 1024,
			max_serialized_bytes: 4 * 1024 * 1024,
		},
		meter: { paths_attempted: operations.length * 2, paths_completed: operations.length * 2, bytes_read: bytes },
		operations,
		journal_hash: "0".repeat(64),
	};
	return { ...withoutHash, journal_hash: computeWorkerWriteJournalHash(withoutHash) };
}

function guardIdentity(identity: StreamingPathIdentity): WorkspaceGuardEntry["identity"] {
	return identity.kind === "missing"
		? { kind: "missing" }
		: { kind: "file", byte_size: identity.byte_size, stat: { ...identity.stat } };
}

function guardEntry(path: string, identity: StreamingPathIdentity, status = " M"): WorkspaceGuardEntry {
	return { path, status, identity: guardIdentity(identity) };
}

function guard(entries: readonly WorkspaceGuardEntry[] = [], irrelevant: readonly string[] = []): WorkspaceGuardRecord {
	const sorted = [...entries].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
	return {
		schema_version: 2,
		git_head: "d".repeat(40),
		entries: sorted,
		irrelevant_artifact_paths: [...irrelevant].sort(),
		meter: {
			status_bytes: 0,
			relevant_paths: sorted.length,
			irrelevant_paths: irrelevant.length,
			stat_calls: sorted.length * 2,
			content_bytes_read: 0,
		},
		workspace_guard_hash: computeWorkspaceGuardHash("d".repeat(40), sorted),
	};
}

function inputFor(
	operations: readonly CompletedWriteJournalOperation[],
	finals: readonly StreamingPathIdentity[],
	beforeGuard = guard(),
	afterGuard = guard(),
	dependencies: readonly string[] = [],
): ComputeChangeSetInput {
	const sealed = journal(operations);
	return {
		delegation_id: ID,
		contract_hash: CONTRACT,
		journal_hash: sealed.journal_hash!,
		journal: sealed,
		before_guard: beforeGuard,
		after_guard: afterGuard,
		dependency_paths: dependencies,
		final_identities: finals,
		finalization_meter: {
			paths_attempted: finals.length,
			paths_completed: finals.length,
			bytes_read: finals.reduce((sum, identity) => sum + (identity.kind === "file" ? identity.byte_size : 0), 0),
		},
	};
}

function success(input: ComputeChangeSetInput) {
	const result = computeChangeSet(input);
	if (!result.ok) throw new Error(result.error.code);
	assert.equal(validateChangeSet(result.value), true);
	return result.value;
}

function reverseKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reverseKeys);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
}

test("attributes new, modify, delete and Unicode paths with deterministic full identities", () => {
	const paths = ["a-new.ts", "b-mod.ts", "c-delete.ts", "src/你好.ts"];
	const operations = [
		operation(1, paths[0]!, missing(paths[0]!), file(paths[0]!, SHA_A, 3, 10)),
		operation(2, paths[1]!, file(paths[1]!, SHA_A, 4, 20), file(paths[1]!, SHA_B, 4, 21)),
		operation(3, paths[2]!, file(paths[2]!, SHA_A, 6, 30), missing(paths[2]!)),
		operation(4, paths[3]!, file(paths[3]!, SHA_A, 7, 40), file(paths[3]!, SHA_C, 8, 41)),
	];
	const value = success(inputFor(operations, operations.map((item) => item.after)));
	assert.equal(value.status, "ATTRIBUTED");
	assert.deepEqual(value.worker_delta.map((entry) => entry.change), ["new", "modify", "delete", "modify"]);
	assert.equal(value.counts.attributed_paths, 4);
	assert.equal(Object.isFrozen(value), true);
});

test("pre-dirty touched path is journal-attributed and repeated operations use first/last authority", () => {
	const path = "src/repeat.ts";
	const before = file(path, SHA_A, 10, 1);
	const middle = file(path, SHA_B, 10, 2);
	const after = file(path, SHA_C, 11, 3);
	const beforeGuard = guard([guardEntry(path, before)]);
	const afterGuard = guard([guardEntry(path, after)]);
	const value = success(inputFor([
		operation(1, path, before, middle),
		operation(2, path, middle, after),
	], [after], beforeGuard, afterGuard));
	assert.equal(value.worker_delta[0]?.operation_count, 2);
	assert.deepEqual(value.worker_delta[0]?.before, before);
	assert.deepEqual(value.worker_delta[0]?.after, after);
});

test("stat-only final change is zero content delta", () => {
	const path = "same.ts";
	const before = file(path, SHA_A, 9, 1);
	const after = file(path, SHA_A, 9, 100);
	const value = success(inputFor([operation(1, path, before, after)], [after]));
	assert.equal(value.worker_delta.length, 0);
	assert.equal(value.counts.zero_delta_paths, 1);
});

test(">4MiB same-size tail hash change is attributed from full SHA facts", () => {
	const path = "large.bin";
	const size = 4 * 1024 * 1024 + 17;
	const before = file(path, SHA_A, size, 1);
	const after = file(path, SHA_B, size, 2);
	const value = success(inputFor([operation(1, path, before, after)], [after]));
	assert.equal(value.worker_delta[0]?.change, "modify");
	assert.equal(value.finalization_meter.bytes_read, size);
});

test("worker delta hash excludes stat but binds content SHA", () => {
	const base: ChangeSetAttributedEntry = {
		path: "hash.ts", change: "modify", operation_count: 1,
		before: file("hash.ts", SHA_A, 5, 1), after: file("hash.ts", SHA_B, 5, 2),
	};
	const statChanged: ChangeSetAttributedEntry = {
		...base, before: file("hash.ts", SHA_A, 5, 99), after: file("hash.ts", SHA_B, 5, 100),
	};
	const contentChanged: ChangeSetAttributedEntry = { ...base, after: file("hash.ts", SHA_C, 5, 2) };
	const repeated: ChangeSetAttributedEntry = { ...base, operation_count: 2 };
	assert.equal(computeWorkerDeltaHash([base], []), computeWorkerDeltaHash([statChanged], []));
	assert.equal(computeWorkerDeltaHash([base], []), computeWorkerDeltaHash([repeated], []));
	assert.notEqual(computeWorkerDeltaHash([base], []), computeWorkerDeltaHash([contentChanged], []));
	const one = success(inputFor([operation(1, "hash.ts", base.before, base.after)], [base.after]));
	const middle = file("hash.ts", SHA_A, 5, 9);
	const two = success(inputFor([
		operation(1, "hash.ts", base.before, middle),
		operation(2, "hash.ts", middle, base.after),
	], [base.after]));
	assert.equal(one.worker_delta_hash, two.worker_delta_hash);
	assert.notEqual(one.change_set_hash, two.change_set_hash);
});

test("final identity and guard races fail closed as CONFLICT with empty delta", () => {
	const path = "race.ts";
	const before = file(path, SHA_A, 5, 1);
	const journalAfter = file(path, SHA_B, 5, 2);
	const raced = file(path, SHA_C, 5, 3);
	const finalConflict = success(inputFor([operation(1, path, before, journalAfter)], [raced]));
	assert.equal(finalConflict.status, "CONFLICT");
	assert.deepEqual(finalConflict.worker_delta, []);
	assert.deepEqual(finalConflict.conflicts, [{ path, reason: "final_identity_mismatch" }]);

	const badGuard = guard([guardEntry(path, file(path, SHA_B, 5, 77))]);
	const guardConflict = success(inputFor([operation(1, path, before, journalAfter)], [journalAfter], guard(), badGuard));
	assert.equal(guardConflict.status, "CONFLICT");
	assert.deepEqual(guardConflict.conflicts, [{ path, reason: "guard_identity_mismatch" }]);
	assert.notEqual(finalConflict.worker_delta_hash, guardConflict.worker_delta_hash);
	const badBeforeGuard = guard([guardEntry(path, file(path, SHA_A, 5, 88))]);
	assert.equal(success(inputFor(
		[operation(1, path, before, journalAfter)], [journalAfter], badBeforeGuard, guard(),
	)).status, "CONFLICT");
});

test("outside-touched drift is dependency or unknown origin and never enters worker delta", () => {
	const touched = "src/touched.ts";
	const dependency = "generated/dependency.ts";
	const unknown = "notes/外部\n变化.txt";
	const before = file(touched, SHA_A, 5, 1);
	const after = file(touched, SHA_B, 5, 2);
	const dependencyBefore = file(dependency, SHA_A, 2, 10);
	const dependencyAfter = file(dependency, SHA_B, 2, 11);
	const unknownAfter = file(unknown, SHA_C, 1, 12);
	const value = success(inputFor(
		[operation(1, touched, before, after)],
		[after],
		guard([guardEntry(dependency, dependencyBefore)]),
		guard([guardEntry(dependency, dependencyAfter), guardEntry(unknown, unknownAfter, "??")]),
		[dependency],
	));
	assert.equal(value.status, "WORKSPACE_DRIFT");
	assert.deepEqual(value.workspace_drift.map((entry) => [entry.path, entry.classification]), [
		[dependency, "dependency"],
		[unknown, "unknown_origin"],
	]);
	assert.deepEqual(value.worker_delta.map((entry) => entry.path), [touched]);
});

test("irrelevant artifact changes do not affect any ChangeSet hash", () => {
	const path = "src/clean.ts";
	const before = file(path, SHA_A, 4, 1);
	const after = file(path, SHA_B, 4, 2);
	const plain = inputFor([operation(1, path, before, after)], [after]);
	const noisy = inputFor(
		[operation(1, path, before, after)], [after],
		guard([], [`.pi/workbench/runs/run-a/manifest.json`]),
		guard([], [`.pi/workbench/delegations/${ID}/worker-report.md`, ".pi/workbench/tool-results/x.json"]),
	);
	const a = success(plain);
	const b = success(noisy);
	assert.equal(a.worker_delta_hash, b.worker_delta_hash);
	assert.equal(a.workspace_guard_hash, b.workspace_guard_hash);
	assert.equal(a.change_set_hash, b.change_set_hash);
});

test("500 dependency paths succeed and 501 fails the closed path-set bound", () => {
	const dependencies = Array.from({ length: 500 }, (_, index) => `many/${String(index).padStart(3, "0")}.ts`);
	const value = success(inputFor([], [], guard(), guard(), dependencies));
	assert.equal(value.dependency_paths.length, 500);
	const result = computeChangeSet(inputFor([], [], guard(), guard(), [...dependencies, "many/500.ts"]));
	assert.deepEqual(result, { ok: false, error: { code: "invalid_dependencies", message: "change set dependency paths are invalid" } });
});

test("rejects tampered/open journal, guard, finals, meter, dependencies and unknown fields", () => {
	const path = "invalid.ts";
	const before = file(path, SHA_A, 5, 1);
	const after = file(path, SHA_B, 5, 2);
	const good = inputFor([operation(1, path, before, after)], [after]);
	const cases: Array<[string, ComputeChangeSetInput, string]> = [
		["journal hash", { ...good, journal: { ...good.journal, journal_hash: SHA_C } }, "invalid_journal"],
		["open journal", { ...good, journal: { ...good.journal, state: "OPEN", journal_hash: null } }, "invalid_journal"],
		["guard hash", { ...good, after_guard: { ...good.after_guard, workspace_guard_hash: SHA_C } }, "invalid_guard"],
		["final ordering/path", { ...good, final_identities: [file("wrong.ts", SHA_B, 5, 2)] }, "invalid_finals"],
		["short meter", { ...good, finalization_meter: { paths_attempted: 1, paths_completed: 1, bytes_read: 4 } }, "invalid_meter"],
		["total meter cap", { ...good, finalization_meter: { paths_attempted: 1, paths_completed: 1, bytes_read: 256 * 1024 * 1024 + 1 } }, "invalid_meter"],
		["file cap", { ...good, final_identities: [file(path, SHA_B, 64 * 1024 * 1024 + 1, 2)], finalization_meter: { paths_attempted: 1, paths_completed: 1, bytes_read: 64 * 1024 * 1024 + 1 } }, "invalid_finals"],
		["dependency order", { ...good, dependency_paths: ["z.ts", "a.ts"] }, "invalid_dependencies"],
		["dependency duplicate", { ...good, dependency_paths: ["a.ts", "a.ts"] }, "invalid_dependencies"],
	];
	for (const [name, candidate, code] of cases) {
		const result = computeChangeSet(candidate);
		assert.equal(result.ok, false, name);
		if (!result.ok) assert.equal(result.error.code, code, name);
	}
	const withUnknown = { ...good, secret_body: "must-not-echo" } as unknown as ComputeChangeSetInput;
	const result = computeChangeSet(withUnknown);
	assert.equal(result.ok, false);
	assert.ok(!JSON.stringify(result).includes("must-not-echo"));
});

test("canonical hashes ignore object key insertion order at every nested layer", () => {
	const path = "ordered.ts";
	const before = file(path, SHA_A, 5, 1);
	const after = file(path, SHA_B, 5, 2);
	const value = success(inputFor([operation(1, path, before, after)], [after]));
	const reordered = {
		...value,
		finalization_meter: {
			bytes_read: value.finalization_meter.bytes_read,
			paths_completed: value.finalization_meter.paths_completed,
			paths_attempted: value.finalization_meter.paths_attempted,
		},
		counts: {
			conflict_paths: value.counts.conflict_paths,
			unknown_origin_drift_paths: value.counts.unknown_origin_drift_paths,
			dependency_drift_paths: value.counts.dependency_drift_paths,
			workspace_drift_paths: value.counts.workspace_drift_paths,
			zero_delta_paths: value.counts.zero_delta_paths,
			attributed_paths: value.counts.attributed_paths,
			touched_paths: value.counts.touched_paths,
		},
		worker_delta: value.worker_delta.map((entry) => ({
			after: entry.after,
			before: entry.before,
			operation_count: entry.operation_count,
			change: entry.change,
			path: entry.path,
		})),
	};
	assert.equal(computeChangeSetHash(reordered), value.change_set_hash);
	assert.equal(validateChangeSet(reordered), true);
	const everyLayerReordered = reverseKeys(value) as ChangeSetRecord;
	assert.equal(computeChangeSetHash(everyLayerReordered), value.change_set_hash);
	assert.equal(validateChangeSet(everyLayerReordered), true);
});

test("computation is deterministic, does not mutate inputs, and errors contain no raw paths", () => {
	const path = "private-token-should-not-leak.ts";
	const before = file(path, SHA_A, 5, 1);
	const after = file(path, SHA_B, 5, 2);
	const input = inputFor([operation(1, path, before, after)], [after]);
	const snapshot = structuredClone(input);
	const first = success(input);
	const second = success(input);
	assert.deepEqual(input, snapshot);
	assert.deepEqual(first, second);
	const bad = computeChangeSet({ ...input, final_identities: [] });
	assert.equal(bad.ok, false);
	assert.ok(!JSON.stringify(bad).includes(path));
});

test("validator rejects unknown fields, tampered hashes and count invariants", () => {
	const path = "record.ts";
	const before = file(path, SHA_A, 5, 1);
	const after = file(path, SHA_B, 5, 2);
	const value = success(inputFor([operation(1, path, before, after)], [after]));
	assert.equal(validateChangeSet({ ...value, unknown: true }), false);
	assert.equal(validateChangeSet({ ...value, worker_delta_hash: SHA_C }), false);
	assert.equal(validateChangeSet({ ...value, counts: { ...value.counts, attributed_paths: 0 } }), false);
	assert.equal(validateChangeSet({ ...value, worker_delta: [...value.worker_delta, value.worker_delta[0]!] }), false);
});
