/** Closed, content-free worker failure facts shared by runner and durable v2 authority. */

export const WORKER_RUN_FAILURE_CODES = [
	"COMPACTION_REJECTED",
	"CONTEXT_HARD_LIMIT",
	"SPEND_TOTAL_TOKEN_LIMIT",
	"SPEND_OUTPUT_TOKEN_LIMIT",
	"SPEND_TURN_LIMIT",
	/** Historical read compatibility only; the current runner emits SPEND_TURN_LIMIT. */
	"SPEND_TURN_LIMIT_LEGACY",
	"MODEL_IDENTITY_MISMATCH",
	"ABORTED",
	"TIMED_OUT",
	"EXIT_CODE_NONZERO",
	"STOP_REASON_FAILURE",
	"PROVIDER_RESPONSE_UNVERIFIED",
	"FINAL_OUTPUT_MISSING",
	/** A durable worker recipe failed even though its command effect was fully classified. */
	"COMMAND_EFFECT_RUN_FAILED",
] as const;

export type WorkerRunFailureCode = (typeof WORKER_RUN_FAILURE_CODES)[number];

export function isWorkerRunFailureCode(value: unknown): value is WorkerRunFailureCode {
	return WORKER_RUN_FAILURE_CODES.includes(value as WorkerRunFailureCode);
}

/**
 * Closed execution interruptions whose complete, attributed implementation
 * delta may be preserved as INTERRUPTED. Identity failures remain ordinary
 * FAILED/RECOVERY_REQUIRED and can never enter the later repair-review path.
 */
export const WORKER_RUN_INTERRUPTION_FAILURE_CODES = [
	"COMPACTION_REJECTED",
	"CONTEXT_HARD_LIMIT",
	"SPEND_TOTAL_TOKEN_LIMIT",
	"SPEND_OUTPUT_TOKEN_LIMIT",
	"SPEND_TURN_LIMIT",
	"SPEND_TURN_LIMIT_LEGACY",
	"ABORTED",
	"TIMED_OUT",
	"EXIT_CODE_NONZERO",
	"STOP_REASON_FAILURE",
	"FINAL_OUTPUT_MISSING",
] as const satisfies readonly WorkerRunFailureCode[];

export function isWorkerRunInterruptionFailureCode(value: unknown): value is WorkerRunFailureCode {
	return WORKER_RUN_INTERRUPTION_FAILURE_CODES.includes(
		value as (typeof WORKER_RUN_INTERRUPTION_FAILURE_CODES)[number],
	);
}
