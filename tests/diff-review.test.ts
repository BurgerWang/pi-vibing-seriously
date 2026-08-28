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
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { spawnExec, withTempDir } from "./helpers.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import {
	collectAfterFacts,
	collectGitFacts,
	computeDiffHash,
	contentDigest,
	makeDelegationId,
	MAX_DIGEST_BYTES,
	readDelegationLedger,
	type LedgerWorkerFacts,
} from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import {
	createLegacyDelegationFixture as createDelegationLedger,
	finishLegacyDelegationFixture as finishDelegationLedger,
} from "./legacy-delegation-fixture.ts";
import {
	COMPACT_GENERATOR_EQUALITY,
	COMPACT_MIN_BYTES,
	COMPACT_PREVIEW_LINES,
	COMPACT_PREVIEW_MAX_BYTES,
	DEFAULT_REVIEW_MAX_BYTES,
	DEFAULT_REVIEW_MAX_LINES,
	MAX_REVIEW_GUIDANCE_BYTES,
	MAX_REVIEW_PATCH_PATHS,
	MAX_REVIEW_VIOLATIONS,
	MAX_REVIEW_NOTES,
	MAX_REVIEW_DRIFT_PATHS,
	REVIEW_ERROR_MAX_BYTES,
	REVIEW_RECORD_MAX_BYTES,
	mergeReviewCoverage,
	normalizeReviewCoverage,
	isStrictSemanticAcceptedOrZeroDelta,
	readReviewRecord,
	renderReviewLines,
	reviewDelegation,
	reviewRecordRelPath,
	suffixUtf8,
	WITHHELD_MARKER,
	type ReviewCompactFacts,
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

/** Wrap an ExecFn and record every call — proves which git commands a review runs. */
function recordingExec(inner: ExecFn): { exec: ExecFn; calls: { command: string; args: string[] }[] } {
	const calls: { command: string; args: string[] }[] = [];
	const exec: ExecFn = (command, args, options) => {
		calls.push({ command, args: [...args] });
		return inner(command, args, options);
	};
	return { exec, calls };
}

/**
 * Phase 5 common compact-facts invariants: exact status/size, a FRESH
 * current sha256 content digest (never a stale or derived value), the fixed
 * digest bounds, an honest NOT_VERIFIED generator equality, honest content
 * truncation, and non-empty JSON-decodable UTF-8-safe head/tail previews
 * bounded by COMPACT_PREVIEW_MAX_BYTES.
 */
function assertCompactFactsCommon(facts: ReviewCompactFacts, status: string, sizeBytes: number, digest: string): void {
	assert.equal(facts.git_status, status);
	assert.equal(facts.size_bytes, sizeBytes);
	assert.equal(facts.digest, digest, "compact digest is the fresh current content digest");
	assert.match(facts.digest, /^[0-9a-f]{64}$/, "full sha256 digest form (file ≤ MAX_DIGEST_BYTES)");
	assert.equal(facts.digest_kind, "sha256");
	assert.equal(facts.digest_max_bytes, MAX_DIGEST_BYTES);
	assert.equal(facts.digest_matches_after, true, "current digest equals the worker's recorded-after digest");
	assert.equal(facts.generator_equality, COMPACT_GENERATOR_EQUALITY, "generator equality is never verified");
	assert.equal(facts.content_truncated, true, "eligible files always exceed the shown preview bytes");
	for (const preview of [facts.head_preview, facts.tail_preview]) {
		const decoded = JSON.parse(preview) as string;
		assert.ok(decoded.length > 0, "preview is never empty for a non-empty window");
		assert.ok(Buffer.byteLength(decoded, "utf8") <= COMPACT_PREVIEW_MAX_BYTES, "preview respects COMPACT_PREVIEW_MAX_BYTES");
		assert.ok(!decoded.includes("\uFFFD"), "preview contains no UTF-8 replacement characters");
		assert.equal(Buffer.from(decoded, "utf8").toString("utf8"), decoded, "preview round-trips as valid UTF-8");
	}
}

/** Phase 5: secrets must never reach the structured record or its rendered lines. */
function assertSecretsAbsent(record: ReviewRecord, secrets: readonly string[]): void {
	const raw = JSON.stringify(record);
	const rendered = renderReviewLines(record).join("\n");
	for (const secret of secrets) {
		assert.ok(!raw.includes(secret), `secret ${secret} leaked into the structured review record`);
		assert.ok(!rendered.includes(secret), `secret ${secret} leaked into the rendered review lines`);
	}
}

function assertWholeReviewBound(lines: readonly string[], maxBytes = DEFAULT_REVIEW_MAX_BYTES, maxLines = DEFAULT_REVIEW_MAX_LINES): string {
	const text = lines.join("\n");
	assert.ok(Buffer.byteLength(text, "utf8") <= maxBytes, `${Buffer.byteLength(text, "utf8")} > ${maxBytes}`);
	assert.ok(lines.length <= maxLines, `${lines.length} > ${maxLines}`);
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			assert.ok(next >= 0xdc00 && next <= 0xdfff, "rendered output contains a lone high surrogate");
			index += 1;
		} else assert.ok(unit < 0xdc00 || unit > 0xdfff, "rendered output contains a lone low surrogate");
	}
	return text;
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
		const reviewPath = join(dir, ".pi", "workbench", "delegations", id, "review.json");
		const rawReview = await readFile(reviewPath, "utf8");
		assert.ok(Buffer.byteLength(rawReview, "utf8") <= REVIEW_RECORD_MAX_BYTES, "a successful review always fits its bounded reader");
		assert.deepEqual(JSON.parse(rawReview), JSON.parse(JSON.stringify(record)), "the complete returned authority facts roundtrip without truncation");
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
		assert.equal(refused.error, "include_path_not_in_diff: include_paths entry is not part of the worker diff");
		assert.doesNotMatch(refused.error ?? "", /never-changed|src\/main/, "fixed error prose never echoes caller args or path lists");
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
		assert.ok(record.notes.some((n) => n.includes("authority binding differs")), "mismatch is recorded as a warning");
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
		const result = await reviewDelegation(reviewInput(dir, id, { maxBytes: 4_096, maxLines: 40 }));
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		assert.equal(record.verdict, "PASS");
		const entry = record.patch.find((p) => p.path === "src/huge.ts");
		assert.ok(entry, "huge untracked file appears in the patch");
		assert.equal(entry.source, "file-content");
		assert.equal(entry.truncated, true, "oversized untracked file is prefix-truncated");
		assert.ok(Buffer.byteLength(entry.text, "utf8") <= 4_096, "patch bytes stay within the bound");
	});
});

test("a single 14 KiB untracked source resumes the same hash-bound page until fully presented", async () => {
	await withTempDir(async (dir) => {
		const source = Array.from({ length: 357 }, (_, index) =>
			`def test_page_${String(index).padStart(3, "0")}(): assert ${index} >= 0  # page`,
		).join("\n") + "\n";
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "large.py"), source, "utf8");
		});
		const first = await reviewDelegation(reviewInput(dir, id, {
			includePaths: ["src/large.py"], maxBytes: 32_000, maxLines: 398,
		}));
		assert.ok(first.ok, first.error ?? "first page failed");
		const firstEntry = first.record?.patch[0];
		assert.equal(firstEntry?.source, "file-content");
		assert.equal(firstEntry?.page?.start_byte, 0);
		assert.equal(first.record?.presentation_complete, false);

		const second = await reviewDelegation(reviewInput(dir, id, {
			includePaths: ["src/large.py"], maxBytes: 32_000, maxLines: 398,
		}));
		assert.ok(second.ok, second.error ?? "second page failed");
		const secondEntry = second.record?.patch[0];
		assert.equal(secondEntry?.page?.start_byte, firstEntry?.page?.end_byte);
		assert.equal(secondEntry?.page?.end_byte, Buffer.byteLength(source, "utf8"));
		assert.equal(second.record?.presentation_complete, true);
		assert.deepEqual(second.record?.fully_presented_paths, ["src/large.py"]);
		assert.equal(`${firstEntry?.text ?? ""}${secondEntry?.text ?? ""}`, source);
		assert.match(second.lines.join("\n"), /complete across contiguous hash-bound pages/);
	});
});

test("ordinary-source page progress resets to byte zero when the bound diff changes", async () => {
	await withTempDir(async (dir) => {
		const source = Array.from({ length: 357 }, (_, index) =>
			`def test_page_${String(index).padStart(3, "0")}(): assert ${index} >= 0  # page`,
		).join("\n") + "\n";
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "large.py"), source, "utf8");
		});
		const first = await reviewDelegation(reviewInput(dir, id, {
			includePaths: ["src/large.py"], maxBytes: 32_000, maxLines: 398,
		}));
		assert.ok(first.ok, first.error ?? "first page failed");
		assert.ok((first.record?.presentation_progress?.[0]?.next_byte ?? 0) > 0);
		const firstHash = first.record?.bound_diff_hash;

		await writeFile(join(dir, "src", "large.py"), `${source}# later drift\n`, "utf8");
		const changed = await reviewDelegation(reviewInput(dir, id, {
			includePaths: ["src/large.py"], maxBytes: 32_000, maxLines: 398,
		}));
		assert.ok(changed.ok, changed.error ?? "changed page failed");
		assert.notEqual(changed.record?.bound_diff_hash, firstHash);
		assert.equal(changed.record?.patch[0]?.page?.start_byte, 0, "same-path progress from another binding is never reused");
		assert.equal(changed.record?.presentation_complete, false);
		assert.ok(changed.record?.mismatch);
		assert.ok((changed.record?.drift_paths.length ?? 0) > 0);
	});
});

