/**
 * P6-A/P6-B cache invalidation classification.
 *
 * IMPORTANT: these are Workbench INFERENCES about why the provider's
 * prompt cache likely missed for this request — never DeepSeek's internal
 * verdict. DeepSeek does not expose cache-miss reasons; the workbench
 * triangulates from explicit Pi events (model/thinking/mode/reload/
 * compaction/session-tree navigation) and hash diffs (system prompt, tool
 * set/order/schema, payload shape). Reports always label these `inferred`.
 *
 * Expected vs unexpected (P6-B stable-prefix contract):
 *   - expected invalidation: mode switch, model switch, thinking level
 *     switch, reload, new session, compaction, session-tree navigation,
 *     history-projection epoch transition, first request, provider-side
 *     best-effort miss — normal lifecycle events that legitimately change
 *     the context prefix.
 *   - UNEXPECTED_DRIFT: the system prompt or the active tool set/order/
 *     schema changed WITHIN the same mode/model/thinking with no explicit
 *     lifecycle event — a sign the context prefix is not stable, which
 *     defeats caching. The specific source is recorded in the record's
 *     `driftSource` field (SYSTEM_PROMPT / TOOL_SET / TOOL_ORDER /
 *     TOOL_SCHEMA).
 *   - CONTEXT_PREFIX_DIVERGED: a previously observed payload prefix item was
 *     rewritten, deleted, or reordered while the system/tool fingerprints
 *     stayed identical and no explicit lifecycle event attributed it —
 *     treated as unexpected drift too. Ordinary append-only growth is healthy.
 *
 * The P6-A specific reasons (SYSTEM_PROMPT_CHANGED, TOOL_SET_CHANGED,
 * TOOL_ORDER_CHANGED, TOOL_SCHEMA_CHANGED) are kept in INVALIDATION_REASONS
 * so old telemetry records (schemaVersion 1.0) still classify correctly;
 * new records (schemaVersion 1.1) always carry UNEXPECTED_DRIFT plus the
 * `driftSource` detail.
 *
 * Pure logic, no Pi imports.
 */

export const INVALIDATION_REASONS = [
	"FIRST_OBSERVED_REQUEST",
	"NEW_SESSION",
	"MODEL_CHANGED",
	"THINKING_LEVEL_CHANGED",
	"MODE_CHANGED",
	"SYSTEM_PROMPT_CHANGED",
	"TOOL_SET_CHANGED",
	"TOOL_ORDER_CHANGED",
	"TOOL_SCHEMA_CHANGED",
	"UNEXPECTED_DRIFT",
	"PACKAGE_RELOADED",
	"COMPACTION",
	"SESSION_TREE_CHANGED",
	"HISTORY_PROJECTION_EPOCH_CHANGED",
	"CONTEXT_PREFIX_DIVERGED",
	"PROVIDER_BEST_EFFORT_MISS",
	"UNKNOWN",
] as const;

export type CacheInvalidationReason = (typeof INVALIDATION_REASONS)[number];

/** Specific source of a same-mode UNEXPECTED_DRIFT (P6-B). */
export const DRIFT_SOURCES = ["SYSTEM_PROMPT", "TOOL_SET", "TOOL_ORDER", "TOOL_SCHEMA"] as const;
export type DriftSource = (typeof DRIFT_SOURCES)[number];

export type InferenceConfidence = "high" | "medium" | "low";

/** Invalidation classes used by reports and the doctor. */
export type InvalidationClass = "expected" | "unexpected" | "unknown";

const EXPECTED_REASONS: ReadonlySet<CacheInvalidationReason> = new Set([
	"FIRST_OBSERVED_REQUEST",
	"NEW_SESSION",
	"MODEL_CHANGED",
	"THINKING_LEVEL_CHANGED",
	"MODE_CHANGED",
	"PACKAGE_RELOADED",
	"COMPACTION",
	"SESSION_TREE_CHANGED",
	"HISTORY_PROJECTION_EPOCH_CHANGED",
	"PROVIDER_BEST_EFFORT_MISS",
]);

const UNEXPECTED_REASONS: ReadonlySet<CacheInvalidationReason> = new Set([
	// P6-A specific reasons (still produced by older records).
	"SYSTEM_PROMPT_CHANGED",
	"TOOL_SET_CHANGED",
	"TOOL_ORDER_CHANGED",
	"TOOL_SCHEMA_CHANGED",
	// P6-B: the reason new records carry for same-mode drift.
	"UNEXPECTED_DRIFT",
	"CONTEXT_PREFIX_DIVERGED",
]);

export function invalidationClass(reason: CacheInvalidationReason): InvalidationClass {
	if (EXPECTED_REASONS.has(reason)) return "expected";
	if (UNEXPECTED_REASONS.has(reason)) return "unexpected";
	return "unknown";
}

