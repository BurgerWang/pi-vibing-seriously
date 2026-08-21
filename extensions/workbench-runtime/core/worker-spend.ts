/**
 * Pinned GPT-5.6 Luna xhigh cumulative delegation-spend policy — pure logic,
 * no Pi imports.
 *
 * Phases 1–2 of the approved worker token-budget repair
 * (`docs/plans/worker-token-budget-repair.md`): this module is the pure
 * policy and is **WIRED into the runtime since Phase 2** — the runner
 * accumulates the cumulative spend state after every assistant message and
 * terminates fail-closed on any hard dimension, and the worker-role
 * lifecycle sends exactly one hidden soft steer when the band first becomes
 * soft/hard (profile carried through the fixed `WORKER_SPEND_PROFILE_ENV`
 * child env contract). Public profile selection and ledger/handoff
 * persistence of the spend facts land in Phase 3 of that plan.
 *
 * It operates independently of the per-message context safety in
 * `core/worker-budget.ts` (272,000-token window, 217,600 soft handoff /
 * 244,800 hard stop): context safety bounds any single
 * message; this policy bounds cumulative spend across a delegation run —
 * turns, cumulative total tokens, and cumulative output tokens.
 *
 * The current limits are Luna-specific and expressed in 272K context-window
 * equivalents. Every profile has a substantial continuation reserve between
 * soft and hard: soft asks the worker to finish the coherent slice and hand
 * off; hard remains a true runaway ceiling. This replaces the historical
 * DeepSeek-calibrated thresholds without weakening fail-closed enforcement.
 *
 *   - Per-message total tokens reuse `workerContextTokens` from
 *     `core/worker-budget.ts`: a positive `totalTokens` is authoritative;
 *     otherwise the sum of the non-negative `input + output + cacheRead +
 *     cacheWrite`; `cacheRead` counts (cache-hit input is billed, so it is
 *     real spend); malformed/non-finite/negative values contribute zero —
 *     never NaN, never a throw.
 *   - The output dimension reads the per-message `output` component
 *     directly (non-negative finite; malformed → 0), independent of which
 *     path the per-message total took; a provider that omits `output`
 *     undercounts the dimension (accepted, documented heuristic guard).
 *   - Three fixed profiles (`low`, `standard` — the default, `extended` —
 *     explicit only), with exact soft/hard limits; "reached" means at or
 *     above (`>=`), mirroring the `workerBudgetBand` convention.
 *   - Band evaluation on every processed message: any hard dimension →
 *     `hard` (hard wins over soft, always); else any soft dimension →
 *     `soft`; else `ok`. The triggered-reasons list is the subset of
 *     dimensions at/above the current band's threshold, in the fixed order
 *     `turns`, `total_tokens`, `output_tokens`.
 *   - At most one hidden cumulative soft steer per delegation (delivered
 *     exactly like the existing context steer, `display: false`,
 *     `deliverAs: "steer"`); the steer is a request, not enforcement. Any
 *     hard dimension → runner terminates and the invocation fails closed.
 *
 * Malformed counters, malformed usage, and unrecognized profile values
 * never throw and never produce NaN: counters normalize to zero, and limit
 * lookups fall back to the `standard` profile (defensive mirror of
 * `resolveWorkerSpendProfile`).
 */

import { workerContextTokens } from "./worker-budget.ts";

/** Closed set of delegation spend profiles; `standard` is the default. */
export type WorkerSpendProfile = "low" | "standard" | "extended";
/** Cumulative spend band for one delegation run. */
export type WorkerSpendBand = "ok" | "soft" | "hard";
/**
 * Spend dimension identifiers in the fixed reason order — never
 * alphabetical, never insertion order, never provider order.
 */
export type WorkerSpendReason = "turns" | "total_tokens" | "output_tokens";

/** Per-dimension numeric limits of one band of one profile. */
export interface WorkerSpendDimensionLimits {
	readonly turns: number;
	readonly totalTokens: number;
	readonly outputTokens: number;
}

/** Soft (one hidden steer) and hard (fail-closed stop) limits of a profile. */
export interface WorkerSpendLimits {
	readonly soft: WorkerSpendDimensionLimits;
	readonly hard: WorkerSpendDimensionLimits;
}

/** Cumulative spend state of one delegation run (one entry per message). */
export interface WorkerSpendState {
	turns: number;
	totalTokens: number;
	outputTokens: number;
}

