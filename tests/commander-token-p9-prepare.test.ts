/**
 * Commander token P9 evidence-preparation tests (offline CLI + library):
 * exact literal-vs-whitespace prompt classification and unrelated-text
 * rejection, bounded terminal facts, deviations derivation against the
 * fixed category/aborted table (invalid-4 and invalid-5 are the only
 * aborted attempts),
 * corrected-session frozen-protocol prevalidation (prompt/model/thinking/
 * compaction/aborted/error/nonterminal failures), baseline byte-identity
 * preflight (missing/ambiguous/hash mismatch), source preflight failures
 * (arity, duplicate, missing, directory, malformed, oversized, unsafe
 * basename), existing-output refusal, byte-exact staging/commit with
 * EXCLUSIVE create primitives (non-recursive mkdir + open("wx")) and
 * ownership-tracked rollback (foreign pre-existing/racing outputs always
 * survive; hook-driven failures after evidence ownership and after
 * manifest open leave no invocation-owned partial outputs), privacy (no
 * absolute paths, no raw content), CLI behavior (help/arity/errors/
 * success), and the package.json / recipes.yaml wiring (commander:prepare
 * script, 11 required string params, artifact-only writes/artifacts,
 * uncached recipes, unchanged existing recipe semantics).
 *
 * Fixtures are small generated Pi-like sessions under a custom FrozenProtocol
 * with generated pinned baseline hashes — production sessions are never
 * copied (except the CLI success path, which byte-copies the preserved P3
 * pre sessions into a temp runs dir exactly like the analyzer CLI tests).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { parse as parseYaml } from "yaml";

import { buildArgv, parseRecipesDocument } from "../extensions/workbench-runtime/core/recipe-schema.ts";
import {
	FROZEN_PROTOCOL,
	SESSION_MAX_BYTES,
	BenchmarkError,
	analyzeManifestFile,
	extractPromptText,
	parseManifest,
	type FrozenProtocol,
} from "../scripts/commander-token-benchmark.ts";
import {
	DEVIATIONS_NAME,
	DEVIATIONS_SCHEMA_VERSION,
	FINAL_CURRENT_LABELS,
	INVALID_EXPECTATIONS,
	INVALID_LABELS,
	MILESTONE_PROMPT_PATH_LITERAL,
	P3_EVIDENCE_DIR,
	P9_EVIDENCE_DIR,
	P9_MANIFEST_NAME,
	PrepareError,
	currentSessionPath,
	deriveInvalidAttempt,
	invalidAttemptPath,
	isLiteralPathPrompt,
	normalizeWhitespace,
	parseArgs,
	prepareEvidence,
	promptMismatchKind,
	terminalStateOf,
	type PrepareResult,
} from "../scripts/commander-token-p9-prepare.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Fixture constants and entry builders
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Distinctive multi-line milestone prompt for the custom-protocol fixtures. */
const PROMPT_TEXT = [
	"P9 prepare hermetic fixture milestone prompt.",
	"Private milestone marker: P9FROZEN-9f2c-bb71.",
	"Second instruction line.",
	"Third instruction line.",
].join("\n");

const PROMPT_SHA = sha256Hex(PROMPT_TEXT);

/** Raw-content markers that must NEVER appear in any prepared output. */
const PRIVATE_MILESTONE_MARKER = "P9FROZEN-9f2c-bb71";
const PRIVATE_ASSISTANT_MARKER = "P9PRIVATE-ASSISTANT-1b3d";

/** Five byte-different whitespace-corrupted variants (all whitespace-equivalent to the prompt). */
function whitespaceVariants(prompt: string): string[] {
	return [
		prompt.replace(/\n/g, " "),
		prompt.replace(/\n/g, "  "),
		prompt.replace(/\n/g, " \n ").replace(/\n/g, " "),
		prompt.replace(/\n/g, "\t"),
		`\n${prompt.replace(/\n/g, " ")}\n`,
	];
}

const WHITESPACE_VARIANTS = whitespaceVariants(PROMPT_TEXT);

/** The frozen milestone prompt text (extracted first user-message text of the preserved P3 sessions). */
const FROZEN_PROMPT_TEXT = [
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

// Frozen-pin regression: the CLI always runs FROZEN_PROTOCOL, so its
// corrected sessions must hash to the frozen milestone prompt hash.
assert.equal(sha256Hex(FROZEN_PROMPT_TEXT), FROZEN_PROTOCOL.milestonePromptSha256);

function userEntry(text: string): Record<string, unknown> {
	return { type: "message", id: "u-1", message: { role: "user", content: [{ type: "text", text }] } };
}

interface AssistantOptions {
	stopReason?: string;
	provider?: string;
	model?: string;
}

function assistantEntry(opts: AssistantOptions = {}): Record<string, unknown> {
	return {
		type: "message",
		id: "a-1",
		message: {
			role: "assistant",
			provider: opts.provider ?? "openai-codex",
			model: opts.model ?? "gpt-5.6-sol",
			content: [{ type: "text", text: `ack ${PRIVATE_ASSISTANT_MARKER}` }],
			stopReason: opts.stopReason ?? "stop",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
		},
	};
}

function toolResultEntry(): Record<string, unknown> {
	return { type: "message", id: "t-1", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "ok" }] } };
}

function thinkingChange(level: string): Record<string, unknown> {
	return { type: "thinking_level_change", id: "th-1", timestamp: "2026-08-05T10:00:00.000Z", thinkingLevel: level };
}

function compactionEntry(): Record<string, unknown> {
	return { type: "compaction", id: "cp-1", timestamp: "2026-08-05T10:00:00.000Z" };
}

