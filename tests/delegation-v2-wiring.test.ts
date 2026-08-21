/** S1.1 public workbench_delegate_worker wiring through delegation-v2. */

import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import {
	persistAbortedDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRecoveryRequiredDelegationTransaction,
	persistRunningDelegationTransaction,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import type { DelegationTransactionRecord } from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import {
	DELEGATION_STATE_ENTRY_TYPE,
	type DelegationStateRecord,
} from "../extensions/workbench-runtime/core/delegation-state.ts";
import {
	COMPACT_STATE_ENTRY_TYPE,
	type CompactState,
} from "../extensions/workbench-runtime/core/compact.ts";
import {
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_MODEL_ID,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_PROVIDER,
	WORKER_ROLE_ENV,
	WORKER_TASK_KIND_ENV,
} from "../extensions/workbench-runtime/core/worker-policy.ts";
import { WORKER_SPEND_PROFILE_ENV } from "../extensions/workbench-runtime/core/worker-spend.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

interface StubAPI {
	tools: Map<string, unknown>;
	events: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	appendedEntries: Array<{ customType: string; data: unknown }>;
	failDelegationStateAppendOnceWhen?: (state: DelegationStateRecord) => boolean;
	failedDelegationStateAppendCount: number;
}

interface RuntimeResult {
	content: Array<Record<string, unknown>>;
	details: Record<string, unknown>;
	usage?: unknown;
}

interface RuntimeTool {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<RuntimeResult>;
}

const WORKER_ENV_NAMES = [
	WORKER_ROLE_ENV,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_TASK_KIND_ENV,
	WORKER_SPEND_PROFILE_ENV,
] as const;
const requireForTest = createRequire(import.meta.url);
const TSX_CJS_PATH = requireForTest.resolve("tsx/cjs");
const WRITE_JOURNAL_MODULE_PATH = fileURLToPath(new URL("../extensions/workbench-runtime/core/write-journal.ts", import.meta.url));

function makeStub(): StubAPI & ExtensionAPI {
	const stub = {
		tools: new Map<string, unknown>(),
		events: new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>(),
		appendedEntries: [] as Array<{ customType: string; data: unknown }>,
		failDelegationStateAppendOnceWhen: undefined as ((state: DelegationStateRecord) => boolean) | undefined,
		failedDelegationStateAppendCount: 0,
		registerCommand: () => {},
		registerTool: (definition: { name: string }) => { stub.tools.set(definition.name, definition); },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const handlers = stub.events.get(event) ?? [];
			handlers.push(handler);
			stub.events.set(event, handlers);
		},
		appendEntry: (customType: string, data?: unknown) => {
			if (
				customType === DELEGATION_STATE_ENTRY_TYPE
				&& stub.failDelegationStateAppendOnceWhen !== undefined
				&& stub.failDelegationStateAppendOnceWhen(data as DelegationStateRecord)
			) {
				stub.failDelegationStateAppendOnceWhen = undefined;
				stub.failedDelegationStateAppendCount += 1;
				throw new Error("injected one-shot delegation state append failure");
			}
			stub.appendedEntries.push({ customType, data });
		},
		sendMessage: () => {},
		sendUserMessage: () => {},
		setActiveTools: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		getThinkingLevel: () => "high" as never,
		exec: spawnExec,
	} as unknown as StubAPI & ExtensionAPI;
	return stub;
}

function commanderRuntime(): StubAPI & ExtensionAPI {
	const previous = new Map(WORKER_ENV_NAMES.map((name) => [name, process.env[name]]));
	try {
		for (const name of WORKER_ENV_NAMES) delete process.env[name];
		const stub = makeStub();
		workbenchRuntime(stub);
		return stub;
	} finally {
		for (const name of WORKER_ENV_NAMES) {
			const value = previous.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function commanderContext(
	root: string,
	sessionId: string,
	entries: readonly Record<string, unknown>[] = [],
): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => entries,
			getSessionFile: () => join(root, `${sessionId}.jsonl`),
			getSessionId: () => sessionId,
		} as unknown as ExtensionContext["sessionManager"],
		model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" },
		thinkingLevel: "high",
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, confirm: async () => false } as unknown as ExtensionContext["ui"],
		signal: undefined,
	} as unknown as ExtensionContext;
}

async function startSession(stub: StubAPI, ctx: ExtensionContext): Promise<void> {
	for (const handler of stub.events.get("session_start") ?? []) {
		await handler({ reason: "resume" }, ctx);
	}
}

function delegateTool(stub: StubAPI): RuntimeTool {
	const tool = stub.tools.get("workbench_delegate_worker");
	assert.ok(tool);
	return tool as RuntimeTool;
}

function delegationStatusTool(stub: StubAPI): RuntimeTool {
	const tool = stub.tools.get("workbench_delegation_status");
	assert.ok(tool);
	return tool as RuntimeTool;
}

function resultText(result: RuntimeResult): string {
	return result.content
		.map((item) => typeof item.text === "string" ? item.text : "")
		.filter(Boolean)
		.join("\n");
}

function delegateParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		task: "Perform the bounded delegated task.",
		allowed_paths: ["src/**"],
		acceptance_criteria: ["The requested bounded behavior is observed."],
		verification: [],
		timeout_seconds: 60,
		...overrides,
	};
}

