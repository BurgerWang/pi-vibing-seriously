/**
 * Single effect boundary for canonical lifecycle actions.
 *
 * The boundary owns orchestration only. Project-specific readers, writer-lock
 * acquisition, and effects are injected so this module cannot create a second
 * authority store. A handler is eligible only when the exact canonical action
 * remains current under the writer lock. Completion is proven from a rebuilt
 * snapshot, which also makes a lost response replay-safe.
 */

import { canonicalHash } from "../cache/canonical-hash.ts";
import {
	DELEGATION_LIFECYCLE_ACTION_KIND_V1,
	DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	DELEGATION_LIFECYCLE_PRIMARY_ACTIONS_V1,
	DELEGATION_LIFECYCLE_REASONS_V1,
	DELEGATION_LIFECYCLE_RESOLUTION_KIND_V1,
	DELEGATION_LIFECYCLE_STATES_V1,
	parseDelegationLifecycleSnapshotV1,
	resolveDelegationLifecycleV1,
	type DelegationLifecyclePrimaryActionNameV1,
	type DelegationLifecyclePrimaryActionV1,
	type DelegationLifecycleResolutionV1,
	type DelegationLifecycleSnapshotV1,
} from "./delegation-lifecycle-resolver.ts";

export const DELEGATION_LIFECYCLE_EFFECT_ACTIONS_V1 = [
	"REVIEW_CANDIDATE",
	"EXECUTE_EXACT_REPAIR",
	"CLOSE_SATISFIED_NO_DELTA",
	"SUPERSEDE_EMPTY_ATTEMPT",
	"CLOSE_ACCEPTED_OBLIGATION",
	"REGENERATE_DERIVED_REVIEW",
	"QUARANTINE_CORRUPT_AUTHORITY",
	"REBASE_CURRENT_BINDING",
	"RECLAIM_STALE_LOCK",
	"PROMOTE_CANDIDATE",
] as const satisfies readonly DelegationLifecyclePrimaryActionNameV1[];

export type DelegationLifecycleEffectActionNameV1 =
	(typeof DELEGATION_LIFECYCLE_EFFECT_ACTIONS_V1)[number];

export type DelegationLifecycleEffectFailureCodeV1 =
	| "ACTION_CHANGED"
	| "ACTION_NOT_EXECUTABLE"
	| "AUTOMATIC_EXECUTION_FORBIDDEN"
	| "EFFECT_CONFLICT"
	| "EFFECT_FAILED"
	| "EFFECT_STORAGE_FAILURE"
	| "EFFECT_UNAVAILABLE"
	| "HANDLER_MISSING"
	| "INVALID_INPUT"
	| "LOCK_CONFLICT"
	| "LOCK_FAILED"
	| "LOCK_STORAGE_FAILURE"
	| "POSTCONDITION_FAILED"
	| "RECOVERY_RANK_NOT_DECREASED"
	| "RECOVERY_RANK_UNAVAILABLE"
	| "SNAPSHOT_INVALID"
	| "SNAPSHOT_READ_FAILED"
	| "USER_AUTHORIZATION_REQUIRED";

export interface DelegationLifecycleEffectExecutionInputV1 {
	readonly project_root: string;
	readonly resolution: DelegationLifecycleResolutionV1;
	readonly expected_snapshot_hash: string;
	readonly execution_mode: "AUTOMATIC" | "EXPLICIT";
	readonly user_authorized: boolean;
	readonly now: string;
}

export interface DelegationLifecycleEffectLockContextV1 {
	/** Opaque exact owner identity; snapshot readers use it to ignore only this lease. */
	readonly owner: unknown;
}

export type DelegationLifecycleEffectOperationResultV1 =
	| { readonly ok: true }
	| {
		readonly ok: false;
		readonly code: "CONFLICT" | "FAILED" | "STORAGE_FAILURE" | "UNAVAILABLE";
	};

export interface DelegationLifecycleEffectHandlerV1 {
	/** Must derive completion only from current durable authority represented by this snapshot. */
	is_complete(input: {
		readonly snapshot: DelegationLifecycleSnapshotV1;
		readonly resolution: DelegationLifecycleResolutionV1;
		readonly requested_action: DelegationLifecyclePrimaryActionV1;
	}): boolean | Promise<boolean>;
	execute(input: {
		readonly project_root: string;
		readonly action: DelegationLifecyclePrimaryActionV1;
		readonly lock: DelegationLifecycleEffectLockContextV1;
		readonly now: string;
	}): Promise<DelegationLifecycleEffectOperationResultV1>;
}

