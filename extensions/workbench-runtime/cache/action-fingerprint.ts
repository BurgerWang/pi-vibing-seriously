/**
 * P6-C input fingerprinting — deterministic content fingerprint of a
 * recipe's DECLARED inputs.
 *
 * Rules (docs/cache/action-cache.md):
 *   - paths are project-relative POSIX form; patterns are stable-sorted
 *   - regular files: relative path + executable bit + streaming SHA-256
 *     content hash (never mtime / size alone)
 *   - directories: recursive Merkle hash (sorted children, dir hash =
 *     SHA-256 of the canonical child summary)
 *   - symlinks: every symlink is a fingerprint error (cache refused, normal
 *     execution); the scanner never follows a link or reads its target
 *   - a pattern with no matches is an explicit key component ("missing")
 *   - protected secret paths (.env, *.pem, *.key, credentials.*, ...) are
 *     NEVER read — they enter the key as {t:"protected"} markers
 *   - input count / total size / depth are bounded; on overflow the
 *     fingerprint fails closed (cache refused, normal execution)
 *   - `touch` (mtime change without content change) does not change the
 *     fingerprint
 */

import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";

import { matchProtectedPath } from "../core/path-policy.ts";
import { canonicalJson, sha256Hex } from "./canonical-hash.ts";
import {
	MAX_INPUT_DEPTH,
	MAX_INPUT_ENTRIES,
	MAX_INPUT_FILE_BYTES,
	MAX_INPUT_TOTAL_BYTES,
	type InputEntry,
	type InputFacts,
} from "./action-types.ts";

/** Thrown when the fingerprint cannot be computed safely (cache refused). */
export class FingerprintError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FingerprintError";
	}
}

export interface Fingerprint {
	merkleHash: string;
	entries: InputEntry[];
	facts: InputFacts;
}

export interface FingerprintIoHooks {
	/** Test-only fault seam; production never mutates a fingerprinted path. */
	afterFileOpenStat?: (path: string) => void | Promise<void>;
}

interface Stats {
	entries: number;
	discovered: number;
	files: number;
	dirs: number;
	symlinks: number;
	bytes: number;
	protected: number;
}

function consumeDiscovery(stats: Stats, description: string): void {
	stats.discovered += 1;
	if (stats.discovered > MAX_INPUT_ENTRIES) {
		throw new FingerprintError(`input glob discovery exceeds the ${MAX_INPUT_ENTRIES}-entry limit while inspecting ${description}`);
	}
}

function consumeEntry(stats: Stats, description: string): void {
	stats.entries += 1;
	if (stats.entries > MAX_INPUT_ENTRIES) {
		throw new FingerprintError(
			`declared inputs exceed the ${MAX_INPUT_ENTRIES}-entry limit while inspecting ${description}`,
		);
	}
}

function posix(relPath: string): string {
	return relPath.split(sep).join("/");
}

/** Streaming SHA-256 from the already-open, bounded file description. */
async function streamHash(handle: FileHandle, expectedBytes: number): Promise<string> {
	const hash = createHash("sha256");
	if (expectedBytes === 0) return hash.digest("hex");
	await new Promise<void>((resolvePromise, reject) => {
		const stream = handle.createReadStream({ autoClose: false, start: 0, end: expectedBytes - 1 });
		stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
		stream.on("end", () => resolvePromise());
		stream.on("error", reject);
	});
	return hash.digest("hex");
}

function sameFileStats(left: Awaited<ReturnType<FileHandle["stat"]>>, right: Awaited<ReturnType<FileHandle["stat"]>>): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.mode === right.mode;
}

/**
 * Hash one regular file: content hash + executable bit. The caller has
 * already rejected symlink path components; O_NOFOLLOW protects the leaf.
 */