async function initializeProject(root: string): Promise<void> {
	await writeConfigFile(root, "project.yaml", "name: delegation-v2-wiring\nprofile: generic\n");
	await mkdir(join(root, "src"), { recursive: true });
	const initialized = await spawnExec("git", ["init", "-q"], { cwd: root });
	assert.equal(initialized.code, 0, initialized.stderr);
}

const PROJECT_AUTHORITY_CONTRACT_HASH = "b".repeat(64);

function projectAuthorityTime(second: number): string {
	return `2026-08-20T17:00:${String(second).padStart(2, "0")}.000Z`;
}

function projectAuthorityCas(state: DelegationTransactionRecord, second: number) {
	return {
		delegation_id: state.delegation_id,
		contract_hash: state.contract_hash,
		worker_identity: state.worker_identity,
		expected_generation: state.generation,
		expected_revision: state.revision,
		now: projectAuthorityTime(second),
	};
}

async function seedProjectAuthorityPrepared(root: string, id: string): Promise<DelegationTransactionRecord> {
	const prepared = await persistPreparedDelegationTransaction(root, {
		delegation_id: id,
		task_kind: "implementation",
		contract_hash: PROJECT_AUTHORITY_CONTRACT_HASH,
		allowed_paths: ["src/**"],
		worker_identity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: `worker:${id}` },
		generation: 1,
		now: projectAuthorityTime(0),
	});
	if (!prepared.ok) throw new Error(prepared.error.code);
	return prepared.value;
}

async function seedProjectAuthorityAborted(root: string, id: string): Promise<DelegationTransactionRecord> {
	const prepared = await seedProjectAuthorityPrepared(root, id);
	const aborted = await persistAbortedDelegationTransaction(root, {
		...projectAuthorityCas(prepared, 1),
		reason: "bounded before-worker abort",
	});
	if (!aborted.ok) throw new Error(aborted.error.code);
	return aborted.value;
}

async function seedProjectAuthorityRecovery(root: string, id: string): Promise<DelegationTransactionRecord> {
	const prepared = await seedProjectAuthorityPrepared(root, id);
	const running = await persistRunningDelegationTransaction(root, projectAuthorityCas(prepared, 1));
	if (!running.ok) throw new Error(running.error.code);
	const recovery = await persistRecoveryRequiredDelegationTransaction(root, {
		...projectAuthorityCas(running.value, 2),
		reason: "bounded recovery evidence",
	});
	if (!recovery.ok) throw new Error(recovery.error.code);
	return recovery.value;
}

function completeReport(changedPaths: readonly string[] = []): string {
	return [
		"## Completed",
		"- Recorded bounded machine-observable facts.",
		"## Files Changed",
		changedPaths.length === 0 ? "- None." : changedPaths.map((path) => `- ${path}`).join("\n"),
		"## Verification",
		"- No command requested.",
		"## Remaining Risks",
		"- None.",
	].join("\n");
}

async function writeFakeWorker(
	root: string,
	options: { changedPath?: string; changedPaths?: readonly string[]; deniedWrite?: boolean; body?: string; launchMarkerPath?: string; unownedPath?: string },
): Promise<string> {
	const path = join(root, `fake-worker-${Math.random().toString(36).slice(2)}.cjs`);
	const setup = [
		options.launchMarkerPath === undefined
			? ""
			: `require('node:fs').appendFileSync(${JSON.stringify(options.launchMarkerPath)}, 'launch\\n', 'utf8');`,
	].filter(Boolean).join("\n");
	const changedPaths = options.changedPaths ?? (options.changedPath === undefined ? [] : [options.changedPath]);
	const report = completeReport(changedPaths);
	const content = options.deniedWrite
		? `[{ type: 'toolCall', id: 'denied-write-1', name: 'write', arguments: { path: 'src/forbidden.txt' } }, { type: 'text', text: ${JSON.stringify(report)} }]`
		: `[{ type: 'text', text: ${JSON.stringify(report)} }]`;
	await writeFile(path, [
		`require(${JSON.stringify(TSX_CJS_PATH)});`,
		`const journal = require(${JSON.stringify(WRITE_JOURNAL_MODULE_PATH)});`,
		"async function main() {",
		setup,
		...(changedPaths.length === 0 ? [] : [
			"  const delegationId = process.env.WORKBENCH_WORKER_DELEGATION_ID;",
			"  const contractHash = process.env.WORKBENCH_WORKER_CONTRACT_HASH;",
			`  const changedPaths = ${JSON.stringify(changedPaths)};`,
			"  let revision = 0;",
			"  for (let index = 0; index < changedPaths.length; index += 1) {",
			"    const changedPath = changedPaths[index];",
			"    const operationId = (index + 1).toString(16).padStart(64, '0');",
			"    const begun = await journal.beginWriteJournalOperation({ project_root: process.cwd(), delegation_id: delegationId, contract_hash: contractHash, expected_revision: revision, operation_id: operationId, kind: 'write', path: changedPath });",
			"    if (!begun.ok) throw new Error('journal begin failed');",
			"    revision = begun.value.revision;",
			"    process.stdout.write(JSON.stringify({ type: 'entry_appended', entry: { type: 'custom', customType: 'workbench-worker-write-journal-runtime-v1', data: { schema: 'workbench-worker-write-journal-runtime-v1', phase: 'begin', tool: 'write', outcome: 'none', code: 'none', revision, poisoned: 0 } } }) + '\\n');",
			`    require('node:fs').writeFileSync(changedPath, ${JSON.stringify(options.body ?? "v2 change\n")}, 'utf8');`,
			"    const completed = await journal.completeWriteJournalOperation({ project_root: process.cwd(), delegation_id: delegationId, contract_hash: contractHash, expected_revision: revision, operation_id: operationId, kind: 'write', path: changedPath, outcome: 'succeeded' });",
			"    if (!completed.ok) throw new Error('journal complete failed');",
			"    revision = completed.value.revision;",
			"    process.stdout.write(JSON.stringify({ type: 'entry_appended', entry: { type: 'custom', customType: 'workbench-worker-write-journal-runtime-v1', data: { schema: 'workbench-worker-write-journal-runtime-v1', phase: 'complete', tool: 'write', outcome: 'succeeded', code: 'none', revision, poisoned: 0 } } }) + '\\n');",
			"  }",
		]),
		...(options.unownedPath === undefined ? [] : [
			`  require('node:fs').writeFileSync(${JSON.stringify(options.unownedPath)}, 'unowned drift\\n', 'utf8');`,
		]),
		"const message = {",
		"  role: 'assistant',",
		`  content: ${content},`,
		"  provider: 'deepseek', model: 'deepseek-v4-flash', stopReason: 'stop',",
		"  usage: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },",
		"};",
		"process.stdout.write(JSON.stringify({ type: 'message_end', message }) + '\\n');",
		"}",
		"main().catch((error) => { process.stderr.write(String(error && error.message || error)); process.exitCode = 1; });",
		"",
	].join("\n"), "utf8");
	return path;
}