export interface DelegationLifecycleEffectDependenciesV1 {
	with_writer_lock<T>(input: {
		readonly project_root: string;
		readonly action: DelegationLifecyclePrimaryActionV1;
		readonly now: string;
	}, operation: (lock: DelegationLifecycleEffectLockContextV1) => Promise<T>): Promise<
		| { readonly ok: true; readonly value: T }
		| { readonly ok: false; readonly code: "CONFLICT" | "FAILED" | "STORAGE_FAILURE" }
	>;
	/** Must rebuild from source authority while masking only `lock.owner`. */
	read_snapshot(input: {
		readonly project_root: string;
		readonly requested_action: DelegationLifecyclePrimaryActionV1;
		readonly lock: DelegationLifecycleEffectLockContextV1;
	}): Promise<unknown>;
	readonly handlers: Partial<Record<DelegationLifecycleEffectActionNameV1, DelegationLifecycleEffectHandlerV1>>;
}

export type DelegationLifecycleEffectExecutionResultV1 =
	| {
		readonly ok: true;
		readonly status: "EXECUTED" | "REPLAYED";
		readonly requested_action_hash: string;
		readonly observed: DelegationLifecycleResolutionV1;
	}
	| {
		readonly ok: false;
		readonly status: "FAILED" | "REFUSED" | "STALE";
		readonly code: DelegationLifecycleEffectFailureCodeV1;
		readonly requested_action_hash: string | null;
		readonly observed?: DelegationLifecycleResolutionV1;
	};

const HASH_RE = /^[a-f0-9]{64}$/u;
const INPUT_FIELDS = [
	"project_root", "resolution", "expected_snapshot_hash", "execution_mode", "user_authorized", "now",
] as const;
const RESOLUTION_FIELDS = ["schema_version", "kind", "state", "primary_action", "resolution_hash"] as const;
const ACTION_FIELDS = [
	"schema_version", "kind", "action", "reason", "snapshot_hash", "exact_target", "affected_paths", "scope_unknown",
	"safe_automatic", "requires_user_authorization", "expected_state",
	"recovery_effect",
	"expected_recovery_rank",
] as const;
const RECOVERY_RANK_FIELDS = ["unresolved_obligations", "unresolved_attempts"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
	return typeof value === "string" && values.includes(value as T);
}

function validRecoveryRank(value: unknown): boolean {
	if (value === null) return true;
	return isRecord(value) && exactFields(value, RECOVERY_RANK_FIELDS) &&
		Number.isSafeInteger(value.unresolved_obligations) && Number(value.unresolved_obligations) >= 0 &&
		Number(value.unresolved_obligations) <= 10_000 && Number.isSafeInteger(value.unresolved_attempts) &&
		Number(value.unresolved_attempts) >= Number(value.unresolved_obligations) &&
		Number(value.unresolved_attempts) <= 10_000;
}

function canonicalTime(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 20 || value.length > 64 || !value.endsWith("Z")) return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isEffectAction(value: DelegationLifecyclePrimaryActionNameV1): value is DelegationLifecycleEffectActionNameV1 {
	return (DELEGATION_LIFECYCLE_EFFECT_ACTIONS_V1 as readonly string[]).includes(value);
}

function validatedResolution(value: unknown): DelegationLifecycleResolutionV1 | undefined {
	if (!isRecord(value) || !exactFields(value, RESOLUTION_FIELDS) || value.schema_version !== 1 ||
		value.kind !== DELEGATION_LIFECYCLE_RESOLUTION_KIND_V1 ||
		!member(value.state, DELEGATION_LIFECYCLE_STATES_V1) ||
		typeof value.resolution_hash !== "string" || !HASH_RE.test(value.resolution_hash) ||
		!isRecord(value.primary_action) || !exactFields(value.primary_action, ACTION_FIELDS)) return undefined;
	const action = value.primary_action;
	if (action.schema_version !== 1 || action.kind !== DELEGATION_LIFECYCLE_ACTION_KIND_V1 ||
		!member(action.action, DELEGATION_LIFECYCLE_PRIMARY_ACTIONS_V1) ||
		!member(action.reason, DELEGATION_LIFECYCLE_REASONS_V1) ||
		typeof action.snapshot_hash !== "string" || !HASH_RE.test(action.snapshot_hash) ||
		!member(action.expected_state, DELEGATION_LIFECYCLE_STATES_V1) ||
		!member(action.recovery_effect, ["MAY_CREATE_DELTA", "MUST_DECREASE_RANK", "NONE"] as const) ||
		!validRecoveryRank(action.expected_recovery_rank) ||
		typeof action.scope_unknown !== "boolean" || typeof action.safe_automatic !== "boolean" ||
		typeof action.requires_user_authorization !== "boolean" || !Array.isArray(action.affected_paths) ||
		!isRecord(action.exact_target)) return undefined;
	const projection = {
		schema_version: value.schema_version,
		kind: value.kind,
		state: value.state,
		primary_action: value.primary_action,
	};
	return canonicalHash(projection) === value.resolution_hash
		? value as unknown as DelegationLifecycleResolutionV1
		: undefined;
}

