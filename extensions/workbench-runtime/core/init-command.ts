/** Project bootstrap command controller. */

import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { applyInit, planInit, renderInitPlan } from "./init.ts";
import { INIT_PROFILES, isSupportedInitProfile } from "./templates.ts";

export interface InitCommandController {
	pi: Pick<ExtensionAPI, "registerCommand">;
	trustedOrError(ctx: ExtensionCommandContext): string | undefined;
	projectRootFor(ctx: ExtensionCommandContext): Promise<string>;
	output(ctx: ExtensionCommandContext, lines: string[]): void;
}

/** Register the preview-confirm-apply bootstrap lifecycle as one domain. */
export function registerInitCommand(controller: InitCommandController): void {
	controller.pi.registerCommand("q-init", {
		description:
			"Initialize .pi/workbench configuration for a profile: generic | quant-research/stock-selection | quant-research/market-timing",
		handler: async (args, ctx) => {
			const profile = args.trim().split(/\s+/)[0] ?? "";
			if (!isSupportedInitProfile(profile)) {
				controller.output(ctx, [
					`/q-init: unsupported profile "${profile || "(empty)"}"`,
					`supported profiles: ${INIT_PROFILES.join(", ")}`,
					"unsupported (by design): hft, market-making, lob, execution-engine",
				]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-init: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);

			const preview = await planInit(projectRoot, profile, {
				exists,
				confirmOverwrite: async () => false,
			});
			controller.output(ctx, [...renderInitPlan(preview, CONFIG_DIR_NAME), ""]);

			const overwrite = new Set<string>();
			if (ctx.hasUI) {
				for (const entry of preview.entries) {
					if (entry.action !== "skip") continue;
					const confirmed = await ctx.ui.confirm(
						"Overwrite?",
						`${CONFIG_DIR_NAME}/workbench/${entry.file} already exists. Overwrite it?`,
					);
					if (confirmed) overwrite.add(entry.file);
				}
			}

			const plan = await planInit(projectRoot, profile, {
				exists,
				confirmOverwrite: async (file) => overwrite.has(file),
			});
			await applyInit(plan, {
				exists,
				write: async (path, content) => {
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, content, "utf8");
				},
			});

			const written = plan.entries.filter((entry) => entry.action !== "skip").length;
			const skipped = plan.entries.filter((entry) => entry.action === "skip").length;
			controller.output(ctx, [
				`Workbench initialized for profile "${profile}" in ${projectRoot}`,
				`${written} file(s) written, ${skipped} existing file(s) left untouched`,
				"",
				"Next steps:",
				"  1. Exit Pi",
				"  2. Re-enter the project directory",
				"  3. Approve project trust when prompted (project config is only read under trust)",
				"",
				`Config files live in ${CONFIG_DIR_NAME}/workbench/ (project.yaml, recipes.yaml, gates.yaml, profiles.yaml).`,
				"AGENTS.md (project root) was selected from the profile's AGENTS template.",
				"Existing files, including an existing AGENTS.md, are never overwritten by default.",
				"Add declarative recipes to recipes.yaml — the workbench only runs declared commands.",
			]);
		},
	});
}