async function withFakeWorker<T>(script: string, action: () => Promise<T>): Promise<T> {
	const previous = process.argv[1];
	try {
		process.argv[1] = script;
		return await action();
	} finally {
		if (previous === undefined) delete process.argv[1];
		else process.argv[1] = previous;
	}
}

function delegationId(result: RuntimeResult): string {
	const id = result.details.delegation_id;
	assert.equal(typeof id, "string");
	return id as string;
}

function latestSessionState(stub: StubAPI): DelegationStateRecord {
	const entry = [...stub.appendedEntries].reverse().find((candidate) => candidate.customType === DELEGATION_STATE_ENTRY_TYPE);
	assert.ok(entry);
	return entry.data as DelegationStateRecord;
}

function latestCompactState(stub: StubAPI): CompactState {
	const entry = [...stub.appendedEntries].reverse().find((candidate) => candidate.customType === COMPACT_STATE_ENTRY_TYPE);
	assert.ok(entry);
	return entry.data as CompactState;
}

async function persistCompactMirror(stub: StubAPI, ctx: ExtensionContext): Promise<void> {
	const handler = stub.events.get("session_before_compact")?.[0];
	assert.ok(handler);
	await handler({
		type: "session_before_compact",
		preparation: {},
		branchEntries: [],
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	}, ctx);
}

async function delegationDirectories(root: string): Promise<string[]> {
	try {
		return (await readdir(join(root, CONFIG_DIR_NAME, "workbench", "delegations"))).sort();
	} catch {
		return [];
	}
}

async function assertNoNewV1WriterFiles(root: string, id: string): Promise<void> {
	const names = await readdir(join(root, CONFIG_DIR_NAME, "workbench", "delegations", id));
	for (const name of ["manifest.json", "before.json", "after.json", "worker-summary.json", "usage.json", "worker-report.md", "review.json"]) {
		assert.equal(names.includes(name), false, `${name} must not be emitted at the v1 top level`);
	}
}

async function emitToolResult(stub: StubAPI, result: RuntimeResult, toolCallId: string): Promise<Record<string, unknown>> {
	const event: Record<string, unknown> = {
		type: "tool_result",
		toolCallId,
		toolName: "workbench_delegate_worker",
		input: {},
		content: result.content,
		details: result.details,
		usage: result.usage,
		isError: false,
	};
	for (const handler of stub.events.get("tool_result") ?? []) {
		const patch = await handler(event, undefined) as Record<string, unknown> | undefined;
		if (!patch) continue;
		for (const key of ["content", "details", "isError", "usage"] as const) {
			if (Object.prototype.hasOwnProperty.call(patch, key)) event[key] = patch[key];
		}
	}
	return event;
}

test("diagnosis zero-diff commits v2 FINISHED, unblocks the mirror, and trusts only the immutable generation report", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const script = await writeFakeWorker(root, {});
		const stub = commanderRuntime();
		const tool = delegateTool(stub);
		const ctx = commanderContext(root, "diagnosis-success");
		await withFakeWorker(script, async () => {
			const first = await tool.execute("diagnosis-success-1", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx);
			const id = delegationId(first);
			const committed = await readDelegationCommittedGenerationV2(root, id);
			assert.equal(committed.ok, true);
			if (!committed.ok) return;
			assert.equal(committed.value.state.status, "FINISHED");
			assert.deepEqual(committed.value.records["after.json"], {
				...(committed.value.records["after.json"] as Record<string, unknown>),
				changed_since_before: [],
			});
			assert.match(String(committed.value.records["worker-report.md"]), /## Remaining Risks/);
			assert.equal(latestSessionState(stub).status, "REVIEWED");
			await assertNoNewV1WriterFiles(root, id);

			const projected = await emitToolResult(stub, first, "diagnosis-success-1");
			const ingress = (projected.details as Record<string, unknown>).ingress_projection as Record<string, unknown>;
			assert.ok(ingress);
			assert.equal(ingress.sourcePath, committed.value.records["worker-summary.json"] &&
				`.pi/workbench/delegations/${id}/v2/generations/g00000001/worker-report.md`);

			const second = await tool.execute("diagnosis-success-2", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx);
			assert.notEqual(delegationId(second), id, "a reviewed diagnosis permits the next delegation");
		});
	});
});

