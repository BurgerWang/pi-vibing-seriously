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

import { lstat, realpath, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { parseRecipesDocument, type Recipe } from "./recipe-schema.ts";
import { DEFAULT_ACTION_CACHE_MAX_BYTES } from "../cache/action-types.ts";
import { lexicalContain } from "./path-guard.ts";
import { parseAdvisoryConfig, type AdvisoryConfig } from "./commander-advisory.ts";
import { BOUNDED_FILE_MAX_BYTES, readUtf8FileBounded } from "./bounded-file-io.ts";

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

/**
 * A present configuration path could not be read as one stable regular UTF-8
 * file.  This is deliberately distinct from ENOENT: callers may treat a
 * genuinely absent optional file as empty configuration, but must never turn
 * permission, type, encoding, size, or concurrent-replacement failures into
 * a silently smaller configuration.
 */
export class ConfigFileReadError extends Error {
	constructor(path: string, reason: string) {
		super(`workbench configuration unavailable: ${path} (${reason})`);
		this.name = "ConfigFileReadError";
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
	/** Explicitly authorized, realpath-resolved roots for v2 recipe artifacts. */
	artifactExternalRoots: Readonly<Record<string, string>>;
	/**
	 * P7 (commander-token-optimization plan §6): observation-only commander
	 * advisory thresholds (project.yaml commander.advisory.soft/high). Always
	 * fully resolved — every missing/invalid field inherits the documented
	 * defaults; invalid fields/ordering are recorded as bounded project.yaml
	 * ConfigIssue records and never disable observability.
	 */
	commanderAdvisory: AdvisoryConfig;
}

/**
 * A caller-owned, already-parsed gates document. The wrapper is intentional:
 * `{ value: undefined }` means the caller has authoritatively observed an
 * absent/empty gates.yaml and the generic loader must NOT fall back to reading
 * the path again. Callers that omit this option retain the historical generic
 * config-loading behaviour unchanged.
 */
export interface ParsedGatesDocumentOverride {
	readonly value: unknown;
}

export interface LoadProjectConfigOptions {
	trusted: boolean;
	/** Internal authority hand-off for bounded gate-loading paths. */
	parsedGatesDocument?: ParsedGatesDocumentOverride;
}

/**
 * The bounded project.yaml projection needed by status/footer/telemetry paths.
 * It deliberately excludes recipes, gates, profiles and all authority-bearing
 * configuration so those files are not parsed on every UI refresh.
 */
export interface ProjectStatusConfig {
	readonly profile: string | undefined;
	readonly cacheTelemetry: boolean;
	readonly commanderAdvisory: AdvisoryConfig;
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

function samePathIdentity(
	stats: BigIntStats,
	source: { dev?: number; ino?: number; fileSize: number; mtimeNs?: string },
): boolean {
	return stats.isFile()
		&& source.dev !== undefined
		&& source.ino !== undefined
		&& Number(stats.dev) === source.dev
		&& Number(stats.ino) === source.ino
		&& Number(stats.size) === source.fileSize
		&& (source.mtimeNs === undefined || stats.mtimeNs.toString(10) === source.mtimeNs);
}

async function readOptionalText(path: string): Promise<string | undefined> {
	let before: BigIntStats;
	try {
		before = await lstat(path, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new ConfigFileReadError(path, "path metadata unavailable");
	}
	if (!before.isFile()) throw new ConfigFileReadError(path, "source is not a regular file");
	const read = await readUtf8FileBounded(path, BOUNDED_FILE_MAX_BYTES);
	if (!read.ok) throw new ConfigFileReadError(path, read.error.code);
	if (!samePathIdentity(before, read.value.source)) {
		throw new ConfigFileReadError(path, "source identity changed before read");
	}
	let after: BigIntStats;
	try {
		after = await lstat(path, { bigint: true });
	} catch {
		throw new ConfigFileReadError(path, "source identity changed after read");
	}
	if (!samePathIdentity(after, read.value.source)) {
		throw new ConfigFileReadError(path, "source identity changed after read");
	}
	return read.value.text;
}

/**
 * Read only the non-authoritative project.yaml fields used by hot status paths.
 * Trust and bounded/same-identity file checks are identical to the full loader;
 * missing, malformed or non-mapping YAML preserves the historical defaults.
 */
export async function loadProjectStatusConfig(
	projectRoot: string,
	options: Pick<LoadProjectConfigOptions, "trusted">,
): Promise<ProjectStatusConfig> {
	if (!options.trusted) throw new UntrustedProjectError(projectRoot);
	const content = await readOptionalText(join(workbenchDir(projectRoot), "project.yaml"));
	let projectDoc: Record<string, unknown> | undefined;
	if (content !== undefined) {
		try {
			const parsed: unknown = parseYaml(content);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				projectDoc = parsed as Record<string, unknown>;
			}
		} catch {
			// Full config loading records the YAML issue and leaves these fields at
			// defaults. This bounded projection has no issue surface of its own.
		}
	}

	const profile = typeof projectDoc?.profile === "string" ? projectDoc.profile : undefined;
	let cacheTelemetry = true;
	const cacheDoc = projectDoc?.cache;
	if (cacheDoc !== undefined && typeof cacheDoc === "object" && cacheDoc !== null && !Array.isArray(cacheDoc)) {
		const telemetry = (cacheDoc as Record<string, unknown>).telemetry;
		if (telemetry === false) cacheTelemetry = false;
	}
	const commanderDoc = projectDoc?.commander;
	const advisoryDoc = typeof commanderDoc === "object" && commanderDoc !== null && !Array.isArray(commanderDoc)
		? (commanderDoc as Record<string, unknown>).advisory
		: undefined;

	return Object.freeze({
		profile,
		cacheTelemetry,
		commanderAdvisory: parseAdvisoryConfig(advisoryDoc).config,
	});
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
export async function loadProjectConfig(projectRoot: string, options: LoadProjectConfigOptions): Promise<ProjectConfig> {
	if (!options.trusted) throw new UntrustedProjectError(projectRoot);
	const dir = workbenchDir(projectRoot);
	const issues: ConfigIssue[] = [];

	const documents = new Map<string, unknown>();
	for (const file of CONFIG_FILES) {
		let doc: unknown;
		if (file === "gates.yaml" && options.parsedGatesDocument !== undefined) {
			// The gate engine already obtained and parsed this document through its
			// fixed-size, same-handle reader. Presence of the wrapper is an
			// authority transfer: never touch gates.yaml again in this load.
			doc = options.parsedGatesDocument.value;
		} else {
			const content = await readOptionalText(join(dir, file));
			if (content === undefined) continue;
			try {
				doc = parseYaml(content);
			} catch (error) {
				issues.push({ file, message: `invalid YAML: ${(error as Error).message}` });
				continue;
			}
		}
		if (doc === null || doc === undefined) continue;
		if (typeof doc !== "object" || Array.isArray(doc)) {
			issues.push({ file, message: "document root must be a YAML mapping" });
			continue;
		}
		documents.set(file, doc);
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

	const artifactExternalRoots: Record<string, string> = {};
	const externalRootsDoc = projectDoc?.artifact_external_roots;
	if (externalRootsDoc !== undefined && (typeof externalRootsDoc !== "object" || externalRootsDoc === null || Array.isArray(externalRootsDoc))) {
		issues.push({ file: "project.yaml", message: '"artifact_external_roots" must be a mapping of name to absolute directory' });
	} else if (externalRootsDoc !== undefined) {
		for (const [name, value] of Object.entries(externalRootsDoc as Record<string, unknown>)) {
			if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || typeof value !== "string" || !isAbsoluteStyleProjectDir(value)) {
				issues.push({ file: "project.yaml", message: `artifact external root "${name}" must name an absolute directory` });
				continue;
			}
			try {
				const resolvedRoot = await realpath(value);
				const rootStats = await stat(resolvedRoot);
				if (!rootStats.isDirectory()) throw new Error("not a directory");
				artifactExternalRoots[name] = resolvedRoot;
			} catch {
				issues.push({ file: "project.yaml", message: `artifact external root "${name}" is unavailable or not a directory` });
			}
		}
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
		artifactExternalRoots,
		commanderAdvisory: parsedAdvisory.config,
	};
}
