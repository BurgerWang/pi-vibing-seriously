/** S1.1 strict public review/status/gate wiring for delegation transactions v2. */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { before, test } from "node:test";

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { deriveFinalizedDelegationWorkspaceFactsV2 } from "../extensions/workbench-runtime/core/delegation-workspace-v2.ts";
import { bindDelegationBoundedTaskContractV2, buildDelegationCommittedArtifactsV2 } from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import { finalizeDelegationChangeSetLifecycleV2, prepareDelegationChangeSetLifecycleV2 } from "../extensions/workbench-runtime/core/delegation-change-set-lifecycle.ts";
import {
	commitDelegationGeneration,
	persistCommittingDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRunningDelegationTransaction,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	type DelegationCommittedRecords,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	DELEGATION_STATE_ENTRY_TYPE,
	serializeDelegationState,
	type DelegationStateRecord,
} from "../extensions/workbench-runtime/core/delegation-state.ts";
import { COMPACT_STATE_ENTRY_TYPE, type CompactState } from "../extensions/workbench-runtime/core/compact.ts";
import { WORKBENCH_TOOL_NAMES, WORKBENCH_TOOL_PARAMETERS } from "../extensions/workbench-runtime/core/tool-catalog.ts";
import { NATIVE_OVERRIDE_NAMES } from "../extensions/workbench-runtime/core/native-tool-policy.ts";
import {
	collectAfterFacts,
	collectGitFacts,
	computeDiffHash,
	createDelegationLedger,
	finishDelegationLedger,
	type LedgerWorkerFacts,
} from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import type {
	DelegationTerminalOutcome,
	DelegationTransactionRecord,
	DelegationWorkerIdentity,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import {
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_MODEL_ID,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_PROVIDER,
	WORKER_ROLE_ENV,
	WORKER_TASK_KIND_ENV,
} from "../extensions/workbench-runtime/core/worker-policy.ts";
import { WORKER_SPEND_PROFILE_ENV } from "../extensions/workbench-runtime/core/worker-spend.ts";
import { beginWriteJournalOperation, completeWriteJournalOperation } from "../extensions/workbench-runtime/core/write-journal.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

const ID = "20260817-190000-rv2w";
const NOW = "2026-01-01T00:00:00.000Z";
const IDENTITY: DelegationWorkerIdentity = {
	provider: WORKER_PROVIDER,
	model: WORKER_MODEL_ID,
	worker_id: "review-wiring-worker",
};

interface RuntimeResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
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

interface StubAPI {
	tools: Map<string, unknown>;
	events: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	entries: Array<{ type: "custom"; customType: string; data: unknown }>;
	appendCalls: Array<{ customType: string; data: unknown }>;
	failDelegationAppendOnce?: (state: DelegationStateRecord) => boolean;
	failedDelegationAppends: number;
}

function makeStub(): StubAPI & ExtensionAPI {
	const stub = {
		tools: new Map<string, unknown>(),
		events: new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>(),
		entries: [] as Array<{ type: "custom"; customType: string; data: unknown }>,
		appendCalls: [] as Array<{ customType: string; data: unknown }>,
		failDelegationAppendOnce: undefined as ((state: DelegationStateRecord) => boolean) | undefined,
		failedDelegationAppends: 0,
		registerCommand: () => {},
		registerTool: (definition: { name: string }) => { stub.tools.set(definition.name, definition); },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const handlers = stub.events.get(event) ?? [];
			handlers.push(handler);
			stub.events.set(event, handlers);
		},
		appendEntry: (customType: string, data: unknown) => {
			if (customType === DELEGATION_STATE_ENTRY_TYPE && stub.failDelegationAppendOnce?.(data as DelegationStateRecord)) {
				stub.failDelegationAppendOnce = undefined;
				stub.failedDelegationAppends += 1;
				throw new Error("injected delegation-state append failure");
			}
			stub.entries.push({ type: "custom", customType, data });
			stub.appendCalls.push({ customType, data });
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

function context(root: string, stub: StubAPI): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => stub.entries,
			getSessionFile: () => join(root, "session.jsonl"),
			getSessionId: () => "delegation-v2-review-wiring",
		} as unknown as ExtensionContext["sessionManager"],
		model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" },
		thinkingLevel: "high",
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, confirm: async () => false } as unknown as ExtensionContext["ui"],
		signal: undefined,
	} as unknown as ExtensionContext;
}

