/**
 * P6-C Action Cache orchestration — the safe read/validate/write lifecycle
 * used by the recipe runner.
 *
 * Cache HIT policy (never skipped):
 *   1. action record schema version validated (store)
 *   2. record actionKey equals the freshly computed key (binds recipe
 *      definition, inputs, env, toolchain, OS/arch, lockfiles, config,
 *      profile, gate schema, upstream keys)
 *   3. semantic fields spot-checked against the computed components
 *   4. expected exit codes checked against the current recipe
 *   5. result-only: summary/evidence schema validated
 *   6. artifacts mode: restore disabled in v1 → always a miss
 *   7. maxAgeSeconds expiry checked
 *   8. executionSource: "cache" recorded on the new run manifest (gate
 *      evidence reads it from the run record)
 *   9. a cache record alone can never PASS a gate — gates only read run
 *      records, and cached runs are full run records
 *
 * Every failure degrades to normal execution. Cache machinery never blocks
 * the task.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import type { WorkbenchMode } from "../core/mode-policy.ts";
import type { ExecFn } from "../core/config.ts";
import type { Recipe } from "../core/recipe-schema.ts";
import { makeRunId, RUN_SCHEMA_VERSION, type RunRecord, type RunSummaryRecord } from "../core/runs.ts";
import { sha256Hex } from "./canonical-hash.ts";
import type { ActionCacheStore } from "./action-store.ts";
import {
	ACTION_CACHE_SCHEMA_VERSION,
	ARTIFACT_RESTORE_ENABLED,
	MAX_RECORD_INPUT_ENTRIES,
	type ActionKey,
	type ActionRecord,
	type CacheRequestMode,
	type CachedSummary,
	type InputEntry,
	type QuantContractRecordInfo,
	type RecipeCachePolicy,
} from "./action-types.ts";
import { computeActionKey, declaredEnvironmentHash, type ComputedActionKey } from "./action-key.ts";
import { resolveQuantContract, verifyBacktestResultArtifact } from "./quant-files.ts";

// Re-exported to preserve the existing `action-cache.ts` import API
// (index.ts and recipe-runner.ts import CacheRequestMode from here); the
// canonical definition lives in action-types.ts.
export type { CacheRequestMode } from "./action-types.ts";

export interface ActionCacheContext {
	projectRoot: string;
	recipe: Recipe;
	policy: RecipeCachePolicy;
	argv: string[];
	mode: WorkbenchMode;
	profile: string | undefined;
	projectGates: readonly unknown[];
	packageVersion: string;
	exec: ExecFn;
	store: ActionCacheStore;
	cacheMode: CacheRequestMode;
	now?: () => Date;
}

export interface LookupOutcome {
	status: "hit" | "miss" | "expired" | "artifacts-disabled" | "corrupt";
	record?: ActionRecord;
	reason?: string;
	validatedAt?: string;
}

export interface ExecutedRunFacts {
	runId: string;
	startedAt: Date;
	finishedAt: Date;
	durationMs: number;
	exitCode: number | null;
	killed: boolean;
	timedOut: boolean;
	cancelled: boolean;
	exitOk: boolean;
	stdoutView: string;
	stderrView: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	artifactPaths: string[];
	env: Record<string, string>;
	gitCommit: string | null;
	gitDirty: boolean;
}

export interface MaterializedRun {
	runId: string;
	runDir: string;
	record: RunRecord;
	summary: RunSummaryRecord;
}

// ---------------------------------------------------------------------------
// Planning / key computation
// ---------------------------------------------------------------------------

export function planCache(ctx: ActionCacheContext): { active: boolean; requestMode: CacheRequestMode } {
	if (ctx.cacheMode === "no-cache") return { active: false, requestMode: "no-cache" };
	if (!ctx.policy.enabled) return { active: false, requestMode: ctx.cacheMode };
	return { active: true, requestMode: ctx.cacheMode };
}

/** Compute the action key; failures refuse the cache (never throw). */
export async function computeKey(ctx: ActionCacheContext): Promise<ComputedActionKey> {
	return computeActionKey({
		projectRoot: ctx.projectRoot,
		recipe: ctx.recipe,
		policy: ctx.policy,
		argv: ctx.argv,
		mode: ctx.mode,
		profile: ctx.profile,
		projectGates: ctx.projectGates,
		packageVersion: ctx.packageVersion,
		exec: ctx.exec,
	});
}

