import assert from "node:assert/strict";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { sha256Hex } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	BOUNDED_FILE_AUTHORIZED_MAX_BYTES,
	BOUNDED_FILE_MAX_BYTES,
	COMPARISON_RECORD_READ_AUTHORITY,
	readUtf8FileBounded,
	readUtf8FileWithExplicitHardCeiling,
} from "../extensions/workbench-runtime/core/bounded-file-io.ts";
import {
	MAX_ARTIFACT_BYTES,
	compareRuns,
	type RunComparison,
} from "../extensions/workbench-runtime/core/compare.ts";
import {
	COMPARISON_PERSIST_ERROR,
	COMPARISON_RECORD_MAX_BYTES,
	COMPARISON_SUMMARY_RECORD_MAX_BYTES,
	compileComparisonRecord,
	persistComparisonRecord,
	type ComparisonRecordInput,
} from "../extensions/workbench-runtime/core/comparison-record.ts";
import { runsDir, workbenchDir } from "../extensions/workbench-runtime/core/config.ts";
import {
	COMPARE_SUMMARY_MAX_BYTES,
	COMPARE_SUMMARY_MAX_LINES,
	renderCompareLines,
} from "../extensions/workbench-runtime/core/render.ts";
import { makeValidQuantResult, withTempDir } from "./helpers.ts";

function manifest(runId: string, artifactPaths: string[], startedAt: string): Record<string, unknown> {
	return {
		schema_version: 1,
		run_id: runId,
		recipe: "backtest",
		profile: "quant-research/stock-selection",
		started_at: startedAt,
		finished_at: startedAt,
		duration_ms: 100,
		cwd: ".",
		argv: [],
		exit_code: 0,
		timed_out: false,
		cancelled: false,
		git_commit: null,
		git_dirty: false,
		artifact_paths: artifactPaths,
		stdout_truncated: false,
		stderr_truncated: false,
		mode: "DEV",
		expected_exit_codes: [0],
		declared_writes: [],
		environment_names: [],
		validation_components: [],
		cache_request_mode: "no-cache",
	};
}

async function writeRun(
	root: string,
	runId: string,
	startedAt: string,
	artifacts: Record<string, string>,
): Promise<void> {
	const dir = join(runsDir(root), runId);
	await mkdir(join(dir, "artifacts"), { recursive: true });
	const paths = Object.keys(artifacts).map((name) => `results/${name}`);
	await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest(runId, paths, startedAt)), "utf8");
	for (const [name, raw] of Object.entries(artifacts)) {
		await writeFile(join(dir, "artifacts", name), raw, "utf8");
	}
}

function recordInput(overrides: Partial<ComparisonRecordInput> = {}): ComparisonRecordInput {
	return {
		a_identity: { run_id: "20260813-000000-aaaa", recipe: "test", started_at: "2026-08-13T00:00:00.000Z" },
		b_identity: { run_id: "20260813-000001-bbbb", recipe: "test", started_at: "2026-08-13T00:00:01.000Z" },
		a_manifest_digest: "a".repeat(64),
		b_manifest_digest: "b".repeat(64),
		report: { compatible: true, nested: { b: 2, a: 1 } },
		summary: { compatible: true, changed_count: 1 },
		...overrides,
	};
}

