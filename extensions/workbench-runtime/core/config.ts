/**
 * Workbench project configuration — loading and parsing.
 *
 * Config lives in `<project-root>/<CONFIG_DIR_NAME>/workbench/` where
 * CONFIG_DIR_NAME is Pi's official export (".pi" by default — never hardcoded
 * here). Supported files:
 *
 *   - project.yaml  — project name, description, selected profile, optional
 *                    `project_dir` (nested effective project root)
 *   - recipes.yaml  — declarative recipes (see recipe-schema.ts)
 *   - gates.yaml    — reserved: gate declarations (parsed, not enforced in P1)
 *   - profiles.yaml — profile definitions (parsed, not enforced in P1)
 *
 * Trust: the caller must pass `trusted` (from ctx.isProjectTrusted()). An
 * untrusted project is rejected before any file is read.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { parseRecipesDocument, type Recipe } from "./recipe-schema.ts";
import { DEFAULT_ACTION_CACHE_MAX_BYTES } from "../cache/action-types.ts";
import { lexicalContain } from "./path-guard.ts";
import { parseAdvisoryConfig, type AdvisoryConfig } from "./commander-advisory.ts";

export const WORKBENCH_DIR = "workbench";
export const RUNS_DIR = "runs";
export const CONFIG_FILES = ["project.yaml", "recipes.yaml", "gates.yaml", "profiles.yaml"] as const;

/** Thrown when project config is requested without project trust. */
export class UntrustedProjectError extends Error {
	constructor(projectRoot: string) {
		super(
			`project ${projectRoot} is not trusted — workbench refuses to read or execute its configuration. Exit Pi, re-enter the project, and approve project trust first.`,
		);
		this.name = "UntrustedProjectError";
	}
}

export interface ConfigIssue {
	file: string;
	message: string;
}

export interface ProjectConfig {
	/** The repository root — every service receives this as `projectRoot`. */
	projectRoot: string;
	/** Raw project.yaml `project_dir` value (undefined when absent). */
	projectDir: string | undefined;
	/**
	 * Safe effective project root resolved from `project_dir` (default: the
	 * repository root). Never points outside the repository: absolute paths,
	 * `..` escapes and symlink escapes are rejected and fall back to
	 * `projectRoot` with a recorded issue. Stack detection and gate
	 * file/json/numeric/schema checks run against this root; config, runs,
	 * git and delegation stay repository-root based.
	 */
	effectiveProjectRoot: string;
	projectName: string | undefined;
	description: string | undefined;
	profile: string | undefined;
	recipes: Recipe[];
	gates: unknown[];
	profiles: unknown[];
	issues: ConfigIssue[];
	/** P6-A: prompt-cache telemetry opt-out (project.yaml cache.telemetry). Default true. */
	cacheTelemetry: boolean;
	/** P6-C: action-cache capacity limit (project.yaml cache.actionCache.maxBytes). */
	actionCacheMaxBytes: number;
	/**
	 * P7 (commander-token-optimization plan §6): observation-only commander
	 * advisory thresholds (project.yaml commander.advisory.soft/high). Always
	 * fully resolved — every missing/invalid field inherits the documented
	 * defaults; invalid fields/ordering are recorded as bounded project.yaml
	 * ConfigIssue records and never disable observability.
	 */
	commanderAdvisory: AdvisoryConfig;
}

/** The workbench config directory for a project root. */
export function workbenchDir(projectRoot: string): string {
	return join(resolve(projectRoot), CONFIG_DIR_NAME, WORKBENCH_DIR);
}

/** The run-records directory for a project root. */
export function runsDir(projectRoot: string): string {
	return join(workbenchDir(projectRoot), RUNS_DIR);
}

/** Minimal exec shape shared by services (mirrors pi.exec). */
export interface ExecFn {
	(
		command: string,
		args: string[],
		options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
	): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
}

/**
 * Project root detection:
 *   1. `git rev-parse --show-toplevel` when the cwd is inside a git repo.
 *   2. Fall back to `cwd` for non-git projects.
 */
export async function findProjectRoot(cwd: string, exec: ExecFn): Promise<string> {
	try {
		const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
		if (result.code === 0) {
			const root = result.stdout.trim();
			if (root.length > 0) return root;
		}
	} catch {
		// git unavailable or not a repo — fall through to cwd.
	}
	return cwd;
}

async function readOptionalText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * True for POSIX absolute (`/x`), Windows drive (`C:\x`, `C:/x`, `C:x`) and
 * Windows root/UNC absolute (`\x`, `\\server\share`) path forms. These are
 * rejected before any resolution so a nested project can never point outside
 * the repository regardless of the host platform.
 */
function isAbsoluteStyleProjectDir(value: string): boolean {
	if (value.startsWith("/") || value.startsWith("\\")) return true;
	return /^[A-Za-z]:/.test(value);
}

