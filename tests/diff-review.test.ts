/**
 * P7 worker-diff review tests (core/diff-review.ts).
 *
 * Real git repos in temp dirs; argv-only git calls (shell=false). Coverage:
 * PASS/FAIL verdicts from the REAL git state, realpath-safe scope checks
 * over the ENTIRE worker diff (include_paths narrows only the patch;
 * unsafe or non-worker include entries are refused), redacted bounded
 * patches (bounded-prefix reads for untracked files), deleted-path
 * markers, hash binding + mismatch/drift warnings (drift compares the
 * recorded-after snapshot to the current tree — same-path later edits are
 * detected, untouched preexisting dirty paths are ignored; later diff
 * changes turn the state STALE in core/delegation-state.ts), report/
 * actual ## Files Changed mismatch warnings, and refusal of
 * unknown/incomplete delegations.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { spawnExec, withTempDir } from "./helpers.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import {
	collectAfterFacts,
	collectGitFacts,
	computeDiffHash,
	createDelegationLedger,
	finishDelegationLedger,
	makeDelegationId,
	readDelegationLedger,
	type LedgerWorkerFacts,
} from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import {
	DEFAULT_REVIEW_MAX_BYTES,
	DEFAULT_REVIEW_MAX_LINES,
	readReviewRecord,
	renderReviewLines,
	reviewDelegation,
	type ReviewInput,
} from "../extensions/workbench-runtime/core/diff-review.ts";

const NOW = "2026-06-01T12:00:00.000Z";

async function git(repo: string, args: string[]): Promise<void> {
	const result = await spawnExec("git", args, { cwd: repo });
	assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

async function commitAll(repo: string, message: string): Promise<void> {
	await git(repo, ["add", "-A"]);
	await git(repo, ["commit", "-q", "-m", message]);
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
		usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 1050, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		cacheHitRatio: null,
		budget: { maxContextTokens: 400_000, maxContextRatio: 0.4, softBudgetReached: false, hardBudgetExceeded: false, compactionCount: 0, compactionReasons: [] },
		reportSummary: "done",
		...overrides,
	};
}

/** Repo + finished delegation whose worker changed only in-scope paths. */
async function setupDelegation(
	dir: string,
	workerChanges: (dir: string) => Promise<void>,
	allowedPaths: string[] = ["src/**", "README.md"],
): Promise<{ id: string; afterHash: string }> {
	await git(dir, ["init", "-q"]);
	await git(dir, ["config", "user.email", "test@example.com"]);
	await git(dir, ["config", "user.name", "Workbench Test"]);
	await git(dir, ["config", "commit.gpgsign", "false"]);
	await mkdir(join(dir, "src"), { recursive: true });
	await writeFile(join(dir, "README.md"), "hello\n", "utf8");
	await writeFile(join(dir, "src", "main.ts"), "v1\n", "utf8");
	await commitAll(dir, "init");

	const before = await collectGitFacts(dir, spawnExec);
	const id = makeDelegationId(new Date());
	const created = await createDelegationLedger(
		dir,
		id,
		{ task: "t", allowedPaths, acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 },
		before,
		NOW,
	);
	assert.ok(created.ok, created.ok ? "" : created.error);
	await workerChanges(dir);
	const after = await collectAfterFacts(dir, before, spawnExec);
	const finished = await finishDelegationLedger(dir, id, { after, worker: workerFacts(), secrets: [], now: NOW });
	assert.ok(finished.ok, finished.ok ? "" : finished.error);
	return { id, afterHash: after.diffHash };
}

function reviewInput(dir: string, id: string, overrides: Partial<ReviewInput> = {}): ReviewInput {
	return { projectRoot: dir, delegationId: id, exec: spawnExec, ...overrides };
}

// ---------------------------------------------------------------------------
// PASS / FAIL verdicts from the real git state
// ---------------------------------------------------------------------------

