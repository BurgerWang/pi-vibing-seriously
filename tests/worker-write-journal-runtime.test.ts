import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
	EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
	WORKER_WRITE_JOURNAL_RUNTIME_BLOCK_REASON,
	WORKER_WRITE_JOURNAL_RUNTIME_OPERATION_SCHEMA,
	WORKER_WRITE_JOURNAL_RUNTIME_SERIALIZE_REASON,
	WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_ENTRY_TYPE,
	WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA,
	createWorkerWriteJournalRuntime,
	deriveWorkerWriteJournalOperationId,
	normalizeWorkerWriteJournalPath,
	observeWorkerWriteJournalRuntimeEntry,
	type WorkerWriteJournalRuntime,
	type WorkerWriteJournalRuntimeContext,
	type WorkerWriteJournalRuntimeObservation,
	type WorkerWriteJournalRuntimeTelemetry,
} from "../extensions/workbench-runtime/core/worker-write-journal-runtime.ts";
import {
	createWorkerWriteJournal,
	readWorkerWriteJournal,
	workerWriteJournalRelativePath,
} from "../extensions/workbench-runtime/core/write-journal.ts";

const DELEGATION_ID = "20260820-120000-A1b2";
const CONTRACT_HASH = "a".repeat(64);

interface Fixture {
	root: string;
	context: WorkerWriteJournalRuntimeContext;
	telemetry: WorkerWriteJournalRuntimeTelemetry[];
	runtime: WorkerWriteJournalRuntime;
}

async function fixture(options?: {
	create?: boolean;
	limits?: Parameters<typeof createWorkerWriteJournal>[0]["limits"];
	appendTelemetry?: (telemetry: Readonly<WorkerWriteJournalRuntimeTelemetry>) => void;
}): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "worker-write-journal-runtime-"));
	const context: WorkerWriteJournalRuntimeContext = {
		role: "worker",
		task_kind: "implementation",
		project_root: root,
		delegation_id: DELEGATION_ID,
		contract_hash: CONTRACT_HASH,
	};
	if (options?.create !== false) {
		const created = await createWorkerWriteJournal({
			project_root: root,
			delegation_id: DELEGATION_ID,
			contract_hash: CONTRACT_HASH,
			...(options?.limits === undefined ? {} : { limits: options.limits }),
		});
		assert.equal(created.ok, true);
	}
	const telemetry: WorkerWriteJournalRuntimeTelemetry[] = [];
	const appendTelemetry = options?.appendTelemetry ?? ((value: Readonly<WorkerWriteJournalRuntimeTelemetry>) => {
		telemetry.push(structuredClone(value));
	});
	return {
		root,
		context,
		telemetry,
		runtime: createWorkerWriteJournalRuntime(context, { appendTelemetry }),
	};
}

async function cleanup(fx: Pick<Fixture, "root">): Promise<void> {
	await rm(fx.root, { recursive: true, force: true });
}

async function journal(fx: Fixture) {
	const result = await readWorkerWriteJournal({
		project_root: fx.root,
		delegation_id: DELEGATION_ID,
		contract_hash: CONTRACT_HASH,
	});
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("journal read failed");
	return result.value;
}

function assertClosedTelemetry(value: WorkerWriteJournalRuntimeTelemetry): void {
	assert.deepEqual(Object.keys(value).sort(), ["code", "outcome", "phase", "poisoned", "revision", "schema", "tool"]);
	assert.equal(value.schema, WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA);
	assert.ok(["begin", "complete", "failure"].includes(value.phase));
	assert.ok(["edit", "write"].includes(value.tool));
	assert.ok(["none", "succeeded", "failed"].includes(value.outcome));
	assert.equal(Number.isSafeInteger(value.revision) && value.revision >= 0, true);
	assert.ok(value.poisoned === 0 || value.poisoned === 1);
}

function telemetryEntry(
	data: unknown,
	patch: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		type: "custom",
		customType: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_ENTRY_TYPE,
		data,
		...patch,
	};
}

function telemetry(
	patch: Partial<WorkerWriteJournalRuntimeTelemetry> = {},
): WorkerWriteJournalRuntimeTelemetry {
	return {
		schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA,
		phase: "begin",
		tool: "edit",
		outcome: "none",
		code: "none",
		revision: 1,
		poisoned: 0,
		...patch,
	};
}

