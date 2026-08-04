/**
 * Workbench Gate Engine — runs the validation ladder and persists gate runs.
 *
 * A gate run writes `<project-root>/.pi/workbench/runs/<run-id>/`:
 *   manifest.json, gates.json, evidence.json, summary.json, stdout.log,
 *   stderr.log, artifacts/ (copied evidence sources)
 *
 * Status model (spec §3): PASS | FAIL | BLOCKED | NOT_RUN.
 *   - a required check that is NOT_RUN can never make a gate PASS
 *   - a non-PASS outcome of a blocking prerequisite BLOCKs dependents
 *     (prerequisite status resolves from the current run first, then from
 *     the most recent persisted gate run, then NOT_RUN)
 *   - warnings never upgrade a status; a check with no verified assertion
 *     is NOT_RUN or FAIL, never PASS
 *   - numeric constraints are only evaluated against structured artifacts
 *   - manual evidence is only ever recorded with type "manual" — model
 *     prose can never masquerade as machine verification
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { globSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";

import { loadProjectConfig, runsDir, type ConfigIssue, type ExecFn } from "./config.ts";
import { GATE_CATALOG } from "./gate-catalog.ts";
import {
	effectiveGates,
	orderGates,
	parseGatesDocument,
	resolveSelector,
	type Gate,
	type GateCheck,
	type GateStatus,
	type WorkerFirstCheckName,
	type WorkerFirstGateFacts,
	WORKER_FIRST_CHECK_NAMES,
	QUANT_GATE_ID_RE,
} from "./gate-schema.ts";
import { validateQuantResult } from "./quant-result.ts";
import { validateQuantContract } from "../cache/quant-contracts.ts";
import { realpathContained } from "./path-guard.ts";
import { runRecipe } from "./recipe-runner.ts";
import type { Recipe } from "./recipe-schema.ts";
import { recipeMutationBlockReason, type RecipeMutationFacts } from "./worker-policy.ts";
import { listRuns, makeRunId, readManifest, RUN_SCHEMA_VERSION } from "./runs.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { truncateTail } from "@earendil-works/pi-coding-agent";

export const GATE_SCHEMA_VERSION = 1;

export class GateSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GateSetupError";
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvidenceEntry {
	type: "config" | "recipe_run" | "artifact" | "file" | "json" | "numeric" | "manual" | "schema" | "worker_first";
	source?: string;
	detail: string;
	run_id?: string;
	recipe?: string;
	exit_code?: number | null;
	/** P6-C: "exec" (executed) or "cache" (reused from the action cache). */
	execution_source?: string;
	value?: unknown;
	paths?: string[];
	check_id?: string;
	provided_by?: string;
	errors?: string[];
	warnings?: string[];
	artifact_path?: string;
}

export interface CheckRunEntry {
	check_id: string;
	gate_id: string;
	status: GateStatus;
	kind: string;
	required: boolean;
	blocking: boolean;
	evidence: EvidenceEntry[];
	failure_reason: string | null;
	blocked_reason: string | null;
	warnings: string[];
	started_at: string;
	finished_at: string;
	duration_ms: number;
}

export interface GateRunEntry {
	id: string;
	title: string;
	description: string;
	status: GateStatus;
	required: boolean;
	blocking: boolean;
	prerequisites: string[];
	prerequisite_status: Record<string, { status: GateStatus; source: string }>;
	checks: CheckRunEntry[];
	failure_reason: string | null;
	blocked_reason: string | null;
	warnings: string[];
	evidence_paths: string[];
	declared_evidence: string[];
	started_at: string;
	finished_at: string;
	duration_ms: number;
}

export interface RunGatesInput {
	projectRoot: string;
	selector: string;
	mode: WorkbenchMode;
	exec: ExecFn;
	signal?: AbortSignal;
	now?: () => Date;
	manualEvidence?: Record<string, string>;
	/**
	 * P7: bounded worker-first compliance facts injected by the runtime.
	 * Missing facts make every worker-first check NOT_RUN (never PASS).
	 */
	workerFirstFacts?: WorkerFirstGateFacts;
	/** P7: actor facts for the shared recipe mutation policy in recipe checks. */
	actorFacts?: RecipeMutationFacts;
}

export interface RunGatesResult {
	ok: boolean;
	status: GateStatus;
	runId: string;
	runDir: string;
	gates: GateRunEntry[];
	requested: string[];
	profile: string | undefined;
}

export interface GateFileRecord {
	schema_version: number;
	run_id: string;
	requested: string[];
	profile: string | undefined;
	mode: string;
	gates: GateRunEntry[];
}

// ---------------------------------------------------------------------------
// Gate loading (catalog + gates.yaml)
// ---------------------------------------------------------------------------

async function readGatesYaml(projectRoot: string): Promise<{ doc: unknown; errors: string[] }> {
	const path = join(projectRoot, CONFIG_DIR_NAME, "workbench", "gates.yaml");
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch {
		// Missing gates.yaml means "no project gates" — the built-in catalog applies.
		return { doc: undefined, errors: [] };
	}
	try {
		const doc = parseYaml(content);
		if (doc === null || doc === undefined) return { doc: undefined, errors: [] };
		return { doc, errors: [] };
	} catch (error) {
		return { doc: undefined, errors: [`gates.yaml: ${(error as Error).message}`] };
	}
}

/**
 * Load the effective gate catalog for a project. Deep parse errors in
 * gates.yaml abort with GateSetupError — a broken gate declaration must
 * never silently drop checks from the ladder.
 */
export async function loadGates(projectRoot: string): Promise<Gate[]> {
	const yaml = await readGatesYaml(projectRoot);
	if (yaml.errors.length > 0) throw new GateSetupError(yaml.errors.join("; "));
	const parsed = parseGatesDocument(yaml.doc);
	if (parsed.errors.length > 0) throw new GateSetupError(parsed.errors.join("; "));
	const config = await loadProjectConfig(projectRoot, { trusted: true });
	return effectiveGates(config.profile, GATE_CATALOG, parsed.gates);
}

