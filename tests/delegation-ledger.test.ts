/**
 * P7 delegation-ledger tests (core/delegation-ledger.ts).
 *
 * Real git repos in temp dirs; every git call goes through the shared
 * argv-only spawn helper (shell=false), exactly like the runtime's execFn.
 * Coverage: bounded git facts (HEAD/dirty/per-path digests incl. untracked
 * files and new directories), ledger-dir self-exclusion, digest-based
 * change detection for already-dirty paths, the atomic five-artifact ledger
 * layout (manifest/before/after/worker-summary + review by the review
 * service), PENDING_REVIEW on success AND failure, contract bounding,
 * redaction, and strict id/path validation.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { spawnExec, withTempDir } from "./helpers.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import {
	changedSinceBefore,
	collectAfterFacts,
	collectGitFacts,
	computeDiffHash,
	contentDigest,
	createDelegationLedger,
	delegationDirFor,
	delegationReportPath,
	delegationsDir,
	DELEGATION_RECORD_MAX_BYTES,
	digestFromPrefix,
	finishDelegationLedger,
	isDelegationRecordPath,
	isToolResultReceiptPath,
	isValidDelegationId,
	makeDelegationId,
	normalizeStatusPath,
	parsePorcelainPath,
	parseReportedPaths,
	readDelegationLedger,
	MAX_CHANGED_PATHS,
	MAX_DIGEST_BYTES,
	MAX_REPORTED_PATHS_SCAN_CHARS,
	type GitFacts,
	type LedgerWorkerFacts,
} from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import {
	MAX_WORKER_REPORT_BYTES,
	WORKER_REPORT_TRUNCATION_MARKER,
} from "../extensions/workbench-runtime/worker/handoff.ts";
import { resolveWorkerRepairOf } from "../extensions/workbench-runtime/core/worker-policy.ts";

const NOW = "2026-06-01T12:00:00.000Z";

async function git(repo: string, args: string[]): Promise<void> {
	const result = await spawnExec("git", args, { cwd: repo });
	assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

async function initRepo(dir: string): Promise<void> {
	await git(dir, ["init", "-q"]);
	await git(dir, ["config", "user.email", "test@example.com"]);
	await git(dir, ["config", "user.name", "Workbench Test"]);
	await git(dir, ["config", "commit.gpgsign", "false"]);
}

async function commitAll(dir: string, message: string): Promise<void> {
	await git(dir, ["add", "-A"]);
	await git(dir, ["commit", "-q", "-m", message]);
}

/** Repo with a committed README.md; the working tree is clean afterwards. */
async function cleanRepo(dir: string): Promise<void> {
	await initRepo(dir);
	await writeFile(join(dir, "README.md"), "hello\n", "utf8");
	await commitAll(dir, "init");
}

function workerFacts(overrides: Partial<LedgerWorkerFacts> = {}): LedgerWorkerFacts {
	return {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		status: "success",
		exitCode: 0,
		turns: 3,
		stopReason: "done",
		errorMessage: null,
		usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 1050, cost: { input: 0.001, output: 0.002, cacheRead: 0.0005, cacheWrite: 0, total: 0.0035 } },
		cacheHitRatio: 900 / 1000,
		budget: { maxContextTokens: 400_000, maxContextRatio: 0.4, softBudgetReached: false, hardBudgetExceeded: false, compactionCount: 0, compactionReasons: [] },
		// Phase 3: the runner's cumulative spend facts (the canonical spend
		// object persisted into usage.json / worker-summary.json derives from
		// these). Defaults stay consistent with turns 3 / totalTokens 1050 /
		// output 50 above.
		spendProfile: "standard",
		spendState: { turns: 3, totalTokens: 1050, outputTokens: 50 },
		spendBand: "ok",
		spendReasons: [],
		spendSoftReached: { turns: false, totalTokens: false, outputTokens: false },
		spendHardExceeded: { turns: false, totalTokens: false, outputTokens: false },
		reportSummary: "Implemented the slice with tests and docs. My secret token is abc-secret-123.",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// ids and path helpers
// ---------------------------------------------------------------------------

test("delegation ids share the run-id shape and are validated strictly", () => {
	const id = makeDelegationId(new Date("2026-06-01T12:00:00Z"));
	assert.match(id, /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/);
	assert.ok(isValidDelegationId(id));
	assert.equal(isValidDelegationId("20260601-120000-abcd"), true);
	assert.equal(isValidDelegationId("../../etc/passwd"), false);
	assert.equal(isValidDelegationId("20260601-120000-abcd/extra"), false);
	assert.equal(isValidDelegationId("20260601-120000"), false);
	assert.equal(isValidDelegationId(""), false);
});

test("normalizeStatusPath refuses absolute, drive and escaping paths", () => {
	assert.equal(normalizeStatusPath("src/main.ts"), "src/main.ts");
	assert.equal(normalizeStatusPath("src\\main.ts"), "src/main.ts");
	assert.equal(normalizeStatusPath("a/./b/"), "a/b");
	assert.equal(normalizeStatusPath("/abs/path"), undefined);
	assert.equal(normalizeStatusPath("\\abs\\path"), undefined);
	assert.equal(normalizeStatusPath("C:\\repo\\src.ts"), undefined);
	assert.equal(normalizeStatusPath("C:notes.md"), undefined);
	assert.equal(normalizeStatusPath("a/../b"), undefined);
	assert.equal(normalizeStatusPath(".."), undefined);
	assert.equal(normalizeStatusPath(""), undefined);
});

test("parsePorcelainPath decodes Git C-quoted UTF-8 bytes and rejects malformed encodings", () => {
	assert.equal(parsePorcelainPath('?? "\\344\\270\\255\\346\\226\\207.txt"'), "中文.txt");
	assert.equal(parsePorcelainPath('?? "tab\\tbackslash\\\\quote\\\".txt"'), 'tab\tbackslash\\quote".txt');
	assert.equal(parsePorcelainPath('R  "old\\342\\230\\203.txt" -> "new\\344\\270\\255.txt"'), "new中.txt");
	assert.equal(parsePorcelainPath("R  old.ts -> new.ts"), "new.ts", "ASCII rename behavior is preserved");
	assert.equal(parsePorcelainPath('?? "ordinary -> name.txt"'), "ordinary -> name.txt", "an ordinary path arrow is not a rename separator");

	assert.equal(parsePorcelainPath('?? "bad\\q.txt"'), undefined, "unknown escapes are rejected");
	assert.equal(parsePorcelainPath('?? "bad\\37.txt"'), undefined, "incomplete octal escapes are rejected");
	assert.equal(parsePorcelainPath('?? "\\777.txt"'), undefined, "octal values beyond one byte are rejected");
	assert.equal(parsePorcelainPath('?? "\\377.txt"'), undefined, "invalid UTF-8 bytes are rejected");
	assert.equal(parsePorcelainPath('R  "bad\\q.txt" -> good.txt'), undefined, "a malformed rename source rejects the whole record");
});

test("the ledger's own directory is recognized and never a project change", async () => {
	await withTempDir(async (dir) => {
		assert.equal(isDelegationRecordPath(dir, `${CONFIG_DIR_NAME}/workbench/delegations/x/manifest.json`), true);
		assert.equal(isDelegationRecordPath(dir, `${CONFIG_DIR_NAME}/workbench/delegations`), true);
		assert.equal(isDelegationRecordPath(dir, `${CONFIG_DIR_NAME}/workbench/runs/x.json`), false);
		assert.equal(isDelegationRecordPath(dir, "src/main.ts"), false);
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		// Write ledger records into the delegation directory…
		const ledgerDir = join(dir, CONFIG_DIR_NAME, "workbench", "delegations", "20260601-120000-abcd");
		await mkdir(ledgerDir, { recursive: true });
		await writeFile(join(ledgerDir, "manifest.json"), "{}", "utf8");
		await writeFile(join(ledgerDir, "before.json"), "{}", "utf8");
		// …and the git facts must be identical (self-exclusion).
		const after = await collectGitFacts(dir, spawnExec);
		assert.deepEqual(after, before);
	});
});

// ---------------------------------------------------------------------------
// git facts
// ---------------------------------------------------------------------------

test("collectGitFacts records HEAD, dirty state and per-path digests (tracked + untracked in new dirs)", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const clean = await collectGitFacts(dir, spawnExec);
		assert.match(clean.gitHead ?? "", /^[0-9a-f]{40}$/);
		assert.equal(clean.gitDirty, false);
		assert.deepEqual(clean.changedPaths, []);
		assert.deepEqual(clean.pathDigests, {});

		await writeFile(join(dir, "README.md"), "changed\n", "utf8");
		await mkdir(join(dir, "src", "nested"), { recursive: true });
		await writeFile(join(dir, "src", "nested", "new.ts"), "x\n", "utf8");
		const dirty = await collectGitFacts(dir, spawnExec);
		assert.equal(dirty.gitDirty, true);
		// --untracked-files=all: every untracked file is listed individually.
		assert.deepEqual(dirty.changedPaths, ["README.md", "src/nested/new.ts"]);
		assert.match(dirty.pathDigests["README.md"] ?? "", /^[0-9a-f]{64}$/);
		assert.match(dirty.pathDigests["src/nested/new.ts"] ?? "", /^[0-9a-f]{64}$/);
	});
});

