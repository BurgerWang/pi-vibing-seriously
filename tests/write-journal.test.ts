import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
	beginWriteJournalOperation,
	completeWriteJournalOperation,
	computeWorkerWriteJournalHash,
	createNodeWriteJournalStorageAdapter,
	createWorkerWriteJournal,
	readWorkerWriteJournal,
	sealWorkerWriteJournal,
	validateWorkerWriteJournalRecord,
	workerWriteJournalRelativePath,
	WRITE_JOURNAL_MAX_OPERATIONS,
	WRITE_JOURNAL_STORAGE_FAULT_POINTS,
	type WorkerWriteJournalRecord,
	type WriteJournalErrorCode,
	type WriteJournalOptions,
	type WriteJournalResult,
	type WriteJournalStorageAdapter,
	type WriteJournalStorageFaultPoint,
} from "../extensions/workbench-runtime/core/write-journal.ts";
import {
	createNodeStreamingIdentityAdapter,
	type StreamingIdentityAdapter,
} from "../extensions/workbench-runtime/core/streaming-identity.ts";

const DELEGATION_ID = "20260820-120000-wrjt";
const CONTRACT_HASH = "c".repeat(64);
const OP_1 = "1".repeat(64);
const OP_2 = "2".repeat(64);
const OP_3 = "3".repeat(64);

interface Fixture {
	root: string;
	base: { project_root: string; delegation_id: string; contract_hash: string };
	record: string;
	lock: string;
}

async function fixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "write-journal-"));
	const relative = workerWriteJournalRelativePath(DELEGATION_ID);
	assert.ok(relative);
	return {
		root,
		base: { project_root: root, delegation_id: DELEGATION_ID, contract_hash: CONTRACT_HASH },
		record: join(root, ...relative.split("/")),
		lock: join(root, ".pi", "workbench", "delegations", DELEGATION_ID, "v2", "write-journal.lock"),
	};
}

async function cleanup(item: Fixture): Promise<void> {
	await rm(item.root, { recursive: true, force: true });
}

