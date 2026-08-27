/** S1.1 strict public review/status/gate wiring for delegation transactions v2. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { before, test } from "node:test";

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { reconcileProjectDelegationAuthorityV2 } from "../extensions/workbench-runtime/core/delegation-project-authority.ts";
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
	hasDelegationSemanticRepairAuthorityV2,
	hasDelegationSemanticReviewAuthorityV2,
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
import { collectReviewRelevanceV2 } from "../extensions/workbench-runtime/core/review-relevance-v2.ts";
import { preflightSemanticReviewEnvelopeV1 } from "../extensions/workbench-runtime/core/diff-review.ts";

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

async function seedV2(
	root: string,
	paths: string[] = ["src/a.ts"],
	workerContent: (path: string) => string | Buffer = (path) => `worker:${path}\n`,
): Promise<V2Fixture> {
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
		await writeFile(join(root, path), workerContent(path));
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
		worker_success: true,
		worker_failure_code: null,
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
	const relevance = await collectReviewRelevanceV2({
		project_root: root, delegation_id: ID, contract_hash: contract.value.contract_hash,
		after_guard: lifecycle.value.after_guard, change_set: lifecycle.value.change_set,
		command_provenance: lifecycle.value.command_provenance, exec: spawnExec,
	});
	assert.equal(relevance.ok, true);
	if (!relevance.ok) throw new Error("review relevance setup failed");
	const envelope = await preflightSemanticReviewEnvelopeV1({
		projectRoot: root, workerPaths: changedPaths, allowedPaths: contract.value.allowed_paths,
		afterDigests: workspace.value.after.pathDigests, pathStatuses: workspace.value.after.pathStatuses,
		relevanceProjection: relevance.value.projection, relevanceProjectionHash: relevance.value.binding.projection_hash,
		exec: spawnExec,
	});
	assert.equal(envelope.ok, true, envelope.ok ? "" : envelope.code);
	if (!envelope.ok) throw new Error("review envelope setup failed");
	const built = buildDelegationCommittedArtifactsV2({
		transaction: committing.value, contract: contract.value, before: workspace.value.before, after: workspace.value.after,
		changeSetLifecycle: lifecycle.value, worker: workerFacts(report), reportText: report, reviewEnvelope: envelope.value,
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
		workerSuccess: true, workerFailureCode: null,
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

async function gateRecord(root: string, runId: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(root, CONFIG_DIR_NAME, "workbench", "runs", runId, "gates.json"), "utf8")) as Record<string, unknown>;
}

function semanticAccept(boundDiffHash: string): Record<string, unknown> {
	return {
		delegation_id: ID,
		semantic_decision: "ACCEPT",
		expected_bound_diff_hash: boundDiffHash,
	};
}

function semanticRepair(boundDiffHash: string, repairReason: string): Record<string, unknown> {
	return {
		delegation_id: ID,
		semantic_decision: "REPAIR",
		expected_bound_diff_hash: boundDiffHash,
		repair_reason: repairReason,
	};
}

async function downgradeFinalToHistoricalMechanical(root: string, delegationId: string): Promise<{
	reviewPath: string;
	transactionPath: string;
	boundDiffHash: string;
}> {
	const v2 = join(root, CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2");
	const reviewPath = join(v2, "review.json");
	const transactionPath = join(v2, "transaction.json");
	const artifact = JSON.parse(await readFile(reviewPath, "utf8")) as Record<string, any>;
	const boundDiffHash = String(artifact.review.bound_diff_hash);
	for (const field of [
		"fully_presented_paths", "presentation_remaining_paths", "presentation_complete",
		"presentation_progress",
		"semantic_review", "semantic_acceptance",
	]) delete artifact.review[field];
	for (const entry of artifact.review.patch ?? []) delete entry.page;
	const reviewBytes = `${JSON.stringify(artifact, null, 2)}\n`;
	await writeFile(reviewPath, reviewBytes, "utf8");
	const transaction = JSON.parse(await readFile(transactionPath, "utf8")) as Record<string, any>;
	transaction.review.review_hash = createHash("sha256").update(reviewBytes).digest("hex");
	await writeFile(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`, "utf8");
	return { reviewPath, transactionPath, boundDiffHash };
}

before(() => {
	for (const name of [WORKER_ROLE_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ALLOWED_PATHS_ENV, WORKER_TASK_KIND_ENV, WORKER_SPEND_PROFILE_ENV]) {
		delete process.env[name];
	}
});

test("registered review is v2-first, stays provisional until a second Sol ACCEPT, then feeds status plus gate facts", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedV2(root);
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		assert.deepEqual([...stub.tools.keys()], [...NATIVE_OVERRIDE_NAMES, ...WORKBENCH_TOOL_NAMES]);
		assert.deepEqual(
			(stub.tools.get("workbench_review_worker_diff") as { parameters: unknown }).parameters,
			WORKBENCH_TOOL_PARAMETERS.workbench_review_worker_diff,
			"review tool schema is unchanged",
		);
		const reviewTool = tool(stub, "workbench_review_worker_diff");
		const review = await reviewTool.execute(
			"v2-final", { delegation_id: fixture.id }, undefined, undefined, ctx,
		);
		assert.equal(review.details.ok, true, text(review));
		assert.equal(review.details.authority_version, 2);
		assert.equal(review.details.finalized, false);
		assert.equal(review.details.review_status, "PENDING_REVIEW");
		assert.equal(review.details.review_kind, "scope_integrity");
		assert.equal(review.details.semantic_review, "required");
		assert.equal(review.details.gate_authority, false);
		assert.match(String(review.details.review_record), /\/v2\/review\.json$/);
		assert.equal(latestState(stub).status, "PENDING_REVIEW");
		assert.equal(
			await readFile(join(root, CONFIG_DIR_NAME, "workbench", "delegations", fixture.id, "review.json"), "utf8").catch(() => null),
			null,
			"v2 review never writes the legacy top-level review file",
		);
		const strict = await readDelegationReviewV2(root, fixture.id);
		assert.equal(strict.ok, true);
		if (strict.ok) {
			assert.equal(strict.value.finalized, false);
			assert.equal(strict.value.review.semantic_review, "required");
			assert.equal(strict.value.review.semantic_acceptance, undefined);
		}
		const reviewBound = strict.ok ? strict.value.review.bound_diff_hash : "";
		const accepted = await reviewTool.execute("v2-accept", semanticAccept(reviewBound), undefined, undefined, ctx);
		assert.equal(accepted.details.ok, true, text(accepted));
		assert.equal(accepted.details.finalized, true);
		assert.equal(accepted.details.review_status, "REVIEWED");
		assert.equal(accepted.details.semantic_review, "accepted");
		assert.equal(accepted.details.gate_authority, false);
		assert.equal(latestState(stub).status, "REVIEWED");
		const finalized = await readDelegationReviewV2(root, fixture.id);
		assert.equal(finalized.ok, true);
		if (finalized.ok) {
			assert.equal(finalized.value.finalized, true);
			assert.equal(finalized.value.review.semantic_acceptance?.expected_bound_diff_hash, reviewBound);
			assert.equal(finalized.value.review.semantic_acceptance?.reviewer.model, "gpt-5.6-sol");
		}

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

test("registered review resumes a 14 KiB ordinary source page and only then permits Sol ACCEPT", async () => {
	await withTempDir(async (root) => {
		const source = Array.from({ length: 357 }, (_, index) =>
			`def test_page_${String(index).padStart(3, "0")}(): assert ${index} >= 0  # page`,
		).join("\n") + "\n";
		const fixture = await seedV2(root, ["src/large.py"], () => source);
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		const reviewTool = tool(stub, "workbench_review_worker_diff");
		const selection = { delegation_id: fixture.id, include_paths: ["src/large.py"] };

		const first = await reviewTool.execute("v2-page-1", selection, undefined, undefined, ctx);
		assert.equal(first.details.ok, true, text(first));
		assert.equal(first.details.presentation_complete, false);
		assert.deepEqual(first.details.next_include_paths, ["src/large.py"]);
		assert.match(text(first), /page bytes 0-/);
		assert.equal(latestState(stub).status, "PENDING_REVIEW");

		const second = await reviewTool.execute("v2-page-2", selection, undefined, undefined, ctx);
		assert.equal(second.details.ok, true, text(second));
		assert.equal(second.details.presentation_complete, true);
		assert.deepEqual(second.details.next_include_paths, []);
		assert.match(text(second), /complete across contiguous hash-bound pages/);
		assert.equal(latestState(stub).status, "PENDING_REVIEW");

		const accepted = await reviewTool.execute(
			"v2-page-accept",
			semanticAccept(String(second.details.bound_diff_hash)),
			undefined,
			undefined,
			ctx,
		);
		assert.equal(accepted.details.ok, true, text(accepted));
		assert.equal(accepted.details.finalized, true);
		assert.equal(accepted.details.review_status, "REVIEWED");
		const strict = await readDelegationReviewV2(root, fixture.id);
		assert.equal(strict.ok, true);
		if (strict.ok) {
			assert.equal(strict.value.review.presentation_progress?.[0]?.next_byte,
				strict.value.review.presentation_progress?.[0]?.total_bytes);
			assert.equal(strict.value.review.semantic_review, "accepted");
		}
	});
});

test("historical mechanical FINAL migrates by complete Sol presentation plus two-hash ACCEPT", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedV2(root);
		const firstRuntime = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		const firstReviewTool = tool(firstRuntime.stub, "workbench_review_worker_diff");
		const initialPresented = await firstReviewTool.execute("historical-present", { delegation_id: fixture.id }, undefined, undefined, firstRuntime.ctx);
		const accepted = await firstReviewTool.execute(
			"historical-accept",
			semanticAccept(String(initialPresented.details.bound_diff_hash)),
			undefined,
			undefined,
			firstRuntime.ctx,
		);
		assert.equal(accepted.details.ok, true, text(accepted));

		const historical = await downgradeFinalToHistoricalMechanical(root, fixture.id);
		const immutableReview = await readFile(historical.reviewPath);
		const immutableTransaction = await readFile(historical.transactionPath);
		const strictHistorical = await readDelegationReviewV2(root, fixture.id);
		assert.equal(strictHistorical.ok, true, strictHistorical.ok ? "" : strictHistorical.error.code);
		if (strictHistorical.ok) assert.equal(strictHistorical.value.review.semantic_acceptance, undefined);

		// Model the real upgrade case: a later commit materialised exactly the
		// already-reviewed worker bytes and did not touch any fifth path.
		await git(root, ["add", "--", "src/a.ts"]);
		await git(root, ["commit", "-q", "-m", "materialize reviewed worker delta"]);
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, historical.boundDiffHash));
		const status = await tool(stub, "workbench_delegation_status").execute("historical-status", {}, undefined, undefined, ctx);
		assert.match(text(status), /latest\s+: .* PENDING_REVIEW/);
		assert.match(text(status), /review v2\s+: PASS .*\(FINAL\)/);
		assert.match(text(status), /semantic v2\s+: MISSING .*not hash-bound Sol ACCEPT/);
		assert.match(text(status), /call workbench_review_worker_diff without a decision/);
		const historicalRepair = await tool(stub, "workbench_delegate_worker").execute(
			"historical-mechanical-repair-refused",
			{
				task: "Do not erase an unaccepted historical review.",
				task_kind: "diagnosis",
				allowed_paths: ["src/**"],
				acceptance_criteria: ["Historical authority remains blocking."],
				verification: [],
				timeout_seconds: 60,
				repair_of: fixture.id,
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(historicalRepair.details.ok, false);
		assert.equal(historicalRepair.details.caller_contract_ignored, true);
		assert.match(text(historicalRepair), /recovery refused|authority unavailable/u);

		const reviewTool = tool(stub, "workbench_review_worker_diff");
		const presented = await reviewTool.execute(
			"historical-migration-present", { delegation_id: fixture.id }, undefined, undefined, ctx,
		);
		assert.equal(presented.details.ok, true, text(presented));
		assert.equal(presented.details.review_status, "PENDING_REVIEW");
		assert.equal(presented.details.semantic_review, "required");
		assert.match(text(presented), /semantic migration: REQUIRED/);
		assert.match(text(presented), /migration decision: .*ACCEPT must bind both/);
		const migrationBinding = String(presented.details.migration_binding_hash);
		assert.match(migrationBinding, /^[0-9a-f]{64}$/u);
		assert.equal(latestState(stub).status, "PENDING_REVIEW");

		const acceptedMigration = await reviewTool.execute("historical-migration-accept", {
			delegation_id: fixture.id,
			semantic_decision: "ACCEPT",
			expected_bound_diff_hash: historical.boundDiffHash,
			expected_migration_binding_hash: migrationBinding,
		}, undefined, undefined, ctx);
		assert.equal(acceptedMigration.details.ok, true, text(acceptedMigration));
		assert.equal(acceptedMigration.details.review_status, "REVIEWED");
		assert.equal(acceptedMigration.details.semantic_review, "accepted");
		assert.equal(acceptedMigration.details.migration_binding_hash, migrationBinding);
		assert.equal(latestState(stub).status, "REVIEWED");
		assert.deepEqual(await readFile(historical.reviewPath), immutableReview, "historical review bytes remain immutable");
		assert.deepEqual(await readFile(historical.transactionPath), immutableTransaction, "historical transaction bytes remain immutable");
		const deferredDifferentMirror = await reconcileProjectDelegationAuthorityV2({
			project_root: root,
			current_state: {
				latestId: "20260817-185959-oldx",
				status: "REVIEWED",
				currentDiffHash: "1".repeat(64),
				reviewedDiffHash: "1".repeat(64),
				blockedWriteAttempts: 3,
				updatedAt: NOW,
			},
			now: at(9),
			exec: spawnExec,
			defer_reviewed_freshness: true,
		});
		assert.equal(deferredDifferentMirror.ok, true);
		if (deferredDifferentMirror.ok) {
			assert.equal(deferredDifferentMirror.state?.latestId, fixture.id);
			assert.equal(deferredDifferentMirror.state?.status, "PENDING_REVIEW", "defer never promotes a different session mirror before review freshness succeeds");
			assert.equal(deferredDifferentMirror.state?.reviewedDiffHash, undefined);
			assert.equal(deferredDifferentMirror.state?.blockedWriteAttempts, 3);
		}

		const reloaded = await runtimeFor(root, stateEntry(fixture.id, historical.boundDiffHash));
		const reloadedStatus = await tool(reloaded.stub, "workbench_delegation_status").execute(
			"historical-migration-reload", {}, undefined, undefined, reloaded.ctx,
		);
		assert.equal(latestState(reloaded.stub).status, "REVIEWED");
		assert.equal(latestState(reloaded.stub).currentDiffHash, migrationBinding);
		assert.equal(latestState(reloaded.stub).reviewedDiffHash, migrationBinding);
		assert.match(text(reloadedStatus), /semantic v2\s+: ACCEPT \(migration\)/);
		assert.match(text(reloadedStatus), new RegExp(migrationBinding));
		await persistCompact(reloaded.stub, reloaded.ctx);
		assert.equal(latestCompact(reloaded.stub).pendingDelegationReview, undefined);
		assert.equal(latestCompact(reloaded.stub).reviewedDiffHash, migrationBinding);
		const acceptedGateResult = await tool(reloaded.stub, "workbench_run_gate").execute(
			"historical-migration-gate", { gates: "b6" }, undefined, undefined, reloaded.ctx,
		);
		const acceptedGateRecord = await gateRecord(root, String(acceptedGateResult.details.run_id));
		const acceptedGate = (acceptedGateRecord.gates as Array<Record<string, unknown>>)
			.find((candidate) => candidate.id === "b6");
		const acceptedReviewCheck = (acceptedGate?.checks as Array<Record<string, unknown>> | undefined)
			?.find((candidate) => candidate.check_id === "b6.6");
		assert.equal(acceptedReviewCheck?.status, "PASS");

		await chmod(join(root, "src/a.ts"), 0o755);
		const driftedReview = await tool(reloaded.stub, "workbench_review_worker_diff").execute(
			"historical-migration-review-after-drift", { delegation_id: fixture.id }, undefined, undefined, reloaded.ctx,
		);
		assert.equal(driftedReview.details.ok, false);
		assert.equal(driftedReview.details.error, "review_conflict");
		assert.match(String(driftedReview.details.binding_hash), /^[0-9a-f]{64}$/u);
		assert.notEqual(driftedReview.details.binding_hash, migrationBinding);
		assert.notEqual(driftedReview.details.next_action, "workbench_review_worker_diff");
		assert.match(text(driftedReview), /accepted historical semantic migration is stale.*fresh successor delegation/);
		assert.equal(latestState(reloaded.stub).status, "STALE", "review itself must persist accepted migration drift fail-closed");
		const driftedStatus = await tool(reloaded.stub, "workbench_delegation_status").execute(
			"historical-migration-mode-drift", {}, undefined, undefined, reloaded.ctx,
		);
		assert.equal(latestState(reloaded.stub).status, "STALE", "an unreviewed executable-bit change must invalidate migration authority");
		assert.match(text(driftedStatus), /latest\s+: .* STALE/);
		await persistCompact(reloaded.stub, reloaded.ctx);
		assert.equal(latestCompact(reloaded.stub).pendingDelegationReview, true);
		assert.equal(latestCompact(reloaded.stub).reviewedDiffHash, migrationBinding);
		const staleGateResult = await tool(reloaded.stub, "workbench_run_gate").execute(
			"historical-migration-stale-gate", { gates: "b6" }, undefined, undefined, reloaded.ctx,
		);
		const staleGateRecord = await gateRecord(root, String(staleGateResult.details.run_id));
		const staleGate = (staleGateRecord.gates as Array<Record<string, unknown>>)
			.find((candidate) => candidate.id === "b6");
		const staleReviewCheck = (staleGate?.checks as Array<Record<string, unknown>> | undefined)
			?.find((candidate) => candidate.check_id === "b6.6");
		assert.equal(staleReviewCheck?.status, "BLOCKED");
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
		assert.equal(second.details.finalized, false);
		assert.equal(second.details.presentation_complete, true);
		assert.equal(second.details.review_status, "PENDING_REVIEW");
		const accepted = await reviewTool.execute(
			"v2-segment-accept", semanticAccept(String(second.details.bound_diff_hash)), undefined, undefined, ctx,
		);
		assert.equal(accepted.details.ok, true, text(accepted));
		assert.equal(accepted.details.finalized, true);
		assert.equal(accepted.details.semantic_review, "accepted");
		assert.equal(accepted.details.review_status, "REVIEWED");
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

test("registered semantic ACCEPT rejects first-call, incomplete, hash-mismatch, and non-Sol requests without publishing", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedV2(root, ["src/a.ts", "src/b.ts"]);
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		const reviewTool = tool(stub, "workbench_review_worker_diff");
		const direct = await reviewTool.execute("v2-direct-accept", semanticAccept("a".repeat(64)), undefined, undefined, ctx);
		assert.equal(direct.details.ok, false);
		assert.equal(direct.details.error, "review_invalid");

		const partial = await reviewTool.execute(
			"v2-partial-present", { delegation_id: fixture.id, include_paths: ["src/a.ts"] }, undefined, undefined, ctx,
		);
		assert.equal(partial.details.ok, true, text(partial));
		assert.equal(partial.details.presentation_complete, false);
		const incomplete = await reviewTool.execute(
			"v2-partial-accept", semanticAccept(String(partial.details.bound_diff_hash)), undefined, undefined, ctx,
		);
		assert.equal(incomplete.details.ok, false);
		assert.equal(incomplete.details.error, "review_invalid");

		const wrongHash = await reviewTool.execute("v2-wrong-hash", semanticAccept("f".repeat(64)), undefined, undefined, ctx);
		assert.equal(wrongHash.details.ok, false);
		assert.equal(wrongHash.details.error, "review_conflict");

		const nonSolCtx = {
			...ctx,
			model: { provider: "openai-codex", id: "gpt-5.6-luna", api: "responses" },
		} as unknown as ExtensionContext;
		const nonSol = await reviewTool.execute(
			"v2-non-sol", semanticAccept(String(partial.details.bound_diff_hash)), undefined, undefined, nonSolCtx,
		);
		assert.equal(nonSol.details.ok, false);
		assert.equal(nonSol.details.error, "semantic_accept_requires_sol");

		const strict = await readDelegationReviewV2(root, fixture.id);
		assert.equal(strict.ok, true);
		if (strict.ok) {
			assert.equal(strict.value.finalized, false);
			assert.equal(strict.value.review.semantic_acceptance, undefined);
		}
		assert.equal(latestState(stub).status, "PENDING_REVIEW");
	});
});

test("registered semantic REPAIR exposes deterministic q-repair guidance while strict review and Gate authority stay blocked", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedV2(root);
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		const reviewTool = tool(stub, "workbench_review_worker_diff");
		const presented = await reviewTool.execute(
			"v2-repair-present", { delegation_id: fixture.id }, undefined, undefined, ctx,
		);
		assert.equal(presented.details.ok, true, text(presented));
		assert.equal(presented.details.presentation_complete, true);
		const boundHash = String(presented.details.bound_diff_hash);
		const reason = "Canonicalize JSON before hashing, use max normalized latency, and fix the Rust float type.";

		const repair = await reviewTool.execute(
			"v2-repair-decide", semanticRepair(boundHash, reason), undefined, undefined, ctx,
		);
		assert.equal(repair.details.ok, true, text(repair));
		assert.equal(repair.details.finalized, false);
		assert.equal(repair.details.review_status, "PENDING_REVIEW");
		assert.equal(repair.details.semantic_review, "repair_required");
		assert.equal(repair.details.gate_authority, false);
		assert.equal(repair.details.repair_of, fixture.id);
		assert.equal(repair.details.next_action, `call workbench_repair_delegation with delegation_id=${fixture.id}`);
		assert.match(String(repair.details.repair_decision_hash), /^[0-9a-f]{64}$/u);
		assert.match(String(repair.details.repair_reason_hash), /^[0-9a-f]{64}$/u);
		assert.match(text(repair), new RegExp(`workbench_repair_delegation with delegation_id=${fixture.id}`));
		assert.equal(latestState(stub).status, "PENDING_REVIEW");

		const strict = await readDelegationReviewV2(root, fixture.id);
		assert.equal(strict.ok, true, strict.ok ? "" : JSON.stringify(strict.error));
		if (strict.ok) {
			assert.equal(strict.value.finalized, false);
			assert.equal(strict.value.state.status, "PENDING_REVIEW");
			assert.equal(strict.value.semantic_repair?.repair_reason, reason);
			assert.equal(strict.value.semantic_repair?.expected_bound_diff_hash, boundHash);
			assert.equal(hasDelegationSemanticRepairAuthorityV2(strict.value), true);
			assert.equal(hasDelegationSemanticReviewAuthorityV2(strict.value), false);
		}
		const repairStatus = await tool(stub, "workbench_delegation_status").execute(
			"v2-repair-status", {}, undefined, undefined, ctx,
		);
		assert.match(text(repairStatus), new RegExp(`next action\\s+: call workbench_repair_delegation with delegation_id=${fixture.id}`));
		assert.match(text(repairStatus), new RegExp(`repair route\\s+: ALLOWED .*workbench_repair_delegation with delegation_id=${fixture.id}`));
		assert.doesNotMatch(text(repairStatus), /call workbench_delegate_worker with repair_of/u);
		assert.doesNotMatch(text(repairStatus), /blocked\s+: Starting a new worker delegation/u);

		const gateResult = await tool(stub, "workbench_run_gate").execute(
			"v2-repair-gate", { gates: "b6" }, undefined, undefined, ctx,
		);
		const record = await gateRecord(root, String(gateResult.details.run_id));
		const gate = (record.gates as Array<Record<string, unknown>>).find((candidate) => candidate.id === "b6");
		const check = (gate?.checks as Array<Record<string, unknown>> | undefined)
			?.find((candidate) => candidate.check_id === "b6.6");
		assert.equal(check?.status, "BLOCKED");
		assert.match(String(check?.blocked_reason), /PENDING_REVIEW|provisional|semantic/i);
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
		assert.equal(result.details.review_status, "PENDING_REVIEW");
		assert.equal(result.details.semantic_review, "required");
		assert.match(String(result.details.review_record), new RegExp(`${fixture.id}/review\\.json$`));
		assert.doesNotMatch(String(result.details.review_record), /\/v2\//);
		const legacy = JSON.parse(await readFile(join(root, result.details.review_record as string), "utf8")) as Record<string, unknown>;
		assert.equal(legacy.verdict, "PASS");
		const refused = await tool(stub, "workbench_review_worker_diff").execute(
			"legacy-accept", semanticAccept(String(result.details.bound_diff_hash)), undefined, undefined, ctx,
		);
		assert.equal(refused.details.ok, false);
		assert.equal(refused.details.error, "semantic_accept_requires_v2");
		assert.equal(latestState(stub).status, "PENDING_REVIEW");
	});
});

test("final v2 artifact remains a successful durable ACCEPT when the REVIEWED mirror append fails", async () => {
	await withTempDir(async (root) => {
		const fixture = await seedV2(root);
		const { stub, ctx } = await runtimeFor(root, stateEntry(fixture.id, fixture.afterHash));
		const reviewTool = tool(stub, "workbench_review_worker_diff");
		const presented = await reviewTool.execute("v2-append-present", { delegation_id: fixture.id }, undefined, undefined, ctx);
		assert.equal(presented.details.ok, true, text(presented));
		assert.equal(presented.details.finalized, false);
		stub.failDelegationAppendOnce = (state) => state.status === "REVIEWED";
		const acceptance = semanticAccept(String(presented.details.bound_diff_hash));
		const first = await reviewTool.execute("v2-append-fail", acceptance, undefined, undefined, ctx);
		assert.equal(first.details.ok, true, text(first));
		assert.equal(first.details.finalized, true);
		assert.deepEqual(first.details.session_mirror_warning, {
			code: "session_mirror_append_failed",
			message: "durable review succeeded; session mirror append failed and will be reconciled from durable authority",
			durable_readback: "confirmed",
			durable_transaction_status: "REVIEWED",
			durable_review_finalized: true,
		});
		assert.match(text(first), /WARNING: durable review succeeded; session mirror append failed/u);
		assert.equal(stub.failedDelegationAppends, 1);
		assert.equal(latestState(stub).status, "PENDING_REVIEW", "failed append does not invent a persisted session entry");
		const strict = await readDelegationReviewV2(root, fixture.id);
		assert.equal(strict.ok, true);
		if (!strict.ok) return;
		assert.equal(strict.value.finalized, true, "project authority was finalized before the injected session failure");
		const artifactBytes = await readFile(join(root, strict.value.review_path));
		await persistCompact(stub, ctx);
		assert.notEqual(latestCompact(stub).pendingDelegationReview, true, "compact projection follows durable authority held in memory");

		const retry = await reviewTool.execute("v2-append-retry", acceptance, undefined, undefined, ctx);
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
		const presented = await reviewTool.execute("v2-normal-drift-present", { delegation_id: fixture.id }, undefined, undefined, ctx);
		assert.equal(presented.details.ok, true);
		const finalized = await reviewTool.execute("v2-normal-drift-finalize", semanticAccept(String(presented.details.bound_diff_hash)), undefined, undefined, ctx);
		assert.equal(finalized.details.ok, true, text(finalized));
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
		const presented = await reviewTool.execute("v2-drift-present", { delegation_id: fixture.id }, undefined, undefined, ctx);
		assert.equal(presented.details.ok, true);
		const finalized = await reviewTool.execute("v2-drift-finalize", semanticAccept(String(presented.details.bound_diff_hash)), undefined, undefined, ctx);
		assert.equal(finalized.details.ok, true, text(finalized));
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
