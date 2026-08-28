import assert from "node:assert/strict";
import test from "node:test";

import {
	executeDelegationLifecycleEffectV1,
	type DelegationLifecycleEffectDependenciesV1,
	type DelegationLifecycleEffectExecutionInputV1,
	type DelegationLifecycleEffectHandlerV1,
} from "../extensions/workbench-runtime/core/delegation-lifecycle-effect.ts";
import {
	DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
	resolveDelegationLifecycleV1,
	type DelegationLifecycleResolutionV1,
	type DelegationLifecycleSnapshotV1,
} from "../extensions/workbench-runtime/core/delegation-lifecycle-resolver.ts";

const NOW = "2026-08-28T10:00:00.000Z";
const OBSERVE = {
	schema_version: 1,
	kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	event: "OBSERVE",
	expected_snapshot_hash: null,
} as const;

function snapshot(patch: Partial<DelegationLifecycleSnapshotV1> = {}): DelegationLifecycleSnapshotV1 {
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: "a".repeat(64),
		operation_intent: "DEV",
		authority: { health: "VALID", disposition: "INACTIVE" },
		writer_lock: "ABSENT",
		binding: "CURRENT",
		attempt: "SATISFIED_NO_DELTA",
		candidate: "NONE",
		runtime_identity: "NOT_REQUIRED",
		request_valid: true,
		target: { kind: "DELEGATION", id: "20260828-100000-r001" },
		affected_paths: ["src/current.ts"],
		scope_unknown: false,
		recovery_rank: { unresolved_obligations: 1, unresolved_attempts: 1 },
		...patch,
	};
}

function resolution(value: DelegationLifecycleSnapshotV1): DelegationLifecycleResolutionV1 {
	return resolveDelegationLifecycleV1(value, OBSERVE);
}

function input(value: DelegationLifecycleResolutionV1, patch: Partial<DelegationLifecycleEffectExecutionInputV1> = {}): DelegationLifecycleEffectExecutionInputV1 {
	return {
		project_root: "/project",
		resolution: value,
		expected_snapshot_hash: value.primary_action.snapshot_hash,
		execution_mode: "AUTOMATIC",
		user_authorized: false,
		now: NOW,
		...patch,
	};
}

interface Harness {
	dependencies: DelegationLifecycleEffectDependenciesV1;
	getSnapshot(): DelegationLifecycleSnapshotV1;
	setSnapshot(value: DelegationLifecycleSnapshotV1): void;
	effectCount(): number;
}

function harness(initial: DelegationLifecycleSnapshotV1, handlerPatch: Partial<DelegationLifecycleEffectHandlerV1> = {}): Harness {
	let current = initial;
	let effects = 0;
	let tail: Promise<void> = Promise.resolve();
	const handler: DelegationLifecycleEffectHandlerV1 = {
		is_complete: ({ snapshot: observed }) => observed.attempt === "TERMINAL",
		execute: async () => {
			effects += 1;
			current = snapshot({
				...current,
				source_authority_hash: "b".repeat(64),
				attempt: "TERMINAL",
				recovery_rank: { unresolved_obligations: 0, unresolved_attempts: 1 },
			});
			return { ok: true };
		},
		...handlerPatch,
	};
	return {
		dependencies: {
			with_writer_lock: async <T>(_request: unknown, operation: (lock: { owner: unknown }) => Promise<T>) => {
				let release!: () => void;
				const predecessor = tail;
				tail = new Promise<void>((resolve) => { release = resolve; });
				await predecessor;
				try {
					return { ok: true as const, value: await operation({ owner: "fixture-lock" }) };
				} finally {
					release();
				}
			},
			read_snapshot: async () => current,
			handlers: { CLOSE_SATISFIED_NO_DELTA: handler },
		},
		getSnapshot: () => current,
		setSnapshot: (value) => { current = value; },
		effectCount: () => effects,
	};
}

test("one exact safe action executes under the writer lock and strictly rereads its terminal postcondition", async () => {
	const initial = snapshot();
	const expected = resolution(initial);
	assert.equal(expected.primary_action.action, "CLOSE_SATISFIED_NO_DELTA");
	assert.equal(expected.primary_action.expected_state, "TERMINAL_NON_BLOCKING");
	const fixture = harness(initial);
	const result = await executeDelegationLifecycleEffectV1(input(expected), fixture.dependencies);
	assert.equal(result.ok, true, JSON.stringify(result));
	if (!result.ok) return;
	assert.equal(result.status, "EXECUTED");
	assert.equal(result.observed.state, "TERMINAL_NON_BLOCKING");
	assert.equal(result.observed.primary_action.action, "CONTINUE_DEVELOPMENT");
	assert.equal(fixture.getSnapshot().attempt, "TERMINAL");
	assert.equal(fixture.effectCount(), 1);
});

test("a lost response replays from durable completion and never runs the effect twice", async () => {
	const initial = snapshot();
	const expected = resolution(initial);
	const fixture = harness(initial);
	const first = await executeDelegationLifecycleEffectV1(input(expected), fixture.dependencies);
	const replay = await executeDelegationLifecycleEffectV1(input(expected), fixture.dependencies);
	assert.equal(first.ok && first.status, "EXECUTED");
	assert.equal(replay.ok && replay.status, "REPLAYED");
	assert.equal(fixture.effectCount(), 1);
});

