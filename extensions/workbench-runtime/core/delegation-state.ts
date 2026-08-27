/**
 * P7 delegation lifecycle state — pure decision logic, no Pi imports.
 *
 * Tracks the acceptance lifecycle of the LATEST worker delegation.  The
 * mechanical diff service supplies scope/integrity evidence; it does not by
 * itself establish semantic code quality or Gate authority:
 *
 *   PENDING_REVIEW -> REVIEWED -> (current diff hash changes) -> STALE
 *         ^                                                         |
 *         +------------- bound semantic acceptance ----------------+
 *   REVIEWED -> PENDING_REVIEW (demoteReviewedToPending): a scope FAIL
 *   from a re-review of the SAME current diff invalidates a prior
 *   same-hash REVIEWED state fail-closed (reviewed hash cleared);
 *   PENDING_REVIEW and STALE are already blocking and are refused
 *
 *   - REVIEWED is always bound to the diff hash that was reviewed; any
 *     change of the current diff hash after a review automatically marks
 *     the delegation STALE (the reviewed diff no longer matches);
 *   - the hash-binding invariants hold for every reachable state and are
 *     enforced fail-closed on restore: REVIEWED binds
 *     reviewedDiffHash === currentDiffHash, PENDING_REVIEW never carries a
 *     reviewedDiffHash, and STALE always carries a reviewedDiffHash
 *     DIFFERENT from the current diff hash — a stale diff returning to
 *     exactly the reviewed hash re-validates the review (back to
 *     REVIEWED);
 *   - a pending or stale review blocks BOTH the next delegation and VERIFY
 *     (final gate verification) by default. A separate, narrowly-scoped
 *     successor transition may replace an exact STALE session mirror only
 *     after the caller has strictly proved that its durable v2 transaction
 *     already carries a FINAL/PASS review. VERIFY remains blocked until the
 *     successor itself is reviewed;
 *   - a bounded blocked-write-attempt counter records how many write
 *     attempts were refused while a review was outstanding;
 *   - the state serializes to a compact JSON record and restores
 *     fail-closed: unknown fields are dropped and invalid payloads restore
 *     to the empty state (no delegation).
 *
 * The empty state carries no delegation (latestId is undefined); the
 * status field is meaningful only together with a latestId. This module is
 * framework-free — Pi wiring (entries, events, VERIFY gating) happens in a
 * later slice.
 */

export type DelegationReviewStatus = "PENDING_REVIEW" | "REVIEWED" | "STALE";

export const DELEGATION_REVIEW_STATUSES: readonly DelegationReviewStatus[] = [
	"PENDING_REVIEW",
	"REVIEWED",
	"STALE",
];

/** Reserved custom-entry type for the later runtime wiring slice. */
export const DELEGATION_STATE_ENTRY_TYPE = "workbench-delegation-state";

const MAX_ID_LENGTH = 64;
const MAX_HASH_LENGTH = 128;
const MAX_UPDATED_AT_LENGTH = 32;
const MAX_SUMMARY_LENGTH = 160;

/** Ceiling for the blocked write-attempt counter (compact-safety bound). */
export const MAX_BLOCKED_WRITE_ATTEMPTS = 999;

export interface DelegationState {
	/** Id of the latest delegation; undefined means no delegation exists. */
	latestId?: string;
	/** Review status of the latest delegation (meaningful with latestId). */
	status: DelegationReviewStatus;
	/** Hash of the current (latest) worker diff. */
	currentDiffHash?: string;
	/** Hash of the diff that was reviewed; REVIEWED always binds to it. */
	reviewedDiffHash?: string;
	/** Bounded counter of write attempts refused while a review was outstanding. */
	blockedWriteAttempts: number;
	updatedAt: string;
}

/** The default state: no delegation, nothing blocked. */
export function emptyDelegationState(): DelegationState {
	return { status: "PENDING_REVIEW", blockedWriteAttempts: 0, updatedAt: "" };
}

export function hasPendingReview(state: DelegationState): boolean {
	return state.latestId !== undefined && state.status === "PENDING_REVIEW";
}

