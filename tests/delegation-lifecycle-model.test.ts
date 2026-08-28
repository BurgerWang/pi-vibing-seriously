/** WP6 deterministic model-based lifecycle convergence checks. */

import assert from "node:assert/strict";
import test from "node:test";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	DELEGATION_LIFECYCLE_PRIMARY_ACTIONS_V1,
	DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
	DELEGATION_LIFECYCLE_STATES_V1,
	delegationLifecycleSnapshotHashV1,
	resolveDelegationLifecycleV1,
	serializeDelegationLifecycleResolutionV1,
	type DelegationLifecyclePrimaryActionNameV1,
	type DelegationLifecycleSnapshotV1,
	type DelegationLifecycleStateV1,
} from "../extensions/workbench-runtime/core/delegation-lifecycle-resolver.ts";

const MODEL_SEQUENCE_COUNT = 10_000;
const BASE_SEED = 0x6d2b79f5;
const OBSERVE = {
	schema_version: 1,
	kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	event: "OBSERVE",
	expected_snapshot_hash: null,
} as const;

const MODEL_COMMANDS = [
	"PREPARE",
	"START",
	"WRITE",
	"COMMIT",
	"WORKER_SUCCESS",
	"WORKER_FAILURE",
	"WORKER_INTERRUPTION",
	"ABORT",
	"REVIEW_ACCEPT",
	"REVIEW_REPAIR",
	"REVIEW_INCOMPLETE",
	"REVIEW_CORRUPT",
	"EXACT_REPAIR",
	"REPLAY",
	"LOST_RESPONSE",
	"ZERO_DELTA_SATISFIED",
	"ZERO_DELTA_NO_EFFECT",
	"EXTERNAL_DRIFT_NON_OVERLAP",
	"EXTERNAL_DRIFT_REBASEABLE",
	"EXTERNAL_DRIFT_OVERLAP",
	"REBASE",
	"CLOSE",
	"CORRUPT_AUTHORITY",
	"QUARANTINE",
	"SUPERSEDE",
	"INVALID_PATH_REQUEST",
	"STORAGE_FAULT",
	"LOCK_ACQUIRE",
	"LOCK_RELEASE",
	"LOCK_CRASH",
	"LOCK_RECLAIM",
	"CANDIDATE_FREEZE",
	"GATE_PASS",
	"GATE_FAIL",
	"PROMOTE",
	"SESSION_RELOAD",
	"RUNTIME_VERSION_CHANGE",
] as const;
type ModelCommand = (typeof MODEL_COMMANDS)[number];

interface LifecycleModel {
	revision: number;
	authority: DelegationLifecycleSnapshotV1["authority"];
	writerLock: DelegationLifecycleSnapshotV1["writer_lock"];
	binding: DelegationLifecycleSnapshotV1["binding"];
	attempt: DelegationLifecycleSnapshotV1["attempt"];
	candidate: DelegationLifecycleSnapshotV1["candidate"];
	runtimeIdentity: DelegationLifecycleSnapshotV1["runtime_identity"];
	intent: DelegationLifecycleSnapshotV1["operation_intent"];
	requestValid: boolean;
	scopeUnknown: boolean;
	affectedPaths: readonly string[];
	recoveryRank: NonNullable<DelegationLifecycleSnapshotV1["recovery_rank"]>;
	successorCount: number;
	promotionCount: number;
}

interface ExpectedResolution {
	state: DelegationLifecycleStateV1;
	action: DelegationLifecyclePrimaryActionNameV1;
}

