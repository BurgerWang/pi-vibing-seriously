/**
 * NRO protocol-v2 FINAL collector — PURE CONTRACT SLICE + READ-ONLY
 * NON-TREATMENT BUNDLE HASH + SCHEMA-2 PERSISTENCE CORE.
 *
 * This module is the pure, side-effect-free contract slice of the v2
 * FINAL collection harness (`commander-native-tool-optimization` plan,
 * protocol `docs/baselines/commander-native-tool-benchmark-
 * protocol-v2.md`): the frozen v2 cohort constants, the fixed ABBA
 * plan, the deterministic attempt/source/session-dir naming, the exact
 * attempt argv/env builders, the hard-capped byte capture, the frozen
 * final-session classifier (`classifyFinalSessionV2`), the read-only
 * non-treatment bundle hash (`nonTreatmentBundleHashV2`), the
 * read-only inputs preflight (`preflightInputsForCollectorV2`), the
 * read-only system/runtime preflight (`preflightSystemForCollectorV2`)
 * and the production direct-spawn attempt runner
 * (`createSpawnAttemptRunnerV2`) and the per-attempt session lifecycle
 * (`createAttemptSessionStorageV2`, `locateProducedSessionV2`,
 * `removeOwnedAttemptSessionV2`).
 *
 * The FINAL-collector PERSISTENCE CORE (protocol-v2 §5, reduced bounded
 * slice — atomic record updates, retained-source helpers and the
 * attempt-session lifecycle ONLY):
 * the canonical schema-2 initial record
 * (`buildInitialCollectionRecordV2` — strict canonical
 * roundtrip through the v2 core parser), the exclusive storage
 * initialization (`initializeCollectionStorageV2` — non-recursive
 * exclusive root/sources creates, exclusive canonical record create
 * with read-back verify, owned-identity revalidation before every
 * descendant write and before return, identity-owned non-recursive
 * rollback), the atomic record writer (`writeCollectionRecordV2` —
 * strict parse-then-write, unique exclusive temp under the owned
 * root, owned root/target identity gates, no-clobber hard-link park
 * of the prior record, atomic no-clobber hard-link publish,
 * committed/not-committed structured failures with prior-record
 * restoration) and the retained-source persistence helpers
 * (`retainRawSourceV2` — frozen size cap before any filesystem
 * access, owned root/sources gates, exclusive deterministic `wx`
 * create with handle-derived identity, write/sync/close, byte-exact
 * read-back with final identity verification, post-hook revalidation
 * of the owned root/sources/source identity and bytes immediately
 * before return, and identity-owned non-recursive cleanup — and
 * `removeOwnedRetainedSourceV2` — deterministic source-name and
 * relative-path validation, owned root/sources gates and unlink
 * of only a currently matching owned source identity, with an
 * explicit `{removed}` result and no recursive/forced removal), and
 * the attempt-session lifecycle (`createAttemptSessionStorageV2` —
 * attempt-validated deterministic exclusive non-recursive session-
 * directory create with a tracked no-follow identity, a path-free hook
 * seam, root+dir revalidation before return and identity-owned
 * non-recursive rollback; `locateProducedSessionV2` — exactly one
 * direct `.jsonl` produced entry, with the SHARED safe-basename
 * predicate (the same one `removeOwnedAttemptSessionV2` enforces)
 * checked BEFORE any join, plus symlink/non-regular rejection,
 * the frozen cap enforced before a bounded exact read through a handle
 * checked against the no-follow lstat, and identity/size/root/dir
 * revalidation after the path-free hooks and before the raw facts are
 * returned; and `removeOwnedAttemptSessionV2` — post-commit cleanup
 * that unlinks only the matching produced-file identity and rmdirs
 * only the still-owned empty attempt directory, with explicit
 * truthful booleans). The
 * FINAL collection loop (`collectFinalV2`) composes exactly these
 * primitives — both read-only preflights before any output or runner
 * call, the exclusive storage initialization, the per-attempt session
 * lifecycle, the injected/default attempt runner, the frozen
 * classifier, byte-exact raw retention, the strict chronological
 * record commit, the owned attempt-session cleanup and the fixed
 * bounded privacy-safe `onDiagnostic` diagnostics — with the
 * fixed ABBA 40-valid / 60-started accounting. The guarded CLI
 * (`usage`, `renderSummary`, `FinalIo`, `CollectFinalV2Fn`, `main`
 * and the path-exact direct-execution guard) is this module's only
 * executable entry point and NEVER runs on import.
 *
 * The bundle-hash, inputs-preflight and system-preflight components
 * are READ-ONLY: when called they lstats/readdirs/reads/stats the four
 * frozen bundle roots (`AGENTS.md`, `skills/`, `prompts/`,
 * `templates/`), the frozen v2 inputs tree (`fixture/`,
 * `milestone-prompt.txt`, `environment.txt`, `rubric.json`), the
 * project `package.json` and the frozen pi binary/arm paths with
 * strict no-follow semantics (the npm pi symlink is followed,
 * everything else is never followed) and never write. The persistence
 * core is the ONLY WRITING part: when called it mkdirs/opens/writes/
 * syncs/links/unlinks EXCLUSIVELY inside the caller-supplied runs
 * dir with non-recursive exclusive-create semantics, identity-owned
 * no-follow verification and non-recursive rollback — it never
 * overwrites a pre-existing or foreign entry, never follows symlinks
 * and never removes recursively. The ONLY subprocess action in the
 * module is the attempt runner's single direct `spawn` — executed
 * only when the runner returned by `createSpawnAttemptRunnerV2` is
 * called — with `shell: false`, ignored stdin, piped stdout/stderr,
 * hard byte caps and a SIGTERM-then-SIGKILL timeout; no shell, no
 * network and no provider/model state. The ONLY top-level
 * executable statement is the path-exact direct-execution guard
 * (this module's own decoded file URL against the resolved first
 * CLI argument), which runs the CLI (`main`) only when this module
 * IS the executed script — importing this module never
 * executes anything beyond module definition and never touches the
 * environment (filesystem access happens only inside
 * `nonTreatmentBundleHashV2`, `preflightInputsForCollectorV2`,
 * `preflightSystemForCollectorV2`, `initializeCollectionStorageV2`,
 * `writeCollectionRecordV2`, `retainRawSourceV2`,
 * `removeOwnedRetainedSourceV2`, `createAttemptSessionStorageV2`,
 * `locateProducedSessionV2` and `removeOwnedAttemptSessionV2` calls).
 *
 * Import policy (frozen): the ONLY imports are the v2 core module
 * (`commander-native-tool-benchmark-v2.ts`, for `abbaArmAtV2`,
 * `deriveAttemptFactsV2`, `computeRunFactsV2`, the strict
 * collection-record primitives `parseCollectionRecordV2` and
 * `collectionRecordToJsonV2` plus the collection record/entry types),
 * the v2 protocol module (`commander-native-tool-benchmark-v2-
 * protocol.ts`, for the frozen cohort/root/environment/pin/inputs
 * constants and the schema/protocol/doc constants
 * `COLLECTION_RECORD_NAME`, `COLLECTION_SCHEMA_VERSION`,
 * `PROTOCOL_VERSION`, `PROTOCOL_DOC`), the v2 POLICY LEAF
 * (`commander-native-tool-benchmark-v2-policy.ts`) restricted to
 * exactly the frozen rubric constants `V2_RUBRIC_CHECKS` (value) and
 * the `RubricCheckV2` type — never the evaluator and never the v2
 * prepare/analyze ADAPTERS (the inputs preflight reimplements its
 * strict schema-2 rubric parse locally on those frozen checks), the
 * v1 PURE core (`commander-native-tool-benchmark.ts`) limited to
 * exactly the eight named primitives/constants `parseSessionLines`,
 * `sha256Hex`, `FIXTURE_MAX_FILES`, `FIXTURE_MAX_BYTES`,
 * `PATH_MAX_BYTES` (the last three are the frozen v1 bounds the
 * bundle hash enforces), `fixtureManifestHash` and
 * `canonicalEnvironmentFile` (the allowlisted pure primitives the
 * inputs preflight verifies through) and `SESSION_MAX_BYTES` (the
 * frozen v1 input size cap the preflight enforces), and exactly five
 * node builtins: `node:child_process` (ONLY `spawn` — the single
 * direct-spawn call site, never a shell and never any other
 * child_process name), `node:fs/promises` (the read-only `lstat`,
 * `readdir`, `readFile`, `stat` plus the MINIMAL persistence write
 * surface `mkdir`, `open`, `writeFile`, `link`, `rmdir`, `unlink`
 * — non-recursive exclusive creates, no-clobber hard-link
 * park/publish and non-recursive identity-owned removal only),
 * `node:crypto` (ONLY `randomUUID` for
 * unique temp names), the `node:fs` `Dirent`/`Stats` TYPE ONLY, and
 * `node:path` (only `join` — plus `resolve`, used ONLY by the
 * direct-execution guard). The Node runtime version is read through
 * the GLOBAL `process.version` inside `preflightSystemForCollectorV2`
 * calls only — the `process` global is never imported. The v1
 * collector, its classifiers/parsers, adapters, and every other v1
 * name are never imported. Nothing else — in particular no other node
 * builtins (no network, no url/os/process/buffer import and no crypto
 * beyond `randomUUID`), no v2 prepare/analyze modules, no extension
 * or provider code — is ever imported here. The v1 collector, its
 * constants, and its evidence remain untouched: the v2 output root is
 * the independent `commander-native-tool-v2-final-collection` root.
 *
 * The guarded CLI (at the end of the file) is import-safe: no
 * arguments run the collection with production paths rooted at the
 * current working directory (`.pi/workbench/runs` and
 * `fixtures/commander-native-tool-benchmark-v2/inputs`), exactly
 * `--help`/`-h` print the usage to stdout (exit 0), any other argv
 * is a FIXED privacy-safe usage error on stderr (exit 2, never
 * echoing argv), a complete collection exits 0 with the single
 * bounded relative summary, `attempts-exhausted` exits 1 with the
 * truthful partial summary, and runtime failures exit 1 with stderr
 * only (collector errors render prefix + code + the already-fixed
 * message; every unknown error renders ONE fixed details-withheld
 * line). The existing fixed `onDiagnostic` lines are forwarded to
 * stderr unchanged. This module defines the pure contract the v2
 * collector consumes, the FINAL collection loop (`collectFinalV2`)
 * that composes it, the read-only bundle hash and the two read-only
 * preflights it verifies against the frozen pins, the direct-spawn
 * attempt runner it drives, the reduced persistence core (initial
 * record, exclusive storage initialization, atomic record updates)
 * and the attempt-session lifecycle (deterministic
 * session-directory create, produced-session locate, owned-session
 * removal) that persist the collection.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join, resolve } from "node:path";

import {
	abbaArmAtV2,
	collectionRecordToJsonV2,
	computeRunFactsV2,
	deriveAttemptFactsV2,
	parseCollectionRecordV2,
} from "./commander-native-tool-benchmark-v2.ts";
import type {
	AttemptFactsV2,
	AttemptCategoryV2,
	CollectionEntryV2,
	CollectionRecordV2,
	RunFactsV2,
	V2FrozenProtocol,
} from "./commander-native-tool-benchmark-v2.ts";
import {
	canonicalEnvironmentFile,
	FIXTURE_MAX_BYTES,
	FIXTURE_MAX_FILES,
	fixtureManifestHash,
	parseSessionLines,
	PATH_MAX_BYTES,
	SESSION_MAX_BYTES,
	sha256Hex,
} from "./commander-native-tool-benchmark.ts";
import {
	BENCHMARK_SCHEMA_VERSION,
	COLLECTION_RECORD_NAME,
	COLLECTION_ROOT_NAME,
	COLLECTION_SCHEMA_VERSION,
	ENVIRONMENT_NAME,
	FIXTURE_DIR_NAME,
	FROZEN_ENVIRONMENT,
	FROZEN_NRO_V2_PROTOCOL,
	MAX_PAID_ATTEMPTS,
	MILESTONE_PROMPT_NAME,
	PROTOCOL_DOC,
	PROTOCOL_VERSION,
	RUBRIC_NAME,
	TOTAL_VALID_RUNS,
} from "./commander-native-tool-benchmark-v2-protocol.ts";
import type { ArmName } from "./commander-native-tool-benchmark-v2-protocol.ts";

// The strict collection record/entry types are re-exported for consumers of
// the persistence API (they are imported from the v2 core module ONLY).
export type { CollectionEntryV2, CollectionRecordV2 } from "./commander-native-tool-benchmark-v2.ts";
import { V2_RUBRIC_CHECKS } from "./commander-native-tool-benchmark-v2-policy.ts";
import type { RubricCheckV2 } from "./commander-native-tool-benchmark-v2-policy.ts";

// ---------------------------------------------------------------------------
// Frozen v2 cohort and output root (protocol-v2 doc §3.1/§4)
// ---------------------------------------------------------------------------

/** Exactly 40 valid FINAL sessions — the frozen v2 cohort (protocol-v2 §3.1/§4.2). */
export const FINAL_V2_VALID_SESSIONS = TOTAL_VALID_RUNS;
/** Hard cap on successfully-started paid attempts: at most 60 (protocol-v2 §4.5). */
export const FINAL_V2_MAX_ATTEMPTS = MAX_PAID_ATTEMPTS;
/** Independent v2 final-collection output root basename (protocol-v2 §3.1) — never the v1 root. */
export const OUTPUT_ROOT_NAME_V2 = COLLECTION_ROOT_NAME;

// ---------------------------------------------------------------------------
// Fixed ABBA plan (pure, deterministic)
// ---------------------------------------------------------------------------

/**
 * The fixed v2 valid-session plan: the arm required at each 1-based
 * ABBA position 1..40, derived from the frozen `abbaArmAtV2` — ABBA
 * repeated ten times (exactly 20 sessions per arm). An invalid attempt
 * does not advance; the next attempt retries the SAME required arm
 * (`plan[validSessions]`).
 */
export function fixedPlanV2(): readonly ArmName[] {
	const arms: ArmName[] = [];
	for (let i = 1; i <= FINAL_V2_VALID_SESSIONS; i += 1) {
		arms.push(abbaArmAtV2(i));
	}
	return arms;
}

// ---------------------------------------------------------------------------
// Attempt identity (pure, deterministic)
// ---------------------------------------------------------------------------

/** Zero-padded two-digit attempt label (01..60). */
export function attemptLabelV2(attempt: number): string {
	return String(attempt).padStart(2, "0");
}

/** Frozen per-attempt pi session name: `nro-v2-final-<NN>-<arm>` (explicit v2 identity). */
export function attemptNameV2(attempt: number, arm: ArmName): string {
	return `nro-v2-final-${attemptLabelV2(attempt)}-${arm}`;
}

/** Deterministic retained raw source name: `raw-<NN>-<arm>.jsonl`. */
export function rawSourceNameV2(attempt: number, arm: ArmName): string {
	return `raw-${attemptLabelV2(attempt)}-${arm}.jsonl`;
}

/** Fresh per-attempt session dir basename: `.attempt-<NN>-session`. */
export function attemptSessionDirNameV2(attempt: number): string {
	return `.attempt-${attemptLabelV2(attempt)}-session`;
}

// ---------------------------------------------------------------------------
// Attempt argv/env builders (pure, exact)
// ---------------------------------------------------------------------------

export interface BuildAttemptArgvV2Options {
	/** Absolute path of the arm extension file (v2 control adapter or treatment runtime). */
	extensionPath: string;
	/** Absolute fresh per-attempt session dir under the v2 output root. */
	sessionDir: string;
	/** 1-based started-process number (01..60 in labels). */
	attemptNumber: number;
	arm: ArmName;
	/** The raw milestone prompt text — the SOLE positional message, byte-exact. */
	promptText: string;
}

/**
 * The exact v2 production attempt argv (pi 0.83.0 CLI contract):
 * `--print --approve --no-extensions --extension <arm> --model <pinned>
 * --thinking <pinned> --session-dir <fresh dir> --name
 * nro-v2-final-<NN>-<arm> --tools read,grep <raw milestone prompt>`.
 * The prompt is the sole positional message; every other token is a
 * flag/value pair in this exact order. The model and thinking pins come
 * from the frozen v2 environment (`FROZEN_ENVIRONMENT`) and the session
 * name from `attemptNameV2` — the output is fully deterministic for a
 * given caller input, and arm-identical except for the caller-supplied
 * extension path, session dir, and the arm-carrying name.
 */
export function buildAttemptArgvV2(opts: BuildAttemptArgvV2Options): string[] {
	return [
		"--print",
		"--approve",
		"--no-extensions",
		"--extension",
		opts.extensionPath,
		"--model",
		FROZEN_ENVIRONMENT.modelKey,
		"--thinking",
		FROZEN_ENVIRONMENT.thinkingLevel,
		"--session-dir",
		opts.sessionDir,
		"--name",
		attemptNameV2(opts.attemptNumber, opts.arm),
		"--tools",
		"read,grep",
		opts.promptText,
	];
}

/**
 * The exact v2 production attempt env: the inherited base environment
 * (credentials included) with `PI_SKIP_VERSION_CHECK=1` and
 * `PI_TELEMETRY=0` pinned. Entries whose value is `undefined` are
 * dropped; the two pins always override any inherited value.
 * Arm-independent by construction (identical env for control and
 * treatment attempts).
 */
export function buildAttemptEnvV2(base: NodeJS.ProcessEnv): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined) env[key] = value;
	}
	env.PI_SKIP_VERSION_CHECK = "1";
	env.PI_TELEMETRY = "0";
	return env;
}

// ---------------------------------------------------------------------------
// Hard-capped byte capture (pure, deterministic)
// ---------------------------------------------------------------------------

export interface CappedCaptureV2 {
	/** The validated cap: a non-negative safe integer, frozen for the capture's lifetime. */
	readonly maxBytes: number;
	/**
	 * The exact prefix of the appended byte stream decoded as UTF-8:
	 * never longer than `maxBytes` raw bytes and, whenever the stream
	 * is valid UTF-8, always ending on a code-point boundary — a
	 * multibyte character is never split and truncation never
	 * introduces a replacement character. Stable once overflowed:
	 * after the cap is hit this value never changes.
	 */
	readonly text: string;
	/** The exact total raw byte count of EVERYTHING appended (never capped). */
	readonly totalBytes: number;
	/** True once the appended raw bytes exceeded the cap (at least once). */
	readonly overflowed: boolean;
	/** Append raw bytes; bytes beyond the cap are counted but never stored. */
	append(raw: Uint8Array): void;
}

/**
 * UTF-8 lead-byte length in bytes; 1 for ASCII and for invalid lead
 * bytes (0xF8..0xFF, which decode as one replacement character each).
 */
function leadLength(byte: number): number {
	if (byte < 0xe0) return 2;
	if (byte < 0xf0) return 3;
	if (byte < 0xf8) return 4;
	return 1;
}

