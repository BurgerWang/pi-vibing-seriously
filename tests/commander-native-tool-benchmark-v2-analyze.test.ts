/**
 * NRO protocol-v2 analyzer adapter tests (commander-native-tool-
 * benchmark-v2-analyze slice) — hermetic, deterministic: every fixture is
 * a synthetic temp tree (created under os.tmpdir() and removed in
 * finally) with pins derived from the generated content; the production
 * frozen pins stay strict (the CLI path always uses FROZEN_NRO_V2_PROTOCOL
 * and a derived protocol is only ever passed explicitly as the library
 * test seam). No network, no provider/model calls; the only spawned
 * process is the analyzer CLI itself under tsx. Every assertion is
 * byte-exact or code-exact.
 *
 * Covers, against the v2 analyzer adapter:
 *
 *   A. Final/dev end-to-end analysis over synthetic temp trees: the
 *      complete 40-session ABBA final cohort analyzes end to end; a dev
 *      manifest reports facts but every verdict is NOT_MEASURED;
 *      identical inputs produce identical JSON and identical rendering;
 *      analysis is read-only (no file created, no input mutated);
 *      privacy sentinels never appear in report JSON, rendering or
 *      failure errors.
 *   B. Fail-closed adapter errors: session and attempt raw byte hash
 *      mismatch; fixture manifest hash mismatch; unsafe output-facing
 *      identities (dev runs and attempts) fail closed generically;
 *      nested fixture symlinks and over-bound fixture paths surface
 *      only the bounded fixture-directory basename; missing,
 *      non-regular and oversized declared inputs; symlink escapes and
 *      duplicate realpaths.
 *   C. Propagation: v1 validator failures (malformed JSONL), v2 core
 *      failures (prompt mismatch, ATTEMPT_NOT_INVALID), v2 policy
 *      failures, attempt category and prompt reproduction drift, and
 *      the strict production pins (pin drift fails PIN_MISMATCH, never
 *      PROTOCOL_NOT_FROZEN).
 *   D. Bounded rendering: applyCapsV2 exact newline-aware caps with the
 *      deterministic marker and degenerate caller caps; multi-line
 *      removal keeps every truncated positive-cap output marked; the
 *      big dev fixture rendering respects the 240-line / 64 KiB caps
 *      with an explicit marker.
 *   E. CLI: exit 0 success against the frozen production pins (human
 *      default and deterministic pretty JSON + LF), exit 1 fail-closed
 *      with stderr only and no partial stdout, exit 2 usage errors,
 *      bounded/control-safe unknown options and subcommands,
 *      renderCliErrorV2 allowlisted codes with withheld untrusted
 *      details (forged/unsafe codes never leak secrets), library
 *      dispatch, and the static import guard (allowlisted v1
 *      primitives + v2 core only, read-only).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { spawnExec, withTempDir } from "./helpers.ts";

import {
	analyzeManifestFileV2,
	applyCapsV2,
	mainV2,
	renderCliErrorV2,
	renderReportV2,
	NroV2AnalyzeError,
	type NroV2AnalyzeErrorCode,
} from "../scripts/commander-native-tool-benchmark-v2-analyze.ts";

import {
	abbaArmAtV2,
	sessionLabelV2,
	NroV2Error,
	type V2FrozenProtocol,
} from "../scripts/commander-native-tool-benchmark-v2.ts";

import {
	V2_RUBRIC_CHECKS,
	V2PolicyError,
} from "../scripts/commander-native-tool-benchmark-v2-policy.ts";

import {
	BENCHMARK_SCHEMA_VERSION,
	FIXTURE_DIR_NAME,
	FROZEN_ENVIRONMENT,
	FROZEN_NRO_V2_PROTOCOL,
	INPUTS_DIR,
	MILESTONE_PROMPT_NAME,
	PROTOCOL_DOC,
	PROTOCOL_VERSION,
	TOTAL_VALID_RUNS,
	type Phase,
} from "../scripts/commander-native-tool-benchmark-v2-protocol.ts";

import {
	HUMAN_MAX_BYTES,
	HUMAN_MAX_LINES,
	SESSION_MAX_BYTES,
	fixtureManifestHash,
	NroError,
} from "../scripts/commander-native-tool-benchmark.ts";

// ---------------------------------------------------------------------------
// Hermetic constants and small helpers
// ---------------------------------------------------------------------------

const H64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const H64_OTHER = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const PROMPT_TEXT = "Solve the frozen NRO benchmark milestone precisely and report every required fact.";
const PROMPT_SHA256 = sha256Hex(PROMPT_TEXT);
const MODEL_KEY = FROZEN_ENVIRONMENT.modelKey; // "openai-codex/gpt-5.6-sol"
const RUBRIC_FULL_TEXT = ["build: alpha-42", "unicode: α, 水, 🚀", "token: delta-77", "needle_occurrences: 140", "needle_lines: 135", "needle_files: 4"].join("\n");

/** Sentinels that must NEVER appear in report JSON, rendering or failure errors. */
const SECRET_BODY = "NROPRIVATE-TOOLRESULT-1b3d";
const SECRET_PATH = "/private/secret-dir/SECRET-file-7c4e.txt";

function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

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

/** A machine-valid final session entry sequence (prompt, env, rubric, pagination all pass). */
function validSessionEntries(promptText: string = PROMPT_TEXT): unknown[] {
	return [
		userMessage(promptText),
		thinkingLevelChange(),
		assistantMessage([toolCallItem("c1", "read", { path: "fixture/alpha.txt" })]),
		toolResultMessage("c1", "read", markerLine(false)),
		assistantMessage([toolCallItem("c2", "read", { path: "fixture/alpha.txt", offset: 100 })]),
		toolResultMessage("c2", "read", "legacy continuation content"),
		assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
	];
}

/** Same shape as validSessionEntries but the session content carries privacy sentinels. */
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

/** An attempt that classifies "errored" (terminal stop reason error). */
function attemptErroredEntries(promptText: string = PROMPT_TEXT): unknown[] {
	return [userMessage(promptText), assistantMessage([{ type: "text", text: "attempt failed" }], { stopReason: "error" })];
}

/** An attempt that classifies "nonterminal" (no terminal stop) — and carries no user message (null prompt hash). */
function attemptNonterminalEntries(): unknown[] {
	return [assistantMessage([{ type: "text", text: "partial attempt" }], { stopReason: "max_tokens" })];
}

/** A machine-observably valid attempt (fails ATTEMPT_NOT_INVALID in strict final mode, "unclassified" in dev). */
function attemptValidEntries(promptText: string = PROMPT_TEXT): unknown[] {
	return [userMessage(promptText), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])];
}

async function writeFixtureTree(root: string): Promise<void> {
	await mkdir(join(root, "fixture", "meta"), { recursive: true });
	await mkdir(join(root, "fixture", "search"), { recursive: true });
	await writeFile(join(root, "fixture", "alpha.txt"), "alpha content\n", "utf8");
	await writeFile(join(root, "fixture", "meta", "build.txt"), "build: alpha-42\n", "utf8");
	await writeFile(join(root, "fixture", "search", "one.txt"), "needle\n", "utf8");
}

