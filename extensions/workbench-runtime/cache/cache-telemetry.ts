/**
 * P6-A cache telemetry — session-scoped observer that turns Pi events into
 * hash-only telemetry records.
 *
 * Wired to Pi events by the extension (index.ts):
 *   - session_start        -> restoreFromEntries (cache summary recovery)
 *   - model_select         -> observeModelChange
 *   - thinking_level_select-> observeThinkingChange
 *   - before_provider_request -> observePayload (READ-ONLY structural peek)
 *   - message_end          -> observeMessageEnd (assistant messages only)
 *   - session_before_compact -> observeCompaction
 *   - session_shutdown     -> flush (safe state entry write)
 *
 * Failure discipline: every public method catches its own errors and returns
 * gracefully — telemetry must never block, crash, or modify a model request.
 *
 * Session state is persisted as a Pi custom entry (customType
 * "workbench-cache-state") holding only: schemaVersion, requestCount,
 * aggregate usage, last hashes, last invalidation reason and the telemetry
 * file reference. No message bodies, no large arrays.
 */

import {
	addUsageTotals,
	emptyUsageTotals,
	EXTENSION_VERSION,
	TELEMETRY_SCHEMA_VERSION,
	verifyUsageSemantics,
	type PiUsageLike,
	type TelemetryRecord,
	type UsageSemanticStatus,
	type UsageTotalsLike,
} from "./cache-types.ts";
import { hashSessionId } from "./canonical-hash.ts";
import {
	fingerprintTools,
	payloadShapeHash,
	summarizePayload,
	systemPromptHash,
	type PayloadSummary,
	type ToolFingerprint,
	type ToolInfoLike,
} from "./prompt-fingerprint.ts";
import {
	classifyInvalidation,
	type CacheInvalidationReason,
	type InferenceConfidence,
} from "./invalidation-classifier.ts";
import { CacheStore } from "./cache-store.ts";

export const CACHE_STATE_ENTRY_TYPE = "workbench-cache-state";

/** Structural shape of the Pi custom entry (mirrors CustomEntry). */
export interface CacheStateEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Lightweight per-session state persisted as a custom entry. */
export interface CacheStateEntryData {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
	hashedSessionId: string;
	requestCount: number;
	usage: UsageTotalsLike;
	lastHashes: {
		systemPromptHash?: string;
		toolNamesHash?: string;
		toolOrderHash?: string;
		toolSchemaHash?: string | null;
		contextShapeHash?: string | null;
	};
	lastInvalidationReason?: CacheInvalidationReason;
	telemetryFile?: string;
	updatedAt: string;
}

export interface CacheTelemetryDeps {
	extensionVersion?: string;
	/** Timestamp source (injectable for tests). */
	now?: () => number;
	/** Persist the session state entry (pi.appendEntry). */
	appendEntry: (customType: string, data: unknown) => void;
}

/** Facts assembled by the extension at message_end. */
export interface MessageEndFacts {
	provider: string;
	model: string;
	/** Pi api kind from the assistant message metadata. */
	apiKind: string | null;
	usage: PiUsageLike | undefined;
	stopReason?: string;
	errorMessage?: string;
	thinkingLevel: string | null;
	systemPrompt: string;
	activeToolNames: readonly string[];
	tools: readonly ToolInfoLike[];
}

export interface CacheSnapshot {
	enabled: boolean;
	hashedSessionId: string;
	provider: string | null;
	model: string | null;
	apiKind: string | null;
	mode: string | null;
	thinkingLevel: string | null;
	requestCount: number;
	usage: UsageTotalsLike;
	hitRatio: number | null;
	semanticStatus: UsageSemanticStatus | null;
	lastInvalidationReason: CacheInvalidationReason | null;
	lastInvalidationConfidence: InferenceConfidence | null;
	telemetryFile: string | null;
}

