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
 *
 * WP4 ordinary final-verification reuse (separate from the action cache):
 *   - DEV-only, strict Sol-only, read-only recipes declaring the complete
 *     typecheck + unit-test + whitespace component set are final checks
 *   - a default invocation may reuse the newest strict Sol run only when its
 *     validation binding is REUSABLE for the current Candidate and the exact
 *     requested argv identity still matches
 *   - reuse executes zero subprocesses and creates no duplicate run; explicit
 *     no-cache/refresh-cache requests still execute, and every uncertainty
 *     falls through to a fresh run
 */

import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";

import { loadProjectConfig, type ExecFn } from "./config.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { realpathContained, lexicalContain } from "./path-guard.ts";
import { buildArgv, RecipeParamError, VALIDATION_COMPONENTS, type Recipe } from "./recipe-schema.ts";
import {
	parseWorkerAllowedPaths,
	parseWorkerTaskKindEnvironment,
	recipeMutationBlockReason,
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_CONTRACT_HASH_ENV,
	WORKER_DELEGATION_ID_ENV,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_ROLE,
	WORKER_TASK_KIND_ENV,
	type RecipeMutationFacts,
	type WorkerRecipeMutationScope,
} from "./worker-policy.ts";
import { collectSecretValues, redactArgvEntry, redactEnvValue, redactText } from "./redact.ts";
import {
	latestRunAttemptForRecipe,
	makeRunId,
	readCommittedManifest,
	readSummary,
	runDirFor,
	RUN_MANIFEST_SCHEMA_VERSION_V2,
	type RunRecord,
	type RunSummaryRecord,
} from "./runs.ts";
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
import {
	captureRecipeValidationEvidence,
	executedArgvHash,
	ownerFromActorFacts,
	unavailableEvidenceBlock,
	validationEvidenceSourceEligible,
	type ValidationEvidenceBlock,
} from "./validation-evidence.ts";
import { assessRunValidation } from "./validation-assessment.ts";
import {
	collectRecipeArtifactsV2,
	readArtifactManifestV2,
	writeArtifactManifestV2,
} from "./artifact-contract.ts";
import {
	currentRunRuntimeIdentityV1,
	ordinaryCandidateProjectionFromRunV1,
	runRuntimeIdentityIsCurrentV1,
} from "./candidate-identity.ts";
import { beginRunTransaction, commitRunTransaction } from "./run-transaction.ts";
import { isWorkerPathAllowedRealpath } from "../worker/path-scope.ts";
import {
	COMMAND_EFFECT_FILE,
	beginRecipeCommandEffectCapture,
	buildRecipeCommandEffectRecord,
	commandEffectBlockingReason,
	completeRecipeCommandEffectCapture,
	recipeCommandEffectPreCaptureError,
	type CommandEffectRecord,
	type RecipeCommandEffectCaptureStart,
} from "./command-effect.ts";

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
	/**
	 * P7: actor facts for the shared recipe mutation policy (strict Sol /
	 * delegated worker / other controller). Omitted callers keep prior
	 * behavior (no mutation restriction).
	 */
	actorFacts?: RecipeMutationFacts;
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
	/** Durable command-effect evidence for an actual Workbench/worker exec. */
	commandEffect?: Readonly<CommandEffectRecord>;
	warnings?: string[];
	/** WP4: an unchanged final Candidate reused strict current validation without execution. */
	validationReuse?: {
		status: "REUSED_CURRENT_CANDIDATE";
		sourceRunId: string;
		validationIdentity: string;
		executionSkipped: true;
	};
	/** WP4 stable DEV Candidate backed by complete current final verification. */
	ordinaryCandidate?: {
		schemaVersion: 1;
		status: "VERIFIED";
		candidateIdentity: string;
		validationIdentity: string;
		artifactManifestIdentity: string;
		runtimeIdentityHash: string;
		sourceRunId: string;
		authorityScope: "DEVELOPMENT_ONLY";
	};
}

export class RecipeSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecipeSetupError";
	}
}

class RecipeCommandEffectPreCaptureError extends Error {
	constructor(readonly record: Readonly<CommandEffectRecord>) {
		super("command-effect evidence is unavailable before process start");
		this.name = "RecipeCommandEffectPreCaptureError";
	}
}