export function hasStaleReview(state: DelegationState): boolean {
	return state.latestId !== undefined && state.status === "STALE";
}

/** A pending or stale review blocks the next delegation. */
export function blocksNextDelegation(state: DelegationState): boolean {
	return state.latestId !== undefined && (state.status === "PENDING_REVIEW" || state.status === "STALE");
}

/** VERIFY (final gate verification) is blocked while a review is pending or stale. */
export function blocksVerify(state: DelegationState): boolean {
	return blocksNextDelegation(state);
}

/** Human-readable block reason for the given target, or undefined when unblocked. */
export function reviewBlockReason(state: DelegationState, target: "delegation" | "verify"): string | undefined {
	if (state.latestId === undefined || !blocksNextDelegation(state)) return undefined;
	const action = target === "delegation" ? "Starting a new worker delegation" : "VERIFY mode / final gate verification";
	return `${action} is blocked while delegation ${state.latestId} is ${state.status}; query workbench_delegation_status and follow its durable next action (review only when durable status is PENDING_REVIEW)`;
}

export interface RecordDelegationInput {
	id: string;
	diffHash: string;
	now: string;
}

export interface SemanticAcceptanceInput {
	/** Must identify the exact latest delegation shown to Sol. */
	delegationId: string;
	/** Must equal the current scope/integrity packet's bound diff hash. */
	expectedDiffHash: string;
	now: string;
}

export type DelegationTransitionResult = { ok: true; state: DelegationState } | { ok: false; error: string };

/**
 * Record a new delegation. Refused while the previous delegation is
 * PENDING_REVIEW or STALE (review first); allowed after REVIEWED. A new
 * delegation always starts PENDING_REVIEW with the new diff hash and
 * clears the previously reviewed hash.
 */
export function recordDelegation(
	state: DelegationState,
	input: RecordDelegationInput,
): DelegationTransitionResult {
	const id = input.id.trim();
	if (!id || id.length > MAX_ID_LENGTH) {
		return { ok: false, error: `delegation id must be a non-empty string of at most ${MAX_ID_LENGTH} characters` };
	}
	const diffHash = input.diffHash.trim();
	if (!diffHash || diffHash.length > MAX_HASH_LENGTH) {
		return { ok: false, error: `delegation diff hash must be a non-empty string of at most ${MAX_HASH_LENGTH} characters` };
	}
	if (blocksNextDelegation(state)) {
		return {
			ok: false,
			error: `A new delegation is blocked while delegation ${state.latestId} is ${state.status}; query workbench_delegation_status and follow its durable next action`,
		};
	}
	return {
		ok: true,
		state: {
			latestId: id,
			status: "PENDING_REVIEW",
			currentDiffHash: diffHash,
			reviewedDiffHash: undefined,
			blockedWriteAttempts: state.blockedWriteAttempts,
			updatedAt: input.now,
		},
	};
}

/**
 * Supersede one exact blocking delegation with an explicitly-bound repair.
 * The caller must first establish durable recoverability; this pure seam only
 * prevents a stale session mirror from deadlocking that approved repair.
 */
export function recordRepairDelegation(
	state: DelegationState,
	input: RecordDelegationInput,
	repairOf: string,
): DelegationTransitionResult {
	const priorId = repairOf.trim();
	if (!priorId || state.latestId !== priorId || !blocksNextDelegation(state)) {
		return { ok: false, error: "repair delegation must supersede the exact latest blocking delegation" };
	}
	const id = input.id.trim();
	if (!id || id === priorId || id.length > MAX_ID_LENGTH) {
		return { ok: false, error: `repair delegation id must be distinct and at most ${MAX_ID_LENGTH} characters` };
	}
	const diffHash = input.diffHash.trim();
	if (!diffHash || diffHash.length > MAX_HASH_LENGTH) {
		return { ok: false, error: `delegation diff hash must be a non-empty string of at most ${MAX_HASH_LENGTH} characters` };
	}
	return {
		ok: true,
		state: {
			latestId: id,
			status: "PENDING_REVIEW",
			currentDiffHash: diffHash,
			reviewedDiffHash: undefined,
			blockedWriteAttempts: state.blockedWriteAttempts,
			updatedAt: input.now,
		},
	};
}

