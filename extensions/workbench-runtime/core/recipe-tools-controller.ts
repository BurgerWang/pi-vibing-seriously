/** Public inspect, recipe-run and persisted-run read tool controller. */

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { boundedCommandText, boundedDetailsList, boundedInlineDetail } from "./command-output.ts";
import { loadProjectConfig, type ExecFn } from "./config.ts";
import { inspectProject } from "./inspect.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import {
	RUN_LOG_RESULT_MAX_BYTES,
	RUN_LOG_RESULT_MAX_LINES,
	clampWholeResultText,
} from "./output-policy.ts";
import { displayRelative, runRecipe } from "./recipe-runner.ts";
import { buildRecipeParentSummary } from "./result-summary.ts";
import { renderRunLogPage, renderRunResult } from "./run-result.ts";
import { runStatusLabel } from "./format.ts";
import {
	DEFAULT_SNIPPET_BYTES,
	DEFAULT_SNIPPET_LINES,
	isValidRunId,
	readManifest,
	readRunLogPage,
} from "./runs.ts";
import { assessRunValidation } from "./validation-assessment.ts";
import { workerRecipeBlockReason } from "./worker-policy.ts";
import { buildTrustedRecoveryAuthority } from "./trusted-recovery-authority.ts";
import type { TrustedRecoveryAuthority } from "./tool-result-ingress-projection.ts";
import {
	WORKBENCH_TOOL_METADATA,
	WORKBENCH_TOOL_PARAMETERS,
} from "./tool-catalog.ts";
import {
	renderInspectLines,
	type InspectToolDetails,
	type ReadRunToolDetails,
	type RecipeToolDetails,
} from "./render.ts";
import { boundedCoverageMap, fixedToolFailure } from "./tool-presentation.ts";
import type { WorkerFirstGateFacts } from "./gate-schema.ts";
import { workbenchToolRenderer } from "../ui/tool-renderers.ts";

interface OutputAuthorizationReservation {
	readonly allowed: boolean;
	readonly allocatedBytes: number;
}

export interface RecipeToolIdentity {
	readonly role?: string;
	readonly provider?: string;
	readonly model?: string;
}

export interface RecipeToolsController<TIngress> {
	pi: Pick<ExtensionAPI, "registerTool">;
	getMode(): WorkbenchMode;
	getIdentity(): RecipeToolIdentity;
	exec: ExecFn;
	trustedOrError(ctx: ExtensionContext): string | undefined;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	buildReadOnlyWorkerFirstGateFacts(projectRoot: string, now: string): Promise<WorkerFirstGateFacts>;
	peekOutputAuthorization(toolCallId: unknown, toolName: unknown): OutputAuthorizationReservation | undefined;
	rememberTrustedRunLogContinuation(toolCallId: unknown, cursor: unknown): void;
	bindTrustedIngressAuthority(authority: TrustedRecoveryAuthority | undefined, content: unknown): TIngress | undefined;
	rememberTrustedIngressAuthority(toolCallId: unknown, toolName: unknown, bound: TIngress | undefined): void;
}

