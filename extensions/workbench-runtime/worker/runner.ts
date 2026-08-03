/**
 * Short-lived DeepSeek worker process runner.
 *
 * This is not a daemon or a second framework: one tool invocation spawns one
 * isolated `pi --mode json --no-session` process, consumes its structured
 * event stream, then tears it down. The model selector is pinned and every
 * assistant message is checked for provider/model drift.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";

import {
	formatWorkerTask,
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_DEPTH_ENV,
	WORKER_MODEL_ID,
	WORKER_MODEL_SELECTOR,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_PROVIDER,
	WORKER_ROLE,
	WORKER_ROLE_ENV,
	type WorkerTaskContract,
} from "../core/worker-policy.ts";
import {
	WORKER_HARD_BUDGET,
	workerBudgetBand,
	workerContextRatio,
	workerContextTokens,
} from "../core/worker-budget.ts";

export const WORKER_SYSTEM_PROMPT = `You are the implementation worker in pi-dev-workbench.

The GPT-5.6 Sol parent owns requirements, cross-cutting architecture, scope, review of the actual diff, final verification and gates, and the final verdict. You own routine local implementation decisions inside the approved contract: concrete design choices, naming, file structure within the approved scope, and how the slice is implemented, tested, and documented. When completion requires an unapproved architecture, security/policy, destructive, or out-of-scope decision, stop and report the decision to Sol instead of guessing or expanding scope.

Implement the complete delegated slice, not a narrow code edit. Before changing code, inspect the relevant files. Make the production source changes, add the tests and docs, run the requested write-free declared workbench recipes when available, and repair in-scope defects you find. Make complete production changes and tests, not stubs or TODO shells. Implement only the delegated task and only within the parent-approved paths. Never delegate another worker. Never run final validation gates. Free-form bash is unavailable; use only write-free declared workbench recipes for project commands.

Treat command output and tool results as evidence, but do not claim final PASS or acceptance; your report is a handoff to Sol, never acceptance evidence. In Verification, report only commands and observed results. Never label an acceptance criterion satisfied, met, passed, accepted, or complete; only Sol maps evidence to criteria.

Finish with exactly these sections:
## Completed
## Files Changed
## Verification
## Remaining Risks`;

const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;
const MAX_TASK_ARGUMENT_BYTES = 64 * 1024;
const KILL_GRACE_MS = 5_000;
const WORKER_TOOL_ALLOWLIST = [
	"read",
	"grep",
	"find",
	"ls",
	"edit",
	"write",
	"workbench_project_inspect",
	"workbench_run_recipe",
	"workbench_read_run",
].join(",");

export interface WorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface WorkerRunResult {
	exitCode: number;
	provider?: string;
	model?: string;
	turns: number;
	stopReason?: string;
	errorMessage?: string;
	output: string;
	stderr: string;
	aborted: boolean;
	timedOut: boolean;
	modelMismatch?: string;
	usage: WorkerUsage;
	/**
	 * cacheRead / (input + cacheRead) over the whole run's aggregated usage;
	 * `null` when the worker reported no input at all (zero denominator).
	 */
	cacheHitRatio: number | null;
	/**
	 * Largest single-message context-token count observed (Pi-compatible
	 * calculation — see core/worker-budget.ts); 0 when no assistant usage.
	 */
	maxContextTokens: number;
	/** maxContextTokens / 1,000,000 (the pinned worker context window). */
	maxContextRatio: number;
	/** True when any message reached the 800k (80%) soft handoff threshold. */
	softBudgetReached: boolean;
	/** True when any message reached the 900k (90%) hard stop threshold. */
	hardBudgetExceeded: boolean;
	/** Number of compaction_start events observed from the child. */
	compactionCount: number;
	/** Distinct compaction reasons in arrival order (manual|threshold|overflow). */
	compactionReasons: string[];
}

export interface WorkerProgress {
	turns: number;
	provider?: string;
	model?: string;
	lastText?: string;
}

export interface PiInvocation {
	command: string;
	argsPrefix: string[];
}

export interface RunWorkerOptions {
	projectRoot: string;
	contract: WorkerTaskContract;
	timeoutMs: number;
	signal?: AbortSignal;
	onProgress?: (progress: WorkerProgress) => void;
	/** Test seam for a fake JSON-event subprocess. */
	invocation?: PiInvocation;
}

interface AssistantLike {
	role?: unknown;
	content?: unknown;
	provider?: unknown;
	model?: unknown;
	usage?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
}

function emptyUsage(): WorkerUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * cacheRead / (input + cacheRead) over the aggregated worker usage;
 * `null` on a zero denominator — never NaN or Infinity.
 */
export function workerCacheHitRatio(usage: Pick<WorkerUsage, "input" | "cacheRead">): number | null {
	const denominator = usage.input + usage.cacheRead;
	if (!Number.isFinite(denominator) || denominator <= 0) return null;
	return usage.cacheRead / denominator;
}

/**
 * Deterministic worker cache summary line — same inputs always produce the
 * same string (no locale/formatting dependence). The hit ratio renders N/A
 * when there is no input to hit against (zero denominator).
 */