async function fireSessionStart(stub: StubAPI, ctx: ExtensionContext): Promise<void> {
	for (const handler of stub.events.get("session_start") ?? []) {
		await handler({ reason: "reload" }, ctx);
	}
}

async function persistCompact(stub: StubAPI, ctx: ExtensionContext): Promise<void> {
	for (const handler of stub.events.get("session_before_compact") ?? []) {
		await handler({
			type: "session_before_compact",
			preparation: {},
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, ctx);
	}
}

function tool(stub: StubAPI, name: string): RuntimeTool {
	const value = stub.tools.get(name);
	assert.ok(value, `${name} is registered`);
	return value as RuntimeTool;
}

function text(result: RuntimeResult): string {
	return result.content.map((item) => item.text).join("\n");
}

function at(second: number): string {
	return `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
}

async function git(root: string, args: string[]): Promise<void> {
	const result = await spawnExec("git", args, { cwd: root });
	assert.equal(result.code, 0, result.stderr || result.stdout);
}

async function initRepo(root: string, paths: readonly string[]): Promise<void> {
	await git(root, ["init", "-q"]);
	await git(root, ["config", "user.email", "review-wiring@example.invalid"]);
	await git(root, ["config", "user.name", "Review Wiring"]);
	await writeConfigFile(root, "project.yaml", "name: delegation-v2-review-wiring\nprofile: generic\n");
	await writeFile(join(root, ".gitignore"), [
		`${CONFIG_DIR_NAME}/workbench/runs/`,
		`${CONFIG_DIR_NAME}/workbench/delegations/`,
		"",
	].join("\n"));
	for (const path of paths) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), `baseline:${path}\n`);
	}
	await git(root, ["add", "--", ...paths, ".gitignore", `${CONFIG_DIR_NAME}/workbench/project.yaml`]);
	await git(root, ["commit", "-q", "-m", "baseline"]);
}

function cas(state: DelegationTransactionRecord, second: number) {
	return {
		delegation_id: state.delegation_id,
		contract_hash: state.contract_hash,
		worker_identity: { ...state.worker_identity },
		expected_generation: state.generation,
		expected_revision: state.revision,
		now: at(second),
	};
}

interface V2Fixture {
	id: string;
	afterHash: string;
	state: DelegationTransactionRecord;
}

async function seedV2(root: string, paths: string[] = ["src/a.ts"]): Promise<V2Fixture> {
	await initRepo(root, paths);
	const contract = bindDelegationBoundedTaskContractV2({
		task_kind: "implementation",
		task: "change the bounded review fixture",
		allowed_paths: ["src/**"],
		acceptance_criteria: ["review the actual diff"],
		verification: [],
		timeout_seconds: 600,
		budget_profile: "standard",
	});
	assert.equal(contract.ok, true);
	if (!contract.ok) throw new Error("contract setup failed");
	const prepared = await persistPreparedDelegationTransaction(root, {
		delegation_id: ID,
		task_kind: "implementation",
		contract_hash: contract.value.contract_hash,
		allowed_paths: contract.value.allowed_paths,
		worker_identity: { ...IDENTITY },
		generation: 1,
		now: at(0),
	});
	assert.equal(prepared.ok, true);
	if (!prepared.ok) throw new Error("prepare failed");
	const lifecyclePrepared = await prepareDelegationChangeSetLifecycleV2({
		project_root: root, delegation_id: ID, contract_hash: contract.value.contract_hash,
		dependency_paths: [], exec: spawnExec,
	});
	assert.equal(lifecyclePrepared.ok, true);
	if (!lifecyclePrepared.ok) throw new Error("lifecycle prepare failed");
	const running = await persistRunningDelegationTransaction(root, cas(prepared.value, 1));
	assert.equal(running.ok, true);
	if (!running.ok) throw new Error("start failed");
	let revision = 0;
	for (let index = 0; index < paths.length; index += 1) {
		const path = paths[index]!;
		const operationId = (index + 1).toString(16).padStart(64, "0");
		const begun = await beginWriteJournalOperation({
			project_root: root, delegation_id: ID, contract_hash: contract.value.contract_hash,
			expected_revision: revision, operation_id: operationId, kind: "write", path,
		});
		assert.equal(begun.ok, true);
		if (!begun.ok) throw new Error("journal begin failed");
		revision = begun.value.revision;
		await writeFile(join(root, path), `worker:${path}\n`);
		const completed = await completeWriteJournalOperation({
			project_root: root, delegation_id: ID, contract_hash: contract.value.contract_hash,
			expected_revision: revision, operation_id: operationId, kind: "write", path, outcome: "succeeded",
		});
		assert.equal(completed.ok, true);
		if (!completed.ok) throw new Error("journal completion failed");
		revision = completed.value.revision;
	}
	const lifecycle = await finalizeDelegationChangeSetLifecycleV2({
		prepared: lifecyclePrepared.value,
		observation: { state: "complete", tool: "write", outcome: "succeeded", code: "none", revision },
		exec: spawnExec,
	});
	assert.equal(lifecycle.ok, true);
	if (!lifecycle.ok) throw new Error("lifecycle finalize failed");
	const workspace = deriveFinalizedDelegationWorkspaceFactsV2(lifecycle.value);
	assert.equal(workspace.ok, true);
	if (!workspace.ok) throw new Error("workspace fact derivation failed");
	const changedPaths = lifecycle.value.change_set.worker_delta.map((entry) => entry.path);
	const outcome: DelegationTerminalOutcome = {
		delegation_id: ID,
		task_kind: "implementation",
		worker_identity: { ...IDENTITY },
		provider_success: true,
		exit_code: 0,
		report_complete: true,
		terminal_facts_complete: true,
		scope_complete: true,
		change_set_status: lifecycle.value.change_set.status,
		changed_paths: [...changedPaths],
		successful_write_count: changedPaths.length,
		denied_write_count: 0,
		delta_hash: lifecycle.value.change_set.worker_delta_hash,
	};
	const committing = await persistCommittingDelegationTransaction(root, { ...cas(running.value, 2), outcome });
	assert.equal(committing.ok, true);
	if (!committing.ok) throw new Error("commit begin failed");
	const report = `## Completed\n- done\n## Files Changed\n${changedPaths.map((path) => `- ${path}`).join("\n")}\n## Verification\n- facts\n## Remaining Risks\n- none\n`;
	const built = buildDelegationCommittedArtifactsV2({
		transaction: committing.value, contract: contract.value, before: workspace.value.before, after: workspace.value.after,
		changeSetLifecycle: lifecycle.value, worker: workerFacts(report), reportText: report,
	});
	assert.equal(built.ok, true);
	if (!built.ok) throw new Error("artifact build failed");
	const records = built.value.records;
	const committed = await commitDelegationGeneration(root, { ...cas(committing.value, 3), records });
	assert.equal(committed.ok, true);
	if (!committed.ok) throw new Error("commit failed");
	return { id: ID, afterHash: workspace.value.after.diffHash, state: committed.value };
}

function stateEntry(id: string, diffHash: string, status: "PENDING_REVIEW" | "REVIEWED" | "STALE" = "PENDING_REVIEW") {
	return {
		type: "custom" as const,
		customType: DELEGATION_STATE_ENTRY_TYPE,
		data: serializeDelegationState({
			latestId: id,
			status,
			currentDiffHash: diffHash,
			reviewedDiffHash: status === "PENDING_REVIEW" ? undefined : diffHash,
			blockedWriteAttempts: 0,
			updatedAt: NOW,
		}),
	};
}

function latestState(stub: StubAPI): DelegationStateRecord {
	const value = [...stub.entries].reverse().find((entry) => entry.customType === DELEGATION_STATE_ENTRY_TYPE)?.data;
	assert.ok(value);
	return value as DelegationStateRecord;
}

function latestCompact(stub: StubAPI): CompactState {
	const value = [...stub.appendCalls].reverse().find((entry) => entry.customType === COMPACT_STATE_ENTRY_TYPE)?.data;
	assert.ok(value);
	return value as CompactState;
}

function workerFacts(report = "## Completed\n- done\n## Files Changed\n- src/legacy.ts\n## Verification\n- facts\n## Remaining Risks\n- none\n"): LedgerWorkerFacts {
	return {
		provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, status: "success", exitCode: 0, turns: 1,
		stopReason: "done", errorMessage: null,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		cacheHitRatio: null,
		budget: { maxContextTokens: 400_000, maxContextRatio: 0.4, softBudgetReached: false, hardBudgetExceeded: false, compactionCount: 0, compactionReasons: [] },
		spendProfile: "standard", spendState: { turns: 1, totalTokens: 2, outputTokens: 1 }, spendBand: "ok",
		spendReasons: [], spendSoftReached: { turns: false, totalTokens: false, outputTokens: false },
		spendHardExceeded: { turns: false, totalTokens: false, outputTokens: false },
		reportSummary: report,
	};
}

async function seedLegacy(root: string, initialize = true): Promise<{ id: string; afterHash: string }> {
	if (initialize) await initRepo(root, ["src/base.ts"]);
	const before = await collectGitFacts(root, spawnExec);
	const created = await createDelegationLedger(root, ID, {
		task: "legacy review", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 600,
	}, before, NOW);
	assert.equal(created.ok, true);
	await writeFile(join(root, "src/legacy.ts"), "legacy worker change\n");
	const after = await collectAfterFacts(root, before, spawnExec);
	const finished = await finishDelegationLedger(root, ID, { after, worker: workerFacts(), now: NOW });
	assert.equal(finished.ok, true);
	return { id: ID, afterHash: after.diffHash };
}

async function runtimeFor(root: string, entry: ReturnType<typeof stateEntry>): Promise<{ stub: StubAPI & ExtensionAPI; ctx: ExtensionContext }> {
	const stub = makeStub();
	stub.entries.push(entry);
	workbenchRuntime(stub);
	const ctx = context(root, stub);
	await fireSessionStart(stub, ctx);
	return { stub, ctx };
}

async function latestGateRecord(root: string): Promise<Record<string, unknown>> {
	const runs = join(root, CONFIG_DIR_NAME, "workbench", "runs");
	const names = (await readdir(runs)).sort();
	assert.ok(names.length > 0);
	return JSON.parse(await readFile(join(runs, names.at(-1)!, "gates.json"), "utf8")) as Record<string, unknown>;
}

before(() => {
	for (const name of [WORKER_ROLE_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ALLOWED_PATHS_ENV, WORKER_TASK_KIND_ENV, WORKER_SPEND_PROFILE_ENV]) {
		delete process.env[name];
	}
});

test("registered review is v2-first, finalizes without top-level v1 files, and feeds status plus gate facts", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedV2(root);
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		assert.deepEqual([...stub.tools.keys()], [...NATIVE_OVERRIDE_NAMES, ...WORKBENCH_TOOL_NAMES]);
		assert.deepEqual(
			(stub.tools.get("workbench_review_worker_diff") as { parameters: unknown }).parameters,
			WORKBENCH_TOOL_PARAMETERS.workbench_review_worker_diff,
			"review tool schema is unchanged",
		);
		const review = await tool(stub, "workbench_review_worker_diff").execute(
			"v2-final", { delegation_id: fixture.id }, undefined, undefined, ctx,
		);
		assert.equal(review.details.ok, true, text(review));
		assert.equal(review.details.authority_version, 2);
		assert.equal(review.details.finalized, true);
		assert.equal(review.details.review_status, "REVIEWED");
		assert.match(String(review.details.review_record), /\/v2\/review\.json$/);
		assert.equal(latestState(stub).status, "REVIEWED");
		assert.equal(
			await readFile(join(root, CONFIG_DIR_NAME, "workbench", "delegations", fixture.id, "review.json"), "utf8").catch(() => null),
			null,
			"v2 review never writes the legacy top-level review file",
		);
		const strict = await readDelegationReviewV2(root, fixture.id);
		assert.equal(strict.ok, true);
		if (strict.ok) assert.equal(strict.value.finalized, true);
		const reviewBound = strict.ok ? strict.value.review.bound_diff_hash : "";

		const status = await tool(stub, "workbench_delegation_status").execute("v2-status", {}, undefined, undefined, ctx);
		assert.match(text(status), /authority v2 : transaction REVIEWED/);
		assert.match(text(status), /review v2\s+: PASS .*\(FINAL\)/);
		assert.match(text(status), /review path\s+: .*\/v2\/review\.json/);
		assert.match(text(status), new RegExp(`review bound\\s+: ${reviewBound}`));

		await tool(stub, "workbench_run_gate").execute("v2-gate", { gates: "b6" }, undefined, undefined, ctx);
		const record = await latestGateRecord(root);
		const gate = (record.gates as Array<Record<string, unknown>>).find((candidate) => candidate.id === "b6");
		assert.ok(gate);
		const check = (gate.checks as Array<Record<string, unknown>>).find((candidate) => candidate.check_id === "b6.6");
		assert.ok(check);
		assert.equal(check.status, "PASS");
		assert.match(JSON.stringify(check.evidence), /latest review PASS/);
	});
});

