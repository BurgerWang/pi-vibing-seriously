/**
 * NRO N2 native search adapter — the Pi-free, abort-aware direct-execution
 * backend for the `grep` count mode (Commander Native Tool Optimization
 * plan, `docs/plans/commander-native-tool-optimization.md` §6.2 / §9 rows
 * 10–12, 18, 21).
 *
 * The Pi 0.83.0 built-in `createGrepToolDefinition` exposes NO count mode,
 * so `output=count` runs the SAME installed ripgrep engine with the SAME
 * flag family as the built-in matches path — `--color=never`, `--hidden`,
 * optional `--ignore-case` / `--fixed-strings` / `--glob`, then `--`,
 * pattern, resolved search path — with the matches-specific flags replaced
 * by the count flags (`--count` / `--count-matches` plus the unambiguous
 * per-file framing `--with-filename --null`, so each record is exactly
 * `path\0count\n` (path NUL-terminated, count LF-terminated) and never
 * ambiguous). `.gitignore` is respected by the same
 * engine defaults; the legacy `limit`/`context` are deliberately NEVER
 * applied — the count is exact over the full scan.
 *
 * Contract:
 *   - binary resolution: the existing managed rg first
 *     (`PI_CODING_AGENT_DIR` or `~/.pi/agent/bin/rg[.exe]`), then the
 *     system rg on PATH — NEVER downloading and NEVER writing anything
 *     (unlike `ensureTool`, which may download);
 *   - path resolution: Pi 0.83.0 `resolveToCwd` parity via the policy
 *     module's `nativeResolvePath` (unicode-space normalization, leading-`@`
 *     strip, tilde expansion, `file://` decoding, absolute-vs-relative);
 *     a missing search path fails explicitly with the built-in's own text
 *     (`Path not found: <resolved>`);
 *   - execution: `spawn` with an explicit argument vector and `shell:false`
 *     only — no shell, no `pi.exec`, no model calls, no writes;
 *   - abort: a pre-aborted signal rejects `Operation aborted`; an abort
 *     during the scan kills the child and rejects `Operation aborted` —
 *     never a partial count;
 *   - failures: rg unavailable, spawn failure (`Failed to run ripgrep:
 *     <message>`), or any rg exit code other than 0/1 (with stderr detail)
 *     reject explicitly and NEVER return a partial number; exit 0 = matches
 *     found, exit 1 = no matches (zero is an exact result, not an error);
 *   - output: per-file counts parsed strictly from the `path\0count\n`
 *     records (every malformed/partial/duplicate/trailing case rejects;
 *     empty stdout is exactly zero records), summed;
 *     `files` = distinct files with at least one match.
 *
 * The adapter is pure and injectable (env/homeDir/rgPath/signal), so it is
 * unit-tested against the real installed rg (tests/native-search-adapter
 * .test.ts) and through the registered override (tests/native-tool-wiring
 * .test.ts).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { nativeNormalizePath, nativeResolvePath, type GrepCountKind } from "./native-tool-policy.ts";

// ---------------------------------------------------------------------------
// Binary resolution (managed first, then system; never downloads, never writes)
// ---------------------------------------------------------------------------

/** The managed rg binary name (Pi 0.83.0 getToolPath naming). */
const RG_BINARY_NAME = `rg${process.platform === "win32" ? ".exe" : ""}`;

/**
 * Resolve the existing managed rg under the Pi agent bin dir:
 * `PI_CODING_AGENT_DIR` (tilde-expanded) or `~/.pi/agent`, then
 * `bin/rg[.exe]` — exactly Pi 0.83.0's `getAgentDir()`/`getBinDir()`
 * layout. Returns the managed path when the file exists, else null.
 * Injectable env/homeDir for tests.
 */