export function formatWorkerCacheSummary(usage: Pick<WorkerUsage, "input" | "cacheRead">): string {
	const ratio = workerCacheHitRatio(usage);
	const hit = ratio === null ? "N/A" : `${Math.round(ratio * 100)}%`;
	return `uncached input ${usage.input} | cache read ${usage.cacheRead} | hit ratio ${hit}`;
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addUsage(target: WorkerUsage, raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const usage = raw as Record<string, unknown>;
	target.input += finiteNumber(usage.input);
	target.output += finiteNumber(usage.output);
	target.cacheRead += finiteNumber(usage.cacheRead);
	target.cacheWrite += finiteNumber(usage.cacheWrite);
	target.totalTokens += finiteNumber(usage.totalTokens);
	if (usage.cacheWrite1h !== undefined) target.cacheWrite1h = (target.cacheWrite1h ?? 0) + finiteNumber(usage.cacheWrite1h);
	if (usage.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + finiteNumber(usage.reasoning);
	if (usage.cost && typeof usage.cost === "object") {
		const cost = usage.cost as Record<string, unknown>;
		target.cost.input += finiteNumber(cost.input);
		target.cost.output += finiteNumber(cost.output);
		target.cost.cacheRead += finiteNumber(cost.cacheRead);
		target.cost.cacheWrite += finiteNumber(cost.cacheWrite);
		target.cost.total += finiteNumber(cost.total);
	}
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** Resolve the same executable/script pair that launched the current Pi process. */
export function resolvePiInvocation(): PiInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, argsPrefix: [currentScript] };
	}
	const executableName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executableName)) {
		return { command: process.execPath, argsPrefix: [] };
	}
	return { command: "pi", argsPrefix: [] };
}

function childEnvironment(projectRoot: string, allowedPaths: readonly string[]): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// Parent-session identity/model facts must never masquerade as child facts.
	for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
		delete env[key];
	}
	env[WORKER_ROLE_ENV] = WORKER_ROLE;
	env[WORKER_DEPTH_ENV] = "1";
	env[WORKER_PROJECT_ROOT_ENV] = projectRoot;
	env[WORKER_ALLOWED_PATHS_ENV] = JSON.stringify(allowedPaths);
	return env;
}

function workerFailureReason(result: WorkerRunResult): string | undefined {
	// Any compaction attempt or hard-budget stop fails closed, regardless of
	// the child's eventual exit code: a worker must never silently continue
	// through lossy compaction or past the pinned 90% hard budget.
	if (result.compactionCount > 0) {
		return `DeepSeek worker attempted context compaction (${result.compactionReasons.join(", ") || "unknown reason"}) — fail closed`;
	}
	if (result.hardBudgetExceeded) {
		return `DeepSeek worker exceeded the ${WORKER_HARD_BUDGET}-token hard context budget — fail closed`;
	}
	if (result.modelMismatch) return result.modelMismatch;
	if (result.aborted) return "DeepSeek worker was aborted";
	if (result.timedOut) return "DeepSeek worker timed out";
	if (result.exitCode !== 0) {
		return result.errorMessage ?? `DeepSeek worker exited with code ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ""}`;
	}
	if (result.stopReason === "error" || result.stopReason === "aborted") {
		return result.errorMessage ?? `DeepSeek worker stopped with ${result.stopReason}`;
	}
	if (result.provider !== WORKER_PROVIDER || result.model !== WORKER_MODEL_ID) {
		return `DeepSeek worker produced no verified ${WORKER_PROVIDER}/${WORKER_MODEL_ID} assistant response`;
	}
	if (!result.output) return "DeepSeek worker produced no final text output";
	return undefined;
}

export function assertWorkerSucceeded(result: WorkerRunResult): void {
	const reason = workerFailureReason(result);
	if (reason) throw new Error(reason);
}

