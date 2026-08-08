/**
 * Workbench project inspection — powers `workbench_project_inspect` and
 * `/q-status`-adjacent reporting. Pure logic with injected exec.
 *
 * Returns project root, git state, detected language/package manager, the
 * workbench profile, available recipes, and config errors. Never emits
 * secrets: no env values, no credentials, only names and status.
 */

import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

import { loadProjectConfig, workbenchDir, type ConfigIssue, type ExecFn } from "./config.ts";
import type { ValidationComponent } from "./recipe-schema.ts";

export interface DetectedStack {
	language: string;
	package_manager: string | null;
	evidence: string[];
}

export interface ProjectInspectResult {
	project_root: string;
	/** Safe effective project root (project.yaml project_dir; repo root by default). */
	effective_project_root: string;
	git: { is_git: boolean; commit: string | null; dirty: boolean; branch: string | null };
	stacks: DetectedStack[];
	profile: string | undefined;
	project_name: string | undefined;
	recipes: {
		name: string;
		description: string;
		allowed_modes: string[];
		command: string[];
		/** Phase 2B: the recipe's exact declared validation components (closed set, [] when none declared). */
		validation_components: ValidationComponent[];
	}[];
	config_errors: ConfigIssue[];
	config_files_present: string[];
}

/** Top-level manifest files that indicate a language/package-manager stack. */
const STACK_DETECTORS: readonly { language: string; package_manager: string | null; files: readonly string[] }[] = [
	{ language: "JavaScript/TypeScript", package_manager: null, files: ["package.json"] },
	{ language: "Python", package_manager: null, files: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"] },
	{ language: "Go", package_manager: null, files: ["go.mod"] },
	{ language: "Rust", package_manager: null, files: ["Cargo.toml"] },
	{ language: "Java", package_manager: null, files: ["pom.xml", "build.gradle", "build.gradle.kts"] },
	{ language: "C#", package_manager: null, files: ["*.csproj", "*.sln"] },
	{ language: "Ruby", package_manager: null, files: ["Gemfile"] },
];

const LOCKFILE_PM: readonly { file: string; pm: string; language: string }[] = [
	{ file: "package-lock.json", pm: "npm", language: "JavaScript/TypeScript" },
	{ file: "pnpm-lock.yaml", pm: "pnpm", language: "JavaScript/TypeScript" },
	{ file: "yarn.lock", pm: "yarn", language: "JavaScript/TypeScript" },
	{ file: "bun.lockb", pm: "bun", language: "JavaScript/TypeScript" },
	{ file: "poetry.lock", pm: "poetry", language: "Python" },
	{ file: "uv.lock", pm: "uv", language: "Python" },
	{ file: "Cargo.lock", pm: "cargo", language: "Rust" },
	{ file: "go.sum", pm: "go modules", language: "Go" },
];

export async function inspectProject(projectRoot: string, options: { trusted: boolean; exec: ExecFn }): Promise<ProjectInspectResult> {
	const config = await loadProjectConfig(projectRoot, { trusted: options.trusted });
	// P8: stack detection reads ONLY the effective project root's top level
	// (project.yaml project_dir, repo root by default). Git and
	// config-files-present below stay repository-root based.
	const effectiveProjectRoot = config.effectiveProjectRoot;

	let topLevel: string[];
	try {
		// P6-B: readdir order is filesystem-dependent — sort for determinism.
		topLevel = (await readdir(effectiveProjectRoot, { withFileTypes: true })).map((e) => e.name).sort();
	} catch {
		topLevel = [];
	}

	const stacks: DetectedStack[] = [];
	for (const detector of STACK_DETECTORS) {
		const matched = detector.files.filter((f) => f.includes("*") ? topLevel.some((name) => name.endsWith(f.slice(1))) : topLevel.includes(f));
		if (matched.length === 0) continue;
		const lockfile = LOCKFILE_PM.find((l) => l.language === detector.language && topLevel.includes(l.file));
		stacks.push({
			language: detector.language,
			package_manager: lockfile?.pm ?? null,
			evidence: matched,
		});
	}

	let commit: string | null = null;
	let dirty = false;
	let branch: string | null = null;
	let isGit = false;
	try {
		const rev = await options.exec("git", ["rev-parse", "--show-toplevel"], { cwd: projectRoot });
		if (rev.code === 0 && rev.stdout.trim() === projectRoot) isGit = true;
		if (isGit) {
			const head = await options.exec("git", ["rev-parse", "HEAD"], { cwd: projectRoot });
			if (head.code === 0) commit = head.stdout.trim() || null;
			const br = await options.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot });
			if (br.code === 0) branch = br.stdout.trim() || null;
			const status = await options.exec("git", ["status", "--porcelain"], { cwd: projectRoot });
			dirty = status.code === 0 && status.stdout.trim().length > 0;
		}
	} catch {
		isGit = false;
	}

	const configFilesPresent: string[] = [];
	for (const file of ["project.yaml", "recipes.yaml", "gates.yaml", "profiles.yaml"]) {
		try {
			await access(join(workbenchDir(projectRoot), file));
			configFilesPresent.push(file);
		} catch {
			// not present
		}
	}

	return {
		project_root: projectRoot,
		effective_project_root: effectiveProjectRoot,
		git: { is_git: isGit, commit, dirty, branch },
		stacks,
		profile: config.profile,
		project_name: config.projectName,
		recipes: config.recipes.map((r) => ({
			name: r.name,
			description: r.description,
			allowed_modes: r.allowed_modes,
			command: r.command,
			validation_components: r.validation_components,
		})),
		config_errors: config.issues,
		config_files_present: configFilesPresent,
	};
}
