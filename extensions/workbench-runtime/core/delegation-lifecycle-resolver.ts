/**
 * Canonical delegation lifecycle resolver v1.
 *
 * Readers normalize durable authority into the closed snapshot below.  This
 * module is deliberately pure: it performs no filesystem, Git, model, lock,
 * process, or runtime I/O.  An effect executor may consume the one returned
 * action only after revalidating `snapshot_hash` under the writer lock.
 */

import { isAbsolute, posix } from "node:path";

import { canonicalHash, canonicalJson } from "../cache/canonical-hash.ts";
import type { DelegationPathLaneAdmissionV1 } from "./delegation-path-lane-admission.ts";
import { validateWorkerCheckpointV1, type WorkerCheckpointV1 } from "./worker-checkpoint.ts";

export const DELEGATION_LIFECYCLE_SCHEMA_VERSION_V1 = 1 as const;
export const DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1 = "delegation-lifecycle-snapshot-v1" as const;
export const DELEGATION_LIFECYCLE_EVENT_KIND_V1 = "delegation-lifecycle-event-v1" as const;
export const DELEGATION_LIFECYCLE_RESOLUTION_KIND_V1 = "delegation-lifecycle-resolution-v1" as const;
export const DELEGATION_LIFECYCLE_ACTION_KIND_V1 = "delegation-lifecycle-action-v1" as const;

export const DELEGATION_LIFECYCLE_STATES_V1 = [
	"ACTIVE",
	"AWAITING_REVIEW",
	"REPAIRABLE",
	"SATISFIED_NO_DELTA",
	"ACCEPTED",
	"SUPERSEDED",
	"TERMINAL_NON_BLOCKING",
	"INVALID_DERIVED_EVIDENCE",
	"CORRUPT_AUTHORITY",
	"BINDING_CONFLICT",
	"PROMOTION_READY",
	"PROMOTION_BLOCKED",
] as const;
export type DelegationLifecycleStateV1 = (typeof DELEGATION_LIFECYCLE_STATES_V1)[number];

export const DELEGATION_LIFECYCLE_PRIMARY_ACTIONS_V1 = [
	"CONTINUE_DEVELOPMENT",
	"WAIT_FOR_ACTIVE_WRITER",
	"REVIEW_CANDIDATE",
	"EXECUTE_EXACT_REPAIR",
	"CLOSE_SATISFIED_NO_DELTA",
	"SUPERSEDE_EMPTY_ATTEMPT",
	"CLOSE_ACCEPTED_OBLIGATION",
	"REGENERATE_DERIVED_REVIEW",
	"QUARANTINE_CORRUPT_AUTHORITY",
	"REBASE_CURRENT_BINDING",
	"BLOCK_OVERLAPPING_PATHS",
	"RECLAIM_STALE_LOCK",
	"PROMOTE_CANDIDATE",
	"BLOCK_PROMOTION",
	"REPORT_STORAGE_FAILURE",
] as const;
export type DelegationLifecyclePrimaryActionNameV1 =
	(typeof DELEGATION_LIFECYCLE_PRIMARY_ACTIONS_V1)[number];

export const DELEGATION_LIFECYCLE_REASONS_V1 = [
	"ACCEPTED_SUCCESSOR_PRESENT",
	"ACTIVE_WRITER_PRESENT",
	"CANDIDATE_PROMOTION_READY",
	"CANDIDATE_PROMOTION_REQUIREMENTS_MISSING",
	"CURRENT_DELTA_REVIEW_REQUIRED",
	"DERIVED_REVIEW_INVALID",
	"EMPTY_ATTEMPT_SUPERSEDED",
	"EXACT_REPAIR_DECISION_CURRENT",
	"INVALID_EVENT",
	"INVALID_PATH_REQUEST",
	"INVALID_SNAPSHOT",
	"NO_CURRENT_BLOCKER",
	"OVERLAPPING_PATHS",
	"REBASEABLE_BINDING_CHANGED",
	"RUNTIME_IDENTITY_STALE",
	"SATISFIED_WITHOUT_NEW_DELTA",
	"SNAPSHOT_CHANGED",
	"STALE_WRITER_LOCK",
	"STORAGE_READ_FAILED",
	"UNDERLYING_AUTHORITY_CORRUPT",
] as const;
export type DelegationLifecycleReasonV1 = (typeof DELEGATION_LIFECYCLE_REASONS_V1)[number];

export type DelegationLifecycleOperationIntentV1 = "DEV" | "RELEASE" | "VERIFY";
export type DelegationLifecycleAuthorityHealthV1 = "CORRUPT" | "DERIVED_INVALID" | "STORAGE_FAILURE" | "VALID";
export type DelegationLifecycleAuthorityDispositionV1 = "ACTIVE" | "INACTIVE" | "UNKNOWN";
export type DelegationLifecycleWriterLockV1 = "ABSENT" | "LIVE" | "STALE";
export type DelegationLifecycleBindingV1 = "CURRENT" | "OVERLAPPING" | "REBASEABLE";
export type DelegationLifecycleAttemptV1 =
	| "ACCEPTED"
	| "ACTIVE"
	| "AWAITING_REVIEW"
	| "NONE"
	| "REPAIRABLE"
	| "SATISFIED_NO_DELTA"
	| "SUPERSEDED"
	| "TERMINAL";
export type DelegationLifecycleCandidateV1 = "BLOCKED" | "INCOMPLETE" | "NONE" | "READY";
export type DelegationLifecycleRuntimeIdentityV1 = "CURRENT" | "NOT_REQUIRED" | "STALE" | "UNKNOWN";
export type DelegationLifecycleRecoveryEffectV1 = "MAY_CREATE_DELTA" | "MUST_DECREASE_RANK" | "NONE";

export interface DelegationLifecycleRecoveryRankV1 {
	readonly unresolved_obligations: number;
	readonly unresolved_attempts: number;
}

export interface DelegationLifecycleTargetV1 {
	readonly kind: "CANDIDATE" | "DELEGATION" | "PROJECT_AUTHORITY";
	readonly id: string;
}

/** Rebuildable projection only; this is never a persisted authority record. */
export interface DelegationLifecycleSnapshotV1 {
	readonly schema_version: typeof DELEGATION_LIFECYCLE_SCHEMA_VERSION_V1;
	readonly kind: typeof DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1;
	readonly source_authority_hash: string;
	readonly operation_intent: DelegationLifecycleOperationIntentV1;
	readonly authority: {
		readonly health: DelegationLifecycleAuthorityHealthV1;
		readonly disposition: DelegationLifecycleAuthorityDispositionV1;
	};
	readonly writer_lock: DelegationLifecycleWriterLockV1;
	readonly binding: DelegationLifecycleBindingV1;
	readonly attempt: DelegationLifecycleAttemptV1;
	readonly candidate: DelegationLifecycleCandidateV1;
	readonly runtime_identity: DelegationLifecycleRuntimeIdentityV1;
	readonly request_valid: boolean;
	readonly target: DelegationLifecycleTargetV1;
	readonly affected_paths: readonly string[];
	readonly scope_unknown: boolean;
	/** Null only when source authority is too incomplete to count safely. */
	readonly recovery_rank: DelegationLifecycleRecoveryRankV1 | null;
}

