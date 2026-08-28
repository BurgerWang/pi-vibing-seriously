import assert from "node:assert/strict";
import test from "node:test";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	AUTOMATIC_DELIVERY_CONTINUATION_MAX_LOCATOR_IDS_V1,
	AUTOMATIC_DELIVERY_CONTINUATION_METADATA_LANE_V1,
	revalidateAutomaticDeliveryContinuationCandidateV1,
	resolveAutomaticDeliveryContinuationCandidateV1,
	type AutomaticDeliveryContinuationAuthorityReadersV1,
	type AutomaticDeliveryContinuationAuthorityResolveInputV1,
} from "../extensions/workbench-runtime/core/automatic-delivery-continuation-authority.ts";
import {
	DELEGATION_PATH_LANE_ADMISSION_KIND_V1,
	type DelegationPathLaneAdmissionInputV1,
	type DelegationPathLaneAdmissionV1,
} from "../extensions/workbench-runtime/core/delegation-path-lane-admission.ts";
import { DELEGATION_PATH_LANE_DECISION_KIND_V1 } from "../extensions/workbench-runtime/core/delegation-path-lane.ts";
import type { ProjectDelegationRepairClosureV1 } from "../extensions/workbench-runtime/core/delegation-project-authority.ts";
import type { ExactRepairCommandAuthorityV1 } from "../extensions/workbench-runtime/core/exact-repair-authority.ts";
import type {
	DelegationCommittedGenerationV2,
	DelegationReviewAuthorityV2,
	DelegationSemanticRepairDecisionV1,
	DelegationTerminalNegativeSolAuthorityV1,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	beginDelegationCommit,
	bindDelegationRepairLineageV1,
	createPreparedDelegationTransaction,
	DELEGATION_COMMITTED_RECORD_NAMES,
	delegationCommitMarker,
	publishDelegationCommit,
	requireDelegationRecovery,
	reviewDelegationTransaction,
	startDelegationTransaction,
	type DelegationCommittedGenerationProof,
	type DelegationRepairLineageV1,
	type DelegationTransactionRecord,
	type DelegationTransactionResult,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";

const ROOT = "/project";
const HASH = "a".repeat(64);
const BOUND_A = "b".repeat(64);
const BOUND_B = "c".repeat(64);
const AFTER_A = "d".repeat(64);
const AFTER_B = "e".repeat(64);
const ID_A = "20260827-120000-a001";
const ID_B = "20260827-120001-b001";
const ID_CLOSED = "20260827-120002-c001";
const ID_TERM = "20260827-120003-t001";
const ID_FAIL = "20260827-120004-f001";
const ID_ZERO = "20260827-120005-z001";
const ID_DEPTH = "20260827-120006-d001";
const ID_RECOVERY = "20260827-120007-r001";

function at(offset: number): string {
	return new Date(Date.parse("2026-08-27T12:00:00.000Z") + offset * 1_000).toISOString();
}

function state(result: DelegationTransactionResult): DelegationTransactionRecord {
	assert.equal(result.ok, true, result.ok ? "" : result.error);
	return result.state;
}

function cas(transaction: DelegationTransactionRecord, now: string) {
	return {
		delegation_id: transaction.delegation_id,
		contract_hash: transaction.contract_hash,
		worker_identity: transaction.worker_identity,
		expected_generation: transaction.generation,
		expected_revision: transaction.revision,
		now,
	};
}

function proof(transaction: DelegationTransactionRecord, contentHash: string): DelegationCommittedGenerationProof {
	const payload: Omit<DelegationCommittedGenerationProof, "commit_marker"> = {
		schema_version: 2,
		delegation_id: transaction.delegation_id,
		task_kind: transaction.task_kind,
		contract_hash: transaction.contract_hash,
		worker_identity: transaction.worker_identity,
		generation: transaction.generation,
		revision: transaction.revision,
		record_names: [...DELEGATION_COMMITTED_RECORD_NAMES],
		record_count: DELEGATION_COMMITTED_RECORD_NAMES.length,
		content_hash: contentHash,
	};
	return { ...payload, commit_marker: delegationCommitMarker(payload) };
}

type PublishedMode = "pending" | "interrupted" | "failed" | "failed-zero";

function published(
	id: string,
	offset: number,
	mode: PublishedMode,
	changedPaths: readonly string[],
	lineage?: DelegationRepairLineageV1,
): DelegationTransactionRecord {
	const prepared = state(createPreparedDelegationTransaction({
		delegation_id: id,
		task_kind: "implementation",
		contract_hash: HASH,
		allowed_paths: ["src/**"],
		worker_identity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: `worker:${id}` },
		generation: 1,
		now: at(offset),
		...(lineage === undefined ? {} : { repair_lineage: lineage }),
	}));
	const running = state(startDelegationTransaction(prepared, cas(prepared, at(offset + 1))));
	const workerSuccess = mode === "pending";
	const failureCode = mode === "interrupted" ? "TIMED_OUT" as const
		: mode === "pending" ? null
			: "PROVIDER_RESPONSE_UNVERIFIED" as const;
	const committing = state(beginDelegationCommit(running, {
		...cas(running, at(offset + 2)),
		outcome: {
			delegation_id: id,
			task_kind: "implementation",
			worker_identity: running.worker_identity,
			provider_success: true,
			worker_success: workerSuccess,
			worker_failure_code: failureCode,
			exit_code: 0,
			report_complete: true,
			terminal_facts_complete: true,
			scope_complete: true,
			change_set_status: "ATTRIBUTED",
			changed_paths: [...changedPaths],
			successful_write_count: changedPaths.length,
			denied_write_count: 0,
			delta_hash: changedPaths.length === 0 ? null : "f".repeat(64),
		},
	}));
	const result = state(publishDelegationCommit(committing, {
		...cas(committing, at(offset + 3)),
		proof: proof(committing, canonicalHash({ id, offset })),
	}));
	assert.equal(result.status, mode === "pending" ? "PENDING_REVIEW"
		: mode === "interrupted" ? "INTERRUPTED" : "FAILED");
	return result;
}