function validateInput(value: unknown): DelegationLifecycleEffectExecutionInputV1 | undefined {
	if (!isRecord(value) || !exactFields(value, INPUT_FIELDS) ||
		typeof value.project_root !== "string" || value.project_root.length === 0 || value.project_root.includes("\0") ||
		typeof value.expected_snapshot_hash !== "string" || !HASH_RE.test(value.expected_snapshot_hash) ||
		(value.execution_mode !== "AUTOMATIC" && value.execution_mode !== "EXPLICIT") ||
		typeof value.user_authorized !== "boolean" || !canonicalTime(value.now)) return undefined;
	let detachedResolution: unknown;
	try {
		detachedResolution = JSON.parse(JSON.stringify(value.resolution));
	} catch {
		return undefined;
	}
	const resolution = validatedResolution(detachedResolution);
	if (resolution === undefined || resolution.primary_action.snapshot_hash !== value.expected_snapshot_hash) return undefined;
	return {
		project_root: value.project_root,
		resolution,
		expected_snapshot_hash: value.expected_snapshot_hash,
		execution_mode: value.execution_mode,
		user_authorized: value.user_authorized,
		now: value.now,
	};
}

function failure(
	status: "FAILED" | "REFUSED" | "STALE",
	code: DelegationLifecycleEffectFailureCodeV1,
	actionHash: string | null,
	observed?: DelegationLifecycleResolutionV1,
): DelegationLifecycleEffectExecutionResultV1 {
	return { ok: false, status, code, requested_action_hash: actionHash, ...(observed === undefined ? {} : { observed }) };
}

function actionHash(action: DelegationLifecyclePrimaryActionV1): string {
	return canonicalHash(action);
}

function sameAction(left: DelegationLifecyclePrimaryActionV1, right: DelegationLifecyclePrimaryActionV1): boolean {
	return actionHash(left) === actionHash(right);
}

function recoveryRankDecreased(
	before: DelegationLifecycleSnapshotV1["recovery_rank"],
	after: DelegationLifecycleSnapshotV1["recovery_rank"],
): boolean {
	if (before === null || after === null) return false;
	return after.unresolved_obligations < before.unresolved_obligations ||
		(after.unresolved_obligations === before.unresolved_obligations &&
			after.unresolved_attempts < before.unresolved_attempts);
}

function operationFailureCode(code: Exclude<DelegationLifecycleEffectOperationResultV1, { ok: true }>["code"]): DelegationLifecycleEffectFailureCodeV1 {
	switch (code) {
		case "CONFLICT": return "EFFECT_CONFLICT";
		case "FAILED": return "EFFECT_FAILED";
		case "STORAGE_FAILURE": return "EFFECT_STORAGE_FAILURE";
		case "UNAVAILABLE": return "EFFECT_UNAVAILABLE";
	}
}

function lockFailureCode(code: "CONFLICT" | "FAILED" | "STORAGE_FAILURE"): DelegationLifecycleEffectFailureCodeV1 {
	switch (code) {
		case "CONFLICT": return "LOCK_CONFLICT";
		case "FAILED": return "LOCK_FAILED";
		case "STORAGE_FAILURE": return "LOCK_STORAGE_FAILURE";
	}
}

async function readObserved(
	input: DelegationLifecycleEffectExecutionInputV1,
	lock: DelegationLifecycleEffectLockContextV1,
	dependencies: DelegationLifecycleEffectDependenciesV1,
): Promise<
	| { ok: true; snapshot: DelegationLifecycleSnapshotV1; resolution: DelegationLifecycleResolutionV1 }
	| { ok: false; code: "SNAPSHOT_INVALID" | "SNAPSHOT_READ_FAILED" }
> {
	let raw: unknown;
	try {
		raw = await dependencies.read_snapshot({
			project_root: input.project_root,
			requested_action: input.resolution.primary_action,
			lock,
		});
	} catch {
		return { ok: false, code: "SNAPSHOT_READ_FAILED" };
	}
	const parsed = parseDelegationLifecycleSnapshotV1(raw);
	if (!parsed.ok) return { ok: false, code: "SNAPSHOT_INVALID" };
	return {
		ok: true,
		snapshot: parsed.value,
		resolution: resolveDelegationLifecycleV1(parsed.value, {
			schema_version: 1,
			kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
			event: "OBSERVE",
			expected_snapshot_hash: null,
		}),
	};
}

/**
 * Execute or replay one exact resolver action under a caller-supplied writer
 * lock. No handler runs unless the action remains byte-canonical and current.
 */
