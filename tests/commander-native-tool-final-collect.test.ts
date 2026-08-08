/**
 * Hermetic unit tests for the NRO FINAL collector
 * (`scripts/commander-native-tool-final-collect.ts`).
 *
 * The collector is exercised ONLY through its injected seams: temp dirs
 * for every output and for the project root (bundle + pi binary + FINAL
 * arm files + package.json), a fake injected attempt runner (never a
 * real spawn), injected runtime facts for the Node pin, and injected IO
 * for the CLI. No provider, model, network, real pi process, or full
 * workbench runtime is ever invoked. The only repository files touched
 * are the frozen inputs (read-only preflight against the real
 * `fixtures/commander-native-tool-benchmark/inputs`) and the frozen
 * protocol constants reused from the benchmark module.
 *
 * Covered contract:
 *   - fixed plan: exactly the frozen ABBA arms abbaArmAt(1..40) = ABBA
 *     repeated ten times (20 sessions per arm);
 *   - exact attempt argv (flag order, pinned model/thinking, tools
 *     allowlist, fresh session dir, `nro-final-<NN>-<arm>` name, raw
 *     milestone prompt as the sole positional message, byte-exact) and
 *     env (inherited + PI_SKIP_VERSION_CHECK=1 + PI_TELEMETRY=0);
 *   - fixed-order collection: 40 valid sessions in ABBA order, complete
 *     status, deterministic `sources/raw-<NN>-<arm>.jsonl` retention,
 *     per-attempt session dirs cleaned up when empty;
 *   - invalid attempts retry the same required arm (all six frozen
 *     categories), are retained as `kind: "attempt"`, and diagnostics
 *     stay bounded on stderr;
 *   - analyzer-compatible classification: only the six frozen attempt
 *     categories become attempts; exit code/timeout are diagnostic only
 *     and never turn machine-valid raw into an attempt; malformed and
 *     unclassified-but-final-invalid raws are UNREPRESENTABLE hard
 *     fails that preserve the truthful record and attempt directory;
 *   - the 60-attempt cap exits 1 with a truthful partial collection;
 *   - preflight BEFORE any output/call: frozen inputs, the exact
 *     non-treatment bundle hash, injected Node pin, exact package Pi
 *     pin, required regular pi/FINAL-arm files — each drift/missing
 *     case fails closed with no calls and no output;
 *   - initial empty strict record; byte preservation and the strict
 *     chronological record: schema 1, phase "final", no status/cap
 *     field, parseCollectionRecord round-trip, every entry's file
 *     byte-identical to the produced raw;
 *   - existing output refusal (EXISTING_OUTPUT);
 *   - zero/multiple/oversized/non-regular produced session files, or a
 *     valid file plus any second direct .jsonl entry (symlink,
 *     directory, or oversized file), fail closed (SESSION_FILE_COUNT)
 *     with no fabricated entries and the attempt directory preserved;
 *   - non-treatment bundle hash rejects a symlinked or non-regular root
 *     AGENTS.md (no-follow), a symlinked ROOT bundle directory
 *     (skills/prompts/templates — never followed), and any symlink
 *     under the walked roots, before any output or call;
 *   - fail-safe retention: the attempt-dir original is removed only
 *     after the destination source is byte-verified AND the updated
 *     record is atomically committed/read back; an injected per-attempt
 *     PRE-rename record-commit failure pops the in-memory entry, removes
 *     the new destination, and leaves the prior/empty persisted record
 *     truthful with the original raw still in its attempt dir; an
 *     injected POST-rename/read-back failure hard-fails keeping the
 *     committed in-memory entry, the retained destination source
 *     byte-exact, and the attempt-dir original (cleanup never reached);
 *     an injected retention failure immediately after exclusive source
 *     creation cleans the newly-created destination (bounded SOURCE_IO)
 *     and leaves the prior/empty record and attempt-dir original
 *     untouched;
 *   - required-file semantics: the pi binary check allow-follows an
 *     npm-style symlink that resolves to a regular file, while the
 *     FINAL control adapter and treatment runtime must be no-follow
 *     regular files — a symlinked arm file fails preflight with no
 *     output or call;
 *   - spawn failure hard-fails (SPAWN_FAILED), is never counted, and
 *     leaves the initial empty record + attempt dir;
 *   - argv/env parity between arms (extension/name/session dir are the
 *     ONLY argv differences; env identical);
 *   - CLI discipline via main with injected IO: --help/-h 0, unknown/
 *     positional 2, runtime 1 (stderr only), complete 0 / exhausted 1
 *     with a bounded relative summary and no absolute paths.
 */

import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile, symlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import {
	COLLECTION_RECORD_NAME,
	FROZEN_NRO_PROTOCOL,
	NroError,
	SESSION_MAX_BYTES,
	abbaArmAt,
	parseCollectionRecord,
	sha256Hex,
} from "../scripts/commander-native-tool-benchmark.ts";
import type { FrozenProtocol } from "../scripts/commander-native-tool-benchmark.ts";
import {
	ATTEMPT_STDERR_MAX_BYTES,
	ATTEMPT_STDOUT_MAX_BYTES,
	ATTEMPT_TIMEOUT_MS,
	FINAL_MAX_ATTEMPTS,
	FINAL_PHASE,
	FINAL_VALID_SESSIONS,
	FinalCollectError,
	OUTPUT_ROOT_NAME,
	SOURCES_DIR_NAME,
	TERMINATE_GRACE_MS,
	attemptLabel,
	attemptName,
	attemptSessionDirName,
	buildAttemptArgv,
	buildAttemptEnv,
	classifyFinalSession,
	collectFinal,
	createCappedCapture,
	fixedPlan,
	main,
	nonTreatmentBundleHash,
	rawSourceName,
	renderSummary,
	serializeCollectionRecord,
	usage,
} from "../scripts/commander-native-tool-final-collect.ts";
import type {
	AttemptRunner,
	AttemptRunRequest,
	CollectFinalOptions,
	CollectResult,
	FinalIo,
	SpawnedAttemptResult,
} from "../scripts/commander-native-tool-final-collect.ts";
import { parseRecipesDocument } from "../extensions/workbench-runtime/core/recipe-schema.ts";
import { withTempDir } from "./helpers.ts";

// ------------------------------------------------------------------ fixtures

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INPUTS_DIR = join(PROJECT_ROOT, "fixtures", "commander-native-tool-benchmark", "inputs");
const FIXTURE_CWD = join(INPUTS_DIR, "fixture");
const CONTROL_EXTENSION_REL = join("scripts", "commander-native-tool-final-control-extension.ts");
const TREATMENT_RUNTIME_REL = join("extensions", "workbench-runtime", "index.ts");
const PI_BIN_REL = join("node_modules", ".bin", "pi");

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
	/** true = omit the user message entirely (attempt-style broken session). */
	noUser?: boolean;
}

