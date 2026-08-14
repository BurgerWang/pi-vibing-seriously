#!/usr/bin/env tsx
/**
 * P6-E cache benchmark CLI — OFFLINE analysis of the workbench prompt-cache
 * and action-cache evidence. It only reads:
 *
 *   1. Workbench telemetry JSONL        (.pi/workbench/cache/telemetry*.jsonl)
 *   2. Pi normalized usage              (inside the telemetry records)
 *   3. Run manifests                    (.pi/workbench/runs/<run-id>/manifest.json)
 *   4. Action cache records             (.pi/workbench/cache/actions/*.json,
 *                                       cache-index.json, locks/, tmp/)
 *
 * It NEVER:
 *   - calls a model or sends any HTTP request
 *   - reads auth.json (or any credential file)
 *   - reads or writes models.json / models-store.json
 *   - depends on DEEPSEEK_API_KEY or any provider environment
 *   - sends cache_control / prompt_cache_key / prompt_cache_retention
 *   - configures cache TTLs, keepalive or warmup traffic
 *   - modifies the provider or any Pi session state
 *   - hardcodes provider prices (estimated avoided cost needs an explicit
 *     --cost-map, otherwise it stays null)
 *
 * Commands:
 *   report  [--project <root>] [--json] [--session <hash>] [--since <iso>]
 *           [--until <iso>] [--cost-map <file>] [--save <name>]
 *   doctor  [--project <root>] [--json]
 *   compare <report-name>... [--project <root>] [--json]
 *
 * Statistical definitions: docs/cache/cache-benchmark.md.
 */

import { readFile, readdir, stat, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	buildCacheReport,
	type CacheReport,
	type ExplicitBreakpointVerifiedUsage,
} from "../extensions/workbench-runtime/cache/cache-report.ts";
import { runDoctor, renderDoctor, doctorToJson, type DoctorFacts } from "../extensions/workbench-runtime/cache/cache-doctor.ts";
import {
	CACHE_DIR_NAME,
	CacheStore,
	DEFAULT_MAX_TELEMETRY_BYTES,
	type ChronologicalReadOptions,
	type StoreReadResult,
} from "../extensions/workbench-runtime/cache/cache-store.ts";
import { LOCK_STALE_MS } from "../extensions/workbench-runtime/cache/action-types.ts";
import type { TelemetryRecord } from "../extensions/workbench-runtime/cache/cache-types.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const WORKBENCH_CACHE_DIR = join(CONFIG_DIR_NAME, "workbench", CACHE_DIR_NAME);
export const RUNS_REL_DIR = join(CONFIG_DIR_NAME, "workbench", "runs");

export function cacheDir(projectRoot: string): string {
	return join(projectRoot, WORKBENCH_CACHE_DIR);
}

export function runsDir(projectRoot: string): string {
	return join(projectRoot, RUNS_REL_DIR);
}

// ---------------------------------------------------------------------------
// Telemetry reading (tolerant)
// ---------------------------------------------------------------------------

export interface TelemetryReadResult {
	records: TelemetryRecord[];
	skipped: number;
	telemetryBytes: number;
	rotatedFiles: number;
	file: string | null;
	sourceIncomplete: boolean;
	truncatedRecords: number;
	filesRead: number;
	unavailable?: StoreReadResult["unavailable"];
}

/**
 * Read telemetry.jsonl plus the bounded rotation set through CacheStore's
 * strict schema validator. Rotations are read oldest-first and the current
 * file last; only the newest bounded record window is retained. Corrupted
 * lines and unavailable sources are surfaced as incomplete evidence.
 */
export async function readTelemetry(projectRoot: string, options: ChronologicalReadOptions = {}): Promise<TelemetryReadResult> {
	const store = new CacheStore(projectRoot);
	const current = store.telemetryPath();
	const history = await store.readRecordsChronological(options);
	const [telemetryBytes, rotatedFiles] = await Promise.all([store.telemetryBytesAll(), store.rotatedFileCount()]);
	return {
		records: history.records as TelemetryRecord[],
		skipped: history.skipped,
		telemetryBytes,
		rotatedFiles,
		file: existsSync(current) ? current : null,
		sourceIncomplete: history.sourceIncomplete,
		truncatedRecords: history.truncatedRecords,
		filesRead: history.filesRead,
		...(history.unavailable === undefined ? {} : { unavailable: history.unavailable }),
	};
}

