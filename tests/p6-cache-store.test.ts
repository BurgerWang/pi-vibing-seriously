/**
 * P6-A store tests — JSONL append, rotation, corrupted lines, write-failure
 * fallback, atomic report saves, forbidden-field refusal, size limits.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename as fsRename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	CacheStore,
	DEFAULT_MAX_TELEMETRY_BYTES,
	MAX_TELEMETRY_RECORD_BYTES,
	hasForbiddenTelemetryFields,
} from "../extensions/workbench-runtime/cache/cache-store.ts";
import { isTelemetryRecord, type TelemetryRecord } from "../extensions/workbench-runtime/cache/cache-types.ts";
import { sha256Hex } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import { withTempDir } from "./helpers.ts";

const CONFIG_DIR = ".pi";

function record(n: number): TelemetryRecord {
	const input = 100;
	const output = 10;
	const cacheRead = 200;
	const cacheWrite = 0;
	return {
		schemaVersion: "1.1",
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
		extensionVersion: "0.7.0",
		hashedSessionId: sha256Hex("session").slice(0, 16),
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		thinkingLevel: "high",
		workbenchMode: "DEV",
		messageStatus: "ok",
		usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: 0.001 },
		usageSemanticStatus: "verified",
		cacheHitRatio: cacheRead / (input + cacheRead),
		systemPromptHash: sha256Hex("system"),
		activeToolNamesHash: sha256Hex("names"),
		activeToolOrderHash: sha256Hex("order"),
		activeToolSchemaHash: sha256Hex("schema"),
		contextShapeHash: sha256Hex(`context-${n}`),
		precedingEvent: "message_end",
		inferredInvalidationReason: "UNKNOWN",
		inferenceConfidence: "low",
		driftSource: null,
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
		assert.equal((records[0] as TelemetryRecord).contextShapeHash, sha256Hex("context-1"));
		assert.equal((records[2] as TelemetryRecord).contextShapeHash, sha256Hex("context-3"));
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

test("valid JSON with an invalid telemetry schema is skipped and marks chronological data incomplete", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir);
		await store.appendRecord(record(1));
		const path = store.telemetryPath();
		const malformed = { ...record(2), usage: { ...record(2).usage, totalTokens: 999 } };
		await writeFile(path, `${await readFile(path, "utf8")}${JSON.stringify(malformed)}\n`, "utf8");
		const current = await store.readRecords();
		assert.equal(current.records.length, 1);
		assert.equal(current.skipped, 1);
		const chronological = await store.readRecordsChronological();
		assert.equal(chronological.records.length, 1);
		assert.equal(chronological.skipped, 1);
		assert.equal(chronological.sourceIncomplete, true);
	});
});

test("invalid UTF-8 makes the telemetry source unavailable instead of trusting replacement-decoded JSON", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir);
		await mkdir(store.cacheDir(), { recursive: true });
		const payload = Buffer.from(`${JSON.stringify(record(1))}\n`, "utf8");
		const providerMarkerOffset = payload.indexOf(Buffer.from('"provider":"deepseek"', "utf8"));
		assert.notEqual(providerMarkerOffset, -1, "fixture must contain the provider value");
		const providerValueOffset = providerMarkerOffset + '"provider":"'.length;
		payload[providerValueOffset] = 0xff;
		await writeFile(store.telemetryPath(), payload);

		assert.deepEqual(await store.readRecords(), { records: [], skipped: 0, unavailable: "read_error" });
		const chronological = await store.readRecordsChronological();
		assert.equal(chronological.records.length, 0);
		assert.equal(chronological.skipped, 0);
		assert.equal(chronological.sourceIncomplete, true);
		assert.equal(chronological.unavailable, "read_error");
	});
});

test("strict telemetry validator accepts exact legacy 1.0 records and rejects proxies/accessors/unknown fields", () => {
	const current = record(1);
	const { driftSource: _driftSource, ...legacy } = { ...current, schemaVersion: "1.0" as const };
	assert.equal(isTelemetryRecord(current), true);
	assert.equal(isTelemetryRecord(legacy), true, "documented schema 1.0 archives remain readable");
	assert.equal(isTelemetryRecord({ ...current, unknown: true }), false);
	const accessor = { ...current } as Record<string, unknown>;
	Object.defineProperty(accessor, "provider", { enumerable: true, get: () => "deepseek" });
	assert.equal(isTelemetryRecord(accessor), false);
	assert.equal(isTelemetryRecord(new Proxy(current, {})), false);
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
		const newest = records[records.length - 1] as TelemetryRecord;
		assert.equal(newest.contextShapeHash, sha256Hex("context-6"));
		// rotated files exist with bounded count
		const all = await store.telemetryBytesAll();
		assert.ok(all > 0);
	});
});

test("chronological report read combines rotated and current files with a newest-record bound", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir, { maxFileBytes: 1, maxRotatedFiles: 3 });
		for (let i = 1; i <= 6; i += 1) await store.appendRecord(record(i));
		const all = await store.readRecordsChronological();
		assert.deepEqual(all.records.map((item) => (item as TelemetryRecord).contextShapeHash), [3, 4, 5, 6].map((n) => sha256Hex(`context-${n}`)));
		assert.equal(all.skipped, 0);
		assert.equal(all.sourceIncomplete, false);

		const bounded = await store.readRecordsChronological({ maxRecords: 2 });
		assert.deepEqual(bounded.records.map((item) => (item as TelemetryRecord).contextShapeHash), [5, 6].map((n) => sha256Hex(`context-${n}`)));
		assert.equal(bounded.truncatedRecords, 2);
		assert.equal(bounded.sourceIncomplete, false, "an intentional newest-record window is complete for that window");
	});
});

test("chronological read fails closed when a rotated generation has a missing middle file", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir, { maxRotatedFiles: 2 });
		await mkdir(store.cacheDir(), { recursive: true });
		await writeFile(store.rotatedPath(2), `${JSON.stringify(record(1))}\n`, "utf8");
		await writeFile(store.telemetryPath(), `${JSON.stringify(record(3))}\n`, "utf8");

		const read = await store.readRecordsChronological();
		assert.deepEqual(read.records.map((item) => (item as TelemetryRecord).contextShapeHash), [1, 3].map((n) => sha256Hex(`context-${n}`)));
		assert.equal(read.sourceIncomplete, true);
		assert.equal(read.unavailable, "rotation_gap");
		assert.equal(read.filesRead, 2);
	});
});

test("chronological read fails closed when rotated telemetry exists without the current file", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir, { maxRotatedFiles: 2 });
		await mkdir(store.cacheDir(), { recursive: true });
		await writeFile(store.rotatedPath(1), `${JSON.stringify(record(1))}\n`, "utf8");

		const read = await store.readRecordsChronological();
		assert.equal(read.records.length, 1);
		assert.equal(read.sourceIncomplete, true);
		assert.equal(read.unavailable, "rotation_gap");
		assert.equal(read.filesRead, 1);
	});
});

test("chronological read treats a clean project with no telemetry files as complete empty evidence", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir, { maxRotatedFiles: 2 });
		assert.deepEqual(await store.readRecordsChronological(), {
			records: [],
			skipped: 0,
			sourceIncomplete: false,
			truncatedRecords: 0,
			filesRead: 0,
		});
	});
});

test("non-ENOENT rotation rename failures propagate instead of being swallowed", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir, { maxFileBytes: 1, maxRotatedFiles: 2 });
		assert.equal((await store.appendRecord(record(1))).ok, true);
		await writeFile(store.rotatedPath(1), `${JSON.stringify(record(0))}\n`, "utf8");
		await chmod(store.cacheDir(), 0o500);
		try {
			await assert.rejects(() => store.rotateNow(), /EACCES|permission denied/i);
		} finally {
			await chmod(store.cacheDir(), 0o700);
		}
	});
});

test("append failure after a partial rotation leaves a visible generation gap", async () => {
	await withTempDir(async (dir) => {
		let renameCalls = 0;
		const store = new CacheStore(dir, {
			maxFileBytes: 1,
			maxRotatedFiles: 3,
			rotationRename: async (source, destination) => {
				renameCalls += 1;
				if (renameCalls === 2) {
					const error = new Error("forced rotation rename failure") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				await fsRename(source, destination);
			},
		});
		await mkdir(store.cacheDir(), { recursive: true });
		await writeFile(store.rotatedPath(2), `${JSON.stringify(record(1))}\n`, "utf8");
		await writeFile(store.rotatedPath(1), `${JSON.stringify(record(2))}\n`, "utf8");
		await writeFile(store.telemetryPath(), `${JSON.stringify(record(3))}\n`, "utf8");

		const append = await store.appendRecord(record(4));
		assert.equal(append.ok, false);
		assert.equal(append.error, "forced rotation rename failure");
		assert.equal(renameCalls, 2);

		const read = await store.readRecordsChronological();
		assert.deepEqual(read.records.map((item) => (item as TelemetryRecord).contextShapeHash), [1, 2, 3].map((n) => sha256Hex(`context-${n}`)));
		assert.equal(read.sourceIncomplete, true);
		assert.equal(read.unavailable, "rotation_gap");
		assert.ok(!read.records.some((item) => (item as TelemetryRecord).contextShapeHash === sha256Hex("context-4")));
	});
});

test("chronological read retries a rotation generation change and succeeds on the stable generation", async () => {
	await withTempDir(async (dir) => {
		let mutations = 0;
		let store!: CacheStore;
		store = new CacheStore(dir, {
			maxFileBytes: 1,
			maxRotatedFiles: 2,
			boundedReadHooks: {
				afterRead: async () => {
					if (mutations > 0) return;
					mutations += 1;
					await store.appendRecord(record(4));
				},
			},
		});
		await store.appendRecord(record(1));
		await store.appendRecord(record(2));
		await store.appendRecord(record(3));
		const read = await store.readRecordsChronological();
		assert.equal(mutations, 1);
		assert.equal(read.sourceIncomplete, false);
		assert.equal((read.records.at(-1) as TelemetryRecord).contextShapeHash, sha256Hex("context-4"));
	});
});

test("chronological read fails closed when the rotation generation changes on both attempts", async () => {
	await withTempDir(async (dir) => {
		let mutations = 0;
		let store!: CacheStore;
		store = new CacheStore(dir, {
			maxFileBytes: 1,
			maxRotatedFiles: 2,
			boundedReadHooks: {
				afterRead: async () => {
					mutations += 1;
					await store.appendRecord(record(10 + mutations));
				},
			},
		});
		await store.appendRecord(record(1));
		await store.appendRecord(record(2));
		await store.appendRecord(record(3));
		const read = await store.readRecordsChronological();
		assert.ok(mutations >= 2);
		assert.equal(read.sourceIncomplete, true);
		assert.equal(read.unavailable, "source_changed_during_read");
	});
});

test("chronological parser retains only the newest bounded window across many tiny lines", async () => {
	await withTempDir(async (dir) => {
		const store = new CacheStore(dir);
		await mkdir(store.cacheDir(), { recursive: true });
		const lines: string[] = [];
		for (let index = 1; index <= 5_000; index += 1) lines.push(JSON.stringify(record(index)));
		await writeFile(store.telemetryPath(), `${lines.join("\n")}\n`, "utf8");
		const read = await store.readRecordsChronological({ maxRecords: 7 });
		assert.equal(read.records.length, 7);
		assert.equal(read.truncatedRecords, 4_993);
		assert.equal(read.sourceIncomplete, false);
		assert.equal((read.records[0] as TelemetryRecord).contextShapeHash, sha256Hex("context-4994"));
		assert.equal((read.records.at(-1) as TelemetryRecord).contextShapeHash, sha256Hex("context-5000"));
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