// ---------------------------------------------------------------------------
// Lookup + full validation
// ---------------------------------------------------------------------------

function validateSummarySchema(record: ActionRecord): string | null {
	const s = record.summary;
	if (!s || typeof s !== "object") return "cached summary is missing";
	if (typeof s.stdout !== "string" || typeof s.stderr !== "string") return "cached summary stdout/stderr must be strings";
	if (typeof s.stdoutTruncated !== "boolean" || typeof s.stderrTruncated !== "boolean") return "cached summary truncation flags must be booleans";
	if (!Array.isArray(s.artifactPaths)) return "cached summary artifactPaths must be an array";
	if (typeof s.timedOut !== "boolean" || typeof s.cancelled !== "boolean") return "cached summary outcome flags must be booleans";
	return null;
}

/**
 * Look up and fully validate a cached result for the computed key.
 * Returns "hit" only when every check passes; anything else is a miss
 * (fall back to execution).
 */
export async function lookupValidated(ctx: ActionCacheContext, key: ActionKey): Promise<LookupOutcome> {
	const now = ctx.now ?? (() => new Date());
	if (ctx.policy.mode === "artifacts" && !ARTIFACT_RESTORE_ENABLED) {
		return {
			status: "artifacts-disabled",
			reason: "artifacts restore is disabled in this version — the recipe always executes",
		};
	}
	const { record, corrupt } = await ctx.store.readRecord(key.key);
	if (corrupt) return { status: "corrupt", reason: "action record corrupted — treated as a miss" };
	if (!record) return { status: "miss", reason: "no cached result for this action key" };

	// 1. schema version (store already checked) + package version.
	if (record.packageVersion !== ctx.packageVersion) {
		return { status: "miss", reason: "workbench package version changed" };
	}
	if (record.cachePolicyVersion !== ctx.policy.version && record.cachePolicyVersion !== 1) {
		return { status: "miss", reason: "cache policy version mismatch" };
	}

	// 3. semantic fields vs the freshly computed components (defense in
	//    depth — the key already binds them, but a malformed record must
	//    never slip through on key equality alone).
	const c = key.components;
	if (record.definitionHash !== c.recipeDefinitionHash) return { status: "miss", reason: "recipe definition hash mismatch" };
	if (record.cachePolicyHash !== c.cachePolicyHash) return { status: "miss", reason: "cache policy hash mismatch" };
	if (record.inputMerkleHash !== c.inputMerkleHash) return { status: "miss", reason: "declared input fingerprint mismatch" };
	if (record.argvHash !== c.argvHash) return { status: "miss", reason: "argv hash mismatch" };
	if (record.cwd !== c.normalizedCwd) return { status: "miss", reason: "cwd mismatch" };
	if (record.allowedMode !== c.allowedMode) return { status: "miss", reason: "mode mismatch" };
	if (record.os !== c.operatingSystem || record.arch !== c.architecture) return { status: "miss", reason: "OS/architecture mismatch" };
	if (record.workbenchConfigHash !== c.workbenchConfigHash) return { status: "miss", reason: "workbench config hash mismatch" };
	if (record.profileHash !== c.profileHash) return { status: "miss", reason: "profile mismatch" };
	if (record.gateSchemaHash !== c.gateSchemaHash) return { status: "miss", reason: "gate schema changed — evidence must be re-validated" };
	if (record.upstreamActionKeys.join(",") !== c.upstreamActionKeys.join(",")) return { status: "miss", reason: "upstream action keys changed" };
	if ((record.quantContractKey ?? null) !== c.quantContractKey) return { status: "miss", reason: "quant contract changed (manifest content, revision or immutable key)" };

	// P6-D: quant contract re-validation on the HIT path. The manifest is
	// re-read and re-validated right now; a backtest-result's declared
	// resultArtifactHash is verified against the on-disk artifact — a
	// mismatch is CORRUPTION (never a hit, never a silently trusted cache).
	if (ctx.policy.domain === "quant" && ctx.policy.quantContract) {
		const resolved = await resolveQuantContract(ctx.projectRoot, ctx.policy.quantContract, { profile: ctx.profile });
		if (!resolved.ok) {
			return { status: "miss", reason: `quant contract invalid at lookup: ${resolved.reason}` };
		}
		if (resolved.resolved.immutableKey !== c.quantContractKey) {
			return { status: "miss", reason: "quant contract resolution changed since key computation" };
		}
		if (ctx.policy.quantContract.type === "backtest-result") {
			const verified = await verifyBacktestResultArtifact(ctx.projectRoot, resolved.resolved.manifest);
			if (verified.corrupt) {
				return { status: "corrupt", reason: `result artifact hash mismatch: ${verified.reason ?? "corruption"}` };
			}
			if (!verified.ok) {
				return { status: "miss", reason: `result artifact unverifiable: ${verified.reason ?? "unknown"}` };
			}
		}
	}
	const envNames = [...new Set([...ctx.recipe.environment, ...ctx.policy.environment])];
	if (declaredEnvironmentHash(envNames, process.env) !== c.environmentHash) {
		return { status: "miss", reason: "declared environment changed" };
	}
	if (record.toolchainVersions[Object.keys(c.toolchainVersions)[0] ?? ""] !== undefined) {
		for (const [tool, version] of Object.entries(c.toolchainVersions)) {
			if (record.toolchainVersions[tool] !== version) {
				return { status: "miss", reason: `toolchain "${tool}" version changed` };
			}
		}
		for (const tool of Object.keys(record.toolchainVersions)) {
			if (!(tool in c.toolchainVersions)) return { status: "miss", reason: `toolchain "${tool}" no longer declared` };
		}
	}
	if (record.lockfileHashes[Object.keys(c.lockfileHashes)[0] ?? ""] !== undefined) {
		for (const [lockfile, hash] of Object.entries(c.lockfileHashes)) {
			if (record.lockfileHashes[lockfile] !== hash) {
				return { status: "miss", reason: `lockfile "${lockfile}" changed` };
			}
		}
	}

	// 4. expected exit codes (current recipe): a cached result is reusable
	//    only when its success flag matches what the CURRENT recipe would
	//    conclude from the cached exit code. (With successOnly=false a cached
	//    FAILURE is reusable by explicit opt-in — the materialized run still
	//    fails gates exactly like a real one.)
	const exitOk = record.exitCode !== null && ctx.recipe.expected_exit_codes.includes(record.exitCode);
	if (record.success !== exitOk) {
		return { status: "miss", reason: "cached exit code is inconsistent with the current recipe's expected_exit_codes" };
	}

	// 5. result-only summary/evidence schema.
	const schemaError = validateSummarySchema(record);
	if (schemaError) return { status: "miss", reason: schemaError };

	// 7. maxAgeSeconds expiry.
	if (ctx.policy.maxAgeSeconds !== null && ctx.policy.maxAgeSeconds > 0) {
		const ageMs = now().getTime() - Date.parse(record.createdAt);
		if (!Number.isNaN(ageMs) && ageMs > ctx.policy.maxAgeSeconds * 1000) {
			return { status: "expired", reason: `cached result is older than maxAgeSeconds (${ctx.policy.maxAgeSeconds}s)` };
		}
	}

	await ctx.store.touch(key.key).catch(() => {});
	return { status: "hit", record, validatedAt: now().toISOString() };
}

