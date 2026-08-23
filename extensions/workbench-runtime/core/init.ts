/**
 * Workbench q-init service — planning and applying project initialization.
 * Pure logic with injected filesystem access so it is fully unit-testable.
 *
 * Flow (per P1/P2):
 *   1. Plan: compute the files a profile would write, checking which already
 *      exist. Existing files default to NOT overwritten.
 *   2. Display the plan before anything is written (done by the command).
 *   3. Overwrites require per-file confirmation (done by the command via
 *      ctx.ui.confirm; skipped in print/json modes where there is no UI).
 *   4. Apply: create the workbench directory and write the template files.
 *
 * P2: each profile also plans an AGENTS.md at the project root, selected by
 * profile (generic → AGENTS.generic.md, quant profiles →
 * AGENTS.quant-research.md). An existing AGENTS.md is never overwritten by
 * default — only after explicit confirmation.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { getInitTemplate, isSupportedInitProfile, type InitProfile } from "./templates.ts";
import { workbenchDir } from "./config.ts";
import { detectStacksFromTopLevel } from "./inspect.ts";
import type { ValidationComponent } from "./recipe-schema.ts";

export type InitAction = "create" | "skip" | "overwrite";

export interface InitPlanEntry {
	file: string;
	path: string;
	action: InitAction;
}

export interface InitPlan {
	profile: InitProfile;
	projectRoot: string;
	workbenchDir: string;
	entries: InitPlanEntry[];
	/** Immutable content snapshot used by apply; preview and apply cannot drift. */
	contents: Record<string, string>;
	agentsFile: string;
	recipePreset: string;
}

export interface InitIO {
	exists(path: string): Promise<boolean>;
	confirmOverwrite(file: string): Promise<boolean>;
}

/** The file name of the project-root AGENTS entry in the plan. */
export const AGENTS_ENTRY_FILE = "AGENTS.md";

/**
 * Plan the initialization without writing anything. `io.exists` decides which
 * files already exist; `io.confirmOverwrite` is consulted per existing file
 * (return false to keep the default non-destructive behavior).
 */
export async function planInit(projectRoot: string, profile: string, io: InitIO): Promise<InitPlan> {
	if (!isSupportedInitProfile(profile)) {
		throw new Error(
			`unsupported profile "${profile}" — supported: ${["generic", "quant-research/stock-selection", "quant-research/market-timing"].join(", ")}`,
		);
	}
	const loaded = await getInitTemplate(profile);
	let recipePreset = "profile-static";
	const contents = { ...loaded.files };
	if (profile === "generic") {
		const generated = await generateGenericRecipes(projectRoot);
		contents["recipes.yaml"] = generated.content;
		recipePreset = generated.preset;
	}
	const dir = workbenchDir(projectRoot);
	const entries: InitPlanEntry[] = [];
	for (const file of Object.keys(contents)) {
		const path = join(dir, file);
		entries.push({ file, path, action: await actionFor(path, file, io) });
	}
	// AGENTS.md lives at the project root (not inside .pi/workbench/) and is
	// selected by profile. Existing AGENTS.md defaults to skip.
	const agentsPath = join(projectRoot, AGENTS_ENTRY_FILE);
	entries.push({ file: AGENTS_ENTRY_FILE, path: agentsPath, action: await actionFor(agentsPath, AGENTS_ENTRY_FILE, io) });
	return {
		profile: loaded.profile,
		projectRoot,
		workbenchDir: dir,
		entries,
		contents,
		agentsFile: loaded.agentsFile,
		recipePreset,
	};
}

interface GeneratedRecipes {
	preset: string;
	content: string;
}

interface GeneratedRecipe {
	name: string;
	description: string;
	command: string[];
	cwd: string;
	timeout_ms: number;
	allowed_modes: string[];
	expected_exit_codes: number[];
	writes: string[];
	mutation: "none" | "artifacts";
	artifacts: string[];
	environment: string[];
	validation_components: ValidationComponent[];
	output_strategy: "tail";
	max_lines: number;
	max_bytes: number;
}

