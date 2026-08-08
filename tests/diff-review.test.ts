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
 * actual ## Files Changed mismatch warnings, refusal of
 * unknown/incomplete delegations, and Slice B2 displayed-path coverage
 * (segmented actual-diff review): globally omitted paths stay remaining,
 * bounded/per-path-truncated entries count as displayed evidence, prior
 * coverage merges only on the SAME bound hash with valid worker-path
 * membership (legacy schema_version-1 records infer coverage only from
 * their persisted patch entries), a hash change resets coverage (this
 * call's actually rendered paths stay displayed under the new hash),
 * rendering normalizes legacy/malformed coverage from valid checked
 * worker paths (absent fields never render zero/zero COMPLETE), hidden
 * out-of-scope paths always FAIL, same-hash complete PASS rerenders keep
 * full coverage, and the next include_paths guidance is bounded to 50
 * paths AND a fixed UTF-8 byte cap with an exact omitted count.
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
	MAX_REVIEW_GUIDANCE_BYTES,
	MAX_REVIEW_PATCH_PATHS,
	readReviewRecord,
	renderReviewLines,
	reviewDelegation,
	reviewRecordRelPath,
	type ReviewInput,
	type ReviewRecord,
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

// ---------------------------------------------------------------------------
// Slice B2 — displayed-path coverage (segmented actual-diff review)
// ---------------------------------------------------------------------------

test("Slice B2: globally omitted paths stay remaining; include_paths segments merge displayed coverage; bounded truncated entries count; complete only when every worker path rendered", async () => {
	await withTempDir(async (dir) => {
		const { id, afterHash } = await setupDelegation(dir, async (d) => {
			for (const name of ["a.ts", "b.ts", "c.ts"]) {
				await writeFile(join(d, "src", name), `// ${name}\n` + "line of content\n".repeat(1200), "utf8");
			}
		});
		// Segment 1: the global envelope (default 400 lines / 32 KiB) renders
		// ONLY a.ts — its entry is line-cut to the remaining budget, so the
		// bounded entry COUNTS as a.ts's evidence segment; b.ts and c.ts are
		// globally omitted and must stay remaining.
		const first = await reviewDelegation(reviewInput(dir, id));
		assert.ok(first.ok, first.error ?? "review failed");
		let record = first.record!;
		assert.equal(record.verdict, "PASS");
		assert.equal(record.patch_truncated, true);
		assert.deepEqual(record.patch.map((p) => p.path), ["src/a.ts"], "the global envelope drops b.ts/c.ts entirely");
		assert.ok(record.patch[0]?.truncated, "the bounded line-cut entry is truncated");
		assert.deepEqual(record.displayed_paths, ["src/a.ts"], "only actually rendered entries count as displayed");
		assert.deepEqual(record.remaining_paths, ["src/b.ts", "src/c.ts"], "globally omitted paths stay remaining");
		assert.equal(record.coverage_complete, false);
		assert.equal(record.bound_diff_hash, afterHash, "the complete current diff hash binds every segment");
		assert.equal(record.review_path, reviewRecordRelPath(id));
		assert.equal(record.review_path, `.pi/workbench/delegations/${id}/review.json`);
		// The durable review.json is written at the declared project-relative path.
		const persisted = JSON.parse(await readFile(join(dir, record.review_path), "utf8"));
		assert.equal(persisted.coverage_complete, false);
		assert.deepEqual(persisted.displayed_paths, ["src/a.ts"]);
		assert.ok(await readReviewRecord(dir, id));

		// Segment 2: include_paths narrows the patch to b.ts; same hash merges
		// the prior displayed coverage.
		const second = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/b.ts"] }));
		assert.ok(second.ok, second.error ?? "review failed");
		record = second.record!;
		assert.equal(record.bound_diff_hash, afterHash);
		assert.deepEqual(record.displayed_paths, ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(record.remaining_paths, ["src/c.ts"]);
		assert.equal(record.coverage_complete, false);
		const rendered2 = renderReviewLines(record).join("\n");
		assert.ok(rendered2.includes("displayed  : 2 of 3 worker path(s)"), rendered2);
		assert.ok(rendered2.includes("remaining  : 1 worker path(s)"), rendered2);
		assert.ok(rendered2.includes("coverage   : INCOMPLETE"), rendered2);
		assert.ok(rendered2.includes(`next incl. : ["src/c.ts"] (max ${MAX_REVIEW_PATCH_PATHS} paths per call; ≤ ${MAX_REVIEW_GUIDANCE_BYTES} bytes)`), rendered2);

		// Segment 3: the last path completes coverage.
		const third = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/c.ts"] }));
		assert.ok(third.ok, third.error ?? "review failed");
		record = third.record!;
		assert.deepEqual(record.displayed_paths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
		assert.deepEqual(record.remaining_paths, []);
		assert.equal(record.coverage_complete, true, "no REVIEWED until every worker path is rendered");
		assert.equal(record.bound_diff_hash, afterHash, "scope checks and the bound hash covered the complete diff in every segment");
		assert.deepEqual(record.checked_paths.sort(), ["src/a.ts", "src/b.ts", "src/c.ts"]);
		const rendered = renderReviewLines(record).join("\n");
		assert.ok(rendered.includes("displayed  : 3 of 3 worker path(s)"), rendered);
		assert.ok(rendered.includes("remaining  : 0 worker path(s)"), rendered);
		assert.ok(rendered.includes("coverage   : COMPLETE"), rendered);
		assert.ok(rendered.includes("next incl. : (none — every worker path displayed for this bound hash)"), rendered);
		assert.ok(rendered.includes(`review path: .pi/workbench/delegations/${id}/review.json`), rendered);
		// Deterministic: two renders of the same record are identical.
		assert.deepEqual(renderReviewLines(record), renderReviewLines(record));
	});
});

test("Slice B2: a changed diff hash resets prior displayed coverage; fresh coverage binds the new hash", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "a.ts"), "a1\n", "utf8");
			await writeFile(join(d, "src", "b.ts"), "b1\n", "utf8");
		});
		const first = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/a.ts"] }));
		assert.ok(first.ok && first.record);
		assert.deepEqual(first.record.displayed_paths, ["src/a.ts"]);
		assert.deepEqual(first.record.remaining_paths, ["src/b.ts"]);

		// The diff changes after the worker finished (e.g. a commander edit).
		await writeFile(join(dir, "src", "b.ts"), "b2 — commander edit\n", "utf8");
		const second = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/a.ts"] }));
		assert.ok(second.ok && second.record);
		assert.notEqual(second.record.bound_diff_hash, first.record.bound_diff_hash);
		assert.deepEqual(second.record.displayed_paths, ["src/a.ts"], "coverage resets on a hash change — prior-hash coverage does not merge, but this call's rendered path stays displayed");
		assert.deepEqual(second.record.remaining_paths, ["src/b.ts"], "a.ts was actually rendered under the new hash in THIS call, so it is displayed and NOT remaining");
		assert.equal(second.record.coverage_complete, false);

		// A full render under the new hash completes coverage.
		const third = await reviewDelegation(reviewInput(dir, id));
		assert.ok(third.ok && third.record);
		assert.equal(third.record.coverage_complete, true);
		assert.deepEqual(third.record.displayed_paths, ["src/a.ts", "src/b.ts"]);
		assert.equal(third.record.bound_diff_hash, second.record.bound_diff_hash);
	});
});

