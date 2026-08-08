/**
 * NRO FINAL-phase collector — FINAL VALIDATION EVIDENCE ONLY.
 *
 * This module is the FINAL collection harness for the Commander Native
 * Tool Optimization (NRO) plan (`docs/plans/commander-native-tool-
 * optimization.md`, protocol `docs/baselines/commander-native-tool-
 * benchmark-protocol.md`, §3.5/§4). It drives the two FINAL arms against
 * the frozen milestone prompt and fixture:
 *
 *   - control:    `scripts/commander-native-tool-final-control-extension.ts`
 *                 (the FINAL control adapter — runs the current workbench
 *                 runtime behind the three-name suppression proxy);
 *   - treatment:  `extensions/workbench-runtime/index.ts` (the CURRENT
 *                 normal workbench runtime extension, loaded directly).
 *
 * It is a FINAL evidence artifact and is deliberately INDEPENDENT of the
 * DEV-pilot harness (`scripts/commander-native-tool-dev-pilot.ts`) and the
 * DEV-pilot control approximation (`scripts/commander-native-tool-
 * control-extension.ts`) — neither is ever imported, and DEV artifacts
 * never become final evidence.
 *
 * Collection discipline (frozen, protocol §4.2–§4.6):
 *   - exactly 40 valid sessions in the frozen ABBA order (abbaArmAt(1..40)
 *     = ABBA repeated 10 times, 20 sessions per arm);
 *   - at most 60 paid attempts; the cap counts each provider/model
 *     process once it has been SUCCESSFULLY STARTED (spawn failures are
 *     hard failures and are never counted); an invalid attempt retries
 *     the SAME required arm; every produced raw Pi session is retained —
 *     valid ones as `kind: "session"` (advancing the ABBA position),
 *     invalid ones as `kind: "attempt"` (position unchanged);
 *   - output root `.pi/workbench/runs/commander-native-tool-final-
 *     collection/` is created EXCLUSIVELY (an existing output fails
 *     closed); it maintains `sources/raw-<NN>-<arm>.jsonl` (byte-exact
 *     copies of every produced raw session, deterministic names) and
 *     `collection-record.json` (strict schema_version 1, phase "final",
 *     frozen non-treatment pin, chronological entries, NO status/cap
 *     field), atomically rewritten and validated with
 *     `parseCollectionRecord` after every attempt, with the attempt-dir
 *     original removed only after the destination source is byte-verified
 *     AND the updated record is committed/read back — a PRE-rename
 *     commit failure pops the in-memory entry and removes the new
 *     destination, while a POST-rename/read-back failure preserves the
 *     committed entry and its retained source and hard-fails (a
 *     committed record must never reference a removed source), keeping
 *     the original raw and its attempt dir — so a partial collection
 *     stays truthful after a failure or after the 60-attempt cap, and
 *     the initial EMPTY record is written before any call;
 *   - PREFLIGHT (read-only, BEFORE any output or call): frozen protocol
 *     pins, the frozen inputs dir, the exact current non-treatment
 *     bundle hash (`AGENTS.md` + `skills/` + `prompts/` + `templates/`,
 *     no-follow throughout — a symlinked root file OR root directory
 *     fails closed instead of being followed), the injected/default
 *     Node version pin, the exact package.json Pi pin, the required pi
 *     binary (allow-follow: npm's `node_modules/.bin/pi` is a symlink
 *     that resolves to a regular file), and the FINAL arm files
 *     (no-follow regular files — a symlinked arm file fails closed);
 *   - analyzer-compatible content classification: strict JSONL/usage
 *     validation + `deriveAttemptFacts(strict: false)`; only the six
 *     frozen attempt categories become `kind: "attempt"`; an
 *     `unclassified` raw must satisfy the FULL final session validity
 *     (exact prompt hash, pinned model keys, non-null pinned thinking,
 *     zero compactions, terminal assistant stop) to become a session.
 *     Process exit code/timeout are DIAGNOSTIC ONLY and never turn
 *     machine-valid raw into an attempt;
 *   - unrepresentable output (zero/multiple/no-unique/oversized/
 *     non-regular session files, or malformed/analyzer-unclassifiable
 *     raw content) HARD-FAILS immediately with exit 1, preserving the
 *     truthful partial record and the entire attempt directory — no
 *     source or entry is ever fabricated and collection never continues.
 *
 * Each attempt spawns the real pi CLI directly (shell:false, stdin
 * ignored, exact frozen argv/env, inherited credentials, per-attempt
 * timeout with SIGTERM then SIGKILL after the grace period, hard
 * stdout/stderr byte caps) with a fresh session dir under the output
 * root.
 *
 * Privacy: stdout carries bounded relative facts only (status, valid,
 * attempts, collection path relative to the project); diagnostics go to
 * stderr — never prompt/session content, credentials, or absolute
 * paths.
 *
 * CLI: no arguments. `--help`/`-h` exit 0; any other argument is a
 * usage error (exit 2); runtime failures exit 1; completing all 40
 * valid sessions exits 0; reaching the 60-attempt cap exits 1 with the
 * truthful partial collection (cap status is reported by the CLI/run
 * result only — the strict record never carries a status field).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	COLLECTION_RECORD_NAME,
	COLLECTION_SCHEMA_VERSION,
	FIXTURE_DIR_NAME,
	FIXTURE_MAX_BYTES,
	FIXTURE_MAX_FILES,
	FROZEN_NRO_PROTOCOL,
	PATH_MAX_BYTES,
	SESSION_MAX_BYTES,
	NroError,
	abbaArmAt,
	deriveAttemptFacts,
	parseCollectionRecord,
	parseSessionLines,
	preflightInputs,
	requireFrozenProtocol,
	sha256Hex,
} from "./commander-native-tool-benchmark.ts";
import type { ArmName, AttemptCategory, CollectionEntryKind, CollectionRecord, FrozenProtocol } from "./commander-native-tool-benchmark.ts";

// ---------------------------------------------------------------------------
// Fixed FINAL constants (frozen)
// ---------------------------------------------------------------------------

/** Exactly 40 valid sessions: the frozen ABBA pattern repeated ten times (positions 1..40). */
export const FINAL_VALID_SESSIONS = 40;
/** Hard cap on paid attempts: at most 60 (each successfully-started process counts once). */
export const FINAL_MAX_ATTEMPTS = 60;
/** Output root basename under `<runs dir>` — created exclusively. */
export const OUTPUT_ROOT_NAME = "commander-native-tool-final-collection";
/** Retained raw sessions live under this directory inside the output root. */
export const SOURCES_DIR_NAME = "sources";
/** Collection record phase (final validation evidence). */
export const FINAL_PHASE = "final" as const;
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
/** Frozen non-treatment bundle roots relative to the project root (§3.2/§5.2). */
const BUNDLE_ROOT_ENTRIES = ["AGENTS.md", "skills", "prompts", "templates"] as const;
/** Control-extension relative path (FINAL adapter, never the DEV approximation). */
const FINAL_CONTROL_REL = "scripts/commander-native-tool-final-control-extension.ts";
/** Treatment runtime relative path (the current workbench runtime, direct). */
const TREATMENT_RUNTIME_REL = "extensions/workbench-runtime/index.ts";
/** pi CLI binary relative path. */
const PI_BIN_REL = "node_modules/.bin/pi";
/** package.json devDependency key carrying the exact Pi pin. */
const PI_PACKAGE_KEY = "@earendil-works/pi-coding-agent";

