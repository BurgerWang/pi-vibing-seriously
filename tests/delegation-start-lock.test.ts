import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	acquireProjectDelegationStartLockV1,
	inspectProjectDelegationStartLockV1,
	PROJECT_DELEGATION_START_LOCK_MAX_BYTES_V1,
	PROJECT_DELEGATION_START_LOCK_RELATIVE_PATH_V1,
	releaseProjectDelegationStartLockV1,
	withProjectDelegationStartLockV1,
	type ProjectDelegationStartLockLeaseV1,
	type ProjectDelegationStartLockOptionsV1,
} from "../extensions/workbench-runtime/core/delegation-start-lock.ts";

const ID = "20260823-220000-lock";
const ID_2 = "20260823-220001-next";
const NOW = "2026-08-23T22:00:00.000Z";
const NOW_2 = "2026-08-23T22:00:01.000Z";
const BOOT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_BOOT_ID = "11111111-2222-4333-8444-555555555555";
const roots: string[] = [];

function exactIdentity(processId: number, processStartTicks: string): ProjectDelegationStartLockOptionsV1 {
	return {
		process_id: processId,
		read_boot_id: async () => BOOT_ID,
		read_process_start_ticks: async () => processStartTicks,
	};
}

async function projectRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-delegation-start-lock-"));
	roots.push(root);
	return root;
}

function fixedPath(root: string): string {
	return join(root, CONFIG_DIR_NAME, "workbench", "delegation-start.lock");
}

test.afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("delegation start lock publishes one complete canonical owner and releases idempotently only after absence", async () => {
	const root = await projectRoot();
	const acquired = await acquireProjectDelegationStartLockV1({ project_root: root, delegation_id: ID, now: NOW });
	assert.equal(acquired.ok, true);
	if (!acquired.ok) return;

	assert.equal(PROJECT_DELEGATION_START_LOCK_RELATIVE_PATH_V1, ".pi/workbench/delegation-start.lock");
	assert.equal(acquired.value.project_root, root);
	const bytes = await readFile(fixedPath(root));
	assert.ok(bytes.length > 0 && bytes.length <= PROJECT_DELEGATION_START_LOCK_MAX_BYTES_V1);
	const stats = await lstat(fixedPath(root));
	assert.equal(stats.isFile(), true);
	assert.equal(stats.isSymbolicLink(), false);
	const owner = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
	assert.deepEqual(Object.keys(owner), [
		"schema_version",
		"kind",
		"project_root_hash",
		"delegation_id",
		"token",
		"process_id",
		"process_start_ticks",
		"boot_id",
		"acquired_at",
	]);
	assert.equal(owner.project_root_hash, createHash("sha256").update(root, "utf8").digest("hex"));
	assert.equal(owner.token, acquired.value.token);
	assert.equal(owner.process_start_ticks, acquired.value.process_start_ticks);
	assert.equal(owner.boot_id, acquired.value.boot_id);
	assert.equal(bytes.toString("utf8"), `${JSON.stringify(owner, null, 2)}\n`);

	const released = await releaseProjectDelegationStartLockV1(acquired.value);
	assert.deepEqual(released, { ok: true, value: undefined });
	const absentRelease = await releaseProjectDelegationStartLockV1(acquired.value);
	assert.deepEqual(absentRelease, { ok: true, value: undefined });
});

test("two concurrent acquisitions publish exactly one owner and report one live-owner conflict", async () => {
	const root = await projectRoot();
	const [first, second] = await Promise.all([
		acquireProjectDelegationStartLockV1({ project_root: root, delegation_id: ID, now: NOW }),
		acquireProjectDelegationStartLockV1({ project_root: root, delegation_id: ID_2, now: NOW_2 }),
	]);
	const successes = [first, second].filter((result) => result.ok);
	const failures = [first, second].filter((result) => !result.ok);
	assert.equal(successes.length, 1);
	assert.equal(failures.length, 1);
	assert.equal(failures[0]?.ok, false);
	if (failures[0] !== undefined && !failures[0].ok) assert.equal(failures[0].error.code, "conflict");
	const winner = successes[0];
	assert.ok(winner?.ok);
	if (winner?.ok) assert.equal((await releaseProjectDelegationStartLockV1(winner.value)).ok, true);
});

test("a live PID remains exclusive while a dead PID owner is atomically recovered", async () => {
	const root = await projectRoot();
	const stale = await acquireProjectDelegationStartLockV1(
		{ project_root: root, delegation_id: ID, now: NOW },
		exactIdentity(999_999_991, "100"),
	);
	assert.equal(stale.ok, true);
	if (!stale.ok) return;

	const liveConflict = await acquireProjectDelegationStartLockV1(
		{ project_root: root, delegation_id: ID_2, now: NOW_2 },
		{
			is_process_alive: () => true,
			read_boot_id: async () => BOOT_ID,
			read_process_start_ticks: async (processId) => processId === 999_999_991 ? "100" : "200",
		},
	);
	assert.equal(liveConflict.ok, false);
	if (!liveConflict.ok) assert.equal(liveConflict.error.code, "conflict");

	const recovered = await acquireProjectDelegationStartLockV1(
		{ project_root: root, delegation_id: ID_2, now: NOW_2 },
		{
			is_process_alive: () => false,
			read_boot_id: async () => BOOT_ID,
			read_process_start_ticks: async () => "200",
		},
	);
	assert.equal(recovered.ok, true);
	if (!recovered.ok) return;

	const staleRelease = await releaseProjectDelegationStartLockV1(stale.value);
	assert.equal(staleRelease.ok, false);
	if (!staleRelease.ok) assert.equal(staleRelease.error.code, "conflict");
	const currentOwner = JSON.parse(await readFile(fixedPath(root), "utf8")) as Record<string, unknown>;
	assert.equal(currentOwner.token, recovered.value.token);
	assert.equal((await releaseProjectDelegationStartLockV1(recovered.value)).ok, true);
});

