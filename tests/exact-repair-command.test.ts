import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	computeChangeSetHash,
	computeWorkerDeltaHash,
	type ChangeSetRecord,
} from "../extensions/workbench-runtime/core/change-set.ts";
import {
	registerDelegateTool,
	type DelegateToolServices,
} from "../extensions/workbench-runtime/core/delegate-tool-controller.ts";
import {
	recoverExactRepairCommandAuthorityV1,
	type ExactRepairCommandAuthorityV1,
	type ExactRepairTerminalNegativeSolAuthorityV1,
} from "../extensions/workbench-runtime/core/exact-repair-authority.ts";
import { emptyDelegationState } from "../extensions/workbench-runtime/core/delegation-state.ts";
import type { DelegationPathLaneAdmissionV1 } from "../extensions/workbench-runtime/core/delegation-path-lane-admission.ts";
import { normalizeDelegationBoundedTaskContractV2 } from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import { bindDelegationRepairLineageV1 } from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import type {
	DelegationCommittedGenerationV2,
	DelegationSemanticRepairDecisionV1,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	exactRepairResultRequiresReconcileV1,
	exactRepairCommandDelegationIdV1,
	registerExactRepairCommandV1,
} from "../extensions/workbench-runtime/core/exact-repair-command.ts";
import { buildSemanticReviewEnvelopeV1 } from "../extensions/workbench-runtime/core/semantic-review-envelope.ts";
import { withTempDir } from "./helpers.ts";

const ID = "20260827-010203-qrep";
const BOUND_DIFF_HASH = "9".repeat(64);
const TERMINAL_TIME = "2026-08-27T01:02:03.000Z";
const DECISION_TIME = "2026-08-27T01:02:04.000Z";

interface CapturedCommand {
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

function context(model = { provider: "openai-codex", id: "gpt-5.6-sol" }): ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/project",
		isProjectTrusted: () => true,
		model: { ...model, api: "responses" },
		waitForIdle: async () => {},
		ui: { notify: () => {} },
		signal: undefined,
	} as unknown as ExtensionCommandContext;
}

function exactChangeSet(contractHash: string): ChangeSetRecord {
	const path = "src/exact.ts";
	const workerDelta = [{
		path,
		change: "new" as const,
		operation_count: 1,
		before: { schema_version: 2 as const, kind: "missing" as const, path },
		after: {
			schema_version: 2 as const,
			kind: "file" as const,
			path,
			byte_size: 1,
			sha256: "1".repeat(64),
			stat: { dev: "1", ino: "2", mtime_ns: "3", ctime_ns: "4" },
		},
	}];
	const withoutHash: Omit<ChangeSetRecord, "change_set_hash"> = {
		schema_version: 2,
		delegation_id: ID,
		contract_hash: contractHash,
		journal_hash: "2".repeat(64),
		before_workspace_guard_hash: "3".repeat(64),
		after_workspace_guard_hash: "4".repeat(64),
		dependency_paths: [],
		status: "ATTRIBUTED",
		worker_delta: workerDelta,
		workspace_drift: [],
		conflicts: [],
		finalization_meter: { paths_attempted: 1, paths_completed: 1, bytes_read: 1 },
		counts: {
			touched_paths: 1,
			attributed_paths: 1,
			zero_delta_paths: 0,
			workspace_drift_paths: 0,
			dependency_drift_paths: 0,
			unknown_origin_drift_paths: 0,
			conflict_paths: 0,
		},
		worker_delta_hash: computeWorkerDeltaHash(workerDelta, []),
		workspace_guard_hash: "4".repeat(64),
	};
	return { ...withoutHash, change_set_hash: computeChangeSetHash(withoutHash) };
}

