/** Isolated tests for runtime delegation session mirror ownership. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	createDelegationSessionController,
	type DelegationSessionServices,
} from "../extensions/workbench-runtime/core/delegation-session-controller.ts";
import {
	DELEGATION_STATE_ENTRY_TYPE,
	type DelegationState,
} from "../extensions/workbench-runtime/core/delegation-state.ts";

const PENDING: DelegationState = {
	latestId: "20260821-030405-W1r2",
	status: "PENDING_REVIEW",
	currentDiffHash: "a".repeat(64),
	blockedWriteAttempts: 0,
	updatedAt: "2026-08-21T03:04:05.000Z",
};
const REVIEWED: DelegationState = {
	...PENDING,
	status: "REVIEWED",
	reviewedDiffHash: PENDING.currentDiffHash,
	updatedAt: "2026-08-21T03:05:00.000Z",
};

function services(overrides: Partial<DelegationSessionServices> = {}): DelegationSessionServices {
	return {
		collectCurrentBinding: async () => ({ status: "fresh", hash: PENDING.currentDiffHash!, kind: "changeset-relevance-v2" }),
		reconcileProjectAuthority: async ({ current_state }) => ({ ok: true, state: current_state }),
		...overrides,
	} as DelegationSessionServices;
}

test("strict persistence publishes before adopting state while best-effort failure keeps local state", () => {
	const appended: unknown[] = [];
	let fail = false;
	const controller = createDelegationSessionController({
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		appendEntry: (customType, data) => {
			assert.equal(customType, DELEGATION_STATE_ENTRY_TYPE);
			if (fail) throw new Error("injected append failure");
			appended.push(data);
		},
		onStateChanged: () => {},
	}, services());
	controller.setState(PENDING);
	controller.persistBestEffort();
	assert.equal(appended.length, 1);

	fail = true;
	assert.throws(() => controller.persistStrict(REVIEWED), /injected append failure/);
	assert.equal(controller.getState(), PENDING, "failed strict append cannot publish prospective state");
	controller.persistBestEffort();
	assert.equal(controller.getState(), PENDING, "best-effort append failure never clears local authority");
});

test("restore owns all session mirror flags and ignores corrupt later records", () => {
	const changed: DelegationState[] = [];
	const controller = createDelegationSessionController({
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		appendEntry: () => {},
		onStateChanged: (state) => changed.push(state),
	}, services());
	controller.setStrictMirrorDirty(true);
	controller.markTerminalMirrorBlocked();
	const restored = controller.restore([
		{ type: "custom", customType: DELEGATION_STATE_ENTRY_TYPE, data: PENDING },
		{ type: "custom", customType: DELEGATION_STATE_ENTRY_TYPE, data: { status: "UNKNOWN" } },
	]);
	assert.equal(restored.latestId, PENDING.latestId);
	assert.equal(controller.isStrictMirrorDirty(), false);
	assert.equal(controller.getProjectAuthorityIssue(), undefined);
	assert.equal(changed.at(-1)?.latestId, PENDING.latestId);
});

test("reconcile failure exposes one bounded project-authority block", async () => {
	const controller = createDelegationSessionController({
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		appendEntry: () => {},
		onStateChanged: () => {},
	}, services({
		reconcileProjectAuthority: async () => ({
				ok: false,
				issue: { code: "invalid_record", delegationId: PENDING.latestId },
			}),
	}));

	assert.equal(await controller.reconcileProjectAuthority("/project", PENDING.updatedAt), false);
	assert.deepEqual(controller.getProjectAuthorityIssue(), { code: "invalid_record", delegationId: PENDING.latestId });
	assert.match(controller.projectAuthorityBlockReason("verify") ?? "", /invalid_record; verify fails closed/);
	controller.clearProjectAuthorityIssue();
	assert.equal(controller.projectAuthorityBlockReason("verify"), undefined);
});

test("failed reconcile append adopts a dirty blocking mirror and next call heals it", async () => {
	let appendCalls = 0;
	const controller = createDelegationSessionController({
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		appendEntry: () => {
			appendCalls += 1;
			if (appendCalls === 1) throw new Error("one-shot append failure");
		},
		onStateChanged: () => {},
	}, services({ reconcileProjectAuthority: async () => ({ ok: true, state: PENDING }) }));

	assert.equal(await controller.reconcileProjectAuthority("/project", PENDING.updatedAt), true);
	assert.equal(controller.getState(), PENDING);
	assert.equal(controller.isStrictMirrorDirty(), true);
	assert.equal(await controller.reconcileProjectAuthority("/project", PENDING.updatedAt), true);
	assert.equal(appendCalls, 2);
	assert.equal(controller.isStrictMirrorDirty(), false);
});

test("reconcile null durably clears an obsolete blocking session mirror", async () => {
	const appended: unknown[] = [];
	const controller = createDelegationSessionController({
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		appendEntry: (_customType, data) => { appended.push(data); },
		onStateChanged: () => {},
	}, services({ reconcileProjectAuthority: async () => ({ ok: true, state: null }) }));
	controller.setState(PENDING);

	assert.equal(await controller.reconcileProjectAuthority("/project", PENDING.updatedAt), true);
	assert.equal(controller.getState().latestId, undefined);
	assert.equal(controller.getState().status, "PENDING_REVIEW", "empty state has no latest id and therefore does not block");
	assert.equal(appended.length, 1, "the cleared mirror is persisted for reload/compaction continuity");
});

test("current binding and terminal review projection use only injected services", async () => {
	const calls: unknown[] = [];
	const controller = createDelegationSessionController({
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		appendEntry: () => {},
		onStateChanged: () => {},
	}, services({
		collectCurrentBinding: async (root, id) => {
			calls.push({ root, id });
			return { status: "fresh", hash: "b".repeat(64), kind: "changeset-relevance-v2" };
		},
	}));
	controller.setState(PENDING);

	assert.equal(await controller.collectCurrentDiffHash("/project"), "b".repeat(64));
	const reviewed = await controller.projectTerminalReviewedBinding("/project", PENDING.latestId!, "2026-08-21T04:00:00.000Z");
	assert.equal(reviewed?.status, "REVIEWED");
	assert.equal(reviewed?.currentDiffHash, "b".repeat(64));
	assert.equal(reviewed?.reviewedDiffHash, "b".repeat(64));
	assert.deepEqual(calls, [
		{ root: "/project", id: PENDING.latestId },
		{ root: "/project", id: PENDING.latestId },
	]);
});