const TARGETED_PREFIXES: readonly (readonly ModelCommand[])[] = [
	["LOCK_ACQUIRE"],
	["LOCK_ACQUIRE", "LOCK_CRASH"],
	["STORAGE_FAULT"],
	["CORRUPT_AUTHORITY"],
	["COMMIT"],
	["COMMIT", "REVIEW_CORRUPT"],
	["WORKER_FAILURE"],
	["ZERO_DELTA_SATISFIED"],
	["SUPERSEDE"],
	["COMMIT", "REVIEW_ACCEPT"],
	["EXTERNAL_DRIFT_REBASEABLE"],
	["EXTERNAL_DRIFT_OVERLAP"],
	["INVALID_PATH_REQUEST"],
	["CANDIDATE_FREEZE"],
	["GATE_FAIL"],
	["RUNTIME_VERSION_CHANGE"],
];

function initialModel(): LifecycleModel {
	return {
		revision: 0,
		authority: { health: "VALID", disposition: "INACTIVE" },
		writerLock: "ABSENT",
		binding: "CURRENT",
		attempt: "TERMINAL",
		candidate: "NONE",
		runtimeIdentity: "NOT_REQUIRED",
		intent: "DEV",
		requestValid: true,
		scopeUnknown: false,
		affectedPaths: ["src/model.ts"],
		recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 0 },
		successorCount: 0,
		promotionCount: 0,
	};
}

function revise(model: LifecycleModel, patch: Partial<LifecycleModel>): LifecycleModel {
	return { ...model, ...patch, revision: model.revision + 1 };
}

function delegationFacts(model: LifecycleModel, patch: Partial<LifecycleModel>): LifecycleModel {
	return revise(model, {
		intent: "DEV",
		candidate: "NONE",
		runtimeIdentity: "NOT_REQUIRED",
		requestValid: true,
		scopeUnknown: false,
		affectedPaths: ["src/model.ts"],
		...patch,
	});
}

