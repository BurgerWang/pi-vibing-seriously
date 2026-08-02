/**
 * P6-C command rendering — /q-cache-explain, /q-cache-prune,
 * /q-cache-clear output lines. Pure line building, no Pi imports.
 *
 * Privacy rules:
 *   - never prints env VALUES or argv values — names and hashes only
 *   - never prints per-file content hashes by default — changed input
 *     NAMES are listed (bounded), counts otherwise
 *   - action keys are printed in full (they are hashes, not secrets)
 */

import type { ActionRecord, ActionKeyComponents, InputEntry } from "./action-types.ts";
import type { StoreStats } from "./action-store.ts";
import { compareInputEntrySets } from "./action-key.ts";
import { canonicalHash } from "./canonical-hash.ts";

export type ExplainStatus = "hit" | "miss" | "expired" | "artifacts-disabled" | "corrupt" | "refused" | "disabled" | "no-cache";

export interface ExplainFacts {
	recipeName: string;
	cacheEnabled: boolean;
	mode: string;
	requestMode: string;
	status: ExplainStatus;
	reason?: string;
	key?: string;
	components: ActionKeyComponents | null;
	currentEntries: InputEntry[];
	record: ActionRecord | null;
	previousRecord: ActionRecord | null;
	maxBytes: number;
	stats: StoreStats;
}

const KB = 1024;
const MB = 1024 * 1024;

export function formatBytes(n: number): string {
	if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
	if (n >= KB) return `${(n / KB).toFixed(1)} KB`;
	return `${n} B`;
}

/** Classify what changed between the current key and a previous record. */
export function classifyChanges(current: ActionKeyComponents, previous: ActionRecord, currentEntries: InputEntry[]): string[] {
	const changes: string[] = [];
	if (current.recipeDefinitionHash !== previous.definitionHash) changes.push("recipe definition");
	if (current.cachePolicyHash !== previous.cachePolicyHash) changes.push("cache policy");
	if (current.inputMerkleHash !== previous.inputMerkleHash) {
		const diff = compareInputEntrySets(currentEntries, previous.inputEntries);
		if (diff.same) changes.push("declared inputs (structure changed, files unchanged)");
		else {
			const parts = [`declared inputs (${diff.changed} changed, ${diff.added} added, ${diff.removed} removed)`];
			if (diff.names.length > 0) parts.push(`e.g. ${diff.names.join(", ")}`);
			changes.push(parts.join(": "));
		}
	}
	if (current.argvHash !== previous.argvHash) changes.push("argv");
	if (current.normalizedCwd !== previous.cwd) changes.push("cwd");
	if (current.allowedMode !== previous.allowedMode) changes.push("mode");
	if (current.environmentHash !== environmentHashFromRecord(previous)) changes.push("declared environment");
	if (current.operatingSystem !== previous.os || current.architecture !== previous.arch) changes.push("OS/architecture");
	if (current.workbenchConfigHash !== previous.workbenchConfigHash) changes.push("workbench config");
	if (current.profileHash !== previous.profileHash) changes.push("profile");
	if (current.gateSchemaHash !== previous.gateSchemaHash) changes.push("gate schema");
	if (current.upstreamActionKeys.join(",") !== previous.upstreamActionKeys.join(",")) changes.push("upstream action keys");
	if (JSON.stringify(current.lockfileHashes) !== JSON.stringify(previous.lockfileHashes)) {
		const changedLockfiles = Object.keys(current.lockfileHashes).filter((name) => current.lockfileHashes[name] !== previous.lockfileHashes[name]);
		changes.push(`lockfiles (${changedLockfiles.join(", ") || "set changed"})`);
	}
	const toolchainChanged = Object.keys({ ...current.toolchainVersions, ...previous.toolchainVersions }).filter(
		(tool) => current.toolchainVersions[tool] !== previous.toolchainVersions[tool],
	);
	if (toolchainChanged.length > 0) changes.push(`toolchain (${toolchainChanged.join(", ")})`);
	return changes;
}

function environmentHashFromRecord(record: ActionRecord): string {
	// The record stores per-name value hashes; rebuild the same canonical
	// form used by declaredEnvironmentHash so comparisons are exact.
	const sorted = [...new Set(Object.keys(record.envValueHashes))].sort();
	const values: Record<string, string> = {};
	for (const name of sorted) values[name] = record.envValueHashes[name] ?? "unset";
	return canonicalHash(values);
}

