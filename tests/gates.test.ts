/**
 * Gate Engine tests (P3) — the validation ladder semantics.
 *
 * Covers the required scenarios: gate dependency order, prerequisite FAIL →
 * BLOCKED, required NOT_RUN never PASSes, missing artifacts, missing JSON
 * fields, numeric constraints, non-numeric/NaN values, quant gates only
 * loading for quant profiles, generic not enforcing quant gates, failed
 * folds not filtered, evidence path escapes, gate result persistence, and
 * independent run ids — plus recipe checks, manual evidence marking,
 * non-blocking prerequisites, same-run prerequisite closure, config
 * checks and yaml catalog overrides — plus P8 nested projects: file/json/
 * numeric/schema checks against the effective root while the built-in b0.4
 * workbench-config existence check stays repository-root anchored via
 * internal catalog-only metadata (gates.yaml can never set root/file_root).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { parse as parseYaml } from "yaml";

import {
	GateSetupError,
	GATE_AUTHORITY_PERSISTENCE_ERROR,
	GATE_AUTHORITY_RECORD_MAX_BYTES,
	GATE_CONFIG_MAX_BYTES,
	GATE_CONFIG_READ_ERROR,
	GATE_JSON_ARTIFACT_MAX_BYTES,
	fileCheckRoot,
	latestGateStatus,
	loadGates,
	preflightGateManualEvidence,
	readPersistedGateRunFacts,
	runGates,
	type CheckContext,
} from "../extensions/workbench-runtime/core/gate-engine.ts";
import { readGateFileRecord } from "../extensions/workbench-runtime/core/report.ts";
import {
	clearGateRunCandidateCacheForTests,
	GATE_ATTEMPT_INDEX_DIR,
	readManifest,
} from "../extensions/workbench-runtime/core/runs.ts";
import type { ValidationEvidenceBlock } from "../extensions/workbench-runtime/core/validation-evidence.ts";
import { gateStateHash } from "../extensions/workbench-runtime/core/validation-evidence.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { BASE_GATES } from "../extensions/workbench-runtime/core/gate-catalog.ts";
import { runRecipe } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import { parseGate, type GateCheck, type WorkerFirstGateFacts } from "../extensions/workbench-runtime/core/gate-schema.ts";
import { makeValidQuantResult, spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";
import { canonicalHash, sha256Hex } from "../extensions/workbench-runtime/cache/canonical-hash.ts";

const CONFIG_CHECK = "      - { id: g1.1, title: Config, kind: config }";
const SOL_FACTS = { role: undefined, provider: "openai-codex", model: "gpt-5.6-sol" };

async function setupProject(dir: string, options: { profile?: string; gatesYaml?: string; recipesYaml?: string } = {}): Promise<void> {
	const profile = options.profile ?? "generic";
	await writeConfigFile(dir, "project.yaml", `name: test-project\nprofile: ${profile}\n`);
	if (options.recipesYaml !== undefined) {
		await writeConfigFile(dir, "recipes.yaml", options.recipesYaml);
	}
	await writeConfigFile(dir, "gates.yaml", options.gatesYaml ?? "gates: []\n");
}

function gatesYaml(gates: string): string {
	return `gates:\n${gates}`;
}

async function readRunFile(runDir: string, file: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(runDir, file), "utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Dependency order and prerequisite semantics
// ---------------------------------------------------------------------------

test("gates run in dependency order regardless of request order", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`,
					`  - id: g2\n    title: G2\n    prerequisites: [g1]\n    checks:\n${CONFIG_CHECK}`,
					`  - id: g3\n    title: G3\n    prerequisites: [g2]\n    checks:\n${CONFIG_CHECK}`,
				].join("\n"),
			),
		});
		// Reversed request: the engine must still evaluate g1 before g2 before g3.
		const result = await runGates({ projectRoot: dir, selector: "g3,g2,g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.ok, true);
		assert.deepEqual(result.gates.map((g) => g.id), ["g1", "g2", "g3"]);
		assert.equal(result.gates[1]!.prerequisite_status["g1"]!.source, "this-run");
		assert.equal(result.gates[2]!.prerequisite_status["g2"]!.status, "PASS");
	});
});

test("prerequisite FAIL blocks dependent gates (checks not evaluated)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Missing file, kind: file, path: does-not-exist.txt }`,
					`  - id: g2\n    title: G2\n    prerequisites: [g1]\n    checks:\n${CONFIG_CHECK}`,
					`  - id: g3\n    title: G3\n    prerequisites: [g2]\n    checks:\n${CONFIG_CHECK}`,
				].join("\n"),
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1,g2,g3", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.equal(result.gates[1]!.status, "BLOCKED");
		assert.ok(result.gates[1]!.blocked_reason?.includes("prerequisite g1 is FAIL"));
		assert.deepEqual(result.gates[1]!.checks, [], "blocked gates must not evaluate checks");
		assert.equal(result.gates[2]!.status, "BLOCKED");
		assert.ok(result.gates[2]!.blocked_reason?.includes("prerequisite g2 is BLOCKED"));
		assert.equal(result.ok, false);
	});
});

test("required NOT_RUN checks never let a gate PASS", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Manual audit, kind: manual, prompt: "audit needed" }`,
			),
		});
		const withoutEvidence = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(withoutEvidence.gates[0]!.status, "NOT_RUN");
		assert.equal(withoutEvidence.ok, false);

		const withEvidence = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "g1.1": "audit performed: timestamps checked against point-in-time data" },
		});
		assert.equal(withEvidence.gates[0]!.status, "PASS");
		assert.equal(withEvidence.ok, true);
	});
});

test("optional NOT_RUN checks do not block PASS but are recorded as warnings", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}\n      - { id: g1.2, title: Optional audit, kind: manual, required: false }`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS");
		assert.ok(result.gates[0]!.warnings.some((w) => w.includes("g1.2") && w.includes("not run")));
		assert.equal(result.ok, true);
	});
});

test("an explicitly selected optional gate FAILs the invocation and cannot create reusable authority", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: optional-gate\n    title: Optional\n    required: false\n    checks:\n      - { id: optional.1, title: Missing, kind: file, path: missing.txt }`,
			),
		});
		await gitBacked(dir);
		const result = await runGates({ projectRoot: dir, selector: "optional-gate", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(result.gates[0]!.required, false);
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.equal(result.status, "FAIL");
		assert.equal(result.ok, false);
		const manifest = (await readRunFile(result.runDir, "manifest.json")) as { validation_evidence: ValidationEvidenceBlock };
		assert.equal(manifest.validation_evidence.binding?.outcome.successful, false);
	});
});

test("a non-blocking prerequisite FAIL does not block dependents", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    blocking: false\n    checks:\n      - { id: g1.1, title: Missing file, kind: file, path: does-not-exist.txt }`,
					`  - id: g2\n    title: G2\n    prerequisites: [g1]\n    checks:\n${CONFIG_CHECK}`,
				].join("\n"),
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1,g2", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.equal(result.gates[1]!.status, "PASS", "non-blocking prerequisite failure must not block dependents");
		assert.equal(result.gates[1]!.prerequisite_status["g1"]!.status, "FAIL");
	});
});

test("a dependent selector executes its full prerequisite closure in the same authority transaction", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`,
					`  - id: g2\n    title: G2\n    prerequisites: [g1]\n    checks:\n${CONFIG_CHECK}`,
				].join("\n"),
			),
		});
		const first = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(first.gates[0]!.status, "PASS");

		const second = await runGates({ projectRoot: dir, selector: "g2", mode: "DEV", exec: spawnExec });
		assert.deepEqual(second.gates.map((gate) => gate.id), ["g1", "g2"]);
		assert.equal(second.gates[1]!.status, "PASS");
		assert.equal(second.gates[1]!.prerequisite_status["g1"]!.source, "this-run");
		assert.equal(second.gates[1]!.prerequisite_status["g1"]!.status, "PASS");

		const latest = await latestGateStatus(dir, "g1");
		assert.equal(latest?.status, "PASS");
		assert.equal(latest?.run_id, second.runId, "the closure rerun, not the older PASS, owns current prerequisite authority");
	});
});

test("an unknown prerequisite setup-fails before allocating a gate attempt", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g2\n    title: G2\n    prerequisites: [removed-gate]\n    checks:\n${CONFIG_CHECK}`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g2", mode: "DEV", exec: spawnExec }),
			(error: unknown) => error instanceof GateSetupError && /unknown prerequisite "removed-gate"/.test(error.message),
		);
		await assert.rejects(readdir(join(dir, ".pi", "workbench", "runs")), { code: "ENOENT" });
	});
});

// ---------------------------------------------------------------------------
// Check kinds: file / json / numeric / manual / schema / recipe
// ---------------------------------------------------------------------------

test("missing artifact fails the file check with the check id in the reason", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Data file, kind: file, path: data/prices.csv }`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.ok(result.gates[0]!.failure_reason?.includes("g1.1"));
	});

	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Data file, kind: file, any_of: [data/a.csv, data/b.csv] }`,
			),
		});
		await mkdir(join(dir, "data"), { recursive: true });
		await writeFile(join(dir, "data", "b.csv"), "x", "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS", "any_of must pass when one of the files exists");
	});
});

test("missing JSON field fails the json check", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Split method, kind: json, file: results/quant-result.json, path: split.method }`,
			),
		});
		await mkdir(join(dir, "results"), { recursive: true });
		await writeFile(join(dir, "results", "quant-result.json"), JSON.stringify({ split: {} }), "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.ok(result.gates[0]!.checks[0]!.failure_reason?.includes("split.method"));
	});
});

test("json equals and any_of_paths checks", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Method, kind: json, file: results/r.json, path: split.method, equals: walk-forward }`,
					`  - id: g2\n    title: G2\n    checks:\n      - { id: g2.1, title: Risk metric, kind: json, file: results/r.json, any_of_paths: [metrics.sharpe, metrics.sortino] }`,
				].join("\n"),
			),
		});
		await mkdir(join(dir, "results"), { recursive: true });
		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ split: { method: "walk-forward" }, metrics: { sortino: 1.2 } }), "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1,g2", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS");
		assert.equal(result.gates[1]!.status, "PASS", "any_of_paths must pass when one path exists");
	});
});

test("nested JSON mismatches persist only bounded digest/type/size facts", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Payload, kind: json, file: results/r.json, path: payload, equals: expected }`,
			),
		});
		await mkdir(join(dir, "results"), { recursive: true });
		const hostile = "x".repeat(900_000);
		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ payload: hostile }), "utf8");

		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.status, "FAIL");
		const check = result.gates[0]!.checks[0]!;
		assert.match(check.failure_reason ?? "", /type=string, json_bytes=10, sha256=[0-9a-f]{64}/);
		assert.match(check.evidence[0]!.detail, /actual\(type=string, json_bytes=900002, sha256=[0-9a-f]{64}\)/);
		assert.ok((check.failure_reason?.length ?? 0) < 256);
		assert.ok(check.evidence[0]!.detail.length < 320);
		assert.ok(!JSON.stringify(check).includes("x".repeat(256)), "hostile JSON content never enters failure/evidence authority");

		const gatesJson = await readFile(join(result.runDir, "gates.json"), "utf8");
		const evidenceJson = await readFile(join(result.runDir, "evidence.json"), "utf8");
		assert.ok(Buffer.byteLength(gatesJson, "utf8") <= GATE_AUTHORITY_RECORD_MAX_BYTES);
		assert.ok(Buffer.byteLength(evidenceJson, "utf8") <= GATE_AUTHORITY_RECORD_MAX_BYTES);
		const manifest = await readManifest(dir, result.runId);
		assert.ok(manifest);
		assert.ok(await readPersistedGateRunFacts(dir, result.runId, manifest), "failed-run authority remains reconstructible");
		assert.ok(await readGateFileRecord(dir, result.runId), "failed-run gates remain readable by the presentation reader");
	});
});

test("gate JSON checks reject oversized/non-regular inputs before allocation and corrupt JSON with fixed bounded reasons", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Payload, kind: json, file: results/r.json, path: ok }`,
			),
		});
		const artifact = join(dir, "results", "r.json");
		await mkdir(join(dir, "results"), { recursive: true });

		await writeFile(artifact, "x".repeat(GATE_JSON_ARTIFACT_MAX_BYTES + 1), "utf8");
		const oversizedAllocations: number[] = [];
		const oversized = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			jsonFileReadHooks: { onBufferAllocate: (bytes) => oversizedAllocations.push(bytes) },
		});
		assert.equal(oversized.gates[0]!.status, "FAIL");
		assert.match(oversized.gates[0]!.checks[0]!.failure_reason ?? "", /source_oversized \(maximum 1048576 bytes\)/);
		assert.deepEqual(oversizedAllocations, [], "oversized JSON is rejected after stat and before Buffer allocation");

		await rm(artifact);
		await mkdir(artifact);
		const nonRegularAllocations: number[] = [];
		const nonRegular = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			jsonFileReadHooks: { onBufferAllocate: (bytes) => nonRegularAllocations.push(bytes) },
		});
		assert.equal(nonRegular.gates[0]!.status, "FAIL");
		assert.match(nonRegular.gates[0]!.checks[0]!.failure_reason ?? "", /source_not_regular/);
		assert.deepEqual(nonRegularAllocations, [], "directories are rejected before Buffer allocation");

		await rm(artifact, { recursive: true });
		await writeFile(artifact, "{not-json", "utf8");
		const corruptAllocations: number[] = [];
		const corrupt = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			jsonFileReadHooks: { onBufferAllocate: (bytes) => corruptAllocations.push(bytes) },
		});
		assert.equal(corrupt.gates[0]!.status, "FAIL");
		assert.match(corrupt.gates[0]!.checks[0]!.failure_reason ?? "", /invalid JSON/);
		assert.ok(corruptAllocations.length > 0, "bounded corrupt input is allocated only after size/type preflight");
	});
});

test("numeric constraints are enforced (min/max, inclusive)", async () => {
	const check = (min: number, max: number): string =>
		`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Return, kind: numeric, file: results/r.json, path: metrics.return, min: ${min}, max: ${max} }`;
	await withTempDir(async (dir) => {
		await setupProject(dir, { gatesYaml: gatesYaml(check(10, 20)) });
		await mkdir(join(dir, "results"), { recursive: true });
		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ metrics: { return: 5 } }), "utf8");
		const below = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(below.gates[0]!.status, "FAIL");
		assert.ok(below.gates[0]!.checks[0]!.failure_reason?.includes("below min"));

		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ metrics: { return: 15 } }), "utf8");
		const within = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(within.gates[0]!.status, "PASS");

		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ metrics: { return: 25 } }), "utf8");
		const above = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(above.gates[0]!.status, "FAIL");
		assert.ok(above.gates[0]!.checks[0]!.failure_reason?.includes("above max"));
	});
});

test("non-numeric and non-finite values fail numeric checks", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Return, kind: numeric, file: results/r.json, path: x }`,
			),
		});
		await mkdir(join(dir, "results"), { recursive: true });

		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ x: "abc" }), "utf8");
		const nonNumeric = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(nonNumeric.gates[0]!.status, "FAIL");
		assert.ok(nonNumeric.gates[0]!.checks[0]!.failure_reason?.includes("finite number"));

		// 1e999 is valid JSON text but parses to Infinity.
		await writeFile(join(dir, "results", "r.json"), '{"x": 1e999}', "utf8");
		const infinity = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(infinity.gates[0]!.status, "FAIL");
		assert.ok(infinity.gates[0]!.checks[0]!.failure_reason?.includes("finite number"));

		await writeFile(join(dir, "results", "r.json"), JSON.stringify({}), "utf8");
		const missing = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(missing.gates[0]!.status, "FAIL");
	});
});

test("numeric checks support array length paths (folds.length)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Folds, kind: numeric, file: results/r.json, path: folds.length, min: 2 }`,
			),
		});
		await mkdir(join(dir, "results"), { recursive: true });
		await writeFile(join(dir, "results", "r.json"), JSON.stringify({ folds: [{ id: "a" }] }), "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.ok(result.gates[0]!.checks[0]!.failure_reason?.includes("below min"));
	});
});

test("recipe checks run declared recipes and record run evidence", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: "recipes:\n  - name: check:lint\n    command: [\"node\", \"-e\", \"process.exit(0)\"]\n",
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Lint, kind: recipe, recipe: check:lint }`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS");
		const evidence = result.gates[0]!.checks[0]!.evidence;
		assert.equal(evidence[0]!.type, "recipe_run");
		assert.equal(evidence[0]!.recipe, "check:lint");
		assert.equal(evidence[0]!.exit_code, 0);
		assert.ok(evidence[0]!.run_id, "recipe run id recorded");
	});
});

test("recipe checks fail when no alternative recipe is declared", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: "recipes:\n  - name: unrelated\n    command: [\"true\"]\n",
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Lint, kind: recipe, recipes: [check:lint, lint] }`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.ok(result.gates[0]!.checks[0]!.failure_reason?.includes("no declared recipe"));
	});
});

test("failed recipes fail their check with the run outcome recorded", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: "recipes:\n  - name: check:lint\n    command: [\"node\", \"-e\", \"process.exit(2)\"]\n",
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Lint, kind: recipe, recipe: check:lint }`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.equal(result.gates[0]!.checks[0]!.evidence[0]!.exit_code, 2);
	});
});

test("manual evidence is explicitly marked as type manual", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Audit, kind: manual, prompt: "audit" }`,
			),
		});
		const result = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "g1.1": "manual review completed" },
		});
		const evidenceJson = (await readRunFile(result.runDir, "evidence.json")) as { checks: Record<string, { evidence: { type: string; provided_by: string }[] }> };
		const evidence = evidenceJson.checks["g1.1"]!.evidence;
		assert.equal(evidence[0]!.type, "manual");
		assert.equal(evidence[0]!.provided_by, "user-command");

		const manifest = await readManifest(dir, result.runId);
		assert.ok(manifest);
		evidence[0]!.provided_by = "manual-input";
		await writeFile(join(result.runDir, "evidence.json"), JSON.stringify(evidenceJson), "utf8");
		assert.equal(
			await readPersistedGateRunFacts(dir, result.runId, manifest),
			null,
			"legacy/untrusted provenance cannot reconstruct reusable human evidence",
		);
	});
});

test("schema checks validate quant-result artifacts and keep failed folds visible", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Contract, kind: schema, file: results/quant-result.json, schema: quant-result }`,
			),
		});
		await mkdir(join(dir, "results"), { recursive: true });
		const artifact = makeValidQuantResult({
			folds: [
				{ id: "f1", status: "failed" },
				{ id: "f2", status: "passed", metrics: { return: 0.1, sharpe: 0.7 } },
			],
		});
		await writeFile(join(dir, "results", "quant-result.json"), JSON.stringify(artifact), "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS");
		const evidence = result.gates[0]!.checks[0]!.evidence[0]!;
		assert.equal(evidence.type, "schema");
		assert.ok((evidence.detail ?? "").includes("failed folds reported: f1"), "failed folds must stay visible in the evidence");

		// A contract violation fails the check.
		const broken = makeValidQuantResult();
		delete (broken.metrics as Record<string, unknown>).return;
		await writeFile(join(dir, "results", "quant-result.json"), JSON.stringify(broken), "utf8");
		const failed = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(failed.gates[0]!.status, "FAIL");
		assert.ok(failed.gates[0]!.checks[0]!.failure_reason?.includes("does not conform"));
	});
});

test("artifact checks use persisted run records, never model claims", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: [
				"recipes:",
				'  - name: producer',
				'    command: ["node", "-e", "require(\\"fs\\").mkdirSync(\\"out\\", { recursive: true }); require(\\"fs\\").writeFileSync(\\"out/result.json\\", \\"{}\\")"]',
				'    writes: ["out/"]',
				"    mutation: artifacts",
				'    artifacts: [{ path: "out/*.json", required: true, min_bytes: 1, freshness: current }]',
				"",
			].join("\n"),
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Output produced, kind: artifact, artifact_recipe: producer, glob: "out/*.json" }`,
			),
		});
		await gitBacked(dir);
		const before = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(before.gates[0]!.status, "FAIL", "no run of the recipe exists yet — must fail, not pass");

		const recipe = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(recipe.ok, true);
		const after = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(after.gates[0]!.status, "PASS", after.gates[0]!.checks[0]!.failure_reason ?? "");
		assert.equal(after.gates[0]!.checks[0]!.evidence[0]!.run_id, recipe.record?.run_id);
	});
});

test("current artifact checks reject a producer whose validation authority is stale", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: [
				"recipes:",
				"  - name: producer",
				'    command: ["node", "-e", "require(\\"fs\\").mkdirSync(\\"out\\", { recursive: true }); require(\\"fs\\").writeFileSync(\\"out/result.json\\", \\"{}\\")"]',
				"    writes: [out/]",
				"    mutation: artifacts",
				'    artifacts: [{ path: "out/*.json", required: true, min_bytes: 1, freshness: current }]',
				"",
			].join("\n"),
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Output, kind: artifact, artifact_recipe: producer }`),
		});
		await gitBacked(dir);
		const producer = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(producer.ok, true, producer.error ?? "");
		assert.equal((await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec })).status, "PASS");

		await spawnExec("git", ["add", "out/result.json"], { cwd: dir });
		await spawnExec("git", ["commit", "-qm", "record output"], { cwd: dir });
		const stale = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(stale.status, "FAIL");
		assert.match(stale.gates[0]!.checks[0]!.failure_reason ?? "", /not current reusable authority/);
		assert.match(stale.gates[0]!.checks[0]!.evidence[0]!.detail, /commit-mismatch|diff-mismatch/);
	});
});

test("artifact authority binds the exact producer run identity even when validation facts are otherwise equal", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: [
				"recipes:",
				"  - name: producer",
				'    command: ["node", "-e", "require(\\"fs\\").mkdirSync(\\"out\\", { recursive: true }); require(\\"fs\\").writeFileSync(\\"out/result.json\\", \\"{}\\")"]',
				"    writes: [out/]",
				"    mutation: artifacts",
				'    artifacts: [{ path: "out/*.json", required: true, min_bytes: 1, freshness: current }]',
				"",
			].join("\n"),
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Output, kind: artifact, artifact_recipe: producer }`),
		});
		await gitBacked(dir);
		const firstSource = await runRecipe({
			projectRoot: dir,
			recipeName: "producer",
			mode: "DEV",
			exec: spawnExec,
			actorFacts: SOL_FACTS,
			now: () => new Date("2098-01-01T00:00:00.000Z"),
		});
		assert.equal(firstSource.ok, true, firstSource.error ?? "");
		const firstGate = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(firstGate.status, "PASS");

		const secondSource = await runRecipe({
			projectRoot: dir,
			recipeName: "producer",
			mode: "DEV",
			exec: spawnExec,
			actorFacts: SOL_FACTS,
			now: () => new Date("2098-01-01T00:00:01.000Z"),
		});
		assert.equal(secondSource.ok, true, secondSource.error ?? "");
		const secondGate = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(secondGate.status, "PASS");

		const firstManifest = (await readRunFile(firstGate.runDir, "manifest.json")) as { validation_evidence: ValidationEvidenceBlock };
		const secondManifest = (await readRunFile(secondGate.runDir, "manifest.json")) as { validation_evidence: ValidationEvidenceBlock };
		assert.notEqual(firstSource.record?.run_id, secondSource.record?.run_id);
		assert.notEqual(
			firstManifest.validation_evidence.binding?.gate_state_hash,
			secondManifest.validation_evidence.binding?.gate_state_hash,
			"source run identity is part of the privacy-safe gate-state hash",
		);
	});
});

test("config checks fail when the workbench config has issues", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "project.yaml", "name: no-profile\n"); // profile missing → config issue
		await writeConfigFile(dir, "gates.yaml", "gates: []\n");
		const result = await runGates({ projectRoot: dir, selector: "b0", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.ok(result.gates[0]!.checks[0]!.failure_reason?.includes("config"));
	});
});

// ---------------------------------------------------------------------------
// Profiles: quant gates only for quant profiles
// ---------------------------------------------------------------------------

test("quant gates load only for quant profiles", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "generic" });
		const generic = await loadGates(dir);
		assert.deepEqual(generic.map((g) => g.id), ["b0", "b1", "b2", "b3", "b4", "b5", "b6"]);
		assert.ok(!generic.some((g) => g.id.startsWith("q")), "generic must not load quant gates");
	});

	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "quant-research/stock-selection" });
		const quant = await loadGates(dir);
		const ids = quant.map((g) => g.id);
		assert.deepEqual(ids, ["b0", "b1", "b2", "b3", "b4", "b5", "b6", "q0", "q1", "q2", "q3", "q4", "q5"]);
	});
});

test("generic profiles do not enforce quant gates (running all)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "generic" });
		await writeFile(join(dir, "package.json"), "{}", "utf8");
		await writeConfigFile(dir, "recipes.yaml", "recipes: []\n");
		const result = await runGates({ projectRoot: dir, selector: "all", mode: "DEV", exec: spawnExec });
		const ids = result.gates.map((g) => g.id);
		assert.ok(ids.includes("b0") && ids.includes("b5"), "base gates run");
		assert.ok(!ids.some((id) => id.startsWith("q")), "quant gates must not be evaluated for generic");
	});

	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "generic" });
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "q0", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("quant gates load only for quant-research profiles"),
		);
	});
});

test("the full base ladder passes when recipes and manual evidence are provided", async () => {
	await withTempDir(async (dir) => {
		const recipes = [
			"recipes:",
			'  - { name: check:format, command: ["node", "-e", "process.exit(0)"] }',
			'  - { name: check:lint, command: ["node", "-e", "process.exit(0)"] }',
			'  - { name: check:typecheck, command: ["node", "-e", "process.exit(0)"] }',
			'  - { name: check:static, command: ["node", "-e", "process.exit(0)"] }',
			'  - { name: test:unit, command: ["node", "-e", "process.exit(0)"] }',
			'  - { name: test:integration, command: ["node", "-e", "process.exit(0)"] }',
			"",
		].join("\n");
		await setupProject(dir, { profile: "generic", recipesYaml: recipes });
		await writeFile(join(dir, "package.json"), "{}", "utf8");
		const manualEvidence: Record<string, string> = {};
		for (const id of ["b2.2", "b2.3", "b3.2", "b3.3", "b4.1", "b4.2", "b4.3", "b5.1", "b5.2"]) {
			manualEvidence[id] = `manual evidence for ${id}`;
		}
		// P7: B6 is machine-backed — the runtime injects the bounded
		// worker-first compliance facts (clean state: strict policy active,
		// hard denial on, no delegation, lease locked, Sol-initiated run).
		const workerFirstFacts: WorkerFirstGateFacts = {
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
		const result = await runGates({ projectRoot: dir, selector: "all", mode: "DEV", exec: spawnExec, manualEvidence, workerFirstFacts });
		assert.equal(result.ok, true, `expected full base ladder PASS, got ${result.gates.map((g) => `${g.id}:${g.status}`).join(", ")}`);
		for (const g of result.gates) assert.equal(g.status, "PASS");
	});
});

// ---------------------------------------------------------------------------
// Path containment and gate config errors
// ---------------------------------------------------------------------------

test("evidence paths that escape the project root are rejected", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Evil, kind: file, path: ../evil.txt }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("escapes the project root"),
		);
	});

	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Evil, kind: json, file: /etc/passwd, path: x }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("escapes the project root"),
		);
	});
});

test("symlink escapes are rejected for evidence paths", async () => {
	await withTempDir(async (dir) => {
		await symlink("/etc", join(dir, "etc-link"));
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Evil, kind: file, path: etc-link/passwd }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("escapes the project root"),
		);
	});
});

test("invalid gates.yaml aborts the run with a setup error", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: X, kind: made-up-kind }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("kind"),
		);
	});
});

test("required/blocking accept literal booleans only and malformed flags allocate no run", async () => {
	for (const invalid of ["true", "yes", 1, null, [], {}]) {
		const parsed = parseGate({
			id: "g1",
			title: "G1",
			required: invalid,
			blocking: invalid,
			checks: [{ id: "g1.1", title: "C", kind: "config", required: invalid, blocking: invalid }],
		}, 0);
		assert.equal(parsed.gate, undefined, `invalid boolean-like value must reject: ${JSON.stringify(invalid)}`);
		assert.ok(parsed.errors.some((error) => error.includes("must be a boolean")));
	}

	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    required: "true"\n    checks:\n${CONFIG_CHECK}`),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes('"required" must be a boolean'),
		);
		await assert.rejects(readdir(join(dir, ".pi", "workbench", "runs")), { code: "ENOENT" });
	});
});

test("project configuration cannot replace or downgrade the reserved built-in B6", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(`  - id: b6\n    title: Fake safety\n    checks:\n      - { id: fake.1, title: Config only, kind: config }`),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes('gate "b6" is reserved'),
		);
		await assert.rejects(readdir(join(dir, ".pi", "workbench", "runs")), { code: "ENOENT" });
	});
});

test("model-tool notes cannot satisfy a human manual check", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Human audit, kind: manual, prompt: "audit" }`),
		});
		const result = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "g1.1": "the model says a human approved" },
			manualEvidenceProvenance: "model-tool",
			actorFacts: SOL_FACTS,
		});
		assert.equal(result.status, "NOT_RUN");
		assert.equal(result.ok, false);
		assert.equal(result.gates[0]!.checks[0]!.evidence.length, 0);
		const evidence = JSON.stringify(await readRunFile(result.runDir, "evidence.json"));
		assert.ok(!evidence.includes("the model says"), "advisory model text is not persisted as human evidence");
	});
});

test("gate config uses a fixed same-handle UTF-8 read cap before YAML parsing", async () => {
	await withTempDir(async (dir) => {
		const normal = gatesYaml(`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`);
		await setupProject(dir, { gatesYaml: normal });
		const gatePath = join(dir, ".pi", "workbench", "gates.yaml");

		const normalAllocations: number[] = [];
		const normalStats: number[] = [];
		const loaded = await loadGates(dir, {
			afterInitialStat: (source) => {
				normalStats.push(source.fileSize);
			},
			onBufferAllocate: (bytes) => normalAllocations.push(bytes),
		});
		assert.ok(loaded.some((gate) => gate.id === "g1"), "a normal bounded project gate remains loadable");
		assert.deepEqual(normalStats, [Buffer.byteLength(normal, "utf8")], "the opened handle is statted before allocation");
		assert.deepEqual(normalAllocations, [Buffer.byteLength(normal, "utf8")]);

		const sparse = await open(gatePath, "w");
		try {
			await sparse.truncate(GATE_CONFIG_MAX_BYTES + 1);
		} finally {
			await sparse.close();
		}
		const oversizedAllocations: number[] = [];
		await assert.rejects(
			loadGates(dir, { onBufferAllocate: (bytes) => oversizedAllocations.push(bytes) }),
			(error) => error instanceof GateSetupError && error.message === GATE_CONFIG_READ_ERROR,
		);
		assert.deepEqual(oversizedAllocations, [], "oversized sparse gate config is rejected before allocation");
		const runOversizedAllocations: number[] = [];
		await assert.rejects(
			runGates({
				projectRoot: dir,
				selector: "g1",
				mode: "DEV",
				exec: spawnExec,
				gateConfigReadHooks: { onBufferAllocate: (bytes) => runOversizedAllocations.push(bytes) },
			}),
			(error) => error instanceof GateSetupError && error.message === GATE_CONFIG_READ_ERROR,
		);
		assert.deepEqual(runOversizedAllocations, [], "formal gate selection also rejects oversized config before allocation");

		await rm(gatePath);
		await mkdir(gatePath);
		const nonRegularAllocations: number[] = [];
		await assert.rejects(
			loadGates(dir, { onBufferAllocate: (bytes) => nonRegularAllocations.push(bytes) }),
			(error) => error instanceof GateSetupError && error.message === GATE_CONFIG_READ_ERROR,
		);
		assert.deepEqual(nonRegularAllocations, [], "non-regular gate config is rejected before allocation");

		await rm(gatePath, { recursive: true });
		await writeFile(gatePath, Buffer.from([0x67, 0x61, 0x80]));
		const invalidUtf8Allocations: number[] = [];
		await assert.rejects(
			loadGates(dir, { onBufferAllocate: (bytes) => invalidUtf8Allocations.push(bytes) }),
			(error) => error instanceof GateSetupError && error.message === GATE_CONFIG_READ_ERROR,
		);
		assert.deepEqual(invalidUtf8Allocations, [3], "bounded bytes are allocated only after type/size preflight");

		await writeFile(gatePath, normal, "utf8");
		let mutationHookCalls = 0;
		await assert.rejects(
			loadGates(dir, {
				afterRead: async () => {
					mutationHookCalls += 1;
					await writeFile(gatePath, `${normal}# changed during read\n`, "utf8");
				},
			}),
			(error) => error instanceof GateSetupError && error.message === GATE_CONFIG_READ_ERROR,
		);
		assert.equal(mutationHookCalls, 1, "the post-read stat checks the same opened handle");
	});
});

test("gate selection, project config and validation binding share one bounded gates.yaml snapshot", async () => {
	await withTempDir(async (dir) => {
		const original = gatesYaml(`  - id: g1\n    title: Original G1\n    checks:\n${CONFIG_CHECK}`);
		const replacement = "x".repeat(GATE_CONFIG_MAX_BYTES + 1);
		await setupProject(dir, { gatesYaml: original });
		await gitBacked(dir);
		const gatePath = join(dir, ".pi", "workbench", "gates.yaml");
		const allocations: number[] = [];
		let stableSnapshots = 0;

		const result = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			gateConfigReadHooks: {
				onBufferAllocate: (bytes) => allocations.push(bytes),
				afterStableSnapshot: async () => {
					stableSnapshots += 1;
					// Replace the pathname only AFTER the authoritative open handle was
					// read and verified. Any generic second gates.yaml read would observe
					// an oversized foreign snapshot and split or exhaust binding capture.
					await writeFile(gatePath, replacement, "utf8");
				},
			},
		});

		assert.equal(stableSnapshots, 1);
		assert.deepEqual(allocations, [Buffer.byteLength(original, "utf8")], "exactly one bounded gate-config buffer is allocated");
		assert.equal(result.ok, true);
		assert.deepEqual(result.requested, ["g1"]);
		assert.deepEqual(result.gates.map((gate) => gate.id), ["g1"], "execution uses the original stable snapshot");

		const manifest = (await readRunFile(result.runDir, "manifest.json")) as { validation_evidence: ValidationEvidenceBlock };
		const binding = manifest.validation_evidence.binding;
		assert.ok(binding, manifest.validation_evidence.unavailable_reason ?? "validation binding unavailable");
		const originalDoc = parseYaml(original) as { gates: unknown[] };
		const expectedOriginalHash = gateStateHash({
			profile: "generic",
			projectGates: originalDoc.gates,
			manualEvidence: {},
			prerequisiteStatus: {},
		});
		assert.equal(binding.gate_state_hash, expectedOriginalHash, "binding hashes the exact project-gate snapshot that executed");
		assert.equal(
			binding.config_hash,
			canonicalHash({
				"project.yaml": sha256Hex("name: test-project\nprofile: generic\n"),
				"recipes.yaml": "missing",
				"gates.yaml": sha256Hex(original),
				"profiles.yaml": "missing",
			}),
			"config binding reuses the first stable gates.yaml bytes even after the pathname becomes oversized",
		);
		assert.deepEqual(
			allocations,
			[Buffer.byteLength(original, "utf8")],
			"validation capture performs no later gates.yaml allocation after the original bounded snapshot",
		);
	});
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test("gate results persist the full run record layout", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		const files = (await readFile(join(result.runDir, "manifest.json"), "utf8")).length > 0;
		assert.ok(files);
		const entries = (await import("node:fs/promises")).readdir;
		const names = (await entries(result.runDir)).sort();
		assert.deepEqual(names, ["artifacts", "command.json", "environment.json", "evidence.json", "gates.json", "manifest.json", "run-commit.json", "stderr.log", "stdout.log", "summary.json"]);

		const manifest = (await readRunFile(result.runDir, "manifest.json")) as Record<string, unknown>;
		assert.equal(manifest.run_id, result.runId);
		assert.equal(manifest.recipe, "gate");
		assert.equal(manifest.exit_code, 0);
		assert.equal(manifest.profile, "generic");
		assert.ok(manifest.started_at && manifest.finished_at);
		assert.equal(typeof manifest.duration_ms, "number");

		const gates = (await readRunFile(result.runDir, "gates.json")) as {
			schema_version: number;
			run_id: string;
			requested: string[];
			gates: {
				id: string;
				status: string;
				prerequisites: string[];
				checks: unknown[];
				evidence_paths: string[];
				failure_reason: string | null;
				blocked_reason: string | null;
				started_at: string;
				finished_at: string;
			}[];
		};
		assert.equal(gates.schema_version, 1);
		assert.equal(gates.run_id, result.runId);
		assert.deepEqual(gates.requested, ["g1"]);
		const g = gates.gates[0]!;
		assert.equal(g.id, "g1");
		assert.equal(g.status, "PASS");
		assert.deepEqual(g.prerequisites, []);
		assert.equal(g.checks.length, 1);
		assert.ok(g.evidence_paths.length > 0, "evidence paths must be recorded");
		assert.equal(g.failure_reason, null);
		assert.equal(g.blocked_reason, null);
		assert.ok(g.started_at && g.finished_at);

		const summary = (await readRunFile(result.runDir, "summary.json")) as Record<string, unknown>;
		assert.equal(summary.status, "PASS");
		assert.equal(summary.kind, "gate");
		assert.ok(typeof summary.stdout === "string");
	});
});

test("repeated runs produce independent run ids", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`,
			),
		});
		const first = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		const second = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.notEqual(first.runId, second.runId);
		assert.notEqual(first.runDir, second.runDir);
		assert.equal(await latestGateStatus(dir, "g1").then((s) => s?.run_id), second.runId, "the latest status must come from the newest run");
	});
});

test("latest gate status rejects a marker whose start identity contradicts the committed manifest", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`,
			),
		});
		const result = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			now: () => new Date("2026-08-23T12:00:00.000Z"),
		});
		const markerPath = join(dir, ".pi", "workbench", "runs", GATE_ATTEMPT_INDEX_DIR, `${result.runId}.json`);
		const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
		marker.started_at = "2026-08-23T11:59:59.000Z";
		await writeFile(markerPath, JSON.stringify(marker), "utf8");
		clearGateRunCandidateCacheForTests(dir);
		assert.equal(await latestGateStatus(dir, "g1"), null, "marker/manifest start mismatch is UNKNOWN, never PASS");
	});
});

test("persisted gate/evidence authority readers preflight size/type before allocation and fail closed on corruption", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`,
			),
		});
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		const manifest = await readManifest(dir, result.runId);
		assert.ok(manifest);
		assert.ok(await readPersistedGateRunFacts(dir, result.runId, manifest), "normal authority records remain compatible");
		assert.ok(await readGateFileRecord(dir, result.runId), "every successful gate record is accepted by the bounded presentation reader");
		const gatesPath = join(result.runDir, "gates.json");
		const evidencePath = join(result.runDir, "evidence.json");
		const gatesOriginal = await readFile(gatesPath, "utf8");
		const evidenceOriginal = await readFile(evidencePath, "utf8");
		assert.ok(Buffer.byteLength(gatesOriginal, "utf8") <= GATE_AUTHORITY_RECORD_MAX_BYTES);
		assert.ok(Buffer.byteLength(evidenceOriginal, "utf8") <= GATE_AUTHORITY_RECORD_MAX_BYTES);

		await writeFile(gatesPath, "x".repeat(GATE_AUTHORITY_RECORD_MAX_BYTES + 1), "utf8");
		const gatesAllocations: number[] = [];
		assert.equal(
			await readPersistedGateRunFacts(dir, result.runId, manifest, { gates: { onBufferAllocate: (bytes) => gatesAllocations.push(bytes) } }),
			null,
		);
		assert.deepEqual(gatesAllocations, [], "oversized gates.json is rejected before allocation");
		const latestAllocations: number[] = [];
		assert.equal(await latestGateStatus(dir, "g1", { onBufferAllocate: (bytes) => latestAllocations.push(bytes) }), null);
		assert.deepEqual(latestAllocations, [], "historical status reader also rejects oversized gates.json before allocation");

		await writeFile(gatesPath, gatesOriginal, "utf8");
		await writeFile(evidencePath, "x".repeat(GATE_AUTHORITY_RECORD_MAX_BYTES + 1), "utf8");
		const evidenceAllocations: number[] = [];
		assert.equal(
			await readPersistedGateRunFacts(dir, result.runId, manifest, { evidence: { onBufferAllocate: (bytes) => evidenceAllocations.push(bytes) } }),
			null,
		);
		assert.deepEqual(evidenceAllocations, [], "oversized evidence.json is rejected before allocation");

		await writeFile(evidencePath, "{not-json", "utf8");
		assert.equal(await readPersistedGateRunFacts(dir, result.runId, manifest), null, "corrupt evidence fails closed");
		await writeFile(evidencePath, evidenceOriginal, "utf8");
		await rm(gatesPath);
		await mkdir(gatesPath);
		const nonRegularAllocations: number[] = [];
		assert.equal(
			await readPersistedGateRunFacts(dir, result.runId, manifest, { gates: { onBufferAllocate: (bytes) => nonRegularAllocations.push(bytes) } }),
			null,
		);
		assert.deepEqual(nonRegularAllocations, [], "non-regular gates.json is rejected before allocation");
	});
});

test("large check/path volume fails closed before writing unreadable gate authority", async () => {
	await withTempDir(async (dir) => {
		const segmentA = "a".repeat(190);
		const segmentB = "b".repeat(190);
		const segmentC = "c".repeat(190);
		const checks = Array.from({ length: 500 }, (_, index) => {
			const paths = ["one", "two", "three"].map((variant) => `missing/${segmentA}/${segmentB}/${segmentC}/${variant}-${index}.json`);
			return `      - { id: g1.${index + 1}, title: Path ${index + 1}, kind: file, any_of: [${paths.join(", ")}] }`;
		}).join("\n");
		await setupProject(dir, {
			gatesYaml: gatesYaml(`  - id: g1\n    title: Large path gate\n    checks:\n${checks}`),
		});

		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message === GATE_AUTHORITY_PERSISTENCE_ERROR,
		);

		const runRoot = join(dir, ".pi", "workbench", "runs");
		const runIds = (await readdir(runRoot)).filter((name) => name !== ".gate-index");
		assert.equal(runIds.length, 1, "evaluation may allocate one private run directory before final authority compilation");
		assert.equal((await readdir(join(runRoot, ".gate-index"))).length, 1, "the pre-evaluation attempt marker remains as fail-closed UNKNOWN authority");
		const files = await readdir(join(runRoot, runIds[0]!));
		assert.ok(files.includes("artifacts"));
		assert.ok(!files.includes("gates.json"), "oversized complete gates facts are never silently truncated or persisted unreadably");
		assert.ok(!files.includes("evidence.json"), "neither authority half is opened before both compiled records fit");
		assert.ok(!files.includes("manifest.json"), "the rejected run is never advertised as a gate authority run");
	});
});

// ---------------------------------------------------------------------------
// gates.yaml overrides
// ---------------------------------------------------------------------------

test("project gate definitions replace built-in catalog gates by id", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: b0\n    title: Custom Readiness\n    checks:\n      - { id: b0.1, title: Config only, kind: config }`,
			),
		});
		const gates = await loadGates(dir);
		const b0 = gates.find((g) => g.id === "b0");
		assert.equal(b0?.title, "Custom Readiness");
		assert.equal(b0?.source, "project");
		assert.equal(b0?.checks.length, 1);

		const result = await runGates({ projectRoot: dir, selector: "b0", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.checks.length, 1, "the yaml definition fully replaced the built-in");
		assert.equal(result.gates[0]!.status, "PASS");
	});
});

// ---------------------------------------------------------------------------
// P7 slice 3: B6 Worker-First Compliance (machine-backed injected facts)
// ---------------------------------------------------------------------------

function cleanWorkerFirstFacts(overrides: Partial<WorkerFirstGateFacts> = {}): WorkerFirstGateFacts {
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

test("B6 is the development-safety base gate with eight legacy-compatible machine checks", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "generic" });
		const gates = await loadGates(dir);
		const b6 = gates.find((g) => g.id === "b6");
		assert.ok(b6, "b6 loads for generic profiles (universal base gate)");
		assert.equal(b6!.source, "catalog");
		assert.equal(b6!.title, "Development Safety");
		assert.match(b6!.description, /fixed Sol\/Luna policy active/);
		assert.match(b6!.description, /commander writes locked or explicitly leased/);
		assert.equal(b6!.prerequisites.length, 0, "B6 is independent of B0-B5 (no manual-evidence prerequisites)");
		assert.equal(b6!.required, true);
		assert.equal(b6!.blocking, true);
		assert.equal(b6!.checks.length, 8, "exactly the eight machine-backed checks");
		for (const c of b6!.checks) {
			assert.equal(c.kind, "worker-first");
			assert.equal(c.required, true);
			assert.ok(c.worker_first, `check ${c.id} names a worker_first assertion`);
		}
		assert.deepEqual(
			b6!.checks.map((c) => c.worker_first),
			[
				"strict-policy-active",
				"no-unauthorized-commander-writes",
				"no-pending-review",
				"no-stale-review",
				"reviewed-hash-matches-current",
				"worker-paths-within-contracts",
				"no-active-unexplained-lease",
				"commander-initiated-final-verification",
			],
		);
	});
});

test("B6 passes with clean injected facts (no manual evidence can be involved)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const result = await runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec, workerFirstFacts: cleanWorkerFirstFacts() });
		assert.equal(result.ok, true);
		assert.equal(result.gates[0]!.status, "PASS");
		for (const c of result.gates[0]!.checks) {
			assert.equal(c.status, "PASS", `${c.check_id}: ${c.failure_reason ?? c.blocked_reason ?? ""}`);
			assert.ok(c.evidence.some((e) => e.type === "worker_first"), `${c.check_id} records worker_first evidence`);
		}
	});
});

test("B6 fails on negative compliance facts (policy off, hash mismatch, violations, unexplained active lease, non-Sol initiator)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const cases: Array<{ label: string; facts: WorkerFirstGateFacts; failed: string[]; passed: string[] }> = [
			{
				label: "policy not active",
				facts: cleanWorkerFirstFacts({ writePolicy: null }),
				failed: ["b6.1"],
				passed: ["b6.2", "b6.3", "b6.4", "b6.5", "b6.6", "b6.7", "b6.8"],
			},
			{
				label: "unauthorized writes with denial off",
				facts: cleanWorkerFirstFacts({ commanderWritesDenied: false, blockedCommanderWriteAttempts: 3 }),
				failed: ["b6.2"],
				passed: ["b6.1", "b6.3", "b6.4", "b6.5", "b6.6", "b6.7", "b6.8"],
			},
			{
				label: "reviewed hash mismatch",
				facts: cleanWorkerFirstFacts({
					hasDelegation: true,
					latestDelegationId: "20260101-120000-abcd",
					reviewStatus: "REVIEWED",
					currentDiffHash: "a".repeat(64),
					reviewedDiffHash: "b".repeat(64),
					reviewVerdict: "PASS",
					reviewViolationCount: 0,
				}),
				failed: ["b6.5"],
				passed: ["b6.1", "b6.2", "b6.3", "b6.4", "b6.6", "b6.7", "b6.8"],
			},
			{
				label: "worker paths outside contracts",
				facts: cleanWorkerFirstFacts({
					hasDelegation: true,
					latestDelegationId: "20260101-120000-abcd",
					reviewStatus: "REVIEWED",
					currentDiffHash: "a".repeat(64),
					reviewedDiffHash: "a".repeat(64),
					reviewVerdict: "FAIL",
					reviewViolationCount: 2,
				}),
				failed: ["b6.6"],
				passed: ["b6.1", "b6.2", "b6.3", "b6.4", "b6.5", "b6.7", "b6.8"],
			},
			{
				label: "active lease without audited reason",
				facts: cleanWorkerFirstFacts({ leaseStatus: "active", leaseReason: null, leaseCallsUsed: 1, leaseMaxCalls: 10 }),
				failed: ["b6.7"],
				passed: ["b6.1", "b6.2", "b6.3", "b6.4", "b6.5", "b6.6", "b6.8"],
			},
			{
				label: "gate run initiated by another controller",
				facts: cleanWorkerFirstFacts({ actor: "other-controller", gateRunInitiatedByCommander: false }),
				failed: ["b6.8"],
				passed: ["b6.1", "b6.2", "b6.3", "b6.4", "b6.5", "b6.6", "b6.7"],
			},
		];
		for (const scenario of cases) {
			const result = await runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec, workerFirstFacts: scenario.facts });
			assert.equal(result.ok, false, `${scenario.label}: gate must not pass`);
			const statuses = new Map(result.gates[0]!.checks.map((c) => [c.check_id, c.status]));
			for (const id of scenario.failed) assert.equal(statuses.get(id), "FAIL", `${scenario.label}: ${id} must FAIL`);
			for (const id of scenario.passed) assert.equal(statuses.get(id), "PASS", `${scenario.label}: ${id} must PASS`);
		}
	});
});

test("B6 checks are BLOCKED when the facts carry a blocked reason (pending/stale review blocks final verification)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const facts = cleanWorkerFirstFacts({
			hasDelegation: true,
			latestDelegationId: "20260101-120000-abcd",
			reviewStatus: "PENDING_REVIEW",
			currentDiffHash: "a".repeat(64),
			blockedReason: "VERIFY mode / final gate verification is blocked while delegation 20260101-120000-abcd is PENDING_REVIEW; review the current diff first",
		});
		const result = await runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec, workerFirstFacts: facts });
		assert.equal(result.gates[0]!.status, "BLOCKED");
		assert.equal(result.ok, false);
		for (const c of result.gates[0]!.checks) {
			assert.equal(c.status, "BLOCKED", `${c.check_id} must be BLOCKED`);
			assert.ok(c.blocked_reason?.includes("PENDING_REVIEW"));
		}
	});
});

test("B6 without injected facts is NOT_RUN and a required NOT_RUN never PASSes", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		// No facts at all: every worker-first check is NOT_RUN, the gate is
		// NOT_RUN and never PASSes — model prose/manual evidence cannot help.
		const result = await runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "NOT_RUN");
		assert.equal(result.ok, false);
		for (const c of result.gates[0]!.checks) assert.equal(c.status, "NOT_RUN");
		// Manual evidence for worker-first check ids must not change anything.
		const withManual = await runGates({
			projectRoot: dir,
			selector: "b6",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "b6.1": "the policy is definitely active, trust me" },
		});
		assert.equal(withManual.gates[0]!.status, "NOT_RUN", "manual evidence can never satisfy worker-first checks");
	});
});

test("partial facts produce NOT_RUN only for the checks whose fact is missing", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		const facts = cleanWorkerFirstFacts({
			hasDelegation: true,
			latestDelegationId: "20260101-120000-abcd",
			reviewStatus: null, // review facts missing
			leaseStatus: null, // lease facts missing
		});
		const result = await runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec, workerFirstFacts: facts });
		const statuses = new Map(result.gates[0]!.checks.map((c) => [c.check_id, c.status]));
		assert.equal(statuses.get("b6.1"), "PASS");
		assert.equal(statuses.get("b6.3"), "NOT_RUN", "missing review-status fact -> NOT_RUN");
		assert.equal(statuses.get("b6.4"), "NOT_RUN");
		assert.equal(statuses.get("b6.7"), "NOT_RUN", "missing lease-status fact -> NOT_RUN");
		assert.equal(result.gates[0]!.status, "NOT_RUN", "required NOT_RUN checks keep the gate NOT_RUN");
	});
});

test("gates.yaml worker-first checks validate strictly (kind + worker_first name)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: WF, kind: worker-first }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("worker_first"),
		);
	});
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: WF, kind: worker-first, worker_first: made-up }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("worker_first"),
		);
	});
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: WF, kind: file, worker_first: strict-policy-active }`,
			),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("worker_first"),
		);
	});
});

test("B6 runs directly with selector b6 without any B0-B5 evidence", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir);
		// No manual evidence, no recipes, no B0-B5 prerequisite runs: B6 still
		// evaluates from the injected facts alone.
		const result = await runGates({ projectRoot: dir, selector: "b6", mode: "DEV", exec: spawnExec, workerFirstFacts: cleanWorkerFirstFacts() });
		assert.equal(result.ok, true);
		assert.equal(result.gates[0]!.status, "PASS");
	});
});

// ---------------------------------------------------------------------------
// P7 slice 3: gate-engine recipe checks apply the shared mutation policy
// ---------------------------------------------------------------------------

test("recipe checks apply the shared mutation policy: strict Sol denies mutation:source, workers run only mutation:none", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: [
				"recipes:",
				'  - { name: fmt, command: ["node", "-e", "process.exit(0)"], mutation: source, writes: ["src/"] }',
				'  - { name: build, command: ["node", "-e", "process.exit(0)"], mutation: artifacts, artifacts: ["dist/**"] }',
				'  - { name: verify, command: ["node", "-e", "process.exit(0)"], mutation: none }',
				"",
			].join("\n"),
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Fmt, kind: recipe, recipe: fmt }`,
					`  - id: g2\n    title: G2\n    checks:\n      - { id: g2.1, title: Build, kind: recipe, recipe: build }`,
					`  - id: g3\n    title: G3\n    checks:\n      - { id: g3.1, title: Verify, kind: recipe, recipe: verify }`,
				].join("\n"),
			),
		});
		// Strict Sol: mutation:source recipe check is BLOCKED; none/artifacts run.
		const sol = await runGates({
			projectRoot: dir,
			selector: "g1,g2,g3",
			mode: "DEV",
			exec: spawnExec,
			actorFacts: { role: undefined, provider: "openai-codex", model: "gpt-5.6-sol" },
		});
		assert.equal(sol.gates[0]!.status, "BLOCKED");
		assert.ok(sol.gates[0]!.checks[0]!.blocked_reason?.includes("mutation: source"), sol.gates[0]!.checks[0]!.blocked_reason ?? "");
		assert.equal(sol.gates[1]!.status, "PASS", "mutation:artifacts recipe check runs for strict Sol");
		assert.equal(sol.gates[2]!.status, "PASS", "mutation:none recipe check runs for strict Sol");
		// Delegated worker: only mutation:none runs.
		const worker = await runGates({
			projectRoot: dir,
			selector: "g1,g2,g3",
			mode: "DEV",
			exec: spawnExec,
			actorFacts: { role: "worker", provider: "deepseek", model: "deepseek-v4-flash" },
		});
		assert.equal(worker.gates[0]!.status, "BLOCKED");
		assert.equal(worker.gates[1]!.status, "BLOCKED", "workers cannot run mutation:artifacts recipes");
		assert.ok(worker.gates[1]!.checks[0]!.blocked_reason?.includes("mutation: artifacts"));
		assert.equal(worker.gates[2]!.status, "PASS", "workers run mutation:none recipe checks");
		// Other controllers / no actor facts: prior behavior (all run).
		const other = await runGates({ projectRoot: dir, selector: "g1,g2,g3", mode: "DEV", exec: spawnExec });
		assert.equal(other.gates[0]!.status, "PASS");
		assert.equal(other.gates[1]!.status, "PASS");
		assert.equal(other.gates[2]!.status, "PASS");
	});
});

// ---------------------------------------------------------------------------
// P8: safe nested project support (project.yaml project_dir)
// ---------------------------------------------------------------------------

test("file/json/numeric gate checks resolve against the effective project root", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Data, kind: file, path: data/prices.csv }`,
					`  - id: g2\n    title: G2\n    checks:\n      - { id: g2.1, title: JSON, kind: json, file: results/r.json, path: split.method }`,
					`  - id: g3\n    title: G3\n    checks:\n      - { id: g3.1, title: Numeric, kind: numeric, file: results/r.json, path: metrics.return, min: 0 }`,
				].join("\n"),
			),
		);
		// Artifacts exist ONLY under the nested root — never under the repo root.
		await mkdir(join(dir, "research", "data"), { recursive: true });
		await writeFile(join(dir, "research", "data", "prices.csv"), "x", "utf8");
		await mkdir(join(dir, "research", "results"), { recursive: true });
		await writeFile(join(dir, "research", "results", "r.json"), JSON.stringify({ split: { method: "walk-forward" }, metrics: { return: 0.1 } }), "utf8");

		const result = await runGates({ projectRoot: dir, selector: "g1,g2,g3", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS", result.gates[0]!.failure_reason ?? "");
		assert.equal(result.gates[1]!.status, "PASS", result.gates[1]!.failure_reason ?? "");
		assert.equal(result.gates[2]!.status, "PASS", result.gates[2]!.failure_reason ?? "");
		assert.equal(result.ok, true);
	});
});

test("nested gate file checks ignore repository-root files (no fallback to the repo root)", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Data, kind: file, path: data/prices.csv }`),
		);
		// The file exists ONLY at the repo root — the check must still FAIL.
		await mkdir(join(dir, "data"), { recursive: true });
		await writeFile(join(dir, "data", "prices.csv"), "x", "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "FAIL");
		assert.ok(result.gates[0]!.checks[0]!.failure_reason?.includes("no file matched"));
	});
});

test("nested gate file checks still reject symlink escapes relative to the effective root", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await symlink("/etc", join(dir, "research", "etc-link"));
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Evil, kind: file, path: etc-link/passwd }`),
		);
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes("escapes the project root"),
		);
	});
});

test("schema checks read artifacts from the effective project root", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Contract, kind: schema, file: results/quant-result.json, schema: quant-result }`),
		);
		await mkdir(join(dir, "research", "results"), { recursive: true });
		await writeFile(join(dir, "research", "results", "quant-result.json"), JSON.stringify(makeValidQuantResult()), "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS", result.gates[0]!.checks[0]!.failure_reason ?? "");
	});
});

test("gate runs persist at the repository root when project_dir is set", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`),
		);
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS");
		// The run record lives under the REPO root's .pi/workbench/runs — never
		// inside the nested project directory.
		assert.ok(
			result.runDir.startsWith(join(dir, ".pi", "workbench", "runs") + sep),
			`runDir ${result.runDir} must be under the repo root runs dir`,
		);
		const manifest = (await readRunFile(result.runDir, "manifest.json")) as Record<string, unknown>;
		assert.equal(manifest.cwd, dir, "the gate run cwd stays at the repository root");
	});
});

test("recipe execution and artifact checks stay repository-root based with project_dir set", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"recipes.yaml",
			[
				"recipes:",
				'  - name: producer',
				'    command: ["node", "-e", "process.stdout.write(process.cwd()); require(\\"fs\\").mkdirSync(\\"out\\", { recursive: true }); require(\\"fs\\").writeFileSync(\\"out/result.json\\", \\"{}\\")"]',
				'    artifacts: [{ path: "out/*.json", required: true, min_bytes: 1, freshness: current }]',
				"",
			].join("\n"),
		);
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Output, kind: artifact, artifact_recipe: producer }`),
		);
		await gitBacked(dir);
		// The recipe executes at the REPO root (recipe cwd semantics unchanged).
		const recipe = await runRecipe({ projectRoot: dir, recipeName: "producer", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(recipe.ok, true, recipe.error ?? "");
		assert.equal(recipe.record?.cwd, dir, "recipe cwd stays at the repository root");
		const manifest = (await readRunFile(recipe.runDir!, "manifest.json")) as Record<string, unknown>;
		assert.equal(manifest.cwd, dir);

		// The artifact check reads the run record at the repo root and passes.
		const gate = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(gate.gates[0]!.status, "PASS", gate.gates[0]!.checks[0]!.failure_reason ?? gate.gates[0]!.failure_reason ?? "");
	});
});

// ---------------------------------------------------------------------------
// P8: the built-in workbench-config existence check (b0.4) stays
// repository-root anchored via INTERNAL catalog metadata — a nested
// effective root must never relocate or impersonate it, and a project
// gates.yaml can never request repository-root anchoring (root/file_root
// are rejected by the strict schema)
// ---------------------------------------------------------------------------

test("built-in b0.4 checks the repository-root workbench config for nested projects", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research"), { recursive: true });
		// Repository root: the workbench config written by /q-init (project.yaml
		// declares the nested effective root; recipes.yaml + empty gates.yaml
		// keep the built-in catalog).
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(dir, "recipes.yaml", "recipes: []\n");
		await writeConfigFile(dir, "gates.yaml", "gates: []\n");
		// Effective root only: manifest + dependency files (the b0.2/b0.3
		// targets) — and NO .pi/workbench under the nested directory.
		await writeFile(join(dir, "research", "package.json"), "{}", "utf8");
		await writeFile(join(dir, "research", "package-lock.json"), "{}", "utf8");

		const result = await runGates({ projectRoot: dir, selector: "b0", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.id, "b0");
		const byId = new Map(result.gates[0]!.checks.map((c) => [c.check_id, c]));
		assert.equal(byId.get("b0.1")!.status, "PASS", byId.get("b0.1")!.failure_reason ?? "");
		assert.equal(byId.get("b0.2")!.status, "PASS", "manifest is found at the effective root");
		assert.equal(byId.get("b0.3")!.status, "PASS", "dependency files are found at the effective root");
		assert.equal(
			byId.get("b0.4")!.status,
			"PASS",
			"workbench config is found at the repository root even though the nested root has no .pi/workbench",
		);
		assert.equal(result.gates[0]!.status, "PASS", result.gates[0]!.failure_reason ?? "");
		assert.equal(result.ok, true);
	});
});

test("a nested .pi/workbench cannot satisfy the built-in b0.4 repository-root check", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research", ".pi", "workbench"), { recursive: true });
		// Repository root: NO workbench config at all (no .pi/workbench). The
		// nested directory carries the complete config it would need if it
		// were the project root — project.yaml + recipes.yaml + gates.yaml
		// (impersonation attempt).
		await writeFile(join(dir, "research", ".pi", "workbench", "project.yaml"), "name: nested\nprofile: generic\n", "utf8");
		await writeFile(join(dir, "research", ".pi", "workbench", "recipes.yaml"), "recipes: []\n", "utf8");
		await writeFile(join(dir, "research", ".pi", "workbench", "gates.yaml"), "gates: []\n", "utf8");

		// Nested-only config must NOT satisfy the repository-root anchored b0.4.
		const result = await runGates({ projectRoot: dir, selector: "b0", mode: "DEV", exec: spawnExec });
		const byId = new Map(result.gates[0]!.checks.map((c) => [c.check_id, c]));
		assert.equal(byId.get("b0.4")!.status, "FAIL", "a nested .pi/workbench must never satisfy b0.4");
		assert.ok(byId.get("b0.4")!.failure_reason?.includes("no file matched"), byId.get("b0.4")!.failure_reason ?? "");
		assert.equal(result.gates[0]!.status, "FAIL");

		// Control: once the repository root itself carries the workbench config
		// (project.yaml + recipes.yaml written by /q-init; project_dir keeps the
		// effective root nested) the same check passes — the repository root is
		// the only source, even with the nested .pi/workbench still present.
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(dir, "recipes.yaml", "recipes: []\n");
		await writeConfigFile(dir, "gates.yaml", "gates: []\n");
		await writeFile(join(dir, "research", "package.json"), "{}", "utf8");
		await writeFile(join(dir, "research", "package-lock.json"), "{}", "utf8");
		const again = await runGates({ projectRoot: dir, selector: "b0", mode: "DEV", exec: spawnExec });
		const againById = new Map(again.gates[0]!.checks.map((c) => [c.check_id, c]));
		assert.equal(againById.get("b0.1")!.status, "PASS", againById.get("b0.1")!.failure_reason ?? "");
		assert.equal(againById.get("b0.2")!.status, "PASS", againById.get("b0.2")!.failure_reason ?? "");
		assert.equal(againById.get("b0.3")!.status, "PASS", againById.get("b0.3")!.failure_reason ?? "");
		assert.equal(againById.get("b0.4")!.status, "PASS", againById.get("b0.4")!.failure_reason ?? "");
		assert.equal(again.gates[0]!.status, "PASS", again.gates[0]!.failure_reason ?? "");
		assert.equal(again.ok, true);
	});
});

test("file checks without root metadata keep resolving against the effective root", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "research", ".pi", "workbench"), { recursive: true });
		await writeConfigFile(dir, "project.yaml", "name: test-project\nprofile: generic\nproject_dir: research\n");
		await writeConfigFile(
			dir,
			"gates.yaml",
			gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: WB config, kind: file, path: .pi/workbench/recipes.yaml }`),
		);
		// The file exists ONLY under the nested effective root — the default
		// (effective-root) anchoring still finds it; only the built-in b0.4
		// internal repository-root metadata would ignore it.
		await writeFile(join(dir, "research", ".pi", "workbench", "recipes.yaml"), "recipes: []\n", "utf8");
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(result.gates[0]!.status, "PASS", result.gates[0]!.failure_reason ?? "");
	});
});

test("gates.yaml cannot set root or file_root (strict schema, internal metadata only)", async () => {
	// `root` is no longer a public gate-check field: rejected for any kind,
	// including kind=file with the previously-valid "repository" value.
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: C, kind: file, root: repository, path: package.json }`),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes('unknown field "root"'),
		);
	});
	// Even the no-op "effective" value is rejected — the schema has no root option.
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: C, kind: file, root: effective, path: x }`),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes('unknown field "root"'),
		);
	});
	// Non-file kinds reject it too (previously "root is only valid for kind=file").
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: C, kind: json, file: x.json, path: a, root: repository }`),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes('unknown field "root"'),
		);
	});
	// The internal metadata name file_root is equally rejected from YAML.
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: C, kind: file, file_root: repository, path: package.json }`),
		});
		await assert.rejects(
			runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec }),
			(error) => error instanceof GateSetupError && error.message.includes('unknown field "file_root"'),
		);
	});
});

test("built-in b0.4 is the only catalog check with internal repository-root metadata", async () => {
	const b0 = BASE_GATES.find((g) => g.id === "b0");
	assert.ok(b0, "base gate b0 exists");
	const b04 = b0!.checks.find((c) => c.id === "b0.4");
	assert.ok(b04, "built-in b0.4 exists");
	assert.equal(b04!.file_root, "repository", "b0.4 carries the internal file_root: repository metadata");
	for (const c of b0!.checks) {
		if (c.id !== "b0.4") {
			assert.equal(c.file_root, undefined, `built-in ${c.id} must not carry file_root`);
		}
	}
	// The engine helper maps the internal metadata to the repository root and
	// everything else to the effective root.
	const ctx = { projectRoot: "/repo", effectiveProjectRoot: "/repo/research" } as unknown as CheckContext;
	assert.equal(fileCheckRoot(ctx, b04 as GateCheck), "/repo", "file_root: repository selects the repository root");
	const plain: GateCheck = { ...(b04 as GateCheck), file_root: undefined };
	assert.equal(fileCheckRoot(ctx, plain), "/repo/research", "default file checks select the effective root");
});

// ---------------------------------------------------------------------------
// P4a: gate validation-evidence wiring
// ---------------------------------------------------------------------------

const WORKER_FACTS = { role: "worker", provider: "deepseek", model: "deepseek-v4-flash" };

/** Git-init the temp project (the .pi config dir stays ignored). */
async function gitBacked(dir: string): Promise<void> {
	await writeFile(join(dir, ".gitignore"), ".pi/\n", "utf8");
	await spawnExec("git", ["init", "-q"], { cwd: dir });
	await spawnExec("git", ["config", "user.email", "t@t"], { cwd: dir });
	await spawnExec("git", ["config", "user.name", "t"], { cwd: dir });
	await spawnExec("git", ["add", "-A"], { cwd: dir });
	await spawnExec("git", ["commit", "-qm", "init"], { cwd: dir });
}

