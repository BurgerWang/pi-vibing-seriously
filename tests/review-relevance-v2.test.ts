import assert from "node:assert/strict";
import test from "node:test";

import { computeChangeSet, type ChangeSetRecord } from "../extensions/workbench-runtime/core/change-set.ts";
import {
	collectReviewRelevanceV2,
	computeReviewRelevanceProjectionHashV2,
	REVIEW_RELEVANCE_KIND_V2,
} from "../extensions/workbench-runtime/core/review-relevance-v2.ts";
import type { StreamingIdentityErrorCode, StreamingPathIdentity } from "../extensions/workbench-runtime/core/streaming-identity.ts";
import { computeWorkspaceGuardHash, type WorkspaceGuardEntry, type WorkspaceGuardRecord } from "../extensions/workbench-runtime/core/workspace-guard.ts";
import { computeWorkerWriteJournalHash, type WorkerWriteJournalRecord } from "../extensions/workbench-runtime/core/write-journal.ts";

const ID = "20260820-151000-rr01";
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
		identity: identity.kind === "missing" ? { kind: "missing" } : {
			kind: "file",
			byte_size: identity.byte_size,
			stat: { ...identity.stat },
		},
	};
}

function guard(entries: readonly WorkspaceGuardEntry[], irrelevant: readonly string[] = []): WorkspaceGuardRecord {
	const ordered = [...entries].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
	const ignored = [...irrelevant].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
	return {
		schema_version: 2,
		git_head: HEAD,
		entries: ordered,
		irrelevant_artifact_paths: ignored,
		meter: {
			status_bytes: (ordered.length + ignored.length) * 16,
			relevant_paths: ordered.length,
			irrelevant_paths: ignored.length,
			stat_calls: ordered.length * 2,
			content_bytes_read: 0,
		},
		workspace_guard_hash: computeWorkspaceGuardHash(HEAD, ordered),
	};
}

interface Fixture {
	afterGuard: WorkspaceGuardRecord;
	changeSet: ChangeSetRecord;
	workerAfter: FileIdentity;
}

function fixture(preDirtyCount = 0, dependency = false, workerSize = 11): Fixture {
	const workerAfter = file(W, "c".repeat(64), workerSize);
	const preDirty = Array.from({ length: preDirtyCount }, (_, index) => {
		const path = `predirty/${String(index).padStart(3, "0")}.ts`;
		return entry(file(path, "d".repeat(64), 7, String(100 + index)), " M");
	});
	if (dependency) preDirty.push(entry(file("dep.ts", "e".repeat(64), 5, "900"), " M"));
	const beforeGuard = guard(preDirty);
	const afterGuard = guard([...preDirty, entry(workerAfter)]);
	const limits = {
		max_unique_paths: 500,
		max_operations: 1000,
		max_identity_paths: 500,
		max_total_bytes: 256 * 1024 * 1024,
		max_file_bytes: 64 * 1024 * 1024,
		max_serialized_bytes: 4 * 1024 * 1024,
	};
	const sealedBase: WorkerWriteJournalRecord = {
		schema_version: 2,
		delegation_id: ID,
		contract_hash: CONTRACT,
		state: "SEALED",
		revision: 3,
		limits,
		meter: { paths_attempted: 2, paths_completed: 2, bytes_read: workerAfter.byte_size },
		operations: [{
			sequence: 1,
			operation_id: "f".repeat(64),
			kind: "write",
			path: W,
			status: "completed",
			before: missing(W),
			after: workerAfter,
			outcome: "succeeded",
		}],
		journal_hash: "0".repeat(64),
	};
	const journal = { ...sealedBase, journal_hash: computeWorkerWriteJournalHash(sealedBase) };
	const computed = computeChangeSet({
		delegation_id: ID,
		contract_hash: CONTRACT,
		journal_hash: journal.journal_hash!,
		journal,
		before_guard: beforeGuard,
		after_guard: afterGuard,
		dependency_paths: dependency ? ["dep.ts"] : [],
		final_identities: [workerAfter],
		finalization_meter: { paths_attempted: 1, paths_completed: 1, bytes_read: workerAfter.byte_size },
	});
	if (!computed.ok) throw new Error(computed.error.code);
	return { afterGuard, changeSet: computed.value as ChangeSetRecord, workerAfter };
}

