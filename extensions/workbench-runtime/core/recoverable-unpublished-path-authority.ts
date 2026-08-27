/**
 * Strict path provenance for one unpublished delegation artifact failure.
 *
 * A proof-null transaction is never path authority by itself.  This module
 * recognizes only the existing revision-3 artifact-failure envelope, binds it
 * to its released execution owner and sealed write journal, and projects a
 * conservative path union.  The projection grants neither semantic review nor
 * repair authority; it exists only to localize an otherwise global blocker and
 * to prove an exact baseline before an inactive-blocker closure is published.
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalHash } from "../cache/canonical-hash.ts";
import { delegationsDir } from "./delegation-ledger.ts";
import { readDelegationExecutionOwnerV2 } from "./delegation-execution-owner.ts";
import { readDelegationTransactionV2 } from "./delegation-transaction-storage.ts";
import {
	DELEGATION_TRANSACTION_MAX_PATHS,
	parseDelegationTransaction,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import type { StreamingPathIdentity } from "./streaming-identity.ts";
import {
	readWorkerWriteJournal,
	validateWorkerWriteJournalRecord,
	type WorkerWriteJournalRecord,
} from "./write-journal.ts";

export const RECOVERABLE_UNPUBLISHED_PATH_AUTHORITY_KIND_V1 =
	"recoverable-unpublished-path-authority-v1" as const;

const RECOVERABLE_UNPUBLISHED_ARTIFACT_FAILURE_REASONS_V1 = new Set([
	"committed artifact construction failed",
	"committed artifact construction failed: invalid_contract",
	"committed artifact construction failed: invalid_state",
	"committed artifact construction failed: binding_conflict",
	"committed artifact construction failed: invalid_facts",
	"committed artifact construction failed: invalid_report",
	"committed artifact construction failed: review_envelope_exceeded",
	"committed artifact construction failed: record_too_large",
	"committed artifact construction failed: internal_error",
]);

const BLOCKER_CLOSURE_DIR_V2 = "blocker-closures-v2";

export type RecoverableUnpublishedPathAuthorityErrorCodeV1 =
	| "not_found"
	| "not_recoverable"
	| "invalid_record"
	| "storage_failure";

export interface RecoverableUnpublishedPathAuthorityV1 {
	readonly schema_version: 1;
	readonly kind: typeof RECOVERABLE_UNPUBLISHED_PATH_AUTHORITY_KIND_V1;
	readonly delegation_id: string;
	readonly transaction_hash: string;
	readonly journal_hash: string;
	/** Outcome paths plus every attempted journal path, excluding lineage-only paths. */
	readonly changed_paths: readonly string[];
	readonly carried_paths: readonly string[];
	readonly relevant_paths: readonly string[];
	/** First pre-operation identity for every journaled path. */
	readonly journal_before: readonly StreamingPathIdentity[];
	/** Relevant paths for which this proof-null envelope has no before identity. */
	readonly uncovered_baseline_paths: readonly string[];
	readonly baseline_complete: boolean;
	readonly authority_hash: string;
	readonly transaction: DelegationTransactionRecord;
	readonly journal: WorkerWriteJournalRecord;
}

export type RecoverableUnpublishedPathAuthorityResultV1 =
	| { ok: true; value: RecoverableUnpublishedPathAuthorityV1 }
	| { ok: false; error: { code: RecoverableUnpublishedPathAuthorityErrorCodeV1 } };

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort(byteCompare);
}

export function isRecoverableUnpublishedPathAuthorityCandidateV1(
	transaction: DelegationTransactionRecord,
): boolean {
	const outcome = transaction.terminal_outcome;
	return transaction.status === "RECOVERY_REQUIRED" && transaction.revision === 3 &&
		transaction.committed_proof === null && transaction.review === null && outcome !== null &&
		outcome.terminal_facts_complete && outcome.scope_complete &&
		transaction.recovery_reason !== null &&
		RECOVERABLE_UNPUBLISHED_ARTIFACT_FAILURE_REASONS_V1.has(transaction.recovery_reason);
}