export interface DelegationLifecycleEventV1 {
	readonly schema_version: typeof DELEGATION_LIFECYCLE_SCHEMA_VERSION_V1;
	readonly kind: typeof DELEGATION_LIFECYCLE_EVENT_KIND_V1;
	readonly event: "EXECUTE" | "OBSERVE";
	/** Required for EXECUTE and forbidden for OBSERVE. */
	readonly expected_snapshot_hash: string | null;
}

export interface DelegationLifecyclePrimaryActionV1 {
	readonly schema_version: typeof DELEGATION_LIFECYCLE_SCHEMA_VERSION_V1;
	readonly kind: typeof DELEGATION_LIFECYCLE_ACTION_KIND_V1;
	readonly action: DelegationLifecyclePrimaryActionNameV1;
	readonly reason: DelegationLifecycleReasonV1;
	readonly snapshot_hash: string;
	readonly exact_target: DelegationLifecycleTargetV1;
	readonly affected_paths: readonly string[];
	readonly scope_unknown: boolean;
	readonly safe_automatic: boolean;
	readonly requires_user_authorization: boolean;
	readonly expected_state: DelegationLifecycleStateV1;
	readonly recovery_effect: DelegationLifecycleRecoveryEffectV1;
	readonly expected_recovery_rank: DelegationLifecycleRecoveryRankV1 | null;
}

export interface DelegationLifecycleResolutionV1 {
	readonly schema_version: typeof DELEGATION_LIFECYCLE_SCHEMA_VERSION_V1;
	readonly kind: typeof DELEGATION_LIFECYCLE_RESOLUTION_KIND_V1;
	readonly state: DelegationLifecycleStateV1;
	readonly primary_action: DelegationLifecyclePrimaryActionV1;
	readonly resolution_hash: string;
}

const HASH_RE = /^[a-f0-9]{64}$/u;
const TARGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SNAPSHOT_FIELDS = [
	"schema_version", "kind", "source_authority_hash", "operation_intent", "authority", "writer_lock", "binding",
	"attempt", "candidate", "runtime_identity", "target", "affected_paths", "scope_unknown",
	"request_valid", "recovery_rank",
] as const;
const AUTHORITY_FIELDS = ["health", "disposition"] as const;
const TARGET_FIELDS = ["kind", "id"] as const;
const RECOVERY_RANK_FIELDS = ["unresolved_obligations", "unresolved_attempts"] as const;
const EVENT_FIELDS = ["schema_version", "kind", "event", "expected_snapshot_hash"] as const;
const INVALID_SNAPSHOT_HASH = canonicalHash({ kind: "delegation-lifecycle-invalid-snapshot-v1", schema_version: 1 });

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort(byteCompare);
	const expected = [...fields].sort(byteCompare);
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
	return typeof value === "string" && values.includes(value as T);
}

function validPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 400) return false;
	if (value !== value.trim() || isAbsolute(value) || value.includes("\\") || value.includes("\0")) return false;
	const subtree = value.endsWith("/**");
	const base = subtree ? value.slice(0, -3) : value;
	return base.length > 0 && posix.normalize(base) === base && base !== "." && base !== ".." && !base.startsWith("../");
}

function parsePaths(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > 500 || !value.every(validPath)) return undefined;
	const paths = [...value];
	return paths.every((path, index) => index === 0 || byteCompare(paths[index - 1]!, path) < 0) ? paths : undefined;
}

function parseTarget(value: unknown): DelegationLifecycleTargetV1 | undefined {
	if (!isRecord(value) || !exactFields(value, TARGET_FIELDS) ||
		!member(value.kind, ["CANDIDATE", "DELEGATION", "PROJECT_AUTHORITY"] as const) ||
		typeof value.id !== "string" || !TARGET_ID_RE.test(value.id)) return undefined;
	return { kind: value.kind, id: value.id };
}

function parseRecoveryRank(value: unknown): DelegationLifecycleRecoveryRankV1 | null | undefined {
	if (value === null) return null;
	if (!isRecord(value) || !exactFields(value, RECOVERY_RANK_FIELDS) ||
		!Number.isSafeInteger(value.unresolved_obligations) || Number(value.unresolved_obligations) < 0 ||
		Number(value.unresolved_obligations) > 10_000 ||
		!Number.isSafeInteger(value.unresolved_attempts) || Number(value.unresolved_attempts) < 0 ||
		Number(value.unresolved_attempts) > 10_000 ||
		Number(value.unresolved_attempts) < Number(value.unresolved_obligations)) return undefined;
	return {
		unresolved_obligations: Number(value.unresolved_obligations),
		unresolved_attempts: Number(value.unresolved_attempts),
	};
}

function parseSnapshot(value: unknown): DelegationLifecycleSnapshotV1 | undefined {
	if (!isRecord(value) || !exactFields(value, SNAPSHOT_FIELDS) || value.schema_version !== 1 ||
		value.kind !== DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1 ||
		typeof value.source_authority_hash !== "string" || !HASH_RE.test(value.source_authority_hash) ||
		!member(value.operation_intent, ["DEV", "RELEASE", "VERIFY"] as const) ||
		!isRecord(value.authority) || !exactFields(value.authority, AUTHORITY_FIELDS) ||
		!member(value.authority.health, ["CORRUPT", "DERIVED_INVALID", "STORAGE_FAILURE", "VALID"] as const) ||
		!member(value.authority.disposition, ["ACTIVE", "INACTIVE", "UNKNOWN"] as const) ||
		!member(value.writer_lock, ["ABSENT", "LIVE", "STALE"] as const) ||
		!member(value.binding, ["CURRENT", "OVERLAPPING", "REBASEABLE"] as const) ||
		!member(value.attempt, ["ACCEPTED", "ACTIVE", "AWAITING_REVIEW", "NONE", "REPAIRABLE", "SATISFIED_NO_DELTA", "SUPERSEDED", "TERMINAL"] as const) ||
		!member(value.candidate, ["BLOCKED", "INCOMPLETE", "NONE", "READY"] as const) ||
		!member(value.runtime_identity, ["CURRENT", "NOT_REQUIRED", "STALE", "UNKNOWN"] as const) ||
		typeof value.request_valid !== "boolean" ||
		typeof value.scope_unknown !== "boolean") return undefined;
	const target = parseTarget(value.target);
	const affectedPaths = parsePaths(value.affected_paths);
	const recoveryRank = parseRecoveryRank(value.recovery_rank);
	if (target === undefined || affectedPaths === undefined || recoveryRank === undefined) return undefined;
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: value.source_authority_hash,
		operation_intent: value.operation_intent,
		authority: { health: value.authority.health, disposition: value.authority.disposition },
		writer_lock: value.writer_lock,
		binding: value.binding,
		attempt: value.attempt,
		candidate: value.candidate,
		runtime_identity: value.runtime_identity,
		request_valid: value.request_valid,
		target,
		affected_paths: affectedPaths,
		scope_unknown: value.scope_unknown,
		recovery_rank: recoveryRank,
	};
}

