import assert from "node:assert/strict";
import test from "node:test";

import {
	admitProjectDelegationPathLaneV1,
	revalidateProjectDelegationPathLaneV1,
	type DelegationPathLaneAdmissionReadersV1,
} from "../extensions/workbench-runtime/core/delegation-path-lane-admission.ts";
import type { DelegationSemanticRepairDecisionV1 } from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	beginDelegationCommit,
	bindDelegationRepairLineageV1,
	createPreparedDelegationTransaction,
	DELEGATION_COMMITTED_RECORD_NAMES,
	delegationCommitMarker,
	publishDelegationCommit,
	reviewDelegationTransaction,
	startDelegationTransaction,
	type DelegationCommittedGenerationProof,
	type DelegationRepairLineageV1,
	type DelegationTransactionRecord,
	type DelegationTransactionResult,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";

const HASH = "a".repeat(64);
const DECISION_A = "b".repeat(64);
const DECISION_B = "c".repeat(64);
const ROOT_A = "20260827-100000-r001";
const TIP_A = "20260827-100001-t001";
const ROOT_B = "20260827-100002-r002";
const TIP_B = "20260827-100003-t002";
const ORDINARY = "20260827-100004-o001";

function at(offset: number): string {
	return new Date(Date.parse("2026-08-27T10:00:00.000Z") + offset * 1_000).toISOString();
}

function state(result: DelegationTransactionResult): DelegationTransactionRecord {
	assert.equal(result.ok, true, result.ok ? "" : result.error);
	return result.state;
}

function cas(transaction: DelegationTransactionRecord, now: string) {
	return {
		delegation_id: transaction.delegation_id,
		contract_hash: transaction.contract_hash,
		worker_identity: transaction.worker_identity,
		expected_generation: transaction.generation,
		expected_revision: transaction.revision,
		now,
	};
}

function proof(transaction: DelegationTransactionRecord): DelegationCommittedGenerationProof {
	const payload: Omit<DelegationCommittedGenerationProof, "commit_marker"> = {
		schema_version: 2,
		delegation_id: transaction.delegation_id,
		task_kind: transaction.task_kind,
		contract_hash: transaction.contract_hash,
		worker_identity: transaction.worker_identity,
		generation: transaction.generation,
		revision: transaction.revision,
		record_names: [...DELEGATION_COMMITTED_RECORD_NAMES],
		record_count: DELEGATION_COMMITTED_RECORD_NAMES.length,
		content_hash: "d".repeat(64),
	};
	return { ...payload, commit_marker: delegationCommitMarker(payload) };
}

function pending(
	id: string,
	offset: number,
	changedPaths: readonly string[],
	lineage?: DelegationRepairLineageV1,
	interrupted = false,
): DelegationTransactionRecord {
	const prepared = state(createPreparedDelegationTransaction({
		delegation_id: id,
		task_kind: "implementation",
		contract_hash: HASH,
		allowed_paths: ["docs/**", "entire-project/**", "lib/**", "src/**"],
		worker_identity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: `worker:${id}` },
		generation: 1,
		now: at(offset),
		...(lineage === undefined ? {} : { repair_lineage: lineage }),
	}));
	const running = state(startDelegationTransaction(prepared, cas(prepared, at(offset + 1))));
	const committing = state(beginDelegationCommit(running, {
		...cas(running, at(offset + 2)),
		outcome: {
			delegation_id: id,
			task_kind: "implementation",
			worker_identity: running.worker_identity,
			provider_success: true,
			worker_success: !interrupted,
			worker_failure_code: interrupted ? "TIMED_OUT" : null,
			exit_code: 0,
			report_complete: true,
			terminal_facts_complete: true,
			scope_complete: true,
			change_set_status: "ATTRIBUTED",
			changed_paths: [...changedPaths],
			successful_write_count: changedPaths.length,
			denied_write_count: 0,
			delta_hash: "e".repeat(64),
		},
	}));
	const published = state(publishDelegationCommit(committing, {
		...cas(committing, at(offset + 3)),
		proof: proof(committing),
	}));
	assert.equal(published.status, interrupted ? "INTERRUPTED" : "PENDING_REVIEW");
	return published;
}

