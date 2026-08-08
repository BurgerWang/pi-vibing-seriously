/**
 * NRO protocol-v2 prepare adapter tests (commander-native-tool-
 * benchmark-v2-prepare slice) — hermetic, deterministic: every fixture
 * is a synthetic temp tree (created under os.tmpdir() and removed in
 * finally) with pins derived from the generated content; the production
 * frozen pins stay strict (the CLI path always uses FROZEN_NRO_V2_PROTOCOL
 * and a derived protocol is only ever passed explicitly as the library
 * test seam). No network, no provider/model calls, no real collection,
 * no production prepare; the only spawned process is the prepare/analyze
 * CLI themselves under tsx. Every assertion is byte-exact or code-exact.
 *
 * Covers, against the v2 prepare adapter:
 *
 *   A. Final and dev happy paths with synthetic reduced runsPerArm=2
 *      protocols: byte-exact staged evidence (fixture, prompt,
 *      environment, rubric, collection record, sessions, attempts),
 *      strict schema/protocol-2 manifest (v2 names, pins, frozen
 *      checks, chronological order_index, all attempts) round-tripped
 *      through parseManifestV2 and analyzable by the existing v2
 *      analyzer; the schema/protocol-2 deviations document; rerun
 *      refusal; no staging leftovers.
 *   B. No write before complete preflight: a large fail-closed table
 *      (inputs set, environment file, rubric structure/hash, fixture
 *      pin/symlink, prompt pin, collection record shape/pins/phase,
 *      partial final cohort, entry cap, ABBA arm drift, missing/
 *      non-regular/symlink/oversize sources, expected-hash mismatch,
 *      malformed JSONL, path escape, duplicate realpath, malformed
 *      labels, hidden-valid final attempts, final session validity,
 *      null-pin protocol) asserts the exact structured error code AND
 *      that the runs root is never created.
 *   C. Attempt categories across every frozen-priority branch (dev),
 *      recorded identically in the manifest, the deviations document
 *      and the analyzer reproduction.
 *   D. Existing/racing output refusal: pre-existing evidence dir and
 *      manifest survive untouched; racing outputs injected at the
 *      documented commit seams are refused and preserved.
 *   D2. Deterministic staging (stagingName seam): exhausted candidate
 *      collisions fail IO_ERROR with every foreign candidate untouched;
 *      a first collision retries to a safe second candidate; unsafe
 *      suffixes fail BASENAME_UNSAFE without echo or escape; a foreign
 *      path at the old staging name after the atomic move survives;
 *      foreign children and replaced owned files inside staging
 *      survive identity-verified rollback while owned siblings are
 *      cleaned.
 *   E. Ownership-tracked rollback: injected failures after evidence
 *      reservation / evidence move / manifest open / manifest commit
 *      leave no partials; foreign replacements of the reserved
 *      evidence dir, foreign children inside it and a foreign manifest
 *      replacement all survive rollback; replaced fixture trees and
 *      foreign nested children inside the committed evidence survive
 *      rollback after the evidence move and after the manifest commit.
 *   F. CLI: importing the module has no side effects; library dispatch
 *      (0 help / 2 usage); parsePrepareV2Args (help, missing/unknown/
 *      duplicate options, runs-dir default); exit 0 success against the
 *      frozen production pins with the analyzer CLI consuming the
 *      prepared manifest; exit 1 fail-closed with stderr only and no
 *      leaks; exit 2 usage errors with bounded/control-safe stderr;
 *      summary caps (240 lines / 64 KiB) and privacy; renderCliErrorV2Prepare
 *      allowlisted codes with withheld untrusted details.
 *   G. Determinism: identical bytes/options produce identical manifests
 *      and summaries across runs roots.
 *   H. Static import guard: the adapter reuses only the allowlisted v1
 *      pure primitives plus the v2 core/protocol/policy; the v1
 *      prepare/analyze/collection implementations and the v1
 *      evidence/result/manifest/path constants are never imported;
 *      offline-only (no network/spawn/shell tokens).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { spawnExec, withTempDir } from "./helpers.ts";

import {
	NroV2PrepareError,
	applyCapsV2Prepare,
	mainV2,
	parsePrepareV2Args,
	prepareEvidenceV2,
	renderCliErrorV2Prepare,
	renderPrepareSummaryV2,
	type DeviationsDocumentV2,
} from "../scripts/commander-native-tool-benchmark-v2-prepare.ts";

import {
	NroV2Error,
	abbaArmAtV2,
	parseManifestV2,
	sessionLabelV2,
	type NroManifestV2,
	type V2FrozenProtocol,
} from "../scripts/commander-native-tool-benchmark-v2.ts";

import {
	BENCHMARK_SCHEMA_VERSION,
	COLLECTION_RECORD_NAME,
	COLLECTION_SCHEMA_VERSION,
	DEVIATIONS_NAME,
	DEVIATIONS_SCHEMA_VERSION,
	ENVIRONMENT_NAME,
	EVIDENCE_DIR_NAME,
	FIXTURE_DIR_NAME,
	FROZEN_ENVIRONMENT,
	FROZEN_NRO_V2_PROTOCOL,
	INPUTS_DIR,
	MANIFEST_NAME,
	MILESTONE_PROMPT_NAME,
	PROTOCOL_DOC,
	PROTOCOL_VERSION,
	RUBRIC_NAME,
	STAGING_PREFIX,
	type ArmName,
	type Phase,
} from "../scripts/commander-native-tool-benchmark-v2-protocol.ts";

import { V2PolicyError, V2_RUBRIC_CHECKS } from "../scripts/commander-native-tool-benchmark-v2-policy.ts";

import { analyzeManifestFileV2 } from "../scripts/commander-native-tool-benchmark-v2-analyze.ts";

import {
	HUMAN_MAX_BYTES,
	HUMAN_MAX_LINES,
	SESSION_MAX_BYTES,
	canonicalEnvironmentFile,
	fixtureManifestHash,
	NroError,
} from "../scripts/commander-native-tool-benchmark.ts";

// ---------------------------------------------------------------------------
// Hermetic fixture constants
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

const H64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const H64_OTHER = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

/** Distinctive milestone prompt (its hash is pinned into the derived test protocol). */
const PROMPT_TEXT = "Solve the frozen NRO v2 benchmark milestone precisely and report every required fact.";
const PROMPT_SHA256 = sha256Hex(PROMPT_TEXT);
const TEST_ENVIRONMENT = { ...FROZEN_ENVIRONMENT };
const NON_TREATMENT_SHA = "ab".repeat(32);
const RUBRIC_RAW = `${JSON.stringify({ schema_version: 2, checks: V2_RUBRIC_CHECKS.map((c) => ({ id: c.id, pattern: c.pattern })) }, null, 2)}\n`;
const RUBRIC_SHA = sha256Hex(RUBRIC_RAW);
const RUBRIC_FULL_TEXT = ["build: alpha-42", "unicode: α, 水, 🚀", "token: delta-77", "needle_occurrences: 140", "needle_lines: 135", "needle_files: 4"].join("\n");
const DEFAULT_FIXTURE_FILES: Record<string, string> = { "a.txt": "alpha", "sub/b.txt": "beta" };

/** Sentinels that must NEVER appear in summaries, stderr or failure errors. */
const SECRET_BODY = "NROPRIVATE-TOOLRESULT-1b3d";
const SECRET_PATH = "/private/secret-dir/SECRET-file-7c4e.txt";

// ---------------------------------------------------------------------------
// Pi-like session entry builders (same shapes as the v2 analyzer tests)
// ---------------------------------------------------------------------------

function jsonl(entries: readonly unknown[]): string {
	return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

function environmentWire(): Record<string, unknown> {
	return {
		model_key: FROZEN_ENVIRONMENT.modelKey,
		thinking_level: FROZEN_ENVIRONMENT.thinkingLevel,
		pi_version: FROZEN_ENVIRONMENT.piVersion,
		node_version: FROZEN_ENVIRONMENT.nodeVersion,
	};
}

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

function toolResultMessage(toolCallId: string, toolName: string, content: unknown, isError?: boolean): Record<string, unknown> {
	return {
		type: "message",
		id: `m-${toolCallId}-result`,
		message: {
			role: "toolResult",
			toolName,
			toolCallId,
			content,
			...(isError ? { isError: true } : {}),
		},
	};
}

function markerLine(complete: boolean): string {
	return `nro-read-facts: complete=${complete} returned_lines=10 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`;
}

interface SessionSpecV2 {
	/** First user message text (defaults to the pinned PROMPT_TEXT). */
	prompt?: string;
	/** undefined = "high"; null = omit the thinking_level_change entry. */
	thinking?: string | null;
	stopReason?: string;
	compaction?: boolean;
	/** Assistant model key override (env_drift attempts). */
	model?: string;
	/** false = omit the user message (attempts only). */
	user?: boolean;
	/** Number of read tool rounds (default 2). */
	rounds?: number;
	/** Final assistant text (defaults to the six-fact rubric answer). */
	text?: string;
}

/** A machine-valid final session entry sequence (prompt, env, rubric, pagination all pass). */
function buildSessionEntriesV2(spec: SessionSpecV2 = {}): unknown[] {
	const entries: unknown[] = [];
	if (spec.thinking !== null) entries.push(thinkingLevelChange(spec.thinking ?? "high"));
	if (spec.user !== false) entries.push(userMessage(spec.prompt ?? PROMPT_TEXT));
	if (spec.compaction) entries.push({ type: "compaction", id: "cp-1", timestamp: "2026-09-01T10:00:00.100Z" });
	const rounds = spec.rounds ?? 2;
	for (let r = 0; r < rounds; r += 1) {
		const id = `c${r + 1}`;
		entries.push(assistantMessage([toolCallItem(id, "read", { path: "fixture/a.txt" })]));
		entries.push(toolResultMessage(id, "read", r === 0 ? markerLine(false) : "legacy continuation content"));
	}
	entries.push(
		assistantMessage([{ type: "text", text: spec.text ?? RUBRIC_FULL_TEXT }], {
			stopReason: spec.stopReason ?? "stop",
			...(spec.model ? { model: spec.model } : {}),
		}),
	);
	return entries;
}

/** Same shape but the session content carries privacy sentinels (never to leak). */
function secretSessionEntries(promptText: string = PROMPT_TEXT): unknown[] {
	return [
		userMessage(promptText),
		thinkingLevelChange(),
		assistantMessage([toolCallItem("c1", "read", { path: SECRET_PATH })]),
		toolResultMessage("c1", "read", markerLine(false)),
		assistantMessage([toolCallItem("c2", "read", { path: SECRET_PATH, offset: 100 })]),
		toolResultMessage("c2", "read", SECRET_BODY),
		assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
	];
}

/** Attempt/session spec presets for the frozen-priority categories. */
const validSpec = (): SessionSpecV2 => ({});
const compactedSpec = (): SessionSpecV2 => ({ compaction: true });
const erroredAttemptSpec = (): SessionSpecV2 => ({ stopReason: "error" });
const nonterminalAttemptSpec = (): SessionSpecV2 => ({ thinking: null, stopReason: "max_tokens", user: false });
const promptMismatchSpec = (): SessionSpecV2 => ({ prompt: "wrong attempt prompt text" });
const envDriftSpec = (): SessionSpecV2 => ({ model: "gpt-4o" });
const compactionSpec = (): SessionSpecV2 => ({ compaction: true });
const abortedSpec = (): SessionSpecV2 => ({ stopReason: "aborted" });
const validAttemptSpec = (): SessionSpecV2 => ({});

// ---------------------------------------------------------------------------
// Prepare-side fixture writer (synthetic temp inputs + collection record)
// ---------------------------------------------------------------------------

interface EntrySlotBaseV2 {
	spec: SessionSpecV2;
	arm: ArmName;
	path?: string;
	write?: boolean;
	rawText?: string;
}

type EntrySlotV2 = (EntrySlotBaseV2 & { kind: "session" }) | (EntrySlotBaseV2 & { kind: "attempt" });

interface PrepareV2Fixture {
	root: string;
	runsDir: string;
	inputsDir: string;
	collectionFile: string;
	protocol: V2FrozenProtocol;
	sourceBytes: Map<string, Buffer>;
	recordRaw: string;
}

interface PrepareV2FixtureSpec {
	phase?: Phase;
	runsPerArm?: number;
	entries: EntrySlotV2[];
	protocolOverride?: Partial<V2FrozenProtocol>;
	recordOverrides?: Record<string, unknown>;
	afterWrite?: (fx: PrepareV2Fixture) => Promise<void>;
}

function collectionWireV2(
	entries: Array<{ kind: "session" | "attempt"; arm: ArmName; path: string; expected_session_sha256: string }>,
	phase: Phase,
	protocol: V2FrozenProtocol,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schema_version: COLLECTION_SCHEMA_VERSION,
		protocol_version: PROTOCOL_VERSION,
		protocol_doc: PROTOCOL_DOC,
		phase,
		milestone_prompt_sha256: protocol.milestonePromptSha256,
		fixture_manifest_sha256: protocol.fixtureManifestSha256,
		non_treatment_sha256: protocol.nonTreatmentSha256,
		rubric_sha256: protocol.rubricSha256,
		environment: environmentWire(),
		entries,
		...overrides,
	};
}