test("PASS: in-scope worker diff binds the current hash, writes review.json and renders a patch", async () => {
	await withTempDir(async (dir) => {
		const { id, afterHash } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "main.ts"), "v2 — in scope\n", "utf8");
			await writeFile(join(d, "src", "new.ts"), "const x = 1;\n", "utf8");
		});
		const result = await reviewDelegation(reviewInput(dir, id));
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		assert.equal(record.verdict, "PASS");
		assert.equal(record.mismatch, false);
		assert.equal(record.bound_diff_hash, afterHash, "the review binds the recorded after hash");
		assert.deepEqual(record.checked_paths, ["src/main.ts", "src/new.ts"], "all worker paths are scope-checked");
		assert.deepEqual(record.violations, []);
		assert.deepEqual(record.drift_paths, []);
		assert.equal(record.patch.length, 2);
		const patchText = record.patch.map((p) => p.text).join("\n");
		assert.ok(patchText.includes("v2"), "patch carries the real diff text");
		assert.ok(patchText.includes("const x = 1;"), "untracked new files appear as bounded content");
		// review.json persisted in the delegation directory.
		const persisted = await readReviewRecord(dir, id);
		assert.ok(persisted);
		assert.equal(persisted.delegation_id, id);
		assert.equal(persisted.verdict, "PASS");
		assert.equal(persisted.bound_diff_hash, afterHash);
		// The ledger stays untouched by the review service.
		const ledger = await readDelegationLedger(dir, id);
		assert.ok(ledger && ledger.after);
		assert.equal(ledger.after.review_status, "PENDING_REVIEW", "the ledger record is not mutated by the review");
	});
});

test("FAIL: an out-of-scope worker path fails the review with a recorded violation", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(
			dir,
			async (d) => {
				await writeFile(join(d, "src", "main.ts"), "ok\n", "utf8");
				// The worker wrote OUTSIDE the parent-approved scope.
				await writeFile(join(d, "forbidden.ts"), "x\n", "utf8");
			},
			["src/**"],
		);
		const result = await reviewDelegation(reviewInput(dir, id));
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		assert.equal(record.verdict, "FAIL");
		assert.equal(record.violations.length, 1);
		assert.equal(record.violations[0]?.path, "forbidden.ts");
		assert.match(record.violations[0]?.reason ?? "", /outside the parent-approved scope/);
		assert.ok(record.checked_paths.includes("forbidden.ts"), "the violation is checked, never skipped");
		// The runtime keeps such a delegation PENDING_REVIEW (state layer).
		assert.equal(record.verdict, "FAIL");
	});
});

test("include_paths narrows only the patch — scope checks still cover the whole worker diff", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "main.ts"), "ok\n", "utf8");
			await writeFile(join(d, "README.md"), "changed\n", "utf8");
			await writeFile(join(d, "out-of-scope.ts"), "x\n", "utf8");
		});
		const result = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/main.ts"] }));
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		// The violation is still detected even though the patch is narrowed.
		assert.equal(record.verdict, "FAIL");
		assert.deepEqual(record.violations.map((v) => v.path), ["out-of-scope.ts"]);
		assert.deepEqual(record.checked_paths.sort(), ["README.md", "out-of-scope.ts", "src/main.ts"]);
		assert.deepEqual(record.include_paths, ["src/main.ts"]);
		assert.deepEqual(record.patch.map((p) => p.path), ["src/main.ts"], "only the included path has patch content");
		// Include entries outside the worker diff are REFUSED — no review runs.
		const refused = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/main.ts", "never-changed.ts"] }));
		assert.equal(refused.ok, false);
		assert.match(refused.error ?? "", /"never-changed.ts" is not part of the worker diff/);
	});
});

test("unsafe include_paths entries are refused (no review runs, no review.json write)", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "main.ts"), "v2\n", "utf8");
		});
		for (const bad of ["../escape.ts", "/etc/passwd", "C:\\win.ts", "a/../../b.ts"]) {
			const result = await reviewDelegation(reviewInput(dir, id, { includePaths: [bad] }));
			assert.equal(result.ok, false, `entry ${bad} must be refused`);
			assert.match(result.error ?? "", /not a safe project-relative path/);
		}
		// A refused review never writes a completed review record — the
		// finish-time PENDING_REVIEW placeholder is still "no review yet".
		assert.equal(await readReviewRecord(dir, id), null);
	});
});

// ---------------------------------------------------------------------------
// hash binding, mismatch and drift
// ---------------------------------------------------------------------------

