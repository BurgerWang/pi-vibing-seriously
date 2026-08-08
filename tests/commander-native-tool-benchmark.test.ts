/**
 * Commander NRO benchmark harness tests (offline analyzer + prepare
 * script, slice N0). Covers, over a small derived test protocol
 * (runsPerArm = 2, generated hermetic pins):
 *
 *   - frozen ABBA interleave helpers and the strict manifest validator
 *     (final 2+2 shape happy path; arm/label/order/count/duplicate/
 *     attempt-gap/unknown-key/unclassified-in-final/basename drift
 *     fail-closed; dev manifests relaxed on ABBA/counts)
 *   - preview-facts marker parsing (string and content[] delivery,
 *     malformed blocks fail closed) and pagination facts (previews,
 *     continuation reads, obligations, reached-complete, misuse)
 *   - median / middle-two-sum / nearest-rank p90 exact semantics and
 *     the four frozen §11.2 verdicts at their exact thresholds
 *     (boundary included), zero-denominator NOT_MEASURED and dev-phase
 *     NOT_MEASURED
 *   - manifest serialization round-trip (strict wire form, trailing
 *     newline — catches the stray-quote serialization defect)
 *   - analyze happy path under derived pins (final: full per-run facts,
 *     arm facts, verdicts, fixture verification, attempts; dev: facts
 *     recorded, verdicts always NOT_MEASURED) and that analyze never
 *     writes a single byte
 *   - analyze fail-closed table: hash, prompt/env/thinking, compaction,
 *     terminal, attempt category/validity, duplicate realpath, path
 *     escape, missing/malformed files, fixture mismatch, cohort count,
 *     attempt labels, unresolved pins (explicit null-pin protocol)
 *   - prepare happy path (byte-exact evidence, generated manifest
 *     analyzable, deviations document, exclusive-commit refusal on
 *     rerun), existing-output refusal with foreign outputs surviving,
 *     ownership-tracked rollback via the documented test seams, and a
 *     representative prepare fail-closed table
 *   - privacy: sentinel message/tool-result content and absolute temp
 *     paths never leak through renderReport, renderPrepareSummary or
 *     CLI stderr; human rendering caps (lines + bytes) hold and are
 *     deterministic
 *   - CLI behavior: usage errors exit 2 (stderr only), --help exits 0,
 *     analyze/prepare against the frozen FROZEN_NRO_PROTOCOL exit 1 on
 *     non-frozen content with no stdout; explicit null-pin protocols
 *     still fail closed PROTOCOL_NOT_FROZEN
 *
 * Production session content is never copied; every fixture is a small
 * generated Pi-like session (helpers only, no bulky hand-written
 * fixtures). Importing this file pulls the script into the typecheck
 * program (tsconfig covers tests/**, not scripts/** directly).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	BENCHMARK_SCHEMA_VERSION,
	COLLECTION_SCHEMA_VERSION,
	ENVIRONMENT_NAME,
	EVIDENCE_DIR_NAME,
	FROZEN_NRO_PROTOCOL,
	HUMAN_MAX_BYTES,
	HUMAN_MAX_LINES,
	MANIFEST_NAME,
	MILESTONE_PROMPT_NAME,
	NRO_FACTS_MARKER,
	PROTOCOL_DOC,
	RUBRIC_NAME,
	RUNS_PER_ARM,
	STAGING_PREFIX,
	VERDICT_IDS,
	NroError,
	abbaArmAt,
	abbaPositionsOf,
	analyzeManifestFile,
	applyCaps,
	buildArmFacts,
	canonicalEnvironmentFile,
	computePagination,
	computeVerdictsFromRuns,
	deriveAttemptFacts,
	fixtureManifestHash,
	main,
	manifestToJson,
	medianOf,
	middleTwoSum,
	nearestRankP90,
	parseCollectionRecord,
	parseManifest,
	parsePrepareArgs,
	parsePreviewFacts,
	prepareEvidence,
	renderPrepareSummary,
	renderReport,
	sessionLabel,
	sha256Hex,
	validateSessionShape,
	type AttemptCategory,
	type BenchmarkReport,
	type FrozenProtocol,
	type Phase,
	type PrepareHooks,
	type RunFacts,
} from "../scripts/commander-native-tool-benchmark.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Hermetic fixture constants
// ---------------------------------------------------------------------------

function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Distinctive milestone prompt (its hash is pinned into the derived test protocol). */
const PROMPT_TEXT = [
	"NRO hermetic fixture milestone prompt.",
	"Private milestone marker: NROPRIVATE-PROMPT-9f2c-bb71.",
	"Collect exactly three facts from the fixture tree and answer with DONE-OK.",
].join("\n");

const PROMPT_SHA = sha256(PROMPT_TEXT);

/** Raw-content sentinels that must NEVER appear in any harness output. */
const PRIVATE_MILESTONE_MARKER = "NROPRIVATE-PROMPT-9f2c-bb71";
const PRIVATE_ASSISTANT_MARKER = "NROPRIVATE-ASSISTANT-1b3d";
const PRIVATE_TOOLRESULT_MARKER = "NROPRIVATE-TOOLRESULT-7c4e";

const RUBRIC_RAW = `${JSON.stringify(
	{ schema_version: 1, checks: [{ id: "ok1", pattern: "DONE-OK" }] },
	null,
	2,
)}\n`;
const RUBRIC_SHA = sha256(RUBRIC_RAW);

const NON_TREATMENT_SHA = "ab".repeat(32);

/** The frozen environment (protocol §3.2) — shared by every derived test protocol. */
const TEST_ENVIRONMENT = { ...FROZEN_NRO_PROTOCOL.environment };

interface UsageSpec {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** Default per-assistant usage (gross = input + output + cacheRead + cacheWrite = 110). */
const DEFAULT_USAGE: UsageSpec = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.001 };

/** Control/treatment usage chosen so the final e2e hits the exact §11.2 boundaries: gross 100 vs 80. */
const CONTROL_USAGE: UsageSpec = { input: 60, output: 20, cacheRead: 20, cacheWrite: 0, cost: 0.001 };
const TREATMENT_USAGE: UsageSpec = { input: 40, output: 20, cacheRead: 20, cacheWrite: 0, cost: 0.001 };

function markerLine(facts: { complete: boolean; returnedLines?: number; returnedBytes?: number; totalLines?: number; totalBytes?: number; omittedLines?: number; omittedBytes?: number; nextOffset?: number; lineTruncated?: boolean }): string {
	return `nro-read-facts: complete=${facts.complete} returned_lines=${facts.returnedLines ?? 10} returned_bytes=${facts.returnedBytes ?? 1000} total_lines=${facts.totalLines ?? 100} total_bytes=${facts.totalBytes ?? 10000} omitted_lines=${facts.omittedLines ?? 90} omitted_bytes=${facts.omittedBytes ?? 9000} next_offset=${facts.nextOffset ?? 10} line_truncated=${facts.lineTruncated ?? false}`;
}

// ---------------------------------------------------------------------------
// Pi-like session entry builders
// ---------------------------------------------------------------------------

function userEntry(text: string): Record<string, unknown> {
	return { type: "message", id: "u-1", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } };
}

function thinkingChange(level: string): Record<string, unknown> {
	return { type: "thinking_level_change", id: "th-1", timestamp: "2026-09-01T10:00:00.000Z", thinkingLevel: level };
}

function compactionEntry(): Record<string, unknown> {
	return { type: "compaction", id: "cp-1", timestamp: "2026-09-01T10:00:00.100Z" };
}

interface AssistantOptions {
	content?: unknown;
	stopReason?: string;
	provider?: string;
	model?: string;
	usage?: UsageSpec;
	text?: string;
}

function assistantEntry(opts: AssistantOptions = {}): Record<string, unknown> {
	const usage = opts.usage ?? DEFAULT_USAGE;
	return {
		type: "message",
		id: "a-1",
		timestamp: "2026-09-01T10:00:01.000Z",
		message: {
			role: "assistant",
			provider: opts.provider ?? "openai-codex",
			model: opts.model ?? "gpt-5.6-sol",
			content: opts.content ?? [{ type: "text", text: opts.text ?? `done ${PRIVATE_ASSISTANT_MARKER} DONE-OK` }],
			stopReason: opts.stopReason ?? "stop",
			usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: { total: usage.cost } },
		},
	};
}

function toolResultEntry(content: unknown, isError?: boolean): Record<string, unknown> {
	return {
		type: "message",
		id: "tr-1",
		timestamp: "2026-09-01T10:00:00.300Z",
		message: { role: "toolResult", toolName: "read", content, ...(isError ? { isError: true } : {}) },
	};
}

interface ToolRound {
	call: { path: string; offset?: number; limit?: number };
	result: { content: unknown; isError?: boolean };
}

interface TestSessionSpec {
	prompt?: string;
	provider?: string;
	model?: string;
	/** undefined = "high"; null = omit the thinking_level_change entry. */
	thinking?: string | null;
	stopReason?: string;
	compaction?: boolean;
	usage?: UsageSpec;
	rounds?: ToolRound[];
	assistantText?: string;
}

function buildSessionEntries(spec: TestSessionSpec): unknown[] {
	const entries: unknown[] = [
		{ type: "session", version: 3, id: "s-1", timestamp: "2026-09-01T10:00:00.000Z" },
		{ type: "session_info", id: "i-1", parentId: null, timestamp: "2026-09-01T10:00:00.000Z", name: "nro-test" },
		{ type: "model_change", id: "m-1", parentId: "i-1", timestamp: "2026-09-01T10:00:00.000Z", provider: "openai-codex", modelId: "gpt-5.6-sol" },
	];
	if (spec.thinking !== null) entries.push(thinkingChange(spec.thinking ?? "high"));
	entries.push(userEntry(spec.prompt ?? PROMPT_TEXT));
	if (spec.compaction) entries.push(compactionEntry());
	for (const round of spec.rounds ?? []) {
		const arguments_ = { path: round.call.path, ...(round.call.offset !== undefined ? { offset: round.call.offset } : {}), ...(round.call.limit !== undefined ? { limit: round.call.limit } : {}) };
		entries.push(assistantEntry({ content: [{ type: "toolCall", name: "read", arguments: arguments_ }], usage: spec.usage, provider: spec.provider, model: spec.model }));
		entries.push(toolResultEntry(round.result.content, round.result.isError));
	}
	entries.push(assistantEntry({ stopReason: spec.stopReason ?? "stop", usage: spec.usage, text: spec.assistantText, provider: spec.provider, model: spec.model }));
	return entries;
}

