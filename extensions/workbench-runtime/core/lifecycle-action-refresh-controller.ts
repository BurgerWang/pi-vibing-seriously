/** Serialized durable lifecycle refresh used by UI and per-turn injection. */

import type { ExecFn } from "./config.ts";
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
}

/** Re-read authority for every queued refresh and publish in the same order. */
export function createLifecycleActionRefreshControllerV2(
	dependencies: LifecycleActionRefreshDependenciesV2,
): LifecycleActionRefreshControllerV2 {
	let tail: Promise<void> = Promise.resolve();
	const refresh = (
		projectRoot: string,
		stateOverride?: Readonly<DelegationState>,
	): Promise<Readonly<LifecycleActionSnapshotV2> | undefined> => {
		const operation = tail.then(async () => {
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
			if (!built.ok) return undefined;
			const appended = appendLifecycleActionSnapshotIfChangedV2(
				built.value,
				dependencies.getLatestSnapshotHash(),
				dependencies.appendEntry,
			);
			if (appended !== undefined) dependencies.setLatestSnapshotHash(appended.latest_snapshot_hash);
			dependencies.publish(status, built.value);
			return built.value;
		});
		tail = operation.then(() => undefined, () => undefined);
		return operation;
	};
	return Object.freeze({ refresh });
}
