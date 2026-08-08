/**
 * Hermetic unit tests for the NRO DEV-pilot collector
 * (`scripts/commander-native-tool-dev-pilot.ts`).
 *
 * The collector is exercised ONLY through its injected seams: temp dirs
 * for every output, a fake injected attempt runner (never a real spawn),
 * and injected IO for the CLI. No provider, model, network, real pi
 * process, or full workbench runtime is ever invoked. The only
 * repository files touched are the frozen inputs (read-only preflight
 * against the real `fixtures/commander-native-tool-benchmark/inputs`)
 * and the frozen protocol constants reused from the benchmark module.
 *
 * Covered contract:
 *   - fixed plan: exactly the frozen ABBA arms abbaArmAt(1..8) =
 *     control, treatment, treatment, control, control, treatment,
 *     treatment, control;
 *   - exact attempt argv (flag order, pinned model/thinking, tools
 *     allowlist, fresh session dir, attempt name, raw milestone prompt
 *     as the sole positional message, byte-exact) and env (inherited +
 *     PI_SKIP_VERSION_CHECK=1 + PI_TELEMETRY=0);
 *   - fixed-order collection: 8 valid sessions in ABBA order, complete
 *     status, deterministic `sources/raw-<NN>-<arm>.jsonl` retention,
 *     per-attempt session dirs cleaned up when empty;
 *   - invalid attempts retry the same required arm (exit/prompt/model/
 *     thinking/compaction/terminal/timeout/malformed), are retained as
 *     `kind: "attempt"`, and diagnostics stay bounded on stderr;
 *   - the 12-attempt cap exits 1 with a truthful partial collection;
 *   - byte preservation and the strict chronological record: schema 1,
 *     phase "dev", frozen non-treatment pin, parseCollectionRecord
 *     round-trip, every entry's file byte-identical to the produced raw;
 *   - existing output refusal (EXISTING_OUTPUT), preflight pin
 *     enforcement (PROTOCOL_NOT_FROZEN / MILESTONE_MISMATCH /
 *     FIXTURE_MISMATCH) with no output created;
 *   - zero/multiple produced session files fail closed
 *     (SESSION_FILE_COUNT) with no fabricated entries;
 *   - argv/env parity between arms (extension/name/session dir are the
 *     ONLY argv differences; env identical);
 *   - CLI discipline via main with injected IO: --help/-h 0, unknown/
 *     positional 2, runtime 1 (stderr only), complete 0 / exhausted 1
 *     with a bounded relative summary and no absolute paths.
 */

import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	COLLECTION_RECORD_NAME,
	FROZEN_NRO_PROTOCOL,
	NroError,
	abbaArmAt,
	parseCollectionRecord,
	sha256Hex,
} from "../scripts/commander-native-tool-benchmark.ts";
import type { FrozenProtocol } from "../scripts/commander-native-tool-benchmark.ts";
import {
	ATTEMPT_STDERR_MAX_BYTES,
	ATTEMPT_STDOUT_MAX_BYTES,
	ATTEMPT_TIMEOUT_MS,
	DEV_PILOT_MAX_ATTEMPTS,
	DEV_PILOT_VALID_SESSIONS,
	OUTPUT_ROOT_NAME,
	PilotError,
	SOURCES_DIR_NAME,
	TERMINATE_GRACE_MS,
	attemptLabel,
	attemptName,
	attemptSessionDirName,
	buildAttemptArgv,
	buildAttemptEnv,
	classifySession,
	collectDevPilot,
	createCappedCapture,
	fixedPlan,
	main,
	rawSourceName,
	renderSummary,
	serializeCollectionRecord,
	usage,
} from "../scripts/commander-native-tool-dev-pilot.ts";
import type { AttemptRunner, AttemptRunRequest, CollectDevPilotOptions, CollectResult, PilotIo, SpawnedAttemptResult } from "../scripts/commander-native-tool-dev-pilot.ts";
import { withTempDir } from "./helpers.ts";

// ------------------------------------------------------------------ fixtures

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INPUTS_DIR = join(PROJECT_ROOT, "fixtures", "commander-native-tool-benchmark", "inputs");
const CONTROL_EXTENSION = join(PROJECT_ROOT, "scripts", "commander-native-tool-control-extension.ts");
const TREATMENT_EXTENSION = join(PROJECT_ROOT, "extensions", "workbench-runtime", "index.ts");
const FIXTURE_CWD = join(INPUTS_DIR, "fixture");

let cachedPromptText: string | null = null;

/**
 * The exact milestone prompt text whose SHA-256 equals the frozen pin
 * (with or without a trailing newline — whichever the pin covers). The
 * pin is over the raw file bytes, so this is the text a produced
 * session's first user message must carry to be valid.
 */
async function frozenPromptText(): Promise<string> {
	if (cachedPromptText !== null) return cachedPromptText;
	const raw = await readFile(join(INPUTS_DIR, "milestone-prompt.txt"));
	const text = raw.toString("utf8");
	const candidates = [text, text.replace(/\n$/, "")];
	const match = candidates.find((candidate) => sha256Hex(candidate) === FROZEN_NRO_PROTOCOL.milestonePromptSha256);
	assert.ok(match !== undefined, "milestone-prompt.txt must reproduce the frozen milestone prompt pin");
	cachedPromptText = match;
	return match;
}

