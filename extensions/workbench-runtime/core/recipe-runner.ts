/**
 * Workbench Recipe Runner — the single execution service behind both the
 * `workbench_run_recipe` custom tool and the `/q-run` command family.
 *
 * Controlled execution model:
 *   - The model can only request a declared recipe by name + schema-approved
 *     parameters; it can never supply an arbitrary command.
 *   - Commands run as argv arrays with shell=false (no string-built shell
 *     commands, no pipes/redirection).
 *   - cwd, writes and artifacts are containment-checked against the project
 *     root (lexical + symlink-aware) before anything executes.
 *   - Timeout and AbortSignal are forwarded to the process.
 *   - An exit code outside `expected_exit_codes` is a failure.
 *   - Full output lands in the run directory; only truncated summaries go
 *     back to the model. Secrets are redacted from all artifacts.
 *
 * P6-C action cache (opt-in per recipe, disabled by default):
 *   - a cache HIT materializes a NEW full run record
 *     (execution_source: "cache", action_key, reused_from_run_id,
 *     cache_created_at, cache_validated_at, artifact_validation,
 *     evidence_paths) without executing anything
 *   - a MISS executes normally; successful results may be written under the
 *     per-key lock (concurrent same-key runs execute once or wait safely)
 *   - `--no-cache` neither reads nor writes; `--refresh-cache` never reads
 *     but executes and (re)writes on success
 *   - ANY cache machinery failure degrades to normal execution — the cache
 *     never blocks the task and never bypasses gates
 */

import { mkdir, writeFile } from "node:fs/promises";
import { copyFile } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { globSync } from "node:fs";

import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";

import { loadProjectConfig, runsDir, type ExecFn } from "./config.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { realpathContained, lexicalContain } from "./path-guard.ts";
import { buildArgv, RecipeParamError, type Recipe } from "./recipe-schema.ts";
import { collectSecretValues, redactArgvEntry, redactEnvValue, redactText } from "./redact.ts";
import { makeRunId, RUN_SCHEMA_VERSION, type RunRecord, type RunSummaryRecord } from "./runs.ts";
import { EXTENSION_VERSION } from "../cache/cache-types.ts";
import { ActionCacheStore, type LockHandle } from "../cache/action-store.ts";
import { ARTIFACT_RESTORE_ENABLED } from "../cache/action-types.ts";
import { resolveQuantContract } from "../cache/quant-files.ts";
import {
	buildActionRecord,
	computeKey,
	lookupValidated,
	materializeCachedRun,
	planCache,
	shouldCacheRun,
	type ActionCacheContext,
	type CacheRequestMode,
} from "../cache/action-cache.ts";
import type { ActionKey, ActionRecord } from "../cache/action-types.ts";

export interface RunRecipeInput {
	projectRoot: string;
	recipeName: string;
	params?: Record<string, unknown>;
	mode: WorkbenchMode;
	exec: ExecFn;
	signal?: AbortSignal;
	now?: () => Date;
	/** P6-C: cache request mode (default = read/write per recipe policy). */
	cacheMode?: CacheRequestMode;
}

export interface RunRecipeResult {
	ok: boolean;
	error?: string;
	record?: RunRecord;
	summary?: RunSummaryRecord;
	runDir?: string;
	/** P6-C cache facts for the caller (/q-run, tool details). */
	cache?: {
		status:
			| "hit"
			| "miss"
			| "disabled"
			| "refused"
			| "no-cache"
			| "refresh-executed"
			| "write-failed"
			| "artifacts-disabled"
			| "corrupt"
			| "expired";
		actionKey?: string;
		reusedFromRunId?: string;
		reason?: string;
	};
}

export class RecipeSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecipeSetupError";
	}
}

