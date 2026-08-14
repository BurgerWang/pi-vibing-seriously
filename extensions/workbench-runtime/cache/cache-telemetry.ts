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
 *   - session_tree         -> observeSessionTreeChange (completed navigation)
 *   - session_shutdown     -> flush (safe state entry write)
 *
 * Failure discipline: every public method catches its own errors and returns
 * gracefully — telemetry must never block, crash, or modify a model request.
 *
 * Session state is persisted as a Pi custom entry (customType
 * "workbench-cache-state") holding only: schemaVersion, requestCount,
 * aggregate usage, a bounded pending-write-gap bit, last payload/tool hashes,
 * last invalidation reason and the telemetry file reference. Projection
 * marker text and epoch/segment hashes are in-memory only. No message bodies,
 * no large arrays.
 */

import { types as nodeTypes } from "node:util";

import {
	addUsageTotals,
	cacheUsageMetrics,
	cacheHitRatioFromTotals,
	combineUsageSemanticStatus,
	emptyUsageTotals,
	EXTENSION_VERSION,
	isHistoryProjectionFacts,
	TELEMETRY_SCHEMA_VERSION,
	verifyUsageSemantics,
	type PiUsageLike,
	type ActorRoleCode,
	type HistoryProjectionFacts,
	type RequestCorrelationCode,
	type TelemetryRecord,
	type UsageSemanticStatus,
	type UsageTotalsLike,
	type WireObservationFacts,
} from "./cache-types.ts";
import { hashSessionId, sha256Hex } from "./canonical-hash.ts";
import {
	classifyPayloadRelationship,
	fingerprintTools,
	payloadShapeHash,
	summarizePayload,
	systemPromptHash,
	wholeItemLcpFacts,
	type PayloadSummary,
	type ToolFingerprint,
	type ToolInfoLike,
} from "./prompt-fingerprint.ts";
import {
	classifyInvalidation,
	INVALIDATION_REASONS,
	type CacheInvalidationReason,
	type InferenceConfidence,
} from "./invalidation-classifier.ts";
import { CacheStore } from "./cache-store.ts";

export const CACHE_STATE_ENTRY_TYPE = "workbench-cache-state";

const CACHE_STATE_KEYS = [
	"schemaVersion",
	"hashedSessionId",
	"requestCount",
	"usage",
	"usageSemanticStatus",
	"telemetryWriteGapPending",
	"lastHashes",
	"lastInvalidationReason",
	"telemetryFile",
	"updatedAt",
] as const;
const CACHE_STATE_REQUIRED_KEYS = [
	"schemaVersion",
	"hashedSessionId",
	"requestCount",
	"usage",
	"lastHashes",
	"updatedAt",
] as const;
const CACHE_STATE_USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const;
const CACHE_STATE_HASH_KEYS = [
	"systemPromptHash",
	"toolNamesHash",
	"toolOrderHash",
	"toolSchemaHash",
	"contextShapeHash",
] as const;
const CACHE_STATE_SESSION_HASH = /^[0-9a-f]{16}$/;
const CACHE_STATE_SHA256 = /^[0-9a-f]{64}$/;
const CACHE_STATE_INVALIDATION_REASONS: ReadonlySet<string> = new Set(INVALIDATION_REASONS);
const CACHE_STATE_SEMANTIC_STATUSES: ReadonlySet<UsageSemanticStatus> = new Set([
	"verified",
	"partial",
	"unverified",
]);
const CACHE_STATE_TELEMETRY_FILE = ".pi/workbench/cache/telemetry.jsonl";
const TELEMETRY_WRITE_GAP_EVENT = "telemetry_write_gap";
const EXPLICIT_PROMPT_CACHE_BREAKPOINTS_APPLIED_EVENT = "explicit_prompt_cache_breakpoints_applied";
const MAX_CACHE_STATE_ENTRIES = 100_000;
const MAX_CACHE_STATE_REQUESTS = 1_000_000_000;
const MAX_CACHE_STATE_NUMERIC_VALUE = 1_000_000_000_000_000;
const PROJECTION_INPUT_KEYS = [
	"eventCode", "causeCode", "epoch", "epochTransitioned", "segmentSealed", "byteOverflow", "bundleOverflow",
	"segmentsBefore", "segmentsAfter", "hardToolTextBytes", "hardBundles", "rawToolTextBytes", "rawBundles",
	"projectedToolTextBytes", "projectedBundles", "stableToolTextBytesBefore", "stableBundlesBefore",
	"activeToolTextBytesBefore", "activeBundlesBefore", "agedRawToolTextBytes", "agedRawBundles",
	"agedProjectedToolTextBytes", "agedProjectedBundles", "suffixRawToolTextBytes", "suffixRawBundles",
] as const;
const CONTEXT_OBSERVATION_KEYS = ["actorRoleCode", "historyProjection"] as const;

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
	/** Aggregate trust level for all usage included in `usage`. */
	usageSemanticStatus?: UsageSemanticStatus | null;
	/** Strict bounded flag: 1 until a durable telemetry gap marker is appended. */
	telemetryWriteGapPending: 0 | 1;
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