/**
 * Largest byte offset <= maxBytes such that `bytes[0..offset)` ends on
 * a code-point boundary of the full `bytes` stream: scans back from the
 * cut over continuation bytes to the start of the last code point,
 * then moves the cut before that code point when it would be split.
 * Invalid bytes (a continuation at offset 0, 0xFE/0xFF) are treated as
 * one byte each — the cut never lands inside a valid code point.
 */
function boundaryCut(bytes: Uint8Array, maxBytes: number): number {
	const cut = Math.min(maxBytes, bytes.length);
	if (cut === 0) return 0;
	// Here cut is in [1, bytes.length], so every index in [0, cut) is a
	// valid in-range index of `bytes`; the `undefined` branches below are
	// type-level impossibility guards for noUncheckedIndexedAccess and are
	// never taken at runtime. They fall back to an exact boundary cut,
	// consistent with treating an unreadable byte as one ASCII byte.
	let start = cut - 1;
	while (start > 0) {
		const probe = bytes[start];
		if (probe === undefined || (probe & 0xc0) !== 0x80) break;
		start -= 1;
	}
	const byte = bytes[start];
	if (byte === undefined) return cut;
	if ((byte & 0xc0) !== 0xc0) return cut; // ASCII or invalid byte: exact boundary
	const length = leadLength(byte);
	return start + length <= cut ? cut : start;
}

/**
 * Factory for a hard-capped byte capture. `maxBytes` must be a
 * non-negative safe integer (a negative, fractional, NaN, or infinite
 * cap throws `RangeError` immediately). Appended raw bytes are hard-
 * capped at `maxBytes` raw bytes: `text` keeps the exact prefix
 * (truncated on a code-point boundary of the full stream, so multibyte
 * characters are never split), `overflowed` turns true exactly when the
 * cap is exceeded, and `totalBytes` always counts the exact total of
 * every appended byte. After overflow the captured text is FROZEN —
 * further appends only advance `totalBytes` — and repeated reads are
 * stable and deterministic. Splitting the same byte stream across any
 * number of `append` calls yields exactly the same capture as a single
 * append.
 */
export function createCappedCaptureV2(maxBytes: number): CappedCaptureV2 {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError(`createCappedCaptureV2: cap must be a non-negative safe integer, got ${String(maxBytes)}`);
	}
	const chunks: Uint8Array[] = [];
	let storedBytes = 0;
	let totalBytes = 0;
	let overflowed = false;
	return {
		maxBytes,
		get text(): string {
			return Buffer.concat(chunks).toString("utf8");
		},
		get totalBytes(): number {
			return totalBytes;
		},
		get overflowed(): boolean {
			return overflowed;
		},
		append(raw: Uint8Array): void {
			if (!(raw instanceof Uint8Array)) {
				throw new TypeError("createCappedCaptureV2.append: raw must be a Uint8Array");
			}
			totalBytes += raw.byteLength;
			if (raw.byteLength === 0 || overflowed) return;
			const room = maxBytes - storedBytes;
			if (raw.byteLength <= room) {
				chunks.push(raw);
				storedBytes += raw.byteLength;
				return;
			}
			overflowed = true;
			const head = raw.subarray(0, room);
			const full = chunks.length === 0 ? head : Buffer.concat([...chunks, head]);
			chunks.length = 0;
			const cut = boundaryCut(full, full.length);
			storedBytes = cut;
			if (cut > 0) chunks.push(full.subarray(0, cut));
		},
	};
}

// ---------------------------------------------------------------------------
// Direct-spawn attempt runner (protocol-v2 §4.4 — frozen v1 envelope parity)
// ---------------------------------------------------------------------------

/** Frozen attempt timeout before SIGTERM — 30 minutes (protocol-v2 §4.4, v1 envelope parity). */
export const ATTEMPT_TIMEOUT_MS_V2 = 30 * 60 * 1000;
/** Frozen SIGTERM grace before SIGKILL on timeout — 5 seconds. */
export const TERMINATE_GRACE_MS_V2 = 5_000;
/** Frozen hard cap on captured attempt stdout — 64 KiB. */
export const ATTEMPT_STDOUT_MAX_BYTES_V2 = 64 * 1024;
/** Frozen hard cap on captured attempt stderr — 256 KiB. */
export const ATTEMPT_STDERR_MAX_BYTES_V2 = 256 * 1024;

/** Fixed privacy-safe start-failure fact — never raw error text, never a program path. */
export const SPAWN_START_FAILED_DETAIL_V2 = "the attempt process could not be started";

/** A direct-spawn attempt request; every optional field defaults to the frozen production envelope. */
export interface SpawnAttemptRequestV2 {
	/** Absolute path of the program to spawn (the verified pi binary for production attempts). */
	program: string;
	/** Exact argv — the program path is never repeated as argv[0]. */
	argv: string[];
	/** Exact working directory. */
	cwd: string;
	/** Exact full environment (production attempts use `buildAttemptEnvV2`). */
	env: Record<string, string>;
	/** Timeout before SIGTERM; defaults to `ATTEMPT_TIMEOUT_MS_V2` (30 min). */
	timeoutMs?: number;
	/** Grace after SIGTERM before SIGKILL; defaults to `TERMINATE_GRACE_MS_V2` (5 s). */
	terminateGraceMs?: number;
	/** Hard stdout cap in bytes; defaults to `ATTEMPT_STDOUT_MAX_BYTES_V2` (64 KiB). */
	stdoutMaxBytes?: number;
	/** Hard stderr cap in bytes; defaults to `ATTEMPT_STDERR_MAX_BYTES_V2` (256 KiB). */
	stderrMaxBytes?: number;
}

/** The settled direct-spawn attempt result — machine facts only, never raw process error text. */
export interface SpawnedAttemptResultV2 {
	/** True exactly when the process successfully started — the future loop counts only these. */
	started: boolean;
	/** Process exit code once closed; null when the process never started (or was killed by a signal). */
	exitCode: number | null;
	/** True when the attempt timed out and SIGTERM was sent. */
	timedOut: boolean;
	/** Fixed privacy-safe start-failure fact; null when the process started. */
	startError: string | null;
	/** Hard-capped stdout capture (`createCappedCaptureV2` — raw byte totals always exact). */
	stdout: CappedCaptureV2;
	/** Hard-capped stderr capture. */
	stderr: CappedCaptureV2;
}

export type SpawnAttemptRunnerV2 = (request: SpawnAttemptRequestV2) => Promise<SpawnedAttemptResultV2>;

/**
 * Production direct-spawn attempt runner (protocol-v2 §4.4): calls
 * Node's `spawn` directly — `program` and `argv` verbatim with
 * `{ cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] }` —
 * never a shell, stdin ignored — and captures stdout/stderr through
 * `createCappedCaptureV2` at the request caps (defaults: the frozen
 * 64 KiB / 256 KiB envelope). The per-attempt timeout sends SIGTERM
 * and then SIGKILL after the grace period, marking the result timed
 * out. The promise settles EXACTLY once on the first of `error` or
 * `close`, both timers are always cleared, and a spawn-start failure
 * NEVER throws: it resolves with `started: false` and the fixed
 * privacy-safe `SPAWN_START_FAILED_DETAIL_V2` — the raw `Error` text
 * and the program path are never retained — so the future collection
 * loop can count only successfully-started processes. The exit code
 * and the timeout diagnostics are preserved verbatim but never
 * classify content.
 */
export function createSpawnAttemptRunnerV2(): SpawnAttemptRunnerV2 {
	return (request: SpawnAttemptRequestV2) =>
		new Promise<SpawnedAttemptResultV2>((resolve) => {
			const stdout = createCappedCaptureV2(request.stdoutMaxBytes ?? ATTEMPT_STDOUT_MAX_BYTES_V2);
			const stderr = createCappedCaptureV2(request.stderrMaxBytes ?? ATTEMPT_STDERR_MAX_BYTES_V2);
			let settled = false;
			let timedOut = false;
			let killer: NodeJS.Timeout | undefined;
			const child = spawn(request.program, request.argv, {
				cwd: request.cwd,
				env: request.env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
			child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
				killer = setTimeout(() => child.kill("SIGKILL"), request.terminateGraceMs ?? TERMINATE_GRACE_MS_V2);
			}, request.timeoutMs ?? ATTEMPT_TIMEOUT_MS_V2);
			const finish = (started: boolean, exitCode: number | null): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (killer !== undefined) clearTimeout(killer);
				resolve({ started, exitCode, timedOut, startError: started ? null : SPAWN_START_FAILED_DETAIL_V2, stdout, stderr });
			};
			child.on("error", () => finish(false, null));
			child.on("close", (code) => finish(true, code));
		});
}

// ---------------------------------------------------------------------------
// Final-session classification (pure, deterministic — protocol-v2 §4.3/§6.2)
// ---------------------------------------------------------------------------

/** Fixed safe session basename for classifier-produced facts (bounded, no path separators — never a path). */
export const FINAL_SESSION_BASENAME_V2 = "raw-session.jsonl";
/** Fixed privacy-safe detail for every unrepresentable raw (exact string — never error text, raw bytes, or paths). */
export const UNREPRESENTABLE_DETAIL_V2 = "raw session is not analyzable under the frozen v2 contract";
/** Fixed detail for a fully valid session. */
export const VALID_DETAIL_V2 = "session satisfies the frozen v2 final-validity contract";

/** Fixed privacy-safe detail per frozen invalid category (protocol-v2 §4.3) — never error text. */
export const CATEGORY_DETAIL_V2: Record<Exclude<AttemptCategoryV2, "unclassified">, string> = {
	prompt_mismatch: "attempt failed the frozen v2 prompt-hash check",
	env_drift: "attempt drifted from the frozen v2 environment pins",
	compaction_present: "attempt contains compaction entries (final v2 sessions require zero compactions)",
	aborted: "attempt terminal assistant response was aborted",
	errored: "attempt terminal assistant response errored",
	nonterminal: "attempt never reached a terminal stop response",
};

/** The only three final-session verdicts. */
export type FinalSessionVerdictV2 = "valid" | "invalid" | "unrepresentable";

export interface ClassifyFinalSessionV2Input {
	/** The exact raw bytes of the produced attempt session (JSONL). */
	raw: Buffer;
	/** The frozen ABBA arm this attempt was launched as. */
	arm: ArmName;
	/** Bounded attempt label (carried into facts only; never echoed in details). */
	label: string;
	/** Process exit code — diagnostic-only, never changes the verdict. */
	exitCode: number | null;
	/** Whether the process timed out — diagnostic-only, never changes the verdict. */
	timedOut: boolean;
	/** The frozen v2 protocol pins; defaults to the frozen protocol (`FROZEN_NRO_V2_PROTOCOL`). */
	protocol?: V2FrozenProtocol;
}

export interface ClassifyFinalSessionV2Result {
	/** "valid" | "invalid" | "unrepresentable" — the only three verdicts. */
	verdict: FinalSessionVerdictV2;
	/** Exact `computeRunFactsV2` facts (orderIndex 1, fixed safe basename) when valid; null otherwise. */
	runFacts: RunFactsV2 | null;
	/** Exact `deriveAttemptFactsV2` facts (strict: false, own raw SHA, fixed safe basename) when invalid; null otherwise. */
	attemptFacts: AttemptFactsV2 | null;
	/** Fixed privacy-safe detail — never error text, raw bytes, or paths. */
	detail: string;
	/** Echoed diagnostic process facts — never influence the verdict. */
	exitCode: number | null;
	timedOut: boolean;
}

/**
 * Classify a produced raw attempt session under the frozen v2 FINAL
 * contract (protocol-v2 §4.3/§6.2), reusing ONLY the frozen v2
 * derive/full-validity chain and the two allowed v1 pure primitives:
 *
 *   1. strict JSONL parse of the raw UTF-8 text (`parseSessionLines`);
 *   2. `deriveAttemptFactsV2(strict: false)` over the attempt's own
 *      entries with the OWN raw SHA-256 (`sha256Hex(raw)` — the exact
 *      input bytes, never the decoded text) and the pinned milestone-
 *      prompt hash / environment of the frozen v2 protocol — the six
 *      frozen invalid categories return an invalid attempt with a
 *      FIXED category detail;
 *   3. an unclassified attempt must satisfy the FULL final validity
 *      check (`computeRunFactsV2` with orderIndex 1, the fixed safe
 *      basename and enforceValidity: true) — success is a valid
 *      session.
 *
 * Any parse/derive/full-validity error — and an unfrozen protocol
 * whose milestone prompt pin is null — returns the fixed exact detail
 * "raw session is not analyzable under the frozen v2 contract" with
 * verdict "unrepresentable". Errors, raw bytes and paths are NEVER
 * exposed: the result carries only facts, hashes and fixed details,
 * and the classifier never throws. The process facts (`exitCode`,
 * `timedOut`) are accepted and echoed verbatim but never change the
 * verdict.
 */
export function classifyFinalSessionV2(input: ClassifyFinalSessionV2Input): ClassifyFinalSessionV2Result {
	const protocol = input.protocol ?? FROZEN_NRO_V2_PROTOCOL;
	const diagnostic = { exitCode: input.exitCode, timedOut: input.timedOut };
	const unrepresentable = (): ClassifyFinalSessionV2Result => ({
		verdict: "unrepresentable",
		runFacts: null,
		attemptFacts: null,
		detail: UNREPRESENTABLE_DETAIL_V2,
		...diagnostic,
	});
	try {
		const expectedPromptSha256 = protocol.milestonePromptSha256;
		if (expectedPromptSha256 === null) return unrepresentable();
		const entries = parseSessionLines(input.raw.toString("utf8"), input.label);
		const rawSha256 = sha256Hex(input.raw);
		const attempt = deriveAttemptFactsV2(
			input.label,
			input.arm,
			FINAL_SESSION_BASENAME_V2,
			rawSha256,
			entries,
			expectedPromptSha256,
			protocol.environment,
			{ strict: false },
		);
		if (attempt.category !== "unclassified") {
			return {
				verdict: "invalid",
				runFacts: null,
				attemptFacts: attempt,
				detail: CATEGORY_DETAIL_V2[attempt.category],
				...diagnostic,
			};
		}
		const run = computeRunFactsV2(
			input.label,
			input.arm,
			1,
			FINAL_SESSION_BASENAME_V2,
			rawSha256,
			entries,
			expectedPromptSha256,
			protocol.environment,
			{ enforceValidity: true },
		);
		return {
			verdict: "valid",
			runFacts: run,
			attemptFacts: null,
			detail: VALID_DETAIL_V2,
			...diagnostic,
		};
	} catch {
		return unrepresentable();
	}
}

// ---------------------------------------------------------------------------
// Non-treatment bundle hash (read-only, deterministic — protocol-v2 §3.2/§5.2)
// ---------------------------------------------------------------------------

/** Frozen non-treatment bundle roots relative to the project root (§3.2/§5.2, v1 parity). */
export const BUNDLE_ROOT_ENTRIES_V2 = ["AGENTS.md", "skills", "prompts", "templates"] as const;

/**
 * The only structured v2 final-collector failure codes: the three
 * bundle-hash codes, the eight frozen inputs-preflight codes, the six
 * frozen system-preflight codes and the twelve persistence codes —
 * bundle pin drift, Node pin drift, package manifest shape, package
 * pin drift, pi binary, arm files (protocol-v2 §3.2/§3.3/§5), plus the
 * persistence core's exclusive-create refusal (EXISTING_OUTPUT),
 * storage-layout/ownership failures (STORAGE_IO), strict record-parse
 * failures (RECORD_INVALID), record-file IO failures (RECORD_IO), the
 * retained-source helpers' over-bounded-raw refusal
 * (SOURCE_OVER_BOUND), existing-destination refusal (SOURCE_EXISTS)
 * and source IO/ownership failures (SOURCE_IO), the attempt-session
 * directory's existing-entry refusal (ATTEMPT_DIR_EXISTS) and
 * creation/ownership failures (ATTEMPT_DIR_IO), and the
 * produced-session locator's entry-count refusal
 * (SESSION_FILE_COUNT), over-bounded refusal (SESSION_OVER_BOUND)
 * and IO/ownership failures (SESSION_IO), plus the two collection-loop
 * codes: spawn start failure (ATTEMPT_START_FAILED) and
 * unrepresentable classification (ATTEMPT_UNREPRESENTABLE).
 */
export type NroV2FinalCollectErrorCode =
	| "BUNDLE_UNSAFE"
	| "BUNDLE_OVER_BOUND"
	| "BUNDLE_PATH_UNSAFE"
	| "BUNDLE_MISMATCH"
	| "PROTOCOL_UNFROZEN"
	| "INPUTS_INVALID"
	| "OVER_BOUND"
	| "FIXTURE_MISMATCH"
	| "MILESTONE_MISMATCH"
	| "ENV_FILE_INVALID"
	| "RUBRIC_INVALID"
	| "RUBRIC_MISMATCH"
	| "NODE_MISMATCH"
	| "PACKAGE_JSON_INVALID"
	| "PACKAGE_PIN_MISMATCH"
	| "PI_BINARY_UNSAFE"
	| "ARM_FILE_UNSAFE"
	| "EXISTING_OUTPUT"
	| "STORAGE_IO"
	| "RECORD_INVALID"
	| "RECORD_IO"
	| "SOURCE_OVER_BOUND"
	| "SOURCE_EXISTS"
	| "SOURCE_IO"
	| "ATTEMPT_DIR_EXISTS"
	| "ATTEMPT_DIR_IO"
	| "SESSION_FILE_COUNT"
	| "SESSION_OVER_BOUND"
	| "SESSION_IO"
	| "ATTEMPT_START_FAILED"
	| "ATTEMPT_UNREPRESENTABLE";

/**
 * Structured v2 final-collector failure — fail closed. Messages are
 * fixed and bounded: they may carry at most a sanitized, length-capped
 * relative entry name or a frozen child basename (never the inputs
 * root, never an absolute path, never raw fs error text and never file
 * content).
 */
export class NroV2FinalCollectError extends Error {
	readonly code: NroV2FinalCollectErrorCode;
	constructor(code: NroV2FinalCollectErrorCode, message: string) {
		super(message);
		this.name = "NroV2FinalCollectError";
		this.code = code;
	}
}

export interface BundleHashResultV2 {
	/** SHA-256 over the sorted `"<rel>:<fileSha>\n"` row concatenation. */
	sha256: string;
	/** Files as relative POSIX paths (code-unit sorted). */
	files: string[];
	/** Exact total raw bytes of every hashed file. */
	totalBytes: number;
}

/**
 * Narrowly injectable bundle bounds for tests. Every field is optional
 * and defaults to the frozen v1 constants (`FIXTURE_MAX_FILES`,
 * `FIXTURE_MAX_BYTES`, `PATH_MAX_BYTES`) — production callers pass no
 * options and always run against the frozen defaults.
 */