function sessionText(entries: unknown[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** One disclosed invalid collection attempt: user prompt deviation + terminal assistant message. */
function invalidEntries(prompt: string, opts: { stopReason?: string } = {}): unknown[] {
	return [
		{ type: "session", version: 3, id: "s-inv", timestamp: "2026-08-05T10:00:00.000Z" },
		userEntry(prompt),
		assistantEntry({ stopReason: opts.stopReason ?? "stop" }),
	];
}

interface CorrectedOptions {
	prompt?: string;
	/** undefined = "high"; null = omit the thinking_level_change entry. */
	thinking?: string | null;
	provider?: string;
	model?: string;
	stopReason?: string;
	compaction?: boolean;
}

/** One corrected final-current session (frozen benchmark semantics). */
function correctedEntries(opts: CorrectedOptions = {}): unknown[] {
	const entries: unknown[] = [
		{ type: "session", version: 3, id: "s-cur", timestamp: "2026-08-05T10:00:00.000Z" },
		{ type: "session_info", id: "i1", parentId: null, timestamp: "2026-08-05T10:00:00.000Z", name: "p9-fixture" },
		{ type: "model_change", id: "mc1", parentId: "i1", timestamp: "2026-08-05T10:00:00.000Z", provider: "openai-codex", modelId: "gpt-5.6-sol" },
	];
	if (opts.thinking !== null) entries.push(thinkingChange(opts.thinking ?? "high"));
	entries.push(userEntry(opts.prompt ?? PROMPT_TEXT));
	if (opts.compaction) entries.push(compactionEntry());
	entries.push(assistantEntry({ provider: opts.provider, model: opts.model, stopReason: opts.stopReason }));
	return entries;
}

const PRE_LABELS = ["pre-1", "pre-2", "pre-3"] as const;

/** A fresh protocol derived from the frozen one with a fixture milestone prompt hash. */
function testProtocol(): FrozenProtocol {
	return {
		...FROZEN_PROTOCOL,
		milestonePromptSha256: PROMPT_SHA,
		environment: { ...FROZEN_PROTOCOL.environment },
		p0Reference: { ...FROZEN_PROTOCOL.p0Reference },
		p3Reference: { ...FROZEN_PROTOCOL.p3Reference },
		pinnedPreSessions: { ...FROZEN_PROTOCOL.pinnedPreSessions },
		finalCurrentLabels: [...FROZEN_PROTOCOL.finalCurrentLabels],
	};
}

interface PrepareFixture {
	runsDir: string;
	/** Exactly 11 source paths in fixed chronological order. */
	sources: string[];
	/** Raw bytes of each source, in the same order. */
	sourceBytes: Buffer[];
	protocol: FrozenProtocol;
	/** Extracted prompt text of each invalid attempt (post-mutation). */
	invalidPrompts: Record<string, string>;
}

interface FixtureMutators {
	invalid?: (label: string, entries: unknown[], prompt: string, stopReason: string) => unknown[];
	current?: (label: string, entries: unknown[], prompt: string) => unknown[];
	/** Wholesale raw-file text overrides by label (malformed/oversized fixtures). */
	rawText?: Partial<Record<string, string>>;
}

/**
 * Write a complete hermetic fixture: preserved P3 baseline sessions whose
 * generated bytes are pinned into the returned protocol, eight disclosed
 * invalid attempt sources (categories/aborted per the fixed table) and
 * three corrected final-current sources. Returns the runs dir, the eleven
 * source paths, the raw source bytes and the derived protocol.
 */
async function writePrepareFixture(root: string, mutators: FixtureMutators = {}): Promise<PrepareFixture> {
	const runsDir = join(root, "runs");
	const sourcesDir = join(root, "sources");
	await mkdir(runsDir, { recursive: true });
	await mkdir(sourcesDir, { recursive: true });

	const protocol = testProtocol();
	const pinned: Record<string, string> = {};
	for (const label of PRE_LABELS) {
		const dir = join(runsDir, P3_EVIDENCE_DIR, "sessions", label);
		await mkdir(dir, { recursive: true });
		const text = sessionText(correctedEntries());
		await writeFile(join(dir, `${label}.jsonl`), text, "utf8");
		pinned[label] = sha256Hex(text);
	}
	protocol.pinnedPreSessions = pinned;

	const sources: string[] = [];
	const sourceBytes: Buffer[] = [];
	const invalidPrompts: Record<string, string> = {};
	for (let i = 0; i < INVALID_LABELS.length; i += 1) {
		const label = INVALID_LABELS[i] as string;
		const expected = INVALID_EXPECTATIONS[label] as { category: "literal_path_prompt" | "whitespace_corrupted_prompt"; aborted: boolean };
		const defaultPrompt =
			expected.category === "literal_path_prompt"
				? label === "invalid-1"
					? MILESTONE_PROMPT_PATH_LITERAL
					: label === "invalid-2"
						? `  ${MILESTONE_PROMPT_PATH_LITERAL}  `
						: `\t${MILESTONE_PROMPT_PATH_LITERAL}\n`
				: (WHITESPACE_VARIANTS[i - 3] as string);
		const stopReason = expected.aborted ? "aborted" : "stop";
		let entries = invalidEntries(defaultPrompt, { stopReason });
		if (mutators.invalid) entries = mutators.invalid(label, entries, defaultPrompt, stopReason);
		invalidPrompts[label] = extractPromptText(entries);
		const file = join(sourcesDir, `${label}.jsonl`);
		const text = mutators.rawText?.[label] ?? sessionText(entries);
		await writeFile(file, text, "utf8");
		sources.push(file);
		sourceBytes.push(Buffer.from(text, "utf8"));
	}
	for (const label of FINAL_CURRENT_LABELS) {
		let entries = correctedEntries();
		if (mutators.current) entries = mutators.current(label, entries, PROMPT_TEXT);
		const file = join(sourcesDir, `${label}.jsonl`);
		const text = mutators.rawText?.[label] ?? sessionText(entries);
		await writeFile(file, text, "utf8");
		sources.push(file);
		sourceBytes.push(Buffer.from(text, "utf8"));
	}
	return { runsDir, sources, sourceBytes, protocol, invalidPrompts };
}

/** Expect a PrepareError/BenchmarkError (or injected coded error) with the exact code. */
async function expectPrepareCode(promise: Promise<unknown>, code: string): Promise<Error> {
	return promise.then(
		() => {
			assert.fail(`expected error code ${code}, got success`);
			throw new Error("unreachable");
		},
		(error: unknown) => {
			assert.ok(error instanceof Error, `expected Error, got ${String(error)}`);
			assert.equal((error as { code?: string }).code, code);
			return error;
		},
	);
}

/** No invocation-owned partial outputs may remain after any failure. */
async function assertNoPartials(runsDir: string): Promise<void> {
	assert.ok(!existsSync(join(runsDir, P9_EVIDENCE_DIR)), "no evidence directory may remain");
	assert.ok(!existsSync(join(runsDir, P9_MANIFEST_NAME)), "no manifest may remain");
	const leftovers = (await readdir(runsDir)).filter((n) => n.startsWith(".p9-prepare-staging-"));
	assert.deepEqual(leftovers, [], "no staging leftovers");
}

/** Assert a text is privacy-safe: no absolute fixture paths and no raw content. */
function assertPrivacySafe(text: string, root: string, runsDir: string): void {
	assert.ok(!text.includes(runsDir), "no absolute runs path");
	assert.ok(!text.includes(root), "no absolute fixture root");
	assert.ok(!text.includes(PRIVATE_MILESTONE_MARKER), "no raw milestone prompt content");
	assert.ok(!text.includes(PRIVATE_ASSISTANT_MARKER), "no raw assistant content");
}

// ---------------------------------------------------------------------------
// Pure prompt-deviation classification
// ---------------------------------------------------------------------------

test("isLiteralPathPrompt: exactly the fixed project-relative literal, up to surrounding whitespace", () => {
	assert.equal(isLiteralPathPrompt(MILESTONE_PROMPT_PATH_LITERAL), true);
	assert.equal(isLiteralPathPrompt(`  ${MILESTONE_PROMPT_PATH_LITERAL}  `), true);
	assert.equal(isLiteralPathPrompt(`\t${MILESTONE_PROMPT_PATH_LITERAL}\n`), true);
	// Unrelated text never classifies: absolute paths, prefixed/quoted
	// literals, instructions that merely mention the path, any other text.
	assert.equal(isLiteralPathPrompt(`/abs/path/${MILESTONE_PROMPT_PATH_LITERAL}`), false);
	assert.equal(isLiteralPathPrompt(`.${MILESTONE_PROMPT_PATH_LITERAL}`), false);
	assert.equal(isLiteralPathPrompt(`"${MILESTONE_PROMPT_PATH_LITERAL}"`), false);
	assert.equal(isLiteralPathPrompt(`read the file ${MILESTONE_PROMPT_PATH_LITERAL} now`), false);
	assert.equal(isLiteralPathPrompt(`${MILESTONE_PROMPT_PATH_LITERAL} extra`), false);
	assert.equal(isLiteralPathPrompt("some other path"), false);
	assert.equal(isLiteralPathPrompt(""), false);
});

test("promptMismatchKind: whitespace-equivalence vs the exact literal vs unrelated", () => {
	// Any whitespace-only corruption of the milestone prompt is the whitespace category.
	assert.equal(promptMismatchKind(PROMPT_TEXT.replace(/\n/g, " "), PROMPT_TEXT), "whitespace_corrupted_prompt");
	assert.equal(promptMismatchKind(` \n${PROMPT_TEXT}\t `, PROMPT_TEXT), "whitespace_corrupted_prompt");
	assert.equal(promptMismatchKind(WHITESPACE_VARIANTS[4] as string, PROMPT_TEXT), "whitespace_corrupted_prompt");
	// The exact single project-relative literal is the literal category.
	assert.equal(promptMismatchKind(MILESTONE_PROMPT_PATH_LITERAL, PROMPT_TEXT), "literal_path_prompt");
	assert.equal(promptMismatchKind(`  ${MILESTONE_PROMPT_PATH_LITERAL}  `, PROMPT_TEXT), "literal_path_prompt");
	// Unrelated text (including an absolute path to the same file) supports neither category.
	assert.equal(promptMismatchKind("completely unrelated text", PROMPT_TEXT), null);
	assert.equal(promptMismatchKind("", PROMPT_TEXT), null);
	assert.equal(promptMismatchKind(`/home/user/${MILESTONE_PROMPT_PATH_LITERAL}`, PROMPT_TEXT), null);
	// The exact milestone prompt is whitespace-equivalent to itself, so it
	// classifies as the whitespace category; the pipeline rejects it earlier
	// via the PROMPT_NOT_MISMATCHED hash-equality check.
	assert.equal(promptMismatchKind(PROMPT_TEXT, PROMPT_TEXT), "whitespace_corrupted_prompt");
});

test("normalizeWhitespace: collapses every whitespace run to one space and trims", () => {
	assert.equal(normalizeWhitespace("  a\t\tb \n c  "), "a b c");
	assert.equal(normalizeWhitespace("\n\n\t"), "");
	assert.equal(normalizeWhitespace(PROMPT_TEXT.replace(/\n/g, "  ")), normalizeWhitespace(PROMPT_TEXT));
});

// ---------------------------------------------------------------------------
// Bounded terminal facts
// ---------------------------------------------------------------------------

test("terminalStateOf: bounded counts and stop/aborted/error classification", () => {
	const stop = terminalStateOf([userEntry("a"), assistantEntry({ stopReason: "stop" })]);
	assert.equal(stop.messageCount, 2);
	assert.equal(stop.assistantMessageCount, 1);
	assert.equal(stop.compactionCount, 0);
	assert.equal(stop.lastEntryType, "message");
	assert.equal(stop.lastMessageRole, "assistant");
	assert.equal(stop.lastAssistantStopReason, "stop");
	assert.equal(stop.terminalStop, true);
	assert.equal(stop.aborted, false);
	assert.equal(stop.errored, false);

	assert.equal(terminalStateOf([userEntry("a"), assistantEntry({ stopReason: "aborted" })]).aborted, true);
	assert.equal(terminalStateOf([userEntry("a"), assistantEntry({ stopReason: "error" })]).errored, true);

	const length = terminalStateOf([userEntry("a"), assistantEntry({ stopReason: "length" })]);
	assert.equal(length.lastAssistantStopReason, "length");
	assert.equal(length.terminalStop, false);

	const toolResult = terminalStateOf([userEntry("a"), assistantEntry(), toolResultEntry()]);
	assert.equal(toolResult.lastMessageRole, "toolResult");
	assert.equal(toolResult.lastAssistantStopReason, "stop");
	assert.equal(toolResult.terminalStop, false);

	// Unknown identity strings are bounded to null — fail closed toward "no claim".
	const unknown = terminalStateOf([userEntry("a"), assistantEntry({ stopReason: "bogus" })]);
	assert.equal(unknown.lastAssistantStopReason, null);
	assert.equal(unknown.terminalStop, false);
	const unknownRole = terminalStateOf([{ type: "message", message: { role: "system", content: "x" } }]);
	assert.equal(unknownRole.lastMessageRole, null);
	assert.equal(unknownRole.lastEntryType, "message");

	const compacted = terminalStateOf([compactionEntry(), userEntry("a"), assistantEntry()]);
	assert.equal(compacted.compactionCount, 1);

	const empty = terminalStateOf([]);
	assert.equal(empty.messageCount, 0);
	assert.equal(empty.lastEntryType, null);
	assert.equal(empty.terminalStop, false);
});

// ---------------------------------------------------------------------------
// Successful preparation (byte-exact, all 8 deviations, strict 3+3 manifest)
// ---------------------------------------------------------------------------

test("prepareEvidence: byte-exact copies, all 8 deviations, strict 3+3 manifest, analyzer round-trip, privacy", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareFixture(root);
		const result: PrepareResult = await prepareEvidence({ runsDir: fx.runsDir, sources: fx.sources, protocol: fx.protocol });
		const evidenceDir = join(fx.runsDir, P9_EVIDENCE_DIR);
		const manifestPath = join(fx.runsDir, P9_MANIFEST_NAME);
		assert.equal(result.evidenceDir, evidenceDir);
		assert.equal(result.manifestPath, manifestPath);

		// Byte-exact copies of all 11 sources under the evidence directory.
		for (let i = 0; i < fx.sources.length; i += 1) {
			const label = i < INVALID_LABELS.length ? (INVALID_LABELS[i] as string) : (FINAL_CURRENT_LABELS[i - INVALID_LABELS.length] as string);
			const copied = i < INVALID_LABELS.length ? join(evidenceDir, "invalid-attempts", label, `${label}.jsonl`) : join(evidenceDir, "sessions", label, `${label}.jsonl`);
			const bytes = await readFile(copied);
			assert.ok(bytes.equals(fx.sourceBytes[i] as Buffer), `byte-exact copy of ${label}`);
		}

		// The deviations document: exactly the 8 disclosed attempts, fixed
		// categories and aborted flags, runs-relative paths, exact hashes.
		assert.equal(result.deviations.schema_version, DEVIATIONS_SCHEMA_VERSION);
		assert.equal(result.deviations.milestone_prompt_sha256, fx.protocol.milestonePromptSha256);
		assert.deepEqual(result.deviations.invalid_attempts.map((a) => a.label), [...INVALID_LABELS]);
		for (const a of result.deviations.invalid_attempts) {
			const expected = INVALID_EXPECTATIONS[a.label] as { category: "literal_path_prompt" | "whitespace_corrupted_prompt"; aborted: boolean };
			assert.equal(a.category, expected.category, a.label);
			assert.equal(a.aborted, expected.aborted, a.label);
			assert.equal(a.path, invalidAttemptPath(a.label, `${a.label}.jsonl`), a.label);
			assert.equal(a.basename, `${a.label}.jsonl`, a.label);
			const sourceIndex = INVALID_LABELS.indexOf(a.label as (typeof INVALID_LABELS)[number]);
			assert.equal(a.rawSha256, sha256Hex(fx.sourceBytes[sourceIndex] as Buffer), a.label);
			assert.equal(a.promptSha256, sha256Hex(fx.invalidPrompts[a.label] as string), a.label);
			assert.notEqual(a.promptSha256, fx.protocol.milestonePromptSha256, a.label);
			assert.equal(a.terminal.messageCount, 2, a.label);
			assert.equal(a.terminal.assistantMessageCount, 1, a.label);
			assert.equal(a.terminal.aborted, expected.aborted, a.label);
			if (!expected.aborted) assert.equal(a.terminal.terminalStop, true, a.label);
		}
		// Exactly the two fixed aborted attempts are machine-observably
		// aborted: invalid-4 and invalid-5, in chronological order.
		assert.deepEqual(
			result.deviations.invalid_attempts.filter((a) => a.aborted).map((a) => a.label),
			["invalid-4", "invalid-5"],
		);

		// The corrected current entries carry frozen-semantics facts.
		assert.deepEqual(result.currentEntries.map((c) => c.label), [...FINAL_CURRENT_LABELS]);
		for (const c of result.currentEntries) {
			assert.equal(c.requests, 1, c.label);
			assert.equal(c.compactions, 0, c.label);
			assert.equal(c.promptSha256, fx.protocol.milestonePromptSha256, c.label);
			assert.equal(c.path, currentSessionPath(c.label, `${c.label}.jsonl`), c.label);
			assert.equal(c.terminal.terminalStop, true, c.label);
		}

		// The committed manifest is strict 3+3 and every declared hash matches
		// the committed bytes.
		const manifestText = await readFile(manifestPath, "utf8");
		const parsed = parseManifest(manifestText, fx.protocol);
		assert.deepEqual(
			parsed.sessions.map((s) => s.label),
			["pre-1", "pre-2", "pre-3", "final-current-1", "final-current-2", "final-current-3"],
		);
		assert.equal(parsed.sessions.filter((s) => s.cohort === "baseline").length, 3);
		assert.equal(parsed.sessions.filter((s) => s.cohort === "current").length, 3);
		for (const s of parsed.sessions) {
			assert.equal(sha256Hex(await readFile(join(fx.runsDir, s.path))), s.expectedSessionSha256, s.label);
		}

		// End-to-end: the frozen analyzer accepts the committed manifest and
		// reproduces all six runs with matching session hashes.
		const report = await analyzeManifestFile(manifestPath, fx.protocol);
		assert.equal(report.runs.length, 6);
		assert.deepEqual(report.runs.map((r) => r.label), parsed.sessions.map((s) => s.label));
		for (const run of report.runs) {
			const session = parsed.sessions.find((s) => s.label === run.label);
			assert.equal(run.sessionSha256, session?.expectedSessionSha256, run.label);
		}

		// Privacy: no absolute paths, no raw content in any prepared document.
		assertPrivacySafe(manifestText, root, fx.runsDir);
		assertPrivacySafe(JSON.stringify(result.deviations), root, fx.runsDir);

		// No staging leftovers after a successful commit.
		assert.deepEqual((await readdir(fx.runsDir)).filter((n) => n.startsWith(".p9-prepare-staging-")), []);

		// A second preparation refuses the existing outputs and the first
		// run's artifacts survive untouched.
		await expectPrepareCode(prepareEvidence({ runsDir: fx.runsDir, sources: fx.sources, protocol: fx.protocol }), "EXISTING_OUTPUT");
		assert.ok(existsSync(manifestPath));
		assert.ok(existsSync(join(evidenceDir, DEVIATIONS_NAME)));
		assert.ok(existsSync(join(evidenceDir, "sessions", "final-current-1", "final-current-1.jsonl")));
	});
});