export async function executeDelegationLifecycleEffectV1(
	inputValue: DelegationLifecycleEffectExecutionInputV1,
	dependencies: DelegationLifecycleEffectDependenciesV1,
): Promise<DelegationLifecycleEffectExecutionResultV1> {
	let input: DelegationLifecycleEffectExecutionInputV1 | undefined;
	try {
		input = validateInput(inputValue);
	} catch {
		input = undefined;
	}
	if (input === undefined) return failure("REFUSED", "INVALID_INPUT", null);
	const requestedAction = input.resolution.primary_action;
	const requestedActionHash = actionHash(requestedAction);
	if (!isEffectAction(requestedAction.action)) {
		return failure("REFUSED", "ACTION_NOT_EXECUTABLE", requestedActionHash);
	}
	const handler = dependencies.handlers[requestedAction.action];
	if (handler === undefined) return failure("REFUSED", "HANDLER_MISSING", requestedActionHash);
	if (input.execution_mode === "AUTOMATIC" && !requestedAction.safe_automatic) {
		return failure("REFUSED", "AUTOMATIC_EXECUTION_FORBIDDEN", requestedActionHash);
	}
	if (requestedAction.requires_user_authorization && !input.user_authorized) {
		return failure("REFUSED", "USER_AUTHORIZATION_REQUIRED", requestedActionHash);
	}

	let locked:
		| { readonly ok: true; readonly value: DelegationLifecycleEffectExecutionResultV1 }
		| { readonly ok: false; readonly code: "CONFLICT" | "FAILED" | "STORAGE_FAILURE" };
	try {
		locked = await dependencies.with_writer_lock({
			project_root: input.project_root,
			action: requestedAction,
			now: input.now,
		}, async (lock): Promise<DelegationLifecycleEffectExecutionResultV1> => {
			const before = await readObserved(input!, lock, dependencies);
			if (!before.ok) return failure("FAILED", before.code, requestedActionHash);
			let alreadyComplete: boolean;
			try {
				alreadyComplete = await handler.is_complete({
					snapshot: before.snapshot,
					resolution: before.resolution,
					requested_action: requestedAction,
				});
			} catch {
				return failure("FAILED", "POSTCONDITION_FAILED", requestedActionHash, before.resolution);
			}
			if (alreadyComplete && before.resolution.state === requestedAction.expected_state) {
				if (requestedAction.recovery_effect === "MUST_DECREASE_RANK" &&
					!recoveryRankDecreased(requestedAction.expected_recovery_rank, before.snapshot.recovery_rank)) {
					return failure("FAILED", "RECOVERY_RANK_NOT_DECREASED", requestedActionHash, before.resolution);
				}
				return {
					ok: true,
					status: "REPLAYED",
					requested_action_hash: requestedActionHash,
					observed: before.resolution,
				};
			}
			if (requestedAction.recovery_effect === "MUST_DECREASE_RANK" && before.snapshot.recovery_rank === null) {
				return failure("REFUSED", "RECOVERY_RANK_UNAVAILABLE", requestedActionHash, before.resolution);
			}
			if (before.resolution.primary_action.snapshot_hash !== input!.expected_snapshot_hash ||
				!sameAction(before.resolution.primary_action, requestedAction)) {
				return failure("STALE", "ACTION_CHANGED", requestedActionHash, before.resolution);
			}
			let effected: DelegationLifecycleEffectOperationResultV1;
			try {
				effected = await handler.execute({
					project_root: input!.project_root,
					action: requestedAction,
					lock,
					now: input!.now,
				});
			} catch {
				return failure("FAILED", "EFFECT_FAILED", requestedActionHash, before.resolution);
			}
			if (!effected.ok) {
				return failure("FAILED", operationFailureCode(effected.code), requestedActionHash, before.resolution);
			}
			const after = await readObserved(input!, lock, dependencies);
			if (!after.ok) return failure("FAILED", after.code, requestedActionHash);
			let complete: boolean;
			try {
				complete = await handler.is_complete({
					snapshot: after.snapshot,
					resolution: after.resolution,
					requested_action: requestedAction,
				});
			} catch {
				complete = false;
			}
			if (!complete || after.resolution.state !== requestedAction.expected_state) {
				return failure("FAILED", "POSTCONDITION_FAILED", requestedActionHash, after.resolution);
			}
			if (requestedAction.recovery_effect === "MUST_DECREASE_RANK" &&
				!recoveryRankDecreased(requestedAction.expected_recovery_rank, after.snapshot.recovery_rank)) {
				return failure("FAILED", "RECOVERY_RANK_NOT_DECREASED", requestedActionHash, after.resolution);
			}
			return {
				ok: true,
				status: "EXECUTED",
				requested_action_hash: requestedActionHash,
				observed: after.resolution,
			};
		});
	} catch {
		return failure("FAILED", "LOCK_FAILED", requestedActionHash);
	}
	return locked.ok ? locked.value : failure("FAILED", lockFailureCode(locked.code), requestedActionHash);
}