function manifestWire(
	sessions: Record<string, unknown>[],
	attempts: Record<string, unknown>[],
	phase: Phase,
	protocol: V2FrozenProtocol,
	fixtureSha: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schema_version: BENCHMARK_SCHEMA_VERSION,
		protocol_version: PROTOCOL_VERSION,
		protocol_doc: PROTOCOL_DOC,
		phase,
		milestone_prompt_sha256: protocol.milestonePromptSha256,
		environment: environmentWire(),
		fixture: { path: "fixture", manifest_sha256: fixtureSha },
		non_treatment_sha256: H64,
		rubric: { sha256: H64, checks: V2_RUBRIC_CHECKS.map((c) => ({ id: c.id, pattern: c.pattern })) },
		sessions,
		attempts,
		...overrides,
	};
}

function attemptWire(label: string, path: string, category: string, promptSha256: string | null, sha: string = H64): Record<string, unknown> {
	return { label, arm: "control", path, expected_session_sha256: sha, prompt_sha256: promptSha256, category };
}

interface CohortTree {
	root: string;
	manifestPath: string;
	protocol: V2FrozenProtocol;
	fixtureSha: string;
}

/**
 * Build a synthetic temp tree: fixture tree + ABBA-labelled session files
 * + attempt files + a strict manifest whose pins derive from the
 * generated content (library seam protocol). Final phase: 40 sessions
 * with the frozen ABBA bijection; dev phase: relaxed counts.
 */
async function buildCohortTree(root: string, opts: { phase?: Phase; sessionCount?: number; attempts?: number; promptText?: string } = {}): Promise<CohortTree> {
	const phase = opts.phase ?? "final";
	const sessionCount = opts.sessionCount ?? TOTAL_VALID_RUNS;
	const attemptCount = opts.attempts ?? 2;
	const promptText = opts.promptText ?? PROMPT_TEXT;
	await writeFixtureTree(root);
	const fixtureSha = (await fixtureManifestHash(join(root, "fixture"))).manifestSha256;
	const protocol: V2FrozenProtocol = {
		...FROZEN_NRO_V2_PROTOCOL,
		milestonePromptSha256: sha256Hex(promptText),
		fixtureManifestSha256: fixtureSha,
		nonTreatmentSha256: H64,
		rubricSha256: H64,
	};
	await mkdir(join(root, "sessions"), { recursive: true });
	const sessions: Record<string, unknown>[] = [];
	const perArm = { control: 0, treatment: 0 };
	for (let i = 1; i <= sessionCount; i += 1) {
		const arm = abbaArmAtV2(i);
		perArm[arm] += 1;
		const label = sessionLabelV2(arm, perArm[arm]);
		const content = jsonl(validSessionEntries(promptText));
		await writeFile(join(root, "sessions", `${label}.json`), content, "utf8");
		sessions.push({ label, arm, order_index: i, path: `sessions/${label}.json`, expected_session_sha256: sha256Hex(content) });
	}
	await mkdir(join(root, "attempts"), { recursive: true });
	const attempts: Record<string, unknown>[] = [];
	if (attemptCount >= 1) {
		const content = jsonl(attemptErroredEntries(promptText));
		await writeFile(join(root, "attempts", "attempt-01.json"), content, "utf8");
		attempts.push(attemptWire("attempt-1", "attempts/attempt-01.json", "errored", sha256Hex(promptText), sha256Hex(content)));
	}
	if (attemptCount >= 2) {
		const content = jsonl(attemptNonterminalEntries());
		await writeFile(join(root, "attempts", "attempt-02.json"), content, "utf8");
		attempts.push(attemptWire("attempt-2", "attempts/attempt-02.json", "nonterminal", null, sha256Hex(content)));
	}
	const manifestPath = join(root, "manifest.json");
	await writeFile(manifestPath, `${JSON.stringify(manifestWire(sessions, attempts, phase, protocol, fixtureSha), null, 2)}\n`, "utf8");
	return { root, manifestPath, protocol, fixtureSha };
}

/** Rewrite one declared session file and re-pin its expected hash in the manifest wire. */
async function replaceSession(root: string, wire: Record<string, unknown>, index: number, entries: unknown[]): Promise<void> {
	const session = (wire.sessions as Record<string, unknown>[])[index];
	assert.ok(session, "session index exists");
	const path = session.path as string;
	const content = jsonl(entries);
	await writeFile(join(root, path), content, "utf8");
	session.expected_session_sha256 = sha256Hex(content);
}

/** Rewrite one declared attempt file and re-pin its expected hash in the manifest wire. */
async function replaceAttempt(root: string, wire: Record<string, unknown>, index: number, entries: unknown[]): Promise<void> {
	const attempt = (wire.attempts as Record<string, unknown>[])[index];
	assert.ok(attempt, "attempt index exists");
	const path = attempt.path as string;
	const content = jsonl(entries);
	await writeFile(join(root, path), content, "utf8");
	attempt.expected_session_sha256 = sha256Hex(content);
}

async function writeWire(root: string, wire: Record<string, unknown>): Promise<string> {
	const manifestPath = join(root, "manifest.json");
	await writeFile(manifestPath, `${JSON.stringify(wire, null, 2)}\n`, "utf8");
	return manifestPath;
}

async function readWire(root: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Record<string, unknown>;
}

/** Fail-closed adapter error helper (analyzeManifestFileV2 resolves or throws NroV2AnalyzeError). */
async function expectAnalyzeError(promise: Promise<unknown>, code: NroV2AnalyzeErrorCode): Promise<NroV2AnalyzeError> {
	let err: unknown;
	try {
		await promise;
	} catch (e) {
		err = e;
	}
	assert.ok(err instanceof NroV2AnalyzeError, `expected NroV2AnalyzeError ${code}, got ${String(err)}`);
	assert.equal(err.code, code);
	return err;
}

/** v2 core error propagation helper. */
async function expectNroV2Error(promise: Promise<unknown>, code: string): Promise<NroV2Error> {
	let err: unknown;
	try {
		await promise;
	} catch (e) {
		err = e;
	}
	assert.ok(err instanceof NroV2Error, `expected NroV2Error ${code}, got ${String(err)}`);
	assert.equal((err as { code?: unknown }).code, code);
	return err as NroV2Error;
}

/** v1 core error propagation helper. */
async function expectNroError(promise: Promise<unknown>, code: string): Promise<NroError> {
	let err: unknown;
	try {
		await promise;
	} catch (e) {
		err = e;
	}
	assert.ok(err instanceof NroError, `expected NroError ${code}, got ${String(err)}`);
	assert.equal((err as { code?: unknown }).code, code);
	return err as NroError;
}

/** v2 policy error propagation helper. */
async function expectPolicyError(promise: Promise<unknown>, code: string): Promise<V2PolicyError> {
	let err: unknown;
	try {
		await promise;
	} catch (e) {
		err = e;
	}
	assert.ok(err instanceof V2PolicyError, `expected V2PolicyError ${code}, got ${String(err)}`);
	assert.equal((err as { code?: unknown }).code, code);
	return err as V2PolicyError;
}

/** Recursive snapshot of a tree: relative path -> utf8 content (used for read-only assertions). */
async function snapshotTree(root: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const walk = async (dir: string): Promise<void> => {
		for (const dirent of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, dirent.name);
			if (dirent.isDirectory()) {
				await walk(full);
			} else {
				out.set(full.slice(root.length + 1), await readFile(full, "utf8"));
			}
		}
	};
	await walk(root);
	return out;
}

// ---------------------------------------------------------------------------
// A. Final/dev end-to-end analysis
// ---------------------------------------------------------------------------

