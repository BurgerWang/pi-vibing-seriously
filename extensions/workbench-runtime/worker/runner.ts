/**
 * Short-lived pinned worker process runner.
 *
 * This is not a daemon or a second framework: one tool invocation spawns one
 * isolated `pi --mode json --no-session` process, consumes its structured
 * event stream, then tears it down. The model selector is pinned and every
 * assistant message is checked for provider/model drift.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { types as utilTypes } from "node:util";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { MAX_WORKER_REPORT_BYTES, workerCacheHitRatio } from "./handoff.ts";
// The deterministic cache-summary presentation moved to worker/handoff.ts
// (the bounded-handoff module); kept re-exported here for callers of the
// runner module.
export { formatWorkerCacheSummary, workerCacheHitRatio } from "./handoff.ts";

import {
	formatWorkerTask,
	resolveWorkerTaskKind,
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_CONTRACT_HASH_ENV,
	WORKER_DELEGATION_ID_ENV,
	WORKER_DEPTH_ENV,
	WORKER_MODEL_ID,
	WORKER_MODEL_SELECTOR,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_PROVIDER,
	WORKER_ROLE,
	WORKER_ROLE_ENV,
	WORKER_TASK_KIND_ENV,
	type WorkerTaskKind,
	type WorkerTaskContract,
} from "../core/worker-policy.ts";
import {
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
} from "../core/delegation-transaction.ts";
import {
	WORKER_HARD_BUDGET,
	workerBudgetBand,
	workerContextRatio,
	workerContextTokens,
} from "../core/worker-budget.ts";
import {
	OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE,
	parseOutputControlTelemetryEntry,
} from "../core/output-control-telemetry.ts";
import {
	EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
	observeWorkerWriteJournalRuntimeEntry,
	type WorkerWriteJournalRuntimeObservation,
} from "../core/worker-write-journal-runtime.ts";
import { WORKER_TURN_MAX_BYTES } from "../core/output-policy.ts";
import {
	addWorkerSpendUsage,
	EMPTY_WORKER_SPEND_STATE,
	formatWorkerSpendHardStop,
	resolveWorkerSpendProfile,
	workerSpendBand,
	workerSpendDimensionFlags,
	workerSpendReasons,
	WORKER_SPEND_PROFILE_ENV,
	type WorkerSpendBand,
	type WorkerSpendDimensionFlags,
	type WorkerSpendProfile,
	type WorkerSpendReason,
	type WorkerSpendState,
} from "../core/worker-spend.ts";
import { readWorkerRepairCapsule, type WorkerRepairAuthorityResult } from "../core/worker-repair-authority.ts";
import type { WorkerRepairCapsule } from "../core/worker-repair-capsule.ts";

export const WORKER_SYSTEM_PROMPT = `You are the Luna implementation worker in pi-dev-workbench.

Sol owns requirements, cross-cutting architecture, approved scope, semantic diff review, final verification, Gates and verdict. You own local design and the complete source+tests+docs slice inside the contract. Stop for unapproved architecture, security/policy, destructive action or scope expansion.

Inspect relevant files, then implement fully: no stubs or TODO shells. Edit/write only approved paths, issue writes sequentially, never delegate, never use free-form bash and never run final Gates. Run only requested declared mutation:none recipes. A repair uses only its bounded authority facts; do not reopen broad diagnosis or infer prior session/report content.

Before the first write, compare planned paths, criteria, requested recipes and remaining spend with the contract; stop if they do not fit. Before reporting, re-read changed paths and check scope, placeholders, generated artifacts and truthful verification without unrelated cleanup.

Use exactly four final headings. Completed, Verification and Remaining Risks: at most 4 single-line bullets, each at most 240 characters. Files Changed: every actual project-relative path, one per bullet with no prose, or \`- None.\`. For each recipe run, Verification uses exactly \`recipe:<name> run:<run-id> outcome:SUCCESS\` or \`... outcome:FAILURE\`; never include logs. Do not repeat the task or criteria.

The report is a handoff, never acceptance evidence. Do not claim final PASS or label criteria satisfied, met, passed, accepted or complete.

Finish with exactly:
## Completed
## Files Changed
## Verification
## Remaining Risks`;

export const WORKER_DIAGNOSIS_SYSTEM_PROMPT = `You are the Luna diagnosis worker in pi-dev-workbench.

Sol owns requirements, architecture, scope, acceptance, final verification, Gates and verdict. Inspect only the approved scope, report bounded observed facts and mark inferences. Stop for mutation, destructive action, security/policy, unapproved architecture or scope expansion.

This task is strictly read-only: never edit, write, create, delete, rename, delegate, use free-form bash or run final Gates. Approved paths are inspection scope, never write authority. Run only requested declared mutation:none recipes. For each run report exactly \`recipe:<name> run:<run-id> outcome:SUCCESS\` or \`... outcome:FAILURE\`; never include logs.

The report is never acceptance evidence. Do not claim final PASS or label criteria satisfied, met, passed, accepted or complete. Use exactly these bounded sections; Files Changed must be exactly \`- None.\`:
## Completed
## Files Changed
- None.
## Verification
## Remaining Risks`;

const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;
const MAX_TASK_ARGUMENT_BYTES = 64 * 1024;
const KILL_GRACE_MS = 5_000;
/** Exact custom-entry identity already emitted by the child runtime. */
const OUTPUT_TURN_TELEMETRY_ENTRY_TYPE = "workbench-output-turn-telemetry-v1";
const WORKER_TOOL_ALLOWLIST = [
	"read",
	"grep",
	"find",
	"ls",
	"edit",
	"write",
	"workbench_project_inspect",
	"workbench_run_recipe",
	"workbench_read_run",
].join(",");
const WORKER_DIAGNOSIS_TOOL_ALLOWLIST = [
	"read",
	"grep",
	"find",
	"ls",
	"workbench_project_inspect",
	"workbench_run_recipe",
	"workbench_read_run",
].join(",");

