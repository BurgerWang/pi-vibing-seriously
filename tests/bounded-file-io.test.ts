import assert from "node:assert/strict";
import { mkdtemp, open, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
	BOUNDED_PAGE_MAX_BYTES,
	fileSourceSnapshotFromStats,
	readJsonFileBounded,
	readTailPage,
	readTextPage,
	readUtf8FileBounded,
	type BoundedFileResult,
	type TailPage,
	type TextPage,
} from "../extensions/workbench-runtime/core/bounded-file-io.ts";
import type { FileSourceSnapshot } from "../extensions/workbench-runtime/core/continuation-cursor.ts";

async function fixture(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "workbench-bounded-io-"));
	t.after(async () => { await rm(dir, { recursive: true, force: true }); });
	return dir;
}

function value<T>(result: BoundedFileResult<T>): T {
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("expected success");
	return result.value;
}

function code(result: BoundedFileResult<unknown>, expected: string): void {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected failure");
	assert.equal(result.error.code, expected);
	assert.ok(Buffer.byteLength(result.error.message, "utf8") < 128);
	assert.doesNotMatch(result.error.message, /[/\\]/);
}

test("bounded whole-file reads accept the exact cap and reject oversize before allocation or read", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "record.json");
	const raw = "{\"ok\":true}";
	await writeFile(path, raw, "utf8");
	const exact = value(await readJsonFileBounded<{ ok: boolean }>(path, Buffer.byteLength(raw)));
	assert.deepEqual(exact.value, { ok: true });
	assert.equal(exact.bytes, Buffer.byteLength(raw));
	assert.equal(exact.source.fileSize, exact.bytes);

	const allocated: number[] = [];
	const reads: number[] = [];
	const oversized = await readJsonFileBounded(path, Buffer.byteLength(raw) - 1, {
		onBufferAllocate(bytes) { allocated.push(bytes); },
		beforeRead(bytes) { reads.push(bytes); },
	});
	code(oversized, "source_oversized");
	assert.deepEqual(allocated, []);
	assert.deepEqual(reads, []);
});

test("whole-file readers reject non-regular, invalid UTF-8, invalid JSON, and invalid limits with fixed errors", async (t) => {
	const dir = await fixture(t);
	code(await readUtf8FileBounded(dir, 100), "source_not_regular");
	const invalidUtf8 = join(dir, "invalid.txt");
	await writeFile(invalidUtf8, Buffer.from([0x61, 0xff, 0x62]));
	code(await readUtf8FileBounded(invalidUtf8, 100), "invalid_utf8");
	const invalidJson = join(dir, "invalid.json");
	await writeFile(invalidJson, "{nope}", "utf8");
	code(await readJsonFileBounded(invalidJson, 100), "invalid_json");
	code(await readUtf8FileBounded(invalidUtf8, 0), "invalid_pagination");
	code(await readUtf8FileBounded(join(dir, "missing"), 100), "io_error");
});

test("forward text pages preserve CRLF, trailing newlines, Unicode, and reconstruct the original bytes", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "source.txt");
	const original = "alpha\r\n汉🙂\r\nomega\n";
	await writeFile(path, original, "utf8");
	let startByte = 0;
	let lineNumber = 1;
	let reconstructed = "";
	let pages = 0;
	while (true) {
		const page = value(await readTextPage(path, { startByte, lineNumber, maxBytes: 9, maxLines: 1 }));
		assert.ok(page.shownBytes <= 9);
		assert.ok(page.shownLines <= 1);
		reconstructed += page.text;
		pages += 1;
		if (page.completeAfter) break;
		assert.equal(page.nextByteOffset, page.endExclusive);
		assert.ok(page.nextByteOffset! > startByte, "each normal page makes progress");
		startByte = page.nextByteOffset!;
		lineNumber = page.nextLineNumber!;
		assert.ok(pages < 20);
	}
	assert.ok(pages >= 3);
	assert.equal(reconstructed, original);
	assert.deepEqual(Buffer.from(reconstructed, "utf8"), Buffer.from(original, "utf8"));
});