/** Structured FINAL failure — fail closed, never a partial report. */
export type FinalCollectErrorCode =
	| "EXISTING_OUTPUT"
	| "SPAWN_FAILED"
	| "SESSION_FILE_COUNT"
	| "UNREPRESENTABLE"
	| "SOURCE_IO"
	| "RECORD_IO"
	| "RECORD_INVALID"
	| "IO_ERROR"
	| "BUNDLE_UNSAFE"
	| "BUNDLE_OVER_BOUND"
	| "BUNDLE_PATH_UNSAFE"
	| "NON_TREATMENT_MISMATCH"
	| "NODE_MISMATCH"
	| "PI_PIN_MISMATCH"
	| "PACKAGE_JSON_INVALID"
	| "FILE_MISSING";

export class FinalCollectError extends Error {
	readonly code: FinalCollectErrorCode;
	constructor(code: FinalCollectErrorCode, message: string) {
		super(message);
		this.name = "FinalCollectError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Fixed plan and attempt identity (pure, deterministic)
// ---------------------------------------------------------------------------

/**
 * The fixed valid-session plan: the arm required at each 1-based ABBA
 * position 1..40, derived from the frozen `abbaArmAt` — ABBA repeated
 * ten times (20 sessions per arm). An invalid attempt does not advance;
 * the next attempt retries the SAME required arm (`plan[validSessions]`).
 */
export function fixedPlan(): readonly ArmName[] {
	const arms: ArmName[] = [];
	for (let i = 1; i <= FINAL_VALID_SESSIONS; i += 1) {
		arms.push(abbaArmAt(i));
	}
	return arms;
}

/** Zero-padded two-digit attempt label (01..60). */
export function attemptLabel(attempt: number): string {
	return String(attempt).padStart(2, "0");
}

/** Frozen per-attempt pi session name: `nro-final-<NN>-<arm>`. */
export function attemptName(attempt: number, arm: ArmName): string {
	return `nro-final-${attemptLabel(attempt)}-${arm}`;
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
	/** Absolute path of the arm extension file (FINAL control adapter or treatment runtime). */
	extensionPath: string;
	/** Absolute fresh per-attempt session dir under the output root. */
	sessionDir: string;
	/** 1-based started-process number (01..60 in labels). */
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
 * nro-final-<NN>-<arm> --tools read,grep <raw milestone prompt>`.
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
// Non-treatment bundle hash (protocol §3.2/§5.2 — deterministic)
// ---------------------------------------------------------------------------

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const DETAIL_MAX_CHARS = 160;

/** Bounded, control-character-safe diagnostic detail. */
function boundDetail(text: string): string {
	const cleaned = text.replace(/[\x00-\x1f\x7f]/g, " ");
	return cleaned.length <= DETAIL_MAX_CHARS ? cleaned : `${cleaned.slice(0, DETAIL_MAX_CHARS - 1)}…`;
}

export interface BundleHashResult {
	sha256: string;
	/** Files as relative POSIX paths (sorted). */
	files: string[];
	totalBytes: number;
}

function fsErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: undefined;
}

/**
 * Deterministic non-treatment bundle hash (§3.2/§5.2): the frozen bundle
 * is exactly `AGENTS.md` plus everything under `skills/`, `prompts/`
 * and `templates/` (relative to the project root). Walk regular files
 * and directories only — symlinks and any other entry type fail closed,
 * with every file (including the root `AGENTS.md`) AND every root
 * directory (`skills`/`prompts`/`templates`) inspected through no-follow
 * `lstat` semantics so a symlinked root file or a symlinked root
 * directory is rejected instead of followed — then SHA-256 over the
 * concatenation of `"<relativePath>:<sha256>\n"` per file sorted by
 * relative path (code-unit order). Bounds: at most
 * FIXTURE_MAX_BYTES total, FIXTURE_MAX_FILES files, PATH_MAX_BYTES per
 * path, no control characters in any path. The result must equal the
 * frozen `non_treatment_sha256` pin captured at the fixture freeze.
 */
export async function nonTreatmentBundleHash(projectRoot: string): Promise<BundleHashResult> {
	const rows: Array<{ rel: string; sha: string }> = [];
	let totalBytes = 0;

	const addFile = async (rel: string, full: string): Promise<void> => {
		if (utf8Bytes(rel) > PATH_MAX_BYTES) throw new FinalCollectError("BUNDLE_PATH_UNSAFE", `non-treatment bundle path exceeds ${PATH_MAX_BYTES} bytes`);
		if (CONTROL_CHAR_RE.test(rel)) throw new FinalCollectError("BUNDLE_PATH_UNSAFE", "non-treatment bundle path contains control characters");
		if (rows.length >= FIXTURE_MAX_FILES) throw new FinalCollectError("BUNDLE_OVER_BOUND", `non-treatment bundle exceeds ${FIXTURE_MAX_FILES} files`);
		let info;
		try {
			// No-follow: a symlink is never a bundle file, even at the root.
			info = await lstat(full);
		} catch {
			throw new FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle file "${boundDetail(rel)}" cannot be inspected`);
		}
		if (!info.isFile()) throw new FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle entry "${boundDetail(rel)}" is not a regular file`);
		if (info.size > FIXTURE_MAX_BYTES - totalBytes) throw new FinalCollectError("BUNDLE_OVER_BOUND", `non-treatment bundle exceeds ${FIXTURE_MAX_BYTES} bytes total`);
		let raw: Buffer;
		try {
			raw = await readFile(full);
		} catch {
			throw new FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle file "${boundDetail(rel)}" cannot be read`);
		}
		totalBytes += raw.length;
		rows.push({ rel, sha: sha256Hex(raw) });
	};

	const walkDir = async (current: string, relPrefix: string): Promise<void> => {
		let names: Dirent[];
		try {
			names = await readdir(current, { withFileTypes: true });
		} catch {
			throw new FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle directory "${boundDetail(relPrefix)}" cannot be read`);
		}
		names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const dirent of names) {
			const rel = relPrefix.length === 0 ? dirent.name : `${relPrefix}/${dirent.name}`;
			if (utf8Bytes(rel) > PATH_MAX_BYTES) throw new FinalCollectError("BUNDLE_PATH_UNSAFE", `non-treatment bundle path exceeds ${PATH_MAX_BYTES} bytes`);
			if (CONTROL_CHAR_RE.test(rel)) throw new FinalCollectError("BUNDLE_PATH_UNSAFE", "non-treatment bundle path contains control characters");
			if (dirent.isSymbolicLink()) throw new FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle entry "${boundDetail(rel)}" is a symlink`);
			if (dirent.isDirectory()) {
				await walkDir(join(current, dirent.name), rel);
				continue;
			}
			if (!dirent.isFile()) throw new FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle entry "${boundDetail(rel)}" is not a regular file`);
			await addFile(rel, join(current, dirent.name));
		}
	};

	for (const entry of BUNDLE_ROOT_ENTRIES) {
		const full = join(projectRoot, entry);
		if (entry === "AGENTS.md") {
			await addFile(entry, full);
			continue;
		}
		let info;
		try {
			// No-follow: a root bundle directory that is itself a symlink is
			// rejected instead of followed (following would silently hash the
			// target's contents under the bundle root's name).
			info = await lstat(full);
		} catch {
			throw new FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle directory "${entry}" cannot be inspected`);
		}
		if (info.isSymbolicLink()) throw new FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle entry "${entry}" is a symlink`);
		if (!info.isDirectory()) throw new FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle entry "${entry}" is not a directory`);
		await walkDir(full, entry);
	}

	rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	const joined = rows.map((r) => `${r.rel}:${r.sha}\n`).join("");
	return { sha256: sha256Hex(joined), files: rows.map((r) => r.rel), totalBytes };
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

