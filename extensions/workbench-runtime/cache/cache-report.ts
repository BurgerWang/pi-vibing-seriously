/**
 * P6-A cache reports — aggregation over telemetry records and text/JSON
 * rendering for /q-cache-status and /q-cache-report.
 *
 * Facts come from the telemetry records only; renderers never recompute
 * anything that is not in the records. The estimated avoided cost is
 * computed ONLY when the model registry provides compatible cost metadata
 * for every record involved (same USD-per-1M-token rates Pi itself uses for
 * usage.cost) and the telemetry observation is complete. Missing, corrupt,
 * or intentionally truncated evidence leaves the estimate null.
 */

import {
	cacheHitRatioFromTotals,
	combineUsageSemanticStatus,
	isTelemetryRecord,
	TELEMETRY_SCHEMA_VERSION,
	type TelemetryRecord,
	type UsageSemanticStatus,
} from "./cache-types.ts";
import { invalidationClass } from "./invalidation-classifier.ts";
import type { CacheSnapshot } from "./cache-telemetry.ts";
import { formatNumber } from "../core/format.ts";

const TELEMETRY_WRITE_GAP_EVENT = "telemetry_write_gap";
const EXPLICIT_PROMPT_CACHE_BREAKPOINTS_APPLIED_EVENT = "explicit_prompt_cache_breakpoints_applied";

function isPublicOpenAiExplicitBreakpointEligible(record: TelemetryRecord): boolean {
	return record.provider === "openai"
		&& record.apiKind === "openai-responses"
		&& (record.model === "gpt-5.6" || record.model.startsWith("gpt-5.6-"));
}

/** Numeric provider-usage facts for successful applied requests whose semantics are verified. */
export interface ExplicitBreakpointVerifiedUsage {
	requestCount: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	hitRatio: number | null;
}

/** Rate lookup compatible with Pi's model registry cost metadata. */
export interface RateLookup {
	(provider: string, model: string): { cacheRead: number } | undefined;
}

export type ReportScope = "session" | "project";

/** Numeric data-quality code for schema-1.3 read/write shares. */
export type CacheShareStatusCode =
	| 0 // unobserved / empty cohort
	| 1 // available from complete, verified, all-1.3 disjoint totals
	| 2 // mixed legacy and 1.3 rows
	| 3 // partial source or schema-invalid input
	| 4 // bounded/truncated retained window
	| 5 // provider usage semantics not verified
	| 6 // cache-write semantics unavailable or unverified
	| 7; // exact aggregate exceeds the bounded numeric publication surface

export interface CacheUsageCohort {
	requestCount: number;
	promptInputTokens: number;
	uncachedInputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheReadShare: number | null;
	cacheWriteShare: number | null;
	cacheReadShareStatusCode: CacheShareStatusCode;
	cacheWriteShareStatusCode: CacheShareStatusCode;
	cacheWriteUnverifiedRequests: number;
	cacheWriteUnavailableRequests: number;
	cacheWriteNormalizedRequests: number;
	cacheWriteNormalizedZeroRequests: number;
	cacheWritePresenceVerifiedRequests: number;
}

/** Schema-1.3 observability facts only: numeric totals and stable enum codes. */
export interface CacheObservabilityReport {
	correlationCounts: {
		unwired: number;
		exact: number;
		multipleOrStale: number;
		missing: number;
	};
	localObservedRequests: number;
	nonFinalObservedRequests: number;
	wholeItemLcp: {
		eligibleRequests: number;
		itemCount: number;
		utf8Bytes: number;
	};
	projection: {
		observedRequests: number;
		eventCounts: Record<string, number>;
		causeCounts: Record<string, number>;
		byteOverflowRequests: number;
		bundleOverflowRequests: number;
	};
	retainedWindowUsage: CacheUsageCohort;
	actorCohorts: {
		unknown: CacheUsageCohort;
		commander: CacheUsageCohort;
		worker: CacheUsageCohort;
	};
	projectionCohorts: {
		segmentSeal: CacheUsageCohort;
		epochTransition: CacheUsageCohort;
	};
}

