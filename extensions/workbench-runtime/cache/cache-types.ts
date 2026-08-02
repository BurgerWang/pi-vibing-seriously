/**
 * P6-A prompt-cache telemetry — shared types, schema constants and usage
 * semantics.
 *
 * Pure logic, no Pi imports. The telemetry schema is deliberately small and
 * hash-only: no system prompt text, no payload text, no message text, no
 * tool schema text, no tool input/output, no secrets, no full session ids.
 *
 * Usage semantics (verified against the installed Pi 0.83.0 source):
 *
 *   - `openai-completions` (the API kind of Pi's built-in deepseek provider):
 *     `input = max(0, prompt_tokens - cacheRead - cacheWrite)` — i.e.
 *     `usage.input` is the UN-cached (cache-miss) input, `cacheRead` is the
 *     cache-hit input. DeepSeek reports `prompt_cache_hit_tokens` /
 *     `prompt_cache_miss_tokens`; Pi maps hit → `cacheRead`, and `input` ends
 *     up as the miss portion. `cacheWrite` is 0 for DeepSeek (it does not
 *     report cache writes) — a zero `cacheWrite` is NOT an error and does NOT
 *     mean the cache was not established.
 *   - `openai-responses` / `azure-openai-responses`: `input =
 *     max(0, input_tokens - cached_tokens - cache_write_tokens)` with
 *     `cacheRead = input_tokens_details.cached_tokens`.
 *   - `anthropic-messages`: `input = input_tokens` (Anthropic reports cache
 *     reads/writes in separate fields, so `input_tokens` already excludes
 *     them), `cacheRead = cache_read_input_tokens`.
 *
 * Any other api kind keeps the normalized usage but is reported with
 * `usageSemanticStatus: "unverified"` — the workbench never guesses.
 */

import type { CacheInvalidationReason, DriftSource, InferenceConfidence } from "./invalidation-classifier.ts";

/**
 * Schema version of telemetry records and the session state entry.
 * 1.1 (P6-B): `inferredInvalidationReason` now emits UNEXPECTED_DRIFT for
 * same-mode drift (with the specific source in `driftSource`); the P6-A
 * specific reasons (SYSTEM_PROMPT_CHANGED / TOOL_SET_CHANGED /
 * TOOL_ORDER_CHANGED / TOOL_SCHEMA_CHANGED) are still recognized when
 * reading older 1.0 records.
 */
export const TELEMETRY_SCHEMA_VERSION = "1.1" as const;

/** Must stay in sync with package.json version. */
export const EXTENSION_VERSION = "0.8.0";

/** Pi usage api kinds whose normalized semantics were verified above. */
export const VERIFIED_API_KINDS: ReadonlySet<string> = new Set([
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"anthropic-messages",
]);

export type UsageSemanticStatus = "verified" | "partial" | "unverified";
/** Raw normalized usage as Pi exposes it on assistant messages. */
export interface PiUsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

/** Aggregated usage stored in telemetry records and session state. */
export interface UsageTotalsLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface UsageSemantics {
	status: UsageSemanticStatus;
	/**
	 * cacheHitRatio = cacheRead / (input + cacheRead) — only computed when the
	 * semantics are verified (input is confirmed to be the un-cached input).
	 * `null` when unverified, or when the denominator is zero.
	 */
	cacheHitRatio: number | null;
}

/**
 * Per-request telemetry record (one JSONL line).
 * Every field is a fact about usage or a hash — never message content.
 */
export interface TelemetryRecord {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
	timestamp: string;
	extensionVersion: string;
	/** SHA-256 of the session id/file, first 16 hex chars. */
	hashedSessionId: string;
	provider: string;
	model: string;
	/** Pi api kind (e.g. "openai-completions"), when model metadata provides it. */
	apiKind: string | null;
	thinkingLevel: string | null;
	workbenchMode: string;
	messageStatus: string;
	usage: UsageTotalsLike;
	usageSemanticStatus: UsageSemanticStatus;
	cacheHitRatio: number | null;
	systemPromptHash: string;
	activeToolNamesHash: string;
	activeToolOrderHash: string;
	activeToolSchemaHash: string | null;
	contextShapeHash: string | null;
	precedingEvent: string | null;
	/** Workbench inference — never DeepSeek's internal verdict. */
	inferredInvalidationReason: CacheInvalidationReason;
	inferenceConfidence: InferenceConfidence;
	/**
	 * P6-B: specific source of a same-mode UNEXPECTED_DRIFT
	 * (SYSTEM_PROMPT / TOOL_SET / TOOL_ORDER / TOOL_SCHEMA), null otherwise.
	 * Keeps the P6-A diagnostic detail under the stable headline reason.
	 */
	driftSource: DriftSource | null;
}

/**
 * Verify the semantics of a normalized Pi usage object and compute the
 * cache hit ratio. The workbench never guesses: `verified` requires the api
 * kind to be one of the kinds whose semantics were confirmed in the installed
 * Pi source AND internally consistent numbers. Anything else degrades to
 * `partial` (structure looks right, semantics unconfirmed) or `unverified`.
 */
export function verifyUsageSemantics(apiKind: string | undefined | null, usage: PiUsageLike | undefined): UsageSemantics {
	if (!usage) return { status: "unverified", cacheHitRatio: null };
	const fields = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.cost.total];
	if (fields.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0)) {
		return { status: "unverified", cacheHitRatio: null };
	}
	const sum = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (usage.totalTokens !== sum) return { status: "unverified", cacheHitRatio: null };
	if (apiKind !== undefined && apiKind !== null && VERIFIED_API_KINDS.has(apiKind)) {
		return { status: "verified", cacheHitRatio: cacheHitRatioFromTotals(usage) };
	}
	return { status: "partial", cacheHitRatio: null };
}

/** cacheHitRatio = cacheRead / (input + cacheRead); null on zero denominator. */
export function cacheHitRatioFromTotals(usage: { input: number; cacheRead: number }): number | null {
	const denominator = usage.input + usage.cacheRead;
	if (!Number.isFinite(denominator) || denominator <= 0) return null;
	return usage.cacheRead / denominator;
}

/** Empty aggregated usage. */
export function emptyUsageTotals(): UsageTotalsLike {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

/** Add one request's usage into the aggregate (never mutates inputs). */
export function addUsageTotals(target: UsageTotalsLike, usage: PiUsageLike): UsageTotalsLike {
	return {
		input: target.input + usage.input,
		output: target.output + usage.output,
		cacheRead: target.cacheRead + usage.cacheRead,
		cacheWrite: target.cacheWrite + usage.cacheWrite,
		totalTokens: target.totalTokens + usage.totalTokens,
		cost: target.cost + usage.cost.total,
	};
}