function reviewed(id: string, offset: number): DelegationTransactionRecord {
	const pending = published(id, offset, "pending", ["src/closed.ts"]);
	return state(reviewDelegationTransaction(pending, {
		...cas(pending, at(offset + 4)),
		review_hash: "9".repeat(64),
	}));
}

function proofNullRecovery(id: string, offset: number): DelegationTransactionRecord {
	const prepared = state(createPreparedDelegationTransaction({
		delegation_id: id,
		task_kind: "implementation",
		contract_hash: HASH,
		allowed_paths: ["src/**"],
		worker_identity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: `worker:${id}` },
		generation: 1,
		now: at(offset),
	}));
	const running = state(startDelegationTransaction(prepared, cas(prepared, at(offset + 1))));
	const recovery = state(requireDelegationRecovery(running, {
		...cas(running, at(offset + 2)),
		reason: "worker result did not close durable generation",
	}));
	assert.equal(recovery.status, "RECOVERY_REQUIRED");
	assert.equal(recovery.committed_proof, null);
	return recovery;
}

function lineage(rootId: string): DelegationRepairLineageV1 {
	const result = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: rootId,
		repair_of: rootId,
		root_decision_hash: "1".repeat(64),
		continuation_decision_delegation_id: rootId,
		continuation_decision_hash: "1".repeat(64),
		parent_lineage_hash: null,
		depth: 1,
		carried_paths: ["src/rejected.ts"],
	});
	assert.notEqual(result, undefined);
	return result!;
}

