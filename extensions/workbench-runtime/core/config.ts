/**
 * Workbench project configuration — loading and parsing.
 *
 * Config lives in `<project-root>/<CONFIG_DIR_NAME>/workbench/` where
 * CONFIG_DIR_NAME is Pi's official export (".pi" by default — never hardcoded
 * here). Supported files:
 *
 *   - project.yaml  — project name, description, selected profile
 *   - recipes.yaml  — declarative recipes (see recipe-schema.ts)
 *   - gates.yaml    — reserved: gate declarations (parsed, not enforced in P1)
 *   - profiles.yaml — profile definitions (parsed, not enforced in P1)
 *
 * Trust: the caller must pass `trusted` (from ctx.isProjectTrusted()). An
 * untrusted project is rejected before any file is read.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { parseRecipesDocument, type Recipe } from "./recipe-schema.ts";

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
	projectRoot: string;
	projectName: string | undefined;
	description: string | undefined;
	profile: string | undefined;
	recipes: Recipe[];
	gates: unknown[];
	profiles: unknown[];
	issues: ConfigIssue[];
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

	const recipesDoc = documents.get("recipes.yaml");
	const parsed = parseRecipesDocument(recipesDoc);
	for (const message of parsed.errors) issues.push({ file: "recipes.yaml", message });

	const gatesDoc = documents.get("gates.yaml") as Record<string, unknown> | undefined;
	const gates = Array.isArray(gatesDoc?.gates) ? (gatesDoc.gates as unknown[]) : [];
	if (gatesDoc !== undefined && !Array.isArray(gatesDoc?.gates)) {
		issues.push({ file: "gates.yaml", message: 'expected a mapping with a "gates" list' });
	}

	const profilesDoc = documents.get("profiles.yaml") as Record<string, unknown> | undefined;
	const profiles = Array.isArray(profilesDoc?.profiles) ? (profilesDoc.profiles as unknown[]) : [];
	if (profilesDoc !== undefined && !Array.isArray(profilesDoc?.profiles)) {
		issues.push({ file: "profiles.yaml", message: 'expected a mapping with a "profiles" list' });
	}

	return { projectRoot, projectName, description, profile, recipes: parsed.recipes, gates, profiles, issues };
}
