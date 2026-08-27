import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import {
	WORKER_CONTRACT_HASH_ENV,
	WORKER_DELEGATION_ID_ENV,
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_ROLE_ENV,
	WORKER_TASK_KIND_ENV,
} from "../extensions/workbench-runtime/core/worker-policy.ts";
import {
	WORKER_WRITE_JOURNAL_RUNTIME_RESULT_ERROR_TEXT,
	WORKER_WRITE_JOURNAL_RUNTIME_SERIALIZE_REASON,
	WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_ENTRY_TYPE,
	type WorkerWriteJournalRuntimeTelemetry,
} from "../extensions/workbench-runtime/core/worker-write-journal-runtime.ts";
import {
	createWorkerWriteJournal,
	readWorkerWriteJournal,
	workerWriteJournalRelativePath,
} from "../extensions/workbench-runtime/core/write-journal.ts";
import {
	WORKBENCH_CHECKOUT_OPERATION_TOKEN_ENV,
	acquireProjectCheckoutOperationV1,
	releaseProjectCheckoutOperationV1,
} from "../extensions/workbench-runtime/core/project-checkout-operation.ts";
import { spawnExec } from "./helpers.ts";

const DELEGATION_ID = "20260820-130000-W1r2";
const CONTRACT_HASH = "b".repeat(64);
const WORKBENCH_SOURCE_PATH = join(process.cwd(), "extensions/workbench-runtime/index.ts");

interface StubAPI {
	commands: Map<string, unknown>;
	tools: Map<string, unknown>;
	toolSources: Map<string, Record<string, unknown>>;
	events: Map<string, Array<(event: any, ctx: any) => unknown>>;
	activeTools: string[];
	appendedEntries: Array<{ customType: string; data: unknown }>;
}

function workbenchSourceInfo(): Record<string, unknown> {
	return {
		path: WORKBENCH_SOURCE_PATH,
		source: "local",
		scope: "temporary",
		origin: "top-level",
		baseDir: join(process.cwd(), "extensions/workbench-runtime"),
	};
}

function builtinSourceInfo(name: string): Record<string, unknown> {
	return { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level", baseDir: undefined };
}

function makeStub(): StubAPI & ExtensionAPI {
	const stub = {
		commands: new Map<string, unknown>(),
		tools: new Map<string, unknown>(),
		toolSources: new Map<string, Record<string, unknown>>(),
		events: new Map<string, Array<(event: any, ctx: any) => unknown>>(),
		activeTools: ["edit", "write"],
		appendedEntries: [] as Array<{ customType: string; data: unknown }>,
		registerCommand: (name: string, definition: unknown) => { stub.commands.set(name, definition); },
		registerTool: (definition: { name: string }) => {
			stub.tools.set(definition.name, definition);
			stub.toolSources.set(definition.name, workbenchSourceInfo());
		},
		on: (event: string, handler: (event: any, ctx: any) => unknown) => {
			const handlers = stub.events.get(event) ?? [];
			handlers.push(handler);
			stub.events.set(event, handlers);
		},
		appendEntry: (customType: string, data?: unknown) => { stub.appendedEntries.push({ customType, data }); },
		sendMessage: () => {},
		sendUserMessage: () => {},
		setActiveTools: (tools: string[]) => { stub.activeTools = [...tools]; },
		getActiveTools: () => [...stub.activeTools],
		getAllTools: () => [...stub.tools.entries()].map(([name, definition]) => ({
			...(definition as Record<string, unknown>),
			sourceInfo: stub.toolSources.get(name),
		})),
		getThinkingLevel: () => "high",
		exec: spawnExec,
	} as unknown as StubAPI & ExtensionAPI;
	for (const name of ["edit", "write"]) {
		stub.tools.set(name, { name, description: `${name} fixture`, parameters: {} });
		stub.toolSources.set(name, builtinSourceInfo(name));
	}
	return stub;
}

function trustedContext(root: string): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => join(root, "session.jsonl"),
			getSessionId: () => "worker-write-journal-wiring-session",
		},
		model: undefined,
		thinkingLevel: undefined,
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, confirm: async () => false },
		signal: undefined,
	} as unknown as ExtensionContext;
}

interface ResultEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: Array<Record<string, unknown>>;
	isError: boolean;
	details?: unknown;
}