function committed(transaction: DelegationTransactionRecord, afterDiffHash: string): DelegationCommittedGenerationV2 {
	assert.notEqual(transaction.committed_proof, null);
	const generationProof = transaction.committed_proof!;
	return {
		state: structuredClone(transaction),
		proof: structuredClone(generationProof),
		inventory: {
			directory: `${ROOT}/.pi/workbench/delegations/${transaction.delegation_id}/v2/generations/1`,
			record_names: [...DELEGATION_COMMITTED_RECORD_NAMES],
			proof: structuredClone(generationProof),
		},
		records: {
			"after.json": { diff_hash: afterDiffHash },
			"before.json": {},
			"identity.json": {},
			"review.json": {},
			"scope.json": {},
			"usage.json": {},
			"worker-report.md": "",
			"worker-summary.json": {},
		},
	};
}

function semanticReview(
	transaction: DelegationTransactionRecord,
	boundDiffHash: string,
): DelegationReviewAuthorityV2 {
	return {
		state: structuredClone(transaction),
		review_hash: canonicalHash({ review: transaction.delegation_id }),
		review: { bound_diff_hash: boundDiffHash } as never,
		semantic_repair: {
			decision_hash: canonicalHash({ decision: transaction.delegation_id }),
		} as DelegationSemanticRepairDecisionV1,
	} as unknown as DelegationReviewAuthorityV2;
}

function terminalSidecar(
	transaction: DelegationTransactionRecord,
	boundDiffHash: string,
): DelegationTerminalNegativeSolAuthorityV1 {
	return {
		state: structuredClone(transaction),
		review_hash: canonicalHash({ review: transaction.delegation_id }),
		bound_diff_hash: boundDiffHash,
		decision: {
			decision_hash: canonicalHash({ decision: transaction.delegation_id }),
		} as DelegationSemanticRepairDecisionV1,
	};
}

interface Fixture {
	transactions: Map<string, DelegationTransactionRecord>;
	committed: Map<string, DelegationCommittedGenerationV2>;
	semantic: Map<string, DelegationReviewAuthorityV2>;
	terminal: Map<string, DelegationTerminalNegativeSolAuthorityV1>;
	repairTips: string[];
	ordinary: string[];
	closure: ProjectDelegationRepairClosureV1;
	semanticErrors: Map<string, string>;
	terminalErrors: Map<string, string>;
	metadataOverlap: boolean;
	metadataUnknown: boolean;
	exactOverlap: Set<string>;
	epoch: number;
	transactionReads: number;
	sidecarReads: number;
	closureReads: number;
	admissionCalls: DelegationPathLaneAdmissionInputV1[];
}

function fixture(): Fixture {
	return {
		transactions: new Map(),
		committed: new Map(),
		semantic: new Map(),
		terminal: new Map(),
		repairTips: [],
		ordinary: [],
		closure: { ok: true, unresolvedTipId: null, rootCount: 0, lineageCount: 0 },
		semanticErrors: new Map(),
		terminalErrors: new Map(),
		metadataOverlap: false,
		metadataUnknown: false,
		exactOverlap: new Set(),
		epoch: 0,
		transactionReads: 0,
		sidecarReads: 0,
		closureReads: 0,
		admissionCalls: [],
	};
}

function admission(source: Fixture, input: DelegationPathLaneAdmissionInputV1): DelegationPathLaneAdmissionV1 {
	const metadata = input.repair_tip_exclusion_id === undefined;
	const overlap = metadata ? source.metadataOverlap : source.exactOverlap.has(input.repair_tip_exclusion_id!);
	const unknown = metadata && source.metadataUnknown;
	const exclusion = input.repair_tip_exclusion_id ?? null;
	return {
		schema_version: 1,
		kind: DELEGATION_PATH_LANE_ADMISSION_KIND_V1,
		authority_hash: canonicalHash({
			epoch: source.epoch,
			ordinary: source.ordinary,
			repair_tips: source.repairTips,
			exclusion,
		}),
		ordinary_blocker_ids: [...source.ordinary],
		repair_tip_ids: [...source.repairTips],
		repair_tip_exclusion_id: exclusion,
		blockers: [],
		decision: {
			schema_version: 1,
			kind: DELEGATION_PATH_LANE_DECISION_KIND_V1,
			decision: unknown || overlap ? "BLOCK" : "ALLOW",
			block_reasons: unknown ? ["UNKNOWN_AUTHORITY"] : overlap ? ["PATH_OVERLAP"] : [],
			normalized_allowed_paths: [...input.allowed_paths],
			conflicts: [],
			authority_failures: unknown ? [{
				delegation_id: null,
				authority_state: "UNKNOWN",
				reason: "STORAGE_FAILURE",
			}] : [],
			maintenance_warnings: [],
		},
	};
}