// ------------------------------------------------------------------ builders

function userEntry(text: string): Record<string, unknown> {
	return { type: "message", id: "u-1", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } };
}

function thinkingChange(level: string): Record<string, unknown> {
	return { type: "thinking_level_change", id: "th-1", timestamp: "2026-09-01T10:00:00.000Z", thinkingLevel: level };
}

function compactionEntry(): Record<string, unknown> {
	return { type: "compaction", id: "cp-1", timestamp: "2026-09-01T10:00:00.100Z" };
}

function assistantEntry(opts: { stopReason?: string; provider?: string; model?: string } = {}): Record<string, unknown> {
	return {
		type: "message",
		id: "a-1",
		timestamp: "2026-09-01T10:00:01.000Z",
		message: {
			role: "assistant",
			provider: opts.provider ?? "openai-codex",
			model: opts.model ?? "gpt-5.6-sol",
			content: [{ type: "text", text: "done" }],
			stopReason: opts.stopReason ?? "stop",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
		},
	};
}

interface ValidSessionOverrides {
	prompt?: string;
	provider?: string;
	model?: string;
	/** undefined = "high"; null = omit the thinking_level_change entry. */
	thinking?: string | null;
	compaction?: boolean;
	stopReason?: string;
}

/** A valid Pi-like session (pinned model/thinking, exact prompt, terminal stop). */
function validSessionEntries(promptText: string, overrides: ValidSessionOverrides = {}): unknown[] {
	return [
		{ type: "session", version: 3, id: "s-1", timestamp: "2026-09-01T10:00:00.000Z" },
		{ type: "session_info", id: "i-1", parentId: null, timestamp: "2026-09-01T10:00:00.000Z", name: "nro-dev-pilot-test" },
		{ type: "model_change", id: "m-1", parentId: "i-1", timestamp: "2026-09-01T10:00:00.000Z", provider: "openai-codex", modelId: "gpt-5.6-sol" },
		...(overrides.thinking === null ? [] : [thinkingChange(overrides.thinking ?? "high")]),
		userEntry(overrides.prompt ?? promptText),
		...(overrides.compaction ? [compactionEntry()] : []),
		assistantEntry({ provider: overrides.provider, model: overrides.model, stopReason: overrides.stopReason }),
	];
}

