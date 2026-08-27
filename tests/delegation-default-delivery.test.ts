import assert from "node:assert/strict";
import { test } from "node:test";

import {
	completeDefaultDelegationDeliveryV2,
	DEFAULT_DELIVERY_REVIEW_MAX_BYTES,
	DEFAULT_DELIVERY_REVIEW_MAX_LINES,
	DEFAULT_DELIVERY_REVIEW_MAX_SEGMENTS,
} from "../extensions/workbench-runtime/core/delegation-default-delivery.ts";
import type { DelegationReviewV2Result } from "../extensions/workbench-runtime/core/delegation-review-v2.ts";
import type { DelegationState } from "../extensions/workbench-runtime/core/delegation-state.ts";
import type { AutomaticSemanticReviewInput } from "../extensions/workbench-runtime/core/automatic-semantic-review-service.ts";

const ID = "20260820-190000-auto";
const BEFORE_HASH = "a".repeat(64);
const REVIEW_HASH = "b".repeat(64);
const NOW = "2026-08-20T19:00:00.000Z";

function pendingState(overrides: Partial<DelegationState> = {}): DelegationState {
	return {
		latestId: ID,
		status: "PENDING_REVIEW",
		currentDiffHash: BEFORE_HASH,
		blockedWriteAttempts: 0,
		updatedAt: "2026-08-20T18:59:00.000Z",
		...overrides,
	};
}

function successfulReview(
	overrides: Record<string, unknown> = {},
	finalized = false,
): Extract<DelegationReviewV2Result, { ok: true }> {
	return {
		ok: true,
		finalized,
		review_hash: "c".repeat(64),
		review_path: `.pi/workbench/delegations/${ID}/v2/review.json`,
		transaction: {} as never,
		review: {
			ok: true,
			lines: ["Review: PASS"],
			record: {
				schema_version: 2,
				delegation_id: ID,
				reviewed_at: NOW,
				allowed_paths: ["src/**"],
				checked_paths: ["src/a.ts"],
				displayed_paths: ["src/a.ts"],
				remaining_paths: [],
				fully_presented_paths: ["src/a.ts"],
				presentation_remaining_paths: [],
				presentation_complete: true,
				presentation_progress: [{
					path: "src/a.ts",
					source: "file-content",
					stream_sha256: "d".repeat(64),
					next_byte: 1,
					total_bytes: 1,
					segments: [{ start_byte: 0, end_byte: 1, page_sha256: "e".repeat(64) }],
				}],
				semantic_review: "required",
				path_stats: [],
				violations: [],
				notes: [],
				drift_paths: [],
				verdict: "PASS",
				mismatch: false,
				coverage_complete: true,
				bound_diff_hash: REVIEW_HASH,
				recorded_after_hash: REVIEW_HASH,
				patch: "",
				patch_truncated: false,
				patch_omitted_paths: 0,
				patch_omitted_bytes: 0,
				diff_identity_kind: "changeset-relevance-v2",
				relevance_binding: {} as never,
				relevance_projection: {} as never,
				...overrides,
			} as never,
		},
	};
}

function provisionalReview(
	overrides: Record<string, unknown>,
): Extract<DelegationReviewV2Result, { ok: true }> {
	return successfulReview(overrides, false);
}

const exec = async () => ({ code: 0, stdout: "", stderr: "", killed: false });

test("ordinary non-zero implementation returns one complete scope/integrity packet but stays PENDING for Sol ACCEPT", async () => {
	const persisted: DelegationState[] = [];
	let captured: Record<string, unknown> | undefined;
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts"],
		state: pendingState(),
		exec,
		now: NOW,
		persistState: (state) => persisted.push(state),
	}, {
		review: async (input) => {
			captured = input as unknown as Record<string, unknown>;
			return successfulReview();
		},
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.state.status, "PENDING_REVIEW");
	assert.equal(result.state.currentDiffHash, REVIEW_HASH);
	assert.equal(result.state.reviewedDiffHash, undefined);
	assert.deepEqual(persisted, [result.state]);
	assert.equal(result.review_kind, "scope_integrity");
	assert.equal(result.scope_integrity_verdict, "PASS");
	assert.equal(result.presentation_complete, true);
	assert.equal(result.semantic_review, "required");
	assert.equal(result.semantic_risk, "medium");
	assert.deepEqual(captured?.includePaths, ["src/a.ts"]);
	assert.equal(captured?.maxLines, DEFAULT_DELIVERY_REVIEW_MAX_LINES);
	assert.equal(captured?.maxBytes, DEFAULT_DELIVERY_REVIEW_MAX_BYTES);
});

