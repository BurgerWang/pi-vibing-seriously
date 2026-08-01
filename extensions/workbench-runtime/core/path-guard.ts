/**
 * Workbench path containment guard — pure logic, no Pi imports.
 *
 * Recipes must never read or write outside the project root. This module
 * enforces that with two layers:
 *
 *  1. Lexical containment — resolves the target against the root and rejects
 *     any path that escapes via `..` segments or absolute paths.
 *  2. Real-path containment — resolves symlinks (on the deepest existing
 *     ancestor of the target) so a symlink inside the project that points
 *     outside the project cannot be used to bypass the lexical check.
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Lexically resolve `target` (relative to the project root, or absolute) and
 * return the normalized absolute path only if it stays inside `root`.
 * Returns `undefined` when the target escapes the root.
 *
 * `resolve()` already eliminates `..` segments and ignores `root` for
 * absolute targets, so the remaining check is pure prefix containment.
 */
export function lexicalContain(root: string, target: string): string | undefined {
	const rootAbs = resolve(root);
	const targetAbs = resolve(rootAbs, target);
	if (targetAbs === rootAbs) return rootAbs;
	if (!targetAbs.startsWith(rootAbs + sep)) return undefined;
	return targetAbs;
}

async function realpathOrUndefined(p: string): Promise<string | undefined> {
	try {
		return await realpath(p);
	} catch {
		return undefined;
	}
}

/**
 * Resolve the real (symlink-free) path of `target`, walking up to the deepest
 * existing ancestor when parts of the path do not exist yet (e.g. files the
 * recipe is about to create).
 */
export async function realpathDeepest(target: string): Promise<string> {
	const suffix: string[] = [];
	let cur = target;
	for (;;) {
		const real = await realpathOrUndefined(cur);
		if (real !== undefined) return join(real, ...suffix);
		suffix.unshift(basename(cur));
		const parent = dirname(cur);
		if (parent === cur) return target; // nothing exists; fall back to lexical path
		cur = parent;
	}
}

/**
 * Resolve `target` (relative to `root` or absolute) with full symlink
 * resolution and return the real absolute path only if it is contained in the
 * real path of `root`. Returns `undefined` on any escape attempt.
 */
export async function realpathContained(root: string, target: string): Promise<string | undefined> {
	const lex = lexicalContain(root, target);
	if (lex === undefined) return undefined;
	const rootReal = (await realpathOrUndefined(root)) ?? resolve(root);
	const targetReal = await realpathDeepest(lex);
	if (targetReal === rootReal) return targetReal;
	if (!targetReal.startsWith(rootReal + sep)) return undefined;
	return targetReal;
}
