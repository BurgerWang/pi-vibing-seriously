/**
 * NRO DEV-pilot collector — DEV EVIDENCE ONLY, NEVER FINAL EVIDENCE.
 *
 * This module is the DEV-pilot collection harness for the Commander Native
 * Tool Optimization (NRO) plan (`docs/plans/commander-native-tool-
 * optimization.md`, protocol `docs/baselines/commander-native-tool-
 * benchmark-protocol.md`). It drives the two DEV-pilot arms against the
 * frozen milestone prompt and fixture:
 *
 *   - control:    `scripts/commander-native-tool-control-extension.ts`
 *                 (DEV-pilot control approximation — never final evidence);
 *   - treatment:  `extensions/workbench-runtime/index.ts` (the CURRENT
 *                 normal workbench runtime extension, unchanged).
 *
 * It is a DEV/approximation artifact only:
 *   - it is intentionally SIMPLER than the final evidence pipeline: no
 *     rubric correctness, no pagination facts, no cost/bytes breakdown,
 *     no deviations document, no manifest — raw retention + a strict
 *     chronological collection record only;
 *   - it never produces or claims final-arm or adoption evidence: dev
 *     records stay `phase: "dev"` and the offline analyzer reports dev
 *     verdicts as NOT_MEASURED;
 *   - it must never be wired into a production/acceptance configuration.
 *
 * Collection discipline (fixed, frozen):
 *   - exactly 8 valid sessions in the frozen ABBA order
 *     (abbaArmAt(1..8) = control, treatment, treatment, control, control,
 *     treatment, treatment, control);
 *   - at most 12 paid attempts; an invalid attempt retries the SAME
 *     required arm; every produced raw Pi session is retained — valid
 *     ones as `kind: "session"` (advancing the ABBA position), invalid
 *     ones as `kind: "attempt"` (position unchanged);
 *   - output root `.pi/workbench/runs/commander-native-tool-dev-pilot-
 *     collection/` is created EXCLUSIVELY (an existing output fails
 *     closed); it maintains `sources/raw-<NN>-<arm>.jsonl` (byte-exact
 *     copies of every produced raw session, deterministic names) and
 *     `collection-record.json` (strict schema_version 1, phase "dev",
 *     frozen non-treatment pin, chronological entries), atomically
 *     rewritten and validated with `parseCollectionRecord` after every
 *     attempt — so a partial collection stays truthful after a failure
 *     or after the 12-attempt cap.
 *
 * Each attempt spawns the real pi CLI directly (shell:false, stdin
 * ignored, exact frozen argv/env, inherited credentials, per-attempt
 * timeout with termination, hard stdout/stderr byte caps) with a fresh
 * session dir under the output root, then requires exactly one direct
 * regular bounded .jsonl session file in that dir (zero or multiple
 * fails closed without inventing evidence). A valid session requires
 * process exit 0 plus the strict session checks: JSONL/entry validity,
 * exact extracted prompt hash, pinned model identity, pinned thinking
 * level, zero compactions, terminal assistant stop.
 *
 * Privacy: stdout carries bounded relative facts only (status, valid,
 * attempts, collection path relative to the project); diagnostics go to
 * stderr — never prompt/session content, credentials, or absolute
 * paths.
 *
 * CLI: no arguments. `--help`/`-h` exit 0; any other argument is a
 * usage error (exit 2); runtime failures exit 1; completing all 8 valid
 * sessions exits 0; reaching the 12-attempt cap exits 1 with the
 * truthful partial collection.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	COLLECTION_RECORD_NAME,
	COLLECTION_SCHEMA_VERSION,
	FIXTURE_DIR_NAME,
	FROZEN_NRO_PROTOCOL,
	NroError,
	SESSION_MAX_BYTES,
	abbaArmAt,
	extractPromptText,
	parseCollectionRecord,
	parseSessionLines,
	preflightInputs,
	requireFrozenProtocol,
	scanEnvironment,
	sha256Hex,
	terminalStateOf,
	validateEntries,
} from "./commander-native-tool-benchmark.ts";
import type { ArmName, CollectionEntryKind, CollectionRecord, FrozenProtocol } from "./commander-native-tool-benchmark.ts";

// ---------------------------------------------------------------------------
// Fixed DEV-pilot constants (frozen)
// ---------------------------------------------------------------------------

/** Exactly 8 valid sessions: the frozen ABBA pattern repeated twice (positions 1..8). */
export const DEV_PILOT_VALID_SESSIONS = 8;
/** Hard cap on paid attempts: at most 12. */
export const DEV_PILOT_MAX_ATTEMPTS = 12;
/** Output root basename under `<runs dir>` — created exclusively. */
export const OUTPUT_ROOT_NAME = "commander-native-tool-dev-pilot-collection";
/** Retained raw sessions live under this directory inside the output root. */
export const SOURCES_DIR_NAME = "sources";
/** Collection record phase (dev evidence is never final). */
export const DEV_PILOT_PHASE = "dev" as const;
/** Per-attempt wall-clock budget (30 minutes). */
export const ATTEMPT_TIMEOUT_MS = 30 * 60 * 1000;
/** Grace after SIGTERM before SIGKILL on timeout (5 seconds). */
export const TERMINATE_GRACE_MS = 5_000;
/** Hard stdout capture cap per attempt (64 KiB). */
export const ATTEMPT_STDOUT_MAX_BYTES = 64 * 1024;
/** Hard stderr capture cap per attempt (256 KiB). */
export const ATTEMPT_STDERR_MAX_BYTES = 256 * 1024;
/** Fresh per-attempt session dir prefix (inside the output root). */
export const SESSION_DIR_PREFIX = ".attempt-";
const SESSION_DIR_SUFFIX = "-session";