function decision(transaction: DelegationTransactionRecord, hash: string, offset: number): DelegationSemanticRepairDecisionV1 {
	return {
		schema_version: 1,
		delegation_id: transaction.delegation_id,
		contract_hash: transaction.contract_hash,
		generation: transaction.generation,
		transaction_revision: 3,
		generation_content_hash: "1".repeat(64),
		base_review_hash: "2".repeat(64),
		expected_bound_diff_hash: "3".repeat(64),
		decision: "REPAIR",
		repair_reason: "repair exact rejected paths",
		repair_reason_hash: "4".repeat(64),
		reviewer: { provider: "openai", model: "gpt-5.6-sol" },
		decided_at: at(offset),
		decision_hash: hash,
	};
}

function reviewed(transaction: DelegationTransactionRecord, offset: number): DelegationTransactionRecord {
	return state(reviewDelegationTransaction(transaction, {
		...cas(transaction, at(offset)),
		review_hash: "9".repeat(64),
	}));
}

function lineage(root: string, decisionHash: string, carriedPaths: readonly string[]): DelegationRepairLineageV1 {
	const bound = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: root,
		repair_of: root,
		root_decision_hash: decisionHash,
		continuation_decision_delegation_id: root,
		continuation_decision_hash: decisionHash,
		parent_lineage_hash: null,
		depth: 1,
		carried_paths: [...carriedPaths],
	});
	if (bound === undefined) throw new Error("invalid lineage fixture");
	return bound;
}

function continuedLineage(
	parent: DelegationTransactionRecord,
	decisionHash: string,
	carriedPaths: readonly string[],
): DelegationRepairLineageV1 {
	const parentLineage = parent.repair_lineage;
	if (parentLineage === undefined) throw new Error("continued lineage requires a lineaged parent");
	const bound = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: parentLineage.root_delegation_id,
		repair_of: parent.delegation_id,
		root_decision_hash: parentLineage.root_decision_hash,
		continuation_decision_delegation_id: parent.delegation_id,
		continuation_decision_hash: decisionHash,
		parent_lineage_hash: parentLineage.lineage_hash,
		depth: parentLineage.depth + 1,
		carried_paths: [...carriedPaths],
	});
	if (bound === undefined) throw new Error("invalid continued lineage fixture");
	return bound;
}

interface ReaderFixture {
	transactions: Map<string, DelegationTransactionRecord>;
	decisions: Map<string, DelegationSemanticRepairDecisionV1>;
	terminalDecisions: Map<string, DelegationSemanticRepairDecisionV1>;
	changed: Map<string, readonly string[]>;
	closed: Set<string>;
	superseded?: Set<string>;
	semanticReviewed?: Set<string>;
	pathErrors: Map<string, "invalid_record" | "not_found" | "storage_failure">;
	order?: readonly string[];
	pathReads: string[];
}

