import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { delegationsDir, isValidDelegationId, readDelegationLedger } from "./delegation-ledger.ts";
import { readJsonFileBounded } from "./bounded-file-io.ts";
import { runsDir } from "./config.ts";
import { isValidRunId, RUN_JSON_INPUT_MAX_BYTES } from "./runs.ts";
import { ARTIFACT_MANIFEST_FILE } from "./artifact-contract.ts";
import { RUN_COMMIT_FILE } from "./run-transaction.ts";

export const GOVERNANCE_ROLLBACK_MAX_ENTRIES = 10_000 as const;
export const GOVERNANCE_ROLLBACK_MAX_SAMPLES = 32 as const;

export type GovernanceRollbackBlocker =
	| "V2_DELEGATION_AUTHORITY_PRESENT"
	| "V2_RUN_AUTHORITY_PRESENT"
	| "UNCLASSIFIED_DELEGATION_AUTHORITY"
	| "UNCLASSIFIED_RUN_AUTHORITY"
	| "INVENTORY_UNAVAILABLE"
	| "INVENTORY_LIMIT_EXCEEDED";

export interface GovernanceRollbackCounts {
	legacy_v1: number;
	v2: number;
	unclassified: number;
}

export interface GovernanceRollbackSample {
	domain: "delegation" | "run";
	id: string;
	classification: "v2" | "unclassified";
}

export interface GovernanceRollbackReport {
	read_only: true;
	safe_for_v1_rollback: boolean;
	delegations: GovernanceRollbackCounts;
	runs: GovernanceRollbackCounts;
	blockers: GovernanceRollbackBlocker[];
	samples: GovernanceRollbackSample[];
}

type Classification = "legacy_v1" | "v2" | "unclassified";

function emptyCounts(): GovernanceRollbackCounts {
	return { legacy_v1: 0, v2: 0, unclassified: 0 };
}

function addBlocker(blockers: Set<GovernanceRollbackBlocker>, domain: "delegation" | "run", classification: Classification): void {
	if (classification === "v2") blockers.add(domain === "delegation" ? "V2_DELEGATION_AUTHORITY_PRESENT" : "V2_RUN_AUTHORITY_PRESENT");
	if (classification === "unclassified") blockers.add(domain === "delegation" ? "UNCLASSIFIED_DELEGATION_AUTHORITY" : "UNCLASSIFIED_RUN_AUTHORITY");
}

async function boundedEntries(root: string): Promise<{ ok: true; entries: Dirent<string>[] } | { ok: false; code: "unavailable" | "limit" }> {
	try {
		const stat = await lstat(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, code: "unavailable" };
		const entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
		entries.sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1);
		return entries.length <= GOVERNANCE_ROLLBACK_MAX_ENTRIES
			? { ok: true, entries }
			: { ok: false, code: "limit" };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { ok: true, entries: [] }
			: { ok: false, code: "unavailable" };
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function classifyDelegation(projectRoot: string, entry: Dirent<string>): Promise<Classification> {
	if (!entry.isDirectory() || entry.isSymbolicLink()) return "unclassified";
	const root = join(delegationsDir(projectRoot), entry.name);
	try {
		const stat = await lstat(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return "unclassified";
		if (await pathExists(join(root, "v2"))) return "v2";
		return await readDelegationLedger(projectRoot, entry.name) === null ? "unclassified" : "legacy_v1";
	} catch {
		return "unclassified";
	}
}

async function classifyRun(projectRoot: string, entry: Dirent<string>): Promise<Classification> {
	if (!entry.isDirectory() || entry.isSymbolicLink()) return "unclassified";
	const root = join(runsDir(projectRoot), entry.name);
	try {
		const stat = await lstat(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return "unclassified";
		if (await pathExists(join(root, RUN_COMMIT_FILE)) || await pathExists(join(root, ARTIFACT_MANIFEST_FILE))) return "v2";
		const read = await readJsonFileBounded<Record<string, unknown>>(join(root, "manifest.json"), RUN_JSON_INPUT_MAX_BYTES);
		if (!read.ok) return "unclassified";
		const value = read.value.value;
		if (value.schema_version === 1 && value.run_transaction_schema_version === undefined) return "legacy_v1";
		if (value.schema_version === 2 || value.run_transaction_schema_version === 2) return "v2";
		return "unclassified";
	} catch {
		return "unclassified";
	}
}

/**
 * Read-only pre-deploy guard for rolling back to v1-only code. It never
 * creates, rewrites, quarantines, or deletes authority records.
 */
export async function inspectGovernanceRollback(projectRoot: string): Promise<GovernanceRollbackReport> {
	const delegations = emptyCounts();
	const runs = emptyCounts();
	const blockers = new Set<GovernanceRollbackBlocker>();
	const samples: GovernanceRollbackSample[] = [];
	try {
		const root = await lstat(projectRoot);
		if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("unsafe project root");
	} catch {
		return {
			read_only: true,
			safe_for_v1_rollback: false,
			delegations,
			runs,
			blockers: ["INVENTORY_UNAVAILABLE"],
			samples,
		};
	}
	const domains = [
		{ domain: "delegation" as const, root: delegationsDir(projectRoot), valid: isValidDelegationId, counts: delegations, classify: classifyDelegation },
		{ domain: "run" as const, root: runsDir(projectRoot), valid: isValidRunId, counts: runs, classify: classifyRun },
	];

	for (const item of domains) {
		const inventory = await boundedEntries(item.root);
		if (!inventory.ok) {
			blockers.add(inventory.code === "limit" ? "INVENTORY_LIMIT_EXCEEDED" : "INVENTORY_UNAVAILABLE");
			continue;
		}
		for (const entry of inventory.entries) {
			if (!item.valid(entry.name)) continue;
			const classification = await item.classify(projectRoot, entry);
			item.counts[classification] += 1;
			addBlocker(blockers, item.domain, classification);
			if (classification !== "legacy_v1" && samples.length < GOVERNANCE_ROLLBACK_MAX_SAMPLES) {
				samples.push({ domain: item.domain, id: entry.name, classification });
			}
		}
	}

	const ordered: GovernanceRollbackBlocker[] = [
		"V2_DELEGATION_AUTHORITY_PRESENT",
		"V2_RUN_AUTHORITY_PRESENT",
		"UNCLASSIFIED_DELEGATION_AUTHORITY",
		"UNCLASSIFIED_RUN_AUTHORITY",
		"INVENTORY_UNAVAILABLE",
		"INVENTORY_LIMIT_EXCEEDED",
	].filter((code) => blockers.has(code as GovernanceRollbackBlocker)) as GovernanceRollbackBlocker[];
	return {
		read_only: true,
		safe_for_v1_rollback: ordered.length === 0,
		delegations,
		runs,
		blockers: ordered,
		samples,
	};
}