export type HistoryProjectionInput = Omit<HistoryProjectionFacts, "contextSerial">;

/** Independent numeric API: callers need not import the projector's core type. */
export interface ContextProjectionObservation {
	actorRoleCode: ActorRoleCode;
	historyProjection?: HistoryProjectionInput | null;
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
	/** Ratio for the most recently observed request only. */
	lastRequestHitRatio: number | null;
	/** Ratio across `usage`; null unless every included request is verified. */
	cumulativeHitRatio: number | null;
	lastRequestSemanticStatus: UsageSemanticStatus | null;
	cumulativeSemanticStatus: UsageSemanticStatus | null;
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
	/** Mark Pi's completed session-tree navigation for the next cache record. */
	observeSessionTreeChange(): void;
	/**
	 * Observe a stable history-projection epoch identifier. The identifier is
	 * hashed in memory and never persisted; a changed hash marks one expected
	 * invalidation for the next recorded request. index.ts calls this only when
	 * the context projector crosses an epoch boundary.
	 */
	observeHistoryProjectionEpoch(epoch: string | number): void;
	/**
	 * Observe a same-epoch immutable segment-chain identifier. The identifier
	 * is hashed and deduplicated in memory only; no marker text or segment hash
	 * is added to telemetry records or persisted session state.
	 */
	observeHistoryProjectionSegmentSeal(segmentHash: string): void;
	/** Bind one context construction to the next observed provider request. */
	observeContextProjection(observation: ContextProjectionObservation): void;
	observeNewSession(): void;
	/** READ-ONLY structural peek at the provider payload. Never mutates. */
	observePayload(payload: unknown): void;
	/** Record that explicit breakpoints are present on the observed outgoing payload. */
	observeExplicitPromptCacheBreakpointsApplied(): void;
	restoreFromEntries(entries: readonly CacheStateEntryLike[]): void;
	observeMessageEnd(facts: MessageEndFacts): Promise<TelemetryRecord | null>;
	flush(): void;
	/** Compact TUI contribution: "CACHE last=72% cum=68% | read 184k | miss 71k". */
	statusSegment(): string | undefined;
	snapshot(): CacheSnapshot;
}

interface ExactOwnDataRecord {
	readonly values: Readonly<Record<string, unknown>>;
}

/** Copy a plain record without invoking accessors or proxy traps. */
function exactOwnDataRecord(
	value: unknown,
	allowedKeys: readonly string[],
	requiredKeys: readonly string[] = allowedKeys,
): ExactOwnDataRecord | undefined {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const names = Object.keys(descriptors);
		const allowed = new Set(allowedKeys);
		if (names.some((name) => !allowed.has(name))) return undefined;
		for (const required of requiredKeys) {
			if (!Object.prototype.hasOwnProperty.call(descriptors, required)) return undefined;
		}
		const values: Record<string, unknown> = Object.create(null);
		for (const name of names) {
			const descriptor = descriptors[name];
			if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
				return undefined;
			}
			values[name] = descriptor.value;
		}
		return { values };
	} catch {
		return undefined;
	}
}

/** Snapshot a bounded dense entry array without indexing untrusted input. */
function strictEntryArray(value: unknown): readonly unknown[] | undefined {
	try {
		if (!Array.isArray(value) || nodeTypes.isProxy(value)) return undefined;
		if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
		if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")) return undefined;
		const length = lengthDescriptor.value;
		if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CACHE_STATE_ENTRIES) return undefined;
		const output = new Array<unknown>(length);
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (key === "length") continue;
			if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return undefined;
			const index = Number(key);
			if (!Number.isSafeInteger(index) || index < 0 || index >= length) return undefined;
			if (descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
			output[index] = descriptor.value;
		}
		for (let index = 0; index < length; index += 1) {
			if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) return undefined;
		}
		return output;
	} catch {
		return undefined;
	}
}

type StateEntryCandidate =
	| { readonly kind: "unrelated" }
	| { readonly kind: "unsafe" }
	| { readonly kind: "matched"; readonly data: unknown };

