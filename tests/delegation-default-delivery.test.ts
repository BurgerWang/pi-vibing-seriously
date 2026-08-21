import assert from "node:assert/strict";
import { test } from "node:test";

import {
	completeDefaultDelegationDeliveryV2,
	DEFAULT_DELIVERY_REVIEW_MAX_BYTES,
	DEFAULT_DELIVERY_REVIEW_MAX_LINES,
} from "../extensions/workbench-runtime/core/delegation-default-delivery.ts";
import type { DelegationReviewV2Result } from "../extensions/workbench-runtime/core/delegation-review-v2.ts";
import type { DelegationState } from "../extensions/workbench-runtime/core/delegation-state.ts";

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

function successfulReview(overrides: Record<string, unknown> = {}): DelegationReviewV2Result {
	return {
		ok: true,
		finalized: true,
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
				path_stats: [],
				violations: [],
				notes: [],
				verdict: "PASS",
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

const exec = async () => ({ code: 0, stdout: "", stderr: "", killed: false });

test("ordinary implementation auto-reviews once and persists REVIEWED", async () => {
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
	assert.equal(result.state.status, "REVIEWED");
	assert.equal(result.state.currentDiffHash, REVIEW_HASH);
	assert.equal(result.state.reviewedDiffHash, REVIEW_HASH);
	assert.deepEqual(persisted, [result.state]);
	assert.deepEqual(captured?.includePaths, ["src/a.ts"]);
	assert.equal(captured?.maxLines, DEFAULT_DELIVERY_REVIEW_MAX_LINES);
	assert.equal(captured?.maxBytes, DEFAULT_DELIVERY_REVIEW_MAX_BYTES);
});

test("incomplete review stays pending for explicit recovery", async () => {
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
		review: async () => successfulReview({ coverage_complete: false, remaining_paths: ["src/a.ts"] }),
	});

	assert.deepEqual(result, {
		ok: false,
		code: "review_incomplete",
		state: persisted[0],
		review_path: `.pi/workbench/delegations/${ID}/v2/review.json`,
	});
	assert.equal(persisted[0]?.status, "PENDING_REVIEW");
	assert.equal(persisted[0]?.currentDiffHash, REVIEW_HASH);
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

test("session append failure never exposes REVIEWED", async () => {
	const state = pendingState();
	const result = await completeDefaultDelegationDeliveryV2({
		projectRoot: "/project",
		delegationId: ID,
		changedPaths: ["src/a.ts"],
		state,
		exec,
		now: NOW,
		persistState: () => { throw new Error("injected"); },
	}, { review: async () => successfulReview() });

	assert.deepEqual(result, {
		ok: false,
		code: "session_persistence_failed",
		state,
		review_path: `.pi/workbench/delegations/${ID}/v2/review.json`,
	});
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
