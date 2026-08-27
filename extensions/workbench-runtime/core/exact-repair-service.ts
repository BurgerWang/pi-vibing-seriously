/** UI-free execution of one exact semantic or terminal repair. */

import { canonicalHash } from "../cache/canonical-hash.ts";
import {
	delegationStatusToolActionV1,
	repairDelegationToolActionV1,
	reviewDelegationToolActionV1,
} from "./agent-next-action.ts";
import type {
	DelegateExactRepairExecuteV1,
} from "./delegate-tool-controller.ts";
import {
	recoverExactRepairCommandAuthorityV1,
	type ExactRepairAuthorityRecoveryCodeV1,
	type ExactRepairCommandAuthorityV1,
} from "./exact-repair-authority.ts";
import {
	readRawLineageImmutableRepairV1,
	recoverRawLineageExactRepairAuthorityV1,
	type RawLineageExactRepairAuthorityCodeV1,
} from "./exact-repair-raw-lineage-authority.ts";
import {
	readExactRepairSuccessorV1,
	readRawLineageExactRepairSuccessorV1,
	type ExactRepairExistingSuccessorV1,
	type ExactRepairSuccessorReadCodeV1,
} from "./exact-repair-successor.ts";
import {
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTerminalNegativeSolAuthorityV1,
	readDelegationTransactionV2,
	type DelegationReviewAuthorityV2,
	type DelegationTerminalNegativeSolAuthorityV1,
	type DelegationCommittedGenerationV2,
} from "./delegation-transaction-storage.ts";
import {
	DELEGATION_TRANSACTION_ID_RE,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";

export type ExactRepairExecutionResultV1 = Awaited<ReturnType<DelegateExactRepairExecuteV1>>;

export interface ExactRepairServiceInputV1 {
	readonly project_root: string;
	readonly repair_of: string;
	readonly signal: Parameters<DelegateExactRepairExecuteV1>[1];
	readonly on_update: Parameters<DelegateExactRepairExecuteV1>[2];
	readonly execution_context: Parameters<DelegateExactRepairExecuteV1>[3];
}

export interface ExactRepairServiceDependenciesV1 {
	readonly executeExactRepair: DelegateExactRepairExecuteV1;
	readonly collectCurrentBinding: (
		projectRoot: string,
		delegationId: string,
	) => Promise<
		| { readonly status: "unavailable" }
		| { readonly status: "fresh" | "conflict"; readonly hash: string }
	>;
	readonly readCommittedGeneration?: typeof readDelegationCommittedGenerationV2;
	readonly readReview?: typeof readDelegationReviewV2;
	readonly readTerminalNegativeRepair?: typeof readDelegationTerminalNegativeSolAuthorityV1;
	readonly readSuccessor?: typeof readExactRepairSuccessorV1;
	readonly readTransaction?: typeof readDelegationTransactionV2;
	readonly readRawImmutable?: typeof readRawLineageImmutableRepairV1;
	readonly readRawSuccessor?: typeof readRawLineageExactRepairSuccessorV1;
	/** Fault-injection seam. Production always uses strict deterministic recovery. */
	readonly recoverAuthority?: typeof recoverExactRepairCommandAuthorityV1;
	/** Fault-injection seam for strict no-write raw lineage recovery. */
	readonly recoverRawAuthority?: typeof recoverRawLineageExactRepairAuthorityV1;
}

interface ExactRepairRecoveredBaseV1 {
	readonly repair_of: string;
	readonly authority: Readonly<ExactRepairCommandAuthorityV1>;
}

export interface ExactRepairAuthorityUnavailableV1 {
	readonly status: "AUTHORITY_UNAVAILABLE";
	readonly repair_of: string;
	readonly source: "committed" | "semantic-repair" | "terminal-negative-repair" | "raw-lineage";
	readonly code: string;
}

export interface ExactRepairRecoveryRefusedV1 {
	readonly status: "RECOVERY_REFUSED";
	readonly repair_of: string;
	readonly code: "INVALID_DELEGATION_ID" | ExactRepairAuthorityRecoveryCodeV1 | RawLineageExactRepairAuthorityCodeV1;
}

export interface ExactRepairIdempotencyRefusedV1 extends ExactRepairRecoveredBaseV1 {
	readonly status: "IDEMPOTENCY_REFUSED";
	readonly code: ExactRepairSuccessorReadCodeV1;
	readonly conflicting_delegation?: string;
}

export interface ExactRepairBindingChangedV1 extends ExactRepairRecoveredBaseV1 {
	readonly status: "CURRENT_BINDING_CHANGED";
}

export interface ExactRepairSuccessorRecordedV1 extends ExactRepairRecoveredBaseV1 {
	readonly status: "SUCCESSOR_RECORDED";
	readonly successor: Readonly<ExactRepairExistingSuccessorV1>;
	readonly replayed: boolean;
	readonly execution_attempted: boolean;
	readonly execution_outcome: "not_started" | "returned" | "threw";
	readonly execution_status?: "completed" | "refused";
	readonly execution_result?: ExactRepairExecutionResultV1;
	readonly execution_error?: string;
}

export interface ExactRepairSuccessorDispositionV1 extends ExactRepairRecoveredBaseV1 {
	readonly status: "SUCCESSOR_ACTIVE" | "EXACT_REPAIR_PENDING" | "SUCCESSOR_BLOCKED";
	readonly successor: Readonly<ExactRepairExistingSuccessorV1>;
	readonly replayed: boolean;
	readonly execution_attempted: boolean;
	readonly execution_outcome: "not_started" | "returned" | "threw";
	readonly execution_result?: ExactRepairExecutionResultV1;
	readonly execution_error?: string;
}

export interface ExactRepairExecutionRefusedV1 extends ExactRepairRecoveredBaseV1 {
	readonly status: "EXECUTION_REFUSED";
	readonly execution_attempted: true;
	readonly execution_result: ExactRepairExecutionResultV1;
}

export interface ExactRepairExecutionReadbackFailedV1 extends ExactRepairRecoveredBaseV1 {
	readonly status: "EXECUTION_READBACK_FAILED";
	readonly execution_attempted: true;
	readonly code: "SUCCESSOR_MISSING" | ExactRepairSuccessorReadCodeV1;
	readonly execution_result: ExactRepairExecutionResultV1;
}

export interface ExactRepairExecutionFailedV1 extends ExactRepairRecoveredBaseV1 {
	readonly status: "EXECUTION_FAILED";
	readonly execution_attempted: true;
	readonly error: string;
	readonly successor_readback:
		| { readonly status: "none" }
		| { readonly status: "error"; readonly code: ExactRepairSuccessorReadCodeV1 };
}

export interface ExactRepairUnexpectedErrorV1 {
	readonly status: "UNEXPECTED_ERROR";
	readonly repair_of: string;
	readonly error: string;
}

export interface ExactRepairRawSuccessorReplayV1 {
	readonly status: "RAW_SUCCESSOR_REPLAY";
	readonly repair_of: string;
	readonly immutable_authority_hash: string;
	readonly successor: Readonly<ExactRepairExistingSuccessorV1>;
	readonly execution_attempted: false;
	readonly next_action: string | null;
}

export type ExactRepairServiceResultV1 =
	| ExactRepairAuthorityUnavailableV1
	| ExactRepairRecoveryRefusedV1
	| ExactRepairIdempotencyRefusedV1
	| ExactRepairBindingChangedV1
	| ExactRepairSuccessorRecordedV1
	| ExactRepairSuccessorDispositionV1
	| ExactRepairExecutionRefusedV1
	| ExactRepairExecutionReadbackFailedV1
	| ExactRepairExecutionFailedV1
	| ExactRepairRawSuccessorReplayV1
	| ExactRepairUnexpectedErrorV1;

/** Bound runner shape for lifecycle hooks and higher-level coordinators. */
export type ExactRepairServiceRunnerV1 = (
	input: ExactRepairServiceInputV1,
) => Promise<ExactRepairServiceResultV1>;

function executionWasRefused(result: ExactRepairExecutionResultV1): boolean {
	return typeof result.details === "object" && result.details !== null &&
		(result.details as Record<string, unknown>).ok === false;
}

export function exactRepairSuccessorNextActionV1(successor: ExactRepairExistingSuccessorV1): string | null {
	if (successor.disposition === "REVIEW_PENDING") return reviewDelegationToolActionV1(successor.delegation_id);
	if (successor.disposition === "REPAIR_PENDING" || successor.disposition === "EXACT_REPAIR_PENDING") {
		return repairDelegationToolActionV1(successor.delegation_id);
	}
	if (successor.disposition === "ACTIVE") return delegationStatusToolActionV1();
	if (successor.disposition === "BLOCKED") return delegationStatusToolActionV1();
	return null;
}

function rawSuccessorReplayResult(input: {
	repair_of: string;
	immutable_authority_hash: string;
	successor: Readonly<ExactRepairExistingSuccessorV1>;
}): ExactRepairRawSuccessorReplayV1 {
	return {
		status: "RAW_SUCCESSOR_REPLAY",
		repair_of: input.repair_of,
		immutable_authority_hash: input.immutable_authority_hash,
		successor: input.successor,
		execution_attempted: false,
		next_action: exactRepairSuccessorNextActionV1(input.successor),
	};
}

function existingSuccessorResult(input: {
	repair_of: string;
	authority: Readonly<ExactRepairCommandAuthorityV1>;
	successor: Readonly<ExactRepairExistingSuccessorV1>;
	replayed: boolean;
	execution_attempted: boolean;
	execution_outcome: "not_started" | "returned" | "threw";
	execution_status?: "completed" | "refused";
	execution_result?: ExactRepairExecutionResultV1;
	execution_error?: string;
}): ExactRepairSuccessorRecordedV1 | ExactRepairSuccessorDispositionV1 {
	const common = {
		repair_of: input.repair_of,
		authority: input.authority,
		successor: input.successor,
		replayed: input.replayed,
		execution_attempted: input.execution_attempted,
		execution_outcome: input.execution_outcome,
		...(input.execution_result === undefined ? {} : { execution_result: input.execution_result }),
		...(input.execution_error === undefined ? {} : { execution_error: input.execution_error }),
	};
	if (input.successor.disposition === "ACTIVE") return { status: "SUCCESSOR_ACTIVE", ...common };
	if (input.successor.disposition === "EXACT_REPAIR_PENDING") return { status: "EXACT_REPAIR_PENDING", ...common };
	if (input.successor.disposition === "BLOCKED") return { status: "SUCCESSOR_BLOCKED", ...common };
	return {
		status: "SUCCESSOR_RECORDED",
		...common,
		...(input.execution_status === undefined ? {} : { execution_status: input.execution_status }),
	};
}

/**
 * Strictly recover one immutable repair request, replay any existing durable
 * successor, and otherwise invoke the private exact delegate bridge once.
 * A tool return or exception is never success evidence without strict
 * successor readback.
 */
export async function runExactRepairServiceV1(
	input: ExactRepairServiceInputV1,
	dependencies: ExactRepairServiceDependenciesV1,
): Promise<ExactRepairServiceResultV1> {
	const repairOf = input.repair_of;
	if (!DELEGATION_TRANSACTION_ID_RE.test(repairOf)) {
		return { status: "RECOVERY_REFUSED", repair_of: repairOf, code: "INVALID_DELEGATION_ID" };
	}
	const readCommitted = dependencies.readCommittedGeneration ?? readDelegationCommittedGenerationV2;
	const readReview = dependencies.readReview ?? readDelegationReviewV2;
	const readTerminalNegative = dependencies.readTerminalNegativeRepair ?? readDelegationTerminalNegativeSolAuthorityV1;
	const readSuccessor = dependencies.readSuccessor ?? readExactRepairSuccessorV1;
	const readTransaction = dependencies.readTransaction ?? readDelegationTransactionV2;
	const readRawImmutable = dependencies.readRawImmutable ?? readRawLineageImmutableRepairV1;
	const readRawSuccessor = dependencies.readRawSuccessor ?? readRawLineageExactRepairSuccessorV1;
	const recoverAuthority = dependencies.recoverAuthority ?? recoverExactRepairCommandAuthorityV1;
	const recoverRawAuthority = dependencies.recoverRawAuthority ?? recoverRawLineageExactRepairAuthorityV1;

	try {
		const committed = await readCommitted(input.project_root, repairOf);
		let parent: DelegationCommittedGenerationV2 | DelegationTransactionRecord;
		let authority: Readonly<ExactRepairCommandAuthorityV1>;
		let terminalNegativeNeedsFreshBinding = false;
		let currentBindingHash: string | undefined;
		if (committed.ok) {
			let review: DelegationReviewAuthorityV2 | undefined;
			let terminalNegativeRepair: DelegationTerminalNegativeSolAuthorityV1 | undefined;
			if (committed.value.state.status === "PENDING_REVIEW") {
				const read = await readReview(input.project_root, repairOf);
				if (!read.ok) {
					return { status: "AUTHORITY_UNAVAILABLE", repair_of: repairOf, source: "semantic-repair", code: read.error.code };
				}
				review = read.value;
			} else if (committed.value.state.status === "INTERRUPTED" ||
				(committed.value.state.status === "FAILED" && committed.value.state.repair_lineage === undefined)) {
				const read = await readTerminalNegative(input.project_root, repairOf);
				if (!read.ok) {
					return { status: "AUTHORITY_UNAVAILABLE", repair_of: repairOf, source: "terminal-negative-repair", code: read.error.code };
				}
				terminalNegativeRepair = read.value;
				currentBindingHash = read.value.bound_diff_hash;
				terminalNegativeNeedsFreshBinding = true;
			}
			const recovered = recoverAuthority({
				repairOf,
				committed: committed.value,
				...(review === undefined ? {} : { review }),
				...(terminalNegativeRepair === undefined ? {} : { terminalNegativeRepair }),
				...(currentBindingHash === undefined ? {} : { currentBindingHash }),
			});
			if (!recovered.ok) return { status: "RECOVERY_REFUSED", repair_of: repairOf, code: recovered.code };
			parent = committed.value;
			authority = recovered.value;
		} else {
			if (committed.error.code === "storage_failure") {
				return { status: "AUTHORITY_UNAVAILABLE", repair_of: repairOf, source: "committed", code: committed.error.code };
			}
			const immutable = await readRawImmutable(input.project_root, repairOf);
			if (!immutable.ok) return { status: "RECOVERY_REFUSED", repair_of: repairOf, code: immutable.code };
			const replay = await readRawSuccessor({ projectRoot: input.project_root, immutable: immutable.value });
			if (!replay.ok) {
				return { status: "AUTHORITY_UNAVAILABLE", repair_of: repairOf, source: "raw-lineage", code: replay.code };
			}
			if (replay.kind === "existing") {
				return rawSuccessorReplayResult({
					repair_of: repairOf,
					immutable_authority_hash: immutable.value.immutable_hash,
					successor: replay.value,
				});
			}
			const rawRecovered = await recoverRawAuthority({
				project_root: input.project_root,
				repair_of: repairOf,
				collectCurrentBinding: dependencies.collectCurrentBinding,
			});
			if (!rawRecovered.ok) {
				const racedReplay = await readRawSuccessor({ projectRoot: input.project_root, immutable: immutable.value });
				if (!racedReplay.ok) {
					return { status: "AUTHORITY_UNAVAILABLE", repair_of: repairOf, source: "raw-lineage", code: racedReplay.code };
				}
				if (racedReplay.kind === "existing") {
					return rawSuccessorReplayResult({
						repair_of: repairOf,
						immutable_authority_hash: immutable.value.immutable_hash,
						successor: racedReplay.value,
					});
				}
				return { status: "RECOVERY_REFUSED", repair_of: repairOf, code: rawRecovered.code };
			}
			const raw = await readTransaction(input.project_root, repairOf);
			if (!raw.ok || canonicalHash(raw.value) !== rawRecovered.value.raw_tip_transaction_hash ||
				canonicalHash(raw.value) !== canonicalHash(immutable.value.parent)) {
				const racedReplay = await readRawSuccessor({ projectRoot: input.project_root, immutable: immutable.value });
				if (!racedReplay.ok) {
					return { status: "AUTHORITY_UNAVAILABLE", repair_of: repairOf, source: "raw-lineage", code: racedReplay.code };
				}
				if (racedReplay.kind === "existing") {
					return rawSuccessorReplayResult({
						repair_of: repairOf,
						immutable_authority_hash: immutable.value.immutable_hash,
						successor: racedReplay.value,
					});
				}
				return {
					status: "AUTHORITY_UNAVAILABLE",
					repair_of: repairOf,
					source: "raw-lineage",
					code: raw.ok ? "AUTHORITY_CHANGED" : raw.error.code,
				};
			}
			parent = raw.value;
			authority = rawRecovered.value;
		}
		const priorSuccessor = await readSuccessor({
			projectRoot: input.project_root,
			parent,
			authority,
		});
		if (!priorSuccessor.ok) {
			return {
				status: "IDEMPOTENCY_REFUSED",
				repair_of: repairOf,
				authority,
				code: priorSuccessor.code,
				...(priorSuccessor.delegation_id === undefined ? {} : { conflicting_delegation: priorSuccessor.delegation_id }),
			};
		}
		if (priorSuccessor.kind === "existing") {
			return existingSuccessorResult({
				repair_of: repairOf,
				authority,
				successor: priorSuccessor.value,
				replayed: true,
				execution_attempted: false,
				execution_outcome: "not_started",
			});
		}

		if (terminalNegativeNeedsFreshBinding) {
			const binding = await dependencies.collectCurrentBinding(input.project_root, repairOf);
			if (binding.status !== "fresh" || binding.hash !== currentBindingHash) {
				return { status: "CURRENT_BINDING_CHANGED", repair_of: repairOf, authority };
			}
		}

		try {
			const executionResult = await dependencies.executeExactRepair(
				authority,
				input.signal,
				input.on_update,
				input.execution_context,
			);
			const refused = executionWasRefused(executionResult);
			const durableSuccessor = await readSuccessor({
				projectRoot: input.project_root,
				parent,
				authority,
			});
			if (durableSuccessor.ok && durableSuccessor.kind === "existing") {
				return existingSuccessorResult({
					repair_of: repairOf,
					authority,
					successor: durableSuccessor.value,
					replayed: false,
					execution_attempted: true,
					execution_outcome: "returned",
					execution_status: refused ? "refused" : "completed",
					execution_result: executionResult,
				});
			}
			if (refused && durableSuccessor.ok && durableSuccessor.kind === "none") {
				return {
					status: "EXECUTION_REFUSED",
					repair_of: repairOf,
					authority,
					execution_attempted: true,
					execution_result: executionResult,
				};
			}
			return {
				status: "EXECUTION_READBACK_FAILED",
				repair_of: repairOf,
				authority,
				execution_attempted: true,
				code: durableSuccessor.ok ? "SUCCESSOR_MISSING" : durableSuccessor.code,
				execution_result: executionResult,
			};
		} catch (error) {
			const durableSuccessor = await readSuccessor({
				projectRoot: input.project_root,
				parent,
				authority,
			});
			const message = error instanceof Error ? error.message : String(error);
			if (durableSuccessor.ok && durableSuccessor.kind === "existing") {
				return existingSuccessorResult({
					repair_of: repairOf,
					authority,
					successor: durableSuccessor.value,
					replayed: false,
					execution_attempted: true,
					execution_outcome: "threw",
					execution_error: message,
				});
			}
			return {
				status: "EXECUTION_FAILED",
				repair_of: repairOf,
				authority,
				execution_attempted: true,
				error: message,
				successor_readback: durableSuccessor.ok
					? { status: "none" }
					: { status: "error", code: durableSuccessor.code },
			};
		}
	} catch (error) {
		return {
			status: "UNEXPECTED_ERROR",
			repair_of: repairOf,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
