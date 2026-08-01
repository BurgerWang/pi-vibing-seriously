/**
 * pi-dev-workbench — Workbench Runtime extension (P1: Project Configuration
 * and Controlled Recipe Runner; P3: Gate Engine, Evidence Artifacts and the
 * Quant Research Validation Ladder; P4: Pi-native TUI status, run reports,
 * run comparison and compact tool renderers; P5: path protection, command
 * protection, state recovery and compaction supplements, compatibility
 * hardening).
 *
 * P5 additions:
 *   - protected-path policy (core/path-policy.ts): credential files are
 *     never modified (edit/write blocked in all modes) and never read in
 *     AUDIT/VERIFY; read in DEV is allowed. .env.example/.env.template are
 *     explicitly allowed.
 *   - token-based command guard (core/command-guard.ts): rm -rf / or ~,
 *     rm of .git, git reset --hard, git clean -fd, git push --force,
 *     git checkout -- . / git restore ., git remote mutations,
 *     git config --global writes, sudo, package publish — parsed, with
 *     quote-awareness so harmless commands never false-positive.
 *   - state recovery + compaction supplements (core/compact.ts): mode and
 *     key task state are persisted as Pi custom entries, restored on
 *     session_start (covers /new /resume /fork /clone /reload); on
 *     session_before_compact a bounded ASCII note (task, mode, gates, runs,
 *     evidence paths, next step, do-not-retry) is persisted and injected as
 *     a hidden custom message. Pi compaction itself is never cancelled or
 *     reimplemented, and no run logs ever enter the session context.
 *
 * Registers native Pi commands:
 *   /q-mode-audit /q-mode-dev /q-mode-verify /q-status   — mode control (P0)
 *   /q-init <profile>                                    — project init (P1)
 *   /q-run <recipe> /q-runs /q-run-show <run-id>         — recipe runner (P1)
 *   /q-gate <selector> /q-gates /q-gate-show <gate-id>   — gate engine (P3)
 *   /q-evidence <run-id>                                 — evidence viewer (P3)
 *   /q-report latest|<run-id>                            — run report (P4)
 *   /q-compare <a> <b>                                   — run comparison (P4)
 *   /q-widget on|off                                     — widget toggle (P4)
 *
 * Registers workbench custom tools (P1/P3/P4):
 *   workbench_project_inspect — project root, git, stacks, profile, recipes,
 *                               config errors (no secrets)
 *   workbench_run_recipe      — run a declared recipe only; full output to
 *                               disk, truncated summary to the model
 *   workbench_read_run        — read run records by run_id (bounded logs)
 *   workbench_run_gate        — run the validation ladder (gates + checks)
 *   workbench_read_gate       — read a gate run record or gate definition
 *   workbench_list_gates      — list available gates with latest status
 *   workbench_compare_runs    — compare two run records (P4)
 *
 * P4 UI (all Pi-native):
 *   - footer status via `ctx.ui.setStatus` (the Pi footer itself is never
 *     replaced): WB:<MODE> | <profile> | <gate>:<status> | run:<id>
 *   - compact widget via `ctx.ui.setWidget`, shown only while a task is
 *     active, a gate is failing, or the user forced it on (/q-widget)
 *   - compact renderCall/renderResult for the five tools above; expanded
 *     shows recipe, duration, exit code, artifacts, failed checks, log path
 *   - all UI calls are guarded by ctx.mode/ctx.hasUI — print/json modes
 *     never touch TUI-only APIs and every fact comes from the run's own
 *     JSON records (manifest/gates/result); renderers never recompute
 *     business metrics
 *
 * Mechanisms used (all Pi-native):
 *   - `pi.appendEntry` + `session_start` for mode persistence
 *   - `pi.setActiveTools` for the mode tool set (layer 1)
 *   - `pi.on("tool_call")` hard guard (layer 2): AUDIT blocks
 *     bash/edit/write/workbench_run_recipe/workbench_run_gate; VERIFY blocks
 *     bash/edit/write
 *   - `pi.exec` (argv + shell=false + timeout/AbortSignal) for recipe runs
 *   - Pi's official CONFIG_DIR_NAME and truncation helpers
 *
 * Scope: stock selection, timing, mid/low-frequency backtesting, data
 * analysis, parameter experiments, walk-forward, out-of-sample validation,
 * and general software engineering. No HFT/L2/market-making/exchange
 * routing/execution code is implemented or planned.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { dirname } from "node:path";

import { Type } from "typebox";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	checkToolCall,
	computeActiveTools,
	MODE_TOOLS,
	type WorkbenchMode,
} from "./core/mode-policy.ts";
import {
	describeMode,
	loadModeFromEntries,
	MODE_ENTRY_TYPE,
	statusText,
} from "./core/state.ts";
import {
	findProjectRoot,
	loadProjectConfig,
	type ExecFn,
} from "./core/config.ts";
import { inspectProject } from "./core/inspect.ts";
import { planInit, applyInit, renderInitPlan } from "./core/init.ts";
import { isSupportedInitProfile, INIT_PROFILES } from "./core/templates.ts";
import { displayRelative, runRecipe, RecipeSetupError } from "./core/recipe-runner.ts";
import {
	GateSetupError,
	latestGateStatus,
	loadGates,
	runGates,
	type GateRunEntry,
} from "./core/gate-engine.ts";
import { GATE_CATALOG } from "./core/gate-catalog.ts";
import { QUANT_GATE_ID_RE, type Gate } from "./core/gate-schema.ts";
import { isValidRunId, listRuns, readLogSnippet, readManifest, readSummary } from "./core/runs.ts";
import { join } from "node:path";
import { runStatusLabel, fitToWidth } from "./core/format.ts";
import { buildStatusLine } from "./core/status.ts";
import { buildWidgetLines, widgetAction, type WidgetState } from "./core/widget.ts";
import { buildRunReport, latestGateRunSummary, resolveRunTarget } from "./core/report.ts";
import { compareRuns } from "./core/compare.ts";
import {
	buildCompactNote,
	collectDoNotRetry,
	COMPACT_NOTE_MESSAGE_TYPE,
	COMPACT_STATE_ENTRY_TYPE,
	emptyCompactState,
	loadCompactStateFromEntries,
	MAX_DO_NOT_RETRY,
	MAX_EVIDENCE_PATHS,
	MAX_GATES,
	MAX_MODIFIED_FILES,
	pushBounded,
	shouldSupplement,
	type CompactState,
} from "./core/compact.ts";
import {
	renderCompareLines,
	type CompareToolDetails,
	type GateToolDetails,
	type InspectToolDetails,
	type ReadRunToolDetails,
	type RecipeToolDetails,
} from "./core/render.ts";
import { workbenchToolRenderer } from "./ui/tool-renderers.ts";

const STATUS_KEY = "workbench";

// ------------------------------------------------------------- P5 state

/** Workbench facts carried across compaction and session replacement (P5). */
let compactState: CompactState = emptyCompactState("DEV");
/** Recent run-outcome signatures (newest last) for repeated-failure notes. */
let recentOutcomes: string[] = [];
/** The last supplement note sent, to avoid duplicates. */
let lastCompactNote: string | undefined;