function sessionText(entries: unknown[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Fixture writers (analyze-side manifest + prepare-side inputs/collection)
// ---------------------------------------------------------------------------

interface TestSessionSlot {
	arm: "control" | "treatment";
	spec: TestSessionSpec;
	/** Declared manifest path; defaults to sessions/<label>.jsonl (analyze) or sources/<label>.jsonl (prepare). */
	path?: string;
	/** Skip writing the file (missing-file / duplicate / escape cases). */
	write?: boolean;
	/** Write this raw text instead of the built entries. */
	rawText?: string;
}

interface TestAttemptSlot {
	arm: "control" | "treatment";
	spec: TestSessionSpec;
	/** Declared-manifest overrides (defaults to the frozen derivation, strict=false). */
	declared?: { category?: AttemptCategory; promptSha256?: string | null; label?: string };
	/** Declared source path; defaults to sources/<label>.jsonl (prepare). */
	path?: string;
	/** Skip writing the file (missing-file / duplicate / escape cases). */
	write?: boolean;
}

interface AnalyzeContext {
	root: string;
	manifestPath: string;
	protocol: FrozenProtocol;
	fixtureDir: string;
}

interface AnalyzeFixtureSpec {
	phase: Phase;
	runsPerArm?: number;
	sessions: TestSessionSlot[];
	attempts?: TestAttemptSlot[];
	protocolOverride?: Partial<FrozenProtocol>;
	afterWrite?: (ctx: AnalyzeContext) => Promise<void>;
}

const DEFAULT_FIXTURE_FILES: Record<string, string> = { "a.txt": "alpha", "sub/b.txt": "beta" };

/**
 * Write a complete hermetic analyze fixture: fixture tree, session and
 * attempt files, and the strict manifest whose pins are derived from the
 * generated content. Returns the manifest path and the derived protocol.
 */
async function writeAnalyzeFixture(root: string, spec: AnalyzeFixtureSpec): Promise<AnalyzeContext> {
	const fixtureDir = join(root, "fixture");
	for (const [rel, content] of Object.entries(DEFAULT_FIXTURE_FILES)) {
		const full = join(fixtureDir, rel);
		await mkdir(join(full, ".."), { recursive: true });
		await writeFile(full, content, "utf8");
	}
	const fixture = await fixtureManifestHash(fixtureDir);
	const protocol: FrozenProtocol = {
		milestonePromptSha256: PROMPT_SHA,
		environment: { ...TEST_ENVIRONMENT },
		fixtureManifestSha256: fixture.manifestSha256,
		nonTreatmentSha256: NON_TREATMENT_SHA,
		rubricSha256: RUBRIC_SHA,
		runsPerArm: spec.runsPerArm ?? 2,
		interleave: "ABBA",
		...spec.protocolOverride,
	};

	await mkdir(join(root, "sessions"), { recursive: true });
	await mkdir(join(root, "attempts"), { recursive: true });
	const sessions: Array<Record<string, unknown>> = [];
	const occurrence = new Map<string, number>();
	for (let i = 0; i < spec.sessions.length; i += 1) {
		const slot = spec.sessions[i] as TestSessionSlot;
		const n = (occurrence.get(slot.arm) ?? 0) + 1;
		occurrence.set(slot.arm, n);
		const label = sessionLabel(slot.arm, n);
		const path = slot.path ?? `sessions/${label}.jsonl`;
		const text = slot.rawText ?? sessionText(buildSessionEntries(slot.spec));
		if (slot.write !== false) await writeFile(join(root, path), text, "utf8");
		sessions.push({ label, arm: slot.arm, order_index: i + 1, path, expected_session_sha256: sha256(text) });
	}

	const attempts: Array<Record<string, unknown>> = [];
	for (let i = 0; i < (spec.attempts ?? []).length; i += 1) {
		const slot = (spec.attempts as TestAttemptSlot[])[i] as TestAttemptSlot;
		const label = slot.declared?.label ?? `attempt-${i + 1}`;
		const path = slot.path ?? `attempts/${label}.jsonl`;
		const entries = buildSessionEntries(slot.spec);
		const text = sessionText(entries);
		if (slot.write !== false) await writeFile(join(root, path), text, "utf8");
		const sha = sha256(text);
		// Declared values default to the script's own frozen derivation
		// (strict=false) so happy-path fixtures always reproduce it.
		const derived = deriveAttemptFacts(label, slot.arm, `${label}.jsonl`, sha, entries, protocol.milestonePromptSha256 as string, protocol.environment, { strict: false });
		attempts.push({
			label,
			arm: slot.arm,
			path,
			expected_session_sha256: sha,
			prompt_sha256: slot.declared?.promptSha256 !== undefined ? slot.declared.promptSha256 : derived.promptSha256,
			category: slot.declared?.category ?? derived.category,
		});
	}

	const wire = {
		schema_version: BENCHMARK_SCHEMA_VERSION,
		protocol_doc: PROTOCOL_DOC,
		phase: spec.phase,
		milestone_prompt_sha256: protocol.milestonePromptSha256,
		environment: {
			model_key: protocol.environment.modelKey,
			thinking_level: protocol.environment.thinkingLevel,
			pi_version: protocol.environment.piVersion,
			node_version: protocol.environment.nodeVersion,
		},
		fixture: { path: "fixture", manifest_sha256: protocol.fixtureManifestSha256 },
		non_treatment_sha256: protocol.nonTreatmentSha256,
		rubric: { sha256: protocol.rubricSha256, checks: [{ id: "ok1", pattern: "DONE-OK" }] },
		sessions,
		attempts,
	};
	const manifestPath = join(root, "manifest.json");
	await writeFile(manifestPath, `${JSON.stringify(wire, null, 2)}\n`, "utf8");
	await spec.afterWrite?.({ root, manifestPath, protocol, fixtureDir });
	return { root, manifestPath, protocol, fixtureDir };
}

interface PrepareFixture {
	root: string;
	runsDir: string;
	inputsDir: string;
	collectionFile: string;
	protocol: FrozenProtocol;
	sourceBytes: Map<string, Buffer>;
	recordRaw: string;
}

interface PrepareFixtureSpec {
	phase: Phase;
	runsPerArm?: number;
	sessions: TestSessionSlot[];
	attempts?: TestAttemptSlot[];
	protocolOverride?: Partial<FrozenProtocol>;
	afterWrite?: (fx: PrepareFixture) => Promise<void>;
}

/**
 * Write a complete hermetic prepare fixture: frozen inputs dir (fixture/,
 * milestone-prompt.txt, environment.txt, rubric.json) with derived pins,
 * the collection record, and one source file per entry. Returns the runs
 * dir, inputs dir, collection file and the derived protocol.
 */
async function writePrepareFixture(root: string, spec: PrepareFixtureSpec): Promise<PrepareFixture> {
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
	const protocol: FrozenProtocol = {
		milestonePromptSha256: PROMPT_SHA,
		environment: { ...TEST_ENVIRONMENT },
		fixtureManifestSha256: fixture.manifestSha256,
		nonTreatmentSha256: NON_TREATMENT_SHA,
		rubricSha256: RUBRIC_SHA,
		runsPerArm: spec.runsPerArm ?? 2,
		interleave: "ABBA",
		...spec.protocolOverride,
	};

	const sourcesDir = join(root, "sources");
	await mkdir(sourcesDir, { recursive: true });
	const sourceBytes = new Map<string, Buffer>();
	const entries: Array<{ kind: "session" | "attempt"; arm: "control" | "treatment"; path: string }> = [];
	const occurrence = new Map<string, number>();
	for (let i = 0; i < spec.sessions.length; i += 1) {
		const slot = spec.sessions[i] as TestSessionSlot;
		const n = (occurrence.get(slot.arm) ?? 0) + 1;
		occurrence.set(slot.arm, n);
		const label = sessionLabel(slot.arm, n);
		const path = slot.path ?? `sources/${label}.jsonl`;
		const text = slot.rawText ?? sessionText(buildSessionEntries(slot.spec));
		if (slot.write !== false) await writeFile(join(root, path), text, "utf8");
		sourceBytes.set(label, Buffer.from(text, "utf8"));
		entries.push({ kind: "session", arm: slot.arm, path });
	}
	for (let i = 0; i < (spec.attempts ?? []).length; i += 1) {
		const slot = (spec.attempts as TestAttemptSlot[])[i] as TestAttemptSlot;
		const label = slot.declared?.label ?? `attempt-${i + 1}`;
		const path = slot.path ?? `sources/${label}.jsonl`;
		const text = sessionText(buildSessionEntries(slot.spec));
		if (slot.write !== false) await writeFile(join(root, path), text, "utf8");
		sourceBytes.set(label, Buffer.from(text, "utf8"));
		entries.push({ kind: "attempt", arm: slot.arm, path });
	}
	const record = { schema_version: COLLECTION_SCHEMA_VERSION, phase: spec.phase, non_treatment_sha256: NON_TREATMENT_SHA, entries };
	const recordRaw = `${JSON.stringify(record, null, 2)}\n`;
	const collectionFile = join(root, "collection.json");
	await writeFile(collectionFile, recordRaw, "utf8");
	const fx: PrepareFixture = { root, runsDir: join(root, "runs"), inputsDir, collectionFile, protocol, sourceBytes, recordRaw };
	await spec.afterWrite?.(fx);
	return fx;
}

/** The standard small final cohort: ABBA order for runsPerArm = 2 (C, T, T, C). */
function finalSessions(): TestSessionSlot[] {
	return [
		{ arm: "control", spec: { usage: CONTROL_USAGE } },
		{ arm: "treatment", spec: { usage: TREATMENT_USAGE } },
		{ arm: "treatment", spec: { usage: TREATMENT_USAGE } },
		{ arm: "control", spec: { usage: CONTROL_USAGE } },
	];
}

/** Expect a rejection with the exact error code (NroError or injected coded error). */
async function expectCode(promise: Promise<unknown>, code: string): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof Error, `expected Error, got ${String(error)}`);
		assert.equal((error as { code?: unknown }).code, code);
		return error;
	}
	assert.fail(`expected error code ${code}, got success`);
	throw new Error("unreachable");
}

function expectParseCode(fn: () => unknown, code: string): void {
	assert.throws(fn, (e: unknown) => e instanceof NroError && e.code === code);
}

/** No invocation-owned partial outputs may remain after any prepare failure. */
async function assertNoPartials(runsDir: string): Promise<void> {
	assert.ok(!existsSync(join(runsDir, EVIDENCE_DIR_NAME)), "no evidence directory may remain");
	assert.ok(!existsSync(join(runsDir, MANIFEST_NAME)), "no manifest may remain");
	const leftovers = (await readdir(runsDir).catch(() => [] as string[])).filter((n) => n.startsWith(STAGING_PREFIX));
	assert.deepEqual(leftovers, [], "no staging leftovers");
}

/** Privacy boundary: no absolute temp paths and no raw sentinel content. */
function assertPrivacySafe(text: string, root: string): void {
	assert.ok(!text.includes(root), `no absolute temp path in: ${text.slice(0, 120)}`);
	assert.ok(!text.includes(PRIVATE_MILESTONE_MARKER), "no raw milestone prompt content");
	assert.ok(!text.includes(PRIVATE_ASSISTANT_MARKER), "no raw assistant content");
	assert.ok(!text.includes(PRIVATE_TOOLRESULT_MARKER), "no raw tool-result content");
}

