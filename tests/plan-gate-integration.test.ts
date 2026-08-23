import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	bindDelegationBoundedTaskContractV2,
	type DelegationBoundedTaskContractBindingV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import { buildDelegationWorkerFirstGateFacts } from "../extensions/workbench-runtime/core/delegation-plan-reference.ts";
import { executeDelegationV2 } from "../extensions/workbench-runtime/core/delegation-execution-v2.ts";
import { GateSetupError, runGates } from "../extensions/workbench-runtime/core/gate-engine.ts";
import type { WorkerFirstGateFacts } from "../extensions/workbench-runtime/core/gate-schema.ts";
import { planReferenceHash, requiredPlanGateIds, type PlanReferenceV1 } from "../extensions/workbench-runtime/core/plan-reference.ts";
import { assessRunValidation } from "../extensions/workbench-runtime/core/validation-assessment.ts";
import type { ValidationEvidenceBlock } from "../extensions/workbench-runtime/core/validation-evidence.ts";
import { readManifest } from "../extensions/workbench-runtime/core/runs.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION } from "../extensions/workbench-runtime/core/worker-write-journal-runtime.ts";
import type { WorkerRunResult } from "../extensions/workbench-runtime/worker/runner.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

const SOL_FACTS = { role: undefined, provider: "openai-codex", model: "gpt-5.6-sol" } as const;
const PLAN_PATH = "docs/plans/active-plan.md";
const SIMPLE_CHECK = (gateId: string): string =>
	`  - id: ${gateId}\n    title: ${gateId}\n    checks:\n      - { id: ${gateId}.config, title: Config, kind: config }\n`;

function gateDocument(extra = ""): string {
	return `gates:\n${["b0", "b1", "b2", "b3", "b4", "b5"].map(SIMPLE_CHECK).join("")}${extra}`;
}

async function initializeGitProject(
	dir: string,
	options: { profile?: string; gatesYaml: string; planBytes?: string },
): Promise<void> {
	await writeFile(join(dir, ".gitignore"), ".pi/\n", "utf8");
	await writeConfigFile(dir, "project.yaml", `name: plan-gate-integration\nprofile: ${options.profile ?? "generic"}\n`);
	await writeConfigFile(dir, "recipes.yaml", "recipes: []\n");
	await writeConfigFile(dir, "gates.yaml", options.gatesYaml);
	await writeFile(join(dir, "package.json"), "{}\n", "utf8");
	if (options.planBytes !== undefined) {
		await mkdir(dirname(join(dir, PLAN_PATH)), { recursive: true });
		await writeFile(join(dir, PLAN_PATH), options.planBytes, "utf8");
	}
	assert.equal((await spawnExec("git", ["init", "-q"], { cwd: dir })).code, 0);
	assert.equal((await spawnExec("git", ["config", "user.email", "plan-gate@example.invalid"], { cwd: dir })).code, 0);
	assert.equal((await spawnExec("git", ["config", "user.name", "Plan Gate"], { cwd: dir })).code, 0);
	assert.equal((await spawnExec("git", ["add", "-A"], { cwd: dir })).code, 0);
	assert.equal((await spawnExec("git", ["commit", "-qm", "init"], { cwd: dir })).code, 0);
}

function completeWorkerResult(): WorkerRunResult {
	const report = [
		"## Completed",
		"- Completed the bounded diagnosis.",
		"## Files Changed",
		"- None.",
		"## Verification",
		"- Current plan bytes were retained.",
		"## Remaining Risks",
		"- None.",
	].join("\n");
	return {
		exitCode: 0,
		provider: WORKER_PROVIDER,
		model: WORKER_MODEL_ID,
		turns: 1,
		stopReason: "end_turn",
		output: report,
		reportText: report,
		reportTextOversized: false,
		stderr: "",
		aborted: false,
		timedOut: false,
		deniedWriteCount: 0,
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		cacheHitRatio: 0,
		maxContextTokens: 20,
		maxContextRatio: 20 / 272_000,
		softBudgetReached: false,
		hardBudgetExceeded: false,
		compactionCount: 0,
		compactionReasons: [],
		spendProfile: "standard",
		spendState: { turns: 1, totalTokens: 20, outputTokens: 10 },
		spendBand: "ok",
		spendReasons: [],
		spendSoftReached: { turns: false, totalTokens: false, outputTokens: false },
		spendHardExceeded: { turns: false, totalTokens: false, outputTokens: false },
		writeJournalObservation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
	};
}