export interface WorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface WorkerRunResult {
	exitCode: number;
	provider?: string;
	model?: string;
	turns: number;
	stopReason?: string;
	errorMessage?: string;
	output: string;
	/**
	 * The COMPLETE final assistant text retained in process memory for the
	 * durable worker-report.md artifact: bounded only by the JSON-event
	 * input cap (MAX_JSON_LINE_BYTES = 2 MiB) — NEVER pre-truncated to the
	 * report bound, so the ledger can redact FIRST and cap + marker only
	 * after redaction (post-secret tail content survives when redaction
	 * makes the report fit). Intermediate assistant texts never survive
	 * (only the final text wins, exactly like `output`). This text never
	 * enters onUpdate/WorkerProgress.
	 */
	reportText: string;
	/** True when the final assistant text exceeded MAX_WORKER_REPORT_BYTES (raw-byte fact). */
	reportTextOversized: boolean;
	stderr: string;
	aborted: boolean;
	timedOut: boolean;
	modelMismatch?: string;
	/** Diagnosis-only count of distinct structured edit/write tool-call ids. */
	deniedWriteCount: number;
	usage: WorkerUsage;
	/**
	 * cacheRead / (input + cacheRead) over the whole run's aggregated usage;
	 * `null` when the worker reported no input at all (zero denominator).
	 */
	cacheHitRatio: number | null;
	/**
	 * Largest single-message context-token count observed (Pi-compatible
	 * calculation — see core/worker-budget.ts); 0 when no assistant usage.
	 */
	maxContextTokens: number;
	/** maxContextTokens / 272,000 (the Pi-advertised pinned worker context window). */
	maxContextRatio: number;
	/** True when any message reached the 217,600 (80%) soft handoff threshold. */
	softBudgetReached: boolean;
	/** True when any message reached the 244,800 (90%) hard stop threshold. */
	hardBudgetExceeded: boolean;
	/** Number of compaction_start events observed from the child. */
	compactionCount: number;
	/** Distinct compaction reasons in arrival order (manual|threshold|overflow). */
	compactionReasons: string[];
	// ---------------------------------------------------------------- Phase 2
	// Cumulative delegation-spend facts (worker token-budget repair, Phase 2):
	// the profile this run accumulated against, the final cumulative spend
	// state (turns / total / output), the final band, the triggered reasons in
	// the fixed order, and per-dimension soft/hard trigger flags. All facts
	// derive from the pure policy in core/worker-spend.ts and are recorded on
	// EVERY outcome (success, hard stop, compaction, drift, abort, timeout,
	// spawn failure). The profile is the runner-resolved value (deterministic
	// `extended` default when no profile was requested).
	/** Spend profile this run accumulated against (deterministic default: extended). */
	spendProfile: WorkerSpendProfile;
	/** Final cumulative spend state (turns / totalTokens / outputTokens). */
	spendState: WorkerSpendState;
	/** Final cumulative spend band ("ok" | "soft" | "hard"). */
	spendBand: WorkerSpendBand;
	/** Triggered spend dimensions for the final band, fixed order. */
	spendReasons: WorkerSpendReason[];
	/** Per-dimension soft trigger flags at the final spend state. */
	spendSoftReached: WorkerSpendDimensionFlags["soft"];
	/** Per-dimension hard trigger flags at the final spend state. */
	spendHardExceeded: WorkerSpendDimensionFlags["hard"];
	/**
	 * Latest trusted child-runtime output-control observation. The child
	 * extension enforces the caps before provider requests; the runner only
	 * observes the two fixed numeric custom-entry protocols and never treats
	 * this object as a substitute enforcement layer. Optional for source
	 * compatibility with callers that construct legacy failure results.
	 */
	outputControl?: Readonly<WorkerOutputControlFacts>;
	/**
	 * Fixed, content-free observation of the child worker write-journal
	 * protocol. This is observation only; durable journal validation remains
	 * authoritative.
	 */
	writeJournalObservation: Readonly<WorkerWriteJournalRuntimeObservation>;
}

