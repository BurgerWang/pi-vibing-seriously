/** Public delegation-status tool controller. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { delegationContextRiskLine } from "../worker/context-diagnostics.ts";
import {
	workbenchRuntimeBuildDetailsV1,
	workbenchRuntimeBuildLinesV1,
} from "./runtime-build-identity.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";

export interface DelegationStatusToolController {
	pi: Pick<ExtensionAPI, "registerTool">;
	trustedOrError(ctx: ExtensionContext): string | undefined;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	syncLease(): void;
	delegationStatusLines(projectRoot: string): Promise<{ lines: string[]; gitRefresh: "fresh" | "unavailable" }>;
	refreshStatus?(ctx: ExtensionContext): Promise<void>;
}

/** Register delegation_status at its fixed catalog position. */
export function registerDelegationStatusTool(controller: DelegationStatusToolController): void {
	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_delegation_status,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_delegation_status,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const buildLines = workbenchRuntimeBuildLinesV1();
			const buildDetails = workbenchRuntimeBuildDetailsV1();
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				return {
					content: [{ type: "text", text: [`workbench_delegation_status: ${trustError}`, ...buildLines].join("\n") }],
					details: buildDetails,
				};
			}
			controller.syncLease();
			const projectRoot = await controller.projectRootFor(ctx);
			const status = await controller.delegationStatusLines(projectRoot);
			// The read just refreshed the durable repair projection. Rebuild the
			// action snapshot and active-tool surface in the same tool turn so the
			// commander can execute the reported route immediately.
			await controller.refreshStatus?.(ctx);
			const contextRisk = delegationContextRiskLine(ctx.sessionManager.getEntries());
			const lines = [...buildLines, ...status.lines];
			if (contextRisk) lines.push(contextRisk);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { git_refresh: status.gitRefresh, ...buildDetails },
			};
		},
	});
}
