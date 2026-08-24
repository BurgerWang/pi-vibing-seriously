import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { runRecipe } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import { runGates } from "../extensions/workbench-runtime/core/gate-engine.ts";
import {
	listCommittedRuns,
	listRunAttempts,
	listRuns,
	readCommittedManifest,
	readManifest,
	RUN_SCHEMA_VERSION,
} from "../extensions/workbench-runtime/core/runs.ts";
import { beginRunTransaction, commitRunTransaction, readCommittedRunTransaction } from "../extensions/workbench-runtime/core/run-transaction.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";

function recipesYaml(command: string, artifact: string): string {
	return [
		"recipes:",
		"  - name: producer",
		`    command: ${command}`,
		"    writes: [out/]",
		"    mutation: artifacts",
		`    artifacts: [${artifact}]`,
		"",
	].join("\n");
}

const CURRENT_REQUIRED = '{ path: "out/*.json", required: true, min_count: 1, max_count: 1, min_bytes: 1, freshness: current }';
const SNAPSHOT_REQUIRED = '{ path: "out/*.json", required: true, min_count: 1, max_count: 1, min_bytes: 1, freshness: immutable-snapshot, snapshot: true }';
const PRODUCE = '["node", "-e", "require(\\"fs\\").mkdirSync(\\"out\\",{recursive:true});require(\\"fs\\").writeFileSync(\\"out/result.json\\",\\"one\\")"]';
const NO_OUTPUT = '["node", "-e", "process.exit(0)"]';
const FAIL = '["node", "-e", "process.exit(3)"]';
const SOL_FACTS = { role: undefined, provider: "openai-codex", model: "gpt-5.6-sol" };

async function setup(dir: string, command = PRODUCE, artifact = CURRENT_REQUIRED): Promise<void> {
	await writeConfigFile(dir, "project.yaml", "name: run-v2\nprofile: generic\n");
	await writeConfigFile(dir, "recipes.yaml", recipesYaml(command, artifact));
	await writeConfigFile(
		dir,
		"gates.yaml",
		[
			"gates:",
			"  - id: g1",
			"    title: artifact authority",
			"    checks:",
			"      - { id: g1.1, title: output, kind: artifact, artifact_recipe: producer, glob: 'out/*.json' }",
			"",
		].join("\n"),
	);
}

/** Git-backed authority fixture; run records remain outside current-state hashes. */
async function gitBacked(dir: string): Promise<void> {
	await writeFile(join(dir, ".gitignore"), ".pi/\n", "utf8");
	await spawnExec("git", ["init", "-q"], { cwd: dir });
	await spawnExec("git", ["config", "user.email", "t@t"], { cwd: dir });
	await spawnExec("git", ["config", "user.name", "t"], { cwd: dir });
	await spawnExec("git", ["add", "-A"], { cwd: dir });
	await spawnExec("git", ["commit", "-qm", "init"], { cwd: dir });
}

async function writeMinimalRunPayload(directory: string, runId: string, marker: string): Promise<void> {
	await writeFile(join(directory, "manifest.json"), JSON.stringify({
		schema_version: 2,
		run_id: runId,
		recipe: "test",
		profile: "generic",
		started_at: "2026-08-20T19:15:00.000Z",
		finished_at: "2026-08-20T19:15:00.001Z",
		duration_ms: 1,
		cwd: directory,
		argv: ["test"],
		exit_code: 0,
		timed_out: false,
		cancelled: false,
		git_commit: null,
		git_dirty: false,
		artifact_paths: [],
		stdout_truncated: false,
		stderr_truncated: false,
		mode: "DEV",
		expected_exit_codes: [0],
		declared_writes: [],
		environment_names: [],
		validation_components: [],
		cache_request_mode: "no-cache",
		run_transaction_schema_version: 2,
		run_outcome: "SUCCESS",
	}), "utf8");
	await writeFile(join(directory, "command.json"), "{}", "utf8");
	await writeFile(join(directory, "environment.json"), "{}", "utf8");
	await writeFile(join(directory, "summary.json"), marker, "utf8");
	await writeFile(join(directory, "stdout.log"), "", "utf8");
	await writeFile(join(directory, "stderr.log"), "", "utf8");
}