function applyCommand(model: LifecycleModel, command: ModelCommand): LifecycleModel {
	switch (command) {
		case "PREPARE":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "ACTIVE",
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 1 },
				successorCount: 0,
			});
		case "START":
		case "LOCK_ACQUIRE":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "ACTIVE" },
				writerLock: "LIVE",
				binding: "CURRENT",
				attempt: "ACTIVE",
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 1 },
			});
		case "WRITE":
			return model.attempt === "ACTIVE" ? revise(model, {}) : model;
		case "COMMIT":
		case "WORKER_SUCCESS":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "AWAITING_REVIEW",
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 1 },
			});
		case "WORKER_FAILURE":
		case "WORKER_INTERRUPTION":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "REPAIRABLE",
				recoveryRank: { unresolved_obligations: 1, unresolved_attempts: 1 },
				successorCount: 0,
			});
		case "ABORT":
		case "ZERO_DELTA_NO_EFFECT":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "TERMINAL",
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 0 },
			});
		case "REVIEW_ACCEPT":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "ACCEPTED",
				recoveryRank: { unresolved_obligations: 1, unresolved_attempts: 1 },
			});
		case "REVIEW_REPAIR":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "REPAIRABLE",
				recoveryRank: { unresolved_obligations: 1, unresolved_attempts: 1 },
				successorCount: 0,
			});
		case "REVIEW_INCOMPLETE":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "AWAITING_REVIEW",
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 1 },
			});
		case "REVIEW_CORRUPT":
			return delegationFacts(model, {
				authority: { health: "DERIVED_INVALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "AWAITING_REVIEW",
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 1 },
			});
		case "EXACT_REPAIR":
			if (model.attempt !== "REPAIRABLE" || model.successorCount !== 0) return model;
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "AWAITING_REVIEW",
				recoveryRank: { unresolved_obligations: 1, unresolved_attempts: 2 },
				successorCount: 1,
			});
		case "REPLAY":
		case "LOST_RESPONSE":
			return model;
		case "ZERO_DELTA_SATISFIED":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "SATISFIED_NO_DELTA",
				recoveryRank: { unresolved_obligations: 1, unresolved_attempts: 1 },
			});
		case "EXTERNAL_DRIFT_NON_OVERLAP":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "TERMINAL",
				affectedPaths: ["src/unrelated.ts"],
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 1 },
			});
		case "EXTERNAL_DRIFT_REBASEABLE":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "REBASEABLE",
				attempt: "TERMINAL",
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 1 },
			});
		case "EXTERNAL_DRIFT_OVERLAP":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "OVERLAPPING",
				attempt: "TERMINAL",
				recoveryRank: { unresolved_obligations: 1, unresolved_attempts: 1 },
			});
		case "REBASE":
			return model.binding === "REBASEABLE" ? revise(model, { binding: "CURRENT" }) : model;
		case "CLOSE":
			if (!(["ACCEPTED", "SATISFIED_NO_DELTA", "SUPERSEDED"] as const).includes(
				model.attempt as "ACCEPTED" | "SATISFIED_NO_DELTA" | "SUPERSEDED",
			)) return model;
			return revise(model, {
				attempt: "TERMINAL",
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 0 },
			});
		case "CORRUPT_AUTHORITY":
			return delegationFacts(model, {
				authority: { health: "CORRUPT", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "TERMINAL",
				scopeUnknown: true,
				recoveryRank: { unresolved_obligations: 1, unresolved_attempts: 1 },
			});
		case "QUARANTINE":
			if (model.authority.health !== "CORRUPT" || model.authority.disposition !== "INACTIVE") return model;
			return revise(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				attempt: "TERMINAL",
				scopeUnknown: false,
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 0 },
			});
		case "SUPERSEDE":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "SUPERSEDED",
				recoveryRank: { unresolved_obligations: 1, unresolved_attempts: 1 },
			});
		case "INVALID_PATH_REQUEST":
			return delegationFacts(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "TERMINAL",
				requestValid: false,
				scopeUnknown: true,
				affectedPaths: [],
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 0 },
			});
		case "STORAGE_FAULT":
			return delegationFacts(model, {
				authority: { health: "STORAGE_FAILURE", disposition: "UNKNOWN" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "TERMINAL",
				scopeUnknown: true,
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 0 },
			});
		case "LOCK_RELEASE":
			return model.writerLock === "LIVE"
				? revise(model, { writerLock: "ABSENT", authority: { health: "VALID", disposition: "INACTIVE" } })
				: model;
		case "LOCK_CRASH":
			return model.writerLock === "LIVE"
				? revise(model, {
					writerLock: "STALE",
					authority: { health: "VALID", disposition: "INACTIVE" },
					attempt: "TERMINAL",
				})
				: model;
		case "LOCK_RECLAIM":
			return model.writerLock === "STALE" ? revise(model, { writerLock: "ABSENT" }) : model;
		case "CANDIDATE_FREEZE":
		case "GATE_PASS":
			return revise(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "TERMINAL",
				candidate: "READY",
				runtimeIdentity: "CURRENT",
				intent: "VERIFY",
				requestValid: true,
				scopeUnknown: false,
				affectedPaths: ["dist/candidate.json"],
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 0 },
			});
		case "GATE_FAIL":
			return revise(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "TERMINAL",
				candidate: "BLOCKED",
				runtimeIdentity: "CURRENT",
				intent: "VERIFY",
				requestValid: true,
				scopeUnknown: false,
				affectedPaths: ["dist/candidate.json"],
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 0 },
			});
		case "PROMOTE": {
			const current = resolveDelegationLifecycleV1(toSnapshot(model), OBSERVE);
			return current.primary_action.action === "PROMOTE_CANDIDATE" && model.promotionCount === 0
				? revise(model, { promotionCount: 1 })
				: model;
		}
		case "SESSION_RELOAD":
			return model.intent === "DEV" ? model : revise(model, { runtimeIdentity: "CURRENT" });
		case "RUNTIME_VERSION_CHANGE":
			return revise(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				writerLock: "ABSENT",
				binding: "CURRENT",
				attempt: "TERMINAL",
				candidate: model.candidate === "NONE" ? "READY" : model.candidate,
				runtimeIdentity: "STALE",
				intent: "VERIFY",
				requestValid: true,
				scopeUnknown: false,
				affectedPaths: ["dist/candidate.json"],
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 0 },
			});
	}
}

