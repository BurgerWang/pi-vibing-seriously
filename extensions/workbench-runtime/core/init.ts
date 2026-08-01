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

import { join } from "node:path";

import { getInitTemplate, isSupportedInitProfile, type InitProfile } from "./templates.ts";
import { workbenchDir } from "./config.ts";

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
	const template = await getInitTemplate(profile);
	const dir = workbenchDir(projectRoot);
	const entries: InitPlanEntry[] = [];
	for (const file of Object.keys(template.files)) {
		const path = join(dir, file);
		entries.push({ file, path, action: await actionFor(path, file, io) });
	}
	// AGENTS.md lives at the project root (not inside .pi/workbench/) and is
	// selected by profile. Existing AGENTS.md defaults to skip.
	const agentsPath = join(projectRoot, AGENTS_ENTRY_FILE);
	entries.push({ file: AGENTS_ENTRY_FILE, path: agentsPath, action: await actionFor(agentsPath, AGENTS_ENTRY_FILE, io) });
	return { profile: template.profile, projectRoot, workbenchDir: dir, entries };
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
	];
	if (created.length > 0) lines.push("Will create:", ...created.map((f) => `  + ${f}`));
	if (overwritten.length > 0) lines.push("Will overwrite (confirmed):", ...overwritten.map((f) => `  ~ ${f}`));
	if (skipped.length > 0) lines.push("Already exists — will NOT overwrite:", ...skipped.map((f) => `  - ${f}`));
	return lines;
}

function displayName(entry: InitPlanEntry): string {
	return entry.file === AGENTS_ENTRY_FILE ? "AGENTS.md (project root)" : entry.file;
}

/** Write the planned files (create + overwrite entries only). */
export async function applyInit(plan: InitPlan, io: Pick<InitIO, "exists"> & { write(path: string, content: string): Promise<void> }): Promise<void> {
	const template = await getInitTemplate(plan.profile);
	for (const entry of plan.entries) {
		if (entry.action === "skip") continue;
		const content = entry.file === AGENTS_ENTRY_FILE ? template.agentsFile : template.files[entry.file];
		if (content === undefined) continue;
		await io.write(entry.path, content);
	}
}
