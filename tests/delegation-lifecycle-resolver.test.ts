import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	DELEGATION_LIFECYCLE_PRIMARY_ACTIONS_V1,
	DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
	delegationLifecycleSnapshotHashV1,
	delegationLifecycleSnapshotFromCleanRepairClosureV1,
	delegationLifecycleSnapshotFromExactRepairAuthorityV1,
	delegationLifecycleSnapshotFromInactiveBlockerClosureV1,
	delegationLifecycleSnapshotFromPathLaneAdmissionV1,
	resolveDelegationLifecycleV1,
	serializeDelegationLifecycleResolutionV1,
	type DelegationLifecycleEventV1,
	type DelegationLifecycleSnapshotV1,
} from "../extensions/workbench-runtime/core/delegation-lifecycle-resolver.ts";
import {
	DELEGATION_PATH_LANE_REQUEST_KIND_V1,
	decideDelegationPathLaneV1,
	type DelegationPathLaneBlockerV1,
} from "../extensions/workbench-runtime/core/delegation-path-lane.ts";
import type { DelegationPathLaneAdmissionV1 } from "../extensions/workbench-runtime/core/delegation-path-lane-admission.ts";

const HASH_A = "a".repeat(64);
const OBSERVE: DelegationLifecycleEventV1 = {
	schema_version: 1,
	kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	event: "OBSERVE",
	expected_snapshot_hash: null,
};

function snapshot(patch: Partial<DelegationLifecycleSnapshotV1> = {}): DelegationLifecycleSnapshotV1 {
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: HASH_A,
		operation_intent: "DEV",
		authority: { health: "VALID", disposition: "INACTIVE" },
		writer_lock: "ABSENT",
		binding: "CURRENT",
		attempt: "TERMINAL",
		candidate: "NONE",
		runtime_identity: "NOT_REQUIRED",
		request_valid: true,
		target: { kind: "DELEGATION", id: "20260828-100000-r001" },
		affected_paths: ["src/current.ts"],
		scope_unknown: false,
		recovery_rank: { unresolved_obligations: 0, unresolved_attempts: 0 },
		...patch,
	};
}

test("the exact-repair adapter yields the same canonical action and a binding change yields one rebase action", () => {
	const authority = {
		kind: "exact-repair-command-execution-v1",
		repair_of: "20260828-100000-r001",
		idempotency_key: "b".repeat(64),
	};
	const current = delegationLifecycleSnapshotFromExactRepairAuthorityV1({
		repair_of: "20260828-100000-r001",
		source_authority: authority,
		affected_paths: ["src/current.ts"],
	});
	const repair = resolveDelegationLifecycleV1(current, OBSERVE);
	assert.equal(repair.primary_action.action, "EXECUTE_EXACT_REPAIR");
	assert.equal(repair.primary_action.reason, "EXACT_REPAIR_DECISION_CURRENT");
	assert.deepEqual(repair.primary_action.affected_paths, ["src/current.ts"]);
	const rebased = resolveDelegationLifecycleV1(
		delegationLifecycleSnapshotFromExactRepairAuthorityV1({
			repair_of: "20260828-100000-r001",
			source_authority: authority,
			affected_paths: ["src/current.ts"],
			binding: "REBASEABLE",
		}),
		OBSERVE,
	);
	assert.equal(rebased.primary_action.action, "REBASE_CURRENT_BINDING");
	assert.equal(rebased.primary_action.reason, "REBASEABLE_BINDING_CHANGED");
});

