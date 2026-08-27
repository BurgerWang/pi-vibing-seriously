/** Deterministic user-only execution of one strict semantic or terminal repair. */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { boundedCommandText, boundedInlineDetail } from "./command-output.ts";
import type { DelegateToolExecutionHandleV1 } from "./delegate-tool-controller.ts";
import type {
	ExactRepairExistingSuccessorV1,
	readExactRepairSuccessorV1,
} from "./exact-repair-successor.ts";
import {
	exactRepairSuccessorNextActionV1,
	runExactRepairServiceV1,
	type ExactRepairExecutionResultV1,
	type ExactRepairServiceResultV1,
} from "./exact-repair-service.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import type {
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTerminalNegativeSolAuthorityV1,
} from "./delegation-transaction-storage.ts";
import { DELEGATION_TRANSACTION_ID_RE } from "./delegation-transaction.ts";
import { commanderBlockReason } from "./worker-policy.ts";

export const EXACT_REPAIR_COMMAND_NAME_V1 = "q-repair" as const;

export interface ExactRepairCommandControllerV1 {
	pi: Pick<ExtensionAPI, "registerCommand">;
	execution: DelegateToolExecutionHandleV1;
	readCommittedGeneration: typeof readDelegationCommittedGenerationV2;
	readReview: typeof readDelegationReviewV2;
	readTerminalNegativeRepair: typeof readDelegationTerminalNegativeSolAuthorityV1;
	readSuccessor: typeof readExactRepairSuccessorV1;
	collectCurrentBinding(projectRoot: string, delegationId: string): Promise<
		| { readonly status: "unavailable" }
		| { readonly status: "fresh" | "conflict"; readonly hash: string }
	>;
	getMode(): WorkbenchMode;
	runtimeCurrentOrError(ctx: ExtensionCommandContext): string | undefined;
	trustedOrError(ctx: ExtensionCommandContext): string | undefined;
	projectRootFor(ctx: ExtensionCommandContext): Promise<string>;
	reconcileProjectAuthority(projectRoot: string, now: string): Promise<boolean>;
	output(ctx: ExtensionCommandContext, lines: string[]): void;
}

export function exactRepairCommandDelegationIdV1(args: string): string | undefined {
	const trimmed = args.trim();
	return DELEGATION_TRANSACTION_ID_RE.test(trimmed) ? trimmed : undefined;
}