test("exit zero with a missing required artifact commits a failed diagnostic run, never SUCCESS", async () => {
	await withTempDir(async (dir) => {
		await setup(dir, NO_OUTPUT);
		const result = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec });
		assert.equal(result.ok, false);
		assert.equal(result.error, "REQUIRED_ARTIFACT_MISSING");
		assert.equal(result.record?.exit_code, 0, "process outcome remains truthful");
		assert.equal(result.record?.run_outcome, "ARTIFACT_FAILED");
		assert.ok(result.runDir, "the failed diagnostic is still atomically committed");
		assert.equal((await readCommittedManifest(dir, result.record!.run_id))?.run_outcome, "ARTIFACT_FAILED");
	});
});

test("artifact byte, count and declared hash bounds fail closed", async () => {
	await withTempDir(async (dir) => {
		const zero = '["node", "-e", "require(\\"fs\\").mkdirSync(\\"out\\",{recursive:true});require(\\"fs\\").writeFileSync(\\"out/zero.json\\",\\"\\")"]';
		await setup(dir, zero, '{ path: "out/*.json", required: true, min_bytes: 1 }');
		assert.equal((await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec })).error, "ARTIFACT_IDENTITY_FAILED");

		const two = '["node", "-e", "require(\\"fs\\").mkdirSync(\\"out\\",{recursive:true});require(\\"fs\\").writeFileSync(\\"out/a.json\\",\\"a\\");require(\\"fs\\").writeFileSync(\\"out/b.json\\",\\"b\\")"]';
		await setup(dir, two, '{ path: "out/*.json", required: true, max_count: 1 }');
		assert.equal((await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec })).error, "ARTIFACT_COUNT_INVALID");

		await setup(dir, PRODUCE, `{ path: "out/result.json", required: true, sha256: "${"0".repeat(64)}" }`);
		assert.equal((await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec })).error, "ARTIFACT_IDENTITY_FAILED");
	});
});

test("partial visible directories and post-commit mutation are never consumable", async () => {
	await withTempDir(async (dir) => {
		const partialId = "20260820-190000-part";
		const partialDir = join(dir, CONFIG_DIR_NAME, "workbench", "runs", partialId);
		await mkdir(partialDir, { recursive: true });
		await writeFile(join(partialDir, "manifest.json"), JSON.stringify({
			schema_version: 2,
			run_id: partialId,
			recipe: "producer",
			started_at: "2026-08-20T19:00:00.000Z",
			finished_at: "2026-08-20T19:00:00.001Z",
			duration_ms: 1,
			exit_code: 0,
			timed_out: false,
			cancelled: false,
			artifact_paths: [],
			run_transaction_schema_version: 2,
			run_outcome: "SUCCESS",
		}), "utf8");
		assert.equal(await readCommittedManifest(dir, partialId), null);
		assert.equal((await listCommittedRuns(dir, 10)).length, 0);
		assert.equal((await listRuns(dir, 10)).length, 0, "the normal run list excludes uncommitted v2 attempts");
		assert.equal((await listRunAttempts(dir, 10))[0]?.run_id, partialId, "diagnostics can still explain the attempt");

		await setup(dir);
		const committed = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec });
		assert.equal(committed.ok, true, committed.error ?? "");
		assert.ok(await readCommittedManifest(dir, committed.record!.run_id));
		await writeFile(join(committed.runDir!, "stdout.log"), "mutated", "utf8");
		assert.equal(await readCommittedManifest(dir, committed.record!.run_id), null, "committed inventory detects replacement");
	});
});

