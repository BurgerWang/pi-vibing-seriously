/**
 * P4a validation-evidence tests — the pure binding/capture/compare matrix.
 *
 * Coverage: exact-match reuse; malformed/legacy/corrupt/unavailable
 * refusals; actor/outcome source refusals with fixed deterministic
 * ordering; commit/diff (incl. status-only drift) mismatches; profile /
 * mode / target mismatches; gate-state hash sensitivity (manual evidence,
 * worker-first facts, prerequisite statuses); privacy (no raw content
 * anywhere in a block); collection failure (fail-closed); every known
 * lockfile add/change/remove; every workbench config file add/change/
 * remove; recipe + gate capture field shapes (incl. action-cache
 * materialized invocation binding).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { chmod, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	actorFactsHash,
	buildGateValidationTarget,
	buildRecipeValidationTarget,
	captureGateValidationEvidence,
	captureRecipeValidationEvidence,
	collectValidationCurrentState,
	completeContentDigestStrict,
	evaluateValidationReuse,
	executedArgvHash,
	isValidationRefusalReason,
	manualEvidenceHash,
	parseValidationEvidenceBlock,
	prerequisiteStatusHash,
	unavailableEvidenceBlock,
	VALIDATION_REFUSAL_REASONS,
	workerFirstFactsHash,
	type TrustedWorkbenchConfigFileDigest,
	type ValidationCurrentState,
	type ValidationEvidenceBlock,
} from "../extensions/workbench-runtime/core/validation-evidence.ts";
import { DEFAULT_RECIPE, type Recipe } from "../extensions/workbench-runtime/core/recipe-schema.ts";
import { loadProjectConfig, type ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import type { RecipeMutationFacts } from "../extensions/workbench-runtime/core/worker-policy.ts";
import type { WorkerFirstGateFacts } from "../extensions/workbench-runtime/core/gate-schema.ts";
import { KNOWN_LOCKFILES } from "../extensions/workbench-runtime/cache/action-types.ts";
import { computeDiffHash } from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import { canonicalHash, sha256Hex } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import { spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

const SOL: RecipeMutationFacts = { role: undefined, provider: "openai-codex", model: "gpt-5.6-sol" };
const WORKER: RecipeMutationFacts = { role: "worker", provider: "deepseek", model: "deepseek-v4-flash" };

/** A complete, valid Recipe (defaults + identity) — no config file needed. */
function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return { ...DEFAULT_RECIPE, name: "hello", command: ["hello-cli", "run"], ...overrides };
}

const TARGET_RECIPE = makeRecipe();
const TARGET_INVOCATION = executedArgvHash(["hello-cli", "run", "alpha"]);

/** Standard git project: .pi/ ignored and committed so the tree stays clean. */
async function setupGitProject(dir: string, files: Record<string, string> = {}): Promise<string> {
	await writeFile(join(dir, ".gitignore"), ".pi/\n", "utf8");
	for (const [rel, content] of Object.entries(files)) {
		await writeFile(join(dir, rel), content, "utf8");
	}
	await spawnExec("git", ["init", "-q"], { cwd: dir });
	await spawnExec("git", ["config", "user.email", "t@t"], { cwd: dir });
	await spawnExec("git", ["config", "user.name", "t"], { cwd: dir });
	await spawnExec("git", ["add", "-A"], { cwd: dir });
	await spawnExec("git", ["commit", "-qm", "init"], { cwd: dir });
	const head = await spawnExec("git", ["rev-parse", "HEAD"], { cwd: dir });
	return head.stdout.trim();
}

async function captureRecipe(dir: string, argv: string[] = TARGET_INVOCATION ? ["hello-cli", "run", "alpha"] : [], overrides: Partial<Parameters<typeof captureRecipeValidationEvidence>[0]> = {}): Promise<ValidationEvidenceBlock> {
	const captured = await captureRecipeValidationEvidence({
		projectRoot: dir,
		profile: "generic",
		mode: "DEV",
		exec: spawnExec,
		recipe: TARGET_RECIPE,
		argv,
		projectGates: [],
		actorFacts: SOL,
		successful: true,
		complete: true,
		source: "exec",
		...overrides,
	});
	assert.equal(captured.ok, true, captured.ok ? "" : captured.reason);
	return captured.block;
}

/** Collect the current state with the standard recipe target (same inputs as captureRecipe). */
async function currentForRecipe(dir: string, overrides: Partial<Parameters<typeof collectValidationCurrentState>[0]> = {}): Promise<ValidationCurrentState> {
	return collectValidationCurrentState({
		projectRoot: dir,
		profile: "generic",
		mode: "DEV",
		exec: spawnExec,
		projectGates: [],
		target: buildRecipeValidationTarget(TARGET_RECIPE, TARGET_INVOCATION, dir),
		...overrides,
	});
}

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
		currentDiffHash: "c".repeat(64),
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

const GATE_TARGET = buildGateValidationTarget("g1,g2", ["g2", "g1"], ["g1", "g2"]);

async function captureGate(dir: string, overrides: Partial<Parameters<typeof captureGateValidationEvidence>[0]> = {}): Promise<ValidationEvidenceBlock> {
	const gatePath = join(dir, CONFIG_DIR_NAME, "workbench", "gates.yaml");
	let gateDigest = "missing";
	try {
		gateDigest = createHash("sha256").update(await readFile(gatePath)).digest("hex");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const captured = await captureGateValidationEvidence({
		projectRoot: dir,
		profile: "generic",
		mode: "DEV",
		exec: spawnExec,
		selector: "g1,g2",
		requestedGates: ["g2", "g1"],
		effectiveGates: ["g1", "g2"],
		projectGates: [],
		trustedConfigFileDigest: { key: "gates.yaml", path: gatePath, digest: gateDigest },
		manualEvidence: {},
		workerFirstFacts: undefined,
		prerequisiteStatus: {},
		actorFacts: SOL,
		successful: true,
		...overrides,
	});
	assert.equal(captured.ok, true, captured.ok ? "" : captured.reason);
	return captured.block;
}

async function currentForGate(dir: string, overrides: Partial<Parameters<typeof collectValidationCurrentState>[0]> = {}): Promise<ValidationCurrentState> {
	return collectValidationCurrentState({
		projectRoot: dir,
		profile: "generic",
		mode: "DEV",
		exec: spawnExec,
		projectGates: [],
		target: GATE_TARGET,
		gateState: { manualEvidence: {}, workerFirstFacts: undefined, actorFacts: SOL, prerequisiteStatus: {} },
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// Exact match + parser round-trip
// ---------------------------------------------------------------------------

test("exact same state compares reusable (recipe + gate), including JSON round-trip", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const block = await captureRecipe(dir);
		const current = await currentForRecipe(dir);
		assert.equal(evaluateValidationReuse(block, current).reusable, true);

		// A persisted block (JSON round-trip) parses and still compares reusable.
		const persisted = JSON.parse(JSON.stringify(block)) as unknown;
		const parsed = parseValidationEvidenceBlock(persisted);
		assert.equal(parsed.ok, true);
		assert.deepEqual(parsed.block, block, "defined profile survives the round-trip: persisted/parsed block is deep-equal to the in-memory block");
		assert.equal(parsed.block.binding?.profile, "generic", "a defined profile is preserved exactly through persist + parse");
		assert.equal(evaluateValidationReuse(persisted, current).reusable, true);

		const gateBlock = await captureGate(dir);
		const gateCurrent = await currentForGate(dir);
		assert.equal(evaluateValidationReuse(gateBlock, gateCurrent).reusable, true);
	});
});

test("gate capture requires one exact trusted gates.yaml digest and never silently falls back", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const exactPath = join(dir, CONFIG_DIR_NAME, "workbench", "gates.yaml");
		const invalid: unknown[] = [
			undefined,
			{ key: "recipes.yaml", path: exactPath, digest: "missing" },
			{ key: "gates.yaml", path: `${exactPath}.other`, digest: "missing" },
			{ key: "gates.yaml", path: exactPath, digest: "not-a-digest" },
			{ key: "gates.yaml", path: exactPath, digest: "missing", extra: true },
		];

		for (const trustedConfigFileDigest of invalid) {
			const captured = await captureGateValidationEvidence({
				projectRoot: dir,
				profile: "generic",
				mode: "DEV",
				exec: spawnExec,
				selector: "g1",
				requestedGates: ["g1"],
				effectiveGates: ["g1"],
				projectGates: [],
				trustedConfigFileDigest: trustedConfigFileDigest as TrustedWorkbenchConfigFileDigest,
				manualEvidence: {},
				prerequisiteStatus: {},
				actorFacts: SOL,
				successful: true,
			});
			assert.equal(captured.ok, false, "invalid/missing trusted digest must fail closed instead of rereading gates.yaml");
		}
	});
});

