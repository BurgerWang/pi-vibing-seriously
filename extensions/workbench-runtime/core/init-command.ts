/** Project bootstrap command controller. */

import { access } from "node:fs/promises";

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { applyInit, planInit, renderInitPlan, retainInitContentSnapshot } from "./init.ts";
import { captureInitFileIdentity, safelyWriteInitFile, type InitFileIdentity } from "./init-safe-write.ts";
import { INIT_PROFILES, isSupportedInitProfile } from "./templates.ts";
import { runProjectCheckoutOperationV1 } from "./project-checkout-operation.ts";

export interface InitCommandController {
	pi: Pick<ExtensionAPI, "registerCommand">;
	trustedOrError(ctx: ExtensionCommandContext): string | undefined;
	projectRootFor(ctx: ExtensionCommandContext): Promise<string>;
	reconcileProjectAuthority(projectRoot: string, now: string): Promise<boolean>;
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
			const overwriteIdentity = new Map<string, InitFileIdentity>();
			if (ctx.hasUI) {
				for (const entry of preview.entries) {
					if (entry.action !== "skip") continue;
					let identity: InitFileIdentity | undefined;
					try {
						identity = await captureInitFileIdentity(projectRoot, entry.path);
					} catch {
						// A declined overwrite remains a safe skip. If the user elects
						// to overwrite, the missing identity below makes it fail closed.
					}
					const confirmed = await ctx.ui.confirm(
						"Overwrite?",
						`${entry.file === "AGENTS.md" ? "AGENTS.md (project root)" : `${CONFIG_DIR_NAME}/workbench/${entry.file}`} already exists. Overwrite it?`,
					);
					if (confirmed) {
						if (!identity) throw new Error(`q-init: ${entry.file} is not a safely bindable regular file`);
						overwrite.add(entry.file);
						overwriteIdentity.set(entry.path, identity);
					}
				}
			}

			if (!await controller.reconcileProjectAuthority(projectRoot, new Date().toISOString())) {
				controller.output(ctx, ["/q-init: checkout authority recovery is unavailable"]);
				return;
			}
			const operation = await runProjectCheckoutOperationV1({
				project_root: projectRoot,
				operation_kind: "command",
				operation_id: `command:q-init:${profile}`,
				now: new Date().toISOString(),
			}, async () => {
				const currentActions = await planInit(projectRoot, profile, {
					exists,
					confirmOverwrite: async (file) => overwrite.has(file),
				});
				// Refresh only create/skip/overwrite decisions after confirmation. The
				// bytes shown in the preview stay authoritative even if package/stack
				// detection changes while the user is deciding.
				const plan = retainInitContentSnapshot(currentActions, preview);
				await applyInit(plan, {
					exists,
					write: async (path, content, action) => {
						await safelyWriteInitFile({
							projectRoot,
							path,
							content,
							action,
							...(action === "overwrite" ? { expectedIdentity: overwriteIdentity.get(path) } : {}),
						});
					},
				});
				return plan;
			});
			if (!operation.ok) {
				controller.output(ctx, [`/q-init: checkout writer lane ${operation.error.code}`]);
				return;
			}
			const plan = operation.value;

			const written = plan.entries.filter((entry) => entry.action !== "skip").length;
			const skipped = plan.entries.filter((entry) => entry.action === "skip").length;
			controller.output(ctx, [
				`Workbench initialized for profile "${profile}" in ${projectRoot}`,
				`${written} file(s) written, ${skipped} existing file(s) left untouched`,
				...(operation.release === "recovery_required"
					? ["Warning: initialization completed but checkout lock cleanup requires recovery."]
					: []),
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
