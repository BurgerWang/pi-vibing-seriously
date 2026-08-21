/** Tool-result envelope, receipt and bounded-details middleware pipeline. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { projectToolResultDetails, type BoundedReceiptFacts } from "./details-projection.ts";
import {
	enforceOutputEnvelope,
	type BoundedContinuation,
	type OutputEnvelopeFacts,
	type OutputEnvelopeResult,
} from "./output-envelope.ts";
import { resolveToolOutputPolicy } from "./output-policy.ts";
import { runtimeFailureEnvelope } from "./runtime-output-controller.ts";
import {
	TOOL_RESULT_INGRESS_BUDGET_BYTES,
	projectToolResultIngress,
	type ToolResultIngressProjectionMetadata,
	type TrustedRecoveryAuthority,
} from "./tool-result-ingress-projection.ts";
import { finalizeReceipt, finalizeUnavailableCode, receiptRelativePath, type ReceiptHandle } from "./tool-result-recovery.ts";
import { toolResultTextContentDigest } from "./trusted-recovery-authority.ts";
import type { TurnOutputAuthorization, TurnOutputBudgetState, TurnRole } from "./turn-output-budget.ts";
import type { BoundTrustedIngressAuthority } from "./runtime-transient-state.ts";
import {
	WORKER_WRITE_JOURNAL_RUNTIME_RESULT_ERROR_TEXT,
	type WorkerWriteJournalRuntime,
} from "./worker-write-journal-runtime.ts";

export interface PendingReceiptHandle {
	readonly handle: ReceiptHandle;
	readonly projectRoot: string;
}

export interface ToolResultMiddlewareController {
	pi: Pick<ExtensionAPI, "on">;
	workerJournalActive: boolean;
	workerWriteJournalRuntime: WorkerWriteJournalRuntime;
	getOutputTurnRole(): TurnRole;
	takeTrustedContinuation(toolCallId: unknown, toolName: unknown): BoundedContinuation | undefined;
	takeOutputAuthorization(toolCallId: unknown, toolName: unknown): TurnOutputAuthorization | undefined;
	authorizeOutput(toolCallId: unknown, toolName: unknown, input: unknown): TurnOutputAuthorization;
	takeTrustedIngressAuthority(toolCallId: unknown, toolName: unknown): BoundTrustedIngressAuthority | undefined;
	turnOutputBudget: TurnOutputBudgetState;
	observeOutputEnvelope(toolName: unknown, facts: unknown): void;
	rememberProcessedNormalResult(toolCallId: unknown, toolName: unknown): void;
	pendingReceiptHandles: Map<string, PendingReceiptHandle>;
	secrets: readonly string[];
}

/** Register the ordered tool_result middleware chain. */
export function registerToolResultMiddleware(controller: ToolResultMiddlewareController): void {
	const outputEnvelopeFactsByEvent = new WeakMap<object, OutputEnvelopeFacts>();
	const receiptFactsByEvent = new WeakMap<object, BoundedReceiptFacts>();
	const ingressProjectionFactsByEvent = new WeakMap<object, ToolResultIngressProjectionMetadata>();

	if (controller.workerJournalActive) {
		controller.pi.on("tool_result", async (event) => {
			if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
			const completed = await controller.workerWriteJournalRuntime.completeToolResult({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
			});
			if (completed.ok) return undefined;
			return { content: [{ type: "text", text: WORKER_WRITE_JOURNAL_RUNTIME_RESULT_ERROR_TEXT }], isError: true };
		});
	}

	controller.pi.on("tool_result", (event) => {
		let envelope: OutputEnvelopeResult;
		let ingressMetadata: ToolResultIngressProjectionMetadata | undefined;
		let ingressContentDigest: string | undefined;
		try {
			const originalContent = event.content;
			const trustedContinuation = controller.takeTrustedContinuation(event.toolCallId, event.toolName);
			const authorization = controller.takeOutputAuthorization(event.toolCallId, event.toolName)
				?? controller.authorizeOutput(event.toolCallId, event.toolName, event.input);
			const policy = resolveToolOutputPolicy({ toolName: event.toolName, args: event.input, role: controller.getOutputTurnRole() });
			const trustedIngress = controller.takeTrustedIngressAuthority(event.toolCallId, event.toolName);
			if (!authorization.allowed || !authorization.authorizationId) {
				envelope = enforceOutputEnvelope({ toolName: event.toolName, content: [], isError: true, policy, allocatedBytes: 0 });
			} else {
				const applyEnvelope = (content: unknown): OutputEnvelopeResult => enforceOutputEnvelope({
					toolName: event.toolName,
					content: content as Parameters<typeof enforceOutputEnvelope>[0]["content"],
					isError: event.isError,
					policy,
					allocatedBytes: authorization.allocatedBytes,
					continuation: trustedContinuation,
				});
				let contentForEnvelope: unknown = originalContent;
				if (trustedIngress) {
					const observedDigest = toolResultTextContentDigest(originalContent);
					if (observedDigest && observedDigest === trustedIngress.contentDigest) {
						const ingress = projectToolResultIngress({
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							content: originalContent,
							isError: event.isError,
							authority: trustedIngress.authority,
						});
						const allocationCanHoldWrapper = !ingress.changed || authorization.allocatedBytes >= TOOL_RESULT_INGRESS_BUDGET_BYTES;
						if (ingress.status === "projected" && allocationCanHoldWrapper) {
							const projectedDigest = toolResultTextContentDigest(ingress.content);
							if (projectedDigest) {
								contentForEnvelope = ingress.content;
								ingressContentDigest = projectedDigest;
								ingressMetadata = ingress.metadata;
							}
						}
					}
				}
				envelope = applyEnvelope(contentForEnvelope);
				if (ingressMetadata) {
					const finalContentDigest = envelope.isError ? undefined : toolResultTextContentDigest(envelope.content);
					if (!ingressContentDigest || finalContentDigest !== ingressContentDigest) {
						envelope = applyEnvelope(originalContent);
						ingressMetadata = undefined;
						ingressContentDigest = undefined;
					}
				}
				const accounting = controller.turnOutputBudget.consumeResult({
					authorizationId: authorization.authorizationId,
					actualBytes: envelope.facts.shownTextBytes,
				});
				if (!accounting.accepted) {
					envelope = enforceOutputEnvelope({ toolName: event.toolName, content: [], isError: true, policy, allocatedBytes: 0 });
					ingressMetadata = undefined;
					ingressContentDigest = undefined;
				}
			}
		} catch {
			ingressMetadata = undefined;
			const policy = resolveToolOutputPolicy({ toolName: event.toolName, args: undefined, role: controller.getOutputTurnRole() });
			envelope = enforceOutputEnvelope({ toolName: event.toolName, content: [], isError: true, policy, allocatedBytes: 0 });
		}
		outputEnvelopeFactsByEvent.set(event, envelope.facts);
		ingressProjectionFactsByEvent.delete(event);
		if (ingressMetadata) ingressProjectionFactsByEvent.set(event, ingressMetadata);
		controller.observeOutputEnvelope(event.toolName, envelope.facts);
		controller.rememberProcessedNormalResult(event.toolCallId, event.toolName);
		return { content: envelope.content, isError: envelope.isError };
	});

	controller.pi.on("tool_result", async (event) => {
		const pending = controller.pendingReceiptHandles.get(event.toolCallId);
		if (!pending) return undefined;
		const { handle, projectRoot } = pending;
		try {
			if (event.toolName !== handle.toolName) {
				receiptFactsByEvent.set(event, { available: false, code: "tool_name_mismatch", result_id: handle.id, tool: handle.toolName });
				return undefined;
			}
			const text = event.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("");
			const outcome = await finalizeReceipt({
				projectRoot,
				handle,
				status: event.isError ? "error" : "success",
				content: text,
				error: event.isError ? text : undefined,
				secrets: controller.secrets,
			});
			receiptFactsByEvent.set(event, outcome.ok
				? { available: true, result_id: outcome.receipt.id, status: outcome.receipt.status, path: receiptRelativePath(projectRoot, outcome.receipt.id) }
				: { available: false, code: finalizeUnavailableCode(outcome), result_id: handle.id });
		} catch {
			receiptFactsByEvent.set(event, { available: false, code: "storage_error", result_id: handle.id });
		} finally {
			controller.pendingReceiptHandles.delete(event.toolCallId);
		}
		return undefined;
	});

	controller.pi.on("tool_result", (event) => {
		try {
			const envelope = outputEnvelopeFactsByEvent.get(event) ?? runtimeFailureEnvelope().facts;
			const receipt = receiptFactsByEvent.get(event);
			const ingressProjection = ingressProjectionFactsByEvent.get(event);
			let details: unknown;
			try { details = event.details; } catch { details = undefined; }
			return {
				details: projectToolResultDetails({ toolName: event.toolName, details, envelope, receipt, ingressProjection }).details,
			};
		} finally {
			outputEnvelopeFactsByEvent.delete(event);
			receiptFactsByEvent.delete(event);
			ingressProjectionFactsByEvent.delete(event);
		}
	});
}
