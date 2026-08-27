/**
 * Pure development-efficiency metrics and advisory policy.
 *
 * No function here grants authority, changes a model, selects a spend
 * profile, or persists a parallel telemetry stream. Missing evidence remains
 * `unknown` and never enters a rate denominator.
 */

import { COMMANDER_MODEL_ID, COMMANDER_PROVIDERS } from "./worker-policy.ts";

export const UNKNOWN_OBSERVATION = "unknown" as const;
export const COMMANDER_EXPECTED_REASONING = "xhigh" as const;
const KNOWN_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type UnknownObservation = typeof UNKNOWN_OBSERVATION;
export type ObservedNumber = number | UnknownObservation;

function finiteNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// -------------------------------------------------------------------------
// Current Sol/xhigh drift visibility. Observation only; no authority effect.
// -------------------------------------------------------------------------

export interface CurrentModelReasoningFacts {
	provider?: unknown;
	model?: unknown;
	reasoning?: unknown;
}

export function solCommanderDriftStatus(facts: CurrentModelReasoningFacts): string | null {
	if (typeof facts.provider !== "string" || typeof facts.model !== "string") return "MODEL:CMD_UNKNOWN";
	if (!COMMANDER_PROVIDERS.includes(facts.provider) || facts.model !== COMMANDER_MODEL_ID) return "MODEL:CMD_DRIFT";
	if (typeof facts.reasoning !== "string" || !(KNOWN_REASONING_LEVELS as readonly string[]).includes(facts.reasoning)) {
		return "MODEL:SOL_REASONING_UNKNOWN";
	}
	if (facts.reasoning !== COMMANDER_EXPECTED_REASONING) {
		return `MODEL:SOL_${facts.reasoning.toUpperCase()}!=${COMMANDER_EXPECTED_REASONING.toUpperCase()}`;
	}
	return null;
}

// -------------------------------------------------------------------------
// Existing-v2 delegation evidence aggregation.
// -------------------------------------------------------------------------

export interface DelegationEfficiencyFact {
	delegation_id: string;
	worker_outcome: "success" | "failure" | UnknownObservation;
	semantic_accepted: boolean | "not_required" | UnknownObservation;
	repair_depth: ObservedNumber;
	review_bytes: ObservedNumber;
	review_presentation_complete: boolean | UnknownObservation;
}

export interface DelegationEfficiencyMetrics {
	attempts: number;
	worker_outcomes_known: number;
	worker_successes: number;
	semantic_outcomes_known: number;
	semantic_accepted: number;
	semantic_not_required: number;
	accepted_yield: ObservedNumber;
	accepted_repair_depth_known: number;
	accepted_repair_depth_unknown: number;
	first_attempt_accepted: number;
	first_accepted_yield: ObservedNumber;
	repair_depth_known: number;
	repair_depth_unknown: number;
	max_repair_depth: ObservedNumber;
	review_bytes_known: number;
	review_bytes_unknown: number;
	review_bytes_observed_total: number;
	review_presentation_known: number;
	review_presentation_unknown: number;
	review_presentation_complete: number;
}