test("analyze v2: complete final 40-session ABBA cohort analyzes end to end", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		const report = await analyzeManifestFileV2(c.manifestPath, c.protocol);
		assert.equal(report.schemaVersion, BENCHMARK_SCHEMA_VERSION);
		assert.equal(report.protocolVersion, PROTOCOL_VERSION);
		assert.equal(report.manifest.phase, "final");
		assert.equal(report.manifest.sessionCount, TOTAL_VALID_RUNS);
		assert.equal(report.manifest.attemptCount, 2);
		assert.equal(report.manifest.rubricChecks, V2_RUBRIC_CHECKS.length);
		assert.equal(report.manifest.fixture.verified, true);
		assert.equal(report.manifest.fixture.files, 3);
		assert.equal(report.manifest.fixture.manifestSha256, c.fixtureSha);
		assert.equal(report.runs.length, TOTAL_VALID_RUNS);
		for (let i = 0; i < TOTAL_VALID_RUNS; i += 1) {
			const run = report.runs[i];
			assert.ok(run);
			assert.equal(run.arm, abbaArmAtV2(i + 1));
			assert.equal(run.orderIndex, i + 1);
			assert.equal(run.promptMatches, true);
			assert.equal(run.correctness.passed, true);
			assert.equal(run.misuse, false);
			assert.equal(run.editWriteToolCalls, 0);
		}
		assert.equal(report.arms.control.runCount, 20);
		assert.equal(report.arms.treatment.runCount, 20);
		assert.equal(report.attempts.length, 2);
		assert.equal(report.attempts[0]?.category, "errored");
		assert.equal(report.attempts[1]?.category, "nonterminal");
		assert.equal(report.verdicts.length, 4);
		// 40 identical valid sessions: bytes/gross medians reduce 0% (MISSED),
		// requests equality and p90 equality achieve the guards.
		assert.deepEqual(
			report.verdicts.map((v) => v.status),
			["MISSED", "MISSED", "ACHIEVED", "ACHIEVED"],
		);
		for (const verdict of report.verdicts) {
			assert.ok(verdict.status === "ACHIEVED" || verdict.status === "MISSED", "final cohort verdicts are measured, never NOT_MEASURED");
			assert.ok(verdict.reason.startsWith("frozen v2 §8"));
		}
	});
});

test("analyze v2: dev manifest reports facts but verdicts are all NOT_MEASURED", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root, { phase: "dev", sessionCount: 2, attempts: 1 });
		// Dev attempt: a machine-valid attempt classifies "unclassified" (non-strict) and is declared so.
		const wire = await readWire(root);
		await replaceAttempt(root, wire, 0, attemptValidEntries());
		(wire.attempts as Record<string, unknown>[])[0]!.category = "unclassified";
		(wire.attempts as Record<string, unknown>[])[0]!.prompt_sha256 = PROMPT_SHA256;
		const manifestPath = await writeWire(root, wire);
		const report = await analyzeManifestFileV2(manifestPath, c.protocol);
		assert.equal(report.manifest.phase, "dev");
		assert.equal(report.runs.length, 2);
		assert.equal(report.attempts.length, 1);
		assert.equal(report.attempts[0]?.category, "unclassified");
		assert.equal(report.runs[0]?.promptMatches, true);
		assert.equal(report.runs[0]?.correctness.passed, true);
		assert.equal(report.verdicts.length, 4);
		for (const verdict of report.verdicts) {
			assert.equal(verdict.status, "NOT_MEASURED");
			assert.equal(verdict.control, null);
			assert.equal(verdict.treatment, null);
			assert.ok(verdict.reason.includes("development-phase manifest"), "dev verdicts carry the frozen dev reason");
		}
	});
});

test("analyze v2: identical inputs produce identical JSON and identical rendering", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		const first = await analyzeManifestFileV2(c.manifestPath, c.protocol);
		const second = await analyzeManifestFileV2(c.manifestPath, c.protocol);
		assert.equal(JSON.stringify(first), JSON.stringify(second));
		assert.deepEqual(renderReportV2(first), renderReportV2(second));
		assert.equal(JSON.stringify(renderReportV2(first)), JSON.stringify(renderReportV2(second)));
	});
});

test("analyze v2: analysis is read-only — inputs unchanged and no file created", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		const before = await snapshotTree(root);
		const report = await analyzeManifestFileV2(c.manifestPath, c.protocol);
		assert.ok(report.runs.length > 0);
		const after = await snapshotTree(root);
		assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "no file may be created");
		for (const [rel, content] of before) {
			assert.equal(after.get(rel), content, `input ${rel} must be byte-identical after analysis`);
		}
	});
});

test("analyze v2: sentinels never appear in report JSON, rendering or failure errors", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		// Rebuild the first session file with secret-bearing content and re-pin it.
		const wire = await readWire(root);
		await replaceSession(root, wire, 0, secretSessionEntries());
		const manifestPath = await writeWire(root, wire);
		const report = await analyzeManifestFileV2(manifestPath, c.protocol);
		const json = JSON.stringify(report);
		assert.ok(!json.includes(SECRET_BODY), "secret tool-result body must never appear in report JSON");
		assert.ok(!json.includes(SECRET_PATH), "secret read path must never appear in report JSON");
		const rendering = renderReportV2(report).join("\n");
		assert.ok(!rendering.includes(SECRET_BODY), "secret tool-result body must never appear in rendering");
		assert.ok(!rendering.includes(SECRET_PATH), "secret read path must never appear in rendering");
		// Failure errors stay clean too: hash mismatch over the secret-bearing session.
		const failing = await readWire(root);
		(failing.sessions as Record<string, unknown>[])[0]!.expected_session_sha256 = H64_OTHER;
		const failingPath = await writeWire(root, failing);
		const err = await expectAnalyzeError(analyzeManifestFileV2(failingPath, c.protocol), "HASH_MISMATCH");
		assert.ok(!err.message.includes(SECRET_BODY));
		assert.ok(!err.message.includes(SECRET_PATH));
	});
});

// ---------------------------------------------------------------------------
// B. Fail-closed adapter errors
// ---------------------------------------------------------------------------

test("analyze v2: session and attempt raw byte hash mismatch fail closed", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		const wire = await readWire(root);
		const original = (wire.sessions as Record<string, unknown>[])[0]!.expected_session_sha256;
		(wire.sessions as Record<string, unknown>[])[0]!.expected_session_sha256 = H64_OTHER;
		const manifestPath = await writeWire(root, wire);
		const sessionErr = await expectAnalyzeError(analyzeManifestFileV2(manifestPath, c.protocol), "HASH_MISMATCH");
		assert.ok(sessionErr.message.includes("session"));
		assert.ok(sessionErr.message.includes("expected_session_sha256"));
		// Attempt hash mismatch fails closed with the same code.
		(wire.sessions as Record<string, unknown>[])[0]!.expected_session_sha256 = original;
		(wire.attempts as Record<string, unknown>[])[0]!.expected_session_sha256 = H64_OTHER;
		const manifestPath2 = await writeWire(root, wire);
		const attemptErr = await expectAnalyzeError(analyzeManifestFileV2(manifestPath2, c.protocol), "HASH_MISMATCH");
		assert.ok(attemptErr.message.includes("attempt"));
	});
});

test("analyze v2: fixture manifest hash mismatch fails closed", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		// The declared pin stays valid; the actual tree drifts after the
		// manifest was pinned — the adapter re-verification fails closed.
		await writeFile(join(root, "fixture", "alpha.txt"), "changed content\n", "utf8");
		const err = await expectAnalyzeError(analyzeManifestFileV2(c.manifestPath, c.protocol), "FIXTURE_MISMATCH");
		assert.ok(err.message.includes("fixture tree SHA-256"));
	});
});