test("P4a: PASS and non-PASS gate runs persist valid bindings with exact Sol owner/outcome/gate target", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Audit, kind: manual, prompt: "audit" }`,
			),
		});
		await gitBacked(dir);

		const pass = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "g1.1": "audit ok" },
			actorFacts: SOL_FACTS,
		});
		assert.equal(pass.ok, true);
		const passManifest = (await readRunFile(pass.runDir, "manifest.json")) as { validation_evidence: ValidationEvidenceBlock };
		const passBlock = passManifest.validation_evidence;
		assert.ok(passBlock?.binding, "a PASS run persists a binding");
		assert.equal(passBlock.binding.owner, "sol");
		assert.deepEqual(passBlock.binding.outcome, { successful: true, complete: true, source: "gate" });
		assert.equal(passBlock.binding.kind, "gate");
		if (passBlock.binding.target.kind === "gate") {
			assert.equal(passBlock.binding.target.selector, "g1");
			assert.deepEqual(passBlock.binding.target.requested_gates, ["g1"]);
			assert.deepEqual(passBlock.binding.target.effective_gates, ["g1"]);
		}
		assert.ok(passBlock.binding.commit, "git HEAD bound");
		assert.match(passBlock.binding.diff_hash, /^[0-9a-f]{64}$/);

		// Non-PASS: the required manual check is NOT_RUN without evidence.
		const notPass = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec, actorFacts: SOL_FACTS });
		assert.equal(notPass.ok, false);
		const notPassManifest = (await readRunFile(notPass.runDir, "manifest.json")) as { validation_evidence: ValidationEvidenceBlock };
		assert.ok(notPassManifest.validation_evidence?.binding, "a non-PASS run persists a binding");
		assert.deepEqual(notPassManifest.validation_evidence.binding.outcome, { successful: false, complete: true, source: "gate" });
		assert.equal(notPassManifest.validation_evidence.binding.owner, "sol");
	});
});

test("P4a: worker and unknown owners are persisted exactly", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, { gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`) });
		await gitBacked(dir);
		const worker = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec, actorFacts: WORKER_FACTS });
		const workerManifest = (await readRunFile(worker.runDir, "manifest.json")) as { validation_evidence: ValidationEvidenceBlock };
		const workerBinding = workerManifest.validation_evidence.binding;
		assert.ok(workerBinding, "worker run persists a binding");
		assert.equal(workerBinding.owner, "worker");

		const unknown = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		const unknownManifest = (await readRunFile(unknown.runDir, "manifest.json")) as { validation_evidence: ValidationEvidenceBlock };
		const unknownBinding = unknownManifest.validation_evidence.binding;
		assert.ok(unknownBinding, "fact-less run persists a binding");
		assert.equal(unknownBinding.owner, "unknown");
	});
});