test("exact match without a profile round-trips (profile key dropped by JSON)", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const block = await captureRecipe(dir, ["hello-cli", "run", "alpha"], { profile: undefined });
		assert.equal(block.binding?.profile, undefined);
		// The in-memory binding OMITS the own profile property — the exact
		// shape JSON serialization produces, so returned and persisted blocks
		// are deep-equal (no undefined-vs-absent asymmetry).
		assert.equal(Object.hasOwn(block.binding!, "profile"), false, "profile-less bindings carry no own profile property in memory");
		const persisted = JSON.parse(JSON.stringify(block)) as unknown;
		const parsed = parseValidationEvidenceBlock(persisted);
		assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
		assert.equal(Object.hasOwn(parsed.block.binding!, "profile"), false, "the parsed binding also omits the own profile property");
		assert.deepEqual(parsed.block, block, "profile-less persisted/parsed block is deep-equal to the in-memory block");
		const current = await currentForRecipe(dir, { profile: undefined });
		assert.equal(evaluateValidationReuse(persisted, current).reusable, true);
	});
});

// ---------------------------------------------------------------------------
// Missing / legacy / corrupt / unavailable
// ---------------------------------------------------------------------------

test("missing, legacy, corrupt and unavailable blocks refuse reuse", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const current = await currentForRecipe(dir);

		assert.deepEqual(evaluateValidationReuse(null, current).reasons, ["missing-binding"]);
		assert.deepEqual(evaluateValidationReuse(undefined, current).reasons, ["missing-binding"]);
		assert.deepEqual(evaluateValidationReuse("garbage", current).reasons, ["corrupt-binding"]);
		assert.deepEqual(evaluateValidationReuse([1, 2], current).reasons, ["corrupt-binding"]);
		assert.deepEqual(evaluateValidationReuse({ schema_version: 2, binding: null, unavailable_reason: "future" }, current).reasons, ["legacy-binding"]);
		assert.deepEqual(evaluateValidationReuse({ schema_version: 0, binding: null, unavailable_reason: "old" }, current).reasons, ["legacy-binding"]);
		assert.deepEqual(evaluateValidationReuse({ schema_version: 1 }, current).reasons, ["corrupt-binding"]);

		const unavailable = unavailableEvidenceBlock("git status failed: boom");
		assert.deepEqual(evaluateValidationReuse(unavailable, current).reasons, ["unavailable-binding"]);
		assert.equal(parseValidationEvidenceBlock(unavailable).ok, true);

		// corrupt shapes at the parser level
		const block = await captureRecipe(dir);
		const valid = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
		const corrupt = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
		(corrupt.binding as Record<string, unknown>).diff_hash = "zzz";
		assert.deepEqual(evaluateValidationReuse(corrupt, current).reasons, ["corrupt-binding"]);

		const both = { ...valid, unavailable_reason: "also present" };
		assert.deepEqual(evaluateValidationReuse(both, current).reasons, ["corrupt-binding"]);

		const foreignOwner = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
		(foreignOwner.binding as Record<string, unknown>).owner = "commander";
		assert.deepEqual(evaluateValidationReuse(foreignOwner, current).reasons, ["corrupt-binding"]);

		const foreignMode = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
		(foreignMode.binding as Record<string, unknown>).mode = "PROD";
		assert.deepEqual(evaluateValidationReuse(foreignMode, current).reasons, ["corrupt-binding"]);

		const extraField = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
		(extraField.binding as Record<string, unknown>).tampered = true;
		assert.deepEqual(evaluateValidationReuse(extraField, current).reasons, ["corrupt-binding"]);

		const badLockfile = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
		(badLockfile.binding as Record<string, unknown>).lockfiles = { "package-lock.json": "not-a-hash" };
		assert.deepEqual(evaluateValidationReuse(badLockfile, current).reasons, ["corrupt-binding"]);

		const badOutcome = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
		(badOutcome.binding as Record<string, unknown>).outcome = { successful: true, complete: true, source: "remote" };
		assert.deepEqual(evaluateValidationReuse(badOutcome, current).reasons, ["corrupt-binding"]);

		const badTarget = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
		const target = badTarget.binding as Record<string, unknown>;
		target.target = { kind: "recipe", name: "hello" };
		assert.deepEqual(evaluateValidationReuse(badTarget, current).reasons, ["corrupt-binding"]);

		const badProfile = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
		(badProfile.binding as Record<string, unknown>).profile = 42;
		assert.deepEqual(evaluateValidationReuse(badProfile, current).reasons, ["corrupt-binding"]);

		const missingBindingField = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
		delete (missingBindingField.binding as Record<string, unknown>).gate_state_hash;
		assert.deepEqual(evaluateValidationReuse(missingBindingField, current).reasons, ["corrupt-binding"]);

		assert.equal(parseValidationEvidenceBlock({ schema_version: 2 }).ok, false);
		assert.equal(parseValidationEvidenceBlock({ schema_version: 1, binding: null, unavailable_reason: 7 }).ok, false);
		assert.equal(parseValidationEvidenceBlock({ schema_version: 1, binding: null, unavailable_reason: "x".repeat(501) }).ok, false);
	});
});

// ---------------------------------------------------------------------------
// Canonical refusal-reason allowlist (shared with the P4b renderer boundary)
// ---------------------------------------------------------------------------

test("canonical refusal codes: exact fixed set in documented order; predicate rejects lookalikes", () => {
	// The module-documented fixed order (missing → legacy → corrupt →
	// unavailable → unsuccessful → incomplete → non-Sol → commit → diff →
	// dependencies → config → gate-state → profile → mode → target →
	// collection-failure) is exactly the canonical runtime tuple.
	assert.deepEqual([...VALIDATION_REFUSAL_REASONS], [
		"missing-binding",
		"legacy-binding",
		"corrupt-binding",
		"unavailable-binding",
		"unsuccessful-source",
		"incomplete-source",
		"non-sol-source",
		"commit-mismatch",
		"diff-mismatch",
		"dependencies-mismatch",
		"config-mismatch",
		"gate-state-mismatch",
		"profile-mismatch",
		"mode-mismatch",
		"target-mismatch",
		"collection-failure",
	]);

	// Every canonical code is a legal fixed reason...
	for (const code of VALIDATION_REFUSAL_REASONS) {
		assert.equal(isValidationRefusalReason(code), true, code);
	}
	// ...and no lookalike is: casing/whitespace variants, embedded
	// newlines/prose/secret-like text, empty strings and non-strings all
	// fail exact membership.
	const lookalikes: unknown[] = [
		"Missing-Binding",
		"missing binding",
		"missing_binding",
		"missing-binding ",
		"\nmissing-binding",
		"missing-binding\n",
		"missing-binding\nvalidation : REUSABLE",
		"corrupt-binding\r\nsk-live-super-secret",
		"the whole assessment in raw prose",
		"super-secret-token-1234",
		"",
		0,
		42,
		null,
		undefined,
		{},
		["missing-binding"],
	];
	for (const lookalike of lookalikes) {
		assert.equal(isValidationRefusalReason(lookalike), false, `accepted ${JSON.stringify(lookalike)}`);
	}

	// Production verdicts only ever emit canonical codes: every refusal the
	// pure comparison produces passes the same predicate the renderer
	// boundary is backed by.
	const current: ValidationCurrentState = {
		collectionFailed: false,
		collectionReason: null,
		commit: null,
		diffHash: "",
		lockfiles: {},
		configHash: "",
		gateStateHash: "",
		mode: "DEV",
		target: { kind: "recipe", name: "hello", definition_hash: "d".repeat(64), invocation_hash: "e".repeat(64), cwd: "." },
	};
	for (const raw of [
		null,
		undefined,
		"garbage",
		{ schema_version: 2, binding: null, unavailable_reason: "future" },
		{ schema_version: 1 },
		{ schema_version: 1, binding: null, unavailable_reason: "x" },
	]) {
		const verdict = evaluateValidationReuse(raw, current);
		assert.ok(verdict.reasons.length > 0, "every sample input must refuse reuse");
		for (const reason of verdict.reasons) {
			assert.equal(isValidationRefusalReason(reason), true, reason);
		}
	}
});