// ---------------------------------------------------------------------------
// Invalid-attempt derivation failures (terminal/category/prompt)
// ---------------------------------------------------------------------------

test("prepareEvidence fails closed: invalid-attempt terminal, category and prompt deviations", async () => {
	await withTempDir(async (root) => {
		// Both fixed aborted attempts must be machine-observably aborted:
		// invalid-5 not aborted fails closed...
		const notAborted5 = await writePrepareFixture(join(root, "a"), {
			invalid: (label, entries, prompt) => (label === "invalid-5" ? invalidEntries(prompt, { stopReason: "stop" }) : entries),
		});
		await expectPrepareCode(prepareEvidence({ runsDir: notAborted5.runsDir, sources: notAborted5.sources, protocol: notAborted5.protocol }), "TERMINAL_MISMATCH");
		await assertNoPartials(notAborted5.runsDir);

		// ... and invalid-4 not aborted fails closed too (the observed
		// evidence records BOTH invalid-4 and invalid-5 as aborted).
		const notAborted4 = await writePrepareFixture(join(root, "b"), {
			invalid: (label, entries, prompt) => (label === "invalid-4" ? invalidEntries(prompt, { stopReason: "stop" }) : entries),
		});
		await expectPrepareCode(prepareEvidence({ runsDir: notAborted4.runsDir, sources: notAborted4.sources, protocol: notAborted4.protocol }), "TERMINAL_MISMATCH");
		await assertNoPartials(notAborted4.runsDir);

		// An attempt fixed as non-aborted must NOT be aborted — one from
		// each non-aborted group (invalid-2 literal-path; invalid-6
		// whitespace-corrupted).
		const wronglyAborted2 = await writePrepareFixture(join(root, "c"), {
			invalid: (label, entries, prompt) => (label === "invalid-2" ? invalidEntries(prompt, { stopReason: "aborted" }) : entries),
		});
		await expectPrepareCode(prepareEvidence({ runsDir: wronglyAborted2.runsDir, sources: wronglyAborted2.sources, protocol: wronglyAborted2.protocol }), "TERMINAL_MISMATCH");
		await assertNoPartials(wronglyAborted2.runsDir);

		const wronglyAborted6 = await writePrepareFixture(join(root, "d"), {
			invalid: (label, entries, prompt) => (label === "invalid-6" ? invalidEntries(prompt, { stopReason: "aborted" }) : entries),
		});
		await expectPrepareCode(prepareEvidence({ runsDir: wronglyAborted6.runsDir, sources: wronglyAborted6.sources, protocol: wronglyAborted6.protocol }), "TERMINAL_MISMATCH");
		await assertNoPartials(wronglyAborted6.runsDir);

		// Observed facts must support the fixed category: invalid-1 is fixed
		// literal — a whitespace-corrupted prompt mismatches.
		const literalExpected = await writePrepareFixture(join(root, "e"), {
			invalid: (label, entries, prompt, stopReason) => (label === "invalid-1" ? invalidEntries(WHITESPACE_VARIANTS[0] as string, { stopReason }) : entries),
		});
		await expectPrepareCode(prepareEvidence({ runsDir: literalExpected.runsDir, sources: literalExpected.sources, protocol: literalExpected.protocol }), "CATEGORY_MISMATCH");
		await assertNoPartials(literalExpected.runsDir);

		// invalid-4 is fixed whitespace — the exact literal mismatches.
		const whitespaceExpected = await writePrepareFixture(join(root, "f"), {
			invalid: (label, entries, prompt, stopReason) => (label === "invalid-4" ? invalidEntries(MILESTONE_PROMPT_PATH_LITERAL, { stopReason }) : entries),
		});
		await expectPrepareCode(prepareEvidence({ runsDir: whitespaceExpected.runsDir, sources: whitespaceExpected.sources, protocol: whitespaceExpected.protocol }), "CATEGORY_MISMATCH");
		await assertNoPartials(whitespaceExpected.runsDir);

		// Unrelated text supports neither category.
		const unrelated = await writePrepareFixture(join(root, "g"), {
			invalid: (label, entries, prompt, stopReason) => (label === "invalid-1" ? invalidEntries("a completely unrelated prompt", { stopReason }) : entries),
		});
		await expectPrepareCode(prepareEvidence({ runsDir: unrelated.runsDir, sources: unrelated.sources, protocol: unrelated.protocol }), "CATEGORY_MISMATCH");
		await assertNoPartials(unrelated.runsDir);

		// An "invalid" attempt that reproduces the exact milestone prompt is
		// not a disclosed deviation at all.
		const exactPrompt = await writePrepareFixture(join(root, "h"), {
			invalid: (label, entries, prompt, stopReason) => (label === "invalid-1" ? invalidEntries(PROMPT_TEXT, { stopReason }) : entries),
		});
		await expectPrepareCode(prepareEvidence({ runsDir: exactPrompt.runsDir, sources: exactPrompt.sources, protocol: exactPrompt.protocol }), "PROMPT_NOT_MISMATCHED");
		await assertNoPartials(exactPrompt.runsDir);
	});
});

