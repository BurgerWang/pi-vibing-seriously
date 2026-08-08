/**
 * Commander token P9 benchmark-preparation analyzer tests (offline CLI +
 * library): frozen-protocol pinning (milestone prompt hash, environment,
 * P0/P3 reference facts, exact frozen P3 rule, the three preserved P3 pre
 * hashes/labels), strict manifest validation (exactly 3 baseline + 3
 * current sessions, expected per-session SHA-256, bounded safe identity
 * strings), buildCostBreakdown-compatible machine facts, P0 targets that
 * are ALWAYS NOT_MEASURABLE with fixed basis-incomparable reasons,
 * comparable-milestone target arithmetic (exact 25/80/40% boundaries,
 * zero baselines, historical non-causal labelling), fail-closed rejection
 * (malformed/corrupt/missing/prompt mismatch/session-hash mismatch/model-
 * and-thinking environment mismatch/duplicates/path safety/over-bounds),
 * all-run retention, multibyte byte counting, successful-vs-error bytes,
 * privacy (no raw content / no absolute paths / unsafe identity strings
 * rejected), deterministic bounded rendering with line/byte caps,
 * no-write behavior and CLI-facing behavior.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { buildCostBreakdown } from "../extensions/workbench-runtime/core/cost-breakdown.ts";
import {
	BENCHMARK_SCHEMA_VERSION,
	FROZEN_PROTOCOL,
	HUMAN_MAX_BYTES,
	HUMAN_MAX_LINES,
	LABEL_MAX_CHARS,
	MANIFEST_MAX_BYTES,
	MAX_USAGE_FACT,
	BenchmarkError,
	analyzeManifestFile,
	applyCaps,
	classifyComparableTargets,
	computeRunFacts,
	emptyCohortTotals,
	extractPromptText,
	p0TargetResults,
	parseManifest,
	renderReport,
	type BenchmarkManifest,
	type BenchmarkReport,
	type CohortName,
	type CohortTotals,
	type FrozenProtocol,
	type ManifestSession,
	type P0ReferenceFacts,
	type P3ReferenceFacts,
	type RunFacts,
} from "../scripts/commander-token-benchmark.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const P3_PROMPT_SHA = "01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f"; // frozen P3 extracted-text hash (P3 record §4.3)

/** The frozen milestone prompt (extracted first user-message text of the preserved P3 sessions). */
const PROMPT_TEXT = [
	"Perform one read-only repository evidence milestone.",
	"Do not modify files, use shell, run recipes, tests or gates, delegate work, or ask questions.",
	"Collect these five facts:",
	"1. Package name, version, and sorted script names from package.json.",
	"2. First H1 heading and exact number of H2 headings in docs/worker-delegation.md.",
	"3. Sorted names of direct *.ts files under extensions/workbench-runtime/cache whose basenames begin with c or p.",
	"4. Exact count of the literal WORKER_SPEND_PROFILE_ENV in extensions/workbench-runtime/core/worker-spend.ts.",
	"5. Gate IDs declared in .pi/workbench/gates.yaml.",
	"Use only read, grep, find, or ls as needed.",
	"End with exactly five numbered lines, each citing its evidence path. Keep the final answer within 10 lines.",
].join("\n");

function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

assert.equal(sha256Hex(PROMPT_TEXT), P3_PROMPT_SHA);

function userEntry(text: string = PROMPT_TEXT): Record<string, unknown> {
	return { type: "message", id: "u-1", message: { role: "user", content: [{ type: "text", text }] } };
}

interface AssistantOptions {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	provider?: string;
	model?: string;
	toolCall?: { name: string; arguments: Record<string, unknown> };
	thinking?: string;
}

function assistantEntry(opts: AssistantOptions = {}): Record<string, unknown> {
	const content: Record<string, unknown>[] = [];
	if (opts.thinking !== undefined) content.push({ type: "thinking", thinking: opts.thinking });
	if (opts.toolCall) content.push({ type: "toolCall", id: "call-1", name: opts.toolCall.name, arguments: opts.toolCall.arguments });
	content.push({ type: "text", text: "ack" });
	return {
		type: "message",
		id: "a-1",
		message: {
			role: "assistant",
			provider: opts.provider ?? "openai-codex",
			model: opts.model ?? "gpt-5.6-sol",
			content,
			usage: {
				input: opts.input ?? 100,
				output: opts.output ?? 10,
				cacheRead: opts.cacheRead ?? 0,
				cacheWrite: opts.cacheWrite ?? 0,
				cost: { total: opts.cost ?? 0.01 },
			},
		},
	};
}

function toolResultEntry(toolName: string, text: string, isError?: boolean): Record<string, unknown> {
	const message: Record<string, unknown> = { role: "toolResult", toolName, content: [{ type: "text", text }] };
	if (isError !== undefined) message.isError = isError;
	return { type: "message", id: "t-1", message };
}

function compactionEntry(): Record<string, unknown> {
	return { type: "compaction", id: "cp-1", timestamp: "2026-08-05T10:00:00.000Z" };
}

function thinkingChange(level: string): Record<string, unknown> {
	return { type: "thinking_level_change", id: "th-1", timestamp: "2026-08-05T10:00:00.000Z", thinkingLevel: level };
}

function sessionText(entries: unknown[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function p0Reference(overrides: Partial<P0ReferenceFacts> = {}): P0ReferenceFacts {
	return {
		commanderRequests: 187,
		commanderInputTokens: 1530854,
		commanderOutputTokens: 111430,
		commanderCacheReadTokens: 21961216,
		commanderCacheWriteTokens: 0,
		commanderGrossTokens: 23603500,
		toolResultTextBytes: 3276725,
		...overrides,
	};
}

function p3Reference(overrides: Partial<P3ReferenceFacts> = {}): P3ReferenceFacts {
	return {
		preTotalRequests: 8,
		currentTotalRequests: 8,
		requestReductionRatio: 0,
		verdict: "FAIL",
		rule: "PASS only if current total requests < pre total requests",
		...overrides,
	};
}

/** A fresh protocol derived from the frozen one (tests never mutate FROZEN_PROTOCOL). */
function testProtocol(): FrozenProtocol {
	return {
		...FROZEN_PROTOCOL,
		pinnedPreSessions: { ...FROZEN_PROTOCOL.pinnedPreSessions },
		finalCurrentLabels: [...FROZEN_PROTOCOL.finalCurrentLabels],
	};
}

interface FixtureSession {
	label: string;
	cohort: CohortName;
	entries: unknown[];
	file?: string;
}

interface FixtureOptions {
	p0?: Partial<P0ReferenceFacts>;
	p3?: Partial<P3ReferenceFacts>;
	/** Override the on-disk session text (for malformed/corrupt/prompt/environment fixtures). */
	rawText?: Record<string, string>;
	/** Extra sessions with a custom path/hash that must NOT be written (path-safety/dup fixtures). */
	extraSessions?: ManifestSession[];
}

/** Serialize the TS manifest shape to the strict on-disk snake_case JSON schema. */
function manifestToJson(manifest: BenchmarkManifest): string {
	const p0 = manifest.p0Reference;
	const p3 = manifest.p3Reference;
	return JSON.stringify(
		{
			schema_version: manifest.schemaVersion,
			milestone_prompt_sha256: manifest.milestonePromptSha256,
			environment: {
				model_key: manifest.environment.modelKey,
				thinking_level: manifest.environment.thinkingLevel,
			},
			p0_reference: {
				commander_requests: p0.commanderRequests,
				commander_input_tokens: p0.commanderInputTokens,
				commander_output_tokens: p0.commanderOutputTokens,
				commander_cache_read_tokens: p0.commanderCacheReadTokens,
				commander_cache_write_tokens: p0.commanderCacheWriteTokens,
				commander_gross_tokens: p0.commanderGrossTokens,
				tool_result_text_bytes: p0.toolResultTextBytes,
			},
			p3_reference: {
				pre_total_requests: p3.preTotalRequests,
				current_total_requests: p3.currentTotalRequests,
				request_reduction_ratio: p3.requestReductionRatio,
				verdict: p3.verdict,
				rule: p3.rule,
			},
			sessions: manifest.sessions.map((s) => ({ label: s.label, cohort: s.cohort, path: s.path, expected_session_sha256: s.expectedSessionSha256 })),
		},
		null,
		2,
	);
}

/**
 * Write session files under <root>/bench/sessions and the manifest at
 * <root>/bench/manifest.json. Baseline (pre-1..pre-3) expected hashes are
 * pinned in `protocol.pinnedPreSessions` to the ACTUAL fixture file bytes;
 * every session's expected_session_sha256 is the actual fixture file hash
 * (for current sessions this mirrors the "resolved at collection time"
 * flow). Returns the manifest path.
 */
async function writeFixture(root: string, fixture: { sessions: FixtureSession[] } & FixtureOptions, protocol: FrozenProtocol): Promise<string> {
	const dir = join(root, "bench");
	await mkdir(join(dir, "sessions"), { recursive: true });
	const sessions: ManifestSession[] = [];
	const pinned: Record<string, string> = { ...protocol.pinnedPreSessions };
	for (const s of fixture.sessions) {
		const file = s.file ?? `${s.label}.jsonl`;
		const text = fixture.rawText?.[s.label] ?? sessionText(s.entries);
		await writeFile(join(dir, "sessions", file), text, "utf8");
		const hash = sha256Hex(text);
		if (s.cohort === "baseline") pinned[s.label] = hash;
		sessions.push({ label: s.label, cohort: s.cohort, path: `sessions/${file}`, expectedSessionSha256: hash });
	}
	protocol.pinnedPreSessions = pinned;
	for (const extra of fixture.extraSessions ?? []) sessions.push(extra);
	const manifest: BenchmarkManifest = {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		milestonePromptSha256: protocol.milestonePromptSha256,
		environment: protocol.environment,
		p0Reference: p0Reference(fixture.p0),
		p3Reference: p3Reference(fixture.p3),
		sessions,
	};
	const manifestPath = join(dir, "manifest.json");
	await writeFile(manifestPath, `${manifestToJson(manifest)}\n`, "utf8");
	return manifestPath;
}

/** The six-session standard fixture used by the aggregation tests. */
function standardSessions(): FixtureSession[] {
	return [
		{
			label: "pre-1",
			cohort: "baseline",
			entries: [
				{ type: "session", version: 3, id: "s1", timestamp: "2026-08-05T10:00:00.000Z" },
				{ type: "session_info", id: "i1", parentId: null, timestamp: "2026-08-05T10:00:00.000Z", name: "bench-pre-1" },
				{ type: "model_change", id: "mc1", parentId: "i1", timestamp: "2026-08-05T10:00:00.000Z", provider: "openai-codex", modelId: "gpt-5.6-sol" },
				thinkingChange("high"),
				userEntry(),
				{ type: "custom", customType: "workbench-cache-state", data: { schemaVersion: "1.1", hashedSessionId: "abc", requestCount: 1 } },
				assistantEntry({ input: 1000, output: 100, cacheRead: 500, cost: 0.01 }),
				toolResultEntry("read", "abcdefghij"),
				assistantEntry({ input: 2000, output: 200, cacheRead: 500, cost: 0.02, toolCall: { name: "read", arguments: { path: "package.json" } } }),
				toolResultEntry("read", "0123456789ABCDEFGHIJ"),
				toolResultEntry("grep", "012345678901234567890123456789"),
				compactionEntry(),
			],
		},
		{
			label: "pre-2",
			cohort: "baseline",
			entries: [
				thinkingChange("high"),
				userEntry(),
				assistantEntry({ input: 500, output: 50, cost: 0.005 }),
				toolResultEntry("read", "0123456789012345678901234567890123456789", true),
				toolResultEntry("find", "0123456789ABCDEFGHIJ"),
			],
		},
		{
			label: "pre-3",
			cohort: "baseline",
			entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 250, output: 25, cost: 0.0025 })],
		},
		{
			label: "final-current-1",
			cohort: "current",
			entries: [
				thinkingChange("high"),
				userEntry(),
				assistantEntry({ input: 100, output: 10, cost: 0.001 }),
				toolResultEntry("read", "12345"),
				assistantEntry({ input: 200, output: 20, cost: 0.002 }),
				toolResultEntry("grep", "67890"),
			],
		},
		{
			label: "final-current-2",
			cohort: "current",
			entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 50, output: 5, cost: 0.0005 }), toolResultEntry("read", "x".repeat(100))],
		},
		{
			label: "final-current-3",
			cohort: "current",
			entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 60, output: 6, cost: 0.0006 }), toolResultEntry("ls", "x")],
		},
	];
}