test("512 KiB nested quant parameters persist in the full record while model and summary outputs stay bounded", async () => {
	await withTempDir(async (root) => {
		const blobA = "a".repeat(480_000);
		const blobB = "b".repeat(480_000);
		const rawA = JSON.stringify(makeValidQuantResult({ parameters: { nested: { payload: blobA } } }));
		const rawB = JSON.stringify(makeValidQuantResult({ parameters: { nested: { payload: blobB } } }));
		assert.ok(Buffer.byteLength(rawA, "utf8") <= MAX_ARTIFACT_BYTES);
		assert.ok(Buffer.byteLength(rawB, "utf8") <= MAX_ARTIFACT_BYTES);
		await writeRun(root, "20260813-000000-aaaa", "2026-08-13T00:00:00.000Z", { "quant-result.json": rawA });
		await writeRun(root, "20260813-000001-bbbb", "2026-08-13T00:00:01.000Z", { "quant-result.json": rawB });

		const outcome = await compareRuns(root, "20260813-000000-aaaa", "20260813-000001-bbbb");
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		const lines = renderCompareLines(outcome.report, true);
		const text = lines.join("\n");
		assert.ok(Buffer.byteLength(text, "utf8") <= COMPARE_SUMMARY_MAX_BYTES);
		assert.ok(lines.length <= COMPARE_SUMMARY_MAX_LINES);
		assert.match(text, /omitted_bytes|comparison_value_omitted/);

		const fullRaw = await readFile(join(root, outcome.comparison_path), "utf8");
		assert.ok(Buffer.byteLength(fullRaw, "utf8") <= COMPARISON_RECORD_MAX_BYTES);
		const full = JSON.parse(fullRaw) as { report: RunComparison };
		const change = full.report.quant?.parameters.find((item) => item.field === "nested");
		assert.equal(((change?.a as { payload?: unknown })?.payload as string).length, blobA.length);
		assert.equal(((change?.b as { payload?: unknown })?.payload as string).length, blobB.length);
		const summaryPath = join(dirname(join(root, outcome.comparison_path)), "summary.json");
		assert.ok((await stat(summaryPath)).size <= COMPARISON_SUMMARY_RECORD_MAX_BYTES);
	});
});

test("oversized artifact inputs are rejected at stat preflight without a content buffer allocation", async () => {
	await withTempDir(async (root) => {
		const oversized = `{"padding":"${"x".repeat(MAX_ARTIFACT_BYTES)}"}`;
		assert.ok(Buffer.byteLength(oversized, "utf8") > MAX_ARTIFACT_BYTES);
		await writeRun(root, "20260813-000002-cccc", "2026-08-13T00:00:02.000Z", { "metrics.json": oversized });
		await writeRun(root, "20260813-000003-dddd", "2026-08-13T00:00:03.000Z", { "metrics.json": oversized });
		const allocations: number[] = [];
		const outcome = await compareRuns(root, "20260813-000002-cccc", "20260813-000003-dddd", {
			artifactIoHooks: { onBufferAllocate: (bytes) => allocations.push(bytes) },
		});
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		assert.deepEqual(allocations, []);
		assert.ok(outcome.report.notes.some((note) => note.includes("source_oversized:2")));
	});
});

test("non-regular and invalid JSON artifact inputs are explicit unavailable facts", async () => {
	await withTempDir(async (root) => {
		await writeRun(root, "20260813-000004-eeee", "2026-08-13T00:00:04.000Z", { "metrics.json": "{}" });
		await writeRun(root, "20260813-000005-ffff", "2026-08-13T00:00:05.000Z", { "metrics.json": "{invalid" });
		const nonRegular = join(runsDir(root), "20260813-000004-eeee", "artifacts", "metrics.json");
		await rm(nonRegular);
		await mkdir(nonRegular);
		const outcome = await compareRuns(root, "20260813-000004-eeee", "20260813-000005-ffff");
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		const notes = outcome.report.notes.join("\n");
		assert.match(notes, /source_not_regular:1/);
		assert.match(notes, /invalid_json:1/);
	});
});