/**
 * Project an already-authorized path-lane successor into the session mirror.
 *
 * This transition carries no admission authority itself. The caller must have
 * strictly enumerated every unresolved project blocker, obtained an ALLOW
 * decision, and revalidated that same authority under the checkout writer
 * lease immediately before PREPARED. It exists because the single-value
 * session mirror may point at a different non-overlapping blocker than the
 * exact project tip being repaired.
 */
export function recordProjectAdmittedDelegation(
	state: DelegationState,
	input: RecordDelegationInput,
): DelegationTransitionResult {
	const id = input.id.trim();
	if (!id || id.length > MAX_ID_LENGTH || id === state.latestId) {
		return { ok: false, error: `project-admitted delegation id must be distinct and at most ${MAX_ID_LENGTH} characters` };
	}
	const diffHash = input.diffHash.trim();
	if (!diffHash || diffHash.length > MAX_HASH_LENGTH) {
		return { ok: false, error: `delegation diff hash must be a non-empty string of at most ${MAX_HASH_LENGTH} characters` };
	}
	return {
		ok: true,
		state: {
			latestId: id,
			status: "PENDING_REVIEW",
			currentDiffHash: diffHash,
			reviewedDiffHash: undefined,
			blockedWriteAttempts: state.blockedWriteAttempts,
			updatedAt: input.now,
		},
	};
}

/**
 * Replace one exact STALE session mirror with a fresh successor delegation.
 *
 * This pure transition does NOT establish review authority. The caller must
 * first strictly read the prior v2 committed generation and prove that its
 * durable transaction is REVIEWED (which also proves a FINAL/PASS review
 * artifact). Keeping that proof outside this framework-free module prevents
 * a generic STALE state from becoming an authorization bypass.
 */
export function recordSuccessorAfterFinalizedReview(
	state: DelegationState,
	input: RecordDelegationInput,
	finalizedPriorId: string,
): DelegationTransitionResult {
	const priorId = finalizedPriorId.trim();
	if (!priorId || state.latestId !== priorId || state.status !== "STALE") {
		return { ok: false, error: "successor delegation must replace the exact latest STALE delegation" };
	}
	const id = input.id.trim();
	if (!id || id === priorId || id.length > MAX_ID_LENGTH) {
		return { ok: false, error: `successor delegation id must be distinct and at most ${MAX_ID_LENGTH} characters` };
	}
	const diffHash = input.diffHash.trim();
	if (!diffHash || diffHash.length > MAX_HASH_LENGTH) {
		return { ok: false, error: `delegation diff hash must be a non-empty string of at most ${MAX_HASH_LENGTH} characters` };
	}
	return {
		ok: true,
		state: {
			latestId: id,
			status: "PENDING_REVIEW",
			currentDiffHash: diffHash,
			reviewedDiffHash: undefined,
			blockedWriteAttempts: state.blockedWriteAttempts,
			updatedAt: input.now,
		},
	};
}

/**
 * Mark the current diff as reviewed. Works from PENDING_REVIEW and STALE;
 * REVIEWED is bound to the CURRENT diff hash (reviewedDiffHash is set to
 * it), so REVIEWED always means "the reviewed hash equals the current
 * hash". Re-review of an already-reviewed delegation is refused.
 */
export function markReviewed(state: DelegationState, now: string): DelegationTransitionResult {
	if (state.latestId === undefined) return { ok: false, error: "no delegation to review" };
	if (state.status !== "PENDING_REVIEW" && state.status !== "STALE") {
		return { ok: false, error: `delegation ${state.latestId} is already ${state.status}` };
	}
	if (state.currentDiffHash === undefined) {
		return { ok: false, error: "cannot review a delegation without a current diff hash" };
	}
	return {
		ok: true,
		state: { ...state, status: "REVIEWED", reviewedDiffHash: state.currentDiffHash, updatedAt: now },
	};
}