function currentTotals(overrides: Partial<CohortTotals> = {}): CohortTotals {
	return { ...emptyCohortTotals(), ...overrides };
}

function expectCode(promise: Promise<unknown>, code: BenchmarkError["code"]): Promise<BenchmarkError> {
	return promise.then(
		() => {
			assert.fail(`expected BenchmarkError ${code}, got success`);
			throw new Error("unreachable");
		},
		(error: unknown) => {
			assert.ok(error instanceof BenchmarkError, `expected BenchmarkError, got ${String(error)}`);
			assert.equal(error.code, code);
			return error;
		},
	);
}

/** A manifest whose sessions are exactly the six pinned labels (hashes from the protocol). */
function validManifest(protocol: FrozenProtocol): BenchmarkManifest {
	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		milestonePromptSha256: protocol.milestonePromptSha256,
		environment: protocol.environment,
		// The p0/p3 facts are sourced from the SUPPLIED protocol so an
		// alternate pinned protocol (e.g. the PASS-case fixture) serializes
		// its own reference facts consistently.
		p0Reference: protocol.p0Reference,
		p3Reference: protocol.p3Reference,
		sessions: [
			{ label: "pre-1", cohort: "baseline", path: "sessions/pre-1.jsonl", expectedSessionSha256: protocol.pinnedPreSessions["pre-1"] ?? "" },
			{ label: "pre-2", cohort: "baseline", path: "sessions/pre-2.jsonl", expectedSessionSha256: protocol.pinnedPreSessions["pre-2"] ?? "" },
			{ label: "pre-3", cohort: "baseline", path: "sessions/pre-3.jsonl", expectedSessionSha256: protocol.pinnedPreSessions["pre-3"] ?? "" },
			{ label: "final-current-1", cohort: "current", path: "sessions/final-current-1.jsonl", expectedSessionSha256: "1".repeat(64) },
			{ label: "final-current-2", cohort: "current", path: "sessions/final-current-2.jsonl", expectedSessionSha256: "2".repeat(64) },
			{ label: "final-current-3", cohort: "current", path: "sessions/final-current-3.jsonl", expectedSessionSha256: "3".repeat(64) },
		],
	};
}

// ---------------------------------------------------------------------------
// Frozen protocol pinning (regression against the P3/P0 records)
// ---------------------------------------------------------------------------

test("FROZEN_PROTOCOL pins the P0/P3 record facts, prompt hash, environment and pre hashes exactly", () => {
	assert.equal(FROZEN_PROTOCOL.milestonePromptSha256, P3_PROMPT_SHA);
	assert.deepEqual(FROZEN_PROTOCOL.environment, { modelKey: "openai-codex/gpt-5.6-sol", thinkingLevel: "high" });
	assert.deepEqual(FROZEN_PROTOCOL.p0Reference, p0Reference());
	assert.deepEqual(FROZEN_PROTOCOL.p3Reference, p3Reference());
	// The three preserved P3 pre-session raw-byte hashes (P3 record §4.3).
	assert.deepEqual(FROZEN_PROTOCOL.pinnedPreSessions, {
		"pre-1": "08b7467e3945b913d8a7e5f81cb890cc057078ed6b50973f7d4dff4c3f5744ec",
		"pre-2": "a245d51db3a030f69028af82d80ffdfb3870c9ef68c099d43b3d7df2c331a899",
		"pre-3": "93aad011fbccd7b60b380f4825c3b4d9ebb753c1fe91da424a17b412b5cd677b",
	});
	assert.deepEqual(FROZEN_PROTOCOL.finalCurrentLabels, ["final-current-1", "final-current-2", "final-current-3"]);
	assert.equal(FROZEN_PROTOCOL.p3Reference.rule, "PASS only if current total requests < pre total requests");
});

// ---------------------------------------------------------------------------
// Manifest parsing (strict)
// ---------------------------------------------------------------------------

test("parseManifest: strict schema — unknown keys, wrong version, bad/mismatched prompt hash, environment, pinned references, bad sessions", () => {
	const protocol = testProtocol();
	assert.equal(parseManifest(manifestToJson(validManifest(protocol)), protocol).sessions.length, 6);

	// Mutations operate on the serialized (snake_case) JSON so unknown-key
	// and wrong-type cases are exercised exactly as the parser sees them.
	const base = JSON.parse(manifestToJson(validManifest(protocol))) as Record<string, any>;
	const cases: Array<{ mutate: (m: Record<string, any>) => void; code: BenchmarkError["code"] }> = [
		// Top-level / schema / prompt hash.
		{ mutate: (m) => (m.extra = 1), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.schema_version = 2), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.milestone_prompt_sha256 = "zzz"), code: "INVALID_MANIFEST" },
		{ mutate: (m) => delete m.milestone_prompt_sha256, code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.milestone_prompt_sha256 = "0".repeat(64)), code: "INVALID_MANIFEST" }, // valid hex but not the frozen hash
		// Environment (missing/mismatch/unsafe).
		{ mutate: (m) => delete m.environment, code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.environment.extra = 1), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.environment.model_key = "openai/gpt-5.6-sol"), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.environment.model_key = "bad model!"), code: "MODEL_UNSAFE" },
		{ mutate: (m) => (m.environment.thinking_level = "low"), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.environment.thinking_level = "high\nlow"), code: "THINKING_UNSAFE" },
		// P0 reference.
		{ mutate: (m) => (m.p0_reference.commander_gross_tokens = 1), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.p0_reference.commander_input_tokens = -1), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.p0_reference.commander_requests = 1.5), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.p0_reference.commander_requests = 5), code: "INVALID_MANIFEST" }, // valid int but not the pinned fact
		{ mutate: (m) => (m.p0_reference.commander_requests = 1e12), code: "INVALID_MANIFEST" }, // over MAX_USAGE_FACT
		// P3 reference.
		{ mutate: (m) => (m.p3_reference.request_reduction_ratio = 0.5), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.p3_reference.verdict = "PASS"), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.p3_reference.verdict = "BLOCKED"), code: "INVALID_MANIFEST" },
		{ mutate: (m) => ((m.p3_reference.pre_total_requests = 0), (m.p3_reference.request_reduction_ratio = 0)), code: "INVALID_MANIFEST" },
		{ mutate: (m) => ((m.p3_reference.pre_total_requests = 7), (m.p3_reference.request_reduction_ratio = -1 / 7)), code: "INVALID_MANIFEST" }, // consistent but not the pinned facts
		// Sessions: labels.
		{ mutate: (m) => (m.sessions[0].label = ""), code: "LABEL_UNSAFE" },
		{ mutate: (m) => (m.sessions[0].label = "evil\nINJECTED"), code: "LABEL_UNSAFE" },
		{ mutate: (m) => (m.sessions[0].label = "a".repeat(LABEL_MAX_CHARS + 1)), code: "LABEL_UNSAFE" },
		{ mutate: (m) => (m.sessions[0].label = "with/slash"), code: "LABEL_UNSAFE" },
		{ mutate: (m) => (m.sessions[0].cohort = "bogus"), code: "INVALID_MANIFEST" },
		{ mutate: (m) => delete m.sessions[0].cohort, code: "INVALID_MANIFEST" },
		// Sessions: paths.
		{ mutate: (m) => (m.sessions[0].path = ""), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.sessions[0].path = "sessions/" + "x".repeat(600)), code: "OVER_BOUND" },
		{ mutate: (m) => (m.sessions[0].path = "sessions/bad name.jsonl"), code: "BASENAME_UNSAFE" },
		// Sessions: expected hashes.
		{ mutate: (m) => delete m.sessions[0].expected_session_sha256, code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.sessions[0].expected_session_sha256 = "zzz"), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.sessions[0].expected_session_sha256 = "f".repeat(64)), code: "INVALID_MANIFEST" }, // != pinned preserved P3 hash
		// Sessions: shape/keys.
		{ mutate: (m) => (m.sessions[0].extra = 1), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.sessions[0] = "nope"), code: "INVALID_MANIFEST" },
		{ mutate: (m) => (m.sessions = "nope"), code: "INVALID_MANIFEST" },
		// Duplicates / cohort shape.
		{ mutate: (m) => (m.sessions[3].label = "pre-1"), code: "DUPLICATE_LABEL" },
		{ mutate: (m) => (m.sessions = m.sessions.slice(0, 5)), code: "COHORT_COUNT" },
		{ mutate: (m) => (m.sessions = m.sessions.slice(0, 3)), code: "COHORT_COUNT" },
		{ mutate: (m) => (m.sessions = m.sessions.slice(3)), code: "COHORT_COUNT" },
		{ mutate: (m) => (m.sessions = []), code: "COHORT_COUNT" },
		{ mutate: (m) => (m.sessions[0].label = "pre-x"), code: "COHORT_COUNT" },
		{ mutate: (m) => (m.sessions[3].label = "final-current-9"), code: "COHORT_COUNT" },
		{ mutate: (m) => (m.sessions[3].cohort = "baseline"), code: "COHORT_COUNT" },
	];
	for (const { mutate, code } of cases) {
		const m = structuredClone(base);
		mutate(m);
		assert.throws(() => parseManifest(JSON.stringify(m), protocol), (e: unknown) => e instanceof BenchmarkError && e.code === code, `expected ${code}`);
	}
	assert.throws(() => parseManifest("{not json", protocol), (e: unknown) => e instanceof BenchmarkError && e.code === "INVALID_MANIFEST");
	assert.throws(() => parseManifest("[1,2]", protocol), (e: unknown) => e instanceof BenchmarkError && e.code === "INVALID_MANIFEST");

	// P3 reference consistency: pre 8 / current 8 -> ratio 0.0 and FAIL.
	const p3 = parseManifest(manifestToJson(validManifest(protocol)), protocol).p3Reference;
	assert.equal(p3.preTotalRequests, 8);
	assert.equal(p3.currentTotalRequests, 8);
	assert.equal(p3.requestReductionRatio, 0);
	assert.equal(p3.verdict, "FAIL");
	// A consistent PASS case (pre 8, current 7 -> ratio 0.125) still passes
	// the derived-rule check but must equal the pinned facts — so a protocol
	// carrying those pinned facts accepts it.
	const passProtocol = testProtocol();
	passProtocol.p3Reference = { preTotalRequests: 8, currentTotalRequests: 7, requestReductionRatio: 0.125, verdict: "PASS", rule: "PASS only if current total requests < pre total requests" };
	const pass = validManifest(passProtocol);
	assert.equal(parseManifest(manifestToJson(pass), passProtocol).p3Reference.verdict, "PASS");
});

