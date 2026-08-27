/**
 * Project-authority admission for historical delegation path lanes.
 *
 * The delegate controller calls `admit...` before mutation and then calls
 * `revalidate...` under the checkout writer lease immediately before the
 * durable PREPARED transition. Proceeding requires both `unchanged === true`
 * and an ALLOW decision. This path-lane admission does not permit concurrent
 * writers: the shared checkout remains protected by its global writer lease.
 *
 * Historical path authority comes only from hash-verified committed
 * generations, strict ChangeSets/command provenance, repair-lineage records,
 * and exact closure readers. Live Git state and historical `allowed_paths`
 * are never path provenance. ChangeSet v2 has no persisted rename pairing, so
 * this service intentionally emits an empty rename map rather than guessing.
 */

import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";

import { canonicalHash } from "../cache/canonical-hash.ts";
import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import {
	validateDelegationCommandProvenance,
	type DelegationCommandProvenanceRecord,
} from "./delegation-command-effect-provenance.ts";
import { delegationsDir, isValidDelegationId } from "./delegation-ledger.ts";
import {
	hasDelegationSemanticReviewAuthorityV2,
	isDelegationTerminalNegativeReviewEligibleFromCommittedV1,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationSemanticRepairDecisionV1,
	readDelegationTerminalNegativeSolAuthorityV1,
	readDelegationTransactionV2,
	type DelegationCommittedGenerationV2,
	type DelegationSemanticRepairDecisionV1,
} from "./delegation-transaction-storage.ts";
import {
	readDelegationCleanRepairAbandonmentV1,
} from "./delegation-repair-abandonment.ts";
import {
	readDelegationInactiveBlockerClosureV2,
} from "./delegation-authority-closure.ts";
import {
	DELEGATION_TRANSACTION_ID_RE,
	parseDelegationTransaction,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import { readStrictRetryableRawRepairEvidenceV1 } from "./delegation-execution-owner.ts";
import { readRecoverableUnpublishedPathAuthorityV1 } from "./recoverable-unpublished-path-authority.ts";
import {
	DELEGATION_PATH_LANE_REQUEST_KIND_V1,
	DELEGATION_PATH_LANE_SCHEMA_VERSION_V1,
	decideDelegationPathLaneV1,
	type DelegationPathLaneBlockerV1,
	type DelegationPathLaneBlockReasonV1,
	type DelegationPathLaneDecisionV1,
	type DelegationPathLaneInvalidReasonV1,
	type DelegationPathLaneUnknownReasonV1,
} from "./delegation-path-lane.ts";
import { projectDelegationDispositionV2 } from "./delegation-project-authority.ts";

export const DELEGATION_PATH_LANE_ADMISSION_KIND_V1 = "delegation-path-lane-admission-v1" as const;
export const DELEGATION_PATH_LANE_REVALIDATION_KIND_V1 = "delegation-path-lane-revalidation-v1" as const;

/**
 * Project projections which describe multiple otherwise readable historical
 * blockers.  These are not authority corruption: a caller may continue only
 * after this module has scanned the complete project and returned ALLOW for
 * the requested path lane.  Every other project issue remains fail-closed.
 */
export const DELEGATION_PATH_LANE_BYPASSABLE_PROJECT_ISSUES_V1 = [
	"additional_unresolved_authority",
	"repair_lineage_multiple_unresolved",
] as const;

export type DelegationPathLaneBypassableProjectIssueV1 =
	(typeof DELEGATION_PATH_LANE_BYPASSABLE_PROJECT_ISSUES_V1)[number];

export function isDelegationPathLaneBypassableProjectIssueV1(
	code: unknown,
): code is DelegationPathLaneBypassableProjectIssueV1 {
	return typeof code === "string" &&
		(DELEGATION_PATH_LANE_BYPASSABLE_PROJECT_ISSUES_V1 as readonly string[]).includes(code);
}

type ReadErrorCode = "conflict" | "invalid_input" | "invalid_record" | "not_found" | "not_recoverable" | "storage_failure" | "unsupported_version";

type AuthorityRead<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: ReadErrorCode } };

