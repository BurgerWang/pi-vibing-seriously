/**
 * Strict durable authority discovery for one bounded automatic continuation.
 *
 * Event locators are an unordered, bounded set of delegation ids. They are
 * never authority and are deliberately absent from the returned authority
 * hash. Every candidate is rebuilt from the transaction, committed proof,
 * immutable Sol sidecar (when present), project repair closure, and a complete
 * project path-lane admission. This module reads no session mirror or live Git
 * state and performs no mutation.
 */

import { isAbsolute, resolve } from "node:path";

import { canonicalHash } from "../cache/canonical-hash.ts";
import {
	AUTOMATIC_DELIVERY_CONTINUATION_MAX_TOOL_LOCATORS_V1,
	type AutomaticDeliveryContinuationResolveInputV1,
	type AutomaticDeliveryContinuationCandidateResolutionV1,
	type AutomaticDeliveryContinuationCandidateV1,
} from "./automatic-delivery-continuation-lifecycle.ts";
import {
	isDelegationPathLaneBypassableProjectIssueV1,
	admitProjectDelegationPathLaneV1,
	DELEGATION_PATH_LANE_ADMISSION_KIND_V1,
	type DelegationPathLaneAdmissionInputV1,
	type DelegationPathLaneAdmissionV1,
} from "./delegation-path-lane-admission.ts";
import {
	readProjectDelegationRepairClosureV1,
	type ProjectDelegationRepairClosureV1,
} from "./delegation-project-authority.ts";
import {
	recoverExactRepairCommandAuthorityV1,
	type ExactRepairCommandAuthorityV1,
} from "./exact-repair-authority.ts";
import {
	hasDelegationSemanticRepairAuthorityV2,
	isDelegationTerminalNegativeReviewEligibleFromCommittedV1,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTerminalNegativeSolAuthorityV1,
	readDelegationTransactionV2,
	type DelegationCommittedGenerationV2,
	type DelegationReviewAuthorityV2,
	type DelegationTerminalNegativeSolAuthorityV1,
} from "./delegation-transaction-storage.ts";
import {
	DELEGATION_TRANSACTION_ID_RE,
	parseDelegationTransaction,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";

/** One source of truth with the lifecycle's bounded per-agent event set. */
export const AUTOMATIC_DELIVERY_CONTINUATION_MAX_LOCATOR_IDS_V1 =
	AUTOMATIC_DELIVERY_CONTINUATION_MAX_TOOL_LOCATORS_V1;
export const AUTOMATIC_DELIVERY_CONTINUATION_METADATA_LANE_V1 =
	".pi/workbench/delegations/**" as const;

const SHA256_RE = /^[a-f0-9]{64}$/u;

/** Exact lifecycle resolver input; locator ids remain selectors, never facts. */
export type AutomaticDeliveryContinuationAuthorityResolveInputV1 =
	AutomaticDeliveryContinuationResolveInputV1;

export interface AutomaticDeliveryContinuationAuthorityReadersV1 {
	readonly readTransaction: typeof readDelegationTransactionV2;
	readonly readCommittedGeneration: typeof readDelegationCommittedGenerationV2;
	readonly readReview: typeof readDelegationReviewV2;
	readonly readTerminalNegativeRepair: typeof readDelegationTerminalNegativeSolAuthorityV1;
	readonly readProjectRepairClosure: typeof readProjectDelegationRepairClosureV1;
	readonly admitPathLane: (
		input: DelegationPathLaneAdmissionInputV1,
	) => Promise<DelegationPathLaneAdmissionV1>;
	readonly recoverExactRepairAuthority: typeof recoverExactRepairCommandAuthorityV1;
	readonly hasSemanticRepairAuthority: typeof hasDelegationSemanticRepairAuthorityV2;
}

export interface AutomaticDeliveryContinuationAuthorityRevalidationInputV1 {
	readonly candidate: Readonly<AutomaticDeliveryContinuationCandidateV1>;
}

export interface AutomaticDeliveryContinuationAuthorityRevalidationV1 {
	readonly schema_version: 1;
	readonly expected_authority_hash: string;
	readonly observed_authority_hash: string | null;
	readonly unchanged: boolean;
	readonly resolution: AutomaticDeliveryContinuationCandidateResolutionV1;
}

const DEFAULT_READERS: AutomaticDeliveryContinuationAuthorityReadersV1 = {
	readTransaction: readDelegationTransactionV2,
	readCommittedGeneration: readDelegationCommittedGenerationV2,
	readReview: readDelegationReviewV2,
	readTerminalNegativeRepair: readDelegationTerminalNegativeSolAuthorityV1,
	readProjectRepairClosure: readProjectDelegationRepairClosureV1,
	admitPathLane: async (input) => admitProjectDelegationPathLaneV1(input),
	recoverExactRepairAuthority: recoverExactRepairCommandAuthorityV1,
	hasSemanticRepairAuthority: hasDelegationSemanticRepairAuthorityV2,
};

type CandidateDescriptorV1 =
	| {
		readonly kind: "semantic-repair";
		readonly transaction: DelegationTransactionRecord;
		readonly review: DelegationReviewAuthorityV2;
	}
	| {
		readonly kind: "terminal-negative-repair";
		readonly transaction: DelegationTransactionRecord;
		readonly terminal: DelegationTerminalNegativeSolAuthorityV1;
	}
	| {
		readonly kind: "terminal-needs-review";
		readonly transaction: DelegationTransactionRecord & { status: "FAILED" | "INTERRUPTED" };
	};

type DescriptorReadV1 =
	| { readonly status: "DESCRIPTOR"; readonly descriptor: CandidateDescriptorV1 }
	| { readonly status: "NONE"; readonly missing_sidecar: boolean }
	| { readonly status: "NOOP_NOT_FOUND" }
	| { readonly status: "DEFER"; readonly code: string }
	| { readonly status: "BLOCKED"; readonly code: string };

type CandidateBuildV1 =
	| { readonly status: "CANDIDATE"; readonly candidate: AutomaticDeliveryContinuationCandidateV1 }
	| { readonly status: "DEFER"; readonly code: string }
	| { readonly status: "BLOCKED"; readonly code: string };

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalRoot(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
		value === value.trim() && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}

function normalizeLocatorIds(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > AUTOMATIC_DELIVERY_CONTINUATION_MAX_LOCATOR_IDS_V1 ||
		!value.every((id) => typeof id === "string" && DELEGATION_TRANSACTION_ID_RE.test(id))) return undefined;
	return [...new Set(value as string[])].sort(byteCompare);
}

