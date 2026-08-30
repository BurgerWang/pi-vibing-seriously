import assert from "node:assert/strict";
import test from "node:test";

import {
	classifyDelegationRepairStatusV1,
	delegationDisplayedStatusV1,
	delegationExactRepairRouteLineV1,
	delegationNextActionTextV1,
	delegationProjectIssueRepairStatusV1,
	delegationRepairStatusLinesV1,
	delegationVerifyBlockReasonV1,
	readDelegationRepairStatusV1,
} from "../extensions/workbench-runtime/core/delegation-repair-status.ts";
import type { DelegationAuthorityObservationV2 } from "../extensions/workbench-runtime/core/delegation-project-authority.ts";
import type { DelegationState } from "../extensions/workbench-runtime/core/delegation-state.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import {
	DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	delegationLifecycleSnapshotFromInvalidDerivedReviewV1,
	delegationLifecycleSnapshotFromReviewCandidateV1,
	resolveDelegationLifecycleV1,
} from "../extensions/workbench-runtime/core/delegation-lifecycle-resolver.ts";

const ID = "20260823-205046-jw66";
const ROOT = "20260823-200000-root";
const HASH = "a".repeat(64);
const DECISION = "b".repeat(64);
const REASON = "c".repeat(64);
const LINEAGE = "d".repeat(64);
const CONTRACT = "e".repeat(64);
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

function terminalCommitted(status: "INTERRUPTED" | "FAILED", changedPaths: readonly string[] = ["src/repaired.ts"]) {
	return {
		proof: { schema_version: 2, delegation_id: ID, revision: 2, content_hash: "f".repeat(64) },
		state: {
			schema_version: 2,
			delegation_id: ID,
			status,
			task_kind: "implementation",
			contract_hash: CONTRACT,
			allowed_paths: ["src/**"],
			generation: 1,
			revision: 3,
			review: null,
			committed_proof: { schema_version: 2, delegation_id: ID, revision: 2, content_hash: "f".repeat(64) },
			terminal_outcome: {
				terminal_facts_complete: true,
				scope_complete: true,
				change_set_status: "ATTRIBUTED",
				changed_paths: [...changedPaths],
				delta_hash: changedPaths.length === 0 ? null : "1".repeat(64),
			},
		},
	} as never;
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
		`call workbench_repair_delegation with delegation_id=${ID} to execute the exact repair from durable authority`);
	assert.match(delegationRepairStatusLinesV1(status).join("\n"), /REPAIR_REQUIRED/);
	assert.match(delegationRepairStatusLinesV1(status).join("\n"), new RegExp(`workbench_repair_delegation with delegation_id=${ID}`));
	assert.doesNotMatch(delegationRepairStatusLinesV1(status).join("\n"), /call workbench_delegate_worker/u);
	assert.equal(
		delegationVerifyBlockReasonV1({ ...state, status: "PENDING_REVIEW" }, status),
		`VERIFY mode / final gate verification is blocked by canonical lifecycle action EXECUTE_EXACT_REPAIR (EXACT_REPAIR_DECISION_CURRENT) for delegation ${ID}; call workbench_repair_delegation with delegation_id=${ID} to execute the exact repair from durable authority`,
		"VERIFY guidance follows the resolver action and never repeats a stale session-status label",
	);
	assert.equal(
		delegationExactRepairRouteLineV1(status),
		`repair route : ALLOWED — ordinary/new delegations remain blocked; call workbench_repair_delegation with delegation_id=${ID} to execute the exact repair from durable authority`,
	);
});