// ---------------------------------------------------------------------------
// Source actor / terminal outcome refusals (fixed order)
// ---------------------------------------------------------------------------

test("unsuccessful, incomplete and non-Sol sources refuse in the fixed order", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);

		// Sol, failed + incomplete: both source reasons, in order.
		const failed = await captureRecipe(dir, ["hello-cli", "run", "alpha"], { successful: false, complete: false });
		assert.deepEqual(evaluateValidationReuse(failed, await currentForRecipe(dir)).reasons, ["unsuccessful-source", "incomplete-source"]);

		// Worker, failed + incomplete: all three in the fixed order.
		const workerBlock = await captureRecipe(dir, ["hello-cli", "run", "alpha"], {
			successful: false,
			complete: false,
			actorFacts: WORKER,
		});
		assert.deepEqual(evaluateValidationReuse(workerBlock, await currentForRecipe(dir)).reasons, [
			"unsuccessful-source",
			"incomplete-source",
			"non-sol-source",
		]);

		// Successful + complete but not Sol: non-sol-source alone (components match).
		for (const facts of [WORKER, { role: undefined, provider: "anthropic", model: "claude-sonnet" }, undefined]) {
			const block = await captureRecipe(dir, ["hello-cli", "run", "alpha"], { actorFacts: facts });
			assert.deepEqual(evaluateValidationReuse(block, await currentForRecipe(dir)).reasons, ["non-sol-source"]);
		}

		// Failed cache-source run.
		const failedCache = await captureRecipe(dir, [], { argvHash: sha256Hex("cached"), successful: false, source: "cache" });
		assert.deepEqual(evaluateValidationReuse(failedCache, await currentForRecipe(dir, {
			target: buildRecipeValidationTarget(TARGET_RECIPE, sha256Hex("cached"), dir),
		})).reasons, ["unsuccessful-source"]);

		// Source refusals short-circuit: a failed non-Sol run with drifted
		// state reports ONLY the source reasons.
		const drifted = await currentForRecipe(dir, { mode: "VERIFY" });
		assert.deepEqual(evaluateValidationReuse(workerBlock, drifted).reasons, [
			"unsuccessful-source",
			"incomplete-source",
			"non-sol-source",
		]);
	});
});

// ---------------------------------------------------------------------------
// Deterministic ordering of component mismatches
// ---------------------------------------------------------------------------

test("all component mismatches accumulate in the fixed deterministic order", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const block = await captureRecipe(dir);
		const current: ValidationCurrentState = {
			collectionFailed: false,
			collectionReason: null,
			commit: "f".repeat(64),
			diffHash: "e".repeat(64),
			lockfiles: { "package-lock.json": "d".repeat(64) },
			configHash: "c".repeat(64),
			gateStateHash: "b".repeat(64),
			profile: "quant-research/stock-selection",
			mode: "VERIFY",
			target: { kind: "recipe", name: "other", definition_hash: "a".repeat(64), invocation_hash: "9".repeat(64), cwd: "sub" },
		};
		assert.deepEqual(evaluateValidationReuse(block, current).reasons, [
			"commit-mismatch",
			"diff-mismatch",
			"dependencies-mismatch",
			"config-mismatch",
			"gate-state-mismatch",
			"profile-mismatch",
			"mode-mismatch",
			"target-mismatch",
		]);
	});
});

// ---------------------------------------------------------------------------
// Commit / diff (content, path, status-only) drift
// ---------------------------------------------------------------------------

test("commit drift is a commit-mismatch; content and path drift are diff-mismatches", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const clean = await captureRecipe(dir);
		const currentClean = await currentForRecipe(dir);
		assert.equal(evaluateValidationReuse(clean, currentClean).reusable, true);

		// Untracked file: diff-mismatch only (commit/config/etc. unchanged).
		await writeFile(join(dir, "dirty.txt"), "x", "utf8");
		const dirtyCurrent = await currentForRecipe(dir);
		assert.deepEqual(evaluateValidationReuse(clean, dirtyCurrent).reasons, ["diff-mismatch"]);

		// A new commit with a clean tree: commit-mismatch only.
		await spawnExec("git", ["add", "dirty.txt"], { cwd: dir });
		await spawnExec("git", ["commit", "-qm", "second"], { cwd: dir });
		const newHeadCurrent = await currentForRecipe(dir);
		assert.deepEqual(evaluateValidationReuse(clean, newHeadCurrent).reasons, ["commit-mismatch"]);
	});
});

test("status-only drift (git add of identical content) changes the diff hash", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		await writeFile(join(dir, "staged.txt"), "same bytes", "utf8");
		const untracked = await captureRecipe(dir);
		const untrackedCurrent = await currentForRecipe(dir);
		assert.equal(evaluateValidationReuse(untracked, untrackedCurrent).reusable, true, "untracked state compares against itself");

		// Stage the SAME content: porcelain status "??" → "A " — the diff
		// hash must change even though content and paths are identical.
		await spawnExec("git", ["add", "staged.txt"], { cwd: dir });
		const stagedCurrent = await currentForRecipe(dir);
		assert.deepEqual(evaluateValidationReuse(untracked, stagedCurrent).reasons, ["diff-mismatch"]);

		// The staged state compares against itself (new binding).
		const staged = await captureRecipe(dir);
		assert.equal(evaluateValidationReuse(staged, stagedCurrent).reusable, true);
	});
});

test("profile and mode mismatches refuse reuse", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const block = await captureRecipe(dir);
		const base = await currentForRecipe(dir);

		// A NON-quant profile change must refuse with profile-mismatch ONLY:
		// the effective gate schema (base gates) is unchanged, so the
		// gate-state hash stays equal.
		const otherProfile = await currentForRecipe(dir, { profile: "other" });
		assert.deepEqual(evaluateValidationReuse(block, otherProfile).reasons, ["profile-mismatch"]);

		// A quant-research profile ALSO changes the effective gate schema
		// (quant gates load only for quant profiles): gate-state-mismatch
		// fires right before profile-mismatch in the fixed order.
		const quantProfile = await currentForRecipe(dir, { profile: "quant-research/stock-selection" });
		assert.deepEqual(evaluateValidationReuse(block, quantProfile).reasons, ["gate-state-mismatch", "profile-mismatch"]);

		const otherMode = await currentForRecipe(dir, { mode: "VERIFY" });
		assert.deepEqual(evaluateValidationReuse(block, otherMode).reasons, ["mode-mismatch"]);

		const both = await currentForRecipe(dir, { profile: "x", mode: "VERIFY" });
		assert.deepEqual(evaluateValidationReuse(block, both).reasons, ["profile-mismatch", "mode-mismatch"]);
	});
});