test("deriveInvalidAttempt: unknown labels fail closed", () => {
	assert.throws(
		() => deriveInvalidAttempt("invalid-9", [userEntry("x")], PROMPT_TEXT, PROMPT_SHA, "a.jsonl", "0".repeat(64)),
		(e: unknown) => e instanceof PrepareError && e.code === "INVALID_LABEL",
	);
});

// ---------------------------------------------------------------------------
// Corrected-session prevalidation failures
// ---------------------------------------------------------------------------

test("prepareEvidence fails closed: corrected prompt/model/thinking/compaction/terminal failures", async () => {
	const cases: Array<{ name: string; mutate: NonNullable<FixtureMutators["current"]>; code: string }> = [
		{ name: "PROMPT_MISMATCH", mutate: (label, _entries) => (label === "final-current-1" ? correctedEntries({ prompt: "a completely different milestone prompt" }) : _entries), code: "PROMPT_MISMATCH" },
		{ name: "MODEL_MISMATCH", mutate: (label, _entries) => (label === "final-current-1" ? correctedEntries({ provider: "openai" }) : _entries), code: "MODEL_MISMATCH" },
		{ name: "THINKING_MISMATCH", mutate: (label, _entries) => (label === "final-current-1" ? correctedEntries({ thinking: "low" }) : _entries), code: "THINKING_MISMATCH" },
		{ name: "MISSING_THINKING_LEVEL", mutate: (label, _entries) => (label === "final-current-1" ? correctedEntries({ thinking: null }) : _entries), code: "MISSING_THINKING_LEVEL" },
		{ name: "COMPACTION_PRESENT", mutate: (label, _entries) => (label === "final-current-1" ? correctedEntries({ compaction: true }) : _entries), code: "COMPACTION_PRESENT" },
		{ name: "ABORTED", mutate: (label, _entries) => (label === "final-current-1" ? correctedEntries({ stopReason: "aborted" }) : _entries), code: "ABORTED" },
		{ name: "ERRORED", mutate: (label, _entries) => (label === "final-current-1" ? correctedEntries({ stopReason: "error" }) : _entries), code: "ERRORED" },
		{ name: "NOT_TERMINAL_STOP", mutate: (label, _entries) => (label === "final-current-1" ? correctedEntries({ stopReason: "length" }) : _entries), code: "NOT_TERMINAL_STOP" },
	];
	await withTempDir(async (root) => {
		for (let i = 0; i < cases.length; i += 1) {
			const c = cases[i] as { name: string; mutate: NonNullable<FixtureMutators["current"]>; code: string };
			const fx = await writePrepareFixture(join(root, `case-${i}`), { current: c.mutate });
			await expectPrepareCode(prepareEvidence({ runsDir: fx.runsDir, sources: fx.sources, protocol: fx.protocol }), c.code);
			await assertNoPartials(fx.runsDir);
		}
	});
});

