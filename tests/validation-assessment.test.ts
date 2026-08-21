/**
 * P4b validation-assessment tests — the Commander-facing current-state
 * reuse verdict over REAL persisted runs.
 *
 * Coverage (assessment-level, not just pure comparator):
 *   - fresh successful complete Sol recipe run is REUSABLE; raw manifest
 *     argv mutation alone never matters (argv is never read — only the
 *     privacy-safe argv_hash identity);
 *   - argv_hash identity: missing/malformed/mismatched is corrupt-binding;
 *   - source refusals with the fixed P4a codes: unsuccessful-source,
 *     incomplete-source, non-sol-source; block refusals missing-binding /
 *     legacy-binding / corrupt-binding / unavailable-binding;
 *   - every bound component refuses: diff, commit, lockfile, config, gate
 *     schema, profile, mode — in the exact fixed order;
 *   - recipe definition/cwd change and recipe removal refuse (removal
 *     short-circuits to target-mismatch), collection failure refuses;
 *   - a real successful Sol gate run with whitespace-padded manual input
 *     plus extra unknown caller keys round-trips to REUSABLE — the binding
 *     hashes EXACTLY the persisted type="manual" evidence map (the
 *     persisted-evidence-map fix), proven by re-deriving the gate-state
 *     hash from the recovered map;
 *   - strict gate artifacts: manual-note tamper, foreign evidence schema,
 *     missing evidence file all refuse fail-closed;
 *   - gate target/catalog change, prerequisite status change and
 *     worker/actor fact change refuse;
 *   - privacy: raw manual secret text never appears in any assessment
 *     output serialization.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { runGates } from "../extensions/workbench-runtime/core/gate-engine.ts";
import { runRecipe } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import { readManifest, type RunRecord } from "../extensions/workbench-runtime/core/runs.ts";
import { loadProjectConfig, type ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { assessRunValidation, type RunValidationAssessment } from "../extensions/workbench-runtime/core/validation-assessment.ts";
import { ARTIFACT_MANIFEST_FILE } from "../extensions/workbench-runtime/core/artifact-contract.ts";
import { RUN_COMMIT_FILE } from "../extensions/workbench-runtime/core/run-transaction.ts";
import {
	gateStateHash,
	unavailableEvidenceBlock,
	type ValidationRefusalReason,
} from "../extensions/workbench-runtime/core/validation-evidence.ts";
import type { WorkerFirstGateFacts } from "../extensions/workbench-runtime/core/gate-schema.ts";
import type { RecipeMutationFacts } from "../extensions/workbench-runtime/core/worker-policy.ts";
import type { WorkbenchMode } from "../extensions/workbench-runtime/core/mode-policy.ts";
import { KNOWN_LOCKFILES } from "../extensions/workbench-runtime/cache/action-types.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

const SOL_FACTS: RecipeMutationFacts = { role: undefined, provider: "openai-codex", model: "gpt-5.6-sol" };
const WORKER_FACTS: RecipeMutationFacts = { role: "worker", provider: "deepseek", model: "deepseek-v4-flash" };

const RECIPES_YAML = `
recipes:
  - name: hello
    description: exits zero
    command: [node, -e, "process.exit(0)"]
  - name: failing
    description: exits one
    command: [node, -e, "process.exit(1)"]
  - name: slow
    description: runs until the timeout kills it
    command: [node, -e, "setTimeout(() => {}, 60000)"]
    timeout_ms: 2000
`;

const GATES_YAML_EMPTY = "gates: []\n";

function gatesYaml(gates: string): string {
	return `gates:\n${gates}`;
}

const MANUAL_GATE = (id: string, checkId: string, extra = "") =>
	`  - id: ${id}\n    title: ${id.toUpperCase()}\n${extra}    checks:\n      - { id: ${checkId}, title: Audit, kind: manual, prompt: "audit" }\n`;

const PREREQ_GATES = gatesYaml(`${MANUAL_GATE("g1", "g1.1")}${MANUAL_GATE("g2", "g2.1", "    prerequisites: [g1]\n")}`);

function cleanWorkerFacts(overrides: Partial<WorkerFirstGateFacts> = {}): WorkerFirstGateFacts {
	return {
		schema_version: 1,
		actor: "sol-commander",
		writePolicy: "worker-first-strict",
		commanderWritesDenied: true,
		blockedCommanderWriteAttempts: 0,
		hasDelegation: false,
		latestDelegationId: null,
		reviewStatus: null,
		currentDiffHash: null,
		reviewedDiffHash: null,
		reviewVerdict: null,
		reviewViolationCount: null,
		leaseStatus: "locked",
		leaseReason: null,
		leaseCallsUsed: 0,
		leaseMaxCalls: 10,
		gateRunInitiatedByCommander: true,
		...overrides,
	};
}

/** Git-init the temp project (the .pi config dir and optionally lockfiles stay ignored). */
async function setupGitProject(dir: string, options: { ignoreLockfiles?: boolean; gatesYaml?: string } = {}): Promise<void> {
	const ignore = `.pi/\n${options.ignoreLockfiles ? `${KNOWN_LOCKFILES.join("\n")}\n` : ""}`;
	await writeFile(join(dir, ".gitignore"), ignore, "utf8");
	await writeConfigFile(dir, "project.yaml", "name: validation-assessment-test\nprofile: generic\n");
	await writeConfigFile(dir, "recipes.yaml", RECIPES_YAML);
	await writeConfigFile(dir, "gates.yaml", options.gatesYaml ?? GATES_YAML_EMPTY);
	await spawnExec("git", ["init", "-q"], { cwd: dir });
	await spawnExec("git", ["config", "user.email", "t@t"], { cwd: dir });
	await spawnExec("git", ["config", "user.name", "t"], { cwd: dir });
	await spawnExec("git", ["add", "-A"], { cwd: dir });
	await spawnExec("git", ["commit", "-qm", "init"], { cwd: dir });
}