// ---------------------------------------------------------------------------
// Target mismatches
// ---------------------------------------------------------------------------

test("recipe target mismatches: invocation, definition, name, cwd", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const block = await captureRecipe(dir, ["hello-cli", "run", "alpha"]);
		const base = await currentForRecipe(dir);

		// Different argv → different invocation hash.
		const otherInvocation = await currentForRecipe(dir, {
			target: buildRecipeValidationTarget(TARGET_RECIPE, canonicalHash(["hello-cli", "run", "beta"]), dir),
		});
		assert.deepEqual(evaluateValidationReuse(block, otherInvocation).reasons, ["target-mismatch"]);

		// Different definition (timeout change).
		const otherDefinition = await currentForRecipe(dir, {
			target: buildRecipeValidationTarget(makeRecipe({ timeout_ms: 90_000 }), TARGET_INVOCATION, dir),
		});
		assert.deepEqual(evaluateValidationReuse(block, otherDefinition).reasons, ["target-mismatch"]);

		// Different name.
		const otherName = await currentForRecipe(dir, {
			target: buildRecipeValidationTarget(makeRecipe({ name: "other" }), TARGET_INVOCATION, dir),
		});
		assert.deepEqual(evaluateValidationReuse(block, otherName).reasons, ["target-mismatch"]);

		// Different cwd.
		const otherCwd = await currentForRecipe(dir, {
			target: buildRecipeValidationTarget(makeRecipe({ cwd: "sub" }), TARGET_INVOCATION, dir),
		});
		assert.deepEqual(evaluateValidationReuse(block, otherCwd).reasons, ["target-mismatch"]);

		// Kind mismatch (recipe binding vs gate current target). The gate
		// current is collected WITHOUT gate-state inputs so its hash stays the
		// schema-only hash (recipe-style) — the refusal must be the kind
		// mismatch alone, not a gate-state hash-space difference.
		const gateCurrent = await collectValidationCurrentState({
			projectRoot: dir,
			profile: "generic",
			mode: "DEV",
			exec: spawnExec,
			projectGates: [],
			target: GATE_TARGET,
		});
		assert.deepEqual(evaluateValidationReuse(block, gateCurrent).reasons, ["target-mismatch"]);
		assert.equal(base.target.kind, "recipe");
	});
});

test("gate target mismatches: selector, requested and effective gates", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const block = await captureGate(dir);

		const otherSelector = await currentForGate(dir, { target: buildGateValidationTarget("g1", ["g1"], ["g1"]) });
		assert.deepEqual(evaluateValidationReuse(block, otherSelector).reasons, ["target-mismatch"]);

		const otherRequested = await currentForGate(dir, { target: buildGateValidationTarget("g1,g2", ["g1", "g2"], ["g1"]) });
		assert.deepEqual(evaluateValidationReuse(block, otherRequested).reasons, ["target-mismatch"]);

		const otherEffective = await currentForGate(dir, { target: buildGateValidationTarget("g1,g2", ["g1", "g2"], ["g1", "g2", "g3"]) });
		assert.deepEqual(evaluateValidationReuse(block, otherEffective).reasons, ["target-mismatch"]);

		// Same selector, different requested ORDER still matches (sorted at capture).
		const same = await currentForGate(dir, { target: buildGateValidationTarget("g1,g2", ["g1", "g2"], ["g1", "g2"]) });
		assert.equal(evaluateValidationReuse(block, same).reusable, true);
	});
});

// ---------------------------------------------------------------------------
// Gate-state hashes (manual / worker-first / prerequisite facts)
// ---------------------------------------------------------------------------

test("gate-state hash sensitivity: manual evidence, worker facts and prerequisite statuses", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const base = await captureGate(dir, {
			manualEvidence: { "g1.1": "manual review completed" },
			workerFirstFacts: cleanWorkerFacts(),
			prerequisiteStatus: { g1: "PASS", g2: "FAIL" },
		});
		const baseCurrent = await currentForGate(dir, {
			gateState: {
				manualEvidence: { "g1.1": "manual review completed" },
				workerFirstFacts: cleanWorkerFacts(),
				actorFacts: SOL,
				prerequisiteStatus: { g1: "PASS", g2: "FAIL" },
			},
		});
		assert.equal(evaluateValidationReuse(base, baseCurrent).reusable, true);

		// Manual evidence text changes → gate-state-mismatch.
		const otherManual = await currentForGate(dir, {
			gateState: {
				manualEvidence: { "g1.1": "manual review completed differently" },
				workerFirstFacts: cleanWorkerFacts(),
				actorFacts: SOL,
				prerequisiteStatus: { g1: "PASS", g2: "FAIL" },
			},
		});
		assert.deepEqual(evaluateValidationReuse(base, otherManual).reasons, ["gate-state-mismatch"]);

		// Worker-first facts change → gate-state-mismatch.
		const otherFacts = await currentForGate(dir, {
			gateState: {
				manualEvidence: { "g1.1": "manual review completed" },
				workerFirstFacts: cleanWorkerFacts({ leaseStatus: "active", leaseReason: "user-directed" }),
				actorFacts: SOL,
				prerequisiteStatus: { g1: "PASS", g2: "FAIL" },
			},
		});
		assert.deepEqual(evaluateValidationReuse(base, otherFacts).reasons, ["gate-state-mismatch"]);

		// Prerequisite status change → gate-state-mismatch.
		const otherPrereq = await currentForGate(dir, {
			gateState: {
				manualEvidence: { "g1.1": "manual review completed" },
				workerFirstFacts: cleanWorkerFacts(),
				actorFacts: SOL,
				prerequisiteStatus: { g1: "PASS", g2: "PASS" },
			},
		});
		assert.deepEqual(evaluateValidationReuse(base, otherPrereq).reasons, ["gate-state-mismatch"]);

		// Actor facts change → gate-state-mismatch (bounded actor facts hashed).
		const otherActor = await currentForGate(dir, {
			gateState: {
				manualEvidence: { "g1.1": "manual review completed" },
				workerFirstFacts: cleanWorkerFacts(),
				actorFacts: WORKER,
				prerequisiteStatus: { g1: "PASS", g2: "FAIL" },
			},
		});
		assert.deepEqual(evaluateValidationReuse(base, otherActor).reasons, ["gate-state-mismatch"]);
	});
});

test("worker-first facts hash excludes currentDiffHash but covers every other fact", () => {
	const base = cleanWorkerFacts();
	assert.equal(
		workerFirstFactsHash(base),
		workerFirstFactsHash({ ...base, currentDiffHash: "d".repeat(64) }),
		"currentDiffHash is already an exact binding component — never double-counted",
	);
	assert.notEqual(workerFirstFactsHash(base), workerFirstFactsHash({ ...base, reviewStatus: "REVIEWED" }));
	assert.notEqual(workerFirstFactsHash(base), workerFirstFactsHash({ ...base, gateRunInitiatedByCommander: false }));
	assert.notEqual(workerFirstFactsHash(base), workerFirstFactsHash({ ...base, blockedReason: "blocked now" }));
	assert.notEqual(workerFirstFactsHash(base), workerFirstFactsHash(undefined));
	assert.equal(workerFirstFactsHash(undefined), workerFirstFactsHash(undefined));
});

test("manual-evidence hash is order-independent and content-sensitive", () => {
	assert.equal(manualEvidenceHash({ a: "x", b: "y" }), manualEvidenceHash({ b: "y", a: "x" }));
	assert.notEqual(manualEvidenceHash({ a: "x" }), manualEvidenceHash({ a: "y" }));
	assert.notEqual(manualEvidenceHash({ a: "x" }), manualEvidenceHash({ b: "x" }));
	assert.notEqual(manualEvidenceHash({}), manualEvidenceHash({ a: "x" }));
});

