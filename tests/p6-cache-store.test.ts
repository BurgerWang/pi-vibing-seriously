/**
 * P6-A store tests — JSONL append, rotation, corrupted lines, write-failure
 * fallback, atomic report saves, forbidden-field refusal, size limits.
 */

import assert from "node:assert/strict";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	CacheStore,
	DEFAULT_MAX_TELEMETRY_BYTES,
	MAX_TELEMETRY_RECORD_BYTES,
	hasForbiddenTelemetryFields,
} from "../extensions/workbench-runtime/cache/cache-store.ts";
import { withTempDir } from "./helpers.ts";

const CONFIG_DIR = ".pi";

function record(n: number): Record<string, unknown> {
	return {
		schemaVersion: "1.1",
		timestamp: `2026-01-01T00:00:0${n}.000Z`,
		extensionVersion: "0.7.0",
		hashedSessionId: "abc123",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		usage: { input: 100, output: 10, cacheRead: 200, cacheWrite: 0, totalTokens: 310, cost: 0.001 },
		usageSemanticStatus: "verified",
		cacheHitRatio: 0.667,
		inferredInvalidationReason: "UNKNOWN",
		index: n,
	};
}

test("JSONL append: one record per line, read back in order", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir);
		for (let i = 1; i <= 3; i += 1) {
			const result = await store.appendRecord(record(i));
			assert.equal(result.ok, true, result.error);
		}
		const { records, skipped } = await store.readRecords();
		assert.equal(skipped, 0);
		assert.equal(records.length, 3);
		assert.equal((records[0] as { index: number }).index, 1);
		assert.equal((records[2] as { index: number }).index, 3);
		// file is under <root>/<CONFIG_DIR_NAME>/workbench/cache/telemetry.jsonl
		const text = await readFile(join(dir, CONFIG_DIR, "workbench", "cache", "telemetry.jsonl"), "utf8");
		assert.equal(text.split("\n").filter((l) => l.trim().length > 0).length, 3);
	});
});

test("corrupted lines are skipped and counted, valid lines still read", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir);
		await store.appendRecord(record(1));
		const path = join(dir, CONFIG_DIR, "workbench", "cache", "telemetry.jsonl");
		await writeFile(path, `${await readFile(path, "utf8")}{not-json}\ntrailing-garbage\n`, "utf8");
		const { records, skipped } = await store.readRecords();
		assert.equal(records.length, 1);
		assert.equal(skipped, 2);
	});
});

test("missing telemetry file reads as zero records without error", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir);
		const { records, skipped } = await store.readRecords();
		assert.equal(records.length, 0);
		assert.equal(skipped, 0);
	});
});

test("oversized and non-regular telemetry sources are rejected before allocation", async () => {
	await withTempDir(async (dir) => {
		const allocations: number[] = [];
		const reads: number[] = [];
		const store = new CacheStore(dir, {
			boundedReadHooks: {
				onBufferAllocate: (bytes) => allocations.push(bytes),
				beforeRead: (bytes) => reads.push(bytes),
			},
		});
		await mkdir(store.cacheDir(), { recursive: true });
		const handle = await open(store.telemetryPath(), "w");
		try { await handle.truncate(DEFAULT_MAX_TELEMETRY_BYTES + MAX_TELEMETRY_RECORD_BYTES + 1); }
		finally { await handle.close(); }
		assert.deepEqual(await store.readRecords(), { records: [], skipped: 0, unavailable: "source_oversized" });
		assert.deepEqual(allocations, [], "oversized telemetry is rejected before allocation");
		assert.deepEqual(reads, [], "oversized telemetry is rejected before read");

		await writeFile(store.telemetryPath(), "", "utf8");
		const directoryRoot = join(dir, "directory-source");
		const directoryAllocations: number[] = [];
		const directoryReads: number[] = [];
		const directoryStore = new CacheStore(directoryRoot, {
			boundedReadHooks: {
				onBufferAllocate: (bytes) => directoryAllocations.push(bytes),
				beforeRead: (bytes) => directoryReads.push(bytes),
			},
		});
		await mkdir(directoryStore.telemetryPath(), { recursive: true });
		assert.deepEqual(await directoryStore.readRecords(), { records: [], skipped: 0, unavailable: "source_not_regular" });
		assert.deepEqual(directoryAllocations, [], "non-regular telemetry is rejected before allocation");
		assert.deepEqual(directoryReads, [], "non-regular telemetry is rejected before read");
	});
});

test("a single telemetry record has a fixed 64 KiB hard cap before disk write", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir);
		const result = await store.appendRecord({ safeField: "x".repeat(MAX_TELEMETRY_RECORD_BYTES) });
		assert.deepEqual(result, { ok: false, error: "refused: telemetry record exceeds the fixed 65536-byte limit" });
		assert.equal(await store.telemetryBytes(), 0, "refused records never touch telemetry.jsonl");
	});
});