test("later diff changes are detected as mismatch + drift (the state layer turns them STALE)", async () => {
	await withTempDir(async (dir) => {
		const { id, afterHash } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "main.ts"), "worker version\n", "utf8");
		});
		// Something changed AFTER the worker finished (e.g. a commander lease write).
		await writeFile(join(dir, "drift.txt"), "post-worker change\n", "utf8");
		const result = await reviewDelegation(reviewInput(dir, id));
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		assert.equal(record.mismatch, true, "current hash differs from the recorded after hash");
		assert.notEqual(record.bound_diff_hash, afterHash);
		assert.deepEqual(record.drift_paths, ["drift.txt"]);
		assert.ok(record.notes.some((n) => n.includes("diff hash differs")), "mismatch is recorded as a warning");
		assert.ok(record.notes.some((n) => n.includes("changed after the worker finished")), "drift is recorded as a warning");
		// In-scope worker paths still PASS — mismatch warns, it does not fail.
		assert.equal(record.verdict, "PASS");
		// The bound hash is the CURRENT real diff hash (drift included).
		const current = await collectGitFacts(dir, spawnExec);
		assert.equal(record.bound_diff_hash, computeDiffHash(current.changedPaths, current.pathDigests, current.pathStatuses));
	});
});

test("drift compares the recorded-after snapshot to the current tree: same-path later edits detected, untouched preexisting dirty ignored", async () => {
	await withTempDir(async (dir) => {
		await git(dir, ["init", "-q"]);
		await git(dir, ["config", "user.email", "test@example.com"]);
		await git(dir, ["config", "user.name", "Workbench Test"]);
		await git(dir, ["config", "commit.gpgsign", "false"]);
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "README.md" as string), "hello\n", "utf8");
		await writeFile(join(dir, "src", "main.ts"), "v1\n", "utf8");
		await commitAll(dir, "init");
		// A preexisting dirty path (untouched by the worker) and the worker
		// target are both dirty BEFORE the delegation starts.
		await writeFile(join(dir, "preexisting.txt"), "dirty v1\n", "utf8");
		await writeFile(join(dir, "src", "main.ts"), "v2\n", "utf8");
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		const created = await createDelegationLedger(
			dir,
			id,
			{ task: "t", allowedPaths: ["src/**", "README.md"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 },
			before,
			NOW,
		);
		assert.ok(created.ok, created.ok ? "" : created.error);
		// The worker touches only src/main.ts.
		await writeFile(join(dir, "src", "main.ts"), "worker version\n", "utf8");
		const after = await collectAfterFacts(dir, before, spawnExec);
		const finished = await finishDelegationLedger(dir, id, { after, worker: workerFacts(), secrets: [], now: NOW });
		assert.ok(finished.ok, finished.ok ? "" : finished.error);

		// Review while preexisting.txt is still untouched: NO drift, no mismatch.
		const cleanReview = await reviewDelegation(reviewInput(dir, id));
		assert.ok(cleanReview.ok && cleanReview.record);
		assert.equal(cleanReview.record.mismatch, false);
		assert.deepEqual(cleanReview.record.drift_paths, [], "untouched preexisting dirty paths are not drift");

		// A later SAME-PATH edit of a worker-changed file IS drift.
		await writeFile(join(dir, "src", "main.ts"), "commander edit after the worker finished\n", "utf8");
		const drifted = await reviewDelegation(reviewInput(dir, id));
		assert.ok(drifted.ok && drifted.record);
		assert.equal(drifted.record.mismatch, true, "the same-path later edit changes the diff hash");
		assert.deepEqual(drifted.record.drift_paths, ["src/main.ts"], "same-path later edit is detected as drift");
		assert.ok(!drifted.record.drift_paths.includes("preexisting.txt"), "untouched preexisting dirty path stays ignored");
	});
});