/** Run a declared recipe end to end (real node child, real git) and read its persisted manifest. */
async function runRecipeRun(dir: string, recipeName: string, overrides: Partial<Parameters<typeof runRecipe>[0]> = {}): Promise<{ runId: string; manifest: RunRecord }> {
	const result = await runRecipe({ projectRoot: dir, recipeName, mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS, ...overrides });
	assert.ok(result.record, `recipe run must produce a record${result.error ? `: ${result.error}` : ""}`);
	const manifest = await readManifest(dir, result.record.run_id);
	assert.ok(manifest, "persisted manifest must be readable");
	return { runId: result.record.run_id, manifest };
}

/** Assess a persisted manifest against the current state with Sol facts. */
function assess(dir: string, manifest: RunRecord, overrides: Partial<Parameters<typeof assessRunValidation>[0]> = {}): Promise<RunValidationAssessment> {
	return assessRunValidation({ projectRoot: dir, mode: "DEV", exec: spawnExec, manifest, actorFacts: SOL_FACTS, ...overrides });
}

function manifestPath(dir: string, runId: string): string {
	return join(dir, CONFIG_DIR_NAME, "workbench", "runs", runId, "manifest.json");
}

/** Persist a mutated manifest (from the given base raw) and re-read it. */
async function persistManifest(dir: string, runId: string, raw: Record<string, unknown>): Promise<RunRecord> {
	await writeFile(manifestPath(dir, runId), JSON.stringify(raw, null, 2), "utf8");
	const manifest = await readManifest(dir, runId);
	assert.ok(manifest, "persisted manifest must stay readable");
	return manifest;
}

const REUSABLE = { status: "REUSABLE", reasons: [] as ValidationRefusalReason[] };
const rerun = (reasons: ValidationRefusalReason[]): RunValidationAssessment => ({ status: "RERUN_REQUIRED", reasons });