test("parseManifest: the frozen P3 rule is exact, not merely non-empty", () => {
	const protocol = testProtocol();
	const base = JSON.parse(manifestToJson(validManifest(protocol))) as Record<string, any>;
	const variants: unknown[] = [
		"",
		"PASS only if current total requests <= pre total requests",
		"PASS only if current total requests < pre total requests ",
		"pass only if current total requests < pre total requests",
		42,
		null,
	];
	for (const rule of variants) {
		const m = structuredClone(base);
		m.p3_reference.rule = rule;
		assert.throws(() => parseManifest(JSON.stringify(m), protocol), (e: unknown) => e instanceof BenchmarkError && e.code === "P3_RULE_MISMATCH", `rule ${JSON.stringify(rule)}`);
	}
});

test("parseManifest: p0 gross identity and integer requirements are enforced", () => {
	const protocol = testProtocol();
	const m = validManifest(protocol);
	assert.equal(parseManifest(manifestToJson(m), protocol).p0Reference.commanderGrossTokens, 23603500);
	const broken = JSON.parse(manifestToJson(m)) as Record<string, any>;
	broken.p0_reference.commander_gross_tokens = broken.p0_reference.commander_input_tokens + broken.p0_reference.commander_output_tokens + broken.p0_reference.commander_cache_read_tokens + broken.p0_reference.commander_cache_write_tokens + 1;
	assert.throws(() => parseManifest(JSON.stringify(broken), protocol), (e: unknown) => e instanceof BenchmarkError && e.code === "INVALID_MANIFEST");
});

// ---------------------------------------------------------------------------
// Valid aggregation (buildCostBreakdown-compatible facts)
// ---------------------------------------------------------------------------

test("analyzeManifestFile: per-run facts and cohort totals match hand-computed arithmetic", async () => {
	await withTempDir(async (root) => {
		const protocol = testProtocol();
		const manifestPath = await writeFixture(root, { sessions: standardSessions() }, protocol);
		const report = await analyzeManifestFile(manifestPath, protocol);

		assert.equal(report.schemaVersion, BENCHMARK_SCHEMA_VERSION);
		assert.equal(report.protocolDoc, "docs/baselines/commander-token-p9-protocol.md");
		assert.equal(report.manifest.basename, "manifest.json");
		assert.equal(report.manifest.sessionCount, 6);
		assert.equal(report.manifest.baselineSessionCount, 3);
		assert.equal(report.manifest.currentSessionCount, 3);
		assert.equal(report.manifest.milestonePromptSha256, P3_PROMPT_SHA);
		assert.deepEqual(report.manifest.environment, { modelKey: "openai-codex/gpt-5.6-sol", thinkingLevel: "high" });
		assert.deepEqual(report.manifest.p0Reference, p0Reference());

		// All declared runs retained, in manifest order.
		assert.deepEqual(report.runs.map((r) => r.label), ["pre-1", "pre-2", "pre-3", "final-current-1", "final-current-2", "final-current-3"]);

		const pre1 = report.runs[0] as RunFacts;
		assert.equal(pre1.requests, 2);
		assert.equal(pre1.input, 3000);
		assert.equal(pre1.output, 300);
		assert.equal(pre1.cacheRead, 1000);
		assert.equal(pre1.cacheWrite, 0);
		assert.equal(pre1.gross, 4300); // exactly input + output + cacheRead + cacheWrite
		assert.equal(pre1.cost, 0.03);
		assert.equal(pre1.compactions, 1);
		assert.equal(pre1.toolResultEntries, 3);
		assert.equal(pre1.successfulToolResultEntries, 3);
		assert.equal(pre1.totalTextBytes, 60);
		assert.equal(pre1.successfulTextBytes, 60);
		assert.deepEqual(pre1.perTool, [
			{ toolName: "grep", entries: 1, textBytes: 30, successfulEntries: 1, successfulTextBytes: 30 },
			{ toolName: "read", entries: 2, textBytes: 30, successfulEntries: 2, successfulTextBytes: 30 },
		]);
		assert.deepEqual(pre1.modelKeys, ["openai-codex/gpt-5.6-sol"]);
		assert.equal(pre1.thinkingLevel, "high");
		assert.equal(pre1.sessionBasename, "pre-1.jsonl");
		assert.match(pre1.sessionSha256, /^[0-9a-f]{64}$/);
		assert.equal(pre1.promptSha256, P3_PROMPT_SHA);
		assert.equal(pre1.promptMatches, true);
		// Session hash = SHA-256 of the raw file bytes, enforced against the manifest.
		assert.equal(pre1.sessionSha256, sha256Hex(sessionText(standardSessions()[0]?.entries ?? [])));

		const pre2 = report.runs[1] as RunFacts;
		assert.equal(pre2.requests, 1);
		assert.equal(pre2.gross, 550);
		assert.equal(pre2.cost, 0.005);
		assert.equal(pre2.toolResultEntries, 2);
		assert.equal(pre2.successfulToolResultEntries, 1);
		assert.equal(pre2.totalTextBytes, 60);
		assert.equal(pre2.successfulTextBytes, 20); // isError=true entry excluded from successful
		assert.deepEqual(pre2.perTool, [
			{ toolName: "find", entries: 1, textBytes: 20, successfulEntries: 1, successfulTextBytes: 20 },
			{ toolName: "read", entries: 1, textBytes: 40, successfulEntries: 0, successfulTextBytes: 0 },
		]);
		assert.equal(pre2.thinkingLevel, "high");

		const pre3 = report.runs[2] as RunFacts;
		assert.equal(pre3.requests, 1);
		assert.equal(pre3.gross, 275);
		assert.equal(pre3.totalTextBytes, 0);

		const fc1 = report.runs[3] as RunFacts;
		assert.equal(fc1.requests, 2);
		assert.equal(fc1.gross, 330);
		assert.equal(fc1.cost, 0.003);
		assert.equal(fc1.totalTextBytes, 10);
		assert.equal(fc1.successfulTextBytes, 10);
		const fc2 = report.runs[4] as RunFacts;
		assert.equal(fc2.requests, 1);
		assert.equal(fc2.gross, 55);
		assert.equal(fc2.cost, 0.0005);
		assert.equal(fc2.totalTextBytes, 100);
		assert.equal(fc2.successfulTextBytes, 100);
		const fc3 = report.runs[5] as RunFacts;
		assert.equal(fc3.requests, 1);
		assert.equal(fc3.gross, 66);
		assert.equal(fc3.totalTextBytes, 1);
		assert.equal(fc3.successfulTextBytes, 1);

		// Cohort totals (exactly 3 + 3 sessions).
		const baseline = report.cohorts.baseline;
		assert.equal(baseline.requests, 4);
		assert.equal(baseline.gross, 5125);
		assert.equal(baseline.cost, 0.0375);
		assert.equal(baseline.compactions, 1);
		assert.equal(baseline.toolResultEntries, 5);
		assert.equal(baseline.successfulToolResultEntries, 4);
		assert.equal(baseline.totalTextBytes, 120);
		assert.equal(baseline.successfulTextBytes, 80);
		const current = report.cohorts.current;
		assert.equal(current.requests, 4);
		assert.equal(current.gross, 451);
		assert.equal(current.cost, 0.0041);
		assert.equal(current.compactions, 0);
		assert.equal(current.totalTextBytes, 111);
		assert.equal(current.successfulTextBytes, 111);

		// P0 targets: all three always NOT_MEASURABLE with fixed reasons.
		assert.deepEqual(
			report.targets.p0Reference.map((t) => [t.id, t.status, t.reductionRatio]),
			[
				["p0_requests", "NOT_MEASURABLE", null],
				["p0_successful_inline_bytes", "NOT_MEASURABLE", null],
				["p0_gross_tokens", "NOT_MEASURABLE", null],
			],
		);
		for (const t of report.targets.p0Reference) {
			assert.ok(t.reason.includes("basis-incomparable"), t.reason);
			// The fixed reason never repeats the structured status token or
			// any other status vocabulary — the status itself is the only
			// classification on the rendered line.
			assert.ok(!t.reason.includes("NOT_MEASURABLE"), t.reason);
			assert.ok(!/ACHIEVED|MISSED|PASS/.test(t.reason), t.reason);
			assert.ok(!["ACHIEVED", "MISSED", "PASS"].includes(t.status));
		}
		assert.ok((report.targets.p0Reference[1] as { reason: string }).reason.includes("no isError split"));
		assert.ok((report.targets.p0Reference[1] as { reason: string }).reason.includes("3,276,725"));

		// Comparable-milestone targets: exact arithmetic pre vs current.
		assert.deepEqual(
			report.targets.comparableCohort.map((t) => [t.id, t.status]),
			[
				["comparable_requests", "MISSED"], // (4-4)/4 = 0.0 < 25%
				["comparable_successful_inline_bytes", "MISSED"], // (80-111)/80 < 0 < 80%
				["comparable_gross_tokens", "ACHIEVED"], // (5125-451)/5125 = 0.9120 >= 40%
			],
		);
		for (const t of report.targets.comparableCohort) {
			assert.ok(t.reason.includes("historical comparable-cohort arithmetic"), t.reason);
			assert.ok(t.reason.includes("3 preserved P3 pre sessions vs 3 fresh final-current sessions"), t.reason);
			assert.ok(t.reason.includes("non-causal"), t.reason);
			assert.ok(t.reason.includes("not strict P0 measurement"), t.reason);
		}
		assert.ok((report.targets.comparableCohort[0] as { reason: string }).reason.includes("reduction 0.0000 (current 4 vs pre 4) < threshold 25%"));
		assert.ok((report.targets.comparableCohort[2] as { reason: string }).reason.includes("reduction 0.9120 (current 451 vs pre 5125) >= threshold 40%"));
		// Status vocabulary never contains PASS.
		for (const t of [...report.targets.p0Reference, ...report.targets.comparableCohort]) assert.ok(["ACHIEVED", "MISSED", "NOT_MEASURABLE"].includes(t.status));
	});
});