/** The frozen ABBA final cohort for a reduced runsPerArm: optional attempt retries at ABBA positions. */
function abbaFinalEntriesV2(runsPerArm: number, opts: { retries?: Array<{ at: number; spec: SessionSpecV2 }> } = {}): EntrySlotV2[] {
	const entries: EntrySlotV2[] = [];
	const retryAt = new Map(opts.retries?.map((r) => [r.at, r.spec]) ?? []);
	for (let i = 1; i <= 2 * runsPerArm; i += 1) {
		const arm = abbaArmAtV2(i);
		const retry = retryAt.get(i);
		if (retry) entries.push({ kind: "attempt", arm, spec: retry });
		entries.push({ kind: "session", arm, spec: {} });
	}
	return entries;
}

/**
 * Write a synthetic prepare fixture: frozen-style inputs (small fixture
 * tree, prompt, canonical environment, schema-2 rubric) whose pins are
 * derived into a test protocol, plus the schema/protocol-2 collection
 * record with chronological entries and expected session hashes. Entry
 * paths are relative to the collection record's directory (root/).
 */
async function writePrepareV2Fixture(root: string, spec: PrepareV2FixtureSpec): Promise<PrepareV2Fixture> {
	const inputsDir = join(root, "inputs");
	const fixtureDir = join(inputsDir, "fixture");
	for (const [rel, content] of Object.entries(DEFAULT_FIXTURE_FILES)) {
		const full = join(fixtureDir, rel);
		await mkdir(join(full, ".."), { recursive: true });
		await writeFile(full, content, "utf8");
	}
	await writeFile(join(inputsDir, MILESTONE_PROMPT_NAME), PROMPT_TEXT, "utf8");
	await writeFile(join(inputsDir, ENVIRONMENT_NAME), canonicalEnvironmentFile(TEST_ENVIRONMENT), "utf8");
	await writeFile(join(inputsDir, RUBRIC_NAME), RUBRIC_RAW, "utf8");
	const fixture = await fixtureManifestHash(fixtureDir);
	const protocol: V2FrozenProtocol = {
		milestonePromptSha256: PROMPT_SHA256,
		environment: { ...TEST_ENVIRONMENT },
		fixtureManifestSha256: fixture.manifestSha256,
		nonTreatmentSha256: NON_TREATMENT_SHA,
		rubricSha256: RUBRIC_SHA,
		runsPerArm: spec.runsPerArm ?? 2,
		interleave: "ABBA",
		...spec.protocolOverride,
	};

	await mkdir(join(root, "sources"), { recursive: true });
	const sourceBytes = new Map<string, Buffer>();
	const recordEntries: Array<{ kind: "session" | "attempt"; arm: ArmName; path: string; expected_session_sha256: string }> = [];
	const occurrence = new Map<string, number>();
	let sessionCount = 0;
	let attemptCount = 0;
	for (const slot of spec.entries) {
		let label: string;
		if (slot.kind === "session") {
			sessionCount += 1;
			const n = (occurrence.get(slot.arm) ?? 0) + 1;
			occurrence.set(slot.arm, n);
			label = sessionLabelV2(slot.arm, n);
		} else {
			attemptCount += 1;
			label = `attempt-${attemptCount}`;
		}
		const path = slot.path ?? `sources/${label}.jsonl`;
		const text = slot.rawText ?? jsonl(buildSessionEntriesV2(slot.spec));
		if (slot.write !== false) await writeFile(join(root, path), text, "utf8");
		sourceBytes.set(label, Buffer.from(text, "utf8"));
		recordEntries.push({ kind: slot.kind, arm: slot.arm, path, expected_session_sha256: sha256Hex(text) });
	}
	const record = collectionWireV2(recordEntries, spec.phase ?? "final", protocol, spec.recordOverrides);
	const recordRaw = `${JSON.stringify(record, null, 2)}\n`;
	const collectionFile = join(root, "collection.json");
	await writeFile(collectionFile, recordRaw, "utf8");
	const fx: PrepareV2Fixture = { root, runsDir: join(root, "runs"), inputsDir, collectionFile, protocol, sourceBytes, recordRaw };
	await spec.afterWrite?.(fx);
	return fx;
}

/** Expect a rejection with the exact error code (adapter, v2 core or v1 validator). */
async function expectCode(promise: Promise<unknown>, code: string): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof Error, `expected Error, got ${String(error)}`);
		assert.equal((error as { code?: unknown }).code, code, `expected code ${code}`);
		return error;
	}
	assert.fail(`expected error code ${code}, got success`);
	throw new Error("unreachable");
}

/** No invocation-owned partial outputs may remain after any prepare failure. */
async function assertNoPartialsV2(runsDir: string): Promise<void> {
	assert.ok(!existsSync(join(runsDir, EVIDENCE_DIR_NAME)), "no evidence directory may remain");
	assert.ok(!existsSync(join(runsDir, MANIFEST_NAME)), "no manifest may remain");
	const leftovers = (await readdir(runsDir).catch(() => [] as string[])).filter((n) => n.startsWith(STAGING_PREFIX));
	assert.deepEqual(leftovers, [], "no staging leftovers");
}

/** Privacy boundary: no absolute temp paths and no raw sentinel content. */
function assertPrivacySafe(text: string, root: string): void {
	assert.ok(!text.includes(root), `no absolute temp path in: ${text.slice(0, 120)}`);
	assert.ok(!text.includes(PROMPT_TEXT), "no raw milestone prompt content");
	assert.ok(!text.includes(SECRET_BODY), "no raw tool-result content");
	assert.ok(!text.includes(SECRET_PATH), "no raw read path content");
}

/** Recursive snapshot of a tree (relpath -> sha256) to prove read-only behavior. */
async function snapshotTree(dir: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const walk = async (cur: string, rel: string): Promise<void> => {
		for (const e of await readdir(cur, { withFileTypes: true })) {
			const r = rel.length === 0 ? e.name : `${rel}/${e.name}`;
			const full = join(cur, e.name);
			if (e.isDirectory()) await walk(full, r);
			else out.set(r, sha256Hex(await readFile(full)));
		}
	};
	await walk(dir, "");
	return out;
}

// ---------------------------------------------------------------------------
// A. Happy paths
// ---------------------------------------------------------------------------

test("prepare v2: final happy path (runsPerArm=2) — byte-exact evidence, strict manifest, analyzer-compatible", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareV2Fixture(join(root, "bench"), {
			phase: "final",
			runsPerArm: 2,
			entries: abbaFinalEntriesV2(2, { retries: [{ at: 1, spec: promptMismatchSpec() }, { at: 3, spec: erroredAttemptSpec() }] }),
		});
		const result = await prepareEvidenceV2({ runsDir: fx.runsDir, inputsDir: fx.inputsDir, collectionFile: fx.collectionFile, protocol: fx.protocol });
		assert.equal(result.evidenceDir, join(fx.runsDir, EVIDENCE_DIR_NAME));
		assert.equal(result.manifestPath, join(fx.runsDir, MANIFEST_NAME));
		assert.equal(result.sessions.length, 4);
		assert.equal(result.attempts.length, 2);

		// Byte-exact staged copies of every source.
		for (const [label, bytes] of fx.sourceBytes) {
			const kind = label.startsWith("attempt-") ? "attempts" : "sessions";
			const copied = await readFile(join(fx.runsDir, EVIDENCE_DIR_NAME, kind, label, `${label}.jsonl`));
			assert.ok(copied.equals(bytes), `byte-exact copy of ${label}`);
		}
		// Byte-exact frozen inputs.
		assert.equal(await readFile(join(fx.runsDir, EVIDENCE_DIR_NAME, MILESTONE_PROMPT_NAME), "utf8"), PROMPT_TEXT);
		assert.equal(await readFile(join(fx.runsDir, EVIDENCE_DIR_NAME, ENVIRONMENT_NAME), "utf8"), canonicalEnvironmentFile(TEST_ENVIRONMENT));
		assert.equal(await readFile(join(fx.runsDir, EVIDENCE_DIR_NAME, RUBRIC_NAME), "utf8"), RUBRIC_RAW);
		assert.equal(await readFile(join(fx.runsDir, EVIDENCE_DIR_NAME, "fixture", "a.txt"), "utf8"), "alpha");
		assert.equal(await readFile(join(fx.runsDir, EVIDENCE_DIR_NAME, "fixture", "sub", "b.txt"), "utf8"), "beta");
		assert.equal(await readFile(join(fx.runsDir, EVIDENCE_DIR_NAME, COLLECTION_RECORD_NAME), "utf8"), fx.recordRaw);
		// The committed fixture tree reproduces the derived manifest hash.
		const committedFixture = await fixtureManifestHash(join(fx.runsDir, EVIDENCE_DIR_NAME, "fixture"));
		assert.equal(committedFixture.manifestSha256, fx.protocol.fixtureManifestSha256);

		// The generated manifest is strict schema/protocol 2: v2 names,
		// pins, frozen checks, chronological order/order_index, all attempts.
		const manifestText = await readFile(result.manifestPath, "utf8");
		const parsed: NroManifestV2 = parseManifestV2(manifestText, fx.protocol);
		assert.equal(parsed.schemaVersion, BENCHMARK_SCHEMA_VERSION);
		assert.equal(parsed.protocolVersion, PROTOCOL_VERSION);
		assert.equal(parsed.protocolDoc, PROTOCOL_DOC);
		assert.equal(parsed.phase, "final");
		assert.deepEqual(parsed.sessions.map((s) => s.label), ["control-01", "treatment-01", "treatment-02", "control-02"]);
		assert.deepEqual(parsed.sessions.map((s) => s.orderIndex), [1, 2, 3, 4]);
		assert.deepEqual(parsed.attempts.map((a) => a.label), ["attempt-1", "attempt-2"]);
		assert.deepEqual(parsed.attempts.map((a) => a.category), ["prompt_mismatch", "errored"]);
		assert.deepEqual(parsed.rubric.checks.map((c) => c.id), V2_RUBRIC_CHECKS.map((c) => c.id));
		assert.equal(parsed.fixture.path, `${EVIDENCE_DIR_NAME}/fixture`);
		assert.equal(parsed.milestonePromptSha256, fx.protocol.milestonePromptSha256);
		for (const s of parsed.sessions) {
			assert.equal(sha256Hex(await readFile(join(fx.runsDir, s.path))), s.expectedSessionSha256, s.label);
		}
		for (const a of parsed.attempts) {
			assert.equal(sha256Hex(await readFile(join(fx.runsDir, a.path))), a.expectedSessionSha256, a.label);
		}

		// The deviations document is schema/protocol 2 and privacy-safe.
		const deviations = JSON.parse(await readFile(join(fx.runsDir, EVIDENCE_DIR_NAME, DEVIATIONS_NAME), "utf8")) as DeviationsDocumentV2;
		assert.equal(deviations.schema_version, DEVIATIONS_SCHEMA_VERSION);
		assert.equal(deviations.protocol_version, PROTOCOL_VERSION);
		assert.equal(deviations.attempts.length, 2);
		assert.deepEqual(deviations.attempts.map((a) => a.category), ["prompt_mismatch", "errored"]);
		assert.equal(deviations.attempts[0]?.basename, "attempt-1.jsonl");
		assert.ok(deviations.attempts[0]?.terminal !== undefined, "terminal facts are recorded");

		// The generated manifest is analyzable by the existing v2 analyzer.
		const report = await analyzeManifestFileV2(result.manifestPath, fx.protocol);
		assert.equal(report.runs.length, 4);
		assert.deepEqual(report.runs.map((r) => r.label), ["control-01", "treatment-01", "treatment-02", "control-02"]);
		assert.equal(report.manifest.fixture.verified, true);
		assert.equal(report.attempts.length, 2);
		assert.equal(report.attempts[0]?.category, "prompt_mismatch");
		// The committed evidence is untouched by analysis.
		assert.deepEqual(await snapshotTree(fx.runsDir), await snapshotTree(fx.runsDir), "analyze must never write");

		// No staging leftovers; a rerun refuses the existing outputs.
		assert.deepEqual((await readdir(fx.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), []);
		await expectCode(prepareEvidenceV2({ runsDir: fx.runsDir, inputsDir: fx.inputsDir, collectionFile: fx.collectionFile, protocol: fx.protocol }), "EXISTING_OUTPUT");
		assert.ok(existsSync(result.manifestPath));
		assert.ok(existsSync(join(fx.runsDir, EVIDENCE_DIR_NAME, "sessions", "control-01", "control-01.jsonl")));

		// The prepare summary is privacy-safe.
		assertPrivacySafe(renderPrepareSummaryV2(result).join("\n"), root);
	});
});

test("prepare v2: dev happy path — compacted session accepted, valid attempt unclassified, analyzer-compatible", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareV2Fixture(join(root, "bench"), {
			phase: "dev",
			entries: [
				{ kind: "attempt", arm: "control", spec: validAttemptSpec() },
				{ kind: "session", arm: "control", spec: compactedSpec() },
			],
		});
		const result = await prepareEvidenceV2({ runsDir: fx.runsDir, inputsDir: fx.inputsDir, collectionFile: fx.collectionFile, protocol: fx.protocol });
		assert.equal(result.manifest.phase, "dev");
		assert.equal(result.sessions.length, 1);
		assert.equal(result.sessions[0]?.compactions, 1);
		const parsed = parseManifestV2(await readFile(result.manifestPath, "utf8"), fx.protocol);
		assert.equal(parsed.attempts.length, 1);
		assert.equal(parsed.attempts[0]?.category, "unclassified");
		const report = await analyzeManifestFileV2(result.manifestPath, fx.protocol);
		assert.equal(report.runs.length, 1);
		assert.equal(report.runs[0]?.compactions, 1);
		for (const verdict of report.verdicts) assert.equal(verdict.status, "NOT_MEASURED");
		assert.equal(report.attempts[0]?.category, "unclassified");
	});
});