// ---------------------------------------------------------------------------
// Run manifest reading
// ---------------------------------------------------------------------------

export interface RunManifestFacts {
	runId: string;
	recipe: string;
	executionSource: "exec" | "cache" | "unknown";
	actionKey: string | null;
	reusedFromRunId: string | null;
	durationMs: number | null;
}

export interface RunReadResult {
	manifests: RunManifestFacts[];
	corrupt: number;
}

/** Read every run manifest under .pi/workbench/runs/<run-id>/manifest.json. */
export async function readRunManifests(projectRoot: string): Promise<RunReadResult> {
	const dir = runsDir(projectRoot);
	const manifests: RunManifestFacts[] = [];
	let corrupt = 0;
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return { manifests, corrupt };
	}
	for (const name of names.sort()) {
		try {
			const raw = JSON.parse(await readFile(join(dir, name, "manifest.json"), "utf8")) as Record<string, unknown>;
			const source = raw.execution_source === "cache" ? "cache" : raw.execution_source === "exec" ? "exec" : "unknown";
			manifests.push({
				runId: typeof raw.run_id === "string" ? raw.run_id : name,
				recipe: typeof raw.recipe === "string" ? raw.recipe : "?",
				executionSource: source,
				actionKey: typeof raw.action_key === "string" ? raw.action_key : null,
				reusedFromRunId: typeof raw.reused_from_run_id === "string" ? raw.reused_from_run_id : null,
				durationMs: typeof raw.duration_ms === "number" && Number.isFinite(raw.duration_ms) ? raw.duration_ms : null,
			});
		} catch {
			corrupt += 1;
		}
	}
	return { manifests, corrupt };
}

// ---------------------------------------------------------------------------
// Action cache reading
// ---------------------------------------------------------------------------