function parseEvent(value: unknown): DelegationLifecycleEventV1 | undefined {
	if (!isRecord(value) || !exactFields(value, EVENT_FIELDS) || value.schema_version !== 1 ||
		value.kind !== DELEGATION_LIFECYCLE_EVENT_KIND_V1 || !member(value.event, ["EXECUTE", "OBSERVE"] as const)) {
		return undefined;
	}
	if (value.event === "OBSERVE") {
		return value.expected_snapshot_hash === null
			? { schema_version: 1, kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1, event: "OBSERVE", expected_snapshot_hash: null }
			: undefined;
	}
	return typeof value.expected_snapshot_hash === "string" && HASH_RE.test(value.expected_snapshot_hash)
		? { schema_version: 1, kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1, event: "EXECUTE", expected_snapshot_hash: value.expected_snapshot_hash }
		: undefined;
}

function assertNever(value: never): never {
	throw new Error(`unreachable lifecycle union member: ${String(value)}`);
}

interface ActionFlags {
	readonly safe: boolean;
	readonly user: boolean;
	readonly expected: DelegationLifecycleStateV1;
	readonly recovery: DelegationLifecycleRecoveryEffectV1;
}

function actionFlags(action: DelegationLifecyclePrimaryActionNameV1): ActionFlags {
	switch (action) {
		case "CONTINUE_DEVELOPMENT": return { safe: true, user: false, expected: "TERMINAL_NON_BLOCKING", recovery: "NONE" };
		case "WAIT_FOR_ACTIVE_WRITER": return { safe: true, user: false, expected: "ACTIVE", recovery: "NONE" };
		case "REVIEW_CANDIDATE": return { safe: false, user: false, expected: "AWAITING_REVIEW", recovery: "NONE" };
		case "EXECUTE_EXACT_REPAIR": return { safe: false, user: false, expected: "REPAIRABLE", recovery: "MAY_CREATE_DELTA" };
		case "CLOSE_SATISFIED_NO_DELTA": return { safe: true, user: false, expected: "TERMINAL_NON_BLOCKING", recovery: "MUST_DECREASE_RANK" };
		case "SUPERSEDE_EMPTY_ATTEMPT": return { safe: true, user: false, expected: "TERMINAL_NON_BLOCKING", recovery: "MUST_DECREASE_RANK" };
		case "CLOSE_ACCEPTED_OBLIGATION": return { safe: true, user: false, expected: "TERMINAL_NON_BLOCKING", recovery: "MUST_DECREASE_RANK" };
		case "REGENERATE_DERIVED_REVIEW": return { safe: true, user: false, expected: "AWAITING_REVIEW", recovery: "NONE" };
		case "QUARANTINE_CORRUPT_AUTHORITY": return { safe: false, user: true, expected: "TERMINAL_NON_BLOCKING", recovery: "MUST_DECREASE_RANK" };
		case "REBASE_CURRENT_BINDING": return { safe: true, user: false, expected: "TERMINAL_NON_BLOCKING", recovery: "NONE" };
		case "BLOCK_OVERLAPPING_PATHS": return { safe: true, user: false, expected: "BINDING_CONFLICT", recovery: "NONE" };
		case "RECLAIM_STALE_LOCK": return { safe: true, user: false, expected: "TERMINAL_NON_BLOCKING", recovery: "NONE" };
		case "PROMOTE_CANDIDATE": return { safe: false, user: true, expected: "PROMOTION_READY", recovery: "NONE" };
		case "BLOCK_PROMOTION": return { safe: true, user: false, expected: "PROMOTION_BLOCKED", recovery: "NONE" };
		case "REPORT_STORAGE_FAILURE": return { safe: true, user: false, expected: "CORRUPT_AUTHORITY", recovery: "NONE" };
		default: return assertNever(action);
	}
}

function makeResolution(
	state: DelegationLifecycleStateV1,
	actionName: DelegationLifecyclePrimaryActionNameV1,
	reason: DelegationLifecycleReasonV1,
	snapshotHash: string,
	target: DelegationLifecycleTargetV1,
	affectedPaths: readonly string[],
	scopeUnknown: boolean,
	expectedRecoveryRank: DelegationLifecycleRecoveryRankV1 | null,
	override?: Partial<ActionFlags>,
): DelegationLifecycleResolutionV1 {
	const flags = { ...actionFlags(actionName), ...override };
	const primaryAction: DelegationLifecyclePrimaryActionV1 = {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_ACTION_KIND_V1,
		action: actionName,
		reason,
		snapshot_hash: snapshotHash,
		exact_target: { ...target },
		affected_paths: [...affectedPaths],
		scope_unknown: scopeUnknown,
		safe_automatic: flags.safe,
		requires_user_authorization: flags.user,
		expected_state: flags.expected,
		recovery_effect: flags.recovery,
		expected_recovery_rank: expectedRecoveryRank === null ? null : { ...expectedRecoveryRank },
	};
	const projection = {
		schema_version: DELEGATION_LIFECYCLE_SCHEMA_VERSION_V1,
		kind: DELEGATION_LIFECYCLE_RESOLUTION_KIND_V1,
		state,
		primary_action: primaryAction,
	};
	return { ...projection, resolution_hash: canonicalHash(projection) };
}

function invalidResolution(reason: "INVALID_EVENT" | "INVALID_SNAPSHOT"): DelegationLifecycleResolutionV1 {
	return makeResolution(
		"CORRUPT_AUTHORITY",
		reason === "INVALID_EVENT" ? "REPORT_STORAGE_FAILURE" : "QUARANTINE_CORRUPT_AUTHORITY",
		reason,
		INVALID_SNAPSHOT_HASH,
		{ kind: "PROJECT_AUTHORITY", id: "project-authority" },
		[],
		true,
		null,
	);
}

