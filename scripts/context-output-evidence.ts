/**
 * Offline, replayable context-output stress/benchmark measurements.
 *
 * This module is deliberately side-effect free on import. Callers supply a
 * temporary root; every generated fixture lives below it and is removed by
 * the caller. No network provider or model is contacted: the worker scenario
 * runs a real Pi AgentSession against a deterministic local provider, then
 * transports only its actual bounded events through the runner's child seam.
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CONFIG_DIR_NAME, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";

import { classifyInvalidation, invalidationClass } from "../extensions/workbench-runtime/cache/invalidation-classifier.ts";

import { compareRuns } from "../extensions/workbench-runtime/core/compare.ts";
import {
	COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
	HISTORY_DESCRIPTOR_MAX_BYTES,
	HISTORY_MAX_BUNDLES,
	HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES,
	HISTORY_PROJECTION_ENTRY_TYPE,
	HISTORY_PROJECTION_MAX_SEGMENTS,
	HISTORY_PROJECTION_SEGMENT_MAX_BUNDLES,
	HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
	HistoryProjectionController,
	WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
	historyToolTextBytes,
	projectContextHistory,
	validateContextToolPairing,
	type AgentMessage,
} from "../extensions/workbench-runtime/core/context-history-budget.ts";
import {
	readReviewRecord,
	renderReviewLines,
	reviewDelegation,
} from "../extensions/workbench-runtime/core/diff-review.ts";
import {
	collectAfterFacts,
	collectGitFacts,
	createDelegationLedger,
	finishDelegationLedger,
} from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { enforceOutputEnvelope } from "../extensions/workbench-runtime/core/output-envelope.ts";
import { OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE } from "../extensions/workbench-runtime/core/output-control-telemetry.ts";
import {
	COMMANDER_TURN_MAX_BYTES,
	COMPARE_RESULT_MAX_BYTES,
	COMPARE_RESULT_MAX_LINES,
	DIFF_REVIEW_RESULT_MAX_BYTES,
	DIFF_REVIEW_RESULT_MAX_LINES,
	NATIVE_READ_MAX_BYTES,
	NATIVE_READ_MAX_TOTAL_LINES,
	OUTPUT_HARD_CAPS,
	RUN_LOG_RESULT_MAX_BYTES,
	RUN_LOG_RESULT_MAX_LINES,
	WORKER_TURN_MAX_BYTES,
	resolveToolOutputPolicy,
} from "../extensions/workbench-runtime/core/output-policy.ts";
import { buildNativeReadV3Page } from "../extensions/workbench-runtime/core/native-tool-policy.ts";
import { renderCompareLines } from "../extensions/workbench-runtime/core/render.ts";
import type { RunRecord } from "../extensions/workbench-runtime/core/runs.ts";
import { planTurnOutputBudget } from "../extensions/workbench-runtime/core/turn-output-budget.ts";
import { readTextPage } from "../extensions/workbench-runtime/core/bounded-file-io.ts";
import {
	computeFileSourceId,
	type FileSourceSnapshot,
} from "../extensions/workbench-runtime/core/continuation-cursor.ts";
import { runDeepseekWorker } from "../extensions/workbench-runtime/worker/runner.ts";
import type { WorkerTaskContract } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { sanitizeSession } from "./workbench-session-sanitize.ts";

export const CONTEXT_OUTPUT_SCENARIO_IDS = [
	"source-100mib-100k-lines",
	"single-line-10mib",
	"sparse-logs-1gib",
	"parallel-read-batches-8-16",
	"diff-review-500-paths",
	"nested-compare-512kib",
	"active-history-100-turns",
	"worker-standard-24-turns",
	"legacy-session-sanitize-resume",
] as const;

export type ContextOutputScenarioId = (typeof CONTEXT_OUTPUT_SCENARIO_IDS)[number];
export type EvidenceStatus = "PASS" | "FAIL" | "UNAVAILABLE";

export interface SampleStats {
	count: number;
	max: number;
	p95: number;
	median: number;
}

export interface AcceptanceFact {
	id: string;
	passed: boolean;
	observed: number | boolean | string;
	operator: "<" | "<=" | "=";
	limit: number | boolean | string;
}

export interface ScenarioEvidence {
	id: ContextOutputScenarioId;
	status: EvidenceStatus;
	duration_ms: number;
	fixture: Record<string, unknown>;
	metrics: Record<string, unknown>;
	acceptance: AcceptanceFact[];
	note: string;
}

export interface ContextOutputEvidence {
	schema: "workbench-context-output-evidence-v1";
	generated_at: string;
	offline: true;
	model_calls: 0;
	hard_caps: typeof OUTPUT_HARD_CAPS;
	scenarios: ScenarioEvidence[];
	metrics: {
		per_result_text_bytes: SampleStats;
		per_turn_tool_text_bytes: SampleStats;
		active_history_tool_text_bytes: SampleStats;
		raw_bytes: number;
		shown_bytes: number;
		omitted_bytes: number;
		blocked_calls: number;
		session_jsonl_growth_bytes: number;
		context_transform_wall_ms: SampleStats;
		log_read_wall_ms: SampleStats;
		rss: {
			start_bytes: number;
			sampled_peak_bytes: number;
			max_delta_bytes: number;
			sparse_log_child: {
				measurement: "process.resourceUsage().maxRSS";
				baseline_peak_bytes: number;
				peak_bytes: number;
				peak_delta_bytes: number;
			};
		};
		provider_payload_structural_bytes: number;
		provider_usage: { input: number; cache_read: number; output: number };
		compaction_count: number;
		worker: { success: boolean; failure_reason: "none" | "runner_failure" };
	};
	acceptance: { passed: boolean; checks: number; failed_checks: string[] };
	note: "machine evidence; final Gate and commander review remain authoritative";
}

interface MeasurementState {
	perResultBytes: number[];
	perTurnBytes: number[];
	historyBytes: number[];
	contextWallMs: number[];
	logWallMs: number[];
	rawBytes: number;
	shownBytes: number;
	omittedBytes: number;
	blockedCalls: number;
	sessionGrowth: number;
	providerStructuralBytes: number;
	providerUsage: { input: number; cacheRead: number; output: number };
	compactionCount: number;
	workerSuccess: boolean;
	startRss: number;
	peakRss: number;
	maxRssDelta: number;
	sparseLogChildRss: {
		baselinePeakBytes: number;
		peakBytes: number;
		peakDeltaBytes: number;
	};
}

interface WorkerRuntimeChildFacts {
	projectTrusted: boolean;
	runtimePackageProvenanceValid: boolean;
	sessionProjectRootIsolated: boolean;
	contextHandlerCount: number;
	providerRequestHandlerCount: number;
	contextRequests: number;
	providerRequests: number;
	requestBoundaryOrderValid: boolean;
	projectionsAfterCompletedToolTurns: number;
	canonicalTelemetryEntries: number;
	turnTelemetryEntries: number;
	productionReadToolResults: number;
	actualToolResultMessageEvents: number;
	forwardedRawToolResultEvents: number;
	maxPreHistoryToolResultEventBytes: number;
	maxPreHistoryToolResultBytes: number;
	maxProjectedHistoryBytes: number;
	finalActiveHistoryToolTextBytes: number;
	pairingValid: boolean;
	sourceFilesUnchanged: boolean;
	preHistoryToolResultBytes: number[];
	projectedHistoryToolTextBytes: number[];
	providerHistoryToolTextBytes: number[];
	providerPayloadBytes: number[];
	providerRequestCanonicalCounts: number[];
	providerRequestTurnTelemetryCounts: number[];
	projectionWallMs: number[];
	totalSourceBytes: number;
	totalPreHistoryToolResultBytes: number;
	totalSourceBytesOmitted: number;
	finalCollapsedToolResults: number;
	finalRemovedToolBundles: number;
	historyCap: number;
	contextPressureEntries: number;
	contextPressureNineFieldValid: boolean;
	historyProjectionV3Entries: number;
	historyProjectionV3Valid: boolean;
	maximumHistoryProjectionStateBytes: number;
	minimumWorkerAnchorReserveBytes: number;
	latestCompletedBundleRaw: boolean;
}

const MIB = 1_024 * 1_024;
const GIB = 1_024 * MIB;
const SOURCE_BYTES = 100 * MIB;
const SOURCE_LINES = 100_000;
const SINGLE_LINE_BYTES = 10 * MIB;
const SPARSE_STREAM_BYTES = GIB / 2;
const WORKER_SOURCE_FILE_BYTES = 512 * 1_024;
const CHILD_STDIO_MAX_BYTES = 128 * 1_024;
const COMMAND_STDIO_MAX_BYTES = 2 * MIB;
const MODULE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_SESSION = join(MODULE_REPO_ROOT, "fixtures", "context-output", "legacy-large-details-session.jsonl");
const OFFLINE_TELEMETRY_RELATIVE_PATH = join(CONFIG_DIR_NAME, "workbench", "cache", "telemetry.jsonl");
const WORKER_CONTRACT: WorkerTaskContract = {
	task: "Measure an offline Pi AgentSession worker loop",
	allowedPaths: ["src/**"],
	acceptanceCriteria: ["Twenty-four bounded large tool-result turns are observed before their next provider requests"],
	verification: [],
};

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function lines(value: string): number {
	return value.length === 0 ? 0 : value.split("\n").length;
}

interface OfflineTelemetryFacts {
	records: number;
	bytes: number;
	sha256: string;
	onlyFakeRecords: boolean;
}

function isOfflineFakeTelemetryRecord(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const usage = record.usage;
	if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return false;
	const totals = usage as Record<string, unknown>;
	return record.provider === "deepseek"
		&& record.model === "deepseek-v4-flash"
		&& record.apiKind === "openai-completions"
		&& totals.input === 100
		&& totals.output === 10
		&& totals.cacheRead === 0
		&& totals.cacheWrite === 0
		&& totals.totalTokens === 110;
}

async function inspectOfflineTelemetry(projectRoot: string): Promise<OfflineTelemetryFacts> {
	const content = await readFile(join(projectRoot, OFFLINE_TELEMETRY_RELATIVE_PATH));
	const records = content.toString("utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try {
				return JSON.parse(line) as unknown;
			} catch {
				return null;
			}
		});
	return {
		records: records.length,
		bytes: content.length,
		sha256: sha256(content),
		onlyFakeRecords: records.length > 0 && records.every(isOfflineFakeTelemetryRecord),
	};
}

function percentile(sorted: readonly number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
	return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

export function sampleStats(values: readonly number[]): SampleStats {
	const sorted = [...values].map((value) => Number.isFinite(value) ? value : 0).sort((a, b) => a - b);
	return {
		count: sorted.length,
		max: sorted.at(-1) ?? 0,
		p95: percentile(sorted, 0.95),
		median: percentile(sorted, 0.5),
	};
}

const execBounded: ExecFn = async (command, args, options = {}) => new Promise((resolvePromise) => {
	let aborted = options.signal?.aborted === true;
	let child: ReturnType<typeof execFile> | undefined;
	const abort = (): void => {
		aborted = true;
		child?.kill("SIGTERM");
	};
	child = execFile(command, args, {
		cwd: options.cwd,
		timeout: options.timeout,
		encoding: "utf8",
		maxBuffer: COMMAND_STDIO_MAX_BYTES,
	}, (error, stdout, stderr) => {
		options.signal?.removeEventListener("abort", abort);
		resolvePromise({
			stdout: typeof stdout === "string" ? stdout : "",
			stderr: typeof stderr === "string" ? stderr : "",
			code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
			killed: aborted || error?.killed === true,
		});
	});
	if (aborted) abort();
	else options.signal?.addEventListener("abort", abort, { once: true });
});

async function execRequired(command: string, args: string[], cwd: string): Promise<void> {
	const result = await execBounded(command, args, { cwd, timeout: 60_000 });
	if (result.code !== 0 || result.killed) throw new Error(`offline fixture command failed: ${command} exit=${result.code}`);
}

async function runJsonChild<T>(args: readonly string[]): Promise<T> {
	const result = await execBounded(process.execPath, [...args], { cwd: MODULE_REPO_ROOT, timeout: 60_000 });
	if (result.code !== 0 || result.killed) throw new Error(`offline measurement child failed: exit=${result.code}`);
	if (bytes(result.stdout) > CHILD_STDIO_MAX_BYTES) throw new Error("offline measurement child exceeded its JSON evidence bound");
	try {
		return JSON.parse(result.stdout) as T;
	} catch {
		throw new Error("offline measurement child returned invalid JSON evidence");
	}
}

function observeRss(state: MeasurementState, baseline = state.startRss): number {
	const current = process.memoryUsage().rss;
	state.peakRss = Math.max(state.peakRss, current);
	state.maxRssDelta = Math.max(state.maxRssDelta, Math.max(0, current - baseline));
	return current;
}

function acceptance(
	id: string,
	observed: number | boolean | string,
	operator: AcceptanceFact["operator"],
	limit: number | boolean | string,
): AcceptanceFact {
	const passed = operator === "="
		? observed === limit
		: typeof observed === "number" && typeof limit === "number"
			? operator === "<" ? observed < limit : observed <= limit
			: false;
	return { id, passed, observed, operator, limit };
}

function scenario(
	id: ContextOutputScenarioId,
	started: number,
	fixture: Record<string, unknown>,
	metrics: Record<string, unknown>,
	checks: AcceptanceFact[],
	note: string,
): ScenarioEvidence {
	return {
		id,
		status: checks.every((check) => check.passed) ? "PASS" : "FAIL",
		duration_ms: performance.now() - started,
		fixture,
		metrics,
		acceptance: checks,
		note,
	};
}

async function writeAll(handle: FileHandle, data: Buffer, position: number): Promise<number> {
	let written = 0;
	while (written < data.length) {
		const result = await handle.write(data, written, data.length - written, position + written);
		if (result.bytesWritten <= 0) throw new Error("fixture write made no progress");
		written += result.bytesWritten;
	}
	return written;
}

async function generateLineFixture(path: string, totalBytes: number, totalLines: number): Promise<{ sha256: string; bytes: number; lines: number }> {
	const handle = await open(path, "wx", 0o600);
	const hash = createHash("sha256");
	const baseLineBytes = Math.floor(totalBytes / totalLines);
	const extraLines = totalBytes - baseLineBytes * totalLines;
	let position = 0;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	const flush = async (): Promise<void> => {
		if (pendingBytes === 0) return;
		const chunk = Buffer.concat(pending, pendingBytes);
		await writeAll(handle, chunk, position);
		hash.update(chunk);
		position += chunk.length;
		pending = [];
		pendingBytes = 0;
	};
	try {
		for (let index = 0; index < totalLines; index += 1) {
			const lineBytes = baseLineBytes + (index < extraLines ? 1 : 0);
			const prefix = `L${String(index).padStart(6, "0")}:`;
			const line = Buffer.from(`${prefix}${"x".repeat(lineBytes - bytes(prefix) - 1)}\n`, "utf8");
			pending.push(line);
			pendingBytes += line.length;
			if (pendingBytes >= MIB) await flush();
		}
		await flush();
	} finally {
		await handle.close();
	}
	return { sha256: hash.digest("hex"), bytes: position, lines: totalLines };
}

async function generateSingleLine(path: string, totalBytes: number): Promise<{ sha256: string; bytes: number; lines: number }> {
	const handle = await open(path, "wx", 0o600);
	const hash = createHash("sha256");
	const chunk = Buffer.alloc(MIB, 0x78);
	let position = 0;
	try {
		const prefix = Buffer.from('{"pad":"', "utf8");
		const suffix = Buffer.from('"}', "utf8");
		await writeAll(handle, prefix, position);
		hash.update(prefix);
		position += prefix.length;
		const payloadEnd = totalBytes - suffix.length;
		while (position < payloadEnd) {
			const next = chunk.subarray(0, Math.min(chunk.length, payloadEnd - position));
			await writeAll(handle, next, position);
			hash.update(next);
			position += next.length;
		}
		await writeAll(handle, suffix, position);
		hash.update(suffix);
		position += suffix.length;
	} finally {
		await handle.close();
	}
	return { sha256: hash.digest("hex"), bytes: position, lines: 1 };
}

async function pageWholeFile(input: {
	path: string;
	displayPath: string;
	sourceId: string;
	expectedBytes: number;
	expectedHash: string;
	state: MeasurementState;
}): Promise<Record<string, unknown>> {
	if (!/^[0-9a-f]{64}$/.test(input.sourceId)) throw new Error("read fixture source id must be 64 lowercase hex characters");
	let startByte = 0;
	let lineNumber = 1;
	let snapshot: FileSourceSnapshot | undefined;
	let pageCount = 0;
	let maxOutputLines = 0;
	const pageWallMs: number[] = [];
	const reconstruction = createHash("sha256");
	while (startByte < input.expectedBytes) {
		const started = performance.now();
		const page = await readTextPage(input.path, {
			startByte,
			lineNumber,
			maxBytes: NATIVE_READ_MAX_BYTES,
			maxLines: 240,
			...(snapshot ? { expectedSource: snapshot } : {}),
		});
		if (!page.ok) throw new Error(`read page failed: ${page.error.code}`);
		snapshot ??= page.value.source;
		const rendered = buildNativeReadV3Page({
			displayPath: input.displayPath,
			sourceId: input.sourceId,
			page: page.value,
		});
		const renderedBytes = bytes(rendered.text);
		const renderedLines = lines(rendered.text);
		input.state.perResultBytes.push(renderedBytes);
		input.state.rawBytes += page.value.shownBytes;
		input.state.shownBytes += rendered.details.shown_bytes;
		input.state.omittedBytes += Math.max(0, page.value.shownBytes - rendered.details.shown_bytes);
		maxOutputLines = Math.max(maxOutputLines, renderedLines);
		const sourcePrefix = Buffer.from(page.value.text, "utf8").subarray(0, rendered.details.shown_bytes);
		reconstruction.update(sourcePrefix);
		const nextByte = rendered.details.end_exclusive;
		if (nextByte <= startByte) throw new Error("read page did not advance");
		let newlineCount = 0;
		for (const value of sourcePrefix) if (value === 0x0a) newlineCount += 1;
		lineNumber += newlineCount;
		startByte = nextByte;
		pageCount += 1;
		pageWallMs.push(performance.now() - started);
	}
	return {
		source_id: input.sourceId,
		source_id_valid: /^[0-9a-f]{64}$/.test(input.sourceId),
		pages: pageCount,
		reconstructed_bytes: startByte,
		reconstructed_sha256: reconstruction.digest("hex"),
		max_result_bytes: sampleStats(input.state.perResultBytes).max,
		max_result_lines: maxOutputLines,
		page_read_wall_ms: sampleStats(pageWallMs),
		expected_sha256: input.expectedHash,
	};
}

function readFixtureSourceId(logicalLocator: string): string {
	const source = computeFileSourceId("read", logicalLocator);
	if (!source.ok || !/^[0-9a-f]{64}$/.test(source.value)) throw new Error("failed to derive a valid read fixture source id");
	return source.value;
}

function runRecord(runId: string, artifactPaths: string[] = []): RunRecord {
	return {
		schema_version: 1,
		run_id: runId,
		recipe: "context-output-fixture",
		profile: "generic",
		started_at: "2026-08-13T00:00:00.000Z",
		finished_at: "2026-08-13T00:00:01.000Z",
		duration_ms: 1_000,
		cwd: "/fixture",
		argv: ["node", "fixture"],
		exit_code: 0,
		timed_out: false,
		cancelled: false,
		git_commit: null,
		git_dirty: false,
		artifact_paths: artifactPaths,
		stdout_truncated: false,
		stderr_truncated: false,
		mode: "VERIFY",
		expected_exit_codes: [0],
		declared_writes: [],
		environment_names: [],
		validation_components: [],
		cache_request_mode: "no-cache",
	};
}

async function sparseLogScenario(root: string, state: MeasurementState): Promise<ScenarioEvidence> {
	const started = performance.now();
	const runId = "20260813-000000-lg01";
	const runDir = join(root, ".pi", "workbench", "runs", runId);
	await mkdir(runDir, { recursive: true, mode: 0o700 });
	const tails = { stdout: Buffer.from("stdout-tail\n".repeat(2_000)), stderr: Buffer.from("stderr-tail\n".repeat(2_000)) };
	for (const stream of ["stdout", "stderr"] as const) {
		const handle = await open(join(runDir, `${stream}.log`), "wx", 0o600);
		try {
			await handle.truncate(SPARSE_STREAM_BYTES);
			await writeAll(handle, tails[stream], SPARSE_STREAM_BYTES - tails[stream].length);
		} finally {
			await handle.close();
		}
	}
	const runsModule = pathToFileURL(join(MODULE_REPO_ROOT, "extensions", "workbench-runtime", "core", "runs.ts")).href;
	const renderModule = pathToFileURL(join(MODULE_REPO_ROOT, "extensions", "workbench-runtime", "core", "run-result.ts")).href;
	const childScript = `
		import { performance } from "node:perf_hooks";
		import { readRunLogPage } from ${JSON.stringify(runsModule)};
		import { renderRunLogPage } from ${JSON.stringify(renderModule)};
		const baselinePeakBytes = process.resourceUsage().maxRSS * 1024;
		let maxAllocation = 0;
		const started = performance.now();
		const page = await readRunLogPage(${JSON.stringify(root)}, ${JSON.stringify(runId)}, {
			logStream: "both",
			maxBytes: ${RUN_LOG_RESULT_MAX_BYTES},
			maxLines: ${RUN_LOG_RESULT_MAX_LINES},
			hooks: {
				stdout: { onBufferAllocate: (value) => { maxAllocation = Math.max(maxAllocation, value); } },
				stderr: { onBufferAllocate: (value) => { maxAllocation = Math.max(maxAllocation, value); } },
			},
		});
		if (!page.ok) throw new Error("sparse log child read failed");
		const rendered = renderRunLogPage({
			manifest: ${JSON.stringify(runRecord(runId))},
			page: page.value,
			stdoutPath: ${JSON.stringify(`.pi/workbench/runs/${runId}/stdout.log`)},
			stderrPath: ${JSON.stringify(`.pi/workbench/runs/${runId}/stderr.log`)},
		});
		const peakBytes = process.resourceUsage().maxRSS * 1024;
		process.stdout.write(JSON.stringify({
			outputBytes: rendered.utf8Bytes,
			outputLines: rendered.lines,
			shownLogBytes: rendered.shownBytes,
			maxAllocation,
			baselinePeakBytes,
			peakBytes,
			peakDeltaBytes: Math.max(0, peakBytes - baselinePeakBytes),
			logReadMs: performance.now() - started,
		}));
	`;
	const facts = await runJsonChild<{
		outputBytes: number;
		outputLines: number;
		shownLogBytes: number;
		maxAllocation: number;
		baselinePeakBytes: number;
		peakBytes: number;
		peakDeltaBytes: number;
		logReadMs: number;
	}>(["--import", "tsx", "--input-type=module", "--eval", childScript]);
	const counts = [facts.outputBytes, facts.outputLines, facts.shownLogBytes, facts.maxAllocation, facts.baselinePeakBytes, facts.peakBytes, facts.peakDeltaBytes];
	if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0) || !Number.isFinite(facts.logReadMs) || facts.logReadMs < 0) {
		throw new Error("sparse log child returned invalid numeric evidence");
	}
	state.logWallMs.push(facts.logReadMs);
	state.perResultBytes.push(facts.outputBytes);
	state.rawBytes += SPARSE_STREAM_BYTES * 2;
	state.shownBytes += facts.shownLogBytes;
	state.omittedBytes += Math.max(0, SPARSE_STREAM_BYTES * 2 - facts.shownLogBytes);
	state.sparseLogChildRss = {
		baselinePeakBytes: facts.baselinePeakBytes,
		peakBytes: facts.peakBytes,
		peakDeltaBytes: facts.peakDeltaBytes,
	};
	state.peakRss = Math.max(state.peakRss, facts.peakBytes);
	state.maxRssDelta = Math.max(state.maxRssDelta, facts.peakDeltaBytes);
	const sparseDescriptor = JSON.stringify({ stream_bytes: SPARSE_STREAM_BYTES, stdout_tail: sha256(tails.stdout), stderr_tail: sha256(tails.stderr) });
	return scenario(
		"sparse-logs-1gib",
		started,
		{ kind: "generated-sparse-layout", logical_bytes: GIB, layout_sha256: sha256(sparseDescriptor) },
		{
			output_bytes: facts.outputBytes,
			output_lines: facts.outputLines,
			shown_log_bytes: facts.shownLogBytes,
			max_buffer_allocation: facts.maxAllocation,
			rss_measurement: "child process.resourceUsage().maxRSS",
			rss_baseline_peak_bytes: facts.baselinePeakBytes,
			rss_peak_bytes: facts.peakBytes,
			rss_peak_delta_bytes: facts.peakDeltaBytes,
			log_read_ms: facts.logReadMs,
		},
		[
			acceptance("logical-size", SPARSE_STREAM_BYTES * 2, "=", GIB),
			acceptance("run-log-byte-cap", facts.outputBytes, "<=", RUN_LOG_RESULT_MAX_BYTES),
			acceptance("run-log-line-cap", facts.outputLines, "<=", RUN_LOG_RESULT_MAX_LINES),
			acceptance("child-peak-rss-delta", facts.peakDeltaBytes, "<", 64 * MIB),
			acceptance("bounded-buffer", facts.maxAllocation, "<=", RUN_LOG_RESULT_MAX_BYTES + 4),
		],
		"A fresh child reads and renders both sparse streams; its audited process peak RSS delta and allocation hook are independent of fixture generation.",
	);
}

async function parallelScenario(state: MeasurementState): Promise<ScenarioEvidence> {
	const started = performance.now();
	const raw = "x".repeat(2 * MIB);
	const batches: Array<Record<string, unknown>> = [];
	let totalBlocked = 0;
	for (const count of [8, 16]) {
		const calls = Array.from({ length: count }, (_, index) => ({ toolCallId: `batch-${count}-${index}`, toolName: "read", args: { path: `fixture-${index}.txt` } }));
		const plan = planTurnOutputBudget({ turnSerial: count, role: "commander", calls });
		const outputs = await Promise.all(plan.reservations.map(async (reservation) => {
			await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
			if (reservation.status === "blocked") return { id: reservation.toolCallId, name: reservation.toolName, text: "", blocked: true };
			const policy = resolveToolOutputPolicy({ toolName: reservation.toolName, args: {}, role: "commander" });
			const result = enforceOutputEnvelope({
				toolName: reservation.toolName,
				content: [{ type: "text", text: raw }],
				isError: false,
				policy,
				allocatedBytes: reservation.allocatedBytes,
			});
			return { id: reservation.toolCallId, name: reservation.toolName, text: result.content.filter((block) => block.type === "text").map((block) => block.text).join(""), blocked: false };
		}));
		const total = outputs.reduce((sum, output) => sum + bytes(output.text), 0);
		const blocked = outputs.filter((output) => output.blocked).length;
		totalBlocked += blocked;
		state.perTurnBytes.push(total);
		state.perResultBytes.push(...outputs.map((output) => bytes(output.text)));
		state.rawBytes += count * bytes(raw);
		state.shownBytes += total;
		state.omittedBytes += count * bytes(raw) - total;
		const messages: AgentMessage[] = [{
			role: "assistant",
			content: calls.map((call) => ({ type: "toolCall", id: call.toolCallId, name: call.toolName, arguments: call.args })),
			timestamp: count,
		} as unknown as AgentMessage];
		messages.push(...outputs.map((output, index) => ({
			role: "toolResult",
			toolCallId: output.id,
			toolName: output.name,
			content: [{ type: "text", text: output.text }],
			isError: output.blocked,
			timestamp: count + index + 1,
		} as unknown as AgentMessage)));
		batches.push({ calls: count, total_text_bytes: total, blocked_calls: blocked, paired: validateContextToolPairing(messages) });
	}
	state.blockedCalls += totalBlocked;
	const maxTurn = sampleStats(state.perTurnBytes).max;
	const paired = batches.every((batch) => batch.paired === true);
	return scenario(
		"parallel-read-batches-8-16",
		started,
		{ kind: "generated-shared-2mib-result", bytes: bytes(raw), sha256: sha256(raw) },
		{ batches, max_turn_text_bytes: maxTurn, blocked_calls: totalBlocked, orphan_free: paired },
		[
			acceptance("commander-turn-cap", maxTurn, "<=", COMMANDER_TURN_MAX_BYTES),
			acceptance("orphan-free", paired, "=", true),
			acceptance("blocked-calls", totalBlocked, "=", 0),
			acceptance("call-limit", 16, "<=", 16),
		],
		"The same raw result is scheduled through real turn reservations and final envelopes in 8-call and 16-call offline batches.",
	);
}

async function diffScenario(root: string, state: MeasurementState): Promise<ScenarioEvidence> {
	const started = performance.now();
	const repo = join(root, "diff-500-repository");
	const delegationId = "20260813-000003-df50";
	const inScopePaths = Array.from({ length: 499 }, (_, index) => `src/generated-${String(index).padStart(3, "0")}.ts`);
	const paths = ["outside-scope.ts", ...inScopePaths].sort();
	await mkdir(join(repo, "src"), { recursive: true, mode: 0o700 });
	await execRequired("git", ["init", "-q"], repo);
	await execRequired("git", ["config", "user.email", "context-output@example.invalid"], repo);
	await execRequired("git", ["config", "user.name", "Context Output Fixture"], repo);
	await execRequired("git", ["config", "commit.gpgsign", "false"], repo);
	await writeFile(join(repo, "README.md"), "context output diff fixture\n", { encoding: "utf8", mode: 0o600 });
	await writeFile(join(repo, ".gitignore"), ".pi/workbench/\n", { encoding: "utf8", mode: 0o600 });
	await execRequired("git", ["add", "README.md", ".gitignore"], repo);
	await execRequired("git", ["commit", "-q", "-m", "fixture baseline"], repo);

	const before = await collectGitFacts(repo, execBounded);
	const created = await createDelegationLedger(repo, delegationId, {
		task: "Review an exact 500-path offline stress diff",
		allowedPaths: ["src/**"],
		acceptanceCriteria: ["All changed paths are checked and the out-of-scope path is withheld"],
		verification: [],
		timeoutSeconds: 1_800,
	}, before, "2026-08-13T00:00:00.000Z");
	if (!created.ok) throw new Error(`diff fixture ledger create failed: ${created.error}`);
	await Promise.all(inScopePaths.map((path, index) => writeFile(
		join(repo, path),
		`export const generated${index} = ${index};\n`,
		{ encoding: "utf8", mode: 0o600 },
	)));
	await writeFile(join(repo, "outside-scope.ts"), "export const outsideScope = true;\n", { encoding: "utf8", mode: 0o600 });
	const after = await collectAfterFacts(repo, before, execBounded);
	const finished = await finishDelegationLedger(repo, delegationId, {
		after,
		now: "2026-08-13T00:00:01.000Z",
		secrets: [],
		worker: {
			provider: "deepseek",
			model: "deepseek-v4-flash",
			status: "success",
			exitCode: 0,
			turns: 1,
			stopReason: "stop",
			errorMessage: null,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			cacheHitRatio: null,
			budget: { maxContextTokens: 2, maxContextRatio: 0.000002, softBudgetReached: false, hardBudgetExceeded: false, compactionCount: 0, compactionReasons: [] },
			reportSummary: "Offline 500-path fixture generated.",
		},
	});
	if (!finished.ok) throw new Error(`diff fixture ledger finish failed: ${finished.error}`);
	const reviewed = await reviewDelegation({
		projectRoot: repo,
		delegationId,
		exec: execBounded,
		now: "2026-08-13T00:00:02.000Z",
		maxBytes: DIFF_REVIEW_RESULT_MAX_BYTES,
		maxLines: DIFF_REVIEW_RESULT_MAX_LINES,
	});
	if (!reviewed.ok || !reviewed.record) throw new Error(`diff fixture review failed: ${reviewed.error ?? "missing record"}`);
	const persisted = await readReviewRecord(repo, delegationId);
	if (!persisted) throw new Error("diff fixture persisted review could not be read through the bounded reader");
	const persistedArtifact = await readFile(join(repo, persisted.review_path));
	const text = renderReviewLines(persisted, {
		maxBytes: DIFF_REVIEW_RESULT_MAX_BYTES,
		maxLines: DIFF_REVIEW_RESULT_MAX_LINES,
	}).join("\n");
	const outputBytes = bytes(text);
	const outputLines = lines(text);
	const rawBytes = persistedArtifact.length;
	const completeDomain = persisted.checked_paths.length === paths.length
		&& paths.every((path, index) => persisted.checked_paths[index] === path)
		&& persisted.patch_paths.length === paths.length
		&& paths.every((path, index) => persisted.patch_paths[index]?.path === path);
	const persistedMatches = persisted.bound_diff_hash === reviewed.record.bound_diff_hash
		&& persisted.recorded_after_hash === after.diffHash;
	const scopeViolationObserved = persisted.verdict === "FAIL"
		&& persisted.violations.length === 1
		&& persisted.violations[0]?.path === "outside-scope.ts";
	state.perResultBytes.push(outputBytes);
	state.rawBytes += rawBytes;
	state.shownBytes += outputBytes;
	state.omittedBytes += Math.max(0, rawBytes - outputBytes);
	return scenario(
		"diff-review-500-paths",
		started,
		{
			kind: "generated-real-git-delegation",
			paths: paths.length,
			in_scope_paths: inScopePaths.length,
			out_of_scope_paths: 1,
			layout_sha256: sha256(paths.map((path) => `${path}\0${path === "outside-scope.ts" ? "outside" : "generated"}`).join("\n")),
			persisted_review_sha256: sha256(persistedArtifact),
		},
		{
			raw_bytes: rawBytes,
			output_bytes: outputBytes,
			output_lines: outputLines,
			checked_paths: persisted.checked_paths.length,
			path_stat_entries: persisted.patch_paths.length,
			patch_entries: persisted.patch.length,
			remaining_paths: persisted.remaining_paths.length,
			patch_truncated: persisted.patch_truncated,
			artifact_complete: completeDomain,
			persisted_read_back: persistedMatches,
			scope_violation_observed: scopeViolationObserved,
			review_path: persisted.review_path,
		},
		[
			acceptance("path-count", paths.length, "=", 500),
			acceptance("persisted-domain-complete", completeDomain, "=", true),
			acceptance("persisted-read-back", persistedMatches, "=", true),
			acceptance("scope-violation-observed", scopeViolationObserved, "=", true),
			acceptance("diff-byte-cap", outputBytes, "<=", DIFF_REVIEW_RESULT_MAX_BYTES),
			acceptance("diff-line-cap", outputLines, "<=", DIFF_REVIEW_RESULT_MAX_LINES),
		],
		"A real temporary git repository traverses delegation before/after capture, atomic review persistence, bounded read-back, scope withholding, and whole-result rendering.",
	);
}

async function writeManifest(root: string, record: RunRecord): Promise<void> {
	const dir = join(root, ".pi", "workbench", "runs", record.run_id);
	await mkdir(join(dir, "artifacts"), { recursive: true, mode: 0o700 });
	await writeFile(join(dir, "manifest.json"), JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
}

function nestedArtifact(value: number): string {
	const target = 512 * 1_024;
	const prefix = JSON.stringify({ outer: { value, nested: { label: "fixture", pad: "" } } });
	return JSON.stringify({ outer: { value, nested: { label: "fixture", pad: "x".repeat(target - bytes(prefix)) } } });
}

async function compareScenario(root: string, state: MeasurementState): Promise<ScenarioEvidence> {
	const started = performance.now();
	const aId = "20260813-000001-ca01";
	const bId = "20260813-000002-cb01";
	const aRecord = runRecord(aId, ["metrics.json"]);
	const bRecord = { ...runRecord(bId, ["metrics.json"]), duration_ms: 2_000 };
	await Promise.all([writeManifest(root, aRecord), writeManifest(root, bRecord)]);
	const aText = nestedArtifact(1);
	const bText = nestedArtifact(2);
	await Promise.all([
		writeFile(join(root, ".pi", "workbench", "runs", aId, "artifacts", "metrics.json"), aText, { encoding: "utf8", mode: 0o600 }),
		writeFile(join(root, ".pi", "workbench", "runs", bId, "artifacts", "metrics.json"), bText, { encoding: "utf8", mode: 0o600 }),
	]);
	let maxInputBuffer = 0;
	const outcome = await compareRuns(root, aId, bId, { artifactIoHooks: { onBufferAllocate: (value) => { maxInputBuffer = Math.max(maxInputBuffer, value); } } });
	if (!outcome.ok) throw new Error(`compare failed: ${outcome.error}`);
	const text = renderCompareLines(outcome.report, true).join("\n");
	const outputBytes = bytes(text);
	const outputLines = lines(text);
	const rawBytes = bytes(aText) + bytes(bText);
	state.perResultBytes.push(outputBytes);
	state.rawBytes += rawBytes;
	state.shownBytes += outputBytes;
	state.omittedBytes += Math.max(0, rawBytes - outputBytes);
	return scenario(
		"nested-compare-512kib",
		started,
		{ kind: "generated-nested-json-pair", a_bytes: bytes(aText), b_bytes: bytes(bText), a_sha256: sha256(aText), b_sha256: sha256(bText) },
		{ output_bytes: outputBytes, output_lines: outputLines, max_input_buffer: maxInputBuffer, comparison_id: outcome.comparison_id, comparison_bytes: outcome.comparison_bytes },
		[
			acceptance("a-input-size", bytes(aText), "=", 512 * 1_024),
			acceptance("b-input-size", bytes(bText), "=", 512 * 1_024),
			acceptance("preflight-buffer-cap", maxInputBuffer, "<=", 512 * 1_024),
			acceptance("compare-byte-cap", outputBytes, "<=", COMPARE_RESULT_MAX_BYTES),
			acceptance("compare-line-cap", outputLines, "<=", COMPARE_RESULT_MAX_LINES),
		],
		"Two exact-512-KiB run-attributed JSON snapshots traverse production preflight, comparison persistence, and bounded rendering.",
	);
}

interface RoleReserveEvidence {
	hard_history_bytes: number;
	aggregate_turn_bytes: number;
	segment_reserve_bytes: number;
	anchor_max_bytes: number;
	anchor_formula_valid: boolean;
	minimum_reserved_suffix_bytes: number;
	fixed_anchor_provider_bytes: number;
	fixed_anchor_provider_sha256: string;
	fixed_anchor_nonempty: boolean;
	initial_epoch: number;
	final_epoch: number;
	segment_seals_before_checkpoint: number;
	checkpoint_ordinal: number;
	post_checkpoint_segment_seals: number;
	same_epoch_payload_append_only: boolean;
	fixed_anchor_provider_visible_unchanged: boolean;
	stable_prior_markers_across_seals: boolean;
	stable_prior_provider_prefix_across_seals: boolean;
	segment_caps_valid: boolean;
	active_caps_valid: boolean;
	state_json_bytes_max: number;
	state_within_32k: boolean;
	state_strict_json_roundtrip: boolean;
	segment_seals_keep_epoch: boolean;
	checkpoint_epoch_increment_exactly_one: boolean;
	checkpoint_epoch_hash_changed: boolean;
	transition_causes_expected: boolean;
	latest_complete_aggregate_raw: boolean;
	pairing_valid: boolean;
	hard_and_bundle_caps_valid: boolean;
	max_projected_tool_text_bytes: number;
	max_projected_bundles: number;
}

function appendAggregateBundle(
	messages: AgentMessage[],
	prefix: string,
	sizes: readonly number[],
): Map<string, string> {
	const expected = new Map<string, string>();
	messages.push({
		role: "assistant",
		content: sizes.map((_, index) => ({
			type: "toolCall",
			id: `${prefix}-${index}`,
			name: "read",
			arguments: { path: `${prefix}-${index}.txt` },
		})),
		timestamp: messages.length + 1,
	} as unknown as AgentMessage);
	for (const [index, size] of sizes.entries()) {
		const id = `${prefix}-${index}`;
		const text = String(index % 10).repeat(size);
		expected.set(id, text);
		messages.push({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: messages.length + 1,
		} as unknown as AgentMessage);
	}
	return expected;
}

function projectedResultText(messages: readonly AgentMessage[], id: string): string | undefined {
	const message = messages.find((candidate) => (
		(candidate as { role?: unknown }).role === "toolResult"
		&& (candidate as { toolCallId?: unknown }).toolCallId === id
	));
	if (!message) return undefined;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	return content.filter((block): block is { type: "text"; text: string } => (
		block !== null && typeof block === "object"
		&& (block as { type?: unknown }).type === "text"
		&& typeof (block as { text?: unknown }).text === "string"
	)).map((block) => block.text).join("");
}

function historyBundleCount(messages: readonly AgentMessage[]): number {
	return messages.filter((message) => {
		if ((message as { role?: unknown }).role !== "assistant") return false;
		const content = (message as { content?: unknown }).content;
		return Array.isArray(content) && content.some((block) => (
			block !== null && typeof block === "object" && (block as { type?: unknown }).type === "toolCall"
		));
	}).length;
}

function jsonProviderMessages(messages: readonly AgentMessage[]): unknown[] {
	return JSON.parse(JSON.stringify(convertToLlm(Array.from(messages)))) as unknown[];
}

function measureRoleReserve(role: "commander" | "worker"): RoleReserveEvidence {
	const hard = role === "commander"
		? COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES
		: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES;
	const aggregateTurn = role === "commander" ? COMMANDER_TURN_MAX_BYTES : WORKER_TURN_MAX_BYTES;
	const segmentReserve = HISTORY_PROJECTION_MAX_SEGMENTS * HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES;
	const expectedAnchorBytes = Math.max(0, hard - aggregateTurn - segmentReserve);
	const controller = new HistoryProjectionController();
	const messages: AgentMessage[] = [{ role: "user", content: `${role} reserve fixture`, timestamp: 0 } as unknown as AgentMessage];
	for (let index = 0; index < 6; index += 1) appendAggregateBundle(messages, `${role}-old-${index}`, [20 * 1_024]);
	appendAggregateBundle(messages, `${role}-seed`, [40 * 1_024]);
	const config = {
		maxToolTextBytes: hard,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role,
	};
	const initial = controller.project({ messages, ...config });
	const initialState = controller.serialize();
	const anchorMessageCount = initialState.anchor.projectedMessageCount;
	const fixedProviderAnchor = jsonProviderMessages(initial.messages.slice(0, anchorMessageCount));
	const fixedProviderAnchorText = JSON.stringify(fixedProviderAnchor);
	const initialProviderPayload = jsonProviderMessages(initial.messages);
	const projectedBytes = [historyToolTextBytes(initial.messages)];
	const projectedBundles = [initial.projectedBundleCount];
	const reserveBytes = [initialState.hardToolTextBytes - initialState.anchorToolTextBytes];
	const stateBytes: number[] = [];
	let pairingValid = validateContextToolPairing(initial.messages);
	let anchorFormulaValid = true;
	let segmentCapsValid = true;
	let activeCapsValid = true;
	let stateStrictJsonRoundTrip = true;
	let hardAndBundleCapsValid = true;
	const observeState = (
		projection: ReturnType<HistoryProjectionController["project"]>,
	): void => {
		const state = controller.serialize();
		const serialized = JSON.stringify(state);
		stateBytes.push(bytes(serialized));
		anchorFormulaValid &&= state.anchorToolTextBytes === expectedAnchorBytes
			&& state.hardToolTextBytes - state.anchorToolTextBytes === aggregateTurn + segmentReserve;
		segmentCapsValid &&= state.segments.length <= HISTORY_PROJECTION_MAX_SEGMENTS
			&& state.segments.every((segment) => (
				segment.projectedToolTextBytes <= HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES
				&& segment.projectedBundles <= HISTORY_PROJECTION_SEGMENT_MAX_BUNDLES
			));
		activeCapsValid &&= historyToolTextBytes(messages.slice(state.activeRawStartMessageCount)) <= aggregateTurn
			&& historyBundleCount(messages.slice(state.activeRawStartMessageCount)) <= HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES;
		hardAndBundleCapsValid &&= historyToolTextBytes(projection.messages) <= hard
			&& projection.projectedBundleCount <= HISTORY_MAX_BUNDLES;
		try {
			const normalizedState = JSON.parse(serialized) as unknown;
			const normalizedMessages = JSON.parse(JSON.stringify(messages)) as AgentMessage[];
			const restored = new HistoryProjectionController();
			const restoredOk = restored.restoreFromEntries([
				{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: normalizedState },
			]);
			const replayed = restoredOk ? restored.project({ messages: normalizedMessages, ...config }) : undefined;
			stateStrictJsonRoundTrip &&= restoredOk
				&& replayed !== undefined
				&& JSON.stringify(jsonProviderMessages(replayed.messages)) === JSON.stringify(jsonProviderMessages(projection.messages))
				&& JSON.stringify(restored.serialize()) === JSON.stringify(normalizedState);
		} catch {
			stateStrictJsonRoundTrip = false;
		}
	};
	observeState(initial);

	appendAggregateBundle(messages, `${role}-same-epoch`, [1 * 1_024]);
	const sameEpoch = controller.project({ messages, ...config });
	const sameState = controller.serialize();
	projectedBytes.push(historyToolTextBytes(sameEpoch.messages));
	projectedBundles.push(sameEpoch.projectedBundleCount);
	reserveBytes.push(sameState.hardToolTextBytes - sameState.anchorToolTextBytes);
	pairingValid &&= validateContextToolPairing(sameEpoch.messages);
	const sameProviderPayload = jsonProviderMessages(sameEpoch.messages);
	const sameEpochAppendOnly = !sameEpoch.epochTransitioned && !sameEpoch.segmentSealed
		&& sameEpoch.epoch === initial.epoch
		&& sameEpoch.epochHash === initial.epochHash
		&& JSON.stringify(sameProviderPayload.slice(0, initialProviderPayload.length)) === JSON.stringify(initialProviderPayload);
	observeState(sameEpoch);

	const rollingSizes = role === "commander"
		? [50 * 1_024, 64 * 1_024, 45 * 1_024, 60 * 1_024, 40 * 1_024]
		: [48 * 1_024, 40 * 1_024];
	let previous = sameEpoch;
	let previousProviderPayload = sameProviderPayload;
	let previousStableCount = sameState.anchor.projectedMessageCount
		+ sameState.segments.reduce((sum, segment) => sum + segment.projectedMessageCount, 0);
	let segmentSealsBeforeCheckpoint = 0;
	let checkpointOrdinal = 0;
	let postCheckpointSegmentSeals = 0;
	let segmentSealsKeepEpoch = true;
	let checkpointEpochIncrementExactlyOne = true;
	let checkpointEpochHashChanged = true;
	let transitionCausesExpected = true;
	let fixedAnchorUnchanged = true;
	let stablePriorMarkers = true;
	let stablePriorProviderPrefix = true;
	let latestCompleteRaw = true;
	for (let ordinal = 1; ordinal <= HISTORY_PROJECTION_MAX_SEGMENTS + 3; ordinal += 1) {
		const size = rollingSizes[(ordinal - 1) % rollingSizes.length]!;
		const expected = appendAggregateBundle(messages, `${role}-roll-${ordinal}`, [size]);
		const rolled = controller.project({ messages, ...config });
		const rolledState = controller.serialize();
		const rolledProviderPayload = jsonProviderMessages(rolled.messages);
		projectedBytes.push(historyToolTextBytes(rolled.messages));
		projectedBundles.push(rolled.projectedBundleCount);
		reserveBytes.push(rolledState.hardToolTextBytes - rolledState.anchorToolTextBytes);
		pairingValid &&= validateContextToolPairing(rolled.messages);
		if (ordinal <= HISTORY_PROJECTION_MAX_SEGMENTS || ordinal > HISTORY_PROJECTION_MAX_SEGMENTS + 1) {
			if (ordinal <= HISTORY_PROJECTION_MAX_SEGMENTS) segmentSealsBeforeCheckpoint += rolled.segmentSealed ? 1 : 0;
			else postCheckpointSegmentSeals += rolled.segmentSealed ? 1 : 0;
			segmentSealsKeepEpoch &&= rolled.segmentSealed && !rolled.epochTransitioned
				&& rolled.epoch === previous.epoch && rolled.epochHash === previous.epochHash;
			transitionCausesExpected &&= rolled.transitionCause === "segment_sealed";
			stablePriorMarkers &&= JSON.stringify(rolled.boundaryMarkers.slice(0, previous.boundaryMarkers.length))
				=== JSON.stringify(previous.boundaryMarkers);
			stablePriorProviderPrefix &&= JSON.stringify(rolledProviderPayload.slice(0, previousStableCount))
				=== JSON.stringify(previousProviderPayload.slice(0, previousStableCount));
			const stableCount = rolledState.anchor.projectedMessageCount
				+ rolledState.segments.reduce((sum, segment) => sum + segment.projectedMessageCount, 0);
			stablePriorProviderPrefix &&= stableCount > previousStableCount;
			previousStableCount = stableCount;
		} else {
			checkpointOrdinal = ordinal;
			checkpointEpochIncrementExactlyOne &&= !rolled.segmentSealed && rolled.epochTransitioned
				&& rolled.epoch === previous.epoch + 1 && rolledState.segments.length === 0;
			checkpointEpochHashChanged &&= typeof rolled.epochHash === "string" && rolled.epochHash !== previous.epochHash;
			transitionCausesExpected &&= rolled.transitionCause === "hard_bytes";
			previousStableCount = rolledState.anchor.projectedMessageCount;
		}
		if (ordinal <= HISTORY_PROJECTION_MAX_SEGMENTS) {
			fixedAnchorUnchanged &&= JSON.stringify(rolledProviderPayload.slice(0, anchorMessageCount)) === fixedProviderAnchorText;
		}
		for (const [id, text] of expected) latestCompleteRaw &&= projectedResultText(rolled.messages, id) === text;
		observeState(rolled);
		previous = rolled;
		previousProviderPayload = rolledProviderPayload;
	}

	return {
		hard_history_bytes: hard,
		aggregate_turn_bytes: aggregateTurn,
		segment_reserve_bytes: segmentReserve,
		anchor_max_bytes: expectedAnchorBytes,
		anchor_formula_valid: anchorFormulaValid,
		minimum_reserved_suffix_bytes: Math.min(...reserveBytes),
		fixed_anchor_provider_bytes: bytes(fixedProviderAnchorText),
		fixed_anchor_provider_sha256: sha256(fixedProviderAnchorText),
		fixed_anchor_nonempty: anchorMessageCount > 0 && fixedProviderAnchor.length > 0,
		initial_epoch: initial.epoch,
		final_epoch: previous.epoch,
		segment_seals_before_checkpoint: segmentSealsBeforeCheckpoint,
		checkpoint_ordinal: checkpointOrdinal,
		post_checkpoint_segment_seals: postCheckpointSegmentSeals,
		same_epoch_payload_append_only: sameEpochAppendOnly,
		fixed_anchor_provider_visible_unchanged: fixedAnchorUnchanged,
		stable_prior_markers_across_seals: stablePriorMarkers,
		stable_prior_provider_prefix_across_seals: stablePriorProviderPrefix,
		segment_caps_valid: segmentCapsValid,
		active_caps_valid: activeCapsValid,
		state_json_bytes_max: Math.max(...stateBytes),
		state_within_32k: stateBytes.every((value) => value <= 32 * 1_024),
		state_strict_json_roundtrip: stateStrictJsonRoundTrip,
		segment_seals_keep_epoch: segmentSealsKeepEpoch,
		checkpoint_epoch_increment_exactly_one: checkpointEpochIncrementExactlyOne,
		checkpoint_epoch_hash_changed: checkpointEpochHashChanged,
		transition_causes_expected: transitionCausesExpected,
		latest_complete_aggregate_raw: latestCompleteRaw,
		pairing_valid: pairingValid,
		hard_and_bundle_caps_valid: hardAndBundleCapsValid,
		max_projected_tool_text_bytes: Math.max(...projectedBytes),
		max_projected_bundles: Math.max(...projectedBundles),
	};
}

function historyScenario(state: MeasurementState): ScenarioEvidence {
	const started = performance.now();
	const messages: AgentMessage[] = [{ role: "user", content: "history fixture", timestamp: 0 } as unknown as AgentMessage];
	let finalMessages: AgentMessage[] = [];
	let originalBytes = 0;
	let finalBytes = 0;
	let paired = true;
	for (let index = 0; index < 100; index += 1) {
		const id = `history-${index}`;
		messages.push(
			{ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }], timestamp: index * 2 + 1 } as unknown as AgentMessage,
			{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `${id}:${"x".repeat(16 * 1_024)}` }], isError: false, timestamp: index * 2 + 2 } as unknown as AgentMessage,
		);
		const transformStarted = performance.now();
		const projected = projectContextHistory({
			messages,
			maxToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
			maxBundles: HISTORY_MAX_BUNDLES,
			descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
			role: "commander",
		});
		state.contextWallMs.push(performance.now() - transformStarted);
		finalMessages = projected.messages;
		originalBytes = projected.facts.originalToolTextBytes;
		finalBytes = projected.facts.finalToolTextBytes;
		state.historyBytes.push(finalBytes);
		paired &&= validateContextToolPairing(finalMessages);
	}
	state.rawBytes += originalBytes;
	state.shownBytes += finalBytes;
	state.omittedBytes += Math.max(0, originalBytes - finalBytes);
	const lastRetained = JSON.stringify(finalMessages).includes("history-99");
	const commanderReserve = measureRoleReserve("commander");
	const workerReserve = measureRoleReserve("worker");
	state.historyBytes.push(commanderReserve.max_projected_tool_text_bytes, workerReserve.max_projected_tool_text_bytes);

	const bundleCapMessages: AgentMessage[] = [];
	for (let index = 0; index < HISTORY_MAX_BUNDLES + 12; index += 1) {
		appendAggregateBundle(bundleCapMessages, `bundle-cap-${index}`, [1]);
	}
	const bundleCapProjection = new HistoryProjectionController().project({
		messages: bundleCapMessages,
		maxToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "commander",
	});
	const bundleCapEnforced = bundleCapProjection.projectedBundleCount <= HISTORY_MAX_BUNDLES
		&& validateContextToolPairing(bundleCapProjection.messages)
		&& projectedResultText(bundleCapProjection.messages, `bundle-cap-${HISTORY_MAX_BUNDLES + 11}-0`) === "0";

	const hostile = { role: "toolResult", toolCallId: "hostile", toolName: "read" } as Record<string, unknown>;
	Object.defineProperty(hostile, "content", {
		enumerable: true,
		get: () => { throw new Error("HOSTILE-RAW-HISTORY"); },
	});
	const hostileProjection = new HistoryProjectionController().project({
		messages: [hostile as unknown as AgentMessage],
		maxToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "commander",
	});
	const failClosedHostile = hostileProjection.transitionCause === "failure"
		&& historyToolTextBytes(hostileProjection.messages) === 0
		&& validateContextToolPairing(hostileProjection.messages)
		&& !JSON.stringify(hostileProjection.messages).includes("HOSTILE-RAW-HISTORY");

	const cacheVerdict = classifyInvalidation({
		isFirstRequest: false,
		isNewSession: false,
		modelChanged: false,
		thinkingChanged: false,
		modeChanged: false,
		packageReloaded: false,
		compactionOccurred: false,
		historyProjectionEpochChanged: true,
		systemPromptChanged: false,
		toolSetChanged: false,
		toolOrderChanged: false,
		toolSchemaChanged: false,
		contextShapeChanged: true,
		cacheReadTokens: 0,
		previousCacheReadTokens: 0,
	});
	const cacheClass = invalidationClass(cacheVerdict.reason);
	return scenario(
		"active-history-100-turns",
		started,
		{ kind: "generated-tool-history", turns: 100, result_payload_bytes: 16 * 1_024, sha256: sha256(JSON.stringify(messages)) },
		{
			original_tool_text_bytes: originalBytes,
			final_tool_text_bytes: finalBytes,
			max_active_history_bytes: sampleStats(state.historyBytes).max,
			paired,
			newest_retained: lastRetained,
			transform_wall_ms: sampleStats(state.contextWallMs),
			role_reserve: { commander: commanderReserve, worker: workerReserve },
			bundle_cap: HISTORY_MAX_BUNDLES,
			bundle_cap_enforced: bundleCapEnforced,
			fail_closed_hostile_history: failClosedHostile,
			cache_invalidation_reason: cacheVerdict.reason,
			cache_invalidation_class: cacheClass,
			provider_cache_read_measurement: "not_measured_offline",
		},
		[
			acceptance("turn-count", 100, "=", 100),
			acceptance("history-cap", sampleStats(state.historyBytes).max, "<=", COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES),
			acceptance("paired", paired, "=", true),
			acceptance("newest-retained", lastRetained, "=", true),
			acceptance("commander-anchor-formula", commanderReserve.anchor_formula_valid, "=", true),
			acceptance("worker-anchor-formula", workerReserve.anchor_formula_valid, "=", true),
			acceptance("commander-same-epoch-append-only", commanderReserve.same_epoch_payload_append_only, "=", true),
			acceptance("worker-same-epoch-append-only", workerReserve.same_epoch_payload_append_only, "=", true),
			acceptance("fixed-anchor-stable", commanderReserve.fixed_anchor_provider_visible_unchanged && workerReserve.fixed_anchor_provider_visible_unchanged, "=", true),
			acceptance("fixed-anchor-nonempty", commanderReserve.fixed_anchor_nonempty && workerReserve.fixed_anchor_nonempty, "=", true),
			acceptance("sixteen-seals-before-checkpoint", commanderReserve.segment_seals_before_checkpoint === HISTORY_PROJECTION_MAX_SEGMENTS
				&& workerReserve.segment_seals_before_checkpoint === HISTORY_PROJECTION_MAX_SEGMENTS, "=", true),
			acceptance("checkpoint-seventeen", commanderReserve.checkpoint_ordinal === HISTORY_PROJECTION_MAX_SEGMENTS + 1
				&& workerReserve.checkpoint_ordinal === HISTORY_PROJECTION_MAX_SEGMENTS + 1, "=", true),
			acceptance("post-checkpoint-seals", commanderReserve.post_checkpoint_segment_seals === 2
				&& workerReserve.post_checkpoint_segment_seals === 2, "=", true),
			acceptance("stable-seal-prefixes", commanderReserve.stable_prior_markers_across_seals
				&& workerReserve.stable_prior_markers_across_seals
				&& commanderReserve.stable_prior_provider_prefix_across_seals
				&& workerReserve.stable_prior_provider_prefix_across_seals, "=", true),
			acceptance("segment-active-caps", commanderReserve.segment_caps_valid && workerReserve.segment_caps_valid
				&& commanderReserve.active_caps_valid && workerReserve.active_caps_valid, "=", true),
			acceptance("strict-state-roundtrip", commanderReserve.state_within_32k && workerReserve.state_within_32k
				&& commanderReserve.state_strict_json_roundtrip && workerReserve.state_strict_json_roundtrip, "=", true),
			acceptance("segment-epoch-stable", commanderReserve.segment_seals_keep_epoch && workerReserve.segment_seals_keep_epoch, "=", true),
			acceptance("checkpoint-epoch-split", commanderReserve.checkpoint_epoch_increment_exactly_one
				&& workerReserve.checkpoint_epoch_increment_exactly_one
				&& commanderReserve.checkpoint_epoch_hash_changed && workerReserve.checkpoint_epoch_hash_changed, "=", true),
			acceptance("v3-transition-causes", commanderReserve.transition_causes_expected && workerReserve.transition_causes_expected, "=", true),
			acceptance("latest-aggregate-raw", commanderReserve.latest_complete_aggregate_raw && workerReserve.latest_complete_aggregate_raw, "=", true),
			acceptance("role-pairing", commanderReserve.pairing_valid && workerReserve.pairing_valid, "=", true),
			acceptance("role-hard-bundle-caps", commanderReserve.hard_and_bundle_caps_valid && workerReserve.hard_and_bundle_caps_valid, "=", true),
			acceptance("commander-role-hard-cap", commanderReserve.max_projected_tool_text_bytes, "<=", COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES),
			acceptance("worker-role-hard-cap", workerReserve.max_projected_tool_text_bytes, "<=", WORKER_HISTORY_TOOL_TEXT_MAX_BYTES),
			acceptance("bundle-cap", bundleCapEnforced, "=", true),
			acceptance("fail-closed", failClosedHostile, "=", true),
			acceptance("cache-classification", cacheVerdict.reason === "HISTORY_PROJECTION_EPOCH_CHANGED" && cacheClass === "expected", "=", true),
		],
		"Offline projection evidence proves role-derived anchors, sixteen immutable segment seals before checkpoint seventeen, post-checkpoint seals, strict JSON state replay, hard caps, pairing, and fail-closed behavior. It never claims or synthesizes a live provider cache hit.",
	);
}

async function workerScenario(root: string, state: MeasurementState): Promise<ScenarioEvidence> {
	const started = performance.now();
	const runtimeSourcePath = join(MODULE_REPO_ROOT, "extensions", "workbench-runtime", "index.ts");
	const historyModule = pathToFileURL(join(MODULE_REPO_ROOT, "extensions", "workbench-runtime", "core", "context-history-budget.ts")).href;
	const codingAgentModule = import.meta.resolve("@earendil-works/pi-coding-agent");
	const piAiModule = pathToFileURL(join(
		MODULE_REPO_ROOT,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"node_modules",
		"@earendil-works",
		"pi-ai",
		"dist",
		"index.js",
	)).href;
	// The worker runs with the supplied temporary project as cwd. Resolve the
	// TypeScript preload from this repository now; a bare `tsx` specifier would
	// be resolved from that isolated cwd and fail before fake-worker.mjs starts.
	const tsxImport = import.meta.resolve("tsx");
	const scriptPath = join(root, "fake-worker.mjs");
	const sourceDirectory = join(root, "src");
	const projectSettingsDirectory = join(root, CONFIG_DIR_NAME);
	await mkdir(projectSettingsDirectory, { recursive: true, mode: 0o700 });
	await writeFile(
		join(projectSettingsDirectory, "settings.json"),
		`${JSON.stringify({ packages: [MODULE_REPO_ROOT], compaction: { enabled: false } }, null, 2)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	await mkdir(sourceDirectory, { recursive: true });
	const expectedSourceHashes: string[] = [];
	for (let index = 0; index < 24; index += 1) {
		const prefix = `SOURCE-WORKER-${index}:`;
		const content = prefix + "x".repeat(WORKER_SOURCE_FILE_BYTES - bytes(prefix));
		await writeFile(join(sourceDirectory, `worker-large-${index}.txt`), content, { encoding: "utf8", mode: 0o600 });
		expectedSourceHashes.push(sha256(content));
	}
	const fakeChildSource = `
		import { HistoryProjectionController, historyToolTextBytes, validateContextToolPairing } from ${JSON.stringify(historyModule)};
		import {
			createAgentSession,
			DefaultResourceLoader,
			ModelRuntime,
			SessionManager,
			SettingsManager,
		} from ${JSON.stringify(codingAgentModule)};
		import { createAssistantMessageEventStream } from ${JSON.stringify(piAiModule)};
		import { createHash } from "node:crypto";
		import { readFile } from "node:fs/promises";
		import { join } from "node:path";
		import { performance } from "node:perf_hooks";

		const sourceBytes = ${WORKER_SOURCE_FILE_BYTES};
		const historyCap = ${WORKER_HISTORY_TOOL_TEXT_MAX_BYTES};
		const workerTurnCap = ${WORKER_TURN_MAX_BYTES};
		const projectionEntryType = ${JSON.stringify(HISTORY_PROJECTION_ENTRY_TYPE)};
		const maxSegments = ${HISTORY_PROJECTION_MAX_SEGMENTS};
		const segmentByteCap = ${HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES};
		const segmentBundleCap = ${HISTORY_PROJECTION_SEGMENT_MAX_BUNDLES};
		const activeBundleCap = ${HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES};
		const expectedAnchorBytes = historyCap - workerTurnCap - maxSegments * segmentByteCap;
		const projectRoot = process.env.WORKBENCH_WORKER_PROJECT_ROOT ?? process.cwd();
		const sessionRoot = projectRoot;
		const runtimePackageSource = ${JSON.stringify(MODULE_REPO_ROOT)};
		const runtimePackageRoot = ${JSON.stringify(MODULE_REPO_ROOT)};
		const runtimeSourcePath = ${JSON.stringify(runtimeSourcePath)};
		const expectedSourceHashes = ${JSON.stringify(expectedSourceHashes)};
		const sourcePaths = expectedSourceHashes.map((_, index) => join(projectRoot, "src", "worker-large-" + index + ".txt"));
		const utf8 = (value) => Buffer.byteLength(value, "utf8");
		const digest = (value) => createHash("sha256").update(value).digest("hex");
		const textOf = (content) => (Array.isArray(content) ? content : [])
			.filter((block) => block?.type === "text")
			.map((block) => String(block.text ?? ""))
			.join("");
		const providerToolTextBytes = (payload) => {
			const messages = payload && typeof payload === "object" && Array.isArray(payload.messages)
				? payload.messages
				: [];
			return messages
				.filter((message) => message?.role === "toolResult")
				.reduce((sum, message) => sum + utf8(textOf(message.content)), 0);
		};
		const maxOf = (values) => values.length === 0 ? 0 : Math.max(...values);
		const lifecycle = [];
		const preHistoryToolResultBytes = [];
		const projectedHistoryToolTextBytes = [];
		const providerHistoryToolTextBytes = [];
		const providerPayloadBytes = [];
		const projectionWallMs = [];
		const beforeProviderRequests = [];
		const projectionsAfterCompletedToolTurns = [];
		const preHistoryToolResultEventBytes = [];
		const canonicalTelemetrySnapshots = [];
		const turnTelemetrySnapshots = [];
		const providerRequestCanonicalCounts = [];
		const providerRequestTurnTelemetryCounts = [];
		const turnEndToolIndexes = [];
		const actualToolResultMessageBytes = [];
		const forwardedRawToolResultEventBytes = [];
		const preHistoryToolResultHashes = [];
		const contextPressureSnapshots = [];
		const historyProjectionSnapshots = [];
		const pressureKeys = [
			"epoch", "hardBundleCount", "hardHistoryBytes", "projectedToolTextBytes",
			"rawBundleCount", "rawToolTextBytes", "role", "schema", "timestampMs",
		].sort();
		let pairingValid = true;
		let requestBoundaryOrderValid = true;
		let latestCompletedBundleRaw = true;
		let contextHandlerCount = 0;
		let providerRequestHandlerCount = 0;
		let projectTrusted = false;
		let runtimePackageProvenanceValid = false;

		const observerExtension = (pi) => {
			pi.on("tool_result", (event) => {
				const index = preHistoryToolResultBytes.length;
				const rawText = textOf(event.content);
				preHistoryToolResultBytes.push(utf8(rawText));
				preHistoryToolResultHashes.push(digest(rawText));
				preHistoryToolResultEventBytes.push(utf8(JSON.stringify(event)) + 1);
				lifecycle.push("tool-result:" + index);
				return undefined;
			});
			pi.on("turn_end", (event) => {
				if (event.toolResults.length > 0) {
					const index = turnEndToolIndexes.length;
					turnEndToolIndexes.push(event.turnIndex);
					lifecycle.push("turn-end:" + index);
				}
				return undefined;
			});
			pi.on("context", (event) => {
				const startedAt = performance.now();
				const requestNumber = projectedHistoryToolTextBytes.length + 1;
				projectionWallMs.push(Math.max(0, performance.now() - startedAt));
				const projectedBytes = historyToolTextBytes(event.messages);
				projectedHistoryToolTextBytes.push(projectedBytes);
				pairingValid &&= validateContextToolPairing(event.messages);
				lifecycle.push("context-projected:" + requestNumber);
				return undefined;
			});
			pi.on("before_provider_request", () => {
				const requestNumber = beforeProviderRequests.length + 1;
				beforeProviderRequests.push(requestNumber);
				lifecycle.push("before-provider:" + requestNumber);
				return undefined;
			});
		};

		let ipcQueue = Promise.resolve();
		const enqueueActualEvent = (event) => {
			if (event?.type === "message_end" && event.message?.role === "toolResult") {
				forwardedRawToolResultEventBytes.push(utf8(JSON.stringify(event)) + 1);
			}
			const line = JSON.stringify(event) + "\\n";
			ipcQueue = ipcQueue.then(async () => {
				if (!process.stdout.write(line)) {
					await new Promise((resolve) => process.stdout.once("drain", resolve));
				}
			});
		};

		const sourceFilesUnchanged = async () => {
			for (let index = 0; index < sourcePaths.length; index += 1) {
				if (digest(await readFile(sourcePaths[index])) !== expectedSourceHashes[index]) return false;
			}
			return true;
		};
		const makeChildFacts = async () => {
			const latestCanonical = canonicalTelemetrySnapshots.at(-1);
			const totalSourceBytes = sourcePaths.length * sourceBytes;
			const totalPreHistoryToolResultBytes = preHistoryToolResultBytes.reduce((sum, value) => sum + value, 0);
			const contextPressureNineFieldValid = contextPressureSnapshots.length > 0
				&& contextPressureSnapshots.every((value) => value && typeof value === "object"
					&& !Array.isArray(value)
					&& JSON.stringify(Object.keys(value).sort()) === JSON.stringify(pressureKeys)
					&& value.schema === "workbench-context-pressure-v1"
					&& value.role === "worker"
					&& value.hardHistoryBytes === historyCap
					&& value.hardBundleCount === ${HISTORY_MAX_BUNDLES}
					&& [value.epoch, value.rawToolTextBytes, value.projectedToolTextBytes, value.rawBundleCount, value.timestampMs]
						.every((item) => Number.isSafeInteger(item) && item >= 0));
			const strictProjectionState = (value) => {
				try {
					const serialized = JSON.stringify(value);
					if (utf8(serialized) > 32 * 1024) return false;
					const normalized = JSON.parse(serialized);
					const restored = new HistoryProjectionController();
					if (!restored.restoreFromEntries([{ type: "custom", customType: projectionEntryType, data: normalized }])) return false;
					if (JSON.stringify(restored.serialize()) !== JSON.stringify(normalized)) return false;
					if (normalized.schemaVersion !== 3 || (normalized.active !== 0 && normalized.active !== 1)) return false;
					if (normalized.active === 0) return true;
					if (normalized.hardToolTextBytes !== historyCap
						|| normalized.anchorToolTextBytes !== expectedAnchorBytes
						|| normalized.hardToolTextBytes - normalized.anchorToolTextBytes !== workerTurnCap + maxSegments * segmentByteCap
						|| normalized.hardBundles !== ${HISTORY_MAX_BUNDLES}
						|| !Array.isArray(normalized.segments) || normalized.segments.length > maxSegments
						|| normalized.segments.some((segment) => segment.projectedToolTextBytes > segmentByteCap
							|| segment.projectedBundles > segmentBundleCap)) return false;
					const stableBytes = normalized.anchor.projectedToolTextBytes
						+ normalized.segments.reduce((sum, segment) => sum + segment.projectedToolTextBytes, 0);
					const stableBundles = normalized.anchor.projectedBundles
						+ normalized.segments.reduce((sum, segment) => sum + segment.projectedBundles, 0);
					return normalized.projectedToolTextBytes - stableBytes <= workerTurnCap
						&& normalized.projectedBundles - stableBundles <= activeBundleCap
						&& normalized.projectedToolTextBytes <= historyCap
						&& normalized.projectedBundles <= ${HISTORY_MAX_BUNDLES};
				} catch {
					return false;
				}
			};
			const activeProjectionStates = historyProjectionSnapshots.filter((value) => value?.active === 1);
			const historyProjectionV3Valid = historyProjectionSnapshots.length > 0
				&& activeProjectionStates.length > 0
				&& historyProjectionSnapshots.every(strictProjectionState);
			const maximumHistoryProjectionStateBytes = maxOf(historyProjectionSnapshots.map((value) => utf8(JSON.stringify(value))));
			const minimumWorkerAnchorReserveBytes = activeProjectionStates.length === 0
				? 0
				: Math.min(...activeProjectionStates.map((value) => value.hardToolTextBytes - value.anchorToolTextBytes));
			return {
				projectTrusted,
				runtimePackageProvenanceValid,
				sessionProjectRootIsolated: sessionRoot === projectRoot && process.cwd() === projectRoot,
				contextHandlerCount,
				providerRequestHandlerCount,
				contextRequests: projectedHistoryToolTextBytes.length,
				providerRequests: beforeProviderRequests.length,
				requestBoundaryOrderValid,
				projectionsAfterCompletedToolTurns: projectionsAfterCompletedToolTurns.length,
				canonicalTelemetryEntries: canonicalTelemetrySnapshots.length,
				turnTelemetryEntries: turnTelemetrySnapshots.length,
				productionReadToolResults: preHistoryToolResultBytes.length,
				actualToolResultMessageEvents: actualToolResultMessageBytes.length,
				forwardedRawToolResultEvents: forwardedRawToolResultEventBytes.length,
				maxPreHistoryToolResultEventBytes: maxOf(preHistoryToolResultEventBytes),
				maxPreHistoryToolResultBytes: maxOf(preHistoryToolResultBytes),
				maxProjectedHistoryBytes: maxOf(projectedHistoryToolTextBytes),
				finalActiveHistoryToolTextBytes: latestCanonical?.activeHistoryToolTextBytes ?? 0,
				pairingValid,
				sourceFilesUnchanged: await sourceFilesUnchanged(),
				preHistoryToolResultBytes: [...preHistoryToolResultBytes],
				projectedHistoryToolTextBytes: [...projectedHistoryToolTextBytes],
				providerHistoryToolTextBytes: [...providerHistoryToolTextBytes],
				providerPayloadBytes: [...providerPayloadBytes],
				providerRequestCanonicalCounts: [...providerRequestCanonicalCounts],
				providerRequestTurnTelemetryCounts: [...providerRequestTurnTelemetryCounts],
				projectionWallMs: [...projectionWallMs],
				totalSourceBytes,
				totalPreHistoryToolResultBytes,
				totalSourceBytesOmitted: Math.max(0, totalSourceBytes - totalPreHistoryToolResultBytes),
				finalCollapsedToolResults: latestCanonical?.totals?.historyCollapsedResults ?? 0,
				finalRemovedToolBundles: latestCanonical?.totals?.historyRemovedBundles ?? 0,
				historyCap,
				contextPressureEntries: contextPressureSnapshots.length,
				contextPressureNineFieldValid,
				historyProjectionV3Entries: historyProjectionSnapshots.length,
				historyProjectionV3Valid,
				maximumHistoryProjectionStateBytes,
				minimumWorkerAnchorReserveBytes,
				latestCompletedBundleRaw,
			};
		};

		const fakeProviderStream = (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					const requestNumber = providerPayloadBytes.length + 1;
					const payload = {
						model: model.id,
						systemPrompt: context.systemPrompt,
						messages: context.messages,
						tools: (context.tools ?? []).map((tool) => ({
							name: tool.name,
							description: tool.description,
							parameters: tool.parameters,
						})),
					};
					const replacedPayload = await options?.onPayload?.(payload, model);
					const outgoingPayload = replacedPayload ?? payload;
					providerRequestCanonicalCounts.push(canonicalTelemetrySnapshots.length);
					providerRequestTurnTelemetryCounts.push(turnTelemetrySnapshots.length);
					lifecycle.push("provider-stream:" + requestNumber);
					const contextPosition = lifecycle.lastIndexOf("context-projected:" + requestNumber);
					const beforePosition = lifecycle.lastIndexOf("before-provider:" + requestNumber);
					const providerPosition = lifecycle.lastIndexOf("provider-stream:" + requestNumber);
					let boundaryValid = contextPosition >= 0
						&& beforePosition > contextPosition
						&& providerPosition > beforePosition
						&& projectedHistoryToolTextBytes.length === requestNumber
						&& beforeProviderRequests.length === requestNumber;
					if (requestNumber > 1) {
						const toolIndex = requestNumber - 2;
						const toolPosition = lifecycle.lastIndexOf("tool-result:" + toolIndex);
						const turnPosition = lifecycle.lastIndexOf("turn-end:" + toolIndex);
						boundaryValid &&= toolPosition >= 0
							&& turnPosition > toolPosition
							&& contextPosition > turnPosition
							&& turnEndToolIndexes.length === requestNumber - 1
							&& preHistoryToolResultBytes.length === requestNumber - 1
							&& canonicalTelemetrySnapshots.length >= requestNumber - 1
							&& turnTelemetrySnapshots.length >= requestNumber - 1
							&& actualToolResultMessageBytes.length === requestNumber - 1;
						if (boundaryValid) projectionsAfterCompletedToolTurns.push(requestNumber);
					}
					const outgoingToolBytes = providerToolTextBytes(outgoingPayload);
					providerHistoryToolTextBytes.push(outgoingToolBytes);
					providerPayloadBytes.push(utf8(JSON.stringify(outgoingPayload)));
					if (requestNumber > 1) {
						const outgoingResults = Array.isArray(outgoingPayload.messages)
							? outgoingPayload.messages.filter((message) => message?.role === "toolResult")
							: [];
						const latestResultText = textOf(outgoingResults.at(-1)?.content);
						latestCompletedBundleRaw &&= utf8(latestResultText) === preHistoryToolResultBytes.at(-1)
							&& digest(latestResultText) === preHistoryToolResultHashes.at(-1);
					}
					boundaryValid &&= outgoingToolBytes === projectedHistoryToolTextBytes[requestNumber - 1]
						&& outgoingToolBytes <= historyCap;
					requestBoundaryOrderValid &&= boundaryValid;

					const usage = {
						input: 100,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 110,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					const output = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						content: [],
						stopReason: requestNumber <= 24 ? "toolUse" : "stop",
						usage,
						timestamp: Date.now(),
					};
					if (requestNumber <= 24) {
						output.content = [{
							type: "toolCall",
				id: "worker-large-" + (requestNumber - 1),
				name: "read",
				arguments: { path: sourcePaths[requestNumber - 1] },
						}];
					} else {
						output.content = [{
							type: "text",
							text: "## Completed\\nCHILD_FACTS " + JSON.stringify(await makeChildFacts()),
						}];
					}
					stream.push({ type: "done", reason: output.stopReason, message: output });
					stream.end();
				} catch (error) {
					const output = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						content: [],
						stopReason: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						timestamp: Date.now(),
					};
					stream.push({ type: "error", reason: "error", error: output });
					stream.end();
				}
			})();
			return stream;
		};

		const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerProvider("deepseek", {
			name: "Offline deterministic DeepSeek",
			apiKey: "offline-local-only",
			api: "openai-completions",
			baseUrl: "http://offline.invalid",
			streamSimple: fakeProviderStream,
			models: [{
				id: "deepseek-v4-flash",
				name: "Offline deterministic DeepSeek V4 Flash",
				api: "openai-completions",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 4_096,
			}],
		});
		const model = modelRuntime.getModel("deepseek", "deepseek-v4-flash");
		if (!model) throw new Error("offline deterministic model registration failed");

		const agentDir = join(projectRoot, ".agent-context-output");
		const settingsManager = SettingsManager.create(sessionRoot, agentDir, { projectTrusted: true });
		const resourceLoader = new DefaultResourceLoader({
			cwd: sessionRoot,
			agentDir,
			settingsManager,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Offline deterministic context-output stress agent.",
			extensionFactories: [
				{ name: "stress-observer", factory: observerExtension },
			],
		});
		await resourceLoader.reload();
		projectTrusted = settingsManager.isProjectTrusted();
		if (!projectTrusted) throw new Error("temporary stress project was not accepted by the project trust guard");
		const sessionManager = SessionManager.inMemory(sessionRoot, { id: "context-output-formal-worker" });
		const { session, extensionsResult } = await createAgentSession({
			cwd: sessionRoot,
			agentDir,
			model,
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader,
			tools: ["read"],
			sessionManager,
			settingsManager,
		});
		if (extensionsResult.errors.length > 0) throw new Error("offline AgentSession extension load failed");
		const runtimeExtension = extensionsResult.extensions.find((extension) => extension.resolvedPath === runtimeSourcePath);
		runtimePackageProvenanceValid = runtimeExtension?.sourceInfo?.source === runtimePackageSource
			&& runtimeExtension.sourceInfo.scope === "project"
			&& runtimeExtension.sourceInfo.origin === "package"
			&& runtimeExtension.sourceInfo.baseDir === runtimePackageRoot;
		if (!runtimePackageProvenanceValid) throw new Error("production runtime did not retain trusted temporary-project package provenance");
		contextHandlerCount = runtimeExtension?.handlers.get("context")?.length ?? 0;
		providerRequestHandlerCount = runtimeExtension?.handlers.get("before_provider_request")?.length ?? 0;
		if (contextHandlerCount !== 1 || providerRequestHandlerCount !== 1) {
			throw new Error("production runtime did not register the exact request-boundary handlers");
		}

		const unsubscribe = session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "custom") {
				if (event.entry.customType === ${JSON.stringify(OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE)}) {
					canonicalTelemetrySnapshots.push(event.entry.data);
					enqueueActualEvent(event);
				} else if (event.entry.customType === "workbench-output-turn-telemetry-v1") {
					turnTelemetrySnapshots.push(event.entry.data);
					enqueueActualEvent(event);
				} else if (event.entry.customType === "workbench-context-pressure-v1") {
					contextPressureSnapshots.push(event.entry.data);
				} else if (event.entry.customType === projectionEntryType) {
					historyProjectionSnapshots.push(event.entry.data);
				}
				return;
			}
			if (event.type === "compaction_start") {
				enqueueActualEvent(event);
				return;
			}
			if (event.type !== "message_end") return;
			if (event.message.role === "toolResult") {
				actualToolResultMessageBytes.push(utf8(JSON.stringify(event)) + 1);
				return;
			}
			if (event.message.role === "assistant") enqueueActualEvent(event);
		});
		try {
			await session.bindExtensions({ mode: "json" });
			await session.prompt("Run the deterministic offline context-output stress loop.", { expandPromptTemplates: false });
			await ipcQueue;
		} finally {
			unsubscribe();
			session.dispose();
			await ipcQueue;
		}
	`;
	await writeFile(scriptPath, fakeChildSource, { encoding: "utf8", mode: 0o600 });
	const progress: Array<{ currentToolTextBytes: number; collapsedToolResults: number; turnReservedBytes: number }> = [];
	const result = await runDeepseekWorker({
		projectRoot: root,
		contract: WORKER_CONTRACT,
		timeoutMs: 120_000,
		invocation: { command: process.execPath, argsPrefix: ["--import", tsxImport, scriptPath] },
		spendProfile: "standard",
		onProgress: (value) => progress.push({
			currentToolTextBytes: value.currentToolTextBytes,
			collapsedToolResults: value.collapsedToolResults,
			turnReservedBytes: value.turnReservedBytes,
		}),
	});
	const marker = "CHILD_FACTS ";
	const markerOffset = result.reportText.indexOf(marker);
	if (markerOffset < 0) {
		// Failure-only runner observations: fixed keys, booleans, byte counts,
		// closed enums, and SHA-256 digests. Never echo child stderr/report/error
		// text and never substitute these parent observations for child facts.
		const errorMessage = result.errorMessage ?? "";
		const modelMismatch = result.modelMismatch ?? "";
		const stopReason = result.stopReason ?? "";
		const failureClass = result.timedOut ? "timeout"
			: result.aborted ? "aborted"
				: result.modelMismatch !== undefined ? "model_mismatch"
					: result.hardBudgetExceeded || result.spendBand === "hard" ? "budget_hard_stop"
						: errorMessage === `Worker JSON event exceeded ${2 * MIB} bytes` ? "json_line_cap"
							: result.exitCode !== 0 ? "child_exit"
								: result.reportText.length > 0 ? "marker_missing_or_overwritten" : "empty_report";
		const diagnostics = {
			failure_class: failureClass,
			exit_code: result.exitCode,
			turns: result.turns,
			timed_out: result.timedOut,
			aborted: result.aborted,
			hard_budget_exceeded: result.hardBudgetExceeded,
			spend_band: result.spendBand,
			report_oversized: result.reportTextOversized,
			report_bytes: bytes(result.reportText),
			report_sha256: sha256(result.reportText),
			output_bytes: bytes(result.output),
			output_sha256: sha256(result.output),
			stderr_bytes: bytes(result.stderr),
			stderr_sha256: sha256(result.stderr),
			error_message_bytes: bytes(errorMessage),
			error_message_sha256: sha256(errorMessage),
			model_mismatch_bytes: bytes(modelMismatch),
			model_mismatch_sha256: sha256(modelMismatch),
			provider_matches: result.provider === "deepseek",
			model_matches: result.model === "deepseek-v4-flash",
			stop_reason_matches: stopReason === "stop",
			stop_reason_bytes: bytes(stopReason),
			stop_reason_sha256: sha256(stopReason),
		};
		throw new Error(`actual-runtime fake child omitted its bounded lifecycle facts; diagnostics=${JSON.stringify(diagnostics)}`);
	}
	let childFacts: WorkerRuntimeChildFacts;
	try {
		childFacts = JSON.parse(result.reportText.slice(markerOffset + marker.length)) as WorkerRuntimeChildFacts;
	} catch {
		throw new Error("actual-runtime fake child returned invalid lifecycle facts");
	}
	const numericCounts = [
		childFacts.contextHandlerCount, childFacts.providerRequestHandlerCount,
		childFacts.contextRequests, childFacts.providerRequests, childFacts.projectionsAfterCompletedToolTurns,
		childFacts.canonicalTelemetryEntries, childFacts.turnTelemetryEntries, childFacts.productionReadToolResults,
		childFacts.actualToolResultMessageEvents, childFacts.forwardedRawToolResultEvents,
		childFacts.maxPreHistoryToolResultEventBytes,
		childFacts.maxPreHistoryToolResultBytes, childFacts.maxProjectedHistoryBytes, childFacts.totalSourceBytes,
		childFacts.totalPreHistoryToolResultBytes, childFacts.totalSourceBytesOmitted, childFacts.finalCollapsedToolResults,
		childFacts.finalRemovedToolBundles, childFacts.finalActiveHistoryToolTextBytes, childFacts.historyCap,
		childFacts.contextPressureEntries, childFacts.historyProjectionV3Entries,
		childFacts.maximumHistoryProjectionStateBytes, childFacts.minimumWorkerAnchorReserveBytes,
	];
	if (!numericCounts.every((value) => Number.isSafeInteger(value) && value >= 0)
		|| typeof childFacts.projectTrusted !== "boolean"
		|| typeof childFacts.runtimePackageProvenanceValid !== "boolean"
		|| typeof childFacts.sessionProjectRootIsolated !== "boolean"
		|| typeof childFacts.requestBoundaryOrderValid !== "boolean"
		|| typeof childFacts.pairingValid !== "boolean" || typeof childFacts.sourceFilesUnchanged !== "boolean"
		|| typeof childFacts.contextPressureNineFieldValid !== "boolean"
		|| typeof childFacts.historyProjectionV3Valid !== "boolean"
		|| typeof childFacts.latestCompletedBundleRaw !== "boolean"
		|| !Array.isArray(childFacts.preHistoryToolResultBytes) || childFacts.preHistoryToolResultBytes.length !== 24
		|| !childFacts.preHistoryToolResultBytes.every((value) => Number.isSafeInteger(value) && value >= 0)
		|| !Array.isArray(childFacts.projectedHistoryToolTextBytes) || childFacts.projectedHistoryToolTextBytes.length !== 25
		|| !childFacts.projectedHistoryToolTextBytes.every((value) => Number.isSafeInteger(value) && value >= 0)
		|| !Array.isArray(childFacts.providerHistoryToolTextBytes) || childFacts.providerHistoryToolTextBytes.length !== 25
		|| !childFacts.providerHistoryToolTextBytes.every((value) => Number.isSafeInteger(value) && value >= 0)
		|| !Array.isArray(childFacts.providerPayloadBytes) || childFacts.providerPayloadBytes.length !== 25
		|| !childFacts.providerPayloadBytes.every((value) => Number.isSafeInteger(value) && value >= 0)
		|| !Array.isArray(childFacts.providerRequestCanonicalCounts) || childFacts.providerRequestCanonicalCounts.length !== 25
		|| !childFacts.providerRequestCanonicalCounts.every((value) => Number.isSafeInteger(value) && value >= 0)
		|| !Array.isArray(childFacts.providerRequestTurnTelemetryCounts) || childFacts.providerRequestTurnTelemetryCounts.length !== 25
		|| !childFacts.providerRequestTurnTelemetryCounts.every((value) => Number.isSafeInteger(value) && value >= 0)
		|| !Array.isArray(childFacts.projectionWallMs) || childFacts.projectionWallMs.length !== 25
		|| !childFacts.projectionWallMs.every((value) => Number.isFinite(value) && value >= 0)) {
		throw new Error("actual-runtime fake child lifecycle facts failed numeric validation");
	}
	const offlineTelemetry = await inspectOfflineTelemetry(root);
	const telemetryIsolated = offlineTelemetry.records === 25 && offlineTelemetry.onlyFakeRecords;
	// Actual Pi ordering persists turn telemetry before it constructs the next
	// request. Progress for response N therefore carries request N-1's projection;
	// the final turn_end entry, observed after the final assistant event, carries
	// request 25's projection. Keep that one-turn observation lag explicit.
	const canonicalProgressLagObserved = progress.length === 25
		&& progress.every((value, index) => (
			value.currentToolTextBytes === (index === 0 ? 0 : childFacts.projectedHistoryToolTextBytes[index - 1])
			&& value.currentToolTextBytes <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES
			&& value.turnReservedBytes <= 49_152
			&& (index === 0 || value.collapsedToolResults >= progress[index - 1]!.collapsedToolResults)
		));
	const preflightObservedBeforeEveryProviderResponse = canonicalProgressLagObserved
		&& childFacts.contextHandlerCount === 1
		&& childFacts.providerRequestHandlerCount === 1
		&& childFacts.contextRequests === 25
		&& childFacts.providerRequests === 25
		&& childFacts.requestBoundaryOrderValid
		&& childFacts.projectionsAfterCompletedToolTurns === 24
		&& childFacts.canonicalTelemetryEntries === 24
		&& childFacts.turnTelemetryEntries === 24
		&& childFacts.providerRequestCanonicalCounts.every((value, index) => value === index)
		&& childFacts.providerRequestTurnTelemetryCounts.every((value, index) => value === index)
		&& childFacts.providerHistoryToolTextBytes.every((value, index) => (
			value === childFacts.projectedHistoryToolTextBytes[index]
			&& value <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES
		));
	const childFactsConsistent = childFacts.projectTrusted
		&& childFacts.runtimePackageProvenanceValid
		&& childFacts.sessionProjectRootIsolated
		&& childFacts.totalSourceBytes === 24 * WORKER_SOURCE_FILE_BYTES
		&& childFacts.productionReadToolResults === 24
		&& childFacts.actualToolResultMessageEvents === 24
		&& childFacts.forwardedRawToolResultEvents === 0
		&& childFacts.requestBoundaryOrderValid
		&& childFacts.totalPreHistoryToolResultBytes === childFacts.preHistoryToolResultBytes.reduce((sum, value) => sum + value, 0)
		&& childFacts.totalSourceBytesOmitted === childFacts.totalSourceBytes - childFacts.totalPreHistoryToolResultBytes
		&& childFacts.maxPreHistoryToolResultBytes === sampleStats(childFacts.preHistoryToolResultBytes).max
		&& childFacts.maxProjectedHistoryBytes === sampleStats(childFacts.projectedHistoryToolTextBytes).max
		&& childFacts.finalActiveHistoryToolTextBytes === childFacts.projectedHistoryToolTextBytes.at(-2)
		&& childFacts.contextPressureEntries >= 24
		&& childFacts.contextPressureNineFieldValid
		&& childFacts.historyProjectionV3Entries >= 24
		&& childFacts.historyProjectionV3Valid
		&& childFacts.maximumHistoryProjectionStateBytes <= 32 * 1_024
		&& childFacts.minimumWorkerAnchorReserveBytes === WORKER_TURN_MAX_BYTES
			+ HISTORY_PROJECTION_MAX_SEGMENTS * HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES
		&& childFacts.latestCompletedBundleRaw;
	const outputControl = result.outputControl;
	const finalOutputControlObserved = outputControl !== undefined
		&& outputControl.currentToolTextBytes === childFacts.projectedHistoryToolTextBytes.at(-1)
		&& outputControl.currentToolTextBytes <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES
		&& outputControl.collapsedToolResults >= childFacts.finalCollapsedToolResults
		&& outputControl.turnReservedBytes <= 49_152;
	const historyBounded = childFacts.maxProjectedHistoryBytes <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES
		&& childFacts.historyCap === WORKER_HISTORY_TOOL_TEXT_MAX_BYTES;
	const success = result.exitCode === 0
		&& result.provider === "deepseek"
		&& result.model === "deepseek-v4-flash"
		&& result.stopReason === "stop"
		&& result.output.length > 0
		&& !result.aborted
		&& !result.timedOut
		&& result.modelMismatch === undefined
		&& !result.hardBudgetExceeded
		&& result.compactionCount === 0
		&& result.turns === 25
		&& result.spendBand === "soft"
		&& childFacts.productionReadToolResults === 24
		&& childFacts.forwardedRawToolResultEvents === 0
		&& childFacts.maxPreHistoryToolResultEventBytes <= 2 * MIB
		&& childFacts.maxPreHistoryToolResultBytes <= NATIVE_READ_MAX_BYTES
		&& childFactsConsistent
		&& telemetryIsolated
		&& preflightObservedBeforeEveryProviderResponse
		&& finalOutputControlObserved
		&& historyBounded
		&& result.usage.cacheRead === 0
		&& (outputControl?.collapsedToolResults ?? 0) > 0
		&& childFacts.pairingValid
		&& childFacts.sourceFilesUnchanged;
	const providerStructuralBytes = childFacts.providerPayloadBytes.reduce((sum, value) => sum + value, 0);
	state.contextWallMs.push(...childFacts.projectionWallMs);
	state.historyBytes.push(...childFacts.projectedHistoryToolTextBytes);
	state.rawBytes += childFacts.totalSourceBytes;
	state.shownBytes += childFacts.totalPreHistoryToolResultBytes;
	state.omittedBytes += childFacts.totalSourceBytesOmitted;
	state.perResultBytes.push(...childFacts.preHistoryToolResultBytes);
	state.perTurnBytes.push(...childFacts.preHistoryToolResultBytes);
	state.providerStructuralBytes += providerStructuralBytes;
	state.providerUsage.input += result.usage.input;
	state.providerUsage.cacheRead += result.usage.cacheRead;
	state.providerUsage.output += result.usage.output;
	state.compactionCount += result.compactionCount;
	state.workerSuccess &&= success;
	state.perResultBytes.push(bytes(result.output));
	return scenario(
		"worker-standard-24-turns",
		started,
		{
			kind: "local-json-transport-with-real-pi-agent-session-and-offline-provider",
			tool_result_turns: 24,
			provider_responses: 25,
			event_order: "Pi tool execute -> tool_result -> turn_end telemetry -> next context projection -> before_provider_request -> offline provider response",
			history_source: "24 production native read executions over distinct 512 KiB local source files; actual pre-history tool-result bytes are measured separately",
			source_file_bytes_each: WORKER_SOURCE_FILE_BYTES,
			total_source_bytes: childFacts.totalSourceBytes,
			child_source_sha256: sha256(fakeChildSource),
			model_calls: 0,
			telemetry_sink: OFFLINE_TELEMETRY_RELATIVE_PATH,
		},
		{
			turns: result.turns,
			exit_code: result.exitCode,
			spend_band: result.spendBand,
			compaction_count: result.compactionCount,
			production_read_tool_results: childFacts.productionReadToolResults,
			actual_tool_result_message_events: childFacts.actualToolResultMessageEvents,
			forwarded_raw_tool_result_events: childFacts.forwardedRawToolResultEvents,
			max_pre_history_tool_result_event_bytes: childFacts.maxPreHistoryToolResultEventBytes,
			max_pre_history_tool_result_text_bytes: childFacts.maxPreHistoryToolResultBytes,
			total_pre_history_tool_result_text_bytes: childFacts.totalPreHistoryToolResultBytes,
			max_projected_history_tool_text_bytes: childFacts.maxProjectedHistoryBytes,
			preflight_observations: progress.length,
			child_context_requests: childFacts.contextRequests,
			child_before_provider_requests: childFacts.providerRequests,
			request_boundary_order_valid: childFacts.requestBoundaryOrderValid,
			projections_after_completed_tool_turns: childFacts.projectionsAfterCompletedToolTurns,
			child_context_handler_count: childFacts.contextHandlerCount,
			child_before_provider_handler_count: childFacts.providerRequestHandlerCount,
			child_project_trusted: childFacts.projectTrusted,
			production_runtime_package_provenance_valid: childFacts.runtimePackageProvenanceValid,
			session_project_root_isolated: childFacts.sessionProjectRootIsolated,
			isolated_telemetry_records: offlineTelemetry.records,
			isolated_telemetry_bytes: offlineTelemetry.bytes,
			isolated_telemetry_sha256: offlineTelemetry.sha256,
			isolated_telemetry_only_fake_records: offlineTelemetry.onlyFakeRecords,
			child_canonical_telemetry_entries_before_final_response: childFacts.canonicalTelemetryEntries,
			child_facts_consistent: childFactsConsistent,
			preflight_before_every_provider_response: preflightObservedBeforeEveryProviderResponse,
			canonical_progress_one_turn_lag_observed: canonicalProgressLagObserved,
			final_output_control_observed: finalOutputControlObserved,
			final_collapsed_tool_results: outputControl?.collapsedToolResults ?? 0,
			last_pre_final_response_collapsed_tool_results: childFacts.finalCollapsedToolResults,
			final_removed_tool_bundles: childFacts.finalRemovedToolBundles,
			context_pressure_entries: childFacts.contextPressureEntries,
			context_pressure_nine_fields_valid: childFacts.contextPressureNineFieldValid,
			history_projection_v3_entries: childFacts.historyProjectionV3Entries,
			history_projection_v3_valid: childFacts.historyProjectionV3Valid,
			maximum_history_projection_state_bytes: childFacts.maximumHistoryProjectionStateBytes,
			minimum_worker_anchor_reserve_bytes: childFacts.minimumWorkerAnchorReserveBytes,
			latest_completed_bundle_raw: childFacts.latestCompletedBundleRaw,
			source_files_unchanged: childFacts.sourceFilesUnchanged,
			provider_payload_structural_bytes: providerStructuralBytes,
			provider_request_structural_bytes: sampleStats(childFacts.providerPayloadBytes),
			usage: { input: result.usage.input, cache_read: result.usage.cacheRead, output: result.usage.output },
			offline_provider_cache_read_tokens: result.usage.cacheRead,
			real_provider_cache_read_measured: false,
			success,
			failure_reason: success ? "none" : "runner_failure",
		},
		[
			acceptance("worker-provider-responses", result.turns, "=", 25),
			acceptance("standard-profile-soft-band", result.spendBand, "=", "soft"),
			acceptance("worker-success", success, "=", true),
			acceptance("production-read-tool-results", childFacts.productionReadToolResults, "=", 24),
			acceptance("actual-tool-result-message-events", childFacts.actualToolResultMessageEvents, "=", 24),
			acceptance("raw-tool-result-ipc-events", childFacts.forwardedRawToolResultEvents, "=", 0),
			acceptance("child-json-line-cap", childFacts.maxPreHistoryToolResultEventBytes, "<=", 2 * MIB),
			acceptance("runtime-envelope-cap", childFacts.maxPreHistoryToolResultBytes, "<=", NATIVE_READ_MAX_BYTES),
			acceptance("child-facts-consistent", childFactsConsistent, "=", true),
			acceptance("temporary-project-trusted", childFacts.projectTrusted, "=", true),
			acceptance("production-runtime-package-provenance", childFacts.runtimePackageProvenanceValid, "=", true),
			acceptance("session-project-root-isolated", childFacts.sessionProjectRootIsolated, "=", true),
			acceptance("isolated-telemetry-records", offlineTelemetry.records, "=", 25),
			acceptance("isolated-telemetry-only-fake-records", offlineTelemetry.onlyFakeRecords, "=", true),
			acceptance("actual-request-boundary-order", childFacts.requestBoundaryOrderValid, "=", true),
			acceptance("post-tool-turn-projections", childFacts.projectionsAfterCompletedToolTurns, "=", 24),
			acceptance("provider-preflight-observed", preflightObservedBeforeEveryProviderResponse, "=", true),
			acceptance("canonical-output-control-observed", finalOutputControlObserved, "=", true),
			acceptance("history-collapse-observed", (outputControl?.collapsedToolResults ?? 0) > 0, "=", true),
			acceptance("context-pressure-nine-fields", childFacts.contextPressureNineFieldValid, "=", true),
			acceptance("history-projection-v3-state", childFacts.historyProjectionV3Valid, "=", true),
			acceptance("history-projection-state-size", childFacts.maximumHistoryProjectionStateBytes, "<=", 32 * 1_024),
			acceptance("worker-anchor-reserve", childFacts.minimumWorkerAnchorReserveBytes,
				"=", WORKER_TURN_MAX_BYTES + HISTORY_PROJECTION_MAX_SEGMENTS * HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES),
			acceptance("latest-completed-bundle-raw", childFacts.latestCompletedBundleRaw, "=", true),
			acceptance("offline-cache-read-zero", result.usage.cacheRead, "=", 0),
			acceptance("worker-history-cap", childFacts.maxProjectedHistoryBytes, "<=", WORKER_HISTORY_TOOL_TEXT_MAX_BYTES),
			acceptance("worker-pairing", childFacts.pairingValid, "=", true),
			acceptance("source-files-unchanged", childFacts.sourceFilesUnchanged, "=", true),
			acceptance("worker-compaction", result.compactionCount, "=", 0),
			acceptance("model-calls", 0, "=", 0),
		],
		"createAgentSession drives the real Pi agent loop with a deterministic local ModelRuntime provider: each of 24 production native reads consumes a distinct 512 KiB local source file, its actual bounded tool result crosses AgentSession middleware, turn_end completes, and only then does the next context/before_provider_request pair run. Strict v3 projection state and the exact nine-field pressure protocol are observed locally. Offline cacheRead is fixed to zero; this scenario never substitutes synthetic usage for live provider cache telemetry.",
	);
}

async function sanitizerScenario(root: string, state: MeasurementState): Promise<ScenarioEvidence> {
	const started = performance.now();
	const input = join(root, "legacy-session.jsonl");
	const output = join(root, "sanitized-session.jsonl");
	const inputBytes = await readFile(FIXTURE_SESSION);
	await writeFile(input, inputBytes, { mode: 0o600 });
	const manifest = await sanitizeSession({ input, output, collapseContent: true });
	const manager = SessionManager.open(output);
	const resumed = manager.getLeafId() === manifest.tree.active_leaf_id_after;
	const paired = validateContextToolPairing(manager.buildSessionContext().messages as AgentMessage[]);
	const growth = manifest.output.bytes - manifest.input.bytes;
	state.sessionGrowth += growth;
	state.rawBytes += manifest.input.bytes;
	state.shownBytes += manifest.output.bytes;
	state.omittedBytes += Math.max(0, manifest.input.bytes - manifest.output.bytes);
	return scenario(
		"legacy-session-sanitize-resume",
		started,
		{ kind: "repository-legacy-session-copy", bytes: inputBytes.length, sha256: sha256(inputBytes) },
		{ input_bytes: manifest.input.bytes, output_bytes: manifest.output.bytes, session_jsonl_growth_bytes: growth, details_projected: manifest.details_projected, content_collapsed: manifest.content_collapsed, tree_preserved: manifest.tree.preserved, resumable: resumed, paired },
		[
			acceptance("tree-preserved", manifest.tree.preserved, "=", true),
			acceptance("tree-hash", manifest.tree.canonical_sha256_before, "=", manifest.tree.canonical_sha256_after),
			acceptance("resume-leaf", resumed, "=", true),
			acceptance("resume-pairing", paired, "=", true),
		],
		"A copy of the checked-in adversarial v3 session is streamed, collapsed, hash-manifested, and reopened by Pi's SessionManager.",
	);
}

export async function runContextOutputEvidence(tempRoot: string): Promise<ContextOutputEvidence> {
	await mkdir(tempRoot, { recursive: true, mode: 0o700 });
	const initialRss = process.memoryUsage().rss;
	const state: MeasurementState = {
		perResultBytes: [], perTurnBytes: [], historyBytes: [], contextWallMs: [], logWallMs: [],
		rawBytes: 0, shownBytes: 0, omittedBytes: 0, blockedCalls: 0, sessionGrowth: 0,
		providerStructuralBytes: 0, providerUsage: { input: 0, cacheRead: 0, output: 0 },
		compactionCount: 0, workerSuccess: true,
		startRss: initialRss, peakRss: initialRss, maxRssDelta: 0,
		sparseLogChildRss: { baselinePeakBytes: 0, peakBytes: 0, peakDeltaBytes: 0 },
	};
	const scenarios: ScenarioEvidence[] = [];

	const sourceStarted = performance.now();
	const sourcePath = join(tempRoot, "huge-source-100mib.txt");
	const sourceFixture = await generateLineFixture(sourcePath, SOURCE_BYTES, SOURCE_LINES);
	const sourcePage = await pageWholeFile({ path: sourcePath, displayPath: "huge-source-100mib.txt", sourceId: readFixtureSourceId("fixture:huge-source-100mib.txt"), expectedBytes: SOURCE_BYTES, expectedHash: sourceFixture.sha256, state });
	const sourceMatches = sourcePage.reconstructed_sha256 === sourceFixture.sha256;
	scenarios.push(scenario(
		"source-100mib-100k-lines", sourceStarted, { kind: "generated-text", ...sourceFixture }, sourcePage,
		[
			acceptance("fixture-bytes", sourceFixture.bytes, "=", SOURCE_BYTES),
			acceptance("fixture-lines", sourceFixture.lines, "=", SOURCE_LINES),
			acceptance("read-result-byte-cap", Number(sourcePage.max_result_bytes), "<=", NATIVE_READ_MAX_BYTES),
			acceptance("read-result-line-cap", Number(sourcePage.max_result_lines), "<=", NATIVE_READ_MAX_TOTAL_LINES),
			acceptance("source-id-format", sourcePage.source_id_valid === true, "=", true),
			acceptance("reconstruction", sourceMatches, "=", true),
		],
		"All generated bytes are consumed through bounded production pages and hashed again in page order.",
	));
	observeRss(state);

	const singleStarted = performance.now();
	const singlePath = join(tempRoot, "huge-single-line-10mib.json");
	const singleFixture = await generateSingleLine(singlePath, SINGLE_LINE_BYTES);
	const singlePage = await pageWholeFile({ path: singlePath, displayPath: "huge-single-line-10mib.json", sourceId: readFixtureSourceId("fixture:huge-single-line-10mib.json"), expectedBytes: SINGLE_LINE_BYTES, expectedHash: singleFixture.sha256, state });
	const singleMatches = singlePage.reconstructed_sha256 === singleFixture.sha256;
	scenarios.push(scenario(
		"single-line-10mib", singleStarted, { kind: "generated-single-line", ...singleFixture }, singlePage,
		[
			acceptance("fixture-bytes", singleFixture.bytes, "=", SINGLE_LINE_BYTES),
			acceptance("read-result-byte-cap", Number(singlePage.max_result_bytes), "<=", NATIVE_READ_MAX_BYTES),
			acceptance("read-result-line-cap", Number(singlePage.max_result_lines), "<=", NATIVE_READ_MAX_TOTAL_LINES),
			acceptance("source-id-format", singlePage.source_id_valid === true, "=", true),
			acceptance("segment-reconstruction", singleMatches, "=", true),
		],
		"The no-newline source is reconstructed from advancing long-line segments without retaining the full source in memory.",
	));
	observeRss(state);

	scenarios.push(await sparseLogScenario(tempRoot, state));
	scenarios.push(await parallelScenario(state));
	scenarios.push(await diffScenario(tempRoot, state));
	scenarios.push(await compareScenario(tempRoot, state));
	scenarios.push(historyScenario(state));
	scenarios.push(await workerScenario(tempRoot, state));
	scenarios.push(await sanitizerScenario(tempRoot, state));
	observeRss(state);

	const failedChecks = scenarios.flatMap((item) => item.acceptance.filter((check) => !check.passed).map((check) => `${item.id}:${check.id}`));
	return {
		schema: "workbench-context-output-evidence-v1",
		generated_at: new Date().toISOString(),
		offline: true,
		model_calls: 0,
		hard_caps: OUTPUT_HARD_CAPS,
		scenarios,
		metrics: {
			per_result_text_bytes: sampleStats(state.perResultBytes),
			per_turn_tool_text_bytes: sampleStats(state.perTurnBytes),
			active_history_tool_text_bytes: sampleStats(state.historyBytes),
			raw_bytes: state.rawBytes,
			shown_bytes: state.shownBytes,
			omitted_bytes: state.omittedBytes,
			blocked_calls: state.blockedCalls,
			session_jsonl_growth_bytes: state.sessionGrowth,
			context_transform_wall_ms: sampleStats(state.contextWallMs),
			log_read_wall_ms: sampleStats(state.logWallMs),
			rss: {
				start_bytes: state.startRss,
				sampled_peak_bytes: state.peakRss,
				max_delta_bytes: state.maxRssDelta,
				sparse_log_child: {
					measurement: "process.resourceUsage().maxRSS",
					baseline_peak_bytes: state.sparseLogChildRss.baselinePeakBytes,
					peak_bytes: state.sparseLogChildRss.peakBytes,
					peak_delta_bytes: state.sparseLogChildRss.peakDeltaBytes,
				},
			},
			provider_payload_structural_bytes: state.providerStructuralBytes,
			provider_usage: { input: state.providerUsage.input, cache_read: state.providerUsage.cacheRead, output: state.providerUsage.output },
			compaction_count: state.compactionCount,
			worker: { success: state.workerSuccess, failure_reason: state.workerSuccess ? "none" : "runner_failure" },
		},
		acceptance: { passed: failedChecks.length === 0 && scenarios.length === CONTEXT_OUTPUT_SCENARIO_IDS.length, checks: scenarios.reduce((sum, item) => sum + item.acceptance.length, 0), failed_checks: failedChecks },
		note: "machine evidence; final Gate and commander review remain authoritative",
	};
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const target = resolve(path);
	const parent = dirname(target);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const temporary = join(parent, `.${relative(parent, target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, target);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}

export function gitText(repoRoot: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
	} catch {
		return "unavailable";
	}
}

export async function buildBenchmarkReport(repoRoot: string, evidence: ContextOutputEvidence): Promise<Record<string, unknown>> {
	const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version?: unknown; devDependencies?: Record<string, unknown> };
	const candidateCommit = gitText(repoRoot, ["rev-parse", "HEAD"]);
	const status = gitText(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	const sourcePaths = [
		"package.json",
		".pi/workbench/recipes.yaml",
		"extensions/workbench-runtime/index.ts",
		"extensions/workbench-runtime/core/output-policy.ts",
		"extensions/workbench-runtime/core/output-envelope.ts",
		"extensions/workbench-runtime/core/output-control-telemetry.ts",
		"extensions/workbench-runtime/core/turn-output-budget.ts",
		"extensions/workbench-runtime/core/bounded-file-io.ts",
		"extensions/workbench-runtime/core/continuation-cursor.ts",
		"extensions/workbench-runtime/core/native-tool-policy.ts",
		"extensions/workbench-runtime/core/details-projection.ts",
		"extensions/workbench-runtime/core/runs.ts",
		"extensions/workbench-runtime/core/run-result.ts",
		"extensions/workbench-runtime/core/delegation-ledger.ts",
		"extensions/workbench-runtime/core/diff-review.ts",
		"extensions/workbench-runtime/core/compare.ts",
		"extensions/workbench-runtime/core/comparison-record.ts",
		"extensions/workbench-runtime/core/context-history-budget.ts",
		"extensions/workbench-runtime/core/render.ts",
		"extensions/workbench-runtime/core/worker-budget.ts",
		"extensions/workbench-runtime/core/worker-policy.ts",
		"extensions/workbench-runtime/core/worker-spend.ts",
		"extensions/workbench-runtime/worker/runner.ts",
		"extensions/workbench-runtime/worker/path-scope.ts",
		"fixtures/context-output/legacy-large-details-session.jsonl",
		"scripts/workbench-session-sanitize.ts",
		"scripts/context-output-evidence.ts",
		"scripts/context-output-benchmark.ts",
	] as const;
	const sourceFiles = await Promise.all(sourcePaths.map(async (path) => {
		const content = await readFile(join(repoRoot, path));
		return { path, bytes: content.length, sha256: sha256(content) };
	}));
	const sourceTreeSha256 = sha256(sourceFiles.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`).join("\n"));
	const fixtureHashes = Object.fromEntries(evidence.scenarios.map((item) => [item.id, item.fixture]));
	return {
		schema: "workbench-context-output-benchmark-v1",
		generated_at: evidence.generated_at,
		baseline_commit: "8ec8c269c6a3ef699c7e8112e8fec75a73fb7c4c",
		candidate_commit: candidateCommit,
		candidate_commit_is_complete_identity: status === "",
		candidate_repository_dirty: status !== "" && status !== "unavailable",
		candidate_repo_status_sha256: sha256(status),
		candidate_source_tree_sha256: sourceTreeSha256,
		candidate_source_files: sourceFiles,
		candidate_effective_identity_sha256: sha256(`${candidateCommit}\0${status}\0${sourceTreeSha256}\0${JSON.stringify(evidence.hard_caps)}`),
		baseline: {
			source: "spec-pinned commit only",
			executed: false,
			comparable: false,
			reason: "This command does not create or execute a baseline checkout; candidate measurements must not be represented as baseline measurements.",
		},
		versions: {
			node: process.version,
			package: typeof pkg.version === "string" ? pkg.version : "unknown",
			pi: typeof pkg.devDependencies?.["@earendil-works/pi-coding-agent"] === "string" ? pkg.devDependencies["@earendil-works/pi-coding-agent"] : "unknown",
		},
		platform: { os: platform(), release: release(), arch: arch() },
		fixture_hashes: fixtureHashes,
		hard_caps: evidence.hard_caps,
		scenarios: evidence.scenarios,
		metrics: evidence.metrics,
		acceptance: evidence.acceptance,
		offline: true,
		model_calls: 0,
		note: "observational machine benchmark; not acceptance evidence and not a substitute for the final Gate",
	};
}
