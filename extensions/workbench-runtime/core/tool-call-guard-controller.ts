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
import {
	acquireProjectCheckoutOperationV1,
	releaseProjectCheckoutOperationV1,
	WORKBENCH_CHECKOUT_OPERATION_TOKEN_ENV,
	type ProjectCheckoutOperationLeaseV1,
} from "./project-checkout-operation.ts";
import { boundedGuardReason } from "./runtime-output-controller.ts";
import {
	workbenchToolRequiresCheckoutLaneV1,
	workbenchToolRoutesExactRepairV1,
} from "./checkout-tool-classification.ts";
import { isWorkerPathAllowedRealpath } from "../worker/path-scope.ts";
import {
	workerRoleToolCallBlockReason,
	WORKER_DELEGATION_ID_ENV,
	type WorkerRoleContext,
} from "./worker-policy.ts";
import type { WorkerWriteJournalRuntime } from "./worker-write-journal-runtime.ts";
import {
	commanderToolCallBlockReason,
	consumeLeaseCall,
	detectActorRole,
	leaseStatus,
	revokeLease,
	type WriteLease,
} from "./write-authority.ts";

export interface ToolCallGuardController {
	pi: Pick<ExtensionAPI, "on">;
	toolCallBlockReason(toolName: unknown): string | undefined;
	runtimeMutationBlockReason(toolName: unknown): string | undefined;
	getWorkerRoleContext(): WorkerRoleContext;
	getIdentity(): { provider?: string; model?: string };
	getMode(): WorkbenchMode;
	getLease(): WriteLease | undefined;
	setLease(lease: WriteLease): void;
	syncLease(now: string): void;
	recordBlockedWriteAttempt(now: string): void;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	makeDelegationId(date: Date): string;
	reconcileProjectAuthority(projectRoot: string, now: string): Promise<unknown>;
	authorizeOutput(toolCallId: unknown, toolName: unknown, input: unknown): TurnOutputAuthorization;
	rememberOutputAuthorization(authorization: TurnOutputAuthorization): void;
	workerWriteJournalRuntime: WorkerWriteJournalRuntime;
	turnOutputBudget: TurnOutputBudgetState;
	pendingReceiptHandles: Map<string, PendingReceiptHandle>;
	pendingCheckoutOperationHandles: Map<string, ProjectCheckoutOperationLeaseV1>;
	acquireCheckoutOperation?: typeof acquireProjectCheckoutOperationV1;
	releaseCheckoutOperation?: typeof releaseProjectCheckoutOperationV1;
	beginToolReceipt?: typeof beginReceipt;
	persistLease(): boolean | void;
	applyModeTools(): void;
	recordModifiedFile(path: string): void;
}

function bashMayOutliveToolResult(input: unknown): boolean {
	if (!input || typeof input !== "object") return true;
	const command = (input as { command?: unknown }).command;
	if (typeof command !== "string") return true;
	return /(^|[;\s])(?:nohup|setsid|disown|daemonize|systemd-run|tmux|screen)(?=\s|$)/u.test(command)
		|| /(?<![&>])&(?![&])/u.test(command);
}

function operationId(toolName: string, toolCallId: string): string {
	const boundedName = toolName.replace(/[\u0000-\u001f\u007f]/gu, "_").slice(0, 64);
	const boundedCall = toolCallId.replace(/[\u0000-\u001f\u007f]/gu, "_").slice(0, 160);
	return `tool:${boundedName}:${boundedCall || "anonymous"}`;
}