test("facts reuse buildCostBreakdown semantics exactly (gross identity, requests, compactions, per-tool bytes)", async () => {
	const entries = standardSessions()[0]?.entries ?? [];
	const breakdown = buildCostBreakdown(entries);
	assert.equal(breakdown.commanderRequests, 2);
	assert.equal(breakdown.compactions, 1);
	assert.equal(breakdown.commander.tokens, 4300);
	assert.equal(breakdown.commander.input + breakdown.commander.output + breakdown.commander.cacheRead + breakdown.commander.cacheWrite, breakdown.commander.tokens);
	assert.equal(breakdown.toolTextBytesTotal, 60);
	assert.deepEqual(
		breakdown.toolTextBytes.map((r) => [r.toolName, r.count, r.textBytes]),
		[
			["grep", 1, 30],
			["read", 2, 30],
		],
	);
	// computeRunFacts mirrors those facts.
	const facts = computeRunFacts("pre-1", "baseline", "pre-1.jsonl", "0".repeat(64), entries, P3_PROMPT_SHA, "openai-codex/gpt-5.6-sol", "high");
	assert.equal(facts.requests, breakdown.commanderRequests);
	assert.equal(facts.gross, breakdown.commander.tokens);
	assert.equal(facts.compactions, breakdown.compactions);
	assert.equal(facts.totalTextBytes, breakdown.toolTextBytesTotal);
	assert.deepEqual(
		facts.perTool.map((r) => [r.toolName, r.entries, r.textBytes]),
		[
			["grep", 1, 30],
			["read", 2, 30],
		],
	);
});

// ---------------------------------------------------------------------------
// P0 targets: always NOT_MEASURABLE
// ---------------------------------------------------------------------------

test("p0TargetResults: all three targets are ALWAYS NOT_MEASURABLE with fixed basis-incomparable reasons", () => {
	const targets = p0TargetResults();
	assert.equal(targets.length, 3);
	for (const t of targets) {
		assert.equal(t.kind, "p0_reference");
		assert.equal(t.status, "NOT_MEASURABLE");
		assert.equal(t.reductionRatio, null);
		assert.ok(t.reason.includes("basis-incomparable"), t.reason);
		// The reason explains the unmatched basis / no-isError split only —
		// it never repeats the structured status token and carries no other
		// status vocabulary (no NOT_MEASURABLE/ACHIEVED/MISSED/PASS).
		assert.ok(!t.reason.includes("NOT_MEASURABLE"), t.reason);
		assert.ok(!/ACHIEVED|MISSED|PASS/.test(t.reason), t.reason);
		assert.ok(!["ACHIEVED", "MISSED", "PASS"].includes(t.status));
	}
	assert.deepEqual(targets.map((t) => t.id), ["p0_requests", "p0_successful_inline_bytes", "p0_gross_tokens"]);
	const inline = targets[1] as { reason: string };
	assert.ok(inline.reason.includes("no isError split"), inline.reason);
	assert.ok(inline.reason.includes("3,276,725"), inline.reason);
	// Fixed reasons never depend on any current-cohort value.
	const again = p0TargetResults();
	assert.deepEqual(again, targets);
});

// ---------------------------------------------------------------------------
// Comparable-milestone target arithmetic
// ---------------------------------------------------------------------------

test("classifyComparableTargets: exact 25%/80%/40% boundaries are ACHIEVED", () => {
	const pre = currentTotals({ requests: 4, gross: 1000, successfulTextBytes: 100 });
	const current = currentTotals({ requests: 3, gross: 600, successfulTextBytes: 20 });
	const targets = classifyComparableTargets(pre, current, 3, 3);
	assert.deepEqual(
		targets.map((t) => [t.id, t.status, t.reductionRatio]),
		[
			["comparable_requests", "ACHIEVED", 0.25],
			["comparable_successful_inline_bytes", "ACHIEVED", 0.8],
			["comparable_gross_tokens", "ACHIEVED", 0.4],
		],
	);
	for (const t of targets) {
		assert.equal(t.kind, "comparable_cohort");
		assert.ok(t.reason.includes("historical comparable-cohort arithmetic"), t.reason);
		assert.ok(t.reason.includes("3 preserved P3 pre sessions vs 3 fresh final-current sessions"), t.reason);
		assert.ok(t.reason.includes("non-causal, not strict P0 measurement"), t.reason);
		assert.ok(t.reason.includes(">="), t.reason);
	}
	assert.ok((targets[0] as { reason: string }).reason.includes("reduction 0.2500 (current 3 vs pre 4) >= threshold 25%"));
	assert.ok((targets[1] as { reason: string }).reason.includes("reduction 0.8000 (current 20 vs pre 100) >= threshold 80%"));
	assert.ok((targets[2] as { reason: string }).reason.includes("reduction 0.4000 (current 600 vs pre 1000) >= threshold 40%"));
});

test("classifyComparableTargets: values just below the thresholds are MISSED", () => {
	const pre = currentTotals({ requests: 4, gross: 1000, successfulTextBytes: 100 });
	const current = currentTotals({ requests: 4, gross: 601, successfulTextBytes: 21 });
	const targets = classifyComparableTargets(pre, current, 3, 3);
	assert.deepEqual(
		targets.map((t) => [t.id, t.status, t.reductionRatio]),
		[
			["comparable_requests", "MISSED", 0],
			["comparable_successful_inline_bytes", "MISSED", 0.79],
			["comparable_gross_tokens", "MISSED", 0.399],
		],
	);
	for (const t of targets) assert.ok(t.reason.includes("< threshold"), t.reason);
});

test("classifyComparableTargets: zero pre baselines are NOT_MEASURABLE, never PASS", () => {
	const pre = currentTotals({});
	const current = currentTotals({ requests: 5, gross: 999, successfulTextBytes: 42 });
	const targets = classifyComparableTargets(pre, current, 3, 3);
	assert.deepEqual(
		targets.map((t) => [t.id, t.status, t.reductionRatio]),
		[
			["comparable_requests", "NOT_MEASURABLE", null],
			["comparable_successful_inline_bytes", "NOT_MEASURABLE", null],
			["comparable_gross_tokens", "NOT_MEASURABLE", null],
		],
	);
	for (const t of targets) {
		assert.ok(t.reason.includes("zero denominator"), t.reason);
		assert.ok(t.reason.includes("never PASS"), t.reason);
		assert.ok(!["ACHIEVED", "MISSED", "PASS"].includes(t.status));
	}
});

// ---------------------------------------------------------------------------
// Fail-closed: malformed/corrupt sessions
// ---------------------------------------------------------------------------

test("fail closed: malformed JSONL (bad line, non-object line, truncated line, empty file)", async () => {
	await withTempDir(async (root) => {
		const protocol = testProtocol();
		const bad = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				rawText: { "pre-1": `${JSON.stringify(userEntry())}\n{this is not json\n` },
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(bad, protocol), "MALFORMED_JSONL");

		const nonObject = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				rawText: { "final-current-1": `${JSON.stringify(userEntry())}\n[1,2,3]\n` },
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(nonObject, protocol), "MALFORMED_JSONL");

		const truncated = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				rawText: { "pre-1": '{"type":"message","message":{"role":"assistant"\n' },
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(truncated, protocol), "MALFORMED_JSONL");

		const messageWithoutObject = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				rawText: { "final-current-1": `${JSON.stringify({ type: "message", id: "x" })}\n` },
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(messageWithoutObject, protocol), "MALFORMED_JSONL");

		const emptyFile = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				rawText: { "pre-1": "" },
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(emptyFile, protocol), "MISSING_USER_MESSAGE");
	});
});

