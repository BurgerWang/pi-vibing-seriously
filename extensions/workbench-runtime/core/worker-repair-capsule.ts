/** Pure, bounded repair facts passed from immutable authority to a fresh worker. */

export const WORKER_REPAIR_CAPSULE_SCHEMA = "workbench-worker-repair-v1" as const;
export const WORKER_REPAIR_CAPSULE_MAX_BYTES = 8 * 1024;
export const WORKER_REPAIR_CAPSULE_MAX_CHANGED_PATHS = 20;
export const WORKER_REPAIR_CAPSULE_MAX_FAILURE_REASONS = 8;
export const WORKER_REPAIR_CAPSULE_MAX_FAILED_RUNS = 4;

export interface WorkerRepairFailedRunFact {
	recipe: string;
	run_id: string;
	outcome: "PROCESS_FAILED" | "ARTIFACT_FAILED" | "COMMAND_EFFECT_FAILED";
}

export interface WorkerRepairPlanFact {
	plan_id: string;
	version: string;
	plan_path: string;
	plan_sha256: string;
	candidate: string;
}

export interface WorkerRepairLineageFact {
	root_delegation_id: string;
	repair_of: string;
	root_decision_hash: string;
	continuation_decision_delegation_id: string;
	continuation_decision_hash: string;
	lineage_hash: string;
	depth: number;
	carried_paths: string[];
	carried_paths_omitted: number;
}

export interface WorkerSemanticRepairDecisionFact {
	delegation_id: string;
	decision_hash: string;
	expected_bound_diff_hash: string;
	repair_reason: string;
	repair_reason_hash: string;
	reviewer: {
		provider: "openai" | "openai-codex";
		model: "gpt-5.6-sol";
	};
	decided_at: string;
}

export interface WorkerRepairCapsule {
	schema: typeof WORKER_REPAIR_CAPSULE_SCHEMA;
	repair_of: string;
	authority_kind: "v2_committed" | "v2_unpublished" | "v2_repair_lineage" | "legacy_v1";
	authority_status: string;
	contract_hash: string | null;
	generation_content_hash: string | null;
	journal_hash: string | null;
	failure: {
		exit_code: number | null;
		reason_codes: string[];
		successful_write_count: number | null;
		denied_write_count: number | null;
	};
	changed_paths: string[];
	changed_paths_omitted: number;
	failed_runs: WorkerRepairFailedRunFact[];
	plan_ref: WorkerRepairPlanFact | null;
	/** Additive for unresolved repair attempts; absent on historical capsules. */
	repair_lineage?: WorkerRepairLineageFact;
	/** Exact immutable Sol decision; bounded by the capsule's existing 8 KiB cap. */
	semantic_repair?: WorkerSemanticRepairDecisionFact;
}

/** Deterministic structured rendering; no report/session prose is accepted. */
export function formatWorkerRepairCapsule(capsule: Readonly<WorkerRepairCapsule>): string {
	const text = JSON.stringify(capsule);
	if (Buffer.byteLength(text, "utf8") > WORKER_REPAIR_CAPSULE_MAX_BYTES) {
		throw new Error(`Worker repair capsule exceeds ${WORKER_REPAIR_CAPSULE_MAX_BYTES} bytes`);
	}
	return text;
}