test("journal observation has an exact immutable empty value and unrelated entries preserve its identity", () => {
	assert.deepEqual(EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION, {
		state: "empty", tool: "none", outcome: "none", code: "none", revision: 0,
	});
	assert.deepEqual(Object.keys(EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION).sort(), [
		"code", "outcome", "revision", "state", "tool",
	]);
	assert.equal(Object.isFrozen(EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION), true);
	for (const unrelated of [
		null,
		{},
		{ type: "custom", customType: "some-other-entry", data: telemetry() },
		new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("must not inspect proxy"); } }),
	]) {
		assert.strictEqual(
			observeWorkerWriteJournalRuntimeEntry(unrelated, EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION),
			EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
		);
	}
});

test("journal observation accepts only exact monotonic begin and same-tool complete transitions", () => {
	const begin = telemetry();
	const beginSnapshot = structuredClone(begin);
	const begun = observeWorkerWriteJournalRuntimeEntry(
		telemetryEntry(begin),
		EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
	);
	assert.deepEqual(begun, { state: "begun", tool: "edit", outcome: "none", code: "none", revision: 1 });
	assert.equal(Object.isFrozen(begun), true);
	assert.deepEqual(begin, beginSnapshot, "telemetry input is not mutated");

	const completed = observeWorkerWriteJournalRuntimeEntry(telemetryEntry(telemetry({
		phase: "complete", outcome: "succeeded", revision: 2,
	})), begun);
	assert.deepEqual(completed, { state: "complete", tool: "edit", outcome: "succeeded", code: "none", revision: 2 });

	const writeBegun = observeWorkerWriteJournalRuntimeEntry(telemetryEntry(telemetry({
		tool: "write", revision: 3,
	})), completed);
	assert.deepEqual(writeBegun, { state: "begun", tool: "write", outcome: "none", code: "none", revision: 3 });
	const writeFailed = observeWorkerWriteJournalRuntimeEntry(telemetryEntry(telemetry({
		phase: "complete", tool: "write", outcome: "failed", revision: 4,
	})), writeBegun);
	assert.deepEqual(writeFailed, { state: "complete", tool: "write", outcome: "failed", code: "none", revision: 4 });
});

test("matching malformed, unknown, accessor, and proxy telemetry data fails invalid without invoking code", () => {
	let invoked = 0;
	const accessorData = Object.defineProperty(telemetry(), "outcome", {
		enumerable: true,
		get: () => {
			invoked += 1;
			return "none";
		},
	});
	const accessorEntry = Object.defineProperty({
		type: "custom",
		customType: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_ENTRY_TYPE,
	}, "data", {
		enumerable: true,
		get: () => {
			invoked += 1;
			return telemetry();
		},
	});
	const accessorCustomType = Object.defineProperty({
		type: "custom",
		data: telemetry(),
	}, "customType", {
		enumerable: true,
		get: () => {
			invoked += 1;
			return WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_ENTRY_TYPE;
		},
	});
	const proxyData = new Proxy(telemetry(), {
		getOwnPropertyDescriptor: () => {
			invoked += 1;
			throw new Error("PRIVATE_PROXY_TRAP");
		},
	});
	const malformed = [
		telemetryEntry({ ...telemetry(), unknown: "PRIVATE_UNKNOWN" }),
		telemetryEntry({ ...telemetry(), schema: "unknown" }),
		telemetryEntry({ ...telemetry(), revision: Number.MAX_SAFE_INTEGER + 1 }),
		telemetryEntry(accessorData),
		accessorEntry,
		accessorCustomType,
		telemetryEntry(proxyData),
	];
	for (const entry of malformed) {
		const observed = observeWorkerWriteJournalRuntimeEntry(entry, EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION);
		assert.deepEqual(observed, { state: "failed", tool: "none", outcome: "none", code: "invalid", revision: 0 });
		assert.equal(Object.isFrozen(observed), true);
		assert.equal(JSON.stringify(observed).includes("PRIVATE"), false);
	}
	assert.equal(invoked, 0, "accessors and proxy traps are never invoked");
});