type InventoryRead =
	| { ok: true; value: readonly string[] }
	| {
		ok: false;
		failure: {
			delegation_id: string | null;
			authority_state: "INVALID" | "UNKNOWN";
			reason: DelegationPathLaneInvalidReasonV1 | DelegationPathLaneUnknownReasonV1;
		};
	};

export interface DelegationPathLaneImmutablePathsV1 {
	readonly changed_paths: readonly string[];
	readonly carried_paths: readonly string[];
}

/** Dependency seam is exported only for deterministic storage-fault tests. */
export interface DelegationPathLaneAdmissionReadersV1 {
	listDelegationIds(projectRoot: string): Promise<InventoryRead>;
	readTransaction(projectRoot: string, delegationId: string): Promise<AuthorityRead<DelegationTransactionRecord>>;
	readSemanticRepairDecision(projectRoot: string, delegationId: string): Promise<AuthorityRead<DelegationSemanticRepairDecisionV1 | undefined>>;
	readTerminalNegativeRepairDecision(
		projectRoot: string,
		transaction: DelegationTransactionRecord,
	): Promise<AuthorityRead<DelegationSemanticRepairDecisionV1 | undefined>>;
	readInactiveClosure(projectRoot: string, transaction: DelegationTransactionRecord): Promise<AuthorityRead<boolean>>;
	readRepairAbandonment(
		projectRoot: string,
		tip: DelegationTransactionRecord,
		rootDecision: DelegationSemanticRepairDecisionV1,
	): Promise<AuthorityRead<boolean>>;
	readSemanticReviewClosure(projectRoot: string, transaction: DelegationTransactionRecord): Promise<AuthorityRead<boolean>>;
	readImmutablePaths(projectRoot: string, transaction: DelegationTransactionRecord): Promise<AuthorityRead<DelegationPathLaneImmutablePathsV1>>;
}

export interface DelegationPathLaneAdmissionInputV1 {
	readonly project_root: string;
	readonly allowed_paths: readonly string[];
	/**
	 * Internal exact-repair request. It is honored only when the id is a
	 * currently enumerated repair tip backed by known immutable paths.
	 */
	readonly repair_tip_exclusion_id?: string;
}

export interface DelegationPathLaneAdmissionV1 {
	readonly schema_version: 1;
	readonly kind: typeof DELEGATION_PATH_LANE_ADMISSION_KIND_V1;
	/** Hash of full unresolved authority plus the requested tip exclusion. */
	readonly authority_hash: string;
	readonly ordinary_blocker_ids: readonly string[];
	readonly repair_tip_ids: readonly string[];
	readonly repair_tip_exclusion_id: string | null;
	readonly blockers: readonly DelegationPathLaneBlockerV1[];
	readonly decision: DelegationPathLaneDecisionV1;
}

export interface DelegationPathLaneRevalidationV1 {
	readonly schema_version: 1;
	readonly kind: typeof DELEGATION_PATH_LANE_REVALIDATION_KIND_V1;
	readonly expected_authority_hash: string;
	readonly observed_authority_hash: string;
	readonly unchanged: boolean;
	readonly admission: DelegationPathLaneAdmissionV1;
}

interface ScanFailure {
	readonly delegation_id: string | null;
	readonly authority_state: "INVALID" | "UNKNOWN";
	readonly reason: DelegationPathLaneInvalidReasonV1 | DelegationPathLaneUnknownReasonV1;
}