/** Closed, content-free failure categories safe to surface at the public edge. */
export type WorkerRunFailureCode =
	| "COMPACTION_REJECTED"
	| "CONTEXT_HARD_LIMIT"
	| "SPEND_TOTAL_TOKEN_LIMIT"
	| "SPEND_OUTPUT_TOKEN_LIMIT"
	| "SPEND_TURN_LIMIT_LEGACY"
	| "MODEL_IDENTITY_MISMATCH"
	| "ABORTED"
	| "TIMED_OUT"
	| "EXIT_CODE_NONZERO"
	| "STOP_REASON_FAILURE"
	| "PROVIDER_RESPONSE_UNVERIFIED"
	| "FINAL_OUTPUT_MISSING";

export interface WorkerRunFailure {
	readonly code: WorkerRunFailureCode;
	readonly message: string;
}

/** Numeric-only worker output-control observation; no free-form string fits. */
export interface WorkerOutputControlFacts {
	currentToolTextBytes: number;
	collapsedToolResults: number;
	turnReservedBytes: number;
}

export interface WorkerProgress {
	/**
	 * Phase 4 (worker token-budget repair): numeric-only cumulative spend
	 * progress. Every callback carries exactly turns / totalTokens /
	 * outputTokens / spendBand plus the pinned provider/model identity —
	 * never worker text, reasons, report content, tool arguments, patches,
	 * logs, or error prose. All three counters come from ONE cumulative
	 * spend-state snapshot after that assistant message was accumulated and
	 * evaluated (band via the same pure policy), so the final progress tuple
	 * exactly equals the final WorkerRunResult spendState/spendBand facts.
	 * Counters are always finite normalized non-negative numbers; spendBand
	 * is always the fixed `ok` | `soft` | `hard` enum.
	 */
	turns: number;
	/** Cumulative normalized total tokens after this assistant message. */
	totalTokens: number;
	/** Cumulative normalized output tokens after this assistant message. */
	outputTokens: number;
	/** Cumulative spend band after this assistant message (fixed enum). */
	spendBand: WorkerSpendBand;
	/** Latest child context projection gauge (outgoing tool-result text bytes). */
	currentToolTextBytes: number;
	/** Latest cumulative count of tool results collapsed from active history. */
	collapsedToolResults: number;
	/** Reserved bytes in the latest completed child tool batch. */
	turnReservedBytes: number;
	provider?: string;
	model?: string;
}

export interface PiInvocation {
	command: string;
	argsPrefix: string[];
}

export interface WorkerRuntimeIdentity {
	delegationId: string;
	contractHash: string;
}

export interface RunWorkerOptions {
	projectRoot: string;
	contract: WorkerTaskContract;
	timeoutMs: number;
	signal?: AbortSignal;
	onProgress?: (progress: WorkerProgress) => void;
	/** Test seam for a fake JSON-event subprocess. */
	invocation?: PiInvocation;
	/**
	 * Internal cumulative spend profile for this delegation run (worker
	 * token-budget repair, Phase 2). Optional and deterministic: omitted
	 * values, including the retired historical `low` literal, resolve to the
	 * `extended` profile. `standard` is the explicit small-slice profile. The resolved profile is
	 * passed to the child through the fixed WORKER_SPEND_PROFILE_ENV env
	 * contract, so the worker-role lifecycle enforces the SAME profile the
	 * runner accumulates against. Public selection (tool schema) is Phase 3.
	 */
	spendProfile?: WorkerSpendProfile;
	/**
	 * Optional delegation-v2 runtime identity. Direct/legacy calls omit this
	 * object and the runner strips any inherited identity values. Present
	 * values are validated before any child process is launched.
	 */
	runtimeIdentity?: Readonly<WorkerRuntimeIdentity>;
	/** Test seam; production reads only existing immutable repair authority. */
	readRepairAuthority?: (projectRoot: string, repairOf: string) => Promise<WorkerRepairAuthorityResult>;
}

interface AssistantLike {
	role?: unknown;
	content?: unknown;
	provider?: unknown;
	model?: unknown;
	usage?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
}

const EMPTY_OUTPUT_CONTROL_FACTS: Readonly<WorkerOutputControlFacts> = Object.freeze({
	currentToolTextBytes: 0,
	collapsedToolResults: 0,
	turnReservedBytes: 0,
});

const CURRENT_TURN_TELEMETRY_KEYS = [
	"role", "planning", "turnSerial", "maxBytes", "reservationCount", "blockedCalls", "consumedCalls",
	"releasedCalls", "reservedBytes", "consumedBytes", "controlConsumedBytes", "totalAccountedBytes",
	"releasedBytes", "unusedBytes",
] as const;
const CANONICAL_TURN_TELEMETRY_KEYS = [
	"schema", "turnSerial", "role", "planned", "maxBytes", "reservationCount", "blockedCalls", "consumedCalls",
	"releasedCalls", "reservedBytes", "consumedBytes", "controlConsumedBytes", "totalAccountedBytes",
	"releasedBytes", "unusedBytes",
] as const;