test("inactive blocker facts select one close, empty-attempt supersession, rebase, or terminal action", () => {
	const base = {
		delegation_id: "20260828-100000-r001",
		source_authority: { transaction_hash: HASH_A },
		affected_paths: ["src/current.ts"],
		relevant_paths_clean: true,
		execution_active: false,
		empty_attempt: false,
		closed: false,
	};
	assert.equal(
		resolveDelegationLifecycleV1(delegationLifecycleSnapshotFromInactiveBlockerClosureV1(base), OBSERVE)
			.primary_action.action,
		"CLOSE_SATISFIED_NO_DELTA",
	);
	assert.equal(
		resolveDelegationLifecycleV1(
			delegationLifecycleSnapshotFromInactiveBlockerClosureV1({ ...base, empty_attempt: true }),
			OBSERVE,
		).primary_action.action,
		"SUPERSEDE_EMPTY_ATTEMPT",
	);
	assert.equal(
		resolveDelegationLifecycleV1(
			delegationLifecycleSnapshotFromInactiveBlockerClosureV1({ ...base, relevant_paths_clean: false }),
			OBSERVE,
		).primary_action.action,
		"REBASE_CURRENT_BINDING",
	);
	const closed = resolveDelegationLifecycleV1(
		delegationLifecycleSnapshotFromInactiveBlockerClosureV1({ ...base, closed: true }),
		OBSERVE,
	);
	assert.equal(closed.state, "TERMINAL_NON_BLOCKING");
	assert.equal(closed.primary_action.action, "CONTINUE_DEVELOPMENT");
});

test("the clean-repair adapter closes only a clean unresolved obligation and strictly lowers its rank", () => {
	const open = delegationLifecycleSnapshotFromCleanRepairClosureV1({
		delegation_id: "20260828-100000-r001",
		source_authority: { closure: "open" },
		workspace_clean: true,
		closed: false,
	});
	const closing = resolveDelegationLifecycleV1(open, OBSERVE);
	assert.equal(closing.primary_action.action, "CLOSE_SATISFIED_NO_DELTA");
	assert.equal(closing.primary_action.recovery_effect, "MUST_DECREASE_RANK");
	assert.deepEqual(closing.primary_action.expected_recovery_rank, {
		unresolved_obligations: 1, unresolved_attempts: 1,
	});
	const dirty = resolveDelegationLifecycleV1(
		delegationLifecycleSnapshotFromCleanRepairClosureV1({
			delegation_id: "20260828-100000-r001",
			source_authority: { closure: "open" },
			workspace_clean: false,
			closed: false,
		}),
		OBSERVE,
	);
	assert.equal(dirty.primary_action.action, "REBASE_CURRENT_BINDING");
	const closed = delegationLifecycleSnapshotFromCleanRepairClosureV1({
		delegation_id: "20260828-100000-r001",
		source_authority: { closure: "closed" },
		workspace_clean: true,
		closed: true,
	});
	assert.deepEqual(closed.recovery_rank, { unresolved_obligations: 0, unresolved_attempts: 0 });
	assert.equal(resolveDelegationLifecycleV1(closed, OBSERVE).primary_action.action, "CONTINUE_DEVELOPMENT");
});

