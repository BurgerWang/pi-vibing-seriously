/**
 * P4 run report tests (P4 spec §4, §6) — /q-report latest|<run-id>.
 *
 * Facts only from the persisted run records (manifest.json, gates.json,
 * summary.json, run-attributed quant-result.json); unknown targets resolve
 * to null; gate runs get a gates/failed-checks section; quant runs get the
 * declared quant facts.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { runGates } from "../extensions/workbench-runtime/core/gate-engine.ts";
import { runRecipe } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import {
	buildRunReport,
	latestGateRunSummary,
	latestGateStatuses,
	readGateFileRecord,
	readGateRunPage,
	resolveRunTarget,
} from "../extensions/workbench-runtime/core/report.ts";
import {
	clearGateRunCandidateCacheForTests,
	GATE_ATTEMPT_INDEX_DIR,
	GATE_ATTEMPT_ORDER_DIR,
	latestRunAttemptForRecipe,
	registerGateRunAttemptIndex,
} from "../extensions/workbench-runtime/core/runs.ts";
import { makeValidQuantResult, withTempDir, writeConfigFile } from "./helpers.ts";

const RECIPES_YAML = `
recipes:
  - name: test
    description: run the test suite
    command: [npm, test]
    expected_exit_codes: [0]
    artifacts: [out/*.json]
`;

function fakeExec(code = 0): (command: string, args: string[], options?: unknown) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
	return async () => ({ stdout: "", stderr: "", code, killed: false });
}

async function setupRecipeProject(dir: string): Promise<void> {
	await writeConfigFile(dir, "project.yaml", "name: p4-report\nprofile: generic\n");
	await writeConfigFile(dir, "recipes.yaml", RECIPES_YAML);
	await writeConfigFile(dir, "gates.yaml", "gates: []\n");
}

async function runRecipeAt(dir: string, date: string, code = 0): Promise<string> {
	const result = await runRecipe({
		projectRoot: dir,
		recipeName: "test",
		mode: "DEV",
		exec: fakeExec(code),
		now: () => new Date(date),
	});
	assert.ok(result.ok === (code === 0), "recipe run outcome must match the fake exit code");
	assert.ok(result.record, "recipe run must produce a record");
	return result.record.run_id;
}

async function setupQuantGateProject(dir: string, metrics: Record<string, unknown>): Promise<void> {
	await writeConfigFile(dir, "project.yaml", "name: p4-quant\nprofile: quant-research/stock-selection\n");
	await writeConfigFile(dir, "recipes.yaml", "recipes: []\n");
	await writeConfigFile(
		dir,
		"gates.yaml",
		"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Contract, kind: schema, file: results/quant-result.json, schema: quant-result }\n",
	);
	await mkdir(join(dir, "results"), { recursive: true });
	await writeFile(join(dir, "results", "quant-result.json"), JSON.stringify(makeValidQuantResult(metrics), null, 2), "utf8");
}

async function runGateAt(dir: string, date: string): Promise<string> {
	const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: fakeExec(), now: () => new Date(date) });
	return result.runId;
}

async function makeGateRunPureLegacyV1(dir: string, runId: string): Promise<void> {
	const runsRoot = join(dir, CONFIG_DIR_NAME, "workbench", "runs");
	const runDir = join(runsRoot, runId);
	const manifestPath = join(runDir, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
	manifest.schema_version = 1;
	delete manifest.run_transaction_schema_version;
	delete manifest.run_outcome;
	delete manifest.artifact_manifest_path;
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
	await rm(join(runDir, "run-commit.json"));
	await rm(join(runsRoot, GATE_ATTEMPT_INDEX_DIR, `${runId}.json`));
	await rm(join(runsRoot, GATE_ATTEMPT_ORDER_DIR), { recursive: true, force: true });
	clearGateRunCandidateCacheForTests(dir);
}

// ------------------------------------------------------------------- target

test("resolveRunTarget latest returns the newest run", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		const first = await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		const second = await runRecipeAt(dir, "2026-08-01T00:01:00.000Z");
		assert.notEqual(first, second);
		assert.equal(await resolveRunTarget(dir, "latest"), second);
	});
});

test("recipe runs snapshot declared JSON artifacts so later runs cannot corrupt earlier records", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await mkdir(join(dir, "out"), { recursive: true });
		await writeFile(join(dir, "out", "metrics.json"), JSON.stringify({ tests: 10 }), "utf8");
		const first = await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		// Overwrite the same project file before the second run.
		await writeFile(join(dir, "out", "metrics.json"), JSON.stringify({ tests: 99 }), "utf8");
		const second = await runRecipeAt(dir, "2026-08-01T00:01:00.000Z");

		const snapshotA = JSON.parse(await readFile(join(dir, CONFIG_DIR_NAME, "workbench", "runs", first, "artifacts", "metrics.json"), "utf8")) as { tests: number };
		assert.equal(snapshotA.tests, 10, "first run snapshot must keep its run-time content");
		const snapshotB = JSON.parse(await readFile(join(dir, CONFIG_DIR_NAME, "workbench", "runs", second, "artifacts", "metrics.json"), "utf8")) as { tests: number };
		assert.equal(snapshotB.tests, 99);
	});
});

test("resolveRunTarget accepts an explicit existing run id", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		const runId = await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		assert.equal(await resolveRunTarget(dir, runId), runId);
	});
});

test("resolveRunTarget returns null for unknown and malformed targets", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		assert.equal(await resolveRunTarget(dir, "20260101-120000-zzzz"), null, "valid-format but unknown run");
		assert.equal(await resolveRunTarget(dir, "not-a-run-id"), null, "malformed target");
		assert.equal(await resolveRunTarget(dir, ""), null, "empty target");
	});
});

test("buildRunReport returns null for an unknown run", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		assert.equal(await buildRunReport(dir, "20260101-120000-zzzz"), null);
	});
});

// ------------------------------------------------------------------ reports

test("recipe run report carries manifest facts and log paths", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await mkdir(join(dir, "out"), { recursive: true });
		await writeFile(join(dir, "out", "report.json"), JSON.stringify({ tests: 1 }), "utf8");
		const runId = await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		const lines = await buildRunReport(dir, runId);
		assert.ok(lines, "report must exist");
		const text = lines.join("\n");
		assert.ok(text.includes(`run       : ${runId}`));
		assert.ok(text.includes("recipe    : test"));
		assert.ok(text.includes("profile   : generic"));
		assert.ok(text.includes("status    : OK"));
		assert.ok(text.includes("exit code : 0"));
		assert.ok(text.includes("artifacts : out/report.json"));
		assert.ok(text.includes("stdout log:"));
		assert.ok(text.includes("stderr log:"));
		assert.ok(text.includes("manifest.json"), "report must cite the full record path");
		assert.ok(!text.includes("gates ("), "recipe run report must not invent a gates section");
	});
});

test("gate run report lists per-gate statuses and failed checks", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		// g1 fails: a gate whose only check requires a missing file.
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Missing, kind: file, path: nope.txt }\n",
		);
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: fakeExec(), now: () => new Date("2026-08-01T00:00:00.000Z") });
		const strictPage = await readGateRunPage({ projectRoot: dir, runId: result.runId, requireCommittedAuthority: true });
		assert.equal(strictPage.ok, true);
		if (strictPage.ok) assert.equal(strictPage.details.authority_kind, "committed-v2");
		const lines = await buildRunReport(dir, result.runId);
		const text = lines?.join("\n") ?? "";
		assert.ok(text.includes("recipe    : gate (gate run)"));
		assert.ok(text.includes("gates (1):"));
		assert.match(text, /g1\s+FAIL/);
		assert.ok(text.includes("failed checks:"));
		assert.ok(text.includes("g1.1"));
	});
});

test("quant run report includes the declared quant facts", async () => {
	await withTempDir(async (dir) => {
		await setupQuantGateProject(dir, {});
		const runId = await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		const lines = await buildRunReport(dir, runId);
		const text = lines?.join("\n") ?? "";
		assert.ok(text.includes("quant result"));
		assert.ok(text.includes("return          : 0.12"));
		assert.ok(text.includes("benchmark delta : 0.04"));
		assert.ok(text.includes("folds           : 3 passed, 0 not passed"));
		assert.ok(text.includes("parameters      : lookback, top_n, seed"));
	});
});

// ------------------------------------------------------- latest gate summary

test("latestGateRunSummary reports worst gate, counts and blocking reason", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			[
				"gates:",
				"  - id: g1",
				"    title: G1",
				"    checks:",
				"      - { id: g1.1, title: Config, kind: config }",
				"  - id: g2",
				"    title: G2",
				"    prerequisites: [g1]",
				"    checks:",
				"      - { id: g2.1, title: Missing, kind: file, path: nope.txt }",
			].join("\n"),
		);
		const result = await runGates({ projectRoot: dir, selector: "g1,g2", mode: "DEV", exec: fakeExec(), now: () => new Date("2026-08-01T00:00:00.000Z") });
		assert.equal(result.status, "FAIL");
		const summary = await latestGateRunSummary(dir);
		assert.ok(summary, "summary must exist after a gate run");
		assert.equal(summary.run_id, result.runId);
		assert.equal(summary.status, "FAIL");
		assert.equal(summary.worst_gate?.id, "g2");
		assert.equal(summary.worst_gate?.status, "FAIL");
		assert.ok(summary.blocking_reason?.includes("g2.1"), "blocking reason must cite the failing check");
		assert.deepEqual(summary.counts, { pass: 1, fail: 1, blocked: 0, not_run: 0 });
	});
});

test("latestGateRunSummary returns null when no gate run exists", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		assert.equal(await latestGateRunSummary(dir), null);
	});
});

test("a pure historical schema-v1 Gate stays blocked with an actionable fresh-v2 rerun reason", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		const legacy = await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		await makeGateRunPureLegacyV1(dir, legacy);
		const legacyManifestPath = join(dir, CONFIG_DIR_NAME, "workbench", "runs", legacy, "manifest.json");
		const immutableLegacyBytes = await readFile(legacyManifestPath);

		const summary = await latestGateRunSummary(dir);
		assert.equal(summary?.run_id, legacy);
		assert.equal(summary?.record_state, "UNAVAILABLE");
		assert.equal(summary?.status, "BLOCKED");
		assert.match(summary?.blocking_reason ?? "", /historical pre-transaction Gate run \(schema v1\)/);
		assert.match(summary?.blocking_reason ?? "", /rerun \/q-gate all/);
		assert.match(summary?.blocking_reason ?? "", /older status not used/);
		const status = (await latestGateStatuses(dir, ["g1"])).g1;
		assert.equal(status?.status, "UNKNOWN");
		assert.equal(status?.run_id, legacy);
		assert.match(status?.unavailable_reason ?? "", /rerun \/q-gate all/);
		assert.deepEqual(await readFile(legacyManifestPath), immutableLegacyBytes, "diagnosis never rewrites legacy evidence");

		const fresh = await runGateAt(dir, "2026-08-02T00:00:00.000Z");
		assert.equal((await latestGateRunSummary(dir))?.run_id, fresh, "a fresh committed v2 Gate supersedes the read-only legacy record");
		assert.deepEqual((await latestGateStatuses(dir, ["g1"])).g1, { status: "PASS", run_id: fresh });
		assert.deepEqual(await readFile(legacyManifestPath), immutableLegacyBytes, "fresh execution leaves the historical run byte-identical");
	});
});

test("a schema-v1-looking Gate with a v2 marker is mixed authority, not a legacy rerun diagnosis", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		const runId = await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		await makeGateRunPureLegacyV1(dir, runId);
		await writeFile(
			join(dir, CONFIG_DIR_NAME, "workbench", "runs", runId, "run-commit.json"),
			"{}\n",
			"utf8",
		);
		clearGateRunCandidateCacheForTests(dir);

		const summary = await latestGateRunSummary(dir);
		assert.equal(summary?.record_state, "UNAVAILABLE");
		assert.match(summary?.blocking_reason ?? "", /committed run identity unavailable/);
		assert.doesNotMatch(summary?.blocking_reason ?? "", /historical pre-transaction/);
		const status = (await latestGateStatuses(dir, ["g1"])).g1;
		assert.match(status?.unavailable_reason ?? "", /committed run identity unavailable/);
		assert.doesNotMatch(status?.unavailable_reason ?? "", /historical pre-transaction/);
	});
});

test("latest gate summary and statuses survive more than fifty newer non-gate runs", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		const gateRunId = await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		for (let index = 1; index <= 60; index += 1) {
			await runRecipeAt(dir, new Date(Date.parse("2026-08-01T00:00:00.000Z") + index * 1_000).toISOString());
		}
		await rm(join(dir, CONFIG_DIR_NAME, "workbench", "runs", GATE_ATTEMPT_INDEX_DIR), { recursive: true, force: true });
		clearGateRunCandidateCacheForTests(dir);
		const summary = await latestGateRunSummary(dir);
		assert.equal(summary?.run_id, gateRunId);
		assert.equal(summary?.record_state, "AVAILABLE");
		let repeatedManifestProbes = 0;
		assert.deepEqual(await latestGateStatuses(dir, ["g1"], {
			onManifestProbe: () => { repeatedManifestProbes += 1; },
		}), {
			g1: { status: "PASS", run_id: gateRunId },
		});
		assert.equal(repeatedManifestProbes, 0, "the old-repository catalog is reused instead of reparsing history");
	});
});

test("immutable gate-attempt index keeps repeated refresh reads bounded with more than one thousand runs", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		const gateRunId = await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		const registration = await registerGateRunAttemptIndex(
			dir,
			gateRunId,
			new Date("2026-08-01T00:00:00.000Z"),
			new Date("2026-08-01T00:00:01.000Z"),
		);
		assert.ok(registration.ok || registration.reason === "already_registered");
		const runsRoot = join(dir, CONFIG_DIR_NAME, "workbench", "runs");
		for (let index = 0; index < 1_001; index += 1) {
			const date = new Date(Date.parse("2026-08-02T00:00:00.000Z") + index * 1_000);
			const stamp = date.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
			const runId = `${stamp}-${index.toString(36).padStart(4, "0")}`;
			const runDir = join(runsRoot, runId);
			await mkdir(runDir);
			await writeFile(join(runDir, "manifest.json"), JSON.stringify({ schema_version: 1, run_id: runId, recipe: "test" }), "utf8");
		}
		clearGateRunCandidateCacheForTests(dir);
		let catalogManifestReads = 0;
		let sourceIdentityProbes = 0;
		let candidateValidations = 0;
		const summary = await latestGateRunSummary(dir, {
			onManifestProbe: () => { catalogManifestReads += 1; },
			onSourceIdentityProbe: (_runId, source) => { if (source === "manifest") sourceIdentityProbes += 1; },
			onCandidateValidation: () => { candidateValidations += 1; },
		});
		assert.equal(summary?.run_id, gateRunId);
		const identityProbesAfterFirstRefresh = sourceIdentityProbes;
		const repeated = await latestGateRunSummary(dir, {
			onManifestProbe: () => { catalogManifestReads += 1; },
			onSourceIdentityProbe: (_runId, source) => { if (source === "manifest") sourceIdentityProbes += 1; },
			onCandidateValidation: () => { candidateValidations += 1; },
		});
		assert.equal(repeated?.run_id, gateRunId);
		assert.equal(catalogManifestReads, 0, "the durable sequence head avoids scanning unrelated unmarked history");
		assert.equal(
			sourceIdentityProbes - identityProbesAfterFirstRefresh,
			0,
			"repeat refresh remains independent of unrelated history size",
		);
		assert.equal(candidateValidations, 2, "each refresh strictly revalidates only the single indexed gate");
	});
});

test("a corrupt newest gate record becomes UNKNOWN/BLOCKED instead of falling back to an older PASS", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		const older = await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		const olderRegistration = await registerGateRunAttemptIndex(dir, older, new Date("2026-08-01T00:00:00.000Z"));
		assert.ok(olderRegistration.ok || olderRegistration.reason === "already_registered");
		const newest = await runGateAt(dir, "2026-08-02T00:00:00.000Z");
		const newestRegistration = await registerGateRunAttemptIndex(dir, newest, new Date("2026-08-02T00:00:00.000Z"));
		assert.ok(newestRegistration.ok || newestRegistration.reason === "already_registered");
		await rm(join(dir, CONFIG_DIR_NAME, "workbench", "runs", newest, "gates.json"));
		clearGateRunCandidateCacheForTests(dir);
		const summary = await latestGateRunSummary(dir);
		assert.equal(summary?.run_id, newest);
		assert.equal(summary?.record_state, "UNAVAILABLE");
		assert.equal(summary?.status, "BLOCKED");
		assert.match(summary?.blocking_reason ?? "", /older status not used/);
		assert.doesNotMatch(summary?.blocking_reason ?? "", /historical pre-transaction/);
		const latest = await latestGateStatuses(dir, ["g1"]);
		assert.equal(latest.g1?.run_id, newest);
		assert.equal(latest.g1?.status, "UNKNOWN");
		assert.match(latest.g1?.unavailable_reason ?? "", /committed run identity unavailable/);
	});
});

test("a crash marker registered before transaction creation blocks an older PASS", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		const crashedRunId = "20260802-000000-crsh";
		const registered = await registerGateRunAttemptIndex(
			dir,
			crashedRunId,
			new Date("2026-08-02T00:00:00.000Z"),
		);
		assert.equal(registered.ok, true);
		clearGateRunCandidateCacheForTests(dir);
		const summary = await latestGateRunSummary(dir);
		assert.equal(summary?.run_id, crashedRunId);
		assert.equal(summary?.record_state, "UNAVAILABLE");
		assert.equal(summary?.status, "BLOCKED");
		assert.doesNotMatch(summary?.blocking_reason ?? "", /historical pre-transaction/);
		assert.equal((await latestGateStatuses(dir, ["g1"])).g1?.status, "UNKNOWN");
	});
});

test("concurrent Gate attempt registrations reserve distinct monotonic sequences", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		const ids = ["20260802-000000-rac1", "20260802-000000-rac2"] as const;
		const results = await Promise.all(ids.map((runId) => registerGateRunAttemptIndex(
			dir,
			runId,
			new Date("2026-08-02T00:00:00.000Z"),
		)));
		assert.ok(results.every((result) => result.ok));
		const orderDir = join(dir, CONFIG_DIR_NAME, "workbench", "runs", GATE_ATTEMPT_ORDER_DIR);
		const orderFiles = (await readdir(orderDir)).sort();
		assert.deepEqual(orderFiles, ["0000000000000001.json", "0000000000000002.json"]);
		const sequences = await Promise.all(ids.map(async (runId) => {
			const marker = JSON.parse(await readFile(join(dir, CONFIG_DIR_NAME, "workbench", "runs", GATE_ATTEMPT_INDEX_DIR, `${runId}.json`), "utf8")) as { attempt_sequence: number };
			return marker.attempt_sequence;
		}));
		assert.deepEqual([...sequences].sort((a, b) => a - b), [1, 2]);
	});
});

test("a corrupt or oversized newest attempt marker is UNKNOWN even when the target run is intact", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		const runId = await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		const markerPath = join(dir, CONFIG_DIR_NAME, "workbench", "runs", GATE_ATTEMPT_INDEX_DIR, `${runId}.json`);
		await writeFile(markerPath, "{not-json", "utf8");
		clearGateRunCandidateCacheForTests(dir);
		assert.equal((await latestGateRunSummary(dir))?.record_state, "UNAVAILABLE");
		assert.equal((await latestGateStatuses(dir, ["g1"])).g1?.status, "UNKNOWN");
		await writeFile(markerPath, "x".repeat(4_097), "utf8");
		clearGateRunCandidateCacheForTests(dir);
		assert.equal((await latestGateRunSummary(dir))?.record_state, "UNAVAILABLE");
		assert.equal((await latestGateStatuses(dir, ["g1"])).g1?.status, "UNKNOWN");
	});
});

test("a cached valid marker becomes invalid after in-place corruption and never exposes an older PASS", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		const older = await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		const newer = await runGateAt(dir, "2026-08-02T00:00:00.000Z");
		clearGateRunCandidateCacheForTests(dir);
		let markerIdentityProbes = 0;
		const hooks = {
			onSourceIdentityProbe: (_runId: string, source: string): void => {
				if (source === "gate-marker") markerIdentityProbes += 1;
			},
		};
		const initial = (await latestGateStatuses(dir, ["g1"], hooks)).g1;
		assert.equal(initial?.run_id, newer);
		assert.equal(initial?.status, "PASS");
		assert.equal(markerIdentityProbes, 4, "first read binds two identities around each marker read");

		await writeFile(
			join(dir, CONFIG_DIR_NAME, "workbench", "runs", GATE_ATTEMPT_INDEX_DIR, `${newer}.json`),
			"{not-json",
			"utf8",
		);
		const probesBeforeCorruptRefresh = markerIdentityProbes;
		const corrupted = (await latestGateStatuses(dir, ["g1"], hooks)).g1;
		assert.equal(corrupted?.run_id, newer);
		assert.notEqual(corrupted?.run_id, older);
		assert.equal(corrupted?.status, "UNKNOWN");
		assert.equal(
			markerIdentityProbes - probesBeforeCorruptRefresh,
			3,
			"the unchanged marker gets one probe while the changed marker is checked before and after reread",
		);
		const probesBeforeStableRefresh = markerIdentityProbes;
		assert.equal((await latestGateStatuses(dir, ["g1"], hooks)).g1?.status, "UNKNOWN");
		assert.equal(
			markerIdentityProbes - probesBeforeStableRefresh,
			2,
			"stable cached marker classifications use one cheap identity probe per marker",
		);
	});
});

test("gate marker registration fails closed when index directory sync fails after publication", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		const runId = "20260802-000000-sync";
		const markerPath = join(dir, CONFIG_DIR_NAME, "workbench", "runs", GATE_ATTEMPT_INDEX_DIR, `${runId}.json`);
		let syncCalls = 0;
		const result = await registerGateRunAttemptIndex(
			dir,
			runId,
			new Date("2026-08-02T00:00:00.000Z"),
			new Date("2026-08-02T00:00:01.000Z"),
			{
				syncDirectory: async (directory) => {
					syncCalls += 1;
					assert.equal(directory, join(dir, CONFIG_DIR_NAME, "workbench", "runs", GATE_ATTEMPT_INDEX_DIR));
					assert.equal(JSON.parse(await readFile(markerPath, "utf8")).run_id, runId, "marker is linked and strictly readable before directory sync");
					throw new Error("injected directory sync failure");
				},
			},
		);
		assert.deepEqual(result, { ok: false, reason: "index_unavailable" });
		assert.equal(syncCalls, 1);
		assert.equal(JSON.parse(await readFile(markerPath, "utf8")).run_id, runId, "visible marker does not upgrade the failed registration result");
	});
});

test("same-second immutable markers use exact start time and ignore a stale mutable pointer", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		const originalRandom = Math.random;
		let older: string;
		let newer: string;
		try {
			Math.random = () => 0.99;
			older = await runGateAt(dir, "2026-08-01T00:00:00.100Z");
			Math.random = () => 0;
			newer = await runGateAt(dir, "2026-08-01T00:00:00.900Z");
		} finally {
			Math.random = originalRandom;
		}
		assert.ok(older > newer, "fixture forces the newer run to have the lexically smaller random suffix");
		await writeFile(
			join(dir, CONFIG_DIR_NAME, "workbench", "runs", ".latest-gate.json"),
			JSON.stringify({ schema_version: 1, recipe: "gate", run_id: older, written_at: "2026-08-01T00:00:01.000Z" }),
			"utf8",
		);
		clearGateRunCandidateCacheForTests(dir);
		assert.equal((await latestGateRunSummary(dir))?.run_id, newer);
		assert.equal((await latestGateStatuses(dir, ["g1"])).g1?.run_id, newer);
	});
});

test("durable Gate attempt sequence outranks a wall-clock rollback", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		const earlierSequence = await runGateAt(dir, "2026-08-02T00:00:00.000Z");
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Missing, kind: file, path: missing.txt }\n",
		);
		const laterSequence = await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		assert.ok(laterSequence < earlierSequence, "fixture rolls the wall-clock run id backwards");
		clearGateRunCandidateCacheForTests(dir);
		const latest = await latestGateRunSummary(dir);
		assert.equal(latest?.run_id, laterSequence);
		assert.equal(latest?.status, "FAIL");
	});
});

test("durable Gate attempt sequence survives marker loss and an unavailable legacy index after restart", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		const runId = await runGateAt(dir, "2026-08-03T00:00:00.000Z");
		const index = join(dir, CONFIG_DIR_NAME, "workbench", "runs", GATE_ATTEMPT_INDEX_DIR);
		await rm(join(index, `${runId}.json`));
		await rm(index, { recursive: true });
		await writeFile(index, "index unavailable", "utf8");
		clearGateRunCandidateCacheForTests(dir);
		assert.equal((await latestGateRunSummary(dir))?.run_id, runId);
		assert.equal((await latestGateStatuses(dir, ["g1"])).g1?.status, "PASS");
	});
});

test("a newer unmarked FAIL outranks an older marked PASS and repeated refresh reuses classification", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		const older = await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Missing, kind: file, path: missing.txt }\n",
		);
		const newerResult = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: fakeExec(),
			now: () => new Date("2026-08-02T00:00:00.000Z"),
		});
		assert.equal(newerResult.status, "FAIL");
		await rm(join(dir, CONFIG_DIR_NAME, "workbench", "runs", GATE_ATTEMPT_INDEX_DIR, `${newerResult.runId}.json`));
		clearGateRunCandidateCacheForTests(dir);
		const summary = await latestGateRunSummary(dir);
		assert.equal(summary?.run_id, newerResult.runId);
		assert.equal(summary?.status, "FAIL");
		assert.notEqual(summary?.run_id, older);
		assert.equal((await latestGateStatuses(dir, ["g1"])).g1?.run_id, newerResult.runId);
		let repeatedProbes = 0;
		assert.equal((await latestGateRunSummary(dir, {
			onManifestProbe: () => { repeatedProbes += 1; },
		}))?.run_id, newerResult.runId);
		assert.equal(repeatedProbes, 0, "repeat refresh does not reclassify mixed history");
	});
});

test("a newer unmarked corrupt gate is UNKNOWN and never falls back to an older marked PASS", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		await writeConfigFile(
			dir,
			"gates.yaml",
			"gates:\n  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Config, kind: config }\n",
		);
		await runGateAt(dir, "2026-08-01T00:00:00.000Z");
		const newer = await runGateAt(dir, "2026-08-02T00:00:00.000Z");
		await rm(join(dir, CONFIG_DIR_NAME, "workbench", "runs", GATE_ATTEMPT_INDEX_DIR, `${newer}.json`));
		await writeFile(join(dir, CONFIG_DIR_NAME, "workbench", "runs", newer, "gates.json"), "{not-json", "utf8");
		clearGateRunCandidateCacheForTests(dir);
		const summary = await latestGateRunSummary(dir);
		assert.equal(summary?.run_id, newer);
		assert.equal(summary?.record_state, "UNAVAILABLE");
		assert.equal(summary?.status, "BLOCKED");
		const status = (await latestGateStatuses(dir, ["g1"])).g1;
		assert.equal(status?.run_id, newer);
		assert.equal(status?.status, "UNKNOWN");
		let repeatedProbes = 0;
		assert.equal((await latestGateRunSummary(dir, {
			onManifestProbe: () => { repeatedProbes += 1; },
		}))?.run_id, newer);
		assert.equal(repeatedProbes, 0);
	});
});

test("recipe-filtered latest-attempt lookup caches unrelated history and fails closed on a new corrupt attempt", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		const runsRoot = join(dir, CONFIG_DIR_NAME, "workbench", "runs");
		await mkdir(runsRoot, { recursive: true });
		const oldRunId = "20260801-000000-old1";
		const oldRunDir = join(runsRoot, oldRunId);
		await mkdir(oldRunDir);
		await writeFile(join(oldRunDir, "manifest.json"), JSON.stringify({ schema_version: 1, run_id: oldRunId, recipe: "test" }), "utf8");
		for (let index = 0; index < 1_001; index += 1) {
			const date = new Date(Date.parse("2026-08-02T00:00:00.000Z") + index * 1_000);
			const stamp = date.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
			const runId = `${stamp}-${index.toString(36).padStart(4, "0")}`;
			const runDir = join(runsRoot, runId);
			await mkdir(runDir);
			await writeFile(join(runDir, "manifest.json"), JSON.stringify({ schema_version: 1, run_id: runId, recipe: "other" }), "utf8");
		}
		clearGateRunCandidateCacheForTests(dir);
		let probes = 0;
		const hooks = { onManifestProbe: (): void => { probes += 1; } };
		const first = await latestRunAttemptForRecipe(dir, "test", hooks);
		assert.equal(first.state, "FOUND");
		assert.equal(first.state === "FOUND" ? first.run_id : null, oldRunId);
		const afterFirst = probes;
		assert.equal(afterFirst, 1_002);
		const repeated = await latestRunAttemptForRecipe(dir, "test", hooks);
		assert.equal(repeated.state, "FOUND");
		assert.equal(probes, afterFirst, "a repeated lookup reuses classification and re-reads only the selected candidate");

		const corruptRunId = "20260803-000000-bad1";
		const corruptRunDir = join(runsRoot, corruptRunId);
		await mkdir(corruptRunDir);
		await writeFile(join(corruptRunDir, "manifest.json"), "{not-json", "utf8");
		await writeFile(join(corruptRunDir, "command.json"), JSON.stringify({ recipe: "test" }), "utf8");
		const corrupt = await latestRunAttemptForRecipe(dir, "test", hooks);
		assert.deepEqual(corrupt, { state: "CORRUPT", run_id: corruptRunId, reason: "manifest_unavailable" });
		assert.equal(probes, afterFirst + 1, "only the newly added directory is classified after the cache snapshot");
	});
});

test("recipe classification cache revalidates source identity and cannot hide same-directory tampering", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		const runsRoot = join(dir, CONFIG_DIR_NAME, "workbench", "runs");
		await mkdir(runsRoot, { recursive: true });
		const oldRunId = "20260801-000000-old1";
		const newerRunId = "20260802-000000-new1";
		await mkdir(join(runsRoot, oldRunId));
		await mkdir(join(runsRoot, newerRunId));
		await writeFile(
			join(runsRoot, oldRunId, "manifest.json"),
			JSON.stringify({ schema_version: 1, run_id: oldRunId, recipe: "test" }),
			"utf8",
		);
		const otherManifest = JSON.stringify({ schema_version: 1, run_id: newerRunId, recipe: "other" });
		await writeFile(join(runsRoot, newerRunId, "manifest.json"), otherManifest, "utf8");

		clearGateRunCandidateCacheForTests(dir);
		let manifestProbes = 0;
		let identityProbes = 0;
		const hooks = {
			onManifestProbe: (): void => { manifestProbes += 1; },
			onSourceIdentityProbe: (): void => { identityProbes += 1; },
		};
		const primed = await latestRunAttemptForRecipe(dir, "test", hooks);
		assert.equal(primed.state, "FOUND");
		assert.equal(primed.state === "FOUND" ? primed.run_id : null, oldRunId);
		const readsAfterPrime = manifestProbes;
		const identitiesAfterPrime = identityProbes;
		const unchanged = await latestRunAttemptForRecipe(dir, "test", hooks);
		assert.equal(unchanged.state, "FOUND");
		assert.equal(unchanged.state === "FOUND" ? unchanged.run_id : null, oldRunId);
		assert.equal(manifestProbes, readsAfterPrime, "unchanged classifications are not parsed again");
		assert.ok(identityProbes > identitiesAfterPrime, "unchanged classifications are guarded by cheap identity probes");

		await writeFile(
			join(runsRoot, newerRunId, "manifest.json"),
			JSON.stringify({ schema_version: 1, run_id: newerRunId, recipe: "test" }),
			"utf8",
		);
		const retargeted = await latestRunAttemptForRecipe(dir, "test", hooks);
		assert.equal(retargeted.state, "FOUND");
		assert.equal(retargeted.run_id, newerRunId, "other-to-target mutation invalidates the negative recipe cache");
		assert.equal(manifestProbes, readsAfterPrime + 1, "only the changed directory is reclassified");

		await writeFile(join(runsRoot, newerRunId, "manifest.json"), otherManifest, "utf8");
		const recachedOther = await latestRunAttemptForRecipe(dir, "test", hooks);
		assert.equal(recachedOther.state, "FOUND");
		assert.equal(recachedOther.state === "FOUND" ? recachedOther.run_id : null, oldRunId);
		const readsAfterOtherWasRecached = manifestProbes;
		await writeFile(join(runsRoot, newerRunId, "manifest.json"), "{not-json", "utf8");
		const corrupted = await latestRunAttemptForRecipe(dir, "test", hooks);
		assert.deepEqual(corrupted, { state: "CORRUPT", run_id: newerRunId, reason: "manifest_unavailable" });
		assert.equal(manifestProbes, readsAfterOtherWasRecached + 1, "changed corrupt source is reclassified once");
		const readsAfterCorrupt = manifestProbes;
		assert.deepEqual(
			await latestRunAttemptForRecipe(dir, "test", hooks),
			{ state: "CORRUPT", run_id: newerRunId, reason: "manifest_unavailable" },
		);
		assert.equal(manifestProbes, readsAfterCorrupt, "stable corrupt obstruction also avoids repeated manifest classification");
	});
});

test("readGateFileRecord rejects run id mismatches and non-gate records", async () => {
	await withTempDir(async (dir) => {
		await setupRecipeProject(dir);
		const runId = await runRecipeAt(dir, "2026-08-01T00:00:00.000Z");
		assert.equal(await readGateFileRecord(dir, runId), null, "recipe run has no gates.json");
		assert.equal(await readGateFileRecord(dir, "20260101-120000-zzzz"), null, "unknown run");
	});
});