function bindPlanContract(reference: PlanReferenceV1): DelegationBoundedTaskContractBindingV2 {
	const contract = bindDelegationBoundedTaskContractV2({
		task_kind: "diagnosis",
		task: "Diagnose the bounded plan criteria without changing project files.",
		allowed_paths: ["src/**"],
		acceptance_criteria: ["The current plan reference remains strictly bound."],
		verification: ["Run the mapped Gate selector."],
		timeout_seconds: 600,
		budget_profile: "standard",
		plan_ref: reference,
	});
	assert.equal(contract.ok, true, contract.ok ? "" : contract.error.code);
	return contract.value;
}

async function seedPlanDelegation(
	dir: string,
	requiredGateIds: readonly string[],
	options: { profile?: string; gatesYaml?: string; planBytes?: string; id?: string } = {},
): Promise<{ delegationId: string; reference: PlanReferenceV1; planReferenceHash: string; requiredGateIds: string[] }> {
	const planBytes = options.planBytes ?? "# Active plan\n\nGate criteria remain current.\n";
	await initializeGitProject(dir, {
		profile: options.profile,
		gatesYaml: options.gatesYaml ?? gateDocument(requiredGateIds.map(SIMPLE_CHECK).join("")),
		planBytes,
	});
	const reference: PlanReferenceV1 = {
		schema: "workbench-plan-ref-v1",
		plan_id: "plan-gate-integration",
		version: "1.0",
		plan_path: PLAN_PATH,
		plan_sha256: createHash("sha256").update(planBytes).digest("hex"),
		candidate: "CURRENT_WORKTREE",
		status: "IN_PROGRESS",
		criteria: [...requiredGateIds].sort().map((gateId, index) => ({
			id: `C${index + 1}`,
			gate_id: gateId,
			check_ids: [`${gateId}.plan`],
			evidence_paths: [PLAN_PATH],
		})),
		next_action: "Run a final selector covering every mapped Gate.",
	};
	const delegationId = options.id ?? "20260823-010101-p001";
	let tick = 0;
	const result = await executeDelegationV2({
		projectRoot: dir,
		delegationId,
		contract: bindPlanContract(reference),
		workerIdentity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: "plan-gate-worker" },
		clock: () => `2026-08-23T01:01:${String(tick++).padStart(2, "0")}.000Z`,
		exec: spawnExec,
		runWorker: async () => completeWorkerResult(),
	});
	assert.equal(result.ok, true, result.ok ? "" : result.code);
	assert.equal(result.status, "FINISHED");
	const hash = planReferenceHash(reference);
	assert.ok(hash);
	return { delegationId, reference, planReferenceHash: hash, requiredGateIds: requiredPlanGateIds(reference) };
}

function currentPlanFacts(
	plan: Awaited<ReturnType<typeof seedPlanDelegation>>,
	overrides: Partial<WorkerFirstGateFacts> = {},
): WorkerFirstGateFacts {
	const reviewedHash = "a".repeat(64);
	return {
		schema_version: 1,
		actor: "sol-commander",
		writePolicy: "worker-first-strict",
		commanderWritesDenied: true,
		blockedCommanderWriteAttempts: 0,
		hasDelegation: true,
		latestDelegationId: plan.delegationId,
		reviewStatus: "REVIEWED",
		currentDiffHash: reviewedHash,
		reviewedDiffHash: reviewedHash,
		reviewVerdict: "PASS",
		reviewViolationCount: 0,
		leaseStatus: "locked",
		leaseReason: null,
		leaseCallsUsed: 0,
		leaseMaxCalls: 10,
		gateRunInitiatedByCommander: true,
		planReferenceHash: plan.planReferenceHash,
		requiredGateIds: [...plan.requiredGateIds],
		planReferenceCurrent: true,
		...overrides,
	};
}