test("segmented v2 review stays provisional, and a stale REVIEWED session cannot make its gate facts authoritative", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedV2(root, ["src/a.ts", "src/b.ts"]);
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		const reviewTool = tool(stub, "workbench_review_worker_diff");
		const first = await reviewTool.execute(
			"v2-segment-a", { delegation_id: fixture.id, include_paths: ["src/a.ts"] }, undefined, undefined, ctx,
		);
		assert.equal(first.details.ok, true);
		assert.equal(first.details.finalized, false);
		assert.equal(first.details.coverage_complete, false);
		assert.equal(first.details.review_status, "PENDING_REVIEW");
		const provisional = await readDelegationReviewV2(root, fixture.id);
		assert.equal(provisional.ok, true);
		if (provisional.ok) assert.equal(provisional.value.finalized, false);

		// Simulate an old/incorrect session mirror. Gate construction must still
		// consume strict v2 authority and block every worker-first check.
		stub.entries.push(stateEntry(fixture.id, fixture.afterHash, "REVIEWED"));
		await fireSessionStart(stub, ctx);
		const beforeGate = await collectGitFacts(root, spawnExec);
		const beforeGateHash = computeDiffHash(beforeGate.changedPaths, beforeGate.pathDigests, beforeGate.pathStatuses);
		await tool(stub, "workbench_run_gate").execute("v2-provisional-gate", { gates: "b6" }, undefined, undefined, ctx);
		const afterGate = await collectGitFacts(root, spawnExec);
		assert.equal(
			computeDiffHash(afterGate.changedPaths, afterGate.pathDigests, afterGate.pathStatuses),
			beforeGateHash,
			"ignored gate/delegation artifacts must not reset same-diff segmented coverage",
		);
		const record = await latestGateRecord(root);
		const gate = (record.gates as Array<Record<string, unknown>>).find((candidate) => candidate.id === "b6");
		assert.ok(gate);
		const check = (gate.checks as Array<Record<string, unknown>>).find((candidate) => candidate.check_id === "b6.6");
		assert.ok(check);
		assert.equal(check.status, "BLOCKED");
		assert.match(String(check.blocked_reason), /PENDING_REVIEW|STALE|v2 review authority is provisional/);

		const second = await reviewTool.execute(
			"v2-segment-b", { delegation_id: fixture.id, include_paths: ["src/b.ts"] }, undefined, undefined, ctx,
		);
		assert.equal(second.details.ok, true);
		assert.equal(second.details.finalized, true);
		assert.equal(second.details.review_status, "REVIEWED");
	});
});