export interface InvalidationInput {
	/** True when this is the first request observed in the current session. */
	isFirstRequest: boolean;
	/** True when the session started fresh (no restored state). */
	isNewSession: boolean;
	/** model_select fired with a different model since the last request. */
	modelChanged: boolean;
	/** thinking_level_select fired with a different level since the last request. */
	thinkingChanged: boolean;
	/** Workbench mode changed since the last request. */
	modeChanged: boolean;
	/** session_start reason "reload" observed since the last request. */
	packageReloaded: boolean;
	/** compaction observed since the last request. */
	compactionOccurred: boolean;
	/** Pi's post-navigation session_tree event occurred since the last request. */
	sessionTreeChanged?: boolean;
	/** An explicit history-projection epoch transition was observed. */
	historyProjectionEpochChanged?: boolean;
	systemPromptChanged: boolean;
	toolSetChanged: boolean;
	toolOrderChanged: boolean;
	toolSchemaChanged: boolean;
	/** Payload shape hash changed while system/tool hashes did not. */
	contextShapeChanged: boolean;
	/** Cache-read tokens of THIS request. */
	cacheReadTokens: number;
	/** Cache-read tokens of the PREVIOUS request. */
	previousCacheReadTokens: number;
}

export interface InvalidationVerdict {
	reason: CacheInvalidationReason;
	confidence: InferenceConfidence;
	/**
	 * P6-B: the specific source when the reason is UNEXPECTED_DRIFT
	 * (SYSTEM_PROMPT / TOOL_SET / TOOL_ORDER / TOOL_SCHEMA), else null.
	 */
	driftSource: DriftSource | null;
}

/**
 * Classify why the prompt cache was likely invalidated for this request.
 * Priority: explicit events > same-mode drift > payload-shape divergence >
 * provider-side best-effort miss. One reason wins (the strongest), so
 * reports stay stable.
 */
export function classifyInvalidation(input: InvalidationInput): InvalidationVerdict {
	// A brand-new session's first request is a NEW_SESSION (its cache is cold
	// by definition); FIRST_OBSERVED_REQUEST covers telemetry starting
	// mid-session (e.g. extension hot-load without session_start).
	if (input.isNewSession) return { reason: "NEW_SESSION", confidence: "high", driftSource: null };
	if (input.isFirstRequest) return { reason: "FIRST_OBSERVED_REQUEST", confidence: "high", driftSource: null };
	if (input.packageReloaded) return { reason: "PACKAGE_RELOADED", confidence: "high", driftSource: null };
	if (input.compactionOccurred) return { reason: "COMPACTION", confidence: "high", driftSource: null };
	if (input.sessionTreeChanged) return { reason: "SESSION_TREE_CHANGED", confidence: "high", driftSource: null };
	if (input.historyProjectionEpochChanged) return { reason: "HISTORY_PROJECTION_EPOCH_CHANGED", confidence: "high", driftSource: null };
	if (input.modelChanged) return { reason: "MODEL_CHANGED", confidence: "high", driftSource: null };
	if (input.thinkingChanged) return { reason: "THINKING_LEVEL_CHANGED", confidence: "high", driftSource: null };
	if (input.modeChanged) return { reason: "MODE_CHANGED", confidence: "high", driftSource: null };
	// P6-B: same-mode drift. The specific source is preserved in driftSource;
	// the record's headline reason is always UNEXPECTED_DRIFT so reports and
	// the doctor can count "same-mode mutations" by one stable label.
	if (input.systemPromptChanged) return { reason: "UNEXPECTED_DRIFT", confidence: "medium", driftSource: "SYSTEM_PROMPT" };
	if (input.toolSetChanged) return { reason: "UNEXPECTED_DRIFT", confidence: "medium", driftSource: "TOOL_SET" };
	if (input.toolOrderChanged) return { reason: "UNEXPECTED_DRIFT", confidence: "medium", driftSource: "TOOL_ORDER" };
	if (input.toolSchemaChanged) return { reason: "UNEXPECTED_DRIFT", confidence: "medium", driftSource: "TOOL_SCHEMA" };
	if (input.contextShapeChanged) return { reason: "CONTEXT_PREFIX_DIVERGED", confidence: "medium", driftSource: null };
	// Nothing in the workbench's own fingerprints changed, yet the provider
	// still did not bill a cache read. That is the provider's best-effort
	// cache missing (TTL expiry, eviction, provider-side prefix changes) —
	// the workbench does not control TTL and never warms the cache.
	if (input.cacheReadTokens <= 0 && input.previousCacheReadTokens > 0) {
		return { reason: "PROVIDER_BEST_EFFORT_MISS", confidence: "low", driftSource: null };
	}
	return { reason: "UNKNOWN", confidence: "low", driftSource: null };
}