test("journal observation fails sticky on gaps, duplicates, mismatches, and out-of-order entries", () => {
	const begun = observeWorkerWriteJournalRuntimeEntry(
		telemetryEntry(telemetry()),
		EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
	);
	const invalidEntries = [
		telemetry({ revision: 2 }),
		telemetry({ phase: "complete", outcome: "succeeded", revision: 1 }),
		telemetry({ phase: "complete", tool: "write", outcome: "succeeded", revision: 2 }),
		telemetry({ phase: "complete", outcome: "none", revision: 2 }),
		telemetry({ phase: "begin", code: "invalid_path", poisoned: 0, revision: 2 }),
		telemetry({ phase: "begin", code: "none", poisoned: 1, revision: 2 }),
	];
	for (const entry of invalidEntries) {
		const observed = observeWorkerWriteJournalRuntimeEntry(telemetryEntry(entry), begun);
		assert.deepEqual(observed, { state: "failed", tool: "none", outcome: "none", code: "invalid", revision: 1 });
		const repaired = observeWorkerWriteJournalRuntimeEntry(telemetryEntry(telemetry({
			phase: "complete", outcome: "succeeded", revision: 2,
		})), observed);
		assert.strictEqual(repaired, observed, "later valid telemetry cannot repair a failed observation");
	}
	const outOfOrder = observeWorkerWriteJournalRuntimeEntry(telemetryEntry(telemetry({
		phase: "complete", outcome: "succeeded", revision: 1,
	})), EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION);
	assert.equal(outOfOrder.state, "failed");
});

test("explicit journal failure telemetry is retained as bounded enums and remains sticky", () => {
	const failure = telemetry({
		phase: "failure",
		tool: "write",
		outcome: "failed",
		code: "journal_complete_failed",
		revision: 7,
		poisoned: 1,
	});
	const inputSnapshot = structuredClone(failure);
	const observed = observeWorkerWriteJournalRuntimeEntry(
		telemetryEntry(failure),
		EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
	);
	assert.deepEqual(observed, {
		state: "failed", tool: "write", outcome: "failed", code: "journal_complete_failed", revision: 7,
	});
	assert.deepEqual(failure, inputSnapshot);
	assert.strictEqual(
		observeWorkerWriteJournalRuntimeEntry(telemetryEntry(telemetry()), observed),
		observed,
	);
	const hostileCurrent = { ...observed, extra: "PRIVATE_CURRENT" } as WorkerWriteJournalRuntimeObservation;
	const invalid = observeWorkerWriteJournalRuntimeEntry(telemetryEntry(telemetry()), hostileCurrent);
	assert.deepEqual(invalid, { state: "failed", tool: "none", outcome: "none", code: "invalid", revision: 0 });
	assert.equal(JSON.stringify(invalid).includes("PRIVATE"), false);
});