function resultText(result: ExactRepairExecutionResultV1): string {
	return result.content
		.filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function recoveredLines(result: Extract<ExactRepairServiceResultV1, { authority: unknown }>): string[] {
	return [
		`repair_of: ${result.repair_of}`,
		`authority_kind: ${result.authority.authority_kind}`,
		`idempotency_key: ${result.authority.idempotency_key}`,
		`tool_call_id: ${result.authority.tool_call_id}`,
	];
}

function renderedExecution(result: ExactRepairExecutionResultV1): string[] {
	const rendered = boundedCommandText(resultText(result));
	return rendered.length === 0 ? [] : rendered.split("\n");
}

function successorNextActionLines(successor: ExactRepairExistingSuccessorV1): string[] {
	const next = exactRepairSuccessorNextActionV1(successor);
	return next === null ? [] : [`next_action: ${next}`];
}

export function exactRepairResultRequiresReconcileV1(result: ExactRepairServiceResultV1): boolean {
	return result.status === "SUCCESSOR_ACTIVE" ||
		(result.status === "RAW_SUCCESSOR_REPLAY" && result.successor.disposition === "ACTIVE");
}

/** Shared bounded rendering for the user command and model-callable tool. */
export function exactRepairServiceLinesV1(
	result: ExactRepairServiceResultV1,
	entrypoint = "/q-repair",
): string[] {
	switch (result.status) {
		case "AUTHORITY_UNAVAILABLE": {
			const label = result.source === "committed"
				? "committed authority"
				: result.source === "semantic-repair"
					? "semantic repair authority"
					: result.source === "terminal-negative-repair"
						? "terminal-negative Sol repair authority"
						: "raw-lineage repair authority";
			return [`${entrypoint}: ${label} unavailable (${result.code})`, `repair_of: ${result.repair_of}`];
		}
		case "RECOVERY_REFUSED":
			return [
				`${entrypoint}: deterministic parameter recovery refused (${result.code})`,
				`repair_of: ${result.repair_of}`,
				"no delegation transaction was started",
			];
		case "IDEMPOTENCY_REFUSED":
			return [
				`${entrypoint}: durable idempotency refused (${result.code})`,
				`repair_of: ${result.repair_of}`,
				`idempotency_key: ${result.authority.idempotency_key}`,
				...(result.conflicting_delegation === undefined ? [] : [`conflicting_delegation: ${result.conflicting_delegation}`]),
				"no delegation transaction was started",
			];
		case "CURRENT_BINDING_CHANGED":
			return [
				`${entrypoint}: deterministic parameter recovery refused (CURRENT_BINDING_CHANGED)`,
				`repair_of: ${result.repair_of}`,
				"no delegation transaction was started",
			];
		case "SUCCESSOR_RECORDED":
			if (result.replayed) {
				return [
					`${entrypoint}: durable replay — returning the existing exact successor`,
					`repair_of: ${result.repair_of}`,
					`authority_kind: ${result.authority.authority_kind}`,
					`idempotency_key: ${result.authority.idempotency_key}`,
					...successorLines(result.successor),
					...successorNextActionLines(result.successor),
					"worker_started_by_replay: false",
				];
			}
			if (result.execution_outcome === "threw") {
				return [
					`${entrypoint}: shared delegate execution failed after recording one durable successor — ${boundedInlineDetail(result.execution_error ?? "unknown failure", 1_024)}`,
					...recoveredLines(result),
					...successorLines(result.successor),
					...successorNextActionLines(result.successor),
				];
			}
			return [
				`${entrypoint}: shared delegate execution ${result.execution_status ?? "completed"}`,
				...recoveredLines(result),
				...successorLines(result.successor),
				...successorNextActionLines(result.successor),
				...(result.execution_result === undefined ? [] : renderedExecution(result.execution_result)),
			];
		case "SUCCESSOR_ACTIVE":
			return [
				`${entrypoint}: exact successor already active; no second worker was started`,
				...recoveredLines(result),
				...successorLines(result.successor),
				...successorNextActionLines(result.successor),
			];
		case "EXACT_REPAIR_PENDING":
			return [
				`${entrypoint}: prior successor ended before writes and has strict deterministic continuation authority`,
				...recoveredLines(result),
				...successorLines(result.successor),
				...successorNextActionLines(result.successor),
			];
		case "SUCCESSOR_BLOCKED":
			return [
				`${entrypoint}: existing successor is not safely replayable or continuable`,
				...recoveredLines(result),
				...successorLines(result.successor),
				...successorNextActionLines(result.successor),
				"no delegation transaction was started",
			];
		case "RAW_SUCCESSOR_REPLAY":
			return [
				`${entrypoint}: immutable raw-lineage replay — returning the existing exact successor`,
				`repair_of: ${result.repair_of}`,
				`immutable_authority_hash: ${result.immutable_authority_hash}`,
				...successorLines(result.successor),
				...(result.next_action === null ? [] : [`next_action: ${result.next_action}`]),
				"worker_started_by_replay: false",
			];
		case "EXECUTION_REFUSED":
			return [
				`${entrypoint}: shared delegate execution refused`,
				...recoveredLines(result),
				...renderedExecution(result.execution_result),
			];
		case "EXECUTION_READBACK_FAILED":
			return [
				`${entrypoint}: shared delegate execution returned but durable idempotency is ${result.code === "SUCCESSOR_MISSING" ? "missing" : result.code}`,
				`repair_of: ${result.repair_of}`,
				`idempotency_key: ${result.authority.idempotency_key}`,
				"result is not reported as a completed repair without a strict successor transaction",
			];
		case "EXECUTION_FAILED":
			return [
				`${entrypoint}: shared delegate execution failed — ${boundedInlineDetail(result.error, 1_024)}`,
				...recoveredLines(result),
				result.successor_readback.status === "none"
					? "durable_idempotency: no successor transaction was recorded"
					: `durable_idempotency: ${result.successor_readback.code}`,
			];
		case "UNEXPECTED_ERROR":
			return [`${entrypoint}: authority recovery failed — ${boundedInlineDetail(result.error, 1_024)}`];
	}
}

function successorLines(successor: ExactRepairExistingSuccessorV1): string[] {
	return [
		`successor: ${successor.delegation_id}`,
		`successor_status: ${successor.status}`,
		`successor_transaction_hash: ${successor.transaction_hash}`,
		`successor_disposition: ${successor.disposition}`,
		...(successor.committed_proof_content_hash === null
			? []
			: [`successor_committed_proof: ${successor.committed_proof_content_hash}`]),
	];
}

/** Register `/q-repair DELEGATION_ID` without creating an agent/model turn. */
export function registerExactRepairCommandV1(controller: ExactRepairCommandControllerV1): void {
	controller.pi.registerCommand(EXACT_REPAIR_COMMAND_NAME_V1, {
		description: "Execute one exact semantic or lineaged terminal repair directly from strict durable authority: /q-repair DELEGATION_ID",
		handler: async (args, ctx) => {
			const repairOf = exactRepairCommandDelegationIdV1(args);
			if (repairOf === undefined) {
				controller.output(ctx, ["/q-repair: invalid delegation id", "usage: /q-repair DELEGATION_ID"]);
				return;
			}
			await ctx.waitForIdle();
			let runtimeError: string | undefined;
			try {
				runtimeError = controller.runtimeCurrentOrError(ctx);
			} catch (error) {
				runtimeError = `runtime freshness check failed — ${boundedInlineDetail((error as Error).message, 768)}`;
			}
			if (runtimeError !== undefined) {
				controller.output(ctx, [`/q-repair: ${boundedInlineDetail(runtimeError, 1_024)}`]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError !== undefined) {
				controller.output(ctx, [`/q-repair: ${trustError}`]);
				return;
			}
			if (controller.getMode() !== "DEV") {
				controller.output(ctx, [`/q-repair: refused — exact repair execution requires DEV mode (current mode: ${controller.getMode()})`]);
				return;
			}
			const commanderError = commanderBlockReason(ctx.model?.provider, ctx.model?.id);
			if (commanderError !== undefined) {
				controller.output(ctx, [`/q-repair: ${boundedInlineDetail(commanderError, 512)}`]);
				return;
			}

			try {
				const projectRoot = await controller.projectRootFor(ctx);
				const serviceInput = {
					project_root: projectRoot,
					repair_of: repairOf,
					signal: ctx.signal,
					on_update: undefined,
					execution_context: ctx,
				};
				const serviceDependencies = {
					executeExactRepair: controller.execution.executeExactRepair,
					collectCurrentBinding: controller.collectCurrentBinding,
					readCommittedGeneration: controller.readCommittedGeneration,
					readReview: controller.readReview,
					readTerminalNegativeRepair: controller.readTerminalNegativeRepair,
					readSuccessor: controller.readSuccessor,
				};
				// The first service read preserves immutable replay-first semantics.
				// Only an active durable successor can require same-process
				// transaction-aware CAS cleanup before one bounded re-read.
				let result = await runExactRepairServiceV1(serviceInput, serviceDependencies);
				if (exactRepairResultRequiresReconcileV1(result)) {
					await controller.reconcileProjectAuthority(projectRoot, new Date().toISOString());
					result = await runExactRepairServiceV1(serviceInput, serviceDependencies);
				}
				controller.output(ctx, exactRepairServiceLinesV1(result));
			} catch (error) {
				controller.output(ctx, [`/q-repair: authority recovery failed — ${boundedInlineDetail((error as Error).message, 1_024)}`]);
			}
		},
	});
}