test("new v2 manifests are rejected by the frozen v1 discriminator", async () => {
	await withTempDir(async (dir) => {
		await setup(dir);
		const run = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(run.ok, true, run.error ?? "");
		const raw = JSON.parse(await readFile(join(run.runDir!, "manifest.json"), "utf8")) as Record<string, unknown>;
		const frozenV1ReaderWouldAccept = raw.schema_version === RUN_SCHEMA_VERSION;
		assert.equal(raw.schema_version, 2);
		assert.equal(frozenV1ReaderWouldAccept, false, "rollback code that only accepts schema v1 cannot consume a new v2 run");
		assert.ok(await readCommittedManifest(dir, run.record!.run_id), "the current strict v2 reader accepts the committed record");
	});
});

test("legacy v1 remains read-only while ambiguous and unknown manifests fail closed", async () => {
	await withTempDir(async (dir) => {
		await setup(dir);
		const runsRoot = join(dir, CONFIG_DIR_NAME, "workbench", "runs");
		const legacyId = "20991231-235957-v1ok";
		const legacyDir = join(runsRoot, legacyId);
		await mkdir(legacyDir, { recursive: true });
		await writeFile(join(legacyDir, "manifest.json"), JSON.stringify({
			schema_version: 1,
			run_id: legacyId,
			recipe: "producer",
			started_at: "2099-12-31T23:59:57.000Z",
			finished_at: "2099-12-31T23:59:57.001Z",
			duration_ms: 1,
			exit_code: 0,
			timed_out: false,
			cancelled: false,
			artifact_paths: ["out/result.json"],
		}), "utf8");
		assert.equal((await readManifest(dir, legacyId))?.run_id, legacyId, "valid historical v1 is still readable");
		assert.equal(await readCommittedManifest(dir, legacyId), null, "historical v1 cannot become v2 authority");
		assert.equal((await listRuns(dir, 10))[0]?.run_id, legacyId, "normal history listing keeps read-only v1 visibility");
		const gate = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(gate.status, "FAIL", "legacy v1 cannot satisfy a current artifact gate");
		assert.match(gate.gates[0]!.checks[0]!.failure_reason ?? "", /failed committed identity verification/);

		const ambiguousId = "20991231-235958-mixd";
		const ambiguousDir = join(runsRoot, ambiguousId);
		await mkdir(ambiguousDir);
		await writeFile(join(ambiguousDir, "manifest.json"), JSON.stringify({
			schema_version: 1,
			run_id: ambiguousId,
			recipe: "producer",
			run_transaction_schema_version: 2,
			run_outcome: "SUCCESS",
		}), "utf8");
		assert.equal(await readManifest(dir, ambiguousId), null, "mixed v1/v2 authority is rejected instead of guessed");

		const unknownId = "20991231-235959-unkn";
		const unknownDir = join(runsRoot, unknownId);
		await mkdir(unknownDir);
		await writeFile(join(unknownDir, "manifest.json"), JSON.stringify({ schema_version: 99, run_id: unknownId, recipe: "producer" }), "utf8");
		assert.equal(await readManifest(dir, unknownId), null, "unknown future schemas fail closed");
	});
});

test("current artifacts are rehashed at gate time", async () => {
	await withTempDir(async (dir) => {
		await setup(dir);
		await gitBacked(dir);
		const run = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(run.ok, true, run.error ?? "");
		const initialGate = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(initialGate.status, "PASS", initialGate.gates[0]?.checks[0]?.failure_reason ?? "initial artifact gate failed");
		await writeFile(join(dir, "out", "result.json"), "two", "utf8");
		const changed = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(changed.status, "FAIL");
		assert.match(changed.gates[0]!.checks[0]!.failure_reason ?? "", /invalid artifact authority/);
		await writeFile(join(dir, "out", "result.json"), "one", "utf8");
		assert.equal((await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec })).status, "PASS");
		const { unlink, symlink } = await import("node:fs/promises");
		await unlink(join(dir, "out", "result.json"));
		await writeFile(join(dir, "out", "replacement.json"), "one", "utf8");
		await symlink("replacement.json", join(dir, "out", "result.json"));
		assert.equal((await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec })).status, "FAIL", "a same-content symlink replacement is not the original current artifact identity");
	});
});