test("prerequisite-status hash drops sources/run ids and is order-independent", () => {
	assert.equal(prerequisiteStatusHash({ g1: "PASS", g2: "FAIL" }), prerequisiteStatusHash({ g2: "FAIL", g1: "PASS" }));
	assert.notEqual(prerequisiteStatusHash({ g1: "PASS" }), prerequisiteStatusHash({ g1: "FAIL" }));
	assert.notEqual(prerequisiteStatusHash({ g1: "PASS" }), prerequisiteStatusHash({ g1: "PASS", g2: "PASS" }));
	// Non-status values (e.g. a run-id-bearing source) never enter the hash.
	assert.equal(prerequisiteStatusHash({ g1: "PASS", g2: "run:20260101-120000-abcd" }), prerequisiteStatusHash({ g1: "PASS" }));
});

test("actor-facts hash is bounded to role/provider/model ids", () => {
	assert.equal(actorFactsHash(undefined), actorFactsHash(undefined));
	assert.notEqual(actorFactsHash(SOL), actorFactsHash(WORKER));
	assert.equal(actorFactsHash(SOL), actorFactsHash({ ...SOL }));
	assert.notEqual(actorFactsHash(SOL), actorFactsHash({ role: "worker", provider: "openai-codex", model: "gpt-5.6-sol" }));
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

test("bindings persist only bounded hashes/enums/ids — never raw content, text or arguments", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const lockSecret = "lockfile-super-secret-body";
		const configSecret = "config-super-secret-line";
		const argvSecret = "argv-super-secret-token";
		const manualSecret = "manual-super-secret-note";
		const factsSecret = "blocked-super-secret-reason";
		await writeFile(join(dir, "package-lock.json"), lockSecret, "utf8");
		await writeConfigFile(dir, "project.yaml", `name: test\nprofile: generic\ndescription: ${configSecret}\n`);

		const block = await captureRecipe(dir, ["hello-cli", "run", argvSecret]);
		const gate = await captureGate(dir, {
			manualEvidence: { "g1.1": manualSecret },
			workerFirstFacts: cleanWorkerFacts({ blockedReason: factsSecret }),
			prerequisiteStatus: { g1: "PASS" },
		});

		const recipeJson = JSON.stringify(block);
		assert.ok(!recipeJson.includes(lockSecret), "lockfile content must never be persisted");
		assert.ok(!recipeJson.includes(configSecret), "config content must never be persisted");
		assert.ok(!recipeJson.includes(argvSecret), "raw tool arguments must never be persisted");
		assert.ok(!recipeJson.includes("hello-cli"), "argument strings never appear (only the invocation hash)");
		assert.ok(!recipeJson.includes("run"), "argument strings never appear (only the invocation hash)");
		assert.ok(block.binding?.target.kind === "recipe");
		if (block.binding?.target.kind === "recipe") {
			assert.equal(block.binding.target.invocation_hash, executedArgvHash(["hello-cli", "run", argvSecret]), "invocation binds as an executed-argv hash");
		}

		const gateJson = JSON.stringify(gate);
		assert.ok(!gateJson.includes(manualSecret), "manual evidence text must never be persisted");
		assert.ok(!gateJson.includes(factsSecret), "worker-first blocked reasons must never be persisted raw");

		for (const json of [recipeJson, gateJson]) {
			assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(json), "no timestamps in a binding");
			assert.ok(!/\d{8}-\d{6}-[A-Za-z0-9]{4}/.test(json), "no run ids in a binding");
			assert.ok(json.length < 8_000, "bindings stay compact");
		}
		// Every hash field is a real SHA-256.
		const recipe = block.binding!;
		for (const field of ["diff_hash", "config_hash", "gate_state_hash"] as const) {
			assert.match(recipe[field], /^[0-9a-f]{64}$/);
		}
		for (const hash of Object.values(recipe.lockfiles)) {
			assert.match(hash, /^[0-9a-f]{64}$|^missing$|^not-a-file$|^too-large$/);
		}
		if (recipe.target.kind === "recipe") {
			assert.match(recipe.target.definition_hash, /^[0-9a-f]{64}$/);
			assert.match(recipe.target.invocation_hash, /^[0-9a-f]{64}$/);
		}
	});
});

// ---------------------------------------------------------------------------
// Collection failure (fail-closed)
// ---------------------------------------------------------------------------

test("collection failure fails closed: unavailable capture and collection-failure comparison", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const failingGit: ExecFn = async (command, args) => {
			if (command === "git" && args[0] === "status") {
				return { stdout: "", stderr: "fatal: repository corrupted", code: 1, killed: false };
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const captured = await captureRecipeValidationEvidence({
			projectRoot: dir,
			profile: "generic",
			mode: "DEV",
			exec: failingGit,
			recipe: TARGET_RECIPE,
			argv: ["hello-cli", "run", "alpha"],
			projectGates: [],
			actorFacts: SOL,
			successful: true,
			complete: true,
			source: "exec",
		});
		assert.equal(captured.ok, false);
		assert.ok(captured.reason.includes("capture failed"), captured.reason);
		const unavailable = unavailableEvidenceBlock(captured.reason);
		assert.equal(unavailable.binding, null);
		assert.ok(unavailable.unavailable_reason!.length <= 500, "bounded reason");

		// A valid binding compared against a failed collection refuses with
		// collection-failure — even when every other component matches.
		const validBlock = await captureRecipe(dir);
		const failedCurrent = await collectValidationCurrentState({
			projectRoot: dir,
			profile: "generic",
			mode: "DEV",
			exec: failingGit,
			projectGates: [],
			target: buildRecipeValidationTarget(TARGET_RECIPE, TARGET_INVOCATION, dir),
		});
		assert.equal(failedCurrent.collectionFailed, true);
		assert.deepEqual(evaluateValidationReuse(validBlock, failedCurrent).reasons, ["collection-failure"]);
		assert.deepEqual(evaluateValidationReuse(unavailable, failedCurrent).reasons, ["unavailable-binding"], "block-level refusal dominates");
	});
});

// ---------------------------------------------------------------------------
// Every known lockfile: add / change / remove
// ---------------------------------------------------------------------------

test("every known lockfile add/change/remove invalidates dependencies", async () => {
	for (const lockfile of KNOWN_LOCKFILES) {
		await withTempDir(async (dir) => {
			// All lockfiles gitignored so mutations never dirty the diff:
			// the ONLY component that changes is the lockfile hash.
			await writeFile(join(dir, ".gitignore"), `.pi/\n${KNOWN_LOCKFILES.join("\n")}\n`, "utf8");
			await spawnExec("git", ["init", "-q"], { cwd: dir });
			await spawnExec("git", ["config", "user.email", "t@t"], { cwd: dir });
			await spawnExec("git", ["config", "user.name", "t"], { cwd: dir });
			await spawnExec("git", ["add", "-A"], { cwd: dir });
			await spawnExec("git", ["commit", "-qm", "init"], { cwd: dir });

			const path = join(dir, lockfile);
			// ADD: absent at capture, present now.
			const absent = await captureRecipe(dir);
			await writeFile(path, "v1", "utf8");
			let current = await currentForRecipe(dir);
			assert.deepEqual(evaluateValidationReuse(absent, current).reasons, ["dependencies-mismatch"], `${lockfile}: add`);

			// CHANGE: content differs.
			const v1 = await captureRecipe(dir);
			await writeFile(path, "v2", "utf8");
			current = await currentForRecipe(dir);
			assert.deepEqual(evaluateValidationReuse(v1, current).reasons, ["dependencies-mismatch"], `${lockfile}: change`);

			// REMOVE: present at capture, gone now.
			const v2 = await captureRecipe(dir);
			await rm(path, { force: true });
			current = await currentForRecipe(dir);
			assert.deepEqual(evaluateValidationReuse(v2, current).reasons, ["dependencies-mismatch"], `${lockfile}: remove`);

			// The block's lockfile map covers EVERY known lockfile.
			const block = await captureRecipe(dir);
			assert.deepEqual(Object.keys(block.binding!.lockfiles).sort(), [...KNOWN_LOCKFILES].sort());
		});
	}
});

