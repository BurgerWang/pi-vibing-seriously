/**
 * Strict implementation-review adapter for delegation transactions v2.
 * Immutable generation authority is resolved before any mutable review file
 * is read or written; no v1 fallback exists in this module.
 */

import { posix } from "node:path";

import {
	collectReviewBoundDiffHash,
	renderReviewLines,
	reviewDelegationFromAuthority,
	type ReviewAuthorityFacts,
	type ReviewRecord,
	type ReviewResult,
} from "./diff-review.ts";
import { computeDiffHash, type GitFacts } from "./delegation-ledger.ts";
import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import { DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2 } from "./delegation-workspace-v2.ts";
import {
	collectReviewRelevanceV2,
	computeReviewRelevanceConflictHashV2,
	REVIEW_RELEVANCE_KIND_V2,
	validateReviewRelevanceProjectionV2,
	type CollectedReviewRelevanceV2,
	type ReviewRelevanceProjectionV2,
} from "./review-relevance-v2.ts";
import { validateWorkspaceGuard, type WorkspaceGuardRecord } from "./workspace-guard.ts";
import { bindDelegationBoundedTaskContractV2 } from "./delegation-transaction-artifacts.ts";
import {
	delegationReviewRelativePathV2,
	persistDelegationReviewProvisionalV2,
	publishDelegationReviewV2,
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	type DelegationCommittedGenerationV2,
	type DelegationReviewArtifactV2,
	type DelegationTransactionStorageOptions,
} from "./delegation-transaction-storage.ts";
import {
	DELEGATION_TRANSACTION_HASH_RE,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import type { ExecFn } from "./config.ts";
import { isWorkerPathAllowedRealpath } from "../worker/path-scope.ts";

const AFTER_FIELDS = [
	"schema_version", "delegation_id", "recorded_at", "status", "exit_code", "pinned_identity",
	"git_head", "git_dirty", "diff_hash", "changed_paths", "path_statuses", "path_digests",
	"changed_since_before", "workspace_guard", "change_set_status", "worker_delta_hash", "workspace_guard_hash",
	"change_set_hash", "reported_paths", "usage", "budget", "report_summary", "review_status",
] as const;
const AFTER_FIELDS_GUARD_V2 = [...AFTER_FIELDS, "diff_identity_kind"] as const;
const BEFORE_FIELDS = [
	"schema_version", "delegation_id", "recorded_at", "contract", "git_head", "git_dirty",
	"diff_hash", "changed_paths", "path_statuses", "path_digests", "workspace_guard",
] as const;
const BEFORE_FIELDS_GUARD_V2 = [...BEFORE_FIELDS, "diff_identity_kind"] as const;
const CONTRACT_REQUIRED_FIELDS = [
	"task_kind", "task", "allowed_paths", "acceptance_criteria", "verification", "timeout_seconds",
	"budget_profile", "contract_hash",
] as const;
const IDENTITY_FIELDS = [
	"schema_version", "delegation_id", "task_kind", "contract_hash", "generation", "revision", "worker_identity",
] as const;
const SCOPE_FIELDS = [
	"schema_version", "delegation_id", "task_kind", "contract_hash", "allowed_paths", "changed_paths",
	"write_journal", "change_set",
] as const;

export type DelegationReviewV2ErrorCode =
	| "authority_invalid"
	| "invalid_state"
	| "review_invalid"
	| "review_conflict"
	| "storage_failure";

export interface DelegationReviewV2Success {
	ok: true;
	review: ReviewResult;
	transaction: DelegationTransactionRecord;
	review_hash: string;
	review_path: string;
	finalized: boolean;
}

export interface DelegationReviewV2Failure {
	ok: false;
	error: { code: DelegationReviewV2ErrorCode; message: string };
	review?: ReviewResult;
	transaction?: DelegationTransactionRecord;
	binding_hash?: string;
}

export type DelegationReviewV2Result = DelegationReviewV2Success | DelegationReviewV2Failure;

export interface ReviewDelegationV2Input {
	projectRoot: string;
	delegationId: string;
	exec: ExecFn;
	includePaths?: readonly string[];
	maxLines?: number;
	maxBytes?: number;
	secrets?: readonly string[];
	now?: string;
	storage?: DelegationTransactionStorageOptions;
}

function fail(
	code: DelegationReviewV2ErrorCode,
	message: string,
	details?: Pick<DelegationReviewV2Failure, "review" | "transaction" | "binding_hash">,
): DelegationReviewV2Failure {
	return { ok: false, error: { code, message: message.slice(0, 240) }, ...details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], optional?: string): boolean {
	const expected = optional !== undefined && Object.prototype.hasOwnProperty.call(value, optional)
		? [...fields, optional]
		: [...fields];
	const actual = Object.keys(value).sort();
	expected.sort();
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
	try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function isCanonicalTime(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 20 || value.length > 32) return false;
	try { return new Date(value).toISOString() === value; } catch { return false; }
}

function isStrictPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 400 || value !== value.trim() ||
		value.includes("\\") || value.includes("\0") || value.startsWith("/")) return false;
	const normalized = posix.normalize(value);
	return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