// ---------------------------------------------------------------------------
// Fresh recipe run: REUSABLE + raw argv never consulted
// ---------------------------------------------------------------------------

test("a fresh successful complete Sol recipe run assesses REUSABLE", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const { manifest } = await runRecipeRun(dir, "hello");

		// Exec runs persist a privacy-safe argv_hash identity; the binding
		// invocation hash must be exactly that identity.
		assert.match(manifest.argv_hash ?? "", /^[0-9a-f]{64}$/);
		const binding = manifest.validation_evidence?.binding;
		assert.equal(binding?.kind, "recipe");
		if (binding?.kind === "recipe" && binding.target.kind === "recipe") assert.equal(binding.target.invocation_hash, manifest.argv_hash);

		assert.deepEqual(await assess(dir, manifest), REUSABLE);
	});
});

test("raw manifest argv mutation alone does not matter", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const { runId, manifest } = await runRecipeRun(dir, "hello");
		const argvSecret = "argv-secret-token-xyz";
		const originalRaw = JSON.parse(await readFile(manifestPath(dir, runId), "utf8")) as Record<string, unknown>;

		const mutated = {
			...JSON.parse(JSON.stringify(originalRaw)) as Record<string, unknown>,
			argv: ["node", "-e", "process.exit(0)", argvSecret],
		} as unknown as RunRecord;
		const verdict = await assess(dir, mutated);
		assert.deepEqual(verdict, REUSABLE, "argv is never read — only the argv_hash identity binds");
		assert.ok(!JSON.stringify(verdict).includes(argvSecret), "raw argv must never surface in assessment output");
		assert.equal(manifest.argv_hash, mutated.argv_hash);
	});
});

test("argv_hash identity: missing/malformed/mismatched refuse with corrupt-binding", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const { runId } = await runRecipeRun(dir, "hello");
		const originalRaw = JSON.parse(await readFile(manifestPath(dir, runId), "utf8")) as Record<string, unknown>;
		assert.match(String(originalRaw.argv_hash), /^[0-9a-f]{64}$/);
		await rm(join(dir, CONFIG_DIR_NAME, "workbench", "runs", runId, RUN_COMMIT_FILE));
		await rm(join(dir, CONFIG_DIR_NAME, "workbench", "runs", runId, ARTIFACT_MANIFEST_FILE));
		delete originalRaw.run_transaction_schema_version;
		delete originalRaw.run_outcome;
		delete originalRaw.artifact_manifest_path;
		originalRaw.schema_version = 1;

		const cases: Array<{ label: string; mutate: (raw: Record<string, unknown>) => void }> = [
			{ label: "missing", mutate: (raw) => { delete raw.argv_hash; } },
			{ label: "malformed", mutate: (raw) => { raw.argv_hash = "zzz"; } },
			{ label: "mismatched", mutate: (raw) => { const h = String(raw.argv_hash); raw.argv_hash = (h[0] === "a" ? "b" : "a") + h.slice(1); } },
		];
		for (const c of cases) {
			const raw = JSON.parse(JSON.stringify(originalRaw)) as Record<string, unknown>;
			c.mutate(raw);
			const mutated = await persistManifest(dir, runId, raw);
			assert.deepEqual(await assess(dir, mutated), rerun(["corrupt-binding"]), c.label);
		}
	});
});

// ---------------------------------------------------------------------------
// Source and block refusals (fixed P4a codes)
// ---------------------------------------------------------------------------

