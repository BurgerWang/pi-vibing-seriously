/**
 * NRO N2 native-search-adapter tests — the Pi-free, abort-aware count-scan
 * adapter (Commander Native Tool Optimization plan §6.2 / §9 rows 10–12,
 * 18, 21):
 *
 *   - strict `path\0count\n` parser: real multi-record framing, Unicode and
 *     embedded-newline path text preserved, empty stdout = exactly zero
 *     records, and EVERY malformed/partial/duplicate/trailing case rejects
 *     (a partial parse is never returned);
 *   - exact buildGrepCountArgs vectors (approved flag order/family pinned;
 *     legacy limit/context can never enter the count surface);
 *   - managed-first/system rg resolution and Pi-equivalent path resolution;
 *   - real installed rg scans on a deterministic temporary git repo:
 *     occurrence count vs matching-line count vs distinct files for regex,
 *     literal, ignoreCase, glob, file/directory path, .gitignore and zero
 *     matches;
 *   - failures — missing path, rg unavailable, spawn failure, non-0/1 exit
 *     (even with valid partial stdout), pre-abort and deterministic
 *     during-abort — all reject explicitly (`Operation aborted` verbatim
 *     for aborts); no failure ever returns a count.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	buildGrepCountArgs,
	managedRgPath,
	parseGrepCountOutput,
	resolveGrepSearchPath,
	resolveRgPath,
	runGrepCount,
	type GrepCountRequest,
	type GrepCountResult,
} from "../extensions/workbench-runtime/core/native-search-adapter.ts";
import { withTempDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Suite-wide environment facts (hermetic git config so .gitignore behavior
// is deterministic; system rg/git availability for the real-scan tests)
// ---------------------------------------------------------------------------

const POSIX = process.platform !== "win32";
const RG_BIN_NAME = process.platform === "win32" ? "rg.exe" : "rg";

/** Resolved real rg (managed or system) used by the real-scan tests; null when rg is not installed. */
let systemRg: string | null = null;
let gitOk = false;
let hermeticGitEnvDir: string | null = null;
const savedGitEnv: Record<string, string | undefined> = {};

before(async () => {
	systemRg = resolveRgPath({ PATH: process.env.PATH ?? "" }, tmpdir());
	gitOk = spawnSync("git", ["--version"], { stdio: "ignore" }).error === undefined;
	hermeticGitEnvDir = await mkdtemp(join(tmpdir(), "nro-n2-gitenv-"));
	for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "XDG_CONFIG_HOME"]) {
		savedGitEnv[key] = process.env[key];
	}
	process.env.GIT_CONFIG_GLOBAL = join(hermeticGitEnvDir, "empty-global-config");
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.XDG_CONFIG_HOME = join(hermeticGitEnvDir, "xdg");
	await writeFile(process.env.GIT_CONFIG_GLOBAL, "", "utf8");
	await mkdir(process.env.XDG_CONFIG_HOME, { recursive: true });
});

