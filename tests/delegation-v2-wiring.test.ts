/** S1.1 public workbench_delegate_worker wiring through delegation-v2. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, unlink, utimes, writeFile } from "node:fs/promises";
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
	persistCommittingDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRecoveryRequiredDelegationTransaction,
	persistRunningDelegationTransaction,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTransactionV2,
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
import { createWorkerWriteJournal, sealWorkerWriteJournal } from "../extensions/workbench-runtime/core/write-journal.ts";
import { readWorkerRepairCapsule } from "../extensions/workbench-runtime/core/worker-repair-authority.ts";
import { readProjectDelegationRepairClosureV1 } from "../extensions/workbench-runtime/core/delegation-project-authority.ts";
import { buildDelegationWorkerFirstGateFacts } from "../extensions/workbench-runtime/core/delegation-plan-reference.ts";
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

function reviewTool(stub: StubAPI): RuntimeTool {
	const tool = stub.tools.get("workbench_review_worker_diff");
	assert.ok(tool);
	return tool as RuntimeTool;
}

function gitTool(stub: StubAPI): RuntimeTool {
	const tool = stub.tools.get("workbench_git");
	assert.ok(tool);
	return tool as RuntimeTool;
}

async function acceptCurrentSemanticReview(
	root: string,
	stub: StubAPI,
	ctx: ExtensionContext,
	delegationId: string,
): Promise<RuntimeResult> {
	const tool = reviewTool(stub);
	for (let segment = 0; segment < 500; segment += 1) {
		const current = await readDelegationReviewV2(root, delegationId);
		assert.equal(current.ok, true);
		if (!current.ok) throw new Error("strict provisional review is unavailable");
		const record = current.value.review as unknown as Record<string, unknown>;
		if (record.presentation_complete === true) {
			const bound = record.bound_diff_hash;
			assert.equal(typeof bound, "string");
			const accepted = await tool.execute("semantic-accept", {
				delegation_id: delegationId,
				semantic_decision: "ACCEPT",
				expected_bound_diff_hash: bound,
			}, undefined, undefined, ctx);
			assert.equal(accepted.details.ok, true, resultText(accepted));
			assert.equal(accepted.details.review_status, "REVIEWED");
			return accepted;
		}
		const remaining = record.presentation_remaining_paths;
		assert.ok(Array.isArray(remaining) && remaining.length > 0, "incomplete review names at least one remaining path");
		const presented = await tool.execute(`semantic-segment-${segment}`, {
			delegation_id: delegationId,
			include_paths: [remaining[0]],
			max_lines: 400,
			max_bytes: 32768,
		}, undefined, undefined, ctx);
		assert.equal(presented.details.ok, true, resultText(presented));
	}
	throw new Error("semantic presentation did not converge within the delegation path bound");
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

async function requireCurrentSemanticRepair(
	root: string,
	stub: StubAPI,
	ctx: ExtensionContext,
	delegationId: string,
	reason: string,
): Promise<RuntimeResult> {
	const tool = reviewTool(stub);
	for (let segment = 0; segment < 500; segment += 1) {
		const current = await readDelegationReviewV2(root, delegationId);
		assert.equal(current.ok, true);
		if (!current.ok) throw new Error("strict provisional review is unavailable");
		const record = current.value.review as unknown as Record<string, unknown>;
		if (record.presentation_complete === true) {
			const bound = record.bound_diff_hash;
			assert.equal(typeof bound, "string");
			const repaired = await tool.execute("semantic-repair", {
				delegation_id: delegationId,
				semantic_decision: "REPAIR",
				expected_bound_diff_hash: bound,
				repair_reason: reason,
			}, undefined, undefined, ctx);
			assert.equal(repaired.details.ok, true, resultText(repaired));
			assert.equal(repaired.details.review_status, "PENDING_REVIEW");
			return repaired;
		}
		const remaining = record.presentation_remaining_paths;
		assert.ok(Array.isArray(remaining) && remaining.length > 0, "incomplete review names at least one remaining path");
		const presented = await tool.execute(`semantic-repair-segment-${segment}`, {
			delegation_id: delegationId,
			include_paths: [remaining[0]],
			max_lines: 400,
			max_bytes: 32768,
		}, undefined, undefined, ctx);
		assert.equal(presented.details.ok, true, resultText(presented));
	}
	throw new Error("semantic repair presentation did not converge");
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

async function seedArtifactConstructionRecovery(root: string, id: string): Promise<DelegationTransactionRecord> {
	const prepared = await seedProjectAuthorityPrepared(root, id);
	const journal = await createWorkerWriteJournal({
		project_root: root,
		delegation_id: id,
		contract_hash: prepared.contract_hash,
	});
	if (!journal.ok) throw new Error(journal.error.code);
	const sealed = await sealWorkerWriteJournal({
		project_root: root,
		delegation_id: id,
		contract_hash: prepared.contract_hash,
		expected_revision: journal.value.revision,
	});
	if (!sealed.ok) throw new Error(sealed.error.code);
	const running = await persistRunningDelegationTransaction(root, projectAuthorityCas(prepared, 1));
	if (!running.ok) throw new Error(running.error.code);
	const committing = await persistCommittingDelegationTransaction(root, {
		...projectAuthorityCas(running.value, 2),
		outcome: {
			delegation_id: id,
			task_kind: "implementation",
			worker_identity: prepared.worker_identity,
			provider_success: true,
			exit_code: 0,
			report_complete: true,
			terminal_facts_complete: true,
			scope_complete: true,
			change_set_status: "ATTRIBUTED",
			changed_paths: [],
			successful_write_count: 0,
			denied_write_count: 0,
			delta_hash: "e".repeat(64),
		},
	});
	if (!committing.ok) throw new Error(committing.error.code);
	const recovery = await persistRecoveryRequiredDelegationTransaction(root, {
		...projectAuthorityCas(committing.value, 3),
		reason: "committed artifact construction failed",
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
		"  provider: 'openai-codex', model: 'gpt-5.6-luna', stopReason: 'stop',",
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

test("public delegate rejects retired low before transaction persistence or child launch", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const stub = commanderRuntime();
		await assert.rejects(
			delegateTool(stub).execute(
				"retired-low",
				delegateParams({ budget_profile: "low" }),
				undefined,
				undefined,
				commanderContext(root, "retired-low"),
			),
			/invalid_contract/,
		);
		assert.deepEqual(await delegationDirectories(root), [], "low is rejected before any transaction directory exists");
	});
});

test("public delegate verifies current plan bytes before persistence and binds valid plan_ref into v2", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const planPath = "docs/plans/current.md";
		const planBytes = "# Current delegation plan\n";
		await mkdir(dirname(join(root, planPath)), { recursive: true });
		await writeFile(join(root, planPath), planBytes, "utf8");
		const planRef = {
			schema: "workbench-plan-ref-v1",
			plan_id: "delegation-v2-current-plan",
			version: "1.0",
			plan_path: planPath,
			plan_sha256: createHash("sha256").update(planBytes).digest("hex"),
			candidate: "CURRENT_WORKTREE",
			status: "IN_PROGRESS",
			criteria: [{ id: "C1", gate_id: "b1", check_ids: ["b1.1"], evidence_paths: ["tests/delegation-v2-wiring.test.ts"] }],
			next_action: "execute the bounded diagnosis",
		};
		const stub = commanderRuntime();
		const tool = delegateTool(stub);
		const ctx = commanderContext(root, "plan-ref-current");

		await writeFile(join(root, planPath), "# Drifted delegation plan\n", "utf8");
		await assert.rejects(
			tool.execute("plan-ref-drift", delegateParams({ task_kind: "diagnosis", plan_ref: planRef }), undefined, undefined, ctx),
			/plan_ref digest_mismatch/,
		);
		assert.deepEqual(await delegationDirectories(root), [], "drift is rejected before any transaction directory exists");

		await writeFile(join(root, planPath), planBytes, "utf8");
		const script = await writeFakeWorker(root, {});
		const result = await withFakeWorker(script, () => tool.execute(
			"plan-ref-valid",
			delegateParams({ task_kind: "diagnosis", plan_ref: planRef }),
			undefined,
			undefined,
			ctx,
		));
		const committed = await readDelegationCommittedGenerationV2(root, delegationId(result));
		assert.equal(committed.ok, true, committed.ok ? "" : committed.error.code);
		if (!committed.ok) return;
		const before = committed.value.records["before.json"] as Record<string, unknown>;
		const contract = before.contract as Record<string, unknown>;
		assert.equal((contract.plan_ref as Record<string, unknown>).plan_sha256, planRef.plan_sha256);
		assert.equal(contract.contract_hash, committed.value.state.contract_hash);

		const beforeContinuation = await delegationDirectories(root);
		await assert.rejects(
			tool.execute(
				"plan-ref-omitted-successor",
				delegateParams({ task_kind: "diagnosis" }),
				undefined,
				undefined,
				ctx,
			),
			/latest strict committed delegation carries one/,
			"a current strict plan cannot disappear through an omitted successor field",
		);
		assert.deepEqual(
			await delegationDirectories(root),
			beforeContinuation,
			"continuity rejection happens before a successor transaction is allocated",
		);

		const successor = await withFakeWorker(script, () => tool.execute(
			"plan-ref-explicit-successor",
			delegateParams({ task_kind: "diagnosis", plan_ref: planRef }),
			undefined,
			undefined,
			ctx,
		));
		const successorCommitted = await readDelegationCommittedGenerationV2(root, delegationId(successor));
		assert.equal(successorCommitted.ok, true, successorCommitted.ok ? "" : successorCommitted.error.code);
		if (successorCommitted.ok) {
			const successorBefore = successorCommitted.value.records["before.json"] as Record<string, unknown>;
			const successorContract = successorBefore.contract as Record<string, unknown>;
			assert.deepEqual(successorContract.plan_ref, contract.plan_ref, "an explicit same plan remains contract-bound");
		}
	});
});

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

test("implementation real in-scope delta stays pending until explicit Sol acceptance, then permits the next delegation", async () => {
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
			assert.equal(committed.value.state.status, "PENDING_REVIEW");
			assert.deepEqual((committed.value.records["after.json"] as Record<string, unknown>).changed_since_before, ["src/implemented.txt"]);
			assert.equal(latestSessionState(stub).status, "PENDING_REVIEW");
			assert.equal(result.details.review_status, "PENDING_REVIEW");
			await assertNoNewV1WriterFiles(root, id);
			const directoriesBeforeBlockedSuccessor = await delegationDirectories(root);
			await assert.rejects(
				withFakeWorker(diagnosisScript, () => tool.execute(
					"implementation-blocked-before-accept", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx,
				)),
				/PENDING_REVIEW/,
			);
			assert.deepEqual(await delegationDirectories(root), directoriesBeforeBlockedSuccessor);
			await acceptCurrentSemanticReview(root, stub, ctx, id);
			const accepted = await readDelegationCommittedGenerationV2(root, id);
			assert.equal(accepted.ok, true);
			if (accepted.ok) assert.equal(accepted.value.state.status, "REVIEWED");
			assert.equal(latestSessionState(stub).status, "REVIEWED");
			const second = await withFakeWorker(diagnosisScript, () => tool.execute(
				"implementation-next-2", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx,
			));
			assert.notEqual(delegationId(second), id, "a hash-bound semantic ACCEPT releases the next delegation");
		});
	});
});

test("a FINAL/PASS v2 delegation that becomes STALE permits a fresh successor with the current workspace as its baseline", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const implementationScript = await writeFakeWorker(root, { changedPath: "src/implemented.txt" });
		const diagnosisScript = await writeFakeWorker(root, {});
		const stub = commanderRuntime();
		const tool = delegateTool(stub);
		const ctx = commanderContext(root, "finalized-stale-successor");

		const first = await withFakeWorker(implementationScript, () => tool.execute(
			"finalized-stale-first",
			delegateParams(),
			undefined,
			undefined,
			ctx,
		));
		const firstId = delegationId(first);
		const firstAuthority = await readDelegationCommittedGenerationV2(root, firstId);
		assert.equal(firstAuthority.ok, true);
		if (!firstAuthority.ok) return;
		assert.equal(firstAuthority.value.state.status, "PENDING_REVIEW");
		await acceptCurrentSemanticReview(root, stub, ctx, firstId);
		const acceptedAuthority = await readDelegationCommittedGenerationV2(root, firstId);
		assert.equal(acceptedAuthority.ok, true);
		if (acceptedAuthority.ok) assert.equal(acceptedAuthority.value.state.status, "REVIEWED");

		await writeFile(join(root, "src", "implemented.txt"), "intentional post-review policy drift\n", "utf8");
		const staleStatus = await delegationStatusTool(stub).execute("finalized-stale-status", {}, undefined, undefined, ctx);
		assert.match(resultText(staleStatus), /latest\s+: .* STALE/);
		assert.match(resultText(staleStatus), /successor\s+: ALLOWED after live revalidation/);
		assert.match(resultText(staleStatus), /verify block\s+: VERIFY remains blocked/);
		assert.doesNotMatch(resultText(staleStatus), /blocked\s+: Starting a new worker delegation/);
		const second = await withFakeWorker(diagnosisScript, () => tool.execute(
			"finalized-stale-successor",
			delegateParams({ task_kind: "diagnosis" }),
			undefined,
			undefined,
			ctx,
		));
		const secondId = delegationId(second);
		assert.notEqual(secondId, firstId);
		assert.equal(latestSessionState(stub).latestId, secondId);
		assert.equal(latestSessionState(stub).status, "REVIEWED");
		const stillImmutable = await readDelegationCommittedGenerationV2(root, firstId);
		assert.equal(stillImmutable.ok, true);
		if (stillImmutable.ok) assert.equal(stillImmutable.value.state.status, "REVIEWED");
	});
});

test("a STALE mirror never bypasses a corrupt finalized v2 authority", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const implementationScript = await writeFakeWorker(root, { changedPath: "src/implemented.txt" });
		const stub = commanderRuntime();
		const tool = delegateTool(stub);
		const ctx = commanderContext(root, "corrupt-stale-authority");
		const first = await withFakeWorker(implementationScript, () => tool.execute(
			"corrupt-stale-first",
			delegateParams(),
			undefined,
			undefined,
			ctx,
		));
		const firstId = delegationId(first);
		const review = await readDelegationReviewV2(root, firstId);
		assert.equal(review.ok, true);
		if (!review.ok) return;
		await writeFile(join(root, review.value.review_path), "{\"truncated\":true}", "utf8");
		await writeFile(join(root, "src", "implemented.txt"), "post-review drift\n", "utf8");
		const directoriesBefore = await delegationDirectories(root);
		await assert.rejects(
			tool.execute("corrupt-stale-second", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx),
			/invalid_record.*fails closed/,
		);
		assert.deepEqual(await delegationDirectories(root), directoriesBefore, "corrupt authority is rejected before a successor transaction is created");
	});
});

test("an incomplete v2-only directory blocks a fresh session before any new delegation is allocated", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const incompleteId = "20260820-180000-inc1";
		await mkdir(join(root, CONFIG_DIR_NAME, "workbench", "delegations", incompleteId, "v2"), { recursive: true });
		const before = await delegationDirectories(root);
		const stub = commanderRuntime();
		const ctx = commanderContext(root, "incomplete-v2-authority");
		await startSession(stub, ctx);
		await assert.rejects(
			delegateTool(stub).execute(
				"incomplete-v2-authority-delegate",
				delegateParams({ task_kind: "diagnosis" }),
				undefined,
				undefined,
				ctx,
			),
			/incomplete_v2_authority.*fails closed/,
		);
		assert.deepEqual(await delegationDirectories(root), before, "invalid prior authority is never hidden by a fresh id");
	});
});

test("semantic-accept mirror append failure reports failure, then durable FINAL reconciles before a successor", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const launchMarkerPath = join(root, ".git", "worker-launches");
		const script = await writeFakeWorker(root, { changedPath: "src/implemented.txt", launchMarkerPath });
		const diagnosisScript = await writeFakeWorker(root, { launchMarkerPath });
		const stub = commanderRuntime();
		const tool = delegateTool(stub);
		const ctx = commanderContext(root, "implementation-semantic-review-append-failure");

		await withFakeWorker(script, async () => {
			const delivered = await tool.execute("implementation-semantic-review-failure-1", delegateParams(), undefined, undefined, ctx);
			const id = delegationId(delivered);
			assert.equal(delivered.details.review_status, "PENDING_REVIEW");
			const provisional = await readDelegationReviewV2(root, id);
			assert.equal(provisional.ok, true);
			if (!provisional.ok) return;
			stub.failDelegationStateAppendOnceWhen = (state) => state.status === "REVIEWED";
			const acceptance = await reviewTool(stub).execute("implementation-semantic-accept-append-failure", {
				delegation_id: id,
				semantic_decision: "ACCEPT",
				expected_bound_diff_hash: provisional.value.review.bound_diff_hash,
			}, undefined, undefined, ctx);
			assert.equal(acceptance.details.ok, false);
			assert.equal(acceptance.details.error, "session_persistence_failed");
			assert.equal(stub.failedDelegationStateAppendCount, 1);
			const directories = await delegationDirectories(root);
			assert.equal(directories.length, 1);
			const committed = await readDelegationCommittedGenerationV2(root, directories[0]!);
			assert.equal(committed.ok, true);
			if (!committed.ok) return;
			assert.equal(committed.value.state.status, "REVIEWED", "the immutable semantic review was published before the mirror append failed");
			assert.equal(latestSessionState(stub).status, "PENDING_REVIEW", "the last successful session entry stays blocking");

			const launchesBefore = (await readFile(launchMarkerPath, "utf8")).trim().split("\n").length;
			const successor = await withFakeWorker(diagnosisScript, () => tool.execute(
				"implementation-semantic-review-failure-2", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx,
			));
			assert.notEqual(delegationId(successor), id);
			assert.equal(latestSessionState(stub).latestId, delegationId(successor));
			assert.equal(latestSessionState(stub).status, "REVIEWED");
			const launchesAfter = (await readFile(launchMarkerPath, "utf8")).trim().split("\n").length;
			assert.equal(launchesAfter, launchesBefore + 1, "the next call first reconciles strict durable FINAL, then launches once");
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
			assert.equal(review.value.finalized, false);
			assert.equal(latestSessionState(stub).currentDiffHash, review.value.review.bound_diff_hash, "session mirror observes the provisional relevance binding");
			assert.equal(latestSessionState(stub).reviewedDiffHash, undefined);
			await acceptCurrentSemanticReview(root, stub, ctx, id);
			const acceptedReview = await readDelegationReviewV2(root, id);
			assert.equal(acceptedReview.ok, true);
			if (!acceptedReview.ok) return;
			assert.equal(acceptedReview.value.finalized, true);
			assert.equal(latestSessionState(stub).reviewedDiffHash, acceptedReview.value.review.bound_diff_hash);
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
			const status = await delegationStatusTool(stub).execute("implementation-drift-status", {}, undefined, undefined, ctx);
			const statusOutput = resultText(status);
			assert.match(statusOutput, new RegExp(`latest\\s+: ${state.latestId} FAILED`, "u"));
			assert.match(statusOutput, new RegExp(`repair_of=${state.latestId}`, "u"));
			assert.doesNotMatch(statusOutput, /latest\s+: .* PENDING_REVIEW/u);
			assert.equal((statusOutput.match(/next action\s+:/gu) ?? []).length, 1, "FAILED reports one durable recovery action");
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

test("an explicit repair_of supersedes the exact latest committed FAILED delegation with a real delta", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const failedScript = await writeFakeWorker(root, { changedPath: "src/failed-worker-delta.txt" });
		const repairScript = await writeFakeWorker(root, {});
		const stub = commanderRuntime();
		const ctx = commanderContext(root, "committed-failed-repair");
		await assert.rejects(
			withFakeWorker(failedScript, () => delegateTool(stub).execute(
				"committed-failed-source", delegateParams({ task_kind: "diagnosis" }), undefined, undefined, ctx,
			)),
			/DIAGNOSIS_DELTA_FORBIDDEN/,
		);
		const failedId = latestSessionState(stub).latestId!;
		assert.equal(latestSessionState(stub).status, "PENDING_REVIEW");
		const failed = await readDelegationCommittedGenerationV2(root, failedId);
		assert.equal(failed.ok, true);
		if (failed.ok) {
			assert.equal(failed.value.state.status, "FAILED");
			assert.deepEqual(failed.value.state.terminal_outcome?.changed_paths, ["src/failed-worker-delta.txt"]);
		}
		const transactionPath = join(root, CONFIG_DIR_NAME, "workbench", "delegations", failedId, "v2", "transaction.json");
		const transactionBefore = await readFile(transactionPath, "utf8");
		const status = await delegationStatusTool(stub).execute("committed-failed-status", {}, undefined, undefined, ctx);
		assert.match(resultText(status), /completion v2:\s+FAIL/);
		assert.match(resultText(status), new RegExp(`repair_of=${failedId}`));
		const refusedReview = await reviewTool(stub).execute(
			"committed-failed-review", { delegation_id: failedId }, undefined, undefined, ctx,
		);
		assert.equal(refusedReview.details.error, "repair_required");
		assert.equal(refusedReview.details.repair_of, failedId);
		assert.match(resultText(refusedReview), /do not retry review/);
		assert.equal(await readFile(transactionPath, "utf8"), transactionBefore, "status and review guidance preserve committed FAILED evidence");

		const repaired = await withFakeWorker(repairScript, () => delegateTool(stub).execute(
			"committed-failed-repair", delegateParams({ task_kind: "diagnosis", repair_of: failedId }), undefined, undefined, ctx,
		));
		const repairId = delegationId(repaired);
		assert.notEqual(repairId, failedId);
		assert.equal(latestSessionState(stub).latestId, repairId);
		assert.equal(latestSessionState(stub).status, "REVIEWED");
		assert.equal(await readFile(transactionPath, "utf8"), transactionBefore, "the committed FAILED authority remains immutable");
	});
});

test("an exact semantic REPAIR sidecar launches one bounded implementation lineage and carries its W/D authority", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const rejectedPath = "src/rejected.ts";
		const initialScript = await writeFakeWorker(root, { changedPath: rejectedPath, body: "known-bad\n" });
		const repairScript = await writeFakeWorker(root, { changedPath: rejectedPath, body: "fixed\n" });
		const grandchildScript = await writeFakeWorker(root, { changedPath: rejectedPath, body: "fixed-again\n" });
		const stub = commanderRuntime();
		const ctx = commanderContext(root, "semantic-repair-lineage");
		const initial = await withFakeWorker(initialScript, () => delegateTool(stub).execute(
			"semantic-repair-parent",
			delegateParams({ task_kind: "implementation" }),
			undefined,
			undefined,
			ctx,
		));
		const parentId = delegationId(initial);
		assert.equal(latestSessionState(stub).status, "PENDING_REVIEW");
		await requireCurrentSemanticRepair(
			root,
			stub,
			ctx,
			parentId,
			"The provisional implementation is semantically wrong and must be replaced.",
		);

		const capsule = await readWorkerRepairCapsule(root, parentId);
		assert.equal(capsule.ok, true, capsule.ok ? "" : capsule.code);
		if (capsule.ok) {
			assert.equal(capsule.capsule.semantic_repair?.delegation_id, parentId);
			assert.match(capsule.capsule.semantic_repair?.decision_hash ?? "", /^[0-9a-f]{64}$/u);
			assert.equal(capsule.capsule.failure.reason_codes.includes("SEMANTIC_REPAIR_REQUIRED"), true);
		}

		const beforeBroadRefusal = await delegationDirectories(root);
		await assert.rejects(
			withFakeWorker(repairScript, () => delegateTool(stub).execute(
				"semantic-repair-broad-refused",
				delegateParams({ task_kind: "implementation", repair_of: parentId, allowed_paths: ["src/**"] }),
				undefined,
				undefined,
				ctx,
			)),
			/requires only exact-file allowed_paths/,
		);
		assert.deepEqual(await delegationDirectories(root), beforeBroadRefusal, "broad repair scope refuses before allocating a child");

		const repaired = await withFakeWorker(repairScript, () => delegateTool(stub).execute(
			"semantic-repair-exact",
			delegateParams({ task_kind: "implementation", repair_of: parentId, allowed_paths: [rejectedPath] }),
			undefined,
			undefined,
			ctx,
		));
		const repairId = delegationId(repaired);
		const committed = await readDelegationCommittedGenerationV2(root, repairId);
		assert.equal(committed.ok, true, committed.ok ? "" : committed.error.code);
		if (!committed.ok) return;
		assert.equal(committed.value.state.status, "PENDING_REVIEW");
		assert.equal(committed.value.state.repair_lineage?.repair_of, parentId);
		assert.equal(committed.value.state.repair_lineage?.depth, 1);
		assert.equal(committed.value.state.repair_lineage?.continuation_decision_delegation_id, parentId);
		assert.equal(committed.value.state.repair_lineage?.continuation_decision_hash, committed.value.state.repair_lineage?.root_decision_hash);
		assert.deepEqual(committed.value.state.repair_lineage?.carried_paths, [rejectedPath]);
		const scope = committed.value.records["scope.json"] as Record<string, any>;
		assert.deepEqual(scope.change_set.dependency_paths, [rejectedPath]);
		assert.deepEqual(scope.change_set.worker_delta.map((entry: { path: string }) => entry.path), [rejectedPath]);

		const secondDecision = await requireCurrentSemanticRepair(
			root,
			stub,
			ctx,
			repairId,
			"The first repair remains semantically wrong and requires one exact continuation.",
		);
		const secondDecisionHash = secondDecision.details.repair_decision_hash;
		assert.equal(typeof secondDecisionHash, "string");
		const grandchildResult = await withFakeWorker(grandchildScript, () => delegateTool(stub).execute(
			"semantic-repair-grandchild",
			delegateParams({ task_kind: "implementation", repair_of: repairId, allowed_paths: [rejectedPath] }),
			undefined,
			undefined,
			ctx,
		));
		const grandchildId = delegationId(grandchildResult);
		const grandchild = await readDelegationCommittedGenerationV2(root, grandchildId);
		assert.equal(grandchild.ok, true, grandchild.ok ? "" : grandchild.error.code);
		if (!grandchild.ok) return;
		assert.equal(grandchild.value.state.repair_lineage?.repair_of, repairId);
		assert.equal(grandchild.value.state.repair_lineage?.depth, 2);
		assert.equal(grandchild.value.state.repair_lineage?.continuation_decision_delegation_id, repairId);
		assert.equal(grandchild.value.state.repair_lineage?.continuation_decision_hash, secondDecisionHash);
		assert.deepEqual(grandchild.value.state.repair_lineage?.carried_paths, [rejectedPath]);
		await acceptCurrentSemanticReview(root, stub, ctx, grandchildId);
		assert.deepEqual(await readProjectDelegationRepairClosureV1(root), {
			ok: true,
			unresolvedTipId: null,
			rootCount: 1,
			lineageCount: 2,
		});

		const secondDecisionPath = join(root, CONFIG_DIR_NAME, "workbench", "delegations", repairId, "v2", "repair-decision.json");
		const parkedDecisionPath = `${secondDecisionPath}.parked`;
		await rename(secondDecisionPath, parkedDecisionPath);
		const missingContinuation = await readProjectDelegationRepairClosureV1(root);
		assert.equal(missingContinuation.ok, false);
		if (!missingContinuation.ok) assert.equal(missingContinuation.issue.code, "repair_lineage_continuation_invalid");
		await rename(parkedDecisionPath, secondDecisionPath);

		const siblingId = "20991231-235959-frk1";
		const sibling = await persistPreparedDelegationTransaction(root, {
			delegation_id: siblingId,
			task_kind: "implementation",
			contract_hash: "d".repeat(64),
			allowed_paths: [rejectedPath],
			worker_identity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: `worker:${siblingId}` },
			generation: 1,
			now: "2099-12-31T23:59:59.000Z",
			repair_lineage: committed.value.state.repair_lineage!,
		});
		assert.equal(sibling.ok, true, sibling.ok ? "" : sibling.error.code);
		const forked = await readProjectDelegationRepairClosureV1(root);
		assert.equal(forked.ok, false);
		if (!forked.ok) assert.equal(forked.issue.code, "repair_lineage_fork");
	});
});

test("a deliberately discarded repair closes on a clean repository and the same worktree accepts the next delegation", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		await writeFile(join(root, ".gitignore"), [
			`${CONFIG_DIR_NAME}/workbench/delegations/`,
			`${CONFIG_DIR_NAME}/workbench/tool-results/`,
			`${CONFIG_DIR_NAME}/workbench/runs/`,
			`${CONFIG_DIR_NAME}/workbench/delegation-start.lock`,
			"fake-worker-*.cjs",
			"",
		].join("\n"), "utf8");
		assert.equal((await spawnExec("git", ["add", ".gitignore", `${CONFIG_DIR_NAME}/workbench/project.yaml`], { cwd: root })).code, 0);
		const committed = await spawnExec("git", [
			"-c", "user.name=Workbench Test", "-c", "user.email=workbench@example.invalid",
			"commit", "-q", "-m", "test baseline",
		], { cwd: root });
		assert.equal(committed.code, 0, committed.stderr);

		const rejectedPath = "src/discarded-repair.ts";
		const rejectedScript = await writeFakeWorker(root, { changedPath: rejectedPath, body: "rejected\n" });
		const repairScript = await writeFakeWorker(root, { changedPath: rejectedPath, body: "fixed\n" });
		const nextScript = await writeFakeWorker(root, { changedPath: "src/next.ts", body: "next\n" });
		const stub = commanderRuntime();
		const ctx = commanderContext(root, "semantic-repair-clean-close");
		await startSession(stub, ctx);
		const initial = await withFakeWorker(rejectedScript, () => delegateTool(stub).execute(
			"clean-close-parent",
			delegateParams({ task_kind: "implementation", allowed_paths: [rejectedPath] }),
			undefined,
			undefined,
			ctx,
		));
		const parentId = delegationId(initial);
		await requireCurrentSemanticRepair(
			root,
			stub,
			ctx,
			parentId,
			"The rejected delta will be discarded rather than repaired.",
		);

		const dirtyRefusal = await gitTool(stub).execute(
			"clean-close-dirty",
			{ action: "close_clean_repair" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(dirtyRefusal.details.ok, false);
		assert.equal(dirtyRefusal.details.code, "workspace_not_clean");
		const stillOpen = await readProjectDelegationRepairClosureV1(root);
		assert.equal(stillOpen.ok, true);
		if (stillOpen.ok) assert.equal(stillOpen.unresolvedTipId, parentId);

		await unlink(join(root, rejectedPath));
		const cleanStatus = await spawnExec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root });
		assert.equal(cleanStatus.code, 0, cleanStatus.stderr);
		assert.equal(cleanStatus.stdout, "", cleanStatus.stdout);
		const closed = await gitTool(stub).execute(
			"clean-close-success",
			{ action: "close_clean_repair" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(closed.details.ok, true, resultText(closed));
		assert.equal(closed.details.action, "close_clean_repair");
		assert.equal(closed.details.delegation_id, parentId);
		assert.equal(closed.details.git_mutation, "NONE");
		assert.equal(closed.details.rejected_authority, "NOT_ACCEPTED");
		assert.match(String(closed.details.abandonment_hash), /^[0-9a-f]{64}$/u);
		assert.deepEqual(await readProjectDelegationRepairClosureV1(root), {
			ok: true,
			unresolvedTipId: null,
			rootCount: 1,
			lineageCount: 0,
		});
		await writeFile(join(root, rejectedPath), "rejected\n", "utf8");
		await assert.rejects(
			withFakeWorker(repairScript, () => delegateTool(stub).execute(
				"clean-close-cannot-reopen",
				delegateParams({ task_kind: "implementation", repair_of: parentId, allowed_paths: [rejectedPath] }),
				undefined,
				undefined,
				ctx,
			)),
			/durably closed after the rejected delta was discarded/,
		);
		await unlink(join(root, rejectedPath));

		const next = await withFakeWorker(nextScript, () => delegateTool(stub).execute(
			"clean-close-next",
			delegateParams({ task_kind: "implementation", allowed_paths: ["src/next.ts"] }),
			undefined,
			undefined,
			ctx,
		));
		assert.notEqual(delegationId(next), parentId);
		assert.equal(next.details.review_status, "PENDING_REVIEW");

		const receiptDirectory = join(root, CONFIG_DIR_NAME, "workbench", "delegations", parentId, "v2", "repair-abandonments-v1");
		const receiptNames = await readdir(receiptDirectory);
		assert.equal(receiptNames.length, 1);
		const receiptPath = join(receiptDirectory, receiptNames[0]!);
		const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
		receipt.abandonment_hash = "f".repeat(64);
		await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
		const corruptClosure = await readProjectDelegationRepairClosureV1(root);
		assert.equal(corruptClosure.ok, false);
		if (!corruptClosure.ok) assert.equal(corruptClosure.issue.code, "repair_abandonment_invalid");
	});
});

test("two sessions cannot consume one semantic REPAIR authority into sibling children", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const rejectedPath = "src/concurrent-rejected.ts";
		const initialScript = await writeFakeWorker(root, { changedPath: rejectedPath, body: "known-bad\n" });
		const repairScript = await writeFakeWorker(root, { changedPath: rejectedPath, body: "fixed\n" });
		const owner = commanderRuntime();
		const ownerContext = commanderContext(root, "semantic-repair-concurrency-owner");
		const initial = await withFakeWorker(initialScript, () => delegateTool(owner).execute(
			"semantic-repair-concurrency-parent",
			delegateParams({ task_kind: "implementation" }),
			undefined,
			undefined,
			ownerContext,
		));
		const parentId = delegationId(initial);
		await requireCurrentSemanticRepair(
			root,
			owner,
			ownerContext,
			parentId,
			"Reject this exact delta and permit only one bounded repair successor.",
		);

		const first = commanderRuntime();
		const second = commanderRuntime();
		const firstContext = commanderContext(root, "semantic-repair-concurrency-a");
		const secondContext = commanderContext(root, "semantic-repair-concurrency-b");
		await Promise.all([startSession(first, firstContext), startSession(second, secondContext)]);
		const attempts = await withFakeWorker(repairScript, () => Promise.allSettled([
			delegateTool(first).execute(
				"semantic-repair-concurrency-a",
				delegateParams({ task_kind: "implementation", repair_of: parentId, allowed_paths: [rejectedPath] }),
				undefined,
				undefined,
				firstContext,
			),
			delegateTool(second).execute(
				"semantic-repair-concurrency-b",
				delegateParams({ task_kind: "implementation", repair_of: parentId, allowed_paths: [rejectedPath] }),
				undefined,
				undefined,
				secondContext,
			),
		]));
		assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
		assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
		const directories = await delegationDirectories(root);
		assert.equal(directories.length, 2, "one root and exactly one repair child are durable");
		const childId = directories.find((id) => id !== parentId)!;
		const closure = await readProjectDelegationRepairClosureV1(root);
		assert.deepEqual(closure, { ok: true, unresolvedTipId: childId, rootCount: 1, lineageCount: 1 });
		const unrelatedId = "20981231-235959-new1";
		const unrelated = await persistPreparedDelegationTransaction(root, {
			delegation_id: unrelatedId,
			task_kind: "implementation",
			contract_hash: "e".repeat(64),
			allowed_paths: ["src/unrelated.ts"],
			worker_identity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: `worker:${unrelatedId}` },
			generation: 1,
			now: "2098-12-31T23:59:59.000Z",
		});
		assert.equal(unrelated.ok, true, unrelated.ok ? "" : unrelated.error.code);
		const hidden = await readProjectDelegationRepairClosureV1(root);
		assert.equal(hidden.ok, false);
		if (!hidden.ok) {
			assert.equal(hidden.issue.code, "additional_unresolved_authority");
			assert.equal(hidden.issue.delegationId, unrelatedId);
		}
		if (!unrelated.ok) return;
		const unrelatedAborted = await persistAbortedDelegationTransaction(root, {
			delegation_id: unrelated.value.delegation_id,
			contract_hash: unrelated.value.contract_hash,
			worker_identity: unrelated.value.worker_identity,
			expected_generation: unrelated.value.generation,
			expected_revision: unrelated.value.revision,
			now: "2099-01-01T00:00:00.000Z",
			reason: "bounded before-worker abort",
		});
		assert.equal(unrelatedAborted.ok, true, unrelatedAborted.ok ? "" : unrelatedAborted.error.code);
		assert.deepEqual(await readProjectDelegationRepairClosureV1(root), {
			ok: true,
			unresolvedTipId: childId,
			rootCount: 1,
			lineageCount: 1,
		});
		const readOnlyFacts = await buildDelegationWorkerFirstGateFacts({
			projectRoot: root,
			state: {
				latestId: unrelatedId,
				status: "REVIEWED",
				blockedWriteAttempts: 0,
				updatedAt: "2099-01-01T00:00:00.000Z",
			},
			currentDiffHash: null,
			runtime: {
				actor: "sol-commander",
				writePolicy: "worker-first-strict",
				commanderWritesDenied: true,
				leaseStatus: "locked",
				leaseReason: null,
				leaseCallsUsed: 0,
				leaseMaxCalls: 0,
				gateRunInitiatedByCommander: true,
			},
		});
		assert.match(readOnlyFacts.blockedReason ?? "", new RegExp(`delegation ${childId} has an unresolved semantic repair`));
	});
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

test("repair provenance prefers strict v2, large default review converges, and corrupt v2 never falls back", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const diagnosisScript = await writeFakeWorker(root, {});
		const segmentedPaths = Array.from({ length: 20 }, (_, index) => `src/segmented-${String(index).padStart(2, "0")}.txt`);
		const implementationScript = await writeFakeWorker(root, {
			changedPaths: segmentedPaths,
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

		const segmentedStub = commanderRuntime();
		const segmented = await withFakeWorker(implementationScript, () => delegateTool(segmentedStub).execute(
			"default-review-segmented", delegateParams({ task_kind: "implementation" }), undefined, undefined,
			commanderContext(root, "default-review-segmented"),
		));
		const segmentedId = delegationId(segmented);
		assert.equal(latestSessionState(segmentedStub).status, "PENDING_REVIEW");
		await acceptCurrentSemanticReview(root, segmentedStub, commanderContext(root, "default-review-segmented"), segmentedId);
		assert.equal(latestSessionState(segmentedStub).status, "REVIEWED");
		const segmentedAuthority = await readDelegationCommittedGenerationV2(root, segmentedId);
		assert.equal(segmentedAuthority.ok, true);
		if (segmentedAuthority.ok) assert.equal(segmentedAuthority.value.state.status, "REVIEWED");

		// Restore the committed transaction's pre-publication PENDING_REVIEW
		// shape to keep the repair provenance guard covered without creating a
		// second oversized worker fixture. The immutable generation and proof
		// stay untouched; only the mutable transaction publication is rewound
		// for the check and then restored byte-for-byte.
		const segmentedTransactionPath = join(
			root, CONFIG_DIR_NAME, "workbench", "delegations", segmentedId, "v2", "transaction.json",
		);
		const segmentedTransactionBefore = await readFile(segmentedTransactionPath, "utf8");
		const pendingTransaction = JSON.parse(segmentedTransactionBefore) as Record<string, unknown>;
		pendingTransaction.revision = 3;
		pendingTransaction.status = "PENDING_REVIEW";
		pendingTransaction.review = null;
		await writeFile(segmentedTransactionPath, `${JSON.stringify(pendingTransaction, null, 2)}\n`, "utf8");
		const pendingAuthority = await readDelegationCommittedGenerationV2(root, segmentedId);
		assert.equal(pendingAuthority.ok, true);
		if (pendingAuthority.ok) assert.equal(pendingAuthority.value.state.status, "PENDING_REVIEW");
		const beforePendingRefusal = await delegationDirectories(root);
		await assert.rejects(
			withFakeWorker(diagnosisScript, () => delegateTool(commanderRuntime()).execute(
				"repair-pending-refused", delegateParams({ task_kind: "diagnosis", repair_of: segmentedId }), undefined, undefined,
				commanderContext(root, "repair-pending-refused"),
			)),
			/requires an exact immutable semantic REPAIR decision/,
		);
		assert.deepEqual(await delegationDirectories(root), beforePendingRefusal, "pending provenance refuses before creating a transaction");
		await writeFile(segmentedTransactionPath, segmentedTransactionBefore, "utf8");

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
		assert.match(resultText(status), /next action\s+: start a fresh delegation; the terminal before-worker transaction needs no review/);
		assert.doesNotMatch(resultText(status), /INVALID|\(no delegation\)/);

		const script = await writeFakeWorker(root, {});
		const successor = await withFakeWorker(script, () => delegateTool(stub).execute(
			"project-aborted-successor",
			delegateParams({ task_kind: "diagnosis" }),
			undefined,
			undefined,
			ctx,
		));
		assert.notEqual(delegationId(successor), id, "the advertised fresh-delegation action is actually executable");
		const committed = await readDelegationCommittedGenerationV2(root, delegationId(successor));
		assert.equal(committed.ok, true, committed.ok ? "" : committed.error.code);
		if (committed.ok) assert.equal(committed.value.state.status, "FINISHED");
	});
});

test("resuming an older session mirror advances monotonically to the newest durable project transaction", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const oldId = "20260820-165900-old1";
		const newestId = "20260820-170000-new1";
		await seedProjectAuthorityAborted(root, oldId);
		await seedProjectAuthorityAborted(root, newestId);
		const stub = commanderRuntime();
		const ctx = commanderContext(root, "project-monotonic-resume", [{
			type: "custom",
			customType: DELEGATION_STATE_ENTRY_TYPE,
			data: {
				latestId: oldId,
				status: "PENDING_REVIEW",
				currentDiffHash: "1".repeat(64),
				blockedWriteAttempts: 0,
				updatedAt: projectAuthorityTime(1),
			},
		}]);
		await startSession(stub, ctx);

		const mirror = latestSessionState(stub);
		assert.equal(mirror.latestId, newestId, "the session-local old id never overrides newer project authority");
		assert.equal(mirror.status, "REVIEWED");
		const status = await delegationStatusTool(stub).execute("project-monotonic-status", {}, undefined, undefined, ctx);
		assert.match(resultText(status), new RegExp(`latest\\s+: ${newestId} ABORTED`, "u"));
		assert.match(resultText(status), /authority v2\s+: transaction ABORTED/u);
		assert.doesNotMatch(resultText(status), new RegExp(oldId, "u"));
		assert.doesNotMatch(resultText(status), /blocked\s+: Starting a new worker delegation/u);
	});
});

test("session_start atomically aborts an ownerless preboot empty RUNNING transaction and removes the review block", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const id = "20260820-170000-boot";
		const initial = await persistPreparedDelegationTransaction(root, {
			delegation_id: id,
			task_kind: "implementation",
			contract_hash: PROJECT_AUTHORITY_CONTRACT_HASH,
			allowed_paths: ["src/**"],
			worker_identity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: `worker:${id}` },
			generation: 1,
			now: "1970-01-01T00:00:01.000Z",
		});
		assert.equal(initial.ok, true, initial.ok ? "" : initial.error.code);
		if (!initial.ok) return;
		const journal = await createWorkerWriteJournal({
			project_root: root,
			delegation_id: id,
			contract_hash: initial.value.contract_hash,
		});
		assert.equal(journal.ok, true, journal.ok ? "" : journal.error.code);
		const running = await persistRunningDelegationTransaction(root, {
			...projectAuthorityCas(initial.value, 1),
			now: "1970-01-01T00:00:02.000Z",
		});
		assert.equal(running.ok, true, running.ok ? "" : running.error.code);
		if (!running.ok) return;
		const v2 = join(root, CONFIG_DIR_NAME, "workbench", "delegations", id, "v2");
		const beforeBoot = new Date("1970-01-01T00:00:03.000Z");
		await utimes(join(v2, "transaction.json"), beforeBoot, beforeBoot);
		await utimes(join(v2, "write-journal.json"), beforeBoot, beforeBoot);

		const stub = commanderRuntime();
		const ctx = commanderContext(root, "project-interrupted", [{
			type: "custom",
			customType: DELEGATION_STATE_ENTRY_TYPE,
			data: {
				latestId: id,
				status: "PENDING_REVIEW",
				currentDiffHash: "3".repeat(64),
				blockedWriteAttempts: 0,
				updatedAt: "1970-01-01T00:00:03.000Z",
			},
		}]);
		await startSession(stub, ctx);
		const durable = await readDelegationTransactionV2(root, id);
		assert.equal(durable.ok, true, durable.ok ? "" : durable.error.code);
		if (durable.ok) {
			assert.equal(durable.value.status, "ABORTED");
			assert.match(durable.value.abort_reason ?? "", /runtime interrupted before any worker write/);
		}
		assert.equal(latestSessionState(stub).status, "REVIEWED");
		const status = await delegationStatusTool(stub).execute("project-interrupted-status", {}, undefined, undefined, ctx);
		assert.doesNotMatch(resultText(status), /blocked\s+: Starting a new worker delegation/);
		assert.match(resultText(status), /next action\s+: start a fresh delegation/);
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
		assert.match(resultText(status), /latest\s+: .* RECOVERY_REQUIRED/);
		assert.doesNotMatch(resultText(status), /review delegation/);
		assert.doesNotMatch(resultText(status), /authority v2\s+: INVALID/);
		assert.equal(await readFile(transactionPath, "utf8"), transactionBefore, "reconciliation never rewrites historical transaction authority");
	});
});

test("an explicit repair_of safely supersedes an unpublished artifact failure without rewriting it", async () => {
	await withTempDir(async (root) => {
		await initializeProject(root);
		const brokenId = "20260820-170003-artf";
		const broken = await seedArtifactConstructionRecovery(root, brokenId);
		assert.equal(broken.status, "RECOVERY_REQUIRED");
		assert.equal(broken.committed_proof, null);
		const transactionPath = join(root, CONFIG_DIR_NAME, "workbench", "delegations", brokenId, "v2", "transaction.json");
		const transactionBefore = await readFile(transactionPath, "utf8");

		const stub = commanderRuntime();
		const ctx = commanderContext(root, "artifact-repair");
		await startSession(stub, ctx);
		assert.equal(latestSessionState(stub).latestId, brokenId);
		assert.equal(latestSessionState(stub).status, "PENDING_REVIEW");
		const status = await delegationStatusTool(stub).execute("artifact-repair-status", {}, undefined, undefined, ctx);
		assert.match(resultText(status), /RECOVERABLE_UNPUBLISHED/);
		assert.match(resultText(status), new RegExp(`repair_of=${brokenId}`));
		assert.doesNotMatch(resultText(status), /authority v2\s+: INVALID/);
		const refusedReview = await reviewTool(stub).execute(
			"artifact-repair-review", { delegation_id: brokenId }, undefined, undefined, ctx,
		);
		assert.equal(refusedReview.details.error, "repair_required");
		assert.equal(refusedReview.details.repair_of, brokenId);
		assert.equal(refusedReview.details.next_action, "workbench_delegate_worker");
		assert.match(resultText(refusedReview), new RegExp(`repair_of=${brokenId}`));
		assert.match(resultText(refusedReview), /do not retry review/);
		assert.equal(await readFile(transactionPath, "utf8"), transactionBefore, "status and review guidance never rewrite recovery evidence");

		const script = await writeFakeWorker(root, {});
		const repaired = await withFakeWorker(script, () => delegateTool(stub).execute(
			"artifact-repair-call",
			delegateParams({ task_kind: "diagnosis", repair_of: brokenId }),
			undefined,
			undefined,
			ctx,
		));
		const repairId = delegationId(repaired);
		assert.notEqual(repairId, brokenId);
		const committed = await readDelegationCommittedGenerationV2(root, repairId);
		assert.equal(committed.ok, true, committed.ok ? "" : committed.error.code);
		if (committed.ok) assert.equal(committed.value.state.status, "FINISHED");
		assert.equal(latestSessionState(stub).latestId, repairId);
		assert.equal(latestSessionState(stub).status, "REVIEWED");
		assert.equal(await readFile(transactionPath, "utf8"), transactionBefore, "the superseded recovery evidence remains immutable");
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
	for (const forbidden of ["createDelegationLedger", "finishDelegationLedger", "runPinnedWorker(", "collectGitFacts(", "collectAfterFacts("]) {
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