test("real edit/write operations capture exact identities, revisions, outcomes, telemetry, and deterministic ids", async () => {
	const fx = await fixture();
	try {
		await writeFile(join(fx.root, "tracked.txt"), "before", "utf8");
		const editInput = { toolCallId: "call-edit-1", toolName: "edit", path: "tracked.txt" };
		const editSnapshot = structuredClone(editInput);
		const begun = await fx.runtime.beginToolCall(editInput);
		assert.deepEqual(editInput, editSnapshot, "caller input is not mutated");
		assert.equal(begun.ok, true);
		assert.equal(begun.ok && begun.action, "begun");
		assert.equal(begun.ok && begun.action === "begun" && begun.revision, 1);
		await writeFile(join(fx.root, "tracked.txt"), "after", "utf8");
		const completed = await fx.runtime.completeToolResult({ toolCallId: "call-edit-1", toolName: "edit", isError: false });
		assert.equal(completed.ok, true);
		assert.equal(completed.ok && completed.action, "completed");
		assert.equal(completed.ok && completed.action === "completed" && completed.revision, 2);

		const writeBegun = await fx.runtime.beginToolCall({ toolCallId: "call-write-2", toolName: "write", path: "new.txt" });
		assert.equal(writeBegun.ok, true);
		assert.equal(writeBegun.ok && writeBegun.action === "begun" && writeBegun.revision, 3);
		await writeFile(join(fx.root, "new.txt"), "tool changed it but reported failure", "utf8");
		const writeCompleted = await fx.runtime.completeToolResult({ toolCallId: "call-write-2", toolName: "write", isError: true });
		assert.equal(writeCompleted.ok, true);
		assert.equal(writeCompleted.ok && writeCompleted.action === "completed" && writeCompleted.revision, 4);

		const record = await journal(fx);
		assert.equal(record.revision, 4);
		assert.deepEqual(record.operations.map((operation) => ({
			kind: operation.kind,
			path: operation.path,
			status: operation.status,
			outcome: operation.status === "completed" ? operation.outcome : undefined,
		})), [
			{ kind: "edit", path: "tracked.txt", status: "completed", outcome: "succeeded" },
			{ kind: "write", path: "new.txt", status: "completed", outcome: "failed" },
		]);

		const projection = JSON.stringify({
			schema: WORKER_WRITE_JOURNAL_RUNTIME_OPERATION_SCHEMA,
			delegation_id: DELEGATION_ID,
			contract_hash: CONTRACT_HASH,
			tool_call_id: "call-edit-1",
			tool: "edit",
			path: "tracked.txt",
		});
		const expectedId = createHash("sha256").update(projection, "utf8").digest("hex");
		assert.equal(record.operations[0]?.operation_id, expectedId);
		assert.equal(begun.ok && begun.action === "begun" && begun.operation_id, expectedId);
		assert.equal(deriveWorkerWriteJournalOperationId({
			delegation_id: DELEGATION_ID,
			contract_hash: CONTRACT_HASH,
			tool_call_id: "call-edit-1",
			tool: "edit",
			path: "tracked.txt",
		}), expectedId);
		assert.deepEqual(fx.telemetry, [
			{ schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA, phase: "begin", tool: "edit", outcome: "none", code: "none", revision: 1, poisoned: 0 },
			{ schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA, phase: "complete", tool: "edit", outcome: "succeeded", code: "none", revision: 2, poisoned: 0 },
			{ schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA, phase: "begin", tool: "write", outcome: "none", code: "none", revision: 3, poisoned: 0 },
			{ schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA, phase: "complete", tool: "write", outcome: "failed", code: "none", revision: 4, poisoned: 0 },
		]);
		fx.telemetry.forEach(assertClosedTelemetry);
		assert.deepEqual(fx.runtime.inspectState(), { applicability: "active", poisoned: 0, pending: 0, revision: 4 });
	} finally {
		await cleanup(fx);
	}
});

test("noncanonical approved paths normalize once to strict project-relative journal paths", async () => {
	const fx = await fixture();
	try {
		await writeFile(join(fx.root, "target.txt"), "before", "utf8");
		assert.equal(normalizeWorkerWriteJournalPath("dir/../target.txt"), "target.txt");
		assert.equal(normalizeWorkerWriteJournalPath("./target.txt"), "target.txt");
		assert.equal(normalizeWorkerWriteJournalPath("../escape"), undefined);
		assert.equal(normalizeWorkerWriteJournalPath("dir\\target.txt"), undefined);
		const begun = await fx.runtime.beginToolCall({ toolCallId: "canonical-call", toolName: "edit", path: "dir/../target.txt" });
		assert.equal(begun.ok, true);
		await writeFile(join(fx.root, "target.txt"), "after", "utf8");
		assert.equal((await fx.runtime.completeToolResult({ toolCallId: "canonical-call", toolName: "edit", isError: false })).ok, true);
		assert.equal((await journal(fx)).operations[0]?.path, "target.txt");
	} finally {
		await cleanup(fx);
	}
});

test("non-worker and diagnosis contexts are not applicable and never access a journal", async () => {
	for (const context of [
		{ role: undefined, task_kind: "implementation", project_root: "not-absolute", delegation_id: "bad", contract_hash: "BAD" },
		{ role: "commander", task_kind: "implementation", project_root: null, delegation_id: null, contract_hash: null },
		{ role: "worker", task_kind: "diagnosis", project_root: null, delegation_id: null, contract_hash: null },
	] as WorkerWriteJournalRuntimeContext[]) {
		let appendCount = 0;
		const runtime = createWorkerWriteJournalRuntime(context, { appendTelemetry: () => { appendCount += 1; } });
		assert.deepEqual(await runtime.beginToolCall({ toolCallId: "x", toolName: "edit", path: "secret.txt" }), {
			ok: true,
			action: "not_applicable",
		});
		assert.equal(appendCount, 0);
		assert.equal(runtime.inspectState().applicability, "not_applicable");
	}
});