// ---------------------------------------------------------------------------
// Latest persisted gate status (prerequisite resolution)
// ---------------------------------------------------------------------------

async function readGatesFile(projectRoot: string, runId: string): Promise<GateFileRecord | null> {
	const manifest = await readManifest(projectRoot, runId);
	if (!manifest || manifest.recipe !== "gate") return null;
	try {
		const raw = await readFile(join(runsDir(projectRoot), runId, "gates.json"), "utf8");
		const parsed = JSON.parse(raw) as GateFileRecord;
		return parsed.run_id === runId ? parsed : null;
	} catch {
		return null;
	}
}

/** Most recent persisted status of a gate, if any. */
export async function latestGateStatus(projectRoot: string, gateId: string): Promise<{ status: GateStatus; run_id: string } | null> {
	const runs = await listRuns(projectRoot, 50);
	for (const run of runs) {
		const record = await readGatesFile(projectRoot, run.run_id);
		if (!record) continue;
		const gate = record.gates.find((g) => g.id === gateId);
		if (gate) return { status: gate.status, run_id: run.run_id };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Check evaluation
// ---------------------------------------------------------------------------

export interface CheckContext {
	projectRoot: string;
	/**
	 * P8: safe effective project root (project.yaml project_dir; repo root by
	 * default). File-type content checks — kind=file (unless the check carries
	 * the internal catalog-only `file_root: "repository"` metadata) and the
	 * files read by json/numeric/schema checks — resolve against this root
	 * with realpath containment; everything else (the b0.4 repository-root
	 * workbench-config check, recipe/artifact checks, git, run persistence)
	 * stays repository-root based on `projectRoot`.
	 */
	effectiveProjectRoot: string;
	runDir: string;
	configIssues: ConfigIssue[];
	profile: string | undefined;
	mode: WorkbenchMode;
	exec: ExecFn;
	signal?: AbortSignal;
	now: () => Date;
	manualEvidence: Record<string, string>;
	/** P7: injected worker-first compliance facts (undefined => NOT_RUN checks). */
	workerFirstFacts?: WorkerFirstGateFacts;
	/** P7: actor facts for the shared recipe mutation decision in recipe checks. */
	actorFacts?: RecipeMutationFacts;
	log: (line: string) => void;
}

async function assertPathContained(projectRoot: string, target: string, label: string): Promise<string> {
	const real = await realpathContained(projectRoot, target);
	if (real === undefined) {
		throw new GateSetupError(`${label} path escapes the project root: ${target}`);
	}
	return real;
}

/**
 * The base root a kind=file check resolves against: the effective project
 * root by default; the repository root only when the check carries the
 * INTERNAL catalog-only `file_root: "repository"` metadata. Only the
 * built-in b0.4 workbench-config check sets it — .pi/workbench always
 * lives at the repository root, so a nested `.pi/workbench` can never
 * impersonate the repository configuration. gates.yaml cannot set
 * file_root: parseCheck rejects both `root` and `file_root` as unknown
 * fields.
 */
export function fileCheckRoot(ctx: CheckContext, check: GateCheck): string {
	return check.file_root === "repository" ? ctx.projectRoot : ctx.effectiveProjectRoot;
}

/** Copy an evidence source into runDir/artifacts/ and return the relative path. */
async function copyEvidenceFile(projectRoot: string, runDir: string, checkId: string, absolutePath: string): Promise<string> {
	const rel = relative(projectRoot, absolutePath);
	const safe = checkId.replace(/[^A-Za-z0-9._-]/g, "-");
	const name = `${safe}-${basename(rel)}`;
	const target = join(runDir, "artifacts", name);
	try {
		await copyFile(absolutePath, target);
	} catch {
		return `artifacts/${name}`; // unreadable source; record the intended path
	}
	return `artifacts/${name}`;
}

async function copyRecipeSummary(runDir: string, checkId: string, recipeRunId: string, recipeRunDir: string): Promise<string> {
	const safe = checkId.replace(/[^A-Za-z0-9._-]/g, "-");
	const target = join(runDir, "artifacts", `${safe}-recipe-${recipeRunId}.summary.json`);
	try {
		await copyFile(join(recipeRunDir, "summary.json"), target);
		return `artifacts/${basename(target)}`;
	} catch {
		return "";
	}
}

class JsonArtifactError extends Error {
	constructor(message: string, readonly missing: boolean) {
		super(message);
	}
}

async function resolveJsonFile(ctx: CheckContext, check: GateCheck, file: string, label: string): Promise<{ path: string; value: unknown }> {
	const absolute = await assertPathContained(ctx.effectiveProjectRoot, file, label);
	let raw: string;
	try {
		raw = await readFile(absolute, "utf8");
	} catch {
		throw new JsonArtifactError("missing", true);
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new JsonArtifactError(`invalid JSON: ${(error as Error).message}`, false);
	}
	return { path: absolute, value };
}

/** Dot-path resolution; arrays support `.length`. */
export function resolveJsonPath(value: unknown, path: string): { found: boolean; value?: unknown } {
	const segments = path.split(".").filter((s) => s.length > 0);
	let cur: unknown = value;
	for (const segment of segments) {
		if (cur === null || cur === undefined) return { found: false };
		if (segment === "length" && Array.isArray(cur)) {
			cur = cur.length;
			continue;
		}
		if (typeof cur !== "object") return { found: false };
		cur = (cur as Record<string, unknown>)[segment];
	}
	return { found: cur !== undefined, value: cur };
}

interface EvaluatedCheck {
	entry: CheckRunEntry;
	artifactPaths: string[];
}

// ---------------------------------------------------------------------------
// P7 worker-first compliance assertions (machine-backed, injected facts only)
// ---------------------------------------------------------------------------

/**
 * Evaluate one worker-first assertion against the injected facts. The
 * runtime constructed the facts from actor/policy/lease/delegation/review
 * state — model prose and manual evidence can never influence them.
 *   - PASS      — the compliance condition holds (vacuous PASS for "no
 *                 delegation" review checks: nothing to review)
 *   - FAIL      — a negative compliance fact
 *   - NOT_RUN   — the required fact is missing (required NOT_RUN can never
 *                 make the gate PASS)
 * A facts-level `blockedReason` is handled by the caller BEFORE this
 * function (every worker-first check then evaluates BLOCKED).
 */
export function evaluateWorkerFirstAssertion(
	name: WorkerFirstCheckName,
	facts: WorkerFirstGateFacts,
): { status: "PASS" | "FAIL" | "NOT_RUN"; detail: string } {
	switch (name) {
		case "strict-policy-active": {
			if (facts.writePolicy === "worker-first-strict") return { status: "PASS", detail: "worker-first-strict policy is active" };
			// The runtime always resolves the policy for the current actor
			// (worker-first-strict for approved Sol, null otherwise) — null is
			// a negative compliance fact, not a missing one.
			return { status: "FAIL", detail: `worker-first-strict policy is not active for this actor (got ${facts.writePolicy ?? "not applicable"})` };
		}
		case "no-unauthorized-commander-writes": {
			if (facts.commanderWritesDenied === true) {
				return { status: "PASS", detail: "commander edit/write is hard-denied — no unauthorized write can get through" };
			}
			if (facts.blockedCommanderWriteAttempts !== null && facts.blockedCommanderWriteAttempts === 0) {
				return { status: "PASS", detail: "zero unauthorized commander write attempts" };
			}
			if (facts.blockedCommanderWriteAttempts !== null && facts.blockedCommanderWriteAttempts > 0) {
				return { status: "FAIL", detail: `${facts.blockedCommanderWriteAttempts} unauthorized commander write attempt(s) while the hard denial was inactive` };
			}
			return { status: "NOT_RUN", detail: "no hard-denial / blocked-write fact injected" };
		}
		case "no-pending-review": {
			if (facts.hasDelegation === false) return { status: "PASS", detail: "no delegation — nothing pending" };
			if (facts.reviewStatus === null) return { status: "NOT_RUN", detail: "no review-status fact injected" };
			if (facts.reviewStatus === "PENDING_REVIEW") {
				return { status: "FAIL", detail: `delegation ${facts.latestDelegationId ?? "?"} is PENDING_REVIEW — review the worker diff first` };
			}
			return { status: "PASS", detail: `latest delegation ${facts.latestDelegationId ?? "?"} is ${facts.reviewStatus}` };
		}
		case "no-stale-review": {
			if (facts.hasDelegation === false) return { status: "PASS", detail: "no delegation — nothing stale" };
			if (facts.reviewStatus === null) return { status: "NOT_RUN", detail: "no review-status fact injected" };
			if (facts.reviewStatus === "STALE") {
				return { status: "FAIL", detail: `delegation ${facts.latestDelegationId ?? "?"} is STALE — the diff changed since the review` };
			}
			return { status: "PASS", detail: `latest delegation ${facts.latestDelegationId ?? "?"} is ${facts.reviewStatus}` };
		}
		case "reviewed-hash-matches-current": {
			if (facts.hasDelegation === false) return { status: "PASS", detail: "no delegation — nothing reviewed yet" };
			if (facts.reviewStatus === "PENDING_REVIEW") {
				return { status: "NOT_RUN", detail: "no reviewed hash yet — the delegation is PENDING_REVIEW" };
			}
			if (facts.reviewedDiffHash === null || facts.currentDiffHash === null) {
				return { status: "NOT_RUN", detail: "reviewed/current diff-hash facts not injected" };
			}
			if (facts.reviewedDiffHash === facts.currentDiffHash) {
				return { status: "PASS", detail: `reviewed hash ${facts.reviewedDiffHash.slice(0, 12)}… equals the current diff hash` };
			}
			return { status: "FAIL", detail: `reviewed hash ${facts.reviewedDiffHash.slice(0, 12)}… differs from the current diff hash ${facts.currentDiffHash.slice(0, 12)}…` };
		}
		case "worker-paths-within-contracts": {
			if (facts.hasDelegation === false) return { status: "PASS", detail: "no delegation — no worker paths to check" };
			if (facts.reviewVerdict === null && facts.reviewViolationCount === null) {
				return { status: "NOT_RUN", detail: "no completed review facts injected" };
			}
			const violations = facts.reviewViolationCount ?? 0;
			if (facts.reviewVerdict === "PASS" && violations === 0) {
				return { status: "PASS", detail: `latest review PASS — every worker path is within the approved contracts` };
			}
			return { status: "FAIL", detail: `${violations} worker path(s) outside the approved contracts (latest review ${facts.reviewVerdict ?? "FAIL"})` };
		}
		case "no-active-unexplained-lease": {
			if (facts.leaseStatus === null) return { status: "NOT_RUN", detail: "no lease-status fact injected" };
			if (facts.leaseStatus === "active") {
				if (facts.leaseReason !== null) {
					return { status: "PASS", detail: `active lease with audited fixed reason ${facts.leaseReason}` };
				}
				return { status: "FAIL", detail: "an active commander write lease has no audited fixed reason" };
			}
			return { status: "PASS", detail: `write lease is ${facts.leaseStatus}` };
		}
		case "commander-initiated-final-verification": {
			if (facts.gateRunInitiatedByCommander === null) return { status: "NOT_RUN", detail: "no gate-run initiator fact injected" };
			if (facts.gateRunInitiatedByCommander === true) {
				return { status: "PASS", detail: "this gate run was initiated by the approved GPT-5.6 Sol commander" };
			}
			return { status: "FAIL", detail: "this gate run was not initiated by the approved Sol commander — final verification is a commander-owned act" };
		}
	}
}

async function evaluateCheck(gateId: string, check: GateCheck, ctx: CheckContext): Promise<EvaluatedCheck> {
	const startedAt = ctx.now();
	const entry: CheckRunEntry = {
		check_id: check.id,
		gate_id: gateId,
		status: "NOT_RUN",
		kind: check.kind,
		required: check.required,
		blocking: check.blocking,
		evidence: [],
		failure_reason: null,
		blocked_reason: null,
		warnings: [],
		started_at: startedAt.toISOString(),
		finished_at: startedAt.toISOString(),
		duration_ms: 0,
	};
	const artifactPaths: string[] = [];
	const fail = (reason: string, evidence: EvidenceEntry[]): void => {
		entry.status = "FAIL";
		entry.failure_reason = reason;
		entry.evidence.push(...evidence);
	};
	const pass = (evidence: EvidenceEntry[]): void => {
		entry.status = "PASS";
		entry.evidence.push(...evidence);
	};

	const label = `gate "${gateId}" check "${check.id}"`;
	ctx.log(`    ${check.id} (${check.kind}) ...`);

	try {
		switch (check.kind) {
			case "config": {
				if (ctx.configIssues.length === 0) {
					pass([{ type: "config", source: ".pi/workbench", detail: "workbench config loads with 0 issues" }]);
				} else {
					const detail = ctx.configIssues.map((i) => `${i.file}: ${i.message}`).join("; ");
					fail(`workbench config has issues: ${detail}`, [{ type: "config", source: ".pi/workbench", detail }]);
				}
				break;
			}

			case "recipe": {
				const candidates = check.recipe ? [check.recipe] : (check.recipes ?? []);
				const declared = await declaredRecipe(ctx.projectRoot, candidates);
				if (!declared) {
					fail(`no declared recipe among: ${candidates.join(", ")}`, [
						{ type: "config", source: ".pi/workbench/recipes.yaml", detail: `none of ${candidates.join(", ")} is declared` },
					]);
					break;
				}
				if (!(await recipeAllowedInMode(ctx.projectRoot, declared.name, ctx.mode))) {
					entry.status = "BLOCKED";
					entry.blocked_reason = `recipe "${declared.name}" is not allowed in ${ctx.mode} mode`;
					break;
				}
				// P7: gate-engine recipe checks apply the SAME shared mutation
				// decision as direct recipe execution — strict Sol is denied
				// mutation: source, workers run only mutation: none, other
				// controllers keep prior behavior. A policy denial BLOCKs the
				// check (it can never run), and runRecipe re-enforces it below.
				const mutationBlock = recipeMutationBlockReason(ctx.actorFacts, declared.name, declared.mutation);
				if (mutationBlock) {
					entry.status = "BLOCKED";
					entry.blocked_reason = mutationBlock;
					break;
				}
				const result = await runRecipe({
					projectRoot: ctx.projectRoot,
					recipeName: declared.name,
					params: {},
					mode: ctx.mode,
					exec: ctx.exec,
					signal: ctx.signal,
					now: ctx.now,
					actorFacts: ctx.actorFacts,
				});
				if (!result.ok && result.error) {
					fail(`recipe "${declared.name}" could not run: ${result.error}`, [
						{ type: "recipe_run", recipe: declared.name, detail: result.error },
					]);
					break;
				}
				const summary = result.summary;
				const ok = result.ok === true;
				const evidence: EvidenceEntry[] = [
					{
						type: "recipe_run",
						run_id: result.record?.run_id,
						recipe: declared.name,
						exit_code: result.record?.exit_code ?? null,
						execution_source: result.record?.execution_source ?? "exec",
						detail: ok ? `recipe "${declared.name}" exited ${result.record?.exit_code} as expected` : `recipe "${declared.name}" failed (exit ${result.record?.exit_code ?? "killed"}, timed_out=${result.record?.timed_out})`,
					},
				];
				if (result.runDir) {
					const copied = await copyRecipeSummary(ctx.runDir, check.id, result.record?.run_id ?? "", result.runDir);
					if (copied) {
						artifactPaths.push(copied);
						evidence[0]!.artifact_path = copied;
					}
				}
				if (summary && summary.stderr.trim().length > 0) {
					entry.warnings.push(`recipe "${declared.name}" wrote to stderr`);
				}
				if (ok) pass(evidence);
				else fail(evidence[0]!.detail, evidence);
				break;
			}

			case "artifact": {
				const recipeName = check.artifact_recipe as string;
				const runs = await listRuns(ctx.projectRoot, 50);
				const run = runs.find((r) => r.recipe === recipeName);
				if (!run) {
					fail(`no run of recipe "${recipeName}" found`, [
						{ type: "config", source: ".pi/workbench/recipes.yaml", detail: `no persisted run of "${recipeName}"` },
					]);
					break;
				}
				const matched = check.artifact_glob
					? run.artifact_paths.filter((p) => globSync(check.artifact_glob as string, { cwd: ctx.projectRoot }).includes(p))
					: run.artifact_paths;
				if (matched.length === 0) {
					fail(`run ${run.run_id} of "${recipeName}" produced no matching artifacts${check.artifact_glob ? ` (glob: ${check.artifact_glob})` : ""}`, [
						{ type: "artifact", run_id: run.run_id, recipe: recipeName, paths: run.artifact_paths, detail: "no matching artifacts" },
					]);
					break;
				}
				pass([
					{
						type: "artifact",
						run_id: run.run_id,
						recipe: recipeName,
						paths: matched,
						detail: `run ${run.run_id} artifacts: ${matched.join(", ")}`,
					},
				]);
				break;
			}

			case "file": {
				const patterns = check.any_of ?? (check.path ? [check.path] : []);
				const baseRoot = fileCheckRoot(ctx, check);
				const matched: string[] = [];
				const matchedAbsolute: string[] = [];
				for (const pattern of patterns) {
					if ((await realpathContained(baseRoot, pattern)) === undefined) {
						throw new GateSetupError(`${label}: file path escapes the project root: ${pattern}`);
					}
					for (const match of globSync(pattern, { cwd: baseRoot })) {
						const absolute = await realpathContained(baseRoot, match);
						if (absolute === undefined) continue;
						matched.push(match);
						matchedAbsolute.push(absolute);
					}
				}
				if (matched.length === 0) {
					fail(`no file matched: ${patterns.join(" | ")}`, [
						{ type: "file", source: patterns.join(" | "), detail: "no match" },
					]);
					break;
				}
				for (let i = 0; i < matched.length && i < 1; i++) {
					const copied = await copyEvidenceFile(ctx.projectRoot, ctx.runDir, check.id, matchedAbsolute[i]!);
					if (copied) {
						artifactPaths.push(copied);
					}
				}
				pass([{ type: "file", source: matched.join(", "), detail: "exists" }]);
				break;
			}

			case "json": {
				const file = check.json_file as string;
				let resolved: { path: string; value: unknown };
				try {
					resolved = await resolveJsonFile(ctx, check, file, label);
				} catch (error) {
					if (error instanceof GateSetupError) throw error;
					const missing = error instanceof JsonArtifactError && error.missing;
					fail(missing ? `artifact missing: ${file}` : `${file}: ${(error as Error).message}`, [
						{ type: "json", source: file, detail: missing ? "file not found" : (error as Error).message },
					]);
					break;
				}
				const copied = await copyEvidenceFile(ctx.projectRoot, ctx.runDir, check.id, resolved.path);
				if (copied) artifactPaths.push(copied);

				const paths = check.json_any_of_paths ?? (check.json_path ? [check.json_path] : []);
				let foundPath: string | undefined;
				for (const p of paths) {
					if (resolveJsonPath(resolved.value, p).found) {
						foundPath = p;
						break;
					}
				}
				if (!foundPath) {
					fail(`JSON field missing: ${file}#${paths.join(" | ")}`, [
						{ type: "json", source: file, detail: `field(s) not found: ${paths.join(" | ")}` },
					]);
					break;
				}
				if (check.json_equals !== undefined) {
					const resolvedValue = resolveJsonPath(resolved.value, foundPath).value;
					if (!isDeepStrictEqual(resolvedValue, check.json_equals)) {
						fail(`JSON field ${file}#${foundPath} does not equal ${JSON.stringify(check.json_equals)}`, [
							{ type: "json", source: file, detail: `${foundPath} = ${JSON.stringify(resolvedValue)}, expected ${JSON.stringify(check.json_equals)}` },
						]);
						break;
					}
				}
				pass([{ type: "json", source: file, detail: `${foundPath} present` }]);
				break;
			}

			case "numeric": {
				const file = check.json_file as string;
				let resolved: { path: string; value: unknown };
				try {
					resolved = await resolveJsonFile(ctx, check, file, label);
				} catch (error) {
					if (error instanceof GateSetupError) throw error;
					const missing = error instanceof JsonArtifactError && error.missing;
					fail(missing ? `artifact missing: ${file}` : `${file}: ${(error as Error).message}`, [
						{ type: "numeric", source: file, detail: missing ? "file not found" : (error as Error).message },
					]);
					break;
				}
				const copied = await copyEvidenceFile(ctx.projectRoot, ctx.runDir, check.id, resolved.path);
				if (copied) artifactPaths.push(copied);

				const path = check.json_path as string;
				const { found, value } = resolveJsonPath(resolved.value, path);
				const finite = typeof value === "number" && Number.isFinite(value);
				if (!found || !finite) {
					fail(`numeric field ${file}#${path} must be a finite number (got ${JSON.stringify(value)})`, [
						{ type: "numeric", source: file, detail: `${path} = ${JSON.stringify(value)} (not a finite number)` },
					]);
					break;
				}
				const num = value as number;
				if (check.numeric_min !== undefined && num < check.numeric_min) {
					fail(`numeric field ${file}#${path} = ${num} is below min ${check.numeric_min}`, [
						{ type: "numeric", source: file, detail: `${path} = ${num} < min ${check.numeric_min}` },
					]);
					break;
				}
				if (check.numeric_max !== undefined && num > check.numeric_max) {
					fail(`numeric field ${file}#${path} = ${num} is above max ${check.numeric_max}`, [
						{ type: "numeric", source: file, detail: `${path} = ${num} > max ${check.numeric_max}` },
					]);
					break;
				}
				pass([{ type: "numeric", source: file, detail: `${path} = ${num}${check.numeric_min !== undefined ? ` >= ${check.numeric_min}` : ""}${check.numeric_max !== undefined ? ` <= ${check.numeric_max}` : ""}` }]);
				break;
			}

			case "manual": {
				const note = ctx.manualEvidence[check.id];
				if (note === undefined || note.trim().length === 0) {
					entry.status = "NOT_RUN";
					entry.failure_reason = null;
					ctx.log(`    ${check.id} NOT_RUN — manual evidence required (${check.manual_prompt ?? "see gates.yaml"})`);
					break;
				}
				pass([
					{
						type: "manual",
						check_id: check.id,
						provided_by: "manual-input",
						detail: note.trim(),
					},
				]);
				break;
			}

			case "worker-first": {
				const name = check.worker_first;
				if (!name || !WORKER_FIRST_CHECK_NAMES.includes(name as WorkerFirstCheckName)) {
					throw new GateSetupError(`${label}: kind=worker-first needs a valid "worker_first" assertion (one of ${WORKER_FIRST_CHECK_NAMES.join(", ")})`);
				}
				const facts = ctx.workerFirstFacts;
				if (!facts) {
					// Required facts were not injected: NOT_RUN — never PASS.
					entry.status = "NOT_RUN";
					entry.failure_reason = null;
					ctx.log(`    ${check.id} NOT_RUN — worker-first compliance facts were not injected (runtime-only machine check)`);
					break;
				}
				if (facts.blockedReason) {
					// The runtime marks the evaluation blocked (e.g. a pending/stale
					// review blocks final verification): every worker-first check
					// is BLOCKED, never evaluated against partial facts.
					entry.status = "BLOCKED";
					entry.blocked_reason = facts.blockedReason;
					ctx.log(`    ${check.id} BLOCKED — ${facts.blockedReason}`);
					break;
				}
				const outcome = evaluateWorkerFirstAssertion(name, facts);
				const evidence: EvidenceEntry = { type: "worker_first", detail: outcome.detail };
				if (outcome.status === "PASS") pass([evidence]);
				else if (outcome.status === "FAIL") fail(outcome.detail, [evidence]);
				else {
					entry.status = "NOT_RUN";
					entry.failure_reason = outcome.detail;
					ctx.log(`    ${check.id} NOT_RUN — ${outcome.detail}`);
				}
				break;
			}

			case "schema": {
				const file = check.json_file as string;
				const schemaName = check.schema_name ?? "quant-result";
				const QUANT_CONTRACT_SCHEMAS: readonly string[] = ["data-snapshot", "feature-set", "backtest-result"];
				if (schemaName !== "quant-result" && !QUANT_CONTRACT_SCHEMAS.includes(schemaName)) {
					throw new GateSetupError(`${label}: unknown built-in schema "${schemaName}" (supported: quant-result, ${QUANT_CONTRACT_SCHEMAS.join(", ")})`);
				}
				let resolved: { path: string; value: unknown };
				try {
					resolved = await resolveJsonFile(ctx, check, file, label);
				} catch (error) {
					if (error instanceof GateSetupError) throw error;
					const missing = error instanceof JsonArtifactError && error.missing;
					fail(missing ? `artifact missing: ${file}` : `${file}: ${(error as Error).message}`, [
						{ type: "schema", source: file, detail: missing ? "file not found" : (error as Error).message },
					]);
					break;
				}
				const copied = await copyEvidenceFile(ctx.projectRoot, ctx.runDir, check.id, resolved.path);
				if (copied) artifactPaths.push(copied);

				// P6-D: the three quant cache contracts validate as built-in
				// schemas. For them the evidence records the validation status
				// (validated/unresolved/invalid), cache eligibility and the
				// manifest warnings verbatim — a cache hit never bypasses these
				// gates, and "validated" is never claimed for manifests that only
				// parse (missing adjustment/corporate-action/delisting semantics
				// or per-profile requirements stay unresolved).
				const isQuantContract = QUANT_CONTRACT_SCHEMAS.includes(schemaName);
				const result = isQuantContract
					? validateQuantContract(resolved.value, { profile: ctx.profile })
					: validateQuantResult(resolved.value, { profile: ctx.profile });
				const evidence: EvidenceEntry = isQuantContract
					? (() => {
							const q = result as ReturnType<typeof validateQuantContract>;
							return {
								type: "schema",
								source: file,
								detail: q.validationStatus === "validated"
									? `conforms to ${schemaName}.schema (${q.validationStatus}${q.cacheEligible ? ", cache-eligible" : ""})`
									: `not ${schemaName}.schema validated: ${q.errors.slice(0, 3).join("; ") || q.warnings.filter((w) => w.includes("validated") || w.includes("semantics")).slice(0, 3).join("; ") || q.validationStatus}`,
								errors: q.errors,
								warnings: q.warnings,
							};
						})()
					: (() => {
							const q = result as ReturnType<typeof validateQuantResult>;
							const entry: EvidenceEntry = {
								type: "schema",
								source: file,
								detail: q.valid ? `conforms to ${schemaName}.schema.json` : `schema violations: ${q.errors.slice(0, 5).join("; ")}`,
								errors: q.errors,
								warnings: q.warnings,
							};
							if (q.failed_folds.length > 0) {
								entry.detail += ` | failed folds reported: ${q.failed_folds.join(", ")}`;
							}
							return entry;
						})();
				// Quant contract schemas only PASS when the manifest is fully
				// VALIDATED (structure + semantics, immutable). A manifest that
				// merely parses (missing adjustment/corporate-action/delisting
				// semantics or per-profile requirements) FAILS the gate.
				const quantPassed = isQuantContract
					? (result as ReturnType<typeof validateQuantContract>).validationStatus === "validated"
					: result.valid;
				if (quantPassed) pass([evidence]);
				else fail(`artifact ${file} does not conform to ${schemaName} contract (validation status: ${isQuantContract ? (result as ReturnType<typeof validateQuantContract>).validationStatus : "invalid"})`, [evidence]);
				break;
			}

			default: {
				throw new GateSetupError(`${label}: unsupported check kind "${check.kind}"`);
			}
		}
	} catch (error) {
		if (error instanceof GateSetupError) throw error;
		entry.status = "FAIL";
		entry.failure_reason = `${label}: unexpected error: ${(error as Error).message}`;
	}

	const finishedAt = ctx.now();
	entry.finished_at = finishedAt.toISOString();
	entry.duration_ms = Math.max(0, finishedAt.getTime() - startedAt.getTime());
	return { entry, artifactPaths };
}

async function declaredRecipe(projectRoot: string, candidates: readonly string[]): Promise<Recipe | undefined> {
	const config = await loadProjectConfig(projectRoot, { trusted: true });
	return config.recipes.find((r) => candidates.includes(r.name));
}

async function recipeAllowedInMode(projectRoot: string, recipeName: string, mode: WorkbenchMode): Promise<boolean> {
	const config = await loadProjectConfig(projectRoot, { trusted: true });
	const recipe = config.recipes.find((r) => r.name === recipeName);
	return recipe?.allowed_modes.includes(mode) ?? false;
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

function worstStatus(a: GateStatus, b: GateStatus): GateStatus {
	const order: Record<GateStatus, number> = { PASS: 0, NOT_RUN: 1, BLOCKED: 2, FAIL: 3 };
	return order[a] >= order[b] ? a : b;
}

function gateStatusFromChecks(checks: readonly CheckRunEntry[]): { status: GateStatus; failure_reason: string | null; blocked_reason: string | null; warnings: string[] } {
	const warnings: string[] = [];
	let status: GateStatus = "PASS";
	let failure_reason: string | null = null;
	let blocked_reason: string | null = null;

	const failed = checks.filter((c) => c.status === "FAIL" && c.blocking);
	if (failed.length > 0) {
		status = "FAIL";
		failure_reason = `check(s) failed: ${failed.map((c) => c.check_id).join(", ")}`;
	} else {
		const blocked = checks.filter((c) => c.status === "BLOCKED" && c.blocking);
		if (blocked.length > 0) {
			status = "BLOCKED";
			blocked_reason = `check(s) blocked: ${blocked.map((c) => `${c.check_id} (${c.blocked_reason})`).join("; ")}`;
		} else {
			const notRun = checks.filter((c) => c.status === "NOT_RUN" && c.required);
			if (notRun.length > 0) {
				status = "NOT_RUN";
				blocked_reason = null;
			}
		}
	}
	for (const c of checks) {
		if (c.status === "FAIL" && !c.blocking) warnings.push(`non-blocking check ${c.check_id} failed: ${c.failure_reason}`);
		if (c.status === "BLOCKED" && !c.blocking) warnings.push(`non-blocking check ${c.check_id} blocked: ${c.blocked_reason}`);
		if (c.status === "NOT_RUN" && !c.required) warnings.push(`optional check ${c.check_id} not run`);
		if (c.warnings.length > 0) warnings.push(...c.warnings.map((w) => `check ${c.check_id}: ${w}`));
	}
	return { status, failure_reason, blocked_reason, warnings };
}

async function evaluateGate(
	gate: Gate,
	ctx: CheckContext,
	inRun: ReadonlyMap<string, GateRunEntry>,
	effective: readonly Gate[],
): Promise<GateRunEntry> {
	const startedAt = ctx.now();
	const prerequisite_status: Record<string, { status: GateStatus; source: string }> = {};
	let blocked_reason: string | null = null;

	for (const prereqId of gate.prerequisites) {
		const prereqGate = effective.find((g) => g.id === prereqId);
		const blocking = prereqGate ? prereqGate.blocking : true;
		const inRunEntry = inRun.get(prereqId);
		let status: GateStatus;
		let source: string;
		if (inRunEntry) {
			status = inRunEntry.status;
			source = "this-run";
		} else {
			const persisted = await latestGateStatus(ctx.projectRoot, prereqId);
			status = persisted?.status ?? "NOT_RUN";
			source = persisted ? `run:${persisted.run_id}` : "no-prior-run";
		}
		prerequisite_status[prereqId] = { status, source };
		if (status !== "PASS" && blocking) {
			blocked_reason = `prerequisite ${prereqId} is ${status} (${source})`;
			break;
		}
	}

	const checks: CheckRunEntry[] = [];
	const evidencePaths: string[] = [];
	const logLabel = `==> gate ${gate.id} ${gate.title}`;

	if (blocked_reason) {
		ctx.log(`${logLabel}: BLOCKED (${blocked_reason})`);
		const finishedAt = ctx.now();
		return {
			id: gate.id,
			title: gate.title,
			description: gate.description,
			status: "BLOCKED",
			required: gate.required,
			blocking: gate.blocking,
			prerequisites: gate.prerequisites,
			prerequisite_status,
			checks: [],
			failure_reason: null,
			blocked_reason,
			warnings: [],
			evidence_paths: [],
			declared_evidence: gate.evidence,
			started_at: startedAt.toISOString(),
			finished_at: finishedAt.toISOString(),
			duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
		};
	}

	ctx.log(logLabel);
	for (const check of gate.checks) {
		const evaluated = await evaluateCheck(gate.id, check, ctx);
		const c = evaluated.entry;
		checks.push(c);
		evidencePaths.push(`evidence.json#/checks/${c.check_id}`, ...evaluated.artifactPaths);
		ctx.log(`    ${c.check_id} ${c.status}${c.failure_reason ? ` — ${c.failure_reason}` : ""}${c.blocked_reason ? ` — ${c.blocked_reason}` : ""}`);
	}

	const { status, failure_reason, blocked_reason: checkBlockedReason, warnings } = gateStatusFromChecks(checks);
	ctx.log(`    gate ${gate.id}: ${status} (${checks.filter((c) => c.status === "PASS").length}/${checks.length} checks passed)`);
	const finishedAt = ctx.now();
	return {
		id: gate.id,
		title: gate.title,
		description: gate.description,
		status,
		required: gate.required,
		blocking: gate.blocking,
		prerequisites: gate.prerequisites,
		prerequisite_status,
		checks,
		failure_reason,
		blocked_reason: checkBlockedReason,
		warnings,
		evidence_paths: evidencePaths,
		declared_evidence: gate.evidence,
		started_at: startedAt.toISOString(),
		finished_at: finishedAt.toISOString(),
		duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
	};
}

// ---------------------------------------------------------------------------
// Run orchestration + persistence
// ---------------------------------------------------------------------------

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
 * Run a gate selector end to end and persist all run artifacts.
 * Throws GateSetupError for setup violations (path escapes, invalid
 * gates.yaml, unknown selectors); evaluation outcomes are reported in the
 * result, never thrown.
 */
export async function runGates(input: RunGatesInput): Promise<RunGatesResult> {
	const { projectRoot, selector, mode, exec } = input;
	const now = input.now ?? (() => new Date());
	const startedAt = now();

	const config = await loadProjectConfig(projectRoot, { trusted: true });
	const gates = await loadGates(projectRoot);

	const requestedIds = resolveSelector(selector, gates);
	if (requestedIds.length === 0) {
		throw new GateSetupError(`selector "${selector}" matched no gates`);
	}
	const known = new Set(gates.map((g) => g.id));
	const unknown = requestedIds.filter((id) => !known.has(id));
	if (unknown.length > 0) {
		const quantOnly = QUANT_GATE_ID_RE.test(unknown[0] ?? "");
		throw new GateSetupError(
			`gate(s) not available for profile ${config.profile ?? "(none)"}: ${unknown.join(", ")}${quantOnly ? " (quant gates load only for quant-research profiles)" : ""}`,
		);
	}

	let ordered: string[];
	try {
		ordered = orderGates(requestedIds, gates);
	} catch (error) {
		throw new GateSetupError((error as Error).message);
	}

	const runId = makeRunId(startedAt);
	const runDir = join(runsDir(projectRoot), runId);
	await mkdir(join(runDir, "artifacts"), { recursive: true });

	const git = await gitState(projectRoot, exec);

	const logLines: string[] = [
		`gate run ${runId}: selector=${selector} profile=${config.profile ?? "(none)"} mode=${mode}`,
		`gates in run (dependency order): ${ordered.join(", ")}`,
		"",
	];
	const log = (line: string): void => {
		logLines.push(line);
	};

	const ctx: CheckContext = {
		projectRoot,
		effectiveProjectRoot: config.effectiveProjectRoot,
		runDir,
		configIssues: config.issues,
		profile: config.profile,
		mode,
		exec,
		signal: input.signal,
		now,
		manualEvidence: input.manualEvidence ?? {},
		workerFirstFacts: input.workerFirstFacts,
		actorFacts: input.actorFacts,
		log,
	};

	const inRun = new Map<string, GateRunEntry>();
	const gateEntries: GateRunEntry[] = [];
	for (const gateId of ordered) {
		const gate = gates.find((g) => g.id === gateId);
		if (!gate) continue;
		const entry = await evaluateGate(gate, ctx, inRun, gates);
		inRun.set(gateId, entry);
		gateEntries.push(entry);
	}

	let overall: GateStatus = "PASS";
	for (const entry of gateEntries) {
		if (entry.required) overall = worstStatus(overall, entry.status);
	}
	const finishedAt = now();
	const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
	const ok = overall === "PASS";

	logLines.push("", `overall: ${overall}${ok ? "" : " (not a pass)"}`);
	const stdoutFull = logLines.join("\n") + "\n";

	// ------------------------------------------------------------ persistence

	const evidenceByCheck: Record<string, CheckRunEntry> = {};
	for (const gateEntry of gateEntries) {
		for (const c of gateEntry.checks) evidenceByCheck[c.check_id] = c;
	}
	const evidenceFile = {
		schema_version: GATE_SCHEMA_VERSION,
		run_id: runId,
		requested: requestedIds,
		profile: config.profile,
		mode,
		checks: evidenceByCheck,
	};

	const gatesFile: GateFileRecord = {
		schema_version: GATE_SCHEMA_VERSION,
		run_id: runId,
		requested: requestedIds,
		profile: config.profile,
		mode,
		gates: gateEntries,
	};

	const stdoutView = truncateTail(stdoutFull, { maxLines: 2000, maxBytes: 51200 });
	const manifest = {
		schema_version: RUN_SCHEMA_VERSION,
		run_id: runId,
		recipe: "gate",
		profile: config.profile,
		started_at: startedAt.toISOString(),
		finished_at: finishedAt.toISOString(),
		duration_ms: durationMs,
		cwd: projectRoot,
		argv: ["/q-gate", selector],
		exit_code: ok ? 0 : 1,
		timed_out: false,
		cancelled: input.signal?.aborted ?? false,
		git_commit: git.commit,
		git_dirty: git.dirty,
		artifact_paths: ["gates.json", "evidence.json", "summary.json", ...gateEntries.flatMap((g) => g.evidence_paths.filter((p) => p.startsWith("artifacts/")))],
		stdout_truncated: stdoutView.truncated,
		stderr_truncated: false,
		mode,
		expected_exit_codes: [0],
		declared_writes: [],
		environment_names: [],
	};

	const gateSummary: Record<string, GateStatus> = {};
	for (const entry of gateEntries) gateSummary[entry.id] = entry.status;
	const summary = {
		run_id: runId,
		recipe: "gate",
		profile: config.profile,
		started_at: manifest.started_at,
		finished_at: manifest.finished_at,
		duration_ms: durationMs,
		cwd: projectRoot,
		argv: manifest.argv,
		exit_code: manifest.exit_code,
		timed_out: false,
		cancelled: manifest.cancelled,
		git_commit: git.commit,
		git_dirty: git.dirty,
		artifact_paths: manifest.artifact_paths,
		stdout_truncated: stdoutView.truncated,
		stderr_truncated: false,
		stdout: stdoutView.content,
		stderr: "",
		stdout_log: join(runDir, "stdout.log"),
		stderr_log: join(runDir, "stderr.log"),
		kind: "gate",
		requested: requestedIds,
		status: overall,
		gates: gateSummary,
		counts: {
			pass: gateEntries.filter((g) => g.status === "PASS").length,
			fail: gateEntries.filter((g) => g.status === "FAIL").length,
			blocked: gateEntries.filter((g) => g.status === "BLOCKED").length,
			not_run: gateEntries.filter((g) => g.status === "NOT_RUN").length,
		},
	};

	await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
	await writeFile(join(runDir, "gates.json"), JSON.stringify(gatesFile, null, 2), "utf8");
	await writeFile(join(runDir, "evidence.json"), JSON.stringify(evidenceFile, null, 2), "utf8");
	await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
	await writeFile(join(runDir, "stdout.log"), stdoutFull, "utf8");
	await writeFile(join(runDir, "stderr.log"), "", "utf8");

	return { ok, status: overall, runId, runDir, gates: gateEntries, requested: requestedIds, profile: config.profile };
}

/** Project-relative form of a path for display. */
export function displayRelative(projectRoot: string, absolutePath: string): string {
	const rel = relative(projectRoot, absolutePath);
	return rel.length === 0 || rel.startsWith("..") ? absolutePath : rel;
}