test("the canonical lifecycle matrix returns one typed primary action for every known condition", () => {
	const cases: Array<{
		name: string;
		input: DelegationLifecycleSnapshotV1;
		state: string;
		action: string;
		reason: string;
		automatic?: boolean;
		authorized?: boolean;
	}> = [
		{
			name: "live writer",
			input: snapshot({ writer_lock: "LIVE", attempt: "ACTIVE" }),
			state: "ACTIVE",
			action: "WAIT_FOR_ACTIVE_WRITER",
			reason: "ACTIVE_WRITER_PRESENT",
		},
		{
			name: "stale lock",
			input: snapshot({ writer_lock: "STALE" }),
			state: "TERMINAL_NON_BLOCKING",
			action: "RECLAIM_STALE_LOCK",
			reason: "STALE_WRITER_LOCK",
		},
		{
			name: "current delta",
			input: snapshot({ attempt: "AWAITING_REVIEW" }),
			state: "AWAITING_REVIEW",
			action: "REVIEW_CANDIDATE",
			reason: "CURRENT_DELTA_REVIEW_REQUIRED",
			automatic: false,
		},
		{
			name: "exact repair",
			input: snapshot({ attempt: "REPAIRABLE" }),
			state: "REPAIRABLE",
			action: "EXECUTE_EXACT_REPAIR",
			reason: "EXACT_REPAIR_DECISION_CURRENT",
			automatic: false,
		},
		{
			name: "already satisfied",
			input: snapshot({ attempt: "SATISFIED_NO_DELTA" }),
			state: "SATISFIED_NO_DELTA",
			action: "CLOSE_SATISFIED_NO_DELTA",
			reason: "SATISFIED_WITHOUT_NEW_DELTA",
		},
		{
			name: "empty attempt superseded",
			input: snapshot({ attempt: "SUPERSEDED" }),
			state: "SUPERSEDED",
			action: "SUPERSEDE_EMPTY_ATTEMPT",
			reason: "EMPTY_ATTEMPT_SUPERSEDED",
		},
		{
			name: "accepted successor",
			input: snapshot({ attempt: "ACCEPTED" }),
			state: "ACCEPTED",
			action: "CLOSE_ACCEPTED_OBLIGATION",
			reason: "ACCEPTED_SUCCESSOR_PRESENT",
		},
		{
			name: "derived review invalid",
			input: snapshot({ authority: { health: "DERIVED_INVALID", disposition: "INACTIVE" } }),
			state: "INVALID_DERIVED_EVIDENCE",
			action: "REGENERATE_DERIVED_REVIEW",
			reason: "DERIVED_REVIEW_INVALID",
		},
		{
			name: "active corrupt authority",
			input: snapshot({ authority: { health: "CORRUPT", disposition: "ACTIVE" } }),
			state: "CORRUPT_AUTHORITY",
			action: "QUARANTINE_CORRUPT_AUTHORITY",
			reason: "UNDERLYING_AUTHORITY_CORRUPT",
			automatic: false,
			authorized: true,
		},
		{
			name: "inactive corrupt authority",
			input: snapshot({ authority: { health: "CORRUPT", disposition: "INACTIVE" } }),
			state: "CORRUPT_AUTHORITY",
			action: "QUARANTINE_CORRUPT_AUTHORITY",
			reason: "UNDERLYING_AUTHORITY_CORRUPT",
		},
		{
			name: "safe rebase",
			input: snapshot({ binding: "REBASEABLE" }),
			state: "BINDING_CONFLICT",
			action: "REBASE_CURRENT_BINDING",
			reason: "REBASEABLE_BINDING_CHANGED",
		},
		{
			name: "invalid path request",
			input: snapshot({ request_valid: false, affected_paths: [], scope_unknown: true }),
			state: "BINDING_CONFLICT",
			action: "BLOCK_OVERLAPPING_PATHS",
			reason: "INVALID_PATH_REQUEST",
		},
		{
			name: "real overlap",
			input: snapshot({ binding: "OVERLAPPING" }),
			state: "BINDING_CONFLICT",
			action: "BLOCK_OVERLAPPING_PATHS",
			reason: "OVERLAPPING_PATHS",
		},
		{
			name: "promotion ready",
			input: snapshot({ operation_intent: "VERIFY", candidate: "READY", runtime_identity: "CURRENT" }),
			state: "PROMOTION_READY",
			action: "PROMOTE_CANDIDATE",
			reason: "CANDIDATE_PROMOTION_READY",
			automatic: false,
			authorized: true,
		},
		{
			name: "promotion evidence incomplete",
			input: snapshot({ operation_intent: "RELEASE", candidate: "INCOMPLETE", runtime_identity: "CURRENT" }),
			state: "PROMOTION_BLOCKED",
			action: "BLOCK_PROMOTION",
			reason: "CANDIDATE_PROMOTION_REQUIREMENTS_MISSING",
		},
		{
			name: "runtime identity stale",
			input: snapshot({ operation_intent: "VERIFY", candidate: "READY", runtime_identity: "STALE" }),
			state: "PROMOTION_BLOCKED",
			action: "BLOCK_PROMOTION",
			reason: "RUNTIME_IDENTITY_STALE",
		},
		{
			name: "storage read failed",
			input: snapshot({ authority: { health: "STORAGE_FAILURE", disposition: "UNKNOWN" }, scope_unknown: true }),
			state: "CORRUPT_AUTHORITY",
			action: "REPORT_STORAGE_FAILURE",
			reason: "STORAGE_READ_FAILED",
		},
		{
			name: "ordinary development",
			input: snapshot(),
			state: "TERMINAL_NON_BLOCKING",
			action: "CONTINUE_DEVELOPMENT",
			reason: "NO_CURRENT_BLOCKER",
		},
	];
	const observedActions = new Set<string>();
	for (const fixture of cases) {
		const resolution = resolveDelegationLifecycleV1(fixture.input, OBSERVE);
		assert.equal(resolution.state, fixture.state, fixture.name);
		assert.equal(resolution.primary_action.action, fixture.action, fixture.name);
		assert.equal(resolution.primary_action.reason, fixture.reason, fixture.name);
		assert.equal(resolution.primary_action.snapshot_hash, delegationLifecycleSnapshotHashV1(fixture.input), fixture.name);
		assert.equal(resolution.primary_action.safe_automatic, fixture.automatic ?? true, fixture.name);
		assert.equal(resolution.primary_action.requires_user_authorization, fixture.authorized ?? false, fixture.name);
		assert.equal(
			resolution.primary_action.recovery_effect,
			["CLOSE_SATISFIED_NO_DELTA", "SUPERSEDE_EMPTY_ATTEMPT", "CLOSE_ACCEPTED_OBLIGATION", "QUARANTINE_CORRUPT_AUTHORITY"].includes(fixture.action)
				? "MUST_DECREASE_RANK"
				: fixture.action === "EXECUTE_EXACT_REPAIR" ? "MAY_CREATE_DELTA" : "NONE",
			fixture.name,
		);
		observedActions.add(resolution.primary_action.action);
	}
	assert.deepEqual([...observedActions].sort(), [...DELEGATION_LIFECYCLE_PRIMARY_ACTIONS_V1].sort());
});