function sessionBytes(promptText: string, overrides: ValidSessionOverrides = {}): Buffer {
	return Buffer.from(validSessionEntries(promptText, overrides).map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

async function validRaw(): Promise<Buffer> {
	return sessionBytes(await frozenPromptText());
}

// ------------------------------------------------------------------ fake runner

interface FakeBehavior {
	exitCode?: number | null;
	timedOut?: boolean;
	spawnError?: string | null;
	sessionFiles?: Array<{ name: string; bytes: Buffer }>;
	stdoutOverflow?: boolean;
	stderrOverflow?: boolean;
}

/**
 * Injected attempt runner recording every request. The factory is called
 * per attempt (0-based index) and may return a Promise; the LAST factory
 * is reused for every further attempt (so an all-invalid cap run needs
 * only one behavior).
 */
function makeFakeRunner(factory: (request: AttemptRunRequest, index: number) => FakeBehavior | Promise<FakeBehavior>): {
	runner: AttemptRunner;
	calls: AttemptRunRequest[];
} {
	const calls: AttemptRunRequest[] = [];
	const runner: AttemptRunner = async (request) => {
		calls.push(request);
		const index = calls.length - 1;
		const behavior = await factory(request, index);
		const sessionDir = request.argv[request.argv.indexOf("--session-dir") + 1];
		assert.ok(sessionDir !== undefined, "fake runner: --session-dir missing from argv");
		for (const file of behavior.sessionFiles ?? []) {
			await writeFile(join(sessionDir, file.name), file.bytes);
		}
		const result: SpawnedAttemptResult = {
			exitCode: behavior.exitCode ?? 0,
			timedOut: behavior.timedOut ?? false,
			spawnError: behavior.spawnError ?? null,
			stdout: { bytes: Buffer.alloc(0), overflow: behavior.stdoutOverflow ?? false },
			stderr: { bytes: Buffer.alloc(0), overflow: behavior.stderrOverflow ?? false },
		};
		return result;
	};
	return { runner, calls };
}

/** All-valid behavior factory (each attempt produces a fresh valid raw session). */
function alwaysValid(): (request: AttemptRunRequest, index: number) => FakeBehavior | Promise<FakeBehavior> {
	return async () => ({ sessionFiles: [{ name: "session.jsonl", bytes: await validRaw() }] });
}

function collectOptions(root: string, overrides: Partial<CollectDevPilotOptions> = {}): CollectDevPilotOptions {
	return {
		paths: { projectRoot: root, inputsDir: INPUTS_DIR, runsDir: join(root, ".pi", "workbench", "runs") },
		...overrides,
	};
}

function outputRootOf(root: string): string {
	return join(root, ".pi", "workbench", "runs", OUTPUT_ROOT_NAME);
}

/** The arm extension path the collector builds for a temp project root. */
function controlExtensionOf(root: string): string {
	return join(root, "scripts", "commander-native-tool-control-extension.ts");
}

/** Arms derived from the extension path each attempt actually received. */
function armsOf(calls: readonly AttemptRunRequest[], root: string): string[] {
	return calls.map((call) => (call.argv[4] === controlExtensionOf(root) ? "control" : "treatment"));
}

function captureIo(): { io: PilotIo; stdout: string[]; stderr: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return { io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, stdout, stderr };
}

async function expectMissing(path: string): Promise<void> {
	await assert.rejects(stat(path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
}

/** Recursive byte-exact tree copy for preflight-drift tests. */
async function copyTree(source: string, dest: string): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dest, { recursive: true });
	for (const name of await readdir(source)) {
		const from = join(source, name);
		const to = join(dest, name);
		const info = await stat(from);
		if (info.isDirectory()) {
			await copyTree(from, to);
		} else {
			await writeFile(to, await readFile(from));
		}
	}
}

// ------------------------------------------------------------------ fixed plan and builders

test("fixed plan is the frozen ABBA sequence from abbaArmAt(1..8)", () => {
	const plan = fixedPlan();
	assert.equal(plan.length, DEV_PILOT_VALID_SESSIONS);
	assert.deepEqual(
		[...plan],
		["control", "treatment", "treatment", "control", "control", "treatment", "treatment", "control"],
	);
	plan.forEach((arm, index) => assert.equal(arm, abbaArmAt(index + 1)));
});

test("attempt identity helpers are deterministic and zero-padded", () => {
	assert.equal(attemptLabel(1), "01");
	assert.equal(attemptLabel(12), "12");
	assert.equal(attemptName(3, "treatment"), "nro-dev-pilot-03-treatment");
	assert.equal(rawSourceName(12, "control"), "raw-12-control.jsonl");
	assert.equal(attemptSessionDirName(7), ".attempt-07-session");
});

test("buildAttemptArgv is exact: flag order, pins, fresh session dir, prompt as sole positional", async () => {
	const promptText = await frozenPromptText();
	const argv = buildAttemptArgv({
		extensionPath: CONTROL_EXTENSION,
		sessionDir: "/tmp/pilot/.attempt-01-session",
		attemptNumber: 1,
		arm: "control",
		promptText,
	});
	assert.deepEqual(argv, [
		"--print",
		"--approve",
		"--no-extensions",
		"--extension",
		CONTROL_EXTENSION,
		"--model",
		"openai-codex/gpt-5.6-sol",
		"--thinking",
		"high",
		"--session-dir",
		"/tmp/pilot/.attempt-01-session",
		"--name",
		"nro-dev-pilot-01-control",
		"--tools",
		"read,grep",
		promptText,
	]);
	// the prompt is the ONLY positional argument: it appears exactly once,
	// as the last element, byte-exact (hash-pinned)
	assert.equal(argv.length, 16);
	assert.equal(argv[argv.length - 1], promptText);
	assert.equal(argv.filter((arg) => arg === promptText).length, 1);
	const last = argv[argv.length - 1];
	assert.ok(last !== undefined);
	assert.equal(sha256Hex(last), FROZEN_NRO_PROTOCOL.milestonePromptSha256);
	assert.equal(Buffer.byteLength(last, "utf8"), Buffer.byteLength(promptText, "utf8"));
	// pinned model/thinking come from the frozen protocol environment
	assert.equal(argv[6], FROZEN_NRO_PROTOCOL.environment.modelKey);
	assert.equal(argv[8], FROZEN_NRO_PROTOCOL.environment.thinkingLevel);
});

test("buildAttemptEnv inherits the base env (credentials) and pins the pilot overrides", () => {
	const env = buildAttemptEnv({ PATH: "/usr/bin", CREDENTIAL: "secret-value" });
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.CREDENTIAL, "secret-value");
	assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
	assert.equal(env.PI_TELEMETRY, "0");
	// undefined base values are dropped; existing override keys are replaced
	const env2 = buildAttemptEnv({ UNDEFINED_KEY: undefined, PATH: "/bin", PI_TELEMETRY: "1" });
	assert.equal("UNDEFINED_KEY" in env2, false);
	assert.equal(env2.PATH, "/bin");
	assert.equal(env2.PI_TELEMETRY, "0");
});

test("createCappedCapture hard-caps bytes and flags overflow", () => {
	const cap = createCappedCapture(10);
	cap.push(Buffer.from("0123456789", "utf8")); // exactly the cap
	assert.deepEqual(cap.result(), { bytes: Buffer.from("0123456789", "utf8"), overflow: false });
	cap.push(Buffer.from("ABCDEFGHIJ", "utf8")); // all beyond the cap
	assert.equal(cap.result().overflow, true);
	assert.equal(cap.result().bytes.toString("utf8"), "0123456789");
	const small = createCappedCapture(3);
	small.push(Buffer.from("abcdef", "utf8"));
	assert.deepEqual(small.result(), { bytes: Buffer.from("abc", "utf8"), overflow: true });
});

// ------------------------------------------------------------------ classifier

test("classifySession: a valid session passes every check", async () => {
	const raw = await validRaw();
	const verdict = classifySession({ exitCode: 0, timedOut: false, raw, protocol: FROZEN_NRO_PROTOCOL });
	assert.deepEqual(verdict, { valid: true, reason: null, detail: null });
});

test("classifySession fails closed on every validity failure with the exact reason", async () => {
	const promptText = await frozenPromptText();
	const cases: Array<{ name: string; raw: Buffer; exitCode: number | null; timedOut: boolean; reason: string }> = [
		{ name: "exit", raw: sessionBytes(promptText), exitCode: 7, timedOut: false, reason: "exit" },
		{ name: "timeout", raw: sessionBytes(promptText), exitCode: 0, timedOut: true, reason: "timeout" },
		{ name: "prompt", raw: sessionBytes(promptText, { prompt: "a completely different prompt" }), exitCode: 0, timedOut: false, reason: "prompt" },
		{ name: "model", raw: sessionBytes(promptText, { provider: "other-provider", model: "other-model" }), exitCode: 0, timedOut: false, reason: "model" },
		{ name: "thinking", raw: sessionBytes(promptText, { thinking: "low" }), exitCode: 0, timedOut: false, reason: "thinking" },
		{ name: "thinking-missing", raw: sessionBytes(promptText, { thinking: null }), exitCode: 0, timedOut: false, reason: "thinking" },
		{ name: "compaction", raw: sessionBytes(promptText, { compaction: true }), exitCode: 0, timedOut: false, reason: "compaction" },
		{ name: "terminal", raw: sessionBytes(promptText, { stopReason: "length" }), exitCode: 0, timedOut: false, reason: "terminal" },
		{ name: "terminal-aborted", raw: sessionBytes(promptText, { stopReason: "aborted" }), exitCode: 0, timedOut: false, reason: "terminal" },
		{ name: "malformed", raw: Buffer.from("not json at all\n", "utf8"), exitCode: 0, timedOut: false, reason: "malformed" },
		{ name: "missing-assistant", raw: Buffer.from(JSON.stringify({ type: "message", id: "u", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: promptText }] } }) + "\n", "utf8"), exitCode: 0, timedOut: false, reason: "malformed" },
	];
	for (const c of cases) {
		const verdict = classifySession({ exitCode: c.exitCode, timedOut: c.timedOut, raw: c.raw, protocol: FROZEN_NRO_PROTOCOL });
		assert.equal(verdict.valid, false, c.name);
		assert.equal(verdict.reason, c.reason, c.name);
		assert.ok(verdict.detail !== null && verdict.detail.length > 0, c.name);
	}
});