// ---------------------------------------------------------------------------
// Record building (after a real execution)
// ---------------------------------------------------------------------------

/** Decide whether a completed run may enter the cache. */
export function shouldCacheRun(policy: RecipeCachePolicy, facts: ExecutedRunFacts): boolean {
	if (facts.killed || facts.timedOut || facts.cancelled) return false;
	if (facts.exitCode === null) return false;
	return policy.successOnly ? facts.exitOk : true;
}

/**
 * Build the action record for an executed run. Values are NEVER stored:
 * env values and argv appear only as SHA-256 hashes; the summary carries the
 * already-redacted truncated output views.
 */
export function buildActionRecord(
	ctx: ActionCacheContext,
	key: ActionKey,
	facts: ExecutedRunFacts,
	inputEntries: InputEntry[],
	quantContractInfo: QuantContractRecordInfo | null = null,
): ActionRecord {
	const c = key.components;
	const envNames = [...new Set([...ctx.recipe.environment, ...ctx.policy.environment])];
	const envValueHashes: Record<string, string> = {};
	for (const name of envNames) {
		const value = facts.env[name];
		envValueHashes[name] = value === undefined ? "unset" : sha256Hex(value);
	}
	const summary: CachedSummary = {
		stdout: facts.stdoutView,
		stderr: facts.stderrView,
		stdoutTruncated: facts.stdoutTruncated,
		stderrTruncated: facts.stderrTruncated,
		artifactPaths: facts.artifactPaths,
		timedOut: facts.timedOut,
		cancelled: facts.cancelled,
	};
	return {
		schemaVersion: 1,
		cachePolicyVersion: ctx.policy.version,
		actionKey: key.key,
		recipe: ctx.recipe.name,
		mode: ctx.policy.mode,
		success: facts.exitOk,
		exitCode: facts.exitCode,
		expectedExitCodes: [...ctx.recipe.expected_exit_codes],
		createdAt: facts.startedAt.toISOString(),
		sourceRunId: facts.runId,
		durationMs: facts.durationMs,
		cwd: c.normalizedCwd,
		argvHash: c.argvHash,
		definitionHash: c.recipeDefinitionHash,
		cachePolicyHash: c.cachePolicyHash,
		environmentNames: envNames,
		envValueHashes,
		toolchainVersions: c.toolchainVersions,
		os: c.operatingSystem,
		arch: c.architecture,
		lockfileHashes: c.lockfileHashes,
		inputMerkleHash: c.inputMerkleHash,
		inputFacts: c.inputFacts,
		inputEntries: inputEntries.length > MAX_RECORD_INPUT_ENTRIES ? inputEntries.slice(0, MAX_RECORD_INPUT_ENTRIES) : inputEntries,
		workbenchConfigHash: c.workbenchConfigHash,
		profileHash: c.profileHash,
		gateSchemaHash: c.gateSchemaHash,
		upstreamActionKeys: c.upstreamActionKeys,
		quantContractKey: c.quantContractKey,
		quantContractInfo: quantContractInfo ?? key.quantContractInfo ?? null,
		allowedMode: c.allowedMode,
		packageVersion: ctx.packageVersion,
		summary,
		artifacts: {
			mode: ctx.policy.mode,
			restored: false,
			restoreDisabled: !ARTIFACT_RESTORE_ENABLED,
			outputs: [...ctx.policy.outputs],
		},
	};
}