test("execution binds the exact snapshot hash and a stale action becomes one rebase action", () => {
	const current = snapshot();
	const currentHash = delegationLifecycleSnapshotHashV1(current);
	const matching = resolveDelegationLifecycleV1(current, {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
		event: "EXECUTE",
		expected_snapshot_hash: currentHash,
	});
	assert.equal(matching.primary_action.action, "CONTINUE_DEVELOPMENT");
	const stale = resolveDelegationLifecycleV1(current, {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
		event: "EXECUTE",
		expected_snapshot_hash: "b".repeat(64),
	});
	assert.equal(stale.state, "BINDING_CONFLICT");
	assert.equal(stale.primary_action.action, "REBASE_CURRENT_BINDING");
	assert.equal(stale.primary_action.reason, "SNAPSHOT_CHANGED");
});

test("the existing path-lane reader normalizes ALLOW and every fail-closed class without persisting shadow state", () => {
	const delegationId = "20260828-100000-r001";
	function admission(allowedPaths: readonly string[], blockers: readonly DelegationPathLaneBlockerV1[]): DelegationPathLaneAdmissionV1 {
		return {
			schema_version: 1,
			kind: "delegation-path-lane-admission-v1",
			authority_hash: HASH_A,
			ordinary_blocker_ids: blockers.map((blocker) => blocker.delegation_id),
			repair_tip_ids: [],
			repair_tip_exclusion_id: null,
			blockers,
			decision: decideDelegationPathLaneV1({
				schema_version: 1,
				kind: DELEGATION_PATH_LANE_REQUEST_KIND_V1,
				allowed_paths: allowedPaths,
				blockers,
			}),
		};
	}
	const fixtures: Array<{
		name: string;
		admission: DelegationPathLaneAdmissionV1;
		action: string;
		reason: string;
	}> = [
		{
			name: "allow",
			admission: admission(["src/**"], []),
			action: "CONTINUE_DEVELOPMENT",
			reason: "NO_CURRENT_BLOCKER",
		},
		{
			name: "overlap",
			admission: admission(["src/**"], [{
				kind: "known",
				delegation_id: delegationId,
				changed_paths: ["src/current.ts"],
				carried_paths: [],
				rename_sources: {},
			}]),
			action: "BLOCK_OVERLAPPING_PATHS",
			reason: "OVERLAPPING_PATHS",
		},
		{
			name: "invalid request",
			admission: admission(["../escape"], []),
			action: "BLOCK_OVERLAPPING_PATHS",
			reason: "INVALID_PATH_REQUEST",
		},
		{
			name: "storage failure",
			admission: admission(["src/**"], [{ kind: "unknown", delegation_id: delegationId, reason: "STORAGE_FAILURE" }]),
			action: "REPORT_STORAGE_FAILURE",
			reason: "STORAGE_READ_FAILED",
		},
		{
			name: "invalid authority",
			admission: admission(["src/**"], [{ kind: "invalid", delegation_id: delegationId, reason: "HASH_MISMATCH" }]),
			action: "QUARANTINE_CORRUPT_AUTHORITY",
			reason: "UNDERLYING_AUTHORITY_CORRUPT",
		},
	];
	for (const fixture of fixtures) {
		const normalized = delegationLifecycleSnapshotFromPathLaneAdmissionV1(fixture.admission);
		const resolution = resolveDelegationLifecycleV1(normalized, OBSERVE);
		assert.equal(resolution.primary_action.action, fixture.action, fixture.name);
		assert.equal(resolution.primary_action.reason, fixture.reason, fixture.name);
	}
});