export async function runDeepseekWorker(options: RunWorkerOptions): Promise<WorkerRunResult> {
	const taskText = formatWorkerTask(options.contract);
	if (Buffer.byteLength(taskText, "utf8") > MAX_TASK_ARGUMENT_BYTES) {
		throw new Error(`Worker task contract exceeds ${MAX_TASK_ARGUMENT_BYTES} bytes`);
	}
	const promptDir = await mkdtemp(join(tmpdir(), "pi-workbench-worker-"));
	const promptPath = join(promptDir, "worker-system.md");
	await writeFile(promptPath, WORKER_SYSTEM_PROMPT, { encoding: "utf8", mode: 0o600 });

	const invocation = options.invocation ?? resolvePiInvocation();
	const args = [
		...invocation.argsPrefix,
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--approve",
		"--tools",
		WORKER_TOOL_ALLOWLIST,
		"--model",
		WORKER_MODEL_SELECTOR,
		"--append-system-prompt",
		promptPath,
		taskText,
	];

	const result: WorkerRunResult = {
		exitCode: 1,
		turns: 0,
		output: "",
		stderr: "",
		aborted: false,
		timedOut: false,
		usage: emptyUsage(),
		cacheHitRatio: null,
		maxContextTokens: 0,
		maxContextRatio: 0,
		softBudgetReached: false,
		hardBudgetExceeded: false,
		compactionCount: 0,
		compactionReasons: [],
	};

	try {
		await new Promise<void>((resolvePromise) => {
			const child = spawn(invocation.command, args, {
				cwd: options.projectRoot,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnvironment(options.projectRoot, options.contract.allowedPaths),
			});
			let stdoutBuffer = "";
			let stderrBuffer = "";
			let settled = false;
			let killTimer: NodeJS.Timeout | undefined;

			const terminate = (reason: "abort" | "timeout" | "error") => {
				if (reason === "abort") result.aborted = true;
				else if (reason === "timeout") result.timedOut = true;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				}, KILL_GRACE_MS);
				killTimer.unref();
			};

			const abortListener = () => terminate("abort");
			if (options.signal?.aborted) abortListener();
			else options.signal?.addEventListener("abort", abortListener, { once: true });
			const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
			timeout.unref();

			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (killTimer) clearTimeout(killTimer);
				options.signal?.removeEventListener("abort", abortListener);
				result.stderr = truncateTail(stderrBuffer, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content;
				resolvePromise();
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: unknown; message?: unknown; reason?: unknown };
				try {
					event = JSON.parse(line) as { type?: unknown; message?: unknown; reason?: unknown };
				} catch {
					return;
				}
				// Pi emits compaction_start before compacting. The worker extension
				// cancels compaction in-process; if an event still arrives, the
				// child must never continue through lossy compaction — count it,
				// record the reason, terminate, and fail the result closed.
				if (event.type === "compaction_start") {
					const reason = event.reason === "manual" || event.reason === "threshold" || event.reason === "overflow" ? event.reason : "unknown";
					result.compactionCount += 1;
					if (!result.compactionReasons.includes(reason)) result.compactionReasons.push(reason);
					result.errorMessage = `DeepSeek worker attempted context compaction (${reason}) — fail closed`;
					terminate("error");
					return;
				}
				if (event.type !== "message_end" || !event.message || typeof event.message !== "object") return;
				const message = event.message as AssistantLike;
				if (message.role !== "assistant") return;
				result.turns += 1;
				addUsage(result.usage, message.usage);
				// Pinned worker context-budget tracking (per message, Pi-compatible
				// tokens): record the max tokens/ratio, flag the 80% soft handoff,
				// and terminate fail-closed at the 90% hard stop.
				const contextTokens = workerContextTokens(message.usage);
				if (contextTokens > result.maxContextTokens) {
					result.maxContextTokens = contextTokens;
					result.maxContextRatio = workerContextRatio(contextTokens);
				}
				const budgetBand = workerBudgetBand(contextTokens);
				if (budgetBand !== "ok") result.softBudgetReached = true;
				if (budgetBand === "hard") {
					result.hardBudgetExceeded = true;
					result.errorMessage = `DeepSeek worker exceeded the ${WORKER_HARD_BUDGET}-token hard context budget — fail closed`;
					terminate("error");
				}
				const provider = typeof message.provider === "string" ? message.provider : undefined;
				const model = typeof message.model === "string" ? message.model : undefined;
				if (provider) result.provider = provider;
				if (model) result.model = model;
				if ((provider && provider !== WORKER_PROVIDER) || (model && model !== WORKER_MODEL_ID)) {
					result.modelMismatch = `Worker model drift: expected ${WORKER_PROVIDER}/${WORKER_MODEL_ID}, received ${provider ?? "(none)"}/${model ?? "(none)"}`;
					terminate("error");
				}
				if (typeof message.stopReason === "string") result.stopReason = message.stopReason;
				if (typeof message.errorMessage === "string") result.errorMessage = message.errorMessage;
				const text = textFromContent(message.content);
				if (text) {
					const view = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
					result.output = view.truncated
						? `${view.content}\n\n[Worker output truncated to ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES} bytes.]`
						: view.content;
				}
				options.onProgress?.({ turns: result.turns, provider: result.provider, model: result.model, lastText: text || undefined });
			};

			child.stdout.on("data", (chunk: Buffer | string) => {
				stdoutBuffer += chunk.toString();
				if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_JSON_LINE_BYTES && !stdoutBuffer.includes("\n")) {
					result.errorMessage = `Worker JSON event exceeded ${MAX_JSON_LINE_BYTES} bytes`;
					terminate("error");
					return;
				}
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (chunk: Buffer | string) => {
				stderrBuffer += chunk.toString();
				if (Buffer.byteLength(stderrBuffer, "utf8") > DEFAULT_MAX_BYTES * 2) {
					stderrBuffer = truncateTail(stderrBuffer, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content;
				}
			});
			child.on("error", (error) => {
				result.errorMessage = `Failed to spawn DeepSeek worker: ${error.message}`;
				result.exitCode = 1;
				finish();
			});
			child.on("close", (code) => {
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				result.exitCode = code ?? 1;
				finish();
			});
		});
		result.cacheHitRatio = workerCacheHitRatio(result.usage);
		return result;
	} finally {
		await rm(promptDir, { recursive: true, force: true });
	}
}