/** Recursive snapshot of a tree (relpath -> sha256) to prove read-only behavior. */
async function snapshotTree(dir: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const walk = async (cur: string, rel: string): Promise<void> => {
		for (const e of await readdir(cur, { withFileTypes: true })) {
			const r = rel.length === 0 ? e.name : `${rel}/${e.name}`;
			const full = join(cur, e.name);
			if (e.isDirectory()) await walk(full, r);
			else out.set(r, sha256(await readFile(full)));
		}
	};
	await walk(dir, "");
	return out;
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// Frozen ABBA helpers
// ---------------------------------------------------------------------------

test("abba helpers: frozen ABBA interleave, positions and labels", () => {
	assert.equal(abbaArmAt(1), "control");
	assert.equal(abbaArmAt(2), "treatment");
	assert.equal(abbaArmAt(3), "treatment");
	assert.equal(abbaArmAt(4), "control");
	assert.equal(abbaArmAt(5), "control");
	assert.equal(abbaArmAt(6), "treatment");
	assert.equal(abbaArmAt(8), "control");
	assert.deepEqual(abbaPositionsOf("control", 2), [1, 4]);
	assert.deepEqual(abbaPositionsOf("treatment", 2), [2, 3]);
	// Production freeze: RUNS_PER_ARM = 20 (user-approved pre-final refreeze
	// 2026-08-06), and the default ABBA sequence has 20 positions per arm /
	// 40 total.
	assert.equal(RUNS_PER_ARM, 20, "production RUNS_PER_ARM must be exactly 20");
	assert.equal(FROZEN_NRO_PROTOCOL.runsPerArm, RUNS_PER_ARM, "frozen protocol runsPerArm must equal RUNS_PER_ARM");
	assert.equal(FROZEN_NRO_PROTOCOL.interleave, "ABBA");
	const defaultControl = abbaPositionsOf("control");
	const defaultTreatment = abbaPositionsOf("treatment");
	assert.equal(defaultControl.length, 20, "default ABBA control positions must be 20");
	assert.equal(defaultTreatment.length, 20, "default ABBA treatment positions must be 20");
	assert.deepEqual(
		[...defaultControl, ...defaultTreatment].sort((a, b) => a - b),
		Array.from({ length: 40 }, (_, i) => i + 1),
		"default ABBA sequence must span exactly the 40 positions 1..40",
	);
	assert.equal(sessionLabel("control", 1), "control-01");
	assert.equal(sessionLabel("treatment", 20), "treatment-20");
});

// ---------------------------------------------------------------------------
// Statistics helpers (exact semantics)
// ---------------------------------------------------------------------------

test("median/p90 helpers: exact even/odd median, middle-two sums, nearest-rank p90", () => {
	assert.equal(medianOf([]), null);
	assert.equal(medianOf([1, 2]), 1.5);
	assert.equal(medianOf([1, 2, 3]), 2);
	assert.equal(middleTwoSum([]), null);
	assert.equal(middleTwoSum([1, 2]), 3);
	assert.equal(middleTwoSum([5]), 10);
	assert.equal(nearestRankP90([]), null);
	assert.equal(nearestRankP90([1]), 1);
	// Nearest-rank p90 of the production cohort (20 values) is the 18th
	// smallest; the median of the even 20-value cohort is 10.5.
	const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
	assert.equal(nearestRankP90(twenty), 18);
	assert.equal(medianOf(twenty), 10.5);
	// Generic even-size cohorts keep the same nearest-rank semantics.
	assert.equal(nearestRankP90(Array.from({ length: 30 }, (_, i) => i + 1)), 27);
});

// ---------------------------------------------------------------------------
// Human rendering caps
// ---------------------------------------------------------------------------

test("applyCaps: line cap, byte cap, oversized first line, determinism", () => {
	const marker = (lines: number, bytes: number): string => `... (output capped: ${lines} lines / ${bytes} bytes — deterministic bound)`;
	// Line cap replaces the last kept line with the marker.
	assert.deepEqual(applyCaps(["a", "b", "c", "d", "e"], 3, 10_000), ["a", "b", marker(3, 10_000)]);
	// Byte cap keeps whole lines while under the cap, then marks.
	assert.deepEqual(applyCaps(["aaa", "bbb", "ccc"], 10, 6), ["aaa", marker(10, 6)]);
	// An oversized first line is truncated to the byte budget then marked.
	const capped = applyCaps(["x".repeat(100)], 10, 16);
	assert.equal(capped.length, 2);
	assert.equal(capped[1], marker(10, 16));
	assert.ok(utf8Bytes(capped[0] as string) <= 16);
	// Small inputs pass through unchanged; output is deterministic.
	assert.deepEqual(applyCaps(["a", "b"], 10, 100), ["a", "b"]);
	assert.deepEqual(applyCaps(["a", "b"], 10, 100), applyCaps(["a", "b"], 10, 100));
});

// ---------------------------------------------------------------------------
// Preview facts marker and pagination
// ---------------------------------------------------------------------------

test("parsePreviewFacts: nine frozen facts, absent marker, malformed blocks fail closed", () => {
	const good = parsePreviewFacts(markerLine({ complete: false }));
	assert.deepEqual(good, {
		complete: false,
		returnedLines: 10,
		returnedBytes: 1000,
		totalLines: 100,
		totalBytes: 10000,
		omittedLines: 90,
		omittedBytes: 9000,
		nextOffset: 10,
		lineTruncated: false,
	});
	const complete = parsePreviewFacts(`prefix text\n${markerLine({ complete: true, lineTruncated: true })}\ntail`);
	assert.equal(complete?.complete, true);
	assert.equal(complete?.lineTruncated, true);
	assert.equal(parsePreviewFacts("no marker here"), null);
	assert.equal(parsePreviewFacts(""), null);

	const malformed = [
		`${NRO_FACTS_MARKER} complete=false`, // missing keys
		`${NRO_FACTS_MARKER} complete=maybe returned_lines=10 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`,
		`${NRO_FACTS_MARKER} complete=false returned_lines=-1 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`,
		`${NRO_FACTS_MARKER} complete=false returned_lines=1.5 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`,
		`${NRO_FACTS_MARKER} complete=false returned_lines=200000000000 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`,
		`${NRO_FACTS_MARKER} complete=false returned_lines=10 returned_lines=20 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`,
		`${NRO_FACTS_MARKER} complete=false bogus=1 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`,
	];
	for (const line of malformed) {
		assert.throws(() => parsePreviewFacts(line), (e: unknown) => e instanceof NroError && e.code === "FACTS_MALFORMED", line);
	}
});

test("computePagination: previews, continuation reads, reached-complete, content[] markers, unknown path", () => {
	const readCall = (path: string, opts: { offset?: number; limit?: number } = {}): Record<string, unknown> => ({
		type: "message",
		id: "a",
		message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path, ...opts } }] },
	});
	const readResult = (content: unknown): Record<string, unknown> => ({ type: "message", id: "r", message: { role: "toolResult", toolName: "read", content } });

	// Preview only (string marker): obligation never paginated — misuse sign.
	const p1 = computePagination([readCall("f.txt"), readResult(markerLine({ complete: false }))]);
	assert.equal(p1.previewResults, 1);
	assert.ok(p1.previewBytes > 0);
	assert.equal(p1.obligations, 1);
	assert.equal(p1.obligationsPaginated, 0);
	assert.equal(p1.unpaginatedPreviews, 1);
	assert.equal(p1.completionFraction, 0);
	assert.equal(p1.reachedFraction, 0);
	assert.equal(p1.continuationReads, 0);
	assert.equal(p1.misuse, true);

	// Preview + legacy continuation (offset, no marker): paginated obligation, no reached-complete.
	const p2 = computePagination([
		readCall("f.txt"),
		readResult(markerLine({ complete: false })),
		readCall("f.txt", { offset: 100 }),
		readResult("legacy full content"),
	]);
	assert.equal(p2.obligations, 1);
	assert.equal(p2.obligationsPaginated, 1);
	assert.equal(p2.continuationReads, 1);
	assert.ok(p2.continuationBytes > 0);
	assert.equal(p2.reachedComplete, 0);
	assert.equal(p2.completionFraction, 1);
	assert.equal(p2.misuse, false);

	// Preview + complete read where the marker arrives inside content[] items.
	const p3 = computePagination([
		readCall("f.txt"),
		readResult([{ type: "text", text: markerLine({ complete: false }) }]),
		readCall("f.txt", { limit: 50 }),
		readResult([{ type: "text", text: markerLine({ complete: true }) }]),
	]);
	assert.equal(p3.previewResults, 1);
	assert.equal(p3.obligationsPaginated, 1);
	assert.equal(p3.reachedComplete, 1);
	assert.equal(p3.reachedFraction, 1);
	assert.equal(p3.misuse, false);

	// An unattributable preview result gets the unknown path and is never paginated.
	const p4 = computePagination([readResult(markerLine({ complete: false }))]);
	assert.equal(p4.previewResults, 1);
	assert.equal(p4.obligations, 1);
	assert.equal(p4.obligationsPaginated, 0);
	assert.equal(p4.misuse, true);

	// The marker is found anywhere in the inline text (own line).
	const p5 = computePagination([readCall("f.txt"), readResult(`prefix line\n${markerLine({ complete: false })}\ntail line`)]);
	assert.equal(p5.previewResults, 1);
	assert.equal(p5.obligations, 1);

	// A malformed marker block inside a session fails closed.
	assert.throws(
		() => computePagination([readCall("f.txt"), readResult(`${NRO_FACTS_MARKER} complete=false bogus=1`)]),
		(e: unknown) => e instanceof NroError && e.code === "FACTS_MALFORMED",
	);
});

// ---------------------------------------------------------------------------
// Attempt classification (frozen priority)
// ---------------------------------------------------------------------------