test("Slice B2: legacy schema_version-1 records stay readable and infer prior coverage only from their persisted patch entries (same hash, valid worker paths only)", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "a.ts"), "a1\n", "utf8");
			await writeFile(join(d, "src", "b.ts"), "b1\n", "utf8");
		});
		const current = await collectGitFacts(dir, spawnExec);
		const hash = computeDiffHash(current.changedPaths, current.pathDigests, current.pathStatuses);
		// Hand-written legacy review.json: schema_version 1 WITHOUT the
		// additive coverage fields and WITHOUT review_path. Its patch entries
		// cover a.ts plus a path that is NOT a worker path.
		const legacy = {
			schema_version: 1,
			delegation_id: id,
			reviewed_at: NOW,
			verdict: "PASS",
			bound_diff_hash: hash,
			recorded_after_hash: hash,
			mismatch: false,
			drift_paths: [],
			violations: [],
			checked_paths: ["src/a.ts", "src/b.ts"],
			include_paths: [],
			patch: [
				{ path: "src/a.ts", source: "git-diff", text: "diff a", truncated: false },
				{ path: "not-a-worker-path.ts", source: "git-diff", text: "diff x", truncated: false },
			],
			patch_truncated: false,
			patch_paths: [],
			notes: [],
		};
		const legacyPath = join(dir, ".pi", "workbench", "delegations", id, "review.json");
		await mkdir(join(dir, ".pi", "workbench", "delegations", id), { recursive: true });
		await writeFile(legacyPath, JSON.stringify(legacy), "utf8");

		// The legacy record stays readable as a completed review.
		const readable = await readReviewRecord(dir, id);
		assert.ok(readable, "legacy schema_version-1 records remain readable");
		assert.equal(readable.verdict, "PASS");

		// Same-hash segment: prior coverage is inferred ONLY from the legacy
		// patch entries, filtered to valid worker paths — the foreign path
		// never counts.
		const result = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/b.ts"] }));
		assert.ok(result.ok && result.record);
		assert.equal(result.record.bound_diff_hash, hash);
		assert.deepEqual(result.record.displayed_paths, ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(result.record.remaining_paths, []);
		assert.equal(result.record.coverage_complete, true);
	});
});