function readers(fixture: ReaderFixture): DelegationPathLaneAdmissionReadersV1 {
	return {
		listDelegationIds: async () => ({ ok: true, value: fixture.order ?? [...fixture.transactions.keys()] }),
		readTransaction: async (_root, id) => {
			const transaction = fixture.transactions.get(id);
			return transaction === undefined ? { ok: false, error: { code: "not_found" } } : { ok: true, value: transaction };
		},
		readSemanticRepairDecision: async (_root, id) => ({ ok: true, value: fixture.decisions.get(id) }),
		readTerminalNegativeRepairDecision: async (_root, transaction) => ({
			ok: true,
			value: fixture.terminalDecisions.get(transaction.delegation_id),
		}),
		readInactiveClosure: async (_root, transaction) => ({ ok: true, value: fixture.closed.has(transaction.delegation_id) }),
		readEmptyRepairAttemptSupersession: async (_root, transaction) => ({
			ok: true,
			value: fixture.superseded?.has(transaction.delegation_id) ?? false,
		}),
		readRepairAbandonment: async () => ({ ok: true, value: false }),
		readSemanticReviewClosure: async (_root, transaction) => ({
			ok: true,
			value: fixture.semanticReviewed?.has(transaction.delegation_id) ?? false,
		}),
		readImmutablePaths: async (_root, transaction) => {
			fixture.pathReads.push(transaction.delegation_id);
			const error = fixture.pathErrors.get(transaction.delegation_id);
			if (error !== undefined) return { ok: false, error: { code: error } };
			return {
				ok: true,
				value: {
					changed_paths: [...(fixture.changed.get(transaction.delegation_id) ?? [])],
					carried_paths: [...(transaction.repair_lineage?.carried_paths ?? [])],
				},
			};
		},
	};
}

function twoLineages(order?: readonly string[]): ReaderFixture {
	const rootA = pending(ROOT_A, 0, ["src/root-a.ts"]);
	const rootB = pending(ROOT_B, 20, ["docs/root-b.md"]);
	const rootDecisionA = decision(rootA, DECISION_A, 4);
	const rootDecisionB = decision(rootB, DECISION_B, 24);
	const tipA = pending(TIP_A, 10, ["src/new-a.ts"], lineage(ROOT_A, DECISION_A, ["src/rejected-a.ts"]));
	const tipB = pending(TIP_B, 30, ["docs/new-b.md"], lineage(ROOT_B, DECISION_B, ["docs/rejected-b.md"]));
	return {
		transactions: new Map([[ROOT_A, rootA], [TIP_A, tipA], [ROOT_B, rootB], [TIP_B, tipB]]),
		decisions: new Map([[ROOT_A, rootDecisionA], [ROOT_B, rootDecisionB]]),
		terminalDecisions: new Map(),
		changed: new Map([[TIP_A, ["src/new-a.ts"]], [TIP_B, ["docs/new-b.md"]]]),
		closed: new Set(),
		pathErrors: new Map(),
		...(order === undefined ? {} : { order }),
		pathReads: [],
	};
}

test("two independent unresolved repair lineages admit a known non-overlapping lane", async () => {
	const fixture = twoLineages([TIP_B, ROOT_A, ROOT_B, TIP_A]);
	const admission = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"] },
		readers(fixture),
	);
	assert.equal(admission.decision.decision, "ALLOW", JSON.stringify(admission));
	assert.deepEqual(admission.repair_tip_ids, [TIP_A, TIP_B]);
	assert.deepEqual(admission.ordinary_blocker_ids, []);
	assert.deepEqual(admission.decision.maintenance_warnings.map((warning) => warning.delegation_id), [TIP_A, TIP_B]);
	assert.deepEqual(admission.blockers, [
		{ kind: "known", delegation_id: TIP_A, changed_paths: ["src/new-a.ts"], carried_paths: ["src/rejected-a.ts"], rename_sources: {} },
		{ kind: "known", delegation_id: TIP_B, changed_paths: ["docs/new-b.md"], carried_paths: ["docs/rejected-b.md"], rename_sources: {} },
	]);
});

test("a superseded empty attempt does not form a fork with its replacement sibling", async () => {
	const fixture = twoLineages();
	const replacementId = "20260827-100005-rpl1";
	const replacement = pending(
		replacementId,
		12,
		["src/replacement-a.ts"],
		lineage(ROOT_A, DECISION_A, ["src/rejected-a.ts"]),
	);
	fixture.transactions.set(replacementId, replacement);
	fixture.changed.set(replacementId, ["src/replacement-a.ts"]);
	fixture.superseded = new Set([TIP_A]);

	const admission = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"] },
		readers(fixture),
	);
	assert.equal(admission.decision.decision, "ALLOW", JSON.stringify(admission));
	assert.deepEqual(admission.repair_tip_ids, [TIP_B, replacementId]);
	assert.deepEqual(fixture.pathReads, [TIP_B, replacementId]);
});