test("P4a: gate validation_evidence carries no manual text, raw worker facts, or prerequisite run ids", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`,
					`  - id: g2\n    title: G2\n    prerequisites: [g1]\n    checks:\n      - { id: g2.1, title: Audit, kind: manual, prompt: "audit" }\n      - { id: g2.2, title: WF, kind: worker-first, worker_first: strict-policy-active }`,
				].join("\n"),
			),
		});
		await gitBacked(dir);
		// Persist an older g1 PASS; selecting g2 must nevertheless rerun g1 in
		// the same transaction instead of inheriting this source.
		const first = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(first.gates[0]!.status, "PASS");
		const runId = first.runId;

		const manualText = "super-secret-manual-note-text";
		const blockedText = "super-secret-blocked-reason";
		const delegationId = "20260101-120000-zzzz";
		const result = await runGates({
			projectRoot: dir,
			selector: "g2",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "g2.1": manualText },
			workerFirstFacts: cleanWorkerFirstFacts({
				blockedReason: blockedText,
				hasDelegation: true,
				latestDelegationId: delegationId,
				reviewStatus: "REVIEWED",
				currentDiffHash: "a".repeat(64),
				reviewedDiffHash: "a".repeat(64),
				reviewVerdict: "PASS",
				reviewViolationCount: 0,
				leaseStatus: "active",
				leaseReason: "user-directed",
			}),
			actorFacts: SOL_FACTS,
		});
		assert.equal(result.gates[1]!.prerequisite_status["g1"]!.source, "this-run");
		const manifest = (await readRunFile(result.runDir, "manifest.json")) as { validation_evidence: ValidationEvidenceBlock };
		const evidenceJson = JSON.stringify(manifest.validation_evidence);
		assert.ok(!evidenceJson.includes(manualText), "manual evidence text never persists in the block");
		assert.ok(!evidenceJson.includes(blockedText), "raw worker-first facts never persist in the block");
		assert.ok(!evidenceJson.includes(delegationId), "raw delegation ids never persist in the block");
		assert.ok(!evidenceJson.includes(runId), "older prerequisite run ids never persist in the block");
		assert.ok(!evidenceJson.includes("run:"), "sources never persist in the block");
	});
});

test("P4a: collection unavailable leaves the gate status/result unchanged and persists unavailable evidence", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, { gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`) });
		const failingGit: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args[0] === "status") return { stdout: "", stderr: "fatal", code: 128, killed: false };
			return { stdout: "", stderr: "", code: 0, killed: false };
		};
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: failingGit, actorFacts: SOL_FACTS });
		assert.equal(result.status, "PASS", "the gate verdict is unchanged by a capture failure");
		assert.equal(result.ok, true);
		const manifest = (await readRunFile(result.runDir, "manifest.json")) as { validation_evidence: ValidationEvidenceBlock };
		assert.equal(manifest.validation_evidence.binding, null);
		assert.ok(manifest.validation_evidence.unavailable_reason?.includes("capture failed"), manifest.validation_evidence.unavailable_reason ?? "");
	});
});

