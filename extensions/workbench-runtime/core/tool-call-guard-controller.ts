/** Ordered second-layer tool-call authorization and receipt guard. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { checkToolCall, type WorkbenchMode } from "./mode-policy.ts";
import { blockedControlText } from "./turn-output-budget.ts";
import type { TurnOutputAuthorization, TurnOutputBudgetState } from "./turn-output-budget.ts";
import { workbenchToolRequiresReceipt } from "./tool-catalog.ts";
import {
	beginBlockReason,
	beginReceipt,
	capacityBlockReason,
	MAX_IN_FLIGHT_RECEIPTS,
} from "./tool-result-recovery.ts";
import type { PendingReceiptHandle } from "./tool-result-middleware-controller.ts";
import { boundedGuardReason } from "./runtime-output-controller.ts";
import { isWorkerPathAllowedRealpath } from "../worker/path-scope.ts";
import {
	workerRoleToolCallBlockReason,
	type WorkerRoleContext,
} from "./worker-policy.ts";
import type { WorkerWriteJournalRuntime } from "./worker-write-journal-runtime.ts";
import {
	commanderToolCallBlockReason,
	consumeLeaseCall,
	detectActorRole,
	leaseStatus,
	type WriteLease,
} from "./write-authority.ts";

export interface ToolCallGuardController {
	pi: Pick<ExtensionAPI, "on">;
	toolCallBlockReason(toolName: unknown): string | undefined;
	getWorkerRoleContext(): WorkerRoleContext;
	getIdentity(): { provider?: string; model?: string };
	getMode(): WorkbenchMode;
	getLease(): WriteLease | undefined;
	setLease(lease: WriteLease): void;
	syncLease(now: string): void;
	recordBlockedWriteAttempt(now: string): void;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	authorizeOutput(toolCallId: unknown, toolName: unknown, input: unknown): TurnOutputAuthorization;
	rememberOutputAuthorization(authorization: TurnOutputAuthorization): void;
	workerWriteJournalRuntime: WorkerWriteJournalRuntime;
	turnOutputBudget: TurnOutputBudgetState;
	pendingReceiptHandles: Map<string, PendingReceiptHandle>;
	persistLease(): void;
	applyModeTools(): void;
	recordModifiedFile(path: string): void;
}

/** Register the single ordered tool_call guard. */
export function registerToolCallGuard(controller: ToolCallGuardController): void {
	controller.pi.on("tool_call", async (event, ctx) => {
		const streamingBoundaryReason = controller.toolCallBlockReason(event.toolName);
		if (streamingBoundaryReason) return { block: true, reason: streamingBoundaryReason };
		const workerRoleContext = controller.getWorkerRoleContext();
		const workerRoleReason = workerRoleToolCallBlockReason(workerRoleContext, event.toolName, event.input);
		if (workerRoleReason) return { block: true, reason: boundedGuardReason(workerRoleReason) };
		if (
			workerRoleContext.role === "worker"
			&& (event.toolName === "edit" || event.toolName === "write")
			&& workerRoleContext.projectRoot
			&& event.input
			&& typeof event.input === "object"
			&& typeof (event.input as { path?: unknown }).path === "string"
		) {
			const path = (event.input as { path: string }).path;
			if (!(await isWorkerPathAllowedRealpath(workerRoleContext.projectRoot, path, workerRoleContext.allowedPaths ?? []))) {
				return { block: true, reason: boundedGuardReason("Delegated worker path failed realpath/symlink scope validation") };
			}
		}

		const identity = controller.getIdentity();
		const actor = detectActorRole({ roleEnv: workerRoleContext.role, provider: identity.provider, model: identity.model });
		const now = new Date().toISOString();
		controller.syncLease(now);
		const mode = controller.getMode();
		const check = checkToolCall(mode, event.toolName, event.input);
		if (!check.allowed) return { block: true, reason: boundedGuardReason(check.reason ?? `Blocked by workbench ${mode} mode`) };
		if (actor === "sol-commander") {
			const commanderReason = commanderToolCallBlockReason({
				actor,
				toolName: event.toolName,
				input: event.input,
				lease: controller.getLease(),
				now,
			});
			if (commanderReason) {
				if (event.toolName === "edit" || event.toolName === "write") controller.recordBlockedWriteAttempt(now);
				return { block: true, reason: boundedGuardReason(commanderReason) };
			}
			if (
				(event.toolName === "edit" || event.toolName === "write")
				&& event.input
				&& typeof event.input === "object"
				&& typeof (event.input as { path?: unknown }).path === "string"
			) {
				const path = (event.input as { path: string }).path;
				try {
					const projectRoot = await controller.projectRootFor(ctx);
					if (!(await isWorkerPathAllowedRealpath(projectRoot, path, [path]))) {
						return { block: true, reason: boundedGuardReason("Commander leased write failed project realpath/symlink containment") };
					}
				} catch {
					return { block: true, reason: boundedGuardReason("Commander leased write could not verify project containment") };
				}
			}
		}

		const authorization = controller.authorizeOutput(event.toolCallId, event.toolName, event.input);
		controller.rememberOutputAuthorization(authorization);
		if (!authorization.allowed) {
			return {
				block: true,
				reason: boundedGuardReason(authorization.controlText ?? blockedControlText(authorization.blockCode ?? "turn_output_budget")),
			};
		}
		if (
			workerRoleContext.role === "worker"
			&& workerRoleContext.taskKind === "implementation"
			&& (event.toolName === "edit" || event.toolName === "write")
		) {
			const path = event.input && typeof event.input === "object" ? (event.input as { path?: unknown }).path : undefined;
			const begun = await controller.workerWriteJournalRuntime.beginToolCall({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				path,
			});
			if (!begun.ok) {
				if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
				return { block: true, reason: boundedGuardReason(begun.reason) };
			}
		}

		if (workbenchToolRequiresReceipt(event.toolName)) {
			if (controller.pendingReceiptHandles.size >= MAX_IN_FLIGHT_RECEIPTS) {
				if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
				return { block: true, reason: boundedGuardReason(capacityBlockReason()) };
			}
			try {
				const projectRoot = await controller.projectRootFor(ctx);
				const begun = await beginReceipt({
					projectRoot,
					sessionIdentity: ctx.sessionManager.getSessionId(),
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					rawInput: event.input,
				});
				if (!begun.ok) {
					if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
					return { block: true, reason: boundedGuardReason(beginBlockReason(begun)) };
				}
				controller.pendingReceiptHandles.set(event.toolCallId, { handle: begun.handle, projectRoot });
			} catch {
				if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
				return { block: true, reason: boundedGuardReason("Tool result receipt storage unavailable") };
			}
		}

		if (actor === "sol-commander" && (event.toolName === "edit" || event.toolName === "write")) {
			const path = event.input && typeof event.input === "object" && typeof (event.input as { path?: unknown }).path === "string"
				? (event.input as { path: string }).path
				: "";
			const lease = controller.getLease();
			if (lease && leaseStatus(lease, now) === "active") {
				const consumed = consumeLeaseCall(lease, event.toolName, path, now);
				if (consumed.ok) {
					controller.setLease(consumed.lease);
					controller.persistLease();
					if (leaseStatus(consumed.lease, now) !== "active") controller.applyModeTools();
				}
			}
		}
		if ((event.toolName === "edit" || event.toolName === "write") && event.input && typeof event.input === "object") {
			const path = (event.input as { path?: unknown }).path;
			if (typeof path === "string" && path.length > 0) controller.recordModifiedFile(path);
		}
		return undefined;
	});
}