// ---------------------------------------------------------------------------
// Session validity classifier (pure, analyzer-compatible)
// ---------------------------------------------------------------------------

/** The six frozen attempt categories (protocol §8.6) — the ONLY raws that become `kind: "attempt"`. */
export type FinalAttemptReason = Exclude<AttemptCategory, "unclassified">;

export interface ClassifyFinalInput {
	/** Process exit code; null when the process was killed by a signal. DIAGNOSTIC ONLY. */
	exitCode: number | null;
	/** True when the attempt exceeded its time budget and was terminated. DIAGNOSTIC ONLY. */
	timedOut: boolean;
	/** Raw bytes of the produced session file. */
	raw: Buffer;
	arm: ArmName;
	/** Attempt label (e.g. "01") — used for bounded diagnostics only. */
	label: string;
	protocol: FrozenProtocol;
}

export interface FinalVerdict {
	/** True → retained as `kind: "session"` (advances the ABBA position). */
	valid: boolean;
	/** True → analyzer-unclassifiable raw: immediate hard fail, preserve record + attempt dir. */
	unrepresentable: boolean;
	/** Frozen attempt category when the raw is an invalid attempt; null otherwise. */
	reason: FinalAttemptReason | null;
	/** Bounded diagnostic detail (never session/prompt content). */
	detail: string | null;
}

const ATTEMPT_DETAILS: Record<FinalAttemptReason, string> = {
	prompt_mismatch: "extracted prompt hash differs from the frozen milestone prompt pin",
	env_drift: "assistant model keys or recorded thinking level differ from the pinned environment",
	compaction_present: "at least one compaction present",
	aborted: "session was aborted",
	errored: "session ended with an error",
	nonterminal: "no terminal assistant stop response",
};