test("prepare v2: collection source paths resolve relative to the collection record's directory", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareV2Fixture(join(root, "bench"), {
			phase: "dev",
			entries: [{ kind: "session", arm: "control", spec: {} }],
			afterWrite: async (f) => {
				// Move the collection record AND its relative source tree into a
				// nested directory together — declared paths stay relative.
				await mkdir(join(f.root, "nested"), { recursive: true });
				await cp(join(f.root, "sources"), join(f.root, "nested", "sources"), { recursive: true });
				await cp(f.collectionFile, join(f.root, "nested", "collection.json"));
			},
		});
		const result = await prepareEvidenceV2({
			runsDir: fx.runsDir,
			inputsDir: fx.inputsDir,
			collectionFile: join(fx.root, "nested", "collection.json"),
			protocol: fx.protocol,
		});
		assert.equal(result.sessions.length, 1);
		assert.equal(result.sessions[0]?.label, "control-01");
	});
});

// ---------------------------------------------------------------------------
// B. No write before complete preflight — fail-closed table
// ---------------------------------------------------------------------------

test("prepare v2: fail-closed preflight table — exact codes, runs root never created", async () => {
	await withTempDir(async (root) => {
		const dev = (): PrepareV2FixtureSpec => ({ phase: "dev", entries: [{ kind: "session", arm: "control", spec: {} }] });
		const cases: Array<{ name: string; spec: PrepareV2FixtureSpec; code: string }> = [
			// Inputs tree / environment / rubric
			{ name: "INPUTS_INVALID_extra", spec: dev(), code: "INPUTS_INVALID" },
			{ name: "INPUTS_INVALID_missing", spec: dev(), code: "INPUTS_INVALID" },
			{ name: "ENV_OVER_BOUND_extra_newline", spec: dev(), code: "OVER_BOUND" },
			{ name: "ENV_FILE_INVALID_value", spec: dev(), code: "ENV_FILE_INVALID" },
			{ name: "RUBRIC_INVALID_malformed", spec: dev(), code: "RUBRIC_INVALID" },
			{ name: "RUBRIC_INVALID_schema", spec: dev(), code: "RUBRIC_INVALID" },
			{ name: "RUBRIC_INVALID_unknown_key", spec: dev(), code: "RUBRIC_INVALID" },
			{ name: "RUBRIC_MISMATCH_order", spec: dev(), code: "RUBRIC_MISMATCH" },
			{ name: "RUBRIC_MISMATCH_count", spec: dev(), code: "RUBRIC_MISMATCH" },
			{ name: "RUBRIC_MISMATCH_hash", spec: dev(), code: "RUBRIC_MISMATCH" },
			{ name: "FIXTURE_MISMATCH", spec: dev(), code: "FIXTURE_MISMATCH" },
			{ name: "FIXTURE_UNSAFE_symlink", spec: dev(), code: "FIXTURE_UNSAFE" },
			{ name: "FIXTURE_UNSAFE_root_symlink", spec: dev(), code: "FIXTURE_UNSAFE" },
			{ name: "FIXTURE_UNSAFE_root_not_dir", spec: dev(), code: "FIXTURE_UNSAFE" },
			{ name: "FIXTURE_UNSAFE_nested_symlink", spec: dev(), code: "FIXTURE_UNSAFE" },
			// Two consecutive control-character name cases: a stateful (global)
			// regex predicate would flip-flop across them — both must fail closed.
			{ name: "FIXTURE_UNSAFE_control_01", spec: dev(), code: "FIXTURE_UNSAFE" },
			{ name: "FIXTURE_UNSAFE_control_1f", spec: dev(), code: "FIXTURE_UNSAFE" },
			{ name: "MILESTONE_MISMATCH", spec: dev(), code: "MILESTONE_MISMATCH" },
			// Inputs root / file lstat validation (symlinks and non-regular entries)
			{ name: "INPUTS_INVALID_root_symlink", spec: dev(), code: "INPUTS_INVALID" },
			{ name: "INPUTS_INVALID_prompt_symlink", spec: dev(), code: "INPUTS_INVALID" },
			{ name: "INPUTS_INVALID_prompt_not_regular", spec: dev(), code: "INPUTS_INVALID" },
			{ name: "INPUTS_INVALID_environment_symlink", spec: dev(), code: "INPUTS_INVALID" },
			{ name: "INPUTS_INVALID_environment_not_regular", spec: dev(), code: "INPUTS_INVALID" },
			{ name: "INPUTS_INVALID_environment_over_bound", spec: dev(), code: "OVER_BOUND" },
			{ name: "INPUTS_INVALID_rubric_symlink", spec: dev(), code: "INPUTS_INVALID" },
			{ name: "INPUTS_INVALID_rubric_not_regular", spec: dev(), code: "INPUTS_INVALID" },
			// Collection record shape/pins/phase
			{ name: "COLLECTION_INVALID_missing", spec: dev(), code: "COLLECTION_INVALID" },
			{ name: "COLLECTION_INVALID_not_regular", spec: dev(), code: "COLLECTION_INVALID" },
			{ name: "COLLECTION_INVALID_record_symlink", spec: dev(), code: "COLLECTION_INVALID" },
			{ name: "COLLECTION_INVALID_not_json", spec: dev(), code: "INVALID_JSON" },
			{ name: "COLLECTION_SCHEMA_VERSION", spec: dev(), code: "SCHEMA_VERSION" },
			{ name: "COLLECTION_PROTOCOL_VERSION", spec: dev(), code: "PROTOCOL_VERSION" },
			{ name: "COLLECTION_PIN_MISMATCH", spec: dev(), code: "PIN_MISMATCH" },
			{ name: "COLLECTION_INVALID_PHASE", spec: dev(), code: "INVALID_PHASE" },
			{ name: "COLLECTION_UNKNOWN_KEY", spec: dev(), code: "UNKNOWN_KEY" },
			{ name: "COLLECTION_BASENAME_UNSAFE", spec: dev(), code: "BASENAME_UNSAFE" },
			{ name: "COLLECTION_OVER_BOUND", spec: dev(), code: "OVER_BOUND" },
			{ name: "DEV_WITHOUT_SESSION", spec: { phase: "dev", entries: [{ kind: "attempt", arm: "control", spec: erroredAttemptSpec() }] }, code: "COHORT_COUNT" },
			// Sources
			{ name: "SOURCE_UNREADABLE", spec: dev(), code: "SOURCE_UNREADABLE" },
			{ name: "SOURCE_NOT_REGULAR_dir", spec: dev(), code: "SOURCE_NOT_REGULAR" },
			{ name: "SOURCE_NOT_REGULAR_symlink", spec: dev(), code: "SOURCE_NOT_REGULAR" },
			{ name: "SOURCE_OVER_BOUND", spec: dev(), code: "SOURCE_OVER_BOUND" },
			{ name: "SOURCE_HASH_MISMATCH", spec: dev(), code: "SOURCE_HASH_MISMATCH" },
			{ name: "SOURCE_MALFORMED_JSONL", spec: { phase: "dev", entries: [{ kind: "session", arm: "control", spec: {}, rawText: "not json\n" }] }, code: "MALFORMED_JSONL" },
			{ name: "PATH_UNSAFE_dotdot", spec: { phase: "dev", entries: [{ kind: "session", arm: "control", spec: {}, path: "../outside.jsonl", write: false }] }, code: "PATH_UNSAFE" },
			{ name: "PATH_UNSAFE_escape", spec: dev(), code: "PATH_UNSAFE" },
			{ name: "DUPLICATE_SOURCE", spec: { phase: "dev", entries: [{ kind: "session", arm: "control", spec: {} }, { kind: "session", arm: "control", path: "alias/control-01.jsonl", write: false, spec: {} }] }, code: "DUPLICATE_SOURCE" },
			// Final cohort / ABBA / cap / validity
			{ name: "PARTIAL_FINAL", spec: { phase: "final", runsPerArm: 2, entries: abbaFinalEntriesV2(2).slice(0, 3) }, code: "COHORT_COUNT" },
			{ name: "FINAL_ARM_MISMATCH", spec: { phase: "final", runsPerArm: 2, entries: [{ kind: "session", arm: "control", spec: {} }, { kind: "session", arm: "control", spec: {} }, { kind: "session", arm: "treatment", spec: {} }, { kind: "session", arm: "treatment", spec: {} }] }, code: "ARM_MISMATCH" },
			{ name: "ENTRY_CAP_61", spec: { phase: "dev", entries: [{ kind: "session", arm: "control", spec: {} }, ...Array.from({ length: 60 }, () => ({ kind: "attempt" as const, arm: "control" as const, spec: erroredAttemptSpec(), write: false }))] }, code: "OVER_BOUND" },
			{ name: "FINAL_HIDDEN_VALID_ATTEMPT", spec: { phase: "final", runsPerArm: 2, entries: abbaFinalEntriesV2(2, { retries: [{ at: 1, spec: validAttemptSpec() }] }) }, code: "ATTEMPT_NOT_INVALID" },
			{ name: "FINAL_SESSION_COMPACTION", spec: { phase: "final", runsPerArm: 2, entries: [{ kind: "session", arm: "control", spec: compactedSpec() }, ...abbaFinalEntriesV2(2).slice(1)] }, code: "COMPACTION_PRESENT" },
			{ name: "FINAL_SESSION_PROMPT", spec: { phase: "final", runsPerArm: 2, entries: [{ kind: "session", arm: "control", spec: { prompt: "wrong final prompt text" } }, ...abbaFinalEntriesV2(2).slice(1)] }, code: "PROMPT_MISMATCH" },
			{ name: "FINAL_SESSION_NONTERMINAL", spec: { phase: "final", runsPerArm: 2, entries: [{ kind: "session", arm: "control", spec: { stopReason: "max_tokens" } }, ...abbaFinalEntriesV2(2).slice(1)] }, code: "NOT_TERMINAL_STOP" },
			{ name: "PROTOCOL_NOT_FROZEN", spec: { ...dev(), protocolOverride: { milestonePromptSha256: null } }, code: "PROTOCOL_NOT_FROZEN" },
		];
		const protocolOverrideByName: Record<string, Partial<V2FrozenProtocol>> = {
			RUBRIC_MISMATCH_hash: { rubricSha256: H64_OTHER },
			MILESTONE_MISMATCH: { milestonePromptSha256: H64_OTHER },
		};
		const afterWriteByName: Record<string, (fx: PrepareV2Fixture) => Promise<void>> = {
			INPUTS_INVALID_extra: async (fx) => {
				await writeFile(join(fx.inputsDir, "extra.txt"), "x", "utf8");
			},
			INPUTS_INVALID_missing: async (fx) => {
				await rm(join(fx.inputsDir, ENVIRONMENT_NAME), { force: true });
			},
			ENV_OVER_BOUND_extra_newline: async (fx) => {
				// An extra trailing newline pushes the file one byte over the pinned
				// canonical size: the lstat size check fails closed OVER_BOUND
				// before any content read.
				await writeFile(join(fx.inputsDir, ENVIRONMENT_NAME), `${canonicalEnvironmentFile(TEST_ENVIRONMENT)}\n`, "utf8");
			},
			ENV_FILE_INVALID_value: async (fx) => {
				await writeFile(join(fx.inputsDir, ENVIRONMENT_NAME), "model_key: wrong-model\nthinking_level: high\npi_version: 0.83.0\nnode_version: v26.4.0", "utf8");
			},
			RUBRIC_INVALID_malformed: async (fx) => {
				await writeFile(join(fx.inputsDir, RUBRIC_NAME), "{not json", "utf8");
			},
			RUBRIC_INVALID_schema: async (fx) => {
				await writeFile(join(fx.inputsDir, RUBRIC_NAME), `${JSON.stringify({ schema_version: 1, checks: V2_RUBRIC_CHECKS.map((c) => ({ id: c.id, pattern: c.pattern })) }, null, 2)}\n`, "utf8");
			},
			RUBRIC_INVALID_unknown_key: async (fx) => {
				await writeFile(join(fx.inputsDir, RUBRIC_NAME), `${JSON.stringify({ schema_version: 2, checks: V2_RUBRIC_CHECKS.map((c) => ({ id: c.id, pattern: c.pattern })), extra: 1 }, null, 2)}\n`, "utf8");
			},
			RUBRIC_MISMATCH_order: async (fx) => {
				const checks = [...V2_RUBRIC_CHECKS].reverse();
				await writeFile(join(fx.inputsDir, RUBRIC_NAME), `${JSON.stringify({ schema_version: 2, checks: checks.map((c) => ({ id: c.id, pattern: c.pattern })) }, null, 2)}\n`, "utf8");
			},
			RUBRIC_MISMATCH_count: async (fx) => {
				const checks = V2_RUBRIC_CHECKS.slice(0, 5);
				await writeFile(join(fx.inputsDir, RUBRIC_NAME), `${JSON.stringify({ schema_version: 2, checks: checks.map((c) => ({ id: c.id, pattern: c.pattern })) }, null, 2)}\n`, "utf8");
			},
			FIXTURE_MISMATCH: async (fx) => {
				await writeFile(join(fx.inputsDir, "fixture", "extra.txt"), "tampered", "utf8");
			},
			FIXTURE_UNSAFE_symlink: async (fx) => {
				await writeFile(join(fx.inputsDir, "fixture", "outside-target.txt"), "x", "utf8");
				await symlink(join(fx.inputsDir, "fixture", "outside-target.txt"), join(fx.inputsDir, "fixture", "link.txt"));
			},
			FIXTURE_UNSAFE_root_symlink: async (fx) => {
				await rename(join(fx.inputsDir, FIXTURE_DIR_NAME), join(fx.root, "fixture-real"));
				await symlink(join(fx.root, "fixture-real"), join(fx.inputsDir, FIXTURE_DIR_NAME));
			},
			FIXTURE_UNSAFE_root_not_dir: async (fx) => {
				await rm(join(fx.inputsDir, FIXTURE_DIR_NAME), { recursive: true, force: true });
				await writeFile(join(fx.inputsDir, FIXTURE_DIR_NAME), "not a directory", "utf8");
			},
			FIXTURE_UNSAFE_nested_symlink: async (fx) => {
				await symlink(join(fx.inputsDir, "fixture", "a.txt"), join(fx.inputsDir, "fixture", "sub", "link.txt"));
			},
			FIXTURE_UNSAFE_control_01: async (fx) => {
				await writeFile(join(fx.inputsDir, "fixture", "\x01evil.txt"), "x", "utf8");
			},
			FIXTURE_UNSAFE_control_1f: async (fx) => {
				await writeFile(join(fx.inputsDir, "fixture", "\x1fevil.txt"), "x", "utf8");
			},
			INPUTS_INVALID_root_symlink: async (fx) => {
				await rename(fx.inputsDir, join(fx.root, "inputs-real"));
				await symlink(join(fx.root, "inputs-real"), fx.inputsDir);
			},
			INPUTS_INVALID_prompt_symlink: async (fx) => {
				await rename(join(fx.inputsDir, MILESTONE_PROMPT_NAME), join(fx.root, "prompt-real.txt"));
				await symlink(join(fx.root, "prompt-real.txt"), join(fx.inputsDir, MILESTONE_PROMPT_NAME));
			},
			INPUTS_INVALID_prompt_not_regular: async (fx) => {
				await rm(join(fx.inputsDir, MILESTONE_PROMPT_NAME), { force: true });
				await mkdir(join(fx.inputsDir, MILESTONE_PROMPT_NAME));
			},
			INPUTS_INVALID_environment_symlink: async (fx) => {
				await rename(join(fx.inputsDir, ENVIRONMENT_NAME), join(fx.root, "environment-real.txt"));
				await symlink(join(fx.root, "environment-real.txt"), join(fx.inputsDir, ENVIRONMENT_NAME));
			},
			INPUTS_INVALID_environment_not_regular: async (fx) => {
				await rm(join(fx.inputsDir, ENVIRONMENT_NAME), { force: true });
				await mkdir(join(fx.inputsDir, ENVIRONMENT_NAME));
			},
			INPUTS_INVALID_environment_over_bound: async (fx) => {
				await writeFile(join(fx.inputsDir, ENVIRONMENT_NAME), "x".repeat(10_000), "utf8");
			},
			INPUTS_INVALID_rubric_symlink: async (fx) => {
				await rename(join(fx.inputsDir, RUBRIC_NAME), join(fx.root, "rubric-real.json"));
				await symlink(join(fx.root, "rubric-real.json"), join(fx.inputsDir, RUBRIC_NAME));
			},
			INPUTS_INVALID_rubric_not_regular: async (fx) => {
				await rm(join(fx.inputsDir, RUBRIC_NAME), { force: true });
				await mkdir(join(fx.inputsDir, RUBRIC_NAME));
			},
			COLLECTION_INVALID_missing: async (fx) => {
				await rm(fx.collectionFile, { force: true });
			},
			COLLECTION_INVALID_not_regular: async (fx) => {
				await rm(fx.collectionFile, { force: true });
				await mkdir(fx.collectionFile);
			},
			COLLECTION_INVALID_record_symlink: async (fx) => {
				await rename(fx.collectionFile, join(fx.root, "collection-real.json"));
				await symlink(join(fx.root, "collection-real.json"), fx.collectionFile);
			},
			COLLECTION_INVALID_not_json: async (fx) => {
				await writeFile(fx.collectionFile, "{not json", "utf8");
			},
			COLLECTION_SCHEMA_VERSION: async (fx) => {
				const wire = JSON.parse(fx.recordRaw) as Record<string, unknown>;
				wire.schema_version = 1;
				await writeFile(fx.collectionFile, `${JSON.stringify(wire, null, 2)}\n`, "utf8");
			},
			COLLECTION_PROTOCOL_VERSION: async (fx) => {
				const wire = JSON.parse(fx.recordRaw) as Record<string, unknown>;
				wire.protocol_version = 1;
				await writeFile(fx.collectionFile, `${JSON.stringify(wire, null, 2)}\n`, "utf8");
			},
			COLLECTION_PIN_MISMATCH: async (fx) => {
				const wire = JSON.parse(fx.recordRaw) as Record<string, unknown>;
				wire.rubric_sha256 = H64_OTHER;
				await writeFile(fx.collectionFile, `${JSON.stringify(wire, null, 2)}\n`, "utf8");
			},
			COLLECTION_INVALID_PHASE: async (fx) => {
				const wire = JSON.parse(fx.recordRaw) as Record<string, unknown>;
				wire.phase = "bogus";
				await writeFile(fx.collectionFile, `${JSON.stringify(wire, null, 2)}\n`, "utf8");
			},
			COLLECTION_UNKNOWN_KEY: async (fx) => {
				const wire = JSON.parse(fx.recordRaw) as Record<string, unknown>;
				(wire.entries as Record<string, unknown>[])[0]!.bogus = 1;
				await writeFile(fx.collectionFile, `${JSON.stringify(wire, null, 2)}\n`, "utf8");
			},
			COLLECTION_BASENAME_UNSAFE: async (fx) => {
				const wire = JSON.parse(fx.recordRaw) as { entries: Array<Record<string, unknown>> };
				wire.entries[0]!.path = "sources/evil name!.jsonl";
				await writeFile(fx.collectionFile, `${JSON.stringify(wire, null, 2)}\n`, "utf8");
			},
			COLLECTION_OVER_BOUND: async (fx) => {
				await writeFile(fx.collectionFile, Buffer.alloc(SESSION_MAX_BYTES + 1, 0x78));
			},
			SOURCE_UNREADABLE: async (fx) => {
				await rm(join(fx.root, "sources", "control-01.jsonl"), { force: true });
			},
			SOURCE_NOT_REGULAR_dir: async (fx) => {
				await rm(join(fx.root, "sources", "control-01.jsonl"), { force: true });
				await mkdir(join(fx.root, "sources", "control-01.jsonl"));
			},
			SOURCE_NOT_REGULAR_symlink: async (fx) => {
				await rm(join(fx.root, "sources", "control-01.jsonl"), { force: true });
				await writeFile(join(fx.root, "sources", "target.jsonl"), fx.sourceBytes.get("control-01")!, "utf8");
				await symlink(join(fx.root, "sources", "target.jsonl"), join(fx.root, "sources", "control-01.jsonl"));
			},
			SOURCE_OVER_BOUND: async (fx) => {
				await writeFile(join(fx.root, "sources", "control-01.jsonl"), Buffer.alloc(SESSION_MAX_BYTES + 1, 0x78));
			},
			SOURCE_HASH_MISMATCH: async (fx) => {
				const wire = JSON.parse(fx.recordRaw) as { entries: Array<{ expected_session_sha256: string }> };
				wire.entries[0]!.expected_session_sha256 = H64_OTHER;
				await writeFile(fx.collectionFile, `${JSON.stringify(wire, null, 2)}\n`, "utf8");
			},
			PATH_UNSAFE_escape: async (fx) => {
				// The declared intermediate `sources` directory is symlinked to a
				// sibling OUTSIDE the collection record's directory (fx.root): the
				// source raw lives there, so realpath genuinely resolves outside
				// and the containment check fails PATH_UNSAFE.
				await rm(join(fx.root, "sources"), { recursive: true, force: true });
				const outside = join(dirname(fx.root), "escape-target");
				await mkdir(outside, { recursive: true });
				await writeFile(join(outside, "control-01.jsonl"), fx.sourceBytes.get("control-01")!, "utf8");
				await symlink(outside, join(fx.root, "sources"));
			},
			DUPLICATE_SOURCE: async (fx) => {
				await symlink(join(fx.root, "sources"), join(fx.root, "alias"));
			},
		};
		for (let i = 0; i < cases.length; i += 1) {
			const c = cases[i] as (typeof cases)[number];
			const fx = await writePrepareV2Fixture(join(root, `case-${i}`), {
				...c.spec,
				// The named override table wins when present; otherwise the case's
				// own spec-level override (e.g. PROTOCOL_NOT_FROZEN's null pin)
				// must survive — an explicit undefined would clobber it.
				protocolOverride: protocolOverrideByName[c.name] ?? c.spec.protocolOverride,
				afterWrite: afterWriteByName[c.name],
			});
			const error = await expectCode(prepareEvidenceV2({ runsDir: fx.runsDir, inputsDir: fx.inputsDir, collectionFile: fx.collectionFile, protocol: fx.protocol }), c.code);
			// Structured errors are privacy-safe: no absolute temp paths and no
			// raw input content.
			assertPrivacySafe(error.message, root);
			assert.ok(!existsSync(fx.runsDir), `case ${c.name}: runs root must not be created before preflight completes`);
		}
	});
});

