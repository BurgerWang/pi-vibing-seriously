/** Public bounded tool-result recovery controller. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	deriveResultId,
	isValidIdentity,
	receiptRelativePath,
	recoverFailureText,
	renderReceiptRecovery,
	type recoverReceipt,
	type RecoverOutcome,
} from "./tool-result-recovery.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";

export interface RecoveryToolController {
	pi: Pick<ExtensionAPI, "registerTool">;
	services: RecoveryToolServices;
	trustedOrError(ctx: ExtensionContext): string | undefined;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
}

export interface RecoveryToolServices {
	recoverReceipt: typeof recoverReceipt;
}

/** Register recover_tool_result at the final catalog position. */
export function registerRecoveryTool(controller: RecoveryToolController): void {
	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_recover_tool_result,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_recover_tool_result,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: `workbench_recover_tool_result: ${trustError}` }], details: {} };
			}
			const hasResultId = params.result_id !== undefined;
			const hasToolCallId = params.tool_call_id !== undefined;
			if (hasResultId === hasToolCallId) {
				return {
					content: [{ type: "text", text: `workbench_recover_tool_result: ${recoverFailureText("invalid")}` }],
					details: { ok: false, available: false, code: "invalid" },
				};
			}
			const projectRoot = await controller.projectRootFor(ctx);
			let id: string | undefined;
			let outcome: RecoverOutcome;
			if (hasResultId) {
				id = params.result_id;
				outcome = await controller.services.recoverReceipt({ projectRoot, id });
			} else {
				const sessionIdentity = ctx.sessionManager.getSessionId();
				const toolCallId = params.tool_call_id;
				if (typeof sessionIdentity !== "string" || typeof toolCallId !== "string" || !isValidIdentity(sessionIdentity, toolCallId)) {
					return {
						content: [{ type: "text", text: `workbench_recover_tool_result: ${recoverFailureText("invalid")}` }],
						details: { ok: false, available: false, code: "invalid" },
					};
				}
				id = deriveResultId(sessionIdentity, toolCallId);
				outcome = await controller.services.recoverReceipt({ projectRoot, sessionIdentity, toolCallId });
			}
			if (!outcome.ok) {
				const facts: Record<string, unknown> = { ok: false, available: false, code: outcome.kind };
				if (outcome.kind === "missing" && id !== undefined) facts.result_id = id;
				else if (outcome.kind === "incomplete") facts.result_id = outcome.started.id;
				return {
					content: [{ type: "text", text: `workbench_recover_tool_result: ${recoverFailureText(outcome.kind)}` }],
					details: facts,
				};
			}
			const receipt = outcome.receipt;
			return {
				content: [{ type: "text", text: renderReceiptRecovery(projectRoot, receipt) }],
				details: {
					ok: true,
					available: true,
					result_id: receipt.id,
					tool: receipt.tool,
					status: receipt.status,
					path: receiptRelativePath(projectRoot, receipt.id),
					summary_omitted_lines: receipt.summary_omitted_lines,
					summary_omitted_bytes: receipt.summary_omitted_bytes,
				},
			};
		},
	});
}
