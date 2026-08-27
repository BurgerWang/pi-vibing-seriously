import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	acquireProjectCheckoutOperationV1,
	forgetRecoveredProjectCheckoutOperationV1,
	inspectProcessCheckoutOperationV1,
	markProjectCheckoutOperationSettledV1,
	projectCheckoutOperationBlockReasonV1,
	recoverSettledGenericProjectCheckoutOperationV1,
	releaseProjectCheckoutOperationV1,
	resetProjectCheckoutOperationRegistryForTestV1,
	runProjectCheckoutOperationV1,
} from "../extensions/workbench-runtime/core/project-checkout-operation.ts";
import { releaseProjectDelegationStartLockV1 } from "../extensions/workbench-runtime/core/delegation-start-lock.ts";
import { withTempDir } from "./helpers.ts";

const NOW = "2026-08-27T10:00:00.000Z";

function lockPath(root: string): string {
	return join(root, CONFIG_DIR_NAME, "workbench", "delegation-start.lock");
}

test.afterEach(() => resetProjectCheckoutOperationRegistryForTestV1());

test("one fixed checkout lane excludes disjoint operation kinds and independent roots remain parallel", async () => {
	await withTempDir(async (firstRoot) => {
		await withTempDir(async (secondRoot) => {
			const first = await acquireProjectCheckoutOperationV1({
				project_root: firstRoot,
				operation_kind: "tool",
				operation_id: "tool:edit:docs/readme.md",
				now: NOW,
			});
			assert.equal(first.ok, true);
			const disjoint = await acquireProjectCheckoutOperationV1({
				project_root: firstRoot,
				operation_kind: "command",
				operation_id: "command:q-run:tests-only",
				now: NOW,
			});
			assert.equal(disjoint.ok, false, "path disjointness never grants a second writer in one checkout");

			const independent = await acquireProjectCheckoutOperationV1({
				project_root: secondRoot,
				operation_kind: "command",
				operation_id: "command:q-run:tests-only",
				now: NOW,
			});
			assert.equal(independent.ok, true, "an independently rooted checkout owns an independent fixed lane");
			if (independent.ok) assert.equal((await releaseProjectCheckoutOperationV1(independent.value)).ok, true);
			if (first.ok) assert.equal((await releaseProjectCheckoutOperationV1(first.value)).ok, true);
		});
	});
});

test("only the exact published token is reentrant and a borrower cannot unlink its parent", async () => {
	await withTempDir(async (root) => {
		const parent = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "delegation",
			operation_id: "delegation:20260827-100000-a001",
			delegation_id: "20260827-100000-a001",
			now: NOW,
		});
		assert.equal(parent.ok, true);
		if (!parent.ok) return;

		const bad = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "tool",
			operation_id: "tool:worker-edit",
			delegation_id: parent.value.delegation_id,
			reentrant_token: "f".repeat(32),
			now: NOW,
		});
		assert.equal(bad.ok, false);

		const nested = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "tool",
			operation_id: "tool:worker-edit",
			delegation_id: parent.value.delegation_id,
			reentrant_token: parent.value.token,
			now: NOW,
		});
		assert.equal(nested.ok, true);
		if (!nested.ok) return;
		assert.equal(nested.value.mode, "reentrant");
		assert.equal((await releaseProjectCheckoutOperationV1(nested.value)).ok, true);
		assert.equal(JSON.parse(await readFile(lockPath(root), "utf8")).token, parent.value.token);
		assert.equal((await releaseProjectCheckoutOperationV1(parent.value)).ok, true);
	});
});

test("process-global settlement survives controller replacement and requires exact-token forgetting", async () => {
	await withTempDir(async (root) => {
		const acquired = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "delegation",
			operation_id: "delegation:20260827-100001-b002",
			delegation_id: "20260827-100001-b002",
			now: NOW,
		});
		assert.equal(acquired.ok, true);
		if (!acquired.ok) return;
		assert.equal(inspectProcessCheckoutOperationV1(root, acquired.value.token), "active");
		assert.equal(markProjectCheckoutOperationSettledV1(acquired.value), true);
		assert.equal(inspectProcessCheckoutOperationV1(root, acquired.value.token), "settled");
		assert.equal(forgetRecoveredProjectCheckoutOperationV1(root, "0".repeat(32)), false);
		assert.equal(forgetRecoveredProjectCheckoutOperationV1(root, acquired.value.token), true);
		// The registry forget helper is used only after strict durable recovery.
		// This test performs the physical cleanup with the still-exact lease.
		const reacquired = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "tool",
			operation_id: "tool:must-still-conflict",
			now: NOW,
		});
		assert.equal(reacquired.ok, false, "forgetting process metadata does not remove durable authority");
		// Re-register through an exact reentrant borrow only; it still cannot own
		// or unlink the parent's fixed lock.
		const borrow = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "tool",
			operation_id: "tool:exact-borrow-after-reload",
			reentrant_token: acquired.value.token,
			now: NOW,
		});
		assert.equal(borrow.ok, true);
		if (borrow.ok) assert.equal((await releaseProjectCheckoutOperationV1(borrow.value)).ok, true);
		// Directly releasing the original lease now fails closed because the
		// process record was deliberately forgotten by the simulated recovery.
		assert.equal((await releaseProjectCheckoutOperationV1(acquired.value)).ok, false);
	});
});