function resolveAttempt(
	snapshot: DelegationLifecycleSnapshotV1,
	snapshotHash: string,
): DelegationLifecycleResolutionV1 | undefined {
	const args = [snapshotHash, snapshot.target, snapshot.affected_paths, snapshot.scope_unknown, snapshot.recovery_rank] as const;
	switch (snapshot.attempt) {
		case "ACTIVE":
			return makeResolution("ACTIVE", "WAIT_FOR_ACTIVE_WRITER", "ACTIVE_WRITER_PRESENT", ...args);
		case "AWAITING_REVIEW":
			return makeResolution(
				"AWAITING_REVIEW", "REVIEW_CANDIDATE", "CURRENT_DELTA_REVIEW_REQUIRED", ...args,
				snapshot.runtime_identity === "CURRENT" ? { safe: true } : undefined,
			);
		case "REPAIRABLE":
			return makeResolution(
				"REPAIRABLE", "EXECUTE_EXACT_REPAIR", "EXACT_REPAIR_DECISION_CURRENT", ...args,
				snapshot.runtime_identity === "CURRENT" ? { safe: true } : undefined,
			);
		case "SATISFIED_NO_DELTA":
			return makeResolution("SATISFIED_NO_DELTA", "CLOSE_SATISFIED_NO_DELTA", "SATISFIED_WITHOUT_NEW_DELTA", ...args);
		case "SUPERSEDED":
			return makeResolution("SUPERSEDED", "SUPERSEDE_EMPTY_ATTEMPT", "EMPTY_ATTEMPT_SUPERSEDED", ...args);
		case "ACCEPTED":
			return makeResolution("ACCEPTED", "CLOSE_ACCEPTED_OBLIGATION", "ACCEPTED_SUCCESSOR_PRESENT", ...args);
		case "NONE":
		case "TERMINAL":
			return undefined;
		default:
			return assertNever(snapshot.attempt);
	}
}

function resolveCandidate(
	snapshot: DelegationLifecycleSnapshotV1,
	snapshotHash: string,
): DelegationLifecycleResolutionV1 {
	const args = [snapshotHash, snapshot.target, snapshot.affected_paths, snapshot.scope_unknown, snapshot.recovery_rank] as const;
	if (snapshot.operation_intent === "DEV") {
		return makeResolution("TERMINAL_NON_BLOCKING", "CONTINUE_DEVELOPMENT", "NO_CURRENT_BLOCKER", ...args);
	}
	if (snapshot.runtime_identity === "STALE" || snapshot.runtime_identity === "UNKNOWN") {
		return makeResolution("PROMOTION_BLOCKED", "BLOCK_PROMOTION", "RUNTIME_IDENTITY_STALE", ...args);
	}
	switch (snapshot.candidate) {
		case "READY":
			return makeResolution("PROMOTION_READY", "PROMOTE_CANDIDATE", "CANDIDATE_PROMOTION_READY", ...args);
		case "BLOCKED":
		case "INCOMPLETE":
		case "NONE":
			return makeResolution("PROMOTION_BLOCKED", "BLOCK_PROMOTION", "CANDIDATE_PROMOTION_REQUIREMENTS_MISSING", ...args);
		default:
			return assertNever(snapshot.candidate);
	}
}

/**
	* Resolve exactly one primary action. Unknown, malformed, or cyclic input is
	* collapsed into a bounded named fail-closed result and never escapes.
	*/
export function resolveDelegationLifecycleV1(
	snapshotInput: unknown,
	eventInput: unknown,
): DelegationLifecycleResolutionV1 {
	try {
		const snapshot = parseSnapshot(snapshotInput);
		if (snapshot === undefined) return invalidResolution("INVALID_SNAPSHOT");
		const event = parseEvent(eventInput);
		if (event === undefined) return invalidResolution("INVALID_EVENT");
		const snapshotHash = canonicalHash(snapshot);
		const args = [snapshotHash, snapshot.target, snapshot.affected_paths, snapshot.scope_unknown, snapshot.recovery_rank] as const;
		if (event.event === "EXECUTE" && event.expected_snapshot_hash !== snapshotHash) {
			return makeResolution("BINDING_CONFLICT", "REBASE_CURRENT_BINDING", "SNAPSHOT_CHANGED", ...args);
		}
		if (snapshot.writer_lock === "LIVE") {
			return makeResolution("ACTIVE", "WAIT_FOR_ACTIVE_WRITER", "ACTIVE_WRITER_PRESENT", ...args);
		}
		switch (snapshot.authority.health) {
			case "STORAGE_FAILURE":
				return makeResolution("CORRUPT_AUTHORITY", "REPORT_STORAGE_FAILURE", "STORAGE_READ_FAILED", ...args);
			case "CORRUPT":
				return makeResolution(
					"CORRUPT_AUTHORITY",
					"QUARANTINE_CORRUPT_AUTHORITY",
					"UNDERLYING_AUTHORITY_CORRUPT",
					...args,
					snapshot.authority.disposition === "INACTIVE"
						? { safe: true, user: false, expected: "TERMINAL_NON_BLOCKING" }
						: undefined,
				);
			case "DERIVED_INVALID":
				return makeResolution("INVALID_DERIVED_EVIDENCE", "REGENERATE_DERIVED_REVIEW", "DERIVED_REVIEW_INVALID", ...args);
			case "VALID":
				break;
			default:
				return assertNever(snapshot.authority.health);
		}
		if (snapshot.writer_lock === "STALE") {
			return makeResolution("TERMINAL_NON_BLOCKING", "RECLAIM_STALE_LOCK", "STALE_WRITER_LOCK", ...args);
		}
		if (!snapshot.request_valid) {
			return makeResolution("BINDING_CONFLICT", "BLOCK_OVERLAPPING_PATHS", "INVALID_PATH_REQUEST", ...args);
		}
		switch (snapshot.binding) {
			case "OVERLAPPING":
				return makeResolution("BINDING_CONFLICT", "BLOCK_OVERLAPPING_PATHS", "OVERLAPPING_PATHS", ...args);
			case "REBASEABLE":
				return makeResolution("BINDING_CONFLICT", "REBASE_CURRENT_BINDING", "REBASEABLE_BINDING_CHANGED", ...args);
			case "CURRENT":
				break;
			default:
				return assertNever(snapshot.binding);
		}
		const attempt = resolveAttempt(snapshot, snapshotHash);
		return attempt ?? resolveCandidate(snapshot, snapshotHash);
	} catch {
		return invalidResolution("INVALID_SNAPSHOT");
	}
}

export function delegationLifecycleSnapshotHashV1(snapshot: DelegationLifecycleSnapshotV1): string {
	const parsed = parseSnapshot(snapshot);
	return parsed === undefined ? INVALID_SNAPSHOT_HASH : canonicalHash(parsed);
}

// ---------------------------------------------------------------------------
// Long-chain optimization: one hash-bound action projection for every UI,
// tool-surface, context-entry, and automatic-executor consumer.
// ---------------------------------------------------------------------------

export const LIFECYCLE_ACTION_SNAPSHOT_SCHEMA_VERSION_V2 = 2 as const;
export const LIFECYCLE_ACTION_SNAPSHOT_KIND_V2 = "lifecycle-action-snapshot-v2" as const;
export const LIFECYCLE_ACTION_SNAPSHOT_ENTRY_TYPE_V2 = "workbench-lifecycle-action-snapshot-v2" as const;
export const LIFECYCLE_ACTION_SNAPSHOT_MAX_BYTES_V2 = 2 * 1024;

