/**
 * Read a minimal repair capsule from existing immutable delegation authority.
 *
 * No prior report text, transcript, task prose, errors, logs or session state
 * cross this boundary. Failed recipe/run pairs must be strict machine lines in
 * the immutable worker summary and are re-bound to committed run manifests.
 */

import { readDelegationLedger, type LedgerWorkerSummaryRecord } from "./delegation-ledger.ts";
import {
	isStrictRetryableAbortedRepairV2,
	isStrictRetryableEmptyRepairRecoveryV2,
} from "./delegation-execution-owner.ts";
import { readRecoverableUnpublishedDelegationV2 } from "./delegation-project-authority.ts";
import {
	hasDelegationSemanticRepairAuthorityV2,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTerminalNegativeSolAuthorityV1,
	readDelegationTransactionV2,
	type DelegationSemanticRepairDecisionV1,
} from "./delegation-transaction-storage.ts";
import type { DelegationRepairLineageV1, DelegationTransactionRecord } from "./delegation-transaction.ts";
import { parsePlanReference } from "./plan-reference.ts";
import { readCommittedManifest, RUN_ID_RE } from "./runs.ts";
import {
	WORKER_REPAIR_CAPSULE_MAX_CHANGED_PATHS,
	WORKER_REPAIR_CAPSULE_MAX_FAILED_RUNS,
	WORKER_REPAIR_CAPSULE_MAX_FAILURE_REASONS,
	WORKER_REPAIR_CAPSULE_SCHEMA,
	formatWorkerRepairCapsule,
	type WorkerRepairCapsule,
	type WorkerRepairFailedRunFact,
	type WorkerRepairPlanFact,
} from "./worker-repair-capsule.ts";

const FAILED_RUN_LINE_RE = /^recipe:(\S{1,200}) run:(\d{8}-\d{6}-[A-Za-z0-9]{4}) outcome:FAILURE$/u;

export type WorkerRepairAuthorityResult =
	| { ok: true; capsule: WorkerRepairCapsule }
	| { ok: false; code: "authority_unavailable" | "authority_invalid" | "capsule_too_large" };

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function boundedChangedPaths(paths: readonly string[]): { paths: string[]; omitted: number } {
	const unique = [...new Set(paths)].sort();
	return {
		paths: unique.slice(0, WORKER_REPAIR_CAPSULE_MAX_CHANGED_PATHS),
		omitted: Math.max(0, unique.length - WORKER_REPAIR_CAPSULE_MAX_CHANGED_PATHS),
	};
}

function lineageFact(lineage: DelegationRepairLineageV1 | undefined): WorkerRepairCapsule["repair_lineage"] {
	if (lineage === undefined) return undefined;
	const carried = boundedChangedPaths(lineage.carried_paths);
	return {
		root_delegation_id: lineage.root_delegation_id,
		repair_of: lineage.repair_of,
		root_decision_hash: lineage.root_decision_hash,
		continuation_decision_delegation_id: lineage.continuation_decision_delegation_id,
		continuation_decision_hash: lineage.continuation_decision_hash,
		lineage_hash: lineage.lineage_hash,
		depth: lineage.depth,
		carried_paths: carried.paths,
		carried_paths_omitted: carried.omitted,
	};
}

function semanticRepairFact(decision: DelegationSemanticRepairDecisionV1): NonNullable<WorkerRepairCapsule["semantic_repair"]> {
	return {
		delegation_id: decision.delegation_id,
		decision_hash: decision.decision_hash,
		expected_bound_diff_hash: decision.expected_bound_diff_hash,
		repair_reason: decision.repair_reason,
		repair_reason_hash: decision.repair_reason_hash,
		reviewer: { ...decision.reviewer },
		decided_at: decision.decided_at,
	};
}

async function strictRepairDecisionForCommitted(
	projectRoot: string,
	state: DelegationTransactionRecord,
): Promise<DelegationSemanticRepairDecisionV1 | undefined> {
	if (state.status === "PENDING_REVIEW") {
		const review = await readDelegationReviewV2(projectRoot, state.delegation_id);
		return review.ok && hasDelegationSemanticRepairAuthorityV2(review.value)
			? review.value.semantic_repair!
			: undefined;
	}
	if (state.repair_lineage === undefined && (state.status === "FAILED" || state.status === "INTERRUPTED")) {
		const terminal = await readDelegationTerminalNegativeSolAuthorityV1(projectRoot, state.delegation_id);
		return terminal.ok ? terminal.value.decision : undefined;
	}
	return undefined;
}