function dependencies(current: WorkspaceGuardRecord, workerAfter: StreamingPathIdentity, override?: StreamingPathIdentity) {
	return {
		collect_guard: async () => ({ ok: true as const, guard: current }),
		capture_identities: async (input: { paths: readonly string[] }) => {
			const identities = input.paths.map((path) => path === W ? (override ?? workerAfter) : missing(path));
			const bytes = identities.reduce((sum, identity) => sum + (identity.kind === "file" ? identity.byte_size : 0), 0);
			return {
				ok: true as const,
				identities,
				meter: { paths_attempted: identities.length, paths_completed: identities.length, bytes_read: bytes },
			};
		},
	};
}

const EXEC = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

async function collect(source: Fixture, current = source.afterGuard, override?: StreamingPathIdentity) {
	return collectReviewRelevanceV2({
		project_root: "/tmp/review-relevance-v2",
		delegation_id: ID,
		contract_hash: CONTRACT,
		after_guard: source.afterGuard,
		change_set: source.changeSet,
		exec: EXEC,
	}, dependencies(current, source.workerAfter, override));
}

test("0 vs 200 pre-dirty paths open and read exactly the same relevance set", async () => {
	const results = await Promise.all([collect(fixture(0)), collect(fixture(200))]);
	for (const result of results) assert.equal(result.ok, true);
	if (!results[0]!.ok || !results[1]!.ok) return;
	assert.equal(results[0].value.meter.identity_paths_attempted, results[1].value.meter.identity_paths_attempted);
	assert.equal(results[0].value.meter.identity_bytes_read, results[1].value.meter.identity_bytes_read);
	assert.equal(results[0].value.meter.identity_bytes_read, 11);
	assert.deepEqual(results[0].value.worker_paths, [W]);
	assert.equal(results[1].value.baseline_ignored_paths.length, 200);
});

test("pre-dirty unrelated mutation, artifact drift and identity key order do not alter binding", async () => {
	const source = fixture(2);
	const first = await collect(source);
	assert.equal(first.ok, true);
	if (!first.ok) return;
	const changedB = source.afterGuard.entries.map((candidate) => candidate.path.startsWith("predirty/")
		? { ...candidate, identity: { ...(candidate.identity as Exclude<typeof candidate.identity, { kind: "missing" }>), stat: { dev: "8", ino: "8", mtime_ns: "8", ctime_ns: "8" } } }
		: candidate);
	const current = guard(changedB, [".pi/workbench/runs/review/report.json"]);
	const reordered = {
		stat: { ctime_ns: "4", mtime_ns: "3", ino: "2", dev: "1" },
		sha256: "c".repeat(64),
		byte_size: 11,
		path: W,
		kind: "file",
		schema_version: 2,
	} as unknown as StreamingPathIdentity;
	const second = await collect(source, current, reordered);
	assert.equal(second.ok, true);
	if (!second.ok) return;
	assert.equal(computeReviewRelevanceProjectionHashV2(first.value.projection), computeReviewRelevanceProjectionHashV2(second.value.projection));
	assert.equal(second.value.projection.diff_identity_kind, REVIEW_RELEVANCE_KIND_V2);
});

test("an unchanged relevance projection survives a filesystem device renumber", async () => {
	const source = fixture();
	const first = await collect(source);
	assert.equal(first.ok, true);
	if (!first.ok) return;
	const current = guard(source.afterGuard.entries.map((candidate) => candidate.identity.kind === "file"
		? {
			...candidate,
			identity: {
				...candidate.identity,
				stat: { ...candidate.identity.stat, dev: "59" },
			},
		}
		: candidate));
	const remountedWorker = {
		...source.workerAfter,
		stat: { ...source.workerAfter.stat, dev: "59" },
	} as StreamingPathIdentity;
	const second = await collectReviewRelevanceV2({
		project_root: "/tmp/review-relevance-v2",
		delegation_id: ID,
		contract_hash: CONTRACT,
		after_guard: source.afterGuard,
		change_set: source.changeSet,
		exec: EXEC,
		expected_projection: first.value.projection,
	}, dependencies(current, source.workerAfter, remountedWorker));
	assert.equal(second.ok, true);
	if (!second.ok) return;
	assert.equal(
		computeReviewRelevanceProjectionHashV2(second.value.projection),
		computeReviewRelevanceProjectionHashV2(first.value.projection),
	);
	const worker = second.value.projection.entries.find((candidate) => candidate.path === W);
	assert.equal(worker?.full_identity.kind, "file");
	if (worker?.full_identity.kind === "file") assert.equal(worker.full_identity.stat.dev, "1");
});