/** A valid Pi-like session (pinned model/thinking, exact prompt, terminal stop). */
function validSessionEntries(promptText: string, overrides: ValidSessionOverrides = {}): unknown[] {
	return [
		{ type: "session", version: 3, id: "s-1", timestamp: "2026-09-01T10:00:00.000Z" },
		{ type: "session_info", id: "i-1", parentId: null, timestamp: "2026-09-01T10:00:00.000Z", name: "nro-final-test" },
		{ type: "model_change", id: "m-1", parentId: "i-1", timestamp: "2026-09-01T10:00:00.000Z", provider: "openai-codex", modelId: "gpt-5.6-sol" },
		...(overrides.thinking === null ? [] : [thinkingChange(overrides.thinking ?? "high")]),
		...(overrides.noUser ? [] : [userEntry(overrides.prompt ?? promptText)]),
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

// ------------------------------------------------------- temp project root

/**
 * Build a hermetic project root satisfying every FINAL preflight
 * requirement: the non-treatment bundle (AGENTS.md + skills/ + prompts/
 * + templates/), package.json with the exact Pi devDependency pin, the
 * regular pi binary, and the two FINAL arm files. Returns a protocol
 * whose non_treatment_sha256 pin is the hash of THIS bundle (so the
 * real deterministic bundle hash is exercised end-to-end).
 */
async function makeProjectRoot(root: string): Promise<FrozenProtocol> {
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "AGENTS.md"), "root agent guidance\n", "utf8");
	await mkdir(join(root, "skills", "sub"), { recursive: true });
	await writeFile(join(root, "skills", "a.md"), "skill a\n", "utf8");
	await writeFile(join(root, "skills", "sub", "b.md"), "skill b\n", "utf8");
	await mkdir(join(root, "prompts"), { recursive: true });
	await writeFile(join(root, "prompts", "c.md"), "prompt c\n", "utf8");
	await mkdir(join(root, "templates"), { recursive: true });
	await writeFile(join(root, "templates", "d.md"), "template d\n", "utf8");
	await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
	await writeFile(join(root, PI_BIN_REL), "#!/usr/bin/env node\n", "utf8");
	await mkdir(join(root, "scripts"), { recursive: true });
	await writeFile(join(root, CONTROL_EXTENSION_REL), "export default async function () {}\n", "utf8");
	await mkdir(join(root, "extensions", "workbench-runtime"), { recursive: true });
	await writeFile(join(root, TREATMENT_RUNTIME_REL), "export default async function () {}\n", "utf8");
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ name: "test-root", devDependencies: { "@earendil-works/pi-coding-agent": "0.83.0" } }, null, 2),
		"utf8",
	);
	const bundle = await nonTreatmentBundleHash(root);
	return { ...FROZEN_NRO_PROTOCOL, nonTreatmentSha256: bundle.sha256 };
}

// ------------------------------------------------------------------ fake runner

interface FakeBehavior {
	exitCode?: number | null;
	timedOut?: boolean;
	spawnError?: string | null;
	sessionFiles?: Array<{ name: string; bytes: Buffer }>;
	/** Directories to create instead of files (non-regular session output). */
	sessionDirs?: string[];
	/** Symlinks to create in the session dir (non-regular session output). */
	sessionSymlinks?: Array<{ name: string; target: string }>;
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
		for (const dir of behavior.sessionDirs ?? []) {
			await mkdir(join(sessionDir, dir));
		}
		for (const link of behavior.sessionSymlinks ?? []) {
			await symlink(link.target, join(sessionDir, link.name));
		}
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

function collectOptions(root: string, overrides: Partial<CollectFinalOptions> = {}): CollectFinalOptions {
	return {
		paths: { projectRoot: root, inputsDir: INPUTS_DIR, runsDir: join(root, ".pi", "workbench", "runs") },
		runtimeFacts: { processVersion: "v26.4.0" },
		...overrides,
	};
}

function outputRootOf(root: string): string {
	return join(root, ".pi", "workbench", "runs", OUTPUT_ROOT_NAME);
}

/** The FINAL control-extension path the collector builds for a temp project root. */
function controlExtensionOf(root: string): string {
	return join(root, CONTROL_EXTENSION_REL);
}

/** Arms derived from the extension path each attempt actually received. */
function armsOf(calls: readonly AttemptRunRequest[], root: string): string[] {
	return calls.map((call) => (call.argv[4] === controlExtensionOf(root) ? "control" : "treatment"));
}

function captureIo(): { io: FinalIo; stdout: string[]; stderr: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return { io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, stdout, stderr };
}

async function expectMissing(path: string): Promise<void> {
	await assert.rejects(stat(path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
}

// ------------------------------------------------------------------ fixed plan and builders

test("fixed plan is the frozen ABBA sequence from abbaArmAt(1..40)", () => {
	const plan = fixedPlan();
	assert.equal(plan.length, FINAL_VALID_SESSIONS);
	const expected = Array.from({ length: 40 }, (_v, i) => abbaArmAt(i + 1));
	assert.deepEqual([...plan], expected);
	// ABBA repeated ten times
	assert.deepEqual([...plan].slice(0, 4), ["control", "treatment", "treatment", "control"]);
	assert.deepEqual([...plan].slice(36), ["control", "treatment", "treatment", "control"]);
	const controlCount = plan.filter((arm) => arm === "control").length;
	const treatmentCount = plan.filter((arm) => arm === "treatment").length;
	assert.equal(controlCount, 20);
	assert.equal(treatmentCount, 20);
});

test("attempt identity helpers are deterministic and zero-padded", () => {
	assert.equal(attemptLabel(1), "01");
	assert.equal(attemptLabel(60), "60");
	assert.equal(attemptName(3, "treatment"), "nro-final-03-treatment");
	assert.equal(attemptName(40, "control"), "nro-final-40-control");
	assert.equal(rawSourceName(12, "control"), "raw-12-control.jsonl");
	assert.equal(attemptSessionDirName(7), ".attempt-07-session");
});

test("buildAttemptArgv is exact: flag order, pins, fresh session dir, prompt as sole positional", async () => {
	const promptText = await frozenPromptText();
	const root = "/tmp/final/.attempt-01-session";
	const argv = buildAttemptArgv({
		extensionPath: controlExtensionOf("/tmp/final"),
		sessionDir: root,
		attemptNumber: 1,
		arm: "control",
		promptText,
	});
	assert.deepEqual(argv, [
		"--print",
		"--approve",
		"--no-extensions",
		"--extension",
		controlExtensionOf("/tmp/final"),
		"--model",
		"openai-codex/gpt-5.6-sol",
		"--thinking",
		"high",
		"--session-dir",
		root,
		"--name",
		"nro-final-01-control",
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

test("buildAttemptEnv inherits the base env (credentials) and pins the collector overrides", () => {
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

// ------------------------------------------------------------------ non-treatment bundle hash

test("nonTreatmentBundleHash is deterministic, sorted, and covers the four frozen roots", async () => {
	await withTempDir(async (root) => {
		await makeProjectRoot(root);
		const first = await nonTreatmentBundleHash(root);
		const second = await nonTreatmentBundleHash(root);
		assert.equal(first.sha256, second.sha256);
		assert.deepEqual(first.files, [
			"AGENTS.md",
			"prompts/c.md",
			"skills/a.md",
			"skills/sub/b.md",
			"templates/d.md",
		]);
		// the hash is SHA-256 over the sorted "<rel>:<sha>\n" concatenation
		const rows = first.files.map((rel) => `${rel}:${sha256Hex(rel === "AGENTS.md" ? "root agent guidance\n" : rel.endsWith("b.md") ? "skill b\n" : rel.endsWith("c.md") ? "prompt c\n" : rel.endsWith("d.md") ? "template d\n" : "skill a\n")}\n`);
		assert.equal(first.sha256, sha256Hex(rows.join("")));
		assert.equal(first.totalBytes, Buffer.byteLength("root agent guidance\nskill a\nskill b\nprompt c\ntemplate d\n", "utf8"));
	});
});

test("nonTreatmentBundleHash fails closed on symlinks and non-regular entries", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "AGENTS.md"), "root\n", "utf8");
		await mkdir(join(root, "skills"), { recursive: true });
		await writeFile(join(root, "skills", "a.md"), "a\n", "utf8");
		await mkdir(join(root, "prompts"));
		await mkdir(join(root, "templates"));
		await symlink(join(root, "skills", "a.md"), join(root, "skills", "link.md"));
		await assert.rejects(nonTreatmentBundleHash(root), (error: unknown) => error instanceof FinalCollectError && error.code === "BUNDLE_UNSAFE");
	});
});

test("a symlinked or non-regular root AGENTS.md fails the bundle hash closed (never followed)", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		// root AGENTS.md replaced by a symlink to a regular file: no-follow
		// lstat semantics must reject it instead of hashing the target
		await rm(join(root, "AGENTS.md"));
		await symlink(join(root, "skills", "a.md"), join(root, "AGENTS.md"));
		await assert.rejects(nonTreatmentBundleHash(root), (error: unknown) => error instanceof FinalCollectError && error.code === "BUNDLE_UNSAFE");
		// the collector preflight fails closed on it too, before any output
		const { runner, calls } = makeFakeRunner(alwaysValid());
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "BUNDLE_UNSAFE",
		);
		await expectMissing(outputRootOf(root));
		assert.equal(calls.length, 0);
	});
	await withTempDir(async (root) => {
		// non-regular root AGENTS.md (a directory) is rejected the same way
		await makeProjectRoot(root);
		await rm(join(root, "AGENTS.md"));
		await mkdir(join(root, "AGENTS.md"));
		await assert.rejects(nonTreatmentBundleHash(root), (error: unknown) => error instanceof FinalCollectError && error.code === "BUNDLE_UNSAFE");
	});
});