/**
 * Return own enumerable data properties only. This parser is deliberately
 * stricter than ordinary JSON access so a future non-JSON test seam cannot
 * invoke getters/proxy traps or smuggle text beside the numeric protocol.
 */
function exactDataRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	try {
		if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const names = Object.keys(descriptors);
		if (names.length !== keys.length || names.some((name) => !keys.includes(name))) return undefined;
		const output: Record<string, unknown> = Object.create(null);
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
			output[key] = descriptor.value;
		}
		return output;
	} catch {
		return undefined;
	}
}

function checkedRuntimeIdentity(value: unknown): Readonly<WorkerRuntimeIdentity> | undefined | false {
	if (value === undefined) return undefined;
	const record = exactDataRecord(value, ["delegationId", "contractHash"]);
	if (record === undefined || typeof record.delegationId !== "string"
		|| !DELEGATION_TRANSACTION_ID_RE.test(record.delegationId)
		|| typeof record.contractHash !== "string"
		|| !DELEGATION_TRANSACTION_HASH_RE.test(record.contractHash)) return false;
	return Object.freeze({ delegationId: record.delegationId, contractHash: record.contractHash });
}

function ownDataValue(value: unknown, key: string): unknown {
	try {
		if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function safeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parse only the child runtime's fixed turn telemetry custom entry. Both
 * the currently persisted enum shape and the canonical core shape are
 * accepted; every other key (including text/args/patch/log/error) rejects
 * the complete entry. The returned value is observation-only.
 */
function parseTurnReservedBytes(entry: unknown): number | undefined {
	if (ownDataValue(entry, "type") !== "custom" || ownDataValue(entry, "customType") !== OUTPUT_TURN_TELEMETRY_ENTRY_TYPE) {
		return undefined;
	}
	const data = ownDataValue(entry, "data");
	const current = exactDataRecord(data, CURRENT_TURN_TELEMETRY_KEYS);
	const canonical = current ? undefined : exactDataRecord(data, CANONICAL_TURN_TELEMETRY_KEYS);
	const record = current ?? canonical;
	if (!record || record.role !== "worker") return undefined;
	if (current && record.planning !== "planned" && record.planning !== "dynamic") return undefined;
	if (canonical && (record.schema !== "workbench-turn-output-telemetry-v1" || typeof record.planned !== "boolean")) return undefined;
	const numericKeys = [
		"turnSerial", "maxBytes", "reservationCount", "blockedCalls", "consumedCalls", "releasedCalls",
		"reservedBytes", "consumedBytes", "controlConsumedBytes", "totalAccountedBytes", "releasedBytes", "unusedBytes",
	] as const;
	for (const key of numericKeys) if (!safeCount(record[key])) return undefined;
	const maxBytes = record.maxBytes as number;
	const reservedBytes = record.reservedBytes as number;
	const totalAccountedBytes = record.totalAccountedBytes as number;
	if (maxBytes !== WORKER_TURN_MAX_BYTES
		|| reservedBytes > maxBytes
		|| totalAccountedBytes > maxBytes
		|| record.releasedBytes !== Math.max(0, reservedBytes - totalAccountedBytes)
		|| record.unusedBytes !== maxBytes - totalAccountedBytes) return undefined;
	return reservedBytes;
}

/** Update only from the two fixed, strictly parsed custom-entry protocols. */
function observeOutputControlEntry(
	entry: unknown,
	current: Readonly<WorkerOutputControlFacts>,
): Readonly<WorkerOutputControlFacts> {
	const snapshot = parseOutputControlTelemetryEntry(entry);
	if (snapshot?.role === "worker") {
		return Object.freeze({
			currentToolTextBytes: snapshot.activeHistoryToolTextBytes,
			collapsedToolResults: snapshot.totals.historyCollapsedResults,
			turnReservedBytes: current.turnReservedBytes,
		});
	}
	const turnReservedBytes = parseTurnReservedBytes(entry);
	if (turnReservedBytes === undefined) return current;
	return Object.freeze({ ...current, turnReservedBytes });
}

function emptyUsage(): WorkerUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addUsage(target: WorkerUsage, raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const usage = raw as Record<string, unknown>;
	target.input += finiteNumber(usage.input);
	target.output += finiteNumber(usage.output);
	target.cacheRead += finiteNumber(usage.cacheRead);
	target.cacheWrite += finiteNumber(usage.cacheWrite);
	target.totalTokens += finiteNumber(usage.totalTokens);
	if (usage.cacheWrite1h !== undefined) target.cacheWrite1h = (target.cacheWrite1h ?? 0) + finiteNumber(usage.cacheWrite1h);
	if (usage.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + finiteNumber(usage.reasoning);
	if (usage.cost && typeof usage.cost === "object") {
		const cost = usage.cost as Record<string, unknown>;
		target.cost.input += finiteNumber(cost.input);
		target.cost.output += finiteNumber(cost.output);
		target.cost.cacheRead += finiteNumber(cost.cacheRead);
		target.cost.cacheWrite += finiteNumber(cost.cacheWrite);
		target.cost.total += finiteNumber(cost.total);
	}
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/**
 * Observe only Pi's typed toolCall identity/name fields. Arguments and prose
 * are deliberately ignored; stable ids make duplicate message events idempotent.
 */
function observeDiagnosisWriteAttempts(content: unknown, ids: Set<string>): void {
	if (!Array.isArray(content)) return;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const candidate = part as { type?: unknown; id?: unknown; name?: unknown };
		if (
			candidate.type === "toolCall" &&
			(candidate.name === "edit" || candidate.name === "write")
		) {
			const validId =
				typeof candidate.id === "string" &&
				candidate.id.length > 0 &&
				candidate.id.length <= 256 &&
				candidate.id.trim() === candidate.id &&
				!/[\u0000-\u001f\u007f]/.test(candidate.id);
			const key = validId
				? `id:${candidate.id}`
				: `invalid:${candidate.name}`;
			ids.add(key);
		}
	}
}

/** Resolve the same executable/script pair that launched the current Pi process. */
export function resolvePiInvocation(): PiInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, argsPrefix: [currentScript] };
	}
	const executableName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executableName)) {
		return { command: process.execPath, argsPrefix: [] };
	}
	return { command: "pi", argsPrefix: [] };
}