test("device renumber compatibility does not hide changed worker bytes", async () => {
	const source = fixture();
	const first = await collect(source);
	assert.equal(first.ok, true);
	if (!first.ok) return;
	const current = guard(source.afterGuard.entries.map((candidate) => candidate.identity.kind === "file"
		? {
			...candidate,
			identity: {
				...candidate.identity,
				stat: { ...candidate.identity.stat, dev: "59" },
			},
		}
		: candidate));
	const changedWorker = file(W, "9".repeat(64), source.workerAfter.kind === "file" ? source.workerAfter.byte_size : 11, "2");
	changedWorker.stat.dev = "59";
	const conflict = await collectReviewRelevanceV2({
		project_root: "/tmp/review-relevance-v2",
		delegation_id: ID,
		contract_hash: CONTRACT,
		after_guard: source.afterGuard,
		change_set: source.changeSet,
		exec: EXEC,
		expected_projection: first.value.projection,
	}, dependencies(current, source.workerAfter, changedWorker));
	assert.equal(conflict.ok, false);
	if (!conflict.ok) assert.equal(conflict.error.code, "relevant_conflict");
});

test("a clean control path uses the prior full projection to survive only device drift", async () => {
	const source = fixture();
	const first = await collect(source);
	assert.equal(first.ok, true);
	if (!first.ok) return;
	const controlPath = "AGENTS.md";
	const control = file(controlPath, "7".repeat(64), 19, "77");
	const expected = {
		...first.value.projection,
		entries: first.value.projection.entries.map((candidate) => candidate.path === controlPath
			? { ...candidate, full_identity: control }
			: candidate),
	};
	const current = guard(source.afterGuard.entries.map((candidate) => candidate.identity.kind === "file"
		? {
			...candidate,
			identity: {
				...candidate.identity,
				stat: { ...candidate.identity.stat, dev: "59" },
			},
		}
		: candidate));
	const remountedWorker = { ...source.workerAfter, stat: { ...source.workerAfter.stat, dev: "59" } };
	const remountedControl = { ...control, stat: { ...control.stat, dev: "59" } };
	const collectControl = (controlIdentity: FileIdentity) => collectReviewRelevanceV2({
		project_root: "/tmp/review-relevance-v2",
		delegation_id: ID,
		contract_hash: CONTRACT,
		after_guard: source.afterGuard,
		change_set: source.changeSet,
		exec: EXEC,
		expected_projection: expected,
	}, {
		collect_guard: async () => ({ ok: true, guard: current }),
		capture_identities: async (input) => {
			const identities = input.paths.map((path) => path === W
				? remountedWorker
				: path === controlPath ? controlIdentity : missing(path));
			return {
				ok: true,
				identities,
				meter: {
					paths_attempted: identities.length,
					paths_completed: identities.length,
					bytes_read: identities.reduce((sum, identity) => sum + (identity.kind === "file" ? identity.byte_size : 0), 0),
				},
			};
		},
	});
	const stable = await collectControl(remountedControl);
	assert.equal(stable.ok, true);
	if (stable.ok) {
		assert.equal(
			computeReviewRelevanceProjectionHashV2(stable.value.projection),
			computeReviewRelevanceProjectionHashV2(expected),
		);
	}
	const changed = await collectControl({ ...remountedControl, sha256: "8".repeat(64) });
	assert.equal(changed.ok, false);
	if (!changed.ok) assert.equal(changed.error.code, "binding_conflict");
});

test("first-review W tail drift conflicts even with same size and stat", async () => {
	const size = 5 * 1024 * 1024;
	const source = fixture(0, false, size);
	const conflict = await collect(source, source.afterGuard, file(W, "2".repeat(64), size, "2"));
	assert.equal(conflict.ok, false);
	if (!conflict.ok) assert.equal(conflict.error.code, "relevant_conflict");
});