test("immutable snapshot authority survives source deletion and detects snapshot corruption", async () => {
	await withTempDir(async (dir) => {
		await setup(dir, PRODUCE, SNAPSHOT_REQUIRED);
		await gitBacked(dir);
		const run = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(run.ok, true, run.error ?? "");
		const artifactManifest = JSON.parse(await readFile(join(run.runDir!, "artifact-manifest.json"), "utf8")) as { artifacts: Array<{ snapshot_path: string }> };
		await import("node:fs/promises").then(({ unlink }) => unlink(join(dir, "out", "result.json")));
		const snapshotGate = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(snapshotGate.status, "PASS", snapshotGate.gates[0]?.checks[0]?.failure_reason ?? "immutable artifact gate failed");
		await writeFile(join(run.runDir!, artifactManifest.artifacts[0]!.snapshot_path), "corrupt", "utf8");
		const corrupt = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(corrupt.status, "FAIL");
	});
});

test("a newer committed failed run blocks the artifact gate instead of falling back", async () => {
	await withTempDir(async (dir) => {
		await setup(dir);
		const success = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec });
		assert.equal(success.ok, true);
		await writeConfigFile(dir, "recipes.yaml", recipesYaml(FAIL, CURRENT_REQUIRED));
		const failed = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec });
		assert.equal(failed.ok, false);
		assert.equal(failed.record?.run_outcome, "PROCESS_FAILED");
		const gate = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(gate.status, "FAIL");
		assert.match(gate.gates[0]!.checks[0]!.failure_reason ?? "", /not a successful committed run/);
		assert.match(gate.gates[0]!.checks[0]!.failure_reason ?? "", new RegExp(failed.record!.run_id));
	});
});

test("a newer partial same-recipe run blocks instead of falling back to an older success", async () => {
	await withTempDir(async (dir) => {
		await setup(dir);
		const success = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec });
		assert.equal(success.ok, true);
		const partialId = "20991231-235959-newr";
		const partialDir = join(dir, CONFIG_DIR_NAME, "workbench", "runs", partialId);
		await mkdir(partialDir, { recursive: true });
		await writeFile(join(partialDir, "manifest.json"), JSON.stringify({
			schema_version: 2,
			run_id: partialId,
			recipe: "producer",
			started_at: "2099-12-31T23:59:59.000Z",
			finished_at: "2099-12-31T23:59:59.001Z",
			duration_ms: 1,
			exit_code: 0,
			timed_out: false,
			cancelled: false,
			artifact_paths: ["out/result.json"],
			run_transaction_schema_version: 2,
			run_outcome: "SUCCESS",
		}, null, 2), "utf8");
		const gate = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(gate.status, "FAIL");
		assert.match(gate.gates[0]!.checks[0]!.failure_reason ?? "", /failed committed identity verification/);
		assert.match(gate.gates[0]!.checks[0]!.failure_reason ?? "", /20991231-235959-newr/);
	});
});

test("a newer forged v1 manifest cannot redirect artifact authority to an older committed success", async () => {
	await withTempDir(async (dir) => {
		await setup(dir);
		await gitBacked(dir);
		const success = await runRecipe({
			projectRoot: dir,
			recipeName: "producer",
			mode: "DEV",
			exec: spawnExec,
			actorFacts: SOL_FACTS,
		});
		assert.equal(success.ok, true, success.error ?? "");
		const initialGate = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			actorFacts: SOL_FACTS,
		});
		assert.equal(initialGate.status, "PASS", initialGate.gates[0]?.checks[0]?.failure_reason ?? "");

		const forgedDirectoryId = "20991231-235959-fake";
		const forgedDirectory = join(dir, CONFIG_DIR_NAME, "workbench", "runs", forgedDirectoryId);
		await mkdir(forgedDirectory, { recursive: true });
		const forgedManifest = JSON.parse(await readFile(join(success.runDir!, "manifest.json"), "utf8")) as Record<string, unknown>;
		forgedManifest.schema_version = 1;
		forgedManifest.run_id = success.record!.run_id;
		delete forgedManifest.run_transaction_schema_version;
		delete forgedManifest.run_outcome;
		delete forgedManifest.artifact_manifest_path;
		await writeFile(join(forgedDirectory, "manifest.json"), JSON.stringify(forgedManifest), "utf8");

		const attacked = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			actorFacts: SOL_FACTS,
		});
		assert.equal(attacked.status, "FAIL", "the old committed artifact authority must not be followed");
		assert.match(attacked.gates[0]!.checks[0]!.failure_reason ?? "", new RegExp(forgedDirectoryId));
		assert.equal(attacked.gates[0]!.checks[0]!.evidence[0]!.run_id, forgedDirectoryId);
		assert.equal(attacked.gates[0]!.checks[0]!.evidence[0]!.detail, "run_identity_mismatch");
	});
});