/** Complete ordinary final-check declaration; focused recipes never qualify. */
export function isOrdinaryFinalVerificationRecipeV1(recipe: Recipe): boolean {
	return recipe.mutation === "none" && recipe.writes.length === 0 &&
		recipe.validation_components.length === VALIDATION_COMPONENTS.length &&
		VALIDATION_COMPONENTS.every((component) => recipe.validation_components.includes(component));
}

function summaryMatchesCommittedRecordV1(summary: RunSummaryRecord, record: RunRecord): boolean {
	return summary.run_id === record.run_id && summary.recipe === record.recipe &&
		summary.profile === record.profile &&
		summary.started_at === record.started_at && summary.finished_at === record.finished_at &&
		summary.duration_ms === record.duration_ms && summary.cwd === record.cwd &&
		summary.exit_code === record.exit_code && summary.timed_out === record.timed_out &&
		summary.cancelled === record.cancelled && summary.git_commit === record.git_commit &&
		summary.git_dirty === record.git_dirty &&
		JSON.stringify(summary.argv) === JSON.stringify(record.argv) &&
		JSON.stringify(summary.artifact_paths) === JSON.stringify(record.artifact_paths) &&
		summary.stdout_truncated === record.stdout_truncated &&
		summary.stderr_truncated === record.stderr_truncated &&
		summary.command_effect_status === record.command_effect_status;
}

async function currentOrdinaryCandidateAfterRunV1(input: {
	projectRoot: string;
	mode: WorkbenchMode;
	exec: ExecFn;
	recipe: Recipe;
	argv: readonly string[];
	record: RunRecord;
	actorFacts?: RecipeMutationFacts;
}): Promise<RunRecipeResult["ordinaryCandidate"]> {
	if (input.mode !== "DEV" || ownerFromActorFacts(input.actorFacts) !== "sol" ||
		!isOrdinaryFinalVerificationRecipeV1(input.recipe) ||
		!runRuntimeIdentityIsCurrentV1(input.record.runtime_identity)) return undefined;
	const argvHash = executedArgvHash(input.argv);
	if (!validationEvidenceSourceEligible(input.record.validation_evidence, {
		recipe: input.recipe.name,
		argvHash,
	})) return undefined;
	const assessment = await assessRunValidation({
		projectRoot: input.projectRoot,
		mode: input.mode,
		exec: input.exec,
		manifest: input.record,
		actorFacts: input.actorFacts,
	});
	if (assessment.status !== "REUSABLE") return undefined;
	const artifactManifest = await readArtifactManifestV2(runDirFor(input.projectRoot, input.record.run_id), input.record.run_id);
	return artifactManifest === null ? undefined : ordinaryCandidateProjectionFromRunV1(input.record, artifactManifest);
}

async function reuseCurrentOrdinaryFinalVerificationV1(input: {
	projectRoot: string;
	mode: WorkbenchMode;
	exec: ExecFn;
	recipe: Recipe;
	argv: readonly string[];
	actorFacts?: RecipeMutationFacts;
	requestedCacheMode: CacheRequestMode;
}): Promise<RunRecipeResult | undefined> {
	if (input.mode !== "DEV" || input.requestedCacheMode !== "default" ||
		ownerFromActorFacts(input.actorFacts) !== "sol" ||
		!isOrdinaryFinalVerificationRecipeV1(input.recipe)) return undefined;
	const latest = await latestRunAttemptForRecipe(input.projectRoot, input.recipe.name);
	if (latest.state !== "FOUND") return undefined;
	if (!runRuntimeIdentityIsCurrentV1(latest.manifest.runtime_identity)) return undefined;
	const argvHash = executedArgvHash(input.argv);
	if (!validationEvidenceSourceEligible(latest.manifest.validation_evidence, {
		recipe: input.recipe.name,
		argvHash,
	})) return undefined;
	const assessment = await assessRunValidation({
		projectRoot: input.projectRoot,
		mode: input.mode,
		exec: input.exec,
		manifest: latest.manifest,
		actorFacts: input.actorFacts,
	});
	if (assessment.status !== "REUSABLE") return undefined;
	const summary = await readSummary(input.projectRoot, latest.run_id);
	const committed = summary === null ? null : await readCommittedManifest(input.projectRoot, latest.run_id);
	const artifactManifest = committed === null ? null : await readArtifactManifestV2(runDirFor(input.projectRoot, latest.run_id), latest.run_id);
	const ordinaryCandidate = committed === null || artifactManifest === null
		? undefined
		: ordinaryCandidateProjectionFromRunV1(committed, artifactManifest);
	if (summary === null || committed === null || ordinaryCandidate === undefined ||
		!summaryMatchesCommittedRecordV1(summary, committed) ||
		!validationEvidenceSourceEligible(committed.validation_evidence, {
			recipe: input.recipe.name,
			argvHash,
		})) return undefined;
	// Re-collect the current Candidate after the committed source and summary
	// have both been re-opened. This closes the useful assessment/read window:
	// a concurrent Candidate change cannot inherit the earlier verdict.
	const finalAssessment = await assessRunValidation({
		projectRoot: input.projectRoot,
		mode: input.mode,
		exec: input.exec,
		manifest: committed,
		actorFacts: input.actorFacts,
	});
	if (finalAssessment.status !== "REUSABLE") return undefined;
	return {
		ok: true,
		record: committed,
		summary,
		runDir: runDirFor(input.projectRoot, latest.run_id),
		validationReuse: {
			status: "REUSED_CURRENT_CANDIDATE",
			sourceRunId: latest.run_id,
			validationIdentity: ordinaryCandidate.validationIdentity,
			executionSkipped: true,
		},
		ordinaryCandidate,
	};
}

