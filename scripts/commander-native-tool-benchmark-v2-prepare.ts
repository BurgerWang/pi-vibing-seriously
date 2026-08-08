/**
 * NRO protocol-v2 offline prepare adapter (commander-native-tool-
 * optimization plan, v2 prepare slice) — standalone, offline, fail-closed
 * filesystem/CLI adapter over the PURE v2 benchmark core
 * (scripts/commander-native-tool-benchmark-v2.ts) and the frozen v2
 * protocol module. The hardened v1 prepare is followed ONLY as a
 * structural pattern: every derivation, label, pin check and strict
 * validation comes exclusively from the v2 core (parseCollectionRecordV2,
 * computeRunFactsV2, deriveAttemptFactsV2, manifestToJsonV2,
 * parseManifestV2) and the frozen v2 policy; the v1 parseCollectionRecord
 * / parseManifest / computeRunFacts / deriveAttemptFacts /
 * preflightInputs / preflightCollection / prepareEvidence /
 * renderPrepareSummary / parsePrepareArgs implementations and the v1
 * frozen protocol/path constants are never imported or called.
 *
 * Single subcommand:
 *
 *   prepare --inputs <dir> --collection <file> [--runs-dir <dir>]
 *     Fully preflights EVERYTHING read-only before any output creation:
 *     refuses a pre-existing v2 evidence directory or v2 manifest (only
 *     ENOENT means absent); the inputs directory must contain exactly
 *     fixture/, milestone-prompt.txt, environment.txt and rubric.json
 *     with the frozen fixture-manifest pin, the exact prompt byte pin,
 *     the exact canonical four-line environment file (no extra newline)
 *     and the schema-2 rubric (raw hash pin + exact ordered
 *     V2_RUBRIC_CHECKS). The schema/protocol-2 collection record is
 *     strictly parsed by parseCollectionRecordV2 (pins, environment,
 *     ABBA arms, entry cap); every chronological entry resolves safely
 *     relative to the collection record's directory (containment,
 *     distinct realpaths, regular non-symlink bounded source), the raw
 *     byte hash must equal entry.expected_session_sha256, strict JSONL,
 *     session labels control/treatment-NN by per-arm occurrence and
 *     attempt labels attempt-N gapless by attempt occurrence; per-run
 *     facts derive exclusively through the v2 core (final sessions
 *     enforce validity, final attempts use the strict classification and
 *     can never hide valid runs); a final record must declare the
 *     complete frozen cohort (partial finals are rejected).
 *     The generated manifest preserves the chronological session order /
 *     order_index and ALL attempts, carries the v2 names/versions/pins
 *     and frozen checks, and strictly round-trips through
 *     parseManifestV2 before any write.
 *     Byte-exact copies are staged beneath a fresh
 *     <runs-dir>/.nro-v2-prepare-staging-<uuid>/ directory (fixture, prompt,
 *     environment, rubric, collection record, sessions, attempts and the
 *     schema/protocol-2 collection-deviations.json), every staged byte
 *     is verified, then committed with a no-clobber transaction:
 *     non-recursive exclusive mkdir reservation of the evidence
 *     directory, move of the staged tree, exclusive open("wx") manifest
 *     with sync/close, post-commit re-checks, and ownership-tracked
 *     (device+inode) rollback that only removes outputs still owned by
 *     this invocation — foreign pre-existing, racing, injected or
 *     replacement paths are never deleted or overwritten, and no
 *     staging/owned partials remain after tested failures. Documented
 *     test hooks expose the race/rollback seams (production runs pass
 *     none).
 *
 * Privacy: errors and the CLI summary carry labels, basenames, arm
 * names, categories, counts, hashes and bounded machine facts only —
 * never absolute paths, message bodies, tool arguments, thinking or
 * untrusted error text. The CLI renders only trusted structured error
 * families (the adapter's own NroV2PrepareError and the established
 * NroV2Error / V2PolicyError / NroError families) recognized by ACTUAL
 * class identity (instanceof), never by a spoofable `name` string, and
 * only with allowlisted bounded uppercase codes; ordinary Errors and
 * forged `code`/`name` properties are withheld. Output is bounded by
 * explicit UTF-8 line/byte caps (240 lines / 64 KiB counting newlines,
 * with one byte reserved for the CLI's final newline so the emitted
 * form never exceeds the cap; CLI error rendering capped at 512
 * bytes).
 *
 * Determinism/offline: the module is deterministic given bytes/options
 * apart from the private staging UUID (never surfaced); purely offline —
 * no network, no provider/model calls, no process spawning, no shell,
 * no repository source writes. Importing this module has no CLI side
 * effects (the CLI runs only when the file is executed directly).
 * v1 evidence/result/manifest/path constants are never referenced or
 * modified.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
	canonicalEnvironmentFile,
	fixtureManifestHash,
	parseSessionLines,
	resolveSessionPath,
	sha256Hex,
	HUMAN_MAX_BYTES,
	HUMAN_MAX_LINES,
	MANIFEST_MAX_BYTES,
	NroError,
	PATH_MAX_BYTES,
	SESSION_MAX_BYTES,
} from "./commander-native-tool-benchmark.ts";

import {
	computeRunFactsV2,
	deriveAttemptFactsV2,
	manifestToJsonV2,
	NroV2Error,
	parseCollectionRecordV2,
	parseManifestV2,
	sessionLabelV2,
	type AttemptFactsV2,
	type CollectionRecordV2,
	type ManifestEnvironmentV2,
	type NroManifestV2,
	type RunFactsV2,
	type V2FrozenProtocol,
} from "./commander-native-tool-benchmark-v2.ts";

import {
	BENCHMARK_SCHEMA_VERSION,
	COLLECTION_RECORD_NAME,
	DEVIATIONS_NAME,
	DEVIATIONS_SCHEMA_VERSION,
	ENVIRONMENT_NAME,
	EVIDENCE_DIR_NAME,
	FIXTURE_DIR_NAME,
	FROZEN_NRO_V2_PROTOCOL,
	MANIFEST_NAME,
	MILESTONE_PROMPT_NAME,
	PROTOCOL_DOC,
	PROTOCOL_VERSION,
	RUBRIC_NAME,
	STAGING_PREFIX,
	type ArmName,
	type Phase,
} from "./commander-native-tool-benchmark-v2-protocol.ts";

import { V2PolicyError, V2_RUBRIC_CHECKS, type RubricCheckV2 } from "./commander-native-tool-benchmark-v2-policy.ts";

// ---------------------------------------------------------------------------
// Structured adapter error (privacy-safe, stable codes, fail closed)
// ---------------------------------------------------------------------------

export type NroV2PrepareErrorCode =
	| "IO_ERROR"
	| "EXISTING_OUTPUT"
	| "INPUTS_INVALID"
	| "FIXTURE_MISMATCH"
	| "FIXTURE_UNSAFE"
	| "MILESTONE_MISMATCH"
	| "ENV_FILE_INVALID"
	| "RUBRIC_INVALID"
	| "RUBRIC_MISMATCH"
	| "COLLECTION_INVALID"
	| "SOURCE_UNREADABLE"
	| "SOURCE_NOT_REGULAR"
	| "SOURCE_OVER_BOUND"
	| "SOURCE_HASH_MISMATCH"
	| "DUPLICATE_SOURCE"
	| "PATH_UNSAFE"
	| "COHORT_COUNT"
	| "INVALID_MANIFEST"
	| "STAGE_VERIFY"
	| "OVER_BOUND"
	| "BASENAME_UNSAFE";

/** Structured adapter failure — fail closed, message never carries entry content or paths. */
export class NroV2PrepareError extends Error {
	readonly code: NroV2PrepareErrorCode;
	constructor(code: NroV2PrepareErrorCode, message: string) {
		super(message);
		this.name = "NroV2PrepareError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Local bounded-display helpers (same frozen values as the v2 core; never
// imported from v1 — the v1 import surface is the allowlisted set)
// ---------------------------------------------------------------------------

/** Frozen rubric pattern cap (UTF-8 bytes — v2 core parity). */
const RUBRIC_PATTERN_MAX_BYTES = 512;
/** The frozen schema-2 rubric schema version (fixtures/.../rubric.json). */
const RUBRIC_SCHEMA_VERSION_V2 = 2;
/** Fixed UTF-8 cap for CLI error rendering (same as the v2 analyzer). */
const ERROR_MAX_BYTES = 512;

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

/** Non-global control-character predicate (a /g regex would carry lastIndex state across .test() calls). */
const CONTROL_RE_TEST = /[\x00-\x1f\x7f]/;
/** Global control-character matcher for .replace() sanitization — a separate instance, never shared with .test(). */
const CONTROL_RE_REPLACE = /[\x00-\x1f\x7f]/g;

/** Sanitized + bounded display form (control chars replaced; never injects lines). */
function boundedDisplay(text: unknown, maxBytes: number): { text: string; altered: boolean } {
	if (typeof text !== "string") return { text: "(invalid)", altered: true };
	const cleaned = text.replace(CONTROL_RE_REPLACE, " ");
	if (utf8Bytes(cleaned) <= maxBytes) return { text: cleaned, altered: cleaned !== text };
	return { text: `${truncateUtf8(cleaned, Math.max(0, maxBytes - 3))}…`, altered: true };
}

/** Sanitized value for error messages (control chars replaced, byte-bounded). */
function safeErrorValue(value: string): string {
	const cleaned = value.replace(CONTROL_RE_REPLACE, " ");
	if (utf8Bytes(cleaned) <= 64) return cleaned;
	return `${truncateUtf8(cleaned, 61)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Strict unknown-key refusal (fail closed with the adapter's structured codes). */
function requireKeysV2Prepare(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) throw new NroV2PrepareError("RUBRIC_INVALID", `unknown key "${safeErrorValue(key)}" in ${where}`);
	}
}

function fsErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: undefined;
}

function isAbsentError(error: unknown): boolean {
	return fsErrorCode(error) === "ENOENT";
}

/** Fail closed when any frozen v2 content pin is unresolved (v2 core code set). */
function requireProtocolFrozenV2(protocol: V2FrozenProtocol): void {
	const pins: Array<[string, string | null]> = [
		["milestone_prompt_sha256", protocol.milestonePromptSha256],
		["fixture_manifest_sha256", protocol.fixtureManifestSha256],
		["non_treatment_sha256", protocol.nonTreatmentSha256],
		["rubric_sha256", protocol.rubricSha256],
	];
	for (const [pinName, pin] of pins) {
		if (pin === null) {
			throw new NroV2Error("PROTOCOL_NOT_FROZEN", `the v2 content pin ${pinName} is not yet resolved (protocol-v2 §3.2)`);
		}
	}
}

/** Refuse existing outputs; only ENOENT means absent — any other stat failure fails closed. */
async function assertOutputAbsentV2(path: string, what: string): Promise<void> {
	try {
		await stat(path);
	} catch (error) {
		if (isAbsentError(error)) return;
		throw new NroV2PrepareError("IO_ERROR", `${what} cannot be inspected (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed: only ENOENT means absent`);
	}
	throw new NroV2PrepareError("EXISTING_OUTPUT", `${what} already exists — refusing to overwrite`);
}

/**
 * Recursive byte-exact fixture copy (regular files and directories only;
 * symlinks and special entries fail closed). The tree was already
 * verified by fixtureManifestHash during preflight; this re-checks every
 * entry type and bound while copying. Every created entry's identity is
 * recorded into the staging ownership tree AT CREATION TIME, so a
 * failure mid-copy can still clean up exactly the owned entries (and
 * nothing else).
 */
async function copyFixtureTreeV2(
	source: string,
	dest: string,
	tree: Map<string, { dev: number; ino: number; isDir: boolean }>,
	relPrefix: string,
): Promise<void> {
	const walk = async (current: string, rel: string): Promise<void> => {
		let names: Dirent[];
		try {
			names = await readdir(current, { withFileTypes: true });
		} catch {
			throw new NroV2PrepareError("FIXTURE_UNSAFE", `fixture directory "${safeErrorValue(basename(current))}" cannot be read`);
		}
		names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const dirent of names) {
			const childRel = rel.length === 0 ? dirent.name : `${rel}/${dirent.name}`;
			const treeRel = `${relPrefix}/${childRel}`;
			if (utf8Bytes(childRel) > PATH_MAX_BYTES) throw new NroV2PrepareError("OVER_BOUND", `fixture path exceeds ${PATH_MAX_BYTES} bytes`);
			if (CONTROL_RE_TEST.test(childRel)) throw new NroV2PrepareError("FIXTURE_UNSAFE", "fixture path contains control characters");
			if (dirent.isSymbolicLink()) throw new NroV2PrepareError("FIXTURE_UNSAFE", `fixture entry "${safeErrorValue(childRel)}" is a symlink`);
			const src = join(current, dirent.name);
			const dst = join(dest, childRel);
			if (dirent.isDirectory()) {
				await mkdir(dst);
				await recordStagingEntryV2(tree, treeRel, dst);
				await walk(src, childRel);
				continue;
			}
			if (!dirent.isFile()) throw new NroV2PrepareError("FIXTURE_UNSAFE", `fixture entry "${safeErrorValue(childRel)}" is not a regular file`);
			let content: Buffer;
			try {
				content = await readFile(src);
			} catch {
				throw new NroV2PrepareError("FIXTURE_UNSAFE", `fixture file "${safeErrorValue(childRel)}" cannot be read`);
			}
			await writeFile(dst, content);
			await recordStagingEntryV2(tree, treeRel, dst);
		}
	};
	await mkdir(dest);
	await recordStagingEntryV2(tree, relPrefix, dest);
	await walk(source, "");
}

// ---------------------------------------------------------------------------
// Inputs preflight (protocol-v2 §3.2/§5) — read-only, nothing is written
// ---------------------------------------------------------------------------

export interface FrozenInputsFactsV2 {
	fixture: Awaited<ReturnType<typeof fixtureManifestHash>>;
	milestonePromptSha256: string;
	environment: ManifestEnvironmentV2;
	rubricSha256: string;
	rubricChecks: RubricCheckV2[];
	/** Raw bytes captured at preflight — the staged copies are written from these (byte-exact by construction). */
	milestonePromptRaw: Buffer;
	environmentRaw: Buffer;
	rubricRaw: Buffer;
}

/** The frozen schema-2 rubric file: exact root keys, exact schema version, exact ordered V2_RUBRIC_CHECKS. */
function parseRubricV2(text: string, where: string): RubricCheckV2[] {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new NroV2PrepareError("RUBRIC_INVALID", `${where} is not valid JSON`);
	}
	const root = asRecord(raw);
	if (!root) throw new NroV2PrepareError("RUBRIC_INVALID", `${where} must be a JSON object`);
	requireKeysV2Prepare(root, ["schema_version", "checks"], where);
	if (root.schema_version !== RUBRIC_SCHEMA_VERSION_V2) {
		throw new NroV2PrepareError("RUBRIC_INVALID", `${where}.schema_version must be ${RUBRIC_SCHEMA_VERSION_V2}`);
	}
	const checksRaw = root.checks;
	if (!Array.isArray(checksRaw)) throw new NroV2PrepareError("RUBRIC_INVALID", `${where}.checks must be an array`);
	if (checksRaw.length !== V2_RUBRIC_CHECKS.length) {
		throw new NroV2PrepareError("RUBRIC_MISMATCH", `${where} must carry exactly the ${V2_RUBRIC_CHECKS.length} frozen v2 checks in frozen order (got ${checksRaw.length})`);
	}
	const checks: RubricCheckV2[] = [];
	for (let i = 0; i < checksRaw.length; i += 1) {
		const c = asRecord(checksRaw[i]);
		if (!c) throw new NroV2PrepareError("RUBRIC_INVALID", `${where}[${i}] must be an object`);
		requireKeysV2Prepare(c, ["id", "pattern"], `${where}[${i}]`);
		const frozen = V2_RUBRIC_CHECKS[i];
		if (!frozen) throw new NroV2PrepareError("RUBRIC_INVALID", `${where}[${i}] is outside the frozen check list`);
		const id = c.id;
		if (typeof id !== "string" || id !== frozen.id) {
			throw new NroV2PrepareError("RUBRIC_MISMATCH", `${where}[${i}].id must be the frozen check id "${frozen.id}" at frozen position ${i}`);
		}
		const pattern = c.pattern;
		if (typeof pattern !== "string" || pattern.length === 0 || utf8Bytes(pattern) > RUBRIC_PATTERN_MAX_BYTES) {
			throw new NroV2PrepareError("RUBRIC_INVALID", `${where}[${i}].pattern must be a non-empty string of at most ${RUBRIC_PATTERN_MAX_BYTES} UTF-8 bytes`);
		}
		if (pattern !== frozen.pattern) {
			throw new NroV2PrepareError("RUBRIC_MISMATCH", `${where}[${i}].pattern must be the frozen v2 pattern for check "${frozen.id}"`);
		}
		try {
			// eslint-disable-next-line no-new
			new RegExp(pattern);
		} catch {
			throw new NroV2PrepareError("RUBRIC_INVALID", `${where}[${i}].pattern must be a compilable regular expression`);
		}
		checks.push({ id, pattern });
	}
	return checks;
}

/** lstat an inputs child, failing closed as INPUTS_INVALID when it cannot be inspected. */
async function lstatInputsChildV2(inputsDir: string, name: string): Promise<Stats> {
	try {
		return await lstat(join(inputsDir, name));
	} catch {
		throw new NroV2PrepareError("INPUTS_INVALID", `inputs "${safeErrorValue(name)}" cannot be inspected`);
	}
}

/**
 * Preflight the frozen v2 inputs directory (protocol-v2 §3.2/§5): exactly
 * fixture/, milestone-prompt.txt, environment.txt and rubric.json, each
 * verified against the frozen pins — fixture manifest hash, prompt raw
 * bytes/hash, the exact canonical four-line environment file (no extra
 * newline), and the schema-2 rubric (strict structure FIRST, then the
 * raw hash pin). The inputs root and the exact four children are
 * lstat-validated before any read (never following a symlink): root and
 * fixture must be real directories; prompt/environment/rubric must be
 * non-symlink regular files with explicit bounded sizes. Read-only:
 * nothing is written.
 */
export async function preflightInputsV2(inputsDir: string, protocol: V2FrozenProtocol): Promise<FrozenInputsFactsV2> {
	requireProtocolFrozenV2(protocol);
	const env = protocol.environment;
	// The inputs ROOT must itself be a real directory — a symlinked or
	// special path is refused before any read (never follow a symlink).
	let inputsLst: Stats;
	try {
		inputsLst = await lstat(inputsDir);
	} catch {
		throw new NroV2PrepareError("INPUTS_INVALID", `inputs directory "${safeErrorValue(basename(inputsDir))}" cannot be inspected`);
	}
	if (!inputsLst.isDirectory() || inputsLst.isSymbolicLink()) {
		throw new NroV2PrepareError("INPUTS_INVALID", "inputs path must be a real directory (symlinks and special entries are rejected)");
	}
	let names: string[];
	try {
		names = await readdir(inputsDir);
	} catch {
		throw new NroV2PrepareError("INPUTS_INVALID", `inputs directory "${safeErrorValue(basename(inputsDir))}" cannot be read`);
	}
	const expected = new Set([FIXTURE_DIR_NAME, MILESTONE_PROMPT_NAME, ENVIRONMENT_NAME, RUBRIC_NAME]);
	for (const name of names) {
		if (!expected.has(name)) {
			throw new NroV2PrepareError("INPUTS_INVALID", `inputs directory must contain exactly fixture/, milestone-prompt.txt, environment.txt and rubric.json — unexpected entry "${safeErrorValue(name)}"`);
		}
	}
	if (names.length !== expected.size) {
		throw new NroV2PrepareError("INPUTS_INVALID", `inputs directory must contain exactly fixture/, milestone-prompt.txt, environment.txt and rubric.json (got ${names.length} entries)`);
	}

	// lstat-validate the exact four children BEFORE any read: fixture must
	// be a real directory, and the three frozen files must be non-symlink
	// regular files with explicit bounded sizes (readFile is never reached
	// with an unbounded, symlinked or special input).
	const envCanonical = canonicalEnvironmentFile(env);
	const envCanonicalBytes = utf8Bytes(envCanonical);
	const fixtureLst = await lstatInputsChildV2(inputsDir, FIXTURE_DIR_NAME);
	if (!fixtureLst.isDirectory() || fixtureLst.isSymbolicLink()) {
		throw new NroV2PrepareError(
			"FIXTURE_UNSAFE",
			`fixture directory "${safeErrorValue(FIXTURE_DIR_NAME)}" must be a real directory (symlinks and special entries are rejected)`,
		);
	}
	const promptLst = await lstatInputsChildV2(inputsDir, MILESTONE_PROMPT_NAME);
	if (!promptLst.isFile() || promptLst.isSymbolicLink()) {
		throw new NroV2PrepareError("INPUTS_INVALID", `inputs "${MILESTONE_PROMPT_NAME}" must be a non-symlink regular file`);
	}
	if (promptLst.size > SESSION_MAX_BYTES) {
		throw new NroV2PrepareError("OVER_BOUND", `inputs "${MILESTONE_PROMPT_NAME}" exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	const environmentLst = await lstatInputsChildV2(inputsDir, ENVIRONMENT_NAME);
	if (!environmentLst.isFile() || environmentLst.isSymbolicLink()) {
		throw new NroV2PrepareError("INPUTS_INVALID", `inputs "${ENVIRONMENT_NAME}" must be a non-symlink regular file`);
	}
	if (environmentLst.size > envCanonicalBytes) {
		throw new NroV2PrepareError("OVER_BOUND", `inputs "${ENVIRONMENT_NAME}" exceeds the pinned canonical size (${envCanonicalBytes} bytes)`);
	}
	const rubricLst = await lstatInputsChildV2(inputsDir, RUBRIC_NAME);
	if (!rubricLst.isFile() || rubricLst.isSymbolicLink()) {
		throw new NroV2PrepareError("INPUTS_INVALID", `inputs "${RUBRIC_NAME}" must be a non-symlink regular file`);
	}
	if (rubricLst.size > SESSION_MAX_BYTES) {
		throw new NroV2PrepareError("OVER_BOUND", `inputs "${RUBRIC_NAME}" exceeds ${SESSION_MAX_BYTES} bytes`);
	}

	let fixture: Awaited<ReturnType<typeof fixtureManifestHash>>;
	try {
		fixture = await fixtureManifestHash(join(inputsDir, FIXTURE_DIR_NAME));
	} catch (error) {
		// Nested fixture paths/entry names never leak: the wrapped error
		// references only the bounded fixture-directory basename.
		const code = (error as { code?: unknown }).code === "OVER_BOUND" ? "OVER_BOUND" : "FIXTURE_UNSAFE";
		throw new NroV2PrepareError(code, `fixture directory "${safeErrorValue(FIXTURE_DIR_NAME)}" could not be verified (unsafe or unreadable fixture tree)`);
	}
	if (fixture.manifestSha256 !== protocol.fixtureManifestSha256) {
		throw new NroV2PrepareError("FIXTURE_MISMATCH", `fixture tree SHA-256 ${fixture.manifestSha256} does not match the frozen pin ${protocol.fixtureManifestSha256}`);
	}

	let promptRaw: Buffer;
	try {
		promptRaw = await readFile(join(inputsDir, MILESTONE_PROMPT_NAME));
	} catch {
		throw new NroV2PrepareError("INPUTS_INVALID", `inputs "${MILESTONE_PROMPT_NAME}" cannot be read`);
	}
	if (promptRaw.length > SESSION_MAX_BYTES) {
		throw new NroV2PrepareError("OVER_BOUND", `inputs "${MILESTONE_PROMPT_NAME}" exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	const promptSha = sha256Hex(promptRaw);
	if (promptSha !== protocol.milestonePromptSha256) {
		throw new NroV2PrepareError("MILESTONE_MISMATCH", `milestone-prompt.txt SHA-256 ${promptSha} does not match the frozen pin ${protocol.milestonePromptSha256}`);
	}

	let environmentRaw: Buffer;
	try {
		environmentRaw = await readFile(join(inputsDir, ENVIRONMENT_NAME));
	} catch {
		throw new NroV2PrepareError("INPUTS_INVALID", `inputs "${ENVIRONMENT_NAME}" cannot be read`);
	}
	if (environmentRaw.toString("utf8") !== envCanonical) {
		throw new NroV2PrepareError(
			"ENV_FILE_INVALID",
			"environment.txt must be exactly the four pinned lines in fixed order (model_key, thinking_level, pi_version, node_version) with no extra content or newline",
		);
	}

	let rubricRaw: Buffer;
	try {
		rubricRaw = await readFile(join(inputsDir, RUBRIC_NAME));
	} catch {
		throw new NroV2PrepareError("INPUTS_INVALID", `inputs "${RUBRIC_NAME}" cannot be read`);
	}
	if (rubricRaw.length > SESSION_MAX_BYTES) {
		throw new NroV2PrepareError("OVER_BOUND", `inputs "${RUBRIC_NAME}" exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	// Strict rubric parse FIRST: a malformed rubric fails closed as
	// RUBRIC_INVALID regardless of its hash; only a structurally exact
	// schema-2 rubric is then compared against the frozen content pin
	// (content drift stays RUBRIC_MISMATCH).
	const rubricChecks = parseRubricV2(rubricRaw.toString("utf8"), "rubric.json");
	const rubricSha = sha256Hex(rubricRaw);
	if (rubricSha !== protocol.rubricSha256) {
		throw new NroV2PrepareError("RUBRIC_MISMATCH", `rubric.json SHA-256 ${rubricSha} does not match the frozen pin ${protocol.rubricSha256}`);
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
// Collection preflight (protocol-v2 §4.5/§5/§6) — read-only, v2 core only
// ---------------------------------------------------------------------------

export interface PreflightedSourceV2 {
	label: string;
	arm: ArmName;
	kind: "session" | "attempt";
	basename: string;
	raw: Buffer;
	rawSha256: string;
	entries: unknown[];
}

export interface PreflightCollectionResultV2 {
	record: CollectionRecordV2;
	recordRaw: Buffer;
	sessions: RunFactsV2[];
	attempts: AttemptFactsV2[];
	sources: PreflightedSourceV2[];
}

/**
 * Preflight the schema/protocol-2 collection record against the frozen
 * protocol: strict parse through parseCollectionRecordV2 (pins,
 * environment, ABBA arms, entry cap), then for every chronological entry
 * a safe relative resolution against the collection record's directory
 * with containment, distinct realpaths, regular non-symlink bounded
 * source, raw byte hash equality with expected_session_sha256, strict
 * JSONL, session labels control/treatment-NN by per-arm occurrence and
 * attempt labels attempt-N gapless by attempt occurrence; per-run facts
 * derive exclusively through the v2 core (final sessions enforce
 * validity; final attempts use the strict classification). A final
 * record must declare the complete frozen cohort. Read-only: nothing is
 * written.
 */
export async function preflightCollectionV2(collectionFile: string, inputs: FrozenInputsFactsV2, protocol: V2FrozenProtocol): Promise<PreflightCollectionResultV2> {
	requireProtocolFrozenV2(protocol);
	const collectionDir = dirname(resolve(collectionFile));
	let dirReal: string;
	try {
		dirReal = await realpath(collectionDir);
	} catch {
		throw new NroV2PrepareError("IO_ERROR", "the collection record's directory cannot be resolved");
	}
	let info;
	try {
		// lstat — the record itself must be a non-symlink regular bounded
		// file (a symlinked record is refused, never followed).
		info = await lstat(collectionFile);
	} catch (error) {
		if (isAbsentError(error)) throw new NroV2PrepareError("COLLECTION_INVALID", "collection record is missing or unreadable");
		throw new NroV2PrepareError("IO_ERROR", `collection record cannot be inspected (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed`);
	}
	if (!info.isFile() || info.isSymbolicLink()) throw new NroV2PrepareError("COLLECTION_INVALID", "collection record must be a non-symlink regular file");
	if (info.size > SESSION_MAX_BYTES) {
		throw new NroV2PrepareError("OVER_BOUND", `collection record exceeds ${SESSION_MAX_BYTES} bytes`);
	}
	let recordRaw: Buffer;
	try {
		recordRaw = await readFile(collectionFile);
	} catch {
		throw new NroV2PrepareError("COLLECTION_INVALID", "collection record is unreadable");
	}
	const record = parseCollectionRecordV2(recordRaw.toString("utf8"), "collection record", protocol);

	const sessions: RunFactsV2[] = [];
	const attempts: AttemptFactsV2[] = [];
	const sources: PreflightedSourceV2[] = [];
	const seenRealPaths = new Set<string>();
	const armOccurrence = new Map<ArmName, number>();
	let sessionPosition = 0;
	let attemptNumber = 0;
	for (const entry of record.entries) {
		let label: string;
		if (entry.kind === "session") {
			sessionPosition += 1;
			const n = (armOccurrence.get(entry.arm) ?? 0) + 1;
			armOccurrence.set(entry.arm, n);
			label = sessionLabelV2(entry.arm, n);
		} else {
			attemptNumber += 1;
			label = `attempt-${attemptNumber}`;
		}
		const safeName = basename(entry.path);
		let resolved: string;
		try {
			resolved = resolveSessionPath(collectionDir, entry.path);
		} catch {
			throw new NroV2PrepareError("PATH_UNSAFE", `collection source "${label}": declared path is not a bounded safe relative path (absolute/drive/UNC/NUL/".." paths are rejected)`);
		}
		// The declared leaf must itself be a regular file — a symlink or
		// any special entry at the declared path fails closed (non-symlink
		// source contract), while symlinked intermediate directories still
		// resolve through realpath and stay containment-checked below.
		let lst;
		try {
			lst = await lstat(resolved);
		} catch (error) {
			if (!isAbsentError(error)) {
				throw new NroV2PrepareError("IO_ERROR", `collection source "${label}" (${safeErrorValue(safeName)}) cannot be inspected (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed`);
			}
			throw new NroV2PrepareError("SOURCE_UNREADABLE", `collection source "${label}" (${safeErrorValue(safeName)}) is missing`);
		}
		if (!lst.isFile()) {
			throw new NroV2PrepareError("SOURCE_NOT_REGULAR", `collection source "${label}" (${safeErrorValue(safeName)}) is not a regular file (symlinks and special entries are rejected)`);
		}
		if (lst.size > SESSION_MAX_BYTES) {
			throw new NroV2PrepareError("SOURCE_OVER_BOUND", `collection source "${label}" (${safeErrorValue(safeName)}) exceeds ${SESSION_MAX_BYTES} bytes`);
		}
		let real: string;
		try {
			real = await realpath(resolved);
		} catch (error) {
			if (!isAbsentError(error)) {
				throw new NroV2PrepareError("IO_ERROR", `collection source "${label}" (${safeErrorValue(safeName)}) cannot be resolved (errno ${fsErrorCode(error) ?? "unknown"}) — failing closed`);
			}
			throw new NroV2PrepareError("SOURCE_UNREADABLE", `collection source "${label}" (${safeErrorValue(safeName)}) is missing`);
		}
		if (real !== dirReal && !real.startsWith(dirReal + sep)) {
			throw new NroV2PrepareError("PATH_UNSAFE", `collection source "${label}" (${safeErrorValue(safeName)}) resolves outside the collection record's directory`);
		}
		if (seenRealPaths.has(real)) {
			throw new NroV2PrepareError("DUPLICATE_SOURCE", `collection source "${label}" (${safeErrorValue(safeName)}) duplicates another declared source (identical realpath — every source must be a distinct file)`);
		}
		seenRealPaths.add(real);
		let raw: Buffer;
		try {
			raw = await readFile(real);
		} catch {
			throw new NroV2PrepareError("SOURCE_UNREADABLE", `collection source "${label}" (${safeErrorValue(safeName)}) is unreadable`);
		}
		const rawSha256 = sha256Hex(raw);
		if (rawSha256 !== entry.expectedSessionSha256) {
			throw new NroV2PrepareError(
				"SOURCE_HASH_MISMATCH",
				`collection source "${label}" (${safeErrorValue(safeName)}): raw byte SHA-256 ${rawSha256} does not match expected_session_sha256 ${entry.expectedSessionSha256}`,
			);
		}
		const entries = parseSessionLines(raw.toString("utf8"), label);
		sources.push({ label, arm: entry.arm, kind: entry.kind, basename: safeName, raw, rawSha256, entries });
		if (entry.kind === "session") {
			const run = computeRunFactsV2(
				label,
				entry.arm,
				sessionPosition,
				safeName,
				rawSha256,
				entries,
				protocol.milestonePromptSha256 as string,
				inputs.environment,
				{ enforceValidity: record.phase === "final" },
			);
			sessions.push(run);
		} else {
			attempts.push(
				deriveAttemptFactsV2(label, entry.arm, safeName, rawSha256, entries, protocol.milestonePromptSha256 as string, inputs.environment, {
					strict: record.phase === "final",
				}),
			);
		}
	}
	if (record.phase === "final" && sessions.length !== 2 * protocol.runsPerArm) {
		throw new NroV2PrepareError(
			"COHORT_COUNT",
			`a final collection record must contain exactly ${protocol.runsPerArm} control + ${protocol.runsPerArm} treatment session entries (got ${sessions.length}) — partial final cohorts are rejected`,
		);
	}
	return { record, recordRaw, sessions, attempts, sources };
}

// ---------------------------------------------------------------------------
// Manifest + deviations assembly (v2 names/versions/pins/frozen checks)
// ---------------------------------------------------------------------------

export interface DeviationsAttemptV2 {
	label: string;
	arm: ArmName;
	/** Runs-root-relative evidence path of the staged attempt copy. */
	path: string;
	basename: string;
	rawSha256: string;
	promptSha256: string | null;
	category: AttemptFactsV2["category"];
	terminal: AttemptFactsV2["terminal"];
}

export interface DeviationsDocumentV2 {
	schema_version: number;
	protocol_version: number;
	protocol_doc: string;
	phase: Phase;
	milestone_prompt_sha256: string;
	attempts: DeviationsAttemptV2[];
}

// ---------------------------------------------------------------------------
// Full preparation pipeline (preflight -> assemble -> stage -> verify ->
// commit) with exclusive creates and ownership-tracked rollback
// ---------------------------------------------------------------------------

/** Exclusive staging-candidate retries before failing closed (production UUID candidates never collide). */
const STAGING_CREATE_RETRIES = 8;

/** Fixed UTF-8 byte bound for a staging candidate suffix (single path component). */
const STAGING_SUFFIX_MAX_BYTES = 64;

/**
 * Validate a staging candidate suffix (TEST SEAM) as a bounded safe
 * single path component: empty, "."/".." traversal, embedded "/" or
 * "\\" separators, control characters and overlong values all fail
 * closed — an unsafe candidate is never joined into a path and can
 * never escape the runs root (production UUID fragments always pass).
 */
function validateStagingSuffixV2(suffix: string): void {
	if (suffix.length === 0) throw new NroV2PrepareError("BASENAME_UNSAFE", "staging candidate name is empty");
	if (suffix === "." || suffix === ".." || suffix.includes("/") || suffix.includes("\\")) {
		throw new NroV2PrepareError("BASENAME_UNSAFE", "staging candidate name must be a single safe path component");
	}
	if (CONTROL_RE_TEST.test(suffix)) throw new NroV2PrepareError("BASENAME_UNSAFE", "staging candidate name contains control characters");
	if (utf8Bytes(suffix) > STAGING_SUFFIX_MAX_BYTES) {
		throw new NroV2PrepareError("BASENAME_UNSAFE", `staging candidate name exceeds ${STAGING_SUFFIX_MAX_BYTES} UTF-8 bytes`);
	}
}

/** Number of path segments of a tree-relative path (never the root itself). */
function relDepthV2(rel: string): number {
	return rel.split("/").length;
}

/**
 * Identity snapshot (device+inode + type) of the invocation-owned staged
 * tree, captured BEFORE the atomic move — rename preserves identities, so
 * the committed tree is rolled back against these same values. Only
 * entries whose current identity still matches are ever removed; a
 * foreign replacement or injected child never matches and survives.
 */
async function captureTreeIdentitiesV2(root: string): Promise<Map<string, { dev: number; ino: number; isDir: boolean }>> {
	const out = new Map<string, { dev: number; ino: number; isDir: boolean }>();
	const walk = async (current: string, rel: string): Promise<void> => {
		const lst = await lstat(current);
		out.set(rel, { dev: lst.dev, ino: lst.ino, isDir: lst.isDirectory() });
		if (!lst.isDirectory()) return;
		const names = await readdir(current, { withFileTypes: true });
		names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const dirent of names) {
			const childRel = rel.length === 0 ? dirent.name : `${rel}/${dirent.name}`;
			await walk(join(current, dirent.name), childRel);
		}
	};
	await walk(root, "");
	return out;
}

/**
 * Best-effort identity record of a staging entry this invocation just
 * created (device+inode + type). An entry that cannot be inspected is
 * left unrecorded — cleanup never deletes an unverified path.
 */
async function recordStagingEntryV2(tree: Map<string, { dev: number; ino: number; isDir: boolean }>, rel: string, full: string): Promise<void> {
	try {
		const lst = await lstat(full);
		tree.set(rel, { dev: lst.dev, ino: lst.ino, isDir: lst.isDirectory() });
	} catch {
		// Uninspectable (already gone or unreadable) — leave unrecorded;
		// a path whose ownership cannot be verified is never deleted.
	}
}

/**
 * Identity-verified removal of an owned tree: only entries whose current
 * device+inode still match the recorded identities are removed, DEEPEST
 * FIRST and NON-recursively (rmdir for directories once their owned
 * children are gone, unlink for files). A foreign replacement of a
 * recorded entry — or any foreign child never recorded — never matches
 * and always survives. The tree ROOT is deliberately not removed here:
 * the caller removes it (rmdir) only after its own root identity check,
 * and only when it is empty — a surviving foreign child makes that
 * rmdir fail, preserving the root with its foreign content.
 */
async function removeOwnedTreeEntriesV2(root: string, tree: Map<string, { dev: number; ino: number; isDir: boolean }>): Promise<void> {
	const rels = [...tree.keys()].sort((a, b) => relDepthV2(b) - relDepthV2(a));
	for (const rel of rels) {
		if (rel.length === 0) continue; // the root is the caller's identity-checked rmdir
		const owned = tree.get(rel);
		if (!owned) continue;
		const full = join(root, rel);
		try {
			const lst = await lstat(full);
			if (lst.dev !== owned.dev || lst.ino !== owned.ino) continue;
			if (owned.isDir) await rmdir(full);
			else await rm(full, { force: true });
		} catch {
			// Already gone, non-empty (foreign content) or unreadable —
			// never delete an entry whose ownership cannot be verified as
			// this invocation's.
		}
	}
}

export interface PrepareHooksV2 {
	/** TEST SEAM ONLY — invoked after staging is fully populated and byte-verified, before the final output re-checks and exclusive commits. */
	beforeEvidenceCommit?: () => void | Promise<void>;
	/** TEST SEAM ONLY — invoked immediately after the evidence directory was EXCLUSIVELY created, before the staged tree is moved in. */
	afterEvidenceReserve?: () => void | Promise<void>;
	/** TEST SEAM ONLY — invoked after the staged tree moved into the owned evidence directory, before the manifest commit. */
	afterEvidenceCommit?: () => void | Promise<void>;
	/** TEST SEAM ONLY — invoked immediately after the manifest was EXCLUSIVELY created with open("wx"), before its bytes are written. */
	afterManifestOpen?: () => void | Promise<void>;
	/** TEST SEAM ONLY — invoked after the manifest commit, before the post-commit verification reads. */
	afterManifestCommit?: () => void | Promise<void>;
}

export interface PrepareV2Options {
	/** Runs root (default `<cwd>/.pi/workbench/runs` at the CLI). */
	runsDir: string;
	/** Frozen v2 inputs directory (fixture/, milestone-prompt.txt, environment.txt, rubric.json). */
	inputsDir: string;
	/** Immutable schema-2 collection record (chronological log of every retained attempt and session). */
	collectionFile: string;
	protocol?: V2FrozenProtocol;
	/** TEST SEAM ONLY — deterministic staging candidate-name generator (production defaults to a random UUID fragment); forces candidate collisions deterministically. Every returned suffix is validated as a bounded safe single path component (no empty, no "."/".." traversal, no "/" or "\\" separators, no control characters, bounded UTF-8 length) and fails closed otherwise. */
	stagingName?: () => string;
	/** Test-only failure seams (documented above); absent in production runs. */
	hooks?: PrepareHooksV2;
}

export interface PrepareV2Result {
	/** Absolute path of the committed evidence directory. */
	evidenceDir: string;
	/** Absolute path of the committed strict manifest. */
	manifestPath: string;
	manifest: NroManifestV2;
	record: CollectionRecordV2;
	sessions: RunFactsV2[];
	attempts: AttemptFactsV2[];
}

/**
 * Read and fully preflight every input BEFORE any output is created:
 * existing-output refusal, frozen inputs against the pins, strict
 * schema-2 collection record with final session validity and strict
 * attempt classification — all through the v2 core. All derivation
 * happens in memory; only then is a staging directory populated,
 * byte-verified, and committed with EXCLUSIVE create primitives
 * (non-recursive mkdir + open("wx")) and ownership-tracked rollback
 * (device+inode identity): the staging directory itself is created
 * EXCLUSIVELY (non-recursive mkdir with fresh candidate retries and
 * immediate ownership capture), and any failure removes only the
 * staging/output paths and tree entries this invocation still owns —
 * never partial final evidence, never a foreign path at any level.
 * Purely offline: no model calls, no network, no shell, no
 * provider/cache/session state.
 */
export async function prepareEvidenceV2(options: PrepareV2Options): Promise<PrepareV2Result> {
	const protocol = options.protocol ?? FROZEN_NRO_V2_PROTOCOL;
	const hooks = options.hooks;
	const runsDir = resolve(options.runsDir);
	const evidenceDirPath = join(runsDir, EVIDENCE_DIR_NAME);
	const manifestPath = join(runsDir, MANIFEST_NAME);

	// Refuse to overwrite existing final outputs (before any read/write).
	await assertOutputAbsentV2(evidenceDirPath, "v2 NRO evidence directory");
	await assertOutputAbsentV2(manifestPath, "v2 NRO manifest");

	// Preflight everything read-only first (protocol-v2 §5/§6).
	const inputsDir = resolve(options.inputsDir);
	const collectionFile = resolve(options.collectionFile);
	const inputs = await preflightInputsV2(inputsDir, protocol);
	const { record, recordRaw, sessions, attempts, sources } = await preflightCollectionV2(collectionFile, inputs, protocol);

	// Assemble the strict manifest (runs-root-relative evidence paths).
	const evidencePrefix = `${EVIDENCE_DIR_NAME}/`;
	const manifest: NroManifestV2 = {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		protocolVersion: PROTOCOL_VERSION,
		protocolDoc: PROTOCOL_DOC,
		phase: record.phase,
		milestonePromptSha256: protocol.milestonePromptSha256 as string,
		environment: { ...protocol.environment },
		fixture: { path: `${evidencePrefix}${FIXTURE_DIR_NAME}`, manifestSha256: protocol.fixtureManifestSha256 as string },
		nonTreatmentSha256: protocol.nonTreatmentSha256 as string,
		rubric: { sha256: protocol.rubricSha256 as string, checks: inputs.rubricChecks },
		sessions: sessions.map((s) => ({
			label: s.label,
			arm: s.arm,
			orderIndex: s.orderIndex,
			path: `${evidencePrefix}sessions/${s.label}/${s.sessionBasename}`,
			expectedSessionSha256: s.sessionSha256,
		})),
		attempts: attempts.map((a) => ({
			label: a.label,
			arm: a.arm,
			path: `${evidencePrefix}attempts/${a.label}/${a.sessionBasename}`,
			expectedSessionSha256: a.rawSha256,
			promptSha256: a.promptSha256,
			category: a.category,
		})),
	};
	const manifestJson = manifestToJsonV2(manifest);
	if (utf8Bytes(manifestJson) > MANIFEST_MAX_BYTES) {
		throw new NroV2PrepareError("OVER_BOUND", `generated manifest exceeds ${MANIFEST_MAX_BYTES} bytes`);
	}
	// Round-trip the generated manifest through the strict parser before
	// anything is committed (protocol-v2 §5).
	try {
		parseManifestV2(manifestJson, protocol);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new NroV2PrepareError("INVALID_MANIFEST", `generated manifest failed the strict v2 manifest validation: ${detail}`);
	}
	const deviations: DeviationsDocumentV2 = {
		schema_version: DEVIATIONS_SCHEMA_VERSION,
		protocol_version: PROTOCOL_VERSION,
		protocol_doc: PROTOCOL_DOC,
		phase: record.phase,
		milestone_prompt_sha256: protocol.milestonePromptSha256 as string,
		attempts: attempts.map((a) => ({
			label: a.label,
			arm: a.arm,
			path: `${evidencePrefix}attempts/${a.label}/${a.sessionBasename}`,
			basename: a.sessionBasename,
			rawSha256: a.rawSha256,
			promptSha256: a.promptSha256,
			category: a.category,
			terminal: a.terminal,
		})),
	};
	const deviationsJson = `${JSON.stringify(deviations, null, 2)}\n`;

	// Stage (writes go ONLY under the staging directory), verify, commit.
	const stagingName = options.stagingName ?? (() => randomUUID().slice(0, 8));
	let staging = "";
	let stagingStat: { dev: number; ino: number } | null = null;
	/**
	 * Creation-time identity records of every staging entry this
	 * invocation created (root + all populated entries). The
	 * end-of-population snapshot is the authoritative superset; until it
	 * exists, a failure mid-population cleans up exactly these owned
	 * entries and nothing else.
	 */
	const stagingTree: Map<string, { dev: number; ino: number; isDir: boolean }> = new Map();
	let evidenceOwned = false;
	let manifestOwned = false;
	let evidenceDirStat: { dev: number; ino: number } | null = null;
	let manifestStat: { dev: number; ino: number } | null = null;
	/** Identity snapshot of the invocation-owned staged tree (captured before the atomic move). */
	let evidenceTree: Map<string, { dev: number; ino: number; isDir: boolean }> | null = null;
	try {
		try {
			await mkdir(runsDir, { recursive: true });
		} catch {
			throw new NroV2PrepareError("IO_ERROR", `runs root "${safeErrorValue(basename(runsDir))}" cannot be created`);
		}
		// Exclusive NON-recursive staging creation directly under the
		// (already created) runs root: EEXIST means a foreign path already
		// occupies the candidate — the candidate is NEVER reused, touched
		// or deleted; a fresh candidate is retried, and ownership
		// (device+inode) is captured immediately after the exclusive
		// create. Exhausted candidates fail closed.
		let stagingCreated = false;
		for (let attempt = 0; attempt < STAGING_CREATE_RETRIES; attempt += 1) {
			const suffix = stagingName();
			// Fail closed on an unsafe candidate BEFORE any path join: an
			// empty, traversal, separator, control or overlong suffix can
			// never escape the runs root or be echoed.
			validateStagingSuffixV2(suffix);
			const candidate = join(runsDir, `${STAGING_PREFIX}${suffix}`);
			try {
				await mkdir(candidate);
			} catch (error) {
				if (fsErrorCode(error) === "EEXIST") continue;
				throw new NroV2PrepareError("IO_ERROR", "staging directory cannot be created");
			}
			try {
				const st = await stat(candidate);
				staging = candidate;
				stagingStat = { dev: st.dev, ino: st.ino };
				stagingTree.set("", { dev: st.dev, ino: st.ino, isDir: true });
				stagingCreated = true;
				break;
			} catch {
				throw new NroV2PrepareError("IO_ERROR", "staging directory cannot be inspected after creation");
			}
		}
		if (!stagingCreated) {
			throw new NroV2PrepareError("IO_ERROR", "staging directory cannot be created (every candidate collides with an existing path)");
		}
		await copyFixtureTreeV2(join(inputsDir, FIXTURE_DIR_NAME), join(staging, FIXTURE_DIR_NAME), stagingTree, FIXTURE_DIR_NAME);
		await writeFile(join(staging, MILESTONE_PROMPT_NAME), inputs.milestonePromptRaw);
		await recordStagingEntryV2(stagingTree, MILESTONE_PROMPT_NAME, join(staging, MILESTONE_PROMPT_NAME));
		await writeFile(join(staging, ENVIRONMENT_NAME), inputs.environmentRaw);
		await recordStagingEntryV2(stagingTree, ENVIRONMENT_NAME, join(staging, ENVIRONMENT_NAME));
		await writeFile(join(staging, RUBRIC_NAME), inputs.rubricRaw);
		await recordStagingEntryV2(stagingTree, RUBRIC_NAME, join(staging, RUBRIC_NAME));
		await writeFile(join(staging, COLLECTION_RECORD_NAME), recordRaw);
		await recordStagingEntryV2(stagingTree, COLLECTION_RECORD_NAME, join(staging, COLLECTION_RECORD_NAME));
		for (const s of sources) {
			const kindDir = s.kind === "session" ? "sessions" : "attempts";
			const relDir = `${kindDir}/${s.label}`;
			const dest = join(staging, kindDir, s.label, s.basename);
			await mkdir(dirname(dest), { recursive: true });
			await recordStagingEntryV2(stagingTree, relDir, join(staging, relDir));
			await recordStagingEntryV2(stagingTree, kindDir, join(staging, kindDir));
			await writeFile(dest, s.raw);
			await recordStagingEntryV2(stagingTree, `${relDir}/${s.basename}`, dest);
		}
		await writeFile(join(staging, DEVIATIONS_NAME), deviationsJson, "utf8");
		await recordStagingEntryV2(stagingTree, DEVIATIONS_NAME, join(staging, DEVIATIONS_NAME));

		// Verify every staged byte before anything is committed.
		const stagedFixture = await fixtureManifestHash(join(staging, FIXTURE_DIR_NAME));
		if (stagedFixture.manifestSha256 !== (protocol.fixtureManifestSha256 as string)) {
			throw new NroV2PrepareError("STAGE_VERIFY", "staged fixture tree does not reproduce the frozen fixture manifest hash");
		}
		if (sha256Hex(await readFile(join(staging, MILESTONE_PROMPT_NAME))) !== (protocol.milestonePromptSha256 as string)) {
			throw new NroV2PrepareError("STAGE_VERIFY", "staged milestone-prompt.txt is not byte-identical to the frozen prompt");
		}
		if ((await readFile(join(staging, ENVIRONMENT_NAME), "utf8")) !== canonicalEnvironmentFile(protocol.environment)) {
			throw new NroV2PrepareError("STAGE_VERIFY", "staged environment.txt is not the canonical pinned environment file");
		}
		if (sha256Hex(await readFile(join(staging, RUBRIC_NAME))) !== (protocol.rubricSha256 as string)) {
			throw new NroV2PrepareError("STAGE_VERIFY", "staged rubric.json is not byte-identical to the frozen rubric");
		}
		if (!(await readFile(join(staging, COLLECTION_RECORD_NAME))).equals(recordRaw)) {
			throw new NroV2PrepareError("STAGE_VERIFY", "staged collection record is not byte-identical to the collection record");
		}
		for (const s of sources) {
			const staged = await readFile(join(staging, s.kind === "session" ? "sessions" : "attempts", s.label, s.basename));
			if (!staged.equals(s.raw)) {
				throw new NroV2PrepareError("STAGE_VERIFY", `staged copy of source "${s.label}" is not byte-identical to the source file`);
			}
		}

		// Capture the identities (device+inode) of the full staged tree —
		// rename preserves them, so the committed tree is rolled back by
		// these same identities: only entries still matching are removed.
		evidenceTree = await captureTreeIdentitiesV2(staging);

		// Re-check BOTH final outputs immediately before the commits: a
		// racing foreign output that appeared since preflight is refused
		// (never overwritten). Only ENOENT means absent. The exclusive
		// creates below are the actual no-clobber guarantee — these
		// re-checks only classify the common pre-existing case early.
		await hooks?.beforeEvidenceCommit?.();
		await assertOutputAbsentV2(evidenceDirPath, "v2 NRO evidence directory");
		await assertOutputAbsentV2(manifestPath, "v2 NRO manifest");

		// Commit 1: EXCLUSIVELY reserve the evidence directory with a
		// NON-recursive mkdir (EEXIST refuses any pre-existing or racing
		// output, including a racing EMPTY foreign directory that a rename
		// would silently replace). Ownership is marked immediately after
		// the exclusive create and the identity is captured for the
		// ownership-verified rollback (re-captured after the move).
		try {
			await mkdir(evidenceDirPath);
		} catch (error) {
			if (fsErrorCode(error) === "EEXIST") {
				throw new NroV2PrepareError("EXISTING_OUTPUT", `v2 NRO evidence directory ${basename(evidenceDirPath)} appeared during commit — refusing to overwrite`);
			}
			throw error;
		}
		evidenceOwned = true;
		const reservedStat = await stat(evidenceDirPath);
		evidenceDirStat = { dev: reservedStat.dev, ino: reservedStat.ino };
		await hooks?.afterEvidenceReserve?.();

		// Move the staged tree into the invocation-owned directory (POSIX
		// rename replaces the empty directory we exclusively created; a
		// racing foreign entry inside makes the rename fail — ENOTEMPTY —
		// and fails closed). The post-move identity is re-captured.
		try {
			await rename(staging, evidenceDirPath);
		} catch (error) {
			if (fsErrorCode(error) === "EEXIST" || fsErrorCode(error) === "ENOTEMPTY" || fsErrorCode(error) === "ENOTDIR") {
				throw new NroV2PrepareError("EXISTING_OUTPUT", `v2 NRO evidence directory ${basename(evidenceDirPath)} appeared during commit — refusing to overwrite`);
			}
			throw error;
		}
		const movedStat = await stat(evidenceDirPath);
		evidenceDirStat = { dev: movedStat.dev, ino: movedStat.ino };
		// The staging PATH's ownership ends with the atomic move: a
		// foreign path that later appears at the old staging name is never
		// this invocation's and must never be deleted.
		staging = "";
		stagingStat = null;
		await hooks?.afterEvidenceCommit?.();

		// Commit 2: the strict manifest via an EXCLUSIVE open("wx") —
		// EEXIST means a pre-existing or racing foreign manifest occupies
		// the path and is refused, never overwritten. Ownership is marked
		// after the open; the bytes are then written, synced and closed,
		// and any failure — including a failure while writing — rolls the
		// owned manifest back.
		try {
			await assertOutputAbsentV2(manifestPath, "v2 NRO manifest");
			const handle = await open(manifestPath, "wx");
			manifestOwned = true;
			const openedStat = await handle.stat();
			manifestStat = { dev: openedStat.dev, ino: openedStat.ino };
			try {
				await hooks?.afterManifestOpen?.();
				await handle.writeFile(manifestJson, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (fsErrorCode(error) === "EEXIST") {
				throw new NroV2PrepareError("EXISTING_OUTPUT", `v2 NRO manifest ${basename(manifestPath)} appeared during commit — refusing to overwrite`);
			}
			throw error;
		}
		await hooks?.afterManifestCommit?.();

		// Post-commit verification: committed manifest byte-identity and
		// committed fixture tree hash (the rename was atomic — this
		// re-checks the committed bytes).
		const writtenManifest = await readFile(manifestPath, "utf8");
		if (writtenManifest !== manifestJson) {
			throw new NroV2PrepareError("STAGE_VERIFY", "committed manifest content is not byte-identical to the generated manifest");
		}
		const committedFixture = await fixtureManifestHash(join(evidenceDirPath, FIXTURE_DIR_NAME));
		if (committedFixture.manifestSha256 !== (protocol.fixtureManifestSha256 as string)) {
			throw new NroV2PrepareError("STAGE_VERIFY", "committed fixture tree does not reproduce the frozen fixture manifest hash");
		}
	} catch (error) {
		// Fail closed: remove the staging directory and ONLY the outputs
		// this invocation established ownership of, each removed only
		// while it is STILL this invocation's (device+inode identity):
		//   - the staging directory is removed only while its current
		//     identity still matches the exclusively created one, and
		//     then only via identity-verified NON-recursive tree removal
		//     (each recorded entry removed deepest-first while its
		//     identity still matches — foreign children and replacements
		//     always survive) — a foreign pre-existing, racing or
		//     replacement path at the staging name is never deleted
		//     (after the atomic move the old staging path no longer
		//     exists and its ownership was cleared);
		//   - each committed evidence-tree entry is removed DEEPEST FIRST
		//     with NON-recursive removal while its current identity still
		//     matches the pre-move snapshot — a foreign replacement of
		//     any known top-level child, or any foreign nested/unknown
		//     child injected inside an otherwise-owned root, survives
		//     while invocation-owned siblings are still cleaned; the
		//     owned evidence directory itself is rmdir'ed last, so only
		//     an empty directory is ever removed;
		//   - the manifest is unlinked only while it is still the file
		//     the exclusive open created.
		// Pre-existing or racing foreign outputs — and foreign replacements
		// of an owned path — are never deleted.
		if (stagingStat !== null && staging.length > 0) {
			try {
				const now = await stat(staging);
				if (now.dev === stagingStat.dev && now.ino === stagingStat.ino) {
					// Identity/tree-safe removal — NEVER recursive deletion:
					// only entries whose current device+inode still match
					// this invocation's records are removed, deepest first
					// and non-recursively, so a foreign replacement of any
					// recorded entry and any foreign child injected at any
					// level always survive. The end-of-population snapshot
					// is the authoritative record when available; before it
					// exists (a failure during population), the
					// creation-time identity records cover exactly the
					// paths this invocation created.
					await removeOwnedTreeEntriesV2(staging, evidenceTree ?? stagingTree);
					await rmdir(staging).catch(() => {});
				}
			} catch {
				// ENOENT (already moved) or unreadable — never delete a
				// path whose ownership cannot be verified as this
				// invocation's.
			}
		}
		if (evidenceOwned && evidenceDirStat && evidenceTree) {
			try {
				const now = await stat(evidenceDirPath);
				if (now.dev === evidenceDirStat.dev && now.ino === evidenceDirStat.ino) {
					// Identity-verified tree removal (shared with staging
					// cleanup): only entries still matching the pre-move
					// snapshot are removed, deepest first, non-recursively.
					await removeOwnedTreeEntriesV2(evidenceDirPath, evidenceTree);
					await rmdir(evidenceDirPath).catch(() => {});
				}
			} catch {
				// Already gone or unreadable — never delete a path whose
				// ownership cannot be verified as this invocation's.
			}
		}
		if (manifestOwned && manifestStat) {
			try {
				const now = await stat(manifestPath);
				if (now.dev === manifestStat.dev && now.ino === manifestStat.ino) {
					await rm(manifestPath, { force: true });
				}
			} catch {
				// Already gone or unreadable — never delete a manifest whose
				// ownership cannot be verified as this invocation's.
			}
		}
		throw error;
	}

	return { evidenceDir: evidenceDirPath, manifestPath, manifest, record, sessions, attempts };
}

// ---------------------------------------------------------------------------
// CLI (protocol-v2 §5) — exit 0 success/help, 1 fail-closed (stderr only,
// no partial stdout), 2 usage error
// ---------------------------------------------------------------------------

function usageV2Prepare(): string {
	return [
		"commander-native-tool-benchmark-v2 — NRO protocol-v2 offline prepare (fail-closed, exclusive commit, offline)",
		"",
		"usage:",
		"  tsx scripts/commander-native-tool-benchmark-v2-prepare.ts prepare --inputs <dir> --collection <file> [--runs-dir <dir>]",
		"  tsx scripts/commander-native-tool-benchmark-v2-prepare.ts --help",
		"",
		"prepare — offline v2 evidence preparation (schema_version/protocol_version 2, machine facts only):",
		"  --inputs <dir>       frozen v2 inputs directory (fixture/, milestone-prompt.txt, environment.txt, rubric.json)",
		"  --collection <file>  immutable schema-2 collection record (chronological log of every retained attempt and session)",
		"  --runs-dir <dir>     evidence/manifest runs root (default: <cwd>/.pi/workbench/runs)",
		"  preflights everything read-only first (pins, environment, rubric, record, sources); refuses existing/racing outputs;",
		"  writes only: <runs-dir>/commander-native-tool-benchmark-v2/ (byte-exact copies) + the strict v2 manifest",
		"  never: model calls, network, shell, provider/cache/session state, repository source files",
		"",
		"exit codes: 0 success | 1 any fail-closed error (stderr only, no partial stdout) | 2 usage error",
	].join("\n");
}

export interface PrepareV2CliArgs {
	help: boolean;
	/** null => usage error. */
	inputsDir: string | null;
	/** null => usage error. */
	collectionFile: string | null;
	runsDir: string;
}

/**
 * Strict `prepare` option parsing: --inputs/--collection required,
 * --runs-dir optional, no repeated options, no positional arguments;
 * unknown/missing/duplicate options are usage errors (nothing is
 * echoed). --help/-h anywhere wins.
 */
export function parsePrepareV2Args(argv: readonly string[]): PrepareV2CliArgs {
	let runsDir = join(process.cwd(), ".pi", "workbench", "runs");
	let inputsDir: string | null = null;
	let collectionFile: string | null = null;
	const seen = new Set<string>();
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string;
		if (arg === "--help" || arg === "-h") return { help: true, inputsDir: null, collectionFile: null, runsDir };
		if (arg === "--inputs" || arg === "--collection" || arg === "--runs-dir") {
			if (seen.has(arg)) return { help: false, inputsDir: null, collectionFile: null, runsDir };
			seen.add(arg);
			const value = argv[i + 1];
			if (value === undefined) return { help: false, inputsDir: null, collectionFile: null, runsDir };
			if (arg === "--inputs") inputsDir = value;
			else if (arg === "--collection") collectionFile = value;
			else runsDir = value;
			i += 1;
			continue;
		}
		return { help: false, inputsDir: null, collectionFile: null, runsDir };
	}
	if (inputsDir === null || collectionFile === null) return { help: false, inputsDir: null, collectionFile: null, runsDir };
	return { help: false, inputsDir, collectionFile, runsDir };
}

/**
 * Deterministic bounded rendering caps over the actual newline-joined
 * form: the UTF-8 byte budget counts the "\n" separator bytes of
 * `out.join("\n")` exactly, and the line budget counts whole kept lines.
 * On overflow the result always carries an explicit marker line
 * (byte-truncated when the caller cap cannot hold the full marker):
 * trailing kept lines are removed — one, or as many as needed — until
 * the marker fits, so a truncated output is never silently returned
 * unmarked. The result is always <= maxLines lines, stays within
 * maxBytes and is deterministic. Degenerate caller caps (non-finite or
 * <= 0 lines/bytes) fail closed to the empty output.
 */
export function applyCapsV2Prepare(lines: readonly string[], maxLines: number, maxBytes: number): string[] {
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
				// A single oversized first line: emit a truncated prefix
				// before the marker when both fit, else the marker alone.
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
			// returned.
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

export function renderPrepareSummaryV2(result: PrepareV2Result): string[] {
	const m = result.manifest;
	const lines = [
		"commander-native-tool-benchmark-v2 prepare: evidence committed (offline, machine facts only)",
		`  evidence dir : ${EVIDENCE_DIR_NAME}/ (fixture + 4 frozen inputs + ${result.sessions.length} sessions + ${result.attempts.length} attempts, byte-exact copies)`,
		`  manifest     : ${MANIFEST_NAME} (schema ${m.schemaVersion}, protocol ${m.protocolVersion}, phase ${m.phase}, ${m.sessions.length} sessions, ${m.attempts.length} attempts; paths relative to the runs root)`,
		`  fixture      : manifest sha256 ${m.fixture.manifestSha256} | prompt sha256 ${m.milestonePromptSha256} | non-treatment sha256 ${m.nonTreatmentSha256} | rubric sha256 ${m.rubric.sha256}`,
	];
	for (const attempt of result.attempts) {
		lines.push(`attempt ${attempt.label} | [${attempt.arm}] category ${attempt.category} | prompt ${attempt.promptSha256 ?? "null"} | raw ${attempt.rawSha256} | basename ${attempt.sessionBasename}`);
	}
	lines.push("privacy : hashes, labels, basenames and bounded machine facts only — never message bodies, tool arguments, thinking, or absolute paths");
	// Reserve one UTF-8 byte for the CLI's final newline: the CLI emits
	// `${line}\n` for every line, so the ACTUAL emitted form is
	// `lines.join("\n") + "\n"` — capping the joined lines one byte
	// under HUMAN_MAX_BYTES guarantees the emitted output (including its
	// final newline) never exceeds the declared cap.
	return applyCapsV2Prepare(lines, HUMAN_MAX_LINES, HUMAN_MAX_BYTES - 1);
}

/** Structured error-code allowlist shape: bounded safe uppercase identifiers. */
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Fixed generic form for untrusted throwables — details are always withheld. */
const GENERIC_WITHHELD = "PREPARE_ERROR: unexpected failure (details withheld — see privacy boundary)";

/**
 * Privacy-safe CLI error rendering: only trusted structured error
 * families render their sanitized bounded messages — recognized by
 * ACTUAL CLASS IDENTITY (instanceof NroV2PrepareError, NroV2Error,
 * V2PolicyError or NroError), never by a spoofable `name` string — and
 * only when they carry an allowlisted bounded uppercase code. A
 * plain/arbitrary Error — even one with BOTH a forged safe-looking code
 * and a forged trusted-looking `name` — and any Error with an unsafe
 * code collapse to the fixed generic withheld-details form, so no
 * untrusted message is ever revealed. No arbitrary coded Error can
 * cause unbounded, control-character or leaking stderr.
 */
export function renderCliErrorV2Prepare(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as { code?: unknown }).code;
		const safeCode = typeof code === "string" && ERROR_CODE_RE.test(code) ? code : null;
		const trusted =
			error instanceof NroV2PrepareError || error instanceof NroV2Error || error instanceof V2PolicyError || error instanceof NroError;
		if (trusted && safeCode !== null) {
			return `${safeCode}: ${boundedDisplay(error.message, ERROR_MAX_BYTES).text}`;
		}
	}
	return GENERIC_WITHHELD;
}

async function mainPrepareV2(args: readonly string[]): Promise<number> {
	const parsed = parsePrepareV2Args(args);
	if (parsed.help) {
		process.stdout.write(`${usageV2Prepare()}\n`);
		return 0;
	}
	if (parsed.inputsDir === null || parsed.collectionFile === null) {
		process.stderr.write(`${usageV2Prepare()}\n`);
		return 2;
	}
	try {
		const result = await prepareEvidenceV2({ runsDir: parsed.runsDir, inputsDir: parsed.inputsDir, collectionFile: parsed.collectionFile });
		for (const line of renderPrepareSummaryV2(result)) process.stdout.write(`${line}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`commander-native-tool-benchmark-v2 prepare: ${renderCliErrorV2Prepare(error)}\n`);
		return 1;
	}
}

export async function mainV2(argv: readonly string[]): Promise<number> {
	const subcommand = argv[0];
	if (subcommand === undefined) {
		process.stderr.write(`${usageV2Prepare()}\n`);
		return 2;
	}
	if (subcommand === "--help" || subcommand === "-h") {
		process.stdout.write(`${usageV2Prepare()}\n`);
		return 0;
	}
	if (subcommand === "prepare") return mainPrepareV2(argv.slice(1));
	process.stderr.write(`commander-native-tool-benchmark-v2: unknown subcommand "${safeErrorValue(subcommand)}"\n${usageV2Prepare()}\n`);
	return 2;
}

// Run only when executed directly (tsx scripts/commander-native-tool-benchmark-v2-prepare.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const exitCode = await mainV2(process.argv.slice(2));
	process.exit(exitCode);
}