function exactAuthority(
	transaction: DelegationTransactionRecord,
	committedGeneration: DelegationCommittedGenerationV2,
	kind: "semantic-repair" | "terminal-negative-repair",
	decisionHash: string,
	boundDiffHash: string,
): ExactRepairCommandAuthorityV1 {
	const successor = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: transaction.delegation_id,
		repair_of: transaction.delegation_id,
		root_decision_hash: decisionHash,
		continuation_decision_delegation_id: transaction.delegation_id,
		continuation_decision_hash: decisionHash,
		parent_lineage_hash: null,
		depth: 1,
		carried_paths: [...(transaction.terminal_outcome?.changed_paths ?? [])],
	});
	assert.notEqual(successor, undefined);
	const common = {
		schema_version: 1 as const,
		kind: "exact-repair-command-execution-v1" as const,
		repair_of: transaction.delegation_id,
		committed_proof_content_hash: committedGeneration.proof.content_hash,
		arguments: {
			task_kind: "implementation" as const,
			task: "Continue the exact rejected implementation.",
			allowed_paths: [...transaction.allowed_paths],
			acceptance_criteria: ["Close the rejected delta."],
			verification: ["Run focused tests."],
			timeout_seconds: 300,
			budget_profile: "standard" as const,
			repair_of: transaction.delegation_id,
		},
		successor_lineage: successor!,
	};
	const projection = kind === "semantic-repair"
		? { ...common, authority_kind: kind, semantic_decision_hash: decisionHash }
		: {
			...common,
			authority_kind: kind,
			semantic_decision_hash: decisionHash,
			expected_bound_diff_hash: boundDiffHash,
		};
	const idempotencyKey = canonicalHash(projection);
	return { ...projection, idempotency_key: idempotencyKey, tool_call_id: `q-repair-${idempotencyKey}` };
}

function readers(source: Fixture): AutomaticDeliveryContinuationAuthorityReadersV1 {
	return {
		readTransaction: async (_root, id) => {
			source.transactionReads += 1;
			const transaction = source.transactions.get(id);
			return transaction === undefined
				? { ok: false, error: { code: "not_found", message: "not found" } } as never
				: { ok: true, value: structuredClone(transaction) };
		},
		readCommittedGeneration: async (_root, id) => {
			const generation = source.committed.get(id);
			return generation === undefined
				? { ok: false, error: { code: "not_found", message: "not found" } } as never
				: { ok: true, value: structuredClone(generation) };
		},
		readReview: async (_root, id) => {
			source.sidecarReads += 1;
			const error = source.semanticErrors.get(id);
			if (error !== undefined) return { ok: false, error: { code: error, message: error } } as never;
			const review = source.semantic.get(id);
			return review === undefined
				? { ok: false, error: { code: "not_found", message: "not found" } } as never
				: { ok: true, value: structuredClone(review) };
		},
		readTerminalNegativeRepair: async (_root, id) => {
			source.sidecarReads += 1;
			const error = source.terminalErrors.get(id);
			if (error !== undefined) return { ok: false, error: { code: error, message: error } } as never;
			const terminal = source.terminal.get(id);
			return terminal === undefined
				? { ok: false, error: { code: "not_found", message: "not found" } } as never
				: { ok: true, value: structuredClone(terminal) };
		},
		readProjectRepairClosure: async () => {
			source.closureReads += 1;
			return structuredClone(source.closure);
		},
		admitPathLane: async (input) => {
			source.admissionCalls.push(structuredClone(input));
			return admission(source, input);
		},
		recoverExactRepairAuthority: (input) => {
			const decisionHash = input.review?.semantic_repair?.decision_hash ??
				input.terminalNegativeRepair?.decision.decision_hash;
			const boundDiffHash = input.review?.review.bound_diff_hash ??
				input.terminalNegativeRepair?.bound_diff_hash;
			if (decisionHash === undefined || boundDiffHash === undefined) {
				return { ok: false, code: "SEMANTIC_REPAIR_AUTHORITY_REQUIRED" };
			}
			return {
				ok: true,
				value: exactAuthority(
					input.committed.state,
					input.committed,
					input.review === undefined ? "terminal-negative-repair" : "semantic-repair",
					decisionHash,
					boundDiffHash,
				),
			};
		},
		hasSemanticRepairAuthority: (authority) => authority.semantic_repair !== undefined,
	};
}