test("a superseded empty attempt stays excluded after its parent receives a newer continuation decision", async () => {
	const staleId = "20260827-100005-stal";
	const replacementId = "20260827-100006-rpl2";
	const root = pending(ROOT_A, 0, ["src/root.ts"]);
	const rootDecision = decision(root, DECISION_A, 4);
	const parent = pending(
		TIP_A,
		10,
		["src/partial.ts"],
		lineage(ROOT_A, DECISION_A, ["src/root.ts"]),
		true,
	);
	const parentDecision = decision(parent, DECISION_B, 14);
	const parentLineage = parent.repair_lineage!;
	const staleLineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: parentLineage.root_delegation_id,
		repair_of: parent.delegation_id,
		root_decision_hash: parentLineage.root_decision_hash,
		continuation_decision_delegation_id: parentLineage.continuation_decision_delegation_id,
		continuation_decision_hash: parentLineage.continuation_decision_hash,
		parent_lineage_hash: parentLineage.lineage_hash,
		depth: parentLineage.depth + 1,
		carried_paths: ["src/partial.ts", "src/root.ts"],
	});
	assert.ok(staleLineage);
	const stale = pending(staleId, 20, [], staleLineage);
	const replacement = pending(
		replacementId,
		22,
		["src/repaired.ts"],
		continuedLineage(parent, DECISION_B, ["src/partial.ts", "src/root.ts"]),
	);
	const fixture: ReaderFixture = {
		transactions: new Map([[staleId, stale], [replacementId, replacement], [TIP_A, parent], [ROOT_A, root]]),
		decisions: new Map([[ROOT_A, rootDecision]]),
		terminalDecisions: new Map([[TIP_A, parentDecision]]),
		changed: new Map([[replacementId, ["src/repaired.ts"]]]),
		closed: new Set(),
		superseded: new Set([staleId]),
		pathErrors: new Map(),
		pathReads: [],
	};
	const admission = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"] },
		readers(fixture),
	);
	assert.equal(admission.decision.decision, "ALLOW", JSON.stringify(admission));
	assert.deepEqual(admission.repair_tip_ids, [replacementId]);
	assert.deepEqual(fixture.pathReads, [replacementId]);
});

test("a chain of strictly superseded empty attempts grants no child authority", async () => {
	const childId = "20260827-100005-chld";
	const fixture = twoLineages();
	const parent = fixture.transactions.get(TIP_A)!;
	const child = pending(
		childId,
		20,
		[],
		continuedLineage(parent, DECISION_A, ["src/rejected-a.ts"]),
	);
	fixture.transactions.set(childId, child);
	fixture.superseded = new Set([TIP_A, childId]);

	const admission = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"] },
		readers(fixture),
	);
	assert.equal(admission.decision.decision, "ALLOW", JSON.stringify(admission));
	assert.deepEqual(admission.repair_tip_ids, [ROOT_A, TIP_B]);
	assert.deepEqual(fixture.pathReads, [ROOT_A, TIP_B]);
});

test("an INTERRUPTED terminal-negative Sol root and its successor form one valid lineage", async () => {
	const root = pending(ROOT_A, 0, ["src/partial.ts"], undefined, true);
	const rootDecision = decision(root, DECISION_A, 4);
	const tip = pending(TIP_A, 10, ["src/repaired.ts"], lineage(ROOT_A, DECISION_A, ["src/partial.ts"]));
	const fixture: ReaderFixture = {
		transactions: new Map([[TIP_A, tip], [ROOT_A, root]]),
		decisions: new Map(),
		terminalDecisions: new Map([[ROOT_A, rootDecision]]),
		changed: new Map([[TIP_A, ["src/repaired.ts"]]]),
		closed: new Set(),
		pathErrors: new Map(),
		pathReads: [],
	};
	const admission = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"] },
		readers(fixture),
	);
	assert.equal(admission.decision.decision, "ALLOW", JSON.stringify(admission));
	assert.deepEqual(admission.repair_tip_ids, [TIP_A]);
	assert.deepEqual(admission.ordinary_blocker_ids, []);
	assert.deepEqual(admission.blockers, [{
		kind: "known",
		delegation_id: TIP_A,
		changed_paths: ["src/repaired.ts"],
		carried_paths: ["src/partial.ts"],
		rename_sources: {},
	}]);
});