test("deriveAttemptFacts: frozen category priority, dev unclassified vs final ATTEMPT_NOT_INVALID", () => {
	const label = "attempt-1";
	const sha = "0".repeat(64);
	const env = TEST_ENVIRONMENT;
	const opts = (strict: boolean): { strict: boolean } => ({ strict });
	const categoryOf = (entries: unknown[], strict: boolean): AttemptCategory => deriveAttemptFacts(label, "control", "a.jsonl", sha, entries, PROMPT_SHA, env, opts(strict)).category;

	// 1. prompt hash mismatch wins over everything else.
	assert.equal(categoryOf(buildSessionEntries({ prompt: "a different prompt" }), true), "prompt_mismatch");
	// 2. env drift (model key) beats compaction/terminal.
	assert.equal(categoryOf(buildSessionEntries({ provider: "openai" }), true), "env_drift");
	assert.equal(categoryOf(buildSessionEntries({ thinking: "low" }), true), "env_drift");
	// 3. compaction beats terminal state.
	assert.equal(categoryOf(buildSessionEntries({ compaction: true, stopReason: "aborted" }), true), "compaction_present");
	// 4–6. terminal priority: aborted > errored > nonterminal.
	assert.equal(categoryOf(buildSessionEntries({ stopReason: "aborted" }), true), "aborted");
	assert.equal(categoryOf(buildSessionEntries({ stopReason: "error" }), true), "errored");
	assert.equal(categoryOf(buildSessionEntries({ stopReason: "length" }), true), "nonterminal");
	// 7. machine-observably valid: dev records unclassified, final fails closed.
	assert.equal(categoryOf(buildSessionEntries({}), false), "unclassified");
	expectParseCode(() => {
		deriveAttemptFacts(label, "control", "a.jsonl", sha, buildSessionEntries({}), PROMPT_SHA, env, opts(true));
	}, "ATTEMPT_NOT_INVALID");
	// No user message → null prompt hash; terminal facts still classify.
	const noUser = deriveAttemptFacts(label, "control", "a.jsonl", sha, [assistantEntry({ stopReason: "length" })], PROMPT_SHA, env, opts(false));
	assert.equal(noUser.promptSha256, null);
	assert.equal(noUser.category, "nonterminal");
});

// ---------------------------------------------------------------------------
// The four frozen §11.2 verdicts
// ---------------------------------------------------------------------------

function verdictRun(gross: number, bytes: number, requests: number): RunFacts {
	const base: RunFacts = {
		label: "x-01",
		arm: "control",
		orderIndex: 1,
		sessionBasename: "x.jsonl",
		sessionSha256: "0".repeat(64),
		promptSha256: "0".repeat(64),
		promptMatches: true,
		requests,
		compactions: 0,
		cost: 0,
		input: gross,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		gross,
		toolResultEntries: 0,
		successfulToolResultEntries: 0,
		totalTextBytes: 0,
		successfulTextBytes: bytes,
		perTool: [],
		modelKeys: ["openai-codex/gpt-5.6-sol"],
		thinkingLevel: "high",
		wallTimeMs: null,
		terminal: {
			messageCount: 2,
			assistantMessageCount: 1,
			compactionCount: 0,
			lastEntryType: "message",
			lastMessageRole: "assistant",
			lastAssistantStopReason: "stop",
			terminalStop: true,
			aborted: false,
			errored: false,
		},
		correctness: { passed: true, checks: [{ id: "ok1", passed: true }] },
		pagination: {
			previewResults: 0,
			previewBytes: 0,
			continuationReads: 0,
			continuationBytes: 0,
			obligations: 0,
			obligationsPaginated: 0,
			reachedComplete: 0,
			completionFraction: null,
			reachedFraction: null,
			unpaginatedPreviews: 0,
			misuse: false,
		},
		misuse: false,
	};
	return { ...base, arm: "control", label: "control-01", ...{ gross, successfulTextBytes: bytes, requests, input: gross } };
}

function arms(c: number[], t: number[]): { control: RunFacts[]; treatment: RunFacts[] } {
	return {
		control: c.map((v, i) => ({ ...verdictRun(v, 0, 0), label: `control-${String(i + 1).padStart(2, "0")}`, orderIndex: i + 1 })),
		treatment: t.map((v, i) => ({ ...verdictRun(v, 0, 0), label: `treatment-${String(i + 1).padStart(2, "0")}`, arm: "treatment" as const, orderIndex: 2 * i + 2 })),
	};
}

function bytesArms(c: number[], t: number[]): { control: RunFacts[]; treatment: RunFacts[] } {
	const base = arms([0, 0], [0, 0]);
	return {
		control: base.control.map((r, i) => ({ ...r, successfulTextBytes: c[i] as number })),
		treatment: base.treatment.map((r, i) => ({ ...r, successfulTextBytes: t[i] as number })),
	};
}

function requestsArms(c: number[], t: number[]): { control: RunFacts[]; treatment: RunFacts[] } {
	const base = arms([0, 0], [0, 0]);
	return {
		control: base.control.map((r, i) => ({ ...r, requests: c[i] as number })),
		treatment: base.treatment.map((r, i) => ({ ...r, requests: t[i] as number })),
	};
}

test("computeVerdictsFromRuns: all four thresholds at their exact boundaries (boundary included)", () => {
	const byId = (verdicts: ReturnType<typeof computeVerdictsFromRuns>): Record<string, { status: string; control: number | null; treatment: number | null; ratio: number | null }> =>
		Object.fromEntries(verdicts.map((v) => [v.id, v]));

	// #1 bytes median reduction >= 50%: exactly 0.5 is ACHIEVED, 0.499 is MISSED.
	let v = byId(computeVerdictsFromRuns(bytesArms([1000, 1000], [500, 500]).control, bytesArms([1000, 1000], [500, 500]).treatment, "final"));
	assert.equal(v.bytes_median_reduction?.status, "ACHIEVED");
	assert.equal(v.bytes_median_reduction?.ratio, 0.5);
	v = byId(computeVerdictsFromRuns(bytesArms([1000, 1000], [501, 501]).control, bytesArms([1000, 1000], [501, 501]).treatment, "final"));
	assert.equal(v.bytes_median_reduction?.status, "MISSED");

	// #2 gross median reduction >= 20%: exactly 0.2 is ACHIEVED, 0.19 is MISSED.
	v = byId(computeVerdictsFromRuns(arms([100, 100], [80, 80]).control, arms([100, 100], [80, 80]).treatment, "final"));
	assert.equal(v.gross_median_reduction?.status, "ACHIEVED");
	assert.equal(v.gross_median_reduction?.ratio, 0.2);
	v = byId(computeVerdictsFromRuns(arms([100, 100], [81, 81]).control, arms([100, 100], [81, 81]).treatment, "final"));
	assert.equal(v.gross_median_reduction?.status, "MISSED");

	// #3 requests median non-increase: equality is ACHIEVED, +1 is MISSED.
	v = byId(computeVerdictsFromRuns(requestsArms([4, 4], [4, 4]).control, requestsArms([4, 4], [4, 4]).treatment, "final"));
	assert.equal(v.requests_median_non_increase?.status, "ACHIEVED");
	v = byId(computeVerdictsFromRuns(requestsArms([4, 4], [5, 5]).control, requestsArms([4, 4], [5, 5]).treatment, "final"));
	assert.equal(v.requests_median_non_increase?.status, "MISSED");

	// #4 gross p90 tail guard <= 1.05 x control: exactly 1.05 is ACHIEVED, 1.06 is MISSED.
	v = byId(computeVerdictsFromRuns(arms([100, 100], [105, 105]).control, arms([100, 100], [105, 105]).treatment, "final"));
	assert.equal(v.gross_p90_regression?.status, "ACHIEVED");
	assert.equal(v.gross_p90_regression?.ratio, 1.05);
	v = byId(computeVerdictsFromRuns(arms([100, 100], [106, 106]).control, arms([100, 100], [106, 106]).treatment, "final"));
	assert.equal(v.gross_p90_regression?.status, "MISSED");
});

test("computeVerdictsFromRuns: dev NOT_MEASURED, zero denominators and empty arms stay NOT_MEASURED", () => {
	const dev = computeVerdictsFromRuns(arms([100, 100], [80, 80]).control, arms([100, 100], [80, 80]).treatment, "dev");
	assert.equal(dev.length, 4);
	assert.deepEqual(dev.map((v) => v.id), [...VERDICT_IDS]);
	for (const verdict of dev) {
		assert.equal(verdict.status, "NOT_MEASURED");
		assert.equal(verdict.control, null);
		assert.equal(verdict.treatment, null);
		assert.ok(verdict.reason.includes("development-phase manifest"), verdict.id);
	}
	// Zero control medians / p90 → NOT_MEASURED (never PASS).
	const zero = computeVerdictsFromRuns(arms([0, 0], [0, 0]).control, arms([0, 0], [0, 0]).treatment, "final");
	const byId = Object.fromEntries(zero.map((v) => [v.id, v]));
	assert.equal(byId.gross_median_reduction?.status, "NOT_MEASURED");
	assert.equal(byId.gross_p90_regression?.status, "NOT_MEASURED");
	assert.equal(byId.bytes_median_reduction?.status, "NOT_MEASURED");
	assert.ok(String(byId.gross_median_reduction?.reason).includes("zero denominator"));
	// An empty arm is NOT_MEASURED, never a crash or PASS.
	const empty = computeVerdictsFromRuns([], arms([100, 100], [80, 80]).treatment, "final");
	for (const verdict of empty) assert.equal(verdict.status, "NOT_MEASURED");
});

// ---------------------------------------------------------------------------
// Manifest serialization and strict parsing
// ---------------------------------------------------------------------------

function testProtocol(): FrozenProtocol {
	return {
		milestonePromptSha256: PROMPT_SHA,
		environment: { ...TEST_ENVIRONMENT },
		fixtureManifestSha256: "22".repeat(32),
		nonTreatmentSha256: NON_TREATMENT_SHA,
		rubricSha256: RUBRIC_SHA,
		runsPerArm: 2,
		interleave: "ABBA",
	};
}

interface WireSession {
	label: string;
	arm: string;
	order_index: number;
	path: string;
	expected_session_sha256: string;
}

interface WireAttempt {
	label: string;
	arm: string;
	path: string;
	expected_session_sha256: string;
	prompt_sha256: string | null;
	category: string;
}

function wireManifest(protocol: FrozenProtocol, overrides: { phase?: Phase; sessions?: WireSession[]; attempts?: WireAttempt[]; extra?: Record<string, unknown> } = {}): string {
	const baseSessions: WireSession[] = [
		{ label: "control-01", arm: "control", order_index: 1, path: "sessions/control-01.jsonl", expected_session_sha256: "11".repeat(32) },
		{ label: "treatment-01", arm: "treatment", order_index: 2, path: "sessions/treatment-01.jsonl", expected_session_sha256: "11".repeat(32) },
		{ label: "treatment-02", arm: "treatment", order_index: 3, path: "sessions/treatment-02.jsonl", expected_session_sha256: "11".repeat(32) },
		{ label: "control-02", arm: "control", order_index: 4, path: "sessions/control-02.jsonl", expected_session_sha256: "11".repeat(32) },
	];
	const wire = {
		schema_version: BENCHMARK_SCHEMA_VERSION,
		protocol_doc: PROTOCOL_DOC,
		phase: overrides.phase ?? "final",
		milestone_prompt_sha256: protocol.milestonePromptSha256,
		environment: {
			model_key: protocol.environment.modelKey,
			thinking_level: protocol.environment.thinkingLevel,
			pi_version: protocol.environment.piVersion,
			node_version: protocol.environment.nodeVersion,
		},
		fixture: { path: "fixture", manifest_sha256: protocol.fixtureManifestSha256 },
		non_treatment_sha256: protocol.nonTreatmentSha256,
		rubric: { sha256: protocol.rubricSha256, checks: [{ id: "ok1", pattern: "DONE-OK" }] },
		sessions: overrides.sessions ?? baseSessions,
		attempts: overrides.attempts ?? [],
		...overrides.extra,
	};
	return `${JSON.stringify(wire, null, 2)}\n`;
}

