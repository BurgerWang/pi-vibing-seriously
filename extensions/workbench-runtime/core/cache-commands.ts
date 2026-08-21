/** Prompt/action/quant cache command controller. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	computeKey,
	lookupValidated,
	planCache,
	type ActionCacheContext,
	type CacheRequestMode,
} from "../cache/action-cache.ts";
import { renderClear, renderCacheExplain, renderPrune, type ExplainFacts } from "../cache/action-explain.ts";
import { ActionCacheStore } from "../cache/action-store.ts";
import type { ActionRecord } from "../cache/action-types.ts";
import { runDoctor, renderDoctor, doctorToJson, type DoctorFacts } from "../cache/cache-doctor.ts";
import { buildCacheReport, renderCacheReport, renderCacheStatus, type RateLookup } from "../cache/cache-report.ts";
import { CacheStore, DEFAULT_MAX_TELEMETRY_BYTES } from "../cache/cache-store.ts";
import type { CacheTelemetry } from "../cache/cache-telemetry.ts";
import { EXTENSION_VERSION, type TelemetryRecord } from "../cache/cache-types.ts";
import { buildQuantLineage, renderQuantLineage } from "../cache/quant-cache-lineage.ts";
import { renderQuantCacheValidate, validateQuantManifestCommand } from "../cache/quant-cache-validate.ts";
import { loadProjectConfig, type ExecFn } from "./config.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { displayRelative } from "./recipe-runner.ts";
import { buildArgv } from "./recipe-schema.ts";

export interface CacheCommandController {
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getThinkingLevel" | "registerCommand">;
	telemetry: CacheTelemetry;
	getMode(): WorkbenchMode;
	exec: ExecFn;
	refreshConfig(ctx: ExtensionCommandContext): Promise<void>;
	trustedOrError(ctx: ExtensionCommandContext): string | undefined;
	projectRootFor(ctx: ExtensionCommandContext): Promise<string>;
	output(ctx: ExtensionCommandContext, lines: string[]): void;
}

interface ActionCacheBuild {
	ok: boolean;
	error?: string;
	ctx?: ActionCacheContext;
	store?: ActionCacheStore;
	keyResult?: Awaited<ReturnType<typeof computeKey>> | null;
}

function actionCacheContextFor(
	controller: CacheCommandController,
	projectRoot: string,
	recipeName: string,
	cacheMode: CacheRequestMode,
): () => Promise<ActionCacheBuild> {
	return async () => {
		const config = await loadProjectConfig(projectRoot, { trusted: true });
		const recipe = config.recipes.find((candidate) => candidate.name === recipeName);
		if (!recipe) return { ok: false, error: `recipe "${recipeName}" not found in recipes.yaml` };
		const store = new ActionCacheStore(projectRoot, { maxBytes: config.actionCacheMaxBytes });
		const ctx: ActionCacheContext = {
			projectRoot,
			recipe,
			policy: recipe.cache,
			argv: buildArgv(recipe, {}),
			mode: controller.getMode(),
			profile: config.profile,
			projectGates: config.gates,
			packageVersion: EXTENSION_VERSION,
			exec: controller.exec,
			store,
			cacheMode,
		};
		const plan = planCache(ctx);
		const keyResult = plan.active ? await computeKey(ctx) : null;
		return { ok: true, ctx, store, keyResult };
	};
}

async function previousRecordFor(
	store: ActionCacheStore,
	recipeName: string,
	currentKey: string | undefined,
): Promise<ActionRecord | null> {
	try {
		const index = await store.readIndex();
		const candidates = index.entries.filter((entry) => entry.recipe === recipeName && entry.key !== currentKey);
		candidates.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
		for (const candidate of candidates) {
			const { record } = await store.readRecord(candidate.key);
			if (record) return record;
		}
		return null;
	} catch {
		return null;
	}
}

/** Register the complete cache command surface without adding new storage. */
export function registerCacheCommands(controller: CacheCommandController): void {
	controller.pi.registerCommand("q-cache-status", {
		description: "Show prompt-cache telemetry for the current session (provider, usage, hit ratio, last inferred invalidation)",
		handler: async (_args, ctx) => {
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-cache-status: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			await controller.refreshConfig(ctx);
			controller.telemetry.setProjectRoot(projectRoot);
			controller.telemetry.setMode(controller.getMode());
			controller.telemetry.setThinkingLevel(ctx.thinkingLevel ?? controller.pi.getThinkingLevel());
			controller.output(ctx, renderCacheStatus(controller.telemetry.snapshot()));
		},
	});

	controller.pi.registerCommand("q-cache-report", {
		description: "Show cache telemetry report: /q-cache-report [session|project] [--save <name>]",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
			const scope = tokens[0] === "session" || tokens[0] === "project"
				? (tokens.shift() as "session" | "project")
				: "session";
			const saveIndex = tokens.indexOf("--save");
			const saveName = saveIndex >= 0 && tokens[saveIndex + 1] ? tokens[saveIndex + 1] : undefined;
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-cache-report: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			await controller.refreshConfig(ctx);
			controller.telemetry.setProjectRoot(projectRoot);
			const store = new CacheStore(projectRoot);
			const history = await store.readRecordsChronological();
			let scoped = history.records as TelemetryRecord[];
			if (scope === "session") {
				const hashed = controller.telemetry.snapshot().hashedSessionId;
				scoped = scoped.filter((record) => record.hashedSessionId === hashed);
			}
			const rateLookup: RateLookup = (provider, model) => {
				const match = ctx.modelRegistry.find(provider, model);
				if (!match || typeof match.cost?.cacheRead !== "number" || !Number.isFinite(match.cost.cacheRead)) return undefined;
				return { cacheRead: match.cost.cacheRead };
			};
			const report = buildCacheReport(scoped, scope, rateLookup, {
				skippedRecords: history.skipped,
				sourceIncomplete: history.sourceIncomplete,
				truncatedRecords: history.truncatedRecords,
			});
			const lines = renderCacheReport(report);
			if (saveName) {
				const saved = await store.saveReport(saveName, report);
				lines.push("", saved.ok && saved.path
					? `report saved: ${displayRelative(projectRoot, saved.path)}`
					: `report save failed: ${saved.error ?? "unknown error"}`);
			}
			if (history.skipped > 0) lines.push(`(note: ${history.skipped} corrupted line(s) skipped in telemetry history)`);
			controller.output(ctx, lines);
		},
	});

	controller.pi.registerCommand("q-cache-doctor", {
		description: "Check cache telemetry health: /q-cache-doctor [json] (provider/model, usage validity, cost metadata, drift, forbidden fields)",
		handler: async (args, ctx) => {
			const jsonMode = args.trim().toLowerCase() === "json";
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				const checks = [{ id: "trust", status: "fail" as const, message: trustError }];
				controller.output(ctx, jsonMode ? [JSON.stringify(doctorToJson(checks), null, 2)] : renderDoctor(checks));
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			await controller.refreshConfig(ctx);
			controller.telemetry.setProjectRoot(projectRoot);
			const store = new CacheStore(projectRoot);
			const history = await store.readRecordsChronological();
			const model = ctx.model;
			const facts: DoctorFacts = {
				provider: model?.provider ?? null,
				model: model?.id ?? null,
				apiKind: model?.api ?? null,
				modelCostPresent: Boolean(model && typeof model.cost === "object" && model.cost !== null),
				modelCostRatesValid: Boolean(
					model && typeof model.cost?.cacheRead === "number" && Number.isFinite(model.cost.cacheRead) && model.cost.cacheRead >= 0,
				),
				systemPrompt: ctx.getSystemPrompt(),
				activeToolNames: controller.pi.getActiveTools(),
				tools: controller.pi.getAllTools().map((tool) => ({
					name: tool.name,
					description: tool.description,
					promptSnippet: (tool as { promptSnippet?: string }).promptSnippet,
					parameters: tool.parameters,
					promptGuidelines: tool.promptGuidelines,
				})),
				records: history.records as TelemetryRecord[],
				telemetryEnabled: controller.telemetry.isEnabled(),
				telemetryBytes: await store.telemetryBytesAll(),
				telemetryMaxBytes: DEFAULT_MAX_TELEMETRY_BYTES,
				rotatedFiles: await store.rotatedFileCount(),
				sourceIncomplete: history.sourceIncomplete,
				skippedRecords: history.skipped,
				truncatedRecords: history.truncatedRecords,
				filesRead: history.filesRead,
				sourceUnavailable: history.unavailable ?? null,
			};
			const checks = runDoctor(facts);
			controller.output(ctx, jsonMode ? [JSON.stringify(doctorToJson(checks, facts), null, 2)] : renderDoctor(checks));
		},
	});

	controller.pi.registerCommand("q-cache-explain", {
		description: "Explain the action cache for a recipe: /q-cache-explain <recipe> (action key, hit/miss, key components, changed inputs, toolchain/config/env diffs; never prints secrets or per-file hashes)",
		handler: async (args, ctx) => {
			const recipeName = args.trim().split(/\s+/)[0] ?? "";
			if (!recipeName) {
				controller.output(ctx, ["/q-cache-explain: usage: /q-cache-explain <recipe>"]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-cache-explain: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			const built = await actionCacheContextFor(controller, projectRoot, recipeName, "default")();
			if (!built.ok || !built.ctx || !built.store) {
				controller.output(ctx, [`/q-cache-explain: ${built.error ?? "unknown error"}`]);
				return;
			}
			const { ctx: cacheCtx, store } = built;
			const config = await loadProjectConfig(projectRoot, { trusted: true });
			const keyResult = built.keyResult;
			const facts: ExplainFacts = {
				recipeName,
				cacheEnabled: cacheCtx.policy.enabled,
				mode: cacheCtx.policy.mode,
				requestMode: "default",
				status: cacheCtx.policy.enabled ? "miss" : "disabled",
				key: keyResult?.ok ? keyResult.key.key : undefined,
				components: keyResult?.ok ? keyResult.key.components : null,
				currentEntries: keyResult?.ok ? keyResult.inputEntries : [],
				record: null,
				previousRecord: null,
				maxBytes: config.actionCacheMaxBytes,
				stats: await store.stats(),
			};
			if (!keyResult) {
				facts.status = cacheCtx.policy.enabled ? "refused" : "disabled";
			} else if (!keyResult.ok) {
				facts.status = "refused";
				facts.reason = keyResult.reason;
			} else {
				const outcome = await lookupValidated(cacheCtx, keyResult.key);
				facts.status = outcome.status;
				facts.reason = outcome.reason;
				facts.record = outcome.record ?? null;
				facts.previousRecord = await previousRecordFor(store, recipeName, keyResult.key.key);
			}
			controller.output(ctx, renderCacheExplain(facts));
		},
	});

	controller.pi.registerCommand("q-cache-prune", {
		description: "Prune the action cache: /q-cache-prune [--apply] (dry-run by default; --apply needs confirmation; never deletes runs/evidence)",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
			const apply = tokens.includes("--apply");
			const confirmToken = tokens.filter((token) => token !== "--apply").join(" ");
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-cache-prune: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			const config = await loadProjectConfig(projectRoot, { trusted: true });
			const store = new ActionCacheStore(projectRoot, { maxBytes: config.actionCacheMaxBytes });
			if (apply) {
				const confirmed = ctx.hasUI
					? await ctx.ui.confirm("Prune action cache?", "Delete LRU action-cache records beyond the configured budget? Runs and evidence are never touched.")
					: confirmToken === "yes";
				if (!confirmed) {
					controller.output(ctx, [
						"/q-cache-prune: not applied (no confirmation)",
						...renderPrune(await store.prune({ apply: false }), config.actionCacheMaxBytes),
					]);
					return;
				}
			}
			controller.output(ctx, renderPrune(await store.prune({ apply }), config.actionCacheMaxBytes));
		},
	});

	controller.pi.registerCommand("q-cache-clear", {
		description: "Clear the action cache: /q-cache-clear <recipe|all> (single recipe needs confirmation; all needs double confirmation; never deletes runs/evidence)",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
			const target = tokens[0] ?? "";
			if (!target) {
				controller.output(ctx, ["/q-cache-clear: usage: /q-cache-clear <recipe|all>"]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-cache-clear: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			const config = await loadProjectConfig(projectRoot, { trusted: true });
			const store = new ActionCacheStore(projectRoot, { maxBytes: config.actionCacheMaxBytes });
			const confirmToken = tokens.slice(1).join(" ");
			let confirmed = false;
			if (target === "all") {
				if (ctx.hasUI) {
					const first = await ctx.ui.confirm("Clear ALL action-cache records?", "This deletes every cached recipe result for this project. Runs and evidence are never touched.");
					if (first) confirmed = await ctx.ui.confirm("Really clear ALL?", "This is the second and final confirmation. Type Cancel to keep the cache.");
				} else {
					confirmed = confirmToken === "yes yes";
				}
			} else if (ctx.hasUI) {
				confirmed = await ctx.ui.confirm(`Clear action cache for "${target}"?`, "Only this recipe's cached results are deleted. Runs and evidence are never touched.");
			} else {
				confirmed = confirmToken === "yes";
			}
			if (!confirmed) {
				controller.output(ctx, [`/q-cache-clear: ${target} not cleared (no confirmation)`]);
				return;
			}
			controller.output(ctx, renderClear(await store.clear(target === "all" ? "all" : target)));
		},
	});

	controller.pi.registerCommand("q-cache-validate", {
		description: "Validate a quant cache contract manifest: /q-cache-validate <manifest-path> (contract type, schema version, immutable/mutable, content hash, upstream keys, missing fields, warnings, cache eligibility, Q gate implications; never reads data files)",
		handler: async (args, ctx) => {
			const manifestPath = args.trim();
			if (!manifestPath) {
				controller.output(ctx, ["/q-cache-validate: usage: /q-cache-validate <manifest-path> (project-relative, e.g. artifacts/data-snapshot.json)"]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-cache-validate: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			controller.output(ctx, renderQuantCacheValidate(await validateQuantManifestCommand(projectRoot, manifestPath)));
		},
	});

	controller.pi.registerCommand("q-cache-lineage", {
		description: "Trace quant cache lineage: /q-cache-lineage <run-id|action-key> (data snapshot -> feature set -> backtest result, upstream relationships, action keys, artifact hashes, reused runs, invalidation reason; never reads data files)",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target) {
				controller.output(ctx, ["/q-cache-lineage: usage: /q-cache-lineage <run-id|action-key>"]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-cache-lineage: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			controller.output(ctx, renderQuantLineage(await buildQuantLineage(projectRoot, target)));
		},
	});
}