test("two concurrent executions serialize to one durable effect and one replay", async () => {
	const initial = snapshot();
	const expected = resolution(initial);
	const fixture = harness(initial, {
		execute: async () => {
			await Promise.resolve();
			fixture.setSnapshot(snapshot({
				source_authority_hash: "c".repeat(64),
				attempt: "TERMINAL",
				recovery_rank: { unresolved_obligations: 0, unresolved_attempts: 1 },
			}));
			return { ok: true };
		},
	});
	const [left, right] = await Promise.all([
		executeDelegationLifecycleEffectV1(input(expected), fixture.dependencies),
		executeDelegationLifecycleEffectV1(input(expected), fixture.dependencies),
	]);
	assert.deepEqual([left.ok && left.status, right.ok && right.status].sort(), ["EXECUTED", "REPLAYED"]);
});

test("TOCTOU action drift is returned as one stale refusal before any effect", async () => {
	const initial = snapshot();
	const expected = resolution(initial);
	const fixture = harness(initial);
	fixture.setSnapshot(snapshot({ source_authority_hash: "d".repeat(64), attempt: "AWAITING_REVIEW" }));
	const result = await executeDelegationLifecycleEffectV1(input(expected), fixture.dependencies);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.status, "STALE");
	assert.equal(result.code, "ACTION_CHANGED");
	assert.equal(result.observed?.primary_action.action, "REVIEW_CANDIDATE");
	assert.equal(fixture.effectCount(), 0);
});

test("automatic, explicit and user-authorization policy is enforced before lock acquisition", async () => {
	const promoted = resolution(snapshot({
		operation_intent: "VERIFY",
		attempt: "TERMINAL",
		candidate: "READY",
		runtime_identity: "CURRENT",
		target: { kind: "CANDIDATE", id: "candidate-1" },
	}));
	assert.equal(promoted.primary_action.action, "PROMOTE_CANDIDATE");
	let locks = 0;
	const dependencies: DelegationLifecycleEffectDependenciesV1 = {
		with_writer_lock: async () => {
			locks += 1;
			return { ok: false, code: "FAILED" };
		},
		read_snapshot: async () => {
			throw new Error("unreachable");
		},
		handlers: {
			PROMOTE_CANDIDATE: {
				is_complete: () => false,
				execute: async () => ({ ok: true }),
			},
		},
	};
	const automatic = await executeDelegationLifecycleEffectV1(input(promoted), dependencies);
	assert.equal(!automatic.ok && automatic.code, "AUTOMATIC_EXECUTION_FORBIDDEN");
	const unauthorized = await executeDelegationLifecycleEffectV1(input(promoted, { execution_mode: "EXPLICIT" }), dependencies);
	assert.equal(!unauthorized.ok && unauthorized.code, "USER_AUTHORIZATION_REQUIRED");
	assert.equal(locks, 0);
});

test("passive actions, missing handlers, invalid envelopes and failed postconditions remain fail-closed", async () => {
	const passive = resolution(snapshot({ attempt: "TERMINAL" }));
	const active = resolution(snapshot());
	const fixture = harness(snapshot());
	const passiveResult = await executeDelegationLifecycleEffectV1(input(passive), fixture.dependencies);
	assert.equal(!passiveResult.ok && passiveResult.code, "ACTION_NOT_EXECUTABLE");
	const missing = await executeDelegationLifecycleEffectV1(input(active), { ...fixture.dependencies, handlers: {} });
	assert.equal(!missing.ok && missing.code, "HANDLER_MISSING");
	const forged = {
		...input(active),
		resolution: { ...active, resolution_hash: "0".repeat(64) },
	};
	const invalid = await executeDelegationLifecycleEffectV1(forged, fixture.dependencies);
	assert.equal(!invalid.ok && invalid.code, "INVALID_INPUT");
	const incomplete = harness(snapshot(), {
		execute: async () => ({ ok: true }),
	});
	const failedPostcondition = await executeDelegationLifecycleEffectV1(input(active), incomplete.dependencies);
	assert.equal(!failedPostcondition.ok && failedPostcondition.code, "POSTCONDITION_FAILED");
});

test("a no-delta closure cannot report success without strictly lowering recovery rank", async () => {
	const initial = snapshot();
	const expected = resolution(initial);
	const fixture = harness(initial, {
		execute: async () => {
			fixture.setSnapshot(snapshot({
				source_authority_hash: "e".repeat(64),
				attempt: "TERMINAL",
				recovery_rank: { unresolved_obligations: 1, unresolved_attempts: 1 },
			}));
			return { ok: true };
		},
	});
	const result = await executeDelegationLifecycleEffectV1(input(expected), fixture.dependencies);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "RECOVERY_RANK_NOT_DECREASED");
	const replay = await executeDelegationLifecycleEffectV1(input(expected), fixture.dependencies);
	assert.equal(replay.ok, false);
	if (!replay.ok) assert.equal(replay.code, "RECOVERY_RANK_NOT_DECREASED");
});