test("realpath-safe scope: a symlink resolving outside the approved subtree is a violation", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(
			dir,
			async (d) => {
				// "src/link.ts" is lexically inside src/** but resolves OUTSIDE it:
				// it points at the PRE-EXISTING committed README.md at the repo
				// root, so the worker diff contains only the symlink and the
				// violation isolates the escape itself (no out-of-scope file is
				// created during the worker phase).
				const link = await spawnExec("ln", ["-s", "../README.md", "src/link.ts"], { cwd: d });
				assert.equal(link.code, 0, `ln failed: ${link.stderr}`);
			},
			["src/**"],
		);
		const result = await reviewDelegation(reviewInput(dir, id));
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		assert.equal(record.verdict, "FAIL", "a symlink escape is a scope violation");
		assert.deepEqual(record.violations.map((v) => v.path), ["src/link.ts"]);
		assert.match(record.violations[0]?.reason ?? "", /realpath\/symlink/);
	});
});

test("untracked patch reads are bounded prefixes — huge files are never loaded fully", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			const big = Buffer.alloc(2 * 1024 * 1024, 0x62);
			await writeFile(join(d, "src", "huge.ts"), big, "utf8");
		});
		const result = await reviewDelegation(reviewInput(dir, id, { maxBytes: 1024, maxLines: 5 }));
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		assert.equal(record.verdict, "PASS");
		const entry = record.patch.find((p) => p.path === "src/huge.ts");
		assert.ok(entry, "huge untracked file appears in the patch");
		assert.equal(entry.source, "file-content");
		assert.equal(entry.truncated, true, "oversized untracked file is prefix-truncated");
		assert.ok(Buffer.byteLength(entry.text, "utf8") <= 1024, "patch bytes stay within the bound");
	});
});

test("any per-path truncated patch entry sets patch_truncated and renders the segmented include_paths guidance even when the entry fits the global envelope", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			// 2000 bytes of pure secret tokens: the bounded prefix read is
			// per-path truncated (size > maxBytes), but redaction shrinks the
			// kept prefix so the whole entry fits the GLOBAL line/byte caps —
			// patch_truncated must still be true and the segmented
			// include_paths review instruction must render.
			await writeFile(join(d, "src", "secretly-huge.ts"), "pad-secret-token-xyz".repeat(100), "utf8");
		});
		const result = await reviewDelegation(
			reviewInput(dir, id, { maxBytes: 1024, maxLines: 100, secrets: ["pad-secret-token-xyz"] }),
		);
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		const entry = record.patch.find((p) => p.path === "src/secretly-huge.ts");
		assert.ok(entry, "the per-path truncated entry is present");
		assert.equal(entry.truncated, true, "the entry itself is marked truncated");
		assert.equal(record.patch_truncated, true, "any per-path truncation sets patch_truncated — even when every entry fits the global envelope");
		assert.ok(!record.patch.some((p) => p.text.includes("pad-secret-token-xyz")), "secrets scrubbed from the patch");
		const rendered = renderReviewLines(record).join("\n");
		assert.ok(
			rendered.includes("review segments via workbench_review_worker_diff include_paths"),
			"segmented include_paths guidance renders when any entry is per-path truncated",
		);
		assert.ok(rendered.includes("src/secretly-huge.ts (file-content"), "per-path stat rendered");
	});
});