function toSnapshot(model: LifecycleModel): DelegationLifecycleSnapshotV1 {
	return {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_SNAPSHOT_KIND_V1,
		source_authority_hash: canonicalHash({ kind: "wp6-model-authority-v1", revision: model.revision }),
		operation_intent: model.intent,
		authority: { ...model.authority },
		writer_lock: model.writerLock,
		binding: model.binding,
		attempt: model.attempt,
		candidate: model.candidate,
		runtime_identity: model.runtimeIdentity,
		request_valid: model.requestValid,
		target: model.intent === "DEV"
			? { kind: "DELEGATION", id: "wp6-model-delegation" }
			: { kind: "CANDIDATE", id: "wp6-model-candidate" },
		affected_paths: [...model.affectedPaths],
		scope_unknown: model.scopeUnknown,
		recovery_rank: { ...model.recoveryRank },
	};
}

function expectedResolution(model: LifecycleModel): ExpectedResolution {
	if (model.writerLock === "LIVE") return { state: "ACTIVE", action: "WAIT_FOR_ACTIVE_WRITER" };
	switch (model.authority.health) {
		case "STORAGE_FAILURE": return { state: "CORRUPT_AUTHORITY", action: "REPORT_STORAGE_FAILURE" };
		case "CORRUPT": return { state: "CORRUPT_AUTHORITY", action: "QUARANTINE_CORRUPT_AUTHORITY" };
		case "DERIVED_INVALID": return { state: "INVALID_DERIVED_EVIDENCE", action: "REGENERATE_DERIVED_REVIEW" };
		case "VALID": break;
	}
	if (model.writerLock === "STALE") return { state: "TERMINAL_NON_BLOCKING", action: "RECLAIM_STALE_LOCK" };
	if (!model.requestValid || model.binding === "OVERLAPPING") {
		return { state: "BINDING_CONFLICT", action: "BLOCK_OVERLAPPING_PATHS" };
	}
	if (model.binding === "REBASEABLE") return { state: "BINDING_CONFLICT", action: "REBASE_CURRENT_BINDING" };
	switch (model.attempt) {
		case "ACTIVE": return { state: "ACTIVE", action: "WAIT_FOR_ACTIVE_WRITER" };
		case "AWAITING_REVIEW": return { state: "AWAITING_REVIEW", action: "REVIEW_CANDIDATE" };
		case "REPAIRABLE": return { state: "REPAIRABLE", action: "EXECUTE_EXACT_REPAIR" };
		case "SATISFIED_NO_DELTA": return { state: "SATISFIED_NO_DELTA", action: "CLOSE_SATISFIED_NO_DELTA" };
		case "SUPERSEDED": return { state: "SUPERSEDED", action: "SUPERSEDE_EMPTY_ATTEMPT" };
		case "ACCEPTED": return { state: "ACCEPTED", action: "CLOSE_ACCEPTED_OBLIGATION" };
		case "NONE":
		case "TERMINAL":
			break;
	}
	if (model.intent === "DEV") return { state: "TERMINAL_NON_BLOCKING", action: "CONTINUE_DEVELOPMENT" };
	if (model.runtimeIdentity === "STALE" || model.runtimeIdentity === "UNKNOWN") {
		return { state: "PROMOTION_BLOCKED", action: "BLOCK_PROMOTION" };
	}
	return model.candidate === "READY"
		? { state: "PROMOTION_READY", action: "PROMOTE_CANDIDATE" }
		: { state: "PROMOTION_BLOCKED", action: "BLOCK_PROMOTION" };
}

function rankLess(left: LifecycleModel["recoveryRank"], right: LifecycleModel["recoveryRank"]): boolean {
	return left.unresolved_obligations < right.unresolved_obligations ||
		(left.unresolved_obligations === right.unresolved_obligations && left.unresolved_attempts < right.unresolved_attempts);
}

