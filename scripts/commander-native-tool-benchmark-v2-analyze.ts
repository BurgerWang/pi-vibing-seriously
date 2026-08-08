#!/usr/bin/env tsx
/**
 * NRO protocol-v2 offline analyzer adapter (commander-native-tool-
 * optimization plan, v2 analyze slice) — READ-ONLY filesystem/report/CLI
 * adapter over the PURE v2 benchmark core
 * (scripts/commander-native-tool-benchmark-v2.ts) and the frozen v2
 * protocol module. The v1 analyzer is followed ONLY as a structural
 * pattern: every derivation, aggregation and verdict comes exclusively
 * from the v2 core (parseManifestV2, computeRunFactsV2,
 * deriveAttemptFactsV2, buildArmFactsV2, computeVerdictsFromRunsV2) and
 * the frozen v2 policy; the v1 parseManifest / buildReport /
 * analyzeManifestFile / computeRunFacts / deriveAttemptFacts
 * implementations and the v1 frozen protocol semantics are never
 * imported or called.
 *
 * Single subcommand:
 *
 *   analyze <manifest.json> [--json]
 *     Strictly size-bound/read ONE v2 manifest (schema_version 2,
 *     protocol_version 2, exact frozen pins); resolve every declared
 *     session/attempt/fixture path RELATIVE to the manifest file's
 *     directory (absolute/drive/UNC/NUL/".." paths, symlink escapes,
 *     duplicate realpaths, non-regular, oversized and missing inputs are
 *     all rejected); verify each session/attempt raw byte SHA-256 and
 *     the fixture tree manifest hash against the declared pins; then
 *     derive per-run machine facts (requests, token components, gross,
 *     cost, total/successful inline bytes, per-tool attribution,
 *     edit/write toolCall counts, wall time), the frozen six-check
 *     rubric correctness over the final assistant text, the exact-ID
 *     pagination facts, arm aggregates and the four frozen §8 verdicts
 *     through the v2 core. Dev manifests report facts but the verdicts
 *     are always NOT_MEASURED (development evidence is never reported).
 *     Attempt categories and prompt hashes are machine-verified against
 *     the frozen derivation (any drift fails closed).
 *     --json emits the deterministic pretty JSON report plus a terminal
 *     LF; without it the bounded human rendering is emitted (240 lines /
 *     64 KiB hard caps with an explicit cap marker).
 *
 * Privacy: output carries labels, basenames, hashes, counts, numeric
 * facts, model keys, arm names, categories and verdicts only — never
 * message bodies, tool arguments, raw tool-result content, thinking,
 * secrets, or absolute paths. Output-facing identities (model keys,
 * thinking levels, tool names) must be bounded safe identities or the
 * report is withheld entirely; fixture-tree verification failures
 * surface only the bounded fixture-directory basename. On failure
 * nothing is written to stdout (stderr only, bounded, basenames only).
 * This adapter never writes a
 * file, never calls a model, never touches the network, never spawns a
 * process, and never touches provider/cache/session state; it never
 * creates evidence, manifests, results or any artifact.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
	fixtureManifestHash,
	parseSessionLines,
	resolveSessionPath,
	sha256Hex,
	HUMAN_MAX_BYTES,
	HUMAN_MAX_LINES,
	MANIFEST_MAX_BYTES,
	SESSION_MAX_BYTES,
} from "./commander-native-tool-benchmark.ts";

import {
	buildArmFactsV2,
	computeRunFactsV2,
	computeVerdictsFromRunsV2,
	deriveAttemptFactsV2,
	parseManifestV2,
	type ArmFactsV2,
	type AttemptFactsV2,
	type ManifestEnvironmentV2,
	type NroManifestV2,
	type RunFactsV2,
	type V2FrozenProtocol,
	type VerdictV2,
} from "./commander-native-tool-benchmark-v2.ts";

import {
	ARMS,
	BENCHMARK_SCHEMA_VERSION,
	FROZEN_NRO_V2_PROTOCOL,
	PROTOCOL_DOC,
	PROTOCOL_VERSION,
	type ArmName,
	type Phase,
} from "./commander-native-tool-benchmark-v2-protocol.ts";

// ---------------------------------------------------------------------------
// Adapter-level structured error (fail closed; messages carry labels and
// basenames only — the same privacy contract as the v2 core errors)
// ---------------------------------------------------------------------------

export type NroV2AnalyzeErrorCode =
	| "IO_ERROR"
	| "FILE_MISSING"
	| "PATH_UNSAFE"
	| "DUPLICATE_PATH"
	| "OVER_BOUND"
	| "BASENAME_UNSAFE"
	| "HASH_MISMATCH"
	| "FIXTURE_MISMATCH"
	| "FIXTURE_UNSAFE"
	| "CATEGORY_MISMATCH"
	| "UNSAFE_IDENTITY";

/** Structured adapter failure — fail closed, message never carries entry content. */
export class NroV2AnalyzeError extends Error {
	readonly code: NroV2AnalyzeErrorCode;
	constructor(code: NroV2AnalyzeErrorCode, message: string) {
		super(message);
		this.name = "NroV2AnalyzeError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Local bounded-display helpers (same frozen values as the v1/v2 cores;
// never imported from v1 — the v1 import surface is the allowlisted set)
// ---------------------------------------------------------------------------

const LABEL_MAX_CHARS = 64;
const PATH_MAX_BYTES = 512;
const BASENAME_MAX_CHARS = 128;
const MODEL_KEY_MAX_CHARS = 96;
const THINKING_LEVEL_MAX_CHARS = 32;
/** Manifest basename contract (frozen v1/v2 safe file name). */
const BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Code-point-safe UTF-8 byte truncation with an explicit "…" marker. */
function truncateUtf8(text: string, maxBytes: number): string {
	let used = 0;
	const out: string[] = [];
	for (const ch of text) {
		const bytes = utf8Bytes(ch);
		if (used + bytes > maxBytes) return out.join("");
		used += bytes;
		out.push(ch);
	}
	return text;
}

const CONTROL_RE = /[\x00-\x1f\x7f]/g;

/** Sanitized + bounded display form (control chars replaced; never injects lines). */
function boundedDisplay(text: unknown, maxBytes: number): { text: string; altered: boolean } {
	if (typeof text !== "string") return { text: "(invalid)", altered: true };
	const cleaned = text.replace(CONTROL_RE, " ");
	if (utf8Bytes(cleaned) <= maxBytes) return { text: cleaned, altered: cleaned !== text };
	return { text: `${truncateUtf8(cleaned, Math.max(0, maxBytes - 3))}…`, altered: true };
}

/** Sanitized value for error messages (control chars replaced, byte-bounded). */
function safeErrorValue(value: string): string {
	const cleaned = value.replace(CONTROL_RE, " ");
	if (utf8Bytes(cleaned) <= 64) return cleaned;
	return `${truncateUtf8(cleaned, 61)}…`;
}

// ---------------------------------------------------------------------------
// Output-facing identity validation (frozen v2 bounds — dev sessions and
// attempts are covered because final-phase identities are already pinned
// by the v2 core enforcement)
// ---------------------------------------------------------------------------

/** Frozen model-key identity (same regex/bounds as the v2 core environment parse). */
const MODEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/;
/** Frozen thinking-level identity (same regex/bounds as the v2 core environment parse). */
const THINKING_LEVEL_RE = /^[A-Za-z0-9._-]{1,32}$/;
/** Frozen per-tool name identity; the deterministic "(unknown)" sentinel is additionally allowed. */
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UNKNOWN_TOOL_NAME = "(unknown)";

/**
 * Fail closed before any report is returned when an output-facing
 * per-run/per-attempt identity (model key, thinking level, tool name) is
 * not a bounded safe identity. The message is generic and never carries
 * the unsafe value; only the (already bounded) run/attempt label is
 * referenced.
 */
function requireSafeOutputIdentitiesV2(
	label: string,
	modelKeys: readonly string[],
	thinkingLevel: string | null,
	toolNames: readonly string[],
): void {
	const where = safeErrorValue(label);
	if (modelKeys.some((k) => !MODEL_KEY_RE.test(k))) {
		throw new NroV2AnalyzeError("UNSAFE_IDENTITY", `run/attempt "${where}" carries an unbounded or unsafe model key — report withheld (privacy boundary)`);
	}
	if (thinkingLevel !== null && !THINKING_LEVEL_RE.test(thinkingLevel)) {
		throw new NroV2AnalyzeError("UNSAFE_IDENTITY", `run/attempt "${where}" carries an unbounded or unsafe thinking level — report withheld (privacy boundary)`);
	}
	if (toolNames.some((t) => t !== UNKNOWN_TOOL_NAME && !TOOL_NAME_RE.test(t))) {
		throw new NroV2AnalyzeError("UNSAFE_IDENTITY", `run/attempt "${where}" carries an unbounded or unsafe tool name — report withheld (privacy boundary)`);
	}
}

// ---------------------------------------------------------------------------
// Report shape (deterministic, privacy-safe — mirrors the v1 report shape
// with the v2 protocol version; every value is bounded by construction)
// ---------------------------------------------------------------------------

export interface ReportFixtureFactsV2 {
	/** Manifest-declared relative fixture path (privacy-safe). */
	path: string;
	manifestSha256: string;
	verified: boolean;
	files: number;
	totalBytes: number;
}

export interface ReportManifestFactsV2 {
	basename: string;
	protocolDoc: string;
	schemaVersion: number;
	protocolVersion: number;
	phase: Phase;
	milestonePromptSha256: string;
	environment: ManifestEnvironmentV2;
	fixture: ReportFixtureFactsV2;
	nonTreatmentSha256: string;
	rubricSha256: string;
	rubricChecks: number;
	sessionCount: number;
	attemptCount: number;
}

export interface BenchmarkReportV2 {
	schemaVersion: number;
	protocolVersion: number;
	protocolDoc: string;
	manifest: ReportManifestFactsV2;
	runs: RunFactsV2[];
	arms: Record<ArmName, ArmFactsV2>;
	attempts: AttemptFactsV2[];
	verdicts: VerdictV2[];
}

// ---------------------------------------------------------------------------
// Analyzer pipeline — read-only, deterministic (v2 core only)
// ---------------------------------------------------------------------------

/**
 * Analyze every declared session and attempt (all runs retained, none
 * excluded) with realpath containment, duplicate-realpath refusal, strict
 * JSONL parsing, raw-byte hash enforcement and fail-closed validation
 * through the v2 core; re-verify the declared fixture tree against its
 * manifest hash; then aggregate arm facts and compute the four frozen
 * verdicts via the v2 core. Read-only: no file is written, no model is
 * called, no network/shell is used.
 */
export async function buildReportV2(manifest: NroManifestV2, manifestDir: string, manifestBasename: string): Promise<BenchmarkReportV2> {
	let dirReal: string;
	try {
		dirReal = await realpath(manifestDir);
	} catch {
		throw new NroV2AnalyzeError("IO_ERROR", "the manifest directory cannot be resolved");
	}
	const seenRealPaths = new Set<string>();

	/**
	 * Resolve + contain + dedupe one declared path, then read it
	 * (size-bounded). Basename-only error messages (privacy boundary).
	 */
	const readDeclaredFile = async (rawPath: string, what: string): Promise<Buffer> => {
		const safeName = basename(rawPath);
		const resolved = resolveSessionPath(manifestDir, rawPath);
		let real: string;
		try {
			real = await realpath(resolved);
		} catch {
			throw new NroV2AnalyzeError("FILE_MISSING", `${what} "${safeErrorValue(safeName)}" is missing or unreadable`);
		}
		if (real !== dirReal && !real.startsWith(dirReal + sep)) {
			throw new NroV2AnalyzeError("PATH_UNSAFE", `${what} "${safeErrorValue(safeName)}" resolves outside the manifest directory`);
		}
		if (seenRealPaths.has(real)) {
			throw new NroV2AnalyzeError("DUPLICATE_PATH", `${what} "${safeErrorValue(safeName)}" duplicates another declared path (identical realpath)`);
		}
		seenRealPaths.add(real);
		let info;
		try {
			info = await stat(real);
		} catch {
			throw new NroV2AnalyzeError("FILE_MISSING", `${what} "${safeErrorValue(safeName)}" is not readable`);
		}
		if (!info.isFile()) throw new NroV2AnalyzeError("FILE_MISSING", `${what} "${safeErrorValue(safeName)}" is not a regular file`);
		if (info.size > SESSION_MAX_BYTES) {
			throw new NroV2AnalyzeError("OVER_BOUND", `${what} "${safeErrorValue(safeName)}" exceeds ${SESSION_MAX_BYTES} bytes`);
		}
		try {
			return await readFile(real);
		} catch {
			throw new NroV2AnalyzeError("FILE_MISSING", `${what} "${safeErrorValue(safeName)}" could not be read`);
		}
	};

	const runs: RunFactsV2[] = [];
	for (const session of manifest.sessions) {
		const raw = await readDeclaredFile(session.path, "session file");
		const sessionSha256 = sha256Hex(raw);
		if (sessionSha256 !== session.expectedSessionSha256) {
			throw new NroV2AnalyzeError(
				"HASH_MISMATCH",
				`session "${safeErrorValue(session.label)}": raw byte SHA-256 ${sessionSha256} does not match expected_session_sha256 ${session.expectedSessionSha256}`,
			);
		}
		const entries = parseSessionLines(raw.toString("utf8"), session.label);
		runs.push(
			computeRunFactsV2(
				session.label,
				session.arm,
				session.orderIndex,
				basename(session.path),
				sessionSha256,
				entries,
				manifest.milestonePromptSha256,
				manifest.environment,
				{ enforceValidity: manifest.phase === "final" },
			),
		);
	}

	const attempts: AttemptFactsV2[] = [];
	for (const attempt of manifest.attempts) {
		const raw = await readDeclaredFile(attempt.path, "attempt file");
		const rawSha256 = sha256Hex(raw);
		if (rawSha256 !== attempt.expectedSessionSha256) {
			throw new NroV2AnalyzeError(
				"HASH_MISMATCH",
				`attempt "${safeErrorValue(attempt.label)}": raw byte SHA-256 ${rawSha256} does not match expected_session_sha256 ${attempt.expectedSessionSha256}`,
			);
		}
		const entries = parseSessionLines(raw.toString("utf8"), attempt.label);
		const derived = deriveAttemptFactsV2(
			attempt.label,
			attempt.arm,
			basename(attempt.path),
			rawSha256,
			entries,
			manifest.milestonePromptSha256,
			manifest.environment,
			{ strict: manifest.phase === "final" },
		);
		if (derived.category !== attempt.category) {
			throw new NroV2AnalyzeError(
				"CATEGORY_MISMATCH",
				`attempt "${safeErrorValue(attempt.label)}": declared category ${attempt.category} does not reproduce the frozen derivation (derived ${derived.category})`,
			);
		}
		if (derived.promptSha256 !== attempt.promptSha256) {
			throw new NroV2AnalyzeError(
				"CATEGORY_MISMATCH",
				`attempt "${safeErrorValue(attempt.label)}": declared prompt SHA-256 ${attempt.promptSha256 ?? "null"} does not equal the derived value ${derived.promptSha256 ?? "null"}`,
			);
		}
		attempts.push(derived);
	}

	// Output-facing identities must be bounded safe identities before any
	// report is returned. Dev sessions/attempts are covered explicitly —
	// final-phase identities are already pinned by the v2 core enforcement,
	// but the report is withheld regardless of phase.
	for (const run of runs) {
		requireSafeOutputIdentitiesV2(run.label, run.modelKeys, run.thinkingLevel, run.perTool.map((t) => t.toolName));
	}
	for (const attempt of attempts) {
		requireSafeOutputIdentitiesV2(attempt.label, attempt.modelKeys, attempt.thinkingLevel, []);
	}

	// Fixture tree: resolve, contain, dedupe, re-verify the manifest hash.
	const fixtureResolved = resolveSessionPath(manifestDir, manifest.fixture.path);
	let fixtureReal: string;
	try {
		fixtureReal = await realpath(fixtureResolved);
	} catch {
		throw new NroV2AnalyzeError("FILE_MISSING", `fixture directory "${safeErrorValue(basename(manifest.fixture.path))}" is missing or unreadable`);
	}
	if (fixtureReal !== dirReal && !fixtureReal.startsWith(dirReal + sep)) {
		throw new NroV2AnalyzeError("PATH_UNSAFE", `fixture directory "${safeErrorValue(basename(manifest.fixture.path))}" resolves outside the manifest directory`);
	}
	if (seenRealPaths.has(fixtureReal)) {
		throw new NroV2AnalyzeError("DUPLICATE_PATH", `fixture directory "${safeErrorValue(basename(manifest.fixture.path))}" duplicates another declared path (identical realpath)`);
	}
	seenRealPaths.add(fixtureReal);
	let fixture: Awaited<ReturnType<typeof fixtureManifestHash>>;
	try {
		fixture = await fixtureManifestHash(fixtureReal);
	} catch (error) {
		// Nested fixture paths/entry names never leak: the wrapped error
		// references only the bounded fixture-directory basename; the stable
		// generic code collapses every failure except OVER_BOUND, which stays
		// distinct.
		const code = (error as { code?: unknown }).code === "OVER_BOUND" ? "OVER_BOUND" : "FIXTURE_UNSAFE";
		throw new NroV2AnalyzeError(code, `fixture directory "${safeErrorValue(basename(manifest.fixture.path))}" could not be verified (unsafe or unreadable fixture tree)`);
	}
	if (fixture.manifestSha256 !== manifest.fixture.manifestSha256) {
		throw new NroV2AnalyzeError(
			"FIXTURE_MISMATCH",
			`fixture tree SHA-256 ${fixture.manifestSha256} does not match the manifest-declared fixture manifest hash ${manifest.fixture.manifestSha256}`,
		);
	}

	const controlRuns = runs.filter((r) => r.arm === "control");
	const treatmentRuns = runs.filter((r) => r.arm === "treatment");
	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		protocolVersion: PROTOCOL_VERSION,
		protocolDoc: PROTOCOL_DOC,
		manifest: {
			basename: manifestBasename,
			protocolDoc: manifest.protocolDoc,
			schemaVersion: manifest.schemaVersion,
			protocolVersion: manifest.protocolVersion,
			phase: manifest.phase,
			milestonePromptSha256: manifest.milestonePromptSha256,
			environment: manifest.environment,
			fixture: {
				path: manifest.fixture.path,
				manifestSha256: fixture.manifestSha256,
				verified: true,
				files: fixture.files.length,
				totalBytes: fixture.totalBytes,
			},
			nonTreatmentSha256: manifest.nonTreatmentSha256,
			rubricSha256: manifest.rubric.sha256,
			rubricChecks: manifest.rubric.checks.length,
			sessionCount: manifest.sessions.length,
			attemptCount: manifest.attempts.length,
		},
		runs,
		arms: {
			control: buildArmFactsV2("control", controlRuns),
			treatment: buildArmFactsV2("treatment", treatmentRuns),
		},
		attempts,
		verdicts: computeVerdictsFromRunsV2(controlRuns, treatmentRuns, manifest.phase),
	};
}

/**
 * Read the manifest file (size-bounded, safe basename) and run the full
 * offline analysis pipeline against the frozen protocol (a derived
 * protocol is accepted as a library-level test seam only — the CLI always
 * uses the frozen pins). Read-only: reads the manifest, the declared
 * session/attempt files and the declared fixture tree only — no file
 * writes, no model call, no network, no provider/cache/session state.
 */
export async function analyzeManifestFileV2(manifestPath: string, protocol: V2FrozenProtocol = FROZEN_NRO_V2_PROTOCOL): Promise<BenchmarkReportV2> {
	const name = basename(manifestPath);
	if (!BASENAME_RE.test(name)) {
		throw new NroV2AnalyzeError("BASENAME_UNSAFE", "manifest basename must be a bounded safe file name ([A-Za-z0-9][A-Za-z0-9._-]*, at most 128 chars)");
	}
	let info;
	try {
		info = await stat(manifestPath);
	} catch {
		throw new NroV2AnalyzeError("IO_ERROR", `cannot read manifest "${safeErrorValue(name)}": missing or unreadable`);
	}
	if (!info.isFile()) throw new NroV2AnalyzeError("IO_ERROR", `manifest "${safeErrorValue(name)}" is not a regular file`);
	if (info.size > MANIFEST_MAX_BYTES) {
		throw new NroV2AnalyzeError("OVER_BOUND", `manifest "${safeErrorValue(name)}" exceeds ${MANIFEST_MAX_BYTES} bytes`);
	}
	let text: string;
	try {
		text = await readFile(manifestPath, "utf8");
	} catch {
		throw new NroV2AnalyzeError("IO_ERROR", `cannot read manifest "${safeErrorValue(name)}": unreadable`);
	}
	const manifest = parseManifestV2(text, protocol);
	return buildReportV2(manifest, dirname(resolve(manifestPath)), name);
}

// ---------------------------------------------------------------------------
// Deterministic bounded rendering (v1 §9.1–§9.2 parity; privacy §9.4)
// ---------------------------------------------------------------------------

/**
 * Deterministic output caps over the actual newline-joined rendering:
 * the UTF-8 byte budget counts the "\n" separator bytes of
 * `out.join("\n")` exactly, and the line budget counts whole kept lines.
 * On overflow the result always carries an explicit marker line
 * (byte-truncated when the caller cap cannot hold the full marker):
 * trailing kept lines are removed — one, or as many as needed — until
 * the marker fits, so a truncated output is never silently returned
 * unmarked (the marker alone always fits within positive caps). The
 * result is always <= maxLines lines, stays within maxBytes and is
 * deterministic — identical inputs yield identical outputs. Degenerate
 * caller caps (non-finite or <= 0 lines/bytes) fail closed to the empty
 * output.
 */
export function applyCapsV2(lines: readonly string[], maxLines: number, maxBytes: number): string[] {
	const safeLines = Number.isFinite(maxLines) ? Math.max(0, Math.floor(maxLines)) : 0;
	const safeBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
	if (safeLines === 0 || safeBytes === 0) return [];
	const marker = truncateUtf8(`... (output capped: ${maxLines} lines / ${maxBytes} bytes — deterministic bound)`, safeBytes);
	const markerBytes = utf8Bytes(marker);
	const out: string[] = [];
	let total = 0; // exact UTF-8 bytes of out.join("\n") so far
	for (const line of lines) {
		const lineBytes = utf8Bytes(line);
		const sepBytes = out.length > 0 ? 1 : 0;
		if (out.length + 1 > safeLines || total + sepBytes + lineBytes > safeBytes) {
			if (out.length === 0) {
				// A single oversized first line: emit a truncated prefix before
				// the marker when both fit, else the marker alone.
				if (safeLines >= 2 && markerBytes + 1 <= safeBytes) {
					const prefix = truncateUtf8(line, safeBytes - markerBytes - 1);
					return prefix.length > 0 ? [prefix, marker] : [marker];
				}
				return [marker];
			}
			// Truncation: drop trailing kept lines — one, or as many as
			// needed — until the marker fits. The marker alone always fits
			// (byte-truncated to safeBytes, one line <= safeLines), so the
			// output always stays marked; an unmarked prefix is never
			// returned. The line bound is preserved because each candidate
			// keeps at most out.length <= safeLines lines.
			let keptBytes = total;
			for (let k = out.length; k > 0; k -= 1) {
				keptBytes -= utf8Bytes(out[k - 1]!) + (k > 1 ? 1 : 0);
				const candidateBytes = keptBytes + markerBytes + (k > 1 ? 1 : 0);
				if (candidateBytes <= safeBytes) {
					return [...out.slice(0, k - 1), marker];
				}
			}
			return [marker];
		}
		out.push(line);
		total += sepBytes + lineBytes;
	}
	return out;
}

/** Deterministic, bounded, ASCII-safe human rendering of the v2 report. */
export function renderReportV2(report: BenchmarkReportV2): string[] {
	const m = report.manifest;
	const lines: string[] = [
		"commander native tool benchmark v2 (NRO protocol v2) — offline analyzer, machine facts only",
		`protocol doc  : ${PROTOCOL_DOC}`,
		`manifest      : ${boundedDisplay(m.basename, BASENAME_MAX_CHARS).text} (schema ${m.schemaVersion}, protocol ${m.protocolVersion}, phase ${m.phase}, ${m.sessionCount} sessions / ${m.attemptCount} attempts)`,
		`milestone prompt sha256 : ${m.milestonePromptSha256}`,
		`environment   : model ${m.environment.modelKey} | thinking ${m.environment.thinkingLevel} | Pi ${m.environment.piVersion} | Node ${m.environment.nodeVersion} (pinned — enforced for every final session)`,
		`fixture       : ${boundedDisplay(m.fixture.path, PATH_MAX_BYTES).text} | manifest sha256 ${m.fixture.manifestSha256} | verified ${m.fixture.verified} | ${m.fixture.files} files | ${m.fixture.totalBytes} bytes`,
		`non-treatment bundle sha256 : ${m.nonTreatmentSha256}`,
		`rubric        : sha256 ${m.rubricSha256} | ${m.rubricChecks} checks (frozen six-fact v2 rubric executed over the final assistant text)`,
		"",
		"per-run facts (every declared run retained; prompt/environment/compaction/terminal enforced for final sessions):",
	];
	for (const run of report.runs) {
		const label = boundedDisplay(run.label, LABEL_MAX_CHARS).text;
		const model = boundedDisplay(run.modelKeys.length > 0 ? run.modelKeys.join(",") : "(none)", MODEL_KEY_MAX_CHARS).text;
		const thinking = run.thinkingLevel === null ? "n/a" : boundedDisplay(run.thinkingLevel, THINKING_LEVEL_MAX_CHARS).text;
		const wall = run.wallTimeMs === null ? "n/a" : `${run.wallTimeMs}ms`;
		lines.push(
			`  ${label.padEnd(12)} [#${String(run.orderIndex).padStart(2, "0")}] requests ${run.requests} | gross ${run.gross} (in ${run.input} / out ${run.output} / cr ${run.cacheRead} / cw ${run.cacheWrite}) | compactions ${run.compactions} | cost $${run.cost.toFixed(6)} | inline ${run.successfulTextBytes}/${run.totalTextBytes} succ/total | edit/write ${run.editWriteToolCalls} | wall ${wall} | model ${model} | thinking ${thinking} | stop ${run.terminal.lastAssistantStopReason ?? "none"} | correct ${run.correctness.passed ? "pass" : "FAIL"} | previews ${run.pagination.previewResults} | obligations ${run.pagination.obligationsPaginated}/${run.pagination.obligations} | reached ${run.pagination.reachedComplete} | misuse ${run.pagination.misuse ? "yes" : "no"} | session ${boundedDisplay(run.sessionBasename, BASENAME_MAX_CHARS).text} | sha256 ${run.sessionSha256}`,
		);
	}
	lines.push("", "arm facts (medians over the arm's valid runs; gross p90 = nearest-rank p90):");
	for (const arm of ARMS) {
		const a = report.arms[arm];
		lines.push(
			`  ${arm.padEnd(9)} n=${a.runCount} | requests median ${a.requestsMedian ?? "n/a"} | gross median ${a.grossMedian ?? "n/a"} | successful inline bytes median ${a.successfulTextBytesMedian ?? "n/a"} | gross p90 ${a.grossP90 ?? "n/a"} | totals requests ${a.totals.requests} gross ${a.totals.gross} inline ${a.totals.successfulTextBytes}/${a.totals.totalTextBytes} succ/total cost $${a.totals.cost.toFixed(6)}`,
		);
	}
	if (report.attempts.length > 0) {
		lines.push("", "attempts (all retained; categories machine-verified against the frozen derivation):");
		for (const attempt of report.attempts) {
			lines.push(
				`  ${attempt.label.padEnd(10)} [${attempt.arm}] category ${attempt.category.padEnd(18)} | prompt ${attempt.promptSha256 ?? "null"} | requests ${attempt.requests} | compactions ${attempt.compactions} | stop ${attempt.terminal.lastAssistantStopReason ?? "none"} | session ${boundedDisplay(attempt.sessionBasename, BASENAME_MAX_CHARS).text} | sha256 ${attempt.rawSha256}`,
			);
		}
	}
	lines.push("", "frozen §8 adoption verdicts (final-validation cohort only; dev manifests are always NOT_MEASURED):");
	for (const verdict of report.verdicts) {
		lines.push(`  ${verdict.metricLabel.padEnd(44)} ${verdict.status} — ${verdict.reason}`);
	}
	lines.push(
		"privacy : this output carries hashes, labels, basenames, counts and numeric facts only — never message bodies, tool arguments, raw tool-result content, preview facts values, secrets, or absolute paths",
	);
	return applyCapsV2(lines, HUMAN_MAX_LINES, HUMAN_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// CLI — exit 0 success, 1 fail-closed analysis error (stderr only, no
// partial stdout), 2 usage error; --json is pretty deterministic + LF
// ---------------------------------------------------------------------------

function usageV2(): string {
	return [
		"commander-native-tool-benchmark-v2 — NRO protocol-v2 offline analyzer (read-only, machine facts only)",
		"",
		"usage:",
		"  tsx scripts/commander-native-tool-benchmark-v2-analyze.ts analyze <manifest.json> [--json]",
		"  tsx scripts/commander-native-tool-benchmark-v2-analyze.ts --help",
		"",
		"analyze — read-only offline analyzer over the strict v2 manifest (schema_version 2, protocol_version 2):",
		"  session/attempt/fixture paths inside the manifest are relative to the manifest file's directory",
		"  (absolute/drive/UNC/NUL/'..' paths, symlink escapes and duplicate realpaths are rejected);",
		"  every session/attempt raw byte SHA-256 and the fixture manifest hash are verified against the",
		"  declared pins; attempt categories and prompt hashes are machine-verified against the frozen",
		"  derivation (any drift fails closed);",
		"  --json emits the deterministic JSON report; without it the bounded human rendering is emitted",
		"  (240 lines / 64 KiB hard caps with an explicit cap marker);",
		"  reads only: the manifest, the declared session/attempt files and the declared fixture tree",
		"  never: model calls, network, provider/cache/session state, file writes, absolute paths in output",
		"",
		"exit codes: 0 success | 1 any fail-closed analysis error (stderr only, no partial stdout) | 2 usage error",
	].join("\n");
}

/** Structured error-code allowlist shape: bounded safe uppercase identifiers. */
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Fixed UTF-8 cap for CLI error messages (control-sanitized, explicit "…" marker). */
const ERROR_MAX_BYTES = 512;
/** Fixed rendered item cap for unknown CLI options. */
const UNKNOWN_OPTIONS_MAX_ITEMS = 8;

/**
 * Privacy-safe CLI error rendering: only trusted structured error
 * families render their sanitized bounded messages — the adapter's own
 * NroV2AnalyzeError (recognized by class) and the established internal
 * core/policy/validator families (NroV2Error, V2PolicyError, NroError,
 * recognized by their internal error names) when they carry an
 * allowlisted bounded uppercase code. A plain/arbitrary Error — even
 * with a forged safe-looking code — and any Error with an unsafe
 * code/name collapse to the fixed generic withheld-details form, so no
 * untrusted message is ever revealed. No arbitrary coded Error can cause
 * unbounded, control-character or leaking stderr.
 */
/** Internal structured error family names trusted to carry privacy-safe bounded messages (the adapter class is recognized by instanceof). */
const TRUSTED_INTERNAL_ERROR_NAMES = new Set(["NroV2Error", "V2PolicyError", "NroError"]);
/** Fixed generic form for untrusted throwables — details are always withheld. */
const GENERIC_WITHHELD = "ANALYZE_ERROR: unexpected failure (details withheld — see privacy boundary)";

export function renderCliErrorV2(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as { code?: unknown }).code;
		const safeCode = typeof code === "string" && ERROR_CODE_RE.test(code) ? code : null;
		const trusted = error instanceof NroV2AnalyzeError || (safeCode !== null && TRUSTED_INTERNAL_ERROR_NAMES.has(error.name));
		if (trusted && safeCode !== null) {
			return `${safeCode}: ${boundedDisplay(error.message, ERROR_MAX_BYTES).text}`;
		}
	}
	return GENERIC_WITHHELD;
}

async function mainAnalyzeV2(args: readonly string[]): Promise<number> {
	const manifestArg = args[0];
	if (manifestArg === undefined) {
		process.stderr.write(`${usageV2()}\n`);
		return 2;
	}
	const unknown = args.slice(1).filter((a) => a !== "--json");
	if (unknown.length > 0) {
		// Fixed item cap plus a fixed byte cap per item and on the rendered
		// list: unknown-option stderr is bounded in both dimensions.
		const shown = unknown.slice(0, UNKNOWN_OPTIONS_MAX_ITEMS).map((a) => boundedDisplay(a, 64).text);
		const hidden = unknown.length - shown.length;
		const rendered = hidden > 0 ? `${shown.join(", ")} (+${hidden} more)` : shown.join(", ");
		process.stderr.write(`commander-native-tool-benchmark-v2 analyze: unknown option(s): ${boundedDisplay(rendered, ERROR_MAX_BYTES).text}\n${usageV2()}\n`);
		return 2;
	}
	const json = args.includes("--json");
	try {
		const report = await analyzeManifestFileV2(manifestArg);
		if (json) {
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		} else {
			for (const line of renderReportV2(report)) process.stdout.write(`${line}\n`);
		}
		return 0;
	} catch (error) {
		process.stderr.write(`commander-native-tool-benchmark-v2 analyze: ${renderCliErrorV2(error)}\n`);
		return 1;
	}
}

export async function mainV2(argv: readonly string[]): Promise<number> {
	const subcommand = argv[0];
	if (subcommand === undefined) {
		process.stderr.write(`${usageV2()}\n`);
		return 2;
	}
	if (subcommand === "--help" || subcommand === "-h") {
		process.stdout.write(`${usageV2()}\n`);
		return 0;
	}
	if (subcommand === "analyze") return mainAnalyzeV2(argv.slice(1));
	process.stderr.write(`commander-native-tool-benchmark-v2: unknown subcommand "${safeErrorValue(subcommand)}"\n${usageV2()}\n`);
	return 2;
}

// Run only when executed directly (tsx scripts/commander-native-tool-benchmark-v2-analyze.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const exitCode = await mainV2(process.argv.slice(2));
	process.exit(exitCode);
}