test("Slice B2: legacy coverage merges only on the SAME bound hash — a different hash resets", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "a.ts"), "a1\n", "utf8");
			await writeFile(join(d, "src", "b.ts"), "b1\n", "utf8");
		});
		const legacyDir = join(dir, ".pi", "workbench", "delegations", id);
		await mkdir(legacyDir, { recursive: true });
		// A legacy record binding a DIFFERENT hash with a.ts in its patch.
		const legacy = {
			schema_version: 1,
			delegation_id: id,
			reviewed_at: NOW,
			verdict: "PASS",
			bound_diff_hash: "0".repeat(64),
			recorded_after_hash: "0".repeat(64),
			mismatch: false,
			drift_paths: [],
			violations: [],
			checked_paths: ["src/a.ts", "src/b.ts"],
			include_paths: [],
			patch: [{ path: "src/a.ts", source: "git-diff", text: "diff a", truncated: false }],
			patch_truncated: false,
			patch_paths: [],
			notes: [],
		};
		await writeFile(join(legacyDir, "review.json"), JSON.stringify(legacy), "utf8");
		const result = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/b.ts"] }));
		assert.ok(result.ok && result.record);
		assert.notEqual(result.record.bound_diff_hash, legacy.bound_diff_hash);
		assert.deepEqual(result.record.displayed_paths, ["src/b.ts"], "different-hash legacy coverage is never merged — only this call's rendered path displays");
		assert.deepEqual(result.record.remaining_paths, ["src/a.ts"], "b.ts was actually rendered in THIS call, so only a.ts remains under the new hash");
		assert.equal(result.record.coverage_complete, false);
	});
});

test("Slice B2: a hidden out-of-scope path always FAILs and is never hidden by include_paths narrowing", async () => {
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
		// include_paths names ONLY the in-scope path — the hidden out-of-scope
		// path must still FAIL and stay remaining (never displayed).
		const result = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/main.ts"] }));
		assert.ok(result.ok && result.record);
		assert.equal(result.record.verdict, "FAIL");
		assert.deepEqual(result.record.violations.map((v) => v.path), ["forbidden.ts"]);
		assert.deepEqual(result.record.displayed_paths, ["src/main.ts"]);
		assert.deepEqual(result.record.remaining_paths, ["forbidden.ts"]);
		assert.equal(result.record.coverage_complete, false);
		// Rendering every path can complete coverage — but the verdict stays
		// FAIL: REVIEWED requires scope PASS AND complete coverage.
		const full = await reviewDelegation(reviewInput(dir, id));
		assert.ok(full.ok && full.record);
		assert.equal(full.record.verdict, "FAIL");
		assert.equal(full.record.coverage_complete, true);
	});
});

test("Slice B2: a same-hash complete PASS rerender keeps full displayed coverage", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "a.ts"), "a1\n", "utf8");
		});
		const first = await reviewDelegation(reviewInput(dir, id));
		assert.ok(first.ok && first.record);
		assert.equal(first.record.coverage_complete, true);
		assert.deepEqual(first.record.displayed_paths, ["src/a.ts"]);
		// A narrowed rerender of the SAME hash keeps the complete binding.
		const rerender = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/a.ts"] }));
		assert.ok(rerender.ok && rerender.record);
		assert.equal(rerender.record.bound_diff_hash, first.record.bound_diff_hash);
		assert.equal(rerender.record.coverage_complete, true, "same-hash merge keeps complete coverage");
		assert.deepEqual(rerender.record.displayed_paths, ["src/a.ts"]);
		assert.deepEqual(rerender.record.remaining_paths, []);
	});
});

