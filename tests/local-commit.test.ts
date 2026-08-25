import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { collectGitFacts } from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import {
	commitLatestReviewedDelegationV1,
	type LocalReviewedCommitServicesV1,
} from "../extensions/workbench-runtime/core/local-commit.ts";

const execFileAsync = promisify(execFile);
const DIAGNOSIS_DELEGATION_ID = "20260825-130000-diag";
const DELEGATION_ID = "20260825-120000-abcd";
const EARLIER_DELEGATION_ID = "20260825-110000-wxyz";
const BINDING_HASH = "a".repeat(64);

const exec: ExecFn = async (command, args, options = {}) => {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options.cwd,
			timeout: options.timeout,
			signal: options.signal,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		});
		return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
		return {
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
			code: typeof failure.code === "number" ? failure.code : 1,
			killed: failure.killed === true,
		};
	}
};

async function git(root: string, ...args: string[]): Promise<string> {
	const result = await exec("git", args, { cwd: root });
	assert.equal(result.code, 0, result.stderr || result.stdout);
	return result.stdout;
}

async function repo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-local-commit-"));
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Workbench Test");
	await git(root, "config", "user.email", "workbench@example.invalid");
	await writeFile(join(root, "reviewed.txt"), "before\n", "utf8");
	await writeFile(join(root, "unrelated.txt"), "before\n", "utf8");
	await git(root, "add", "--", "reviewed.txt", "unrelated.txt");
	await git(root, "commit", "-m", "initial");
	return root;
}

function acceptedAuthority(delegationId: string, paths: string[]) {
	return {
		kind: "v2" as const,
		transactionStatus: "REVIEWED",
		transactionVerdict: null,
		review: { checked_paths: paths } as never,
		reviewPath: `.pi/workbench/delegations/${delegationId}/v2/review.json`,
		finalized: true,
		semanticAccepted: true,
		semanticBindingHash: BINDING_HASH,
		semanticSource: "embedded" as const,
		semanticReviewer: "openai-codex/gpt-5.6-sol",
		semanticAcceptedAt: "2026-08-25T12:00:00.000Z",
	};
}

function completedDiagnosisAuthority() {
	return {
		kind: "v2" as const,
		transactionStatus: "FINISHED",
		transactionVerdict: "PASS" as const,
		review: null,
		reviewPath: null,
		finalized: true,
		semanticAccepted: false,
		semanticBindingHash: null,
		semanticSource: null,
		semanticReviewer: null,
		semanticAcceptedAt: null,
	};
}

function services(options: { paths?: string[] } = {}): LocalReviewedCommitServicesV1 {
	const paths = options.paths ?? ["reviewed.txt"];
	return {
		readLatestTransaction: async () => ({
			ok: true,
			value: { delegation_id: DELEGATION_ID } as never,
		}),
		listCandidateIds: async () => ({ ok: true, value: [DELEGATION_ID] }),
		readAuthority: async () => acceptedAuthority(DELEGATION_ID, paths),
		readCommittedGeneration: async (projectRoot) => {
			const snapshot = await collectGitFacts(projectRoot, exec);
			return {
				ok: true,
				value: {
					records: {
						"after.json": {
							git_head: snapshot.gitHead,
							changed_paths: snapshot.changedPaths,
							path_statuses: snapshot.pathStatuses,
							path_digests: snapshot.pathDigests,
						},
					},
				} as never,
			};
		},
		collectGitFacts,
		acquireStartLock: async (input) => ({
			ok: true,
			value: {
				schema_version: 1,
				project_root: input.project_root,
				delegation_id: input.delegation_id,
				token: "1".repeat(32),
				process_id: 1,
				process_start_ticks: "1",
				boot_id: "11111111-1111-1111-1111-111111111111",
				acquired_at: input.now,
			},
		}),
		releaseStartLock: async () => ({ ok: true, value: undefined }),
	};
}