test("a terminal-negative decision on a lineaged parent authorizes its depth-two successor", async () => {
	const childId = "20260827-100005-c001";
	const root = pending(ROOT_A, 0, ["src/root.ts"]);
	const rootDecision = decision(root, DECISION_A, 4);
	const parent = pending(
		TIP_A,
		10,
		["src/partial.ts"],
		lineage(ROOT_A, DECISION_A, ["src/root.ts"]),
		true,
	);
	const parentDecision = decision(parent, DECISION_B, 14);
	const child = pending(
		childId,
		20,
		["src/repaired.ts"],
		continuedLineage(parent, DECISION_B, ["src/partial.ts", "src/root.ts"]),
	);
	const fixture: ReaderFixture = {
		transactions: new Map([[childId, child], [TIP_A, parent], [ROOT_A, root]]),
		decisions: new Map([[ROOT_A, rootDecision]]),
		terminalDecisions: new Map([[TIP_A, parentDecision]]),
		changed: new Map([[childId, ["src/repaired.ts"]]]),
		closed: new Set(),
		pathErrors: new Map(),
		pathReads: [],
	};
	const admission = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"] },
		readers(fixture),
	);
	assert.equal(admission.decision.decision, "ALLOW", JSON.stringify(admission));
	assert.deepEqual(admission.repair_tip_ids, [childId]);
	assert.deepEqual(admission.blockers, [{
		kind: "known",
		delegation_id: childId,
		changed_paths: ["src/repaired.ts"],
		carried_paths: ["src/partial.ts", "src/root.ts"],
		rename_sources: {},
	}]);
});

test("a saturated depth-16 repair tip remains valid and can be excluded for its exact successor", async () => {
	const rootId = "20260827-110000-s000";
	const root = pending(rootId, 0, ["src/root.ts"]);
	const rootDecision = decision(root, DECISION_A, 4);
	const transactions = new Map<string, DelegationTransactionRecord>([[rootId, root]]);
	const changed = new Map<string, readonly string[]>([[rootId, ["src/root.ts"]]]);
	let parent = root;
	let tipId = rootId;

	for (let index = 1; index <= 17; index += 1) {
		tipId = `20260827-${String(110000 + index).padStart(6, "0")}-s${String(index).padStart(3, "0")}`;
		const parentLineage = parent.repair_lineage;
		const nextLineage = parentLineage === undefined
			? lineage(rootId, DECISION_A, ["src/root.ts"])
			: bindDelegationRepairLineageV1({
				schema_version: 1,
				kind: "semantic-repair-lineage-v1",
				root_delegation_id: rootId,
				repair_of: parent.delegation_id,
				root_decision_hash: DECISION_A,
				continuation_decision_delegation_id: rootId,
				continuation_decision_hash: DECISION_A,
				parent_lineage_hash: parentLineage.lineage_hash,
				depth: Math.min(parentLineage.depth + 1, 16),
				carried_paths: ["src/root.ts"],
			});
		assert.ok(nextLineage);
		parent = pending(tipId, index * 10, [`src/repair-${index}.ts`], nextLineage);
		transactions.set(tipId, parent);
		changed.set(tipId, [`src/repair-${index}.ts`]);
	}

	assert.equal(parent.repair_lineage?.depth, 16);
	const fixture: ReaderFixture = {
		transactions,
		decisions: new Map([[rootId, rootDecision]]),
		terminalDecisions: new Map(),
		changed,
		closed: new Set(),
		pathErrors: new Map(),
		pathReads: [],
	};
	const admission = await admitProjectDelegationPathLaneV1({
		project_root: "/project",
		allowed_paths: ["src/final.ts"],
		repair_tip_exclusion_id: tipId,
	}, readers(fixture));

	assert.equal(admission.decision.decision, "ALLOW", JSON.stringify(admission));
	assert.deepEqual(admission.repair_tip_ids, [tipId]);
	assert.equal(admission.repair_tip_exclusion_id, tipId);
});