test("analyze v2: unsafe output-facing identities fail closed generically (dev runs and attempts)", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root, { phase: "dev", sessionCount: 2, attempts: 1 });
		// Unsafe dev run model key.
		const wire1 = await readWire(root);
		await replaceSession(root, wire1, 0, [userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { model: "bad model!" })]);
		const err1 = await expectAnalyzeError(analyzeManifestFileV2(await writeWire(root, wire1), c.protocol), "UNSAFE_IDENTITY");
		assert.ok(!err1.message.includes("bad model"), "the unsafe value must never be rendered");
		// Unsafe dev run thinking level.
		const wire2 = await readWire(root);
		await replaceSession(root, wire2, 0, [userMessage(), thinkingLevelChange("bad level!"), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]);
		const err2 = await expectAnalyzeError(analyzeManifestFileV2(await writeWire(root, wire2), c.protocol), "UNSAFE_IDENTITY");
		assert.ok(!err2.message.includes("bad level"));
		// Unsafe dev run tool name.
		const wire3 = await readWire(root);
		await replaceSession(root, wire3, 0, [
			userMessage(),
			thinkingLevelChange(),
			assistantMessage([toolCallItem("c1", "read", { path: "fixture/alpha.txt" })]),
			toolResultMessage("c1", "bad name!", markerLine(false)),
			assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
		]);
		const err3 = await expectAnalyzeError(analyzeManifestFileV2(await writeWire(root, wire3), c.protocol), "UNSAFE_IDENTITY");
		assert.ok(!err3.message.includes("bad name"));
		// Unsafe dev attempt model key (attempt declares the derived env_drift category).
		const wire4 = await readWire(root);
		await replaceAttempt(root, wire4, 0, [userMessage(), assistantMessage([{ type: "text", text: "x" }], { model: "bad model!" })]);
		(wire4.attempts as Record<string, unknown>[])[0]!.category = "env_drift";
		(wire4.attempts as Record<string, unknown>[])[0]!.prompt_sha256 = PROMPT_SHA256;
		const err4 = await expectAnalyzeError(analyzeManifestFileV2(await writeWire(root, wire4), c.protocol), "UNSAFE_IDENTITY");
		assert.ok(!err4.message.includes("bad model"));
	});
});

test("analyze v2: nested fixture symlinks/unsafe entries surface only the bounded fixture basename", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		// Nested symlink deep inside the fixture tree.
		await symlink(join(root, "fixture", "alpha.txt"), join(root, "fixture", "search", "evil-link.txt"));
		const wire = await readWire(root);
		const manifestPath = await writeWire(root, wire);
		const err = await expectAnalyzeError(analyzeManifestFileV2(manifestPath, c.protocol), "FIXTURE_UNSAFE");
		assert.ok(err.message.includes("fixture"), "message keeps the bounded fixture-directory basename");
		assert.ok(!err.message.includes("evil"), "nested fixture entry names never leak");
		assert.ok(!err.message.includes("search"), "nested fixture paths never leak");
		// Over-bound fixture path stays a distinct OVER_BOUND code.
		await rm(join(root, "fixture", "search", "evil-link.txt"));
		const longSegments = Array.from({ length: 30 }, (_, i) => `s${String(i).padStart(3, "0")}${"x".repeat(17)}`);
		await mkdir(join(root, "fixture", ...longSegments), { recursive: true });
		await writeFile(join(root, "fixture", ...longSegments, "deep.txt"), "x\n", "utf8");
		const err2 = await expectAnalyzeError(analyzeManifestFileV2(manifestPath, c.protocol), "OVER_BOUND");
		assert.ok(err2.message.includes("fixture"));
	});
});

test("analyze v2: missing, non-regular and oversized declared inputs fail closed", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		const sessionPath = join(root, "sessions", "control-01.json");
		// Missing session file.
		await rm(sessionPath, { recursive: true });
		const wire1 = await readWire(root);
		const err1 = await expectAnalyzeError(analyzeManifestFileV2(await writeWire(root, wire1), c.protocol), "FILE_MISSING");
		assert.ok(err1.message.includes("control-01.json"), "basename-only message");
		// Non-regular declared input (a directory where the session file must be).
		await mkdir(sessionPath);
		const wire2 = await readWire(root);
		const err2 = await expectAnalyzeError(analyzeManifestFileV2(await writeWire(root, wire2), c.protocol), "FILE_MISSING");
		assert.ok(err2.message.includes("not a regular file"));
		// Oversized declared input.
		await rm(sessionPath, { recursive: true });
		await writeFile(sessionPath, Buffer.alloc(SESSION_MAX_BYTES + 1));
		const wire3 = await readWire(root);
		const err3 = await expectAnalyzeError(analyzeManifestFileV2(await writeWire(root, wire3), c.protocol), "OVER_BOUND");
		assert.ok(err3.message.includes(String(SESSION_MAX_BYTES)));
	});
});

test("analyze v2: symlink escape and duplicate realpath fail closed", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		// Symlink escape: the declared session path resolves outside the manifest directory.
		await withTempDir(async (outside) => {
			const outsideFile = join(outside, "secret.txt");
			await writeFile(outsideFile, "outside content\n", "utf8");
			await rm(join(root, "sessions", "control-01.json"));
			await symlink(outsideFile, join(root, "sessions", "control-01.json"));
			const wire = await readWire(root);
			const err = await expectAnalyzeError(analyzeManifestFileV2(await writeWire(root, wire), c.protocol), "PATH_UNSAFE");
			assert.ok(!err.message.includes(outside), "absolute paths never leak");
		});
		// Duplicate realpath: two declared paths resolving to the same real file.
		await withTempDir(async (root2) => {
			const c2 = await buildCohortTree(root2, { phase: "dev", sessionCount: 2, attempts: 0 });
			await rm(join(root2, "sessions", "treatment-01.json"));
			await symlink(join(root2, "sessions", "control-01.json"), join(root2, "sessions", "treatment-01.json"));
			const wire = await readWire(root2);
			const err = await expectAnalyzeError(analyzeManifestFileV2(await writeWire(root2, wire), c2.protocol), "DUPLICATE_PATH");
			assert.ok(err.message.includes("duplicates"));
		});
	});
});

// ---------------------------------------------------------------------------
// C. Propagation (v1 validator / v2 core / v2 policy / strict pins)
// ---------------------------------------------------------------------------

test("analyze v2: malformed JSONL propagates the v1 validator failure", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		const wire = await readWire(root);
		await replaceSession(root, wire, 0, [{ type: "message", id: "broken" }]);
		await writeFile(join(root, "sessions", "control-01.json"), "this is not json\n", "utf8");
		(wire.sessions as Record<string, unknown>[])[0]!.expected_session_sha256 = sha256Hex("this is not json\n");
		const err = await expectNroError(analyzeManifestFileV2(await writeWire(root, wire), c.protocol), "MALFORMED_JSONL");
		assert.ok(err.message.includes("control-01"));
	});
});

test("analyze v2: final session prompt mismatch propagates the v2 core failure", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		const wire = await readWire(root);
		await replaceSession(root, wire, 0, validSessionEntries("A different prompt text that does not match the pinned milestone prompt."));
		const err = await expectNroV2Error(analyzeManifestFileV2(await writeWire(root, wire), c.protocol), "PROMPT_MISMATCH");
		assert.ok(err.message.includes("control-01"));
	});
});

