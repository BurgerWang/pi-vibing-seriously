import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	computeChangeSetHash,
	computeWorkerDeltaHash,
	type ChangeSetAttributedEntry,
	type ChangeSetRecord,
} from "../extensions/workbench-runtime/core/change-set.ts";
import type { DelegationCommandProvenanceRecord } from "../extensions/workbench-runtime/core/delegation-command-effect-provenance.ts";
import {
	exactRepairToolArgumentsV1,
	recoverExactRepairCommandAuthorityV1,
	type ExactRepairTerminalNegativeSolAuthorityV1,
} from "../extensions/workbench-runtime/core/exact-repair-authority.ts";
import { buildSemanticReviewEnvelopeV1 } from "../extensions/workbench-runtime/core/semantic-review-envelope.ts";
import { normalizeDelegationBoundedTaskContractV2 } from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import {
	bindDelegationRepairLineageV1,
	type DelegationRepairLineageV1,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import type {
	DelegationCommittedGenerationV2,
	DelegationSemanticRepairDecisionV1,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";

const ID = "20260827-010203-qrep";
const ROOT_ID = "20260827-010100-root";
const NOW = "2026-08-27T01:02:03.000Z";
const DECIDED = "2026-08-27T01:02:04.000Z";

function sha(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function sorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort(byteCompare);
}

function contract(allowedPaths: readonly string[] = ["src/**"]) {
	const normalized = normalizeDelegationBoundedTaskContractV2({
		task_kind: "implementation",
		task: "Repair the rejected implementation from immutable authority.",
		allowed_paths: [...allowedPaths],
		acceptance_criteria: ["The rejected behavior is corrected."],
		verification: [],
		timeout_seconds: 600,
		budget_profile: "extended",
	});
	if (!normalized.ok) assert.fail(normalized.error.code);
	return normalized.value;
}

function file(path: string, marker: string) {
	return {
		schema_version: 2 as const,
		kind: "file" as const,
		path,
		byte_size: 1,
		sha256: sha(marker),
		stat: { dev: "1", ino: "2", mtime_ns: "3", ctime_ns: "4" },
	};
}

function missing(path: string) {
	return { schema_version: 2 as const, kind: "missing" as const, path };
}

function delta(path: string, marker: string): ChangeSetAttributedEntry {
	return { path, change: "new", operation_count: 1, before: missing(path), after: file(path, marker) };
}

function changeSet(contractHash: string, workerPaths: readonly string[], dependencies: readonly string[]): ChangeSetRecord {
	const workerDelta = sorted(workerPaths).map((path, index) => delta(path, `worker-${index}`));
	const withoutHash: Omit<ChangeSetRecord, "change_set_hash"> = {
		schema_version: 2,
		delegation_id: ID,
		contract_hash: contractHash,
		journal_hash: "1".repeat(64),
		before_workspace_guard_hash: "2".repeat(64),
		after_workspace_guard_hash: "3".repeat(64),
		dependency_paths: sorted(dependencies),
		status: "ATTRIBUTED",
		worker_delta: workerDelta,
		workspace_drift: [],
		conflicts: [],
		finalization_meter: {
			paths_attempted: workerDelta.length,
			paths_completed: workerDelta.length,
			bytes_read: workerDelta.length,
		},
		counts: {
			touched_paths: workerDelta.length,
			attributed_paths: workerDelta.length,
			zero_delta_paths: 0,
			workspace_drift_paths: 0,
			dependency_drift_paths: 0,
			unknown_origin_drift_paths: 0,
			conflict_paths: 0,
		},
		worker_delta_hash: computeWorkerDeltaHash(workerDelta, []),
		workspace_guard_hash: "3".repeat(64),
	};
	return { ...withoutHash, change_set_hash: computeChangeSetHash(withoutHash) };
}

function commandProvenance(
	change: ChangeSetRecord,
	commandPath: string,
	options: { legacyCleanRunFailure?: boolean } = {},
): DelegationCommandProvenanceRecord {
	const runId = "20260827-010204-cmd1";
	const runOutcome = options.legacyCleanRunFailure ? "PROCESS_FAILED" as const : "SUCCESS" as const;
	const receipt = {
		run_id: runId,
		recipe: "generate-exact",
		started_at: NOW,
		finished_at: DECIDED,
		run_outcome: runOutcome,
		manifest_sha256: "4".repeat(64),
		command_effect_file_sha256: "5".repeat(64),
		command_effect_hash: "6".repeat(64),
		command_effect_status: "COMMAND_ATTRIBUTED" as const,
	};
	const observationEntry = {
		schema: "workbench-worker-command-effect-v1" as const,
		kind: "committed" as const,
		delegation_id: ID,
		contract_hash: change.contract_hash,
		...receipt,
		failure_code: null,
	};
	const commandDelta = [{
		path: commandPath,
		change: "new" as const,
		before: missing(commandPath),
		after: file(commandPath, "command"),
		run_ids: [runId],
	}];
	const effectivePaths = sorted([...change.worker_delta.map((entry) => entry.path), commandPath]);
	const effectiveDeltaHash = jsonHash({
		schema_version: 1,
		kind: "delegation-effective-delta-v1",
		delegation_id: ID,
		contract_hash: change.contract_hash,
		worker_delta_hash: change.worker_delta_hash,
		command_delta: commandDelta.map((entry) => ({
			path: entry.path,
			change: entry.change,
			before: entry.before,
			after: entry.after,
			run_ids: [...entry.run_ids],
		})),
		receipts: [{ ...receipt }],
	});
	const withoutHash: Omit<DelegationCommandProvenanceRecord, "command_provenance_hash"> = {
		schema_version: 1,
		delegation_id: ID,
		contract_hash: change.contract_hash,
		base_change_set_hash: change.change_set_hash,
		worker_delta_hash: change.worker_delta_hash,
		runtime_observation: { state: "observed", code: "none", entries: [observationEntry] },
		receipts: [receipt],
		command_delta: commandDelta,
		remaining_workspace_drift: [],
		terminal_reasons: options.legacyCleanRunFailure ? ["COMMAND_EFFECT_RUN_FAILED"] : [],
		effective_status: options.legacyCleanRunFailure ? "WORKSPACE_DRIFT" : "ATTRIBUTED",
		effective_paths: effectivePaths,
		finalization_meter: { paths_attempted: 1, paths_completed: 1, bytes_read: 1 },
		effective_delta_hash: effectiveDeltaHash,
	};
	const projection = {
		schema_version: withoutHash.schema_version,
		delegation_id: withoutHash.delegation_id,
		contract_hash: withoutHash.contract_hash,
		base_change_set_hash: withoutHash.base_change_set_hash,
		worker_delta_hash: withoutHash.worker_delta_hash,
		runtime_observation: {
			state: withoutHash.runtime_observation.state,
			code: withoutHash.runtime_observation.code,
			entries: withoutHash.runtime_observation.entries.map((entry) => ({ ...entry })),
		},
		receipts: withoutHash.receipts.map((entry) => ({ ...entry })),
		command_delta: withoutHash.command_delta.map((entry) => ({
			path: entry.path,
			change: entry.change,
			before: entry.before,
			after: entry.after,
			run_ids: [...entry.run_ids],
		})),
		remaining_workspace_drift: [],
		terminal_reasons: [...withoutHash.terminal_reasons],
		effective_status: withoutHash.effective_status,
		effective_paths: [...withoutHash.effective_paths],
		finalization_meter: { ...withoutHash.finalization_meter },
		effective_delta_hash: withoutHash.effective_delta_hash,
	};
	return { ...withoutHash, command_provenance_hash: jsonHash(projection) };
}

function lineage(carriedPaths: readonly string[] = ["src/root.ts"]): DelegationRepairLineageV1 {
	const value = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: ROOT_ID,
		repair_of: ROOT_ID,
		root_decision_hash: "b".repeat(64),
		continuation_decision_delegation_id: ROOT_ID,
		continuation_decision_hash: "b".repeat(64),
		parent_lineage_hash: null,
		depth: 1,
		carried_paths: sorted(carriedPaths),
	});
	assert.ok(value);
	return value;
}