test("P4a: current manifests without validation_evidence stay readable (additive optional field)", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, { gatesYaml: gatesYaml(`  - id: g1\n    title: G1\n    checks:\n${CONFIG_CHECK}`) });
		const result = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		// Strip only the additive P4a field; the current v2 identity remains.
		const manifestPath = join(result.runDir, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
		delete manifest.validation_evidence;
		await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
		const read = await readManifest(dir, result.runId);
		assert.equal(read?.schema_version, 2, "the current run manifest stays schema v2");
		assert.equal(read?.run_id, result.runId);
		assert.equal(read.validation_evidence, undefined, "the field is optional — legacy records parse");

		const fresh = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		const freshRead = await readManifest(dir, fresh.runId);
		assert.ok(freshRead?.validation_evidence, "new runs persist the additive field");
	});
});

// ---------------------------------------------------------------------------
// Phase 3A: pure/read-only manual-evidence preflight
// ---------------------------------------------------------------------------

test("preflight reports required manual checks in deterministic effective order with exact provided flags", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g2\n    title: G2\n    checks:\n      - { id: g2.1, title: Audit A, kind: manual, prompt: "audit a" }\n      - { id: g2.2, title: Optional audit, kind: manual, required: false, prompt: "optional audit" }\n      - { id: g2.3, title: Config, kind: config }`,
					`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Audit B, kind: manual, prompt: "audit b" }`,
					`  - id: g3\n    title: G3\n    checks:\n      - { id: g3.1, title: Optional only, kind: manual, required: false }`,
				].join("\n"),
			),
		});

		const result = await preflightGateManualEvidence({
			projectRoot: dir,
			selector: "g1,g2",
			manualEvidence: {
				"g2.1": "  performed  ", // provided after trim
				"g1.1": "   \n\t ", // whitespace-only → missing
				"g2.3": "not a manual check", // key of a non-manual check → ignored
				ghost: "anything", // unknown check id → ignored
			},
		});
		assert.equal(result.selector, "g1,g2");
		assert.deepEqual(result.requested, ["g1", "g2"]);
		assert.equal(result.profile, "generic");
		// Deterministic effective order: gates by id, checks in declaration order;
		// optional manual checks (g2.2) and non-manual checks (g2.3) excluded.
		assert.deepEqual(result.required_manual_checks, [
			{ gate_id: "g1", check_id: "g1.1", prompt: "audit b", provided: false },
			{ gate_id: "g2", check_id: "g2.1", prompt: "audit a", provided: true },
		]);
		assert.deepEqual(result.provided_required_ids, ["g2.1"]);
		assert.deepEqual(result.missing_required_ids, ["g1.1"]);
		assert.equal(result.manual_evidence_ready, false);
		// Machine facts only: raw notes are never returned, and no gate status
		// or run identity can ever appear.
		const serialized = JSON.stringify(result);
		assert.ok(!serialized.includes("performed"), "raw evidence notes must never be returned");
		assert.ok(!serialized.includes("anything"), "unknown-key notes must never be returned");
		for (const status of ["PASS", "FAIL", "BLOCKED", "NOT_RUN"] as const) {
			assert.ok(!serialized.includes(status), `preflight must never return gate status ${status}`);
		}
		assert.ok(!serialized.includes("run_id") && !serialized.includes("runId"), "preflight must never carry a run id");

		// All required provided → ready.
		const ready = await preflightGateManualEvidence({
			projectRoot: dir,
			selector: "g1,g2",
			manualEvidence: { "g1.1": "ok", "g2.1": "ok" },
		});
		assert.equal(ready.manual_evidence_ready, true);
		assert.deepEqual(ready.provided_required_ids, ["g1.1", "g2.1"]);
		assert.deepEqual(ready.missing_required_ids, []);

		// Optional-only selector is ready with no evidence at all.
		const optionalOnly = await preflightGateManualEvidence({ projectRoot: dir, selector: "g3" });
		assert.deepEqual(optionalOnly.required_manual_checks, []);
		assert.deepEqual(optionalOnly.missing_required_ids, []);
		assert.equal(optionalOnly.manual_evidence_ready, true, "optional manual checks never make readiness false");
	});
});

test("preflight includes required manual evidence from the full prerequisite closure", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Prerequisite audit, kind: manual, prompt: "audit prerequisite" }`,
					`  - id: g2\n    title: G2\n    prerequisites: [g1]\n    checks:\n${CONFIG_CHECK}`,
				].join("\n"),
			),
		});

		const missing = await preflightGateManualEvidence({ projectRoot: dir, selector: "g2" });
		assert.deepEqual(missing.requested, ["g2"], "requested remains the selector expansion, not the closure");
		assert.deepEqual(missing.required_manual_checks, [
			{ gate_id: "g1", check_id: "g1.1", prompt: "audit prerequisite", provided: false },
		]);
		assert.deepEqual(missing.missing_required_ids, ["g1.1"]);
		assert.equal(missing.manual_evidence_ready, false);

		const ready = await preflightGateManualEvidence({
			projectRoot: dir,
			selector: "g2",
			manualEvidence: { "g1.1": "confirmed by user" },
		});
		assert.deepEqual(ready.provided_required_ids, ["g1.1"]);
		assert.equal(ready.manual_evidence_ready, true);
	});
});