test("analyze v2: v2 policy failures propagate unchanged", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		const wire = await readWire(root);
		// A present-but-malformed preview-facts marker fails closed in the frozen v2 policy.
		await replaceSession(root, wire, 0, [
			userMessage(),
			thinkingLevelChange(),
			assistantMessage([toolCallItem("c1", "read", { path: "fixture/alpha.txt" })]),
			toolResultMessage("c1", "read", "nro-read-facts: complete=maybe\n"),
			assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
		]);
		const err = await expectPolicyError(analyzeManifestFileV2(await writeWire(root, wire), c.protocol), "FACTS_MALFORMED");
		assert.ok(!err.message.includes("complete=maybe"), "policy messages never carry entry content");
	});
});

test("analyze v2: attempt category and prompt reproduction drift fail closed", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root, { phase: "dev", sessionCount: 2, attempts: 1 });
		// Category drift: the attempt derives "nonterminal" but is declared "errored".
		const wire1 = await readWire(root);
		await replaceAttempt(root, wire1, 0, attemptNonterminalEntries());
		const err1 = await expectAnalyzeError(analyzeManifestFileV2(await writeWire(root, wire1), c.protocol), "CATEGORY_MISMATCH");
		assert.ok(err1.message.includes("declared category"));
		// Prompt reproduction drift: declared prompt hash does not reproduce the derived (null) hash.
		const wire2 = await readWire(root);
		await replaceAttempt(root, wire2, 0, attemptNonterminalEntries());
		(wire2.attempts as Record<string, unknown>[])[0]!.category = "nonterminal";
		(wire2.attempts as Record<string, unknown>[])[0]!.prompt_sha256 = H64_OTHER;
		const err2 = await expectAnalyzeError(analyzeManifestFileV2(await writeWire(root, wire2), c.protocol), "CATEGORY_MISMATCH");
		assert.ok(err2.message.includes("prompt SHA-256"));
	});
});

test("analyze v2: a machine-valid final attempt fails closed (ATTEMPT_NOT_INVALID)", async () => {
	await withTempDir(async (root) => {
		const c = await buildCohortTree(root);
		const wire = await readWire(root);
		await replaceAttempt(root, wire, 0, attemptValidEntries());
		(wire.attempts as Record<string, unknown>[])[0]!.prompt_sha256 = PROMPT_SHA256;
		const err = await expectNroV2Error(analyzeManifestFileV2(await writeWire(root, wire), c.protocol), "ATTEMPT_NOT_INVALID");
		assert.ok(err.message.includes("attempt-1"));
	});
});

test("analyze v2: production frozen pins stay strict (pin drift fails PIN_MISMATCH, never PROTOCOL_NOT_FROZEN)", async () => {
	await withTempDir(async (root) => {
		// A minimal manifest whose milestone pin drifts from the frozen protocol pin.
		const wire = manifestWire([], [], "final", FROZEN_NRO_V2_PROTOCOL, H64, {
			milestone_prompt_sha256: H64_OTHER,
			non_treatment_sha256: FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256,
			rubric: { sha256: FROZEN_NRO_V2_PROTOCOL.rubricSha256, checks: V2_RUBRIC_CHECKS.map((c) => ({ id: c.id, pattern: c.pattern })) },
		});
		const manifestPath = join(root, "manifest.json");
		await writeFile(manifestPath, `${JSON.stringify(wire, null, 2)}\n`, "utf8");
		// CLI/library default: the frozen production protocol is used.
		const err = await expectNroV2Error(analyzeManifestFileV2(manifestPath), "PIN_MISMATCH");
		assert.ok(!err.message.includes("PROTOCOL_NOT_FROZEN"), "the production protocol is frozen — never an unresolved-pin failure");
		// A derived protocol with an unresolved pin does fail PROTOCOL_NOT_FROZEN.
		const unfrozen = { ...FROZEN_NRO_V2_PROTOCOL, milestonePromptSha256: null };
		await expectNroV2Error(analyzeManifestFileV2(manifestPath, unfrozen), "PROTOCOL_NOT_FROZEN");
	});
});

// ---------------------------------------------------------------------------
// D. Bounded rendering
// ---------------------------------------------------------------------------

function markerText(maxLines: number, maxBytes: number): string {
	return `... (output capped: ${maxLines} lines / ${maxBytes} bytes — deterministic bound)`;
}

test("applyCapsV2: exact newline-aware caps, deterministic marker, degenerate caller caps", () => {
	const lines = ["alpha", "beta", "gamma"];
	// Line cap: the last kept line is replaced by the explicit marker.
	assert.deepEqual(applyCapsV2(lines, 2, 1024), ["alpha", markerText(2, 1024)]);
	// Byte cap counts the "\n" separator bytes of join("\n") exactly.
	const byteCapped = applyCapsV2(lines, 100, 12);
	const joined = byteCapped.join("\n");
	assert.ok(byteCapped.length <= 100);
	assert.ok(utf8Bytes(joined) <= 12);
	// Determinism: identical inputs produce byte-identical outputs.
	assert.deepEqual(applyCapsV2(lines, 2, 1024), applyCapsV2(lines, 2, 1024));
	assert.deepEqual(applyCapsV2(lines, 100, 12), applyCapsV2(lines, 100, 12));
	// Untruncated inputs pass through unchanged (no marker).
	assert.deepEqual(applyCapsV2(lines, 100, 1024), lines);
	// Degenerate caller caps fail closed to the empty output.
	assert.deepEqual(applyCapsV2(lines, 0, 1024), []);
	assert.deepEqual(applyCapsV2(lines, -3, 1024), []);
	assert.deepEqual(applyCapsV2(lines, Number.NaN, 1024), []);
	assert.deepEqual(applyCapsV2(lines, Number.POSITIVE_INFINITY, 0), []);
	assert.deepEqual(applyCapsV2(lines, 2, Number.NaN), []);
	// A single oversized first line: truncated prefix + marker when both fit.
	const big = ["x".repeat(1000)];
	const prefixed = applyCapsV2(big, 2, 100);
	assert.equal(prefixed.length, 2);
	assert.ok(prefixed[0] && prefixed[0].length < 1000);
	assert.ok(prefixed[1]?.includes("output capped"));
	assert.ok(utf8Bytes(prefixed.join("\n")) <= 100);
	// Caps that cannot hold the full marker: the marker is byte-truncated and still marks.
	const tiny = applyCapsV2(big, 1, 8);
	assert.equal(tiny.length, 1);
	assert.ok(utf8Bytes(tiny.join("\n")) <= 8);
	assert.ok((tiny[0] ?? "").startsWith("..."));
	// Positive caps always keep a marked, bounded result.
	const lone = applyCapsV2(["z".repeat(5000)], 1, 64);
	assert.equal(lone.length, 1);
	assert.ok((lone[0] ?? "").includes("output capped"));
	assert.ok(utf8Bytes(lone.join("\n")) <= 64);
});

