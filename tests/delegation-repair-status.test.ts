import assert from "node:assert/strict";
import test from "node:test";

import {
	classifyDelegationRepairStatusV1,
	delegationDisplayedStatusV1,
	delegationNextActionTextV1,
	delegationProjectIssueRepairStatusV1,
	delegationRepairStatusLinesV1,
	readDelegationRepairStatusV1,
} from "../extensions/workbench-runtime/core/delegation-repair-status.ts";
import type { DelegationAuthorityObservationV2 } from "../extensions/workbench-runtime/core/delegation-project-authority.ts";
import type { DelegationState } from "../extensions/workbench-runtime/core/delegation-state.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";

const ID = "20260823-205046-jw66";
const ROOT = "20260823-200000-root";
const HASH = "a".repeat(64);
const DECISION = "b".repeat(64);
const REASON = "c".repeat(64);
const LINEAGE = "d".repeat(64);
const state: DelegationState = {
	latestId: ID,
	status: "PENDING_REVIEW",
	currentDiffHash: HASH,
	blockedWriteAttempts: 0,
	updatedAt: "2026-08-23T20:50:46.000Z",
};

function observation(overrides: Partial<Extract<DelegationAuthorityObservationV2, { kind: "v2" }>> = {}): Extract<DelegationAuthorityObservationV2, { kind: "v2" }> {
	return {
		kind: "v2",
		transactionStatus: "PENDING_REVIEW",
		transactionVerdict: null,
		review: null,
		reviewPath: null,
		finalized: false,
		semanticAccepted: false,
		semanticBindingHash: null,
		semanticSource: null,
		semanticReviewer: null,
		semanticAcceptedAt: null,
		...overrides,
	};
}

test("repair status projects a fresh negative decision into one exact next action", () => {
	const status = classifyDelegationRepairStatusV1({
		delegationId: ID,
		authority: observation({
			semanticRepair: {
				decisionHash: DECISION,
				reasonHash: REASON,
				expectedBindingHash: HASH,
				reviewer: "openai-codex/gpt-5.6-sol",
				decidedAt: "2026-08-23T20:51:00.000Z",
			},
		}),
		binding: { status: "fresh", hash: HASH, kind: "changeset-relevance-v2" },
	});
	assert.equal(status.kind, "repair_required");
	assert.equal(delegationNextActionTextV1(state, status),
		`start the exact semantic repair with workbench_delegate_worker repair_of=${ID}`);
	assert.match(delegationRepairStatusLinesV1(status).join("\n"), /REPAIR_REQUIRED/);
	assert.match(delegationRepairStatusLinesV1(status).join("\n"), new RegExp(`repair_of=${ID}`));
});

test("binding conflict and project-chain invalidity never advertise an executable repair", async () => {
	const conflict = classifyDelegationRepairStatusV1({
		delegationId: ID,
		authority: observation({
			semanticRepair: {
				decisionHash: DECISION,
				reasonHash: REASON,
				expectedBindingHash: HASH,
				reviewer: "openai-codex/gpt-5.6-sol",
				decidedAt: "2026-08-23T20:51:00.000Z",
			},
		}),
		binding: { status: "conflict", hash: "e".repeat(64), kind: "changeset-relevance-v2", code: "binding_conflict" },
	});
	assert.equal(conflict.kind, "repair_required");
	assert.doesNotMatch(delegationNextActionTextV1(state, conflict) ?? "", /start the exact semantic repair/);

	let capsuleReads = 0;
	const invalid = await readDelegationRepairStatusV1("/tmp/project", state, (async () => {
		throw new Error("unused");
	}) as ExecFn, {
		readAuthority: async () => ({ kind: "invalid-v2", code: "repair_lineage_fork" }),
		collectBinding: async () => ({ status: "unavailable" }),
		readRepairCapsule: async () => {
			capsuleReads += 1;
			return { ok: false, code: "authority_invalid" };
		},
	});
	assert.deepEqual(invalid, { kind: "authority_invalid", delegationId: ID, code: "repair_lineage_fork" });
	assert.equal(capsuleReads, 0);
	const next = delegationNextActionTextV1(state, invalid) ?? "";
	assert.match(next, /fail-closed/);
	assert.doesNotMatch(next, /workbench_delegate_worker repair_of/);
});

test("project-wide repair corruption remains visible even when the restored mirror has no latest id", async () => {
	const empty: DelegationState = {
		status: "REVIEWED",
		blockedWriteAttempts: 0,
		updatedAt: "2026-08-23T20:50:46.000Z",
	};
	const invalid = await readDelegationRepairStatusV1("/tmp/project", empty, (async () => {
		throw new Error("unused");
	}) as ExecFn, {
		readRepairClosure: async () => ({ ok: false, issue: { code: "repair_lineage_fork" } }),
		readAuthority: async () => { throw new Error("must not read a missing latest id"); },
		collectBinding: async () => { throw new Error("must not collect a missing latest id"); },
		readRepairCapsule: async () => { throw new Error("must not read a missing latest id"); },
	});
	assert.deepEqual(invalid, { kind: "authority_invalid", delegationId: null, code: "repair_lineage_fork" });
	const next = delegationNextActionTextV1(empty, invalid) ?? "";
	assert.match(next, /project delegation authority is repair_lineage_fork/);
	assert.doesNotMatch(next, /start the first worker delegation/);
});

