import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { createDelegationLedger, readDelegationLedger } from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import { inspectGovernanceRollback } from "../extensions/workbench-runtime/core/governance-rollback.ts";
import { persistPreparedDelegationTransaction } from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { withTempDir } from "./helpers.ts";

const HASH = "a".repeat(64);

async function writeLegacyRun(root: string, runId: string): Promise<void> {
	const dir = join(root, CONFIG_DIR_NAME, "workbench", "runs", runId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "manifest.json"), JSON.stringify({
		schema_version: 1,
		run_id: runId,
		recipe: "legacy",
		started_at: "2026-08-20T10:00:00.000Z",
		finished_at: "2026-08-20T10:00:01.000Z",
		duration_ms: 1000,
		exit_code: 0,
		timed_out: false,
		cancelled: false,
		artifact_paths: [],
	}), "utf8");
}

async function writeLegacyDelegation(root: string, delegationId: string): Promise<void> {
	const created = await createDelegationLedger(root, delegationId, {
		task: "legacy read-only fixture",
		allowedPaths: ["src/**"],
		acceptanceCriteria: ["readable"],
		verification: [],
		timeoutSeconds: 60,
	}, {
		gitHead: null,
		gitDirty: false,
		changedPaths: [],
		pathStatuses: {},
		pathDigests: {},
	}, "2026-08-20T10:00:00.000Z");
	assert.equal(created.ok, true);
}

async function tree(root: string, prefix = ""): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(join(root, prefix), { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		out.push(path);
		if (entry.isDirectory()) out.push(...await tree(root, path));
	}
	return out;
}

test("rollback inspection is read-only and allows a pure legacy v1 corpus", async () => {
	await withTempDir(async (root) => {
		const delegationId = "20260820-100000-v1ok";
		const runId = "20260820-100001-v1ok";
		await writeLegacyDelegation(root, delegationId);
		await writeLegacyRun(root, runId);
		const manifestPath = join(root, CONFIG_DIR_NAME, "workbench", "runs", runId, "manifest.json");
		const beforeBytes = await readFile(manifestPath);
		const beforeTree = await tree(join(root, CONFIG_DIR_NAME, "workbench"));

		const report = await inspectGovernanceRollback(root);
		assert.deepEqual(report, {
			read_only: true,
			safe_for_v1_rollback: true,
			delegations: { legacy_v1: 1, v2: 0, unclassified: 0 },
			runs: { legacy_v1: 1, v2: 0, unclassified: 0 },
			blockers: [],
			samples: [],
		});
		assert.deepEqual(await tree(join(root, CONFIG_DIR_NAME, "workbench")), beforeTree, "inspection creates or deletes nothing");
		assert.deepEqual(await readFile(manifestPath), beforeBytes, "inspection never rewrites history");
	});
});

test("v2 delegation and run authority block a v1-only rollback even when old readers see no delegation", async () => {
	await withTempDir(async (root) => {
		const delegationId = "20260820-100002-v2ok";
		const prepared = await persistPreparedDelegationTransaction(root, {
			delegation_id: delegationId,
			task_kind: "implementation",
			contract_hash: HASH,
			allowed_paths: ["src/**"],
			worker_identity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: `worker:${delegationId}` },
			generation: 1,
			now: "2026-08-20T10:00:02.000Z",
		});
		assert.equal(prepared.ok, true);
		assert.equal(await readDelegationLedger(root, delegationId), null, "a v1-only reader would see no delegation authority");

		const runId = "20260820-100003-v2ok";
		const runDir = join(root, CONFIG_DIR_NAME, "workbench", "runs", runId);
		await mkdir(runDir, { recursive: true });
		await writeFile(join(runDir, "manifest.json"), JSON.stringify({
			schema_version: 2,
			run_id: runId,
			recipe: "current",
			run_transaction_schema_version: 2,
			run_outcome: "SUCCESS",
		}), "utf8");

		const report = await inspectGovernanceRollback(root);
		assert.equal(report.safe_for_v1_rollback, false);
		assert.deepEqual(report.delegations, { legacy_v1: 0, v2: 1, unclassified: 0 });
		assert.deepEqual(report.runs, { legacy_v1: 0, v2: 1, unclassified: 0 });
		assert.deepEqual(report.blockers, ["V2_DELEGATION_AUTHORITY_PRESENT", "V2_RUN_AUTHORITY_PRESENT"]);
		assert.deepEqual(report.samples, [
			{ domain: "delegation", id: delegationId, classification: "v2" },
			{ domain: "run", id: runId, classification: "v2" },
		]);
	});
});

test("partial and unknown authority block rollback instead of being skipped", async () => {
	await withTempDir(async (root) => {
		const delegationId = "20260820-100004-part";
		await mkdir(join(root, CONFIG_DIR_NAME, "workbench", "delegations", delegationId), { recursive: true });
		const runId = "20260820-100005-unkn";
		const runDir = join(root, CONFIG_DIR_NAME, "workbench", "runs", runId);
		await mkdir(runDir, { recursive: true });
		await writeFile(join(runDir, "manifest.json"), JSON.stringify({ schema_version: 99, run_id: runId }), "utf8");

		const report = await inspectGovernanceRollback(root);
		assert.equal(report.safe_for_v1_rollback, false);
		assert.deepEqual(report.delegations, { legacy_v1: 0, v2: 0, unclassified: 1 });
		assert.deepEqual(report.runs, { legacy_v1: 0, v2: 0, unclassified: 1 });
		assert.deepEqual(report.blockers, ["UNCLASSIFIED_DELEGATION_AUTHORITY", "UNCLASSIFIED_RUN_AUTHORITY"]);
	});
});

test("a missing project root fails closed instead of reporting an empty safe inventory", async () => {
	await withTempDir(async (root) => {
		assert.deepEqual(await inspectGovernanceRollback(join(root, "missing")), {
			read_only: true,
			safe_for_v1_rollback: false,
			delegations: { legacy_v1: 0, v2: 0, unclassified: 0 },
			runs: { legacy_v1: 0, v2: 0, unclassified: 0 },
			blockers: ["INVENTORY_UNAVAILABLE"],
			samples: [],
		});
	});
});
