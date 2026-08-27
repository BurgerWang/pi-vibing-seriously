/** User-facing declared-recipe run command controller. */

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import type { CacheRequestMode } from "../cache/action-cache.ts";
import { compareRuns } from "./compare.ts";
import {
	boundedCommandText,
	boundedDetailsList,
	boundedInlineDetail,
} from "./command-output.ts";
import type { ExecFn } from "./config.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { displayRelative, RecipeSetupError, runRecipe } from "./recipe-runner.ts";
import { buildRecipeParentSummary } from "./result-summary.ts";
import { isValidRunId, listRuns, readLogSnippet, readManifest } from "./runs.ts";
import { renderCompareLines } from "./render.ts";
import type { RecipeMutationFacts } from "./worker-policy.ts";
import { runProjectCheckoutOperationV1 } from "./project-checkout-operation.ts";

export interface RunCommandController {
	pi: Pick<ExtensionAPI, "registerCommand">;
	getMode(): WorkbenchMode;
	getActorFacts(): RecipeMutationFacts;
	exec: ExecFn;
	trustedOrError(ctx: ExtensionCommandContext): string | undefined;
	projectRootFor(ctx: ExtensionCommandContext): Promise<string>;
	reconcileProjectAuthority(projectRoot: string, now: string): Promise<boolean>;
	output(ctx: ExtensionCommandContext, lines: string[]): void;
	refreshStatus(ctx: ExtensionCommandContext): void | Promise<void>;
	refreshWidget(ctx: ExtensionCommandContext): void | Promise<void>;
}

export interface ParsedRunArgs {
	recipe: string;
	params: Record<string, unknown>;
	cacheMode: CacheRequestMode;
}

/** Parse the bounded slash-command grammar; recipes still validate parameters. */
export function parseRunCommandArgs(args: string): ParsedRunArgs {
	let cacheMode: CacheRequestMode = "default";
	const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0 && !token.startsWith("--"));
	const flags = args.trim().split(/\s+/).filter((token) => token.startsWith("--"));
	if (flags.includes("--no-cache")) cacheMode = "no-cache";
	if (flags.includes("--refresh-cache")) cacheMode = "refresh-cache";
	const recipe = tokens[0] ?? "";
	const params: Record<string, unknown> = {};
	for (const token of tokens.slice(1)) {
		const separator = token.indexOf("=");
		if (separator <= 0) continue;
		const key = token.slice(0, separator);
		const raw = token.slice(separator + 1);
		if (raw === "true") params[key] = true;
		else if (raw === "false") params[key] = false;
		else if (/^-?\d+(\.\d+)?$/.test(raw)) params[key] = Number(raw);
		else params[key] = raw;
	}
	return { recipe, params, cacheMode };
}