function sha(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function terminalNegativeCommitted(
	status: "INTERRUPTED" | "FAILED",
	legacyOutcome = false,
): DelegationCommittedGenerationV2 {
	const contract = normalizeDelegationBoundedTaskContractV2({
		task_kind: "implementation",
		task: "Continue the bounded partial implementation.",
		allowed_paths: ["src/**"],
		acceptance_criteria: ["The interrupted implementation is completed."],
		verification: [],
		timeout_seconds: 600,
		budget_profile: "extended",
	});
	if (!contract.ok) assert.fail(contract.error.code);
	const changeSet = exactChangeSet(contract.value.contract_hash);
	const envelope = buildSemanticReviewEnvelopeV1({
		streams: [{
			path: "src/exact.ts",
			source: "compact",
			stream_bytes: 1,
			stream_sha256: sha("terminal-negative-stream"),
			page_count: 1,
		}],
		projected_review_record_bytes: 1_024,
		relevance_projection_hash: BOUND_DIFF_HASH,
	});
	if (!envelope.ok) assert.fail(envelope.code);
	const proof = { schema_version: 2, delegation_id: ID, content_hash: "c".repeat(64) };
	return {
		state: {
			schema_version: 2,
			delegation_id: ID,
			status,
			task_kind: "implementation",
			contract_hash: contract.value.contract_hash,
			allowed_paths: ["src/**"],
			worker_identity: { provider: "openai", model: "gpt-5.6-luna", worker_id: "worker:test" },
			generation: 1,
			revision: 3,
			created_at: TERMINAL_TIME,
			updated_at: TERMINAL_TIME,
			postcondition_reasons: ["WORKER_RUN_FAILED"],
			terminal_outcome: {
				delegation_id: ID,
				task_kind: "implementation",
				worker_identity: { provider: "openai", model: "gpt-5.6-luna", worker_id: "worker:test" },
				provider_success: true,
				...(legacyOutcome ? {} : { worker_success: false, worker_failure_code: "TURN_LIMIT" }),
				exit_code: 0,
				report_complete: true,
				terminal_facts_complete: true,
				scope_complete: true,
				change_set_status: "ATTRIBUTED",
				changed_paths: ["src/exact.ts"],
				successful_write_count: 1,
				denied_write_count: 0,
				delta_hash: changeSet.worker_delta_hash,
			},
			committed_proof: proof,
			review: null,
			abort_reason: null,
			recovery_reason: null,
		},
		records: {
			"before.json": { contract: contract.value },
			"scope.json": {
				allowed_paths: ["src/**"],
				changed_paths: ["src/exact.ts"],
				change_set: changeSet,
			},
			"after.json": status === "INTERRUPTED" ? { review_envelope: envelope.value } : {},
		},
		proof,
	} as unknown as DelegationCommittedGenerationV2;
}

function terminalNegativeAuthority(
	committed: DelegationCommittedGenerationV2,
): ExactRepairTerminalNegativeSolAuthorityV1 {
	const reason = "Continue the complete in-scope partial implementation under Sol review.";
	const payload: Omit<DelegationSemanticRepairDecisionV1, "decision_hash"> = {
		schema_version: 1,
		delegation_id: ID,
		contract_hash: committed.state.contract_hash,
		generation: committed.state.generation,
		transaction_revision: 3,
		generation_content_hash: committed.proof.content_hash,
		base_review_hash: "8".repeat(64),
		expected_bound_diff_hash: BOUND_DIFF_HASH,
		decision: "REPAIR",
		repair_reason: reason,
		repair_reason_hash: sha(reason),
		reviewer: { provider: "openai-codex", model: "gpt-5.6-sol" },
		decided_at: DECISION_TIME,
	};
	return {
		state: structuredClone(committed.state),
		review_hash: payload.base_review_hash,
		bound_diff_hash: BOUND_DIFF_HASH,
		decision: { ...payload, decision_hash: canonicalHash(payload) },
	};
}

function exactTipLaneAdmission(
	repairTipId: string,
	authorityHash = "a".repeat(64),
): DelegationPathLaneAdmissionV1 {
	return {
		schema_version: 1,
		kind: "delegation-path-lane-admission-v1",
		authority_hash: authorityHash,
		ordinary_blocker_ids: [],
		repair_tip_ids: [repairTipId],
		repair_tip_exclusion_id: repairTipId,
		blockers: [{
			kind: "known",
			delegation_id: repairTipId,
			changed_paths: ["src/exact.ts"],
			carried_paths: [],
			rename_sources: {},
		}],
		decision: {
			schema_version: 1,
			kind: "delegation-path-lane-decision-v1",
			decision: "ALLOW",
			block_reasons: [],
			normalized_allowed_paths: ["src/**"],
			conflicts: [],
			authority_failures: [],
			maintenance_warnings: [],
		},
	};
}

test("q-repair accepts exactly one canonical delegation id", () => {
	assert.equal(exactRepairCommandDelegationIdV1(ID), ID);
	assert.equal(exactRepairCommandDelegationIdV1(`  ${ID}  `), ID);
	assert.equal(exactRepairCommandDelegationIdV1(`${ID} extra`), undefined);
	assert.equal(exactRepairCommandDelegationIdV1("repair_of=20260827-010203-qrep"), undefined);
});

test("q-repair reconciles ACTIVE disposition for committed and raw replay results only", () => {
	assert.equal(exactRepairResultRequiresReconcileV1({ status: "SUCCESSOR_ACTIVE" } as never), true);
	assert.equal(exactRepairResultRequiresReconcileV1({
		status: "RAW_SUCCESSOR_REPLAY",
		successor: { disposition: "ACTIVE" },
	} as never), true);
	assert.equal(exactRepairResultRequiresReconcileV1({
		status: "RAW_SUCCESSOR_REPLAY",
		successor: { disposition: "EXACT_REPAIR_PENDING" },
	} as never), false);
	assert.equal(exactRepairResultRequiresReconcileV1({ status: "SUCCESSOR_RECORDED" } as never), false);
});

test("delegate tool registration keeps exact repair off the model-callable execute surface", () => {
	let registered: { execute?: unknown } | undefined;
	const handle = registerDelegateTool({
		pi: { registerTool(definition: unknown) { registered = definition as { execute?: unknown }; } },
	} as never);
	assert.ok(registered);
	assert.equal(handle.execute, registered.execute);
	assert.notEqual(handle.executeExactRepair, registered.execute,
		"the in-process authority bridge must not be exposed as model tool input");
});

test("q-repair rejects a stale loaded runtime before trust, authority reads, or execution", async () => {
	let command: CapturedCommand | undefined;
	let waits = 0;
	let trustChecks = 0;
	let rootReads = 0;
	let committedReads = 0;
	let executions = 0;
	const output: string[] = [];
	registerExactRepairCommandV1({
		pi: { registerCommand(_name: string, definition: unknown) { command = definition as CapturedCommand; } } as never,
		execution: {
			execute: (async () => { throw new Error("must not execute"); }) as never,
			executeExactRepair: (async () => { executions += 1; throw new Error("must not execute"); }) as never,
		},
		readCommittedGeneration: (async () => { committedReads += 1; throw new Error("must not read"); }) as never,
		readReview: (async () => { throw new Error("must not read"); }) as never,
		readTerminalNegativeRepair: (async () => { throw new Error("must not read"); }) as never,
		readSuccessor: (async () => { throw new Error("must not read"); }) as never,
		collectCurrentBinding: async () => { throw new Error("must not collect"); },
		getMode: () => "DEV",
		runtimeCurrentOrError: () => "loaded workbench runtime is STALE",
		trustedOrError: () => { trustChecks += 1; return undefined; },
		projectRootFor: async () => { rootReads += 1; return "/project"; },
		reconcileProjectAuthority: async () => true,
		output: (_ctx, lines) => { output.push(lines.join("\n")); },
	});
	assert.ok(command);
	const ctx = { ...context(), waitForIdle: async () => { waits += 1; } } as unknown as ExtensionCommandContext;
	await command.handler(ID, ctx);
	assert.equal(waits, 1);
	assert.equal(trustChecks, 0);
	assert.equal(rootReads, 0);
	assert.equal(committedReads, 0);
	assert.equal(executions, 0);
	assert.match(output.join("\n"), /runtime is STALE/u);
});

test("q-repair enforces trust, DEV, and Sol before durable authority reads", async () => {
	for (const scenario of [
		{ name: "trust", trust: "project is not trusted", mode: "DEV" as const, model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
		{ name: "mode", trust: undefined, mode: "VERIFY" as const, model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
		{ name: "model", trust: undefined, mode: "DEV" as const, model: { provider: "openai-codex", id: "gpt-5.6-luna" } },
	] as const) {
		let command: CapturedCommand | undefined;
		let committedReads = 0;
		const output: string[] = [];
		registerExactRepairCommandV1({
			pi: { registerCommand(_name: string, definition: unknown) { command = definition as CapturedCommand; } } as never,
			execution: {
				execute: (async () => { throw new Error("must not execute"); }) as never,
				executeExactRepair: (async () => { throw new Error("must not execute"); }) as never,
			},
			readCommittedGeneration: (async () => { committedReads += 1; throw new Error("must not read"); }) as never,
			readReview: (async () => { throw new Error("must not read"); }) as never,
			readTerminalNegativeRepair: (async () => { throw new Error("must not read"); }) as never,
			readSuccessor: (async () => { throw new Error("must not read"); }) as never,
			collectCurrentBinding: async () => { throw new Error("must not collect"); },
			getMode: () => scenario.mode,
			runtimeCurrentOrError: () => undefined,
			trustedOrError: () => scenario.trust,
			projectRootFor: async () => "/project",
			reconcileProjectAuthority: async () => true,
			output: (_ctx, lines) => { output.push(lines.join("\n")); },
		});
		assert.ok(command, scenario.name);
		await command.handler(ID, context(scenario.model));
		assert.equal(committedReads, 0, scenario.name);
		assert.equal(output.length, 1, scenario.name);
	}
});

test("q-repair preserves immutable replay-first ordering before any reconciliation", async () => {
	let command: CapturedCommand | undefined;
	let committedReads = 0;
	let executions = 0;
	let reconciliations = 0;
	const output: string[] = [];
	registerExactRepairCommandV1({
		pi: { registerCommand(_name: string, definition: unknown) { command = definition as CapturedCommand; } } as never,
		execution: {
			execute: (async () => { throw new Error("must not execute"); }) as never,
			executeExactRepair: (async () => { executions += 1; throw new Error("must not execute"); }) as never,
		},
		readCommittedGeneration: (async () => {
			committedReads += 1;
			assert.equal(reconciliations, 0);
			return { ok: false, error: { code: "not_found" } };
		}) as never,
		readReview: (async () => { throw new Error("must not read"); }) as never,
		readTerminalNegativeRepair: (async () => { throw new Error("must not read"); }) as never,
		readSuccessor: (async () => { throw new Error("must not read"); }) as never,
		collectCurrentBinding: async () => { throw new Error("must not collect"); },
		getMode: () => "DEV",
		runtimeCurrentOrError: () => undefined,
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
		reconcileProjectAuthority: async () => { reconciliations += 1; return false; },
		output: (_ctx, lines) => { output.push(lines.join("\n")); },
	});
	assert.ok(command);
	await command.handler(ID, context());
	assert.equal(committedReads, 1);
	assert.equal(executions, 0);
	assert.equal(reconciliations, 0);
	assert.match(output.join("\n"), /RAW_TIP_NOT_RETRYABLE/u);
});

test("q-repair returns an existing durable successor without invoking shared execution again", async () => {
	const rootId = "20260827-010100-root";
	const contract = normalizeDelegationBoundedTaskContractV2({
		task_kind: "implementation",
		task: "Repair one exact rejected path.",
		allowed_paths: ["src/exact.ts"],
		acceptance_criteria: ["The rejected behavior is corrected."],
		verification: [],
		timeout_seconds: 600,
		budget_profile: "extended",
	});
	assert.equal(contract.ok, true);
	if (!contract.ok) return;
	const lineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: rootId,
		repair_of: rootId,
		root_decision_hash: "b".repeat(64),
		continuation_decision_delegation_id: rootId,
		continuation_decision_hash: "b".repeat(64),
		parent_lineage_hash: null,
		depth: 1,
		carried_paths: ["src/exact.ts"],
	});
	assert.ok(lineage);
	const proof = { schema_version: 2, delegation_id: ID, content_hash: "c".repeat(64) };
	const changeSet = exactChangeSet(contract.value.contract_hash);
	const committed = {
		state: {
			schema_version: 2,
			delegation_id: ID,
			status: "FAILED",
			task_kind: "implementation",
			contract_hash: contract.value.contract_hash,
			allowed_paths: ["src/exact.ts"],
			worker_identity: { provider: "openai", model: "gpt-5.6-luna", worker_id: "worker:test" },
			generation: 1,
			revision: 3,
			created_at: "2026-08-27T01:02:03.000Z",
			updated_at: "2026-08-27T01:02:04.000Z",
			postcondition_reasons: ["WORKER_RUN_FAILED"],
			terminal_outcome: {
				delegation_id: ID,
				task_kind: "implementation",
				worker_identity: { provider: "openai", model: "gpt-5.6-luna", worker_id: "worker:test" },
				provider_success: true,
				worker_success: false,
				worker_failure_code: "TURN_LIMIT",
				exit_code: 0,
				report_complete: true,
				terminal_facts_complete: true,
				scope_complete: true,
				change_set_status: "ATTRIBUTED",
				changed_paths: ["src/exact.ts"],
				successful_write_count: 1,
				denied_write_count: 0,
				delta_hash: changeSet.worker_delta_hash,
			},
			committed_proof: proof,
			review: null,
			abort_reason: null,
			recovery_reason: null,
			repair_lineage: lineage,
		},
		records: {
			"before.json": { contract: contract.value },
			"scope.json": {
				allowed_paths: ["src/exact.ts"],
				changed_paths: ["src/exact.ts"],
				change_set: changeSet,
			},
		},
		proof,
	} as unknown as DelegationCommittedGenerationV2;
	let command: CapturedCommand | undefined;
	let reviews = 0;
	let successorReads = 0;
	let executions = 0;
	let waits = 0;
	let reconciliations = 0;
	const output: string[] = [];
	registerExactRepairCommandV1({
		pi: { registerCommand(_name: string, definition: unknown) { command = definition as CapturedCommand; } } as never,
		execution: {
			execute: (async () => { throw new Error("replay must not execute"); }) as never,
			executeExactRepair: (async () => { executions += 1; throw new Error("replay must not execute"); }) as never,
		},
		readCommittedGeneration: (async () => ({ ok: true, value: committed })) as never,
		readReview: (async () => { reviews += 1; throw new Error("terminal replay must not read review"); }) as never,
		readTerminalNegativeRepair: (async () => { throw new Error("lineaged terminal replay must not read terminal-negative authority"); }) as never,
		readSuccessor: (async () => {
			successorReads += 1;
			return {
				ok: true,
				kind: "existing",
				value: {
					delegation_id: "20260827-010204-next",
					status: "PREPARED",
					contract_hash: "d".repeat(64),
					transaction_hash: "e".repeat(64),
					committed_proof_content_hash: null,
					disposition: "ACTIVE",
				},
			};
		}) as never,
		collectCurrentBinding: async () => { throw new Error("lineaged terminal replay does not need exact binding"); },
		getMode: () => "DEV",
		runtimeCurrentOrError: () => undefined,
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
		reconcileProjectAuthority: async () => { reconciliations += 1; return true; },
		output: (_ctx, lines) => { output.push(lines.join("\n")); },
	});
	assert.ok(command);
	await command.handler(ID, {
		...context(),
		waitForIdle: async () => { waits += 1; },
	} as unknown as ExtensionCommandContext);
	assert.equal(waits, 1);
	assert.equal(reviews, 0);
	assert.equal(successorReads, 2);
	assert.equal(executions, 0);
	assert.equal(reconciliations, 1);
	assert.match(output.join("\n"), /exact successor already active; no second worker was started/u);
});

test("q-repair sends INTERRUPTED and legacy FAILED terminal-negative authority through the private bridge", async () => {
	for (const scenario of [
		{ status: "INTERRUPTED" as const, legacy: false },
		{ status: "FAILED" as const, legacy: true },
	]) {
		const committed = terminalNegativeCommitted(scenario.status, scenario.legacy);
		const sidecar = terminalNegativeAuthority(committed);
		let command: CapturedCommand | undefined;
		let publicExecutions = 0;
		let exactExecutions = 0;
		let successorReads = 0;
		let capturedAuthority: Parameters<ReturnType<typeof registerDelegateTool>["executeExactRepair"]>[0] | undefined;
		const output: string[] = [];
		registerExactRepairCommandV1({
			pi: { registerCommand(_name: string, definition: unknown) { command = definition as CapturedCommand; } } as never,
			execution: {
				execute: (async () => { publicExecutions += 1; throw new Error("public model route must not execute"); }) as never,
				executeExactRepair: (async (authority: ExactRepairCommandAuthorityV1) => {
					exactExecutions += 1;
					capturedAuthority = authority;
					return { content: [{ type: "text", text: "worker completed" }], details: { ok: true } };
				}) as never,
			},
			readCommittedGeneration: (async () => ({ ok: true, value: committed })) as never,
			readReview: (async () => { throw new Error("terminal-negative repair must not use ordinary review"); }) as never,
			readTerminalNegativeRepair: (async () => ({ ok: true, value: sidecar })) as never,
			readSuccessor: (async () => {
				successorReads += 1;
				return successorReads === 1
					? { ok: true, kind: "none" }
					: {
						ok: true,
						kind: "existing",
						value: {
							delegation_id: "20260827-010204-next",
							status: "PREPARED",
							contract_hash: "d".repeat(64),
							transaction_hash: "e".repeat(64),
							committed_proof_content_hash: null,
						},
					};
			}) as never,
			collectCurrentBinding: async () => ({ status: "fresh", hash: BOUND_DIFF_HASH }),
			getMode: () => "DEV",
			runtimeCurrentOrError: () => undefined,
			trustedOrError: () => undefined,
			projectRootFor: async () => "/project",
			reconcileProjectAuthority: async () => true,
			output: (_ctx, lines) => { output.push(lines.join("\n")); },
		});
		assert.ok(command);
		await command.handler(ID, context());
		assert.equal(publicExecutions, 0, scenario.status);
		assert.equal(exactExecutions, 1, scenario.status);
		assert.equal(successorReads, 2, scenario.status);
		assert.equal(capturedAuthority?.authority_kind, "terminal-negative-repair", scenario.status);
		assert.deepEqual(capturedAuthority?.arguments.allowed_paths, ["src/**"], scenario.status);
		assert.deepEqual(capturedAuthority?.successor_lineage.carried_paths, ["src/exact.ts"], scenario.status);
		assert.match(output.join("\n"), /shared delegate execution completed/u, scenario.status);
	}
});

test("q-repair lost-response retry returns the same durable successor without starting a second worker", async () => {
	const committed = terminalNegativeCommitted("INTERRUPTED");
	const sidecar = terminalNegativeAuthority(committed);
	let command: CapturedCommand | undefined;
	let exactExecutions = 0;
	let successorReads = 0;
	let bindingReads = 0;
	const output: string[] = [];
	registerExactRepairCommandV1({
		pi: { registerCommand(_name: string, definition: unknown) { command = definition as CapturedCommand; } } as never,
		execution: {
			execute: (async () => { throw new Error("public route must not execute"); }) as never,
			executeExactRepair: (async () => {
				exactExecutions += 1;
				throw new Error("response channel lost");
			}) as never,
		},
		readCommittedGeneration: (async () => ({ ok: true, value: committed })) as never,
		readReview: (async () => { throw new Error("must not read ordinary review"); }) as never,
		readTerminalNegativeRepair: (async () => ({ ok: true, value: sidecar })) as never,
		readSuccessor: (async () => {
			successorReads += 1;
			return successorReads === 1
				? { ok: true, kind: "none" }
				: {
					ok: true,
					kind: "existing",
					value: {
						delegation_id: "20260827-010204-next",
						status: "PREPARED",
						contract_hash: "d".repeat(64),
						transaction_hash: "e".repeat(64),
						committed_proof_content_hash: null,
					},
				};
		}) as never,
		collectCurrentBinding: async () => {
			bindingReads += 1;
			return bindingReads === 1
				? { status: "fresh", hash: BOUND_DIFF_HASH }
				: { status: "conflict", hash: "7".repeat(64) };
		},
		getMode: () => "DEV",
		runtimeCurrentOrError: () => undefined,
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
		reconcileProjectAuthority: async () => true,
		output: (_ctx, lines) => { output.push(lines.join("\n")); },
	});
	assert.ok(command);
	await command.handler(ID, context());
	await command.handler(ID, context());
	assert.equal(exactExecutions, 1);
	assert.equal(successorReads, 3);
	assert.equal(bindingReads, 1, "replay returns the durable successor without re-gating the changed parent binding");
	assert.match(output[0] ?? "", /failed after recording one durable successor/u);
	assert.match(output[1] ?? "", /durable replay — returning the existing exact successor/u);
});

test("q-repair refuses stale terminal-negative binding before replay scan or execution", async () => {
	const committed = terminalNegativeCommitted("INTERRUPTED");
	const sidecar = terminalNegativeAuthority(committed);
	let command: CapturedCommand | undefined;
	let successorReads = 0;
	let exactExecutions = 0;
	const output: string[] = [];
	registerExactRepairCommandV1({
		pi: { registerCommand(_name: string, definition: unknown) { command = definition as CapturedCommand; } } as never,
		execution: {
			execute: (async () => { throw new Error("must not execute"); }) as never,
			executeExactRepair: (async () => { exactExecutions += 1; throw new Error("must not execute"); }) as never,
		},
		readCommittedGeneration: (async () => ({ ok: true, value: committed })) as never,
		readReview: (async () => { throw new Error("must not read ordinary review"); }) as never,
		readTerminalNegativeRepair: (async () => ({ ok: true, value: sidecar })) as never,
		readSuccessor: (async () => { successorReads += 1; return { ok: true, kind: "none" }; }) as never,
		collectCurrentBinding: async () => ({ status: "conflict", hash: "7".repeat(64) }),
		getMode: () => "DEV",
		runtimeCurrentOrError: () => undefined,
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
		reconcileProjectAuthority: async () => true,
		output: (_ctx, lines) => { output.push(lines.join("\n")); },
	});
	assert.ok(command);
	await command.handler(ID, context());
	assert.equal(successorReads, 1, "immutable replay scan precedes the fresh-binding start gate");
	assert.equal(exactExecutions, 0);
	assert.match(output.join("\n"), /CURRENT_BINDING_CHANGED/u);
	assert.match(output.join("\n"), /no delegation transaction was started/u);
});

test("delegate controller exact bridge injects the recovered subtree lineage into the shared execution kernel", async () => {
	await withTempDir(async (projectRoot) => {
		const committed = terminalNegativeCommitted("INTERRUPTED");
		const sidecar = terminalNegativeAuthority(committed);
		const recovered = recoverExactRepairCommandAuthorityV1({
			repairOf: ID,
			committed,
			terminalNegativeRepair: sidecar,
			currentBindingHash: BOUND_DIFF_HASH,
		});
		assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.code);
		if (!recovered.ok) return;
		let executionCalls = 0;
		let released = 0;
		let capturedInput: {
			contract: { allowed_paths: readonly string[]; repair_of?: string };
			dependencyPaths?: readonly string[];
			repairLineage?: unknown;
		} | undefined;
		let state = {
			...emptyDelegationState(),
			latestId: ID,
			status: "PENDING_REVIEW" as const,
			currentDiffHash: BOUND_DIFF_HASH,
			updatedAt: TERMINAL_TIME,
		};
		const handle = registerDelegateTool({
			pi: { registerTool() {} },
			services: {
				now: () => new Date(DECISION_TIME),
				makeDelegationId: () => "20260827-010205-next",
				acquireStartLock: async (input: { project_root: string; delegation_id: string; now: string }) => ({
					ok: true,
					value: {
						schema_version: 1,
						project_root: input.project_root,
						delegation_id: input.delegation_id,
						token: "a".repeat(32),
						process_id: 1,
						process_start_ticks: "1",
						boot_id: "11111111-1111-4111-8111-111111111111",
						acquired_at: input.now,
					},
				}),
				releaseStartLock: async () => { released += 1; return { ok: true, value: undefined }; },
				readCommittedGeneration: async () => ({ ok: true, value: committed }),
				readReview: async () => ({ ok: false, error: { code: "not_found" } }),
				readTerminalNegativeRepair: async () => ({ ok: true, value: sidecar }),
				readPlanContractAuthority: async () => ({ status: "absent" }),
				admitPathLane: async () => exactTipLaneAdmission(ID),
				revalidatePathLane: async (input: Parameters<NonNullable<DelegateToolServices["revalidatePathLane"]>>[0]) => ({
					schema_version: 1,
					kind: "delegation-path-lane-revalidation-v1",
					expected_authority_hash: input.expected_authority_hash,
					observed_authority_hash: input.expected_authority_hash,
					unchanged: true,
					admission: exactTipLaneAdmission(ID, input.expected_authority_hash),
				}),
				readRecoverableUnpublished: async () => ({ ok: false, error: { code: "not_recoverable" } }),
				readLegacyLedger: async () => null,
				executeDelegation: async (input: typeof capturedInput) => {
					executionCalls += 1;
					capturedInput = input;
					throw new Error("intentional worker boundary");
				},
				completeDefaultDelivery: async () => { throw new Error("must not deliver"); },
				buildTrustedRecoveryAuthority: async () => undefined,
			},
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			secrets: [],
			trustedOrError: () => undefined,
			projectRootFor: async () => projectRoot,
			reconcileProjectAuthority: async () => true,
			getProjectAuthorityBlockReason: () => undefined,
			collectCurrentDelegationBinding: async () => ({ status: "fresh", hash: BOUND_DIFF_HASH }),
			projectTerminalReviewedBinding: async () => null,
			getDelegationState: () => state,
			setDelegationState: (next: typeof state) => { state = next; },
			persistDelegationState: () => {},
			persistDelegationStateStrict: (next: typeof state) => { state = next; },
			markTerminalMirrorBlocked: () => {},
			refreshStatus: async () => {},
			bindTrustedIngressAuthority: () => undefined,
			rememberTrustedIngressAuthority: () => {},
		} as never);

		await assert.rejects(
			handle.executeExactRepair(recovered.value, undefined, undefined, context() as never),
			/intentional worker boundary/u,
		);
		assert.equal(executionCalls, 1);
		assert.equal(released, 1);
		assert.deepEqual(capturedInput?.contract.allowed_paths, ["src/**"]);
		assert.equal(capturedInput?.contract.repair_of, ID);
		assert.deepEqual(capturedInput?.dependencyPaths, ["src/exact.ts"]);
		assert.deepEqual(capturedInput?.repairLineage, recovered.value.successor_lineage);
	});
});