export interface CacheReport {
	scope: ReportScope;
	schemaVersion: string;
	generatedAt: string;
	requestCount: number;
	/** Count of strict schema-1.3 rows in this retained source. */
	schema13Rows: number;
	/** Null means schema-1.3 facts were not observed; it never means zero. */
	observability: CacheObservabilityReport | null;
	byMode: Record<string, number>;
	byModel: Record<string, number>;
	totals: {
		input: number;
		cacheRead: number;
		output: number;
		cacheWrite: number;
		totalTokens: number;
		cost: number;
	};
	hitRatio: number | null;
	semanticStatus: UsageSemanticStatus | null;
	changeCounts: {
		model: number;
		thinking: number;
		mode: number;
		reload: number;
		compaction: number;
	};
	invalidationCounts: Record<string, number>;
	expectedInvalidations: number;
	unexpectedDrifts: number;
	/** P6-B: requests invalidated while the workbench mode did NOT change. */
	sameModeMutationCount: number;
	/** Same-epoch immutable projection-seal records in the retained observation. */
	historyProjectionSegmentSeals: number;
	/** Projection checkpoint/epoch-transition records in the retained observation. */
	historyProjectionEpochTransitions: number;
	/** Requests whose records say the public request carried explicit breakpoints. */
	explicitBreakpointAppliedRequests: number;
	/** Verified provider usage for the applied-request subset; never marker/hash/payload data. */
	explicitBreakpointVerifiedUsage: ExplicitBreakpointVerifiedUsage;
	/** Null unless rates resolve and the full telemetry observation is complete. */
	estimatedAvoidedCost: number | null;
	skippedRecords: number;
	/** True when one or more source records could not be read or parsed. */
	sourceIncomplete?: boolean;
	/** Oldest records intentionally omitted by a bounded chronological read. */
	truncatedRecords?: number;
}

export interface CacheReportQuality {
	skippedRecords?: number;
	sourceIncomplete?: boolean;
	truncatedRecords?: number;
}

function countBy<T>(items: readonly T[], key: (item: T) => string | null | undefined): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of items) {
		const k = key(item);
		if (k === null || k === undefined) continue;
		counts[k] = (counts[k] ?? 0) + 1;
	}
	return counts;
}