// ---------------------------------------------------------------------------
// Hit materialization — a cache hit creates a NEW full run record
// ---------------------------------------------------------------------------

export interface MaterializeInput {
	projectRoot: string;
	recipe: Recipe;
	policy: RecipeCachePolicy;
	profile: string | undefined;
	key: ActionKey;
	record: ActionRecord;
	mode: WorkbenchMode;
	git: { commit: string | null; dirty: boolean };
	now?: () => Date;
}

/**
 * A cache hit still creates a fresh run manifest (executionSource: "cache",
 * actionKey, reusedFromRunId, cacheCreatedAt, cacheValidatedAt, exitCode,
 * evidencePaths, artifactValidation). The cached stdout/stderr views are the
 * truncated views — hit runs have no full logs (documented).
 */
export async function materializeCachedRun(input: MaterializeInput): Promise<MaterializedRun> {
	const { projectRoot, recipe, profile, key, record, mode, git } = input;
	const now = input.now ?? (() => new Date());
	const validatedAt = now();
	const runId = makeRunId(validatedAt);
	const runDir = join(projectRoot, CONFIG_DIR_NAME, "workbench", "runs", runId);
	const cwdAbs = resolve(projectRoot, recipe.cwd);
	const evidencePaths = [`${CONFIG_DIR_NAME}/workbench/runs/${runId}`];

	const manifest: RunRecord = {
		schema_version: RUN_SCHEMA_VERSION,
		run_id: runId,
		recipe: recipe.name,
		profile,
		started_at: validatedAt.toISOString(),
		finished_at: validatedAt.toISOString(),
		duration_ms: 0,
		cwd: cwdAbs,
		argv: [],
		exit_code: record.exitCode,
		timed_out: false,
		cancelled: false,
		git_commit: git.commit,
		git_dirty: git.dirty,
		artifact_paths: record.summary.artifactPaths,
		stdout_truncated: record.summary.stdoutTruncated,
		stderr_truncated: record.summary.stderrTruncated,
		mode,
		expected_exit_codes: recipe.expected_exit_codes,
		declared_writes: recipe.writes,
		environment_names: recipe.environment,
		validation_components: recipe.validation_components,
		// Only "default" mode reads cache hits — materialized runs are always
		// produced from a default-mode read.
		cache_request_mode: "default",
		execution_source: "cache",
		action_key: key.key,
		reused_from_run_id: record.sourceRunId,
		cache_created_at: record.createdAt,
		cache_validated_at: validatedAt.toISOString(),
		argv_hash: record.argvHash,
		artifact_validation: {
			mode: record.mode,
			artifacts_restored: false,
			hash_verified: false,
			status: record.mode === "artifacts" ? "restore-disabled" : "result-only",
		},
		quant_contract: record.quantContractInfo
			? {
					type: record.quantContractInfo.type,
					manifest: record.quantContractInfo.manifest,
					immutable_key: record.quantContractInfo.immutableKey,
					validation_status: record.quantContractInfo.validationStatus,
					logical_reference: record.quantContractInfo.logicalReference,
					resolved_reference: record.quantContractInfo.resolvedReference,
					warnings: record.quantContractInfo.warnings,
				}
			: undefined,
		evidence_paths: evidencePaths,
	};

	const summary: RunSummaryRecord = {
		run_id: runId,
		recipe: recipe.name,
		profile,
		started_at: manifest.started_at,
		finished_at: manifest.finished_at,
		duration_ms: 0,
		cwd: cwdAbs,
		argv: [],
		exit_code: record.exitCode,
		timed_out: false,
		cancelled: false,
		git_commit: git.commit,
		git_dirty: git.dirty,
		artifact_paths: record.summary.artifactPaths,
		stdout_truncated: record.summary.stdoutTruncated,
		stderr_truncated: record.summary.stderrTruncated,
		stdout: record.summary.stdout,
		stderr: record.summary.stderr,
		stdout_log: join(runDir, "stdout.log"),
		stderr_log: join(runDir, "stderr.log"),
	};

	await mkdir(runDir, { recursive: true });
	await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
	await writeFile(
		join(runDir, "command.json"),
		JSON.stringify(
			{
				recipe: recipe.name,
				cwd: cwdAbs,
				cache: {
					execution_source: "cache",
					action_key: key.key,
					reused_from_run_id: record.sourceRunId,
					cache_created_at: record.createdAt,
					cache_validated_at: manifest.cache_validated_at,
					argv_hash: record.argvHash,
					note: "argv values are never stored — only the argv hash",
				},
			},
			null,
			2,
		),
		"utf8",
	);
	await writeFile(
		join(runDir, "environment.json"),
		JSON.stringify(
			{
				environment: {},
				note: "cached run — declared environment values are stored only as SHA-256 hashes in the action record",
				env_value_hashes: record.envValueHashes,
			},
			null,
			2,
		),
		"utf8",
	);
	await writeFile(join(runDir, "stdout.log"), record.summary.stdout, "utf8");
	await writeFile(join(runDir, "stderr.log"), record.summary.stderr, "utf8");
	await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
	// Cache-source evidence: an explicit marker in the run directory.
	await writeFile(
		join(runDir, "execution.json"),
		JSON.stringify(
			{
				schema_version: 1,
				execution_source: "cache",
				action_key: key.key,
				reused_from_run_id: record.sourceRunId,
				cache_created_at: record.createdAt,
				cache_validated_at: manifest.cache_validated_at,
				cache_schema_version: ACTION_CACHE_SCHEMA_VERSION,
			},
			null,
			2,
		),
		"utf8",
	);

	return { runId, runDir, record: manifest, summary };
}