test("comparison record identity, canonical files, atomic replay, modes and independent caps are deterministic", async () => {
	await withTempDir(async (root) => {
		const first = await persistComparisonRecord(root, recordInput());
		assert.ok(first.ok);
		if (!first.ok) return;
		assert.match(first.comparison_id, /^cmp1-[0-9a-f]{64}$/);
		assert.equal(first.comparison_path, `${CONFIG_DIR_NAME}/workbench/comparisons/${first.comparison_id}/comparison.json`);
		assert.equal(first.summary_path, `${CONFIG_DIR_NAME}/workbench/comparisons/${first.comparison_id}/summary.json`);
		const fullPath = join(root, first.comparison_path);
		const summaryPath = join(root, first.summary_path);
		const fullRaw = await readFile(fullPath, "utf8");
		const summaryRaw = await readFile(summaryPath, "utf8");
		assert.equal(sha256Hex(fullRaw), first.content_hash);
		assert.equal((JSON.parse(summaryRaw) as { comparison_id?: unknown }).comparison_id, first.comparison_id);
		assert.equal(Buffer.byteLength(summaryRaw, "utf8"), first.summary_bytes);
		assert.equal((await stat(fullPath)).mode & 0o777, 0o600);
		assert.equal((await stat(summaryPath)).mode & 0o777, 0o600);
		assert.ok((await stat(fullPath)).size <= COMPARISON_RECORD_MAX_BYTES);
		assert.ok((await stat(summaryPath)).size <= COMPARISON_SUMMARY_RECORD_MAX_BYTES);
		const changedReport = compileComparisonRecord(recordInput({ report: { compatible: false } }));
		assert.ok(changedReport.ok);
		if (changedReport.ok) {
			assert.equal(changedReport.value.comparison_id, first.comparison_id);
			assert.notEqual(changedReport.value.content_hash, first.content_hash);
		}

		const replay = await persistComparisonRecord(root, recordInput({
			report: { nested: { a: 1, b: 2 }, compatible: true },
			summary: { changed_count: 1, compatible: true },
		}));
		assert.ok(replay.ok);
		if (!replay.ok) return;
		assert.equal(replay.comparison_id, first.comparison_id);
		assert.equal(replay.content_hash, first.content_hash);
		assert.equal(replay.replayed, true);
		assert.deepEqual(await readdir(join(workbenchDir(root), "comparisons")), [first.comparison_id]);

		const fullOversize = compileComparisonRecord(recordInput({ report: { blob: "x".repeat(COMPARISON_RECORD_MAX_BYTES) } }));
		assert.deepEqual(fullOversize, { ok: false, code: COMPARISON_PERSIST_ERROR });
		const summaryOversize = compileComparisonRecord(recordInput({ summary: { blob: "x".repeat(COMPARISON_SUMMARY_RECORD_MAX_BYTES) } }));
		assert.deepEqual(summaryOversize, { ok: false, code: COMPARISON_PERSIST_ERROR });
	});
});

test("a comparison larger than the generic 1 MiB cap persists and replays byte-identically under the explicit 4 MiB authority", async () => {
	await withTempDir(async (root) => {
		assert.equal(COMPARISON_RECORD_MAX_BYTES, BOUNDED_FILE_AUTHORIZED_MAX_BYTES);
		const input = recordInput({
			report: { compatible: true, payload: "x".repeat(BOUNDED_FILE_MAX_BYTES + 131_072) },
			summary: { compatible: true, changed_count: 1 },
		});
		const first = await persistComparisonRecord(root, input);
		assert.ok(first.ok);
		if (!first.ok) return;
		assert.ok(first.bytes > BOUNDED_FILE_MAX_BYTES);
		assert.ok(first.bytes <= COMPARISON_RECORD_MAX_BYTES);
		const fullPath = join(root, first.comparison_path);
		const generic = await readUtf8FileBounded(fullPath, COMPARISON_RECORD_MAX_BYTES);
		assert.equal(generic.ok, false, "the generic reader remains hard-clamped to 1 MiB");
		if (!generic.ok) assert.equal(generic.error.code, "source_oversized");
		const before = await readFile(fullPath, "utf8");
		const replay = await persistComparisonRecord(root, input);
		assert.ok(replay.ok);
		if (!replay.ok) return;
		assert.equal(replay.replayed, true);
		assert.equal(replay.content_hash, first.content_hash);
		assert.equal(replay.bytes, first.bytes);
		assert.equal(await readFile(fullPath, "utf8"), before);

		const oversizedPath = join(root, "oversized-comparison-record.json");
		const handle = await open(oversizedPath, "w");
		try {
			await handle.truncate(COMPARISON_RECORD_MAX_BYTES + 1);
		} finally {
			await handle.close();
		}
		const allocations: number[] = [];
		const oversized = await readUtf8FileWithExplicitHardCeiling(
			oversizedPath,
			Number.MAX_SAFE_INTEGER,
			COMPARISON_RECORD_READ_AUTHORITY,
			{ onBufferAllocate: (bytes) => allocations.push(bytes) },
		);
		assert.equal(oversized.ok, false);
		if (!oversized.ok) assert.equal(oversized.error.code, "source_oversized");
		assert.deepEqual(allocations, [], "the explicit 4 MiB authority still rejects oversize before allocation");
	});
});