test("collectGitFacts decodes and sorts real Git C-quoted Unicode paths without escaped literal leakage", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const names = ["文档.txt", "中文.txt", "éclair.txt"];
		for (const name of names) await writeFile(join(dir, name), `${name}\n`, "utf8");

		const rawStatus = await spawnExec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir });
		assert.equal(rawStatus.code, 0);
		assert.match(rawStatus.stdout, /\\[0-7]{3}/, "fixture exercises Git's actual octal C quoting");

		const facts = await collectGitFacts(dir, spawnExec);
		assert.deepEqual(facts.changedPaths, [...names].sort(), "decoded Unicode paths retain deterministic path ordering");
		assert.deepEqual(Object.keys(facts.pathStatuses).sort(), [...names].sort());
		assert.ok(facts.changedPaths.every((path) => !path.includes("\\")), "no octal escape literal leaks into changed paths");
		assert.ok(Object.keys(facts.pathDigests).every((path) => names.includes(path)), "digests are keyed by decoded filesystem paths");
		for (const name of names) {
			assert.equal(facts.pathStatuses[name], "??");
			assert.match(facts.pathDigests[name] ?? "", /^[0-9a-f]{64}$/);
		}
	});
});

test("collectGitFacts rejects an undecodable quoted status path instead of omitting it", async () => {
	await withTempDir(async (dir) => {
		const invalidStatusExec: ExecFn = async (command, args) => {
			if (command === "git" && args[0] === "rev-parse") {
				return { stdout: "a".repeat(40), stderr: "", code: 0, killed: false };
			}
			if (command === "git" && args[0] === "status") {
				return { stdout: '?? "\\377.txt"\n', stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		await assert.rejects(
			collectGitFacts(dir, invalidStatusExec),
			/git status --porcelain returned an invalid or undecodable path/,
		);
	});
});

test("collectGitFacts fails closed: a thrown or non-zero git status rejects — never an empty clean-tree fact set", async () => {
	await withTempDir(async (dir) => {
		const makeFakeExec = (statusMode: "throw" | "nonzero"): ExecFn => {
			return async (command, args) => {
				// rev-parse HEAD behaves (tolerant path — never the failure).
				if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
					return { stdout: "a".repeat(40), stderr: "", code: 0, killed: false };
				}
				if (command === "git" && args[0] === "status") {
					if (statusMode === "throw") throw new Error("git status exploded");
					return { stdout: "", stderr: "fatal: not a git repository", code: 128, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			};
		};
		// Thrown exec failure rejects.
		await assert.rejects(collectGitFacts(dir, makeFakeExec("throw")), /git status --porcelain failed/);
		// Non-zero exit rejects with the exit code surfaced.
		await assert.rejects(collectGitFacts(dir, makeFakeExec("nonzero")), /git status --porcelain failed \(exit 128\)/);
	});
});

test("collectGitFacts fails closed on changed-path overflow: more than MAX_CHANGED_PATHS never yields a truncated fact set", async () => {
	await withTempDir(async (dir) => {
		// Fake git status reporting MAX_CHANGED_PATHS + 1 distinct non-ledger
		// changed paths: collection must REJECT — a silently truncated path
		// set could let diff hashing and scope review PASS on a partial diff.
		const paths = Array.from({ length: MAX_CHANGED_PATHS + 1 }, (_, i) => `src/file-${i}.ts`);
		const makeExec = (statusLines: string[]): ExecFn => {
			return async (command, args) => {
				if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
					return { stdout: "a".repeat(40), stderr: "", code: 0, killed: false };
				}
				if (command === "git" && args[0] === "status") {
					return { stdout: statusLines.join("\n"), stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			};
		};
		// One path beyond the cap rejects with a clear bounded error.
		await assert.rejects(
			collectGitFacts(dir, makeExec(paths.map((p) => ` M ${p}`))),
			/more than \d+ changed paths; refusing to record a truncated diff/,
			"overflow rejects instead of returning a truncated fact set",
		);
		// Exactly MAX_CHANGED_PATHS distinct non-ledger paths still collect
		// normally (behavior below the limit is unchanged).
		const atLimit = await collectGitFacts(dir, makeExec(paths.slice(0, MAX_CHANGED_PATHS).map((p) => ` M ${p}`)));
		assert.equal(atLimit.changedPaths.length, MAX_CHANGED_PATHS);
		assert.equal(atLimit.gitDirty, true);
		assert.equal(Object.keys(atLimit.pathStatuses).length, MAX_CHANGED_PATHS);
		// Ledger-dir records are excluded BEFORE the cap: thousands of
		// delegation records beyond the bound never trigger refusal.
		const ledgerLines = Array.from(
			{ length: 3000 },
			(_, i) => `?? ${CONFIG_DIR_NAME}/workbench/delegations/20260601-120000-${String(i).padStart(4, "0")}/manifest.json`,
		);
		const facts = await collectGitFacts(
			dir,
			makeExec([...ledgerLines, ...paths.slice(0, MAX_CHANGED_PATHS).map((p) => `?? ${p}`)]),
		);
		assert.equal(facts.changedPaths.length, MAX_CHANGED_PATHS, "ledger records are excluded, never counted toward the cap");
		assert.ok(facts.changedPaths.every((p) => !isDelegationRecordPath(dir, p)), "no ledger record ever lands in the fact set");
	});
});

test("collectGitFacts excludes P8b tool-result receipts exactly (sibling-safe), before the cap, statuses and digests", async () => {
	await withTempDir(async (dir) => {
		const makeExec = (statusLines: string[]): ExecFn => {
			return async (command, args) => {
				if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
					return { stdout: "a".repeat(40), stderr: "", code: 0, killed: false };
				}
				if (command === "git" && args[0] === "status") {
					return { stdout: statusLines.join("\n"), stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			};
		};
		// The predicate itself is sibling-safe: only the exact receipts
		// subtree (and the directory itself) matches — never the
		// `tool-results-extra` sibling prefix nor other workbench subtrees.
		assert.equal(isToolResultReceiptPath(dir, `${CONFIG_DIR_NAME}/workbench/tool-results`), true);
		assert.equal(isToolResultReceiptPath(dir, `${CONFIG_DIR_NAME}/workbench/tool-results/x.json`), true);
		assert.equal(isToolResultReceiptPath(dir, `${CONFIG_DIR_NAME}/workbench/tool-results/sub/dir/y.json`), true);
		assert.equal(isToolResultReceiptPath(dir, `${CONFIG_DIR_NAME}/workbench/tool-results-extra/x.json`), false);
		assert.equal(isToolResultReceiptPath(dir, `${CONFIG_DIR_NAME}/workbench/other/x.json`), false);
		assert.equal(isToolResultReceiptPath(dir, `${CONFIG_DIR_NAME}/workbench/runs/x.json`), false);
		assert.equal(isToolResultReceiptPath(dir, "src/main.ts"), false);

		// A flood of receipt porcelain lines (beyond the cap alone) plus
		// exactly MAX_CHANGED_PATHS ordinary paths: receipts are excluded
		// BEFORE the cap — like delegation records — so the ordinary paths
		// stay complete and no receipt ever enters changedPaths/statuses/
		// digests (and thus never any diff-hash input).
		const receipts = Array.from(
			{ length: 3000 },
			(_, i) => `?? ${CONFIG_DIR_NAME}/workbench/tool-results/20260601-120000-${String(i).padStart(4, "0")}.json`,
		);
		const ordinary = Array.from({ length: MAX_CHANGED_PATHS }, (_, i) => ` M src/regular-${i}.ts`);
		const facts = await collectGitFacts(dir, makeExec([...receipts, ...ordinary]));
		assert.equal(facts.changedPaths.length, MAX_CHANGED_PATHS, "receipts are excluded before the cap — ordinary paths stay complete");
		assert.ok(facts.changedPaths.every((p) => p.startsWith("src/regular-")), "no receipt path ever lands in the changed path set");
		assert.equal(Object.keys(facts.pathStatuses).length, MAX_CHANGED_PATHS, "no receipt path ever lands in the status map");
		assert.ok(Object.keys(facts.pathStatuses).every((p) => p.startsWith("src/regular-")));
		assert.ok(Object.keys(facts.pathDigests).every((p) => !isToolResultReceiptPath(dir, p)), "no receipt path ever lands in the digest map");
		assert.equal(facts.gitDirty, true);

		// The exclusion is exact: a nested receipt descendant is still
		// excluded, while the `tool-results-extra` sibling prefix and other
		// workbench subtrees stay fully visible with their statuses.
		const siblingFacts = await collectGitFacts(
			dir,
			makeExec([
				`?? ${CONFIG_DIR_NAME}/workbench/tool-results/x.json`,
				`?? ${CONFIG_DIR_NAME}/workbench/tool-results/sub/dir/y.json`,
				`?? ${CONFIG_DIR_NAME}/workbench/tool-results-extra/x.json`,
				`?? ${CONFIG_DIR_NAME}/workbench/other/x.json`,
				" M README.md",
			]),
		);
		assert.deepEqual(siblingFacts.changedPaths, [
			`${CONFIG_DIR_NAME}/workbench/other/x.json`,
			`${CONFIG_DIR_NAME}/workbench/tool-results-extra/x.json`,
			"README.md",
		]);
		assert.ok(siblingFacts.pathStatuses[`${CONFIG_DIR_NAME}/workbench/tool-results-extra/x.json`], "sibling-prefix path keeps its porcelain status");
		assert.ok(siblingFacts.pathStatuses[`${CONFIG_DIR_NAME}/workbench/other/x.json`], "other workbench paths keep their porcelain status");
	});
});

test("collectGitFacts tolerates rev-parse failure on an unborn repository when git status succeeds", async () => {
	await withTempDir(async (dir) => {
		await git(dir, ["init", "-q"]);
		const facts = await collectGitFacts(dir, spawnExec);
		assert.equal(facts.gitHead, null, "unborn repository has no HEAD commit yet");
		assert.equal(facts.gitDirty, false, "an unborn repo with no changes is a legitimate clean fact set");
		assert.deepEqual(facts.changedPaths, []);
	});
});

test("collectAfterFacts rejects when the current git facts cannot be collected (fail closed)", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const failing: ExecFn = async (command, args) => {
			if (command === "git" && args[0] === "status") throw new Error("status unavailable");
			return { stdout: "", stderr: "", code: 0, killed: false };
		};
		await assert.rejects(collectAfterFacts(dir, before, failing), /git status --porcelain failed/);
	});
});

test("contentDigest is a bounded prefix hash with a size suffix beyond MAX_DIGEST_BYTES", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "small.txt"), "abc", "utf8");
		assert.match((await contentDigest(dir, "small.txt")) ?? "", /^[0-9a-f]{64}$/);
		const big = Buffer.alloc(MAX_DIGEST_BYTES + 1, 0x61);
		await writeFile(join(dir, "big.txt"), big, "utf8");
		const digest = await contentDigest(dir, "big.txt");
		assert.match(digest ?? "", /^[0-9a-f]{64}:\d+$/, "oversized files carry the size suffix");
		assert.equal(digest, digestFromPrefix(big.subarray(0, MAX_DIGEST_BYTES), big.length));
		// Missing / unreadable paths have no digest.
		assert.equal(await contentDigest(dir, "missing.txt"), undefined);
	});
});