async function strictRepairLineageDecision(
	projectRoot: string,
	state: DelegationTransactionRecord,
): Promise<DelegationSemanticRepairDecisionV1 | undefined> {
	const lineage = state.repair_lineage;
	if (lineage === undefined) {
		return strictRepairDecisionForCommitted(projectRoot, state);
	}
	const root = await readDelegationCommittedGenerationV2(projectRoot, lineage.root_delegation_id);
	if (!root.ok || root.value.state.repair_lineage !== undefined) return undefined;
	const rootDecision = await strictRepairDecisionForCommitted(projectRoot, root.value.state);
	if (rootDecision === undefined || rootDecision.decision_hash !== lineage.root_decision_hash) return undefined;
	if (lineage.continuation_decision_delegation_id === lineage.root_delegation_id) {
		return lineage.continuation_decision_hash === lineage.root_decision_hash
			? rootDecision
			: undefined;
	}
	const continuation = await readDelegationCommittedGenerationV2(
		projectRoot,
		lineage.continuation_decision_delegation_id,
	);
	if (!continuation.ok) return undefined;
	const continuationLineage = continuation.value.state.repair_lineage;
	if (continuationLineage === undefined || continuationLineage.root_delegation_id !== lineage.root_delegation_id ||
		continuationLineage.root_decision_hash !== lineage.root_decision_hash) return undefined;
	const continuationDecision = await strictRepairDecisionForCommitted(projectRoot, continuation.value.state);
	return continuationDecision?.decision_hash === lineage.continuation_decision_hash
		? continuationDecision
		: undefined;
}

function minimalPlanFact(before: unknown): WorkerRepairPlanFact | null {
	const contract = record(record(before)?.contract);
	const plan = parsePlanReference(contract?.plan_ref);
	return plan === undefined
		? null
		: {
			plan_id: plan.plan_id,
			version: plan.version,
			plan_path: plan.plan_path,
			plan_sha256: plan.plan_sha256,
			candidate: plan.candidate,
		};
}

async function strictRepairPlanFact(
	projectRoot: string,
	state: DelegationTransactionRecord,
	currentBefore?: unknown,
): Promise<{ ok: true; value: WorkerRepairPlanFact | null } | { ok: false }> {
	if (state.repair_lineage === undefined) return { ok: true, value: minimalPlanFact(currentBefore) };
	const root = await readDelegationCommittedGenerationV2(projectRoot, state.repair_lineage.root_delegation_id);
	if (!root.ok) return { ok: false };
	return { ok: true, value: minimalPlanFact(root.value.records["before.json"]) };
}

function summaryFacts(value: unknown): Pick<LedgerWorkerSummaryRecord, "verification_commands" | "verification_observations"> | undefined {
	const candidate = record(value);
	if (!candidate) return undefined;
	const commands = candidate.verification_commands;
	const observations = candidate.verification_observations;
	if (!Array.isArray(commands) || !commands.every((item) => typeof item === "string") ||
		!Array.isArray(observations) || !observations.every((item) => typeof item === "string")) return undefined;
	return { verification_commands: commands as string[], verification_observations: observations as string[] };
}

async function failedRunFacts(
	projectRoot: string,
	summary: unknown,
	startedAt: string,
	finishedAt: string,
): Promise<WorkerRepairFailedRunFact[]> {
	const facts = summaryFacts(summary);
	if (!facts) return [];
	const candidates = [...facts.verification_commands, ...facts.verification_observations]
		.map((line) => FAILED_RUN_LINE_RE.exec(line))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => ({ recipe: match[1]!, run_id: match[2]! }));
	const output: WorkerRepairFailedRunFact[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (output.length >= WORKER_REPAIR_CAPSULE_MAX_FAILED_RUNS) break;
		if (!RUN_ID_RE.test(candidate.run_id) || seen.has(candidate.run_id)) continue;
		const manifest = await readCommittedManifest(projectRoot, candidate.run_id);
		if (!manifest || manifest.recipe !== candidate.recipe ||
			(manifest.run_outcome !== "PROCESS_FAILED" && manifest.run_outcome !== "ARTIFACT_FAILED" && manifest.run_outcome !== "COMMAND_EFFECT_FAILED") ||
			manifest.started_at < startedAt || manifest.finished_at > finishedAt) continue;
		seen.add(candidate.run_id);
		output.push({ recipe: candidate.recipe, run_id: candidate.run_id, outcome: manifest.run_outcome });
	}
	return output;
}