test("worker implementation missing or malformed runtime identity fails closed without leaking values", async () => {
	const secret = "PRIVATE_CONTEXT_VALUE";
	for (const context of [
		{ role: "worker", task_kind: "implementation", project_root: "relative", delegation_id: DELEGATION_ID, contract_hash: CONTRACT_HASH },
		{ role: "worker", task_kind: "implementation", project_root: tmpdir(), delegation_id: "bad", contract_hash: CONTRACT_HASH },
		{ role: "worker", task_kind: "implementation", project_root: tmpdir(), delegation_id: DELEGATION_ID, contract_hash: `${secret}${"A".repeat(64)}` },
		{ role: "worker", task_kind: "invalid", project_root: tmpdir(), delegation_id: DELEGATION_ID, contract_hash: CONTRACT_HASH },
	] as WorkerWriteJournalRuntimeContext[]) {
		const observed: WorkerWriteJournalRuntimeTelemetry[] = [];
		const runtime = createWorkerWriteJournalRuntime(context, { appendTelemetry: (value) => observed.push(structuredClone(value)) });
		const result = await runtime.beginToolCall({ toolCallId: "identity-call", toolName: "write", path: `${secret}/file` });
		assert.deepEqual(result, { ok: false, code: "invalid_context", reason: WORKER_WRITE_JOURNAL_RUNTIME_BLOCK_REASON });
		assert.equal(JSON.stringify({ result, observed }).includes(secret), false);
		assert.deepEqual(runtime.inspectState(), { applicability: "invalid_context", poisoned: 1, pending: 0, revision: 0 });
	}
});

test("invalid call ids and invalid paths poison the runtime before journal access", async () => {
	for (const invalid of [
		{ input: { toolCallId: "", toolName: "edit", path: "a.txt" }, code: "invalid_call_id" },
		{ input: { toolCallId: " padded ", toolName: "edit", path: "a.txt" }, code: "invalid_call_id" },
		{ input: { toolCallId: "x".repeat(257), toolName: "write", path: "a.txt" }, code: "invalid_call_id" },
		{ input: { toolCallId: "bad\ncall", toolName: "edit", path: "a.txt" }, code: "invalid_call_id" },
		{ input: { toolCallId: "valid", toolName: "write", path: "../PRIVATE_PATH" }, code: "invalid_path" },
	] as const) {
		const fx = await fixture();
		try {
			const result = await fx.runtime.beginToolCall(invalid.input);
			assert.equal(result.ok, false);
			assert.equal(!result.ok && result.code, invalid.code);
			assert.equal((await journal(fx)).revision, 0);
			assert.equal(JSON.stringify({ result, telemetry: fx.telemetry }).includes("PRIVATE_PATH"), false);
			assert.equal((await fx.runtime.beginToolCall({ toolCallId: "future", toolName: "write", path: "future.txt" })).ok, false);
		} finally {
			await cleanup(fx);
		}
	}
});

