/** Model-callable exact-repair router backed only by strict durable authority. */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { EXACT_REPAIR_TOOL_NAME_V1 } from "./agent-next-action.ts";
import { boundedCommandText, boundedInlineDetail } from "./command-output.ts";
import type {
	DelegateToolExecutionHandleV1,
	DelegateWorkerExecuteV1,
} from "./delegate-tool-controller.ts";
import {
	exactRepairResultRequiresReconcileV1,
	exactRepairServiceLinesV1,
} from "./exact-repair-command.ts";
import {
	exactRepairSuccessorNextActionV1,
	runExactRepairServiceV1,
	type ExactRepairServiceDependenciesV1,
	type ExactRepairServiceResultV1,
} from "./exact-repair-service.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";
import { commanderBlockReason } from "./worker-policy.ts";
import type { ExecFn } from "./config.ts";
import { collectCheckpointResumeExecutionAuthorityV1 } from "./delegation-resume-authority.ts";

type RepairToolExecuteV1 = ToolDefinition<
	typeof WORKBENCH_TOOL_PARAMETERS.workbench_repair_delegation
>["execute"];

export interface ExactRepairToolControllerV1 {
	readonly pi: Pick<ExtensionAPI, "registerTool">;
	readonly execution: DelegateToolExecutionHandleV1;
	readonly serviceDependencies: Omit<ExactRepairServiceDependenciesV1, "executeExactRepair">;
	readonly trustedOrError: (ctx: ExtensionContext) => string | undefined;
	readonly projectRootFor: (ctx: ExtensionContext) => Promise<string>;
	readonly getMode: () => WorkbenchMode;
	readonly runtimeCurrentOrError: (ctx: ExtensionContext) => string | undefined;
	readonly reconcileProjectAuthority: (projectRoot: string, now: string) => Promise<unknown>;
	readonly exec?: ExecFn;
	/** Optional deterministic seam; production uses strict durable checkpoint collection. */
	readonly collectCheckpointResumeAuthority?: typeof collectCheckpointResumeExecutionAuthorityV1;
}

export interface ExactRepairToolExecutionHandleV1 {
	readonly execute: RepairToolExecuteV1;
	readonly executeDelegateAlias: DelegateWorkerExecuteV1;
}

function resultDetails(
	result: ExactRepairServiceResultV1,
	compatibilityAlias: boolean,
): Record<string, unknown> {
	const successor = "successor" in result ? result.successor : undefined;
	const authority = "authority" in result ? result.authority : undefined;
	const lifecycle = "lifecycle_resolution" in result ? result.lifecycle_resolution : undefined;
	const nextAction = successor === undefined
		? ("next_action" in result ? result.next_action : null)
		: exactRepairSuccessorNextActionV1(successor);
	const durableSuccessor = successor !== undefined;
	return {
		ok: durableSuccessor,
		status: result.status,
		repair_of: result.repair_of,
		execution_attempted: "execution_attempted" in result ? result.execution_attempted : false,
		...("replayed" in result ? { replayed: result.replayed } : {}),
		...(authority === undefined ? {} : {
			authority_kind: authority.authority_kind,
			idempotency_key: authority.idempotency_key,
		}),
		...(lifecycle === undefined ? {} : {
			lifecycle_action: lifecycle.primary_action.action,
			lifecycle_reason: lifecycle.primary_action.reason,
			lifecycle_snapshot_hash: lifecycle.primary_action.snapshot_hash,
		}),
		...(successor === undefined ? {} : {
			delegation_id: successor.delegation_id,
			successor_status: successor.status,
			successor_disposition: successor.disposition,
			successor_transaction_hash: successor.transaction_hash,
		}),
		...(nextAction === null ? {} : { next_action: nextAction }),
		...(compatibilityAlias ? {
			compatibility_alias: "workbench_delegate_worker.repair_of",
			caller_contract_ignored: true,
		} : {}),
	};
}

