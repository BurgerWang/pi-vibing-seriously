/**
 * Workbench q-init templates — loaded from templates/project/ on disk.
 *
 * Three profiles:
 *   - generic                             — no quantitative content
 *   - quant-research/stock-selection      — selection workflows
 *   - quant-research/market-timing        — timing workflows
 *
 * Template files live under <package>/templates/project/:
 *   AGENTS.generic.md         — AGENTS.md content for the generic profile
 *   AGENTS.quant-research.md  — AGENTS.md content for both quant profiles
 *   generic/                  — config files (project/recipes/gates/profiles.yaml)
 *   stock-selection/          — config files
 *   market-timing/            — config files
 *
 * Templates only describe how the project invokes existing commands. The
 * workbench itself implements no backtesting engine. hft, market-making, lob
 * and execution-engine profiles are intentionally NOT supported.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type InitProfile = "generic" | "quant-research/stock-selection" | "quant-research/market-timing";

export const INIT_PROFILES: readonly InitProfile[] = [
	"generic",
	"quant-research/stock-selection",
	"quant-research/market-timing",
];

/** Profiles the workbench explicitly refuses to initialize. */
export const UNSUPPORTED_PROFILES: readonly string[] = [
	"hft",
	"market-making",
	"lob",
	"execution-engine",
];

export function isSupportedInitProfile(value: string): value is InitProfile {
	return (INIT_PROFILES as readonly string[]).includes(value);
}

export interface InitTemplate {
	profile: InitProfile;
	/** config filename → content (written into <project>/.pi/workbench/) */
	files: Record<string, string>;
	/** AGENTS.md content (written to the project root) */
	agentsFile: string;
}

const TEMPLATES_PROJECT_DIR = fileURLToPath(new URL("../../../templates/project", import.meta.url));

const CONFIG_FILES = ["project.yaml", "recipes.yaml", "gates.yaml", "profiles.yaml"] as const;

function profileDir(profile: InitProfile): string {
	switch (profile) {
		case "generic":
			return "generic";
		case "quant-research/stock-selection":
			return "stock-selection";
		case "quant-research/market-timing":
			return "market-timing";
	}
}

function agentsTemplate(profile: InitProfile): string {
	return profile === "generic" ? "AGENTS.generic.md" : "AGENTS.quant-research.md";
}

export async function getInitTemplate(profile: InitProfile): Promise<InitTemplate> {
	const dir = join(TEMPLATES_PROJECT_DIR, profileDir(profile));
	const files: Record<string, string> = {};
	for (const file of CONFIG_FILES) {
		files[file] = await readFile(join(dir, file), "utf8");
	}
	const agentsFile = await readFile(join(TEMPLATES_PROJECT_DIR, agentsTemplate(profile)), "utf8");
	return { profile, files, agentsFile };
}

/** Human-readable lines describing the template (shown by q-init before writing). */
export function describeInitTemplate(template: InitTemplate, configDirName: string): string[] {
	return [
		`profile : ${template.profile}`,
		"files   :",
		...Object.keys(template.files).map((f) => `  - ${configDirName}/workbench/${f}`),
		"  - AGENTS.md (project root)",
	];
}