function childEnvironment(
	projectRoot: string,
	allowedPaths: readonly string[],
	spendProfile: WorkerSpendProfile,
	taskKind: WorkerTaskKind,
	runtimeIdentity: Readonly<WorkerRuntimeIdentity> | undefined,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// Parent-session identity/model facts must never masquerade as child facts.
	for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
		delete env[key];
	}
	// Delegation-v2 identity is never inherited. Legacy/direct runner calls
	// omit it and therefore always launch with both keys absent.
	delete env[WORKER_DELEGATION_ID_ENV];
	delete env[WORKER_CONTRACT_HASH_ENV];
	env[WORKER_ROLE_ENV] = WORKER_ROLE;
	env[WORKER_DEPTH_ENV] = "1";
	env[WORKER_PROJECT_ROOT_ENV] = projectRoot;
	env[WORKER_ALLOWED_PATHS_ENV] = JSON.stringify(allowedPaths);
	env[WORKER_TASK_KIND_ENV] = taskKind;
	// Phase 2: the fixed spend-profile child env contract — the runner ALWAYS
	// writes a valid resolved profile value here (never empty/malformed).
	env[WORKER_SPEND_PROFILE_ENV] = spendProfile;
	if (runtimeIdentity !== undefined) {
		env[WORKER_DELEGATION_ID_ENV] = runtimeIdentity.delegationId;
		env[WORKER_CONTRACT_HASH_ENV] = runtimeIdentity.contractHash;
	}
	return env;
}

export function workerRunFailure(result: WorkerRunResult): WorkerRunFailure | undefined {
	// Any compaction attempt or hard-budget stop fails closed, regardless of
	// the child's eventual exit code: a worker must never silently continue
	// through lossy compaction or past the pinned 90% hard budget.
	if (result.compactionCount > 0) {
		return {
			code: "COMPACTION_REJECTED",
			message: `Pinned worker attempted context compaction (${result.compactionReasons.join(", ") || "unknown reason"}) — fail closed`,
		};
	}
	if (result.hardBudgetExceeded) {
		return {
			code: "CONTEXT_HARD_LIMIT",
			message: `Pinned worker exceeded the ${WORKER_HARD_BUDGET}-token hard context budget — fail closed`,
		};
	}
	// Cumulative total/output tokens remain true hard resource ceilings.
	// Turn thresholds are retained in persisted telemetry for historical
	// compatibility, but a tool-heavy run is no longer killed solely because
	// it processed many small assistant messages.
	if (result.spendHardExceeded.totalTokens || result.spendHardExceeded.outputTokens) {
		return {
			code: result.spendHardExceeded.totalTokens ? "SPEND_TOTAL_TOKEN_LIMIT" : "SPEND_OUTPUT_TOKEN_LIMIT",
			message: formatWorkerSpendHardStop(result.spendState, result.spendProfile),
		};
	}
	// Old runtimes terminated on the turn marker. Recognize their bounded,
	// deterministic signature so a reloaded controller can diagnose the
	// historical result accurately instead of blaming the provider.
	if (
		result.spendHardExceeded.turns &&
		result.exitCode !== 0 &&
		result.errorMessage?.startsWith("Worker cumulative spend hard budget reached")
	) {
		return {
			code: "SPEND_TURN_LIMIT_LEGACY",
			message: result.errorMessage,
		};
	}
	if (result.modelMismatch) return { code: "MODEL_IDENTITY_MISMATCH", message: result.modelMismatch };
	if (result.aborted) return { code: "ABORTED", message: "Pinned worker was aborted" };
	if (result.timedOut) return { code: "TIMED_OUT", message: "Pinned worker timed out" };
	if (result.exitCode !== 0) {
		return {
			code: "EXIT_CODE_NONZERO",
			message: result.errorMessage ?? `Pinned worker exited with code ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ""}`,
		};
	}
	if (result.stopReason === "error" || result.stopReason === "aborted") {
		return {
			code: "STOP_REASON_FAILURE",
			message: result.errorMessage ?? `Pinned worker stopped with ${result.stopReason}`,
		};
	}
	if (result.stopReason === "toolUse") {
		return { code: "FINAL_OUTPUT_MISSING", message: "Pinned worker exited before a terminal assistant response" };
	}
	if (result.provider !== WORKER_PROVIDER || result.model !== WORKER_MODEL_ID) {
		return {
			code: "PROVIDER_RESPONSE_UNVERIFIED",
			message: `Pinned worker produced no verified ${WORKER_PROVIDER}/${WORKER_MODEL_ID} assistant response`,
		};
	}
	if (!result.output) return { code: "FINAL_OUTPUT_MISSING", message: "Pinned worker produced no final text output" };
	return undefined;
}