function validPaths(value: unknown, max = 500): value is string[] {
	return Array.isArray(value) && value.length <= max && value.every(isStrictPath) &&
		value.every((path, index) => index === 0 || value[index - 1]! < path);
}

function validByteSortedPaths(value: unknown, max = 500): value is string[] {
	return Array.isArray(value) && value.length <= max && value.every(isStrictPath) &&
		value.every((path, index) => index === 0 || Buffer.from(value[index - 1]!, "utf8").compare(Buffer.from(path, "utf8")) < 0);
}

function validGitRecord(value: Record<string, unknown>, after: boolean): GitFacts | undefined {
	if ((value.git_head !== null && (typeof value.git_head !== "string" || !/^[a-f0-9]{40,64}$/.test(value.git_head))) ||
		typeof value.git_dirty !== "boolean" || !validPaths(value.changed_paths) ||
		!isRecord(value.path_statuses) || !isRecord(value.path_digests)) return undefined;
	const changedPaths = value.changed_paths as string[];
	if (value.git_dirty !== (changedPaths.length > 0) || !sameJson(Object.keys(value.path_statuses).sort(), changedPaths) ||
		!Object.values(value.path_statuses).every((status) => typeof status === "string" && status.length > 0 && status.length <= 4) ||
		!Object.keys(value.path_digests).every((path) => changedPaths.includes(path)) ||
		!Object.values(value.path_digests).every((digest) => typeof digest === "string" && /^[a-f0-9]{64}(?::\d+)?$/.test(digest))) return undefined;
	const facts: GitFacts = {
		gitHead: value.git_head as string | null,
		gitDirty: value.git_dirty,
		changedPaths: [...changedPaths],
		pathStatuses: { ...value.path_statuses } as Record<string, string>,
		pathDigests: { ...value.path_digests } as Record<string, string>,
	};
	const calculated = computeDiffHash(facts.changedPaths, facts.pathDigests, facts.pathStatuses);
	if (value.diff_hash !== calculated || (after && !DELEGATION_TRANSACTION_HASH_RE.test(String(value.diff_hash)))) return undefined;
	return facts;
}

function validAfterGitRecord(value: Record<string, unknown>): GitFacts | undefined {
	if (!isRecord(value.workspace_guard) || !Array.isArray(value.workspace_guard.entries)) return undefined;
	const fullPaths = value.workspace_guard.entries.map((entry) => isRecord(entry) ? entry.path : undefined);
	if (!validByteSortedPaths(fullPaths)) return undefined;
	const legacyOrderedPaths = [...fullPaths].sort();
	return validGitRecord({ ...value, changed_paths: legacyOrderedPaths }, true);
}

interface GenerationReviewAuthority {
	kind: "legacy-v2" | "guard-v2";
	authority: ReviewAuthorityFacts;
	after_guard: WorkspaceGuardRecord;
	change_set: ChangeSetRecord;
}

