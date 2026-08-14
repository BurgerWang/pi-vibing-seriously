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
 *   - `openai-responses` / `azure-openai-responses` /
 *     `openai-codex-responses`: `input =
 *     max(0, input_tokens - cached_tokens - cache_write_tokens)` with
 *     `cacheRead = input_tokens_details.cached_tokens`. The Codex provider
 *     (`openai-codex-responses`) streams through the same
 *     `openai-responses-shared` `finalizeResponse` normalization, so its
 *     semantics are identical to the other Responses kinds.
 *   - `anthropic-messages`: `input = input_tokens` (Anthropic reports cache
 *     reads/writes in separate fields, so `input_tokens` already excludes
 *     them), `cacheRead = cache_read_input_tokens`.
 *
 * Any other api kind keeps the normalized usage but is reported with
 * `usageSemanticStatus: "unverified"` — the workbench never guesses.
 */

import { types as nodeTypes } from "node:util";

import {
	DRIFT_SOURCES,
	INVALIDATION_REASONS,
	type CacheInvalidationReason,
	type DriftSource,
	type InferenceConfidence,
} from "./invalidation-classifier.ts";

/**
 * Schema version of telemetry records and the session state entry.
 * 1.3: adds numeric-only request correlation, projection anatomy, local
 * provider-observation facts and cache-read/write shares. Provider text,
 * SDK payload bodies and projection marker text are never persisted.
 * Readers remain strict for every exact 1.0 through 1.3 record shape.
 */
export const TELEMETRY_SCHEMA_VERSION = "1.3" as const;
export type TelemetrySchemaVersion = "1.0" | "1.1" | "1.2" | typeof TELEMETRY_SCHEMA_VERSION;

/** Must stay in sync with package.json version. */
export const EXTENSION_VERSION = "0.10.0";