/** Per-dimension soft/hard trigger flags for a state against a profile. */
export interface WorkerSpendDimensionFlags {
	readonly soft: Readonly<Record<SpendDimensionKey, boolean>>;
	readonly hard: Readonly<Record<SpendDimensionKey, boolean>>;
}

type SpendDimensionKey = "turns" | "totalTokens" | "outputTokens";

/** Default profile for every delegation that does not explicitly request another. */
export const WORKER_SPEND_DEFAULT_PROFILE = "standard" as const;

/** Current model-specific spend policy; persisted for diagnostics/tests. */
export const WORKER_SPEND_POLICY_ID = "gpt-5.6-luna-xhigh-continuation-v1" as const;

/**
 * Fixed child env contract (Phase 2 wiring): the runner passes the resolved
 * spend profile to the worker child through this env var, so the worker-role
 * lifecycle enforces the SAME profile the runner accumulates against. The
 * runner always writes a valid `low` | `standard` | `extended` value;
 * worker-role readers strictly validate it and fall back to `standard` on
 * malformed/missing values (defensive mirror of `resolveWorkerSpendProfile`).
 */
export const WORKER_SPEND_PROFILE_ENV = "WORKBENCH_WORKER_SPEND_PROFILE";

/** customType of the one-shot hidden cumulative soft-budget steer message. */
export const WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE = "workbench-worker-spend-soft-steer";

/**
 * Exact immutable profile limits (plan §4.3). Every object is frozen at
 * runtime; all six numbers per profile are fixed constants and "reached"
 * means at or above the limit (`>=`).
 */
export const WORKER_SPEND_LIMITS: Readonly<Record<WorkerSpendProfile, WorkerSpendLimits>> = Object.freeze({
	low: Object.freeze({
		soft: Object.freeze({ turns: 8, totalTokens: 816_000, outputTokens: 50_000 }),
		hard: Object.freeze({ turns: 16, totalTokens: 1_632_000, outputTokens: 100_000 }),
	}),
	standard: Object.freeze({
		soft: Object.freeze({ turns: 32, totalTokens: 5_440_000, outputTokens: 160_000 }),
		hard: Object.freeze({ turns: 64, totalTokens: 10_880_000, outputTokens: 320_000 }),
	}),
	extended: Object.freeze({
		soft: Object.freeze({ turns: 64, totalTokens: 10_880_000, outputTokens: 320_000 }),
		hard: Object.freeze({ turns: 96, totalTokens: 17_408_000, outputTokens: 512_000 }),
	}),
});

/** Frozen zero state: no messages processed yet. */
export const EMPTY_WORKER_SPEND_STATE: Readonly<WorkerSpendState> = Object.freeze({
	turns: 0,
	totalTokens: 0,
	outputTokens: 0,
});

/** The fixed reason order shared by every reasons/flags/formatter path. */
const WORKER_SPEND_REASON_ORDER: readonly WorkerSpendReason[] = ["turns", "total_tokens", "output_tokens"];

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function dimensionKey(reason: WorkerSpendReason): SpendDimensionKey {
	switch (reason) {
		case "turns":
			return "turns";
		case "total_tokens":
			return "totalTokens";
		case "output_tokens":
			return "outputTokens";
	}
}

function currentValue(state: WorkerSpendState, reason: WorkerSpendReason): number {
	switch (reason) {
		case "turns":
			return state.turns;
		case "total_tokens":
			return state.totalTokens;
		case "output_tokens":
			return state.outputTokens;
	}
}

function limitValue(limits: WorkerSpendDimensionLimits, reason: WorkerSpendReason): number {
	switch (reason) {
		case "turns":
			return limits.turns;
		case "total_tokens":
			return limits.totalTokens;
		case "output_tokens":
			return limits.outputTokens;
	}
}

/** Defensive limit lookup: an unrecognized profile value resolves to `standard`. */
function limitsFor(profile: WorkerSpendProfile): WorkerSpendLimits {
	return WORKER_SPEND_LIMITS[profile] ?? WORKER_SPEND_LIMITS[WORKER_SPEND_DEFAULT_PROFILE];
}

/**
 * Strict profile validation: accepts exactly `low` | `standard` |
 * `extended`; rejects everything else (unknown, empty, wrong type,
 * case variants). Callers that must fail closed use this check; callers
 * that explicitly request a default use `resolveWorkerSpendProfile`.
 */