test("diagnosis REVIEWED mirror append failure stays PENDING_REVIEW and blocks the next delegation before transaction or child", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const launchMarkerPath = join(root, ".git", "worker-launches");
		const script = await writeFakeWorker(root, { launchMarkerPath });
		const stub = commanderRuntime();
		const tool = delegateTool(stub);
		const ctx = commanderContext(root, "diagnosis-reviewed-append-failure");
		stub.failDelegationStateAppendOnceWhen = (state) => state.status === "REVIEWED";

		await withFakeWorker(script, async () => {
			await assert.rejects(
				tool.execute("diagnosis-reviewed-append-failure-1", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx),
				/diagnosis session mirror persistence failed/,
			);
			assert.equal(stub.failedDelegationStateAppendCount, 1, "the injected failure is consumed exactly at the REVIEWED append");

			const directoriesAfterFirst = await delegationDirectories(root);
			assert.equal(directoriesAfterFirst.length, 1);
			const committed = await readDelegationCommittedGenerationV2(root, directoriesAfterFirst[0]!);
			assert.equal(committed.ok, true);
			if (!committed.ok) return;
			assert.equal(committed.value.state.status, "FINISHED", "the immutable diagnosis generation stays FINISHED");
			assert.equal(latestSessionState(stub).status, "PENDING_REVIEW", "the latest successful session append stays blocking");

			await persistCompactMirror(stub, ctx);
			const compact = latestCompactState(stub);
			assert.equal(compact.pendingDelegationReview, true, "the compact mirror stays blocking after the failed REVIEWED append");
			assert.equal(compact.lastDelegationId, directoriesAfterFirst[0]);
			assert.match(compact.nextDelegationAction ?? "", /PENDING_REVIEW/);

			const launchCountAfterFirst = (await readFile(launchMarkerPath, "utf8")).trim().split("\n").length;
			await assert.rejects(
				tool.execute("diagnosis-reviewed-append-failure-2", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx),
				/PENDING_REVIEW/,
			);
			assert.deepEqual(await delegationDirectories(root), directoriesAfterFirst, "the second delegation is rejected before a new transaction directory");
			const launchCountAfterSecond = (await readFile(launchMarkerPath, "utf8")).trim().split("\n").length;
			assert.equal(launchCountAfterSecond, launchCountAfterFirst, "the second delegation is rejected before child launch");
		});
	});
});

test("implementation real in-scope delta auto-reviews and permits the next delegation", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const script = await writeFakeWorker(root, { changedPath: "src/implemented.txt" });
		const diagnosisScript = await writeFakeWorker(root, {});
		const stub = commanderRuntime();
		const tool = delegateTool(stub);
		const ctx = commanderContext(root, "implementation-success");
		await withFakeWorker(script, async () => {
			const result = await tool.execute("implementation-success-1", delegateParams({ task_kind: "implementation" }), undefined, undefined, ctx);
			const id = delegationId(result);
			const committed = await readDelegationCommittedGenerationV2(root, id);
			assert.equal(committed.ok, true);
			if (!committed.ok) return;
			assert.equal(committed.value.state.status, "REVIEWED");
			assert.deepEqual((committed.value.records["after.json"] as Record<string, unknown>).changed_since_before, ["src/implemented.txt"]);
			assert.equal(latestSessionState(stub).status, "REVIEWED");
			assert.equal(result.details.review_status, "REVIEWED");
			await assertNoNewV1WriterFiles(root, id);
			const second = await withFakeWorker(diagnosisScript, () => tool.execute(
				"implementation-next-2", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx,
			));
			assert.notEqual(delegationId(second), id, "ordinary delivery needs no manual review/status chain");
		});
	});
});

test("implementation auto-review append failure stays blocking and creates no second transaction", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const launchMarkerPath = join(root, ".git", "worker-launches");
		const script = await writeFakeWorker(root, { changedPath: "src/implemented.txt", launchMarkerPath });
		const stub = commanderRuntime();
		const tool = delegateTool(stub);
		const ctx = commanderContext(root, "implementation-auto-review-append-failure");
		stub.failDelegationStateAppendOnceWhen = (state) => state.status === "REVIEWED";

		await withFakeWorker(script, async () => {
			await assert.rejects(
				tool.execute("implementation-auto-review-failure-1", delegateParams(), undefined, undefined, ctx),
				/default delivery session_persistence_failed/,
			);
			assert.equal(stub.failedDelegationStateAppendCount, 1);
			const directories = await delegationDirectories(root);
			assert.equal(directories.length, 1);
			const committed = await readDelegationCommittedGenerationV2(root, directories[0]!);
			assert.equal(committed.ok, true);
			if (!committed.ok) return;
			assert.equal(committed.value.state.status, "REVIEWED", "the immutable review was published before the mirror append failed");
			assert.equal(latestSessionState(stub).status, "PENDING_REVIEW", "the last successful session entry stays blocking");

			const launchesBefore = (await readFile(launchMarkerPath, "utf8")).trim().split("\n").length;
			await assert.rejects(
				tool.execute("implementation-auto-review-failure-2", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx),
				/PENDING_REVIEW|mirror persistence/i,
			);
			assert.deepEqual(await delegationDirectories(root), directories);
			const launchesAfter = (await readFile(launchMarkerPath, "utf8")).trim().split("\n").length;
			assert.equal(launchesAfter, launchesBefore, "the blocked retry never launches another worker");
		});
	});
});