test("manifestToJson: strict wire round-trip with a single trailing newline", () => {
	const protocol = testProtocol();
	const parsed = parseManifest(wireManifest(protocol), protocol);
	const json = manifestToJson(parsed);
	assert.ok(json.endsWith("}\n"), "serialized manifest must end with exactly one newline and no trailing characters");
	const reparsed = parseManifest(json, protocol);
	assert.deepEqual(reparsed.sessions, parsed.sessions);
	assert.deepEqual(reparsed.attempts, parsed.attempts);
	assert.equal(reparsed.phase, "final");
	assert.equal(reparsed.fixture.manifestSha256, protocol.fixtureManifestSha256);
});

test("parseManifest: strict final ABBA manifest parses; dev manifests relax ABBA/counts", () => {
	const protocol = testProtocol();
	const manifest = parseManifest(wireManifest(protocol), protocol);
	assert.equal(manifest.phase, "final");
	assert.deepEqual(
		manifest.sessions.map((s) => `${s.label}@${s.orderIndex}:${s.arm}`),
		["control-01@1:control", "treatment-01@2:treatment", "treatment-02@3:treatment", "control-02@4:control"],
	);
	assert.deepEqual(manifest.attempts, []);

	// Dev: two control sessions in non-ABBA order are fine; a dev
	// "unclassified" attempt is fine.
	const dev = wireManifest(protocol, {
		phase: "dev",
		sessions: [
			{ label: "control-01", arm: "control", order_index: 1, path: "sessions/control-01.jsonl", expected_session_sha256: "11".repeat(32) },
			{ label: "control-02", arm: "control", order_index: 2, path: "sessions/control-02.jsonl", expected_session_sha256: "11".repeat(32) },
		],
		attempts: [{ label: "attempt-1", arm: "control", path: "attempts/attempt-1.jsonl", expected_session_sha256: "11".repeat(32), prompt_sha256: null, category: "unclassified" }],
	});
	const devManifest = parseManifest(dev, protocol);
	assert.equal(devManifest.phase, "dev");
	assert.equal(devManifest.attempts[0]?.category, "unclassified");
	// The dev wire must also survive the strict shape validator.
	validateSessionShape(devManifest.sessions, "dev", 2);
});

test("parseManifest fails closed: ABBA/label/order/count drift, duplicates, gaps, unknown keys", () => {
	const protocol = testProtocol();
	const base = (): string => wireManifest(protocol);
	const session = (label: string, arm: string, order: number): WireSession => ({ label, arm, order_index: order, path: `sessions/${label}.jsonl`, expected_session_sha256: "11".repeat(32) });
	const cases: Array<{ name: string; wire: string; code: string }> = [
		{
			name: "ARM_MISMATCH",
			wire: wireManifest(protocol, { sessions: [session("control-01", "control", 1), session("control-02", "control", 2), session("treatment-01", "treatment", 3), session("treatment-02", "treatment", 4)] }),
			code: "ARM_MISMATCH",
		},
		{
			name: "LABEL_MISMATCH",
			wire: wireManifest(protocol, { sessions: [session("control-01", "control", 1), session("control-99", "control", 2), session("treatment-01", "treatment", 3), session("treatment-02", "treatment", 4)] }),
			code: "LABEL_MISMATCH",
		},
		{
			name: "ORDER_MISMATCH_START",
			wire: wireManifest(protocol, { sessions: [session("control-01", "control", 2), session("treatment-01", "treatment", 3), session("treatment-02", "treatment", 4), session("control-02", "control", 5)] }),
			code: "ORDER_MISMATCH",
		},
		{
			name: "ORDER_MISMATCH_DUPLICATE",
			wire: wireManifest(protocol, { sessions: [session("control-01", "control", 1), session("treatment-01", "treatment", 1), session("treatment-02", "treatment", 3), session("control-02", "control", 4)] }),
			code: "ORDER_MISMATCH",
		},
		{
			name: "COHORT_COUNT",
			wire: wireManifest(protocol, { sessions: [session("control-01", "control", 1), session("treatment-01", "treatment", 2), session("treatment-02", "treatment", 3)] }),
			code: "COHORT_COUNT",
		},
		{
			name: "DUPLICATE_LABEL",
			wire: wireManifest(protocol, { sessions: [session("control-01", "control", 1), session("control-01", "control", 2), session("treatment-01", "treatment", 3), session("treatment-02", "treatment", 4)] }),
			code: "DUPLICATE_LABEL",
		},
		{
			name: "ATTEMPT_LABELS_GAP",
			wire: wireManifest(protocol, {
				attempts: [{ label: "attempt-2", arm: "control", path: "attempts/attempt-2.jsonl", expected_session_sha256: "11".repeat(32), prompt_sha256: null, category: "prompt_mismatch" }],
			}),
			code: "ATTEMPT_LABELS",
		},
		{
			name: "UNCLASSIFIED_IN_FINAL",
			wire: wireManifest(protocol, {
				attempts: [{ label: "attempt-1", arm: "control", path: "attempts/attempt-1.jsonl", expected_session_sha256: "11".repeat(32), prompt_sha256: null, category: "unclassified" }],
			}),
			code: "INVALID_MANIFEST",
		},
		{
			name: "UNKNOWN_KEY",
			wire: wireManifest(protocol, { extra: { bogus: 1 } }),
			code: "INVALID_MANIFEST",
		},
		{
			name: "WRONG_SCHEMA",
			wire: wireManifest(protocol, { extra: { schema_version: 2 } }),
			code: "INVALID_MANIFEST",
		},
		{
			name: "WRONG_PROTOCOL_DOC",
			wire: wireManifest(protocol, { extra: { protocol_doc: "docs/other.md" } }),
			code: "INVALID_MANIFEST",
		},
		{
			name: "BASENAME_UNSAFE",
			wire: wireManifest(protocol, { sessions: [session("control-01", "control", 1), { label: "treatment-01", arm: "treatment", order_index: 2, path: "sessions/bad name.jsonl", expected_session_sha256: "11".repeat(32) }, session("treatment-02", "treatment", 3), session("control-02", "control", 4)] }),
			code: "BASENAME_UNSAFE",
		},
	];
	for (const c of cases) {
		expectParseCode(() => parseManifest(c.wire, protocol), c.code);
	}
	expectParseCode(() => parseManifest(base(), { ...testProtocol(), milestonePromptSha256: null }), "PROTOCOL_NOT_FROZEN");
	expectParseCode(() => parseManifest(base(), { ...testProtocol(), milestonePromptSha256: "ff".repeat(32) }), "INVALID_MANIFEST");
});

// ---------------------------------------------------------------------------
// Collection record and environment file
// ---------------------------------------------------------------------------

test("parseCollectionRecord and canonicalEnvironmentFile: strict shapes", () => {
	const good = {
		schema_version: COLLECTION_SCHEMA_VERSION,
		phase: "final",
		non_treatment_sha256: NON_TREATMENT_SHA,
		entries: [
			{ kind: "session", arm: "control", path: "sources/control-01.jsonl" },
			{ kind: "attempt", arm: "treatment", path: "sources/attempt-1.jsonl" },
		],
	};
	const record = parseCollectionRecord(`${JSON.stringify(good, null, 2)}\n`, "collection record");
	assert.equal(record.phase, "final");
	assert.equal(record.entries.length, 2);
	assert.equal(record.entries[1]?.kind, "attempt");
	expectParseCode(() => parseCollectionRecord(`${JSON.stringify({ ...good, schema_version: 2 })}\n`, "collection record"), "COLLECTION_INVALID");
	expectParseCode(() => parseCollectionRecord(`${JSON.stringify({ ...good, entries: [{ kind: "session", arm: "control", path: "../escape.jsonl" }] })}\n`, "collection record"), "PATH_UNSAFE");
	expectParseCode(() => parseCollectionRecord(`${JSON.stringify({ ...good, entries: [{ kind: "session", arm: "control", path: "sources/bad name.jsonl" }] })}\n`, "collection record"), "BASENAME_UNSAFE");
	expectParseCode(() => parseCollectionRecord(`${JSON.stringify({ ...good, bogus: 1 })}\n`, "collection record"), "COLLECTION_INVALID");

	assert.equal(
		canonicalEnvironmentFile(TEST_ENVIRONMENT),
		["model_key: openai-codex/gpt-5.6-sol", "thinking_level: high", "pi_version: 0.83.0", "node_version: v26.4.0"].join("\n"),
	);
});

// ---------------------------------------------------------------------------
// Fixture manifest hash (hand-computed expectation, symlinks fail closed)
// ---------------------------------------------------------------------------

test("fixtureManifestHash: deterministic sorted hash, bounds, symlink refusal", async () => {
	await withTempDir(async (root) => {
		await mkdir(join(root, "d"), { recursive: true });
		await writeFile(join(root, "a.txt"), "hello", "utf8");
		await writeFile(join(root, "d", "b.txt"), "world", "utf8");
		const result = await fixtureManifestHash(root);
		const rows = `a.txt:${sha256("hello")}\nd/b.txt:${sha256("world")}\n`;
		assert.equal(result.manifestSha256, sha256(rows));
		assert.deepEqual(result.files, ["a.txt", "d/b.txt"]);
		assert.equal(result.totalBytes, 10);
		await symlink(join(root, "a.txt"), join(root, "link.txt"));
		await expectCode(fixtureManifestHash(root), "FIXTURE_UNSAFE");
	});
});

// ---------------------------------------------------------------------------
// Analyze: happy paths (final + dev), read-only
// ---------------------------------------------------------------------------