test("v2 scope failure stops before content and publishes no review while session stays blocking", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedV2(root);
		const outside = join(root, "outside.ts");
		await writeFile(outside, "outside\n");
		await unlink(join(root, "src/a.ts"));
		await symlink(outside, join(root, "src/a.ts"));
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		const result = await tool(stub, "workbench_review_worker_diff").execute(
			"v2-scope-fail", { delegation_id: fixture.id }, undefined, undefined, ctx,
		);
		assert.equal(result.details.ok, false, text(result));
		assert.equal(result.details.authority_version, 2);
		assert.equal(result.details.error, "review_invalid");
		assert.equal(latestState(stub).status, "PENDING_REVIEW");
		const strict = await readDelegationReviewV2(root, fixture.id);
		assert.equal(strict.ok, false);
		if (!strict.ok) assert.equal(strict.error.code, "not_found");
	});
});

test("corrupt v2 refuses public review and status fallback even when a valid legacy ledger is present", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedV2(root);
		await seedLegacy(root, false);
		const legacyReviewPath = join(root, CONFIG_DIR_NAME, "workbench", "delegations", fixture.id, "review.json");
		const legacyBefore = await readFile(legacyReviewPath, "utf8");
		await writeFile(join(root, CONFIG_DIR_NAME, "workbench", "delegations", fixture.id, "v2", "transaction.json"), "{\n");
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		const result = await tool(stub, "workbench_review_worker_diff").execute(
			"v2-corrupt", { delegation_id: fixture.id }, undefined, undefined, ctx,
		);
		assert.equal(result.details.ok, false);
		assert.equal(result.details.authority_version, 2);
		assert.equal(result.details.error, "invalid_record");
		assert.equal(await readFile(legacyReviewPath, "utf8"), legacyBefore, "legacy review file is not consulted or rewritten");
		const status = await tool(stub, "workbench_delegation_status").execute("v2-corrupt-status", {}, undefined, undefined, ctx);
		assert.match(text(status), /(?:authority v2|project auth)\s+: INVALID \(invalid_record\)/);
		assert.doesNotMatch(text(status), /^review\s+:/m, "legacy review verdict is not displayed");
	});
});