test("public implementation result exposes only ChangeSet worker delta while the session mirrors the guard binding", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		await writeFile(join(root, "src", "pre-dirty-unknown.txt"), "pre-dirty\n", "utf8");
		const script = await writeFakeWorker(root, { changedPath: "src/implemented.txt" });
		const stub = commanderRuntime();
		const ctx = commanderContext(root, "implementation-pre-dirty");
		await withFakeWorker(script, async () => {
			const result = await delegateTool(stub).execute(
				"implementation-pre-dirty-1", delegateParams({ task_kind: "implementation" }), undefined, undefined, ctx,
			);
			const id = delegationId(result);
			const committed = await readDelegationCommittedGenerationV2(root, id);
			assert.equal(committed.ok, true);
			if (!committed.ok) return;
			const after = committed.value.records["after.json"] as Record<string, unknown>;
			assert.deepEqual(after.changed_paths, ["src/implemented.txt"], "immutable worker authority is ChangeSet-only");
			const fullSnapshotPaths = Object.keys(after.path_statuses as Record<string, unknown>);
			assert.ok(fullSnapshotPaths.includes("src/implemented.txt"));
			assert.ok(fullSnapshotPaths.includes("src/pre-dirty-unknown.txt"), "the full workspace snapshot retains the pre-dirty unknown path");
			assert.ok(fullSnapshotPaths.length > 1, "the full snapshot remains broader than the worker delta");
			assert.deepEqual(result.details.changed_paths, ["src/implemented.txt"], "public handoff cannot expose full-snapshot paths");
			const review = await readDelegationReviewV2(root, id);
			assert.equal(review.ok, true);
			if (!review.ok) return;
			assert.equal(review.value.finalized, true);
			assert.equal(latestSessionState(stub).currentDiffHash, review.value.review.bound_diff_hash, "session authority observes the finalized relevance binding");
			assert.equal(latestSessionState(stub).reviewedDiffHash, review.value.review.bound_diff_hash);
		});
	});
});

test("implementation omission defaults to implementation, zero diff durably FAILS, and its delta-free mirror permits the next delegation", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const script = await writeFakeWorker(root, {});
		const stub = commanderRuntime();
		const tool = delegateTool(stub);
		const ctx = commanderContext(root, "implementation-zero");
		await withFakeWorker(script, async () => {
			await assert.rejects(
				tool.execute("implementation-zero", delegateParams(), undefined, undefined, ctx),
				/IMPLEMENTATION_DELTA_REQUIRED/,
			);

			const directories = await delegationDirectories(root);
			assert.equal(directories.length, 1);
			const committed = await readDelegationCommittedGenerationV2(root, directories[0]!);
			assert.equal(committed.ok, true);
			if (!committed.ok) return;
			assert.equal(committed.value.state.task_kind, "implementation");
			assert.equal(committed.value.state.status, "FAILED");
			assert.deepEqual((committed.value.records["after.json"] as Record<string, unknown>).changed_since_before, []);

			const mirror = latestSessionState(stub);
			assert.equal(mirror.status, "REVIEWED", "a committed terminal failure with an exact zero delta needs no diff review");
			assert.equal(mirror.reviewedDiffHash, mirror.currentDiffHash, "the REVIEWED mirror stays bound to the actual current diff");

			const status = await delegationStatusTool(stub).execute("implementation-zero-status", {}, undefined, undefined, ctx);
			assert.match(resultText(status), /authority v2\s+: transaction FAILED/);
			assert.match(resultText(status), /completion v2: FAIL/);
			assert.doesNotMatch(resultText(status), /authority v2\s+: INVALID/);

			const second = await tool.execute(
				"implementation-zero-next-diagnosis",
				delegateParams({ task_kind: "diagnosis" }),
				undefined,
				undefined,
				ctx,
			);
			const secondCommitted = await readDelegationCommittedGenerationV2(root, delegationId(second));
			assert.equal(secondCommitted.ok, true);
			if (secondCommitted.ok) assert.equal(secondCommitted.value.state.status, "FINISHED");
		});
		assert.equal((stub.events.get("tool_result") ?? []).length > 0, true);
	});
});