/** The minimal valid six-session fixture (one assistant per session). */
function simpleSessions(): FixtureSession[] {
	return [
		{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
		{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
		{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
		{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
		{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
		{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
	];
}

test("fail closed: non-finite, negative, non-number, non-integer and over-bound usage facts", async () => {
	await withTempDir(async (root) => {
		const variants: Array<{ mutate: (a: AssistantOptions) => AssistantOptions; code: BenchmarkError["code"] }> = [
			{ mutate: (o) => ({ ...o, input: 1e999 }), code: "INVALID_FACTS" }, // parses to Infinity
			{ mutate: (o) => ({ ...o, output: -5 }), code: "INVALID_FACTS" },
			{ mutate: (o) => ({ ...o, cacheRead: 10.5 }), code: "INVALID_FACTS" }, // tokens must be integers
			{ mutate: (o) => ({ ...o, input: MAX_USAGE_FACT + 1 }), code: "INVALID_FACTS" }, // over the documented numeric bound
			{ mutate: (o) => ({ ...o, cost: 1e999 }), code: "INVALID_FACTS" },
			{ mutate: (o) => ({ ...o, cost: -0.5 }), code: "INVALID_FACTS" },
			{ mutate: (o) => ({ ...o, cost: MAX_USAGE_FACT + 1 }), code: "INVALID_FACTS" },
		];
		for (const { mutate, code } of variants) {
			const protocol = testProtocol();
			const bad = await writeFixture(
				root,
				{
					sessions: [
						{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry(mutate({}))] },
						{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
						{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
						{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
						{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
						{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					],
				},
				protocol,
			);
			await expectCode(analyzeManifestFile(bad, protocol), code);
		}

		const protocol = testProtocol();
		// String usage component.
		const stringUsage = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				rawText: {
					"pre-1": `${JSON.stringify(userEntry())}\n${JSON.stringify({
						type: "message",
						message: { role: "assistant", usage: { input: "100", output: 1, cacheRead: 0, cacheWrite: 0 } },
					})}\n`,
				},
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(stringUsage, protocol), "INVALID_FACTS");

		// Malformed cost shape.
		const badCost = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				rawText: {
					"pre-1": `${JSON.stringify(userEntry())}\n${JSON.stringify({
						type: "message",
						message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 5 } },
					})}\n`,
				},
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(badCost, protocol), "INVALID_FACTS");
	});
});

test("fail closed: missing assistant usage and missing user message / prompt text", async () => {
	await withTempDir(async (root) => {
		// No assistant messages at all.
		const protocol = testProtocol();
		const noAssistant = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(noAssistant, protocol), "MISSING_ASSISTANT_USAGE");

		// Assistant message without a usage object.
		const missingUsage = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				rawText: {
					"pre-1": `${JSON.stringify(userEntry())}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x" }] } })}\n`,
				},
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(missingUsage, protocol), "MISSING_ASSISTANT_USAGE");

		// No user message.
		const noUser = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(noUser, protocol), "MISSING_USER_MESSAGE");

		// First user message without extractable text.
		const emptyPrompt = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(""), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(emptyPrompt, protocol), "MISSING_PROMPT_TEXT");
	});
});

test("fail closed: prompt-hash mismatch (session text differs from the frozen milestone prompt)", async () => {
	await withTempDir(async (root) => {
		const protocol = testProtocol();
		const manifestPath = await writeFixture(
			root,
			{
				sessions: standardSessions(),
				rawText: { "pre-1": sessionText([thinkingChange("high"), userEntry("a completely different milestone prompt"), assistantEntry()]) },
			},
			protocol,
		);
		const error = await expectCode(analyzeManifestFile(manifestPath, protocol), "PROMPT_MISMATCH");
		assert.ok(error.message.includes("milestone prompt SHA-256"));
	});
});

// ---------------------------------------------------------------------------
// Fail-closed: session-hash and environment enforcement
// ---------------------------------------------------------------------------

test("fail closed: raw session bytes must match expected_session_sha256 (HASH_MISMATCH)", async () => {
	await withTempDir(async (root) => {
		// Tampered preserved pre session (bytes changed after the manifest pinned its hash).
		const protocol = testProtocol();
		const tamperedPre = await writeFixture(root, { sessions: standardSessions() }, protocol);
		await writeFile(join(root, "bench", "sessions", "pre-1.jsonl"), `${sessionText(standardSessions()[0]?.entries ?? [])}\n`, "utf8");
		const error = await expectCode(analyzeManifestFile(tamperedPre, protocol), "HASH_MISMATCH");
		assert.ok(error.message.includes("pre-1"));

		// Tampered fresh current session.
		const protocol2 = testProtocol();
		const tamperedCurrent = await writeFixture(root, { sessions: standardSessions() }, protocol2);
		await writeFile(join(root, "bench", "sessions", "final-current-1.jsonl"), `${sessionText(standardSessions()[3]?.entries ?? [])}extra\n`, "utf8");
		await expectCode(analyzeManifestFile(tamperedCurrent, protocol2), "HASH_MISMATCH");

		// Manifest declares a wrong (but valid-hex) expected hash for a
		// current session — the hash is "resolved at collection time", so
		// the declared value must equal the actual raw bytes.
		const protocol3 = testProtocol();
		const wrongCurrent = await writeFixture(root, { sessions: standardSessions() }, protocol3);
		const manifestJson = JSON.parse(await readFile(wrongCurrent, "utf8")) as Record<string, any>;
		manifestJson.sessions[3].expected_session_sha256 = "0".repeat(64);
		await writeFile(wrongCurrent, `${JSON.stringify(manifestJson, null, 2)}\n`, "utf8");
		await expectCode(analyzeManifestFile(wrongCurrent, protocol3), "HASH_MISMATCH");
	});
});

test("fail closed: model identity and thinking level must match the expected environment", async () => {
	await withTempDir(async (root) => {
		// Different model on one assistant message.
		const protocol = testProtocol();
		const wrongModel = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry({ model: "gpt-4o" })] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
			},
			protocol,
		);
		const modelError = await expectCode(analyzeManifestFile(wrongModel, protocol), "MODEL_MISMATCH");
		assert.ok(modelError.message.includes("openai-codex/gpt-5.6-sol"));

		// Multiple different model keys within one session.
		const protocol2 = testProtocol();
		const multiModel = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{
						label: "final-current-1",
						cohort: "current",
						entries: [thinkingChange("high"), userEntry(), assistantEntry(), assistantEntry({ provider: "openai", model: "gpt-4o" })],
					},
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
			},
			protocol2,
		);
		await expectCode(analyzeManifestFile(multiModel, protocol2), "MODEL_MISMATCH");

		// Missing provider -> "unknown/..." key.
		const protocol3 = testProtocol();
		const missingProvider = await writeFixture(
			root,
			{
				sessions: simpleSessions(),
				rawText: {
					"final-current-1": `${JSON.stringify(userEntry())}\n${JSON.stringify({
						type: "message",
						message: { role: "assistant", model: "gpt-5.6-sol", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
					})}\n`,
				},
			},
			protocol3,
		);
		await expectCode(analyzeManifestFile(missingProvider, protocol3), "MODEL_MISMATCH");

		// A hostile provider string is sanitized inside the error message.
		const protocol4 = testProtocol();
		const hostileProvider = await writeFixture(
			root,
			{
				sessions: simpleSessions(),
				rawText: {
					"final-current-1": `${JSON.stringify(userEntry())}\n${JSON.stringify({
						type: "message",
						message: { role: "assistant", provider: "\nEVIL", model: "gpt-5.6-sol", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
					})}\n`,
				},
			},
			protocol4,
		);
		const hostileError = await expectCode(analyzeManifestFile(hostileProvider, protocol4), "MODEL_MISMATCH");
		assert.ok(!/[\x00-\x1f\x7f]/.test(hostileError.message), "error message must carry no control characters");

		// No thinking_level_change entry at all.
		const protocol5 = testProtocol();
		const noThinking = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
			},
			protocol5,
		);
		await expectCode(analyzeManifestFile(noThinking, protocol5), "MISSING_THINKING_LEVEL");

		// Recorded thinking level differs from the expected environment.
		const protocol6 = testProtocol();
		const wrongThinking = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("low"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
			},
			protocol6,
		);
		const thinkingError = await expectCode(analyzeManifestFile(wrongThinking, protocol6), "THINKING_MISMATCH");
		assert.ok(thinkingError.message.includes("high"));
	});
});

test("fail closed: unsafe or over-bound tool names are rejected", async () => {
	await withTempDir(async (root) => {
		const protocol = testProtocol();
		const newlineTool = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry(), toolResultEntry("read\nEVIL", "x")] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
			},
			protocol,
		);
		const error = await expectCode(analyzeManifestFile(newlineTool, protocol), "TOOL_NAME_UNSAFE");
		assert.ok(!/[\x00-\x1f\x7f]/.test(error.message), "error message must carry no control characters");

		const protocol2 = testProtocol();
		const longTool = await writeFixture(
			root,
			{
				sessions: simpleSessions(),
				rawText: {
					"final-current-1": `${JSON.stringify(userEntry())}\n${JSON.stringify(assistantEntry())}\n${JSON.stringify(toolResultEntry("a".repeat(65), "x"))}\n`,
				},
			},
			protocol2,
		);
		await expectCode(analyzeManifestFile(longTool, protocol2), "TOOL_NAME_UNSAFE");
	});
});

// ---------------------------------------------------------------------------
// Fail-closed: duplicates and path safety
// ---------------------------------------------------------------------------

test("fail closed: duplicate labels and duplicate session paths (realpath-based)", async () => {
	await withTempDir(async (root) => {
		// Same relative path declared twice under different labels.
		const protocol = testProtocol();
		const dupPath = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				extraSessions: [{ label: "final-current-3", cohort: "current", path: "sessions/final-current-1.jsonl", expectedSessionSha256: "0".repeat(64) }],
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(dupPath, protocol), "DUPLICATE_PATH");

		// Different spellings of the same file ("./" prefix) still collide via realpath.
		const protocol2 = testProtocol();
		const spellings = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				extraSessions: [{ label: "final-current-3", cohort: "current", path: "./sessions/final-current-1.jsonl", expectedSessionSha256: "0".repeat(64) }],
			},
			protocol2,
		);
		await expectCode(analyzeManifestFile(spellings, protocol2), "DUPLICATE_PATH");

		// Duplicate labels are caught at manifest parse time.
		const protocol3 = testProtocol();
		const dupLabel = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				extraSessions: [{ label: "pre-1", cohort: "current", path: "sessions/final-current-1.jsonl", expectedSessionSha256: "0".repeat(64) }],
			},
			protocol3,
		);
		await expectCode(analyzeManifestFile(dupLabel, protocol3), "DUPLICATE_LABEL");
	});
});

