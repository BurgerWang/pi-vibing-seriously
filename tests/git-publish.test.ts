import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { pushCurrentBranchV1 } from "../extensions/workbench-runtime/core/git-publish.ts";

const execFileAsync = promisify(execFile);

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
	return result.stdout.trim();
}

async function repoWithRemote(): Promise<{ root: string; remote: string; head: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-git-publish-work-"));
	const remote = await mkdtemp(join(tmpdir(), "pi-git-publish-remote-"));
	await git(remote, "init", "--bare", "-b", "main");
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Workbench Test");
	await git(root, "config", "user.email", "workbench@example.invalid");
	await writeFile(join(root, "file.txt"), "published\n", "utf8");
	await git(root, "add", "--", "file.txt");
	await git(root, "commit", "-m", "initial");
	await git(root, "remote", "add", "origin", remote);
	return { root, remote, head: await git(root, "rev-parse", "HEAD") };
}

test("exact-HEAD publication pushes only the current named branch and verifies the remote ref", async () => {
	const fixture = await repoWithRemote();
	try {
		const calls: string[][] = [];
		const recordingExec: ExecFn = async (command, args, options) => {
			if (command === "git") calls.push([...args]);
			return exec(command, args, options);
		};
		const result = await pushCurrentBranchV1({
			project_root: fixture.root,
			expected_head: fixture.head,
			exec: recordingExec,
		});
		assert.deepEqual(result, {
			ok: true,
			commit: fixture.head,
			branch: "main",
			remote: "origin",
			upstream: "origin/main",
			verification: "remote_head_exact",
		});
		const push = calls.find((args) => args[0] === "push");
		assert.deepEqual(push, ["push", "--porcelain", "--set-upstream", "origin", "HEAD:refs/heads/main"]);
		assert.equal(calls.flat().some((arg) => arg === "--force" || arg === "-f" || arg.startsWith("--force-with-lease")), false);
		assert.equal(await git(fixture.remote, "rev-parse", "refs/heads/main"), fixture.head);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
		await rm(fixture.remote, { recursive: true, force: true });
	}
});

test("publication rejects a stale expected HEAD before contacting the remote", async () => {
	const fixture = await repoWithRemote();
	try {
		let remoteCalls = 0;
		const guardedExec: ExecFn = async (command, args, options) => {
			if (command === "git" && (args[0] === "push" || args[0] === "ls-remote" || args[0] === "remote")) remoteCalls += 1;
			return exec(command, args, options);
		};
		const result = await pushCurrentBranchV1({
			project_root: fixture.root,
			expected_head: "f".repeat(40),
			exec: guardedExec,
		});
		assert.deepEqual(result.ok ? "ok" : result.code, "head_changed");
		assert.equal(remoteCalls, 0);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
		await rm(fixture.remote, { recursive: true, force: true });
	}
});

test("publication rejects remote-name injection before Git execution", async () => {
	let calls = 0;
	const result = await pushCurrentBranchV1({
		project_root: "/tmp/project",
		expected_head: "a".repeat(40),
		remote: "--delete",
		exec: async () => {
			calls += 1;
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	});
	assert.deepEqual(result.ok ? "ok" : result.code, "invalid_input");
	assert.equal(calls, 0);
});
