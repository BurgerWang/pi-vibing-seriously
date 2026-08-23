/**
 * P7 tests for the pure delegation lifecycle state (core/delegation-state.ts).
 *
 * Focus: latest id, PENDING_REVIEW -> REVIEWED -> STALE transitions,
 * REVIEWED bound to the reviewed diff hash (auto-stale on diff change),
 * the fail-closed hash-binding invariants (REVIEWED reviewed===current,
 * PENDING_REVIEW without reviewed hash, STALE with reviewed !== current),
 * the fail-closed demoteReviewedToPending invalidation (scope FAIL of the
 * same current diff demotes REVIEWED to PENDING_REVIEW and clears the
 * reviewed hash while pending/stale stay safely blocking),
 * blocking of the next delegation and VERIFY while pending/stale,
 * the blocked write-attempt counter, and fail-closed serialization/restore
 * plus the compact-safe summary.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	blocksNextDelegation,
	blocksVerify,
	delegationCompactSummary,
	demoteReviewedToPending,
	emptyDelegationState,
	hasPendingReview,
	hasStaleReview,
	markSemanticAccepted,
	markReviewed,
	MAX_BLOCKED_WRITE_ATTEMPTS,
	observeDiffChange,
	recordBlockedWriteAttempt,
	recordDelegation,
	recordRepairDelegation,
	recordSuccessorAfterFinalizedReview,
	restoreDelegationState,
	reviewBlockReason,
	serializeDelegationState,
	type DelegationState,
} from "../extensions/workbench-runtime/core/delegation-state.ts";

const NOW = "2026-06-01T12:00:00.000Z";
const LATER = "2026-06-01T13:00:00.000Z";

const DIFF_A = "a".repeat(64);
const DIFF_B = "b".repeat(64);
const DIFF_C = "c".repeat(64);

function recordOk(state: DelegationState, id = "dlg-1", diffHash = DIFF_A): DelegationState {
	const result = recordDelegation(state, { id, diffHash, now: NOW });
	if (!result.ok) throw new Error(result.error);
	return result.state;
}

function reviewedOk(state: DelegationState): DelegationState {
	const result = markReviewed(state, NOW);
	if (!result.ok) throw new Error(result.error);
	return result.state;
}

// ---------------------------------------------------------------------------
// empty state and recording
// ---------------------------------------------------------------------------

test("empty delegation state has no delegation and blocks nothing", () => {
	const state = emptyDelegationState();
	assert.equal(state.latestId, undefined);
	assert.equal(state.status, "PENDING_REVIEW");
	assert.equal(hasPendingReview(state), false);
	assert.equal(hasStaleReview(state), false);
	assert.equal(blocksNextDelegation(state), false);
	assert.equal(blocksVerify(state), false);
	assert.equal(reviewBlockReason(state, "delegation"), undefined);
	assert.equal(reviewBlockReason(state, "verify"), undefined);
	assert.equal(delegationCompactSummary(state), "DELEGATION none");
});

test("recording a delegation starts PENDING_REVIEW with the current diff hash", () => {
	const state = recordOk(emptyDelegationState());
	assert.equal(state.latestId, "dlg-1");
	assert.equal(state.status, "PENDING_REVIEW");
	assert.equal(state.currentDiffHash, DIFF_A);
	assert.equal(state.reviewedDiffHash, undefined);
	assert.equal(state.blockedWriteAttempts, 0);
	assert.equal(hasPendingReview(state), true);
	assert.equal(blocksNextDelegation(state), true);
	assert.equal(blocksVerify(state), true);
	// Invalid ids / hashes are refused.
	assert.equal(recordDelegation(emptyDelegationState(), { id: "", diffHash: DIFF_A, now: NOW }).ok, false);
	assert.equal(recordDelegation(emptyDelegationState(), { id: "dlg-2", diffHash: "  ", now: NOW }).ok, false);
});

test("a pending or stale review blocks the next delegation; REVIEWED allows it", () => {
	// Pending blocks.
	assert.equal(recordDelegation(recordOk(emptyDelegationState()), { id: "dlg-2", diffHash: DIFF_B, now: NOW }).ok, false);
	// Stale blocks.
	const stale = observeDiffChange(reviewedOk(recordOk(emptyDelegationState())), DIFF_B, LATER);
	assert.equal(recordDelegation(stale, { id: "dlg-2", diffHash: DIFF_B, now: LATER }).ok, false);
	// Reviewed allows the next delegation, which starts fresh pending with the new hash.
	const reviewed = reviewedOk(recordOk(emptyDelegationState()));
	const next = recordOk(reviewed, "dlg-2", DIFF_B);
	assert.equal(next.latestId, "dlg-2");
	assert.equal(next.status, "PENDING_REVIEW");
	assert.equal(next.currentDiffHash, DIFF_B);
	assert.equal(next.reviewedDiffHash, undefined, "a new delegation clears the previously reviewed hash");
});

test("an exact explicit repair may supersede only its latest blocking delegation", () => {
	const pending = recordOk(emptyDelegationState(), "broken-1", DIFF_A);
	const repaired = recordRepairDelegation(pending, { id: "repair-1", diffHash: DIFF_B, now: LATER }, "broken-1");
	assert.equal(repaired.ok, true);
	if (repaired.ok) {
		assert.equal(repaired.state.latestId, "repair-1");
		assert.equal(repaired.state.status, "PENDING_REVIEW");
		assert.equal(repaired.state.currentDiffHash, DIFF_B);
	}
	assert.equal(recordRepairDelegation(pending, { id: "repair-2", diffHash: DIFF_B, now: LATER }, "other").ok, false);
	assert.equal(recordRepairDelegation(reviewedOk(pending), { id: "repair-2", diffHash: DIFF_B, now: LATER }, "broken-1").ok, false);
	assert.equal(recordRepairDelegation(pending, { id: "broken-1", diffHash: DIFF_B, now: LATER }, "broken-1").ok, false);
});

test("a strictly authorized successor may replace only the exact latest STALE mirror", () => {
	const pending = recordOk(emptyDelegationState(), "reviewed-1", DIFF_A);
	const stale = observeDiffChange(reviewedOk(pending), DIFF_B, LATER);
	const withBlockedAttempt = recordBlockedWriteAttempt(stale, LATER);
	const successor = recordSuccessorAfterFinalizedReview(
		withBlockedAttempt,
		{ id: "successor-1", diffHash: DIFF_B, now: LATER },
		"reviewed-1",
	);
	assert.equal(successor.ok, true);
	if (successor.ok) {
		assert.equal(successor.state.latestId, "successor-1");
		assert.equal(successor.state.status, "PENDING_REVIEW");
		assert.equal(successor.state.currentDiffHash, DIFF_B);
		assert.equal(successor.state.reviewedDiffHash, undefined);
		assert.equal(successor.state.blockedWriteAttempts, 1);
	}
	assert.equal(
		recordSuccessorAfterFinalizedReview(stale, { id: "successor-2", diffHash: DIFF_B, now: LATER }, "other").ok,
		false,
	);
	assert.equal(
		recordSuccessorAfterFinalizedReview(pending, { id: "successor-2", diffHash: DIFF_B, now: LATER }, "reviewed-1").ok,
		false,
	);
	assert.equal(
		recordSuccessorAfterFinalizedReview(reviewedOk(pending), { id: "successor-2", diffHash: DIFF_B, now: LATER }, "reviewed-1").ok,
		false,
	);
	assert.equal(
		recordSuccessorAfterFinalizedReview(stale, { id: "reviewed-1", diffHash: DIFF_B, now: LATER }, "reviewed-1").ok,
		false,
	);
});

// ---------------------------------------------------------------------------
// review lifecycle and diff-hash binding
// ---------------------------------------------------------------------------

test("markReviewed binds REVIEWED to the current diff hash", () => {
	const state = reviewedOk(recordOk(emptyDelegationState()));
	assert.equal(state.status, "REVIEWED");
	assert.equal(state.reviewedDiffHash, state.currentDiffHash);
	assert.equal(state.reviewedDiffHash, DIFF_A);
	assert.equal(hasPendingReview(state), false);
	assert.equal(blocksNextDelegation(state), false);
	assert.equal(blocksVerify(state), false);
	// Reviewing again is refused.
	assert.equal(markReviewed(state, LATER).ok, false);
	// Reviewing without any delegation is refused.
	assert.equal(markReviewed(emptyDelegationState(), NOW).ok, false);
});

test("markSemanticAccepted requires the exact latest delegation and current bound hash", () => {
	const pending = recordOk(emptyDelegationState());
	const accepted = markSemanticAccepted(pending, { delegationId: "dlg-1", expectedDiffHash: DIFF_A, now: LATER });
	assert.equal(accepted.ok, true);
	if (accepted.ok) {
		assert.equal(accepted.state.status, "REVIEWED");
		assert.equal(accepted.state.reviewedDiffHash, DIFF_A);
	}
	assert.equal(markSemanticAccepted(pending, { delegationId: "other", expectedDiffHash: DIFF_A, now: LATER }).ok, false);
	assert.equal(markSemanticAccepted(pending, { delegationId: "dlg-1", expectedDiffHash: DIFF_B, now: LATER }).ok, false);
	assert.equal(markSemanticAccepted(emptyDelegationState(), { delegationId: "dlg-1", expectedDiffHash: DIFF_A, now: LATER }).ok, false);
});

test("a current diff hash change after review automatically marks the delegation STALE", () => {
	const reviewed = reviewedOk(recordOk(emptyDelegationState()));
	const stale = observeDiffChange(reviewed, DIFF_B, LATER);
	assert.equal(stale.status, "STALE");
	assert.equal(stale.currentDiffHash, DIFF_B, "the current hash tracks the new diff");
	assert.equal(stale.reviewedDiffHash, DIFF_A, "the reviewed hash keeps the diff that was actually reviewed");
	assert.equal(hasStaleReview(stale), true);
	assert.equal(blocksNextDelegation(stale), true);
	assert.equal(blocksVerify(stale), true);
	// Identical hashes and empty hashes are no-ops.
	assert.equal(observeDiffChange(reviewed, DIFF_A, LATER), reviewed);
	assert.equal(observeDiffChange(reviewed, "  ", LATER), reviewed);
});

test("pending diff changes stay pending; stale requires reviewed !== current and reverts on return", () => {
	const pending = recordOk(emptyDelegationState());
	const changed = observeDiffChange(pending, DIFF_B, LATER);
	assert.equal(changed.status, "PENDING_REVIEW");
	assert.equal(changed.currentDiffHash, DIFF_B);
	assert.equal(blocksNextDelegation(changed), true);
	// STALE always binds reviewedDiffHash !== currentDiffHash.
	const stale = observeDiffChange(reviewedOk(recordOk(emptyDelegationState())), DIFF_B, LATER);
	assert.equal(stale.status, "STALE");
	assert.notEqual(stale.reviewedDiffHash, stale.currentDiffHash);
	assert.equal(stale.reviewedDiffHash, DIFF_A);
	assert.equal(stale.currentDiffHash, DIFF_B);
	// A further change to a third hash keeps STALE with reviewed !== current.
	const staleThird = observeDiffChange(stale, DIFF_C, NOW);
	assert.equal(staleThird.status, "STALE");
	assert.equal(staleThird.currentDiffHash, DIFF_C);
	assert.equal(staleThird.reviewedDiffHash, DIFF_A);
	assert.notEqual(staleThird.reviewedDiffHash, staleThird.currentDiffHash);
	// A stale diff returning to EXACTLY the reviewed hash re-validates the
	// review (back to REVIEWED), keeping reviewed === current.
	const reValidated = observeDiffChange(stale, DIFF_A, NOW);
	assert.equal(reValidated.status, "REVIEWED");
	assert.equal(reValidated.reviewedDiffHash, reValidated.currentDiffHash);
	assert.equal(reValidated.reviewedDiffHash, DIFF_A);
	// observeDiffChange without any delegation is a no-op.
	assert.deepEqual(observeDiffChange(emptyDelegationState(), DIFF_B, NOW), emptyDelegationState());
});

test("STALE is resolved by re-reviewing the current diff, which rebinds REVIEWED", () => {
	const stale = observeDiffChange(reviewedOk(recordOk(emptyDelegationState())), DIFF_B, LATER);
	assert.equal(stale.status, "STALE");
	const reReviewed = reviewedOk(stale);
	assert.equal(reReviewed.status, "REVIEWED");
	assert.equal(reReviewed.reviewedDiffHash, DIFF_B);
	assert.equal(reReviewed.currentDiffHash, DIFF_B);
	assert.equal(blocksNextDelegation(reReviewed), false);
	// The rebinding is live: a further diff change goes stale again.
	const staleAgain = observeDiffChange(reReviewed, DIFF_A, LATER);
	assert.equal(staleAgain.status, "STALE");
	assert.equal(staleAgain.reviewedDiffHash, DIFF_B);
});

// ---------------------------------------------------------------------------
// fail-closed REVIEWED invalidation (Slice B2)
// ---------------------------------------------------------------------------

test("demoteReviewedToPending invalidates a REVIEWED binding fail-closed: PENDING_REVIEW, reviewed hash cleared, blocking resumes", () => {
	const reviewed = reviewedOk(recordOk(emptyDelegationState()));
	const demoted = demoteReviewedToPending(reviewed, LATER);
	assert.ok(demoted.ok, demoted.ok ? "" : demoted.error);
	const state = demoted.state;
	assert.equal(state.status, "PENDING_REVIEW");
	assert.equal(state.reviewedDiffHash, undefined, "the reviewed hash is cleared");
	assert.equal(state.currentDiffHash, DIFF_A, "the current diff hash is kept — it is still the current diff");
	assert.equal(state.latestId, "dlg-1", "the delegation itself is kept");
	assert.equal(hasPendingReview(state), true);
	assert.equal(blocksNextDelegation(state), true);
	assert.equal(blocksVerify(state), true);
	assert.ok(reviewBlockReason(state, "delegation"));
	assert.ok(reviewBlockReason(state, "verify"));
	// The demoted state satisfies the PENDING_REVIEW hash-binding invariant
	// (no reviewed hash) and round-trips through restore.
	assert.deepEqual(restoreDelegationState(JSON.parse(JSON.stringify(serializeDelegationState(state)))), state);
	// The blocked-write counter survives the demotion.
	assert.equal(state.blockedWriteAttempts, reviewed.blockedWriteAttempts);
});

test("demoteReviewedToPending refuses PENDING_REVIEW / STALE / empty — those stay safely blocking and untouched", () => {
	const pending = recordOk(emptyDelegationState());
	const pendingResult = demoteReviewedToPending(pending, NOW);
	assert.equal(pendingResult.ok, false);
	assert.match(pendingResult.ok ? "" : pendingResult.error, /is PENDING_REVIEW, not REVIEWED/);
	assert.equal(pending.status, "PENDING_REVIEW");
	assert.equal(blocksNextDelegation(pending), true);

	const reviewed = reviewedOk(recordOk(emptyDelegationState()));
	const stale = observeDiffChange(reviewed, DIFF_B, LATER);
	const staleResult = demoteReviewedToPending(stale, NOW);
	assert.equal(staleResult.ok, false);
	assert.match(staleResult.ok ? "" : staleResult.error, /is STALE, not REVIEWED/);
	assert.equal(stale.status, "STALE");
	assert.equal(stale.reviewedDiffHash, DIFF_A, "STALE keeps its reviewed hash");
	assert.equal(blocksNextDelegation(stale), true);
	assert.equal(blocksVerify(stale), true);

	assert.equal(demoteReviewedToPending(emptyDelegationState(), NOW).ok, false);
	assert.deepEqual(emptyDelegationState(), emptyDelegationState());
});

test("review block reasons name the target and the outstanding review", () => {
	const pending = recordOk(emptyDelegationState());
	const delegationReason = reviewBlockReason(pending, "delegation");
	assert.ok(delegationReason);
	assert.match(delegationReason, /Starting a new worker delegation is blocked/);
	assert.match(delegationReason, /PENDING_REVIEW/);
	assert.match(delegationReason, /review the current diff/);
	const verifyReason = reviewBlockReason(pending, "verify");
	assert.ok(verifyReason);
	assert.match(verifyReason, /VERIFY mode \/ final gate verification is blocked/);
	const reviewed = reviewedOk(pending);
	assert.equal(reviewBlockReason(reviewed, "delegation"), undefined);
	assert.equal(reviewBlockReason(reviewed, "verify"), undefined);
});

// ---------------------------------------------------------------------------
// blocked write-attempt counter
// ---------------------------------------------------------------------------

test("blocked write-attempt counter increments monotonically, caps, and survives transitions", () => {
	let state = recordOk(emptyDelegationState());
	for (let i = 1; i <= 3; i++) {
		state = recordBlockedWriteAttempt(state, NOW);
		assert.equal(state.blockedWriteAttempts, i);
	}
	// Survives review and a subsequent delegation.
	const reviewed = reviewedOk(state);
	assert.equal(reviewed.blockedWriteAttempts, 3);
	const next = recordOk(reviewed, "dlg-2", DIFF_B);
	assert.equal(next.blockedWriteAttempts, 3);
	// Bounded at the ceiling.
	let capped = state;
	for (let i = 0; i < MAX_BLOCKED_WRITE_ATTEMPTS + 10; i++) {
		capped = recordBlockedWriteAttempt(capped, NOW);
	}
	assert.equal(capped.blockedWriteAttempts, MAX_BLOCKED_WRITE_ATTEMPTS);
});

// ---------------------------------------------------------------------------
// serialization / restore / compact summary
// ---------------------------------------------------------------------------

test("delegation state serialization round-trips exactly", () => {
	const scenarios = [
		emptyDelegationState(),
		recordOk(emptyDelegationState()),
		reviewedOk(recordOk(emptyDelegationState())),
		observeDiffChange(reviewedOk(recordOk(emptyDelegationState())), DIFF_B, LATER),
		recordBlockedWriteAttempt(recordOk(emptyDelegationState()), NOW),
		// A stale diff returning to the reviewed hash re-validates (REVIEWED).
		observeDiffChange(observeDiffChange(reviewedOk(recordOk(emptyDelegationState())), DIFF_B, LATER), DIFF_A, NOW),
	];
	for (const state of scenarios) {
		const restored = restoreDelegationState(JSON.parse(JSON.stringify(serializeDelegationState(state))));
		assert.deepEqual(restored, state);
	}
});

test("delegation state restore fails closed on invalid payloads", () => {
	const valid = serializeDelegationState(reviewedOk(recordOk(emptyDelegationState())));
	const tampered: Array<Record<string, unknown>> = [
		{ ...valid, status: "APPROVED" },
		{ ...valid, status: "PENDING_REVIEW", currentDiffHash: undefined },
		{ ...valid, latestId: "x".repeat(65) },
		{ ...valid, latestId: " " },
		{ ...valid, blockedWriteAttempts: "3" },
		{ ...valid, blockedWriteAttempts: 1.5 },
		{ ...valid, currentDiffHash: 42 },
	];
	for (const bad of tampered) {
		assert.deepEqual(restoreDelegationState(bad), emptyDelegationState(), JSON.stringify(bad));
	}
	assert.deepEqual(restoreDelegationState(null), emptyDelegationState());
	assert.deepEqual(restoreDelegationState("state"), emptyDelegationState());
	assert.deepEqual(restoreDelegationState({}), emptyDelegationState());
	// Out-of-range counters are clamped to the bounded ceiling, never grown.
	const clamped = restoreDelegationState({ ...valid, blockedWriteAttempts: 1_000_000 });
	assert.equal(clamped.blockedWriteAttempts, MAX_BLOCKED_WRITE_ATTEMPTS);
	assert.equal(clamped.latestId, valid.latestId);
	// Overlong hashes are bounded on restore (checked on a PENDING record so
	// the hash-binding invariant does not interfere with the bounding check).
	const pendingValid = serializeDelegationState(recordOk(emptyDelegationState()));
	const longHash = restoreDelegationState({ ...pendingValid, currentDiffHash: "c".repeat(500) });
	assert.equal(longHash.currentDiffHash?.length, 128);
});

test("delegation state restore enforces the hash-binding invariants fail-closed", () => {
	// REVIEWED: reviewedDiffHash must equal currentDiffHash.
	const reviewed = serializeDelegationState(reviewedOk(recordOk(emptyDelegationState())));
	assert.deepEqual(restoreDelegationState({ ...reviewed, reviewedDiffHash: undefined }), emptyDelegationState());
	assert.deepEqual(restoreDelegationState({ ...reviewed, reviewedDiffHash: DIFF_B }), emptyDelegationState());
	assert.deepEqual(restoreDelegationState({ ...reviewed, currentDiffHash: DIFF_B }), emptyDelegationState());
	assert.deepEqual(restoreDelegationState({ ...reviewed, status: "PENDING_REVIEW" }), emptyDelegationState(), "PENDING_REVIEW must not carry a reviewedDiffHash");
	assert.deepEqual(restoreDelegationState({ ...reviewed, status: "STALE" }), emptyDelegationState(), "STALE requires reviewedDiffHash !== currentDiffHash");
	// PENDING_REVIEW: must not carry a reviewedDiffHash.
	const pending = serializeDelegationState(recordOk(emptyDelegationState()));
	assert.deepEqual(restoreDelegationState({ ...pending, reviewedDiffHash: DIFF_A }), emptyDelegationState());
	// STALE: must carry a reviewedDiffHash different from currentDiffHash.
	const stale = serializeDelegationState(observeDiffChange(reviewedOk(recordOk(emptyDelegationState())), DIFF_B, LATER));
	assert.deepEqual(restoreDelegationState({ ...stale, reviewedDiffHash: undefined }), emptyDelegationState());
	assert.deepEqual(restoreDelegationState({ ...stale, reviewedDiffHash: DIFF_B }), emptyDelegationState());
	assert.deepEqual(restoreDelegationState({ ...stale, currentDiffHash: DIFF_A }), emptyDelegationState());
	// Invariant-valid records still restore to themselves.
	assert.deepEqual(restoreDelegationState(JSON.parse(JSON.stringify(reviewed))), restoreDelegationState(reviewed));
	assert.deepEqual(restoreDelegationState(JSON.parse(JSON.stringify(pending))), restoreDelegationState(pending));
	assert.deepEqual(restoreDelegationState(JSON.parse(JSON.stringify(stale))), restoreDelegationState(stale));
});

test("delegation compact summary is bounded and informative", () => {
	assert.equal(delegationCompactSummary(emptyDelegationState()), "DELEGATION none");
	const pending = recordOk(emptyDelegationState());
	const summary = delegationCompactSummary(pending);
	assert.match(summary, /^DELEGATION dlg-1 PENDING_REVIEW diff a+$/);
	assert.ok(summary.length <= 160);
	const blocked = recordBlockedWriteAttempt(pending, NOW);
	assert.match(delegationCompactSummary(blocked), /blocked-writes 1/);
	assert.match(delegationCompactSummary(observeDiffChange(reviewedOk(pending), DIFF_B, LATER)), /STALE/);
});