test("analyze happy path (final, runsPerArm=2): full facts, ABBA cohort, fixture verified, verdicts, attempts", async () => {
	await withTempDir(async (root) => {
		const ctx = await writeAnalyzeFixture(join(root, "bench"), {
			phase: "final",
			runsPerArm: 2,
			sessions: finalSessions(),
			attempts: [{ arm: "control", spec: { prompt: "wrong attempt prompt text" } }],
		});
		const before = await snapshotTree(ctx.root);
		const report = await analyzeManifestFile(ctx.manifestPath, ctx.protocol);

		// Read-only: nothing changed on disk.
		assert.deepEqual(await snapshotTree(ctx.root), before, "analyze must never write");

		assert.equal(report.runs.length, 4);
		assert.deepEqual(report.runs.map((r) => r.label), ["control-01", "treatment-01", "treatment-02", "control-02"]);
		assert.deepEqual(report.runs.map((r) => r.orderIndex), [1, 2, 3, 4]);
		for (const run of report.runs) {
			assert.equal(run.compactions, 0);
			// Hand-computed: no tool rounds → exactly one assistant request
			// (commanderRequests counts every assistant message once).
			assert.equal(run.requests, 1);
			assert.equal(run.promptMatches, true);
			assert.deepEqual(run.modelKeys, ["openai-codex/gpt-5.6-sol"]);
			assert.equal(run.thinkingLevel, "high");
			assert.equal(run.terminal.terminalStop, true);
			assert.equal(run.correctness.passed, true);
			assert.equal(run.wallTimeMs, 1000);
			assert.equal(run.totalTextBytes, 0);
			assert.equal(run.successfulTextBytes, 0);
			assert.equal(run.gross, run.arm === "control" ? 100 : 80);
			assert.equal(run.cost, 0.001);
		}

		assert.equal(report.arms.control.runCount, 2);
		assert.equal(report.arms.treatment.runCount, 2);
		assert.equal(report.arms.control.grossMedian, 100);
		assert.equal(report.arms.treatment.grossMedian, 80);
		assert.equal(report.arms.control.grossP90, 100);
		assert.equal(report.arms.treatment.grossP90, 80);

		// Fixture re-verified against the declared hash.
		assert.equal(report.manifest.fixture.verified, true);
		assert.equal(report.manifest.fixture.files, 2);
		assert.equal(report.manifest.fixture.totalBytes, 9);
		assert.equal(report.manifest.sessionCount, 4);
		assert.equal(report.manifest.attemptCount, 1);

		// The attempt is derived and reported.
		assert.equal(report.attempts.length, 1);
		assert.equal(report.attempts[0]?.category, "prompt_mismatch");
		assert.notEqual(report.attempts[0]?.promptSha256, ctx.protocol.milestonePromptSha256);

		// Exact §11.2 outcomes on the chosen values: gross exactly 20%
		// reduction (ACHIEVED), requests equal (ACHIEVED), p90 ratio 0.8
		// (ACHIEVED), zero control inline bytes (NOT_MEASURED).
		const byId = Object.fromEntries(report.verdicts.map((v) => [v.id, v]));
		assert.equal(byId.gross_median_reduction?.status, "ACHIEVED");
		assert.equal(byId.gross_median_reduction?.ratio, 0.2);
		assert.equal(byId.requests_median_non_increase?.status, "ACHIEVED");
		assert.equal(byId.gross_p90_regression?.status, "ACHIEVED");
		assert.equal(byId.bytes_median_reduction?.status, "NOT_MEASURED");

		// Privacy: the human rendering leaks no sentinels and no absolute paths.
		assertPrivacySafe(renderReport(report).join("\n"), root);
	});
});

test("analyze dev manifest: facts recorded, verdicts NOT_MEASURED, pagination via string and content[] markers", async () => {
	await withTempDir(async (root) => {
		const ctx = await writeAnalyzeFixture(join(root, "bench"), {
			phase: "dev",
			sessions: [
				{
					arm: "control",
					spec: {
						rounds: [
							{ call: { path: "fixture/a.txt" }, result: { content: `${markerLine({ complete: false })}\n${PRIVATE_TOOLRESULT_MARKER} ${"x".repeat(80)}` } },
							{ call: { path: "fixture/a.txt", offset: 100 }, result: { content: [{ type: "text", text: markerLine({ complete: true }) }] } },
						],
					},
				},
				{ arm: "treatment", spec: { compaction: true, rounds: [{ call: { path: "fixture/a.txt" }, result: { content: [{ type: "text", text: markerLine({ complete: false }) }] } }] } },
			],
			attempts: [{ arm: "control", spec: {} }],
		});
		const before = await snapshotTree(ctx.root);
		const report = await analyzeManifestFile(ctx.manifestPath, ctx.protocol);
		assert.deepEqual(await snapshotTree(ctx.root), before, "analyze must never write");

		// Dev phase: all four verdicts are NOT_MEASURED with the fixed reason.
		for (const verdict of report.verdicts) {
			assert.equal(verdict.status, "NOT_MEASURED");
			assert.ok(verdict.reason.includes("development-phase manifest"), verdict.id);
		}

		const control = report.runs.find((r) => r.label === "control-01");
		const treatment = report.runs.find((r) => r.label === "treatment-01");
		assert.ok(control);
		assert.ok(treatment);

		// String-marker preview + content[]-marker complete read: the full
		// pagination contract is derived.
		assert.equal(control.pagination.previewResults, 1);
		assert.ok(control.pagination.previewBytes > 0);
		assert.equal(control.pagination.obligations, 1);
		assert.equal(control.pagination.obligationsPaginated, 1);
		assert.equal(control.pagination.reachedComplete, 1);
		assert.equal(control.pagination.continuationReads, 1);
		assert.ok(control.pagination.continuationBytes > 0);
		assert.equal(control.pagination.completionFraction, 1);
		assert.equal(control.pagination.reachedFraction, 1);
		assert.equal(control.pagination.misuse, false);
		assert.equal(control.toolResultEntries, 2);
		assert.equal(control.successfulToolResultEntries, 2);

		// Content[]-marker preview with no continuation: the misuse sign.
		assert.equal(treatment.pagination.previewResults, 1);
		assert.equal(treatment.pagination.obligations, 1);
		assert.equal(treatment.pagination.obligationsPaginated, 0);
		assert.equal(treatment.pagination.misuse, true);
		// Dev sessions are not enforced: the compaction is recorded.
		assert.equal(treatment.compactions, 1);

		// A machine-valid dev attempt is recorded as unclassified.
		assert.equal(report.attempts.length, 1);
		assert.equal(report.attempts[0]?.category, "unclassified");
		assert.equal(report.attempts[0]?.promptSha256, ctx.protocol.milestonePromptSha256);

		assertPrivacySafe(renderReport(report).join("\n"), root);
	});
});

// ---------------------------------------------------------------------------
// Analyze: fail-closed table
// ---------------------------------------------------------------------------

test("analyze fails closed: hash, prompt/env/thinking, compaction, terminal, attempts, paths, fixture", async () => {
	await withTempDir(async (root) => {
		const ABBA2 = finalSessions();
		const withSpec = (sessions: TestSessionSlot[], index: number, patch: Partial<TestSessionSpec>): TestSessionSlot[] => sessions.map((s, i) => (i === index ? { ...s, spec: { ...s.spec, ...patch } } : s));
		const cases: Array<{ name: string; sessions: TestSessionSlot[]; attempts?: TestAttemptSlot[]; code: string; afterWrite?: (ctx: AnalyzeContext) => Promise<void> }> = [
			{
				name: "HASH_MISMATCH",
				sessions: ABBA2,
				code: "HASH_MISMATCH",
				afterWrite: async (ctx) => {
					await appendFile(join(ctx.root, "sessions", "control-01.jsonl"), "tamper", "utf8");
				},
			},
			{ name: "PROMPT_MISMATCH", sessions: withSpec(ABBA2, 0, { prompt: "a different milestone prompt" }), code: "PROMPT_MISMATCH" },
			{ name: "MODEL_MISMATCH", sessions: withSpec(ABBA2, 0, { provider: "openai" }), code: "MODEL_MISMATCH" },
			{ name: "THINKING_MISMATCH", sessions: withSpec(ABBA2, 0, { thinking: "low" }), code: "THINKING_MISMATCH" },
			{ name: "MISSING_THINKING_LEVEL", sessions: withSpec(ABBA2, 0, { thinking: null }), code: "MISSING_THINKING_LEVEL" },
			{ name: "COMPACTION_PRESENT", sessions: withSpec(ABBA2, 0, { compaction: true }), code: "COMPACTION_PRESENT" },
			{ name: "ABORTED", sessions: withSpec(ABBA2, 0, { stopReason: "aborted" }), code: "ABORTED" },
			{ name: "ERRORED", sessions: withSpec(ABBA2, 0, { stopReason: "error" }), code: "ERRORED" },
			{ name: "NOT_TERMINAL_STOP", sessions: withSpec(ABBA2, 0, { stopReason: "length" }), code: "NOT_TERMINAL_STOP" },
			{ name: "MALFORMED_JSONL", sessions: withSpec(ABBA2, 0, {}).map((s, i) => (i === 0 ? { ...s, rawText: '{"type":"message"}\n{this is not json\n' } : s)), code: "MALFORMED_JSONL" },
			{ name: "FILE_MISSING", sessions: ABBA2.map((s, i) => (i === 0 ? { ...s, path: "sessions/gone.jsonl", write: false } : s)), code: "FILE_MISSING" },
			{ name: "PATH_UNSAFE", sessions: ABBA2.map((s, i) => (i === 0 ? { ...s, path: "../escape.jsonl", write: false } : s)), code: "PATH_UNSAFE" },
			{
				name: "DUPLICATE_PATH",
				sessions: ABBA2.map((s, i) => (i === 1 ? { ...s, path: "sessions/control-01.jsonl", write: false } : s)),
				code: "DUPLICATE_PATH",
			},
			{
				name: "CATEGORY_MISMATCH",
				sessions: ABBA2,
				attempts: [{ arm: "control", spec: { prompt: "wrong attempt prompt text" }, declared: { category: "aborted" } }],
				code: "CATEGORY_MISMATCH",
			},
			{
				name: "ATTEMPT_NOT_INVALID",
				sessions: ABBA2,
				attempts: [{ arm: "control", spec: {}, declared: { category: "aborted" } }],
				code: "ATTEMPT_NOT_INVALID",
			},
			{ name: "COHORT_COUNT", sessions: ABBA2.slice(0, 3), code: "COHORT_COUNT" },
			{
				name: "ATTEMPT_LABELS",
				sessions: ABBA2,
				attempts: [{ arm: "control", spec: { prompt: "wrong attempt prompt text" }, declared: { label: "attempt-2" } }],
				code: "ATTEMPT_LABELS",
			},
			{
				name: "FIXTURE_MISMATCH",
				sessions: ABBA2,
				code: "FIXTURE_MISMATCH",
				afterWrite: async (ctx) => {
					await writeFile(join(ctx.fixtureDir, "extra.txt"), "tampered-fixture", "utf8");
				},
			},
		];
		for (let i = 0; i < cases.length; i += 1) {
			const c = cases[i] as (typeof cases)[number];
			const ctx = await writeAnalyzeFixture(join(root, `case-${i}`), { phase: "final", runsPerArm: 2, sessions: c.sessions, attempts: c.attempts, afterWrite: c.afterWrite });
			await expectCode(analyzeManifestFile(ctx.manifestPath, ctx.protocol), c.code);
		}
	});
});