function projectedPlanFacts(
	dir: string,
	plan: Awaited<ReturnType<typeof seedPlanDelegation>>,
): Promise<WorkerFirstGateFacts> {
	const reviewedHash = "a".repeat(64);
	return buildDelegationWorkerFirstGateFacts({
		projectRoot: dir,
		state: {
			latestId: plan.delegationId,
			status: "REVIEWED",
			currentDiffHash: reviewedHash,
			reviewedDiffHash: reviewedHash,
			blockedWriteAttempts: 0,
			updatedAt: "2026-08-23T01:02:00.000Z",
		},
		currentDiffHash: reviewedHash,
		runtime: {
			actor: "sol-commander",
			writePolicy: "worker-first-strict",
			commanderWritesDenied: true,
			leaseStatus: "locked",
			leaseReason: null,
			leaseCallsUsed: 0,
			leaseMaxCalls: 10,
			gateRunInitiatedByCommander: true,
		},
	});
}

async function manifestFor(dir: string, runId: string) {
	const manifest = await readManifest(dir, runId);
	assert.ok(manifest);
	return manifest;
}

test("historical gate authority without plan_ref remains reusable when no current delegation plan exists", async () => {
	await withTempDir(async (dir) => {
		await initializeGitProject(dir, { gatesYaml: `gates:\n${SIMPLE_CHECK("g1")}` });
		const run = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(run.ok, true);
		const manifest = await manifestFor(dir, run.runId);
		assert.equal(manifest.validation_evidence?.binding?.target.kind, "gate");
		if (manifest.validation_evidence?.binding?.target.kind === "gate") {
			assert.equal(Object.prototype.hasOwnProperty.call(manifest.validation_evidence.binding.target, "plan_reference"), false);
		}
		assert.deepEqual(
			await assessRunValidation({ projectRoot: dir, mode: "DEV", exec: spawnExec, manifest, actorFacts: SOL_FACTS }),
			{ status: "REUSABLE", reasons: [] },
		);
	});
});

test("a current plan is hash-bound into a fully covered final Gate authority and is reverified during assessment", async () => {
	await withTempDir(async (dir) => {
		const plan = await seedPlanDelegation(dir, ["g1"]);
		const facts = await projectedPlanFacts(dir, plan);
		assert.equal(facts.planReferenceHash, plan.planReferenceHash);
		assert.deepEqual(facts.requiredGateIds, ["g1"]);
		assert.equal(facts.planReferenceCurrent, true);
		const run = await runGates({
			projectRoot: dir,
			selector: "all",
			mode: "DEV",
			exec: spawnExec,
			workerFirstFacts: facts,
			actorFacts: SOL_FACTS,
		});
		assert.equal(run.ok, true, run.gates.map((gate) => `${gate.id}:${gate.status}`).join(","));
		const manifest = await manifestFor(dir, run.runId);
		const binding = manifest.validation_evidence?.binding;
		assert.equal(binding?.target.kind, "gate");
		if (binding?.target.kind === "gate") {
			assert.deepEqual(binding.target.plan_reference, {
				plan_reference_hash: plan.planReferenceHash,
				required_gate_ids: ["g1"],
				coverage: "FULL",
			});
		}
		assert.deepEqual(
			await assessRunValidation({
				projectRoot: dir,
				mode: "DEV",
				exec: spawnExec,
				manifest,
				workerFirstFacts: facts,
				actorFacts: SOL_FACTS,
			}),
			{ status: "REUSABLE", reasons: [] },
		);

		await writeFile(join(dir, PLAN_PATH), "# Tampered plan bytes\n", "utf8");
		assert.deepEqual(
			await assessRunValidation({
				projectRoot: dir,
				mode: "DEV",
				exec: spawnExec,
				manifest,
				workerFirstFacts: facts,
				actorFacts: SOL_FACTS,
			}),
			{ status: "RERUN_REQUIRED", reasons: ["collection-failure"] },
			"assessment re-verifies the current plan bytes instead of trusting persisted plan facts",
		);
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "all", mode: "DEV", exec: spawnExec, workerFirstFacts: facts, actorFacts: SOL_FACTS }),
			(error: unknown) => error instanceof GateSetupError && /PLAN_REFERENCE_BLOCKED:plan-reference-digest-mismatch/.test(error.message),
		);
	});
});