/** Structured pilot failure — fail closed, never a partial report. */
export type PilotErrorCode = "EXISTING_OUTPUT" | "SPAWN_FAILED" | "SESSION_FILE_COUNT" | "SOURCE_IO" | "RECORD_IO" | "RECORD_INVALID" | "IO_ERROR";

export class PilotError extends Error {
	readonly code: PilotErrorCode;
	constructor(code: PilotErrorCode, message: string) {
		super(message);
		this.name = "PilotError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Fixed plan and attempt identity (pure, deterministic)
// ---------------------------------------------------------------------------

/**
 * The fixed valid-session plan: the arm required at each 1-based ABBA
 * position 1..8, derived from the frozen `abbaArmAt` — exactly
 * control, treatment, treatment, control, control, treatment, treatment,
 * control. An invalid attempt does not advance; the next attempt retries
 * the SAME required arm (`plan[validSessions]`).
 */
export function fixedPlan(): readonly ArmName[] {
	const arms: ArmName[] = [];
	for (let i = 1; i <= DEV_PILOT_VALID_SESSIONS; i += 1) {
		arms.push(abbaArmAt(i));
	}
	return arms;
}

/** Zero-padded two-digit attempt label (01..12). */
export function attemptLabel(attempt: number): string {
	return String(attempt).padStart(2, "0");
}

/** Frozen per-attempt pi session name: `nro-dev-pilot-<NN>-<arm>`. */
export function attemptName(attempt: number, arm: ArmName): string {
	return `nro-dev-pilot-${attemptLabel(attempt)}-${arm}`;
}

/** Deterministic retained raw source name: `raw-<NN>-<arm>.jsonl`. */
export function rawSourceName(attempt: number, arm: ArmName): string {
	return `raw-${attemptLabel(attempt)}-${arm}.jsonl`;
}

/** Fresh per-attempt session dir basename: `.attempt-<NN>-session`. */
export function attemptSessionDirName(attempt: number): string {
	return `${SESSION_DIR_PREFIX}${attemptLabel(attempt)}${SESSION_DIR_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Attempt argv/env builders (pure, exact)
// ---------------------------------------------------------------------------

export interface BuildAttemptArgvOptions {
	/** Absolute path of the arm extension file (control approximation or treatment runtime). */
	extensionPath: string;
	/** Absolute fresh per-attempt session dir under the output root. */
	sessionDir: string;
	/** 1-based attempt number (01..12 in labels). */
	attemptNumber: number;
	arm: ArmName;
	/** The raw milestone prompt text — the SOLE positional message, byte-exact. */
	promptText: string;
	protocol?: FrozenProtocol;
}

/**
 * The exact production attempt argv (pi 0.83.0 CLI contract):
 * `--print --approve --no-extensions --extension <arm> --model <pinned>
 * --thinking <pinned> --session-dir <fresh dir> --name
 * nro-dev-pilot-<NN>-<arm> --tools read,grep <raw milestone prompt>`.
 * The prompt is the sole positional message; every other token is a
 * flag/value pair in this exact order. `--print` is followed by
 * `--approve` (a dash-prefixed token), so pi's `--print` message
 * consumption never swallows the prompt.
 */
export function buildAttemptArgv(opts: BuildAttemptArgvOptions): string[] {
	const protocol = opts.protocol ?? FROZEN_NRO_PROTOCOL;
	return [
		"--print",
		"--approve",
		"--no-extensions",
		"--extension",
		opts.extensionPath,
		"--model",
		protocol.environment.modelKey,
		"--thinking",
		protocol.environment.thinkingLevel,
		"--session-dir",
		opts.sessionDir,
		"--name",
		attemptName(opts.attemptNumber, opts.arm),
		"--tools",
		"read,grep",
		opts.promptText,
	];
}

/**
 * The exact production attempt env: the inherited base environment
 * (credentials included) with `PI_SKIP_VERSION_CHECK=1` and
 * `PI_TELEMETRY=0` pinned. Arm-independent by construction (identical
 * env for control and treatment attempts).
 */
export function buildAttemptEnv(base: NodeJS.ProcessEnv): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined) env[key] = value;
	}
	env.PI_SKIP_VERSION_CHECK = "1";
	env.PI_TELEMETRY = "0";
	return env;
}

// ---------------------------------------------------------------------------
// Session validity classifier (pure)
// ---------------------------------------------------------------------------

/** Invalid-attempt reason tags (dev-pilot granularity; simpler than final evidence). */
export type SessionInvalidReason = "timeout" | "exit" | "malformed" | "prompt" | "model" | "thinking" | "compaction" | "terminal";

export interface SessionVerdict {
	valid: boolean;
	/** Non-null exactly when invalid. */
	reason: SessionInvalidReason | null;
	/** Bounded diagnostic detail (never session/prompt content). */
	detail: string | null;
}

export interface ClassifySessionInput {
	/** Process exit code; null when the process was killed by a signal. */
	exitCode: number | null;
	/** True when the attempt exceeded its time budget and was terminated. */
	timedOut: boolean;
	/** Raw bytes of the produced session file. */
	raw: Buffer;
	protocol: FrozenProtocol;
}

const DETAIL_MAX_CHARS = 160;

/** Bounded, control-character-safe diagnostic detail. */
function boundDetail(text: string): string {
	const cleaned = text.replace(/[\x00-\x1f\x7f]/g, " ");
	return cleaned.length <= DETAIL_MAX_CHARS ? cleaned : `${cleaned.slice(0, DETAIL_MAX_CHARS - 1)}…`;
}

/**
 * Fail-closed session validity, in this exact order: timeout, process
 * exit 0, strict JSONL/entries, exact extracted prompt hash, pinned
 * model identity, pinned thinking level, zero compactions, terminal
 * assistant stop. Every produced-but-invalid session is retained as
 * `kind: "attempt"`; only a verdict of `valid: true` advances the ABBA
 * position.
 */
export function classifySession(input: ClassifySessionInput): SessionVerdict {
	const { protocol } = input;
	if (input.timedOut) {
		return { valid: false, reason: "timeout", detail: "attempt exceeded its time budget and was terminated" };
	}
	if (input.exitCode !== 0) {
		return { valid: false, reason: "exit", detail: `process exit code ${input.exitCode ?? "none"}` };
	}
	let entries: unknown[];
	try {
		entries = parseSessionLines(input.raw.toString("utf8"), "pilot-session");
		validateEntries(entries, "pilot-session", true);
	} catch (error) {
		return { valid: false, reason: "malformed", detail: error instanceof Error ? boundDetail(error.message) : null };
	}
	let promptText: string;
	try {
		promptText = extractPromptText(entries);
	} catch {
		return { valid: false, reason: "malformed", detail: "no user message found" };
	}
	if (sha256Hex(promptText) !== protocol.milestonePromptSha256) {
		return { valid: false, reason: "prompt", detail: "first user-message text does not match the frozen milestone prompt" };
	}
	const envScan = scanEnvironment(entries);
	if (envScan.modelKeys.length === 0 || envScan.modelKeys.some((key) => key !== protocol.environment.modelKey)) {
		return { valid: false, reason: "model", detail: "assistant model identity does not match the pinned model key" };
	}
	if (envScan.thinkingLevel === null || envScan.thinkingLevel !== protocol.environment.thinkingLevel) {
		return { valid: false, reason: "thinking", detail: "recorded thinking level does not match the pinned level" };
	}
	const terminal = terminalStateOf(entries);
	if (terminal.compactionCount !== 0) {
		return { valid: false, reason: "compaction", detail: `${terminal.compactionCount} compaction(s) present` };
	}
	if (!terminal.terminalStop || terminal.aborted || terminal.errored) {
		return { valid: false, reason: "terminal", detail: "no terminal assistant stop response" };
	}
	return { valid: true, reason: null, detail: null };
}

// ---------------------------------------------------------------------------
// Attempt runner (production: direct spawn with caps and timeout)
// ---------------------------------------------------------------------------

export interface AttemptOutput {
	/** Captured bytes (bounded by the hard cap). */
	bytes: Buffer;
	/** True when more bytes arrived after the cap — the capture is truncated. */
	overflow: boolean;
}

export interface SpawnedAttemptResult {
	exitCode: number | null;
	timedOut: boolean;
	/** Non-null when the process could not be started at all. */
	spawnError: string | null;
	stdout: AttemptOutput;
	stderr: AttemptOutput;
}

export interface AttemptRunRequest {
	/** Absolute path of the pi binary (`node_modules/.bin/pi`). */
	program: string;
	/** Exact attempt argv (without the program). */
	argv: string[];
	/** Exact attempt env (inherited + pilot pins). */
	env: Record<string, string>;
	/** Frozen fixture working directory. */
	cwd: string;
	timeoutMs: number;
	terminateGraceMs: number;
	stdoutMaxBytes: number;
	stderrMaxBytes: number;
}

export type AttemptRunner = (request: AttemptRunRequest) => Promise<SpawnedAttemptResult>;

/** Hard-capped byte capture (pure, testable). */
export interface CappedCapture {
	push(chunk: Buffer): void;
	result(): AttemptOutput;
}

export function createCappedCapture(maxBytes: number): CappedCapture {
	const chunks: Buffer[] = [];
	let total = 0;
	let overflow = false;
	return {
		push(chunk) {
			if (overflow) return;
			if (total + chunk.length > maxBytes) {
				const room = Math.max(0, maxBytes - total);
				if (room > 0) {
					chunks.push(chunk.subarray(0, room));
					total += room;
				}
				overflow = true;
				return;
			}
			chunks.push(chunk);
			total += chunk.length;
		},
		result() {
			return { bytes: Buffer.concat(chunks, total), overflow };
		},
	};
}

/**
 * Production attempt runner: direct spawn (shell:false, stdin ignored),
 * hard stdout/stderr byte caps, per-attempt timeout that terminates the
 * process (SIGTERM then SIGKILL after the grace period) and marks the
 * attempt timed out. Never throws: spawn failures resolve with
 * `spawnError`, everything else resolves with the close facts.
 */
export function createSpawnAttemptRunner(): AttemptRunner {
	return (request: AttemptRunRequest) =>
		new Promise<SpawnedAttemptResult>((resolve) => {
			const stdout = createCappedCapture(request.stdoutMaxBytes);
			const stderr = createCappedCapture(request.stderrMaxBytes);
			let settled = false;
			let timedOut = false;
			let killer: NodeJS.Timeout | undefined;
			const child = spawn(request.program, request.argv, {
				cwd: request.cwd,
				env: request.env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
			child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
				killer = setTimeout(() => child.kill("SIGKILL"), request.terminateGraceMs);
			}, request.timeoutMs);
			const finish = (exitCode: number | null, spawnError: string | null): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (killer !== undefined) clearTimeout(killer);
				resolve({ exitCode, timedOut, spawnError, stdout: stdout.result(), stderr: stderr.result() });
			};
			child.on("error", (error) => finish(null, error instanceof Error ? error.message : "spawn failed"));
			child.on("close", (code) => finish(code, null));
		});
}

// ---------------------------------------------------------------------------
// Collection record serialization and atomic persistence
// ---------------------------------------------------------------------------

/**
 * Serialize the strict collection record (schema_version 1, phase "dev",
 * frozen non-treatment pin, chronological entries) — deterministic key
 * order, stable formatting.
 */
export function serializeCollectionRecord(record: CollectionRecord): string {
	return `${JSON.stringify(
		{
			schema_version: record.schemaVersion,
			phase: record.phase,
			non_treatment_sha256: record.nonTreatmentSha256,
			entries: record.entries.map((entry) => ({ kind: entry.kind, arm: entry.arm, path: entry.path })),
		},
		null,
		2,
	)}\n`;
}

/**
 * Atomically rewrite `collection-record.json`: the generated record is
 * validated with the strict `parseCollectionRecord` BEFORE anything is
 * written, then committed via a temp file + rename (atomic on POSIX),
 * then read back and byte-verified.
 */
async function writeCollectionRecord(outputRoot: string, record: CollectionRecord): Promise<void> {
	const serialized = serializeCollectionRecord(record);
	try {
		parseCollectionRecord(serialized, "collection record");
	} catch (error) {
		throw new PilotError("RECORD_INVALID", error instanceof Error ? error.message : "generated collection record failed strict validation");
	}
	const target = join(outputRoot, COLLECTION_RECORD_NAME);
	const tmp = join(outputRoot, `${COLLECTION_RECORD_NAME}.tmp-${randomUUID().slice(0, 8)}`);
	try {
		await writeFile(tmp, serialized, "utf8");
		await rename(tmp, target);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw new PilotError("RECORD_IO", "collection record cannot be written");
	}
	const written = await readFile(target, "utf8");
	if (written !== serialized) {
		throw new PilotError("RECORD_IO", "collection record is not byte-identical after write");
	}
}

/**
 * Require exactly one direct regular bounded .jsonl file in the attempt
 * session dir. Zero or multiple (or a single over-bound file) fails
 * closed with SESSION_FILE_COUNT — no evidence is invented and any
 * partial collection stays.
 */
async function locateSingleSessionFile(sessionDir: string): Promise<string> {
	let entries;
	try {
		entries = await readdir(sessionDir, { withFileTypes: true });
	} catch {
		throw new PilotError("SESSION_FILE_COUNT", "the attempt session directory cannot be read");
	}
	const candidates: string[] = [];
	for (const dirent of entries) {
		if (!dirent.name.endsWith(".jsonl")) continue;
		if (!dirent.isFile()) continue; // directories/symlinks are never session files
		const full = join(sessionDir, dirent.name);
		let info;
		try {
			info = await stat(full);
		} catch {
			throw new PilotError("IO_ERROR", "a session file cannot be inspected");
		}
		if (info.size > SESSION_MAX_BYTES) continue;
		candidates.push(full);
	}
	if (candidates.length !== 1) {
		throw new PilotError(
			"SESSION_FILE_COUNT",
			`expected exactly one direct regular bounded .jsonl file in the attempt session directory, found ${candidates.length}`,
		);
	}
	return candidates[0] as string;
}

/**
 * Byte-exact retention of a produced raw session: exclusive-create the
 * deterministic source path, write the raw bytes, read back and verify,
 * then remove the session file from the attempt dir (the move completes
 * only after the destination is byte-verified). On any failure the
 * destination this invocation created is removed again — a retained
 * source is never left half-verified.
 */
async function retainRawSession(dest: string, raw: Buffer): Promise<void> {
	let handle;
	try {
		handle = await open(dest, "wx");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST") {
			throw new PilotError("SOURCE_IO", `source ${basename(dest)} already exists — refusing to overwrite`);
		}
		throw new PilotError("SOURCE_IO", `source ${basename(dest)} cannot be created`);
	}
	try {
		await handle.writeFile(raw);
		await handle.sync();
	} finally {
		await handle.close();
	}
	const written = await readFile(dest);
	if (!written.equals(raw)) {
		await rm(dest, { force: true }).catch(() => {});
		throw new PilotError("SOURCE_IO", `source ${basename(dest)} is not byte-identical to the produced session`);
	}
}

function fsErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: undefined;
}

// ---------------------------------------------------------------------------
// Collection pipeline (injected runner / paths / time options)
// ---------------------------------------------------------------------------

export interface DevPilotPaths {
	/** Repository root (summary paths are relative to it). */
	projectRoot: string;
	/** Frozen inputs dir (`fixtures/commander-native-tool-benchmark/inputs`). */
	inputsDir: string;
	/** Runs root (`.pi/workbench/runs`); the output root lives under it. */
	runsDir: string;
}

export interface CollectDevPilotOptions {
	paths: DevPilotPaths;
	protocol?: FrozenProtocol;
	/** Injected attempt runner (production default: direct spawn). */
	runner?: AttemptRunner;
	attemptTimeoutMs?: number;
	terminateGraceMs?: number;
	stdoutMaxBytes?: number;
	stderrMaxBytes?: number;
	/** Bounded per-invalid-attempt diagnostic lines (stderr in production). */
	onDiagnostic?: (line: string) => void;
}

export type CollectResultStatus = "complete" | "attempts-exhausted";

export interface CollectResult {
	status: CollectResultStatus;
	validSessions: number;
	attempts: number;
	/** The final in-memory record (identical to the persisted one). */
	record: CollectionRecord;
	/** Collection record path relative to the project root (stdout-safe). */
	relativeCollectionPath: string;
}

/**
 * Collect the DEV pilot: preflight (frozen protocol + exact prompt/
 * fixture pins) BEFORE any output, exclusive-create the output root,
 * then run attempts against the fixed ABBA plan until 8 valid sessions
 * or the 12-attempt cap. Every produced raw session is retained
 * byte-exact under `sources/` and the strict chronological collection
 * record is atomically rewritten and validated after every attempt, so
 * the persisted partial collection is always truthful.
 *
 * Completion semantics: 8 valid sessions => `complete` (exit 0); the
 * 12-attempt cap with fewer than 8 valid => `attempts-exhausted`
 * (exit 1, truthful partial collection). Hard failures (existing output,
 * preflight drift, zero/multiple session files, retention/record I/O)
 * throw — the partial collection stays as-is.
 */
export async function collectDevPilot(options: CollectDevPilotOptions): Promise<CollectResult> {
	const protocol = options.protocol ?? FROZEN_NRO_PROTOCOL;
	const runner = options.runner ?? createSpawnAttemptRunner();
	const attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
	const terminateGraceMs = options.terminateGraceMs ?? TERMINATE_GRACE_MS;
	const stdoutMaxBytes = options.stdoutMaxBytes ?? ATTEMPT_STDOUT_MAX_BYTES;
	const stderrMaxBytes = options.stderrMaxBytes ?? ATTEMPT_STDERR_MAX_BYTES;
	const onDiagnostic = options.onDiagnostic ?? (() => {});

	// Preflight: frozen protocol and exact prompt/fixture/environment/
	// rubric pins BEFORE any output exists.
	requireFrozenProtocol(protocol);
	const projectRoot = resolve(options.paths.projectRoot);
	const inputsDir = resolve(options.paths.inputsDir);
	const runsDir = resolve(options.paths.runsDir);
	const inputs = await preflightInputs(inputsDir, protocol);
	const fixtureCwd = join(inputsDir, FIXTURE_DIR_NAME);

	// Exclusive output root: only ENOENT means absent.
	const outputRoot = join(runsDir, OUTPUT_ROOT_NAME);
	try {
		await mkdir(runsDir, { recursive: true });
		await mkdir(outputRoot);
	} catch (error) {
		if (fsErrorCode(error) === "EEXIST") {
			throw new PilotError("EXISTING_OUTPUT", `output root ${basename(outputRoot)} already exists — refusing to overwrite`);
		}
		throw new PilotError("IO_ERROR", `output root ${basename(outputRoot)} cannot be created`);
	}
	try {
		await mkdir(join(outputRoot, SOURCES_DIR_NAME));
	} catch {
		throw new PilotError("IO_ERROR", "sources directory cannot be created");
	}

	const plan = fixedPlan();
	const record: CollectionRecord = {
		schemaVersion: COLLECTION_SCHEMA_VERSION,
		phase: DEV_PILOT_PHASE,
		nonTreatmentSha256: protocol.nonTreatmentSha256 as string,
		entries: [],
	};
	const extensionFor = (arm: ArmName): string =>
		arm === "control"
			? join(projectRoot, "scripts", "commander-native-tool-control-extension.ts")
			: join(projectRoot, "extensions", "workbench-runtime", "index.ts");
	const piBin = join(projectRoot, "node_modules", ".bin", "pi");
	const promptText = inputs.milestonePromptRaw.toString("utf8");

	let validSessions = 0;
	let attempts = 0;
	while (validSessions < DEV_PILOT_VALID_SESSIONS && attempts < DEV_PILOT_MAX_ATTEMPTS) {
		const arm = plan[validSessions];
		if (arm === undefined) {
			throw new PilotError("IO_ERROR", "internal plan error");
		}
		attempts += 1;
		const label = attemptLabel(attempts);
		const sessionDir = join(outputRoot, attemptSessionDirName(attempts));
		try {
			await mkdir(sessionDir);
		} catch {
			throw new PilotError("IO_ERROR", `attempt session directory ${basename(sessionDir)} cannot be created`);
		}
		const request: AttemptRunRequest = {
			program: piBin,
			argv: buildAttemptArgv({
				extensionPath: extensionFor(arm),
				sessionDir,
				attemptNumber: attempts,
				arm,
				promptText,
				protocol,
			}),
			env: buildAttemptEnv(process.env),
			cwd: fixtureCwd,
			timeoutMs: attemptTimeoutMs,
			terminateGraceMs,
			stdoutMaxBytes,
			stderrMaxBytes,
		};
		const result = await runner(request);
		if (result.spawnError !== null) {
			throw new PilotError("SPAWN_FAILED", "the attempt process could not be started (details withheld)");
		}

		const sessionFile = await locateSingleSessionFile(sessionDir);
		const raw = await readFile(sessionFile);
		const verdict = classifySession({ exitCode: result.exitCode, timedOut: result.timedOut, raw, protocol });
		const kind: CollectionEntryKind = verdict.valid ? "session" : "attempt";
		if (verdict.valid) validSessions += 1;

		const destName = rawSourceName(attempts, arm);
		await retainRawSession(join(outputRoot, SOURCES_DIR_NAME, destName), raw);
		await rm(sessionFile, { force: true });
		// Remove the per-attempt dir only when it is empty (best-effort;
		// a non-empty dir is never force-deleted).
		await rmdir(sessionDir).catch(() => {});

		record.entries.push({ kind, arm, path: `${SOURCES_DIR_NAME}/${destName}` });
		await writeCollectionRecord(outputRoot, record);

		if (!verdict.valid) {
			const extra = `${result.stdout.overflow ? " (stdout overflow)" : ""}${result.stderr.overflow ? " (stderr overflow)" : ""}`;
			onDiagnostic(
				`commander-native-tool-dev-pilot: attempt ${label} (${arm}) invalid: ${verdict.reason as string} — ${verdict.detail ?? "invalid"}${extra}`,
			);
		}
	}

	const status: CollectResultStatus = validSessions >= DEV_PILOT_VALID_SESSIONS ? "complete" : "attempts-exhausted";
	return {
		status,
		validSessions,
		attempts,
		record,
		relativeCollectionPath: relative(projectRoot, join(outputRoot, COLLECTION_RECORD_NAME)),
	};
}

// ---------------------------------------------------------------------------
// CLI (fixed no args; --help/-h 0; unknown/positional 2; runtime 1)
// ---------------------------------------------------------------------------

export function usage(): string {
	return [
		"commander-native-tool-dev-pilot — NRO DEV-pilot collector (DEV evidence only, never final evidence)",
		"",
		"Collects 8 valid sessions (frozen ABBA order, at most 12 paid attempts) by running the",
		"real pi CLI against the frozen milestone prompt/fixture on both DEV-pilot arms",
		"(control approximation vs. the current workbench runtime extension), retaining every",
		"produced raw session byte-exact under .pi/workbench/runs/commander-native-tool-dev-pilot-collection/",
		"with a strict chronological collection-record.json.",
		"",
		"usage:",
		"  tsx scripts/commander-native-tool-dev-pilot.ts     collect (8 valid sessions, max 12 attempts)",
		"  tsx scripts/commander-native-tool-dev-pilot.ts --help   this help",
		"  tsx scripts/commander-native-tool-dev-pilot.ts -h       this help",
		"",
		"no arguments are accepted; any positional argument or option is a usage error.",
		"",
		"exit codes: 0 all 8 valid sessions collected | 1 attempts exhausted (truthful partial",
		"collection) or runtime failure (stderr only) | 2 usage error",
	].join("\n");
}

/** Bounded stdout summary: status, valid, attempts, project-relative collection path. */
export function renderSummary(result: CollectResult): string {
	return `commander-native-tool-dev-pilot: status=${result.status} valid=${result.validSessions} attempts=${result.attempts} collection=${result.relativeCollectionPath}`;
}

/** Bounded stderr diagnostic for a runtime failure (never session/prompt content or absolute paths). */
function renderDiagnostic(error: unknown): string {
	if (error instanceof PilotError || error instanceof NroError) {
		return `commander-native-tool-dev-pilot: ${error.code}: ${error.message}`;
	}
	return "commander-native-tool-dev-pilot: unexpected failure (details withheld — privacy boundary)";
}

export interface PilotIo {
	stdout(line: string): void;
	stderr(line: string): void;
}

const defaultIo: PilotIo = {
	stdout: (line) => process.stdout.write(`${line}\n`),
	stderr: (line) => process.stderr.write(`${line}\n`),
};

function defaultPaths(): DevPilotPaths {
	const projectRoot = process.cwd();
	return {
		projectRoot,
		inputsDir: join(projectRoot, "fixtures", "commander-native-tool-benchmark", "inputs"),
		runsDir: join(projectRoot, ".pi", "workbench", "runs"),
	};
}

export type CollectDevPilotFn = (options: CollectDevPilotOptions) => Promise<CollectResult>;

/**
 * CLI entry: no arguments runs the collection; exactly `--help`/`-h`
 * prints the usage to stdout (exit 0); any other argument is a usage
 * error (exit 2, usage on stderr). Runtime failures exit 1 with stderr
 * diagnostics only; `attempts-exhausted` exits 1 with the truthful
 * partial summary on stdout.
 */
export async function main(argv: readonly string[], io: PilotIo = defaultIo, collect: CollectDevPilotFn = collectDevPilot): Promise<number> {
	if (argv.length === 0) {
		try {
			const result = await collect({ paths: defaultPaths(), onDiagnostic: (line) => io.stderr(line) });
			io.stdout(renderSummary(result));
			return result.status === "complete" ? 0 : 1;
		} catch (error) {
			io.stderr(renderDiagnostic(error));
			return 1;
		}
	}
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
		io.stdout(usage());
		return 0;
	}
	io.stderr(`commander-native-tool-dev-pilot: unexpected argument(s): ${argv.join(" ")}\n${usage()}`);
	return 2;
}

// Run only when executed directly (tsx scripts/commander-native-tool-dev-pilot.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exitCode = await main(process.argv.slice(2));
}
