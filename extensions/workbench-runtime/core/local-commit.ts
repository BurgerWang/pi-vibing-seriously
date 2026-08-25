/**
 * Bound local Git commit for one finalized semantic delegation review.
 *
 * This is deliberately not a shell escape. The caller supplies only a commit
 * message; paths come from strict review authority. The operation
 * never pushes, amends, cleans, resets the worktree, switches branches, or
 * stages an unrelated path.
 */

import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { ExecFn } from "./config.ts";
import {
	acquireProjectDelegationStartLockV1,
	releaseProjectDelegationStartLockV1,
	type ProjectDelegationStartLockLeaseV1,
} from "./delegation-start-lock.ts";
import {
	collectGitFacts,
	delegationsDir,
	isValidDelegationId,
	type GitFacts,
} from "./delegation-ledger.ts";
import {
	collectCurrentDelegationBindingV2,
	type DelegationAuthorityObservationV2,
	MAX_PROJECT_DELEGATION_ENTRIES_V2,
	readDelegationAuthorityObservationV2,
	readLatestProjectDelegationTransactionV2,
} from "./delegation-project-authority.ts";
import { readDelegationCommittedGenerationV2 } from "./delegation-transaction-storage.ts";

export const LOCAL_COMMIT_MESSAGE_MAX_BYTES_V1 = 240 as const;
const COMMIT_HASH_RE = /^[0-9a-f]{40,64}$/u;
const FORBIDDEN_MESSAGE_RE = /[\u0000-\u001f\u007f]/u;
const IN_PROGRESS_GIT_MARKERS = [
	"MERGE_HEAD",
	"CHERRY_PICK_HEAD",
	"REVERT_HEAD",
	"REBASE_HEAD",
	"BISECT_LOG",
] as const;

export type LocalReviewedCommitErrorCodeV1 =
	| "invalid_input"
	| "authority_unavailable"
	| "review_not_ready"
	| "binding_conflict"
	| "workspace_unavailable"
	| "workspace_changed"
	| "staged_changes_present"
	| "git_operation_in_progress"
	| "detached_head"
	| "commit_failed"
	| "index_recovery_required"
	| "post_commit_verification_failed"
	| "lock_conflict"
	| "lock_release_failed";

export interface LocalReviewedCommitFailureV1 {
	ok: false;
	code: LocalReviewedCommitErrorCodeV1;
	message: string;
	delegation_id?: string;
	commit?: string;
}

export interface LocalReviewedCommitSuccessV1 {
	ok: true;
	delegation_id: string;
	commit: string;
	branch: string;
	committed_paths: string[];
	remaining_changed_paths: number;
	authority_binding: "current" | "accepted_head_descendant";
	lock_release: "released" | "recovery_required";
}

export type LocalReviewedCommitResultV1 = LocalReviewedCommitFailureV1 | LocalReviewedCommitSuccessV1;

export type LocalCommitCandidateDelegationIdsResultV1 =
	| { ok: true; value: string[] }
	| { ok: false };

/**
 * Discover bounded delegation ids for reviewed-backlog checkpointing.
 *
 * This reads names only. Every candidate still has to pass the strict v2
 * transaction, committed-generation, review, and live Git checks below.
 */
export async function listLocalCommitCandidateDelegationIdsV1(
	projectRoot: string,
): Promise<LocalCommitCandidateDelegationIdsResultV1> {
	const root = delegationsDir(projectRoot);
	let entries: Dirent<string>[];
	try {
		const stat = await lstat(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false };
		entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { ok: true, value: [] }
			: { ok: false };
	}
	if (entries.length > MAX_PROJECT_DELEGATION_ENTRIES_V2) return { ok: false };
	const ids: string[] = [];
	for (const entry of entries) {
		if (!isValidDelegationId(entry.name)) continue;
		if (!entry.isDirectory() || entry.isSymbolicLink()) return { ok: false };
		try {
			const stat = await lstat(join(root, entry.name));
			if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false };
		} catch {
			return { ok: false };
		}
		ids.push(entry.name);
	}
	ids.sort((left, right) => left === right ? 0 : left < right ? 1 : -1);
	return { ok: true, value: ids };
}