/** Pi usage api kinds whose normalized semantics were verified above. */
export const VERIFIED_API_KINDS: ReadonlySet<string> = new Set([
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
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

export type ActorRoleCode = 0 | 1 | 2;
export type RequestCorrelationCode = 0 | 1 | 2 | 3;
export type CacheWriteStatusCode = 0 | 1 | 2 | 3;

/** Numeric-only anatomy supplied by the context projector; no core type dependency. */
export interface HistoryProjectionFacts {
	contextSerial: number;
	eventCode: 0 | 1 | 2 | 3 | 4 | 5 | 6;
	causeCode: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
	epoch: number;
	epochTransitioned: 0 | 1;
	segmentSealed: 0 | 1;
	byteOverflow: 0 | 1;
	bundleOverflow: 0 | 1;
	segmentsBefore: number;
	segmentsAfter: number;
	hardToolTextBytes: number;
	hardBundles: number;
	rawToolTextBytes: number;
	rawBundles: number;
	projectedToolTextBytes: number;
	projectedBundles: number;
	stableToolTextBytesBefore: number;
	stableBundlesBefore: number;
	activeToolTextBytesBefore: number;
	activeBundlesBefore: number;
	agedRawToolTextBytes: number;
	agedRawBundles: number;
	agedProjectedToolTextBytes: number;
	agedProjectedBundles: number;
	suffixRawToolTextBytes: number;
	suffixRawBundles: number;
}

/** Local before_provider_request observation, explicitly not final actual wire. */
export interface WireObservationFacts {
	requestSerial: number;
	finalityCode: 0;
	digestStatusCode: 0 | 1 | 2;
	apiShapeCode: 0 | 1 | 2 | 3;
	relationshipCode: 0 | 1 | 2 | 3;
	itemCount: number;
	itemLcpCount: number;
	itemLcpUtf8Bytes: number;
}

/**
 * Per-request telemetry record (one JSONL line).
 * Every field is a fact about usage or a hash — never message content.
 */
export interface TelemetryRecord {
	schemaVersion: TelemetrySchemaVersion;
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
	/** 1.3 only; absent from strict legacy 1.0-1.2 records. */
	promptInputTokens?: number;
	cacheReadShare?: number | null;
	cacheWriteShare?: number | null;
	cacheWriteStatusCode?: CacheWriteStatusCode;
	actorRoleCode?: ActorRoleCode;
	requestCorrelationCode?: RequestCorrelationCode;
	historyProjection?: HistoryProjectionFacts | null;
	wireObservation?: WireObservationFacts | null;
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
	driftSource?: DriftSource | null;
}

const TELEMETRY_RECORD_KEYS_V1_2 = [
	"schemaVersion",
	"timestamp",
	"extensionVersion",
	"hashedSessionId",
	"provider",
	"model",
	"apiKind",
	"thinkingLevel",
	"workbenchMode",
	"messageStatus",
	"usage",
	"usageSemanticStatus",
	"cacheHitRatio",
	"systemPromptHash",
	"activeToolNamesHash",
	"activeToolOrderHash",
	"activeToolSchemaHash",
	"contextShapeHash",
	"precedingEvent",
	"inferredInvalidationReason",
	"inferenceConfidence",
	"driftSource",
] as const;

const TELEMETRY_RECORD_KEYS_V1_3 = [
	...TELEMETRY_RECORD_KEYS_V1_2,
	"promptInputTokens",
	"cacheReadShare",
	"cacheWriteShare",
	"cacheWriteStatusCode",
	"actorRoleCode",
	"requestCorrelationCode",
	"historyProjection",
	"wireObservation",
] as const;
const TELEMETRY_RECORD_KEYS_V1_0 = TELEMETRY_RECORD_KEYS_V1_2.filter((key) => key !== "driftSource");

const HISTORY_PROJECTION_KEYS = [
	"contextSerial", "eventCode", "causeCode", "epoch", "epochTransitioned", "segmentSealed", "byteOverflow", "bundleOverflow",
	"segmentsBefore", "segmentsAfter", "hardToolTextBytes", "hardBundles", "rawToolTextBytes", "rawBundles",
	"projectedToolTextBytes", "projectedBundles", "stableToolTextBytesBefore", "stableBundlesBefore",
	"activeToolTextBytesBefore", "activeBundlesBefore", "agedRawToolTextBytes", "agedRawBundles",
	"agedProjectedToolTextBytes", "agedProjectedBundles", "suffixRawToolTextBytes", "suffixRawBundles",
] as const;
const WIRE_OBSERVATION_KEYS = [
	"requestSerial", "finalityCode", "digestStatusCode", "apiShapeCode", "relationshipCode",
	"itemCount", "itemLcpCount", "itemLcpUtf8Bytes",
] as const;

const USAGE_TOTAL_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const;
const TELEMETRY_HASH = /^[0-9a-f]{64}$/;
const SESSION_HASH = /^[0-9a-f]{16}$/;
const USAGE_STATUSES: ReadonlySet<UsageSemanticStatus> = new Set(["verified", "partial", "unverified"]);
const INFERENCE_CONFIDENCES: ReadonlySet<InferenceConfidence> = new Set(["high", "medium", "low"]);
const INVALIDATION_REASON_SET: ReadonlySet<string> = new Set(INVALIDATION_REASONS);
const DRIFT_SOURCE_SET: ReadonlySet<string> = new Set(DRIFT_SOURCES);
/** A single record cannot plausibly exceed this and remains safely aggregatable. */
const MAX_TELEMETRY_NUMERIC_VALUE = 1_000_000_000_000_000;
/** Must match the core controller's fixed immutable-segment window. */
const HISTORY_PROJECTION_MAX_SEGMENTS = 16;

/**
 * Runtime guard for persisted telemetry. JSON being syntactically valid is
 * not enough: reports may only consume the exact hash-only 1.0-1.3
 * contracts. Accessors, proxies, inherited fields, unknown fields and
 * invalid numeric/semantic combinations all fail closed.
 */
export function isTelemetryRecord(value: unknown): value is TelemetryRecord {
	try {
		if (!isPlainOwnDataRecord(value)) return false;
		if (value.schemaVersion === TELEMETRY_SCHEMA_VERSION) {
			if (!hasExactOwnKeys(value, TELEMETRY_RECORD_KEYS_V1_3)) return false;
		} else if (value.schemaVersion === "1.1" || value.schemaVersion === "1.2") {
			if (!hasExactOwnKeys(value, TELEMETRY_RECORD_KEYS_V1_2)) return false;
		} else if (value.schemaVersion === "1.0") {
			if (!hasExactOwnKeys(value, TELEMETRY_RECORD_KEYS_V1_0)) return false;
		} else {
			return false;
		}
		if (!isIsoTimestamp(value.timestamp)) return false;
		if (!boundedString(value.extensionVersion, 1, 64)) return false;
		if (typeof value.hashedSessionId !== "string" || !SESSION_HASH.test(value.hashedSessionId)) return false;
		if (!boundedString(value.provider, 1, 256) || !boundedString(value.model, 1, 256)) return false;
		if (!nullableBoundedString(value.apiKind, 128) || !nullableBoundedString(value.thinkingLevel, 64)) return false;
		if (!boundedString(value.workbenchMode, 1, 64)) return false;
		if (value.messageStatus !== "ok" && value.messageStatus !== "error") return false;
		if (!isUsageTotals(value.usage)) return false;
		if (typeof value.usageSemanticStatus !== "string" || !USAGE_STATUSES.has(value.usageSemanticStatus as UsageSemanticStatus)) return false;
		if (!validCacheHitRatio(value.cacheHitRatio, value.usageSemanticStatus as UsageSemanticStatus, value.usage)) return false;
		if (value.schemaVersion === TELEMETRY_SCHEMA_VERSION && !validV1_3Facts(value)) return false;
		if (!isHash(value.systemPromptHash) || !isHash(value.activeToolNamesHash) || !isHash(value.activeToolOrderHash)) return false;
		if (!nullableHash(value.activeToolSchemaHash) || !nullableHash(value.contextShapeHash)) return false;
		if (!nullableBoundedString(value.precedingEvent, 128)) return false;
		if (typeof value.inferredInvalidationReason !== "string" || !INVALIDATION_REASON_SET.has(value.inferredInvalidationReason)) return false;
		if (value.inferredInvalidationReason === "HISTORY_PROJECTION_SEGMENT_SEALED"
			&& value.schemaVersion !== "1.2" && value.schemaVersion !== TELEMETRY_SCHEMA_VERSION) return false;
		if (typeof value.inferenceConfidence !== "string" || !INFERENCE_CONFIDENCES.has(value.inferenceConfidence as InferenceConfidence)) return false;
		if (value.schemaVersion !== "1.0") {
			if (value.driftSource !== null && (typeof value.driftSource !== "string" || !DRIFT_SOURCE_SET.has(value.driftSource))) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function isPlainOwnDataRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	if (Object.getOwnPropertySymbols(value).length > 0) return false;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	return Object.values(descriptors).every((descriptor) => descriptor.enumerable === true
		&& "value" in descriptor && descriptor.get === undefined && descriptor.set === undefined);
}

function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	if (keys.length !== expected.length) return false;
	const expectedSet = new Set(expected);
	return keys.every((key) => expectedSet.has(key));
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
	return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function nullableBoundedString(value: unknown, maximum: number): value is string | null {
	return value === null || boundedString(value, 1, maximum);
}

function isHash(value: unknown): value is string {
	return typeof value === "string" && TELEMETRY_HASH.test(value);
}

function nullableHash(value: unknown): value is string | null {
	return value === null || isHash(value);
}

function isIsoTimestamp(value: unknown): value is string {
	if (!boundedString(value, 20, 32)) return false;
	const epoch = Date.parse(value);
	return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function safeTelemetryToken(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TELEMETRY_NUMERIC_VALUE;
}

function safeTelemetryCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TELEMETRY_NUMERIC_VALUE;
}

function isUsageTotals(value: unknown): value is UsageTotalsLike {
	if (!isPlainOwnDataRecord(value) || !hasExactOwnKeys(value, USAGE_TOTAL_KEYS)) return false;
	if (!safeTelemetryToken(value.input) || !safeTelemetryToken(value.output)) return false;
	if (!safeTelemetryToken(value.cacheRead) || !safeTelemetryToken(value.cacheWrite)) return false;
	if (!safeTelemetryToken(value.totalTokens) || !safeTelemetryCost(value.cost)) return false;
	const expectedTotal = value.input + value.output + value.cacheRead + value.cacheWrite;
	return Number.isSafeInteger(expectedTotal) && value.totalTokens === expectedTotal;
}

function validCacheHitRatio(value: unknown, status: UsageSemanticStatus, usage: UsageTotalsLike): boolean {
	if (status !== "verified") return value === null;
	const expected = cacheHitRatioFromTotals(usage);
	if (expected === null) return value === null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return false;
	return Math.abs(value - expected) <= Number.EPSILON * 4;
}

function sameRatio(value: unknown, expected: number | null): boolean {
	if (expected === null) return value === null;
	return typeof value === "number"
		&& Number.isFinite(value)
		&& value >= 0
		&& value <= 1
		&& Math.abs(value - expected) <= Number.EPSILON * 4;
}

function isCode(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/**
 * Strict cache-side semantic guard for the core projector's numeric anatomy.
 * Kept independent of the core module so persisted-record readers and the
 * best-effort writer share one fail-closed contract without a runtime cycle.
 */
export function isHistoryProjectionFacts(value: unknown): value is HistoryProjectionFacts {
	if (!isPlainOwnDataRecord(value) || !hasExactOwnKeys(value, HISTORY_PROJECTION_KEYS)) return false;
	const facts = value as unknown as HistoryProjectionFacts;
	for (const key of HISTORY_PROJECTION_KEYS) {
		if (!safeTelemetryToken(facts[key])) return false;
	}
	if (facts.contextSerial > 1_000_000_000) return false;
	if (!isCode(facts.eventCode, 6) || !isCode(facts.causeCode, 9)) return false;
	for (const key of ["epochTransitioned", "segmentSealed", "byteOverflow", "bundleOverflow"] as const) {
		if (!isCode(facts[key], 1)) return false;
	}
	if (facts.segmentsBefore > HISTORY_PROJECTION_MAX_SEGMENTS || facts.segmentsAfter > HISTORY_PROJECTION_MAX_SEGMENTS) {
		return false;
	}

	const noOverflow = facts.byteOverflow === 0 && facts.bundleOverflow === 0;
	const hasOverflow = facts.byteOverflow === 1 || facts.bundleOverflow === 1;
	switch (facts.eventCode) {
		case 0: // none
			return facts.causeCode === 0
				&& facts.epochTransitioned === 0
				&& facts.segmentSealed === 0
				&& noOverflow
				&& facts.segmentsAfter === facts.segmentsBefore;
		case 1: // initial_hard_projection
			return facts.causeCode === 1
				&& facts.epochTransitioned === 1
				&& facts.segmentSealed === 0
				&& hasOverflow
				&& facts.segmentsBefore === 0
				&& facts.segmentsAfter === 0;
		case 2: // segment_seal
			return facts.causeCode === 4
				&& facts.epochTransitioned === 0
				&& facts.segmentSealed === 1
				&& hasOverflow
				&& facts.segmentsAfter === facts.segmentsBefore + 1;
		case 3: // epoch_checkpoint
			return (facts.causeCode === 2 || facts.causeCode === 3 || facts.causeCode === 5
					|| facts.causeCode === 6 || facts.causeCode === 7)
				&& facts.epochTransitioned === 1
				&& facts.segmentSealed === 0
				&& hasOverflow
				&& facts.segmentsAfter === 0
				&& (facts.causeCode !== 7 || facts.segmentsBefore === 0);
		case 4: // inactive_boundary
			return (facts.causeCode === 5 || facts.causeCode === 6 || facts.causeCode === 7)
				&& facts.epochTransitioned === 1
				&& facts.segmentSealed === 0
				&& noOverflow
				&& facts.segmentsAfter === 0
				&& (facts.causeCode !== 7 || facts.segmentsBefore === 0);
		case 5: // fixed_failure; the same fixed boundary may repeat without a transition
			return facts.causeCode === 8
				&& facts.segmentSealed === 0
				&& facts.segmentsAfter === 0;
		case 6: // one-shot recovery after failure clears all frozen segments
			return facts.causeCode === 9
				&& facts.epochTransitioned === 1
				&& facts.segmentSealed === 0
				&& facts.segmentsBefore === 0
				&& facts.segmentsAfter === 0;
	}
	return false;
}

function isWireObservationFacts(value: unknown): value is WireObservationFacts {
	if (!isPlainOwnDataRecord(value) || !hasExactOwnKeys(value, WIRE_OBSERVATION_KEYS)) return false;
	const facts = value as unknown as WireObservationFacts;
	if (!safeTelemetryToken(facts.requestSerial) || facts.requestSerial > 1_000_000_000) return false;
	if (facts.finalityCode !== 0) return false;
	if (!isCode(facts.digestStatusCode, 2) || !isCode(facts.apiShapeCode, 3) || !isCode(facts.relationshipCode, 3)) return false;
	if (!safeTelemetryToken(facts.itemCount) || !safeTelemetryToken(facts.itemLcpCount) || !safeTelemetryToken(facts.itemLcpUtf8Bytes)) return false;
	if (facts.itemLcpCount > facts.itemCount) return false;
	if (facts.itemLcpCount === 0 && facts.itemLcpUtf8Bytes !== 0) return false;
	if (facts.relationshipCode === 0 && (facts.itemLcpCount !== 0 || facts.itemLcpUtf8Bytes !== 0)) return false;
	if (facts.digestStatusCode === 0 && (
		facts.apiShapeCode !== 0 || facts.relationshipCode !== 0 || facts.itemCount !== 0
		|| facts.itemLcpCount !== 0 || facts.itemLcpUtf8Bytes !== 0
	)) return false;
	return true;
}

function validV1_3Facts(value: Record<string, unknown>): boolean {
	if (!isUsageTotals(value.usage)) return false;
	if (typeof value.provider !== "string" || !nullableBoundedString(value.apiKind, 128)) return false;
	if (typeof value.usageSemanticStatus !== "string" || !USAGE_STATUSES.has(value.usageSemanticStatus as UsageSemanticStatus)) return false;
	const status = value.usageSemanticStatus as UsageSemanticStatus;
	const expected = cacheUsageMetrics(value.provider, value.apiKind as string | null, value.usage, status);
	if (value.promptInputTokens !== expected.promptInputTokens) return false;
	if (!sameRatio(value.cacheReadShare, expected.cacheReadShare) || !sameRatio(value.cacheWriteShare, expected.cacheWriteShare)) return false;
	if (value.cacheWriteStatusCode !== expected.cacheWriteStatusCode) return false;
	if (!isCode(value.actorRoleCode, 2) || !isCode(value.requestCorrelationCode, 3)) return false;
	if (value.historyProjection !== null && !isHistoryProjectionFacts(value.historyProjection)) return false;
	if (value.wireObservation !== null && !isWireObservationFacts(value.wireObservation)) return false;
	if (value.requestCorrelationCode === 1) {
		if (value.wireObservation === null) return false;
	} else if (value.actorRoleCode !== 0 || value.historyProjection !== null) {
		return false;
	}
	return true;
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

export interface CacheUsageMetrics {
	promptInputTokens: number;
	cacheReadShare: number | null;
	cacheWriteShare: number | null;
	cacheWriteStatusCode: CacheWriteStatusCode;
}

/**
 * Compute 1.3 cache metrics from Pi-normalized prompt components. DeepSeek's
 * Chat Completions adapter cannot expose writes; Responses adapters coalesce
 * absent and zero writes, so neither is promoted to presence-verified.
 */
export function cacheUsageMetrics(
	provider: string,
	apiKind: string | null | undefined,
	usage: Pick<PiUsageLike, "input" | "cacheRead" | "cacheWrite">,
	status: UsageSemanticStatus,
): CacheUsageMetrics {
	const parts = [usage.input, usage.cacheRead, usage.cacheWrite];
	const validParts = parts.every((part) => safeTelemetryToken(part));
	const sum = validParts ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
	const promptInputTokens = Number.isSafeInteger(sum) && sum <= MAX_TELEMETRY_NUMERIC_VALUE ? sum : 0;
	if (status !== "verified") {
		return { promptInputTokens, cacheReadShare: null, cacheWriteShare: null, cacheWriteStatusCode: 0 };
	}

	const normalizedProvider = provider.toLowerCase();
	let cacheWriteStatusCode: CacheWriteStatusCode = 0;
	if (apiKind === "openai-completions" && normalizedProvider === "deepseek") {
		cacheWriteStatusCode = 1;
	} else if (
		apiKind === "openai-responses"
		|| apiKind === "azure-openai-responses"
		|| apiKind === "openai-codex-responses"
	) {
		cacheWriteStatusCode = 2;
	}
	if (promptInputTokens <= 0) {
		return { promptInputTokens, cacheReadShare: null, cacheWriteShare: null, cacheWriteStatusCode };
	}
	return {
		promptInputTokens,
		cacheReadShare: usage.cacheRead / promptInputTokens,
		cacheWriteShare: cacheWriteStatusCode === 2 ? usage.cacheWrite / promptInputTokens : null,
		cacheWriteStatusCode,
	};
}

/**
 * Combine request-level semantic statuses for an aggregate. The least
 * trustworthy status always wins: unverified > partial > verified.
 */
export function combineUsageSemanticStatus(
	current: UsageSemanticStatus | null,
	next: UsageSemanticStatus,
): UsageSemanticStatus {
	if (current === "unverified" || next === "unverified") return "unverified";
	if (current === "partial" || next === "partial") return "partial";
	return "verified";
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