function authorityFromGeneration(generation: DelegationCommittedGenerationV2): GenerationReviewAuthority | undefined {
	const state = generation.state;
	if (state.task_kind !== "implementation" || state.terminal_outcome === null || state.committed_proof === null ||
		(state.status !== "PENDING_REVIEW" && state.status !== "REVIEWED")) return undefined;
	const before = generation.records["before.json"];
	const after = generation.records["after.json"];
	const identity = generation.records["identity.json"];
	const scope = generation.records["scope.json"];
	if (!isRecord(before) || !isRecord(after) ||
		!isRecord(identity) || !exactFields(identity, IDENTITY_FIELDS) || !isRecord(scope) || !exactFields(scope, SCOPE_FIELDS)) return undefined;
	const guardV2 = before.diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2 ||
		after.diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2;
	if (guardV2
		? (!exactFields(before, BEFORE_FIELDS_GUARD_V2) || !exactFields(after, AFTER_FIELDS_GUARD_V2)
			|| before.diff_identity_kind !== DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2
			|| after.diff_identity_kind !== DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2)
		: (!exactFields(before, BEFORE_FIELDS) || !exactFields(after, AFTER_FIELDS))) return undefined;
	if (before.schema_version !== 2 || before.delegation_id !== state.delegation_id || !isCanonicalTime(before.recorded_at) ||
		after.schema_version !== 2 || after.delegation_id !== state.delegation_id || !isCanonicalTime(after.recorded_at) ||
		after.review_status !== "PENDING_REVIEW" || !validByteSortedPaths(after.changed_paths) ||
		!(guardV2 ? validByteSortedPaths(after.changed_since_before) : validPaths(after.changed_since_before)) || !validPaths(after.reported_paths) ||
		!isRecord(before.workspace_guard) || !isRecord(after.workspace_guard)) return undefined;
	const contract = before.contract;
	if (!isRecord(contract) || !exactFields(contract, CONTRACT_REQUIRED_FIELDS, "repair_of") ||
		contract.task_kind !== state.task_kind || contract.contract_hash !== state.contract_hash ||
		!sameJson(contract.allowed_paths, state.allowed_paths)) return undefined;
	const { contract_hash: suppliedHash, ...contractPayload } = contract;
	const canonicalContract = bindDelegationBoundedTaskContractV2(contractPayload);
	if (!canonicalContract.ok || suppliedHash !== canonicalContract.value.contract_hash) return undefined;
	let afterFacts: GitFacts | undefined;
	if (guardV2) {
		if (!validateWorkspaceGuard(after.workspace_guard) || after.diff_hash !== (after.workspace_guard as WorkspaceGuardRecord).workspace_guard_hash
			|| !isRecord(after.path_statuses) || !isRecord(after.path_digests)
			|| !Object.entries(after.path_digests).every(([path, digest]) => (after.changed_paths as string[]).includes(path)
				&& typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest))) return undefined;
		afterFacts = {
			gitHead: after.git_head as string | null,
			gitDirty: (after.changed_paths as string[]).length > 0,
			changedPaths: [...after.changed_paths as string[]],
			pathStatuses: { ...after.path_statuses } as Record<string, string>,
			pathDigests: { ...after.path_digests } as Record<string, string>,
		};
	} else {
		const beforeFacts = validGitRecord(before, false);
		afterFacts = validAfterGitRecord(after);
		if (beforeFacts === undefined) return undefined;
	}
	if (afterFacts === undefined || !sameJson(after.changed_paths, state.terminal_outcome.changed_paths)) return undefined;
	if (identity.schema_version !== 2 || identity.delegation_id !== state.delegation_id || identity.task_kind !== state.task_kind ||
		identity.contract_hash !== state.contract_hash || identity.generation !== state.generation ||
		identity.revision !== state.committed_proof.revision || !sameJson(identity.worker_identity, state.worker_identity)) return undefined;
	if (scope.schema_version !== 2 || scope.delegation_id !== state.delegation_id || scope.task_kind !== state.task_kind ||
		scope.contract_hash !== state.contract_hash || !sameJson(scope.allowed_paths, state.allowed_paths) ||
		!sameJson(scope.changed_paths, state.terminal_outcome.changed_paths) ||
		!isRecord(scope.write_journal) || !isRecord(scope.change_set) || !validateChangeSet(scope.change_set)) return undefined;
	const changeSet = scope.change_set as ChangeSetRecord;
	if (!validateWorkspaceGuard(after.workspace_guard)) return undefined;
	const afterGuard = after.workspace_guard as unknown as WorkspaceGuardRecord;
	return {
		kind: guardV2 ? "guard-v2" : "legacy-v2",
		after_guard: afterGuard,
		change_set: changeSet,
		authority: {
			delegation_id: state.delegation_id,
			allowed_paths: [...state.allowed_paths],
			worker_paths: [...(after.changed_paths as string[])],
			recorded_after_hash: after.diff_hash as string,
			after: afterFacts,
			reported_paths: [...(after.reported_paths as string[])],
		},
	};
}

