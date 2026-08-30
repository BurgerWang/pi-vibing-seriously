/** Serialized durable lifecycle refresh used by UI and per-turn injection. */

import type { ExecFn } from "./config.ts";
import {
	authorizePausedBudgetContinuationTurnV1,
	type BudgetContinuationAuthorizationV1,
} from "./budget-continuation-authorization.ts";
import { lifecycleActionTurnMessageV2 } from "./agent-next-action.ts";
import { isStrictRetryableCheckpointRepairRecoveryV2 } from "./delegation-execution-owner.ts";
import {
	appendLifecycleActionSnapshotIfChangedV2,
	buildLifecycleActionSnapshotV2,
	type LifecycleActionSnapshotV2,
} from "./delegation-lifecycle-resolver.ts";
import {
	delegationLifecycleResolutionForStatusV1,
	readDelegationRepairStatusV1,
	type DelegationRepairStatusV1,
} from "./delegation-repair-status.ts";
import type { DelegationState } from "./delegation-state.ts";
import {
	readDelegationTransactionV2,
	readDelegationWorkerCheckpointV1,
} from "./delegation-transaction-storage.ts";
import type { WorkbenchMode } from "./mode-policy.ts";

export interface LifecycleActionRefreshDependenciesV2 {
	readonly exec: ExecFn;
	readonly getMode: () => WorkbenchMode;
	readonly getDelegationState: () => DelegationState;
	readonly getLatestSnapshotHash: () => string | null;
	readonly setLatestSnapshotHash: (hash: string) => void;
	readonly appendEntry: (customType: string, data: unknown) => void;
	readonly publish: (
		status: DelegationRepairStatusV1,
		snapshot: Readonly<LifecycleActionSnapshotV2>,
	) => void;
}

export interface LifecycleActionRefreshControllerV2 {
	refresh(projectRoot: string, stateOverride?: Readonly<DelegationState>): Promise<Readonly<LifecycleActionSnapshotV2> | undefined>;
	refreshTurn(input: Readonly<{
		enabled: boolean;
		getProjectRoot: () => Promise<string>;
		prompt: string;
		getActiveTools: () => readonly string[];
	}>): Promise<Readonly<{
		message?: ReturnType<typeof lifecycleActionTurnMessageV2>;
		budgetAuthorized: boolean;
	}> | undefined>;
	takeBudgetContinuationAuthorization(delegationId: string): Readonly<BudgetContinuationAuthorizationV1> | undefined;
	clearBudgetContinuationAuthorization(): void;
}

/** Re-read authority for every queued refresh and publish in the same order. */
export function createLifecycleActionRefreshControllerV2(
	dependencies: LifecycleActionRefreshDependenciesV2,
): LifecycleActionRefreshControllerV2 {
	let tail: Promise<void> = Promise.resolve();
	let pendingBudgetContinuationAuthorization: Readonly<BudgetContinuationAuthorizationV1> | undefined;
	const enqueueRefresh = (
		projectRoot: string,
		stateOverride?: Readonly<DelegationState>,
		prompt?: string,
	): Promise<Readonly<{
		snapshot?: Readonly<LifecycleActionSnapshotV2>;
		budgetAuthorized: boolean;
	}>> => {
		const operation = tail.then(async () => {
			if (prompt !== undefined) pendingBudgetContinuationAuthorization = undefined;
			const state = stateOverride ?? dependencies.getDelegationState();
			const status = await readDelegationRepairStatusV1(
				projectRoot,
				state,
				dependencies.exec,
			);
			const resolution = delegationLifecycleResolutionForStatusV1(state, status);
			let checkpoint;
			if (state.latestId !== undefined) {
				const transaction = await readDelegationTransactionV2(projectRoot, state.latestId);
				if (transaction.ok && (transaction.value.status === "RUNNING" ||
					transaction.value.status === "RECOVERY_REQUIRED" &&
					await isStrictRetryableCheckpointRepairRecoveryV2(projectRoot, transaction.value))) {
					const readCheckpoint = await readDelegationWorkerCheckpointV1(projectRoot, state.latestId);
					if (readCheckpoint.ok) checkpoint = readCheckpoint.value;
				}
			}
			const built = buildLifecycleActionSnapshotV2({
				project_root: projectRoot,
				mode: dependencies.getMode(),
				resolution,
				...(checkpoint === undefined ? {} : { checkpoint }),
			});
			if (!built.ok) return { budgetAuthorized: false };
			const authorized = prompt === undefined
				? undefined
				: authorizePausedBudgetContinuationTurnV1(built.value, prompt, checkpoint);
			const snapshot = authorized?.snapshot ?? built.value;
			if (authorized !== undefined) pendingBudgetContinuationAuthorization = authorized.authorization;
			const appended = appendLifecycleActionSnapshotIfChangedV2(
				snapshot,
				dependencies.getLatestSnapshotHash(),
				dependencies.appendEntry,
			);
			if (appended !== undefined) dependencies.setLatestSnapshotHash(appended.latest_snapshot_hash);
			dependencies.publish(status, snapshot);
			return { snapshot, budgetAuthorized: authorized !== undefined };
		});
		tail = operation.then(() => undefined, () => undefined);
		return operation;
	};
	const refresh = async (
		projectRoot: string,
		stateOverride?: Readonly<DelegationState>,
	): Promise<Readonly<LifecycleActionSnapshotV2> | undefined> =>
		(await enqueueRefresh(projectRoot, stateOverride)).snapshot;
	const refreshTurn = async (input: Readonly<{
		enabled: boolean;
		getProjectRoot: () => Promise<string>;
		prompt: string;
		getActiveTools: () => readonly string[];
	}>) => {
		if (!input.enabled) return undefined;
		try {
			const result = await enqueueRefresh(await input.getProjectRoot(), undefined, input.prompt);
			if (result.snapshot === undefined) return undefined;
			return Object.freeze({
				message: lifecycleActionTurnMessageV2(result.snapshot, input.getActiveTools()),
				budgetAuthorized: result.budgetAuthorized,
			});
		} catch {
			// Per-turn status/tool refresh remains fail-closed and non-disruptive.
			return undefined;
		}
	};
	const takeBudgetContinuationAuthorization = (delegationId: string) => {
		if (pendingBudgetContinuationAuthorization?.delegation_id !== delegationId) return undefined;
		const authorization = pendingBudgetContinuationAuthorization;
		pendingBudgetContinuationAuthorization = undefined;
		return authorization;
	};
	const clearBudgetContinuationAuthorization = (): void => {
		pendingBudgetContinuationAuthorization = undefined;
	};
	return Object.freeze({
		refresh,
		refreshTurn,
		takeBudgetContinuationAuthorization,
		clearBudgetContinuationAuthorization,
	});
}