const PYTHON_BYTECODE_ENV = "PYTHONDONTWRITEBYTECODE" as const;

function buildEnvironment(recipe: Recipe): Record<string, string> {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "", [PYTHON_BYTECODE_ENV]: "1" };
	for (const name of recipe.environment) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

const COMMAND_EFFECT_DELEGATION_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/u;
const COMMAND_EFFECT_HASH_RE = /^[0-9a-f]{64}$/u;

type CommandEffectActorResolution =
	| {
		ok: true;
		actor: {
			actor: "workbench" | "worker";
			worker_delegation_id: string | null;
			worker_contract_hash: string | null;
		};
		workerScope?: WorkerRecipeMutationScope;
	}
	| { ok: false; error: string };

function commandEffectActor(facts: RecipeMutationFacts, projectRoot: string): CommandEffectActorResolution {
	if (facts.role !== WORKER_ROLE) {
		return { ok: true, actor: { actor: "workbench", worker_delegation_id: null, worker_contract_hash: null } };
	}
	const delegationId = process.env[WORKER_DELEGATION_ID_ENV];
	const contractHash = process.env[WORKER_CONTRACT_HASH_ENV];
	if (delegationId === undefined || !COMMAND_EFFECT_DELEGATION_ID_RE.test(delegationId)
		|| contractHash === undefined || !COMMAND_EFFECT_HASH_RE.test(contractHash)) {
		return { ok: false, error: "WORKER_COMMAND_EFFECT_IDENTITY_INVALID" };
	}
	const declaredRoot = process.env[WORKER_PROJECT_ROOT_ENV];
	if (declaredRoot !== undefined && resolve(declaredRoot) !== resolve(projectRoot)) {
		return { ok: false, error: "WORKER_COMMAND_EFFECT_PROJECT_ROOT_MISMATCH" };
	}
	return {
		ok: true,
		actor: {
			actor: "worker",
			worker_delegation_id: delegationId,
			worker_contract_hash: contractHash,
		},
		workerScope: {
			projectRoot,
			allowedPaths: parseWorkerAllowedPaths(process.env[WORKER_ALLOWED_PATHS_ENV]),
			taskKind: parseWorkerTaskKindEnvironment(process.env[WORKER_TASK_KIND_ENV]),
		},
	};
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
 * P4a: capture the recipe validation binding for a terminal run and patch
 * BOTH the in-memory record and the persisted manifest. NEVER masks the
 * original recipe/cache outcome:
 *   - a capture failure persists a bounded non-reusable unavailable block;
 *   - if even that patch write fails, the persisted manifest stays exactly
 *     as it was (original record without validation_evidence) and the
 *     ORIGINAL record is returned — the returned and persisted records can
 *     never disagree by claiming a binding that was not actually persisted.
 * This function never throws.
 */
export async function captureAndPatchRunManifest(input: {
	projectRoot: string;
	runDir: string;
	record: RunRecord;
	profile: string | undefined;
	mode: WorkbenchMode;
	exec: ExecFn;
	recipe: Recipe;
	argv?: string[];
	argvHash?: string;
	projectGates: readonly unknown[];
	actorFacts?: RecipeMutationFacts;
	successful: boolean;
	complete: boolean;
	source: "exec" | "cache";
}): Promise<RunRecord> {
	const captured = await captureRecipeValidationEvidence({
		projectRoot: input.projectRoot,
		profile: input.profile,
		mode: input.mode,
		exec: input.exec,
		recipe: input.recipe,
		argv: input.argv,
		argvHash: input.argvHash,
		projectGates: input.projectGates,
		actorFacts: input.actorFacts,
		successful: input.successful,
		complete: input.complete,
		source: input.source,
	});
	const block: ValidationEvidenceBlock = captured.ok ? captured.block : unavailableEvidenceBlock(captured.reason);
	const patched: RunRecord = { ...input.record, validation_evidence: block };
	try {
		await writeFile(join(input.runDir, "manifest.json"), JSON.stringify(patched, null, 2), "utf8");
	} catch {
		// The manifest patch could not be persisted: return the ORIGINAL
		// record so returned and persisted records agree (both without the
		// block) — the original outcome is never altered or masked.
		return input.record;
	}
	return patched;
}

/**
 * Run one declared recipe end to end and persist all run artifacts.
 * Throws RecipeSetupError for setup violations; execution outcomes (non-zero
 * exit, timeout, cancellation) are reported in the result, not thrown.
 */
export async function runRecipe(input: RunRecipeInput): Promise<RunRecipeResult> {
	const { projectRoot, recipeName, mode, exec } = input;
	const params = input.params ?? {};
	const requestedCacheMode: CacheRequestMode = input.cacheMode ?? "default";
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

	// P7: the shared mutation-policy decision applies to DIRECT recipe
	// execution (workbench_run_recipe tool and /q-run). Strict Sol is denied
	// mutation: source; delegated implementation workers may run only exact,
	// in-scope mutating declarations; other controllers and fact-less callers
	// are unrestricted (prior behavior).
	const actorResolution = input.actorFacts === undefined ? undefined : commandEffectActor(input.actorFacts, projectRoot);
	if (actorResolution?.ok === false) return { ok: false, error: actorResolution.error };
	const mutationBlock = recipeMutationBlockReason(
		input.actorFacts,
		recipe.name,
		recipe.mutation,
		recipe.writes,
		actorResolution?.workerScope,
	);
	if (mutationBlock) {
		return { ok: false, error: mutationBlock };
	}
	// A mutating worker command always executes under a fresh before/after
	// command-effect capture. It may never bypass provenance through cache.
	const cacheMode: CacheRequestMode = actorResolution?.actor.actor === "worker" && recipe.mutation !== "none"
		? "no-cache"
		: requestedCacheMode;

	let argv: string[];
	try {
		argv = buildArgv(recipe, params);
	} catch (error) {
		if (error instanceof RecipeParamError) return { ok: false, error: error.message };
		throw error;
	}

	await validateRecipePaths(projectRoot, recipe);
	if (actorResolution?.actor.actor === "worker" && recipe.mutation !== "none") {
		const allowedPaths = actorResolution.workerScope?.allowedPaths ?? [];
		for (const output of recipe.writes) {
			if (!(await isWorkerPathAllowedRealpath(projectRoot, output, allowedPaths))) {
				return {
					ok: false,
					error: `Delegated worker cannot run mutating recipe "${recipe.name}": writes output resolves outside delegation allowed_paths: ${output}`,
				};
			}
		}
	}

	const reusedFinalVerification = await reuseCurrentOrdinaryFinalVerificationV1({
		projectRoot,
		mode,
		exec,
		recipe,
		argv,
		actorFacts: input.actorFacts,
		requestedCacheMode,
	});
	if (reusedFinalVerification !== undefined) return reusedFinalVerification;

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
		try {
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
				authorizedExternalRoots: config.artifactExternalRoots,
				exec,
				runtimeIdentity: currentRunRuntimeIdentityV1(),
			});
			return { materialized, record: outcome.record };
		} catch {
			// A cache hit that cannot produce a complete v2 run transaction is
			// not a hit. Execute normally; partial staging is never consumable.
			return null;
		}
	};

	// P4a: patch the materialized cache-hit run with its validation binding
	// (source "cache", outcome from the reused action record) on BOTH hit
	// paths — the materialized manifest was written by action-cache.ts and is
	// patched here so the persisted and returned records stay consistent.
	const hitResult = async (hit: NonNullable<Awaited<ReturnType<typeof tryHit>>>, actionKey: string, reason: string): Promise<RunRecipeResult> => {
		const patched = await captureAndPatchRunManifest({
			projectRoot,
			runDir: hit.materialized.stagingDir,
			record: hit.materialized.record,
			profile: config.profile,
			mode,
			exec,
			recipe,
			argv: [],
			argvHash: hit.materialized.record.argv_hash,
			projectGates: config.gates,
			actorFacts: input.actorFacts,
			successful: hit.record.success,
			complete: true,
			source: "cache",
		});
		try {
			await commitRunTransaction(
				{ runId: hit.materialized.runId, stagingDir: hit.materialized.stagingDir, finalDir: hit.materialized.runDir },
				new Date(hit.materialized.record.finished_at),
			);
		} catch {
			return { ok: false, error: "RUN_RECORD_COMMIT_FAILED" };
		}
		const ordinaryCandidate = await currentOrdinaryCandidateAfterRunV1({
			projectRoot,
			mode,
			exec,
			recipe,
			argv,
			record: patched,
			actorFacts: input.actorFacts,
		});
		return {
			ok: hit.record.success,
			record: patched,
			summary: hit.materialized.summary,
			runDir: hit.materialized.runDir,
			cache: {
				status: "hit",
				actionKey,
				reusedFromRunId: hit.record.sourceRunId,
				reason,
			},
			...(ordinaryCandidate === undefined ? {} : { ordinaryCandidate }),
		};
	};

	// Fast path: lookup without the lock.
	if (plan.active && computed?.ok && cacheMode !== "refresh-cache") {
		const hit = await tryHit(computed.key);
		if (hit) {
			return hitResult(
				hit,
				computed.key.key,
				"validated against the current action key (definition, inputs, env, toolchain, OS/arch, lockfiles, config, profile, gate schema)",
			);
		}
	}

	// Locked path: execute once per key or wait safely, then write.
	let lock: LockHandle | null = null;
	if (plan.active && computed?.ok) {
		lock = await store.acquireLock(computed.key.key);
	}
	try {
		if (lock && computed?.ok && cacheMode !== "refresh-cache") {
			// Re-check under the lock: a concurrent run may have finished.
			const hit = await tryHit(computed.key);
			if (hit) {
				return hitResult(hit, computed.key.key, "reused result written by a concurrent run (double-checked lock)");
			}
		}

	// ------------------------------------------------------------------ exec
	const runId = makeRunId(startedAt);
	let transaction;
	try {
		transaction = await beginRunTransaction(projectRoot, runId);
	} catch (error) {
		return { ok: false, error: `RUN_RECORD_COMMIT_FAILED: ${(error as Error).message}` };
	}
	const runDir = transaction.finalDir;
	const writeDir = transaction.stagingDir;
	const env = buildEnvironment(recipe);
	const secrets = collectSecretValues(env);

	// P4a: deterministic, privacy-safe identity of the EXECUTED argv — raw
	// values are hashed, never persisted (manifest argv stays redacted).
	const executedArgvHashValue = executedArgvHash(argv);

	// Resolve the real cwd (also serves as the containment result).
	const cwd = (await realpathContained(projectRoot, recipe.cwd)) as string;

	const git = await gitState(projectRoot, exec);
	let commandEffectStarted: Readonly<RecipeCommandEffectCaptureStart> | undefined;
	let commandEffectActorFacts: Extract<CommandEffectActorResolution, { ok: true }>["actor"] | undefined;
	if (actorResolution !== undefined && actorResolution.ok) {
		commandEffectActorFacts = actorResolution.actor;
		commandEffectStarted = await beginRecipeCommandEffectCapture({
			project_root: projectRoot,
			exec,
			declared_writes: recipe.writes,
		});
	}

	let result: { stdout: string; stderr: string; code: number; killed: boolean };
	try {
		if (commandEffectStarted !== undefined && commandEffectActorFacts !== undefined
			&& recipeCommandEffectPreCaptureError(commandEffectStarted) !== undefined) {
			throw new RecipeCommandEffectPreCaptureError(buildRecipeCommandEffectRecord({
				run_id: runId,
				recipe: recipe.name,
				...commandEffectActorFacts,
				mutation_declaration: recipe.mutation,
				declared_writes: recipe.writes,
				before_guard: commandEffectStarted.before_guard,
				after_guard: commandEffectStarted.before_guard,
				before_exact_output_evidence: commandEffectStarted.before_exact_output_evidence,
				after_exact_output_evidence: commandEffectStarted.before_exact_output_evidence,
			}));
		}
		// Pi's exec surface intentionally has no arbitrary env option. Use the
		// POSIX env launcher for this one deterministic runtime setting so Python
		// verification cannot create __pycache__ dirt that is later mistaken for
		// worker-owned source drift.
		const environmentArguments = Object.entries(env)
			.sort(([left], [right]) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")))
			.map(([name, value]) => `${name}=${value}`);
		result = await exec("env", ["-i", ...environmentArguments, argv[0] ?? "", ...argv.slice(1)], {
			cwd,
			timeout: recipe.timeout_ms,
			signal: input.signal,
		});
	} catch (error) {
		// Spawn failure: persist what we know so the run is not lost, then
		// surface the error to the caller.
		const failedAt = now();
		const preCaptureFailure = error instanceof RecipeCommandEffectPreCaptureError;
		const commandEffect = preCaptureFailure
			? error.record
			: commandEffectStarted === undefined || commandEffectActorFacts === undefined
			? undefined
			: await completeRecipeCommandEffectCapture({
				project_root: projectRoot,
				exec,
				run_id: runId,
				recipe: recipe.name,
				...commandEffectActorFacts,
				mutation_declaration: recipe.mutation,
				declared_writes: recipe.writes,
				started: commandEffectStarted,
			});
		const redactedArgv = redactText(argv.join("\u0000"), secrets).split("\u0000").map(redactArgvEntry);
		const record: RunRecord = {
			schema_version: RUN_MANIFEST_SCHEMA_VERSION_V2,
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
			validation_components: recipe.validation_components,
			cache_request_mode: cacheMode,
			runtime_identity: currentRunRuntimeIdentityV1(),
			argv_hash: executedArgvHashValue,
			run_transaction_schema_version: 2,
			// The subprocess did not start. The existing closed manifest schema
			// represents that honestly as PROCESS_FAILED while the bound
			// command-effect receipt carries EVIDENCE_UNAVAILABLE.
			run_outcome: "PROCESS_FAILED",
			artifact_manifest_path: "artifact-manifest.json",
			...(commandEffect === undefined ? {} : {
				command_effect_path: COMMAND_EFFECT_FILE,
				command_effect_hash: commandEffect.command_effect_hash,
				command_effect_status: commandEffect.status,
			}),
		};
		const environmentRecord: Record<string, string> = {};
		for (const [name, value] of Object.entries(env)) {
			environmentRecord[name] = redactEnvValue(name, value);
		}
		const artifactCollection = await collectRecipeArtifactsV2({ projectRoot, runId, stagingRunDir: writeDir, contracts: recipe.artifact_contracts, authorizedExternalRoots: config.artifactExternalRoots, exec });
		await writeArtifactManifestV2(writeDir, artifactCollection.manifest);
		if (commandEffect !== undefined) {
			await writeFile(join(writeDir, COMMAND_EFFECT_FILE), JSON.stringify(commandEffect, null, 2), "utf8");
		}
		await writeFile(join(writeDir, "manifest.json"), JSON.stringify(record, null, 2), "utf8");
		await writeFile(join(writeDir, "command.json"), JSON.stringify({ recipe: recipe.name, argv: redactedArgv, cwd, error: (error as Error).message }, null, 2), "utf8");
		await writeFile(join(writeDir, "environment.json"), JSON.stringify({ environment: environmentRecord }, null, 2), "utf8");
		await writeFile(join(writeDir, "stdout.log"), "", "utf8");
		await writeFile(join(writeDir, "stderr.log"), "", "utf8");
		const failureCode = preCaptureFailure ? "COMMAND_EFFECT_EVIDENCE_UNAVAILABLE" : "PROCESS_FAILED";
		const failedSummary: RunSummaryRecord = {
			run_id: runId,
			recipe: recipe.name,
			profile: config.profile,
			started_at: record.started_at,
			finished_at: record.finished_at,
			duration_ms: record.duration_ms,
			cwd,
			argv: redactedArgv,
			exit_code: null,
			timed_out: false,
			cancelled: input.signal?.aborted ?? false,
			git_commit: git.commit,
			git_dirty: git.dirty,
			artifact_paths: artifactCollection.artifactPaths,
			stdout_truncated: false,
			stderr_truncated: false,
			stdout: "",
			stderr: "",
			stdout_log: join(runDir, "stdout.log"),
			stderr_log: join(runDir, "stderr.log"),
			...(commandEffect === undefined ? {} : {
				command_effect_status: commandEffect.status,
				command_effect_path: join(runDir, COMMAND_EFFECT_FILE),
			}),
		};
		await writeFile(join(writeDir, "summary.json"), JSON.stringify(failedSummary, null, 2), "utf8");
		// P4a: capture the validation binding for the spawn-failure terminal
		// path too (outcome: unsuccessful + incomplete). A capture failure
		// persists bounded unavailable state; the original spawn error always
		// surfaces — the patch must never mask it.
		let finalizedFailureRecord = record;
		try {
			finalizedFailureRecord = await captureAndPatchRunManifest({
				projectRoot,
				runDir: writeDir,
				record,
				profile: config.profile,
				mode,
				exec,
				recipe,
				argv,
				argvHash: executedArgvHashValue,
				projectGates: config.gates,
				actorFacts: input.actorFacts,
				successful: false,
				complete: false,
				source: "exec",
			});
		} catch {
			// never mask the spawn failure with a manifest-patch error
		}
		try {
			await commitRunTransaction(transaction, failedAt);
		} catch {
			if (preCaptureFailure) return { ok: false, error: "RUN_RECORD_COMMIT_FAILED" };
			throw new Error(`recipe "${recipeName}" failed to spawn and RUN_RECORD_COMMIT_FAILED`);
		}
		if (preCaptureFailure) {
			return {
				ok: false,
				error: failureCode,
				record: finalizedFailureRecord,
				summary: failedSummary,
				runDir,
				cache: { status: "no-cache", reason: "process start refused because command-effect before evidence is unavailable" },
				commandEffect: error.record,
				warnings: ["COMMAND_EFFECT_EVIDENCE_UNAVAILABLE"],
			};
		}
		throw new Error(`recipe "${recipeName}" failed to spawn: ${(error as Error).message}`);
	}

	const finishedAt = now();
	const cancelled = input.signal?.aborted ?? false;
	const timedOut = result.killed && !cancelled;
	const exitOk = !result.killed && recipe.expected_exit_codes.includes(result.code);
	const commandEffect = commandEffectStarted === undefined || commandEffectActorFacts === undefined
		? undefined
		: await completeRecipeCommandEffectCapture({
			project_root: projectRoot,
			exec,
			run_id: runId,
			recipe: recipe.name,
			...commandEffectActorFacts,
			mutation_declaration: recipe.mutation,
			declared_writes: recipe.writes,
			started: commandEffectStarted,
		});
	const commandEffectFailure = commandEffect === undefined ? undefined : commandEffectBlockingReason(commandEffect);
	const commandEffectWarnings = commandEffect?.status === "EVIDENCE_UNAVAILABLE"
		? ["COMMAND_EFFECT_EVIDENCE_UNAVAILABLE"]
		: undefined;

	const stdoutFull = redactText(result.stdout, secrets);
	const stderrFull = redactText(result.stderr, secrets);
	const truncate = recipe.output_strategy === "head" ? truncateHead : truncateTail;
	const truncationOptions = { maxLines: recipe.max_lines, maxBytes: recipe.max_bytes };
	const stdoutView = truncate(stdoutFull, truncationOptions);
	const stderrView = truncate(stderrFull, truncationOptions);

	const artifactCollection = await collectRecipeArtifactsV2({
		projectRoot,
		runId,
		stagingRunDir: writeDir,
		contracts: recipe.artifact_contracts,
		authorizedExternalRoots: config.artifactExternalRoots,
		exec,
	});
	const artifactPaths = artifactCollection.artifactPaths;
	const runOk = exitOk && artifactCollection.ok && commandEffectFailure === undefined;

	const record: RunRecord = {
		schema_version: RUN_MANIFEST_SCHEMA_VERSION_V2,
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
		validation_components: recipe.validation_components,
		cache_request_mode: cacheMode,
		runtime_identity: currentRunRuntimeIdentityV1(),
		execution_source: "exec",
		argv_hash: executedArgvHashValue,
		run_transaction_schema_version: 2,
		run_outcome: !exitOk
			? "PROCESS_FAILED"
			: !artifactCollection.ok
				? "ARTIFACT_FAILED"
				: commandEffectFailure === undefined ? "SUCCESS" : "COMMAND_EFFECT_FAILED",
		artifact_manifest_path: "artifact-manifest.json",
		...(commandEffect === undefined ? {} : {
			command_effect_path: COMMAND_EFFECT_FILE,
			command_effect_hash: commandEffect.command_effect_hash,
			command_effect_status: commandEffect.status,
		}),
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
		...(commandEffect === undefined ? {} : {
			command_effect_status: commandEffect.status,
			command_effect_path: join(runDir, COMMAND_EFFECT_FILE),
		}),
	};

	const environmentRecord: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		environmentRecord[name] = redactEnvValue(name, value);
	}

	await writeArtifactManifestV2(writeDir, artifactCollection.manifest);
	if (commandEffect !== undefined) {
		await writeFile(join(writeDir, COMMAND_EFFECT_FILE), JSON.stringify(commandEffect, null, 2), "utf8");
	}
	await writeFile(join(writeDir, "manifest.json"), JSON.stringify(record, null, 2), "utf8");
	await writeFile(
		join(writeDir, "command.json"),
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
	await writeFile(join(writeDir, "environment.json"), JSON.stringify({ environment: environmentRecord }, null, 2), "utf8");
	await writeFile(join(writeDir, "stdout.log"), stdoutFull, "utf8");
	await writeFile(join(writeDir, "stderr.log"), stderrFull, "utf8");
	await writeFile(join(writeDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

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
		if (runOk && shouldCacheRun(recipe.cache, facts)) {
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

	// P4a: capture the validation binding for the exec terminal path and
	// patch the persisted + returned manifest (never alters the outcome).
	const patched = await captureAndPatchRunManifest({
		projectRoot,
		runDir: writeDir,
		record,
		profile: config.profile,
		mode,
		exec,
		recipe,
		argv,
		argvHash: executedArgvHashValue,
		projectGates: config.gates,
		actorFacts: input.actorFacts,
		successful: runOk,
		complete: !result.killed,
		source: "exec",
	});
	try {
		await commitRunTransaction(transaction, finishedAt);
	} catch {
		return {
			ok: false,
			error: "RUN_RECORD_COMMIT_FAILED",
			record: patched,
			summary,
			cache: cacheStatus,
			...(commandEffect === undefined ? {} : { commandEffect }),
			...(commandEffectWarnings === undefined ? {} : { warnings: commandEffectWarnings }),
		};
	}
	const ordinaryCandidate = runOk
		? await currentOrdinaryCandidateAfterRunV1({
			projectRoot,
			mode,
			exec,
			recipe,
			argv,
			record: patched,
			actorFacts: input.actorFacts,
		})
		: undefined;

	return {
		ok: runOk,
		error: commandEffectFailure ?? (artifactCollection.ok ? undefined : artifactCollection.code),
		record: patched,
		summary,
		runDir,
		cache: cacheStatus,
		...(ordinaryCandidate === undefined ? {} : { ordinaryCandidate }),
		...(commandEffect === undefined ? {} : { commandEffect }),
		...(commandEffectWarnings === undefined ? {} : { warnings: commandEffectWarnings }),
	};
	} finally {
		if (lock) await lock.release().catch(() => {});
	}
}

/** Project-relative form of a path for display (keeps messages portable). */
export function displayRelative(projectRoot: string, absolutePath: string): string {
	const rel = relative(projectRoot, absolutePath);
	return rel.length === 0 || rel.startsWith("..") ? absolutePath : rel;
}