test("rotation: file beyond the limit is rotated, oldest dropped", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir, { maxFileBytes: 100, maxRotatedFiles: 3 });
		for (let i = 1; i <= 6; i += 1) {
			const result = await store.appendRecord(record(i));
			assert.equal(result.ok, true, result.error);
		}
		assert.equal(await store.rotatedFileCount(), 3, "telemetry.1/2/3.jsonl kept");
		// current file contains the newest records only
		const { records } = await store.readRecords();
		assert.ok(records.length >= 1);
		const newest = records[records.length - 1] as { index: number };
		assert.equal(newest.index, 6);
		// rotated files exist with bounded count
		const all = await store.telemetryBytesAll();
		assert.ok(all > 0);
	});
});

test("rotation keeps at most maxRotatedFiles rotated files", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir, { maxFileBytes: 1, maxRotatedFiles: 2 });
		for (let i = 1; i <= 10; i += 1) {
			await store.appendRecord(record(i));
		}
		assert.equal(await store.rotatedFileCount(), 2);
	});
});

test("write failure degrades to {ok:false} and never throws", async () => {
	await withTempDir(async (dir) => {
		// Block the path with a regular file so mkdir/append must fail.
		const blocker = join(dir, "blocker");
		await writeFile(blocker, "x", "utf8");
		const store = new CacheStore(join(blocker, "sub"));
		// read path: degrades to zero records
		const { records } = await store.readRecords();
		assert.equal(records.length, 0);
		// append returns an error instead of throwing
		const result = await store.appendRecord(record(1));
		assert.equal(result.ok, false);
		assert.ok(typeof result.error === "string" && result.error.length > 0);
	});
});

test("forbidden fields are refused before touching disk", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir);
		const bad = { ...record(1), content: "leaked system prompt" };
		const result = await store.appendRecord(bad);
		assert.equal(result.ok, false);
		assert.ok(result.error?.includes("forbidden field"));
		const { records } = await store.readRecords();
		assert.equal(records.length, 0, "nothing was written");
	});
});

test("forbidden-field scanner: exact keys, deep scan, schema keys allowed", () => {
	assert.equal(hasForbiddenTelemetryFields({ content: "x" }), "content");
	assert.equal(hasForbiddenTelemetryFields({ nested: { deep: { apiKey: "sk-..." } } }), "apiKey");
	assert.equal(hasForbiddenTelemetryFields({ list: [{ a: 1 }, { toolInput: { x: 1 } }] }), "toolInput");
	assert.equal(hasForbiddenTelemetryFields({ payload: { headers: {} } }), "payload");
	// hash fields are allowed — exact matching only
	assert.equal(hasForbiddenTelemetryFields({ systemPromptHash: "abc", activeToolNamesHash: "def", totalTokens: 10 }), null);
	// the full telemetry schema is clean
	const clean = {
		schemaVersion: "1.1",
		timestamp: "2026-01-01T00:00:00.000Z",
		extensionVersion: "0.7.0",
		hashedSessionId: "abc123",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		thinkingLevel: "high",
		workbenchMode: "DEV",
		messageStatus: "ok",
		usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, totalTokens: 3, cost: 0 },
		usageSemanticStatus: "verified",
		cacheHitRatio: 0.5,
		systemPromptHash: "a",
		activeToolNamesHash: "b",
		activeToolOrderHash: "c",
		activeToolSchemaHash: "d",
		contextShapeHash: null,
		precedingEvent: null,
		inferredInvalidationReason: "UNKNOWN",
		inferenceConfidence: "low",
		driftSource: null,
	};
	assert.equal(hasForbiddenTelemetryFields(clean), null);
});

test("report save is atomic and lists existing reports", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir);
		const saved = await store.saveReport("session-2026-01", { scope: "session", requestCount: 5 });
		assert.equal(saved.ok, true, saved.error);
		assert.ok(saved.path);
		assert.ok(saved.path.endsWith("session-2026-01.json"));
		// atomic: no tmp files remain
		const reports = await store.listReports();
		assert.deepEqual(reports, ["session-2026-01.json"]);
		// no temp artifacts in the reports dir
		const content = await readFile(saved.path as string, "utf8");
		assert.ok(content.includes("requestCount"));
	});
});

test("unsafe report names are sanitized", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir);
		const saved = await store.saveReport("../evil/name", { ok: true });
		assert.equal(saved.ok, true, saved.error);
		assert.ok(saved.path);
		assert.ok(!saved.path.includes(".."));
	});
});

test("telemetry size reporting", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir);
		assert.equal(await store.telemetryBytes(), 0);
		await store.appendRecord(record(1));
		const bytes = await store.telemetryBytes();
		assert.ok(bytes > 50);
	});
});

test("telemetryRef uses CONFIG_DIR_NAME without hardcoding .pi", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir);
		assert.equal(store.telemetryRef(), ".pi/workbench/cache/telemetry.jsonl");
	});
});