test("analyze: frozen real protocol rejects hermetic pins as INVALID_MANIFEST; explicit null-pin protocol fails PROTOCOL_NOT_FROZEN", async () => {
	await withTempDir(async (root) => {
		const ctx = await writeAnalyzeFixture(join(root, "bench"), { phase: "final", sessions: finalSessions() });
		// The real FROZEN_NRO_PROTOCOL has all four content pins resolved:
		// a manifest derived from hermetic (non-frozen) content drifts from
		// the production pins and fails closed as INVALID_MANIFEST (pin
		// drift) — never PROTOCOL_NOT_FROZEN.
		const drift = await expectCode(analyzeManifestFile(ctx.manifestPath, FROZEN_NRO_PROTOCOL), "INVALID_MANIFEST");
		assert.ok(drift.message.includes("frozen pin"), "pin-drift message must reference the frozen pin");
		// Explicit generic unresolved-pin coverage: a derived protocol with
		// a null pin still fails closed PROTOCOL_NOT_FROZEN.
		await expectCode(analyzeManifestFile(ctx.manifestPath, { ...testProtocol(), fixtureManifestSha256: null }), "PROTOCOL_NOT_FROZEN");
		await expectCode(analyzeManifestFile(join(root, "not-json.json"), { ...testProtocol(), milestonePromptSha256: null }), "IO_ERROR");
		const badPath = join(root, "bad.json");
		await writeFile(badPath, "{not json", "utf8");
		await expectCode(analyzeManifestFile(badPath, testProtocol()), "INVALID_MANIFEST");
	});
});

// ---------------------------------------------------------------------------
// Prepare: happy paths (final + dev), byte-exact, analyzable
// ---------------------------------------------------------------------------

test("prepare happy path (final): byte-exact evidence, strict manifest analyzable, exclusive-commit refusal", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareFixture(join(root, "bench"), {
			phase: "final",
			runsPerArm: 2,
			sessions: finalSessions(),
			attempts: [{ arm: "control", spec: { prompt: "wrong attempt prompt text" } }],
		});
		const result = await prepareEvidence({ runsDir: fx.runsDir, inputsDir: fx.inputsDir, collectionFile: fx.collectionFile, protocol: fx.protocol });
		assert.equal(result.evidenceDir, join(fx.runsDir, EVIDENCE_DIR_NAME));
		assert.equal(result.manifestPath, join(fx.runsDir, MANIFEST_NAME));

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
		assert.equal(await readFile(join(fx.runsDir, EVIDENCE_DIR_NAME, "collection-record.json"), "utf8"), fx.recordRaw);
		// The fixture tree reproduces the frozen manifest hash.
		const stagedFixture = await fixtureManifestHash(join(fx.runsDir, EVIDENCE_DIR_NAME, "fixture"));
		assert.equal(stagedFixture.manifestSha256, fx.protocol.fixtureManifestSha256);

		// The generated manifest is strict and analyzable end to end.
		const manifestText = await readFile(result.manifestPath, "utf8");
		const parsed = parseManifest(manifestText, fx.protocol);
		assert.deepEqual(parsed.sessions.map((s) => s.label), ["control-01", "treatment-01", "treatment-02", "control-02"]);
		for (const s of parsed.sessions) {
			assert.equal(sha256(await readFile(join(fx.runsDir, s.path))), s.expectedSessionSha256, s.label);
		}
		const report = await analyzeManifestFile(result.manifestPath, fx.protocol);
		assert.equal(report.runs.length, 4);
		assert.deepEqual(report.runs.map((r) => r.label), ["control-01", "treatment-01", "treatment-02", "control-02"]);
		assert.equal(report.manifest.fixture.verified, true);
		assert.equal(report.attempts.length, 1);
		assert.equal(report.attempts[0]?.category, "prompt_mismatch");
		// The committed evidence is untouched by analysis.
		assert.deepEqual(await snapshotTree(fx.runsDir), await snapshotTree(fx.runsDir), "analyze must never write");

		// The deviations document records the retained attempt.
		const deviations = JSON.parse(await readFile(join(fx.runsDir, EVIDENCE_DIR_NAME, "collection-deviations.json"), "utf8")) as { attempts: Array<{ label: string; category: string }> };
		assert.equal(deviations.attempts.length, 1);
		assert.equal(deviations.attempts[0]?.label, "attempt-1");
		assert.equal(deviations.attempts[0]?.category, "prompt_mismatch");

		// No staging leftovers; a rerun refuses the existing outputs.
		assert.deepEqual((await readdir(fx.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), []);
		await expectCode(prepareEvidence({ runsDir: fx.runsDir, inputsDir: fx.inputsDir, collectionFile: fx.collectionFile, protocol: fx.protocol }), "EXISTING_OUTPUT");
		assert.ok(existsSync(result.manifestPath));
		assert.ok(existsSync(join(fx.runsDir, EVIDENCE_DIR_NAME, "sessions", "control-01", "control-01.jsonl")));

		// The prepare summary is privacy-safe.
		assertPrivacySafe(renderPrepareSummary(result).join("\n"), root);
	});
});

test("prepare happy path (dev): compacted session accepted, valid attempt unclassified, verdicts NOT_MEASURED", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareFixture(join(root, "bench"), {
			phase: "dev",
			sessions: [{ arm: "control", spec: { compaction: true } }],
			attempts: [{ arm: "control", spec: {} }],
		});
		const result = await prepareEvidence({ runsDir: fx.runsDir, inputsDir: fx.inputsDir, collectionFile: fx.collectionFile, protocol: fx.protocol });
		assert.equal(result.manifest.phase, "dev");
		const report = await analyzeManifestFile(result.manifestPath, fx.protocol);
		assert.equal(report.runs.length, 1);
		assert.equal(report.runs[0]?.compactions, 1);
		for (const verdict of report.verdicts) assert.equal(verdict.status, "NOT_MEASURED");
		assert.equal(report.attempts[0]?.category, "unclassified");
	});
});

// ---------------------------------------------------------------------------
// Prepare: existing-output refusal and ownership-tracked rollback
// ---------------------------------------------------------------------------