interface CommittedOptions {
	status?: "INTERRUPTED" | "FAILED" | "RECOVERY_REQUIRED";
	allowedPaths?: readonly string[];
	workerPaths?: readonly string[];
	dependencyPaths?: readonly string[];
	commandPath?: string;
	legacyCleanRunFailure?: boolean;
	withLineage?: boolean;
	legacyOutcome?: boolean;
	stateContractHash?: string;
	stateProofHash?: string;
	proofHash?: string;
	boundDiffHash?: string;
}

function committed(options: CommittedOptions = {}): DelegationCommittedGenerationV2 {
	const persistedContract = contract(options.allowedPaths);
	const stateContractHash = options.stateContractHash ?? persistedContract.contract_hash;
	const change = changeSet(stateContractHash, options.workerPaths ?? ["src/worker.ts"], options.dependencyPaths ?? ["src/dependency.ts"]);
	const command = options.commandPath === undefined
		? undefined
		: commandProvenance(change, options.commandPath, { legacyCleanRunFailure: options.legacyCleanRunFailure });
	const effectivePaths = command?.effective_paths ?? change.worker_delta.map((entry) => entry.path);
	const effectiveHash = command?.effective_delta_hash ?? change.worker_delta_hash;
	const boundDiffHash = options.boundDiffHash ?? "9".repeat(64);
	const envelope = buildSemanticReviewEnvelopeV1({
		streams: effectivePaths.map((path, index) => ({
			path,
			source: "compact" as const,
			stream_bytes: 1,
			stream_sha256: sha(`stream-${index}`),
			page_count: 1,
		})),
		projected_review_record_bytes: 1_024,
		relevance_projection_hash: boundDiffHash,
	});
	assert.equal(envelope.ok, true);
	const proof = {
		schema_version: 2,
		delegation_id: ID,
		content_hash: options.proofHash ?? "c".repeat(64),
	};
	const outcome = {
		delegation_id: ID,
		task_kind: "implementation" as const,
		worker_identity: { provider: "openai" as const, model: "gpt-5.6-luna" as const, worker_id: "worker:test" },
		provider_success: true,
		...(options.legacyOutcome
			? {}
			: options.legacyCleanRunFailure
				? { worker_success: true, worker_failure_code: null }
				: { worker_success: false, worker_failure_code: "TURN_LIMIT" as const }),
		exit_code: 0,
		report_complete: true,
		terminal_facts_complete: true,
		scope_complete: true,
		change_set_status: command?.effective_status ?? "ATTRIBUTED" as const,
		changed_paths: [...effectivePaths],
		successful_write_count: change.worker_delta.length,
		denied_write_count: 0,
		delta_hash: effectiveHash,
	};
	const state = {
		schema_version: 2 as const,
		delegation_id: ID,
		status: options.status ?? "FAILED",
		task_kind: "implementation" as const,
		contract_hash: stateContractHash,
		allowed_paths: [...persistedContract.allowed_paths],
		worker_identity: outcome.worker_identity,
		generation: 1,
		revision: 3,
		created_at: NOW,
		updated_at: NOW,
		postcondition_reasons: options.legacyCleanRunFailure
			? ["WORKSPACE_DRIFT_DETECTED" as const]
			: ["WORKER_RUN_FAILED" as const],
		terminal_outcome: outcome,
		committed_proof: { ...proof, content_hash: options.stateProofHash ?? proof.content_hash },
		review: null,
		abort_reason: null,
		recovery_reason: null,
		...(options.withLineage === false ? {} : { repair_lineage: lineage() }),
	};
	return {
		state,
		records: {
			"before.json": { contract: persistedContract },
			"scope.json": {
				allowed_paths: [...persistedContract.allowed_paths],
				changed_paths: [...effectivePaths],
				change_set: change,
				...(command === undefined ? {} : { command_provenance: command }),
			},
			"after.json": { review_envelope: envelope.value },
		},
		proof,
	} as unknown as DelegationCommittedGenerationV2;
}