test("applyCapsV2: multi-line removal keeps every truncated positive-cap output marked (one-line replacement cannot fit)", () => {
	// Two medium retained lines plus an overflowing third where the marker
	// cannot replace ONLY the last line within the byte budget: one-line
	// replacement cannot fit, so both retained lines must be removed. The
	// result is the explicit marker — never an unmarked prefix.
	const lines = ["m".repeat(30), "n".repeat(30), "x".repeat(200)];
	const out = applyCapsV2(lines, 3, 90);
	const joined = out.join("\n");
	assert.ok(out.length >= 1, "a truncated positive-cap output is never empty");
	assert.ok(out.length <= 3, "maxLines bound holds");
	assert.ok(utf8Bytes(joined) <= 90, "exact UTF-8 maxBytes bound on join(\"\\n\") holds");
	assert.ok(joined.includes("output capped"), "no unmarked truncation remains — the marker is always present");
	assert.deepEqual(out, applyCapsV2(lines, 3, 90), "deterministic");
	// Regression-shape proof: the marker plus a single retained line
	// exceeds the cap, so one-line replacement cannot fit — multi-line
	// removal is required.
	assert.ok(utf8Bytes("m".repeat(30)) + utf8Bytes(markerText(3, 90)) > 90, "one-line replacement cannot fit");
	assert.ok(utf8Bytes(markerText(3, 90)) <= 90, "the marker alone always fits within positive caps");
	// A second case: three retained lines and an overflowing fourth — two
	// trailing lines are removed so the first line + marker fit exactly.
	const more = ["m".repeat(30), "n".repeat(30), "o".repeat(30), "x".repeat(200)];
	const out2 = applyCapsV2(more, 4, 100);
	assert.deepEqual(out2, ["m".repeat(30), markerText(4, 100)], "trailing retained lines are removed until the marker fits");
	assert.ok(out2.length <= 4);
	assert.ok(utf8Bytes(out2.join("\n")) <= 100);
	// Property sweep: every truncated positive-cap output carries the marker.
	for (const [ml, mb, input] of [
		[3, 90, lines],
		[4, 100, more],
		[5, 40, ["a".repeat(10), "b".repeat(10), "c".repeat(10), "d".repeat(10), "e".repeat(100)]],
		[2, 20, ["a".repeat(15), "b".repeat(15)]],
	] as Array<[number, number, string[]]>) {
		const result = applyCapsV2(input, ml, mb);
		const text = result.join("\n");
		assert.ok(result.length <= ml);
		assert.ok(utf8Bytes(text) <= mb);
		const truncated = text !== input.join("\n");
		if (truncated) assert.ok(text.includes("output capped"), `truncated output must be marked (${ml}/${mb})`);
	}
});

test("renderReportV2: the big dev fixture rendering respects the 240-line / 64 KiB caps with a marker", async () => {
	await withTempDir(async (root) => {
		// 99 + 99 dev sessions (the two-digit label space) produce a rendering
		// far beyond the 64 KiB production cap — truncation must be marked.
		const c = await buildCohortTree(root, { phase: "dev", sessionCount: 198, attempts: 0 });
		const report = await analyzeManifestFileV2(c.manifestPath, c.protocol);
		assert.equal(report.runs.length, 198);
		const lines = renderReportV2(report);
		const joined = lines.join("\n");
		assert.ok(lines.length <= HUMAN_MAX_LINES, "line cap respected");
		assert.ok(utf8Bytes(joined) <= HUMAN_MAX_BYTES, "64 KiB byte cap respected");
		assert.ok(joined.includes("output capped"), "the big rendering carries the explicit cap marker");
		const last = lines[lines.length - 1];
		assert.ok(last && last.includes("output capped"), "the marker terminates the capped rendering");
		assert.deepEqual(lines, renderReportV2(report), "rendering stays deterministic");
	});
});

// ---------------------------------------------------------------------------
// E. CLI and bounded error rendering
// ---------------------------------------------------------------------------

test("mainV2: library dispatch returns 2 for usage errors and 0 for help", async () => {
	assert.equal(await mainV2(["--help"]), 0);
	assert.equal(await mainV2(["-h"]), 0);
	assert.equal(await mainV2([]), 2);
	assert.equal(await mainV2(["analyze"]), 2);
	assert.equal(await mainV2(["bogus"]), 2);
});

const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const SCRIPT = join(process.cwd(), "scripts", "commander-native-tool-benchmark-v2-analyze.ts");
const INPUTS = join(process.cwd(), INPUTS_DIR);

test("CLI: analyze success exits 0 against the frozen production pins — human default and deterministic pretty JSON + LF", async () => {
	await withTempDir(async (root) => {
		// Byte-copy the frozen production fixture tree so the frozen fixture
		// manifest pin reproduces exactly; the frozen protocol is used by the
		// CLI unconditionally.
		await cp(join(INPUTS, FIXTURE_DIR_NAME), join(root, "fixture"), { recursive: true });
		const promptText = await readFile(join(INPUTS, MILESTONE_PROMPT_NAME), "utf8");
		await mkdir(join(root, "sessions"), { recursive: true });
		const sessions: Record<string, unknown>[] = [];
		const perArm = { control: 0, treatment: 0 };
		for (let i = 1; i <= TOTAL_VALID_RUNS; i += 1) {
			const arm = abbaArmAtV2(i);
			perArm[arm] += 1;
			const label = sessionLabelV2(arm, perArm[arm]);
			const content = jsonl(validSessionEntries(promptText));
			await writeFile(join(root, "sessions", `${label}.json`), content, "utf8");
			sessions.push({ label, arm, order_index: i, path: `sessions/${label}.json`, expected_session_sha256: sha256Hex(content) });
		}
		await mkdir(join(root, "attempts"), { recursive: true });
		const attempts: Record<string, unknown>[] = [];
		const errored = jsonl(attemptErroredEntries(promptText));
		await writeFile(join(root, "attempts", "attempt-01.json"), errored, "utf8");
		attempts.push(attemptWire("attempt-1", "attempts/attempt-01.json", "errored", sha256Hex(promptText), sha256Hex(errored)));
		const nonterminal = jsonl(attemptNonterminalEntries());
		await writeFile(join(root, "attempts", "attempt-02.json"), nonterminal, "utf8");
		attempts.push(attemptWire("attempt-2", "attempts/attempt-02.json", "nonterminal", null, sha256Hex(nonterminal)));
		const wire = {
			schema_version: BENCHMARK_SCHEMA_VERSION,
			protocol_version: PROTOCOL_VERSION,
			protocol_doc: PROTOCOL_DOC,
			phase: "final",
			milestone_prompt_sha256: FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256,
			environment: environmentWire(),
			fixture: { path: "fixture", manifest_sha256: FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256 },
			non_treatment_sha256: FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256,
			rubric: { sha256: FROZEN_NRO_V2_PROTOCOL.rubricSha256, checks: V2_RUBRIC_CHECKS.map((c) => ({ id: c.id, pattern: c.pattern })) },
			sessions,
			attempts,
		};
		const manifestPath = join(root, "manifest.json");
		await writeFile(manifestPath, `${JSON.stringify(wire, null, 2)}\n`, "utf8");

		const human = await spawnExec(TSX, [SCRIPT, "analyze", manifestPath], { timeout: 120000 });
		assert.equal(human.code, 0, human.stderr);
		assert.ok(human.stdout.includes("commander native tool benchmark v2"), "human rendering header");
		assert.ok(human.stdout.includes("privacy :"), "privacy statement present");
		assert.ok(human.stdout.endsWith("\n"));

		const json = await spawnExec(TSX, [SCRIPT, "analyze", manifestPath, "--json"], { timeout: 120000 });
		assert.equal(json.code, 0, json.stderr);
		assert.ok(json.stdout.endsWith("\n"), "deterministic pretty JSON + terminal LF");
		const report = JSON.parse(json.stdout) as {
			schemaVersion: number;
			protocolVersion: number;
			runs: unknown[];
			attempts: unknown[];
			arms: { control: { runCount: number }; treatment: { runCount: number } };
			verdicts: Array<{ status: string }>;
			manifest: { phase: string; fixture: { verified: boolean; files: number } };
		};
		assert.equal(report.schemaVersion, BENCHMARK_SCHEMA_VERSION);
		assert.equal(report.protocolVersion, PROTOCOL_VERSION);
		assert.equal(report.manifest.phase, "final");
		assert.equal(report.runs.length, TOTAL_VALID_RUNS);
		assert.equal(report.attempts.length, 2);
		assert.equal(report.arms.control.runCount, 20);
		assert.equal(report.arms.treatment.runCount, 20);
		assert.equal(report.verdicts.length, 4);
		assert.equal(report.manifest.fixture.verified, true, "the copied production fixture tree reproduces the frozen pin");
		assert.ok(report.manifest.fixture.files >= 10);
	});
});