test("same-bound redaction-stream changes reset the cursor without retaining old completion", async () => {
	await withTempDir(async (dir) => {
		const secret = "very-long-secret-token-123456789";
		const source = Array.from({ length: 357 }, (_, index) =>
			`value_${String(index).padStart(3, "0")} = ${JSON.stringify(secret)}  # unchanged bytes`,
		).join("\n") + "\n";
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "large.py"), source, "utf8");
		});
		let redacted = await reviewDelegation(reviewInput(dir, id, {
			includePaths: ["src/large.py"], maxBytes: 32_000, maxLines: 398, secrets: [secret],
		}));
		assert.ok(redacted.ok, redacted.error ?? "redacted page failed");
		while (!redacted.record?.presentation_complete) {
			redacted = await reviewDelegation(reviewInput(dir, id, {
				includePaths: ["src/large.py"], maxBytes: 32_000, maxLines: 398, secrets: [secret],
			}));
			assert.ok(redacted.ok, redacted.error ?? "redacted continuation failed");
		}
		const boundHash = redacted.record.bound_diff_hash;
		const oldStreamHash = redacted.record.presentation_progress?.[0]?.stream_sha256;

		const reset = await reviewDelegation(reviewInput(dir, id, {
			includePaths: ["src/large.py"], maxBytes: 32_000, maxLines: 398, secrets: [],
		}));
		assert.ok(reset.ok, reset.error ?? "same-bound stream reset failed");
		assert.equal(reset.record?.bound_diff_hash, boundHash, "redaction policy is presentation-only, not workspace authority");
		assert.equal(reset.record?.patch[0]?.page?.start_byte, 0);
		assert.notEqual(reset.record?.presentation_progress?.[0]?.stream_sha256, oldStreamHash);
		assert.equal(reset.record?.presentation_complete, false);
		assert.deepEqual(reset.record?.fully_presented_paths, [], "old completed stream cannot complete a different same-bound stream");
	});
});

test("a 3 KiB review envelope either advances the selected page or fails explicitly", async () => {
	await withTempDir(async (dir) => {
		const source = Array.from({ length: 357 }, (_, index) =>
			`def test_low_budget_${String(index).padStart(3, "0")}(): assert ${index} >= 0`,
		).join("\n") + "\n";
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "large.py"), source, "utf8");
		});
		const result = await reviewDelegation(reviewInput(dir, id, {
			includePaths: ["src/large.py"], maxBytes: 3_000, maxLines: 50,
		}));
		assert.ok(result.ok, result.error ?? "low-budget review failed");
		const page = result.record?.patch[0]?.page;
		assert.ok(page, "a successful low-budget response cannot silently omit its continuation page");
		assert.equal(page.start_byte, 0);
		assert.ok(page.end_byte > 0);
		assert.equal(result.record?.presentation_progress?.[0]?.next_byte, page.end_byte);
	});
});

test("a multi-path entry that is only partly visible is persisted as truncated, never as complete presentation evidence", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "a-small.ts"), "export const small = true;\n", "utf8");
			await writeFile(join(d, "src", "b-large.ts"), "export const value = 1;\n".repeat(120), "utf8");
		});
		const result = await reviewDelegation(reviewInput(dir, id, {
			maxBytes: 3_000,
			maxLines: 80,
		}));
		assert.ok(result.ok, result.error ?? "bounded multi-path review failed");
		const record = result.record!;
		assert.ok(record.patch.some((entry) => entry.truncated), "the straddling visible entry is explicitly incomplete");
		for (const entry of record.patch.filter((candidate) => !candidate.truncated)) {
			const progress = record.presentation_progress?.find((item) => item.path === entry.path);
			assert.ok(progress, `complete entry ${entry.path} has persisted presentation progress`);
			assert.equal(progress.next_byte, progress.total_bytes);
		}
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
			reviewInput(dir, id, { maxBytes: 3_000, maxLines: 100, secrets: ["pad-secret-token-xyz"] }),
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
			rendered.includes("bounded presentation segments via workbench_review_worker_diff include_paths"),
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
		const result = await reviewDelegation(reviewInput(dir, id, { maxBytes: 4_096, maxLines: 40, secrets: ["pad-secret-token-xyz"] }));
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		assert.equal(record.verdict, "PASS");
		const patchText = record.patch.map((p) => p.text).join("\n");
		assert.ok(!patchText.includes("pad-secret-token-xyz"), "secrets scrubbed from the patch");
		assert.ok(record.patch_truncated, "oversized patch is truncated");
		assert.ok(Buffer.byteLength(patchText, "utf8") <= 4_096, "patch bytes stay within the bound");
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

test("readReviewRecord bounds review.json before allocation and fails closed for non-regular, corrupt, foreign, mismatched, and pending records", async () => {
	await withTempDir(async (dir) => {
		const id = "20260601-120000-abcd";
		const recordDir = join(dir, ".pi", "workbench", "delegations", id);
		const recordPath = join(recordDir, "review.json");
		await mkdir(recordDir, { recursive: true });

		// A sparse record above the fixed 1 MiB cap is rejected from the same
		// open-handle stat before any content buffer or read is attempted.
		const sparse = await open(recordPath, "w", 0o600);
		try { await sparse.truncate(REVIEW_RECORD_MAX_BYTES + 1); }
		finally { await sparse.close(); }
		const allocations: number[] = [];
		const reads: number[] = [];
		assert.equal(await readReviewRecord(dir, id, {
			onBufferAllocate(bytes) { allocations.push(bytes); },
			beforeRead(bytes) { reads.push(bytes); },
		}), null);
		assert.deepEqual(allocations, [], "oversized review record is rejected before allocation");
		assert.deepEqual(reads, [], "oversized review record is rejected before read");

		// A directory at review.json is non-regular and therefore unavailable.
		await rm(recordPath, { force: true });
		await mkdir(recordPath);
		assert.equal(await readReviewRecord(dir, id), null);
		await rm(recordPath, { recursive: true });

		await writeFile(recordPath, Buffer.from([0x7b, 0xff, 0x7d]));
		assert.equal(await readReviewRecord(dir, id), null, "invalid UTF-8 fails closed");
		await writeFile(recordPath, "{not-json}", "utf8");
		assert.equal(await readReviewRecord(dir, id), null, "invalid JSON fails closed");
		await writeFile(recordPath, JSON.stringify({ schema_version: 1, delegation_id: "20260601-120000-efgh" }), "utf8");
		assert.equal(await readReviewRecord(dir, id), null, "foreign delegation record fails closed");
		await writeFile(recordPath, JSON.stringify({ schema_version: 2, delegation_id: id }), "utf8");
		assert.equal(await readReviewRecord(dir, id), null, "schema version mismatch fails closed");
		await writeFile(recordPath, JSON.stringify({ schema_version: 1, delegation_id: id, review_status: "PENDING_REVIEW" }), "utf8");
		assert.equal(await readReviewRecord(dir, id), null, "finish-time placeholder is not a completed review");

		// Legacy schema-v1 records remain readable without the additive
		// coverage fields; existing merge tests exercise their coverage use.
		const legacy = {
			schema_version: 1,
			delegation_id: id,
			reviewed_at: NOW,
			verdict: "PASS",
			bound_diff_hash: "a".repeat(64),
			recorded_after_hash: "a".repeat(64),
			mismatch: false,
			drift_paths: [],
			violations: [],
			checked_paths: [],
			include_paths: [],
			patch: [],
			patch_truncated: false,
			patch_paths: [],
			notes: [],
		};
		await writeFile(recordPath, JSON.stringify(legacy), "utf8");
		const readable = await readReviewRecord(dir, id);
		assert.ok(readable);
		assert.equal(readable.verdict, "PASS");
	});
});