test("comparison persistence failure returns only the fixed code", async () => {
	await withTempDir(async (root) => {
		await mkdir(workbenchDir(root), { recursive: true });
		await writeFile(join(workbenchDir(root), "comparisons"), "blocking file", "utf8");
		const result = await persistComparisonRecord(root, recordInput());
		assert.deepEqual(result, { ok: false, code: COMPARISON_PERSIST_ERROR });
	});
});

test("hostile paths and large nested delta lists render with exact omissions, no controls, and n/a metrics", () => {
	const hostile = (index: number): string => `path-${index}\n\u0000\u001b-${"界".repeat(200)}`;
	const report: RunComparison = {
		comparison_id: `cmp1-${"c".repeat(64)}`,
		comparison_path: `.pi/workbench/comparisons/cmp1-${"c".repeat(64)}/comparison.json`,
		compatible: true,
		notes: Array.from({ length: 20 }, (_, index) => `note-${index}\n${"n".repeat(1000)}`),
		a: { run_id: "a", recipe: "r", started_at: "t" },
		b: { run_id: "b", recipe: "r", started_at: "t" },
		generic: {
			exit_code: { a: 0, b: 0, changed: false },
			duration_ms: { a: 1, b: 2, changed: true },
			artifacts: {
				added: Array.from({ length: 100 }, (_, index) => hostile(index)),
				removed: Array.from({ length: 100 }, (_, index) => hostile(index + 100)),
				common: Array.from({ length: 100 }, (_, index) => hostile(index + 200)),
			},
			gate_delta: {
				changed: Array.from({ length: 100 }, (_, index) => ({ gate: hostile(index), a: "PASS" as const, b: "FAIL" as const })),
				a: {},
				b: {},
			},
			test_counts: null,
			artifact_metrics: [],
		},
		quant: {
			benchmark_delta: { a: null, b: null, changed: false },
			return: { a: null, b: 0, changed: true },
			drawdown: { a: -0.1, b: -0.2, changed: true },
			turnover: { a: 1, b: 2, changed: true },
			costs: Array.from({ length: 100 }, (_, index) => ({ file: "costs", field: hostile(index), a: index, b: index + 1 })),
			folds: { a: null, b: null },
			parameters: Array.from({ length: 100 }, (_, index) => ({
				field: hostile(index),
				a: { rows: Array.from({ length: 100 }, () => "a".repeat(1000)) },
				b: { rows: Array.from({ length: 100 }, () => "b".repeat(1000)) },
			})),
			a_path: hostile(1),
			b_path: hostile(2),
		},
	};
	const lines = renderCompareLines(report, true);
	const text = lines.join("\n");
	assert.ok(Buffer.byteLength(text, "utf8") <= COMPARE_SUMMARY_MAX_BYTES);
	assert.ok(lines.length <= COMPARE_SUMMARY_MAX_LINES);
	for (const line of lines) assert.equal(/[\x00-\x1f\x7f]/.test(line), false, JSON.stringify(line));
	for (const expected of [
		"+92 more added artifact(s) omitted",
		"76 more gate change(s) omitted",
		"76 more cost change(s) omitted",
		"84 more parameter change(s) omitted",
		"12 more note(s) omitted",
		"return          : n/a -> 0",
	]) assert.ok(text.includes(expected), expected);
});
