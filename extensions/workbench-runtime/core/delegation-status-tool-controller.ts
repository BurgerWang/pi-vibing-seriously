/** Public delegation-status tool controller. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { delegationContextRiskLine } from "../worker/context-diagnostics.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";

export interface DelegationStatusToolController {
	pi: Pick<ExtensionAPI, "registerTool">;
	trustedOrError(ctx: ExtensionContext): string | undefined;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	syncLease(): void;
	delegationStatusLines(projectRoot: string): Promise<{ lines: string[]; gitRefresh: "fresh" | "unavailable" }>;
}

/** Register delegation_status at its fixed catalog position. */
export function registerDelegationStatusTool(controller: DelegationStatusToolController): void {
	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_delegation_status,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_delegation_status,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: `workbench_delegation_status: ${trustError}` }], details: {} };
			}
			controller.syncLease();
			const projectRoot = await controller.projectRootFor(ctx);
			const status = await controller.delegationStatusLines(projectRoot);
			const contextRisk = delegationContextRiskLine(ctx.sessionManager.getEntries());
			return {
				content: [{ type: "text", text: contextRisk ? [...status.lines, contextRisk].join("\n") : status.lines.join("\n") }],
				details: { git_refresh: status.gitRefresh },
			};
		},
	});
}