function touchCompactState(): void {
	compactState.updatedAt = new Date().toISOString();
}

function rememberRunOutcome(toolName: string, details: Record<string, unknown>): void {
	if (toolName === "workbench_run_gate") {
		const status = typeof details.status === "string" ? details.status : "UNKNOWN";
		recentOutcomes.push(`gate:${status}`);
	} else if (toolName === "workbench_run_recipe") {
		const recipe = typeof details.recipe === "string" ? details.recipe : "?";
		recentOutcomes.push(details.ok === true ? `recipe:${recipe}:ok` : `recipe:${recipe}:exit:${String(details.exit_code ?? "?")}`);
	}
	recentOutcomes = recentOutcomes.slice(-12);
	compactState.doNotRetry = collectDoNotRetry(recentOutcomes, MAX_DO_NOT_RETRY);
}

export default function workbenchRuntime(pi: ExtensionAPI): void {
	let mode: WorkbenchMode = "DEV";

	const execFn: ExecFn = (command, args, options) =>
		pi.exec(command, args, { cwd: options?.cwd, timeout: options?.timeout, signal: options?.signal });

	// ------------------------------------------------------------------ state

	function applyModeTools(): void {
		pi.setActiveTools(computeActiveTools(mode, pi.getActiveTools()));
	}

	/**
	 * P4 status bar: WB:<MODE> | <profile> | <gate>:<status> | run:<id>.
	 * All facts come from the project config and the persisted run records;
	 * missing pieces degrade to shorter lines (mode-only fallback).
	 */
	async function refreshStatus(ctx: ExtensionContext): Promise<void> {
		// No status bar exists in print/json modes; skip silently.
		if (ctx.mode === "print" || ctx.mode === "json") return;
		let line = statusText(mode);
		try {
			if (ctx.isProjectTrusted()) {
				const projectRoot = await projectRootFor(ctx);
				const config = await loadProjectConfig(projectRoot, { trusted: true });
				const gate = await latestGateRunSummary(projectRoot);
				const runs = await listRuns(projectRoot, 1);
				const latestRun = runs[0];
				line = buildStatusLine({
					mode,
					profile: config.profile,
					activeGate: gate?.worst_gate ? { id: gate.worst_gate.id, status: gate.worst_gate.status, run_id: gate.run_id } : undefined,
					latestRun: latestRun
						? { run_id: latestRun.run_id, status: runStatusLabel(latestRun), ok: runStatusLabel(latestRun) === "OK" }
						: undefined,
				});
			}
		} catch {
			// keep the mode-only fallback line
		}
		ctx.ui.setStatus(STATUS_KEY, line);
	}

	// ------------------------------------------------------------------ widget

	const WIDGET_KEY = "workbench";
	let widgetForced = false;
	let widgetTask: string | undefined;
	let widgetPhase: string | undefined;

	/** Collect the widget facts (latest gate run + latest run) from disk. */
	async function collectWidgetState(ctx: ExtensionContext): Promise<WidgetState> {
		const state: WidgetState = {
			task: widgetTask,
			phase: widgetPhase,
			taskActive: widgetTask !== undefined,
			gateFailed: false,
			forced: widgetForced,
		};
		try {
			if (!ctx.isProjectTrusted()) return state;
			const projectRoot = await projectRootFor(ctx);
			const gate = await latestGateRunSummary(projectRoot);
			if (gate) {
				state.gateFailed = gate.status !== "PASS";
				state.activeGate = gate.worst_gate
					? `${gate.worst_gate.id} ${gate.worst_gate.status} (run ${gate.run_id})`
					: `all ${gate.status} (run ${gate.run_id})`;
				state.blockingReason = gate.blocking_reason ?? undefined;
			}
			const runs = await listRuns(projectRoot, 1);
			const latest = runs[0];
			if (latest) {
				state.lastRun = `run:${latest.run_id} ${latest.recipe} exit=${latest.exit_code ?? "killed"} ${runStatusLabel(latest)}`;
			}
		} catch {
			// minimal state (task/phase only)
		}
		return state;
	}

	/**
	 * Show/hide the widget per the P4 rules. Never touches the UI without
	 * `ctx.hasUI` (print/json are no-ops).
	 */
	async function refreshWidget(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const state = await collectWidgetState(ctx);
		const action = widgetAction(state, ctx.hasUI);
		if (action === "show") {
			ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(state, { width: 96 }));
		} else if (action === "hide") {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	}

	function setMode(next: WorkbenchMode, ctx: ExtensionContext, label: string): void {
		mode = next;
		pi.appendEntry(MODE_ENTRY_TYPE, { mode });
		applyModeTools();
		const text = `${label}: ${describeMode(mode)}`;
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
		} else {
			// print/json modes: visible stdout fallback.
			console.log(text);
		}
		void refreshStatus(ctx);
	}

	function output(ctx: ExtensionCommandContext, lines: string[]): void {
		const text = lines.join("\n");
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
		} else {
			// print/json modes: fall back to stdout so /q-* still works.
			console.log(text);
		}
	}

	function trustedOrError(ctx: ExtensionContext): string | undefined {
		if (!ctx.isProjectTrusted()) {
			return "project is not trusted — workbench will not read or run its configuration. Exit Pi, re-enter the project, and approve project trust first.";
		}
		return undefined;
	}

	async function projectRootFor(ctx: ExtensionContext): Promise<string> {
		return findProjectRoot(ctx.cwd, execFn);
	}

	function runsDirFor(projectRoot: string): string {
		return join(projectRoot, CONFIG_DIR_NAME, "workbench", "runs");
	}

	function renderGateDefinition(gate: Gate, latestStatus?: string, latestRunId?: string): string[] {
		const lines = [
			`gate        : ${gate.id} — ${gate.title}`,
			`description : ${gate.description}`,
			`profiles    : ${gate.profiles.length > 0 ? gate.profiles.join(", ") : "(all)"}${QUANT_GATE_ID_RE.test(gate.id) ? " [quant]" : " [base]"}`,
			`prereq      : ${gate.prerequisites.length > 0 ? gate.prerequisites.join(", ") : "(none)"}`,
			`required    : ${gate.required}`,
			`blocking    : ${gate.blocking}`,
			`latest      : ${latestStatus ? `${latestStatus} (run ${latestRunId})` : "NOT_RUN (never run)"}`,
			`acceptance  : ${gate.acceptance || "(not declared)"}`,
			`evidence    : ${gate.evidence.length > 0 ? gate.evidence.join(", ") : "(not declared)"}`,
			"checks:",
		];
		for (const c of gate.checks) {
			const flags = [c.required ? "required" : "optional", c.blocking ? "blocking" : "non-blocking"].join("/");
			const target =
				c.recipe ?? c.recipes?.join("|") ?? c.path ?? c.any_of?.join("|") ??
				(c.json_file ? `${c.json_file}#${c.json_path ?? c.json_any_of_paths?.join("|") ?? ""}` : undefined) ??
				(c.artifact_recipe ? `artifacts of ${c.artifact_recipe}` : undefined) ??
				(c.kind === "manual" ? "manual evidence" : c.kind === "config" ? "config" : c.schema_name ?? "");
			lines.push(`  - ${c.id} [${c.kind}, ${flags}] ${c.title}${target ? ` — ${target}` : ""}`);
		}
		return lines;
	}

	// -------------------------------------------------------------- lifecycle

	pi.on("session_start", async (_event, ctx) => {
		// Restore the most recent persisted mode and workbench state from the
		// current session's custom entries. Custom entries survive compaction
		// and every session-replacement path (/new, /resume, /fork, /clone,
		// /reload all reach this handler via session_start); /new starts a
		// fresh session file, so it falls back to the DEV default.
		const entries = ctx.sessionManager.getEntries();
		mode = loadModeFromEntries(entries);
		compactState = loadCompactStateFromEntries(entries, mode);
		applyModeTools();
		void refreshStatus(ctx);
		void refreshWidget(ctx); // a previously failed gate keeps the widget visible
	});

	// ----------------------------------------------------- P5 compaction

	// Never cancels Pi compaction and never replaces its summary — the note
	// only supplements the compacted context with authoritative workbench
	// facts (task, mode, gates, runs, evidence paths, next step, do-not-retry
	// notes). The state entry persists across compaction and session
	// replacement; the hidden custom message (display: false, nextTurn) makes
	// the facts visible to the model without putting any log content into the
	// session context.
	pi.on("session_before_compact", (_event, _ctx) => {
		if (!shouldSupplement(compactState)) return undefined;
		const note = buildCompactNote(compactState);
		if (note === lastCompactNote) return undefined;
		lastCompactNote = note;
		try {
			pi.appendEntry(COMPACT_STATE_ENTRY_TYPE, compactState);
		} catch {
			// non-interactive context: the in-memory state is still valid
		}
		try {
			pi.sendMessage(
				{
					customType: COMPACT_NOTE_MESSAGE_TYPE,
					content: note,
					display: false,
					details: { updated_at: compactState.updatedAt },
				},
				{ deliverAs: "nextTurn" },
			);
		} catch {
			// print/json modes: the durable state entry above is the fallback
		}
		return undefined;
	});

	// -------------------------------------------------------- widget events

	pi.on("before_agent_start", async (event, ctx) => {
		widgetTask = fitToWidth(event.prompt.trim().replace(/\s+/g, " ").slice(0, 120), 96) || "active task";
		widgetPhase = "planning";
		compactState.task = widgetTask;
		compactState.phase = "planning";
		touchCompactState();
		void refreshWidget(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		widgetTask = undefined;
		widgetPhase = undefined;
		compactState.task = undefined;
		compactState.phase = undefined;
		touchCompactState();
		void refreshWidget(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!event.toolName.startsWith("workbench_")) return;
		widgetPhase = `running ${event.toolName}`;
		compactState.phase = widgetPhase;
		touchCompactState();
		void refreshWidget(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!event.toolName.startsWith("workbench_")) return;
		widgetPhase = `finished ${event.toolName}`;
		compactState.phase = widgetPhase;
		const details = (event.result as { details?: unknown } | undefined)?.details;
		if (details && typeof details === "object" && !Array.isArray(details)) {
			const record = details as Record<string, unknown>;
			const runId = typeof record.run_id === "string" ? record.run_id : undefined;
			if (runId) {
				compactState.lastRunId = runId;
				if (typeof record.recipe === "string") compactState.lastRecipe = record.recipe;
				const evidencePath = `.pi/workbench/runs/${runId}`;
				compactState.evidencePaths = pushBounded(compactState.evidencePaths, evidencePath, MAX_EVIDENCE_PATHS);
				if (event.toolName === "workbench_run_gate" && Array.isArray(record.gates)) {
					for (const g of record.gates as Array<{ id?: unknown; status?: unknown }>) {
						const id = typeof g.id === "string" ? g.id : "?";
						if (g.status === "PASS") compactState.passedGates = pushBounded(compactState.passedGates, id, MAX_GATES);
						else if (g.status === "FAIL") compactState.failedGates = pushBounded(compactState.failedGates, `${id} (run ${runId})`, MAX_GATES);
						else if (g.status === "BLOCKED") compactState.blockedGates = pushBounded(compactState.blockedGates, `${id} (run ${runId})`, MAX_GATES);
					}
				}
				rememberRunOutcome(event.toolName, record);
			}
		}
		touchCompactState();
		void refreshStatus(ctx);
		void refreshWidget(ctx);
	});

	// --------------------------------------------------------------- commands

	pi.registerCommand("q-mode-audit", {
		description: "Switch workbench to AUDIT mode (read-only: read, grep, find, ls, workbench_project_inspect, workbench_read_run)",
		handler: async (_args, ctx) => setMode("AUDIT", ctx, "AUDIT mode"),
	});

	pi.registerCommand("q-mode-dev", {
		description: "Switch workbench to DEV mode (full local development tools)",
		handler: async (_args, ctx) => setMode("DEV", ctx, "DEV mode"),
	});

	pi.registerCommand("q-mode-verify", {
		description:
			"Switch workbench to VERIFY mode (read, grep, find, ls, workbench tools; no free bash/edit/write — declared recipes only)",
		handler: async (_args, ctx) => setMode("VERIFY", ctx, "VERIFY mode"),
	});

	pi.registerCommand("q-status", {
		description: "Show workbench mode, cwd, project trust, active tools, and workbench tools",
		handler: async (_args, ctx) => {
			const trust = ctx.isProjectTrusted() ? "trusted" : "not trusted";
			const workbenchTools = pi
				.getAllTools()
				.map((t) => t.name)
				.filter((name) => name.startsWith("workbench_"));
			const lines = [
				`workbench mode : ${mode} — ${describeMode(mode)}`,
				`cwd            : ${ctx.cwd}`,
				`project trust  : ${trust}`,
				`active tools   : ${pi.getActiveTools().join(", ") || "(none)"}`,
				`mode tool set  : ${MODE_TOOLS[mode].join(", ")}`,
				`workbench tools: ${workbenchTools.length > 0 ? workbenchTools.join(", ") : "(none registered)"}`,
				`path policy    : write .env/.pem/.key/credentials.*/secrets.*/auth.json blocked in all modes; read blocked in AUDIT/VERIFY, allowed in DEV`,
				`command guard  : rm -rf / or ~, git reset --hard, git clean -fd, git push --force, git checkout -- ., git restore ., git remote changes, rm .git, git config --global writes, sudo, npm/yarn/pnpm/bun publish`,
			];
			output(ctx, lines);
		},
	});

	// ------------------------------------------------------------ /q-init

	pi.registerCommand("q-init", {
		description:
			"Initialize .pi/workbench configuration for a profile: generic | quant-research/stock-selection | quant-research/market-timing",
		handler: async (args, ctx) => {
			const profile = args.trim().split(/\s+/)[0] ?? "";
			if (!isSupportedInitProfile(profile)) {
				output(ctx, [
					`/q-init: unsupported profile "${profile || "(empty)"}"`,
					`supported profiles: ${INIT_PROFILES.join(", ")}`,
					"unsupported (by design): hft, market-making, lob, execution-engine",
				]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-init: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const exists = async (p: string): Promise<boolean> => access(p).then(() => true, () => false);

			// Phase 1: display what will be written, BEFORE touching the disk.
			const preview = await planInit(projectRoot, profile, { exists, confirmOverwrite: async () => false });
			output(ctx, [...renderInitPlan(preview, CONFIG_DIR_NAME), ""]);

			// Phase 2: overwrites require per-file confirmation (only when a
			// dialog UI exists; otherwise existing files are never touched).
			const overwrite = new Set<string>();
			if (ctx.hasUI) {
				for (const entry of preview.entries) {
					if (entry.action !== "skip") continue;
					const yes = await ctx.ui.confirm("Overwrite?", `${CONFIG_DIR_NAME}/workbench/${entry.file} already exists. Overwrite it?`);
					if (yes) overwrite.add(entry.file);
				}
			}

			// Phase 3: apply.
			const plan = await planInit(projectRoot, profile, { exists, confirmOverwrite: async (file) => overwrite.has(file) });
			await applyInit(plan, {
				exists,
				write: async (path, content) => {
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, content, "utf8");
				},
			});
			const written = plan.entries.filter((e) => e.action !== "skip").length;
			const skipped = plan.entries.filter((e) => e.action === "skip").length;
			const lines = [
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
			];
			output(ctx, lines);
		},
	});

	// ------------------------------------------------------------ /q-run

	function parseRunArgs(args: string): { recipe: string; params: Record<string, unknown> } {
		const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
		const recipe = tokens[0] ?? "";
		const params: Record<string, unknown> = {};
		for (const token of tokens.slice(1)) {
			const eq = token.indexOf("=");
			if (eq <= 0) continue;
			const key = token.slice(0, eq);
			const raw = token.slice(eq + 1);
			if (raw === "true") params[key] = true;
			else if (raw === "false") params[key] = false;
			else if (/^-?\d+(\.\d+)?$/.test(raw)) params[key] = Number(raw);
			else params[key] = raw;
		}
		return { recipe, params };
	}

	pi.registerCommand("q-run", {
		description: "Run a declared recipe: /q-run <recipe> [key=value ...] (same service as workbench_run_recipe)",
		handler: async (args, ctx) => {
			const { recipe, params } = parseRunArgs(args);
			if (!recipe) {
				output(ctx, ["/q-run: usage: /q-run <recipe> [key=value ...]"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-run: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			try {
				const result = await runRecipe({ projectRoot, recipeName: recipe, params, mode, exec: execFn, signal: ctx.signal });
				if (!result.ok && result.error) {
					output(ctx, [`/q-run: ${result.error}`]);
					return;
				}
				const summary = result.summary;
				if (!summary) {
					output(ctx, ["/q-run: no summary produced"]);
					return;
				}
				const lines = [
					`run        : ${summary.run_id}`,
					`recipe     : ${summary.recipe}`,
					`exit code  : ${summary.exit_code ?? "killed"} (expected: ${result.record?.expected_exit_codes.join(", ") ?? "?"})`,
					`status     : ${summary.timed_out ? "TIMED OUT" : summary.cancelled ? "CANCELLED" : result.ok ? "OK" : "FAILED"}`,
					`duration   : ${summary.duration_ms} ms`,
					`artifacts  : ${summary.artifact_paths.length > 0 ? summary.artifact_paths.join(", ") : "(none)"}`,
					`stdout log : ${displayRelative(projectRoot, summary.stdout_log)}`,
					`stderr log : ${displayRelative(projectRoot, summary.stderr_log)}`,
					"",
					"--- stdout (truncated) ---",
					summary.stdout,
					"--- stderr (truncated) ---",
					summary.stderr,
				];
				output(ctx, lines);
				void refreshStatus(ctx);
				void refreshWidget(ctx);
			} catch (error) {
				const message = error instanceof RecipeSetupError ? error.message : `failed to run recipe: ${(error as Error).message}`;
				output(ctx, [`/q-run: ${message}`]);
			}
		},
	});

	// ------------------------------------------------------------ /q-runs

	pi.registerCommand("q-runs", {
		description: "List recent workbench runs: /q-runs [limit]",
		handler: async (args, ctx) => {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-runs: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const limitToken = args.trim().split(/\s+/)[0];
			const limit = limitToken && /^\d+$/.test(limitToken) ? Math.min(Number(limitToken), 50) : 10;
			const runs = await listRuns(projectRoot, limit);
			if (runs.length === 0) {
				output(ctx, [`No runs yet in ${displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs`)}`]);
				return;
			}
			const lines = runs.map((r) => {
				const status = r.timed_out ? "TIMED OUT" : r.cancelled ? "CANCELLED" : r.exit_code !== null && r.expected_exit_codes.includes(r.exit_code) ? "OK" : "FAILED";
				return `${r.run_id}  ${r.recipe.padEnd(28)} exit=${r.exit_code ?? "killed"} ${status.padEnd(9)} ${r.duration_ms}ms  ${r.started_at}`;
			});
			output(ctx, [`${lines.length} run(s) in ${displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs`)}`, ...lines]);
		},
	});

	// ------------------------------------------------------ /q-run-show

	pi.registerCommand("q-run-show", {
		description: "Show a run record: /q-run-show <run-id> (manifest, summary, bounded log tails)",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!isValidRunId(runId)) {
				output(ctx, ["/q-run-show: usage: /q-run-show <run-id> (e.g. 20260101-120000-abcd)"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-run-show: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const manifest = await readManifest(projectRoot, runId);
			if (!manifest) {
				output(ctx, [`/q-run-show: run ${runId} not found`]);
				return;
			}
			const stdoutSnippet = await readLogSnippet(projectRoot, runId, "stdout");
			const stderrSnippet = await readLogSnippet(projectRoot, runId, "stderr");
			const lines = [
				`run       : ${manifest.run_id}`,
				`recipe    : ${manifest.recipe}`,
				`profile   : ${manifest.profile ?? "(none)"}`,
				`mode      : ${manifest.mode}`,
				`started   : ${manifest.started_at}`,
				`finished  : ${manifest.finished_at}`,
				`duration  : ${manifest.duration_ms} ms`,
				`cwd       : ${manifest.cwd}`,
				`argv      : ${manifest.argv.join(" ")}`,
				`exit code : ${manifest.exit_code ?? "killed"}`,
				`timed out : ${manifest.timed_out}`,
				`cancelled : ${manifest.cancelled}`,
				`git       : ${manifest.git_commit ? manifest.git_commit.slice(0, 12) : "(no git)"}${manifest.git_dirty ? " (dirty)" : ""}`,
				`artifacts : ${manifest.artifact_paths.length > 0 ? manifest.artifact_paths.join(", ") : "(none)"}`,
				`stdout log: ${displayRelative(projectRoot, stdoutSnippet.path)}${stdoutSnippet.truncated ? " (truncated below)" : ""}`,
				`stderr log: ${displayRelative(projectRoot, stderrSnippet.path)}${stderrSnippet.truncated ? " (truncated below)" : ""}`,
				"",
				"--- stdout tail ---",
				stdoutSnippet.content || "(empty)",
				"--- stderr tail ---",
				stderrSnippet.content || "(empty)",
			];
			output(ctx, lines);
		},
	});

	// ------------------------------------------------------------ /q-gate

	function parseGateArgs(args: string): { selector: string; manualEvidence: Record<string, string> } {
		const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
		const selector = tokens[0] ?? "";
		const manualEvidence: Record<string, string> = {};
		for (const token of tokens.slice(1)) {
			const eq = token.indexOf("=");
			if (eq <= 0) continue;
			const key = token.slice(0, eq);
			if (!key.startsWith("manual:")) continue;
			manualEvidence[key.slice("manual:".length)] = token.slice(eq + 1);
		}
		return { selector, manualEvidence };
	}

	function renderGateRun(result: Awaited<ReturnType<typeof runGates>>, projectRoot: string): string[] {
		const lines = [
			`gate run   : ${result.runId}`,
			`requested  : ${result.requested.join(", ")}`,
			`profile    : ${result.profile ?? "(none)"}`,
			`status     : ${result.status}`,
			`exit code  : ${result.status === "PASS" ? 0 : 1}`,
			"",
		];
		for (const g of result.gates) {
			const reason = g.failure_reason ?? g.blocked_reason ?? "";
			lines.push(`  ${g.id.padEnd(4)} ${g.status.padEnd(8)} ${g.title}${reason ? ` — ${reason}` : ""}`);
		}
		lines.push("", `full record: ${displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${result.runId}`)}`);
		return lines;
	}

	pi.registerCommand("q-gate", {
		description: "Run gates: /q-gate <gate-id|base|quant|all> [manual:<check-id>=<evidence> ...]",
		handler: async (args, ctx) => {
			const { selector, manualEvidence } = parseGateArgs(args);
			if (!selector) {
				output(ctx, ["/q-gate: usage: /q-gate <gate-id|base|quant|all> [manual:<check-id>=<evidence> ...]"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-gate: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			try {
				const result = await runGates({ projectRoot, selector, mode, exec: execFn, signal: ctx.signal, manualEvidence });
				output(ctx, renderGateRun(result, projectRoot));
				void refreshStatus(ctx);
				void refreshWidget(ctx);
			} catch (error) {
				const message = error instanceof GateSetupError ? error.message : `failed to run gates: ${(error as Error).message}`;
				output(ctx, [`/q-gate: ${message}`]);
			}
		},
	});

	// ------------------------------------------------------------ /q-gates

	pi.registerCommand("q-gates", {
		description: "List the gates available for this project with their latest status",
		handler: async (_args, ctx) => {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-gates: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			try {
				const gates = await loadGates(projectRoot);
				if (gates.length === 0) {
					output(ctx, ["No gates available for this project/profile."]);
					return;
				}
				const lines = [`${gates.length} gate(s) for this project:`];
				for (const g of gates) {
					const latest = await latestGateStatus(projectRoot, g.id);
					const status = latest ? `${latest.status} (run ${latest.run_id})` : "NOT_RUN (never run)";
					const prereqs = g.prerequisites.length > 0 ? ` needs: ${g.prerequisites.join(",")}` : "";
					lines.push(`  ${g.id.padEnd(4)} ${status.padEnd(42)} ${g.title}${prereqs}`);
				}
				output(ctx, lines);
			} catch (error) {
				output(ctx, [`/q-gates: ${error instanceof GateSetupError ? error.message : (error as Error).message}`]);
			}
		},
	});

	// ------------------------------------------------------- /q-gate-show

	pi.registerCommand("q-gate-show", {
		description: "Show a gate definition: /q-gate-show <gate-id>",
		handler: async (args, ctx) => {
			const gateId = args.trim();
			if (!gateId) {
				output(ctx, ["/q-gate-show: usage: /q-gate-show <gate-id>"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-gate-show: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			try {
				const gates = await loadGates(projectRoot);
				const gate = gates.find((g) => g.id === gateId);
				if (!gate) {
					const known = gates.map((g) => g.id).join(", ") || "(none)";
					output(ctx, [`/q-gate-show: gate "${gateId}" not found. Available: ${known}`]);
					return;
				}
				const latest = await latestGateStatus(projectRoot, gate.id);
				output(ctx, renderGateDefinition(gate, latest?.status, latest?.run_id));
			} catch (error) {
				output(ctx, [`/q-gate-show: ${error instanceof GateSetupError ? error.message : (error as Error).message}`]);
			}
		},
	});

	// --------------------------------------------------------- /q-evidence

	pi.registerCommand("q-evidence", {
		description: "Show the evidence of a gate run: /q-evidence <run-id>",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!isValidRunId(runId)) {
				output(ctx, ["/q-evidence: usage: /q-evidence <run-id> (e.g. 20260101-120000-abcd)"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-evidence: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const manifest = await readManifest(projectRoot, runId);
			if (!manifest) {
				output(ctx, [`/q-evidence: run ${runId} not found`]);
				return;
			}
			if (manifest.recipe !== "gate") {
				output(ctx, [`/q-evidence: run ${runId} is a recipe run (recipe "${manifest.recipe}") — it has no gate evidence`]);
				return;
			}
			const { readFile } = await import("node:fs/promises");
			const evidence = await readFile(join(runsDirFor(projectRoot), runId, "evidence.json"), "utf8");
			const parsed = JSON.parse(evidence) as { checks?: Record<string, { status: string; kind: string; evidence: unknown[]; failure_reason?: string | null }> };
			const lines = [`evidence for gate run ${runId} (${Object.keys(parsed.checks ?? {}).length} check record(s)):`, ""];
			for (const [checkId, record] of Object.entries(parsed.checks ?? {})) {
				const items = (record.evidence ?? []).map((e) => {
					const ev = e as { type?: string; detail?: string };
					return `${ev.type ?? "?"}:${ev.detail ?? ""}`;
				});
				lines.push(`  ${checkId.padEnd(8)} ${record.status.padEnd(8)} ${record.kind.padEnd(8)} ${items.join(" | ") || "(no evidence)"}`);
			}
			lines.push("", `full record: ${displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${runId}/evidence.json`)}`);
			output(ctx, lines);
		},
	});

	// ----------------------------------------------------------- /q-report

	pi.registerCommand("q-report", {
		description: "Show a run report: /q-report latest | /q-report <run-id> (manifest, gates, quant facts)",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target) {
				output(ctx, ["/q-report: usage: /q-report latest | /q-report <run-id> (e.g. 20260101-120000-abcd)"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-report: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const runId = await resolveRunTarget(projectRoot, target);
			if (!runId) {
				output(ctx, [
					`/q-report: ${isValidRunId(target) ? `run ${target} not found` : `unknown target "${target}" (use "latest" or a run id)`}`,
				]);
				return;
			}
			const lines = await buildRunReport(projectRoot, runId);
			output(ctx, lines ?? [`/q-report: run ${runId} not found`]);
		},
	});

	// ---------------------------------------------------------- /q-compare

	pi.registerCommand("q-compare", {
		description: "Compare two runs: /q-compare <run-id-a> <run-id-b> (exit code, duration, artifacts, gates, quant metrics)",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
			if (tokens.length < 2) {
				output(ctx, ["/q-compare: usage: /q-compare <run-id-a> <run-id-b> (e.g. /q-compare 20260101-120000-abcd 20260102-120000-efgh)"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-compare: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const outcome = await compareRuns(projectRoot, tokens[0] ?? "", tokens[1] ?? "");
			if (!outcome.ok) {
				output(ctx, [`/q-compare: ${outcome.error}`]);
				return;
			}
			output(ctx, renderCompareLines(outcome.report, true));
		},
	});

	// ----------------------------------------------------------- /q-widget

	pi.registerCommand("q-widget", {
		description: "Toggle the workbench widget: /q-widget on | /q-widget off (widget also shows during tasks and gate failures)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				widgetForced = true;
				output(ctx, ["workbench widget: on (shown while a task is active, a gate is failing, or forced)"]);
			} else if (arg === "off") {
				widgetForced = false;
				output(ctx, ["workbench widget: off (auto-hides; still shows during tasks and gate failures)"]);
			} else {
				output(ctx, ["/q-widget: usage: /q-widget on | /q-widget off"]);
				return;
			}
			await refreshWidget(ctx);
		},
	});

	// --------------------------------------------------------- custom tools

	pi.registerTool({
		name: "workbench_project_inspect",
		label: "Workbench project inspect",
		description:
			"Inspect the current project's workbench setup: project root, git state, detected language/package manager, workbench profile, declared recipes, and configuration errors. Never outputs secrets.",
		promptSnippet: "Inspect workbench project configuration (root, git, stack, profile, recipes, config errors)",
		promptGuidelines: [
			"Use workbench_project_inspect before running or designing recipes to learn the project profile and available recipe names.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: `workbench_project_inspect: ${trustError}` }], details: {} };
			}
			const projectRoot = await projectRootFor(ctx);
			const result = await inspectProject(projectRoot, { trusted: true, exec: execFn });
			const lines = [
				`project root : ${result.project_root}`,
				`git          : ${result.git.is_git ? `${result.git.branch ?? "(detached)"} @ ${result.git.commit?.slice(0, 12) ?? "(no commits)"}${result.git.dirty ? " (dirty)" : ""}` : "(not a git repo)"}`,
				`stacks       : ${result.stacks.length > 0 ? result.stacks.map((s) => `${s.language}${s.package_manager ? ` (${s.package_manager})` : ""}`).join(", ") : "(none detected)"}`,
				`profile      : ${result.profile ?? "(not set)"}`,
				`config files : ${result.config_files_present.length > 0 ? result.config_files_present.join(", ") : "(none — run /q-init)"}`,
				`config errors: ${result.config_errors.length > 0 ? result.config_errors.map((e) => `${e.file}: ${e.message}`).join("; ") : "(none)"}`,
				`recipes      : ${result.recipes.length > 0 ? result.recipes.map((r) => `${r.name} [${r.allowed_modes.join(",")}]`).join(", ") : "(none)"}`,
			];
			const details: InspectToolDetails = {
				project_root: result.project_root,
				git: result.git,
				stacks: result.stacks.map((s) => `${s.language}${s.package_manager ? ` (${s.package_manager})` : ""}`),
				profile: result.profile,
				recipes: result.recipes.map((r) => r.name),
				config_errors: result.config_errors.map((e) => `${e.file}: ${e.message}`),
				config_files_present: result.config_files_present,
			};
			return { content: [{ type: "text", text: lines.join("\n") }], details };
		},
		...workbenchToolRenderer("inspect", "workbench_project_inspect"),
	});

	pi.registerTool({
		name: "workbench_run_recipe",
		label: "Workbench run recipe",
		description:
			"Run a declared recipe from .pi/workbench/recipes.yaml by name with schema-approved parameters. Only declared recipes run — arbitrary commands are never accepted. Full output is written to the run directory; a truncated summary is returned. Use workbench_project_inspect to list recipes.",
		promptSnippet: "Run a declared workbench recipe by name (controlled execution)",
		promptGuidelines: [
			"Use workbench_run_recipe instead of bash for project commands that are declared as recipes — the model must not improvise shell commands in VERIFY mode.",
			"Only pass parameters declared in the recipe's params schema.",
		],
		parameters: Type.Object({
			recipe: Type.String({ description: "Name of a declared recipe in .pi/workbench/recipes.yaml" }),
			params: Type.Optional(
				Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
					description: "Recipe parameters declared in the recipe schema (substituted into argv placeholders)",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: `workbench_run_recipe: ${trustError}` }], details: {} };
			}
			const projectRoot = await projectRootFor(ctx);
			onUpdate?.({
				content: [{ type: "text", text: `Running recipe "${params.recipe}" (${mode} mode)...` }],
				details: { phase: "started", recipe: params.recipe },
			});
			try {
				const result = await runRecipe({
					projectRoot,
					recipeName: params.recipe,
					params: params.params ?? {},
					mode,
					exec: execFn,
					signal,
				});
				if (!result.ok && result.error) {
					return { content: [{ type: "text", text: `workbench_run_recipe: ${result.error}` }], details: { ok: false, error: result.error } };
				}
				const summary = result.summary;
				if (!summary) {
					return { content: [{ type: "text", text: "workbench_run_recipe: no summary produced" }], details: { ok: false } };
				}
				const status = summary.timed_out ? "TIMED OUT" : summary.cancelled ? "CANCELLED" : result.ok ? "OK" : "FAILED";
				const text = [
					`run_id    : ${summary.run_id}`,
					`recipe    : ${summary.recipe}`,
					`status    : ${status}`,
					`exit code : ${summary.exit_code ?? "killed"}`,
					`duration  : ${summary.duration_ms} ms`,
					`artifacts : ${summary.artifact_paths.length > 0 ? summary.artifact_paths.join(", ") : "(none)"}`,
					`stdout log: ${displayRelative(projectRoot, summary.stdout_log)} (${summary.stdout_truncated ? "truncated below" : "complete below"})`,
					`stderr log: ${displayRelative(projectRoot, summary.stderr_log)} (${summary.stderr_truncated ? "truncated below" : "complete below"})`,
					"",
					"--- stdout ---",
					summary.stdout || "(empty)",
					"--- stderr ---",
					summary.stderr || "(empty)",
					"",
					`Full logs: read ${displayRelative(projectRoot, summary.stdout_log)} and ${displayRelative(projectRoot, summary.stderr_log)} (full output is never placed inline; use workbench_read_run or /q-run-show for bounded snippets).`,
				].join("\n");
				const details: RecipeToolDetails = {
					ok: result.ok,
					run_id: summary.run_id,
					recipe: summary.recipe,
					status,
					exit_code: summary.exit_code ?? null,
					duration_ms: summary.duration_ms,
					artifact_paths: summary.artifact_paths,
					stdout_log: displayRelative(projectRoot, summary.stdout_log),
					stderr_log: displayRelative(projectRoot, summary.stderr_log),
					expected_exit_codes: result.record?.expected_exit_codes ?? [0],
					phase: "finished",
				};
				onUpdate?.({
					content: [{ type: "text", text }],
					details: { ...details },
				});
				return { content: [{ type: "text", text }], details: { ...details, record: result.record } };
			} catch (error) {
				// Setup violations (path escapes) and spawn failures surface as errors.
				throw new Error(error instanceof RecipeSetupError ? error.message : `workbench_run_recipe failed: ${(error as Error).message}`);
			}
		},
		...workbenchToolRenderer("recipe", "workbench_run_recipe"),
	});

	pi.registerTool({
		name: "workbench_read_run",
		label: "Workbench read run",
		description:
			"Read a workbench run record by run_id: manifest metadata, summary, and bounded log snippets. Full logs are never sent inline; use the returned log paths with read/grep when more detail is needed.",
		promptSnippet: "Read a workbench run record (manifest, summary, bounded logs) by run_id",
		promptGuidelines: [
			"Use workbench_read_run to inspect previous recipe runs; default output is deliberately bounded.",
		],
		parameters: Type.Object({
			run_id: Type.String({ description: "Run id, e.g. 20260101-120000-abcd" }),
			include: Type.Optional(
				Type.Union([Type.Literal("summary"), Type.Literal("manifest"), Type.Literal("logs"), Type.Literal("all")], {
					description: "What to include (default: all, with bounded log tails)",
				}),
			),
			max_lines: Type.Optional(Type.Integer({ description: "Log snippet line cap (default 200)", minimum: 1, maximum: 2000 })),
			max_bytes: Type.Optional(Type.Integer({ description: "Log snippet byte cap (default 20KB)", minimum: 1, maximum: 512000 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: `workbench_read_run: ${trustError}` }], details: {} };
			}
			if (!isValidRunId(params.run_id)) {
				return { content: [{ type: "text", text: `workbench_read_run: invalid run_id "${params.run_id}"` }], details: {} };
			}
			const projectRoot = await projectRootFor(ctx);
			const manifest = await readManifest(projectRoot, params.run_id);
			if (!manifest) {
				return { content: [{ type: "text", text: `workbench_read_run: run ${params.run_id} not found` }], details: {} };
			}
			const include = params.include ?? "all";
			const summary = include === "manifest" ? null : await readSummary(projectRoot, params.run_id);
			const snippetOptions = { maxLines: params.max_lines, maxBytes: params.max_bytes };
			const stdoutSnippet = include === "manifest" || include === "summary" ? null : await readLogSnippet(projectRoot, params.run_id, "stdout", snippetOptions);
			const stderrSnippet = include === "manifest" || include === "summary" ? null : await readLogSnippet(projectRoot, params.run_id, "stderr", snippetOptions);
			const lines = [
				`run_id     : ${manifest.run_id}`,
				`recipe     : ${manifest.recipe}`,
				`profile    : ${manifest.profile ?? "(none)"}`,
				`mode       : ${manifest.mode}`,
				`started    : ${manifest.started_at}`,
				`finished   : ${manifest.finished_at}`,
				`duration   : ${manifest.duration_ms} ms`,
				`cwd        : ${manifest.cwd}`,
				`argv       : ${manifest.argv.join(" ")}`,
				`exit code  : ${manifest.exit_code ?? "killed"}`,
				`timed out  : ${manifest.timed_out}`,
				`cancelled  : ${manifest.cancelled}`,
				`git        : ${manifest.git_commit ? manifest.git_commit.slice(0, 12) : "(no git)"}${manifest.git_dirty ? " (dirty)" : ""}`,
				`artifacts  : ${manifest.artifact_paths.length > 0 ? manifest.artifact_paths.join(", ") : "(none)"}`,
				`declared writes: ${manifest.declared_writes.length > 0 ? manifest.declared_writes.join(", ") : "(none)"}`,
			];
			if (summary) {
				lines.push(`stdout truncated: ${summary.stdout_truncated}`, `stderr truncated: ${summary.stderr_truncated}`);
			}
			if (stdoutSnippet) {
				lines.push("", `--- stdout tail (${stdoutSnippet.truncated ? "truncated" : "full"}): ${displayRelative(projectRoot, stdoutSnippet.path)} ---`, stdoutSnippet.content || "(empty)");
			}
			if (stderrSnippet) {
				lines.push("", `--- stderr tail (${stderrSnippet.truncated ? "truncated" : "full"}): ${displayRelative(projectRoot, stderrSnippet.path)} ---`, stderrSnippet.content || "(empty)");
			}
			lines.push("", `Full logs: ${displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${manifest.run_id}/stdout.log`)} (read the file for the complete output)`);
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
				stdout_log: displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${manifest.run_id}/stdout.log`),
				stderr_log: displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${manifest.run_id}/stderr.log`),
			};
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details,
			};
		},
		...workbenchToolRenderer("read_run", "workbench_read_run"),
	});

	pi.registerTool({
		name: "workbench_run_gate",
		label: "Workbench run gate",
		description:
			"Run a gate selector (gate id, comma-separated ids, or base|quant|all) from the validation ladder. Only declared recipes run; the gate engine never trusts model prose — manual evidence supplied here is recorded with type \"manual\" and can never masquerade as machine verification.",
		promptSnippet: "Run validation gates (base/quant ladder) for the project",
		promptGuidelines: [
			"Use workbench_list_gates or /q-gates to see the gates available for the current profile.",
			"Manual evidence for manual checks must be passed as manual_evidence keyed by check id; it is recorded as type \"manual\" only.",
		],
		parameters: Type.Object({
			gates: Type.String({ description: "Gate selector: a gate id (e.g. \"b0\"), comma-separated ids, or base|quant|all" }),
			manual_evidence: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Manual evidence notes keyed by check id — recorded as manual evidence, never as machine verification",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: `workbench_run_gate: ${trustError}` }], details: {} };
			}
			const projectRoot = await projectRootFor(ctx);
			onUpdate?.({
				content: [{ type: "text", text: `Running gates "${params.gates}" (${mode} mode)...` }],
				details: { phase: "started", gates: params.gates },
			});
			try {
				const result = await runGates({
					projectRoot,
					selector: params.gates,
					mode,
					exec: execFn,
					signal,
					manualEvidence: params.manual_evidence ?? {},
				});
				const text = renderGateRun(result, projectRoot).join("\n");
				const details: GateToolDetails = {
					ok: result.ok,
					status: result.status,
					run_id: result.runId,
					requested: result.requested,
					profile: result.profile,
					gates: result.gates.map((g) => ({
						id: g.id,
						status: g.status,
						title: g.title,
						failure_reason: g.failure_reason,
						blocked_reason: g.blocked_reason,
						failed_checks: g.checks.filter((c) => c.status === "FAIL").map((c) => c.check_id),
					})),
					counts: {
						pass: result.gates.filter((g) => g.status === "PASS").length,
						fail: result.gates.filter((g) => g.status === "FAIL").length,
						blocked: result.gates.filter((g) => g.status === "BLOCKED").length,
						not_run: result.gates.filter((g) => g.status === "NOT_RUN").length,
					},
					log_path: displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${result.runId}`),
					phase: "finished",
				};
				onUpdate?.({ content: [{ type: "text", text }], details: { ...details } });
				return { content: [{ type: "text", text }], details: { ...details, gates_full: result.gates } };
			} catch (error) {
				throw new Error(error instanceof GateSetupError ? error.message : `workbench_run_gate failed: ${(error as Error).message}`);
			}
		},
		...workbenchToolRenderer("gate", "workbench_run_gate"),
	});

	pi.registerTool({
		name: "workbench_read_gate",
		label: "Workbench read gate",
		description:
			"Read a gate run record by run_id (gates.json summary) or a gate definition by gate_id (with its latest persisted status). Provide exactly one of run_id / gate_id.",
		promptSnippet: "Read a gate run record or gate definition",
		promptGuidelines: [
			"Use workbench_read_gate with run_id to inspect the per-gate statuses of a gate run.",
			"Use workbench_read_gate with gate_id to see the gate definition and its latest status.",
		],
		parameters: Type.Object({
			run_id: Type.Optional(Type.String({ description: "Run id of a gate run (e.g. 20260101-120000-abcd)" })),
			gate_id: Type.Optional(Type.String({ description: "Gate id (e.g. b0, q3)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: `workbench_read_gate: ${trustError}` }], details: {} };
			}
			const projectRoot = await projectRootFor(ctx);
			if (params.run_id === undefined && params.gate_id === undefined) {
				return { content: [{ type: "text", text: "workbench_read_gate: provide run_id or gate_id" }], details: {} };
			}
			if (params.run_id !== undefined) {
				if (!isValidRunId(params.run_id)) {
					return { content: [{ type: "text", text: `workbench_read_gate: invalid run_id "${params.run_id}"` }], details: {} };
				}
				const manifest = await readManifest(projectRoot, params.run_id);
				if (!manifest) {
					return { content: [{ type: "text", text: `workbench_read_gate: run ${params.run_id} not found` }], details: {} };
				}
				if (manifest.recipe !== "gate") {
					return { content: [{ type: "text", text: `workbench_read_gate: run ${params.run_id} is not a gate run (recipe "${manifest.recipe}")` }], details: {} };
				}
				const { readFile } = await import("node:fs/promises");
				const gatesJson = JSON.parse(await readFile(join(runsDirFor(projectRoot), params.run_id, "gates.json"), "utf8")) as { gates: GateRunEntry[] };
				const lines = [`gate run ${params.run_id} (profile ${manifest.profile ?? "(none)"}):`, ""];
				for (const g of gatesJson.gates) {
					const reason = g.failure_reason ?? g.blocked_reason ?? "";
					lines.push(`  ${g.id.padEnd(4)} ${g.status.padEnd(8)} ${g.title}${reason ? ` — ${reason}` : ""}`);
					for (const c of g.checks) {
						const why = c.failure_reason ?? c.blocked_reason ?? "";
						lines.push(`      ${c.check_id.padEnd(8)} ${c.status.padEnd(8)} ${c.kind}${why ? ` — ${why}` : ""}`);
					}
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { run_id: params.run_id, gates: gatesJson.gates.map((g) => ({ id: g.id, status: g.status })) },
				};
			}
			const gates = await loadGates(projectRoot);
			const gate = gates.find((g) => g.id === params.gate_id);
			if (!gate) {
				return { content: [{ type: "text", text: `workbench_read_gate: gate "${params.gate_id}" not found for this profile` }], details: {} };
			}
			const latest = await latestGateStatus(projectRoot, gate.id);
			return {
				content: [{ type: "text", text: renderGateDefinition(gate, latest?.status, latest?.run_id).join("\n") }],
				details: { gate_id: gate.id, latest_status: latest?.status ?? "NOT_RUN", latest_run: latest?.run_id ?? null },
			};
		},
	});

	pi.registerTool({
		name: "workbench_list_gates",
		label: "Workbench list gates",
		description: "List the validation gates available for the current project/profile with their latest persisted status.",
		promptSnippet: "List available validation gates and their latest status",
		promptGuidelines: [
			"Use workbench_list_gates before running gates to see which gates the current profile loads (base b0-b5 always; quant q0-q5 only for quant-research profiles).",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: `workbench_list_gates: ${trustError}` }], details: {} };
			}
			const projectRoot = await projectRootFor(ctx);
			const gates = await loadGates(projectRoot);
			const lines = [`${gates.length} gate(s) for this project:`];
			const statuses: Record<string, string> = {};
			for (const g of gates) {
				const latest = await latestGateStatus(projectRoot, g.id);
				const status = latest ? `${latest.status} (run ${latest.run_id})` : "NOT_RUN (never run)";
				statuses[g.id] = latest?.status ?? "NOT_RUN";
				const prereqs = g.prerequisites.length > 0 ? ` needs: ${g.prerequisites.join(",")}` : "";
				lines.push(`  ${g.id.padEnd(4)} ${status.padEnd(42)} ${g.title}${prereqs}`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: { gate_count: gates.length, statuses } };
		},
	});

	pi.registerTool({
		name: "workbench_compare_runs",
		label: "Workbench compare runs",
		description:
			"Compare two workbench run records by run_id: exit code, duration, artifact changes, gate delta, and (when both runs carry a valid quant-result artifact) benchmark/return/drawdown/turnover/cost/fold deltas and parameter changes. All facts come from the runs' own JSON records; deltas are descriptive — a higher return is never automatically interpreted as a better strategy.",
		promptSnippet: "Compare two workbench run records (exit code, duration, artifacts, gates, quant metrics)",
		promptGuidelines: [
			"Use workbench_compare_runs to diff two persisted run records; use /q-runs or workbench_read_run to discover run ids first.",
			"Deltas are descriptive facts — do not treat a higher return as automatically better without risk-adjusted and out-of-sample evidence.",
		],
		parameters: Type.Object({
			a: Type.String({ description: "First run id, e.g. 20260101-120000-abcd" }),
			b: Type.String({ description: "Second run id, e.g. 20260102-120000-efgh" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: `workbench_compare_runs: ${trustError}` }], details: { ok: false, error: trustError } };
			}
			const projectRoot = await projectRootFor(ctx);
			const outcome = await compareRuns(projectRoot, params.a, params.b);
			if (!outcome.ok) {
				const details: CompareToolDetails = { ok: false, error: outcome.error };
				return { content: [{ type: "text", text: `workbench_compare_runs: ${outcome.error}` }], details };
			}
			const details: CompareToolDetails = { ok: true, report: outcome.report };
			return {
				content: [{ type: "text", text: renderCompareLines(outcome.report, true).join("\n") }],
				details,
			};
		},
		...workbenchToolRenderer("compare", "workbench_compare_runs"),
	});

	// ------------------------------------------- second-layer tool_call guard

	pi.on("tool_call", async (event) => {
		const check = checkToolCall(mode, event.toolName, event.input);
		if (!check.allowed) {
			return {
				block: true,
				reason: check.reason ?? `Blocked by workbench ${mode} mode`,
			};
		}
		// P5: remember which project files the agent modified (bounded) so the
		// compaction supplement can point at them.
		if ((event.toolName === "edit" || event.toolName === "write") && event.input && typeof event.input === "object") {
			const path = (event.input as { path?: unknown }).path;
			if (typeof path === "string" && path.length > 0) {
				compactState.modifiedFiles = pushBounded(compactState.modifiedFiles, path, MAX_MODIFIED_FILES);
			}
		}
		return undefined;
	});
}
