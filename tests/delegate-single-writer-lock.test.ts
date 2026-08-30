import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	registerDelegateTool,
	type DelegateToolController,
	type DelegateToolServices,
} from "../extensions/workbench-runtime/core/delegate-tool-controller.ts";
import type { DelegationPathLaneAdmissionV1 } from "../extensions/workbench-runtime/core/delegation-path-lane-admission.ts";
import {
	acquireProjectDelegationStartLockV1,
	inspectProjectDelegationStartLockV1,
	releaseProjectDelegationStartLockV1,
} from "../extensions/workbench-runtime/core/delegation-start-lock.ts";
import {
	acquireProjectCheckoutOperationV1,
	forgetRecoveredProjectCheckoutOperationV1,
	inspectProcessCheckoutOperationV1,
	releaseProjectCheckoutOperationV1,
} from "../extensions/workbench-runtime/core/project-checkout-operation.ts";
import { emptyDelegationState, type DelegationState } from "../extensions/workbench-runtime/core/delegation-state.ts";
import { withTempDir } from "./helpers.ts";

const NOW = new Date("2026-08-27T09:00:00.000Z");

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

interface ExecuteInput {
	readonly delegationId: string;
	readonly signal?: AbortSignal;
	onPrepared?(transaction: unknown, before: { diffHash: string }): Promise<void>;
}

interface DeliveryInput {
	readonly delegationId: string;
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((accept) => { resolve = accept; });
	return { promise, resolve };
}

