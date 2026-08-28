/** WP6 scheduled review/repair/writer-lock race checks. */

import assert from "node:assert/strict";
import test from "node:test";

import {
	executeDelegationLifecycleEffectV1,
	type DelegationLifecycleEffectDependenciesV1,
	type DelegationLifecycleEffectExecutionInputV1,
	type DelegationLifecycleEffectExecutionResultV1,
} from "../extensions/workbench-runtime/core/delegation-lifecycle-effect.ts";
import {
	DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
	resolveDelegationLifecycleV1,
	type DelegationLifecycleResolutionV1,
	type DelegationLifecycleSnapshotV1,
} from "../extensions/workbench-runtime/core/delegation-lifecycle-resolver.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const HASH_INITIAL = "a".repeat(64);
const HASH_REVIEWED = "b".repeat(64);
const HASH_REPAIRABLE = "c".repeat(64);
const HASH_REPAIRED = "d".repeat(64);
const OBSERVE = {
	schema_version: 1,
	kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	event: "OBSERVE",
	expected_snapshot_hash: null,
} as const;

type ScheduledOperation = "repair-a" | "repair-b" | "review-a" | "review-b" | "stale-repair" | "stale-review";

function snapshot(patch: Partial<DelegationLifecycleSnapshotV1> = {}): DelegationLifecycleSnapshotV1 {
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: HASH_INITIAL,
		operation_intent: "DEV",
		authority: { health: "VALID", disposition: "INACTIVE" },
		writer_lock: "ABSENT",
		binding: "CURRENT",
		attempt: "AWAITING_REVIEW",
		candidate: "NONE",
		runtime_identity: "CURRENT",
		request_valid: true,
		target: { kind: "DELEGATION", id: "wp6-race-delegation" },
		affected_paths: ["src/race.ts"],
		scope_unknown: false,
		recovery_rank: { unresolved_obligations: 0, unresolved_attempts: 1 },
		...patch,
	};
}

function resolution(value: DelegationLifecycleSnapshotV1): DelegationLifecycleResolutionV1 {
	return resolveDelegationLifecycleV1(value, OBSERVE);
}

function input(value: DelegationLifecycleResolutionV1): DelegationLifecycleEffectExecutionInputV1 {
	return {
		project_root: "/fixture/wp6-race",
		resolution: value,
		expected_snapshot_hash: value.primary_action.snapshot_hash,
		execution_mode: "EXPLICIT",
		user_authorized: false,
		now: NOW,
	};
}

function permutations<T>(values: readonly T[]): T[][] {
	if (values.length <= 1) return [[...values]];
	const out: T[][] = [];
	for (let index = 0; index < values.length; index += 1) {
		const head = values[index]!;
		const rest = [...values.slice(0, index), ...values.slice(index + 1)];
		for (const tail of permutations(rest)) out.push([head, ...tail]);
	}
	return out;
}

interface RaceHarness {
	dependencies: DelegationLifecycleEffectDependenciesV1;
	setSnapshot(value: DelegationLifecycleSnapshotV1): void;
	reviewEffects(): number;
	repairEffects(): number;
	successors(): readonly string[];
	maxActiveLocks(): number;
}

function raceHarness(initial: DelegationLifecycleSnapshotV1, failLockAttempts = 0): RaceHarness {
	let current = initial;
	let reviewPublished = false;
	let repairPublished = false;
	let reviews = 0;
	let repairs = 0;
	let activeLocks = 0;
	let maximumActiveLocks = 0;
	let remainingLockFailures = failLockAttempts;
	let tail: Promise<void> = Promise.resolve();
	const successorIds = new Set<string>();
	return {
		dependencies: {
			with_writer_lock: async <T>(_request: unknown, operation: (lock: { owner: unknown }) => Promise<T>) => {
				let release!: () => void;
				const predecessor = tail;
				tail = new Promise<void>((resolve) => { release = resolve; });
				await predecessor;
				activeLocks += 1;
				maximumActiveLocks = Math.max(maximumActiveLocks, activeLocks);
				try {
					if (remainingLockFailures > 0) {
						remainingLockFailures -= 1;
						throw new Error("scheduled writer-lock crash");
					}
					return { ok: true as const, value: await operation({ owner: "wp6-scheduled-lock" }) };
				} finally {
					activeLocks -= 1;
					release();
				}
			},
			read_snapshot: async () => current,
			handlers: {
				REVIEW_CANDIDATE: {
					is_complete: ({ snapshot: observed }) => reviewPublished &&
						observed.attempt === "AWAITING_REVIEW" && observed.source_authority_hash === HASH_REVIEWED,
					execute: async () => {
						await Promise.resolve();
						reviews += 1;
						reviewPublished = true;
						current = snapshot({
							...current,
							source_authority_hash: HASH_REVIEWED,
							attempt: "AWAITING_REVIEW",
							recovery_rank: { unresolved_obligations: 0, unresolved_attempts: 1 },
						});
						return { ok: true };
					},
				},
				EXECUTE_EXACT_REPAIR: {
					is_complete: ({ snapshot: observed }) => repairPublished &&
						observed.attempt === "REPAIRABLE" && observed.source_authority_hash === HASH_REPAIRED,
					execute: async () => {
						await Promise.resolve();
						repairs += 1;
						repairPublished = true;
						successorIds.add("wp6-race-successor");
						current = snapshot({
							...current,
							source_authority_hash: HASH_REPAIRED,
							attempt: "REPAIRABLE",
							recovery_rank: { unresolved_obligations: 1, unresolved_attempts: 1 },
						});
						return { ok: true };
					},
				},
			},
		},
		setSnapshot: (value) => { current = value; },
		reviewEffects: () => reviews,
		repairEffects: () => repairs,
		successors: () => [...successorIds],
		maxActiveLocks: () => maximumActiveLocks,
	};
}