function strictPathEnvelopeShape(transaction: DelegationTransactionRecord): boolean {
	return isRecoverableUnpublishedPathAuthorityCandidateV1(transaction) &&
		transaction.terminal_outcome?.change_set_status === "ATTRIBUTED";
}

async function validateStrictPathAuthorityInventoryV1(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
): Promise<RecoverableUnpublishedPathAuthorityResultV1 | undefined> {
	const root = join(delegationsDir(projectRoot), transaction.delegation_id, "v2");
	const expectedClosureName = `${canonicalHash(transaction)}.json`;
	try {
		const rootStat = await lstat(root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
			return { ok: false, error: { code: "invalid_record" } };
		}
		const entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
		let hasTransaction = false;
		let hasJournal = false;
		for (const entry of entries) {
			if (entry.isSymbolicLink()) return { ok: false, error: { code: "invalid_record" } };
			if (entry.name === "transaction.json" || entry.name === "write-journal.json") {
				if (!entry.isFile()) return { ok: false, error: { code: "invalid_record" } };
				if (entry.name === "transaction.json") hasTransaction = true;
				else hasJournal = true;
				continue;
			}
			if (entry.name === "generations") {
				if (!entry.isDirectory() || (await readdir(join(root, entry.name))).length !== 0) {
					return { ok: false, error: { code: "not_recoverable" } };
				}
				continue;
			}
			if (entry.name === BLOCKER_CLOSURE_DIR_V2) {
				if (!entry.isDirectory()) return { ok: false, error: { code: "invalid_record" } };
				const closures = await readdir(join(root, entry.name), {
					withFileTypes: true,
					encoding: "utf8",
				});
				if (closures.length > 1 || closures.some((closure) =>
					closure.name !== expectedClosureName || !closure.isFile() || closure.isSymbolicLink())) {
					return { ok: false, error: { code: "not_recoverable" } };
				}
				continue;
			}
			return { ok: false, error: { code: "not_recoverable" } };
		}
		return hasTransaction && hasJournal
			? undefined
			: { ok: false, error: { code: "invalid_record" } };
	} catch (error) {
		return {
			ok: false,
			error: {
				code: (error as NodeJS.ErrnoException).code === "ENOENT"
					? "invalid_record"
					: "storage_failure",
			},
		};
	}
}

/**
 * Pure strict projection over an already-read transaction and journal.
 * Mismatched outcome/journal counters are corruption, not a recoverable
 * absence.  Failed operations still enter the conflict domain because a
 * failed mutator may have touched bytes before returning failure.
 */