interface ScannedAuthority {
	readonly ordinaryIds: string[];
	readonly repairTipIds: string[];
	readonly blockers: DelegationPathLaneBlockerV1[];
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorFailure(code: ReadErrorCode, delegationId: string | null): ScanFailure {
	if (code === "not_found") return { delegation_id: delegationId, authority_state: "UNKNOWN", reason: "NOT_FOUND" };
	if (code === "storage_failure") return { delegation_id: delegationId, authority_state: "UNKNOWN", reason: "STORAGE_FAILURE" };
	if (code === "unsupported_version") return { delegation_id: delegationId, authority_state: "INVALID", reason: "SCHEMA_MISMATCH" };
	return { delegation_id: delegationId, authority_state: "INVALID", reason: "INVALID_RECORD" };
}

function invalidGraph(delegationId: string | null): ScanFailure {
	return { delegation_id: delegationId, authority_state: "INVALID", reason: "INVALID_RECORD" };
}

function dataRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort(byteCompare);
	const expected = [...fields].sort(byteCompare);
	return sameStrings(actual, expected);
}

function strictStringList(value: unknown): value is string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return false;
	return value.every((item, index) => index === 0 || byteCompare(value[index - 1]!, item) < 0);
}

function strictCommittedPaths(
	transaction: DelegationTransactionRecord,
	committed: DelegationCommittedGenerationV2,
): DelegationPathLaneImmutablePathsV1 | undefined {
	if (canonicalHash(committed.state) !== canonicalHash(transaction) || committed.proof.generation !== transaction.generation) return undefined;
	const scope = committed.records["scope.json"];
	if (!dataRecord(scope)) return undefined;
	const baseFields = [
		"schema_version", "delegation_id", "task_kind", "contract_hash", "allowed_paths", "changed_paths", "write_journal", "change_set",
	] as const;
	const hasCommand = Object.prototype.hasOwnProperty.call(scope, "command_provenance");
	if (!exactFields(scope, hasCommand ? [...baseFields, "command_provenance"] : baseFields) ||
		scope.schema_version !== 2 || scope.delegation_id !== transaction.delegation_id ||
		scope.task_kind !== transaction.task_kind || scope.contract_hash !== transaction.contract_hash ||
		!strictStringList(scope.changed_paths)) return undefined;
	const changeSet = scope.change_set;
	if (!validateChangeSet(changeSet) || changeSet.delegation_id !== transaction.delegation_id ||
		changeSet.contract_hash !== transaction.contract_hash) return undefined;
	const command = hasCommand ? scope.command_provenance : undefined;
	if (command !== undefined && !validateDelegationCommandProvenance(command, changeSet)) return undefined;
	const provenance = command as DelegationCommandProvenanceRecord | undefined;
	const changedPaths = provenance === undefined
		? changeSet.worker_delta.map((entry) => entry.path)
		: [...provenance.effective_paths];
	const outcome = transaction.terminal_outcome;
	if (outcome === null || !sameStrings(scope.changed_paths, changedPaths) || !sameStrings(outcome.changed_paths, changedPaths) ||
		outcome.change_set_status !== (provenance?.effective_status ?? changeSet.status) ||
		(transaction.task_kind === "implementation"
			? outcome.delta_hash !== (provenance?.effective_delta_hash ?? changeSet.worker_delta_hash)
			: outcome.delta_hash !== null)) return undefined;
	return {
		changed_paths: changedPaths,
		carried_paths: [...(transaction.repair_lineage?.carried_paths ?? [])],
	};
}

async function listDelegationIds(projectRoot: string): Promise<InventoryRead> {
	const root = delegationsDir(projectRoot);
	let entries: Dirent<string>[];
	try {
		const stat = await lstat(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			return { ok: false, failure: invalidGraph(null) };
		}
		entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { ok: true, value: [] }
			: { ok: false, failure: { delegation_id: null, authority_state: "UNKNOWN", reason: "STORAGE_FAILURE" } };
	}
	const ids: string[] = [];
	for (const entry of entries) {
		if (!isValidDelegationId(entry.name)) continue;
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			return { ok: false, failure: invalidGraph(entry.name) };
		}
		ids.push(entry.name);
	}
	ids.sort(byteCompare);
	return { ok: true, value: ids };
}