function ensureBounded(capsule: WorkerRepairCapsule): WorkerRepairAuthorityResult {
	try {
		formatWorkerRepairCapsule(capsule);
		return { ok: true, capsule };
	} catch {
		return { ok: false, code: "capsule_too_large" };
	}
}

/** Resolve v2 committed, recoverable unpublished, then historical v1 authority. */
export async function readWorkerRepairCapsule(
	projectRoot: string,
	repairOf: string,
): Promise<WorkerRepairAuthorityResult> {
	const committed = await readDelegationCommittedGenerationV2(projectRoot, repairOf);
	if (committed.ok) {
		const { state, records, proof } = committed.value;
		const outcome = state.terminal_outcome;
		if (outcome === null) return { ok: false, code: "authority_invalid" };
		let semanticDecision: DelegationSemanticRepairDecisionV1 | undefined;
		if (state.status === "PENDING_REVIEW") {
			const review = await readDelegationReviewV2(projectRoot, repairOf);
			if (!review.ok || !hasDelegationSemanticRepairAuthorityV2(review.value)) {
				return { ok: false, code: review.ok ? "authority_invalid" : review.error.code === "storage_failure" ? "authority_unavailable" : "authority_invalid" };
			}
			semanticDecision = review.value.semantic_repair!;
		} else {
			semanticDecision = await strictRepairDecisionForCommitted(projectRoot, state);
		}
		if (state.status !== "PENDING_REVIEW" &&
			!new Set(["FAILED", "INTERRUPTED", "FINISHED", "REVIEWED"]).has(state.status) &&
			!(state.status === "RECOVERY_REQUIRED" && state.repair_lineage !== undefined)) {
			return { ok: false, code: "authority_invalid" };
		}
		if (state.repair_lineage !== undefined) {
			const rootDecision = await strictRepairLineageDecision(projectRoot, state);
			if (rootDecision === undefined) return { ok: false, code: "authority_invalid" };
			semanticDecision ??= rootDecision;
		}
		const plan = await strictRepairPlanFact(projectRoot, state, records["before.json"]);
		if (!plan.ok) return { ok: false, code: "authority_invalid" };
		const changed = boundedChangedPaths(outcome.changed_paths);
		const reasonCodes = [
			...(semanticDecision !== undefined || state.repair_lineage !== undefined ? ["SEMANTIC_REPAIR_REQUIRED"] : []),
			...state.postcondition_reasons,
		].slice(0, WORKER_REPAIR_CAPSULE_MAX_FAILURE_REASONS);
		return ensureBounded({
			schema: WORKER_REPAIR_CAPSULE_SCHEMA,
			repair_of: repairOf,
			authority_kind: state.repair_lineage === undefined ? "v2_committed" : "v2_repair_lineage",
			authority_status: state.status,
			contract_hash: state.contract_hash,
			generation_content_hash: proof.content_hash,
			journal_hash: null,
			failure: {
				exit_code: outcome.exit_code,
				reason_codes: reasonCodes,
				successful_write_count: outcome.successful_write_count,
				denied_write_count: outcome.denied_write_count,
			},
			changed_paths: changed.paths,
			changed_paths_omitted: changed.omitted,
			failed_runs: await failedRunFacts(projectRoot, records["worker-summary.json"], state.created_at, state.updated_at),
			plan_ref: plan.value,
			...(state.repair_lineage === undefined ? {} : { repair_lineage: lineageFact(state.repair_lineage) }),
			...(semanticDecision === undefined ? {} : { semantic_repair: semanticRepairFact(semanticDecision) }),
		});
	}
	const committedAbsent = committed.error.code === "not_found";
	if (!committedAbsent && committed.error.code !== "invalid_record") {
		return { ok: false, code: "authority_unavailable" };
	}
	if (!committedAbsent) {
		const raw = await readDelegationTransactionV2(projectRoot, repairOf);
		const safeRawLineage = raw.ok && raw.value.repair_lineage !== undefined &&
			(await isStrictRetryableAbortedRepairV2(projectRoot, raw.value) ||
				await isStrictRetryableEmptyRepairRecoveryV2(projectRoot, raw.value));
		if (raw.ok && safeRawLineage) {
			const semanticDecision = await strictRepairLineageDecision(projectRoot, raw.value);
			if (semanticDecision === undefined) return { ok: false, code: "authority_invalid" };
			const plan = await strictRepairPlanFact(projectRoot, raw.value);
			if (!plan.ok) return { ok: false, code: "authority_invalid" };
			return ensureBounded({
				schema: WORKER_REPAIR_CAPSULE_SCHEMA,
				repair_of: repairOf,
				authority_kind: "v2_repair_lineage",
				authority_status: raw.value.status,
				contract_hash: raw.value.contract_hash,
				generation_content_hash: null,
				journal_hash: null,
				failure: {
					exit_code: null,
					reason_codes: ["SEMANTIC_REPAIR_REQUIRED",
						raw.value.status === "ABORTED" ? "REPAIR_ATTEMPT_ABORTED" : "REPAIR_EMPTY_RECOVERY_REQUIRED"],
					successful_write_count: null,
					denied_write_count: null,
				},
				changed_paths: [],
				changed_paths_omitted: 0,
				failed_runs: [],
				plan_ref: plan.value,
				repair_lineage: lineageFact(raw.value.repair_lineage),
				semantic_repair: semanticRepairFact(semanticDecision),
			});
		}
	}

	const unpublished = await readRecoverableUnpublishedDelegationV2(projectRoot, repairOf);
	if (unpublished.ok) {
		const { transaction, journal } = unpublished.value;
		const outcome = transaction.terminal_outcome;
		if (outcome === null || journal.journal_hash === null) return { ok: false, code: "authority_invalid" };
		const semanticDecision = transaction.repair_lineage === undefined
			? undefined
			: await strictRepairLineageDecision(projectRoot, transaction);
		if (transaction.repair_lineage !== undefined && semanticDecision === undefined) {
			return { ok: false, code: "authority_invalid" };
		}
		const plan = await strictRepairPlanFact(projectRoot, transaction);
		if (!plan.ok) return { ok: false, code: "authority_invalid" };
		const changed = boundedChangedPaths(outcome.changed_paths);
		const reasonCodes = [
			...(transaction.repair_lineage === undefined ? [] : ["SEMANTIC_REPAIR_REQUIRED"]),
			...transaction.postcondition_reasons,
		].slice(0, WORKER_REPAIR_CAPSULE_MAX_FAILURE_REASONS);
		return ensureBounded({
			schema: WORKER_REPAIR_CAPSULE_SCHEMA,
			repair_of: repairOf,
			authority_kind: transaction.repair_lineage === undefined ? "v2_unpublished" : "v2_repair_lineage",
			authority_status: transaction.status,
			contract_hash: transaction.contract_hash,
			generation_content_hash: null,
			journal_hash: journal.journal_hash,
			failure: {
				exit_code: outcome.exit_code,
				reason_codes: reasonCodes,
				successful_write_count: outcome.successful_write_count,
				denied_write_count: outcome.denied_write_count,
			},
			changed_paths: changed.paths,
			changed_paths_omitted: changed.omitted,
			failed_runs: [],
			plan_ref: plan.value,
			...(transaction.repair_lineage === undefined ? {} : { repair_lineage: lineageFact(transaction.repair_lineage) }),
			...(semanticDecision === undefined ? {} : { semantic_repair: semanticRepairFact(semanticDecision) }),
		});
	}
	if (!committedAbsent) {
		return {
			ok: false,
			code: unpublished.error.code === "storage_failure" ? "authority_unavailable" : "authority_invalid",
		};
	}
	if (unpublished.error.code !== "not_found") {
		return { ok: false, code: "authority_unavailable" };
	}

	const legacy = await readDelegationLedger(projectRoot, repairOf);
	if (!legacy || legacy.manifest.status !== "finished" || legacy.after === null) {
		return { ok: false, code: "authority_unavailable" };
	}
	const changed = boundedChangedPaths(legacy.after.changed_since_before);
	const failed = legacy.workerSummary?.status === "failure" || legacy.after.status === "failure";
	return ensureBounded({
		schema: WORKER_REPAIR_CAPSULE_SCHEMA,
		repair_of: repairOf,
		authority_kind: "legacy_v1",
		authority_status: legacy.after.status,
		contract_hash: null,
		generation_content_hash: null,
		journal_hash: null,
		failure: {
			exit_code: legacy.workerSummary?.exit_code ?? legacy.after.exit_code,
			reason_codes: failed ? ["LEGACY_WORKER_FAILURE"] : [],
			successful_write_count: null,
			denied_write_count: null,
		},
		changed_paths: changed.paths,
		changed_paths_omitted: changed.omitted,
		failed_runs: await failedRunFacts(
			projectRoot,
			legacy.workerSummary,
			legacy.manifest.created_at,
			legacy.manifest.finished_at!,
		),
		plan_ref: null,
	});
}