/** Identify a cache-state entry using own data descriptors only. */
function cacheStateEntryCandidate(value: unknown): StateEntryCandidate {
	try {
		if (value === null || typeof value !== "object") return { kind: "unrelated" };
		if (nodeTypes.isProxy(value)) return { kind: "unsafe" };
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return { kind: "unsafe" };
		if (Object.getOwnPropertySymbols(value).length !== 0) return { kind: "unsafe" };
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const typeDescriptor = descriptors.type;
		if (!typeDescriptor || !Object.prototype.hasOwnProperty.call(typeDescriptor, "value")) return { kind: "unsafe" };
		if (typeDescriptor.value !== "custom") return { kind: "unrelated" };
		const customTypeDescriptor = descriptors.customType;
		if (!customTypeDescriptor || !Object.prototype.hasOwnProperty.call(customTypeDescriptor, "value")) {
			return { kind: "unsafe" };
		}
		if (customTypeDescriptor.value !== CACHE_STATE_ENTRY_TYPE) return { kind: "unrelated" };
		const dataDescriptor = descriptors.data;
		if (!dataDescriptor || !Object.prototype.hasOwnProperty.call(dataDescriptor, "value")) {
			return { kind: "matched", data: undefined };
		}
		return { kind: "matched", data: dataDescriptor.value };
	} catch {
		return { kind: "unsafe" };
	}
}

function boundedSafeInteger(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function boundedCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_CACHE_STATE_NUMERIC_VALUE;
}

function boundedCode(value: unknown, maximum: number): value is number {
	return boundedSafeInteger(value, maximum);
}

function parseProjectionInput(value: unknown, contextSerial: number): HistoryProjectionFacts | null | undefined {
	if (value === undefined || value === null) return null;
	const record = exactOwnDataRecord(value, PROJECTION_INPUT_KEYS);
	if (!record) return undefined;
	const facts = { contextSerial, ...(record.values as unknown as HistoryProjectionInput) };
	return isHistoryProjectionFacts(facts) ? facts : undefined;
}

function parseContextProjectionObservation(
	value: unknown,
	contextSerial: number,
): { actorRoleCode: ActorRoleCode; historyProjection: HistoryProjectionFacts | null } | undefined {
	const record = exactOwnDataRecord(value, CONTEXT_OBSERVATION_KEYS, ["actorRoleCode"]);
	if (!record || !boundedCode(record.values.actorRoleCode, 2)) return undefined;
	const historyProjection = parseProjectionInput(record.values.historyProjection, contextSerial);
	if (historyProjection === undefined) return undefined;
	return { actorRoleCode: record.values.actorRoleCode as ActorRoleCode, historyProjection };
}

function apiShapeCode(summary: PayloadSummary | undefined): 0 | 1 | 2 | 3 {
	if (!summary || summary.apiShape === "unknown") return 0;
	if (summary.apiShape === "chat-completions") return 1;
	if (summary.apiShape === "responses") return 2;
	return 3;
}

function relationshipCode(relationship: ReturnType<typeof classifyPayloadRelationship>): 0 | 1 | 2 | 3 {
	if (relationship === "UNCHANGED") return 1;
	if (relationship === "APPEND_ONLY") return 2;
	if (relationship === "PREFIX_REWRITTEN") return 3;
	return 0;
}

function localWireObservation(
	requestSerial: number,
	previous: PayloadSummary | undefined,
	current: PayloadSummary | undefined,
): WireObservationFacts {
	if (!current) {
		return {
			requestSerial, finalityCode: 0, digestStatusCode: 0, apiShapeCode: 0, relationshipCode: 0,
			itemCount: 0, itemLcpCount: 0, itemLcpUtf8Bytes: 0,
		};
	}
	const lcp = wholeItemLcpFacts(previous, current);
	return {
		requestSerial,
		finalityCode: 0,
		digestStatusCode: current.degraded ? 2 : 1,
		apiShapeCode: apiShapeCode(current),
		relationshipCode: relationshipCode(lcp.relationship),
		itemCount: lcp.itemCount,
		itemLcpCount: lcp.itemLcpCount,
		itemLcpUtf8Bytes: lcp.itemLcpUtf8Bytes,
	};
}

