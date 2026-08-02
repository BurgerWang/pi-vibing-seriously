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
 *   - symlinks: real path resolved; escapes OUTSIDE the project root are a
 *     fingerprint error (cache refused, normal execution); in-project
 *     symlinks record the link target and the target's content hash
 *   - a pattern with no matches is an explicit key component ("missing")
 *   - protected secret paths (.env, *.pem, *.key, credentials.*, ...) are
 *     NEVER read — they enter the key as {t:"protected"} markers
 *   - input count / total size / depth are bounded; on overflow the
 *     fingerprint fails closed (cache refused, normal execution)
 *   - `touch` (mtime change without content change) does not change the
 *     fingerprint
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { globSync } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { matchProtectedPath } from "../core/path-policy.ts";
import { canonicalJson, sha256Hex } from "./canonical-hash.ts";
import {
	MAX_INPUT_DEPTH,
	MAX_INPUT_FILE_BYTES,
	MAX_INPUT_FILES,
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

interface Stats {
	files: number;
	dirs: number;
	symlinks: number;
	bytes: number;
	protected: number;
}

function posix(relPath: string): string {
	return relPath.split(sep).join("/");
}

/** Streaming SHA-256 of a file's content (bounded by caller checks). */
async function streamHash(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolvePromise, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
		stream.on("end", () => resolvePromise());
		stream.on("error", reject);
	});
	return hash.digest("hex");
}

/**
 * Hash one file (or symlink target): content hash + executable bit.
 * `bytesRef` accumulates total bytes for the global limit.
 */
async function hashFileContent(absPath: string, stats: Stats, depth: number): Promise<{ h: string; x: 0 | 1 }> {
	if (depth > MAX_INPUT_DEPTH) throw new FingerprintError(`input nesting deeper than ${MAX_INPUT_DEPTH} levels`);
	let info;
	try {
		info = await stat(absPath);
	} catch (error) {
		throw new FingerprintError(`cannot stat input file "${absPath}": ${(error as Error).message}`);
	}
	if (!info.isFile()) {
		throw new FingerprintError(`input "${absPath}" is not a regular file (type: ${info.isDirectory() ? "directory" : "special"})`);
	}
	if (info.size > MAX_INPUT_FILE_BYTES) {
		throw new FingerprintError(`input file "${absPath}" exceeds the ${MAX_INPUT_FILE_BYTES}-byte per-file limit`);
	}
	if (stats.bytes + info.size > MAX_INPUT_TOTAL_BYTES) {
		throw new FingerprintError(`declared inputs exceed the ${MAX_INPUT_TOTAL_BYTES}-byte total limit`);
	}
	stats.bytes += info.size;
	stats.files += 1;
	if (stats.files > MAX_INPUT_FILES) {
		throw new FingerprintError(`declared inputs exceed the ${MAX_INPUT_FILES}-file limit`);
	}
	const h = await streamHash(absPath);
	const x: 0 | 1 = (info.mode & 0o111) !== 0 ? 1 : 0;
	return { h, x };
}

/**
 * Hash a symlink: resolve the real path, verify containment in the project
 * root, hash the target content. A symlink escaping the root is a
 * FingerprintError (cache refused — the recipe may read outside the
 * project, so its result must never be reused).
 */
async function hashSymlink(absPath: string, rootReal: string, stats: Stats, depth: number): Promise<{ target: string; h: string }> {
	let target;
	try {
		target = await readlink(absPath);
	} catch (error) {
		throw new FingerprintError(`cannot read symlink "${absPath}": ${(error as Error).message}`);
	}
	let real: string;
	try {
		real = await realpath(absPath);
	} catch (error) {
		throw new FingerprintError(`cannot resolve symlink "${absPath}": ${(error as Error).message}`);
	}
	if (real !== rootReal && !real.startsWith(rootReal + sep)) {
		throw new FingerprintError(
			`symlink "${absPath}" resolves outside the project root (${real}) — cache refused`,
		);
	}
	let info;
	try {
		info = await lstat(real);
	} catch (error) {
		throw new FingerprintError(`cannot stat symlink target "${real}": ${(error as Error).message}`);
	}
	if (info.isDirectory()) {
		throw new FingerprintError(
			`symlink "${absPath}" points at a directory — directory symlinks are not cacheable in this version`,
		);
	}
	if (info.size > MAX_INPUT_FILE_BYTES) {
		throw new FingerprintError(`symlink target "${real}" exceeds the ${MAX_INPUT_FILE_BYTES}-byte per-file limit`);
	}
	if (stats.bytes + info.size > MAX_INPUT_TOTAL_BYTES) {
		throw new FingerprintError(`declared inputs exceed the ${MAX_INPUT_TOTAL_BYTES}-byte total limit`);
	}
	stats.bytes += info.size;
	stats.symlinks += 1;
	const h = await streamHash(real);
	return { target, h };
}