// ------------------------------------------------------------------ collection

test("fixed-order collection: 8 valid sessions in frozen ABBA order, complete", async () => {
	await withTempDir(async (root) => {
		const produced: Buffer[] = [];
		const { runner, calls } = makeFakeRunner(async () => {
			const bytes = await validRaw();
			produced.push(bytes);
			return { sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const diagnostics: string[] = [];
		const result = await collectDevPilot(collectOptions(root, { runner, onDiagnostic: (line) => diagnostics.push(line) }));

		assert.equal(result.status, "complete");
		assert.equal(result.validSessions, 8);
		assert.equal(result.attempts, 8);
		assert.deepEqual(diagnostics, []);

		// frozen ABBA arm order across the attempts
		const arms = armsOf(calls, root);
		assert.deepEqual(arms, ["control", "treatment", "treatment", "control", "control", "treatment", "treatment", "control"]);
		const names = calls.map((call) => call.argv[call.argv.indexOf("--name") + 1]);
		assert.deepEqual(names, [
			"nro-dev-pilot-01-control",
			"nro-dev-pilot-02-treatment",
			"nro-dev-pilot-03-treatment",
			"nro-dev-pilot-04-control",
			"nro-dev-pilot-05-control",
			"nro-dev-pilot-06-treatment",
			"nro-dev-pilot-07-treatment",
			"nro-dev-pilot-08-control",
		]);

		// deterministic retained source names
		const sources = (await readdir(join(outputRootOf(root), SOURCES_DIR_NAME))).sort();
		assert.deepEqual(sources, [
			"raw-01-control.jsonl",
			"raw-02-treatment.jsonl",
			"raw-03-treatment.jsonl",
			"raw-04-control.jsonl",
			"raw-05-control.jsonl",
			"raw-06-treatment.jsonl",
			"raw-07-treatment.jsonl",
			"raw-08-control.jsonl",
		]);

		// strict record: 8 session entries in chronological order, no attempts
		assert.deepEqual(
			result.record.entries.map((entry) => ({ kind: entry.kind, arm: entry.arm, path: entry.path })),
			sources.map((name) => ({ kind: "session" as const, arm: name.includes("control") ? ("control" as const) : ("treatment" as const), path: `sources/${name}` })),
		);

		// per-attempt session dirs were removed (empty after moving the raw)
		const outputEntries = await readdir(outputRootOf(root));
		assert.ok(!outputEntries.some((name) => name.startsWith(".attempt-")), "empty per-attempt dirs must be removed");

		// relative collection path is project-relative and stdout-safe
		assert.equal(result.relativeCollectionPath, `.pi/workbench/runs/${OUTPUT_ROOT_NAME}/collection-record.json`);
		assert.ok(!result.relativeCollectionPath.startsWith("/"));
	});
});

test("an invalid attempt retries the same required arm, then success completes at 9 attempts", async () => {
	await withTempDir(async (root) => {
		const produced: Buffer[] = [];
		const diagnostics: string[] = [];
		const { runner, calls } = makeFakeRunner(async (_request, index) => {
			const bytes = await validRaw();
			produced.push(bytes);
			if (index === 0) {
				return { exitCode: 7, sessionFiles: [{ name: "session.jsonl", bytes }], stdoutOverflow: true };
			}
			return { sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const result = await collectDevPilot(collectOptions(root, { runner, onDiagnostic: (line) => diagnostics.push(line) }));

		assert.equal(result.status, "complete");
		assert.equal(result.validSessions, 8);
		assert.equal(result.attempts, 9);

		// attempt 1 invalid -> attempt 2 retries the SAME required arm (control)
		const arms = armsOf(calls, root);
		assert.deepEqual(arms, ["control", "control", "treatment", "treatment", "control", "control", "treatment", "treatment", "control"]);

		// retained: 1 attempt + 8 sessions, chronological, truthful
		assert.deepEqual(
			result.record.entries.map((entry) => entry.kind),
			["attempt", "session", "session", "session", "session", "session", "session", "session", "session"],
		);
		assert.equal(result.record.entries[0]?.arm, "control");
		assert.equal(result.record.entries[0]?.path, "sources/raw-01-control.jsonl");
		const sources = (await readdir(join(outputRootOf(root), SOURCES_DIR_NAME))).sort();
		assert.equal(sources.length, 9);

		// bounded diagnostic on stderr: reason + overflow flag, no content/paths
		assert.equal(diagnostics.length, 1);
		const line = diagnostics[0] as string;
		assert.ok(line.startsWith("commander-native-tool-dev-pilot: attempt 01 (control) invalid: exit"));
		assert.ok(line.includes("(stdout overflow)"));
		assert.ok(!line.includes(root));
		assert.ok(!line.includes("milestone"));
	});
});

test("the 12-attempt cap yields a truthful partial collection and exits 1", async () => {
	await withTempDir(async (root) => {
		const diagnostics: string[] = [];
		const { runner, calls } = makeFakeRunner(async () => {
			const bytes = await validRaw();
			return { exitCode: 3, sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const result = await collectDevPilot(collectOptions(root, { runner, onDiagnostic: (line) => diagnostics.push(line) }));

		assert.equal(result.status, "attempts-exhausted");
		assert.equal(result.validSessions, 0);
		assert.equal(result.attempts, DEV_PILOT_MAX_ATTEMPTS);
		assert.equal(calls.length, 12);

		// position never advanced: every attempt retried the same required arm
		const arms = new Set(armsOf(calls, root));
		assert.deepEqual([...arms], ["control"]);

		// 12 retained attempt sources + 12 chronological attempt entries
		const sources = (await readdir(join(outputRootOf(root), SOURCES_DIR_NAME))).sort();
		assert.deepEqual(sources, Array.from({ length: 12 }, (_v, i) => `raw-${attemptLabel(i + 1)}-control.jsonl`));
		assert.equal(result.record.entries.length, 12);
		assert.ok(result.record.entries.every((entry) => entry.kind === "attempt" && entry.arm === "control"));
		assert.equal(diagnostics.length, 12);

		// CLI plumbing: exhausted => exit 1 with the bounded summary on stdout
		const { io, stdout, stderr } = captureIo();
		const code = await main([], io, async () => result);
		assert.equal(code, 1);
		assert.deepEqual(stdout, [renderSummary(result)]);
		assert.deepEqual(stderr, []);
		assert.ok(!stdout.join("\n").includes(root), "summary must not carry absolute paths");
	});
});

test("a timed-out attempt is classified invalid even with exit 0 and valid bytes", async () => {
	await withTempDir(async (root) => {
		const { runner, calls } = makeFakeRunner(async (_request, index) => {
			const bytes = await validRaw();
			if (index === 0) return { exitCode: 0, timedOut: true, sessionFiles: [{ name: "session.jsonl", bytes }] };
			return { sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const result = await collectDevPilot(collectOptions(root, { runner }));
		assert.equal(result.status, "complete");
		assert.equal(result.attempts, 9);
		assert.equal(result.record.entries[0]?.kind, "attempt");
		assert.equal(result.record.entries[0]?.arm, "control");
		// the same required arm is retried after the timeout
		const arms = armsOf(calls, root);
		assert.deepEqual(arms.slice(0, 2), ["control", "control"]);
		// the timed-out raw session is still retained byte-exact
		const retained = await readFile(join(outputRootOf(root), SOURCES_DIR_NAME, "raw-01-control.jsonl"));
		assert.ok(retained.length > 0);
	});
});

test("existing output root fails closed and is never touched", async () => {
	await withTempDir(async (root) => {
		const { mkdir } = await import("node:fs/promises");
		const outputRoot = outputRootOf(root);
		await mkdir(outputRoot, { recursive: true });
		await writeFile(join(outputRoot, "junk.txt"), "pre-existing");
		const { runner } = makeFakeRunner(alwaysValid());
		await assert.rejects(
			collectDevPilot(collectOptions(root, { runner })),
			(error: unknown) => error instanceof PilotError && error.code === "EXISTING_OUTPUT",
		);
		assert.equal(await readFile(join(outputRoot, "junk.txt"), "utf8"), "pre-existing");
		await expectMissing(join(outputRoot, COLLECTION_RECORD_NAME));

		// CLI: runtime failure => exit 1, stderr only
		const { io, stdout, stderr } = captureIo();
		const code = await main([], io, async () => {
			throw new PilotError("EXISTING_OUTPUT", `output root ${OUTPUT_ROOT_NAME} already exists — refusing to overwrite`);
		});
		assert.equal(code, 1);
		assert.deepEqual(stdout, []);
		assert.equal(stderr.length, 1);
		assert.ok((stderr[0] as string).includes("EXISTING_OUTPUT"));
	});
});

test("zero produced session files fail closed without fabricating an entry", async () => {
	await withTempDir(async (root) => {
		const produced: Buffer[] = [];
		const { runner } = makeFakeRunner(async (_request, index) => {
			if (index === 0) {
				// attempt 1 produces an invalid raw (retained)
				const bytes = await validRaw();
				produced.push(bytes);
				return { exitCode: 1, sessionFiles: [{ name: "session.jsonl", bytes }] };
			}
			// attempt 2 produces NOTHING
			return { sessionFiles: [] };
		});
		await assert.rejects(
			collectDevPilot(collectOptions(root, { runner })),
			(error: unknown) => error instanceof PilotError && error.code === "SESSION_FILE_COUNT",
		);
		// partial collection stays truthful: only attempt 1 is recorded
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.equal(record.entries.length, 1);
		assert.deepEqual(record.entries[0], { kind: "attempt", arm: "control", path: "sources/raw-01-control.jsonl" });
		const sources = await readdir(join(outputRootOf(root), SOURCES_DIR_NAME));
		assert.deepEqual(sources, ["raw-01-control.jsonl"]);
	});
});

test("multiple produced session files fail closed with nothing fabricated", async () => {
	await withTempDir(async (root) => {
		const bytes = await validRaw();
		const { runner } = makeFakeRunner(() => ({
			sessionFiles: [
				{ name: "session.jsonl", bytes },
				{ name: "duplicate.jsonl", bytes },
			],
		}));
		await assert.rejects(
			collectDevPilot(collectOptions(root, { runner })),
			(error: unknown) => error instanceof PilotError && error.code === "SESSION_FILE_COUNT",
		);
		// no record, no retained sources, no fabricated evidence
		await expectMissing(join(outputRootOf(root), COLLECTION_RECORD_NAME));
		assert.deepEqual(await readdir(join(outputRootOf(root), SOURCES_DIR_NAME)), []);
	});
});

test("only the empty per-attempt dir is removed after moving the raw session", async () => {
	await withTempDir(async (root) => {
		const { runner } = makeFakeRunner(async (_request, index) => {
			const bytes = await validRaw();
			if (index === 0) {
				return { sessionFiles: [{ name: "session.jsonl", bytes }, { name: "notes.txt", bytes: Buffer.from("extra", "utf8") }] };
			}
			return { sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const result = await collectDevPilot(collectOptions(root, { runner }));
		assert.equal(result.status, "complete");
		const outputEntries = (await readdir(outputRootOf(root))).sort();
		// attempt 1's dir is NOT empty (notes.txt) so it survives; the rest were removed
		assert.deepEqual(outputEntries.filter((name) => name.startsWith(".attempt-")), [".attempt-01-session"]);
		const leftovers = await readdir(join(outputRootOf(root), ".attempt-01-session"));
		assert.deepEqual(leftovers, ["notes.txt"]);
	});
});

test("preflight enforces the frozen protocol and pins before any output exists", async () => {
	await withTempDir(async (root) => {
		const { mkdir } = await import("node:fs/promises");
		const { runner } = makeFakeRunner(alwaysValid());

		// unfrozen protocol pin => PROTOCOL_NOT_FROZEN
		const unfrozen: FrozenProtocol = { ...FROZEN_NRO_PROTOCOL, milestonePromptSha256: null };
		await assert.rejects(
			collectDevPilot(collectOptions(root, { runner, protocol: unfrozen })),
			(error: unknown) => error instanceof NroError && error.code === "PROTOCOL_NOT_FROZEN",
		);
		await expectMissing(outputRootOf(root));

		// prompt pin drift => MILESTONE_MISMATCH (inputs copied byte-exact, prompt replaced)
		const driftedInputs = join(root, "drifted-inputs");
		await copyTree(INPUTS_DIR, driftedInputs);
		await writeFile(join(driftedInputs, "milestone-prompt.txt"), "a different prompt", "utf8");
		await assert.rejects(
			collectDevPilot(collectOptions(root, { runner, paths: { projectRoot: root, inputsDir: driftedInputs, runsDir: join(root, ".pi", "workbench", "runs") } })),
			(error: unknown) => error instanceof NroError && error.code === "MILESTONE_MISMATCH",
		);
		await expectMissing(outputRootOf(root));

		// fixture pin drift => FIXTURE_MISMATCH (one fixture byte modified)
		const driftedFixture = join(root, "drifted-fixture-inputs");
		await copyTree(INPUTS_DIR, driftedFixture);
		const buildPath = join(driftedFixture, "fixture", "meta", "build.txt");
		await writeFile(buildPath, `${await readFile(buildPath, "utf8")}x`, "utf8");
		await assert.rejects(
			collectDevPilot(collectOptions(root, { runner, paths: { projectRoot: root, inputsDir: driftedFixture, runsDir: join(root, ".pi", "workbench", "runs") } })),
			(error: unknown) => error instanceof NroError && error.code === "FIXTURE_MISMATCH",
		);
		await expectMissing(outputRootOf(root));
	});
});

test("raw sessions are retained byte-exact and the record is strictly chronological with the frozen pin", async () => {
	await withTempDir(async (root) => {
		const produced: Buffer[] = [];
		const { runner, calls } = makeFakeRunner(async (_request, index) => {
			const bytes = await validRaw();
			produced.push(bytes);
			if (index === 3) return { exitCode: 9, sessionFiles: [{ name: "session.jsonl", bytes }] }; // one invalid in the middle
			return { sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const result = await collectDevPilot(collectOptions(root, { runner }));
		assert.equal(result.status, "complete");
		assert.equal(result.attempts, 9);

		// persisted record == in-memory record, parses strictly, frozen pin
		const recordText = await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8");
		const persisted = parseCollectionRecord(recordText, "collection record");
		assert.deepEqual(persisted, result.record);
		assert.equal(persisted.schemaVersion, 1);
		assert.equal(persisted.phase, "dev");
		assert.equal(persisted.nonTreatmentSha256, FROZEN_NRO_PROTOCOL.nonTreatmentSha256);
		// exact wire shape (strict key set, no extras)
		assert.deepEqual(JSON.parse(recordText), {
			schema_version: 1,
			phase: "dev",
			non_treatment_sha256: FROZEN_NRO_PROTOCOL.nonTreatmentSha256,
			entries: result.record.entries.map((entry) => ({ kind: entry.kind, arm: entry.arm, path: entry.path })),
		});
		// serializer round-trips through the strict parser
		assert.deepEqual(parseCollectionRecord(serializeCollectionRecord(result.record), "collection record"), result.record);

		// chronology: entries in exact attempt order (attempt 4 was the invalid one)
		assert.deepEqual(
			result.record.entries.map((entry) => entry.kind),
			["session", "session", "session", "attempt", "session", "session", "session", "session", "session"],
		);

		// byte preservation: every retained source is byte-identical to the produced raw
		for (let i = 0; i < produced.length; i += 1) {
			const entry = result.record.entries[i];
			assert.ok(entry !== undefined);
			const retained = await readFile(join(outputRootOf(root), entry.path));
			assert.ok(retained.equals(produced[i] as Buffer), `source ${entry.path} must be byte-identical`);
		}

		// every attempt ran against the same fixture cwd and pi program
		for (const call of calls) {
			assert.equal(call.cwd, FIXTURE_CWD);
			assert.equal(call.program, join(root, "node_modules", ".bin", "pi"));
			assert.equal(call.timeoutMs, ATTEMPT_TIMEOUT_MS);
			assert.equal(call.terminateGraceMs, TERMINATE_GRACE_MS);
			assert.equal(call.stdoutMaxBytes, ATTEMPT_STDOUT_MAX_BYTES);
			assert.equal(call.stderrMaxBytes, ATTEMPT_STDERR_MAX_BYTES);
		}
	});
});

test("attempt argv differs between arms ONLY in extension/name/session dir; env is identical", async () => {
	await withTempDir(async (root) => {
		const { runner, calls } = makeFakeRunner(alwaysValid());
		// project root = the REAL repo root: this pins the exact production
		// arm extension paths (scripts/... vs extensions/...) in the argv
		const runsDir = join(root, "runs");
		const result = await collectDevPilot({ paths: { projectRoot: PROJECT_ROOT, inputsDir: INPUTS_DIR, runsDir }, runner });
		assert.equal(result.status, "complete");
		assert.equal(calls.length, 8);

		const EXTENSION = 4;
		const SESSION_DIR = 10;
		const NAME = 12;
		for (let i = 0; i < calls.length; i += 1) {
			for (let j = i + 1; j < calls.length; j += 1) {
				const a = calls[i] as AttemptRunRequest;
				const b = calls[j] as AttemptRunRequest;
				assert.equal(a.argv.length, b.argv.length);
				const differing: number[] = [];
				a.argv.forEach((value, index) => {
					if (value !== b.argv[index]) differing.push(index);
				});
				const sameArm = a.argv[EXTENSION] === b.argv[EXTENSION];
				// extension differs iff the arm differs; name/session dir always differ
				assert.deepEqual(differing, sameArm ? [SESSION_DIR, NAME] : [EXTENSION, SESSION_DIR, NAME]);
				// env is IDENTICAL across attempts and arms
				assert.deepEqual(a.env, b.env);
				assert.equal(a.env.PI_SKIP_VERSION_CHECK, "1");
				assert.equal(a.env.PI_TELEMETRY, "0");
			}
		}

		// arm extension paths are the exact production files
		assert.ok(calls.some((call) => call.argv[EXTENSION] === CONTROL_EXTENSION));
		assert.ok(calls.some((call) => call.argv[EXTENSION] === TREATMENT_EXTENSION));

		// session dirs are fresh per attempt under the output root; names unique
		const sessionDirs = calls.map((call) => call.argv[SESSION_DIR] as string);
		const names = calls.map((call) => call.argv[NAME] as string);
		assert.equal(new Set(sessionDirs).size, 8);
		assert.equal(new Set(names).size, 8);
		const outputRoot = join(runsDir, OUTPUT_ROOT_NAME);
		for (const dir of sessionDirs) {
			assert.ok(dir.startsWith(outputRoot + sep), "session dir must live under the output root");
			assert.ok(dir.endsWith("-session"));
		}

		// raw prompt exactness: byte-identical prompt as the sole positional in every attempt
		const promptText = await frozenPromptText();
		for (const call of calls) {
			assert.equal(call.argv[call.argv.length - 1], promptText);
			assert.equal(sha256Hex(call.argv[call.argv.length - 1] as string), FROZEN_NRO_PROTOCOL.milestonePromptSha256);
			assert.equal(call.argv.length, 16);
			assert.equal(call.argv.filter((arg) => arg === promptText).length, 1);
		}
	});
});

// ------------------------------------------------------------------ CLI

test("main: --help/-h exit 0 with usage on stdout and nothing on stderr", async () => {
	const { io, stdout, stderr } = captureIo();
	assert.equal(await main(["--help"], io), 0);
	assert.equal(await main(["-h"], io), 0);
	const all = stdout.join("\n");
	assert.ok(all.includes("usage:"));
	assert.ok(all.includes("exit codes: 0"));
	assert.ok(usage().includes("DEV evidence only, never final evidence"));
	assert.deepEqual(stderr, []);
});

test("main: unknown and positional arguments exit 2 with usage on stderr", async () => {
	for (const argv of [["x"], ["--flag"], ["positional"], ["a", "b"], ["--help", "extra"], ["-h", "x"]]) {
		const { io, stdout, stderr } = captureIo();
		const code = await main(argv, io);
		assert.equal(code, 2, JSON.stringify(argv));
		assert.deepEqual(stdout, [], JSON.stringify(argv));
		assert.ok(stderr.length >= 1, JSON.stringify(argv));
		assert.ok((stderr[0] as string).includes("unexpected argument"), JSON.stringify(argv));
		assert.ok(stderr.join("\n").includes("usage:"), JSON.stringify(argv));
	}
});

test("main: complete run exits 0 with a single bounded relative summary", async () => {
	await withTempDir(async (root) => {
		const { runner } = makeFakeRunner(alwaysValid());
		const { io, stdout, stderr } = captureIo();
		const code = await main([], io, async (opts) => collectDevPilot({ ...collectOptions(root, { runner }), onDiagnostic: opts.onDiagnostic }));
		assert.equal(code, 0);
		assert.equal(stdout.length, 1);
		const line = stdout[0] as string;
		assert.equal(line, `commander-native-tool-dev-pilot: status=complete valid=8 attempts=8 collection=.pi/workbench/runs/${OUTPUT_ROOT_NAME}/collection-record.json`);
		assert.ok(!line.includes(root), "summary must not carry absolute paths");
		assert.ok(!line.includes(await frozenPromptText()), "summary must never carry prompt content");
		assert.deepEqual(stderr, []);
	});
});

test("main: exhausted run exits 1 with the truthful partial summary and bounded diagnostics", async () => {
	await withTempDir(async (root) => {
		const { runner } = makeFakeRunner(async () => {
			const bytes = await validRaw();
			return { exitCode: 3, sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const { io, stdout, stderr } = captureIo();
		const code = await main([], io, async (opts) => collectDevPilot({ ...collectOptions(root, { runner }), onDiagnostic: opts.onDiagnostic }));
		assert.equal(code, 1);
		assert.equal(stdout.length, 1);
		assert.equal(stdout[0], `commander-native-tool-dev-pilot: status=attempts-exhausted valid=0 attempts=12 collection=.pi/workbench/runs/${OUTPUT_ROOT_NAME}/collection-record.json`);
		// per-attempt diagnostics on stderr, bounded, no absolute paths
		assert.equal(stderr.length, 12);
		for (const line of stderr) {
			assert.ok(/^commander-native-tool-dev-pilot: attempt \d{2} \(control\) invalid: exit — process exit code 3$/.test(line), line);
			assert.ok(!line.includes(root), "diagnostics must not carry absolute paths");
			assert.ok(!line.includes(await frozenPromptText()), "diagnostics must never carry prompt content");
		}
	});
});

test("main: runtime failures exit 1 with stderr only (never a partial stdout claim)", async () => {
	const { io, stdout, stderr } = captureIo();
	const code = await main([], io, async () => {
		throw new PilotError("SPAWN_FAILED", "the attempt process could not be started (details withheld)");
	});
	assert.equal(code, 1);
	assert.deepEqual(stdout, []);
	assert.equal(stderr.length, 1);
	assert.equal(stderr[0], "commander-native-tool-dev-pilot: SPAWN_FAILED: the attempt process could not be started (details withheld)");
});

test("main: non-pilot runtime failures are withheld (privacy boundary)", async () => {
	const { io, stdout, stderr } = captureIo();
	const code = await main([], io, async () => {
		throw new Error(`sensitive detail ${PROJECT_ROOT}`);
	});
	assert.equal(code, 1);
	assert.deepEqual(stdout, []);
	assert.equal(stderr.length, 1);
	assert.equal(stderr[0], "commander-native-tool-dev-pilot: unexpected failure (details withheld — privacy boundary)");
});