test("fail closed: path safety — absolute, drive, UNC, traversal, NUL, missing, directory, symlink escape", async () => {
	await withTempDir(async (root) => {
		const unsafePaths: Array<{ path: string; code: BenchmarkError["code"] }> = [
			{ path: "/etc/passwd", code: "PATH_UNSAFE" },
			{ path: "C:\\evil.jsonl", code: "BASENAME_UNSAFE" },
			{ path: "\\\\server\\share\\x.jsonl", code: "BASENAME_UNSAFE" },
			{ path: "../escape.jsonl", code: "PATH_UNSAFE" },
			{ path: "..\\escape.jsonl", code: "BASENAME_UNSAFE" }, // backslash in the basename fails the safe-basename check at parse
			{ path: "sessions/../escape.jsonl", code: "PATH_UNSAFE" },
			{ path: "sessions/\0bad.jsonl", code: "BASENAME_UNSAFE" },
		];
		for (const { path, code } of unsafePaths) {
			const protocol = testProtocol();
			const fixture = await writeFixture(
				root,
				{
					sessions: [
						{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
						{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
						{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
						{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
						{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					],
					extraSessions: [{ label: "final-current-3", cohort: "current", path, expectedSessionSha256: "0".repeat(64) }],
				},
				protocol,
			);
			const error = await expectCode(analyzeManifestFile(fixture, protocol), code);
			assert.ok(!error.message.includes(root), "error message must not carry absolute input paths");
		}

		// Missing file.
		const protocol = testProtocol();
		const missing = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				extraSessions: [{ label: "final-current-3", cohort: "current", path: "sessions/does-not-exist.jsonl", expectedSessionSha256: "0".repeat(64) }],
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(missing, protocol), "FILE_MISSING");

		// A directory declared as a session file.
		await mkdir(join(root, "bench", "sessions", "adir"));
		const protocol2 = testProtocol();
		const directory = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
				extraSessions: [{ label: "final-current-3", cohort: "current", path: "sessions/adir", expectedSessionSha256: "0".repeat(64) }],
			},
			protocol2,
		);
		await expectCode(analyzeManifestFile(directory, protocol2), "FILE_MISSING");

		// Symlink escape (POSIX only): a link inside the manifest tree that
		// points to a file outside it must be refused via realpath.
		if (process.platform !== "win32") {
			const outside = join(root, "outside.jsonl");
			await writeFile(outside, sessionText([thinkingChange("high"), userEntry(), assistantEntry()]), "utf8");
			await symlink(outside, join(root, "bench", "sessions", "escape.jsonl"));
			const protocol3 = testProtocol();
			const escaped = await writeFixture(
				root,
				{
					sessions: [
						{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
						{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
						{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
						{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
						{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					],
					extraSessions: [{ label: "final-current-3", cohort: "current", path: "sessions/escape.jsonl", expectedSessionSha256: "0".repeat(64) }],
				},
				protocol3,
			);
			await expectCode(analyzeManifestFile(escaped, protocol3), "PATH_UNSAFE");
		}
	});
});

test("fail closed: missing manifest file, unreadable manifest, oversized manifest, unsafe manifest basename", async () => {
	await withTempDir(async (root) => {
		const error = await expectCode(analyzeManifestFile(join(root, "nope", "manifest.json")), "IO_ERROR");
		assert.ok(!error.message.includes(root), "error message must not carry absolute input paths");

		// Manifest over the documented byte cap.
		const protocol = testProtocol();
		const manifestPath = await writeFixture(root, { sessions: standardSessions() }, protocol);
		await writeFile(manifestPath, `x`.repeat(MANIFEST_MAX_BYTES + 1), "utf8");
		await expectCode(analyzeManifestFile(manifestPath, protocol), "OVER_BOUND");

		// Unsafe manifest basename is rejected (output-facing identity string).
		const unsafeName = join(root, "bench", "manifest with spaces.json");
		await writeFile(unsafeName, "{}", "utf8");
		await expectCode(analyzeManifestFile(unsafeName, protocol), "BASENAME_UNSAFE");
	});
});

test("fail closed: hard bounds — per-session bytes and JSONL lines", async () => {
	await withTempDir(async (root) => {
		// Session file over SESSION_MAX_BYTES (stat check before parsing).
		const protocol = testProtocol();
		const bigSession = await writeFixture(
			root,
			{
				sessions: simpleSessions(),
				rawText: { "final-current-1": `${JSON.stringify(userEntry())}\n${JSON.stringify(assistantEntry())}\n${JSON.stringify(toolResultEntry("read", "x".repeat(16 * 1024 * 1024 + 1)))}\n` },
			},
			protocol,
		);
		await expectCode(analyzeManifestFile(bigSession, protocol), "OVER_BOUND");

		// More than SESSION_MAX_LINES non-empty JSONL lines.
		const protocol2 = testProtocol();
		const manyLines = await writeFixture(
			root,
			{
				sessions: simpleSessions(),
				rawText: { "final-current-2": `${Array.from({ length: 100_001 }, () => JSON.stringify({ type: "session", version: 3 })).join("\n")}\n` },
			},
			protocol2,
		);
		await expectCode(analyzeManifestFile(manyLines, protocol2), "OVER_BOUND");
	});
});

// ---------------------------------------------------------------------------
// All-run retention, multibyte bytes, privacy, determinism, no writes
// ---------------------------------------------------------------------------

test("all declared runs are retained, including extreme and zero-byte runs", async () => {
	await withTempDir(async (root) => {
		const huge = "z".repeat(200_000);
		const protocol = testProtocol();
		const manifestPath = await writeFixture(
			root,
			{
				sessions: [
					{ label: "pre-1", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 10 }), toolResultEntry("read", "abc")] },
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 20 }), toolResultEntry("grep", huge)] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 30 })] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 40 }), toolResultEntry("ls", "x")] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 50, cost: 0.999999999 }), toolResultEntry("find", huge)] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 60 })] },
				],
			},
			protocol,
		);
		const report = await analyzeManifestFile(manifestPath, protocol);
		assert.equal(report.runs.length, 6);
		const byLabel = new Map(report.runs.map((r) => [r.label, r]));
		assert.equal((byLabel.get("pre-2") as RunFacts).totalTextBytes, 200_000);
		assert.equal((byLabel.get("pre-3") as RunFacts).totalTextBytes, 0);
		assert.equal((byLabel.get("pre-3") as RunFacts).toolResultEntries, 0);
		assert.equal((byLabel.get("final-current-2") as RunFacts).successfulTextBytes, 200_000);
		assert.equal((byLabel.get("final-current-2") as RunFacts).cost, 0.999999999);
		// No run is excluded: totals reflect all six.
		assert.equal(report.cohorts.current.totalTextBytes, 200_001);
		assert.equal(report.cohorts.baseline.totalTextBytes, 200_003);
	});
});

test("multibyte content is byte-counted as UTF-8, prompt hashing included", async () => {
	await withTempDir(async (root) => {
		const text1 = "héllo—世界 🚀";
		const text2 = "日本語テキストのテスト";
		const protocol = testProtocol();
		const manifestPath = await writeFixture(
			root,
			{
				sessions: [
					{
						label: "pre-1",
						cohort: "baseline",
						entries: [thinkingChange("high"), userEntry(), assistantEntry(), toolResultEntry("read", text1), toolResultEntry("read", text2, true)],
					},
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry(), toolResultEntry("read", text1)] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
			},
			protocol,
		);
		const report = await analyzeManifestFile(manifestPath, protocol);
		const pre1 = report.runs[0] as RunFacts;
		const expectedBytes = new TextEncoder().encode(text1).length + new TextEncoder().encode(text2).length;
		const expectedSuccess = new TextEncoder().encode(text1).length;
		assert.equal(pre1.totalTextBytes, expectedBytes);
		assert.equal(pre1.successfulTextBytes, expectedSuccess);
		assert.equal(pre1.perTool[0]?.textBytes, expectedBytes);
		assert.equal(pre1.perTool[0]?.successfulTextBytes, expectedSuccess);
		assert.equal(pre1.promptSha256, P3_PROMPT_SHA);
		assert.ok(pre1.totalTextBytes > text1.length + text2.length, "byte count must exceed character count for multibyte text");
	});
});

test("privacy: adversarial sentinels and absolute paths never appear in JSON or human output", async () => {
	await withTempDir(async (root) => {
		const sentinels = {
			arg: "TOP_SECRET_ARG_7x1",
			argPath: "/home/hanbaoji/forbidden/secret-file",
			result: "TOP_SECRET_RESULT_RAW_4b",
			thinking: "TOP_SECRET_THINKING_2q",
			secret: "BEARER_TOKEN_zz9",
		};
		// NOTE: the user-prompt sentinel is intentionally absent — the first
		// user-message text is pinned to the frozen milestone prompt (any
		// other text fails PROMPT_MISMATCH), so arbitrary prompt content can
		// never enter the analysis at all.
		const protocol = testProtocol();
		const manifestPath = await writeFixture(
			root,
			{
				sessions: [
					{
						label: "pre-1",
						cohort: "baseline",
						entries: [
							thinkingChange("high"),
							userEntry(),
							assistantEntry({
								thinking: sentinels.thinking,
								toolCall: { name: "read", arguments: { path: sentinels.argPath, pattern: sentinels.arg, secret: sentinels.secret } },
							}),
							toolResultEntry("read", sentinels.result),
						],
					},
					{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry(), toolResultEntry("grep", sentinels.result)] },
					{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
					{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry()] },
				],
			},
			protocol,
		);
		const report = await analyzeManifestFile(manifestPath, protocol);
		const json = JSON.stringify(report, null, 2);
		const human = renderReport(report).join("\n");
		for (const value of Object.values(sentinels)) {
			assert.ok(!json.includes(value), `JSON output must not contain sentinel ${value}`);
			assert.ok(!human.includes(value), `human output must not contain sentinel ${value}`);
		}
		assert.ok(!json.includes(root), "JSON output must not contain the absolute fixture root");
		assert.ok(!human.includes(root), "human output must not contain the absolute fixture root");
		assert.ok(!json.includes("/home/hanbaoji"), "no absolute path fragments");
		// Positive control: labels, basenames, hashes and numbers are present.
		assert.ok(json.includes("pre-1"));
		assert.ok(json.includes("pre-1.jsonl"));
		assert.ok(json.includes(report.runs[0]?.sessionSha256 ?? ""));
		assert.ok(json.includes(report.runs[0]?.promptSha256 ?? ""));
		assert.ok(human.includes("privacy"));
	});
});