test("computeDiffHash is deterministic and sensitive to content, path sets and status codes", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const a = await collectGitFacts(dir, spawnExec);
		const h1 = computeDiffHash(a.changedPaths, a.pathDigests, a.pathStatuses);
		assert.equal(computeDiffHash(a.changedPaths, a.pathDigests, a.pathStatuses), h1);
		assert.equal(computeDiffHash([...a.changedPaths].reverse(), a.pathDigests, a.pathStatuses), h1, "path order never changes the hash");
		await writeFile(join(dir, "README.md"), "v2\n", "utf8");
		const b = await collectGitFacts(dir, spawnExec);
		assert.notEqual(computeDiffHash(b.changedPaths, b.pathDigests, b.pathStatuses), h1, "content change changes the hash");
		// Same path + same digest but a different porcelain status (staged vs
		// unstaged) changes the hash — status codes are part of the diff state.
		await git(dir, ["add", "README.md"]);
		const staged = await collectGitFacts(dir, spawnExec);
		assert.equal(staged.pathDigests["README.md"], b.pathDigests["README.md"], "digest unchanged by staging");
		assert.notEqual(staged.pathStatuses["README.md"], b.pathStatuses["README.md"], "porcelain status changed by staging");
		assert.notEqual(
			computeDiffHash(staged.changedPaths, staged.pathDigests, staged.pathStatuses),
			computeDiffHash(b.changedPaths, b.pathDigests, b.pathStatuses),
			"status transition changes the hash",
		);
	});
});

test("changedSinceBefore detects new, deleted and digest-moved paths — including already-dirty paths", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		await writeFile(join(dir, "README.md"), "dirty v1\n", "utf8");
		await writeFile(join(dir, "notes.md"), "n\n", "utf8");
		const before = await collectGitFacts(dir, spawnExec);
		// The worker changes the already-dirty file, deletes notes.md and adds a new file.
		await writeFile(join(dir, "README.md"), "dirty v2\n", "utf8");
		await writeFile(join(dir, "src.ts"), "s\n", "utf8");
		await writeFile(join(dir, "notes.md"), "n\n", "utf8");
		const after = await collectGitFacts(dir, spawnExec);
		const changed = changedSinceBefore(before, after);
		assert.deepEqual(changed, ["README.md", "src.ts"], "digest-moved + new paths; notes.md unchanged content is NOT a change");
		// Deleting a path is a change even when the digest vanishes.
		await rm(join(dir, "notes.md"));
		const afterDelete = await collectGitFacts(dir, spawnExec);
		const changed2 = changedSinceBefore(before, afterDelete);
		assert.ok(changed2.includes("notes.md"), "deleted paths are changes");
	});
});

// ---------------------------------------------------------------------------
// ledger lifecycle
// ---------------------------------------------------------------------------

test("createDelegationLedger writes atomic bounded manifest + before records", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		const created = await createDelegationLedger(
			dir,
			id,
			{
				task: "Implement the parser slice",
				allowedPaths: ["src/**", "tests/parser.test.ts"],
				acceptanceCriteria: ["Unit tests cover the new option", "Docs describe the new option"],
				verification: ["Run the unit-test recipe"],
				timeoutSeconds: 900,
			},
			before,
			NOW,
		);
		assert.ok(created.ok, created.ok ? "" : created.error);
		const dirPath = delegationDirFor(dir, id);
		assert.equal(created.ok && created.dir, dirPath);
		const manifest = JSON.parse(await readFile(join(dirPath, "manifest.json"), "utf8")) as Record<string, unknown>;
		assert.equal(manifest.status, "running");
		assert.equal(manifest.review_status, "PENDING_REVIEW");
		assert.equal(manifest.delegation_id, id);
		assert.equal(manifest.git_head_before, before.gitHead);
		assert.equal(manifest.git_dirty_before, before.gitDirty);
		assert.equal(manifest.diff_hash_before, computeDiffHash(before.changedPaths, before.pathDigests, before.pathStatuses));
		const beforeRecord = JSON.parse(await readFile(join(dirPath, "before.json"), "utf8")) as {
			contract: { task: string; allowed_paths: string[]; acceptance_criteria: string[]; verification: string[]; timeout_seconds: number; budget_profile?: string };
		};
		assert.equal(beforeRecord.contract.task, "Implement the parser slice");
		assert.deepEqual(beforeRecord.contract.allowed_paths, ["src/**", "tests/parser.test.ts"]);
		assert.deepEqual(beforeRecord.contract.acceptance_criteria, ["Unit tests cover the new option", "Docs describe the new option"]);
		assert.deepEqual(beforeRecord.contract.verification, ["Run the unit-test recipe"]);
		assert.equal(beforeRecord.contract.timeout_seconds, 900);
		assert.ok("budget_profile" in beforeRecord.contract, "new before records ALWAYS carry the resolved budget_profile");
		assert.equal(beforeRecord.contract.budget_profile, "extended", "omitted budget_profile resolves deterministically to extended in the before contract");
		// Atomic bounded writes: mode 0600 on the records.
		const st = await stat(join(dirPath, "manifest.json"));
		assert.equal(st.mode & 0o777, 0o600);
	});
});