test("500 worst-case long violating paths fail review persistence closed without replacing the readable placeholder", async () => {
	await withTempDir(async (dir) => {
		const segmentA = "a".repeat(180);
		const segmentB = "b".repeat(180);
		const { id } = await setupDelegation(
			dir,
			async (root) => {
				const outsideDir = join(root, "outside", segmentA, segmentB);
				await mkdir(outsideDir, { recursive: true });
				for (let start = 0; start < 500; start += 50) {
					await Promise.all(Array.from({ length: 50 }, (_, offset) => {
						const index = start + offset;
						return writeFile(join(outsideDir, `p${String(index).padStart(3, "0")}.txt`), "x\n", "utf8");
					}));
				}
			},
			["allowed/**"],
		);
		const ledger = await readDelegationLedger(dir, id);
		assert.ok(ledger?.after);
		assert.equal(ledger.after.changed_since_before.length, 500, "the authority test reaches the complete maximum path set");
		assert.ok(ledger.after.changed_since_before.every((path) => path.length > 370), "every path is near the fixed 400-character boundary");

		const reviewPath = join(dir, ".pi", "workbench", "delegations", id, "review.json");
		const placeholder = await readFile(reviewPath, "utf8");
		assert.match(placeholder, /"review_status": "PENDING_REVIEW"/);
		assert.ok(Buffer.byteLength(placeholder, "utf8") <= REVIEW_RECORD_MAX_BYTES);

		const result = await reviewDelegation(reviewInput(dir, id));
		assert.equal(result.ok, false, "an unpersistable complete review can never be returned as successful authority");
		assert.equal(result.error, "review_persist_failed: failed to write review record");
		assert.equal(result.record, undefined, "no silently truncated record is exposed to the caller");
		assert.deepEqual(result.lines, [
			"[workbench-diff-review error code=review_persist_failed]",
			"failed to write review record",
		]);
		assert.equal(await readFile(reviewPath, "utf8"), placeholder, "preflight happens before the atomic writer and leaves prior readable authority untouched");
		assert.equal(await readReviewRecord(dir, id), null, "the untouched pending placeholder is never mistaken for a completed review");
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
		assert.equal(lines[0], "review kind: scope_integrity (mechanical; no semantic-quality or Gate authority)");
		assert.ok(text.includes("scope check: PASS"));
		assert.ok(text.includes("bound hash : "));
		assert.ok(text.includes("after hash : "));
		assert.ok(text.includes("--- src/main.ts (git-diff"));
		// The scope note is part of the rendered output.
		assert.ok(text.includes("Scope checks always cover the entire worker diff"));
	});
});

test("small review renderer keeps the compact v1 text format stable", () => {
	const reviewPath = ".pi/workbench/delegations/20260601-120000-abcd/review.json";
	const record: ReviewRecord = {
		schema_version: 1,
		delegation_id: "20260601-120000-abcd",
		reviewed_at: NOW,
		verdict: "PASS",
		bound_diff_hash: "a".repeat(64),
		recorded_after_hash: "a".repeat(64),
		mismatch: false,
		drift_paths: [],
		violations: [],
		allowed_paths: ["src/**"],
		checked_paths: ["src/a.ts"],
		include_paths: ["src/a.ts"],
		patch: [{ path: "src/a.ts", source: "git-diff", text: "+a", truncated: false }],
		patch_truncated: false,
		patch_paths: [{ path: "src/a.ts", source: "git-diff", bytes: 2, truncated: false }],
		notes: [],
		displayed_paths: ["src/a.ts"],
		remaining_paths: [],
		coverage_complete: true,
		review_path: reviewPath,
	};
	const allowedHash = createHash("sha256").update(JSON.stringify(["src/**"])).digest("hex");
	assert.deepEqual(renderReviewLines(record), [
		"review kind: scope_integrity (mechanical; no semantic-quality or Gate authority)",
		"delegation : 20260601-120000-abcd",
		"scope check: PASS",
		`inspected  : ${NOW}`,
		`bound hash : ${"a".repeat(64)}`,
		`after hash : ${"a".repeat(64)}`,
		"checked    : 1 worker path(s)",
		"displayed  : 1 of 1 worker path(s)",
		"remaining  : 0 worker path(s)",
		"coverage   : COMPLETE — every worker path has a bounded scope/integrity segment",
		"evidence   : COMPLETE — each worker path has a full patch or strict compact fact packet",
		"semantic   : REQUIRED (medium risk; explicit Sol ACCEPT must bind this hash)",
		`packet stats: violations=0/0/0; notes=0/0/0; drift=0/0/0; patch=1/1/0; stats=1/1/0; full=${reviewPath}; scope/integrity evidence is not semantic acceptance or Gate authority`,
		"next incl. : (none — every worker path displayed for this bound hash)",
		`scope artifact: ${reviewPath}`,
		`allowed    : count=1 hash=${allowedHash} shown=["src/**"] omitted=0`,
		"patch (1 path(s), shown 1, omitted 0):",
		"--- src/a.ts (git-diff) ---",
		"+a",
		"patch paths (1): original=1 shown=1 omitted=0",
		"  - src/a.ts (git-diff, 2 bytes)",
		"Scope checks always cover the entire worker diff; include_paths only narrows the bounded patch above.",
	]);
});

test("strict semantic authority accepts only an exact schema-2 Sol decision or a genuinely empty delta", () => {
	const base: ReviewRecord = {
		schema_version: 1,
		delegation_id: "20260601-120000-abcd",
		reviewed_at: NOW,
		verdict: "PASS",
		bound_diff_hash: "a".repeat(64),
		recorded_after_hash: "a".repeat(64),
		mismatch: false,
		drift_paths: [],
		violations: [],
		allowed_paths: ["src/**"],
		checked_paths: ["src/a.ts"],
		include_paths: ["src/a.ts"],
		patch: [{ path: "src/a.ts", source: "git-diff", text: "+a", truncated: false }],
		patch_truncated: false,
		patch_paths: [{ path: "src/a.ts", source: "git-diff", bytes: 2, truncated: false }],
		notes: [],
		displayed_paths: ["src/a.ts"],
		remaining_paths: [],
		coverage_complete: true,
		fully_presented_paths: ["src/a.ts"],
		presentation_remaining_paths: [],
		presentation_complete: true,
		semantic_review: "required",
		review_path: ".pi/workbench/delegations/20260601-120000-abcd/review.json",
	};
	assert.equal(isStrictSemanticAcceptedOrZeroDelta(base), false, "historical mechanical REVIEWED is never semantic authority");

	const accepted: ReviewRecord = {
		...base,
		schema_version: 2,
		semantic_review: "accepted",
		semantic_acceptance: {
			decision: "ACCEPT",
			expected_bound_diff_hash: base.bound_diff_hash,
			reviewer: { provider: "openai-codex", model: "gpt-5.6-sol" },
			accepted_at: NOW,
		},
	};
	assert.equal(isStrictSemanticAcceptedOrZeroDelta(accepted), true);
	assert.equal(isStrictSemanticAcceptedOrZeroDelta({
		...accepted,
		semantic_acceptance: { ...accepted.semantic_acceptance!, expected_bound_diff_hash: "b".repeat(64) },
	}), false, "acceptance must bind the exact packet hash");
	for (const hostileAcceptance of [null, "ACCEPT", { decision: "ACCEPT" }, { ...accepted.semantic_acceptance, reviewer: null }]) {
		assert.doesNotThrow(() => {
			assert.equal(isStrictSemanticAcceptedOrZeroDelta({
				...accepted,
				semantic_acceptance: hostileAcceptance,
			} as unknown as ReviewRecord), false);
		}, "malformed legacy semantic acceptance fails closed without throwing");
	}
	const hostileReviewer = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("hostile"); } });
	assert.equal(isStrictSemanticAcceptedOrZeroDelta({
		...accepted,
		semantic_acceptance: { ...accepted.semantic_acceptance!, reviewer: hostileReviewer },
	} as unknown as ReviewRecord), false, "hostile nested acceptance data fails closed");

	const empty: ReviewRecord = {
		...base,
		checked_paths: [],
		include_paths: [],
		patch: [],
		patch_paths: [],
		displayed_paths: [],
		fully_presented_paths: [],
		semantic_review: undefined,
	};
	assert.equal(isStrictSemanticAcceptedOrZeroDelta(empty), true, "historical zero delta needs no semantic decision");
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
		assert.ok(rendered.includes("bounded presentation segments via workbench_review_worker_diff include_paths"), "segmented include_paths instruction when truncated");
		assert.ok(rendered.includes("patch paths (3)"), "bounded path/stat info rendered");
	});
});