test("failed, incomplete and non-Sol sources refuse with the fixed codes", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);

		// Failed exec run: exit 1 outside expected_exit_codes.
		const failed = await runRecipeRun(dir, "failing");
		assert.equal(failed.manifest.exit_code, 1);
		assert.deepEqual(await assess(dir, failed.manifest), rerun(["unsuccessful-source"]));

		// Incomplete run: the timeout kills the child (exit_code null,
		// complete false) — both source reasons in the fixed order.
		const slow = await runRecipeRun(dir, "slow");
		assert.equal(slow.manifest.exit_code, null);
		assert.equal(slow.manifest.timed_out, true);
		assert.deepEqual(await assess(dir, slow.manifest), rerun(["unsuccessful-source", "incomplete-source"]));

		// Successful complete run by a worker: non-sol-source alone.
		const worker = await runRecipeRun(dir, "hello", { actorFacts: WORKER_FACTS });
		assert.equal(worker.manifest.validation_evidence?.binding?.owner, "worker");
		assert.deepEqual(await assess(dir, worker.manifest), rerun(["non-sol-source"]));
	});
});

test("missing, legacy, corrupt and unavailable blocks refuse with the fixed codes", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const { runId } = await runRecipeRun(dir, "hello");
		const originalRaw = JSON.parse(await readFile(manifestPath(dir, runId), "utf8")) as Record<string, unknown>;
		await rm(join(dir, CONFIG_DIR_NAME, "workbench", "runs", runId, RUN_COMMIT_FILE));
		await rm(join(dir, CONFIG_DIR_NAME, "workbench", "runs", runId, ARTIFACT_MANIFEST_FILE));
		delete originalRaw.run_transaction_schema_version;
		delete originalRaw.run_outcome;
		delete originalRaw.artifact_manifest_path;
		originalRaw.schema_version = 1;

		const cases: Array<{ label: string; block: unknown; expect: ValidationRefusalReason[] }> = [
			{ label: "missing", block: undefined, expect: ["missing-binding"] },
			{ label: "legacy", block: { schema_version: 2, binding: null, unavailable_reason: "future" }, expect: ["legacy-binding"] },
			{ label: "corrupt-shape", block: { schema_version: 1 }, expect: ["corrupt-binding"] },
			{ label: "corrupt-garbage", block: "garbage", expect: ["corrupt-binding"] },
			{ label: "unavailable", block: unavailableEvidenceBlock("git status failed: boom"), expect: ["unavailable-binding"] },
		];
		for (const c of cases) {
			const raw = JSON.parse(JSON.stringify(originalRaw)) as Record<string, unknown>;
			if (c.block === undefined) delete raw.validation_evidence;
			else raw.validation_evidence = c.block;
			const mutated = await persistManifest(dir, runId, raw);
			assert.deepEqual(await assess(dir, mutated), rerun(c.expect), c.label);
		}
	});
});

// ---------------------------------------------------------------------------
// Every bound component refuses (fixed order, assessment level)
// ---------------------------------------------------------------------------