test("public WORKSPACE_DRIFT failure keeps a nonzero binding PENDING and never auto-releases the next delegation", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const script = await writeFakeWorker(root, {
			changedPath: "src/implemented.txt",
			unownedPath: "src/unowned-drift.txt",
		});
		const stub = commanderRuntime();
		const ctx = commanderContext(root, "implementation-workspace-drift");
		await withFakeWorker(script, async () => {
			await assert.rejects(
				delegateTool(stub).execute("implementation-drift-1", delegateParams(), undefined, undefined, ctx),
				/WORKSPACE_DRIFT_DETECTED/,
			);
			const state = latestSessionState(stub);
			assert.equal(state.status, "PENDING_REVIEW");
			assert.equal(typeof state.latestId, "string");
			const committed = await readDelegationCommittedGenerationV2(root, state.latestId!);
			assert.equal(committed.ok, true);
			if (committed.ok) {
				const after = committed.value.records["after.json"] as Record<string, any>;
				assert.equal(after.change_set_status, "WORKSPACE_DRIFT");
				assert.ok(after.changed_since_before.length > 0);
				assert.ok(after.changed_since_before.includes("src/unowned-drift.txt"));
			}
			await assert.rejects(
				delegateTool(stub).execute("implementation-drift-blocked", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx),
				/PENDING_REVIEW/,
			);
		});
	});
});

test("implementation zero-delta FAILED mirror append fault stays PENDING_REVIEW and blocks before a second transaction or child", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const launchMarkerPath = join(root, ".git", "worker-launches");
		const script = await writeFakeWorker(root, { launchMarkerPath });
		const stub = commanderRuntime();
		const tool = delegateTool(stub);
		const ctx = commanderContext(root, "implementation-zero-reviewed-append-failure");
		stub.failDelegationStateAppendOnceWhen = (state) => state.status === "REVIEWED";

		await withFakeWorker(script, async () => {
			await assert.rejects(
				tool.execute("implementation-zero-reviewed-append-failure-1", delegateParams(), undefined, undefined, ctx),
				/session mirror persistence failed/,
			);
			assert.equal(stub.failedDelegationStateAppendCount, 1, "the injected failure is consumed exactly at the zero-delta REVIEWED append");

			const directoriesAfterFirst = await delegationDirectories(root);
			assert.equal(directoriesAfterFirst.length, 1);
			const committed = await readDelegationCommittedGenerationV2(root, directoriesAfterFirst[0]!);
			assert.equal(committed.ok, true);
			if (!committed.ok) return;
			assert.equal(committed.value.state.status, "FAILED", "the immutable transaction remains terminal FAILED");
			assert.deepEqual((committed.value.records["after.json"] as Record<string, unknown>).changed_since_before, []);
			assert.equal(latestSessionState(stub).status, "PENDING_REVIEW", "the latest successfully appended mirror remains fail-closed");

			const launchCountAfterFirst = (await readFile(launchMarkerPath, "utf8")).trim().split("\n").length;
			await assert.rejects(
				tool.execute("implementation-zero-reviewed-append-failure-2", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx),
				/PENDING_REVIEW/,
			);
			assert.deepEqual(await delegationDirectories(root), directoriesAfterFirst, "the second delegation is rejected before a new transaction directory");
			const launchCountAfterSecond = (await readFile(launchMarkerPath, "utf8")).trim().split("\n").length;
			assert.equal(launchCountAfterSecond, launchCountAfterFirst, "the second delegation is rejected before child launch");
		});
	});
});

test("diagnosis denied structured write or real delta durably FAILS", async () => {
	for (const scenario of [
		{ name: "denied", fake: { deniedWrite: true }, reason: "DIAGNOSIS_DENIED_WRITES_FORBIDDEN" },
		{ name: "delta", fake: { changedPath: "src/diagnosis-write.txt" }, reason: "DIAGNOSIS_DELTA_FORBIDDEN" },
	] as const) {
		await withTempDir(async (root) => {
			await initializeProject(root);
			const script = await writeFakeWorker(root, scenario.fake);
			const stub = commanderRuntime();
			const tool = delegateTool(stub);
			const ctx = commanderContext(root, scenario.name);
			await withFakeWorker(script, async () => {
				await assert.rejects(
					tool.execute(`diagnosis-${scenario.name}`, delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx),
					new RegExp(scenario.reason),
				);
				if (scenario.name === "delta") {
					assert.equal(latestSessionState(stub).status, "PENDING_REVIEW", "a FAILED execution with a real delta must remain blocking");
					const directoriesAfterFirst = await delegationDirectories(root);
					await assert.rejects(
						tool.execute("diagnosis-real-delta-blocked-2", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx),
						/PENDING_REVIEW/,
					);
					assert.deepEqual(await delegationDirectories(root), directoriesAfterFirst, "the blocked follow-up creates no transaction");
				}
			});
			const directories = await delegationDirectories(root);
			assert.equal(directories.length, 1);
			const committed = await readDelegationCommittedGenerationV2(root, directories[0]!);
			assert.equal(committed.ok, true);
			if (committed.ok) assert.equal(committed.value.state.status, "FAILED");
		});
	}
});

async function installLegacyFinishedFixture(root: string, id: string): Promise<void> {
	const source = join(process.cwd(), "tests", "fixtures", "governance-v1", "delegation", "valid");
	const destination = join(root, CONFIG_DIR_NAME, "workbench", "delegations", id);
	await cp(source, destination, { recursive: true });
	for (const name of ["manifest.json", "before.json", "after.json", "worker-summary.json"]) {
		const path = join(destination, name);
		const text = await readFile(path, "utf8");
		await writeFile(path, text.replaceAll("20260817-010000-a001", id), "utf8");
	}
}