function resolveInput(
	ids: readonly string[],
	trigger: "agent_settled" | "before_agent_start" = "agent_settled",
	allowNeedsReview = trigger === "agent_settled",
): AutomaticDeliveryContinuationAuthorityResolveInputV1 {
	return {
		project_root: ROOT,
		trigger,
		locator_delegation_ids: [...ids],
		require_unique_unresolved_tip: true,
		require_strict_repair_sidecar: true,
		require_full_path_admission: true,
		allow_exact_terminal_needs_review: allowNeedsReview,
	};
}

function addSemanticRoot(source: Fixture, id: string, offset: number, bound: string, after: string): void {
	const transaction = published(id, offset, "pending", [`src/${id}.ts`]);
	source.transactions.set(id, transaction);
	source.committed.set(id, committed(transaction, after));
	source.semantic.set(id, semanticReview(transaction, bound));
	source.repairTips.push(id);
	source.repairTips.sort();
}

test("locator sets select one exact depth-zero sidecar while reload and two live ids remain ambiguous", async () => {
	const source = fixture();
	addSemanticRoot(source, ID_A, 0, BOUND_A, AFTER_A);
	addSemanticRoot(source, ID_B, 10, BOUND_B, AFTER_B);
	const closed = reviewed(ID_CLOSED, 20);
	source.transactions.set(ID_CLOSED, closed);
	source.committed.set(ID_CLOSED, committed(closed, "8".repeat(64)));
	source.closure = { ok: false, issue: { code: "repair_lineage_multiple_unresolved" } };

	const exact = await resolveAutomaticDeliveryContinuationCandidateV1(
		resolveInput([ID_CLOSED, ID_A, ID_CLOSED]), readers(source),
	);
	assert.equal(exact.status, "CANDIDATE", JSON.stringify(exact));
	if (exact.status !== "CANDIDATE") return;
	assert.equal(exact.candidate.delegation_id, ID_A);
	assert.equal(exact.candidate.sidecar_kind, "semantic-repair");
	assert.deepEqual(exact.candidate.affected_paths, ["src/**"]);
	assert.deepEqual(source.admissionCalls.at(-1), {
		project_root: ROOT,
		allowed_paths: ["src/**"],
		repair_tip_exclusion_id: ID_A,
	});

	const sameFromOtherTrigger = await resolveAutomaticDeliveryContinuationCandidateV1(
		resolveInput([ID_A], "before_agent_start", false), readers(source),
	);
	assert.equal(sameFromOtherTrigger.status, "CANDIDATE");
	if (sameFromOtherTrigger.status === "CANDIDATE") {
		assert.equal(sameFromOtherTrigger.candidate.authority_hash, exact.candidate.authority_hash,
			"trigger and locator-set shape are not authority facts");
	}
	const eventAmbiguous = await resolveAutomaticDeliveryContinuationCandidateV1(
		resolveInput([ID_B, ID_A]), readers(source),
	);
	assert.deepEqual(eventAmbiguous, { status: "BLOCKED", code: "AMBIGUOUS_CANDIDATES" });
	const reloadAmbiguous = await resolveAutomaticDeliveryContinuationCandidateV1(
		resolveInput([], "before_agent_start", false), readers(source),
	);
	assert.deepEqual(reloadAmbiguous, { status: "BLOCKED", code: "AMBIGUOUS_CANDIDATES" });
	const closedOnly = await resolveAutomaticDeliveryContinuationCandidateV1(
		resolveInput([ID_CLOSED]), readers(source),
	);
	assert.deepEqual(closedOnly, { status: "NOOP", code: "NO_CANDIDATE" });
});