async function emitToolCall(
	stub: StubAPI,
	ctx: ExtensionContext,
	event: { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> },
): Promise<{ block?: boolean; reason?: string }> {
	let result: { block?: boolean; reason?: string } = {};
	for (const handler of stub.events.get("tool_call") ?? []) {
		const patch = await handler(event, ctx) as typeof result | undefined;
		if (patch !== undefined) result = patch;
		if (result.block) break;
	}
	return result;
}

async function emitToolResult(stub: StubAPI, initial: ResultEvent): Promise<ResultEvent> {
	const current: ResultEvent = { ...initial, content: [...initial.content] };
	for (const handler of stub.events.get("tool_result") ?? []) {
		const patch = await handler(current, undefined) as Partial<ResultEvent> | undefined;
		if (!patch) continue;
		if (patch.content !== undefined) current.content = patch.content;
		if (patch.isError !== undefined) current.isError = patch.isError;
		if (patch.details !== undefined) current.details = patch.details;
	}
	return current;
}

const ENV_NAMES = [
	WORKER_ROLE_ENV,
	WORKER_TASK_KIND_ENV,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_DELEGATION_ID_ENV,
	WORKER_CONTRACT_HASH_ENV,
	WORKBENCH_CHECKOUT_OPERATION_TOKEN_ENV,
] as const;