test("preflight is pure read-only: no run directory/record/log/artifact is created and nothing ever executes", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			recipesYaml: [
				"recipes:",
				"  - name: check:lint",
				'    command: ["node", "-e", "require(\\"fs\\").writeFileSync(\\"marker.txt\\", \\"ran\\")"]',
				"",
			].join("\n"),
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Audit, kind: manual, prompt: "audit" }`,
					`  - id: g2\n    title: G2\n    checks:\n      - { id: g2.1, title: Lint, kind: recipe, recipe: check:lint }`,
				].join("\n"),
			),
		});
		const workbenchDir = join(dir, ".pi", "workbench");
		const before = (await readdir(workbenchDir)).sort();
		assert.deepEqual(before, ["gates.yaml", "project.yaml", "recipes.yaml"]);

		// preflightGateManualEvidence has NO exec parameter — nothing can be
		// injected or called. The recipe check below would run `node` and write
		// marker.txt in a formal run; the preflight must never reach it.
		const result = await preflightGateManualEvidence({
			projectRoot: dir,
			selector: "g1,g2",
			manualEvidence: { "g1.1": "audit performed" },
		});
		assert.deepEqual(result.requested, ["g1", "g2"]);
		assert.deepEqual(result.missing_required_ids, []);
		assert.equal(result.manual_evidence_ready, true);

		// No file or directory was created anywhere under .pi/workbench.
		const after = (await readdir(workbenchDir)).sort();
		assert.deepEqual(after, before, "preflight must not create any file or directory");
		// No run record/log/artifact exists — the runs directory itself is absent.
		const runsDirPath = join(workbenchDir, "runs");
		for (const file of ["manifest.json", "gates.json", "evidence.json", "summary.json", "stdout.log", "stderr.log"]) {
			await assert.rejects(readFile(join(runsDirPath, file), "utf8"), { code: "ENOENT" });
		}
		// The recipe check never executed.
		await assert.rejects(readFile(join(dir, "marker.txt"), "utf8"), { code: "ENOENT" });
	});
});

test("preflight fails closed exactly like runGates for unknown/empty/profile-invalid/cyclic selectors", async () => {
	const expectSameSetupError = async (dir: string, selector: string): Promise<void> => {
		let formalError: unknown;
		let preflightError: unknown;
		try {
			await runGates({ projectRoot: dir, selector, mode: "DEV", exec: spawnExec });
		} catch (error) {
			formalError = error;
		}
		try {
			await preflightGateManualEvidence({ projectRoot: dir, selector });
		} catch (error) {
			preflightError = error;
		}
		assert.ok(formalError instanceof GateSetupError, `runGates must reject selector "${selector}" with GateSetupError`);
		assert.ok(preflightError instanceof GateSetupError, `preflight must reject selector "${selector}" with GateSetupError`);
		assert.equal(
			(preflightError as Error).message,
			(formalError as Error).message,
			`selector "${selector}": preflight and runGates must fail identically`,
		);
	};

	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "generic" });
		await expectSameSetupError(dir, "nope"); // unknown id → matched no gates
		await expectSameSetupError(dir, ""); // empty selector → matched no gates
		await expectSameSetupError(dir, "   "); // blank selector → matched no gates
		await expectSameSetupError(dir, "q0"); // quant gate not available for generic
	});

	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				[
					`  - id: g1\n    title: G1\n    prerequisites: [g2]\n    checks:\n${CONFIG_CHECK}`,
					`  - id: g2\n    title: G2\n    prerequisites: [g1]\n    checks:\n${CONFIG_CHECK}`,
				].join("\n"),
			),
		});
		await expectSameSetupError(dir, "g1,g2"); // prerequisite cycle
	});

	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: X, kind: made-up-kind }`,
			),
		});
		await expectSameSetupError(dir, "g1"); // invalid gates.yaml
	});
});

