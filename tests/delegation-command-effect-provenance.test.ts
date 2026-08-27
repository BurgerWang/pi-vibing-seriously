import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
	beginRecipeCommandEffectCapture,
	completeRecipeCommandEffectCapture,
	type CommandEffectRecord,
} from "../extensions/workbench-runtime/core/command-effect.ts";
import {
	buildWorkerCommandEffectEntryFromToolResult,
	EMPTY_WORKER_COMMAND_EFFECT_RUNTIME_OBSERVATION,
	finalizeDelegationCommandProvenance,
	isDelegationCommandScopeAttributedV1,
	observeWorkerCommandEffectRuntimeEntry,
	revalidateDelegationCommandProvenanceReceipts,
	validateDelegationCommandProvenance,
	WORKER_COMMAND_EFFECT_ENTRY_TYPE,
	type DelegationCommandProvenanceRecord,
	type WorkerCommandEffectEntry,
	type WorkerCommandEffectRuntimeObservation,
} from "../extensions/workbench-runtime/core/delegation-command-effect-provenance.ts";
import {
	finalizeDelegationChangeSetLifecycleV2,
	prepareDelegationChangeSetLifecycleV2,
} from "../extensions/workbench-runtime/core/delegation-change-set-lifecycle.ts";
import { deriveFinalizedDelegationWorkspaceFactsV2 } from "../extensions/workbench-runtime/core/delegation-workspace-v2.ts";
import { preflightSemanticReviewEnvelopeV1 } from "../extensions/workbench-runtime/core/diff-review.ts";
import { collectReviewRelevanceV2 } from "../extensions/workbench-runtime/core/review-relevance-v2.ts";
import {
	bindDelegationBoundedTaskContractV2,
	buildDelegationCommittedArtifactsV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import {
	commitDelegationGeneration,
	persistCommittingDelegationTransaction,
	persistPreparedDelegationTransaction,
	persistRunningDelegationTransaction,
	readDelegationCommittedGenerationV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import { registerToolResultMiddleware } from "../extensions/workbench-runtime/core/tool-result-middleware-controller.ts";
import { beginRunTransaction, commitRunTransaction } from "../extensions/workbench-runtime/core/run-transaction.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import type { LedgerWorkerFacts } from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

const DELEGATION_ID = "20260827-120000-cmd1";
const OUTPUT_PATH = "generated/result.json";
const IDENTITY = { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: "command-provenance-worker" } as const;

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function workerFacts(report: string): LedgerWorkerFacts {
	return {
		provider: WORKER_PROVIDER,
		model: WORKER_MODEL_ID,
		status: "success",
		workerSuccess: true,
		workerFailureCode: null,
		exitCode: 0,
		turns: 1,
		stopReason: "end_turn",
		errorMessage: null,
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		cacheHitRatio: 0,
		budget: {
			maxContextTokens: 20,
			maxContextRatio: 0.00002,
			softBudgetReached: false,
			hardBudgetExceeded: false,
			compactionCount: 0,
			compactionReasons: [],
		},
		spendProfile: "standard",
		spendState: { turns: 1, totalTokens: 20, outputTokens: 10 },
		spendBand: "ok",
		spendReasons: [],
		spendSoftReached: { turns: false, totalTokens: false, outputTokens: false },
		spendHardExceeded: { turns: false, totalTokens: false, outputTokens: false },
		reportSummary: report,
	};
}

function provenanceProjection(record: Omit<DelegationCommandProvenanceRecord, "command_provenance_hash">): unknown {
	return {
		schema_version: record.schema_version,
		delegation_id: record.delegation_id,
		contract_hash: record.contract_hash,
		base_change_set_hash: record.base_change_set_hash,
		worker_delta_hash: record.worker_delta_hash,
		runtime_observation: record.runtime_observation,
		receipts: record.receipts,
		command_delta: record.command_delta,
		remaining_workspace_drift: record.remaining_workspace_drift,
		terminal_reasons: record.terminal_reasons,
		effective_status: record.effective_status,
		effective_paths: record.effective_paths,
		finalization_meter: record.finalization_meter,
		effective_delta_hash: record.effective_delta_hash,
	};
}

function resign(record: DelegationCommandProvenanceRecord): DelegationCommandProvenanceRecord {
	if (record.command_delta.length > 0) {
		record.effective_delta_hash = hash({
			schema_version: 1,
			kind: "delegation-effective-delta-v1",
			delegation_id: record.delegation_id,
			contract_hash: record.contract_hash,
			worker_delta_hash: record.worker_delta_hash,
			command_delta: record.command_delta,
			receipts: record.receipts,
		});
	} else {
		record.effective_delta_hash = record.worker_delta_hash;
	}
	const { command_provenance_hash: _ignored, ...withoutHash } = record;
	record.command_provenance_hash = hash(provenanceProjection(withoutHash));
	return record;
}

async function initIgnoredOutputRepo(root: string): Promise<void> {
	await writeFile(join(root, ".gitignore"), `.pi/\n${OUTPUT_PATH}\n`, "utf8");
	await writeFile(join(root, "README.md"), "fixture\n", "utf8");
	await spawnExec("git", ["init", "-q"], { cwd: root });
	await spawnExec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
	await spawnExec("git", ["config", "user.name", "Test"], { cwd: root });
	await spawnExec("git", ["add", "-A"], { cwd: root });
	await spawnExec("git", ["commit", "-qm", "init"], { cwd: root });
}

async function commitEffectRun(
	root: string,
	effect: Readonly<CommandEffectRecord>,
	startedAt: string,
	finishedAt: string,
	runOutcome?: "SUCCESS" | "PROCESS_FAILED",
): Promise<void> {
	const transaction = await beginRunTransaction(root, effect.run_id);
	const resolvedRunOutcome = runOutcome ?? (effect.status === "CLEAN" || effect.status === "COMMAND_ATTRIBUTED"
		? "SUCCESS"
		: "COMMAND_EFFECT_FAILED");
	const manifest = {
		schema_version: 2,
		run_id: effect.run_id,
		recipe: effect.recipe,
		profile: "generic",
		started_at: startedAt,
		finished_at: finishedAt,
		duration_ms: Date.parse(finishedAt) - Date.parse(startedAt),
		cwd: root,
		argv: ["fixture"],
		exit_code: resolvedRunOutcome === "SUCCESS" ? 0 : 2,
		timed_out: false,
		cancelled: false,
		git_commit: null,
		git_dirty: false,
		artifact_paths: [],
		stdout_truncated: false,
		stderr_truncated: false,
		mode: "DEV",
		expected_exit_codes: [0],
		declared_writes: [...effect.declared_writes],
		environment_names: [],
		validation_components: [],
		cache_request_mode: "no-cache",
		run_transaction_schema_version: 2,
		run_outcome: resolvedRunOutcome,
		command_effect_path: "command-effect.json",
		command_effect_hash: effect.command_effect_hash,
		command_effect_status: effect.status,
	};
	await Promise.all([
		writeFile(join(transaction.stagingDir, "manifest.json"), JSON.stringify(manifest), "utf8"),
		writeFile(join(transaction.stagingDir, "command-effect.json"), JSON.stringify(effect), "utf8"),
		writeFile(join(transaction.stagingDir, "command.json"), "{}", "utf8"),
		writeFile(join(transaction.stagingDir, "environment.json"), "{}", "utf8"),
		writeFile(join(transaction.stagingDir, "summary.json"), "{}", "utf8"),
		writeFile(join(transaction.stagingDir, "stdout.log"), "", "utf8"),
		writeFile(join(transaction.stagingDir, "stderr.log"), "", "utf8"),
	]);
	await commitRunTransaction(transaction, new Date(finishedAt));
}

test("a failed CLEAN recipe remains spatially ATTRIBUTED and is a separate worker failure fact", async () => {
	await withTempDir(async (root) => {
		await initIgnoredOutputRepo(root);
		const contract = bindDelegationBoundedTaskContractV2({
			task_kind: "implementation",
			task: "Preserve an attributed source delta when a no-write validation command fails.",
			allowed_paths: ["src/**"],
			acceptance_criteria: ["Command failure is not relabelled as workspace drift."],
			verification: [],
			timeout_seconds: 600,
			budget_profile: "standard",
		});
		assert.equal(contract.ok, true);
		if (!contract.ok) return;
		const prepared = await prepareDelegationChangeSetLifecycleV2({
			project_root: root,
			delegation_id: DELEGATION_ID,
			contract_hash: contract.value.contract_hash,
			dependency_paths: [],
			exec: spawnExec,
		});
		assert.equal(prepared.ok, true);
		if (!prepared.ok) return;
		const started = await beginRecipeCommandEffectCapture({
			project_root: root,
			exec: spawnExec,
			declared_writes: [],
		});
		const effect = await completeRecipeCommandEffectCapture({
			project_root: root,
			exec: spawnExec,
			started,
			run_id: "20260827-120003-cm03",
			recipe: "expected-no-write-check",
			actor: "worker",
			worker_delegation_id: DELEGATION_ID,
			worker_contract_hash: contract.value.contract_hash,
			mutation_declaration: "none",
			declared_writes: [],
		});
		assert.equal(effect.status, "CLEAN");
		await commitEffectRun(
			root,
			effect,
			"2026-08-27T12:00:03.000Z",
			"2026-08-27T12:00:03.001Z",
			"PROCESS_FAILED",
		);
		const finalized = await finalizeDelegationChangeSetLifecycleV2({
			prepared: prepared.value,
			observation: { state: "empty", tool: "none", outcome: "none", code: "none", revision: 0 },
			exec: spawnExec,
		});
		assert.equal(finalized.ok, true, finalized.ok ? "" : finalized.error.code);
		if (!finalized.ok || finalized.value.command_provenance === undefined) return;
		const provenance = finalized.value.command_provenance;
		assert.deepEqual(provenance.terminal_reasons, ["COMMAND_EFFECT_RUN_FAILED"]);
		assert.deepEqual(provenance.remaining_workspace_drift, []);
		assert.equal(provenance.effective_status, "ATTRIBUTED");
		assert.equal(validateDelegationCommandProvenance(provenance, finalized.value.change_set), true);
		assert.equal(isDelegationCommandScopeAttributedV1(provenance, finalized.value.change_set), true);

		const legacy = structuredClone(provenance) as DelegationCommandProvenanceRecord;
		legacy.effective_status = "WORKSPACE_DRIFT";
		resign(legacy);
		assert.equal(validateDelegationCommandProvenance(legacy, finalized.value.change_set), true,
			"immutable v1 clean-run-failure records remain readable");
		assert.equal(isDelegationCommandScopeAttributedV1(legacy, finalized.value.change_set), true,
			"legacy process failure remains safe repair scope, not write drift");
	});
});

async function commandRun(
	root: string,
	contractHash: string,
	runId: string,
	content: string,
	startedAt: string,
	finishedAt: string,
): Promise<void> {
	const started = await beginRecipeCommandEffectCapture({
		project_root: root,
		exec: spawnExec,
		declared_writes: [OUTPUT_PATH],
	});
	await mkdir(join(root, "generated"), { recursive: true });
	await writeFile(join(root, OUTPUT_PATH), content, "utf8");
	const effect = await completeRecipeCommandEffectCapture({
		project_root: root,
		exec: spawnExec,
		started,
		run_id: runId,
		recipe: "fixture-output",
		actor: "worker",
		worker_delegation_id: DELEGATION_ID,
		worker_contract_hash: contractHash,
		mutation_declaration: "artifacts",
		declared_writes: [OUTPUT_PATH],
	});
	assert.equal(effect.status, "COMMAND_ATTRIBUTED");
	await commitEffectRun(root, effect, startedAt, finishedAt);
}

interface ProvenanceFixture {
	root: string;
	contract: ReturnType<typeof bindDelegationBoundedTaskContractV2> & { ok: true };
	lifecycle: Awaited<ReturnType<typeof finalizeDelegationChangeSetLifecycleV2>> & { ok: true };
}

async function setupProvenanceFixture(root: string): Promise<ProvenanceFixture> {
	await initIgnoredOutputRepo(root);
	const contract = bindDelegationBoundedTaskContractV2({
		task_kind: "implementation",
		task: "Produce the bounded generated command artifact.",
		allowed_paths: ["generated/**"],
		acceptance_criteria: ["The generated artifact is receipt-bound."],
		verification: ["strict receipt validation"],
		timeout_seconds: 600,
		budget_profile: "standard",
	});
	assert.equal(contract.ok, true);
	if (!contract.ok) throw new Error("contract failed");
	const prepared = await prepareDelegationChangeSetLifecycleV2({
		project_root: root,
		delegation_id: DELEGATION_ID,
		contract_hash: contract.value.contract_hash,
		dependency_paths: [],
		exec: spawnExec,
	});
	assert.equal(prepared.ok, true);
	if (!prepared.ok) throw new Error("prepare failed");
	await commandRun(root, contract.value.contract_hash, "20260827-120001-cm01", "one\n", "2026-08-27T12:00:01.000Z", "2026-08-27T12:00:01.001Z");
	await commandRun(root, contract.value.contract_hash, "20260827-120002-cm02", "two\n", "2026-08-27T12:00:02.000Z", "2026-08-27T12:00:02.001Z");
	const lifecycle = await finalizeDelegationChangeSetLifecycleV2({
		prepared: prepared.value,
		observation: { state: "empty", tool: "none", outcome: "none", code: "none", revision: 0 },
		exec: spawnExec,
	});
	assert.equal(lifecycle.ok, true, lifecycle.ok ? "" : lifecycle.error.code);
	if (!lifecycle.ok) throw new Error("finalize failed");
	return { root, contract: contract as ProvenanceFixture["contract"], lifecycle: lifecycle as ProvenanceFixture["lifecycle"] };
}

test("durable scan recovers two ordered ignored command outputs without a session observation", async () => {
	await withTempDir(async (root) => {
		const fixture = await setupProvenanceFixture(root);
		const provenance = fixture.lifecycle.value.command_provenance!;
		assert.deepEqual(fixture.lifecycle.value.change_set.worker_delta, []);
		assert.deepEqual(fixture.lifecycle.value.change_set.workspace_drift, []);
		assert.deepEqual(provenance.receipts.map((entry) => entry.run_id), [
			"20260827-120001-cm01",
			"20260827-120002-cm02",
		]);
		assert.deepEqual(provenance.command_delta.map((entry) => ({ path: entry.path, run_ids: entry.run_ids })), [{
			path: OUTPUT_PATH,
			run_ids: ["20260827-120001-cm01", "20260827-120002-cm02"],
		}]);
		assert.deepEqual(provenance.effective_paths, [OUTPUT_PATH]);
		assert.deepEqual(provenance.terminal_reasons, []);
		assert.equal(provenance.effective_status, "ATTRIBUTED");
		assert.equal(validateDelegationCommandProvenance(provenance, fixture.lifecycle.value.change_set), true);
		assert.equal(await revalidateDelegationCommandProvenanceReceipts(
			root, provenance, fixture.lifecycle.value.change_set, fixture.lifecycle.value.after_guard,
		), true);

		const workspace = deriveFinalizedDelegationWorkspaceFactsV2(fixture.lifecycle.value);
		assert.equal(workspace.ok, true);
		if (!workspace.ok) throw new Error("workspace facts failed");
		assert.equal(workspace.value.after.gitDirty, false);
		assert.deepEqual(workspace.value.after.changedPaths, [OUTPUT_PATH]);
		assert.deepEqual(workspace.value.after.pathStatuses, {}, "ignored C must not be forged into Git status");
		assert.match(workspace.value.after.pathDigests[OUTPUT_PATH] ?? "", /^[0-9a-f]{64}$/u);

		const contract = fixture.contract.value;
		const prepared = await persistPreparedDelegationTransaction(root, {
			delegation_id: DELEGATION_ID,
			task_kind: "implementation",
			contract_hash: contract.contract_hash,
			allowed_paths: contract.allowed_paths,
			worker_identity: IDENTITY,
			generation: 1,
			now: "2026-08-27T12:00:03.000Z",
		});
		assert.equal(prepared.ok, true);
		if (!prepared.ok) throw new Error("transaction prepare failed");
		const running = await persistRunningDelegationTransaction(root, {
			delegation_id: DELEGATION_ID,
			contract_hash: contract.contract_hash,
			worker_identity: IDENTITY,
			expected_generation: 1,
			expected_revision: 0,
			now: "2026-08-27T12:00:04.000Z",
		});
		assert.equal(running.ok, true);
		if (!running.ok) throw new Error("transaction start failed");
		const committing = await persistCommittingDelegationTransaction(root, {
			delegation_id: DELEGATION_ID,
			contract_hash: contract.contract_hash,
			worker_identity: IDENTITY,
			expected_generation: 1,
			expected_revision: 1,
			now: "2026-08-27T12:00:05.000Z",
			outcome: {
				delegation_id: DELEGATION_ID,
				task_kind: "implementation",
				worker_identity: IDENTITY,
				provider_success: true,
				worker_success: true,
				worker_failure_code: null,
				exit_code: 0,
				report_complete: true,
				terminal_facts_complete: true,
				scope_complete: true,
				change_set_status: provenance.effective_status,
				changed_paths: [...provenance.effective_paths],
				successful_write_count: 0,
				denied_write_count: 0,
				delta_hash: provenance.effective_delta_hash,
			},
		});
		assert.equal(committing.ok, true);
		if (!committing.ok) throw new Error("transaction commit begin failed");
		const relevance = await collectReviewRelevanceV2({
			project_root: root,
			delegation_id: DELEGATION_ID,
			contract_hash: contract.contract_hash,
			after_guard: fixture.lifecycle.value.after_guard,
			change_set: fixture.lifecycle.value.change_set,
			command_provenance: provenance,
			exec: spawnExec,
		});
		assert.equal(relevance.ok, true);
		if (!relevance.ok) throw new Error("relevance failed");
		const envelope = await preflightSemanticReviewEnvelopeV1({
			projectRoot: root,
			workerPaths: provenance.effective_paths,
			allowedPaths: contract.allowed_paths,
			afterDigests: workspace.value.after.pathDigests,
			pathStatuses: workspace.value.after.pathStatuses,
			relevanceProjection: relevance.value.projection,
			relevanceProjectionHash: relevance.value.binding.projection_hash,
			exec: spawnExec,
		});
		assert.equal(envelope.ok, true);
		if (!envelope.ok) throw new Error("envelope failed");
		const report = [
			"## Completed",
			"- Produced the bounded command artifact.",
			"## Files Changed",
			`- \`${OUTPUT_PATH}\``,
			"## Verification",
			"- strict receipt validation — pass",
			"## Remaining Risks",
			"- None.",
		].join("\n");
		const artifacts = buildDelegationCommittedArtifactsV2({
			transaction: committing.value,
			contract,
			before: workspace.value.before,
			after: workspace.value.after,
			changeSetLifecycle: fixture.lifecycle.value,
			worker: workerFacts(report),
			reportText: report,
			reviewEnvelope: envelope.value,
		});
		assert.equal(artifacts.ok, true, artifacts.ok ? "" : artifacts.error.code);
		if (!artifacts.ok) throw new Error("artifact build failed");
		const afterRecord = artifacts.value.records["after.json"] as Record<string, unknown>;
		assert.deepEqual(afterRecord.path_statuses, {});
		assert.deepEqual(afterRecord.changed_paths, [OUTPUT_PATH]);
		const committed = await commitDelegationGeneration(root, {
			delegation_id: DELEGATION_ID,
			contract_hash: contract.contract_hash,
			worker_identity: IDENTITY,
			expected_generation: 1,
			expected_revision: 2,
			now: "2026-08-27T12:00:06.000Z",
			records: artifacts.value.records,
		});
		assert.equal(committed.ok, true, committed.ok ? "" : committed.error.message);
		const strict = await readDelegationCommittedGenerationV2(root, DELEGATION_ID);
		assert.equal(strict.ok, true, strict.ok ? "" : strict.error.message);
	});
});

test("custom observation is advisory: empty recovers, exact cross-checks, and contradictions only deny", async () => {
	await withTempDir(async (root) => {
		const fixture = await setupProvenanceFixture(root);
		const base = fixture.lifecycle.value;
		const contractHash = fixture.contract.value.contract_hash;
		const exactEntry = await buildWorkerCommandEffectEntryFromToolResult({
			project_root: root,
			delegation_id: DELEGATION_ID,
			contract_hash: contractHash,
			tool_name: "workbench_run_recipe",
			details: { phase: "finished", run_id: "20260827-120001-cm01" },
		});
		assert.equal(exactEntry?.kind, "committed");
		const exactObservation = observeWorkerCommandEffectRuntimeEntry({
			type: "custom",
			customType: WORKER_COMMAND_EFFECT_ENTRY_TYPE,
			data: exactEntry,
		}, EMPTY_WORKER_COMMAND_EFFECT_RUNTIME_OBSERVATION, {
			delegation_id: DELEGATION_ID,
			contract_hash: contractHash,
		});
		const exact = await finalizeDelegationCommandProvenance({
			project_root: root,
			delegation_id: DELEGATION_ID,
			contract_hash: contractHash,
			before_guard: base.prepared.before_guard,
			after_guard: base.after_guard,
			change_set: base.change_set,
			observation: exactObservation,
		});
		assert.equal(exact.ok, true);
		if (exact.ok) assert.deepEqual(exact.value.terminal_reasons, []);

		const unavailable: WorkerCommandEffectEntry = {
			schema: "workbench-worker-command-effect-v1",
			kind: "unavailable",
			delegation_id: DELEGATION_ID,
			contract_hash: contractHash,
			run_id: "20260827-120001-cm01",
			recipe: null,
			started_at: null,
			finished_at: null,
			run_outcome: null,
			manifest_sha256: null,
			command_effect_file_sha256: null,
			command_effect_hash: null,
			command_effect_status: null,
			failure_code: "command_effect_unavailable",
		};
		const contradictory: WorkerCommandEffectRuntimeObservation = {
			state: "observed",
			code: "none",
			entries: [unavailable],
		};
		const denied = await finalizeDelegationCommandProvenance({
			project_root: root,
			delegation_id: DELEGATION_ID,
			contract_hash: contractHash,
			before_guard: base.prepared.before_guard,
			after_guard: base.after_guard,
			change_set: base.change_set,
			observation: contradictory,
		});
		assert.equal(denied.ok, true);
		if (denied.ok) {
			assert.deepEqual(denied.value.terminal_reasons, ["COMMAND_EFFECT_PROTOCOL_INVALID"]);
			assert.equal(denied.value.effective_status, "CONFLICT");
		}
	});
});

test("strict companion validation rejects re-signed malformed identities, meters, ordering, and status", async () => {
	await withTempDir(async (root) => {
		const fixture = await setupProvenanceFixture(root);
		const changeSet = fixture.lifecycle.value.change_set;
		const original = fixture.lifecycle.value.command_provenance!;

		const badIdentity = structuredClone(original) as DelegationCommandProvenanceRecord;
		assert.equal(badIdentity.command_delta[0]?.after.kind, "file");
		if (badIdentity.command_delta[0]?.after.kind === "file") badIdentity.command_delta[0].after.stat.dev = "-1";
		assert.equal(validateDelegationCommandProvenance(resign(badIdentity), changeSet), false);

		const badMeter = structuredClone(original) as DelegationCommandProvenanceRecord;
		badMeter.finalization_meter = {
			...badMeter.finalization_meter,
			paths_completed: badMeter.finalization_meter.paths_attempted + 1,
		};
		assert.equal(validateDelegationCommandProvenance(resign(badMeter), changeSet), false);

		const badRunOrder = structuredClone(original) as DelegationCommandProvenanceRecord;
		badRunOrder.command_delta[0]!.run_ids = [...badRunOrder.command_delta[0]!.run_ids].reverse();
		assert.equal(validateDelegationCommandProvenance(resign(badRunOrder), changeSet), false);

		const badReasons = structuredClone(original) as DelegationCommandProvenanceRecord;
		badReasons.terminal_reasons = ["COMMAND_EFFECT_PROTOCOL_INVALID", "COMMAND_EFFECT_BINDING_CONFLICT"];
		badReasons.effective_status = "CONFLICT";
		assert.equal(validateDelegationCommandProvenance(resign(badReasons), changeSet), false);

		const badStatus = structuredClone(original) as DelegationCommandProvenanceRecord;
		badStatus.effective_status = "WORKSPACE_DRIFT";
		assert.equal(validateDelegationCommandProvenance(resign(badStatus), changeSet), false);
	});
});

test("session mirror failure never converts a committed recipe tool result into an error", async () => {
	const handlers: Array<(event: any) => unknown> = [];
	registerToolResultMiddleware({
		pi: { on(_event: string, handler: (event: any) => unknown) { handlers.push(handler); } },
		workerJournalActive: false,
		observeWorkerRecipeCommandEffect: async () => { throw new Error("append failed"); },
	} as never);
	assert.ok(handlers.length > 0);
	const original = {
		toolName: "workbench_run_recipe",
		toolCallId: "call-1",
		input: {},
		content: [{ type: "text", text: "committed" }],
		details: { phase: "finished", run_id: "20260827-120001-cm01" },
		isError: false,
	};
	assert.equal(await handlers[0]!(original), undefined);
	assert.equal(original.isError, false);
});