// ---------------------------------------------------------------------------
// Source preflight failures
// ---------------------------------------------------------------------------

test("prepareEvidence fails closed: source arity, duplicate, missing, directory, malformed, oversized, unsafe basename", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareFixture(root);

		// Arity: exactly 11 sources.
		await expectPrepareCode(prepareEvidence({ runsDir: fx.runsDir, sources: fx.sources.slice(0, 10), protocol: fx.protocol }), "ARITY");
		await expectPrepareCode(prepareEvidence({ runsDir: fx.runsDir, sources: [...fx.sources, fx.sources[0] as string], protocol: fx.protocol }), "ARITY");

		// Duplicate realpath.
		const dup = [...fx.sources];
		dup[1] = dup[0] as string;
		await expectPrepareCode(prepareEvidence({ runsDir: fx.runsDir, sources: dup, protocol: fx.protocol }), "DUPLICATE_SOURCE");

		// Missing source.
		const missing = [...fx.sources];
		missing[8] = join(root, "missing-current-1.jsonl");
		await expectPrepareCode(prepareEvidence({ runsDir: fx.runsDir, sources: missing, protocol: fx.protocol }), "SOURCE_UNREADABLE");

		// A directory is not a regular file.
		const dir = join(root, "not-a-file");
		await mkdir(dir);
		const asDir = [...fx.sources];
		asDir[2] = dir;
		await expectPrepareCode(prepareEvidence({ runsDir: fx.runsDir, sources: asDir, protocol: fx.protocol }), "SOURCE_NOT_REGULAR");

		// Malformed JSONL.
		const malformed = await writePrepareFixture(join(root, "malformed"), { rawText: { "invalid-6": '{"type":"message"}\n{this is not json\n' } });
		await expectPrepareCode(prepareEvidence({ runsDir: malformed.runsDir, sources: malformed.sources, protocol: malformed.protocol }), "MALFORMED_JSONL");
		await assertNoPartials(malformed.runsDir);

		// Oversized source.
		const oversized = await writePrepareFixture(join(root, "oversized"));
		await writeFile(oversized.sources[0] as string, Buffer.alloc(SESSION_MAX_BYTES + 1, 0x61));
		await expectPrepareCode(prepareEvidence({ runsDir: oversized.runsDir, sources: oversized.sources, protocol: oversized.protocol }), "SOURCE_OVER_BOUND");
		await assertNoPartials(oversized.runsDir);

		// Unsafe basename.
		const unsafe = [...fx.sources];
		const unsafeFile = join(root, "bad name!.jsonl");
		await writeFile(unsafeFile, "{}", "utf8");
		unsafe[3] = unsafeFile;
		await expectPrepareCode(prepareEvidence({ runsDir: fx.runsDir, sources: unsafe, protocol: fx.protocol }), "BASENAME_UNSAFE");

		// No partial outputs from any of the above (the shared fixture run
		// never commits: every failure above precedes the commit).
		await assertNoPartials(fx.runsDir);
	});
});

// ---------------------------------------------------------------------------
// Baseline preflight failures
// ---------------------------------------------------------------------------

test("prepareEvidence fails closed: baseline missing, ambiguous, hash mismatch", async () => {
	await withTempDir(async (root) => {
		// Missing preserved P3 pre evidence.
		const missing = await writePrepareFixture(join(root, "a"));
		await rm(join(missing.runsDir, P3_EVIDENCE_DIR), { recursive: true, force: true });
		await expectPrepareCode(prepareEvidence({ runsDir: missing.runsDir, sources: missing.sources, protocol: missing.protocol }), "BASELINE_MISSING");
		await assertNoPartials(missing.runsDir);

		// More than one session file in a pre-N directory.
		const ambiguous = await writePrepareFixture(join(root, "b"));
		await writeFile(join(ambiguous.runsDir, P3_EVIDENCE_DIR, "sessions", "pre-1", "extra.jsonl"), "{}", "utf8");
		await expectPrepareCode(prepareEvidence({ runsDir: ambiguous.runsDir, sources: ambiguous.sources, protocol: ambiguous.protocol }), "BASELINE_AMBIGUOUS");
		await assertNoPartials(ambiguous.runsDir);

		// Preserved bytes no longer match the pinned preserved P3 hash.
		const tampered = await writePrepareFixture(join(root, "c"));
		const pre1Dir = join(tampered.runsDir, P3_EVIDENCE_DIR, "sessions", "pre-1");
		const pre1File = join(pre1Dir, "pre-1.jsonl");
		const original = await readFile(pre1File);
		await writeFile(pre1File, Buffer.concat([original, Buffer.from("tampered")]));
		await expectPrepareCode(prepareEvidence({ runsDir: tampered.runsDir, sources: tampered.sources, protocol: tampered.protocol }), "BASELINE_HASH_MISMATCH");
		await assertNoPartials(tampered.runsDir);
	});
});

// ---------------------------------------------------------------------------
// Existing final outputs are refused and never touched
// ---------------------------------------------------------------------------