async function hashFileContent(absPath: string, stats: Stats, depth: number, hooks?: FingerprintIoHooks): Promise<{ h: string; x: 0 | 1 }> {
	if (depth > MAX_INPUT_DEPTH) throw new FingerprintError(`input nesting deeper than ${MAX_INPUT_DEPTH} levels`);
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	let handle: FileHandle;
	try {
		handle = await open(absPath, constants.O_RDONLY | noFollow);
	} catch (error) {
		throw new FingerprintError(`cannot open input file "${absPath}" without following symlinks: ${(error as Error).message}`);
	}
	try {
		const initial = await handle.stat();
		if (!initial.isFile()) throw new FingerprintError(`input "${absPath}" is not a regular file`);
		if (initial.size > MAX_INPUT_FILE_BYTES) throw new FingerprintError(`input file "${absPath}" exceeds the ${MAX_INPUT_FILE_BYTES}-byte per-file limit`);
		if (stats.bytes + initial.size > MAX_INPUT_TOTAL_BYTES) throw new FingerprintError(`declared inputs exceed the ${MAX_INPUT_TOTAL_BYTES}-byte total limit`);
		await hooks?.afterFileOpenStat?.(absPath);
		const h = await streamHash(handle, initial.size);
		const final = await handle.stat();
		let pathNow;
		try { pathNow = await lstat(absPath); }
		catch { throw new FingerprintError(`input file "${absPath}" changed path identity during hashing`); }
		if (!sameFileStats(initial, final) || pathNow.isSymbolicLink() || pathNow.dev !== initial.dev || pathNow.ino !== initial.ino) {
			throw new FingerprintError(`input file "${absPath}" changed identity or contents during hashing`);
		}
		stats.bytes += initial.size;
		stats.files += 1;
		const x: 0 | 1 = (initial.mode & 0o111) !== 0 ? 1 : 0;
		return { h, x };
	} finally {
		await handle.close().catch(() => {});
	}
}

/**
 * Inspect path components from the trusted project root outward. Each lstat
 * happens before descending to the next component, so an ancestor symlink is
 * rejected without resolving through it or reading its target.
 */