const DEFAULT_READERS: DelegationPathLaneAdmissionReadersV1 = {
	listDelegationIds,
	readTransaction: async (projectRoot, delegationId) => readDelegationTransactionV2(projectRoot, delegationId),
	readSemanticRepairDecision: async (projectRoot, delegationId) => readDelegationSemanticRepairDecisionV1(projectRoot, delegationId),
	readTerminalNegativeRepairDecision: async (projectRoot, transaction) => {
		if (transaction.repair_lineage !== undefined
			|| (transaction.status !== "FAILED" && transaction.status !== "INTERRUPTED")) {
			return { ok: true, value: undefined };
		}
		const committed = await readDelegationCommittedGenerationV2(projectRoot, transaction.delegation_id);
		if (!committed.ok) return committed;
		if (canonicalHash(committed.value.state) !== canonicalHash(transaction)) {
			return { ok: false, error: { code: "invalid_record" } };
		}
		if (!isDelegationTerminalNegativeReviewEligibleFromCommittedV1(transaction, committed.value.records)) {
			return { ok: true, value: undefined };
		}
		const read = await readDelegationTerminalNegativeSolAuthorityV1(projectRoot, transaction.delegation_id);
		if (!read.ok) return read.error.code === "not_found" ? { ok: true, value: undefined } : read;
		return canonicalHash(read.value.state) === canonicalHash(transaction)
			? { ok: true, value: read.value.decision }
			: { ok: false, error: { code: "invalid_record" } };
	},
	readInactiveClosure: async (projectRoot, transaction) => {
		const read = await readDelegationInactiveBlockerClosureV2(projectRoot, transaction);
		return read.ok ? { ok: true, value: read.value !== undefined } : read;
	},
	readRepairAbandonment: async (projectRoot, tip, rootDecision) => {
		const read = await readDelegationCleanRepairAbandonmentV1(projectRoot, tip, rootDecision);
		return read.ok ? { ok: true, value: read.value !== undefined } : read;
	},
	readSemanticReviewClosure: async (projectRoot, transaction) => {
		const read = await readDelegationReviewV2(projectRoot, transaction.delegation_id);
		return read.ok ? { ok: true, value: read.value.finalized && hasDelegationSemanticReviewAuthorityV2(read.value) } : read;
	},
	readImmutablePaths: async (projectRoot, transaction) => {
		if (transaction.committed_proof === null) {
			if (transaction.repair_lineage !== undefined) {
				const raw = await readStrictRetryableRawRepairEvidenceV1(projectRoot, transaction);
				if (raw.ok) {
					if (raw.value.transaction_hash !== canonicalHash(transaction)) {
						return { ok: false, error: { code: "conflict" } };
					}
					return {
						ok: true,
						value: {
							changed_paths: [],
							carried_paths: [...transaction.repair_lineage.carried_paths],
						},
					};
				}
				if (raw.code === "STORAGE_FAILURE") return { ok: false, error: { code: "storage_failure" } };
				if (raw.code === "AUTHORITY_CHANGED") return { ok: false, error: { code: "conflict" } };
			}
			const recoverable = await readRecoverableUnpublishedPathAuthorityV1(
				projectRoot,
				transaction.delegation_id,
			);
			if (!recoverable.ok) {
				return recoverable.error.code === "not_recoverable"
					? { ok: false, error: { code: "not_found" } }
					: recoverable;
			}
			if (recoverable.value.transaction_hash !== canonicalHash(transaction)) {
				return { ok: false, error: { code: "conflict" } };
			}
			return {
				ok: true,
				value: {
					changed_paths: [...recoverable.value.changed_paths],
					carried_paths: [...recoverable.value.carried_paths],
				},
			};
		}
		const read = await readDelegationCommittedGenerationV2(projectRoot, transaction.delegation_id);
		if (!read.ok) return read;
		const paths = strictCommittedPaths(transaction, read.value);
		return paths === undefined
			? { ok: false, error: { code: "invalid_record" } }
			: { ok: true, value: paths };
	},
};

