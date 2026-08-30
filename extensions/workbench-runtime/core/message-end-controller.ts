/** Assistant telemetry, worker budget steering and status refresh on message_end. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CacheTelemetry } from "../cache/cache-telemetry.ts";
import {
	WORKER_HARD_BUDGET,
	WORKER_MODEL_CONTEXT_TOKENS,
	WORKER_SOFT_BUDGET,
	WORKER_SOFT_STEER_MESSAGE_TYPE,
	WORKER_SOFT_STEER_TEXT,
	workerBudgetBand,
	workerContextTokens,
} from "./worker-budget.ts";
import {
	addWorkerSpendUsage,
	EMPTY_WORKER_SPEND_STATE,
	formatWorkerSpendSteerText,
	workerSpendBand,
	workerSpendReasons,
	WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE,
	type WorkerSpendProfile,
	type WorkerSpendState,
} from "./worker-spend.ts";
import { WORKER_CHECKPOINT_REQUEST_ENTRY_TYPE_V1 } from "./worker-checkpoint.ts";

interface WorkerMessageContext {
	readonly role?: string;
	readonly spendProfile: WorkerSpendProfile;
	readonly timeoutMs?: number;
	readonly attempt?: number;
	readonly initialSpendState?: Readonly<WorkerSpendState>;
}

export const WORKER_TIME_CHECKPOINT_MESSAGE_TYPE = "workbench-worker-time-checkpoint";
export const WORKER_TIME_FINALIZE_MESSAGE_TYPE = "workbench-worker-time-finalize";
export const WORKER_TIME_CHECKPOINT_RATIO = 0.65;
export const WORKER_TIME_FINALIZE_RATIO = 0.85;

export const WORKER_TIME_CHECKPOINT_TEXT = [
	"Worker wall-clock checkpoint reached (65% of the existing timeout).",
	"Stop broad exploration. Finish one coherent in-scope change, run the cheapest requested verification that still fits, and keep the final report ready.",
	"If the contract cannot fit, report the exact blocker and remaining work instead of starting another branch of investigation.",
].join("\n");

export const WORKER_TIME_FINALIZE_TEXT = [
	"Worker wall-clock finalization window reached (85% of the existing timeout).",
	"Do not start new edits or broad tests. Preserve truthful verification facts and write the required four-heading final report now.",
	"Incomplete work is an explicit Remaining Risk; a usable handoff is better than a timeout with an empty report.",
].join("\n");

export interface MessageEndController {
	pi: Pick<ExtensionAPI, "on" | "sendMessage" | "appendEntry" | "getThinkingLevel" | "getActiveTools" | "getAllTools">;
	cacheTelemetry: CacheTelemetry;
	getWorkerContext(): WorkerMessageContext;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	refreshStatus(ctx: ExtensionContext, pendingMessage?: unknown): Promise<void>;
	onWorkerBudgetSteerSent?(): void;
	/** Deterministic timer seams for direct tests. */
	scheduleTimer?(callback: () => void, delayMs: number): unknown;
	clearTimer?(handle: unknown): void;
}