test("reviewed local commit commits only authority paths and preserves unrelated dirt", async () => {
	const root = await repo();
	try {
		await writeFile(join(root, "reviewed.txt"), "reviewed change\n", "utf8");
		await writeFile(join(root, "unrelated.txt"), "unrelated change\n", "utf8");
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "feat: commit reviewed slice",
			now: "2026-08-25T12:01:00.000Z",
			exec,
		}, services());
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.branch, "main");
		assert.deepEqual(result.committed_paths, ["reviewed.txt"]);
		assert.deepEqual(result.delegation_ids, [DELEGATION_ID]);
		assert.equal(result.remaining_changed_paths, 1);
		assert.equal(result.authority_binding, "sealed_review_paths");
		assert.equal(result.preserved_staged_paths, 0);
		assert.equal(result.lock_release, "released");
		assert.equal((await git(root, "show", "--format=", "--name-only", "HEAD")).trim(), "reviewed.txt");
		assert.equal((await readFile(join(root, "unrelated.txt"), "utf8")), "unrelated change\n");
		assert.match(await git(root, "status", "--short"), /^ M unrelated\.txt$/m);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("path-limited checkpoint includes a reviewed deletion without git add -A", async () => {
	const root = await repo();
	try {
		await unlink(join(root, "reviewed.txt"));
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "fix: remove reviewed file",
			now: "2026-08-25T12:01:30.000Z",
			exec,
		}, services());
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.committed_paths, ["reviewed.txt"]);
		assert.match(await git(root, "show", "--format=", "--name-status", "HEAD"), /^D\s+reviewed\.txt$/m);
		assert.equal((await git(root, "status", "--short")).trim(), "");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("path-limited checkpoint commits a reviewed rename atomically", async () => {
	const root = await repo();
	try {
		await git(root, "mv", "reviewed.txt", "renamed.txt");
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "refactor: rename reviewed file",
			now: "2026-08-25T12:01:45.000Z",
			exec,
		}, services({ paths: ["reviewed.txt", "renamed.txt"] }));
		assert.equal(result.ok, true, JSON.stringify(result));
		if (!result.ok) return;
		assert.deepEqual(result.committed_paths, ["renamed.txt", "reviewed.txt"]);
		assert.match(await git(root, "show", "--format=", "--name-status", "--find-renames", "HEAD"), /^R100\s+reviewed\.txt\s+renamed\.txt$/m);
		assert.equal((await git(root, "status", "--short")).trim(), "");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("legacy destination-only rename authority fails closed before creating a partial commit", async () => {
	const root = await repo();
	try {
		await git(root, "mv", "reviewed.txt", "renamed.txt");
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "refactor: reject incomplete rename authority",
			now: "2026-08-25T12:01:50.000Z",
			exec,
		}, services({ paths: ["renamed.txt"] }));
		assert.deepEqual(result.ok ? "ok" : result.code, "binding_conflict");
		assert.equal((await git(root, "log", "-1", "--format=%s")).trim(), "initial");
		assert.match(await git(root, "status", "--short"), /^R\s+reviewed\.txt -> renamed\.txt$/m);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("one checkpoint batches all compatible reviewed slices", async () => {
	const root = await repo();
	try {
		await writeFile(join(root, "reviewed.txt"), "newest accepted change\n", "utf8");
		await writeFile(join(root, "unrelated.txt"), "earlier accepted change\n", "utf8");
		const reviewedSnapshot = await collectGitFacts(root, exec);
		assert.ok(reviewedSnapshot.gitHead);
		const base = services();
		const historicalServices: LocalReviewedCommitServicesV1 = {
			...base,
			listCandidateIds: async () => ({ ok: true, value: [DELEGATION_ID, EARLIER_DELEGATION_ID] }),
			readAuthority: async (_projectRoot, delegationId) => delegationId === DELEGATION_ID
				? acceptedAuthority(DELEGATION_ID, ["reviewed.txt"])
				: acceptedAuthority(EARLIER_DELEGATION_ID, ["unrelated.txt"]),
			readCommittedGeneration: async () => {
				return {
					ok: true,
					value: {
						records: {
							"after.json": {
								git_head: reviewedSnapshot.gitHead,
								changed_paths: reviewedSnapshot.changedPaths,
								path_statuses: reviewedSnapshot.pathStatuses,
								path_digests: reviewedSnapshot.pathDigests,
							},
						},
					} as never,
				};
			},
		};

		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "feat: checkpoint reviewed backlog",
			now: "2026-08-25T12:01:00.000Z",
			exec,
		}, historicalServices);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.delegation_ids, [DELEGATION_ID, EARLIER_DELEGATION_ID]);
		assert.equal(result.authority_binding, "sealed_review_paths");
		assert.deepEqual(result.committed_paths, ["reviewed.txt", "unrelated.txt"]);
		assert.equal(result.remaining_changed_paths, 0);
		assert.equal((await git(root, "status", "--short")).trim(), "");
		assert.equal((await git(root, "log", "-1", "--format=%s")).trim(), "feat: checkpoint reviewed backlog");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a finalized zero-change diagnosis does not hide an older accepted slice", async () => {
	const root = await repo();
	try {
		await writeFile(join(root, "unrelated.txt"), "earlier accepted change\n", "utf8");
		const reviewedSnapshot = await collectGitFacts(root, exec);
		assert.ok(reviewedSnapshot.gitHead);
		await writeFile(join(root, "reviewed.txt"), "already checkpointed change\n", "utf8");
		await git(root, "add", "--", "reviewed.txt");
		await git(root, "commit", "-m", "checkpoint newer reviewed slice");

		const base = services();
		const diagnosisLatestServices: LocalReviewedCommitServicesV1 = {
			...base,
			readLatestTransaction: async () => ({
				ok: true,
				value: { delegation_id: DIAGNOSIS_DELEGATION_ID } as never,
			}),
			listCandidateIds: async () => ({
				ok: true,
				value: [DIAGNOSIS_DELEGATION_ID, EARLIER_DELEGATION_ID],
			}),
			readAuthority: async (_projectRoot, delegationId) => delegationId === DIAGNOSIS_DELEGATION_ID
				? completedDiagnosisAuthority()
				: acceptedAuthority(EARLIER_DELEGATION_ID, ["unrelated.txt"]),
			readCommittedGeneration: async (_projectRoot, delegationId) => {
				assert.equal(delegationId, EARLIER_DELEGATION_ID);
				return {
					ok: true,
					value: {
						records: {
							"after.json": {
								git_head: reviewedSnapshot.gitHead,
								changed_paths: ["unrelated.txt"],
								path_statuses: { "unrelated.txt": reviewedSnapshot.pathStatuses["unrelated.txt"] },
								path_digests: { "unrelated.txt": reviewedSnapshot.pathDigests["unrelated.txt"] },
							},
						},
					} as never,
				};
			},
		};
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "feat: commit earlier reviewed slice",
			now: "2026-08-25T13:01:00.000Z",
			exec,
		}, diagnosisLatestServices);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.delegation_id, EARLIER_DELEGATION_ID);
		assert.equal(result.authority_binding, "sealed_review_paths");
		assert.deepEqual(result.committed_paths, ["unrelated.txt"]);
		assert.equal(result.remaining_changed_paths, 0);
		assert.equal((await git(root, "status", "--short")).trim(), "");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("historical acceptance cannot cross a descendant commit that touched its paths", async () => {
	const root = await repo();
	try {
		const reviewedHead = (await git(root, "rev-parse", "HEAD")).trim();
		await writeFile(join(root, "reviewed.txt"), "accepted bytes\n", "utf8");
		const reviewedSnapshot = await collectGitFacts(root, exec);
		await writeFile(join(root, "reviewed.txt"), "intervening committed bytes\n", "utf8");
		await git(root, "add", "--", "reviewed.txt");
		await git(root, "commit", "-m", "manual intervening change");
		await writeFile(join(root, "reviewed.txt"), "accepted bytes\n", "utf8");
		const base = services();
		const historicalServices: LocalReviewedCommitServicesV1 = {
			...base,
			readCommittedGeneration: async () => ({
				ok: true,
				value: {
					records: {
						"after.json": {
							git_head: reviewedHead,
							changed_paths: ["reviewed.txt"],
							path_statuses: { "reviewed.txt": reviewedSnapshot.pathStatuses["reviewed.txt"] },
							path_digests: { "reviewed.txt": reviewedSnapshot.pathDigests["reviewed.txt"] },
						},
					},
				} as never,
			}),
		};
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "feat: must reject touched history",
			now: "2026-08-25T12:03:00.000Z",
			exec,
		}, historicalServices);
		assert.deepEqual(result.ok ? "ok" : result.code, "binding_conflict");
		assert.equal((await git(root, "diff", "--cached", "--name-only")).trim(), "");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an unrelated unresolved latest review does not block an older accepted slice", async () => {
	const root = await repo();
	try {
		await writeFile(join(root, "unrelated.txt"), "earlier accepted change\n", "utf8");
		const base = services();
		const guardedServices: LocalReviewedCommitServicesV1 = {
			...base,
			listCandidateIds: async () => ({ ok: true, value: [DELEGATION_ID, EARLIER_DELEGATION_ID] }),
			readAuthority: async (_projectRoot, delegationId) => delegationId === DELEGATION_ID
				? {
					...acceptedAuthority(DELEGATION_ID, ["reviewed.txt"]),
					transactionStatus: "PENDING_REVIEW",
					finalized: false,
					semanticAccepted: false,
					semanticBindingHash: null,
				}
				: acceptedAuthority(EARLIER_DELEGATION_ID, ["unrelated.txt"]),
		};
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "feat: checkpoint accepted slice",
			now: "2026-08-25T12:04:00.000Z",
			exec,
		}, guardedServices);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.delegation_ids, [EARLIER_DELEGATION_ID]);
		assert.deepEqual(result.committed_paths, ["unrelated.txt"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reviewed checkpoint preserves staged paths outside semantic authority", async () => {
	const root = await repo();
	try {
		await writeFile(join(root, "reviewed.txt"), "reviewed change\n", "utf8");
		await writeFile(join(root, "unrelated.txt"), "staged unrelated\n", "utf8");
		await git(root, "add", "--", "unrelated.txt");
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "feat: commit reviewed only",
			now: "2026-08-25T12:02:00.000Z",
			exec,
		}, services());
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.preserved_staged_paths, 1);
		assert.deepEqual(result.committed_paths, ["reviewed.txt"]);
		assert.equal((await git(root, "show", "--format=", "--name-only", "HEAD")).trim(), "reviewed.txt");
		assert.equal((await git(root, "diff", "--cached", "--name-only")).trim(), "unrelated.txt");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("unrelated post-review dirt and reviewed staging-state changes do not invalidate sealed bytes", async () => {
	const root = await repo();
	try {
		await writeFile(join(root, "reviewed.txt"), "accepted bytes\n", "utf8");
		const acceptedSnapshot = await collectGitFacts(root, exec);
		await git(root, "add", "--", "reviewed.txt");
		await writeFile(join(root, "unrelated.txt"), "later unrelated dirt\n", "utf8");
		const compatibleServices: LocalReviewedCommitServicesV1 = {
			...services(),
			readCommittedGeneration: async () => ({
				ok: true,
				value: {
					records: {
						"after.json": {
							git_head: acceptedSnapshot.gitHead,
							changed_paths: acceptedSnapshot.changedPaths,
							path_statuses: acceptedSnapshot.pathStatuses,
							path_digests: acceptedSnapshot.pathDigests,
						},
					},
				} as never,
			}),
		};
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "feat: checkpoint sealed bytes",
			now: "2026-08-25T12:02:30.000Z",
			exec,
		}, compatibleServices);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.committed_paths, ["reviewed.txt"]);
		assert.match(await git(root, "status", "--short"), /^ M unrelated\.txt$/m);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reviewed checkpoint rejects path-content drift after semantic acceptance", async () => {
	const root = await repo();
	try {
		await writeFile(join(root, "reviewed.txt"), "accepted change\n", "utf8");
		const acceptedSnapshot = await collectGitFacts(root, exec);
		await writeFile(join(root, "reviewed.txt"), "drift after review\n", "utf8");
		const driftServices: LocalReviewedCommitServicesV1 = {
			...services(),
			readCommittedGeneration: async () => ({
				ok: true,
				value: {
					records: {
						"after.json": {
							git_head: acceptedSnapshot.gitHead,
							changed_paths: acceptedSnapshot.changedPaths,
							path_statuses: acceptedSnapshot.pathStatuses,
							path_digests: acceptedSnapshot.pathDigests,
						},
					},
				} as never,
			}),
		};
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "feat: stale authority",
			now: "2026-08-25T12:03:00.000Z",
			exec,
		}, driftServices);
		assert.deepEqual(result.ok ? "ok" : result.code, "binding_conflict");
		assert.equal((await git(root, "diff", "--cached", "--name-only")).trim(), "");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("failed Git commit preserves reviewed worktree bytes and prior index state", async () => {
	const root = await repo();
	try {
		await writeFile(join(root, "reviewed.txt"), "reviewed change\n", "utf8");
		const failingExec: ExecFn = async (command, args, options) => {
			if (command === "git" && args[0] === "commit") {
				return { stdout: "", stderr: "hook refused", code: 1, killed: false };
			}
			return exec(command, args, options);
		};
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "feat: rejected by Git",
			now: "2026-08-25T12:04:00.000Z",
			exec: failingExec,
		}, services());
		assert.deepEqual(result.ok ? "ok" : result.code, "commit_failed");
		assert.equal((await git(root, "diff", "--cached", "--name-only")).trim(), "");
		assert.equal(await readFile(join(root, "reviewed.txt"), "utf8"), "reviewed change\n");
		assert.match(await git(root, "status", "--short"), /^ M reviewed\.txt$/m);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("failed checkpoint removes only tool-owned intent-to-add for reviewed untracked paths", async () => {
	const root = await repo();
	try {
		await writeFile(join(root, "new.txt"), "reviewed new file\n", "utf8");
		const failingExec: ExecFn = async (command, args, options) => {
			if (command === "git" && args[0] === "commit") {
				return { stdout: "", stderr: "hook refused", code: 1, killed: false };
			}
			return exec(command, args, options);
		};
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "feat: rejected untracked checkpoint",
			now: "2026-08-25T12:05:00.000Z",
			exec: failingExec,
		}, services({ paths: ["new.txt"] }));
		assert.deepEqual(result.ok ? "ok" : result.code, "commit_failed");
		assert.equal((await git(root, "diff", "--cached", "--name-only")).trim(), "");
		assert.match(await git(root, "status", "--short"), /^\?\? new\.txt$/m);
		assert.equal(await readFile(join(root, "new.txt"), "utf8"), "reviewed new file\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