function pathSubset(subset: readonly string[], superset: readonly string[]): boolean {
	const available = new Set(superset);
	return subset.every((path) => available.has(path));
}

async function scanAuthority(
	projectRoot: string,
	readers: DelegationPathLaneAdmissionReadersV1,
): Promise<{ ok: true; value: ScannedAuthority } | { ok: false; failure: ScanFailure }> {
	const listed = await readers.listDelegationIds(projectRoot);
	if (!listed.ok) return listed;
	const ids = [...listed.value].sort(byteCompare);
	if (ids.some((id, index) => !DELEGATION_TRANSACTION_ID_RE.test(id) || (index > 0 && ids[index - 1] === id))) {
		return { ok: false, failure: invalidGraph(null) };
	}

	const transactions = new Map<string, DelegationTransactionRecord>();
	for (const id of ids) {
		const read = await readers.readTransaction(projectRoot, id);
		if (!read.ok) return { ok: false, failure: errorFailure(read.error.code, id) };
		const parsed = parseDelegationTransaction(read.value);
		if (!parsed.ok || parsed.state.delegation_id !== id) return { ok: false, failure: invalidGraph(id) };
		transactions.set(id, parsed.state);
	}

	const decisions = new Map<string, DelegationSemanticRepairDecisionV1>();
	for (const transaction of transactions.values()) {
		let read: AuthorityRead<DelegationSemanticRepairDecisionV1 | undefined>;
		if (transaction.status === "PENDING_REVIEW") {
			read = await readers.readSemanticRepairDecision(projectRoot, transaction.delegation_id);
		} else if (transaction.repair_lineage === undefined
			&& (transaction.status === "FAILED" || transaction.status === "INTERRUPTED")) {
			read = await readers.readTerminalNegativeRepairDecision(projectRoot, transaction);
		} else {
			continue;
		}
		if (!read.ok) return { ok: false, failure: errorFailure(read.error.code, transaction.delegation_id) };
		if (read.value !== undefined) {
			if (read.value.delegation_id !== transaction.delegation_id || read.value.contract_hash !== transaction.contract_hash) {
				return { ok: false, failure: invalidGraph(transaction.delegation_id) };
			}
			decisions.set(transaction.delegation_id, read.value);
		}
	}

	const roots = new Map<string, DelegationTransactionRecord>();
	const lineaged = new Map<string, DelegationTransactionRecord>();
	for (const transaction of transactions.values()) {
		if (transaction.repair_lineage !== undefined) lineaged.set(transaction.delegation_id, transaction);
		else if (decisions.has(transaction.delegation_id)) roots.set(transaction.delegation_id, transaction);
	}
	const children = new Map<string, string>();
	for (const child of lineaged.values()) {
		const lineage = child.repair_lineage!;
		const root = roots.get(lineage.root_delegation_id);
		const rootDecision = decisions.get(lineage.root_delegation_id);
		const parent = transactions.get(lineage.repair_of);
		const continuation = decisions.get(lineage.continuation_decision_delegation_id);
		if (root === undefined || rootDecision === undefined || parent === undefined ||
			rootDecision.decision_hash !== lineage.root_decision_hash || continuation === undefined ||
			continuation.decision_hash !== lineage.continuation_decision_hash ||
			parent.created_at > child.created_at || rootDecision.decided_at > child.created_at || continuation.decided_at > child.created_at ||
			children.has(parent.delegation_id)) return { ok: false, failure: invalidGraph(child.delegation_id) };
		if (lineage.depth === 1) {
			if (parent.delegation_id !== root.delegation_id || parent.repair_lineage !== undefined ||
				lineage.parent_lineage_hash !== null || lineage.continuation_decision_delegation_id !== parent.delegation_id) {
				return { ok: false, failure: invalidGraph(child.delegation_id) };
			}
		} else {
			const parentLineage = parent.repair_lineage;
			if (parentLineage === undefined || lineage.parent_lineage_hash !== parentLineage.lineage_hash ||
				parentLineage.root_delegation_id !== lineage.root_delegation_id || lineage.depth !== parentLineage.depth + 1 ||
				!pathSubset(parentLineage.carried_paths, lineage.carried_paths)) {
				return { ok: false, failure: invalidGraph(child.delegation_id) };
			}
			if (decisions.has(parent.delegation_id)) {
				const parentDecision = decisions.get(parent.delegation_id);
				if (parentDecision === undefined || lineage.continuation_decision_delegation_id !== parent.delegation_id ||
					lineage.continuation_decision_hash !== parentDecision.decision_hash) {
					return { ok: false, failure: invalidGraph(child.delegation_id) };
				}
			} else if (lineage.continuation_decision_delegation_id !== parentLineage.continuation_decision_delegation_id ||
				lineage.continuation_decision_hash !== parentLineage.continuation_decision_hash) {
				return { ok: false, failure: invalidGraph(child.delegation_id) };
			}
		}
		children.set(parent.delegation_id, child.delegation_id);
	}

	const reached = new Set<string>();
	const repairTips: DelegationTransactionRecord[] = [];
	for (const root of [...roots.values()].sort((a, b) => byteCompare(a.delegation_id, b.delegation_id))) {
		let current = root;
		const seen = new Set<string>();
		while (true) {
			if (seen.has(current.delegation_id)) return { ok: false, failure: invalidGraph(current.delegation_id) };
			seen.add(current.delegation_id);
			if (current.repair_lineage !== undefined) reached.add(current.delegation_id);
			const next = children.get(current.delegation_id);
			if (next === undefined) break;
			const nextTransaction = lineaged.get(next);
			if (nextTransaction === undefined) return { ok: false, failure: invalidGraph(next) };
			current = nextTransaction;
		}
		const rootDecision = decisions.get(root.delegation_id)!;
		const abandoned = await readers.readRepairAbandonment(projectRoot, current, rootDecision);
		if (!abandoned.ok) return { ok: false, failure: errorFailure(abandoned.error.code, current.delegation_id) };
		const inactive = await readers.readInactiveClosure(projectRoot, current);
		if (!inactive.ok) return { ok: false, failure: errorFailure(inactive.error.code, current.delegation_id) };
		let closed = abandoned.value || inactive.value;
		if (!closed && current.status === "REVIEWED") {
			const reviewed = await readers.readSemanticReviewClosure(projectRoot, current);
			if (!reviewed.ok) return { ok: false, failure: errorFailure(reviewed.error.code, current.delegation_id) };
			closed = reviewed.value;
		}
		if (!closed) repairTips.push(current);
	}
	if (reached.size !== lineaged.size) {
		const hidden = [...lineaged.keys()].sort(byteCompare).find((id) => !reached.has(id));
		return { ok: false, failure: invalidGraph(hidden ?? null) };
	}

	const ordinary: DelegationTransactionRecord[] = [];
	for (const transaction of transactions.values()) {
		if (transaction.repair_lineage !== undefined || roots.has(transaction.delegation_id) ||
			!projectDelegationDispositionV2(transaction).blocking) continue;
		const closure = await readers.readInactiveClosure(projectRoot, transaction);
		if (!closure.ok) return { ok: false, failure: errorFailure(closure.error.code, transaction.delegation_id) };
		if (!closure.value) ordinary.push(transaction);
	}

	ordinary.sort((a, b) => byteCompare(a.delegation_id, b.delegation_id));
	repairTips.sort((a, b) => byteCompare(a.delegation_id, b.delegation_id));
	const unresolved = [...ordinary, ...repairTips].sort((a, b) => byteCompare(a.delegation_id, b.delegation_id));
	const blockers: DelegationPathLaneBlockerV1[] = [];
	for (const transaction of unresolved) {
		const paths = await readers.readImmutablePaths(projectRoot, transaction);
		if (!paths.ok) {
			const failure = errorFailure(paths.error.code, transaction.delegation_id);
			blockers.push(failure.authority_state === "UNKNOWN"
				? { kind: "unknown", delegation_id: transaction.delegation_id, reason: failure.reason as DelegationPathLaneUnknownReasonV1 }
				: { kind: "invalid", delegation_id: transaction.delegation_id, reason: failure.reason as DelegationPathLaneInvalidReasonV1 });
			continue;
		}
		if (!sameStrings(paths.value.carried_paths, transaction.repair_lineage?.carried_paths ?? [])) {
			blockers.push({ kind: "invalid", delegation_id: transaction.delegation_id, reason: "INVALID_RECORD" });
			continue;
		}
		blockers.push({
			kind: "known",
			delegation_id: transaction.delegation_id,
			changed_paths: [...paths.value.changed_paths],
			carried_paths: [...paths.value.carried_paths],
			rename_sources: {},
		});
	}

	// Bound the scan against directory/transaction races. Closures are
	// append-only, so observing a newly appended closure conservatively leaves
	// an extra blocker until the controller's second revalidation.
	const relisted = await readers.listDelegationIds(projectRoot);
	if (!relisted.ok) return relisted;
	if (!sameStrings(ids, [...relisted.value].sort(byteCompare))) {
		return { ok: false, failure: { delegation_id: null, authority_state: "UNKNOWN", reason: "AMBIGUOUS" } };
	}
	for (const [id, transaction] of transactions) {
		const reread = await readers.readTransaction(projectRoot, id);
		if (!reread.ok) return { ok: false, failure: errorFailure(reread.error.code, id) };
		const parsed = parseDelegationTransaction(reread.value);
		if (!parsed.ok || canonicalHash(parsed.state) !== canonicalHash(transaction)) {
			return { ok: false, failure: { delegation_id: id, authority_state: "UNKNOWN", reason: "AMBIGUOUS" } };
		}
	}
	return {
		ok: true,
		value: {
			ordinaryIds: ordinary.map((transaction) => transaction.delegation_id),
			repairTipIds: repairTips.map((transaction) => transaction.delegation_id),
			blockers,
		},
	};
}