export function isWorkerSpendProfile(value: unknown): value is WorkerSpendProfile {
	return value === "low" || value === "standard" || value === "extended";
}

/**
 * Profile normalization with an explicit default: any unrecognized value
 * resolves to `WORKER_SPEND_DEFAULT_PROFILE` (`standard`). This fallback
 * exists only here, where a default is explicitly requested; strict
 * validation (`isWorkerSpendProfile`) still rejects unknown values.
 */
export function resolveWorkerSpendProfile(value: unknown): WorkerSpendProfile {
	return isWorkerSpendProfile(value) ? value : WORKER_SPEND_DEFAULT_PROFILE;
}

/**
 * Normalize an arbitrary state value into a valid `WorkerSpendState`:
 * malformed, non-finite or negative counters become zero — never NaN,
 * never a throw. Fractional finite non-negative values are accepted as-is.
 */
export function normalizeWorkerSpendState(state: unknown): WorkerSpendState {
	if (!state || typeof state !== "object") return { turns: 0, totalTokens: 0, outputTokens: 0 };
	const s = state as Record<string, unknown>;
	return {
		turns: finiteNonNegative(s.turns),
		totalTokens: finiteNonNegative(s.totalTokens),
		outputTokens: finiteNonNegative(s.outputTokens),
	};
}

/**
 * Per-message output component (tokens): non-negative finite `output`,
 * else 0. Independent of which path the per-message total took — this is
 * the `output_tokens` dimension's input.
 */
export function workerSpendOutputTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	return finiteNonNegative((usage as Record<string, unknown>).output);
}

/**
 * Immutable cumulative state update for one processed assistant message:
 * returns a NEW state (never mutates the input) with turns + 1 and the
 * per-message normalized total/output tokens added. The per-message total
 * reuses `workerContextTokens` from `core/worker-budget.ts` (positive
 * `totalTokens` authoritative, else the non-negative
 * `input + output + cacheRead + cacheWrite` sum; `cacheRead` counts).
 * Malformed state or usage contributes zero — never NaN, never a throw.
 */
export function addWorkerSpendUsage(state: unknown, usage: unknown): WorkerSpendState {
	const current = normalizeWorkerSpendState(state);
	return {
		turns: current.turns + 1,
		totalTokens: current.totalTokens + workerContextTokens(usage),
		outputTokens: current.outputTokens + workerSpendOutputTokens(usage),
	};
}

/**
 * Per-dimension soft/hard trigger flags for a state against a profile.
 * Every dimension is evaluated with `>=` semantics ("reached" means at or
 * above the limit). Malformed state normalizes to zero; an unrecognized
 * profile value resolves to the `standard` limits.
 */
export function workerSpendDimensionFlags(state: unknown, profile: WorkerSpendProfile): WorkerSpendDimensionFlags {
	const s = normalizeWorkerSpendState(state);
	const limits = limitsFor(profile);
	return {
		soft: {
			turns: s.turns >= limits.soft.turns,
			totalTokens: s.totalTokens >= limits.soft.totalTokens,
			outputTokens: s.outputTokens >= limits.soft.outputTokens,
		},
		hard: {
			turns: s.turns >= limits.hard.turns,
			totalTokens: s.totalTokens >= limits.hard.totalTokens,
			outputTokens: s.outputTokens >= limits.hard.outputTokens,
		},
	};
}

/**
 * Cumulative spend band: any hard dimension reached → `hard` (hard wins
 * over soft, always); else any soft dimension reached → `soft`; else `ok`.
 * Malformed state → `ok`.
 */
export function workerSpendBand(state: unknown, profile: WorkerSpendProfile): WorkerSpendBand {
	const flags = workerSpendDimensionFlags(state, profile);
	if (flags.hard.turns || flags.hard.totalTokens || flags.hard.outputTokens) return "hard";
	if (flags.soft.turns || flags.soft.totalTokens || flags.soft.outputTokens) return "soft";
	return "ok";
}

/**
 * Triggered reasons for the CURRENT band: the dimensions at/above the
 * band's threshold (hard dimensions when the band is `hard`, soft
 * dimensions when `soft`, none when `ok`), always in the fixed order
 * `turns`, `total_tokens`, `output_tokens`.
 */