export interface BundleHashBoundsV2 {
	/** At most this many files; default `FIXTURE_MAX_FILES` (10 000). */
	maxFiles?: number;
	/** At most this many total bytes; default `FIXTURE_MAX_BYTES` (64 MiB). */
	maxBytes?: number;
	/** At most this many UTF-8 bytes per relative path; default `PATH_MAX_BYTES` (512). */
	maxPathBytes?: number;
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const DETAIL_MAX_CHARS = 160;

/** Bounded, control-character-safe diagnostic detail (relative names only). */
function boundDetail(text: string): string {
	const cleaned = text.replace(/[\x00-\x1f\x7f]/g, " ");
	return cleaned.length <= DETAIL_MAX_CHARS ? cleaned : `${cleaned.slice(0, DETAIL_MAX_CHARS - 1)}…`;
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Deterministic non-treatment bundle hash (protocol-v2 §3.2/§5.2, v1
 * parity): the frozen bundle is exactly `AGENTS.md` plus everything
 * under `skills/`, `prompts/` and `templates/` (relative to the
 * project root). Walk regular files and directories only — symlinks
 * and any other entry type fail closed, with every file (including the
 * root `AGENTS.md`) AND every root directory (`skills`/`prompts`/
 * `templates`) inspected through no-follow `lstat` semantics so a
 * symlinked root file or a symlinked root directory is rejected
 * instead of followed — then SHA-256 over the concatenation of
 * `"<relativePath>:<sha256>\n"` per file sorted by relative path
 * (code-unit order). Bounds: at most `FIXTURE_MAX_BYTES` total,
 * `FIXTURE_MAX_FILES` files, `PATH_MAX_BYTES` per path, no control
 * characters in any path. Empty directories are allowed; all four
 * roots must exist with their correct types. The result must equal the
 * frozen `non_treatment_sha256` pin captured at the fixture freeze.
 * Read-only: never writes. Errors are `NroV2FinalCollectError` with
 * fixed, bounded, privacy-safe messages.
 */
export async function nonTreatmentBundleHashV2(projectRoot: string, bounds: BundleHashBoundsV2 = {}): Promise<BundleHashResultV2> {
	const maxFiles = bounds.maxFiles ?? FIXTURE_MAX_FILES;
	const maxBytes = bounds.maxBytes ?? FIXTURE_MAX_BYTES;
	const maxPathBytes = bounds.maxPathBytes ?? PATH_MAX_BYTES;
	const rows: Array<{ rel: string; sha: string }> = [];
	let totalBytes = 0;

	const addFile = async (rel: string, full: string): Promise<void> => {
		if (utf8Bytes(rel) > maxPathBytes) throw new NroV2FinalCollectError("BUNDLE_PATH_UNSAFE", `non-treatment bundle path exceeds ${maxPathBytes} bytes`);
		if (CONTROL_CHAR_RE.test(rel)) throw new NroV2FinalCollectError("BUNDLE_PATH_UNSAFE", "non-treatment bundle path contains control characters");
		if (rows.length >= maxFiles) throw new NroV2FinalCollectError("BUNDLE_OVER_BOUND", `non-treatment bundle exceeds ${maxFiles} files`);
		let info;
		try {
			// No-follow: a symlink is never a bundle file, even at the root.
			info = await lstat(full);
		} catch {
			throw new NroV2FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle file "${boundDetail(rel)}" cannot be inspected`);
		}
		if (!info.isFile()) throw new NroV2FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle entry "${boundDetail(rel)}" is not a regular file`);
		if (info.size > maxBytes - totalBytes) throw new NroV2FinalCollectError("BUNDLE_OVER_BOUND", `non-treatment bundle exceeds ${maxBytes} bytes total`);
		let raw: Buffer;
		try {
			raw = await readFile(full);
		} catch {
			throw new NroV2FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle file "${boundDetail(rel)}" cannot be read`);
		}
		totalBytes += raw.length;
		rows.push({ rel, sha: sha256Hex(raw) });
	};

	const walkDir = async (current: string, relPrefix: string): Promise<void> => {
		let names: Dirent[];
		try {
			names = await readdir(current, { withFileTypes: true });
		} catch {
			throw new NroV2FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle directory "${boundDetail(relPrefix)}" cannot be read`);
		}
		names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const dirent of names) {
			const rel = relPrefix.length === 0 ? dirent.name : `${relPrefix}/${dirent.name}`;
			if (utf8Bytes(rel) > maxPathBytes) throw new NroV2FinalCollectError("BUNDLE_PATH_UNSAFE", `non-treatment bundle path exceeds ${maxPathBytes} bytes`);
			if (CONTROL_CHAR_RE.test(rel)) throw new NroV2FinalCollectError("BUNDLE_PATH_UNSAFE", "non-treatment bundle path contains control characters");
			if (dirent.isSymbolicLink()) throw new NroV2FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle entry "${boundDetail(rel)}" is a symlink`);
			if (dirent.isDirectory()) {
				await walkDir(join(current, dirent.name), rel);
				continue;
			}
			if (!dirent.isFile()) throw new NroV2FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle entry "${boundDetail(rel)}" is not a regular file`);
			await addFile(rel, join(current, dirent.name));
		}
	};

	for (const entry of BUNDLE_ROOT_ENTRIES_V2) {
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
			throw new NroV2FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle directory "${entry}" cannot be inspected`);
		}
		if (info.isSymbolicLink()) throw new NroV2FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle entry "${entry}" is a symlink`);
		if (!info.isDirectory()) throw new NroV2FinalCollectError("BUNDLE_UNSAFE", `non-treatment bundle entry "${entry}" is not a directory`);
		await walkDir(full, entry);
	}

	rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	const joined = rows.map((r) => `${r.rel}:${r.sha}\n`).join("");
	return { sha256: sha256Hex(joined), files: rows.map((r) => r.rel), totalBytes };
}

// ---------------------------------------------------------------------------
// Inputs preflight (protocol-v2 §3.2/§3.3/§5) — read-only, nothing is written
// ---------------------------------------------------------------------------

/** Frozen rubric pattern cap (512 UTF-8 bytes, same frozen value as the v1/v2 cores) — mirrored locally, never imported. */
const RUBRIC_PATTERN_MAX_BYTES = 512;
/** Frozen bounded-safe rubric check id shape (same as the v2 core). */
const CHECK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Exact root key set of the frozen schema-2 rubric file. */
const RUBRIC_ROOT_KEYS = ["schema_version", "checks"] as const;
/** Exact per-check key set of the frozen schema-2 rubric file. */
const RUBRIC_CHECK_KEYS = ["id", "pattern"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Strict unknown-key refusal (fail closed RUBRIC_INVALID with a fixed message — the offending key never surfaces). */
function requireRubricKeysCollectorV2(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) throw new NroV2FinalCollectError("RUBRIC_INVALID", `unknown key in ${where}`);
	}
}

/**
 * Strict schema-2 rubric parse for the inputs preflight, reimplemented
 * LOCALLY on the frozen v2 policy leaf (`V2_RUBRIC_CHECKS`) — the v2
 * prepare/analyze adapters are never imported. The rubric text must be
 * a JSON object with exactly the keys `schema_version` and `checks`;
 * `schema_version` exactly `BENCHMARK_SCHEMA_VERSION` (2); and
 * `checks` exactly the six frozen `V2_RUBRIC_CHECKS` in frozen order —
 * each check an object with exactly `id` and `pattern`, a bounded safe
 * unique id, and a non-empty pattern of at most 512 UTF-8 bytes that
 * compiles as a JavaScript regular expression. Any malformed shape
 * fails closed RUBRIC_INVALID; any count/id/pattern drift from the
 * frozen checks fails closed RUBRIC_MISMATCH — the raw hash pin is
 * only compared after this strict structural parse. Messages render
 * only frozen ids and fixed names — never file content.
 */
function parseRubricFileForCollectorV2(text: string, where: string): RubricCheckV2[] {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new NroV2FinalCollectError("RUBRIC_INVALID", `${where} is not valid JSON`);
	}
	const root = asRecord(raw);
	if (!root) throw new NroV2FinalCollectError("RUBRIC_INVALID", `${where} must be a JSON object`);
	requireRubricKeysCollectorV2(root, RUBRIC_ROOT_KEYS, where);
	if (root.schema_version !== BENCHMARK_SCHEMA_VERSION) {
		throw new NroV2FinalCollectError("RUBRIC_INVALID", `${where}.schema_version must be ${BENCHMARK_SCHEMA_VERSION}`);
	}
	const checksRaw = root.checks;
	if (!Array.isArray(checksRaw)) throw new NroV2FinalCollectError("RUBRIC_INVALID", `${where}.checks must be an array`);
	if (checksRaw.length !== V2_RUBRIC_CHECKS.length) {
		throw new NroV2FinalCollectError("RUBRIC_MISMATCH", `${where} must carry exactly the ${V2_RUBRIC_CHECKS.length} frozen v2 checks in frozen order (got ${checksRaw.length})`);
	}
	const checks: RubricCheckV2[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < checksRaw.length; i += 1) {
		const c = asRecord(checksRaw[i]);
		if (!c) throw new NroV2FinalCollectError("RUBRIC_INVALID", `${where}[${i}] must be an object`);
		requireRubricKeysCollectorV2(c, RUBRIC_CHECK_KEYS, `${where}[${i}]`);
		const frozen = V2_RUBRIC_CHECKS[i];
		if (!frozen) throw new NroV2FinalCollectError("RUBRIC_INVALID", `${where}[${i}] is outside the frozen check list`);
		const id = c.id;
		if (typeof id !== "string" || !CHECK_ID_RE.test(id)) {
			throw new NroV2FinalCollectError("RUBRIC_INVALID", `${where}[${i}].id must match [A-Za-z0-9][A-Za-z0-9._-]* with at most 64 characters`);
		}
		if (seen.has(id)) throw new NroV2FinalCollectError("RUBRIC_INVALID", `duplicate rubric check id \"${id}\"`);
		seen.add(id);
		if (id !== frozen.id) {
			throw new NroV2FinalCollectError("RUBRIC_MISMATCH", `${where}[${i}].id must be the frozen check id \"${frozen.id}\" at frozen position ${i}`);
		}
		const pattern = c.pattern;
		if (typeof pattern !== "string" || pattern.length === 0 || utf8Bytes(pattern) > RUBRIC_PATTERN_MAX_BYTES) {
			throw new NroV2FinalCollectError("RUBRIC_INVALID", `${where}[${i}].pattern must be a non-empty string of at most ${RUBRIC_PATTERN_MAX_BYTES} UTF-8 bytes`);
		}
		if (pattern !== frozen.pattern) {
			throw new NroV2FinalCollectError("RUBRIC_MISMATCH", `${where}[${i}].pattern must be the frozen v2 pattern for check \"${frozen.id}\"`);
		}
		try {
			// eslint-disable-next-line no-new
			new RegExp(pattern);
		} catch {
			throw new NroV2FinalCollectError("RUBRIC_INVALID", `${where}[${i}].pattern must be a compilable regular expression`);
		}
		checks.push({ id, pattern });
	}
	return checks;
}

/**
 * Fail closed when the supplied protocol is not EXACTLY the frozen v2
 * protocol: every one of the four content pins (milestone prompt,
 * fixture manifest, non-treatment bundle, rubric) must equal the frozen
 * pin (never null), the environment must equal the frozen
 * model/thinking/Pi/Node pins field by field, and the frozen cohort
 * fields (`runsPerArm`, `interleave`) must match exactly. The check
 * runs BEFORE any filesystem access — drift is rejected with the
 * stable `PROTOCOL_UNFROZEN` collector code and a fixed message that
 * never renders the drifted values.
 */
function requireFrozenProtocolForCollectorV2(protocol: V2FrozenProtocol): void {
	const frozen = FROZEN_NRO_V2_PROTOCOL;
	const pinsMatch =
		protocol.milestonePromptSha256 === frozen.milestonePromptSha256 &&
		protocol.fixtureManifestSha256 === frozen.fixtureManifestSha256 &&
		protocol.nonTreatmentSha256 === frozen.nonTreatmentSha256 &&
		protocol.rubricSha256 === frozen.rubricSha256;
	const envMatches =
		protocol.environment.modelKey === frozen.environment.modelKey &&
		protocol.environment.thinkingLevel === frozen.environment.thinkingLevel &&
		protocol.environment.piVersion === frozen.environment.piVersion &&
		protocol.environment.nodeVersion === frozen.environment.nodeVersion;
	const cohortMatches = protocol.runsPerArm === frozen.runsPerArm && protocol.interleave === frozen.interleave;
	if (!pinsMatch || !envMatches || !cohortMatches) {
		throw new NroV2FinalCollectError(
			"PROTOCOL_UNFROZEN",
			"the supplied protocol must equal the frozen v2 protocol exactly (all four content pins, the exact pinned environment and the frozen cohort runsPerArm/interleave)",
		);
	}
}

/** lstat an inputs child, failing closed as INPUTS_INVALID with the fixed child basename only. */
async function lstatInputsChildForCollectorV2(inputsDir: string, name: string): Promise<Stats> {
	try {
		return await lstat(join(inputsDir, name));
	} catch {
		throw new NroV2FinalCollectError("INPUTS_INVALID", `inputs \"${name}\" cannot be inspected`);
	}
}

/**
 * Facts the future v2 collector consumes from the inputs preflight.
 * Deliberately carries NO path fields (the caller already holds the
 * inputs dir and the frozen child basenames live in the v2 protocol
 * module): fixture facts are safe relative POSIX paths only, and the
 * three raw buffers are the exact input bytes captured at preflight —
 * byte-exact by construction for any later staging copy.
 */
export interface FrozenInputsFactsForCollectorV2 {
	fixture: Awaited<ReturnType<typeof fixtureManifestHash>>;
	milestonePromptSha256: string;
	environment: V2FrozenProtocol["environment"];
	rubricSha256: string;
	rubricChecks: RubricCheckV2[];
	/** Raw bytes captured at preflight — byte-exact by construction. */
	milestonePromptRaw: Buffer;
	environmentRaw: Buffer;
	rubricRaw: Buffer;
}

/**
 * Preflight the frozen v2 inputs directory (protocol-v2 §3.2/§3.3/§5),
 * fully read-only: exactly `fixture/`, `milestone-prompt.txt`,
 * `environment.txt` and `rubric.json`, each verified against the frozen
 * pins — fixture manifest hash, prompt raw bytes/hash, the exact
 * canonical four-line environment file (no extra newline), and the
 * schema-2 rubric (strict structure FIRST, then the raw hash pin). The
 * supplied protocol must equal every frozen v2 pin/environment field
 * BEFORE any filesystem access. The inputs root and the exact four
 * children are lstat-validated before any read (never following a
 * symlink): root and `fixture` must be real directories; the other
 * three must be non-symlink regular files with explicit bounded sizes
 * (prompt/rubric at most `SESSION_MAX_BYTES`, environment at most the
 * exact canonical environment bytes). Nothing is written and no output
 * root is created; errors are `NroV2FinalCollectError` with fixed,
 * bounded, privacy-safe messages carrying fixed child basenames only.
 */