test("strict terminal-negative sidecars survive status reload and route directly to q-repair", async () => {
	for (const terminalStatus of ["INTERRUPTED", "FAILED"] as const) {
		const projected = await readDelegationRepairStatusV1("/tmp/project", state, (async () => {
			throw new Error("unused");
		}) as ExecFn, {
			readRepairClosure: async () => ({ ok: true, unresolvedTipId: ID, rootCount: 1, lineageCount: 0 }),
			readAuthority: async () => observation({
				transactionStatus: terminalStatus,
				semanticRepair: {
					decisionHash: DECISION,
					reasonHash: REASON,
					expectedBindingHash: HASH,
					reviewer: "openai-codex/gpt-5.6-sol",
					decidedAt: "2026-08-23T20:51:00.000Z",
				},
			}),
			collectBinding: async () => ({ status: "fresh", hash: HASH, kind: "changeset-relevance-v2" }),
			readCommittedGeneration: async () => ({ ok: true, value: terminalCommitted(terminalStatus) }),
		});
		assert.equal(projected.kind, "repair_required");
		assert.match(delegationNextActionTextV1(state, projected) ?? "", new RegExp(`workbench_repair_delegation with delegation_id=${ID}`));
		assert.match(delegationRepairStatusLinesV1(projected).join("\n"), /REPAIR_REQUIRED/u);
		assert.equal(delegationExactRepairRouteLineV1(projected),
			`repair route : ALLOWED — ordinary/new delegations remain blocked; call workbench_repair_delegation with delegation_id=${ID} to execute the exact repair from durable authority`);
	}
});

test("eligible terminal-negative authority without a sidecar routes to q-review, while corruption fails closed", async () => {
	const services = {
		readRepairClosure: async () => ({ ok: true as const, unresolvedTipId: ID, rootCount: 0, lineageCount: 0 }),
		readAuthority: async () => observation({ transactionStatus: "INTERRUPTED" }),
		collectBinding: async () => ({ status: "fresh" as const, hash: HASH, kind: "changeset-relevance-v2" as const }),
		readCommittedGeneration: async () => ({ ok: true as const, value: terminalCommitted("INTERRUPTED") }),
	};
	const missing = await readDelegationRepairStatusV1("/tmp/project", state, (async () => {
		throw new Error("unused");
	}) as ExecFn, services);
	assert.equal(missing.kind, "terminal_negative_review");
	assert.equal(missing.resolution?.primary_action.action, "REVIEW_CANDIDATE");
	assert.match(delegationNextActionTextV1(state, missing) ?? "", new RegExp(`workbench_review_worker_diff with delegation_id=${ID}`));
	assert.match(delegationRepairStatusLinesV1(missing).join("\n"), /REPAIR-only Sol review/u);
	assert.match(delegationRepairStatusLinesV1(missing).join("\n"), /typed action : REVIEW_CANDIDATE/u);

	const corrupt = await readDelegationRepairStatusV1("/tmp/project", state, (async () => {
		throw new Error("unused");
	}) as ExecFn, {
		...services,
		readAuthority: async () => ({ kind: "invalid-v2", code: "invalid_record" }),
	});
	assert.equal(corrupt.kind, "authority_invalid");
	assert.equal(corrupt.resolution?.primary_action.action, "QUARANTINE_CORRUPT_AUTHORITY");
	const corruptAction = delegationNextActionTextV1(state, corrupt) ?? "";
	assert.match(corruptAction, /quarantine_unreadable_authority/u);
	assert.doesNotMatch(corruptAction, /\/q-(?:review|repair)/u);
});

test("a corrupt provisional review over readable committed authority resolves to regeneration, never quarantine", async () => {
	const resolution = resolveDelegationLifecycleV1(
		delegationLifecycleSnapshotFromInvalidDerivedReviewV1(ID, { status: "PENDING_REVIEW" }),
		{ schema_version: 1, kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1, event: "OBSERVE", expected_snapshot_hash: null },
	);
	const projected = await readDelegationRepairStatusV1("/tmp/project", state, (async () => {
		throw new Error("unused");
	}) as ExecFn, {
		readRepairClosure: async () => ({ ok: true, unresolvedTipId: null, rootCount: 0, lineageCount: 0 }),
		readAuthority: async () => ({
			kind: "derived-review-invalid", transactionStatus: "PENDING_REVIEW", code: "invalid_record", resolution,
		}),
		collectBinding: async () => ({ status: "fresh", hash: HASH, kind: "changeset-relevance-v2" }),
	});
	assert.equal(projected.kind, "derived_review_invalid");
	if (projected.kind !== "derived_review_invalid") return;
	assert.equal(projected.resolution.state, "INVALID_DERIVED_EVIDENCE");
	assert.equal(projected.resolution.primary_action.action, "REGENERATE_DERIVED_REVIEW");
	const guidance = delegationNextActionTextV1(state, projected) ?? "";
	assert.match(guidance, /workbench_review_worker_diff/u);
	assert.match(guidance, /do not quarantine/u);
	assert.doesNotMatch(guidance, /quarantine_unreadable_authority/u);
	assert.match(delegationRepairStatusLinesV1(projected).join("\n"), /typed action : REGENERATE_DERIVED_REVIEW/u);
});