test("model-callable delegate params cannot forge terminal-negative exact repair authority", async () => {
	await withTempDir(async (projectRoot) => {
		const committed = terminalNegativeCommitted("INTERRUPTED");
		const sidecar = terminalNegativeAuthority(committed);
		const recovered = recoverExactRepairCommandAuthorityV1({
			repairOf: ID,
			committed,
			terminalNegativeRepair: sidecar,
			currentBindingHash: BOUND_DIFF_HASH,
		});
		assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.code);
		if (!recovered.ok) return;
		let executionCalls = 0;
		const handle = registerDelegateTool({
			pi: { registerTool() {} },
			services: {
				now: () => new Date(DECISION_TIME),
				makeDelegationId: () => "20260827-010205-fake",
				acquireStartLock: async (input: { project_root: string; delegation_id: string; now: string }) => ({
					ok: true,
					value: {
						schema_version: 1,
						project_root: input.project_root,
						delegation_id: input.delegation_id,
						token: "b".repeat(32),
						process_id: 1,
						process_start_ticks: "1",
						boot_id: "11111111-1111-4111-8111-111111111111",
						acquired_at: input.now,
					},
				}),
				releaseStartLock: async () => ({ ok: true, value: undefined }),
				readCommittedGeneration: async () => ({ ok: true, value: committed }),
				readReview: async () => ({ ok: false, error: { code: "not_found" } }),
				readTerminalNegativeRepair: async () => ({ ok: true, value: sidecar }),
				readPlanContractAuthority: async () => ({ status: "absent" }),
				readRecoverableUnpublished: async () => ({ ok: false, error: { code: "not_recoverable" } }),
				readLegacyLedger: async () => null,
				executeDelegation: async () => { executionCalls += 1; throw new Error("must not execute"); },
				completeDefaultDelivery: async () => { throw new Error("must not deliver"); },
				buildTrustedRecoveryAuthority: async () => undefined,
			},
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			secrets: [], trustedOrError: () => undefined, projectRootFor: async () => projectRoot,
			reconcileProjectAuthority: async () => true, getProjectAuthorityBlockReason: () => undefined,
			collectCurrentDelegationBinding: async () => ({ status: "fresh", hash: BOUND_DIFF_HASH }),
			projectTerminalReviewedBinding: async () => null,
			getDelegationState: () => ({
				...emptyDelegationState(), latestId: ID, status: "PENDING_REVIEW",
				currentDiffHash: BOUND_DIFF_HASH, updatedAt: TERMINAL_TIME,
			}),
			setDelegationState: () => {}, persistDelegationState: () => {}, persistDelegationStateStrict: () => {},
			markTerminalMirrorBlocked: () => {}, refreshStatus: async () => {},
			bindTrustedIngressAuthority: () => undefined, rememberTrustedIngressAuthority: () => {},
		} as never);
		await assert.rejects(
			handle.execute(
				recovered.value.tool_call_id,
				({
					...recovered.value.arguments,
					// Unknown model fields cannot smuggle the in-process authority object.
					exact_repair_authority: recovered.value,
				} as never),
				undefined,
				undefined,
				context() as never,
			),
				/exact repair compatibility router is unavailable/u,
		);
		assert.equal(executionCalls, 0);
	});
});
