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
			return makeResolution("AWAITING_REVIEW", "REVIEW_CANDIDATE", "CURRENT_DELTA_REVIEW_REQUIRED", ...args);
		case "REPAIRABLE":
			return makeResolution("REPAIRABLE", "EXECUTE_EXACT_REPAIR", "EXACT_REPAIR_DECISION_CURRENT", ...args);
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