async function scheduledResults(
	order: readonly ScheduledOperation[],
	operations: Readonly<Record<ScheduledOperation, () => Promise<DelegationLifecycleEffectExecutionResultV1>>>,
): Promise<Record<ScheduledOperation, DelegationLifecycleEffectExecutionResultV1 | undefined>> {
	const results = await Promise.all(order.map(async (name) => ({ name, result: await operations[name]() })));
	return Object.fromEntries(results.map(({ name, result }) => [name, result])) as
		Record<ScheduledOperation, DelegationLifecycleEffectExecutionResultV1 | undefined>;
}

function successStatus(result: DelegationLifecycleEffectExecutionResultV1 | undefined): "EXECUTED" | "REPLAYED" | null {
	return result?.ok ? result.status : null;
}

function staleCode(result: DelegationLifecycleEffectExecutionResultV1 | undefined): string | null {
	return result !== undefined && !result.ok && result.status === "STALE" ? result.code : null;
}

test("WP6 AC03: every scheduled review/repair ordering serializes under one writer lock with one effect and one replay", async () => {
	for (const reviewOrder of permutations<ScheduledOperation>(["review-a", "stale-repair", "review-b"])) {
		const initial = snapshot();
		const review = resolution(initial);
		const staleRepair = resolution(snapshot({
			source_authority_hash: HASH_REPAIRABLE,
			attempt: "REPAIRABLE",
			recovery_rank: { unresolved_obligations: 1, unresolved_attempts: 1 },
		}));
		assert.equal(review.primary_action.action, "REVIEW_CANDIDATE");
		assert.equal(staleRepair.primary_action.action, "EXECUTE_EXACT_REPAIR");
		const harness = raceHarness(initial);
		const reviewPhase = await scheduledResults(reviewOrder, {
			"review-a": () => executeDelegationLifecycleEffectV1(input(review), harness.dependencies),
			"review-b": () => executeDelegationLifecycleEffectV1(input(review), harness.dependencies),
			"stale-repair": () => executeDelegationLifecycleEffectV1(input(staleRepair), harness.dependencies),
			"repair-a": async () => { throw new Error("not scheduled"); },
			"repair-b": async () => { throw new Error("not scheduled"); },
			"stale-review": async () => { throw new Error("not scheduled"); },
		});
		assert.deepEqual(
			[successStatus(reviewPhase["review-a"]), successStatus(reviewPhase["review-b"])].sort(),
			["EXECUTED", "REPLAYED"],
			`review schedule ${reviewOrder.join(" -> ")}`,
		);
		assert.equal(staleCode(reviewPhase["stale-repair"]), "ACTION_CHANGED");
		assert.equal(harness.reviewEffects(), 1);

		const repairSnapshot = snapshot({
			source_authority_hash: HASH_REPAIRABLE,
			attempt: "REPAIRABLE",
			recovery_rank: { unresolved_obligations: 1, unresolved_attempts: 1 },
		});
		harness.setSnapshot(repairSnapshot);
		const repair = resolution(repairSnapshot);
		for (const repairOrder of permutations<ScheduledOperation>(["repair-a", "stale-review", "repair-b"])) {
			const isolated = raceHarness(repairSnapshot);
			const repairPhase = await scheduledResults(repairOrder, {
				"repair-a": () => executeDelegationLifecycleEffectV1(input(repair), isolated.dependencies),
				"repair-b": () => executeDelegationLifecycleEffectV1(input(repair), isolated.dependencies),
				"stale-review": () => executeDelegationLifecycleEffectV1(input(review), isolated.dependencies),
				"review-a": async () => { throw new Error("not scheduled"); },
				"review-b": async () => { throw new Error("not scheduled"); },
				"stale-repair": async () => { throw new Error("not scheduled"); },
			});
			assert.deepEqual(
				[successStatus(repairPhase["repair-a"]), successStatus(repairPhase["repair-b"])].sort(),
				["EXECUTED", "REPLAYED"],
				`repair schedule ${repairOrder.join(" -> ")}`,
			);
			assert.equal(staleCode(repairPhase["stale-review"]), "ACTION_CHANGED");
			assert.equal(isolated.repairEffects(), 1);
			assert.deepEqual(isolated.successors(), ["wp6-race-successor"]);
			assert.equal(isolated.maxActiveLocks(), 1);
		}
		assert.equal(harness.maxActiveLocks(), 1);
	}
});

test("WP6 AC03: a scheduled writer-lock crash releases the queue; one retry executes and the other replays", async () => {
	const repairSnapshot = snapshot({
		source_authority_hash: HASH_REPAIRABLE,
		attempt: "REPAIRABLE",
		recovery_rank: { unresolved_obligations: 1, unresolved_attempts: 1 },
	});
	const repair = resolution(repairSnapshot);
	const harness = raceHarness(repairSnapshot, 1);
	const outcomes = await Promise.all([
		executeDelegationLifecycleEffectV1(input(repair), harness.dependencies),
		executeDelegationLifecycleEffectV1(input(repair), harness.dependencies),
		executeDelegationLifecycleEffectV1(input(repair), harness.dependencies),
	]);
	assert.equal(outcomes.filter((outcome) => !outcome.ok && outcome.code === "LOCK_FAILED").length, 1);
	assert.deepEqual(
		outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.ok ? outcome.status : null).sort(),
		["EXECUTED", "REPLAYED"],
	);
	assert.equal(harness.repairEffects(), 1);
	assert.deepEqual(harness.successors(), ["wp6-race-successor"]);
	assert.equal(harness.maxActiveLocks(), 1);
});