/**
 * Recursively hash a directory (sorted children; dir hash = SHA-256 of the
 * canonical child summary). Returns the set of covered child paths so the
 * caller can dedupe overlapping patterns.
 */
async function hashDirectory(
	absPath: string,
	relPath: string,
	rootReal: string,
	stats: Stats,
	depth: number,
	covered: Set<string>,
): Promise<{ h: string; covered: Set<string> }> {
	if (depth > MAX_INPUT_DEPTH) throw new FingerprintError(`input nesting deeper than ${MAX_INPUT_DEPTH} levels`);
	let children;
	try {
		children = await readdir(absPath, { withFileTypes: true });
	} catch (error) {
		throw new FingerprintError(`cannot read input directory "${absPath}": ${(error as Error).message}`);
	}
	children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const summaries: Array<{ n: string; t: string; h: string; x?: 0 | 1 }> = [];
	const myCovered = new Set<string>();
	for (const child of children) {
		const childRel = posix(join(relPath, child.name));
		const childAbs = join(absPath, child.name);
		const protectedMatch = matchProtectedPath(childRel);
		if (protectedMatch) {
			stats.protected += 1;
			summaries.push({ n: child.name, t: "protected", h: "refused" });
			myCovered.add(childRel);
			continue;
		}
		if (child.isSymbolicLink()) {
			const { h } = await hashSymlink(childAbs, rootReal, stats, depth + 1);
			summaries.push({ n: child.name, t: "symlink", h });
			myCovered.add(childRel);
			continue;
		}
		if (child.isDirectory()) {
			const sub = await hashDirectory(childAbs, childRel, rootReal, stats, depth + 1, covered);
			summaries.push({ n: child.name, t: "dir", h: sub.h });
			for (const c of sub.covered) myCovered.add(c);
			myCovered.add(childRel);
			continue;
		}
		if (child.isFile()) {
			const { h, x } = await hashFileContent(childAbs, stats, depth + 1);
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
 *
 * @param projectRoot  trusted project root (absolute)
 * @param patterns     declared input globs (project-relative POSIX)
 * @returns fingerprint with merkle hash, flat entry list and facts
 * @throws FingerprintError — cache must be refused (never blocks execution)
 */
export async function fingerprintInputs(projectRoot: string, patterns: readonly string[]): Promise<Fingerprint> {
	const rootAbs = resolve(projectRoot);
	const rootReal = (await realpath(rootAbs).catch(() => rootAbs)) ?? rootAbs;
	const stats: Stats = { files: 0, dirs: 0, symlinks: 0, bytes: 0, protected: 0 };
	const covered = new Set<string>();
	const entries: InputEntry[] = [];

	const sortedPatterns = [...new Set(patterns)].sort();
	for (const pattern of sortedPatterns) {
		let matches: string[];
		try {
			matches = globSync(pattern, { cwd: rootAbs }).map(posix).sort();
		} catch (error) {
			throw new FingerprintError(`invalid input glob "${pattern}": ${(error as Error).message}`);
		}
		if (matches.length === 0) {
			// A pattern with no match is an explicit key component.
			entries.push({ p: pattern, t: "missing", h: "missing" });
			continue;
		}
		for (const match of matches) {
			if (covered.has(match) || coveredByAncestor(match, covered)) continue;
			const protectedMatch = matchProtectedPath(match);
			if (protectedMatch) {
				stats.protected += 1;
				entries.push({ p: match, t: "protected", h: "refused" });
				covered.add(match);
				continue;
			}
			const abs = join(rootAbs, ...match.split("/"));
			let info;
			try {
				info = await lstat(abs);
			} catch (error) {
				throw new FingerprintError(`cannot lstat input "${match}": ${(error as Error).message}`);
			}
			if (info.isSymbolicLink()) {
				const { target, h } = await hashSymlink(abs, rootReal, stats, 0);
				entries.push({ p: match, t: "symlink", h: sha256Hex(canonicalJson({ target, contentHash: h })) });
				covered.add(match);
				continue;
			}
			if (info.isDirectory()) {
				const sub = await hashDirectory(abs, match, rootReal, stats, 0, covered);
				entries.push({ p: match, t: "dir", h: sub.h });
				for (const c of sub.covered) covered.add(c);
				covered.add(match);
				continue;
			}
			if (info.isFile()) {
				const { h, x } = await hashFileContent(abs, stats, 0);
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
