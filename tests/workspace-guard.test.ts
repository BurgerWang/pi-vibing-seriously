import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import {
	collectWorkspaceGuard,
	computeWorkspaceGuardHash,
	createNodeWorkspaceGuardStatAdapter,
	validateWorkspaceGuard,
	WORKSPACE_GUARD_FAULT_POINTS,
	type CollectWorkspaceGuardResult,
	type WorkspaceGuardErrorCode,
	type WorkspaceGuardFaultPoint,
	type WorkspaceGuardRecord,
	type WorkspaceGuardStatAdapter,
} from "../extensions/workbench-runtime/core/workspace-guard.ts";

const HEAD = "a".repeat(40);
const execFileAsync = promisify(execFile);

async function tempProject(): Promise<string> {
	return mkdtemp(join(tmpdir(), "workspace-guard-"));
}

async function cleanup(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}

interface StatusItem {
	status: string;
	path: string;
	original?: string;
}

function statusOutput(items: readonly StatusItem[]): string {
	let output = "";
	for (const item of items) {
		output += `${item.status} ${item.path}\0`;
		if (item.original !== undefined) output += `${item.original}\0`;
	}
	return output;
}

interface FakeExecOptions {
	headCode?: number;
	headStdout?: string;
	statusCode?: number;
	statusStdout?: string;
	killed?: boolean;
	throwOn?: "head" | "status";
	secret?: string;
}

function fakeExec(options: FakeExecOptions = {}, calls: string[][] = []): ExecFn {
	return async (command, args) => {
		calls.push([command, ...args]);
		const isHead = args[0] === "rev-parse";
		if (options.throwOn === (isHead ? "head" : "status")) throw new Error(options.secret ?? "private exec detail");
		return {
			code: isHead ? (options.headCode ?? 0) : (options.statusCode ?? 0),
			stdout: isHead ? (options.headStdout ?? `${HEAD}\n`) : (options.statusStdout ?? ""),
			stderr: options.secret ?? "",
			killed: options.killed ?? false,
		};
	};
}

const realGitExec: ExecFn = async (command, args, options) => {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options?.cwd,
			timeout: options?.timeout,
			signal: options?.signal,
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
		});
		return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
	} catch (error) {
		const failed = error as Error & { code?: number; stdout?: string; stderr?: string; killed?: boolean };
		return {
			stdout: failed.stdout ?? "",
			stderr: failed.stderr ?? "",
			code: typeof failed.code === "number" ? failed.code : 1,
			killed: failed.killed ?? false,
		};
	}
};

function success(result: CollectWorkspaceGuardResult): Readonly<WorkspaceGuardRecord> {
	assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
	if (!result.ok) throw new Error("expected workspace guard success");
	return result.guard;
}

function failure(result: CollectWorkspaceGuardResult, code: WorkspaceGuardErrorCode) {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected workspace guard failure");
	assert.equal(result.error.code, code);
	assert.ok(!("guard" in result), "failed collection cannot expose a partial guard");
	return result;
}

test("real Git positive path covers an unborn dirty repository and a committed clean repository", async () => {
	const root = await tempProject();
	try {
		assert.equal((await realGitExec("git", ["init", "-q"], { cwd: root })).code, 0);
		await writeFile(join(root, "real space-你好.txt"), "real-git-content");
		const unborn = success(await collectWorkspaceGuard({ project_root: root, exec: realGitExec }));
		assert.equal(unborn.git_head, null);
		assert.deepEqual(unborn.entries.map(({ path, status }) => ({ path, status })), [
			{ path: "real space-你好.txt", status: "??" },
		]);
		assert.equal(unborn.entries[0]?.identity.kind, "file");

		assert.equal((await realGitExec("git", ["add", "--", "real space-你好.txt"], { cwd: root })).code, 0);
		assert.equal((await realGitExec("git", [
			"-c", "user.name=Workspace Guard Test", "-c", "user.email=guard@example.invalid",
			"commit", "-q", "-m", "base",
		], { cwd: root })).code, 0);
		const clean = success(await collectWorkspaceGuard({ project_root: root, exec: realGitExec }));
		assert.match(clean.git_head ?? "", /^[0-9a-f]{40}$/u);
		assert.deepEqual(clean.entries, []);
		assert.equal(validateWorkspaceGuard(clean), true);
	} finally {
		await cleanup(root);
	}
});