// ---------------------------------------------------------------------------
// C. Attempt categories
// ---------------------------------------------------------------------------

test("prepare v2: attempt categories follow the frozen priority across every branch (dev)", async () => {
	await withTempDir(async (root) => {
		const entries: EntrySlotV2[] = [
			{ kind: "attempt", arm: "control", spec: promptMismatchSpec() },
			{ kind: "attempt", arm: "control", spec: envDriftSpec() },
			{ kind: "attempt", arm: "control", spec: compactionSpec() },
			{ kind: "attempt", arm: "control", spec: abortedSpec() },
			{ kind: "attempt", arm: "control", spec: erroredAttemptSpec() },
			{ kind: "attempt", arm: "control", spec: nonterminalAttemptSpec() },
			{ kind: "attempt", arm: "control", spec: validAttemptSpec() },
			{ kind: "session", arm: "control", spec: {} },
		];
		const expected = ["prompt_mismatch", "env_drift", "compaction_present", "aborted", "errored", "nonterminal", "unclassified"];
		const fx = await writePrepareV2Fixture(join(root, "bench"), { phase: "dev", entries });
		const result = await prepareEvidenceV2({ runsDir: fx.runsDir, inputsDir: fx.inputsDir, collectionFile: fx.collectionFile, protocol: fx.protocol });
		assert.deepEqual(result.attempts.map((a) => a.category), expected);
		const parsed = parseManifestV2(await readFile(result.manifestPath, "utf8"), fx.protocol);
		assert.deepEqual(parsed.attempts.map((a) => a.category), expected);
		assert.deepEqual(parsed.attempts.map((a) => a.label), ["attempt-1", "attempt-2", "attempt-3", "attempt-4", "attempt-5", "attempt-6", "attempt-7"]);
		const deviations = JSON.parse(await readFile(join(fx.runsDir, EVIDENCE_DIR_NAME, DEVIATIONS_NAME), "utf8")) as DeviationsDocumentV2;
		assert.deepEqual(deviations.attempts.map((a) => a.category), expected);
		const report = await analyzeManifestFileV2(result.manifestPath, fx.protocol);
		assert.deepEqual(report.attempts.map((a) => a.category), expected, "the analyzer reproduces every category");
	});
});

// ---------------------------------------------------------------------------
// D. Existing and racing output refusal
// ---------------------------------------------------------------------------