test("CLI: fail-closed analysis error exits 1 with stderr only, no partial stdout, privacy-safe", async () => {
	await withTempDir(async (root) => {
		// The CLI always uses FROZEN_NRO_V2_PROTOCOL: byte-copy the frozen
		// production fixture tree so the frozen fixture pin reproduces, then
		// fail the declared session hash. Secret-bearing session content must
		// never reach stderr.
		await cp(join(INPUTS, FIXTURE_DIR_NAME), join(root, "fixture"), { recursive: true });
		const promptText = await readFile(join(INPUTS, MILESTONE_PROMPT_NAME), "utf8");
		await mkdir(join(root, "sessions"), { recursive: true });
		const content = jsonl(secretSessionEntries(promptText));
		await writeFile(join(root, "sessions", "control-01.json"), content, "utf8");
		const wire = {
			schema_version: BENCHMARK_SCHEMA_VERSION,
			protocol_version: PROTOCOL_VERSION,
			protocol_doc: PROTOCOL_DOC,
			phase: "dev",
			milestone_prompt_sha256: FROZEN_NRO_V2_PROTOCOL.milestonePromptSha256,
			environment: environmentWire(),
			fixture: { path: "fixture", manifest_sha256: FROZEN_NRO_V2_PROTOCOL.fixtureManifestSha256 },
			non_treatment_sha256: FROZEN_NRO_V2_PROTOCOL.nonTreatmentSha256,
			rubric: { sha256: FROZEN_NRO_V2_PROTOCOL.rubricSha256, checks: V2_RUBRIC_CHECKS.map((c) => ({ id: c.id, pattern: c.pattern })) },
			sessions: [{ label: "control-01", arm: "control", order_index: 1, path: "sessions/control-01.json", expected_session_sha256: H64_OTHER }],
			attempts: [],
		};
		const manifestPath = join(root, "manifest.json");
		await writeFile(manifestPath, `${JSON.stringify(wire, null, 2)}\n`, "utf8");
		const res = await spawnExec(TSX, [SCRIPT, "analyze", manifestPath], { timeout: 120000 });
		assert.equal(res.code, 1);
		assert.equal(res.stdout, "", "no partial stdout on failure");
		assert.ok(res.stderr.includes("commander-native-tool-benchmark-v2 analyze:"));
		assert.ok(res.stderr.includes("HASH_MISMATCH"), res.stderr);
		assert.ok(!res.stderr.includes(root), "absolute temp paths never leak");
		assert.ok(!res.stderr.includes(SECRET_BODY), "secret tool-result body never leaks");
		assert.ok(!res.stderr.includes(SECRET_PATH), "secret read path never leaks");
	});
});

test("CLI: usage errors exit 2 on stderr only; --help/-h exit 0 on stdout", async () => {
	const noArgs = await spawnExec(TSX, [SCRIPT], { timeout: 120000 });
	assert.equal(noArgs.code, 2);
	assert.equal(noArgs.stdout, "");
	assert.ok(noArgs.stderr.includes("usage:"));
	assert.ok(noArgs.stderr.includes("exit codes"));

	const analyzeNoManifest = await spawnExec(TSX, [SCRIPT, "analyze"], { timeout: 120000 });
	assert.equal(analyzeNoManifest.code, 2);
	assert.equal(analyzeNoManifest.stdout, "");
	assert.ok(analyzeNoManifest.stderr.includes("usage:"));

	const help = await spawnExec(TSX, [SCRIPT, "--help"], { timeout: 120000 });
	assert.equal(help.code, 0);
	assert.equal(help.stderr, "");
	assert.ok(help.stdout.includes("usage:"));
	assert.ok(help.stdout.includes("exit codes"));

	const shortHelp = await spawnExec(TSX, [SCRIPT, "-h"], { timeout: 120000 });
	assert.equal(shortHelp.code, 0);
	assert.equal(shortHelp.stderr, "");
	assert.ok(shortHelp.stdout.includes("usage:"));
});

const GENERIC_WITHHELD = "ANALYZE_ERROR: unexpected failure (details withheld — see privacy boundary)";

test("renderCliErrorV2: codes allowlisted bounded uppercase; messages control-sanitized and UTF-8 capped", () => {
	// A genuine NroV2AnalyzeError renders its allowlisted code and a
	// control-sanitized message.
	const sanitized = renderCliErrorV2(new NroV2AnalyzeError("IO_ERROR", "line1\x00\x1bline2"));
	assert.ok(sanitized.startsWith("IO_ERROR: "));
	assert.ok(!/[\x00-\x1f\x7f]/.test(sanitized), "control characters are replaced");
	assert.ok(sanitized.includes("line1  line2"));
	// The trusted internal error families (v2 core, v2 policy, v1 core)
	// render their sanitized bounded messages too.
	assert.ok(renderCliErrorV2(new NroV2Error("PIN_MISMATCH", "pin drift")).startsWith("PIN_MISMATCH: "));
	assert.ok(renderCliErrorV2(new V2PolicyError("FACTS_MALFORMED", "bad facts")).startsWith("FACTS_MALFORMED: "));
	assert.ok(renderCliErrorV2(new NroError("MALFORMED_JSONL", "bad jsonl")).startsWith("MALFORMED_JSONL: "));
	// Messages are UTF-8 capped with an explicit ellipsis marker.
	const long = renderCliErrorV2(new NroV2AnalyzeError("IO_ERROR", "x".repeat(2000)));
	assert.equal(utf8Bytes(long), "IO_ERROR: ".length + 512);
	assert.ok(long.endsWith("…"));
	// Non-Error throwables collapse to the fixed generic form.
	assert.equal(renderCliErrorV2("boom"), GENERIC_WITHHELD);
	assert.equal(renderCliErrorV2(42), GENERIC_WITHHELD);
	assert.equal(renderCliErrorV2(undefined), GENERIC_WITHHELD);
	assert.equal(renderCliErrorV2(null), GENERIC_WITHHELD);
});

