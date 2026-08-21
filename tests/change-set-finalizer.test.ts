import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	finalizeChangeSetV2,
	type FinalizeChangeSetV2Input,
	type FinalizeChangeSetV2Result,
} from "../extensions/workbench-runtime/core/change-set-finalizer.ts";
import {
	captureStreamingIdentities,
	createNodeStreamingIdentityAdapter,
	STREAMING_IDENTITY_FAULT_POINTS,
	type StreamingIdentityAdapter,
	type StreamingPathIdentity,
} from "../extensions/workbench-runtime/core/streaming-identity.ts";
import {
	computeWorkerWriteJournalHash,
	type CompletedWriteJournalOperation,
	type WorkerWriteJournalRecord,
} from "../extensions/workbench-runtime/core/write-journal.ts";
import {
	computeWorkspaceGuardHash,
	type WorkspaceGuardEntry,
	type WorkspaceGuardRecord,
} from "../extensions/workbench-runtime/core/workspace-guard.ts";

const ID = "20260820-140000-f1N2";
const CONTRACT = "c".repeat(64);
const HEAD = "d".repeat(40);

function sha(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function missing(path: string): StreamingPathIdentity {
	return { schema_version: 2, kind: "missing", path };
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
	const identityBytes = operations.reduce((sum, item) => sum
		+ (item.before.kind === "file" ? item.before.byte_size : 0)
		+ (item.after.kind === "file" ? item.after.byte_size : 0), 0);
	const record: WorkerWriteJournalRecord = {
		schema_version: 2,
		delegation_id: ID,
		contract_hash: CONTRACT,
		state: "SEALED",
		revision: operations.length * 2 + 1,
		limits: {
			max_unique_paths: 500,
			max_operations: 1_000,
			max_identity_paths: 500,
			max_total_bytes: 256 * 1024 * 1024,
			max_file_bytes: 64 * 1024 * 1024,
			max_serialized_bytes: 4 * 1024 * 1024,
		},
		meter: {
			paths_attempted: operations.length * 2,
			paths_completed: operations.length * 2,
			bytes_read: identityBytes,
		},
		operations,
		journal_hash: "0".repeat(64),
	};
	return { ...record, journal_hash: computeWorkerWriteJournalHash(record) };
}

function guard(entries: readonly WorkspaceGuardEntry[] = []): WorkspaceGuardRecord {
	const sorted = [...entries].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
	return {
		schema_version: 2,
		git_head: HEAD,
		entries: sorted,
		irrelevant_artifact_paths: [],
		meter: {
			status_bytes: 0,
			relevant_paths: sorted.length,
			irrelevant_paths: 0,
			stat_calls: sorted.length * 2,
			content_bytes_read: 0,
		},
		workspace_guard_hash: computeWorkspaceGuardHash(HEAD, sorted),
	};
}

function baseInput(root: string, sealed: WorkerWriteJournalRecord): FinalizeChangeSetV2Input {
	return {
		project_root: root,
		delegation_id: ID,
		contract_hash: CONTRACT,
		journal_hash: sealed.journal_hash!,
		journal: sealed,
		before_guard: guard(),
		after_guard: guard(),
		dependency_paths: [],
	};
}

function success(result: FinalizeChangeSetV2Result) {
	assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}:${result.error.identity_code ?? "none"}`);
	if (!result.ok) throw new Error("expected finalizer success");
	return result.value;
}

function failure(result: FinalizeChangeSetV2Result, code: string, identityCode?: string) {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected finalizer failure");
	assert.equal(result.error.code, code);
	if (identityCode !== undefined) assert.equal(result.error.identity_code, identityCode);
	return result.error;
}

async function capture(root: string, paths: readonly string[]): Promise<readonly StreamingPathIdentity[]> {
	const result = await captureStreamingIdentities({ project_root: root, paths });
	assert.equal(result.ok, true, result.ok ? undefined : result.error.code);
	if (!result.ok) throw new Error("capture failed");
	return result.identities;
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "change-set-finalizer-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function countingAdapter(counter: { opens: string[]; bytes: number }): StreamingIdentityAdapter {
	const base = createNodeStreamingIdentityAdapter();
	return {
		...base,
		async openNoFollow(path) {
			counter.opens.push(path);
			const handle = await base.openNoFollow(path);
			return {
				...handle,
				async read(buffer, offset, length, position) {
					const result = await handle.read(buffer, offset, length, position);
					counter.bytes += result.bytesRead;
					return result;
				},
			};
		},
	};
}

test("real new/modify/delete/Unicode multi-path finalization reads exact final bytes", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "modify.txt"), "before-modify");
		await writeFile(join(root, "delete.txt"), "before-delete");
		const initial = await capture(root, ["modify.txt", "delete.txt"]);
		const initialByPath = new Map(initial.map((identity) => [identity.path, identity]));
		await writeFile(join(root, "new.txt"), "new");
		await writeFile(join(root, "modify.txt"), "after-modify");
		await unlink(join(root, "delete.txt"));
		await writeFile(join(root, "你好.txt"), "unicode");
		const finals = await capture(root, ["new.txt", "modify.txt", "delete.txt", "你好.txt"]);
		const byPath = new Map(finals.map((identity) => [identity.path, identity]));
		const sealed = journal([
			operation(1, "new.txt", missing("new.txt"), byPath.get("new.txt")!),
			operation(2, "modify.txt", initialByPath.get("modify.txt")!, byPath.get("modify.txt")!),
			operation(3, "delete.txt", initialByPath.get("delete.txt")!, byPath.get("delete.txt")!),
			operation(4, "你好.txt", missing("你好.txt"), byPath.get("你好.txt")!),
		]);
		const snapshot = structuredClone(baseInput(root, sealed));
		const input = baseInput(root, sealed);
		const value = success(await finalizeChangeSetV2(input));
		assert.deepEqual(input, snapshot);
		assert.equal(value.status, "ATTRIBUTED");
		assert.deepEqual(value.worker_delta.map((entry) => [entry.path, entry.change]), [
			["delete.txt", "delete"], ["modify.txt", "modify"], ["new.txt", "new"], ["你好.txt", "new"],
		]);
		assert.deepEqual(value.finalization_meter, {
			paths_attempted: 4,
			paths_completed: 4,
			bytes_read: Buffer.byteLength("after-modify") + Buffer.byteLength("new") + Buffer.byteLength("unicode"),
		});
	});
});

test("empty sealed journal returns pure deterministic record with no identity adapter calls", async () => {
	await withRoot(async (root) => {
		const sealed = journal([]);
		const counter = { opens: [] as string[], bytes: 0 };
		const input = baseInput(root, sealed);
		const first = success(await finalizeChangeSetV2(input, { identity_adapter: countingAdapter(counter) }));
		const second = success(await finalizeChangeSetV2(input, { identity_adapter: countingAdapter(counter) }));
		assert.deepEqual(first, second);
		assert.deepEqual(first.finalization_meter, { paths_attempted: 0, paths_completed: 0, bytes_read: 0 });
		assert.deepEqual(counter, { opens: [], bytes: 0 });
	});
});

test(">4MiB same-prefix same-size tail is fully detected, then later tail mutation is CONFLICT", async () => {
	await withRoot(async (root) => {
		const path = "large.bin";
		const prefix = Buffer.alloc(4 * 1024 * 1024, 7);
		const beforeBytes = Buffer.concat([prefix, Buffer.from("tail-A")]);
		const afterBytes = Buffer.concat([prefix, Buffer.from("tail-B")]);
		await writeFile(join(root, path), beforeBytes);
		const [before] = await capture(root, [path]);
		await writeFile(join(root, path), afterBytes);
		const [after] = await capture(root, [path]);
		assert.notEqual(before!.kind === "file" ? before!.sha256 : "", after!.kind === "file" ? after!.sha256 : "");
		const input = baseInput(root, journal([operation(1, path, before!, after!)]));
		const detected = success(await finalizeChangeSetV2(input));
		assert.equal(detected.worker_delta[0]?.after.kind, "file");
		assert.equal(detected.finalization_meter.bytes_read, afterBytes.length);

		await writeFile(join(root, path), Buffer.concat([prefix, Buffer.from("tail-C")]));
		const conflict = success(await finalizeChangeSetV2(input));
		assert.equal(conflict.status, "CONFLICT");
		assert.deepEqual(conflict.worker_delta, []);
		assert.deepEqual(conflict.conflicts, [{ path, reason: "final_identity_mismatch" }]);
	});
});

test("unrelated dirty guard facts never cause unrelated file reads", async () => {
	await withRoot(async (root) => {
		const path = "only-touched.txt";
		await writeFile(join(root, path), "final bytes");
		const [after] = await capture(root, [path]);
		const entries: WorkspaceGuardEntry[] = Array.from({ length: 500 }, (_, index) => ({
			path: `unrelated/${String(index).padStart(3, "0")}.bin`,
			status: " M",
			identity: {
				kind: "file",
				byte_size: 63 * 1024 * 1024,
				stat: { dev: "1", ino: String(index + 1), mtime_ns: "2", ctime_ns: "3" },
			},
		}));
		const sameGuard = guard(entries);
		const sealed = journal([operation(1, path, missing(path), after!)]);
		const input = { ...baseInput(root, sealed), before_guard: sameGuard, after_guard: sameGuard };
		const counter = { opens: [] as string[], bytes: 0 };
		const value = success(await finalizeChangeSetV2(input, { identity_adapter: countingAdapter(counter) }));
		assert.equal(value.finalization_meter.paths_attempted, 1);
		assert.equal(counter.opens.length, 1);
		assert.ok(counter.opens[0]!.endsWith(path));
		assert.equal(counter.bytes, Buffer.byteLength("final bytes"));
	});
});

test("lower path, per-file and total limits fail explicitly without partial ChangeSet", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "a.txt"), "aaaa");
		await writeFile(join(root, "b.txt"), "bbbb");
		const [a, b] = await capture(root, ["a.txt", "b.txt"]);
		const input = baseInput(root, journal([
			operation(1, "a.txt", missing("a.txt"), a!),
			operation(2, "b.txt", missing("b.txt"), b!),
		]));
		const zero = { opens: [] as string[], bytes: 0 };
		failure(await finalizeChangeSetV2(input, {
			limits: { max_paths: 1 }, identity_adapter: countingAdapter(zero),
		}), "limit_exceeded");
		assert.deepEqual(zero, { opens: [], bytes: 0 });

		const perFile = failure(await finalizeChangeSetV2(input, {
			limits: { max_file_bytes: 3 },
		}), "limit_exceeded", "file_bytes_overflow");
		assert.equal("path" in perFile, false);
		failure(await finalizeChangeSetV2(input, {
			limits: { max_total_bytes: 6 },
		}), "limit_exceeded", "total_bytes_overflow");
	});
});

test("every streaming fault is closed, bounded, and never leaks private details", async () => {
	await withRoot(async (root) => {
		const path = "fault.txt";
		await writeFile(join(root, path), "fault-content");
		const [after] = await capture(root, [path]);
		const input = baseInput(root, journal([operation(1, path, missing(path), after!)]));
		for (const point of STREAMING_IDENTITY_FAULT_POINTS) {
			let fired = false;
			const result = await finalizeChangeSetV2(input, {
				identity_hooks: {
					fault(seen) {
						if (!fired && seen === point) {
							fired = true;
							throw new Error("PRIVATE_STREAMING_FAULT_DETAIL");
						}
					},
				},
			});
			const error = failure(result, "identity_failure");
			assert.equal(fired, true, point);
			assert.equal(JSON.stringify(error).includes("PRIVATE"), false);
			assert.equal(JSON.stringify(error).includes(path), false);
		}
	});
});

test("invalid journal, guards, dependencies and outer schema cause zero identity reads", async () => {
	await withRoot(async (root) => {
		const path = "valid.txt";
		await writeFile(join(root, path), "valid");
		const [after] = await capture(root, [path]);
		const sealed = journal([operation(1, path, missing(path), after!)]);
		const base = baseInput(root, sealed);
		const cases: Array<[string, FinalizeChangeSetV2Input]> = [
			["invalid_journal", { ...base, journal: { ...sealed, state: "OPEN", journal_hash: null } }],
			["invalid_journal", { ...base, journal: { ...sealed, revision: sealed.revision + 1 } }],
			["invalid_journal", { ...base, journal: { ...sealed, delegation_id: "20260820-140001-z9Y8" } }],
			["invalid_journal", { ...base, journal_hash: "e".repeat(64) }],
			["invalid_input", { ...base, delegation_id: "bad" }],
			["invalid_guard", { ...base, after_guard: { ...base.after_guard, workspace_guard_hash: "a".repeat(64) } }],
			["invalid_dependencies", { ...base, dependency_paths: ["z.ts", "a.ts"] }],
		];
		for (const [code, input] of cases) {
			const counter = { opens: [] as string[], bytes: 0 };
			failure(await finalizeChangeSetV2(input, { identity_adapter: countingAdapter(counter) }), code);
			assert.deepEqual(counter, { opens: [], bytes: 0 });
		}
		const counter = { opens: [] as string[], bytes: 0 };
		failure(await finalizeChangeSetV2({ ...base, extra: true } as unknown as FinalizeChangeSetV2Input, {
			identity_adapter: countingAdapter(counter),
		}), "invalid_input");
		assert.deepEqual(counter, { opens: [], bytes: 0 });
	});
});

test("recomputed but broken repeated-operation chain is refused before reads", async () => {
	await withRoot(async (root) => {
		const path = "chain.txt";
		await writeFile(join(root, path), "final");
		const [final] = await capture(root, [path]);
		const middle: StreamingPathIdentity = final!.kind === "file"
			? { ...final!, sha256: sha("middle") }
			: final!;
		const brokenBefore: StreamingPathIdentity = final!.kind === "file"
			? { ...final!, sha256: sha("not-middle") }
			: final!;
		const broken = journal([
			operation(1, path, missing(path), middle),
			operation(2, path, brokenBefore, final!),
		]);
		const counter = { opens: [] as string[], bytes: 0 };
		failure(await finalizeChangeSetV2(baseInput(root, broken), {
			identity_adapter: countingAdapter(counter),
		}), "invalid_journal");
		assert.deepEqual(counter, { opens: [], bytes: 0 });
	});
});

test("invalid lower-limit and options schemas fail before reads", async () => {
	await withRoot(async (root) => {
		const sealed = journal([]);
		const input = baseInput(root, sealed);
		failure(await finalizeChangeSetV2(input, { limits: { max_paths: 501 } }), "invalid_input");
		failure(await finalizeChangeSetV2(input, { limits: { max_total_bytes: 0 } }), "invalid_input");
		failure(await finalizeChangeSetV2(input, { extra: true } as never), "invalid_input");
		failure(await finalizeChangeSetV2({ ...input, project_root: "" }), "invalid_input");
	});
});