/** Register the model-callable tool and expose the safe legacy delegate alias. */
export function registerExactRepairToolV1(
	controller: ExactRepairToolControllerV1,
): ExactRepairToolExecutionHandleV1 {
	const executeRepair = async (
		toolCallId: string,
		repairOf: string,
		signal: Parameters<RepairToolExecuteV1>[2],
		onUpdate: Parameters<RepairToolExecuteV1>[3],
		ctx: Parameters<RepairToolExecuteV1>[4],
		entrypoint: string,
		compatibilityAlias: boolean,
	): ReturnType<RepairToolExecuteV1> => {
		const trustError = controller.trustedOrError(ctx);
		if (trustError !== undefined) throw new Error(`${entrypoint}: ${trustError}`);
		const runtimeError = controller.runtimeCurrentOrError(ctx);
		if (runtimeError !== undefined) throw new Error(`${entrypoint}: ${runtimeError}`);
		if (controller.getMode() !== "DEV") {
			throw new Error(`${entrypoint}: exact repair execution requires DEV mode (current mode: ${controller.getMode()})`);
		}
		const commanderError = commanderBlockReason(ctx.model?.provider, ctx.model?.id);
		if (commanderError !== undefined) throw new Error(`${entrypoint}: ${commanderError}`);

		try {
			const projectRoot = await controller.projectRootFor(ctx);
			const collectCheckpoint = controller.collectCheckpointResumeAuthority
				?? collectCheckpointResumeExecutionAuthorityV1;
			const checkpoint = controller.exec === undefined ? { ok: false as const, code: "CHECKPOINT_NOT_RETRYABLE" } : await collectCheckpoint({
				project_root: projectRoot,
				delegation_id: repairOf,
				exec: controller.exec,
				session_entries: ctx.sessionManager.getEntries(),
			});
			if (checkpoint.ok) {
				if (controller.execution.executeCheckpointRecovery === undefined) {
					throw new Error("checkpoint recovery execution is unavailable");
				}
				return controller.execution.executeCheckpointRecovery(
					toolCallId,
					checkpoint.value,
					signal,
					onUpdate,
					ctx,
				);
			}
			if (checkpoint.code !== "CHECKPOINT_NOT_RETRYABLE" && checkpoint.code !== "CHECKPOINT_SUCCESSOR_REQUIRED") {
				throw new Error(`checkpoint recovery ${checkpoint.code}`);
			}
			const input = {
				project_root: projectRoot,
				repair_of: repairOf,
				signal,
				on_update: onUpdate,
				execution_context: ctx,
			};
			const dependencies: ExactRepairServiceDependenciesV1 = {
				...controller.serviceDependencies,
				executeExactRepair: controller.execution.executeExactRepair,
			};
			let result = await runExactRepairServiceV1(input, dependencies);
			if (exactRepairResultRequiresReconcileV1(result)) {
				await controller.reconcileProjectAuthority(projectRoot, new Date().toISOString());
				result = await runExactRepairServiceV1(input, dependencies);
			}
			const lines = exactRepairServiceLinesV1(result, entrypoint);
			const executionResult = "execution_result" in result ? result.execution_result : undefined;
			return {
				content: [{ type: "text" as const, text: boundedCommandText(lines.join("\n")) }],
				details: resultDetails(result, compatibilityAlias),
				...(executionResult?.usage === undefined ? {} : { usage: executionResult.usage }),
			};
		} catch (error) {
			const message = boundedInlineDetail(error instanceof Error ? error.message : String(error), 1_024);
			return {
				content: [{ type: "text" as const, text: boundedCommandText(`${entrypoint}: authority recovery failed — ${message}`) }],
				details: {
					ok: false,
					status: "UNEXPECTED_ERROR",
					repair_of: repairOf,
					...(compatibilityAlias ? {
						compatibility_alias: "workbench_delegate_worker.repair_of",
						caller_contract_ignored: true,
					} : {}),
				},
			};
		}
	};

	const execute: RepairToolExecuteV1 = (toolCallId, params, signal, onUpdate, ctx) =>
		executeRepair(toolCallId, params.delegation_id, signal, onUpdate, ctx, EXACT_REPAIR_TOOL_NAME_V1, false);
	const executeDelegateAlias: DelegateWorkerExecuteV1 = (toolCallId, params, signal, onUpdate, ctx) => {
		if (params.repair_of === undefined) {
			throw new Error("workbench_delegate_worker: exact repair compatibility route requires repair_of");
		}
		return executeRepair(
			toolCallId,
			params.repair_of,
			signal,
			onUpdate,
			ctx,
			"workbench_delegate_worker(repair_of compatibility)",
			true,
		);
	};

	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_repair_delegation,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_repair_delegation,
		executionMode: "sequential",
		execute,
	});
	return Object.freeze({ execute, executeDelegateAlias });
}
