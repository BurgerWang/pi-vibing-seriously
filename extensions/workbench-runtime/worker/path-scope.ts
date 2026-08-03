/** Realpath/symlink enforcement for delegated worker edit/write scopes. */

import { resolve, sep } from "node:path";

import { lexicalContain, realpathContained, realpathDeepest } from "../core/path-guard.ts";
import { isWorkerPathAllowed } from "../core/worker-policy.ts";

function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root + sep);
}

function parseRule(projectRoot: string, raw: string): { lexicalPath: string; subtree: boolean } | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const subtree = trimmed.endsWith("/**") || /[\\/]$/.test(trimmed);
	const withoutSuffix = trimmed.endsWith("/**") ? trimmed.slice(0, -3) : trimmed.replace(/[\\/]+$/, "");
	if (!withoutSuffix) return undefined;
	const lexicalPath = lexicalContain(projectRoot, withoutSuffix);
	return lexicalPath ? { lexicalPath, subtree } : undefined;
}

/**
 * Re-check a lexically approved path after resolving symlinks. Both the target
 * and its matching allowed rule must stay inside the real project root, and
 * subtree membership is evaluated against real paths as well.
 */
export async function isWorkerPathAllowedRealpath(
	projectRoot: string,
	candidatePath: string,
	allowedPaths: readonly string[],
): Promise<boolean> {
	if (!isWorkerPathAllowed(projectRoot, candidatePath, allowedPaths)) return false;
	const candidateReal = await realpathContained(projectRoot, candidatePath);
	if (!candidateReal) return false;
	const rootReal = await realpathDeepest(resolve(projectRoot));

	for (const raw of allowedPaths) {
		const rule = parseRule(projectRoot, raw);
		if (!rule) continue;
		const ruleReal = await realpathDeepest(rule.lexicalPath);
		if (!isInside(rootReal, ruleReal)) continue;
		if (candidateReal === ruleReal) return true;
		if (rule.subtree && isInside(ruleReal, candidateReal)) return true;
	}
	return false;
}