function cacheStateUsage(value: unknown): UsageTotalsLike | undefined {
	const record = exactOwnDataRecord(value, CACHE_STATE_USAGE_KEYS);
	if (!record) return undefined;
	const { input, output, cacheRead, cacheWrite, totalTokens, cost } = record.values;
	if (!boundedSafeInteger(input, MAX_CACHE_STATE_NUMERIC_VALUE)
		|| !boundedSafeInteger(output, MAX_CACHE_STATE_NUMERIC_VALUE)
		|| !boundedSafeInteger(cacheRead, MAX_CACHE_STATE_NUMERIC_VALUE)
		|| !boundedSafeInteger(cacheWrite, MAX_CACHE_STATE_NUMERIC_VALUE)
		|| !boundedSafeInteger(totalTokens, MAX_CACHE_STATE_NUMERIC_VALUE)
		|| !boundedCost(cost)) return undefined;
	const exactTotal = input + output + cacheRead + cacheWrite;
	if (!Number.isSafeInteger(exactTotal) || exactTotal !== totalTokens) return undefined;
	return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

function optionalHash(value: unknown): string | undefined {
	return value === undefined || (typeof value === "string" && CACHE_STATE_SHA256.test(value))
		? value
		: undefined;
}

function optionalNullableHash(value: unknown): string | null | undefined {
	return value === undefined || value === null || (typeof value === "string" && CACHE_STATE_SHA256.test(value))
		? value
		: undefined;
}

function cacheStateHashes(value: unknown): CacheStateEntryData["lastHashes"] | undefined {
	const record = exactOwnDataRecord(value, CACHE_STATE_HASH_KEYS, []);
	if (!record) return undefined;
	const systemPromptHash = optionalHash(record.values.systemPromptHash);
	const toolNamesHash = optionalHash(record.values.toolNamesHash);
	const toolOrderHash = optionalHash(record.values.toolOrderHash);
	const toolSchemaHash = optionalNullableHash(record.values.toolSchemaHash);
	const contextShapeHash = optionalNullableHash(record.values.contextShapeHash);
	if ((record.values.systemPromptHash !== undefined && systemPromptHash === undefined)
		|| (record.values.toolNamesHash !== undefined && toolNamesHash === undefined)
		|| (record.values.toolOrderHash !== undefined && toolOrderHash === undefined)
		|| (record.values.toolSchemaHash !== undefined && toolSchemaHash === undefined)
		|| (record.values.contextShapeHash !== undefined && contextShapeHash === undefined)) return undefined;
	const hashes: CacheStateEntryData["lastHashes"] = {};
	if (systemPromptHash !== undefined) hashes.systemPromptHash = systemPromptHash;
	if (toolNamesHash !== undefined) hashes.toolNamesHash = toolNamesHash;
	if (toolOrderHash !== undefined) hashes.toolOrderHash = toolOrderHash;
	if (toolSchemaHash !== undefined) hashes.toolSchemaHash = toolSchemaHash;
	if (contextShapeHash !== undefined) hashes.contextShapeHash = contextShapeHash;
	return hashes;
}

function exactIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 20 || value.length > 32) return false;
	const epoch = Date.parse(value);
	return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

/** Parse and clone the only state shape allowed to influence cache metrics. */
function parseCacheStateData(value: unknown): CacheStateEntryData | undefined {
	try {
		const record = exactOwnDataRecord(value, CACHE_STATE_KEYS, CACHE_STATE_REQUIRED_KEYS);
		if (!record) return undefined;
		const schemaVersion = record.values.schemaVersion;
		if (schemaVersion !== "1.0" && schemaVersion !== "1.1" && schemaVersion !== "1.2" && schemaVersion !== TELEMETRY_SCHEMA_VERSION) return undefined;
		const sessionHash = record.values.hashedSessionId;
		if (typeof sessionHash !== "string" || !CACHE_STATE_SESSION_HASH.test(sessionHash)) return undefined;
		const requestCount = record.values.requestCount;
		if (!boundedSafeInteger(requestCount, MAX_CACHE_STATE_REQUESTS)) return undefined;
		const usage = cacheStateUsage(record.values.usage);
		const lastHashes = cacheStateHashes(record.values.lastHashes);
		if (!usage || !lastHashes || !exactIsoTimestamp(record.values.updatedAt)) return undefined;
		if (requestCount === 0 && Object.values(usage).some((part) => part !== 0)) return undefined;
		if (requestCount > 0 && (
			lastHashes.systemPromptHash === undefined
			|| lastHashes.toolNamesHash === undefined
			|| lastHashes.toolOrderHash === undefined
			|| !Object.prototype.hasOwnProperty.call(lastHashes, "toolSchemaHash")
			|| !Object.prototype.hasOwnProperty.call(lastHashes, "contextShapeHash")
		)) return undefined;
		if (requestCount === 0 && Object.keys(lastHashes).length !== 0) return undefined;

		const rawSemanticStatus = record.values.usageSemanticStatus;
		let usageSemanticStatus: UsageSemanticStatus | null;
		if (rawSemanticStatus === undefined) {
			usageSemanticStatus = requestCount > 0 ? "unverified" : null;
		} else if (requestCount === 0 && rawSemanticStatus === null) {
			usageSemanticStatus = null;
		} else if (requestCount > 0
			&& typeof rawSemanticStatus === "string"
			&& CACHE_STATE_SEMANTIC_STATUSES.has(rawSemanticStatus as UsageSemanticStatus)) {
			usageSemanticStatus = rawSemanticStatus as UsageSemanticStatus;
		} else {
			return undefined;
		}

		const rawReason = record.values.lastInvalidationReason;
		if (rawReason !== undefined
			&& (typeof rawReason !== "string" || !CACHE_STATE_INVALIDATION_REASONS.has(rawReason))) return undefined;
		if (rawReason === "HISTORY_PROJECTION_SEGMENT_SEALED" && schemaVersion !== "1.2" && schemaVersion !== TELEMETRY_SCHEMA_VERSION) return undefined;
		const rawTelemetryWriteGapPending = record.values.telemetryWriteGapPending;
		const telemetryWriteGapPending = rawTelemetryWriteGapPending === undefined
			? 0
			: rawTelemetryWriteGapPending === 0 || rawTelemetryWriteGapPending === 1
				? rawTelemetryWriteGapPending
				: undefined;
		if (telemetryWriteGapPending === undefined) return undefined;
		if (telemetryWriteGapPending === 1 && usageSemanticStatus !== "unverified") return undefined;
		const rawTelemetryFile = record.values.telemetryFile;
		if (rawTelemetryFile !== undefined && rawTelemetryFile !== CACHE_STATE_TELEMETRY_FILE) return undefined;

		const parsed: CacheStateEntryData = {
			schemaVersion: TELEMETRY_SCHEMA_VERSION,
			hashedSessionId: sessionHash,
			requestCount,
			usage,
			usageSemanticStatus,
			telemetryWriteGapPending,
			lastHashes,
			updatedAt: record.values.updatedAt,
		};
		if (rawReason !== undefined) parsed.lastInvalidationReason = rawReason as CacheInvalidationReason;
		if (rawTelemetryFile !== undefined) parsed.telemetryFile = rawTelemetryFile;
		return parsed;
	} catch {
		return undefined;
	}
}