// ---------------------------------------------------------------------------
// Every workbench config file: add / change / remove
// ---------------------------------------------------------------------------

const CONFIG_FILES = ["project.yaml", "recipes.yaml", "gates.yaml", "profiles.yaml"] as const;
const CONFIG_VARIANTS: Record<(typeof CONFIG_FILES)[number], Record<string, string>> = {
	"project.yaml": { a: "", b: "name: p\nprofile: generic\n", c: "name: p\nprofile: generic\ndescription: changed\n" },
	"recipes.yaml": {
		a: "",
		b: "recipes:\n  - { name: hello, command: [\"hello-cli\", \"run\"] }\n  - { name: other, command: [\"other-cli\"] }\n",
		c: "recipes:\n  - { name: hello, command: [\"hello-cli\", \"run\"] }\n  - { name: other, command: [\"other-cli\"], description: changed }\n",
	},
	"gates.yaml": { a: "", b: "gates: []\n", c: "gates:\n  - { id: g1, title: Added, checks: [{ id: g1.1, kind: config }] }\n" },
	"profiles.yaml": {
		a: "",
		b: "profiles:\n  - { name: generic }\n",
		c: "profiles:\n  - { name: generic, description: changed }\n",
	},
};

test("every workbench config file add/change/remove invalidates config", async () => {
	for (const file of CONFIG_FILES) {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, ".gitignore"), ".pi/\n", "utf8");
			await spawnExec("git", ["init", "-q"], { cwd: dir });
			await spawnExec("git", ["config", "user.email", "t@t"], { cwd: dir });
			await spawnExec("git", ["config", "user.name", "t"], { cwd: dir });
			await spawnExec("git", ["add", "-A"], { cwd: dir });
			await spawnExec("git", ["commit", "-qm", "init"], { cwd: dir });

			const variants = CONFIG_VARIANTS[file];
			const writeVariant = async (key: "a" | "b" | "c"): Promise<void> => {
				const content = variants[key];
				if (!content) {
					await rm(join(dir, ".pi", "workbench", file), { force: true });
				} else {
					await writeConfigFile(dir, file, content);
				}
			};
			// Real gates from the actual gates.yaml: a gates.yaml change must
			// alter BOTH config_hash and the effective gate-state hash.
			const loadGates = async (): Promise<unknown[]> => (await loadProjectConfig(dir, { trusted: true })).gates;
			const expectConfigMismatch = async (block: ValidationEvidenceBlock, projectGates: readonly unknown[]): Promise<void> => {
				const current = await currentForRecipe(dir, { projectGates });
				const verdict = evaluateValidationReuse(block, current);
				assert.ok(!verdict.reusable, `${file}: must refuse reuse`);
				assert.ok(verdict.reasons.includes("config-mismatch"), `${file}: config-mismatch in ${verdict.reasons.join(",")}`);
			};

			// ADD: absent at capture, present now.
			await writeVariant("a");
			const absent = await captureRecipe(dir, ["hello-cli", "run", "alpha"], { projectGates: await loadGates() });
			await writeVariant("b");
			await expectConfigMismatch(absent, await loadGates());

			// CHANGE: content differs.
			const v1 = await captureRecipe(dir, ["hello-cli", "run", "alpha"], { projectGates: await loadGates() });
			await writeVariant("c");
			await expectConfigMismatch(v1, await loadGates());

			// REMOVE: present at capture, gone now.
			const v2 = await captureRecipe(dir, ["hello-cli", "run", "alpha"], { projectGates: await loadGates() });
			await writeVariant("a");
			await expectConfigMismatch(v2, await loadGates());

			// gates.yaml additionally changes the effective gate schema:
			// gate-state-mismatch fires right after config-mismatch.
			if (file === "gates.yaml") {
				await writeVariant("b");
				const gatesB = await loadGates();
				const before = await captureRecipe(dir, ["hello-cli", "run", "alpha"], { projectGates: gatesB });
				await writeVariant("c");
				const current = await currentForRecipe(dir, { projectGates: await loadGates() });
				assert.deepEqual(evaluateValidationReuse(before, current).reasons, ["config-mismatch", "gate-state-mismatch"]);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Capture field shapes (recipe + gate + action-cache invocation binding)
// ---------------------------------------------------------------------------

test("recipe capture binds name/definition/invocation/cwd and outcome facts", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const block = await captureRecipe(dir, ["hello-cli", "run", "alpha"], { source: "exec" });
		const binding = block.binding!;
		assert.equal(binding.kind, "recipe");
		assert.equal(binding.owner, "sol");
		assert.equal(binding.profile, "generic");
		assert.equal(binding.mode, "DEV");
		assert.deepEqual(binding.outcome, { successful: true, complete: true, source: "exec" });
		assert.equal(binding.target.kind, "recipe");
		if (binding.target.kind === "recipe") {
			assert.equal(binding.target.name, "hello");
			assert.equal(binding.target.cwd, ".");
			assert.equal(binding.target.invocation_hash, executedArgvHash(["hello-cli", "run", "alpha"]));
		}
		assert.ok(binding.commit, "git HEAD captured");
		assert.ok(binding.diff_hash.length === 64);
	});
});

test("action-cache materialized captures bind the action-key argv hash, never argv", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const argvHash = sha256Hex("hello-cli run --flag=secret");
		const block = await captureRecipe(dir, [], { argvHash, source: "cache" });
		const binding = block.binding!;
		assert.ok(binding.target.kind === "recipe");
		if (binding.target.kind === "recipe") {
			assert.equal(binding.target.invocation_hash, argvHash);
		}
		assert.deepEqual(binding.outcome, { successful: true, complete: true, source: "cache" });
		const json = JSON.stringify(block);
		assert.ok(!json.includes("hello-cli"), "cached argv never persists");
	});
});

test("gate capture binds sorted requested/effective gates and gate-state hash", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const block = await captureGate(dir, {
			selector: "g2,g1",
			requestedGates: ["g2", "g1"],
			effectiveGates: ["g2", "g1"],
			manualEvidence: { "m1": "note" },
			workerFirstFacts: cleanWorkerFacts(),
			prerequisiteStatus: { g2: "FAIL", g1: "PASS" },
			successful: false,
		});
		const binding = block.binding!;
		assert.equal(binding.kind, "gate");
		assert.deepEqual(binding.outcome, { successful: false, complete: true, source: "gate" });
		if (binding.target.kind === "gate") {
			assert.equal(binding.target.selector, "g2,g1");
			assert.deepEqual(binding.target.requested_gates, ["g1", "g2"], "requested gates sorted");
			assert.deepEqual(binding.target.effective_gates, ["g1", "g2"], "effective gates sorted");
		}
		// The gate-state hash changes when any hashed fact changes.
		const other = await captureGate(dir, {
			manualEvidence: { "m1": "note" },
			workerFirstFacts: cleanWorkerFacts({ reviewStatus: "REVIEWED" }),
			prerequisiteStatus: { g2: "FAIL", g1: "PASS" },
		});
		assert.notEqual(other.binding!.gate_state_hash, binding.gate_state_hash);
	});
});

// ---------------------------------------------------------------------------
// P4a strict collection: complete-content diff identity
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;

/** Non-asserting capture (for fail-closed cases). */
async function tryCaptureRecipe(dir: string): Promise<Awaited<ReturnType<typeof captureRecipeValidationEvidence>>> {
	return captureRecipeValidationEvidence({
		projectRoot: dir,
		profile: "generic",
		mode: "DEV",
		exec: spawnExec,
		recipe: TARGET_RECIPE,
		argv: ["hello-cli", "run", "alpha"],
		projectGates: [],
		actorFacts: SOL,
		successful: true,
		complete: true,
		source: "exec",
	});
}