function projectionFromReview(review: ReviewRecord | null): ReviewRelevanceProjectionV2 | undefined {
	if (review === null || review.schema_version !== 2 || review.diff_identity_kind !== REVIEW_RELEVANCE_KIND_V2 ||
		!validateReviewRelevanceProjectionV2(review.relevance_projection)) return undefined;
	return review.relevance_projection;
}

function authorityWithRelevance(
	base: ReviewAuthorityFacts,
	relevance: Readonly<CollectedReviewRelevanceV2>,
): ReviewAuthorityFacts {
	const worker = new Set(relevance.worker_paths);
	const pathStatuses: Record<string, string> = {};
	const pathDigests: Record<string, string> = {};
	for (const entry of relevance.projection.entries) {
		if (!worker.has(entry.path)) continue;
		pathStatuses[entry.path] = entry.status;
		if (entry.full_identity.kind === "file") pathDigests[entry.path] = entry.full_identity.sha256;
	}
	return {
		...base,
		recorded_after_hash: relevance.binding.projection_hash,
		current: {
			gitHead: relevance.projection.git_head,
			gitDirty: relevance.worker_paths.length > 0,
			changedPaths: [...relevance.worker_paths],
			pathStatuses,
			pathDigests,
		},
		current_diff_hash: relevance.binding.projection_hash,
		drift_paths: [],
		relevance_binding: relevance.binding,
		relevance_projection: relevance.projection,
	};
}

function relevanceConflictHash(
	state: DelegationTransactionRecord,
	changeSet: ChangeSetRecord,
	error: { code: string; path?: string },
): string | undefined {
	if (!["head_conflict", "relevant_conflict", "unknown_origin", "binding_conflict"].includes(error.code)) return undefined;
	return computeReviewRelevanceConflictHashV2({
		delegation_id: state.delegation_id,
		contract_hash: state.contract_hash,
		change_set_hash: changeSet.change_set_hash,
		error_code: error.code as "head_conflict" | "relevant_conflict" | "unknown_origin" | "binding_conflict",
		...(error.path === undefined ? {} : { path: error.path }),
	});
}

async function workerScopeIsSafeBeforeContent(
	projectRoot: string,
	workerPaths: readonly string[],
	allowedPaths: readonly string[],
): Promise<boolean> {
	for (const path of workerPaths) {
		if (!(await isWorkerPathAllowedRealpath(projectRoot, path, allowedPaths))) return false;
	}
	return true;
}

function artifactFor(state: DelegationTransactionRecord, reviewedAt: string, review: ReviewRecord): DelegationReviewArtifactV2 {
	// The shared renderer intentionally uses optional `compact: undefined`
	// properties in its in-memory patch entries.  Canonical JSON omits those
	// properties; normalize the detached copy before strict storage parsing so
	// the object being validated is exactly the object whose bytes are hashed.
	const canonicalReview = JSON.parse(JSON.stringify(review)) as ReviewRecord;
	return {
		schema_version: 2,
		delegation_id: state.delegation_id,
		task_kind: "implementation",
		contract_hash: state.contract_hash,
		worker_identity: { ...state.worker_identity },
		generation: state.generation,
		transaction_revision: 3,
		reviewed_at: reviewedAt,
		review: canonicalReview,
	};
}