function success<T>(result: WriteJournalResult<T>): T {
	assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}:${result.error.point ?? "none"}`);
	if (!result.ok) throw new Error("expected success");
	return result.value;
}

function failure<T>(result: WriteJournalResult<T>, code: WriteJournalErrorCode, point?: WriteJournalStorageFaultPoint) {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected failure");
	assert.equal(result.error.code, code);
	if (point !== undefined) assert.equal(result.error.point, point);
	return result.error;
}

function sha(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function begin(
	fx: Fixture,
	revision: number,
	operation_id: string,
	kind: "edit" | "write",
	path: string,
	options?: WriteJournalOptions,
) {
	return beginWriteJournalOperation({ ...fx.base, expected_revision: revision, operation_id, kind, path }, options);
}

async function complete(
	fx: Fixture,
	revision: number,
	operation_id: string,
	kind: "edit" | "write",
	path: string,
	outcome: "succeeded" | "failed",
	options?: WriteJournalOptions,
) {
	return completeWriteJournalOperation({ ...fx.base, expected_revision: revision, operation_id, kind, path, outcome }, options);
}

function faultingAdapter(
	point: WriteJournalStorageFaultPoint,
	overrides?: Partial<Pick<WriteJournalStorageAdapter, "isProcessAlive" | "move">>,
): WriteJournalStorageAdapter {
	let fired = false;
	const base = createNodeWriteJournalStorageAdapter((seen) => {
		if (!fired && seen === point) {
			fired = true;
			throw new Error("PRIVATE_FAULT_DETAIL_SHOULD_NOT_LEAK");
		}
	});
	return {
		...base,
		...(overrides?.isProcessAlive === undefined ? {} : { isProcessAlive: overrides.isProcessAlive }),
		...(overrides?.move === undefined ? {} : { move: overrides.move }),
	};
}

function countingIdentityAdapter(counter: { bytes: number }): StreamingIdentityAdapter {
	const base = createNodeStreamingIdentityAdapter();
	return {
		...base,
		async openNoFollow(path) {
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

async function writeCanonical(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("create/read use one exact bound v2 record; missing is not empty and caller input is immutable", async () => {
	const fx = await fixture();
	try {
		failure(await readWorkerWriteJournal(fx.base), "not_found");
		const input = {
			...fx.base,
			limits: {
				max_unique_paths: 3,
				max_operations: 6,
				max_identity_paths: 6,
				max_total_bytes: 1_024,
				max_file_bytes: 512,
				max_serialized_bytes: 32_768,
			},
		};
		const snapshot = structuredClone(input);
		const created = success(await createWorkerWriteJournal(input));
		assert.deepEqual(input, snapshot);
		assert.equal(created.schema_version, 2);
		assert.equal(created.state, "OPEN");
		assert.equal(created.revision, 0);
		assert.deepEqual(created.operations, []);
		assert.deepEqual(created.meter, { paths_attempted: 0, paths_completed: 0, bytes_read: 0 });
		assert.equal(created.journal_hash, null);
		assert.deepEqual(success(await readWorkerWriteJournal(fx.base)), created);
		failure(await createWorkerWriteJournal(input), "conflict");
		failure(await readWorkerWriteJournal({ ...fx.base, contract_hash: "d".repeat(64) }), "invalid_record");
		assert.equal(workerWriteJournalRelativePath("bad-id"), undefined);
	} finally {
		await cleanup(fx);
	}
});

test("pure strict record validator reuses every journal invariant without requiring object key order", async () => {
	const fx = await fixture();
	try {
		await writeFile(join(fx.root, "chain.txt"), "one");
		success(await createWorkerWriteJournal(fx.base));
		success(await begin(fx, 0, OP_1, "edit", "chain.txt"));
		await writeFile(join(fx.root, "chain.txt"), "two");
		success(await complete(fx, 1, OP_1, "edit", "chain.txt", "succeeded"));
		success(await begin(fx, 2, OP_2, "write", "chain.txt"));
		await writeFile(join(fx.root, "chain.txt"), "three");
		const open = success(await complete(fx, 3, OP_2, "write", "chain.txt", "failed"));
		const snapshot = structuredClone(open);
		assert.equal(validateWorkerWriteJournalRecord(open), true);
		assert.deepEqual(open, snapshot, "validation cannot mutate its caller-owned input");

		const reordered = {
			journal_hash: open.journal_hash,
			operations: open.operations.map((operation) => ({
				...(operation.status === "completed" ? { outcome: operation.outcome, after: operation.after } : {}),
				before: operation.before,
				status: operation.status,
				path: operation.path,
				kind: operation.kind,
				operation_id: operation.operation_id,
				sequence: operation.sequence,
			})),
			meter: {
				bytes_read: open.meter.bytes_read,
				paths_completed: open.meter.paths_completed,
				paths_attempted: open.meter.paths_attempted,
			},
			limits: {
				max_serialized_bytes: open.limits.max_serialized_bytes,
				max_file_bytes: open.limits.max_file_bytes,
				max_total_bytes: open.limits.max_total_bytes,
				max_identity_paths: open.limits.max_identity_paths,
				max_operations: open.limits.max_operations,
				max_unique_paths: open.limits.max_unique_paths,
			},
			revision: open.revision,
			state: open.state,
			contract_hash: open.contract_hash,
			delegation_id: open.delegation_id,
			schema_version: open.schema_version,
		};
		assert.equal(validateWorkerWriteJournalRecord(reordered), true);

		assert.equal(validateWorkerWriteJournalRecord({ ...open, unknown: true }), false);
		assert.equal(validateWorkerWriteJournalRecord({
			...open,
			limits: { ...open.limits, max_operations: 1 },
		}), false);
		assert.equal(validateWorkerWriteJournalRecord({
			...open,
			meter: { ...open.meter, paths_attempted: 0 },
		}), false);

		const brokenChain = structuredClone(open) as WorkerWriteJournalRecord;
		const second = brokenChain.operations[1];
		assert.equal(second?.status, "completed");
		if (second?.status !== "completed" || second.before.kind !== "file") throw new Error("expected second file identity");
		second.before.sha256 = "0".repeat(64);
		assert.equal(validateWorkerWriteJournalRecord(brokenChain), false);

		const brokenPendingLayout = structuredClone(open) as unknown as { operations: unknown[] };
		const first = open.operations[0];
		assert.ok(first);
		brokenPendingLayout.operations[0] = {
			sequence: first.sequence,
			operation_id: first.operation_id,
			kind: first.kind,
			path: first.path,
			status: "pending",
			before: first.before,
		};
		assert.equal(validateWorkerWriteJournalRecord(brokenPendingLayout), false);

		let accessorCalls = 0;
		const accessor = structuredClone(open) as unknown as Record<string, unknown>;
		Object.defineProperty(accessor, "state", {
			enumerable: true,
			get() { accessorCalls += 1; throw new Error("must not execute"); },
		});
		assert.equal(validateWorkerWriteJournalRecord(accessor), false);
		assert.equal(accessorCalls, 0);

		let proxyTrapCalls = 0;
		const proxy = new Proxy(structuredClone(open), {
			ownKeys() { proxyTrapCalls += 1; throw new Error("must not execute"); },
			getPrototypeOf() { proxyTrapCalls += 1; throw new Error("must not execute"); },
		});
		assert.equal(validateWorkerWriteJournalRecord(proxy), false);
		assert.equal(proxyTrapCalls, 0);

		const sealed = success(await sealWorkerWriteJournal({ ...fx.base, expected_revision: open.revision }));
		assert.equal(validateWorkerWriteJournalRecord(sealed), true);
		assert.equal(validateWorkerWriteJournalRecord({ ...sealed, journal_hash: "0".repeat(64) }), false);
	} finally {
		await cleanup(fx);
	}
});

test("edit, write, failed outcome, and repeated-path identity chain are fully attributable", async () => {
	const fx = await fixture();
	try {
		await writeFile(join(fx.root, "tracked.txt"), "before");
		success(await createWorkerWriteJournal(fx.base));

		const firstPending = success(await begin(fx, 0, OP_1, "edit", "tracked.txt"));
		assert.equal(firstPending.revision, 1);
		assert.equal(firstPending.operations[0]?.status, "pending");
		await writeFile(join(fx.root, "tracked.txt"), "after-one");
		const firstDone = success(await complete(fx, 1, OP_1, "edit", "tracked.txt", "succeeded"));
		assert.equal(firstDone.revision, 2);
		assert.equal(firstDone.operations[0]?.status, "completed");
		assert.equal(firstDone.operations[0]?.status === "completed" && firstDone.operations[0].after.kind === "file"
			? firstDone.operations[0].after.sha256 : "", sha("after-one"));

		const secondPending = success(await begin(fx, 2, OP_2, "write", "tracked.txt"));
		assert.deepEqual(secondPending.operations[1]?.before,
			firstDone.operations[0]?.status === "completed" ? firstDone.operations[0].after : undefined);
		await writeFile(join(fx.root, "tracked.txt"), "tool-failed-but-file-changed");
		const secondDone = success(await complete(fx, 3, OP_2, "write", "tracked.txt", "failed"));
		assert.equal(secondDone.operations[1]?.status === "completed" && secondDone.operations[1].outcome, "failed");
		assert.deepEqual(secondDone.meter, {
			paths_attempted: 4,
			paths_completed: 4,
			bytes_read: Buffer.byteLength("beforeafter-oneafter-onetool-failed-but-file-changed"),
		});
	} finally {
		await cleanup(fx);
	}
});

test("Unicode-path deletion and recreation retain missing/file identities in one exact chain", async () => {
	const fx = await fixture();
	try {
		const path = "目录/你好-🌱.txt";
		await mkdir(join(fx.root, "目录"));
		await writeFile(join(fx.root, path), "present-before-delete");
		success(await createWorkerWriteJournal(fx.base));
		const deletePending = success(await begin(fx, 0, OP_1, "edit", path));
		assert.equal(deletePending.operations[0]?.before.kind, "file");
		await unlink(join(fx.root, path));
		const deleted = success(await complete(fx, 1, OP_1, "edit", path, "succeeded"));
		assert.equal(deleted.operations[0]?.status === "completed" && deleted.operations[0].after.kind, "missing");
		const createPending = success(await begin(fx, 2, OP_2, "write", path));
		assert.equal(createPending.operations[1]?.before.kind, "missing");
		await writeFile(join(fx.root, path), "created-again");
		const created = success(await complete(fx, 3, OP_2, "write", path, "succeeded"));
		assert.equal(created.operations[1]?.status === "completed" && created.operations[1].after.kind, "file");
		assert.deepEqual(success(await readWorkerWriteJournal(fx.base)), created);
	} finally {
		await cleanup(fx);
	}
});

test("pending is globally exclusive and strict CAS/id/kind/path/order/replay failures do not invoke tools", async () => {
	const fx = await fixture();
	try {
		await writeFile(join(fx.root, "a.txt"), "a");
		await writeFile(join(fx.root, "b.txt"), "b");
		success(await createWorkerWriteJournal(fx.base));
		success(await begin(fx, 0, OP_1, "edit", "a.txt"));
		for (const attempted of [
			begin(fx, 1, OP_2, "write", "b.txt"),
			begin(fx, 0, OP_2, "write", "b.txt"),
			complete(fx, 1, OP_2, "edit", "a.txt", "succeeded"),
			complete(fx, 1, OP_1, "write", "a.txt", "succeeded"),
			complete(fx, 1, OP_1, "edit", "b.txt", "succeeded"),
		]) failure(await attempted, "conflict");
		failure(await sealWorkerWriteJournal({ ...fx.base, expected_revision: 1 }), "conflict");
		const done = success(await complete(fx, 1, OP_1, "edit", "a.txt", "succeeded"));
		failure(await complete(fx, 2, OP_1, "edit", "a.txt", "succeeded"), "conflict");
		failure(await begin(fx, 2, OP_1, "edit", "a.txt"), "conflict");
		assert.deepEqual(success(await readWorkerWriteJournal(fx.base)), done);
		failure(await begin(fx, 2, OP_2, "edit", "../escape"), "invalid_path");
	} finally {
		await cleanup(fx);
	}
});

test("concurrent begin has exactly one publisher and duplicate operation ids remain rejected", async () => {
	const fx = await fixture();
	try {
		await writeFile(join(fx.root, "a.txt"), "a");
		await writeFile(join(fx.root, "b.txt"), "b");
		success(await createWorkerWriteJournal(fx.base));
		const results = await Promise.all([
			begin(fx, 0, OP_1, "edit", "a.txt"),
			begin(fx, 0, OP_2, "write", "b.txt"),
		]);
		assert.equal(results.filter((result) => result.ok).length, 1);
		assert.equal(results.filter((result) => !result.ok && result.error.code === "conflict").length, 1);
		const current = success(await readWorkerWriteJournal(fx.base));
		assert.equal(current.revision, 1);
		assert.equal(current.operations.length, 1);
	} finally {
		await cleanup(fx);
	}
});

test("strict reader rejects corrupt, truncated, unknown-schema, symlink, and repeated-chain identity conflict", async () => {
	for (const mutation of ["corrupt", "truncated", "unknown"] as const) {
		const fx = await fixture();
		try {
			success(await createWorkerWriteJournal(fx.base));
			if (mutation === "corrupt") await writeFile(fx.record, "{not-json}\n", "utf8");
			if (mutation === "truncated") {
				const raw = await readFile(fx.record);
				await writeFile(fx.record, raw.subarray(0, Math.max(1, raw.length - 3)));
			}
			if (mutation === "unknown") {
				const raw = JSON.parse(await readFile(fx.record, "utf8"));
				raw.schema_version = 99;
				await writeCanonical(fx.record, raw);
			}
			failure(await readWorkerWriteJournal(fx.base), "invalid_record");
		} finally {
			await cleanup(fx);
		}
	}

	const oversizedFx = await fixture();
	try {
		success(await createWorkerWriteJournal(oversizedFx.base));
		await writeFile(oversizedFx.record, Buffer.alloc(4 * 1024 * 1024 + 1, 0x7b));
		failure(await readWorkerWriteJournal(oversizedFx.base), "invalid_record");
	} finally {
		await cleanup(oversizedFx);
	}

	const symlinkFx = await fixture();
	try {
		await mkdir(dirname(symlinkFx.record), { recursive: true });
		await writeFile(join(symlinkFx.root, "outside.json"), "{}\n");
		await symlink(join(symlinkFx.root, "outside.json"), symlinkFx.record);
		failure(await readWorkerWriteJournal(symlinkFx.base), "invalid_record");
	} finally {
		await cleanup(symlinkFx);
	}

	const chainFx = await fixture();
	try {
		await writeFile(join(chainFx.root, "same.txt"), "one");
		success(await createWorkerWriteJournal(chainFx.base));
		success(await begin(chainFx, 0, OP_1, "edit", "same.txt"));
		await writeFile(join(chainFx.root, "same.txt"), "two");
		success(await complete(chainFx, 1, OP_1, "edit", "same.txt", "succeeded"));
		success(await begin(chainFx, 2, OP_2, "edit", "same.txt"));
		await writeFile(join(chainFx.root, "same.txt"), "three");
		success(await complete(chainFx, 3, OP_2, "edit", "same.txt", "succeeded"));
		const raw = JSON.parse(await readFile(chainFx.record, "utf8"));
		raw.operations[1].before.sha256 = "f".repeat(64);
		await writeCanonical(chainFx.record, raw);
		failure(await readWorkerWriteJournal(chainFx.base), "invalid_record");
	} finally {
		await cleanup(chainFx);
	}
});

test("strict reader binds meter lower bounds to every persisted file identity", async () => {
	const completedFx = await fixture();
	try {
		await writeFile(join(completedFx.root, "a"), "before");
		success(await createWorkerWriteJournal(completedFx.base));
		success(await begin(completedFx, 0, OP_1, "edit", "a"));
		await writeFile(join(completedFx.root, "a"), "after");
		const completed = success(await complete(completedFx, 1, OP_1, "edit", "a", "succeeded"));
		const validRaw = JSON.parse(await readFile(completedFx.record, "utf8"));
		const exactBytes = completed.operations[0]?.status === "completed"
			&& completed.operations[0].before.kind === "file" && completed.operations[0].after.kind === "file"
			? completed.operations[0].before.byte_size + completed.operations[0].after.byte_size
			: -1;
		assert.ok(exactBytes > 0);
		for (const field of ["bytes_read", "paths_completed", "paths_attempted"] as const) {
			const raw = structuredClone(validRaw);
			if (field === "bytes_read") raw.meter.bytes_read = exactBytes - 1;
			else if (field === "paths_completed") raw.meter.paths_completed = 1;
			else {
				raw.meter.paths_attempted = 1;
				raw.meter.paths_completed = 1;
			}
			await writeCanonical(completedFx.record, raw);
			failure(await readWorkerWriteJournal(completedFx.base), "invalid_record");
		}
	} finally { await cleanup(completedFx); }

	const pendingFx = await fixture();
	try {
		await writeFile(join(pendingFx.root, "a"), "pending-before");
		success(await createWorkerWriteJournal(pendingFx.base));
		const pending = success(await begin(pendingFx, 0, OP_1, "edit", "a"));
		const raw = JSON.parse(await readFile(pendingFx.record, "utf8"));
		assert.equal(pending.operations[0]?.before.kind, "file");
		const exactBytes = pending.operations[0]?.before.kind === "file"
			? pending.operations[0].before.byte_size : -1;
		raw.meter.bytes_read = exactBytes - 1;
		await writeCanonical(pendingFx.record, raw);
		failure(await readWorkerWriteJournal(pendingFx.base), "invalid_record");
	} finally { await cleanup(pendingFx); }

	const allowanceFx = await fixture();
	try {
		await writeFile(join(allowanceFx.root, "a"), "allowance");
		success(await createWorkerWriteJournal(allowanceFx.base));
		success(await begin(allowanceFx, 0, OP_1, "edit", "a"));
		const raw = JSON.parse(await readFile(allowanceFx.record, "utf8"));
		raw.meter.bytes_read += 1;
		raw.meter.paths_attempted += 1;
		await writeCanonical(allowanceFx.record, raw);
		const accepted = success(await readWorkerWriteJournal(allowanceFx.base));
		assert.equal(accepted.meter.bytes_read, Buffer.byteLength("allowance") + 1,
			"failed/partial captures may leave a conservative durable overcount");
		assert.equal(accepted.meter.paths_attempted, 2);
		assert.equal(accepted.meter.paths_completed, 1);
	} finally { await cleanup(allowanceFx); }

	const overflowFx = await fixture();
	try {
		await writeFile(join(overflowFx.root, "a"), "x");
		success(await createWorkerWriteJournal(overflowFx.base));
		success(await begin(overflowFx, 0, OP_1, "edit", "a"));
		await writeFile(join(overflowFx.root, "a"), "y");
		success(await complete(overflowFx, 1, OP_1, "edit", "a", "succeeded"));
		const raw = JSON.parse(await readFile(overflowFx.record, "utf8"));
		raw.operations[0].before.byte_size = Number.MAX_SAFE_INTEGER;
		raw.operations[0].after.byte_size = Number.MAX_SAFE_INTEGER;
		raw.meter.bytes_read = Number.MAX_SAFE_INTEGER;
		await writeCanonical(overflowFx.record, raw);
		failure(await readWorkerWriteJournal(overflowFx.base), "invalid_record");
	} finally { await cleanup(overflowFx); }
});

test("one-shot pre-rename begin/complete faults recover intended state without resetting the byte cap", async () => {
	for (const phase of ["begin", "complete"] as const) {
		for (const suffix of ["temp.write", "temp.read", "rename"] as const) {
			const fx = await fixture();
			try {
				await writeFile(join(fx.root, "a"), "data");
				success(await createWorkerWriteJournal({
					...fx.base,
					limits: { max_total_bytes: phase === "begin" ? 4 : 8 },
				}));
				if (phase === "complete") success(await begin(fx, 0, OP_1, "edit", "a"));
				const counter = { bytes: 0 };
				const identity = countingIdentityAdapter(counter);
				const faultPoint = `${phase}.${suffix}` as WriteJournalStorageFaultPoint;
				const first = phase === "begin"
					? await begin(fx, 0, OP_1, "edit", "a", {
						storage_adapter: faultingAdapter(faultPoint), identity_adapter: identity,
					})
					: await complete(fx, 1, OP_1, "edit", "a", "succeeded", {
						storage_adapter: faultingAdapter(faultPoint), identity_adapter: identity,
					});
				failure(first, "storage_failure", faultPoint);
				assert.equal(counter.bytes, 4, "the injected publication fault follows a successful full capture");

				const durable = success(await readWorkerWriteJournal(fx.base));
				assert.equal(durable.meter.bytes_read, phase === "begin" ? 4 : 8);
				const operation = durable.operations[0];
				assert.equal(operation?.status, phase === "begin" ? "pending" : "completed",
					"the tool-attempt state is durably retained despite the reported fault");
				if (phase === "complete") {
					assert.equal(operation?.status === "completed" && operation.outcome, "succeeded");
				}

				const retried = phase === "begin"
					? await begin(fx, durable.revision, OP_1, "edit", "a", { identity_adapter: identity })
					: await complete(fx, durable.revision, OP_1, "edit", "a", "succeeded", { identity_adapter: identity });
				failure(retried, "conflict");
				assert.equal(counter.bytes, 4, "retry is rejected before identity I/O and cannot exceed the cap");
				assert.deepEqual(success(await readWorkerWriteJournal(fx.base)), durable);
			} finally { await cleanup(fx); }
		}
	}
});

test(">4 MiB equal-prefix/equal-size tail identities survive exact journal round trips", async () => {
	const fx = await fixture();
	try {
		const prefix = Buffer.alloc(4 * 1024 * 1024, 0x61);
		const before = Buffer.concat([prefix, Buffer.from("left-tail")]);
		const after = Buffer.concat([prefix, Buffer.from("rite-tail")]);
		assert.equal(before.length, after.length);
		await writeFile(join(fx.root, "large.bin"), before);
		success(await createWorkerWriteJournal(fx.base));
		success(await begin(fx, 0, OP_1, "write", "large.bin"));
		await writeFile(join(fx.root, "large.bin"), after);
		const completed = success(await complete(fx, 1, OP_1, "write", "large.bin", "succeeded"));
		const operation = completed.operations[0];
		assert.equal(operation?.status, "completed");
		if (operation?.status !== "completed" || operation.before.kind !== "file" || operation.after.kind !== "file") {
			throw new Error("expected file identities");
		}
		assert.equal(operation.before.sha256, sha(before));
		assert.equal(operation.after.sha256, sha(after));
		assert.notEqual(operation.before.sha256, operation.after.sha256);
		assert.equal(completed.meter.bytes_read, before.length + after.length);
		assert.deepEqual(success(await readWorkerWriteJournal(fx.base)), completed);
	} finally {
		await cleanup(fx);
	}
});

test("cumulative meter cannot reset; identity cap remains authoritative before operation headroom", async () => {
	const fx = await fixture();
	try {
		await writeFile(join(fx.root, "a.txt"), "aa");
		await writeFile(join(fx.root, "b.txt"), "bbb");
		success(await createWorkerWriteJournal({
			...fx.base,
			limits: { max_operations: WRITE_JOURNAL_MAX_OPERATIONS, max_identity_paths: 2 },
		}));
		const one = success(await begin(fx, 0, OP_1, "edit", "a.txt"));
		assert.deepEqual(one.meter, { paths_attempted: 1, paths_completed: 1, bytes_read: 2 });
		const two = success(await complete(fx, 1, OP_1, "edit", "a.txt", "succeeded"));
		assert.deepEqual(two.meter, { paths_attempted: 2, paths_completed: 2, bytes_read: 4 });
		const overflow = failure(await begin(fx, 2, OP_2, "edit", "b.txt"), "identity_failure");
		assert.equal(overflow.identity_code, "path_count_overflow");
		assert.equal(overflow.current_revision, 2, "preflight overflow consumes no meter and no revision");
		assert.deepEqual(success(await readWorkerWriteJournal(fx.base)).meter, two.meter);
	} finally {
		await cleanup(fx);
	}
});

test("path, operation, byte, and serialized limits fail explicitly without truncation", async () => {
	const serializedFx = await fixture();
	try {
		failure(await createWorkerWriteJournal({ ...serializedFx.base, limits: { max_serialized_bytes: 1 } }), "limit_exceeded");
	} finally { await cleanup(serializedFx); }

	const operationFx = await fixture();
	try {
		await writeFile(join(operationFx.root, "a"), "a");
		await writeFile(join(operationFx.root, "b"), "b");
		success(await createWorkerWriteJournal({ ...operationFx.base, limits: { max_operations: 1 } }));
		failure(await begin(operationFx, 0, "short", "edit", "a"), "invalid_input");
		failure(await begin(operationFx, 0, OP_2, "edit", `${"p".repeat(401)}`), "invalid_path");
		success(await begin(operationFx, 0, OP_1, "edit", "a"));
		success(await complete(operationFx, 1, OP_1, "edit", "a", "succeeded"));
		failure(await begin(operationFx, 2, OP_2, "edit", "b"), "limit_exceeded");
	} finally { await cleanup(operationFx); }

	const pathFx = await fixture();
	try {
		await writeFile(join(pathFx.root, "a"), "a");
		await writeFile(join(pathFx.root, "b"), "b");
		success(await createWorkerWriteJournal({ ...pathFx.base, limits: { max_unique_paths: 1 } }));
		success(await begin(pathFx, 0, OP_1, "edit", "a"));
		success(await complete(pathFx, 1, OP_1, "edit", "a", "succeeded"));
		failure(await begin(pathFx, 2, OP_2, "edit", "b"), "limit_exceeded");
	} finally { await cleanup(pathFx); }

	const byteFx = await fixture();
	try {
		await writeFile(join(byteFx.root, "large"), "12345");
		success(await createWorkerWriteJournal({ ...byteFx.base, limits: { max_total_bytes: 4 } }));
		const error = failure(await begin(byteFx, 0, OP_1, "write", "large"), "identity_failure");
		assert.equal(error.identity_code, "total_bytes_overflow");
		assert.equal(error.current_revision, 1, "attempt meter is durably advanced despite identity failure");
		assert.deepEqual(success(await readWorkerWriteJournal(byteFx.base)).meter,
			{ paths_attempted: 1, paths_completed: 0, bytes_read: 0 });
	} finally { await cleanup(byteFx); }
});

test("external change between repeated attempts is an identity conflict and no new pending entry is attributed", async () => {
	const fx = await fixture();
	try {
		await writeFile(join(fx.root, "same"), "one");
		success(await createWorkerWriteJournal(fx.base));
		success(await begin(fx, 0, OP_1, "edit", "same"));
		await writeFile(join(fx.root, "same"), "two");
		success(await complete(fx, 1, OP_1, "edit", "same", "succeeded"));
		await writeFile(join(fx.root, "same"), "external-three");
		const error = failure(await begin(fx, 2, OP_2, "edit", "same"), "identity_failure");
		assert.equal(error.identity_code, "unstable");
		assert.equal(error.current_revision, 3);
		const current = success(await readWorkerWriteJournal(fx.base));
		assert.equal(current.operations.length, 1);
		assert.deepEqual(current.meter, {
			paths_attempted: 3,
			paths_completed: 3,
			bytes_read: Buffer.byteLength("onetwoexternal-three"),
		});
	} finally { await cleanup(fx); }
});

test("seal hash is deterministic, replay is immutable, and tampering is rejected", async () => {
	const fx = await fixture();
	try {
		await writeFile(join(fx.root, "a"), "a");
		success(await createWorkerWriteJournal(fx.base));
		success(await begin(fx, 0, OP_1, "edit", "a"));
		await writeFile(join(fx.root, "a"), "b");
		success(await complete(fx, 1, OP_1, "edit", "a", "succeeded"));
		const sealed = success(await sealWorkerWriteJournal({ ...fx.base, expected_revision: 2 }));
		assert.equal(sealed.state, "SEALED");
		assert.equal(sealed.revision, 3);
		assert.equal(sealed.journal_hash, computeWorkerWriteJournalHash(sealed));
		const bytes = await readFile(fx.record);
		const replay = success(await sealWorkerWriteJournal({ ...fx.base, expected_revision: 3 }));
		assert.deepEqual(replay, sealed);
		assert.deepEqual(await readFile(fx.record), bytes);
		failure(await begin(fx, 3, OP_2, "edit", "a"), "conflict");

		const raw = JSON.parse(await readFile(fx.record, "utf8"));
		raw.operations[0].outcome = "failed";
		await writeCanonical(fx.record, raw);
		failure(await readWorkerWriteJournal(fx.base), "invalid_record");
	} finally { await cleanup(fx); }
});

test("identity/storage errors expose only closed codes and never file content, paths, or raw errors", async () => {
	const fx = await fixture();
	const secret = "PRIVATE_SECRET_FILE_CONTENT_928374";
	try {
		await writeFile(join(fx.root, "secret-target"), secret);
		await symlink("secret-target", join(fx.root, "secret-link"));
		success(await createWorkerWriteJournal(fx.base));
		const identityError = failure(await begin(fx, 0, OP_1, "edit", "secret-link"), "identity_failure");
		assert.equal(identityError.identity_code, "path_symlink");
		const rendered = JSON.stringify(identityError);
		assert.ok(!rendered.includes(secret));
		assert.ok(!rendered.includes("secret-link"));

		const storageFx = await fixture();
		try {
			const error = failure(await createWorkerWriteJournal(storageFx.base, {
				storage_adapter: faultingAdapter("create.temp.write"),
			}), "storage_failure", "create.temp.write");
			assert.ok(!JSON.stringify(error).includes("PRIVATE_FAULT_DETAIL_SHOULD_NOT_LEAK"));
		} finally { await cleanup(storageFx); }
	} finally { await cleanup(fx); }
});

test("every declared storage fault point is exercised and reported at its exact point", async () => {
	const covered = new Set<WriteJournalStorageFaultPoint>();

	for (const point of [
		"layout.mkdir", "lock.acquire", "lock.owner.write", "lock.owner.read",
		"create.temp.write", "create.temp.read", "create.rename", "create.final.read",
		"lock.release.rename", "lock.release.read", "lock.release.unlink",
	] as const) {
		const fx = await fixture();
		try {
			failure(await createWorkerWriteJournal(fx.base, { storage_adapter: faultingAdapter(point) }), "storage_failure", point);
			covered.add(point);
		} finally { await cleanup(fx); }
	}

	{
		const fx = await fixture();
		try {
			success(await createWorkerWriteJournal(fx.base));
			failure(await readWorkerWriteJournal(fx.base, { storage_adapter: faultingAdapter("record.read") }),
				"storage_failure", "record.read");
			covered.add("record.read");
		} finally { await cleanup(fx); }
	}

	for (const phase of ["begin", "complete", "seal"] as const) {
		for (const suffix of ["temp.write", "temp.read", "rename", "final.read"] as const) {
			const point = `${phase}.${suffix}` as WriteJournalStorageFaultPoint;
			const fx = await fixture();
			try {
				await writeFile(join(fx.root, "a"), "a");
				success(await createWorkerWriteJournal(fx.base));
				if (phase === "begin") {
					failure(await begin(fx, 0, OP_1, "edit", "a", { storage_adapter: faultingAdapter(point) }),
						"storage_failure", point);
				} else if (phase === "complete") {
					success(await begin(fx, 0, OP_1, "edit", "a"));
					failure(await complete(fx, 1, OP_1, "edit", "a", "succeeded", { storage_adapter: faultingAdapter(point) }),
						"storage_failure", point);
				} else {
					failure(await sealWorkerWriteJournal({ ...fx.base, expected_revision: 0 },
						{ storage_adapter: faultingAdapter(point) }), "storage_failure", point);
				}
				covered.add(point);
			} finally { await cleanup(fx); }
		}
	}

	for (const point of ["lock.recover.rename", "lock.recover.read", "lock.recover.unlink"] as const) {
		const fx = await fixture();
		try {
			success(await createWorkerWriteJournal(fx.base));
			await writeCanonical(fx.lock, {
				schema_version: 2,
				delegation_id: DELEGATION_ID,
				token: "a".repeat(32),
				process_id: 999_999_999,
			});
			const adapter = faultingAdapter(point);
			adapter.isProcessAlive = () => false;
			failure(await createWorkerWriteJournal(fx.base, { storage_adapter: adapter }), "conflict", point);
			covered.add(point);
		} finally { await cleanup(fx); }
	}

	assert.deepEqual([...covered].sort(), [...WRITE_JOURNAL_STORAGE_FAULT_POINTS].sort());
});

test("foreign live lock and token-swapped release are never deleted as owned cleanup", async () => {
	const staleFx = await fixture();
	try {
		await writeFile(join(staleFx.root, "a"), "a");
		success(await createWorkerWriteJournal(staleFx.base));
		await writeCanonical(staleFx.lock, {
			schema_version: 2,
			delegation_id: DELEGATION_ID,
			token: "d".repeat(32),
			process_id: 999_999_999,
		});
		const adapter = createNodeWriteJournalStorageAdapter();
		adapter.isProcessAlive = () => false;
		const recovered = success(await begin(staleFx, 0, OP_1, "edit", "a", { storage_adapter: adapter }));
		assert.equal(recovered.revision, 1);
		await assert.rejects(readFile(staleFx.lock), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	} finally { await cleanup(staleFx); }

	const liveFx = await fixture();
	try {
		await mkdir(dirname(liveFx.lock), { recursive: true });
		await writeCanonical(liveFx.lock, {
			schema_version: 2,
			delegation_id: DELEGATION_ID,
			token: "f".repeat(32),
			process_id: process.pid,
		});
		failure(await createWorkerWriteJournal(liveFx.base), "conflict", "lock.acquire");
		assert.equal(JSON.parse(await readFile(liveFx.lock, "utf8")).token, "f".repeat(32));
	} finally { await cleanup(liveFx); }

	const swappedFx = await fixture();
	try {
		const base = createNodeWriteJournalStorageAdapter();
		const foreign = {
			schema_version: 2,
			delegation_id: DELEGATION_ID,
			token: "e".repeat(32),
			process_id: process.pid,
		};
		const adapter: WriteJournalStorageAdapter = {
			...base,
			async move(source, destination) {
				await base.move(source, destination);
				if (destination.includes(".release.")) await writeCanonical(destination, foreign);
			},
		};
		failure(await createWorkerWriteJournal(swappedFx.base, { storage_adapter: adapter }),
			"storage_failure", "lock.release.read");
		assert.equal(JSON.parse(await readFile(swappedFx.lock, "utf8")).token, foreign.token,
			"foreign token is restored to the lock path, never unlinked as the caller's lock");
	} finally { await cleanup(swappedFx); }
});

test("all public operation inputs remain unmodified", async () => {
	const fx = await fixture();
	try {
		await writeFile(join(fx.root, "a"), "a");
		const createInput = { ...fx.base, limits: { max_operations: 3 } };
		const createSnapshot = structuredClone(createInput);
		success(await createWorkerWriteJournal(createInput));
		assert.deepEqual(createInput, createSnapshot);
		const beginInput = { ...fx.base, expected_revision: 0, operation_id: OP_3, kind: "edit" as const, path: "a" };
		const beginSnapshot = structuredClone(beginInput);
		success(await beginWriteJournalOperation(beginInput));
		assert.deepEqual(beginInput, beginSnapshot);
		const completeInput = { ...beginInput, expected_revision: 1, outcome: "failed" as const };
		const completeSnapshot = structuredClone(completeInput);
		success(await completeWriteJournalOperation(completeInput));
		assert.deepEqual(completeInput, completeSnapshot);
		const sealInput = { ...fx.base, expected_revision: 2 };
		const sealSnapshot = structuredClone(sealInput);
		success(await sealWorkerWriteJournal(sealInput));
		assert.deepEqual(sealInput, sealSnapshot);
	} finally { await cleanup(fx); }
});