test("incomplete default packet makes exactly one call and returns PENDING with explicit presentation incompleteness", async () => {
	const persisted: DelegationState[] = [];
	const included: string[][] = [];
	let calls = 0;
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
		state: pendingState(),
		exec,
		now: NOW,
		persistState: (state) => persisted.push(state),
	}, {
		review: async (input) => {
			included.push([...(input.includePaths ?? [])]);
			calls += 1;
			return provisionalReview({
				checked_paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
				displayed_paths: ["src/a.ts"],
				coverage_complete: false,
				remaining_paths: ["src/b.ts", "src/c.ts"],
				fully_presented_paths: ["src/a.ts"],
				presentation_remaining_paths: ["src/b.ts", "src/c.ts"],
				presentation_complete: false,
			});
		},
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.state.status, "PENDING_REVIEW");
	assert.equal(result.presentation_complete, false);
	assert.equal(calls, 1);
	assert.deepEqual(included, [["src/a.ts", "src/b.ts", "src/c.ts"]]);
	assert.deepEqual(persisted, [result.state]);
});

test("incomplete review with no remaining-path progress stays pending", async () => {
	const persisted: DelegationState[] = [];
	let calls = 0;
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts", "src/b.ts"],
		state: pendingState(),
		exec,
		now: NOW,
		persistState: (state) => persisted.push(state),
	}, {
		review: async () => {
			calls += 1;
			return provisionalReview({
				checked_paths: ["src/a.ts", "src/b.ts"],
				coverage_complete: false,
				remaining_paths: ["src/a.ts", "src/b.ts"],
				fully_presented_paths: [],
				presentation_remaining_paths: ["src/a.ts", "src/b.ts"],
				presentation_complete: false,
				presentation_progress: [],
			});
		},
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.presentation_complete, false);
	assert.equal(result.state.status, "PENDING_REVIEW");
	assert.equal(result.state.currentDiffHash, REVIEW_HASH);
	assert.equal(calls, 1);
	assert.deepEqual(persisted, [result.state]);
});

test("default delivery never auto-pages beyond its single handoff-sized segment", async () => {
	const changedPaths = Array.from(
		{ length: DEFAULT_DELIVERY_REVIEW_MAX_SEGMENTS + 1 },
		(_, index) => `src/${String(index).padStart(2, "0")}.ts`,
	);
	const included: string[][] = [];
	const persisted: DelegationState[] = [];
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths,
		state: pendingState(),
		exec,
		now: NOW,
		persistState: (state) => persisted.push(state),
	}, {
		review: async (input) => {
			const current = [...(input.includePaths ?? [])];
			included.push(current);
			return provisionalReview({
				checked_paths: current,
				coverage_complete: false,
				remaining_paths: current.slice(1),
				fully_presented_paths: [],
				presentation_remaining_paths: current,
				presentation_complete: false,
				presentation_progress: [],
			});
		},
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.presentation_complete, false);
	assert.equal(included.length, DEFAULT_DELIVERY_REVIEW_MAX_SEGMENTS);
	assert.deepEqual(included[0], changedPaths);
	assert.deepEqual(persisted, [result.state]);
});

test("default delivery binds only the single returned packet and never observes a hypothetical later segment", async () => {
	const persisted: DelegationState[] = [];
	let calls = 0;
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts", "src/b.ts"],
		state: pendingState(),
		exec,
		now: NOW,
		persistState: (state) => persisted.push(state),
	}, {
		review: async () => {
			calls += 1;
			return provisionalReview({
				coverage_complete: false,
				remaining_paths: ["src/b.ts"],
				presentation_complete: false,
				presentation_remaining_paths: ["src/b.ts"],
			});
		},
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.state.status, "PENDING_REVIEW");
	assert.equal(result.state.currentDiffHash, REVIEW_HASH);
	assert.equal(calls, 1);
	assert.deepEqual(persisted, [result.state]);
});