export function renderCacheExplain(facts: ExplainFacts): string[] {
	const lines: string[] = [];
	const c = facts.components;
	lines.push(`recipe        : ${facts.recipeName}`);
	lines.push(`cache policy  : ${facts.cacheEnabled ? `${facts.mode} (version ${c?.cachePolicyVersion ?? "?"}, successOnly=${facts.record ? "stored" : "policy"})` : "disabled"}`);
	lines.push(`request mode  : ${facts.requestMode}`);
	lines.push(`status        : ${facts.status.toUpperCase()}${facts.reason ? ` — ${facts.reason}` : ""}`);
	if (facts.key) lines.push(`action key    : ${facts.key}`);
	if (facts.record) {
		lines.push(
			`cached result : run ${facts.record.sourceRunId}, created ${facts.record.createdAt}, exit=${facts.record.exitCode}${facts.record.mode === "artifacts" ? ", artifacts restore disabled" : ""}`,
		);
	}
	if (facts.previousRecord && facts.components) {
		const changes = classifyChanges(facts.components, facts.previousRecord, facts.currentEntries);
		if (changes.length > 0) {
			lines.push(`changed since  : ${changes.join(" | ")}`);
		}
	}
	lines.push("", "action key components:");
	if (!c) {
		lines.push("  (not computed — cache disabled or refused)");
		return lines;
	}
	lines.push(`  schema/cache policy : ${c.cacheSchemaVersion}/${c.cachePolicyVersion}, package ${c.packageVersion}`);
	lines.push(`  recipe definition   : ${c.recipeDefinitionHash.slice(0, 16)}…`);
	lines.push(`  cache policy hash   : ${c.cachePolicyHash.slice(0, 16)}…`);
	lines.push(`  argv hash           : ${c.argvHash.slice(0, 16)}…`);
	lines.push(`  cwd                 : ${c.normalizedCwd}`);
	lines.push(`  mode                : ${c.allowedMode}`);
	lines.push(`  environment         : ${c.environmentHash.slice(0, 16)}… (${Object.keys(recordEnvNames(facts)).length} declared name(s); values hashed, never stored)`);
	lines.push(`  toolchain           : ${Object.entries(c.toolchainVersions).map(([t, v]) => `${t}=${v}`).join(", ") || "(none declared)"}`);
	lines.push(`  os/arch             : ${c.operatingSystem} / ${c.architecture}`);
	lines.push(`  lockfiles           : ${lockfileSummary(c)}`);
	lines.push(
		`  declared inputs     : ${c.inputMerkleHash.slice(0, 16)}… (${c.inputFacts.files} file(s), ${c.inputFacts.dirs} dir(s), ${c.inputFacts.symlinks} symlink(s), ${c.inputFacts.missingPatterns} missing pattern(s), ${c.inputFacts.protectedRefused} protected refused, ${formatBytes(c.inputFacts.totalBytes)})`,
	);
	lines.push(`  workbench config    : ${c.workbenchConfigHash.slice(0, 16)}…`);
	lines.push(`  profile             : ${c.profileHash.slice(0, 16)}…`);
	lines.push(`  gate schema         : ${c.gateSchemaHash.slice(0, 16)}…`);
	if (c.upstreamActionKeys.length > 0) {
		lines.push(`  upstream keys       : ${c.upstreamActionKeys.map((k) => k.slice(0, 12)).join(", ")}`);
	}
	lines.push(
		`  cache dir           : ${formatBytes(facts.stats.totalBytes)} in ${facts.stats.entries} record(s) (max ${formatBytes(facts.maxBytes)})`,
	);
	return lines;
}

function recordEnvNames(facts: ExplainFacts): Record<string, unknown> {
	if (facts.record) {
		const names: Record<string, unknown> = {};
		for (const name of facts.record.environmentNames) names[name] = true;
		return names;
	}
	return {};
}

function lockfileSummary(c: ActionKeyComponents): string {
	const present = Object.entries(c.lockfileHashes).filter(([, h]) => h !== "missing" && h !== "not-a-file");
	const changed = present.map(([name]) => name);
	return present.length === 0 ? "(none present)" : `${changed.join(", ")} (${present.length}/${Object.keys(c.lockfileHashes).length} known lockfiles present)`;
}

export function renderPrune(result: { dryRun: boolean; reclaimableBytes: number; keptBytes: number; totalBytes: number; removed: { key: string; recipe: string; sizeBytes: number }[]; skippedInUse: { key: string; recipe: string }[] }, maxBytes: number): string[] {
	const lines = [
		`action cache prune (${result.dryRun ? "dry-run — nothing deleted" : "applied"}):`,
		`  records scanned     : ${result.removed.length + result.skippedInUse.length} candidate(s) beyond the ${formatBytes(maxBytes)} budget`,
		`  reclaimable         : ${formatBytes(result.reclaimableBytes)}`,
		`  kept after prune    : ${formatBytes(result.keptBytes)}`,
	];
	for (const entry of result.removed.slice(0, 20)) {
		lines.push(`    - ${entry.recipe.padEnd(24)} ${formatBytes(entry.sizeBytes).padStart(10)}  ${entry.key.slice(0, 16)}…`);
	}
	if (result.removed.length > 20) lines.push(`    … and ${result.removed.length - 20} more`);
	for (const entry of result.skippedInUse) {
		lines.push(`    ~ ${entry.recipe} (skipped: in use)`);
	}
	lines.push("", "runs/ and evidence are never touched by pruning.");
	return lines;
}

export function renderClear(result: { removed: number; recipe: string | "all" }): string[] {
	return [
		`action cache clear (${result.recipe}): ${result.removed} record(s) removed`,
		"runs/ and evidence are never touched by clearing.",
	];
}