test("createDelegationLedger refuses invalid ids and unbounded contracts", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const contract = { task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 };
		assert.equal((await createDelegationLedger(dir, "bad/id!", contract, before, NOW)).ok, false);
		assert.equal((await createDelegationLedger(dir, makeDelegationId(new Date()), { ...contract, task: "" }, before, NOW)).ok, false);
		assert.equal((await createDelegationLedger(dir, makeDelegationId(new Date()), { ...contract, task: "   " }, before, NOW)).ok, false);
		assert.equal((await createDelegationLedger(dir, makeDelegationId(new Date()), { ...contract, allowedPaths: [] }, before, NOW)).ok, false);
		// Contract bounding: overlong task is truncated, not refused; path rules are capped.
		const id = makeDelegationId(new Date());
		const bounded = await createDelegationLedger(
			dir,
			id,
			{
				task: "x".repeat(20_000),
				allowedPaths: Array.from({ length: 80 }, (_, i) => `src/file-${i}.ts`),
				acceptanceCriteria: Array.from({ length: 40 }, (_, i) => `criterion ${i}`),
				verification: Array.from({ length: 40 }, (_, i) => `step ${i}`),
				timeoutSeconds: 12345,
			},
			before,
			NOW,
		);
		assert.ok(bounded.ok);
		const record = JSON.parse(await readFile(join(delegationDirFor(dir, id), "before.json"), "utf8")) as {
			contract: { task: string; allowed_paths: string[]; acceptance_criteria: string[]; verification: string[]; timeout_seconds: number };
		};
		assert.equal(record.contract.task.length, 10_000, "task bounded to MAX_TASK_CHARS");
		assert.equal(record.contract.allowed_paths.length, 50, "allowed paths capped at 50");
		assert.equal(record.contract.acceptance_criteria.length, 20, "acceptance criteria capped at 20");
		assert.equal(record.contract.verification.length, 20, "verification steps capped at 20");
		assert.equal(record.contract.timeout_seconds, 1800, "invalid timeout falls back to the default");
	});
});

// ---------------------------------------------------------------------------
// Phase 3: budget profile in the before contract + canonical spend records
// (worker token-budget repair)
// ---------------------------------------------------------------------------

test("the before contract records the explicit budget profile and rejects invalid ones before creating anything", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		const created = await createDelegationLedger(
			dir,
			id,
			{ task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800, budgetProfile: "extended" },
			before,
			NOW,
		);
		assert.ok(created.ok, created.ok ? "" : created.error);
		const record = JSON.parse(await readFile(join(delegationDirFor(dir, id), "before.json"), "utf8")) as { contract: { budget_profile: string } };
		assert.equal(record.contract.budget_profile, "extended", "the resolved profile is persisted in the before contract");

		// Unknown/empty/wrong-type profiles fail closed BEFORE any ledger
		// record exists (boundLedgerContract refuses without writing).
		for (const bad of ["", "low", "LOW", "Standard", "ultra", null, 42, true, {}] as unknown[]) {
			const refused = await createDelegationLedger(
				dir,
				makeDelegationId(new Date()),
				{ task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800, budgetProfile: bad as never },
				before,
				NOW,
			);
			assert.equal(refused.ok, false, `${JSON.stringify(bad)} must fail closed before ledger creation`);
			if (!refused.ok) assert.match(refused.error, /budget_profile must be one of "standard" \| "extended"/);
		}
	});
});

test("usage.json and worker-summary.json persist the exact canonical spend object (schema_version stays 1; after.json carries none)", async () => {
	await withTempDir(async (dir) => {
		const { id } = await finishedDelegation(dir);
		const dirPath = delegationDirFor(dir, id);
		const expected = {
			profile: "standard",
			turns: 3,
			totalTokens: 1050,
			outputTokens: 50,
			band: "ok",
			softReached: { turns: false, totalTokens: false, outputTokens: false },
			hardExceeded: { turns: false, totalTokens: false, outputTokens: false },
			reasons: [],
		};
		const usage = JSON.parse(await readFile(join(dirPath, "usage.json"), "utf8")) as { spend: unknown; schema_version: number };
		assert.deepEqual(usage.spend, expected, "usage.json carries the exact canonical spend object");
		assert.equal(usage.schema_version, 1, "schema_version stays 1 (additive only)");
		const summary = JSON.parse(await readFile(join(dirPath, "worker-summary.json"), "utf8")) as { spend: unknown; schema_version: number };
		assert.deepEqual(summary.spend, expected, "worker-summary.json carries the SAME canonical spend object");
		assert.equal(summary.schema_version, 1);
		// after.json deliberately carries no spend — usage.json /
		// worker-summary.json are its records (single-derivation rule).
		const after = JSON.parse(await readFile(join(dirPath, "after.json"), "utf8")) as { spend?: unknown };
		assert.ok(!("spend" in after), "after.json has no spend object");
	});
});

test("hard spend failures are ledgered as failure with the spend hard flags/reasons and the dimension-named error", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		const created = await createDelegationLedger(
			dir,
			id,
			{ task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800, budgetProfile: "standard" },
			before,
			NOW,
		);
		assert.ok(created.ok);
		const after = await collectAfterFacts(dir, before, spawnExec);
		const finished = await finishDelegationLedger(dir, id, {
			after,
			worker: workerFacts({
				status: "failure",
				exitCode: 1,
				errorMessage: "Worker cumulative spend hard budget reached (profile standard): turns 64/64.",
				spendState: { turns: 64, totalTokens: 10_879_999, outputTokens: 319_999 },
				spendBand: "hard",
				spendReasons: ["turns"],
				spendSoftReached: { turns: true, totalTokens: false, outputTokens: false },
				spendHardExceeded: { turns: true, totalTokens: false, outputTokens: false },
			}),
			secrets: [],
			now: NOW,
		});
		assert.ok(finished.ok, finished.ok ? "" : finished.error);
		const ledger = await readDelegationLedger(dir, id);
		assert.ok(ledger && ledger.after && ledger.workerSummary);
		assert.equal(ledger.after.status, "failure");
		assert.match(ledger.workerSummary.error_message ?? "", /hard budget reached/);
		assert.deepEqual(ledger.workerSummary.spend, {
			profile: "standard",
			turns: 64,
			totalTokens: 10_879_999,
			outputTokens: 319_999,
			band: "hard",
			softReached: { turns: true, totalTokens: false, outputTokens: false },
			hardExceeded: { turns: true, totalTokens: false, outputTokens: false },
			reasons: ["turns"],
		}, "the failure record carries the spend hard flags and the fixed-order reasons");
		assert.equal(ledger.after.review_status, "PENDING_REVIEW");
	});
});

test("legacy-shaped worker facts (no spend facts) keep the pre-repair record shape: readable, no spend key, no rewrite", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		await createDelegationLedger(dir, id, { task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 }, before, NOW);
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "parser.ts"), "v1\n", "utf8");
		const after = await collectAfterFacts(dir, before, spawnExec);
		// Old-style caller: no spend facts at all.
		const { spendProfile: _spendProfile, spendState: _spendState, spendBand: _spendBand, spendReasons: _spendReasons, spendSoftReached: _spendSoftReached, spendHardExceeded: _spendHardExceeded, ...legacyWorker } = workerFacts();
		const finished = await finishDelegationLedger(dir, id, { after, worker: legacyWorker, secrets: [], now: NOW });
		assert.ok(finished.ok, finished.ok ? "" : finished.error);
		const dirPath = delegationDirFor(dir, id);
		for (const file of ["usage.json", "worker-summary.json"]) {
			const record = JSON.parse(await readFile(join(dirPath, file), "utf8")) as Record<string, unknown>;
			assert.equal(record.schema_version, 1);
			assert.ok(!("spend" in record), `${file} keeps the pre-repair shape when the caller omits spend facts`);
		}
		const ledger = await readDelegationLedger(dir, id);
		assert.ok(ledger && ledger.workerSummary, "the legacy-shaped ledger remains readable");
		assert.ok(!("spend" in ledger.workerSummary));
	});
});

test("synthetic pre-repair schema_version 1 records without budget_profile/spend/repair_of read successfully and are not rewritten", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		const created = await createDelegationLedger(dir, id, { task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 }, before, NOW);
		assert.ok(created.ok);
		const dirPath = delegationDirFor(dir, id);
		// Strip the new additive field from the before contract to recreate
		// the exact pre-repair shape (schema_version stays 1).
		const beforeRecord = JSON.parse(await readFile(join(dirPath, "before.json"), "utf8")) as { contract: Record<string, unknown> };
		assert.equal(beforeRecord.contract.budget_profile, "extended");
		delete beforeRecord.contract.budget_profile;
		await writeFile(join(dirPath, "before.json"), `${JSON.stringify(beforeRecord, null, 2)}\n`, "utf8");
		// Finish normally, then strip spend from both records to recreate the
		// pre-repair usage/worker-summary shapes.
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "parser.ts"), "v1\n", "utf8");
		const after = await collectAfterFacts(dir, before, spawnExec);
		const finished = await finishDelegationLedger(dir, id, { after, worker: workerFacts(), secrets: [], now: NOW });
		assert.ok(finished.ok);
		for (const file of ["usage.json", "worker-summary.json"]) {
			const record = JSON.parse(await readFile(join(dirPath, file), "utf8")) as Record<string, unknown>;
			assert.equal(record.schema_version, 1);
			delete record.spend;
			await writeFile(join(dirPath, file), `${JSON.stringify(record, null, 2)}\n`, "utf8");
		}
		// Reading succeeds without migration — the optional fields are simply
		// absent, and the files are never rewritten by the read.
		const ledger = await readDelegationLedger(dir, id);
		assert.ok(ledger, "pre-repair records remain readable");
		assert.ok(ledger.workerSummary);
		assert.ok(!("spend" in ledger.workerSummary), "no spend on the pre-repair summary record");
		assert.ok(!("budget_profile" in (ledger.before.contract as Record<string, unknown>)), "no budget_profile on the pre-repair before contract");
		assert.equal(
			(ledger.before.contract as { budget_profile?: string }).budget_profile,
			undefined,
			"the pre-repair before contract exposes budget_profile as undefined (optional field, never defaulted on read)",
		);
		assert.ok(!("repair_of" in (ledger.before.contract as Record<string, unknown>)), "no repair_of on the pre-repair before contract");
		assert.equal(
			(ledger.before.contract as { repair_of?: string }).repair_of,
			undefined,
			"the pre-repair before contract exposes repair_of as undefined (optional field, never defaulted on read)",
		);
		const usageRaw = await readFile(join(dirPath, "usage.json"), "utf8");
		assert.ok(!usageRaw.includes('"spend"'), "the pre-repair usage.json is not rewritten");
		const beforeRaw = await readFile(join(dirPath, "before.json"), "utf8");
		assert.ok(!beforeRaw.includes("budget_profile"), "the pre-repair before.json is not rewritten");
		assert.ok(!beforeRaw.includes("repair_of"), "the pre-repair before.json is never rewritten with repair_of");
	});
});