test("diff, lockfile, config, gate schema, profile, mode and commit changes refuse", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir, { ignoreLockfiles: true });
		const { manifest } = await runRecipeRun(dir, "hello");
		assert.deepEqual(await assess(dir, manifest), REUSABLE, "clean state first");

		const cases: Array<{
			label: string;
			mutate: () => Promise<void>;
			revert: () => Promise<void>;
			expect: ValidationRefusalReason[];
			mode?: WorkbenchMode;
		}> = [
			{
				label: "diff",
				mutate: async () => { await writeFile(join(dir, "dirty.txt"), "x", "utf8"); },
				revert: async () => { await rm(join(dir, "dirty.txt"), { force: true }); },
				expect: ["diff-mismatch"],
			},
			{
				label: "lockfile",
				mutate: async () => { await writeFile(join(dir, "package-lock.json"), "v1", "utf8"); },
				revert: async () => { await rm(join(dir, "package-lock.json"), { force: true }); },
				expect: ["dependencies-mismatch"],
			},
			{
				label: "config",
				mutate: async () => { await writeConfigFile(dir, "project.yaml", "name: validation-assessment-test\nprofile: generic\ndescription: changed\n"); },
				revert: async () => { await writeConfigFile(dir, "project.yaml", "name: validation-assessment-test\nprofile: generic\n"); },
				expect: ["config-mismatch"],
			},
			{
				label: "gate-schema",
				mutate: async () => { await writeConfigFile(dir, "gates.yaml", gatesYaml(`  - { id: gX, title: X, checks: [{ id: gX.1, kind: config }] }`)); },
				revert: async () => { await writeConfigFile(dir, "gates.yaml", GATES_YAML_EMPTY); },
				expect: ["config-mismatch", "gate-state-mismatch"],
			},
			{
				label: "profile",
				mutate: async () => { await writeConfigFile(dir, "project.yaml", "name: validation-assessment-test\nprofile: other\n"); },
				revert: async () => { await writeConfigFile(dir, "project.yaml", "name: validation-assessment-test\nprofile: generic\n"); },
				expect: ["config-mismatch", "profile-mismatch"],
			},
			{
				label: "mode",
				mutate: async () => {},
				revert: async () => {},
				expect: ["mode-mismatch"],
				mode: "VERIFY",
			},
			{
				label: "commit",
				mutate: async () => {
					await writeFile(join(dir, "dirty.txt"), "x", "utf8");
					await spawnExec("git", ["add", "dirty.txt"], { cwd: dir });
					await spawnExec("git", ["commit", "-qm", "second"], { cwd: dir });
				},
				revert: async () => {},
				expect: ["commit-mismatch"],
			},
		];
		for (const c of cases) {
			await c.mutate();
			const verdict = await assess(dir, manifest, c.mode !== undefined ? { mode: c.mode } : {});
			assert.deepEqual(verdict, rerun(c.expect), c.label);
			await c.revert();
		}
	});
});

test("recipe definition/cwd change, recipe removal and collection failure refuse", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const { manifest } = await runRecipeRun(dir, "hello");
		assert.deepEqual(await assess(dir, manifest), REUSABLE, "clean state first");

		// Definition change (command) — config hash AND target both differ.
		await writeConfigFile(dir, "recipes.yaml", RECIPES_YAML.replace('command: [node, -e, "process.exit(0)"]', 'command: [node, "--version"]'));
		assert.deepEqual(await assess(dir, manifest), rerun(["config-mismatch", "target-mismatch"]), "recipe definition change");
		await writeConfigFile(dir, "recipes.yaml", RECIPES_YAML);

		// Declared cwd change — config hash AND target both differ.
		await writeConfigFile(dir, "recipes.yaml", RECIPES_YAML.replace("    description: exits zero\n", "    description: exits zero\n    cwd: sub\n"));
		assert.deepEqual(await assess(dir, manifest), rerun(["config-mismatch", "target-mismatch"]), "recipe cwd change");
		await writeConfigFile(dir, "recipes.yaml", RECIPES_YAML);

		// Removal short-circuits before collection: target-mismatch only.
		await writeConfigFile(dir, "recipes.yaml", "recipes: []\n");
		assert.deepEqual(await assess(dir, manifest), rerun(["target-mismatch"]), "recipe removal");

		// Collection failure at assessment time (unavailable git status).
		await writeConfigFile(dir, "recipes.yaml", RECIPES_YAML);
		const failingGit: ExecFn = async (command, args) => {
			if (command === "git" && args[0] === "status") return { stdout: "", stderr: "fatal: repository corrupted", code: 128, killed: false };
			return { stdout: "", stderr: "", code: 0, killed: false };
		};
		assert.deepEqual(await assess(dir, manifest, { exec: failingGit }), rerun(["collection-failure"]));
	});
});

// ---------------------------------------------------------------------------
// Gate runs: persisted manual-evidence map fix + strict artifacts
// ---------------------------------------------------------------------------