test("repair provenance prefers strict v2, allows terminal v2/v1, and never falls back from corrupt or incomplete-review v2", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const diagnosisScript = await writeFakeWorker(root, {});
		const incompletePaths = Array.from({ length: 20 }, (_, index) => `src/pending-${String(index).padStart(2, "0")}.txt`);
		const implementationScript = await writeFakeWorker(root, {
			changedPaths: incompletePaths,
			body: `${"large review line ".repeat(256)}\n`,
		});

		const finishedStub = commanderRuntime();
		const finished = await withFakeWorker(diagnosisScript, () => delegateTool(finishedStub).execute(
			"repair-source-finished", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, commanderContext(root, "repair-source-finished"),
		));
		const finishedId = delegationId(finished);

		const failedStub = commanderRuntime();
		await assert.rejects(withFakeWorker(diagnosisScript, () => delegateTool(failedStub).execute(
			"repair-source-failed", delegateParams(), undefined, undefined, commanderContext(root, "repair-source-failed"),
		)));
		const failedId = (await delegationDirectories(root)).find((id) => id !== finishedId)!;

		for (const repairId of [finishedId, failedId]) {
			const stub = commanderRuntime();
			const repaired = await withFakeWorker(diagnosisScript, () => delegateTool(stub).execute(
				`repair-allowed-${repairId}`, delegateParams({ task_kind: "diagnosis", repair_of: repairId }), undefined, undefined, commanderContext(root, `repair-${repairId}`),
			));
			assert.notEqual(delegationId(repaired), repairId);
		}

		const legacyId = "20260817-030000-v1ok";
		await installLegacyFinishedFixture(root, legacyId);
		const legacyRepair = await withFakeWorker(diagnosisScript, () => delegateTool(commanderRuntime()).execute(
			"repair-legacy-allowed", delegateParams({ task_kind: "diagnosis", repair_of: legacyId }), undefined, undefined, commanderContext(root, "repair-legacy-allowed"),
		));
		assert.notEqual(delegationId(legacyRepair), legacyId);

		const pendingStub = commanderRuntime();
		await assert.rejects(
			withFakeWorker(implementationScript, () => delegateTool(pendingStub).execute(
				"repair-source-pending", delegateParams({ task_kind: "implementation" }), undefined, undefined, commanderContext(root, "repair-source-pending"),
			)),
			/default delivery review_incomplete/,
		);
		const pendingId = latestSessionState(pendingStub).latestId!;
		const pendingAuthority = await readDelegationCommittedGenerationV2(root, pendingId);
		assert.equal(pendingAuthority.ok, true);
		if (pendingAuthority.ok) assert.equal(pendingAuthority.value.state.status, "PENDING_REVIEW");
		const beforePendingRefusal = await delegationDirectories(root);
		await assert.rejects(
			withFakeWorker(diagnosisScript, () => delegateTool(commanderRuntime()).execute(
				"repair-pending-refused", delegateParams({ task_kind: "diagnosis", repair_of: pendingId }), undefined, undefined, commanderContext(root, "repair-pending-refused"),
			)),
			/non-terminal v2 status PENDING_REVIEW/,
		);
		assert.deepEqual(await delegationDirectories(root), beforePendingRefusal, "pending provenance refuses before creating a transaction");

		await installLegacyFinishedFixture(root, finishedId);
		await writeFile(join(root, CONFIG_DIR_NAME, "workbench", "delegations", finishedId, "v2", "transaction.json"), "{\"schema_version\":2", "utf8");
		const beforeCorruptRefusal = await delegationDirectories(root);
		await assert.rejects(
			withFakeWorker(diagnosisScript, () => delegateTool(commanderRuntime()).execute(
				"repair-corrupt-refused", delegateParams({ task_kind: "diagnosis", repair_of: finishedId }), undefined, undefined, commanderContext(root, "repair-corrupt-refused"),
			)),
			/invalid_record/,
		);
		assert.deepEqual(await delegationDirectories(root), beforeCorruptRefusal, "corrupt v2 never falls back to the colocated v1 fixture");
	});
});

test("a fresh session discovers durable ABORTED project authority without reporting no delegation or invalid generation", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const id = "20260820-170000-abrt";
		await seedProjectAuthorityAborted(root, id);
		const stub = commanderRuntime();
		const ctx = commanderContext(root, "project-aborted", [{
			type: "custom",
			customType: DELEGATION_STATE_ENTRY_TYPE,
			data: {
				latestId: id,
				status: "REVIEWED",
				currentDiffHash: "1".repeat(64),
				reviewedDiffHash: "2".repeat(64),
				blockedWriteAttempts: 0,
				updatedAt: projectAuthorityTime(3),
			},
		}]);
		await startSession(stub, ctx);

		const mirror = latestSessionState(stub);
		assert.equal(mirror.latestId, id);
		assert.equal(mirror.status, "REVIEWED", "a before-worker abort is terminal and does not strand the next delegation");
		const status = await delegationStatusTool(stub).execute("project-aborted-status", {}, undefined, undefined, ctx);
		assert.match(resultText(status), /authority v2\s+: transaction ABORTED/);
		assert.match(resultText(status), /completion v2: FAIL/);
		assert.doesNotMatch(resultText(status), /INVALID|\(no delegation\)/);
	});
});