test("rename failure cannot publish a committed run", async () => {
	await withTempDir(async (dir) => {
		const runId = "20260820-191000-rnme";
		const transaction = await beginRunTransaction(dir, runId);
		await writeMinimalRunPayload(transaction.stagingDir, runId, "rename");
		await mkdir(transaction.finalDir);
		await writeFile(join(transaction.finalDir, "foreign"), "occupied", "utf8");
		await assert.rejects(commitRunTransaction(transaction, new Date("2026-08-20T19:10:00.000Z")));
		assert.equal((await readCommittedRunTransaction(dir, runId)).ok, false);
	});
});

test("commit rejects incomplete v2 manifest shapes and terminal-outcome contradictions", async () => {
	await withTempDir(async (dir) => {
		const incompleteId = "20260820-191100-shap";
		const incomplete = await beginRunTransaction(dir, incompleteId);
		await writeMinimalRunPayload(incomplete.stagingDir, incompleteId, "shape");
		const incompletePath = join(incomplete.stagingDir, "manifest.json");
		const incompleteManifest = JSON.parse(await readFile(incompletePath, "utf8")) as Record<string, unknown>;
		delete incompleteManifest.expected_exit_codes;
		await writeFile(incompletePath, JSON.stringify(incompleteManifest), "utf8");
		await assert.rejects(commitRunTransaction(incomplete, new Date("2026-08-20T19:11:00.000Z")), /manifest readback invalid/);

		const contradictionId = "20260820-191101-outc";
		const contradiction = await beginRunTransaction(dir, contradictionId);
		await writeMinimalRunPayload(contradiction.stagingDir, contradictionId, "outcome");
		const contradictionPath = join(contradiction.stagingDir, "manifest.json");
		const contradictionManifest = JSON.parse(await readFile(contradictionPath, "utf8")) as Record<string, unknown>;
		contradictionManifest.run_outcome = "PROCESS_FAILED";
		await writeFile(contradictionPath, JSON.stringify(contradictionManifest), "utf8");
		await assert.rejects(commitRunTransaction(contradiction, new Date("2026-08-20T19:11:01.000Z")), /manifest readback invalid/);
	});
});

test("a missing required run payload file cannot produce a commit marker", async () => {
	await withTempDir(async (dir) => {
		const runId = "20260820-191200-miss";
		const transaction = await beginRunTransaction(dir, runId);
		await writeMinimalRunPayload(transaction.stagingDir, runId, "missing");
		await import("node:fs/promises").then(({ unlink }) => unlink(join(transaction.stagingDir, "environment.json")));
		await assert.rejects(commitRunTransaction(transaction, new Date("2026-08-20T19:12:00.000Z")), /missing environment\.json/);
		assert.equal((await readCommittedRunTransaction(dir, runId)).ok, false);
	});
});

test("concurrent transactions for one run id publish exactly one immutable winner", async () => {
	await withTempDir(async (dir) => {
		const runId = "20260820-191500-race";
		const first = await beginRunTransaction(dir, runId);
		const second = await beginRunTransaction(dir, runId);
		await writeMinimalRunPayload(first.stagingDir, runId, "first");
		await writeMinimalRunPayload(second.stagingDir, runId, "second");
		const outcomes = await Promise.allSettled([
			commitRunTransaction(first, new Date("2026-08-20T19:15:00.000Z")),
			commitRunTransaction(second, new Date("2026-08-20T19:15:00.000Z")),
		]);
		assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
		assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
		assert.equal((await readCommittedRunTransaction(dir, runId)).ok, true);
	});
});

