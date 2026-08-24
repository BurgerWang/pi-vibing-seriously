import assert from "node:assert/strict";
import { test } from "node:test";

import {
	abortDelegationTransaction,
	bindDelegationRepairLineageV1,
	beginDelegationCommit,
	computeDelegationRepairLineageHashV1,
	createPreparedDelegationTransaction,
	DELEGATION_COMMITTED_RECORD_NAMES,
	DELEGATION_POSTCONDITION_REASON_ORDER,
	DELEGATION_TRANSACTION_MAX_BYTES,
	delegationCommitMarker,
	evaluateDelegationPostconditions,
	parseDelegationTransaction,
	publishDelegationCommit,
	requireDelegationRecovery,
	reviewDelegationTransaction,
	serializeDelegationTransaction,
	startDelegationTransaction,
	type DelegationCasInput,
	type DelegationCommittedGenerationProof,
	type DelegationRepairLineageV1,
	type DelegationTaskKind,
	type DelegationTerminalOutcome,
	type DelegationTransactionRecord,
	type DelegationTransactionResult,
	type DelegationWorkerIdentity,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import {
	WORKER_MODEL_ID,
	WORKER_PROVIDER,
} from "../extensions/workbench-runtime/core/worker-policy.ts";

const ID = "20260817-120000-Ab12";
const OTHER_ID = "20260817-120001-Cd34";
const CONTRACT_HASH = "a".repeat(64);
const OTHER_CONTRACT_HASH = "b".repeat(64);
const DELTA_HASH = "c".repeat(64);
const CONTENT_HASH = "d".repeat(64);
const REVIEW_HASH = "e".repeat(64);
const T0 = "2026-08-17T05:00:00.000Z";
const T1 = "2026-08-17T05:00:01.000Z";
const T2 = "2026-08-17T05:00:02.000Z";
const T3 = "2026-08-17T05:00:03.000Z";
const T4 = "2026-08-17T05:00:04.000Z";
const INVALID_SOURCE_STATE_ERROR = "invalid delegation transaction source state";

function repairLineage(overrides: Partial<DelegationRepairLineageV1> = {}): DelegationRepairLineageV1 {
	const lineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: OTHER_ID,
		repair_of: OTHER_ID,
		root_decision_hash: "9".repeat(64),
		continuation_decision_delegation_id: OTHER_ID,
		continuation_decision_hash: "9".repeat(64),
		parent_lineage_hash: null,
		depth: 1,
		carried_paths: ["src/a.ts", "src/z.ts"],
	});
	assert.ok(lineage);
	return { ...lineage, ...overrides };
}

const IDENTITY: DelegationWorkerIdentity = {
	provider: WORKER_PROVIDER,
	model: WORKER_MODEL_ID,
	worker_id: "worker-A",
};

function ok(result: DelegationTransactionResult): DelegationTransactionRecord {
	assert.equal(result.ok, true, result.ok ? "" : result.error);
	return result.state;
}

function prepared(kind: DelegationTaskKind = "implementation", allowedPaths: readonly string[] = ["src/**"]): DelegationTransactionRecord {
	return ok(createPreparedDelegationTransaction({
		delegation_id: ID,
		task_kind: kind,
		contract_hash: CONTRACT_HASH,
		allowed_paths: allowedPaths,
		worker_identity: IDENTITY,
		generation: 1,
		now: T0,
	}));
}

function cas(state: DelegationTransactionRecord, now: string): DelegationCasInput {
	return {
		delegation_id: state.delegation_id,
		contract_hash: state.contract_hash,
		worker_identity: state.worker_identity,
		expected_generation: state.generation,
		expected_revision: state.revision,
		now,
	};
}

function running(kind: DelegationTaskKind = "implementation", allowedPaths?: readonly string[]): DelegationTransactionRecord {
	const state = prepared(kind, allowedPaths);
	return ok(startDelegationTransaction(state, cas(state, T1)));
}

function terminalOutcome(
	state: DelegationTransactionRecord,
	overrides: Partial<DelegationTerminalOutcome> = {},
): DelegationTerminalOutcome {
	const implementation = state.task_kind === "implementation";
	return {
		delegation_id: state.delegation_id,
		task_kind: state.task_kind,
		worker_identity: state.worker_identity,
		provider_success: true,
		exit_code: 0,
		report_complete: true,
		terminal_facts_complete: true,
		scope_complete: true,
		change_set_status: "ATTRIBUTED",
		changed_paths: implementation ? ["src/main.ts"] : [],
		successful_write_count: implementation ? 1 : 0,
		denied_write_count: 0,
		delta_hash: implementation ? DELTA_HASH : null,
		...overrides,
	};
}

function committing(
	kind: DelegationTaskKind = "implementation",
	overrides: Partial<DelegationTerminalOutcome> = {},
	allowedPaths?: readonly string[],
): DelegationTransactionRecord {
	const state = running(kind, allowedPaths);
	return ok(beginDelegationCommit(state, { ...cas(state, T2), outcome: terminalOutcome(state, overrides) }));
}