test("whole renderer bounds 500 paths and exact section omissions under one 32 KiB / 400-line envelope", () => {
	const paths = Array.from({ length: 500 }, (_, index) => `src/${String(index).padStart(3, "0")}-${"汉🙂".repeat(30)}.ts`);
	const allowedPaths = Array.from({ length: 50 }, (_, index) => `scope-${index}/${"a".repeat(280)}/**`);
	const record: ReviewRecord = {
		schema_version: 1,
		delegation_id: "20260601-120000-abcd",
		reviewed_at: NOW,
		verdict: "FAIL",
		bound_diff_hash: "a".repeat(64),
		recorded_after_hash: "b".repeat(64),
		mismatch: true,
		drift_paths: paths.slice(0, 80),
		violations: paths.slice(0, 80).map((path, index) => ({
			path,
			reason: `outside scope ${index}: ${allowedPaths.join(", ")}`,
		})),
		allowed_paths: allowedPaths,
		checked_paths: paths,
		include_paths: paths,
		patch: paths.slice(0, 50).map((path) => ({
			path, source: "git-diff", text: `@@ ${path} @@\n${"变更🙂\n".repeat(40)}`, truncated: true,
		})),
		patch_truncated: true,
		patch_paths: paths.slice(0, 50).map((path) => ({ path, source: "git-diff", bytes: 1_000, truncated: true })),
		notes: Array.from({ length: 40 }, (_, index) => `note-${index}-${"注🙂".repeat(150)}`),
		displayed_paths: paths.slice(0, 50),
		remaining_paths: paths.slice(50),
		coverage_complete: false,
		review_path: ".pi/workbench/delegations/20260601-120000-abcd/review.json",
	};
	const rendered = renderReviewLines(record);
	const text = assertWholeReviewBound(rendered);
	assert.deepEqual(rendered, renderReviewLines(record), "the same domain record renders byte-identically");
	const firstPatch = text.indexOf(`--- ${paths[0]} (git-diff, truncated) ---`);
	const secondPatch = text.indexOf(`--- ${paths[1]} (git-diff, truncated) ---`);
	assert.ok(firstPatch >= 0 && secondPatch > firstPatch, "bounded patch entries preserve deterministic source order");
	const summary = /packet stats: violations=(\d+)\/(\d+)\/(\d+); notes=(\d+)\/(\d+)\/(\d+); drift=(\d+)\/(\d+)\/(\d+);/.exec(text);
	assert.ok(summary, text);
	const values = summary.slice(1).map(Number);
	assert.deepEqual([values[0], values[3], values[6]], [80, 40, 80]);
	assert.equal(values[1]! + values[2]!, values[0]);
	assert.equal(values[4]! + values[5]!, values[3]);
	assert.equal(values[7]! + values[8]!, values[6]);
	assert.ok(values[1]! <= MAX_REVIEW_VIOLATIONS);
	assert.ok(values[4]! <= MAX_REVIEW_NOTES);
	assert.ok(values[7]! <= MAX_REVIEW_DRIFT_PATHS);
	assert.match(text, /patch=500\/\d+\/\d+; stats=500\/\d+\/\d+;/);
	assert.match(text, /allowed    : count=50 hash=[0-9a-f]{64} shown=\[.*\] omitted=\d+/);
	assert.equal((text.match(/^allowed    :/gm) ?? []).length, 1, "allowed scope prose is rendered once, not once per violation");
	assert.equal((text.match(/^violation  :/gm) ?? []).length, values[1]);
	assert.equal((text.match(/^note       :/gm) ?? []).length, values[4]);
	assert.equal((text.match(/^drift      :/gm) ?? []).length, values[7]);
	assert.match(text, /full=\.pi\/workbench\/delegations\/20260601-120000-abcd\/review\.json/);
	assert.match(text, /scope\/integrity evidence is not semantic acceptance or Gate authority/);
});

test("whole renderer honors caller lower caps and keeps its omission marker inside the cap", () => {
	const paths = Array.from({ length: 60 }, (_, index) => `src/path-${index}.ts`);
	const record: ReviewRecord = {
		schema_version: 1, delegation_id: "20260601-120000-abcd", reviewed_at: NOW, verdict: "PASS",
		bound_diff_hash: "a".repeat(64), recorded_after_hash: "a".repeat(64), mismatch: false,
		drift_paths: [], violations: [], allowed_paths: ["src/**"], checked_paths: paths, include_paths: paths,
		patch: paths.slice(0, 50).map((path) => ({ path, source: "file-content", text: `${"🙂汉x\n".repeat(80)}tail`, truncated: true })),
		patch_truncated: true,
		patch_paths: paths.slice(0, 50).map((path) => ({ path, source: "file-content", bytes: 4_000, truncated: true })),
		notes: [], displayed_paths: paths.slice(0, 50), remaining_paths: paths.slice(50), coverage_complete: false,
		review_path: ".pi/workbench/delegations/20260601-120000-abcd/review.json",
	};
	const text = assertWholeReviewBound(renderReviewLines(record, { maxBytes: 4_096, maxLines: 40 }), 4_096, 40);
	assert.match(text, /Patch content truncated or omitted/);
	assert.match(text, /patch \(60 path\(s\), shown \d+, omitted \d+, truncated\):/);
	assert.match(text, /patch paths \(60\): original=60 shown=\d+ omitted=\d+/);
});

test("review error paths are fixed, bounded, and never expose hostile messages, args, or stacks", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(dir, async (root) => {
			await writeFile(join(root, "src", "main.ts"), "v2\n", "utf8");
		});
		const secret = `SECRET-${"🙂".repeat(3_000)}`;
		const result = await reviewDelegation(reviewInput(dir, id, {
			exec: async () => { const error = new Error(secret); error.stack = `${secret}\nSTACK`; throw error; },
		}));
		assert.equal(result.ok, false);
		const text = assertWholeReviewBound(result.lines, REVIEW_ERROR_MAX_BYTES, 20);
		assert.equal(text, "[workbench-diff-review error code=git_state_unavailable]\ncannot collect the real git state; git status --porcelain failed");
		assert.equal(result.error, "git_state_unavailable: cannot collect the real git state; git status --porcelain failed");
		assert.doesNotMatch(`${text}\n${result.error}`, /SECRET|STACK/);

		const hostile = await reviewDelegation({
			...reviewInput(dir, id),
			includePaths: [{ trim() { throw new Error(secret); } } as unknown as string],
		});
		assert.equal(hostile.ok, false);
		assert.equal(hostile.error, "runtime_failure: diff review failed closed");
		assert.ok(Buffer.byteLength(hostile.lines.join("\n"), "utf8") <= REVIEW_ERROR_MAX_BYTES);
		assert.doesNotMatch(`${hostile.lines.join("\n")}\n${hostile.error}`, /SECRET|STACK/);
	});
});

// ---------------------------------------------------------------------------
// Slice B2 — displayed-path coverage (segmented actual-diff review)
// ---------------------------------------------------------------------------

test("Slice B2: displayed and remaining coverage preserve trusted Unicode worker order", () => {
	const byteFirst = "src/\uE000.ts";
	const byteSecond = "src/😀.ts";
	const workerPaths = [byteFirst, byteSecond];
	assert.ok(Buffer.from(byteFirst).compare(Buffer.from(byteSecond)) < 0, "fixture is UTF-8 byte canonical");
	assert.ok(byteFirst > byteSecond, "fixture differs from default JavaScript UTF-16 ordering");

	const merged = mergeReviewCoverage(workerPaths, [byteSecond, byteFirst], null, "a".repeat(64));
	assert.deepEqual(merged.displayed_paths, workerPaths, "render order cannot replace worker authority order");
	assert.deepEqual(merged.remaining_paths, []);

	const normalized = normalizeReviewCoverage({
		checked_paths: workerPaths,
		displayed_paths: [byteSecond, byteFirst],
		remaining_paths: [],
		patch: [],
	} as unknown as ReviewRecord);
	assert.deepEqual(normalized.displayed_paths, workerPaths, "render normalization projects coverage through checked order");
	assert.deepEqual(normalized.remaining_paths, []);
});