after(async () => {
	for (const key of Object.keys(savedGitEnv)) {
		const value = savedGitEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (hermeticGitEnvDir !== null) {
		await rm(hermeticGitEnvDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Strict output parser (path\0count\n framing)
// ---------------------------------------------------------------------------

test("parser: real multi-file path\\0count\\n framing", () => {
	const stdout = "a.ts\0" + "4" + "\n" + "b.ts\0" + "0" + "\n";
	assert.deepEqual(parseGrepCountOutput(stdout), [
		{ file: "a.ts", count: 4 },
		{ file: "b.ts", count: 0 },
	]);
});

test("parser: preserves Unicode and embedded-newline path text verbatim", () => {
	const stdout = "café ☕.txt\0" + "3" + "\n" + "line\nbreak.txt\0" + "1" + "\n";
	assert.deepEqual(parseGrepCountOutput(stdout), [
		{ file: "café ☕.txt", count: 3 },
		{ file: "line\nbreak.txt", count: 1 },
	]);
});

test("parser: count is the full ASCII digit run (leading zeros fine)", () => {
	assert.deepEqual(parseGrepCountOutput("a.txt\0" + "007" + "\n"), [{ file: "a.txt", count: 7 }]);
});

test("parser: empty stdout is exactly zero records", () => {
	assert.deepEqual(parseGrepCountOutput(""), []);
});

test("parser: CRLF tolerance is opt-in and win32-defaulted", () => {
	const crlf = "a.txt\0" + "1" + "\r\n" + "b.txt\0" + "2" + "\r\n";
	assert.deepEqual(parseGrepCountOutput(crlf, { acceptCrLf: true }), [
		{ file: "a.txt", count: 1 },
		{ file: "b.txt", count: 2 },
	]);
	// mixed LF + CRLF records with tolerance
	const mixed = "a.txt\0" + "1" + "\n" + "b.txt\0" + "2" + "\r\n";
	assert.deepEqual(parseGrepCountOutput(mixed, { acceptCrLf: true }), [
		{ file: "a.txt", count: 1 },
		{ file: "b.txt", count: 2 },
	]);
	// without tolerance, CRLF is malformed
	assert.throws(() => parseGrepCountOutput(crlf, { acceptCrLf: false }), /invalid count/);
	// CR at EOF with tolerance is still missing its LF
	assert.throws(() => parseGrepCountOutput("a.txt\0" + "1" + "\r", { acceptCrLf: true }), /missing line terminator/);
	// the default follows the platform (win32 tolerates, POSIX rejects)
	if (process.platform === "win32") {
		assert.equal(parseGrepCountOutput(crlf).length, 2);
	} else {
		assert.throws(() => parseGrepCountOutput(crlf), /invalid count/);
	}
});

test("parser: strictly rejects every malformed/partial/duplicate/trailing case", () => {
	const cases: Array<[stdout: string, expected: RegExp]> = [
		// missing NUL (bare path, and path after a complete record)
		["alpha.txt", /missing NUL/],
		["a.txt\0" + "1" + "\n" + "b.txt", /missing NUL/],
		["a.txt\0" + "1" + "\n" + "\n", /missing NUL/],
		// empty path
		["\0" + "1" + "\n", /empty file path/],
		["a.txt\0" + "1" + "\n" + "\0" + "2" + "\n", /empty file path/],
		// missing count (nothing, non-digit, or whitespace before the LF)
		["a.txt\0" + "\n", /missing count/],
		["a.txt\0" + "x1" + "\n", /missing count/],
		["a.txt\0" + " 1" + "\n", /missing count/],
		// non-digit / non-LF-terminated count
		["a.txt\0" + "1x" + "\n", /invalid count/],
		["a.txt\0" + "1 " + "\n", /invalid count/],
		["a.txt\0" + "1.5" + "\n", /invalid count/],
		// the OLD incorrect path\0count\0 framing must reject
		["a.txt\0" + "1" + "\0" + "b.txt\0" + "2" + "\0", /invalid count/],
		// unsafe (non-safe-integer) counts
		["a.txt\0" + "9007199254740992" + "\n", /count out of range/],
		["a.txt\0" + "99999999999999999999" + "\n", /count out of range/],
		// missing terminator at EOF
		["a.txt\0" + "1", /missing line terminator/],
		["a.txt\0" + "1" + "\n" + "b.txt\0" + "2", /missing line terminator/],
		// duplicate path
		["a.txt\0" + "1" + "\n" + "a.txt\0" + "2" + "\n", /duplicate file path/],
		// trailing junk after a complete record
		["a.txt\0" + "1" + "\n" + "junk", /missing NUL/],
		["a.txt\0" + "1" + "\n" + "junk\0" + "\n", /missing count/],
	];
	for (const [stdout, expected] of cases) {
		assert.throws(() => parseGrepCountOutput(stdout), expected, `input ${JSON.stringify(stdout)}`);
	}
});

// ---------------------------------------------------------------------------
// Argument vector (approved order/family; no limit/context surface)
// ---------------------------------------------------------------------------

test("buildGrepCountArgs: exact vectors pin the approved flag order and family", () => {
	assert.deepEqual(buildGrepCountArgs({ pattern: "foo", countKind: "matches" }, "/repo"), [
		"--color=never",
		"--hidden",
		"--count-matches",
		"--with-filename",
		"--null",
		"--",
		"foo",
		"/repo",
	]);
	assert.deepEqual(buildGrepCountArgs({ pattern: "foo", countKind: "lines" }, "/repo"), [
		"--color=never",
		"--hidden",
		"--count",
		"--with-filename",
		"--null",
		"--",
		"foo",
		"/repo",
	]);
	assert.deepEqual(buildGrepCountArgs({ pattern: "foo", ignoreCase: true, countKind: "matches" }, "/repo"), [
		"--color=never",
		"--hidden",
		"--ignore-case",
		"--count-matches",
		"--with-filename",
		"--null",
		"--",
		"foo",
		"/repo",
	]);
	assert.deepEqual(buildGrepCountArgs({ pattern: "foo", literal: true, countKind: "matches" }, "/repo"), [
		"--color=never",
		"--hidden",
		"--fixed-strings",
		"--count-matches",
		"--with-filename",
		"--null",
		"--",
		"foo",
		"/repo",
	]);
	assert.deepEqual(buildGrepCountArgs({ pattern: "foo", glob: "*.ts", countKind: "matches" }, "/repo"), [
		"--color=never",
		"--hidden",
		"--glob",
		"*.ts",
		"--count-matches",
		"--with-filename",
		"--null",
		"--",
		"foo",
		"/repo",
	]);
	// all selectors together: fixed order --ignore-case, --fixed-strings, --glob, count flag
	assert.deepEqual(buildGrepCountArgs({ pattern: "pat", glob: "**/*.spec.ts", ignoreCase: true, literal: true, countKind: "lines" }, "/p"), [
		"--color=never",
		"--hidden",
		"--ignore-case",
		"--fixed-strings",
		"--glob",
		"**/*.spec.ts",
		"--count",
		"--with-filename",
		"--null",
		"--",
		"pat",
		"/p",
	]);
});

test("buildGrepCountArgs: limit/context can never enter the count args", () => {
	const vectors = [
		buildGrepCountArgs({ pattern: "foo", countKind: "matches" }, "/repo"),
		buildGrepCountArgs({ pattern: "foo", countKind: "lines" }, "/repo"),
		buildGrepCountArgs({ pattern: "foo", glob: "*.ts", ignoreCase: true, literal: true, countKind: "matches" }, "/repo"),
	];
	for (const args of vectors) {
		assert.ok(!args.includes("limit"), "limit must never appear in count args");
		assert.ok(!args.includes("context"), "context must never appear in count args");
		assert.ok(!args.some((arg) => arg.startsWith("--limit") || arg.startsWith("--context")));
	}
	// flag-looking patterns and spaces stay single literal argv elements after "--"
	assert.deepEqual(buildGrepCountArgs({ pattern: "-n", countKind: "matches" }, "/p").slice(-2), ["-n", "/p"]);
	assert.deepEqual(buildGrepCountArgs({ pattern: "a b", countKind: "matches" }, "/p dir").slice(-2), ["a b", "/p dir"]);
});

// Compile-time guard: the count request surface must never grow the legacy
// limit/context fields (typecheck fails if it ever does).
type NoLegacyCountFields = "limit" extends keyof GrepCountRequest ? false : "context" extends keyof GrepCountRequest ? false : true;
const _noLegacyCountFields: NoLegacyCountFields = true;

// ---------------------------------------------------------------------------
// Binary and path resolution
// ---------------------------------------------------------------------------

test("managedRgPath: PI_CODING_AGENT_DIR first, then homeDir layout, else null", async () => {
	await withTempDir(async (dir) => {
		const bin = join(dir, "bin");
		await mkdir(bin);
		const fake = join(bin, RG_BIN_NAME);
		await writeFile(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		assert.equal(managedRgPath({ PI_CODING_AGENT_DIR: dir }, dir), fake);
		// env dir without the binary: null — the adapter never downloads/writes
		assert.equal(managedRgPath({ PI_CODING_AGENT_DIR: join(dir, "missing") }, dir), null);
		// homeDir fallback layout: ~/.pi/agent/bin/rg
		const home = join(dir, "home");
		const homeBin = join(home, ".pi", "agent", "bin");
		await mkdir(homeBin, { recursive: true });
		const homeFake = join(homeBin, RG_BIN_NAME);
		await writeFile(homeFake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		assert.equal(managedRgPath({}, home), homeFake);
		// neither: null
		assert.equal(managedRgPath({}, dir), null);
	});
});

test("resolveRgPath: managed first, then system rg on the injected PATH, else null", async () => {
	await withTempDir(async (dir) => {
		const bin = join(dir, "bin");
		await mkdir(bin);
		const managed = join(bin, RG_BIN_NAME);
		await writeFile(managed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		// managed wins even when the system rg exists on PATH
		assert.equal(resolveRgPath({ PI_CODING_AGENT_DIR: dir, PATH: process.env.PATH ?? "" }, dir), managed);
		// no managed: system rg on the injected PATH (mirrors the environment)
		const system = resolveRgPath({ PATH: process.env.PATH ?? "" }, dir);
		if (systemRg !== null) assert.equal(system, "rg");
		else assert.equal(system, null);
		// neither managed nor system: null (deterministic, empty PATH)
		const emptyBin = join(dir, "empty-bin");
		await mkdir(emptyBin);
		assert.equal(resolveRgPath({ PATH: emptyBin }, dir), null);
	});
});

test("resolveGrepSearchPath: Pi-equivalent normalization", (t) => {
	if (!POSIX) {
		t.skip("POSIX path-form assertions");
		return;
	}
	const cwd = "/proj";
	assert.equal(resolveGrepSearchPath("src", cwd), "/proj/src");
	assert.equal(resolveGrepSearchPath("/abs/path", cwd), "/abs/path");
	assert.equal(resolveGrepSearchPath("@rel", cwd), "/proj/rel");
	assert.equal(resolveGrepSearchPath("caf\u00A0x", cwd), "/proj/caf x");
	assert.equal(resolveGrepSearchPath("file:///tmp/x", cwd), fileURLToPath("file:///tmp/x"));
	assert.equal(resolveGrepSearchPath("~/x", "/proj", "/home/t"), "/home/t/x");
});

// ---------------------------------------------------------------------------
// Real installed rg scans on a deterministic temporary git repo
// ---------------------------------------------------------------------------

/**
 * Deterministic fixture repo. Expected "foo" counts (cross-platform):
 * README.md 1, src/a.ts 4, src/b.ts 2, src/sub/c.ts 1, src/ünïcode ☕.txt 1;
 * data/ignored.log and node_modules/dep.js are excluded by .gitignore.
 *
 * Determinism note: `--hidden` makes rg 15 also scan `.git/hooks/*.sample`
 * (git-version-dependent content), so full-repo assertions only use
 * patterns that cannot match those samples ("foo", "^foo", "FOO",
 * "zzz-absent") and regex-metacharacter assertions scan `path: "src"`.
 */
const FIXTURE_FILES: Array<{ path: string; content: string }> = [
	{ path: ".gitignore", content: "node_modules/\n*.log\n" },
	{ path: "README.md", content: "project foo\n" },
	{ path: "src/a.ts", content: "foo bar\nfoo foo\nno match here\nfoo" },
	{ path: "src/b.ts", content: "FOO foo\nfoo\n" },
	{ path: "src/sub/c.ts", content: "foo\n" },
	{ path: "src/ünïcode ☕.txt", content: "foo\n" },
	{ path: "data/ignored.log", content: "foo foo foo\n" },
	{ path: "node_modules/dep.js", content: "foo foo\n" },
];

async function createFixtureRepo(root: string, extraFiles: Array<{ path: string; content: string }> = []): Promise<void> {
	for (const file of FIXTURE_FILES.concat(extraFiles)) {
		const full = join(root, file.path);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, file.content, "utf8");
	}
	const git = spawnSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
	assert.equal(git.error, undefined, "git init must run");
	assert.equal(git.status, 0, "git init must exit 0");
}

async function withFixtureRepo<T>(
	fn: (root: string) => Promise<T>,
	extraFiles: Array<{ path: string; content: string }> = [],
): Promise<T> {
	return withTempDir(async (root) => {
		await createFixtureRepo(root, extraFiles);
		return fn(root);
	});
}

function scan(root: string, request: GrepCountRequest): Promise<GrepCountResult> {
	if (systemRg === null) throw new Error("scan() requires an installed rg — tests must skip first");
	return runGrepCount(request, { cwd: root, rgPath: systemRg });
}

function needsRgAndGit(t: { skip: (message?: string) => void }): boolean {
	if (systemRg === null) {
		t.skip("real ripgrep (rg) is not installed");
		return false;
	}
	if (!gitOk) {
		t.skip("git is not installed");
		return false;
	}
	return true;
}

test("real rg: occurrence count vs matching-line count vs distinct files", async (t) => {
	if (!needsRgAndGit(t)) return;
	await withFixtureRepo(async (root) => {
		assert.deepEqual(await scan(root, { pattern: "foo", countKind: "matches" }), { value: 9, files: 5 });
		assert.deepEqual(await scan(root, { pattern: "foo", countKind: "lines" }), { value: 8, files: 5 });
	});
});



test("real rg: regex, literal and ignoreCase semantics (path src — .git-free)", async (t) => {
	if (!needsRgAndGit(t)) return;
	// Scans are rooted at src/ so git-version-dependent .git/hooks samples
	// (which rg --hidden scans) can never affect the counts.
	await withFixtureRepo(async (root) => {
		// regex anchoring: only line-start occurrences
		assert.deepEqual(await scan(root, { pattern: "^foo", path: "src", countKind: "matches" }), { value: 6, files: 4 });
		// literal disables regex metacharacters
		assert.deepEqual(await scan(root, { pattern: "f.o", literal: true, path: "src", countKind: "matches" }), { value: 0, files: 0 });
		assert.deepEqual(await scan(root, { pattern: "f.o", path: "src", countKind: "matches" }), { value: 8, files: 4 });
		// case sensitivity: "FOO" hits only b.ts's literal FOO; ignoreCase hits everything
		assert.deepEqual(await scan(root, { pattern: "FOO", path: "src", countKind: "matches" }), { value: 1, files: 1 });
		assert.deepEqual(await scan(root, { pattern: "FOO", ignoreCase: true, path: "src", countKind: "matches" }), { value: 9, files: 4 });
		assert.deepEqual(await scan(root, { pattern: "FOO", ignoreCase: true, path: "src", countKind: "lines" }), { value: 7, files: 4 });
	});
});

test("real rg: glob filters and .gitignore exclusion", async (t) => {
	if (!needsRgAndGit(t)) return;
	await withFixtureRepo(async (root) => {
		assert.deepEqual(await scan(root, { pattern: "foo", glob: "**/*.ts", countKind: "matches" }), { value: 7, files: 3 });
		assert.deepEqual(await scan(root, { pattern: "foo", glob: "**/*.ts", countKind: "lines" }), { value: 6, files: 3 });
		assert.deepEqual(await scan(root, { pattern: "foo", glob: "*.md", countKind: "matches" }), { value: 1, files: 1 });
		// directory-scoped glob (absolute search paths need a leading **)
		assert.deepEqual(await scan(root, { pattern: "foo", glob: "**/sub/*.ts", countKind: "matches" }), { value: 1, files: 1 });
		// an explicit --glob match OVERRIDES ignore rules for the matched file
		// (documented rg behavior): data/ignored.log is gitignored by *.log yet
		// searched when the glob targets it — .gitignore exclusion is proven
		// by the default full-repo scan (occurrence test: 9/5, not 14/7).
		assert.deepEqual(await scan(root, { pattern: "foo", glob: "**/*.log", countKind: "matches" }), { value: 3, files: 1 });
	});
});

test("real rg: file and directory search paths", async (t) => {
	if (!needsRgAndGit(t)) return;
	await withFixtureRepo(async (root) => {
		assert.deepEqual(await scan(root, { pattern: "foo", path: "src", countKind: "matches" }), { value: 8, files: 4 });
		assert.deepEqual(await scan(root, { pattern: "foo", path: "src", countKind: "lines" }), { value: 7, files: 4 });
		assert.deepEqual(await scan(root, { pattern: "foo", path: "src/a.ts", countKind: "matches" }), { value: 4, files: 1 });
		assert.deepEqual(await scan(root, { pattern: "foo", path: "README.md", countKind: "matches" }), { value: 1, files: 1 });
	});
});

test("real rg: zero matches is an exact zero result, not an error", async (t) => {
	if (!needsRgAndGit(t)) return;
	await withFixtureRepo(async (root) => {
		assert.deepEqual(await scan(root, { pattern: "zzz-absent", countKind: "matches" }), { value: 0, files: 0 });
		assert.deepEqual(await scan(root, { pattern: "zzz-absent", countKind: "lines" }), { value: 0, files: 0 });
	});
});

test("real rg: newline-in-path file counts (POSIX)", async (t) => {
	if (!needsRgAndGit(t)) return;
	if (!POSIX) {
		t.skip("newline filenames are POSIX-only");
		return;
	}
	await withFixtureRepo(
		async (root) => {
			assert.deepEqual(await scan(root, { pattern: "foo", countKind: "matches" }), { value: 10, files: 6 });
			assert.deepEqual(await scan(root, { pattern: "foo", countKind: "lines" }), { value: 9, files: 6 });
		},
		[{ path: "src/odd\nname.txt", content: "foo\n" }],
	);
});

// ---------------------------------------------------------------------------
// Failure and abort semantics (bounded fake rg executables where needed)
// ---------------------------------------------------------------------------

async function writeFakeRg(dir: string, body: string): Promise<string> {
	const path = join(dir, "fake-rg");
	await writeFile(path, `#!/bin/sh\n${body}`, "utf8");
	await chmod(path, 0o755);
	return path;
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${path}`);
}

test("runGrepCount: missing search path rejects with the built-in text", async () => {
	await withTempDir(async (dir) => {
		const expected = `Path not found: ${resolveGrepSearchPath("no-such-dir", dir)}`;
		await assert.rejects(
			runGrepCount({ pattern: "x", countKind: "matches", path: "no-such-dir" }, { cwd: dir, rgPath: "rg" }),
			(err: unknown) => err instanceof Error && err.message === expected,
		);
	});
});

test("runGrepCount: rg unavailable rejects explicitly", async () => {
	await withTempDir(async (dir) => {
		const emptyBin = join(dir, "empty-bin");
		await mkdir(emptyBin);
		await assert.rejects(
			runGrepCount({ pattern: "x", countKind: "matches" }, { cwd: dir, env: { PATH: emptyBin }, homeDir: dir }),
			/ripgrep \(rg\) is not available/,
		);
	});
});

test("runGrepCount: spawn failure rejects explicitly", async () => {
	await withTempDir(async (dir) => {
		await assert.rejects(
			runGrepCount({ pattern: "x", countKind: "matches" }, { cwd: dir, rgPath: join(dir, "no-such-rg") }),
			/Failed to run ripgrep/,
		);
	});
});

test("runGrepCount: pre-aborted signal rejects exactly Operation aborted", async () => {
	await withTempDir(async (dir) => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			runGrepCount({ pattern: "x", countKind: "matches" }, { cwd: dir, signal: controller.signal, rgPath: "rg" }),
			(err: unknown) => err instanceof Error && err.message === "Operation aborted",
		);
	});
});

test("fake rg: exit 1 with empty stdout resolves exact zero", async (t) => {
	if (!POSIX) {
		t.skip("fake rg shell fixtures are POSIX-only");
		return;
	}
	await withTempDir(async (dir) => {
		const rgPath = await writeFakeRg(dir, "exit 1\n");
		assert.deepEqual(await runGrepCount({ pattern: "x", countKind: "matches" }, { cwd: dir, rgPath }), { value: 0, files: 0 });
	});
});

test("fake rg: valid path\\0count\\n records sum exactly", async (t) => {
	if (!POSIX) {
		t.skip("fake rg shell fixtures are POSIX-only");
		return;
	}
	await withTempDir(async (dir) => {
		const rgPath = await writeFakeRg(dir, "printf 'a.txt\\0002\\012b.txt\\0003\\012'\n");
		assert.deepEqual(await runGrepCount({ pattern: "x", countKind: "matches" }, { cwd: dir, rgPath }), { value: 5, files: 2 });
	});
});

test("fake rg: malformed (old path\\0count\\0 framing) output rejects, never a partial count", async (t) => {
	if (!POSIX) {
		t.skip("fake rg shell fixtures are POSIX-only");
		return;
	}
	await withTempDir(async (dir) => {
		const rgPath = await writeFakeRg(dir, "printf 'a.txt\\0001\\000b.txt\\0002\\000'\n");
		await assert.rejects(runGrepCount({ pattern: "x", countKind: "matches" }, { cwd: dir, rgPath }), /Malformed rg count output/);
	});
});

test("fake rg: non-0/1 exit rejects even with valid partial stdout", async (t) => {
	if (!POSIX) {
		t.skip("fake rg shell fixtures are POSIX-only");
		return;
	}
	await withTempDir(async (dir) => {
		const rgPath = await writeFakeRg(dir, "printf 'a.txt\\0002\\012'\nexit 2\n");
		await assert.rejects(runGrepCount({ pattern: "x", countKind: "matches" }, { cwd: dir, rgPath }), /ripgrep failed with exit code 2/);
	});
});

test("fake rg: non-0/1 exit rejects with stderr detail", async (t) => {
	if (!POSIX) {
		t.skip("fake rg shell fixtures are POSIX-only");
		return;
	}
	await withTempDir(async (dir) => {
		const rgPath = await writeFakeRg(dir, "printf 'oops' >&2\nexit 3\n");
		await assert.rejects(
			runGrepCount({ pattern: "x", countKind: "matches" }, { cwd: dir, rgPath }),
			(err: unknown) => err instanceof Error && err.message === "ripgrep failed with exit code 3: oops",
		);
	});
});

test("fake rg: abort during the scan rejects exactly Operation aborted, never a partial count", async (t) => {
	if (!POSIX) {
		t.skip("fake rg shell fixtures are POSIX-only");
		return;
	}
	await withTempDir(async (dir) => {
		// Deterministic during-abort: the fake rg emits one valid record,
		// creates a marker, then blocks — the test aborts only after the
		// marker proves the record was produced.
		const marker = join(dir, "produced.marker");
		const rgPath = await writeFakeRg(dir, `printf 'a.txt\\0001\\012'\n: > '${marker}'\nexec sleep 30\n`);
		const controller = new AbortController();
		const pending = runGrepCount({ pattern: "x", countKind: "matches" }, { cwd: dir, rgPath, signal: controller.signal });
		await waitForFile(marker, 5000);
		controller.abort();
		await assert.rejects(pending, (err: unknown) => err instanceof Error && err.message === "Operation aborted");
	});
});