export interface LocalReviewedCommitServicesV1 {
	readLatestTransaction: typeof readLatestProjectDelegationTransactionV2;
	listCandidateIds: typeof listLocalCommitCandidateDelegationIdsV1;
	readAuthority: typeof readDelegationAuthorityObservationV2;
	readCommittedGeneration: typeof readDelegationCommittedGenerationV2;
	collectBinding: typeof collectCurrentDelegationBindingV2;
	collectGitFacts: typeof collectGitFacts;
	acquireStartLock: typeof acquireProjectDelegationStartLockV1;
	releaseStartLock: typeof releaseProjectDelegationStartLockV1;
}

export const LOCAL_REVIEWED_COMMIT_SERVICES_V1: LocalReviewedCommitServicesV1 = Object.freeze({
	readLatestTransaction: readLatestProjectDelegationTransactionV2,
	listCandidateIds: listLocalCommitCandidateDelegationIdsV1,
	readAuthority: readDelegationAuthorityObservationV2,
	readCommittedGeneration: readDelegationCommittedGenerationV2,
	collectBinding: collectCurrentDelegationBindingV2,
	collectGitFacts,
	acquireStartLock: acquireProjectDelegationStartLockV1,
	releaseStartLock: releaseProjectDelegationStartLockV1,
});