interface BoundRequestObservation {
	actorRoleCode: ActorRoleCode;
	requestCorrelationCode: RequestCorrelationCode;
	historyProjection: HistoryProjectionFacts | null;
	wireObservation: WireObservationFacts | null;
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
	let pendingSessionTreeChange = false;
	let pendingHistoryProjectionEpochChange = false;
	let pendingHistoryProjectionSegmentSeal = false;
	let pendingNewSession = false;
	let pendingModelChange = false;
	let pendingThinkingChange = false;
	let pendingModeChange = false;
	let state: CacheStateEntryData = freshState();
	let currentPayloadSummary: PayloadSummary | undefined;
	let previousPayloadSummary: PayloadSummary | undefined;
	let contextSerial = 0;
	let requestSerial = 0;
	let contextsSinceLastPayload = 0;
	let correlationApiActive = false;
	let contextObservationInvalid = false;
	let latestContextObservation: { actorRoleCode: ActorRoleCode; historyProjection: HistoryProjectionFacts | null } | undefined;
	let pendingRequestObservation: BoundRequestObservation | undefined;
	let lastHistoryProjectionEpochHash: string | undefined;
	let lastHistoryProjectionSegmentHash: string | undefined;
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
			usageSemanticStatus: null,
			telemetryWriteGapPending: 0,
			lastHashes: {},
			telemetryFile: undefined,
			updatedAt: new Date(now()).toISOString(),
		};
	}

	function persistState(): void {
		try {
			state.updatedAt = new Date(now()).toISOString();
			const snapshot = parseCacheStateData(state);
			if (!snapshot) return;
			// Pi keeps custom-entry data in memory. Persist a detached snapshot so a
			// host callback cannot mutate telemetry internals and older entries remain
			// chronological rather than sharing the current mutable state object.
			deps.appendEntry(CACHE_STATE_ENTRY_TYPE, snapshot);
		} catch {
			// In-memory state remains valid; persistence is best-effort.
		}
	}

	function resetProjectionObservability(): void {
		pendingHistoryProjectionEpochChange = false;
		pendingHistoryProjectionSegmentSeal = false;
		lastHistoryProjectionEpochHash = undefined;
		lastHistoryProjectionSegmentHash = undefined;
		contextSerial = 0;
		requestSerial = 0;
		contextsSinceLastPayload = 0;
		correlationApiActive = false;
		contextObservationInvalid = false;
		latestContextObservation = undefined;
		pendingRequestObservation = undefined;
	}

	function consumeRequestObservation(): BoundRequestObservation {
		if (pendingRequestObservation) {
			const observed = pendingRequestObservation;
			pendingRequestObservation = undefined;
			return observed;
		}
		if (!correlationApiActive) {
			return { actorRoleCode: 0, requestCorrelationCode: 0, historyProjection: null, wireObservation: null };
		}
		// A message_end without exactly one pending provider observation cannot
		// be joined to a context. Consume any unmatched context as stale.
		contextsSinceLastPayload = 0;
		contextObservationInvalid = false;
		latestContextObservation = undefined;
		return { actorRoleCode: 0, requestCorrelationCode: 3, historyProjection: null, wireObservation: null };
	}

	function resetRestoredState(): void {
		state = freshState();
		pendingNewSession = true;
		resetProjectionObservability();
		lastCacheRead = 0;
		lastSemanticStatus = null;
		lastHitRatio = null;
		lastReason = null;
		lastConfidence = null;
		currentPayloadSummary = undefined;
		previousPayloadSummary = undefined;
	}

	function acceptRestoredState(restored: CacheStateEntryData): void {
		state = restored;
		pendingNewSession = false;
		resetProjectionObservability();
		lastCacheRead = 0;
		lastSemanticStatus = null;
		lastHitRatio = null;
		lastReason = restored.lastInvalidationReason ?? null;
		lastConfidence = null;
		currentPayloadSummary = undefined;
		previousPayloadSummary = undefined;
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
				resetProjectionObservability();
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

		observeSessionTreeChange(): void {
			pendingSessionTreeChange = true;
			lastEvent = "session_tree";
		},

		observeHistoryProjectionEpoch(epoch: string | number): void {
			try {
				const nextHash = sha256Hex(String(epoch));
				if (lastHistoryProjectionEpochHash !== nextHash) {
					lastHistoryProjectionEpochHash = nextHash;
					pendingHistoryProjectionEpochChange = true;
					lastEvent = "history_projection_epoch";
				}
			} catch {
				// Observability cannot affect the request path.
			}
		},

		observeHistoryProjectionSegmentSeal(segmentHash: string): void {
			try {
				if (!CACHE_STATE_SHA256.test(segmentHash)) return;
				if (lastHistoryProjectionSegmentHash !== segmentHash) {
					lastHistoryProjectionSegmentHash = segmentHash;
					pendingHistoryProjectionSegmentSeal = true;
					lastEvent = "history_projection_segment";
				}
			} catch {
				// Observability cannot affect the request path.
			}
		},

		observeContextProjection(observation: ContextProjectionObservation): void {
			try {
				correlationApiActive = true;
				if (contextSerial >= MAX_CACHE_STATE_REQUESTS) {
					contextObservationInvalid = true;
					contextsSinceLastPayload = 2;
					latestContextObservation = undefined;
					return;
				}
				contextSerial += 1;
				contextsSinceLastPayload = Math.min(2, contextsSinceLastPayload + 1);
				const parsed = parseContextProjectionObservation(observation, contextSerial);
				if (!parsed) {
					contextObservationInvalid = true;
					latestContextObservation = undefined;
				} else {
					latestContextObservation = parsed;
				}
				if (pendingRequestObservation) {
					pendingRequestObservation = {
						actorRoleCode: 0,
						requestCorrelationCode: 2,
						historyProjection: null,
						wireObservation: pendingRequestObservation.wireObservation,
					};
					contextsSinceLastPayload = 0;
					contextObservationInvalid = false;
					latestContextObservation = undefined;
				}
			} catch {
				correlationApiActive = true;
				contextObservationInvalid = true;
				contextsSinceLastPayload = 2;
				latestContextObservation = undefined;
			}
		},

		observeNewSession(): void {
			pendingNewSession = true;
			lastEvent = "session_start:new";
		},

		observePayload(payload: unknown): void {
			// Structural digest only — no text survives, payload untouched.
			try {
				currentPayloadSummary = summarizePayload(payload);
			} catch {
				currentPayloadSummary = undefined;
			}
			try {
				requestSerial += 1;
				if (!Number.isSafeInteger(requestSerial) || requestSerial > MAX_CACHE_STATE_REQUESTS) {
					requestSerial = MAX_CACHE_STATE_REQUESTS;
					pendingRequestObservation = {
						actorRoleCode: 0, requestCorrelationCode: 2, historyProjection: null, wireObservation: null,
					};
				} else if (pendingRequestObservation) {
					// Multiple provider observations before one message_end cannot be
					// attributed to a particular response.
					pendingRequestObservation = {
						actorRoleCode: 0, requestCorrelationCode: 2, historyProjection: null, wireObservation: null,
					};
				} else {
					const wireObservation = localWireObservation(requestSerial, previousPayloadSummary, currentPayloadSummary);
					if (!correlationApiActive) {
						pendingRequestObservation = {
							actorRoleCode: 0, requestCorrelationCode: 0, historyProjection: null, wireObservation,
						};
					} else if (
						!contextObservationInvalid
						&& contextsSinceLastPayload === 1
						&& latestContextObservation !== undefined
					) {
						pendingRequestObservation = {
							actorRoleCode: latestContextObservation.actorRoleCode,
							requestCorrelationCode: 1,
							historyProjection: latestContextObservation.historyProjection,
							wireObservation,
						};
					} else {
						pendingRequestObservation = {
							actorRoleCode: 0,
							requestCorrelationCode: contextsSinceLastPayload > 1 || contextObservationInvalid ? 2 : 3,
							historyProjection: null,
							wireObservation,
						};
					}
				}
				contextsSinceLastPayload = 0;
				contextObservationInvalid = false;
				latestContextObservation = undefined;
			} catch {
				pendingRequestObservation = {
					actorRoleCode: 0, requestCorrelationCode: 2, historyProjection: null, wireObservation: null,
				};
			}
			lastEvent = "before_provider_request";
		},

		observeExplicitPromptCacheBreakpointsApplied(): void {
			lastEvent = EXPLICIT_PROMPT_CACHE_BREAKPOINTS_APPLIED_EVENT;
		},

		restoreFromEntries(entries: readonly CacheStateEntryLike[]): void {
			try {
				const safeEntries = strictEntryArray(entries);
				if (!safeEntries) {
					resetRestoredState();
					return;
				}
				for (let index = safeEntries.length - 1; index >= 0; index -= 1) {
					const candidate = cacheStateEntryCandidate(safeEntries[index]);
					if (candidate.kind === "unrelated") continue;
					if (candidate.kind === "unsafe") {
						resetRestoredState();
						return;
					}
					const restored = parseCacheStateData(candidate.data);
					if (!restored || restored.hashedSessionId !== hashedSessionId) {
						// The latest matching entry is authoritative. Malformed or
						// cross-session state fails closed; older entries cannot revive it.
						resetRestoredState();
						return;
					}
					acceptRestoredState(restored);
					return;
				}
				resetRestoredState();
			} catch {
				resetRestoredState();
			} finally {
				lastEvent = "session_start";
			}
		},

		async observeMessageEnd(facts: MessageEndFacts): Promise<TelemetryRecord | null> {
			try {
				const requestObservation = consumeRequestObservation();
				if (!enabled || store === undefined || facts.usage === undefined) return null;

				const apiKind = facts.apiKind ?? lastApiKind;
				const semantics = verifyUsageSemantics(apiKind, facts.usage);
				const fingerprint = fingerprintTools(facts.activeToolNames, facts.tools);
				const sysHash = systemPromptHash(facts.systemPrompt);
				const ctxShapeHash = currentPayloadSummary ? payloadShapeHash(currentPayloadSummary) : null;
				const payloadRelationship = classifyPayloadRelationship(previousPayloadSummary, currentPayloadSummary);

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
				const contextShapeChanged = payloadRelationship === "PREFIX_REWRITTEN";

				const verdict = classifyInvalidation({
					isFirstRequest: state.requestCount === 0,
					isNewSession: pendingNewSession,
					modelChanged: pendingModelChange,
					thinkingChanged: pendingThinkingChange,
					modeChanged: pendingModeChange,
					packageReloaded: pendingReload,
					compactionOccurred: pendingCompaction,
					sessionTreeChanged: pendingSessionTreeChange,
					historyProjectionEpochChanged: pendingHistoryProjectionEpochChange,
					historyProjectionSegmentSealed: pendingHistoryProjectionSegmentSeal,
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

				const carriesTelemetryWriteGap = state.telemetryWriteGapPending === 1;
				const usageSemanticStatus = carriesTelemetryWriteGap ? "unverified" : semantics.status;
				const cacheMetrics = cacheUsageMetrics(facts.provider, apiKind, facts.usage, usageSemanticStatus);
				const record: TelemetryRecord = {
					schemaVersion: TELEMETRY_SCHEMA_VERSION,
					timestamp: new Date(now()).toISOString(),
					extensionVersion: version,
					hashedSessionId,
					provider: facts.provider,
					model: facts.model,
					apiKind,
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
					usageSemanticStatus,
					cacheHitRatio: carriesTelemetryWriteGap ? null : semantics.cacheHitRatio,
					promptInputTokens: cacheMetrics.promptInputTokens,
					cacheReadShare: cacheMetrics.cacheReadShare,
					cacheWriteShare: cacheMetrics.cacheWriteShare,
					cacheWriteStatusCode: cacheMetrics.cacheWriteStatusCode,
					actorRoleCode: requestObservation.actorRoleCode,
					requestCorrelationCode: requestObservation.requestCorrelationCode,
					historyProjection: requestObservation.historyProjection,
					wireObservation: requestObservation.wireObservation,
					systemPromptHash: sysHash,
					activeToolNamesHash: fingerprint.namesHash,
					activeToolOrderHash: fingerprint.orderHash,
					activeToolSchemaHash: fingerprint.schemaHash,
					contextShapeHash: ctxShapeHash,
					precedingEvent: carriesTelemetryWriteGap ? TELEMETRY_WRITE_GAP_EVENT : lastEvent,
					inferredInvalidationReason: verdict.reason,
					inferenceConfidence: verdict.confidence,
					driftSource: verdict.driftSource,
				};

				// Persist (best-effort, append-only). A failure is itself an
				// observation gap: retain the marker until a later append succeeds,
				// and fail this request's persisted semantics closed in memory.
				const appendResult = await store.appendRecord(record);
				if (appendResult.ok) {
					if (carriesTelemetryWriteGap) state.telemetryWriteGapPending = 0;
				} else {
					state.telemetryWriteGapPending = 1;
					record.precedingEvent = TELEMETRY_WRITE_GAP_EVENT;
					record.usageSemanticStatus = "unverified";
					record.cacheHitRatio = null;
					record.cacheReadShare = null;
					record.cacheWriteShare = null;
					record.cacheWriteStatusCode = 0;
				}

				// Advance the session state.
				state.requestCount += 1;
				state.usage = addUsageTotals(state.usage, facts.usage);
				state.usageSemanticStatus = combineUsageSemanticStatus(state.usageSemanticStatus ?? null, record.usageSemanticStatus);
				state.lastHashes = {
					systemPromptHash: sysHash,
					toolNamesHash: fingerprint.namesHash,
					toolOrderHash: fingerprint.orderHash,
					toolSchemaHash: fingerprint.schemaHash,
					contextShapeHash: ctxShapeHash,
				};
				state.lastInvalidationReason = verdict.reason;
				if (appendResult.ok) state.telemetryFile = store.telemetryRef();

				lastProvider = facts.provider;
				lastModel = facts.model;
				if (facts.apiKind !== null) lastApiKind = facts.apiKind;
				lastCacheRead = facts.usage.cacheRead;
				lastSemanticStatus = record.usageSemanticStatus;
				lastHitRatio = record.cacheHitRatio;
				lastReason = verdict.reason;
				lastConfidence = verdict.confidence;
				previousPayloadSummary = currentPayloadSummary;
				lastEvent = "message_end";

				// One-shot flags are consumed.
				pendingReload = false;
				pendingCompaction = false;
				pendingSessionTreeChange = false;
				pendingHistoryProjectionEpochChange = false;
				pendingHistoryProjectionSegmentSeal = false;
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
			try {
				const safeState = parseCacheStateData(state);
				if (!enabled || !safeState || safeState.requestCount === 0) return undefined;
				const safeLastRatio = lastSemanticStatus === "verified"
					&& typeof lastHitRatio === "number"
					&& Number.isFinite(lastHitRatio)
					&& lastHitRatio >= 0
					&& lastHitRatio <= 1
					? lastHitRatio
					: null;
				const last = safeLastRatio === null ? "N/A" : `${Math.round(safeLastRatio * 100)}%`;
				const cumulativeRatio = safeState.usageSemanticStatus === "verified"
					? cacheHitRatioFromTotals(safeState.usage)
					: null;
				const cumulative = cumulativeRatio === null ? "N/A" : `${Math.round(cumulativeRatio * 100)}%`;
				return `CACHE last=${last} cum=${cumulative} | read ${formatTokens(safeState.usage.cacheRead)} | miss ${formatTokens(safeState.usage.input)}`;
			} catch {
				return undefined;
			}
		},

		snapshot(): CacheSnapshot {
			const safeState = parseCacheStateData(state);
			const safeUsage = safeState?.usage ?? emptyUsageTotals();
			const safeLastStatus = lastSemanticStatus !== null && CACHE_STATE_SEMANTIC_STATUSES.has(lastSemanticStatus)
				? lastSemanticStatus
				: null;
			const safeLastRatio = safeLastStatus === "verified"
				&& typeof lastHitRatio === "number"
				&& Number.isFinite(lastHitRatio)
				&& lastHitRatio >= 0
				&& lastHitRatio <= 1
				? lastHitRatio
				: null;
			const cumulativeStatus = safeState?.usageSemanticStatus ?? null;
			return {
				enabled,
				hashedSessionId,
				provider: lastProvider,
				model: lastModel,
				apiKind: lastApiKind,
				mode: mode ?? null,
				thinkingLevel,
				requestCount: safeState?.requestCount ?? 0,
				usage: { ...safeUsage },
				lastRequestHitRatio: safeLastRatio,
				cumulativeHitRatio: cumulativeStatus === "verified" ? cacheHitRatioFromTotals(safeUsage) : null,
				lastRequestSemanticStatus: safeLastStatus,
				cumulativeSemanticStatus: cumulativeStatus,
				lastInvalidationReason: safeState ? lastReason : null,
				lastInvalidationConfidence: lastConfidence,
				telemetryFile: safeState?.telemetryFile ?? null,
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