test("forward paging segments a long single line only at code-point boundaries", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "long-line.txt");
	const original = `${"🙂".repeat(80)}END`;
	await writeFile(path, original, "utf8");
	let startByte = 0;
	let reconstructed = "";
	let segments = 0;
	while (true) {
		const page = value(await readTextPage(path, { startByte, lineNumber: 1, maxBytes: 9, maxLines: 1 }));
		assert.ok(page.shownBytes <= 9);
		assert.doesNotMatch(page.text, /\ufffd/);
		reconstructed += page.text;
		segments += 1;
		if (page.completeAfter) {
			assert.equal(page.lineSegment, false);
			break;
		}
		assert.equal(page.lineSegment, true);
		assert.equal(page.nextLineNumber, 1);
		startByte = page.nextByteOffset!;
		assert.ok(segments < 100);
	}
	assert.ok(segments > 20);
	assert.equal(reconstructed, original);
});

test("forward pagination rejects a byte cap smaller than the next UTF-8 scalar and always progresses on success", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "one-emoji.txt");
	await writeFile(path, "🙂", "utf8");
	for (const maxBytes of [1, 2, 3]) {
		code(await readTextPage(path, { maxBytes, maxLines: 1 }), "invalid_pagination");
	}
	const page = value(await readTextPage(path, { maxBytes: 4, maxLines: 1 }));
	assert.equal(page.text, "🙂");
	assert.equal(page.shownBytes, 4);
	assert.ok(page.endExclusive > page.startByte);
	assert.equal(page.completeAfter, true);
});

test("an arbitrary forward start inside an emoji aligns to the next scalar without replacement", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "unicode.txt");
	await writeFile(path, "a🙂b", "utf8");
	const page = value(await readTextPage(path, { startByte: 2, lineNumber: 1, maxBytes: 8, maxLines: 2 }));
	assert.equal(page.requestedStartByte, 2);
	assert.equal(page.startByte, 5);
	assert.equal(page.startAligned, true);
	assert.equal(page.text, "b");
	assert.equal(page.completeAfter, true);
});

test("tail pages use positional suffix reads, obey endExclusive, and reconstruct by prepending", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "log.txt");
	const original = "one\r\ntwo🙂\nthree\nfour\n";
	await writeFile(path, original, "utf8");
	let endExclusive: number | undefined;
	let reconstructed = "";
	let pages = 0;
	while (true) {
		const page = value(await readTailPage(path, { endExclusive, maxBytes: 10, maxLines: 2 }));
		assert.ok(page.shownBytes <= 10);
		assert.ok(page.shownLines <= 2);
		reconstructed = page.text + reconstructed;
		pages += 1;
		if (page.completeBefore) break;
		assert.equal(page.previousEndExclusive, page.startByte);
		endExclusive = page.previousEndExclusive;
		assert.ok(pages < 20);
	}
	assert.ok(pages >= 2);
	assert.equal(reconstructed, original);

	const endAtThree = Buffer.byteLength("one\r\ntwo🙂\nthree", "utf8");
	const boundedEnd = value(await readTailPage(path, { endExclusive: endAtThree, maxBytes: 100, maxLines: 10 }));
	assert.equal(boundedEnd.endExclusive, endAtThree);
	assert.equal(boundedEnd.text, "one\r\ntwo🙂\nthree");
});

test("tail end inside a multibyte scalar aligns backward and never inserts replacement text", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "tail-unicode.txt");
	await writeFile(path, "a🙂b", "utf8");
	const page = value(await readTailPage(path, { endExclusive: 3, maxBytes: 20, maxLines: 2 }));
	assert.equal(page.endAligned, true);
	assert.equal(page.endExclusive, 1);
	assert.equal(page.text, "a");
	assert.doesNotMatch(page.text, /\ufffd/);
});

test("tail pagination rejects a byte cap smaller than the next UTF-8 scalar and always progresses on success", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "tail-emoji.txt");
	await writeFile(path, "🙂", "utf8");
	for (const maxBytes of [1, 2, 3]) {
		code(await readTailPage(path, { maxBytes, maxLines: 1 }), "invalid_pagination");
	}
	const page = value(await readTailPage(path, { maxBytes: 4, maxLines: 1 }));
	assert.equal(page.text, "🙂");
	assert.equal(page.shownBytes, 4);
	assert.ok(page.startByte < page.endExclusive);
	assert.equal(page.completeBefore, true);
});