test("historical schema_version 1 low records remain read-only compatible", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		const created = await createDelegationLedger(
			dir,
			id,
			{ task: "historical", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 },
			before,
			NOW,
		);
		assert.ok(created.ok);
		const beforePath = join(delegationDirFor(dir, id), "before.json");
		const record = JSON.parse(await readFile(beforePath, "utf8")) as { contract: { budget_profile: string } };
		record.contract.budget_profile = "low";
		const historicalBytes = `${JSON.stringify(record, null, 2)}\n`;
		await writeFile(beforePath, historicalBytes, "utf8");
		const ledger = await readDelegationLedger(dir, id);
		assert.equal(ledger?.before.contract.budget_profile, "low");
		assert.equal(await readFile(beforePath, "utf8"), historicalBytes, "historical low is read without migration");
	});
});

// ---------------------------------------------------------------------------
// Phase 4A: repair-provenance pointer persisted in the before contract
// (worker repair contract — strict fail-closed validation, exact id)
// ---------------------------------------------------------------------------

test("ordinary creates omit repair_of entirely; a valid repair id persists exactly", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const contract = { task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 };

		// Ordinary create: no repairOf — the before contract must not carry
		// the own property at all (additive key, spread conditionally).
		const ordinaryId = makeDelegationId(new Date());
		const created = await createDelegationLedger(dir, ordinaryId, contract, before, NOW);
		assert.ok(created.ok, created.ok ? "" : created.error);
		const ordinary = JSON.parse(await readFile(join(delegationDirFor(dir, ordinaryId), "before.json"), "utf8")) as {
			contract: Record<string, unknown>;
		};
		assert.ok(!("repair_of" in ordinary.contract), "ordinary creates omit the own property repair_of");

		// Explicit valid repair id: persisted EXACTLY as supplied.
		const repairedId = makeDelegationId(new Date());
		const repaired = await createDelegationLedger(dir, repairedId, { ...contract, repairOf: "20250101-120000-abcd" }, before, NOW);
		assert.ok(repaired.ok, repaired.ok ? "" : repaired.error);
		const repairRecord = JSON.parse(await readFile(join(delegationDirFor(dir, repairedId), "before.json"), "utf8")) as {
			contract: { repair_of?: string };
		};
		assert.equal(repairRecord.contract.repair_of, "20250101-120000-abcd", "the exact repair id is persisted");
	});
});

test("malformed repair_of values fail closed before any delegation directory or file exists", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const contract = { task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 };
		// Padded, traversal, wrong separators, short/empty strings, and
		// non-string values (null/number/object/array via the typed escape)
		// all fail closed before any ledger record exists.
		const badValues: unknown[] = [
			" 20250101-120000-abcd",
			"20250101-120000-abcd ",
			"20250101-120000-abcd\n",
			"../../etc/passwd",
			"20250101-120000-abcd/extra",
			"2025/01/01-120000-abcd",
			"20250101_120000_abcd",
			"20250101-120000",
			"",
			null,
			42,
			{ repairOf: "20250101-120000-abcd" },
			["20250101-120000-abcd"],
		];
		for (const bad of badValues) {
			const result = await createDelegationLedger(dir, makeDelegationId(new Date()), { ...contract, repairOf: bad as never }, before, NOW);
			assert.equal(result.ok, false, `${JSON.stringify(bad)} must fail closed before ledger creation`);
			if (!result.ok) assert.match(result.error, /repair_of must be a valid 20-character delegation id/);
		}
		// Fail-closed semantics: not one delegation directory (nor any file)
		// exists — the delegations root itself was never created.
		await assert.rejects(readdir(delegationsDir(dir)), /ENOENT/, "no delegation directory or files are created");
	});
});

test("resolveWorkerRepairOf and isValidDelegationId agree on representative id strings", () => {
	// Both validators share the exact run-id shape (YYYYMMDD-HHMMSS-XXXX);
	// for every string input the repair resolver's boolean MUST equal the
	// ledger id validator — one strict rule, two enforcement points.
	const ids = [
		"20250101-120000-abcd",
		"20260601-120000-ABCD",
		"20250101-120000-9aZ0",
		"",
		"20250101-120000",
		"20250101-120000-abcd/extra",
		"../../etc/passwd",
		" 20250101-120000-abcd",
		"20250101-120000-abcd ",
		"2025/01/01-120000-abcd",
		"20250101_120000_abcd",
		"20250101-120000-ab!d",
	];
	for (const id of ids) {
		assert.equal(
			resolveWorkerRepairOf(id).ok,
			isValidDelegationId(id),
			`repair-of acceptance agrees with the ledger id validator on ${JSON.stringify(id)}`,
		);
	}
});

test("finishDelegationLedger records success with true changed paths, after hash, usage/budget and PENDING_REVIEW", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		await mkdir(join(dir, "src"));
		await writeFile(join(dir, "src", "main.ts"), "v1\n", "utf8");
		await commitAll(dir, "base");
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		const created = await createDelegationLedger(dir, id, { task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 }, before, NOW);
		assert.ok(created.ok);

		// The worker modifies an in-scope file and creates a new one.
		await writeFile(join(dir, "src", "main.ts"), "v2\n", "utf8");
		await writeFile(join(dir, "src", "new.ts"), "n\n", "utf8");
		const after = await collectAfterFacts(dir, before, spawnExec);
		const finished = await finishDelegationLedger(dir, id, { after, worker: workerFacts(), secrets: ["abc-secret-123"], now: NOW });
		assert.ok(finished.ok, finished.ok ? "" : finished.error);

		const ledger = await readDelegationLedger(dir, id);
		assert.ok(ledger);
		assert.equal(ledger.manifest.status, "finished");
		assert.equal(ledger.manifest.review_status, "PENDING_REVIEW");
		assert.equal(ledger.manifest.finished_at, NOW);
		assert.equal(ledger.manifest.diff_hash_after, after.diffHash);
		assert.equal(ledger.manifest.changed_path_count_after, 2);
		assert.equal(ledger.manifest.changed_since_before_count, 2);
		assert.ok(ledger.after);
		assert.equal(ledger.after.status, "success");
		assert.equal(ledger.after.exit_code, 0);
		assert.equal(ledger.after.review_status, "PENDING_REVIEW");
		assert.deepEqual(ledger.after.changed_since_before, ["src/main.ts", "src/new.ts"]);
		assert.equal(ledger.after.diff_hash, after.diffHash);
		assert.equal(ledger.after.pinned_identity.pinned_provider, "deepseek");
		assert.equal(ledger.after.pinned_identity.pinned_model, "deepseek-v4-flash");
		assert.equal(ledger.after.usage.totalTokens, 1050);
		assert.equal(ledger.after.budget.maxContextTokens, 400_000);
		assert.ok(ledger.workerSummary);
		assert.equal(ledger.workerSummary.turns, 3);
		assert.equal(ledger.workerSummary.stop_reason, "done");
		assert.equal(ledger.workerSummary.cache_hit_ratio, 0.9);
		assert.deepEqual(ledger.workerSummary.changed_paths, ["src/main.ts", "src/new.ts"], "summary changed_paths are the ACTUAL digest-based paths, never prose");
		assert.ok(ledger.workerSummary.report_path.startsWith(".pi/workbench/delegations/"), "summary carries the project-relative report path");
		assert.ok(ledger.workerSummary.report_path.endsWith("/worker-report.md"));
		// Secrets are scrubbed from every recorded summary.
		assert.ok(!ledger.after.report_summary.includes("abc-secret-123"));
		assert.ok(!ledger.workerSummary.report_summary.includes("abc-secret-123"));
	});
});