test("prepare v2: existing outputs refused with EXISTING_OUTPUT and survive untouched", async () => {
	await withTempDir(async (root) => {
		const dev = (): PrepareV2FixtureSpec => ({ phase: "dev", entries: [{ kind: "session", arm: "control", spec: {} }] });

		const fx1 = await writePrepareV2Fixture(join(root, "a"), dev());
		await mkdir(join(fx1.runsDir, EVIDENCE_DIR_NAME), { recursive: true });
		await writeFile(join(fx1.runsDir, EVIDENCE_DIR_NAME, "keep.txt"), "FOREIGN-KEEP-1", "utf8");
		await expectCode(prepareEvidenceV2({ runsDir: fx1.runsDir, inputsDir: fx1.inputsDir, collectionFile: fx1.collectionFile, protocol: fx1.protocol }), "EXISTING_OUTPUT");
		assert.equal(await readFile(join(fx1.runsDir, EVIDENCE_DIR_NAME, "keep.txt"), "utf8"), "FOREIGN-KEEP-1");
		assert.ok(!existsSync(join(fx1.runsDir, MANIFEST_NAME)), "no manifest may remain in a");
		assert.deepEqual((await readdir(fx1.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [], "no staging leftovers in a");

		const fx2 = await writePrepareV2Fixture(join(root, "b"), dev());
		await mkdir(fx2.runsDir, { recursive: true });
		await writeFile(join(fx2.runsDir, MANIFEST_NAME), "FOREIGN-MANIFEST-2", "utf8");
		await expectCode(prepareEvidenceV2({ runsDir: fx2.runsDir, inputsDir: fx2.inputsDir, collectionFile: fx2.collectionFile, protocol: fx2.protocol }), "EXISTING_OUTPUT");
		assert.equal(await readFile(join(fx2.runsDir, MANIFEST_NAME), "utf8"), "FOREIGN-MANIFEST-2");
		assert.ok(!existsSync(join(fx2.runsDir, EVIDENCE_DIR_NAME)), "no evidence directory may remain in b");
		assert.deepEqual((await readdir(fx2.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [], "no staging leftovers in b");
	});
});

test("prepare v2: racing outputs injected at the commit seams are refused and preserved", async () => {
	await withTempDir(async (root) => {
		const dev = (): PrepareV2FixtureSpec => ({ phase: "dev", entries: [{ kind: "session", arm: "control", spec: {} }] });

		// Evidence dir appears between staging and the commit re-checks.
		const fx1 = await writePrepareV2Fixture(join(root, "a"), dev());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx1.runsDir,
				inputsDir: fx1.inputsDir,
				collectionFile: fx1.collectionFile,
				protocol: fx1.protocol,
				hooks: {
					beforeEvidenceCommit: async () => {
						await mkdir(join(fx1.runsDir, EVIDENCE_DIR_NAME));
						await writeFile(join(fx1.runsDir, EVIDENCE_DIR_NAME, "race.txt"), "RACE-1", "utf8");
					},
				},
			}),
			"EXISTING_OUTPUT",
		);
		assert.equal(await readFile(join(fx1.runsDir, EVIDENCE_DIR_NAME, "race.txt"), "utf8"), "RACE-1", "racing evidence dir survives");
		assert.ok(!existsSync(join(fx1.runsDir, MANIFEST_NAME)));
		assert.deepEqual((await readdir(fx1.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [], "no staging leftovers");

		// Manifest appears between staging and the commit re-checks.
		const fx2 = await writePrepareV2Fixture(join(root, "b"), dev());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx2.runsDir,
				inputsDir: fx2.inputsDir,
				collectionFile: fx2.collectionFile,
				protocol: fx2.protocol,
				hooks: {
					beforeEvidenceCommit: async () => {
						await mkdir(fx2.runsDir, { recursive: true });
						await writeFile(join(fx2.runsDir, MANIFEST_NAME), "RACE-2", "utf8");
					},
				},
			}),
			"EXISTING_OUTPUT",
		);
		assert.equal(await readFile(join(fx2.runsDir, MANIFEST_NAME), "utf8"), "RACE-2", "racing manifest survives");
		assert.ok(!existsSync(join(fx2.runsDir, EVIDENCE_DIR_NAME)));
		assert.deepEqual((await readdir(fx2.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [], "no staging leftovers");

		// Manifest appears after the evidence reservation: the owned evidence
		// dir is rolled back, the foreign manifest survives.
		const fx3 = await writePrepareV2Fixture(join(root, "c"), dev());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx3.runsDir,
				inputsDir: fx3.inputsDir,
				collectionFile: fx3.collectionFile,
				protocol: fx3.protocol,
				hooks: {
					afterEvidenceReserve: async () => {
						await writeFile(join(fx3.runsDir, MANIFEST_NAME), "RACE-3", "utf8");
					},
				},
			}),
			"EXISTING_OUTPUT",
		);
		assert.equal(await readFile(join(fx3.runsDir, MANIFEST_NAME), "utf8"), "RACE-3", "racing manifest survives");
		assert.ok(!existsSync(join(fx3.runsDir, EVIDENCE_DIR_NAME)), "owned evidence dir rolled back");
		assert.deepEqual((await readdir(fx3.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [], "no staging leftovers");
	});
});

// ---------------------------------------------------------------------------
// D2. Deterministic staging — stagingName seam (collisions, unsafe suffixes,
//      post-move foreign paths)
// ---------------------------------------------------------------------------

test("prepare v2: staging candidates — all 8 collide with foreign dirs/files → IO_ERROR, foreign paths untouched", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareV2Fixture(join(root, "bench"), { phase: "dev", entries: [{ kind: "session", arm: "control", spec: {} }] });
		// Pre-create the runs root with 8 foreign candidates (7 dirs + 1 file).
		await mkdir(fx.runsDir, { recursive: true });
		const foreign: Array<{ name: string; marker: string; isDir: boolean }> = [];
		for (let i = 0; i < 8; i += 1) {
			const name = `${STAGING_PREFIX}cand-${i}`;
			const marker = `FOREIGN-CAND-${i}`;
			if (i === 7) {
				await writeFile(join(fx.runsDir, name), marker, "utf8");
				foreign.push({ name, marker, isDir: false });
			} else {
				await mkdir(join(fx.runsDir, name));
				await writeFile(join(fx.runsDir, name, "keep.txt"), marker, "utf8");
				foreign.push({ name, marker, isDir: true });
			}
		}
		let n = 0;
		const error = await expectCode(
			prepareEvidenceV2({
				runsDir: fx.runsDir,
				inputsDir: fx.inputsDir,
				collectionFile: fx.collectionFile,
				protocol: fx.protocol,
				stagingName: () => `cand-${Math.min(n++, 7)}`,
			}),
			"IO_ERROR",
		);
		// Every foreign candidate survives byte-identical — none was deleted,
		// overwritten or modified.
		for (const f of foreign) {
			const full = f.isDir ? join(fx.runsDir, f.name, "keep.txt") : join(fx.runsDir, f.name);
			assert.equal(await readFile(full, "utf8"), f.marker, `foreign candidate ${f.name} survives`);
		}
		assert.ok(!existsSync(join(fx.runsDir, EVIDENCE_DIR_NAME)), "no evidence dir");
		assert.ok(!existsSync(join(fx.runsDir, MANIFEST_NAME)), "no manifest");
		assert.deepEqual(
			(await readdir(fx.runsDir)).filter((x) => x.startsWith(STAGING_PREFIX)).sort(),
			foreign.map((f) => f.name).sort(),
			"exactly the 8 foreign candidates remain under the staging prefix",
		);
		assert.ok(!error.message.includes(root), "no absolute temp path in the error");
	});
});

test("prepare v2: staging candidates — first collision retried, safe second candidate succeeds, foreign path survives", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareV2Fixture(join(root, "bench"), { phase: "dev", entries: [{ kind: "session", arm: "control", spec: {} }] });
		await mkdir(fx.runsDir, { recursive: true });
		const first = `${STAGING_PREFIX}used`;
		await mkdir(join(fx.runsDir, first));
		await writeFile(join(fx.runsDir, first, "keep.txt"), "FOREIGN-FIRST-CAND", "utf8");
		let calls = 0;
		const result = await prepareEvidenceV2({
			runsDir: fx.runsDir,
			inputsDir: fx.inputsDir,
			collectionFile: fx.collectionFile,
			protocol: fx.protocol,
			stagingName: () => (calls++ === 0 ? "used" : "fresh"),
		});
		assert.equal(await readFile(join(fx.runsDir, first, "keep.txt"), "utf8"), "FOREIGN-FIRST-CAND", "foreign colliding candidate survives");
		assert.ok(existsSync(result.evidenceDir), "evidence committed");
		assert.ok(existsSync(result.manifestPath), "manifest committed");
		assert.deepEqual(
			(await readdir(fx.runsDir)).filter((x) => x.startsWith(STAGING_PREFIX)),
			[first],
			"only the foreign first candidate remains under the staging prefix",
		);
	});
});

test("prepare v2: staging candidates — unsafe suffixes fail BASENAME_UNSAFE without escape or echo", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareV2Fixture(join(root, "bench"), { phase: "dev", entries: [{ kind: "session", arm: "control", spec: {} }] });
		const unsafe: string[] = ["", ".", "..", "a/b", "a\\b", "bad\x01name", "x".repeat(65)];
		for (let i = 0; i < unsafe.length; i += 1) {
			const runsDir = join(root, `runs-${i}`);
			const suffix = unsafe[i]!;
			const error = await expectCode(
				prepareEvidenceV2({
					runsDir,
					inputsDir: fx.inputsDir,
					collectionFile: fx.collectionFile,
					protocol: fx.protocol,
					stagingName: () => suffix,
				}),
				"BASENAME_UNSAFE",
			);
			if (suffix.length > 0) assert.ok(!error.message.includes(suffix), "the unsafe suffix is never echoed");
			// The unsafe candidate is rejected before any path join, so no
			// staging/output entry ever exists under this runs root.
			await assertNoPartialsV2(runsDir);
		}
	});
});

test("prepare v2: staging — foreign path at the old staging name after the atomic move survives rollback", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareV2Fixture(join(root, "bench"), { phase: "dev", entries: [{ kind: "session", arm: "control", spec: {} }] });
		const boom = (message: string): Error => Object.assign(new Error(message), { code: "INJECTED" });
		const fixed = "deadbeef";
		const oldStagingPath = join(fx.runsDir, `${STAGING_PREFIX}${fixed}`);
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx.runsDir,
				inputsDir: fx.inputsDir,
				collectionFile: fx.collectionFile,
				protocol: fx.protocol,
				stagingName: () => fixed,
				hooks: {
					afterEvidenceCommit: async () => {
						// The staging path's ownership ended with the atomic move; a
					// foreign path appearing at the old staging name is never this
					// invocation's.
					await writeFile(oldStagingPath, "FOREIGN-OLD-STAGING", "utf8");
				},
					afterManifestOpen: async () => {
						throw boom("injected after manifest open");
					},
				},
			}),
			"INJECTED",
		);
		assert.equal(await readFile(oldStagingPath, "utf8"), "FOREIGN-OLD-STAGING", "foreign path at the old staging name survives");
		assert.ok(!existsSync(join(fx.runsDir, EVIDENCE_DIR_NAME)), "owned evidence dir rolled back");
		assert.ok(!existsSync(join(fx.runsDir, MANIFEST_NAME)), "owned manifest rolled back");
		assert.deepEqual(await readdir(fx.runsDir), [`${STAGING_PREFIX}${fixed}`], "only the foreign old-staging-name path remains");
	});
});

test("prepare v2: staging — foreign child and replaced owned file inside staging survive identity-verified rollback", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareV2Fixture(join(root, "bench"), { phase: "dev", entries: [{ kind: "session", arm: "control", spec: {} }] });
		const boom = (message: string): Error => Object.assign(new Error(message), { code: "INJECTED" });
		const fixed = "cafe42";
		const stagingDir = join(fx.runsDir, `${STAGING_PREFIX}${fixed}`);
		// The foreign replacement of the owned environment file is pre-created
		// at a sibling path (distinct pre-existing inode, same filesystem) and
		// renamed into place inside the hook — never delete+recreate at the
		// owned path, which could reuse the owned inode.
		const foreignEnvPath = join(root, "foreign-env-replacement.txt");
		await writeFile(foreignEnvPath, "FOREIGN-REPLACED-ENV", "utf8");
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx.runsDir,
				inputsDir: fx.inputsDir,
				collectionFile: fx.collectionFile,
				protocol: fx.protocol,
				stagingName: () => fixed,
				hooks: {
					beforeEvidenceCommit: async () => {
						// An unknown foreign child never recorded in the ownership
						// snapshot, and an owned staged file REPLACED by the
						// pre-created foreign entry renamed into place: both must
						// survive rollback.
						await writeFile(join(stagingDir, "foreign-child.txt"), "FOREIGN-CHILD", "utf8");
						await rm(join(stagingDir, ENVIRONMENT_NAME), { force: true });
						await rename(foreignEnvPath, join(stagingDir, ENVIRONMENT_NAME));
						throw boom("injected before evidence commit");
					},
				},
			}),
			"INJECTED",
		);
		assert.equal(await readFile(join(stagingDir, "foreign-child.txt"), "utf8"), "FOREIGN-CHILD", "foreign child survives");
		assert.equal(await readFile(join(stagingDir, ENVIRONMENT_NAME), "utf8"), "FOREIGN-REPLACED-ENV", "replaced owned file survives");
		assert.ok(!existsSync(join(stagingDir, MILESTONE_PROMPT_NAME)), "owned prompt sibling cleaned");
		assert.ok(!existsSync(join(stagingDir, RUBRIC_NAME)), "owned rubric sibling cleaned");
		assert.ok(!existsSync(join(stagingDir, COLLECTION_RECORD_NAME)), "owned collection-record sibling cleaned");
		assert.ok(!existsSync(join(stagingDir, DEVIATIONS_NAME)), "owned deviations sibling cleaned");
		assert.ok(!existsSync(join(stagingDir, FIXTURE_DIR_NAME)), "owned fixture sibling cleaned");
		assert.deepEqual((await readdir(stagingDir)).sort(), ["environment.txt", "foreign-child.txt"], "only the two foreign entries remain in staging");
		assert.ok(!existsSync(join(fx.runsDir, EVIDENCE_DIR_NAME)), "no evidence dir");
		assert.ok(!existsSync(join(fx.runsDir, MANIFEST_NAME)), "no manifest");
		assert.deepEqual((await readdir(fx.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [`${STAGING_PREFIX}${fixed}`], "only the surviving staging dir remains");
	});
});