test("deterministic output: identical JSON and identical human rendering across runs", async () => {
	await withTempDir(async (root) => {
		const protocol = testProtocol();
		const manifestPath = await writeFixture(root, { sessions: standardSessions() }, protocol);
		const first = await analyzeManifestFile(manifestPath, protocol);
		const second = await analyzeManifestFile(manifestPath, protocol);
		assert.equal(JSON.stringify(first, null, 2), JSON.stringify(second, null, 2));
		assert.deepEqual(renderReport(first), renderReport(second));
		const json = JSON.stringify(first);
		assert.ok(!json.includes("generatedAt") && !json.includes("timestamp"), "deterministic JSON must carry no timestamps");
		// Reason strings are deterministic numeric facts.
		assert.match(
			(first.targets.comparableCohort[0] as { reason: string }).reason,
			/^historical comparable-cohort arithmetic \(3 preserved P3 pre sessions vs 3 fresh final-current sessions; equal-size cohort totals; non-causal, not strict P0 measurement\): reduction [0-9.-]+ \(current [0-9]+ vs pre [0-9]+\) < threshold 25%$/,
		);
	});
});

test("the analyzer performs no file writes", async () => {
	await withTempDir(async (root) => {
		const protocol = testProtocol();
		const manifestPath = await writeFixture(root, { sessions: standardSessions() }, protocol);
		const before = await snapshotDir(root);
		await analyzeManifestFile(manifestPath, protocol);
		const after = await snapshotDir(root);
		assert.deepEqual(after, before, "analyzing must not create, modify or delete any file");
	});
});

async function snapshotDir(root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else out.push(`${path}:${await readFile(path, "utf8")}`);
		}
	};
	await walk(root);
	return out.sort();
}

// ---------------------------------------------------------------------------
// Prompt extraction semantics
// ---------------------------------------------------------------------------

test("extractPromptText: first user message only, multi-part concatenation, string content", () => {
	const multi = [userEntry("a"), userEntry("b")];
	assert.equal(extractPromptText(multi), "a");
	const parts = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "part1 " }, { type: "image", url: "x" }, { type: "text", text: "part2" }] } },
		userEntry(),
	];
	assert.equal(extractPromptText(parts), "part1 part2");
	const stringContent = [{ type: "message", message: { role: "user", content: "raw string prompt" } }];
	assert.equal(extractPromptText(stringContent), "raw string prompt");
	assert.throws(() => extractPromptText([]), (e: unknown) => e instanceof BenchmarkError && e.code === "MISSING_USER_MESSAGE");
});

test("computeRunFacts: prompt hash check and per-run identity/environment facts", () => {
	const entries = [thinkingChange("high"), userEntry(), assistantEntry({ provider: "openai-codex", model: "gpt-5.6-sol" }), toolResultEntry("read", "x")];
	const facts = computeRunFacts("final-current-1", "current", "final-current-1.jsonl", "a".repeat(64), entries, P3_PROMPT_SHA, "openai-codex/gpt-5.6-sol", "high");
	assert.equal(facts.requests, 1);
	assert.equal(facts.gross, 110);
	assert.equal(facts.promptMatches, true);
	assert.deepEqual(facts.modelKeys, ["openai-codex/gpt-5.6-sol"]);
	assert.equal(facts.thinkingLevel, "high");
	assert.throws(
		() => computeRunFacts("final-current-1", "current", "final-current-1.jsonl", "a".repeat(64), entries, sha256Hex("other"), "openai-codex/gpt-5.6-sol", "high"),
		(e: unknown) => e instanceof BenchmarkError && e.code === "PROMPT_MISMATCH",
	);
	assert.throws(
		() => computeRunFacts("final-current-1", "current", "final-current-1.jsonl", "a".repeat(64), entries, P3_PROMPT_SHA, "openai/gpt-4o", "high"),
		(e: unknown) => e instanceof BenchmarkError && e.code === "MODEL_MISMATCH",
	);
	assert.throws(
		() => computeRunFacts("final-current-1", "current", "final-current-1.jsonl", "a".repeat(64), entries, P3_PROMPT_SHA, "openai-codex/gpt-5.6-sol", "low"),
		(e: unknown) => e instanceof BenchmarkError && e.code === "THINKING_MISMATCH",
	);
	assert.throws(
		() => computeRunFacts("final-current-1", "current", "final-current-1.jsonl", "a".repeat(64), [userEntry(), assistantEntry()], P3_PROMPT_SHA, "openai-codex/gpt-5.6-sol", "high"),
		(e: unknown) => e instanceof BenchmarkError && e.code === "MISSING_THINKING_LEVEL",
	);
});

// ---------------------------------------------------------------------------
// Human rendering and output caps
// ---------------------------------------------------------------------------

test("applyCaps: deterministic line and byte caps with an explicit marker", () => {
	const lines = ["a".repeat(100), "b".repeat(100), "c".repeat(100)];
	const lineCapped = applyCaps(lines, 2, 1_000_000);
	assert.equal(lineCapped.length, 2);
	assert.equal(lineCapped[0], "a".repeat(100));
	assert.ok((lineCapped[1] ?? "").includes("capped"));

	const byteCapped = applyCaps(["x".repeat(100), "y".repeat(100)], 10, 150);
	assert.equal(byteCapped.length, 1);
	assert.ok((byteCapped[0] ?? "").includes("capped"));

	const singleHuge = applyCaps(["z".repeat(500)], 10, 200);
	assert.equal(singleHuge.length, 2);
	assert.ok((singleHuge[1] ?? "").includes("capped"));
	assert.ok(new TextEncoder().encode(singleHuge[0] ?? "").length <= 200);

	assert.deepEqual(applyCaps(lines, 200, 1_000_000), lines, "no truncation when under caps");
	assert.deepEqual(applyCaps(lines, 200, 1_000_000), applyCaps(lines, 200, 1_000_000), "deterministic");
});

test("renderReport: bounded deterministic lines carry the machine facts", async () => {
	await withTempDir(async (root) => {
		const protocol = testProtocol();
		const manifestPath = await writeFixture(root, { sessions: standardSessions() }, protocol);
		const report = await analyzeManifestFile(manifestPath, protocol);
		const lines = renderReport(report);
		assert.ok(lines[0]?.includes("offline analyzer"));
		assert.ok(lines.some((l) => l.includes("p0 reference") && l.includes("187")));
		assert.ok(lines.some((l) => l.includes("p3 reference") && l.includes("verdict FAIL")));
		assert.ok(lines.some((l) => l.includes("environment") && l.includes("openai-codex/gpt-5.6-sol")));
		assert.ok(lines.some((l) => l.includes("per-run facts")));
		assert.ok(lines.some((l) => l.includes("[baseline]") && l.includes("requests 2")));
		assert.ok(lines.some((l) => l.includes("[current]") && l.includes("requests 2")));
		assert.ok(lines.some((l) => l.includes("sha256") && l.includes(report.runs[0]?.sessionSha256 ?? "")));
		assert.ok(lines.some((l) => l.includes("cohort totals")));
		assert.ok(lines.some((l) => l.includes("baseline") && l.includes("requests 4") && l.includes("cost $0.037500")));
		assert.ok(lines.some((l) => l.includes("P0 references")));
		assert.ok(lines.some((l) => l.includes("NOT_MEASURABLE")));
		assert.ok(lines.some((l) => l.includes("comparable-milestone arithmetic")));
		assert.ok(lines.some((l) => l.includes("ACHIEVED")));
		assert.ok(lines.some((l) => l.includes("privacy")));
		// The P0 section carries exactly one structured NOT_MEASURABLE status
		// per line and no other status vocabulary: the fixed reasons explain
		// the unmatched basis only and never repeat or conflict with the status.
		const p0Section = lines.slice(lines.findIndex((l) => l.includes("P0 references")) + 1, lines.findIndex((l) => l.includes("comparable-milestone arithmetic")));
		for (const line of p0Section) {
			if (line.length === 0) continue; // section boundary blank line
			assert.equal(line.split("NOT_MEASURABLE").length - 1, 1, line);
			assert.ok(!/ACHIEVED|MISSED|PASS/.test(line), line);
		}
		// Hard caps hold.
		assert.ok(lines.length <= HUMAN_MAX_LINES, `lines ${lines.length} <= ${HUMAN_MAX_LINES}`);
		const totalBytes = lines.reduce((sum, l) => sum + new TextEncoder().encode(l).length, 0);
		assert.ok(totalBytes <= HUMAN_MAX_BYTES, `bytes ${totalBytes} <= ${HUMAN_MAX_BYTES}`);
		for (const line of lines) assert.ok(!line.includes("\n") && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(line), "no control characters in rendered lines");
	});
});

// ---------------------------------------------------------------------------
// CLI behavior
// ---------------------------------------------------------------------------

const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const SCRIPT = join(process.cwd(), "scripts", "commander-token-benchmark.ts");

/** Durable preserved P3 evidence root (protocol §2.4; gitignored, present wherever P9 prep runs). */
const P3_EVIDENCE_ROOT = join(process.cwd(), ".pi", "workbench", "runs", "commander-token-p3-benchmark");
/** Persisted P3 pre-session file names (P3 record §4.3 / protocol §2.4). */
const REAL_PRE_FILE_NAMES: Record<string, string> = {
	"pre-1": "2026-08-05T10-54-10-323Z_019fd18f-3193-739d-97ca-4d1b28fd4310.jsonl",
	"pre-2": "2026-08-05T10-56-52-803Z_019fd191-ac43-76fd-962f-9d77cb9d8e42.jsonl",
	"pre-3": "2026-08-05T10-57-23-421Z_019fd192-23dd-7ce3-b719-4b92182f9bf5.jsonl",
};

/**
 * Manifest for CLI subprocess tests: the CLI always runs the real
 * FROZEN_PROTOCOL, so baseline expected hashes are the REAL pinned
 * preserved P3 hashes (synthetic baseline bytes then fail HASH_MISMATCH at
 * analysis time, which is exactly what the hermetic failure tests assert).
 */
async function writeCliManifest(root: string, fixture: { sessions: FixtureSession[] }): Promise<string> {
	const dir = join(root, "bench");
	await mkdir(join(dir, "sessions"), { recursive: true });
	const sessions: ManifestSession[] = [];
	for (const s of fixture.sessions) {
		const file = s.file ?? `${s.label}.jsonl`;
		const text = sessionText(s.entries);
		await writeFile(join(dir, "sessions", file), text, "utf8");
		const expected = s.cohort === "baseline" ? (FROZEN_PROTOCOL.pinnedPreSessions[s.label] ?? "") : sha256Hex(text);
		sessions.push({ label: s.label, cohort: s.cohort, path: `sessions/${file}`, expectedSessionSha256: expected });
	}
	const manifest: BenchmarkManifest = {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		milestonePromptSha256: FROZEN_PROTOCOL.milestonePromptSha256,
		environment: FROZEN_PROTOCOL.environment,
		p0Reference: p0Reference(),
		p3Reference: p3Reference(),
		sessions,
	};
	const manifestPath = join(dir, "manifest.json");
	await writeFile(manifestPath, `${manifestToJson(manifest)}\n`, "utf8");
	return manifestPath;
}