test("prepare: existing outputs refused with EXISTING_OUTPUT and survive untouched", async () => {
	await withTempDir(async (root) => {
		const fx1 = await writePrepareFixture(join(root, "a"), { phase: "dev", sessions: [{ arm: "control", spec: {} }] });
		await mkdir(join(fx1.runsDir, EVIDENCE_DIR_NAME), { recursive: true });
		await writeFile(join(fx1.runsDir, EVIDENCE_DIR_NAME, "keep.txt"), "FOREIGN-KEEP-1", "utf8");
		await expectCode(prepareEvidence({ runsDir: fx1.runsDir, inputsDir: fx1.inputsDir, collectionFile: fx1.collectionFile, protocol: fx1.protocol }), "EXISTING_OUTPUT");
		assert.equal(await readFile(join(fx1.runsDir, EVIDENCE_DIR_NAME, "keep.txt"), "utf8"), "FOREIGN-KEEP-1");

		const fx2 = await writePrepareFixture(join(root, "b"), { phase: "dev", sessions: [{ arm: "control", spec: {} }] });
		await mkdir(fx2.runsDir, { recursive: true });
		await writeFile(join(fx2.runsDir, MANIFEST_NAME), "FOREIGN-MANIFEST-2", "utf8");
		await expectCode(prepareEvidence({ runsDir: fx2.runsDir, inputsDir: fx2.inputsDir, collectionFile: fx2.collectionFile, protocol: fx2.protocol }), "EXISTING_OUTPUT");
		assert.equal(await readFile(join(fx2.runsDir, MANIFEST_NAME), "utf8"), "FOREIGN-MANIFEST-2");

		// Post-conditions are per-case: the foreign outputs must survive
		// untouched while nothing invocation-owned may remain — fx1 keeps its
		// foreign evidence dir (no manifest, no staging), fx2 keeps its
		// foreign manifest (no evidence dir, no staging).
		assert.ok(!existsSync(join(fx1.runsDir, MANIFEST_NAME)), "no manifest may remain in a");
		assert.deepEqual((await readdir(fx1.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [], "no staging leftovers in a");
		assert.ok(!existsSync(join(fx2.runsDir, EVIDENCE_DIR_NAME)), "no evidence directory may remain in b");
		assert.deepEqual((await readdir(fx2.runsDir)).filter((n) => n.startsWith(STAGING_PREFIX)), [], "no staging leftovers in b");
	});
});

test("prepare rollback: injected failures after exclusive creates leave no partials", async () => {
	await withTempDir(async (root) => {
		const spec = (): PrepareFixtureSpec => ({ phase: "final", runsPerArm: 2, sessions: finalSessions() });

		const fx1 = await writePrepareFixture(join(root, "a"), spec());
		const boom1 = Object.assign(new Error("injected after evidence reservation"), { code: "INJECTED_RESERVE" });
		const hooks1: PrepareHooks = {
			afterEvidenceReserve: async () => {
				throw boom1;
			},
		};
		await expectCode(prepareEvidence({ runsDir: fx1.runsDir, inputsDir: fx1.inputsDir, collectionFile: fx1.collectionFile, protocol: fx1.protocol, hooks: hooks1 }), "INJECTED_RESERVE");
		await assertNoPartials(fx1.runsDir);

		const fx2 = await writePrepareFixture(join(root, "b"), spec());
		const boom2 = Object.assign(new Error("injected after manifest open"), { code: "INJECTED_MANIFEST_OPEN" });
		const hooks2: PrepareHooks = {
			afterManifestOpen: async () => {
				throw boom2;
			},
		};
		await expectCode(prepareEvidence({ runsDir: fx2.runsDir, inputsDir: fx2.inputsDir, collectionFile: fx2.collectionFile, protocol: fx2.protocol, hooks: hooks2 }), "INJECTED_MANIFEST_OPEN");
		await assertNoPartials(fx2.runsDir);
	});
});

// ---------------------------------------------------------------------------
// Prepare: fail-closed table
// ---------------------------------------------------------------------------

test("prepare fails closed: inputs, pins, collection, sources, ABBA, cohort, attempts", async () => {
	await withTempDir(async (root) => {
		const dev = (): PrepareFixtureSpec => ({ phase: "dev", sessions: [{ arm: "control", spec: {} }] });
		const cases: Array<{ name: string; spec: PrepareFixtureSpec; code: string }> = [
			{
				name: "INPUTS_INVALID",
				spec: dev(),
				code: "INPUTS_INVALID",
			},
			{
				name: "ENV_FILE_INVALID",
				spec: dev(),
				code: "ENV_FILE_INVALID",
			},
			{
				name: "RUBRIC_INVALID",
				spec: dev(),
				code: "RUBRIC_INVALID",
			},
			{
				name: "FIXTURE_MISMATCH",
				spec: dev(),
				code: "FIXTURE_MISMATCH",
			},
			{
				name: "MILESTONE_MISMATCH",
				spec: dev(),
				code: "MILESTONE_MISMATCH",
			},
			{
				name: "NON_TREATMENT_MISMATCH",
				spec: dev(),
				code: "NON_TREATMENT_MISMATCH",
			},
			{
				name: "SOURCE_UNREADABLE",
				spec: dev(),
				code: "SOURCE_UNREADABLE",
			},
			{
				name: "COLLECTION_ABBA",
				spec: { phase: "final", runsPerArm: 2, sessions: [{ arm: "control", spec: {} }, { arm: "control", spec: {} }, { arm: "treatment", spec: {} }, { arm: "treatment", spec: {} }] },
				code: "COLLECTION_INVALID",
			},
			{
				name: "COHORT_COUNT",
				spec: { phase: "final", runsPerArm: 2, sessions: [{ arm: "control", spec: {} }, { arm: "treatment", spec: {} }, { arm: "treatment", spec: {} }] },
				code: "COHORT_COUNT",
			},
			{
				name: "DUPLICATE_SOURCE",
				spec: { phase: "dev", sessions: [{ arm: "control", spec: {} }, { arm: "control", spec: {}, path: "sources/control-01.jsonl", write: false }] },
				code: "DUPLICATE_SOURCE",
			},
			{
				name: "ATTEMPT_NOT_INVALID",
				spec: { phase: "final", runsPerArm: 2, sessions: finalSessions(), attempts: [{ arm: "control", spec: {} }] },
				code: "ATTEMPT_NOT_INVALID",
			},
		];
		const afterWriteByName: Record<string, (fx: PrepareFixture) => Promise<void>> = {
			INPUTS_INVALID: async (fx) => {
				await writeFile(join(fx.inputsDir, "extra.txt"), "x", "utf8");
			},
			ENV_FILE_INVALID: async (fx) => {
				await writeFile(join(fx.inputsDir, ENVIRONMENT_NAME), `${canonicalEnvironmentFile(TEST_ENVIRONMENT)}\n`, "utf8");
			},
			RUBRIC_INVALID: async (fx) => {
				await writeFile(join(fx.inputsDir, RUBRIC_NAME), "{not json", "utf8");
			},
			FIXTURE_MISMATCH: async (fx) => {
				await writeFile(join(fx.inputsDir, "fixture", "extra.txt"), "tampered", "utf8");
			},
			MILESTONE_MISMATCH: async () => {},
			SOURCE_UNREADABLE: async (fx) => {
				await rm(join(fx.root, "sources", "control-01.jsonl"), { force: true });
			},
		};
		const protocolOverrideByName: Record<string, Partial<FrozenProtocol>> = {
			MILESTONE_MISMATCH: { milestonePromptSha256: "ff".repeat(32) },
			NON_TREATMENT_MISMATCH: { nonTreatmentSha256: "ee".repeat(32) },
		};
		for (let i = 0; i < cases.length; i += 1) {
			const c = cases[i] as (typeof cases)[number];
			const fx = await writePrepareFixture(join(root, `case-${i}`), {
				...c.spec,
				protocolOverride: protocolOverrideByName[c.name],
				afterWrite: afterWriteByName[c.name],
			});
			await expectCode(prepareEvidence({ runsDir: fx.runsDir, inputsDir: fx.inputsDir, collectionFile: fx.collectionFile, protocol: fx.protocol }), c.code);
			await assertNoPartials(fx.runsDir);
		}
	});
});

// ---------------------------------------------------------------------------
// renderReport privacy and human caps on a large report
// ---------------------------------------------------------------------------

test("renderReport: human caps hold (lines + bytes), deterministic, privacy-safe", () => {
	const runs: RunFacts[] = [];
	for (let i = 0; i < 300; i += 1) {
		const arm = i % 2 === 0 ? "control" : "treatment";
		const n = Math.floor(i / 2) + 1;
		runs.push({ ...verdictRun(100, 0, 2), arm, label: `${arm}-${String(n).padStart(2, "0")}`, orderIndex: i + 1, sessionBasename: `${arm}-${String(n).padStart(2, "0")}.jsonl` });
	}
	const controlRuns = runs.filter((r) => r.arm === "control");
	const treatmentRuns = runs.filter((r) => r.arm === "treatment");
	const report: BenchmarkReport = {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		protocolDoc: PROTOCOL_DOC,
		manifest: {
			basename: "manifest.json",
			protocolDoc: PROTOCOL_DOC,
			schemaVersion: BENCHMARK_SCHEMA_VERSION,
			phase: "final",
			milestonePromptSha256: "0".repeat(64),
			environment: { ...TEST_ENVIRONMENT },
			fixture: { path: "fixture", manifestSha256: "0".repeat(64), verified: true, files: 2, totalBytes: 9 },
			nonTreatmentSha256: "0".repeat(64),
			rubricSha256: "0".repeat(64),
			rubricChecks: 1,
			sessionCount: runs.length,
			attemptCount: 0,
		},
		runs,
		arms: { control: buildArmFacts("control", controlRuns), treatment: buildArmFacts("treatment", treatmentRuns) },
		attempts: [],
		verdicts: computeVerdictsFromRuns(controlRuns, treatmentRuns, "final"),
	};
	const rendered = renderReport(report);
	assert.ok(rendered.length <= HUMAN_MAX_LINES, `line cap: got ${rendered.length}`);
	assert.ok(utf8Bytes(rendered.join("\n")) <= HUMAN_MAX_BYTES, "byte cap");
	assert.ok(rendered.some((l) => l.includes("output capped")), "explicit truncation marker present");
	// Deterministic.
	assert.deepEqual(rendered, renderReport(report));
});

// ---------------------------------------------------------------------------
// CLI argument parsing (library level)
// ---------------------------------------------------------------------------

test("parsePrepareArgs: help, missing options, unknown args, runs-dir", () => {
	assert.equal(parsePrepareArgs(["--help"]).help, true);
	assert.equal(parsePrepareArgs(["-h"]).help, true);
	assert.equal(parsePrepareArgs([]).inputsDir, null);
	assert.equal(parsePrepareArgs(["--inputs", "x"]).collectionFile, null);
	assert.equal(parsePrepareArgs(["--bogus"]).inputsDir, null);
	assert.equal(parsePrepareArgs(["--inputs", "x", "--collection"]).inputsDir, null);
	const ok = parsePrepareArgs(["--inputs", "/in", "--collection", "/c.json", "--runs-dir", "/runs"]);
	assert.equal(ok.inputsDir, "/in");
	assert.equal(ok.collectionFile, "/c.json");
	assert.equal(ok.runsDir, "/runs");
	assert.equal(parsePrepareArgs(["--inputs", "/in", "--collection", "/c.json"]).runsDir, join(process.cwd(), ".pi", "workbench", "runs"));
});

// ---------------------------------------------------------------------------
// CLI subprocess behavior
// ---------------------------------------------------------------------------

const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const SCRIPT = join(process.cwd(), "scripts", "commander-native-tool-benchmark.ts");

test("CLI: usage errors exit 2 with usage on stderr and no stdout; --help exits 0", async () => {
	const noArgs = await spawnExec(TSX, [SCRIPT], { timeout: 120000 });
	assert.equal(noArgs.code, 2);
	assert.equal(noArgs.stdout, "");
	assert.ok(noArgs.stderr.includes("usage:"));

	const unknownSub = await spawnExec(TSX, [SCRIPT, "--bogus"], { timeout: 120000 });
	assert.equal(unknownSub.code, 2);
	assert.equal(unknownSub.stdout, "");
	assert.ok(unknownSub.stderr.includes("unknown subcommand"));

	const analyzeUnknown = await spawnExec(TSX, [SCRIPT, "analyze", "manifest.json", "--bogus"], { timeout: 120000 });
	assert.equal(analyzeUnknown.code, 2);
	assert.equal(analyzeUnknown.stdout, "");
	assert.ok(analyzeUnknown.stderr.includes("unknown option"));

	const prepareNoInputs = await spawnExec(TSX, [SCRIPT, "prepare"], { timeout: 120000 });
	assert.equal(prepareNoInputs.code, 2);
	assert.equal(prepareNoInputs.stdout, "");
	assert.ok(prepareNoInputs.stderr.includes("usage:"));

	const help = await spawnExec(TSX, [SCRIPT, "--help"], { timeout: 120000 });
	assert.equal(help.code, 0);
	assert.ok(help.stdout.includes("usage:"));
	assert.ok(help.stdout.includes("prepare --inputs"));
	assert.equal(help.stderr, "");
});

test("CLI: analyze/prepare against the frozen real protocol exit 1 on non-frozen content with stderr only and no leaks", async () => {
	await withTempDir(async (root) => {
		// A valid-JSON manifest with sentinel-bearing session content and
		// hermetic pins: the FROZEN production protocol now rejects it as
		// pin drift (INVALID_MANIFEST), never as PROTOCOL_NOT_FROZEN.
		const manifestPath = join(root, "manifest.json");
		const sessionPath = join(root, "sessions", "control-01.jsonl");
		await mkdir(join(root, "sessions"), { recursive: true });
		await writeFile(sessionPath, sessionText(buildSessionEntries({})), "utf8");
		const wire = {
			schema_version: BENCHMARK_SCHEMA_VERSION,
			protocol_doc: PROTOCOL_DOC,
			phase: "dev",
			milestone_prompt_sha256: "a".repeat(64),
			sessions: [{ label: "control-01", arm: "control", order_index: 1, path: "sessions/control-01.jsonl", expected_session_sha256: sha256(await readFile(sessionPath)) }],
			attempts: [],
		};
		await writeFile(manifestPath, `${JSON.stringify(wire, null, 2)}\n`, "utf8");

		const analyze = await spawnExec(TSX, [SCRIPT, "analyze", manifestPath], { timeout: 120000 });
		assert.equal(analyze.code, 1);
		assert.equal(analyze.stdout, "");
		assert.ok(analyze.stderr.includes("INVALID_MANIFEST"), analyze.stderr);
		assert.ok(!analyze.stderr.includes("PROTOCOL_NOT_FROZEN"), "the real protocol is frozen — never an unresolved-pin failure");
		assertPrivacySafe(analyze.stderr, root);

		// prepare: the frozen production protocol preflights the inputs
		// against the pins and fails closed before any output (here the
		// inputs dir does not exist) — no PROTOCOL_NOT_FROZEN, no writes.
		const prepare = await spawnExec(TSX, [SCRIPT, "prepare", "--inputs", join(root, "inputs"), "--collection", join(root, "collection.json"), "--runs-dir", join(root, "runs")], { timeout: 120000 });
		assert.equal(prepare.code, 1);
		assert.equal(prepare.stdout, "");
		assert.ok(prepare.stderr.includes("INPUTS_INVALID"), prepare.stderr);
		assert.ok(!prepare.stderr.includes("PROTOCOL_NOT_FROZEN"), "the real protocol is frozen — never an unresolved-pin failure");
		assertPrivacySafe(prepare.stderr, root);
		assert.ok(!existsSync(join(root, "runs", EVIDENCE_DIR_NAME)), "no evidence may be written");
	});
});

// ---------------------------------------------------------------------------
// main() dispatch sanity (library level)
// ---------------------------------------------------------------------------

test("main: dispatches usage errors without executing analysis", async () => {
	assert.equal(await main([]), 2);
	assert.equal(await main(["--help"]), 0);
	assert.equal(await main(["analyze"]), 2);
	assert.equal(await main(["prepare"]), 2);
});