/**
 * Fail-closed, analyzer-compatible content classification (protocol
 * §8.6 + §4.4 final validity), in this exact order:
 *
 *   1. strict JSONL parse + strict entry/usage validation (via
 *      `deriveAttemptFacts(strict:false)`, which keeps the attempt
 *      leniency — broken sessions are the point of an attempt); a
 *      malformed/unvalidatable raw is ANALYZER-UNCLASSIFIABLE →
 *      unrepresentable hard fail;
 *   2. the six frozen attempt categories (prompt_mismatch, env_drift,
 *      compaction_present, aborted, errored, nonterminal) → invalid
 *      attempt (same-arm retry);
 *   3. `unclassified` (machine-valid raw) → session ONLY when the full
 *      final session validity holds: exact prompt hash, ≥1 assistant
 *      model key all pinned, non-null pinned thinking level, zero
 *      compactions, terminal assistant stop; otherwise the raw is
 *      unrepresentable (the strict analyzer would fail closed on it).
 *
 * Process exit code and timeout are DIAGNOSTIC ONLY: they never turn
 * machine-valid raw into an attempt and never override the content
 * verdict.
 */
export function classifyFinalSession(input: ClassifyFinalInput): FinalVerdict {
	const { protocol } = input;
	const factsLabel = `attempt-${input.label}`;
	let entries: unknown[];
	try {
		entries = parseSessionLines(input.raw.toString("utf8"), "final-session");
	} catch (error) {
		return {
			valid: false,
			unrepresentable: true,
			reason: null,
			detail: `malformed raw: ${error instanceof Error ? boundDetail(error.message) : "not valid JSONL"}`,
		};
	}
	let facts;
	try {
		facts = deriveAttemptFacts(factsLabel, input.arm, "session.jsonl", sha256Hex(input.raw), entries, protocol.milestonePromptSha256 as string, protocol.environment, {
			strict: false,
		});
	} catch (error) {
		return {
			valid: false,
			unrepresentable: true,
			reason: null,
			detail: `malformed raw: ${error instanceof Error ? boundDetail(error.message) : "strict session validation failed"}`,
		};
	}
	if (facts.category !== "unclassified") {
		return { valid: false, unrepresentable: false, reason: facts.category, detail: ATTEMPT_DETAILS[facts.category] };
	}
	const failures: string[] = [];
	if (facts.promptSha256 !== protocol.milestonePromptSha256) {
		failures.push("first user-message text is not the frozen milestone prompt");
	}
	if (facts.modelKeys.length === 0 || facts.modelKeys.some((key) => key !== protocol.environment.modelKey)) {
		failures.push("no assistant model key matching the pinned model");
	}
	if (facts.thinkingLevel === null || facts.thinkingLevel !== protocol.environment.thinkingLevel) {
		failures.push("recorded thinking level is not the pinned level");
	}
	if (facts.compactions !== 0) {
		failures.push(`${facts.compactions} compaction(s) present`);
	}
	if (!facts.terminal.terminalStop || facts.terminal.aborted || facts.terminal.errored) {
		failures.push("no terminal assistant stop response");
	}
	if (failures.length > 0) {
		return {
			valid: false,
			unrepresentable: true,
			reason: null,
			detail: `analyzer-unclassifiable raw: unclassified by the frozen attempt priority but fails final session validity (${failures.join("; ")})`,
		};
	}
	return { valid: true, unrepresentable: false, reason: null, detail: null };
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
	/** Exact attempt env (inherited + final pins). */
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
 * Serialize the strict collection record (schema_version 1, phase
 * "final", frozen non-treatment pin, chronological entries, no
 * status/cap field) — deterministic key order, stable formatting.
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
 * Private structured collection-record write failure: `committed`
 * carries the exact commit stage. `committed === false` means the
 * failure happened BEFORE the atomic rename — the target still holds
 * the prior record, so the per-attempt caller rolls back the in-memory
 * entry and removes the new destination. `committed === true` means the
 * rename succeeded and the update IS committed — the caller MUST
 * preserve the in-memory entry and the retained destination source (a
 * committed record must never reference a removed source) and hard-fail.
 */
class RecordWriteError extends FinalCollectError {
	readonly committed: boolean;
	constructor(committed: boolean, message: string) {
		super("RECORD_IO", message);
		this.name = "RecordWriteError";
		this.committed = committed;
	}
}

/**
 * Atomically rewrite `collection-record.json` with explicit commit-stage
 * semantics. The generated record is validated with the strict
 * `parseCollectionRecord` BEFORE anything is written; the temp file is
 * written and byte-verified BEFORE the atomic rename; once `rename`
 * succeeds the update IS COMMITTED; the target is then still read back
 * and byte-verified as the contract requires. Any pre-rename failure
 * (write/temp-verify/rename) removes the temp and throws
 * `RecordWriteError{committed:false}`; any post-rename failure (the
 * injected `afterRename` seam, the read-back, or the byte comparison)
 * throws `RecordWriteError{committed:true}` so the caller never rolls
 * back a committed update. Messages are fixed and bounded (never
 * absolute paths or content).
 */
async function writeCollectionRecord(outputRoot: string, record: CollectionRecord, afterRename?: () => Promise<void> | void): Promise<void> {
	const serialized = serializeCollectionRecord(record);
	try {
		parseCollectionRecord(serialized, "collection record");
	} catch (error) {
		throw new FinalCollectError("RECORD_INVALID", error instanceof Error ? error.message : "generated collection record failed strict validation");
	}
	const target = join(outputRoot, COLLECTION_RECORD_NAME);
	const tmp = join(outputRoot, `${COLLECTION_RECORD_NAME}.tmp-${randomUUID().slice(0, 8)}`);
	let committed = false;
	try {
		await writeFile(tmp, serialized, "utf8");
		const tmpWritten = await readFile(tmp, "utf8");
		if (tmpWritten !== serialized) {
			throw new FinalCollectError("RECORD_IO", "collection record temp is not byte-identical before commit");
		}
		await rename(tmp, target);
		committed = true;
		await afterRename?.();
		const written = await readFile(target, "utf8");
		if (written !== serialized) {
			throw new FinalCollectError("RECORD_IO", "collection record is not byte-identical after write");
		}
	} catch (error) {
		if (!committed) {
			await rm(tmp, { force: true }).catch(() => {});
			throw new RecordWriteError(
				false,
				error instanceof FinalCollectError && error.code === "RECORD_IO" ? error.message : "collection record cannot be written",
			);
		}
		throw new RecordWriteError(
			true,
			error instanceof FinalCollectError && error.code === "RECORD_IO" ? error.message : "collection record cannot be verified after commit",
		);
	}
}

/**
 * Require exactly one direct regular bounded .jsonl file in the attempt
 * session dir (protocol §4.5 representability). EVERY direct `.jsonl`
 * entry participates in uniqueness: exactly one such entry total, and
 * that sole entry must itself be a direct regular non-symlink file of
 * at most SESSION_MAX_BYTES. Zero, multiple, or a single
 * non-regular/over-bound file — including a second `.jsonl` directory,
 * symlink, or oversized file next to a valid file — fails closed with
 * SESSION_FILE_COUNT (invalid extra JSONL entries are NEVER silently
 * ignored): the truthful partial record and the entire attempt
 * directory are preserved, no evidence is invented, and collection
 * never continues.
 */
async function locateSingleSessionFile(sessionDir: string): Promise<string> {
	let entries;
	try {
		entries = await readdir(sessionDir, { withFileTypes: true });
	} catch {
		throw new FinalCollectError("SESSION_FILE_COUNT", "the attempt session directory cannot be read");
	}
	const jsonlEntries = entries.filter((dirent) => dirent.name.endsWith(".jsonl"));
	if (jsonlEntries.length !== 1) {
		throw new FinalCollectError(
			"SESSION_FILE_COUNT",
			`expected exactly one direct .jsonl entry in the attempt session directory, found ${jsonlEntries.length}`,
		);
	}
	const sole = jsonlEntries[0] as Dirent;
	if (!sole.isFile()) {
		// Directories and symlinks are never session files — the sole .jsonl
		// entry must itself be a direct regular file.
		throw new FinalCollectError("SESSION_FILE_COUNT", `the sole .jsonl entry "${boundDetail(sole.name)}" in the attempt session directory is not a regular file`);
	}
	const full = join(sessionDir, sole.name);
	let info;
	try {
		info = await stat(full);
	} catch {
		throw new FinalCollectError("IO_ERROR", "a session file cannot be inspected");
	}
	if (info.size > SESSION_MAX_BYTES) {
		throw new FinalCollectError("SESSION_FILE_COUNT", `the sole .jsonl session file "${boundDetail(sole.name)}" exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	return full;
}

/**
 * Byte-exact retention of a produced raw session: exclusive-create the
 * deterministic source path, write the raw bytes, read back and verify
 * byte-identical. ANY failure after the exclusive creation — the
 * injected `afterSourceCreate` seam, the write, the sync, the close, or
 * the read-back validation — best-effort closes and removes the
 * newly-created destination and throws a bounded SOURCE_IO: a partial
 * unrecorded source is never left behind and no raw error detail (which
 * could carry absolute or session content) leaks. The attempt-dir
 * original is removed by the caller ONLY after the updated collection
 * record is atomically committed and read back (see collectFinal) —
 * never before.
 */
async function retainRawSession(dest: string, raw: Buffer, afterSourceCreate?: () => Promise<void> | void): Promise<void> {
	let handle;
	try {
		handle = await open(dest, "wx");
	} catch (error) {
		if (fsErrorCode(error) === "EEXIST") {
			throw new FinalCollectError("SOURCE_IO", `source ${basename(dest)} already exists — refusing to overwrite`);
		}
		throw new FinalCollectError("SOURCE_IO", `source ${basename(dest)} cannot be created`);
	}
	try {
		await afterSourceCreate?.();
		await handle.writeFile(raw);
		await handle.sync();
		await handle.close();
	} catch {
		// The destination was exclusively created by this invocation: any
		// subsequent failure must not leave a partial unrecorded source.
		await handle.close().catch(() => {});
		await rm(dest, { force: true }).catch(() => {});
		throw new FinalCollectError("SOURCE_IO", `source ${basename(dest)} cannot be retained`);
	}
	try {
		const written = await readFile(dest);
		if (!written.equals(raw)) {
			await rm(dest, { force: true }).catch(() => {});
			throw new FinalCollectError("SOURCE_IO", `source ${basename(dest)} is not byte-identical to the produced session`);
		}
	} catch (error) {
		if (error instanceof FinalCollectError) throw error;
		await rm(dest, { force: true }).catch(() => {});
		throw new FinalCollectError("SOURCE_IO", `source ${basename(dest)} cannot be read back`);
	}
}

// ---------------------------------------------------------------------------
// Preflight (read-only; BEFORE any output or call)
// ---------------------------------------------------------------------------

/**
 * Deterministic non-treatment bundle hash over the project root. The
 * result must equal the frozen pin — any drift fails closed before a
 * single byte of output or a single paid call (protocol §3.2/§4.5).
 */
async function preflightBundle(projectRoot: string, protocol: FrozenProtocol): Promise<BundleHashResult> {
	const bundle = await nonTreatmentBundleHash(projectRoot);
	if (bundle.sha256 !== protocol.nonTreatmentSha256) {
		throw new FinalCollectError(
			"NON_TREATMENT_MISMATCH",
			`non-treatment bundle SHA-256 ${bundle.sha256} does not match the frozen pin ${protocol.nonTreatmentSha256}`,
		);
	}
	return bundle;
}

/** Exact package.json Pi pin: `devDependencies["@earendil-works/pi-coding-agent"]` (no range). */
async function readPackagePiPin(projectRoot: string): Promise<string> {
	let text: string;
	try {
		text = await readFile(join(projectRoot, "package.json"), "utf8");
	} catch {
		throw new FinalCollectError("PACKAGE_JSON_INVALID", "package.json cannot be read");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new FinalCollectError("PACKAGE_JSON_INVALID", "package.json is not valid JSON");
	}
	const root = raw as { devDependencies?: Record<string, unknown> };
	const devDeps = root?.devDependencies;
	const pin = typeof devDeps === "object" && devDeps !== null ? devDeps[PI_PACKAGE_KEY] : undefined;
	if (typeof pin !== "string" || pin.length === 0) {
		throw new FinalCollectError("PI_PIN_MISMATCH", `package.json does not pin ${PI_PACKAGE_KEY} exactly in devDependencies`);
	}
	return pin;
}

/**
 * Require an existing regular file, FOLLOWING symlinks: npm's
 * `node_modules/.bin/pi` is a symlink to the package bin in normal
 * installs and resolves to a regular file — the pi binary check is the
 * ONLY allow-follow required-file check.
 */
async function requireRegularFileFollow(path: string, what: string): Promise<void> {
	let info;
	try {
		info = await stat(path);
	} catch {
		throw new FinalCollectError("FILE_MISSING", `${what} is missing or unreadable`);
	}
	if (!info.isFile()) {
		throw new FinalCollectError("FILE_MISSING", `${what} is not a regular file`);
	}
}

/**
 * Require an existing regular file at the path ITSELF, with no-follow
 * `lstat` semantics: directories AND symlinks fail closed. Used for the
 * FINAL control adapter and treatment runtime — a symlinked arm file is
 * never accepted as FINAL evidence.
 */
async function requireRegularFileNoFollow(path: string, what: string): Promise<void> {
	let info;
	try {
		info = await lstat(path);
	} catch {
		throw new FinalCollectError("FILE_MISSING", `${what} is missing or unreadable`);
	}
	if (!info.isFile()) {
		throw new FinalCollectError("FILE_MISSING", `${what} is not a regular file`);
	}
}

// ---------------------------------------------------------------------------
// Collection pipeline (injected runner / paths / runtime facts)
// ---------------------------------------------------------------------------

export interface FinalPaths {
	/** Repository root (summary paths are relative to it). */
	projectRoot: string;
	/** Frozen inputs dir (`fixtures/commander-native-tool-benchmark/inputs`). */
	inputsDir: string;
	/** Runs root (`.pi/workbench/runs`); the output root lives under it. */
	runsDir: string;
}

export interface RuntimeFacts {
	/** Injected Node version (production default: `process.version`). */
	processVersion: string;
}

export interface CollectFinalOptions {
	paths: FinalPaths;
	protocol?: FrozenProtocol;
	/** Injected attempt runner (production default: direct spawn). */
	runner?: AttemptRunner;
	/** Injected runtime facts (production default: process.version). */
	runtimeFacts?: RuntimeFacts;
	attemptTimeoutMs?: number;
	terminateGraceMs?: number;
	stdoutMaxBytes?: number;
	stderrMaxBytes?: number;
	/** Bounded per-attempt diagnostic lines (stderr in production). */
	onDiagnostic?: (line: string) => void;
	/**
	 * Narrow injected test seam: called immediately before each
	 * per-attempt collection-record commit (production default: no-op).
	 * Throwing deterministically simulates a PRE-rename record-commit
	 * failure so the fail-safe rollback (in-memory entry pop +
	 * destination removal) can be tested. Never called for the initial
	 * empty record.
	 */
	beforeRecordCommit?: () => Promise<void> | void;
	/**
	 * Narrow injected test seam: called immediately after the atomic
	 * rename commits each per-attempt collection-record update, before
	 * the target read-back verification (production default: no-op).
	 * Throwing deterministically simulates a POST-rename/read-back
	 * failure: the update is already committed, so the caller preserves
	 * the in-memory entry and the retained destination source (a
	 * committed record must never reference a removed source) and
	 * hard-fails; the attempt-dir original is kept because cleanup is
	 * never reached. Never called for the initial empty record.
	 */
	afterRecordRename?: () => Promise<void> | void;
	/**
	 * Narrow injected test seam: called immediately after the exclusive
	 * creation of each retained source destination, before its bytes are
	 * written (production default: no-op). Throwing deterministically
	 * simulates a retention write/sync failure: the newly-created
	 * destination is best-effort closed and removed again and a bounded
	 * SOURCE_IO is thrown — a partial unrecorded source is never left
	 * behind.
	 */
	afterSourceCreate?: () => Promise<void> | void;
}

export type CollectResultStatus = "complete" | "attempts-exhausted";

export interface CollectResult {
	status: CollectResultStatus;
	validSessions: number;
	/** Successfully-started paid processes (the 60 cap is over this count). */
	attempts: number;
	/** The final in-memory record (identical to the persisted one). */
	record: CollectionRecord;
	/** Collection record path relative to the project root (stdout-safe). */
	relativeCollectionPath: string;
}

/**
 * Collect the FINAL validation cohort: preflight (frozen protocol +
 * exact prompt/fixture pins + current non-treatment bundle hash +
 * injected/default Node pin + exact package Pi pin + required regular
 * pi/FINAL-arm files) BEFORE any output, exclusive-create the output
 * root, write the initial EMPTY strict record, then run attempts
 * against the fixed ABBA plan until 40 valid sessions or the 60
 * successfully-started-process cap. Every produced raw session is
 * retained byte-exact under `sources/` and the strict chronological
 * collection record is atomically rewritten, validated and read back
 * after every attempt; the attempt-dir original is removed only after
 * the destination source is byte-verified AND the updated record is
 * committed and read back (a PRE-rename commit failure pops the
 * in-memory entry and removes the new destination; a POST-rename or
 * read-back failure preserves the in-memory entry and the retained
 * destination source — a committed record must never reference a
 * removed source — and hard-fails), so the persisted partial
 * collection is always truthful (no status/cap field — cap status is
 * CLI/run-result only).
 *
 * Completion semantics: 40 valid sessions => `complete` (exit 0); the
 * 60-attempt cap with fewer than 40 valid => `attempts-exhausted`
 * (exit 1, truthful partial collection). Hard failures (preflight
 * drift, existing output, spawn failure, unrepresentable session files
 * or analyzer-unclassifiable raw content, retention/record I/O) throw —
 * the truthful partial record and the attempt directory are preserved
 * and collection never continues.
 */
export async function collectFinal(options: CollectFinalOptions): Promise<CollectResult> {
	const protocol = options.protocol ?? FROZEN_NRO_PROTOCOL;
	const runner = options.runner ?? createSpawnAttemptRunner();
	const runtimeFacts = options.runtimeFacts ?? { processVersion: process.version };
	const attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
	const terminateGraceMs = options.terminateGraceMs ?? TERMINATE_GRACE_MS;
	const stdoutMaxBytes = options.stdoutMaxBytes ?? ATTEMPT_STDOUT_MAX_BYTES;
	const stderrMaxBytes = options.stderrMaxBytes ?? ATTEMPT_STDERR_MAX_BYTES;
	const onDiagnostic = options.onDiagnostic ?? (() => {});
	const beforeRecordCommit = options.beforeRecordCommit ?? (() => {});
	const afterRecordRename = options.afterRecordRename ?? (() => {});
	const afterSourceCreate = options.afterSourceCreate ?? (() => {});

	// ---- Preflight (read-only): nothing is written and no process is
	// started until every pin and required file is verified.
	requireFrozenProtocol(protocol);
	const projectRoot = resolve(options.paths.projectRoot);
	const inputsDir = resolve(options.paths.inputsDir);
	const runsDir = resolve(options.paths.runsDir);
	const inputs = await preflightInputs(inputsDir, protocol);
	const fixtureCwd = join(inputsDir, FIXTURE_DIR_NAME);
	const bundle = await preflightBundle(projectRoot, protocol);
	if (runtimeFacts.processVersion !== protocol.environment.nodeVersion) {
		throw new FinalCollectError(
			"NODE_MISMATCH",
			`running Node ${runtimeFacts.processVersion} does not match the pinned environment node_version ${protocol.environment.nodeVersion}`,
		);
	}
	const piPin = await readPackagePiPin(projectRoot);
	if (piPin !== protocol.environment.piVersion) {
		throw new FinalCollectError("PI_PIN_MISMATCH", `package.json pins ${PI_PACKAGE_KEY} ${piPin} but the frozen environment requires exactly ${protocol.environment.piVersion}`);
	}
	const piBin = join(projectRoot, PI_BIN_REL);
	const controlExtension = join(projectRoot, FINAL_CONTROL_REL);
	const treatmentRuntime = join(projectRoot, TREATMENT_RUNTIME_REL);
	await requireRegularFileFollow(piBin, "the pi CLI binary (node_modules/.bin/pi)");
	await requireRegularFileNoFollow(controlExtension, "the FINAL control extension (scripts/commander-native-tool-final-control-extension.ts)");
	await requireRegularFileNoFollow(treatmentRuntime, "the treatment runtime (extensions/workbench-runtime/index.ts)");

	// ---- Exclusive output root: only ENOENT means absent.
	const outputRoot = join(runsDir, OUTPUT_ROOT_NAME);
	try {
		await mkdir(runsDir, { recursive: true });
		await mkdir(outputRoot);
	} catch (error) {
		if (fsErrorCode(error) === "EEXIST") {
			throw new FinalCollectError("EXISTING_OUTPUT", `output root ${basename(outputRoot)} already exists — refusing to overwrite`);
		}
		throw new FinalCollectError("IO_ERROR", `output root ${basename(outputRoot)} cannot be created`);
	}
	try {
		await mkdir(join(outputRoot, SOURCES_DIR_NAME));
	} catch {
		throw new FinalCollectError("IO_ERROR", "sources directory cannot be created");
	}

	const plan = fixedPlan();
	const record: CollectionRecord = {
		schemaVersion: COLLECTION_SCHEMA_VERSION,
		phase: FINAL_PHASE,
		nonTreatmentSha256: bundle.sha256,
		entries: [],
	};
	// Initial EMPTY strict record, written and verified BEFORE any call.
	await writeCollectionRecord(outputRoot, record);

	const extensionFor = (arm: ArmName): string => (arm === "control" ? controlExtension : treatmentRuntime);
	const promptText = inputs.milestonePromptRaw.toString("utf8");

	let validSessions = 0;
	let attempts = 0;
	while (validSessions < FINAL_VALID_SESSIONS && attempts < FINAL_MAX_ATTEMPTS) {
		const arm = plan[validSessions];
		if (arm === undefined) {
			throw new FinalCollectError("IO_ERROR", "internal plan error");
		}
		attempts += 1;
		const label = attemptLabel(attempts);
		const sessionDir = join(outputRoot, attemptSessionDirName(attempts));
		try {
			await mkdir(sessionDir);
		} catch {
			throw new FinalCollectError("IO_ERROR", `attempt session directory ${basename(sessionDir)} cannot be created`);
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
			// The process never started: NOT a paid attempt (the cap counts
			// only successfully-started processes). Hard fail — the truthful
			// record (initial empty or partial) and the attempt dir stay.
			throw new FinalCollectError("SPAWN_FAILED", "the attempt process could not be started (details withheld)");
		}

		const sessionFile = await locateSingleSessionFile(sessionDir);
		const raw = await readFile(sessionFile);
		const verdict = classifyFinalSession({ exitCode: result.exitCode, timedOut: result.timedOut, raw, arm, label, protocol });
		if (verdict.unrepresentable) {
			// Analyzer-unclassifiable output: immediate hard fail. The
			// truthful partial record and the ENTIRE attempt directory are
			// preserved; no source or entry is fabricated; never continue.
			throw new FinalCollectError("UNREPRESENTABLE", `attempt ${label} (${arm}) produced analyzer-unclassifiable raw — ${verdict.detail ?? "unrepresentable"}`);
		}
		const kind: CollectionEntryKind = verdict.valid ? "session" : "attempt";
		if (verdict.valid) validSessions += 1;

		const destName = rawSourceName(attempts, arm);
		const dest = join(outputRoot, SOURCES_DIR_NAME, destName);
		await retainRawSession(dest, raw, afterSourceCreate);
		record.entries.push({ kind, arm, path: `${SOURCES_DIR_NAME}/${destName}` });
		try {
			await beforeRecordCommit();
			await writeCollectionRecord(outputRoot, record, afterRecordRename);
		} catch (error) {
			if (error instanceof RecordWriteError && error.committed) {
				// The atomic rename already committed the updated record — the
				// in-memory entry and its retained destination source are
				// preserved (a committed record must never reference a removed
				// source) and the failure hard-fails; the attempt-dir original
				// is kept because cleanup is not reached.
				throw error;
			}
			// Pre-rename failure: the persisted record still holds the prior
			// state, so the in-memory entry and the destination created for it
			// are reverted — the prior record stays truthful, the original raw
			// keeps its attempt dir, and nothing unrecorded is left retained.
			record.entries.pop();
			await rm(dest, { force: true }).catch(() => {});
			throw error;
		}
		// Only after the destination source is byte-verified AND the updated
		// record is atomically committed/read back may the attempt-dir
		// original be removed; the per-attempt dir is then removed when
		// empty (best-effort; a non-empty dir is never force-deleted).
		await rm(sessionFile, { force: true });
		await rmdir(sessionDir).catch(() => {});

		if (!verdict.valid) {
			const extra = `${result.exitCode !== 0 ? ` (exit ${result.exitCode ?? "signal"})` : ""}${result.timedOut ? " (timed out)" : ""}${
				result.stdout.overflow ? " (stdout overflow)" : ""
			}${result.stderr.overflow ? " (stderr overflow)" : ""}`;
			onDiagnostic(
				`commander-native-tool-final-collect: attempt ${label} (${arm}) invalid: ${verdict.reason as string} — ${verdict.detail ?? "invalid"}${extra}`,
			);
		} else if (result.exitCode !== 0 || result.timedOut) {
			// Diagnostic-only note: the content verdict is authoritative and
			// exit/timeout never turn machine-valid raw into an attempt.
			const why = result.timedOut ? "timed out" : `exit ${result.exitCode ?? "signal"}`;
			onDiagnostic(`commander-native-tool-final-collect: attempt ${label} (${arm}) session valid despite ${why} (diagnostic only)`);
		}
	}

	const status: CollectResultStatus = validSessions >= FINAL_VALID_SESSIONS ? "complete" : "attempts-exhausted";
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
		"commander-native-tool-final-collect — NRO FINAL validation collector (final evidence only)",
		"",
		"Collects 40 valid sessions (frozen ABBA order x10, at most 60 successfully-started paid",
		"attempts) by running the real pi CLI against the frozen milestone prompt/fixture on both",
		"FINAL arms (final control adapter vs. the current workbench runtime extension), retaining",
		"every produced raw session byte-exact under",
		".pi/workbench/runs/commander-native-tool-final-collection/ with a strict chronological",
		"collection-record.json (no status/cap field).",
		"",
		"usage:",
		"  tsx scripts/commander-native-tool-final-collect.ts     collect (40 valid sessions, max 60 attempts)",
		"  tsx scripts/commander-native-tool-final-collect.ts --help   this help",
		"  tsx scripts/commander-native-tool-final-collect.ts -h       this help",
		"",
		"no arguments are accepted; any positional argument or option is a usage error.",
		"",
		"exit codes: 0 all 40 valid sessions collected | 1 attempts exhausted (truthful partial",
		"collection) or runtime failure (stderr only) | 2 usage error",
	].join("\n");
}

/** Bounded stdout summary: status, valid, attempts, project-relative collection path. */
export function renderSummary(result: CollectResult): string {
	return `commander-native-tool-final-collect: status=${result.status} valid=${result.validSessions} attempts=${result.attempts} collection=${result.relativeCollectionPath}`;
}

/** Bounded stderr diagnostic for a runtime failure (never session/prompt content or absolute paths). */
function renderDiagnostic(error: unknown): string {
	if (error instanceof FinalCollectError || error instanceof NroError) {
		return `commander-native-tool-final-collect: ${error.code}: ${error.message}`;
	}
	return "commander-native-tool-final-collect: unexpected failure (details withheld — privacy boundary)";
}

export interface FinalIo {
	stdout(line: string): void;
	stderr(line: string): void;
}

const defaultIo: FinalIo = {
	stdout: (line) => process.stdout.write(`${line}\n`),
	stderr: (line) => process.stderr.write(`${line}\n`),
};

function defaultPaths(): FinalPaths {
	const projectRoot = process.cwd();
	return {
		projectRoot,
		inputsDir: join(projectRoot, "fixtures", "commander-native-tool-benchmark", "inputs"),
		runsDir: join(projectRoot, ".pi", "workbench", "runs"),
	};
}

export type CollectFinalFn = (options: CollectFinalOptions) => Promise<CollectResult>;

/**
 * CLI entry: no arguments runs the collection; exactly `--help`/`-h`
 * prints the usage to stdout (exit 0); any other argument is a usage
 * error (exit 2, usage on stderr). Runtime failures exit 1 with stderr
 * diagnostics only; `attempts-exhausted` exits 1 with the truthful
 * partial summary on stdout.
 */
export async function main(argv: readonly string[], io: FinalIo = defaultIo, collect: CollectFinalFn = collectFinal): Promise<number> {
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
	io.stderr(`commander-native-tool-final-collect: unexpected argument(s): ${argv.join(" ")}\n${usage()}`);
	return 2;
}

// Run only when executed directly (tsx scripts/commander-native-tool-final-collect.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exitCode = await main(process.argv.slice(2));
}