test("CLI: success — human and --json output with exit 0 (byte-identical preserved P3 pre sessions)", async (t) => {
	const missing = Object.entries(REAL_PRE_FILE_NAMES).filter(([label, name]) => !existsSync(join(P3_EVIDENCE_ROOT, "sessions", label, name)));
	if (missing.length > 0) {
		t.skip(`preserved P3 pre evidence absent (${missing[0]?.[0]}); the CLI success path needs the byte-identical preserved pre sessions`);
		return;
	}
	await withTempDir(async (root) => {
		const dir = join(root, "bench");
		await mkdir(join(dir, "sessions"), { recursive: true });
		const sessions: ManifestSession[] = [];
		// Baseline: byte-for-byte copies of the preserved P3 pre sessions.
		for (const [label, name] of Object.entries(REAL_PRE_FILE_NAMES)) {
			await mkdir(join(dir, "sessions", label), { recursive: true });
			await copyFile(join(P3_EVIDENCE_ROOT, "sessions", label, name), join(dir, "sessions", label, name));
			sessions.push({ label, cohort: "baseline", path: `sessions/${label}/${name}`, expectedSessionSha256: FROZEN_PROTOCOL.pinnedPreSessions[label] ?? "" });
		}
		// Current: synthetic fresh sessions; expected hashes resolved at collection time.
		for (const s of simpleSessions().slice(3)) {
			const text = sessionText(s.entries);
			await writeFile(join(dir, "sessions", `${s.label}.jsonl`), text, "utf8");
			sessions.push({ label: s.label, cohort: s.cohort, path: `sessions/${s.label}.jsonl`, expectedSessionSha256: sha256Hex(text) });
		}
		const manifest: BenchmarkManifest = {
			schemaVersion: BENCHMARK_SCHEMA_VERSION,
			milestonePromptSha256: FROZEN_PROTOCOL.milestonePromptSha256,
			environment: FROZEN_PROTOCOL.environment,
			p0Reference: p0Reference(),
			p3Reference: p3Reference(),
			sessions,
		};
		const manifestPath = join(dir, "manifest.json");
		await writeFile(manifestPath, `${manifestToJson(manifest)}\n`, "utf8");

		const text = await spawnExec(TSX, [SCRIPT, manifestPath], { timeout: 120000 });
		assert.equal(text.code, 0);
		assert.ok(text.stdout.includes("commander token benchmark"));
		assert.ok(text.stdout.includes("targets"));
		assert.ok(text.stdout.includes("comparable-milestone arithmetic"));
		assert.ok(text.stdout.includes("NOT_MEASURABLE"));
		// The analyzer reproduces the pinned preserved P3 session hashes byte-for-byte.
		assert.ok(text.stdout.includes(FROZEN_PROTOCOL.pinnedPreSessions["pre-1"] ?? ""));
		assert.equal(text.stderr, "");

		const json = await spawnExec(TSX, [SCRIPT, manifestPath, "--json"], { timeout: 120000 });
		assert.equal(json.code, 0);
		const parsed = JSON.parse(json.stdout) as BenchmarkReport;
		assert.equal(parsed.runs.length, 6);
		assert.equal(parsed.targets.p0Reference.length, 3);
		assert.equal(parsed.targets.comparableCohort.length, 3);
		assert.equal(parsed.runs[0]?.sessionSha256, FROZEN_PROTOCOL.pinnedPreSessions["pre-1"]);
		assert.equal(parsed.runs[0]?.promptSha256, P3_PROMPT_SHA);
		assert.equal(parsed.runs[0]?.modelKeys[0], "openai-codex/gpt-5.6-sol");
		assert.equal(parsed.runs[0]?.thinkingLevel, "high");
		assert.ok(!json.stdout.includes(root), "CLI JSON output must not contain the absolute manifest path");

		// Deterministic across two identical invocations.
		const second = await spawnExec(TSX, [SCRIPT, manifestPath, "--json"], { timeout: 120000 });
		assert.equal(second.code, 0);
		assert.equal(second.stdout, json.stdout);
	});
});

test("CLI: failure exits 1 with the error code on stderr and empty stdout", async () => {
	await withTempDir(async (root) => {
		// Session-hash mismatch: baseline expected hashes are the REAL pinned
		// P3 hashes but the on-disk bytes are synthetic.
		const hashPath = await writeCliManifest(root, { sessions: simpleSessions() });
		const hashResult = await spawnExec(TSX, [SCRIPT, hashPath], { timeout: 120000 });
		assert.equal(hashResult.code, 1);
		assert.equal(hashResult.stdout, "");
		assert.ok(hashResult.stderr.includes("HASH_MISMATCH"));
		assert.ok(!hashResult.stderr.includes(root), "stderr must not carry absolute input paths");

		// Cohort-count violation (parse-level).
		const fiveSessions = await writeCliManifest(root, { sessions: simpleSessions().slice(0, 5) });
		const countResult = await spawnExec(TSX, [SCRIPT, fiveSessions], { timeout: 120000 });
		assert.equal(countResult.code, 1);
		assert.ok(countResult.stderr.includes("COHORT_COUNT"));

		const missing = await spawnExec(TSX, [SCRIPT, join(root, "no-manifest.json")], { timeout: 120000 });
		assert.equal(missing.code, 1);
		assert.ok(missing.stderr.includes("IO_ERROR"));
	});
});

test("CLI: usage errors exit 2, --help exits 0", async () => {
	const noArgs = await spawnExec(TSX, [SCRIPT], { timeout: 120000 });
	assert.equal(noArgs.code, 2);
	assert.ok(noArgs.stderr.includes("usage:"));
	assert.equal(noArgs.stdout, "");

	const unknown = await spawnExec(TSX, [SCRIPT, "x.json", "--bogus"], { timeout: 120000 });
	assert.equal(unknown.code, 2);
	assert.ok(unknown.stderr.includes("unknown option"));

	const help = await spawnExec(TSX, [SCRIPT, "--help"], { timeout: 120000 });
	assert.equal(help.code, 0);
	assert.ok(help.stdout.includes("usage:"));
	assert.ok(help.stdout.includes("--json"));
});

// ---------------------------------------------------------------------------
// Real P3-shaped evidence compatibility (frozen prompt hash, real entry types)
// ---------------------------------------------------------------------------

test("a P3-shaped session (real entry types, frozen prompt hash) analyzes with exact facts", async () => {
	await withTempDir(async (root) => {
		// The exact extracted first user-message text of the six preserved P3
		// sessions (milestone-prompt.txt content, no trailing newline); its
		// SHA-256 is the frozen protocol prompt identity.
		assert.equal(sha256Hex(PROMPT_TEXT), P3_PROMPT_SHA);
		const p3Shaped: FixtureSession[] = [
			{
				label: "pre-1",
				cohort: "baseline",
				entries: [
					{ type: "session", version: 3, id: "s", timestamp: "2026-08-05T10:54:10.323Z" },
					{ type: "session_info", id: "i", parentId: null, timestamp: "2026-08-05T10:54:10.323Z", name: "p3-pre-1" },
					{ type: "model_change", id: "mc", parentId: "i", timestamp: "2026-08-05T10:54:10.385Z", provider: "openai-codex", modelId: "gpt-5.6-sol" },
					{ type: "thinking_level_change", id: "tl", parentId: "mc", timestamp: "2026-08-05T10:54:10.385Z", thinkingLevel: "high" },
					userEntry(PROMPT_TEXT),
					assistantEntry({ input: 22533, output: 773, cacheRead: 15872, cost: 0.143791 }),
					toolResultEntry("read", "y".repeat(46425)),
					assistantEntry({ input: 1, output: 1, cost: 0.000001 }),
				],
			},
			{ label: "pre-2", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 8285, output: 762, cacheRead: 4608, cost: 0.066589 })] },
			{ label: "pre-3", cohort: "baseline", entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 22886, output: 865, cacheRead: 15872, cost: 0.148316 })] },
			{ label: "final-current-1", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 17283, output: 789, cacheRead: 4608, cost: 0.112389 }), toolResultEntry("read", "x".repeat(45493))] },
			{ label: "final-current-2", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 18140, output: 713, cacheRead: 20480, cost: 0.12233 })] },
			{ label: "final-current-3", cohort: "current", entries: [thinkingChange("high"), userEntry(), assistantEntry({ input: 27557, output: 1058, cacheRead: 19968, cost: 0.179509 })] },
		];
		const protocol = testProtocol();
		const manifestPath = await writeFixture(root, { sessions: p3Shaped }, protocol);
		const report = await analyzeManifestFile(manifestPath, protocol);
		const pre = report.runs[0] as RunFacts;
		assert.equal(pre.promptSha256, P3_PROMPT_SHA);
		assert.equal(pre.requests, 2);
		assert.equal(pre.gross, 22533 + 773 + 15872 + 1 + 1); // input+output+cacheRead+cacheWrite per run
		assert.equal(pre.totalTextBytes, 46425);
		assert.equal(pre.cost, 0.143792);
		assert.equal(pre.thinkingLevel, "high");
		assert.deepEqual(pre.modelKeys, ["openai-codex/gpt-5.6-sol"]);
		const cur = report.runs[3] as RunFacts;
		assert.equal(cur.promptSha256, P3_PROMPT_SHA);
		assert.equal(cur.totalTextBytes, 45493);
		// P3 pinned reference is reported (0.0 request reduction, FAIL).
		assert.equal(report.manifest.p3Reference.preTotalRequests, 8);
		assert.equal(report.manifest.p3Reference.requestReductionRatio, 0);
		assert.equal(report.manifest.p3Reference.verdict, "FAIL");
		// The preserved P3 current cohort is NOT pooled into the baseline:
		// baseline totals come from pre-1..pre-3 only.
		assert.equal(report.cohorts.baseline.requests, 4); // pre-1 (2) + pre-2 (1) + pre-3 (1)
		assert.equal(report.cohorts.current.requests, 3); // 1 per fresh final-current session
	});
});