test("a child's own REPAIR decision ratifies a historical inherited continuation and authorizes its successor", async () => {
	const legacyId = "20260827-100005-lgcy";
	const successorId = "20260827-100006-next";
	const childDecisionHash = "f".repeat(64);
	const root = pending(ROOT_A, 0, ["src/root.ts"]);
	const rootDecision = decision(root, DECISION_A, 4);
	const parent = pending(
		TIP_A,
		10,
		["src/partial.ts"],
		lineage(ROOT_A, DECISION_A, ["src/root.ts"]),
		true,
	);
	const parentDecision = decision(parent, DECISION_B, 14);
	const parentLineage = parent.repair_lineage!;
	const legacyLineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: parentLineage.root_delegation_id,
		repair_of: parent.delegation_id,
		root_decision_hash: parentLineage.root_decision_hash,
		continuation_decision_delegation_id: parentLineage.continuation_decision_delegation_id,
		continuation_decision_hash: parentLineage.continuation_decision_hash,
		parent_lineage_hash: parentLineage.lineage_hash,
		depth: parentLineage.depth + 1,
		carried_paths: ["src/partial.ts", "src/root.ts"],
	});
	assert.ok(legacyLineage);
	const legacy = pending(legacyId, 20, ["src/legacy.ts"], legacyLineage, true);
	const legacyDecision = decision(legacy, childDecisionHash, 24);
	const successor = pending(
		successorId,
		30,
		["src/repaired.ts"],
		continuedLineage(legacy, childDecisionHash, ["src/legacy.ts", "src/partial.ts", "src/root.ts"]),
	);
	const fixture: ReaderFixture = {
		transactions: new Map([[successorId, successor], [legacyId, legacy], [TIP_A, parent], [ROOT_A, root]]),
		decisions: new Map([[ROOT_A, rootDecision]]),
		terminalDecisions: new Map([[TIP_A, parentDecision], [legacyId, legacyDecision]]),
		changed: new Map([[successorId, ["src/repaired.ts"]]]),
		closed: new Set(),
		pathErrors: new Map(),
		pathReads: [],
	};
	const admission = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"] },
		readers(fixture),
	);
	assert.equal(admission.decision.decision, "ALLOW", JSON.stringify(admission));
	assert.deepEqual(admission.repair_tip_ids, [successorId]);
	assert.deepEqual(fixture.pathReads, [successorId]);
});

test("a child's own ACCEPT review closes a historical inherited continuation", async () => {
	const acceptedId = "20260827-100005-acpt";
	const root = pending(ROOT_A, 0, ["src/root.ts"]);
	const rootDecision = decision(root, DECISION_A, 4);
	const parent = pending(
		TIP_A,
		10,
		["src/partial.ts"],
		lineage(ROOT_A, DECISION_A, ["src/root.ts"]),
		true,
	);
	const parentDecision = decision(parent, DECISION_B, 14);
	const parentLineage = parent.repair_lineage!;
	const acceptedLineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: parentLineage.root_delegation_id,
		repair_of: parent.delegation_id,
		root_decision_hash: parentLineage.root_decision_hash,
		continuation_decision_delegation_id: parentLineage.continuation_decision_delegation_id,
		continuation_decision_hash: parentLineage.continuation_decision_hash,
		parent_lineage_hash: parentLineage.lineage_hash,
		depth: parentLineage.depth + 1,
		carried_paths: ["src/partial.ts", "src/root.ts"],
	});
	assert.ok(acceptedLineage);
	const accepted = reviewed(pending(acceptedId, 20, [], acceptedLineage), 24);
	const fixture: ReaderFixture = {
		transactions: new Map([[acceptedId, accepted], [TIP_A, parent], [ROOT_A, root]]),
		decisions: new Map([[ROOT_A, rootDecision]]),
		terminalDecisions: new Map([[TIP_A, parentDecision]]),
		changed: new Map(),
		closed: new Set(),
		semanticReviewed: new Set([acceptedId]),
		pathErrors: new Map(),
		pathReads: [],
	};
	const admission = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"] },
		readers(fixture),
	);
	assert.equal(admission.decision.decision, "ALLOW", JSON.stringify(admission));
	assert.deepEqual(admission.repair_tip_ids, []);
	assert.deepEqual(admission.blockers, []);
	assert.deepEqual(fixture.pathReads, []);
});