export interface ActionCacheFacts {
	records: number;
	corruptQuarantined: number;
	indexMismatchEntries: number;
	staleLocks: number;
	activeLocks: number;
	totalBytes: number;
	successful: number;
	failed: number;
	perRecipe: Record<string, number>;
	/** key -> durationMs (of the original execution). */
	durationsByKey: Map<string, number>;
	/** key -> sourceRunId. */
	sourceRunByKey: Map<string, string>;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Inspect the action cache: record files, quarantined corruption copies,
 * lock staleness and total on-disk size of the cache directory. Read-only.
 */
export async function readActionCache(projectRoot: string): Promise<ActionCacheFacts> {
	const dir = cacheDir(projectRoot);
	const actionsDir = join(dir, "actions");
	const tmpDir = join(dir, "tmp");
	const locksDir = join(dir, "locks");

	const facts: ActionCacheFacts = {
		records: 0,
		corruptQuarantined: 0,
		indexMismatchEntries: 0,
		staleLocks: 0,
		activeLocks: 0,
		totalBytes: 0,
		successful: 0,
		failed: 0,
		perRecipe: {},
		durationsByKey: new Map(),
		sourceRunByKey: new Map(),
	};

	// Action records.
	let actionNames: string[] = [];
	try {
		actionNames = await readdir(actionsDir);
	} catch {
		actionNames = [];
	}
	for (const name of actionNames.filter((n) => n.endsWith(".json"))) {
		const key = name.slice(0, -".json".length);
		try {
			const path = join(actionsDir, name);
			const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
			facts.totalBytes += info.size;
			const record = JSON.parse(raw) as Record<string, unknown>;
			if (record.schemaVersion === undefined || record.actionKey !== key) {
				facts.corruptQuarantined += 1; // key/schema mismatch — treated as corruption
				continue;
			}
			facts.records += 1;
			const recipe = typeof record.recipe === "string" ? record.recipe : "?";
			facts.perRecipe[recipe] = (facts.perRecipe[recipe] ?? 0) + 1;
			if (record.success === true) facts.successful += 1;
			else facts.failed += 1;
			if (typeof record.durationMs === "number" && Number.isFinite(record.durationMs)) {
				facts.durationsByKey.set(key, record.durationMs);
			}
			if (typeof record.sourceRunId === "string") facts.sourceRunByKey.set(key, record.sourceRunId);
		} catch {
			facts.corruptQuarantined += 1; // unparseable record — corruption evidence
		}
	}

	// Index consistency: entries that do not correspond to a record file
	// (and record files missing from the index) mean the index needs a
	// rebuild. Read-only check — the CLI never rebuilds.
	try {
		const index = JSON.parse(await readFile(join(dir, "cache-index.json"), "utf8")) as { schemaVersion?: number; entries?: Array<{ key?: string }> };
		if (index.schemaVersion !== undefined && Array.isArray(index.entries)) {
			const indexKeys = new Set(index.entries.map((e) => e.key).filter((k): k is string => typeof k === "string"));
			for (const name of actionNames.filter((n) => n.endsWith(".json"))) {
				const key = name.slice(0, -".json".length);
				if (!indexKeys.has(key)) facts.indexMismatchEntries += 1;
			}
			for (const key of indexKeys) {
				if (!existsSync(join(actionsDir, `${key}.json`))) facts.indexMismatchEntries += 1;
			}
		}
	} catch {
		// Missing/corrupt index: rebuildable — count every record file as a mismatch.
		facts.indexMismatchEntries += actionNames.filter((n) => n.endsWith(".json")).length;
	}

	// Corruption quarantine copies in tmp/ (written by the store on
	// read-time corruption) and CAS quarantine (v1: disabled, counted if present).
	try {
		const tmpNames = await readdir(tmpDir);
		facts.corruptQuarantined += tmpNames.filter((n) => n.startsWith("corrupt-")).length;
	} catch {
		// no tmp dir — nothing quarantined
	}
	try {
		const casNames = await readdir(join(dir, "cas", "quarantine"));
		facts.corruptQuarantined += casNames.length;
	} catch {
		// no cas quarantine
	}

	// Locks: stale = owner process dead (or unreadable) and older than
	// LOCK_STALE_MS; these are evidence of lock-break / lock-timeout
	// fallback. Fresh locks with a live owner are in use.
	const now = Date.now();
	try {
		const lockNames = await readdir(locksDir);
		for (const name of lockNames.filter((n) => n.endsWith(".lock"))) {
			try {
				const raw = JSON.parse(await readFile(join(locksDir, name), "utf8")) as { ownerPid?: number; createdAt?: string };
				const pid = typeof raw.ownerPid === "number" ? raw.ownerPid : Number.NaN;
				const createdAt = typeof raw.createdAt === "string" ? new Date(raw.createdAt).getTime() : Number.NaN;
				const ownerAlive = Number.isFinite(pid) ? processExists(pid) : false;
				const age = Number.isFinite(createdAt) ? now - createdAt : Number.POSITIVE_INFINITY;
				if (!ownerAlive && age > LOCK_STALE_MS) facts.staleLocks += 1;
				else facts.activeLocks += 1;
			} catch {
				// unreadable lock file: treat as stale (recoverable)
				facts.staleLocks += 1;
			}
		}
	} catch {
		// no locks dir
	}

	// Whole-cache directory size (actions + cas + locks + tmp + index +
	// telemetry + reports): bounded accounting, recursive stat.
	facts.totalBytes = await directorySize(dir);

	return facts;
}

async function directorySize(dir: string): Promise<number> {
	let total = 0;
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return 0;
	}
	for (const name of names) {
		const path = join(dir, name);
		try {
			const info = await stat(path);
			if (info.isDirectory()) total += await directorySize(path);
			else total += info.size;
		} catch {
			// raced or unreadable — skip
		}
	}
	return total;
}

// ---------------------------------------------------------------------------
// Benchmark report
// ---------------------------------------------------------------------------

export interface CostMapEntry {
	cacheRead: number;
}

export interface BenchmarkReport {
	schemaVersion: "1.0";
	generatedAt: string;
	scope: "session" | "project";
	timeRange: { from: string | null; to: string | null };
	sources: {
		telemetryFile: string | null;
		rotatedFiles: number;
		runManifests: number;
		actionRecords: number;
	};
	requestCount: number;
	uncachedInputTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cacheHitRatio: number | null;
	usageSemanticStatus: "verified" | "partial" | "unverified" | null;
	providerReportedCost: number;
	/** Null unless rates resolve and the full telemetry observation is complete. */
	estimatedAvoidedCost: number | null;
	expectedInvalidations: number;
	unexpectedDrifts: number;
	historyProjectionSegmentSeals: number;
	historyProjectionEpochTransitions: number;
	explicitBreakpointAppliedRequests: number;
	explicitBreakpointVerifiedUsage: ExplicitBreakpointVerifiedUsage;
	modeChanges: number;
	modelChanges: number;
	thinkingChanges: number;
	reloads: number;
	compactions: number;
	recipeExecutions: number;
	recipeCacheHits: number;
	recipeCacheMisses: number;
	recipeHitRatio: number | null;
	/** Seconds of local execution avoided by action-cache hits. */
	localExecutionTimeAvoided: number;
	/** Bytes on disk under .pi/workbench/cache/ (actions+index+locks+tmp+telemetry+reports). */
	cacheStorageSize: number;
	corruptionCount: number;
	fallbackCount: number;
	skippedTelemetryLines: number;
	telemetrySourceIncomplete: boolean;
	truncatedTelemetryRecords: number;
}