test("a symlinked root bundle directory fails the hash closed (no-follow) and the preflight with no output or call", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		// root `skills` becomes a symlink to the `templates` directory: a
		// follow-based walk would silently hash the TARGET's contents under
		// the bundle root's name — no-follow lstat must reject the root
		// entry itself instead of following it
		await rm(join(root, "skills"), { recursive: true });
		await symlink(join(root, "templates"), join(root, "skills"));
		await assert.rejects(
			nonTreatmentBundleHash(root),
			(error: unknown) => error instanceof FinalCollectError && error.code === "BUNDLE_UNSAFE",
		);
		// the collector preflight fails closed on it too, before any output or call
		const { runner, calls } = makeFakeRunner(alwaysValid());
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "BUNDLE_UNSAFE",
		);
		await expectMissing(outputRootOf(root));
		assert.equal(calls.length, 0);
	});
	await withTempDir(async (root) => {
		// `prompts` and `templates` are checked with the same no-follow
		// semantics (symlink to a real directory)
		await makeProjectRoot(root);
		for (const dir of ["prompts", "templates"] as const) {
			await rm(join(root, dir), { recursive: true });
			await symlink(join(root, "skills"), join(root, dir));
			await assert.rejects(
				nonTreatmentBundleHash(root),
				(error: unknown) => error instanceof FinalCollectError && error.code === "BUNDLE_UNSAFE",
				`root ${dir} symlink must fail closed`,
			);
			// restore a real directory for the next iteration
			await rm(join(root, dir));
			await mkdir(join(root, dir));
		}
	});
});

// ------------------------------------------------------------------ classifier

test("classifyFinalSession: a valid session passes every check", async () => {
	const raw = await validRaw();
	const verdict = classifyFinalSession({ exitCode: 0, timedOut: false, raw, arm: "control", label: "01", protocol: FROZEN_NRO_PROTOCOL });
	assert.deepEqual(verdict, { valid: true, unrepresentable: false, reason: null, detail: null });
});

test("classifyFinalSession: the six frozen attempt categories become invalid attempts", async () => {
	const promptText = await frozenPromptText();
	const cases: Array<{ name: string; raw: Buffer; reason: string }> = [
		{ name: "prompt_mismatch", raw: sessionBytes(promptText, { prompt: "a completely different prompt" }), reason: "prompt_mismatch" },
		{ name: "env_drift-model", raw: sessionBytes(promptText, { provider: "other-provider", model: "other-model" }), reason: "env_drift" },
		{ name: "env_drift-thinking", raw: sessionBytes(promptText, { thinking: "low" }), reason: "env_drift" },
		{ name: "compaction_present", raw: sessionBytes(promptText, { compaction: true }), reason: "compaction_present" },
		{ name: "aborted", raw: sessionBytes(promptText, { stopReason: "aborted" }), reason: "aborted" },
		{ name: "errored", raw: sessionBytes(promptText, { stopReason: "error" }), reason: "errored" },
		{ name: "nonterminal", raw: sessionBytes(promptText, { stopReason: "length" }), reason: "nonterminal" },
	];
	for (const c of cases) {
		const verdict = classifyFinalSession({ exitCode: 0, timedOut: false, raw: c.raw, arm: "treatment", label: "03", protocol: FROZEN_NRO_PROTOCOL });
		assert.equal(verdict.valid, false, c.name);
		assert.equal(verdict.unrepresentable, false, c.name);
		assert.equal(verdict.reason, c.reason, c.name);
		assert.ok(verdict.detail !== null && verdict.detail.length > 0, c.name);
	}
});

test("classifyFinalSession: an empty raw is a representable nonterminal attempt (analyzer leniency)", async () => {
	const verdict = classifyFinalSession({ exitCode: 0, timedOut: false, raw: Buffer.alloc(0), arm: "control", label: "05", protocol: FROZEN_NRO_PROTOCOL });
	assert.equal(verdict.valid, false);
	assert.equal(verdict.unrepresentable, false);
	assert.equal(verdict.reason, "nonterminal");
});

test("classifyFinalSession: malformed and unclassified-but-final-invalid raws are unrepresentable", async () => {
	const promptText = await frozenPromptText();
	const cases: Array<{ name: string; raw: Buffer; exitCode: number | null; timedOut: boolean }> = [
		{ name: "malformed-json", raw: Buffer.from("not json at all\n", "utf8"), exitCode: 0, timedOut: false },
		{ name: "malformed-message", raw: Buffer.from(JSON.stringify({ type: "message", id: "u", timestamp: "2026-09-01T10:00:00.000Z" }) + "\n", "utf8"), exitCode: 0, timedOut: false },
		{ name: "unclassified-missing-thinking", raw: sessionBytes(promptText, { thinking: null }), exitCode: 0, timedOut: false },
		{ name: "unclassified-missing-prompt", raw: sessionBytes(promptText, { noUser: true }), exitCode: 0, timedOut: false },
		{ name: "malformed-despite-exit-7", raw: Buffer.from("garbage\n", "utf8"), exitCode: 7, timedOut: false },
		{ name: "malformed-despite-timeout", raw: Buffer.from("garbage\n", "utf8"), exitCode: 0, timedOut: true },
	];
	for (const c of cases) {
		const verdict = classifyFinalSession({ exitCode: c.exitCode, timedOut: c.timedOut, raw: c.raw, arm: "control", label: "01", protocol: FROZEN_NRO_PROTOCOL });
		assert.equal(verdict.valid, false, c.name);
		assert.equal(verdict.unrepresentable, true, c.name);
		assert.equal(verdict.reason, null, c.name);
		assert.ok(verdict.detail !== null && verdict.detail.length > 0, c.name);
	}
});

test("classifyFinalSession: exit code and timeout are diagnostic only — machine-valid raw stays valid", async () => {
	const raw = await validRaw();
	for (const exitCode of [0, 3, 7, null]) {
		const verdict = classifyFinalSession({ exitCode, timedOut: false, raw, arm: "control", label: "01", protocol: FROZEN_NRO_PROTOCOL });
		assert.deepEqual(verdict, { valid: true, unrepresentable: false, reason: null, detail: null }, `exit ${String(exitCode)}`);
	}
	const timedOut = classifyFinalSession({ exitCode: 0, timedOut: true, raw, arm: "control", label: "01", protocol: FROZEN_NRO_PROTOCOL });
	assert.deepEqual(timedOut, { valid: true, unrepresentable: false, reason: null, detail: null });
});

// ------------------------------------------------------------------ collection