/** Public fail-closed v2 review boundary. */
export async function reviewDelegationV2(input: ReviewDelegationV2Input): Promise<DelegationReviewV2Result> {
	try {
		// Required ordering: immutable committed-generation authority is always
		// resolved before the mutable v2 review path is inspected.
		const generation = await readDelegationCommittedGenerationV2(input.projectRoot, input.delegationId, input.storage);
		if (!generation.ok) return fail("authority_invalid", "delegation committed-generation authority is unavailable");
		const state = generation.value.state;
		const authorityInfo = authorityFromGeneration(generation.value);
		if (authorityInfo === undefined) return fail("invalid_state", "delegation is not a strictly bound implementation review", { transaction: state });
		const reviewPath = delegationReviewRelativePathV2(state.delegation_id);
		if (reviewPath === undefined) return fail("authority_invalid", "delegation review path is invalid", { transaction: state });
		if (authorityInfo.kind === "guard-v2" && !(await workerScopeIsSafeBeforeContent(
			input.projectRoot,
			authorityInfo.authority.worker_paths,
			authorityInfo.authority.allowed_paths,
		))) {
			return fail("review_invalid", "delegation worker path fails the parent-approved realpath scope", { transaction: state });
		}

		if (state.status === "REVIEWED") {
			const existing = await readDelegationReviewV2(input.projectRoot, state.delegation_id, input.storage);
			if (!existing.ok || !existing.value.finalized) return fail("authority_invalid", "finalized review authority is unavailable", { transaction: state });
			if (authorityInfo.kind === "guard-v2") {
				const expected = projectionFromReview(existing.value.review);
				if (expected === undefined) return fail("authority_invalid", "new-v2 finalized review lacks a strict relevance projection", { transaction: state });
				const current = await collectReviewRelevanceV2({
					project_root: input.projectRoot,
					delegation_id: state.delegation_id,
					contract_hash: state.contract_hash,
					after_guard: authorityInfo.after_guard,
					change_set: authorityInfo.change_set,
					exec: input.exec,
					expected_projection: expected,
				});
				if (!current.ok) {
					return fail("review_conflict", "current relevance no longer matches the immutable finalized review", {
						transaction: state,
						...(relevanceConflictHash(state, authorityInfo.change_set, current.error) === undefined ? {} : {
							binding_hash: relevanceConflictHash(state, authorityInfo.change_set, current.error),
						}),
					});
				}
				if (current.value.binding.projection_hash !== existing.value.review.bound_diff_hash) {
					return fail("review_conflict", "current relevance no longer matches the immutable finalized review", { transaction: state });
				}
			} else {
				if (existing.value.review.schema_version !== 1) return fail("authority_invalid", "legacy-v2 review schema is invalid", { transaction: state });
				const currentHash = await collectReviewBoundDiffHash(input.projectRoot, input.exec);
				if (currentHash === null) return fail("review_invalid", "current git review facts are unavailable", { transaction: state });
				if (currentHash !== existing.value.review.bound_diff_hash) {
					return fail("review_conflict", "current diff no longer matches the immutable finalized review", { transaction: state });
				}
			}
			const review: ReviewResult = {
				ok: true,
				record: existing.value.review,
				lines: renderReviewLines(existing.value.review, { maxBytes: input.maxBytes, maxLines: input.maxLines }),
			};
			return {
				ok: true,
				review,
				transaction: existing.value.state,
				review_hash: existing.value.review_hash,
				review_path: existing.value.review_path,
				finalized: true,
			};
		}

		const priorRead = await readDelegationReviewV2(input.projectRoot, state.delegation_id, input.storage);
		let priorReview: ReviewRecord | null = null;
		if (priorRead.ok) {
			if (priorRead.value.finalized) return fail("review_conflict", "pending transaction conflicts with a finalized review", { transaction: state });
			priorReview = priorRead.value.review;
		} else if (priorRead.error.code !== "not_found") {
			return fail("authority_invalid", "existing provisional review is corrupt or unsafe", { transaction: state });
		}
		if (authorityInfo.kind === "legacy-v2") {
			// Historical experimental v2 is strict read-only. Existing schema1
			// evidence may be replayed, but this adapter never rewrites/upgrades it.
			if (priorReview === null || priorReview.schema_version !== 1) {
				return fail("authority_invalid", "legacy-v2 pending review has no replayable schema1 artifact", { transaction: state });
			}
			const currentHash = await collectReviewBoundDiffHash(input.projectRoot, input.exec);
			if (currentHash === null || currentHash !== priorReview.bound_diff_hash) {
				return fail("review_conflict", "legacy-v2 full diff no longer matches its read-only review", { transaction: state });
			}
			return {
				ok: true,
				review: { ok: true, record: priorReview, lines: renderReviewLines(priorReview, { maxBytes: input.maxBytes, maxLines: input.maxLines }) },
				transaction: state,
				review_hash: priorRead.ok ? priorRead.value.review_hash : "",
				review_path: reviewPath,
				finalized: false,
			};
		}
		const expectedProjection = priorReview === null ? undefined : projectionFromReview(priorReview);
		if (priorReview !== null && expectedProjection === undefined) {
			return fail("authority_invalid", "new-v2 provisional review lacks a strict relevance projection", { transaction: state });
		}
		const relevance = await collectReviewRelevanceV2({
			project_root: input.projectRoot,
			delegation_id: state.delegation_id,
			contract_hash: state.contract_hash,
			after_guard: authorityInfo.after_guard,
			change_set: authorityInfo.change_set,
			exec: input.exec,
			...(expectedProjection === undefined ? {} : { expected_projection: expectedProjection }),
		});
		if (!relevance.ok) {
			const bindingHash = relevanceConflictHash(state, authorityInfo.change_set, relevance.error);
			return fail("review_conflict", `delegation relevance review failed closed (${relevance.error.code})`, {
				transaction: state,
				...(bindingHash === undefined ? {} : { binding_hash: bindingHash }),
			});
		}
		const authority = authorityWithRelevance(authorityInfo.authority, relevance.value);
		const reviewedAt = input.now ?? new Date().toISOString();
		if (!isCanonicalTime(reviewedAt)) return fail("review_invalid", "review time must be canonical ISO-8601", { transaction: state });
		const review = await reviewDelegationFromAuthority({
			projectRoot: input.projectRoot,
			delegationId: state.delegation_id,
			exec: input.exec,
			includePaths: input.includePaths === undefined ? undefined : [...input.includePaths],
			maxLines: input.maxLines,
			maxBytes: input.maxBytes,
			secrets: input.secrets === undefined ? undefined : [...input.secrets],
			now: reviewedAt,
			authority,
			priorReview,
			reviewPath,
		});
		if (!review.ok || review.record === undefined) return fail("review_invalid", "delegation diff review failed closed", { review, transaction: state });
		const artifact = artifactFor(state, reviewedAt, review.record);
		const cas = {
			delegation_id: state.delegation_id,
			contract_hash: state.contract_hash,
			worker_identity: { ...state.worker_identity },
			expected_generation: state.generation,
			expected_revision: state.revision,
			now: reviewedAt,
			artifact,
		};
		const persisted = review.record.verdict === "PASS" && review.record.coverage_complete
			? await publishDelegationReviewV2(input.projectRoot, cas, input.storage)
			: await persistDelegationReviewProvisionalV2(input.projectRoot, cas, input.storage);
		if (!persisted.ok) {
			const point = persisted.error.point === undefined ? "" : ` at ${persisted.error.point}`;
			return fail("storage_failure", `delegation v2 review persistence failed (${persisted.error.code}${point})`, { review, transaction: state });
		}
		const persistedReview: ReviewResult = {
			...review,
			record: persisted.value.review,
		};
		return {
			ok: true,
			review: persistedReview,
			transaction: persisted.value.state,
			review_hash: persisted.value.review_hash,
			review_path: persisted.value.review_path,
			finalized: persisted.value.finalized,
		};
	} catch {
		return fail("review_invalid", "delegation v2 review failed closed");
	}
}