test("any immutable changed or carried path overlap blocks the requested lane", async () => {
	const fixture = twoLineages();
	const carried = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["src/rejected-a.ts"] },
		readers(fixture),
	);
	assert.equal(carried.decision.decision, "BLOCK");
	assert.deepEqual(carried.decision.block_reasons, ["PATH_OVERLAP"]);
	assert.equal(carried.decision.conflicts[0]?.delegation_id, TIP_A);
	assert.deepEqual(carried.decision.conflicts[0]?.historical_sources, ["carried_path"]);
});

test("an exact repair may exclude only its known current repair tip while retaining full hashed authority", async () => {
	const fixture = twoLineages();
	const blocked = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["src/rejected-a.ts"] },
		readers(fixture),
	);
	const admitted = await admitProjectDelegationPathLaneV1(
		{
			project_root: "/project",
			allowed_paths: ["src/rejected-a.ts"],
			repair_tip_exclusion_id: TIP_A,
		},
		readers(twoLineages()),
	);
	assert.equal(blocked.decision.decision, "BLOCK");
	assert.equal(admitted.decision.decision, "ALLOW", JSON.stringify(admitted));
	assert.equal(admitted.repair_tip_exclusion_id, TIP_A);
	assert.deepEqual(admitted.repair_tip_ids, [TIP_A, TIP_B]);
	assert.deepEqual(admitted.blockers.map((blocker) => blocker.delegation_id), [TIP_A, TIP_B]);
	assert.deepEqual(admitted.decision.maintenance_warnings.map((warning) => warning.delegation_id), [TIP_B]);
	assert.notEqual(admitted.authority_hash, blocked.authority_hash, "the exclusion request is authority-bound");

	const revalidated = await revalidateProjectDelegationPathLaneV1(
		{
			project_root: "/project",
			allowed_paths: ["src/rejected-a.ts"],
			repair_tip_exclusion_id: TIP_A,
			expected_authority_hash: admitted.authority_hash,
		},
		readers(twoLineages()),
	);
	assert.equal(revalidated.unchanged, true);
	assert.equal(revalidated.admission.decision.decision, "ALLOW");
});

test("ordinary, non-tip, forged, and unreadable tip exclusions fail closed", async () => {
	const fixture = twoLineages();
	const ordinary = pending(ORDINARY, 40, ["lib/ordinary.ts"]);
	fixture.transactions.set(ORDINARY, ordinary);
	fixture.changed.set(ORDINARY, ["lib/ordinary.ts"]);
	for (const excluded of [ORDINARY, ROOT_A, "20260827-100099-fake"]) {
		const admission = await admitProjectDelegationPathLaneV1(
			{ project_root: "/project", allowed_paths: ["tests/**"], repair_tip_exclusion_id: excluded },
			readers(fixture),
		);
		assert.equal(admission.decision.decision, "BLOCK");
		assert.ok(admission.decision.block_reasons.includes("INVALID_REQUEST"));
	}

	const unreadable = twoLineages();
	unreadable.pathErrors.set(TIP_A, "storage_failure");
	const admission = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"], repair_tip_exclusion_id: TIP_A },
		readers(unreadable),
	);
	assert.equal(admission.decision.decision, "BLOCK");
	assert.deepEqual(admission.decision.block_reasons, ["INVALID_REQUEST", "UNKNOWN_AUTHORITY"]);
});

