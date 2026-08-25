/**
 * Bound local Git commit for one finalized semantic delegation review.
 *
 * This is deliberately not a shell escape. The caller supplies only a commit
 * message; paths come from the latest strict review authority. The operation
 * never pushes, amends, cleans, resets the worktree, switches branches, or
 * stages an unrelated path.
 */

import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ExecFn } from "./config.ts";
import {
	acquireProjectDelegationStartLockV1,
	releaseProjectDelegationStartLockV1,
	type ProjectDelegationStartLockLeaseV1,
} from "./delegation-start-lock.ts";
import { collectGitFacts, type GitFacts } from "./delegation-ledger.ts";
import {
	collectCurrentDelegationBindingV2,
	readDelegationAuthorityObservationV2,
	readLatestProjectDelegationTransactionV2,
} from "./delegation-project-authority.ts";

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
	lock_release: "released" | "recovery_required";
}

export type LocalReviewedCommitResultV1 = LocalReviewedCommitFailureV1 | LocalReviewedCommitSuccessV1;

export interface LocalReviewedCommitServicesV1 {
	readLatestTransaction: typeof readLatestProjectDelegationTransactionV2;
	readAuthority: typeof readDelegationAuthorityObservationV2;
	collectBinding: typeof collectCurrentDelegationBindingV2;
	collectGitFacts: typeof collectGitFacts;
	acquireStartLock: typeof acquireProjectDelegationStartLockV1;
	releaseStartLock: typeof releaseProjectDelegationStartLockV1;
}

export const LOCAL_REVIEWED_COMMIT_SERVICES_V1: LocalReviewedCommitServicesV1 = Object.freeze({
	readLatestTransaction: readLatestProjectDelegationTransactionV2,
	readAuthority: readDelegationAuthorityObservationV2,
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

async function runGit(exec: ExecFn, projectRoot: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false }> {
	try {
		const result = await exec("git", args, { cwd: projectRoot });
		return result.code === 0 ? { ok: true, stdout: result.stdout } : { ok: false };
	} catch {
		return { ok: false };
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
 * Commit exactly the latest finalized semantic review's checked paths.
 * Receipt/Gate/review files remain outside the commit and push is never run.
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
	const delegationId = firstLatest.value.delegation_id;

	const acquired = await services.acquireStartLock({
		project_root: input.project_root,
		delegation_id: delegationId,
		now: input.now,
	});
	if (!acquired.ok) return failure("lock_conflict", "another delegation or local commit is active", delegationId);
	const lease = acquired.value;
	let stagedByOperation = false;
	let committedHash: string | undefined;
	let reviewedPathsForRecovery: string[] = [];
	let outcome: LocalReviewedCommitResultV1;
	const perform = async (): Promise<LocalReviewedCommitResultV1> => {
		const latest = await services.readLatestTransaction(input.project_root);
		if (!latest.ok || latest.value === null || latest.value.delegation_id !== delegationId) {
			outcome = failure("authority_unavailable", "latest delegation changed before commit authority was acquired", delegationId);
			return outcome;
		}
		const authority = await services.readAuthority(input.project_root, delegationId);
		if (authority.kind !== "v2" || authority.transactionStatus !== "REVIEWED" || !authority.finalized
			|| !authority.semanticAccepted || authority.semanticBindingHash === null || authority.review === null) {
			outcome = failure("review_not_ready", "latest delegation lacks finalized semantic ACCEPT authority", delegationId);
			return outcome;
		}
		const reviewedPaths = sortedUnique(authority.review.checked_paths);
		reviewedPathsForRecovery = reviewedPaths;
		if (reviewedPaths.length === 0) {
			outcome = failure("review_not_ready", "the reviewed delegation has no project changes to commit", delegationId);
			return outcome;
		}
		const binding = await services.collectBinding(input.project_root, delegationId, input.exec);
		if (binding.status !== "fresh" || binding.hash !== authority.semanticBindingHash) {
			outcome = failure("binding_conflict", "reviewed project bytes no longer match semantic ACCEPT authority", delegationId);
			return outcome;
		}

		let before: GitFacts;
		try {
			before = await services.collectGitFacts(input.project_root, input.exec);
		} catch {
			outcome = failure("workspace_unavailable", "Git workspace facts are unavailable", delegationId);
			return outcome;
		}
		if (before.gitHead === null) {
			outcome = failure("workspace_unavailable", "a committed Git HEAD is required", delegationId);
			return outcome;
		}
		if (hasConflict(before) || !reviewedPaths.every((path) => before.changedPaths.includes(path))) {
			outcome = failure("workspace_changed", "reviewed paths are missing or contain unresolved conflicts", delegationId);
			return outcome;
		}
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

		const added = await runGit(input.exec, input.project_root, ["add", "-A", "--", ...reviewedPaths]);
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