test("fixed-order collection: 40 valid sessions in frozen ABBA order, complete", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const produced: Buffer[] = [];
		const { runner, calls } = makeFakeRunner(async () => {
			const bytes = await validRaw();
			produced.push(bytes);
			return { sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const diagnostics: string[] = [];
		const result = await collectFinal(collectOptions(root, { protocol, runner, onDiagnostic: (line) => diagnostics.push(line) }));

		assert.equal(result.status, "complete");
		assert.equal(result.validSessions, FINAL_VALID_SESSIONS);
		assert.equal(result.attempts, FINAL_VALID_SESSIONS);
		assert.deepEqual(diagnostics, []);

		// frozen ABBA arm order across the attempts
		const arms = armsOf(calls, root);
		assert.deepEqual(arms, Array.from({ length: 40 }, (_v, i) => abbaArmAt(i + 1)));
		const names = calls.map((call) => call.argv[call.argv.indexOf("--name") + 1]);
		assert.equal(names[0], "nro-final-01-control");
		assert.equal(names[1], "nro-final-02-treatment");
		assert.equal(names[39], "nro-final-40-control");
		assert.equal(new Set(names).size, 40);

		// deterministic retained source names
		const sources = (await readdir(join(outputRootOf(root), SOURCES_DIR_NAME))).sort();
		assert.deepEqual(sources, Array.from({ length: 40 }, (_v, i) => `raw-${attemptLabel(i + 1)}-${abbaArmAt(i + 1)}.jsonl`));

		// strict record: 40 session entries in chronological order, no attempts
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

test("an invalid attempt retries the same required arm, then success completes at 41 attempts", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const diagnostics: string[] = [];
		const { runner, calls } = makeFakeRunner(async (_request, index) => {
			const bytes = await validRaw();
			if (index === 0) {
				return { exitCode: 0, sessionFiles: [{ name: "session.jsonl", bytes: sessionBytes(await frozenPromptText(), { stopReason: "aborted" }) }] };
			}
			return { sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const result = await collectFinal(collectOptions(root, { protocol, runner, onDiagnostic: (line) => diagnostics.push(line) }));

		assert.equal(result.status, "complete");
		assert.equal(result.validSessions, FINAL_VALID_SESSIONS);
		assert.equal(result.attempts, 41);

		// attempt 1 invalid -> attempt 2 retries the SAME required arm (control)
		const arms = armsOf(calls, root);
		assert.deepEqual(arms.slice(0, 2), ["control", "control"]);
		// after the retry, valid sessions occupy plan positions 1..40: attempts 3..41
		assert.deepEqual(arms.slice(2), Array.from({ length: 39 }, (_v, i) => abbaArmAt(i + 2)));

		// retained: 1 attempt + 40 sessions, chronological, truthful
		assert.equal(result.record.entries.length, 41);
		assert.equal(result.record.entries[0]?.kind, "attempt");
		assert.equal(result.record.entries[0]?.arm, "control");
		assert.equal(result.record.entries[0]?.path, "sources/raw-01-control.jsonl");
		assert.ok(result.record.entries.slice(1).every((entry) => entry.kind === "session"));
		const sources = (await readdir(join(outputRootOf(root), SOURCES_DIR_NAME))).sort();
		assert.equal(sources.length, 41);

		// bounded diagnostic on stderr: reason, no content/paths
		assert.equal(diagnostics.length, 1);
		const line = diagnostics[0] as string;
		assert.ok(line.startsWith("commander-native-tool-final-collect: attempt 01 (control) invalid: aborted"));
		assert.ok(!line.includes(root));
		assert.ok(!line.includes("milestone"));
	});
});

test("the 60-attempt cap yields a truthful partial collection and exits 1", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const diagnostics: string[] = [];
		const { runner, calls } = makeFakeRunner(async () => {
			// content-classified INVALID raw (nonterminal) — exit 3 is diagnostic only
			const bytes = sessionBytes(await frozenPromptText(), { stopReason: "length" });
			return { exitCode: 3, sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const result = await collectFinal(collectOptions(root, { protocol, runner, onDiagnostic: (line) => diagnostics.push(line) }));

		assert.equal(result.status, "attempts-exhausted");
		assert.equal(result.validSessions, 0);
		assert.equal(result.attempts, FINAL_MAX_ATTEMPTS);
		assert.equal(calls.length, FINAL_MAX_ATTEMPTS);

		// position never advanced: every attempt retried the same required arm
		const arms = new Set(armsOf(calls, root));
		assert.deepEqual([...arms], ["control"]);

		// 60 retained attempt sources + 60 chronological attempt entries
		const sources = (await readdir(join(outputRootOf(root), SOURCES_DIR_NAME))).sort();
		assert.deepEqual(sources, Array.from({ length: 60 }, (_v, i) => `raw-${attemptLabel(i + 1)}-control.jsonl`));
		assert.equal(result.record.entries.length, 60);
		assert.ok(result.record.entries.every((entry) => entry.kind === "attempt" && entry.arm === "control"));
		assert.equal(diagnostics.length, 60);

		// exit 3 is diagnostic only — the content (valid raw) still decides; here
		// the content is a plain invalid attempt per the category, and the exit
		// note is carried on the diagnostic line
		const line = diagnostics[0] as string;
		assert.ok(line.includes("invalid: nonterminal"));
		assert.ok(line.includes("(exit 3)"));

		// CLI plumbing: exhausted => exit 1 with the bounded summary on stdout
		const { io, stdout, stderr } = captureIo();
		const code = await main([], io, async () => result);
		assert.equal(code, 1);
		assert.deepEqual(stdout, [renderSummary(result)]);
		assert.deepEqual(stderr, []);
		assert.ok(!stdout.join("\n").includes(root), "summary must not carry absolute paths");
	});
});

test("a timed-out attempt with machine-valid content is still a session (diagnostic only)", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const diagnostics: string[] = [];
		const { runner } = makeFakeRunner(async (_request, index) => {
			const bytes = await validRaw();
			if (index === 0) return { exitCode: 0, timedOut: true, sessionFiles: [{ name: "session.jsonl", bytes }] };
			return { sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const result = await collectFinal(collectOptions(root, { protocol, runner, onDiagnostic: (line) => diagnostics.push(line) }));
		assert.equal(result.status, "complete");
		assert.equal(result.attempts, 40);
		// the timed-out raw is machine-valid: retained as a SESSION, advancing ABBA
		assert.equal(result.record.entries[0]?.kind, "session");
		assert.equal(result.record.entries[0]?.arm, "control");
		assert.equal(result.record.entries[0]?.path, "sources/raw-01-control.jsonl");
		assert.equal(diagnostics.length, 1);
		assert.ok((diagnostics[0] as string).includes("session valid despite timed out (diagnostic only)"));
	});
});

test("a non-zero exit with machine-valid content is still a session (diagnostic only)", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const diagnostics: string[] = [];
		const { runner } = makeFakeRunner(async (_request, index) => {
			const bytes = await validRaw();
			if (index === 0) return { exitCode: 9, sessionFiles: [{ name: "session.jsonl", bytes }] };
			return { sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const result = await collectFinal(collectOptions(root, { protocol, runner, onDiagnostic: (line) => diagnostics.push(line) }));
		assert.equal(result.status, "complete");
		assert.equal(result.attempts, 40);
		assert.equal(result.record.entries[0]?.kind, "session");
		assert.ok((diagnostics[0] as string).includes("session valid despite exit 9 (diagnostic only)"));
	});
});

test("spawn failure hard-fails, is never counted, and preserves the initial empty record + attempt dir", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const { runner, calls } = makeFakeRunner(() => ({ spawnError: "ENOENT" }));
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "SPAWN_FAILED",
		);
		assert.equal(calls.length, 1);
		// the initial EMPTY strict record was written before the call
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.equal(record.entries.length, 0);
		assert.equal(record.phase, FINAL_PHASE);
		assert.equal(record.nonTreatmentSha256, protocol.nonTreatmentSha256);
		// nothing retained, attempt dir preserved
		assert.deepEqual(await readdir(join(outputRootOf(root), SOURCES_DIR_NAME)), []);
		assert.deepEqual(await readdir(join(outputRootOf(root), ".attempt-01-session")), []);
	});
});