test("report summaries are bounded (after capped below the worker summary)", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		await createDelegationLedger(dir, id, { task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 }, before, NOW);
		const after = await collectAfterFacts(dir, before, spawnExec);
		const longReport = "Implementing the slice with tests and docs. ".repeat(1200);
		const finished = await finishDelegationLedger(dir, id, { after, worker: workerFacts({ reportSummary: longReport }), secrets: [], now: NOW });
		assert.ok(finished.ok);
		const ledger = await readDelegationLedger(dir, id);
		assert.ok(ledger && ledger.after && ledger.workerSummary);
		assert.equal(ledger.workerSummary.report_summary.length, 8000, "worker summary bounded to MAX_REPORT_SUMMARY_CHARS");
		assert.equal(ledger.after.report_summary.length, 2000, "after summary bounded to MAX_AFTER_SUMMARY_CHARS");
		assert.ok(ledger.after.report_summary.length < ledger.workerSummary.report_summary.length);
	});
});

test("finishDelegationLedger records FAILURE with PENDING_REVIEW (no fallback, no auto-retry)", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		const created = await createDelegationLedger(dir, id, { task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 }, before, NOW);
		assert.ok(created.ok);
		const after = await collectAfterFacts(dir, before, spawnExec);
		const finished = await finishDelegationLedger(
			dir,
			id,
			{
				after,
				worker: workerFacts({
					status: "failure",
					exitCode: 1,
					turns: 2,
					errorMessage: "worker exceeded hard budget — fail closed",
					reportSummary: "could not finish",
				}),
				secrets: [],
				now: NOW,
			},
		);
		assert.ok(finished.ok);
		const ledger = await readDelegationLedger(dir, id);
		assert.ok(ledger && ledger.after);
		assert.equal(ledger.after.status, "failure");
		assert.equal(ledger.after.exit_code, 1);
		assert.equal(ledger.after.review_status, "PENDING_REVIEW");
		assert.equal(ledger.manifest.status, "finished");
		assert.equal(ledger.workerSummary?.error_message, "worker exceeded hard budget — fail closed");
	});
});

test("readDelegationLedger returns null for invalid ids, missing or corrupt records", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		assert.equal(await readDelegationLedger(dir, "not-an-id"), null);
		assert.equal(await readDelegationLedger(dir, "20260601-120000-abcd"), null, "missing records are null");
		// A ledger without after.json (still running) is readable with after=null.
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		await createDelegationLedger(dir, id, { task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 }, before, NOW);
		const running = await readDelegationLedger(dir, id);
		assert.ok(running);
		assert.equal(running.after, null);
		assert.equal(running.workerSummary, null);
		// Corruption (bad JSON) is null.
		await writeFile(join(delegationDirFor(dir, id), "manifest.json"), "{not json", "utf8");
		assert.equal(await readDelegationLedger(dir, id), null);
	});
});

test("delegation authority JSON reads reject oversized/non-regular records before allocation", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		await createDelegationLedger(dir, id, { task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 }, before, NOW);
		assert.ok(await readDelegationLedger(dir, id), "normal bounded ledger remains readable");
		const manifestPath = join(delegationDirFor(dir, id), "manifest.json");
		const original = await readFile(manifestPath, "utf8");

		await writeFile(manifestPath, "x".repeat(DELEGATION_RECORD_MAX_BYTES + 1), "utf8");
		const oversizedAllocations: number[] = [];
		assert.equal(await readDelegationLedger(dir, id, { onBufferAllocate: (bytes) => oversizedAllocations.push(bytes) }), null);
		assert.deepEqual(oversizedAllocations, [], "oversized manifest is rejected before Buffer allocation");

		await rm(manifestPath);
		await mkdir(manifestPath);
		const nonRegularAllocations: number[] = [];
		assert.equal(await readDelegationLedger(dir, id, { onBufferAllocate: (bytes) => nonRegularAllocations.push(bytes) }), null);
		assert.deepEqual(nonRegularAllocations, [], "non-regular manifest is rejected before Buffer allocation");

		await rm(manifestPath, { recursive: true });
		await writeFile(manifestPath, "{not-json", "utf8");
		const corruptAllocations: number[] = [];
		assert.equal(await readDelegationLedger(dir, id, { onBufferAllocate: (bytes) => corruptAllocations.push(bytes) }), null);
		assert.deepEqual(corruptAllocations, [Buffer.byteLength("{not-json")], "corrupt manifest stops before any later authority record is allocated");

		const wrongDelegationId = id === "20260601-120000-abcd" ? "20260601-120000-abce" : "20260601-120000-abcd";
		const wrongManifest = `${JSON.stringify({ ...(JSON.parse(original) as object), delegation_id: wrongDelegationId })}\n`;
		await writeFile(manifestPath, wrongManifest, "utf8");
		const mismatchedAllocations: number[] = [];
		assert.equal(await readDelegationLedger(dir, id, { onBufferAllocate: (bytes) => mismatchedAllocations.push(bytes) }), null);
		assert.deepEqual(mismatchedAllocations, [Buffer.byteLength(wrongManifest)], "mismatched manifest identity stops before before.json is allocated");

		await writeFile(manifestPath, original, "utf8");
		assert.ok(await readDelegationLedger(dir, id), "restored normal record remains compatible");

		const beforePath = join(delegationDirFor(dir, id), "before.json");
		await writeFile(join(delegationDirFor(dir, id), "after.json"), JSON.stringify({ delegation_id: id }), "utf8");
		await writeFile(join(delegationDirFor(dir, id), "worker-summary.json"), JSON.stringify({ delegation_id: id }), "utf8");
		await writeFile(beforePath, "{not-json", "utf8");
		const invalidBeforeAllocations: number[] = [];
		assert.equal(await readDelegationLedger(dir, id, { onBufferAllocate: (bytes) => invalidBeforeAllocations.push(bytes) }), null);
		assert.deepEqual(
			invalidBeforeAllocations,
			[Buffer.byteLength(original), Buffer.byteLength("{not-json")],
			"invalid before record stops before optional after/worker-summary records are allocated",
		);
	});
});