test("an eligible lineaged INTERRUPTED tip routes to q-review instead of generic recovery", async () => {
	const lineage = {
		rootDelegationId: ROOT,
		repairOf: ROOT,
		rootDecisionHash: DECISION,
		continuationDecisionDelegationId: ROOT,
		continuationDecisionHash: DECISION,
		lineageHash: LINEAGE,
		depth: 1,
		carriedPathCount: 1,
	};
	const committed = terminalCommitted("INTERRUPTED") as any;
	committed.state.repair_lineage = {
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: ROOT,
		repair_of: ROOT,
		root_decision_hash: DECISION,
		continuation_decision_delegation_id: ROOT,
		continuation_decision_hash: DECISION,
		parent_lineage_hash: null,
		lineage_hash: LINEAGE,
		depth: 1,
		carried_paths: ["src/root.ts"],
	};
	const projected = await readDelegationRepairStatusV1("/tmp/project", state, (async () => {
		throw new Error("unused");
	}) as ExecFn, {
		readRepairClosure: async () => ({ ok: true, unresolvedTipId: ID, rootCount: 1, lineageCount: 1 }),
		readAuthority: async () => observation({ transactionStatus: "INTERRUPTED", repairLineage: lineage }),
		collectBinding: async () => ({ status: "fresh", hash: HASH, kind: "changeset-relevance-v2" }),
		readCommittedGeneration: async () => ({ ok: true, value: committed }),
	});
	assert.equal(projected.kind, "terminal_negative_review");
	assert.match(delegationNextActionTextV1(state, projected) ?? "", new RegExp(`workbench_review_worker_diff with delegation_id=${ID}`));
});

test("a lineageless attributed zero-delta failure is satisfied and never becomes recovery noise", async () => {
	const projected = await readDelegationRepairStatusV1("/tmp/project", state, (async () => {
		throw new Error("unused");
	}) as ExecFn, {
		readRepairClosure: async () => ({ ok: true, unresolvedTipId: ID, rootCount: 0, lineageCount: 0 }),
		readAuthority: async () => observation({ transactionStatus: "FAILED" }),
		collectBinding: async () => ({ status: "fresh", hash: HASH, kind: "changeset-relevance-v2" }),
		readCommittedGeneration: async () => ({ ok: true, value: terminalCommitted("FAILED", []) }),
	});
	assert.equal(projected.kind, "none");
	assert.equal(projected.resolution?.state, "SATISFIED_NO_DELTA");
	assert.equal(projected.resolution?.primary_action.action, "CLOSE_SATISFIED_NO_DELTA");
	assert.doesNotMatch(delegationNextActionTextV1(state, projected) ?? "", /q-review/u);
	assert.doesNotMatch(delegationNextActionTextV1(state, projected) ?? "", /strict path-lane admission/u);
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
	const conflictAction = delegationNextActionTextV1(state, conflict) ?? "";
	assert.doesNotMatch(conflictAction, /start the exact semantic repair/);
	assert.match(conflictAction, /start a fresh bounded successor delegation/u);
	assert.equal(conflict.resolution?.primary_action.action, "REBASE_CURRENT_BINDING");
	assert.doesNotMatch(conflictAction, /workbench_repair_delegation/u);
	assert.equal(delegationExactRepairRouteLineV1(conflict), undefined);

	const invalid = await readDelegationRepairStatusV1("/tmp/project", state, (async () => {
		throw new Error("unused");
	}) as ExecFn, {
		readAuthority: async () => ({ kind: "invalid-v2", code: "repair_lineage_fork" }),
		collectBinding: async () => ({ status: "unavailable" }),
	});
	assert.equal(invalid.kind, "authority_invalid");
	assert.equal(invalid.resolution?.primary_action.action, "QUARANTINE_CORRUPT_AUTHORITY");
	const next = delegationNextActionTextV1(state, invalid) ?? "";
	assert.match(next, /quarantine_unreadable_authority/u);
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
	});
	assert.equal(invalid.kind, "authority_invalid");
	assert.equal(invalid.resolution?.primary_action.action, "QUARANTINE_CORRUPT_AUTHORITY");
	const next = delegationNextActionTextV1(empty, invalid) ?? "";
	assert.match(next, /select and quarantine the exact unreadable project authority/u);
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
	});
	assert.equal(projected.kind, "repair_required");
	if (projected.kind === "repair_required") assert.equal(projected.delegationId, hiddenTip);
	assert.deepEqual(readIds, [hiddenTip, hiddenTip]);
	assert.match(delegationNextActionTextV1(state, projected) ?? "", new RegExp(`workbench_repair_delegation with delegation_id=${hiddenTip}`));
	assert.doesNotMatch(delegationNextActionTextV1(state, projected) ?? "", /start the next delegation/);
	const unavailable = delegationProjectIssueRepairStatusV1({ code: "binding_unavailable" });
	assert.equal(unavailable?.kind, "authority_invalid");
	assert.equal(unavailable?.resolution?.primary_action.action, "REPORT_STORAGE_FAILURE");
});