test("existing output root fails closed and is never touched", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const outputRoot = outputRootOf(root);
		await mkdir(outputRoot, { recursive: true });
		await writeFile(join(outputRoot, "junk.txt"), "pre-existing");
		const { runner, calls } = makeFakeRunner(alwaysValid());
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "EXISTING_OUTPUT",
		);
		assert.equal(calls.length, 0);
		assert.equal(await readFile(join(outputRoot, "junk.txt"), "utf8"), "pre-existing");
		await expectMissing(join(outputRoot, COLLECTION_RECORD_NAME));

		// CLI: runtime failure => exit 1, stderr only
		const { io, stdout, stderr } = captureIo();
		const code = await main([], io, async () => {
			throw new FinalCollectError("EXISTING_OUTPUT", `output root ${OUTPUT_ROOT_NAME} already exists — refusing to overwrite`);
		});
		assert.equal(code, 1);
		assert.deepEqual(stdout, []);
		assert.equal(stderr.length, 1);
		assert.ok((stderr[0] as string).includes("EXISTING_OUTPUT"));
	});
});

test("preflight enforces bundle/Node/Pi-pin/required-file pins before any output or call", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const { runner, calls } = makeFakeRunner(alwaysValid());

		// bundle drift => NON_TREATMENT_MISMATCH (one bundle byte modified)
		const driftedRoot = join(root, "drifted-bundle");
		await mkdir(driftedRoot, { recursive: true });
		await writeFile(join(driftedRoot, "AGENTS.md"), "root agent guidance\nx", "utf8");
		await mkdir(join(driftedRoot, "skills"));
		await mkdir(join(driftedRoot, "prompts"));
		await mkdir(join(driftedRoot, "templates"));
		await assert.rejects(
			collectFinal(collectOptions(driftedRoot, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "NON_TREATMENT_MISMATCH",
		);
		await expectMissing(outputRootOf(driftedRoot));
		assert.equal(calls.length, 0);

		// Node pin drift => NODE_MISMATCH
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol, runner, runtimeFacts: { processVersion: "v24.0.0" } })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "NODE_MISMATCH",
		);
		await expectMissing(outputRootOf(root));

		// package Pi pin drift => PI_PIN_MISMATCH
		const wrongPinRoot = join(root, "wrong-pi-pin");
		await makeProjectRoot(wrongPinRoot);
		await writeFile(join(wrongPinRoot, "package.json"), JSON.stringify({ devDependencies: { "@earendil-works/pi-coding-agent": "0.82.0" } }), "utf8");
		await assert.rejects(
			collectFinal(collectOptions(wrongPinRoot, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "PI_PIN_MISMATCH",
		);
		await expectMissing(outputRootOf(wrongPinRoot));

		// missing pi binary => FILE_MISSING
		const noPiRoot = join(root, "no-pi-binary");
		await makeProjectRoot(noPiRoot);
		await rm(join(noPiRoot, PI_BIN_REL));
		await assert.rejects(
			collectFinal(collectOptions(noPiRoot, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "FILE_MISSING",
		);
		await expectMissing(outputRootOf(noPiRoot));

		// non-regular pi binary (directory) => FILE_MISSING
		const dirPiRoot = join(root, "dir-pi-binary");
		await makeProjectRoot(dirPiRoot);
		await rm(join(dirPiRoot, PI_BIN_REL));
		await mkdir(join(dirPiRoot, PI_BIN_REL), { recursive: true });
		await assert.rejects(
			collectFinal(collectOptions(dirPiRoot, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "FILE_MISSING",
		);

		// missing FINAL control extension => FILE_MISSING (never the DEV approximation)
		const noControlRoot = join(root, "no-control");
		await makeProjectRoot(noControlRoot);
		await rm(join(noControlRoot, CONTROL_EXTENSION_REL));
		await assert.rejects(
			collectFinal(collectOptions(noControlRoot, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "FILE_MISSING",
		);

		// unfrozen protocol pin => PROTOCOL_NOT_FROZEN (NroError, before anything)
		const unfrozen: FrozenProtocol = { ...protocol, milestonePromptSha256: null };
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol: unfrozen, runner })),
			(error: unknown) => error instanceof NroError && error.code === "PROTOCOL_NOT_FROZEN",
		);
		await expectMissing(outputRootOf(root));
		assert.equal(calls.length, 0);
	});
});

test("preflight rejects a symlinked FINAL arm file (no-follow) before any output or call", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		// the FINAL control adapter replaced by a symlink to a regular file:
		// the arm file check is no-follow — the link itself is rejected
		await rm(join(root, CONTROL_EXTENSION_REL));
		await symlink(join(root, TREATMENT_RUNTIME_REL), join(root, CONTROL_EXTENSION_REL));
		const { runner, calls } = makeFakeRunner(alwaysValid());
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "FILE_MISSING",
		);
		await expectMissing(outputRootOf(root));
		assert.equal(calls.length, 0);
	});
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		// the treatment runtime replaced by a symlink to a regular file
		await rm(join(root, TREATMENT_RUNTIME_REL));
		await symlink(join(root, CONTROL_EXTENSION_REL), join(root, TREATMENT_RUNTIME_REL));
		const { runner, calls } = makeFakeRunner(alwaysValid());
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "FILE_MISSING",
		);
		await expectMissing(outputRootOf(root));
		assert.equal(calls.length, 0);
	});
});

test("preflight accepts an npm-style symlinked pi binary that resolves to a regular file", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		// npm's node_modules/.bin entries are symlinks to the package bin:
		// the pi binary check is allow-follow and must accept the link
		await rm(join(root, PI_BIN_REL));
		const piTarget = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "bin", "pi.js");
		await mkdir(dirname(piTarget), { recursive: true });
		await writeFile(piTarget, "#!/usr/bin/env node\n", "utf8");
		await symlink(piTarget, join(root, PI_BIN_REL));
		assert.equal((await lstat(join(root, PI_BIN_REL))).isSymbolicLink(), true, "fixture must be a real symlink");
		const { runner, calls } = makeFakeRunner(alwaysValid());
		const result = await collectFinal(collectOptions(root, { protocol, runner }));
		assert.equal(result.status, "complete");
		assert.equal(result.attempts, FINAL_VALID_SESSIONS);
		// every attempt requests the symlinked .bin path itself
		for (const call of calls) {
			assert.equal(call.program, join(root, PI_BIN_REL));
		}
	});
});

test("zero produced session files fail closed preserving the truthful record and attempt dir", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const { runner } = makeFakeRunner(async (_request, index) => {
			if (index === 0) {
				// attempt 1 produces a valid raw (retained)
				return { sessionFiles: [{ name: "session.jsonl", bytes: await validRaw() }] };
			}
			// attempt 2 produces NOTHING
			return { sessionFiles: [] };
		});
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "SESSION_FILE_COUNT",
		);
		// partial collection stays truthful: only attempt 1 is recorded
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.equal(record.entries.length, 1);
		assert.deepEqual(record.entries[0], { kind: "session", arm: "control", path: "sources/raw-01-control.jsonl" });
		const sources = await readdir(join(outputRootOf(root), SOURCES_DIR_NAME));
		assert.deepEqual(sources, ["raw-01-control.jsonl"]);
		// the attempt dir of the failed attempt is preserved (never deleted)
		assert.deepEqual(await readdir(join(outputRootOf(root), ".attempt-02-session")), []);
	});
});