test("preflight returns the resolved profile and selector-expanded requested ids", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "generic" });
		const base = await preflightGateManualEvidence({ projectRoot: dir, selector: "all" });
		assert.equal(base.profile, "generic");
		assert.deepEqual(base.requested, ["b0", "b1", "b2", "b3", "b4", "b5", "b6"]);
		const subset = await preflightGateManualEvidence({ projectRoot: dir, selector: "b2,b0" });
		assert.deepEqual(subset.requested, ["b2", "b0"], "explicit ids keep selector order");
	});

	await withTempDir(async (dir) => {
		await setupProject(dir, { profile: "quant-research/stock-selection" });
		const quant = await preflightGateManualEvidence({ projectRoot: dir, selector: "quant" });
		assert.equal(quant.profile, "quant-research/stock-selection");
		assert.deepEqual(quant.requested, ["q0", "q1", "q2", "q3", "q4", "q5"]);
	});
});

test("formal runs after preflight keep NOT_RUN/PASS and type-manual persistence semantics unchanged", async () => {
	await withTempDir(async (dir) => {
		await setupProject(dir, {
			gatesYaml: gatesYaml(
				`  - id: g1\n    title: G1\n    checks:\n      - { id: g1.1, title: Audit, kind: manual, prompt: "audit" }`,
			),
		});
		// Read-only preflight first — it must not influence the formal run.
		const pre = await preflightGateManualEvidence({ projectRoot: dir, selector: "g1" });
		assert.equal(pre.manual_evidence_ready, false);
		assert.deepEqual(pre.missing_required_ids, ["g1.1"]);

		// A subsequent formal run WITHOUT evidence still evaluates NOT_RUN.
		const withoutEvidence = await runGates({ projectRoot: dir, selector: "g1", mode: "DEV", exec: spawnExec });
		assert.equal(withoutEvidence.gates[0]!.status, "NOT_RUN");
		assert.equal(withoutEvidence.gates[0]!.checks[0]!.status, "NOT_RUN");
		assert.equal(withoutEvidence.ok, false);

		// Supplied evidence still persists type "manual" and PASSes.
		const withEvidence = await runGates({
			projectRoot: dir,
			selector: "g1",
			mode: "DEV",
			exec: spawnExec,
			manualEvidence: { "g1.1": "  audit performed  " },
		});
		assert.equal(withEvidence.gates[0]!.status, "PASS");
		assert.equal(withEvidence.ok, true);
		const evidenceJson = (await readRunFile(withEvidence.runDir, "evidence.json")) as {
			checks: Record<string, { evidence: { type: string; provided_by: string; detail: string }[] }>;
		};
		const evidence = evidenceJson.checks["g1.1"]!.evidence;
		assert.equal(evidence[0]!.type, "manual");
		assert.equal(evidence[0]!.provided_by, "user-command");
		assert.equal(evidence[0]!.detail, "audit performed", "the persisted note is the trimmed note");

		// Even with persisted runs present, the preflight still reads no latest
		// status and never reports run records.
		const afterFormal = await preflightGateManualEvidence({ projectRoot: dir, selector: "g1", manualEvidence: { "g1.1": "x" } });
		assert.deepEqual(afterFormal.requested, ["g1"]);
		assert.deepEqual(afterFormal.missing_required_ids, []);
		assert.ok(!JSON.stringify(afterFormal).includes(withoutEvidence.runId), "preflight never reads or reports run records");
	});
});