/** Register the first three catalog tools in canonical order. */
export function registerRecipeTools<TIngress>(controller: RecipeToolsController<TIngress>): void {
	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_project_inspect,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_project_inspect,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const trustError = controller.trustedOrError(ctx);
				if (trustError) return fixedToolFailure("workbench_project_inspect", "untrusted_project");
				const projectRoot = await controller.projectRootFor(ctx);
				const result = await inspectProject(projectRoot, { trusted: true, exec: controller.exec });
				const stacks = result.stacks.map((stack) => `${stack.language}${stack.package_manager ? ` (${stack.package_manager})` : ""}`);
				const errors = result.config_errors.map((error) => `${error.file}: ${error.message}`);
				const recipeQuery = params.recipe === undefined ? undefined : boundedInlineDetail(params.recipe, 200);
				const selectedRecipes = recipeQuery === undefined
					? result.recipes
					: result.recipes.filter((recipe) => recipe.name === recipeQuery);
				const details: InspectToolDetails = {
					project_root: boundedInlineDetail(result.project_root, 512),
					effective_project_root: boundedInlineDetail(result.effective_project_root, 512),
					git: {
						is_git: result.git.is_git,
						commit: result.git.commit ? boundedInlineDetail(result.git.commit, 128) : null,
						dirty: result.git.dirty,
						branch: result.git.branch ? boundedInlineDetail(result.git.branch, 128) : null,
					},
					stacks: boundedDetailsList(stacks, 24, 256),
					profile: result.profile ? boundedInlineDetail(result.profile, 128) : undefined,
					recipes: boundedDetailsList(selectedRecipes.map((recipe) => recipe.name), recipeQuery === undefined ? 64 : 1, 256),
					...(recipeQuery === undefined ? {} : { recipe_query: recipeQuery, recipe_found: selectedRecipes.length === 1 }),
					recipe_validation_components: boundedCoverageMap(selectedRecipes),
					config_errors: boundedDetailsList(errors, 24, 512),
					config_files_present: boundedDetailsList(result.config_files_present, 24, 256),
				};
				const text = boundedCommandText(renderInspectLines(details, true).join("\n"));
				return { content: [{ type: "text", text }], details };
			} catch {
				return fixedToolFailure("workbench_project_inspect", "runtime_error");
			}
		},
		...workbenchToolRenderer("inspect", "workbench_project_inspect"),
	});

	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_run_recipe,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_run_recipe,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let trustedIngress: TIngress | undefined;
			try {
				const trustError = controller.trustedOrError(ctx);
				if (trustError) return fixedToolFailure("workbench_run_recipe", "untrusted_project");
				const projectRoot = await controller.projectRootFor(ctx);
				const config = await loadProjectConfig(projectRoot, { trusted: true });
				const recipeIssues = config.issues.filter((issue) => issue.file === "recipes.yaml");
				if (recipeIssues.length > 0) {
					const nextAction = `call workbench_project_inspect with recipe=${boundedInlineDetail(params.recipe, 200)}, then use a narrow workbench_delegate_worker config repair on ${CONFIG_DIR_NAME}/workbench/recipes.yaml with verification omitted; this lane is available in DEV and VERIFY`;
					return {
						content: [{ type: "text" as const, text: boundedCommandText(`workbench_run_recipe: config_invalid\nsource: ${CONFIG_DIR_NAME}/workbench/recipes.yaml\nissue_count: ${recipeIssues.length}\nnext_action: ${nextAction}`) }],
						details: {
							ok: false,
							error: "config_invalid",
							requested_recipe: boundedInlineDetail(params.recipe, 200),
							issue_count: recipeIssues.length,
							source_path: `${CONFIG_DIR_NAME}/workbench/recipes.yaml`,
							next_action: nextAction,
						},
					};
				}
				const declaredRecipe = config.recipes.find((candidate) => candidate.name === params.recipe);
				if (declaredRecipe === undefined) {
					const requested = boundedInlineDetail(params.recipe, 200);
					const nextAction = `call workbench_project_inspect with recipe=${requested}, then use workbench_delegate_worker in DEV or VERIFY with allowed_paths=[\"${CONFIG_DIR_NAME}/workbench/recipes.yaml\"] and verification omitted, review the config delta, and retry`;
					return {
						content: [{ type: "text" as const, text: boundedCommandText(`workbench_run_recipe: recipe_not_found\nrequested_recipe: ${requested}\nsource: ${CONFIG_DIR_NAME}/workbench/recipes.yaml\nnext_action: ${nextAction}`) }],
						details: {
							ok: false,
							error: "recipe_not_found",
							requested_recipe: requested,
							source_path: `${CONFIG_DIR_NAME}/workbench/recipes.yaml`,
							next_action: nextAction,
						},
					};
				}
				const identity = controller.getIdentity();
				if (identity.role === "worker") {
					const roleError = workerRecipeBlockReason(identity.role, declaredRecipe.name, declaredRecipe.writes);
					if (roleError) return fixedToolFailure("workbench_run_recipe", "execution_denied");
				}
				onUpdate?.({
					content: [{ type: "text", text: "Running declared recipe..." }],
					details: { phase: "started", recipe: boundedInlineDetail(params.recipe, 256) },
				});
				const result = await runRecipe({
					projectRoot,
					recipeName: params.recipe,
					params: params.params ?? {},
					mode: controller.getMode(),
					exec: controller.exec,
					signal,
					cacheMode: params.cache ?? "default",
					actorFacts: identity,
				});
				if (!result.ok && result.error && !result.summary) return fixedToolFailure("workbench_run_recipe", "recipe_error");
				const summary = result.summary;
				if (!summary) return fixedToolFailure("workbench_run_recipe", "summary_unavailable");
				const status = summary.timed_out ? "TIMED OUT" : summary.cancelled ? "CANCELLED" : result.ok ? "OK" : "FAILED";
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
				const text = boundedCommandText(result.error
					? `error      : ${boundedInlineDetail(result.error, 128)}\n${parentSummary.text}`
					: parentSummary.text);
				const artifactPaths = summary.artifact_paths
					.slice(0, summary.artifact_paths.length > 32 ? 31 : 32)
					.map((path) => boundedInlineDetail(path, 512));
				if (summary.artifact_paths.length > artifactPaths.length) {
					artifactPaths.push(`... ${summary.artifact_paths.length - artifactPaths.length} artifact path(s) omitted`);
				}
				const details: RecipeToolDetails = {
					ok: result.ok,
					...(result.error ? { error: boundedInlineDetail(result.error, 128) } : {}),
					run_id: boundedInlineDetail(summary.run_id, 128),
					recipe: boundedInlineDetail(summary.recipe, 256),
					status,
					exit_code: summary.exit_code ?? null,
					duration_ms: summary.duration_ms,
					artifact_paths: artifactPaths,
					stdout_log: boundedInlineDetail(displayRelative(projectRoot, summary.stdout_log), 512),
					stderr_log: boundedInlineDetail(displayRelative(projectRoot, summary.stderr_log), 512),
					expected_exit_codes: result.record?.expected_exit_codes ?? [0],
					...(result.record
						? {
							validation_components: result.record.validation_components,
							cache_request_mode: result.record.cache_request_mode,
						}
						: {}),
					cache: result.cache,
					phase: "finished",
				};
				onUpdate?.({ content: [{ type: "text", text }], details: { ...details } });
				const toolResult = { content: [{ type: "text" as const, text }], details };
				if (result.ok) {
					const authority = await buildTrustedRecoveryAuthority({
						projectRoot,
						sourceKind: "finalized_recipe_run",
						toolCallId,
						toolName: "workbench_run_recipe",
						sourcePath: `${CONFIG_DIR_NAME}/workbench/runs/${summary.run_id}/summary.json`,
						requiredFacts: [
							{ key: "run_id", value: summary.run_id },
							{ key: "recipe", value: summary.recipe },
							{ key: "status", value: status },
							{ key: "exit_code", value: summary.exit_code },
							{ key: "duration_ms", value: summary.duration_ms },
						],
					});
					trustedIngress = controller.bindTrustedIngressAuthority(authority, toolResult.content);
				}
				return toolResult;
			} catch {
				return fixedToolFailure("workbench_run_recipe", "runtime_error");
			} finally {
				controller.rememberTrustedIngressAuthority(toolCallId, "workbench_run_recipe", trustedIngress);
			}
		},
		...workbenchToolRenderer("recipe", "workbench_run_recipe"),
	});

	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_read_run,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_read_run,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			let trustedIngress: TIngress | undefined;
			const readRunText = (value: unknown): string => clampWholeResultText(value, {
				maxBytes: RUN_LOG_RESULT_MAX_BYTES,
				maxLines: RUN_LOG_RESULT_MAX_LINES,
			}).text;
			try {
				const trustError = controller.trustedOrError(ctx);
				if (trustError) return { content: [{ type: "text", text: readRunText(`workbench_read_run: ${trustError}`) }], details: {} };
				if (!isValidRunId(params.run_id)) {
					return { content: [{ type: "text", text: readRunText(`workbench_read_run: invalid run_id "${params.run_id}"`) }], details: {} };
				}
				const projectRoot = await controller.projectRootFor(ctx);
				const manifest = await readManifest(projectRoot, params.run_id);
				if (!manifest) return { content: [{ type: "text", text: readRunText(`workbench_read_run: run ${params.run_id} not found`) }], details: {} };
				const include = params.include ?? "summary";
				const logMode = include === "logs" || include === "all";
				if (!logMode && params.cursor !== undefined) {
					return { content: [{ type: "text", text: readRunText("workbench_read_run: cursor_requires_logs_or_all") }], details: {} };
				}
				const pendingAuthorization = controller.peekOutputAuthorization(toolCallId, "workbench_read_run");
				const requestedOutputBytes = params.max_bytes ?? DEFAULT_SNIPPET_BYTES;
				const outputBytes = pendingAuthorization
					? (pendingAuthorization.allowed ? Math.min(requestedOutputBytes, pendingAuthorization.allocatedBytes) : 0)
					: Math.min(requestedOutputBytes, RUN_LOG_RESULT_MAX_BYTES);
				const outputLines = Math.min(params.max_lines ?? DEFAULT_SNIPPET_LINES, RUN_LOG_RESULT_MAX_LINES);
				if (logMode && outputBytes <= 0) return { content: [{ type: "text", text: "" }], details: {} };
				const logPage = logMode
					? await readRunLogPage(projectRoot, params.run_id, {
						logStream: params.log_stream ?? "both",
						...(params.cursor === undefined ? {} : { cursor: params.cursor }),
						maxLines: outputLines,
						maxBytes: Math.min(RUN_LOG_RESULT_MAX_BYTES, Math.max(1, outputBytes)),
						preferStderr: manifest.exit_code === null || manifest.exit_code !== 0 || manifest.timed_out || manifest.cancelled,
					})
					: null;
				if (logPage && !logPage.ok) {
					return { content: [{ type: "text", text: readRunText(`workbench_read_run: ${logPage.error.code}`) }], details: {} };
				}
				const identity = controller.getIdentity();
				const validation = await assessRunValidation({
					projectRoot,
					mode: controller.getMode(),
					exec: controller.exec,
					manifest,
					actorFacts: identity,
					...(manifest.recipe === "gate"
						? { workerFirstFacts: await controller.buildReadOnlyWorkerFirstGateFacts(projectRoot, new Date().toISOString()) }
						: {}),
				});
				const runDirRel = `${CONFIG_DIR_NAME}/workbench/runs/${manifest.run_id}`;
				const stdoutPath = `${runDirRel}/stdout.log`;
				const stderrPath = `${runDirRel}/stderr.log`;
				let renderedText: string;
				let runLogDetails: Record<string, unknown> = {};
				if (logPage?.ok) {
					const rendered = renderRunLogPage({
						manifest,
						page: logPage.value,
						validation,
						stdoutPath,
						stderrPath,
						maxOutputBytes: outputBytes,
						maxOutputLines: outputLines,
					});
					renderedText = rendered.text;
					runLogDetails = {
						include,
						log_stream: logPage.value.selection,
						shown_lines: rendered.shownLines,
						shown_bytes: rendered.shownBytes,
						remaining_bytes: rendered.omittedBeforeBytes,
						...(rendered.previousCursor ? { next_cursor: rendered.previousCursor } : {}),
					};
					if (rendered.previousCursor) controller.rememberTrustedRunLogContinuation(toolCallId, rendered.previousCursor);
				} else {
					renderedText = renderRunResult({
						include,
						manifest,
						validation,
						stdoutSnippet: null,
						stderrSnippet: null,
						runDir: runDirRel,
						manifestPath: `${runDirRel}/manifest.json`,
						summaryPath: `${runDirRel}/summary.json`,
						stdoutPath,
						stderrPath,
					}).text;
				}
				const text = readRunText(renderedText);
				const details: ReadRunToolDetails = {
					run_id: manifest.run_id,
					recipe: manifest.recipe,
					kind: manifest.recipe === "gate" ? "gate" : "recipe",
					status: runStatusLabel(manifest),
					exit_code: manifest.exit_code,
					duration_ms: manifest.duration_ms,
					profile: manifest.profile,
					mode: manifest.mode,
					started_at: manifest.started_at,
					finished_at: manifest.finished_at,
					git_commit: manifest.git_commit,
					git_dirty: manifest.git_dirty,
					artifact_paths: manifest.artifact_paths,
					validation: { status: validation.status, reasons: validation.reasons },
					stdout_log: displayRelative(projectRoot, `${runDirRel}/stdout.log`),
					stderr_log: displayRelative(projectRoot, `${runDirRel}/stderr.log`),
					...runLogDetails,
				};
				const toolResult = { content: [{ type: "text" as const, text }], details };
				let sourcePath: string | undefined;
				let logStream: "stdout" | "stderr" | null = null;
				let page = 0;
				if (include === "summary" || include === "manifest") sourcePath = `${runDirRel}/manifest.json`;
				else if (include === "logs" && logPage?.ok && logPage.value.selection !== "both") {
					logStream = logPage.value.selection;
					const streamPage = logStream === "stdout" ? logPage.value.stdout : logPage.value.stderr;
					page = streamPage.startByte;
					sourcePath = logStream === "stdout" ? stdoutPath : stderrPath;
				}
				if (sourcePath) {
					const authority = await buildTrustedRecoveryAuthority({
						projectRoot,
						sourceKind: "finalized_run_page",
						toolCallId,
						toolName: "workbench_read_run",
						sourcePath,
						requiredFacts: [
							{ key: "run_id", value: manifest.run_id },
							{ key: "include", value: include },
							{ key: "log_stream", value: logStream },
							{ key: "page", value: page },
						],
					});
					trustedIngress = controller.bindTrustedIngressAuthority(authority, toolResult.content);
				}
				return toolResult;
			} catch (error) {
				return { content: [{ type: "text", text: readRunText(error) }], details: {} };
			} finally {
				controller.rememberTrustedIngressAuthority(toolCallId, "workbench_read_run", trustedIngress);
			}
		},
		...workbenchToolRenderer("read_run", "workbench_read_run"),
	});
}