test("multiple produced session files fail closed with nothing fabricated", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const bytes = await validRaw();
		const { runner } = makeFakeRunner(() => ({
			sessionFiles: [
				{ name: "session.jsonl", bytes },
				{ name: "duplicate.jsonl", bytes },
			],
		}));
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "SESSION_FILE_COUNT",
		);
		// initial empty record, no retained sources, no fabricated evidence
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.equal(record.entries.length, 0);
		assert.deepEqual(await readdir(join(outputRootOf(root), SOURCES_DIR_NAME)), []);
		assert.deepEqual((await readdir(join(outputRootOf(root), ".attempt-01-session"))).sort(), ["duplicate.jsonl", "session.jsonl"]);
	});
});

test("an oversized single session file fails closed with nothing fabricated", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const { runner } = makeFakeRunner(() => ({
			sessionFiles: [{ name: "session.jsonl", bytes: Buffer.alloc(SESSION_MAX_BYTES + 1, 0x61) }],
		}));
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "SESSION_FILE_COUNT",
		);
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.equal(record.entries.length, 0);
		assert.deepEqual(await readdir(join(outputRootOf(root), SOURCES_DIR_NAME)), []);
	});
});

test("a non-regular session output (directory named *.jsonl) fails closed", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const { runner } = makeFakeRunner(() => ({ sessionDirs: ["session.jsonl"] }));
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "SESSION_FILE_COUNT",
		);
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.equal(record.entries.length, 0);
		assert.deepEqual(await readdir(join(outputRootOf(root), SOURCES_DIR_NAME)), []);
	});
});

test("a valid regular .jsonl plus any second direct .jsonl entry (symlink, dir, oversized) fails closed", async () => {
	const bytes = await validRaw();
	const scenarios: Array<{
		name: string;
		sessionFiles: Array<{ name: string; bytes: Buffer }>;
		sessionDirs?: string[];
		sessionSymlinks?: Array<{ name: string; target: string }>;
	}> = [
		{
			name: "symlink",
			sessionFiles: [{ name: "session.jsonl", bytes }],
			sessionSymlinks: [{ name: "extra.jsonl", target: join(PROJECT_ROOT, "AGENTS.md") }],
		},
		{
			name: "directory",
			sessionFiles: [{ name: "session.jsonl", bytes }],
			sessionDirs: ["extra.jsonl"],
		},
		{
			name: "oversized",
			sessionFiles: [
				{ name: "session.jsonl", bytes },
				{ name: "extra.jsonl", bytes: Buffer.alloc(SESSION_MAX_BYTES + 1, 0x61) },
			],
		},
	];
	for (const scenario of scenarios) {
		await withTempDir(async (root) => {
			const protocol = await makeProjectRoot(root);
			const { runner } = makeFakeRunner(() => ({
				sessionFiles: scenario.sessionFiles,
				sessionDirs: scenario.sessionDirs,
				sessionSymlinks: scenario.sessionSymlinks,
			}));
			await assert.rejects(
				collectFinal(collectOptions(root, { protocol, runner })),
				(error: unknown) => error instanceof FinalCollectError && error.code === "SESSION_FILE_COUNT",
			);
			// nothing recorded, nothing retained, no fabricated evidence — the
			// invalid extra .jsonl is NEVER silently ignored
			const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
			assert.equal(record.entries.length, 0, scenario.name);
			assert.deepEqual(await readdir(join(outputRootOf(root), SOURCES_DIR_NAME)), [], scenario.name);
			// the attempt dir is preserved with BOTH entries
			assert.deepEqual((await readdir(join(outputRootOf(root), ".attempt-01-session"))).sort(), ["extra.jsonl", "session.jsonl"], scenario.name);
		});
	}
});

test("injected record-commit failure on the first attempt rolls back: empty record, no destination, raw in attempt dir", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const { runner } = makeFakeRunner(alwaysValid());
		let hookCalls = 0;
		await assert.rejects(
			collectFinal(
				collectOptions(root, {
					protocol,
					runner,
					beforeRecordCommit: async () => {
						hookCalls += 1;
						throw new FinalCollectError("RECORD_IO", "injected per-attempt record commit failure");
					},
				}),
			),
			(error: unknown) => error instanceof FinalCollectError && error.code === "RECORD_IO",
		);
		assert.equal(hookCalls, 1);
		// the initial EMPTY record was committed before any attempt and is unchanged
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.equal(record.entries.length, 0);
		assert.equal(record.phase, FINAL_PHASE);
		assert.equal(record.nonTreatmentSha256, protocol.nonTreatmentSha256);
		// the destination created for the failed commit was removed again
		assert.deepEqual(await readdir(join(outputRootOf(root), SOURCES_DIR_NAME)), []);
		// the original raw still lives in its preserved attempt dir
		assert.deepEqual(await readdir(join(outputRootOf(root), ".attempt-01-session")), ["session.jsonl"]);
	});
});

test("injected record-commit failure after a prior attempt keeps the prior record truthful and the failed raw in its attempt dir", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const { runner } = makeFakeRunner(alwaysValid());
		let hookCalls = 0;
		await assert.rejects(
			collectFinal(
				collectOptions(root, {
					protocol,
					runner,
					beforeRecordCommit: async () => {
						hookCalls += 1;
						if (hookCalls === 2) throw new FinalCollectError("RECORD_IO", "injected per-attempt record commit failure");
					},
				}),
			),
			(error: unknown) => error instanceof FinalCollectError && error.code === "RECORD_IO",
		);
		assert.equal(hookCalls, 2);
		// the persisted record still holds ONLY attempt 1 — no phantom entry
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.deepEqual(record.entries, [{ kind: "session", arm: "control", path: "sources/raw-01-control.jsonl" }]);
		// attempt 1's retained source stays; the failed attempt's destination was removed
		assert.deepEqual(await readdir(join(outputRootOf(root), SOURCES_DIR_NAME)), ["raw-01-control.jsonl"]);
		// attempt 2's original raw is still in its preserved attempt dir
		assert.deepEqual(await readdir(join(outputRootOf(root), ".attempt-02-session")), ["session.jsonl"]);
		// attempt 1's dir was cleaned up normally on the committed path
		await expectMissing(join(outputRootOf(root), ".attempt-01-session"));
	});
});

test("post-rename record read-back failure hard-fails: committed entry and byte-exact source kept, attempt-dir original retained", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const produced: Buffer[] = [];
		const { runner } = makeFakeRunner(async () => {
			const bytes = await validRaw();
			produced.push(bytes);
			return { sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		let hookCalls = 0;
		await assert.rejects(
			collectFinal(
				collectOptions(root, {
					protocol,
					runner,
					afterRecordRename: async () => {
						hookCalls += 1;
						throw new FinalCollectError("RECORD_IO", "injected post-rename record read-back failure");
					},
				}),
			),
			(error: unknown) => error instanceof FinalCollectError && error.code === "RECORD_IO",
		);
		assert.equal(hookCalls, 1);
		// the rename had already committed attempt 1's entry BEFORE the
		// read-back failure: the persisted record holds it — the caller
		// never rolls back a committed update (a committed record must
		// never reference a removed source)
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.deepEqual(record.entries, [{ kind: "session", arm: "control", path: "sources/raw-01-control.jsonl" }]);
		// the retained destination source is byte-exact
		const retained = await readFile(join(outputRootOf(root), SOURCES_DIR_NAME, "raw-01-control.jsonl"));
		assert.ok(retained.equals(produced[0] as Buffer), "retained source must be byte-identical to the produced raw");
		// the attempt-dir original is retained because cleanup was not reached
		assert.deepEqual(await readdir(join(outputRootOf(root), ".attempt-01-session")), ["session.jsonl"]);
	});
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const { runner } = makeFakeRunner(alwaysValid());
		let hookCalls = 0;
		await assert.rejects(
			collectFinal(
				collectOptions(root, {
					protocol,
					runner,
					afterRecordRename: async () => {
						hookCalls += 1;
						if (hookCalls === 2) throw new FinalCollectError("RECORD_IO", "injected post-rename record read-back failure");
					},
				}),
			),
			(error: unknown) => error instanceof FinalCollectError && error.code === "RECORD_IO",
		);
		assert.equal(hookCalls, 2);
		// attempt 1 committed normally (its dir was cleaned up); attempt 2's
		// rename committed its entry too, and the read-back failure preserved
		// BOTH committed entries and their sources
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.deepEqual(record.entries, [
			{ kind: "session", arm: "control", path: "sources/raw-01-control.jsonl" },
			{ kind: "session", arm: "treatment", path: "sources/raw-02-treatment.jsonl" },
		]);
		assert.deepEqual((await readdir(join(outputRootOf(root), SOURCES_DIR_NAME))).sort(), ["raw-01-control.jsonl", "raw-02-treatment.jsonl"]);
		// attempt 1's dir was cleaned up normally; attempt 2's original raw
		// is retained because cleanup was not reached
		await expectMissing(join(outputRootOf(root), ".attempt-01-session"));
		assert.deepEqual(await readdir(join(outputRootOf(root), ".attempt-02-session")), ["session.jsonl"]);
	});
});