test("no v2 root uses the unchanged read-only legacy fallback", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedLegacy(root);
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		const result = await tool(stub, "workbench_review_worker_diff").execute(
			"legacy-review", { delegation_id: fixture.id }, undefined, undefined, ctx,
		);
		assert.equal(result.details.ok, true, text(result));
		assert.equal(result.details.authority_version, 1);
		assert.equal(result.details.review_status, "REVIEWED");
		assert.match(String(result.details.review_record), new RegExp(`${fixture.id}/review\\.json$`));
		assert.doesNotMatch(String(result.details.review_record), /\/v2\//);
		const legacy = JSON.parse(await readFile(join(root, result.details.review_record as string), "utf8")) as Record<string, unknown>;
		assert.equal(legacy.verdict, "PASS");
	});
});

test("final v2 artifact survives a one-shot REVIEWED mirror append failure and replay completes only the mirror", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedV2(root);
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		stub.failDelegationAppendOnce = (state) => state.status === "REVIEWED";
		const reviewTool = tool(stub, "workbench_review_worker_diff");
		const first = await reviewTool.execute("v2-append-fail", { delegation_id: fixture.id }, undefined, undefined, ctx);
		assert.equal(first.details.ok, false);
		assert.equal(first.details.error, "session_persistence_failed");
		assert.equal(first.details.finalized, true);
		assert.equal(stub.failedDelegationAppends, 1);
		assert.equal(latestState(stub).status, "PENDING_REVIEW", "last successful session entry stays blocking");
		const strict = await readDelegationReviewV2(root, fixture.id);
		assert.equal(strict.ok, true);
		if (!strict.ok) return;
		assert.equal(strict.value.finalized, true, "project authority was finalized before the injected session failure");
		const artifactBytes = await readFile(join(root, strict.value.review_path));
		await persistCompact(stub, ctx);
		assert.equal(latestCompact(stub).pendingDelegationReview, true);

		const retry = await reviewTool.execute("v2-append-retry", { delegation_id: fixture.id }, undefined, undefined, ctx);
		assert.equal(retry.details.ok, true, text(retry));
		assert.equal(retry.details.finalized, true);
		assert.equal(latestState(stub).status, "REVIEWED");
		assert.deepEqual(await readFile(join(root, strict.value.review_path)), artifactBytes, "replay never rewrites finalized bytes");
	});
});