function validInput(input: AutomaticDeliveryContinuationAuthorityResolveInputV1): boolean {
	return canonicalRoot(input.project_root) &&
		(input.trigger === "agent_settled" || input.trigger === "before_agent_start") &&
		input.require_unique_unresolved_tip === true && input.require_strict_repair_sidecar === true &&
		input.require_full_path_admission === true && typeof input.allow_exact_terminal_needs_review === "boolean";
}

function strictTransaction(value: unknown): DelegationTransactionRecord | undefined {
	try {
		const parsed = parseDelegationTransaction(value);
		return parsed.ok ? parsed.state : undefined;
	} catch {
		return undefined;
	}
}

function validAdmission(value: DelegationPathLaneAdmissionV1): boolean {
	return value.schema_version === 1 && value.kind === DELEGATION_PATH_LANE_ADMISSION_KIND_V1 &&
		SHA256_RE.test(value.authority_hash) && Array.isArray(value.ordinary_blocker_ids) &&
		Array.isArray(value.repair_tip_ids) && Array.isArray(value.blockers) &&
		(value.repair_tip_exclusion_id === null ||
			typeof value.repair_tip_exclusion_id === "string") &&
		(value.decision.decision === "ALLOW" || value.decision.decision === "BLOCK") &&
		Array.isArray(value.decision.authority_failures) && Array.isArray(value.decision.block_reasons);
}