test("injected retention failure after exclusive source creation cleans the destination: empty record, no sources, raw in attempt dir", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const { runner } = makeFakeRunner(alwaysValid());
		let hookCalls = 0;
		await assert.rejects(
			collectFinal(
				collectOptions(root, {
					protocol,
					runner,
					afterSourceCreate: async () => {
						hookCalls += 1;
						throw new Error("injected source write failure");
					},
				}),
			),
			(error: unknown) => error instanceof FinalCollectError && error.code === "SOURCE_IO",
		);
		assert.equal(hookCalls, 1);
		// the persisted record is unchanged (the initial EMPTY record)
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.equal(record.entries.length, 0);
		// the newly-created destination was removed — no partial unrecorded source
		assert.deepEqual(await readdir(join(outputRootOf(root), SOURCES_DIR_NAME)), []);
		// the original raw still lives in its preserved attempt dir
		assert.deepEqual(await readdir(join(outputRootOf(root), ".attempt-01-session")), ["session.jsonl"]);
	});
});

test("injected retention failure after a prior attempt keeps the prior record truthful and cleans the new destination", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const { runner } = makeFakeRunner(alwaysValid());
		let hookCalls = 0;
		await assert.rejects(
			collectFinal(
				collectOptions(root, {
					protocol,
					runner,
					afterSourceCreate: async () => {
						hookCalls += 1;
						if (hookCalls === 2) throw new Error("injected source write failure");
					},
				}),
			),
			(error: unknown) => error instanceof FinalCollectError && error.code === "SOURCE_IO",
		);
		assert.equal(hookCalls, 2);
		// the persisted record still holds ONLY attempt 1
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.deepEqual(record.entries, [{ kind: "session", arm: "control", path: "sources/raw-01-control.jsonl" }]);
		// attempt 1's retained source stays; attempt 2's destination was removed
		assert.deepEqual(await readdir(join(outputRootOf(root), SOURCES_DIR_NAME)), ["raw-01-control.jsonl"]);
		// attempt 2's original raw is still in its preserved attempt dir
		assert.deepEqual(await readdir(join(outputRootOf(root), ".attempt-02-session")), ["session.jsonl"]);
		// attempt 1's dir was cleaned up normally on the committed path
		await expectMissing(join(outputRootOf(root), ".attempt-01-session"));
	});
});

test("analyzer-unclassifiable raw hard-fails preserving the truthful record and the entire attempt dir", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const promptText = await frozenPromptText();
		const { runner } = makeFakeRunner(async (_request, index) => {
			if (index === 0) {
				return { sessionFiles: [{ name: "session.jsonl", bytes: await validRaw() }] };
			}
			// attempt 2: machine-valid but unclassified + missing thinking
			return { sessionFiles: [{ name: "session.jsonl", bytes: sessionBytes(promptText, { thinking: null }) }] };
		});
		await assert.rejects(
			collectFinal(collectOptions(root, { protocol, runner })),
			(error: unknown) => error instanceof FinalCollectError && error.code === "UNREPRESENTABLE",
		);
		// the truthful partial record (attempt 1) is preserved; no entry for attempt 2
		const record = parseCollectionRecord(await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8"), "collection record");
		assert.equal(record.entries.length, 1);
		assert.equal(record.entries[0]?.kind, "session");
		assert.deepEqual(await readdir(join(outputRootOf(root), SOURCES_DIR_NAME)), ["raw-01-control.jsonl"]);
		// the ENTIRE attempt dir of the unrepresentable attempt is preserved
		assert.deepEqual(await readdir(join(outputRootOf(root), ".attempt-02-session")), ["session.jsonl"]);
	});
});

test("raw sessions are retained byte-exact and the record is strictly chronological with the frozen pin", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const produced: Buffer[] = [];
		const { runner } = makeFakeRunner(async (_request, index) => {
			if (index === 3) {
				// one invalid in the middle (prompt_mismatch) — the exact bytes that are produced
				const bad = sessionBytes(await frozenPromptText(), { prompt: "wrong prompt" });
				produced.push(bad);
				return { exitCode: 0, sessionFiles: [{ name: "session.jsonl", bytes: bad }] };
			}
			const bytes = await validRaw();
			produced.push(bytes);
			return { sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const result = await collectFinal(collectOptions(root, { protocol, runner }));
		assert.equal(result.status, "complete");
		assert.equal(result.attempts, 41);

		// persisted record == in-memory record, parses strictly, frozen pin
		const recordText = await readFile(join(outputRootOf(root), COLLECTION_RECORD_NAME), "utf8");
		const persisted = parseCollectionRecord(recordText, "collection record");
		assert.deepEqual(persisted, result.record);
		assert.equal(persisted.schemaVersion, 1);
		assert.equal(persisted.phase, "final");
		assert.equal(persisted.nonTreatmentSha256, protocol.nonTreatmentSha256);
		assert.equal(persisted.nonTreatmentSha256, (await nonTreatmentBundleHash(root)).sha256);
		// exact wire shape (strict key set, no extras, no status/cap field)
		assert.deepEqual(JSON.parse(recordText), {
			schema_version: 1,
			phase: "final",
			non_treatment_sha256: protocol.nonTreatmentSha256,
			entries: result.record.entries.map((entry) => ({ kind: entry.kind, arm: entry.arm, path: entry.path })),
		});
		// serializer round-trips through the strict parser
		assert.deepEqual(parseCollectionRecord(serializeCollectionRecord(result.record), "collection record"), result.record);

		// chronology: entries in exact attempt order (attempt 4 was the invalid one)
		assert.deepEqual(
			result.record.entries.map((entry) => entry.kind),
			["session", "session", "session", "attempt", ...Array.from({ length: 37 }, () => "session")],
		);

		// byte preservation: every retained source is byte-identical to the produced raw
		for (let i = 0; i < produced.length; i += 1) {
			const entry = result.record.entries[i];
			assert.ok(entry !== undefined);
			const retained = await readFile(join(outputRootOf(root), entry.path));
			assert.ok(retained.equals(produced[i] as Buffer), `source ${entry.path} must be byte-identical`);
		}

	});
});