const recipe = (
	name: string,
	description: string,
	command: string[],
	validationComponents: ValidationComponent[],
	options: { timeout?: number; writes?: string[]; artifacts?: string[] } = {},
): GeneratedRecipe => ({
	name,
	description,
	command,
	cwd: ".",
	timeout_ms: options.timeout ?? 120_000,
	allowed_modes: ["DEV", "VERIFY"],
	expected_exit_codes: [0],
	writes: [...(options.writes ?? [])],
	mutation: (options.writes?.length ?? 0) > 0 ? "artifacts" : "none",
	artifacts: [...(options.artifacts ?? [])],
	environment: [],
	validation_components: validationComponents,
	output_strategy: "tail",
	max_lines: 2_000,
	max_bytes: 51_200,
});

function renderGeneratedRecipes(preset: string, detected: string, recipes: GeneratedRecipe[]): string {
	const configured = recipes.length > 0
		? `# Stack-detected executable preset: ${preset}. Review commands before first use.`
		: "# NOT_CONFIGURED: no unambiguous executable preset could be inferred; declare and review project commands explicitly.";
	return [
		"# Declarative recipes generated by /q-init generic.",
		`# Detected stack: ${detected || "none"}.`,
		configured,
		stringifyYaml({ recipes }, { lineWidth: 120 }).trimEnd(),
		"",
	].join("\n");
}

function packageManagerCommand(topLevel: readonly string[]): { manager: string; prefix: string[] } | undefined {
	const detected = [
		topLevel.includes("package-lock.json") ? "npm" : undefined,
		topLevel.includes("pnpm-lock.yaml") ? "pnpm" : undefined,
		topLevel.includes("yarn.lock") ? "yarn" : undefined,
		topLevel.includes("bun.lockb") || topLevel.includes("bun.lock") ? "bun" : undefined,
	].filter((value): value is string => value !== undefined);
	if (detected.length > 1) return undefined;
	if (detected[0] === "pnpm") return { manager: "pnpm", prefix: ["pnpm", "run"] };
	if (detected[0] === "yarn") return { manager: "yarn", prefix: ["yarn", "run"] };
	if (detected[0] === "bun") return { manager: "bun", prefix: ["bun", "run"] };
	return { manager: "npm", prefix: ["npm", "run"] };
}

async function readPackageScripts(projectRoot: string): Promise<Set<string>> {
	try {
		const raw = await readFile(join(projectRoot, "package.json"), "utf8");
		if (Buffer.byteLength(raw, "utf8") > 262_144) return new Set();
		const parsed = JSON.parse(raw) as { scripts?: unknown };
		if (!parsed.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) return new Set();
		return new Set(Object.entries(parsed.scripts).filter(([, value]) => typeof value === "string").map(([name]) => name));
	} catch {
		return new Set();
	}
}

async function generateGenericRecipes(projectRoot: string): Promise<GeneratedRecipes> {
	let topLevel: string[] = [];
	try {
		topLevel = (await readdir(projectRoot, { withFileTypes: true })).map((entry) => entry.name).sort();
	} catch {
		// An unreadable project root produces an explicit NOT_CONFIGURED template.
	}
	const stacks = detectStacksFromTopLevel(topLevel);
	const detected = stacks.map((stack) => stack.language).join(", ");
	if (stacks.some((stack) => stack.language === "JavaScript/TypeScript")) {
		const scripts = await readPackageScripts(projectRoot);
		const pm = packageManagerCommand(topLevel);
		if (!pm) {
			return {
				preset: "javascript-typescript/not-configured-ambiguous-package-manager",
				content: renderGeneratedRecipes("javascript-typescript/not-configured-ambiguous-package-manager", detected, []),
			};
		}
		const selected: GeneratedRecipe[] = [];
		const mappings = [
			{ candidates: ["format:check", "check:format"], name: "check:format", component: "whitespace" },
			// Lint is useful feedback, but it is not the framework's narrowly
			// defined whitespace component. Do not manufacture component coverage.
			{ candidates: ["lint", "check:lint"], name: "check:lint", component: undefined },
			{ candidates: ["typecheck", "check:typecheck"], name: "check:typecheck", component: "typecheck" },
			{ candidates: ["test:unit", "test"], name: "test:unit", component: "unit-test" },
		] as const;
		for (const mapping of mappings) {
			const script = mapping.candidates.find((candidate) => scripts.has(candidate));
			if (!script) continue;
			selected.push(recipe(mapping.name, `Run package script ${script}`, [...pm.prefix, script], mapping.component ? [mapping.component] : [], {
				timeout: mapping.name === "test:unit" ? 300_000 : 120_000,
			}));
		}
		return {
			preset: selected.length > 0 ? `javascript-typescript/${pm.manager}` : "javascript-typescript/not-configured",
			content: renderGeneratedRecipes(`javascript-typescript/${pm.manager}`, detected, selected),
		};
	}
	if (stacks.some((stack) => stack.language === "Go")) {
		const recipes = [
			recipe("check:static", "Run Go vet without changing module files", ["go", "vet", "-mod=readonly", "./..."], ["typecheck"]),
			recipe("test:unit", "Run Go tests without changing module files", ["go", "test", "-mod=readonly", "./..."], ["unit-test"], { timeout: 300_000 }),
		];
		return { preset: "go", content: renderGeneratedRecipes("go", detected, recipes) };
	}
	if (stacks.some((stack) => stack.language === "Rust")) {
		if (!topLevel.includes("Cargo.lock")) {
			return {
				preset: "rust/not-configured-no-lockfile",
				content: renderGeneratedRecipes("rust/not-configured-no-lockfile", detected, []),
			};
		}
		// Cargo writes build intermediates under target/, but those files are not
		// useful workbench artifacts and must not be recursively inventoried.
		const output = { writes: ["target/**"] };
		const recipes = [
			recipe("check:static", "Run Cargo check against the committed lockfile", ["cargo", "check", "--locked"], ["typecheck"], output),
			recipe("test:unit", "Run Cargo tests against the committed lockfile", ["cargo", "test", "--locked"], ["unit-test"], { ...output, timeout: 300_000 }),
		];
		return { preset: "rust", content: renderGeneratedRecipes("rust", detected, recipes) };
	}
	return { preset: detected ? `${detected.toLowerCase()}/not-configured` : "not-configured", content: renderGeneratedRecipes("none", detected, []) };
}

