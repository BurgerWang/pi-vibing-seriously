/** Strict durable replay detection for `/q-repair`. */

import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { canonicalHash } from "../cache/canonical-hash.ts";
import { delegationsDir, isValidDelegationId } from "./delegation-ledger.ts";
import { isDelegationPathLaneBypassableProjectIssueV1 } from "./delegation-path-lane-admission.ts";
import { readStrictRetryableRawRepairEvidenceV1 } from "./delegation-execution-owner.ts";
import { readProjectDelegationRepairClosureV1 } from "./delegation-project-authority.ts";
import { normalizeDelegationBoundedTaskContractV2 } from "./delegation-transaction-artifacts.ts";
import {
	hasDelegationSemanticRepairAuthorityV2,
	hasDelegationSemanticReviewAuthorityV2,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTerminalNegativeSolAuthorityV1,
	readDelegationTransactionV2,
	type DelegationCommittedGenerationV2,
} from "./delegation-transaction-storage.ts";
import {
	parseDelegationRepairLineageV1,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import {
	recoverExactRepairCommandAuthorityV1,
	type ExactRepairToolArgumentsV1,
	type ExactRepairCommandAuthorityV1,
} from "./exact-repair-authority.ts";
import type { RawLineageImmutableRepairV1 } from "./exact-repair-raw-lineage-authority.ts";

export type ExactRepairSuccessorReadCodeV1 =
	| "AUTHORITY_INVALID"
	| "IDEMPOTENCY_CONFLICT"
	| "STORAGE_FAILURE";

export interface ExactRepairExistingSuccessorV1 {
	readonly delegation_id: string;
	readonly status: DelegationTransactionRecord["status"];
	readonly contract_hash: string;
	readonly transaction_hash: string;
	readonly committed_proof_content_hash: string | null;
	readonly disposition:
		| "ACTIVE"
		| "REVIEW_PENDING"
		| "REPAIR_PENDING"
		| "CHAIN_CLOSED"
		| "EXACT_REPAIR_PENDING"
		| "BLOCKED";
}

export type ExactRepairSuccessorParentV1 = DelegationCommittedGenerationV2 | DelegationTransactionRecord;

export type ReadExactRepairSuccessorResultV1 =
	| { readonly ok: true; readonly kind: "none" }
	| { readonly ok: true; readonly kind: "existing"; readonly value: Readonly<ExactRepairExistingSuccessorV1> }
	| { readonly ok: false; readonly code: ExactRepairSuccessorReadCodeV1; readonly delegation_id?: string };

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function lineageMatchesAuthority(
	parent: DelegationTransactionRecord,
	authority: ExactRepairCommandAuthorityV1,
	candidate: DelegationTransactionRecord,
): boolean {
	const lineage = candidate.repair_lineage;
	return lineage !== undefined && lineage.repair_of === parent.delegation_id &&
		canonicalHash(lineage) === canonicalHash(authority.successor_lineage);
}

function authorityMatchesParent(
	parent: DelegationTransactionRecord,
	authority: ExactRepairCommandAuthorityV1,
): boolean {
	const { idempotency_key: idempotencyKey, tool_call_id: toolCallId, ...projection } = authority;
	if (canonicalHash(projection) !== idempotencyKey || toolCallId !== `q-repair-${idempotencyKey}`) return false;
	const successor = parseDelegationRepairLineageV1(authority.successor_lineage);
	const parentLineage = parent.repair_lineage === undefined
		? undefined
		: parseDelegationRepairLineageV1(parent.repair_lineage);
	if (successor === undefined || (parent.repair_lineage !== undefined && parentLineage === undefined) ||
		successor.repair_of !== parent.delegation_id) return false;
	if (authority.authority_kind === "raw-lineage-retry") {
		return parent.committed_proof === null && parentLineage !== undefined &&
			authority.raw_tip_transaction_hash === canonicalHash(parent) &&
			authority.root_delegation_id === parentLineage.root_delegation_id &&
			authority.root_decision_hash === parentLineage.root_decision_hash &&
			authority.lineage_hash === parentLineage.lineage_hash &&
			successor.root_delegation_id === parentLineage.root_delegation_id &&
			successor.root_decision_hash === parentLineage.root_decision_hash &&
			successor.continuation_decision_delegation_id === parentLineage.continuation_decision_delegation_id &&
			successor.continuation_decision_hash === parentLineage.continuation_decision_hash &&
			successor.parent_lineage_hash === parentLineage.lineage_hash;
	}
	if (authority.authority_kind === "terminal-lineage") {
		return parentLineage !== undefined && authority.lineage_hash === parentLineage.lineage_hash &&
			successor.root_delegation_id === parentLineage.root_delegation_id &&
			successor.root_decision_hash === parentLineage.root_decision_hash &&
			successor.continuation_decision_delegation_id === parentLineage.continuation_decision_delegation_id &&
			successor.continuation_decision_hash === parentLineage.continuation_decision_hash &&
			successor.parent_lineage_hash === parentLineage.lineage_hash;
	}
	if (!/^[a-f0-9]{64}$/u.test(authority.semantic_decision_hash) ||
		(authority.authority_kind === "terminal-negative-repair" &&
			!/^[a-f0-9]{64}$/u.test(authority.expected_bound_diff_hash)) ||
		successor.continuation_decision_delegation_id !== parent.delegation_id ||
		successor.continuation_decision_hash !== authority.semantic_decision_hash) return false;
	if (parentLineage === undefined) {
		return successor.depth === 1 && successor.root_delegation_id === parent.delegation_id &&
			successor.root_decision_hash === authority.semantic_decision_hash && successor.parent_lineage_hash === null;
	}
	return successor.root_delegation_id === parentLineage.root_delegation_id &&
		successor.root_decision_hash === parentLineage.root_decision_hash &&
		successor.parent_lineage_hash === parentLineage.lineage_hash;
}

export type ClassifyExactRepairSuccessorResultV1 =
	| {
		readonly ok: true;
		readonly committed_proof_content_hash: string | null;
		readonly disposition: ExactRepairExistingSuccessorV1["disposition"];
	}
	| { readonly ok: false; readonly code: "AUTHORITY_INVALID" | "STORAGE_FAILURE" };

/** Strict machine disposition shared by command replay and runtime chaining. */
export async function classifyExactRepairSuccessorV1(
	projectRoot: string,
	candidate: DelegationTransactionRecord,
): Promise<ClassifyExactRepairSuccessorResultV1> {
	if (candidate.committed_proof !== null) {
		const committed = await readDelegationCommittedGenerationV2(projectRoot, candidate.delegation_id);
		if (!committed.ok || canonicalHash(committed.value.state) !== canonicalHash(candidate)) {
			return { ok: false, code: committed.ok || committed.error.code !== "storage_failure" ? "AUTHORITY_INVALID" : "STORAGE_FAILURE" };
		}
		let disposition: ExactRepairExistingSuccessorV1["disposition"];
		if (candidate.status === "PENDING_REVIEW") {
			const review = await readDelegationReviewV2(projectRoot, candidate.delegation_id);
			if (!review.ok) {
				if (review.error.code === "not_found") disposition = "REVIEW_PENDING";
				else return { ok: false, code: review.error.code === "storage_failure" ? "STORAGE_FAILURE" : "AUTHORITY_INVALID" };
			} else {
				disposition = hasDelegationSemanticRepairAuthorityV2(review.value) ? "REPAIR_PENDING" : "REVIEW_PENDING";
			}
		} else if (candidate.status === "REVIEWED") {
			const review = await readDelegationReviewV2(projectRoot, candidate.delegation_id);
			if (!review.ok) return { ok: false, code: review.error.code === "storage_failure" ? "STORAGE_FAILURE" : "AUTHORITY_INVALID" };
			disposition = review.value.finalized && hasDelegationSemanticReviewAuthorityV2(review.value)
				? "CHAIN_CLOSED" : "BLOCKED";
		} else if (candidate.status === "INTERRUPTED") {
			const negative = await readDelegationTerminalNegativeSolAuthorityV1(projectRoot, candidate.delegation_id);
			if (negative.ok) disposition = "REPAIR_PENDING";
			else if (negative.error.code === "not_found") disposition = "REVIEW_PENDING";
			else return { ok: false, code: negative.error.code === "storage_failure" ? "STORAGE_FAILURE" : "AUTHORITY_INVALID" };
		} else if ((candidate.status === "FAILED" || candidate.status === "RECOVERY_REQUIRED") &&
			recoverExactRepairCommandAuthorityV1({ repairOf: candidate.delegation_id, committed: committed.value }).ok) {
			disposition = "EXACT_REPAIR_PENDING";
		} else {
			disposition = "BLOCKED";
		}
		return { ok: true, committed_proof_content_hash: committed.value.proof.content_hash, disposition };
	}
	if (["PREPARED", "RUNNING", "COMMITTING"].includes(candidate.status)) {
		return { ok: true, committed_proof_content_hash: null, disposition: "ACTIVE" };
	}
	const retryable = await readStrictRetryableRawRepairEvidenceV1(projectRoot, candidate);
	if (!retryable.ok && retryable.code === "STORAGE_FAILURE") return { ok: false, code: "STORAGE_FAILURE" };
	if (!retryable.ok && retryable.code === "AUTHORITY_CHANGED") return { ok: false, code: "AUTHORITY_INVALID" };
	return {
		ok: true,
		committed_proof_content_hash: null,
		disposition: retryable.ok ? "EXACT_REPAIR_PENDING" : "BLOCKED",
	};
}

async function hasV2Layout(root: string, delegationId: string): Promise<"absent" | "present" | "invalid"> {
	try {
		const stat = await lstat(join(root, delegationId, "v2"));
		return stat.isDirectory() && !stat.isSymbolicLink() ? "present" : "invalid";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid";
	}
}

async function scanExactRepairSuccessorV1(input: {
	readonly projectRoot: string;
	readonly parent: DelegationTransactionRecord;
	readonly arguments: ExactRepairToolArgumentsV1;
	readonly successorLineage: NonNullable<DelegationTransactionRecord["repair_lineage"]>;
	readonly readRepairClosure?: typeof readProjectDelegationRepairClosureV1;
}): Promise<ReadExactRepairSuccessorResultV1> {
	const expected = normalizeDelegationBoundedTaskContractV2(input.arguments);
	if (!expected.ok || expected.value.task_kind !== "implementation" ||
		expected.value.repair_of !== input.parent.delegation_id) return { ok: false, code: "AUTHORITY_INVALID" };
	const closure = await (input.readRepairClosure ?? readProjectDelegationRepairClosureV1)(input.projectRoot);
	if (!closure.ok && !isDelegationPathLaneBypassableProjectIssueV1(closure.issue.code)) {
		return { ok: false, code: "AUTHORITY_INVALID", ...(closure.issue.delegationId === undefined ? {} : { delegation_id: closure.issue.delegationId }) };
	}
	const root = delegationsDir(input.projectRoot);
	let entries: Dirent<string>[];
	try {
		const stat = await lstat(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, code: "AUTHORITY_INVALID" };
		entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { ok: true, kind: "none" }
			: { ok: false, code: "STORAGE_FAILURE" };
	}
	const matches: ExactRepairExistingSuccessorV1[] = [];
	for (const entry of entries) {
		if (!isValidDelegationId(entry.name)) continue;
		if (!entry.isDirectory() || entry.isSymbolicLink()) return { ok: false, code: "AUTHORITY_INVALID", delegation_id: entry.name };
		const read = await readDelegationTransactionV2(input.projectRoot, entry.name);
		if (!read.ok) {
			if (read.error.code !== "not_found") {
				return { ok: false, code: read.error.code === "storage_failure" ? "STORAGE_FAILURE" : "AUTHORITY_INVALID", delegation_id: entry.name };
			}
			const layout = await hasV2Layout(root, entry.name);
			if (layout !== "absent") return { ok: false, code: "AUTHORITY_INVALID", delegation_id: entry.name };
			continue;
		}
		const candidate = read.value;
		if (candidate.delegation_id !== entry.name) return { ok: false, code: "AUTHORITY_INVALID", delegation_id: entry.name };
		if (candidate.repair_lineage?.repair_of !== input.parent.delegation_id) continue;
		if (candidate.task_kind !== "implementation" || candidate.contract_hash !== expected.value.contract_hash ||
			!sameStrings(candidate.allowed_paths, expected.value.allowed_paths) ||
			canonicalHash(candidate.repair_lineage) !== canonicalHash(input.successorLineage)) {
			return { ok: false, code: "IDEMPOTENCY_CONFLICT", delegation_id: candidate.delegation_id };
		}
		const classified = await classifyExactRepairSuccessorV1(input.projectRoot, candidate);
		if (!classified.ok) return { ok: false, code: classified.code, delegation_id: candidate.delegation_id };
		matches.push({
			delegation_id: candidate.delegation_id,
			status: candidate.status,
			contract_hash: candidate.contract_hash,
			transaction_hash: canonicalHash(candidate),
			committed_proof_content_hash: classified.committed_proof_content_hash,
			disposition: classified.disposition,
		});
	}
	if (matches.length === 0) return { ok: true, kind: "none" };
	if (matches.length !== 1) return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
	return { ok: true, kind: "existing", value: Object.freeze(matches[0]!) };
}

/** Replay scan that deliberately needs no live binding or fresh admission. */
export async function readRawLineageExactRepairSuccessorV1(input: {
	readonly projectRoot: string;
	readonly immutable: RawLineageImmutableRepairV1;
	readonly readRepairClosure?: typeof readProjectDelegationRepairClosureV1;
}): Promise<ReadExactRepairSuccessorResultV1> {
	return scanExactRepairSuccessorV1({
		projectRoot: input.projectRoot,
		parent: input.immutable.parent,
		arguments: input.immutable.arguments,
		successorLineage: input.immutable.successor_lineage,
		...(input.readRepairClosure === undefined ? {} : { readRepairClosure: input.readRepairClosure }),
	});
}

/**
 * Treat the strict successor transaction itself as the replay receipt. The
 * scan is read-only and global-fail-closed: a hidden/corrupt v2 authority can
 * never be skipped in favour of starting another worker.
 */
export async function readExactRepairSuccessorV1(input: {
	readonly projectRoot: string;
	readonly parent: ExactRepairSuccessorParentV1;
	readonly authority: ExactRepairCommandAuthorityV1;
	/** Bounded test seam; production defaults to the strict all-lineage project closure. */
	readonly readRepairClosure?: typeof readProjectDelegationRepairClosureV1;
}): Promise<ReadExactRepairSuccessorResultV1> {
	const parentState = "state" in input.parent ? input.parent.state : input.parent;
	const parentProof = "state" in input.parent ? input.parent.proof : undefined;
	const expected = normalizeDelegationBoundedTaskContractV2(input.authority.arguments);
	if (!expected.ok || expected.value.task_kind !== "implementation" ||
		expected.value.repair_of !== parentState.delegation_id ||
		input.authority.repair_of !== parentState.delegation_id ||
		(input.authority.authority_kind === "raw-lineage-retry"
			? parentProof !== undefined || parentState.committed_proof !== null
			: parentProof === undefined || input.authority.committed_proof_content_hash !== parentProof.content_hash ||
				parentState.committed_proof?.content_hash !== parentProof.content_hash) ||
		!sameStrings(input.authority.arguments.allowed_paths, parentState.allowed_paths) ||
		!authorityMatchesParent(parentState, input.authority)) {
		return { ok: false, code: "AUTHORITY_INVALID" };
	}
	return scanExactRepairSuccessorV1({
		projectRoot: input.projectRoot,
		parent: parentState,
		arguments: input.authority.arguments,
		successorLineage: input.authority.successor_lineage,
		...(input.readRepairClosure === undefined ? {} : { readRepairClosure: input.readRepairClosure }),
	});
}