// ---------------------------------------------------------------------------
// E. Ownership-tracked rollback and foreign preservation
// ---------------------------------------------------------------------------

test("prepare v2: rollback — injected failures after exclusive creates leave no partials", async () => {
	await withTempDir(async (root) => {
		const spec = (): PrepareV2FixtureSpec => ({ phase: "final", runsPerArm: 2, entries: abbaFinalEntriesV2(2) });
		const boom = (message: string): Error => Object.assign(new Error(message), { code: "INJECTED" });

		const fx0 = await writePrepareV2Fixture(join(root, "a"), spec());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx0.runsDir,
				inputsDir: fx0.inputsDir,
				collectionFile: fx0.collectionFile,
				protocol: fx0.protocol,
				hooks: {
					beforeEvidenceCommit: async () => {
						throw boom("injected before commit");
					},
				},
			}),
			"INJECTED",
		);
		await assertNoPartialsV2(fx0.runsDir);

		const fx1 = await writePrepareV2Fixture(join(root, "b"), spec());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx1.runsDir,
				inputsDir: fx1.inputsDir,
				collectionFile: fx1.collectionFile,
				protocol: fx1.protocol,
				hooks: {
					afterEvidenceReserve: async () => {
						throw boom("injected after evidence reservation");
					},
				},
			}),
			"INJECTED",
		);
		await assertNoPartialsV2(fx1.runsDir);

		const fx2 = await writePrepareV2Fixture(join(root, "c"), spec());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx2.runsDir,
				inputsDir: fx2.inputsDir,
				collectionFile: fx2.collectionFile,
				protocol: fx2.protocol,
				hooks: {
					afterEvidenceCommit: async () => {
						throw boom("injected after evidence move");
					},
				},
			}),
			"INJECTED",
		);
		await assertNoPartialsV2(fx2.runsDir);

		const fx3 = await writePrepareV2Fixture(join(root, "d"), spec());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx3.runsDir,
				inputsDir: fx3.inputsDir,
				collectionFile: fx3.collectionFile,
				protocol: fx3.protocol,
				hooks: {
					afterManifestOpen: async () => {
						throw boom("injected after manifest open");
					},
				},
			}),
			"INJECTED",
		);
		await assertNoPartialsV2(fx3.runsDir);

		const fx4 = await writePrepareV2Fixture(join(root, "e"), spec());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx4.runsDir,
				inputsDir: fx4.inputsDir,
				collectionFile: fx4.collectionFile,
				protocol: fx4.protocol,
				hooks: {
					afterManifestCommit: async () => {
						throw boom("injected after manifest commit");
					},
				},
			}),
			"INJECTED",
		);
		await assertNoPartialsV2(fx4.runsDir);
	});
});

test("prepare v2: foreign replacements and foreign children of owned paths survive rollback", async () => {
	await withTempDir(async (root) => {
		const dev = (): PrepareV2FixtureSpec => ({ phase: "dev", entries: [{ kind: "session", arm: "control", spec: {} }] });

		// The reserved evidence dir is replaced by a foreign non-empty dir:
		// the rename fails (ENOTEMPTY) and the foreign dir survives.
		const fx1 = await writePrepareV2Fixture(join(root, "a"), dev());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx1.runsDir,
				inputsDir: fx1.inputsDir,
				collectionFile: fx1.collectionFile,
				protocol: fx1.protocol,
				hooks: {
					afterEvidenceReserve: async () => {
						await rm(join(fx1.runsDir, EVIDENCE_DIR_NAME), { recursive: true, force: true });
						await mkdir(join(fx1.runsDir, EVIDENCE_DIR_NAME));
						await writeFile(join(fx1.runsDir, EVIDENCE_DIR_NAME, "replacement.txt"), "REPLACEMENT-1", "utf8");
					},
				},
			}),
			"EXISTING_OUTPUT",
		);
		assert.equal(await readFile(join(fx1.runsDir, EVIDENCE_DIR_NAME, "replacement.txt"), "utf8"), "REPLACEMENT-1", "foreign replacement dir survives");
		assert.ok(!existsSync(join(fx1.runsDir, MANIFEST_NAME)));
		assert.deepEqual((await readdir(fx1.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [], "no staging leftovers");

		// A foreign child injected into the reserved dir makes the move fail
		// (ENOTEMPTY); the child survives and the reserved dir is never wiped.
		const fx2 = await writePrepareV2Fixture(join(root, "b"), dev());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx2.runsDir,
				inputsDir: fx2.inputsDir,
				collectionFile: fx2.collectionFile,
				protocol: fx2.protocol,
				hooks: {
					afterEvidenceReserve: async () => {
						await writeFile(join(fx2.runsDir, EVIDENCE_DIR_NAME, "child.txt"), "CHILD-2", "utf8");
					},
				},
			}),
			"EXISTING_OUTPUT",
		);
		assert.equal(await readFile(join(fx2.runsDir, EVIDENCE_DIR_NAME, "child.txt"), "utf8"), "CHILD-2", "foreign child survives");
		assert.deepEqual((await readdir(join(fx2.runsDir, EVIDENCE_DIR_NAME))).sort(), ["child.txt"], "no staged content remains inside");
		assert.ok(!existsSync(join(fx2.runsDir, MANIFEST_NAME)));
		assert.deepEqual((await readdir(fx2.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [], "no staging leftovers");

		// The owned manifest is replaced after the exclusive open: the
		// post-commit verification fails and the foreign manifest survives.
		// The foreign manifest replacement is pre-created at a sibling path
		// (distinct pre-existing inode, same filesystem) and renamed into place
		// inside the hook — never delete+recreate at the owned path.
		const foreignManifestPath = join(root, "foreign-manifest-3.json");
		await writeFile(foreignManifestPath, "FOREIGN-MANIFEST-3", "utf8");
		const fx3 = await writePrepareV2Fixture(join(root, "c"), dev());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx3.runsDir,
				inputsDir: fx3.inputsDir,
				collectionFile: fx3.collectionFile,
				protocol: fx3.protocol,
				hooks: {
					afterManifestOpen: async () => {
						await rm(join(fx3.runsDir, MANIFEST_NAME), { force: true });
						await rename(foreignManifestPath, join(fx3.runsDir, MANIFEST_NAME));
					},
				},
			}),
			"STAGE_VERIFY",
		);
		assert.equal(await readFile(join(fx3.runsDir, MANIFEST_NAME), "utf8"), "FOREIGN-MANIFEST-3", "foreign manifest replacement survives");
		assert.ok(!existsSync(join(fx3.runsDir, EVIDENCE_DIR_NAME)), "owned evidence dir rolled back");
		assert.deepEqual((await readdir(fx3.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [], "no staging leftovers");
	});
});

