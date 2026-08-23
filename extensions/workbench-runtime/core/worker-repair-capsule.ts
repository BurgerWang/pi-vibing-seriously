/** Pure, bounded repair facts passed from immutable authority to a fresh worker. */

export const WORKER_REPAIR_CAPSULE_SCHEMA = "workbench-worker-repair-v1" as const;
export const WORKER_REPAIR_CAPSULE_MAX_BYTES = 8 * 1024;
export const WORKER_REPAIR_CAPSULE_MAX_CHANGED_PATHS = 20;
export const WORKER_REPAIR_CAPSULE_MAX_FAILURE_REASONS = 8;
export const WORKER_REPAIR_CAPSULE_MAX_FAILED_RUNS = 4;

export interface WorkerRepairFailedRunFact {
	recipe: string;
	run_id: string;
	outcome: "PROCESS_FAILED" | "ARTIFACT_FAILED";
}

export interface WorkerRepairPlanFact {
	plan_id: string;
	version: string;
	plan_path: string;
	plan_sha256: string;
	candidate: string;
}

export interface WorkerRepairCapsule {
	schema: typeof WORKER_REPAIR_CAPSULE_SCHEMA;
	repair_of: string;
	authority_kind: "v2_committed" | "v2_unpublished" | "legacy_v1";
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
}

/** Deterministic structured rendering; no report/session prose is accepted. */
export function formatWorkerRepairCapsule(capsule: Readonly<WorkerRepairCapsule>): string {
	const text = JSON.stringify(capsule);
	if (Buffer.byteLength(text, "utf8") > WORKER_REPAIR_CAPSULE_MAX_BYTES) {
		throw new Error(`Worker repair capsule exceeds ${WORKER_REPAIR_CAPSULE_MAX_BYTES} bytes`);
	}
	return text;
}