/** Non-asserting current-state collection (for fail-closed cases). */
async function tryCurrentForRecipe(dir: string): Promise<ValidationCurrentState> {
	return collectValidationCurrentState({
		projectRoot: dir,
		profile: "generic",
		mode: "DEV",
		exec: spawnExec,
		projectGates: [],
		target: buildRecipeValidationTarget(TARGET_RECIPE, TARGET_INVOCATION, dir),
	});
}

/** True when the platform can create symlinks (Windows may need privileges). */
async function canCreateSymlink(dir: string): Promise<boolean> {
	try {
		await symlink(join(dir, "probe-target"), join(dir, "probe-link"));
		await rm(join(dir, "probe-link"));
		return true;
	} catch {
		return false;
	}
}

/** True when chmod 000 actually blocks reads (root/Windows may not enforce). */
async function permissionsEnforceable(dir: string): Promise<boolean> {
	const probe = join(dir, ".perm-probe");
	await writeFile(probe, "x", "utf8");
	await chmod(probe, 0o000);
	try {
		await readFile(probe);
		return false;
	} catch {
		return true;
	} finally {
		await chmod(probe, 0o600).catch(() => {});
	}
}

/** Git project with every known lockfile gitignored (isolates lockfile facts). */
async function setupGitProjectIgnoringLockfiles(dir: string): Promise<void> {
	await writeFile(join(dir, ".gitignore"), `.pi/\n${KNOWN_LOCKFILES.join("\n")}\n`, "utf8");
	await spawnExec("git", ["init", "-q"], { cwd: dir });
	await spawnExec("git", ["config", "user.email", "t@t"], { cwd: dir });
	await spawnExec("git", ["config", "user.name", "t"], { cwd: dir });
	await spawnExec("git", ["add", "-A"], { cwd: dir });
	await spawnExec("git", ["commit", "-qm", "init"], { cwd: dir });
}

test("same-size change beyond 4 MiB invalidates the diff hash (complete-content identity)", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		const big = Buffer.alloc(5 * MIB, 0x61);
		await writeFile(join(dir, "big.bin"), big);

		const block = await captureRecipe(dir);
		const clean = await currentForRecipe(dir);
		assert.equal(evaluateValidationReuse(block, clean).reusable, true, "a >4MiB changed file binds against itself");

		// Same file size; only a byte BEYOND the 4 MiB prefix changes. The
		// complete-content identity must still invalidate the diff hash.
		big[4 * MIB + 17] = 0x62;
		await writeFile(join(dir, "big.bin"), big);
		const drifted = await currentForRecipe(dir);
		assert.deepEqual(evaluateValidationReuse(block, drifted).reasons, ["diff-mismatch"], "bytes beyond 4 MiB must invalidate");

		// The drifted state re-binds against itself.
		const rebound = await captureRecipe(dir);
		assert.equal(evaluateValidationReuse(rebound, drifted).reusable, true);
	});
});

test("completeContentDigestStrict hashes the FULL file and refuses unprovable paths", async () => {
	await withTempDir(async (dir) => {
		const big = Buffer.alloc(5 * MIB);
		for (let i = 0; i < big.length; i += 4096) big[i] = (i >> 8) & 0xff;
		await writeFile(join(dir, "big.bin"), big);
		const digest = await completeContentDigestStrict(dir, "big.bin", "??");
		const expected = createHash("sha256").update(big).digest("hex");
		assert.equal(digest, expected, "the digest covers the ENTIRE file, not a prefix");

		// Escapes / absolute / drive-letter / traversal forms are refused.
		await assert.rejects(completeContentDigestStrict(dir, "../outside", " M"), /safe project-relative|escapes/);
		await assert.rejects(completeContentDigestStrict(dir, "/etc/passwd", " M"), /safe project-relative|escapes/);
		await assert.rejects(completeContentDigestStrict(dir, "..\\outside", " M"), /safe project-relative|escapes/);
		await assert.rejects(completeContentDigestStrict(dir, "C:\\outside", " M"), /safe project-relative|escapes/);

		// Absent without a deletion status is unprovable; WITH a deletion
		// status it binds the deterministic missing marker.
		await assert.rejects(completeContentDigestStrict(dir, "gone.txt", " M"), /not a deletion/);
		assert.equal(await completeContentDigestStrict(dir, "gone.txt", " D"), "missing");
		assert.equal(await completeContentDigestStrict(dir, "gone.txt", "D "), "missing");
		assert.equal(await completeContentDigestStrict(dir, "gone.txt", "AD"), "missing");

		// A directory is not a provable regular file.
		await mkdir(join(dir, "adir"));
		await assert.rejects(completeContentDigestStrict(dir, "adir", "??"), /not a regular file/);
	});
});

test("a deletion with a deletion status binds the missing marker through computeDiffHash", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, ".gitignore"), ".pi/\n", "utf8");
		await writeFile(join(dir, "tracked.txt"), "content", "utf8");
		await spawnExec("git", ["init", "-q"], { cwd: dir });
		await spawnExec("git", ["config", "user.email", "t@t"], { cwd: dir });
		await spawnExec("git", ["config", "user.name", "t"], { cwd: dir });
		await spawnExec("git", ["add", "-A"], { cwd: dir });
		await spawnExec("git", ["commit", "-qm", "init"], { cwd: dir });
		await rm(join(dir, "tracked.txt"));

		const block = await captureRecipe(dir);
		const current = await currentForRecipe(dir);
		assert.equal(evaluateValidationReuse(block, current).reusable, true, "a deletion state binds against itself");
		assert.equal(
			block.binding!.diff_hash,
			computeDiffHash(["tracked.txt"], { "tracked.txt": "missing" }, { "tracked.txt": " D" }),
			"deleted path binds the deterministic missing marker, not a fabricated digest",
		);
	});
});

test("changed symlink paths refuse capture and current collection (untracked and tracked)", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		if (!(await canCreateSymlink(dir))) return; // platform cannot create symlinks

		// Untracked symlink: "?? link" is a changed path whose full content
		// cannot be proven without following.
		await symlink("target-file", join(dir, "link"));
		let captured = await tryCaptureRecipe(dir);
		assert.equal(captured.ok, false, "an untracked symlink must refuse capture");
		assert.ok(captured.reason.includes("symlink"), captured.reason);
		let state = await tryCurrentForRecipe(dir);
		assert.equal(state.collectionFailed, true, "current collection fails closed on a symlink");
		await rm(join(dir, "link"));

		// Tracked symlink whose target changed: porcelain " T link".
		await symlink("one", join(dir, "tracked-link"));
		await spawnExec("git", ["add", "tracked-link"], { cwd: dir });
		await spawnExec("git", ["commit", "-qm", "add symlink"], { cwd: dir });
		await rm(join(dir, "tracked-link"));
		await symlink("two", join(dir, "tracked-link"));
		captured = await tryCaptureRecipe(dir);
		assert.equal(captured.ok, false, "a tracked symlink typechange must refuse capture");
		state = await tryCurrentForRecipe(dir);
		assert.equal(state.collectionFailed, true, "current collection fails closed on a tracked typechange");
	});
});

test("a changed socket path refuses collection (unsupported file type)", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		// A Unix-domain socket: open() on it errors immediately (unlike a
		// FIFO, whose read-open would block), so this never hangs.
		const server = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(join(dir, "sock"), () => resolve());
			});
		} catch {
			return; // platform cannot create unix sockets (e.g. Windows)
		}
		server.close();
		const status = await spawnExec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir });
		if (!status.stdout.includes("sock")) return; // git does not surface this special type here
		const captured = await tryCaptureRecipe(dir);
		assert.equal(captured.ok, false);
		assert.ok(captured.reason.includes("not a regular file"), captured.reason);
		const state = await tryCurrentForRecipe(dir);
		assert.equal(state.collectionFailed, true);
	});
});