test("HEAD drift conflicts before relevance content capture", async () => {
	const source = fixture();
	const current: WorkspaceGuardRecord = {
		...source.afterGuard,
		git_head: "9".repeat(40),
		workspace_guard_hash: computeWorkspaceGuardHash("9".repeat(40), source.afterGuard.entries),
	};
	let captured = false;
	const result = await collectReviewRelevanceV2({
		project_root: "/tmp/review-relevance-v2",
		delegation_id: ID,
		contract_hash: CONTRACT,
		after_guard: source.afterGuard,
		change_set: source.changeSet,
		exec: EXEC,
	}, {
		collect_guard: async () => ({ ok: true, guard: current }),
		capture_identities: async () => {
			captured = true;
			return { ok: true, identities: [], meter: { paths_attempted: 0, paths_completed: 0, bytes_read: 0 } };
		},
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, "head_conflict");
	assert.equal(captured, false);
});

test("D/control/unknown drift conflict while guard-classified artifacts are ignored", async () => {
	const dependencySource = fixture(0, true);
	const depChanged = guard(dependencySource.afterGuard.entries.map((candidate) => candidate.path === "dep.ts"
		? entry(file("dep.ts", "9".repeat(64), 5, "901"), " M") : candidate));
	const dependency = await collect(dependencySource, depChanged);
	assert.equal(dependency.ok, false);
	if (!dependency.ok) assert.equal(dependency.error.code, "relevant_conflict");

	const source = fixture();
	const control = await collect(source, guard([...source.afterGuard.entries, entry(file(".pi/settings.json", "8".repeat(64), 5, "88"), " M")]));
	assert.equal(control.ok, false);
	if (!control.ok) assert.equal(control.error.code, "relevant_conflict");
	const unknown = await collect(source, guard([...source.afterGuard.entries, entry(file("new-source.ts", "7".repeat(64), 5, "77"), "??")]));
	assert.equal(unknown.ok, false);
	if (!unknown.ok) assert.equal(unknown.error.code, "unknown_origin");
	const artifact = await collect(source, guard(source.afterGuard.entries, [".pi/workbench/runs/x/report.json"]));
	assert.equal(artifact.ok, true);
});

test("hard path bounds fail closed before identity capture", async () => {
	const source = fixture();
	let captured = false;
	const result = await collectReviewRelevanceV2({
		project_root: "/tmp/review-relevance-v2",
		delegation_id: ID,
		contract_hash: CONTRACT,
		after_guard: source.afterGuard,
		change_set: source.changeSet,
		exec: EXEC,
		limits: { max_paths: 1 },
	}, {
		collect_guard: async () => ({ ok: true, guard: source.afterGuard }),
		capture_identities: async () => {
			captured = true;
			return { ok: true, identities: [], meter: { paths_attempted: 0, paths_completed: 0, bytes_read: 0 } };
		},
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, "limit_exceeded");
	assert.equal(captured, false);
});

test("symlink, read, unstable, and byte-bound identity failures preserve bounded meters and fail closed", async () => {
	const source = fixture();
	const cases: Array<{ code: StreamingIdentityErrorCode; expected: "identity_unavailable" | "limit_exceeded" }> = [
		{ code: "path_symlink", expected: "identity_unavailable" },
		{ code: "read_failed", expected: "identity_unavailable" },
		{ code: "unstable", expected: "identity_unavailable" },
		{ code: "total_bytes_overflow", expected: "limit_exceeded" },
	];
	for (const item of cases) {
		const result = await collectReviewRelevanceV2({
			project_root: "/tmp/review-relevance-v2",
			delegation_id: ID,
			contract_hash: CONTRACT,
			after_guard: source.afterGuard,
			change_set: source.changeSet,
			exec: EXEC,
		}, {
			collect_guard: async () => ({ ok: true, guard: source.afterGuard }),
			capture_identities: async () => ({
				ok: false,
				error: { code: item.code, message: "bounded injected identity failure", path: W },
				meter: { paths_attempted: 1, paths_completed: 0, bytes_read: 7 },
			}),
		});
		assert.equal(result.ok, false, item.code);
		if (!result.ok) {
			assert.equal(result.error.code, item.expected, item.code);
			assert.equal(result.error.path, W, item.code);
			assert.equal(result.meter.identity_paths_attempted, 1, item.code);
			assert.equal(result.meter.identity_paths_completed, 0, item.code);
			assert.equal(result.meter.identity_bytes_read, 7, item.code);
		}
	}
});
