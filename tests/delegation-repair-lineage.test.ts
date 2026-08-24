import assert from "node:assert/strict";
import test from "node:test";

import type { ChangeSetRecord } from "../extensions/workbench-runtime/core/change-set.ts";
import { deriveDelegationRepairLineageV1 } from "../extensions/workbench-runtime/core/delegate-tool-controller.ts";
import {
	bindDelegationRepairLineageV1,
	createPreparedDelegationTransaction,
	type DelegationRepairLineageV1,
	type DelegationTransactionRecord,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";

const HASH = "a".repeat(64);

function prepared(id: string, lineage?: DelegationRepairLineageV1): DelegationTransactionRecord {
	const result = createPreparedDelegationTransaction({
		delegation_id: id,
		task_kind: "implementation",
		contract_hash: HASH,
		allowed_paths: ["src/**"],
		worker_identity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: `worker:${id}` },
		generation: 1,
		now: "2026-08-23T01:02:03.000Z",
		...(lineage === undefined ? {} : { repair_lineage: lineage }),
	});
	if (!result.ok) throw new Error(result.error);
	return result.state;
}

function paths(worker: readonly string[], dependencies: readonly string[]): ChangeSetRecord {
	return {
		worker_delta: worker.map((path) => ({ path })),
		dependency_paths: [...dependencies],
	} as unknown as ChangeSetRecord;
}

test("semantic repair lineage carries the rejected W/D set and every retry preserves its ancestry", () => {
	const root = prepared("20260823-010203-root");
	const first = deriveDelegationRepairLineageV1({
		parent: root,
		changeSet: paths(["src/z.ts"], ["src/a.ts"]),
		semanticDecision: { delegationId: root.delegation_id, decisionHash: "b".repeat(64) },
	});
	assert.ok(first);
	assert.equal(first.depth, 1);
	assert.equal(first.root_delegation_id, root.delegation_id);
	assert.equal(first.repair_of, root.delegation_id);
	assert.equal(first.parent_lineage_hash, null);
	assert.deepEqual(first.carried_paths, ["src/a.ts", "src/z.ts"]);

	const failedRepair = prepared("20260823-010204-rpr1", first);
	const retry = deriveDelegationRepairLineageV1({
		parent: failedRepair,
		changeSet: paths(["src/b.ts"], ["src/a.ts"]),
	});
	assert.ok(retry);
	assert.equal(retry.depth, 2);
	assert.equal(retry.root_delegation_id, root.delegation_id);
	assert.equal(retry.repair_of, failedRepair.delegation_id);
	assert.equal(retry.parent_lineage_hash, first.lineage_hash);
	assert.equal(retry.root_decision_hash, first.root_decision_hash);
	assert.deepEqual(retry.carried_paths, ["src/a.ts", "src/b.ts", "src/z.ts"]);

	const abortedRetry = deriveDelegationRepairLineageV1({ parent: failedRepair });
	assert.ok(abortedRetry);
	assert.deepEqual(abortedRetry.carried_paths, first.carried_paths);
});

test("repair lineage saturates its diagnostic depth while advancing the hash chain, and bounds carried paths", () => {
	const deep = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: "20260823-010203-root",
		repair_of: "20260823-010204-rpr1",
		root_decision_hash: "b".repeat(64),
		continuation_decision_delegation_id: "20260823-010203-root",
		continuation_decision_hash: "b".repeat(64),
		parent_lineage_hash: "c".repeat(64),
		depth: 16,
		carried_paths: ["src/a.ts"],
	});
	assert.ok(deep);
	const saturated = deriveDelegationRepairLineageV1({ parent: prepared("20260823-010205-rpr2", deep) });
	assert.ok(saturated);
	assert.equal(saturated.depth, 16);
	assert.equal(saturated.parent_lineage_hash, deep.lineage_hash);
	assert.notEqual(saturated.lineage_hash, deep.lineage_hash);

	const fullPaths = Array.from({ length: 500 }, (_, index) => `src/${String(index).padStart(3, "0")}.ts`);
	const full = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: "20260823-010203-root",
		repair_of: "20260823-010204-rpr1",
		root_decision_hash: "b".repeat(64),
		continuation_decision_delegation_id: "20260823-010203-root",
		continuation_decision_hash: "b".repeat(64),
		parent_lineage_hash: "c".repeat(64),
		depth: 2,
		carried_paths: fullPaths,
	});
	assert.ok(full);
	const fullParent = prepared("20260823-010206-rpr3", full);
	assert.equal(deriveDelegationRepairLineageV1({
		parent: fullParent,
		additionalPaths: ["src/new.ts"],
	}), undefined, "the 501st exact write path is rejected before a worker can start");
	const stable = deriveDelegationRepairLineageV1({
		parent: fullParent,
		changeSet: paths([fullPaths[499]!], fullPaths),
		additionalPaths: [fullPaths[0]!],
	});
	assert.ok(stable);
	assert.equal(stable.carried_paths.length, 500, "worker failure within exact carried scope does not grow the union");
});