export async function preflightInputsForCollectorV2(inputsDir: string, protocol: V2FrozenProtocol = FROZEN_NRO_V2_PROTOCOL): Promise<FrozenInputsFactsForCollectorV2> {
	// 1. Frozen protocol identity FIRST — before any filesystem access.
	requireFrozenProtocolForCollectorV2(protocol);
	const env = protocol.environment;
	const envCanonical = canonicalEnvironmentFile(env);
	const envCanonicalBytes = utf8Bytes(envCanonical);
	const expected = new Set([FIXTURE_DIR_NAME, MILESTONE_PROMPT_NAME, ENVIRONMENT_NAME, RUBRIC_NAME]);

	// 2. The inputs ROOT must itself be a real directory — a symlinked or
	// special path is refused before any read (never follow a symlink).
	let inputsLst: Stats;
	try {
		inputsLst = await lstat(inputsDir);
	} catch {
		throw new NroV2FinalCollectError("INPUTS_INVALID", "inputs directory cannot be inspected");
	}
	if (!inputsLst.isDirectory() || inputsLst.isSymbolicLink()) {
		throw new NroV2FinalCollectError("INPUTS_INVALID", "inputs path must be a real directory (symlinks and special entries are rejected)");
	}

	// 3. Exactly the four frozen direct children — no missing, no extra.
	let names: string[];
	try {
		names = await readdir(inputsDir);
	} catch {
		throw new NroV2FinalCollectError("INPUTS_INVALID", "inputs directory cannot be read");
	}
	for (const name of names) {
		if (!expected.has(name)) {
			throw new NroV2FinalCollectError("INPUTS_INVALID", "inputs directory must contain exactly fixture/, milestone-prompt.txt, environment.txt and rubric.json — an unexpected entry is rejected");
		}
	}
	if (names.length !== expected.size) {
		throw new NroV2FinalCollectError("INPUTS_INVALID", `inputs directory must contain exactly fixture/, milestone-prompt.txt, environment.txt and rubric.json (got ${names.length} entries)`);
	}

	// 4. lstat-validate the exact four children BEFORE any read: fixture
	// must be a real directory, and the three frozen files must be
	// non-symlink regular files with explicit bounded sizes (readFile is
	// never reached with an unbounded, symlinked or special input).
	const fixtureLst = await lstatInputsChildForCollectorV2(inputsDir, FIXTURE_DIR_NAME);
	if (!fixtureLst.isDirectory() || fixtureLst.isSymbolicLink()) {
		throw new NroV2FinalCollectError(
			"INPUTS_INVALID",
			`fixture directory \"${FIXTURE_DIR_NAME}\" must be a real directory (symlinks and special entries are rejected)`,
		);
	}
	const promptLst = await lstatInputsChildForCollectorV2(inputsDir, MILESTONE_PROMPT_NAME);
	if (!promptLst.isFile() || promptLst.isSymbolicLink()) {
		throw new NroV2FinalCollectError("INPUTS_INVALID", `inputs \"${MILESTONE_PROMPT_NAME}\" must be a non-symlink regular file`);
	}
	if (promptLst.size > SESSION_MAX_BYTES) {
		throw new NroV2FinalCollectError("OVER_BOUND", `inputs \"${MILESTONE_PROMPT_NAME}\" exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	const environmentLst = await lstatInputsChildForCollectorV2(inputsDir, ENVIRONMENT_NAME);
	if (!environmentLst.isFile() || environmentLst.isSymbolicLink()) {
		throw new NroV2FinalCollectError("INPUTS_INVALID", `inputs \"${ENVIRONMENT_NAME}\" must be a non-symlink regular file`);
	}
	if (environmentLst.size > envCanonicalBytes) {
		throw new NroV2FinalCollectError("OVER_BOUND", `inputs \"${ENVIRONMENT_NAME}\" exceeds the pinned canonical size (${envCanonicalBytes} bytes)`);
	}
	const rubricLst = await lstatInputsChildForCollectorV2(inputsDir, RUBRIC_NAME);
	if (!rubricLst.isFile() || rubricLst.isSymbolicLink()) {
		throw new NroV2FinalCollectError("INPUTS_INVALID", `inputs \"${RUBRIC_NAME}\" must be a non-symlink regular file`);
	}
	if (rubricLst.size > SESSION_MAX_BYTES) {
		throw new NroV2FinalCollectError("OVER_BOUND", `inputs \"${RUBRIC_NAME}\" exceeds ${SESSION_MAX_BYTES} bytes`);
	}

	// 5. Content verification against the frozen pins (read-only).
	let fixture: Awaited<ReturnType<typeof fixtureManifestHash>>;
	try {
		fixture = await fixtureManifestHash(join(inputsDir, FIXTURE_DIR_NAME));
	} catch (error) {
		// Nested fixture paths/entry names never leak: the wrapped error
		// references only the fixed fixture-directory basename.
		const code = (error as { code?: unknown }).code === "OVER_BOUND" ? "OVER_BOUND" : "INPUTS_INVALID";
		throw new NroV2FinalCollectError(code, `fixture directory \"${FIXTURE_DIR_NAME}\" could not be verified (unsafe or unreadable fixture tree)`);
	}
	if (fixture.manifestSha256 !== protocol.fixtureManifestSha256) {
		throw new NroV2FinalCollectError("FIXTURE_MISMATCH", `fixture tree SHA-256 ${fixture.manifestSha256} does not match the frozen pin ${protocol.fixtureManifestSha256}`);
	}

	let promptRaw: Buffer;
	try {
		promptRaw = await readFile(join(inputsDir, MILESTONE_PROMPT_NAME));
	} catch {
		throw new NroV2FinalCollectError("INPUTS_INVALID", `inputs \"${MILESTONE_PROMPT_NAME}\" cannot be read`);
	}
	if (promptRaw.length > SESSION_MAX_BYTES) {
		throw new NroV2FinalCollectError("OVER_BOUND", `inputs \"${MILESTONE_PROMPT_NAME}\" exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	const promptSha = sha256Hex(promptRaw);
	if (promptSha !== protocol.milestonePromptSha256) {
		throw new NroV2FinalCollectError("MILESTONE_MISMATCH", `milestone-prompt.txt SHA-256 ${promptSha} does not match the frozen pin ${protocol.milestonePromptSha256}`);
	}

	let environmentRaw: Buffer;
	try {
		environmentRaw = await readFile(join(inputsDir, ENVIRONMENT_NAME));
	} catch {
		throw new NroV2FinalCollectError("INPUTS_INVALID", `inputs \"${ENVIRONMENT_NAME}\" cannot be read`);
	}
	if (environmentRaw.toString("utf8") !== envCanonical) {
		throw new NroV2FinalCollectError(
			"ENV_FILE_INVALID",
			"environment.txt must be exactly the four pinned lines in fixed order (model_key, thinking_level, pi_version, node_version) with no extra content or newline",
		);
	}

	let rubricRaw: Buffer;
	try {
		rubricRaw = await readFile(join(inputsDir, RUBRIC_NAME));
	} catch {
		throw new NroV2FinalCollectError("INPUTS_INVALID", `inputs \"${RUBRIC_NAME}\" cannot be read`);
	}
	if (rubricRaw.length > SESSION_MAX_BYTES) {
		throw new NroV2FinalCollectError("OVER_BOUND", `inputs \"${RUBRIC_NAME}\" exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	// Strict rubric parse FIRST: a malformed rubric fails closed as
	// RUBRIC_INVALID regardless of its hash; only a structurally exact
	// schema-2 rubric is then compared against the frozen content pin
	// (content drift stays RUBRIC_MISMATCH).
	const rubricChecks = parseRubricFileForCollectorV2(rubricRaw.toString("utf8"), RUBRIC_NAME);
	const rubricSha = sha256Hex(rubricRaw);
	if (rubricSha !== protocol.rubricSha256) {
		throw new NroV2FinalCollectError("RUBRIC_MISMATCH", `rubric.json SHA-256 ${rubricSha} does not match the frozen pin ${protocol.rubricSha256}`);
	}
	return {
		fixture,
		milestonePromptSha256: promptSha,
		environment: env,
		rubricSha256: rubricSha,
		rubricChecks,
		milestonePromptRaw: promptRaw,
		environmentRaw,
		rubricRaw,
	};
}

// ---------------------------------------------------------------------------
// System/runtime preflight (protocol-v2 §3.2/§5) — read-only, nothing is written
// ---------------------------------------------------------------------------

/** Frozen project-relative package manifest path. */
export const PACKAGE_JSON_RELATIVE_V2 = "package.json";
/** Frozen project-relative pi binary path (npm symlink accepted — must resolve to a regular file). */
export const PI_BINARY_RELATIVE_V2 = "node_modules/.bin/pi";
/** Frozen project-relative control arm extension path (no-follow regular file). */
export const CONTROL_ARM_FILE_RELATIVE_V2 = "scripts/commander-native-tool-final-control-extension.ts";
/** Frozen project-relative treatment arm runtime path (no-follow regular file). */
export const TREATMENT_ARM_FILE_RELATIVE_V2 = "extensions/workbench-runtime/index.ts";

/** Narrowly injectable runtime facts for hermetic system-preflight tests. */
export interface SystemRuntimeFactsV2 {
	/**
	 * The Node runtime version to verify against the frozen Node pin.
	 * Omitted in production: the default reads the GLOBAL
	 * `process.version` — only when the preflight is called, never at
	 * module import time.
	 */
	nodeVersion?: string;
}

/**
 * Facts the future v2 collector consumes from the system preflight —
 * the verified hash/versions and the frozen RELATIVE paths only
 * (never absolute roots or paths).
 */
export interface SystemPreflightFactsV2 {
	/** The verified non-treatment bundle SHA-256 — exactly the frozen pin. */
	nonTreatmentSha256: string;
	/** The verified Node runtime version — exactly the frozen Node pin. */
	nodeVersion: string;
	/** The verified exact pi package pin — exactly the frozen Pi pin. */
	piPackageVersion: string;
	/** Verified project-relative pi binary path (resolves to a regular file). */
	piBinary: string;
	/** Verified project-relative control arm extension path (non-symlink regular file). */
	controlArmFile: string;
	/** Verified project-relative treatment arm runtime path (non-symlink regular file). */
	treatmentArmFile: string;
}

/**
 * Read-only v2 system/runtime preflight (protocol-v2 §3.2/§5), run by
 * the future collector BEFORE any output root is created or any paid
 * attempt is started. Checks, in this frozen order, each failing
 * closed with a fixed privacy-safe `NroV2FinalCollectError`:
 *
 *   1. the supplied protocol is EXACTLY the frozen v2 protocol
 *      (`PROTOCOL_UNFROZEN`) — before ANY filesystem access;
 *   2. the current non-treatment bundle reproduces the frozen
 *      `nonTreatmentSha256` pin exactly (`BUNDLE_MISMATCH`; unsafe
 *      trees fail through the bundle walker's own codes);
 *   3. the Node runtime version — the injected `runtime.nodeVersion`
 *      or, in production, the global `process.version` read ONLY
 *      here — equals the frozen Node pin exactly (`NODE_MISMATCH`);
 *   4. `package.json` is valid JSON whose
 *      `devDependencies["@earendil-works/pi-coding-agent"]` is pinned
 *      EXACTLY (un-ranged) to the frozen Pi pin
 *      (`PACKAGE_JSON_INVALID` for shape, `PACKAGE_PIN_MISMATCH` for
 *      the pin);
 *   5. `node_modules/.bin/pi` resolves through `stat` — the npm
 *      symlink is followed — to a regular file (`PI_BINARY_UNSAFE`);
 *   6. both frozen arm files are regular files AT THE PATH ITSELF
 *      under no-follow `lstat` — symlinks and special entries are
 *      rejected (`ARM_FILE_UNSAFE`).
 *
 * Read-only: nothing is written and no output root is created. Errors
 * and the returned facts never carry absolute roots/paths, raw fs
 * messages, package contents or drifted runtime values; the facts
 * carry the verified hash/versions and the frozen relative paths
 * only.
 */
export async function preflightSystemForCollectorV2(
	projectRoot: string,
	runtime: SystemRuntimeFactsV2 = {},
	protocol: V2FrozenProtocol = FROZEN_NRO_V2_PROTOCOL,
): Promise<SystemPreflightFactsV2> {
	// 1. Frozen protocol identity FIRST — before any filesystem access
	//    or runtime read.
	requireFrozenProtocolForCollectorV2(protocol);

	// 2. The current non-treatment bundle must reproduce the frozen pin
	//    exactly (unsafe trees fail closed through the bundle walker).
	const bundle = await nonTreatmentBundleHashV2(projectRoot);
	if (bundle.sha256 !== protocol.nonTreatmentSha256) {
		throw new NroV2FinalCollectError(
			"BUNDLE_MISMATCH",
			`non-treatment bundle SHA-256 ${bundle.sha256} does not match the frozen pin ${protocol.nonTreatmentSha256}`,
		);
	}

	// 3. The Node runtime version must equal the frozen Node pin exactly
	//    (production default: the global process.version, read only here).
	const nodeVersion = runtime.nodeVersion ?? process.version;
	if (nodeVersion !== protocol.environment.nodeVersion) {
		throw new NroV2FinalCollectError(
			"NODE_MISMATCH",
			`the Node runtime version must equal the frozen v2 Node pin (${protocol.environment.nodeVersion}) exactly`,
		);
	}

	// 4. package.json must be valid JSON with the exact un-ranged pi pin.
	let packageRaw: Buffer;
	try {
		packageRaw = await readFile(join(projectRoot, PACKAGE_JSON_RELATIVE_V2));
	} catch {
		throw new NroV2FinalCollectError("PACKAGE_JSON_INVALID", `project ${PACKAGE_JSON_RELATIVE_V2} cannot be read`);
	}
	let packageData: unknown;
	try {
		packageData = JSON.parse(packageRaw.toString("utf8"));
	} catch {
		throw new NroV2FinalCollectError("PACKAGE_JSON_INVALID", `project ${PACKAGE_JSON_RELATIVE_V2} must be valid JSON`);
	}
	const packageRoot = asRecord(packageData);
	if (!packageRoot) throw new NroV2FinalCollectError("PACKAGE_JSON_INVALID", `project ${PACKAGE_JSON_RELATIVE_V2} must be a JSON object`);
	const devDependencies = asRecord(packageRoot.devDependencies);
	if (!devDependencies) {
		throw new NroV2FinalCollectError("PACKAGE_JSON_INVALID", `project ${PACKAGE_JSON_RELATIVE_V2} devDependencies must be an object`);
	}
	const piPin = devDependencies["@earendil-works/pi-coding-agent"];
	if (typeof piPin !== "string" || piPin !== protocol.environment.piVersion) {
		throw new NroV2FinalCollectError(
			"PACKAGE_PIN_MISMATCH",
			`devDependencies["@earendil-works/pi-coding-agent"] must be pinned exactly to the frozen Pi version (${protocol.environment.piVersion})`,
		);
	}

	// 5. The pi binary must resolve — npm symlink followed — to a
	//    regular file.
	let piInfo: Stats;
	try {
		piInfo = await stat(join(projectRoot, PI_BINARY_RELATIVE_V2));
	} catch {
		throw new NroV2FinalCollectError("PI_BINARY_UNSAFE", `the pi binary (${PI_BINARY_RELATIVE_V2}) cannot be resolved`);
	}
	if (!piInfo.isFile()) {
		throw new NroV2FinalCollectError("PI_BINARY_UNSAFE", `the pi binary (${PI_BINARY_RELATIVE_V2}) must resolve to a regular file`);
	}

	// 6. Both frozen arm files must be regular files AT THE PATH ITSELF
	//    (no-follow lstat — symlinks and special entries are rejected).
	for (const [rel, role] of [
		[CONTROL_ARM_FILE_RELATIVE_V2, "control arm extension"],
		[TREATMENT_ARM_FILE_RELATIVE_V2, "treatment arm runtime"],
	] as const) {
		let info: Stats;
		try {
			info = await lstat(join(projectRoot, rel));
		} catch {
			throw new NroV2FinalCollectError("ARM_FILE_UNSAFE", `the ${role} (${rel}) cannot be inspected`);
		}
		if (info.isSymbolicLink() || !info.isFile()) {
			throw new NroV2FinalCollectError("ARM_FILE_UNSAFE", `the ${role} (${rel}) must be a non-symlink regular file`);
		}
	}

	return {
		nonTreatmentSha256: bundle.sha256,
		nodeVersion,
		piPackageVersion: piPin,
		piBinary: PI_BINARY_RELATIVE_V2,
		controlArmFile: CONTROL_ARM_FILE_RELATIVE_V2,
		treatmentArmFile: TREATMENT_ARM_FILE_RELATIVE_V2,
	};
}

// ---------------------------------------------------------------------------
// FINAL collector persistence core (protocol-v2 §5) — schema-2 initial
// record, exclusive storage initialization, atomic record updates and
// retained-source persistence helpers ONLY
// ---------------------------------------------------------------------------

/** Frozen sources-directory basename inside the v2 collection root (retained sources live here). */
export const SOURCES_DIR_NAME_V2 = "sources";

/**
 * The canonical schema-2 FINAL initial collection record (protocol-v2
 * §5): schema_version 2, protocol_version 2, the exact frozen
 * protocol_doc, phase "final", all four frozen content pins, the
 * pinned environment and an EMPTY entries list — the state the
 * collector writes and verifies before any paid process. The supplied
 * protocol must be EXACTLY the frozen v2 protocol (fail closed
 * PROTOCOL_UNFROZEN before anything is built). The builder ITSELF
 * performs the strict canonical roundtrip: the built record is
 * serialized and re-parsed through the v2 core strict parser
 * (`parseCollectionRecordV2` over `collectionRecordToJsonV2`), the
 * parsed form must re-serialize byte-exactly, and the PARSED record
 * is what is returned — a caller can never obtain a non-canonical
 * initial record.
 */
/** The four resolved content pins of the frozen protocol (non-null by the frozen freeze contract). */
function frozenPinV2(pin: string | null): string {
	if (pin === null) {
		throw new NroV2FinalCollectError("PROTOCOL_UNFROZEN", "the frozen v2 protocol must carry all four resolved content pins");
	}
	return pin;
}

export function buildInitialCollectionRecordV2(protocol: V2FrozenProtocol = FROZEN_NRO_V2_PROTOCOL): CollectionRecordV2 {
	requireFrozenProtocolForCollectorV2(protocol);
	// The frozen check guarantees the supplied protocol equals the frozen
	// protocol EXACTLY — the pins/environment below are the frozen ones
	// (non-null by the freeze contract), so the record always carries the
	// four frozen pins and the pinned environment regardless of the
	// caller's argument.
	const frozen = FROZEN_NRO_V2_PROTOCOL;
	const record: CollectionRecordV2 = {
		schemaVersion: COLLECTION_SCHEMA_VERSION,
		protocolVersion: PROTOCOL_VERSION,
		protocolDoc: PROTOCOL_DOC,
		phase: "final",
		milestonePromptSha256: frozenPinV2(frozen.milestonePromptSha256),
		fixtureManifestSha256: frozenPinV2(frozen.fixtureManifestSha256),
		nonTreatmentSha256: frozenPinV2(frozen.nonTreatmentSha256),
		rubricSha256: frozenPinV2(frozen.rubricSha256),
		environment: frozen.environment,
		entries: [],
	};
	const canonical = collectionRecordToJsonV2(record);
	let parsed: CollectionRecordV2;
	try {
		parsed = parseCollectionRecordV2(canonical);
	} catch {
		throw new NroV2FinalCollectError("RECORD_INVALID", "the initial collection record failed the strict v2 collection-record parse");
	}
	if (collectionRecordToJsonV2(parsed) !== canonical) {
		throw new NroV2FinalCollectError("RECORD_INVALID", "the initial collection record is not the strict canonical v2 form");
	}
	return parsed;
}

/** No-follow filesystem identity: dev + ino + entry kind — never a path. */
export interface FsIdentityV2 {
	readonly dev: number;
	readonly ino: number;
	readonly kind: "file" | "directory" | "other";
}

function identityOfV2(info: Stats): FsIdentityV2 {
	return { dev: info.dev, ino: info.ino, kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other" };
}

/** True when the current no-follow identity still matches the tracked owned identity. */
function identityMatchesV2(current: FsIdentityV2, tracked: FsIdentityV2): boolean {
	return current.dev === tracked.dev && current.ino === tracked.ino && current.kind === tracked.kind;
}

/** Best-effort no-follow identity read for ownership checks — never throws. */
async function currentIdentityV2(path: string): Promise<FsIdentityV2 | null> {
	try {
		return identityOfV2(await lstat(path));
	} catch {
		return null;
	}
}

/** No-follow owned-identity gate for the persistence stages — fails closed with `code` (default STORAGE_IO). */
async function requireOwnedV2(
	path: string,
	tracked: FsIdentityV2,
	what: string,
	code: NroV2FinalCollectErrorCode = "STORAGE_IO",
): Promise<void> {
	const current = await currentIdentityV2(path);
	if (current === null || !identityMatchesV2(current, tracked)) {
		throw new NroV2FinalCollectError(code, `${what} was replaced or is no longer the owned entry`);
	}
}

function isEexistsV2(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}

/**
 * Non-recursive exclusive directory create: `mkdir` without the
 * recursive flag — a pre-existing or racing entry fails closed with
 * `existsCode` (default EXISTING_OUTPUT) and is never overwritten; any
 * other failure is `ioCode` (default STORAGE_IO). The owned identity
 * is tracked immediately after the exclusive create (no-follow lstat).
 */
async function exclusiveMkdirV2(
	path: string,
	what: string,
	existsCode: NroV2FinalCollectErrorCode = "EXISTING_OUTPUT",
	ioCode: NroV2FinalCollectErrorCode = "STORAGE_IO",
): Promise<FsIdentityV2> {
	await mkdir(path).catch((error: unknown) => {
		if (isEexistsV2(error)) {
			throw new NroV2FinalCollectError(existsCode, `${what} already exists and is never overwritten`);
		}
		throw new NroV2FinalCollectError(ioCode, `${what} could not be created`);
	});
	try {
		return identityOfV2(await lstat(path));
	} catch {
		throw new NroV2FinalCollectError(ioCode, `${what} could not be verified after creation`);
	}
}

/**
 * Exclusive regular-file create (`wx`), write the exact bytes, sync
 * and close; returns the identity of the EXACT file created — read
 * from the open handle (fstat), never from a path race. A
 * pre-existing entry fails closed with `existsCode` and is never
 * overwritten; create/write failures are RECORD_IO with fixed
 * privacy-safe messages.
 */
async function exclusiveWriteFileV2(path: string, bytes: Buffer, what: string, existsCode: NroV2FinalCollectErrorCode): Promise<FsIdentityV2> {
	const handle = await open(path, "wx").catch((error: unknown) => {
		if (isEexistsV2(error)) {
			throw new NroV2FinalCollectError(existsCode, `${what} already exists and is never overwritten`);
		}
		throw new NroV2FinalCollectError("RECORD_IO", `${what} could not be created exclusively`);
	});
	try {
		const identity = identityOfV2(await handle.stat());
		await writeFile(handle, bytes);
		await handle.sync();
		await handle.close();
		return identity;
	} catch {
		await handle.close().catch(() => undefined);
		throw new NroV2FinalCollectError("RECORD_IO", `${what} could not be written`);
	}
}

/**
 * The owned v2 collection-storage state returned by
 * `initializeCollectionStorageV2` and consumed by
 * `writeCollectionRecordV2`, `retainRawSourceV2` and
 * `removeOwnedRetainedSourceV2`. The public facts are the frozen
 * RELATIVE names and the tracked ownership identities (dev+ino+kind —
 * never paths). The absolute root/sources/record paths are private
 * in-process plumbing: never rendered in errors or facts and never
 * serialized (JSON serialization exposes only the public relative
 * names and identities).
 *
 * Construction is module-private: the constructor requires the
 * module-local brand, so ordinary callers cannot forge arbitrary
 * storage state — a real storage can only be obtained from
 * `initializeCollectionStorageV2` (or a committed
 * `writeCollectionRecordV2` return).
 */
/** Module-local brand token — `CollectionStorageV2` is constructible only inside this module. */
const COLLECTION_STORAGE_V2_BRAND: unique symbol = Symbol("CollectionStorageV2");

export class CollectionStorageV2 {
	/** Public frozen relative root name — never an absolute path. */
	readonly rootName = OUTPUT_ROOT_NAME_V2;
	/** Public frozen relative sources-directory name. */
	readonly sourcesName = SOURCES_DIR_NAME_V2;
	/** Public frozen relative collection-record name. */
	readonly recordName = COLLECTION_RECORD_NAME;
	/** The owned root identity at initialization (dev+ino+kind — never a path). */
	readonly rootIdentity: FsIdentityV2;
	/** The owned sources-directory identity at initialization (dev+ino+kind — never a path). */
	readonly sourcesIdentity: FsIdentityV2;
	#rootPath: string;
	#sourcesPath: string;
	#recordPath: string;
	#recordIdentity: FsIdentityV2;

	/** @internal Module-private construction — see the module factory below. */
	constructor(rootPath: string, rootIdentity: FsIdentityV2, sourcesIdentity: FsIdentityV2, recordIdentity: FsIdentityV2, brand: typeof COLLECTION_STORAGE_V2_BRAND) {
		if (brand !== COLLECTION_STORAGE_V2_BRAND) {
			throw new TypeError("CollectionStorageV2 is constructible only by the v2 persistence core");
		}
		this.#rootPath = rootPath;
		this.#sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		this.rootIdentity = rootIdentity;
		this.sourcesIdentity = sourcesIdentity;
		this.#recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		this.#recordIdentity = recordIdentity;
	}

	/** The current tracked record identity — updated after every committed write. */
	get recordIdentity(): FsIdentityV2 {
		return this.#recordIdentity;
	}

	/** @internal Absolute root path — in-process plumbing, never serialized or rendered. */
	get rootPathAbs(): string {
		return this.#rootPath;
	}

	/** @internal Absolute sources path — in-process plumbing, never serialized or rendered. */
	get sourcesPathAbs(): string {
		return this.#sourcesPath;
	}

	/** @internal Absolute record path — in-process plumbing, never serialized or rendered. */
	get recordPathAbs(): string {
		return this.#recordPath;
	}

	/** @internal Replace the tracked record identity after a committed atomic publish. */
	updateRecordIdentity(identity: FsIdentityV2): void {
		this.#recordIdentity = identity;
	}
}

/** Module-private factory — the ONLY way to obtain a `CollectionStorageV2`. */
function createCollectionStorageV2(rootPath: string, rootIdentity: FsIdentityV2, sourcesIdentity: FsIdentityV2, recordIdentity: FsIdentityV2): CollectionStorageV2 {
	return new CollectionStorageV2(rootPath, rootIdentity, sourcesIdentity, recordIdentity, COLLECTION_STORAGE_V2_BRAND);
}

/** Narrow deterministic initialization hooks — run after each exclusive-create stage to inject race/failure scenarios in tests. */
export interface InitializeCollectionStorageV2Hooks {
	/** Runs after the exclusive output-root create, before `sources/` — inject races/failures here. */
	afterRootCreate?: () => void | Promise<void>;
	/** Runs after the exclusive `sources/` create, before the record — inject races/failures here. */
	afterSourcesCreate?: () => void | Promise<void>;
	/** Runs after the exclusive record open (identity tracked), before the write — inject races/failures here. */
	afterRecordOpen?: () => void | Promise<void>;
	/** Runs after the record write/sync/close, before the read-back verify — inject races/failures here. */
	afterRecordCommit?: () => void | Promise<void>;
	/** Runs after the successful record read-back verify, before returning — inject races/failures here. */
	afterRecordReadBack?: () => void | Promise<void>;
}

/**
 * Exclusive v2 FINAL storage initialization (protocol-v2 §5): create
 * `<runsDir>/<OUTPUT_ROOT_NAME_V2>` by NON-RECURSIVE exclusive mkdir,
 * then the exclusive `sources/` directory, then exclusively
 * create/write/sync/close the canonical initial `collection-record.json`
 * and read it back byte-exact. Any pre-existing or racing output
 * entry is refused with EXISTING_OUTPUT — nothing is ever
 * overwritten.
 *
 * The no-follow owned identities (dev+ino+kind) of the root and of
 * `sources/` are REVALIDATED before every descendant write, and the
 * root/sources/record identities are revalidated again before
 * returning: a foreign replacement at any stage fails closed
 * STORAGE_IO without creating descendants inside the foreign entry
 * and without touching it.
 *
 * On any failure the invocation rolls back ONLY its own entries whose
 * current no-follow dev+ino+kind identity still matches the identity
 * tracked immediately after each exclusive create — removed
 * non-recursively, children before root (never a recursive or forced
 * removal): foreign replacements and injected foreign children always
 * survive, and an owned root holding a foreign child is left in
 * place. Hook failures propagate unchanged after the rollback.
 *
 * The returned storage carries the tracked identities and the frozen
 * RELATIVE names; absolute paths are private plumbing that never
 * appears in serialized facts or error messages.
 */
export async function initializeCollectionStorageV2(
	runsDir: string,
	protocol: V2FrozenProtocol = FROZEN_NRO_V2_PROTOCOL,
	hooks: InitializeCollectionStorageV2Hooks = {},
): Promise<CollectionStorageV2> {
	const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
	const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
	const recordPath = join(rootPath, COLLECTION_RECORD_NAME);

	// 1. The canonical initial record: the builder itself guarantees the
	//    strict canonical roundtrip; serialize it for the exclusive write.
	const bytes = Buffer.from(collectionRecordToJsonV2(buildInitialCollectionRecordV2(protocol)), "utf8");

	// 2. Invocation-owned entries with identities tracked immediately
	//    after each exclusive create. Rollback removes ONLY entries whose
	//    current no-follow identity still matches, children before root,
	//    non-recursively.
	const owned = new Map<string, FsIdentityV2>();
	const rollback = async (): Promise<void> => {
		for (const path of [recordPath, sourcesPath, rootPath]) {
			const tracked = owned.get(path);
			if (tracked === undefined) continue;
			const current = await currentIdentityV2(path);
			if (current === null || !identityMatchesV2(current, tracked)) continue;
			try {
				if (tracked.kind === "directory") await rmdir(path);
				else await unlink(path);
			} catch {
				// non-empty (foreign children injected) or blocked: the owned
				// entry survives with its foreign children — never forced
			}
		}
	};

	try {
		// 3. Exclusive output root (non-recursive mkdir — EEXIST refuses).
		const rootIdentity = await exclusiveMkdirV2(rootPath, `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}"`);
		owned.set(rootPath, rootIdentity);
		await hooks.afterRootCreate?.();
		// 4. Revalidate the owned root BEFORE creating any descendant: a
		//    foreign replacement of the root must never receive `sources/`
		//    or the record (fail closed, the foreign entry stays untouched).
		await requireOwnedV2(rootPath, rootIdentity, `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}"`);

		// 5. Exclusive sources directory.
		const sourcesIdentity = await exclusiveMkdirV2(sourcesPath, `the v2 sources directory "${SOURCES_DIR_NAME_V2}"`);
		owned.set(sourcesPath, sourcesIdentity);
		await hooks.afterSourcesCreate?.();
		// 6. Revalidate the owned root AND the owned sources before creating
		//    the record: a foreign replacement of either fails closed.
		await requireOwnedV2(rootPath, rootIdentity, `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}"`);
		await requireOwnedV2(sourcesPath, sourcesIdentity, `the v2 sources directory "${SOURCES_DIR_NAME_V2}"`);

		// 7. Exclusive record create (`wx`), identity tracked from the open
		//    handle, then write/sync/close.
		const handle = await open(recordPath, "wx").catch((error: unknown) => {
			if (isEexistsV2(error)) {
				throw new NroV2FinalCollectError("EXISTING_OUTPUT", `the v2 collection record "${COLLECTION_RECORD_NAME}" already exists and is never overwritten`);
			}
			throw new NroV2FinalCollectError("RECORD_IO", `the v2 collection record "${COLLECTION_RECORD_NAME}" could not be created exclusively`);
		});
		let recordIdentity: FsIdentityV2;
		try {
			recordIdentity = identityOfV2(await handle.stat());
		} catch {
			await handle.close().catch(() => undefined);
			throw new NroV2FinalCollectError("RECORD_IO", `the v2 collection record "${COLLECTION_RECORD_NAME}" could not be created exclusively`);
		}
		owned.set(recordPath, recordIdentity);
		try {
			await hooks.afterRecordOpen?.();
		} catch (error) {
			await handle.close().catch(() => undefined);
			throw error; // the hook's own failure propagates after rollback
		}
		try {
			await writeFile(handle, bytes);
			await handle.sync();
			await handle.close();
		} catch {
			await handle.close().catch(() => undefined);
			throw new NroV2FinalCollectError("RECORD_IO", `the v2 collection record "${COLLECTION_RECORD_NAME}" could not be written`);
		}
		await hooks.afterRecordCommit?.();

		// 6. Read-back verify: the record file bytes must be exactly the
		//    canonical initial record.
		const readBack = await readFile(recordPath).catch(() => {
			throw new NroV2FinalCollectError("RECORD_IO", `the v2 collection record "${COLLECTION_RECORD_NAME}" could not be read back`);
		});
		if (!readBack.equals(bytes)) {
			throw new NroV2FinalCollectError("RECORD_IO", `the v2 collection record "${COLLECTION_RECORD_NAME}" does not match the canonical record`);
		}
		await hooks.afterRecordReadBack?.();
		// 8. Final stage revalidation BEFORE return: root, sources and the
		//    record must ALL still be the owned entries.
		await requireOwnedV2(rootPath, rootIdentity, `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}"`);
		await requireOwnedV2(sourcesPath, sourcesIdentity, `the v2 sources directory "${SOURCES_DIR_NAME_V2}"`);
		await requireOwnedV2(recordPath, recordIdentity, `the v2 collection record "${COLLECTION_RECORD_NAME}"`);
		return createCollectionStorageV2(rootPath, rootIdentity, sourcesIdentity, recordIdentity);
	} catch (error) {
		await rollback();
		throw error;
	}
}

/** Narrow deterministic write hooks — run at each atomic-update stage to inject race/failure scenarios in tests. */
export interface WriteCollectionRecordV2Hooks {
	/** Runs after the exclusive temp write/sync/close, before the temp verify — inject temp races/failures here. */
	afterTempCommit?: () => void | Promise<void>;
	/** Runs after the owned root/target identity verify, before the no-clobber park — inject root/target races/failures here. */
	afterTargetVerify?: () => void | Promise<void>;
	/** Runs after the parked-backup identity verify, before the old-target name removal — inject backup races/failures here. */
	afterBackupPark?: () => void | Promise<void>;
	/** Runs after the owned old-target name removal, before the no-clobber publish — inject target races/failures here. */
	afterTargetRemoved?: () => void | Promise<void>;
	/** Runs after the atomic publish and the tracked-identity update, before the post-commit verify — inject post-commit races/failures here. */
	afterPublish?: () => void | Promise<void>;
}

/**
 * Structured record-write failure (fail closed, privacy-safe): extends
 * `NroV2FinalCollectError` with `committed` — false for every failure
 * BEFORE the atomic no-clobber publish, true once the publish
 * committed — so the future collection loop can choose source
 * rollback correctly. Messages are fixed and bounded: never absolute
 * paths, raw fs messages/content, UUID/temp names or untrusted record
 * content.
 */
export class NroV2RecordWriteError extends NroV2FinalCollectError {
	/** False before the atomic publish; true after it committed (the committed target is preserved on every post-commit failure). */
	readonly committed: boolean;
	constructor(code: NroV2FinalCollectErrorCode, message: string, committed: boolean) {
		super(code, message);
		this.committed = committed;
	}
}

/** Verify bytes + no-follow identity of a record file, failing closed with the given `committed` flag. */
async function verifyRecordFileV2(path: string, bytes: Buffer, expected: FsIdentityV2, what: string, committed: boolean): Promise<void> {
	const current = await currentIdentityV2(path);
	if (current === null || !identityMatchesV2(current, expected)) {
		throw new NroV2RecordWriteError("STORAGE_IO", `${what} was replaced or is no longer the owned entry`, committed);
	}
	const raw = await readFile(path).catch(() => {
		throw new NroV2RecordWriteError("RECORD_IO", `${what} could not be read back`, committed);
	});
	if (!raw.equals(bytes)) {
		throw new NroV2RecordWriteError("RECORD_IO", `${what} does not match the canonical record`, committed);
	}
}

function asWriteErrorV2(error: unknown, committed: boolean): NroV2RecordWriteError {
	if (error instanceof NroV2RecordWriteError) return error;
	if (error instanceof NroV2FinalCollectError) return new NroV2RecordWriteError(error.code, error.message, committed);
	return new NroV2RecordWriteError("RECORD_IO", "the collection record write was interrupted by an internal stage failure", committed);
}

/** No-follow owned-identity gate for the write transaction — fails closed STORAGE_IO with the given `committed` flag. */
async function requireOwnedEntryV2(path: string, expected: FsIdentityV2, what: string, committed: boolean): Promise<void> {
	const current = await currentIdentityV2(path);
	if (current === null || !identityMatchesV2(current, expected)) {
		throw new NroV2RecordWriteError("STORAGE_IO", `${what} was replaced or is no longer the owned entry`, committed);
	}
}

/**
 * Atomic v2 collection-record update (protocol-v2 §5): the record is
 * strict-parsed through the v2 core and canonically serialized BEFORE
 * any write; a unique temp file is created EXCLUSIVELY under the
 * owned root (write/sync/close, byte+identity verify); the storage
 * root and the collection target must still BE the owned entries
 * (no-follow dev+ino+kind identities) — foreign or replaced entries
 * are refused and never overwritten; the owned target is PARKED at a
 * unique backup name by a no-clobber `link` and the parked identity
 * is verified immediately; the owned old-target name is removed; the
 * completed temp is PUBLISHED to the now-absent canonical target by a
 * second no-clobber `link` — the atomic commit point — which cannot
 * overwrite a racing foreign target (EEXIST fails closed); the temp
 * name is removed and the tracked record identity is updated.
 *
 * Every failure is a structured `NroV2RecordWriteError` with
 * `committed: false` before the publish and `committed: true` after
 * it. On PRE-commit failures the prior record is restored at the
 * canonical target where possible (never over a foreign entry and
 * never inside a foreign root) and otherwise preserved at the backup
 * name; the committed target is preserved on every post-commit
 * failure — never rewritten or reverted. Cleanup removes ONLY owned
 * temp/backup names by current identity; foreign temp/backup
 * replacements survive. Errors never carry paths, raw fs text,
 * UUID/temp names or record content.
 */
export async function writeCollectionRecordV2(
	storage: CollectionStorageV2,
	record: CollectionRecordV2,
	hooks: WriteCollectionRecordV2Hooks = {},
): Promise<CollectionStorageV2> {
	// 1. Strict v2 parse/canonical serialization BEFORE any write.
	const canonical = collectionRecordToJsonV2(record);
	try {
		parseCollectionRecordV2(canonical);
	} catch {
		throw new NroV2RecordWriteError("RECORD_INVALID", "the collection record failed the strict v2 collection-record parse", false);
	}
	const bytes = Buffer.from(canonical, "utf8");
	const rootPath = storage.rootPathAbs;
	const targetPath = storage.recordPathAbs;
	const tempPath = join(rootPath, `.${COLLECTION_RECORD_NAME}.${randomUUID()}.tmp`);
	const backupPath = join(rootPath, `.${COLLECTION_RECORD_NAME}.${randomUUID()}.bak`);

	// 2. The storage root must still BE the owned root before any
	//    descendant write (temp and backup live under it).
	await requireOwnedEntryV2(rootPath, storage.rootIdentity, "the storage root", false);
	// 3. Unique temp exclusively under the owned root; write/sync/close;
	//    the tracked identity is the exact file created (fstat on the open
	//    handle — never a path race).
	let tempIdentity: FsIdentityV2;
	try {
		tempIdentity = await exclusiveWriteFileV2(tempPath, bytes, "the collection record temp file", "RECORD_IO");
	} catch (error) {
		throw asWriteErrorV2(error, false);
	}
	// Clean ONLY by current identity: a foreign temp replacement survives;
	// after the publish the temp name is gone (or foreign).
	const cleanupTemp = async (): Promise<void> => {
		const current = await currentIdentityV2(tempPath);
		if (current === null || !identityMatchesV2(current, tempIdentity)) return;
		await unlink(tempPath).catch(() => undefined);
	};
	// Remove the parked backup name ONLY while its current identity still
	// matches the parked prior record — a foreign backup replacement
	// survives.
	const cleanupBackup = async (): Promise<void> => {
		if (backupIdentity === null) return;
		const current = await currentIdentityV2(backupPath);
		if (current === null || !identityMatchesV2(current, backupIdentity)) return;
		await unlink(backupPath).catch(() => undefined);
	};
	let committed = false;
	let backupIdentity: FsIdentityV2 | null = null;
	let parked = false;
	let targetRemoved = false;
	try {
		await hooks.afterTempCommit?.();
		await verifyRecordFileV2(tempPath, bytes, tempIdentity, "the collection record temp file", committed);
		// 4. Owned root + target gate, the hook, then the gate AGAIN — the
		//    re-check immediately before the park catches hook/race
		//    replacements of the root or the target.
		await requireOwnedEntryV2(rootPath, storage.rootIdentity, "the storage root", committed);
		await requireOwnedEntryV2(targetPath, storage.recordIdentity, "the collection record at the storage target", committed);
		await hooks.afterTargetVerify?.();
		await requireOwnedEntryV2(rootPath, storage.rootIdentity, "the storage root", committed);
		await requireOwnedEntryV2(targetPath, storage.recordIdentity, "the collection record at the storage target", committed);
		// 5. PARK: no-clobber `link` of the owned target at the unique backup
		//    name — EEXIST means a foreign entry already occupies the backup
		//    name and is never overwritten; the parked identity is verified
		//    IMMEDIATELY so a foreign inode parked in the residual race
		//    window is detected and never removed.
		await link(targetPath, backupPath).catch((error: unknown) => {
			if (isEexistsV2(error)) {
				throw new NroV2RecordWriteError("STORAGE_IO", "the collection record backup name is occupied and is never overwritten", committed);
			}
			throw new NroV2RecordWriteError("RECORD_IO", "the current collection record could not be parked at the backup name", committed);
		});
		backupIdentity = storage.recordIdentity;
		parked = true;
		await requireOwnedEntryV2(backupPath, backupIdentity, "the parked collection record", committed);
		await hooks.afterBackupPark?.();
		// 6. Remove the OLD canonical target name, identity-gated
		//    immediately before the unlink — only the owned old-record name
		//    is removed.
		await requireOwnedEntryV2(targetPath, storage.recordIdentity, "the collection record at the storage target", committed);
		await unlink(targetPath).catch(() => {
			throw new NroV2RecordWriteError("RECORD_IO", "the previous collection record could not be removed from the storage target", committed);
		});
		targetRemoved = true;
		await hooks.afterTargetRemoved?.();
		// 7. Owned-root gate, then the ATOMIC NO-CLOBBER PUBLISH: `link` of
		//    the completed temp at the now-absent canonical target — the
		//    commit point. EEXIST means a foreign entry raced into the
		//    target and is NEVER overwritten.
		await requireOwnedEntryV2(rootPath, storage.rootIdentity, "the storage root", committed);
		await link(tempPath, targetPath).catch((error: unknown) => {
			if (isEexistsV2(error)) {
				throw new NroV2RecordWriteError("STORAGE_IO", "the collection record target was reoccupied and is never overwritten", committed);
			}
			throw new NroV2RecordWriteError("RECORD_IO", "the completed collection record could not be published at the storage target", committed);
		});
		committed = true;
		// The temp name is now redundant (same inode as the published
		// target) — remove it identity-gated.
		await cleanupTemp();
		// 8. Track the published identity — the new record IS the temp inode.
		storage.updateRecordIdentity(tempIdentity);
		await hooks.afterPublish?.();
		// 9. Post-commit byte+identity verify — the committed target is
		//    preserved on every post-commit failure.
		await verifyRecordFileV2(targetPath, bytes, tempIdentity, "the collection record file", committed);
		// 10. The parked prior record is superseded — remove its backup name
		//     identity-gated (a foreign backup replacement survives).
		await cleanupBackup();
		return storage;
	} catch (error) {
		if (committed) {
			// Post-commit: the NEW canonical target is preserved — never
			// rewritten or reverted. The parked prior record is superseded;
			// its backup name is removed only while still owned (a foreign
			// backup replacement survives).
			await cleanupBackup();
		} else if (parked && targetRemoved) {
			// PRE-commit, prior record only at the backup name: restore it at
			// the canonical target where possible — never over a foreign
			// entry and never inside a foreign root.
			const rootCurrent = await currentIdentityV2(rootPath);
			if (rootCurrent !== null && identityMatchesV2(rootCurrent, storage.rootIdentity)) {
				await link(backupPath, targetPath).catch(() => undefined);
			}
			const restored = await currentIdentityV2(targetPath);
			if (restored !== null && identityMatchesV2(restored, storage.recordIdentity)) {
				await cleanupBackup();
			}
		} else if (parked) {
			// PRE-commit, prior record possibly only at the backup name: the
			// backup name is removed ONLY if the canonical target still holds
			// the prior record (then it is redundant); otherwise the prior
			// record is preserved at the backup name.
			const targetCurrent = await currentIdentityV2(targetPath);
			if (targetCurrent !== null && identityMatchesV2(targetCurrent, storage.recordIdentity)) {
				await cleanupBackup();
			}
		}
		await cleanupTemp();
		throw asWriteErrorV2(error, committed);
	}
}

// ---------------------------------------------------------------------------
// Retained-source persistence helpers (protocol-v2 §4.3/§5) — byte-exact raw
// retention and identity-owned removal ONLY
// ---------------------------------------------------------------------------

/** No-follow owned-identity gate for the retained-source helpers — fails closed SOURCE_IO. */
async function requireOwnedSourceV2(path: string, tracked: FsIdentityV2, what: string): Promise<void> {
	const current = await currentIdentityV2(path);
	if (current === null || !identityMatchesV2(current, tracked)) {
		throw new NroV2FinalCollectError("SOURCE_IO", `${what} was replaced or is no longer the owned entry`);
	}
}

/**
 * Facts the future v2 collector records for one retained raw source
 * (protocol-v2 §4.3/§5): the deterministic file name, the safe
 * relative path inside the v2 collection root, the collection-time
 * raw-byte SHA-256 (the `expected_session_sha256` of the record
 * entry) and the no-follow dev+ino+kind identity of the exact file
 * retained — identities only, never a path to the file and never raw
 * content.
 */
export interface RetainedSourceV2 {
	/** The deterministic retained source file name (`raw-<NN>-<arm>.jsonl`). */
	readonly sourceName: string;
	/** Safe relative path inside the v2 collection root: `sources/<sourceName>` — never absolute. */
	readonly relativePath: string;
	/** SHA-256 of the exact retained raw bytes (the collection-time `expected_session_sha256`). */
	readonly expectedSessionSha256: string;
	/** The no-follow identity (dev+ino+kind) of the retained file at creation — never a path. */
	readonly identity: FsIdentityV2;
}

/** Narrow deterministic retention hooks — run at each retained-source stage to inject race/failure scenarios in tests. */
export interface RetainRawSourceV2Hooks {
	/** Runs after the exclusive source open (identity tracked from the handle), before the write — inject races/failures here. */
	afterSourceOpen?: () => void | Promise<void>;
	/** Runs after the source write/sync/close, before the read-back verify — inject races/failures here. */
	afterSourceCommit?: () => void | Promise<void>;
	/** Runs after the successful byte-exact read-back verify — the owned root/sources/source identity and byte-exact gates are re-run immediately after this hook returns and before the retained facts are returned, so replacements injected here fail closed SOURCE_IO; inject races/failures here. */
	afterSourceVerify?: () => void | Promise<void>;
}

/**
 * Byte-exact retention of a produced raw source (protocol-v2 §4.3/§5):
 * the deterministic destination `sources/raw-<NN>-<arm>.jsonl` is
 * created EXCLUSIVELY (`wx` — a pre-existing or racing destination is
 * refused SOURCE_EXISTS and never overwritten), the identity of the
 * EXACT file created is derived from the open handle (fstat — never
 * from a path race), the raw bytes are written/synced/closed, and the
 * owned root/sources identities plus the source's own no-follow
 * identity are re-verified together with a byte-exact read-back before
 * the retained facts are returned.
 *
 * The frozen `SESSION_MAX_BYTES` cap is enforced BEFORE any filesystem
 * access: an over-bounded raw is refused SOURCE_OVER_BOUND and the
 * storage is never touched. The owned root and sources directories are
 * revalidated before the descendant create — a foreign replacement of
 * either fails closed SOURCE_IO and never receives the source.
 *
 * The `afterSourceVerify` seam is the last hook before return and is
 * followed by a full revalidation: the owned root, the owned sources
 * directory, the retained source's own no-follow identity and the
 * byte-exact read-back are verified AGAIN immediately before the
 * retained facts are returned — a hook-injected replacement of root,
 * sources, source inode or source bytes fails closed SOURCE_IO and can
 * never produce stale ownership facts.
 *
 * On ANY failure after the exclusive create — the injected
 * `afterSourceOpen`/`afterSourceCommit`/`afterSourceVerify` seams, the
 * write/sync/close, the identity gates, the read-back or the post-hook
 * revalidation — the destination is unlinked ONLY while its current
 * no-follow identity still matches the exact file created (a foreign
 * replacement at the destination survives) and a partial unrecorded
 * source is never left behind. Hook failures propagate unchanged after
 * that identity-owned cleanup; every other failure is a fixed bounded
 * SOURCE_IO message. Errors never carry absolute paths, raw fs text or
 * raw bytes.
 */
export async function retainRawSourceV2(
	storage: CollectionStorageV2,
	attempt: number,
	arm: ArmName,
	raw: Buffer,
	hooks: RetainRawSourceV2Hooks = {},
): Promise<RetainedSourceV2> {
	// 1. Frozen size cap BEFORE any filesystem access — an over-bounded
	//    raw is refused without touching the storage.
	if (raw.byteLength > SESSION_MAX_BYTES) {
		throw new NroV2FinalCollectError("SOURCE_OVER_BOUND", `the retained raw source exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	const sourceName = rawSourceNameV2(attempt, arm);
	const sourcePath = join(storage.sourcesPathAbs, sourceName);

	// 2. Owned root + owned sources gate BEFORE the descendant create: a
	//    foreign replacement of either never receives the source.
	await requireOwnedSourceV2(storage.rootPathAbs, storage.rootIdentity, `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}"`);
	await requireOwnedSourceV2(storage.sourcesPathAbs, storage.sourcesIdentity, `the v2 sources directory "${SOURCES_DIR_NAME_V2}"`);

	// 3. Exclusive deterministic create (`wx`) — EEXIST is a refused
	//    SOURCE_EXISTS, never an overwrite.
	const handle = await open(sourcePath, "wx").catch((error: unknown) => {
		if (isEexistsV2(error)) {
			throw new NroV2FinalCollectError("SOURCE_EXISTS", `the retained source "${sourceName}" already exists and is never overwritten`);
		}
		throw new NroV2FinalCollectError("SOURCE_IO", `the retained source "${sourceName}" could not be created exclusively`);
	});
	// 4. The owned identity is the EXACT file created — derived from the
	//    open handle (fstat), never from a path race.
	let identity: FsIdentityV2;
	try {
		identity = identityOfV2(await handle.stat());
	} catch {
		await handle.close().catch(() => undefined);
		throw new NroV2FinalCollectError("SOURCE_IO", `the retained source "${sourceName}" could not be verified after creation`);
	}
	// Identity-owned cleanup: unlink the destination ONLY while its
	// current no-follow identity still matches the exact file created —
	// foreign replacements and injected children are never removed.
	const cleanup = async (): Promise<void> => {
		const current = await currentIdentityV2(sourcePath);
		if (current === null || !identityMatchesV2(current, identity)) return;
		await unlink(sourcePath).catch(() => undefined);
	};
	try {
		await hooks.afterSourceOpen?.();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await cleanup();
		throw error; // the hook's own failure propagates after cleanup
	}
	try {
		await writeFile(handle, raw);
		await handle.sync();
		await handle.close();
	} catch {
		await handle.close().catch(() => undefined);
		await cleanup();
		throw new NroV2FinalCollectError("SOURCE_IO", `the retained source "${sourceName}" could not be written`);
	}
	try {
		await hooks.afterSourceCommit?.();
	} catch (error) {
		await cleanup();
		throw error; // the hook's own failure propagates after cleanup
	}
	// 5. Final verification: owned root, owned sources, the source's own
	//    no-follow identity, then the byte-exact read-back.
	const verifyRetainedSource = async (): Promise<void> => {
		await requireOwnedSourceV2(storage.rootPathAbs, storage.rootIdentity, `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}"`);
		await requireOwnedSourceV2(storage.sourcesPathAbs, storage.sourcesIdentity, `the v2 sources directory "${SOURCES_DIR_NAME_V2}"`);
		await requireOwnedSourceV2(sourcePath, identity, `the retained source "${sourceName}"`);
		const readBack = await readFile(sourcePath).catch(() => {
			throw new NroV2FinalCollectError("SOURCE_IO", `the retained source "${sourceName}" could not be read back`);
		});
		if (!readBack.equals(raw)) {
			throw new NroV2FinalCollectError("SOURCE_IO", `the retained source "${sourceName}" is not byte-identical to the retained raw`);
		}
	};
	try {
		await verifyRetainedSource();
	} catch (error) {
		await cleanup();
		throw error;
	}
	try {
		await hooks.afterSourceVerify?.();
	} catch (error) {
		await cleanup();
		throw error; // the hook's own failure propagates after cleanup
	}
	// 6. Post-hook revalidation — the afterSourceVerify seam is the last
	//    hook before return and must not be able to replace the owned
	//    root, the owned sources directory, the retained source inode or
	//    the retained bytes: the exact same owned-identity and byte-exact
	//    gates are re-run immediately before the retained facts are
	//    returned, and a post-hook replacement fails closed SOURCE_IO
	//    with the same identity-only cleanup (a foreign replacement at
	//    the destination survives).
	try {
		await verifyRetainedSource();
	} catch (error) {
		await cleanup();
		throw error;
	}
	return {
		sourceName,
		relativePath: `${SOURCES_DIR_NAME_V2}/${sourceName}`,
		expectedSessionSha256: sha256Hex(raw),
		identity,
	};
}

/**
 * Identity-owned removal of a previously retained raw source: the
 * retained facts must name EXACTLY the deterministic source for the
 * given attempt and arm (`rawSourceNameV2`) and its deterministic
 * relative path (`sources/<sourceName>`), both validated before any
 * descendant path is derived — a forged or mismatched relativePath
 * fails closed even when the sourceName matches. The owned root and
 * sources directories are revalidated, and the destination is unlinked
 * ONLY while its current no-follow identity still matches the identity
 * tracked at retention — a missing entry, a foreign replacement or an
 * entry of any other kind is never touched and returns `{removed:
 * false}`. The explicit `{removed}` result never recurses and never
 * forces: a single matching regular file is unlinked at most.
 * Errors are fixed bounded SOURCE_IO messages — never absolute paths,
 * raw fs text or raw bytes.
 */
export async function removeOwnedRetainedSourceV2(
	storage: CollectionStorageV2,
	attempt: number,
	arm: ArmName,
	retained: RetainedSourceV2,
): Promise<{ removed: boolean }> {
	// 1. The retained facts must name the deterministic source for the
	//    attempt and arm — BOTH the deterministic source name and its
	//    deterministic relative path must match before any descendant
	//    path is derived; a forged or mismatched relativePath fails
	//    closed even when the sourceName matches.
	const expectedSourceName = rawSourceNameV2(attempt, arm);
	if (retained.sourceName !== expectedSourceName) {
		throw new NroV2FinalCollectError("SOURCE_IO", "the retained source does not match the deterministic v2 source name for the attempt and arm");
	}
	if (retained.relativePath !== `${SOURCES_DIR_NAME_V2}/${expectedSourceName}`) {
		throw new NroV2FinalCollectError("SOURCE_IO", "the retained source does not match the deterministic v2 relative path for the attempt and arm");
	}
	const sourcePath = join(storage.sourcesPathAbs, retained.sourceName);
	// 2. Owned root + owned sources gate BEFORE the unlink.
	await requireOwnedSourceV2(storage.rootPathAbs, storage.rootIdentity, `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}"`);
	await requireOwnedSourceV2(storage.sourcesPathAbs, storage.sourcesIdentity, `the v2 sources directory "${SOURCES_DIR_NAME_V2}"`);
	// 3. Unlink ONLY while the current no-follow identity still matches
	//    the identity tracked at retention — a missing or foreign entry
	//    is untouched and reported as not removed.
	const current = await currentIdentityV2(sourcePath);
	if (current === null || !identityMatchesV2(current, retained.identity)) {
		return { removed: false };
	}
	try {
		await unlink(sourcePath);
	} catch {
		throw new NroV2FinalCollectError("SOURCE_IO", `the retained source "${retained.sourceName}" could not be removed`);
	}
	return { removed: true };
}

// ---------------------------------------------------------------------------
// Attempt-session lifecycle (protocol-v2 §4.4/§5) — deterministic per-attempt
// session-directory create, produced-session locate and owned-session removal
// ---------------------------------------------------------------------------

/**
 * The owned per-attempt session-directory state returned by
 * `createAttemptSessionStorageV2` and consumed by
 * `locateProducedSessionV2` and `removeOwnedAttemptSessionV2`. The
 * public facts are the validated attempt number, the deterministic
 * RELATIVE session-directory name (`.attempt-<NN>-session`) and the
 * tracked no-follow directory identity (dev+ino+kind — never a path).
 * The absolute session-directory path is private in-process plumbing:
 * never rendered in errors or facts and never serialized (JSON
 * serialization exposes only the public attempt/name/identity).
 *
 * Construction is module-private: the constructor requires the
 * module-local brand, so ordinary callers cannot forge arbitrary
 * attempt-session state — a real attempt session can only be obtained
 * from `createAttemptSessionStorageV2`.
 */
/** Module-local brand token — `AttemptSessionStorageV2` is constructible only inside this module. */
const ATTEMPT_SESSION_STORAGE_V2_BRAND: unique symbol = Symbol("AttemptSessionStorageV2");

export class AttemptSessionStorageV2 {
	/** The validated attempt number (integer 1..FINAL_V2_MAX_ATTEMPTS). */
	readonly attempt: number;
	/** Public deterministic relative session-directory name — never an absolute path. */
	readonly sessionDirName: string;
	/** The owned session-directory identity at creation (dev+ino+kind — never a path). */
	readonly sessionIdentity: FsIdentityV2;
	#sessionPath: string;

	/** @internal Module-private construction — see the module factory below. */
	constructor(
		attempt: number,
		sessionDirName: string,
		sessionIdentity: FsIdentityV2,
		sessionPath: string,
		brand: typeof ATTEMPT_SESSION_STORAGE_V2_BRAND,
	) {
		if (brand !== ATTEMPT_SESSION_STORAGE_V2_BRAND) {
			throw new TypeError("AttemptSessionStorageV2 is constructible only by the v2 persistence core");
		}
		this.attempt = attempt;
		this.sessionDirName = sessionDirName;
		this.sessionIdentity = sessionIdentity;
		this.#sessionPath = sessionPath;
	}

	/** @internal Absolute session-directory path — in-process plumbing, never serialized or rendered. */
	get sessionPathAbs(): string {
		return this.#sessionPath;
	}
}

/** Module-private factory — the ONLY way to obtain an `AttemptSessionStorageV2`. */
function buildAttemptSessionStorageV2(attempt: number, sessionDirName: string, sessionIdentity: FsIdentityV2, sessionPath: string): AttemptSessionStorageV2 {
	return new AttemptSessionStorageV2(attempt, sessionDirName, sessionIdentity, sessionPath, ATTEMPT_SESSION_STORAGE_V2_BRAND);
}

/** Narrow deterministic attempt-session creation hooks — run after the exclusive session-directory create to inject race/failure scenarios in tests. */
export interface CreateAttemptSessionStorageV2Hooks {
	/** Runs after the exclusive session-directory create (identity tracked), before the final root+dir revalidation — inject races/failures here. */
	afterSessionDirCreate?: () => void | Promise<void>;
}

/**
 * Exclusive per-attempt session-directory creation (protocol-v2
 * §4.4/§5): the attempt must be an integer in 1..FINAL_V2_MAX_ATTEMPTS
 * — validated BEFORE any filesystem access. The owned collection root
 * must still BE the owned entry (no-follow dev+ino+kind identity) — a
 * foreign replacement never receives the descendant. The deterministic
 * direct child `.attempt-<NN>-session` is created by NON-RECURSIVE
 * exclusive mkdir: a pre-existing or racing entry is refused
 * ATTEMPT_DIR_EXISTS and never overwritten. The owned identity of the
 * exact directory created is tracked immediately (no-follow lstat),
 * the `afterSessionDirCreate` hook runs, and the owned root and the
 * owned session directory are revalidated AGAIN immediately before the
 * attempt-session state is returned — a hook-injected replacement of
 * root or dir fails closed ATTEMPT_DIR_IO and can never produce stale
 * ownership facts.
 *
 * On ANY failure after the exclusive create — the hook, an identity
 * gate or the final revalidation — the invocation rolls back ONLY the
 * directory it created, and only while its current no-follow identity
 * still matches the tracked identity, by non-recursive `rmdir` (an
 * injected foreign child makes the rmdir fail and the owned directory
 * survives with its foreign children; a foreign replacement is never
 * touched). The owned root is never removed. Hook failures propagate
 * unchanged after that identity-owned rollback; every other failure is
 * a fixed bounded ATTEMPT_DIR_EXISTS/ATTEMPT_DIR_IO message — never
 * absolute paths, raw fs text or raw bytes.
 */
export async function createAttemptSessionStorageV2(
	storage: CollectionStorageV2,
	attempt: number,
	hooks: CreateAttemptSessionStorageV2Hooks = {},
): Promise<AttemptSessionStorageV2> {
	// 1. Attempt validation BEFORE any filesystem access — the
	//    deterministic name is derived only from a validated attempt.
	if (!Number.isInteger(attempt) || attempt < 1 || attempt > FINAL_V2_MAX_ATTEMPTS) {
		throw new NroV2FinalCollectError("ATTEMPT_DIR_IO", `attempt must be an integer between 1 and ${FINAL_V2_MAX_ATTEMPTS}`);
	}
	const sessionDirName = attemptSessionDirNameV2(attempt);
	const sessionPath = join(storage.rootPathAbs, sessionDirName);

	// 2. Owned root gate BEFORE the descendant create: a foreign
	//    replacement of the root never receives the session directory.
	await requireOwnedV2(storage.rootPathAbs, storage.rootIdentity, `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}"`, "ATTEMPT_DIR_IO");

	// 3. Exclusive non-recursive create of the deterministic direct
	//    child — EEXIST is a refused ATTEMPT_DIR_EXISTS, never an
	//    overwrite; the identity of the exact directory created is
	//    tracked immediately (no-follow lstat).
	const sessionIdentity = await exclusiveMkdirV2(sessionPath, `the v2 attempt-session directory "${sessionDirName}"`, "ATTEMPT_DIR_EXISTS", "ATTEMPT_DIR_IO");
	// Identity-owned rollback: remove ONLY the directory created, only
	// while its current no-follow identity still matches the tracked
	// identity, non-recursively — `rmdir` removes an empty directory
	// only, so injected foreign children survive and a foreign
	// replacement is never touched.
	const rollback = async (): Promise<void> => {
		const current = await currentIdentityV2(sessionPath);
		if (current === null || !identityMatchesV2(current, sessionIdentity)) return;
		await rmdir(sessionPath).catch(() => undefined);
	};
	try {
		await hooks.afterSessionDirCreate?.();
	} catch (error) {
		await rollback();
		throw error; // the hook's own failure propagates after rollback
	}
	// 4. Final stage revalidation BEFORE return: the owned root and the
	//    owned session directory must BOTH still be the owned entries.
	try {
		await requireOwnedV2(storage.rootPathAbs, storage.rootIdentity, `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}"`, "ATTEMPT_DIR_IO");
		await requireOwnedV2(sessionPath, sessionIdentity, `the v2 attempt-session directory "${sessionDirName}"`, "ATTEMPT_DIR_IO");
	} catch (error) {
		await rollback();
		throw error;
	}
	return buildAttemptSessionStorageV2(attempt, sessionDirName, sessionIdentity, sessionPath);
}

/**
 * The ONE shared safe-basename contract for produced-session file
 * names — enforced by BOTH `locateProducedSessionV2` (the sole
 * `.jsonl` entry selected from the session directory) and
 * `removeOwnedAttemptSessionV2` (the produced facts' basename), so
 * locate and remove can never drift. Accepts only a non-empty DIRECT
 * basename: never "." or "..", no "/" or "\\" separator, no ASCII
 * control characters (C0 + DEL), the `.jsonl` suffix, and at most
 * `PATH_MAX_BYTES` UTF-8 bytes. Anything else is refused.
 */
function isSafeProducedSessionFileNameV2(fileName: string): boolean {
	if (fileName.length === 0 || fileName === "." || fileName === "..") return false;
	if (fileName.includes("/") || fileName.includes("\\")) return false;
	if (CONTROL_CHAR_RE.test(fileName)) return false;
	if (!fileName.endsWith(".jsonl")) return false;
	return utf8Bytes(fileName) <= PATH_MAX_BYTES;
}

/** Narrow deterministic produced-session locate hooks — run at each locate stage to inject race/failure scenarios in tests. */
export interface LocateProducedSessionV2Hooks {
	/** Runs after the produced file open (identity checked against the no-follow lstat), before the bounded read — inject races/failures here. */
	afterSessionOpen?: () => void | Promise<void>;
	/** Runs after the exact-bytes read and handle close, before the final identity/size/root/dir revalidation — inject races/failures here. */
	afterSessionRead?: () => void | Promise<void>;
}

/**
 * Facts the future v2 collector consumes for one produced attempt
 * session (protocol-v2 §4.4/§5): the safe basename of the produced
 * session file, its exact raw bytes (hard-capped at
 * `SESSION_MAX_BYTES`) and the no-follow dev+ino+kind identity of the
 * exact file read — identities and the basename only, never a path to
 * the file and never raw content beyond the capped bytes.
 */
export interface ProducedSessionV2 {
	/** Safe basename of the produced session file (`.jsonl`, never a path). */
	readonly fileName: string;
	/** The exact raw bytes of the produced session — never more than `SESSION_MAX_BYTES`. */
	readonly raw: Buffer;
	/** The no-follow identity (dev+ino+kind) of the exact file read — never a path. */
	readonly identity: FsIdentityV2;
}

/**
 * Locate the produced raw session of one attempt (protocol-v2 §4.4/§5)
 * — READ-ONLY, nothing is written. The attempt-session facts must name
 * exactly the deterministic session directory for their attempt; the
 * owned collection root and the owned attempt-session directory are
 * revalidated (no-follow dev+ino+kind) — a foreign replacement of
 * either fails closed SESSION_IO and is never read. The attempt
 * directory must contain EXACTLY ONE direct `.jsonl` entry (any other
 * direct entries are ignored): zero or multiple fail closed
 * SESSION_FILE_COUNT. The single `.jsonl` entry must be a SAFE direct
 * basename (non-empty, never "." or "..", no "/" or "\\"
 * separators, no ASCII control characters, `.jsonl` suffix, at most
 * `PATH_MAX_BYTES` UTF-8 bytes) — an unsafe entry name fails closed
 * SESSION_IO and is never joined, inspected or rendered — and must be
 * a non-symlink regular file at the path itself — a symlink or special
 * entry is rejected SESSION_IO — and its size is checked against the
 * frozen
 * `SESSION_MAX_BYTES` cap BEFORE any read (an over-bounded produced
 * session is refused SESSION_OVER_BOUND and never read). The file is
 * opened READ-ONLY and the open-handle identity (fstat) is checked
 * against the no-follow lstat identity BEFORE reading; exactly the
 * lstat-size bytes are read from the verified handle (a short read —
 * a shrank file — fails closed SESSION_IO), so the raw bytes can
 * never exceed the verified cap. The `afterSessionOpen`/
 * `afterSessionRead` seams are the path-free hooks; immediately after
 * the last hook and before the facts are returned, the owned root, the
 * owned session directory, the produced file's no-follow identity AND
 * its size are revalidated — a hook-injected replacement or size
 * change fails closed SESSION_IO and can never produce stale facts.
 * Errors carry only fixed bounded messages — never absolute paths,
 * untrusted file names, raw fs text or raw bytes.
 */
export async function locateProducedSessionV2(
	storage: CollectionStorageV2,
	attemptSession: AttemptSessionStorageV2,
	hooks: LocateProducedSessionV2Hooks = {},
): Promise<ProducedSessionV2> {
	// 1. Deterministic association BEFORE any filesystem access: the
	//    attempt-session facts must name exactly the deterministic
	//    session directory for their attempt.
	const expectedDirName = attemptSessionDirNameV2(attemptSession.attempt);
	if (attemptSession.sessionDirName !== expectedDirName) {
		throw new NroV2FinalCollectError("SESSION_IO", "the attempt session does not match the deterministic v2 session directory for its attempt");
	}
	const sessionPath = attemptSession.sessionPathAbs;
	// 2. Owned root + owned attempt-dir gates BEFORE any descendant
	//    read: a foreign replacement of either fails closed SESSION_IO.
	await requireOwnedV2(storage.rootPathAbs, storage.rootIdentity, `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}"`, "SESSION_IO");
	await requireOwnedV2(sessionPath, attemptSession.sessionIdentity, `the v2 attempt-session directory "${expectedDirName}"`, "SESSION_IO");
	// 3. Exactly one direct `.jsonl` entry — other direct entries are
	//    ignored; zero or multiple fail closed SESSION_FILE_COUNT.
	let names: string[];
	try {
		names = await readdir(sessionPath);
	} catch {
		throw new NroV2FinalCollectError("SESSION_IO", `the v2 attempt-session directory "${expectedDirName}" could not be read`);
	}
	const jsonlNames = names.filter((name) => name.endsWith(".jsonl"));
	const fileName = jsonlNames[0];
	if (fileName === undefined || jsonlNames.length !== 1) {
		throw new NroV2FinalCollectError("SESSION_FILE_COUNT", "the attempt session directory must contain exactly one produced session file (.jsonl)");
	}
	// 4. Shared safe-basename contract BEFORE any join/lstat/open: the
	//    sole `.jsonl` entry must be a safe direct basename (non-empty,
	//    never "." or "..", no separators, no ASCII control characters,
	//    `.jsonl` suffix, at most `PATH_MAX_BYTES` UTF-8 bytes) — the
	//    same predicate `removeOwnedAttemptSessionV2` enforces, so
	//    locate and remove can never drift. An unsafe name fails closed
	//    SESSION_IO and is never joined, inspected, opened or rendered.
	if (!isSafeProducedSessionFileNameV2(fileName)) {
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session directory entry is not a safe .jsonl basename");
	}
	// 5. No-follow lstat of the single `.jsonl` entry BEFORE any read:
	//    a symlink or non-regular entry is rejected, and the frozen cap
	//    is enforced on the lstat size.
	const filePath = join(sessionPath, fileName);
	let info: Stats;
	try {
		info = await lstat(filePath);
	} catch {
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session file could not be inspected");
	}
	if (info.isSymbolicLink() || !info.isFile()) {
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session file must be a non-symlink regular file");
	}
	if (info.size > SESSION_MAX_BYTES) {
		throw new NroV2FinalCollectError("SESSION_OVER_BOUND", `the produced session file exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	// 6. Open READ-ONLY and check the open-handle identity against the
	//    no-follow lstat identity BEFORE reading — the read below can
	//    only ever touch the exact inspected file.
	const handle = await open(filePath, "r").catch(() => {
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session file could not be opened");
	});
	let handleIdentity: FsIdentityV2;
	try {
		handleIdentity = identityOfV2(await handle.stat());
	} catch {
		await handle.close().catch(() => undefined);
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session file could not be verified after opening");
	}
	if (!identityMatchesV2(handleIdentity, identityOfV2(info))) {
		await handle.close().catch(() => undefined);
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session file changed between inspection and open");
	}
	try {
		await hooks.afterSessionOpen?.();
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error; // the hook's own failure propagates unchanged
	}
	// 7. Read EXACTLY the lstat-size bytes from the verified handle —
	//    never more than the verified cap; a short read (the file
	//    shrank) fails closed SESSION_IO.
	const raw = Buffer.alloc(info.size);
	let offset = 0;
	try {
		while (offset < raw.length) {
			const { bytesRead } = await handle.read(raw, offset, raw.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
	} catch {
		await handle.close().catch(() => undefined);
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session file could not be read");
	}
	if (offset !== raw.length) {
		await handle.close().catch(() => undefined);
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session file changed size while it was read");
	}
	await handle.close().catch(() => {
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session file could not be closed");
	});
	try {
		await hooks.afterSessionRead?.();
	} catch (error) {
		throw error; // the hook's own failure propagates unchanged
	}
	// 8. Final stage revalidation immediately before return: the owned
	//    root, the owned attempt-session directory and the produced
	//    file's no-follow identity AND size must all still match —
	//    hook-injected replacements or size changes fail closed
	//    SESSION_IO and can never produce stale facts.
	await requireOwnedV2(storage.rootPathAbs, storage.rootIdentity, `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}"`, "SESSION_IO");
	await requireOwnedV2(sessionPath, attemptSession.sessionIdentity, `the v2 attempt-session directory "${expectedDirName}"`, "SESSION_IO");
	let finalInfo: Stats;
	try {
		finalInfo = await lstat(filePath);
	} catch {
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session file could not be re-inspected");
	}
	if (finalInfo.isSymbolicLink() || !finalInfo.isFile()) {
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session file must be a non-symlink regular file");
	}
	if (!identityMatchesV2(identityOfV2(finalInfo), handleIdentity) || finalInfo.size !== raw.length) {
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session file changed while it was located");
	}
	return { fileName, raw, identity: handleIdentity };
}

/**
 * Identity-owned removal of a produced attempt session (post-commit
 * cleanup, protocol-v2 §4.4/§5): the attempt-session facts must name
 * exactly the deterministic session directory for their attempt, and
 * the produced facts must carry a SAFE basename (non-empty, no path
 * separators, never "." or "..", no ASCII control characters,
 * `.jsonl` suffix, bounded UTF-8 length) —
 * both validated BEFORE any descendant path is derived; a forged or
 * mismatched fact fails closed SESSION_IO even when the identity would
 * match. The owned root and owned attempt-session directory are
 * revalidated (no-follow dev+ino+kind) BEFORE the removal — a foreign
 * replacement of either is never touched. The produced file is
 * unlinked ONLY while its current no-follow identity still matches the
 * identity tracked at locate time (a missing, foreign or non-regular
 * entry is untouched and reports `removedFile: false`); then the
 * attempt-session directory is removed by NON-recursive `rmdir` ONLY
 * while its current identity still matches the owned session-directory
 * identity AND it is empty — a foreign child, a non-empty directory or
 * a foreign directory replacement survives and reports
 * `removedDir: false`. The explicit `{removedFile, removedDir}` result
 * never recurses and never forces: at most one matching regular file
 * and one matching empty directory are removed. Errors are fixed
 * bounded SESSION_IO messages — never absolute paths, untrusted file
 * names, raw fs text or raw bytes.
 */
export async function removeOwnedAttemptSessionV2(
	storage: CollectionStorageV2,
	attemptSession: AttemptSessionStorageV2,
	produced: ProducedSessionV2,
): Promise<{ removedFile: boolean; removedDir: boolean }> {
	// 1. Deterministic association BEFORE any filesystem access: the
	//    attempt-session facts must name exactly the deterministic
	//    session directory for their attempt, and the produced facts
	//    must carry a safe direct-child `.jsonl` basename (never a path
	//    — no separators, never "." or "..", no ASCII control
	//    characters, bounded UTF-8 length) — the same shared predicate
	//    `locateProducedSessionV2` enforces, so locate and remove can
	//    never drift.
	const expectedDirName = attemptSessionDirNameV2(attemptSession.attempt);
	if (attemptSession.sessionDirName !== expectedDirName) {
		throw new NroV2FinalCollectError("SESSION_IO", "the attempt session does not match the deterministic v2 session directory for its attempt");
	}
	const fileName = produced.fileName;
	if (!isSafeProducedSessionFileNameV2(fileName)) {
		throw new NroV2FinalCollectError("SESSION_IO", "the produced session facts must carry a safe .jsonl basename for the attempt session");
	}
	const sessionPath = attemptSession.sessionPathAbs;
	const filePath = join(sessionPath, fileName);
	// 2. Owned root + owned attempt-dir gates BEFORE the removal: a
	//    foreign replacement of either is never touched.
	await requireOwnedV2(storage.rootPathAbs, storage.rootIdentity, `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}"`, "SESSION_IO");
	await requireOwnedV2(sessionPath, attemptSession.sessionIdentity, `the v2 attempt-session directory "${expectedDirName}"`, "SESSION_IO");
	// 3. Unlink ONLY the produced file while its current no-follow
	//    identity still matches the identity tracked at locate time — a
	//    missing, foreign or non-regular entry is untouched and
	//    reported as not removed.
	let removedFile = false;
	const fileCurrent = await currentIdentityV2(filePath);
	if (fileCurrent !== null && identityMatchesV2(fileCurrent, produced.identity)) {
		try {
			await unlink(filePath);
			removedFile = true;
		} catch {
			throw new NroV2FinalCollectError("SESSION_IO", "the produced session file could not be removed");
		}
	}
	// 4. rmdir the attempt-session directory ONLY while its current
	//    identity still matches the owned identity AND it is empty —
	//    non-recursive `rmdir` removes an empty directory only; a
	//    foreign child, a non-empty directory or a foreign replacement
	//    survives with a truthful `removedDir: false`.
	let removedDir = false;
	const dirCurrent = await currentIdentityV2(sessionPath);
	if (dirCurrent !== null && identityMatchesV2(dirCurrent, attemptSession.sessionIdentity)) {
		try {
			await rmdir(sessionPath);
			removedDir = true;
		} catch (error) {
			// Non-empty (or raced non-empty): truthful not-removed; any
			// other failure fails closed.
			if (!isEexistsV2(error) && (error as { code?: unknown }).code !== "ENOTEMPTY") {
				throw new NroV2FinalCollectError("SESSION_IO", "the attempt-session directory could not be removed");
			}
		}
	}
	return { removedFile, removedDir };
}

// ---------------------------------------------------------------------------
// FINAL collection loop (protocol-v2 §4.2–§4.5/§5) — composes the v2
// primitives above; no new imports and no new fs/spawn call sites (the
// guarded CLI entry lives at the end of the file)
// ---------------------------------------------------------------------------

/** The only two collection-loop statuses. */
export type CollectFinalV2Status = "complete" | "attempts-exhausted";

/** Narrow deterministic collection-loop hooks — run at the two loop-level transaction boundaries. */
export interface CollectFinalV2Hooks {
	/**
	 * Runs after BOTH read-only preflights succeeded and before any
	 * output creation or runner call — inject checks/failures here. A
	 * failure propagates unchanged (never wrapped or rendered).
	 */
	afterPreflights?: () => void | Promise<void>;
	/**
	 * Runs after the entry's strict record commit and before the owned
	 * attempt-session cleanup — inject races/failures here. A failure
	 * propagates unchanged; the committed entry and retained source are
	 * preserved and the cleanup is not reached.
	 */
	afterEntryCommit?: (attempt: number, arm: ArmName, kind: CollectionEntryV2["kind"]) => void | Promise<void>;
}

/** Options of `collectFinalV2` — narrow, deterministic, hermetic-testable. */
export interface CollectFinalV2Options {
	/** Verified project root: the verified Pi binary and control/treatment arm RELATIVE facts are joined under it. */
	projectRoot: string;
	/**
	 * EXISTING parent of the independent v2 collection root — the loop
	 * never creates it (non-recursive exclusive creates are the storage
	 * core's contract) and never renders it.
	 */
	runsDir: string;
	/** The frozen v2 inputs tree (verified by the inputs preflight; `fixture/` becomes the attempt cwd). */
	inputsDir: string;
	/** The frozen protocol; defaults to `FROZEN_NRO_V2_PROTOCOL` — any drift fails closed before any output. */
	protocol?: V2FrozenProtocol;
	/** Injectable runtime facts for the system preflight; the production default reads the global `process.version` ONLY when called. */
	runtime?: SystemRuntimeFactsV2;
	/** The attempt runner; defaults to the production direct-spawn runner created ONLY when called. */
	runner?: SpawnAttemptRunnerV2;
	/** Base process environment for the attempt env; defaults to the process env read ONLY when the function is called. */
	env?: NodeJS.ProcessEnv;
	/** Narrow loop-level hooks. */
	hooks?: CollectFinalV2Hooks;
	/** Forwarded unchanged to every `retainRawSourceV2` call. */
	retainHooks?: RetainRawSourceV2Hooks;
	/** Forwarded unchanged to every `writeCollectionRecordV2` call. */
	writeHooks?: WriteCollectionRecordV2Hooks;
	/**
	 * Narrow optional diagnostics sink: receives exactly ONE fixed
	 * bounded privacy-safe line per representable invalid attempt and
	 * per valid attempt with anomalous process/capture facts
	 * (nonzero/null exit, timeout, stdout/stderr overflow). Never
	 * called for clean valid attempts, spawn start failures, locator
	 * failures or unrepresentable raws. Each line carries ONLY the
	 * attempt label, arm, category (or the fixed `valid` token) and
	 * bounded boolean/numeric process-capture facts — never raw
	 * stdout/stderr/session bytes, absolute paths, untrusted file
	 * names, process error text, hook errors, UUID/hidden transaction
	 * names or filesystem messages. Diagnostics never influence
	 * verdicts or the record.
	 */
	onDiagnostic?: (line: string) => void;
}

/** The bounded privacy-safe run result of one FINAL v2 collection. */
export interface CollectFinalV2Result {
	/** "complete" after exactly 40 valid sessions; "attempts-exhausted" after the 60-started cap with fewer. */
	status: CollectFinalV2Status;
	/** Valid sessions (0..40) — the ABBA position advanced exactly this many times. */
	validCount: number;
	/** Successfully-started attempts (0..60) — the cap counts ONLY `started: true` results. */
	startedAttempts: number;
	/** The final strict in-memory record — byte-identical to the persisted one (never a status/cap field). */
	record: CollectionRecordV2;
	/** Safe RELATIVE collection-record location (`<root>/<record>` under the runs dir) — never absolute. */
	recordLocation: string;
}

/**
 * Fixed bounded privacy-safe diagnostic line for one attempt: only the
 * zero-padded attempt label, the frozen arm, the frozen invalid
 * category (or the fixed `valid` token) and bounded boolean/numeric
 * process-capture facts — never raw stdout/stderr/session bytes,
 * absolute paths, untrusted file names, process error text, hook
 * errors, UUID/hidden transaction names or filesystem messages.
 */
function attemptDiagnosticLineV2(attempt: number, arm: ArmName, category: string, spawned: SpawnedAttemptResultV2): string {
	return `collectFinalV2 diagnostic: attempt=${attemptLabelV2(attempt)} arm=${arm} category=${category} exitCode=${String(spawned.exitCode)} timedOut=${String(spawned.timedOut)} stdoutOverflow=${String(spawned.stdout.overflowed)} stderrOverflow=${String(spawned.stderr.overflowed)}`;
}

/**
 * FINAL v2 collection loop (protocol-v2 §4.2–§4.5/§5), composing ONLY
 * the frozen v2 primitives of this module — never reimplementing them:
 *
 *   1. BOTH read-only preflights (`preflightInputsForCollectorV2`,
 *      `preflightSystemForCollectorV2`) run BEFORE any output creation
 *      or runner call; the verified Pi/control/treatment RELATIVE facts
 *      are joined under the supplied project root, the attempt cwd is
 *      the frozen `fixture/` dir under the supplied inputs dir, the
 *      prompt text is the exact preflight-captured raw, and the
 *      process env is read only when the function is called.
 *   2. `initializeCollectionStorageV2` exclusively creates the
 *      independent v2 collection root and the canonical initial record.
 *   3. Each attempt 1..60: `createAttemptSessionStorageV2`, the exact
 *      argv/env builders, the injected/default `SpawnAttemptRunnerV2`,
 *      `locateProducedSessionV2`, `classifyFinalSessionV2`,
 *      `retainRawSourceV2`, `writeCollectionRecordV2` and
 *      `removeOwnedAttemptSessionV2` — in that frozen transaction
 *      order (raw retention -> strict record commit -> owned
 *      attempt-session cleanup) — under the fixed ABBA plan: the
 *      required arm is `abbaArmAtV2(validSessions + 1)`; an invalid
 *      representable raw stays `kind: "attempt"` and retries the SAME
 *      required arm; a valid raw advances the position ONLY after its
 *      record commit.
 *
 * Hard failures (never continue): a spawn start failure
 * (`ATTEMPT_START_FAILED` — the cap counts only `started: true`, no
 * entry is fabricated and the attempt dir stays), a locator failure
 * (SESSION_*), an `unrepresentable` classification
 * (`ATTEMPT_UNREPRESENTABLE` — nothing retained), a retention failure
 * and a record-write failure. On a pre-commit `NroV2RecordWriteError`
 * the prospective in-memory entry is reverted and ONLY the owned
 * retained source is removed (the attempt dir and the prior truthful
 * record are preserved); on `committed: true` the loop's in-memory
 * record is advanced to the prospective committed record before the
 * rethrow — the newly committed entry and retained source are
 * preserved and the attempt dir is NOT cleaned. The optional
 * `onDiagnostic` sink receives exactly one fixed bounded privacy-safe
 * line per representable invalid attempt and per valid attempt with
 * anomalous process/capture facts (nonzero/null exit, timeout,
 * stdout/stderr overflow); diagnostics never influence verdicts or
 * the record. Completion: 40 valid sessions -> `complete`; the 60-started
 * cap with fewer -> `attempts-exhausted` with the truthful bounded
 * partial result (never analyzable/adoption evidence).
 *
 * The loop itself adds no import and no spawn/open/randomUUID call
 * site and never executes at module top level (the module's guarded
 * CLI — the only top-level executable statement — may call it, and
 * only when the module IS the executed script); errors, diagnostics
 * and the result are fixed, bounded and privacy-safe (never
 * absolute paths, raw
 * JSONL/stdout/stderr, UUID/temp/backup/hidden transaction names,
 * hook errors, untrusted file names or raw filesystem messages).
 */
export async function collectFinalV2(options: CollectFinalV2Options): Promise<CollectFinalV2Result> {
	const protocol = options.protocol ?? FROZEN_NRO_V2_PROTOCOL;
	// 1. Read-only preflights BEFORE any output creation or runner call.
	const inputs = await preflightInputsForCollectorV2(options.inputsDir, protocol);
	const system = await preflightSystemForCollectorV2(options.projectRoot, options.runtime ?? {}, protocol);
	const runner = options.runner ?? createSpawnAttemptRunnerV2();
	// The process env is read ONLY here — when the function is called.
	const attemptEnv = buildAttemptEnvV2(options.env ?? process.env);
	const promptText = inputs.milestonePromptRaw.toString("utf8");
	const fixtureCwd = join(options.inputsDir, FIXTURE_DIR_NAME);
	const piBinary = join(options.projectRoot, system.piBinary);
	const controlArm = join(options.projectRoot, system.controlArmFile);
	const treatmentArm = join(options.projectRoot, system.treatmentArmFile);
	const extensionFor = (arm: ArmName): string => (arm === "control" ? controlArm : treatmentArm);
	await options.hooks?.afterPreflights?.();

	// 2. Exclusive independent v2 collection root + canonical initial record.
	let storage = await initializeCollectionStorageV2(options.runsDir, protocol);
	let record = buildInitialCollectionRecordV2(protocol);
	let validSessions = 0;
	let startedAttempts = 0;

	for (let attempt = 1; attempt <= FINAL_V2_MAX_ATTEMPTS; attempt += 1) {
		// The fixed ABBA arm of the next not-yet-filled valid position — an
		// invalid attempt retries it without advancing.
		const arm = abbaArmAtV2(validSessions + 1);
		const attemptSession = await createAttemptSessionStorageV2(storage, attempt);
		const argv = buildAttemptArgvV2({
			extensionPath: extensionFor(arm),
			sessionDir: attemptSession.sessionPathAbs,
			attemptNumber: attempt,
			arm,
			promptText,
		});
		const spawned = await runner({
			program: piBinary,
			argv,
			cwd: fixtureCwd,
			env: attemptEnv,
			timeoutMs: ATTEMPT_TIMEOUT_MS_V2,
			terminateGraceMs: TERMINATE_GRACE_MS_V2,
			stdoutMaxBytes: ATTEMPT_STDOUT_MAX_BYTES_V2,
			stderrMaxBytes: ATTEMPT_STDERR_MAX_BYTES_V2,
		});
		if (!spawned.started) {
			// Start failure: privacy-safe hard failure — the cap counts only
			// started:true results; no entry is fabricated and the attempt
			// dir and the truthful partial record are preserved.
			throw new NroV2FinalCollectError("ATTEMPT_START_FAILED", SPAWN_START_FAILED_DETAIL_V2);
		}
		startedAttempts += 1;
		const produced = await locateProducedSessionV2(storage, attemptSession);
		const classification = classifyFinalSessionV2({
			raw: produced.raw,
			arm,
			label: attemptNameV2(attempt, arm),
			exitCode: spawned.exitCode,
			timedOut: spawned.timedOut,
			protocol,
		});
		if (classification.verdict === "unrepresentable") {
			// Immediate hard failure: preserve the truthful partial record
			// and the ENTIRE attempt directory; retain/fabricate nothing.
			throw new NroV2FinalCollectError("ATTEMPT_UNREPRESENTABLE", UNREPRESENTABLE_DETAIL_V2);
		}
		// Fixed bounded privacy-safe diagnostics (never influence verdicts):
		// exactly one line per representable invalid attempt, and one per
		// valid attempt with anomalous process/capture facts (nonzero/null
		// exit, timeout, stdout/stderr overflow); clean valid attempts,
		// start failures, locator failures and unrepresentable raws emit
		// nothing.
		if (options.onDiagnostic !== undefined) {
			const anomalousValid =
				classification.verdict === "valid" &&
				(spawned.exitCode !== 0 || spawned.exitCode === null || spawned.timedOut || spawned.stdout.overflowed || spawned.stderr.overflowed);
			if (classification.verdict === "invalid" || anomalousValid) {
				const category = classification.verdict === "invalid" ? (classification.attemptFacts?.category ?? "invalid") : "valid";
				options.onDiagnostic(attemptDiagnosticLineV2(attempt, arm, category, spawned));
			}
		}
		// Every representable raw, valid or invalid, is retained byte-exact
		// BEFORE the record publication.
		const retained = await retainRawSourceV2(storage, attempt, arm, produced.raw, options.retainHooks);
		const entry: CollectionEntryV2 = {
			kind: classification.verdict === "valid" ? "session" : "attempt",
			arm,
			path: retained.relativePath,
			expectedSessionSha256: retained.expectedSessionSha256,
		};
		const prospective: CollectionRecordV2 = { ...record, entries: [...record.entries, entry] };
		try {
			storage = await writeCollectionRecordV2(storage, prospective, options.writeHooks);
		} catch (error) {
			if (error instanceof NroV2RecordWriteError && !error.committed) {
				// Pre-commit: revert only the prospective in-memory entry (the
				// loop's record never changed) and remove ONLY the owned
				// retained source; the attempt dir and the prior truthful
				// record are preserved. Best-effort rollback — the structured
				// write failure is the surface error.
				await removeOwnedRetainedSourceV2(storage, attempt, arm, retained).catch(() => undefined);
			} else if (error instanceof NroV2RecordWriteError && error.committed) {
				// Post-commit: the prospective record IS the committed on-disk
				// record — advance the loop's in-memory record to it before
				// rethrowing (the newly committed entry and retained source
				// are preserved and the attempt dir is NOT cleaned).
				record = prospective;
			}
			// Hard fail either way, never continue.
			throw error;
		}
		record = prospective;
		await options.hooks?.afterEntryCommit?.(attempt, arm, entry.kind);
		if (entry.kind === "session") {
			// The position advances ONLY after the updated record committed.
			validSessions += 1;
		}
		// Owned attempt-session cleanup ONLY after retention and commit.
		await removeOwnedAttemptSessionV2(storage, attemptSession, produced);
		if (validSessions === FINAL_V2_VALID_SESSIONS) {
			return {
				status: "complete",
				validCount: validSessions,
				startedAttempts,
				record,
				recordLocation: `${OUTPUT_ROOT_NAME_V2}/${COLLECTION_RECORD_NAME}`,
			};
		}
	}
	// The frozen 60-started cap was reached: truthful bounded partial
	// state — never analyzable/adoption evidence.
	return {
		status: "attempts-exhausted",
		validCount: validSessions,
		startedAttempts,
		record,
		recordLocation: `${OUTPUT_ROOT_NAME_V2}/${COLLECTION_RECORD_NAME}`,
	};
}

// ---------------------------------------------------------------------------
// CLI (fixed no args; --help/-h 0; unknown/positional 2; runtime 1)
// ---------------------------------------------------------------------------

/** The fixed privacy-safe usage text (stdout for --help/-h; appended to the fixed usage error on stderr). */
export function usage(): string {
	return [
		"commander-native-tool-v2-final-collect — NRO protocol-v2 FINAL validation collector (final evidence only)",
		"",
		"Collects 40 valid sessions (frozen ABBA order x10, at most 60 successfully-started paid",
		"attempts) by running the real pi CLI against the frozen v2 milestone prompt/fixture on both",
		"FINAL arms (final control adapter vs. the current workbench runtime extension), retaining",
		"every produced raw session byte-exact under",
		".pi/workbench/runs/commander-native-tool-v2-final-collection/ with a strict schema-2",
		"collection-record.json (no status/cap field).",
		"",
		"usage:",
		"  tsx scripts/commander-native-tool-v2-final-collect.ts     collect (40 valid sessions, max 60 attempts)",
		"  tsx scripts/commander-native-tool-v2-final-collect.ts --help   this help",
		"  tsx scripts/commander-native-tool-v2-final-collect.ts -h       this help",
		"",
		"no arguments are accepted; any positional argument or option is a usage error.",
		"",
		"exit codes: 0 all 40 valid sessions collected | 1 attempts exhausted (truthful partial",
		"collection) or runtime failure (stderr only) | 2 usage error",
	].join("\n");
}

/** Bounded stdout summary: status, valid, attempts and the runs-relative collection path. */
export function renderSummary(result: CollectFinalV2Result): string {
	return `commander-native-tool-v2-final-collect: status=${result.status} valid=${result.validCount} attempts=${result.startedAttempts} collection=.pi/workbench/runs/${result.recordLocation}`;
}

/**
 * Bounded stderr diagnostic for a runtime failure: collector errors render
 * ONLY the fixed prefix, the error code and the already-fixed message
 * (`NroV2RecordWriteError` is a collector error and renders the same way);
 * every unknown error renders ONE fixed details-withheld line — never raw
 * argv, absolute paths, raw session/stdout/stderr bytes, untrusted
 * names/messages, hook errors, UUID/hidden transaction names or
 * filesystem messages.
 */
function renderDiagnostic(error: unknown): string {
	if (error instanceof NroV2FinalCollectError) {
		return `commander-native-tool-v2-final-collect: ${error.code}: ${error.message}`;
	}
	return "commander-native-tool-v2-final-collect: unexpected failure (details withheld — privacy boundary)";
}

/** Narrow CLI stream sink (hermetic-testable). */
export interface FinalIo {
	stdout(line: string): void;
	stderr(line: string): void;
}

const defaultIo: FinalIo = {
	stdout: (line) => process.stdout.write(`${line}\n`),
	stderr: (line) => process.stderr.write(`${line}\n`),
};

/** The production default paths, rooted at the current working directory. */
function defaultPaths(): { projectRoot: string; runsDir: string; inputsDir: string } {
	const projectRoot = process.cwd();
	return {
		projectRoot,
		runsDir: join(projectRoot, ".pi", "workbench", "runs"),
		inputsDir: join(projectRoot, "fixtures", "commander-native-tool-benchmark-v2", "inputs"),
	};
}

/** The injected collect function the CLI drives (hermetic-testable). */
export type CollectFinalV2Fn = (options: CollectFinalV2Options) => Promise<CollectFinalV2Result>;

/**
 * CLI entry: no arguments runs the collection with the production default
 * paths (cwd-rooted) and forwards the fixed bounded `onDiagnostic` lines to
 * stderr; exactly `--help`/`-h` prints the usage to stdout (exit 0); any
 * other argv is a FIXED privacy-safe usage error on stderr (exit 2, never
 * echoing argv). `complete` exits 0 with the single bounded relative
 * summary; `attempts-exhausted` exits 1 with the truthful partial summary;
 * runtime failures exit 1 with stderr diagnostics only (never a partial
 * stdout claim).
 */
export async function main(argv: readonly string[], io: FinalIo = defaultIo, collect: CollectFinalV2Fn = collectFinalV2): Promise<number> {
	if (argv.length === 0) {
		try {
			const result = await collect({ ...defaultPaths(), onDiagnostic: (line) => io.stderr(line) });
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
	io.stderr(`commander-native-tool-v2-final-collect: unexpected argument(s) — usage error (details withheld)\n${usage()}`);
	return 2;
}

// Run only when executed directly (tsx scripts/commander-native-tool-v2-final-collect.ts).
// The guard is path-exact: this module's own decoded file URL against the
// resolved first CLI argument — importing the module never runs main/collection.
if (process.argv[1] !== undefined && decodeURIComponent(new URL(import.meta.url).pathname) === resolve(process.argv[1])) {
	process.exitCode = await main(process.argv.slice(2));
}