/**
 * Record an explicit Sol semantic ACCEPT for the exact current diff.
 *
 * This is deliberately only a hash-bound session transition: it grants no
 * Gate PASS and stores no model prose as evidence.  Callers must separately
 * prove that a complete scope/integrity packet existed before the ACCEPT
 * request and that the current model is the pinned Sol commander.
 */
export function markSemanticAccepted(
	state: DelegationState,
	input: SemanticAcceptanceInput,
): DelegationTransitionResult {
	const delegationId = input.delegationId.trim();
	const expectedDiffHash = input.expectedDiffHash.trim();
	if (state.latestId === undefined || delegationId !== state.latestId) {
		return { ok: false, error: "semantic ACCEPT must identify the exact latest delegation" };
	}
	if (!expectedDiffHash || expectedDiffHash !== state.currentDiffHash) {
		return { ok: false, error: "semantic ACCEPT hash does not match the current diff binding" };
	}
	return markReviewed(state, input.now);
}

/**
 * Demote a REVIEWED delegation back to PENDING_REVIEW and clear the
 * reviewed hash — the fail-closed invalidation transition for a scope
 * FAIL that re-reviews the SAME current diff (a review record can no
 * longer be trusted once the actual-diff review of that hash fails). The
 * current diff hash is kept (it is still the current diff); PENDING_REVIEW
 * and STALE are already safely blocking and are refused (unchanged);
 * without a delegation there is nothing to demote.
 */
export function demoteReviewedToPending(state: DelegationState, now: string): DelegationTransitionResult {
	if (state.latestId === undefined) return { ok: false, error: "no delegation to demote" };
	if (state.status !== "REVIEWED") {
		return {
			ok: false,
			error: `delegation ${state.latestId} is ${state.status}, not REVIEWED — only a REVIEWED state can be demoted (pending/stale stay blocking)`,
		};
	}
	return {
		ok: true,
		state: { ...state, status: "PENDING_REVIEW", reviewedDiffHash: undefined, updatedAt: now },
	};
}

/**
 * Observe a change of the current diff hash. A REVIEWED delegation becomes
 * STALE automatically (the reviewed hash no longer matches); a pending one
 * stays pending with the new hash. STALE always carries a reviewedDiffHash
 * DIFFERENT from the current hash — a stale diff returning to exactly the
 * reviewed hash re-validates the review (back to REVIEWED), while any
 * other change keeps it stale. Identical or empty hashes are no-ops, as is
 * a state without any delegation.
 */
export function observeDiffChange(state: DelegationState, newDiffHash: string, now: string): DelegationState {
	if (state.latestId === undefined) return state;
	const hash = newDiffHash.trim();
	if (!hash || hash === state.currentDiffHash) return state;
	let status: DelegationReviewStatus = state.status;
	if (status === "REVIEWED") {
		status = "STALE";
	} else if (status === "STALE" && state.reviewedDiffHash === hash) {
		// The diff returned to exactly what was reviewed: the review is valid again.
		status = "REVIEWED";
	}
	return { ...state, status, currentDiffHash: hash, updatedAt: now };
}

/** Record one refused write attempt (bounded, monotonic, survives transitions). */
export function recordBlockedWriteAttempt(state: DelegationState, now: string): DelegationState {
	return {
		...state,
		blockedWriteAttempts: Math.min(state.blockedWriteAttempts + 1, MAX_BLOCKED_WRITE_ATTEMPTS),
		updatedAt: now,
	};
}

// ---------------------------------------------------------------------------
// Serialization / restore / compact summary
// ---------------------------------------------------------------------------

export interface DelegationStateRecord {
	latestId?: string;
	status: DelegationReviewStatus;
	currentDiffHash?: string;
	reviewedDiffHash?: string;
	blockedWriteAttempts: number;
	updatedAt: string;
}
/** JSON-safe serialization. */
export function serializeDelegationState(state: DelegationState): DelegationStateRecord {
	return {
		latestId: state.latestId,
		status: state.status,
		currentDiffHash: state.currentDiffHash,
		reviewedDiffHash: state.reviewedDiffHash,
		blockedWriteAttempts: state.blockedWriteAttempts,
		updatedAt: state.updatedAt,
	};
}