test("finalized v2 drift durably appends one STALE mirror, returns review_conflict, and never rewrites the artifact", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedV2(root);
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		const reviewTool = tool(stub, "workbench_review_worker_diff");
		const finalized = await reviewTool.execute("v2-normal-drift-finalize", { delegation_id: fixture.id }, undefined, undefined, ctx);
		assert.equal(finalized.details.ok, true);
		const strict = await readDelegationReviewV2(root, fixture.id);
		assert.equal(strict.ok, true);
		if (!strict.ok) return;
		const artifactBytes = await readFile(join(root, strict.value.review_path));

		await writeFile(join(root, "src/a.ts"), "post-review normal drift\n");
		const drift = await reviewTool.execute("v2-normal-drift", { delegation_id: fixture.id }, undefined, undefined, ctx);
		assert.equal(drift.details.ok, false);
		assert.equal(drift.details.error, "review_conflict");
		assert.equal(latestState(stub).status, "STALE");
		const staleAppends = () => stub.appendCalls.filter((call) =>
			call.customType === DELEGATION_STATE_ENTRY_TYPE && (call.data as DelegationStateRecord).status === "STALE").length;
		assert.equal(staleAppends(), 1);
		assert.deepEqual(await readFile(join(root, strict.value.review_path)), artifactBytes);

		const replay = await reviewTool.execute("v2-normal-drift-replay", { delegation_id: fixture.id }, undefined, undefined, ctx);
		assert.equal(replay.details.ok, false);
		assert.equal(replay.details.error, "review_conflict");
		assert.equal(staleAppends(), 1, "a clean STALE mirror replay must not append a duplicate state entry");
		assert.deepEqual(await readFile(join(root, strict.value.review_path)), artifactBytes);
	});
});