/** Register the best-effort message_end observer. */
export function registerMessageEndController(controller: MessageEndController): void {
	let workerSoftSteerSent = false;
	let workerSpendSoftSteerSent = false;
	let workerSpendSteerIssuedThisSession = false;
	let workerCheckpointRequestAppended = false;
	let workerSpendState: WorkerSpendState = { ...EMPTY_WORKER_SPEND_STATE };
	let wallClockTimers: unknown[] = [];

	const clearWallClockTimers = (): void => {
		for (const handle of wallClockTimers) {
			if (controller.clearTimer) controller.clearTimer(handle);
			else clearTimeout(handle as ReturnType<typeof setTimeout>);
		}
		wallClockTimers = [];
	};
	const scheduleWallClockSteer = (delayMs: number, customType: string, content: string, ratio: number): void => {
		const callback = () => {
			try {
				controller.pi.sendMessage({
					customType,
					content,
					display: false,
					details: { timeout_ratio: ratio, delay_ms: delayMs },
				}, { deliverAs: "steer" });
				controller.onWorkerBudgetSteerSent?.();
			} catch {
				// Advisory delivery never changes worker execution or authority.
			}
		};
		const handle = controller.scheduleTimer?.(callback, delayMs) ?? setTimeout(callback, delayMs);
		if (!controller.scheduleTimer && typeof handle === "object" && handle !== null && "unref" in handle) {
			(handle as { unref(): void }).unref();
		}
		wallClockTimers.push(handle);
	};

	controller.pi.on("session_start", () => {
		clearWallClockTimers();
		workerSoftSteerSent = false;
		workerSpendSoftSteerSent = false;
		workerSpendSteerIssuedThisSession = false;
		workerCheckpointRequestAppended = false;
		const worker = controller.getWorkerContext();
		workerSpendState = worker.initialSpendState === undefined
			? { ...EMPTY_WORKER_SPEND_STATE }
			: { ...worker.initialSpendState };
		// Per-process soft steering is one-shot. Current fresh continuations
		// start at zero; the optional initial state remains a legacy/test seam.
		// If that seam starts inside the soft band, do not emit a duplicate steer.
		workerSpendSoftSteerSent = worker.role === "worker"
			&& workerSpendBand(workerSpendState, worker.spendProfile) !== "ok";
		if (worker.role === "worker" && worker.timeoutMs !== undefined) {
			scheduleWallClockSteer(
				Math.max(1, Math.floor(worker.timeoutMs * WORKER_TIME_CHECKPOINT_RATIO)),
				WORKER_TIME_CHECKPOINT_MESSAGE_TYPE,
				WORKER_TIME_CHECKPOINT_TEXT,
				WORKER_TIME_CHECKPOINT_RATIO,
			);
			scheduleWallClockSteer(
				Math.max(1, Math.floor(worker.timeoutMs * WORKER_TIME_FINALIZE_RATIO)),
				WORKER_TIME_FINALIZE_MESSAGE_TYPE,
				WORKER_TIME_FINALIZE_TEXT,
				WORKER_TIME_FINALIZE_RATIO,
			);
		}
	});

	controller.pi.on("message_end", async (event, ctx) => {
		const message = event.message as {
			provider?: string;
			model?: string;
			api?: string;
			usage?: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				totalTokens: number;
				cost: { total: number };
			};
			stopReason?: string;
			errorMessage?: string;
		};
		if (event.message.role === "assistant") {
			const spendSteerWasSentBeforeMessage = workerSpendSoftSteerSent;
			try {
				if (ctx.isProjectTrusted()) {
					const projectRoot = await controller.projectRootFor(ctx);
					controller.cacheTelemetry.setProjectRoot(projectRoot);
					if (message.usage) {
						await controller.cacheTelemetry.observeMessageEnd({
							provider: message.provider ?? "unknown",
							model: message.model ?? "unknown",
							apiKind: typeof message.api === "string" ? message.api : ctx.model?.api ?? null,
							usage: message.usage,
							stopReason: message.stopReason,
							errorMessage: message.errorMessage,
							thinkingLevel: ctx.thinkingLevel ?? controller.pi.getThinkingLevel(),
							systemPrompt: ctx.getSystemPrompt(),
							activeToolNames: controller.pi.getActiveTools(),
							tools: controller.pi.getAllTools().map((tool) => ({
								name: tool.name,
								description: tool.description,
								promptSnippet: (tool as { promptSnippet?: string }).promptSnippet,
								parameters: tool.parameters,
								promptGuidelines: tool.promptGuidelines,
							})),
						});
					}
				}
			} catch {
				// Telemetry must never alter a model request.
			}

			const worker = controller.getWorkerContext();
			if (worker.role === "worker" && !workerSoftSteerSent) {
				try {
					const contextTokens = workerContextTokens(message.usage);
					if (workerBudgetBand(contextTokens) !== "ok") {
						controller.pi.sendMessage({
							customType: WORKER_SOFT_STEER_MESSAGE_TYPE,
							content: WORKER_SOFT_STEER_TEXT,
							display: false,
							details: {
								context_tokens: contextTokens,
								budget: WORKER_MODEL_CONTEXT_TOKENS,
								soft: WORKER_SOFT_BUDGET,
								hard: WORKER_HARD_BUDGET,
							},
						}, { deliverAs: "steer" });
						workerSoftSteerSent = true;
						controller.onWorkerBudgetSteerSent?.();
					}
				} catch {
					// A steer must never alter a model request.
				}
			}
			if (worker.role === "worker") {
				try {
					workerSpendState = addWorkerSpendUsage(workerSpendState, message.usage);
					if (!workerSpendSoftSteerSent && workerSpendBand(workerSpendState, worker.spendProfile) !== "ok") {
						controller.pi.sendMessage({
							customType: WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE,
							content: formatWorkerSpendSteerText(workerSpendState, worker.spendProfile),
							display: false,
							details: {
								profile: worker.spendProfile,
								band: workerSpendBand(workerSpendState, worker.spendProfile),
								reasons: workerSpendReasons(workerSpendState, worker.spendProfile),
								turns: workerSpendState.turns,
								total_tokens: workerSpendState.totalTokens,
								output_tokens: workerSpendState.outputTokens,
							},
						}, { deliverAs: "steer" });
						workerSpendSoftSteerSent = true;
						workerSpendSteerIssuedThisSession = true;
						controller.onWorkerBudgetSteerSent?.();
					}
				} catch {
					// Spend steering must never alter a model request.
				}
				if (spendSteerWasSentBeforeMessage && workerSpendSteerIssuedThisSession && !workerCheckpointRequestAppended) {
					try {
						controller.pi.appendEntry(WORKER_CHECKPOINT_REQUEST_ENTRY_TYPE_V1, {
							schema_version: 1,
							kind: WORKER_CHECKPOINT_REQUEST_ENTRY_TYPE_V1,
							attempt: worker.attempt ?? 1,
							completed_criteria: [],
							remaining_criteria: [],
						});
						workerCheckpointRequestAppended = true;
					} catch {
						// Missing checkpoint telemetry leaves continuation fail closed.
					}
				}
			}
		}
		try {
			await controller.refreshStatus(ctx, event.message);
		} catch {
			// Status refresh is best effort.
		}
		return undefined;
	});
}