function applyAutomaticRecovery(model: LifecycleModel, action: DelegationLifecyclePrimaryActionNameV1): LifecycleModel {
	switch (action) {
		case "CLOSE_SATISFIED_NO_DELTA":
		case "SUPERSEDE_EMPTY_ATTEMPT":
		case "CLOSE_ACCEPTED_OBLIGATION":
			return revise(model, {
				attempt: "TERMINAL",
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 0 },
			});
		case "QUARANTINE_CORRUPT_AUTHORITY":
			return revise(model, {
				authority: { health: "VALID", disposition: "INACTIVE" },
				attempt: "TERMINAL",
				scopeUnknown: false,
				recoveryRank: { unresolved_obligations: 0, unresolved_attempts: 0 },
			});
		default:
			return model;
	}
}

function verifyModel(model: LifecycleModel): { state: DelegationLifecycleStateV1; action: DelegationLifecyclePrimaryActionNameV1 } {
	const input = toSnapshot(model);
	const first = resolveDelegationLifecycleV1(input, OBSERVE);
	const replay = resolveDelegationLifecycleV1(structuredClone(input), structuredClone(OBSERVE));
	const expected = expectedResolution(model);
	assert.deepEqual(replay, first, "same snapshot and event must be deterministic");
	assert.equal(serializeDelegationLifecycleResolutionV1(replay), serializeDelegationLifecycleResolutionV1(first));
	assert.equal(first.state, expected.state);
	assert.equal(first.primary_action.action, expected.action);
	assert.equal(first.primary_action.snapshot_hash, delegationLifecycleSnapshotHashV1(input));
	assert.deepEqual(first.primary_action.exact_target, input.target);
	assert.deepEqual(first.primary_action.affected_paths, input.affected_paths);
	assert.ok(DELEGATION_LIFECYCLE_PRIMARY_ACTIONS_V1.includes(first.primary_action.action));
	assert.ok(DELEGATION_LIFECYCLE_STATES_V1.includes(first.state));
	assert.ok(model.successorCount <= 1, "one obligation must never publish two successors");
	assert.ok(model.promotionCount <= 1, "promotion replay must not publish a second promotion");
	if (first.primary_action.action === "PROMOTE_CANDIDATE") {
		assert.notEqual(model.intent, "DEV");
		assert.equal(model.candidate, "READY");
		assert.equal(model.runtimeIdentity, "CURRENT");
		assert.equal(model.authority.health, "VALID");
		assert.equal(model.writerLock, "ABSENT");
		assert.equal(model.binding, "CURRENT");
		assert.ok(model.attempt === "NONE" || model.attempt === "TERMINAL");
	}
	if (first.primary_action.recovery_effect === "MUST_DECREASE_RANK" && first.primary_action.safe_automatic) {
		const recovered = applyAutomaticRecovery(model, first.primary_action.action);
		assert.ok(rankLess(recovered.recoveryRank, model.recoveryRank), "automatic no-delta recovery must lower rank");
		const after = resolveDelegationLifecycleV1(toSnapshot(recovered), OBSERVE);
		assert.equal(after.state, first.primary_action.expected_state, "strict readback must reach the declared state");
	}
	return { state: first.state, action: first.primary_action.action };
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0 || 0x9e3779b9;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}

function sequenceForSeed(seedIndex: number): ModelCommand[] {
	const seed = (BASE_SEED + Math.imul(seedIndex + 1, 0x9e3779b1)) >>> 0;
	const random = seededRandom(seed);
	const targeted = TARGETED_PREFIXES[seedIndex] ?? [];
	const length = Math.max(targeted.length, 6 + random() % 7);
	const commands = [...targeted];
	while (commands.length < length) commands.push(MODEL_COMMANDS[random() % MODEL_COMMANDS.length]!);
	return commands;
}

