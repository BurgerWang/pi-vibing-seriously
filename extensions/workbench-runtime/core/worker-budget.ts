/**
 * Pinned DeepSeek worker context-budget policy — pure logic, no Pi imports.
 *
 * The pinned worker model (`deepseek/deepseek-v4-flash:max`) runs on a
 * 1,000,000-token context window. The workbench protects that budget with
 * two thresholds that are model-specific and completely independent of the
 * Commander/project compaction reserve:
 *
 *   - soft handoff: 800,000 tokens (80%) — the worker role sends one hidden
 *     steer asking the worker to stop new implementation and hand off;
 *   - hard stop:    900,000 tokens (90%) — the runner terminates the child
 *     and any result at/above this budget fails closed.
 *
 * Context tokens follow Pi's normalized usage semantics: a positive
 * `totalTokens` is authoritative; otherwise the sum of the non-negative
 * `input + output + cacheRead + cacheWrite` components. Malformed,
 * non-finite or negative values contribute zero — never NaN, never a crash.
 */

/** Pinned worker model context window (tokens). */
export const WORKER_MODEL_CONTEXT_TOKENS = 1_000_000;
/** 80% soft handoff threshold: one hidden steer, no failure. */
export const WORKER_SOFT_BUDGET = 800_000;
/** 90% hard stop threshold: runner terminates, invocation fails closed. */
export const WORKER_HARD_BUDGET = 900_000;
/** customType of the hidden worker soft-budget steer message. */
export const WORKER_SOFT_STEER_MESSAGE_TYPE = "workbench-worker-soft-steer";

export type WorkerBudgetBand = "ok" | "soft" | "hard";

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Pi-compatible context tokens for one message's usage object:
 * a positive `totalTokens` is authoritative; otherwise the sum of the
 * non-negative `input + output + cacheRead + cacheWrite`. Malformed usage
 * yields 0 — never NaN, never Infinity, never a throw.
 */
export function workerContextTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const u = usage as Record<string, unknown>;
	const total = u.totalTokens;
	if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
	return (
		finiteNonNegative(u.input) +
		finiteNonNegative(u.output) +
		finiteNonNegative(u.cacheRead) +
		finiteNonNegative(u.cacheWrite)
	);
}

/** tokens / 1,000,000 context window; malformed input maps to 0, never NaN. */
export function workerContextRatio(tokens: number): number {
	if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return 0;
	return tokens / WORKER_MODEL_CONTEXT_TOKENS;
}

/**
 * Budget band for a token count:
 *   "ok"   — below 800,000 (80%);
 *   "soft" — at/above 800,000 and below 900,000 (90%);
 *   "hard" — at/above 900,000.
 * Malformed input maps to "ok".
 */
export function workerBudgetBand(tokens: number): WorkerBudgetBand {
	if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return "ok";
	if (tokens >= WORKER_HARD_BUDGET) return "hard";
	if (tokens >= WORKER_SOFT_BUDGET) return "soft";
	return "ok";
}

/**
 * The one-shot hidden steer delivered to the worker at/above the soft
 * budget: stop new implementation, finish a concise handoff, list the
 * remaining work. Small, deterministic, and explicit about the thresholds.
 */
export const WORKER_SOFT_STEER_TEXT = [
	`Worker context budget soft limit reached (${WORKER_SOFT_BUDGET} / ${WORKER_MODEL_CONTEXT_TOKENS} tokens, 80%).`,
	"Stop starting new implementation work now.",
	"Finish only the change already in flight, then write a concise handoff",
	"(## Completed / ## Files Changed / ## Verification / ## Remaining Risks).",
	"List the remaining work explicitly for the Sol commander.",
].join("\n");

/**
 * Deterministic worker budget summary line — same inputs always produce the
 * same string (plain digits, no locale/formatting dependence).
 */
export function formatWorkerBudgetSummary(maxContextTokens: number, maxContextRatio: number): string {
	const tokens = Number.isFinite(maxContextTokens) && maxContextTokens >= 0 ? maxContextTokens : 0;
	const ratio = Number.isFinite(maxContextRatio) && maxContextRatio >= 0 ? maxContextRatio : workerContextRatio(tokens);
	// Floor at one decimal so a soft-band value such as 899,999 never renders
	// as the 90% hard boundary.
	const pct = (Math.floor(ratio * 1000) / 10).toFixed(1).replace(/\.0$/, "");
	return `max context ${tokens} / ${WORKER_MODEL_CONTEXT_TOKENS} (${pct}%) | soft ${WORKER_SOFT_BUDGET} | hard ${WORKER_HARD_BUDGET}`;
}