test("RECOVERY_REQUIRED project authority survives a failed session append and blocks before a new transaction", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const id = "20260820-170001-rcvr";
		const recovery = await seedProjectAuthorityRecovery(root, id);
		assert.equal(recovery.status, "RECOVERY_REQUIRED");
		assert.equal(recovery.recovery_reason, "bounded recovery evidence");
		const transactionPath = join(root, CONFIG_DIR_NAME, "workbench", "delegations", id, "v2", "transaction.json");
		const transactionBefore = await readFile(transactionPath, "utf8");
		const stub = commanderRuntime();
		stub.failDelegationStateAppendOnceWhen = (state) => state.latestId === id && state.status === "PENDING_REVIEW";
		const ctx = commanderContext(root, "project-recovery-append-failure");
		await startSession(stub, ctx);
		assert.equal(stub.failedDelegationStateAppendCount, 1);

		const before = await delegationDirectories(root);
		await assert.rejects(
			delegateTool(stub).execute("project-recovery-block", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx),
			/PENDING_REVIEW/,
		);
		assert.deepEqual(await delegationDirectories(root), before, "reconciliation blocks before a second transaction directory");
		const status = await delegationStatusTool(stub).execute("project-recovery-status", {}, undefined, undefined, ctx);
		assert.match(resultText(status), /authority v2\s+: transaction RECOVERY_REQUIRED/);
		assert.match(resultText(status), /latest\s+: .* PENDING_REVIEW/);
		assert.doesNotMatch(resultText(status), /authority v2\s+: INVALID/);
		assert.equal(await readFile(transactionPath, "utf8"), transactionBefore, "reconciliation never rewrites historical transaction authority");
	});
});

test("a corrupt newest project transaction overrides an optimistic REVIEWED session mirror and fails closed", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const id = "20260820-170002-bad1";
		const transaction = join(root, CONFIG_DIR_NAME, "workbench", "delegations", id, "v2", "transaction.json");
		await mkdir(dirname(transaction), { recursive: true });
		await writeFile(transaction, "{\"schema_version\":2", "utf8");
		const optimisticHash = "c".repeat(64);
		const entries = [{
			type: "custom",
			customType: DELEGATION_STATE_ENTRY_TYPE,
			data: {
				latestId: id,
				status: "REVIEWED",
				currentDiffHash: optimisticHash,
				reviewedDiffHash: optimisticHash,
				blockedWriteAttempts: 0,
				updatedAt: projectAuthorityTime(3),
			},
		}];
		const stub = commanderRuntime();
		const ctx = commanderContext(root, "project-corrupt", entries);
		await startSession(stub, ctx);

		const before = await delegationDirectories(root);
		await assert.rejects(
			delegateTool(stub).execute("project-corrupt-block", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx),
			/Project delegation authority .* invalid_record/,
		);
		assert.deepEqual(await delegationDirectories(root), before);
		const status = await delegationStatusTool(stub).execute("project-corrupt-status", {}, undefined, undefined, ctx);
		assert.match(resultText(status), /project auth\s+: INVALID \(invalid_record\)/);
		assert.match(resultText(status), /PROJECT_AUTHORITY_INVALID/);
	});
});

test("public delegate source has no legacy writer or direct runner wiring", async () => {
	const [block, adapters] = await Promise.all([
		readFile(join(process.cwd(), "extensions", "workbench-runtime", "core", "delegate-tool-controller.ts"), "utf8"),
		readFile(join(process.cwd(), "extensions", "workbench-runtime", "core", "runtime-controller-services.ts"), "utf8"),
	]);
	const statusCommands = await readFile(
		join(process.cwd(), "extensions", "workbench-runtime", "core", "status-commands.ts"),
		"utf8",
	);
	for (const forbidden of ["createDelegationLedger", "finishDelegationLedger", "runDeepseekWorker(", "collectGitFacts(", "collectAfterFacts("]) {
		assert.equal(block.includes(forbidden), false, forbidden);
	}
	assert.match(block, /resolveWorkerTaskKind\(params\.task_kind\)/);
	assert.match(block, /normalizeDelegationBoundedTaskContractV2\(/);
	assert.match(block, /controller\.services\.executeDelegation\(/);
	assert.match(block, /controller\.services\.completeDefaultDelivery\(/);
	assert.match(block, /changedPaths: handoffSummary\.changed_paths/);
	assert.match(block, /observeDiffChange\(controller\.getDelegationState\(\), execution\.after\.diffHash/);
	assert.doesNotMatch(block, /changedPaths: execution\.after\.changedSinceBefore/);
	assert.match(block, /priorV2\.error\.code === "not_found"/);
	assert.match(block, /controller\.services\.readCommittedGeneration/);
	assert.match(adapters, /executeDelegation: executeDelegationV2/);
	assert.match(adapters, /completeDefaultDelivery: completeDefaultDelegationDeliveryV2/);
	assert.match(adapters, /readCommittedGeneration: readDelegationCommittedGenerationV2/);
	assert.match(statusCommands, /new v2 refreshes worker\/dependency\/control relevance and rejects unknown-origin drift/);
	assert.match(statusCommands, /historical v2\/v1 retain full-diff freshness/);
});