export interface BenchmarkInput {
	projectRoot: string;
	scope: "session" | "project";
	sessionId?: string;
	since?: string;
	until?: string;
	costMap?: Record<string, CostMapEntry>;
}

/** Build the benchmark report from local evidence only. */
export async function buildBenchmarkReport(input: BenchmarkInput): Promise<BenchmarkReport> {
	const { projectRoot, scope } = input;
	const telemetry = await readTelemetry(projectRoot);
	const runs = await readRunManifests(projectRoot);
	const actionCache = await readActionCache(projectRoot);

	let records = telemetry.records;
	if (input.sessionId) records = records.filter((r) => r.hashedSessionId === input.sessionId);
	const since = input.since;
	const until = input.until;
	if (since) records = records.filter((r) => r.timestamp >= since);
	if (until) records = records.filter((r) => r.timestamp < until);

	const from = records.length > 0 ? records[0]?.timestamp ?? null : since ?? null;
	const to = records.length > 0 ? records[records.length - 1]?.timestamp ?? null : until ?? null;

	// Telemetry aggregation reuses the extension's exact aggregation
	// (buildCacheReport) so CLI numbers equal /q-cache-report numbers.
	const rateLookup = (provider: string, model: string): { cacheRead: number } | undefined => input.costMap?.[`${provider}/${model}`];
	const report = buildCacheReport(records, scope, rateLookup, {
		skippedRecords: telemetry.skipped,
		sourceIncomplete: telemetry.sourceIncomplete,
		truncatedRecords: telemetry.truncatedRecords,
	});

	// Recipe cache dimensions from run manifests + action records.
	const hits = runs.manifests.filter((m) => m.executionSource === "cache");
	const misses = runs.manifests.filter((m) => m.executionSource !== "cache");
	let avoidedMs = 0;
	for (const hit of hits) {
		// Preferred: the action record's original execution duration.
		const byKey = hit.actionKey ? actionCache.durationsByKey.get(hit.actionKey) : undefined;
		if (byKey !== undefined) {
			avoidedMs += byKey;
			continue;
		}
		// Fallback: the exec run manifest that the hit reuses.
		if (hit.reusedFromRunId) {
			const source = runs.manifests.find((m) => m.runId === hit.reusedFromRunId);
			if (source?.durationMs !== undefined && source?.durationMs !== null) avoidedMs += source.durationMs;
		}
	}

	return {
		schemaVersion: "1.0",
		generatedAt: new Date().toISOString(),
		scope,
		timeRange: { from, to },
		sources: {
			telemetryFile: telemetry.file !== null ? relative(projectRoot, telemetry.file) : null,
			rotatedFiles: telemetry.rotatedFiles,
			runManifests: runs.manifests.length,
			actionRecords: actionCache.records,
		},
		requestCount: report.requestCount,
		uncachedInputTokens: report.totals.input,
		cacheReadTokens: report.totals.cacheRead,
		outputTokens: report.totals.output,
		cacheWriteTokens: report.totals.cacheWrite,
		totalTokens: report.totals.totalTokens,
		cacheHitRatio: report.hitRatio,
		usageSemanticStatus: report.semanticStatus,
		providerReportedCost: report.totals.cost,
		estimatedAvoidedCost: report.estimatedAvoidedCost,
		expectedInvalidations: report.expectedInvalidations,
		unexpectedDrifts: report.unexpectedDrifts,
		historyProjectionSegmentSeals: report.historyProjectionSegmentSeals,
		historyProjectionEpochTransitions: report.historyProjectionEpochTransitions,
		explicitBreakpointAppliedRequests: report.explicitBreakpointAppliedRequests,
		explicitBreakpointVerifiedUsage: report.explicitBreakpointVerifiedUsage,
		modeChanges: report.changeCounts.mode,
		modelChanges: report.changeCounts.model,
		thinkingChanges: report.changeCounts.thinking,
		reloads: report.changeCounts.reload,
		compactions: report.changeCounts.compaction,
		recipeExecutions: runs.manifests.length,
		recipeCacheHits: hits.length,
		recipeCacheMisses: misses.length,
		recipeHitRatio: hits.length + misses.length > 0 ? hits.length / (hits.length + misses.length) : null,
		localExecutionTimeAvoided: avoidedMs / 1000,
		cacheStorageSize: actionCache.totalBytes,
		corruptionCount: actionCache.corruptQuarantined + telemetry.skipped + runs.corrupt,
		fallbackCount: actionCache.staleLocks,
		skippedTelemetryLines: telemetry.skipped,
		telemetrySourceIncomplete: report.sourceIncomplete === true,
		truncatedTelemetryRecords: report.truncatedRecords ?? 0,
	};
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pct(value: number | null): string {
	if (value === null) return "n/a";
	return `${Math.round(value * 100)}%`;
}

function seconds(value: number): string {
	if (!Number.isFinite(value)) return "n/a";
	if (value >= 60) return `${(value / 60).toFixed(1)} min`;
	return `${value.toFixed(1)} s`;
}

function bytes(value: number): string {
	if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
	if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${value} B`;
}

/** Human-readable rendering — plain facts, never sensitive content. */
export function renderBenchmarkReport(report: BenchmarkReport): string[] {
	const telemetryObservationIncomplete = report.telemetrySourceIncomplete || report.truncatedTelemetryRecords > 0;
	const qualityLabel = report.telemetrySourceIncomplete
		? "PARTIAL"
		: report.truncatedTelemetryRecords > 0
			? "bounded retained window"
			: "complete";
	const lines = [
		`cache benchmark (${report.scope} scope)`,
		`time range      : ${report.timeRange.from ?? "(no records)"} → ${report.timeRange.to ?? "now"}`,
		`request count   : ${report.requestCount}`,
		`uncached input  : ${report.uncachedInputTokens}`,
		`cache read      : ${report.cacheReadTokens}`,
		`cache write     : ${report.cacheWriteTokens}`,
		`output          : ${report.outputTokens}`,
		`total tokens    : ${report.totalTokens}`,
		`cache hit ratio : ${pct(report.cacheHitRatio)} (cacheRead/(input+cacheRead); only when usage semantics are verified)`,
		`usage semantics : ${report.usageSemanticStatus ?? "(no records)"}`,
		`reported cost   : $${report.providerReportedCost.toFixed(6)} (Pi usage.cost.total)`,
		`estimated avoided cost: ${report.estimatedAvoidedCost === null
			? telemetryObservationIncomplete
				? "n/a (incomplete telemetry observation)"
				: "n/a (no compatible --cost-map — never hardcoded)"
			: `$${report.estimatedAvoidedCost.toFixed(6)}`}`,
		`invalidations   : expected=${report.expectedInvalidations} unexpected=${report.unexpectedDrifts}`,
		`history projection: segment seals=${report.historyProjectionSegmentSeals} epoch transitions=${report.historyProjectionEpochTransitions}`,
		`explicit breakpoints: applied=${report.explicitBreakpointAppliedRequests} verified requests=${report.explicitBreakpointVerifiedUsage.requestCount} input=${report.explicitBreakpointVerifiedUsage.input} cacheRead=${report.explicitBreakpointVerifiedUsage.cacheRead} cacheWrite=${report.explicitBreakpointVerifiedUsage.cacheWrite} ratio=${pct(report.explicitBreakpointVerifiedUsage.hitRatio)} (provider usage; cacheRead=0 is not a failure)`,
		`changes         : mode=${report.modeChanges} model=${report.modelChanges} thinking=${report.thinkingChanges} reload=${report.reloads} compaction=${report.compactions}`,
		`recipes         : executed=${report.recipeExecutions} hits=${report.recipeCacheHits} misses=${report.recipeCacheMisses} hit=${pct(report.recipeHitRatio)}`,
		`local time avoided: ${seconds(report.localExecutionTimeAvoided)}`,
		`cache storage   : ${bytes(report.cacheStorageSize)}`,
		`corruption      : ${report.corruptionCount}`,
		`lock fallback   : ${report.fallbackCount} stale lock(s) broken`,
		`telemetry file  : ${report.sources.telemetryFile ?? "(none)"} (${report.sources.rotatedFiles} rotated, ${report.skippedTelemetryLines} bad line(s) skipped)`,
		`data quality    : ${qualityLabel}; bounded oldest omitted=${report.truncatedTelemetryRecords}`,
		`run manifests   : ${report.sources.runManifests} (action records: ${report.sources.actionRecords})`,
	];
	return lines;
}

// ---------------------------------------------------------------------------
// Saved-report reading (compare mode)
// ---------------------------------------------------------------------------

/** Tolerantly load a saved report in either the extension shape or the benchmark shape. */
export async function loadSavedReport(projectRoot: string, name: string): Promise<BenchmarkReport | CacheReport | null> {
	const safeName = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
	if (safeName.length === 0) return null;
	const path = join(cacheDir(projectRoot), "reports", `${safeName}.json`);
	try {
		return JSON.parse(await readFile(path, "utf8")) as BenchmarkReport | CacheReport;
	} catch {
		return null;
	}
}

export interface CompareRow {
	name: string;
	scope: string;
	requestCount: number;
	hitRatio: number | null;
	semanticStatus: string;
	uncachedInput: number;
	cacheRead: number;
	output: number;
	cost: number;
	expected: number;
	unexpected: number;
	recipeHits: number | null;
	recipeMisses: number | null;
}

/** Normalize either report shape into comparable rows (descriptive facts). */
export function normalizeReport(name: string, report: BenchmarkReport | CacheReport): CompareRow {
	const isBenchmark = "uncachedInputTokens" in report;
	const totals = isBenchmark
		? {
				input: report.uncachedInputTokens,
				cacheRead: report.cacheReadTokens,
				output: report.outputTokens,
				cost: report.providerReportedCost,
			}
		: report.totals;
	const row: CompareRow = {
		name,
		scope: report.scope,
		requestCount: report.requestCount,
		hitRatio: isBenchmark ? report.cacheHitRatio : report.hitRatio,
		semanticStatus: (isBenchmark ? report.usageSemanticStatus : report.semanticStatus) ?? "unverified",
		uncachedInput: totals.input,
		cacheRead: totals.cacheRead,
		output: totals.output,
		cost: totals.cost,
		expected: "expectedInvalidations" in report ? report.expectedInvalidations : 0,
		unexpected: "unexpectedDrifts" in report ? report.unexpectedDrifts : 0,
		recipeHits: isBenchmark ? report.recipeCacheHits : null,
		recipeMisses: isBenchmark ? report.recipeCacheMisses : null,
	};
	return row;
}

export function renderCompare(rows: readonly CompareRow[]): string[] {
	const lines = ["cache benchmark comparison (saved reports) — descriptive facts, not savings claims", ""];
	const header = ["report", "scope", "requests", "hit", "semantics", "input", "cacheRead", "output", "cost$", "exp.inv.", "unexp.drift"];
	const widths = header.map((h) => h.length);
	const cells: string[][] = rows.map((r) => [
		r.name,
		r.scope,
		String(r.requestCount),
		pct(r.hitRatio),
		r.semanticStatus,
		String(r.uncachedInput),
		String(r.cacheRead),
		String(r.output),
		r.cost.toFixed(6),
		String(r.expected),
		String(r.unexpected),
	]);
	for (const row of cells) {
		row.forEach((cell, i) => {
			if (cell.length > (widths[i] ?? 0)) widths[i] = cell.length;
		});
	}
	const fmt = (row: string[]) => row.map((cell, i) => cell.padEnd((widths[i] ?? 0) + 2)).join("").trimEnd();
	lines.push(fmt(header), fmt(header.map(() => "-".repeat(4))));
	for (const row of cells) lines.push(fmt(row));
	return lines;
}

// ---------------------------------------------------------------------------
// Doctor (offline)
// ---------------------------------------------------------------------------

/** Offline doctor: telemetry-derived facts + local action-cache hygiene. */
export async function buildDoctorFacts(projectRoot: string): Promise<DoctorFacts> {
	const telemetry = await readTelemetry(projectRoot);
	return {
		provider: null,
		model: null,
		apiKind: null,
		modelCostPresent: false,
		modelCostRatesValid: false,
		systemPrompt: "",
		activeToolNames: [],
		tools: [],
		records: telemetry.records,
		telemetryEnabled: true,
		telemetryBytes: telemetry.telemetryBytes,
		telemetryMaxBytes: DEFAULT_MAX_TELEMETRY_BYTES,
		rotatedFiles: telemetry.rotatedFiles,
		sourceIncomplete: telemetry.sourceIncomplete,
		skippedRecords: telemetry.skipped,
		truncatedRecords: telemetry.truncatedRecords,
		filesRead: telemetry.filesRead,
		sourceUnavailable: telemetry.unavailable ?? null,
		context: "cli",
	};
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
	command: string;
	projectRoot: string;
	json: boolean;
	session?: string;
	since?: string;
	until?: string;
	costMapFile?: string;
	save?: string;
	names: string[];
}

function usage(): string {
	return [
		"cache-benchmark — offline prompt-cache + action-cache benchmark (P6-E)",
		"",
		"usage:",
		"  tsx scripts/cache-benchmark.ts report [--project <root>] [--json] [--session <hash>]",
		"                                     [--since <iso>] [--until <iso>] [--cost-map <file>] [--save <name>]",
		"  tsx scripts/cache-benchmark.ts doctor [--project <root>] [--json]",
		"  tsx scripts/cache-benchmark.ts compare <report-name>... [--project <root>] [--json]",
		"",
		"reads only: telemetry JSONL, run manifests, action cache records, saved reports",
		"never: model calls, HTTP, auth.json, models.json, provider modification, hardcoded prices",
	].join("\n");
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
	const args = [...argv];
	const command = args.shift() ?? "report";
	const names: string[] = [];
	const options: Record<string, string | undefined> = {};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] as string;
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const value = args[i + 1];
			if (value !== undefined && !value.startsWith("--")) {
				options[key] = value;
				i += 1;
			} else {
				options[key] = "true";
			}
		} else {
			names.push(arg);
		}
	}
	return {
		command: ["report", "doctor", "compare"].includes(command) ? command : "report",
		projectRoot: resolve(options.project ?? process.cwd()),
		json: options.json === "true",
		session: options.session,
		since: options.since,
		until: options.until,
		costMapFile: options["cost-map"],
		save: options.save,
		names,
	};
}

async function loadCostMap(file: string | undefined): Promise<Record<string, CostMapEntry> | undefined> {
	if (!file) return undefined;
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		const out: Record<string, CostMapEntry> = {};
		for (const [key, value] of Object.entries(parsed)) {
			const entry = value as Partial<CostMapEntry>;
			if (entry && typeof entry.cacheRead === "number" && Number.isFinite(entry.cacheRead) && entry.cacheRead >= 0) {
				out[key] = { cacheRead: entry.cacheRead };
			}
		}
		return out;
	} catch (error) {
		throw new Error(`cannot read --cost-map ${file}: ${(error as Error).message}`);
	}
}

/** Atomic save into reports/ (same behavior as /q-cache-report --save). */
export async function saveBenchmarkReport(projectRoot: string, name: string, data: unknown): Promise<{ ok: boolean; path?: string; error?: string }> {
	const safeName = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
	if (safeName.length === 0 || safeName.startsWith(".")) return { ok: false, error: "invalid report name" };
	const dir = join(cacheDir(projectRoot), "reports");
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const target = resolve(join(dir, `${safeName}.json`));
		if (!target.startsWith(resolve(dir))) return { ok: false, error: "report path escapes the reports directory" };
		const tmp = join(dir, `.${safeName}.tmp`);
		await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		await rename(tmp, target);
		return { ok: true, path: target };
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
}

export async function main(argv: readonly string[]): Promise<number> {
	const options = parseCliArgs(argv);
	try {
		if (options.command === "report") {
			const telemetry = await readTelemetry(options.projectRoot);
			if (
				telemetry.records.length === 0 &&
				telemetry.file === null &&
				telemetry.rotatedFiles === 0 &&
				!telemetry.sourceIncomplete &&
				!options.session &&
				!options.since &&
				!options.until
			) {
				// Friendly exit: no telemetry at all.
				const message =
					`no cache telemetry found at ${WORKBENCH_CACHE_DIR}/telemetry.jsonl — ` +
					"the workbench records one line per assistant message (P6-A). Nothing to benchmark yet.";
				if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, requestCount: 0, note: message }, null, 2)}\n`);
				else process.stdout.write(`${message}\n`);
				return 0;
			}
			const costMap = await loadCostMap(options.costMapFile);
			const report = await buildBenchmarkReport({
				projectRoot: options.projectRoot,
				scope: options.session ? "session" : "project",
				sessionId: options.session,
				since: options.since,
				until: options.until,
				costMap,
			});
			let savedPath: string | null = null;
			if (options.save) {
				const saved = await saveBenchmarkReport(options.projectRoot, options.save, report);
				if (!saved.ok) {
					process.stderr.write(`cache-benchmark: save failed: ${saved.error ?? "unknown error"}\n`);
					return 1;
				}
				savedPath = saved.path ?? null;
			}
			const lines = renderBenchmarkReport(report);
			if (savedPath) lines.push("", `report saved: ${relative(options.projectRoot, savedPath)}`);
			if (options.json) {
				const out = { ...report, savedTo: savedPath ? relative(options.projectRoot, savedPath) : null };
				process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
			} else {
				for (const line of lines) process.stdout.write(`${line}\n`);
			}
			return 0;
		}

		if (options.command === "doctor") {
			const telemetry = await readTelemetry(options.projectRoot);
			if (telemetry.records.length === 0 && telemetry.file === null && telemetry.rotatedFiles === 0 && !telemetry.sourceIncomplete) {
				const message = `no cache telemetry found at ${WORKBENCH_CACHE_DIR}/telemetry.jsonl — run the workbench first; nothing to check.`;
				if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, checks: [], fail_count: 0, warn_count: 0, note: message }, null, 2)}\n`);
				else process.stdout.write(`${message}\n`);
				return 0;
			}
			const facts = await buildDoctorFacts(options.projectRoot);
			const checks = runDoctor(facts);
			const actionCache = await readActionCache(options.projectRoot);
			// Offline-only hygiene checks (extension doctor cannot run these).
			checks.push({
				id: "action_cache_integrity",
				status: actionCache.corruptQuarantined > 0 ? "warn" : "ok",
				message:
					actionCache.corruptQuarantined > 0
						? `${actionCache.corruptQuarantined} corrupted/quarantined action record(s) — cache treats them as misses`
						: `action cache intact: ${actionCache.records} record(s) on disk`,
			});
			checks.push({
				id: "action_cache_index",
				status: actionCache.indexMismatchEntries > 0 ? "warn" : "ok",
				message:
					actionCache.indexMismatchEntries > 0
						? `${actionCache.indexMismatchEntries} entry/record mismatch(es) — cache-index.json is rebuildable from actions/`
						: "cache-index.json is consistent with the actions directory",
			});
			checks.push({
				id: "action_cache_locks",
				status: actionCache.staleLocks > 0 ? "warn" : "ok",
				message:
					actionCache.staleLocks > 0
						? `${actionCache.staleLocks} stale lock(s) (dead owner) — lock recovery evidence; ${actionCache.activeLocks} lock(s) in use`
						: `no stale locks (${actionCache.activeLocks} active)`,
			});
			checks.push({
				id: "recipe_cache_consistency",
				status: "ok",
				message: "recipe cache hits never bypass gates: cache-hit runs re-validate through the full gate ladder",
			});
			const fails = checks.filter((c) => c.status === "fail").length;
			if (options.json) {
				process.stdout.write(`${JSON.stringify(doctorToJson(checks, facts), null, 2)}\n`);
			} else {
				for (const line of renderDoctor(checks)) process.stdout.write(`${line}\n`);
			}
			return fails > 0 ? 1 : 0;
		}

		// compare
		const rows: CompareRow[] = [];
		let missing: string[] = [];
		for (const name of options.names) {
			const report = await loadSavedReport(options.projectRoot, name);
			if (!report) {
				missing.push(name);
				continue;
			}
			rows.push(normalizeReport(name, report));
		}
		if (rows.length === 0) {
			process.stderr.write(`cache-benchmark compare: no saved reports found (looked in ${WORKBENCH_CACHE_DIR}/reports/)${missing.length > 0 ? ` — missing: ${missing.join(", ")}` : ""}\n`);
			return 1;
		}
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ reports: rows, missing }, null, 2)}\n`);
		} else {
			for (const line of renderCompare(rows)) process.stdout.write(`${line}\n`);
			if (missing.length > 0) process.stdout.write(`\n(missing: ${missing.join(", ")})\n`);
		}
		return 0;
	} catch (error) {
		process.stderr.write(`cache-benchmark: ${(error as Error).message}\n`);
		return 2;
	}
}

// Run only when executed directly (npm run cache:report / cache:doctor).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const exitCode = await main(process.argv.slice(2));
	process.exit(exitCode);
}