function admissionHasInvalidAuthority(value: DelegationPathLaneAdmissionV1): boolean {
	return value.decision.authority_failures.length > 0 ||
		value.decision.block_reasons.includes("INVALID_AUTHORITY") ||
		value.decision.block_reasons.includes("UNKNOWN_AUTHORITY");
}

function storageFailure(code: string): boolean {
	return code === "storage_failure";
}

function readFailure(code: string, invalidCode: string): DescriptorReadV1 {
	return storageFailure(code)
		? { status: "DEFER", code: "AUTHORITY_STORAGE_UNAVAILABLE" }
		: { status: "BLOCKED", code: invalidCode };
}

function projectClosureAllowed(closure: ProjectDelegationRepairClosureV1): boolean {
	return closure.ok || isDelegationPathLaneBypassableProjectIssueV1(closure.issue.code);
}

function committedGenerationBinds(
	transaction: DelegationTransactionRecord,
	committed: DelegationCommittedGenerationV2,
): boolean {
	return canonicalHash(committed.state) === canonicalHash(transaction) &&
		transaction.committed_proof !== null &&
		canonicalHash(committed.proof) === canonicalHash(transaction.committed_proof) &&
		committed.proof.content_hash === transaction.committed_proof.content_hash &&
		SHA256_RE.test(committed.proof.content_hash);
}