test("review warns on report/actual ## Files Changed mismatch and missing sections", async () => {
	await withTempDir(async (dir) => {
		await git(dir, ["init", "-q"]);
		await git(dir, ["config", "user.email", "test@example.com"]);
		await git(dir, ["config", "user.name", "Workbench Test"]);
		await git(dir, ["config", "commit.gpgsign", "false"]);
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "README.md"), "hello\n", "utf8");
		await writeFile(join(dir, "src", "main.ts"), "v1\n", "utf8");
		await commitAll(dir, "init");
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		const created = await createDelegationLedger(
			dir,
			id,
			{ task: "t", allowedPaths: ["src/**", "README.md"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 },
			before,
			NOW,
		);
		assert.ok(created.ok, created.ok ? "" : created.error);
		await writeFile(join(dir, "src", "main.ts"), "v2\n", "utf8");
		await writeFile(join(dir, "src", "extra.ts"), "x\n", "utf8");
		const after = await collectAfterFacts(dir, before, spawnExec);
		// The worker claimed README.md (never touched) and missed src/extra.ts.
		const report = ["## Completed", "done", "## Files Changed", "- src/main.ts", "- README.md", "## Verification", "ok", "## Remaining Risks", "none"].join("\n");
		const finished = await finishDelegationLedger(dir, id, { after, worker: workerFacts({ reportSummary: report }), secrets: [], now: NOW });
		assert.ok(finished.ok, finished.ok ? "" : finished.error);

		const ledger = await readDelegationLedger(dir, id);
		assert.ok(ledger && ledger.after);
		assert.deepEqual(ledger.after.reported_paths, ["README.md", "src/main.ts"], "safe paths parsed from the bounded section");

		const result = await reviewDelegation(reviewInput(dir, id));
		assert.ok(result.ok && result.record);
		assert.ok(result.record.notes.some((n) => n.includes("not present in the actual diff: README.md")), "claimed-but-unchanged path is a warning");
		assert.ok(result.record.notes.some((n) => n.includes("misses 1 actual diff path(s): src/extra.ts")), "changed-but-unclaimed path is a warning");

		// A report with NO ## Files Changed section is a warning too.
		const noSection = await reviewDelegation(reviewInput(dir, id));
		void noSection;
		const plain = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "main.ts"), "v3\n", "utf8");
		});
		const plainResult = await reviewDelegation(reviewInput(dir, plain.id));
		assert.ok(plainResult.ok && plainResult.record);
		assert.ok(
			plainResult.record.notes.some((n) => n.includes("no parseable ## Files Changed section")),
			"missing section is a warning",
		);
	});
});

test("deleted tracked paths render as git removal diffs", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "main.ts"), "v1\n", "utf8");
			await writeFile(join(d, "src", "gone.ts"), "delete me\n", "utf8");
			await commitAll(d, "add gone");
			// The worker deletes an in-scope tracked file.
			await git(d, ["rm", "-q", "src/gone.ts"]);
		});
		const result = await reviewDelegation(reviewInput(dir, id));
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		assert.equal(record.verdict, "PASS");
		const gone = record.patch.find((p) => p.path === "src/gone.ts");
		assert.ok(gone, "deleted path appears in the patch");
		assert.equal(gone.source, "git-diff", "tracked deletions render as the git removal diff");
	});
});

// ---------------------------------------------------------------------------
// bounding, redaction and refusals
// ---------------------------------------------------------------------------

test("the patch is bounded by max_bytes/max_lines and redacts secrets", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "main.ts"), `line0\n${"pad-secret-token-xyz\n".repeat(500)}`, "utf8");
		});
		const result = await reviewDelegation(reviewInput(dir, id, { maxBytes: 200, maxLines: 10, secrets: ["pad-secret-token-xyz"] }));
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		assert.equal(record.verdict, "PASS");
		const patchText = record.patch.map((p) => p.text).join("\n");
		assert.ok(!patchText.includes("pad-secret-token-xyz"), "secrets scrubbed from the patch");
		assert.ok(record.patch_truncated, "oversized patch is truncated");
		assert.ok(Buffer.byteLength(patchText, "utf8") <= 300, "patch bytes stay within the bound");
	});
});

test("reviews refuse unknown, incomplete and running delegations", async () => {
	await withTempDir(async (dir) => {
		const invalid = await reviewDelegation(reviewInput(dir, "not-an-id"));
		assert.equal(invalid.ok, false);
		assert.match(invalid.error ?? "", /invalid delegation id/);
		const missing = await reviewDelegation(reviewInput(dir, "20260601-120000-abcd"));
		assert.equal(missing.ok, false);
		assert.match(missing.error ?? "", /not found or incomplete/);
		// A running delegation (no after record yet) cannot be reviewed.
		await git(dir, ["init", "-q"]);
		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		await createDelegationLedger(dir, id, { task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 }, before, NOW);
		const running = await reviewDelegation(reviewInput(dir, id));
		assert.equal(running.ok, false);
		assert.match(running.error ?? "", /no recorded result/);
	});
});

