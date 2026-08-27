/** Direct `/q-review` execution of the shared durable semantic-review service. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { boundedInlineDetail } from "./command-output.ts";
import {
	runAutomaticSemanticReview,
	type AutomaticSemanticReviewResult,
} from "./automatic-semantic-review-service.ts";
import { markSemanticAccepted, observeDiffChange, type DelegationState } from "./delegation-state.ts";
import { DELEGATION_TRANSACTION_ID_RE } from "./delegation-transaction.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { commanderBlockReason } from "./worker-policy.ts";
import type { ExecFn } from "./config.ts";
import { runProjectCheckoutOperationV1 } from "./project-checkout-operation.ts";

export const AUTOMATIC_SEMANTIC_REVIEW_COMMAND_NAME = "q-review" as const;

export interface AutomaticSemanticReviewCommandController {
	pi: Pick<ExtensionAPI, "registerCommand">;
	review?: typeof runAutomaticSemanticReview;
	runCheckoutOperation?: typeof runProjectCheckoutOperationV1;
	exec: ExecFn;
	secrets: readonly string[];
	getMode(): WorkbenchMode;
	runtimeCurrentOrError(ctx: ExtensionCommandContext): string | undefined;
	trustedOrError(ctx: ExtensionCommandContext): string | undefined;
	projectRootFor(ctx: ExtensionCommandContext): Promise<string>;
	reconcileProjectAuthority(projectRoot: string, now: string): Promise<boolean>;
	getDelegationState(): DelegationState;
	persistDelegationStateStrict(state: DelegationState): void;
	output(ctx: ExtensionCommandContext, lines: string[]): void;
}

export function automaticSemanticReviewCommandDelegationId(args: string): string | undefined {
	const value = args.trim();
	return DELEGATION_TRANSACTION_ID_RE.test(value) ? value : undefined;
}

function usageLine(result: AutomaticSemanticReviewResult): string {
	const usage = result.nested_usage;
	return `nested_usage: input=${usage.input}; output=${usage.output}; cache_read=${usage.cacheRead}; cache_write=${usage.cacheWrite}; total=${usage.totalTokens}; cost=${usage.cost.total}`;
}

/** Register a direct command; it never sends a user message or creates a model turn. */
export function registerAutomaticSemanticReviewCommand(controller: AutomaticSemanticReviewCommandController): void {
	controller.pi.registerCommand("q-review", {
		description: "Complete and run one exact durable Sol semantic review: /q-review DELEGATION_ID",
		handler: async (args, ctx) => {
			const delegationId = automaticSemanticReviewCommandDelegationId(args);
			if (delegationId === undefined) {
				controller.output(ctx, ["/q-review: invalid delegation id", "usage: /q-review DELEGATION_ID"]);
				return;
			}
			await ctx.waitForIdle();
			let runtimeError: string | undefined;
			try { runtimeError = controller.runtimeCurrentOrError(ctx); } catch (error) {
				runtimeError = `runtime freshness check failed — ${boundedInlineDetail((error as Error).message, 768)}`;
			}
			if (runtimeError !== undefined) {
				controller.output(ctx, [`/q-review: ${boundedInlineDetail(runtimeError, 1_024)}`]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError !== undefined) {
				controller.output(ctx, [`/q-review: ${trustError}`]);
				return;
			}
			if (controller.getMode() !== "DEV") {
				controller.output(ctx, [`/q-review: refused — automatic semantic review requires DEV mode (current mode: ${controller.getMode()})`]);
				return;
			}
			const commanderError = commanderBlockReason(ctx.model?.provider, ctx.model?.id);
			if (commanderError !== undefined) {
				controller.output(ctx, [`/q-review: ${boundedInlineDetail(commanderError, 512)}`]);
				return;
			}

			try {
				const projectRoot = await controller.projectRootFor(ctx);
				if (!await controller.reconcileProjectAuthority(projectRoot, new Date().toISOString())) {
					controller.output(ctx, ["/q-review: checkout authority recovery is unavailable"]);
					return;
				}
				const run = controller.review ?? runAutomaticSemanticReview;
				const operation = await (controller.runCheckoutOperation ?? runProjectCheckoutOperationV1)({
					project_root: projectRoot,
					operation_kind: "command",
					operation_id: `command:q-review:${delegationId}`,
					now: new Date().toISOString(),
				}, async () => run({
					project_root: projectRoot,
					delegation_id: delegationId,
					exec: controller.exec,
					model_registry: ctx.modelRegistry,
					secrets: controller.secrets,
					signal: ctx.signal,
				}));
				if (!operation.ok) {
					controller.output(ctx, [`/q-review: checkout writer lane ${operation.error.code}`]);
					return;
				}
				const result = operation.value;
				let mirrorWarning: string | undefined;
				if (result.status === "ACCEPT") {
					const projected = observeDiffChange(controller.getDelegationState(), result.bound_diff_hash, new Date().toISOString());
					const accepted = markSemanticAccepted(projected, {
						delegationId,
						expectedDiffHash: result.bound_diff_hash,
						now: new Date().toISOString(),
					});
					if (!accepted.ok) {
						mirrorWarning = `session mirror projection unavailable (${boundedInlineDetail(accepted.error, 512)})`;
					} else {
						try { controller.persistDelegationStateStrict(accepted.state); } catch {
							mirrorWarning = "session mirror append failed; durable semantic ACCEPT remains authoritative";
						}
					}
				}
				const lines = [
					`/q-review: ${result.status}${"code" in result ? ` (${result.code})` : result.replayed ? " — durable replay" : " — durable decision published"}`,
					`delegation_id: ${delegationId}`,
					...("bound_diff_hash" in result && result.bound_diff_hash !== undefined ? [`bound_diff_hash: ${result.bound_diff_hash}`] : []),
					...(result.receipt_hash === undefined ? [] : [`receipt_hash: ${result.receipt_hash}`]),
					usageLine(result),
					`mechanical_page_calls: ${result.mechanical_page_calls}`,
					...(result.next_action === undefined ? [] : [`next_action: ${result.next_action}`]),
					...(result.status === "RETRYABLE_FAILURE" && result.code === "REVIEW_TOO_LARGE"
						? ["manual_route: review exceeds the 32-page automatic ceiling; use bounded manual paging or split the change"] : []),
					...(result.status === "RETRYABLE_FAILURE" && result.code === "LEGACY_ENVELOPE_REQUIRES_MIGRATION"
						? ["manual_route: legacy page-count authority requires bounded manual paging/migration; repeating automatic review will not advance it"] : []),
					...(result.status === "RETRYABLE_FAILURE" && result.code === "LINEAGE_PRESENTATION_GAP"
						? ["manual_route: carried rejected paths are not distinguishable in W/C authority; complete a bounded manual semantic review"] : []),
					...(result.status === "RETRYABLE_FAILURE" && result.code === "MECHANICAL_SCOPE_INTEGRITY_FAILED"
						? ["manual_route: inspect only the durable bounded scope/integrity violations, then repair the scope breach; automatic ACCEPT is forbidden"] : []),
					...(mirrorWarning === undefined ? [] : [`warning: ${mirrorWarning}`]),
					...(operation.release === "recovery_required"
						? ["warning: semantic review completed but checkout lock cleanup requires recovery"]
						: []),
				];
				controller.output(ctx, lines);
			} catch (error) {
				controller.output(ctx, [`/q-review: execution failed — ${boundedInlineDetail((error as Error).message, 1_024)}`]);
			}
		},
	});
}