function terminalNegativeAuthority(
	source: DelegationCommittedGenerationV2,
	options: { decisionReason?: string; boundDiffHash?: string } = {},
): ExactRepairTerminalNegativeSolAuthorityV1 {
	const reviewHash = "8".repeat(64);
	const boundDiffHash = options.boundDiffHash ?? "9".repeat(64);
	const repairReason = options.decisionReason ?? "Continue the complete in-scope partial implementation under Sol review.";
	const payload: Omit<DelegationSemanticRepairDecisionV1, "decision_hash"> = {
		schema_version: 1,
		delegation_id: ID,
		contract_hash: source.state.contract_hash,
		generation: source.state.generation,
		transaction_revision: 3,
		generation_content_hash: source.proof.content_hash,
		base_review_hash: reviewHash,
		expected_bound_diff_hash: boundDiffHash,
		decision: "REPAIR",
		repair_reason: repairReason,
		repair_reason_hash: sha(repairReason),
		reviewer: { provider: "openai-codex", model: "gpt-5.6-sol" },
		decided_at: DECIDED,
	};
	return {
		state: structuredClone(source.state),
		review_hash: reviewHash,
		bound_diff_hash: boundDiffHash,
		decision: { ...payload, decision_hash: canonicalHash(payload) },
	};
}