/** Register the single ordered tool_call guard. */
export function registerToolCallGuard(controller: ToolCallGuardController): void {
	let writeAuthorizationTail: Promise<void> = Promise.resolve();
	let pendingReceiptReservations = 0;
	const persistLease = (): boolean => {
		try {
			return controller.persistLease() !== false;
		} catch {
			return false;
		}
	};
	controller.pi.on("tool_call", async (event, ctx) => {
		let releaseWriteAuthorization: (() => void) | undefined;
		let acquiredCheckoutOperation: ProjectCheckoutOperationLeaseV1 | undefined;
		const abandonCheckoutOperation = async (): Promise<void> => {
			if (acquiredCheckoutOperation === undefined) return;
			controller.pendingCheckoutOperationHandles.delete(event.toolCallId);
			await (controller.releaseCheckoutOperation ?? releaseProjectCheckoutOperationV1)(acquiredCheckoutOperation).catch(() => undefined);
			acquiredCheckoutOperation = undefined;
		};
		if (event.toolName === "edit" || event.toolName === "write") {
			const previous = writeAuthorizationTail;
			writeAuthorizationTail = new Promise<void>((resolve) => { releaseWriteAuthorization = resolve; });
			await previous;
		}
		try {
		const streamingBoundaryReason = controller.toolCallBlockReason(event.toolName);
		if (streamingBoundaryReason) return { block: true, reason: streamingBoundaryReason };
		const staleRuntimeReason = controller.runtimeMutationBlockReason(event.toolName);
		if (staleRuntimeReason) return { block: true, reason: boundedGuardReason(staleRuntimeReason) };
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
		if (event.toolName === "bash" && bashMayOutliveToolResult(event.input)) {
			return {
				block: true,
				reason: boundedGuardReason("Background/detached shell processes are forbidden: the checkout lane is released only after the foreground process tree settles"),
			};
		}
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

		if (workbenchToolRequiresCheckoutLaneV1(event.toolName, event.input) &&
			!workbenchToolRoutesExactRepairV1(event.toolName, event.input)) {
			let projectRoot: string;
			const inheritedToken = process.env[WORKBENCH_CHECKOUT_OPERATION_TOKEN_ENV];
			const inheritedDelegationId = workerRoleContext.role === "worker"
				? process.env[WORKER_DELEGATION_ID_ENV]
				: undefined;
			if (workerRoleContext.role === "worker" &&
				(workerRoleContext.projectRoot === undefined || inheritedDelegationId === undefined || inheritedToken === undefined)) {
				if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
				return {
					block: true,
					reason: boundedGuardReason("Delegated worker checkout mutation requires the exact inherited parent operation token"),
				};
			}
			try {
				// A delegated worker's immutable runtime identity is the authority for
				// its checkout root.  It may borrow only the exact parent token passed
				// by the runner; it must never fall back to acquiring a second,
				// independent writer operation from a session cwd.
				const contextProjectRoot = await controller.projectRootFor(ctx);
				if (workerRoleContext.role === "worker" && contextProjectRoot !== workerRoleContext.projectRoot) {
					throw new Error("worker checkout root mismatch");
				}
				projectRoot = workerRoleContext.role === "worker"
					? workerRoleContext.projectRoot!
					: contextProjectRoot;
			} catch {
				if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
				return { block: true, reason: boundedGuardReason("Checkout writer lane project root is unavailable") };
			}
			if (inheritedToken === undefined) {
				try {
					// This is also the deterministic same-PID /reload recovery point:
					// a settled delegation is CAS-closed under its exact retained token
					// before this new operation attempts acquisition.
					await controller.reconcileProjectAuthority(projectRoot, now);
				} catch {
					if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
					return { block: true, reason: boundedGuardReason("Checkout writer lane recovery is unavailable") };
				}
			}
			const guardedDelegationId = event.toolName === "workbench_delegate_worker"
				? controller.makeDelegationId(new Date(now))
				: undefined;
			const acquired = await (controller.acquireCheckoutOperation ?? acquireProjectCheckoutOperationV1)({
					project_root: projectRoot,
					operation_kind: guardedDelegationId === undefined ? "tool" : "delegation",
					operation_id: guardedDelegationId === undefined
						? operationId(event.toolName, event.toolCallId)
						: `delegation:${guardedDelegationId}`,
					now,
					...(guardedDelegationId === undefined ? {} : { delegation_id: guardedDelegationId }),
					...(inheritedToken === undefined ? {} : { reentrant_token: inheritedToken }),
					...(inheritedDelegationId === undefined ? {} : { delegation_id: inheritedDelegationId }),
			});
			if (!acquired.ok) {
				if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
				return { block: true, reason: boundedGuardReason(`Checkout writer lane ${acquired.error.code}`) };
			}
			acquiredCheckoutOperation = acquired.value;
			controller.pendingCheckoutOperationHandles.set(event.toolCallId, acquired.value);
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
				await abandonCheckoutOperation();
				return { block: true, reason: boundedGuardReason(begun.reason) };
			}
		}

		const receiptFreeGatePreflight = event.toolName === "workbench_run_gate"
			&& event.input && typeof event.input === "object"
			&& (event.input as { preflight?: unknown }).preflight === true;
		if (workbenchToolRequiresReceipt(event.toolName) && !receiptFreeGatePreflight) {
			if (controller.pendingReceiptHandles.size + pendingReceiptReservations >= MAX_IN_FLIGHT_RECEIPTS) {
				if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
				await abandonCheckoutOperation();
				return { block: true, reason: boundedGuardReason(capacityBlockReason()) };
			}
			pendingReceiptReservations += 1;
			try {
				const projectRoot = await controller.projectRootFor(ctx);
					const begun = await (controller.beginToolReceipt ?? beginReceipt)({
					projectRoot,
					sessionIdentity: ctx.sessionManager.getSessionId(),
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					rawInput: event.input,
				});
				if (!begun.ok) {
					if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
					await abandonCheckoutOperation();
					return { block: true, reason: boundedGuardReason(beginBlockReason(begun)) };
				}
				controller.pendingReceiptHandles.set(event.toolCallId, { handle: begun.handle, projectRoot });
			} catch {
				if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
				await abandonCheckoutOperation();
				return { block: true, reason: boundedGuardReason("Tool result receipt storage unavailable") };
			} finally {
				pendingReceiptReservations -= 1;
			}
		}

		if (actor === "sol-commander" && (event.toolName === "edit" || event.toolName === "write")) {
			const path = event.input && typeof event.input === "object" && typeof (event.input as { path?: unknown }).path === "string"
				? (event.input as { path: string }).path
				: "";
			const lease = controller.getLease();
			if (lease && leaseStatus(lease, now) === "active") {
				const consumed = consumeLeaseCall(lease, event.toolName, path, now);
				if (!consumed.ok) {
					if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
					await abandonCheckoutOperation();
					return { block: true, reason: boundedGuardReason(consumed.error) };
				}
				controller.setLease(consumed.lease);
				if (!persistLease()) {
					controller.setLease(revokeLease(consumed.lease, "lease persistence unavailable", now));
					controller.applyModeTools();
					if (authorization.authorizationId) controller.turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
					await abandonCheckoutOperation();
					return { block: true, reason: boundedGuardReason("Commander write lease persistence unavailable; write authorization locked") };
				}
				if (leaseStatus(consumed.lease, now) !== "active") controller.applyModeTools();
			}
		}
		if ((event.toolName === "edit" || event.toolName === "write") && event.input && typeof event.input === "object") {
			const path = (event.input as { path?: unknown }).path;
			if (typeof path === "string" && path.length > 0) controller.recordModifiedFile(path);
		}
		return undefined;
		} finally {
			releaseWriteAuthorization?.();
		}
	});
}
