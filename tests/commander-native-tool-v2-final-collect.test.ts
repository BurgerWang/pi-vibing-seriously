/**
 * Hermetic unit tests for the NRO protocol-v2 FINAL collector
 * (`scripts/commander-native-tool-v2-final-collect.ts`): the pure
 * contract slice (constants, plan, naming, argv/env, capped capture,
 * frozen final-session classifier), the read-only non-treatment bundle
 * hash (`nonTreatmentBundleHashV2`), the read-only inputs preflight
 * (`preflightInputsForCollectorV2`), the read-only system/runtime
 * preflight (`preflightSystemForCollectorV2`), the direct-spawn
 * attempt runner (`createSpawnAttemptRunnerV2`) and the schema-2
 * persistence core (canonical initial record
 * `buildInitialCollectionRecordV2`, exclusive storage initialization
 * `initializeCollectionStorageV2`, atomic record updates
 * `writeCollectionRecordV2`, the retained-source persistence
 * helpers `retainRawSourceV2` / `removeOwnedRetainedSourceV2`, and the
 * attempt-session lifecycle `createAttemptSessionStorageV2` /
 * `locateProducedSessionV2` / `removeOwnedAttemptSessionV2`) and the
 * FINAL collection loop (`collectFinalV2`) — the exported orchestration
 * that composes the preflights, storage, runner, classifier and
 * lifecycle under the fixed ABBA 40-valid / 60-started accounting,
 * including the fixed bounded privacy-safe `onDiagnostic` diagnostics
 * (one fixed line per representable invalid attempt and per anomalous
 * valid attempt — never affecting verdicts or the record).
 *
 * The pure contract slice performs no I/O and starts no subprocess;
 * importing the module never has side effects and never runs the
 * guarded CLI or the collection (the runner's spawn, the preflight's
 * fs/runtime reads and `main` run ONLY when called / directly
 * executed — the path-exact direct-execution guard fires only when
 * the module IS the executed script). The bundle-hash and preflight components read the
 * filesystem ONLY when called, so their tests use throwaway temp
 * roots (never the real project tree — except read-only passes over
 * the frozen real bundle copy and the real package.json pin) and
 * cover the exact deterministic rows/hash, order independence, nested
 * POSIX paths, counts/bytes, no-follow rejection of every symlink and
 * non-regular entry, the frozen bounds (via narrowly injected test
 * bounds), and privacy (errors/results never expose the root path,
 * absolute paths, raw fs error text or file content). The persistence
 * core is the ONLY writing part: its tests confine every
 * mkdir/open/write/link/unlink to throwaway temp roots (never the
 * real production runs root), create no production v2 output/evidence
 * and never invoke Pi/provider/model/network.
 *
 * Covered contract:
 *   - constants: FINAL_V2_VALID_SESSIONS = 40 and FINAL_V2_MAX_ATTEMPTS
 *     = 60, structurally tied to the frozen v2 protocol cohort
 *     (TOTAL_VALID_RUNS / MAX_PAID_ATTEMPTS), and OUTPUT_ROOT_NAME_V2
 *     tied to the independent v2 collection root — never the v1 root;
 *   - fixedPlanV2: exactly abbaArmAtV2(1..40) — ABBA repeated ten
 *     times, 20 sessions per arm, deterministic across calls;
 *   - naming: zero-padded labels at every boundary (01/09/10/60),
 *     deterministic `nro-v2-final-<NN>-<arm>` v2 identity (never the
 *     v1 `nro-final-` prefix), raw source and session-dir names;
 *   - buildAttemptArgvV2: exact 16-token order with pinned
 *     model/thinking and the prompt as the SOLE positional; env with
 *     undefined filtered and the two pins forced; control/treatment
 *     parity — argv differs ONLY in the caller-supplied extension
 *     path, session dir and arm-carrying name, env identical;
 *   - createCappedCaptureV2: invalid caps rejected, zero cap, exact
 *     fit, overflow, split appends identical to a single append,
 *     multibyte truncation on code-point boundaries (including chars
 *     split across appends), frozen stability after overflow;
 *   - classifyFinalSessionV2: the exact frozen v2 derive/full-validity
 *     chain over the own raw SHA and the pinned prompt/env — valid,
 *     the six invalid categories and their frozen priority, malformed
 *     and full-validity failures collapsing to the fixed privacy-safe
 *     unrepresentable detail, diagnostic-only process facts, own-byte
 *     hashing, and privacy (errors/raw bytes/paths never surface);
 *   - nonTreatmentBundleHashV2 (temp roots only): deterministic sorted
 *     rows `rel:sha256\n` over exactly the four frozen roots
 *     (AGENTS.md, skills/, prompts/, templates/), creation-order
 *     independence, nested POSIX paths, file counts and total bytes,
 *     byte changes altering the hash, empty dirs allowed, missing /
 *     wrong-type roots, no-follow symlink rejection (root file, root
 *     dirs, nested files, nested dirs), FIFO/non-regular rejection
 *     when the platform supports it, frozen bounds via narrowly
 *     injectable overrides, control-character paths, and privacy-safe
 *     fixed NroV2FinalCollectError messages;
 *   - preflightInputsForCollectorV2 (temp copies of the frozen v2
 *     inputs tree, plus one read-only pass over the real frozen tree):
 *     success reproduces every frozen pin, raw byte and ordered check;
 *     every protocol pin/environment drift fails closed
 *     (PROTOCOL_UNFROZEN) BEFORE any filesystem access; the inputs
 *     root and each child symlink/type/missing/extra rejection
 *     (no-follow, shape before content); prompt, fixture, environment
 *     and rubric drift; the strict schema-2 rubric parse — malformed
 *     JSON, unknown keys, schema version, count/order, id, pattern,
 *     duplicate, missing keys and wrong types — always before the raw
 *     hash pin; size bounds (prompt/rubric <= SESSION_MAX_BYTES,
 *     environment <= the exact canonical bytes); no extra environment
 *     newline; privacy/control-safe fixed errors that never render
 *     roots, absolute paths, raw fs text or content; and no writes,
 *     no output roots and no calls;
 *   - buildInitialCollectionRecordV2 (pure): the canonical exact
 *     schema-2 empty final record (schema_version/protocol_version 2,
 *     the frozen protocol_doc, phase final, the four frozen pins, the
 *     pinned environment, empty entries), byte-exact canonical
 *     roundtrip and determinism; the explicit frozen protocol is
 *     identical to the default; every pin/environment/cohort drift
 *     fails closed PROTOCOL_UNFROZEN before anything is built with
 *     the fixed privacy-safe message;
 *   - initializeCollectionStorageV2 (temp roots only): exclusive
 *     non-recursive root/sources/record creation with byte-exact
 *     canonical read-back and owned dev+ino+kind identities; frozen
 *     RELATIVE facts only (JSON never exposes absolute plumbing, and
 *     the storage class is constructible only through the module
 *     factory); pre-existing/racing entries refused EXISTING_OUTPUT
 *     and never overwritten; every deterministic hook stage
 *     (afterRootCreate/afterSourcesCreate/afterRecordOpen/
 *     afterRecordCommit/afterRecordReadBack) in order; hook failures
 *     propagate unchanged with identity-aware non-recursive rollback
 *     that preserves foreign replacements and foreign children;
 *     root/sources/record replacement races fail closed STORAGE_IO /
 *     RECORD_IO without touching the foreign entry;
 *   - writeCollectionRecordV2 (temp roots only, hard links required):
 *     strict invalid records rejected RECORD_INVALID before any
 *     write; successful canonical updates with byte-exact publish and
 *     tracked record identity change; committed:false before the
 *     atomic no-clobber publish and committed:true after it; target
 *     reoccupation is never clobbered and the prior record is
 *     preserved/restored; root/target/temp/backup replacement races
 *     injected through the public hooks; foreign temp/backup
 *     replacements survive identity-gated cleanup; sources and
 *     foreign children never disturbed; and privacy — errors and
 *     facts expose only frozen relative names, never absolute roots,
 *     temp UUID/transaction names, raw record content or raw fs text;
 *   - retainRawSourceV2 (temp roots only): the frozen SESSION_MAX_BYTES
 *     cap is enforced BEFORE any filesystem access — cap+1 refused
 *     SOURCE_OVER_BOUND, the exact cap accepted byte-exactly; the
 *     deterministic `sources/raw-<NN>-<arm>.jsonl` destination is
 *     created exclusively (`wx`) with the exact file's handle-derived
 *     identity, byte-exact write/sync/close and read-back; the
 *     retained facts carry only the deterministic name, the relative
 *     path, the raw-byte SHA-256 and the identity — never absolute
 *     plumbing; pre-existing destinations are refused SOURCE_EXISTS
 *     and never overwritten; the three hook stages
 *     (afterSourceOpen/afterSourceCommit/afterSourceVerify) run in
 *     order; every hook failure propagates unchanged after
 *     identity-owned non-recursive cleanup; root/sources/source
 *     replacement and in-place byte replacement at every hook — and
 *     at the post-hook revalidation after afterSourceVerify — fail
 *     closed SOURCE_IO; foreign children and foreign replacements
 *     survive success and cleanup;
 *   - removeOwnedRetainedSourceV2 (temp roots only): the
 *     deterministic source-name AND relative-path validation
 *     precedes every fs gate; identity-only unlink of a currently
 *     matching owned source — removed true, then false, with missing
 *     and foreign sources returning {removed:false} untouched;
 *     root/sources replacement gates fail closed SOURCE_IO without
 *     touching the foreign entry; errors are fixed bounded
 *     privacy-safe messages;
 *   - attempt-session lifecycle (temp roots only):
 *     `createAttemptSessionStorageV2` — attempt validated BEFORE any
 *     filesystem access (0/61/fractions refused ATTEMPT_DIR_IO),
 *     exclusive non-recursive deterministic session-dir create with a
 *     tracked no-follow identity, pre-existing/racing entries refused
 *     ATTEMPT_DIR_EXISTS and never overwritten, the
 *     afterSessionDirCreate hook order and failure propagation with
 *     identity-owned non-recursive rollback, root/dir replacement
 *     races failing closed ATTEMPT_DIR_IO, foreign children and
 *     foreign replacements surviving, brand-gated construction and
 *     relative-only public JSON;
 *     `locateProducedSessionV2` — exactly one direct `.jsonl` entry
 *     with every non-jsonl sibling ignored, zero/multiple
 *     SESSION_FILE_COUNT, symlink/directory/FIFO rejection, the
 *     shared safe-basename contract (control characters rejected and
 *     never rendered), the frozen cap enforced before any read —
 *     cap+1 SESSION_OVER_BOUND and the exact cap read byte-exactly —
 *     both hook stages in order and their failures propagating
 *     unchanged, root/dir/file replacement and grow/shrink/in-place
 *     mutations failing the final identity+size revalidation, exact
 *     raw bytes and handle-derived identity, and fixed bounded
 *     privacy-safe errors;
 *     `removeOwnedAttemptSessionV2` — truthful {removedFile,
 *     removedDir} booleans, identity-only unlink of the matching
 *     produced file and non-recursive rmdir of the still-owned EMPTY
 *     session dir, missing/foreign/nonempty cases returning truthful
 *     false, deterministic association and safe-basename validation
 *     BEFORE every fs gate (forged facts fail closed even against a
 *     replaced root), root/dir replacement gates and foreign
 *     preservation;
 *   - module import has no side effects;
 *   - static guards: imports limited to the v2 core, the v2 protocol,
 *     the v2 POLICY LEAF (V2_RUBRIC_CHECKS value + RubricCheckV2
 *     type only), the eight frozen v1 pure names (parseSessionLines,
 *     sha256Hex, FIXTURE_MAX_FILES, FIXTURE_MAX_BYTES, PATH_MAX_BYTES,
 *     fixtureManifestHash, canonicalEnvironmentFile, SESSION_MAX_BYTES)
 *     and the five allowed node builtins (node:child_process spawn
 *     ONLY, node:crypto randomUUID ONLY, node:fs/promises value with
 *     exactly lstat/readdir/readFile/stat plus the minimal persistence
 *     write surface mkdir/open/writeFile/link/rmdir/unlink, node:fs
 *     type-only, node:path value) plus the read-only global
 *     process.version; no other node builtins, no v1 collector /
 *     classifiers / parsers / adapters / v2 prepare-analyze adapters
 *     / provider imports, no shell, network or
 *     recursive/force-deletion capability, and exactly one direct
 *     spawn call site with shell:false and ignored stdin; the
 *     exclusive persistence surface is exactly three `wx` open call
 *     sites (initial record, record temp, retained source) and
 *     exactly two randomUUID call sites (record temp/backup names).
 *     The loop is declared exactly once and never invoked at module
 *     top level; the ONLY top-level executable statement is the
 *     path-exact direct-execution guard, which runs the CLI (`main`
 *     declared once, invoked once) only when the module IS the
 *     executed script — `process.argv`/`import.meta` appear only
 *     there and no hard `process.exit(` call exists;
 *   - CLI (`main` with injected IO and injected collect): --help/-h
 *     exit 0 with the usage on stdout and nothing on stderr;
 *     unknown/positional argv exit 2 with the FIXED privacy-safe
 *     usage error on stderr (argv is never echoed); no-args default
 *     paths are rooted at process.cwd() with the existing fixed
 *     onDiagnostic lines forwarded to stderr; complete -> 0 with the
 *     exact bounded relative summary; attempts-exhausted -> 1 with
 *     the truthful partial summary; NroV2FinalCollectError (incl.
 *     NroV2RecordWriteError) -> 1 stderr-only prefix+code+message;
 *     unknown errors -> 1 with the single fixed details-withheld
 *     line; the direct-execution guard is exercised only through an
 *     import subprocess from a throwaway temp cwd and a direct
 *     --help subprocess — never a collection, provider, model,
 *     network, prepare or analyze action.
 *
 * The persistence core is the only writing component and is fully
 * covered here; the FINAL collection loop (`collectFinalV2`)
 * is covered hermetically with fake/injected runners and temp roots only. The attempt runner is exercised only
 * with harmless local subprocesses (the test runner's own node binary
 * and temp dirs) — never Pi, provider, model or network — including
 * argv/env/cwd fidelity, exact-fit/overflow caps with raw byte
 * counts, the fixed privacy-safe start-failure fact, the timeout
 * SIGTERM-then-SIGKILL sequence, and settle-once timer cleanup.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, link, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withTempDir } from "./helpers.ts";

import { abbaArmAtV2, collectionRecordToJsonV2, computeRunFactsV2, deriveAttemptFactsV2, parseCollectionRecordV2 } from "../scripts/commander-native-tool-benchmark-v2.ts";
import type { AttemptCategoryV2, CollectionEntryKindV2, CollectionEntryV2, CollectionRecordV2, V2FrozenProtocol } from "../scripts/commander-native-tool-benchmark-v2.ts";
import {
	BENCHMARK_SCHEMA_VERSION,
	COLLECTION_RECORD_NAME,
	COLLECTION_ROOT_NAME,
	COLLECTION_SCHEMA_VERSION,
	ENVIRONMENT_NAME,
	FIXTURE_DIR_NAME,
	FROZEN_ENVIRONMENT,
	FROZEN_NRO_V2_PROTOCOL,
	INPUTS_DIR,
	MAX_PAID_ATTEMPTS,
	MILESTONE_PROMPT_NAME,
	PROTOCOL_DOC,
	PROTOCOL_VERSION,
	RUBRIC_NAME,
	TOTAL_VALID_RUNS,
} from "../scripts/commander-native-tool-benchmark-v2-protocol.ts";
import type { ArmName } from "../scripts/commander-native-tool-benchmark-v2-protocol.ts";
import { V2_RUBRIC_CHECKS } from "../scripts/commander-native-tool-benchmark-v2-policy.ts";
import { canonicalEnvironmentFile, fixtureManifestHash, SESSION_MAX_BYTES } from "../scripts/commander-native-tool-benchmark.ts";
import {
	ATTEMPT_STDOUT_MAX_BYTES_V2,
	ATTEMPT_STDERR_MAX_BYTES_V2,
	ATTEMPT_TIMEOUT_MS_V2,
	AttemptSessionStorageV2,
	BUNDLE_ROOT_ENTRIES_V2,
	CATEGORY_DETAIL_V2,
	CollectionStorageV2,
	CONTROL_ARM_FILE_RELATIVE_V2,
	FINAL_SESSION_BASENAME_V2,
	FINAL_V2_MAX_ATTEMPTS,
	FINAL_V2_VALID_SESSIONS,
	NroV2FinalCollectError,
	NroV2RecordWriteError,
	OUTPUT_ROOT_NAME_V2,
	PACKAGE_JSON_RELATIVE_V2,
	PI_BINARY_RELATIVE_V2,
	SOURCES_DIR_NAME_V2,
	SPAWN_START_FAILED_DETAIL_V2,
	TERMINATE_GRACE_MS_V2,
	TREATMENT_ARM_FILE_RELATIVE_V2,
	UNREPRESENTABLE_DETAIL_V2,
	VALID_DETAIL_V2,
	attemptLabelV2,
	attemptNameV2,
	attemptSessionDirNameV2,
	buildAttemptArgvV2,
	buildAttemptEnvV2,
	buildInitialCollectionRecordV2,
	classifyFinalSessionV2,
	collectFinalV2,
	createAttemptSessionStorageV2,
	createCappedCaptureV2,
	createSpawnAttemptRunnerV2,
	fixedPlanV2,
	initializeCollectionStorageV2,
	locateProducedSessionV2,
	main,
	nonTreatmentBundleHashV2,
	preflightInputsForCollectorV2,
	preflightSystemForCollectorV2,
	rawSourceNameV2,
	removeOwnedAttemptSessionV2,
	removeOwnedRetainedSourceV2,
	renderSummary,
	retainRawSourceV2,
	usage,
	writeCollectionRecordV2,
} from "../scripts/commander-native-tool-v2-final-collect.ts";
import type {
	BundleHashBoundsV2,
	BundleHashResultV2,
	ClassifyFinalSessionV2Result,
	CollectFinalV2Fn,
	CollectFinalV2Hooks,
	CollectFinalV2Options,
	CollectFinalV2Result,
	CreateAttemptSessionStorageV2Hooks,
	FinalIo,
	FrozenInputsFactsForCollectorV2,
	FsIdentityV2,
	InitializeCollectionStorageV2Hooks,
	LocateProducedSessionV2Hooks,
	NroV2FinalCollectErrorCode,
	ProducedSessionV2,
	RetainedSourceV2,
	RetainRawSourceV2Hooks,
	SpawnAttemptRequestV2,
	SpawnAttemptRunnerV2,
	SpawnedAttemptResultV2,
	SystemPreflightFactsV2,
	SystemRuntimeFactsV2,
	WriteCollectionRecordV2Hooks,
} from "../scripts/commander-native-tool-v2-final-collect.ts";

const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "commander-native-tool-v2-final-collect.ts");

// ------------------------------------------------------ preflight fixtures

/** The real frozen v2 inputs tree (read-only; temp copies are made from it). */
const FROZEN_INPUTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", INPUTS_DIR);
/** The exact canonical environment.txt bytes the frozen environment pins. */
const CANONICAL_ENV_TEXT = canonicalEnvironmentFile(FROZEN_ENVIRONMENT);
const CANONICAL_ENV_BYTES = Buffer.byteLength(CANONICAL_ENV_TEXT, "utf8");
/** The frozen checks as plain JSON-able objects (for rubric mutants). */
const FROZEN_CHECK_OBJECTS = V2_RUBRIC_CHECKS.map((c) => ({ ...c }));

/** Byte-copy the frozen v2 inputs tree into a temp dir (frozen pins always apply). */
async function makeInputsTree(root: string): Promise<string> {
	const inputs = join(root, "inputs");
	await cp(FROZEN_INPUTS, inputs, { recursive: true });
	return inputs;
}

/** Expect a preflight rejection with the exact collector error code (and optional exact message). */
async function expectPreflightError(inputsDir: string, code: NroV2FinalCollectErrorCode, message?: string): Promise<void> {
	await assert.rejects(preflightInputsForCollectorV2(inputsDir), (error: unknown) => {
		assert.ok(error instanceof NroV2FinalCollectError, `expected NroV2FinalCollectError, got ${String(error)}`);
		assert.equal(error.code, code);
		assert.equal(error.name, "NroV2FinalCollectError");
		if (message !== undefined) assert.equal(error.message, message);
		return true;
	});
}

/** Snapshot every regular file of a tree as sorted [rel, raw] pairs (for no-writes assertions). */
async function treeSnapshot(rootAbs: string): Promise<Array<[string, Buffer]>> {
	const out: Array<[string, Buffer]> = [];
	const walk = async (dir: string, relPrefix: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const rel = relPrefix.length === 0 ? entry.name : `${relPrefix}/${entry.name}`;
			if (entry.isDirectory()) {
				await walk(join(dir, entry.name), rel);
				continue;
			}
			if (entry.isFile()) out.push([rel, await readFile(join(dir, entry.name))]);
		}
	};
	await walk(rootAbs, "");
	return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ------------------------------------------------------------- classifier data

/** The frozen milestone prompt, read byte-exact from the frozen v2 inputs fixture. */
const PROMPT_TEXT = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", INPUTS_DIR, MILESTONE_PROMPT_NAME), "utf8");
const PROMPT_SHA256 = sha256Hex(PROMPT_TEXT);
/** The frozen rubric-passing final text (same as the v2 core test). */
const RUBRIC_FULL_TEXT = ["build: alpha-42", "unicode: α, 水, 🚀", "token: delta-77", "needle_occurrences: 140", "needle_lines: 135", "needle_files: 4"].join("\n");
/** Secrets that must never surface in results, details or errors. */
const SECRET_CALL_ID = "call-SECRET-9f2c-bb71";
const SECRET_PATH = "/private/secret-dir/SECRET-file-7c4e.txt";
const SECRET_BODY = "NROPRIVATE-TOOLRESULT-1b3d";
const SECRET_THINKING = "NROPRIVATE-THINKING-a5e8";

function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

// Minimal session builders (mirrors of the frozen v2 core test builders).
function userMessage(text: string = PROMPT_TEXT): Record<string, unknown> {
	return { type: "message", id: "m-user", message: { role: "user", content: [{ type: "text", text }] } };
}
function thinkingLevelChange(level: string = FROZEN_ENVIRONMENT.thinkingLevel): Record<string, unknown> {
	return { type: "thinking_level_change", thinkingLevel: level };
}
function assistantMessage(content: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "message",
		id: "m-assistant",
		message: {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			content,
			stopReason: "stop",
			usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.001 } },
			...overrides,
		},
	};
}
function toolCallItem(id: string, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "toolCall", id, name, arguments: args };
}
function toolResultMessage(toolCallId: string, toolName: string, content: unknown, isError?: boolean, usage?: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "message",
		id: `m-${toolCallId}-result`,
		message: {
			role: "toolResult",
			toolName,
			toolCallId,
			content,
			...(isError ? { isError: true } : {}),
			...(usage !== undefined ? { usage } : {}),
		},
	};
}
function markerLine(complete: boolean): string {
	return `nro-read-facts: complete=${complete} returned_lines=10 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`;
}
function attemptCompactionEntry(): Record<string, unknown> {
	return { type: "compaction", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } } };
}
/** A machine-observably valid final session (prompt/env/compaction/terminal). */
function validSessionEntries(): unknown[] {
	return [
		userMessage(),
		thinkingLevelChange(),
		assistantMessage([toolCallItem("c1", "read", { path: "fixture/alpha.txt" })]),
		toolResultMessage("c1", "read", markerLine(false)),
		assistantMessage([toolCallItem("c2", "read", { path: "fixture/alpha.txt", offset: 100 })]),
		toolResultMessage("c2", "read", "legacy continuation content"),
		assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
	];
}
/** JSONL-encode entries into the exact raw Buffer the classifier consumes. */
function rawOf(entries: unknown[]): Buffer {
	return Buffer.from(entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
/** Classify with defaulted classifier input (arm control, label attempt-01, clean process facts). */
function classifyRaw(raw: Buffer, overrides: { arm?: ArmName; label?: string; exitCode?: number | null; timedOut?: boolean } = {}): ClassifyFinalSessionV2Result {
	return classifyFinalSessionV2({
		raw,
		arm: overrides.arm ?? "control",
		label: overrides.label ?? "attempt-01",
		exitCode: overrides.exitCode ?? null,
		timedOut: overrides.timedOut ?? false,
	});
}
/** The exact v2 derive (strict: false) the classifier must reproduce. */
function expectedAttemptFacts(entries: unknown[], raw: Buffer, label: string, arm: ArmName = "control"): ReturnType<typeof deriveAttemptFactsV2> {
	return deriveAttemptFactsV2(label, arm, FINAL_SESSION_BASENAME_V2, sha256Hex(raw), entries, PROMPT_SHA256, FROZEN_NRO_V2_PROTOCOL.environment, { strict: false });
}
/** The exact v2 full-validity run facts (orderIndex 1, fixed basename) the classifier must reproduce. */
function expectedRunFacts(entries: unknown[], raw: Buffer, label: string, arm: ArmName = "control"): ReturnType<typeof computeRunFactsV2> {
	return computeRunFactsV2(label, arm, 1, FINAL_SESSION_BASENAME_V2, sha256Hex(raw), entries, PROMPT_SHA256, FROZEN_NRO_V2_PROTOCOL.environment, { enforceValidity: true });
}

// ------------------------------------------------------------------ constants

test("constants: exactly the v2 40-valid / 60-attempt cohort tied to the frozen v2 protocol", () => {
	assert.equal(FINAL_V2_VALID_SESSIONS, 40);
	assert.equal(FINAL_V2_MAX_ATTEMPTS, 60);
	// structurally tied to the frozen v2 protocol constants — never drift
	assert.equal(FINAL_V2_VALID_SESSIONS, TOTAL_VALID_RUNS);
	assert.equal(FINAL_V2_MAX_ATTEMPTS, MAX_PAID_ATTEMPTS);
	assert.equal(TOTAL_VALID_RUNS, 40);
	assert.equal(MAX_PAID_ATTEMPTS, 60);
});

test("constants: OUTPUT_ROOT_NAME_V2 is the independent v2 collection root, never the v1 root", () => {
	assert.equal(OUTPUT_ROOT_NAME_V2, COLLECTION_ROOT_NAME);
	assert.equal(OUTPUT_ROOT_NAME_V2, "commander-native-tool-v2-final-collection");
	// root independence: distinct from the v1 final-collection root basename
	assert.notEqual(OUTPUT_ROOT_NAME_V2, "commander-native-tool-final-collection");
	assert.ok(OUTPUT_ROOT_NAME_V2.includes("v2"));
});

// ------------------------------------------------------------------ plan

test("fixedPlanV2: exactly ABBA repeated ten times — 40 positions, 20 sessions per arm", () => {
	const plan = fixedPlanV2();
	assert.equal(plan.length, 40);
	assert.equal(plan.length, FINAL_V2_VALID_SESSIONS);
	const expected = Array.from({ length: 40 }, (_, i) => abbaArmAtV2(i + 1));
	assert.deepEqual(plan, expected);
	assert.deepEqual(plan.slice(0, 4), ["control", "treatment", "treatment", "control"]);
	// ABBA period: positions 1..40 repeat with period 4
	for (let i = 0; i < 36; i += 1) assert.equal(plan[i], plan[i + 4]);
	// exactly 20 per arm
	assert.equal(plan.filter((a) => a === "control").length, 20);
	assert.equal(plan.filter((a) => a === "treatment").length, 20);
	// control occupies the 1-based positions (i-1)%4 in {0,3} — 1,4,5,8,...
	assert.deepEqual(plan.filter((_, i) => i % 4 === 0 || i % 4 === 3), Array(20).fill("control"));
	// deterministic across calls
	assert.deepEqual(fixedPlanV2(), plan);
});

// ------------------------------------------------------------------ naming

test("naming: zero-padded labels at every boundary (01/09/10/60)", () => {
	assert.equal(attemptLabelV2(1), "01");
	assert.equal(attemptLabelV2(9), "09");
	assert.equal(attemptLabelV2(10), "10");
	assert.equal(attemptLabelV2(60), "60");
});

test("naming: deterministic v2 identities with the explicit nro-v2-final prefix", () => {
	assert.equal(attemptNameV2(1, "control"), "nro-v2-final-01-control");
	assert.equal(attemptNameV2(9, "treatment"), "nro-v2-final-09-treatment");
	assert.equal(attemptNameV2(10, "control"), "nro-v2-final-10-control");
	assert.equal(attemptNameV2(60, "treatment"), "nro-v2-final-60-treatment");
	assert.equal(rawSourceNameV2(1, "control"), "raw-01-control.jsonl");
	assert.equal(rawSourceNameV2(60, "treatment"), "raw-60-treatment.jsonl");
	assert.equal(attemptSessionDirNameV2(1), ".attempt-01-session");
	assert.equal(attemptSessionDirNameV2(60), ".attempt-60-session");
	// deterministic v2 prefix across the whole attempt range, never the v1 identity
	for (let n = 1; n <= FINAL_V2_MAX_ATTEMPTS; n += 1) {
		for (const arm of ["control", "treatment"] as const) {
			const name = attemptNameV2(n, arm);
			assert.ok(name.startsWith("nro-v2-final-"), name);
			assert.ok(!name.startsWith("nro-final-"), name);
			assert.match(name, /^nro-v2-final-\d{2}-(control|treatment)$/);
		}
	}
	// determinism: repeated calls return identical strings
	assert.equal(attemptNameV2(7, "treatment"), attemptNameV2(7, "treatment"));
	assert.equal(rawSourceNameV2(7, "treatment"), rawSourceNameV2(7, "treatment"));
});

// ------------------------------------------------------------------ argv

test("buildAttemptArgvV2: exact 16-token order, pinned model/thinking, prompt the sole positional", () => {
	const promptText = "milestone prompt line 1\nline 2 --print --approve";
	const argv = buildAttemptArgvV2({
		extensionPath: "/abs/control-extension.ts",
		sessionDir: "/abs/runs/.attempt-07-session",
		attemptNumber: 7,
		arm: "control",
		promptText,
	});
	assert.deepEqual(argv, [
		"--print",
		"--approve",
		"--no-extensions",
		"--extension",
		"/abs/control-extension.ts",
		"--model",
		FROZEN_ENVIRONMENT.modelKey,
		"--thinking",
		FROZEN_ENVIRONMENT.thinkingLevel,
		"--session-dir",
		"/abs/runs/.attempt-07-session",
		"--name",
		"nro-v2-final-07-control",
		"--tools",
		"read,grep",
		promptText,
	]);
	assert.equal(argv.length, 16);
	// the pinned model/thinking come from the frozen v2 environment
	assert.equal(FROZEN_ENVIRONMENT.modelKey, "openai-codex/gpt-5.6-sol");
	assert.equal(FROZEN_ENVIRONMENT.thinkingLevel, "high");
	// the prompt is the SOLE positional: exactly one occurrence, always the last token
	assert.equal(argv.indexOf(promptText), argv.length - 1);
	assert.equal(argv.lastIndexOf(promptText), argv.length - 1);
	assert.equal(argv[argv.length - 1], promptText);
	// deterministic for identical caller input
	assert.deepEqual(
		buildAttemptArgvV2({ extensionPath: "/abs/control-extension.ts", sessionDir: "/abs/runs/.attempt-07-session", attemptNumber: 7, arm: "control", promptText }),
		argv,
	);
});

// ------------------------------------------------------------------ env

test("buildAttemptEnvV2: inherits defined values, filters undefined, forces the two pins", () => {
	const base: NodeJS.ProcessEnv = {
		PATH: "/usr/bin",
		CRED: "secret",
		PI_SKIP_VERSION_CHECK: "0",
		PI_TELEMETRY: "1",
		UNSET: undefined,
	};
	const env = buildAttemptEnvV2(base);
	assert.deepEqual(env, {
		PATH: "/usr/bin",
		CRED: "secret",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
	});
	assert.ok(!("UNSET" in env));
	// empty base still yields exactly the two pins
	assert.deepEqual(buildAttemptEnvV2({}), { PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
});

// ------------------------------------------------------------------ parity

test("arm parity: argv differs only in extension/name/session-dir; env is identical", () => {
	const promptText = "the frozen milestone prompt";
	const controlArgv = buildAttemptArgvV2({
		extensionPath: "/a/control.ts",
		sessionDir: "/runs/a/.attempt-09-session",
		attemptNumber: 9,
		arm: "control",
		promptText,
	});
	const treatmentArgv = buildAttemptArgvV2({
		extensionPath: "/b/treatment.ts",
		sessionDir: "/runs/b/.attempt-09-session",
		attemptNumber: 9,
		arm: "treatment",
		promptText,
	});
	const diffs: number[] = [];
	for (let i = 0; i < controlArgv.length; i += 1) {
		if (controlArgv[i] !== treatmentArgv[i]) diffs.push(i);
	}
	// different extension, session dir and arm/name → exactly the extension
	// value (4), the session dir (10) and the arm-carrying name (12) differ;
	// every other token is arm-identical
	assert.deepEqual(diffs, [4, 10, 12]);
	assert.equal(treatmentArgv[12], "nro-v2-final-09-treatment");
	assert.equal(controlArgv[12], "nro-v2-final-09-control");
	// a different session dir is the third allowed caller difference
	const otherDir = buildAttemptArgvV2({
		extensionPath: "/a/control.ts",
		sessionDir: "/runs/c/.attempt-09-session",
		attemptNumber: 9,
		arm: "control",
		promptText,
	});
	assert.equal(otherDir[10], "/runs/c/.attempt-09-session");
	// env is arm-independent
	const base: NodeJS.ProcessEnv = { PATH: "/bin", HOME: "/root" };
	const env = buildAttemptEnvV2(base);
	assert.deepEqual(env, { PATH: "/bin", HOME: "/root", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
	assert.deepEqual(buildAttemptEnvV2(base), env);
});

// ------------------------------------------------------------------ capped capture

test("createCappedCaptureV2: invalid caps are rejected deterministically", () => {
	for (const bad of [-1, -0.5, 1.5, NaN, Infinity, -Infinity, 2 ** 53]) {
		assert.throws(() => createCappedCaptureV2(bad), RangeError, `cap ${String(bad)} must throw`);
	}
	for (const good of [0, 1, 1024, Number.MAX_SAFE_INTEGER]) {
		assert.doesNotThrow(() => createCappedCaptureV2(good));
	}
});

test("createCappedCaptureV2: zero cap flags any bytes as overflow and stays empty", () => {
	const cap = createCappedCaptureV2(0);
	assert.equal(cap.maxBytes, 0);
	assert.equal(cap.text, "");
	assert.equal(cap.overflowed, false);
	assert.equal(cap.totalBytes, 0);
	cap.append(Buffer.from("abc"));
	assert.equal(cap.text, "");
	assert.equal(cap.overflowed, true);
	assert.equal(cap.totalBytes, 3);
	cap.append(Buffer.from("de"));
	assert.equal(cap.text, "");
	assert.equal(cap.overflowed, true);
	assert.equal(cap.totalBytes, 5);
});

test("createCappedCaptureV2: exact fit keeps the full input without overflow", () => {
	const cap = createCappedCaptureV2(5);
	cap.append(Buffer.from("hello"));
	assert.equal(cap.text, "hello");
	assert.equal(cap.overflowed, false);
	assert.equal(cap.totalBytes, 5);
	cap.append(Buffer.alloc(0));
	assert.equal(cap.text, "hello");
	assert.equal(cap.overflowed, false);
	assert.equal(cap.totalBytes, 5);
});

test("createCappedCaptureV2: overflow hard-caps raw bytes, preserves the exact prefix, counts total bytes", () => {
	const cap = createCappedCaptureV2(5);
	cap.append(Buffer.from("hello world"));
	assert.equal(cap.text, "hello");
	assert.equal(cap.overflowed, true);
	assert.equal(cap.totalBytes, 11);
	assert.ok(Buffer.byteLength(cap.text, "utf8") <= 5);
});

test("createCappedCaptureV2: split appends match a single append at the cap boundary", () => {
	const single = createCappedCaptureV2(7);
	single.append(Buffer.from("abcdefghij"));
	const split = createCappedCaptureV2(7);
	split.append(Buffer.from("abcd"));
	split.append(Buffer.from("efghij"));
	assert.equal(split.text, single.text);
	assert.equal(split.text, "abcdefg");
	assert.equal(split.overflowed, true);
	assert.equal(single.overflowed, true);
	assert.equal(split.totalBytes, 10);
	assert.equal(single.totalBytes, 10);
});

test("createCappedCaptureV2: multibyte UTF-8 never truncates inside a code point", () => {
	// "héllo" is 6 raw bytes (é = 2 bytes); a 2-byte cap cuts inside é → "h", never a replacement char
	const cap = createCappedCaptureV2(2);
	cap.append(Buffer.from("héllo", "utf8"));
	assert.equal(cap.text, "h");
	assert.equal(cap.overflowed, true);
	assert.equal(cap.totalBytes, 6);
	// a 6-byte stream into a 3-byte cap overflows even though the captured
	// prefix ends exactly on a code-point boundary
	const exact = createCappedCaptureV2(3);
	exact.append(Buffer.from("héllo", "utf8"));
	assert.equal(exact.text, "hé");
	assert.equal(exact.overflowed, true);
	assert.equal(exact.totalBytes, 6);
	// a char split across two appends decodes correctly (concat, not per-chunk, decode)
	const splitChar = createCappedCaptureV2(16);
	splitChar.append(Buffer.from([0xc3]));
	splitChar.append(Buffer.from([0xa9, 0x21]));
	assert.equal(splitChar.text, "é!");
	assert.equal(splitChar.overflowed, false);
	assert.equal(splitChar.totalBytes, 3);
	// a char split across appends with the cap landing inside it truncates before the char
	const straddle = createCappedCaptureV2(1);
	straddle.append(Buffer.from([0xc3]));
	straddle.append(Buffer.from([0xa9]));
	assert.equal(straddle.text, "");
	assert.equal(straddle.overflowed, true);
	assert.equal(straddle.totalBytes, 2);
});

test("createCappedCaptureV2: frozen after overflow — text stable, total bytes keep counting", () => {
	const cap = createCappedCaptureV2(4);
	cap.append(Buffer.from("abcdef"));
	assert.equal(cap.text, "abcd");
	assert.equal(cap.overflowed, true);
	assert.equal(cap.totalBytes, 6);
	const first = cap.text;
	cap.append(Buffer.from("ghijkl"));
	cap.append(Buffer.from("mnop"));
	assert.equal(cap.text, first);
	assert.equal(cap.text, "abcd");
	assert.equal(cap.overflowed, true);
	assert.equal(cap.totalBytes, 16);
	// repeated reads are stable and deterministic
	assert.equal(cap.text, cap.text);
});

test("createCappedCaptureV2: append rejects non-byte input without corrupting state", () => {
	const cap = createCappedCaptureV2(8);
	assert.throws(() => cap.append("text" as unknown as Uint8Array), TypeError);
	assert.equal(cap.totalBytes, 0);
	assert.equal(cap.text, "");
	assert.equal(cap.overflowed, false);
});

// ------------------------------------------------------------- classifier: pins

test("classifier fixture: the frozen milestone prompt reproduces the frozen v2 prompt pin", () => {
	assert.equal(PROMPT_SHA256, FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256);
	assert.equal(PROMPT_SHA256.length, 64);
	assert.ok(PROMPT_TEXT.length > 0);
});

// ----------------------------------------------------------- classifier: valid

test("classifyFinalSessionV2: a fully valid raw is a valid session with the exact v2 chain facts", () => {
	for (const arm of ["control", "treatment"] as const) {
		const entries = validSessionEntries();
		const raw = rawOf(entries);
		const label = arm === "control" ? "nro-v2-final-01-control" : "nro-v2-final-02-treatment";
		const result = classifyFinalSessionV2({ raw, arm, label, exitCode: null, timedOut: false });
		assert.equal(result.verdict, "valid");
		assert.equal(result.detail, VALID_DETAIL_V2);
		assert.equal(result.attemptFacts, null);
		assert.ok(result.runFacts !== null);
		assert.deepEqual(result.runFacts, expectedRunFacts(entries, raw, label, arm));
		assert.equal(result.runFacts.orderIndex, 1);
		assert.equal(result.runFacts.sessionBasename, FINAL_SESSION_BASENAME_V2);
		assert.equal(result.runFacts.sessionSha256, sha256Hex(raw));
		assert.equal(result.runFacts.promptMatches, true);
		assert.equal(result.runFacts.label, label);
		assert.equal(result.runFacts.arm, arm);
		assert.equal(result.exitCode, null);
		assert.equal(result.timedOut, false);
	}
});

// ------------------------------------------------------- classifier: categories

test("classifyFinalSessionV2: the six frozen categories return invalid with the fixed category detail", () => {
	const cases: Array<{ name: string; entries: unknown[]; category: Exclude<AttemptCategoryV2, "unclassified"> }> = [
		{ name: "wrong prompt hash", entries: [userMessage("a different prompt"), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])], category: "prompt_mismatch" },
		{ name: "model drift", entries: [userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { model: "gpt-4o" })], category: "env_drift" },
		{ name: "thinking drift", entries: [userMessage(), thinkingLevelChange("low"), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])], category: "env_drift" },
		{ name: "compaction", entries: [userMessage(), thinkingLevelChange(), attemptCompactionEntry(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])], category: "compaction_present" },
		{ name: "terminal abort", entries: [userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })], category: "aborted" },
		{ name: "terminal error", entries: [userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "error" })], category: "errored" },
		{ name: "length stop", entries: [userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "length" })], category: "nonterminal" },
		{ name: "tool-result last", entries: [userMessage(), thinkingLevelChange(), assistantMessage([toolCallItem("c1", "read", { path: "a.txt" })]), toolResultMessage("c1", "read", "ok")], category: "nonterminal" },
	];
	for (const c of cases) {
		const raw = rawOf(c.entries);
		const result = classifyRaw(raw);
		assert.equal(result.verdict, "invalid", c.name);
		assert.equal(result.detail, CATEGORY_DETAIL_V2[c.category], c.name);
		assert.equal(result.runFacts, null, c.name);
		assert.ok(result.attemptFacts !== null, c.name);
		assert.equal(result.attemptFacts.category, c.category, c.name);
		assert.equal(result.attemptFacts.label, "attempt-01", c.name);
		assert.equal(result.attemptFacts.arm, "control", c.name);
		assert.equal(result.attemptFacts.sessionBasename, FINAL_SESSION_BASENAME_V2, c.name);
		assert.equal(result.attemptFacts.rawSha256, sha256Hex(raw), c.name);
		assert.deepEqual(result.attemptFacts, expectedAttemptFacts(c.entries, raw, "attempt-01"), c.name);
	}
});

test("classifyFinalSessionV2: multi-failure precedence is the frozen v2 order", () => {
	// Wrong prompt + thinking drift + compaction + model drift + aborted → prompt_mismatch.
	const drifted = [userMessage("a different prompt"), thinkingLevelChange("low"), attemptCompactionEntry(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { model: "gpt-4o", stopReason: "aborted" })];
	assert.equal(classifyRaw(rawOf(drifted)).attemptFacts?.category, "prompt_mismatch");
	// Correct prompt + thinking drift + compaction + aborted → env_drift.
	const thinkingBeat = [userMessage(), thinkingLevelChange("low"), attemptCompactionEntry(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })];
	assert.equal(classifyRaw(rawOf(thinkingBeat)).attemptFacts?.category, "env_drift");
	// Correct prompt + model drift + compaction + errored → env_drift.
	const modelBeat = [userMessage(), thinkingLevelChange(), attemptCompactionEntry(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { model: "gpt-4o", stopReason: "error" })];
	assert.equal(classifyRaw(rawOf(modelBeat)).attemptFacts?.category, "env_drift");
	// Correct prompt + clean env + compaction + aborted → compaction_present.
	const compactionBeat = [userMessage(), thinkingLevelChange(), attemptCompactionEntry(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })];
	assert.equal(classifyRaw(rawOf(compactionBeat)).attemptFacts?.category, "compaction_present");
	// Aborted/errored beat nonterminal even though neither is a terminal stop.
	assert.equal(classifyRaw(rawOf([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })])).attemptFacts?.category, "aborted");
	assert.equal(classifyRaw(rawOf([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "error" })])).attemptFacts?.category, "errored");
	// A missing user message never masks lower-priority categories (null prompt hash).
	const noUserCompaction = [thinkingLevelChange(), attemptCompactionEntry(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })];
	assert.equal(classifyRaw(rawOf(noUserCompaction)).attemptFacts?.category, "compaction_present");
});

// ------------------------------------------------------ classifier: failures

test("classifyFinalSessionV2: malformed raws and invalid usage are unrepresentable with the fixed exact detail", () => {
	const malformed: Buffer[] = [
		Buffer.from("not-json\n", "utf8"),
		Buffer.from('{"type": "message"}\n{broken\n', "utf8"),
		Buffer.from("[1, 2, 3]\n", "utf8"),
		Buffer.from([0xff, 0x00, 0x7b, 0x7d, 0x0a]), // 0xFF decodes to U+FFFD; the embedded NUL breaks JSON.parse
	];
	for (const raw of malformed) {
		const result = classifyRaw(raw);
		assert.equal(result.verdict, "unrepresentable", raw.toString("utf8"));
		assert.equal(result.detail, UNREPRESENTABLE_DETAIL_V2, raw.toString("utf8"));
		assert.equal(result.runFacts, null, raw.toString("utf8"));
		assert.equal(result.attemptFacts, null, raw.toString("utf8"));
	}
	// Invalid usage fails closed through the strict validators.
	const badUsage = [userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { usage: { input: -5, output: 1 } })];
	assert.equal(classifyRaw(rawOf(badUsage)).verdict, "unrepresentable");
	// An assistant message without a usage object fails closed.
	const noUsage = [userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { usage: undefined })];
	assert.equal(classifyRaw(rawOf(noUsage)).verdict, "unrepresentable");
	// A message entry without a message object fails closed.
	const noMessageObject = [{ type: "message", id: "m-broken" }];
	assert.equal(classifyRaw(rawOf(noMessageObject)).verdict, "unrepresentable");
});

test("classifyFinalSessionV2: unclassified attempts failing the full final validity check are unrepresentable", () => {
	// Derive (strict: false) records unclassified; the full validity check
	// still requires a user message and fails closed.
	const noUser = [thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])];
	const r1 = classifyRaw(rawOf(noUser));
	assert.equal(r1.verdict, "unrepresentable");
	assert.equal(r1.detail, UNREPRESENTABLE_DETAIL_V2);
	assert.equal(r1.runFacts, null);
	assert.equal(r1.attemptFacts, null);
	// Derive sees no environment drift without a recorded thinking level;
	// the full validity check fails closed on the missing level.
	const noThinking = [userMessage(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])];
	const r2 = classifyRaw(rawOf(noThinking));
	assert.equal(r2.verdict, "unrepresentable");
	assert.equal(r2.detail, UNREPRESENTABLE_DETAIL_V2);
	assert.equal(r2.runFacts, null);
	assert.equal(r2.attemptFacts, null);
});

// ---------------------------------------------------- classifier: process facts

test("classifyFinalSessionV2: exit code and timeout are diagnostic-only — echoed, never change the verdict", () => {
	// Valid despite a nonzero exit and a timeout.
	const valid = classifyFinalSessionV2({ raw: rawOf(validSessionEntries()), arm: "control", label: "attempt-01", exitCode: 1, timedOut: true });
	assert.equal(valid.verdict, "valid");
	assert.equal(valid.exitCode, 1);
	assert.equal(valid.timedOut, true);
	// Invalid despite a clean process exit.
	const invalid = classifyRaw(rawOf([userMessage("wrong"), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]), { exitCode: 0, timedOut: false });
	assert.equal(invalid.verdict, "invalid");
	assert.equal(invalid.attemptFacts?.category, "prompt_mismatch");
	assert.equal(invalid.exitCode, 0);
	assert.equal(invalid.timedOut, false);
	// Unrepresentable regardless of the process facts, which are still echoed.
	const malformed = classifyRaw(Buffer.from("not json", "utf8"), { exitCode: 3, timedOut: true });
	assert.equal(malformed.verdict, "unrepresentable");
	assert.equal(malformed.exitCode, 3);
	assert.equal(malformed.timedOut, true);
});

// ----------------------------------------------------------- classifier: bytes

test("classifyFinalSessionV2: the session SHA covers the own raw bytes, never the decoded text", () => {
	const entries = validSessionEntries();
	// Insert an assistant tool call + result carrying a non-ASCII payload
	// BEFORE the terminal assistant message.
	entries.splice(6, 0, assistantMessage([toolCallItem("c9", "read", { path: "fixture/alpha.txt" })]), toolResultMessage("c9", "read", "NROPRIVATE-BYTES-\uFFFD-tail"));
	const text = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
	const encoded = Buffer.from(text, "utf8");
	// Flip the U+FFFD encoding (EF BF BD) to a single invalid byte 0xFF.
	const replacement = Buffer.from("\uFFFD", "utf8");
	const at = encoded.indexOf(replacement);
	assert.ok(at >= 0, "expected the U+FFFD byte sequence in the encoded raw");
	const raw = Buffer.concat([encoded.subarray(0, at), Buffer.from([0xff]), encoded.subarray(at + replacement.length)]);
	// The raw decodes back to the exact JSONL text (0xFF → U+FFFD)…
	assert.equal(raw.toString("utf8"), text);
	// …but the own-byte SHA-256 differs from the decoded-text SHA-256.
	assert.notEqual(sha256Hex(raw), sha256Hex(raw.toString("utf8")));
	const result = classifyFinalSessionV2({ raw, arm: "control", label: "attempt-01", exitCode: null, timedOut: false });
	assert.equal(result.verdict, "valid");
	assert.ok(result.runFacts !== null);
	assert.equal(result.runFacts.sessionSha256, sha256Hex(raw));
	assert.notEqual(result.runFacts.sessionSha256, sha256Hex(raw.toString("utf8")));
	// An invalid attempt carries the same own-bytes hash in its facts.
	const wrongEntries = [userMessage("wrong"), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])];
	const wrong = classifyRaw(rawOf(wrongEntries));
	assert.equal(wrong.attemptFacts?.rawSha256, sha256Hex(rawOf(wrongEntries)));
});

// --------------------------------------------------------- classifier: privacy

test("classifyFinalSessionV2: errors, raw bytes and paths never surface — fixed detail only", () => {
	const secrets = [SECRET_CALL_ID, SECRET_PATH, SECRET_BODY, SECRET_THINKING, "SECRET-TOOL-ARG-99"];
	const pathLikeLabel = SECRET_PATH;
	const assertSafe = (result: ClassifyFinalSessionV2Result): void => {
		assert.equal(result.verdict, "unrepresentable");
		assert.equal(result.detail, UNREPRESENTABLE_DETAIL_V2);
		assert.equal(result.runFacts, null);
		assert.equal(result.attemptFacts, null);
		const json = JSON.stringify(result);
		for (const s of secrets) assert.ok(!json.includes(s), `result JSON leaks "${s}"`);
		assert.ok(!json.includes(pathLikeLabel), "result JSON leaks the path-like label");
		for (const code of ["MALFORMED_JSONL", "MISSING_ASSISTANT_USAGE", "INVALID_FACTS", "MISSING_USER_MESSAGE", "MISSING_THINKING_LEVEL", "PROMPT_MISMATCH", "ATTEMPT_NOT_INVALID", "NroError", "NroV2Error"]) {
			assert.ok(!json.includes(code), `result JSON leaks error code "${code}"`);
		}
		assert.ok(!("error" in result), "result must not carry an error field");
		assert.ok(!("raw" in result), "result must not carry a raw field");
	};
	// Parse failure with a path-like label and a secret body in the raw.
	assertSafe(classifyRaw(Buffer.from(`{"message": "${SECRET_BODY}"}\nnot json\n`, "utf8"), { label: pathLikeLabel }));
	// Derive-stage validator failure (assistant without usage) with secrets in play.
	assertSafe(classifyRaw(rawOf([userMessage(), thinkingLevelChange(), assistantMessage([toolCallItem(SECRET_CALL_ID, "read", { path: SECRET_PATH }), { type: "thinking", text: SECRET_THINKING }], { usage: undefined })]), { label: pathLikeLabel }));
	// Full-validity failure (missing user message) with secrets in play.
	assertSafe(classifyRaw(rawOf([thinkingLevelChange(), assistantMessage([{ type: "text", text: `${SECRET_BODY}\n${RUBRIC_FULL_TEXT}` }])]), { label: pathLikeLabel }));
	// Invalid results carry aggregates only — bodies, ids, args, paths and thinking never surface.
	const invalid = classifyRaw(rawOf([userMessage(), thinkingLevelChange(), assistantMessage([toolCallItem(SECRET_CALL_ID, "bash", { cmd: "SECRET-TOOL-ARG-99" }), { type: "thinking", text: SECRET_THINKING }]), toolResultMessage(SECRET_CALL_ID, "bash", `${SECRET_BODY}\n${SECRET_PATH}`), assistantMessage([{ type: "text", text: `${SECRET_BODY}\n${SECRET_THINKING}\n${RUBRIC_FULL_TEXT}` }], { stopReason: "length" })]));
	assert.equal(invalid.verdict, "invalid");
	assert.equal(invalid.attemptFacts?.category, "nonterminal");
	const invalidJson = JSON.stringify(invalid);
	for (const s of secrets) assert.ok(!invalidJson.includes(s), `invalid result JSON leaks "${s}"`);
	// Valid results are hashes and aggregates only.
	const valid = classifyRaw(rawOf(validSessionEntries()));
	assert.equal(valid.verdict, "valid");
	const validJson = JSON.stringify(valid);
	for (const s of secrets) assert.ok(!validJson.includes(s), `valid result JSON leaks "${s}"`);
});

// ------------------------------------------------------ classifier: protocol

test("classifyFinalSessionV2: the explicit frozen protocol matches the default; an unfrozen null prompt pin fails closed", () => {
	const raw = rawOf(validSessionEntries());
	const base = { arm: "control" as const, label: "attempt-01", exitCode: null, timedOut: false };
	const viaDefault = classifyFinalSessionV2({ raw, ...base });
	const viaExplicit = classifyFinalSessionV2({ raw, ...base, protocol: FROZEN_NRO_V2_PROTOCOL });
	assert.deepEqual(viaExplicit, viaDefault);
	assert.equal(viaExplicit.verdict, "valid");
	// An unfrozen protocol (null prompt pin) is never analyzable — fail closed.
	const unfrozen = classifyFinalSessionV2({ raw, ...base, protocol: { ...FROZEN_NRO_V2_PROTOCOL, milestonePromptSha256: null } });
	assert.equal(unfrozen.verdict, "unrepresentable");
	assert.equal(unfrozen.detail, UNREPRESENTABLE_DETAIL_V2);
	assert.equal(unfrozen.runFacts, null);
	assert.equal(unfrozen.attemptFacts, null);
});

// ------------------------------------------------------- non-treatment bundle hash

/** Build the canonical four-root bundle fixture (v1-parity contents). */
async function makeBundleRoot(root: string): Promise<void> {
	await writeFile(join(root, "AGENTS.md"), "root agent guidance\n", "utf8");
	await mkdir(join(root, "skills", "sub"), { recursive: true });
	await writeFile(join(root, "skills", "a.md"), "skill a\n", "utf8");
	await writeFile(join(root, "skills", "sub", "b.md"), "skill b\n", "utf8");
	await mkdir(join(root, "prompts"));
	await writeFile(join(root, "prompts", "c.md"), "prompt c\n", "utf8");
	await mkdir(join(root, "templates"));
	await writeFile(join(root, "templates", "d.md"), "template d\n", "utf8");
}

/** The exact per-file body used by makeBundleRoot (for expected rows). */
function bundleBody(rel: string): string {
	if (rel === "AGENTS.md") return "root agent guidance\n";
	if (rel.endsWith("b.md")) return "skill b\n";
	if (rel.endsWith("c.md")) return "prompt c\n";
	if (rel.endsWith("d.md")) return "template d\n";
	return "skill a\n";
}

/** Expect a rejection with the exact v2 bundle error code. */
async function expectBundleError(root: string, code: NroV2FinalCollectErrorCode, message?: string): Promise<void> {
	await assert.rejects(nonTreatmentBundleHashV2(root), (error: unknown) => {
		assert.ok(error instanceof NroV2FinalCollectError, `expected NroV2FinalCollectError, got ${String(error)}`);
		assert.equal(error.code, code);
		assert.equal(error.name, "NroV2FinalCollectError");
		if (message !== undefined) assert.equal(error.message, message);
		return true;
	});
}

async function expectBundleErrorWithBounds(root: string, code: NroV2FinalCollectErrorCode, bounds: BundleHashBoundsV2, message?: string): Promise<void> {
	await assert.rejects(nonTreatmentBundleHashV2(root, bounds), (error: unknown) => {
		assert.ok(error instanceof NroV2FinalCollectError, `expected NroV2FinalCollectError, got ${String(error)}`);
		assert.equal(error.code, code);
		if (message !== undefined) assert.equal(error.message, message);
		return true;
	});
}

test("nonTreatmentBundleHashV2: deterministic sorted rows over exactly the four frozen roots", async () => {
	await withTempDir(async (root) => {
		await makeBundleRoot(root);
		// content outside the four frozen roots is never part of the bundle
		await mkdir(join(root, "fixture"));
		await writeFile(join(root, "fixture", "x.txt"), "x\n", "utf8");
		await writeFile(join(root, "stray.md"), "stray\n", "utf8");
		const first = await nonTreatmentBundleHashV2(root);
		const second = await nonTreatmentBundleHashV2(root);
		assert.equal(first.sha256, second.sha256);
		assert.deepEqual(first.files, ["AGENTS.md", "prompts/c.md", "skills/a.md", "skills/sub/b.md", "templates/d.md"]);
		// the hash is SHA-256 over the sorted "<rel>:<fileSha>\n" concatenation
		const rows = first.files.map((rel) => `${rel}:${sha256Hex(bundleBody(rel))}\n`);
		assert.equal(first.sha256, sha256Hex(rows.join("")));
		assert.equal(first.totalBytes, Buffer.byteLength("root agent guidance\nskill a\nskill b\nprompt c\ntemplate d\n", "utf8"));
		// the frozen root list is exactly the four roots
		assert.deepEqual(BUNDLE_ROOT_ENTRIES_V2, ["AGENTS.md", "skills", "prompts", "templates"]);
	});
});

test("nonTreatmentBundleHashV2: creation-order independent — identical content hashes identically", async () => {
	const run = async (): Promise<BundleHashResultV2> =>
		withTempDir(async (root) => {
			// deliberately created in the REVERSE of makeBundleRoot order
			await mkdir(join(root, "templates"));
			await writeFile(join(root, "templates", "d.md"), "template d\n", "utf8");
			await mkdir(join(root, "prompts"));
			await writeFile(join(root, "prompts", "c.md"), "prompt c\n", "utf8");
			await mkdir(join(root, "skills", "sub"), { recursive: true });
			await writeFile(join(root, "skills", "sub", "b.md"), "skill b\n", "utf8");
			await writeFile(join(root, "skills", "a.md"), "skill a\n", "utf8");
			await writeFile(join(root, "AGENTS.md"), "root agent guidance\n", "utf8");
			return nonTreatmentBundleHashV2(root);
		});
	const first = await run();
	const second = await run();
	assert.deepEqual(first, second);
	assert.equal(first.sha256.length, 64);
});

test("nonTreatmentBundleHashV2: changed bytes alter the hash while the file list stays stable", async () => {
	await withTempDir(async (root) => {
		await makeBundleRoot(root);
		const before = await nonTreatmentBundleHashV2(root);
		await writeFile(join(root, "skills", "a.md"), "skill A\n", "utf8");
		const after = await nonTreatmentBundleHashV2(root);
		assert.notEqual(after.sha256, before.sha256);
		assert.deepEqual(after.files, before.files);
		assert.equal(after.totalBytes, before.totalBytes);
	});
});

test("nonTreatmentBundleHashV2: empty directories are allowed", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "AGENTS.md"), "root\n", "utf8");
		await mkdir(join(root, "skills"));
		await mkdir(join(root, "prompts"));
		await mkdir(join(root, "templates"));
		const result = await nonTreatmentBundleHashV2(root);
		assert.deepEqual(result.files, ["AGENTS.md"]);
		assert.equal(result.totalBytes, 5);
		assert.equal(result.sha256, sha256Hex(`AGENTS.md:${sha256Hex("root\n")}\n`));
	});
});

test("nonTreatmentBundleHashV2: every root must exist with its correct type — missing and wrong-type roots fail closed", async () => {
	// templates missing entirely
	await withTempDir(async (root) => {
		await writeFile(join(root, "AGENTS.md"), "root\n", "utf8");
		await mkdir(join(root, "skills"));
		await mkdir(join(root, "prompts"));
		await expectBundleError(root, "BUNDLE_UNSAFE", 'non-treatment bundle directory "templates" cannot be inspected');
	});
	// prompts is a regular file, not a directory
	await withTempDir(async (root) => {
		await writeFile(join(root, "AGENTS.md"), "root\n", "utf8");
		await mkdir(join(root, "skills"));
		await writeFile(join(root, "prompts"), "not a dir\n", "utf8");
		await mkdir(join(root, "templates"));
		await expectBundleError(root, "BUNDLE_UNSAFE", 'non-treatment bundle entry "prompts" is not a directory');
	});
	// AGENTS.md missing
	await withTempDir(async (root) => {
		await mkdir(join(root, "skills"));
		await mkdir(join(root, "prompts"));
		await mkdir(join(root, "templates"));
		await expectBundleError(root, "BUNDLE_UNSAFE", 'non-treatment bundle file "AGENTS.md" cannot be inspected');
	});
	// AGENTS.md is a directory — a non-regular root file
	await withTempDir(async (root) => {
		await mkdir(join(root, "AGENTS.md"));
		await mkdir(join(root, "skills"));
		await mkdir(join(root, "prompts"));
		await mkdir(join(root, "templates"));
		await expectBundleError(root, "BUNDLE_UNSAFE", 'non-treatment bundle entry "AGENTS.md" is not a regular file');
	});
});

test("nonTreatmentBundleHashV2: no-follow — symlinked roots, nested files and nested dirs fail closed", async () => {
	// root AGENTS.md replaced by a symlink to a regular file: never followed
	await withTempDir(async (root) => {
		await makeBundleRoot(root);
		await rm(join(root, "AGENTS.md"));
		await symlink(join(root, "skills", "a.md"), join(root, "AGENTS.md"));
		await expectBundleError(root, "BUNDLE_UNSAFE", 'non-treatment bundle entry "AGENTS.md" is not a regular file');
	});
	// a symlinked ROOT bundle directory is rejected instead of followed
	for (const dir of ["skills", "prompts", "templates"] as const) {
		await withTempDir(async (root) => {
			await makeBundleRoot(root);
			await rm(join(root, dir), { recursive: true });
			await symlink(join(root, "templates"), join(root, dir));
			await expectBundleError(root, "BUNDLE_UNSAFE", `non-treatment bundle entry "${dir}" is a symlink`);
		});
	}
	// a symlinked nested file is rejected
	await withTempDir(async (root) => {
		await makeBundleRoot(root);
		await symlink(join(root, "skills", "a.md"), join(root, "skills", "link.md"));
		await expectBundleError(root, "BUNDLE_UNSAFE", 'non-treatment bundle entry "skills/link.md" is a symlink');
	});
	// a symlinked nested directory is rejected (never recursed through)
	await withTempDir(async (root) => {
		await makeBundleRoot(root);
		await symlink(join(root, "skills"), join(root, "prompts", "linked"));
		await expectBundleError(root, "BUNDLE_UNSAFE", 'non-treatment bundle entry "prompts/linked" is a symlink');
	});
});

test("nonTreatmentBundleHashV2: FIFO (non-regular) entries fail closed when the platform supports them", async () => {
	if (process.platform === "win32") return; // POSIX FIFOs are unsupported on Windows
	await withTempDir(async (root) => {
		await writeFile(join(root, "AGENTS.md"), "root\n", "utf8");
		await mkdir(join(root, "skills"));
		await mkdir(join(root, "prompts"));
		await mkdir(join(root, "templates"));
		const made = spawnSync("mkfifo", [join(root, "skills", "pipe")]);
		if (made.error !== undefined || made.status !== 0) return; // no mkfifo available — skip
		assert.ok((await lstat(join(root, "skills", "pipe"))).isFIFO(), "fixture must be a real FIFO");
		await expectBundleError(root, "BUNDLE_UNSAFE", 'non-treatment bundle entry "skills/pipe" is not a regular file');
	});
});

test("nonTreatmentBundleHashV2: injected bounds fail closed while production defaults stay frozen", async () => {
	// file-count bound
	await withTempDir(async (root) => {
		await writeFile(join(root, "AGENTS.md"), "a\n", "utf8");
		await mkdir(join(root, "skills"));
		await writeFile(join(root, "skills", "1.md"), "1\n", "utf8");
		await writeFile(join(root, "skills", "2.md"), "2\n", "utf8");
		await writeFile(join(root, "skills", "3.md"), "3\n", "utf8");
		await mkdir(join(root, "prompts"));
		await mkdir(join(root, "templates"));
		await expectBundleErrorWithBounds(root, "BUNDLE_OVER_BOUND", { maxFiles: 3 }, "non-treatment bundle exceeds 3 files");
		const ok = await nonTreatmentBundleHashV2(root, { maxFiles: 4 });
		assert.equal(ok.files.length, 4);
	});
	// total-byte bound
	await withTempDir(async (root) => {
		await writeFile(join(root, "AGENTS.md"), "12345", "utf8"); // 5 bytes
		await mkdir(join(root, "skills"));
		await writeFile(join(root, "skills", "a.md"), "123456", "utf8"); // 6 bytes
		await mkdir(join(root, "prompts"));
		await mkdir(join(root, "templates"));
		await expectBundleErrorWithBounds(root, "BUNDLE_OVER_BOUND", { maxBytes: 10 }, "non-treatment bundle exceeds 10 bytes total");
		const ok = await nonTreatmentBundleHashV2(root, { maxBytes: 11 });
		assert.equal(ok.totalBytes, 11);
	});
	// per-path byte bound
	await withTempDir(async (root) => {
		await makeBundleRoot(root); // skills/a.md is 10 UTF-8 bytes
		await expectBundleErrorWithBounds(root, "BUNDLE_PATH_UNSAFE", { maxPathBytes: 8 }, "non-treatment bundle path exceeds 8 bytes");
		const ok = await nonTreatmentBundleHashV2(root, { maxPathBytes: 512 });
		assert.equal(ok.files.length, 5);
	});
	// generous injected bounds never change the default result
	await withTempDir(async (root) => {
		await makeBundleRoot(root);
		const plain = await nonTreatmentBundleHashV2(root);
		const injected = await nonTreatmentBundleHashV2(root, { maxFiles: 10_000, maxBytes: 64 * 1024 * 1024, maxPathBytes: 512 });
		assert.deepEqual(injected, plain);
	});
});

test("nonTreatmentBundleHashV2: control characters in any path fail closed and never surface raw", async () => {
	if (process.platform === "win32") return; // control-char file names are unsupported on Windows
	await withTempDir(async (root) => {
		await writeFile(join(root, "AGENTS.md"), "root\n", "utf8");
		await mkdir(join(root, "skills"));
		await mkdir(join(root, "prompts"));
		await mkdir(join(root, "templates"));
		await writeFile(join(root, "skills", "bad\u0001name.md"), "x\n", "utf8");
		await expectBundleError(root, "BUNDLE_PATH_UNSAFE", "non-treatment bundle path contains control characters");
	});
});

test("NroV2FinalCollectError: stable thirty-one-code family with fixed bounded privacy-safe messages", async () => {
	// constructible with exactly the thirty-one frozen codes; name and code stable
	for (const code of ["BUNDLE_UNSAFE", "BUNDLE_OVER_BOUND", "BUNDLE_PATH_UNSAFE", "BUNDLE_MISMATCH", "PROTOCOL_UNFROZEN", "INPUTS_INVALID", "OVER_BOUND", "FIXTURE_MISMATCH", "MILESTONE_MISMATCH", "ENV_FILE_INVALID", "RUBRIC_INVALID", "RUBRIC_MISMATCH", "NODE_MISMATCH", "PACKAGE_JSON_INVALID", "PACKAGE_PIN_MISMATCH", "PI_BINARY_UNSAFE", "ARM_FILE_UNSAFE", "EXISTING_OUTPUT", "STORAGE_IO", "RECORD_INVALID", "RECORD_IO", "SOURCE_OVER_BOUND", "SOURCE_EXISTS", "SOURCE_IO", "ATTEMPT_DIR_EXISTS", "ATTEMPT_DIR_IO", "SESSION_FILE_COUNT", "SESSION_OVER_BOUND", "SESSION_IO", "ATTEMPT_START_FAILED", "ATTEMPT_UNREPRESENTABLE"] as const) {
		const error = new NroV2FinalCollectError(code, `fixed message for ${code}`);
		assert.ok(error instanceof Error);
		assert.equal(error.name, "NroV2FinalCollectError");
		assert.equal(error.code, code);
		assert.equal(error.message, `fixed message for ${code}`);
	}
	// failure messages carry only the fixed root entry name — never the
	// secret absolute root, its basename, or raw fs error text
	await withTempDir(async (root) => {
		const secretRoot = join(root, "SECRET-ROOT-7f3a");
		await mkdir(secretRoot);
		await writeFile(join(secretRoot, "AGENTS.md"), "root\n", "utf8");
		await mkdir(join(secretRoot, "skills"));
		await mkdir(join(secretRoot, "prompts"));
		// templates missing → BUNDLE_UNSAFE with the fixed entry name only
		const error = await nonTreatmentBundleHashV2(secretRoot).then(
			() => null,
			(e: unknown) => e,
		);
		assert.ok(error instanceof NroV2FinalCollectError);
		const text = `${error.name} ${error.code} ${error.message}`;
		assert.ok(!text.includes(secretRoot), `error leaks the absolute root path: ${text}`);
		assert.ok(!text.includes("SECRET-ROOT-7f3a"), `error leaks the root basename: ${text}`);
		for (const raw of ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "Error:", "node:"]) {
			assert.ok(!text.includes(raw), `error leaks raw fs error text "${raw}": ${text}`);
		}
		assert.ok(!/[\u0000-\u001f\u007f]/.test(text), "error message contains control characters");
		assert.ok(error.message.length <= 200, "error message exceeds the bounded length");
	});
	// a successful result carries relative paths only — never the root
	await withTempDir(async (root) => {
		const secretRoot = join(root, "SECRET-ROOT-9c11");
		await mkdir(secretRoot, { recursive: true });
		await makeBundleRoot(secretRoot);
		const result = await nonTreatmentBundleHashV2(secretRoot);
		const json = JSON.stringify(result);
		assert.ok(!json.includes(secretRoot), "result JSON leaks the absolute root path");
		assert.ok(!json.includes("SECRET-ROOT-9c11"), "result JSON leaks the root basename");
		for (const rel of result.files) {
			assert.ok(!rel.startsWith("/") && !rel.includes("\\"), `non-relative file row: ${rel}`);
		}
	});
});

// ----------------------------------------------------------- inputs preflight

const PROTOCOL_UNFROZEN_MESSAGE = "the supplied protocol must equal the frozen v2 protocol exactly (all four content pins, the exact pinned environment and the frozen cohort runsPerArm/interleave)";

async function expectProtocolUnfrozen(inputsDir: string, protocol: V2FrozenProtocol, name: string): Promise<void> {
	await assert.rejects(preflightInputsForCollectorV2(inputsDir, protocol), (error: unknown) => {
		assert.ok(error instanceof NroV2FinalCollectError, name);
		assert.equal(error.code, "PROTOCOL_UNFROZEN", name);
		assert.equal(error.name, "NroV2FinalCollectError", name);
		assert.equal(error.message, PROTOCOL_UNFROZEN_MESSAGE, name);
		assert.ok(!error.message.includes(inputsDir), name);
		assert.ok(error.message.length <= 200, name);
		return true;
	});
}

test("preflight: success reproduces every frozen pin, exact raw bytes and the ordered frozen checks (temp copy)", async () => {
	await withTempDir(async (root) => {
		const inputsDir = await makeInputsTree(root);
		const viaDefault = await preflightInputsForCollectorV2(inputsDir);
		const viaExplicit = await preflightInputsForCollectorV2(inputsDir, FROZEN_NRO_V2_PROTOCOL);
		assert.deepEqual(viaExplicit, viaDefault);
		const facts: FrozenInputsFactsForCollectorV2 = viaDefault;
		// fixture facts reproduce the frozen fixture manifest pin and the real tree
		assert.equal(facts.fixture.manifestSha256, FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256);
		assert.equal(facts.fixture.manifestSha256.length, 64);
		assert.deepEqual(facts.fixture, await fixtureManifestHash(join(FROZEN_INPUTS, FIXTURE_DIR_NAME)));
		assert.ok(facts.fixture.files.length >= 10, "fixture facts must carry the full frozen relative file list");
		// prompt raw bytes and hash reproduce the frozen prompt pin
		assert.equal(facts.milestonePromptSha256, FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256);
		assert.equal(facts.milestonePromptSha256, sha256Hex(facts.milestonePromptRaw));
		assert.equal(Buffer.compare(facts.milestonePromptRaw, await readFile(join(FROZEN_INPUTS, MILESTONE_PROMPT_NAME))), 0);
		// environment raw equals the exact canonical bytes (no extra newline)
		assert.equal(facts.environmentRaw.toString("utf8"), CANONICAL_ENV_TEXT);
		assert.equal(facts.environmentRaw.length, CANONICAL_ENV_BYTES);
		assert.equal(Buffer.compare(facts.environmentRaw, await readFile(join(FROZEN_INPUTS, ENVIRONMENT_NAME))), 0);
		assert.ok(!facts.environmentRaw.toString("utf8").endsWith("\n"), "the canonical environment file carries no trailing newline");
		// rubric raw/hash/checks reproduce the frozen schema-2 rubric pin
		assert.equal(facts.rubricSha256, FROZEN_NRO_V2_PROTOCOL.rubricSha256);
		assert.equal(facts.rubricSha256, sha256Hex(facts.rubricRaw));
		assert.deepEqual(facts.rubricChecks, [...V2_RUBRIC_CHECKS]);
		assert.equal(Buffer.compare(facts.rubricRaw, await readFile(join(FROZEN_INPUTS, RUBRIC_NAME))), 0);
		// the facts carry safe relative paths only — never the temp/frozen roots
		const json = JSON.stringify(facts);
		assert.ok(!json.includes(root), "facts JSON leaks the temp root");
		assert.ok(!json.includes(basename(root)), "facts JSON leaks the temp root basename");
		assert.ok(!json.includes(FROZEN_INPUTS), "facts JSON leaks the frozen inputs path");
		for (const rel of facts.fixture.files) {
			assert.ok(!rel.startsWith("/") && !rel.includes("\\"), `non-relative fixture row: ${rel}`);
		}
		// deterministic across calls
		assert.deepEqual(await preflightInputsForCollectorV2(inputsDir), facts);
	});
});

test("preflight: the real frozen v2 inputs tree passes read-only against every pin", async () => {
	const facts = await preflightInputsForCollectorV2(FROZEN_INPUTS);
	assert.equal(facts.fixture.manifestSha256, FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256);
	assert.equal(facts.milestonePromptSha256, FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256);
	assert.equal(facts.environmentRaw.toString("utf8"), CANONICAL_ENV_TEXT);
	assert.equal(facts.rubricSha256, FROZEN_NRO_V2_PROTOCOL.rubricSha256);
	assert.deepEqual(facts.rubricChecks, [...V2_RUBRIC_CHECKS]);
	assert.deepEqual(facts.fixture, await fixtureManifestHash(join(FROZEN_INPUTS, FIXTURE_DIR_NAME)));
});

test("preflight: every protocol pin and environment drift fails closed BEFORE any filesystem access", async () => {
	await withTempDir(async (root) => {
		// a nonexistent inputs dir proves the drift check runs before ANY fs access
		const phantom = join(root, "does-not-exist-7f2b");
		const driftProtocols: Array<{ name: string; protocol: V2FrozenProtocol }> = [
			{ name: "null milestone pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, milestonePromptSha256: null } },
			{ name: "null fixture pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, fixtureManifestSha256: null } },
			{ name: "null non-treatment pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, nonTreatmentSha256: null } },
			{ name: "null rubric pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, rubricSha256: null } },
			{ name: "drifted milestone pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, milestonePromptSha256: "0".repeat(64) } },
			{ name: "drifted fixture pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, fixtureManifestSha256: "1".repeat(64) } },
			{ name: "drifted non-treatment pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, nonTreatmentSha256: "2".repeat(64) } },
			{ name: "drifted rubric pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, rubricSha256: "3".repeat(64) } },
			{ name: "drifted model key", protocol: { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, modelKey: "openai-codex/gpt-4o" } } },
			{ name: "drifted thinking level", protocol: { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, thinkingLevel: "low" } } },
			{ name: "drifted pi version", protocol: { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, piVersion: "0.82.0" } } },
			{ name: "drifted node version", protocol: { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, nodeVersion: "v25.0.0" } } },
			{ name: "drifted runsPerArm", protocol: { ...FROZEN_NRO_V2_PROTOCOL, runsPerArm: 21 } },
			{ name: "drifted interleave", protocol: { ...FROZEN_NRO_V2_PROTOCOL, interleave: "BABA" } as unknown as V2FrozenProtocol },
		];
		for (const c of driftProtocols) {
			await expectProtocolUnfrozen(phantom, c.protocol, c.name);
		}
		// with a REAL frozen inputs tree present, protocol drift still wins
		const inputsDir = await makeInputsTree(root);
		await expectProtocolUnfrozen(inputsDir, { ...FROZEN_NRO_V2_PROTOCOL, milestonePromptSha256: "0".repeat(64) }, "real tree with drifted milestone pin");
		// the exact frozen protocol (default and explicit) still succeeds
		await preflightInputsForCollectorV2(inputsDir);
		await preflightInputsForCollectorV2(inputsDir, FROZEN_NRO_V2_PROTOCOL);
	});
});

test("preflight: the inputs root must be a real directory — missing, file, symlink and FIFO roots fail closed", async () => {
	await withTempDir(async (root) => {
		await expectPreflightError(join(root, "missing-root-9c11"), "INPUTS_INVALID", "inputs directory cannot be inspected");
	});
	await withTempDir(async (root) => {
		const fileRoot = join(root, "inputs-file");
		await writeFile(fileRoot, "not a dir\n", "utf8");
		await expectPreflightError(fileRoot, "INPUTS_INVALID", "inputs path must be a real directory (symlinks and special entries are rejected)");
	});
	// a symlinked root is never followed, even to a real inputs tree
	await withTempDir(async (root) => {
		const realRoot = await makeInputsTree(root);
		const linkRoot = join(root, "inputs-link");
		await symlink(realRoot, linkRoot);
		await expectPreflightError(linkRoot, "INPUTS_INVALID", "inputs path must be a real directory (symlinks and special entries are rejected)");
	});
	if (process.platform !== "win32") {
		await withTempDir(async (root) => {
			const fifoRoot = join(root, "inputs-fifo");
			const made = spawnSync("mkfifo", [fifoRoot]);
			if (made.error === undefined && made.status === 0) {
				assert.ok((await lstat(fifoRoot)).isFIFO(), "fixture must be a real FIFO");
				await expectPreflightError(fifoRoot, "INPUTS_INVALID", "inputs path must be a real directory (symlinks and special entries are rejected)");
			}
		});
	}
});

test("preflight: exactly the four frozen children — missing, extra and wrong-type entries fail closed", async () => {
	for (const name of [FIXTURE_DIR_NAME, MILESTONE_PROMPT_NAME, ENVIRONMENT_NAME, RUBRIC_NAME]) {
		await withTempDir(async (root) => {
			const inputs = await makeInputsTree(root);
			await rm(join(inputs, name), { recursive: true });
			await expectPreflightError(inputs, "INPUTS_INVALID", "inputs directory must contain exactly fixture/, milestone-prompt.txt, environment.txt and rubric.json (got 3 entries)");
		});
	}
	// an extra REGULAR FILE entry — its name never surfaces
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await writeFile(join(inputs, "stray-SECRET-7f1a.txt"), "x\n", "utf8");
		await expectPreflightError(inputs, "INPUTS_INVALID", "inputs directory must contain exactly fixture/, milestone-prompt.txt, environment.txt and rubric.json — an unexpected entry is rejected");
	});
	// an extra DIRECTORY entry
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await mkdir(join(inputs, "extra-SECRET-dir"));
		await expectPreflightError(inputs, "INPUTS_INVALID", "inputs directory must contain exactly fixture/, milestone-prompt.txt, environment.txt and rubric.json — an unexpected entry is rejected");
	});
	// fixture replaced by a regular file
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await rm(join(inputs, FIXTURE_DIR_NAME), { recursive: true });
		await writeFile(join(inputs, FIXTURE_DIR_NAME), "not a dir\n", "utf8");
		await expectPreflightError(inputs, "INPUTS_INVALID", 'fixture directory "fixture" must be a real directory (symlinks and special entries are rejected)');
	});
	// each of the three frozen files replaced by a directory
	for (const name of [MILESTONE_PROMPT_NAME, ENVIRONMENT_NAME, RUBRIC_NAME]) {
		await withTempDir(async (root) => {
			const inputs = await makeInputsTree(root);
			await rm(join(inputs, name));
			await mkdir(join(inputs, name));
			await expectPreflightError(inputs, "INPUTS_INVALID", `inputs "${name}" must be a non-symlink regular file`);
		});
	}
});

test("preflight: no-follow — symlinked children fail closed and the lstat pass precedes every content read", async () => {
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await rm(join(inputs, FIXTURE_DIR_NAME), { recursive: true });
		await symlink(join(FROZEN_INPUTS, FIXTURE_DIR_NAME), join(inputs, FIXTURE_DIR_NAME));
		await expectPreflightError(inputs, "INPUTS_INVALID", 'fixture directory "fixture" must be a real directory (symlinks and special entries are rejected)');
	});
	for (const name of [MILESTONE_PROMPT_NAME, ENVIRONMENT_NAME, RUBRIC_NAME]) {
		await withTempDir(async (root) => {
			const inputs = await makeInputsTree(root);
			await rm(join(inputs, name));
			await symlink(join(FROZEN_INPUTS, name), join(inputs, name));
			await expectPreflightError(inputs, "INPUTS_INVALID", `inputs "${name}" must be a non-symlink regular file`);
		});
	}
	// shape failures fire BEFORE content drift is ever read: a symlinked
	// rubric combined with drifted prompt content still fails on the shape
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await rm(join(inputs, RUBRIC_NAME));
		await symlink(join(FROZEN_INPUTS, RUBRIC_NAME), join(inputs, RUBRIC_NAME));
		await writeFile(join(inputs, MILESTONE_PROMPT_NAME), "drifted prompt content\n", "utf8");
		await expectPreflightError(inputs, "INPUTS_INVALID", 'inputs "rubric.json" must be a non-symlink regular file');
	});
	// a symlinked fixture with a malformed rubric sibling fails on the shape first
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await rm(join(inputs, FIXTURE_DIR_NAME), { recursive: true });
		await symlink(join(FROZEN_INPUTS, FIXTURE_DIR_NAME), join(inputs, FIXTURE_DIR_NAME));
		await writeFile(join(inputs, RUBRIC_NAME), "{ broken", "utf8");
		await expectPreflightError(inputs, "INPUTS_INVALID", 'fixture directory "fixture" must be a real directory (symlinks and special entries are rejected)');
	});
});

test("preflight: prompt drift fails closed MILESTONE_MISMATCH after a bounded read", async () => {
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await writeFile(join(inputs, MILESTONE_PROMPT_NAME), "drifted prompt bytes\n", "utf8");
		await expectPreflightError(inputs, "MILESTONE_MISMATCH", `milestone-prompt.txt SHA-256 ${sha256Hex("drifted prompt bytes\n")} does not match the frozen pin ${FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256}`);
	});
	// same-size drift fails identically
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		const original = await readFile(join(FROZEN_INPUTS, MILESTONE_PROMPT_NAME));
		const drifted = Buffer.from(original.toString("utf8").replace("Read meta/build.txt", "READ meta/build.txt"));
		assert.notEqual(sha256Hex(drifted), FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256);
		await writeFile(join(inputs, MILESTONE_PROMPT_NAME), drifted);
		await expectPreflightError(inputs, "MILESTONE_MISMATCH", `milestone-prompt.txt SHA-256 ${sha256Hex(drifted)} does not match the frozen pin ${FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256}`);
	});
});

test("preflight: fixture drift fails closed FIXTURE_MISMATCH; unsafe nested fixture trees are wrapped, names never leak", async () => {
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await writeFile(join(inputs, FIXTURE_DIR_NAME, "meta", "build.txt"), "alpha-43\n", "utf8");
		const driftedSha = (await fixtureManifestHash(join(inputs, FIXTURE_DIR_NAME))).manifestSha256;
		assert.notEqual(driftedSha, FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256);
		const error = await preflightInputsForCollectorV2(inputs).then(
			() => null,
			(e: unknown) => e,
		);
		assert.ok(error instanceof NroV2FinalCollectError);
		assert.equal(error.code, "FIXTURE_MISMATCH");
		assert.equal(error.message, `fixture tree SHA-256 ${driftedSha} does not match the frozen pin ${FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256}`);
		assert.ok(!error.message.includes(root), "error leaks the temp root");
	});
	// a nested symlink inside the fixture tree is wrapped — nested names never leak
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await symlink(join(inputs, FIXTURE_DIR_NAME, "meta", "build.txt"), join(inputs, FIXTURE_DIR_NAME, "search", "linked-SECRET.txt"));
		await expectPreflightError(inputs, "INPUTS_INVALID", 'fixture directory "fixture" could not be verified (unsafe or unreadable fixture tree)');
	});
	// an over-long nested path maps to OVER_BOUND with the fixed wrapped message
	if (process.platform !== "win32") {
		await withTempDir(async (root) => {
			const inputs = await makeInputsTree(root);
			let deep = join(inputs, FIXTURE_DIR_NAME);
			for (let i = 0; i < 12; i += 1) {
				deep = join(deep, "x".repeat(48));
				await mkdir(deep);
			}
			await writeFile(join(deep, "leaf.txt"), "x", "utf8");
			await expectPreflightError(inputs, "OVER_BOUND", 'fixture directory "fixture" could not be verified (unsafe or unreadable fixture tree)');
		});
	}
});

test("preflight: environment.txt must equal the exact canonical bytes — no extra newline, no drift", async () => {
	// a trailing newline is over the pinned canonical size → OVER_BOUND
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await writeFile(join(inputs, ENVIRONMENT_NAME), `${CANONICAL_ENV_TEXT}\n`, "utf8");
		await expectPreflightError(inputs, "OVER_BOUND", `inputs "environment.txt" exceeds the pinned canonical size (${CANONICAL_ENV_BYTES} bytes)`);
	});
	// same-size value drift passes the size bound but fails the exact content check
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await writeFile(join(inputs, ENVIRONMENT_NAME), CANONICAL_ENV_TEXT.replace("thinking_level: high", "thinking_level: low"), "utf8");
		await expectPreflightError(inputs, "ENV_FILE_INVALID", "environment.txt must be exactly the four pinned lines in fixed order (model_key, thinking_level, pi_version, node_version) with no extra content or newline");
	});
	// missing, reordered and model-drifted files fail the same way
	const lines = CANONICAL_ENV_TEXT.split("\n");
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await writeFile(join(inputs, ENVIRONMENT_NAME), lines.slice(0, 3).join("\n"), "utf8");
		await expectPreflightError(inputs, "ENV_FILE_INVALID");
	});
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await writeFile(join(inputs, ENVIRONMENT_NAME), [...lines].reverse().join("\n"), "utf8");
		await expectPreflightError(inputs, "ENV_FILE_INVALID");
	});
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await writeFile(join(inputs, ENVIRONMENT_NAME), CANONICAL_ENV_TEXT.replace("openai-codex/gpt-5.6-sol", "openai-codex/gpt-4o"), "utf8");
		await expectPreflightError(inputs, "ENV_FILE_INVALID");
	});
	// the canonical text itself is exactly four lines with no trailing newline
	assert.equal(lines.length, 4);
	assert.ok(!CANONICAL_ENV_TEXT.endsWith("\n"));
});

test("preflight: the strict schema-2 rubric parse precedes the hash pin — malformed, unknown, wrong-schema, order/id/pattern drift, duplicates, missing keys and wrong types", async () => {
	// sanity: the temp copy's rubric is byte-identical to the frozen file
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		assert.equal(await readFile(join(inputs, RUBRIC_NAME), "utf8"), await readFile(join(FROZEN_INPUTS, RUBRIC_NAME), "utf8"));
	});
	const cases: Array<{ name: string; text: string; code: NroV2FinalCollectErrorCode; message?: string }> = [
		{ name: "not valid JSON", text: "{ broken", code: "RUBRIC_INVALID", message: "rubric.json is not valid JSON" },
		{ name: "array root", text: "[1, 2, 3]", code: "RUBRIC_INVALID", message: "rubric.json must be a JSON object" },
		{ name: "string root", text: '"nope"', code: "RUBRIC_INVALID", message: "rubric.json must be a JSON object" },
		{ name: "unknown root key", text: JSON.stringify({ schema_version: 2, checks: FROZEN_CHECK_OBJECTS, extra: 1 }), code: "RUBRIC_INVALID", message: "unknown key in rubric.json" },
		{ name: "missing checks key", text: JSON.stringify({ schema_version: 2 }), code: "RUBRIC_INVALID", message: "rubric.json.checks must be an array" },
		{ name: "missing schema key", text: JSON.stringify({ checks: FROZEN_CHECK_OBJECTS }), code: "RUBRIC_INVALID", message: "rubric.json.schema_version must be 2" },
		{ name: "schema 1", text: JSON.stringify({ schema_version: 1, checks: FROZEN_CHECK_OBJECTS }), code: "RUBRIC_INVALID", message: "rubric.json.schema_version must be 2" },
		{ name: "schema 3", text: JSON.stringify({ schema_version: 3, checks: FROZEN_CHECK_OBJECTS }), code: "RUBRIC_INVALID", message: "rubric.json.schema_version must be 2" },
		{ name: "checks not an array", text: JSON.stringify({ schema_version: 2, checks: "nope" }), code: "RUBRIC_INVALID", message: "rubric.json.checks must be an array" },
		{ name: "five checks", text: JSON.stringify({ schema_version: 2, checks: FROZEN_CHECK_OBJECTS.slice(0, 5) }), code: "RUBRIC_MISMATCH", message: "rubric.json must carry exactly the 6 frozen v2 checks in frozen order (got 5)" },
		{ name: "seven checks", text: JSON.stringify({ schema_version: 2, checks: [...FROZEN_CHECK_OBJECTS, { id: "extra", pattern: "x" }] }), code: "RUBRIC_MISMATCH", message: "rubric.json must carry exactly the 6 frozen v2 checks in frozen order (got 7)" },
		{ name: "check not an object", text: JSON.stringify({ schema_version: 2, checks: ["build", ...FROZEN_CHECK_OBJECTS.slice(1)] }), code: "RUBRIC_INVALID", message: "rubric.json[0] must be an object" },
		{ name: "unknown check key", text: JSON.stringify({ schema_version: 2, checks: [{ id: "build", pattern: "x", extra: 1 }, ...FROZEN_CHECK_OBJECTS.slice(1)] }), code: "RUBRIC_INVALID", message: "unknown key in rubric.json[0]" },
		{ name: "missing check id", text: JSON.stringify({ schema_version: 2, checks: [{ pattern: "x" }, ...FROZEN_CHECK_OBJECTS.slice(1)] }), code: "RUBRIC_INVALID" },
		{ name: "non-string check id", text: JSON.stringify({ schema_version: 2, checks: [{ id: 42, pattern: "x" }, ...FROZEN_CHECK_OBJECTS.slice(1)] }), code: "RUBRIC_INVALID" },
		{ name: "unsafe check id", text: JSON.stringify({ schema_version: 2, checks: [{ id: "bad id!", pattern: "x" }, ...FROZEN_CHECK_OBJECTS.slice(1)] }), code: "RUBRIC_INVALID" },
		{ name: "reordered checks", text: JSON.stringify({ schema_version: 2, checks: (() => { const c = [...FROZEN_CHECK_OBJECTS]; const a = c[0]; const b = c[1]; if (a && b) { c[0] = b; c[1] = a; } return c; })() }), code: "RUBRIC_MISMATCH", message: 'rubric.json[0].id must be the frozen check id "build" at frozen position 0' },
		{ name: "duplicate check id", text: JSON.stringify({ schema_version: 2, checks: (() => { const c = [...FROZEN_CHECK_OBJECTS]; const a = c[0]; if (a) c[1] = { id: a.id, pattern: a.pattern }; return c; })() }), code: "RUBRIC_INVALID", message: 'duplicate rubric check id "build"' },
		{ name: "drifted pattern", text: JSON.stringify({ schema_version: 2, checks: [{ id: "build", pattern: "build:\\s*alpha-43\\b" }, ...FROZEN_CHECK_OBJECTS.slice(1)] }), code: "RUBRIC_MISMATCH", message: 'rubric.json[0].pattern must be the frozen v2 pattern for check "build"' },
		{ name: "non-string pattern", text: JSON.stringify({ schema_version: 2, checks: [{ id: "build", pattern: 42 }, ...FROZEN_CHECK_OBJECTS.slice(1)] }), code: "RUBRIC_INVALID" },
		{ name: "empty pattern", text: JSON.stringify({ schema_version: 2, checks: [{ id: "build", pattern: "" }, ...FROZEN_CHECK_OBJECTS.slice(1)] }), code: "RUBRIC_INVALID" },
		{ name: "over-long pattern", text: JSON.stringify({ schema_version: 2, checks: [{ id: "build", pattern: "a".repeat(513) }, ...FROZEN_CHECK_OBJECTS.slice(1)] }), code: "RUBRIC_INVALID" },
		{ name: "uncompilable drifted pattern", text: JSON.stringify({ schema_version: 2, checks: [{ id: "build", pattern: "(" }, ...FROZEN_CHECK_OBJECTS.slice(1)] }), code: "RUBRIC_MISMATCH", message: 'rubric.json[0].pattern must be the frozen v2 pattern for check "build"' },
	];
	for (const c of cases) {
		await withTempDir(async (root) => {
			const inputs = await makeInputsTree(root);
			await writeFile(join(inputs, RUBRIC_NAME), c.text, "utf8");
			// every mutant's raw bytes differ from the frozen pin — the code must
			// come from the STRUCTURE, never from the hash comparison
			assert.notEqual(sha256Hex(c.text), FROZEN_NRO_V2_PROTOCOL.rubricSha256, c.name);
			await expectPreflightError(inputs, c.code, c.message);
		});
	}
	// structurally valid but different raw bytes (compact whitespace) reach the
	// hash pin → RUBRIC_MISMATCH with the SHA message
	const compact = JSON.stringify({ schema_version: 2, checks: FROZEN_CHECK_OBJECTS });
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await writeFile(join(inputs, RUBRIC_NAME), compact, "utf8");
		await expectPreflightError(inputs, "RUBRIC_MISMATCH", `rubric.json SHA-256 ${sha256Hex(compact)} does not match the frozen pin ${FROZEN_NRO_V2_PROTOCOL.rubricSha256}`);
	});
});

test("preflight: size bounds — prompt/rubric capped at SESSION_MAX_BYTES, environment at the exact canonical size", async () => {
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await writeFile(join(inputs, MILESTONE_PROMPT_NAME), Buffer.alloc(SESSION_MAX_BYTES + 1, 0x61));
		await expectPreflightError(inputs, "OVER_BOUND", `inputs "milestone-prompt.txt" exceeds ${SESSION_MAX_BYTES} bytes`);
	});
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await writeFile(join(inputs, RUBRIC_NAME), Buffer.alloc(SESSION_MAX_BYTES + 1, 0x7b));
		await expectPreflightError(inputs, "OVER_BOUND", `inputs "rubric.json" exceeds ${SESSION_MAX_BYTES} bytes`);
	});
	// the frozen environment file sits exactly AT the canonical bound
	assert.equal(CANONICAL_ENV_BYTES, (await readFile(join(FROZEN_INPUTS, ENVIRONMENT_NAME))).length);
});

test("preflight: no writes, no output roots and no calls — success and failure leave the tree byte-identical", async () => {
	await withTempDir(async (root) => {
		const inputsDir = await makeInputsTree(root);
		const before = await treeSnapshot(inputsDir);
		const facts = await preflightInputsForCollectorV2(inputsDir);
		assert.deepEqual(await treeSnapshot(inputsDir), before, "successful preflight must never modify the inputs tree");
		// no output/evidence root, no staging prefix, nothing new anywhere
		assert.ok(!existsSync(join(root, OUTPUT_ROOT_NAME_V2)), "no v2 collection output root may be created");
		assert.ok(!existsSync(join(root, "commander-native-tool-benchmark-v2")), "no v2 evidence root may be created");
		for (const sibling of await readdir(root)) {
			assert.ok(!sibling.startsWith(".nro-v2-prepare-staging-"), `v2 staging entry created: ${sibling}`);
			assert.ok(!sibling.startsWith(".nro-prepare-staging-"), `v1 staging entry created: ${sibling}`);
		}
		assert.ok(facts.fixture.files.length > 0, "fixture facts must carry the frozen relative file list");
		// failures also never write
		await writeFile(join(inputsDir, MILESTONE_PROMPT_NAME), "drifted prompt\n", "utf8");
		const driftedBefore = await treeSnapshot(inputsDir);
		await expectPreflightError(inputsDir, "MILESTONE_MISMATCH");
		assert.deepEqual(await treeSnapshot(inputsDir), driftedBefore, "a failing preflight must never modify the tree");
	});
});

test("preflight: control-character child names fail closed with fixed messages (POSIX)", async () => {
	if (process.platform === "win32") return;
	await withTempDir(async (root) => {
		const inputs = await makeInputsTree(root);
		await writeFile(join(inputs, "bad\u0001name.txt"), "x\n", "utf8");
		await expectPreflightError(inputs, "INPUTS_INVALID", "inputs directory must contain exactly fixture/, milestone-prompt.txt, environment.txt and rubric.json — an unexpected entry is rejected");
	});
});

test("preflight: privacy — errors carry fixed child basenames only, never roots, raw fs text or file content", async () => {
	await withTempDir(async (root) => {
		let n = 0;
		const scenarioError = async (mutate: (inputs: string) => Promise<void>): Promise<NroV2FinalCollectError> => {
			n += 1;
			const secretRoot = join(root, `SECRET-ROOT-${String(n).padStart(2, "0")}`);
			await mkdir(secretRoot);
			const inputs = join(secretRoot, "inputs");
			await cp(FROZEN_INPUTS, inputs, { recursive: true });
			await mutate(inputs);
			const error = await preflightInputsForCollectorV2(inputs).then(
				() => null,
				(e: unknown) => e,
			);
			assert.ok(error instanceof NroV2FinalCollectError, `scenario ${n} must fail closed`);
			return error;
		};
		const scenarios: Array<{ name: string; mutate: (inputs: string) => Promise<void>; secrets: string[] }> = [
			{
				name: "missing root",
				mutate: async (inputs) => {
					await rm(inputs, { recursive: true, force: true });
				},
				secrets: [],
			},
			{
				name: "unexpected entry",
				mutate: async (inputs) => {
					await writeFile(join(inputs, "SECRET-EXTRA-8c2e.txt"), "x\n", "utf8");
				},
				secrets: ["SECRET-EXTRA-8c2e.txt"],
			},
			{
				name: "prompt drift",
				mutate: async (inputs) => {
					await writeFile(join(inputs, MILESTONE_PROMPT_NAME), "SECRET-BODY-9f31 drifted prompt\n", "utf8");
				},
				secrets: ["SECRET-BODY-9f31"],
			},
			{
				name: "rubric malformed",
				mutate: async (inputs) => {
					await writeFile(join(inputs, RUBRIC_NAME), '{ "checks": "SECRET-BODY-9f31"', "utf8");
				},
				secrets: ["SECRET-BODY-9f31"],
			},
			{
				name: "fixture unsafe",
				mutate: async (inputs) => {
					await symlink(join(inputs, FIXTURE_DIR_NAME, "meta", "build.txt"), join(inputs, FIXTURE_DIR_NAME, "SECRET-LINK-7a42.txt"));
				},
				secrets: ["SECRET-LINK-7a42.txt"],
			},
			{
				name: "environment drift",
				mutate: async (inputs) => {
					await writeFile(join(inputs, ENVIRONMENT_NAME), CANONICAL_ENV_TEXT.replace("thinking_level: high", "thinking_level: low"), "utf8");
				},
				secrets: [],
			},
		];
		for (const s of scenarios) {
			const error = await scenarioError(s.mutate);
			const text = `${error.name} ${error.code} ${error.message}`;
			assert.ok(!text.includes(root), `${s.name}: error leaks the temp root`);
			assert.ok(!text.includes("SECRET-ROOT-"), `${s.name}: error leaks a secret root basename`);
			for (const secret of [...s.secrets, "ENOENT", "ENOTDIR", "EACCES", "EPERM", "Error:", "node:", "SECRET-BODY-9f31", "SECRET-LINK-7a42.txt"]) {
				assert.ok(!text.includes(secret), `${s.name}: error leaks "${secret}": ${text}`);
			}
			assert.ok(!/[\u0000-\u001f\u007f]/.test(text), `${s.name}: error message contains control characters`);
			assert.ok(error.message.length <= 200, `${s.name}: error message exceeds the bounded length`);
		}
		// a SUCCESSFUL result also carries no roots — hashes, relative fixture
		// paths and raw buffers only
		const secretRoot = join(root, "SECRET-ROOT-99");
		await mkdir(secretRoot);
		const inputs = join(secretRoot, "inputs");
		await cp(FROZEN_INPUTS, inputs, { recursive: true });
		const facts = await preflightInputsForCollectorV2(inputs);
		const json = JSON.stringify(facts);
		assert.ok(!json.includes(secretRoot), "facts JSON leaks the secret root path");
		assert.ok(!json.includes("SECRET-ROOT-99"), "facts JSON leaks the secret root basename");
		for (const rel of facts.fixture.files) {
			assert.ok(!rel.startsWith("/") && !rel.includes("\\"), `non-relative fixture row: ${rel}`);
		}
	});
});

// ----------------------------------------------------------- system preflight

/** Repository root — read-only real-tree references only (frozen bundle copy, package.json pin). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Byte-copy the frozen bundle; the root AGENTS bytes come from the historical generic template, never the live repository policy. */
async function makeBundleCopy(projectRoot: string): Promise<void> {
	await cp(join(REPO_ROOT, "templates", "project", "AGENTS.generic.md"), join(projectRoot, "AGENTS.md"));
	for (const dir of ["skills", "prompts", "templates"] as const) {
		await cp(join(REPO_ROOT, dir), join(projectRoot, dir), { recursive: true });
	}
}

/** Build a temp project root whose system preflight succeeds: frozen bundle copy, exact pi pin, npm-style pi symlink, regular arm files. */
async function makeSystemRoot(projectRoot: string): Promise<void> {
	await makeBundleCopy(projectRoot);
	await writeFile(join(projectRoot, PACKAGE_JSON_RELATIVE_V2), JSON.stringify({ devDependencies: { "@earendil-works/pi-coding-agent": FROZEN_ENVIRONMENT.piVersion } }), "utf8");
	await mkdir(join(projectRoot, "node_modules", ".bin"), { recursive: true });
	await writeFile(join(projectRoot, "node_modules", ".bin", "pi-target.js"), "#!/usr/bin/env node\n", "utf8");
	await symlink(join(projectRoot, "node_modules", ".bin", "pi-target.js"), join(projectRoot, PI_BINARY_RELATIVE_V2));
	await mkdir(dirname(join(projectRoot, CONTROL_ARM_FILE_RELATIVE_V2)), { recursive: true });
	await writeFile(join(projectRoot, CONTROL_ARM_FILE_RELATIVE_V2), "export default {};\n", "utf8");
	await mkdir(dirname(join(projectRoot, TREATMENT_ARM_FILE_RELATIVE_V2)), { recursive: true });
	await writeFile(join(projectRoot, TREATMENT_ARM_FILE_RELATIVE_V2), "export default {};\n", "utf8");
}

/** Expect a system-preflight rejection with the exact collector error code (and optional exact message). */
async function expectSystemError(root: string, runtime: SystemRuntimeFactsV2, code: NroV2FinalCollectErrorCode, message?: string, protocol: V2FrozenProtocol = FROZEN_NRO_V2_PROTOCOL): Promise<void> {
	await assert.rejects(preflightSystemForCollectorV2(root, runtime, protocol), (error: unknown) => {
		assert.ok(error instanceof NroV2FinalCollectError, `expected NroV2FinalCollectError, got ${String(error)}`);
		assert.equal(error.code, code);
		assert.equal(error.name, "NroV2FinalCollectError");
		if (message !== undefined) assert.equal(error.message, message);
		return true;
	});
}

test("preflightSystemForCollectorV2: success reproduces every frozen pin and returns only safe relative paths (temp root)", async () => {
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		const viaDefaultProtocol = await preflightSystemForCollectorV2(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion });
		const viaExplicit = await preflightSystemForCollectorV2(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, FROZEN_NRO_V2_PROTOCOL);
		assert.deepEqual(viaExplicit, viaDefaultProtocol);
		const facts: SystemPreflightFactsV2 = viaDefaultProtocol;
		// every verified fact reproduces the frozen pins exactly
		assert.equal(facts.nonTreatmentSha256, FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256);
		assert.equal(facts.nonTreatmentSha256.length, 64);
		assert.equal(facts.nodeVersion, FROZEN_ENVIRONMENT.nodeVersion);
		assert.equal(facts.piPackageVersion, FROZEN_ENVIRONMENT.piVersion);
		// the facts carry the frozen RELATIVE paths only — never absolute roots
		assert.equal(facts.piBinary, PI_BINARY_RELATIVE_V2);
		assert.equal(facts.controlArmFile, CONTROL_ARM_FILE_RELATIVE_V2);
		assert.equal(facts.treatmentArmFile, TREATMENT_ARM_FILE_RELATIVE_V2);
		const json = JSON.stringify(facts);
		assert.ok(!json.includes(root), "facts JSON leaks the temp root");
		assert.ok(!json.includes(basename(root)), "facts JSON leaks the temp root basename");
		for (const rel of [facts.piBinary, facts.controlArmFile, facts.treatmentArmFile]) {
			assert.ok(!rel.startsWith("/") && !rel.includes("\\"), `non-relative fact path: ${rel}`);
		}
		// deterministic across calls
		assert.deepEqual(await preflightSystemForCollectorV2(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }), facts);
	});
});

test("preflightSystemForCollectorV2: the current Pi 0.84.2 package pin fails closed against the historical Pi 0.83.0 collector", async () => {
	const raw = await readFile(join(REPO_ROOT, PACKAGE_JSON_RELATIVE_V2), "utf8");
	const root = JSON.parse(raw) as Record<string, unknown>;
	const devDeps = root.devDependencies;
	assert.ok(typeof devDeps === "object" && devDeps !== null && !Array.isArray(devDeps), "real package.json must carry devDependencies");
	assert.equal((devDeps as Record<string, unknown>)["@earendil-works/pi-coding-agent"], "0.84.2", "the real repository must carry the currently qualified Pi pin");
	assert.equal(FROZEN_ENVIRONMENT.piVersion, "0.83.0", "the historical paid benchmark authority must retain its frozen Pi pin");
	await withTempDir(async (projectRoot) => {
		await makeSystemRoot(projectRoot);
		await writeFile(join(projectRoot, PACKAGE_JSON_RELATIVE_V2), JSON.stringify({ devDependencies: { "@earendil-works/pi-coding-agent": "0.84.2" } }), "utf8");
		await expectSystemError(
			projectRoot,
			{ nodeVersion: FROZEN_ENVIRONMENT.nodeVersion },
			"PACKAGE_PIN_MISMATCH",
			`devDependencies["@earendil-works/pi-coding-agent"] must be pinned exactly to the frozen Pi version (${FROZEN_ENVIRONMENT.piVersion})`,
		);
	});
});

test("preflightSystemForCollectorV2: every protocol pin and environment drift fails closed BEFORE any filesystem access", async () => {
	await withTempDir(async (root) => {
		// a nonexistent project root proves the drift check runs before ANY fs access
		const phantom = join(root, "does-not-exist-7f2b");
		const driftProtocols: Array<{ name: string; protocol: V2FrozenProtocol }> = [
			{ name: "null milestone pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, milestonePromptSha256: null } },
			{ name: "null fixture pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, fixtureManifestSha256: null } },
			{ name: "null non-treatment pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, nonTreatmentSha256: null } },
			{ name: "null rubric pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, rubricSha256: null } },
			{ name: "drifted milestone pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, milestonePromptSha256: "0".repeat(64) } },
			{ name: "drifted fixture pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, fixtureManifestSha256: "1".repeat(64) } },
			{ name: "drifted non-treatment pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, nonTreatmentSha256: "2".repeat(64) } },
			{ name: "drifted rubric pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, rubricSha256: "3".repeat(64) } },
			{ name: "drifted model key", protocol: { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, modelKey: "openai-codex/gpt-4o" } } },
			{ name: "drifted thinking level", protocol: { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, thinkingLevel: "low" } } },
			{ name: "drifted pi version", protocol: { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, piVersion: "0.82.0" } } },
			{ name: "drifted node version", protocol: { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, nodeVersion: "v25.0.0" } } },
			{ name: "drifted runsPerArm", protocol: { ...FROZEN_NRO_V2_PROTOCOL, runsPerArm: 21 } },
			{ name: "drifted interleave", protocol: { ...FROZEN_NRO_V2_PROTOCOL, interleave: "BABA" } as unknown as V2FrozenProtocol },
		];
		for (const c of driftProtocols) {
			await expectSystemError(phantom, {}, "PROTOCOL_UNFROZEN", PROTOCOL_UNFROZEN_MESSAGE, c.protocol);
		}
	});
});

test("preflightSystemForCollectorV2: the frozen check order — bundle before node, node before package, package before pi binary, pi binary before arm files", async () => {
	// bundle drift masks a drifted node runtime
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await writeFile(join(root, "skills", "a.md"), "drifted\n", "utf8");
		await expectSystemError(root, { nodeVersion: "v99.0.0" }, "BUNDLE_MISMATCH");
	});
	// node drift masks a malformed package.json
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await writeFile(join(root, PACKAGE_JSON_RELATIVE_V2), "{ broken", "utf8");
		await expectSystemError(root, { nodeVersion: "v99.0.0" }, "NODE_MISMATCH");
	});
	// package shape masks a missing pi binary
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await writeFile(join(root, PACKAGE_JSON_RELATIVE_V2), "{ broken", "utf8");
		await rm(join(root, PI_BINARY_RELATIVE_V2));
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PACKAGE_JSON_INVALID");
	});
	// pi binary masks missing arm files
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await rm(join(root, PI_BINARY_RELATIVE_V2));
		await rm(join(root, CONTROL_ARM_FILE_RELATIVE_V2));
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PI_BINARY_UNSAFE");
	});
});

test("preflightSystemForCollectorV2: a drifted non-treatment bundle fails closed BUNDLE_MISMATCH with the exact hash message", async () => {
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await writeFile(join(root, "skills", "a.md"), "drifted skill content\n", "utf8");
		const drifted = await nonTreatmentBundleHashV2(root);
		assert.notEqual(drifted.sha256, FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256);
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "BUNDLE_MISMATCH", `non-treatment bundle SHA-256 ${drifted.sha256} does not match the frozen pin ${FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256}`);
	});
});

test("preflightSystemForCollectorV2: an injected Node runtime drift fails closed NODE_MISMATCH without rendering the drifted value", async () => {
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await expectSystemError(root, { nodeVersion: "v99.0.0" }, "NODE_MISMATCH", `the Node runtime version must equal the frozen v2 Node pin (${FROZEN_ENVIRONMENT.nodeVersion}) exactly`);
		const error = await preflightSystemForCollectorV2(root, { nodeVersion: "v99.0.0" }).then(
			() => null,
			(e: unknown) => e,
		);
		assert.ok(error instanceof NroV2FinalCollectError);
		const text = `${error.name} ${error.code} ${error.message}`;
		assert.ok(!text.includes("v99.0.0"), `error leaks the drifted node version: ${text}`);
	});
});

test("preflightSystemForCollectorV2: the production default reads the global process.version only when called", async () => {
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		if (process.version === FROZEN_ENVIRONMENT.nodeVersion) {
			const facts = await preflightSystemForCollectorV2(root);
			assert.equal(facts.nodeVersion, process.version);
		} else {
			await expectSystemError(root, {}, "NODE_MISMATCH", `the Node runtime version must equal the frozen v2 Node pin (${FROZEN_ENVIRONMENT.nodeVersion}) exactly`);
		}
	});
});

test("preflightSystemForCollectorV2: package.json shape failures fail closed PACKAGE_JSON_INVALID", async () => {
	// missing package.json
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await rm(join(root, PACKAGE_JSON_RELATIVE_V2));
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PACKAGE_JSON_INVALID", "project package.json cannot be read");
	});
	// malformed JSON
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await writeFile(join(root, PACKAGE_JSON_RELATIVE_V2), "{ broken", "utf8");
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PACKAGE_JSON_INVALID", "project package.json must be valid JSON");
	});
	// not an object
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await writeFile(join(root, PACKAGE_JSON_RELATIVE_V2), "[1, 2, 3]", "utf8");
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PACKAGE_JSON_INVALID", "project package.json must be a JSON object");
	});
	// devDependencies not an object
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await writeFile(join(root, PACKAGE_JSON_RELATIVE_V2), JSON.stringify({ devDependencies: "nope" }), "utf8");
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PACKAGE_JSON_INVALID", "project package.json devDependencies must be an object");
	});
});

test("preflightSystemForCollectorV2: the pi package pin must be exact and un-ranged — missing, ranged, wrong and non-string pins fail closed", async () => {
	const pinMessage = `devDependencies["@earendil-works/pi-coding-agent"] must be pinned exactly to the frozen Pi version (${FROZEN_ENVIRONMENT.piVersion})`;
	// missing key
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await writeFile(join(root, PACKAGE_JSON_RELATIVE_V2), JSON.stringify({ devDependencies: {} }), "utf8");
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PACKAGE_PIN_MISMATCH", pinMessage);
	});
	// ranged
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await writeFile(join(root, PACKAGE_JSON_RELATIVE_V2), JSON.stringify({ devDependencies: { "@earendil-works/pi-coding-agent": "^0.83.0" } }), "utf8");
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PACKAGE_PIN_MISMATCH", pinMessage);
	});
	// wrong exact version
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await writeFile(join(root, PACKAGE_JSON_RELATIVE_V2), JSON.stringify({ devDependencies: { "@earendil-works/pi-coding-agent": "0.82.0" } }), "utf8");
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PACKAGE_PIN_MISMATCH", pinMessage);
	});
	// non-string
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await writeFile(join(root, PACKAGE_JSON_RELATIVE_V2), JSON.stringify({ devDependencies: { "@earendil-works/pi-coding-agent": 42 } }), "utf8");
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PACKAGE_PIN_MISMATCH", pinMessage);
	});
});

test("preflightSystemForCollectorV2: the pi binary must resolve to a regular file — npm symlink accepted, broken and nonregular rejected", async () => {
	// a plain regular file at the path also passes
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await rm(join(root, PI_BINARY_RELATIVE_V2));
		await writeFile(join(root, PI_BINARY_RELATIVE_V2), "#!/usr/bin/env node\n", "utf8");
		const facts = await preflightSystemForCollectorV2(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion });
		assert.equal(facts.piBinary, PI_BINARY_RELATIVE_V2);
	});
	// missing
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await rm(join(root, PI_BINARY_RELATIVE_V2));
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PI_BINARY_UNSAFE", "the pi binary (node_modules/.bin/pi) cannot be resolved");
	});
	// broken symlink
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await rm(join(root, PI_BINARY_RELATIVE_V2));
		await symlink(join(root, "node_modules", ".bin", "missing-target.js"), join(root, PI_BINARY_RELATIVE_V2));
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PI_BINARY_UNSAFE", "the pi binary (node_modules/.bin/pi) cannot be resolved");
	});
	// symlink resolving to a DIRECTORY
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await rm(join(root, PI_BINARY_RELATIVE_V2));
		await symlink(join(root, "node_modules"), join(root, PI_BINARY_RELATIVE_V2));
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PI_BINARY_UNSAFE", "the pi binary (node_modules/.bin/pi) must resolve to a regular file");
	});
	// the path itself is a directory
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await rm(join(root, PI_BINARY_RELATIVE_V2));
		await mkdir(join(root, PI_BINARY_RELATIVE_V2));
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PI_BINARY_UNSAFE", "the pi binary (node_modules/.bin/pi) must resolve to a regular file");
	});
});

test("preflightSystemForCollectorV2: the frozen arm files must be regular files at the path itself — missing, symlinked and nonregular arms fail closed", async () => {
	// missing control arm
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await rm(join(root, CONTROL_ARM_FILE_RELATIVE_V2));
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "ARM_FILE_UNSAFE", "the control arm extension (scripts/commander-native-tool-final-control-extension.ts) cannot be inspected");
	});
	// control arm replaced by a symlink — never followed, even to a real file
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await rm(join(root, CONTROL_ARM_FILE_RELATIVE_V2));
		await symlink(join(REPO_ROOT, CONTROL_ARM_FILE_RELATIVE_V2), join(root, CONTROL_ARM_FILE_RELATIVE_V2));
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "ARM_FILE_UNSAFE", "the control arm extension (scripts/commander-native-tool-final-control-extension.ts) must be a non-symlink regular file");
	});
	// control arm replaced by a directory
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await rm(join(root, CONTROL_ARM_FILE_RELATIVE_V2));
		await mkdir(join(root, CONTROL_ARM_FILE_RELATIVE_V2));
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "ARM_FILE_UNSAFE", "the control arm extension (scripts/commander-native-tool-final-control-extension.ts) must be a non-symlink regular file");
	});
	// missing treatment arm
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await rm(join(root, TREATMENT_ARM_FILE_RELATIVE_V2));
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "ARM_FILE_UNSAFE", "the treatment arm runtime (extensions/workbench-runtime/index.ts) cannot be inspected");
	});
	// treatment arm replaced by a symlink
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		await rm(join(root, TREATMENT_ARM_FILE_RELATIVE_V2));
		await symlink(join(REPO_ROOT, TREATMENT_ARM_FILE_RELATIVE_V2), join(root, TREATMENT_ARM_FILE_RELATIVE_V2));
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "ARM_FILE_UNSAFE", "the treatment arm runtime (extensions/workbench-runtime/index.ts) must be a non-symlink regular file");
	});
});

test("preflightSystemForCollectorV2: no writes — success and failure leave the temp project root byte-identical and create no output root", async () => {
	await withTempDir(async (root) => {
		await makeSystemRoot(root);
		const before = await treeSnapshot(root);
		const facts = await preflightSystemForCollectorV2(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion });
		assert.deepEqual(await treeSnapshot(root), before, "a successful preflight must never modify the project tree");
		assert.equal(facts.nonTreatmentSha256, FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256);
		// no output/evidence root or staging entry anywhere
		assert.ok(!existsSync(join(root, OUTPUT_ROOT_NAME_V2)), "no v2 collection output root may be created");
		for (const sibling of await readdir(root)) {
			assert.ok(!sibling.startsWith(".nro-v2-prepare-staging-"), `v2 staging entry created: ${sibling}`);
		}
		// failures also never write
		await rm(join(root, PI_BINARY_RELATIVE_V2));
		const failingBefore = await treeSnapshot(root);
		await expectSystemError(root, { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion }, "PI_BINARY_UNSAFE");
		assert.deepEqual(await treeSnapshot(root), failingBefore, "a failing preflight must never modify the tree");
	});
});

test("preflightSystemForCollectorV2: privacy — fixed bounded messages never leak roots, package contents or drifted values", async () => {
	await withTempDir(async (root) => {
		const secretRoot = join(root, "SECRET-ROOT-77");
		await mkdir(secretRoot);
		await makeSystemRoot(secretRoot);
		const scenarios: Array<{ name: string; mutate: () => Promise<void>; runtime: SystemRuntimeFactsV2; secrets: string[] }> = [
			{
				name: "bundle drift",
				mutate: async () => {
					await writeFile(join(secretRoot, "skills", "a.md"), "SECRET-BODY-31\n", "utf8");
				},
				runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion },
				secrets: [],
			},
			{ name: "node drift", mutate: async () => {}, runtime: { nodeVersion: "SECRET-NODE-91.0.0" }, secrets: ["SECRET-NODE-91.0.0"] },
			{
				name: "malformed package",
				mutate: async () => {
					await writeFile(join(secretRoot, PACKAGE_JSON_RELATIVE_V2), '{"SECRET-KEY-11": ', "utf8");
				},
				runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion },
				secrets: ["SECRET-KEY-11"],
			},
			{
				name: "ranged pin",
				mutate: async () => {
					await writeFile(join(secretRoot, PACKAGE_JSON_RELATIVE_V2), JSON.stringify({ devDependencies: { "@earendil-works/pi-coding-agent": "^0.83.0" } }), "utf8");
				},
				runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion },
				secrets: ["^0.83.0"],
			},
			{
				name: "wrong pin",
				mutate: async () => {
					await writeFile(join(secretRoot, PACKAGE_JSON_RELATIVE_V2), JSON.stringify({ devDependencies: { "@earendil-works/pi-coding-agent": "0.82.0" } }), "utf8");
				},
				runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion },
				secrets: ["0.82.0"],
			},
			{
				name: "missing pi binary",
				mutate: async () => {
					await rm(join(secretRoot, PI_BINARY_RELATIVE_V2));
				},
				runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion },
				secrets: [],
			},
			{
				name: "missing arm file",
				mutate: async () => {
					await rm(join(secretRoot, TREATMENT_ARM_FILE_RELATIVE_V2));
				},
				runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion },
				secrets: [],
			},
		];
		for (const s of scenarios) {
			await s.mutate();
			const error = await preflightSystemForCollectorV2(secretRoot, s.runtime).then(
				() => null,
				(e: unknown) => e,
			);
			assert.ok(error instanceof NroV2FinalCollectError, `${s.name} must fail closed`);
			const text = `${error.name} ${error.code} ${error.message}`;
			assert.ok(!text.includes(root), `${s.name}: error leaks the temp root`);
			assert.ok(!text.includes("SECRET-ROOT-77"), `${s.name}: error leaks the secret root basename`);
			for (const secret of [...s.secrets, "ENOENT", "ENOTDIR", "EACCES", "EPERM", "Error:", "node:", "workbench-test-"]) {
				assert.ok(!text.includes(secret), `${s.name}: error leaks "${secret}": ${text}`);
			}
			assert.ok(!/[\u0000-\u001f\u007f]/.test(text), `${s.name}: error message contains control characters`);
			assert.ok(error.message.length <= 200, `${s.name}: error message exceeds the bounded length`);
		}
	});
});

// ------------------------------------------------------- spawn attempt runner

/** Run a harmless local node child through the production runner (test seam only — never Pi/provider/model/network). */
function runNode(runner: SpawnAttemptRunnerV2, script: string, overrides: Partial<SpawnAttemptRequestV2> = {}): Promise<SpawnedAttemptResultV2> {
	return runner({
		program: process.execPath,
		argv: ["-e", script],
		cwd: process.cwd(),
		env: { PI_TELEMETRY: "0" },
		...overrides,
	});
}

test("runner envelope: the frozen production constants match the protocol/v1 operational envelope", () => {
	assert.equal(ATTEMPT_TIMEOUT_MS_V2, 30 * 60 * 1000);
	assert.equal(TERMINATE_GRACE_MS_V2, 5_000);
	assert.equal(ATTEMPT_STDOUT_MAX_BYTES_V2, 64 * 1024);
	assert.equal(ATTEMPT_STDERR_MAX_BYTES_V2, 256 * 1024);
	assert.equal(SPAWN_START_FAILED_DETAIL_V2, "the attempt process could not be started");
});

test("createSpawnAttemptRunnerV2: exact argv/env/cwd fidelity with shell:false — shell metacharacters pass verbatim", async () => {
	await withTempDir(async (root) => {
		const runner = createSpawnAttemptRunnerV2();
		process.env.NRO_TEST_INHERITED = "inherited-secret-9f2c";
		try {
			const positional = ["a;b && c", "$HOME", "*.md", "x|y>z"];
			const script =
				"console.log(JSON.stringify({ argv: process.argv.slice(1), argv0: process.argv[0], cwd: process.cwd(), marker: process.env.PI_TEST_MARKER, inherited: Object.prototype.hasOwnProperty.call(process.env, 'NRO_TEST_INHERITED') }))";
			const result = await runNode(runner, script, {
				cwd: root,
				env: { PI_TEST_MARKER: "SECRET-marker-7f1a", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
				argv: ["-e", script, ...positional],
				timeoutMs: 30_000,
				stdoutMaxBytes: 8192,
				stderrMaxBytes: 1024,
			});
			assert.equal(result.started, true);
			assert.equal(result.timedOut, false);
			assert.equal(result.startError, null);
			assert.equal(result.exitCode, 0);
			const parsed = JSON.parse(result.stdout.text) as { argv: string[]; argv0: string; cwd: string; marker: string; inherited: boolean };
			// the exact argv arrives verbatim — no shell expansion
			assert.deepEqual(parsed.argv, positional);
			// argv[0] is the program itself, never a shell wrapper
			assert.equal(parsed.argv0, process.execPath);
			// the exact env is delivered — never merged with the parent
			assert.equal(parsed.marker, "SECRET-marker-7f1a");
			assert.equal(parsed.inherited, false);
			// the exact cwd is delivered
			assert.equal(parsed.cwd, root);
			assert.equal(result.stderr.text, "");
		} finally {
			delete process.env.NRO_TEST_INHERITED;
		}
	});
});

test("createSpawnAttemptRunnerV2: stdin is ignored — the child sees immediate EOF", async () => {
	const runner = createSpawnAttemptRunnerV2();
	const script = "process.stdin.on('data', () => process.exit(7)); process.stdin.on('end', () => { console.log('EOF'); process.exit(0); });";
	const result = await runNode(runner, script, { timeoutMs: 10_000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024 });
	assert.equal(result.started, true);
	assert.equal(result.exitCode, 0);
	assert.equal(result.timedOut, false);
	assert.equal(result.stdout.text, "EOF\n");
});

test("createSpawnAttemptRunnerV2: stdout/stderr are hard-capped at the byte caps with exact raw byte counts", async () => {
	const runner = createSpawnAttemptRunnerV2();
	// exact fit at the cap
	const exact = await runNode(runner, "process.stdout.write('x'.repeat(1024))", { timeoutMs: 30_000, stdoutMaxBytes: 1024, stderrMaxBytes: 256 });
	assert.equal(exact.started, true);
	assert.equal(exact.exitCode, 0);
	assert.equal(exact.stdout.overflowed, false);
	assert.equal(exact.stdout.totalBytes, 1024);
	assert.equal(exact.stdout.text, "x".repeat(1024));
	// overflow by exactly one raw byte
	const over = await runNode(runner, "process.stdout.write('y'.repeat(1025))", { timeoutMs: 30_000, stdoutMaxBytes: 1024, stderrMaxBytes: 256 });
	assert.equal(over.stdout.overflowed, true);
	assert.equal(over.stdout.totalBytes, 1025);
	assert.equal(over.stdout.text, "y".repeat(1024));
	assert.ok(Buffer.byteLength(over.stdout.text, "utf8") <= 1024);
	// independent stderr capture with multibyte raw bytes
	const mb = await runNode(runner, "process.stderr.write('héllo')", { timeoutMs: 30_000, stdoutMaxBytes: 64, stderrMaxBytes: 64 });
	assert.equal(mb.stderr.totalBytes, 6);
	assert.equal(mb.stderr.text, "héllo");
	assert.equal(mb.stderr.overflowed, false);
	assert.equal(mb.stdout.text, "");
	// multibyte overflow never splits a code point
	const mbOver = await runNode(runner, "process.stderr.write('héllo')", { timeoutMs: 30_000, stdoutMaxBytes: 64, stderrMaxBytes: 2 });
	assert.equal(mbOver.stderr.totalBytes, 6);
	assert.equal(mbOver.stderr.overflowed, true);
	assert.equal(mbOver.stderr.text, "h");
	// invalid raw bytes count exactly and decode to replacement characters
	const raw = await runNode(runner, "process.stdout.write(Buffer.from([0x61, 0xff, 0x62]))", { timeoutMs: 30_000, stdoutMaxBytes: 8, stderrMaxBytes: 8 });
	assert.equal(raw.stdout.totalBytes, 3);
	assert.equal(raw.stdout.overflowed, false);
	assert.equal(raw.stdout.text, "a\uFFFDb");
	// stdout and stderr capture independently
	const both = await runNode(runner, "process.stdout.write('out'); process.stderr.write('err')", { timeoutMs: 30_000, stdoutMaxBytes: 64, stderrMaxBytes: 64 });
	assert.equal(both.stdout.text, "out");
	assert.equal(both.stderr.text, "err");
});

test("createSpawnAttemptRunnerV2: a spawn-start failure never throws and yields the fixed privacy-safe start fact", async () => {
	await withTempDir(async (root) => {
		const runner = createSpawnAttemptRunnerV2();
		// a nonexistent program; the default 30-minute timeout proves the
		// timer is cleared on settle (the suite would hang otherwise)
		const missing = join(root, "missing-program-7f2b");
		const result = await runner({ program: missing, argv: ["--flag"], cwd: root, env: { PI_TELEMETRY: "0" } });
		assert.equal(result.started, false);
		assert.equal(result.exitCode, null);
		assert.equal(result.timedOut, false);
		assert.equal(result.startError, SPAWN_START_FAILED_DETAIL_V2);
		assert.equal(result.stdout.text, "");
		assert.equal(result.stderr.text, "");
		assert.equal(result.stdout.totalBytes, 0);
		assert.equal(result.stderr.totalBytes, 0);
		assert.equal(result.stdout.overflowed, false);
		assert.equal(result.stderr.overflowed, false);
		// the settled result is machine facts only — no raw error text,
		// no program path, no fs codes
		const json = JSON.stringify(result);
		assert.ok(!json.includes(missing), "result leaks the missing program path");
		assert.ok(!json.includes(basename(missing)), "result leaks the program basename");
		for (const raw of ["ENOENT", "EACCES", "error", "node:", "spawn"]) {
			assert.ok(!json.includes(raw), `result leaks raw spawn error text "${raw}"`);
		}
		// a directory as the program is also a deterministic start failure
		const dirProgram = join(root, "program-dir-9c11");
		await mkdir(dirProgram);
		const result2 = await runner({ program: dirProgram, argv: [], cwd: root, env: { PI_TELEMETRY: "0" } });
		assert.equal(result2.started, false);
		assert.equal(result2.exitCode, null);
		assert.equal(result2.startError, SPAWN_START_FAILED_DETAIL_V2);
		assert.ok(!JSON.stringify(result2).includes(dirProgram), "result leaks the directory program path");
	});
});

test("createSpawnAttemptRunnerV2: timeout sends SIGTERM then SIGKILL after the grace and marks the attempt timed out", async () => {
	const runner = createSpawnAttemptRunnerV2();
	// the child catches SIGTERM (proof of delivery) but cannot catch SIGKILL
	const script = "process.on('SIGTERM', () => { console.error('TERM'); }); setInterval(() => {}, 1000);";
	const started = Date.now();
	const result = await runNode(runner, script, { timeoutMs: 150, terminateGraceMs: 100, stdoutMaxBytes: 1024, stderrMaxBytes: 1024 });
	const elapsed = Date.now() - started;
	assert.equal(result.started, true);
	assert.equal(result.timedOut, true);
	assert.equal(result.exitCode, null); // killed by a signal
	assert.ok(result.stderr.text.includes("TERM"), "SIGTERM must be delivered before SIGKILL");
	assert.ok(elapsed >= 150, `resolved before the timeout fired: ${elapsed}ms`);
	assert.ok(elapsed < 5000, `resolution took far longer than timeout+grace: ${elapsed}ms`);
});

test("createSpawnAttemptRunnerV2: a child that dies on SIGTERM resolves timedOut with a null exit code", async () => {
	const runner = createSpawnAttemptRunnerV2();
	const result = await runNode(runner, "setInterval(() => {}, 1000);", { timeoutMs: 120, terminateGraceMs: 5000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024 });
	assert.equal(result.started, true);
	assert.equal(result.timedOut, true);
	assert.equal(result.exitCode, null);
	assert.equal(result.stdout.text, "");
	assert.equal(result.stderr.text, "");
});

test("createSpawnAttemptRunnerV2: prompt exits settle exactly once with the exact exit code and no timeout", async () => {
	const runner = createSpawnAttemptRunnerV2();
	// the default production envelope is used: a prompt exit must clear
	// the 30-minute timer (the suite would hang otherwise)
	let resolutions = 0;
	const result = await new Promise<SpawnedAttemptResultV2>((resolve, reject) => {
		runner({ program: process.execPath, argv: ["-e", "process.exit(7)"], cwd: process.cwd(), env: { PI_TELEMETRY: "0" } }).then(
			(r) => {
				resolutions += 1;
				resolve(r);
			},
			reject,
		);
	});
	assert.equal(resolutions, 1);
	assert.equal(result.started, true);
	assert.equal(result.exitCode, 7);
	assert.equal(result.timedOut, false);
	assert.equal(result.startError, null);
});

test("createSpawnAttemptRunnerV2: output racing a fast exit is fully captured before close", async () => {
	const runner = createSpawnAttemptRunnerV2();
	const result = await runNode(runner, "process.stdout.write('fast', () => process.exit(3))", { timeoutMs: 30_000, stdoutMaxBytes: 64, stderrMaxBytes: 64 });
	assert.equal(result.started, true);
	assert.equal(result.exitCode, 3);
	assert.equal(result.timedOut, false);
	assert.equal(result.stdout.text, "fast");
});

// ------------------------------------------------------------------ import side effects

test("module import has no side effects", async () => {
	const before = { skip: process.env.PI_SKIP_VERSION_CHECK, telemetry: process.env.PI_TELEMETRY };
	const mod = await import("../scripts/commander-native-tool-v2-final-collect.ts");
	// importing never touches the environment
	assert.equal(process.env.PI_SKIP_VERSION_CHECK, before.skip);
	assert.equal(process.env.PI_TELEMETRY, before.telemetry);
	// and only exports data constants and pure functions
	assert.equal(mod.FINAL_V2_VALID_SESSIONS, 40);
	assert.equal(mod.FINAL_V2_MAX_ATTEMPTS, 60);
	assert.equal(mod.OUTPUT_ROOT_NAME_V2, "commander-native-tool-v2-final-collection");
	assert.equal(typeof mod.fixedPlanV2, "function");
	assert.equal(typeof mod.buildAttemptArgvV2, "function");
	assert.equal(typeof mod.buildAttemptEnvV2, "function");
	assert.equal(typeof mod.createCappedCaptureV2, "function");
	assert.equal(typeof mod.classifyFinalSessionV2, "function");
	assert.equal(typeof mod.nonTreatmentBundleHashV2, "function");
	assert.equal(typeof mod.NroV2FinalCollectError, "function");
	assert.deepEqual(mod.BUNDLE_ROOT_ENTRIES_V2, ["AGENTS.md", "skills", "prompts", "templates"]);
	assert.equal(mod.UNREPRESENTABLE_DETAIL_V2, "raw session is not analyzable under the frozen v2 contract");
	assert.equal(mod.FINAL_SESSION_BASENAME_V2, "raw-session.jsonl");
	assert.equal(mod.VALID_DETAIL_V2, "session satisfies the frozen v2 final-validity contract");
	assert.equal(typeof mod.preflightInputsForCollectorV2, "function");
	assert.equal(typeof mod.preflightSystemForCollectorV2, "function");
	assert.equal(typeof mod.createSpawnAttemptRunnerV2, "function");
	// the public initial-record/storage exports of the persistence core
	assert.equal(typeof mod.buildInitialCollectionRecordV2, "function");
	assert.equal(typeof mod.initializeCollectionStorageV2, "function");
	assert.equal(typeof mod.CollectionStorageV2, "function");
	assert.equal(mod.SOURCES_DIR_NAME_V2, "sources");
	assert.equal(typeof mod.retainRawSourceV2, "function");
	assert.equal(typeof mod.removeOwnedRetainedSourceV2, "function");
	// the attempt-session lifecycle exports of the persistence core
	assert.equal(typeof mod.AttemptSessionStorageV2, "function");
	assert.equal(typeof mod.createAttemptSessionStorageV2, "function");
	assert.equal(typeof mod.locateProducedSessionV2, "function");
	assert.equal(typeof mod.removeOwnedAttemptSessionV2, "function");
	// the FINAL collection loop
	assert.equal(typeof mod.collectFinalV2, "function");
	// the guarded CLI entry — importing never runs it, only the path-exact
	// direct-execution guard may (and only when the module IS the executed script)
	assert.equal(typeof mod.usage, "function");
	assert.equal(typeof mod.renderSummary, "function");
	assert.equal(typeof mod.main, "function");
	// the CLI usage is fixed and bounded (never argv, paths, or session bytes)
	const usageText = mod.usage();
	assert.ok(usageText.includes("usage:"));
	assert.ok(usageText.includes("exit codes: 0"));
	assert.ok(usageText.includes("FINAL validation collector (final evidence only)"));
	assert.ok(!usageText.includes(SOURCE_PATH), "usage must never carry absolute paths");
	// renderSummary is exact and runs-relative
	assert.equal(
		mod.renderSummary({ status: "attempts-exhausted", validCount: 3, startedAttempts: 60, record: mod.buildInitialCollectionRecordV2(), recordLocation: `${mod.OUTPUT_ROOT_NAME_V2}/${COLLECTION_RECORD_NAME}` }),
		`commander-native-tool-v2-final-collect: status=attempts-exhausted valid=3 attempts=60 collection=.pi/workbench/runs/${mod.OUTPUT_ROOT_NAME_V2}/${COLLECTION_RECORD_NAME}`,
	);
	// the frozen production runner envelope and system-preflight paths are data constants
	assert.equal(mod.ATTEMPT_TIMEOUT_MS_V2, 30 * 60 * 1000);
	assert.equal(mod.TERMINATE_GRACE_MS_V2, 5_000);
	assert.equal(mod.ATTEMPT_STDOUT_MAX_BYTES_V2, 64 * 1024);
	assert.equal(mod.ATTEMPT_STDERR_MAX_BYTES_V2, 256 * 1024);
	assert.equal(mod.SPAWN_START_FAILED_DETAIL_V2, "the attempt process could not be started");
	assert.equal(mod.PACKAGE_JSON_RELATIVE_V2, "package.json");
	assert.equal(mod.PI_BINARY_RELATIVE_V2, "node_modules/.bin/pi");
	assert.equal(mod.CONTROL_ARM_FILE_RELATIVE_V2, "scripts/commander-native-tool-final-control-extension.ts");
	assert.equal(mod.TREATMENT_ARM_FILE_RELATIVE_V2, "extensions/workbench-runtime/index.ts");
});

// ------------------------------------------------------------------ static guards

test("static guard: imports are exactly the v2 core/protocol/policy leaf, the eight frozen v1 pure names and the five allowed node builtins — a single direct spawn with shell:false, the ONE guarded CLI entry (never run on import), no shell/network, no recursive/force removal, no rename and no v1 collector or v2 adapters", async () => {
	const source = await readFile(SOURCE_PATH, "utf8");
	// import statements may span multiple lines (the v2 protocol import is
	// multiline), so match whole statements — from the `import` keyword to the
	// terminating `;` — instead of assuming one statement per line
	const importStatements = [...source.matchAll(/^\s*import\b[\s\S]*?;\s*$/gm)].map((m) => m[0].trim());
	assert.ok(importStatements.length >= 12, `expected at least twelve frozen imports, found ${importStatements.length}`);

	// node builtins are limited to EXACTLY five specifiers: node:child_process
	// (spawn ONLY), node:crypto (randomUUID ONLY), node:fs/promises (value
	// import — the read-only surface plus the minimal persistence write
	// surface), node:fs (TYPE ONLY) and node:path (value import)
	const nodeImports = new Map<string, { typeOnly: boolean; names: string[] }>();
	for (const statement of importStatements) {
		const match = statement.match(/from\s+["'](node:[^"']+)["']/);
		if (!match) continue;
		const specifier = match[1];
		assert.ok(specifier !== undefined);
		const typeOnly = /^\s*import\s+type\b/.test(statement);
		const block = statement.match(/\{([^}]*)\}/);
		const names = block
			? [...(block[1] ?? "").matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)]
					.map((m) => m[1])
					.filter((n): n is string => n !== undefined && !["import", "type", "from"].includes(n))
			: [];
		nodeImports.set(specifier, { typeOnly, names });
	}
	assert.deepEqual([...nodeImports.keys()].sort(), ["node:child_process", "node:crypto", "node:fs", "node:fs/promises", "node:path"]);
	assert.deepEqual(nodeImports.get("node:child_process"), { typeOnly: false, names: ["spawn"] });
	assert.deepEqual(nodeImports.get("node:crypto"), { typeOnly: false, names: ["randomUUID"] });
	assert.deepEqual(nodeImports.get("node:fs"), { typeOnly: true, names: ["Dirent", "Stats"] });
	// the value import carries exactly the read-only surface plus the MINIMAL
	// persistence write surface — never a sync/stream/recursive/force/rename form
	// (names in the frozen source declaration order)
	assert.deepEqual(nodeImports.get("node:fs/promises"), { typeOnly: false, names: ["link", "lstat", "mkdir", "open", "readFile", "readdir", "rmdir", "stat", "unlink", "writeFile"] });
	assert.deepEqual(nodeImports.get("node:path"), { typeOnly: false, names: ["join", "resolve"] });
	// no other node: specifier appears anywhere in the imports
	for (const statement of importStatements) {
		assert.ok(!/from\s+["']node:(?!child_process["']|crypto["']|fs(?:\/promises)?["']|path["'])/.test(statement), statement);
	}

	// every RELATIVE import is the v2 core, the v2 protocol, the v2 POLICY
	// LEAF, or the v1 PURE core — nothing else (node: builtins are checked
	// separately above)
	for (const statement of importStatements) {
		const match = statement.match(/from\s+["']([^"']+)["']/);
		assert.ok(match, statement);
		const specifier = match[1];
		if (specifier !== undefined && specifier.startsWith("node:")) continue;
		assert.ok(
			specifier === "./commander-native-tool-benchmark-v2.ts" ||
				specifier === "./commander-native-tool-benchmark-v2-protocol.ts" ||
				specifier === "./commander-native-tool-benchmark-v2-policy.ts" ||
				specifier === "./commander-native-tool-benchmark.ts",
			`unexpected import specifier: ${specifier}`,
		);
	}
	// the v1 pure core is limited to EXACTLY the eight frozen names — the
	// three primitives, the three bounds constants, the canonical environment
	// builder and the session size cap; never the v1 classifier/parsers or
	// any other v1 name
	const v1CoreNames: string[] = [];
	for (const statement of importStatements) {
		const match = statement.match(/from\s+["']([^"']+)["']/);
		if (match && match[1] === "./commander-native-tool-benchmark.ts") {
			const block = statement.match(/\{([^}]*)\}/);
			const names = block
				? [...(block[1] ?? "").matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)]
						.map((m) => m[1])
						.filter((n): n is string => n !== undefined && !["import", "type", "from"].includes(n))
				: [];
			v1CoreNames.push(...names);
		}
	}
	assert.deepEqual([...new Set(v1CoreNames)].sort(), [
		"FIXTURE_MAX_BYTES",
		"FIXTURE_MAX_FILES",
		"PATH_MAX_BYTES",
		"SESSION_MAX_BYTES",
		"canonicalEnvironmentFile",
		"fixtureManifestHash",
		"parseSessionLines",
		"sha256Hex",
	]);
	// the v2 policy LEAF is limited to EXACTLY the frozen rubric constants
	// (`V2_RUBRIC_CHECKS` value, `RubricCheckV2` type) — never the evaluator
	const policyLeafNames: string[] = [];
	for (const statement of importStatements) {
		const match = statement.match(/from\s+["']([^"']+)["']/);
		if (match && match[1] === "./commander-native-tool-benchmark-v2-policy.ts") {
			const block = statement.match(/\{([^}]*)\}/);
			const names = block
				? [...(block[1] ?? "").matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)]
						.map((m) => m[1])
						.filter((n): n is string => n !== undefined && !["import", "type", "from"].includes(n))
				: [];
			policyLeafNames.push(...names);
		}
	}
	assert.deepEqual([...new Set(policyLeafNames)].sort(), ["RubricCheckV2", "V2_RUBRIC_CHECKS"]);
	// the v2 core import is EXACTLY the frozen value names (the derive/
	// full-validity chain plus the strict collection-record primitives) and
	// the frozen type names — never any other v2-core name
	const v2CoreValueNames: string[] = [];
	const v2CoreTypeNames: string[] = [];
	for (const statement of importStatements) {
		const match = statement.match(/from\s+["']([^"']+)["']/);
		if (!(match && match[1] === "./commander-native-tool-benchmark-v2.ts")) continue;
		const block = statement.match(/\{([^}]*)\}/);
		const names = block
			? [...(block[1] ?? "").matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)]
					.map((m) => m[1])
					.filter((n): n is string => n !== undefined && !["import", "type", "from"].includes(n))
			: [];
		if (/^\s*import\s+type\b/.test(statement)) v2CoreTypeNames.push(...names);
		else v2CoreValueNames.push(...names);
	}
	assert.deepEqual([...new Set(v2CoreValueNames)].sort(), ["abbaArmAtV2", "collectionRecordToJsonV2", "computeRunFactsV2", "deriveAttemptFactsV2", "parseCollectionRecordV2"]);
	assert.deepEqual([...new Set(v2CoreTypeNames)].sort(), ["AttemptCategoryV2", "AttemptFactsV2", "CollectionEntryV2", "CollectionRecordV2", "RunFactsV2", "V2FrozenProtocol"]);
	// no v1 collector / sibling adapter / v2 prepare-analyze adapter / provider
	// specifiers anywhere in the imports (the v2 POLICY LEAF is the only
	// policy-suffixed module allowed — the `-policy` fragment is therefore
	// NOT forbidden, only the `-prepare`/`-analyze` ADAPTER fragments are)
	for (const specifier of [
		"commander-native-tool-final-collect",
		"-prepare",
		"-analyze",
		"dev-pilot",
		"control-extension",
		"workbench-runtime",
		"cost-breakdown",
		"cache-benchmark",
	]) {
		assert.ok(!importStatements.some((statement) => statement.includes(specifier)), `forbidden import specifier fragment: ${specifier}`);
	}
	// v1 collector classifiers/parsers/preflight and the v2 prepare/analyze
	// adapter names never appear as identifiers anywhere in the source (the
	// \b boundary excludes the V2-suffixed collector natives)
	for (const banned of [
		"deriveAttemptFacts",
		"computeRunFacts",
		"parseManifest",
		"parseCollectionRecord",
		"analyzeManifestFile",
		"buildReport",
		"prepareEvidence",
		"nonTreatmentBundleHash",
		"preflightInputs",
		"FrozenInputsFacts",
		"requireFrozenProtocol",
		"preflightInputsV2",
		"FrozenInputsFactsV2",
		"parseRubricV2",
		"NroV2PrepareError",
		"NroV2AnalyzeError",
	]) {
		assert.ok(!new RegExp(`\\b${banned}\\b`).test(source), `v1 classifier/parser/collector or v2 adapter identifier must not appear: ${banned}`);
	}
	// the runner's direct spawn is the ONLY subprocess call site: shell
	// disabled, stdin ignored, stdout/stderr piped, exact argv/env/cwd
	assert.equal((source.match(/spawn\(/g) ?? []).length, 1, "exactly one spawn( call site in the source");
	assert.ok(source.includes("shell: false"), "the spawn call must disable the shell");
	assert.ok(source.includes('stdio: ["ignore", "pipe", "pipe"]'), "the spawn call must ignore stdin and pipe stdout/stderr");
	assert.ok(source.includes("process.version"), "the preflight must read the global process.version when called");
	// the frozen production runner envelope lives in the module
	for (const token of ["ATTEMPT_TIMEOUT_MS_V2", "TERMINATE_GRACE_MS_V2", "ATTEMPT_STDOUT_MAX_BYTES_V2", "ATTEMPT_STDERR_MAX_BYTES_V2", "SPAWN_START_FAILED_DETAIL_V2"]) {
		assert.ok(source.includes(token), `expected frozen runner constant: ${token}`);
	}
	// the FINAL collection loop is exported and composes the primitives
	// WITHOUT adding any import, spawn/open/randomUUID call site or fs
	// surface (the counts above stay frozen); the guarded CLI is the
	// module's only executable entry point and never runs on import
	assert.ok(source.includes("export async function collectFinalV2("), "the loop API must be exported");
	assert.ok(source.includes("afterPreflights"), "the loop must expose the afterPreflights hook");
	assert.ok(source.includes("ATTEMPT_START_FAILED") && source.includes("ATTEMPT_UNREPRESENTABLE"), "the two loop error codes must exist");
	// robust declaration/call-site check: `collectFinalV2(` occurs EXACTLY
	// once in the source and that occurrence IS the exported function
	// declaration itself — any additional occurrence or top-level
	// invocation fails
	const loopOccurrences = [...source.matchAll(/collectFinalV2\(/g)];
	assert.equal(loopOccurrences.length, 1, "the loop must be declared exactly once and never invoked at module top level");
	const loopDeclaration = source.match(/export async function collectFinalV2\(/);
	assert.ok(loopDeclaration !== null, "the loop API must be exported");
	const loopDeclarationAt = loopDeclaration.index ?? -1;
	const loopOccurrenceAt = loopOccurrences[0]?.index ?? -1;
	assert.equal(loopOccurrenceAt, loopDeclarationAt + "export async function ".length, "the single collectFinalV2( occurrence must be the exported declaration itself, never a call site");
	assert.ok(!/await\s+collectFinalV2\(/.test(source), "the loop must never be awaited or invoked at module top level");
	// forbidden tokens anywhere in the source: network, shell execution,
	// CLI, v1 capture, recursive/force removal, rename, sync/stream/copy fs
	// forms, crypto beyond randomUUID, and any child_process name beyond the
	// single spawn
	const forbidden = [
		// no other node builtins — network, runtime, url/os/process/buffer, workers
		"node:net",
		"node:http",
		"node:https",
		"node:tls",
		"node:dgram",
		"node:dns",
		"node:os",
		"node:url",
		"node:process",
		"node:buffer",
		"node:worker_threads",
		"node:inspector",
		// no shell execution or any child_process beyond the single spawn
		"exec(",
		"execFile",
		"spawnSync",
		"fork(",
		"shell: true",
		// no hard process exit — the CLI sets process.exitCode only
		"process.exit(",
		// no v1 capture
		"createCappedCapture(",
		// no recursive/force removal and no rename anywhere
		"rm(",
		"rmSync",
		"rename(",
		"renameSync",
		"recursive:",
		"force:",
		// no sync/stream/copy fs forms beyond the minimal async persistence surface
		"mkdirSync",
		"rmdirSync",
		"unlinkSync",
		"linkSync",
		"writeFileSync",
		"readFileSync",
		"lstatSync",
		"readdirSync",
		"statSync",
		"openSync",
		"existsSync",
		"appendFile",
		"truncate(",
		"chmod",
		"chown",
		"createWriteStream",
		"createReadStream",
		"copyFile",
		"cp(",
		// no crypto beyond randomUUID
		"createHash",
		"createHmac",
		"randomBytes",
		"createCipheriv",
		"createDecipheriv",
		"generateKeyPair",
		"scrypt",
		"pbkdf2",
		"timingSafeEqual",
		"webcrypto",
		// no network clients or servers
		"fetch(",
		"createServer",
		"http.request",
		"https.request",
	];
	for (const token of forbidden) {
		assert.ok(!source.includes(token), `forbidden token in source: ${token}`);
	}
	// the guarded CLI entry is the ONLY top-level executable statement:
	// `main` is declared exactly once and invoked exactly once, inside the
	// path-exact direct-execution guard — importing never runs it, and no
	// hard `process.exit(` call exists (the CLI sets process.exitCode)
	assert.equal((source.match(/export async function main\(/g) ?? []).length, 1, "the CLI entry must be declared exactly once");
	assert.equal((source.match(/await main\(/g) ?? []).length, 1, "the CLI entry must be invoked exactly once — inside the direct-execution guard");
	assert.equal((source.match(/import\.meta/g) ?? []).length, 1, "import.meta appears exactly once — the direct-execution guard");
	assert.equal((source.match(/process\.argv/g) ?? []).length, 3, "process.argv appears exactly three times — the direct-execution guard (argv[1] twice + argv.slice(2))");
	assert.equal((source.match(/process\.exitCode/g) ?? []).length, 1, "process.exitCode is set exactly once — never a hard process.exit call");
	assert.equal((source.match(/process\.exit\(/g) ?? []).length, 0, "no hard process.exit( call may exist");
	assert.ok(
		source.includes("if (process.argv[1] !== undefined && decodeURIComponent(new URL(import.meta.url).pathname) === resolve(process.argv[1])) {"),
		"the direct-execution guard must compare this module's own decoded file URL against the resolved first CLI argument",
	);
	assert.ok(source.includes("process.exitCode = await main(process.argv.slice(2));"), "the guard must run the CLI with the remaining argv only");
	// the CLI surface is exported for hermetic tests: usage, renderSummary,
	// the IO type, the collect function type and main
	assert.ok(source.includes("export function usage()"), "usage must be exported");
	assert.ok(source.includes("export function renderSummary("), "renderSummary must be exported");
	assert.ok(source.includes("export interface FinalIo"), "the IO type must be exported");
	assert.ok(source.includes("export type CollectFinalV2Fn ="), "the collect function type must be exported");
	// the fs call surface is EXACTLY the ten frozen async names — the
	// read-only lstat/readdir/readFile/stat plus the MINIMAL persistence
	// write surface mkdir/open/writeFile/link/rmdir/unlink
	for (const token of ["lstat(", "readdir(", "readFile(", "stat(", "mkdir(", "open(", "writeFile(", "link(", "rmdir(", "unlink("]) {
		assert.ok(source.includes(token), `expected fs call site: ${token}`);
	}
	// open( appears exactly four times — the three exclusive creates (the
	// initial record, the record temp and the retained source, every one
	// with "wx") plus the locator's single READ-ONLY open with "r"; no
	// other open form exists
	assert.equal((source.match(/open\(/g) ?? []).length, 4, "exactly four open( call sites in the source");
	assert.equal((source.match(/open\([^)]*,\s*"wx"/g) ?? []).length, 3, "exactly three exclusive-create wx open( call sites");
	assert.equal((source.match(/open\([^)]*,\s*"r"/g) ?? []).length, 1, "exactly one read-only open( call site");
	// randomUUID appears exactly twice — the unique temp/backup name call sites
	assert.equal((source.match(/randomUUID\(/g) ?? []).length, 2, "randomUUID is used exactly for the temp and backup names");
});

// ------------------------------------------------- persistence: initial record

/** The exact canonical bytes of the schema-2 initial record (single source of truth for the persistence tests). */
function initialRecordBytes(): Buffer {
	return Buffer.from(collectionRecordToJsonV2(buildInitialCollectionRecordV2()), "utf8");
}

/** No-follow lstat identity in the module's dev+ino+kind shape (mirror of the production helper). */
async function identityOf(path: string): Promise<FsIdentityV2> {
	const info = await lstat(path);
	return { dev: info.dev, ino: info.ino, kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other" };
}

/** Expect an initialization rejection with the exact collector error code (and optional exact message). */
async function expectInitError(
	runsDir: string,
	code: NroV2FinalCollectErrorCode,
	message?: string,
	protocol: V2FrozenProtocol = FROZEN_NRO_V2_PROTOCOL,
	hooks: InitializeCollectionStorageV2Hooks = {},
): Promise<void> {
	await assert.rejects(initializeCollectionStorageV2(runsDir, protocol, hooks), (error: unknown) => {
		assert.ok(error instanceof NroV2FinalCollectError, `expected NroV2FinalCollectError, got ${String(error)}`);
		assert.equal(error.code, code);
		assert.equal(error.name, "NroV2FinalCollectError");
		if (message !== undefined) assert.equal(error.message, message);
		return true;
	});
}

/** Assert that a rollback left the runs dir completely empty. */
async function assertRunsDirEmpty(runsDir: string): Promise<void> {
	assert.deepEqual(await readdir(runsDir), [], `runs dir must be empty after rollback: ${runsDir}`);
}

test("buildInitialCollectionRecordV2: the canonical schema-2 empty final record with the exact frozen protocol identity", () => {
	const record = buildInitialCollectionRecordV2();
	// exact schema-2 protocol identity
	assert.equal(record.schemaVersion, COLLECTION_SCHEMA_VERSION);
	assert.equal(record.schemaVersion, 2);
	assert.equal(record.protocolVersion, PROTOCOL_VERSION);
	assert.equal(record.protocolVersion, 2);
	assert.equal(record.protocolDoc, PROTOCOL_DOC);
	assert.equal(record.protocolDoc, "docs/baselines/commander-native-tool-benchmark-protocol-v2.md");
	assert.equal(record.phase, "final");
	// the four frozen content pins
	assert.equal(record.milestonePromptSha256, FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256);
	assert.equal(record.fixtureManifestSha256, FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256);
	assert.equal(record.nonTreatmentSha256, FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256);
	assert.equal(record.rubricSha256, FROZEN_NRO_V2_PROTOCOL.rubricSha256);
	for (const pin of [record.milestonePromptSha256, record.fixtureManifestSha256, record.nonTreatmentSha256, record.rubricSha256]) {
		assert.match(pin, /^[0-9a-f]{64}$/);
	}
	// the pinned environment and an EMPTY entries list — the pre-collection state
	assert.deepEqual(record.environment, FROZEN_ENVIRONMENT);
	assert.deepEqual(record.entries, []);
	// the explicit frozen protocol is identical to the default
	assert.deepEqual(buildInitialCollectionRecordV2(FROZEN_NRO_V2_PROTOCOL), record);
	// deterministic across calls
	assert.deepEqual(buildInitialCollectionRecordV2(), record);
});

test("buildInitialCollectionRecordV2: byte-exact canonical roundtrip with the frozen key order and formatting", () => {
	const record = buildInitialCollectionRecordV2();
	const canonical = collectionRecordToJsonV2(record);
	// the canonical text is the exact pretty-printed schema-2 record: frozen
	// key order, two-space indent, trailing newline, empty entries array
	const expected = [
		"{",
		'  "schema_version": 2,',
		'  "protocol_version": 2,',
		'  "protocol_doc": "docs/baselines/commander-native-tool-benchmark-protocol-v2.md",',
		'  "phase": "final",',
		`  "milestone_prompt_sha256": "${FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256}",`,
		`  "fixture_manifest_sha256": "${FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256}",`,
		`  "non_treatment_sha256": "${FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256}",`,
		`  "rubric_sha256": "${FROZEN_NRO_V2_PROTOCOL.rubricSha256}",`,
		'  "environment": {',
		`    "model_key": "${FROZEN_ENVIRONMENT.modelKey}",`,
		`    "thinking_level": "${FROZEN_ENVIRONMENT.thinkingLevel}",`,
		`    "pi_version": "${FROZEN_ENVIRONMENT.piVersion}",`,
		`    "node_version": "${FROZEN_ENVIRONMENT.nodeVersion}"`,
		"  },",
		'  "entries": []',
		"}",
		"",
	].join("\n");
	assert.equal(canonical, expected);
	// the strict re-parse roundtrips byte-exactly and reproduces the builder output
	const parsed = parseCollectionRecordV2(canonical);
	assert.deepEqual(parsed, record);
	assert.equal(collectionRecordToJsonV2(parsed), canonical);
	assert.equal(Buffer.compare(Buffer.from(canonical, "utf8"), initialRecordBytes()), 0);
	// determinism: identical canonical bytes across calls
	assert.equal(collectionRecordToJsonV2(buildInitialCollectionRecordV2()), canonical);
});

test("buildInitialCollectionRecordV2: every protocol/environment/cohort drift fails closed PROTOCOL_UNFROZEN before anything is built", () => {
	const driftProtocols: Array<{ name: string; protocol: V2FrozenProtocol }> = [
		{ name: "null milestone pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, milestonePromptSha256: null } },
		{ name: "null fixture pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, fixtureManifestSha256: null } },
		{ name: "null non-treatment pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, nonTreatmentSha256: null } },
		{ name: "null rubric pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, rubricSha256: null } },
		{ name: "drifted milestone pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, milestonePromptSha256: "0".repeat(64) } },
		{ name: "drifted fixture pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, fixtureManifestSha256: "1".repeat(64) } },
		{ name: "drifted non-treatment pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, nonTreatmentSha256: "2".repeat(64) } },
		{ name: "drifted rubric pin", protocol: { ...FROZEN_NRO_V2_PROTOCOL, rubricSha256: "3".repeat(64) } },
		{ name: "drifted model key", protocol: { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, modelKey: "openai-codex/gpt-4o" } } },
		{ name: "drifted thinking level", protocol: { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, thinkingLevel: "low" } } },
		{ name: "drifted pi version", protocol: { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, piVersion: "0.82.0" } } },
		{ name: "drifted node version", protocol: { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, nodeVersion: "v25.0.0" } } },
		{ name: "drifted runsPerArm", protocol: { ...FROZEN_NRO_V2_PROTOCOL, runsPerArm: 21 } },
		{ name: "drifted interleave", protocol: { ...FROZEN_NRO_V2_PROTOCOL, interleave: "BABA" } as unknown as V2FrozenProtocol },
	];
	for (const c of driftProtocols) {
		assert.throws(
			() => buildInitialCollectionRecordV2(c.protocol),
			(error: unknown) => {
				assert.ok(error instanceof NroV2FinalCollectError, c.name);
				assert.equal(error.code, "PROTOCOL_UNFROZEN", c.name);
				assert.equal(error.name, "NroV2FinalCollectError", c.name);
				assert.equal(error.message, PROTOCOL_UNFROZEN_MESSAGE, c.name);
				assert.ok(error.message.length <= 200, c.name);
				return true;
			},
			c.name,
		);
	}
	// the frozen protocol still builds after every drift case
	assert.deepEqual(buildInitialCollectionRecordV2(FROZEN_NRO_V2_PROTOCOL), buildInitialCollectionRecordV2());
});

// ----------------------------------------------- persistence: initialization

test("initializeCollectionStorageV2: exclusive success — exact paths, canonical bytes, owned identities and relative-only public facts", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "SECRET-RUNS-9f2c");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		// the storage exposes only the frozen RELATIVE names — never absolute paths
		assert.equal(storage.rootName, OUTPUT_ROOT_NAME_V2);
		assert.equal(storage.sourcesName, SOURCES_DIR_NAME_V2);
		assert.equal(storage.sourcesName, "sources");
		assert.equal(storage.recordName, COLLECTION_RECORD_NAME);
		assert.equal(storage.recordName, "collection-record.json");
		// the exact layout exists with the exact entry kinds
		assert.ok((await lstat(rootPath)).isDirectory(), "root must be a real directory");
		assert.ok((await lstat(sourcesPath)).isDirectory(), "sources must be a real directory");
		assert.ok((await lstat(recordPath)).isFile(), "record must be a regular file");
		assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
		assert.deepEqual(await readdir(sourcesPath), []);
		// the record bytes are EXACTLY the canonical initial record
		assert.equal(Buffer.compare(await readFile(recordPath), initialRecordBytes()), 0);
		// byte-exact strict re-parse roundtrip of the persisted record
		const text = (await readFile(recordPath)).toString("utf8");
		assert.deepEqual(parseCollectionRecordV2(text), buildInitialCollectionRecordV2());
		assert.equal(collectionRecordToJsonV2(parseCollectionRecordV2(text)), text);
		// owned no-follow identities: dev+ino+kind tracked from the created entries
		assert.deepEqual(storage.rootIdentity, await identityOf(rootPath));
		assert.equal(storage.rootIdentity.kind, "directory");
		assert.deepEqual(storage.sourcesIdentity, await identityOf(sourcesPath));
		assert.equal(storage.sourcesIdentity.kind, "directory");
		assert.deepEqual(storage.recordIdentity, await identityOf(recordPath));
		assert.equal(storage.recordIdentity.kind, "file");
		assert.ok(storage.rootIdentity.dev !== 0 && storage.rootIdentity.ino !== 0, "root identity must carry a real dev+ino");
		assert.ok(storage.sourcesIdentity.dev !== 0 && storage.sourcesIdentity.ino !== 0, "sources identity must carry a real dev+ino");
		assert.ok(storage.recordIdentity.dev !== 0 && storage.recordIdentity.ino !== 0, "record identity must carry a real dev+ino");
		assert.notDeepEqual(storage.sourcesIdentity, storage.rootIdentity, "sources must be a distinct owned entry");
		// JSON serialization exposes the frozen relative names and identities ONLY
		const json = JSON.stringify(storage);
		assert.deepEqual(JSON.parse(json), {
			rootName: OUTPUT_ROOT_NAME_V2,
			sourcesName: SOURCES_DIR_NAME_V2,
			recordName: COLLECTION_RECORD_NAME,
			rootIdentity: storage.rootIdentity,
			sourcesIdentity: storage.sourcesIdentity,
		});
		assert.ok(!json.includes(runsDir), "serialized storage leaks the runs dir");
		assert.ok(!json.includes("SECRET-RUNS-9f2c"), "serialized storage leaks the runs dir basename");
		assert.ok(!json.includes(recordPath), "serialized storage leaks the absolute record path");
		// the absolute plumbing exists only as in-process getters — never serialized
		assert.equal(storage.rootPathAbs, rootPath);
		assert.equal(storage.sourcesPathAbs, sourcesPath);
		assert.equal(storage.recordPathAbs, recordPath);
		// deterministic: a fresh initialization writes byte-identical records and identical public names
		const runsDir2 = join(root, "runs-2");
		await mkdir(runsDir2);
		const storage2 = await initializeCollectionStorageV2(runsDir2);
		assert.equal(Buffer.compare(await readFile(join(runsDir2, OUTPUT_ROOT_NAME_V2, COLLECTION_RECORD_NAME)), initialRecordBytes()), 0);
		assert.equal(storage2.rootName, storage.rootName);
		assert.equal(storage2.sourcesName, storage.sourcesName);
		assert.equal(storage2.recordName, storage.recordName);
	});
	// the storage class is constructible ONLY through the module factory — a foreign brand is refused
	const Forge = CollectionStorageV2 as unknown as new (rootPath: string, rootIdentity: FsIdentityV2, sourcesIdentity: FsIdentityV2, recordIdentity: FsIdentityV2, brand: unknown) => CollectionStorageV2;
	assert.throws(
		() => new Forge("/tmp/foreign-root", { dev: 1, ino: 1, kind: "directory" }, { dev: 1, ino: 2, kind: "directory" }, { dev: 1, ino: 3, kind: "file" }, Symbol("foreign-brand")),
		TypeError,
		"a foreign brand must be refused by the module-private constructor",
	);
});

test("initializeCollectionStorageV2: protocol drift fails closed PROTOCOL_UNFROZEN before any filesystem access", async () => {
	await withTempDir(async (root) => {
		// a nonexistent runs dir proves the drift check runs before ANY fs access
		const phantom = join(root, "does-not-exist-7f2b");
		await expectInitError(phantom, "PROTOCOL_UNFROZEN", PROTOCOL_UNFROZEN_MESSAGE, { ...FROZEN_NRO_V2_PROTOCOL, milestonePromptSha256: null });
		await expectInitError(phantom, "PROTOCOL_UNFROZEN", PROTOCOL_UNFROZEN_MESSAGE, { ...FROZEN_NRO_V2_PROTOCOL, environment: { ...FROZEN_ENVIRONMENT, modelKey: "openai-codex/gpt-4o" } });
		await expectInitError(phantom, "PROTOCOL_UNFROZEN", PROTOCOL_UNFROZEN_MESSAGE, { ...FROZEN_NRO_V2_PROTOCOL, runsPerArm: 21 });
		// with a real runs dir, drift still wins and nothing is created
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		await expectInitError(runsDir, "PROTOCOL_UNFROZEN", PROTOCOL_UNFROZEN_MESSAGE, { ...FROZEN_NRO_V2_PROTOCOL, rubricSha256: "0".repeat(64) });
		await assertRunsDirEmpty(runsDir);
		// the frozen protocol still initializes
		const storage = await initializeCollectionStorageV2(runsDir);
		assert.equal(Buffer.compare(await readFile(join(runsDir, OUTPUT_ROOT_NAME_V2, COLLECTION_RECORD_NAME)), initialRecordBytes()), 0);
		assert.equal(storage.rootName, OUTPUT_ROOT_NAME_V2);
	});
});

test("initializeCollectionStorageV2: pre-existing and racing entries are refused EXISTING_OUTPUT and never overwritten", async () => {
	// a pre-existing output root is refused without touching it
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await mkdir(rootPath);
		await writeFile(join(rootPath, "marker-SECRET-7f1a.txt"), "foreign marker\n", "utf8");
		await expectInitError(runsDir, "EXISTING_OUTPUT", `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}" already exists and is never overwritten`);
		assert.equal(await readFile(join(rootPath, "marker-SECRET-7f1a.txt"), "utf8"), "foreign marker\n");
		assert.deepEqual(await readdir(rootPath), ["marker-SECRET-7f1a.txt"]);
	});
	// a racing sources/ entry injected after the root create is refused and preserved
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await expectInitError(
			runsDir,
			"EXISTING_OUTPUT",
			`the v2 sources directory "${SOURCES_DIR_NAME_V2}" already exists and is never overwritten`,
			FROZEN_NRO_V2_PROTOCOL,
			{
				afterRootCreate: async () => {
					await mkdir(join(rootPath, SOURCES_DIR_NAME_V2));
					await writeFile(join(rootPath, SOURCES_DIR_NAME_V2, "foreign-sources-child.txt"), "foreign\n", "utf8");
				},
			},
		);
		// the foreign sources dir survives with its child; the owned root survives with it (never removed)
		assert.equal(await readFile(join(rootPath, SOURCES_DIR_NAME_V2, "foreign-sources-child.txt"), "utf8"), "foreign\n");
		assert.ok((await lstat(rootPath)).isDirectory(), "the owned root must survive with its foreign child");
	});
	// a racing record file injected after the sources create is refused and preserved
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await expectInitError(
			runsDir,
			"EXISTING_OUTPUT",
			`the v2 collection record "${COLLECTION_RECORD_NAME}" already exists and is never overwritten`,
			FROZEN_NRO_V2_PROTOCOL,
			{
				afterSourcesCreate: async () => {
					await writeFile(join(rootPath, COLLECTION_RECORD_NAME), "SECRET-foreign-record\n", "utf8");
				},
			},
		);
		// the foreign record survives byte-identical; the owned sources were rolled back; the root survives with the foreign record
		assert.equal(await readFile(join(rootPath, COLLECTION_RECORD_NAME), "utf8"), "SECRET-foreign-record\n");
		assert.ok(!existsSync(join(rootPath, SOURCES_DIR_NAME_V2)), "the owned sources dir must be rolled back");
		assert.ok((await lstat(rootPath)).isDirectory(), "the owned root must survive with its foreign child");
	});
});

test("initializeCollectionStorageV2: the five deterministic hook stages run in order on success", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const order: string[] = [];
		const storage = await initializeCollectionStorageV2(runsDir, FROZEN_NRO_V2_PROTOCOL, {
			afterRootCreate: () => {
				order.push("afterRootCreate");
			},
			afterSourcesCreate: () => {
				order.push("afterSourcesCreate");
			},
			afterRecordOpen: () => {
				order.push("afterRecordOpen");
			},
			afterRecordCommit: () => {
				order.push("afterRecordCommit");
			},
			afterRecordReadBack: () => {
				order.push("afterRecordReadBack");
			},
		});
		assert.deepEqual(order, ["afterRootCreate", "afterSourcesCreate", "afterRecordOpen", "afterRecordCommit", "afterRecordReadBack"]);
		// the success path returned a fully committed storage
		assert.equal(storage.rootName, OUTPUT_ROOT_NAME_V2);
		assert.equal(Buffer.compare(await readFile(join(runsDir, OUTPUT_ROOT_NAME_V2, COLLECTION_RECORD_NAME)), initialRecordBytes()), 0);
	});
});

test("initializeCollectionStorageV2: every hook failure propagates unchanged after identity-owned non-recursive rollback", async () => {
	for (const hook of ["afterRootCreate", "afterSourcesCreate", "afterRecordOpen", "afterRecordCommit", "afterRecordReadBack"] as const) {
		await withTempDir(async (root) => {
			const runsDir = join(root, "runs");
			await mkdir(runsDir);
			const hookError = new Error(`hook-failure-${hook}-9f2c`);
			// one asynchronous rejection proves async hooks are awaited
			const hooks: InitializeCollectionStorageV2Hooks = {};
			if (hook === "afterRecordCommit") hooks.afterRecordCommit = () => Promise.reject(hookError);
			else hooks[hook] = () => {
				throw hookError;
			};
			await assert.rejects(
				initializeCollectionStorageV2(runsDir, FROZEN_NRO_V2_PROTOCOL, hooks),
				(error: unknown) => error === hookError,
				`${hook} must propagate the hook's own error unchanged`,
			);
			// non-recursive owned-only rollback: nothing the invocation created survives
			await assertRunsDirEmpty(runsDir);
		});
	}
});

test("initializeCollectionStorageV2: root/sources/record replacement races fail closed without touching the foreign entry", async () => {
	// root replaced after its create — no descendant ever lands inside the foreign root
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await expectInitError(
			runsDir,
			"STORAGE_IO",
			`the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}" was replaced or is no longer the owned entry`,
			FROZEN_NRO_V2_PROTOCOL,
			{
				afterRootCreate: async () => {
					await rm(rootPath, { recursive: true }); // the owned root is empty at this stage
					await mkdir(rootPath); // a foreign root occupies the name
					await writeFile(join(rootPath, "foreign-root-marker.txt"), "foreign\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(join(rootPath, "foreign-root-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual(await readdir(rootPath), ["foreign-root-marker.txt"]);
	});
	// root replaced after the sources create — the record is never created inside the foreign root
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await expectInitError(
			runsDir,
			"STORAGE_IO",
			`the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}" was replaced or is no longer the owned entry`,
			FROZEN_NRO_V2_PROTOCOL,
			{
				afterSourcesCreate: async () => {
					await rm(rootPath, { recursive: true }); // the owned root (and its owned sources) is destroyed by the hook
					await mkdir(rootPath); // a foreign root occupies the name
				},
			},
		);
		// the foreign root survives empty — the record was never created inside it
		assert.ok((await lstat(rootPath)).isDirectory(), "the foreign root must survive");
		assert.deepEqual(await readdir(rootPath), []);
	});
	// sources replaced after its create — the record is never created inside the foreign sources
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		await expectInitError(
			runsDir,
			"STORAGE_IO",
			`the v2 sources directory "${SOURCES_DIR_NAME_V2}" was replaced or is no longer the owned entry`,
			FROZEN_NRO_V2_PROTOCOL,
			{
				afterSourcesCreate: async () => {
					await rm(sourcesPath, { recursive: true }); // empty at this stage
					await mkdir(sourcesPath);
					await writeFile(join(sourcesPath, "foreign-sources-marker.txt"), "foreign\n", "utf8");
				},
			},
		);
		// the foreign sources survive untouched; the owned root survives only because it holds the foreign entry
		assert.equal(await readFile(join(sourcesPath, "foreign-sources-marker.txt"), "utf8"), "foreign\n");
		assert.ok(!existsSync(join(rootPath, COLLECTION_RECORD_NAME)), "no record may exist inside a foreign sources entry");
		assert.ok((await lstat(rootPath)).isDirectory(), "the owned root must survive with its foreign child");
	});
	// the record replaced after its open — the write lands on the owned inode and the foreign file fails read-back
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		await expectInitError(
			runsDir,
			"RECORD_IO",
			`the v2 collection record "${COLLECTION_RECORD_NAME}" does not match the canonical record`,
			FROZEN_NRO_V2_PROTOCOL,
			{
				afterRecordOpen: async () => {
					await rm(recordPath);
					await writeFile(recordPath, "SECRET-foreign-record\n", "utf8");
				},
			},
		);
		// the foreign record file survives byte-identical; the owned sources were rolled back; the root survives with the foreign record
		assert.equal(await readFile(recordPath, "utf8"), "SECRET-foreign-record\n");
		assert.ok(!existsSync(join(rootPath, SOURCES_DIR_NAME_V2)), "the owned sources dir must be rolled back");
		assert.ok((await lstat(rootPath)).isDirectory(), "the owned root must survive with its foreign child");
	});
	// the record replaced after its commit — same fail-closed read-back mismatch
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		await expectInitError(
			runsDir,
			"RECORD_IO",
			`the v2 collection record "${COLLECTION_RECORD_NAME}" does not match the canonical record`,
			FROZEN_NRO_V2_PROTOCOL,
			{
				afterRecordCommit: async () => {
					await rm(recordPath);
					await writeFile(recordPath, "SECRET-foreign-record\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(recordPath, "utf8"), "SECRET-foreign-record\n");
		assert.ok(!existsSync(join(rootPath, SOURCES_DIR_NAME_V2)), "the owned sources dir must be rolled back");
		assert.ok((await lstat(rootPath)).isDirectory(), "the owned root must survive with its foreign child");
	});
	// the record replaced after the successful read-back — the final identity revalidation fails closed
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		await expectInitError(
			runsDir,
			"STORAGE_IO",
			`the v2 collection record "${COLLECTION_RECORD_NAME}" was replaced or is no longer the owned entry`,
			FROZEN_NRO_V2_PROTOCOL,
			{
				afterRecordReadBack: async () => {
					await rm(recordPath);
					await writeFile(recordPath, "SECRET-foreign-record\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(recordPath, "utf8"), "SECRET-foreign-record\n");
		assert.ok(!existsSync(join(rootPath, SOURCES_DIR_NAME_V2)), "the owned sources dir must be rolled back");
		assert.ok((await lstat(rootPath)).isDirectory(), "the owned root must survive with its foreign child");
	});
});

test("initializeCollectionStorageV2: foreign children survive identity-owned rollback and never disturb success", async () => {
	// foreign children injected into the owned root and sources survive a hook-failure rollback
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const hookError = new Error("hook-failure-foreign-children-7f2b");
		await assert.rejects(
			initializeCollectionStorageV2(runsDir, FROZEN_NRO_V2_PROTOCOL, {
				afterSourcesCreate: async () => {
					await writeFile(join(rootPath, "foreign-root-child.txt"), "root child\n", "utf8");
					await writeFile(join(sourcesPath, "foreign-sources-child.txt"), "sources child\n", "utf8");
				},
				afterRecordCommit: () => {
					throw hookError;
				},
			}),
			(error: unknown) => error === hookError,
		);
		// the owned record is removed; the owned entries holding foreign children are left in place
		assert.ok(!existsSync(join(rootPath, COLLECTION_RECORD_NAME)), "the owned record must be rolled back");
		assert.equal(await readFile(join(rootPath, "foreign-root-child.txt"), "utf8"), "root child\n");
		assert.equal(await readFile(join(sourcesPath, "foreign-sources-child.txt"), "utf8"), "sources child\n");
		assert.ok((await lstat(sourcesPath)).isDirectory(), "the owned sources dir survives with its foreign child");
		assert.ok((await lstat(rootPath)).isDirectory(), "the owned root survives with its foreign children");
	});
	// foreign children never disturb a successful initialization and are never removed
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const storage = await initializeCollectionStorageV2(runsDir, FROZEN_NRO_V2_PROTOCOL, {
			afterSourcesCreate: async () => {
				await writeFile(join(sourcesPath, "foreign-sources-child.txt"), "sources child\n", "utf8");
			},
			afterRecordReadBack: async () => {
				await writeFile(join(rootPath, "foreign-root-child.txt"), "root child\n", "utf8");
			},
		});
		assert.equal(Buffer.compare(await readFile(join(rootPath, COLLECTION_RECORD_NAME)), initialRecordBytes()), 0);
		assert.equal(await readFile(join(sourcesPath, "foreign-sources-child.txt"), "utf8"), "sources child\n");
		assert.equal(await readFile(join(rootPath, "foreign-root-child.txt"), "utf8"), "root child\n");
		assert.deepEqual(storage.rootIdentity, await identityOf(rootPath));
		assert.deepEqual(storage.recordIdentity, await identityOf(join(rootPath, COLLECTION_RECORD_NAME)));
	});
});

test("initializeCollectionStorageV2: errors carry frozen relative names only — never absolute roots, raw fs text or record content", async () => {
	await withTempDir(async (root) => {
		const scenarios: Array<{ name: string; prepare: (runsDir: string) => Promise<() => Promise<unknown>>; secrets: string[] }> = [
			{
				name: "preexisting root",
				prepare: async (runsDir) => {
					await mkdir(join(runsDir, OUTPUT_ROOT_NAME_V2));
					return () => initializeCollectionStorageV2(runsDir);
				},
				secrets: [],
			},
			{
				name: "root replacement",
				prepare: (runsDir) =>
					Promise.resolve(() =>
						initializeCollectionStorageV2(runsDir, FROZEN_NRO_V2_PROTOCOL, {
							afterRootCreate: async () => {
								await rm(join(runsDir, OUTPUT_ROOT_NAME_V2), { recursive: true });
								await mkdir(join(runsDir, OUTPUT_ROOT_NAME_V2));
							},
						}),
					),
				secrets: [],
			},
			{
				name: "record replacement",
				prepare: (runsDir) =>
					Promise.resolve(() =>
						initializeCollectionStorageV2(runsDir, FROZEN_NRO_V2_PROTOCOL, {
							afterRecordOpen: async () => {
								await rm(join(runsDir, OUTPUT_ROOT_NAME_V2, COLLECTION_RECORD_NAME));
								await writeFile(join(runsDir, OUTPUT_ROOT_NAME_V2, COLLECTION_RECORD_NAME), "SECRET-RECORD-BODY-31\n", "utf8");
							},
						}),
					),
				secrets: ["SECRET-RECORD-BODY-31"],
			},
			{
				name: "injected collision",
				prepare: (runsDir) =>
					Promise.resolve(() =>
						initializeCollectionStorageV2(runsDir, FROZEN_NRO_V2_PROTOCOL, {
							afterRootCreate: async () => {
								await mkdir(join(runsDir, OUTPUT_ROOT_NAME_V2, SOURCES_DIR_NAME_V2));
								await writeFile(join(runsDir, OUTPUT_ROOT_NAME_V2, SOURCES_DIR_NAME_V2, "SECRET-CHILD-77.txt"), "x\n", "utf8");
							},
						}),
					),
				secrets: ["SECRET-CHILD-77.txt"],
			},
		];
		let n = 0;
		for (const s of scenarios) {
			n += 1;
			const runsDir = join(root, `SECRET-RUNS-${String(n).padStart(2, "0")}`);
			await mkdir(runsDir);
			const run = await s.prepare(runsDir);
			const error = await run().then(
				() => null,
				(e: unknown) => e,
			);
			assert.ok(error instanceof NroV2FinalCollectError, `${s.name} must fail closed`);
			const text = `${error.name} ${error.code} ${error.message}`;
			assert.ok(!text.includes(root), `${s.name}: error leaks the temp root`);
			assert.ok(!text.includes(runsDir), `${s.name}: error leaks the runs dir`);
			assert.ok(!text.includes(`SECRET-RUNS-${String(n).padStart(2, "0")}`), `${s.name}: error leaks the runs dir basename`);
			for (const secret of [...s.secrets, "ENOENT", "ENOTDIR", "EACCES", "EPERM", "Error:", "node:"]) {
				assert.ok(!text.includes(secret), `${s.name}: error leaks "${secret}": ${text}`);
			}
			assert.ok(!/[\u0000-\u001f\u007f]/.test(text), `${s.name}: error message contains control characters`);
			assert.ok(error.message.length <= 200, `${s.name}: error message exceeds the bounded length`);
		}
	});
});

// ------------------------------------------------ persistence: record writes

/** One canonical strict-valid entry bound to its frozen ABBA position (arm from the v2 core). */
function canonicalEntry(position: number, kind: CollectionEntryKindV2, path: string, expectedSessionSha256: string = sha256Hex(path)): CollectionEntryV2 {
	return { kind, arm: abbaArmAtV2(position), path, expectedSessionSha256 };
}

/**
 * A strict canonical updated record built through the ACTUAL serializer/
 * parser contract: serialize, strict-parse, require the byte-exact
 * re-serialization and return the PARSED record — exactly the canonical
 * form `writeCollectionRecordV2` itself verifies before any write.
 */
function canonicalRecordWithEntries(entries: readonly CollectionEntryV2[]): CollectionRecordV2 {
	const text = collectionRecordToJsonV2({ ...buildInitialCollectionRecordV2(), entries: [...entries] });
	const parsed = parseCollectionRecordV2(text);
	assert.equal(collectionRecordToJsonV2(parsed), text, "the canonical updated record must re-serialize byte-exactly");
	return parsed;
}

/** The frozen hidden temp/backup name prefix the persistence core generates under the owned root. */
const HIDDEN_ENTRY_PREFIX = `.${COLLECTION_RECORD_NAME}.`;

/**
 * Deterministic discovery of the generated hidden temp/backup entries under
 * the owned root (suffix ".tmp"/".bak") — tests may inspect the generated
 * names internally, but never assert or leak them as API.
 */
async function hiddenEntries(rootPath: string, suffix?: string): Promise<string[]> {
	const names = (await readdir(rootPath)).filter((n) => n.startsWith(HIDDEN_ENTRY_PREFIX) && (suffix === undefined || n.endsWith(suffix)));
	return names.sort();
}

/** The canonical single-entry updated record used across the write tests (position-1 session, control). */
const WRITE_ENTRY_1 = canonicalEntry(1, "session", "sources/control/session-01.jsonl");
/** Position-2 attempt (retries the position without advancing it). */
const WRITE_ENTRY_2 = canonicalEntry(2, "attempt", "sources/control/attempt-02.jsonl");
/** Position-2 session (fills and advances the position). */
const WRITE_ENTRY_3 = canonicalEntry(2, "session", "sources/treatment/session-02.jsonl");

/**
 * Expect a record-write rejection with the exact collector error code and
 * committed flag; returns the structured error for further assertions.
 */
async function expectWriteError(
	storage: CollectionStorageV2,
	record: CollectionRecordV2,
	code: NroV2FinalCollectErrorCode,
	committed: boolean,
	message?: string,
	hooks: WriteCollectionRecordV2Hooks = {},
): Promise<NroV2RecordWriteError> {
	let caught: unknown;
	try {
		await writeCollectionRecordV2(storage, record, hooks);
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof NroV2RecordWriteError, `expected NroV2RecordWriteError, got ${String(caught)}`);
	assert.ok(caught instanceof NroV2FinalCollectError, "NroV2RecordWriteError must extend NroV2FinalCollectError");
	assert.ok(caught instanceof Error, "NroV2RecordWriteError must extend Error");
	assert.equal(caught.code, code);
	assert.equal(caught.committed, committed);
	if (message !== undefined) assert.equal(caught.message, message);
	return caught;
}

test("NroV2RecordWriteError: structured write failures carry the code, the committed flag and the collector error lineage", () => {
	const error = new NroV2RecordWriteError("STORAGE_IO", "a fixed privacy-safe message", true);
	assert.ok(error instanceof Error);
	assert.ok(error instanceof NroV2FinalCollectError);
	assert.ok(error instanceof NroV2RecordWriteError);
	assert.equal(error.code, "STORAGE_IO");
	assert.equal(error.committed, true);
	assert.equal(error.message, "a fixed privacy-safe message");
	// JSON serialization exposes the structured fields only — never the message
	const json = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
	assert.deepEqual(Object.keys(json).sort(), ["code", "committed", "name"]);
	// the committed flag is a plain boolean in every direction
	assert.equal(new NroV2RecordWriteError("RECORD_IO", "m", false).committed, false);
	assert.equal(new NroV2RecordWriteError("RECORD_INVALID", "m", false).committed, false);
});

test("writeCollectionRecordV2: strict invalid records are rejected RECORD_INVALID before any temp write", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		const priorBytes = await readFile(recordPath);
		const priorIdentity = storage.recordIdentity;
		const invalidRecords: Array<{ name: string; record: CollectionRecordV2 }> = [
			{
				name: "wrong arm at ABBA position 1",
				record: {
					...buildInitialCollectionRecordV2(),
					entries: [{ kind: "session", arm: "treatment", path: "sources/treatment/session-01.jsonl", expectedSessionSha256: sha256Hex("wrong-arm") }],
				},
			},
			{
				name: "non-hex session sha",
				record: {
					...buildInitialCollectionRecordV2(),
					entries: [{ kind: "session", arm: "control", path: "sources/control/session-01.jsonl", expectedSessionSha256: "Z".repeat(64) }],
				},
			},
			{
				name: "absolute path",
				record: {
					...buildInitialCollectionRecordV2(),
					entries: [{ kind: "session", arm: "control", path: "/etc/passwd", expectedSessionSha256: sha256Hex("absolute") }],
				},
			},
			{
				name: "unsafe basename",
				record: {
					...buildInitialCollectionRecordV2(),
					entries: [{ kind: "session", arm: "control", path: "sources/.hidden.jsonl", expectedSessionSha256: sha256Hex("hidden") }],
				},
			},
			{
				name: "unknown entry kind",
				record: {
					...buildInitialCollectionRecordV2(),
					entries: [{ kind: "bogus", arm: "control", path: "sources/control/session-01.jsonl", expectedSessionSha256: sha256Hex("bogus") }] as unknown as CollectionEntryV2[],
				},
			},
			{
				name: "duplicate declared paths",
				record: {
					...buildInitialCollectionRecordV2(),
					entries: [
						WRITE_ENTRY_1,
						{ kind: "attempt", arm: abbaArmAtV2(2), path: WRITE_ENTRY_1.path, expectedSessionSha256: sha256Hex("duplicate") },
					],
				},
			},
		];
		for (const c of invalidRecords) {
			const hookCalls: string[] = [];
			const error = await expectWriteError(
				storage,
				c.record,
				"RECORD_INVALID",
				false,
				"the collection record failed the strict v2 collection-record parse",
				{
					afterTempCommit: () => {
						hookCalls.push("afterTempCommit");
					},
				},
			);
			// no write hook ever ran — the strict parse precedes ANY filesystem mutation
			assert.deepEqual(hookCalls, [], c.name);
			assert.equal(error.committed, false, c.name);
			// the record file is byte-identical and the tracked identity unchanged
			assert.equal(Buffer.compare(await readFile(recordPath), priorBytes), 0, c.name);
			assert.deepEqual(storage.recordIdentity, priorIdentity, c.name);
			// no temp/backup entry ever appeared in the root
			assert.deepEqual(await hiddenEntries(rootPath), [], c.name);
			assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2], c.name);
		}
		// the strict parse precedes even the root gate: with a replaced (foreign) root the
		// invalid record still fails RECORD_INVALID, never STORAGE_IO, and nothing is written
		await rm(rootPath, { recursive: true });
		await mkdir(rootPath);
		await writeFile(join(rootPath, "foreign-marker.txt"), "foreign\n", "utf8");
		await expectWriteError(storage, invalidRecords[0]?.record ?? buildInitialCollectionRecordV2(), "RECORD_INVALID", false);
		assert.deepEqual(await readdir(rootPath), ["foreign-marker.txt"]);
	});
});

test("writeCollectionRecordV2: successful update is byte-exact at the canonical target with strict parse roundtrip and a tracked record inode update", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		const initialIdentity = storage.recordIdentity;
		const record = canonicalRecordWithEntries([WRITE_ENTRY_1]);
		const canonicalText = collectionRecordToJsonV2(record);
		const canonicalBytes = Buffer.from(canonicalText, "utf8");
		// the updated record is strict-valid through the actual serializer/parser contract
		assert.deepEqual(parseCollectionRecordV2(canonicalText), record);
		assert.equal(collectionRecordToJsonV2(parseCollectionRecordV2(canonicalText)), canonicalText);
		// the write returns the SAME tracked storage object
		const result = await writeCollectionRecordV2(storage, record);
		assert.equal(result, storage);
		// byte-exact at the canonical target
		assert.equal(Buffer.compare(await readFile(recordPath), canonicalBytes), 0);
		// strict parse roundtrip of the persisted bytes
		const text = (await readFile(recordPath)).toString("utf8");
		assert.deepEqual(parseCollectionRecordV2(text), record);
		assert.equal(collectionRecordToJsonV2(parseCollectionRecordV2(text)), text);
		// the tracked record identity follows the published inode: NEW dev+ino, same kind
		assert.deepEqual(storage.recordIdentity, await identityOf(recordPath));
		assert.equal(storage.recordIdentity.kind, "file");
		assert.ok(storage.recordIdentity.ino !== initialIdentity.ino, "the published record must be a NEW inode");
		// the publish is a hard-link move: exactly one name links the committed inode
		assert.equal((await lstat(recordPath)).nlink, 1);
		// the parked backup was superseded and removed — only the two owned entries remain
		assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
		assert.deepEqual(await hiddenEntries(rootPath), []);
		// sources untouched
		assert.deepEqual(await readdir(sourcesPath), []);
	});
});

test("writeCollectionRecordV2: multiple sequential writes each update the canonical bytes and the tracked identity", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		const sequence = [
			{ record: canonicalRecordWithEntries([WRITE_ENTRY_1]), entries: 1 },
			{ record: canonicalRecordWithEntries([WRITE_ENTRY_1, WRITE_ENTRY_2]), entries: 2 },
			{ record: canonicalRecordWithEntries([WRITE_ENTRY_1, WRITE_ENTRY_2, WRITE_ENTRY_3]), entries: 3 },
		];
		let previousIdentity = storage.recordIdentity;
		for (const step of sequence) {
			await writeCollectionRecordV2(storage, step.record);
			const text = (await readFile(recordPath)).toString("utf8");
			assert.equal(text, collectionRecordToJsonV2(step.record));
			assert.deepEqual(parseCollectionRecordV2(text), step.record);
			assert.equal(parseCollectionRecordV2(text).entries.length, step.entries);
			// every committed write publishes a NEW inode and tracks it
			assert.deepEqual(storage.recordIdentity, await identityOf(recordPath));
			assert.ok(storage.recordIdentity.ino !== previousIdentity.ino, "every committed write must publish a NEW inode");
			previousIdentity = storage.recordIdentity;
			// no temp/backup residue between writes
			assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
			assert.deepEqual(await hiddenEntries(rootPath), []);
		}
		// the final record is the exact strict chronological prefix
		const final = parseCollectionRecordV2((await readFile(recordPath)).toString("utf8"));
		assert.deepEqual(final.entries, [WRITE_ENTRY_1, WRITE_ENTRY_2, WRITE_ENTRY_3]);
	});
});

test("writeCollectionRecordV2: the five public write hook stages run in order on success", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const order: string[] = [];
		await writeCollectionRecordV2(storage, canonicalRecordWithEntries([WRITE_ENTRY_1]), {
			afterTempCommit: () => {
				order.push("afterTempCommit");
			},
			afterTargetVerify: () => {
				order.push("afterTargetVerify");
			},
			afterBackupPark: () => {
				order.push("afterBackupPark");
			},
			afterTargetRemoved: () => {
				order.push("afterTargetRemoved");
			},
			afterPublish: () => {
				order.push("afterPublish");
			},
		});
		assert.deepEqual(order, ["afterTempCommit", "afterTargetVerify", "afterBackupPark", "afterTargetRemoved", "afterPublish"]);
	});
});

test("writeCollectionRecordV2: every pre-commit hook failure is committed:false with the prior record restored or preserved", async () => {
	const cases = ["afterTempCommit", "afterTargetVerify", "afterBackupPark", "afterTargetRemoved"] as const;
	for (const hook of cases) {
		await withTempDir(async (root) => {
			const runsDir = join(root, "runs");
			await mkdir(runsDir);
			const storage = await initializeCollectionStorageV2(runsDir);
			const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
			const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
			const priorBytes = await readFile(recordPath);
			const priorIdentity = storage.recordIdentity;
			const hookError = new Error(`hook-failure-${hook}-4e11`);
			const hooks: WriteCollectionRecordV2Hooks = {};
			// one asynchronous rejection proves async hooks are awaited
			if (hook === "afterTargetVerify") hooks.afterTargetVerify = () => Promise.reject(hookError);
			else hooks[hook] = () => {
				throw hookError;
			};
			const error = await expectWriteError(
				storage,
				canonicalRecordWithEntries([WRITE_ENTRY_1]),
				"RECORD_IO",
				false,
				"the collection record write was interrupted by an internal stage failure",
				hooks,
			);
			// the hook's own error never surfaces raw — fixed privacy-safe message only
			assert.ok(!error.message.includes("hook-failure"), hook);
			// committed:false and the tracked identity was never advanced
			assert.equal(error.committed, false, hook);
			assert.deepEqual(storage.recordIdentity, priorIdentity, hook);
			// the prior record is byte-identical at the canonical target
			assert.equal(Buffer.compare(await readFile(recordPath), priorBytes), 0, hook);
			// ...and, when the old target name was removed (afterTargetRemoved), it was
			// RESTORED from the parked backup as the SAME inode — never rewritten
			assert.deepEqual(await identityOf(recordPath), priorIdentity, hook);
			// every owned temp/backup name was cleaned up; the root is back to the two owned entries
			assert.deepEqual(await hiddenEntries(rootPath), [], hook);
			assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2], hook);
		});
	}
});

test("writeCollectionRecordV2: a post-publish hook failure is committed:true with the newly committed target preserved", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		const priorIdentity = storage.recordIdentity;
		const record = canonicalRecordWithEntries([WRITE_ENTRY_1]);
		const canonicalBytes = Buffer.from(collectionRecordToJsonV2(record), "utf8");
		const error = await expectWriteError(
			storage,
			record,
			"RECORD_IO",
			true,
			"the collection record write was interrupted by an internal stage failure",
			{
				afterPublish: () => {
					throw new Error("hook-failure-afterPublish-7c4e");
				},
			},
		);
		assert.ok(!error.message.includes("hook-failure"));
		// the committed target is preserved byte-exact — never rewritten or reverted
		assert.equal(Buffer.compare(await readFile(recordPath), canonicalBytes), 0);
		assert.deepEqual(parseCollectionRecordV2((await readFile(recordPath)).toString("utf8")), record);
		// the tracked identity was already advanced to the published inode
		assert.deepEqual(storage.recordIdentity, await identityOf(recordPath));
		assert.ok(storage.recordIdentity.ino !== priorIdentity.ino);
		// the parked prior record is superseded — no backup name remains
		assert.deepEqual(await hiddenEntries(rootPath), []);
		assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
	});
});

test("writeCollectionRecordV2: root and target replacement gates fail closed STORAGE_IO without touching the foreign entry", async () => {
	// the root replaced BEFORE the write — refused before any temp write inside the foreign root
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await rm(rootPath, { recursive: true });
		await mkdir(rootPath);
		await writeFile(join(rootPath, "foreign-root-marker.txt"), "foreign\n", "utf8");
		await expectWriteError(
			storage,
			canonicalRecordWithEntries([WRITE_ENTRY_1]),
			"STORAGE_IO",
			false,
			"the storage root was replaced or is no longer the owned entry",
		);
		// nothing was ever written inside the foreign root
		assert.deepEqual(await readdir(rootPath), ["foreign-root-marker.txt"]);
	});
	// the target replaced BEFORE the write — the temp is cleaned and the foreign record preserved
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		await rm(recordPath);
		await writeFile(recordPath, "SECRET-FOREIGN-RECORD-9d02\n", "utf8");
		await expectWriteError(
			storage,
			canonicalRecordWithEntries([WRITE_ENTRY_1]),
			"STORAGE_IO",
			false,
			"the collection record at the storage target was replaced or is no longer the owned entry",
		);
		assert.equal(await readFile(recordPath, "utf8"), "SECRET-FOREIGN-RECORD-9d02\n");
		assert.deepEqual(await hiddenEntries(rootPath), []);
	});
	// the root replaced at afterTempCommit — the temp verify fails closed and the foreign root stays empty
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await expectWriteError(
			storage,
			canonicalRecordWithEntries([WRITE_ENTRY_1]),
			"STORAGE_IO",
			false,
			"the collection record temp file was replaced or is no longer the owned entry",
			{
				afterTempCommit: async () => {
					await rm(rootPath, { recursive: true });
					await mkdir(rootPath);
					await writeFile(join(rootPath, "foreign-root-marker.txt"), "foreign\n", "utf8");
				},
			},
		);
		assert.deepEqual(await readdir(rootPath), ["foreign-root-marker.txt"]);
	});
	// the root replaced at afterTargetVerify — the re-check gate refuses the foreign root
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await expectWriteError(
			storage,
			canonicalRecordWithEntries([WRITE_ENTRY_1]),
			"STORAGE_IO",
			false,
			"the storage root was replaced or is no longer the owned entry",
			{
				afterTargetVerify: async () => {
					await rm(rootPath, { recursive: true });
					await mkdir(rootPath);
					await writeFile(join(rootPath, "foreign-root-marker.txt"), "foreign\n", "utf8");
				},
			},
		);
		assert.deepEqual(await readdir(rootPath), ["foreign-root-marker.txt"]);
	});
	// the target replaced at afterTargetVerify — the re-check gate refuses and the foreign record survives
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		await expectWriteError(
			storage,
			canonicalRecordWithEntries([WRITE_ENTRY_1]),
			"STORAGE_IO",
			false,
			"the collection record at the storage target was replaced or is no longer the owned entry",
			{
				afterTargetVerify: async () => {
					await rm(recordPath);
					await writeFile(recordPath, "SECRET-FOREIGN-RECORD-4c11\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(recordPath, "utf8"), "SECRET-FOREIGN-RECORD-4c11\n");
		assert.deepEqual(await hiddenEntries(rootPath), []);
	});
});

test("writeCollectionRecordV2: a temp replaced afterTempCommit fails closed and the foreign temp survives identity-only cleanup", async () => {
	// identity replacement: the owned temp name now holds a foreign inode
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		const priorBytes = await readFile(recordPath);
		let replacedTempName = "";
		await expectWriteError(
			storage,
			canonicalRecordWithEntries([WRITE_ENTRY_1]),
			"STORAGE_IO",
			false,
			"the collection record temp file was replaced or is no longer the owned entry",
			{
				afterTempCommit: async () => {
					// deterministic hook-time directory inspection of the generated hidden name
					const tempNames = await hiddenEntries(rootPath, ".tmp");
					assert.equal(tempNames.length, 1, "exactly one owned temp must exist at afterTempCommit");
					replacedTempName = tempNames[0] ?? "";
					await rm(join(rootPath, replacedTempName));
					await writeFile(join(rootPath, replacedTempName), "SECRET-FOREIGN-TEMP-7f1a\n", "utf8");
				},
			},
		);
		// the foreign temp replacement survives byte-identical — identity-gated cleanup never removes it
		assert.ok(replacedTempName.length > 0);
		assert.equal(await readFile(join(rootPath, replacedTempName), "utf8"), "SECRET-FOREIGN-TEMP-7f1a\n");
		assert.deepEqual(await hiddenEntries(rootPath, ".tmp"), [replacedTempName]);
		// the target still holds the prior record, byte-identical
		assert.equal(Buffer.compare(await readFile(recordPath), priorBytes), 0);
		assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2, replacedTempName].sort());
	});
	// in-place content mutation: the same inode now carries non-canonical bytes
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		const priorBytes = await readFile(recordPath);
		await expectWriteError(
			storage,
			canonicalRecordWithEntries([WRITE_ENTRY_1]),
			"RECORD_IO",
			false,
			"the collection record temp file does not match the canonical record",
			{
				afterTempCommit: async () => {
					const tempNames = await hiddenEntries(rootPath, ".tmp");
					assert.equal(tempNames.length, 1);
					await writeFile(join(rootPath, tempNames[0] ?? ""), "SECRET-MUTATED-TEMP-2d19\n", "utf8");
				},
			},
		);
		// the OWNED temp name was cleaned up — no hidden residue
		assert.deepEqual(await hiddenEntries(rootPath), []);
		assert.equal(Buffer.compare(await readFile(recordPath), priorBytes), 0);
	});
});

test("writeCollectionRecordV2: a target reoccupied afterTargetRemoved is never clobbered — the prior record is preserved at the backup name", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		const priorBytes = await readFile(recordPath);
		const priorIdentity = storage.recordIdentity;
		await expectWriteError(
			storage,
			canonicalRecordWithEntries([WRITE_ENTRY_1]),
			"STORAGE_IO",
			false,
			"the collection record target was reoccupied and is never overwritten",
			{
				afterTargetRemoved: async () => {
					await writeFile(recordPath, "SECRET-REOCCUPY-BODY-2b19\n", "utf8");
				},
			},
		);
		// the foreign target was NEVER clobbered
		assert.equal(await readFile(recordPath, "utf8"), "SECRET-REOCCUPY-BODY-2b19\n");
		// the prior record is preserved at exactly one backup name — the SAME inode as the original record
		const backups = await hiddenEntries(rootPath, ".bak");
		assert.equal(backups.length, 1);
		const backupPath = join(rootPath, backups[0] ?? "");
		assert.equal(Buffer.compare(await readFile(backupPath), priorBytes), 0);
		assert.deepEqual(await identityOf(backupPath), priorIdentity);
		// the tracked identity still points at the prior record — nothing was committed
		assert.deepEqual(storage.recordIdentity, priorIdentity);
		assert.deepEqual(storage.recordIdentity, await identityOf(backupPath));
		// no temp name remains
		assert.deepEqual(await hiddenEntries(rootPath, ".tmp"), []);
	});
	// restoration semantics: with NO reoccupation the removed target is restored from the
	// parked backup as the SAME inode, and the storage remains fully usable
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		const priorBytes = await readFile(recordPath);
		const priorIdentity = storage.recordIdentity;
		await expectWriteError(
			storage,
			canonicalRecordWithEntries([WRITE_ENTRY_1]),
			"RECORD_IO",
			false,
			"the collection record write was interrupted by an internal stage failure",
			{
				afterTargetRemoved: () => {
					throw new Error("hook-failure-afterTargetRemoved-5c2d");
				},
			},
		);
		// the prior record is restored at the canonical target as the SAME inode
		assert.equal(Buffer.compare(await readFile(recordPath), priorBytes), 0);
		assert.deepEqual(await identityOf(recordPath), priorIdentity);
		assert.deepEqual(await hiddenEntries(rootPath), []);
		// a follow-up write succeeds against the restored storage
		await writeCollectionRecordV2(storage, canonicalRecordWithEntries([WRITE_ENTRY_1, WRITE_ENTRY_2]));
		assert.deepEqual(parseCollectionRecordV2((await readFile(recordPath)).toString("utf8")).entries, [WRITE_ENTRY_1, WRITE_ENTRY_2]);
	});
});

test("writeCollectionRecordV2: a parked-backup replacement afterBackupPark survives — the write commits and identity-only cleanup skips it", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		let replacedBackupName = "";
		const record = canonicalRecordWithEntries([WRITE_ENTRY_1]);
		const canonicalBytes = Buffer.from(collectionRecordToJsonV2(record), "utf8");
		await writeCollectionRecordV2(storage, record, {
			afterBackupPark: async () => {
				const backupNames = await hiddenEntries(rootPath, ".bak");
				assert.equal(backupNames.length, 1, "exactly one owned backup must exist at afterBackupPark");
				replacedBackupName = backupNames[0] ?? "";
				await rm(join(rootPath, replacedBackupName));
				await writeFile(join(rootPath, replacedBackupName), "SECRET-FOREIGN-BACKUP-8a3f\n", "utf8");
			},
		});
		// the write COMMITTED: the target holds the new canonical bytes and the identity advanced
		assert.equal(Buffer.compare(await readFile(recordPath), canonicalBytes), 0);
		assert.deepEqual(storage.recordIdentity, await identityOf(recordPath));
		// the foreign backup replacement survives byte-identical — cleanup only removes OWNED backup names
		assert.ok(replacedBackupName.length > 0);
		assert.equal(await readFile(join(rootPath, replacedBackupName), "utf8"), "SECRET-FOREIGN-BACKUP-8a3f\n");
		assert.deepEqual(await hiddenEntries(rootPath, ".bak"), [replacedBackupName]);
	});
});

test("writeCollectionRecordV2: foreign temp/backup replacements survive identity-only cleanup on both success and failure paths", async () => {
	// success path: foreign temp- and backup-pattern files injected mid-write survive the cleanup
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		const foreignTempName = ".collection-record.json.11111111-2222-4333-8444-555555555555.tmp";
		const foreignBackupName = ".collection-record.json.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bak";
		await writeCollectionRecordV2(storage, canonicalRecordWithEntries([WRITE_ENTRY_1]), {
			afterTargetVerify: async () => {
				await writeFile(join(rootPath, foreignTempName), "SECRET-FOREIGN-TEMP-6e3b\n", "utf8");
				await writeFile(join(rootPath, foreignBackupName), "SECRET-FOREIGN-BACKUP-0f4a\n", "utf8");
			},
		});
		// the write committed and the OWNED temp/backup names were removed...
		assert.equal(Buffer.compare(await readFile(recordPath), Buffer.from(collectionRecordToJsonV2(canonicalRecordWithEntries([WRITE_ENTRY_1])), "utf8")), 0);
		// ...while the foreign replacements survive byte-identical (the only hidden residue)
		assert.deepEqual(await hiddenEntries(rootPath), [foreignTempName, foreignBackupName].sort());
		assert.equal(await readFile(join(rootPath, foreignTempName), "utf8"), "SECRET-FOREIGN-TEMP-6e3b\n");
		assert.equal(await readFile(join(rootPath, foreignBackupName), "utf8"), "SECRET-FOREIGN-BACKUP-0f4a\n");
	});
	// failure path: a foreign backup-pattern entry injected before a pre-commit failure survives
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const foreignBackupName = ".collection-record.json.bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.bak";
		await expectWriteError(
			storage,
			canonicalRecordWithEntries([WRITE_ENTRY_1]),
			"RECORD_IO",
			false,
			"the collection record write was interrupted by an internal stage failure",
			{
				afterTargetVerify: async () => {
					await writeFile(join(rootPath, foreignBackupName), "SECRET-FOREIGN-BACKUP-3d17\n", "utf8");
					throw new Error("hook-failure-foreign-backup-3d17");
				},
			},
		);
		// failure cleanup removed the owned temp and never touched the foreign backup-pattern entry
		assert.equal(await readFile(join(rootPath, foreignBackupName), "utf8"), "SECRET-FOREIGN-BACKUP-3d17\n");
		assert.deepEqual(await hiddenEntries(rootPath), [foreignBackupName]);
	});
});

test("writeCollectionRecordV2: sources and foreign children are never disturbed across success, failure and recovery", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		// foreign children pre-exist every write
		await writeFile(join(sourcesPath, "foreign-sources-child.txt"), "sources child\n", "utf8");
		await writeFile(join(rootPath, "foreign-root-child.txt"), "root child\n", "utf8");
		const assertForeignIntact = async (): Promise<void> => {
			assert.deepEqual((await readdir(sourcesPath)).sort(), ["foreign-sources-child.txt"]);
			assert.equal(await readFile(join(sourcesPath, "foreign-sources-child.txt"), "utf8"), "sources child\n");
			assert.equal(await readFile(join(rootPath, "foreign-root-child.txt"), "utf8"), "root child\n");
		};
		// 1. a successful write leaves them untouched
		await writeCollectionRecordV2(storage, canonicalRecordWithEntries([WRITE_ENTRY_1]));
		await assertForeignIntact();
		// 2. a failing write (target reoccupied) leaves them untouched and preserves the prior record
		const oneEntryBytes = await readFile(recordPath);
		await expectWriteError(
			storage,
			canonicalRecordWithEntries([WRITE_ENTRY_1, WRITE_ENTRY_2]),
			"STORAGE_IO",
			false,
			"the collection record target was reoccupied and is never overwritten",
			{
				afterTargetRemoved: async () => {
					await writeFile(recordPath, "SECRET-REOCCUPY-6b2a\n", "utf8");
				},
			},
		);
		await assertForeignIntact();
		const backups = await hiddenEntries(rootPath, ".bak");
		assert.equal(backups.length, 1);
		assert.equal(Buffer.compare(await readFile(join(rootPath, backups[0] ?? "")), oneEntryBytes), 0);
		// 3. a follow-up write is refused while a foreign entry occupies the target (gate)
		await expectWriteError(
			storage,
			canonicalRecordWithEntries([WRITE_ENTRY_1, WRITE_ENTRY_2]),
			"STORAGE_IO",
			false,
			"the collection record at the storage target was replaced or is no longer the owned entry",
		);
		// 4. documented recovery: restore the prior record from the preserved backup (hard link)
		await rm(recordPath);
		await link(join(rootPath, backups[0] ?? ""), recordPath);
		assert.deepEqual(await identityOf(recordPath), storage.recordIdentity);
		// 5. writes recover and continue; the preserved backup of the failed transaction stays
		await writeCollectionRecordV2(storage, canonicalRecordWithEntries([WRITE_ENTRY_1, WRITE_ENTRY_2]));
		await writeCollectionRecordV2(storage, canonicalRecordWithEntries([WRITE_ENTRY_1, WRITE_ENTRY_2, WRITE_ENTRY_3]));
		await assertForeignIntact();
		const final = parseCollectionRecordV2((await readFile(recordPath)).toString("utf8"));
		assert.deepEqual(final.entries, [WRITE_ENTRY_1, WRITE_ENTRY_2, WRITE_ENTRY_3]);
		// the root holds the two owned entries, the foreign child and the preserved backup of the
		// failed transaction (the collector loop owns its cleanup — out of scope here)
		assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2, "foreign-root-child.txt", backups[0] ?? ""].sort());
	});
});

test("writeCollectionRecordV2: errors and facts expose only frozen relative names — never absolute roots, UUID/temp/backup names, raw content or raw fs text", async () => {
	await withTempDir(async (root) => {
		const captured = { temp: "", backup: "" };
		const scenarios: Array<{
			name: string;
			committed: boolean;
			prepare: (runsDir: string) => Promise<{ storage: CollectionStorageV2; run: () => Promise<unknown>; after?: () => Promise<void> }>;
			secrets: string[];
		}> = [
			{
				name: "strict invalid record",
				committed: false,
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					const invalid: CollectionRecordV2 = {
						...buildInitialCollectionRecordV2(),
						entries: [{ kind: "session", arm: "treatment", path: "sources/treatment/session-01.jsonl", expectedSessionSha256: "f".repeat(64) }],
					};
					return { storage, run: () => writeCollectionRecordV2(storage, invalid) };
				},
				secrets: [],
			},
			{
				name: "foreign root before the write",
				committed: false,
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					await rm(join(runsDir, OUTPUT_ROOT_NAME_V2), { recursive: true });
					await mkdir(join(runsDir, OUTPUT_ROOT_NAME_V2));
					await writeFile(join(runsDir, OUTPUT_ROOT_NAME_V2, "SECRET-FOREIGN-MARKER-1c8e.txt"), "foreign\n", "utf8");
					return { storage, run: () => writeCollectionRecordV2(storage, canonicalRecordWithEntries([WRITE_ENTRY_1])) };
				},
				secrets: ["SECRET-FOREIGN-MARKER-1c8e.txt"],
			},
			{
				name: "temp replaced afterTempCommit",
				committed: false,
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					return {
						storage,
						run: () =>
							writeCollectionRecordV2(storage, canonicalRecordWithEntries([WRITE_ENTRY_1]), {
								afterTempCommit: async () => {
									const names = await hiddenEntries(join(runsDir, OUTPUT_ROOT_NAME_V2), ".tmp");
									captured.temp = names[0] ?? "";
									await rm(join(runsDir, OUTPUT_ROOT_NAME_V2, captured.temp));
									await writeFile(join(runsDir, OUTPUT_ROOT_NAME_V2, captured.temp), "SECRET-TEMP-BODY-2d19\n", "utf8");
								},
							}),
					};
				},
				secrets: ["SECRET-TEMP-BODY-2d19"],
			},
			{
				name: "target reoccupied afterTargetRemoved",
				committed: false,
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					const recordPath = join(runsDir, OUTPUT_ROOT_NAME_V2, COLLECTION_RECORD_NAME);
					return {
						storage,
						run: () =>
							writeCollectionRecordV2(storage, canonicalRecordWithEntries([WRITE_ENTRY_1]), {
								afterTargetRemoved: async () => {
									await writeFile(recordPath, "SECRET-REOCCUPY-BODY-4b2c\n", "utf8");
								},
							}),
						after: async () => {
							const names = await hiddenEntries(join(runsDir, OUTPUT_ROOT_NAME_V2), ".bak");
							captured.backup = names[0] ?? "";
						},
					};
				},
				secrets: ["SECRET-REOCCUPY-BODY-4b2c"],
			},
			{
				name: "hook failure after publish",
				committed: true,
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					return {
						storage,
						run: () =>
							writeCollectionRecordV2(storage, canonicalRecordWithEntries([WRITE_ENTRY_1]), {
								afterPublish: () => {
									throw new Error("SECRET-HOOK-BODY-7f1a");
								},
							}),
					};
				},
				secrets: ["SECRET-HOOK-BODY-7f1a"],
			},
		];
		let n = 0;
		for (const s of scenarios) {
			n += 1;
			captured.temp = "";
			captured.backup = "";
			const runsDir = join(root, `SECRET-RUNS-${String(n).padStart(2, "0")}`);
			await mkdir(runsDir);
			const prepared = await s.prepare(runsDir);
			const error = await prepared.run().then(
				() => null,
				(e: unknown) => e,
			);
			await prepared.after?.();
			assert.ok(error instanceof NroV2RecordWriteError, `${s.name} must fail closed as NroV2RecordWriteError`);
			assert.ok(error instanceof NroV2FinalCollectError, `${s.name}: NroV2RecordWriteError must extend NroV2FinalCollectError`);
			assert.ok(error instanceof Error, `${s.name}: NroV2RecordWriteError must extend Error`);
			assert.equal(error.committed, s.committed, `${s.name}: committed flag`);
			const text = `${error.name} ${error.code} ${error.message}`;
			assert.ok(!text.includes(root), `${s.name}: error leaks the temp root`);
			assert.ok(!text.includes(runsDir), `${s.name}: error leaks the runs dir`);
			assert.ok(!text.includes(`SECRET-RUNS-${String(n).padStart(2, "0")}`), `${s.name}: error leaks the runs dir basename`);
			for (const secret of [...s.secrets, captured.temp, captured.backup, "ENOENT", "ENOTDIR", "EACCES", "EPERM", "Error:", "node:"]) {
				if (secret.length === 0) continue;
				assert.ok(!text.includes(secret), `${s.name}: error leaks "${secret}": ${text}`);
			}
			assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text), `${s.name}: error leaks a UUID: ${text}`);
			assert.ok(!/[\u0000-\u001f\u007f]/.test(text), `${s.name}: error message contains control characters`);
			assert.ok(error.message.length <= 200, `${s.name}: error message exceeds the bounded length`);
			// serialized errors carry only the structured fields — never the message or secrets
			const json = JSON.stringify(error);
			assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ["code", "committed", "name"], `${s.name}: serialized error shape`);
			assert.ok(
				!json.includes(runsDir) &&
					(captured.temp.length === 0 || !json.includes(captured.temp)) &&
					(captured.backup.length === 0 || !json.includes(captured.backup)),
				`${s.name}: serialized error leaks a secret`,
			);
			// public facts never leak absolute plumbing or runs-dir names
			const storageJson = JSON.stringify(prepared.storage);
			assert.ok(!storageJson.includes(runsDir), `${s.name}: storage facts leak the runs dir`);
			assert.ok(!storageJson.includes("SECRET-RUNS-"), `${s.name}: storage facts leak a runs-dir basename`);
		}
	});
});

// ------------------------------------------------ persistence: retained sources

/** Expect a retained-source rejection with the exact collector error code (and optional exact message). */
async function expectRetainError(
	storage: CollectionStorageV2,
	attempt: number,
	arm: ArmName,
	raw: Buffer,
	code: NroV2FinalCollectErrorCode,
	message?: string,
	hooks: RetainRawSourceV2Hooks = {},
): Promise<NroV2FinalCollectError> {
	let caught: unknown;
	try {
		await retainRawSourceV2(storage, attempt, arm, raw, hooks);
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof NroV2FinalCollectError, `expected NroV2FinalCollectError, got ${String(caught)}`);
	assert.ok(caught instanceof Error, "NroV2FinalCollectError must extend Error");
	assert.equal(caught.code, code);
	assert.equal(caught.name, "NroV2FinalCollectError");
	if (message !== undefined) assert.equal(caught.message, message);
	return caught;
}

/** Expect a retained-source removal rejection with the exact collector error code (and optional exact message). */
async function expectRemoveError(
	storage: CollectionStorageV2,
	attempt: number,
	arm: ArmName,
	retained: RetainedSourceV2,
	code: NroV2FinalCollectErrorCode,
	message?: string,
): Promise<NroV2FinalCollectError> {
	let caught: unknown;
	try {
		await removeOwnedRetainedSourceV2(storage, attempt, arm, retained);
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof NroV2FinalCollectError, `expected NroV2FinalCollectError, got ${String(caught)}`);
	assert.ok(caught instanceof Error, "NroV2FinalCollectError must extend Error");
	assert.equal(caught.code, code);
	assert.equal(caught.name, "NroV2FinalCollectError");
	if (message !== undefined) assert.equal(caught.message, message);
	return caught;
}

test("retainRawSourceV2: exact success — deterministic name/relative path/hash, byte-exact file, owned identity and relative-only public facts", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "SECRET-RUNS-5a1c");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		const raw = Buffer.from('{"type":"message","id":"m-1","message":{"role":"user","content":[{"type":"text","text":"α 水 🚀 milestone"}]}}\n', "utf8");
		const retained = await retainRawSourceV2(storage, 1, "control", raw);
		// deterministic facts: the frozen raw-source name, the relative path and the raw-byte SHA
		assert.equal(retained.sourceName, rawSourceNameV2(1, "control"));
		assert.equal(retained.sourceName, "raw-01-control.jsonl");
		assert.equal(retained.relativePath, `${SOURCES_DIR_NAME_V2}/${retained.sourceName}`);
		assert.equal(retained.relativePath, "sources/raw-01-control.jsonl");
		assert.equal(retained.expectedSessionSha256, sha256Hex(raw));
		assert.match(retained.expectedSessionSha256, /^[0-9a-f]{64}$/);
		// the exact destination file exists with byte-exact content and the tracked identity
		const sourcePath = join(sourcesPath, retained.sourceName);
		assert.ok((await lstat(sourcePath)).isFile(), "the retained source must be a regular file");
		assert.equal(Buffer.compare(await readFile(sourcePath), raw), 0);
		assert.deepEqual(retained.identity, await identityOf(sourcePath));
		assert.equal(retained.identity.kind, "file");
		assert.ok(retained.identity.dev !== 0 && retained.identity.ino !== 0, "the retained identity must carry a real dev+ino");
		assert.notDeepEqual(retained.identity, storage.recordIdentity, "the retained source must be a distinct entry");
		// the tree holds exactly the owned entries; the record is never disturbed
		assert.deepEqual(await readdir(sourcesPath), [retained.sourceName]);
		assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
		assert.equal(Buffer.compare(await readFile(recordPath), initialRecordBytes()), 0);
		// arm/attempt determinism: the name follows the frozen zero-padded identity
		const treatment = await retainRawSourceV2(storage, 9, "treatment", Buffer.from("treatment raw\n", "utf8"));
		assert.equal(treatment.sourceName, "raw-09-treatment.jsonl");
		assert.equal(treatment.relativePath, "sources/raw-09-treatment.jsonl");
		assert.equal(Buffer.compare(await readFile(join(sourcesPath, treatment.sourceName)), Buffer.from("treatment raw\n", "utf8")), 0);
		assert.deepEqual((await readdir(sourcesPath)).sort(), ["raw-01-control.jsonl", "raw-09-treatment.jsonl"]);
		// public facts expose the frozen relative names, the hash and the identity ONLY — never absolute plumbing
		const json = JSON.stringify(retained);
		assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ["expectedSessionSha256", "identity", "relativePath", "sourceName"]);
		assert.ok(!json.includes(runsDir), "retained facts leak the runs dir");
		assert.ok(!json.includes("SECRET-RUNS-5a1c"), "retained facts leak the runs dir basename");
		assert.ok(!retained.relativePath.startsWith("/") && !retained.relativePath.includes("\\"), `non-relative retained path: ${retained.relativePath}`);
		// storage facts likewise never leak absolute plumbing
		const storageJson = JSON.stringify(storage);
		assert.ok(!storageJson.includes(runsDir), "storage facts leak the runs dir");
		assert.ok(!storageJson.includes("SECRET-RUNS-5a1c"), "storage facts leak a runs-dir basename");
	});
});

test("retainRawSourceV2: the frozen SESSION_MAX_BYTES cap is enforced BEFORE any filesystem access — cap+1 refused SOURCE_OVER_BOUND, the exact cap accepted", async () => {
	// cap+1 with the runs dir entirely removed proves the cap check runs before ANY fs access
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		await rm(runsDir, { recursive: true }); // every fs path is now phantom
		await expectRetainError(storage, 1, "control", Buffer.alloc(SESSION_MAX_BYTES + 1, 0x61), "SOURCE_OVER_BOUND", `the retained raw source exceeds ${SESSION_MAX_BYTES} bytes`);
	});
	// with an intact storage, cap+1 is refused before any write and nothing is created
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const over = Buffer.concat([Buffer.from("SECRET-OVER-RAW-2d7f\n", "utf8"), Buffer.alloc(SESSION_MAX_BYTES, 0x61)]);
		const error = await expectRetainError(storage, 1, "control", over, "SOURCE_OVER_BOUND", `the retained raw source exceeds ${SESSION_MAX_BYTES} bytes`);
		assert.ok(!error.message.includes("SECRET-OVER-RAW-2d7f"), "the over-bound error must never render raw bytes");
		assert.deepEqual(await readdir(sourcesPath), [], "no source may be created for an over-bound raw");
		assert.equal(Buffer.compare(await readFile(join(rootPath, COLLECTION_RECORD_NAME)), initialRecordBytes()), 0);
		// the EXACT cap is accepted and retained byte-exactly
		const exact = Buffer.alloc(SESSION_MAX_BYTES, 0x63);
		const retained = await retainRawSourceV2(storage, 1, "control", exact);
		const sourcePath = join(sourcesPath, retained.sourceName);
		assert.equal((await lstat(sourcePath)).size, SESSION_MAX_BYTES);
		assert.equal(Buffer.compare(await readFile(sourcePath), exact), 0);
		assert.equal(retained.expectedSessionSha256, sha256Hex(exact));
		assert.deepEqual(retained.identity, await identityOf(sourcePath));
	});
});

test("retainRawSourceV2: a pre-existing destination is refused SOURCE_EXISTS and never overwritten", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const sourcePath = join(sourcesPath, rawSourceNameV2(1, "control"));
		await writeFile(sourcePath, "SECRET-EXISTING-BODY-4f1c\n", "utf8");
		await expectRetainError(
			storage,
			1,
			"control",
			Buffer.from("fresh raw\n", "utf8"),
			"SOURCE_EXISTS",
			`the retained source "raw-01-control.jsonl" already exists and is never overwritten`,
		);
		// the pre-existing bytes survive untouched — no overwrite, no cleanup of foreign entries
		assert.equal(await readFile(sourcePath, "utf8"), "SECRET-EXISTING-BODY-4f1c\n");
		assert.deepEqual(await readdir(sourcesPath), ["raw-01-control.jsonl"]);
		assert.equal(Buffer.compare(await readFile(join(rootPath, COLLECTION_RECORD_NAME)), initialRecordBytes()), 0);
	});
});

test("retainRawSourceV2: the three deterministic hook stages run in order on success", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const order: string[] = [];
		const raw = Buffer.from("hook order raw\n", "utf8");
		const retained = await retainRawSourceV2(storage, 1, "control", raw, {
			afterSourceOpen: () => {
				order.push("afterSourceOpen");
			},
			afterSourceCommit: () => {
				order.push("afterSourceCommit");
			},
			afterSourceVerify: () => {
				order.push("afterSourceVerify");
			},
		});
		assert.deepEqual(order, ["afterSourceOpen", "afterSourceCommit", "afterSourceVerify"]);
		assert.equal(Buffer.compare(await readFile(join(storage.sourcesPathAbs, retained.sourceName)), raw), 0);
	});
});

test("retainRawSourceV2: every hook failure propagates unchanged after identity-owned cleanup", async () => {
	for (const hook of ["afterSourceOpen", "afterSourceCommit", "afterSourceVerify"] as const) {
		await withTempDir(async (root) => {
			const runsDir = join(root, "runs");
			await mkdir(runsDir);
			const storage = await initializeCollectionStorageV2(runsDir);
			const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
			const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
			const hookError = new Error(`hook-failure-${hook}-3c9a`);
			const hooks: RetainRawSourceV2Hooks = {};
			hooks[hook] = () => {
				throw hookError;
			};
			await assert.rejects(
				retainRawSourceV2(storage, 1, "control", Buffer.from("raw\n", "utf8"), hooks),
				(error: unknown) => error === hookError,
				`${hook} must propagate the hook's own error unchanged`,
			);
			// identity-owned non-recursive cleanup: the partial source is gone, the owned root/sources/record stay
			assert.deepEqual(await readdir(sourcesPath), [], `${hook}: the partial source must be cleaned up`);
			assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
			assert.equal(Buffer.compare(await readFile(join(rootPath, COLLECTION_RECORD_NAME)), initialRecordBytes()), 0);
		});
	}
});

test("retainRawSourceV2: root/sources/source replacement and byte replacement at every hook fail closed SOURCE_IO — including the post-hook revalidation after afterSourceVerify", async () => {
	// root replaced at afterSourceOpen — the write lands on the orphaned owned inode, the gate fails, the foreign root survives
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await expectRetainError(
			storage,
			1,
			"control",
			Buffer.from("the original retained raw bytes\n", "utf8"),
			"SOURCE_IO",
			`the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}" was replaced or is no longer the owned entry`,
			{
				afterSourceOpen: async () => {
					await rm(rootPath, { recursive: true });
					await mkdir(rootPath);
					await writeFile(join(rootPath, "foreign-root-marker.txt"), "foreign\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(join(rootPath, "foreign-root-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual(await readdir(rootPath), ["foreign-root-marker.txt"]);
	});
	// sources replaced at afterSourceOpen — the gate fails before any byte lands in the foreign sources
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		await expectRetainError(
			storage,
			1,
			"control",
			Buffer.from("raw\n", "utf8"),
			"SOURCE_IO",
			`the v2 sources directory "${SOURCES_DIR_NAME_V2}" was replaced or is no longer the owned entry`,
			{
				afterSourceOpen: async () => {
					await rm(sourcesPath, { recursive: true });
					await mkdir(sourcesPath);
					await writeFile(join(sourcesPath, "foreign-sources-marker.txt"), "foreign\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(join(sourcesPath, "foreign-sources-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual(await readdir(sourcesPath), ["foreign-sources-marker.txt"]);
		assert.ok((await lstat(rootPath)).isDirectory(), "the owned root must survive with its foreign child");
	});
	// the source file replaced at afterSourceOpen — the foreign inode survives, the write goes to the orphaned owned inode
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const sourcePath = join(sourcesPath, rawSourceNameV2(1, "control"));
		await expectRetainError(
			storage,
			1,
			"control",
			Buffer.from("raw\n", "utf8"),
			"SOURCE_IO",
			`the retained source "raw-01-control.jsonl" was replaced or is no longer the owned entry`,
			{
				afterSourceOpen: async () => {
					await rm(sourcePath);
					await writeFile(sourcePath, "SECRET-FOREIGN-BODY-8b1e\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(sourcePath, "utf8"), "SECRET-FOREIGN-BODY-8b1e\n");
		assert.deepEqual(await readdir(sourcesPath), ["raw-01-control.jsonl"]);
	});
	// the source file replaced at afterSourceCommit — identity gate fails, foreign bytes survive identity-only cleanup
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const sourcePath = join(sourcesPath, rawSourceNameV2(1, "control"));
		await expectRetainError(
			storage,
			1,
			"control",
			Buffer.from("raw\n", "utf8"),
			"SOURCE_IO",
			`the retained source "raw-01-control.jsonl" was replaced or is no longer the owned entry`,
			{
				afterSourceCommit: async () => {
					await rm(sourcePath);
					await writeFile(sourcePath, "SECRET-FOREIGN-BODY-9d4e\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(sourcePath, "utf8"), "SECRET-FOREIGN-BODY-9d4e\n");
		assert.deepEqual(await readdir(sourcesPath), ["raw-01-control.jsonl"]);
		assert.equal(Buffer.compare(await readFile(join(rootPath, COLLECTION_RECORD_NAME)), initialRecordBytes()), 0);
	});
	// the source bytes replaced IN PLACE at afterSourceCommit — identity matches, the byte-exact read-back fails and the partial source is cleaned up
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const sourcePath = join(sourcesPath, rawSourceNameV2(1, "control"));
		await expectRetainError(
			storage,
			1,
			"control",
			Buffer.from("the original retained raw bytes\n", "utf8"),
			"SOURCE_IO",
			`the retained source "raw-01-control.jsonl" is not byte-identical to the retained raw`,
			{
				afterSourceCommit: async () => {
					await writeFile(sourcePath, "SECRET-ALTERED-BODY-6d2a\n", "utf8"); // same inode, different bytes
				},
			},
		);
		assert.ok(!existsSync(sourcePath), "the identity-matched partial source must be cleaned up");
		assert.deepEqual(await readdir(sourcesPath), []);
	});
	// root replaced at afterSourceVerify — the post-hook revalidation fails closed and the foreign root survives
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await expectRetainError(
			storage,
			1,
			"control",
			Buffer.from("raw\n", "utf8"),
			"SOURCE_IO",
			`the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}" was replaced or is no longer the owned entry`,
			{
				afterSourceVerify: async () => {
					await rm(rootPath, { recursive: true });
					await mkdir(rootPath);
					await writeFile(join(rootPath, "foreign-root-marker.txt"), "foreign\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(join(rootPath, "foreign-root-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual(await readdir(rootPath), ["foreign-root-marker.txt"]);
	});
	// the source replaced at afterSourceVerify — the post-hook revalidation identity gate fails, foreign survives
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const sourcePath = join(sourcesPath, rawSourceNameV2(1, "control"));
		await expectRetainError(
			storage,
			1,
			"control",
			Buffer.from("raw\n", "utf8"),
			"SOURCE_IO",
			`the retained source "raw-01-control.jsonl" was replaced or is no longer the owned entry`,
			{
				afterSourceVerify: async () => {
					await rm(sourcePath);
					await writeFile(sourcePath, "SECRET-FOREIGN-BODY-7c3f\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(sourcePath, "utf8"), "SECRET-FOREIGN-BODY-7c3f\n");
		assert.deepEqual(await readdir(sourcesPath), ["raw-01-control.jsonl"]);
	});
	// the source bytes replaced IN PLACE at afterSourceVerify — the post-hook byte-exact revalidation fails and the partial source is cleaned up
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const sourcePath = join(sourcesPath, rawSourceNameV2(1, "control"));
		await expectRetainError(
			storage,
			1,
			"control",
			Buffer.from("the original retained raw bytes\n", "utf8"),
			"SOURCE_IO",
			`the retained source "raw-01-control.jsonl" is not byte-identical to the retained raw`,
			{
				afterSourceVerify: async () => {
					await writeFile(sourcePath, "SECRET-ALTERED-BODY-2c5f\n", "utf8"); // same inode, different bytes
				},
			},
		);
		assert.ok(!existsSync(sourcePath), "the identity-matched partial source must be cleaned up");
		assert.deepEqual(await readdir(sourcesPath), []);
	});
});

test("retainRawSourceV2: foreign children and foreign replacements survive success and identity-owned cleanup", async () => {
	// a foreign child in sources/ never disturbs success and is never removed
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		await writeFile(join(sourcesPath, "foreign-sources-child.txt"), "sources child\n", "utf8");
		const retained = await retainRawSourceV2(storage, 1, "control", Buffer.from("raw\n", "utf8"));
		assert.equal(await readFile(join(sourcesPath, "foreign-sources-child.txt"), "utf8"), "sources child\n");
		assert.deepEqual((await readdir(sourcesPath)).sort(), ["foreign-sources-child.txt", retained.sourceName]);
		assert.equal(Buffer.compare(await readFile(join(rootPath, COLLECTION_RECORD_NAME)), initialRecordBytes()), 0);
	});
	// a foreign child injected at afterSourceVerify passes the post-hook revalidation (dir identity unchanged) and survives
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const retained = await retainRawSourceV2(storage, 1, "control", Buffer.from("raw\n", "utf8"), {
			afterSourceVerify: async () => {
				await writeFile(join(sourcesPath, "foreign-verify-child.txt"), "verify child\n", "utf8");
			},
		});
		assert.equal(await readFile(join(sourcesPath, "foreign-verify-child.txt"), "utf8"), "verify child\n");
		assert.deepEqual((await readdir(sourcesPath)).sort(), ["foreign-verify-child.txt", retained.sourceName]);
	});
	// a foreign replacement at the destination survives identity-only cleanup — only the exact file created is unlinked
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const sourcePath = join(sourcesPath, rawSourceNameV2(1, "control"));
		await expectRetainError(
			storage,
			1,
			"control",
			Buffer.from("raw\n", "utf8"),
			"SOURCE_IO",
			`the retained source "raw-01-control.jsonl" was replaced or is no longer the owned entry`,
			{
				afterSourceCommit: async () => {
					await rm(sourcePath);
					await writeFile(sourcePath, "SECRET-FOREIGN-REPLACEMENT-5b2d\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(sourcePath, "utf8"), "SECRET-FOREIGN-REPLACEMENT-5b2d\n");
		assert.deepEqual(await readdir(sourcesPath), ["raw-01-control.jsonl"]);
	});
});

test("removeOwnedRetainedSourceV2: deterministic source-name and relative-path validation precedes every fs gate", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const raw = Buffer.from("retained raw\n", "utf8");
		const retained = await retainRawSourceV2(storage, 1, "control", raw);
		const sourcePath = join(storage.sourcesPathAbs, retained.sourceName);
		// a forged source name fails closed even when the relative path matches
		await expectRemoveError(
			storage,
			1,
			"control",
			{ ...retained, sourceName: "raw-99-control.jsonl" },
			"SOURCE_IO",
			"the retained source does not match the deterministic v2 source name for the attempt and arm",
		);
		// a mismatched relative path fails closed even when the source name matches
		await expectRemoveError(
			storage,
			1,
			"control",
			{ ...retained, relativePath: "sources/raw-02-control.jsonl" },
			"SOURCE_IO",
			"the retained source does not match the deterministic v2 relative path for the attempt and arm",
		);
		// neither validation touched the retained file
		assert.equal(Buffer.compare(await readFile(sourcePath), raw), 0);
		// validation precedes the fs gates: with the root replaced by a foreign dir, the FORGED name still fails with the name error (never the root error)
		await rm(join(runsDir, OUTPUT_ROOT_NAME_V2), { recursive: true });
		await mkdir(join(runsDir, OUTPUT_ROOT_NAME_V2));
		await writeFile(join(runsDir, OUTPUT_ROOT_NAME_V2, "foreign-root-marker.txt"), "foreign\n", "utf8");
		await expectRemoveError(
			storage,
			1,
			"control",
			{ ...retained, sourceName: "raw-99-control.jsonl" },
			"SOURCE_IO",
			"the retained source does not match the deterministic v2 source name for the attempt and arm",
		);
		// and with VALID facts the owned root gate fails closed before any unlink
		await expectRemoveError(
			storage,
			1,
			"control",
			retained,
			"SOURCE_IO",
			`the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}" was replaced or is no longer the owned entry`,
		);
		assert.equal(await readFile(join(runsDir, OUTPUT_ROOT_NAME_V2, "foreign-root-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual(await readdir(join(runsDir, OUTPUT_ROOT_NAME_V2)), ["foreign-root-marker.txt"]);
	});
});

test("removeOwnedRetainedSourceV2: identity-only unlink — removed true, then false; missing and foreign sources return false untouched", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		const raw = Buffer.from("removable raw\n", "utf8");
		const retained = await retainRawSourceV2(storage, 1, "control", raw);
		const sourcePath = join(sourcesPath, retained.sourceName);
		// a matching owned source is unlinked exactly once — removed true, then false
		assert.deepEqual(await removeOwnedRetainedSourceV2(storage, 1, "control", retained), { removed: true });
		assert.ok(!existsSync(sourcePath), "the retained source must be unlinked");
		assert.deepEqual(await readdir(sourcesPath), []);
		assert.equal(Buffer.compare(await readFile(recordPath), initialRecordBytes()), 0);
		assert.deepEqual(await removeOwnedRetainedSourceV2(storage, 1, "control", retained), { removed: false });
		// a missing source (valid deterministic facts, never retained) returns false without touching anything
		const missing: RetainedSourceV2 = {
			sourceName: rawSourceNameV2(7, "treatment"),
			relativePath: `sources/${rawSourceNameV2(7, "treatment")}`,
			expectedSessionSha256: "0".repeat(64),
			identity: { dev: 1, ino: 1, kind: "file" },
		};
		assert.deepEqual(await removeOwnedRetainedSourceV2(storage, 7, "treatment", missing), { removed: false });
		assert.deepEqual(await readdir(sourcesPath), []);
		// a foreign entry at the destination is never unlinked — the identity gate returns false and the foreign bytes survive
		const retained2 = await retainRawSourceV2(storage, 1, "control", raw);
		await rm(sourcePath);
		await writeFile(sourcePath, "SECRET-FOREIGN-REMAINS-7c3f\n", "utf8");
		assert.deepEqual(await removeOwnedRetainedSourceV2(storage, 1, "control", retained2), { removed: false });
		assert.equal(await readFile(sourcePath, "utf8"), "SECRET-FOREIGN-REMAINS-7c3f\n");
		assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
	});
});

test("removeOwnedRetainedSourceV2: root and sources replacement gates fail closed SOURCE_IO without touching the foreign entry", async () => {
	// root replaced — the unlink never happens inside the foreign root
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const retained = await retainRawSourceV2(storage, 1, "control", Buffer.from("raw\n", "utf8"));
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await rm(rootPath, { recursive: true });
		await mkdir(rootPath);
		await writeFile(join(rootPath, "foreign-root-marker.txt"), "foreign\n", "utf8");
		await expectRemoveError(
			storage,
			1,
			"control",
			retained,
			"SOURCE_IO",
			`the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}" was replaced or is no longer the owned entry`,
		);
		assert.equal(await readFile(join(rootPath, "foreign-root-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual(await readdir(rootPath), ["foreign-root-marker.txt"]);
	});
	// sources replaced — same fail-closed gate, the foreign sources survive untouched
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const retained = await retainRawSourceV2(storage, 1, "control", Buffer.from("raw\n", "utf8"));
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sourcesPath = join(rootPath, SOURCES_DIR_NAME_V2);
		await rm(sourcesPath, { recursive: true });
		await mkdir(sourcesPath);
		await writeFile(join(sourcesPath, "foreign-sources-marker.txt"), "foreign\n", "utf8");
		await expectRemoveError(
			storage,
			1,
			"control",
			retained,
			"SOURCE_IO",
			`the v2 sources directory "${SOURCES_DIR_NAME_V2}" was replaced or is no longer the owned entry`,
		);
		assert.equal(await readFile(join(sourcesPath, "foreign-sources-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual(await readdir(sourcesPath), ["foreign-sources-marker.txt"]);
	});
});

test("retained-source privacy: errors and facts expose only frozen relative names — never absolute roots, raw bytes, hook errors, raw fs text or hidden transaction details", async () => {
	await withTempDir(async (root) => {
		const hookError = new Error("SECRET-HOOK-BODY-2c5f");
		const scenarios: Array<{
			name: string;
			prepare: (runsDir: string) => Promise<{ run: () => Promise<unknown> }>;
			secrets: string[];
			hookError?: Error;
		}> = [
			{
				name: "over-bound raw",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					const over = Buffer.concat([Buffer.from("SECRET-RAW-BODY-3e8a\n", "utf8"), Buffer.alloc(SESSION_MAX_BYTES, 0x61)]);
					return { run: () => retainRawSourceV2(storage, 1, "control", over) };
				},
				secrets: ["SECRET-RAW-BODY-3e8a"],
			},
			{
				name: "existing destination",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					await writeFile(join(storage.sourcesPathAbs, rawSourceNameV2(1, "control")), "SECRET-EXISTING-BODY-4f1c\n", "utf8");
					return { run: () => retainRawSourceV2(storage, 1, "control", Buffer.from("raw\n", "utf8")) };
				},
				secrets: ["SECRET-EXISTING-BODY-4f1c"],
			},
			{
				name: "root replacement",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					return {
						run: () =>
							retainRawSourceV2(storage, 1, "control", Buffer.from("raw\n", "utf8"), {
								afterSourceOpen: async () => {
									await rm(storage.rootPathAbs, { recursive: true });
									await mkdir(storage.rootPathAbs);
									await writeFile(join(storage.rootPathAbs, "SECRET-FOREIGN-ROOT-7a2b.txt"), "foreign\n", "utf8");
								},
							}),
					};
				},
				secrets: ["SECRET-FOREIGN-ROOT-7a2b.txt"],
			},
			{
				name: "source replacement",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					return {
						run: () =>
							retainRawSourceV2(storage, 1, "control", Buffer.from("raw\n", "utf8"), {
								afterSourceCommit: async () => {
									await rm(join(storage.sourcesPathAbs, rawSourceNameV2(1, "control")));
									await writeFile(join(storage.sourcesPathAbs, rawSourceNameV2(1, "control")), "SECRET-FOREIGN-SOURCE-BODY-9d4e\n", "utf8");
								},
							}),
					};
				},
				secrets: ["SECRET-FOREIGN-SOURCE-BODY-9d4e"],
			},
			{
				name: "in-place byte replacement",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					return {
						run: () =>
							retainRawSourceV2(storage, 1, "control", Buffer.from("raw\n", "utf8"), {
								afterSourceVerify: async () => {
									await writeFile(join(storage.sourcesPathAbs, rawSourceNameV2(1, "control")), "SECRET-ALTERED-BODY-6d2a\n", "utf8");
								},
							}),
					};
				},
				secrets: ["SECRET-ALTERED-BODY-6d2a"],
			},
			{
				name: "hook failure propagates unchanged",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					return {
						run: () =>
							retainRawSourceV2(storage, 1, "control", Buffer.from("raw\n", "utf8"), {
								afterSourceCommit: () => {
									throw hookError;
								},
							}),
					};
				},
				secrets: [],
				hookError,
			},
			{
				name: "removal with a replaced root",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					const retained = await retainRawSourceV2(storage, 1, "control", Buffer.from("raw\n", "utf8"));
					await rm(storage.rootPathAbs, { recursive: true });
					await mkdir(storage.rootPathAbs);
					return { run: () => removeOwnedRetainedSourceV2(storage, 1, "control", retained) };
				},
				secrets: [],
			},
		];
		let n = 0;
		for (const s of scenarios) {
			n += 1;
			const runsDir = join(root, `SECRET-RUNS-${String(n).padStart(2, "0")}`);
			await mkdir(runsDir);
			const prepared = await s.prepare(runsDir);
			const error = await prepared.run().then(
				() => null,
				(e: unknown) => e,
			);
			assert.ok(error instanceof Error, `${s.name} must fail`);
			const text = `${error.name} ${error.message}`;
			assert.ok(!text.includes(root), `${s.name}: error leaks the temp root`);
			assert.ok(!text.includes(runsDir), `${s.name}: error leaks the runs dir`);
			assert.ok(!text.includes(`SECRET-RUNS-${String(n).padStart(2, "0")}`), `${s.name}: error leaks the runs dir basename`);
			if (s.hookError !== undefined) {
				// hook failures propagate UNCHANGED — the hook's own error is the surface error
				assert.equal(error, s.hookError, `${s.name}: the hook's own error must propagate unchanged`);
				assert.ok(text.includes("SECRET-HOOK-BODY-2c5f"), `${s.name}: the propagated hook error must keep its own message`);
			} else {
				assert.ok(error instanceof NroV2FinalCollectError, `${s.name} must fail closed as NroV2FinalCollectError`);
				assert.ok(!text.includes("SECRET-HOOK-BODY-2c5f"), `${s.name}: a collector error must never embed hook error text`);
				for (const secret of [...s.secrets, "ENOENT", "ENOTDIR", "EACCES", "EPERM", "Error:", "node:"]) {
					if (secret.length === 0) continue;
					assert.ok(!text.includes(secret), `${s.name}: error leaks "${secret}": ${text}`);
				}
				assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text), `${s.name}: error leaks a UUID: ${text}`);
				assert.ok(!/[\u0000-\u001f\u007f]/.test(text), `${s.name}: error message contains control characters`);
				assert.ok(error.message.length <= 200, `${s.name}: error message exceeds the bounded length`);
			}
		}
		// a successful retention's public facts expose the frozen relative names and the identity ONLY
		const runsDir = join(root, "SECRET-RUNS-ok");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const raw = Buffer.from("SECRET-FACTS-RAW-1b7d\n", "utf8");
		const retained = await retainRawSourceV2(storage, 1, "control", raw);
		const factsJson = JSON.stringify(retained);
		assert.ok(!factsJson.includes(runsDir), "retained facts leak the runs dir");
		assert.ok(!factsJson.includes("SECRET-FACTS-RAW-1b7d"), "retained facts leak raw bytes");
		assert.deepEqual(Object.keys(JSON.parse(factsJson)).sort(), ["expectedSessionSha256", "identity", "relativePath", "sourceName"]);
		// storage facts never leak absolute plumbing
		const storageJson = JSON.stringify(storage);
		assert.ok(!storageJson.includes(runsDir), "storage facts leak the runs dir");
		assert.ok(!storageJson.includes("SECRET-RUNS-ok"), "storage facts leak a runs-dir basename");
	});
});

// ------------------------------------------- persistence: attempt-session lifecycle

/** Expect an attempt-session creation rejection with the exact collector error code (and optional exact message). */
async function expectAttemptDirError(
	storage: CollectionStorageV2,
	attempt: number,
	code: NroV2FinalCollectErrorCode,
	message?: string,
	hooks: CreateAttemptSessionStorageV2Hooks = {},
): Promise<NroV2FinalCollectError> {
	let caught: unknown;
	try {
		await createAttemptSessionStorageV2(storage, attempt, hooks);
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof NroV2FinalCollectError, `expected NroV2FinalCollectError, got ${String(caught)}`);
	assert.ok(caught instanceof Error, "NroV2FinalCollectError must extend Error");
	assert.equal(caught.code, code);
	assert.equal(caught.name, "NroV2FinalCollectError");
	if (message !== undefined) assert.equal(caught.message, message);
	return caught;
}

/** Expect a produced-session locate rejection with the exact collector error code (and optional exact message). */
async function expectLocateError(
	storage: CollectionStorageV2,
	attemptSession: AttemptSessionStorageV2,
	code: NroV2FinalCollectErrorCode,
	message?: string,
	hooks: LocateProducedSessionV2Hooks = {},
): Promise<NroV2FinalCollectError> {
	let caught: unknown;
	try {
		await locateProducedSessionV2(storage, attemptSession, hooks);
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof NroV2FinalCollectError, `expected NroV2FinalCollectError, got ${String(caught)}`);
	assert.ok(caught instanceof Error, "NroV2FinalCollectError must extend Error");
	assert.equal(caught.code, code);
	assert.equal(caught.name, "NroV2FinalCollectError");
	if (message !== undefined) assert.equal(caught.message, message);
	return caught;
}

/** Expect an attempt-session removal rejection with the exact collector error code (and optional exact message). */
async function expectSessionRemoveError(
	storage: CollectionStorageV2,
	attemptSession: AttemptSessionStorageV2,
	produced: ProducedSessionV2,
	code: NroV2FinalCollectErrorCode,
	message?: string,
): Promise<NroV2FinalCollectError> {
	let caught: unknown;
	try {
		await removeOwnedAttemptSessionV2(storage, attemptSession, produced);
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof NroV2FinalCollectError, `expected NroV2FinalCollectError, got ${String(caught)}`);
	assert.ok(caught instanceof Error, "NroV2FinalCollectError must extend Error");
	assert.equal(caught.code, code);
	assert.equal(caught.name, "NroV2FinalCollectError");
	if (message !== undefined) assert.equal(caught.message, message);
	return caught;
}

/** A fresh initialized storage plus one created attempt session (the standard lifecycle fixture). */
async function makeAttemptSession(root: string, attempt: number = 1): Promise<{ storage: CollectionStorageV2; attemptSession: AttemptSessionStorageV2; runsDir: string; rootPath: string; sessionPath: string }> {
	const runsDir = join(root, "runs");
	await mkdir(runsDir);
	const storage = await initializeCollectionStorageV2(runsDir);
	const attemptSession = await createAttemptSessionStorageV2(storage, attempt);
	const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
	const sessionPath = join(rootPath, attemptSession.sessionDirName);
	return { storage, attemptSession, runsDir, rootPath, sessionPath };
}

test("createAttemptSessionStorageV2: invalid attempts (0/61/fractions) are rejected BEFORE any filesystem access", async () => {
	// with the runs dir entirely removed, only the pure attempt gate can pass
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		await rm(runsDir, { recursive: true }); // every fs path is now phantom
		for (const attempt of [0, -1, 61, 60.5, 1.5, NaN, Infinity, -Infinity, 1e6]) {
			await expectAttemptDirError(storage, attempt, "ATTEMPT_DIR_IO", `attempt must be an integer between 1 and ${FINAL_V2_MAX_ATTEMPTS}`);
		}
	});
	// with an intact storage, invalid attempts create nothing
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		for (const attempt of [0, 61, 2.5]) {
			await expectAttemptDirError(storage, attempt, "ATTEMPT_DIR_IO");
		}
		assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
	});
});

test("createAttemptSessionStorageV2: deterministic exclusive success — public facts never include absolute plumbing, brand-gated construction", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "SECRET-RUNS-3d9f");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const attemptSession = await createAttemptSessionStorageV2(storage, 1);
		const sessionPath = join(rootPath, attemptSession.sessionDirName);
		// the public facts are the validated attempt, the deterministic relative name and the owned identity
		assert.equal(attemptSession.attempt, 1);
		assert.equal(attemptSession.sessionDirName, attemptSessionDirNameV2(1));
		assert.equal(attemptSession.sessionDirName, ".attempt-01-session");
		assert.deepEqual(attemptSession.sessionIdentity, await identityOf(sessionPath));
		assert.equal(attemptSession.sessionIdentity.kind, "directory");
		assert.ok(attemptSession.sessionIdentity.dev !== 0 && attemptSession.sessionIdentity.ino !== 0, "the session identity must carry a real dev+ino");
		// the exact empty directory exists directly under the owned root
		assert.ok((await lstat(sessionPath)).isDirectory(), "the session dir must be a real directory");
		assert.deepEqual(await readdir(sessionPath), []);
		assert.equal(attemptSession.sessionPathAbs, sessionPath);
		assert.deepEqual((await readdir(rootPath)).sort(), [".attempt-01-session", COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
		assert.equal(Buffer.compare(await readFile(join(rootPath, COLLECTION_RECORD_NAME)), initialRecordBytes()), 0);
		// zero-padded deterministic names across the range
		const last = await createAttemptSessionStorageV2(storage, FINAL_V2_MAX_ATTEMPTS);
		assert.equal(last.attempt, FINAL_V2_MAX_ATTEMPTS);
		assert.equal(last.sessionDirName, ".attempt-60-session");
		assert.equal(last.sessionPathAbs, join(rootPath, ".attempt-60-session"));
		assert.deepEqual((await readdir(rootPath)).sort(), [".attempt-01-session", ".attempt-60-session", COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
		// JSON serialization exposes attempt + deterministic name + identity ONLY — never the absolute path
		const json = JSON.stringify(attemptSession);
		assert.deepEqual(JSON.parse(json), {
			attempt: 1,
			sessionDirName: ".attempt-01-session",
			sessionIdentity: attemptSession.sessionIdentity,
		});
		assert.ok(!json.includes(runsDir), "serialized session leaks the runs dir");
		assert.ok(!json.includes("SECRET-RUNS-3d9f"), "serialized session leaks a runs-dir basename");
		assert.ok(!json.includes(rootPath), "serialized session leaks the absolute root path");
		assert.ok(!json.includes(sessionPath), "serialized session leaks the absolute session path");
	});
	// the storage class is constructible ONLY through the module factory — a foreign brand is refused
	const Forge = AttemptSessionStorageV2 as unknown as new (attempt: number, sessionDirName: string, sessionIdentity: FsIdentityV2, sessionPath: string, brand: unknown) => AttemptSessionStorageV2;
	assert.throws(
		() => new Forge(1, ".attempt-01-session", { dev: 1, ino: 1, kind: "directory" }, "/tmp/foreign-session", Symbol("foreign-brand")),
		TypeError,
		"a foreign brand must be refused by the module-private constructor",
	);
});

test("createAttemptSessionStorageV2: a pre-existing or racing entry is refused ATTEMPT_DIR_EXISTS and never overwritten", async () => {
	// a pre-existing session dir with foreign content
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sessionPath = join(rootPath, ".attempt-01-session");
		await mkdir(sessionPath);
		await writeFile(join(sessionPath, "SECRET-EXISTING-CHILD-1f4a.txt"), "foreign\n", "utf8");
		await expectAttemptDirError(storage, 1, "ATTEMPT_DIR_EXISTS", 'the v2 attempt-session directory ".attempt-01-session" already exists and is never overwritten');
		// the pre-existing entry survives byte-identical with its child
		assert.equal(await readFile(join(sessionPath, "SECRET-EXISTING-CHILD-1f4a.txt"), "utf8"), "foreign\n");
		assert.deepEqual((await readdir(rootPath)).sort(), [".attempt-01-session", COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
	});
	// a pre-existing FILE at the session name is equally refused (mkdir EEXIST)
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sessionPath = join(rootPath, ".attempt-01-session");
		await writeFile(sessionPath, "SECRET-EXISTING-FILE-8c2d\n", "utf8");
		await expectAttemptDirError(storage, 1, "ATTEMPT_DIR_EXISTS", 'the v2 attempt-session directory ".attempt-01-session" already exists and is never overwritten');
		assert.equal(await readFile(sessionPath, "utf8"), "SECRET-EXISTING-FILE-8c2d\n");
		assert.deepEqual((await readdir(rootPath)).sort(), [".attempt-01-session", COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
	});
});

test("createAttemptSessionStorageV2: the afterSessionDirCreate hook runs in order on success and its failure propagates unchanged after identity-owned rollback", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sessionPath = join(rootPath, ".attempt-01-session");
		const order: string[] = [];
		const attemptSession = await createAttemptSessionStorageV2(storage, 1, {
			afterSessionDirCreate: () => {
				order.push("afterSessionDirCreate");
			},
		});
		assert.deepEqual(order, ["afterSessionDirCreate"]);
		assert.ok((await lstat(sessionPath)).isDirectory(), "the hook ran after the exclusive create");
		assert.equal(attemptSession.sessionDirName, ".attempt-01-session");
	});
	for (const c of [
		{ name: "sync throw", hooks: (hookError: Error): CreateAttemptSessionStorageV2Hooks => ({ afterSessionDirCreate: () => { throw hookError; } }) },
		{ name: "async rejection", hooks: (hookError: Error): CreateAttemptSessionStorageV2Hooks => ({ afterSessionDirCreate: () => Promise.reject(hookError) }) },
	] as const) {
		await withTempDir(async (root) => {
			const runsDir = join(root, "runs");
			await mkdir(runsDir);
			const storage = await initializeCollectionStorageV2(runsDir);
			const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
			const sessionPath = join(rootPath, ".attempt-01-session");
			const hookError = new Error(`hook-failure-${c.name}-7e2b`);
			await assert.rejects(createAttemptSessionStorageV2(storage, 1, c.hooks(hookError)), (error: unknown) => error === hookError, c.name);
			// identity-owned non-recursive rollback: the created dir is gone, the owned root/record/sources stay
			assert.ok(!existsSync(sessionPath), `${c.name}: the created session dir must be rolled back`);
			assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
			assert.equal(Buffer.compare(await readFile(join(rootPath, COLLECTION_RECORD_NAME)), initialRecordBytes()), 0);
		});
	}
});

test("createAttemptSessionStorageV2: root/dir replacement races fail closed ATTEMPT_DIR_IO and foreign children survive identity-only rollback", async () => {
	// the root replaced BEFORE the create — the pre-create root gate fails and the foreign root never receives the descendant
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await rm(rootPath, { recursive: true });
		await mkdir(rootPath);
		await writeFile(join(rootPath, "foreign-root-marker.txt"), "foreign\n", "utf8");
		await expectAttemptDirError(storage, 1, "ATTEMPT_DIR_IO", `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}" was replaced or is no longer the owned entry`);
		assert.equal(await readFile(join(rootPath, "foreign-root-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual(await readdir(rootPath), ["foreign-root-marker.txt"]);
	});
	// root replaced at the hook — the final root gate fails, the foreign root survives untouched
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		await expectAttemptDirError(
			storage,
			1,
			"ATTEMPT_DIR_IO",
			`the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}" was replaced or is no longer the owned entry`,
			{
				afterSessionDirCreate: async () => {
					await rm(rootPath, { recursive: true });
					await mkdir(rootPath);
					await writeFile(join(rootPath, "foreign-root-marker.txt"), "foreign\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(join(rootPath, "foreign-root-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual(await readdir(rootPath), ["foreign-root-marker.txt"]);
	});
	// the session dir replaced at the hook — the final dir gate fails; the foreign dir (with its marker) survives the identity-gated rollback
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sessionPath = join(rootPath, ".attempt-01-session");
		await expectAttemptDirError(
			storage,
			1,
			"ATTEMPT_DIR_IO",
			'the v2 attempt-session directory ".attempt-01-session" was replaced or is no longer the owned entry',
			{
				afterSessionDirCreate: async () => {
					await rm(sessionPath, { recursive: true }); // empty at this stage
					await mkdir(sessionPath);
					await writeFile(join(sessionPath, "foreign-dir-marker.txt"), "foreign\n", "utf8");
				},
			},
		);
		assert.equal(await readFile(join(sessionPath, "foreign-dir-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual((await readdir(rootPath)).sort(), [".attempt-01-session", COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
	});
	// a foreign child injected into the OWNED dir makes the hook-failure rmdir fail — the owned dir survives with its foreign child
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sessionPath = join(rootPath, ".attempt-01-session");
		const hookError = new Error("hook-failure-foreign-child-5c1a");
		await assert.rejects(
			createAttemptSessionStorageV2(storage, 1, {
				afterSessionDirCreate: async () => {
					await writeFile(join(sessionPath, "foreign-session-child.txt"), "session child\n", "utf8");
					throw hookError;
				},
			}),
			(error: unknown) => error === hookError,
		);
		// rmdir refuses a non-empty dir — the owned dir survives holding only the foreign child
		assert.equal(await readFile(join(sessionPath, "foreign-session-child.txt"), "utf8"), "session child\n");
		assert.deepEqual(await readdir(sessionPath), ["foreign-session-child.txt"]);
		assert.ok((await lstat(sessionPath)).isDirectory(), "the owned session dir must survive with its foreign child");
		assert.deepEqual((await readdir(rootPath)).sort(), [".attempt-01-session", COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
	});
	// a foreign dir replacement survives a hook-failure rollback (the identity gate skips the rmdir)
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const rootPath = join(runsDir, OUTPUT_ROOT_NAME_V2);
		const sessionPath = join(rootPath, ".attempt-01-session");
		const hookError = new Error("hook-failure-foreign-dir-6d4b");
		await assert.rejects(
			createAttemptSessionStorageV2(storage, 1, {
				afterSessionDirCreate: async () => {
					await rm(sessionPath, { recursive: true });
					await mkdir(sessionPath);
					await writeFile(join(sessionPath, "foreign-dir-marker.txt"), "foreign\n", "utf8");
					throw hookError;
				},
			}),
			(error: unknown) => error === hookError,
		);
		assert.equal(await readFile(join(sessionPath, "foreign-dir-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual(await readdir(sessionPath), ["foreign-dir-marker.txt"]);
	});
});

test("locateProducedSessionV2: exactly one direct .jsonl entry while every non-jsonl sibling is ignored", async () => {
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		const raw = Buffer.from('{"type":"message","id":"m-1","message":{"role":"user","content":[{"type":"text","text":"α 水 🚀 session"}]}}\n', "utf8");
		// non-jsonl siblings: a plain file, a dotfile, an uppercase-suffix file and a subdir holding a jsonl
		await writeFile(join(sessionPath, "raw-session.jsonl"), raw);
		await writeFile(join(sessionPath, "notes.txt"), "ignored notes\n", "utf8");
		await writeFile(join(sessionPath, ".hidden"), "ignored hidden\n", "utf8");
		await writeFile(join(sessionPath, "RAW.JSONL"), "uppercase suffix is not .jsonl\n", "utf8");
		await mkdir(join(sessionPath, "sub"));
		await writeFile(join(sessionPath, "sub", "nested.jsonl"), "nested\n", "utf8");
		const produced = await locateProducedSessionV2(storage, attemptSession);
		assert.equal(produced.fileName, "raw-session.jsonl");
		assert.equal(Buffer.compare(produced.raw, raw), 0);
		assert.deepEqual(produced.identity, await identityOf(join(sessionPath, "raw-session.jsonl")));
		assert.equal(produced.identity.kind, "file");
		assert.ok(produced.identity.dev !== 0 && produced.identity.ino !== 0, "the produced identity must carry a real dev+ino");
	});
});

test("locateProducedSessionV2: zero or multiple direct .jsonl entries fail closed SESSION_FILE_COUNT", async () => {
	// zero .jsonl entries (non-jsonl siblings present)
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		await writeFile(join(sessionPath, "notes.txt"), "no session here\n", "utf8");
		await expectLocateError(storage, attemptSession, "SESSION_FILE_COUNT", "the attempt session directory must contain exactly one produced session file (.jsonl)");
	});
	// multiple .jsonl entries
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		await writeFile(join(sessionPath, "raw-session.jsonl"), "first\n", "utf8");
		await writeFile(join(sessionPath, "second.jsonl"), "second\n", "utf8");
		await expectLocateError(storage, attemptSession, "SESSION_FILE_COUNT", "the attempt session directory must contain exactly one produced session file (.jsonl)");
	});
	// multiple .jsonl entries where one is a directory — the count fails before any type check
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		await writeFile(join(sessionPath, "raw-session.jsonl"), "first\n", "utf8");
		await mkdir(join(sessionPath, "dir.jsonl"));
		await expectLocateError(storage, attemptSession, "SESSION_FILE_COUNT", "the attempt session directory must contain exactly one produced session file (.jsonl)");
	});
});

test("locateProducedSessionV2: the sole .jsonl entry must be a direct non-symlink regular file — symlink, directory and FIFO entries fail closed", async () => {
	// a symlink to a regular file is never followed
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		await writeFile(join(sessionPath, "target.txt"), "the real bytes\n", "utf8");
		await symlink(join(sessionPath, "target.txt"), join(sessionPath, "raw-session.jsonl"));
		await expectLocateError(storage, attemptSession, "SESSION_IO", "the produced session file must be a non-symlink regular file");
	});
	// a directory named *.jsonl
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		await mkdir(join(sessionPath, "raw-session.jsonl"));
		await expectLocateError(storage, attemptSession, "SESSION_IO", "the produced session file must be a non-symlink regular file");
	});
	// a FIFO (POSIX only)
	if (process.platform !== "win32") {
		await withTempDir(async (root) => {
			const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
			const made = spawnSync("mkfifo", [join(sessionPath, "raw-session.jsonl")]);
			if (made.error === undefined && made.status === 0) {
				assert.ok((await lstat(join(sessionPath, "raw-session.jsonl"))).isFIFO(), "fixture must be a real FIFO");
				await expectLocateError(storage, attemptSession, "SESSION_IO", "the produced session file must be a non-symlink regular file");
			}
		});
	}
});

test("locateProducedSessionV2: an unsafe sole .jsonl basename fails closed SESSION_IO and never surfaces the untrusted name", async () => {
	if (process.platform === "win32") return; // control-char file names are unsupported on Windows
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		const badName = "bad\u0001name.jsonl";
		await writeFile(join(sessionPath, badName), "x\n", "utf8");
		const error = await expectLocateError(storage, attemptSession, "SESSION_IO", "the produced session directory entry is not a safe .jsonl basename");
		// the untrusted name is never rendered
		assert.ok(!error.message.includes("bad"), "the unsafe name must never surface");
		assert.ok(!/[\u0000-\u001f\u007f]/.test(error.message), "error message contains control characters");
	});
});

test("locateProducedSessionV2: the frozen cap is enforced BEFORE any read — cap+1 refused SESSION_OVER_BOUND, the exact cap read byte-exactly", async () => {
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		const over = Buffer.concat([Buffer.from("SECRET-OVER-SESSION-6e2c\n", "utf8"), Buffer.alloc(SESSION_MAX_BYTES, 0x61)]);
		await writeFile(join(sessionPath, "raw-session.jsonl"), over);
		const error = await expectLocateError(storage, attemptSession, "SESSION_OVER_BOUND", `the produced session file exceeds ${SESSION_MAX_BYTES} bytes`);
		assert.ok(!error.message.includes("SECRET-OVER-SESSION-6e2c"), "the over-bound error must never render raw bytes or content");
		// the over-bounded file is untouched (locate is read-only)
		assert.equal(Buffer.compare(await readFile(join(sessionPath, "raw-session.jsonl")), over), 0);
	});
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		const exact = Buffer.alloc(SESSION_MAX_BYTES, 0x63);
		await writeFile(join(sessionPath, "raw-session.jsonl"), exact);
		const produced = await locateProducedSessionV2(storage, attemptSession);
		assert.equal(produced.raw.length, SESSION_MAX_BYTES);
		assert.equal(Buffer.compare(produced.raw, exact), 0);
		assert.deepEqual(produced.identity, await identityOf(join(sessionPath, "raw-session.jsonl")));
	});
});

test("locateProducedSessionV2: the two deterministic hook stages run in order on success and their failures propagate unchanged", async () => {
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		const raw = Buffer.from("hook order raw\n", "utf8");
		await writeFile(join(sessionPath, "raw-session.jsonl"), raw);
		const order: string[] = [];
		const produced = await locateProducedSessionV2(storage, attemptSession, {
			afterSessionOpen: () => {
				order.push("afterSessionOpen");
			},
			afterSessionRead: () => {
				order.push("afterSessionRead");
			},
		});
		assert.deepEqual(order, ["afterSessionOpen", "afterSessionRead"]);
		assert.equal(Buffer.compare(produced.raw, raw), 0);
	});
	for (const hook of ["afterSessionOpen", "afterSessionRead"] as const) {
		await withTempDir(async (root) => {
			const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
			await writeFile(join(sessionPath, "raw-session.jsonl"), "raw\n", "utf8");
			const hookError = new Error(`hook-failure-${hook}-8d3a`);
			const hooks: LocateProducedSessionV2Hooks = {};
			if (hook === "afterSessionOpen") hooks.afterSessionOpen = () => Promise.reject(hookError);
			else hooks.afterSessionRead = () => {
				throw hookError;
			};
			await assert.rejects(locateProducedSessionV2(storage, attemptSession, hooks), (error: unknown) => error === hookError, hook);
			// locate is read-only — the produced file survives untouched
			assert.equal(await readFile(join(sessionPath, "raw-session.jsonl"), "utf8"), "raw\n");
		});
	}
});

test("locateProducedSessionV2: root/dir/file replacement and grow/shrink/in-place mutations fail the final revalidation — stale facts never return", async () => {
	// root replaced BEFORE the locate — the root gate fails closed, the foreign root is never read
	await withTempDir(async (root) => {
		const { storage, attemptSession, rootPath, sessionPath } = await makeAttemptSession(root);
		await writeFile(join(sessionPath, "raw-session.jsonl"), "the original session bytes\n", "utf8");
		await rm(rootPath, { recursive: true });
		await mkdir(rootPath);
		await writeFile(join(rootPath, "foreign-root-marker.txt"), "foreign\n", "utf8");
		await expectLocateError(storage, attemptSession, "SESSION_IO", `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}" was replaced or is no longer the owned entry`);
		assert.equal(await readFile(join(rootPath, "foreign-root-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual(await readdir(rootPath), ["foreign-root-marker.txt"]);
	});
	// the session dir replaced BEFORE the locate — the dir gate fails closed and the foreign dir is never read
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		await writeFile(join(sessionPath, "raw-session.jsonl"), "the original session bytes\n", "utf8");
		await rm(sessionPath, { recursive: true });
		await mkdir(sessionPath);
		await writeFile(join(sessionPath, "raw-session.jsonl"), "SECRET-FOREIGN-SESSION-2f9b\n", "utf8");
		await expectLocateError(storage, attemptSession, "SESSION_IO", 'the v2 attempt-session directory ".attempt-01-session" was replaced or is no longer the owned entry');
		assert.equal(await readFile(join(sessionPath, "raw-session.jsonl"), "utf8"), "SECRET-FOREIGN-SESSION-2f9b\n");
	});
	// the produced file replaced at afterSessionOpen — the handle stays on the owned inode; the final identity revalidation fails
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		const filePath = join(sessionPath, "raw-session.jsonl");
		await writeFile(filePath, "the original session bytes\n", "utf8");
		await expectLocateError(
			storage,
			attemptSession,
			"SESSION_IO",
			"the produced session file changed while it was located",
			{
				afterSessionOpen: async () => {
					await rm(filePath);
					await writeFile(filePath, "SECRET-FOREIGN-SESSION-9e4a\n", "utf8");
				},
			},
		);
		// the foreign replacement survives byte-identical (locate never cleans up)
		assert.equal(await readFile(filePath, "utf8"), "SECRET-FOREIGN-SESSION-9e4a\n");
	});
	// the file GREW at afterSessionOpen — the exact lstat-size read still succeeds, the final size revalidation fails
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		const filePath = join(sessionPath, "raw-session.jsonl");
		await writeFile(filePath, "the original session bytes\n", "utf8");
		await expectLocateError(
			storage,
			attemptSession,
			"SESSION_IO",
			"the produced session file changed while it was located",
			{
				afterSessionOpen: async () => {
					await writeFile(filePath, Buffer.concat([await readFile(filePath), Buffer.from(" and more\n", "utf8")])); // same inode, bigger
				},
			},
		);
	});
	// the file SHRANK at afterSessionOpen — the bounded read short-reads and fails closed
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		const filePath = join(sessionPath, "raw-session.jsonl");
		await writeFile(filePath, "the original session bytes\n", "utf8");
		await expectLocateError(
			storage,
			attemptSession,
			"SESSION_IO",
			"the produced session file changed size while it was read",
			{
				afterSessionOpen: async () => {
					await writeFile(filePath, "short\n", "utf8"); // same inode, smaller
				},
			},
		);
	});
	// an in-place SAME-SIZE mutation at afterSessionOpen is read from the verified handle and returned — identity+size are the revalidation contract
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		const filePath = join(sessionPath, "raw-session.jsonl");
		const mutated = Buffer.from("THE MUTATED SESSION BYTES!\n", "utf8"); // exactly the original 27 bytes
		await writeFile(filePath, "the original session bytes\n", "utf8");
		const produced = await locateProducedSessionV2(storage, attemptSession, {
			afterSessionOpen: async () => {
				await writeFile(filePath, mutated); // same inode, same size, different bytes
			},
		});
		assert.equal(Buffer.compare(produced.raw, mutated), 0);
		assert.deepEqual(produced.identity, await identityOf(filePath));
	});
	// mutations at afterSessionRead — the final revalidation fails for grow/shrink/replace
	for (const mutation of ["grow", "shrink", "replace"] as const) {
		await withTempDir(async (root) => {
			const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
			const filePath = join(sessionPath, "raw-session.jsonl");
			await writeFile(filePath, "the original session bytes\n", "utf8");
			await expectLocateError(
				storage,
				attemptSession,
				"SESSION_IO",
				"the produced session file changed while it was located",
				{
					afterSessionRead: async () => {
						if (mutation === "grow") await writeFile(filePath, Buffer.concat([await readFile(filePath), Buffer.from(" more\n", "utf8")]));
					else if (mutation === "shrink") await writeFile(filePath, "short\n", "utf8");
					else {
						await rm(filePath);
						await writeFile(filePath, "SECRET-FOREIGN-SESSION-7c3f\n", "utf8");
					}
				},
			},
		);
		});
	}
	// an in-place SAME-SIZE mutation at afterSessionRead passes revalidation and returns the EXACT bytes read
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		const filePath = join(sessionPath, "raw-session.jsonl");
		const original = Buffer.from("the original session bytes\n", "utf8");
		const mutated = Buffer.from("THE MUTATED SESSION BYTES!\n", "utf8");
		await writeFile(filePath, original);
		const produced = await locateProducedSessionV2(storage, attemptSession, {
			afterSessionRead: async () => {
				await writeFile(filePath, mutated); // same inode, same size — undetectable after the read
			},
		});
		assert.equal(Buffer.compare(produced.raw, original), 0);
		assert.equal(Buffer.compare(await readFile(filePath), mutated), 0);
		assert.deepEqual(produced.identity, await identityOf(filePath));
	});
});

test("locateProducedSessionV2: the deterministic association check precedes every filesystem gate — a mismatched session fact fails closed", async () => {
	await withTempDir(async (root) => {
		const { storage, attemptSession, runsDir } = await makeAttemptSession(root);
		await rm(runsDir, { recursive: true }); // every fs path is now phantom — only the pure association gate can pass
		// a forged session object whose dir name does not match its attempt
		const forged = { attempt: 1, sessionDirName: ".attempt-02-session", sessionIdentity: attemptSession.sessionIdentity, sessionPathAbs: attemptSession.sessionPathAbs } as unknown as AttemptSessionStorageV2;
		await expectLocateError(storage, forged, "SESSION_IO", "the attempt session does not match the deterministic v2 session directory for its attempt");
	});
});

test("removeOwnedAttemptSessionV2: matching identity-only unlink and empty-dir rmdir — removedFile/removedDir true, then false", async () => {
	await withTempDir(async (root) => {
		const { storage, attemptSession, rootPath, sessionPath } = await makeAttemptSession(root);
		const raw = Buffer.from("produced session bytes\n", "utf8");
		await writeFile(join(sessionPath, "raw-session.jsonl"), raw);
		const produced = await locateProducedSessionV2(storage, attemptSession);
		const recordPath = join(rootPath, COLLECTION_RECORD_NAME);
		assert.deepEqual(await removeOwnedAttemptSessionV2(storage, attemptSession, produced), { removedFile: true, removedDir: true });
		assert.ok(!existsSync(join(sessionPath, "raw-session.jsonl")), "the produced file must be unlinked");
		assert.ok(!existsSync(sessionPath), "the emptied owned session dir must be rmdir'd");
		assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
		assert.equal(Buffer.compare(await readFile(recordPath), initialRecordBytes()), 0);
		// a second removal with the same facts fails closed at the owned-dir gate:
		// the gates precede the identity-checked removal, and the dir is gone
		await expectSessionRemoveError(storage, attemptSession, produced, "SESSION_IO", 'the v2 attempt-session directory ".attempt-01-session" was replaced or is no longer the owned entry');
	});
});

test("removeOwnedAttemptSessionV2: missing and foreign entries return truthful false — only the exact owned file and empty owned dir are removed", async () => {
	// a missing produced file (valid facts, never written): file false, but the empty owned dir is still rmdir'd
	await withTempDir(async (root) => {
		const { storage, attemptSession, rootPath, sessionPath } = await makeAttemptSession(root);
		const missing: ProducedSessionV2 = {
			fileName: "raw-session.jsonl",
			raw: Buffer.from("x\n", "utf8"),
			identity: { dev: 1, ino: 1, kind: "file" },
		};
		assert.deepEqual(await removeOwnedAttemptSessionV2(storage, attemptSession, missing), { removedFile: false, removedDir: true });
		assert.ok(!existsSync(sessionPath), "the empty owned dir must be removed");
		assert.deepEqual((await readdir(rootPath)).sort(), [COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
	});
	// a foreign file at the produced path (identity mismatch): never unlinked; the owned dir stays (non-empty) with the foreign file
	await withTempDir(async (root) => {
		const { storage, attemptSession, rootPath, sessionPath } = await makeAttemptSession(root);
		const filePath = join(sessionPath, "raw-session.jsonl");
		await writeFile(filePath, "owned-then-foreign\n", "utf8");
		const produced = await locateProducedSessionV2(storage, attemptSession);
		await rm(filePath);
		await writeFile(filePath, "SECRET-FOREIGN-BODY-4c8e\n", "utf8");
		assert.deepEqual(await removeOwnedAttemptSessionV2(storage, attemptSession, produced), { removedFile: false, removedDir: false });
		assert.equal(await readFile(filePath, "utf8"), "SECRET-FOREIGN-BODY-4c8e\n");
		assert.deepEqual(await readdir(sessionPath), ["raw-session.jsonl"]);
		assert.deepEqual((await readdir(rootPath)).sort(), [".attempt-01-session", COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
	});
});

test("removeOwnedAttemptSessionV2: a non-jsonl foreign child preserves the owned dir — removedFile true with removedDir false", async () => {
	await withTempDir(async (root) => {
		const { storage, attemptSession, rootPath, sessionPath } = await makeAttemptSession(root);
		await writeFile(join(sessionPath, "raw-session.jsonl"), "produced\n", "utf8");
		await writeFile(join(sessionPath, "foreign-notes.txt"), "foreign notes\n", "utf8");
		await mkdir(join(sessionPath, "foreign-subdir"));
		const produced = await locateProducedSessionV2(storage, attemptSession);
		assert.deepEqual(await removeOwnedAttemptSessionV2(storage, attemptSession, produced), { removedFile: true, removedDir: false });
		assert.ok(!existsSync(join(sessionPath, "raw-session.jsonl")), "the matching produced file must be unlinked");
		assert.equal(await readFile(join(sessionPath, "foreign-notes.txt"), "utf8"), "foreign notes\n");
		assert.ok((await lstat(join(sessionPath, "foreign-subdir"))).isDirectory(), "the foreign subdir must survive");
		assert.deepEqual((await readdir(sessionPath)).sort(), ["foreign-notes.txt", "foreign-subdir"]);
		assert.deepEqual((await readdir(rootPath)).sort(), [".attempt-01-session", COLLECTION_RECORD_NAME, SOURCES_DIR_NAME_V2]);
	});
});

test("removeOwnedAttemptSessionV2: root and session-dir replacement gates fail closed SESSION_IO without touching the foreign entry", async () => {
	// root replaced — the unlink never happens inside the foreign root
	await withTempDir(async (root) => {
		const { storage, attemptSession, rootPath, sessionPath } = await makeAttemptSession(root);
		await writeFile(join(sessionPath, "raw-session.jsonl"), "produced\n", "utf8");
		const produced = await locateProducedSessionV2(storage, attemptSession);
		await rm(rootPath, { recursive: true });
		await mkdir(rootPath);
		await writeFile(join(rootPath, "foreign-root-marker.txt"), "foreign\n", "utf8");
		await expectSessionRemoveError(storage, attemptSession, produced, "SESSION_IO", `the v2 final-collection output root "${OUTPUT_ROOT_NAME_V2}" was replaced or is no longer the owned entry`);
		assert.equal(await readFile(join(rootPath, "foreign-root-marker.txt"), "utf8"), "foreign\n");
		assert.deepEqual(await readdir(rootPath), ["foreign-root-marker.txt"]);
	});
	// session dir replaced — the produced path inside the foreign dir is never touched
	await withTempDir(async (root) => {
		const { storage, attemptSession, sessionPath } = await makeAttemptSession(root);
		await writeFile(join(sessionPath, "raw-session.jsonl"), "produced\n", "utf8");
		const produced = await locateProducedSessionV2(storage, attemptSession);
		await rm(sessionPath, { recursive: true });
		await mkdir(sessionPath);
		await writeFile(join(sessionPath, "raw-session.jsonl"), "SECRET-FOREIGN-SESSION-2f9b\n", "utf8");
		await expectSessionRemoveError(storage, attemptSession, produced, "SESSION_IO", 'the v2 attempt-session directory ".attempt-01-session" was replaced or is no longer the owned entry');
		assert.equal(await readFile(join(sessionPath, "raw-session.jsonl"), "utf8"), "SECRET-FOREIGN-SESSION-2f9b\n");
	});
});

test("removeOwnedAttemptSessionV2: deterministic association and safe-basename validation precede every fs gate — forged facts fail closed even against a replaced root", async () => {
	await withTempDir(async (root) => {
		const { storage, attemptSession, rootPath, sessionPath } = await makeAttemptSession(root);
		await writeFile(join(sessionPath, "raw-session.jsonl"), "produced\n", "utf8");
		const produced = await locateProducedSessionV2(storage, attemptSession);
		// forged unsafe basenames — refused SESSION_IO before any fs access
		const unsafe: Array<{ name: string; fileName: string }> = [
			{ name: "empty", fileName: "" },
			{ name: "dot", fileName: "." },
			{ name: "dotdot", fileName: ".." },
			{ name: "no suffix", fileName: "raw-session.txt" },
			{ name: "slash separator", fileName: "../raw-session.jsonl" },
			{ name: "backslash separator", fileName: "sub\\raw-session.jsonl" },
			{ name: "control char", fileName: "bad\u0001name.jsonl" },
			{ name: "over-long bytes", fileName: `${"a".repeat(600)}.jsonl` },
		];
		for (const c of unsafe) {
			const error = await expectSessionRemoveError(storage, attemptSession, { ...produced, fileName: c.fileName }, "SESSION_IO", "the produced session facts must carry a safe .jsonl basename for the attempt session");
			// the fixed message legitimately contains "." (the ".jsonl" suffix), so
			// the dot/dotdot names are covered by the exact code+message equality
			if (c.fileName.length > 0 && c.fileName !== "." && c.fileName !== "..") assert.ok(!error.message.includes(c.fileName), c.name);
		}
		// a forged session object whose dir name does not match its attempt — refused before any fs gate
		const forged = { attempt: 1, sessionDirName: ".attempt-02-session", sessionIdentity: attemptSession.sessionIdentity, sessionPathAbs: attemptSession.sessionPathAbs } as unknown as AttemptSessionStorageV2;
		await expectSessionRemoveError(storage, forged, produced, "SESSION_IO", "the attempt session does not match the deterministic v2 session directory for its attempt");
		// the produced file survives every forged-fact rejection
		assert.equal(await readFile(join(sessionPath, "raw-session.jsonl"), "utf8"), "produced\n");
		// validation precedes the fs gates: with the root replaced by a foreign dir, the FORGED name still fails with the basename error (never the root error)
		await rm(rootPath, { recursive: true });
		await mkdir(rootPath);
		await writeFile(join(rootPath, "foreign-root-marker.txt"), "foreign\n", "utf8");
		await expectSessionRemoveError(storage, attemptSession, { ...produced, fileName: "../evil.jsonl" }, "SESSION_IO", "the produced session facts must carry a safe .jsonl basename for the attempt session");
		assert.equal(await readFile(join(rootPath, "foreign-root-marker.txt"), "utf8"), "foreign\n");
	});
});

test("attempt-session privacy: errors and facts expose only frozen relative names — never absolute roots, untrusted names, raw bytes, hook errors or raw fs text", async () => {
	await withTempDir(async (root) => {
		const hookError = new Error("SECRET-HOOK-BODY-9d4e");
		const scenarios: Array<{
			name: string;
			prepare: (runsDir: string) => Promise<{ run: () => Promise<unknown> }>;
			secrets: string[];
			hookError?: Error;
		}> = [
			{
				name: "invalid attempt",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					return { run: () => createAttemptSessionStorageV2(storage, 61) };
				},
				secrets: [],
			},
			{
				name: "preexisting session dir",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					await mkdir(join(storage.rootPathAbs, ".attempt-01-session"));
					await writeFile(join(storage.rootPathAbs, ".attempt-01-session", "SECRET-CHILD-3c8e.txt"), "x\n", "utf8");
					return { run: () => createAttemptSessionStorageV2(storage, 1) };
				},
				secrets: ["SECRET-CHILD-3c8e.txt"],
			},
			{
				name: "session dir replacement",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					return {
						run: () =>
							createAttemptSessionStorageV2(storage, 1, {
								afterSessionDirCreate: async () => {
									await rm(join(storage.rootPathAbs, ".attempt-01-session"), { recursive: true });
									await mkdir(join(storage.rootPathAbs, ".attempt-01-session"));
									await writeFile(join(storage.rootPathAbs, ".attempt-01-session", "SECRET-FOREIGN-DIR-7b1f.txt"), "foreign\n", "utf8");
								},
							}),
					};
				},
				secrets: ["SECRET-FOREIGN-DIR-7b1f.txt"],
			},
			{
				name: "locate zero entries",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					const attemptSession = await createAttemptSessionStorageV2(storage, 1);
					return { run: () => locateProducedSessionV2(storage, attemptSession) };
				},
				secrets: [],
			},
			{
				name: "locate over-bound",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					const attemptSession = await createAttemptSessionStorageV2(storage, 1);
					await writeFile(join(storage.rootPathAbs, attemptSession.sessionDirName, "raw-session.jsonl"), Buffer.concat([Buffer.from("SECRET-OVER-SESSION-6e2c\n", "utf8"), Buffer.alloc(SESSION_MAX_BYTES, 0x61)]));
					return { run: () => locateProducedSessionV2(storage, attemptSession) };
				},
				secrets: ["SECRET-OVER-SESSION-6e2c"],
			},
			{
				name: "locate root replacement",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					const attemptSession = await createAttemptSessionStorageV2(storage, 1);
					await writeFile(join(storage.rootPathAbs, attemptSession.sessionDirName, "raw-session.jsonl"), "produced\n", "utf8");
					await rm(storage.rootPathAbs, { recursive: true });
					await mkdir(storage.rootPathAbs);
					await writeFile(join(storage.rootPathAbs, "SECRET-FOREIGN-ROOT-5a2d.txt"), "foreign\n", "utf8");
					return { run: () => locateProducedSessionV2(storage, attemptSession) };
				},
				secrets: ["SECRET-FOREIGN-ROOT-5a2d.txt"],
			},
			{
				name: "locate file replacement",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					const attemptSession = await createAttemptSessionStorageV2(storage, 1);
					const filePath = join(storage.rootPathAbs, attemptSession.sessionDirName, "raw-session.jsonl");
					await writeFile(filePath, "the original session bytes\n", "utf8");
					return {
						run: () =>
							locateProducedSessionV2(storage, attemptSession, {
								afterSessionOpen: async () => {
									await rm(filePath);
									await writeFile(filePath, "SECRET-FOREIGN-SESSION-9e4a\n", "utf8");
								},
							}),
					};
				},
				secrets: ["SECRET-FOREIGN-SESSION-9e4a"],
			},
			{
				name: "locate hook failure",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					const attemptSession = await createAttemptSessionStorageV2(storage, 1);
					await writeFile(join(storage.rootPathAbs, attemptSession.sessionDirName, "raw-session.jsonl"), "produced\n", "utf8");
					return {
						run: () =>
							locateProducedSessionV2(storage, attemptSession, {
								afterSessionRead: () => {
									throw hookError;
								},
							}),
					};
				},
				secrets: [],
				hookError,
			},
			{
				name: "remove forged basename",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					const attemptSession = await createAttemptSessionStorageV2(storage, 1);
					await writeFile(join(storage.rootPathAbs, attemptSession.sessionDirName, "raw-session.jsonl"), "produced\n", "utf8");
					const produced = await locateProducedSessionV2(storage, attemptSession);
					return { run: () => removeOwnedAttemptSessionV2(storage, attemptSession, { ...produced, fileName: "SECRET-FORGED-NAME-6f1c/evil.jsonl" }) };
				},
				secrets: ["SECRET-FORGED-NAME-6f1c"],
			},
			{
				name: "remove replaced root",
				prepare: async (runsDir) => {
					const storage = await initializeCollectionStorageV2(runsDir);
					const attemptSession = await createAttemptSessionStorageV2(storage, 1);
					await writeFile(join(storage.rootPathAbs, attemptSession.sessionDirName, "raw-session.jsonl"), "produced\n", "utf8");
					const produced = await locateProducedSessionV2(storage, attemptSession);
					await rm(storage.rootPathAbs, { recursive: true });
					await mkdir(storage.rootPathAbs);
					await writeFile(join(storage.rootPathAbs, "SECRET-FOREIGN-ROOT-5a2d.txt"), "foreign\n", "utf8");
					return { run: () => removeOwnedAttemptSessionV2(storage, attemptSession, produced) };
				},
				secrets: ["SECRET-FOREIGN-ROOT-5a2d.txt"],
			},
		];
		let n = 0;
		for (const s of scenarios) {
			n += 1;
			const runsDir = join(root, `SECRET-RUNS-${String(n).padStart(2, "0")}`);
			await mkdir(runsDir);
			const prepared = await s.prepare(runsDir);
			const error = await prepared.run().then(
				() => null,
				(e: unknown) => e,
			);
			assert.ok(error instanceof Error, `${s.name} must fail`);
			const text = `${error.name} ${error.message}`;
			assert.ok(!text.includes(root), `${s.name}: error leaks the temp root`);
			assert.ok(!text.includes(runsDir), `${s.name}: error leaks the runs dir`);
			assert.ok(!text.includes(`SECRET-RUNS-${String(n).padStart(2, "0")}`), `${s.name}: error leaks the runs dir basename`);
			if (s.hookError !== undefined) {
				// hook failures propagate UNCHANGED — the hook's own error is the surface error
				assert.equal(error, s.hookError, `${s.name}: the hook's own error must propagate unchanged`);
				assert.ok(text.includes("SECRET-HOOK-BODY-9d4e"), `${s.name}: the propagated hook error must keep its own message`);
			} else {
				assert.ok(error instanceof NroV2FinalCollectError, `${s.name} must fail closed as NroV2FinalCollectError`);
				assert.ok(!text.includes("SECRET-HOOK-BODY-9d4e"), `${s.name}: a collector error must never embed hook error text`);
				for (const secret of [...s.secrets, "ENOENT", "ENOTDIR", "EACCES", "EPERM", "Error:", "node:"]) {
					if (secret.length === 0) continue;
					assert.ok(!text.includes(secret), `${s.name}: error leaks "${secret}": ${text}`);
				}
				assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text), `${s.name}: error leaks a UUID: ${text}`);
				assert.ok(!/[\u0000-\u001f\u007f]/.test(text), `${s.name}: error message contains control characters`);
				assert.ok(error.message.length <= 200, `${s.name}: error message exceeds the bounded length`);
			}
		}
		// a successful attempt-session and produced-session expose relative names and identities ONLY
		const runsDir = join(root, "SECRET-RUNS-ok");
		await mkdir(runsDir);
		const storage = await initializeCollectionStorageV2(runsDir);
		const attemptSession = await createAttemptSessionStorageV2(storage, 1);
		const secretRaw = Buffer.from("SECRET-FACTS-RAW-1b7d\n", "utf8");
		await writeFile(join(storage.rootPathAbs, attemptSession.sessionDirName, "raw-session.jsonl"), secretRaw);
		const produced = await locateProducedSessionV2(storage, attemptSession);
		const sessionJson = JSON.stringify(attemptSession);
		assert.ok(!sessionJson.includes(runsDir), "attempt-session facts leak the runs dir");
		assert.ok(!sessionJson.includes("SECRET-RUNS-ok"), "attempt-session facts leak a runs-dir basename");
		assert.deepEqual(Object.keys(JSON.parse(sessionJson)).sort(), ["attempt", "sessionDirName", "sessionIdentity"]);
		const producedJson = JSON.stringify(produced);
		assert.ok(!producedJson.includes(runsDir), "produced facts leak the runs dir");
		assert.ok(!producedJson.includes("SECRET-FACTS-RAW-1b7d"), "produced facts leak raw bytes as plaintext");
		assert.deepEqual(Object.keys(JSON.parse(producedJson)).sort(), ["fileName", "identity", "raw"]);
		assert.equal(Buffer.compare(produced.raw, secretRaw), 0, "the produced raw must still be the exact capped bytes");
	});
});

// ------------------------------------------------------ final collection loop

/** Hermetic produced-session behaviors a fake attempt runner injects per attempt. */
type FakeProduceV2 =
	| { kind: "raw"; raw: Buffer }
	| { kind: "start-failure" }
	| { kind: "none" }
	| { kind: "multiple" }
	| { kind: "overbound" };

interface FakeRunnerV2Options {
	exitCode?: number | null;
	timedOut?: boolean;
	onRequest?: (request: SpawnAttemptRequestV2) => void | Promise<void>;
	/** Raw bytes appended to the captured stdout (overflow-fact injection). */
	stdoutBytes?: Buffer;
	/** Raw bytes appended to the captured stderr (overflow-fact injection). */
	stderrBytes?: Buffer;
}

/**
 * Fake attempt runner: writes the produced session into the request's
 * `--session-dir` and records every request. `options` apply to every
 * attempt; `perAttempt` (when given) supplies per-attempt overrides
 * merged over them — used to inject per-attempt exit/timeout/capture
 * facts for the diagnostic tests.
 */
function makeFakeRunnerV2(
	produce: (attempt: number, arm: ArmName) => FakeProduceV2,
	options: FakeRunnerV2Options = {},
	perAttempt?: (attempt: number, arm: ArmName) => FakeRunnerV2Options,
): { runner: SpawnAttemptRunnerV2; calls: SpawnAttemptRequestV2[] } {
	const calls: SpawnAttemptRequestV2[] = [];
	const runner: SpawnAttemptRunnerV2 = async (request) => {
		calls.push(request);
		const name = request.argv[12] ?? "";
		const arm: ArmName = name.endsWith("-treatment") ? "treatment" : "control";
		const attempt = calls.length;
		const merged: FakeRunnerV2Options = { ...options, ...(perAttempt?.(attempt, arm) ?? {}) };
		await merged.onRequest?.(request);
		const outcome = produce(attempt, arm);
		if (outcome.kind === "start-failure") {
			return { started: false, exitCode: null, timedOut: false, startError: SPAWN_START_FAILED_DETAIL_V2, stdout: createCappedCaptureV2(0), stderr: createCappedCaptureV2(0) };
		}
		const sessionDir = request.argv[10];
		if (sessionDir === undefined) throw new Error("fake runner: missing --session-dir");
		if (outcome.kind === "none") {
			// the locator sees zero .jsonl entries
		} else if (outcome.kind === "multiple") {
			await writeFile(join(sessionDir, FINAL_SESSION_BASENAME_V2), "first\n", "utf8");
			await writeFile(join(sessionDir, "raw-session-2.jsonl"), "second\n", "utf8");
		} else if (outcome.kind === "overbound") {
			await writeFile(join(sessionDir, FINAL_SESSION_BASENAME_V2), Buffer.alloc(SESSION_MAX_BYTES + 1, 0x61));
		} else {
			await writeFile(join(sessionDir, FINAL_SESSION_BASENAME_V2), outcome.raw);
		}
		const stdout = createCappedCaptureV2(request.stdoutMaxBytes ?? ATTEMPT_STDOUT_MAX_BYTES_V2);
		const stderr = createCappedCaptureV2(request.stderrMaxBytes ?? ATTEMPT_STDERR_MAX_BYTES_V2);
		if (merged.stdoutBytes !== undefined) stdout.append(merged.stdoutBytes);
		if (merged.stderrBytes !== undefined) stderr.append(merged.stderrBytes);
		return {
			started: true,
			exitCode: merged.exitCode === undefined ? 0 : merged.exitCode,
			timedOut: merged.timedOut ?? false,
			startError: null,
			stdout,
			stderr,
		};
	};
	return { runner, calls };
}

/** Layout of the hermetic loop-test workspace under one temp root. */
function runsLayoutV2(root: string): { projectRoot: string; runsDir: string; inputsDir: string; rootDir: string } {
	const projectRoot = join(root, "project");
	const runsDir = join(root, "runs");
	const inputsDir = join(root, "inputs");
	return { projectRoot, runsDir, inputsDir, rootDir: join(runsDir, OUTPUT_ROOT_NAME_V2) };
}

/** Build the passing temp project root + frozen inputs copy + empty runs dir. */
async function prepareCollectV2(root: string): Promise<{ projectRoot: string; runsDir: string; inputsDir: string; rootDir: string }> {
	const layout = runsLayoutV2(root);
	await makeSystemRoot(layout.projectRoot);
	await makeInputsTree(root);
	await mkdir(layout.runsDir);
	return layout;
}

/** Run `collectFinalV2` hermetically (injected runner, injected Node pin, temp roots only). */
async function collectWithV2(
	root: string,
	options: {
		runner: SpawnAttemptRunnerV2;
		hooks?: CollectFinalV2Hooks;
		retainHooks?: RetainRawSourceV2Hooks;
		writeHooks?: WriteCollectionRecordV2Hooks;
		protocol?: V2FrozenProtocol;
		env?: NodeJS.ProcessEnv;
		onDiagnostic?: (line: string) => void;
	},
): Promise<CollectFinalV2Result> {
	const layout = runsLayoutV2(root);
	await prepareCollectV2(root);
	return collectFinalV2({
		projectRoot: layout.projectRoot,
		runsDir: layout.runsDir,
		inputsDir: layout.inputsDir,
		runner: options.runner,
		runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion },
		hooks: options.hooks,
		retainHooks: options.retainHooks,
		writeHooks: options.writeHooks,
		protocol: options.protocol,
		env: options.env,
		onDiagnostic: options.onDiagnostic,
	});
}

/** A machine-valid session raw and a prompt-mismatch invalid raw (frozen pin semantics). */
const VALID_RAW_V2 = rawOf(validSessionEntries());
const INVALID_RAW_V2 = rawOf([userMessage("a different prompt"), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]);
/** The classifier-unrepresentable raw (malformed JSONL). */
const UNREPRESENTABLE_RAW_V2 = Buffer.from("not-json\n", "utf8");

/** Assert the persisted record byte-equals the in-memory one, with every owned attempt dir cleaned — except the explicitly expected survivors. */
async function assertPersistedStateV2(rootDir: string, result: CollectFinalV2Result, expectedAttemptDirSurvivors: readonly string[] = []): Promise<void> {
	assert.equal(await readFile(join(rootDir, COLLECTION_RECORD_NAME), "utf8"), collectionRecordToJsonV2(result.record));
	assert.deepEqual(parseCollectionRecordV2(collectionRecordToJsonV2(result.record)), result.record);
	const rootNames = await readdir(rootDir);
	const attemptDirs = rootNames.filter((n) => n.startsWith(".attempt-"));
	const expected = [...new Set(expectedAttemptDirSurvivors)].sort();
	assert.deepEqual(attemptDirs.sort(), expected, "every owned attempt dir must be cleaned after commit except the expected survivors");
	const sources = await readdir(join(rootDir, SOURCES_DIR_NAME_V2));
	assert.equal(sources.length, result.record.entries.length, "one retained source per recorded entry");
}

test("collectFinalV2: both read-only preflights run BEFORE any output creation or runner call", async () => {
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		await prepareCollectV2(root);
		let runnerCalls = 0;
		let hookRan = false;
		const { runner } = makeFakeRunnerV2(() => ({ kind: "raw", raw: VALID_RAW_V2 }));
		const result = await collectFinalV2({
			projectRoot: layout.projectRoot,
			runsDir: layout.runsDir,
			inputsDir: layout.inputsDir,
			runner: async (request) => {
				runnerCalls += 1;
				return runner(request);
			},
			runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion },
			hooks: {
				afterPreflights: async () => {
					hookRan = true;
					// no output root exists yet and the runner was never called
					assert.deepEqual(await readdir(layout.runsDir), []);
					assert.equal(runnerCalls, 0);
				},
			},
		});
		assert.ok(hookRan);
		assert.equal(result.status, "complete");
		assert.equal(runnerCalls, 40);
	});
	// a preflight failure — protocol drift — leaves no output and never calls the runner
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		await prepareCollectV2(root);
		let runnerCalls = 0;
		const { runner } = makeFakeRunnerV2(() => ({ kind: "raw", raw: VALID_RAW_V2 }));
		const error = await collectFinalV2({
			projectRoot: layout.projectRoot,
			runsDir: layout.runsDir,
			inputsDir: layout.inputsDir,
			runner: async (request) => {
				runnerCalls += 1;
				return runner(request);
			},
			runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion },
			protocol: { ...FROZEN_NRO_V2_PROTOCOL, milestonePromptSha256: "0".repeat(64) },
		}).then(
			() => null,
			(e: unknown) => e,
		);
		assert.ok(error instanceof NroV2FinalCollectError);
		assert.equal(error.code, "PROTOCOL_UNFROZEN");
		assert.equal(runnerCalls, 0);
		assert.deepEqual(await readdir(layout.runsDir), [], "preflight drift must create no output");
	});
});

test("collectFinalV2: complete — exactly 40 ABBA sessions with exact request composition and started accounting", async () => {
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		// the session dir must already exist when the runner is invoked —
		// observed at onRequest time (the dirs are cleaned again before the
		// collection returns, so post-return checks can never see them)
		const sessionDirsAtInvoke: string[] = [];
		const { runner, calls } = makeFakeRunnerV2(() => ({ kind: "raw", raw: VALID_RAW_V2 }), {
			onRequest: async (request) => {
				const sessionDir = request.argv[10];
				assert.ok(sessionDir !== undefined, "every attempt request carries a --session-dir");
				assert.ok(existsSync(sessionDir), `the session dir must already exist when the runner is invoked: ${sessionDir}`);
				sessionDirsAtInvoke.push(basename(sessionDir));
			},
		});
		const result = await collectWithV2(root, { runner });
		assert.equal(result.status, "complete");
		assert.equal(result.validCount, 40);
		assert.equal(result.startedAttempts, 40);
		assert.equal(result.record.entries.length, 40);
		assert.equal(result.recordLocation, `${OUTPUT_ROOT_NAME_V2}/${COLLECTION_RECORD_NAME}`);
		// frozen ABBA arms and deterministic retained paths, chronological
		for (const [i, entry] of result.record.entries.entries()) {
			const arm = abbaArmAtV2(i + 1);
			assert.equal(entry.kind, "session");
			assert.equal(entry.arm, arm);
			assert.equal(entry.path, `sources/${rawSourceNameV2(i + 1, arm)}`);
			assert.equal(entry.expectedSessionSha256, sha256Hex(VALID_RAW_V2));
		}
		await assertPersistedStateV2(layout.rootDir, result);
		// every retained source is byte-exact
		for (const entry of result.record.entries) {
			assert.equal(Buffer.compare(await readFile(join(layout.rootDir, entry.path)), VALID_RAW_V2), 0);
		}
		// request composition: verified relative facts joined under the project root,
		// fixture cwd under the inputs dir, exact prompt text, frozen envelope
		assert.equal(calls.length, 40);
		for (const [i, request] of calls.entries()) {
			const arm = abbaArmAtV2(i + 1);
			const attempt = i + 1;
			assert.equal(request.program, join(layout.projectRoot, PI_BINARY_RELATIVE_V2));
			assert.equal(request.cwd, join(layout.inputsDir, FIXTURE_DIR_NAME));
			assert.deepEqual(request.env, buildAttemptEnvV2(process.env), "the default env is the process env read at call time");
			assert.equal(request.env.PI_SKIP_VERSION_CHECK, "1");
			assert.equal(request.env.PI_TELEMETRY, "0");
			assert.equal(request.timeoutMs, ATTEMPT_TIMEOUT_MS_V2);
			assert.equal(request.terminateGraceMs, TERMINATE_GRACE_MS_V2);
			assert.equal(request.stdoutMaxBytes, ATTEMPT_STDOUT_MAX_BYTES_V2);
			assert.equal(request.stderrMaxBytes, ATTEMPT_STDERR_MAX_BYTES_V2);
			const expectedArgv = buildAttemptArgvV2({
				extensionPath: join(layout.projectRoot, arm === "control" ? CONTROL_ARM_FILE_RELATIVE_V2 : TREATMENT_ARM_FILE_RELATIVE_V2),
				sessionDir: join(layout.rootDir, attemptSessionDirNameV2(attempt)),
				attemptNumber: attempt,
				arm,
				promptText: PROMPT_TEXT,
			});
			assert.deepEqual(request.argv, expectedArgv);
		}
		// the session dir already exists when the runner is invoked: every
		// invocation observed it, in attempt order
		assert.deepEqual(
			sessionDirsAtInvoke,
			Array.from({ length: 40 }, (_, i) => attemptSessionDirNameV2(i + 1)),
			"every session dir must exist at runner-invocation time, in attempt order",
		);
		// post-return cleanup assertions: no owned attempt dir survives the return
		for (let attempt = 1; attempt <= 40; attempt += 1) {
			assert.ok(!existsSync(join(layout.rootDir, attemptSessionDirNameV2(attempt))), `owned attempt dir ${attemptSessionDirNameV2(attempt)} must be cleaned after return`);
		}
	});
});

test("collectFinalV2: invalid representable attempts retry the same required arm, stay kind attempt and are retained byte-exact", async () => {
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		// attempts 1-2 invalid (position 1 control), 3 valid, 4-5 invalid (position 2 treatment), 6 valid, then all valid
		const { runner, calls } = makeFakeRunnerV2((attempt) =>
			attempt === 1 || attempt === 2 || attempt === 4 || attempt === 5 ? { kind: "raw", raw: INVALID_RAW_V2 } : { kind: "raw", raw: VALID_RAW_V2 },
		);
		const result = await collectWithV2(root, { runner });
		assert.equal(result.status, "complete");
		assert.equal(result.validCount, 40);
		assert.equal(result.startedAttempts, 44);
		assert.equal(calls.length, 44);
		const entries = result.record.entries;
		assert.equal(entries.length, 44);
		// chronological kinds: attempt, attempt, session, attempt, attempt, session, ...
		assert.deepEqual(entries.slice(0, 6).map((e) => e?.kind), ["attempt", "attempt", "session", "attempt", "attempt", "session"]);
		// same-arm retry: entries 0..2 all control (position 1), 3..5 all treatment (position 2)
		assert.deepEqual(entries.slice(0, 3).map((e) => e?.arm), ["control", "control", "control"]);
		assert.deepEqual(entries.slice(3, 6).map((e) => e?.arm), ["treatment", "treatment", "treatment"]);
		// invalid attempts keep kind attempt with their own-byte SHA; valid raws are sessions
		assert.equal(entries[0]?.expectedSessionSha256, sha256Hex(INVALID_RAW_V2));
		assert.equal(entries[2]?.expectedSessionSha256, sha256Hex(VALID_RAW_V2));
		// strict parse + persisted state + byte-exact retained invalid raws
		await assertPersistedStateV2(layout.rootDir, result);
		assert.equal(Buffer.compare(await readFile(join(layout.rootDir, "sources", rawSourceNameV2(1, "control"))), INVALID_RAW_V2), 0);
		assert.equal(Buffer.compare(await readFile(join(layout.rootDir, "sources", rawSourceNameV2(4, "treatment"))), INVALID_RAW_V2), 0);
		assert.equal(Buffer.compare(await readFile(join(layout.rootDir, "sources", rawSourceNameV2(6, "treatment"))), VALID_RAW_V2), 0);
	});
});

test("collectFinalV2: the 60-started cap returns a truthful attempts-exhausted partial result", async () => {
	// all-invalid: 60 started attempts, 0 valid, 60 attempt entries at position 1 (control)
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		const { runner, calls } = makeFakeRunnerV2(() => ({ kind: "raw", raw: INVALID_RAW_V2 }));
		const result = await collectWithV2(root, { runner });
		assert.equal(result.status, "attempts-exhausted");
		assert.equal(result.validCount, 0);
		assert.equal(result.startedAttempts, 60);
		assert.equal(calls.length, 60);
		assert.equal(result.record.entries.length, 60);
		assert.ok(result.record.entries.every((e) => e.kind === "attempt" && e.arm === "control"));
		assert.ok(!JSON.stringify(result.record).includes("exhausted"), "the strict record never carries a status/cap field");
		await assertPersistedStateV2(layout.rootDir, result);
	});
	// mixed truthful partial: 45 invalid then 15 valid — cap reached with 15 valid
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		const { runner } = makeFakeRunnerV2((attempt) => (attempt <= 45 ? { kind: "raw", raw: INVALID_RAW_V2 } : { kind: "raw", raw: VALID_RAW_V2 }));
		const result = await collectWithV2(root, { runner });
		assert.equal(result.status, "attempts-exhausted");
		assert.equal(result.validCount, 15);
		assert.equal(result.startedAttempts, 60);
		assert.equal(result.record.entries.length, 60);
		assert.deepEqual(result.record.entries.slice(0, 45).map((e) => e?.arm), Array(45).fill("control"));
		assert.deepEqual(result.record.entries.slice(45).map((e) => e?.kind), Array(15).fill("session"));
		assert.deepEqual(result.record.entries.slice(45).map((e) => e?.arm), Array.from({ length: 15 }, (_, i) => abbaArmAtV2(i + 1)));
		await assertPersistedStateV2(layout.rootDir, result);
	});
});

test("collectFinalV2: a spawn start failure hard-fails — not counted, no entry, attempt dir and partial record preserved", async () => {
	// first attempt fails to start: the initial empty record stays and the attempt dir is preserved
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		const { runner, calls } = makeFakeRunnerV2(() => ({ kind: "start-failure" }));
		const error = await collectWithV2(root, { runner }).then(
			() => null,
			(e: unknown) => e,
		);
		assert.ok(error instanceof NroV2FinalCollectError);
		assert.equal(error.code, "ATTEMPT_START_FAILED");
		assert.equal(error.message, SPAWN_START_FAILED_DETAIL_V2);
		assert.equal(calls.length, 1);
		assert.deepEqual(parseCollectionRecordV2(await readFile(join(layout.rootDir, COLLECTION_RECORD_NAME), "utf8")).entries, []);
		assert.deepEqual(await readdir(join(layout.rootDir, SOURCES_DIR_NAME_V2)), []);
		assert.ok(existsSync(join(layout.rootDir, attemptSessionDirNameV2(1))), "the attempt dir must be preserved");
	});
	// start failure after one committed session: truthful 1-entry record, attempt-02 dir preserved
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		const { runner, calls } = makeFakeRunnerV2((attempt) => (attempt === 1 ? { kind: "raw", raw: VALID_RAW_V2 } : { kind: "start-failure" }));
		const error = await collectWithV2(root, { runner }).then(
			() => null,
			(e: unknown) => e,
		);
		assert.ok(error instanceof NroV2FinalCollectError);
		assert.equal(error.code, "ATTEMPT_START_FAILED");
		assert.equal(calls.length, 2);
		const entries = parseCollectionRecordV2(await readFile(join(layout.rootDir, COLLECTION_RECORD_NAME), "utf8")).entries;
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.kind, "session");
		assert.ok(existsSync(join(layout.rootDir, SOURCES_DIR_NAME_V2, rawSourceNameV2(1, "control"))));
		assert.ok(!existsSync(join(layout.rootDir, attemptSessionDirNameV2(1))));
		assert.ok(existsSync(join(layout.rootDir, attemptSessionDirNameV2(2))), "the failed attempt dir must be preserved");
	});
});

test("collectFinalV2: locator failures hard-fail immediately — attempt dir and partial record preserved, nothing retained, never continues", async () => {
	const cases: Array<{ name: string; produce: FakeProduceV2; code: NroV2FinalCollectErrorCode; dirEntries: string[] }> = [
		{ name: "zero produced", produce: { kind: "none" }, code: "SESSION_FILE_COUNT", dirEntries: [] },
		{ name: "multiple produced", produce: { kind: "multiple" }, code: "SESSION_FILE_COUNT", dirEntries: ["raw-session-2.jsonl", FINAL_SESSION_BASENAME_V2] },
		{ name: "over-bounded produced", produce: { kind: "overbound" }, code: "SESSION_OVER_BOUND", dirEntries: [FINAL_SESSION_BASENAME_V2] },
	];
	for (const c of cases) {
		await withTempDir(async (root) => {
			const layout = runsLayoutV2(root);
			const { runner, calls } = makeFakeRunnerV2((attempt) => (attempt === 1 ? { kind: "raw", raw: VALID_RAW_V2 } : c.produce));
			const error = await collectWithV2(root, { runner }).then(
				() => null,
				(e: unknown) => e,
			);
			assert.ok(error instanceof NroV2FinalCollectError, c.name);
			assert.equal(error.code, c.code, c.name);
			assert.equal(calls.length, 2, `${c.name}: never continues`);
			const entries = parseCollectionRecordV2(await readFile(join(layout.rootDir, COLLECTION_RECORD_NAME), "utf8")).entries;
			assert.equal(entries.length, 1, c.name);
			assert.equal(entries[0]?.kind, "session", c.name);
			assert.deepEqual(await readdir(join(layout.rootDir, SOURCES_DIR_NAME_V2)), [rawSourceNameV2(1, "control")], `${c.name}: nothing retained for the failed attempt`);
			assert.deepEqual(await readdir(join(layout.rootDir, attemptSessionDirNameV2(2))), c.dirEntries, `${c.name}: the ENTIRE attempt dir is preserved`);
			assert.ok(!existsSync(join(layout.rootDir, attemptSessionDirNameV2(1))), c.name);
		});
	}
});

test("collectFinalV2: a classifier-unrepresentable raw hard-fails — nothing retained or fabricated, attempt dir and partial record preserved", async () => {
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		const { runner, calls } = makeFakeRunnerV2((attempt) => (attempt === 1 ? { kind: "raw", raw: VALID_RAW_V2 } : { kind: "raw", raw: UNREPRESENTABLE_RAW_V2 }));
		const error = await collectWithV2(root, { runner }).then(
			() => null,
			(e: unknown) => e,
		);
		assert.ok(error instanceof NroV2FinalCollectError);
		assert.equal(error.code, "ATTEMPT_UNREPRESENTABLE");
		assert.equal(error.message, UNREPRESENTABLE_DETAIL_V2);
		assert.equal(calls.length, 2);
		const entries = parseCollectionRecordV2(await readFile(join(layout.rootDir, COLLECTION_RECORD_NAME), "utf8")).entries;
		assert.equal(entries.length, 1);
		assert.deepEqual(await readdir(join(layout.rootDir, SOURCES_DIR_NAME_V2)), [rawSourceNameV2(1, "control")], "the unrepresentable raw is never retained");
		assert.deepEqual(await readdir(join(layout.rootDir, attemptSessionDirNameV2(2))), [FINAL_SESSION_BASENAME_V2], "the entire attempt dir is preserved");
	});
});

test("collectFinalV2: transaction order is raw retention -> strict record commit -> owned attempt-session cleanup", async () => {
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		const { runner } = makeFakeRunnerV2(() => ({ kind: "raw", raw: VALID_RAW_V2 }));
		let tempCommits = 0;
		let publishes = 0;
		let entryCommits = 0;
		const result = await collectWithV2(root, {
			runner,
			writeHooks: {
				afterTempCommit: async () => {
				tempCommits += 1;
				if (tempCommits !== 1) return;
				// pre-commit of the FIRST entry: retained source already byte-exact,
				// attempt dir still present, record still the initial empty one
				assert.ok(existsSync(join(layout.rootDir, SOURCES_DIR_NAME_V2, rawSourceNameV2(1, "control"))));
				assert.equal(Buffer.compare(await readFile(join(layout.rootDir, SOURCES_DIR_NAME_V2, rawSourceNameV2(1, "control"))), VALID_RAW_V2), 0);
				assert.ok(existsSync(join(layout.rootDir, attemptSessionDirNameV2(1))));
				assert.deepEqual(parseCollectionRecordV2(await readFile(join(layout.rootDir, COLLECTION_RECORD_NAME), "utf8")).entries, []);
				},
				afterPublish: async () => {
					publishes += 1;
					if (publishes !== 1) return;
					// post-commit of the FIRST entry: record committed, source retained,
					// attempt dir still present (cleanup comes after the write returns)
					assert.equal(parseCollectionRecordV2(await readFile(join(layout.rootDir, COLLECTION_RECORD_NAME), "utf8")).entries.length, 1);
					assert.ok(existsSync(join(layout.rootDir, attemptSessionDirNameV2(1))));
				},
			},
			hooks: {
				afterEntryCommit: async (attempt, arm, kind) => {
					entryCommits += 1;
					if (attempt !== 1) return;
					assert.equal(arm, "control");
					assert.equal(kind, "session");
					assert.equal(parseCollectionRecordV2(await readFile(join(layout.rootDir, COLLECTION_RECORD_NAME), "utf8")).entries.length, 1);
					assert.ok(existsSync(join(layout.rootDir, attemptSessionDirNameV2(1))), "cleanup runs only after the commit hook");
				},
			},
		});
		assert.equal(result.status, "complete");
		assert.ok(tempCommits >= 1 && publishes >= 1 && entryCommits === 40);
		// after return: every owned attempt dir is cleaned and the record is persisted
		await assertPersistedStateV2(layout.rootDir, result);
	});
});

test("collectFinalV2: a pre-commit NroV2RecordWriteError reverts only the prospective entry and removes only the owned retained source", async () => {
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		const writeError = new NroV2RecordWriteError("RECORD_IO", "the collection record write was interrupted by an internal stage failure", false);
		const { runner, calls } = makeFakeRunnerV2(() => ({ kind: "raw", raw: VALID_RAW_V2 }));
		let writes = 0;
		const error = await collectWithV2(root, {
			runner,
			writeHooks: {
				afterTempCommit: () => {
					writes += 1;
					if (writes === 2) throw writeError;
				},
			},
		}).then(
			() => null,
			(e: unknown) => e,
		);
		assert.equal(error, writeError, "the structured pre-commit failure propagates unchanged");
		assert.equal(calls.length, 2);
		const entries = parseCollectionRecordV2(await readFile(join(layout.rootDir, COLLECTION_RECORD_NAME), "utf8")).entries;
		assert.equal(entries.length, 1, "the prior truthful record is preserved");
		assert.equal(entries[0]?.kind, "session");
		// the prior in-memory record is byte-exact the committed one — the
		// prospective entry of the failed write is NOT reflected anywhere
		const committedEntry: CollectionEntryV2 = { kind: "session", arm: "control", path: `sources/${rawSourceNameV2(1, "control")}`, expectedSessionSha256: sha256Hex(VALID_RAW_V2) };
		const committedRecord: CollectionRecordV2 = { ...buildInitialCollectionRecordV2(), entries: [committedEntry] };
		assert.equal(await readFile(join(layout.rootDir, COLLECTION_RECORD_NAME), "utf8"), collectionRecordToJsonV2(committedRecord), "the prior truthful record is preserved byte-exact");
		assert.deepEqual(await readdir(join(layout.rootDir, SOURCES_DIR_NAME_V2)), [rawSourceNameV2(1, "control")], "only the owned retained source of the failed entry is removed");
		assert.deepEqual(await readdir(join(layout.rootDir, attemptSessionDirNameV2(2))), [FINAL_SESSION_BASENAME_V2], "the attempt dir is preserved");
	});
});

test("collectFinalV2: a post-commit NroV2RecordWriteError preserves the committed entry and retained source without attempt-dir cleanup", async () => {
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		const writeError = new NroV2RecordWriteError("STORAGE_IO", "the storage root was replaced or is no longer the owned entry", true);
		const { runner, calls } = makeFakeRunnerV2(() => ({ kind: "raw", raw: VALID_RAW_V2 }));
		let writes = 0;
		const error = await collectWithV2(root, {
			runner,
			writeHooks: {
				afterPublish: () => {
					writes += 1;
					if (writes === 1) throw writeError;
				},
			},
		}).then(
			() => null,
			(e: unknown) => e,
		);
		assert.equal(error, writeError, "the structured post-commit failure propagates unchanged");
		assert.equal(calls.length, 1, "collection never continues");
		const entries = parseCollectionRecordV2(await readFile(join(layout.rootDir, COLLECTION_RECORD_NAME), "utf8")).entries;
		assert.equal(entries.length, 1, "the newly committed entry is preserved");
		assert.equal(entries[0]?.kind, "session");
		// the loop's in-memory record is advanced to the prospective committed
		// record before the rethrow: the committed target is byte-exact the
		// canonical prospective record (in-memory and disk bookkeeping agree)
		const prospectiveEntry: CollectionEntryV2 = { kind: "session", arm: "control", path: `sources/${rawSourceNameV2(1, "control")}`, expectedSessionSha256: sha256Hex(VALID_RAW_V2) };
		const prospectiveRecord: CollectionRecordV2 = { ...buildInitialCollectionRecordV2(), entries: [prospectiveEntry] };
		assert.equal(await readFile(join(layout.rootDir, COLLECTION_RECORD_NAME), "utf8"), collectionRecordToJsonV2(prospectiveRecord), "the committed target is byte-exact the prospective record");
		assert.equal(Buffer.compare(await readFile(join(layout.rootDir, SOURCES_DIR_NAME_V2, rawSourceNameV2(1, "control"))), VALID_RAW_V2), 0, "the retained source is preserved");
		assert.deepEqual(await readdir(join(layout.rootDir, attemptSessionDirNameV2(1))), [FINAL_SESSION_BASENAME_V2], "the attempt dir is NOT cleaned after a committed failure");
	});
});

test("collectFinalV2: owned attempt-session cleanup never touches foreign replacements or children", async () => {
	// a foreign child injected after commit survives; the collection still completes
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		const { runner } = makeFakeRunnerV2(() => ({ kind: "raw", raw: VALID_RAW_V2 }));
		const result = await collectWithV2(root, {
			runner,
			hooks: {
				afterEntryCommit: async (attempt) => {
					if (attempt === 1) {
						await writeFile(join(layout.rootDir, attemptSessionDirNameV2(1), "SECRET-FOREIGN-CHILD-4a2f.txt"), "foreign\n", "utf8");
					}
				},
			},
		});
		assert.equal(result.status, "complete");
		assert.deepEqual(await readdir(join(layout.rootDir, attemptSessionDirNameV2(1))), ["SECRET-FOREIGN-CHILD-4a2f.txt"], "the foreign child survives and the owned produced file is removed");
		assert.ok(!existsSync(join(layout.rootDir, attemptSessionDirNameV2(2))));
		// the intentional foreign-child survivor is EXPECTED: the record and
		// retained sources stay truthful while `.attempt-01-session` survives
		await assertPersistedStateV2(layout.rootDir, result, [attemptSessionDirNameV2(1)]);
	});
	// a foreign replacement of the produced file survives untouched
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		const { runner } = makeFakeRunnerV2(() => ({ kind: "raw", raw: VALID_RAW_V2 }));
		const result = await collectWithV2(root, {
			runner,
			hooks: {
				afterEntryCommit: async (attempt) => {
					if (attempt === 1) {
						// REPLACE the produced file with a genuinely foreign inode
						// (unlink then create) — an in-place truncating write would
						// keep the owned inode and be removed by identity cleanup
						const producedPath = join(layout.rootDir, attemptSessionDirNameV2(1), FINAL_SESSION_BASENAME_V2);
						await rm(producedPath);
						await writeFile(producedPath, "SECRET-FOREIGN-REPLACEMENT-8c3b\n", "utf8");
					}
				},
			},
		});
		assert.equal(result.status, "complete");
		assert.deepEqual(await readdir(join(layout.rootDir, attemptSessionDirNameV2(1))), [FINAL_SESSION_BASENAME_V2]);
		assert.equal(await readFile(join(layout.rootDir, attemptSessionDirNameV2(1), FINAL_SESSION_BASENAME_V2), "utf8"), "SECRET-FOREIGN-REPLACEMENT-8c3b\n", "the foreign inode is never removed");
	});
});

test("collectFinalV2: process exit code and timeout are diagnostic-only — they never change the verdict or the record", async () => {
	await withTempDir(async (root) => {
		const { runner } = makeFakeRunnerV2(() => ({ kind: "raw", raw: VALID_RAW_V2 }), { exitCode: 1, timedOut: true });
		const result = await collectWithV2(root, { runner });
		assert.equal(result.status, "complete");
		assert.equal(result.validCount, 40);
		assert.ok(result.record.entries.every((e) => e.kind === "session"), "a valid raw stays a session despite exit/timeout facts");
	});
	await withTempDir(async (root) => {
		const { runner } = makeFakeRunnerV2((attempt) => (attempt === 1 ? { kind: "raw", raw: INVALID_RAW_V2 } : { kind: "raw", raw: VALID_RAW_V2 }), { exitCode: 7, timedOut: true });
		const result = await collectWithV2(root, { runner });
		assert.equal(result.status, "complete");
		assert.equal(result.record.entries[0]?.kind, "attempt", "an invalid raw stays an attempt despite clean process facts");
		assert.equal(result.record.entries[1]?.kind, "session");
	});
});

test("collectFinalV2: onDiagnostic emits exactly one fixed bounded line per representable invalid attempt and per anomalous valid attempt", async () => {
	await withTempDir(async (root) => {
		const lines: string[] = [];
		const { runner } = makeFakeRunnerV2(
			(attempt) => (attempt <= 2 ? { kind: "raw", raw: INVALID_RAW_V2 } : { kind: "raw", raw: VALID_RAW_V2 }),
			{},
			(attempt) => {
				if (attempt === 1) return { exitCode: 1 }; // invalid + nonzero exit
				if (attempt === 2) return {}; // invalid + clean facts
				if (attempt === 3) return {}; // valid + clean facts -> NO line
				if (attempt === 4) return { timedOut: true }; // valid + timeout
				if (attempt === 5) return { exitCode: null }; // valid + null exit
				if (attempt === 6) return { stdoutBytes: Buffer.alloc(ATTEMPT_STDOUT_MAX_BYTES_V2 + 1, 0x61) }; // valid + stdout overflow
				if (attempt === 7) return { stderrBytes: Buffer.alloc(ATTEMPT_STDERR_MAX_BYTES_V2 + 1, 0x62) }; // valid + stderr overflow
				return {};
			},
		);
		const result = await collectWithV2(root, { runner, onDiagnostic: (line) => lines.push(line) });
		assert.equal(result.status, "complete");
		assert.equal(result.validCount, 40);
		assert.equal(result.startedAttempts, 42);
		assert.deepEqual(result.record.entries.slice(0, 2).map((e) => e?.kind), ["attempt", "attempt"]);
		assert.deepEqual(
			lines,
			[
				"collectFinalV2 diagnostic: attempt=01 arm=control category=prompt_mismatch exitCode=1 timedOut=false stdoutOverflow=false stderrOverflow=false",
				"collectFinalV2 diagnostic: attempt=02 arm=control category=prompt_mismatch exitCode=0 timedOut=false stdoutOverflow=false stderrOverflow=false",
				"collectFinalV2 diagnostic: attempt=04 arm=treatment category=valid exitCode=0 timedOut=true stdoutOverflow=false stderrOverflow=false",
				"collectFinalV2 diagnostic: attempt=05 arm=treatment category=valid exitCode=null timedOut=false stdoutOverflow=false stderrOverflow=false",
				"collectFinalV2 diagnostic: attempt=06 arm=control category=valid exitCode=0 timedOut=false stdoutOverflow=true stderrOverflow=false",
				"collectFinalV2 diagnostic: attempt=07 arm=control category=valid exitCode=0 timedOut=false stdoutOverflow=false stderrOverflow=true",
			],
			"exactly one fixed line per representable invalid attempt and per anomalous valid attempt, in attempt order",
		);
	});
});

test("collectFinalV2: onDiagnostic lines are fixed, bounded and privacy-safe — never raw bytes, paths, names, error text or hidden details", async () => {
	await withTempDir(async (root) => {
		const lines: string[] = [];
		// a representable invalid raw carrying secrets, with anomalous facts
		const secretInvalidRaw = rawOf([
			userMessage("a different prompt"),
			thinkingLevelChange(),
			assistantMessage([toolCallItem(SECRET_CALL_ID, "bash", { cmd: "SECRET-TOOL-ARG-99" }), { type: "thinking", text: SECRET_THINKING }]),
			toolResultMessage(SECRET_CALL_ID, "bash", `${SECRET_BODY}\n${SECRET_PATH}`),
			assistantMessage([{ type: "text", text: `${SECRET_BODY}\n${SECRET_THINKING}\n${RUBRIC_FULL_TEXT}` }]),
		]);
		const { runner } = makeFakeRunnerV2(
			() => ({ kind: "raw", raw: secretInvalidRaw }),
			{
				exitCode: 1,
				timedOut: true,
				stdoutBytes: Buffer.alloc(ATTEMPT_STDOUT_MAX_BYTES_V2 + 1, 0x61),
				stderrBytes: Buffer.alloc(ATTEMPT_STDERR_MAX_BYTES_V2 + 1, 0x62),
			},
		);
		const result = await collectWithV2(root, { runner, onDiagnostic: (line) => lines.push(line) });
		assert.equal(result.status, "attempts-exhausted");
		assert.equal(lines.length, 60, "one line per representable invalid attempt");
		for (const line of lines) {
			assert.match(
				line,
				/^collectFinalV2 diagnostic: attempt=\d{2} arm=(control|treatment) category=(prompt_mismatch|env_drift|compaction_present|aborted|errored|nonterminal) exitCode=-?\d+ timedOut=(true|false) stdoutOverflow=(true|false) stderrOverflow=(true|false)$/,
				`fixed line shape violated: ${line}`,
			);
			for (const secret of [SECRET_CALL_ID, SECRET_PATH, SECRET_BODY, SECRET_THINKING, "SECRET-TOOL-ARG-99"]) {
				assert.ok(!line.includes(secret), `diagnostic leaks "${secret}": ${line}`);
			}
			for (const forbidden of [root, basename(root), "project", "runs", "sources", "raw-session.jsonl", "collection-record", "ENOENT", "EACCES", "EPERM", "Error:", "node:", "aaaaaaaa"]) {
				assert.ok(!line.includes(forbidden), `diagnostic leaks "${forbidden}": ${line}`);
			}
			assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(line), `diagnostic leaks a UUID: ${line}`);
			assert.ok(!/[\u0000-\u001f\u007f]/.test(line), `diagnostic contains control characters: ${line}`);
			assert.ok(line.length <= 200, `unbounded diagnostic line: ${line}`);
		}
		// content classification stays authoritative: 60 attempt entries, zero sessions
		assert.equal(result.record.entries.length, 60);
		assert.ok(result.record.entries.every((e) => e.kind === "attempt"));
	});
});

test("collectFinalV2: diagnostics never change verdicts or the record — content classification stays authoritative", async () => {
	const run = async (withSink: boolean): Promise<{ result: CollectFinalV2Result; lines: string[] }> =>
		withTempDir(async (root) => {
			const lines: string[] = [];
			const { runner } = makeFakeRunnerV2(
				(attempt) => (attempt === 1 ? { kind: "raw", raw: INVALID_RAW_V2 } : { kind: "raw", raw: VALID_RAW_V2 }),
				{},
				(attempt) => {
					if (attempt === 1) return { exitCode: 7, timedOut: true };
					if (attempt === 2) return { stdoutBytes: Buffer.alloc(ATTEMPT_STDOUT_MAX_BYTES_V2 + 1, 0x61), stderrBytes: Buffer.alloc(ATTEMPT_STDERR_MAX_BYTES_V2 + 1, 0x62) };
					return {};
				},
			);
			const result = await collectWithV2(root, { runner, onDiagnostic: withSink ? (line) => lines.push(line) : undefined });
			return { result, lines };
		});
	const withSink = await run(true);
	const withoutSink = await run(false);
	assert.deepEqual(withSink.result, withoutSink.result, "the diagnostic sink never changes the result");
	assert.equal(withSink.result.status, "complete");
	assert.equal(withSink.result.validCount, 40);
	assert.equal(withSink.result.startedAttempts, 41);
	assert.equal(withSink.result.record.entries[0]?.kind, "attempt", "an invalid raw stays an attempt despite anomalous facts and the sink");
	assert.ok(withSink.result.record.entries.slice(1).every((e) => e.kind === "session"));
	assert.equal(withSink.lines.length, 2, "one invalid line and one anomalous-valid line");
	assert.equal(withoutSink.lines.length, 0);
});

test("collectFinalV2: the run result and every hard-failure error are fixed, bounded and privacy-safe", async () => {
	// the successful result never leaks roots, absolute paths or raw content
	await withTempDir(async (root) => {
		const { runner } = makeFakeRunnerV2(() => ({ kind: "raw", raw: VALID_RAW_V2 }));
		const result = await collectWithV2(root, { runner });
		const json = JSON.stringify(result);
		for (const secret of [root, basename(root), "project", "runs", VALID_RAW_V2.toString("utf8")]) {
			assert.ok(!json.includes(secret), `result JSON leaks "${secret}"`);
		}
		assert.ok(!json.includes("exhausted"), "the strict record never carries the cap status");
	});
	// every hard-failure error is fixed, bounded and never leaks the workspace
	await withTempDir(async (root) => {
		const layout = runsLayoutV2(root);
		await prepareCollectV2(root);
		const writeError = new NroV2RecordWriteError("RECORD_IO", "the collection record write was interrupted by an internal stage failure", false);
		const scenarios: Array<{ name: string; run: (runsDir: string) => Promise<unknown> }> = [];
		const startFailure = makeFakeRunnerV2(() => ({ kind: "start-failure" }));
		scenarios.push({
			name: "start failure",
			run: (runsDir) =>
				collectFinalV2({ projectRoot: layout.projectRoot, runsDir, inputsDir: layout.inputsDir, runner: startFailure.runner, runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion } }),
		});
		const unrepresentable = makeFakeRunnerV2(() => ({ kind: "raw", raw: UNREPRESENTABLE_RAW_V2 }));
		scenarios.push({
			name: "unrepresentable",
			run: (runsDir) =>
				collectFinalV2({ projectRoot: layout.projectRoot, runsDir, inputsDir: layout.inputsDir, runner: unrepresentable.runner, runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion } }),
		});
		const locator = makeFakeRunnerV2(() => ({ kind: "none" }));
		scenarios.push({
			name: "locator failure",
			run: (runsDir) =>
				collectFinalV2({ projectRoot: layout.projectRoot, runsDir, inputsDir: layout.inputsDir, runner: locator.runner, runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion } }),
		});
		const preCommit = makeFakeRunnerV2(() => ({ kind: "raw", raw: VALID_RAW_V2 }));
		let writes = 0;
		scenarios.push({
			name: "pre-commit write failure",
			run: (runsDir) =>
				collectFinalV2({
					projectRoot: layout.projectRoot,
					runsDir,
					inputsDir: layout.inputsDir,
					runner: preCommit.runner,
					runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion },
					writeHooks: {
						afterTempCommit: () => {
							writes += 1;
							if (writes === 1) throw writeError;
						},
					},
				}),
		});
		for (const [n, s] of scenarios.entries()) {
			const runsDir = join(layout.runsDir, `scenario-${n + 1}`);
			await mkdir(runsDir);
			const error = await s.run(runsDir).then(
				() => null,
				(e: unknown) => e,
			);
			assert.ok(error instanceof Error, s.name);
			const text = `${error.name} ${error.message}`;
			for (const secret of [root, basename(root), "project", "runs", "ENOENT", "ENOTDIR", "EACCES", "EPERM", "Error:", "node:", "SECRET", "raw-session.jsonl", "collection-record.json"]) {
				assert.ok(!text.includes(secret), `${s.name}: error leaks "${secret}": ${text}`);
			}
			assert.ok(!/[\u0000-\u001f\u007f]/.test(text), `${s.name}: control characters in the error`);
			assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text), `${s.name}: UUID leak`);
			assert.ok(error.message.length <= 200, `${s.name}: unbounded error message`);
		}
	});
});

// ------------------------------------------------------------------ CLI

function captureIo(): { io: FinalIo; stdout: string[]; stderr: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return { io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, stdout, stderr };
}

/** Run the CLI hermetically over the temp layout with an injected fake runner (returns the run result too). */
async function collectThroughCliV2(
	root: string,
	runner: SpawnAttemptRunnerV2,
): Promise<{ code: number; stdout: string[]; stderr: string[]; result: CollectFinalV2Result }> {
	const layout = runsLayoutV2(root);
	await prepareCollectV2(root);
	const { io, stdout, stderr } = captureIo();
	let result: CollectFinalV2Result = null as unknown as CollectFinalV2Result;
	const code = await main([], io, async (opts) => {
		result = await collectFinalV2({
			projectRoot: layout.projectRoot,
			runsDir: layout.runsDir,
			inputsDir: layout.inputsDir,
			runner,
			runtime: { nodeVersion: FROZEN_ENVIRONMENT.nodeVersion },
			onDiagnostic: opts.onDiagnostic,
		});
		return result;
	});
	return { code, stdout, stderr, result };
}

test("main: --help/-h exit 0 with usage on stdout and nothing on stderr", async () => {
	const { io, stdout, stderr } = captureIo();
	assert.equal(await main(["--help"], io), 0);
	assert.equal(await main(["-h"], io), 0);
	const all = stdout.join("\n");
	assert.ok(all.includes("usage:"));
	assert.ok(all.includes("exit codes: 0"));
	assert.ok(usage().includes("FINAL validation collector (final evidence only)"));
	assert.deepEqual(stderr, []);
});

test("main: unknown and positional arguments exit 2 with a FIXED usage error on stderr — argv is never echoed", async () => {
	const usageText = usage();
	const fixedError = `commander-native-tool-v2-final-collect: unexpected argument(s) — usage error (details withheld)\n${usageText}`;
	for (const argv of [
		["x"],
		["--flag"],
		["positional"],
		["a", "b"],
		["--help", "extra"],
		["-h", "x"],
		["--secret-flag", "SECRET-TOKEN-9f2c", "positional"],
	]) {
		const { io, stdout, stderr } = captureIo();
		const code = await main(argv, io);
		assert.equal(code, 2, JSON.stringify(argv));
		assert.deepEqual(stdout, [], JSON.stringify(argv));
		assert.equal(stderr.length, 1, JSON.stringify(argv));
		// the error is EXACTLY the fixed privacy-safe line — no dynamic argv
		assert.equal(stderr[0], fixedError, JSON.stringify(argv));
		// belt-and-braces: no argv token appears beyond the fixed usage text
		// (the fixed text legitimately documents the literal --help/-h flags
		// and words like "x10"/"positional", so only dynamic tokens are checked)
		for (const token of argv) {
			if (usageText.includes(token)) continue;
			assert.ok(!(stderr[0] as string).includes(token), `argv must never be echoed back: ${token}`);
		}
	}
});

test("main: complete run exits 0 with the single exact bounded relative summary", async () => {
	await withTempDir(async (root) => {
		const { runner } = makeFakeRunnerV2(() => ({ kind: "raw", raw: VALID_RAW_V2 }));
		const { code, stdout, stderr, result } = await collectThroughCliV2(root, runner);
		assert.equal(code, 0);
		assert.equal(result.status, "complete");
		assert.equal(result.validCount, 40);
		assert.equal(result.startedAttempts, 40);
		assert.equal(stdout.length, 1);
		const line = stdout[0] as string;
		assert.equal(line, renderSummary(result));
		assert.equal(line, `commander-native-tool-v2-final-collect: status=complete valid=40 attempts=40 collection=.pi/workbench/runs/${OUTPUT_ROOT_NAME_V2}/${COLLECTION_RECORD_NAME}`);
		assert.ok(!line.includes(root), "summary must not carry absolute paths");
		assert.ok(!line.includes(PROMPT_TEXT), "summary must never carry prompt content");
		assert.deepEqual(stderr, []);
	});
});

test("main: attempts-exhausted exits 1 with the truthful partial summary and the existing fixed diagnostics forwarded to stderr", async () => {
	await withTempDir(async (root) => {
		const { runner } = makeFakeRunnerV2(() => ({ kind: "raw", raw: INVALID_RAW_V2 }));
		const { code, stdout, stderr, result } = await collectThroughCliV2(root, runner);
		assert.equal(code, 1);
		assert.equal(result.status, "attempts-exhausted");
		assert.equal(result.validCount, 0);
		assert.equal(result.startedAttempts, 60);
		assert.equal(stdout.length, 1);
		assert.equal(stdout[0], renderSummary(result));
		assert.equal(stdout[0], `commander-native-tool-v2-final-collect: status=attempts-exhausted valid=0 attempts=60 collection=.pi/workbench/runs/${OUTPUT_ROOT_NAME_V2}/${COLLECTION_RECORD_NAME}`);
		// the fixed bounded onDiagnostic lines are forwarded verbatim to stderr
		assert.equal(stderr.length, 60);
		for (const line of stderr) {
			assert.ok(
				/^collectFinalV2 diagnostic: attempt=\d{2} arm=control category=prompt_mismatch exitCode=0 timedOut=false stdoutOverflow=false stderrOverflow=false$/.test(line),
				line,
			);
			assert.ok(!line.includes(root), "diagnostics must not carry absolute paths");
			assert.ok(!line.includes(PROMPT_TEXT), "diagnostics must never carry prompt content");
		}
	});
});

test("main: collector runtime failures exit 1 with stderr only — prefix + code + the already-fixed message (incl. NroV2RecordWriteError)", async () => {
	const { io, stdout, stderr } = captureIo();
	const code = await main([], io, async () => {
		throw new NroV2FinalCollectError("ATTEMPT_START_FAILED", SPAWN_START_FAILED_DETAIL_V2);
	});
	assert.equal(code, 1);
	assert.deepEqual(stdout, []);
	assert.equal(stderr.length, 1);
	assert.equal(stderr[0], `commander-native-tool-v2-final-collect: ATTEMPT_START_FAILED: ${SPAWN_START_FAILED_DETAIL_V2}`);
	// NroV2RecordWriteError is a collector error and renders the same fixed way
	const { io: io2, stdout: stdout2, stderr: stderr2 } = captureIo();
	const code2 = await main([], io2, async () => {
		throw new NroV2RecordWriteError("RECORD_IO", "the collection record write was interrupted by an internal stage failure", false);
	});
	assert.equal(code2, 1);
	assert.deepEqual(stdout2, []);
	assert.equal(stderr2.length, 1);
	assert.equal(stderr2[0], "commander-native-tool-v2-final-collect: RECORD_IO: the collection record write was interrupted by an internal stage failure");
});

test("main: non-collector runtime failures exit 1 with the single fixed details-withheld line (privacy boundary)", async () => {
	const { io, stdout, stderr } = captureIo();
	const code = await main([], io, async () => {
		throw new Error(`sensitive detail ${REPO_ROOT} SECRET-TOKEN-9f2c`);
	});
	assert.equal(code, 1);
	assert.deepEqual(stdout, []);
	assert.equal(stderr.length, 1);
	assert.equal(stderr[0], "commander-native-tool-v2-final-collect: unexpected failure (details withheld — privacy boundary)");
});

test("main: no-args default paths are rooted at process.cwd() and the fixed onDiagnostic lines are forwarded to stderr", async () => {
	const cwd = process.cwd();
	const captured: { seen: CollectFinalV2Options | null } = { seen: null };
	const { io, stdout, stderr } = captureIo();
	const code = await main([], io, async (opts) => {
		captured.seen = opts;
		opts.onDiagnostic?.("collectFinalV2 diagnostic: attempt=01 arm=control category=prompt_mismatch exitCode=0 timedOut=false stdoutOverflow=false stderrOverflow=false");
		return { status: "complete", validCount: 40, startedAttempts: 40, record: buildInitialCollectionRecordV2(), recordLocation: `${OUTPUT_ROOT_NAME_V2}/${COLLECTION_RECORD_NAME}` };
	});
	assert.equal(code, 0);
	assert.ok(captured.seen !== null, "the injected collect must be called with the production default paths");
	assert.equal(captured.seen.projectRoot, cwd);
	assert.equal(captured.seen.runsDir, join(cwd, ".pi", "workbench", "runs"));
	assert.equal(captured.seen.inputsDir, join(cwd, "fixtures", "commander-native-tool-benchmark-v2", "inputs"));
	assert.equal(stdout.length, 1);
	assert.equal(stdout[0], `commander-native-tool-v2-final-collect: status=complete valid=40 attempts=40 collection=.pi/workbench/runs/${OUTPUT_ROOT_NAME_V2}/${COLLECTION_RECORD_NAME}`);
	assert.deepEqual(stderr, ["collectFinalV2 diagnostic: attempt=01 arm=control category=prompt_mismatch exitCode=0 timedOut=false stdoutOverflow=false stderrOverflow=false"]);
});

// The tsx ESM loader, absolute (resolution must not depend on the probe cwd).
const TSX_LOADER = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

test("direct-execution guard: importing the module in a fresh process never runs main/collection (temp cwd, no outputs, no calls)", async () => {
	await withTempDir(async (root) => {
		const probe = `import(${JSON.stringify(pathToFileURL(SOURCE_PATH).href)}).then((m) => { if (typeof m.main !== "function" || typeof m.usage !== "function" || typeof m.renderSummary !== "function") process.exit(3); console.log("import-ok"); }).catch((e) => { console.error(String(e)); process.exit(4); });`;
		const result = spawnSync(process.execPath, ["--import", TSX_LOADER, "-e", probe], { cwd: root, encoding: "utf8", timeout: 120_000 });
		assert.equal(result.status, 0, `import subprocess failed (${String(result.status)}): ${result.stderr}`);
		assert.ok((result.stdout ?? "").includes("import-ok"), result.stdout);
		assert.equal(result.stderr, "", result.stderr);
		// the guard never ran main/collection: the throwaway cwd stays empty
		assert.deepEqual(await readdir(root), []);
	});
});

test("direct-execution guard: executing the script directly with --help prints the usage and exits 0 (help path only, never collection)", async () => {
	const result = spawnSync(process.execPath, ["--import", TSX_LOADER, SOURCE_PATH, "--help"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
	assert.equal(result.status, 0, `--help subprocess failed (${String(result.status)}): ${result.stderr}`);
	assert.ok((result.stdout ?? "").includes("usage:"), result.stdout);
	assert.ok((result.stdout ?? "").includes("commander-native-tool-v2-final-collect — NRO protocol-v2 FINAL validation collector"), result.stdout);
	assert.equal(result.stderr, "", result.stderr);
});