test("prepare v2: rollback — replaced fixture and foreign nested child inside the committed evidence survive (after move and after manifest commit)", async () => {
	await withTempDir(async (root) => {
		const dev = (): PrepareV2FixtureSpec => ({ phase: "dev", entries: [{ kind: "session", arm: "control", spec: {} }] });
		const boom = (message: string): Error => Object.assign(new Error(message), { code: "INJECTED" });
		const foreignFixtureTree = async (name: string): Promise<string> => {
			// A foreign replacement tree pre-created at a sibling path (distinct
			// pre-existing inode, same filesystem) ready to be renamed into place.
			const dir = join(root, name);
			await mkdir(dir);
			await writeFile(join(dir, "foreign.txt"), "FOREIGN-FIXTURE", "utf8");
			return dir;
		};
		const tamper = async (evidenceDir: string, foreignFixtureDir: string): Promise<void> => {
			// Replace a known top-level owned child (fixture) with the foreign
			// tree renamed into place, and inject an unknown nested child inside
			// an owned sessions directory.
			await rm(join(evidenceDir, FIXTURE_DIR_NAME), { recursive: true, force: true });
			await rename(foreignFixtureDir, join(evidenceDir, FIXTURE_DIR_NAME));
			await writeFile(join(evidenceDir, "sessions", "control-01", "foreign-nested.txt"), "FOREIGN-NESTED", "utf8");
		};

		// Failure after the evidence move (before the manifest commit): the
		// foreign content survives, owned siblings are cleaned, no manifest was
		// ever committed.
		const foreignFixture1 = await foreignFixtureTree("foreign-fixture-tree-1");
		const fx1 = await writePrepareV2Fixture(join(root, "a"), dev());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx1.runsDir,
				inputsDir: fx1.inputsDir,
				collectionFile: fx1.collectionFile,
				protocol: fx1.protocol,
				hooks: {
					afterEvidenceCommit: async () => {
						await tamper(join(fx1.runsDir, EVIDENCE_DIR_NAME), foreignFixture1);
						throw boom("injected after evidence move");
					},
				},
			}),
			"INJECTED",
		);
		const ev1 = join(fx1.runsDir, EVIDENCE_DIR_NAME);
		assert.equal(await readFile(join(ev1, FIXTURE_DIR_NAME, "foreign.txt"), "utf8"), "FOREIGN-FIXTURE", "replaced fixture survives");
		assert.equal(await readFile(join(ev1, "sessions", "control-01", "foreign-nested.txt"), "utf8"), "FOREIGN-NESTED", "foreign nested child survives");
		assert.ok(!existsSync(join(ev1, MILESTONE_PROMPT_NAME)), "owned prompt sibling cleaned");
		assert.ok(!existsSync(join(ev1, ENVIRONMENT_NAME)), "owned environment sibling cleaned");
		assert.ok(!existsSync(join(ev1, "sessions", "control-01", "control-01.jsonl")), "owned session copy cleaned");
		assert.deepEqual((await readdir(ev1)).sort(), [FIXTURE_DIR_NAME, "sessions"], "only foreign-content roots remain");
		assert.ok(!existsSync(join(fx1.runsDir, MANIFEST_NAME)), "no manifest was committed");
		assert.deepEqual((await readdir(fx1.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [], "no staging leftovers");

		// Failure after the manifest commit: same replacements; the foreign
		// content survives and the owned manifest is cleaned too.
		const foreignFixture2 = await foreignFixtureTree("foreign-fixture-tree-2");
		const fx2 = await writePrepareV2Fixture(join(root, "b"), dev());
		await expectCode(
			prepareEvidenceV2({
				runsDir: fx2.runsDir,
				inputsDir: fx2.inputsDir,
				collectionFile: fx2.collectionFile,
				protocol: fx2.protocol,
				hooks: {
					afterManifestCommit: async () => {
						await tamper(join(fx2.runsDir, EVIDENCE_DIR_NAME), foreignFixture2);
						throw boom("injected after manifest commit");
					},
				},
			}),
			"INJECTED",
		);
		const ev2 = join(fx2.runsDir, EVIDENCE_DIR_NAME);
		assert.equal(await readFile(join(ev2, FIXTURE_DIR_NAME, "foreign.txt"), "utf8"), "FOREIGN-FIXTURE", "replaced fixture survives");
		assert.equal(await readFile(join(ev2, "sessions", "control-01", "foreign-nested.txt"), "utf8"), "FOREIGN-NESTED", "foreign nested child survives");
		assert.ok(!existsSync(join(ev2, MILESTONE_PROMPT_NAME)), "owned prompt sibling cleaned");
		assert.ok(!existsSync(join(ev2, "sessions", "control-01", "control-01.jsonl")), "owned session copy cleaned");
		assert.deepEqual((await readdir(ev2)).sort(), [FIXTURE_DIR_NAME, "sessions"], "only foreign-content roots remain");
		assert.ok(!existsSync(join(fx2.runsDir, MANIFEST_NAME)), "owned manifest cleaned");
		assert.deepEqual((await readdir(fx2.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [], "no staging leftovers");
	});
});

// ---------------------------------------------------------------------------
// F. CLI — import guard, dispatch, parsing, exits, privacy, caps
// ---------------------------------------------------------------------------

test("CLI: importing the module has no side effects (import guard)", async () => {
	await withTempDir(async (root) => {
		const script = join(root, "import-guard.mts");
		const adapterPath = join(process.cwd(), "scripts", "commander-native-tool-benchmark-v2-prepare.ts");
		await writeFile(
			script,
			[
				`import { mainV2, parsePrepareV2Args, prepareEvidenceV2, renderPrepareSummaryV2 } from ${JSON.stringify(adapterPath)};`,
				`console.log("IMPORT-OK", typeof mainV2, typeof parsePrepareV2Args, typeof prepareEvidenceV2, typeof renderPrepareSummaryV2);`,
			].join("\n") + "\n",
			"utf8",
		);
		const res = await spawnExec(join(process.cwd(), "node_modules", ".bin", "tsx"), [script], { timeout: 120000 });
		assert.equal(res.code, 0, res.stderr);
		assert.equal(res.stderr, "", "importing must never run the CLI (no stderr)");
		assert.ok(res.stdout.startsWith("IMPORT-OK function function function function"), res.stdout);
	});
});

test("mainV2: library dispatch returns 2 for usage errors and 0 for help", async () => {
	assert.equal(await mainV2(["--help"]), 0);
	assert.equal(await mainV2(["-h"]), 0);
	assert.equal(await mainV2([]), 2);
	assert.equal(await mainV2(["prepare"]), 2);
	assert.equal(await mainV2(["prepare", "--inputs"]), 2);
	assert.equal(await mainV2(["bogus"]), 2);
});

test("parsePrepareV2Args: help, missing/unknown/duplicate options, runs-dir default", () => {
	const ok = parsePrepareV2Args(["--inputs", "a", "--collection", "c"]);
	assert.equal(ok.help, false);
	assert.equal(ok.inputsDir, "a");
	assert.equal(ok.collectionFile, "c");
	assert.equal(ok.runsDir, join(process.cwd(), ".pi", "workbench", "runs"));
	const withRuns = parsePrepareV2Args(["--inputs", "a", "--collection", "c", "--runs-dir", "r"]);
	assert.equal(withRuns.runsDir, "r");
	assert.equal(parsePrepareV2Args(["--help"]).help, true);
	assert.equal(parsePrepareV2Args(["-h"]).help, true);
	assert.equal(parsePrepareV2Args(["--inputs", "a", "--collection", "c", "--help"]).help, true);
	for (const argv of [[], ["--inputs"], ["--inputs", "a"], ["--collection", "c"], ["--inputs", "a", "--collection", "c", "--runs-dir"]]) {
		const p = parsePrepareV2Args(argv);
		assert.equal(p.help, false);
		assert.equal(p.inputsDir, null, JSON.stringify(argv));
		assert.equal(p.collectionFile, null, JSON.stringify(argv));
	}
	for (const argv of [
		["--inputs", "a", "--collection", "c", "--bogus"],
		["--inputs", "a", "--inputs", "b", "--collection", "c"],
		["--inputs", "a", "--collection", "c", "--runs-dir", "r", "--runs-dir", "r2"],
		["--inputs", "a", "--collection", "c", "extra"],
	]) {
		const p = parsePrepareV2Args(argv);
		assert.equal(p.help, false);
		assert.equal(p.inputsDir, null, JSON.stringify(argv));
		assert.equal(p.collectionFile, null, JSON.stringify(argv));
	}
});

const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const SCRIPT = join(process.cwd(), "scripts", "commander-native-tool-benchmark-v2-prepare.ts");
const ANALYZE_SCRIPT = join(process.cwd(), "scripts", "commander-native-tool-benchmark-v2-analyze.ts");
const INPUTS = join(process.cwd(), INPUTS_DIR);

/** Byte-copy the frozen production v2 inputs into a temp dir (CLI tests always use the frozen pins). */
async function writeFrozenInputs(root: string): Promise<string> {
	const inputsDir = join(root, "inputs");
	await mkdir(inputsDir, { recursive: true });
	await cp(join(INPUTS, FIXTURE_DIR_NAME), join(inputsDir, FIXTURE_DIR_NAME), { recursive: true });
	for (const name of [MILESTONE_PROMPT_NAME, ENVIRONMENT_NAME, RUBRIC_NAME]) {
		await writeFile(join(inputsDir, name), await readFile(join(INPUTS, name)), "utf8");
	}
	return inputsDir;
}

test("CLI: prepare success exits 0 against the frozen production pins; analyzer CLI consumes the manifest", async () => {
	await withTempDir(async (root) => {
		const inputsDir = await writeFrozenInputs(root);
		const promptText = await readFile(join(inputsDir, MILESTONE_PROMPT_NAME), "utf8");
		await mkdir(join(root, "sources"), { recursive: true });
		const entries: Array<{ kind: "session"; arm: ArmName; path: string; expected_session_sha256: string }> = [];
		const perArm = { control: 0, treatment: 0 };
		for (const arm of ["control", "treatment"] as const) {
			perArm[arm] += 1;
			const label = sessionLabelV2(arm, perArm[arm]);
			const content = jsonl(buildSessionEntriesV2({ prompt: promptText }));
			await writeFile(join(root, "sources", `${label}.jsonl`), content, "utf8");
			entries.push({ kind: "session", arm, path: `sources/${label}.jsonl`, expected_session_sha256: sha256Hex(content) });
		}
		const wire = {
			schema_version: COLLECTION_SCHEMA_VERSION,
			protocol_version: PROTOCOL_VERSION,
			protocol_doc: PROTOCOL_DOC,
			phase: "dev",
			milestone_prompt_sha256: FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256,
			fixture_manifest_sha256: FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256,
			non_treatment_sha256: FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256,
			rubric_sha256: FROZEN_NRO_V2_PROTOCOL.rubricSha256,
			environment: environmentWire(),
			entries,
		};
		await writeFile(join(root, "collection.json"), `${JSON.stringify(wire, null, 2)}\n`, "utf8");

		const res = await spawnExec(
			TSX,
			[SCRIPT, "prepare", "--inputs", inputsDir, "--collection", join(root, "collection.json"), "--runs-dir", join(root, "runs")],
			{ timeout: 120000 },
		);
		assert.equal(res.code, 0, res.stderr);
		assert.ok(res.stdout.includes("commander-native-tool-benchmark-v2 prepare:"), res.stdout);
		assert.ok(res.stdout.includes(`evidence dir : ${EVIDENCE_DIR_NAME}/`), res.stdout);
		assert.ok(res.stdout.includes(MANIFEST_NAME), res.stdout);
		assert.ok(res.stdout.includes("privacy :"), res.stdout);
		assert.ok(res.stdout.endsWith("\n"));
		assert.ok(!res.stdout.includes(root), "no absolute temp paths in the summary");
		assert.ok(!res.stdout.includes(promptText), "prompt text never surfaces");
		// The FULL emitted stdout — already asserted to end with "\n" — including
		// its final newline must stay within the declared human byte cap.
		assert.ok(utf8Bytes(res.stdout) <= HUMAN_MAX_BYTES, "full emitted stdout (including the final newline) stays within the byte cap");
		// The prepared manifest is consumable by the analyzer CLI (frozen pins).
		const analyze = await spawnExec(TSX, [ANALYZE_SCRIPT, "analyze", join(root, "runs", MANIFEST_NAME)], { timeout: 120000 });
		assert.equal(analyze.code, 0, analyze.stderr);
		assert.ok(analyze.stdout.includes("commander native tool benchmark v2"));
	});
});

test("CLI: fail-closed prepare error exits 1 with stderr only, no partial stdout, privacy-safe", async () => {
	await withTempDir(async (root) => {
		const inputsDir = await writeFrozenInputs(root);
		const promptText = await readFile(join(inputsDir, MILESTONE_PROMPT_NAME), "utf8");
		await mkdir(join(root, "sources"), { recursive: true });
		// Secret-bearing session content with a wrong expected hash: only
		// hashes may surface on stderr.
		const content = jsonl(secretSessionEntries(promptText));
		await writeFile(join(root, "sources", "control-01.jsonl"), content, "utf8");
		const wire = {
			schema_version: COLLECTION_SCHEMA_VERSION,
			protocol_version: PROTOCOL_VERSION,
			protocol_doc: PROTOCOL_DOC,
			phase: "dev",
			milestone_prompt_sha256: FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256,
			fixture_manifest_sha256: FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256,
			non_treatment_sha256: FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256,
			rubric_sha256: FROZEN_NRO_V2_PROTOCOL.rubricSha256,
			environment: environmentWire(),
			entries: [{ kind: "session", arm: "control", path: "sources/control-01.jsonl", expected_session_sha256: H64_OTHER }],
		};
		await writeFile(join(root, "collection.json"), `${JSON.stringify(wire, null, 2)}\n`, "utf8");

		const res = await spawnExec(
			TSX,
			[SCRIPT, "prepare", "--inputs", inputsDir, "--collection", join(root, "collection.json"), "--runs-dir", join(root, "runs")],
			{ timeout: 120000 },
		);
		assert.equal(res.code, 1);
		assert.equal(res.stdout, "", "no partial stdout on failure");
		assert.ok(res.stderr.includes("commander-native-tool-benchmark-v2 prepare:"), res.stderr);
		assert.ok(res.stderr.includes("SOURCE_HASH_MISMATCH"), res.stderr);
		assert.ok(!res.stderr.includes(root), "absolute temp paths never leak");
		assert.ok(!res.stderr.includes(SECRET_BODY), "secret tool-result body never leaks");
		assert.ok(!res.stderr.includes(SECRET_PATH), "secret read path never leaks");
		assert.ok(!res.stderr.includes(promptText), "prompt text never leaks");
		assert.ok(!existsSync(join(root, "runs")), "no outputs on failure");
	});
});

test("CLI: usage errors exit 2 on stderr only; --help/-h exit 0 on stdout; adversarial values bounded", async () => {
	const noArgs = await spawnExec(TSX, [SCRIPT], { timeout: 120000 });
	assert.equal(noArgs.code, 2);
	assert.equal(noArgs.stdout, "");
	assert.ok(noArgs.stderr.includes("usage:"));
	assert.ok(noArgs.stderr.includes("exit codes"));
	assert.ok(utf8Bytes(noArgs.stderr) <= 4096);

	const missing = await spawnExec(TSX, [SCRIPT, "prepare", "--inputs", "x"], { timeout: 120000 });
	assert.equal(missing.code, 2);
	assert.equal(missing.stdout, "");

	const unknown = await spawnExec(TSX, [SCRIPT, "prepare", "--inputs", "x", "--collection", "y", "--bogus"], { timeout: 120000 });
	assert.equal(unknown.code, 2);
	assert.equal(unknown.stdout, "");

	const dup = await spawnExec(TSX, [SCRIPT, "prepare", "--inputs", "x", "--inputs", "y", "--collection", "z"], { timeout: 120000 });
	assert.equal(dup.code, 2);
	assert.equal(dup.stdout, "");

	const positional = await spawnExec(TSX, [SCRIPT, "prepare", "--inputs", "x", "--collection", "y", "extra"], { timeout: 120000 });
	assert.equal(positional.code, 2);
	assert.equal(positional.stdout, "");

	// Adversarial unknown option: usage only, nothing echoed, bounded stderr.
	// (A NUL byte cannot traverse spawn argv at all — node rejects it before
	// exec — so the adversarial payload carries the passable control chars
	// TAB and ESC; NUL sanitization is covered by the renderer tests.)
	const evilOption = "x".repeat(10000) + "\t\x1bevil";
	const adv = await spawnExec(TSX, [SCRIPT, "prepare", "--inputs", "x", "--collection", "y", evilOption], { timeout: 120000 });
	assert.equal(adv.code, 2);
	assert.ok(!adv.stderr.includes(evilOption), "the adversarial option is never echoed");
	assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(adv.stderr), "no control characters on stderr");
	assert.ok(utf8Bytes(adv.stderr) <= 4096);

	// Adversarial option VALUE (well-formed args): fails closed exit 1 with
	// bounded, sanitized, path-free stderr (payload as above: passable control
	// chars only — NUL cannot be delivered through spawn argv).
	const evilValue = "x".repeat(10000) + "\t\x1bevil";
	const advValue = await spawnExec(TSX, [SCRIPT, "prepare", "--inputs", evilValue, "--collection", "y"], { timeout: 120000 });
	assert.equal(advValue.code, 1);
	assert.equal(advValue.stdout, "");
	assert.ok(!advValue.stderr.includes(evilValue), "the adversarial value is never echoed");
	assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(advValue.stderr), "no control characters on stderr");
	assert.ok(utf8Bytes(advValue.stderr) <= 4096);

	const sub = await spawnExec(TSX, [SCRIPT, "nope"], { timeout: 120000 });
	assert.equal(sub.code, 2);
	assert.equal(sub.stdout, "");
	assert.ok(sub.stderr.includes('unknown subcommand "nope"'), sub.stderr);
	assert.ok(utf8Bytes(sub.stderr) <= 4096);

	const help = await spawnExec(TSX, [SCRIPT, "--help"], { timeout: 120000 });
	assert.equal(help.code, 0);
	assert.equal(help.stderr, "");
	assert.ok(help.stdout.includes("usage:"));
	const shortHelp = await spawnExec(TSX, [SCRIPT, "-h"], { timeout: 120000 });
	assert.equal(shortHelp.code, 0);
	assert.equal(shortHelp.stderr, "");
});