test("generic recovery defers a settled delegation to transaction-aware CAS", async () => {
	await withTempDir(async (root) => {
		const acquired = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "delegation",
			operation_id: "delegation:20260827-100001-cas1",
			delegation_id: "20260827-100001-cas1",
			now: NOW,
		});
		assert.equal(acquired.ok, true);
		if (!acquired.ok) return;
		assert.equal(markProjectCheckoutOperationSettledV1(acquired.value, "delegation_cas"), true);
		assert.deepEqual(await recoverSettledGenericProjectCheckoutOperationV1(root), {
			ok: true,
			value: "delegation_cas_pending",
		});
		const next = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "tool",
			operation_id: "tool:must-wait-for-delegation-cas",
			now: "2026-08-27T10:00:01.000Z",
		});
		assert.equal(next.ok, false, "ordinary acquisition cannot treat delegation CAS as generic cleanup");
		assert.equal((await releaseProjectCheckoutOperationV1(acquired.value)).ok, true);
	});
});

test("read-only barrier allows absence and exact inheritance but blocks a foreign live owner", async () => {
	await withTempDir(async (root) => {
		assert.equal(await projectCheckoutOperationBlockReasonV1({ project_root: root }), undefined);
		const parent = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "delegation",
			operation_id: "delegation:20260827-100002-c003",
			delegation_id: "20260827-100002-c003",
			now: NOW,
		});
		assert.equal(parent.ok, true);
		if (!parent.ok) return;
		assert.match(await projectCheckoutOperationBlockReasonV1({ project_root: root }) ?? "", /active/u);
		assert.equal(await projectCheckoutOperationBlockReasonV1({
			project_root: root,
			delegation_id: parent.value.delegation_id,
			reentrant_token: parent.value.token,
		}), undefined);
		assert.equal((await releaseProjectCheckoutOperationV1(parent.value)).ok, true);
	});
});

test("a settled command release fault is recovered exactly before the next mutation", async () => {
	await withTempDir(async (root) => {
		let releaseCalls = 0;
		const options = {
			release_start_lock: async (...args: Parameters<typeof releaseProjectDelegationStartLockV1>) => {
				releaseCalls += 1;
				if (releaseCalls === 1) {
					return { ok: false as const, error: { code: "storage_failure" as const, message: "injected release fault" } };
				}
				return releaseProjectDelegationStartLockV1(...args);
			},
		};
		const command = await runProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "command",
			operation_id: "command:q-run:settled-release-fault",
			now: NOW,
		}, async (lease) => {
			assert.equal(inspectProcessCheckoutOperationV1(root, lease.token), "active");
			return { command: "committed" };
		}, options);
		assert.equal(command.ok, true);
		if (!command.ok) return;
		assert.equal(command.release, "recovery_required");

		const lock = JSON.parse(await readFile(lockPath(root), "utf8")) as { token: string };
		assert.equal(inspectProcessCheckoutOperationV1(root, lock.token), "settled",
			"the awaited slash callback is process-settled before a cleanup failure is retained");
		const staleBorrow = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "tool",
			operation_id: "tool:late-reentrant-after-command-settled",
			reentrant_token: lock.token,
			now: "2026-08-27T10:00:01.000Z",
		}, options);
		assert.equal(staleBorrow.ok, false, "an exact token stops granting reentrancy once its callback is settled");

		const next = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "tool",
			operation_id: "tool:next-mutation-after-command-release-fault",
			now: "2026-08-27T10:00:01.000Z",
		}, options);
		assert.equal(next.ok, true, next.ok ? "" : next.error.message);
		assert.equal(releaseCalls, 2, "the next mutation releases only the exact settled fixed owner before acquiring");
		if (!next.ok) return;
		assert.notEqual(next.value.token, lock.token);
		assert.equal((await releaseProjectCheckoutOperationV1(next.value, options)).ok, true);
	});
});

test("post-unlink release failure drops only the exact settled registry record", async () => {
	await withTempDir(async (root) => {
		let releaseCalls = 0;
		const options = {
			release_start_lock: async (...args: Parameters<typeof releaseProjectDelegationStartLockV1>) => {
				releaseCalls += 1;
				const released = await releaseProjectDelegationStartLockV1(...args);
				if (releaseCalls === 1 && released.ok) {
					return { ok: false as const, error: { code: "storage_failure" as const, message: "injected post-unlink fault" } };
				}
				return released;
			},
		};
		const command = await runProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "command",
			operation_id: "command:q-gate:post-unlink-fault",
			now: NOW,
		}, async () => "gate-written", options);
		assert.equal(command.ok, true);
		if (!command.ok) return;
		assert.equal(command.release, "recovery_required");
		await assert.rejects(readFile(lockPath(root), "utf8"), { code: "ENOENT" });

		const next = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "tool",
			operation_id: "tool:next-after-absent-fixed-owner",
			now: "2026-08-27T10:00:01.000Z",
		}, options);
		assert.equal(next.ok, true, next.ok ? "" : next.error.message);
		assert.equal(releaseCalls, 1, "durable absence needs no guessed second unlink");
		if (next.ok) assert.equal((await releaseProjectCheckoutOperationV1(next.value, options)).ok, true);
	});
});
