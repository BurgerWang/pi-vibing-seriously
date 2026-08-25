/**
 * Structured fast-forward Git publication for the current named branch.
 *
 * The caller must bind the request to the exact current HEAD. The operation
 * cannot force, delete a ref, push another local ref, switch branches, amend,
 * or rewrite history. A successful push is verified against the remote ref.
 */

import type { ExecFn } from "./config.ts";

const COMMIT_HASH_RE = /^[0-9a-f]{40,64}$/u;
const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export type GitPublishErrorCodeV1 =
	| "invalid_input"
	| "workspace_unavailable"
	| "detached_head"
	| "head_changed"
	| "remote_unavailable"
	| "push_rejected"
	| "remote_verification_failed";

export type GitPublishResultV1 =
	| {
		ok: true;
		commit: string;
		branch: string;
		remote: string;
		upstream: `${string}/${string}`;
		verification: "remote_head_exact";
	}
	| {
		ok: false;
		code: GitPublishErrorCodeV1;
		message: string;
		commit?: string;
		branch?: string;
	};

async function runGit(
	exec: ExecFn,
	projectRoot: string,
	args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false }> {
	try {
		const result = await exec("git", args, { cwd: projectRoot });
		return result.code === 0 ? { ok: true, stdout: result.stdout } : { ok: false };
	} catch {
		return { ok: false };
	}
}

function failure(
	code: GitPublishErrorCodeV1,
	message: string,
	commit?: string,
	branch?: string,
): GitPublishResultV1 {
	return {
		ok: false,
		code,
		message,
		...(commit === undefined ? {} : { commit }),
		...(branch === undefined ? {} : { branch }),
	};
}

export async function pushCurrentBranchV1(input: {
	project_root: string;
	expected_head: string;
	remote?: string | undefined;
	exec: ExecFn;
}): Promise<GitPublishResultV1> {
	const remote = input.remote ?? "origin";
	if (typeof input.project_root !== "string" || input.project_root.length === 0
		|| typeof input.expected_head !== "string" || !COMMIT_HASH_RE.test(input.expected_head)
		|| typeof remote !== "string" || !REMOTE_NAME_RE.test(remote)) {
		return failure("invalid_input", "an exact commit hash and a simple Git remote name are required");
	}

	const head = await runGit(input.exec, input.project_root, ["rev-parse", "HEAD"]);
	if (!head.ok || !COMMIT_HASH_RE.test(head.stdout.trim())) {
		return failure("workspace_unavailable", "the current Git HEAD is unavailable");
	}
	const commit = head.stdout.trim();
	if (commit !== input.expected_head) {
		return failure("head_changed", "current HEAD differs from expected_head; inspect and authorize the current commit", commit);
	}

	const branchResult = await runGit(input.exec, input.project_root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (!branchResult.ok || branchResult.stdout.trim().length === 0) {
		return failure("detached_head", "publication requires a named current branch", commit);
	}
	const branch = branchResult.stdout.trim();
	const validBranch = await runGit(input.exec, input.project_root, ["check-ref-format", "--branch", branch]);
	if (!validBranch.ok) return failure("workspace_unavailable", "the current branch name is invalid", commit, branch);

	const remoteUrl = await runGit(input.exec, input.project_root, ["remote", "get-url", remote]);
	if (!remoteUrl.ok || remoteUrl.stdout.trim().length === 0) {
		return failure("remote_unavailable", "the requested Git remote is unavailable", commit, branch);
	}

	const pushed = await runGit(input.exec, input.project_root, [
		"push",
		"--porcelain",
		"--set-upstream",
		remote,
		`HEAD:refs/heads/${branch}`,
	]);
	if (!pushed.ok) {
		return failure("push_rejected", "Git rejected the ordinary non-force push", commit, branch);
	}

	const headAfter = await runGit(input.exec, input.project_root, ["rev-parse", "HEAD"]);
	if (!headAfter.ok || headAfter.stdout.trim() !== commit) {
		return failure("remote_verification_failed", "local HEAD changed while verifying the push", commit, branch);
	}
	const remoteHead = await runGit(input.exec, input.project_root, [
		"ls-remote",
		"--heads",
		remote,
		`refs/heads/${branch}`,
	]);
	if (!remoteHead.ok) {
		return failure("remote_verification_failed", "the pushed remote branch could not be read back", commit, branch);
	}
	const fields = remoteHead.stdout.trim().split(/\s+/u);
	if (fields.length !== 2 || fields[0] !== commit || fields[1] !== `refs/heads/${branch}`) {
		return failure("remote_verification_failed", "the remote branch does not point to the expected commit", commit, branch);
	}

	return {
		ok: true,
		commit,
		branch,
		remote,
		upstream: `${remote}/${branch}`,
		verification: "remote_head_exact",
	};
}