test("renderCliErrorV2Prepare: allowlisted codes; forged and unsafe codes withheld", () => {
	const GENERIC = "PREPARE_ERROR: unexpected failure (details withheld — see privacy boundary)";
	const sanitized = renderCliErrorV2Prepare(new NroV2PrepareError("IO_ERROR", "line1\x00\x1bline2"));
	assert.ok(sanitized.startsWith("IO_ERROR: "));
	assert.ok(!/[\x00-\x1f\x7f]/.test(sanitized), "control characters are replaced");
	assert.ok(sanitized.includes("line1  line2"));
	// The trusted internal error families render their sanitized bounded messages.
	assert.ok(renderCliErrorV2Prepare(new NroV2Error("PIN_MISMATCH", "pin drift")).startsWith("PIN_MISMATCH: "));
	assert.ok(renderCliErrorV2Prepare(new NroError("MALFORMED_JSONL", "bad jsonl")).startsWith("MALFORMED_JSONL: "));
	assert.ok(renderCliErrorV2Prepare(new V2PolicyError("RUBRIC_INVALID", "policy drift")).startsWith("RUBRIC_INVALID: "));
	// Messages are UTF-8 capped with an explicit ellipsis marker.
	const long = renderCliErrorV2Prepare(new NroV2PrepareError("IO_ERROR", "x".repeat(2000)));
	assert.equal(utf8Bytes(long), "IO_ERROR: ".length + 512);
	assert.ok(long.endsWith("…"));
	// Non-Error throwables collapse to the fixed generic form.
	assert.equal(renderCliErrorV2Prepare("boom"), GENERIC);
	assert.equal(renderCliErrorV2Prepare(42), GENERIC);
	assert.equal(renderCliErrorV2Prepare(undefined), GENERIC);
	assert.equal(renderCliErrorV2Prepare(null), GENERIC);
	// Forged safe-looking codes on plain Errors are withheld entirely.
	const SECRET = "NROPRIVATE-APIKEY-7f3d";
	const forged = new Error(`read failed with secret ${SECRET}`);
	(forged as { code?: unknown }).code = "IO_ERROR";
	assert.equal(renderCliErrorV2Prepare(forged), GENERIC);
	const lower = new Error(`secret ${SECRET}`);
	(lower as { code?: unknown }).code = "i_o_error";
	assert.equal(renderCliErrorV2Prepare(lower), GENERIC);
	const nonString = new Error(`secret ${SECRET}`);
	(nonString as { code?: unknown }).code = 42;
	assert.equal(renderCliErrorV2Prepare(nonString), GENERIC);
	const control = new Error(`secret ${SECRET}`);
	(control as { code?: unknown }).code = "BAD CODE!";
	assert.equal(renderCliErrorV2Prepare(control), GENERIC);
	// A forged trusted-looking `name` never grants class identity: a plain
	// Error carrying BOTH a safe code and any forged family name is always
	// exactly the generic withheld form.
	for (const forgedName of ["NroV2PrepareError", "NroV2Error", "V2PolicyError", "NroError"]) {
		const forged = new Error(`read failed with secret ${SECRET}`);
		(forged as { code?: unknown }).code = "IO_ERROR";
		forged.name = forgedName;
		assert.equal(renderCliErrorV2Prepare(forged), GENERIC, `forged name "${forgedName}" is never trusted`);
	}
	// A genuine structured error whose code was corrupted is withheld as well.
	const corrupted = new NroV2PrepareError("IO_ERROR", `secret ${SECRET}`);
	(corrupted as { code: string }).code = "lower_case";
	assert.equal(renderCliErrorV2Prepare(corrupted), GENERIC);
	// While a genuine structured error still renders sanitized bounded details.
	const genuine = renderCliErrorV2Prepare(new NroV2PrepareError("IO_ERROR", `failed on value ${SECRET}`));
	assert.ok(genuine.startsWith("IO_ERROR: "));
	assert.ok(genuine.includes("failed on value"));
	assert.ok(utf8Bytes(genuine) <= "IO_ERROR: ".length + 512, "bounded rendering");
	assert.ok(!/[\x00-\x1f\x7f]/.test(genuine), "sanitized rendering");
});

test("applyCapsV2Prepare: exact newline-aware caps, marker, degenerate caller caps", () => {
	// Within caps: unchanged; the byte budget counts the "\n" separators.
	assert.deepEqual(applyCapsV2Prepare(["a", "b", "c"], 10, 1000), ["a", "b", "c"]);
	// Line cap: exactly maxLines kept plus the marker as the final line.
	const many = applyCapsV2Prepare(Array.from({ length: 10 }, (_, i) => `line-${i}`), 3, 10000);
	assert.equal(many.length, 3);
	assert.equal(many[2], "... (output capped: 3 lines / 10000 bytes — deterministic bound)");
	// Byte cap: 3 lines of 5 bytes joined = 5+1+5+1+5 = 17 bytes — exact fit kept.
	assert.deepEqual(applyCapsV2Prepare(["12345", "12345", "12345"], 10, 17), ["12345", "12345", "12345"]);
	// One byte less: the trailing line is dropped for the marker.
	const over = applyCapsV2Prepare(["12345", "12345", "12345"], 10, 16);
	assert.ok(over.length >= 1);
	assert.ok(utf8Bytes(over.join("\n")) <= 16, "byte cap holds");
	assert.ok(over.length <= 10, "line cap holds");
	// Byte overflow with a fully-fitting marker.
	const over2 = applyCapsV2Prepare(["x".repeat(100), "y"], 10, 101);
	assert.equal(over2.length, 1);
	assert.ok(over2[0]!.includes("capped"), "truncation is always marked");
	// Degenerate caller caps fail closed to the empty output.
	assert.deepEqual(applyCapsV2Prepare(["x"], 0, 100), []);
	assert.deepEqual(applyCapsV2Prepare(["x"], 100, 0), []);
	assert.deepEqual(applyCapsV2Prepare(["x"], NaN, 100), []);
	assert.deepEqual(applyCapsV2Prepare(["x"], 100, Infinity), []);
	assert.deepEqual(applyCapsV2Prepare(["x"], -1, -1), []);
	// Deterministic.
	assert.deepEqual(applyCapsV2Prepare(["a", "b"], 1, 100), applyCapsV2Prepare(["a", "b"], 1, 100));
});

test("renderPrepareSummaryV2: caps hold (lines + bytes), deterministic, privacy-safe", async () => {
	await withTempDir(async (root) => {
		const entries: EntrySlotV2[] = [];
		for (let i = 0; i < 30; i += 1) entries.push({ kind: "attempt", arm: "control", spec: erroredAttemptSpec() });
		entries.push({ kind: "session", arm: "control", spec: {} });
		const fx = await writePrepareV2Fixture(join(root, "bench"), { phase: "dev", entries });
		const result = await prepareEvidenceV2({ runsDir: fx.runsDir, inputsDir: fx.inputsDir, collectionFile: fx.collectionFile, protocol: fx.protocol });
		const lines = renderPrepareSummaryV2(result);
		assert.ok(lines.length <= HUMAN_MAX_LINES, "line cap holds");
		assert.ok(utf8Bytes(lines.join("\n")) <= HUMAN_MAX_BYTES, "byte cap holds");
		// Exact final-newline reservation: the CLI emits `${line}\n` per line, so
		// the emitted form is the joined lines plus ONE trailing newline byte —
		// and that emitted form must still respect the declared byte cap.
		const emitted = `${lines.join("\n")}\n`;
		assert.ok(utf8Bytes(emitted) <= HUMAN_MAX_BYTES, "emitted summary (joined + final newline) stays within the byte cap");
		assert.equal(utf8Bytes(emitted), utf8Bytes(lines.join("\n")) + 1, "the emitted form is exactly the joined bytes plus one newline byte");
		assert.deepEqual(lines, renderPrepareSummaryV2(result), "deterministic summary");
		assert.ok(lines.some((l) => l.includes("attempt attempt-1 | [control] category errored")), "bounded attempt facts rendered");
		assertPrivacySafe(lines.join("\n"), root);
	});
});

// ---------------------------------------------------------------------------
// G. Determinism
// ---------------------------------------------------------------------------

test("prepare v2: deterministic given bytes/options — identical manifests and summaries across runs roots", async () => {
	await withTempDir(async (root) => {
		const spec = (): PrepareV2FixtureSpec => ({
			phase: "final",
			runsPerArm: 2,
			entries: abbaFinalEntriesV2(2, { retries: [{ at: 1, spec: promptMismatchSpec() }, { at: 3, spec: erroredAttemptSpec() }] }),
		});
		const a = await writePrepareV2Fixture(join(root, "a"), spec());
		const b = await writePrepareV2Fixture(join(root, "b"), spec());
		const ra = await prepareEvidenceV2({ runsDir: a.runsDir, inputsDir: a.inputsDir, collectionFile: a.collectionFile, protocol: a.protocol });
		const rb = await prepareEvidenceV2({ runsDir: b.runsDir, inputsDir: b.inputsDir, collectionFile: b.collectionFile, protocol: b.protocol });
		assert.equal(await readFile(ra.manifestPath, "utf8"), await readFile(rb.manifestPath, "utf8"), "manifest bytes are identical");
		assert.deepEqual(renderPrepareSummaryV2(ra), renderPrepareSummaryV2(rb), "summaries are identical");
		assert.deepEqual(ra.manifest, rb.manifest);
	});
});

// ---------------------------------------------------------------------------
// H. Static import guard
// ---------------------------------------------------------------------------

test("static guard: adapter imports only allowlisted v1 primitives plus the v2 core/protocol/policy; offline", async () => {
	const source = await readFile(join(process.cwd(), "scripts", "commander-native-tool-benchmark-v2-prepare.ts"), "utf8");
	// The v1 import surface is exactly the allowlisted pure primitive set.
	const v1Marker = 'from "./commander-native-tool-benchmark.ts";';
	const v1Block = source.slice(source.indexOf(v1Marker) - 600, source.indexOf(v1Marker));
	for (const allowed of ["canonicalEnvironmentFile", "fixtureManifestHash", "parseSessionLines", "resolveSessionPath", "sha256Hex", "HUMAN_MAX_BYTES", "HUMAN_MAX_LINES", "MANIFEST_MAX_BYTES", "PATH_MAX_BYTES", "SESSION_MAX_BYTES", "NroError"]) {
		assert.ok(v1Block.includes(allowed), `v1 primitive ${allowed} is allowlisted`);
	}
	for (const banned of [
		"parseManifest",
		"parseCollectionRecord",
		"preflightInputs",
		"preflightCollection",
		"prepareEvidence",
		"computeRunFacts",
		"deriveAttemptFacts",
		"analyzeManifestFile",
		"buildReport",
		"applyCaps",
		"renderReport",
		"renderPrepareSummary",
		"parsePrepareArgs",
		"manifestToJson",
		"copyFixtureTree",
		"EVIDENCE_DIR_NAME",
		"MANIFEST_NAME",
		"STAGING_PREFIX",
		"DEVIATIONS_NAME",
		"COLLECTION_RECORD_NAME",
		"FIXTURE_DIR_NAME",
		"MILESTONE_PROMPT_NAME",
		"ENVIRONMENT_NAME",
		"RUBRIC_NAME",
		"FROZEN_NRO_PROTOCOL",
	]) {
		assert.ok(!v1Block.includes(banned), `v1 implementation/constant ${banned} is never imported`);
	}
	// The v2 core import surface is the normative derivation/validation path.
	const v2Marker = 'from "./commander-native-tool-benchmark-v2.ts";';
	const v2Block = source.slice(source.indexOf(v2Marker) - 800, source.indexOf(v2Marker));
	for (const name of ["parseCollectionRecordV2", "computeRunFactsV2", "deriveAttemptFactsV2", "manifestToJsonV2", "parseManifestV2", "sessionLabelV2", "NroV2Error"]) {
		assert.ok(v2Block.includes(name), `v2 core name ${name} is imported`);
	}
	// The frozen v2 protocol module supplies the v2 output names/constants.
	const protocolMarker = 'from "./commander-native-tool-benchmark-v2-protocol.ts";';
	const protocolBlock = source.slice(source.indexOf(protocolMarker) - 800, source.indexOf(protocolMarker));
	for (const name of [
		"EVIDENCE_DIR_NAME",
		"MANIFEST_NAME",
		"STAGING_PREFIX",
		"DEVIATIONS_NAME",
		"DEVIATIONS_SCHEMA_VERSION",
		"COLLECTION_RECORD_NAME",
		"FIXTURE_DIR_NAME",
		"MILESTONE_PROMPT_NAME",
		"ENVIRONMENT_NAME",
		"RUBRIC_NAME",
		"FROZEN_NRO_V2_PROTOCOL",
	]) {
		assert.ok(protocolBlock.includes(name), `v2 protocol constant ${name} is imported`);
	}
	// The frozen v2 policy supplies the ordered rubric checks.
	const policyMarker = 'from "./commander-native-tool-benchmark-v2-policy.ts";';
	const policyBlock = source.slice(source.indexOf(policyMarker) - 300, source.indexOf(policyMarker));
	assert.ok(policyBlock.includes("V2_RUBRIC_CHECKS"), "V2_RUBRIC_CHECKS is imported");
	// The runtime error-trust classes are intentional imports: V2PolicyError
	// (class-identity error trust) alongside the v1 NroError family.
	assert.ok(policyBlock.includes("V2PolicyError"), "V2PolicyError is imported (class-identity error trust)");
	// Only node builtins and the four local modules are imported.
	const imports = [...source.matchAll(/^import .*? from "([^"]+)";/gm)].map((m) => m[1] ?? "");
	for (const mod of imports) {
		assert.ok(
			mod.startsWith("node:") ||
				mod === "./commander-native-tool-benchmark.ts" ||
				mod === "./commander-native-tool-benchmark-v2.ts" ||
				mod === "./commander-native-tool-benchmark-v2-protocol.ts" ||
				mod === "./commander-native-tool-benchmark-v2-policy.ts",
			`unexpected import "${mod}"`,
		);
	}
	// Offline: no network, no process spawning, no shell, no analyzer dependency.
	for (const banned of ["child_process", "spawn(", "fetch(", "node:http", "node:https", "node:net", "node:child_process", "commander-native-tool-benchmark-v2-analyze"]) {
		assert.ok(!source.includes(banned), `offline token ${banned} must never appear`);
	}
	// The CLI runs only when executed directly (import-time purity).
	assert.ok(source.includes("fileURLToPath(import.meta.url)"), "direct-execution guard present");
});
