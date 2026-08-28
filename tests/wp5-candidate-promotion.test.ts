/** WP5 frozen Candidate, Candidate-bound Gate, promotion, and release provenance. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readCandidateAliasV1 } from "../extensions/workbench-runtime/core/candidate.ts";
import { compareRuns } from "../extensions/workbench-runtime/core/compare.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { readPersistedGateRunFacts, validatePersistedGateRunRecords } from "../extensions/workbench-runtime/core/gate-engine.ts";
import type { WorkerFirstGateFacts } from "../extensions/workbench-runtime/core/gate-schema.ts";
import { parsePromotionCommandArgsV1 } from "../extensions/workbench-runtime/core/promotion-command.ts";
import { promoteCandidateV1, readPromotionRecordV1 } from "../extensions/workbench-runtime/core/promotion.ts";
import { runRecipe } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import { latestGateRunSummary, readGateRunPage } from "../extensions/workbench-runtime/core/report.ts";
import { readCommittedManifest } from "../extensions/workbench-runtime/core/runs.ts";
import type { RecipeMutationFacts } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { initializeGitFixture, spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

const SOL_FACTS: RecipeMutationFacts = { provider: "openai-codex", model: "gpt-5.6-sol" };

const CLEAN_WORKER_FACTS: WorkerFirstGateFacts = {
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
};

const MANUAL_EVIDENCE = Object.fromEntries([
	"b2.2", "b2.3", "b3.2", "b3.3", "b4.1", "b4.2", "b4.3", "b5.1", "b5.2",
].map((id) => [id, `explicit user evidence for ${id}`]));

const RECIPES = `
recipes:
  - name: check
    command: [node, -e, "process.exit(0)"]
    mutation: none
    writes: []
    validation_components: [typecheck, unit-test, whitespace]
  - { name: check:format, command: [node, -e, "process.exit(0)"], mutation: none, writes: [] }
  - { name: check:lint, command: [node, -e, "process.exit(0)"], mutation: none, writes: [] }
  - { name: check:typecheck, command: [node, -e, "process.exit(0)"], mutation: none, writes: [] }
  - { name: check:static, command: [node, -e, "process.exit(0)"], mutation: none, writes: [] }
  - { name: test:unit, command: [node, -e, "process.exit(0)"], mutation: none, writes: [] }
  - { name: test:integration, command: [node, -e, "process.exit(0)"], mutation: none, writes: [] }
  - name: build
    command: [node, -e, "process.exit(0)"]
    mutation: none
    writes: []
    artifacts:
      - path: dist/release.txt
        required: true
        min_count: 1
        max_count: 1
        type: file
        min_bytes: 1
        max_bytes: 1024
        freshness: current
        snapshot: false
        root: project
`;

async function setup(root: string): Promise<void> {
	await writeFile(join(root, "package.json"), "{}\n", "utf8");
	await writeFile(join(root, "candidate.ts"), "export const candidate = 1;\n", "utf8");
	await writeFile(join(root, "dist-release-placeholder"), "tracked\n", "utf8");
	await writeConfigFile(root, "project.yaml", "name: wp5-fixture\nprofile: generic\n");
	await writeConfigFile(root, "recipes.yaml", RECIPES);
	await initializeGitFixture(root);
	await writeFile(join(root, "dist", "release.txt"), "release artifact\n", "utf8").catch(async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(root, "dist"), { recursive: true });
		await writeFile(join(root, "dist", "release.txt"), "release artifact\n", "utf8");
	});
	await spawnExec("git", ["add", "dist/release.txt"], { cwd: root });
	await spawnExec("git", ["commit", "-qm", "release fixture"], { cwd: root });
}

async function candidate(root: string, exec: ExecFn = spawnExec) {
	const result = await runRecipe({
		projectRoot: root,
		recipeName: "check",
		mode: "DEV",
		exec,
		actorFacts: SOL_FACTS,
	});
	assert.equal(result.ok, true);
	assert.ok(result.record);
	assert.ok(result.ordinaryCandidate);
	return result;
}

test("research promotion freezes one Candidate and binds all durable Gate facts to it", async () => {
	await withTempDir(async (root) => {
		await setup(root);
		const source = await candidate(root);
		const result = await promoteCandidateV1({
			projectRoot: root,
			target: "RESEARCH_ACCEPTED",
			expectedCandidateIdentity: source.ordinaryCandidate!.candidateIdentity,
			sourceRunId: source.record!.run_id,
			authorizationProvenance: "user-command",
			manualEvidence: MANUAL_EVIDENCE,
			workerFirstFacts: CLEAN_WORKER_FACTS,
			actorFacts: SOL_FACTS,
			exec: spawnExec,
		});
		assert.equal(result.ok, true, result.ok ? undefined : result.code);
		if (!result.ok) return;
		assert.equal(result.record.release_authority, false);
		assert.equal(result.record.profitability_authority, false);
		assert.equal(result.record.better_strategy_authority, false);
		assert.equal(result.record.release_provenance, null);

		const current = await readCandidateAliasV1(root, "current");
		const champion = await readCandidateAliasV1(root, "champion");
		assert.equal(current?.candidate_identity, source.ordinaryCandidate!.candidateIdentity);
		assert.equal(champion?.candidate_identity, source.ordinaryCandidate!.candidateIdentity);
		assert.equal(champion?.promotion_identity, result.record.promotion_identity);
		assert.deepEqual(await readPromotionRecordV1(root, result.record.promotion_identity), result.record);

		const manifest = await readCommittedManifest(root, result.gateRunId);
		assert.ok(manifest);
		assert.deepEqual(manifest!.candidate_binding, result.record.candidate_binding);
		assert.equal(manifest!.mode, "VERIFY");
		const facts = await readPersistedGateRunFacts(root, result.gateRunId, manifest!);
		assert.deepEqual(facts?.candidateBinding, result.record.candidate_binding);
		assert.equal((await latestGateRunSummary(root))?.candidate_identity, source.ordinaryCandidate!.candidateIdentity);
		const gatePage = await readGateRunPage({ projectRoot: root, runId: result.gateRunId, include: "summary" });
		assert.equal(gatePage.ok, true);
		if (gatePage.ok) assert.match(gatePage.text, new RegExp(`candidate ${source.ordinaryCandidate!.candidateIdentity}`, "u"));
		const compared = await compareRuns(root, result.gateRunId, result.gateRunId);
		assert.equal(compared.ok, true);
		if (compared.ok) assert.ok(compared.report.notes.some((note) => note.includes("same frozen Candidate")));

		const gates = JSON.parse(await readFile(join(root, ".pi", "workbench", "runs", result.gateRunId, "gates.json"), "utf8"));
		const evidence = JSON.parse(await readFile(join(root, ".pi", "workbench", "runs", result.gateRunId, "evidence.json"), "utf8"));
		assert.deepEqual(gates.candidate_binding, result.record.candidate_binding);
		assert.deepEqual(evidence.candidate_binding, result.record.candidate_binding);
		const tamperedEvidence = structuredClone(evidence);
		tamperedEvidence.candidate_binding.candidate_identity = "f".repeat(64);
		assert.equal(validatePersistedGateRunRecords(result.gateRunId, manifest!, gates, tamperedEvidence), null);
	});
});

test("failed promotion withholds champion but leaves DEV able to produce a new Candidate", async () => {
	await withTempDir(async (root) => {
		await setup(root);
		const source = await candidate(root);
		const failed = await promoteCandidateV1({
			projectRoot: root,
			target: "RESEARCH_ACCEPTED",
			expectedCandidateIdentity: source.ordinaryCandidate!.candidateIdentity,
			sourceRunId: source.record!.run_id,
			authorizationProvenance: "user-command",
			manualEvidence: {},
			workerFirstFacts: CLEAN_WORKER_FACTS,
			actorFacts: SOL_FACTS,
			exec: spawnExec,
		});
		assert.equal(failed.ok, false);
		if (failed.ok) return;
		assert.equal(failed.code, "GATES_NOT_PASS");
		assert.equal(await readCandidateAliasV1(root, "champion"), null);
		assert.equal((await readCandidateAliasV1(root, "current"))?.candidate_identity, source.ordinaryCandidate!.candidateIdentity);

		await writeFile(join(root, "candidate.ts"), "export const candidate = 2;\n", "utf8");
		const next = await candidate(root);
		assert.notEqual(next.ordinaryCandidate!.candidateIdentity, source.ordinaryCandidate!.candidateIdentity);
	});
});

test("release promotion requires explicit permission and traces exact source, build, inputs, and artifacts without push", async () => {
	await withTempDir(async (root) => {
		await setup(root);
		const gitCommands: string[][] = [];
		const exec: ExecFn = async (command, args, options) => {
			if (command === "git") gitCommands.push([...args]);
			return spawnExec(command, args, options);
		};
		const source = await candidate(root, exec);
		const build = await runRecipe({
			projectRoot: root,
			recipeName: "build",
			mode: "VERIFY",
			exec,
			actorFacts: SOL_FACTS,
		});
		assert.equal(build.ok, true);
		assert.ok(build.record);

		const refused = await promoteCandidateV1({
			projectRoot: root,
			target: "RELEASE_AUTHORIZED",
			expectedCandidateIdentity: source.ordinaryCandidate!.candidateIdentity,
			sourceRunId: source.record!.run_id,
			artifactRunId: build.record!.run_id,
			authorizationProvenance: "user-command",
			exec,
		});
		assert.deepEqual(refused, {
			ok: false,
			code: "RELEASE_AUTHORIZATION_REQUIRED",
			candidateIdentity: source.ordinaryCandidate!.candidateIdentity,
		});

		const promoted = await promoteCandidateV1({
			projectRoot: root,
			target: "RELEASE_AUTHORIZED",
			expectedCandidateIdentity: source.ordinaryCandidate!.candidateIdentity,
			sourceRunId: source.record!.run_id,
			artifactRunId: build.record!.run_id,
			authorizationProvenance: "user-command",
			releaseAuthorized: true,
			manualEvidence: MANUAL_EVIDENCE,
			workerFirstFacts: CLEAN_WORKER_FACTS,
			actorFacts: SOL_FACTS,
			exec,
		});
		assert.equal(promoted.ok, true, promoted.ok ? undefined : promoted.code);
		if (!promoted.ok) return;
		assert.equal(promoted.record.release_authority, true);
		assert.equal(promoted.record.release_provenance?.source.candidate_identity, source.ordinaryCandidate!.candidateIdentity);
		assert.equal(promoted.record.release_provenance?.source.candidate_source_run_id, source.record!.run_id);
		assert.equal(promoted.record.release_provenance?.build.run_id, build.record!.run_id);
		assert.match(promoted.record.release_provenance?.build.definition_hash ?? "", /^[0-9a-f]{64}$/u);
		assert.equal(promoted.record.release_provenance?.artifacts[0]?.path, "dist/release.txt");
		assert.match(promoted.record.release_provenance?.artifacts[0]?.sha256 ?? "", /^[0-9a-f]{64}$/u);
		assert.equal((await readCandidateAliasV1(root, "release-candidate"))?.promotion_identity, promoted.record.promotion_identity);
		assert.equal(gitCommands.some((args) => args[0] === "push"), false, "promotion must never push");
	});
});

test("q-promote grammar makes release permission explicit and rejects ambiguous flags", () => {
	const candidateId = "a".repeat(64);
	const sourceRun = "20260828-120000-abcd";
	const buildRun = "20260828-120100-efgh";
	assert.equal(parsePromotionCommandArgsV1(`release ${candidateId} ${sourceRun} --artifact-run ${buildRun}`).ok, false);
	const parsed = parsePromotionCommandArgsV1(`release ${candidateId} ${sourceRun} --artifact-run=${buildRun} --authorize-release manual:b2.2=evidence`);
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.target, "RELEASE_AUTHORIZED");
		assert.equal(parsed.releaseAuthorized, true);
		assert.equal(parsed.artifactRunId, buildRun);
		assert.deepEqual(parsed.manualEvidence, { "b2.2": "evidence" });
	}
	assert.equal(parsePromotionCommandArgsV1(`research ${candidateId} ${sourceRun} --authorize-release`).ok, false);
});