test("Slice B2: the next include_paths guidance is bounded to 50 paths with an explicit overflow marker", async () => {
	await withTempDir(async (dir) => {
		const names: string[] = [];
		for (let i = 0; i < 100; i += 1) names.push(`f${String(i).padStart(2, "0")}.ts`);
		const { id } = await setupDelegation(dir, async (d) => {
			for (const name of names) await writeFile(join(d, "src", name), "x\n", "utf8");
		});
		// A single-path segment leaves 99 remaining paths; the guidance caps
		// at MAX_REVIEW_PATCH_PATHS (50) with an explicit overflow marker.
		const result = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/f00.ts"] }));
		assert.ok(result.ok && result.record);
		assert.equal(MAX_REVIEW_PATCH_PATHS, 50);
		assert.equal(result.record.displayed_paths.length, 1);
		assert.equal(result.record.remaining_paths.length, 99);
		const rendered = renderReviewLines(result.record).join("\n");
		const guidance = rendered.split("\n").find((line) => line.startsWith("next incl. : "));
		assert.ok(guidance, rendered);
		assert.ok(guidance!.includes(`(max ${MAX_REVIEW_PATCH_PATHS} paths per call; ≤ ${MAX_REVIEW_GUIDANCE_BYTES} bytes)`), guidance);
		const quoted = /\[([^\]]*)\]/.exec(guidance!)?.[1] ?? "";
		assert.equal(quoted.split(",").length, 50, "guidance lists exactly 50 paths");
		assert.ok(guidance!.includes("+49 more"), guidance);
		assert.ok(
			Buffer.byteLength(guidance!, "utf8") <= MAX_REVIEW_GUIDANCE_BYTES + 256,
			"the whole guidance line stays byte-bounded (fixed suffix over the capped path list)",
		);
	});
});