function failure(
	code: LocalReviewedCommitErrorCodeV1,
	message: string,
	delegationId?: string,
	commit?: string,
): LocalReviewedCommitFailureV1 {
	return {
		ok: false,
		code,
		message,
		...(delegationId === undefined ? {} : { delegation_id: delegationId }),
		...(commit === undefined ? {} : { commit }),
	};
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function stagedPaths(facts: GitFacts): string[] {
	return facts.changedPaths.filter((path) => {
		const status = facts.pathStatuses[path];
		return status !== undefined && status[0] !== " " && status[0] !== "?";
	});
}

function hasConflict(facts: GitFacts): boolean {
	return facts.changedPaths.some((path) => {
		const status = facts.pathStatuses[path] ?? "";
		return status.includes("U") || status === "AA" || status === "DD";
	});
}

function sameContentSnapshot(before: GitFacts, after: GitFacts, reviewedPaths: ReadonlySet<string>): boolean {
	if (before.gitHead !== after.gitHead || !sameStrings(before.changedPaths, after.changedPaths)) return false;
	for (const path of before.changedPaths) {
		if (before.pathDigests[path] !== after.pathDigests[path]) return false;
		if (!reviewedPaths.has(path) && before.pathStatuses[path] !== after.pathStatuses[path]) return false;
	}
	return true;
}

function parseNulPaths(value: string): string[] {
	return value.split("\0").filter(Boolean).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

interface ReviewedAfterSnapshotV1 {
	gitHead: string;
	pathStatuses: Record<string, string>;
	pathDigests: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviewedAfterSnapshot(
	after: unknown,
	reviewedPaths: readonly string[],
): ReviewedAfterSnapshotV1 | undefined {
	if (!isRecord(after) || typeof after.git_head !== "string" || !COMMIT_HASH_RE.test(after.git_head)
		|| !isRecord(after.path_statuses) || !isRecord(after.path_digests)
		|| !Array.isArray(after.changed_paths) || !after.changed_paths.every((path) => typeof path === "string")
		|| !sameStrings(after.changed_paths, reviewedPaths)) return undefined;
	const statuses: Record<string, string> = {};
	const digests: Record<string, string> = {};
	for (const path of reviewedPaths) {
		const status = after.path_statuses[path];
		if (typeof status !== "string" || status.length === 0) return undefined;
		statuses[path] = status;
		const digest = after.path_digests[path];
		if (digest !== undefined) {
			if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) return undefined;
			digests[path] = digest;
		}
	}
	return { gitHead: after.git_head, pathStatuses: statuses, pathDigests: digests };
}

function matchesReviewedSnapshot(
	facts: GitFacts,
	paths: readonly string[],
	snapshot: ReviewedAfterSnapshotV1,
): boolean {
	return paths.every((path) => facts.pathStatuses[path] === snapshot.pathStatuses[path]
		&& facts.pathDigests[path] === snapshot.pathDigests[path]);
}

/**
 * A completed zero-write diagnosis has no implementation review obligation and
 * therefore must not hide an older still-present ACCEPT checkpoint. Every
 * unresolved or failed latest transaction remains blocking.
 */
function isFinalizedZeroDeltaDiagnosis(authority: DelegationAuthorityObservationV2): boolean {
	return authority.kind === "v2"
		&& authority.transactionStatus === "FINISHED"
		&& authority.transactionVerdict === "PASS"
		&& authority.review === null
		&& authority.reviewPath === null
		&& authority.finalized
		&& !authority.semanticAccepted
		&& authority.semanticBindingHash === null
		&& authority.semanticSource === null
		&& authority.semanticReviewer === null
		&& authority.semanticAcceptedAt === null;
}

async function runGit(exec: ExecFn, projectRoot: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false }> {
	try {
		const result = await exec("git", args, { cwd: projectRoot });
		return result.code === 0 ? { ok: true, stdout: result.stdout } : { ok: false };
	} catch {
		return { ok: false };
	}
}

async function acceptedHeadDescendantCompatible(input: {
	exec: ExecFn;
	projectRoot: string;
	reviewedHead: string;
	currentHead: string;
	reviewedPaths: string[];
}): Promise<boolean> {
	try {
		const ancestor = await input.exec("git", ["merge-base", "--is-ancestor", input.reviewedHead, input.currentHead], {
			cwd: input.projectRoot,
		});
		if (ancestor.code !== 0) return false;
		const touched = await input.exec("git", [
			"diff", "--name-only", "--find-renames", "-z", `${input.reviewedHead}..${input.currentHead}`, "--", ...input.reviewedPaths,
		], { cwd: input.projectRoot });
		return touched.code === 0 && parseNulPaths(touched.stdout).length === 0;
	} catch {
		return false;
	}
}

async function operationInProgress(exec: ExecFn, projectRoot: string): Promise<boolean | undefined> {
	for (const marker of IN_PROGRESS_GIT_MARKERS) {
		try {
			const result = await exec("git", ["rev-parse", "--verify", "--quiet", marker], { cwd: projectRoot });
			if (result.code === 0) return true;
			if (result.code !== 1) return undefined;
		} catch {
			return undefined;
		}
	}
	for (const name of ["rebase-merge", "rebase-apply"] as const) {
		const gitPath = await runGit(exec, projectRoot, ["rev-parse", "--git-path", name]);
		if (!gitPath.ok || gitPath.stdout.trim().length === 0) return undefined;
		const path = gitPath.stdout.trim();
		const absolute = isAbsolute(path) ? path : resolve(projectRoot, path);
		try {
			await lstat(absolute);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
		}
	}
	return false;
}

async function releaseLease(
	services: LocalReviewedCommitServicesV1,
	lease: ProjectDelegationStartLockLeaseV1,
): Promise<boolean> {
	try {
		const released = await services.releaseStartLock(lease);
		return released.ok;
	} catch {
		return false;
	}
}

/**
 * Commit exactly one still-present finalized semantic review's checked paths.
 *
 * The newest authority is preferred. After an earlier reviewed checkpoint has
 * advanced HEAD, the next historical authority is usable only for the narrow
 * `head_conflict` case: its reviewed bytes/status must still match the sealed
 * after-record, current HEAD must descend from the reviewed HEAD, and no
 * intervening commit may have touched those paths. Receipt/Gate/review files
 * remain outside the commit and push is never run.
 */
export async function commitLatestReviewedDelegationV1(input: {
	project_root: string;
	message: string;
	now: string;
	exec: ExecFn;
}, services: LocalReviewedCommitServicesV1 = LOCAL_REVIEWED_COMMIT_SERVICES_V1): Promise<LocalReviewedCommitResultV1> {
	if (typeof input.project_root !== "string" || input.project_root.length === 0
		|| typeof input.message !== "string" || input.message.trim() !== input.message
		|| input.message.length === 0 || Buffer.byteLength(input.message, "utf8") > LOCAL_COMMIT_MESSAGE_MAX_BYTES_V1
		|| FORBIDDEN_MESSAGE_RE.test(input.message)
		|| typeof input.now !== "string" || !Number.isFinite(Date.parse(input.now))) {
		return failure("invalid_input", "a single-line 1-240 byte commit message and canonical time are required");
	}

	const firstLatest = await services.readLatestTransaction(input.project_root);
	if (!firstLatest.ok) return failure("authority_unavailable", "latest delegation authority is unavailable");
	if (firstLatest.value === null) return failure("review_not_ready", "no reviewed delegation is available to commit");
	const lockDelegationId = firstLatest.value.delegation_id;

	const acquired = await services.acquireStartLock({
		project_root: input.project_root,
		delegation_id: lockDelegationId,
		now: input.now,
	});
	if (!acquired.ok) return failure("lock_conflict", "another delegation or local commit is active", lockDelegationId);
	const lease = acquired.value;
	let delegationId = lockDelegationId;
	let stagedByOperation = false;
	let committedHash: string | undefined;
	let reviewedPathsForRecovery: string[] = [];
	let outcome: LocalReviewedCommitResultV1;
	const perform = async (): Promise<LocalReviewedCommitResultV1> => {
		const latest = await services.readLatestTransaction(input.project_root);
		if (!latest.ok || latest.value === null || latest.value.delegation_id !== lockDelegationId) {
			outcome = failure("authority_unavailable", "latest delegation changed before commit authority was acquired", lockDelegationId);
			return outcome;
		}

		let before: GitFacts;
		try {
			before = await services.collectGitFacts(input.project_root, input.exec);
		} catch {
			outcome = failure("workspace_unavailable", "Git workspace facts are unavailable", lockDelegationId);
			return outcome;
		}
		if (before.gitHead === null) {
			outcome = failure("workspace_unavailable", "a committed Git HEAD is required", lockDelegationId);
			return outcome;
		}
		if (hasConflict(before)) {
			outcome = failure("workspace_changed", "the workspace contains unresolved conflicts", lockDelegationId);
			return outcome;
		}

		const listed = await services.listCandidateIds(input.project_root);
		if (!listed.ok || !listed.value.includes(lockDelegationId)) {
			outcome = failure("authority_unavailable", "reviewed delegation history is unavailable", lockDelegationId);
			return outcome;
		}
		const candidateIds = [lockDelegationId, ...listed.value.filter((id) => id !== lockDelegationId)];
		let reviewedPaths: string[] | undefined;
		let authorityBinding: LocalReviewedCommitSuccessV1["authority_binding"] | undefined;
		for (const candidateId of candidateIds) {
			const authority = await services.readAuthority(input.project_root, candidateId);
			if (authority.kind === "invalid-v2") {
				outcome = failure("authority_unavailable", "reviewed delegation history contains invalid authority", candidateId);
				return outcome;
			}
			if (authority.kind !== "v2" || authority.transactionStatus !== "REVIEWED" || !authority.finalized
				|| !authority.semanticAccepted || authority.semanticBindingHash === null || authority.review === null) {
				if (candidateId === lockDelegationId) {
					if (isFinalizedZeroDeltaDiagnosis(authority)) continue;
					outcome = failure("review_not_ready", "latest delegation lacks finalized semantic ACCEPT authority", candidateId);
					return outcome;
				}
				continue;
			}
			const paths = sortedUnique(authority.review.checked_paths);
			if (paths.length === 0) continue;
			const present = paths.filter((path) => before.changedPaths.includes(path));
			if (present.length === 0) continue;
			if (present.length !== paths.length) {
				outcome = failure("workspace_changed", "a semantic ACCEPT path set is only partially present", candidateId);
				return outcome;
			}

			const binding = await services.collectBinding(input.project_root, candidateId, input.exec);
			if (binding.status === "fresh" && binding.hash === authority.semanticBindingHash) {
				delegationId = candidateId;
				reviewedPaths = paths;
				authorityBinding = "current";
				break;
			}
			if (binding.status !== "conflict" || binding.code !== "head_conflict") {
				outcome = failure("binding_conflict", "reviewed project bytes no longer match semantic ACCEPT authority", candidateId);
				return outcome;
			}
			const committed = await services.readCommittedGeneration(input.project_root, candidateId);
			if (!committed.ok) {
				outcome = failure("authority_unavailable", "the accepted delegation generation is unavailable", candidateId);
				return outcome;
			}
			const snapshot = reviewedAfterSnapshot(committed.value.records["after.json"], paths);
			if (snapshot === undefined || !matchesReviewedSnapshot(before, paths, snapshot)) {
				outcome = failure("workspace_changed", "historical semantic ACCEPT bytes no longer match the sealed reviewed snapshot", candidateId);
				return outcome;
			}
			if (!await acceptedHeadDescendantCompatible({
				exec: input.exec,
				projectRoot: input.project_root,
				reviewedHead: snapshot.gitHead,
				currentHead: before.gitHead,
				reviewedPaths: paths,
			})) {
				outcome = failure("binding_conflict", "HEAD advancement is not a path-disjoint descendant of semantic ACCEPT authority", candidateId);
				return outcome;
			}
			delegationId = candidateId;
			reviewedPaths = paths;
			authorityBinding = "accepted_head_descendant";
			break;
		}
		if (reviewedPaths === undefined || authorityBinding === undefined) {
			outcome = failure("review_not_ready", "no still-present finalized semantic ACCEPT path set is available to commit", lockDelegationId);
			return outcome;
		}
		reviewedPathsForRecovery = reviewedPaths;
		const stagedBefore = sortedUnique(stagedPaths(before));
		if (stagedBefore.length > 0 && !sameStrings(stagedBefore, reviewedPaths)) {
			outcome = failure("staged_changes_present", "the Git index contains changes outside the reviewed path set", delegationId);
			return outcome;
		}

		const branchResult = await runGit(input.exec, input.project_root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
		if (!branchResult.ok || branchResult.stdout.trim().length === 0) {
			outcome = failure("detached_head", "local commit requires a named branch", delegationId);
			return outcome;
		}
		const branch = branchResult.stdout.trim();
		const inProgress = await operationInProgress(input.exec, input.project_root);
		if (inProgress === undefined) {
			outcome = failure("workspace_unavailable", "Git operation state is unavailable", delegationId);
			return outcome;
		}
		if (inProgress) {
			outcome = failure("git_operation_in_progress", "merge, rebase, cherry-pick, revert, or bisect is active", delegationId);
			return outcome;
		}

		const added = await runGit(input.exec, input.project_root, ["add", "--", ...reviewedPaths]);
		if (!added.ok) {
			outcome = failure("commit_failed", "reviewed paths could not be staged", delegationId);
			return outcome;
		}
		stagedByOperation = stagedBefore.length === 0;
		const staged = await runGit(input.exec, input.project_root, ["diff", "--cached", "--name-only", "--find-renames", "-z"]);
		if (!staged.ok || !sameStrings(parseNulPaths(staged.stdout), reviewedPaths)) {
			outcome = failure("staged_changes_present", "staged paths do not exactly match the reviewed path set", delegationId);
			return outcome;
		}
		const whitespace = await runGit(input.exec, input.project_root, ["diff", "--cached", "--check"]);
		if (!whitespace.ok) {
			outcome = failure("commit_failed", "the reviewed staged diff fails Git whitespace checks", delegationId);
			return outcome;
		}
		let afterStage: GitFacts;
		try {
			afterStage = await services.collectGitFacts(input.project_root, input.exec);
		} catch {
			outcome = failure("workspace_unavailable", "Git workspace changed during staging", delegationId);
			return outcome;
		}
		if (!sameContentSnapshot(before, afterStage, new Set(reviewedPaths))) {
			outcome = failure("workspace_changed", "project content changed after semantic review", delegationId);
			return outcome;
		}
		const expectedTree = await runGit(input.exec, input.project_root, ["write-tree"]);
		if (!expectedTree.ok || !COMMIT_HASH_RE.test(expectedTree.stdout.trim())) {
			outcome = failure("commit_failed", "the reviewed staged tree could not be verified", delegationId);
			return outcome;
		}

		const committed = await runGit(input.exec, input.project_root, ["commit", "-m", input.message]);
		if (!committed.ok) {
			outcome = failure("commit_failed", "Git did not create the local commit", delegationId);
			return outcome;
		}
		const head = await runGit(input.exec, input.project_root, ["rev-parse", "HEAD"]);
		if (!head.ok || !COMMIT_HASH_RE.test(head.stdout.trim()) || head.stdout.trim() === before.gitHead) {
			outcome = failure("post_commit_verification_failed", "the new local HEAD could not be verified", delegationId);
			return outcome;
		}
		committedHash = head.stdout.trim();
		const committedTree = await runGit(input.exec, input.project_root, ["rev-parse", `${committedHash}^{tree}`]);
		if (!committedTree.ok || committedTree.stdout.trim() !== expectedTree.stdout.trim()) {
			outcome = failure(
				"post_commit_verification_failed",
				"the created commit tree differs from the reviewed staged tree",
				delegationId,
				committedHash,
			);
			return outcome;
		}
		const committedPaths = await runGit(input.exec, input.project_root, [
			"diff-tree", "--root", "--no-commit-id", "--name-only", "--find-renames", "-r", "-z", committedHash,
		]);
		if (!committedPaths.ok || !sameStrings(parseNulPaths(committedPaths.stdout), reviewedPaths)) {
			outcome = failure(
				"post_commit_verification_failed",
				"the created commit path set does not match semantic review authority",
				delegationId,
				committedHash,
			);
			return outcome;
		}
		let remaining: GitFacts;
		try {
			remaining = await services.collectGitFacts(input.project_root, input.exec);
		} catch {
			outcome = failure(
				"post_commit_verification_failed",
				"the commit was created but post-commit workspace facts are unavailable",
				delegationId,
				committedHash,
			);
			return outcome;
		}
		outcome = {
			ok: true,
			delegation_id: delegationId,
			commit: committedHash,
			branch,
			committed_paths: reviewedPaths,
			remaining_changed_paths: remaining.changedPaths.length,
			authority_binding: authorityBinding,
			lock_release: "released",
		};
		return outcome;
	};
	try {
		outcome = await perform();
	} catch {
		outcome = failure("commit_failed", "local commit failed before a verified commit was created", delegationId, committedHash);
	}
	if (!committedHash && stagedByOperation) {
		const reset = await runGit(input.exec, input.project_root, [
			"reset", "--quiet", "--mixed", "HEAD", "--", ...reviewedPathsForRecovery,
		]);
		if (!reset.ok) outcome = failure("index_recovery_required", "commit failed and the Git index requires manual recovery", delegationId);
	}
	const released = await releaseLease(services, lease);
	if (!released) {
		if (outcome.ok) outcome.lock_release = "recovery_required";
		else outcome = failure("lock_release_failed", "local commit lock release requires recovery", delegationId, committedHash);
	}
	return outcome;
}