function decisionForFailure(allowedPaths: readonly string[], failure: ScanFailure): DelegationPathLaneDecisionV1 {
	if (failure.delegation_id !== null) {
		const blocker: DelegationPathLaneBlockerV1 = failure.authority_state === "UNKNOWN"
			? { kind: "unknown", delegation_id: failure.delegation_id, reason: failure.reason as DelegationPathLaneUnknownReasonV1 }
			: { kind: "invalid", delegation_id: failure.delegation_id, reason: failure.reason as DelegationPathLaneInvalidReasonV1 };
		return decideDelegationPathLaneV1({
			schema_version: DELEGATION_PATH_LANE_SCHEMA_VERSION_V1,
			kind: DELEGATION_PATH_LANE_REQUEST_KIND_V1,
			allowed_paths: allowedPaths,
			blockers: [blocker],
		});
	}
	const base = decideDelegationPathLaneV1({
		schema_version: DELEGATION_PATH_LANE_SCHEMA_VERSION_V1,
		kind: DELEGATION_PATH_LANE_REQUEST_KIND_V1,
		allowed_paths: allowedPaths,
		blockers: [],
	});
	if (base.decision === "BLOCK") return base;
	return {
		...base,
		decision: "BLOCK",
		block_reasons: [failure.authority_state === "UNKNOWN" ? "UNKNOWN_AUTHORITY" : "INVALID_AUTHORITY"],
		authority_failures: [failure],
	};
}