function committedProof(state: DelegationTransactionRecord): DelegationCommittedGenerationProof {
	const withoutMarker: Omit<DelegationCommittedGenerationProof, "commit_marker"> = {
		schema_version: 2,
		delegation_id: state.delegation_id,
		task_kind: state.task_kind,
		contract_hash: state.contract_hash,
		worker_identity: state.worker_identity,
		generation: state.generation,
		revision: state.revision,
		record_names: [...DELEGATION_COMMITTED_RECORD_NAMES],
		record_count: DELEGATION_COMMITTED_RECORD_NAMES.length,
		content_hash: CONTENT_HASH,
	};
	return { ...withoutMarker, commit_marker: delegationCommitMarker(withoutMarker) };
}

function proofAtRevision(
	proof: DelegationCommittedGenerationProof,
	revision: number,
): DelegationCommittedGenerationProof {
	const { commit_marker: _oldMarker, ...withoutMarker } = proof;
	const rebound = { ...withoutMarker, revision };
	return { ...rebound, commit_marker: delegationCommitMarker(rebound) };
}

function publish(state: DelegationTransactionRecord): DelegationTransactionRecord {
	return ok(publishDelegationCommit(state, { ...cas(state, T3), proof: committedProof(state) }));
}

test("PREPARED freezes schema v2, exact contract hash, pinned worker identity, paths, generation and revision", () => {
	const rawPaths = ["tests/exact.test.ts", "src/**"];
	const state = prepared("implementation", rawPaths);
	assert.equal(state.schema_version, 2);
	assert.equal(state.status, "PREPARED");
	assert.equal(state.contract_hash, CONTRACT_HASH);
	assert.deepEqual(state.worker_identity, { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: "worker-A" });
	assert.deepEqual(state.allowed_paths, ["src/**", "tests/exact.test.ts"]);
	assert.deepEqual(rawPaths, ["tests/exact.test.ts", "src/**"], "prepare does not sort the caller-owned input");
	assert.equal(state.generation, 1);
	assert.equal(state.revision, 0);
});

test("committed generation inventory preserves the existing authority record names", () => {
	assert.deepEqual(DELEGATION_COMMITTED_RECORD_NAMES, [
		"after.json",
		"before.json",
		"identity.json",
		"review.json",
		"scope.json",
		"usage.json",
		"worker-report.md",
		"worker-summary.json",
	]);
});

test("prepare rejects mechanical, malformed contract hash, wrong worker identity, unsafe paths and duplicates", () => {
	const base = {
		delegation_id: ID,
		task_kind: "implementation",
		contract_hash: CONTRACT_HASH,
		allowed_paths: ["src/**"],
		worker_identity: IDENTITY,
		generation: 1,
		now: T0,
	};
	assert.match(createPreparedDelegationTransaction({ ...base, task_kind: "mechanical" }).ok ? "" : (createPreparedDelegationTransaction({ ...base, task_kind: "mechanical" }) as { error: string }).error, /not enabled/);
	for (const contract_hash of ["", "A".repeat(64), "a".repeat(63), `${"a".repeat(64)}0`]) {
		assert.equal(createPreparedDelegationTransaction({ ...base, contract_hash }).ok, false);
	}
	assert.equal(createPreparedDelegationTransaction({ ...base, worker_identity: { ...IDENTITY, provider: "openai" } }).ok, false);
	assert.equal(createPreparedDelegationTransaction({ ...base, worker_identity: { ...IDENTITY, model: "deepseek-v3" } }).ok, false);
	for (const allowed_paths of [[], ["../escape"], ["/absolute"], ["src\\file.ts"], ["src/**", "src/**"]]) {
		assert.equal(createPreparedDelegationTransaction({ ...base, allowed_paths }).ok, false);
	}
});

test("implementation follows PREPARED → RUNNING → COMMITTING → PENDING_REVIEW → REVIEWED with monotonic revisions", () => {
	const states: DelegationTransactionRecord[] = [prepared()];
	states.push(ok(startDelegationTransaction(states[0]!, cas(states[0]!, T1))));
	states.push(ok(beginDelegationCommit(states[1]!, { ...cas(states[1]!, T2), outcome: terminalOutcome(states[1]!) })));
	states.push(publish(states[2]!));
	states.push(ok(reviewDelegationTransaction(states[3]!, { ...cas(states[3]!, T4), review_hash: REVIEW_HASH })));
	assert.deepEqual(states.map((state) => state.status), ["PREPARED", "RUNNING", "COMMITTING", "PENDING_REVIEW", "REVIEWED"]);
	assert.deepEqual(states.map((state) => state.revision), [0, 1, 2, 3, 4]);
	assert.equal(states[3]!.committed_proof?.contract_hash, CONTRACT_HASH, "published proof binds the approved contract");
	assert.equal(states[4]!.review?.transaction_revision, 3);
});

test("diagnosis succeeds only as FINISHED with zero delta, zero successful writes and zero denied writes", () => {
	const state = committing("diagnosis");
	assert.deepEqual(state.postcondition_reasons, []);
	const finished = publish(state);
	assert.equal(finished.status, "FINISHED");
	assert.equal(reviewDelegationTransaction(finished, { ...cas(finished, T4), review_hash: REVIEW_HASH }).ok, false);
});