async function assertNoSymlinkPath(absPath: string, rootAbs: string): Promise<boolean> {
	const rel = relative(rootAbs, absPath);
	if (rel === "" || rel === ".") return true;
	if (rel === ".." || rel.startsWith(`..${sep}`)) throw new FingerprintError(`input path "${absPath}" escapes the project root`);
	let current = rootAbs;
	for (const component of rel.split(sep)) {
		current = join(current, component);
		let info;
		try {
			info = await lstat(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw new FingerprintError(`cannot inspect input path component "${current}": ${(error as Error).message}`);
		}
		if (info.isSymbolicLink()) {
			throw new FingerprintError(`input path "${absPath}" contains a symlink — cache refused without following it`);
		}
	}
	return true;
}

const GLOB_META_RE = /[*?\[\]{}()]/;

/**
 * Bounded lstat/opendir glob discovery. Unlike fs.glob, this walker checks
 * every path component before descent and rejects a symlink Dirent without
 * ever opening its target directory.
 */
async function safeGlobMatches(rootAbs: string, pattern: string, stats: Stats): Promise<string[]> {
	const normalized = posix(pattern).replace(/^\.\//, "");
	if (normalized.length === 0 || isAbsolute(pattern) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new FingerprintError(`invalid input glob "${pattern}"`);
	}
	const parts = normalized.split("/");
	const firstMeta = parts.findIndex((part) => GLOB_META_RE.test(part));
	const literalPrefix = firstMeta < 0 ? normalized : parts.slice(0, firstMeta).join("/");
	const startRel = literalPrefix || ".";
	const startAbs = startRel === "." ? rootAbs : join(rootAbs, ...startRel.split("/"));
	if (!(await assertNoSymlinkPath(startAbs, rootAbs))) return [];

	const matches: string[] = [];
	const walk = async (absPath: string, relPath: string, depth: number): Promise<void> => {
		if (depth > MAX_INPUT_DEPTH) throw new FingerprintError(`input glob nesting deeper than ${MAX_INPUT_DEPTH} levels`);
		let info;
		try { info = await lstat(absPath); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw new FingerprintError(`cannot inspect glob path "${relPath}": ${(error as Error).message}`);
		}
		if (info.isSymbolicLink()) throw new FingerprintError(`symlink "${relPath}" is not cacheable — glob discovery refused without following it`);
		if (relPath !== ".") {
			consumeDiscovery(stats, `glob path "${relPath}"`);
			let matched = false;
			try { matched = matchesGlob(relPath, normalized); }
			catch (error) { throw new FingerprintError(`invalid input glob "${pattern}": ${(error as Error).message}`); }
			if (matched) matches.push(relPath);
		}
		if (!info.isDirectory()) return;
		let directory;
		try { directory = await opendir(absPath); }
		catch (error) { throw new FingerprintError(`cannot read glob directory "${relPath}": ${(error as Error).message}`); }
		for await (const child of directory) {
			const childRel = relPath === "." ? child.name : `${relPath}/${child.name}`;
			if (child.isSymbolicLink()) throw new FingerprintError(`symlink "${childRel}" is not cacheable — glob discovery refused without following it`);
			await walk(join(absPath, child.name), childRel, depth + 1);
		}
	};

	await walk(startAbs, startRel, 0);
	return matches.sort();
}

/**
 * Recursively hash a directory (sorted children; dir hash = SHA-256 of the
 * canonical child summary). Returns the set of covered child paths so the
 * caller can dedupe overlapping patterns.
 */
async function hashDirectory(
	absPath: string,
	relPath: string,
	rootAbs: string,
	stats: Stats,
	depth: number,
	covered: Set<string>,
	hooks?: FingerprintIoHooks,
): Promise<{ h: string; covered: Set<string> }> {
	if (depth > MAX_INPUT_DEPTH) throw new FingerprintError(`input nesting deeper than ${MAX_INPUT_DEPTH} levels`);
	await assertNoSymlinkPath(absPath, rootAbs);
	let children: Dirent[] = [];
	try {
		const directory = await opendir(absPath);
		for await (const child of directory) {
			consumeEntry(stats, `directory entry "${posix(join(relPath, child.name))}"`);
			children.push(child);
		}
	} catch (error) {
		if (error instanceof FingerprintError) throw error;
		throw new FingerprintError(`cannot read input directory "${absPath}": ${(error as Error).message}`);
	}
	children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const summaries: Array<{ n: string; t: string; h: string; x?: 0 | 1 }> = [];
	const myCovered = new Set<string>();
	for (const child of children) {
		const childRel = posix(join(relPath, child.name));
		const childAbs = join(absPath, child.name);
		if (child.isSymbolicLink()) {
			stats.symlinks += 1;
			throw new FingerprintError(`symlink "${childRel}" is not cacheable — cache refused without following it`);
		}
		const protectedMatch = matchProtectedPath(childRel);
		if (protectedMatch) {
			stats.protected += 1;
			summaries.push({ n: child.name, t: "protected", h: "refused" });
			myCovered.add(childRel);
			continue;
		}
		if (child.isDirectory()) {
			const sub = await hashDirectory(childAbs, childRel, rootAbs, stats, depth + 1, covered, hooks);
			summaries.push({ n: child.name, t: "dir", h: sub.h });
			for (const c of sub.covered) myCovered.add(c);
			myCovered.add(childRel);
			continue;
		}
		if (child.isFile()) {
			await assertNoSymlinkPath(childAbs, rootAbs);
			const { h, x } = await hashFileContent(childAbs, stats, depth + 1, hooks);
			summaries.push({ n: child.name, t: "file", h, x });
			myCovered.add(childRel);
			continue;
		}
		// sockets/fifos/devices: refuse — contents are not stable.
		throw new FingerprintError(`input "${childRel}" is a special file (${child.isFIFO() ? "fifo" : child.isSocket() ? "socket" : child.isCharacterDevice() ? "char device" : "block device"}) — cache refused`);
	}
	stats.dirs += 1;
	return { h: sha256Hex(canonicalJson(summaries)), covered: myCovered };
}

/** True when a path is covered by an already-hashed ancestor directory. */
function coveredByAncestor(relPath: string, covered: Set<string>): boolean {
	const parts = relPath.split("/");
	for (let i = parts.length - 1; i >= 1; i -= 1) {
		if (covered.has(parts.slice(0, i).join("/"))) return true;
	}
	return false;
}

/**
 * Fingerprint the declared input globs of a recipe.
 * @param projectRoot  trusted project root (absolute)
 * @param patterns     declared input globs (project-relative POSIX)
 * @returns fingerprint with merkle hash, flat entry list and facts
 * @throws FingerprintError — cache must be refused (never blocks execution)
 */
export async function fingerprintInputs(projectRoot: string, patterns: readonly string[], hooks?: FingerprintIoHooks): Promise<Fingerprint> {
	const rootAbs = resolve(projectRoot);
	const stats: Stats = { entries: 0, discovered: 0, files: 0, dirs: 0, symlinks: 0, bytes: 0, protected: 0 };
	const covered = new Set<string>();
	const entries: InputEntry[] = [];

	const sortedPatterns = [...new Set(patterns)].sort();
	for (const pattern of sortedPatterns) {
		const matches = await safeGlobMatches(rootAbs, pattern, stats);
		if (matches.length === 0) {
			// A pattern with no match is an explicit key component.
			consumeEntry(stats, `missing pattern "${pattern}"`);
			entries.push({ p: pattern, t: "missing", h: "missing" });
			continue;
		}
		for (const match of matches) {
			if (covered.has(match) || coveredByAncestor(match, covered)) continue;
			consumeEntry(stats, `matched input "${match}"`);
			const abs = join(rootAbs, ...match.split("/"));
			let info;
			try {
				info = await lstat(abs);
			} catch (error) {
				throw new FingerprintError(`cannot lstat input "${match}": ${(error as Error).message}`);
			}
			if (info.isSymbolicLink()) {
				stats.symlinks += 1;
				throw new FingerprintError(`symlink "${match}" is not cacheable — cache refused without following it`);
			}
			await assertNoSymlinkPath(abs, rootAbs);
			const protectedMatch = matchProtectedPath(match);
			if (protectedMatch) {
				stats.protected += 1;
				entries.push({ p: match, t: "protected", h: "refused" });
				covered.add(match);
				continue;
			}
			if (info.isDirectory()) {
				const sub = await hashDirectory(abs, match, rootAbs, stats, 0, covered, hooks);
				entries.push({ p: match, t: "dir", h: sub.h });
				for (const c of sub.covered) covered.add(c);
				covered.add(match);
				continue;
			}
			if (info.isFile()) {
				const { h, x } = await hashFileContent(abs, stats, 0, hooks);
				entries.push({ p: match, t: "file", h, x });
				covered.add(match);
				continue;
			}
			throw new FingerprintError(`input "${match}" is a special file — cache refused`);
		}
	}

	entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
	const facts: InputFacts = {
		files: stats.files,
		dirs: stats.dirs,
		symlinks: stats.symlinks,
		missingPatterns: entries.filter((e) => e.t === "missing").length,
		protectedRefused: stats.protected,
		totalBytes: stats.bytes,
		truncated: false,
	};
	return {
		merkleHash: sha256Hex(canonicalJson(entries)),
		entries,
		facts,
	};
}

/** Bound the flat entry list for record storage (diffs stay bounded). */
export function capInputEntries(entries: readonly InputEntry[], max: number): InputEntry[] {
	if (entries.length <= max) return [...entries];
	return entries.slice(0, max);
}