test("exact agent-settled terminal candidates use the dedicated metadata lane and never reload without a sidecar", async () => {
	for (const [id, mode, afterHash] of [
		[ID_TERM, "interrupted", AFTER_A],
		[ID_FAIL, "failed", AFTER_B],
	] as const) {
		const source = fixture();
		const transaction = published(id, id === ID_TERM ? 30 : 40, mode, [`src/${id}.ts`]);
		source.transactions.set(id, transaction);
		source.committed.set(id, committed(transaction, afterHash));
		source.ordinary = [id];
		const resolved = await resolveAutomaticDeliveryContinuationCandidateV1(resolveInput([id]), readers(source));
		assert.equal(resolved.status, "CANDIDATE", JSON.stringify(resolved));
		if (resolved.status !== "CANDIDATE") continue;
		assert.equal(resolved.candidate.review_authority, "ELIGIBLE_TERMINAL_NEEDS_REVIEW");
		assert.equal(resolved.candidate.terminal_status, transaction.status);
		assert.equal(resolved.candidate.bound_diff_hash, afterHash);
		assert.deepEqual(resolved.candidate.affected_paths, [AUTOMATIC_DELIVERY_CONTINUATION_METADATA_LANE_V1]);
		assert.deepEqual(source.admissionCalls, [{
			project_root: ROOT,
			allowed_paths: [AUTOMATIC_DELIVERY_CONTINUATION_METADATA_LANE_V1],
		}], "metadata review has no source-tip exclusion and no broad workbench lane");

		const before = await resolveAutomaticDeliveryContinuationCandidateV1(
			resolveInput([id], "before_agent_start", false), readers(source),
		);
		assert.deepEqual(before, { status: "NOOP", code: "NO_DURABLE_REPAIR_SIDECAR" });
		const reload = await resolveAutomaticDeliveryContinuationCandidateV1(
			resolveInput([], "before_agent_start", false), readers(source),
		);
		assert.deepEqual(reload, { status: "NOOP", code: "NO_DURABLE_REPAIR_SIDECAR" });
	}
});

test("terminal-negative REPAIR sidecars are strict repair candidates with lifecycle-compatible null terminal status", async () => {
	const source = fixture();
	const transaction = published(ID_TERM, 0, "interrupted", ["src/partial.ts"]);
	source.transactions.set(ID_TERM, transaction);
	source.committed.set(ID_TERM, committed(transaction, AFTER_A));
	source.terminal.set(ID_TERM, terminalSidecar(transaction, BOUND_A));
	source.repairTips = [ID_TERM];
	source.closure = { ok: true, unresolvedTipId: ID_TERM, rootCount: 1, lineageCount: 0 };
	const resolved = await resolveAutomaticDeliveryContinuationCandidateV1(resolveInput([ID_TERM]), readers(source));
	assert.equal(resolved.status, "CANDIDATE", JSON.stringify(resolved));
	if (resolved.status !== "CANDIDATE") return;
	assert.equal(resolved.candidate.sidecar_kind, "terminal-negative-repair");
	assert.equal(resolved.candidate.review_authority, "DURABLE_REPAIR_SIDECAR");
	assert.equal(resolved.candidate.terminal_status, null,
		"durable sidecar kind carries terminal provenance; lifecycle reserves terminal_status for NEEDS_REVIEW");
	assert.equal(resolved.candidate.bound_diff_hash, BOUND_A);
	assert.deepEqual(source.admissionCalls.at(-1), {
		project_root: ROOT,
		allowed_paths: ["src/**"],
		repair_tip_exclusion_id: ID_TERM,
	});
});