/** Aggregate one row per existing v2 delegation; duplicate ids are ignored. */
export function aggregateDelegationEfficiency(
	facts: readonly DelegationEfficiencyFact[],
): DelegationEfficiencyMetrics {
	const seen = new Set<string>();
	let attempts = 0;
	let workerOutcomesKnown = 0;
	let workerSuccesses = 0;
	let semanticOutcomesKnown = 0;
	let semanticAccepted = 0;
	let semanticNotRequired = 0;
	let acceptedRepairDepthKnown = 0;
	let acceptedRepairDepthUnknown = 0;
	let firstAttemptAccepted = 0;
	let repairDepthKnown = 0;
	let repairDepthUnknown = 0;
	let maxRepairDepth = 0;
	let reviewBytesKnown = 0;
	let reviewBytesUnknown = 0;
	let reviewBytesObservedTotal = 0;
	let reviewPresentationKnown = 0;
	let reviewPresentationUnknown = 0;
	let reviewPresentationComplete = 0;
	for (const fact of facts) {
		if (!fact.delegation_id || seen.has(fact.delegation_id)) continue;
		seen.add(fact.delegation_id);
		attempts += 1;
		if (fact.worker_outcome !== UNKNOWN_OBSERVATION) {
			workerOutcomesKnown += 1;
			if (fact.worker_outcome === "success") workerSuccesses += 1;
		}
		const depth = finiteNonNegativeInteger(fact.repair_depth);
		if (depth === undefined) repairDepthUnknown += 1;
		else {
			repairDepthKnown += 1;
			maxRepairDepth = Math.max(maxRepairDepth, depth);
		}
		if (fact.semantic_accepted === "not_required") {
			semanticNotRequired += 1;
		} else if (fact.semantic_accepted !== UNKNOWN_OBSERVATION) {
			semanticOutcomesKnown += 1;
			if (fact.semantic_accepted) semanticAccepted += 1;
			// First-accepted yield is conditioned only on explicit durable
			// acceptances. Failures remain valid overall-yield outcomes but never
			// enter this denominator. Any accepted row with unknown lineage makes
			// the first-accepted ratio unknown rather than partially observed.
			if (fact.semantic_accepted) {
				if (depth === undefined) acceptedRepairDepthUnknown += 1;
				else {
					acceptedRepairDepthKnown += 1;
					if (depth === 0) firstAttemptAccepted += 1;
				}
			}
		}
		const bytes = finiteNonNegativeInteger(fact.review_bytes);
		if (bytes !== undefined) {
			reviewBytesKnown += 1;
			reviewBytesObservedTotal += bytes;
		} else reviewBytesUnknown += 1;
		if (fact.review_presentation_complete === UNKNOWN_OBSERVATION) {
			reviewPresentationUnknown += 1;
		} else {
			reviewPresentationKnown += 1;
			if (fact.review_presentation_complete) reviewPresentationComplete += 1;
		}
	}
	return {
		attempts,
		worker_outcomes_known: workerOutcomesKnown,
		worker_successes: workerSuccesses,
		semantic_outcomes_known: semanticOutcomesKnown,
		semantic_accepted: semanticAccepted,
		semantic_not_required: semanticNotRequired,
		accepted_yield: semanticOutcomesKnown === 0 ? UNKNOWN_OBSERVATION : semanticAccepted / semanticOutcomesKnown,
		accepted_repair_depth_known: acceptedRepairDepthKnown,
		accepted_repair_depth_unknown: acceptedRepairDepthUnknown,
		first_attempt_accepted: firstAttemptAccepted,
		first_accepted_yield: acceptedRepairDepthKnown === 0 || acceptedRepairDepthUnknown > 0
			? UNKNOWN_OBSERVATION
			: firstAttemptAccepted / acceptedRepairDepthKnown,
		repair_depth_known: repairDepthKnown,
		repair_depth_unknown: repairDepthUnknown,
		max_repair_depth: repairDepthKnown === 0 || repairDepthUnknown > 0 ? UNKNOWN_OBSERVATION : maxRepairDepth,
		review_bytes_known: reviewBytesKnown,
		review_bytes_unknown: reviewBytesUnknown,
		review_bytes_observed_total: reviewBytesObservedTotal,
		review_presentation_known: reviewPresentationKnown,
		review_presentation_unknown: reviewPresentationUnknown,
		review_presentation_complete: reviewPresentationComplete,
	};
}

// -------------------------------------------------------------------------
// Pure standard/extended advisory routing. `effective_profile` preserves the
// current explicit-selection/default behavior; recommendation is evidence.
// -------------------------------------------------------------------------

export type ActiveWorkerProfile = "standard" | "extended";

export interface WorkerRoutingEvidence {
	task_kind?: unknown;
	requested_profile?: unknown;
	risk?: unknown;
	root_cause_known?: unknown;
	cross_cutting?: unknown;
	allowed_path_count?: unknown;
	acceptance_criterion_count?: unknown;
	verification_count?: unknown;
}

export interface WorkerRoutingDecision {
	recommended_profile: ActiveWorkerProfile;
	effective_profile: ActiveWorkerProfile;
	recommendation_status: "evidence_complete" | "insufficient_evidence";
	reasons: readonly string[];
	missing_evidence: readonly string[];
	explicit_conflict: boolean;
}