test("scope/integrity FAIL returns its packet without closing or replaying", async () => {
	const persisted: DelegationState[] = [];
	let calls = 0;
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts"],
		state: pendingState(),
		exec,
		now: NOW,
		persistState: (state) => persisted.push(state),
	}, {
		review: async () => {
			calls += 1;
			return provisionalReview({
				verdict: "FAIL",
				coverage_complete: true,
				remaining_paths: [],
				violations: [{ path: "src/a.ts", reason: "outside allowed scope" }],
			});
		},
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.scope_integrity_verdict, "FAIL");
	assert.equal(result.presentation_complete, false);
	assert.equal(result.state.status, "PENDING_REVIEW");
	assert.equal(result.automatic_semantic_review?.status, "RETRYABLE_FAILURE");
	assert.equal(result.automatic_semantic_review?.code, "MECHANICAL_SCOPE_INTEGRITY_FAILED");
	assert.equal(result.automatic_semantic_review?.next_action, `/q-review ${ID}`);
	assert.equal(calls, 1);
	assert.deepEqual(persisted, [result.state]);
});

test("review conflict updates the blocking hash without claiming delivery", async () => {
	const conflictHash = "d".repeat(64);
	const persisted: DelegationState[] = [];
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts"],
		state: pendingState(),
		exec,
		now: NOW,
		persistState: (state) => persisted.push(state),
	}, {
		review: async () => ({
			ok: false,
			error: { code: "review_conflict", message: "bounded" },
			binding_hash: conflictHash,
		}),
	});

	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "review_failed");
	assert.equal(result.review_error, "review_conflict");
	assert.equal(persisted[0]?.status, "PENDING_REVIEW");
	assert.equal(persisted[0]?.currentDiffHash, conflictHash);
});

test("scope/integrity storage failure stays pending and fails the delivery boundary", async () => {
	const persisted: DelegationState[] = [];
	let calls = 0;
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts", "src/b.ts"],
		state: pendingState(),
		exec,
		now: NOW,
		persistState: (state) => persisted.push(state),
	}, {
		review: async () => {
			calls += 1;
			return {
				ok: false,
				error: { code: "storage_failure", message: "injected" },
			};
		},
	});

	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, "review_failed");
	assert.equal(result.review_error, "storage_failure");
	assert.equal(result.state.status, "PENDING_REVIEW");
	assert.equal(result.state.currentDiffHash, BEFORE_HASH);
	assert.equal(calls, 1);
	assert.deepEqual(persisted, []);
});

test("complete zero-delta packet is the only mechanical implementation closure", async () => {
	const persisted: DelegationState[] = [];
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: [],
		state: pendingState(),
		exec,
		now: NOW,
		persistState: (state) => persisted.push(state),
	}, {
		review: async () => successfulReview({
			checked_paths: [],
			displayed_paths: [],
			remaining_paths: [],
			fully_presented_paths: [],
			presentation_remaining_paths: [],
			presentation_complete: true,
			presentation_progress: [],
			semantic_review: "not_required",
			patch: [],
		}, true),
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.state.status, "REVIEWED");
	assert.equal(result.semantic_review, "not_required");
	assert.equal(result.semantic_risk, "low");
	assert.deepEqual(persisted, [result.state]);
});

test("session append failure preserves successful durable delivery and returns a confirmed warning", async () => {
	const state = pendingState();
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts"],
		state,
		exec,
		now: NOW,
		persistState: () => { throw new Error("injected"); },
	}, {
		review: async () => successfulReview(),
		readReview: async () => ({
			ok: true,
			value: {
				state: { status: "PENDING_REVIEW" },
				review_hash: "c".repeat(64),
				review_path: `.pi/workbench/delegations/${ID}/v2/review.json`,
				finalized: false,
			} as never,
		}),
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.state.status, "PENDING_REVIEW");
	assert.equal(result.state.currentDiffHash, REVIEW_HASH);
	assert.deepEqual(result.session_mirror_warning, {
		code: "session_mirror_append_failed",
		message: "durable review succeeded; session mirror append failed and will be reconciled from durable authority",
		durable_readback: "confirmed",
		durable_transaction_status: "PENDING_REVIEW",
		durable_review_finalized: false,
	});
});