test("existing final outputs are refused with EXISTING_OUTPUT and survive untouched", async () => {
	await withTempDir(async (root) => {
		// Pre-existing evidence directory with foreign content.
		const fx1 = await writePrepareFixture(join(root, "a"));
		await mkdir(join(fx1.runsDir, P9_EVIDENCE_DIR), { recursive: true });
		await writeFile(join(fx1.runsDir, P9_EVIDENCE_DIR, "keep.txt"), "FOREIGN-KEEP-1", "utf8");
		await expectPrepareCode(prepareEvidence({ runsDir: fx1.runsDir, sources: fx1.sources, protocol: fx1.protocol }), "EXISTING_OUTPUT");
		assert.equal(await readFile(join(fx1.runsDir, P9_EVIDENCE_DIR, "keep.txt"), "utf8"), "FOREIGN-KEEP-1");

		// Pre-existing manifest file.
		const fx2 = await writePrepareFixture(join(root, "b"));
		await writeFile(join(fx2.runsDir, P9_MANIFEST_NAME), "FOREIGN-MANIFEST-2", "utf8");
		await expectPrepareCode(prepareEvidence({ runsDir: fx2.runsDir, sources: fx2.sources, protocol: fx2.protocol }), "EXISTING_OUTPUT");
		assert.equal(await readFile(join(fx2.runsDir, P9_MANIFEST_NAME), "utf8"), "FOREIGN-MANIFEST-2");

		// A plain FILE at the evidence-directory path is refused too.
		const fx3 = await writePrepareFixture(join(root, "c"));
		await writeFile(join(fx3.runsDir, P9_EVIDENCE_DIR), "file-in-the-way", "utf8");
		await expectPrepareCode(prepareEvidence({ runsDir: fx3.runsDir, sources: fx3.sources, protocol: fx3.protocol }), "EXISTING_OUTPUT");
		assert.equal(await readFile(join(fx3.runsDir, P9_EVIDENCE_DIR), "utf8"), "file-in-the-way");

		// The foreign pre-existing outputs remain exactly as they were and no
		// staging leftovers exist (the invocation-owned outputs are nothing).
		for (const fx of [fx1, fx2, fx3]) {
			assert.deepEqual((await readdir(fx.runsDir)).filter((n) => n.startsWith(".p9-prepare-staging-")), []);
		}
	});
});

// ---------------------------------------------------------------------------
// Race preservation and ownership-tracked rollback (test seams)
// ---------------------------------------------------------------------------

test("race: foreign evidence dir and foreign manifest created at the last absence check are refused and survive", async () => {
	await withTempDir(async (root) => {
		// A racing foreign evidence directory (with content) is never replaced.
		const fx1 = await writePrepareFixture(join(root, "a"));
		await expectPrepareCode(
			prepareEvidence({
				runsDir: fx1.runsDir,
				sources: fx1.sources,
				protocol: fx1.protocol,
				hooks: {
					beforeEvidenceCommit: async () => {
						await mkdir(join(fx1.runsDir, P9_EVIDENCE_DIR), { recursive: true });
						await writeFile(join(fx1.runsDir, P9_EVIDENCE_DIR, "foreign-marker.txt"), "FOREIGN-KEEP-1a2b", "utf8");
					},
				},
			}),
			"EXISTING_OUTPUT",
		);
		assert.equal(await readFile(join(fx1.runsDir, P9_EVIDENCE_DIR, "foreign-marker.txt"), "utf8"), "FOREIGN-KEEP-1a2b");
		assert.ok(!existsSync(join(fx1.runsDir, P9_MANIFEST_NAME)), "no manifest may remain");
		assert.deepEqual((await readdir(fx1.runsDir)).filter((n) => n.startsWith(".p9-prepare-staging-")), []);

		// A racing foreign manifest file is never overwritten.
		const fx2 = await writePrepareFixture(join(root, "b"));
		await expectPrepareCode(
			prepareEvidence({
				runsDir: fx2.runsDir,
				sources: fx2.sources,
				protocol: fx2.protocol,
				hooks: {
					beforeEvidenceCommit: async () => {
						await writeFile(join(fx2.runsDir, P9_MANIFEST_NAME), "FOREIGN-MANIFEST-3c4d", "utf8");
					},
				},
			}),
			"EXISTING_OUTPUT",
		);
		assert.equal(await readFile(join(fx2.runsDir, P9_MANIFEST_NAME), "utf8"), "FOREIGN-MANIFEST-3c4d");
		assert.ok(!existsSync(join(fx2.runsDir, P9_EVIDENCE_DIR)), "no evidence directory may remain");
		assert.deepEqual((await readdir(fx2.runsDir)).filter((n) => n.startsWith(".p9-prepare-staging-")), []);
	});
});

test("rollback: failure right after the exclusive evidence reservation removes the owned empty directory", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareFixture(root);
		const boom = Object.assign(new Error("injected after evidence reservation"), { code: "INJECTED_RESERVE" });
		await expectPrepareCode(
			prepareEvidence({
				runsDir: fx.runsDir,
				sources: fx.sources,
				protocol: fx.protocol,
				hooks: { afterEvidenceReserve: async () => {
					throw boom;
				} },
			}),
			"INJECTED_RESERVE",
		);
		await assertNoPartials(fx.runsDir);
	});
});

test("rollback: failure after the evidence commit removes the owned evidence directory", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareFixture(root);
		const boom = Object.assign(new Error("injected after evidence commit"), { code: "INJECTED_EVIDENCE" });
		await expectPrepareCode(
			prepareEvidence({
				runsDir: fx.runsDir,
				sources: fx.sources,
				protocol: fx.protocol,
				hooks: { afterEvidenceCommit: async () => {
					throw boom;
				} },
			}),
			"INJECTED_EVIDENCE",
		);
		await assertNoPartials(fx.runsDir);
	});
});

test("race: foreign manifest after the evidence commit is refused; owned evidence rolled back; foreign survives", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareFixture(root);
		await expectPrepareCode(
			prepareEvidence({
				runsDir: fx.runsDir,
				sources: fx.sources,
				protocol: fx.protocol,
				hooks: {
					afterEvidenceCommit: async () => {
						await writeFile(join(fx.runsDir, P9_MANIFEST_NAME), "FOREIGN-MANIFEST-5e6f", "utf8");
					},
				},
			}),
			"EXISTING_OUTPUT",
		);
		assert.equal(await readFile(join(fx.runsDir, P9_MANIFEST_NAME), "utf8"), "FOREIGN-MANIFEST-5e6f");
		assert.ok(!existsSync(join(fx.runsDir, P9_EVIDENCE_DIR)), "owned evidence must be rolled back");
		assert.deepEqual((await readdir(fx.runsDir)).filter((n) => n.startsWith(".p9-prepare-staging-")), []);
	});
});

test("race: foreign manifest after the evidence reservation is refused; owned evidence rolled back; foreign survives", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareFixture(root);
		await expectPrepareCode(
			prepareEvidence({
				runsDir: fx.runsDir,
				sources: fx.sources,
				protocol: fx.protocol,
				hooks: {
					afterEvidenceReserve: async () => {
						await writeFile(join(fx.runsDir, P9_MANIFEST_NAME), "FOREIGN-MANIFEST-7a8b", "utf8");
					},
				},
			}),
			"EXISTING_OUTPUT",
		);
		assert.equal(await readFile(join(fx.runsDir, P9_MANIFEST_NAME), "utf8"), "FOREIGN-MANIFEST-7a8b");
		assert.ok(!existsSync(join(fx.runsDir, P9_EVIDENCE_DIR)), "owned evidence must be rolled back");
		assert.deepEqual((await readdir(fx.runsDir)).filter((n) => n.startsWith(".p9-prepare-staging-")), []);
	});
});

test("rollback: failure after the exclusive manifest open removes the owned manifest (write never completed)", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareFixture(root);
		const boom = Object.assign(new Error("injected after manifest open"), { code: "INJECTED_MANIFEST_OPEN" });
		await expectPrepareCode(
			prepareEvidence({
				runsDir: fx.runsDir,
				sources: fx.sources,
				protocol: fx.protocol,
				hooks: { afterManifestOpen: async () => {
					throw boom;
				} },
			}),
			"INJECTED_MANIFEST_OPEN",
		);
		await assertNoPartials(fx.runsDir);
	});
});

test("rollback: failure after the manifest commit removes the owned manifest and evidence", async () => {
	await withTempDir(async (root) => {
		const fx = await writePrepareFixture(root);
		const boom = Object.assign(new Error("injected after manifest commit"), { code: "INJECTED_MANIFEST" });
		await expectPrepareCode(
			prepareEvidence({
				runsDir: fx.runsDir,
				sources: fx.sources,
				protocol: fx.protocol,
				hooks: { afterManifestCommit: async () => {
					throw boom;
				} },
			}),
			"INJECTED_MANIFEST",
		);
		await assertNoPartials(fx.runsDir);
	});
});

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const ELEVEN = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"];