test("clean and unborn repositories produce valid guards through exact argv-only git calls", async () => {
	const root = await tempProject();
	try {
		const calls: string[][] = [];
		const clean = success(await collectWorkspaceGuard({ project_root: root, exec: fakeExec({}, calls) }));
		assert.equal(clean.git_head, HEAD);
		assert.deepEqual(clean.entries, []);
		assert.deepEqual(clean.meter, {
			status_bytes: 0, relevant_paths: 0, irrelevant_paths: 0, stat_calls: 0, content_bytes_read: 0,
		});
		assert.equal(validateWorkspaceGuard(clean), true);
		assert.deepEqual(calls, [
			["git", "rev-parse", "HEAD"],
			["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
		]);

		const unborn = success(await collectWorkspaceGuard({
			project_root: root,
			exec: fakeExec({ headCode: 128, headStdout: "fatal text that is never retained" }),
		}));
		assert.equal(unborn.git_head, null);
		assert.equal(validateWorkspaceGuard(unborn), true);
		assert.ok(!JSON.stringify(unborn).includes("fatal text"));
	} finally {
		await cleanup(root);
	}
});

test("new, modified, deleted, spaced, Unicode, newline, file, directory, symlink, and missing paths use lstat identities", async () => {
	const root = await tempProject();
	try {
		await writeFile(join(root, "new file.txt"), "new-content-is-never-read");
		await writeFile(join(root, "你好.txt"), "unicode-content");
		await writeFile(join(root, "line\nbreak.txt"), "newline-name");
		await mkdir(join(root, "directory"));
		await symlink("new file.txt", join(root, "link"));
		const output = statusOutput([
			{ status: "??", path: "new file.txt" },
			{ status: " M", path: "你好.txt" },
			{ status: "A ", path: "line\nbreak.txt" },
			{ status: "??", path: "directory" },
			{ status: "??", path: "link" },
			{ status: " D", path: "deleted.txt" },
		]);
		const guard = success(await collectWorkspaceGuard({ project_root: root, exec: fakeExec({ statusStdout: output }) }));
		const kinds = Object.fromEntries(guard.entries.map((entry) => [entry.path, entry.identity.kind]));
		assert.deepEqual(kinds, {
			"deleted.txt": "missing",
			directory: "directory",
			"line\nbreak.txt": "file",
			link: "symlink",
			"new file.txt": "file",
			"你好.txt": "file",
		});
		assert.equal(guard.meter.stat_calls, 12);
		assert.equal(guard.meter.content_bytes_read, 0);
		assert.equal(JSON.stringify(guard).includes("new-content-is-never-read"), false);
		for (const entry of guard.entries) {
			if (entry.identity.kind !== "missing") {
				assert.match(entry.identity.stat.dev, /^\d+$/u);
				assert.match(entry.identity.stat.ino, /^\d+$/u);
				assert.ok(Number.isSafeInteger(entry.identity.byte_size));
			}
		}
	} finally {
		await cleanup(root);
	}
});

test("porcelain rename and copy two-path NUL records retain both paths and exact XY status", async () => {
	const root = await tempProject();
	try {
		const output = statusOutput([
			{ status: "R ", path: "new name.txt", original: "old name.txt" },
			{ status: " C", path: "复制-new.txt", original: "复制-old.txt" },
		]);
		const guard = success(await collectWorkspaceGuard({ project_root: root, exec: fakeExec({ statusStdout: output }) }));
		assert.deepEqual(guard.entries.map(({ path, status }) => ({ path, status })), [
			{ path: "new name.txt", status: "R " },
			{ path: "old name.txt", status: "R " },
			{ path: "复制-new.txt", status: " C" },
			{ path: "复制-old.txt", status: " C" },
		]);
		assert.equal(guard.entries.every((entry) => entry.identity.kind === "missing"), true);
	} finally {
		await cleanup(root);
	}
});

test("malformed, truncated, duplicate, nonzero, thrown, killed, and oversized status fail closed", async () => {
	const root = await tempProject();
	const secret = "RAW_GIT_SECRET_4815162342";
	try {
		for (const malformed of [
			"?? missing-nul",
			"? bad-status\0",
			"?? \0",
			"R  new-only\0",
			"?? ../escape\0",
			"?? slash\\path\0",
			statusOutput([{ status: "??", path: "same" }, { status: " M", path: "same" }]),
		]) {
			failure(await collectWorkspaceGuard({ project_root: root, exec: fakeExec({ statusStdout: malformed }) }), "invalid_path");
		}
		for (const options of [
			{ statusCode: 1, secret },
			{ throwOn: "status" as const, secret },
			{ killed: true, secret },
		]) {
			const result = failure(await collectWorkspaceGuard({ project_root: root, exec: fakeExec(options) }), "git_failure");
			assert.ok(!JSON.stringify(result).includes(secret));
		}
		const overflow = failure(await collectWorkspaceGuard({
			project_root: root,
			exec: fakeExec({ statusStdout: statusOutput([{ status: "??", path: "long.txt" }]) }),
			limits: { max_status_bytes: 3 },
		}), "status_overflow");
		assert.ok(overflow.meter.status_bytes > 3);
	} finally {
		await cleanup(root);
	}
});

test("pre/post lstat mutation and stat failures are closed and never publish identities", async () => {
	const root = await tempProject();
	try {
		await writeFile(join(root, "mutable.txt"), "before");
		const node = createNodeWorkspaceGuardStatAdapter();
		let calls = 0;
		const mutating: WorkspaceGuardStatAdapter = {
			async lstat(path) {
				calls += 1;
				if (calls === 2) await writeFile(path, "after-is-a-different-size");
				return node.lstat(path);
			},
		};
		const output = statusOutput([{ status: " M", path: "mutable.txt" }]);
		failure(await collectWorkspaceGuard({
			project_root: root, exec: fakeExec({ statusStdout: output }), stat_adapter: mutating,
		}), "unstable");

		const broken: WorkspaceGuardStatAdapter = { async lstat() { throw new Error("private stat path"); } };
		const failed = failure(await collectWorkspaceGuard({
			project_root: root, exec: fakeExec({ statusStdout: output }), stat_adapter: broken,
		}), "stat_failure");
		assert.ok(!JSON.stringify(failed).includes("private stat path"));
		assert.equal(failed.meter.stat_calls, 1);
	} finally {
		await cleanup(root);
	}
});

test("control artifacts are separately bounded and cannot change the guard hash; sibling names remain relevant", async () => {
	const root = await tempProject();
	try {
		const common = [
			{ status: "??", path: "src/live.ts" },
			{ status: "??", path: ".pi/workbench/runs-sibling/kept.json" },
			{ status: "??", path: ".pi/workbench/delegation-start.lock-extra" },
		] as const;
		const first = success(await collectWorkspaceGuard({
			project_root: root,
			exec: fakeExec({ statusStdout: statusOutput([
				...common,
				{ status: "??", path: ".pi/workbench/runs/one/report.json" },
				{ status: "??", path: ".pi/workbench/delegations/d1/log.json" },
				{ status: "??", path: ".pi/workbench/delegation-start.lock" },
				{ status: "??", path: `.pi/workbench/delegation-start.lock.candidate.${"a".repeat(32)}` },
			]) }),
		}));
		const second = success(await collectWorkspaceGuard({
			project_root: root,
			exec: fakeExec({ statusStdout: statusOutput([
				...common,
				{ status: "??", path: ".pi/workbench/tool-results/t2/result.json" },
				{ status: "??", path: `.pi/workbench/delegation-start.lock.release.${"b".repeat(32)}` },
			]) }),
		}));
		assert.deepEqual(first.entries.map((entry) => entry.path), [
			".pi/workbench/delegation-start.lock-extra", ".pi/workbench/runs-sibling/kept.json", "src/live.ts",
		]);
		assert.deepEqual(first.irrelevant_artifact_paths, [
			`.pi/workbench/delegation-start.lock`,
			`.pi/workbench/delegation-start.lock.candidate.${"a".repeat(32)}`,
			".pi/workbench/delegations/d1/log.json",
			".pi/workbench/runs/one/report.json",
		]);
		assert.notDeepEqual(first.irrelevant_artifact_paths, second.irrelevant_artifact_paths);
		assert.equal(first.workspace_guard_hash, second.workspace_guard_hash);
		assert.equal(first.meter.stat_calls, 6, "irrelevant artifact paths are never stated");
	} finally {
		await cleanup(root);
	}
});

test("generated Python cache bytecode is non-authoritative while source-like siblings and legacy guards remain valid", async () => {
	const root = await tempProject();
	try {
		const pyc = "src/pkg/__pycache__/module.cpython-314.pyc";
		const relevantPaths = ["src/pkg/__pycache__/module.py", "src/pkg/module.pyc"];
		const collected = success(await collectWorkspaceGuard({
			project_root: root,
			exec: fakeExec({ statusStdout: statusOutput([
				{ status: "??", path: pyc },
				...relevantPaths.map((path) => ({ status: "??", path })),
			]) }),
		}));
		assert.deepEqual(collected.entries.map((entry) => entry.path), relevantPaths);
		assert.deepEqual(collected.irrelevant_artifact_paths, [pyc]);
		assert.equal(validateWorkspaceGuard(collected), true);

		const legacyEntry = {
			path: pyc,
			status: "??",
			identity: { kind: "missing" as const },
		};
		const legacyEntries = [...collected.entries, legacyEntry].sort((left, right) =>
			Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")));
		const legacy = {
			...collected,
			entries: legacyEntries,
			irrelevant_artifact_paths: [],
			meter: {
				...collected.meter,
				relevant_paths: legacyEntries.length,
				irrelevant_paths: 0,
				stat_calls: legacyEntries.length * 2,
			},
			workspace_guard_hash: computeWorkspaceGuardHash(collected.git_head, legacyEntries),
		};
		assert.equal(validateWorkspaceGuard(legacy), true, "pre-classification guards stay readable");
	} finally {
		await cleanup(root);
	}
});

test("workspace guard hash is canonical across object key insertion order without mutating inputs", () => {
	const canonicalEntries = [{
		path: "src/live.ts",
		status: " M",
		identity: {
			kind: "file" as const,
			byte_size: 7,
			stat: { dev: "1", ino: "2", mtime_ns: "3", ctime_ns: "4" },
		},
	}];
	const reorderedEntries = [{
		identity: {
			stat: { ctime_ns: "4", mtime_ns: "3", ino: "2", dev: "1" },
			byte_size: 7,
			kind: "file" as const,
		},
		status: " M",
		path: "src/live.ts",
	}];
	const canonicalBefore = structuredClone(canonicalEntries);
	const reorderedBefore = structuredClone(reorderedEntries);
	const canonicalHash = computeWorkspaceGuardHash(HEAD, canonicalEntries);
	const reorderedHash = computeWorkspaceGuardHash(HEAD, reorderedEntries);
	assert.equal(reorderedHash, canonicalHash);
	assert.deepEqual(canonicalEntries, canonicalBefore);
	assert.deepEqual(reorderedEntries, reorderedBefore);

	const canonicalGuard = {
		schema_version: 2 as const,
		git_head: HEAD,
		entries: canonicalEntries,
		irrelevant_artifact_paths: [],
		meter: {
			status_bytes: 14,
			relevant_paths: 1,
			irrelevant_paths: 0,
			stat_calls: 2,
			content_bytes_read: 0 as const,
		},
		workspace_guard_hash: canonicalHash,
	};
	const reorderedGuard = {
		workspace_guard_hash: reorderedHash,
		meter: {
			content_bytes_read: 0 as const,
			stat_calls: 2,
			irrelevant_paths: 0,
			relevant_paths: 1,
			status_bytes: 14,
		},
		irrelevant_artifact_paths: [],
		entries: reorderedEntries,
		git_head: HEAD,
		schema_version: 2 as const,
	};
	assert.equal(validateWorkspaceGuard(canonicalGuard), true);
	assert.equal(validateWorkspaceGuard(reorderedGuard), true);

	const changedEntries = [
		[{ ...canonicalEntries[0]!, path: "src/other.ts" }],
		[{ ...canonicalEntries[0]!, status: "M " }],
		[{ ...canonicalEntries[0]!, identity: { ...canonicalEntries[0]!.identity, byte_size: 8 } }],
		[{
			...canonicalEntries[0]!,
			identity: {
				...canonicalEntries[0]!.identity,
				stat: { ...canonicalEntries[0]!.identity.stat, dev: "5" },
			},
		}],
	];
	for (const entries of changedEntries) {
		assert.notEqual(computeWorkspaceGuardHash(HEAD, entries), canonicalHash);
		assert.equal(validateWorkspaceGuard({ ...canonicalGuard, entries }), false);
	}
});

test("relevant and irrelevant caps accept 500 and reject 501 without truncation", async () => {
	const root = await tempProject();
	const missing: WorkspaceGuardStatAdapter = { async lstat() { return null; } };
	try {
		const relevant500 = Array.from({ length: 500 }, (_, index) => ({
			status: "??", path: `src/p-${String(index).padStart(3, "0")}.ts`,
		}));
		const acceptedRelevant = success(await collectWorkspaceGuard({
			project_root: root,
			exec: fakeExec({ statusStdout: statusOutput(relevant500) }),
			stat_adapter: missing,
		}));
		assert.equal(acceptedRelevant.entries.length, 500);
		assert.equal(acceptedRelevant.meter.stat_calls, 1000);
		failure(await collectWorkspaceGuard({
			project_root: root,
			exec: fakeExec({ statusStdout: statusOutput([...relevant500, { status: "??", path: "src/overflow.ts" }]) }),
			stat_adapter: missing,
		}), "path_overflow");

		const irrelevant500 = Array.from({ length: 500 }, (_, index) => ({
			status: "??", path: `.pi/workbench/runs/r-${String(index).padStart(3, "0")}/out.json`,
		}));
		const acceptedIrrelevant = success(await collectWorkspaceGuard({
			project_root: root,
			exec: fakeExec({ statusStdout: statusOutput(irrelevant500) }),
			stat_adapter: { async lstat() { throw new Error("irrelevant path was stated"); } },
		}));
		assert.equal(acceptedIrrelevant.irrelevant_artifact_paths.length, 500);
		assert.equal(acceptedIrrelevant.meter.stat_calls, 0);
		failure(await collectWorkspaceGuard({
			project_root: root,
			exec: fakeExec({ statusStdout: statusOutput([
				...irrelevant500,
				{ status: "??", path: ".pi/workbench/tool-results/overflow/out.json" },
			]) }),
		}), "path_overflow");
	} finally {
		await cleanup(root);
	}
});

test("strict validator rejects unknown fields, versions, order, duplicates, stat, meter, hash, and lowered-limit violations", async () => {
	const root = await tempProject();
	try {
		const guard = success(await collectWorkspaceGuard({
			project_root: root,
			exec: fakeExec({ statusStdout: statusOutput([
				{ status: "??", path: "a.txt" }, { status: "??", path: "b.txt" },
			]) }),
		}));
		assert.equal(validateWorkspaceGuard(guard), true);
		const tamper = (change: (copy: any) => void): unknown => {
			const copy = structuredClone(guard) as any;
			change(copy);
			return copy;
		};
		for (const changed of [
			tamper((copy) => { copy.extra = true; }),
			tamper((copy) => { copy.schema_version = 1; }),
			tamper((copy) => { copy.entries.reverse(); }),
			tamper((copy) => { copy.entries[1].path = copy.entries[0].path; }),
			tamper((copy) => { copy.entries[0].status = "XX"; }),
			tamper((copy) => { copy.entries[0].identity = { kind: "file", byte_size: 0, stat: { dev: "01", ino: "1", mtime_ns: "1", ctime_ns: "1" } }; }),
			tamper((copy) => { copy.meter.content_bytes_read = 1; }),
			tamper((copy) => { copy.meter.stat_calls -= 1; }),
			tamper((copy) => { copy.workspace_guard_hash = "0".repeat(64); }),
		]) assert.equal(validateWorkspaceGuard(changed), false);
		assert.equal(validateWorkspaceGuard(guard, { max_relevant_paths: 1 }), false);
		assert.equal(validateWorkspaceGuard(guard, { max_path_bytes: 3 }), false);
		assert.equal(validateWorkspaceGuard(guard, { max_relevant_paths: 501 }), false);
		assert.equal(validateWorkspaceGuard(guard, { max_relevant_paths: 2, unknown: 1 } as any), false);
	} finally {
		await cleanup(root);
	}
});

const FAULT_CODES: Readonly<Record<WorkspaceGuardFaultPoint, WorkspaceGuardErrorCode>> = Object.freeze({
	head_before: "git_failure",
	head_after: "git_failure",
	status_before: "git_failure",
	status_after: "git_failure",
	stat_before: "stat_failure",
	stat_after: "stat_failure",
});

test("every deterministic head, status, and pre/post stat fault point returns its bounded code", async () => {
	const root = await tempProject();
	const secret = "FAULT_SECRET_2718281828";
	try {
		assert.deepEqual(Object.keys(FAULT_CODES).sort(), [...WORKSPACE_GUARD_FAULT_POINTS].sort());
		for (const point of WORKSPACE_GUARD_FAULT_POINTS) {
			const result = failure(await collectWorkspaceGuard({
				project_root: root,
				exec: fakeExec({ statusStdout: statusOutput([{ status: "??", path: "one.txt" }]) }),
				hooks: { fault(candidate) { if (candidate === point) throw new Error(secret); } },
			}), FAULT_CODES[point]);
			const rendered = JSON.stringify(result);
			assert.ok(rendered.length < 400);
			assert.ok(!rendered.includes(secret));
		}
	} finally {
		await cleanup(root);
	}
});

test("collector is deterministic, does not mutate inputs, enforces lower path limits, and keeps errors secret", async () => {
	const root = await tempProject();
	const secret = "DO_NOT_LEAK_GIT_STDERR_314159";
	try {
		const limits = { max_relevant_paths: 4, max_irrelevant_paths: 4, max_status_bytes: 100, max_path_bytes: 20 } as const;
		const input = { project_root: root, exec: fakeExec({ statusStdout: statusOutput([{ status: "??", path: "same.txt" }]) }), limits };
		const before = { ...limits };
		const first = success(await collectWorkspaceGuard(input));
		const second = success(await collectWorkspaceGuard(input));
		assert.deepEqual(limits, before);
		assert.deepEqual(first, second);
		assert.equal(first.workspace_guard_hash, computeWorkspaceGuardHash(first.git_head, first.entries));

		failure(await collectWorkspaceGuard({
			project_root: root,
			exec: fakeExec({ statusStdout: statusOutput([{ status: "??", path: "path-is-longer-than-10" }]) }),
			limits: { max_path_bytes: 10 },
		}), "invalid_path");
		const thrown = failure(await collectWorkspaceGuard({
			project_root: root,
			exec: fakeExec({ throwOn: "head", secret }),
		}), "git_failure");
		assert.ok(!JSON.stringify(thrown).includes(secret));
	} finally {
		await cleanup(root);
	}
});