test("a malformed fixed owner fails closed and is never treated as recoverable crash evidence", async () => {
	const root = await projectRoot();
	await mkdir(join(root, CONFIG_DIR_NAME, "workbench"), { recursive: true });
	await writeFile(fixedPath(root), "{\n", { mode: 0o600 });

	const acquired = await acquireProjectDelegationStartLockV1({ project_root: root, delegation_id: ID, now: NOW });
	assert.equal(acquired.ok, false);
	if (!acquired.ok) assert.equal(acquired.error.code, "invalid_record");
	assert.equal(await readFile(fixedPath(root), "utf8"), "{\n");
});

test("strict inspection distinguishes live and dead canonical owners for crash recovery", async () => {
	const root = await projectRoot();
	const acquired = await acquireProjectDelegationStartLockV1(
		{ project_root: root, delegation_id: ID, now: NOW },
		exactIdentity(999_999_991, "100"),
	);
	assert.equal(acquired.ok, true);
	if (!acquired.ok) return;
	const live = await inspectProjectDelegationStartLockV1(root, {
		is_process_alive: () => true,
		read_boot_id: async () => BOOT_ID,
		read_process_start_ticks: async () => "100",
	});
	assert.equal(live.ok && live.value.status, "live");
	const dead = await inspectProjectDelegationStartLockV1(root, {
		is_process_alive: () => false,
		read_boot_id: async () => BOOT_ID,
		read_process_start_ticks: async () => "100",
	});
	assert.equal(dead.ok && dead.value.status, "dead");
	if (dead.ok && dead.value.status === "dead") assert.equal(dead.value.lease.token, acquired.value.token);
	assert.equal((await releaseProjectDelegationStartLockV1(acquired.value)).ok, true);
});

test("a live reused PID is dead only when its boot/process-start identity proves it is a different process", async () => {
	const root = await projectRoot();
	const stale = await acquireProjectDelegationStartLockV1(
		{ project_root: root, delegation_id: ID, now: NOW },
		exactIdentity(999_999_991, "100"),
	);
	assert.equal(stale.ok, true);
	if (!stale.ok) return;

	const reused = await acquireProjectDelegationStartLockV1(
		{ project_root: root, delegation_id: ID_2, now: NOW_2 },
		{
			is_process_alive: () => true,
			read_boot_id: async () => BOOT_ID,
			read_process_start_ticks: async (processId) => processId === 999_999_991 ? "101" : "200",
		},
	);
	assert.equal(reused.ok, true);
	if (!reused.ok) return;
	assert.equal(reused.value.delegation_id, ID_2);
	assert.equal((await releaseProjectDelegationStartLockV1(reused.value)).ok, true);
});

test("a prior-boot owner is dead even when the numeric PID is currently live", async () => {
	const root = await projectRoot();
	const stale = await acquireProjectDelegationStartLockV1(
		{ project_root: root, delegation_id: ID, now: NOW },
		exactIdentity(999_999_991, "100"),
	);
	assert.equal(stale.ok, true);
	if (!stale.ok) return;

	const inspected = await inspectProjectDelegationStartLockV1(root, {
		is_process_alive: () => true,
		read_boot_id: async () => OTHER_BOOT_ID,
		read_process_start_ticks: async () => "100",
	});
	assert.equal(inspected.ok && inspected.value.status, "dead");
	assert.equal((await releaseProjectDelegationStartLockV1(stale.value)).ok, true);
});

test("missing process identity fails closed and never recovers a canonical owner", async () => {
	const root = await projectRoot();
	const acquired = await acquireProjectDelegationStartLockV1(
		{ project_root: root, delegation_id: ID, now: NOW },
		exactIdentity(999_999_991, "100"),
	);
	assert.equal(acquired.ok, true);
	if (!acquired.ok) return;
	const before = await readFile(fixedPath(root));

	const inspected = await inspectProjectDelegationStartLockV1(root, {
		is_process_alive: () => false,
		read_boot_id: async () => null,
		read_process_start_ticks: async () => null,
	});
	assert.equal(inspected.ok, false);
	if (!inspected.ok) assert.equal(inspected.error.code, "conflict");
	let bootReads = 0;
	const blocked = await acquireProjectDelegationStartLockV1(
		{ project_root: root, delegation_id: ID_2, now: NOW_2 },
		{
			is_process_alive: () => false,
			read_boot_id: async () => {
				bootReads += 1;
				return bootReads === 1 ? BOOT_ID : null;
			},
			read_process_start_ticks: async () => "200",
		},
	);
	assert.equal(blocked.ok, false);
	if (!blocked.ok) assert.equal(blocked.error.code, "conflict");
	assert.deepEqual(await readFile(fixedPath(root)), before);
	assert.equal((await releaseProjectDelegationStartLockV1(acquired.value)).ok, true);
});