export type LifecycleActionNameV2 =
	| "NONE"
	| "CONTINUE_DIRECT_DEVELOPMENT"
	| "START_DELEGATION"
	| "CONTINUE_CHECKPOINT"
	| "REVIEW_CANDIDATE"
	| "RETRY_REVIEW_JOB"
	| "START_EXACT_REPAIR"
	| "PAUSED_BUDGET"
	| "PROMOTE_CANDIDATE"
	| "RUN_GATE"
	| "RECOVER_AUTHORITY";

export interface LifecycleActionExactTargetV2 {
	readonly delegation_id?: string;
	readonly generation?: number;
	readonly review_job_id?: string;
	readonly repair_of?: string;
	readonly candidate_id?: string;
	readonly bound_hash?: string;
}

export interface LifecycleActionSnapshotV2 {
	readonly schema_version: typeof LIFECYCLE_ACTION_SNAPSHOT_SCHEMA_VERSION_V2;
	readonly kind: typeof LIFECYCLE_ACTION_SNAPSHOT_KIND_V2;
	readonly project_root_hash: string;
	readonly mode: "AUDIT" | "DEV" | "VERIFY";
	readonly authority_hash: string;
	readonly state: string;
	readonly action: LifecycleActionNameV2;
	readonly exact_target: Readonly<LifecycleActionExactTargetV2>;
	readonly tool: string | null;
	readonly arguments: Readonly<Record<string, unknown>> | null;
	readonly safe_automatic: boolean;
	readonly authorization: "NONE" | "EXISTING" | "USER_REQUIRED";
	readonly retryable: boolean;
	readonly reason_code: string;
	readonly invalidation_conditions: readonly string[];
	readonly snapshot_hash: string;
}

export interface BuildLifecycleActionSnapshotV2Input {
	readonly project_root: string;
	readonly mode: "AUDIT" | "DEV" | "VERIFY";
	readonly resolution: Readonly<DelegationLifecycleResolutionV1>;
	/** When present, the execution checkpoint overrides the older ACTIVE label. */
	readonly checkpoint?: Readonly<WorkerCheckpointV1>;
}

const LIFECYCLE_ACTIONS_V2: readonly LifecycleActionNameV2[] = [
	"NONE", "CONTINUE_DIRECT_DEVELOPMENT", "START_DELEGATION", "CONTINUE_CHECKPOINT", "REVIEW_CANDIDATE",
	"RETRY_REVIEW_JOB", "START_EXACT_REPAIR", "PAUSED_BUDGET", "PROMOTE_CANDIDATE", "RUN_GATE", "RECOVER_AUTHORITY",
];
const SNAPSHOT_V2_FIELDS = [
	"schema_version", "kind", "project_root_hash", "mode", "authority_hash", "state", "action", "exact_target",
	"tool", "arguments", "safe_automatic", "authorization", "retryable", "reason_code", "invalidation_conditions",
	"snapshot_hash",
] as const;
const EXACT_TARGET_V2_FIELDS = ["delegation_id", "generation", "review_job_id", "repair_of", "candidate_id", "bound_hash"] as const;
const INVALIDATION_CONDITIONS_V2 = Object.freeze([
	"authority_hash_changed",
	"exact_target_changed",
	"mode_changed",
	"owner_or_lock_changed",
	"runtime_identity_changed",
]);

function validBoundedAtom(value: unknown, maximum = 160): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum
		&& !/[\u0000-\u001f\u007f]/u.test(value);
}

function validExactTargetV2(value: unknown): value is LifecycleActionExactTargetV2 {
	if (!isRecord(value) || Object.keys(value).some((field) => !EXACT_TARGET_V2_FIELDS.includes(field as never))) return false;
	if (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || Number(value.generation) < 1)) return false;
	for (const field of ["delegation_id", "review_job_id", "repair_of", "candidate_id"] as const) {
		if (value[field] !== undefined && !validBoundedAtom(value[field], 160)) return false;
	}
	return value.bound_hash === undefined || typeof value.bound_hash === "string" && HASH_RE.test(value.bound_hash);
}

function snapshotV2Projection(value: Omit<LifecycleActionSnapshotV2, "snapshot_hash">): unknown {
	return value;
}

export function computeLifecycleActionSnapshotHashV2(
	value: Omit<LifecycleActionSnapshotV2, "snapshot_hash">,
): string {
	return canonicalHash(snapshotV2Projection(value));
}

export function validateLifecycleActionSnapshotV2(value: unknown): value is LifecycleActionSnapshotV2 {
	if (!isRecord(value) || !exactFields(value, SNAPSHOT_V2_FIELDS)
		|| value.schema_version !== LIFECYCLE_ACTION_SNAPSHOT_SCHEMA_VERSION_V2
		|| value.kind !== LIFECYCLE_ACTION_SNAPSHOT_KIND_V2
		|| typeof value.project_root_hash !== "string" || !HASH_RE.test(value.project_root_hash)
		|| (value.mode !== "AUDIT" && value.mode !== "DEV" && value.mode !== "VERIFY")
		|| typeof value.authority_hash !== "string" || !HASH_RE.test(value.authority_hash)
		|| !validBoundedAtom(value.state, 160) || !member(value.action, LIFECYCLE_ACTIONS_V2)
		|| !validExactTargetV2(value.exact_target)
		|| !(value.tool === null || validBoundedAtom(value.tool, 160))
		|| !(value.arguments === null || isRecord(value.arguments))
		|| typeof value.safe_automatic !== "boolean"
		|| (value.authorization !== "NONE" && value.authorization !== "EXISTING" && value.authorization !== "USER_REQUIRED")
		|| typeof value.retryable !== "boolean" || !validBoundedAtom(value.reason_code, 160)
		|| !Array.isArray(value.invalidation_conditions) || value.invalidation_conditions.length > 16
		|| !value.invalidation_conditions.every((condition) => validBoundedAtom(condition, 160))
		|| typeof value.snapshot_hash !== "string" || !HASH_RE.test(value.snapshot_hash)) return false;
	try {
		if (Buffer.byteLength(canonicalJson(value.arguments), "utf8") > 1_024) return false;
		const { snapshot_hash: supplied, ...payload } = value;
		return supplied === computeLifecycleActionSnapshotHashV2(payload as Omit<LifecycleActionSnapshotV2, "snapshot_hash">)
			&& Buffer.byteLength(canonicalJson(value), "utf8") <= LIFECYCLE_ACTION_SNAPSHOT_MAX_BYTES_V2;
	} catch {
		return false;
	}
}