test("Slice B2: displayed coverage can complete while ordinary truncated source presentation remains blocking", async () => {
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
		assert.deepEqual(record.fully_presented_paths, [], "a line-cut ordinary source entry is not complete semantic-review evidence");
		assert.deepEqual(record.presentation_remaining_paths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
		assert.equal(record.presentation_complete, false);
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
		assert.ok(rendered2.includes(`next incl. : ["src/a.ts", "src/b.ts", "src/c.ts"] (max ${MAX_REVIEW_PATCH_PATHS} paths per call; ≤ ${MAX_REVIEW_GUIDANCE_BYTES} bytes)`), rendered2);

		// Segment 3: the last path completes coverage.
		const third = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/c.ts"] }));
		assert.ok(third.ok, third.error ?? "review failed");
		record = third.record!;
		assert.deepEqual(record.displayed_paths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
		assert.deepEqual(record.remaining_paths, []);
		assert.equal(record.coverage_complete, true, "mechanical displayed-path coverage is complete");
		assert.equal(record.presentation_complete, false, "ordinary source truncation remains blocking even after every path has a bounded segment");
		assert.deepEqual(record.fully_presented_paths, []);
		assert.deepEqual(record.presentation_remaining_paths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
		assert.equal(record.bound_diff_hash, afterHash, "scope checks and the bound hash covered the complete diff in every segment");
		assert.deepEqual(record.checked_paths.sort(), ["src/a.ts", "src/b.ts", "src/c.ts"]);
		const rendered = renderReviewLines(record).join("\n");
		assert.ok(rendered.includes("displayed  : 3 of 3 worker path(s)"), rendered);
		assert.ok(rendered.includes("remaining  : 0 worker path(s)"), rendered);
		assert.ok(rendered.includes("coverage   : COMPLETE"), rendered);
		assert.ok(rendered.includes("evidence   : INCOMPLETE"), rendered);
		assert.ok(rendered.includes(`next incl. : ["src/a.ts", "src/b.ts", "src/c.ts"] (max ${MAX_REVIEW_PATCH_PATHS} paths per call; ≤ ${MAX_REVIEW_GUIDANCE_BYTES} bytes)`), rendered);
		assert.ok(rendered.includes(`scope artifact: .pi/workbench/delegations/${id}/review.json`), rendered);
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
	// Two valid ~250-byte paths and one path that exceeds both the per-path
	// presentation cap and the aggregate guidance cap.
	const longA = `src/${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(60)}/${"g".repeat(60)}.ts`;
	const longB = `src/${"k".repeat(60)}/${"l".repeat(60)}/${"m".repeat(60)}/${"n".repeat(60)}.ts`;
	const huge = `src/${"r".repeat(200)}/${"s".repeat(200)}/${"t".repeat(200)}/${"u".repeat(200)}/${"v".repeat(200)}/${"w".repeat(200)}/${"x".repeat(300)}.ts`;
	assert.ok(Buffer.byteLength(longA, "utf8") >= 240, "longA is a ~250-byte valid path");
	assert.ok(Buffer.byteLength(longB, "utf8") >= 240, "longB is a ~250-byte valid path");
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
	assert.ok(listed.length >= 2, `the two ~250-byte paths fit within the byte cap (listed ${listed.length})`);
	// Every listed path is a COMPLETE usable path string — never truncated.
	for (const path of listed) {
		assert.ok([longA, longB].includes(path), `only complete remaining paths are listed, got ${path}`);
	}
	assert.ok(guidance!.includes("+1 more"), "the byte-exceeding path is counted exactly in the omitted count");
	assert.ok(!guidance!.includes(huge.slice(0, 40)), "an overlong path is never truncated into the guidance");
	// The path list itself never exceeds the fixed byte cap: an unbounded
	// 50-path line is impossible even with long bounded paths.
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

// ---------------------------------------------------------------------------
// Phase 5 (Execution Efficiency Optimization): compact facts — first tranche
// ---------------------------------------------------------------------------

test("Phase 5: a tracked modified large SVG and an untracked minified single-line JSON render as compact facts (fresh sha256 digests, redacted bounded head/tail previews, no per-path git diff) and segmented include_paths reviews merge displayed coverage", async () => {
	await withTempDir(async (dir) => {
		const svgSecret = "SVG_HEAD_SECRET_9d41c2f7";
		const jsonHeadSecret = "JSON_HEAD_SECRET_c41a77e3";
		const jsonTailSecret = "JSON_TAIL_SECRET_8b2f9d51";
		const secrets = [svgSecret, jsonHeadSecret, jsonTailSecret];

		// Multi-line SVG > 32 KiB with a secret token near its head.
		const svgLines = [
			'<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048" viewBox="0 0 2048 2048">',
			`  <!-- ${svgSecret} -->`,
			'  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
			'    <stop offset="0" stop-color="#123456"/>',
			'    <stop offset="1" stop-color="#654321"/>',
			"  </linearGradient></defs>",
		];
		for (let i = 0; i < 700; i++) {
			svgLines.push(`  <path d="M${i % 97} ${i % 89} L${i % 53} ${i % 61} Z" fill="url(#g)" stroke="#000" stroke-width="0.5"/>`);
		}
		svgLines.push("</svg>");
		const svgContent = svgLines.join("\n") + "\n";
		assert.ok(Buffer.byteLength(svgContent, "utf8") > COMPACT_MIN_BYTES, "the SVG must exceed COMPACT_MIN_BYTES");

		// Minified single-line VALID JSON > 32 KiB with unique secret tokens
		// and UTF-8 emoji/CJK near both its head and its tail.
		const jsonContent = JSON.stringify({
			meta: { token: jsonHeadSecret, label: "🎨数据头", generatedBy: "minifier", version: 3 },
			payload: "x".repeat(34_000),
			tail: { token: jsonTailSecret, label: "尾数据🎉", done: true },
		});
		assert.ok(Buffer.byteLength(jsonContent, "utf8") > COMPACT_MIN_BYTES, "the JSON must exceed COMPACT_MIN_BYTES");
		assert.ok(!jsonContent.includes("\n"), "the JSON must be a single line");

		const { id } = await setupDelegation(
			dir,
			async (d) => {
				// Tracked (committed) then modified by the worker → " M".
				await writeFile(join(d, "src", "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>\n', "utf8");
				await commitAll(d, "add icon v1");
				await writeFile(join(d, "src", "icon.svg"), svgContent, "utf8");
				// Untracked → "??".
				await mkdir(join(d, "assets"), { recursive: true });
				await writeFile(join(d, "assets", "bundle.json"), jsonContent, "utf8");
			},
			["src/**", "README.md", "assets/**"],
		);

		const rec = recordingExec(spawnExec);
		// Segment 1: the tracked modified SVG only (default caller maxBytes).
		const svgReview = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/icon.svg"], exec: rec.exec, secrets }));
		assert.ok(svgReview.ok, svgReview.error ?? "review failed");
		const svgRecord = svgReview.record!;
		assert.equal(svgRecord.verdict, "PASS");
		assert.deepEqual(svgRecord.include_paths, ["src/icon.svg"]);
		assert.equal(svgRecord.patch.length, 1);
		const svgEntry = svgRecord.patch[0]!;
		assert.equal(svgEntry.path, "src/icon.svg");
		assert.equal(svgEntry.source, "compact", "the tracked modified large SVG takes the compact path");
		assert.equal(svgEntry.truncated, true, "compact entries honestly report their bounded presentation as truncated");
		assert.equal(svgRecord.patch_truncated, true, "any per-path compact truncation sets patch_truncated");
		const freshSvgDigest = await contentDigest(dir, "src/icon.svg");
		assert.ok(freshSvgDigest, "the SVG is a current readable regular file");
		const svgFacts = svgEntry.compact!;
		assertCompactFactsCommon(svgFacts, " M", Buffer.byteLength(svgContent, "utf8"), freshSvgDigest);
		assert.equal(svgFacts.head_lines, COMPACT_PREVIEW_LINES, "multi-line SVG head preview holds complete lines up to the line cap");
		assert.equal(svgFacts.head_partial_line, false);
		assert.equal(svgFacts.tail_lines, COMPACT_PREVIEW_LINES, "multi-line SVG tail preview holds complete lines up to the line cap");
		assert.equal(svgFacts.tail_partial_line, false);
		const svgHead = JSON.parse(svgFacts.head_preview) as string;
		const svgTail = JSON.parse(svgFacts.tail_preview) as string;
		assert.ok(svgHead.startsWith("<svg"), "head preview shows the SVG head text");
		assert.ok(svgTail.includes("</svg>"), "tail preview shows the SVG tail text");
		assert.ok(svgHead.includes("[REDACTED]"), "the head secret is redacted in the head preview");
		assert.ok(!svgHead.includes(svgSecret) && !svgTail.includes(svgSecret), "the SVG secret never reaches the previews");
		assert.ok(svgEntry.text.includes('status=" M"'), "rendered compact facts carry the exact porcelain status");
		assert.ok(svgEntry.text.includes("matches the worker's recorded-after digest"), "rendered compact facts carry the honest digest comparison");
		assert.ok(svgEntry.text.includes("generator equality NOT_VERIFIED"), "generator equality is never verified by the review");
		assert.deepEqual(svgRecord.patch_paths, [
			{ path: "src/icon.svg", source: "compact", bytes: Buffer.byteLength(svgEntry.text, "utf8"), truncated: true },
		]);
		assertSecretsAbsent(svgRecord, secrets);
		// Slice B2 coverage: only the segmented path is displayed so far.
		assert.deepEqual(svgRecord.displayed_paths, ["src/icon.svg"]);
		assert.deepEqual(svgRecord.remaining_paths, ["assets/bundle.json"]);
		assert.equal(svgRecord.coverage_complete, false);
		const svgRendered = renderReviewLines(svgRecord).join("\n");
		assert.ok(svgRendered.includes("--- src/icon.svg (compact, truncated) ---"), "compact entry renders with its honest source and truncation marker");
		assert.ok(svgRendered.includes('"assets/bundle.json"'), "the next include_paths guidance names the remaining compact path");

		// Segment 2: the untracked minified JSON at the CALLER maxBytes cap
		// The caller may still pass a legacy-sized value programmatically;
		// the v1 whole renderer clamps it to the 32 KiB hard ceiling while
		// compact eligibility stays tied to the fixed threshold.
		const jsonReview = await reviewDelegation(
			reviewInput(dir, id, { includePaths: ["assets/bundle.json"], maxBytes: 512_000, exec: rec.exec, secrets }),
		);
		assert.ok(jsonReview.ok, jsonReview.error ?? "review failed");
		const jsonRecord = jsonReview.record!;
		assert.equal(jsonRecord.verdict, "PASS");
		assert.deepEqual(jsonRecord.include_paths, ["assets/bundle.json"]);
		assert.equal(jsonRecord.patch.length, 1);
		const jsonEntry = jsonRecord.patch[0]!;
		assert.equal(jsonEntry.path, "assets/bundle.json");
		assert.equal(jsonEntry.source, "compact", "compaction stays automatic even when a caller tries to raise maxBytes above the hard ceiling");
		assert.equal(jsonEntry.truncated, true);
		assert.equal(jsonRecord.patch_truncated, true);
		const freshJsonDigest = await contentDigest(dir, "assets/bundle.json");
		assert.ok(freshJsonDigest, "the JSON is a current readable regular file");
		const jsonFacts = jsonEntry.compact!;
		assertCompactFactsCommon(jsonFacts, "??", Buffer.byteLength(jsonContent, "utf8"), freshJsonDigest);
		// Minified single-line JSON: no complete line in either bounded window.
		assert.equal(jsonFacts.head_lines, 0, "single-line JSON head window holds no complete line");
		assert.equal(jsonFacts.head_partial_line, true, "the head preview is the window's bounded partial-line text");
		assert.equal(jsonFacts.tail_lines, 0, "single-line JSON tail window holds no complete line");
		assert.equal(jsonFacts.tail_partial_line, true, "the tail preview is the window's bounded partial-line text");
		const jsonHead = JSON.parse(jsonFacts.head_preview) as string;
		const jsonTail = JSON.parse(jsonFacts.tail_preview) as string;
		assert.ok(jsonHead.includes("🎨数据头"), "head preview keeps the UTF-8 emoji/CJK near the JSON head");
		assert.ok(jsonHead.includes("[REDACTED]"), "the JSON head secret is redacted");
		assert.ok(!jsonHead.includes(jsonHeadSecret), "the JSON head secret never reaches the head preview");
		// The single-line JSON's TAIL preview is a UTF-8-safe bounded SUFFIX
		// of the redacted tail window — even though the minified content
		// holds no complete line, the partial-line preview shows the ACTUAL
		// end of the file: the file-end UTF-8 label and the redacted tail
		// secret appear, while the raw tail token never leaks into the facts
		// or rendered lines (assertSecretsAbsent).
		assert.ok(jsonTail.includes("尾数据🎉"), "the tail preview shows the actual file-end UTF-8 emoji/CJK label");
		assert.ok(jsonTail.includes("[REDACTED]"), "the JSON tail secret is redacted in the tail preview");
		assert.ok(!jsonTail.includes(jsonTailSecret), "the JSON tail secret never reaches the tail preview");
		assert.ok(!jsonHead.includes(jsonTailSecret) && !jsonTail.includes(jsonHeadSecret), "the JSON secrets never cross previews");
		assert.ok(jsonEntry.text.includes('status="??"'), "rendered compact facts carry the exact untracked porcelain status");
		assertSecretsAbsent(jsonRecord, secrets);
		// Same-hash merge with segment 1 → coverage complete.
		assert.deepEqual(jsonRecord.displayed_paths, ["assets/bundle.json", "src/icon.svg"]);
		assert.deepEqual(jsonRecord.remaining_paths, []);
		assert.equal(jsonRecord.coverage_complete, true);
		const jsonRendered = renderReviewLines(jsonRecord).join("\n");
		assert.ok(jsonRendered.includes("displayed  : 2 of 2 worker path(s)"), jsonRendered);
		assert.ok(jsonRendered.includes("coverage   : COMPLETE"), jsonRendered);
		assert.ok(jsonRendered.includes("(none — every worker path displayed for this bound hash)"), jsonRendered);

		// No per-path `git diff -- <path>` / `git diff --cached -- <path>` for
		// either compact path, while the normal whole-diff git facts calls run.
		const compactPaths = ["src/icon.svg", "assets/bundle.json"];
		const perPathDiffs = rec.calls.filter(
			(c) => c.command === "git" && c.args[0] === "diff" && c.args.includes("--") && compactPaths.some((p) => c.args.includes(p)),
		);
		assert.deepEqual(perPathDiffs, [], "compact paths never run a per-path git diff or git diff --cached");
		assert.ok(
			!rec.calls.some((c) => c.command === "git" && c.args[0] === "diff"),
			"no git diff of any kind runs while every path is compact",
		);
		assert.ok(rec.calls.some((c) => c.command === "git" && c.args[0] === "rev-parse"), "normal git facts calls still occur (rev-parse HEAD)");
		assert.ok(rec.calls.some((c) => c.command === "git" && c.args[0] === "status"), "normal git facts calls still occur (git status --porcelain)");
	});
});

test("Phase 5: the tail preview suffix bound is deterministic and code-point-safe — a multi-byte code point straddling the byte limit is never split", () => {
	// "ab🎉cd" is 8 UTF-8 bytes (1+1+4+1+1) over 6 UTF-16 code units; a
	// naive UTF-16 code-unit suffix (e.g. slice(-3)) would split the
	// emoji's surrogate pair into a lone low surrogate. The code-point-safe
	// bound keeps the largest complete-code-point suffix within the limit.
	assert.equal(suffixUtf8("ab🎉cd", 8), "ab🎉cd", "text within the limit is returned unchanged");
	assert.equal(suffixUtf8("ab🎉cd", 7), "b🎉cd", "the 4-byte emoji fits with one preceding ASCII byte");
	assert.equal(suffixUtf8("ab🎉cd", 6), "🎉cd", "the emoji fits exactly at the limit");
	assert.equal(suffixUtf8("ab🎉cd", 5), "cd", "the straddling emoji is dropped whole — never split");
	assert.equal(suffixUtf8("ab🎉cd", 3), "cd", "a 3-byte limit must not yield the lone low surrogate of a naive UTF-16 slice");
	assert.equal(suffixUtf8("ab🎉cd", 1), "d");
	assert.equal(suffixUtf8("🎉", 3), "", "a 4-byte code point never fits a 3-byte limit — no partial code point");
	assert.equal(suffixUtf8("🎉", 4), "🎉");
	// "尾数据🎉" is 13 UTF-8 bytes (3+3+3+4).
	assert.equal(suffixUtf8("尾数据🎉", 13), "尾数据🎉");
	assert.equal(suffixUtf8("尾数据🎉", 12), "数据🎉", "the straddling CJK character is dropped whole");
	assert.equal(suffixUtf8("尾数据🎉", 9), "据🎉");
	assert.equal(suffixUtf8("hello", 0), "", "a zero limit yields an empty suffix");
	assert.equal(suffixUtf8("", 10), "", "empty text stays empty");
	// The result is always valid UTF-8: no replacement characters, an exact
	// round-trip, and the byte length never exceeds the limit.
	for (const [text, limit] of [
		["ab🎉cd", 5],
		["尾数据🎉", 9],
		["x".repeat(2000) + "尾🎉", 1024],
	] as const) {
		const cut = suffixUtf8(text, limit);
		assert.ok(!cut.includes("\uFFFD"), "the suffix bound never introduces a replacement character");
		assert.equal(Buffer.from(cut, "utf8").toString("utf8"), cut, "the suffix round-trips as valid UTF-8");
		assert.ok(Buffer.byteLength(cut, "utf8") <= limit, "the suffix respects the byte limit");
	}
});

test("Phase 5: compact eligibility is strict — ordinary .ts, small .svg/.json and an exactly COMPACT_MIN_BYTES JSON keep the existing git-diff/file-content sources; a COMPACT_MIN_BYTES + 1 JSON is compact; a deleted tracked JSON is never compact", async () => {
	await withTempDir(async (dir) => {
		const { id } = await setupDelegation(
			dir,
			async (d) => {
				// A TRACKED JSON the worker deletes — deleted paths are never
				// compact (the existing "deleted tracked paths render as git
				// removal diffs" test covers the generic deleted-path case; this
				// extends it to a compact-eligible extension at a size above the
				// threshold).
				await writeFile(join(d, "src", "gone.json"), `{"pad":"${'w'.repeat(40_000)}"}`, "utf8");
				await commitAll(d, "add tracked json");
				await git(d, ["rm", "-q", "src/gone.json"]);
				// Ordinary tracked source (modified) — never compact-eligible.
				await writeFile(join(d, "src", "main.ts"), "const x = 2;\n", "utf8");
				// Small .svg and .json — below the strict threshold.
				await writeFile(join(d, "src", "small.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>\n', "utf8");
				await writeFile(join(d, "src", "small.json"), '{"a":1,"b":"small"}\n', "utf8");
				// Exactly COMPACT_MIN_BYTES (32 KiB) — NOT compact (strictly
				// greater is required).
				const exactJson = `{"pad":"${'y'.repeat(COMPACT_MIN_BYTES - 10)}"}`;
				assert.equal(Buffer.byteLength(exactJson, "utf8"), COMPACT_MIN_BYTES, "exact.json must be exactly COMPACT_MIN_BYTES bytes");
				await writeFile(join(d, "src", "exact.json"), exactJson, "utf8");
				// COMPACT_MIN_BYTES + 1 — compact.
				const overJson = `{"pad":"${'z'.repeat(COMPACT_MIN_BYTES - 9)}"}`;
				assert.equal(Buffer.byteLength(overJson, "utf8"), COMPACT_MIN_BYTES + 1, "over.json must be COMPACT_MIN_BYTES + 1 bytes");
				await writeFile(join(d, "src", "over.json"), overJson, "utf8");
			},
			["src/**"],
		);
		// A legacy oversized caller value cannot raise the hard ceiling. Review
		// each source as a normal include_paths page so source selection is
		// checked independently of the shared whole-result budget.
		const byPath = new Map<string, ReviewRecord["patch"][number]>();
		const statsByPath = new Map<string, ReviewRecord["patch_paths"][number]>();
		for (const path of ["src/main.ts", "src/small.svg", "src/small.json", "src/exact.json", "src/over.json", "src/gone.json"]) {
			const segment = await reviewDelegation(reviewInput(dir, id, { includePaths: [path], maxBytes: 512_000 }));
			assert.ok(segment.ok, segment.error ?? `review failed for ${path}`);
			assert.equal(segment.record!.verdict, "PASS");
			assert.equal(segment.record!.patch.length, 1, `the narrowed ${path} page has one bounded entry`);
			byPath.set(path, segment.record!.patch[0]!);
			statsByPath.set(path, segment.record!.patch_paths[0]!);
		}
		const main = byPath.get("src/main.ts")!;
		assert.equal(main.source, "git-diff", "ordinary tracked .ts keeps the git-diff source");
		assert.equal(main.truncated, false);
		assert.equal(main.compact, undefined, "ordinary .ts never carries compact facts");
		const smallSvg = byPath.get("src/small.svg")!;
		assert.equal(smallSvg.source, "file-content", "small .svg keeps the existing untracked file-content source");
		assert.equal(smallSvg.compact, undefined);
		const smallJson = byPath.get("src/small.json")!;
		assert.equal(smallJson.source, "file-content", "small .json keeps the existing file-content source");
		assert.equal(smallJson.compact, undefined);
		const exact = byPath.get("src/exact.json")!;
		assert.equal(exact.source, "file-content", "a JSON of exactly COMPACT_MIN_BYTES is NOT compact — strictly greater is required");
		assert.equal(exact.truncated, true, "the exact-size non-compact entry is honestly bounded by the fixed patch sub-budget");
		assert.equal(exact.compact, undefined);
		const over = byPath.get("src/over.json")!;
		assert.equal(over.source, "compact", "COMPACT_MIN_BYTES + 1 crosses the strict threshold");
		assert.equal(over.truncated, true, "compact entries honestly report their bounded presentation as truncated");
		assert.ok(over.compact, "the compact entry carries structured facts");
		const overDigest = await contentDigest(dir, "src/over.json");
		assert.ok(overDigest, "over.json is a current readable regular file");
		assertCompactFactsCommon(over.compact!, "??", COMPACT_MIN_BYTES + 1, overDigest);
		assert.equal(over.compact!.head_lines, 0, "the minified over-threshold JSON holds no complete head line");
		assert.equal(over.compact!.head_partial_line, true);
		assert.equal(over.compact!.tail_lines, 0);
		assert.equal(over.compact!.tail_partial_line, true);
		assert.ok(over.text.includes("size="), "rendered compact facts show the real byte size");
		const gone = byPath.get("src/gone.json")!;
		assert.equal(gone.source, "git-diff", "a deleted tracked JSON renders the git removal diff — never compact");
		assert.equal(gone.compact, undefined, "deleted paths carry no compact facts");
		assert.ok(gone.text.includes("deleted file mode"), "the removal diff is the honest git evidence");
		// patch_paths stats mirror the same honest sources.
		const stat = statsByPath.get("src/over.json")!;
		assert.deepEqual([stat.source, stat.truncated], ["compact", true]);
		const goneStat = statsByPath.get("src/gone.json")!;
		assert.deepEqual([goneStat.source, goneStat.truncated], ["git-diff", true]);
	});
});

// ---------------------------------------------------------------------------
// Phase 5 second tranche: >4 MiB bounded-digest honesty + later-edit reset,
// and withheld containment/presentation for scope-violating worker paths
// ---------------------------------------------------------------------------

test("Phase 5: a >4 MiB JSON renders an honest sha256-prefix+size compact digest; a later head edit changes the bounded digest, drifts, and resets prior same-hash coverage", async () => {
	await withTempDir(async (dir) => {
		// A regular JSON LARGER than MAX_DIGEST_BYTES (4 MiB): the compact
		// digest is the EXISTING bounded form — sha256 of the first
		// MAX_DIGEST_BYTES plus the exact real size — honestly labelled.
		const bigJsonV1 = JSON.stringify({
			head: "BIG_JSON_HEAD_v1",
			pad: "p".repeat(MAX_DIGEST_BYTES + 4096),
		});
		assert.ok(Buffer.byteLength(bigJsonV1, "utf8") > MAX_DIGEST_BYTES, "the JSON must exceed the 4 MiB digest bound");
		const { id, afterHash } = await setupDelegation(dir, async (d) => {
			await writeFile(join(d, "src", "big.json"), bigJsonV1, "utf8");
			// The second ordinary worker path (tracked modified .ts).
			await writeFile(join(d, "src", "main.ts"), "v2\n", "utf8");
		});

		const assertBoundedDigestFacts = (facts: ReviewCompactFacts, expectedSize: number, matchesAfter: boolean): void => {
			assert.equal(facts.digest_kind, "sha256-prefix+size");
			assert.equal(facts.digest_max_bytes, MAX_DIGEST_BYTES, "the fixed 4 MiB digest boundary is reported");
			assert.equal(facts.size_bytes, expectedSize);
			assert.ok(facts.size_bytes > MAX_DIGEST_BYTES, "genuinely beyond the 4 MiB digest bound");
			assert.match(facts.digest, /^[0-9a-f]{64}:\d+$/, "sha256-prefix+size form: 64-hex prefix + exact size suffix");
			const colon = facts.digest.indexOf(":");
			assert.equal(colon, 64, "64-hex prefix before the size suffix");
			assert.equal(facts.digest.slice(colon + 1), String(facts.size_bytes), "the size suffix is the exact real byte size");
			assert.equal(facts.digest_matches_after, matchesAfter);
			assert.equal(facts.generator_equality, COMPACT_GENERATOR_EQUALITY, "generator equality is never verified");
		};
		const assertNotFullSha256Label = (text: string): void => {
			assert.ok(text.includes("sha256-prefix+size"), "the bounded digest form is named");
			assert.ok(!text.includes("(sha256)"), "the bounded digest is never labeled as the full sha256 form");
		};

		// Segment 1: the >4 MiB JSON takes the compact path with the honest
		// bounded digest label; the ordinary worker path stays remaining.
		const first = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/big.json"] }));
		assert.ok(first.ok, first.error ?? "review failed");
		let record = first.record!;
		assert.equal(record.verdict, "PASS");
		assert.equal(record.bound_diff_hash, afterHash);
		assert.equal(record.patch.length, 1);
		const firstEntry = record.patch[0]!;
		assert.equal(firstEntry.path, "src/big.json");
		assert.equal(firstEntry.source, "compact");
		assert.equal(firstEntry.truncated, true);
		const facts = firstEntry.compact!;
		assertBoundedDigestFacts(facts, Buffer.byteLength(bigJsonV1, "utf8"), true);
		const freshV1 = await contentDigest(dir, "src/big.json");
		assert.ok(freshV1, "big.json is a current readable regular file");
		assert.equal(facts.digest, freshV1, "the compact digest is a fresh current content digest");
		const firstRendered = renderReviewLines(record).join("\n");
		assert.ok(
			firstRendered.includes(`(${facts.digest_kind} beyond ${MAX_DIGEST_BYTES} bytes)`),
			"rendered facts name the bounded form and its fixed boundary",
		);
		assertNotFullSha256Label(firstRendered);
		assert.ok(firstRendered.includes("matches the worker's recorded-after digest"), firstRendered);
		assert.deepEqual(record.displayed_paths, ["src/big.json"]);
		assert.deepEqual(record.remaining_paths, ["src/main.ts"]);
		assert.equal(record.coverage_complete, false);

		// Segment 2: the ordinary worker path — SAME hash merges the prior
		// segment into complete coverage.
		const second = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/main.ts"] }));
		assert.ok(second.ok && second.record);
		record = second.record!;
		assert.equal(record.bound_diff_hash, afterHash, "both segments bind the same complete diff hash");
		assert.equal(record.patch[0]!.path, "src/main.ts");
		assert.equal(record.patch[0]!.source, "git-diff", "the ordinary worker path keeps the git-diff source");
		assert.deepEqual(record.displayed_paths, ["src/big.json", "src/main.ts"]);
		assert.deepEqual(record.remaining_paths, []);
		assert.equal(record.coverage_complete, true, "segmented same-hash reviews complete coverage");

		// A later edit NEAR THE HEAD of the big JSON (inside the bounded
		// digest prefix) changes the bounded digest.
		const bigJsonV2 = JSON.stringify({
			head: "BIG_JSON_HEAD_v2_EDITED",
			pad: "p".repeat(MAX_DIGEST_BYTES + 4096),
		});
		await writeFile(join(dir, "src", "big.json"), bigJsonV2, "utf8");

		// Narrowed re-review: honest mismatch/drift/current-hash binding and
		// a coverage RESET under the changed hash — only this call's rendered
		// path stays displayed; the second worker path remains.
		const re = await reviewDelegation(reviewInput(dir, id, { includePaths: ["src/big.json"] }));
		assert.ok(re.ok && re.record);
		record = re.record!;
		assert.equal(record.verdict, "PASS", "in-scope worker paths still PASS — mismatch warns, it does not fail");
		assert.equal(record.mismatch, true, "the later head edit changes the diff hash");
		assert.notEqual(record.bound_diff_hash, afterHash);
		assert.deepEqual(record.drift_paths, ["src/big.json"], "the later same-path edit is drift");
		const current = await collectGitFacts(dir, spawnExec);
		assert.equal(
			record.bound_diff_hash,
			computeDiffHash(current.changedPaths, current.pathDigests, current.pathStatuses),
			"the review binds a freshly computed current complete diff hash",
		);
		assert.equal(record.patch.length, 1);
		const reEntry = record.patch[0]!;
		assert.equal(reEntry.path, "src/big.json");
		assert.ok(reEntry.compact, "the re-review still renders the compact entry");
		const reFacts = reEntry.compact!;
		const freshV2 = await contentDigest(dir, "src/big.json");
		assert.ok(freshV2, "big.json is still a current readable regular file");
		assert.equal(reFacts.digest, freshV2, "the re-review digest is a fresh current digest");
		assert.notEqual(reFacts.digest, facts.digest, "the head edit changed the bounded digest");
		assertBoundedDigestFacts(reFacts, Buffer.byteLength(bigJsonV2, "utf8"), false);
		const reRendered = renderReviewLines(record).join("\n");
		assert.ok(reRendered.includes("DIFFERS from the worker's recorded-after digest"), "the rendered digest comparison is honest after the edit");
		assertNotFullSha256Label(reRendered);
		// Prior COMPLETE coverage resets under the changed hash: only this
		// call's actually rendered path is displayed; src/main.ts remains.
		assert.deepEqual(record.displayed_paths, ["src/big.json"]);
		assert.deepEqual(record.remaining_paths, ["src/main.ts"]);
		assert.equal(record.coverage_complete, false);
	});
});

test("Phase 5: scope-violating worker paths (an out-of-scope large JSON and a src/escape.json symlink to a pre-committed secret target) are withheld — exact marker, no per-path git diff/digest/content/secret, displayed coverage with a FAIL verdict", async () => {
	await withTempDir(async (dir) => {
		await git(dir, ["init", "-q"]);
		await git(dir, ["config", "user.email", "test@example.com"]);
		await git(dir, ["config", "user.name", "Workbench Test"]);
		await git(dir, ["config", "commit.gpgsign", "false"]);
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "README.md"), "hello\n", "utf8");
		await writeFile(join(dir, "src", "main.ts"), "v1\n", "utf8");
		// A PRE-COMMITTED large secret-bearing target OUTSIDE the approved
		// src/** scope — the escaping symlink resolves to it.
		const vaultSecret = "VAULT_SECRET_7f3a9c21";
		const vault = JSON.stringify({ vault: vaultSecret, pad: "v".repeat(200_000) });
		assert.ok(Buffer.byteLength(vault, "utf8") > COMPACT_MIN_BYTES, "the target is compact-eligible sized — only withholding keeps it unread");
		await writeFile(join(dir, "vault-secrets.json"), vault, "utf8");
		await commitAll(dir, "init");

		const before = await collectGitFacts(dir, spawnExec);
		const id = makeDelegationId(new Date());
		const created = await createDelegationLedger(
			dir,
			id,
			{ task: "t", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 },
			before,
			NOW,
		);
		assert.ok(created.ok, created.ok ? "" : created.error);
		// The worker phase creates BOTH violations: (a) an out-of-scope large
		// regular JSON and (b) a lexically in-scope symlink that resolves
		// OUTSIDE the approved subtree (to the pre-committed secret target).
		await writeFile(join(dir, "outsidescope.json"), JSON.stringify({ pad: "b".repeat(200_000) }), "utf8");
		const link = await spawnExec("ln", ["-s", "../vault-secrets.json", "src/escape.json"], { cwd: dir });
		assert.equal(link.code, 0, `ln failed: ${link.stderr}`);
		const after = await collectAfterFacts(dir, before, spawnExec);
		const finished = await finishDelegationLedger(dir, id, { after, worker: workerFacts(), secrets: [], now: NOW });
		assert.ok(finished.ok, finished.ok ? "" : finished.error);
		assert.deepEqual(
			after.changedSinceBefore,
			["outsidescope.json", "src/escape.json"],
			"both violating paths are actual worker paths",
		);

		const rec = recordingExec(spawnExec);
		const result = await reviewDelegation(reviewInput(dir, id, { exec: rec.exec }));
		assert.ok(result.ok, result.error ?? "review failed");
		const record = result.record!;
		assert.equal(record.verdict, "FAIL", "both scope violations fail the review");
		assert.equal(record.mismatch, false, "the FAIL comes from the scope violations, not from drift");
		assert.deepEqual(record.violations.map((v) => v.path), ["outsidescope.json", "src/escape.json"]);
		assert.deepEqual(record.checked_paths, ["outsidescope.json", "src/escape.json"], "both violating paths are scope-checked");
		assert.equal(record.patch.length, 2);
		for (const entry of record.patch) {
			assert.equal(entry.source, "withheld", `${entry.path} is withheld`);
			assert.equal(entry.text, WITHHELD_MARKER, `${entry.path} renders the exact withheld marker and nothing else`);
			assert.equal(entry.truncated, false);
			assert.equal(entry.compact, undefined, "withheld entries carry no compact facts");
		}
		// No per-path digest text, no file content, no secret anywhere in the
		// structured record or its rendering.
		assertSecretsAbsent(record, [vaultSecret]);
		const raw = JSON.stringify(record);
		const rendered = renderReviewLines(record).join("\n");
		assert.ok(!raw.includes("digest=") && !rendered.includes("digest="), "no per-path digest text is ever rendered for withheld paths");
		assert.ok(rendered.includes(WITHHELD_MARKER), "the rendered lines carry the exact marker");
		// patch_paths stats mirror the same withheld source.
		assert.equal(record.patch_paths.length, 2);
		for (const stat of record.patch_paths) assert.equal(stat.source, "withheld");
		// Withheld entries ARE actually rendered, so they count as displayed
		// coverage — but the verdict stays FAIL.
		assert.deepEqual(record.displayed_paths, ["outsidescope.json", "src/escape.json"]);
		assert.deepEqual(record.remaining_paths, []);
		assert.equal(record.coverage_complete, true, "withheld entries count as displayed evidence segments");
		assert.ok(rendered.includes("scope check: FAIL"), rendered);
		assert.ok(rendered.includes("displayed  : 2 of 2 worker path(s)"), rendered);

		// The whole-diff git facts collection is UNCHANGED: collectGitFacts
		// (rev-parse + status) still runs and still performs its bounded
		// per-path content-digest work over the COMPLETE diff — the review
		// never claims it performs no digest work. What is withheld is the
		// per-path PRESENTATION pipeline: no `git diff -- <path>` /
		// `git diff --cached -- <path>` is ever invoked for a withheld path.
		const withheldPaths = ["outsidescope.json", "src/escape.json"];
		const perPathDiffs = rec.calls.filter(
			(c) => c.command === "git" && c.args[0] === "diff" && withheldPaths.some((p) => c.args.includes(p)),
		);
		assert.deepEqual(perPathDiffs, [], "no per-path git diff / git diff --cached is invoked for withheld paths");
		assert.ok(
			!rec.calls.some((c) => c.command === "git" && c.args[0] === "diff"),
			"no git diff of any kind runs while every patch path is withheld",
		);
		assert.ok(rec.calls.some((c) => c.command === "git" && c.args[0] === "rev-parse"), "whole-diff git facts still run (rev-parse HEAD)");
		assert.ok(rec.calls.some((c) => c.command === "git" && c.args[0] === "status"), "whole-diff git facts still run (git status --porcelain)");
		// The bound hash still covers the complete actual diff — violating
		// paths included (their digests are whole-diff facts, never rendered).
		const current = await collectGitFacts(dir, spawnExec);
		assert.equal(
			record.bound_diff_hash,
			computeDiffHash(current.changedPaths, current.pathDigests, current.pathStatuses),
			"the bound hash covers the complete diff including the violating paths",
		);
	});
});