test("zero-delta durable closure remains successful when the REVIEWED mirror append fails", async () => {
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: [],
		state: pendingState(),
		exec,
		now: NOW,
		persistState: () => { throw new Error("injected"); },
	}, {
		review: async () => successfulReview({
			checked_paths: [],
			displayed_paths: [],
			remaining_paths: [],
			fully_presented_paths: [],
			presentation_remaining_paths: [],
			presentation_progress: [],
			semantic_review: "not_required",
			patch: [],
		}, true),
		readReview: async () => ({
			ok: true,
			value: {
				state: { status: "REVIEWED" },
				review_hash: "c".repeat(64),
				review_path: `.pi/workbench/delegations/${ID}/v2/review.json`,
				finalized: true,
			} as never,
		}),
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.state.status, "REVIEWED");
	assert.equal(result.session_mirror_warning?.durable_readback, "confirmed");
	assert.equal(result.session_mirror_warning?.durable_transaction_status, "REVIEWED");
});

test("a different latest delegation is rejected before review", async () => {
	let calls = 0;
	const state = pendingState({ latestId: "different" });
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts"],
		state,
		exec,
		now: NOW,
		persistState: () => assert.fail("must not persist"),
	}, {
		review: async () => { calls += 1; return successfulReview(); },
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, "state_transition_failed");
	assert.equal(calls, 0);
});

test("complete default delivery automatically persists ACCEPT and projects REVIEWED", async () => {
	const completedAt = new Date("2026-08-20T19:05:00.000Z");
	const acceptedReview = successfulReview({
		semantic_review: "accepted",
		semantic_acceptance: {
			decision: "ACCEPT",
			expected_bound_diff_hash: REVIEW_HASH,
			reviewer: { provider: "openai-codex", model: "gpt-5.6-sol" },
			accepted_at: completedAt.toISOString(),
		},
	}, true);
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts"],
		state: pendingState(),
		exec,
		now: NOW,
		persistState: () => {},
		modelRegistry: {} as never,
	}, {
		review: async () => successfulReview(),
		now: () => completedAt,
		automaticSemanticReview: (async (input: AutomaticSemanticReviewInput) => {
			assert.equal(input.now?.().toISOString(), completedAt.toISOString(), "semantic accepted_at uses completion clock, not worker-start timestamp");
			return {
				status: "ACCEPT",
				delegation_id: ID,
				bound_diff_hash: REVIEW_HASH,
				durable: true,
				replayed: false,
				receipt_hash: "f".repeat(64),
				nested_usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				mechanical_page_calls: 0,
				review_result: acceptedReview,
			};
		}) as never,
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.state.status, "REVIEWED");
	assert.equal(result.state.updatedAt, completedAt.toISOString());
	assert.equal(result.semantic_review, "accepted");
	assert.equal(result.automatic_semantic_review?.nested_usage.totalTokens, 15);
});

test("automatic semantic REPAIR stays worker-success/PENDING and routes only to q-repair", async () => {
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts"],
		state: pendingState(),
		exec,
		now: NOW,
		persistState: () => {},
		modelRegistry: {} as never,
	}, {
		review: async () => successfulReview(),
		automaticSemanticReview: (async () => ({
			status: "REPAIR",
			delegation_id: ID,
			bound_diff_hash: REVIEW_HASH,
			durable: true,
			replayed: false,
			receipt_hash: "e".repeat(64),
			nested_usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			mechanical_page_calls: 0,
			next_action: `/q-repair ${ID}`,
			review_result: successfulReview({}, false),
		})) as never,
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.state.status, "PENDING_REVIEW");
	assert.equal(result.semantic_review, "repair_required");
	assert.equal(result.automatic_semantic_review?.next_action, `/q-repair ${ID}`);
});

test("automatic model failure preserves worker-success/PENDING and exact q-review recovery", async () => {
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts"],
		state: pendingState(),
		exec,
		now: NOW,
		persistState: () => {},
		modelRegistry: {} as never,
	}, {
		review: async () => successfulReview(),
		automaticSemanticReview: (async () => ({
			status: "RETRYABLE_FAILURE",
			code: "MODEL_UNAVAILABLE",
			delegation_id: ID,
			bound_diff_hash: REVIEW_HASH,
			nested_usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			mechanical_page_calls: 0,
			next_action: `/q-review ${ID}`,
		})) as never,
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.state.status, "PENDING_REVIEW");
	assert.equal(result.semantic_review, "required");
	assert.equal(result.automatic_semantic_review?.next_action, `/q-review ${ID}`);
});