export function managedRgPath(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string | null {
	const envDir = env.PI_CODING_AGENT_DIR;
	const agentDir = envDir ? nativeNormalizePath(envDir) : join(homeDir, ".pi", "agent");
	const candidate = join(agentDir, "bin", RG_BINARY_NAME);
	return existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the rg binary for the count scan: the managed binary first
 * (`managedRgPath`), then the system `rg` on the injected env's PATH
 * (probed the same way as Pi 0.83.0's `commandExists` — a spawn of
 * `rg --version` that did not fail with ENOENT). Returns null when neither
 * exists — the caller must fail explicitly; this adapter NEVER downloads
 * and NEVER writes.
 */
export function resolveRgPath(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string | null {
	const managed = managedRgPath(env, homeDir);
	if (managed !== null) return managed;
	const probe = spawnSync("rg", ["--version"], { stdio: "ignore", env });
	if (probe.error === undefined || probe.error === null) return "rg";
	return null;
}

// ---------------------------------------------------------------------------
// Path resolution (Pi 0.83.0 resolveToCwd parity) and the argument vector
// ---------------------------------------------------------------------------

/**
 * Resolve a grep search path exactly like Pi 0.83.0's `resolveToCwd`:
 * unicode-space normalization, leading-`@` strip, tilde expansion, `file://`
 * decoding, absolute-vs-relative resolution against `cwd`. Injectable
 * homeDir for tilde tests.
 */
export function resolveGrepSearchPath(input: string, cwd: string, homeDir: string = homedir()): string {
	return nativeResolvePath(input, cwd, {
		normalizeUnicodeSpaces: true,
		stripAtPrefix: true,
		homeDir,
	});
}

/**
 * Build the count-mode argument vector — the built-in matches flag family
 * (`--color=never`, `--hidden`, optional `--ignore-case` / `--fixed-strings`
 * / `--glob <glob>`, then `--`, pattern, search path) with the matches
 * output flags replaced by the exact-count flags: `--count` (matching
 * lines) or `--count-matches` (all occurrences), plus `--with-filename
 * --null` so every per-file count record is NUL-framed and unambiguous.
 */
export function buildGrepCountArgs(
	request: { pattern: string; glob?: string; ignoreCase?: boolean; literal?: boolean; countKind: GrepCountKind },
	searchPath: string,
): string[] {
	const args = ["--color=never", "--hidden"];
	if (request.ignoreCase) args.push("--ignore-case");
	if (request.literal) args.push("--fixed-strings");
	if (request.glob) args.push("--glob", request.glob);
	args.push(request.countKind === "lines" ? "--count" : "--count-matches");
	args.push("--with-filename", "--null");
	args.push("--", request.pattern, searchPath);
	return args;
}

// ---------------------------------------------------------------------------
// Output parsing (NUL-framed per-file records)
// ---------------------------------------------------------------------------

export interface GrepPerFileCount {
	/** The file path as printed by rg (relative to the search path or the resolved file path). */
	file: string;
	/** The exact per-file count (occurrences or matching lines per count_kind). */
	count: number;
}

export interface ParseGrepCountOptions {
	/**
	 * Accept an optional CR immediately before the record-terminating LF
	 * (win32 tolerance). Defaults to `process.platform === "win32"`.
	 */
	acceptCrLf?: boolean;
}

/**
 * Parse rg's `--count/--count-matches --with-filename --null` stdout as a
 * strict sequential sequence of `path\0count\n` records:
 *
 *   - the path is ALL text up to the NUL (Unicode and embedded newlines are
 *     preserved verbatim); it must be nonempty and unique;
 *   - the count is an ASCII digit run representing a non-negative safe
 *     integer, terminated by LF (on win32 only, an optional CR before the
 *     LF is tolerated via `acceptCrLf`);
 *   - empty stdout is exactly zero records.
 *
 * Every malformed case — missing NUL, empty/duplicate path, missing/
 * non-digit/unsafe count, missing terminator, trailing junk — throws an
 * explicit error; a partial parse is never returned.
 */
export function parseGrepCountOutput(stdout: string, options: ParseGrepCountOptions = {}): GrepPerFileCount[] {
	const acceptCrLf = options.acceptCrLf ?? process.platform === "win32";
	const records: GrepPerFileCount[] = [];
	const seen = new Set<string>();
	let pos = 0;
	while (pos < stdout.length) {
		const nul = stdout.indexOf("\0", pos);
		if (nul === -1) {
			throw new Error(`Malformed rg count output: missing NUL after file path (at offset ${pos})`);
		}
		const file = stdout.slice(pos, nul);
		if (file.length === 0) {
			throw new Error("Malformed rg count output: empty file path");
		}
		if (seen.has(file)) {
			throw new Error(`Malformed rg count output: duplicate file path ${JSON.stringify(file)}`);
		}
		let end = nul + 1;
		while (end < stdout.length) {
			const code = stdout.charCodeAt(end);
			if (code < 0x30 || code > 0x39) break; // ASCII digits only
			end += 1;
		}
		const countToken = stdout.slice(nul + 1, end);
		if (countToken.length === 0) {
			throw new Error(`Malformed rg count output: missing count for file path ${JSON.stringify(file)}`);
		}
		if (end >= stdout.length) {
			throw new Error(`Malformed rg count output: missing line terminator after count for file path ${JSON.stringify(file)}`);
		}
		if (stdout[end] === "\r" && acceptCrLf) end += 1;
		if (end >= stdout.length) {
			throw new Error(`Malformed rg count output: missing line terminator after count for file path ${JSON.stringify(file)}`);
		}
		if (stdout[end] !== "\n") {
			throw new Error(`Malformed rg count output: invalid count ${JSON.stringify(countToken)} for file path ${JSON.stringify(file)}`);
		}
		const count = Number(countToken);
		if (!Number.isSafeInteger(count) || count < 0) {
			throw new Error(`Malformed rg count output: count out of range ${JSON.stringify(countToken)} for file path ${JSON.stringify(file)}`);
		}
		seen.add(file);
		records.push({ file, count });
		pos = end + 1;
	}
	return records;
}

// ---------------------------------------------------------------------------
// The abort-aware exact-count scan
// ---------------------------------------------------------------------------

/** The grep count scan request (legacy limit/context are never applied). */
export interface GrepCountRequest {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	countKind: GrepCountKind;
}

/** Injectable execution environment (Pi-free; used by the registered override and the tests). */
export interface GrepCountEnvironment {
	/** The working directory the search path resolves against (ctx.cwd). */
	cwd: string;
	/** Optional abort signal — abort rejects `Operation aborted`, never a partial count. */
	signal?: AbortSignal;
	/** Process env for the managed-rg resolution (default process.env). */
	env?: NodeJS.ProcessEnv;
	/** Home dir for the managed-rg and tilde resolution (default os.homedir()). */
	homeDir?: string;
	/** Explicit rg binary override (tests); defaults to resolveRgPath(). */
	rgPath?: string;
}

export interface GrepCountResult {
	/** Sum of the exact per-file counts over the FULL scan (never capped). */
	value: number;
	/** Distinct files with at least one match. */
	files: number;
}

/**
 * Run the exact uncapped count scan with the installed ripgrep engine.
 * Direct argument-vector execution only (shell:false); abort-aware;
 * explicit failures only — a partial count is never returned.
 */
export async function runGrepCount(request: GrepCountRequest, options: GrepCountEnvironment): Promise<GrepCountResult> {
	if (options.signal?.aborted) throw new Error("Operation aborted");
	const searchPath = resolveGrepSearchPath(request.path ?? ".", options.cwd, options.homeDir);
	const rgPath = options.rgPath ?? resolveRgPath(options.env, options.homeDir);
	if (rgPath === null) {
		throw new Error("ripgrep (rg) is not available");
	}
	try {
		await stat(searchPath);
	} catch {
		throw new Error(`Path not found: ${searchPath}`);
	}
	const args = buildGrepCountArgs(request, searchPath);
	return new Promise<GrepCountResult>((resolve, reject) => {
		let settled = false;
		const settle = (fn: () => void): void => {
			if (!settled) {
				settled = true;
				fn();
			}
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
		} catch (error) {
			settle(() => reject(new Error(`Failed to run ripgrep: ${(error as Error).message}`)));
			return;
		}
		const stdoutChunks: Buffer[] = [];
		let stderr = "";
		const onAbort = (): void => {
			if (!child.killed) child.kill();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		// stdio is explicitly ["ignore", "pipe", "pipe"], so both streams exist.
		// Buffers are accumulated and decoded ONCE at close, so a UTF-8
		// sequence split across a chunk boundary can never corrupt a path.
		child.stdout!.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			options.signal?.removeEventListener("abort", onAbort);
			settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
		});
		child.on("close", (code) => {
			options.signal?.removeEventListener("abort", onAbort);
			if (options.signal?.aborted) {
				settle(() => reject(new Error("Operation aborted")));
				return;
			}
			if (code !== 0 && code !== 1) {
				const detail = stderr.trim();
				settle(() => reject(new Error(`ripgrep failed with exit code ${String(code)}${detail.length > 0 ? `: ${detail}` : ""}`)));
				return;
			}
			try {
				const records = parseGrepCountOutput(Buffer.concat(stdoutChunks).toString("utf8"));
				const value = records.reduce((sum, record) => sum + record.count, 0);
				settle(() => resolve({ value, files: records.length }));
			} catch (error) {
				settle(() => reject(error as Error));
			}
		});
	});
}