/** Recommend standard only for a fully evidenced low-risk implementation. */
export function decideWorkerProfile(evidence: WorkerRoutingEvidence): WorkerRoutingDecision {
	const requested = evidence.requested_profile === "standard" || evidence.requested_profile === "extended"
		? evidence.requested_profile
		: undefined;
	const effective: ActiveWorkerProfile = requested ?? "standard";
	const taskKind = evidence.task_kind === "implementation" || evidence.task_kind === "diagnosis"
		? evidence.task_kind
		: undefined;
	const risk = evidence.risk === "low" || evidence.risk === "medium" || evidence.risk === "high"
		? evidence.risk
		: undefined;
	const rootCauseKnown = typeof evidence.root_cause_known === "boolean" ? evidence.root_cause_known : undefined;
	const crossCutting = typeof evidence.cross_cutting === "boolean" ? evidence.cross_cutting : undefined;
	const allowedPathCount = finiteNonNegativeInteger(evidence.allowed_path_count);
	const acceptanceCount = finiteNonNegativeInteger(evidence.acceptance_criterion_count);
	const verificationCount = finiteNonNegativeInteger(evidence.verification_count);
	const required: Array<[string, unknown]> = [
		["task_kind", taskKind],
		["risk", risk],
		["cross_cutting", crossCutting],
		["allowed_path_count", allowedPathCount],
		["acceptance_criterion_count", acceptanceCount],
		["verification_count", verificationCount],
	];
	if (taskKind === "implementation") required.push(["root_cause_known", rootCauseKnown]);
	const missing = required.filter(([, value]) => value === undefined || value === UNKNOWN_OBSERVATION).map(([name]) => name);
	const standard = missing.length === 0
		&& taskKind === "implementation"
		&& risk === "low"
		&& rootCauseKnown === true
		&& crossCutting === false
		&& (allowedPathCount ?? 0) >= 1 && (allowedPathCount ?? Number.POSITIVE_INFINITY) <= 4
		&& (acceptanceCount ?? 0) >= 1
		&& (verificationCount ?? 0) >= 1;
	const recommended: ActiveWorkerProfile = standard ? "standard" : "extended";
	return {
		recommended_profile: recommended,
		effective_profile: effective,
		recommendation_status: missing.length === 0 ? "evidence_complete" : "insufficient_evidence",
		reasons: standard
			? ["bounded_low_risk_implementation"]
			: missing.length > 0
				? ["missing_routing_evidence"]
				: taskKind === "diagnosis"
					? ["diagnosis_exploration_reserve"]
					: ["risk_or_scope_requires_extended_reserve"],
		missing_evidence: missing,
		explicit_conflict: requested !== undefined && requested !== recommended,
	};
}

// -------------------------------------------------------------------------
// Worker-only one-shot no-progress advisory.
// -------------------------------------------------------------------------

export const WORKER_NO_PROGRESS_STEER_MESSAGE_TYPE = "workbench-worker-no-progress-steer" as const;
export const WORKER_IMPLEMENTATION_NO_PROGRESS_INTERVALS = 3 as const;
export const WORKER_NO_PROGRESS_STEER_TEXT = [
	"No successful write and no new verification evidence were observed across 3 consecutive worker intervals.",
	"Re-check the bounded task and current evidence now.",
	"Either make one concrete in-scope change, collect new verification evidence, or stop and hand off the blocker.",
].join("\n");

export interface WorkerNoProgressState {
	seen_assistant: boolean;
	consecutive_intervals: number;
	steer_sent: boolean;
}

export interface WorkerNoProgressInterval {
	task_kind: "implementation" | "diagnosis" | UnknownObservation;
	successful_write: boolean;
	new_verification_evidence: boolean;
}

export interface WorkerNoProgressDecision {
	state: WorkerNoProgressState;
	steer: boolean;
}

export const EMPTY_WORKER_NO_PROGRESS_STATE: Readonly<WorkerNoProgressState> = Object.freeze({
	seen_assistant: false,
	consecutive_intervals: 0,
	steer_sent: false,
});

/** Diagnosis is disabled until a separate evidence-backed threshold exists. */
export function advanceWorkerNoProgress(
	state: WorkerNoProgressState,
	interval: WorkerNoProgressInterval,
): WorkerNoProgressDecision {
	if (interval.task_kind !== "implementation") {
		return { state: { ...state, seen_assistant: true, consecutive_intervals: 0 }, steer: false };
	}
	if (!state.seen_assistant) return { state: { ...state, seen_assistant: true }, steer: false };
	const progressed = interval.successful_write || interval.new_verification_evidence;
	const consecutive = progressed ? 0 : state.consecutive_intervals + 1;
	const steer = !state.steer_sent && consecutive >= WORKER_IMPLEMENTATION_NO_PROGRESS_INTERVALS;
	return {
		state: { seen_assistant: true, consecutive_intervals: consecutive, steer_sent: state.steer_sent || steer },
		steer,
	};
}