/**
 * Restore a persisted state, fail-closed: unknown statuses, out-of-range
 * counters, oversized ids/hashes, a delegation without a current diff hash
 * or any violation of the hash-binding invariants restores to the empty
 * state. Field values are bounded on restore so a hostile or corrupt entry
 * can never grow the in-memory state.
 */
export function restoreDelegationState(raw: unknown): DelegationState {
	const empty = emptyDelegationState();
	if (typeof raw !== "object" || raw === null) return empty;
	const r = raw as Record<string, unknown>;
	const latestId = typeof r.latestId === "string" ? r.latestId.trim() : "";
	const status = r.status;
	if (!DELEGATION_REVIEW_STATUSES.includes(status as DelegationReviewStatus)) return empty;
	if (typeof r.blockedWriteAttempts !== "number" || !Number.isInteger(r.blockedWriteAttempts)) return empty;
	const blockedWriteAttempts = Math.min(Math.max(r.blockedWriteAttempts, 0), MAX_BLOCKED_WRITE_ATTEMPTS);
	const currentDiffHash =
		typeof r.currentDiffHash === "string" && r.currentDiffHash.trim()
			? r.currentDiffHash.trim().slice(0, MAX_HASH_LENGTH)
			: undefined;
	const reviewedDiffHash =
		typeof r.reviewedDiffHash === "string" && r.reviewedDiffHash.trim()
			? r.reviewedDiffHash.trim().slice(0, MAX_HASH_LENGTH)
			: undefined;
	const updatedAt = typeof r.updatedAt === "string" ? r.updatedAt.slice(0, MAX_UPDATED_AT_LENGTH) : "";
	if (!latestId) {
		// No delegation id: the record carries no delegation — restore the pure empty state.
		return empty;
	}
	if (latestId.length > MAX_ID_LENGTH || currentDiffHash === undefined) return empty;
	// Fail-closed hash-binding invariants: a hostile or corrupt record can
	// never produce an invalid REVIEWED / PENDING_REVIEW / STALE binding.
	if (status === "REVIEWED" && reviewedDiffHash !== currentDiffHash) return empty;
	if (status === "PENDING_REVIEW" && reviewedDiffHash !== undefined) return empty;
	if (status === "STALE" && (reviewedDiffHash === undefined || reviewedDiffHash === currentDiffHash)) return empty;
	return {
		latestId,
		status: status as DelegationReviewStatus,
		currentDiffHash,
		reviewedDiffHash,
		blockedWriteAttempts,
		updatedAt,
	};
}

/** Minimal structural shape of a Pi custom session entry (mirrors state.ts). */
export interface DelegationStateEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * Reconstruct the persisted delegation state from session entries. Only
 * entries whose payload restores to a real delegation (latestId present)
 * are adopted; later entries win. Corrupt/empty payloads are skipped — a
 * bad entry can never clear a valid delegation.
 */
export function loadDelegationStateFromEntries(entries: readonly DelegationStateEntry[]): DelegationState {
	let state = emptyDelegationState();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== DELEGATION_STATE_ENTRY_TYPE) continue;
		const restored = restoreDelegationState(entry.data);
		if (restored.latestId !== undefined) state = restored;
	}
	return state;
}

/**
 * Bounded compact-safe summary for the future compaction note: latest id,
 * review status, short diff hash and the blocked-write counter.
 */
export function delegationCompactSummary(state: DelegationState): string {
	if (state.latestId === undefined) return "DELEGATION none";
	const parts = [`DELEGATION ${state.latestId} ${state.status}`];
	if (state.currentDiffHash) parts.push(`diff ${state.currentDiffHash.slice(0, 12)}`);
	if (state.blockedWriteAttempts > 0) parts.push(`blocked-writes ${state.blockedWriteAttempts}`);
	return parts.join(" ").slice(0, MAX_SUMMARY_LENGTH);
}