test("Slice B2: the next include_paths guidance is ALSO bounded by a fixed UTF-8 byte cap — complete usable paths only and an exact omitted count", () => {
	assert.equal(MAX_REVIEW_GUIDANCE_BYTES, 1024, "the fixed guidance byte cap is 1024 UTF-8 bytes");
	// Two valid ~400-byte paths and one path that alone exceeds the cap.
	const longA = `src/${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(60)}/${"g".repeat(60)}/${"h".repeat(60)}/${"i".repeat(60)}/${"j".repeat(50)}.ts`;
	const longB = `src/${"k".repeat(60)}/${"l".repeat(60)}/${"m".repeat(60)}/${"n".repeat(60)}/${"o".repeat(60)}/${"p".repeat(60)}/${"q".repeat(50)}.ts`;
	const huge = `src/${"r".repeat(200)}/${"s".repeat(200)}/${"t".repeat(200)}/${"u".repeat(200)}/${"v".repeat(200)}/${"w".repeat(200)}/${"x".repeat(300)}.ts`;
	assert.ok(Buffer.byteLength(longA, "utf8") >= 400, "longA is a ~400-byte valid path");
	assert.ok(Buffer.byteLength(longB, "utf8") >= 400, "longB is a ~400-byte valid path");
	assert.ok(Buffer.byteLength(huge, "utf8") > MAX_REVIEW_GUIDANCE_BYTES, "huge alone exceeds the byte cap");
	const record: ReviewRecord = {
		schema_version: 1,
		delegation_id: "20260601-120000-abcd",
		reviewed_at: NOW,
		verdict: "PASS",
		bound_diff_hash: "0".repeat(64),
		recorded_after_hash: "0".repeat(64),
		mismatch: false,
		drift_paths: [],
		violations: [],
		checked_paths: ["src/a.ts", longA, longB, huge],
		include_paths: [],
		patch: [{ path: "src/a.ts", source: "git-diff", text: "diff", truncated: false }],
		patch_truncated: false,
		patch_paths: [{ path: "src/a.ts", source: "git-diff", bytes: 4, truncated: false }],
		notes: [],
		displayed_paths: ["src/a.ts"],
		remaining_paths: [longA, longB, huge],
		coverage_complete: false,
		review_path: ".pi/workbench/delegations/20260601-120000-abcd/review.json",
	};
	const rendered = renderReviewLines(record).join("\n");
	const guidance = rendered.split("\n").find((line) => line.startsWith("next incl. : "));
	assert.ok(guidance, rendered);
	const quoted = /\[([^\]]*)\]/.exec(guidance!)?.[1] ?? "";
	const listed = quoted.length === 0 ? [] : quoted.split(",").map((entry) => JSON.parse(entry) as string);
	assert.ok(listed.length >= 2, `the two ~400-byte paths fit within the byte cap (listed ${listed.length})`);
	// Every listed path is a COMPLETE usable path string — never truncated.
	for (const path of listed) {
		assert.ok([longA, longB].includes(path), `only complete remaining paths are listed, got ${path}`);
	}
	assert.ok(guidance!.includes("+1 more"), "the byte-exceeding path is counted exactly in the omitted count");
	assert.ok(!guidance!.includes(huge.slice(0, 40)), "an overlong path is never truncated into the guidance");
	// The path list itself never exceeds the fixed byte cap: an unbounded
	// 50-path line is impossible even with 400-byte paths.
	const bracketList = quoted.length === 0 ? "[]" : `[${quoted}]`;
	assert.ok(Buffer.byteLength(bracketList, "utf8") <= MAX_REVIEW_GUIDANCE_BYTES, "guidance path list stays within the byte cap");

	// A remaining path that ALONE exceeds the cap is omitted entirely and
	// the omitted count stays exact (the guidance never fabricates a path).
	const hugeFirst: ReviewRecord = { ...record, checked_paths: [huge, "src/a.ts"], displayed_paths: [], remaining_paths: [huge, "src/a.ts"], patch: [], patch_paths: [] };
	const hugeRendered = renderReviewLines(hugeFirst).join("\n");
	const hugeGuidance = hugeRendered.split("\n").find((line) => line.startsWith("next incl. : "));
	assert.ok(hugeGuidance, hugeRendered);
	assert.ok(!hugeGuidance!.includes(JSON.stringify(huge)), "the overlong path is never listed");
	assert.ok(hugeGuidance!.includes("+2 more"), "both remaining paths are counted exactly when none fit the byte cap");
	assert.ok(hugeGuidance!.includes("next incl. : []"), "the empty list stays explicit");
});

