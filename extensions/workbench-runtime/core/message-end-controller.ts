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

interface WorkerMessageContext {
	readonly role?: string;
	readonly spendProfile: WorkerSpendProfile;
}

export interface MessageEndController {
	pi: Pick<ExtensionAPI, "on" | "sendMessage" | "getThinkingLevel" | "getActiveTools" | "getAllTools">;
	cacheTelemetry: CacheTelemetry;
	getWorkerContext(): WorkerMessageContext;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	refreshStatus(ctx: ExtensionContext, pendingMessage?: unknown): Promise<void>;
	onWorkerBudgetSteerSent?(): void;
}

/** Register the best-effort message_end observer. */
export function registerMessageEndController(controller: MessageEndController): void {
	let workerSoftSteerSent = false;
	let workerSpendSoftSteerSent = false;
	let workerSpendState: WorkerSpendState = { ...EMPTY_WORKER_SPEND_STATE };

	controller.pi.on("session_start", () => {
		workerSoftSteerSent = false;
		workerSpendSoftSteerSent = false;
		workerSpendState = { ...EMPTY_WORKER_SPEND_STATE };
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
						controller.onWorkerBudgetSteerSent?.();
					}
				} catch {
					// Spend steering must never alter a model request.
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