/**
 * Resolve the optional project.yaml `project_dir` into the safe effective
 * project root. Rules:
 *   - omitted or `"."` → the repository root itself (backward compatible);
 *   - POSIX/Windows absolute paths are rejected;
 *   - paths that resolve outside the repository via `..` are rejected;
 *   - the target must exist and be a directory;
 *   - the real (symlink-free) target must stay inside the real repository
 *     root — an escaping symlink is rejected, an inside symlink is fine;
 *   - on any violation the caller gets the repository root plus an issue
 *     message (the effective root never points outside the repository and
 *     no content outside the repository is ever accessed).
 */
export async function resolveEffectiveProjectRoot(
	projectRoot: string,
	projectDir: string | undefined,
): Promise<{ root: string; issue?: string }> {
	if (projectDir === undefined || projectDir === ".") return { root: projectRoot };
	if (projectDir.length === 0) {
		return { root: projectRoot, issue: '"project_dir" must be a non-empty relative path' };
	}
	if (isAbsoluteStyleProjectDir(projectDir)) {
		return { root: projectRoot, issue: `"project_dir" must be a relative path inside the project root (got "${projectDir}")` };
	}
	const lex = lexicalContain(projectRoot, projectDir);
	if (lex === undefined) {
		return { root: projectRoot, issue: `"project_dir" resolves outside the project root: ${projectDir}` };
	}
	let stats;
	try {
		stats = await stat(lex);
	} catch {
		return { root: projectRoot, issue: `"project_dir" does not exist or is not readable: ${projectDir}` };
	}
	if (!stats.isDirectory()) {
		return { root: projectRoot, issue: `"project_dir" is not a directory: ${projectDir}` };
	}
	const rootReal = (await realpath(projectRoot).catch(() => resolve(projectRoot))) ?? resolve(projectRoot);
	const targetReal = await realpath(lex).catch(() => undefined);
	if (targetReal === undefined) {
		return { root: projectRoot, issue: `"project_dir" cannot be resolved: ${projectDir}` };
	}
	if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
		return { root: projectRoot, issue: `"project_dir" escapes the project root via a symlink: ${projectDir}` };
	}
	return { root: targetReal };
}

/**
 * Load and parse the workbench configuration for a project root.
 * Refuses (throws UntrustedProjectError) before reading anything when
 * `trusted` is false. Missing files are fine (empty config); invalid YAML and
 * invalid recipes are collected as issues, never thrown.
 */