test("review fails closed: a thrown or non-zero git status returns a structured failure and writes NO review record", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "main.ts"), "v2\n", "utf8");
		});
		const makeFailingExec = (mode: "throw" | "nonzero"): ExecFn => {
			return async (command, args) => {
				if (command === "git" && args[0] === "status") {
					if (mode === "throw") throw new Error("git status exploded");
					return { stdout: "", stderr: "fatal: bad config", code: 128, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			};
		};
		for (const mode of ["throw", "nonzero"] as const) {
			const result = await reviewDelegation(reviewInput(dir, id, { exec: makeFailingExec(mode) }));
			assert.equal(result.ok, false, `${mode}: the review must fail closed on an unavailable git status`);
			assert.equal(result.record, undefined, `${mode}: no review record is produced`);
			assert.match(result.error ?? "", /git status --porcelain failed/, `${mode}: the structured error names the failed status`);
		}
		// No review (PASS or otherwise) was written: the finish-time
		// PENDING_REVIEW placeholder is still "no review yet".
		assert.equal(await readReviewRecord(dir, id), null);
		// The ledger itself is untouched by the failed review.
		const ledger = await readDelegationLedger(dir, id);
		assert.ok(ledger && ledger.after);
		assert.equal(ledger.after.review_status, "PENDING_REVIEW");
	});
});

test("renderReviewLines is deterministic and carries verdict, hashes and the patch", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "main.ts"), "v2\n", "utf8");
		});
		const result = await reviewDelegation(reviewInput(dir, id));
		assert.ok(result.ok && result.record);
		const lines = renderReviewLines(result.record);
		const text = lines.join("\n");
		assert.ok(lines[0]?.startsWith("delegation : "));
		assert.ok(text.includes("verdict    : PASS"));
		assert.ok(text.includes("bound hash : "));
		assert.ok(text.includes("after hash : "));
		assert.ok(text.includes("--- src/main.ts (git-diff"));
		// The scope note is part of the rendered output.
		assert.ok(text.includes("Scope checks always cover the entire worker diff"));
	});
});

test("review patch defaults are 400 lines / 32 KiB, enforced GLOBALLY over the rendered patch", async () => {
	assert.equal(DEFAULT_REVIEW_MAX_LINES, 400, "default line cap is 400");
	assert.equal(DEFAULT_REVIEW_MAX_BYTES, 32 * 1024, "default byte cap is 32 KiB");
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			// Three files, each ~24 KiB: every single file fits a per-path
			// 32 KiB cap, but the combined patch far exceeds it — a per-path
			// cap would keep all three; the GLOBAL cap must truncate.
			for (const name of ["a.ts", "b.ts", "c.ts"]) {
				await writeFile(join(d, "src", name), `// ${name}\n` + "line of content\n".repeat(1200), "utf8");
			}
		});
		const result = await reviewDelegation(reviewInput(dir, id));
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		assert.equal(record.verdict, "PASS");
		const patchText = record.patch.map((p) => p.text).join("\n");
		const patchLines = record.patch.reduce((n, p) => n + p.text.split("\n").length, 0);
		assert.ok(Buffer.byteLength(patchText, "utf8") <= 32 * 1024, "global byte cap holds over the rendered patch");
		assert.ok(patchLines <= 400, "global line cap holds over the rendered patch");
		assert.equal(record.patch_truncated, true, "the oversized combined patch is truncated globally");
		// Bounded path/stat info covers every patch path even when content is cut.
		assert.equal(record.patch_paths.length, 3, "per-path stats cover every patch path");
		assert.ok(record.patch_paths.some((p) => p.truncated), "cut/omitted paths are marked truncated");
		// The COMPLETE actual diff still drives scope checks and the bound hash.
		const current = await collectGitFacts(dir, spawnExec);
		assert.equal(record.bound_diff_hash, computeDiffHash(current.changedPaths, current.pathDigests, current.pathStatuses));
		assert.deepEqual(record.checked_paths.sort(), ["src/a.ts", "src/b.ts", "src/c.ts"], "all worker paths scope-checked");
		// The explicit segmented-review instruction is rendered.
		const rendered = renderReviewLines(record).join("\n");
		assert.ok(rendered.includes("review segments via workbench_review_worker_diff include_paths"), "segmented include_paths instruction when truncated");
		assert.ok(rendered.includes("patch paths (3)"), "bounded path/stat info rendered");
	});
});