test("ordinary blockers are enumerated beside repair tips without using allowed_paths as provenance", async () => {
	const fixture = twoLineages();
	const ordinary = pending(ORDINARY, 40, ["lib/ordinary.ts"]);
	fixture.transactions.set(ORDINARY, ordinary);
	fixture.changed.set(ORDINARY, ["lib/ordinary.ts"]);
	const admission = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["entire-project/safe.ts"] },
		readers(fixture),
	);
	assert.equal(admission.decision.decision, "ALLOW", JSON.stringify(admission));
	assert.deepEqual(admission.ordinary_blocker_ids, [ORDINARY]);
	const ordinaryBlocker = admission.blockers.find((blocker) => blocker.delegation_id === ORDINARY);
	assert.deepEqual(ordinaryBlocker, {
		kind: "known", delegation_id: ORDINARY, changed_paths: ["lib/ordinary.ts"], carried_paths: [], rename_sources: {},
	});
});

test("corrupt or unavailable immutable authority remains a global block", async () => {
	const corruptFixture = twoLineages();
	corruptFixture.pathErrors.set(TIP_A, "invalid_record");
	const corrupt = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"] },
		readers(corruptFixture),
	);
	assert.equal(corrupt.decision.decision, "BLOCK");
	assert.deepEqual(corrupt.decision.block_reasons, ["INVALID_AUTHORITY"]);
	assert.deepEqual(corrupt.decision.authority_failures[0], {
		delegation_id: TIP_A, authority_state: "INVALID", reason: "INVALID_RECORD",
	});

	const rawFixture = twoLineages();
	const rawId = "20260827-100005-raw1";
	rawFixture.order = [...rawFixture.transactions.keys(), rawId];
	const raw = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"] },
		readers(rawFixture),
	);
	assert.equal(raw.decision.decision, "BLOCK");
	assert.deepEqual(raw.decision.authority_failures, [{
		delegation_id: rawId, authority_state: "UNKNOWN", reason: "NOT_FOUND",
	}]);
});

test("an exactly closed repair chain is ignored before committed path extraction", async () => {
	const fixture = twoLineages();
	fixture.closed.add(TIP_A);
	fixture.closed.add(TIP_B);
	const admission = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["src/**"] },
		readers(fixture),
	);
	assert.equal(admission.decision.decision, "ALLOW");
	assert.deepEqual(admission.repair_tip_ids, []);
	assert.deepEqual(admission.blockers, []);
	assert.deepEqual(fixture.pathReads, []);
});

test("authority ordering and hash are deterministic, and revalidation detects a changed snapshot", async () => {
	const firstFixture = twoLineages([TIP_B, ROOT_B, TIP_A, ROOT_A]);
	const secondFixture = twoLineages([ROOT_A, TIP_A, ROOT_B, TIP_B]);
	const first = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"] },
		readers(firstFixture),
	);
	const second = await admitProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"] },
		readers(secondFixture),
	);
	assert.equal(first.authority_hash, second.authority_hash);
	assert.deepEqual(first.blockers, second.blockers);

	secondFixture.changed.set(TIP_B, ["docs/new-b.md", "tests/new-overlap.ts"]);
	const revalidated = await revalidateProjectDelegationPathLaneV1(
		{ project_root: "/project", allowed_paths: ["tests/**"], expected_authority_hash: first.authority_hash },
		readers(secondFixture),
	);
	assert.equal(revalidated.unchanged, false);
	assert.notEqual(revalidated.observed_authority_hash, first.authority_hash);
	assert.equal(revalidated.admission.decision.decision, "BLOCK");
});