export async function loadProjectConfig(projectRoot: string, options: { trusted: boolean }): Promise<ProjectConfig> {
	if (!options.trusted) throw new UntrustedProjectError(projectRoot);
	const dir = workbenchDir(projectRoot);
	const issues: ConfigIssue[] = [];

	const documents = new Map<string, unknown>();
	for (const file of CONFIG_FILES) {
		const content = await readOptionalText(join(dir, file));
		if (content === undefined) continue;
		try {
			const doc = parseYaml(content);
			if (doc === null || doc === undefined) continue;
			if (typeof doc !== "object" || Array.isArray(doc)) {
				issues.push({ file, message: "document root must be a YAML mapping" });
				continue;
			}
			documents.set(file, doc);
		} catch (error) {
			issues.push({ file, message: `invalid YAML: ${(error as Error).message}` });
		}
	}

	const projectDoc = documents.get("project.yaml") as Record<string, unknown> | undefined;
	const projectName = typeof projectDoc?.name === "string" ? projectDoc.name : undefined;
	const description = typeof projectDoc?.description === "string" ? projectDoc.description : undefined;
	const profile = typeof projectDoc?.profile === "string" ? projectDoc.profile : undefined;
	if (projectDoc !== undefined && profile === undefined) {
		issues.push({ file: "project.yaml", message: '"profile" is missing (expected one of the profiles in profiles.yaml)' });
	}

	// Optional nested project directory. Invalid values (non-string, empty,
	// absolute, escaping, missing, non-directory) become project.yaml issues
	// and fall back to the repository root — the effective root is never
	// outside the repository and config stays inspectable.
	let projectDir: string | undefined;
	if (projectDoc?.project_dir !== undefined) {
		if (typeof projectDoc.project_dir !== "string") {
			issues.push({ file: "project.yaml", message: '"project_dir" must be a string' });
		} else {
			projectDir = projectDoc.project_dir;
		}
	}
	const effective = await resolveEffectiveProjectRoot(projectRoot, projectDir);
	if (effective.issue !== undefined) {
		issues.push({ file: "project.yaml", message: effective.issue });
	}

	// P6-A: telemetry opt-out. project.yaml: cache: { telemetry: false }.
	let cacheTelemetry = true;
	// P6-C: action-cache capacity. project.yaml: cache: { actionCache: { maxBytes: N } }.
	let actionCacheMaxBytes = DEFAULT_ACTION_CACHE_MAX_BYTES;
	const cacheDoc = projectDoc?.cache;
	if (cacheDoc !== undefined && (typeof cacheDoc !== "object" || Array.isArray(cacheDoc))) {
		issues.push({ file: "project.yaml", message: '"cache" must be a mapping (e.g. cache: { telemetry: false })' });
	} else if (cacheDoc !== undefined) {
		const cacheMap = cacheDoc as Record<string, unknown>;
		if (cacheMap.telemetry !== undefined && typeof cacheMap.telemetry !== "boolean") {
			issues.push({ file: "project.yaml", message: '"cache.telemetry" must be a boolean' });
		} else {
			cacheTelemetry = cacheMap.telemetry !== false;
		}
		const actionCacheDoc = cacheMap.actionCache;
		if (actionCacheDoc !== undefined && (typeof actionCacheDoc !== "object" || Array.isArray(actionCacheDoc))) {
			issues.push({ file: "project.yaml", message: '"cache.actionCache" must be a mapping (e.g. { maxBytes: 268435456 })' });
		} else if (actionCacheDoc !== undefined) {
			const maxBytes = (actionCacheDoc as Record<string, unknown>).maxBytes;
			if (maxBytes !== undefined && (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes <= 0)) {
				issues.push({ file: "project.yaml", message: '"cache.actionCache.maxBytes" must be a positive integer' });
			} else if (typeof maxBytes === "number") {
				actionCacheMaxBytes = maxBytes;
			}
		}
	}

	// P7 (commander-token-optimization plan §6): optional observation-only
	// commander advisory thresholds. project.yaml:
	//   commander:
	//     advisory:
	//       soft: { requests: 200, gross_tokens: 25000000, ... }
	//       high: { requests: 300, gross_tokens: 40000000, ... }
	// Each value must be a positive safe integer and each high value must be
	// greater than its soft value; missing fields inherit the documented
	// defaults; invalid fields/ordering become bounded project.yaml
	// ConfigIssue records (hard-capped) and fall back to the defaults —
	// observability is never disabled and nothing throws.
	const commanderDoc = projectDoc?.commander;
	if (commanderDoc !== undefined && (typeof commanderDoc !== "object" || commanderDoc === null || Array.isArray(commanderDoc))) {
		issues.push({
			file: "project.yaml",
			message: '"commander" must be a mapping (e.g. commander: { advisory: { soft: {...}, high: {...} } })',
		});
	}
	const advisoryDoc =
		typeof commanderDoc === "object" && commanderDoc !== null
			? (commanderDoc as Record<string, unknown>).advisory
			: undefined;
	const parsedAdvisory = parseAdvisoryConfig(advisoryDoc);
	for (const message of parsedAdvisory.issues) {
		issues.push({ file: "project.yaml", message });
	}

	const recipesDoc = documents.get("recipes.yaml");
	const parsed = parseRecipesDocument(recipesDoc);
	for (const message of parsed.errors) issues.push({ file: "recipes.yaml", message });
	for (const message of parsed.warnings) issues.push({ file: "recipes.yaml", message });

	const gatesDoc = documents.get("gates.yaml") as Record<string, unknown> | undefined;
	const gates = Array.isArray(gatesDoc?.gates) ? (gatesDoc.gates as unknown[]) : [];
	if (gatesDoc !== undefined && !Array.isArray(gatesDoc?.gates)) {
		issues.push({ file: "gates.yaml", message: 'expected a mapping with a "gates" list' });
	}

	const profilesDoc = documents.get("profiles.yaml") as Record<string, unknown> | undefined;
	let profiles = Array.isArray(profilesDoc?.profiles) ? (profilesDoc.profiles as unknown[]) : [];
	if (profilesDoc !== undefined && !Array.isArray(profilesDoc?.profiles)) {
		issues.push({ file: "profiles.yaml", message: 'expected a mapping with a "profiles" list' });
	}
	// P6-B: deterministic profile order — sorted by name, never YAML order.
	profiles = [...profiles].sort((a, b) => {
		const nameA = typeof a === "object" && a !== null && typeof (a as Record<string, unknown>).name === "string" ? ((a as Record<string, unknown>).name as string) : "";
		const nameB = typeof b === "object" && b !== null && typeof (b as Record<string, unknown>).name === "string" ? ((b as Record<string, unknown>).name as string) : "";
		return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
	});

	return {
		projectRoot,
		projectDir,
		effectiveProjectRoot: effective.root,
		projectName,
		description,
		profile,
		recipes: parsed.recipes,
		gates,
		profiles,
		issues,
		cacheTelemetry,
		actionCacheMaxBytes,
		commanderAdvisory: parsedAdvisory.config,
	};
}
