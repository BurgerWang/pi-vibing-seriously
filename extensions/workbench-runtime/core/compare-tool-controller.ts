/** Public immutable run-comparison tool controller. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { compareRuns } from "./compare.ts";
import { COMPARISON_PERSIST_ERROR } from "./comparison-record.ts";
import { renderCompareLines, type CompareToolDetails } from "./render.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";
import type { buildTrustedRecoveryAuthority } from "./trusted-recovery-authority.ts";
import type { TrustedRecoveryAuthority } from "./tool-result-ingress-projection.ts";
import { workbenchToolRenderer } from "../ui/tool-renderers.ts";

export interface CompareToolController<TIngress> {
	pi: Pick<ExtensionAPI, "registerTool">;
	services: CompareToolServices;
	trustedOrError(ctx: ExtensionContext): string | undefined;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	bindTrustedIngressAuthority(authority: TrustedRecoveryAuthority | undefined, content: unknown): TIngress | undefined;
	rememberTrustedIngressAuthority(toolCallId: unknown, toolName: unknown, bound: TIngress | undefined): void;
}

export interface CompareToolServices {
	compareRuns: typeof compareRuns;
	buildTrustedRecoveryAuthority: typeof buildTrustedRecoveryAuthority;
}

/** Register compare_runs at its fixed catalog position. */
export function registerCompareTool<TIngress>(controller: CompareToolController<TIngress>): void {
	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_compare_runs,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_compare_runs,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			let trustedIngress: TIngress | undefined;
			try {
				const trustError = controller.trustedOrError(ctx);
				if (trustError) {
					return { content: [{ type: "text", text: `workbench_compare_runs: ${trustError}` }], details: { ok: false, error: trustError } };
				}
				const projectRoot = await controller.projectRootFor(ctx);
				const outcome = await controller.services.compareRuns(projectRoot, params.a, params.b);
				if (!outcome.ok) {
					if (outcome.error === COMPARISON_PERSIST_ERROR) {
						throw new Error(`workbench_compare_runs: ${COMPARISON_PERSIST_ERROR}`);
					}
					const details: CompareToolDetails = { ok: false, error: outcome.error };
					return { content: [{ type: "text", text: `workbench_compare_runs: ${outcome.error}` }], details };
				}
				const quant = outcome.report.quant;
				const quantChangedCount = quant === null
					? 0
					: [quant.benchmark_delta, quant.return, quant.drawdown, quant.turnover]
						.filter((delta) => delta.changed).length + quant.costs.length + quant.parameters.length;
				const details: CompareToolDetails = {
					ok: true,
					comparison_id: outcome.comparison_id,
					a_run_id: outcome.report.a.run_id,
					b_run_id: outcome.report.b.run_id,
					compatible: outcome.report.compatible,
					artifact_added_count: outcome.report.generic.artifacts.added.length,
					artifact_removed_count: outcome.report.generic.artifacts.removed.length,
					gate_changed_count: outcome.report.generic.gate_delta?.changed.length ?? 0,
					quant_changed_count: quantChangedCount,
					parameter_changed_count: quant?.parameters.length ?? 0,
					comparison_path: outcome.comparison_path,
				};
				const toolResult = {
					content: [{ type: "text" as const, text: renderCompareLines(outcome.report, true).join("\n") }],
					details,
				};
				const authority = await controller.services.buildTrustedRecoveryAuthority({
					projectRoot,
					sourceKind: "immutable_comparison",
					toolCallId,
					toolName: "workbench_compare_runs",
					sourcePath: outcome.comparison_path,
					requiredFacts: [
						{ key: "comparison_id", value: outcome.comparison_id },
						{ key: "a_run_id", value: outcome.report.a.run_id },
						{ key: "b_run_id", value: outcome.report.b.run_id },
						{ key: "compatible", value: outcome.report.compatible },
					],
				});
				trustedIngress = controller.bindTrustedIngressAuthority(authority, toolResult.content);
				return toolResult;
			} finally {
				controller.rememberTrustedIngressAuthority(toolCallId, "workbench_compare_runs", trustedIngress);
			}
		},
		...workbenchToolRenderer("compare", "workbench_compare_runs"),
	});
}