function runSequence(commands: readonly ModelCommand[]): Array<{ state: DelegationLifecycleStateV1; action: DelegationLifecyclePrimaryActionNameV1 }> {
	let model = initialModel();
	const trace = [verifyModel(model)];
	for (const command of commands) {
		const before = model;
		model = applyCommand(model, command);
		if (command === "REPLAY" || command === "LOST_RESPONSE") assert.deepEqual(model, before);
		trace.push(verifyModel(model));
	}
	return trace;
}

function shrinkFailingSequence(
	sequence: readonly ModelCommand[],
	fails: (candidate: readonly ModelCommand[]) => boolean,
): ModelCommand[] {
	let current = [...sequence];
	let granularity = 2;
	while (current.length >= 2) {
		const chunkSize = Math.ceil(current.length / granularity);
		let reduced = false;
		for (let start = 0; start < current.length; start += chunkSize) {
			const candidate = [...current.slice(0, start), ...current.slice(start + chunkSize)];
			if (candidate.length === 0 || !fails(candidate)) continue;
			current = candidate;
			granularity = Math.max(2, granularity - 1);
			reduced = true;
			break;
		}
		if (reduced) continue;
		if (granularity >= current.length) break;
		granularity = Math.min(current.length, granularity * 2);
	}
	return current;
}

test("WP6 model runner is fixed-seed replayable and its failure reducer isolates a minimal command sequence", () => {
	for (const seedIndex of [0, 1, 127, 9_999]) {
		assert.deepEqual(sequenceForSeed(seedIndex), sequenceForSeed(seedIndex));
	}
	const failure = ["PREPARE", "REVIEW_CORRUPT", "REPLAY", "PROMOTE"] as const;
	const minimized = shrinkFailingSequence(
		failure,
		(candidate) => candidate.includes("REVIEW_CORRUPT") && candidate.includes("PROMOTE"),
	);
	assert.equal(minimized.length, 2);
	assert.ok(minimized.includes("REVIEW_CORRUPT"));
	assert.ok(minimized.includes("PROMOTE"));
});

test("WP6 AC02: 10,000 fixed-seed generated lifecycle sequences satisfy safety, determinism, idempotency, convergence, isolation and promotion strictness", () => {
	const actions = new Set<DelegationLifecyclePrimaryActionNameV1>();
	const states = new Set<DelegationLifecycleStateV1>();
	const commands = new Set<ModelCommand>();
	for (let seedIndex = 0; seedIndex < MODEL_SEQUENCE_COUNT; seedIndex += 1) {
		const seed = (BASE_SEED + Math.imul(seedIndex + 1, 0x9e3779b1)) >>> 0;
		const sequence = sequenceForSeed(seedIndex);
		sequence.forEach((command) => commands.add(command));
		try {
			for (const item of runSequence(sequence)) {
				actions.add(item.action);
				states.add(item.state);
			}
		} catch (error) {
			const minimized = shrinkFailingSequence(sequence, (candidate) => {
				try {
					runSequence(candidate);
					return false;
				} catch {
					return true;
				}
			});
			assert.fail([
				`WP6 model failure seed=${seed}`,
				`replay=${JSON.stringify(sequence)}`,
				`minimized=${JSON.stringify(minimized)}`,
				`cause=${error instanceof Error ? error.message : String(error)}`,
			].join("\n"));
		}
	}
	assert.equal(MODEL_SEQUENCE_COUNT, 10_000);
	assert.deepEqual([...commands].sort(), [...MODEL_COMMANDS].sort(), "the command model must exercise every declared command");
	assert.deepEqual([...actions].sort(), [...DELEGATION_LIFECYCLE_PRIMARY_ACTIONS_V1].sort(), "generated histories must cover every action");
	assert.deepEqual([...states].sort(), [...DELEGATION_LIFECYCLE_STATES_V1].sort(), "generated histories must cover every canonical state");
});
