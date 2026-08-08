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
import { MAX_WORKER_REPORT_BYTES, workerCacheHitRatio } from "./handoff.ts";
// The deterministic cache-summary presentation moved to worker/handoff.ts
// (the bounded-handoff module); kept re-exported here for callers of the
// runner module.
export { formatWorkerCacheSummary, workerCacheHitRatio } from "./handoff.ts";

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
import {
	addWorkerSpendUsage,
	EMPTY_WORKER_SPEND_STATE,
	formatWorkerSpendHardStop,
	resolveWorkerSpendProfile,
	workerSpendBand,
	workerSpendDimensionFlags,
	workerSpendReasons,
	WORKER_SPEND_PROFILE_ENV,
	type WorkerSpendBand,
	type WorkerSpendDimensionFlags,
	type WorkerSpendProfile,
	type WorkerSpendReason,
	type WorkerSpendState,
} from "../core/worker-spend.ts";

export const WORKER_SYSTEM_PROMPT = `You are the implementation worker in pi-dev-workbench.

The GPT-5.6 Sol parent owns requirements, cross-cutting architecture, scope, review of the actual diff, final verification and gates, and the final verdict. You own routine local implementation decisions inside the approved contract: concrete design choices, naming, file structure within the approved scope, and how the slice is implemented, tested, and documented. When completion requires an unapproved architecture, security/policy, destructive, or out-of-scope decision, stop and report the decision to Sol instead of guessing or expanding scope.

Implement the complete delegated slice, not a narrow code edit. Before changing code, inspect the relevant files. Make the production source changes, add the tests and docs, run the requested write-free declared workbench recipes when available, and repair in-scope defects you find. Make complete production changes and tests, not stubs or TODO shells. Implement only the delegated task and only within the parent-approved paths. Never delegate another worker. Never run final validation gates. Free-form bash is unavailable; use only write-free declared workbench recipes for project commands.

Three mandatory execution disciplines:
1. EARLY CHECKPOINT — after inspecting the relevant files and before the first write, privately compare your planned changed paths, acceptance criteria, and verification to the exact contract and the remaining spend; if the plan does not fit, stop and report to Sol rather than expand. A repair with a known root cause must not reopen broad diagnosis.
2. STOPPING HYGIENE — before your final response, re-read every changed path and confirm no accidental out-of-scope writes, no stubs or TODO placeholders, no accidental generated artifacts, and that every requested check is reported truthfully; hygiene must not trigger unrelated cleanup.
3. SHORT REPORT — keep exactly the four final headings; Completed, Verification, and Remaining Risks each take at most 4 single-line bullets of at most 240 characters; Files Changed is exempt from that cap: list EVERY actually changed project-relative path, one exact project-relative path per single-line bullet, with no prose — mechanically bounded by the ledger's existing 500 changed-path fail-closed limit, and use \`- None.\` when nothing changed; Verification reports only the command and its observed outcome, never logs; never repeat the task or acceptance criteria.

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
	/**
	 * The COMPLETE final assistant text retained in process memory for the
	 * durable worker-report.md artifact: bounded only by the JSON-event
	 * input cap (MAX_JSON_LINE_BYTES = 2 MiB) — NEVER pre-truncated to the
	 * report bound, so the ledger can redact FIRST and cap + marker only
	 * after redaction (post-secret tail content survives when redaction
	 * makes the report fit). Intermediate assistant texts never survive
	 * (only the final text wins, exactly like `output`). This text never
	 * enters onUpdate/WorkerProgress.
	 */
	reportText: string;
	/** True when the final assistant text exceeded MAX_WORKER_REPORT_BYTES (raw-byte fact). */
	reportTextOversized: boolean;
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
	// ---------------------------------------------------------------- Phase 2
	// Cumulative delegation-spend facts (worker token-budget repair, Phase 2):
	// the profile this run accumulated against, the final cumulative spend
	// state (turns / total / output), the final band, the triggered reasons in
	// the fixed order, and per-dimension soft/hard trigger flags. All facts
	// derive from the pure policy in core/worker-spend.ts and are recorded on
	// EVERY outcome (success, hard stop, compaction, drift, abort, timeout,
	// spawn failure). The profile is the runner-resolved value (deterministic
	// `standard` default when no profile was requested).
	/** Spend profile this run accumulated against (deterministic default: standard). */
	spendProfile: WorkerSpendProfile;
	/** Final cumulative spend state (turns / totalTokens / outputTokens). */
	spendState: WorkerSpendState;
	/** Final cumulative spend band ("ok" | "soft" | "hard"). */
	spendBand: WorkerSpendBand;
	/** Triggered spend dimensions for the final band, fixed order. */
	spendReasons: WorkerSpendReason[];
	/** Per-dimension soft trigger flags at the final spend state. */
	spendSoftReached: WorkerSpendDimensionFlags["soft"];
	/** Per-dimension hard trigger flags at the final spend state. */
	spendHardExceeded: WorkerSpendDimensionFlags["hard"];
}

export interface WorkerProgress {
	/**
	 * Phase 4 (worker token-budget repair): numeric-only cumulative spend
	 * progress. Every callback carries exactly turns / totalTokens /
	 * outputTokens / spendBand plus the pinned provider/model identity —
	 * never worker text, reasons, report content, tool arguments, patches,
	 * logs, or error prose. All three counters come from ONE cumulative
	 * spend-state snapshot after that assistant message was accumulated and
	 * evaluated (band via the same pure policy), so the final progress tuple
	 * exactly equals the final WorkerRunResult spendState/spendBand facts.
	 * Counters are always finite normalized non-negative numbers; spendBand
	 * is always the fixed `ok` | `soft` | `hard` enum.
	 */
	turns: number;
	/** Cumulative normalized total tokens after this assistant message. */
	totalTokens: number;
	/** Cumulative normalized output tokens after this assistant message. */
	outputTokens: number;
	/** Cumulative spend band after this assistant message (fixed enum). */
	spendBand: WorkerSpendBand;
	provider?: string;
	model?: string;
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
	/**
	 * Internal cumulative spend profile for this delegation run (worker
	 * token-budget repair, Phase 2). Optional and deterministic: omitted
	 * values resolve to the `standard` profile. Only the typed
	 * low/standard/extended profile is accepted. The resolved profile is
	 * passed to the child through the fixed WORKER_SPEND_PROFILE_ENV env
	 * contract, so the worker-role lifecycle enforces the SAME profile the
	 * runner accumulates against. Public selection (tool schema) is Phase 3.
	 */
	spendProfile?: WorkerSpendProfile;
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

function childEnvironment(projectRoot: string, allowedPaths: readonly string[], spendProfile: WorkerSpendProfile): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// Parent-session identity/model facts must never masquerade as child facts.
	for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
		delete env[key];
	}
	env[WORKER_ROLE_ENV] = WORKER_ROLE;
	env[WORKER_DEPTH_ENV] = "1";
	env[WORKER_PROJECT_ROOT_ENV] = projectRoot;
	env[WORKER_ALLOWED_PATHS_ENV] = JSON.stringify(allowedPaths);
	// Phase 2: the fixed spend-profile child env contract — the runner ALWAYS
	// writes a valid resolved profile value here (never empty/malformed).
	env[WORKER_SPEND_PROFILE_ENV] = spendProfile;
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
	// Phase 2 cumulative spend hard stop: any hard spend dimension reached
	// fails closed regardless of the child's eventual exit code, and the
	// deterministic hard-stop formatter outranks the ordinary exit/timeout
	// text. This check sits parallel to the existing 900k hard-context path
	// (compaction and hard-context keep their existing precedence above it;
	// model-drift/abort/timeout keep their existing relative order below it).
	if (
		result.spendHardExceeded.turns ||
		result.spendHardExceeded.totalTokens ||
		result.spendHardExceeded.outputTokens
	) {
		return formatWorkerSpendHardStop(result.spendState, result.spendProfile);
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
	// Phase 2: deterministic profile resolution — omitted/undefined resolves
	// to the `standard` profile; only the typed low/standard/extended value
	// is accepted by the options contract.
	const spendProfile = resolveWorkerSpendProfile(options.spendProfile);
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
		reportText: "",
		reportTextOversized: false,
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
		spendProfile,
		spendState: { ...EMPTY_WORKER_SPEND_STATE },
		spendBand: "ok",
		spendReasons: [],
		spendSoftReached: { turns: false, totalTokens: false, outputTokens: false },
		spendHardExceeded: { turns: false, totalTokens: false, outputTokens: false },
	};

	try {
		await new Promise<void>((resolvePromise) => {
			const child = spawn(invocation.command, args, {
				cwd: options.projectRoot,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnvironment(options.projectRoot, options.contract.allowedPaths, spendProfile),
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
				// Phase 2 cumulative spend accounting (independent of the per-message
				// context safety above): every assistant message increments the
				// cumulative spend state exactly once via the pure policy — turns + 1,
				// normalized total/output added (positive totalTokens authoritative,
				// else the non-negative component sum; cacheRead counts; malformed
				// usage contributes zero but still counts the turn — never NaN). Any
				// hard dimension reached (`>=`) terminates the child fail-closed with
				// the deterministic hard-stop message; soft alone never fails.
				result.spendState = addWorkerSpendUsage(result.spendState, message.usage);
				const spendFlags = workerSpendDimensionFlags(result.spendState, spendProfile);
				if (spendFlags.hard.turns || spendFlags.hard.totalTokens || spendFlags.hard.outputTokens) {
					result.errorMessage = formatWorkerSpendHardStop(result.spendState, spendProfile);
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
					// Retain the COMPLETE final assistant text for worker-report.md
					// persistence — bounded only by the bounded JSON-event input
					// (MAX_JSON_LINE_BYTES = 2 MiB), NEVER pre-truncated to the
					// report bound: redaction happens BEFORE any truncation in the
					// ledger, so content after long secrets survives when redaction
					// makes the report fit. The oversized flag is the raw-byte fact;
					// this is a private child-local variable — it never enters
					// onUpdate.
					result.reportText = text;
					result.reportTextOversized = Buffer.byteLength(text, "utf8") > MAX_WORKER_REPORT_BYTES;
				}
				// Phase 4: the progress tuple is built AFTER the message was
				// accumulated/evaluated above, from the SAME cumulative spend
				// state the final result facts derive from — every tuple matches
				// the final ledger counters at the last event, hard stops
				// included (the callback still runs after terminate()). Numeric
				// counters only plus the pinned identity: never text of any kind.
				options.onProgress?.({
					turns: result.spendState.turns,
					totalTokens: result.spendState.totalTokens,
					outputTokens: result.spendState.outputTokens,
					spendBand: workerSpendBand(result.spendState, spendProfile),
					provider: result.provider,
					model: result.model,
				});
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
		// Phase 2: record the deterministic FINAL spend facts (profile, state,
		// band, fixed-order reasons, per-dimension soft/hard flags) from the
		// final cumulative state on every outcome.
		const finalSpendFlags = workerSpendDimensionFlags(result.spendState, spendProfile);
		result.spendBand = workerSpendBand(result.spendState, spendProfile);
		result.spendReasons = workerSpendReasons(result.spendState, spendProfile);
		result.spendSoftReached = finalSpendFlags.soft;
		result.spendHardExceeded = finalSpendFlags.hard;
		return result;
	} finally {
		await rm(promptDir, { recursive: true, force: true });
	}
}