function buildEnvironment(recipe: Recipe): Record<string, string> {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
	for (const name of recipe.environment) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

async function gitState(projectRoot: string, exec: ExecFn): Promise<{ commit: string | null; dirty: boolean }> {
	try {
		const rev = await exec("git", ["rev-parse", "HEAD"], { cwd: projectRoot });
		const commit = rev.code === 0 && rev.stdout.trim().length > 0 ? rev.stdout.trim() : null;
		const status = await exec("git", ["status", "--porcelain"], { cwd: projectRoot });
		const dirty = status.code === 0 && status.stdout.trim().length > 0;
		return { commit, dirty };
	} catch {
		return { commit: null, dirty: false };
	}
}

/** Collect artifact files matching declared globs (project-relative paths). */
async function collectArtifacts(projectRoot: string, globs: readonly string[]): Promise<string[]> {
	const paths = new Set<string>();
	for (const pattern of globs) {
		if (lexicalContain(projectRoot, pattern) === undefined) continue; // validated earlier; skip defensively
		for (const match of globSync(pattern, { cwd: projectRoot })) {
			// glob may return directories for patterns like "dist/**"; keep files only.
			try {
				const { stat } = await import("node:fs/promises");
				if ((await stat(join(projectRoot, match))).isFile()) paths.add(match);
			} catch {
				// vanished between glob and stat
			}
		}
	}
	return [...paths].sort();
}

/**
 * Validate every declared path of the recipe against the project root.
 * Throws RecipeSetupError on the first violation.
 */
export async function validateRecipePaths(projectRoot: string, recipe: Recipe): Promise<void> {
	const cwd = await realpathContained(projectRoot, recipe.cwd);
	if (cwd === undefined) {
		throw new RecipeSetupError(
			`recipe "${recipe.name}" cwd escapes the project root: ${recipe.cwd} (no ../, absolute paths or symlink escapes)`,
		);
	}
	for (const write of recipe.writes) {
		if ((await realpathContained(projectRoot, write)) === undefined) {
			throw new RecipeSetupError(`recipe "${recipe.name}" writes path escapes the project root: ${write}`);
		}
	}
	for (const artifact of recipe.artifacts) {
		if (lexicalContain(projectRoot, artifact) === undefined) {
			throw new RecipeSetupError(`recipe "${recipe.name}" artifacts pattern escapes the project root: ${artifact}`);
		}
	}
}

/**
 * Snapshot declared JSON artifacts into the run directory (P4).
 *
 * Run records must be self-contained evidence: the comparator and quant
 * report only ever read facts that are attributed to a run. Small JSON
 * artifacts (<= 1MB) are copied to `<run-dir>/artifacts/<basename>` so later
 * runs overwriting the same project file can never corrupt earlier records.
 */
const SNAPSHOT_MAX_BYTES = 1024 * 1024;

async function snapshotJsonArtifacts(projectRoot: string, runDir: string, artifactPaths: readonly string[]): Promise<void> {
	const targets: string[] = [];
	const { stat } = await import("node:fs/promises");
	for (const rel of artifactPaths) {
		if (!rel.endsWith(".json")) continue;
		try {
			const info = await stat(join(projectRoot, rel));
			if (info.isFile() && info.size <= SNAPSHOT_MAX_BYTES) targets.push(rel);
		} catch {
			// vanished between collection and snapshot — skip
		}
	}
	if (targets.length === 0) return;
	await mkdir(join(runDir, "artifacts"), { recursive: true });
	for (const rel of targets) {
		try {
			await copyFile(join(projectRoot, rel), join(runDir, "artifacts", basename(rel)));
		} catch {
			// unreadable source — record without a snapshot
		}
	}
}

/**
 * Run one declared recipe end to end and persist all run artifacts.
 * Throws RecipeSetupError for setup violations; execution outcomes (non-zero
 * exit, timeout, cancellation) are reported in the result, not thrown.
 */
export async function runRecipe(input: RunRecipeInput): Promise<RunRecipeResult> {
	const { projectRoot, recipeName, mode, exec } = input;
	const params = input.params ?? {};
	const cacheMode: CacheRequestMode = input.cacheMode ?? "default";
	const now = input.now ?? (() => new Date());
	const startedAt = now();

	const config = await loadProjectConfig(projectRoot, { trusted: true });
	const recipe = config.recipes.find((r) => r.name === recipeName);
	if (!recipe) {
		return { ok: false, error: `recipe "${recipeName}" not found in ${config.issues.length > 0 ? "recipes.yaml (file has config errors)" : "recipes.yaml"}` };
	}
	if (!recipe.allowed_modes.includes(mode)) {
		return {
			ok: false,
			error: `recipe "${recipeName}" is not allowed in ${mode} mode (allowed_modes: ${recipe.allowed_modes.join(", ")})`,
		};
	}

	let argv: string[];
	try {
		argv = buildArgv(recipe, params);
	} catch (error) {
		if (error instanceof RecipeParamError) return { ok: false, error: error.message };
		throw error;
	}

	await validateRecipePaths(projectRoot, recipe);

	// ------------------------------------------------------------ P6-C cache
	const store = new ActionCacheStore(projectRoot, { maxBytes: config.actionCacheMaxBytes, now });
	const cacheCtx: ActionCacheContext = {
		projectRoot,
		recipe,
		policy: recipe.cache,
		argv,
		mode,
		profile: config.profile,
		projectGates: config.gates,
		packageVersion: EXTENSION_VERSION,
		exec,
		store,
		cacheMode,
		now,
	};
	const plan = planCache(cacheCtx);
	let computed = plan.active ? await computeKey(cacheCtx) : null;
	if (computed && !computed.ok) {
		// Cache refused (fingerprint/toolchain/limits) — fall back to normal
		// execution. The refusal reason is surfaced, never blocking.
	}

	// Lookup + validate + materialize a hit; null when not a hit. (const arrow
	// so TS narrowing of `recipe` carries into the closure.)
	const tryHit = async (key: ActionKey): Promise<{ materialized: Awaited<ReturnType<typeof materializeCachedRun>>; record: ActionRecord } | null> => {
		const outcome = await lookupValidated(cacheCtx, key);
		if (outcome.status !== "hit" || !outcome.record) return null;
		const git = await gitState(projectRoot, exec);
		const materialized = await materializeCachedRun({
			projectRoot,
			recipe,
			policy: recipe.cache,
			profile: config.profile,
			key,
			record: outcome.record,
			mode,
			git,
			now,
		});
		return { materialized, record: outcome.record };
	};

	// Fast path: lookup without the lock.
	if (plan.active && computed?.ok && cacheMode !== "refresh-cache") {
		const hit = await tryHit(computed.key);
		if (hit) {
			return {
				ok: hit.record.success,
				record: hit.materialized.record,
				summary: hit.materialized.summary,
				runDir: hit.materialized.runDir,
				cache: {
					status: "hit",
					actionKey: computed.key.key,
					reusedFromRunId: hit.record.sourceRunId,
					reason: "validated against the current action key (definition, inputs, env, toolchain, OS/arch, lockfiles, config, profile, gate schema)",
				},
			};
		}
	}

	// Locked path: execute once per key or wait safely, then write.
	let lock: LockHandle | null = null;
	if (plan.active && computed?.ok) {
		lock = await store.acquireLock(computed.key.key);
		if (lock && cacheMode !== "refresh-cache") {
			// Re-check under the lock: a concurrent run may have finished.
			const hit = await tryHit(computed.key);
			if (hit) {
				await lock.release().catch(() => {});
				return {
					ok: hit.record.success,
					record: hit.materialized.record,
					summary: hit.materialized.summary,
					runDir: hit.materialized.runDir,
					cache: {
						status: "hit",
						actionKey: computed.key.key,
						reusedFromRunId: hit.record.sourceRunId,
						reason: "reused result written by a concurrent run (double-checked lock)",
					},
				};
			}
		}
	}

	// ------------------------------------------------------------------ exec
	const runId = makeRunId(startedAt);
	const runDir = join(runsDir(projectRoot), runId);
	const env = buildEnvironment(recipe);
	const secrets = collectSecretValues(env);

	// Resolve the real cwd (also serves as the containment result).
	const cwd = (await realpathContained(projectRoot, recipe.cwd)) as string;

	const git = await gitState(projectRoot, exec);

	await mkdir(runDir, { recursive: true });

	let result: { stdout: string; stderr: string; code: number; killed: boolean };
	try {
		result = await exec(argv[0] ?? "", argv.slice(1), {
			cwd,
			timeout: recipe.timeout_ms,
			signal: input.signal,
		});
	} catch (error) {
		// Spawn failure: persist what we know so the run is not lost, then
		// surface the error to the caller.
		if (lock) await lock.release().catch(() => {});
		const failedAt = now();
		const redactedArgv = redactText(argv.join("\u0000"), secrets).split("\u0000").map(redactArgvEntry);
		const record: RunRecord = {
			schema_version: RUN_SCHEMA_VERSION,
			run_id: runId,
			recipe: recipe.name,
			profile: config.profile,
			started_at: startedAt.toISOString(),
			finished_at: failedAt.toISOString(),
			duration_ms: Math.max(0, failedAt.getTime() - startedAt.getTime()),
			cwd,
			argv: redactedArgv,
			exit_code: null,
			timed_out: false,
			cancelled: input.signal?.aborted ?? false,
			git_commit: git.commit,
			git_dirty: git.dirty,
			artifact_paths: [],
			stdout_truncated: false,
			stderr_truncated: false,
			mode,
			expected_exit_codes: recipe.expected_exit_codes,
			declared_writes: recipe.writes,
			environment_names: recipe.environment,
		};
		const environmentRecord: Record<string, string> = {};
		for (const [name, value] of Object.entries(env)) {
			environmentRecord[name] = redactEnvValue(name, value);
		}
		await writeFile(join(runDir, "manifest.json"), JSON.stringify(record, null, 2), "utf8");
		await writeFile(join(runDir, "command.json"), JSON.stringify({ recipe: recipe.name, argv: redactedArgv, cwd, error: (error as Error).message }, null, 2), "utf8");
		await writeFile(join(runDir, "environment.json"), JSON.stringify({ environment: environmentRecord }, null, 2), "utf8");
		await writeFile(join(runDir, "stdout.log"), "", "utf8");
		await writeFile(join(runDir, "stderr.log"), "", "utf8");
		await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: runId, recipe: recipe.name, error: (error as Error).message }, null, 2), "utf8");
		throw new Error(`recipe "${recipeName}" failed to spawn: ${(error as Error).message}`);
	}

	const finishedAt = now();
	const cancelled = input.signal?.aborted ?? false;
	const timedOut = result.killed && !cancelled;
	const exitOk = !result.killed && recipe.expected_exit_codes.includes(result.code);

	const stdoutFull = redactText(result.stdout, secrets);
	const stderrFull = redactText(result.stderr, secrets);
	const truncate = recipe.output_strategy === "head" ? truncateHead : truncateTail;
	const truncationOptions = { maxLines: recipe.max_lines, maxBytes: recipe.max_bytes };
	const stdoutView = truncate(stdoutFull, truncationOptions);
	const stderrView = truncate(stderrFull, truncationOptions);

	const artifactPaths = await collectArtifacts(projectRoot, recipe.artifacts);
	await snapshotJsonArtifacts(projectRoot, runDir, artifactPaths);

	const record: RunRecord = {
		schema_version: RUN_SCHEMA_VERSION,
		run_id: runId,
		recipe: recipe.name,
		profile: config.profile,
		started_at: startedAt.toISOString(),
		finished_at: finishedAt.toISOString(),
		duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
		cwd,
		argv: redactText(argv.join("\u0000"), secrets).split("\u0000").map(redactArgvEntry),
		exit_code: result.killed ? null : result.code,
		timed_out: timedOut,
		cancelled,
		git_commit: git.commit,
		git_dirty: git.dirty,
		artifact_paths: artifactPaths,
		stdout_truncated: stdoutView.truncated,
		stderr_truncated: stderrView.truncated,
		mode,
		expected_exit_codes: recipe.expected_exit_codes,
		declared_writes: recipe.writes,
		environment_names: recipe.environment,
		execution_source: "exec",
	};

	const summary: RunSummaryRecord = {
		run_id: runId,
		recipe: recipe.name,
		profile: config.profile,
		started_at: record.started_at,
		finished_at: record.finished_at,
		duration_ms: record.duration_ms,
		cwd,
		argv: record.argv,
		exit_code: record.exit_code,
		timed_out: timedOut,
		cancelled,
		git_commit: git.commit,
		git_dirty: git.dirty,
		artifact_paths: artifactPaths,
		stdout_truncated: stdoutView.truncated,
		stderr_truncated: stderrView.truncated,
		stdout: stdoutView.content,
		stderr: stderrView.content,
		stdout_log: join(runDir, "stdout.log"),
		stderr_log: join(runDir, "stderr.log"),
	};

	const environmentRecord: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		environmentRecord[name] = redactEnvValue(name, value);
	}

	await writeFile(join(runDir, "manifest.json"), JSON.stringify(record, null, 2), "utf8");
	await writeFile(
		join(runDir, "command.json"),
		JSON.stringify(
			{
				recipe: recipe.name,
				argv: record.argv,
				cwd,
				timeout_ms: recipe.timeout_ms,
				output_strategy: recipe.output_strategy,
				max_lines: recipe.max_lines,
				max_bytes: recipe.max_bytes,
				environment: recipe.environment,
			},
			null,
			2,
		),
		"utf8",
	);
	await writeFile(join(runDir, "environment.json"), JSON.stringify({ environment: environmentRecord }, null, 2), "utf8");
	await writeFile(join(runDir, "stdout.log"), stdoutFull, "utf8");
	await writeFile(join(runDir, "stderr.log"), stderrFull, "utf8");
	await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

	// ---------------------------------------------------------- cache write
	let cacheStatus: RunRecipeResult["cache"] = {
		status: cacheMode === "no-cache" ? "no-cache" : !recipe.cache.enabled ? "disabled" : "miss",
		actionKey: computed?.ok ? computed.key.key : undefined,
	};
	if (computed && !computed.ok) {
		cacheStatus = { status: "refused", reason: computed.reason };
	} else if (computed?.ok) {
		const envNames = [...new Set([...recipe.environment, ...recipe.cache.environment])];
		const envForRecord: Record<string, string> = {};
		for (const name of envNames) {
			const value = process.env[name];
			if (value !== undefined) envForRecord[name] = value;
		}
		const facts = {
			runId,
			startedAt,
			finishedAt,
			durationMs: record.duration_ms,
			exitCode: record.exit_code,
			killed: result.killed,
			timedOut,
			cancelled,
			exitOk,
			stdoutView: stdoutView.content,
			stderrView: stderrView.content,
			stdoutTruncated: stdoutView.truncated,
			stderrTruncated: stderrView.truncated,
			artifactPaths,
			env: envForRecord,
			gitCommit: git.commit,
			gitDirty: git.dirty,
		};
		if (shouldCacheRun(recipe.cache, facts)) {
			// P6-D: the quant contract is re-validated AT WRITE TIME — a schema
			// that became invalid (or a logical reference that can no longer
			// resolve) between key computation and write REFUSES the cache.
			let quantWriteBlocked: string | null = null;
			if (recipe.cache.domain === "quant" && recipe.cache.quantContract) {
				const recheck = await resolveQuantContract(projectRoot, recipe.cache.quantContract, { profile: config.profile });
				if (!recheck.ok) quantWriteBlocked = recheck.reason;
			}
			if (quantWriteBlocked) {
				cacheStatus = { status: "refused", actionKey: computed.key.key, reason: `quant contract invalid at write time: ${quantWriteBlocked}` };
			} else {
				const actionRecord = buildActionRecord(cacheCtx, computed.key, facts, computed.inputEntries, computed.quantContractInfo ?? null);
				const written = await store.writeRecord(actionRecord);
				if (!written.ok) {
					cacheStatus = { status: "write-failed", actionKey: computed.key.key, reason: written.error };
				} else if (recipe.cache.mode === "artifacts" && !ARTIFACT_RESTORE_ENABLED) {
					// v1: artifacts restore is disabled — the run always executes and
					// only result metadata is stored.
					cacheStatus = { status: "artifacts-disabled", actionKey: computed.key.key, reason: "artifacts restore disabled — result metadata stored only" };
				} else {
					cacheStatus = { status: cacheMode === "refresh-cache" ? "refresh-executed" : "miss", actionKey: computed.key.key };
				}
			}
		}
	}

	if (lock) await lock.release().catch(() => {});

	return { ok: exitOk, record, summary, runDir, cache: cacheStatus };
}

/** Project-relative form of a path for display (keeps messages portable). */
export function displayRelative(projectRoot: string, absolutePath: string): string {
	const rel = relative(projectRoot, absolutePath);
	return rel.length === 0 || rel.startsWith("..") ? absolutePath : rel;
}