test("missing is non-authority, corrupt sidecars fail closed, and closed or ineligible terminals are filtered", async () => {
	const source = fixture();
	const pending = published(ID_A, 0, "pending", ["src/pending.ts"]);
	source.transactions.set(ID_A, pending);
	source.committed.set(ID_A, committed(pending, AFTER_A));
	source.ordinary = [ID_A];
	assert.deepEqual(await resolveAutomaticDeliveryContinuationCandidateV1(resolveInput([ID_A]), readers(source)), {
		status: "NOOP", code: "NO_DURABLE_REPAIR_SIDECAR",
	});
	source.semanticErrors.set(ID_A, "invalid_record");
	assert.deepEqual(await resolveAutomaticDeliveryContinuationCandidateV1(resolveInput([ID_A]), readers(source)), {
		status: "BLOCKED", code: "SEMANTIC_REPAIR_SIDECAR_INVALID",
	});

	const terminalSource = fixture();
	const terminal = published(ID_TERM, 20, "interrupted", ["src/partial.ts"]);
	terminalSource.transactions.set(ID_TERM, terminal);
	terminalSource.committed.set(ID_TERM, committed(terminal, AFTER_A));
	terminalSource.ordinary = [ID_TERM];
	terminalSource.terminalErrors.set(ID_TERM, "invalid_record");
	assert.deepEqual(await resolveAutomaticDeliveryContinuationCandidateV1(resolveInput([ID_TERM]), readers(terminalSource)), {
		status: "BLOCKED", code: "TERMINAL_REPAIR_SIDECAR_INVALID",
	});

	const inactive = fixture();
	const inactivePending = published(ID_A, 30, "pending", ["src/inactive-pending.ts"]);
	const inactiveTerminal = published(ID_TERM, 31, "interrupted", ["src/inactive-terminal.ts"]);
	inactive.transactions.set(ID_A, inactivePending);
	inactive.transactions.set(ID_TERM, inactiveTerminal);
	inactive.committed.set(ID_A, committed(inactivePending, AFTER_A));
	inactive.committed.set(ID_TERM, committed(inactiveTerminal, AFTER_B));
	inactive.semanticErrors.set(ID_A, "invalid_record");
	inactive.terminalErrors.set(ID_TERM, "invalid_record");
	assert.deepEqual(await resolveAutomaticDeliveryContinuationCandidateV1(
		resolveInput([ID_A, ID_TERM]), readers(inactive),
	), { status: "NOOP", code: "NO_CANDIDATE" });
	assert.equal(inactive.sidecarReads, 0,
		"durably closed locator noise is filtered by project authority before historical sidecars are read");

	const filtered = fixture();
	const zero = published(ID_ZERO, 40, "failed-zero", []);
	const depth = published(ID_DEPTH, 50, "failed", ["src/depth.ts"], lineage(ID_A));
	const recovery = proofNullRecovery(ID_RECOVERY, 60);
	for (const transaction of [zero, depth, recovery]) filtered.transactions.set(transaction.delegation_id, transaction);
	filtered.committed.set(ID_ZERO, committed(zero, AFTER_A));
	filtered.committed.set(ID_DEPTH, committed(depth, AFTER_B));
	filtered.ordinary = [ID_ZERO, ID_DEPTH, ID_RECOVERY];
	assert.deepEqual(await resolveAutomaticDeliveryContinuationCandidateV1(
		resolveInput([ID_ZERO, ID_DEPTH, ID_RECOVERY]), readers(filtered),
	), { status: "NOOP", code: "NO_CANDIDATE" });
});