function committedAfterDiffHash(committed: DelegationCommittedGenerationV2): string | undefined {
	const after = committed.records["after.json"];
	if (typeof after !== "object" || after === null || Array.isArray(after)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(after, "diff_hash");
	return descriptor?.enumerable === true && "value" in descriptor &&
		typeof descriptor.value === "string" && SHA256_RE.test(descriptor.value)
		? descriptor.value
		: undefined;
}

function exactRepairAuthorityBinds(input: {
	readonly descriptor: Extract<CandidateDescriptorV1, { kind: "semantic-repair" | "terminal-negative-repair" }>;
	readonly committed: DelegationCommittedGenerationV2;
	readonly authority: ExactRepairCommandAuthorityV1;
}): boolean {
	const { descriptor, committed, authority } = input;
	const state = descriptor.transaction;
	const expectedKind = descriptor.kind === "semantic-repair" ? "semantic-repair" : "terminal-negative-repair";
	return authority.authority_kind === expectedKind && authority.repair_of === state.delegation_id &&
		authority.arguments.repair_of === state.delegation_id &&
		authority.committed_proof_content_hash === committed.proof.content_hash &&
		sameStrings(authority.arguments.allowed_paths, state.allowed_paths) &&
		authority.successor_lineage.depth === 1 &&
		authority.successor_lineage.root_delegation_id === state.delegation_id &&
		authority.successor_lineage.repair_of === state.delegation_id &&
		authority.successor_lineage.parent_lineage_hash === null &&
		SHA256_RE.test(authority.successor_lineage.lineage_hash) &&
		SHA256_RE.test(authority.idempotency_key);
}

async function readDescriptor(
	projectRoot: string,
	delegationId: string,
	metadataAdmission: DelegationPathLaneAdmissionV1,
	allowNeedsReview: boolean,
	readers: AutomaticDeliveryContinuationAuthorityReadersV1,
): Promise<DescriptorReadV1> {
	const transactionRead = await readers.readTransaction(projectRoot, delegationId);
	if (!transactionRead.ok) {
		if (transactionRead.error.code === "not_found") return { status: "NOOP_NOT_FOUND" };
		return readFailure(transactionRead.error.code, "TRANSACTION_AUTHORITY_INVALID");
	}
	const transaction = strictTransaction(transactionRead.value);
	if (transaction === undefined || transaction.delegation_id !== delegationId) {
		return { status: "BLOCKED", code: "TRANSACTION_AUTHORITY_INVALID" };
	}
	// Automatic continuation is intentionally one successor deep. Closed
	// transactions and every already-lineaged transaction are locator noise.
	if (transaction.repair_lineage !== undefined ||
		transaction.status === "REVIEWED" || transaction.status === "FINISHED" ||
		transaction.status === "ABORTED") return { status: "NONE", missing_sidecar: false };
	const ordinaryBlocker = metadataAdmission.ordinary_blocker_ids.includes(delegationId);
	const repairTip = metadataAdmission.repair_tip_ids.includes(delegationId);
	// Event locators are selectors, never authority. A depth-zero transaction
	// that no longer appears in either project-authoritative live set has been
	// superseded or durably closed; do not let its stale/corrupt historical
	// sidecar re-block the current project after closure has converged.
	if (!ordinaryBlocker && !repairTip) return { status: "NONE", missing_sidecar: false };

	if (transaction.status === "PENDING_REVIEW") {
		const review = await readers.readReview(projectRoot, delegationId);
		if (!review.ok) {
			return review.error.code === "not_found"
				? { status: "NONE", missing_sidecar: true }
				: readFailure(review.error.code, "SEMANTIC_REPAIR_SIDECAR_INVALID");
		}
		if (canonicalHash(review.value.state) !== canonicalHash(transaction)) {
			return { status: "BLOCKED", code: "SEMANTIC_REPAIR_SIDECAR_INVALID" };
		}
		if (!readers.hasSemanticRepairAuthority(review.value)) {
			return { status: "NONE", missing_sidecar: true };
		}
		if (!repairTip) {
			return { status: "BLOCKED", code: "PROJECT_AUTHORITY_CHANGED" };
		}
		return { status: "DESCRIPTOR", descriptor: { kind: "semantic-repair", transaction, review: review.value } };
	}

	if (transaction.status !== "FAILED" && transaction.status !== "INTERRUPTED") {
		return { status: "NONE", missing_sidecar: false };
	}
	const terminalCommitted = await readers.readCommittedGeneration(projectRoot, delegationId);
	if (!terminalCommitted.ok) {
		return readFailure(terminalCommitted.error.code, "TRANSACTION_AUTHORITY_INVALID");
	}
	if (canonicalHash(terminalCommitted.value.state) !== canonicalHash(transaction)) {
		return { status: "BLOCKED", code: "TRANSACTION_AUTHORITY_INVALID" };
	}
	if (!isDelegationTerminalNegativeReviewEligibleFromCommittedV1(
		transaction,
		terminalCommitted.value.records,
	)) {
		// RECOVERY_REQUIRED/proof-null and incomplete/zero-delta terminal shapes
		// can remain path blockers, but they never become continuation authority.
		return { status: "NONE", missing_sidecar: false };
	}
	const terminal = await readers.readTerminalNegativeRepair(projectRoot, delegationId);
	if (!terminal.ok) {
		if (terminal.error.code !== "not_found") {
			return readFailure(terminal.error.code, "TERMINAL_REPAIR_SIDECAR_INVALID");
		}
		if (!allowNeedsReview) return { status: "NONE", missing_sidecar: true };
		if (!ordinaryBlocker) {
			return { status: "BLOCKED", code: "PROJECT_AUTHORITY_CHANGED" };
		}
		return { status: "DESCRIPTOR", descriptor: { kind: "terminal-needs-review", transaction } };
	}
	if (canonicalHash(terminal.value.state) !== canonicalHash(transaction) || !repairTip) {
		return { status: "BLOCKED", code: "TERMINAL_REPAIR_SIDECAR_INVALID" };
	}
	return {
		status: "DESCRIPTOR",
		descriptor: { kind: "terminal-negative-repair", transaction, terminal: terminal.value },
	};
}

async function buildCandidate(
	projectRoot: string,
	descriptor: CandidateDescriptorV1,
	closure: ProjectDelegationRepairClosureV1,
	metadataAdmission: DelegationPathLaneAdmissionV1,
	readers: AutomaticDeliveryContinuationAuthorityReadersV1,
): Promise<CandidateBuildV1> {
	const state = descriptor.transaction;
	const committedRead = await readers.readCommittedGeneration(projectRoot, state.delegation_id);
	if (!committedRead.ok) {
		return storageFailure(committedRead.error.code)
			? { status: "DEFER", code: "COMMITTED_AUTHORITY_UNAVAILABLE" }
			: { status: "BLOCKED", code: "COMMITTED_PROOF_REQUIRED" };
	}
	const committed = committedRead.value;
	if (!committedGenerationBinds(state, committed) || state.repair_lineage !== undefined) {
		return { status: "BLOCKED", code: "COMMITTED_AUTHORITY_CHANGED" };
	}

	if (descriptor.kind === "terminal-needs-review") {
		const terminalState = descriptor.transaction;
		const boundDiffHash = committedAfterDiffHash(committed);
		if (boundDiffHash === undefined || metadataAdmission.decision.decision !== "ALLOW" ||
			metadataAdmission.repair_tip_exclusion_id !== null ||
			!metadataAdmission.ordinary_blocker_ids.includes(terminalState.delegation_id) ||
			admissionHasInvalidAuthority(metadataAdmission)) {
			return { status: "BLOCKED", code: "METADATA_PATH_ADMISSION_BLOCKED" };
		}
		const authorityHash = canonicalHash({
			schema_version: 1,
			kind: "automatic-delivery-continuation-authority-v1",
			project_root: projectRoot,
			delegation_id: state.delegation_id,
			transaction_hash: canonicalHash(state),
			committed_proof_hash: canonicalHash(committed.proof),
			committed_proof_content_hash: committed.proof.content_hash,
			decision_hash: null,
			durable_decision: "NEEDS_REVIEW",
			bound_diff_hash: boundDiffHash,
			review_authority: "ELIGIBLE_TERMINAL_NEEDS_REVIEW",
			terminal_status: terminalState.status,
			project_repair_closure_hash: canonicalHash(closure),
			path_lane_allowed_paths: [AUTOMATIC_DELIVERY_CONTINUATION_METADATA_LANE_V1],
			path_admission_authority_hash: metadataAdmission.authority_hash,
			path_admission_hash: canonicalHash(metadataAdmission),
		});
		return {
			status: "CANDIDATE",
			candidate: Object.freeze({
				schema_version: 1,
				project_root: projectRoot,
				delegation_id: state.delegation_id,
				authority_hash: authorityHash,
				bound_diff_hash: boundDiffHash,
				lineage_depth: 0,
				review_authority: "ELIGIBLE_TERMINAL_NEEDS_REVIEW",
				sidecar_kind: "none",
				durable_decision: "NEEDS_REVIEW",
				strict_sidecar: false,
				terminal_status: terminalState.status,
				unique_unresolved_tip: true,
				path_admission: "ALLOW",
				path_admission_authority_hash: metadataAdmission.authority_hash,
			}),
		};
	}

	const terminal = descriptor.kind === "terminal-negative-repair" ? descriptor.terminal : undefined;
	const recovered = readers.recoverExactRepairAuthority({
		repairOf: state.delegation_id,
		committed,
		...(descriptor.kind === "semantic-repair" ? { review: descriptor.review } : {}),
		...(terminal === undefined
			? {}
			: { terminalNegativeRepair: terminal, currentBindingHash: terminal.bound_diff_hash }),
	});
	if (!recovered.ok || !exactRepairAuthorityBinds({ descriptor, committed, authority: recovered.value })) {
		return { status: "BLOCKED", code: "EXACT_REPAIR_AUTHORITY_INVALID" };
	}
	const authority = recovered.value;
	const boundDiffHash = descriptor.kind === "semantic-repair"
		? descriptor.review.review.bound_diff_hash
		: descriptor.terminal.bound_diff_hash;
	const decisionHash = descriptor.kind === "semantic-repair"
		? descriptor.review.semantic_repair?.decision_hash
		: descriptor.terminal.decision.decision_hash;
	if (decisionHash === undefined || !SHA256_RE.test(decisionHash) || !SHA256_RE.test(boundDiffHash)) {
		return { status: "BLOCKED", code: "REPAIR_DECISION_INVALID" };
	}
	const pathAdmission = await readers.admitPathLane({
		project_root: projectRoot,
		allowed_paths: authority.arguments.allowed_paths,
		repair_tip_exclusion_id: state.delegation_id,
	});
	if (!validAdmission(pathAdmission) || pathAdmission.decision.decision !== "ALLOW" ||
		admissionHasInvalidAuthority(pathAdmission) ||
		pathAdmission.repair_tip_exclusion_id !== state.delegation_id ||
		!pathAdmission.repair_tip_ids.includes(state.delegation_id)) {
		return { status: "BLOCKED", code: "REPAIR_PATH_ADMISSION_BLOCKED" };
	}
	const authorityHash = canonicalHash({
		schema_version: 1,
		kind: "automatic-delivery-continuation-authority-v1",
		project_root: projectRoot,
		delegation_id: state.delegation_id,
		transaction_hash: canonicalHash(state),
		committed_proof_hash: canonicalHash(committed.proof),
		committed_proof_content_hash: committed.proof.content_hash,
		decision_hash: decisionHash,
		durable_decision: "REPAIR",
		bound_diff_hash: boundDiffHash,
		review_authority: "DURABLE_REPAIR_SIDECAR",
		sidecar_kind: descriptor.kind,
		exact_repair_authority_hash: canonicalHash(authority),
		project_repair_closure_hash: canonicalHash(closure),
		path_lane_allowed_paths: authority.arguments.allowed_paths,
		path_admission_authority_hash: pathAdmission.authority_hash,
		path_admission_hash: canonicalHash(pathAdmission),
	});
	return {
		status: "CANDIDATE",
		candidate: Object.freeze({
			schema_version: 1,
			project_root: projectRoot,
			delegation_id: state.delegation_id,
			authority_hash: authorityHash,
			bound_diff_hash: boundDiffHash,
			lineage_depth: 0,
			review_authority: "DURABLE_REPAIR_SIDECAR",
			sidecar_kind: descriptor.kind,
			durable_decision: "REPAIR",
			strict_sidecar: true,
			terminal_status: null,
			unique_unresolved_tip: true,
			path_admission: "ALLOW",
			path_admission_authority_hash: pathAdmission.authority_hash,
		}),
	};
}

/**
 * Resolve at most one strict depth-zero candidate. Nonempty locator sets never
 * fall back to another project transaction; an empty set performs the bounded
 * reload scan and accepts only one durable sidecar root.
 */
export async function resolveAutomaticDeliveryContinuationCandidateV1(
	input: AutomaticDeliveryContinuationAuthorityResolveInputV1,
	readers: AutomaticDeliveryContinuationAuthorityReadersV1 = DEFAULT_READERS,
): Promise<AutomaticDeliveryContinuationCandidateResolutionV1> {
	let locatorIds: string[] | undefined;
	try {
		if (!validInput(input)) return { status: "BLOCKED", code: "INVALID_RESOLVE_INPUT" };
		locatorIds = normalizeLocatorIds(input.locator_delegation_ids);
	} catch {
		return { status: "BLOCKED", code: "INVALID_RESOLVE_INPUT" };
	}
	if (locatorIds === undefined) return { status: "BLOCKED", code: "INVALID_LOCATOR_SET" };
	if (locatorIds.length === 0 && input.trigger !== "before_agent_start") {
		return { status: "NOOP", code: "NO_CANDIDATE" };
	}
	try {
		const closure = await readers.readProjectRepairClosure(input.project_root);
		const metadataAdmission = await readers.admitPathLane({
			project_root: input.project_root,
			allowed_paths: [AUTOMATIC_DELIVERY_CONTINUATION_METADATA_LANE_V1],
		});
		if (!validAdmission(metadataAdmission)) {
			return { status: "BLOCKED", code: "PATH_ADMISSION_INVALID" };
		}
		if (admissionHasInvalidAuthority(metadataAdmission)) {
			return { status: "BLOCKED", code: "PROJECT_PATH_AUTHORITY_INVALID" };
		}
		if (!projectClosureAllowed(closure)) {
			return closure.ok === false && storageFailure(closure.issue.code)
				? { status: "DEFER", code: "PROJECT_AUTHORITY_UNAVAILABLE" }
				: { status: "BLOCKED", code: "PROJECT_AUTHORITY_INVALID" };
		}

		const scanIds = locatorIds.length > 0 ? locatorIds : [...metadataAdmission.repair_tip_ids].sort(byteCompare);
		const descriptors: CandidateDescriptorV1[] = [];
		let missingSidecar = false;
		for (const delegationId of scanIds) {
			const descriptorRead = await readDescriptor(
				input.project_root,
				delegationId,
				metadataAdmission,
				input.trigger === "agent_settled" && input.allow_exact_terminal_needs_review && locatorIds.length > 0,
				readers,
			);
			if (descriptorRead.status === "DEFER" || descriptorRead.status === "BLOCKED") return descriptorRead;
			if (descriptorRead.status === "NONE") missingSidecar ||= descriptorRead.missing_sidecar;
			if (descriptorRead.status === "DESCRIPTOR") descriptors.push(descriptorRead.descriptor);
		}

		const candidates: AutomaticDeliveryContinuationCandidateV1[] = [];
		for (const descriptor of descriptors) {
			const built = await buildCandidate(input.project_root, descriptor, closure, metadataAdmission, readers);
			if (built.status === "DEFER" || built.status === "BLOCKED") return built;
			candidates.push(built.candidate);
		}
		if (candidates.length > 1) return { status: "BLOCKED", code: "AMBIGUOUS_CANDIDATES" };
		if (candidates.length === 1) return { status: "CANDIDATE", candidate: candidates[0]! };
		if (input.trigger === "before_agent_start" &&
			(missingSidecar || metadataAdmission.ordinary_blocker_ids.length > 0)) {
			return { status: "NOOP", code: "NO_DURABLE_REPAIR_SIDECAR" };
		}
		return { status: "NOOP", code: missingSidecar ? "NO_DURABLE_REPAIR_SIDECAR" : "NO_CANDIDATE" };
	} catch {
		return { status: "DEFER", code: "AUTHORITY_READ_FAILED" };
	}
}

/**
 * Rebuild a previously selected candidate immediately before execution. This
 * seam proves only immutable authority stability; the composition root must
 * separately prove that no checkout writer lane is active before producing
 * lifecycle `no_active_lane: true` authority.
 */
export async function revalidateAutomaticDeliveryContinuationCandidateV1(
	input: AutomaticDeliveryContinuationAuthorityRevalidationInputV1,
	readers: AutomaticDeliveryContinuationAuthorityReadersV1 = DEFAULT_READERS,
): Promise<AutomaticDeliveryContinuationAuthorityRevalidationV1> {
	const expected = input.candidate;
	const resolution = await resolveAutomaticDeliveryContinuationCandidateV1({
		project_root: expected.project_root,
		trigger: "agent_settled",
		locator_delegation_ids: [expected.delegation_id],
		require_unique_unresolved_tip: true,
		require_strict_repair_sidecar: true,
		require_full_path_admission: true,
		allow_exact_terminal_needs_review: expected.review_authority === "ELIGIBLE_TERMINAL_NEEDS_REVIEW",
	}, readers);
	const observed = resolution.status === "CANDIDATE" ? resolution.candidate : undefined;
	const unchanged = observed !== undefined && observed.delegation_id === expected.delegation_id &&
		observed.authority_hash === expected.authority_hash &&
		observed.bound_diff_hash === expected.bound_diff_hash &&
		observed.review_authority === expected.review_authority &&
		observed.sidecar_kind === expected.sidecar_kind && observed.lineage_depth === 0;
	return {
		schema_version: 1,
		expected_authority_hash: expected.authority_hash,
		observed_authority_hash: observed?.authority_hash ?? null,
		unchanged,
		resolution,
	};
}