interface SnapshotActionProjectionV2 {
	action: LifecycleActionNameV2;
	exact_target: LifecycleActionExactTargetV2;
	tool: string | null;
	arguments: Record<string, unknown> | null;
	safe_automatic: boolean;
	authorization: LifecycleActionSnapshotV2["authorization"];
	retryable: boolean;
}

function actionProjectionV2(resolution: Readonly<DelegationLifecycleResolutionV1>): SnapshotActionProjectionV2 {
	const action = resolution.primary_action;
	const id = action.exact_target.id;
	switch (action.action) {
		case "CONTINUE_DEVELOPMENT":
		case "CLOSE_SATISFIED_NO_DELTA":
		case "SUPERSEDE_EMPTY_ATTEMPT":
		case "CLOSE_ACCEPTED_OBLIGATION":
			return { action: "CONTINUE_DIRECT_DEVELOPMENT", exact_target: {}, tool: null, arguments: null,
				safe_automatic: action.safe_automatic, authorization: "NONE", retryable: false };
		case "WAIT_FOR_ACTIVE_WRITER":
		case "BLOCK_OVERLAPPING_PATHS":
		case "BLOCK_PROMOTION":
			return { action: "NONE", exact_target: action.exact_target.kind === "DELEGATION" ? { delegation_id: id } : {},
				tool: "workbench_delegation_status", arguments: {}, safe_automatic: false, authorization: "NONE", retryable: true };
		case "REVIEW_CANDIDATE":
			return { action: "REVIEW_CANDIDATE", exact_target: { delegation_id: id }, tool: "workbench_review_worker_diff",
				arguments: { delegation_id: id }, safe_automatic: action.safe_automatic, authorization: "EXISTING", retryable: true };
		case "REGENERATE_DERIVED_REVIEW":
			return { action: "RETRY_REVIEW_JOB", exact_target: { delegation_id: id }, tool: "workbench_review_worker_diff",
				arguments: { delegation_id: id }, safe_automatic: action.safe_automatic, authorization: "EXISTING", retryable: true };
		case "EXECUTE_EXACT_REPAIR":
			return { action: "START_EXACT_REPAIR", exact_target: { delegation_id: id, repair_of: id },
				tool: "workbench_repair_delegation", arguments: { delegation_id: id }, safe_automatic: action.safe_automatic,
				authorization: "EXISTING", retryable: true };
		case "PROMOTE_CANDIDATE":
			return { action: "PROMOTE_CANDIDATE", exact_target: { candidate_id: id }, tool: null, arguments: null,
				safe_automatic: false, authorization: "USER_REQUIRED", retryable: false };
		case "QUARANTINE_CORRUPT_AUTHORITY":
		case "REPORT_STORAGE_FAILURE":
		case "RECLAIM_STALE_LOCK":
			return { action: "RECOVER_AUTHORITY", exact_target: action.exact_target.kind === "DELEGATION" ? { delegation_id: id } : {},
				tool: "workbench_delegation_status", arguments: {}, safe_automatic: action.safe_automatic,
				authorization: action.requires_user_authorization ? "USER_REQUIRED" : "EXISTING", retryable: true };
		case "REBASE_CURRENT_BINDING":
			// A finalized immutable slice cannot be rebound in place.  Expose the
			// existing guarded successor lane so the commander can continue from
			// the current workspace baseline instead of polling status forever.
			return { action: "START_DELEGATION", exact_target: { delegation_id: id },
				tool: "workbench_delegate_worker", arguments: null, safe_automatic: false,
				authorization: "EXISTING", retryable: true };
		default:
			return assertNever(action.action);
	}
}

/** Build the only primary-action projection from one already-canonical V1 resolution. */
export function buildLifecycleActionSnapshotV2(
	input: Readonly<BuildLifecycleActionSnapshotV2Input>,
): { readonly ok: true; readonly value: Readonly<LifecycleActionSnapshotV2> } | { readonly ok: false; readonly code: "INVALID_INPUT" } {
	try {
		if (!isAbsolute(input.project_root) || !member(input.mode, ["AUDIT", "DEV", "VERIFY"] as const)
			|| canonicalHash({
				schema_version: input.resolution.schema_version,
				kind: input.resolution.kind,
				state: input.resolution.state,
				primary_action: input.resolution.primary_action,
			}) !== input.resolution.resolution_hash
			|| (input.checkpoint !== undefined && !validateWorkerCheckpointV1(input.checkpoint))) {
			return { ok: false, code: "INVALID_INPUT" };
		}
		const checkpoint = input.checkpoint;
		const projected = checkpoint === undefined ? actionProjectionV2(input.resolution) : checkpoint.machine_state === "PAUSED_BUDGET"
			? {
				action: "PAUSED_BUDGET" as const,
				exact_target: { delegation_id: checkpoint.delegation_id, bound_hash: checkpoint.checkpoint_hash },
				tool: null,
				arguments: null,
				safe_automatic: false,
				authorization: "USER_REQUIRED" as const,
				retryable: false,
			}
			: {
				action: "CONTINUE_CHECKPOINT" as const,
				exact_target: { delegation_id: checkpoint.delegation_id, bound_hash: checkpoint.checkpoint_hash },
				tool: "workbench_repair_delegation",
				arguments: { delegation_id: checkpoint.delegation_id },
				safe_automatic: true,
				authorization: "EXISTING" as const,
				retryable: true,
			};
		const payload: Omit<LifecycleActionSnapshotV2, "snapshot_hash"> = {
			schema_version: LIFECYCLE_ACTION_SNAPSHOT_SCHEMA_VERSION_V2,
			kind: LIFECYCLE_ACTION_SNAPSHOT_KIND_V2,
			project_root_hash: canonicalHash({ project_root: input.project_root }),
			mode: input.mode,
			authority_hash: checkpoint?.checkpoint_hash ?? input.resolution.primary_action.snapshot_hash,
			state: checkpoint?.machine_state ?? input.resolution.state,
			...projected,
			reason_code: checkpoint?.machine_state === "PAUSED_BUDGET"
				? checkpoint.remaining_budget.profile === "standard"
					? "PAUSED_BUDGET_STANDARD_PROMOTION_AVAILABLE"
					: "PAUSED_BUDGET_EXTENDED_SPLIT_REQUIRED"
				: checkpoint?.machine_state ?? input.resolution.primary_action.reason,
			invalidation_conditions: [...INVALIDATION_CONDITIONS_V2],
		};
		const value = { ...payload, snapshot_hash: computeLifecycleActionSnapshotHashV2(payload) };
		return validateLifecycleActionSnapshotV2(value)
			? { ok: true, value: Object.freeze(structuredClone(value)) }
			: { ok: false, code: "INVALID_INPUT" };
	} catch {
		return { ok: false, code: "INVALID_INPUT" };
	}
}