test("an unreadable changed file fails collection closed (skipped where permissions cannot be enforced)", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		if (!(await permissionsEnforceable(dir))) return;
		const path = join(dir, "locked.txt");
		await writeFile(path, "secret content", "utf8");
		await chmod(path, 0o000);
		try {
			const captured = await tryCaptureRecipe(dir);
			assert.equal(captured.ok, false);
			assert.ok(captured.reason.includes("cannot be read in full"), captured.reason);
			const state = await tryCurrentForRecipe(dir);
			assert.equal(state.collectionFailed, true);
		} finally {
			await chmod(path, 0o600).catch(() => {});
		}
	});
});

// ---------------------------------------------------------------------------
// P4a strict collection: lockfile and config paths (lstat-proven absence)
// ---------------------------------------------------------------------------

test("dangling and resolving symlink lockfiles fail collection closed for every known lockfile", async () => {
	for (const lockfile of KNOWN_LOCKFILES) {
		await withTempDir(async (dir) => {
			await setupGitProjectIgnoringLockfiles(dir);
			if (!(await canCreateSymlink(dir))) return;
			// Dangling symlink: the FOLLOWED stat would return ENOENT, but the
			// path itself EXISTS — it must never masquerade as "missing".
			await symlink(join(dir, "no-such-target"), join(dir, lockfile));
			let captured = await tryCaptureRecipe(dir);
			assert.equal(captured.ok, false, `${lockfile}: a dangling symlink is an EXISTING path — never "missing"`);
			assert.ok(captured.reason.includes("symlink"), `${lockfile}: ${captured.reason}`);
			let state = await tryCurrentForRecipe(dir);
			assert.equal(state.collectionFailed, true, `${lockfile}: current collection fails closed`);

			// A symlink that RESOLVES is equally an existing non-regular path.
			await rm(join(dir, lockfile));
			await writeFile(join(dir, "real-target"), "x", "utf8");
			await symlink(join(dir, "real-target"), join(dir, lockfile));
			captured = await tryCaptureRecipe(dir);
			assert.equal(captured.ok, false, `${lockfile}: a resolving symlink is still refused`);
			state = await tryCurrentForRecipe(dir);
			assert.equal(state.collectionFailed, true, `${lockfile}: current collection fails closed on a resolving symlink`);
		});
	}
});

test("directory and oversized lockfile paths keep the deterministic not-a-file / too-large markers", async () => {
	await withTempDir(async (dir) => {
		await setupGitProjectIgnoringLockfiles(dir);

		// A DIRECTORY at a known lockfile path is "not-a-file" (P6-C marker
		// semantics preserved — it is not an absence, but it is a provable
		// non-file fact).
		const dirName = KNOWN_LOCKFILES[0]!;
		await mkdir(join(dir, dirName));
		const withDir = await captureRecipe(dir);
		assert.equal(withDir.binding!.lockfiles[dirName], "not-a-file");

		// A sparse 65 MiB lockfile is "too-large" — never read in full.
		await rm(join(dir, dirName), { recursive: true });
		const bigName = KNOWN_LOCKFILES[1]!;
		const handle = await open(join(dir, bigName), "w");
		await handle.truncate(65 * MIB);
		await handle.close();
		const withBig = await captureRecipe(dir);
		assert.equal(withBig.binding!.lockfiles[bigName], "too-large");
		const parsed = parseValidationEvidenceBlock(withBig);
		assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
	});
});

test("an unreadable lockfile fails collection closed (skipped where permissions cannot be enforced)", async () => {
	await withTempDir(async (dir) => {
		await setupGitProjectIgnoringLockfiles(dir);
		if (!(await permissionsEnforceable(dir))) return;
		const path = join(dir, KNOWN_LOCKFILES[0]!);
		await writeFile(path, "x", "utf8");
		await chmod(path, 0o000);
		try {
			const captured = await tryCaptureRecipe(dir);
			assert.equal(captured.ok, false, "an existing-but-unreadable lockfile must fail closed");
		} finally {
			await chmod(path, 0o600).catch(() => {});
		}
	});
});

test("dangling symlink workbench config files fail collection closed for every config file", async () => {
	for (const file of CONFIG_FILES) {
		await withTempDir(async (dir) => {
			await setupGitProject(dir);
			if (!(await canCreateSymlink(dir))) return;
			await mkdir(join(dir, CONFIG_DIR_NAME, "workbench"), { recursive: true });
			await symlink(join(dir, "no-such-target"), join(dir, CONFIG_DIR_NAME, "workbench", file));
			const captured = await tryCaptureRecipe(dir);
			assert.equal(captured.ok, false, `${file}: a dangling config symlink is not absence`);
			assert.ok(captured.reason.includes("symlink"), `${file}: ${captured.reason}`);
			const state = await tryCurrentForRecipe(dir);
			assert.equal(state.collectionFailed, true, `${file}: current collection fails closed`);
		});
	}
});

test("a directory at a workbench config path fails collection closed", async () => {
	await withTempDir(async (dir) => {
		await setupGitProject(dir);
		await mkdir(join(dir, CONFIG_DIR_NAME, "workbench", "project.yaml"), { recursive: true });
		const captured = await tryCaptureRecipe(dir);
		assert.equal(captured.ok, false);
		assert.ok(captured.reason.includes("not a regular file"), captured.reason);
		const state = await tryCurrentForRecipe(dir);
		assert.equal(state.collectionFailed, true);
	});
});

// ---------------------------------------------------------------------------
// P4a: complete lockfile-map parser
// ---------------------------------------------------------------------------

test("lockfile-map parser accepts the complete known set with legal markers and refuses partial/foreign maps", () => {
	const hashes: Record<string, string> = {};
	KNOWN_LOCKFILES.forEach((name, i) => {
		hashes[name] = i === 0 ? "missing" : i === 1 ? "not-a-file" : i === 2 ? "too-large" : sha256Hex(`content-${i}`);
	});
	const raw = {
		schema_version: 1,
		binding: {
			schema_version: 1,
			kind: "recipe",
			commit: null,
			diff_hash: "a".repeat(64),
			lockfiles: hashes,
			config_hash: "b".repeat(64),
			gate_state_hash: "c".repeat(64),
			mode: "DEV",
			owner: "sol",
			target: { kind: "recipe", name: "hello", definition_hash: "d".repeat(64), invocation_hash: "e".repeat(64), cwd: "." },
			outcome: { successful: true, complete: true, source: "exec" },
		},
		unavailable_reason: null,
	};
	assert.equal(parseValidationEvidenceBlock(raw).ok, true, "complete map with all legal markers parses");

	// A dropped known lockfile is never accepted as evidence.
	const partial = JSON.parse(JSON.stringify(raw)) as typeof raw;
	delete partial.binding.lockfiles[KNOWN_LOCKFILES[0]!];
	assert.equal(parseValidationEvidenceBlock(partial).ok, false, "an incomplete lockfile map is corrupt");

	// A foreign key is never accepted.
	const foreign = JSON.parse(JSON.stringify(raw)) as typeof raw;
	foreign.binding.lockfiles["unknown.lock"] = "missing";
	assert.equal(parseValidationEvidenceBlock(foreign).ok, false, "a foreign lockfile key is corrupt");

	// Illegal marker values are never accepted.
	const bad = JSON.parse(JSON.stringify(raw)) as typeof raw;
	bad.binding.lockfiles[KNOWN_LOCKFILES[0]!] = "gone";
	assert.equal(parseValidationEvidenceBlock(bad).ok, false, "an illegal marker value is corrupt");
});
