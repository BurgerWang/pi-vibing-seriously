/** WP7 structural ownership guards for lifecycle projection and compatibility. */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const EXTENSION_ROOT = new URL("../extensions/workbench-runtime/", import.meta.url);
const CORE_ROOT = new URL("core/", EXTENSION_ROOT);

async function source(relativePath: string): Promise<string> {
	return readFile(new URL(relativePath, EXTENSION_ROOT), "utf8");
}

async function coreSources(): Promise<Array<{ name: string; text: string }>> {
	const names = (await readdir(CORE_ROOT)).filter((name) => name.endsWith(".ts")).sort();
	return Promise.all(names.map(async (name) => ({ name, text: await readFile(new URL(name, CORE_ROOT), "utf8") })));
}

test("one canonical resolver owns lifecycle state and compatibility classifiers delegate to it", async () => {
	const files = await coreSources();
	const ownerCount = files.reduce(
		(count, file) => count + (file.text.match(/export function resolveDelegationLifecycleV1\s*\(/g)?.length ?? 0),
		0,
	);
	assert.equal(ownerCount, 1);

	const repairStatus = await source("core/delegation-repair-status.ts");
	assert.match(
		repairStatus,
		/return withCompatibilityResolutionV1\(classifyDelegationRepairFactsV1\(input\)\);/,
	);
	const successor = await source("core/exact-repair-successor.ts");
	assert.match(successor, /resolveExactRepairSuccessorDispositionV1\s*\(\{/);
});

test("status is a read-only projection with one typed next-action renderer", async () => {
	const runtime = await source("index.ts");
	const statusStart = runtime.indexOf("async function delegationStatusLines");
	const statusEnd = runtime.indexOf("\n\t// -------------------------------------------------------------- lifecycle", statusStart);
	assert.ok(statusStart >= 0 && statusEnd > statusStart, "delegationStatusLines source slice must remain discoverable");
	const statusSource = runtime.slice(statusStart, statusEnd);
	for (const forbidden of ["reconcileProjectAuthority", ".setState(", ".persistBestEffort(", ".appendEntry("]) {
		assert.equal(statusSource.includes(forbidden), false, `status must not call ${forbidden}`);
	}
	assert.match(statusSource, /createDelegationRepairStatusReadScopeV1\(projectRoot, execFn\)/);
	assert.equal(statusSource.includes("readDelegationRepairStatusV1("), false);
	assert.equal(statusSource.includes("readDelegationAuthorityObservation"), false);

	const repairStatus = await source("core/delegation-repair-status.ts");
	assert.equal(repairStatus.includes("readWorkerRepairCapsule"), false);
	assert.equal(repairStatus.includes("readRepairCapsule"), false);
	assert.equal(repairStatus.match(/`next action  :/g)?.length, 1);

	const statusCommands = await source("core/status-commands.ts");
	const qStatusStart = statusCommands.indexOf('controller.pi.registerCommand("q-status"');
	const qStatusEnd = statusCommands.indexOf('controller.pi.registerCommand("q-runtime-doctor"', qStatusStart);
	assert.ok(qStatusStart >= 0 && qStatusEnd > qStatusStart, "q-status source slice must remain discoverable");
	const qStatusSource = statusCommands.slice(qStatusStart, qStatusEnd);
	assert.match(qStatusSource, /controller\.delegationStatusLines\(projectRoot\)/);
	assert.equal(qStatusSource.includes("controller.reconcileProjectAuthority"), false);
});

test("machine-call compatibility strings have one production owner", async () => {
	const files = await coreSources();
	const repairOwners = files.filter(({ text }) => text.includes("call ${EXACT_REPAIR_TOOL_NAME_V1} with delegation_id=${delegationId}"));
	const reviewOwners = files.filter(({ text }) => text.includes("call workbench_review_worker_diff with delegation_id=${delegationId}"));
	assert.deepEqual(repairOwners.map(({ name }) => name), ["agent-next-action.ts"]);
	assert.deepEqual(reviewOwners.map(({ name }) => name), ["agent-next-action.ts"]);
});

test("historical v1 ledger is readable but both production writers fail closed", async () => {
	const ledger = await source("core/delegation-ledger.ts");
	assert.equal(ledger.match(/historical delegation schema v1 is read-only/g)?.length, 2);
	assert.equal(ledger.includes('writeJsonAtomic(dir, "before.json"'), false);
	assert.equal(ledger.includes('writeJsonAtomic(dir, "after.json"'), false);
	assert.match(ledger, /export async function readDelegationLedger\s*\(/);

	const delegateController = await source("core/delegate-tool-controller.ts");
	assert.equal(delegateController.includes("createDelegationLedger"), false);
	assert.equal(delegateController.includes("finishDelegationLedger"), false);
});