test("successful Sol gate with padded manual input plus extra unknown keys is REUSABLE and privacy-safe", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir, { gatesYaml: gatesYaml(`${MANUAL_GATE("g1", "g1.1")}${MANUAL_GATE("g2", "g2.1")}`) });
		const SECRET = "manual-super-secret-note-text";

		const result = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "g1.1": `  ${SECRET}  `, "g2.1": "not this run", "ghost-check": "unknown caller key" },
			actorFacts: SOL_FACTS,
		});
		assert.equal(result.ok, true);
		assert.equal(result.gates[0]!.status, "PASS");

		// The persisted evidence.json carries ONLY the real manual entry,
		// with the trimmed note — the exact map the binding must hash.
		const evidencePath = join(result.runDir, "evidence.json");
		const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as { checks: Record<string, { evidence: Array<{ type: string; check_id: string; detail: string }> }> };
		assert.deepEqual(Object.keys(evidence.checks), ["g1.1"], "extra caller keys never persist");
		assert.equal(evidence.checks["g1.1"]!.evidence[0]!.detail, SECRET, "the persisted note is the trimmed note");

		const manifest = await readManifest(dir, result.runId);
		assert.ok(manifest, "gate manifest must be readable");
		const verdict = await assess(dir, manifest);
		assert.deepEqual(verdict, REUSABLE, "whitespace-padded input + extra unknown caller keys round-trip to REUSABLE");

		// Direct invariant: the binding hashes EXACTLY the persisted map
		// ({g1.1: trimmed}) — had any extra/unknown caller key entered the
		// binding, the hash could not be reproduced from the persisted
		// evidence and the round trip above would refuse.
		const binding = manifest.validation_evidence?.binding;
		assert.equal(binding?.kind, "gate");
		if (binding?.kind === "gate") {
			const config = await loadProjectConfig(dir, { trusted: true });
			assert.equal(
				binding.gate_state_hash,
				gateStateHash({
					profile: binding.profile,
					projectGates: config.gates,
					manualEvidence: { "g1.1": SECRET },
					workerFirstFacts: undefined,
					actorFacts: SOL_FACTS,
					prerequisiteStatus: {},
				}),
				"the gate binding hashes exactly the persisted type=manual evidence map",
			);
		}

		// Privacy: the raw manual text never appears in the assessment
		// output serialization nor in the persisted validation binding.
		assert.ok(!JSON.stringify(verdict).includes(SECRET), "assessment output must never render manual evidence text");
		assert.ok(!JSON.stringify(manifest.validation_evidence).includes(SECRET), "the binding persists hashes only");
		assert.ok(!JSON.stringify(manifest.validation_evidence).includes("ghost-check"), "unknown caller keys never enter the binding");
	});
});

test("strict gate artifacts: manual tamper, foreign schema and missing evidence file refuse", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir, { gatesYaml: gatesYaml(MANUAL_GATE("g1", "g1.1")) });
		const result = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "g1.1": "original note" },
			actorFacts: SOL_FACTS,
		});
		assert.equal(result.ok, true);
		const manifest = await readManifest(dir, result.runId);
		assert.ok(manifest, "gate manifest must be readable");
		assert.deepEqual(await assess(dir, manifest), REUSABLE, "clean artifacts first");

		const evidencePath = join(result.runDir, "evidence.json");

		// Manual-note tamper: the recovered map changes the gate-state hash.
		const tampered = JSON.parse(await readFile(evidencePath, "utf8")) as { schema_version: number; checks: Record<string, { evidence: Array<{ detail: string }> }> };
		tampered.checks["g1.1"]!.evidence[0]!.detail = "TAMPERED-NOTE";
		await writeFile(evidencePath, JSON.stringify(tampered, null, 2), "utf8");
		assert.deepEqual(await assess(dir, manifest), rerun(["collection-failure"]), "manual artifact tamper invalidates the committed transaction");

		// Foreign evidence schema version: contradictory source evidence.
		tampered.schema_version = 99;
		await writeFile(evidencePath, JSON.stringify(tampered, null, 2), "utf8");
		assert.deepEqual(await assess(dir, manifest), rerun(["collection-failure"]), "foreign evidence schema");

		// Missing evidence file: fail closed, never reuse.
		await rm(evidencePath);
		assert.deepEqual(await assess(dir, manifest), rerun(["collection-failure"]), "missing evidence file");
	});
});