test("a legacy PID-only owner is invalid and is not reclaimed", async () => {
	const root = await projectRoot();
	await mkdir(join(root, CONFIG_DIR_NAME, "workbench"), { recursive: true });
	const legacyOwner = {
		schema_version: 1,
		kind: "project-delegation-start-lock-v1",
		project_root_hash: createHash("sha256").update(root, "utf8").digest("hex"),
		delegation_id: ID,
		token: "a".repeat(32),
		process_id: 999_999_991,
		acquired_at: NOW,
	};
	const legacyBytes = `${JSON.stringify(legacyOwner, null, 2)}\n`;
	await writeFile(fixedPath(root), legacyBytes, { mode: 0o600 });

	const blocked = await acquireProjectDelegationStartLockV1(
		{ project_root: root, delegation_id: ID_2, now: NOW_2 },
		exactIdentity(999_999_992, "200"),
	);
	assert.equal(blocked.ok, false);
	if (!blocked.ok) assert.equal(blocked.error.code, "invalid_record");
	assert.equal(await readFile(fixedPath(root), "utf8"), legacyBytes);
});

test("symlink lock and symlinked project layout fail closed without modifying their targets", async () => {
	const root = await projectRoot();
	const outside = await projectRoot();
	await mkdir(join(root, CONFIG_DIR_NAME, "workbench"), { recursive: true });
	const target = join(outside, "foreign-owner.json");
	await writeFile(target, "foreign\n", { mode: 0o600 });
	await symlink(target, fixedPath(root));

	const linkedLock = await acquireProjectDelegationStartLockV1({ project_root: root, delegation_id: ID, now: NOW });
	assert.equal(linkedLock.ok, false);
	if (!linkedLock.ok) assert.equal(linkedLock.error.code, "invalid_record");
	assert.equal(await readFile(target, "utf8"), "foreign\n");

	const otherRoot = await projectRoot();
	const outsidePi = join(outside, "outside-pi");
	await mkdir(outsidePi);
	await symlink(outsidePi, join(otherRoot, CONFIG_DIR_NAME));
	const linkedLayout = await acquireProjectDelegationStartLockV1({ project_root: otherRoot, delegation_id: ID, now: NOW });
	assert.equal(linkedLayout.ok, false);
	if (!linkedLayout.ok) assert.equal(linkedLayout.error.code, "invalid_record");
	await assert.rejects(readFile(join(outsidePi, "workbench", "delegation-start.lock")), { code: "ENOENT" });
});

test("foreign-token release never deletes the current owner", async () => {
	const root = await projectRoot();
	const acquired = await acquireProjectDelegationStartLockV1({ project_root: root, delegation_id: ID, now: NOW });
	assert.equal(acquired.ok, true);
	if (!acquired.ok) return;
	const foreign: ProjectDelegationStartLockLeaseV1 = {
		...acquired.value,
		token: acquired.value.token === "f".repeat(32) ? "e".repeat(32) : "f".repeat(32),
	};
	const refused = await releaseProjectDelegationStartLockV1(foreign);
	assert.equal(refused.ok, false);
	if (!refused.ok) assert.equal(refused.error.code, "conflict");
	const owner = JSON.parse(await readFile(fixedPath(root), "utf8")) as Record<string, unknown>;
	assert.equal(owner.token, acquired.value.token);
	const foreignIdentity: ProjectDelegationStartLockLeaseV1 = {
		...acquired.value,
		process_start_ticks: `${BigInt(acquired.value.process_start_ticks) + 1n}`,
	};
	const identityRefused = await releaseProjectDelegationStartLockV1(foreignIdentity);
	assert.equal(identityRefused.ok, false);
	if (!identityRefused.ok) assert.equal(identityRefused.error.code, "conflict");
	assert.equal((JSON.parse(await readFile(fixedPath(root), "utf8")) as Record<string, unknown>).token,
		acquired.value.token);
	assert.equal((await releaseProjectDelegationStartLockV1(acquired.value)).ok, true);
});

test("withProjectDelegationStartLockV1 releases in finally when the operation throws", async () => {
	const root = await projectRoot();
	await assert.rejects(
		withProjectDelegationStartLockV1(
			{ project_root: root, delegation_id: ID, now: NOW },
			async () => {
				throw new Error("operation failed");
			},
		),
		/operation failed/,
	);
	const next = await acquireProjectDelegationStartLockV1({ project_root: root, delegation_id: ID_2, now: NOW_2 });
	assert.equal(next.ok, true);
	if (next.ok) assert.equal((await releaseProjectDelegationStartLockV1(next.value)).ok, true);
});