/** Register execution, listing and inspection as one run behavior domain. */
export function registerRunCommands(controller: RunCommandController): void {
	controller.pi.registerCommand("q-run", {
		description: "Run a declared recipe: /q-run <recipe> [key=value ...] [--no-cache|--refresh-cache] (same service as workbench_run_recipe)",
		handler: async (args, ctx) => {
			const { recipe, params, cacheMode } = parseRunCommandArgs(args);
			if (!recipe) {
				controller.output(ctx, ["/q-run: usage: /q-run <recipe> [key=value ...] [--no-cache|--refresh-cache]"]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-run: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			try {
				if (!await controller.reconcileProjectAuthority(projectRoot, new Date().toISOString())) {
					controller.output(ctx, ["/q-run: checkout authority recovery is unavailable"]);
					return;
				}
				const operation = await runProjectCheckoutOperationV1({
					project_root: projectRoot,
					operation_kind: "command",
					operation_id: `command:q-run:${recipe}`.slice(0, 256),
					now: new Date().toISOString(),
				}, async () => runRecipe({
					projectRoot,
					recipeName: recipe,
					params,
					mode: controller.getMode(),
					exec: controller.exec,
					signal: ctx.signal,
					cacheMode,
					actorFacts: controller.getActorFacts(),
				}));
				if (!operation.ok) {
					controller.output(ctx, [`/q-run: checkout writer lane ${operation.error.code}`]);
					return;
				}
				const result = operation.value;
				if (!result.ok && result.error && !result.summary) {
					controller.output(ctx, [`/q-run: ${result.error}`]);
					return;
				}
				const summary = result.summary;
				if (!summary) {
					controller.output(ctx, ["/q-run: no summary produced"]);
					return;
				}
				const parentSummary = buildRecipeParentSummary({
					runId: summary.run_id,
					recipe: summary.recipe,
					command: summary.argv.join(" "),
					ok: result.ok,
					exitCode: summary.exit_code,
					durationMs: summary.duration_ms,
					timedOut: summary.timed_out,
					cancelled: summary.cancelled,
					stdout: summary.stdout,
					stderr: summary.stderr,
					stdoutLogPath: displayRelative(projectRoot, summary.stdout_log),
					stderrLogPath: displayRelative(projectRoot, summary.stderr_log),
					stdoutTruncated: summary.stdout_truncated,
					stderrTruncated: summary.stderr_truncated,
					artifactPaths: summary.artifact_paths,
					cache: result.cache,
				});
				controller.output(
					ctx,
					[
						...(result.error ? [`error      : ${boundedInlineDetail(result.error, 128)}`] : []),
						...(result.record?.command_effect_status
							? [`cmd effect : ${boundedInlineDetail(result.record.command_effect_status, 128)}; semantic_acceptance=NOT_GRANTED`]
							: []),
						...(result.warnings?.[0] ? [`warning    : ${boundedInlineDetail(result.warnings[0], 128)}`] : []),
						...(operation.release === "recovery_required" ? ["warning    : checkout operation completed but lock cleanup requires recovery"] : []),
						...parentSummary.lines,
					],
				);
				void controller.refreshStatus(ctx);
				void controller.refreshWidget(ctx);
			} catch (error) {
				const message = error instanceof RecipeSetupError
					? error.message
					: `failed to run recipe: ${(error as Error).message}`;
				controller.output(ctx, [`/q-run: ${message}`]);
			}
		},
	});

	controller.pi.registerCommand("q-runs", {
		description: "List recent workbench runs: /q-runs [limit]",
		handler: async (args, ctx) => {
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-runs: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			const limitToken = args.trim().split(/\s+/)[0];
			const limit = limitToken && /^\d+$/.test(limitToken) ? Math.min(Number(limitToken), 50) : 10;
			const runs = await listRuns(projectRoot, limit);
			if (runs.length === 0) {
				controller.output(ctx, [`No runs yet in ${displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs`)}`]);
				return;
			}
			const lines = runs.map((run) => {
				const status = run.timed_out
					? "TIMED OUT"
					: run.cancelled
						? "CANCELLED"
						: run.exit_code !== null && run.expected_exit_codes.includes(run.exit_code)
							? "OK"
							: "FAILED";
				return `${run.run_id}  ${run.recipe.padEnd(28)} exit=${run.exit_code ?? "killed"} ${status.padEnd(9)} ${run.duration_ms}ms  ${run.started_at}`;
			});
			controller.output(ctx, [
				`${lines.length} run(s) in ${displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs`)}`,
				...lines,
			]);
		},
	});

	controller.pi.registerCommand("q-run-show", {
		description: "Show a run record: /q-run-show <run-id> (manifest, summary, bounded log tails)",
		handler: async (args, ctx) => {
			const emit = (value: unknown): void => {
				controller.output(ctx, boundedCommandText(value).split("\n"));
			};
			const runId = args.trim();
			if (!isValidRunId(runId)) {
				emit("/q-run-show: usage: /q-run-show <run-id> (e.g. 20260101-120000-abcd)");
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				emit(`/q-run-show: ${trustError}`);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			const manifest = await readManifest(projectRoot, runId);
			if (!manifest) {
				emit(`/q-run-show: run ${runId} not found`);
				return;
			}
			const stdoutSnippet = await readLogSnippet(projectRoot, runId, "stdout");
			const stderrSnippet = await readLogSnippet(projectRoot, runId, "stderr");
			const argvValues = Array.isArray(manifest.argv)
				? manifest.argv.filter((value): value is string => typeof value === "string")
				: [];
			const artifactValues = Array.isArray(manifest.artifact_paths)
				? manifest.artifact_paths.filter((value): value is string => typeof value === "string")
				: [];
			const argv = boundedDetailsList(argvValues, 32, 256);
			const artifacts = boundedDetailsList(artifactValues, 32, 256);
			emit([
				`run       : ${boundedInlineDetail(manifest.run_id, 128)}`,
				`full record: ${displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${runId}/manifest.json`)}`,
				`recipe    : ${boundedInlineDetail(manifest.recipe, 256)}`,
				`profile   : ${boundedInlineDetail(manifest.profile ?? "(none)", 256)}`,
				`mode      : ${boundedInlineDetail(manifest.mode, 64)}`,
				`started   : ${boundedInlineDetail(manifest.started_at, 128)}`,
				`finished  : ${boundedInlineDetail(manifest.finished_at, 128)}`,
				`duration  : ${manifest.duration_ms} ms`,
				`cwd       : ${boundedInlineDetail(manifest.cwd, 512)}`,
				`argv      : ${argv.items.join(" ") || "(none)"}${argv.omitted_items > 0 ? ` (+${argv.omitted_items} argv item(s) omitted)` : ""}`,
				`exit code : ${manifest.exit_code ?? "killed"}`,
				`timed out : ${manifest.timed_out}`,
				`cancelled : ${manifest.cancelled}`,
				`git       : ${typeof manifest.git_commit === "string" ? boundedInlineDetail(manifest.git_commit, 12) : "(no git)"}${manifest.git_dirty ? " (dirty)" : ""}`,
				`artifacts : ${artifacts.items.join(", ") || "(none)"}${artifacts.omitted_items > 0 ? ` (+${artifacts.omitted_items} artifact path(s) omitted)` : ""}`,
				`stdout log: ${displayRelative(projectRoot, stdoutSnippet.path)}${stdoutSnippet.truncated ? " (truncated below)" : ""}`,
				`stderr log: ${displayRelative(projectRoot, stderrSnippet.path)}${stderrSnippet.truncated ? " (truncated below)" : ""}`,
				"",
				"--- stdout tail ---",
				stdoutSnippet.content || "(empty)",
				"--- stderr tail ---",
				stderrSnippet.content || "(empty)",
			].join("\n"));
		},
	});

	controller.pi.registerCommand("q-compare", {
		description: "Compare two runs: /q-compare <run-id-a> <run-id-b> (exit code, duration, artifacts, gates, quant metrics)",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
			if (tokens.length < 2) {
				controller.output(ctx, ["/q-compare: usage: /q-compare <run-id-a> <run-id-b> (e.g. /q-compare 20260101-120000-abcd 20260102-120000-efgh)"]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-compare: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			const outcome = await compareRuns(projectRoot, tokens[0] ?? "", tokens[1] ?? "");
			if (!outcome.ok) {
				controller.output(ctx, [`/q-compare: ${outcome.error}`]);
				return;
			}
			controller.output(ctx, renderCompareLines(outcome.report, true));
		},
	});
}