function blockInvalidExclusion(decision: DelegationPathLaneDecisionV1): DelegationPathLaneDecisionV1 {
	const blockReasons = [...new Set<DelegationPathLaneBlockReasonV1>([
		...decision.block_reasons,
		"INVALID_REQUEST",
	])].sort(byteCompare);
	return {
		...decision,
		decision: "BLOCK",
		block_reasons: blockReasons,
	};
}

/**
 * Read all project authority and decide one proposed delegation path lane.
 * Production callers must omit `readers`; injected readers carry no authority.
 */
export async function admitProjectDelegationPathLaneV1(
	input: DelegationPathLaneAdmissionInputV1,
	readers: DelegationPathLaneAdmissionReadersV1 = DEFAULT_READERS,
): Promise<DelegationPathLaneAdmissionV1> {
	const scanned = await scanAuthority(input.project_root, readers);
	const ordinaryIds = scanned.ok ? scanned.value.ordinaryIds : [];
	const repairTipIds = scanned.ok ? scanned.value.repairTipIds : [];
	const blockers = scanned.ok ? scanned.value.blockers : [];
	const exclusionRequested = input.repair_tip_exclusion_id !== undefined;
	const exclusionId = typeof input.repair_tip_exclusion_id === "string"
		? input.repair_tip_exclusion_id
		: null;
	const authorityPayload = scanned.ok
		? {
			authority: { ordinary_blocker_ids: ordinaryIds, repair_tip_ids: repairTipIds, blockers },
			repair_tip_exclusion_id: exclusionId,
		}
		: { authority: { failure: scanned.failure }, repair_tip_exclusion_id: exclusionId };
	const matchingBlockers = exclusionId === null
		? []
		: blockers.filter((blocker) => blocker.delegation_id === exclusionId);
	const validExclusion = exclusionRequested && exclusionId !== null && isValidDelegationId(exclusionId) && scanned.ok &&
		repairTipIds.includes(exclusionId) && !ordinaryIds.includes(exclusionId) && matchingBlockers.length === 1 &&
		matchingBlockers[0]!.kind === "known";
	const decisionBlockers = validExclusion
		? blockers.filter((blocker) => blocker.delegation_id !== exclusionId)
		: blockers;
	const baseDecision = scanned.ok
		? decideDelegationPathLaneV1({
			schema_version: DELEGATION_PATH_LANE_SCHEMA_VERSION_V1,
			kind: DELEGATION_PATH_LANE_REQUEST_KIND_V1,
			allowed_paths: input.allowed_paths,
			blockers: decisionBlockers,
		})
		: decisionForFailure(input.allowed_paths, scanned.failure);
	const decision = exclusionRequested && !validExclusion
		? blockInvalidExclusion(baseDecision)
		: baseDecision;
	return {
		schema_version: 1,
		kind: DELEGATION_PATH_LANE_ADMISSION_KIND_V1,
		authority_hash: canonicalHash(authorityPayload),
		ordinary_blocker_ids: ordinaryIds,
		repair_tip_ids: repairTipIds,
		repair_tip_exclusion_id: exclusionId,
		blockers,
		decision,
	};
}

/** Second-read seam for a controller's under-lease TOCTOU check. */
export async function revalidateProjectDelegationPathLaneV1(
	input: DelegationPathLaneAdmissionInputV1 & { readonly expected_authority_hash: string },
	readers: DelegationPathLaneAdmissionReadersV1 = DEFAULT_READERS,
): Promise<DelegationPathLaneRevalidationV1> {
	const admission = await admitProjectDelegationPathLaneV1(input, readers);
	return {
		schema_version: 1,
		kind: DELEGATION_PATH_LANE_REVALIDATION_KIND_V1,
		expected_authority_hash: input.expected_authority_hash,
		observed_authority_hash: admission.authority_hash,
		unchanged: input.expected_authority_hash === admission.authority_hash,
		admission,
	};
}