test("lineaged terminal recovery preserves subtree rules and binds proof plus the exact successor lineage", () => {
	const source = committed({ commandPath: "src/generated.ts" });
	const first = recoverExactRepairCommandAuthorityV1({ repairOf: ID, committed: source });
	const replay = recoverExactRepairCommandAuthorityV1({ repairOf: ID, committed: source });
	assert.equal(first.ok, true, first.ok ? "" : first.code);
	assert.deepEqual(replay, first, "unchanged durable authority produces one stable command identity");
	if (!first.ok) return;
	assert.equal(first.value.authority_kind, "terminal-lineage");
	assert.deepEqual(first.value.arguments.allowed_paths, ["src/**"]);
	assert.deepEqual(first.value.successor_lineage.carried_paths, [
		"src/dependency.ts", "src/generated.ts", "src/root.ts", "src/worker.ts",
	]);
	assert.equal(first.value.successor_lineage.depth, 2);
	assert.equal(first.value.successor_lineage.parent_lineage_hash, source.state.repair_lineage?.lineage_hash);
	assert.equal(first.value.tool_call_id, `q-repair-${first.value.idempotency_key}`);
	assert.equal("semantic_decision_hash" in first.value, false, "terminal lineage never invents a decision");
	const { idempotency_key: idempotencyKey, tool_call_id: _toolCallId, ...projection } = first.value;
	assert.equal(idempotencyKey, canonicalHash(projection));
	const differentProof = committed({ commandPath: "src/generated.ts", proofHash: "d".repeat(64), stateProofHash: "d".repeat(64) });
	const rebound = recoverExactRepairCommandAuthorityV1({ repairOf: ID, committed: differentProof });
	assert.equal(rebound.ok, true);
	if (rebound.ok) assert.notEqual(rebound.value.idempotency_key, idempotencyKey);
});

test("lineaged recovery accepts only the legacy CLEAN command-failure shape as attributed scope", () => {
	const source = committed({
		status: "FAILED",
		commandPath: "src/generated.ts",
		legacyCleanRunFailure: true,
	});
	const scope = source.records["scope.json"] as {
		change_set: ChangeSetRecord;
		command_provenance: DelegationCommandProvenanceRecord;
	};
	assert.equal(scope.change_set.status, "ATTRIBUTED");
	assert.deepEqual(scope.command_provenance.remaining_workspace_drift, []);
	assert.deepEqual(scope.command_provenance.terminal_reasons, ["COMMAND_EFFECT_RUN_FAILED"]);
	assert.equal(scope.command_provenance.effective_status, "WORKSPACE_DRIFT");
	assert.equal(source.state.terminal_outcome?.change_set_status, "WORKSPACE_DRIFT");

	const recovered = recoverExactRepairCommandAuthorityV1({ repairOf: ID, committed: source });
	assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.code);
	if (recovered.ok) {
		assert.deepEqual(recovered.value.successor_lineage.carried_paths, [
			"src/dependency.ts", "src/generated.ts", "src/root.ts", "src/worker.ts",
		]);
	}

	const corrupted = structuredClone(source);
	const provenance = (corrupted.records["scope.json"] as typeof scope).command_provenance;
	provenance.terminal_reasons = ["COMMAND_EFFECT_RUN_FAILED", "COMMAND_EFFECT_EVIDENCE_UNAVAILABLE"];
	provenance.effective_status = "WORKSPACE_DRIFT";
	assert.deepEqual(recoverExactRepairCommandAuthorityV1({ repairOf: ID, committed: corrupted }), {
		ok: false,
		code: "INVALID_COMMITTED_SCOPE",
	}, "evidence loss remains fail-closed and is never treated as the legacy CLEAN exception");
});