test("readable historical multiplicity is not projected as corrupt authority", async () => {
	for (const code of ["additional_unresolved_authority", "repair_lineage_multiple_unresolved"] as const) {
		const tip = "20260827-120000-mult";
		const projected = delegationProjectIssueRepairStatusV1({ code, delegationId: tip });
		assert.equal(projected?.kind, "historical_multiplicity");
		assert.equal(projected?.resolution?.primary_action.action, "BLOCK_OVERLAPPING_PATHS");
		if (projected === undefined) continue;
		const lines = delegationRepairStatusLinesV1(projected).join("\n");
		const next = delegationNextActionTextV1(state, projected) ?? "";
		assert.match(lines, /HISTORICAL_MULTIPLICITY/u);
		assert.match(lines, /strict full-project path-lane admission/u);
		assert.match(lines, /overlap or unknown authority remains BLOCKED/u);
		assert.match(lines, /VERIFY remains BLOCKED/u);
		assert.doesNotMatch(lines, /workbench_repair_delegation/u);
		assert.doesNotMatch(lines, /INVALID/u);
		assert.match(next, /overlapping or unknown path authority/u);
		assert.match(next, /VERIFY remain blocked/u);
		assert.equal(delegationExactRepairRouteLineV1(projected), undefined);
	}
});

test("repair-status closure uses the same historical multiplicity classification", async () => {
	const tip = "20260827-120001-mul2";
	const projected = await readDelegationRepairStatusV1("/tmp/project", state, (async () => {
		throw new Error("unused");
	}) as ExecFn, {
		readRepairClosure: async () => ({
			ok: false,
			issue: { code: "repair_lineage_multiple_unresolved", delegationId: tip },
		}),
		readAuthority: async () => { throw new Error("must not read one arbitrary tip"); },
		collectBinding: async () => { throw new Error("must not collect one arbitrary tip"); },
	});
	assert.equal(projected.kind, "historical_multiplicity");
	assert.equal(projected.resolution?.primary_action.action, "BLOCK_OVERLAPPING_PATHS");
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
	assert.match(delegationNextActionTextV1(state, failed) ?? "", new RegExp(`workbench_repair_delegation with delegation_id=${ID}`));
	assert.match(delegationRepairStatusLinesV1(failed).join("\n"), new RegExp(`workbench_repair_delegation with delegation_id=${ID}`));

	const staleFailed = classifyDelegationRepairStatusV1({
		delegationId: ID,
		authority: observation({ transactionStatus: "FAILED", repairLineage: lineage }),
		binding: { status: "conflict", hash: "f".repeat(64), kind: "changeset-relevance-v2", code: "binding_conflict" },
		retryable: true,
	});
	assert.equal(staleFailed.resolution?.primary_action.action, "REBASE_CURRENT_BINDING");
	assert.match(delegationNextActionTextV1(state, staleFailed) ?? "", /start a fresh bounded successor delegation/u);
	assert.doesNotMatch(delegationRepairStatusLinesV1(staleFailed).join("\n"), /workbench_repair_delegation/u);

	const active = classifyDelegationRepairStatusV1({
		delegationId: ID,
		authority: observation({ transactionStatus: "RUNNING", repairLineage: lineage }),
		binding: { status: "fresh", hash: HASH, kind: "changeset-relevance-v2" },
	});
	assert.equal(active.kind, "repair_active");
	assert.match(delegationNextActionTextV1(state, active) ?? "", /active writer.*wait for its durable result/u);
	assert.doesNotMatch(delegationNextActionTextV1(state, active) ?? "", /review delegation/);

	const pending = classifyDelegationRepairStatusV1({
		delegationId: ID,
		authority: observation({ transactionStatus: "PENDING_REVIEW", repairLineage: lineage }),
		binding: { status: "fresh", hash: HASH, kind: "changeset-relevance-v2" },
	});
	assert.equal(pending.kind, "repair_review");
	assert.match(delegationNextActionTextV1(state, pending) ?? "", new RegExp(`workbench_review_worker_diff with delegation_id=${ID}`));
});