async function actionFor(path: string, file: string, io: InitIO): Promise<InitAction> {
	const exists = await io.exists(path);
	if (!exists) return "create";
	const overwrite = await io.confirmOverwrite(file);
	return overwrite ? "overwrite" : "skip";
}

/** Render the plan as display lines (must be shown BEFORE applying). */
export function renderInitPlan(plan: InitPlan, configDirName: string): string[] {
	const created = plan.entries.filter((e) => e.action === "create").map(displayName);
	const overwritten = plan.entries.filter((e) => e.action === "overwrite").map(displayName);
	const skipped = plan.entries.filter((e) => e.action === "skip").map(displayName);
	const lines = [
		`Initializing workbench profile "${plan.profile}" in ${plan.projectRoot}`,
		`Config directory: ${configDirName}/workbench/`,
		`Recipe preset: ${plan.recipePreset}`,
	];
	if (created.length > 0) lines.push("Will create:", ...created.map((f) => `  + ${f}`));
	if (overwritten.length > 0) lines.push("Will overwrite (confirmed):", ...overwritten.map((f) => `  ~ ${f}`));
	if (skipped.length > 0) lines.push("Already exists — will NOT overwrite:", ...skipped.map((f) => `  - ${f}`));
	return lines;
}

/**
 * Combine freshly rechecked file actions with the exact bytes shown in an
 * earlier preview. A mismatched project/profile is never silently combined.
 */
export function retainInitContentSnapshot(currentActions: InitPlan, preview: InitPlan): InitPlan {
	if (currentActions.projectRoot !== preview.projectRoot || currentActions.profile !== preview.profile ||
		currentActions.workbenchDir !== preview.workbenchDir) {
		throw new Error("init preview identity changed before apply");
	}
	return {
		...currentActions,
		contents: preview.contents,
		agentsFile: preview.agentsFile,
		recipePreset: preview.recipePreset,
	};
}

function displayName(entry: InitPlanEntry): string {
	return entry.file === AGENTS_ENTRY_FILE ? "AGENTS.md (project root)" : entry.file;
}

/** Write the planned files (create + overwrite entries only). */
export async function applyInit(plan: InitPlan, io: Pick<InitIO, "exists"> & { write(path: string, content: string, action: Exclude<InitAction, "skip">): Promise<void> }): Promise<void> {
	for (const entry of plan.entries) {
		if (entry.action === "skip") continue;
		const content = entry.file === AGENTS_ENTRY_FILE ? plan.agentsFile : plan.contents[entry.file];
		if (content === undefined) continue;
		await io.write(entry.path, content, entry.action);
	}
}