test("a source mutation between read and restat fails with source_changed_during_read", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "changing.txt");
	await writeFile(path, "before", "utf8");
	let mutated = false;
	const result = await readTextPage(path, {
		maxBytes: 32,
		maxLines: 2,
		hooks: {
			async afterRead() {
				if (!mutated) {
					mutated = true;
					await writeFile(path, "after-and-longer", "utf8");
				}
			},
		},
	});
	code(result, "source_changed_during_read");
});

test("a same-size rewrite inside one millisecond fails the live same-handle check", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "sub-ms-changing.txt");
	const second = 1_700_000_000;
	await writeFile(path, "before", "utf8");
	await utimes(path, second + 0.0001, second + 0.0001);
	let initialSnapshot: FileSourceSnapshot | undefined;
	const result = await readTextPage(path, {
		maxBytes: 32,
		maxLines: 2,
		hooks: {
			afterInitialStat(snapshot) {
				initialSnapshot = { ...snapshot };
			},
			async afterRead(snapshot) {
				assert.equal(snapshot.fileSize, 6);
				await writeFile(path, "after!", "utf8");
				await utimes(path, second + 0.0009, second + 0.0009);
			},
		},
	});
	assert.ok(initialSnapshot);
	assert.match(initialSnapshot.mtimeNs ?? "", /^[0-9]+$/);
	const verifier = await open(path, "r");
	let currentSnapshot: FileSourceSnapshot;
	try {
		currentSnapshot = value(fileSourceSnapshotFromStats(await verifier.stat({ bigint: true })));
	} finally {
		await verifier.close();
	}
	assert.equal(currentSnapshot.fileSize, initialSnapshot.fileSize);
	assert.equal(currentSnapshot.mtimeMs, initialSnapshot.mtimeMs, "both writes remain inside one legacy millisecond bucket");
	assert.equal(currentSnapshot.dev, initialSnapshot.dev);
	assert.equal(currentSnapshot.ino, initialSnapshot.ino);
	assert.notEqual(currentSnapshot.mtimeNs, initialSnapshot.mtimeNs);
	code(result, "source_changed_during_read");
});

test("a generated 1 GiB sparse file allocates only page-cap-related memory", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "one-gib-sparse.log");
	const handle = await open(path, "w");
	try { await handle.truncate(1024 * 1024 * 1024); }
	finally { await handle.close(); }
	const allocations: number[] = [];
	const page = value(await readTailPage(path, {
		maxBytes: 4_096,
		maxLines: 400,
		hooks: { onBufferAllocate(bytes) { allocations.push(bytes); } },
	}));
	assert.equal(page.shownBytes, 4_096);
	assert.equal(page.source.fileSize, 1024 * 1024 * 1024);
	assert.ok(Math.max(...allocations) <= 4_096 + 4);
	assert.equal(page.completeBefore, false);
});

test("page hard ceilings cannot be enlarged and hostile option getters fail closed", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "large.txt");
	await writeFile(path, "x".repeat(BOUNDED_PAGE_MAX_BYTES + 100), "utf8");
	const allocations: number[] = [];
	const page = value(await readTextPage(path, {
		maxBytes: Number.MAX_SAFE_INTEGER,
		maxLines: Number.MAX_SAFE_INTEGER,
		hooks: { onBufferAllocate(bytes) { allocations.push(bytes); } },
	}));
	assert.equal(page.shownBytes, BOUNDED_PAGE_MAX_BYTES);
	assert.ok(Math.max(...allocations) <= BOUNDED_PAGE_MAX_BYTES + 4);

	const hostile = new Proxy({ maxBytes: 10, maxLines: 1 }, { get(): never { throw new Error("secret"); } });
	code(await readTextPage(path, hostile), "invalid_pagination");
	code(await readTailPage(path, { maxBytes: 10, maxLines: 0 }), "invalid_pagination");
});

test("empty files produce complete empty forward and tail pages", async (t) => {
	const dir = await fixture(t);
	const path = join(dir, "empty.txt");
	await writeFile(path, "", "utf8");
	const forward: TextPage = value(await readTextPage(path, { maxBytes: 16, maxLines: 2 }));
	const tail: TailPage = value(await readTailPage(path, { maxBytes: 16, maxLines: 2 }));
	assert.equal(forward.text, "");
	assert.equal(forward.completeAfter, true);
	assert.equal(forward.shownLines, 0);
	assert.equal(tail.text, "");
	assert.equal(tail.completeBefore, true);
	assert.equal(tail.shownLines, 0);
});