test("status lines expose the canonical typed action recovered by the status reader", () => {
	const resolution = resolveDelegationLifecycleV1(
		delegationLifecycleSnapshotFromReviewCandidateV1({
			delegation_id: ID,
			source_authority: { proof: HASH },
			affected_paths: ["src/repaired.ts"],
			review_required: true,
		}),
		{ schema_version: 1, kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1, event: "OBSERVE", expected_snapshot_hash: null },
	);
	const status = {
		kind: "repair_review" as const,
		delegationId: ID,
		transactionStatus: "PENDING_REVIEW",
		rootDelegationId: ROOT,
		lineageHash: LINEAGE,
		depth: 1,
		resolution,
	};
	const lines = delegationRepairStatusLinesV1(status);
	assert.equal(lines.filter((line) => line.startsWith("typed action :")).length, 1);
	assert.match(lines.join("\n"), /typed action : REVIEW_CANDIDATE \(CURRENT_DELTA_REVIEW_REQUIRED\)/u);
});

test("ordinary active and retryable v2 transactions consume the canonical action, never the mirror instruction", () => {
	const ordinaryFailed = classifyDelegationRepairStatusV1({
		delegationId: ID,
		authority: observation({ transactionStatus: "FAILED", repairLineage: undefined }),
		binding: { status: "fresh", hash: HASH, kind: "changeset-relevance-v2" },
		retryable: true,
	});
	assert.equal(ordinaryFailed.kind, "delegation_retry");
	assert.equal(ordinaryFailed.resolution?.primary_action.action, "EXECUTE_EXACT_REPAIR");
	assert.match(delegationNextActionTextV1(state, ordinaryFailed) ?? "", new RegExp(`workbench_repair_delegation with delegation_id=${ID}`));
	assert.doesNotMatch(delegationRepairStatusLinesV1(ordinaryFailed).join("\n"), /call workbench_delegate_worker/u);
	assert.doesNotMatch(delegationNextActionTextV1(state, ordinaryFailed) ?? "", /review delegation/);

	const ordinaryRunning = classifyDelegationRepairStatusV1({
		delegationId: ID,
		authority: observation({ transactionStatus: "RUNNING", repairLineage: undefined }),
		binding: { status: "fresh", hash: HASH, kind: "changeset-relevance-v2" },
	});
	assert.equal(ordinaryRunning.kind, "delegation_active");
	assert.match(delegationNextActionTextV1(state, ordinaryRunning) ?? "", /active writer.*wait for its durable result/u);
	assert.doesNotMatch(delegationNextActionTextV1(state, ordinaryRunning) ?? "", /review delegation/);
});

test("status display uses durable execution while preserving pending/stale terminal completion", () => {
	assert.equal(delegationDisplayedStatusV1("PENDING_REVIEW", "FAILED"), "FAILED");
	assert.equal(delegationDisplayedStatusV1("PENDING_REVIEW", "RUNNING"), "RUNNING");
	assert.equal(delegationDisplayedStatusV1("PENDING_REVIEW", "REVIEWED"), "PENDING_REVIEW");
	assert.equal(delegationDisplayedStatusV1("STALE", "REVIEWED"), "STALE");
	assert.equal(delegationDisplayedStatusV1("REVIEWED", "FINISHED"), "FINISHED");
});