test("parseArgs: help, arity, unknown options, runs-dir", () => {
	assert.equal(parseArgs(["--help"]).help, true);
	assert.equal(parseArgs(["-h"]).help, true);
	assert.equal(parseArgs(["a", "--help"]).help, true);
	assert.equal(parseArgs([]).sources, null);
	assert.equal(parseArgs(ELEVEN.slice(0, 10)).sources, null);
	assert.equal(parseArgs([...ELEVEN, "12"]).sources, null);
	assert.equal(parseArgs(["--bogus"]).sources, null);
	assert.equal(parseArgs([...ELEVEN, "--runs-dir"]).sources, null); // missing value
	assert.equal(parseArgs([...ELEVEN, "--runs-dir", "/tmp/runs"]).runsDir, "/tmp/runs");

	const ok = parseArgs(ELEVEN);
	assert.equal(ok.help, false);
	assert.deepEqual(ok.sources, ELEVEN);
	assert.equal(ok.runsDir, join(process.cwd(), ".pi", "workbench", "runs"));
});

// ---------------------------------------------------------------------------
// CLI subprocess behavior (real FROZEN_PROTOCOL + preserved P3 pre sessions)
// ---------------------------------------------------------------------------

const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const PREPARE_SCRIPT = join(process.cwd(), "scripts", "commander-token-p9-prepare.ts");
/** Durable preserved P3 evidence root (protocol §2.4; gitignored, present wherever P9 prep runs). */
const P3_EVIDENCE_ROOT = join(process.cwd(), ".pi", "workbench", "runs", "commander-token-p3-benchmark");

/** Byte-copy the preserved P3 pre sessions into a temp runs dir; false when the real evidence is absent. */
async function copyRealBaselines(runsDir: string): Promise<boolean> {
	for (const label of PRE_LABELS) {
		const srcDir = join(P3_EVIDENCE_ROOT, "sessions", label);
		let names: string[];
		try {
			names = await readdir(srcDir);
		} catch {
			return false;
		}
		const files = names.filter((n) => n.endsWith(".jsonl"));
		if (files.length !== 1) return false;
		const dstDir = join(runsDir, P3_EVIDENCE_DIR, "sessions", label);
		await mkdir(dstDir, { recursive: true });
		await copyFile(join(srcDir, files[0] as string), join(dstDir, files[0] as string));
	}
	return true;
}

/** Write the eleven CLI source files against the real frozen protocol (invalid table + frozen prompt). */
async function writeCliSources(root: string): Promise<string[]> {
	const dir = join(root, "cli-sources");
	await mkdir(dir, { recursive: true });
	const sources: string[] = [];
	for (const label of INVALID_LABELS) {
		const expected = INVALID_EXPECTATIONS[label] as { category: "literal_path_prompt" | "whitespace_corrupted_prompt"; aborted: boolean };
		const prompt =
			expected.category === "literal_path_prompt"
				? label === "invalid-2"
					? `  ${MILESTONE_PROMPT_PATH_LITERAL}  `
					: label === "invalid-3"
						? `\t${MILESTONE_PROMPT_PATH_LITERAL}\n`
						: MILESTONE_PROMPT_PATH_LITERAL
				: (whitespaceVariants(FROZEN_PROMPT_TEXT)[INVALID_LABELS.indexOf(label) - 3] as string);
		const entries = invalidEntries(prompt, { stopReason: expected.aborted ? "aborted" : "stop" });
		const file = join(dir, `${label}.jsonl`);
		await writeFile(file, sessionText(entries), "utf8");
		sources.push(file);
	}
	for (const label of FINAL_CURRENT_LABELS) {
		const file = join(dir, `${label}.jsonl`);
		await writeFile(file, sessionText(correctedEntries({ prompt: FROZEN_PROMPT_TEXT })), "utf8");
		sources.push(file);
	}
	return sources;
}

test("CLI: --help exits 0; usage errors exit 2 with usage on stderr", async () => {
	const help = await spawnExec(TSX, [PREPARE_SCRIPT, "--help"], { timeout: 120000 });
	assert.equal(help.code, 0);
	assert.ok(help.stdout.includes("usage:"));
	assert.ok(help.stdout.includes("--runs-dir"));
	assert.equal(help.stderr, "");

	const noArgs = await spawnExec(TSX, [PREPARE_SCRIPT], { timeout: 120000 });
	assert.equal(noArgs.code, 2);
	assert.ok(noArgs.stderr.includes("usage:"));
	assert.equal(noArgs.stdout, "");

	const unknown = await spawnExec(TSX, [PREPARE_SCRIPT, "--bogus"], { timeout: 120000 });
	assert.equal(unknown.code, 2);
	assert.ok(unknown.stderr.includes("usage:"));
	assert.equal(unknown.stdout, "");
});

test("CLI: success — exit 0, byte-exact evidence + strict manifest, privacy-safe summary", async (t) => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir, { recursive: true });
		if (!(await copyRealBaselines(runsDir))) {
			t.skip("preserved P3 pre evidence absent; the CLI success path needs the byte-identical preserved pre sessions");
			return;
		}
		const sources = await writeCliSources(root);
		const run = await spawnExec(TSX, [PREPARE_SCRIPT, ...sources, "--runs-dir", runsDir], { timeout: 120000 });
		assert.equal(run.code, 0);
		assert.equal(run.stderr, "");
		assert.ok(run.stdout.includes("commander-token-p9-prepare: P9 evidence prepared"));
		assert.ok(run.stdout.includes("invalid-attempt invalid-4 | category whitespace_corrupted_prompt | aborted true"));
		assert.ok(run.stdout.includes("invalid-attempt invalid-5 | category whitespace_corrupted_prompt | aborted true"));
		assert.ok(run.stdout.includes("final-current final-current-1 | requests 1 | compactions 0 | terminal stop"));
		assertPrivacySafe(run.stdout, root, runsDir);

		// The committed manifest is strict 3+3 under the real frozen protocol,
		// and every declared hash matches the committed bytes.
		const manifestPath = join(runsDir, P9_MANIFEST_NAME);
		const manifest = parseManifest(await readFile(manifestPath, "utf8"), FROZEN_PROTOCOL);
		assert.deepEqual(
			manifest.sessions.map((s) => s.label),
			["pre-1", "pre-2", "pre-3", "final-current-1", "final-current-2", "final-current-3"],
		);
		for (const s of manifest.sessions) {
			assert.equal(sha256Hex(await readFile(join(runsDir, s.path))), s.expectedSessionSha256, s.label);
		}
		const deviations = JSON.parse(await readFile(join(runsDir, P9_EVIDENCE_DIR, DEVIATIONS_NAME), "utf8")) as { invalid_attempts: Array<{ label: string; category: string; aborted: boolean }> };
		assert.equal(deviations.invalid_attempts.length, 8);
		assert.equal(deviations.invalid_attempts.filter((a) => a.category === "literal_path_prompt").length, 3);
		assert.equal(deviations.invalid_attempts.filter((a) => a.category === "whitespace_corrupted_prompt").length, 5);
		// Exactly the two fixed aborted attempts: invalid-4 and invalid-5.
		assert.deepEqual(deviations.invalid_attempts.filter((a) => a.aborted).map((a) => a.label), ["invalid-4", "invalid-5"]);

		// A rerun refuses the existing outputs; the first run survives.
		const again = await spawnExec(TSX, [PREPARE_SCRIPT, ...sources, "--runs-dir", runsDir], { timeout: 120000 });
		assert.equal(again.code, 1);
		assert.equal(again.stdout, "");
		assert.ok(again.stderr.includes("EXISTING_OUTPUT"));
		assert.ok(existsSync(manifestPath));
		assert.ok(existsSync(join(runsDir, P9_EVIDENCE_DIR, DEVIATIONS_NAME)));
	});
});