export function assertWorkerSucceeded(result: WorkerRunResult): void {
	const failure = workerRunFailure(result);
	if (failure) throw new Error(failure.message);
}

export async function runPinnedWorker(options: RunWorkerOptions): Promise<WorkerRunResult> {
	const runtimeIdentity = checkedRuntimeIdentity(options.runtimeIdentity);
	if (runtimeIdentity === false) throw new Error("Worker runtime identity is invalid");
	const taskKindResult = resolveWorkerTaskKind(options.contract.taskKind);
	if (!taskKindResult.ok) throw new Error(taskKindResult.error);
	const taskKind = taskKindResult.taskKind;
	// Deterministic active-profile resolution: omitted, malformed, and the
	// retired historical `low` value all resolve to the safe `extended`
	// default; explicit `standard` selects the smaller bounded-slice profile.
	const spendProfile = resolveWorkerSpendProfile(options.spendProfile);
	let repairCapsule: WorkerRepairCapsule | undefined;
	if (options.contract.repairOf !== undefined) {
		const authority = await (options.readRepairAuthority ?? readWorkerRepairCapsule)(options.projectRoot, options.contract.repairOf);
		if (!authority.ok) throw new Error(`Worker repair authority is ${authority.code}`);
		repairCapsule = authority.capsule;
	}
	// Render the same active profile used by the runner and child env. This
	// prevents an old/internal `low` contract from advertising a retired
	// budget while actually running under the defensive standard fallback.
	const taskText = formatWorkerTask({
		...options.contract,
		budgetProfile: spendProfile,
		...(repairCapsule === undefined ? {} : { repairCapsule }),
	});
	if (Buffer.byteLength(taskText, "utf8") > MAX_TASK_ARGUMENT_BYTES) {
		throw new Error(`Worker task contract exceeds ${MAX_TASK_ARGUMENT_BYTES} bytes`);
	}
	const promptDir = await mkdtemp(join(tmpdir(), "pi-workbench-worker-"));
	const promptPath = join(promptDir, "worker-system.md");
	const systemPrompt = taskKind === "diagnosis" ? WORKER_DIAGNOSIS_SYSTEM_PROMPT : WORKER_SYSTEM_PROMPT;
	const toolAllowlist = taskKind === "diagnosis" ? WORKER_DIAGNOSIS_TOOL_ALLOWLIST : WORKER_TOOL_ALLOWLIST;
	await writeFile(promptPath, systemPrompt, { encoding: "utf8", mode: 0o600 });

	const invocation = options.invocation ?? resolvePiInvocation();
	const args = [
		...invocation.argsPrefix,
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--approve",
		"--tools",
		toolAllowlist,
		"--model",
		WORKER_MODEL_SELECTOR,
		"--append-system-prompt",
		promptPath,
		taskText,
	];

	const result: WorkerRunResult = {
		exitCode: 1,
		turns: 0,
		output: "",
		reportText: "",
		reportTextOversized: false,
		stderr: "",
		aborted: false,
		timedOut: false,
		deniedWriteCount: 0,
		usage: emptyUsage(),
		cacheHitRatio: null,
		maxContextTokens: 0,
		maxContextRatio: 0,
		softBudgetReached: false,
		hardBudgetExceeded: false,
		compactionCount: 0,
		compactionReasons: [],
		spendProfile,
		spendState: { ...EMPTY_WORKER_SPEND_STATE },
		spendBand: "ok",
		spendReasons: [],
		spendSoftReached: { turns: false, totalTokens: false, outputTokens: false },
		spendHardExceeded: { turns: false, totalTokens: false, outputTokens: false },
		outputControl: EMPTY_OUTPUT_CONTROL_FACTS,
		writeJournalObservation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
	};

	try {
		await new Promise<void>((resolvePromise) => {
			const diagnosisWriteAttemptIds = new Set<string>();
			const child = spawn(invocation.command, args, {
				cwd: options.projectRoot,
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnvironment(options.projectRoot, options.contract.allowedPaths, spendProfile, taskKind, runtimeIdentity),
			});
			let stdoutBuffer = "";
			let stderrBuffer = "";
			let settled = false;
			let terminating = false;
			let streamInvalid = false;
			let killTimer: NodeJS.Timeout | undefined;
			const signalProcessTree = (value: NodeJS.Signals): void => {
				try {
					if (process.platform !== "win32" && typeof child.pid === "number") process.kill(-child.pid, value);
					else child.kill(value);
				} catch {
					try { child.kill(value); } catch { /* process already exited */ }
				}
			};

			const terminate = (reason: "abort" | "timeout" | "error") => {
				if (reason === "abort") result.aborted = true;
				else if (reason === "timeout") result.timedOut = true;
				if (terminating) return;
				terminating = true;
				signalProcessTree("SIGTERM");
				killTimer = setTimeout(() => {
					// On POSIX the group can outlive its leader, so do not gate the
					// final signal on the leader's exitCode.
					if (process.platform !== "win32" || (child.exitCode === null && child.signalCode === null)) {
						signalProcessTree("SIGKILL");
					}
				}, KILL_GRACE_MS);
				killTimer.unref();
			};

			const abortListener = () => terminate("abort");
			if (options.signal?.aborted) abortListener();
			else options.signal?.addEventListener("abort", abortListener, { once: true });
			const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
			timeout.unref();

			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (killTimer) clearTimeout(killTimer);
				options.signal?.removeEventListener("abort", abortListener);
				result.stderr = truncateTail(stderrBuffer, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content;
				resolvePromise();
			};

			let outputControl: Readonly<WorkerOutputControlFacts> = EMPTY_OUTPUT_CONTROL_FACTS;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) {
					streamInvalid = true;
					result.errorMessage = `Worker JSON event exceeded ${MAX_JSON_LINE_BYTES} bytes`;
					terminate("error");
					return;
				}
				let event: { type?: unknown; message?: unknown; reason?: unknown; entry?: unknown };
				try {
					event = JSON.parse(line) as { type?: unknown; message?: unknown; reason?: unknown; entry?: unknown };
				} catch {
					return;
				}
				// Observation only: the child extension already enforced history/turn
				// limits before the provider request. The runner trusts exactly two
				// fixed custom-entry schemas and retains numeric/enum facts only.
				if (event.type === "entry_appended") {
					result.writeJournalObservation = observeWorkerWriteJournalRuntimeEntry(
						event.entry,
						result.writeJournalObservation,
					);
					outputControl = observeOutputControlEntry(event.entry, outputControl);
					result.outputControl = outputControl;
					return;
				}
				// Pi emits compaction_start before compacting. The worker extension
				// cancels compaction in-process; if an event still arrives, the
				// child must never continue through lossy compaction — count it,
				// record the reason, terminate, and fail the result closed.
				if (event.type === "compaction_start") {
					const reason = event.reason === "manual" || event.reason === "threshold" || event.reason === "overflow" ? event.reason : "unknown";
					result.compactionCount += 1;
					if (!result.compactionReasons.includes(reason)) result.compactionReasons.push(reason);
					result.errorMessage = `Pinned worker attempted context compaction (${reason}) — fail closed`;
					terminate("error");
					return;
				}
				if (event.type !== "message_end" || !event.message || typeof event.message !== "object") return;
				const message = event.message as AssistantLike;
				if (message.role !== "assistant") return;
				if (taskKind === "diagnosis") {
					observeDiagnosisWriteAttempts(message.content, diagnosisWriteAttemptIds);
					result.deniedWriteCount = diagnosisWriteAttemptIds.size;
				}
				result.turns += 1;
				addUsage(result.usage, message.usage);
				// Pinned worker context-budget tracking (per message, Pi-compatible
				// tokens): record the max tokens/ratio, flag the 80% soft handoff,
				// and terminate fail-closed at the 90% hard stop.
				const contextTokens = workerContextTokens(message.usage);
				if (contextTokens > result.maxContextTokens) {
					result.maxContextTokens = contextTokens;
					result.maxContextRatio = workerContextRatio(contextTokens);
				}
				const budgetBand = workerBudgetBand(contextTokens);
				if (budgetBand !== "ok") result.softBudgetReached = true;
				if (budgetBand === "hard") {
					result.hardBudgetExceeded = true;
					result.errorMessage = `Pinned worker exceeded the ${WORKER_HARD_BUDGET}-token hard context budget — fail closed`;
					terminate("error");
				}
				// Phase 2 cumulative spend accounting (independent of the per-message
				// context safety above): every assistant message increments the
				// cumulative spend state exactly once via the pure policy — turns + 1,
				// normalized total/output added (positive totalTokens authoritative,
				// else the non-negative component sum; cacheRead counts; malformed
				// usage contributes zero but still counts the turn — never NaN). Any
				// cumulative total/output hard dimension reached (`>=`) terminates the
				// child fail-closed with the deterministic hard-stop message. Turns
				// remain an advisory/telemetry marker: tool-heavy development must not
				// be killed solely for crossing an arbitrary message count.
				result.spendState = addWorkerSpendUsage(result.spendState, message.usage);
				const spendFlags = workerSpendDimensionFlags(result.spendState, spendProfile);
				if (spendFlags.hard.totalTokens || spendFlags.hard.outputTokens) {
					result.errorMessage = formatWorkerSpendHardStop(result.spendState, spendProfile);
					terminate("error");
				}
				const provider = typeof message.provider === "string" ? message.provider : undefined;
				const model = typeof message.model === "string" ? message.model : undefined;
				if (provider) result.provider = provider;
				if (model) result.model = model;
				if ((provider && provider !== WORKER_PROVIDER) || (model && model !== WORKER_MODEL_ID)) {
					result.modelMismatch = `Worker model drift: expected ${WORKER_PROVIDER}/${WORKER_MODEL_ID}, received ${provider ?? "(none)"}/${model ?? "(none)"}`;
					terminate("error");
				}
				if (typeof message.stopReason === "string") result.stopReason = message.stopReason;
				if (typeof message.errorMessage === "string") result.errorMessage = message.errorMessage;
				const text = textFromContent(message.content);
				if (text) {
					const view = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
					result.output = view.truncated
						? `${view.content}\n\n[Worker output truncated to ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES} bytes.]`
						: view.content;
					// Retain the COMPLETE final assistant text for worker-report.md
					// persistence — bounded only by the bounded JSON-event input
					// (MAX_JSON_LINE_BYTES = 2 MiB), NEVER pre-truncated to the
					// report bound: redaction happens BEFORE any truncation in the
					// ledger, so content after long secrets survives when redaction
					// makes the report fit. The oversized flag is the raw-byte fact;
					// this is a private child-local variable — it never enters
					// onUpdate.
					result.reportText = text;
					result.reportTextOversized = Buffer.byteLength(text, "utf8") > MAX_WORKER_REPORT_BYTES;
				}
				// Phase 4: the progress tuple is built AFTER the message was
				// accumulated/evaluated above, from the SAME cumulative spend
				// state the final result facts derive from — every tuple matches
				// the final ledger counters at the last event, hard stops
				// included (the callback still runs after terminate()). Numeric
				// counters only plus the pinned identity: never text of any kind.
				options.onProgress?.({
					turns: result.spendState.turns,
					totalTokens: result.spendState.totalTokens,
					outputTokens: result.spendState.outputTokens,
					spendBand: workerSpendBand(result.spendState, spendProfile),
					currentToolTextBytes: outputControl.currentToolTextBytes,
					collapsedToolResults: outputControl.collapsedToolResults,
					turnReservedBytes: outputControl.turnReservedBytes,
					provider: result.provider,
					model: result.model,
				});
			};

			child.stdout.on("data", (chunk: Buffer | string) => {
				if (streamInvalid) return;
				stdoutBuffer += chunk.toString();
				if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_JSON_LINE_BYTES && !stdoutBuffer.includes("\n")) {
					streamInvalid = true;
					result.errorMessage = `Worker JSON event exceeded ${MAX_JSON_LINE_BYTES} bytes`;
					terminate("error");
					return;
				}
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) {
					processLine(line);
					if (streamInvalid) break;
				}
			});
			child.stderr.on("data", (chunk: Buffer | string) => {
				stderrBuffer += chunk.toString();
				if (Buffer.byteLength(stderrBuffer, "utf8") > DEFAULT_MAX_BYTES * 2) {
					stderrBuffer = truncateTail(stderrBuffer, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content;
				}
			});
			child.on("error", (error) => {
				result.errorMessage = `Failed to spawn pinned worker: ${error.message}`;
				result.exitCode = 1;
				finish();
			});
			child.on("exit", () => {
				// A successful worker process may still have spawned background
				// descendants. They have no authority after the pinned worker exits.
				if (process.platform !== "win32" && typeof child.pid === "number") {
					try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already empty */ }
				}
			});
			child.on("close", (code) => {
				if (!streamInvalid && stdoutBuffer.trim()) processLine(stdoutBuffer);
				result.exitCode = code ?? 1;
				finish();
			});
		});
		result.cacheHitRatio = workerCacheHitRatio(result.usage);
		// Phase 2: record the deterministic FINAL spend facts (profile, state,
		// band, fixed-order reasons, per-dimension soft/hard flags) from the
		// final cumulative state on every outcome.
		const finalSpendFlags = workerSpendDimensionFlags(result.spendState, spendProfile);
		result.spendBand = workerSpendBand(result.spendState, spendProfile);
		result.spendReasons = workerSpendReasons(result.spendState, spendProfile);
		result.spendSoftReached = finalSpendFlags.soft;
		result.spendHardExceeded = finalSpendFlags.hard;
		return result;
	} finally {
		await rm(promptDir, { recursive: true, force: true });
	}
}