test("implementation zero delta cannot succeed even with provider success, exit 0 and a complete report", () => {
	const state = committing("implementation", { changed_paths: [], successful_write_count: 0, delta_hash: null });
	assert.deepEqual(state.postcondition_reasons, ["IMPLEMENTATION_DELTA_REQUIRED", "IMPLEMENTATION_DELTA_HASH_REQUIRED"]);
	assert.equal(publish(state).status, "FAILED");
});

test("diagnosis delta, successful writes, and denied writes each fail closed", () => {
	const state = committing("diagnosis", {
		changed_paths: ["src/main.ts"],
		successful_write_count: 1,
		denied_write_count: 1,
		delta_hash: DELTA_HASH,
	});
	assert.deepEqual(state.postcondition_reasons, [
		"DIAGNOSIS_DELTA_FORBIDDEN",
		"DIAGNOSIS_SUCCESSFUL_WRITES_FORBIDDEN",
		"DIAGNOSIS_DENIED_WRITES_FORBIDDEN",
	]);
	assert.equal(publish(state).status, "FAILED");
});

test("postcondition reasons have fixed order and are independent of worker prose", () => {
	const state = running("implementation", ["src/**"]);
	const outcome = terminalOutcome(state, {
		provider_success: false,
		exit_code: 9,
		report_complete: false,
		terminal_facts_complete: false,
		scope_complete: false,
		changed_paths: ["outside.ts"],
		successful_write_count: 0,
		delta_hash: null,
	});
	const reasons = evaluateDelegationPostconditions(state, outcome);
	assert.deepEqual(reasons, [
		"PROVIDER_NOT_SUCCESS",
		"EXIT_CODE_NOT_ZERO",
		"REPORT_INCOMPLETE",
		"TERMINAL_FACTS_INCOMPLETE",
		"SCOPE_INCOMPLETE",
		"OUT_OF_SCOPE_CHANGES",
		"IMPLEMENTATION_DELTA_HASH_REQUIRED",
	]);
	assert.deepEqual(reasons, DELEGATION_POSTCONDITION_REASON_ORDER.filter((reason) => reasons.includes(reason)));
});

test("complete workspace drift and ChangeSet conflicts commit immutable FAILED evidence in fixed order", () => {
	const drift = committing("implementation", { change_set_status: "WORKSPACE_DRIFT" });
	assert.deepEqual(drift.postcondition_reasons, ["WORKSPACE_DRIFT_DETECTED"]);
	assert.equal(publish(drift).status, "FAILED");

	const conflict = committing("implementation", {
		report_complete: false,
		change_set_status: "CONFLICT",
		changed_paths: ["outside.ts"],
	});
	assert.deepEqual(conflict.postcondition_reasons, [
		"REPORT_INCOMPLETE",
		"CHANGE_SET_CONFLICT",
		"OUT_OF_SCOPE_CHANGES",
	]);
	assert.equal(publish(conflict).status, "FAILED");
});

test("incomplete scope remains RECOVERY_REQUIRED even when ChangeSet evidence is attributed", () => {
	const incomplete = committing("implementation", { scope_complete: false, change_set_status: "ATTRIBUTED" });
	assert.deepEqual(incomplete.postcondition_reasons, ["SCOPE_INCOMPLETE"]);
	assert.equal(publish(incomplete).status, "RECOVERY_REQUIRED");
});

test("OUT_OF_SCOPE_CHANGES is computed from changed_paths even when outcome claims scope_complete", () => {
	const exact = running("implementation", ["src/exact.ts"]);
	const exactOutcome = terminalOutcome(exact, { changed_paths: ["src/exact.ts.extra"] });
	assert.equal(exactOutcome.scope_complete, true);
	assert.deepEqual(evaluateDelegationPostconditions(exact, exactOutcome), ["OUT_OF_SCOPE_CHANGES"]);

	const subtree = running("implementation", ["src/**"]);
	assert.deepEqual(evaluateDelegationPostconditions(subtree, terminalOutcome(subtree, { changed_paths: ["src/nested/a.ts"] })), []);
	assert.deepEqual(evaluateDelegationPostconditions(subtree, terminalOutcome(subtree, { changed_paths: ["src2/a.ts"] })), ["OUT_OF_SCOPE_CHANGES"]);
});

test("complete failure facts can publish only FAILED; incomplete terminal or scope facts require recovery", () => {
	const failed = publish(committing("implementation", { provider_success: false, exit_code: 1 }));
	assert.equal(failed.status, "FAILED");
	assert.deepEqual(failed.postcondition_reasons, ["PROVIDER_NOT_SUCCESS", "EXIT_CODE_NOT_ZERO"]);
	assert.equal(reviewDelegationTransaction(failed, { ...cas(failed, T4), review_hash: REVIEW_HASH }).ok, false);

	const incomplete = publish(committing("implementation", { terminal_facts_complete: false }));
	assert.equal(incomplete.status, "RECOVERY_REQUIRED");
	assert.match(incomplete.recovery_reason ?? "", /incomplete/);
	const unknownScope = publish(committing("implementation", { scope_complete: false }));
	assert.equal(unknownScope.status, "RECOVERY_REQUIRED");
});