/** Executor guard: stale authority/action/target is rejected and never re-routed. */
export function validateLifecycleActionExecutionV2(
	snapshot: unknown,
	input: Readonly<{
		project_root_hash: string;
		mode: "AUDIT" | "DEV" | "VERIFY";
		authority_hash: string;
		action: LifecycleActionNameV2;
		exact_target: Readonly<LifecycleActionExactTargetV2>;
	}>,
): snapshot is LifecycleActionSnapshotV2 {
	return validateLifecycleActionSnapshotV2(snapshot)
		&& snapshot.project_root_hash === input.project_root_hash
		&& snapshot.mode === input.mode
		&& snapshot.authority_hash === input.authority_hash
		&& snapshot.action === input.action
		&& canonicalHash(snapshot.exact_target) === canonicalHash(input.exact_target);
}

export interface LifecycleActionSnapshotAppendResultV2 {
	readonly appended: boolean;
	readonly latest_snapshot_hash: string;
}

/** Append one bounded context entry iff its machine snapshot hash changed. */
export function appendLifecycleActionSnapshotIfChangedV2(
	snapshot: unknown,
	latestSnapshotHash: string | null,
	appendEntry: (customType: string, data: unknown) => void,
): LifecycleActionSnapshotAppendResultV2 | undefined {
	if (!validateLifecycleActionSnapshotV2(snapshot)) return undefined;
	if (snapshot.snapshot_hash === latestSnapshotHash) {
		return { appended: false, latest_snapshot_hash: snapshot.snapshot_hash };
	}
	try {
		appendEntry(LIFECYCLE_ACTION_SNAPSHOT_ENTRY_TYPE_V2, structuredClone(snapshot));
		return { appended: true, latest_snapshot_hash: snapshot.snapshot_hash };
	} catch {
		return undefined;
	}
}

export type ParseDelegationLifecycleSnapshotResultV1 =
	| { readonly ok: true; readonly value: DelegationLifecycleSnapshotV1 }
	| { readonly ok: false; readonly code: "INVALID_SNAPSHOT" };

/** Closed runtime parser shared by read adapters and the effect boundary. */
export function parseDelegationLifecycleSnapshotV1(value: unknown): ParseDelegationLifecycleSnapshotResultV1 {
	try {
		const parsed = parseSnapshot(value);
		return parsed === undefined ? { ok: false, code: "INVALID_SNAPSHOT" } : { ok: true, value: parsed };
	} catch {
		return { ok: false, code: "INVALID_SNAPSHOT" };
	}
}

export function serializeDelegationLifecycleResolutionV1(resolution: DelegationLifecycleResolutionV1): string {
	return canonicalJson(resolution);
}

export interface DelegationLifecycleCompatibilityProjectionV1 {
	readonly source_authority: unknown;
	readonly operation_intent?: DelegationLifecycleOperationIntentV1;
	readonly authority_health: DelegationLifecycleAuthorityHealthV1;
	readonly authority_disposition: DelegationLifecycleAuthorityDispositionV1;
	readonly writer_lock?: DelegationLifecycleWriterLockV1;
	readonly binding: DelegationLifecycleBindingV1;
	readonly attempt: DelegationLifecycleAttemptV1;
	readonly candidate?: DelegationLifecycleCandidateV1;
	readonly runtime_identity?: DelegationLifecycleRuntimeIdentityV1;
	readonly request_valid?: boolean;
	readonly target: DelegationLifecycleTargetV1;
	readonly affected_paths?: readonly string[];
	readonly scope_unknown?: boolean;
	readonly recovery_rank: DelegationLifecycleRecoveryRankV1 | null;
}

/**
	* Normalize a historical read-model projection into the canonical resolver
	* input. Compatibility callers may preserve old labels, but they do not get
	* to classify a lifecycle action independently.
	*/
export function delegationLifecycleSnapshotFromCompatibilityProjectionV1(
	input: DelegationLifecycleCompatibilityProjectionV1,
): DelegationLifecycleSnapshotV1 {
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: canonicalHash({
			kind: "delegation-lifecycle-compatibility-source-v1",
			authority: input.source_authority,
		}),
		operation_intent: input.operation_intent ?? "DEV",
		authority: {
			health: input.authority_health,
			disposition: input.authority_disposition,
		},
		writer_lock: input.writer_lock ?? "ABSENT",
		binding: input.binding,
		attempt: input.attempt,
		candidate: input.candidate ?? "NONE",
		runtime_identity: input.runtime_identity ?? "NOT_REQUIRED",
		request_valid: input.request_valid ?? true,
		target: { ...input.target },
		affected_paths: [...(input.affected_paths ?? [])],
		scope_unknown: input.scope_unknown ?? false,
		recovery_rank: input.recovery_rank === null ? null : { ...input.recovery_rank },
	};
}

/**
	* Read-only compatibility adapter for the existing project path-lane reader.
	* It creates no files and grants no new authority; production wiring remains
	* unchanged while tests compare old-reader classification with the resolver.
	*/
export function delegationLifecycleSnapshotFromPathLaneAdmissionV1(
	admission: DelegationPathLaneAdmissionV1,
	operationIntent: DelegationLifecycleOperationIntentV1 = "DEV",
): DelegationLifecycleSnapshotV1 {
	const storageFailure = admission.decision.authority_failures.some((failure) => failure.reason === "STORAGE_FAILURE");
	const authorityFailure = admission.decision.authority_failures.length > 0;
	const invalidRequest = admission.decision.block_reasons.includes("INVALID_REQUEST");
	const conflict = admission.decision.conflicts[0];
	const failure = admission.decision.authority_failures[0];
	const exactId = failure?.delegation_id ?? conflict?.delegation_id ?? admission.repair_tip_ids[0] ??
		admission.ordinary_blocker_ids[0] ?? "project-authority";
	const unresolvedObligations = new Set([
		...admission.ordinary_blocker_ids,
		...admission.repair_tip_ids,
	]).size;
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: admission.authority_hash,
		operation_intent: operationIntent,
		authority: {
			health: storageFailure ? "STORAGE_FAILURE" : authorityFailure ? "CORRUPT" : "VALID",
			disposition: authorityFailure ? "UNKNOWN" : "INACTIVE",
		},
		writer_lock: "ABSENT",
		binding: conflict === undefined ? "CURRENT" : "OVERLAPPING",
		attempt: "TERMINAL",
		candidate: "NONE",
		runtime_identity: "NOT_REQUIRED",
		request_valid: !invalidRequest,
		target: {
			kind: exactId === "project-authority" ? "PROJECT_AUTHORITY" : "DELEGATION",
			id: exactId,
		},
		affected_paths: [...admission.decision.normalized_allowed_paths],
		scope_unknown: authorityFailure || invalidRequest,
		recovery_rank: authorityFailure
			? null
			: {
				unresolved_obligations: unresolvedObligations,
				unresolved_attempts: Math.max(unresolvedObligations, admission.blockers.length),
			},
	};
}