test("unknown authority and metadata or repair path overlap all fail closed before continuation", async () => {
	const terminal = published(ID_TERM, 0, "interrupted", ["src/partial.ts"]);
	const unknown = fixture();
	unknown.transactions.set(ID_TERM, terminal);
	unknown.committed.set(ID_TERM, committed(terminal, AFTER_A));
	unknown.ordinary = [ID_TERM];
	unknown.metadataUnknown = true;
	assert.deepEqual(await resolveAutomaticDeliveryContinuationCandidateV1(resolveInput([ID_TERM]), readers(unknown)), {
		status: "BLOCKED", code: "PROJECT_PATH_AUTHORITY_INVALID",
	});
	assert.equal(unknown.transactionReads, 0, "complete project authority fails before target selection");

	const metadataOverlap = fixture();
	metadataOverlap.transactions.set(ID_TERM, terminal);
	metadataOverlap.committed.set(ID_TERM, committed(terminal, AFTER_A));
	metadataOverlap.ordinary = [ID_TERM];
	metadataOverlap.metadataOverlap = true;
	assert.deepEqual(await resolveAutomaticDeliveryContinuationCandidateV1(resolveInput([ID_TERM]), readers(metadataOverlap)), {
		status: "BLOCKED", code: "METADATA_PATH_ADMISSION_BLOCKED",
	});

	const repairOverlap = fixture();
	addSemanticRoot(repairOverlap, ID_A, 20, BOUND_A, AFTER_A);
	repairOverlap.exactOverlap.add(ID_A);
	assert.deepEqual(await resolveAutomaticDeliveryContinuationCandidateV1(resolveInput([ID_A]), readers(repairOverlap)), {
		status: "BLOCKED", code: "REPAIR_PATH_ADMISSION_BLOCKED",
	});
});

test("revalidation strictly rereads transaction, sidecar, closure, and path admission and detects TOCTOU", async () => {
	const source = fixture();
	addSemanticRoot(source, ID_A, 0, BOUND_A, AFTER_A);
	const boundReaders = readers(source);
	const initial = await resolveAutomaticDeliveryContinuationCandidateV1(resolveInput([ID_A]), boundReaders);
	assert.equal(initial.status, "CANDIDATE", JSON.stringify(initial));
	if (initial.status !== "CANDIDATE") return;
	const counts = {
		transactions: source.transactionReads,
		sidecars: source.sidecarReads,
		closures: source.closureReads,
		admissions: source.admissionCalls.length,
	};
	source.epoch += 1;
	const revalidated = await revalidateAutomaticDeliveryContinuationCandidateV1({
		candidate: initial.candidate,
	}, boundReaders);
	assert.equal(revalidated.resolution.status, "CANDIDATE");
	assert.equal(revalidated.unchanged, false);
	assert.notEqual(revalidated.observed_authority_hash, initial.candidate.authority_hash);
	assert.ok(source.transactionReads > counts.transactions);
	assert.ok(source.sidecarReads > counts.sidecars);
	assert.ok(source.closureReads > counts.closures);
	assert.ok(source.admissionCalls.length > counts.admissions);
});

test("authority callers cannot supply a locator set wider than the lifecycle bound", async () => {
	assert.equal(AUTOMATIC_DELIVERY_CONTINUATION_MAX_LOCATOR_IDS_V1, 8);
	const ids = Array.from({ length: AUTOMATIC_DELIVERY_CONTINUATION_MAX_LOCATOR_IDS_V1 + 1 }, (_value, index) =>
		`20260827-130000-x00${index}`);
	assert.deepEqual(await resolveAutomaticDeliveryContinuationCandidateV1(resolveInput(ids), readers(fixture())), {
		status: "BLOCKED",
		code: "INVALID_LOCATOR_SET",
	});
});