test("CAS rejects old revision, competing/repeated transition, wrong generation and non-monotonic time", () => {
	const before = prepared();
	const startInput = cas(before, T1);
	const first = ok(startDelegationTransaction(before, startInput));
	assert.match(startDelegationTransaction(first, startInput).ok ? "" : (startDelegationTransaction(first, startInput) as { error: string }).error, /revision CAS mismatch/);
	assert.equal(startDelegationTransaction(first, { ...cas(first, T2), expected_generation: 2 }).ok, false);
	assert.equal(beginDelegationCommit(first, { ...cas(first, T0), outcome: terminalOutcome(first) }).ok, false);

	const commit = ok(beginDelegationCommit(first, { ...cas(first, T2), outcome: terminalOutcome(first) }));
	const finishInput = { ...cas(commit, T3), proof: committedProof(commit) };
	const published = ok(publishDelegationCommit(commit, finishInput));
	assert.match(publishDelegationCommit(published, finishInput).ok ? "" : (publishDelegationCommit(published, finishInput) as { error: string }).error, /revision CAS mismatch/);
	assert.equal(publishDelegationCommit(published, { ...cas(published, T4), proof: committedProof(commit) }).ok, false);
});

test("every transition rejects delegation, contract, or worker identity conflicts without mutating state", () => {
	const state = prepared();
	const snapshot = structuredClone(state);
	assert.equal(startDelegationTransaction(state, { ...cas(state, T1), delegation_id: OTHER_ID }).ok, false);
	assert.equal(startDelegationTransaction(state, { ...cas(state, T1), contract_hash: OTHER_CONTRACT_HASH }).ok, false);
	assert.equal(startDelegationTransaction(state, { ...cas(state, T1), worker_identity: { ...IDENTITY, worker_id: "worker-B" } }).ok, false);
	assert.deepEqual(state, snapshot);

	const run = running();
	assert.equal(beginDelegationCommit(run, { ...cas(run, T2), outcome: { ...terminalOutcome(run), delegation_id: OTHER_ID } }).ok, false);
	assert.equal(beginDelegationCommit(run, { ...cas(run, T2), outcome: { ...terminalOutcome(run), task_kind: "diagnosis" } }).ok, false);
	assert.equal(beginDelegationCommit(run, { ...cas(run, T2), outcome: { ...terminalOutcome(run), worker_identity: { ...IDENTITY, worker_id: "worker-B" } } }).ok, false);
});

test("only an exact committed generation proof can expose PENDING_REVIEW or FINISHED", () => {
	const state = committing();
	const valid = committedProof(state);
	const invalid: DelegationCommittedGenerationProof[] = [
		{ ...valid, delegation_id: OTHER_ID },
		{ ...valid, contract_hash: OTHER_CONTRACT_HASH },
		{ ...valid, generation: 2 },
		{ ...valid, revision: state.revision - 1 },
		{ ...valid, record_count: valid.record_count - 1 },
		{ ...valid, record_names: valid.record_names.slice(0, -1) },
		{ ...valid, record_names: [...valid.record_names.slice(0, -1), "foreign.json" as never] },
		{ ...valid, content_hash: "not-a-hash" },
		{ ...valid, commit_marker: "foreign-marker" },
	];
	for (const proof of invalid) {
		const result = publishDelegationCommit(state, { ...cas(state, T3), proof });
		assert.equal(result.ok, false, JSON.stringify(proof));
		assert.equal(state.status, "COMMITTING", "rejected proof leaves the source state unchanged");
	}
	assert.equal(reviewDelegationTransaction(state, { ...cas(state, T3), review_hash: REVIEW_HASH }).ok, false);
	assert.equal(publish(state).status, "PENDING_REVIEW");
});

test("strict parser/serializer round-trips and returns detached data", () => {
	const state = publish(committing());
	const parsed = parseDelegationTransaction(structuredClone(state));
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
	assert.deepEqual(parsed.state, state);
	assert.notEqual(parsed.state, state);
	assert.notEqual(parsed.state.allowed_paths, state.allowed_paths);
	assert.notEqual(parsed.state.committed_proof, state.committed_proof);
	assert.deepEqual(serializeDelegationTransaction(state), state);
});

test("repair lineage is optional for old records, strict for new records, and immutable across lifecycle transitions", () => {
	const legacy = prepared();
	assert.equal(legacy.repair_lineage, undefined);
	assert.equal(parseDelegationTransaction(legacy).ok, true);

	const lineage = repairLineage();
	assert.equal(lineage.lineage_hash, computeDelegationRepairLineageHashV1(lineage));
	const created = ok(createPreparedDelegationTransaction({
		delegation_id: ID,
		task_kind: "implementation",
		contract_hash: CONTRACT_HASH,
		allowed_paths: ["src/**"],
		worker_identity: IDENTITY,
		generation: 1,
		now: T0,
		repair_lineage: lineage,
	}));
	assert.deepEqual(created.repair_lineage, lineage);
	assert.notEqual(created.repair_lineage, lineage);
	assert.notEqual(created.repair_lineage!.carried_paths, lineage.carried_paths);
	const started = ok(startDelegationTransaction(created, cas(created, T1)));
	const committed = ok(beginDelegationCommit(started, { ...cas(started, T2), outcome: terminalOutcome(started) }));
	const pending = ok(publishDelegationCommit(committed, { ...cas(committed, T3), proof: committedProof(committed) }));
	assert.deepEqual(started.repair_lineage, lineage);
	assert.deepEqual(committed.repair_lineage, lineage);
	assert.deepEqual(pending.repair_lineage, lineage);
	assert.deepEqual(serializeDelegationTransaction(pending).repair_lineage, lineage);
});