export function workerSpendReasons(state: unknown, profile: WorkerSpendProfile): WorkerSpendReason[] {
	const flags = workerSpendDimensionFlags(state, profile);
	const hard = WORKER_SPEND_REASON_ORDER.filter((reason) => flags.hard[dimensionKey(reason)]);
	if (hard.length > 0) return hard;
	return WORKER_SPEND_REASON_ORDER.filter((reason) => flags.soft[dimensionKey(reason)]);
}

/**
 * Deterministic one-shot hidden cumulative soft-steer text: names the
 * profile, the soft-triggered dimension(s) in the fixed reason order with
 * current vs. soft-limit values, and instructs the worker to stop new
 * implementation, finish the change in flight, write the concise handoff,
 * and list the remaining work. Same inputs always produce the same string
 * (plain digits, no locale/formatting dependence). The steer is a request,
 * not an enforcement. A state below every soft limit renders the
 * deterministic degenerate form "no dimension at its soft limit".
 */
export function formatWorkerSpendSteerText(state: unknown, profile: WorkerSpendProfile): string {
	const s = normalizeWorkerSpendState(state);
	const profileName = resolveWorkerSpendProfile(profile);
	const limits = limitsFor(profile);
	const softReasons = WORKER_SPEND_REASON_ORDER.filter(
		(reason) => workerSpendDimensionFlags(s, profile).soft[dimensionKey(reason)],
	);
	const facts =
		softReasons.length > 0
			? softReasons.map((reason) => `${reason} ${currentValue(s, reason)}/${limitValue(limits.soft, reason)}`).join(", ")
			: "no dimension at its soft limit";
	return [
		`Worker cumulative spend soft budget reached (profile ${profileName}): ${facts}.`,
		"The Luna continuation reserve is active; do not stop solely because the soft threshold was reached.",
		"Stop starting unrelated work and finish the coherent change already in flight, then write a concise handoff",
		"(## Completed / ## Files Changed / ## Verification / ## Remaining Risks).",
		"List any remaining work for a bounded follow-up delegation in the current Sol session; never ask the user to open a new Sol session.",
	].join("\n");
}

/**
 * Deterministic hard-stop reason text: names the profile and the
 * hard-triggered dimension(s) in the fixed reason order with current vs.
 * hard-limit values. Reasons derive strictly from the hard trigger flags
 * — a soft-only state (at/above soft, below every hard limit) never
 * reuses soft-band reasons with hard denominators and renders the
 * deterministic degenerate form "no dimension at its hard limit". Used
 * by the runner (Phase 2) to terminate the child fail-closed when any
 * hard dimension is reached.
 */
export function formatWorkerSpendHardStop(state: unknown, profile: WorkerSpendProfile): string {
	const s = normalizeWorkerSpendState(state);
	const profileName = resolveWorkerSpendProfile(profile);
	const limits = limitsFor(profile);
	const flags = workerSpendDimensionFlags(s, profile);
	const reasons = WORKER_SPEND_REASON_ORDER.filter((reason) => flags.hard[dimensionKey(reason)]);
	const facts =
		reasons.length > 0
			? reasons.map((reason) => `${reason} ${currentValue(s, reason)}/${limitValue(limits.hard, reason)}`).join(", ")
			: "no dimension at its hard limit";
	return `Worker cumulative spend hard budget reached (profile ${profileName}): ${facts}. Continue with a bounded follow-up delegation in the current Sol session after reviewing any partial delta; do not request a new Sol session.`;
}

/**
 * Deterministic spend summary line for the parent handoff / worker report
 * (plan §12): `spend budget : turns N/M | total X/Y | output A/B | profile
 * P`. The denominators are the profile's HARD limits (the enforcement
 * ceiling), mirroring the context summary's window-denominator convention;
 * plain digits, no locale/formatting dependence. Malformed state renders
 * zeros.
 */
export function formatWorkerSpendSummary(state: unknown, profile: WorkerSpendProfile): string {
	const s = normalizeWorkerSpendState(state);
	const limits = limitsFor(profile);
	return `spend budget : turns ${s.turns}/${limits.hard.turns} | total ${s.totalTokens}/${limits.hard.totalTokens} | output ${s.outputTokens}/${limits.hard.outputTokens} | profile ${resolveWorkerSpendProfile(profile)}`;
}