test("attempt argv differs between arms ONLY in extension/name/session dir; env is identical", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const { runner, calls } = makeFakeRunner(alwaysValid());
		const runsDir = join(root, "runs");
		const result = await collectFinal({ paths: { projectRoot: root, inputsDir: INPUTS_DIR, runsDir }, protocol, runner, runtimeFacts: { processVersion: "v26.4.0" } });
		assert.equal(result.status, "complete");
		assert.equal(calls.length, 40);

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

		// arm extension paths are the exact FINAL production files (never the DEV wrapper)
		assert.ok(calls.some((call) => call.argv[EXTENSION] === controlExtensionOf(root)));
		assert.ok(calls.some((call) => call.argv[EXTENSION] === join(root, TREATMENT_RUNTIME_REL)));
		for (const call of calls) {
			assert.ok(!call.argv[EXTENSION]?.includes("commander-native-tool-control-extension.ts"), "the DEV-pilot control approximation must never be used");
		}

		// session dirs are fresh per attempt under the output root; names unique
		const sessionDirs = calls.map((call) => call.argv[SESSION_DIR] as string);
		const names = calls.map((call) => call.argv[NAME] as string);
		assert.equal(new Set(sessionDirs).size, 40);
		assert.equal(new Set(names).size, 40);
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
			// fixture cwd, pi program, caps and timeouts are exact
			assert.equal(call.cwd, FIXTURE_CWD);
			assert.equal(call.program, join(root, PI_BIN_REL));
			assert.equal(call.timeoutMs, ATTEMPT_TIMEOUT_MS);
			assert.equal(call.terminateGraceMs, TERMINATE_GRACE_MS);
			assert.equal(call.stdoutMaxBytes, ATTEMPT_STDOUT_MAX_BYTES);
			assert.equal(call.stderrMaxBytes, ATTEMPT_STDERR_MAX_BYTES);
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
	assert.ok(usage().includes("FINAL validation collector (final evidence only)"));
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
		const protocol = await makeProjectRoot(root);
		const { runner } = makeFakeRunner(alwaysValid());
		const { io, stdout, stderr } = captureIo();
		const code = await main([], io, async (opts) => collectFinal({ ...collectOptions(root, { protocol, runner }), onDiagnostic: opts.onDiagnostic }));
		assert.equal(code, 0);
		assert.equal(stdout.length, 1);
		const line = stdout[0] as string;
		assert.equal(line, `commander-native-tool-final-collect: status=complete valid=40 attempts=40 collection=.pi/workbench/runs/${OUTPUT_ROOT_NAME}/collection-record.json`);
		assert.ok(!line.includes(root), "summary must not carry absolute paths");
		assert.ok(!line.includes(await frozenPromptText()), "summary must never carry prompt content");
		assert.deepEqual(stderr, []);
	});
});

test("main: exhausted run exits 1 with the truthful partial summary and bounded diagnostics", async () => {
	await withTempDir(async (root) => {
		const protocol = await makeProjectRoot(root);
		const { runner } = makeFakeRunner(async () => {
			// content-classified INVALID raw (nonterminal) — exit 3 is diagnostic only
			const bytes = sessionBytes(await frozenPromptText(), { stopReason: "length" });
			return { exitCode: 3, sessionFiles: [{ name: "session.jsonl", bytes }] };
		});
		const { io, stdout, stderr } = captureIo();
		const code = await main([], io, async (opts) => collectFinal({ ...collectOptions(root, { protocol, runner }), onDiagnostic: opts.onDiagnostic }));
		assert.equal(code, 1);
		assert.equal(stdout.length, 1);
		assert.equal(stdout[0], `commander-native-tool-final-collect: status=attempts-exhausted valid=0 attempts=60 collection=.pi/workbench/runs/${OUTPUT_ROOT_NAME}/collection-record.json`);
		// per-attempt diagnostics on stderr, bounded, no absolute paths
		assert.equal(stderr.length, 60);
		for (const line of stderr) {
			assert.ok(/^commander-native-tool-final-collect: attempt \d{2} \(control\) invalid: nonterminal — no terminal assistant stop response \(exit 3\)$/.test(line), line);
			assert.ok(!line.includes(root), "diagnostics must not carry absolute paths");
			assert.ok(!line.includes(await frozenPromptText()), "diagnostics must never carry prompt content");
		}
	});
});

test("main: runtime failures exit 1 with stderr only (never a partial stdout claim)", async () => {
	const { io, stdout, stderr } = captureIo();
	const code = await main([], io, async () => {
		throw new FinalCollectError("SPAWN_FAILED", "the attempt process could not be started (details withheld)");
	});
	assert.equal(code, 1);
	assert.deepEqual(stdout, []);
	assert.equal(stderr.length, 1);
	assert.equal(stderr[0], "commander-native-tool-final-collect: SPAWN_FAILED: the attempt process could not be started (details withheld)");
});

test("main: non-collector runtime failures are withheld (privacy boundary)", async () => {
	const { io, stdout, stderr } = captureIo();
	const code = await main([], io, async () => {
		throw new Error(`sensitive detail ${PROJECT_ROOT}`);
	});
	assert.equal(code, 1);
	assert.deepEqual(stdout, []);
	assert.equal(stderr.length, 1);
	assert.equal(stderr[0], "commander-native-tool-final-collect: unexpected failure (details withheld — privacy boundary)");
});

// ---------------------------------------------------------------------------
// package.json and recipes.yaml wiring (hermetic, read-only parsing)
// ---------------------------------------------------------------------------

test("package.json: commander:nro:final wired to the FINAL collector with no hidden flags", async () => {
	const pkg = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
	assert.equal(pkg.scripts?.["commander:nro:final"], "tsx scripts/commander-native-tool-final-collect.ts");
});

async function loadRecipes(): Promise<ReturnType<typeof parseRecipesDocument>> {
	const text = await readFile(join(PROJECT_ROOT, ".pi", "workbench", "recipes.yaml"), "utf8");
	return parseRecipesDocument(parseYaml(text));
}

test("recipes.yaml: commander-native-tool-final-collect — exact argv, DEV-only, uncached, [0,1], artifact-only final root, no params, sufficient timeout", async () => {
	const doc = await loadRecipes();
	assert.deepEqual(doc.errors, []);
	assert.deepEqual(doc.warnings, []);
	const recipe = doc.recipes.find((r) => r.name === "commander-native-tool-final-collect");
	assert.ok(recipe, "commander-native-tool-final-collect recipe declared");

	// exact invocation: the package script, no args, project cwd
	assert.deepEqual(recipe.command, ["npm", "run", "commander:nro:final"]);
	assert.equal(recipe.cwd, ".");
	// paid external provider/model collection, DEV-only, clearly labelled
	assert.deepEqual(recipe.allowed_modes, ["DEV"]);
	assert.ok(recipe.description.includes("PAID"), "recipe must be labelled as PAID external provider/model collection");
	assert.ok(recipe.description.includes("authorization"), "recipe must require separate explicit user authorization");
	// expected exits: 0 = complete 40-valid collection; 1 = truthful capped partial / runtime hard-fail
	assert.deepEqual(recipe.expected_exit_codes, [0, 1]);
	// mutation/artifact/write scope: ONLY the final collection root
	assert.equal(recipe.mutation, "artifacts");
	assert.deepEqual(recipe.writes, [`.pi/workbench/runs/${OUTPUT_ROOT_NAME}/**`]);
	assert.deepEqual(recipe.artifacts, [`.pi/workbench/runs/${OUTPUT_ROOT_NAME}/**`]);
	// no params, no env
	assert.deepEqual(recipe.params, []);
	assert.deepEqual(recipe.environment, []);
	// intentionally never cached
	assert.equal(recipe.cache.enabled, false);
	// timeout covers the frozen worst case: 60 x 30-minute per-attempt timeouts
	// plus small overhead (~31 hours); collector timeouts/cap are unchanged
	assert.equal(FINAL_MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS, 60 * 30 * 60 * 1000);
	assert.ok(
		recipe.timeout_ms >= FINAL_MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS + 3_600_000,
		`timeout must cover ~31 h (60 x 30 min + overhead), got ${recipe.timeout_ms}`,
	);
	assert.ok(recipe.timeout_ms <= 150_000_000, `timeout must stay bounded, got ${recipe.timeout_ms}`);
});