test("missing, corrupt, thrown-storage, and identity failures poison with bounded telemetry", async () => {
	const missing = await fixture({ create: false });
	try {
		const result = await missing.runtime.beginToolCall({ toolCallId: "missing", toolName: "write", path: "a.txt" });
		assert.equal(!result.ok && result.code, "journal_read_failed");
	} finally {
		await cleanup(missing);
	}

	const corrupt = await fixture();
	try {
		const relative = workerWriteJournalRelativePath(DELEGATION_ID);
		assert.ok(relative);
		await writeFile(join(corrupt.root, relative), "{PRIVATE_CORRUPT_STORAGE_DETAIL", "utf8");
		const result = await corrupt.runtime.beginToolCall({ toolCallId: "corrupt", toolName: "edit", path: "a.txt" });
		assert.equal(!result.ok && result.code, "journal_read_failed");
		assert.equal(JSON.stringify({ result, telemetry: corrupt.telemetry }).includes("PRIVATE"), false);
	} finally {
		await cleanup(corrupt);
	}

	const root = await mkdtemp(join(tmpdir(), "worker-write-journal-runtime-storage-"));
	try {
		const telemetry: WorkerWriteJournalRuntimeTelemetry[] = [];
		const runtime = createWorkerWriteJournalRuntime({
			role: "worker", task_kind: "implementation", project_root: root,
			delegation_id: DELEGATION_ID, contract_hash: CONTRACT_HASH,
		}, {
			appendTelemetry: (value) => telemetry.push(structuredClone(value)),
			readJournal: async () => { throw new Error("PRIVATE_STORAGE_ERROR"); },
		});
		const result = await runtime.beginToolCall({ toolCallId: "storage", toolName: "edit", path: "a.txt" });
		assert.equal(!result.ok && result.code, "journal_read_failed");
		assert.equal(JSON.stringify({ result, telemetry }).includes("PRIVATE"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}

	const identity = await fixture({ limits: { max_file_bytes: 1 } });
	try {
		await writeFile(join(identity.root, "large.txt"), "too large", "utf8");
		const result = await identity.runtime.beginToolCall({ toolCallId: "identity", toolName: "edit", path: "large.txt" });
		assert.equal(!result.ok && result.code, "journal_begin_failed");
		assert.equal(identity.telemetry.at(-1)?.revision, 0, "runtime telemetry retains only the last successful revision");
		assert.equal((await journal(identity)).revision, 1);
	} finally {
		await cleanup(identity);
	}
});

test("parallel writes serialize without poisoning; true mismatches and unbegun results still poison", async () => {
	const pending = await fixture();
	try {
		await writeFile(join(pending.root, "a.txt"), "a", "utf8");
		await writeFile(join(pending.root, "b.txt"), "b", "utf8");
		assert.equal((await pending.runtime.beginToolCall({ toolCallId: "first", toolName: "edit", path: "a.txt" })).ok, true);
		const conflict = await pending.runtime.beginToolCall({ toolCallId: "second", toolName: "write", path: "b.txt" });
		assert.equal(!conflict.ok && conflict.code, "pending_conflict");
		assert.equal(!conflict.ok && conflict.reason, WORKER_WRITE_JOURNAL_RUNTIME_SERIALIZE_REASON);
		assert.deepEqual(pending.runtime.inspectState(), { applicability: "active", poisoned: 0, pending: 1, revision: 1 });
		assert.equal((await pending.runtime.completeToolResult({
			toolCallId: "second", toolName: "write", isError: true,
		})).ok, true, "the blocked parallel result is consumed without touching the journal");
		await writeFile(join(pending.root, "a.txt"), "aa", "utf8");
		assert.equal((await pending.runtime.completeToolResult({
			toolCallId: "first", toolName: "edit", isError: false,
		})).ok, true);
		assert.equal((await pending.runtime.beginToolCall({
			toolCallId: "second-retry", toolName: "write", path: "b.txt",
		})).ok, true);
		await writeFile(join(pending.root, "b.txt"), "bb", "utf8");
		assert.equal((await pending.runtime.completeToolResult({
			toolCallId: "second-retry", toolName: "write", isError: false,
		})).ok, true);
		assert.deepEqual(pending.runtime.inspectState(), { applicability: "active", poisoned: 0, pending: 0, revision: 4 });
		assert.deepEqual((await journal(pending)).operations.map((operation) => [operation.path, operation.status]), [
			["a.txt", "completed"],
			["b.txt", "completed"],
		]);
		assert.equal(pending.telemetry.some((entry) => entry.code === "pending_conflict"), false);
	} finally {
		await cleanup(pending);
	}

	const mismatch = await fixture();
	try {
		await writeFile(join(mismatch.root, "a.txt"), "a", "utf8");
		await mismatch.runtime.beginToolCall({ toolCallId: "first", toolName: "edit", path: "a.txt" });
		const result = await mismatch.runtime.completeToolResult({ toolCallId: "wrong", toolName: "edit", isError: false });
		assert.equal(!result.ok && result.code, "result_mismatch");
	} finally {
		await cleanup(mismatch);
	}

	const unbegun = await fixture();
	try {
		const result = await unbegun.runtime.completeToolResult({ toolCallId: "none", toolName: "write", isError: false });
		assert.equal(!result.ok && result.code, "unbegun_result");
		assert.equal((await unbegun.runtime.beginToolCall({ toolCallId: "future", toolName: "write", path: "future.txt" })).ok, false);
	} finally {
		await cleanup(unbegun);
	}
});

test("synchronous telemetry callback failure makes begin or complete fail closed and permanently poisons", async () => {
	const beginFailure = await fixture({ appendTelemetry: () => { throw new Error("PRIVATE_TELEMETRY"); } });
	try {
		await writeFile(join(beginFailure.root, "a.txt"), "a", "utf8");
		const result = await beginFailure.runtime.beginToolCall({ toolCallId: "begin-telemetry", toolName: "edit", path: "a.txt" });
		assert.equal(!result.ok && result.code, "telemetry_failed");
		assert.deepEqual(beginFailure.runtime.inspectState(), { applicability: "active", poisoned: 1, pending: 1, revision: 1 });
		assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
	} finally {
		await cleanup(beginFailure);
	}

	let calls = 0;
	const completeFailure = await fixture({ appendTelemetry: () => {
		calls += 1;
		if (calls === 2) throw new Error("PRIVATE_COMPLETE_TELEMETRY");
	} });
	try {
		await writeFile(join(completeFailure.root, "a.txt"), "a", "utf8");
		assert.equal((await completeFailure.runtime.beginToolCall({ toolCallId: "complete-telemetry", toolName: "edit", path: "a.txt" })).ok, true);
		await writeFile(join(completeFailure.root, "a.txt"), "b", "utf8");
		const result = await completeFailure.runtime.completeToolResult({ toolCallId: "complete-telemetry", toolName: "edit", isError: false });
		assert.equal(!result.ok && result.code, "telemetry_failed");
		assert.deepEqual(completeFailure.runtime.inspectState(), { applicability: "active", poisoned: 1, pending: 0, revision: 2 });
		assert.equal((await journal(completeFailure)).operations[0]?.status, "completed");
		assert.equal((await completeFailure.runtime.beginToolCall({ toolCallId: "future", toolName: "write", path: "future.txt" })).ok, false);
	} finally {
		await cleanup(completeFailure);
	}
});

test("non-edit/write events are inert even while an exact edit is pending", async () => {
	const fx = await fixture();
	try {
		await writeFile(join(fx.root, "a.txt"), "a", "utf8");
		assert.deepEqual(await fx.runtime.beginToolCall({ toolCallId: "read-call", toolName: "read", path: "a.txt" }), {
			ok: true,
			action: "not_applicable",
		});
		assert.equal((await fx.runtime.beginToolCall({ toolCallId: "edit-call", toolName: "edit", path: "a.txt" })).ok, true);
		assert.deepEqual(await fx.runtime.completeToolResult({ toolCallId: "read-call", toolName: "read", isError: false }), {
			ok: true,
			action: "not_applicable",
		});
		await writeFile(join(fx.root, "a.txt"), "b", "utf8");
		assert.equal((await fx.runtime.completeToolResult({ toolCallId: "edit-call", toolName: "edit", isError: false })).ok, true);
	} finally {
		await cleanup(fx);
	}
});

test("operation-id derivation rejects non-exact inputs and never exposes caller material", async () => {
	const valid = {
		delegation_id: DELEGATION_ID,
		contract_hash: CONTRACT_HASH,
		tool_call_id: "call",
		tool: "write",
		path: "safe.txt",
	};
	assert.match(deriveWorkerWriteJournalOperationId(valid) ?? "", /^[a-f0-9]{64}$/);
	assert.equal(deriveWorkerWriteJournalOperationId({ ...valid, extra: "PRIVATE" } as typeof valid), undefined);
	assert.equal(deriveWorkerWriteJournalOperationId({ ...valid, contract_hash: "A".repeat(64) }), undefined);
	assert.equal(deriveWorkerWriteJournalOperationId({ ...valid, path: "a/../safe.txt" }), undefined);
	const accessor = Object.defineProperty({ ...valid }, "tool_call_id", { enumerable: true, get: () => "PRIVATE" });
	assert.equal(deriveWorkerWriteJournalOperationId(accessor), undefined);
});