test("durable unresolved tip overrides a stale cached latest id and project issues override both", async () => {
	const hiddenTip = "20260823-205100-tip1";
	const readIds: string[] = [];
	const projected = await readDelegationRepairStatusV1("/tmp/project", state, (async () => {
		throw new Error("unused");
	}) as ExecFn, {
		readRepairClosure: async () => ({ ok: true, unresolvedTipId: hiddenTip, rootCount: 1, lineageCount: 1 }),
		readAuthority: async (_root, id) => {
			readIds.push(id);
			return observation({
				semanticRepair: {
					decisionHash: DECISION,
					reasonHash: REASON,
					expectedBindingHash: HASH,
					reviewer: "openai-codex/gpt-5.6-sol",
					decidedAt: "2026-08-23T20:51:00.000Z",
				},
			});
		},
		collectBinding: async (_root, id) => {
			readIds.push(id ?? "(none)");
			return { status: "fresh", hash: HASH, kind: "changeset-relevance-v2" };
		},
		readRepairCapsule: async () => ({ ok: false, code: "authority_invalid" }),
	});
	assert.equal(projected.kind, "repair_required");
	if (projected.kind === "repair_required") assert.equal(projected.delegationId, hiddenTip);
	assert.deepEqual(readIds, [hiddenTip, hiddenTip]);
	assert.match(delegationNextActionTextV1(state, projected) ?? "", new RegExp(`repair_of=${hiddenTip}`));
	assert.doesNotMatch(delegationNextActionTextV1(state, projected) ?? "", /start the next delegation/);
	assert.deepEqual(delegationProjectIssueRepairStatusV1({ code: "binding_unavailable" }), {
		kind: "authority_invalid", delegationId: null, code: "binding_unavailable",
	});
});

test("lineaged terminal retry, active execution, and pending review have distinct non-contradictory guidance", () => {
	const lineage = {
		rootDelegationId: ROOT,
		repairOf: ROOT,
		rootDecisionHash: DECISION,
		continuationDecisionDelegationId: ROOT,
		continuationDecisionHash: DECISION,
		lineageHash: LINEAGE,
		depth: 1,
		carriedPathCount: 3,
	};
	const failed = classifyDelegationRepairStatusV1({
		delegationId: ID,
		authority: observation({ transactionStatus: "FAILED", repairLineage: lineage }),
		binding: { status: "fresh", hash: HASH, kind: "changeset-relevance-v2" },
		retryable: true,
	});
	assert.equal(failed.kind, "repair_terminal_retry");
	assert.match(delegationNextActionTextV1(state, failed) ?? "", new RegExp(`repair_of=${ID}`));

	const active = classifyDelegationRepairStatusV1({
		delegationId: ID,
		authority: observation({ transactionStatus: "RUNNING", repairLineage: lineage }),
		binding: { status: "fresh", hash: HASH, kind: "changeset-relevance-v2" },
	});
	assert.equal(active.kind, "repair_active");
	assert.match(delegationNextActionTextV1(state, active) ?? "", /wait for it or recover/);
	assert.doesNotMatch(delegationNextActionTextV1(state, active) ?? "", /review delegation/);

	const pending = classifyDelegationRepairStatusV1({
		delegationId: ID,
		authority: observation({ transactionStatus: "PENDING_REVIEW", repairLineage: lineage }),
		binding: { status: "fresh", hash: HASH, kind: "changeset-relevance-v2" },
	});
	assert.equal(pending.kind, "repair_review");
	assert.match(delegationNextActionTextV1(state, pending) ?? "", /explicitly ACCEPT.*or issue another REPAIR/);
});

test("ordinary active and failed v2 transactions never inherit the mirror's review instruction", () => {
	const ordinaryFailed = classifyDelegationRepairStatusV1({
		delegationId: ID,
		authority: observation({ transactionStatus: "FAILED", repairLineage: undefined }),
		binding: { status: "fresh", hash: HASH, kind: "changeset-relevance-v2" },
		retryable: true,
	});
	assert.equal(ordinaryFailed.kind, "delegation_retry");
	assert.match(delegationNextActionTextV1(state, ordinaryFailed) ?? "", new RegExp(`repair_of=${ID}`));
	assert.doesNotMatch(delegationNextActionTextV1(state, ordinaryFailed) ?? "", /review delegation/);

	const ordinaryRunning = classifyDelegationRepairStatusV1({
		delegationId: ID,
		authority: observation({ transactionStatus: "RUNNING", repairLineage: undefined }),
		binding: { status: "fresh", hash: HASH, kind: "changeset-relevance-v2" },
	});
	assert.equal(ordinaryRunning.kind, "delegation_active");
	assert.match(delegationNextActionTextV1(state, ordinaryRunning) ?? "", /wait for the worker result/);
	assert.doesNotMatch(delegationNextActionTextV1(state, ordinaryRunning) ?? "", /review delegation/);
});

test("status display uses durable execution while preserving pending/stale terminal completion", () => {
	assert.equal(delegationDisplayedStatusV1("PENDING_REVIEW", "FAILED"), "FAILED");
	assert.equal(delegationDisplayedStatusV1("PENDING_REVIEW", "RUNNING"), "RUNNING");
	assert.equal(delegationDisplayedStatusV1("PENDING_REVIEW", "REVIEWED"), "PENDING_REVIEW");
	assert.equal(delegationDisplayedStatusV1("STALE", "REVIEWED"), "STALE");
	assert.equal(delegationDisplayedStatusV1("REVIEWED", "FINISHED"), "FINISHED");
});