test("before/after records carry per-path porcelain statuses and the five-file layout exists at finish", async () => {
	await withTempDir(async (dir) => {
		await cleanRepo(dir);
		await mkdir(join(dir, "src"));
		await writeFile(join(dir, "src", "main.ts"), "v1\n", "utf8");
		await commitAll(dir, "base");
		// A preexisting dirty path and the worker target are both dirty
		// (unstaged) BEFORE the delegation starts.
		await writeFile(join(dir, "README.md"), "dirty\n", "utf8");
		await writeFile(join(dir, "src", "main.ts"), "v2\n", "utf8");
		const before = await collectGitFacts(dir, spawnExec);
		assert.equal(before.pathStatuses["README.md"], " M");
		assert.equal(before.pathStatuses["src/main.ts"], " M");
		const id = makeDelegationId(new Date());
		const created = await createDelegationLedger(dir, id, { task: "t", allowedPaths: ["src/**", "README.md"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 }, before, NOW);
		assert.ok(created.ok, created.ok ? "" : created.error);
		const beforeRecord = JSON.parse(await readFile(join(delegationDirFor(dir, id), "before.json"), "utf8")) as { path_statuses: Record<string, string> };
		assert.equal(beforeRecord.path_statuses["README.md"], " M", "before record carries the porcelain status");

		// The worker only STAGES its already-modified file: same content,
		// different porcelain status (" M" → "M ") — a true change.
		await git(dir, ["add", "src/main.ts"]);
		const after = await collectAfterFacts(dir, before, spawnExec);
		assert.deepEqual(after.changedSinceBefore, ["src/main.ts"], "status-only transition counts; untouched preexisting dirty path does not");
		const finished = await finishDelegationLedger(
			dir,
			id,
			{
				after,
				worker: workerFacts({ reportSummary: "## Completed\nslice done\n## Files Changed\n- src/main.ts\n## Verification\nrun unit-test\n## Remaining Risks\nnone" }),
				secrets: [],
				now: NOW,
			},
		);
		assert.ok(finished.ok, finished.ok ? "" : finished.error);

		// Seven ledger files exist immediately after every outcome, including
		// the review.json PENDING_REVIEW placeholder and the bounded durable
		// artifacts worker-report.md + usage.json (atomic writes leave no
		// temp files behind).
		const dirPath = delegationDirFor(dir, id);
		const files = (await readdir(dirPath)).sort();
		assert.deepEqual(
			files,
			["after.json", "before.json", "manifest.json", "review.json", "usage.json", "worker-report.md", "worker-summary.json"],
			"seven-file ledger layout at finish",
		);
		const review = JSON.parse(await readFile(join(dirPath, "review.json"), "utf8")) as { review_status: string; delegation_id: string };
		assert.equal(review.review_status, "PENDING_REVIEW");
		assert.equal(review.delegation_id, id);
		// The durable redacted report artifact is persisted with the full
		// four-section text (worker prose, never parsed into paths).
		const report = await readFile(join(dirPath, "worker-report.md"), "utf8");
		assert.ok(report.includes("## Files Changed"), "complete final report text persisted");
		assert.ok(report.includes("slice done"));

		const afterRecord = JSON.parse(await readFile(join(dirPath, "after.json"), "utf8")) as {
			path_statuses: Record<string, string>;
			reported_paths: string[];
			changed_since_before: string[];
		};
		assert.equal(afterRecord.path_statuses["src/main.ts"], "M ", "after record carries the staged porcelain status");
		assert.equal(afterRecord.path_statuses["README.md"], " M");
		assert.deepEqual(afterRecord.reported_paths, ["src/main.ts"], "reported_paths parsed from the ## Files Changed section");
		assert.deepEqual(afterRecord.changed_since_before, ["src/main.ts"]);
	});
});

test("parseReportedPaths extracts only safe project-relative paths from the ## Files Changed section", () => {
	assert.deepEqual(
		parseReportedPaths(
			[
				"## Completed",
				"done",
				"## Files Changed",
				"- extensions/workbench-runtime/core/delegation-ledger.ts",
				"* `tests/delegation-ledger.test.ts`",
				"+ README.md",
				"../escape.ts",
				"/abs/path.ts",
				"C:\\win.ts",
				"",
				"## Verification",
				"ran unit-test",
			].join("\n"),
		),
		["README.md", "extensions/workbench-runtime/core/delegation-ledger.ts", "tests/delegation-ledger.test.ts"],
		"bullet markers, backticks and backslash separators normalize; unsafe entries are dropped",
	);
	assert.deepEqual(parseReportedPaths("no section here"), []);
	assert.deepEqual(parseReportedPaths("## Files Changed\n- only/../unsafe"), []);
	// The MAX_CHANGED_PATHS cap is the binding bound when the whole section
	// fits inside the explicit scan window (700 short entries ≈ 6.9 KB <
	// MAX_REPORTED_PATHS_SCAN_CHARS).
	const many = Array.from({ length: 700 }, (_, i) => `- f${i}.ts`).join("\n");
	assert.equal(parseReportedPaths(`## Files Changed\n${many}`).length, MAX_CHANGED_PATHS, "capped at MAX_CHANGED_PATHS when the section fits the scan window");
	// The scan window equals the durable report artifact bound
	// (MAX_WORKER_REPORT_BYTES): 700 realistic entries (~13 KB) fit inside
	// it, so the MAX_CHANGED_PATHS cap binds — never a partial path set.
	const realistic = Array.from({ length: 700 }, (_, i) => `- src/file-${i}.ts`).join("\n");
	const windowed = parseReportedPaths(`## Files Changed\n${realistic}`);
	assert.equal(windowed.length, MAX_CHANGED_PATHS, "the MAX_CHANGED_PATHS cap binds when the section fits the scan window");
	// A section larger than the window (padding beyond the 512 KiB artifact
	// bound) is cut at the window and never reads past it; a line cut by the
	// window is dropped, never partially reported.
	const padLine = "- ".padEnd(MAX_REPORTED_PATHS_SCAN_CHARS, "p");
	const windowCut = parseReportedPaths(`## Files Changed\n${padLine}\n- src/a.ts`);
	assert.ok(windowCut.length <= MAX_CHANGED_PATHS);
	assert.ok(!windowCut.includes("src/a.ts"), "a line beyond the window is never reported");
	// A final line cut by the scan window is dropped — a partial path like
	// "b.t" is never fabricated. (The pad line is overlong, so it is dropped
	// by MAX_PATH_LENGTH; the boundary then cuts "- b.ts" mid-line.)
	const cutReport = "## Files Changed\n- a.ts\n" + "- ".padEnd(MAX_REPORTED_PATHS_SCAN_CHARS - 30, "p") + "\n- b.ts";
	assert.deepEqual(parseReportedPaths(cutReport), ["a.ts"], "a line cut by the scan window is not partially reported");
});

test("parseReportedPaths extracts only the bounded backticked path claim from the documented `- `path` — description` form", () => {
	// The worker's documented common form is `- `path/to/file` — description`:
	// the path claim is the FIRST backticked segment; the description after
	// it is prose that is never parsed into a path.
	assert.deepEqual(
		parseReportedPaths(
			[
				"## Files Changed",
				"- `extensions/workbench-runtime/core/lease-command.ts` — added the two-part token renderers",
				"- `tests/write-authority.test.ts` — new footer segment tests",
				"- `docs/notes.md` — prose after the claim is never parsed",
				"- `src/main.ts`",
				"- src/lib/util.ts — plain bullet with a description suffix",
				"- src/main.ts (plain safe path bullet)",
				"- `../escape.ts` — unsafe backticked claim is dropped",
				"- `/abs/path.ts` — unsafe backticked claim is dropped",
				"- `C:\\win.ts` — unsafe backticked claim is dropped",
				"- `src/../../x.ts` — escape is dropped",
				"- `this is prose with an unmatched backtick",
				"",
				"## Verification",
				"ran unit-test",
			].join("\n"),
		),
		[
			"docs/notes.md",
			"extensions/workbench-runtime/core/lease-command.ts",
			"src/lib/util.ts",
			"src/main.ts",
			"tests/write-authority.test.ts",
		],
		"backticked claims plus description suffixes; plain first-token claims; unsafe claims dropped; unmatched backticks skipped",
	);
	// A multi-token plain bullet yields only its first token — the arbitrary
	// prose suffix is never parsed into a path.
	assert.deepEqual(
		parseReportedPaths("## Files Changed\n- src/a.ts refactored the parser\n- src/b.ts (see notes)"),
		["src/a.ts", "src/b.ts"],
	);
	// Backticked claims are deduplicated and sorted like every other path.
	assert.deepEqual(
		parseReportedPaths("## Files Changed\n- `b.ts` — first\n- `b.ts` — duplicate\n- `a.ts` — second"),
		["a.ts", "b.ts"],
	);
});

test("delegationsDir is the bounded per-delegation layout under the workbench dir", async () => {
	await withTempDir(async (dir) => {
		const id = "20260601-120000-abcd";
		assert.equal(delegationDirFor(dir, id), join(delegationsDir(dir), id));
		assert.throws(() => delegationDirFor(dir, "../escape"), /invalid delegation id/);
	});
});

// ---------------------------------------------------------------------------
// P7 bounded handoff artifacts (worker-report.md / usage.json / extended
// worker-summary.json)
// ---------------------------------------------------------------------------

const FOUR_SECTION_REPORT = [
	"## Completed",
	"Implemented the parser slice with tests and docs",
	"## Files Changed",
	"- `src/parser.ts` — new option",
	"## Verification",
	"- `npm run typecheck` — exit 0",
	"- ran the unit-test recipe: 12 tests passed",
	"## Remaining Risks",
	"- none",
].join("\n");

async function finishedDelegation(dir: string, overrides: Partial<Parameters<typeof finishDelegationLedger>[2]> = {}) {
	await cleanRepo(dir);
	const before = await collectGitFacts(dir, spawnExec);
	const id = makeDelegationId(new Date());
	const created = await createDelegationLedger(dir, id, { task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 }, before, NOW);
	assert.ok(created.ok, created.ok ? "" : created.error);
	await mkdir(join(dir, "src"), { recursive: true });
	await writeFile(join(dir, "src", "parser.ts"), "v1\n", "utf8");
	const after = await collectAfterFacts(dir, before, spawnExec);
	const finished = await finishDelegationLedger(dir, id, {
		after,
		worker: workerFacts({ reportSummary: FOUR_SECTION_REPORT }),
		reportText: FOUR_SECTION_REPORT,
		secrets: ["abc-secret-123"],
		now: NOW,
		...overrides,
	});
	assert.ok(finished.ok, finished.ok ? "" : finished.error);
	return { dir, id, after, reportPath: delegationReportPath(dir, id) };
}

test("worker-report.md is persisted redacted, mode 0600, project-relative and contained; usage.json carries bounded facts", async () => {
	await withTempDir(async (dir) => {
		const { id, reportPath } = await finishedDelegation(dir);
		// Project-relative, normalized, contained in the validated delegation dir.
		assert.equal(reportPath, `.pi/workbench/delegations/${id}/worker-report.md`);
		assert.ok(!reportPath.startsWith("/") && !reportPath.startsWith("../"), "report path stays project-relative");
		const absolute = join(dir, reportPath.split("/").join(sep));
		assert.equal(absolute, join(delegationDirFor(dir, id), "worker-report.md"), "report path resolves inside the delegation directory");
		const st = await stat(absolute);
		assert.equal(st.mode & 0o777, 0o600, "report artifact is mode 0600");
		const report = await readFile(absolute, "utf8");
		assert.ok(report.includes("## Completed") && report.includes("## Remaining Risks"), "complete final report text persisted");
		// No temp artifacts survive the atomic write.
		const leftovers = (await readdir(delegationDirFor(dir, id))).filter((f) => f.endsWith(".tmp"));
		assert.deepEqual(leftovers, []);
		// usage.json: bounded structured usage/cache/budget/turn facts with the
		// nested worker usage shape preserved.
		const usage = JSON.parse(await readFile(join(delegationDirFor(dir, id), "usage.json"), "utf8")) as {
			delegation_id: string;
			status: string;
			turns: number;
			cache_hit_ratio: number | null;
			usage: { totalTokens: number; cost: { total: number } };
			budget: { maxContextTokens: number };
		};
		assert.equal(usage.delegation_id, id);
		assert.equal(usage.status, "success");
		assert.equal(usage.turns, 3);
		assert.equal(usage.cache_hit_ratio, 0.9);
		assert.equal(usage.usage.totalTokens, 1050, "nested worker usage preserved for cost accounting");
		assert.equal(usage.usage.cost.total, 0.0035);
		assert.equal(usage.budget.maxContextTokens, 400_000);
	});
});

test("worker-report.md redacts secrets BEFORE truncation and carries the explicit marker only when the REDACTED report exceeds the bound (UTF-8 safe)", async () => {
	await withTempDir(async (dir) => {
		// A report with a secret in the MIDDLE: redaction must reach content
		// that a head-slice would drop, and the secret must never survive.
		const report = `${FOUR_SECTION_REPORT}\nThe deployment token is abc-secret-123 and it must never persist.`;
		const { id } = await finishedDelegation(dir, { reportText: report });
		const stored = await readFile(join(delegationDirFor(dir, id), "worker-report.md"), "utf8");
		assert.ok(!stored.includes("abc-secret-123"), "configured secret values are scrubbed from the artifact");
		assert.ok(stored.includes("[REDACTED]"), "redaction marker present");

		// Genuinely oversized REDACTED text (≈ 810 KB of CJK, no secrets):
		// bounded to MAX_WORKER_REPORT_BYTES with the explicit marker; a
		// trailing multibyte sequence is never split.
		const oversized = `## Completed\n${'已实现'.repeat(90_000)}\n## Remaining Risks\n${FOUR_SECTION_REPORT}`;
		const big = await finishedDelegation(dir, { reportText: oversized });
		const bigStored = await readFile(join(delegationDirFor(big.dir, big.id), "worker-report.md"), "utf8");
		assert.ok(Buffer.byteLength(bigStored, "utf8") <= MAX_WORKER_REPORT_BYTES, "artifact stays within the 512 KiB bound");
		assert.ok(bigStored.includes(WORKER_REPORT_TRUNCATION_MARKER.trim()), "explicit truncation marker appended");
		// Decode strictly: no replacement chars from a split multibyte sequence.
		const roundTrip = Buffer.from(bigStored, "utf8").toString("utf8");
		assert.equal(roundTrip, bigStored, "no split multibyte sequence in the persisted report");

		// A VERY LONG secret before useful tail content: the runner retains
		// the complete text, the ledger redacts FIRST, and the report shrinks
		// below the bound — the post-secret tail persists with NO marker.
		const tail = ["## Completed", "done", "## Files Changed", "- `src/parser.ts`", "## Verification", "- ran unit-test", "## Remaining Risks", "- useful tail content survives"].join("\n");
		const longSecret = `${'abc-secret-123'.repeat(40_000)}\n${tail}`; // ≈ 560 KB raw
		assert.ok(Buffer.byteLength(longSecret, "utf8") > MAX_WORKER_REPORT_BYTES, "raw report is oversized before redaction");
		const small = await finishedDelegation(dir, { reportText: longSecret });
		const smallStored = await readFile(join(delegationDirFor(small.dir, small.id), "worker-report.md"), "utf8");
		assert.ok(smallStored.includes("useful tail content survives"), "post-secret tail persists when redaction makes the report fit");
		assert.ok(!smallStored.includes(WORKER_REPORT_TRUNCATION_MARKER.trim()), "no marker when the REDACTED report fits the bound");
		assert.ok(!smallStored.includes("abc-secret-123"), "secrets never survive in the artifact");
		assert.ok(Buffer.byteLength(smallStored, "utf8") <= MAX_WORKER_REPORT_BYTES, "artifact stays within the 512 KiB bound");
	});
});

test("worker-summary.json carries parsed section items, ACTUAL changed paths and a parse warning", async () => {
	await withTempDir(async (dir) => {
		const { id, after } = await finishedDelegation(dir);
		const summary = JSON.parse(await readFile(join(delegationDirFor(dir, id), "worker-summary.json"), "utf8")) as {
			changed_paths: string[];
			completed: string[];
			verification_commands: string[];
			verification_observations: string[];
			remaining_risks: string[];
			report_path: string;
			parse_warning: string | null;
			parse_reliable: boolean;
			truncated_items: boolean;
		};
		assert.deepEqual(summary.changed_paths, after.changedSinceBefore, "changed_paths are the ACTUAL digest-based paths");
		assert.deepEqual(summary.completed, ["Implemented the parser slice with tests and docs"]);
		assert.deepEqual(summary.verification_commands, ["`npm run typecheck` — exit 0"], "backticked command claims classified as commands");
		assert.deepEqual(summary.verification_observations, ["ran the unit-test recipe: 12 tests passed"]);
		assert.deepEqual(summary.remaining_risks, ["none"]);
		assert.equal(summary.report_path, `.pi/workbench/delegations/${id}/worker-report.md`);
		assert.equal(summary.parse_warning, null, "a normal four-section report parses reliably");
		assert.equal(summary.parse_reliable, true, "all four sections found — parsing reliable");
		assert.equal(summary.truncated_items, false);
	});
});

test("unreliable reports degrade safely: parse warning + actual changed paths, never raw-text fallback", async () => {
	await withTempDir(async (dir) => {
		// No required sections at all — parsing is unreliable.
		const { id } = await finishedDelegation(dir, { reportText: "free prose with no sections" });
		const summary = JSON.parse(await readFile(join(delegationDirFor(dir, id), "worker-summary.json"), "utf8")) as {
			changed_paths: string[];
			completed: string[];
			parse_warning: string | null;
			parse_reliable: boolean;
			truncated_items: boolean;
			report_path: string;
		};
		assert.deepEqual(summary.completed, [], "no items are fabricated from prose");
		assert.deepEqual(summary.changed_paths, ["src/parser.ts"], "actual changed paths still recorded");
		assert.match(summary.parse_warning ?? "", /missing required section/);
		assert.equal(summary.parse_reliable, false, "missing sections make the summary unreliable for the parent fallback");
		assert.equal(summary.truncated_items, false);
		assert.ok(summary.report_path.endsWith("/worker-report.md"));
	});

	// Diverging Files Changed claims produce a divergence warning while the
	// persisted changed_paths stay the actual diff (fresh repo per case).
	await withTempDir(async (dir) => {
		const liar = ["## Files Changed", "- README.md", "## Verification", "ok", "## Remaining Risks", "none", "## Completed", "done"].join("\n");
		const { id } = await finishedDelegation(dir, { reportText: liar });
		const liarSummary = JSON.parse(await readFile(join(delegationDirFor(dir, id), "worker-summary.json"), "utf8")) as {
			changed_paths: string[];
			parse_warning: string | null;
			parse_reliable: boolean;
		};
		assert.deepEqual(liarSummary.changed_paths, ["src/parser.ts"], "never the report's Files Changed claims");
		assert.match(liarSummary.parse_warning ?? "", /diverge from the actual diff/);
		assert.equal(liarSummary.parse_reliable, true, "all four sections present — the divergence warning does NOT suppress the parsed items");
	});

	// Item-cap hits with all sections present stay reliable (bounded items +
	// the explicit truncation fact), unlike missing sections.
	await withTempDir(async (dir) => {
		const capped = ["## Completed", ...Array.from({ length: 12 }, (_, i) => `- item ${i}`), "## Files Changed", "- `src/parser.ts`", "## Verification", "- ran unit-test", "## Remaining Risks", "- none"].join("\n");
		const { id } = await finishedDelegation(dir, { reportText: capped });
		const cappedSummary = JSON.parse(await readFile(join(delegationDirFor(dir, id), "worker-summary.json"), "utf8")) as {
			parse_warning: string | null;
			parse_reliable: boolean;
			truncated_items: boolean;
			completed: string[];
		};
		assert.equal(cappedSummary.parse_reliable, true, "caps do not make otherwise-present sections unreliable");
		assert.equal(cappedSummary.truncated_items, true, "the bounded-truncation fact is persisted");
		assert.equal(cappedSummary.completed.length, 8);
		assert.match(cappedSummary.parse_warning ?? "", /section item cap/);
	});
});