function context(root: string, sessionId: string): ExtensionContext {
	return {
		cwd: root,
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
}

function params(path: string, taskKind: "diagnosis" | "implementation" = "diagnosis") {
	return {
		task: "Exercise one bounded checkout writer.",
		task_kind: taskKind,
		allowed_paths: [path],
		acceptance_criteria: ["The bounded lifecycle reaches an explicit outcome."],
		verification: [],
		timeout_seconds: 60,
	};
}

function lockPath(root: string): string {
	return join(root, CONFIG_DIR_NAME, "workbench", "delegation-start.lock");
}

function terminalFailure(code = "runner_failed", status = "FAILED") {
	return {
		ok: false,
		code,
		durable_state: { status, postcondition_reasons: ["EXIT_CODE_NOT_ZERO"] },
	};
}

function allowedLane(authorityHash: string, path = "src/lane.ts"): DelegationPathLaneAdmissionV1 {
	return {
		schema_version: 1,
		kind: "delegation-path-lane-admission-v1",
		authority_hash: authorityHash,
		ordinary_blocker_ids: [],
		repair_tip_ids: [],
		repair_tip_exclusion_id: null,
		blockers: [],
		decision: {
			schema_version: 1,
			kind: "delegation-path-lane-decision-v1",
			decision: "ALLOW",
			block_reasons: [],
			normalized_allowed_paths: [path],
			conflicts: [],
			authority_failures: [],
			maintenance_warnings: [],
		},
	};
}

function allowedHistoricalLane(
	authorityHash: string,
	blockerId: string,
	requestedPath = "docs/fresh-lane.md",
): DelegationPathLaneAdmissionV1 {
	return {
		schema_version: 1,
		kind: "delegation-path-lane-admission-v1",
		authority_hash: authorityHash,
		ordinary_blocker_ids: [blockerId],
		repair_tip_ids: [],
		repair_tip_exclusion_id: null,
		blockers: [{
			kind: "known",
			delegation_id: blockerId,
			changed_paths: ["src/historical-lane.ts"],
			carried_paths: [],
			rename_sources: {},
		}],
		decision: {
			schema_version: 1,
			kind: "delegation-path-lane-decision-v1",
			decision: "ALLOW",
			block_reasons: [],
			normalized_allowed_paths: [requestedPath],
			conflicts: [],
			authority_failures: [],
			maintenance_warnings: [{
				code: "NON_OVERLAPPING_HISTORICAL_BLOCKER",
				delegation_id: blockerId,
				relevant_paths: ["src/historical-lane.ts"],
			}],
		},
	};
}

function successfulExecution(delegationId: string, path: string) {
	return {
		ok: true,
		status: "PENDING_REVIEW",
		delegation_id: delegationId,
		durable_state: { status: "PENDING_REVIEW", postcondition_reasons: [] },
		after: { diffHash: "b".repeat(64), changedSinceBefore: [path] },
		result: {
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			turns: 1,
			exitCode: 0,
		},
		workerSummary: {
			report_path: `.pi/workbench/delegations/${delegationId}/v2/generations/g00000001/worker-report.md`,
			changed_paths: [path],
		},
	};
}

function controller(input: {
	readonly root: string;
	readonly delegationId: string;
	readonly executeDelegation: (input: ExecuteInput) => Promise<unknown>;
	readonly completeDefaultDelivery?: (input: DeliveryInput) => Promise<unknown>;
	readonly persistDelegationStateStrict?: (state: DelegationState) => void;
	readonly readTransaction?: () => Promise<unknown>;
	readonly admitPathLane?: NonNullable<DelegateToolServices["admitPathLane"]>;
	readonly revalidatePathLane?: NonNullable<DelegateToolServices["revalidatePathLane"]>;
	readonly releaseStartLock?: DelegateToolServices["releaseStartLock"];
	readonly initialState?: DelegationState;
	readonly collectCurrentDelegationBinding?: DelegateToolController<unknown>["collectCurrentDelegationBinding"];
}) {
	let state: DelegationState = input.initialState ?? emptyDelegationState();
	return registerDelegateTool({
		pi: { registerTool() {} },
		services: {
			now: () => NOW,
			makeDelegationId: () => input.delegationId,
			acquireStartLock: acquireProjectDelegationStartLockV1,
			releaseStartLock: input.releaseStartLock ?? releaseProjectDelegationStartLockV1,
			readCommittedGeneration: async () => ({ ok: false, error: { code: "not_found" } }),
				...(input.readTransaction === undefined ? {} : { readTransaction: input.readTransaction }),
				...(input.admitPathLane === undefined ? {} : { admitPathLane: input.admitPathLane }),
				...(input.revalidatePathLane === undefined ? {} : { revalidatePathLane: input.revalidatePathLane }),
			readRecoverableUnpublished: async () => ({ ok: false, error: { code: "not_recoverable" } }),
			readLegacyLedger: async () => null,
			executeDelegation: input.executeDelegation,
			persistResumeAuthority: async () => ({ ok: true, value: {} }) as never,
			completeDefaultDelivery: input.completeDefaultDelivery ?? (async () => { throw new Error("delivery must not run"); }),
			buildTrustedRecoveryAuthority: async () => ({}),
		},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		secrets: [],
		trustedOrError: () => undefined,
		projectRootFor: async () => input.root,
		getMode: () => "DEV",
		reconcileProjectAuthority: async () => true,
		getProjectAuthorityBlockReason: () => undefined,
		collectCurrentDelegationBinding: input.collectCurrentDelegationBinding ?? (async () => ({ status: "fresh", hash: "a".repeat(64) })),
		projectTerminalReviewedBinding: async () => null,
		getDelegationState: () => state,
		setDelegationState: (next: DelegationState) => { state = next; },
		persistDelegationState: () => {},
		persistDelegationStateStrict: input.persistDelegationStateStrict ?? (() => {}),
		markTerminalMirrorBlocked: () => {},
		refreshStatus: async () => {},
		bindTrustedIngressAuthority: () => undefined,
		rememberTrustedIngressAuthority: () => {},
	} as unknown as DelegateToolController<unknown>);
}

test("a known non-overlapping historical session blocker does not require its unavailable live binding", async () => {
	await withTempDir(async (root) => {
		const blockerId = "20260827-085950-hist";
		const admission = allowedHistoricalLane("c".repeat(64), blockerId);
		let bindingReads = 0;
		let executions = 0;
		const handle = controller({
			root,
			delegationId: "20260827-085951-next",
			initialState: {
				latestId: blockerId,
				status: "PENDING_REVIEW",
				currentDiffHash: "a".repeat(64),
				blockedWriteAttempts: 0,
				updatedAt: NOW.toISOString(),
			},
			collectCurrentDelegationBinding: async () => {
				bindingReads += 1;
				return { status: "unavailable" };
			},
			admitPathLane: async () => admission,
			revalidatePathLane: async (input) => ({
				schema_version: 1,
				kind: "delegation-path-lane-revalidation-v1",
				expected_authority_hash: input.expected_authority_hash,
				observed_authority_hash: admission.authority_hash,
				unchanged: true,
				admission,
			}),
			executeDelegation: async () => {
				executions += 1;
				return terminalFailure();
			},
		});
		await assert.rejects(
			handle.execute("historical-binding-unavailable", params("docs/fresh-lane.md"), undefined, undefined,
				context(root, "historical-binding-unavailable")),
			/durable_status=FAILED/u,
		);
		assert.equal(bindingReads, 0, "the session mirror cannot reintroduce a global live-binding blocker after strict admission");
		assert.equal(executions, 1, "the known disjoint lane reaches the durable execution boundary");
	});
});

test("path-lane authority drift under the writer lease stops before PREPARED and releases the lease", async () => {
	await withTempDir(async (root) => {
		const before = allowedLane("a".repeat(64), "src/toctou.ts");
		const after = allowedLane("b".repeat(64), "src/toctou.ts");
		let admissionCalls = 0;
		let revalidationCalls = 0;
		let executionCalls = 0;
		const handle = controller({
			root,
			delegationId: "20260827-085959-z000",
			admitPathLane: async () => {
				admissionCalls += 1;
				return before;
			},
			revalidatePathLane: async (input) => {
				revalidationCalls += 1;
				return {
					schema_version: 1,
					kind: "delegation-path-lane-revalidation-v1",
					expected_authority_hash: input.expected_authority_hash,
					observed_authority_hash: after.authority_hash,
					unchanged: false,
					admission: after,
				};
			},
			executeDelegation: async () => {
				executionCalls += 1;
				return terminalFailure();
			},
		});
		await assert.rejects(
			handle.execute("lane-toctou", params("src/toctou.ts"), undefined, undefined, context(root, "lane-toctou")),
			/path lane revalidation blocked before PREPARED: authority changed/u,
		);
		assert.equal(admissionCalls, 1);
		assert.equal(revalidationCalls, 1);
		assert.equal(executionCalls, 0, "PREPARED-capable execution is never called after authority drift");
		await assert.rejects(readFile(lockPath(root), "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	});
});

test("two controllers serialize disjoint paths until the first worker execution reaches a terminal failure", async () => {
	await withTempDir(async (root) => {
		const entered = deferred();
		const finish = deferred();
		let executions = 0;
		const first = controller({
			root,
			delegationId: "20260827-090000-a001",
			executeDelegation: async (input) => {
				executions += 1;
				await input.onPrepared?.({}, { diffHash: "a".repeat(64) });
				entered.resolve();
				await finish.promise;
				return terminalFailure();
			},
		});
		const contender = controller({
			root,
			delegationId: "20260827-090001-b002",
			executeDelegation: async () => {
				executions += 1;
				return terminalFailure();
			},
		});
		const firstRun = first.execute(
			"writer-first",
			params("src/lane-a.ts"),
			undefined,
			undefined,
			context(root, "writer-first"),
		).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		await entered.promise;
		const owner = JSON.parse(await readFile(lockPath(root), "utf8")) as Record<string, unknown>;
		assert.equal(owner.delegation_id, "20260827-090000-a001");
		await assert.rejects(
			contender.execute(
				"writer-conflict",
				params("src/lane-b.ts"),
				undefined,
				undefined,
				context(root, "writer-conflict"),
			),
			/project start lock conflict/u,
			"disjoint paths do not grant parallel checkout writes",
		);
		assert.equal(executions, 1, "the conflicting controller never reaches execution");

		finish.resolve();
		const outcome = await firstRun;
		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.match(String(outcome.error), /durable_status=FAILED/u);
		await assert.rejects(readFile(lockPath(root), "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

		const retry = controller({
			root,
			delegationId: "20260827-090002-c003",
			executeDelegation: async () => {
				executions += 1;
				return terminalFailure();
			},
		});
		await assert.rejects(
			retry.execute("writer-retry", params("src/lane-b.ts"), undefined, undefined, context(root, "writer-retry")),
			/durable_status=FAILED/u,
		);
		assert.equal(executions, 2, "a fresh controller reaches execution only after release");
	});
});

test("the same checkout lock remains held through mechanical delivery and releases when delivery throws", async () => {
	await withTempDir(async (root) => {
		const deliveryEntered = deferred();
		const finishDelivery = deferred();
		let executions = 0;
		let deliveries = 0;
		const firstId = "20260827-091000-d004";
		const first = controller({
			root,
			delegationId: firstId,
			executeDelegation: async (input) => {
				executions += 1;
				await input.onPrepared?.({}, { diffHash: "a".repeat(64) });
				return successfulExecution(firstId, "src/delivery-a.ts");
			},
			completeDefaultDelivery: async () => {
				deliveries += 1;
				deliveryEntered.resolve();
				await finishDelivery.promise;
				throw new Error("injected delivery/review throw");
			},
		});
		const contender = controller({
			root,
			delegationId: "20260827-091001-e005",
			executeDelegation: async () => {
				executions += 1;
				return terminalFailure();
			},
		});
		const firstRun = first.execute(
			"delivery-first",
			params("src/delivery-a.ts", "implementation"),
			undefined,
			undefined,
			context(root, "delivery-first"),
		).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		await deliveryEntered.promise;
		assert.equal(executions, 1);
		assert.equal(deliveries, 1);
		await assert.rejects(
			contender.execute(
				"delivery-conflict",
				params("src/delivery-b.ts"),
				undefined,
				undefined,
				context(root, "delivery-conflict"),
			),
			/project start lock conflict/u,
		);
		assert.equal(executions, 1, "the contender cannot execute during delivery");

		finishDelivery.resolve();
		const outcome = await firstRun;
		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.match(String(outcome.error), /injected delivery\/review throw/u);
		await assert.rejects(readFile(lockPath(root), "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

		const retry = controller({
			root,
			delegationId: "20260827-091002-f006",
			executeDelegation: async () => {
				executions += 1;
				return terminalFailure();
			},
		});
		await assert.rejects(
			retry.execute("delivery-retry", params("src/delivery-b.ts"), undefined, undefined, context(root, "delivery-retry")),
			/durable_status=FAILED/u,
		);
		assert.equal(executions, 2);
	});
});

test("PREPARED session mirror failure is advisory while unresolved post-PREPARED execution still retains its lease", async () => {
	await withTempDir(async (root) => {
		let mirrorWrites = 0;
		const aborted = controller({
			root,
			delegationId: "20260827-092000-g007",
			executeDelegation: async (input) => {
				await input.onPrepared?.({}, { diffHash: "a".repeat(64) });
				return terminalFailure("runner_failed", "FAILED");
			},
			readTransaction: async () => ({ ok: true, value: { status: "PREPARED" } }),
			persistDelegationStateStrict: () => {
				mirrorWrites += 1;
				throw new Error("injected PREPARED session mirror append failure");
			},
		});
		await assert.rejects(
			aborted.execute("abort", params("src/abort.ts"), undefined, undefined, context(root, "abort")),
			/durable_status=FAILED.*warning=session_mirror_append_failed.*durable_readback=confirmed/us,
		);
		assert.equal(mirrorWrites, 1);
		await assert.rejects(readFile(lockPath(root), "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

		const prePreparedThrow = controller({
			root,
			delegationId: "20260827-092001-h008",
			executeDelegation: async () => { throw new Error("injected pre-PREPARED execution throw"); },
		});
		await assert.rejects(
			prePreparedThrow.execute("pre-throw", params("src/pre-throw.ts"), undefined, undefined, context(root, "pre-throw")),
			/injected pre-PREPARED execution throw/u,
		);
		await assert.rejects(readFile(lockPath(root), "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

		const throwing = controller({
			root,
			delegationId: "20260827-092002-i009",
			executeDelegation: async (input) => {
				await input.onPrepared?.({}, { diffHash: "a".repeat(64) });
				throw new Error("injected execution throw");
			},
		});
		await assert.rejects(
			throwing.execute("throw", params("src/throw.ts"), undefined, undefined, context(root, "throw")),
			/injected execution throw/u,
		);
		const postPreparedInspection = await inspectProjectDelegationStartLockV1(root);
		assert.equal(postPreparedInspection.ok, true);
		if (postPreparedInspection.ok && postPreparedInspection.value.status !== "absent") {
			assert.equal(postPreparedInspection.value.status, "live");
			assert.equal(postPreparedInspection.value.owner.delegation_id, "20260827-092002-i009");
		}
		let conflictingExecutions = 0;
		const contender = controller({
			root,
			delegationId: "20260827-092003-j010",
			executeDelegation: async () => {
				conflictingExecutions += 1;
				return terminalFailure();
			},
		});
		await assert.rejects(
			contender.execute("post-throw-conflict", params("src/contender.ts"), undefined, undefined, context(root, "post-throw-conflict")),
			/project start lock conflict/u,
		);
		assert.equal(conflictingExecutions, 0, "an ambiguous post-PREPARED throw never admits a second writer");
		if (postPreparedInspection.ok && postPreparedInspection.value.status !== "absent") {
			assert.equal((await releaseProjectDelegationStartLockV1(postPreparedInspection.value.lease)).ok, true);
			assert.equal(forgetRecoveredProjectCheckoutOperationV1(root, postPreparedInspection.value.lease.token), true);
		}

		const prepared = controller({
			root,
			delegationId: "20260827-092004-k011",
			executeDelegation: async () => terminalFailure("start_failed", "PREPARED"),
		});
		await assert.rejects(
			prepared.execute("prepared", params("src/prepared.ts"), undefined, undefined, context(root, "prepared")),
			/durable_status=PREPARED/u,
		);
		const inspection = await inspectProjectDelegationStartLockV1(root);
		assert.equal(inspection.ok, true);
		if (inspection.ok) {
			assert.equal(inspection.value.status, "live");
			assert.equal(inspection.value.owner.delegation_id, "20260827-092004-k011");
			assert.equal((await releaseProjectDelegationStartLockV1(inspection.value.lease)).ok, true);
			assert.equal(forgetRecoveredProjectCheckoutOperationV1(root, inspection.value.lease.token), true);
		}
		const next = await acquireProjectDelegationStartLockV1({
			project_root: root,
			delegation_id: "20260827-092005-l012",
			now: NOW.toISOString(),
		});
		assert.equal(next.ok, true);
		if (next.ok) assert.equal((await releaseProjectDelegationStartLockV1(next.value)).ok, true);
	});
});

test("an abort signal keeps the writer lease until execution returns a terminal failure, then releases it", async () => {
	await withTempDir(async (root) => {
		const entered = deferred();
		const abort = new AbortController();
		const tool = controller({
			root,
			delegationId: "20260827-093000-k011",
			executeDelegation: async (input) => {
				await input.onPrepared?.({}, { diffHash: "a".repeat(64) });
				entered.resolve();
				await new Promise<void>((resolve) => {
					if (input.signal?.aborted === true) resolve();
					else input.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return terminalFailure("runner_failed", "FAILED");
			},
		});
		const running = tool.execute(
			"abort-signal",
			params("src/abort-signal.ts"),
			abort.signal,
			undefined,
			context(root, "abort-signal"),
		).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		await entered.promise;
		assert.equal((JSON.parse(await readFile(lockPath(root), "utf8")) as Record<string, unknown>).delegation_id,
			"20260827-093000-k011");
		abort.abort();
		const outcome = await running;
		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.match(String(outcome.error), /durable_status=FAILED/u);
		await assert.rejects(readFile(lockPath(root), "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	});
});

test("a direct delegate safe-release fault is process-settled and recovered before the next writer", async () => {
	await withTempDir(async (root) => {
		const delegationId = "20260827-094000-m013";
		const tool = controller({
			root,
			delegationId,
			executeDelegation: async () => terminalFailure("runner_failed", "FAILED"),
			releaseStartLock: async () => ({
				ok: false,
				error: { code: "storage_failure", message: "injected direct release fault", operation: "release" },
			}),
		});
		await assert.rejects(
			tool.execute("direct-release-fault", params("src/direct-release.ts"), undefined, undefined,
				context(root, "direct-release-fault")),
			/project start lock release storage_failure/u,
		);
		const inspected = await inspectProjectDelegationStartLockV1(root);
		assert.equal(inspected.ok, true);
		if (!inspected.ok || inspected.value.status === "absent") return;
		assert.equal(inspectProcessCheckoutOperationV1(root, inspected.value.lease.token), "settled");

		const next = await acquireProjectCheckoutOperationV1({
			project_root: root,
			operation_kind: "tool",
			operation_id: "tool:after-direct-release-fault",
			now: "2026-08-27T09:40:01.000Z",
		});
		assert.equal(next.ok, true, next.ok ? "" : next.error.message);
		if (next.ok) assert.equal((await releaseProjectCheckoutOperationV1(next.value)).ok, true);
	});
});