async function instantiateRuntime(root: string, options?: {
	role?: "worker" | "other";
	allowedPaths?: readonly string[];
	omitDelegation?: boolean;
}): Promise<{ stub: StubAPI & ExtensionAPI; cleanup: () => Promise<void> }> {
	const previous = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
	let parentOperation: Awaited<ReturnType<typeof acquireProjectCheckoutOperationV1>> | undefined;
	try {
		const workerRole = (options?.role ?? "worker") === "worker";
		if (workerRole) process.env[WORKER_ROLE_ENV] = "worker";
		else delete process.env[WORKER_ROLE_ENV];
		process.env[WORKER_TASK_KIND_ENV] = "implementation";
		process.env[WORKER_PROJECT_ROOT_ENV] = root;
		process.env[WORKER_ALLOWED_PATHS_ENV] = JSON.stringify(options?.allowedPaths ?? ["tracked.txt", "new.txt"]);
		if (!workerRole || options?.omitDelegation) {
			delete process.env[WORKER_DELEGATION_ID_ENV];
			delete process.env[WORKER_CONTRACT_HASH_ENV];
			delete process.env[WORKBENCH_CHECKOUT_OPERATION_TOKEN_ENV];
		} else {
			process.env[WORKER_DELEGATION_ID_ENV] = DELEGATION_ID;
			process.env[WORKER_CONTRACT_HASH_ENV] = CONTRACT_HASH;
			parentOperation = await acquireProjectCheckoutOperationV1({
				project_root: root,
				operation_kind: "delegation",
				operation_id: `delegation:${DELEGATION_ID}`,
				delegation_id: DELEGATION_ID,
				now: new Date().toISOString(),
			});
			if (!parentOperation.ok) throw new Error(`worker fixture checkout authority unavailable: ${parentOperation.error.code}`);
			process.env[WORKBENCH_CHECKOUT_OPERATION_TOKEN_ENV] = parentOperation.value.token;
		}
		const stub = makeStub();
		workbenchRuntime(stub);
		return {
			stub,
			cleanup: async () => {
				if (parentOperation?.ok) await releaseProjectCheckoutOperationV1(parentOperation.value);
				for (const name of ENV_NAMES) {
					const value = previous.get(name);
					if (value === undefined) delete process.env[name];
					else process.env[name] = value;
				}
			},
		};
	} catch (error) {
		if (parentOperation?.ok) await releaseProjectCheckoutOperationV1(parentOperation.value);
		for (const name of ENV_NAMES) {
			const value = previous.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		throw error;
	}
}

async function createJournal(root: string): Promise<void> {
	const result = await createWorkerWriteJournal({
		project_root: root,
		delegation_id: DELEGATION_ID,
		contract_hash: CONTRACT_HASH,
	});
	assert.equal(result.ok, true);
}

async function readJournal(root: string) {
	const result = await readWorkerWriteJournal({
		project_root: root,
		delegation_id: DELEGATION_ID,
		contract_hash: CONTRACT_HASH,
	});
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("journal read failed");
	return result.value;
}

function journalTelemetry(stub: StubAPI): WorkerWriteJournalRuntimeTelemetry[] {
	return stub.appendedEntries
		.filter((entry) => entry.customType === WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_ENTRY_TYPE)
		.map((entry) => entry.data as WorkerWriteJournalRuntimeTelemetry);
}

function textOf(content: Array<Record<string, unknown>>): string {
	return content.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
}

test("allowed worker edit/write calls begin before mutation and complete from original outcomes", async () => {
	const root = await mkdtemp(join(tmpdir(), "worker-write-journal-wiring-positive-"));
	let runtime: Awaited<ReturnType<typeof instantiateRuntime>> | undefined;
	try {
		await createJournal(root);
		await writeFile(join(root, "tracked.txt"), "before", "utf8");
		runtime = await instantiateRuntime(root);
		const stub = runtime.stub;
		const ctx = trustedContext(root);

		const editGuard = await emitToolCall(stub, ctx, {
			type: "tool_call", toolCallId: "wire-edit", toolName: "edit", input: { path: "tracked.txt", oldText: "before", newText: "after" },
		});
		assert.equal(editGuard.block, undefined);
		assert.equal((await readJournal(root)).operations[0]?.status, "pending", "journal begin precedes filesystem mutation");
		await writeFile(join(root, "tracked.txt"), "after", "utf8");
		const editResult = await emitToolResult(stub, {
			type: "tool_result", toolCallId: "wire-edit", toolName: "edit", input: { path: "tracked.txt" },
			content: [{ type: "text", text: "edited" }], isError: false,
		});
		assert.equal(editResult.isError, false);

		const writeGuard = await emitToolCall(stub, ctx, {
			type: "tool_call", toolCallId: "wire-write", toolName: "write", input: { path: "new.txt", content: "new" },
		});
		assert.equal(writeGuard.block, undefined);
		await writeFile(join(root, "new.txt"), "new despite tool failure", "utf8");
		const writeResult = await emitToolResult(stub, {
			type: "tool_result", toolCallId: "wire-write", toolName: "write", input: { path: "new.txt" },
			content: [{ type: "text", text: "failed" }], isError: true,
		});
		assert.equal(writeResult.isError, true);

		const record = await readJournal(root);
		assert.equal(record.revision, 4);
		assert.deepEqual(record.operations.map((operation) => operation.status === "completed"
			? [operation.kind, operation.path, operation.outcome]
			: [operation.kind, operation.path, operation.status]), [
			["edit", "tracked.txt", "succeeded"],
			["write", "new.txt", "failed"],
		]);
		assert.deepEqual(journalTelemetry(stub).map((entry) => [entry.phase, entry.tool, entry.outcome, entry.revision]), [
			["begin", "edit", "none", 1],
			["complete", "edit", "succeeded", 2],
			["begin", "write", "none", 3],
			["complete", "write", "failed", 4],
		]);
	} finally {
		await runtime?.cleanup();
		await rm(root, { recursive: true, force: true });
	}
});

test("parallel write calls block only the later call and allow a sequential retry", async () => {
	const root = await mkdtemp(join(tmpdir(), "worker-write-journal-wiring-parallel-"));
	let runtime: Awaited<ReturnType<typeof instantiateRuntime>> | undefined;
	try {
		await createJournal(root);
		await writeFile(join(root, "alpha.txt"), "alpha=before\n", "utf8");
		await writeFile(join(root, "beta.txt"), "beta=before\n", "utf8");
		runtime = await instantiateRuntime(root, { allowedPaths: ["alpha.txt", "beta.txt"] });
		const stub = runtime.stub;
		const ctx = trustedContext(root);

		assert.equal((await emitToolCall(stub, ctx, {
			type: "tool_call", toolCallId: "parallel-alpha", toolName: "edit", input: { path: "alpha.txt" },
		})).block, undefined);
		const blocked = await emitToolCall(stub, ctx, {
			type: "tool_call", toolCallId: "parallel-beta", toolName: "edit", input: { path: "beta.txt" },
		});
		assert.deepEqual(blocked, { block: true, reason: WORKER_WRITE_JOURNAL_RUNTIME_SERIALIZE_REASON });
		await emitToolResult(stub, {
			type: "tool_result", toolCallId: "parallel-beta", toolName: "edit", input: { path: "beta.txt" },
			content: [{ type: "text", text: WORKER_WRITE_JOURNAL_RUNTIME_SERIALIZE_REASON }], isError: true,
		});
		await writeFile(join(root, "alpha.txt"), "alpha=after\n", "utf8");
		await emitToolResult(stub, {
			type: "tool_result", toolCallId: "parallel-alpha", toolName: "edit", input: { path: "alpha.txt" },
			content: [{ type: "text", text: "edited" }], isError: false,
		});

		assert.equal((await emitToolCall(stub, ctx, {
			type: "tool_call", toolCallId: "retry-beta", toolName: "edit", input: { path: "beta.txt" },
		})).block, undefined);
		await writeFile(join(root, "beta.txt"), "beta=after\n", "utf8");
		await emitToolResult(stub, {
			type: "tool_result", toolCallId: "retry-beta", toolName: "edit", input: { path: "beta.txt" },
			content: [{ type: "text", text: "edited" }], isError: false,
		});

		const record = await readJournal(root);
		assert.deepEqual(record.operations.map((operation) => [operation.path, operation.status]), [
			["alpha.txt", "completed"],
			["beta.txt", "completed"],
		]);
		assert.deepEqual(journalTelemetry(stub).map((entry) => [entry.phase, entry.revision]), [
			["begin", 1], ["complete", 2], ["begin", 3], ["complete", 4],
		]);
	} finally {
		await runtime?.cleanup();
		await rm(root, { recursive: true, force: true });
	}
});

test("existing worker guards deny before journaling and missing v2 identity blocks before execution", async () => {
	const root = await mkdtemp(join(tmpdir(), "worker-write-journal-wiring-guards-"));
	let deniedRuntime: Awaited<ReturnType<typeof instantiateRuntime>> | undefined;
	let missingRuntime: Awaited<ReturnType<typeof instantiateRuntime>> | undefined;
	try {
		await createJournal(root);
		await writeFile(join(root, "tracked.txt"), "before", "utf8");
		await writeFile(join(root, "outside.txt"), "outside", "utf8");
		deniedRuntime = await instantiateRuntime(root, { allowedPaths: ["tracked.txt"] });
		const denied = deniedRuntime.stub;
		const ctx = trustedContext(root);
		const deniedGuard = await emitToolCall(denied, ctx, {
			type: "tool_call", toolCallId: "wire-denied", toolName: "edit", input: { path: "outside.txt" },
		});
		assert.equal(deniedGuard.block, true);
		assert.equal((await readJournal(root)).revision, 0);
		assert.deepEqual(journalTelemetry(denied), []);

		await deniedRuntime.cleanup();
		deniedRuntime = undefined;
		missingRuntime = await instantiateRuntime(root, { allowedPaths: ["tracked.txt"], omitDelegation: true });
		const missingIdentity = missingRuntime.stub;
		const missingGuard = await emitToolCall(missingIdentity, ctx, {
			type: "tool_call", toolCallId: "wire-missing-id", toolName: "edit", input: { path: "tracked.txt" },
		});
		assert.deepEqual(missingGuard, { block: true, reason: "Delegated worker checkout mutation requires the exact inherited parent operation token" });
		assert.equal((await readJournal(root)).revision, 0, "missing identity cannot reach journal begin or tool execution");
		assert.deepEqual(journalTelemetry(missingIdentity), []);
	} finally {
		await missingRuntime?.cleanup();
		await deniedRuntime?.cleanup();
		await rm(root, { recursive: true, force: true });
	}
});

test("completion failure becomes one bounded error on the same event and poisons future writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "worker-write-journal-wiring-complete-fail-"));
	let runtime: Awaited<ReturnType<typeof instantiateRuntime>> | undefined;
	try {
		await createJournal(root);
		await writeFile(join(root, "tracked.txt"), "before", "utf8");
		runtime = await instantiateRuntime(root, { allowedPaths: ["tracked.txt", "new.txt"] });
		const stub = runtime.stub;
		const ctx = trustedContext(root);
		assert.equal((await emitToolCall(stub, ctx, {
			type: "tool_call", toolCallId: "wire-complete-fail", toolName: "edit", input: { path: "tracked.txt" },
		})).block, undefined);
		await writeFile(join(root, "tracked.txt"), "after", "utf8");
		const relative = workerWriteJournalRelativePath(DELEGATION_ID);
		assert.ok(relative);
		await writeFile(join(root, relative), "{corrupt-before-complete", "utf8");

		let laterSeen: ResultEvent | undefined;
		stub.events.get("tool_result")!.push((event: ResultEvent) => {
			laterSeen = event;
			return { details: { later_middleware: true } };
		});
		const result = await emitToolResult(stub, {
			type: "tool_result", toolCallId: "wire-complete-fail", toolName: "edit", input: { path: "tracked.txt" },
			content: [{ type: "text", text: "PRIVATE_RAW_TOOL_OUTPUT" }], isError: false,
		});
		assert.equal(laterSeen, result, "later middleware receives the same mutable Pi event object");
		assert.equal(result.isError, true);
		assert.equal(textOf(result.content), WORKER_WRITE_JOURNAL_RUNTIME_RESULT_ERROR_TEXT);
		assert.ok(Buffer.byteLength(textOf(result.content), "utf8") < 256);
		assert.equal(textOf(result.content).includes("PRIVATE_RAW_TOOL_OUTPUT"), false);
		assert.deepEqual(result.details, { later_middleware: true });
		assert.equal(journalTelemetry(stub).at(-1)?.code, "journal_complete_failed");

		const future = await emitToolCall(stub, ctx, {
			type: "tool_call", toolCallId: "wire-future", toolName: "write", input: { path: "new.txt", content: "must not run" },
		});
		assert.deepEqual(future, { block: true, reason: "Worker write journal unavailable" });
	} finally {
		await runtime?.cleanup();
		await rm(root, { recursive: true, force: true });
	}
});