test("repair lineage rejects diagnosis, malformed ancestry, unsorted paths, unknown fields, and hash tampering", () => {
	const lineage = repairLineage();
	const input = {
		delegation_id: ID,
		task_kind: "implementation",
		contract_hash: CONTRACT_HASH,
		allowed_paths: ["src/**"],
		worker_identity: IDENTITY,
		generation: 1,
		now: T0,
		repair_lineage: lineage,
	};
	assert.equal(createPreparedDelegationTransaction({ ...input, task_kind: "diagnosis" }).ok, false);
	for (const repair_lineage of [
		{ ...lineage, lineage_hash: "0".repeat(64) },
		{ ...lineage, carried_paths: ["src/z.ts", "src/a.ts"] },
		{ ...lineage, depth: 2 },
		{ ...lineage, parent_lineage_hash: "8".repeat(64) },
		{ ...lineage, unknown: true },
	]) {
		assert.equal(createPreparedDelegationTransaction({ ...input, repair_lineage } as typeof input).ok, false);
	}
	const withLineage = ok(createPreparedDelegationTransaction(input));
	assert.equal(parseDelegationTransaction({ ...withLineage, repair_lineage: { ...lineage, lineage_hash: "0".repeat(64) } }).ok, false);
});

test("strict parser rejects unknown fields at every authority layer", () => {
	const pending = publish(committing());
	const cases: unknown[] = [
		{ ...pending, unknown: true },
		{ ...pending, worker_identity: { ...pending.worker_identity, unknown: true } },
		{ ...pending, terminal_outcome: { ...pending.terminal_outcome, worker_prose: "SUCCESS" } },
		{ ...pending, committed_proof: { ...pending.committed_proof, unknown: true } },
	];
	const reviewed = ok(reviewDelegationTransaction(pending, { ...cas(pending, T4), review_hash: REVIEW_HASH }));
	cases.push({ ...reviewed, review: { ...reviewed.review, unknown: true } });
	for (const value of cases) assert.equal(parseDelegationTransaction(value).ok, false);
});

test("every public transition rejects a closed-schema-invalid source before CAS and leaves it unchanged", () => {
	const prepForStart = prepared();
	const runForCommit = running();
	const commitForPublish = committing();
	const pendingForReview = publish(committing());
	const prepForAbort = prepared();
	const runForRecovery = running();
	const cases: Array<{
		name: string;
		source: DelegationTransactionRecord;
		invoke: (source: DelegationTransactionRecord) => DelegationTransactionResult;
	}> = [
		{
			name: "start",
			source: { ...prepForStart, unknown: true } as unknown as DelegationTransactionRecord,
			invoke: (source) => startDelegationTransaction(source, { ...cas(source, T1), delegation_id: OTHER_ID }),
		},
		{
			name: "begin commit",
			source: { ...runForCommit, unknown: true } as unknown as DelegationTransactionRecord,
			invoke: (source) => beginDelegationCommit(source, { ...cas(source, T2), outcome: terminalOutcome(source) }),
		},
		{
			name: "publish",
			source: { ...commitForPublish, unknown: true } as unknown as DelegationTransactionRecord,
			invoke: (source) => publishDelegationCommit(source, { ...cas(source, T3), proof: committedProof(source) }),
		},
		{
			name: "review",
			source: { ...pendingForReview, unknown: true } as unknown as DelegationTransactionRecord,
			invoke: (source) => reviewDelegationTransaction(source, { ...cas(source, T4), review_hash: REVIEW_HASH }),
		},
		{
			name: "abort",
			source: { ...prepForAbort, unknown: true } as unknown as DelegationTransactionRecord,
			invoke: (source) => abortDelegationTransaction(source, { ...cas(source, T1), reason: "cancelled" }),
		},
		{
			name: "require recovery",
			source: { ...runForRecovery, unknown: true } as unknown as DelegationTransactionRecord,
			invoke: (source) => requireDelegationRecovery(source, { ...cas(source, T2), reason: "ambiguous child state" }),
		},
	];

	for (const entry of cases) {
		const snapshot = structuredClone(entry.source);
		const result = entry.invoke(entry.source);
		assert.equal(result.ok, false, entry.name);
		assert.equal(result.ok ? "" : result.error, INVALID_SOURCE_STATE_ERROR, entry.name);
		assert.deepEqual(entry.source, snapshot, `${entry.name} must not mutate invalid source state`);
	}
});