test("CLI: fail-closed errors exit 1 with the error code on stderr and no partial outputs", async (t) => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		await mkdir(runsDir, { recursive: true });
		if (!(await copyRealBaselines(runsDir))) {
			t.skip("preserved P3 pre evidence absent; the CLI failure path needs the preserved pre sessions");
			return;
		}
		const sources = await writeCliSources(root);
		sources[7] = join(root, "missing-invalid-8.jsonl");
		const run = await spawnExec(TSX, [PREPARE_SCRIPT, ...sources, "--runs-dir", runsDir], { timeout: 120000 });
		assert.equal(run.code, 1);
		assert.equal(run.stdout, "");
		assert.ok(run.stderr.includes("SOURCE_UNREADABLE"));
		assert.ok(!run.stderr.includes(root), "stderr must not carry absolute input paths");
		assert.ok(!existsSync(join(runsDir, P9_EVIDENCE_DIR)));
		assert.ok(!existsSync(join(runsDir, P9_MANIFEST_NAME)));
		assert.deepEqual((await readdir(runsDir)).filter((n) => n.startsWith(".p9-prepare-staging-")), []);
	});
});

test("CLI: an existing evidence output is refused (exit 1 EXISTING_OUTPUT) and survives", async () => {
	await withTempDir(async (root) => {
		const runsDir = join(root, "runs");
		const evidenceDir = join(runsDir, P9_EVIDENCE_DIR);
		await mkdir(evidenceDir, { recursive: true });
		await writeFile(join(evidenceDir, "foreign-marker.txt"), "FOREIGN-KEEP-9f0e", "utf8");
		const sources = await writeCliSources(root);
		const run = await spawnExec(TSX, [PREPARE_SCRIPT, ...sources, "--runs-dir", runsDir], { timeout: 120000 });
		assert.equal(run.code, 1);
		assert.equal(run.stdout, "");
		assert.ok(run.stderr.includes("EXISTING_OUTPUT"));
		assert.equal(await readFile(join(evidenceDir, "foreign-marker.txt"), "utf8"), "FOREIGN-KEEP-9f0e");
		assert.deepEqual((await readdir(runsDir)).filter((n) => n.startsWith(".p9-prepare-staging-")), []);
	});
});

// ---------------------------------------------------------------------------
// package.json and recipes.yaml wiring
// ---------------------------------------------------------------------------

test("package.json: commander:prepare wired to the preparation tool", async () => {
	const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, string> };
	assert.equal(pkg.scripts?.["commander:prepare"], "tsx scripts/commander-token-p9-prepare.ts");
	assert.equal(pkg.scripts?.["commander:benchmark"], "tsx scripts/commander-token-benchmark.ts");
});

async function loadRecipes(): Promise<ReturnType<typeof parseRecipesDocument>> {
	const text = await readFile(join(process.cwd(), ".pi", "workbench", "recipes.yaml"), "utf8");
	return parseRecipesDocument(parseYaml(text));
}

test("recipes.yaml: commander-token-p9-prepare — 11 required string params, artifact-only writes/artifacts, uncached", async () => {
	const doc = await loadRecipes();
	assert.deepEqual(doc.errors, []);
	assert.deepEqual(doc.warnings, []);
	const recipe = doc.recipes.find((r) => r.name === "commander-token-p9-prepare");
	assert.ok(recipe, "commander-token-p9-prepare recipe declared");

	// Exact argv shape: npm run commander:prepare -- <11 placeholders>.
	assert.deepEqual(recipe.command, [
		"npm",
		"run",
		"commander:prepare",
		"--",
		"{{invalid1}}",
		"{{invalid2}}",
		"{{invalid3}}",
		"{{invalid4}}",
		"{{invalid5}}",
		"{{invalid6}}",
		"{{invalid7}}",
		"{{invalid8}}",
		"{{current1}}",
		"{{current2}}",
		"{{current3}}",
	]);
	// Exactly the 11 required string params, in fixed order.
	assert.deepEqual(
		recipe.params.map((p) => [p.name, p.type, p.required]),
		[
			["invalid1", "string", true],
			["invalid2", "string", true],
			["invalid3", "string", true],
			["invalid4", "string", true],
			["invalid5", "string", true],
			["invalid6", "string", true],
			["invalid7", "string", true],
			["invalid8", "string", true],
			["current1", "string", true],
			["current2", "string", true],
			["current3", "string", true],
		],
	);
	// Artifact-only write surface: the exact P9 evidence directory and manifest.
	assert.deepEqual(recipe.writes, [`.pi/workbench/runs/${P9_EVIDENCE_DIR}/**`, `.pi/workbench/runs/${P9_MANIFEST_NAME}`]);
	assert.deepEqual(recipe.artifacts, [`.pi/workbench/runs/${P9_EVIDENCE_DIR}/**`, `.pi/workbench/runs/${P9_MANIFEST_NAME}`]);
	assert.equal(recipe.mutation, "artifacts");
	assert.deepEqual(recipe.allowed_modes, ["DEV", "VERIFY"]);
	assert.deepEqual(recipe.expected_exit_codes, [0]);
	assert.deepEqual(recipe.environment, []);
	// Intentionally uncached.
	assert.equal(recipe.cache.enabled, false);

	// Exact param -> argv wiring.
	const argv = buildArgv(recipe, {
		invalid1: "s1",
		invalid2: "s2",
		invalid3: "s3",
		invalid4: "s4",
		invalid5: "s5",
		invalid6: "s6",
		invalid7: "s7",
		invalid8: "s8",
		current1: "c1",
		current2: "c2",
		current3: "c3",
	});
	assert.deepEqual(argv, ["npm", "run", "commander:prepare", "--", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "c1", "c2", "c3"]);
});

test("recipes.yaml: commander-token-p9-benchmark — fixed JSON invocation of the prepared manifest, read-only, uncached", async () => {
	const doc = await loadRecipes();
	assert.deepEqual(doc.errors, []);
	const recipe = doc.recipes.find((r) => r.name === "commander-token-p9-benchmark");
	assert.ok(recipe, "commander-token-p9-benchmark recipe declared");
	assert.deepEqual(recipe.command, ["npm", "run", "commander:benchmark", "--", ".pi/workbench/runs/commander-token-p9-manifest.json", "--json"]);
	assert.equal(recipe.mutation, "none");
	assert.deepEqual(recipe.writes, []);
	assert.deepEqual(recipe.artifacts, []);
	assert.deepEqual(recipe.params, []);
	assert.deepEqual(recipe.environment, []);
	assert.equal(recipe.cache.enabled, false);
});

test("recipes.yaml: existing recipe semantics are unchanged", async () => {
	const doc = await loadRecipes();
	assert.deepEqual(doc.errors, []);
	assert.deepEqual(doc.warnings, []);
	const byName = new Map(doc.recipes.map((r) => [r.name, r]));
	const typecheck = byName.get("typecheck");
	assert.ok(typecheck);
	assert.deepEqual(typecheck.command, ["npm", "run", "typecheck"]);
	assert.equal(typecheck.mutation, "none");
	assert.deepEqual(typecheck.writes, []);
	assert.deepEqual(typecheck.artifacts, []);
	assert.equal(typecheck.cache.enabled, true);
	const unitTest = byName.get("unit-test");
	assert.ok(unitTest);
	assert.deepEqual(unitTest.command, ["npm", "test"]);
	assert.equal(unitTest.mutation, "none");
	assert.deepEqual(unitTest.writes, []);
	assert.deepEqual(unitTest.artifacts, []);
	assert.equal(unitTest.cache.enabled, true);
	const check = byName.get("check");
	assert.ok(check);
	assert.deepEqual(check.command, ["npm", "run", "check"]);
	assert.equal(check.mutation, "none");
	assert.equal(check.cache.enabled, false);
});