test("a new terminal-negative decision on a lineaged FAILED parent replaces stale continuation authority", () => {
	const source = committed({
		status: "FAILED",
		commandPath: "src/generated.ts",
		legacyCleanRunFailure: true,
	});
	const sidecar = terminalNegativeAuthority(source, {
		decisionReason: "Repair the current failed continuation using its newly reviewed failure facts.",
	});
	const recovered = recoverExactRepairCommandAuthorityV1({
		repairOf: ID,
		committed: source,
		terminalNegativeRepair: sidecar,
		currentBindingHash: sidecar.bound_diff_hash,
	});
	assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.code);
	if (!recovered.ok) return;
	assert.equal(recovered.value.authority_kind, "terminal-negative-repair");
	assert.equal(recovered.value.successor_lineage.depth, 2);
	assert.equal(recovered.value.successor_lineage.repair_of, ID);
	assert.equal(recovered.value.successor_lineage.continuation_decision_delegation_id, ID);
	assert.equal(recovered.value.successor_lineage.continuation_decision_hash, sidecar.decision.decision_hash);
	assert.equal(recovered.value.successor_lineage.parent_lineage_hash, source.state.repair_lineage?.lineage_hash);
});

test("lineaged terminal recovery does not reinterpret carried review dependencies as write scope", () => {
	const source = committed({
		allowedPaths: ["src/worker.ts"],
		workerPaths: ["src/worker.ts"],
		dependencyPaths: [],
	});
	const recovered = recoverExactRepairCommandAuthorityV1({ repairOf: ID, committed: source });
	assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.code);
	if (!recovered.ok) return;
	assert.deepEqual(recovered.value.arguments.allowed_paths, ["src/worker.ts"]);
	assert.deepEqual(recovered.value.successor_lineage.carried_paths, ["src/root.ts", "src/worker.ts"]);
});

test("INTERRUPTED requires a fresh terminal-negative Sol sidecar and creates the first lineage", () => {
	const source = committed({ status: "INTERRUPTED", withLineage: false, commandPath: "src/generated.ts" });
	assert.deepEqual(recoverExactRepairCommandAuthorityV1({ repairOf: ID, committed: source }), {
		ok: false,
		code: "TERMINAL_NEGATIVE_REPAIR_AUTHORITY_REQUIRED",
	});
	const sidecar = terminalNegativeAuthority(source);
	const recovered = recoverExactRepairCommandAuthorityV1({
		repairOf: ID,
		committed: source,
		terminalNegativeRepair: sidecar,
		currentBindingHash: sidecar.bound_diff_hash,
	});
	assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.code);
	if (!recovered.ok) return;
	assert.equal(recovered.value.authority_kind, "terminal-negative-repair");
	assert.equal(recovered.value.successor_lineage.depth, 1);
	assert.equal(recovered.value.successor_lineage.root_delegation_id, ID);
	assert.equal(recovered.value.successor_lineage.root_decision_hash, sidecar.decision.decision_hash);
	assert.deepEqual(recovered.value.successor_lineage.carried_paths, [
		"src/dependency.ts", "src/generated.ts", "src/worker.ts",
	]);
	const changedDecision = terminalNegativeAuthority(source, { decisionReason: "A different strict Sol repair decision." });
	const changedDecisionRecovery = recoverExactRepairCommandAuthorityV1({
		repairOf: ID,
		committed: source,
		terminalNegativeRepair: changedDecision,
		currentBindingHash: changedDecision.bound_diff_hash,
	});
	assert.equal(changedDecisionRecovery.ok, true);
	if (changedDecisionRecovery.ok) {
		assert.notEqual(changedDecisionRecovery.value.idempotency_key, recovered.value.idempotency_key);
	}
	const changedCarriedSource = committed({
		status: "INTERRUPTED",
		withLineage: false,
		commandPath: "src/generated.ts",
		dependencyPaths: ["src/other-dependency.ts"],
	});
	const changedCarriedDecision = terminalNegativeAuthority(changedCarriedSource);
	const changedCarriedRecovery = recoverExactRepairCommandAuthorityV1({
		repairOf: ID,
		committed: changedCarriedSource,
		terminalNegativeRepair: changedCarriedDecision,
		currentBindingHash: changedCarriedDecision.bound_diff_hash,
	});
	assert.equal(changedCarriedRecovery.ok, true);
	if (changedCarriedRecovery.ok) {
		assert.notEqual(changedCarriedRecovery.value.idempotency_key, recovered.value.idempotency_key);
	}
});

test("legacy FAILED can create its first lineage only from the same strict terminal-negative authority", () => {
	const source = committed({ status: "FAILED", withLineage: false, legacyOutcome: true });
	delete (source.records["after.json"] as { review_envelope?: unknown }).review_envelope;
	assert.deepEqual(recoverExactRepairCommandAuthorityV1({ repairOf: ID, committed: source }), {
		ok: false,
		code: "TERMINAL_NEGATIVE_REPAIR_AUTHORITY_REQUIRED",
	});
	const sidecar = terminalNegativeAuthority(source);
	const recovered = recoverExactRepairCommandAuthorityV1({
		repairOf: ID,
		committed: source,
		terminalNegativeRepair: sidecar,
		currentBindingHash: sidecar.bound_diff_hash,
	});
	assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.code);
	if (recovered.ok) assert.equal(recovered.value.successor_lineage.depth, 1);
});