export interface CacheTelemetry {
	setEnabled(enabled: boolean): void;
	isEnabled(): boolean;
	setProjectRoot(projectRoot: string): void;
	setSessionId(sessionId: string): void;
	setMode(mode: string): void;
	setThinkingLevel(level: string): void;
	observeModelChange(model: { provider: string; id: string; api?: string }): void;
	observeThinkingChange(level: string): void;
	observeModeChange(mode: string): void;
	observeReload(): void;
	observeCompaction(): void;
	observeNewSession(): void;
	/** READ-ONLY structural peek at the provider payload. Never mutates. */
	observePayload(payload: unknown): void;
	restoreFromEntries(entries: readonly CacheStateEntryLike[]): void;
	observeMessageEnd(facts: MessageEndFacts): Promise<TelemetryRecord | null>;
	flush(): void;
	/** Compact TUI contribution: "CACHE 72% | read 184k | miss 71k". */
	statusSegment(): string | undefined;
	snapshot(): CacheSnapshot;
}

export function createCacheTelemetry(deps: CacheTelemetryDeps): CacheTelemetry {
	const version = deps.extensionVersion ?? EXTENSION_VERSION;
	const now = deps.now ?? (() => Date.now());

	let enabled = true;
	let store: CacheStore | undefined;
	let hashedSessionId = "unknown";
	let mode: string | undefined;
	let thinkingLevel: string | null = null;
	let lastProvider: string | null = null;
	let lastModel: string | null = null;
	let lastApiKind: string | null = null;
	let lastEvent: string | null = null;

	// One-shot event flags consumed by the next message_end.
	let pendingReload = false;
	let pendingCompaction = false;
	let pendingNewSession = false;
	let pendingModelChange = false;
	let pendingThinkingChange = false;
	let pendingModeChange = false;

	let state: CacheStateEntryData = freshState();
	let lastPayloadSummary: PayloadSummary | undefined;
	let lastCacheRead = 0;
	let lastSemanticStatus: UsageSemanticStatus | null = null;
	let lastHitRatio: number | null = null;
	let lastReason: CacheInvalidationReason | null = null;
	let lastConfidence: InferenceConfidence | null = null;

	function freshState(): CacheStateEntryData {
		return {
			schemaVersion: TELEMETRY_SCHEMA_VERSION,
			hashedSessionId,
			requestCount: 0,
			usage: emptyUsageTotals(),
			lastHashes: {},
			telemetryFile: undefined,
			updatedAt: new Date(now()).toISOString(),
		};
	}

	function persistState(): void {
		state.updatedAt = new Date(now()).toISOString();
		try {
			deps.appendEntry(CACHE_STATE_ENTRY_TYPE, state);
		} catch {
			// In-memory state remains valid; persistence is best-effort.
		}
	}

	const telemetry: CacheTelemetry = {
		setEnabled(value: boolean): void {
			enabled = value;
		},

		isEnabled(): boolean {
			return enabled;
		},

		setProjectRoot(projectRoot: string): void {
			store = new CacheStore(projectRoot);
		},

		setSessionId(sessionId: string): void {
			const next = hashSessionId(sessionId);
			if (next !== hashedSessionId) {
				hashedSessionId = next;
				state.hashedSessionId = next;
			}
		},

		setMode(value: string): void {
			mode = value;
		},

		setThinkingLevel(level: string): void {
			thinkingLevel = level;
		},

		observeModelChange(model: { provider: string; id: string; api?: string }): void {
			const key = `${model.provider}/${model.id}`;
			const previous = lastModel !== null ? `${lastProvider}/${lastModel}` : undefined;
			if (previous !== undefined && previous !== key) pendingModelChange = true;
			lastProvider = model.provider;
			lastModel = model.id;
			if (model.api !== undefined) lastApiKind = model.api;
			lastEvent = "model_select";
		},

		observeThinkingChange(level: string): void {
			if (thinkingLevel !== null && thinkingLevel !== level) pendingThinkingChange = true;
			thinkingLevel = level;
			lastEvent = "thinking_level_select";
		},

		observeModeChange(value: string): void {
			if (mode !== undefined && mode !== value) pendingModeChange = true;
			mode = value;
			lastEvent = "mode_change";
		},

		observeReload(): void {
			pendingReload = true;
			lastEvent = "session_reload";
		},

		observeCompaction(): void {
			pendingCompaction = true;
			lastEvent = "session_before_compact";
		},

		observeNewSession(): void {
			pendingNewSession = true;
			lastEvent = "session_start:new";
		},

		observePayload(payload: unknown): void {
			// Structural digest only — no text survives, payload untouched.
			try {
				lastPayloadSummary = summarizePayload(payload);
			} catch {
				lastPayloadSummary = undefined;
			}
			lastEvent = "before_provider_request";
		},

		restoreFromEntries(entries: readonly CacheStateEntryLike[]): void {
			let restored: CacheStateEntryData | undefined;
			for (const entry of entries) {
				if (entry.type !== "custom" || entry.customType !== CACHE_STATE_ENTRY_TYPE) continue;
				restored = entry.data as CacheStateEntryData | undefined;
			}
			if (restored && typeof restored === "object" && restored.hashedSessionId === hashedSessionId) {
				state = {
					...freshState(),
					requestCount: Number.isFinite(restored.requestCount) ? restored.requestCount : 0,
					usage: restored.usage ?? emptyUsageTotals(),
					lastHashes: restored.lastHashes ?? {},
					lastInvalidationReason: restored.lastInvalidationReason,
					telemetryFile: restored.telemetryFile,
				};
				lastReason = restored.lastInvalidationReason ?? null;
			} else {
				state = freshState();
				pendingNewSession = true;
			}
			lastEvent = "session_start";
		},

		async observeMessageEnd(facts: MessageEndFacts): Promise<TelemetryRecord | null> {
			try {
				if (!enabled || store === undefined || facts.usage === undefined) return null;

				const semantics = verifyUsageSemantics(facts.apiKind ?? lastApiKind, facts.usage);
				const fingerprint = fingerprintTools(facts.activeToolNames, facts.tools);
				const sysHash = systemPromptHash(facts.systemPrompt);
				const ctxShapeHash = lastPayloadSummary ? payloadShapeHash(lastPayloadSummary) : null;

				const previous = state.lastHashes;
				const systemPromptChanged = previous.systemPromptHash !== undefined && previous.systemPromptHash !== sysHash;
				const toolSetChanged = previous.toolNamesHash !== undefined && previous.toolNamesHash !== fingerprint.namesHash;
				const toolOrderChanged =
					!toolSetChanged && previous.toolOrderHash !== undefined && previous.toolOrderHash !== fingerprint.orderHash;
				const toolSchemaChanged =
					!toolSetChanged &&
					!toolOrderChanged &&
					previous.toolSchemaHash !== undefined &&
					fingerprint.schemaHash !== null &&
					previous.toolSchemaHash !== fingerprint.schemaHash;
				const contextShapeChanged =
					previous.contextShapeHash !== undefined && ctxShapeHash !== null && previous.contextShapeHash !== ctxShapeHash;

				const verdict = classifyInvalidation({
					isFirstRequest: state.requestCount === 0,
					isNewSession: pendingNewSession,
					modelChanged: pendingModelChange,
					thinkingChanged: pendingThinkingChange,
					modeChanged: pendingModeChange,
					packageReloaded: pendingReload,
					compactionOccurred: pendingCompaction,
					systemPromptChanged,
					toolSetChanged,
					toolOrderChanged,
					toolSchemaChanged,
					contextShapeChanged,
					cacheReadTokens: facts.usage.cacheRead,
					previousCacheReadTokens: lastCacheRead,
				});

				const messageStatus = facts.stopReason === "error" || facts.stopReason === "aborted" || facts.errorMessage !== undefined ? "error" : "ok";
				const totalTokens = Number.isFinite(facts.usage.totalTokens)
					? facts.usage.totalTokens
					: facts.usage.input + facts.usage.output + facts.usage.cacheRead + facts.usage.cacheWrite;

				const record: TelemetryRecord = {
					schemaVersion: TELEMETRY_SCHEMA_VERSION,
					timestamp: new Date(now()).toISOString(),
					extensionVersion: version,
					hashedSessionId,
					provider: facts.provider,
					model: facts.model,
					apiKind: facts.apiKind ?? lastApiKind,
					thinkingLevel: facts.thinkingLevel ?? thinkingLevel ?? null,
					workbenchMode: mode ?? "unknown",
					messageStatus,
					usage: {
						input: facts.usage.input,
						output: facts.usage.output,
						cacheRead: facts.usage.cacheRead,
						cacheWrite: facts.usage.cacheWrite,
						totalTokens,
						cost: facts.usage.cost.total,
					},
					usageSemanticStatus: semantics.status,
					cacheHitRatio: semantics.cacheHitRatio,
					systemPromptHash: sysHash,
					activeToolNamesHash: fingerprint.namesHash,
					activeToolOrderHash: fingerprint.orderHash,
					activeToolSchemaHash: fingerprint.schemaHash,
					contextShapeHash: ctxShapeHash,
					precedingEvent: lastEvent,
					inferredInvalidationReason: verdict.reason,
					inferenceConfidence: verdict.confidence,
					driftSource: verdict.driftSource,
				};

				// Persist (best-effort, append-only). Failures never throw.
				await store.appendRecord(record);

				// Advance the session state.
				state.requestCount += 1;
				state.usage = addUsageTotals(state.usage, facts.usage);
				state.lastHashes = {
					systemPromptHash: sysHash,
					toolNamesHash: fingerprint.namesHash,
					toolOrderHash: fingerprint.orderHash,
					toolSchemaHash: fingerprint.schemaHash,
					contextShapeHash: ctxShapeHash,
				};
				state.lastInvalidationReason = verdict.reason;
				state.telemetryFile = store.telemetryRef();

				lastProvider = facts.provider;
				lastModel = facts.model;
				if (facts.apiKind !== null) lastApiKind = facts.apiKind;
				lastCacheRead = facts.usage.cacheRead;
				lastSemanticStatus = semantics.status;
				lastHitRatio = semantics.cacheHitRatio;
				lastReason = verdict.reason;
				lastConfidence = verdict.confidence;
				lastEvent = "message_end";

				// One-shot flags are consumed.
				pendingReload = false;
				pendingCompaction = false;
				pendingNewSession = false;
				pendingModelChange = false;
				pendingThinkingChange = false;
				pendingModeChange = false;

				persistState();
				return record;
			} catch {
				return null;
			}
		},

		flush(): void {
			try {
				persistState();
			} catch {
				// nothing else to do — flush is best-effort
			}
		},

		statusSegment(): string | undefined {
			if (!enabled || state.requestCount === 0) return undefined;
			if (lastSemanticStatus !== "verified") return "CACHE N/A";
			const ratio = state.usage.cacheRead / (state.usage.input + state.usage.cacheRead);
			if (!Number.isFinite(ratio) || state.usage.input + state.usage.cacheRead <= 0) return "CACHE N/A";
			return `CACHE ${Math.round(ratio * 100)}% | read ${formatTokens(state.usage.cacheRead)} | miss ${formatTokens(state.usage.input)}`;
		},

		snapshot(): CacheSnapshot {
			return {
				enabled,
				hashedSessionId,
				provider: lastProvider,
				model: lastModel,
				apiKind: lastApiKind,
				mode: mode ?? null,
				thinkingLevel,
				requestCount: state.requestCount,
				usage: state.usage,
				hitRatio: lastHitRatio,
				semanticStatus: lastSemanticStatus,
				lastInvalidationReason: lastReason,
				lastInvalidationConfidence: lastConfidence,
				telemetryFile: state.telemetryFile ?? null,
			};
		},
	};

	return telemetry;
}

/** Compact token counts: 71_234 -> "71k", 1_845_000 -> "1.8M". */
export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0";
	if (n >= 1_000_000) {
		const value = n / 1_000_000;
		return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(Math.round(n));
}