/** Normalize a readable transaction with only replaceable derived-review damage. */
export function delegationLifecycleSnapshotFromInvalidDerivedReviewV1(
	delegationId: string,
	sourceAuthority: unknown,
): DelegationLifecycleSnapshotV1 {
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: canonicalHash({
			kind: "delegation-derived-review-source-v1",
			state: sourceAuthority,
		}),
		operation_intent: "DEV",
		authority: { health: "DERIVED_INVALID", disposition: "INACTIVE" },
		writer_lock: "ABSENT",
		binding: "CURRENT",
		attempt: "AWAITING_REVIEW",
		candidate: "NONE",
		runtime_identity: "NOT_REQUIRED",
		request_valid: true,
		target: { kind: "DELEGATION", id: delegationId },
		affected_paths: [],
		scope_unknown: false,
		recovery_rank: { unresolved_obligations: 0, unresolved_attempts: 0 },
	};
}

/** Normalize one already-strict exact-repair command authority for public routing. */
export function delegationLifecycleSnapshotFromExactRepairAuthorityV1(input: {
	repair_of: string;
	source_authority: unknown;
	affected_paths: readonly string[];
	binding?: "CURRENT" | "REBASEABLE";
}): DelegationLifecycleSnapshotV1 {
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: canonicalHash({
			kind: "delegation-exact-repair-source-v1",
			authority: input.source_authority,
		}),
		operation_intent: "DEV",
		authority: { health: "VALID", disposition: "INACTIVE" },
		writer_lock: "ABSENT",
		binding: input.binding ?? "CURRENT",
		attempt: "REPAIRABLE",
		candidate: "NONE",
		runtime_identity: "NOT_REQUIRED",
		request_valid: true,
		target: { kind: "DELEGATION", id: input.repair_of },
		affected_paths: [...input.affected_paths],
		scope_unknown: false,
		recovery_rank: { unresolved_obligations: 1, unresolved_attempts: 1 },
	};
}

/** Normalize the strict-clean compatibility closure without persisting shadow state. */
export function delegationLifecycleSnapshotFromCleanRepairClosureV1(input: {
	delegation_id: string;
	source_authority: unknown;
	workspace_clean: boolean;
	closed: boolean;
}): DelegationLifecycleSnapshotV1 {
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: canonicalHash({
			kind: "delegation-clean-repair-closure-source-v1",
			authority: input.source_authority,
		}),
		operation_intent: "DEV",
		authority: { health: "VALID", disposition: "INACTIVE" },
		writer_lock: "ABSENT",
		binding: input.closed || input.workspace_clean ? "CURRENT" : "REBASEABLE",
		attempt: input.closed ? "TERMINAL" : "SATISFIED_NO_DELTA",
		candidate: "NONE",
		runtime_identity: "NOT_REQUIRED",
		request_valid: true,
		target: { kind: "DELEGATION", id: input.delegation_id },
		affected_paths: [],
		scope_unknown: false,
		recovery_rank: input.closed
			? { unresolved_obligations: 0, unresolved_attempts: 0 }
			: { unresolved_obligations: 1, unresolved_attempts: 1 },
	};
}

/** Normalize one exact inactive blocker without persisting shadow authority. */
export function delegationLifecycleSnapshotFromInactiveBlockerClosureV1(input: {
	delegation_id: string;
	source_authority: unknown;
	affected_paths: readonly string[];
	relevant_paths_clean: boolean;
	execution_active: boolean;
	empty_attempt: boolean;
	closed: boolean;
	scope_unknown?: boolean;
}): DelegationLifecycleSnapshotV1 {
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: canonicalHash({
			kind: "delegation-inactive-blocker-closure-source-v1",
			authority: input.source_authority,
		}),
		operation_intent: "DEV",
		authority: { health: "VALID", disposition: input.execution_active ? "ACTIVE" : "INACTIVE" },
		writer_lock: "ABSENT",
		binding: input.closed || input.relevant_paths_clean ? "CURRENT" : "REBASEABLE",
		attempt: input.closed ? "TERMINAL"
			: input.execution_active ? "ACTIVE"
				: input.empty_attempt ? "SUPERSEDED" : "SATISFIED_NO_DELTA",
		candidate: "NONE",
		runtime_identity: "NOT_REQUIRED",
		request_valid: true,
		target: { kind: "DELEGATION", id: input.delegation_id },
		affected_paths: [...input.affected_paths],
		scope_unknown: input.scope_unknown ?? false,
		recovery_rank: input.closed
			? { unresolved_obligations: 0, unresolved_attempts: 0 }
			: { unresolved_obligations: 1, unresolved_attempts: 1 },
	};
}

/** Normalize one strictly discovered automatic-continuation candidate. */
export function delegationLifecycleSnapshotFromAutomaticContinuationCandidateV1(input: {
	candidate: {
		delegation_id: string;
		authority_hash: string;
		durable_decision: "NEEDS_REVIEW" | "REPAIR";
		affected_paths: readonly string[];
	};
}): DelegationLifecycleSnapshotV1 {
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: canonicalHash({
			kind: "delegation-automatic-continuation-source-v1",
			candidate: input.candidate,
		}),
		operation_intent: "DEV",
		authority: { health: "VALID", disposition: "INACTIVE" },
		writer_lock: "ABSENT",
		binding: "CURRENT",
		attempt: input.candidate.durable_decision === "NEEDS_REVIEW" ? "AWAITING_REVIEW" : "REPAIRABLE",
		candidate: "NONE",
		runtime_identity: "CURRENT",
		request_valid: true,
		target: { kind: "DELEGATION", id: input.candidate.delegation_id },
		affected_paths: [...input.candidate.affected_paths],
		scope_unknown: false,
		recovery_rank: input.candidate.durable_decision === "REPAIR"
			? { unresolved_obligations: 1, unresolved_attempts: 1 }
			: { unresolved_obligations: 0, unresolved_attempts: 0 },
	};
}

/** Normalize one strict public-review candidate or immutable replay. */
export function delegationLifecycleSnapshotFromReviewCandidateV1(input: {
	delegation_id: string;
	source_authority: unknown;
	affected_paths: readonly string[];
	review_required: boolean;
}): DelegationLifecycleSnapshotV1 {
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: canonicalHash({
			kind: "delegation-review-candidate-source-v1",
			authority: input.source_authority,
		}),
		operation_intent: "DEV",
		authority: { health: "VALID", disposition: "INACTIVE" },
		writer_lock: "ABSENT",
		binding: "CURRENT",
		attempt: input.review_required ? "AWAITING_REVIEW" : "TERMINAL",
		candidate: "NONE",
		runtime_identity: "NOT_REQUIRED",
		request_valid: true,
		target: { kind: "DELEGATION", id: input.delegation_id },
		affected_paths: [...input.affected_paths],
		scope_unknown: false,
		recovery_rank: { unresolved_obligations: 0, unresolved_attempts: 0 },
	};
}