test("unknown, malformed, hostile and cyclic input is total and fail-closed", () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	for (const input of [undefined, null, {}, { schema_version: 99 }, cyclic]) {
		const resolution = resolveDelegationLifecycleV1(input, OBSERVE);
		assert.equal(resolution.state, "CORRUPT_AUTHORITY");
		assert.equal(resolution.primary_action.action, "QUARANTINE_CORRUPT_AUTHORITY");
		assert.equal(resolution.primary_action.reason, "INVALID_SNAPSHOT");
		assert.equal(resolution.primary_action.safe_automatic, false);
		assert.equal(resolution.primary_action.requires_user_authorization, true);
	}
	const invalidEvent = resolveDelegationLifecycleV1(snapshot(), { event: "EXECUTE" });
	assert.equal(invalidEvent.primary_action.action, "REPORT_STORAGE_FAILURE");
	assert.equal(invalidEvent.primary_action.reason, "INVALID_EVENT");
});

test("resolution bytes and hashes are deterministic across object insertion order", () => {
	const firstInput = snapshot({ affected_paths: ["docs/a.md", "src/current.ts"] });
	const reordered = {
		recovery_rank: firstInput.recovery_rank === null ? null : {
			unresolved_attempts: firstInput.recovery_rank.unresolved_attempts,
			unresolved_obligations: firstInput.recovery_rank.unresolved_obligations,
		},
		scope_unknown: firstInput.scope_unknown,
		target: { id: firstInput.target.id, kind: firstInput.target.kind },
		runtime_identity: firstInput.runtime_identity,
		request_valid: firstInput.request_valid,
		candidate: firstInput.candidate,
		attempt: firstInput.attempt,
		binding: firstInput.binding,
		writer_lock: firstInput.writer_lock,
		authority: { disposition: firstInput.authority.disposition, health: firstInput.authority.health },
		operation_intent: firstInput.operation_intent,
		source_authority_hash: firstInput.source_authority_hash,
		kind: firstInput.kind,
		schema_version: firstInput.schema_version,
		affected_paths: [...firstInput.affected_paths],
	};
	const first = resolveDelegationLifecycleV1(firstInput, OBSERVE);
	const second = resolveDelegationLifecycleV1(reordered, OBSERVE);
	assert.deepEqual(second, first);
	assert.equal(serializeDelegationLifecycleResolutionV1(second), serializeDelegationLifecycleResolutionV1(first));
	const { resolution_hash: resolutionHash, ...projection } = first;
	assert.equal(resolutionHash, canonicalHash(projection));
});

test("resolver source remains a pure leaf without filesystem, Git, model, process or runtime effects", async () => {
	const source = await readFile(new URL(
		"../extensions/workbench-runtime/core/delegation-lifecycle-resolver.ts",
		import.meta.url,
	), "utf8");
	assert.doesNotMatch(source, /node:(?:child_process|fs|http|https|net|os|worker_threads)/u);
	assert.doesNotMatch(source, /\b(?:exec|spawn|fetch|writeFile|mkdir|rename|unlink)\s*\(/u);
	assert.doesNotMatch(source, /from\s+["'][^"']*(?:git|runtime-controller|service)[^"']*["']/u);
});