test("tampered source authority cannot bypass commit or review postconditions", () => {
	const failedCommit = committing("implementation", { provider_success: false, exit_code: 9, report_complete: false });
	assert.deepEqual(failedCommit.postcondition_reasons, ["PROVIDER_NOT_SUCCESS", "EXIT_CODE_NOT_ZERO", "REPORT_INCOMPLETE"]);
	const erasedReasons = { ...failedCommit, postcondition_reasons: [] };
	const publishResult = publishDelegationCommit(erasedReasons, { ...cas(erasedReasons, T3), proof: committedProof(erasedReasons) });
	assert.equal(publishResult.ok, false);
	assert.equal(publishResult.ok ? "" : publishResult.error, INVALID_SOURCE_STATE_ERROR);

	const run = running();
	const unsafeScope = { ...run, allowed_paths: ["../escape"] };
	const beginResult = beginDelegationCommit(unsafeScope, { ...cas(unsafeScope, T2), outcome: terminalOutcome(unsafeScope) });
	assert.equal(beginResult.ok, false);
	assert.equal(beginResult.ok ? "" : beginResult.error, INVALID_SOURCE_STATE_ERROR);

	const pending = publish(committing());
	const corruptProof = {
		...pending,
		committed_proof: { ...pending.committed_proof!, revision: pending.committed_proof!.revision - 1 },
	};
	const prematureReview = {
		...pending,
		review: {
			delegation_id: pending.delegation_id,
			generation: pending.generation,
			transaction_revision: pending.revision,
			review_hash: REVIEW_HASH,
			reviewed_at: T4,
			reviewer: "sol" as const,
		},
	};
	for (const source of [corruptProof, prematureReview]) {
		const result = reviewDelegationTransaction(source, { ...cas(source, T4), review_hash: REVIEW_HASH });
		assert.equal(result.ok, false);
		assert.equal(result.ok ? "" : result.error, INVALID_SOURCE_STATE_ERROR);
	}
});

test("public transitions fail closed without throwing for oversized or non-serializable source state", () => {
	const base = prepared();
	const oversized = { ...base, padding: "x".repeat(DELEGATION_TRANSACTION_MAX_BYTES) } as unknown as DelegationTransactionRecord;
	assert.doesNotThrow(() => {
		const result = startDelegationTransaction(oversized, cas(oversized, T1));
		assert.equal(result.ok, false);
		assert.equal(result.ok ? "" : result.error, INVALID_SOURCE_STATE_ERROR);
	});

	const circular = { ...base } as DelegationTransactionRecord & { circular?: unknown };
	circular.circular = circular;
	assert.doesNotThrow(() => {
		const result = abortDelegationTransaction(circular, { ...cas(circular, T1), reason: "cancelled" });
		assert.equal(result.ok, false);
		assert.equal(result.ok ? "" : result.error, INVALID_SOURCE_STATE_ERROR);
	});
});

test("strict parser rejects unknown schema/status/task, malformed ids/hashes/times/revisions and oversized input", () => {
	const state = prepared();
	const invalid: unknown[] = [
		{ ...state, schema_version: 1 },
		{ ...state, schema_version: 3 },
		{ ...state, status: "SUCCESS" },
		{ ...state, task_kind: "mechanical" },
		{ ...state, delegation_id: "../escape" },
		{ ...state, contract_hash: "A".repeat(64) },
		{ ...state, created_at: "yesterday" },
		{ ...state, updated_at: "2026-08-17T04:00:00.000Z" },
		{ ...state, revision: -1 },
		{ ...state, revision: 1.5 },
		{ ...state, generation: 0 },
		{ ...state, allowed_paths: ["src/**", "src/**"] },
	];
	for (const value of invalid) assert.equal(parseDelegationTransaction(value).ok, false);
	const oversized = { ...state, padding: "x".repeat(DELEGATION_TRANSACTION_MAX_BYTES) };
	const result = parseDelegationTransaction(oversized);
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.error, /exceeds/);
	assert.throws(() => serializeDelegationTransaction({ ...state, revision: -1 }), /invalid delegation transaction/);
});

test("parser binds every lifecycle status to its exact reachable revision", () => {
	const preparedState = prepared();
	const runningState = running();
	const committingState = committing();
	const pendingState = publish(committingState);
	const finishedState = publish(committing("diagnosis"));
	const reviewedState = ok(reviewDelegationTransaction(pendingState, { ...cas(pendingState, T4), review_hash: REVIEW_HASH }));
	const failedState = publish(committing("implementation", { provider_success: false, exit_code: 1 }));
	const abortedPrepared = ok(abortDelegationTransaction(prepared(), { ...cas(preparedState, T1), reason: "cancelled before launch" }));
	const abortedRunning = ok(abortDelegationTransaction(runningState, { ...cas(runningState, T2), reason: "cancelled after launch" }));
	const recoveryRunning = ok(requireDelegationRecovery(runningState, { ...cas(runningState, T2), reason: "running state ambiguous" }));
	const recoveryCommitting = ok(requireDelegationRecovery(committingState, { ...cas(committingState, T3), reason: "commit state ambiguous" }));
	const recoveryPublished = publish(committing("implementation", { terminal_facts_complete: false }));

	const legal = [
		preparedState,
		runningState,
		committingState,
		pendingState,
		finishedState,
		reviewedState,
		failedState,
		abortedPrepared,
		abortedRunning,
		recoveryRunning,
		recoveryCommitting,
		recoveryPublished,
	];
	for (const state of legal) {
		assert.equal(parseDelegationTransaction(state).ok, true, `${state.status}@${state.revision} must remain reachable`);
	}

	const wrongRevisionCases: Array<{ name: string; source: DelegationTransactionRecord; revision: number }> = [
		{ name: "PREPARED", source: preparedState, revision: 9 },
		{ name: "RUNNING", source: runningState, revision: 0 },
		{ name: "COMMITTING", source: committingState, revision: 1 },
		{ name: "PENDING_REVIEW", source: pendingState, revision: 2 },
		{ name: "FINISHED", source: finishedState, revision: 4 },
		{ name: "REVIEWED", source: reviewedState, revision: 3 },
		{ name: "FAILED", source: failedState, revision: 4 },
		{ name: "ABORTED", source: abortedPrepared, revision: 0 },
		{ name: "RECOVERY_REQUIRED", source: recoveryRunning, revision: 1 },
	];
	for (const entry of wrongRevisionCases) {
		const source = { ...entry.source, revision: entry.revision };
		assert.equal(parseDelegationTransaction(source).ok, false, `${entry.name} accepted revision ${entry.revision}`);
	}
});