test("gate target/catalog change refuses with target-mismatch", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir, {
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }`),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(result.gates[0]!.status, "PASS");
		const manifest = await readManifest(dir, result.runId);
		assert.ok(manifest, "gate manifest must be readable");
		assert.deepEqual(await assess(dir, manifest), REUSABLE, "clean catalog first");

		// The persisted gate is renamed: today's catalog cannot reproduce it.
		await writeConfigFile(dir, "gates.yaml", gatesYaml(`  - id: g1b\n    title: G1\n    checks:\n      - { id: g1b.1, title: Config, kind: config }`));
		assert.deepEqual(await assess(dir, manifest), rerun(["target-mismatch"]), "renamed gate");

		// The persisted gate is removed entirely.
		await writeConfigFile(dir, "gates.yaml", GATES_YAML_EMPTY);
		assert.deepEqual(await assess(dir, manifest), rerun(["target-mismatch"]), "removed gate");
	});
});

test("prerequisite status change refuses with gate-state-mismatch", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir, { gatesYaml: PREREQ_GATES });
		const run1 = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec, manualEvidence: { "g1.1": "ok" }, actorFacts: SOL_FACTS });
		assert.equal(run1.gates[0]!.status, "PASS");

		const run2 = await runGates({ projectRoot: dir, selector: "g2", mode: "DEV", exec: spawnExec, manualEvidence: { "g2.1": "ok" }, actorFacts: SOL_FACTS });
		assert.equal(run2.gates[0]!.status, "PASS");
		assert.equal(run2.gates[0]!.prerequisite_status["g1"]!.status, "PASS");
		const manifest2 = await readManifest(dir, run2.runId);
		assert.ok(manifest2, "gate manifest must be readable");
		assert.deepEqual(await assess(dir, manifest2), REUSABLE, "unchanged prerequisite state first");

		// A NEWER run of g1 changes its latest persisted status to NOT_RUN:
		// the current prerequisite re-resolution must refuse reuse.
		const run3 = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(run3.gates[0]!.status, "NOT_RUN");
		assert.deepEqual(await assess(dir, manifest2), rerun(["gate-state-mismatch"]), "prerequisite status change");
	});
});

test("worker and actor fact changes refuse with gate-state-mismatch", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir, { gatesYaml: gatesYaml(MANUAL_GATE("g1", "g1.1")) });
		const facts = cleanWorkerFacts();
		const result = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "g1.1": "note" },
			workerFirstFacts: facts,
			actorFacts: SOL_FACTS,
		});
		assert.equal(result.gates[0]!.status, "PASS");
		const manifest = await readManifest(dir, result.runId);
		assert.ok(manifest, "gate manifest must be readable");

		assert.deepEqual(await assess(dir, manifest, { workerFirstFacts: facts }), REUSABLE, "same facts first");

		// Worker-first fact change.
		assert.deepEqual(
			await assess(dir, manifest, { workerFirstFacts: cleanWorkerFacts({ reviewStatus: "REVIEWED" }) }),
			rerun(["gate-state-mismatch"]),
			"worker-first facts change",
		);
		// Facts missing entirely (null projection).
		assert.deepEqual(await assess(dir, manifest, { workerFirstFacts: undefined }), rerun(["gate-state-mismatch"]), "missing worker-first facts");

		// Actor fact change that keeps the Sol owner (provider swap): the
		// bounded actor hash differs but the owner stays sol.
		assert.deepEqual(
			await assess(dir, manifest, { workerFirstFacts: facts, actorFacts: { role: undefined, provider: "openai", model: "gpt-5.6-sol" } }),
			rerun(["gate-state-mismatch"]),
			"actor facts change",
		);
	});
});