export function resolveRecoverableUnpublishedPathAuthorityV1(
	transaction: DelegationTransactionRecord,
	journal: WorkerWriteJournalRecord,
): RecoverableUnpublishedPathAuthorityResultV1 {
	const parsed = parseDelegationTransaction(transaction);
	if (!parsed.ok || canonicalHash(parsed.state) !== canonicalHash(transaction)) {
		return { ok: false, error: { code: "invalid_record" } };
	}
	if (!strictPathEnvelopeShape(transaction)) {
		return { ok: false, error: { code: "not_recoverable" } };
	}
	if (!validateWorkerWriteJournalRecord(journal) || journal.delegation_id !== transaction.delegation_id ||
		journal.contract_hash !== transaction.contract_hash) {
		return { ok: false, error: { code: "invalid_record" } };
	}
	if (journal.state !== "SEALED" || journal.journal_hash === null ||
		journal.operations.some((operation) => operation.status !== "completed")) {
		return { ok: false, error: { code: "not_recoverable" } };
	}
	const successfulWrites = journal.operations.filter((operation) =>
		operation.status === "completed" && operation.outcome === "succeeded").length;
	if (transaction.terminal_outcome!.successful_write_count !== successfulWrites) {
		return { ok: false, error: { code: "invalid_record" } };
	}

	const journalPaths = sortedUnique(journal.operations.map((operation) => operation.path));
	const changedPaths = sortedUnique([
		...transaction.terminal_outcome!.changed_paths,
		...journalPaths,
	]);
	const carriedPaths = [...(transaction.repair_lineage?.carried_paths ?? [])];
	const relevantPaths = sortedUnique([...changedPaths, ...carriedPaths]);
	if (changedPaths.length > DELEGATION_TRANSACTION_MAX_PATHS ||
		carriedPaths.length > DELEGATION_TRANSACTION_MAX_PATHS ||
		relevantPaths.length > DELEGATION_TRANSACTION_MAX_PATHS) {
		return { ok: false, error: { code: "invalid_record" } };
	}

	const firstBefore = new Map<string, StreamingPathIdentity>();
	for (const operation of journal.operations) {
		if (!firstBefore.has(operation.path)) firstBefore.set(operation.path, operation.before);
	}
	const journalBefore = [...firstBefore.entries()]
		.sort(([left], [right]) => byteCompare(left, right))
		.map(([, identity]) => identity);
	const uncoveredBaselinePaths = relevantPaths.filter((path) => !firstBefore.has(path));
	const payload = {
		schema_version: 1 as const,
		kind: RECOVERABLE_UNPUBLISHED_PATH_AUTHORITY_KIND_V1,
		delegation_id: transaction.delegation_id,
		transaction_hash: canonicalHash(transaction),
		journal_hash: journal.journal_hash,
		changed_paths: changedPaths,
		carried_paths: carriedPaths,
		relevant_paths: relevantPaths,
		journal_before: journalBefore,
		uncovered_baseline_paths: uncoveredBaselinePaths,
		baseline_complete: uncoveredBaselinePaths.length === 0,
	};
	return {
		ok: true,
		value: {
			...payload,
			authority_hash: canonicalHash(payload),
			transaction,
			journal,
		},
	};
}

/** Read the complete released proof-null envelope and return conservative paths. */
export async function readRecoverableUnpublishedPathAuthorityV1(
	projectRoot: string,
	delegationId: string,
): Promise<RecoverableUnpublishedPathAuthorityResultV1> {
	const transaction = await readDelegationTransactionV2(projectRoot, delegationId);
	if (!transaction.ok) {
		return {
			ok: false,
			error: {
				code: transaction.error.code === "not_found"
					? "not_found"
					: transaction.error.code === "storage_failure"
						? "storage_failure"
						: "invalid_record",
			},
		};
	}
	if (!strictPathEnvelopeShape(transaction.value)) {
		return { ok: false, error: { code: "not_recoverable" } };
	}
	const journal = await readWorkerWriteJournal({
		project_root: projectRoot,
		delegation_id: delegationId,
		contract_hash: transaction.value.contract_hash,
	});
	if (!journal.ok) {
		return {
			ok: false,
			error: {
				code: journal.error.code === "not_found"
					? "not_found"
					: journal.error.code === "storage_failure"
						? "storage_failure"
						: "invalid_record",
			},
		};
	}
	const projected = resolveRecoverableUnpublishedPathAuthorityV1(transaction.value, journal.value);
	if (!projected.ok) return projected;

	const owner = await readDelegationExecutionOwnerV2(projectRoot, transaction.value);
	if (owner.ok) return { ok: false, error: { code: "not_recoverable" } };
	if (owner.error.code !== "not_found") {
		return {
			ok: false,
			error: {
				code: owner.error.code === "storage_failure" ? "storage_failure" : "invalid_record",
			},
		};
	}
	const inventoryFailure = await validateStrictPathAuthorityInventoryV1(projectRoot, transaction.value);
	if (inventoryFailure !== undefined) return inventoryFailure;
	return projected;
}