test("RECOVERY_REQUIRED parser accepts only the three reachable authority shapes", () => {
	const run = running();
	const commit = committing();
	const runningRecovery = ok(requireDelegationRecovery(run, { ...cas(run, T2), reason: "running state ambiguous" }));
	const committingRecovery = ok(requireDelegationRecovery(commit, { ...cas(commit, T3), reason: "commit state ambiguous" }));
	const publishedRecovery = publish(committing("implementation", { terminal_facts_complete: false }));
	const pending = publish(committing());
	const reviewed = ok(reviewDelegationTransaction(pending, { ...cas(pending, T4), review_hash: REVIEW_HASH }));

	for (const state of [runningRecovery, committingRecovery, publishedRecovery]) {
		assert.equal(parseDelegationTransaction(state).ok, true, `reachable recovery shape ${state.revision}/${state.committed_proof !== null}`);
	}

	const validProofWithWrongRevision = proofAtRevision(publishedRecovery.committed_proof!, 1);
	const invalid: Array<{ name: string; source: DelegationTransactionRecord }> = [
		{ name: "running recovery at revision 3 without outcome", source: { ...runningRecovery, revision: 3 } },
		{
			name: "running recovery carrying an outcome at revision 2",
			source: {
				...runningRecovery,
				terminal_outcome: terminalOutcome(run),
			},
		},
		{ name: "committing recovery at revision 2", source: { ...committingRecovery, revision: 2 } },
		{ name: "committing recovery without its outcome", source: { ...committingRecovery, terminal_outcome: null } },
		{
			name: "published recovery with a proof bound to revision 1",
			source: { ...publishedRecovery, committed_proof: validProofWithWrongRevision },
		},
		{
			name: "recovery carrying a proof without an outcome",
			source: {
				...runningRecovery,
				revision: 3,
				committed_proof: proofAtRevision(publishedRecovery.committed_proof!, 2),
			},
		},
		{ name: "recovery at revision 4", source: { ...publishedRecovery, revision: 4 } },
		{ name: "recovery carrying review authority", source: { ...publishedRecovery, review: reviewed.review } },
	];
	for (const entry of invalid) {
		assert.equal(parseDelegationTransaction(entry.source).ok, false, entry.name);
	}
});

test("public transitions reject forged lifecycle revisions before CAS or status handling", () => {
	const preparedState = prepared();
	const runningState = running();
	const committingState = committing();
	const pendingState = publish(committingState);
	const finishedState = publish(committing("diagnosis"));
	const reviewedState = ok(reviewDelegationTransaction(pendingState, { ...cas(pendingState, T4), review_hash: REVIEW_HASH }));
	const failedState = publish(committing("implementation", { provider_success: false, exit_code: 1 }));
	const abortedState = ok(abortDelegationTransaction(preparedState, { ...cas(preparedState, T1), reason: "cancelled" }));
	const recoveryState = ok(requireDelegationRecovery(runningState, { ...cas(runningState, T2), reason: "ambiguous" }));

	const cases: Array<{
		name: string;
		source: DelegationTransactionRecord;
		invoke: (source: DelegationTransactionRecord) => DelegationTransactionResult;
	}> = [
		{
			name: "PREPARED",
			source: { ...preparedState, revision: 9 },
			invoke: (source) => startDelegationTransaction(source, cas(source, T4)),
		},
		{
			name: "RUNNING",
			source: { ...runningState, revision: 0 },
			invoke: (source) => beginDelegationCommit(source, { ...cas(source, T4), outcome: terminalOutcome(source) }),
		},
		{
			name: "COMMITTING",
			source: { ...committingState, revision: 1 },
			invoke: (source) => publishDelegationCommit(source, { ...cas(source, T4), proof: committedProof(source) }),
		},
		{
			name: "PENDING_REVIEW",
			source: { ...pendingState, revision: 2 },
			invoke: (source) => reviewDelegationTransaction(source, { ...cas(source, T4), review_hash: REVIEW_HASH }),
		},
		{
			name: "FINISHED",
			source: { ...finishedState, revision: 4 },
			invoke: (source) => abortDelegationTransaction(source, { ...cas(source, T4), reason: "forged" }),
		},
		{
			name: "REVIEWED",
			source: { ...reviewedState, revision: 3 },
			invoke: (source) => requireDelegationRecovery(source, { ...cas(source, T4), reason: "forged" }),
		},
		{
			name: "FAILED",
			source: { ...failedState, revision: 4 },
			invoke: (source) => abortDelegationTransaction(source, { ...cas(source, T4), reason: "forged" }),
		},
		{
			name: "ABORTED",
			source: { ...abortedState, revision: 0 },
			invoke: (source) => startDelegationTransaction(source, cas(source, T4)),
		},
		{
			name: "RECOVERY_REQUIRED",
			source: { ...recoveryState, revision: 1 },
			invoke: (source) => requireDelegationRecovery(source, { ...cas(source, T4), reason: "forged" }),
		},
	];

	for (const entry of cases) {
		const snapshot = structuredClone(entry.source);
		const result = entry.invoke(entry.source);
		assert.equal(result.ok, false, entry.name);
		assert.equal(result.ok ? "" : result.error, INVALID_SOURCE_STATE_ERROR, entry.name);
		assert.deepEqual(entry.source, snapshot, `${entry.name} source must remain untouched`);
	}
});