test("authorized external artifacts require explicit config and an independent process probe", async () => {
	await withTempDir(async (projectRoot) => {
		await withTempDir(async (externalRoot) => {
			await writeFile(join(externalRoot, "result.json"), "external", "utf8");
			await writeConfigFile(projectRoot, "project.yaml", `name: external\nprofile: generic\nartifact_external_roots:\n  warehouse: ${JSON.stringify(externalRoot)}\n`);
			await writeConfigFile(
				projectRoot,
				"recipes.yaml",
				[
					"recipes:",
					"  - name: external",
					'    command: ["node", "-e", "process.exit(0)"]',
					'    artifacts: [{ path: "*.json", root: authorized-external, external_root: warehouse, required: true, min_bytes: 1, freshness: current }]',
					"",
				].join("\n"),
			);
			await writeConfigFile(projectRoot, "gates.yaml", [
				"gates:",
				"  - id: g1",
				"    title: external artifact",
				"    checks:",
				"      - { id: g1.1, title: output, kind: artifact, artifact_recipe: external, glob: 'external:warehouse/*.json' }",
				"",
			].join("\n"));
			await gitBacked(projectRoot);
			let probes = 0;
			const exec: ExecFn = async (command, args, options) => {
				if (command === process.execPath && args[0] === "-e") probes += 1;
				return spawnExec(command, args, options);
			};
			const result = await runRecipe({ projectRoot, recipeName: "external", mode: "DEV", exec, actorFacts: SOL_FACTS });
			assert.equal(result.ok, true, result.error ?? "");
			assert.equal(probes, 1, "the external artifact is re-opened by exactly one separate probe process");
			assert.deepEqual(result.record?.artifact_paths, ["external:warehouse/result.json"]);
			assert.equal((await runGates({ projectRoot, selector: "g1", mode: "DEV", exec })).status, "PASS");
			assert.equal(probes, 2, "gate consumption performs a fresh independent probe");
			await writeFile(join(externalRoot, "result.json"), "changed", "utf8");
			assert.equal((await runGates({ projectRoot, selector: "g1", mode: "DEV", exec })).status, "FAIL");
		});
	});
});

test("external artifact roots fail closed when unauthorized or changed before the probe", async () => {
	await withTempDir(async (projectRoot) => {
		await withTempDir(async (externalRoot) => {
			const artifact = join(externalRoot, "result.json");
			await writeFile(artifact, "before", "utf8");
			const recipeYaml = [
				"recipes:",
				"  - name: external",
				'    command: ["node", "-e", "process.exit(0)"]',
				'    artifacts: [{ path: "*.json", root: authorized-external, external_root: warehouse, required: true, freshness: current }]',
				"",
			].join("\n");
			await writeConfigFile(projectRoot, "project.yaml", "name: external\nprofile: generic\n");
			await writeConfigFile(projectRoot, "recipes.yaml", recipeYaml);
			const unauthorized = await runRecipe({ projectRoot, recipeName: "external", mode: "DEV", exec: spawnExec });
			assert.equal(unauthorized.ok, false);
			assert.equal(unauthorized.error, "EXTERNAL_ROOT_UNAUTHORIZED");

			await writeConfigFile(projectRoot, "project.yaml", `name: external\nprofile: generic\nartifact_external_roots:\n  warehouse: ${JSON.stringify(externalRoot)}\n`);
			let changed = false;
			const changingExec: ExecFn = async (command, args, options) => {
				if (!changed && command === process.execPath && args[0] === "-e") {
					changed = true;
					await writeFile(artifact, "after", "utf8");
				}
				return spawnExec(command, args, options);
			};
			const raced = await runRecipe({ projectRoot, recipeName: "external", mode: "DEV", exec: changingExec });
			assert.equal(raced.ok, false);
			assert.equal(raced.error, "ARTIFACT_IDENTITY_FAILED");
		});
	});
});