test("terminal-negative recovery fails closed on stale binding, sidecar state, or decision content", () => {
	const source = committed({ status: "INTERRUPTED", withLineage: false });
	const sidecar = terminalNegativeAuthority(source);
	assert.deepEqual(recoverExactRepairCommandAuthorityV1({
		repairOf: ID,
		committed: source,
		terminalNegativeRepair: sidecar,
		currentBindingHash: "7".repeat(64),
	}), { ok: false, code: "CURRENT_BINDING_CHANGED" });

	const staleState = structuredClone(sidecar);
	staleState.state.updated_at = "2026-08-27T01:02:02.000Z";
	assert.deepEqual(recoverExactRepairCommandAuthorityV1({
		repairOf: ID,
		committed: source,
		terminalNegativeRepair: staleState,
		currentBindingHash: staleState.bound_diff_hash,
	}), { ok: false, code: "AUTHORITY_CHANGED" });

	const corruptDecision = structuredClone(sidecar);
	corruptDecision.decision.repair_reason = "changed without rehash";
	assert.deepEqual(recoverExactRepairCommandAuthorityV1({
		repairOf: ID,
		committed: source,
		terminalNegativeRepair: corruptDecision,
		currentBindingHash: corruptDecision.bound_diff_hash,
	}), { ok: false, code: "AUTHORITY_CHANGED" });
});

test("FAILED and RECOVERY_REQUIRED inherited continuation still require a valid lineage and proof", () => {
	for (const status of ["FAILED", "RECOVERY_REQUIRED"] as const) {
		const recovered = recoverExactRepairCommandAuthorityV1({ repairOf: ID, committed: committed({ status }) });
		assert.equal(recovered.ok, true, `${status} with strict lineage is recoverable`);
		if (recovered.ok) assert.equal(recovered.value.authority_kind, "terminal-lineage");
	}
	assert.deepEqual(
		recoverExactRepairCommandAuthorityV1({
			repairOf: ID,
			committed: committed({ status: "RECOVERY_REQUIRED", withLineage: false }),
		}),
		{ ok: false, code: "REPAIR_LINEAGE_REQUIRED" },
	);
	assert.deepEqual(recoverExactRepairCommandAuthorityV1({
		repairOf: ID,
		committed: committed({ status: "RECOVERY_REQUIRED", stateProofHash: "d".repeat(64) }),
	}), { ok: false, code: "AUTHORITY_CHANGED" });
	const noProof = committed({ status: "RECOVERY_REQUIRED" });
	noProof.state.committed_proof = null;
	assert.deepEqual(recoverExactRepairCommandAuthorityV1({ repairOf: ID, committed: noProof }), {
		ok: false,
		code: "AUTHORITY_CHANGED",
	});
});

test("recovery rejects contract mismatch and concrete carried paths outside immutable scope", () => {
	assert.deepEqual(recoverExactRepairCommandAuthorityV1({
		repairOf: ID,
		committed: committed({ stateContractHash: "e".repeat(64) }),
	}), { ok: false, code: "CONTRACT_RECOVERY_FAILED" });
	assert.deepEqual(recoverExactRepairCommandAuthorityV1({
		repairOf: ID,
		committed: committed({ allowedPaths: ["src"], workerPaths: ["src/child.ts"] }),
	}), { ok: false, code: "INVALID_COMMITTED_SCOPE" }, "an exact parent rule never admits a child path");
	const subtree = recoverExactRepairCommandAuthorityV1({
		repairOf: ID,
		committed: committed({ allowedPaths: ["src/**"] }),
	});
	assert.equal(subtree.ok, true, "a subtree rule admits its concrete carried children without being expanded");
});

test("the shared contract rebinder supports INTERRUPTED and preserves immutable subtree rules", () => {
	const arguments_ = exactRepairToolArgumentsV1(committed({ status: "INTERRUPTED" }), ID);
	assert.ok(arguments_);
	assert.equal(arguments_.repair_of, ID);
	assert.deepEqual(arguments_.allowed_paths, ["src/**"]);
});