test("finalized v2 drift keeps the artifact immutable and remains STALE in memory/compact when its append fails", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedV2(root);
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		const reviewTool = tool(stub, "workbench_review_worker_diff");
		const finalized = await reviewTool.execute("v2-drift-finalize", { delegation_id: fixture.id }, undefined, undefined, ctx);
		assert.equal(finalized.details.ok, true);
		const strict = await readDelegationReviewV2(root, fixture.id);
		assert.equal(strict.ok, true);
		if (!strict.ok) return;
		const artifactBytes = await readFile(join(root, strict.value.review_path));
		stub.failDelegationAppendOnce = (state) => state.status === "STALE";
		await writeFile(join(root, "src/a.ts"), "post-review drift\n");
		const drift = await reviewTool.execute("v2-drift", { delegation_id: fixture.id }, undefined, undefined, ctx);
		assert.equal(drift.details.ok, false);
		assert.equal(drift.details.error, "session_persistence_failed");
		assert.equal(stub.failedDelegationAppends, 1);
		assert.equal(latestState(stub).status, "REVIEWED", "durable session entry was not falsely reported as STALE");
		await persistCompact(stub, ctx);
		const compact = latestCompact(stub);
		assert.equal(compact.pendingDelegationReview, true, "in-memory compact mirror remains blocking");
		assert.match(compact.nextDelegationAction ?? "", /STALE/);
		assert.deepEqual(await readFile(join(root, strict.value.review_path)), artifactBytes);
		const committed = await readDelegationCommittedGenerationV2(root, fixture.id);
		assert.equal(committed.ok, true);
		if (committed.ok) assert.equal(committed.value.state.status, "REVIEWED", "immutable project authority is unchanged by workspace drift");

		const retry = await reviewTool.execute("v2-drift-heal", { delegation_id: fixture.id }, undefined, undefined, ctx);
		assert.equal(retry.details.ok, false);
		assert.equal(retry.details.error, "review_conflict", "healing the mirror does not turn immutable drift into review success");
		assert.equal(latestState(stub).status, "STALE", "the second call durably heals the exact blocking mirror");
		await persistCompact(stub, ctx);
		const healedCompact = latestCompact(stub);
		assert.equal(healedCompact.pendingDelegationReview, true);
		assert.match(healedCompact.nextDelegationAction ?? "", /STALE/);
		assert.deepEqual(await readFile(join(root, strict.value.review_path)), artifactBytes, "mirror healing never rewrites finalized bytes");
		const afterHeal = await readDelegationCommittedGenerationV2(root, fixture.id);
		assert.equal(afterHeal.ok, true);
		if (afterHeal.ok) assert.equal(afterHeal.value.state.status, "REVIEWED");
	});
});