test("Slice B2: renderReviewLines normalizes legacy/malformed coverage from valid checked worker paths — absent fields never render zero/zero COMPLETE", () => {
	const base: ReviewRecord = {
		schema_version: 1,
		delegation_id: "20260601-120000-abcd",
		reviewed_at: NOW,
		verdict: "PASS",
		bound_diff_hash: "0".repeat(64),
		recorded_after_hash: "0".repeat(64),
		mismatch: false,
		drift_paths: [],
		violations: [],
		checked_paths: ["src/a.ts", "src/b.ts"],
		include_paths: [],
		patch: [{ path: "src/a.ts", source: "git-diff", text: "diff a", truncated: false }],
		patch_truncated: false,
		patch_paths: [{ path: "src/a.ts", source: "git-diff", bytes: 6, truncated: false }],
		notes: [],
		displayed_paths: [],
		remaining_paths: [],
		coverage_complete: false,
		review_path: ".pi/workbench/delegations/20260601-120000-abcd/review.json",
	};

	// Legacy schema_version-1 record WITHOUT the additive coverage fields:
	// displayed is inferred from the persisted patch entries and remaining
	// from checked_paths — never zero/zero COMPLETE.
	const legacy: ReviewRecord = {
		...base,
		displayed_paths: undefined as unknown as string[],
		remaining_paths: undefined as unknown as string[],
		coverage_complete: undefined as unknown as boolean,
	};
	const legacyText = renderReviewLines(legacy).join("\n");
	assert.ok(legacyText.includes("displayed  : 1 of 2 worker path(s)"), legacyText);
	assert.ok(legacyText.includes("remaining  : 1 worker path(s)"), "remaining is recomputed from checked worker paths");
	assert.ok(legacyText.includes("coverage   : INCOMPLETE"), "absent coverage fields never render zero/zero COMPLETE");

	// A legacy record whose patch covered EVERY worker path renders COMPLETE.
	const legacyFull: ReviewRecord = {
		...base,
		patch: [
			{ path: "src/a.ts", source: "git-diff", text: "diff a", truncated: false },
			{ path: "src/b.ts", source: "git-diff", text: "diff b", truncated: false },
		],
		patch_paths: [
			{ path: "src/a.ts", source: "git-diff", bytes: 6, truncated: false },
			{ path: "src/b.ts", source: "git-diff", bytes: 6, truncated: false },
		],
		displayed_paths: undefined as unknown as string[],
		remaining_paths: undefined as unknown as string[],
		coverage_complete: undefined as unknown as boolean,
	};
	const legacyFullText = renderReviewLines(legacyFull).join("\n");
	assert.ok(legacyFullText.includes("displayed  : 2 of 2 worker path(s)"), legacyFullText);
	assert.ok(legacyFullText.includes("coverage   : COMPLETE"), legacyFullText);

	// Malformed persisted coverage: a foreign displayed path and a persisted
	// coverage_complete=true with a non-empty remaining — recomputation from
	// valid checked worker paths wins over both.
	const malformed: ReviewRecord = {
		...base,
		displayed_paths: ["src/a.ts", "not-a-worker.ts"],
		remaining_paths: [],
		coverage_complete: true,
	};
	const malformedText = renderReviewLines(malformed).join("\n");
	assert.ok(malformedText.includes("displayed  : 1 of 2 worker path(s)"), "foreign displayed paths are dropped");
	assert.ok(malformedText.includes("remaining  : 1 worker path(s)"), "remaining is recomputed from checked worker paths");
	assert.ok(malformedText.includes("coverage   : INCOMPLETE"), "persisted coverage_complete is never trusted over recomputation");

	// Malformed empty displayed_paths but actually rendered patch entries:
	// the patch entries still count as displayed evidence.
	const patchOnly: ReviewRecord = {
		...base,
		displayed_paths: [],
		remaining_paths: ["src/a.ts", "src/b.ts"],
		coverage_complete: false,
	};
	const patchOnlyText = renderReviewLines(patchOnly).join("\n");
	assert.ok(patchOnlyText.includes("displayed  : 1 of 2 worker path(s)"), "actually rendered patch entries count as displayed evidence");
	assert.ok(patchOnlyText.includes("remaining  : 1 worker path(s)"), patchOnlyText);
	assert.ok(patchOnlyText.includes("coverage   : INCOMPLETE"), patchOnlyText);
});

test("Slice B2: same-hash merge never trusts a malformed persisted displayed array — the prior record's actually rendered patch entries still count", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "a.ts"), "a1\n", "utf8");
			await writeFile(join(d, "src", "b.ts"), "b1\n", "utf8");
		});
		const current = await collectGitFacts(dir, spawnExec);
		const hash = computeDiffHash(current.changedPaths, current.pathDigests, current.pathStatuses);
		const legacyDir = join(dir, ".pi", "workbench", "delegations", id);
		await mkdir(legacyDir, { recursive: true });
		// Malformed persisted coverage: displayed_paths is EMPTY even though
		// a.ts was ACTUALLY rendered in the persisted patch.
		const prior = {
			schema_version: 1,
			delegation_id: id,
			reviewed_at: NOW,
			verdict: "PASS",
			bound_diff_hash: hash,
			recorded_after_hash: hash,
			mismatch: false,
			drift_paths: [],
			violations: [],
			checked_paths: ["src/a.ts", "src/b.ts"],
			include_paths: [],
			patch: [{ path: "src/a.ts", source: "git-diff", text: "diff a", truncated: false }],
			patch_truncated: false,
			patch_paths: [],
			notes: [],
			displayed_paths: [],
			remaining_paths: ["src/a.ts", "src/b.ts"],
			coverage_complete: false,
		};
		await writeFile(join(legacyDir, "review.json"), JSON.stringify(prior), "utf8");
		const result = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/b.ts"] }));
		assert.ok(result.ok && result.record);
		assert.equal(result.record.bound_diff_hash, hash);
		assert.deepEqual(
			result.record.displayed_paths,
			["src/a.ts", "src/b.ts"],
			"prior patch entries are recomputed into coverage despite the empty malformed array",
		);
		assert.deepEqual(result.record.remaining_paths, []);
		assert.equal(result.record.coverage_complete, true);
	});
});