test("non-worker edit/write calls and results remain behaviorally unaffected", async () => {
	const root = await mkdtemp(join(tmpdir(), "worker-write-journal-wiring-nonworker-"));
	let runtime: Awaited<ReturnType<typeof instantiateRuntime>> | undefined;
	try {
		await writeFile(join(root, "tracked.txt"), "before", "utf8");
		runtime = await instantiateRuntime(root, { role: "other", allowedPaths: [] });
		const stub = runtime.stub;
		const ctx = trustedContext(root);
		const guard = await emitToolCall(stub, ctx, {
			type: "tool_call", toolCallId: "wire-nonworker", toolName: "edit", input: { path: "tracked.txt" },
		});
		assert.equal(guard.block, undefined);
		const result = await emitToolResult(stub, {
			type: "tool_result", toolCallId: "wire-nonworker", toolName: "edit", input: { path: "tracked.txt" },
			content: [{ type: "text", text: "ordinary result" }], isError: false,
		});
		assert.equal(result.isError, false);
		assert.equal(textOf(result.content), "ordinary result");
		assert.deepEqual(journalTelemetry(stub), []);
	} finally {
		await runtime?.cleanup();
		await rm(root, { recursive: true, force: true });
	}
});

test("source order pins journal completion before envelope and begin after every existing policy guard", async () => {
	const source = await readFile(WORKBENCH_SOURCE_PATH, "utf8");
	const resultSection = await readFile(
		join(process.cwd(), "extensions/workbench-runtime/core/tool-result-middleware-controller.ts"),
		"utf8",
	);
	assert.ok(resultSection.indexOf("workerWriteJournalRuntime.completeToolResult(") >= 0);
	assert.ok(resultSection.indexOf("workerWriteJournalRuntime.completeToolResult(") < resultSection.indexOf("const originalContent = event.content"));

	const guard = await readFile(
		join(process.cwd(), "extensions/workbench-runtime/core/tool-call-guard-controller.ts"),
		"utf8",
	);
	const markers = [
		"controller.toolCallBlockReason(",
		"workerRoleToolCallBlockReason(",
		"isWorkerPathAllowedRealpath(",
		"checkToolCall(mode",
		"commanderToolCallBlockReason({",
		"controller.authorizeOutput(event.toolCallId",
		"controller.workerWriteJournalRuntime.beginToolCall({",
		"controller.beginToolReceipt ?? beginReceipt",
		"consumeLeaseCall(",
	];
	const positions = markers.map((marker) => guard.indexOf(marker));
	assert.ok(positions.every((position) => position >= 0), JSON.stringify(positions));
	assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});
