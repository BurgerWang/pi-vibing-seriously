/**
 * P6-A cache reports — aggregation over telemetry records and text/JSON
 * rendering for /q-cache-status and /q-cache-report.
 *
 * Facts come from the telemetry records only; renderers never recompute
 * anything that is not in the records. The estimated avoided cost is
 * computed ONLY when the model registry provides compatible cost metadata
 * for every record involved (same USD-per-1M-token rates Pi itself uses for
 * usage.cost) — otherwise it stays null.
 */

import { cacheHitRatioFromTotals, type TelemetryRecord, type UsageSemanticStatus } from "./cache-types.ts";
import { invalidationClass } from "./invalidation-classifier.ts";
import type { CacheSnapshot } from "./cache-telemetry.ts";
import { formatNumber } from "../core/format.ts";

/** Rate lookup compatible with Pi's model registry cost metadata. */
export interface RateLookup {
	(provider: string, model: string): { cacheRead: number } | undefined;
}

export type ReportScope = "session" | "project";

export interface CacheReport {
	scope: ReportScope;
	schemaVersion: string;
	generatedAt: string;
	requestCount: number;
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
	estimatedAvoidedCost: number | null;
	skippedRecords: number;
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

/**
 * Aggregate telemetry records into a report. Records must be in
 * chronological order (the JSONL file order).
 */
export function buildCacheReport(records: readonly TelemetryRecord[], scope: ReportScope, rateLookup: RateLookup): CacheReport {
	const totals = { input: 0, cacheRead: 0, output: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	let semantic: UsageSemanticStatus | null = null;
	let estimatedAvoidedCost: number | null = 0;
	let ratesReliable = true;

	for (const record of records) {
		totals.input += record.usage.input;
		totals.cacheRead += record.usage.cacheRead;
		totals.output += record.usage.output;
		totals.cacheWrite += record.usage.cacheWrite;
		totals.totalTokens += record.usage.totalTokens;
		totals.cost += record.usage.cost;
		if (record.usageSemanticStatus === "unverified") semantic = "unverified";
		else if (record.usageSemanticStatus === "partial" && semantic === null) semantic = "partial";
		else if (semantic === null) semantic = "verified";

		// Estimated avoided cost: only when the registry gives a compatible
		// rate for THIS record's provider/model. One unknown rate voids the
		// whole estimate (strict — the report never guesses).
		if (ratesReliable) {
			const rate = rateLookup(record.provider, record.model);
			if (!rate || !Number.isFinite(rate.cacheRead) || rate.cacheRead < 0) {
				ratesReliable = false;
				estimatedAvoidedCost = null;
			} else {
				estimatedAvoidedCost = (estimatedAvoidedCost ?? 0) + (record.usage.cacheRead * rate.cacheRead) / 1_000_000;
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

	for (let i = 0; i < records.length; i += 1) {
		const record = records[i] as TelemetryRecord;
		if (record.inferredInvalidationReason === "PACKAGE_RELOADED") reloads += 1;
		if (record.inferredInvalidationReason === "COMPACTION") compactions += 1;
		const klass = invalidationClass(record.inferredInvalidationReason);
		if (klass === "expected") expectedInvalidations += 1;
		else if (klass === "unexpected") unexpectedDrifts += 1;
		invalidationCounts[record.inferredInvalidationReason] = (invalidationCounts[record.inferredInvalidationReason] ?? 0) + 1;
		const previous = records[i - 1];
		if (!previous) continue;
		if (previous.model !== record.model) modelChanges += 1;
		if (previous.thinkingLevel !== null && record.thinkingLevel !== null && previous.thinkingLevel !== record.thinkingLevel) {
			thinkingChanges += 1;
		}
		if (previous.workbenchMode !== record.workbenchMode) modeChanges += 1;
		// P6-B: same-mode mutation — invalidated while the mode stayed the same.
		if (previous.workbenchMode === record.workbenchMode && klass === "unexpected") sameModeMutationCount += 1;
	}

	const hitRatio = records.length > 0 ? cacheHitRatioFromTotals(totals) : null;

	return {
		scope,
		schemaVersion: records[0]?.schemaVersion ?? "1.1",
		generatedAt: new Date().toISOString(),
		requestCount: records.length,
		byMode: countBy(records, (r) => r.workbenchMode),
		byModel: countBy(records, (r) => `${r.provider}/${r.model}`),
		totals,
		hitRatio,
		semanticStatus: records.length === 0 ? null : semantic,
		changeCounts: { model: modelChanges, thinking: thinkingChanges, mode: modeChanges, reload: reloads, compaction: compactions },
		invalidationCounts,
		expectedInvalidations,
		unexpectedDrifts,
		sameModeMutationCount,
		estimatedAvoidedCost: records.length === 0 ? null : estimatedAvoidedCost,
		skippedRecords: 0,
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

/** Render the /q-cache-status output. */
export function renderCacheStatus(snapshot: CacheSnapshot): string[] {
	const s = snapshot;
	const status = s.semanticStatus ?? "unverified";
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
		`hit ratio       : ${pct(s.hitRatio)} (cacheRead / (input + cacheRead))`,
		`usage semantics : ${status}${status === "verified" ? "" : " — hit ratio not computed (workbench does not guess)"}`,
		`last invalidation: ${s.lastInvalidationReason ?? "(none)"} (inferred, ${s.lastInvalidationConfidence ?? "n/a"} confidence)`,
		`telemetry file  : ${s.telemetryFile ?? "(not written yet)"}`,
		`session id      : ${s.hashedSessionId} (hashed)`,
	];
}

/** Render the /q-cache-report output. */
export function renderCacheReport(report: CacheReport): string[] {
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
		`changes          : model=${report.changeCounts.model} thinking=${report.changeCounts.thinking} mode=${report.changeCounts.mode} reload=${report.changeCounts.reload} compaction=${report.changeCounts.compaction}`,
		`invalidations    : ${countsLine(report.invalidationCounts)}`,
		`expected         : ${report.expectedInvalidations} (mode/model/thinking/reload/new-session/compaction/provider-miss)`,
		`unexpected drift : ${report.unexpectedDrifts} (same-mode UNEXPECTED_DRIFT / context prefix divergence)`,
		`same-mode mutat. : ${report.sameModeMutationCount} (context prefix changed while the mode stayed the same)`,
		`estimated avoided cost: ${usd(report.estimatedAvoidedCost)} (registry cacheRead rate, USD per 1M tokens)`,
	];
	return lines;
}