test("renderCliErrorV2: forged safe-looking codes and unsafe codes never leak secrets; genuine errors still render sanitized bounded details", () => {
	const SECRET = "NROPRIVATE-APIKEY-7f3d";
	// A plain/arbitrary Error that forges the safe-looking adapter code is
	// withheld entirely — the exact generic string, no secret, no message.
	const forged = new Error(`read failed with secret ${SECRET}`);
	(forged as { code?: unknown }).code = "IO_ERROR";
	const forgedOut = renderCliErrorV2(forged);
	assert.equal(forgedOut, GENERIC_WITHHELD);
	assert.ok(!forgedOut.includes(SECRET), "forged-code Error details are withheld");
	assert.ok(!forgedOut.includes("read failed"));
	// Any unsafe code (shape/length) on any Error is withheld too.
	const lower = new Error(`secret ${SECRET}`);
	(lower as { code?: unknown }).code = "i_o_error";
	assert.equal(renderCliErrorV2(lower), GENERIC_WITHHELD);
	const nonString = new Error(`secret ${SECRET}`);
	(nonString as { code?: unknown }).code = 42;
	assert.equal(renderCliErrorV2(nonString), GENERIC_WITHHELD);
	const overlong = new Error(`secret ${SECRET}`);
	(overlong as { code?: unknown }).code = "A".repeat(100);
	assert.equal(renderCliErrorV2(overlong), GENERIC_WITHHELD);
	const control = new Error(`secret ${SECRET}`);
	(control as { code?: unknown }).code = "BAD CODE!";
	assert.equal(renderCliErrorV2(control), GENERIC_WITHHELD);
	// A genuine structured error whose code was corrupted is withheld as well.
	const corrupted = new NroV2AnalyzeError("IO_ERROR", `secret ${SECRET}`);
	(corrupted as { code: string }).code = "lower_case";
	assert.equal(renderCliErrorV2(corrupted), GENERIC_WITHHELD);
	// While a genuine NroV2AnalyzeError still renders sanitized bounded details.
	const genuine = renderCliErrorV2(new NroV2AnalyzeError("IO_ERROR", `failed on value ${SECRET}`));
	assert.ok(genuine.startsWith("IO_ERROR: "));
	assert.ok(genuine.includes("failed on value"));
	assert.ok(utf8Bytes(genuine) <= "IO_ERROR: ".length + 512, "bounded rendering");
	assert.ok(!/[\x00-\x1f\x7f]/.test(genuine), "sanitized rendering");
});

test("CLI: unknown options and unknown subcommands are bounded and control-safe on stderr", async () => {
	const unknown = await spawnExec(TSX, [SCRIPT, "analyze", "manifest.json", "--bogus"], { timeout: 120000 });
	assert.equal(unknown.code, 2);
	assert.equal(unknown.stdout, "");
	assert.ok(unknown.stderr.includes("unknown option(s): --bogus"), unknown.stderr);
	assert.ok(unknown.stderr.includes("usage:"));
	assert.ok(utf8Bytes(unknown.stderr) <= 4096, "unknown-option stderr stays bounded");

	// Many unknown options: the rendered list is item-capped with an explicit overflow note.
	const many = Array.from({ length: 20 }, (_, i) => `--opt-${i}`);
	const manyRes = await spawnExec(TSX, [SCRIPT, "analyze", "manifest.json", ...many], { timeout: 120000 });
	assert.equal(manyRes.code, 2);
	assert.ok(manyRes.stderr.includes("(+12 more)"), manyRes.stderr);
	assert.ok(utf8Bytes(manyRes.stderr) <= 4096);

	// Control characters in options are sanitized before stderr.
	const control = await spawnExec(TSX, [SCRIPT, "analyze", "manifest.json", "--bad\toption"], { timeout: 120000 });
	assert.equal(control.code, 2);
	// Newlines are legitimate line separators; every OTHER control
	// character (the option's tab included) must be sanitized away.
	assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(control.stderr), "no control characters in unknown-option stderr");
	assert.ok(!control.stderr.includes("\t"), "the option's tab is replaced, never echoed");
	assert.ok(control.stderr.includes("--bad option"), "control characters are replaced, not dropped");

	// Unknown subcommands are bounded and control-safe on stderr.
	const sub = await spawnExec(TSX, [SCRIPT, "nope"], { timeout: 120000 });
	assert.equal(sub.code, 2);
	assert.equal(sub.stdout, "");
	assert.ok(sub.stderr.includes('unknown subcommand "nope"'), sub.stderr);
	assert.ok(sub.stderr.includes("usage:"));
	assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(sub.stderr));
	assert.ok(utf8Bytes(sub.stderr) <= 4096);
});

test("static guard: analyzer reuses only the allowlisted v1 primitives and the v2 core; read-only", async () => {
	const source = await readFile(join(process.cwd(), "scripts", "commander-native-tool-benchmark-v2-analyze.ts"), "utf8");
	// The v1 import surface is exactly the allowlisted primitive set.
	const v1Marker = 'from "./commander-native-tool-benchmark.ts";';
	const v1Block = source.slice(source.indexOf(v1Marker) - 400, source.indexOf(v1Marker));
	for (const allowed of ["fixtureManifestHash", "parseSessionLines", "resolveSessionPath", "sha256Hex", "HUMAN_MAX_BYTES", "HUMAN_MAX_LINES", "MANIFEST_MAX_BYTES", "SESSION_MAX_BYTES"]) {
		assert.ok(v1Block.includes(allowed), `v1 primitive ${allowed} is allowlisted`);
	}
	for (const banned of ["parseManifest", "buildReport", "analyzeManifestFile", "computeRunFacts", "deriveAttemptFacts", "applyCaps", "renderReport", "prepareEvidence", "preflightInputs", "preflightCollection"]) {
		assert.ok(!v1Block.includes(banned), `v1 implementation ${banned} is never imported`);
	}
	// The v2 core import surface is the v2 derivation/aggregation surface.
	const v2Marker = 'from "./commander-native-tool-benchmark-v2.ts";';
	const v2Block = source.slice(source.indexOf(v2Marker) - 500, source.indexOf(v2Marker));
	for (const name of ["parseManifestV2", "computeRunFactsV2", "deriveAttemptFactsV2", "buildArmFactsV2", "computeVerdictsFromRunsV2"]) {
		assert.ok(v2Block.includes(name), `v2 core function ${name} is imported`);
	}
	// The frozen v2 protocol module is imported for the pins/constants.
	const protocolMarker = 'from "./commander-native-tool-benchmark-v2-protocol.ts";';
	const protocolBlock = source.slice(source.indexOf(protocolMarker) - 400, source.indexOf(protocolMarker));
	for (const name of ["FROZEN_NRO_V2_PROTOCOL", "PROTOCOL_DOC", "PROTOCOL_VERSION", "BENCHMARK_SCHEMA_VERSION", "ARMS"]) {
		assert.ok(protocolBlock.includes(name), `protocol constant ${name} is imported`);
	}
	// Only node builtins and the three local modules are imported.
	const imports = [...source.matchAll(/^import .*? from "([^"]+)";/gm)].map((m) => m[1] ?? "");
	for (const mod of imports) {
		assert.ok(
			mod.startsWith("node:") || mod === "./commander-native-tool-benchmark.ts" || mod === "./commander-native-tool-benchmark-v2.ts" || mod === "./commander-native-tool-benchmark-v2-protocol.ts",
			`unexpected import "${mod}"`,
		);
	}
	// Read-only: no write APIs, no process spawning, no network.
	for (const banned of ["writeFile", "appendFile", "mkdir", "rm(", "unlink", "rename", "copyFile", "createWriteStream", "child_process", "spawn(", "fetch("]) {
		assert.ok(!source.includes(banned), `write/spawn/network API ${banned} must never appear`);
	}
	// The only filesystem primitives are reads.
	assert.ok(source.includes('import { readFile, realpath, stat } from "node:fs/promises";'), "read-only fs imports");
});