test("parser refuses partial/corrupt status combinations and reordered reason authority", () => {
	const committingState = committing("implementation", { provider_success: false, exit_code: 1 });
	assert.equal(parseDelegationTransaction({ ...committingState, terminal_outcome: null }).ok, false);
	assert.equal(parseDelegationTransaction({ ...committingState, status: "PENDING_REVIEW" }).ok, false);
	assert.equal(parseDelegationTransaction({ ...committingState, postcondition_reasons: [...committingState.postcondition_reasons].reverse() }).ok, false);
	const pending = publish(committing());
	assert.equal(parseDelegationTransaction({ ...pending, committed_proof: null }).ok, false);
	assert.equal(parseDelegationTransaction({ ...pending, committed_proof: { ...pending.committed_proof, revision: 0 } }).ok, false);
	assert.equal(parseDelegationTransaction({ ...pending, status: "REVIEWED", review: null }).ok, false);
});

test("terminal outcome paths must be sorted/unique and machine facts cannot carry prose", () => {
	const state = running();
	const duplicate = { ...terminalOutcome(state), changed_paths: ["src/main.ts", "src/main.ts"] };
	assert.equal(beginDelegationCommit(state, { ...cas(state, T2), outcome: duplicate }).ok, false);
	const unsorted = { ...terminalOutcome(state), changed_paths: ["src/z.ts", "src/a.ts"] };
	assert.equal(beginDelegationCommit(state, { ...cas(state, T2), outcome: unsorted }).ok, false);
	const withProse = { ...terminalOutcome(state), worker_prose: "SUCCESS despite facts" };
	assert.equal(beginDelegationCommit(state, { ...cas(state, T2), outcome: withProse }).ok, false);
	const { change_set_status: _missing, ...missingStatus } = terminalOutcome(state);
	assert.equal(beginDelegationCommit(state, { ...cas(state, T2), outcome: missingStatus as DelegationTerminalOutcome }).ok, false);
	assert.equal(beginDelegationCommit(state, {
		...cas(state, T2),
		outcome: { ...terminalOutcome(state), change_set_status: "UNKNOWN" } as unknown as DelegationTerminalOutcome,
	}).ok, false);
});

test("PREPARED and RUNNING may abort; RUNNING and COMMITTING may enter RECOVERY_REQUIRED", () => {
	const prep = prepared();
	assert.equal(ok(abortDelegationTransaction(prep, { ...cas(prep, T1), reason: "cancelled before launch" })).status, "ABORTED");
	const run = running();
	assert.equal(ok(abortDelegationTransaction(run, { ...cas(run, T2), reason: "child cancelled" })).status, "ABORTED");
	assert.equal(ok(requireDelegationRecovery(run, { ...cas(run, T2), reason: "child outcome ambiguous" })).status, "RECOVERY_REQUIRED");
	const commit = committing();
	assert.equal(ok(requireDelegationRecovery(commit, { ...cas(commit, T3), reason: "commit publication ambiguous" })).status, "RECOVERY_REQUIRED");
	assert.equal(abortDelegationTransaction(commit, { ...cas(commit, T3), reason: "too late" }).ok, false);
	assert.equal(requireDelegationRecovery(prep, { ...cas(prep, T1), reason: "not running" }).ok, false);
});

test("successful transitions are deterministic and never mutate state, outcome, proof, or CAS inputs", () => {
	const state = running();
	const outcome = terminalOutcome(state);
	const input = { ...cas(state, T2), outcome };
	const stateSnapshot = structuredClone(state);
	const inputSnapshot = structuredClone(input);
	const left = beginDelegationCommit(state, input);
	const right = beginDelegationCommit(state, input);
	assert.deepEqual(left, right);
	assert.deepEqual(state, stateSnapshot);
	assert.deepEqual(input, inputSnapshot);
	const commit = ok(left);
	const proof = committedProof(commit);
	const publishInput = { ...cas(commit, T3), proof };
	const publishSnapshot = structuredClone(publishInput);
	publishDelegationCommit(commit, publishInput);
	assert.deepEqual(publishInput, publishSnapshot);
});
