/** Worker-only, one-shot no-progress advisory wiring. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	EMPTY_WORKER_NO_PROGRESS_STATE,
	WORKER_NO_PROGRESS_STEER_MESSAGE_TYPE,
	WORKER_NO_PROGRESS_STEER_TEXT,
	advanceWorkerNoProgress,
	type WorkerNoProgressState,
} from "./development-efficiency.ts";

export interface WorkerNoProgressControllerOptions {
	pi: Pick<ExtensionAPI, "on" | "sendMessage">;
	workerRole?: string;
	workerTaskKind?: string;
	/** Safety/context budget steering wins and permanently suppresses this advisory. */
	budgetSteerSent?: () => boolean;
}

const MAX_VERIFICATION_EVIDENCE_IDS = 256;

/**
 * Register a worker-only advisory.  Diagnosis is disabled by the pure policy;
 * the signal can fire at most once per session and never loops.
 */
export function registerWorkerNoProgressController(options: WorkerNoProgressControllerOptions): void {
	if (options.workerRole !== "worker") return;
	let state: WorkerNoProgressState = { ...EMPTY_WORKER_NO_PROGRESS_STATE };
	let successfulWrite = false;
	let newVerificationEvidence = false;
	const verificationIds = new Set<string>();

	options.pi.on("session_start", () => {
		state = { ...EMPTY_WORKER_NO_PROGRESS_STATE };
		successfulWrite = false;
		newVerificationEvidence = false;
		verificationIds.clear();
	});

	options.pi.on("tool_execution_end", (event) => {
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			successfulWrite = true;
			return;
		}
		if (event.toolName !== "workbench_run_recipe" || event.isError) return;
		const details = (event.result as { details?: unknown } | undefined)?.details;
		if (!details || typeof details !== "object" || Array.isArray(details)) return;
		const record = details as Record<string, unknown>;
		const runId = record.ok === true && typeof record.run_id === "string" ? record.run_id : undefined;
		if (!runId || verificationIds.has(runId)) return;
		// Once the bounded de-duplication set is full, prefer treating a later
		// successful run as progress over issuing a false no-progress steer.
		if (verificationIds.size < MAX_VERIFICATION_EVIDENCE_IDS) verificationIds.add(runId);
		newVerificationEvidence = true;
	});

	options.pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		if (options.budgetSteerSent?.()) {
			successfulWrite = false;
			newVerificationEvidence = false;
			return;
		}
		const decision = advanceWorkerNoProgress(state, {
			task_kind: options.workerTaskKind === "implementation" || options.workerTaskKind === "diagnosis"
				? options.workerTaskKind
				: "unknown",
			successful_write: successfulWrite,
			new_verification_evidence: newVerificationEvidence,
		});
		state = decision.state;
		successfulWrite = false;
		newVerificationEvidence = false;
		if (!decision.steer) return;
		try {
			options.pi.sendMessage({
				customType: WORKER_NO_PROGRESS_STEER_MESSAGE_TYPE,
				content: WORKER_NO_PROGRESS_STEER_TEXT,
				display: false,
				details: { consecutive_intervals: state.consecutive_intervals },
			}, { deliverAs: "steer" });
		} catch {
			// Advisory delivery never changes worker authority or termination.
		}
	});
}