test("final selectors fail closed when mapped Gates are unavailable or not selected, including quant mappings", async () => {
	await withTempDir(async (dir) => {
		const plan = await seedPlanDelegation(dir, ["gone"], { gatesYaml: gateDocument() });
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "all", mode: "DEV", exec: spawnExec, workerFirstFacts: currentPlanFacts(plan) }),
			(error: unknown) => error instanceof GateSetupError && /PLAN_REFERENCE_GATE_UNAVAILABLE:gone/.test(error.message),
		);
	});

	await withTempDir(async (dir) => {
		const plan = await seedPlanDelegation(dir, ["q0"], {
			profile: "quant-research/stock-selection",
			gatesYaml: gateDocument(),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "base", mode: "DEV", exec: spawnExec, workerFirstFacts: currentPlanFacts(plan) }),
			(error: unknown) => error instanceof GateSetupError &&
				/PLAN_REFERENCE_SELECTOR_INCOMPLETE:q0:use-all-for-quant-plan-gates/.test(error.message),
		);
	});
});

test("a non-PASS mapped Gate makes the full authority unsuccessful", async () => {
	await withTempDir(async (dir) => {
		const failing = "  - id: g1\n    title: G1\n    checks:\n      - { id: g1.file, title: Missing, kind: file, path: missing.txt }\n";
		const plan = await seedPlanDelegation(dir, ["g1"], { gatesYaml: gateDocument(failing) });
		const facts = currentPlanFacts(plan);
		const run = await runGates({
			projectRoot: dir,
			selector: "all",
			mode: "DEV",
			exec: spawnExec,
			workerFirstFacts: facts,
			actorFacts: SOL_FACTS,
		});
		assert.equal(run.ok, false);
		assert.equal(run.gates.find((gate) => gate.id === "g1")?.status, "FAIL");
		const manifest = await manifestFor(dir, run.runId);
		const block = manifest.validation_evidence as ValidationEvidenceBlock;
		assert.equal(block.binding?.target.kind, "gate");
		if (block.binding?.target.kind === "gate") assert.equal(block.binding.target.plan_reference?.coverage, "FULL");
		assert.equal(block.binding?.outcome.successful, false);
		assert.deepEqual(
			await assessRunValidation({ projectRoot: dir, mode: "DEV", exec: spawnExec, manifest, workerFirstFacts: facts, actorFacts: SOL_FACTS }),
			{ status: "RERUN_REQUIRED", reasons: ["unsuccessful-source"] },
		);
	});
});

test("a focused mapped Gate remains development feedback and cannot become reusable plan authority", async () => {
	await withTempDir(async (dir) => {
		const plan = await seedPlanDelegation(dir, ["g1", "g2"]);
		const facts = currentPlanFacts(plan);
		const run = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			workerFirstFacts: facts,
			actorFacts: SOL_FACTS,
		});
		assert.equal(run.ok, true, "focused feedback may report the selected Gate PASS");
		const manifest = await manifestFor(dir, run.runId);
		const binding = manifest.validation_evidence?.binding;
		assert.equal(binding?.target.kind, "gate");
		if (binding?.target.kind === "gate") {
			assert.deepEqual(binding.target.plan_reference, {
				plan_reference_hash: plan.planReferenceHash,
				required_gate_ids: ["g1", "g2"],
				coverage: "PARTIAL",
			});
		}
		assert.equal(binding?.outcome.successful, false, "partial plan coverage never creates formal authority");
		assert.deepEqual(
			await assessRunValidation({ projectRoot: dir, mode: "DEV", exec: spawnExec, manifest, workerFirstFacts: facts, actorFacts: SOL_FACTS }),
			{ status: "RERUN_REQUIRED", reasons: ["unsuccessful-source"] },
		);
	});
});
