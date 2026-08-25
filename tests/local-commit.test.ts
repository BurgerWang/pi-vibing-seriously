import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const DELEGATION_ID = "20260825-120000-abcd";
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

function services(options: {
	paths?: string[];
	bindingStatus?: "fresh" | "conflict" | "unavailable";
} = {}): LocalReviewedCommitServicesV1 {
	const paths = options.paths ?? ["reviewed.txt"];
	return {
		readLatestTransaction: async () => ({
			ok: true,
			value: { delegation_id: DELEGATION_ID } as never,
		}),
		readAuthority: async () => ({
			kind: "v2",
			transactionStatus: "REVIEWED",
			transactionVerdict: null,
			review: { checked_paths: paths } as never,
			reviewPath: `.pi/workbench/delegations/${DELEGATION_ID}/v2/review.json`,
			finalized: true,
			semanticAccepted: true,
			semanticBindingHash: BINDING_HASH,
			semanticSource: "embedded",
			semanticReviewer: "openai-codex/gpt-5.6-sol",
			semanticAcceptedAt: "2026-08-25T12:00:00.000Z",
		}),
		collectBinding: async () => options.bindingStatus === "unavailable"
			? { status: "unavailable" }
			: options.bindingStatus === "conflict"
				? { status: "conflict", hash: "b".repeat(64), kind: "changeset-relevance-v2", code: "binding_conflict" }
				: { status: "fresh", hash: BINDING_HASH, kind: "changeset-relevance-v2" },
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
		assert.equal(result.remaining_changed_paths, 1);
		assert.equal(result.lock_release, "released");
		assert.equal((await git(root, "show", "--format=", "--name-only", "HEAD")).trim(), "reviewed.txt");
		assert.equal((await readFile(join(root, "unrelated.txt"), "utf8")), "unrelated change\n");
		assert.match(await git(root, "status", "--short"), /^ M unrelated\.txt$/m);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reviewed local commit rejects staged paths outside semantic authority", async () => {
	const root = await repo();
	try {
		await writeFile(join(root, "reviewed.txt"), "reviewed change\n", "utf8");
		await writeFile(join(root, "unrelated.txt"), "staged unrelated\n", "utf8");
		await git(root, "add", "--", "unrelated.txt");
		const before = (await git(root, "rev-parse", "HEAD")).trim();
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "feat: must not commit unrelated",
			now: "2026-08-25T12:02:00.000Z",
			exec,
		}, services());
		assert.deepEqual(result.ok ? "ok" : result.code, "staged_changes_present");
		assert.equal((await git(root, "rev-parse", "HEAD")).trim(), before);
		assert.equal((await git(root, "diff", "--cached", "--name-only")).trim(), "unrelated.txt");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reviewed local commit rejects stale semantic binding before staging", async () => {
	const root = await repo();
	try {
		await writeFile(join(root, "reviewed.txt"), "reviewed change\n", "utf8");
		const result = await commitLatestReviewedDelegationV1({
			project_root: root,
			message: "feat: stale authority",
			now: "2026-08-25T12:03:00.000Z",
			exec,
		}, services({ bindingStatus: "conflict" }));
		assert.deepEqual(result.ok ? "ok" : result.code, "binding_conflict");
		assert.equal((await git(root, "diff", "--cached", "--name-only")).trim(), "");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("failed Git commit restores paths staged by the tool without discarding worktree bytes", async () => {
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