function addSafe(left: number, right: number): number {
	const sum = left + right;
	return Number.isSafeInteger(sum) && sum >= 0 ? sum : Number.MAX_SAFE_INTEGER;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function publishedBigInt(value: bigint): number {
	return value > MAX_SAFE_BIGINT ? Number.MAX_SAFE_INTEGER : Number(value);
}

function exactBigIntShare(numerator: bigint, denominator: bigint): number | null {
	if (denominator <= 0n) return null;
	// Callers only use this after proving every published total fits inside the
	// safe-integer surface, so both conversions are exact.
	return Number(numerator) / Number(denominator);
}

function shareStatus(
	rows: readonly TelemetryRecord[],
	allRowsAreV13: boolean,
	sourceIncomplete: boolean,
	truncatedRecords: number,
): CacheShareStatusCode {
	if (rows.length === 0) return 0;
	if (sourceIncomplete) return 3;
	if (truncatedRecords > 0) return 4;
	if (!allRowsAreV13) return 2;
	if (rows.some((row) => row.usageSemanticStatus !== "verified")) return 5;
	return 1;
}

function usageCohort(
	rows: readonly TelemetryRecord[],
	allRowsAreV13: boolean,
	sourceIncomplete: boolean,
	truncatedRecords: number,
): CacheUsageCohort {
	let input = 0n;
	let cacheRead = 0n;
	let cacheWrite = 0n;
	let writeUnverified = 0;
	let writeUnavailable = 0;
	let writeNormalized = 0;
	let writeNormalizedZero = 0;
	let writePresenceVerified = 0;
	for (const row of rows) {
		input += BigInt(row.usage.input);
		cacheRead += BigInt(row.usage.cacheRead);
		cacheWrite += BigInt(row.usage.cacheWrite);
		if (row.schemaVersion !== "1.3") continue;
		if (row.cacheWriteStatusCode === 1) writeUnavailable += 1;
		else if (row.cacheWriteStatusCode === 2) {
			writeNormalized += 1;
			if (row.usage.cacheWrite === 0) writeNormalizedZero += 1;
		} else if (row.cacheWriteStatusCode === 3) writePresenceVerified += 1;
		else writeUnverified += 1;
	}
	const promptInputTokens = input + cacheRead + cacheWrite;
	const aggregateOverflow = input > MAX_SAFE_BIGINT
		|| cacheRead > MAX_SAFE_BIGINT
		|| cacheWrite > MAX_SAFE_BIGINT
		|| promptInputTokens > MAX_SAFE_BIGINT;
	const baseReadStatus = shareStatus(rows, allRowsAreV13, sourceIncomplete, truncatedRecords);
	const readStatus: CacheShareStatusCode = aggregateOverflow ? 7 : baseReadStatus;
	const writeStatus: CacheShareStatusCode = readStatus !== 1
		? readStatus
		: writeUnavailable > 0 || writeUnverified > 0
			? 6
			: 1;
	return {
		requestCount: rows.length,
		promptInputTokens: publishedBigInt(promptInputTokens),
		uncachedInputTokens: publishedBigInt(input),
		cacheReadTokens: publishedBigInt(cacheRead),
		cacheWriteTokens: publishedBigInt(cacheWrite),
		cacheReadShare: readStatus === 1 ? exactBigIntShare(cacheRead, promptInputTokens) : null,
		cacheWriteShare: writeStatus === 1 ? exactBigIntShare(cacheWrite, promptInputTokens) : null,
		cacheReadShareStatusCode: readStatus,
		cacheWriteShareStatusCode: writeStatus,
		cacheWriteUnverifiedRequests: writeUnverified,
		cacheWriteUnavailableRequests: writeUnavailable,
		cacheWriteNormalizedRequests: writeNormalized,
		cacheWriteNormalizedZeroRequests: writeNormalizedZero,
		cacheWritePresenceVerifiedRequests: writePresenceVerified,
	};
}

function buildObservability(
	validRecords: readonly TelemetryRecord[],
	sourceIncomplete: boolean,
	truncatedRecords: number,
): { schema13Rows: number; observability: CacheObservabilityReport | null } {
	const rows = validRecords.filter((record) => record.schemaVersion === "1.3");
	if (rows.length === 0) return { schema13Rows: 0, observability: null };
	const correlationCounts = { unwired: 0, exact: 0, multipleOrStale: 0, missing: 0 };
	let localObservedRequests = 0;
	let nonFinalObservedRequests = 0;
	let eligibleRequests = 0;
	let itemCount = 0;
	let utf8Bytes = 0;
	let projectionObserved = 0;
	let byteOverflowRequests = 0;
	let bundleOverflowRequests = 0;
	const eventCounts: Record<string, number> = {};
	const causeCounts: Record<string, number> = {};
	const commander: TelemetryRecord[] = [];
	const worker: TelemetryRecord[] = [];
	const unknown: TelemetryRecord[] = [];
	const segmentSeal: TelemetryRecord[] = [];
	const epochTransition: TelemetryRecord[] = [];

	for (const row of rows) {
		if (row.requestCorrelationCode === 1) correlationCounts.exact += 1;
		else if (row.requestCorrelationCode === 2) correlationCounts.multipleOrStale += 1;
		else if (row.requestCorrelationCode === 3) correlationCounts.missing += 1;
		else correlationCounts.unwired += 1;
		if (row.actorRoleCode === 1) commander.push(row);
		else if (row.actorRoleCode === 2) worker.push(row);
		else unknown.push(row);

		const wire = row.wireObservation;
		if (wire !== null && wire !== undefined) {
			localObservedRequests += 1;
			if (wire.finalityCode === 0) nonFinalObservedRequests += 1;
			if (row.requestCorrelationCode === 1 && wire.digestStatusCode === 1) {
				eligibleRequests += 1;
				itemCount = addSafe(itemCount, wire.itemLcpCount);
				utf8Bytes = addSafe(utf8Bytes, wire.itemLcpUtf8Bytes);
			}
		}
		const projection = row.historyProjection;
		if (projection === null || projection === undefined) continue;
		projectionObserved += 1;
		const eventKey = String(projection.eventCode);
		const causeKey = String(projection.causeCode);
		eventCounts[eventKey] = (eventCounts[eventKey] ?? 0) + 1;
		causeCounts[causeKey] = (causeCounts[causeKey] ?? 0) + 1;
		if (projection.byteOverflow === 1) byteOverflowRequests += 1;
		if (projection.bundleOverflow === 1) bundleOverflowRequests += 1;
		if (projection.segmentSealed === 1) segmentSeal.push(row);
		if (projection.epochTransitioned === 1) epochTransition.push(row);
	}

	const allRowsAreV13 = rows.length === validRecords.length;
	const cohort = (selected: readonly TelemetryRecord[]) => usageCohort(selected, allRowsAreV13, sourceIncomplete, truncatedRecords);
	return {
		schema13Rows: rows.length,
		observability: {
			correlationCounts,
			localObservedRequests,
			nonFinalObservedRequests,
			wholeItemLcp: { eligibleRequests, itemCount, utf8Bytes },
			projection: { observedRequests: projectionObserved, eventCounts, causeCounts, byteOverflowRequests, bundleOverflowRequests },
			retainedWindowUsage: cohort(validRecords),
			actorCohorts: { unknown: cohort(unknown), commander: cohort(commander), worker: cohort(worker) },
			projectionCohorts: { segmentSeal: cohort(segmentSeal), epochTransition: cohort(epochTransition) },
		},
	};
}

/**
 * Aggregate telemetry records into a report. Records must be in
 * chronological order (the JSONL file order).
 */
export function buildCacheReport(
	records: readonly TelemetryRecord[],
	scope: ReportScope,
	rateLookup: RateLookup,
	quality: CacheReportQuality = {},
): CacheReport {
	const validRecords: TelemetryRecord[] = [];
	let invalidRecords = 0;
	for (const candidate of records as readonly unknown[]) {
		if (isTelemetryRecord(candidate)) validRecords.push(candidate);
		else invalidRecords += 1;
	}
	const totals = { input: 0, cacheRead: 0, output: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	let semantic: UsageSemanticStatus | null = null;
	let estimatedAvoidedCost: number | null = 0;
	let ratesReliable = true;
	let historyProjectionSegmentSeals = 0;
	let historyProjectionEpochTransitions = 0;
	let explicitBreakpointAppliedRequests = 0;
	const explicitBreakpointVerifiedTotals = { requestCount: 0, input: 0, cacheRead: 0, cacheWrite: 0 };

	for (const record of validRecords) {
		totals.input += record.usage.input;
		totals.cacheRead += record.usage.cacheRead;
		totals.output += record.usage.output;
		totals.cacheWrite += record.usage.cacheWrite;
		totals.totalTokens += record.usage.totalTokens;
		totals.cost += record.usage.cost;
		const recordSemantic = record.usageSemanticStatus === "verified" || record.usageSemanticStatus === "partial" || record.usageSemanticStatus === "unverified"
			? record.usageSemanticStatus
			: "unverified";
		semantic = combineUsageSemanticStatus(semantic, recordSemantic);
		if (record.inferredInvalidationReason === "HISTORY_PROJECTION_SEGMENT_SEALED") historyProjectionSegmentSeals += 1;
		if (record.inferredInvalidationReason === "HISTORY_PROJECTION_EPOCH_CHANGED") historyProjectionEpochTransitions += 1;
		if (record.precedingEvent === EXPLICIT_PROMPT_CACHE_BREAKPOINTS_APPLIED_EVENT) {
			explicitBreakpointAppliedRequests += 1;
			if (record.messageStatus === "ok" && recordSemantic === "verified" && isPublicOpenAiExplicitBreakpointEligible(record)) {
				explicitBreakpointVerifiedTotals.requestCount += 1;
				explicitBreakpointVerifiedTotals.input += record.usage.input;
				explicitBreakpointVerifiedTotals.cacheRead += record.usage.cacheRead;
				explicitBreakpointVerifiedTotals.cacheWrite += record.usage.cacheWrite;
			}
		}

		// Estimated avoided cost: only when the registry gives a compatible
		// rate for THIS record's provider/model. One unknown rate voids the
		// whole estimate (strict — the report never guesses).
		if (ratesReliable) {
			let rate: { cacheRead: number } | undefined;
			try {
				rate = rateLookup(record.provider, record.model);
			} catch {
				rate = undefined;
			}
			if (!rate || !Number.isFinite(rate.cacheRead) || rate.cacheRead < 0 || rate.cacheRead > Number.MAX_SAFE_INTEGER) {
				ratesReliable = false;
				estimatedAvoidedCost = null;
			} else {
				const nextEstimate: number = (estimatedAvoidedCost ?? 0) + (record.usage.cacheRead * rate.cacheRead) / 1_000_000;
				if (!Number.isFinite(nextEstimate)) {
					ratesReliable = false;
					estimatedAvoidedCost = null;
				} else {
					estimatedAvoidedCost = nextEstimate;
				}
			}
		}
	}

	let modelChanges = 0;
	let thinkingChanges = 0;
	let modeChanges = 0;
	let reloads = 0;
	let compactions = 0;
	let expectedInvalidations = 0;
	let unexpectedDrifts = 0;
	let sameModeMutationCount = 0;
	const invalidationCounts: Record<string, number> = {};

	for (let i = 0; i < validRecords.length; i += 1) {
		const record = validRecords[i] as TelemetryRecord;
		if (record.inferredInvalidationReason === "PACKAGE_RELOADED") reloads += 1;
		if (record.inferredInvalidationReason === "COMPACTION") compactions += 1;
		const klass = invalidationClass(record.inferredInvalidationReason);
		if (klass === "expected") expectedInvalidations += 1;
		else if (klass === "unexpected") unexpectedDrifts += 1;
		invalidationCounts[record.inferredInvalidationReason] = (invalidationCounts[record.inferredInvalidationReason] ?? 0) + 1;
		const previous = validRecords[i - 1];
		if (!previous) continue;
		if (previous.model !== record.model) modelChanges += 1;
		if (previous.thinkingLevel !== null && record.thinkingLevel !== null && previous.thinkingLevel !== record.thinkingLevel) {
			thinkingChanges += 1;
		}
		if (previous.workbenchMode !== record.workbenchMode) modeChanges += 1;
		// P6-B: same-mode mutation — invalidated while the mode stayed the same.
		if (previous.workbenchMode === record.workbenchMode && klass === "unexpected") sameModeMutationCount += 1;
	}

	const skippedRecords = Math.min(Number.MAX_SAFE_INTEGER, nonNegativeInteger(quality.skippedRecords) + invalidRecords);
	const telemetryWriteGapObserved = validRecords.some((record) => record.precedingEvent === TELEMETRY_WRITE_GAP_EVENT);
	const sourceIncomplete = quality.sourceIncomplete === true || skippedRecords > 0 || telemetryWriteGapObserved;
	const truncatedRecords = nonNegativeInteger(quality.truncatedRecords);
	const observationIncomplete = sourceIncomplete || truncatedRecords > 0;
	const observability = buildObservability(validRecords, sourceIncomplete, truncatedRecords);
	const hitRatio = validRecords.length > 0 && semantic === "verified" && !sourceIncomplete
		? cacheHitRatioFromTotals(totals)
		: null;
	const explicitBreakpointVerifiedHitRatio = explicitBreakpointVerifiedTotals.requestCount > 0 && !observationIncomplete
		? cacheHitRatioFromTotals(explicitBreakpointVerifiedTotals)
		: null;

	return {
		scope,
		schemaVersion: validRecords[0]?.schemaVersion ?? TELEMETRY_SCHEMA_VERSION,
		generatedAt: new Date().toISOString(),
		requestCount: validRecords.length,
		schema13Rows: observability.schema13Rows,
		observability: observability.observability,
		byMode: countBy(validRecords, (r) => r.workbenchMode),
		byModel: countBy(validRecords, (r) => `${r.provider}/${r.model}`),
		totals,
		hitRatio,
		semanticStatus: validRecords.length === 0 ? null : semantic,
		changeCounts: { model: modelChanges, thinking: thinkingChanges, mode: modeChanges, reload: reloads, compaction: compactions },
		invalidationCounts,
		expectedInvalidations,
		unexpectedDrifts,
		sameModeMutationCount,
		historyProjectionSegmentSeals,
		historyProjectionEpochTransitions,
		explicitBreakpointAppliedRequests,
		explicitBreakpointVerifiedUsage: {
			...explicitBreakpointVerifiedTotals,
			hitRatio: explicitBreakpointVerifiedHitRatio,
		},
		estimatedAvoidedCost: validRecords.length === 0 || observationIncomplete ? null : estimatedAvoidedCost,
		skippedRecords,
		sourceIncomplete,
		truncatedRecords,
	};
}

function pct(ratio: number | null): string {
	if (ratio === null) return "N/A";
	return `${Math.round(ratio * 100)}%`;
}

function usd(value: number | null): string {
	if (value === null) return "n/a (cost metadata missing or units unknown)";
	return `$${value.toFixed(6)}`;
}

function countsLine(counts: Record<string, number>): string {
	const entries = Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k}=${v}`);
	return entries.length > 0 ? entries.join(" ") : "(none)";
}

function nonNegativeInteger(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
	return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

/** Render the /q-cache-status output. */
export function renderCacheStatus(snapshot: CacheSnapshot): string[] {
	const s = snapshot;
	const lastStatus = s.lastRequestSemanticStatus ?? "unverified";
	const cumulativeStatus = s.cumulativeSemanticStatus ?? "unverified";
	return [
		`cache telemetry : ${s.enabled ? "enabled" : "disabled (project.yaml cache.telemetry: false)"}`,
		`provider        : ${s.provider ?? "(none observed yet)"}`,
		`model           : ${s.model ?? "(none observed yet)"}`,
		`api kind        : ${s.apiKind ?? "(unknown — not provided by model metadata)"}`,
		`mode            : ${s.mode ?? "(unknown)"}`,
		`thinking level  : ${s.thinkingLevel ?? "(unknown)"}`,
		`requests        : ${s.requestCount}`,
		`uncached input  : ${formatNumber(s.usage.input)}`,
		`cache read      : ${formatNumber(s.usage.cacheRead)}`,
		`cache write     : ${formatNumber(s.usage.cacheWrite)}`,
		`output          : ${formatNumber(s.usage.output)}`,
		`reported cost   : $${s.usage.cost.toFixed(6)} (Pi usage.cost.total)`,
		`last request ratio: ${pct(s.lastRequestHitRatio)} (last request only)`,
		`cumulative ratio : ${pct(s.cumulativeHitRatio)} (session cacheRead / (input + cacheRead))`,
		`usage semantics : last=${lastStatus} cumulative=${cumulativeStatus}${cumulativeStatus === "verified" ? "" : " — cumulative ratio not computed (workbench does not guess)"}`,
		`last invalidation: ${s.lastInvalidationReason ?? "(none)"} (inferred, ${s.lastInvalidationConfidence ?? "n/a"} confidence)`,
		`telemetry file  : ${s.telemetryFile ?? "(not written yet)"}`,
		`session id      : ${s.hashedSessionId} (hashed)`,
	];
}

/** Render the /q-cache-report output. */
export function renderCacheReport(report: CacheReport): string[] {
	const truncatedRecords = report.truncatedRecords ?? 0;
	const observationIncomplete = report.sourceIncomplete === true || truncatedRecords > 0;
	const qualityLabel = report.sourceIncomplete === true
		? `PARTIAL (skipped=${report.skippedRecords})`
		: truncatedRecords > 0
			? "bounded retained window"
			: "complete";
	const lines = [
		`scope            : ${report.scope}`,
		`requests         : ${report.requestCount}`,
		`by mode          : ${countsLine(report.byMode)}`,
		`by model         : ${countsLine(report.byModel)}`,
		`input (miss)     : ${formatNumber(report.totals.input)}`,
		`cache read       : ${formatNumber(report.totals.cacheRead)}`,
		`cache write      : ${formatNumber(report.totals.cacheWrite)}`,
		`output           : ${formatNumber(report.totals.output)}`,
		`total tokens     : ${formatNumber(report.totals.totalTokens)}`,
		`reported cost    : $${report.totals.cost.toFixed(6)} (Pi usage.cost.total)`,
		`hit ratio        : ${pct(report.hitRatio)}`,
		`usage semantics  : ${report.semanticStatus ?? "(no records)"}`,
		`data quality     : ${qualityLabel}; bounded oldest omitted=${truncatedRecords}`,
		`changes          : model=${report.changeCounts.model} thinking=${report.changeCounts.thinking} mode=${report.changeCounts.mode} reload=${report.changeCounts.reload} compaction=${report.changeCounts.compaction}`,
		`invalidations    : ${countsLine(report.invalidationCounts)}`,
		`expected         : ${report.expectedInvalidations} (mode/model/thinking/reload/new-session/compaction/session-tree/history-projection/provider-miss)`,
		`unexpected drift : ${report.unexpectedDrifts} (same-mode UNEXPECTED_DRIFT / context prefix divergence)`,
		`same-mode mutat. : ${report.sameModeMutationCount} (context prefix changed while the mode stayed the same)`,
		`history projection: segment seals=${report.historyProjectionSegmentSeals} epoch transitions=${report.historyProjectionEpochTransitions}`,
		`explicit breakpoints: applied=${report.explicitBreakpointAppliedRequests} verified requests=${report.explicitBreakpointVerifiedUsage.requestCount} input=${formatNumber(report.explicitBreakpointVerifiedUsage.input)} cacheRead=${formatNumber(report.explicitBreakpointVerifiedUsage.cacheRead)} cacheWrite=${formatNumber(report.explicitBreakpointVerifiedUsage.cacheWrite)} ratio=${pct(report.explicitBreakpointVerifiedUsage.hitRatio)} (provider usage; cacheRead=0 is not a failure)`,
		`estimated avoided cost: ${usd(report.estimatedAvoidedCost)} (${observationIncomplete ? "incomplete telemetry observation; full estimate unavailable" : "registry cacheRead rate, USD per 1M tokens"})`,
	];
	const observed = report.observability;
	lines.push(`schema 1.3      : rows=${report.schema13Rows} observed=${observed === null ? 0 : 1}`);
	if (observed !== null) {
		lines.push(
			`request correlation: unwired=${observed.correlationCounts.unwired} exact=${observed.correlationCounts.exact} multiple-or-stale=${observed.correlationCounts.multipleOrStale} missing=${observed.correlationCounts.missing}`,
			`local wire observation: requests=${observed.localObservedRequests} nonfinal=${observed.nonFinalObservedRequests} finalityCode=0`,
			`whole-item LCP  : eligible=${observed.wholeItemLcp.eligibleRequests} items=${observed.wholeItemLcp.itemCount} utf8Bytes=${observed.wholeItemLcp.utf8Bytes}`,
			`projection facts: observed=${observed.projection.observedRequests} events=${countsLine(observed.projection.eventCounts)} causes=${countsLine(observed.projection.causeCounts)} byteOverflow=${observed.projection.byteOverflowRequests} bundleOverflow=${observed.projection.bundleOverflowRequests}`,
			`v1.3 usage shares: read=${pct(observed.retainedWindowUsage.cacheReadShare)} readStatusCode=${observed.retainedWindowUsage.cacheReadShareStatusCode} write=${pct(observed.retainedWindowUsage.cacheWriteShare)} writeStatusCode=${observed.retainedWindowUsage.cacheWriteShareStatusCode}`,
			`actor cohorts   : unknown=${observed.actorCohorts.unknown.requestCount} commander=${observed.actorCohorts.commander.requestCount} worker=${observed.actorCohorts.worker.requestCount}`,
			`projection cohorts: segmentSeal=${observed.projectionCohorts.segmentSeal.requestCount} epochTransition=${observed.projectionCohorts.epochTransition.requestCount}`,
		);
	}
	return lines;
}
