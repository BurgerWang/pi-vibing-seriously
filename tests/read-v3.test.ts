import assert from "node:assert/strict";
import { mkdir, rename, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

import { createReadToolDefinition, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import workbenchRuntime, { installNativeReadV3TestHooks } from "../extensions/workbench-runtime/index.ts";
import {
	buildNativeReadV3Page,
	NATIVE_OVERRIDE_PARAMETERS,
	READ_V3_ALLOCATION_TOO_SMALL,
	READ_V3_MAX_FILE_LINES,
	READ_V3_MAX_OUTPUT_BYTES,
	READ_V3_MAX_TOTAL_LINES,
} from "../extensions/workbench-runtime/core/native-tool-policy.ts";
import { decodeContinuationCursor } from "../extensions/workbench-runtime/core/continuation-cursor.ts";
import {
	COMMANDER_TURN_MAX_BYTES,
	WORKER_TURN_MAX_BYTES,
} from "../extensions/workbench-runtime/core/output-policy.ts";
import { planTurnOutputBudget } from "../extensions/workbench-runtime/core/turn-output-budget.ts";
import { WORKER_ALLOWED_PATHS_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ROLE_ENV } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { WORKER_SPEND_PROFILE_ENV } from "../extensions/workbench-runtime/core/worker-spend.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

interface StubAPI {
	tools: Map<string, unknown>;
	events: Map<string, Array<(event: never, ctx: never) => unknown>>;
	activeTools: string[];
}

function makeStub(): StubAPI & ExtensionAPI {
	const stub = {
		tools: new Map<string, unknown>(),
		events: new Map<string, Array<(event: never, ctx: never) => unknown>>(),
		activeTools: [] as string[],
		registerCommand: () => {},
		registerTool: (definition: { name: string }) => { stub.tools.set(definition.name, definition); },
		on: (event: string, handler: (event: never, ctx: never) => unknown) => {
			const handlers = stub.events.get(event) ?? [];
			handlers.push(handler);
			stub.events.set(event, handlers);
		},
		appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {},
		setActiveTools: (tools: string[]) => { stub.activeTools = [...tools]; },
		getActiveTools: () => stub.activeTools,
		getAllTools: () => [...stub.tools.values()] as never[],
		getThinkingLevel: () => "high" as never,
		exec: spawnExec,
	} as unknown as StubAPI & ExtensionAPI;
	return stub;
}

function trustedCtx(root: string): ExtensionCommandContext {
	return {
		mode: "tui", hasUI: true, cwd: root, isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => [], getSessionFile: () => `${root}/session.jsonl`, getSessionId: () => "read-v3-test",
		} as unknown as ExtensionContext["sessionManager"],
		model: undefined,
		ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {}, confirm: () => false } as unknown as ExtensionContext["ui"],
		signal: undefined,
	} as unknown as ExtensionCommandContext;
}

interface ReadResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: Record<string, unknown>;
}

interface ReadTool {
	execute: (
		id: string,
		params: { path: string; offset?: number; limit?: number; cursor?: string },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<ReadResult>;
}

function registeredRead(): { stub: StubAPI & ExtensionAPI; read: ReadTool } {
	const stub = makeStub();
	workbenchRuntime(stub);
	const read = stub.tools.get("read") as ReadTool | undefined;
	assert.ok(read);
	return { stub, read };
}

function registeredReadForRole(role: "commander" | "worker"): { stub: StubAPI & ExtensionAPI; read: ReadTool } {
	const previous = process.env[WORKER_ROLE_ENV];
	try {
		if (role === "worker") process.env[WORKER_ROLE_ENV] = "worker";
		else delete process.env[WORKER_ROLE_ENV];
		return registeredRead();
	} finally {
		if (previous === undefined) delete process.env[WORKER_ROLE_ENV];
		else process.env[WORKER_ROLE_ENV] = previous;
	}
}

async function emitEvent(stub: StubAPI, name: string, event: unknown, ctx: ExtensionContext): Promise<void> {
	for (const handler of stub.events.get(name) ?? []) {
		await (handler as unknown as (value: unknown, context: unknown) => unknown)(event, ctx);
	}
}

async function emitMessageEnd(stub: StubAPI, message: Record<string, unknown>, ctx: ExtensionContext): Promise<void> {
	let current = message;
	for (const handler of stub.events.get("message_end") ?? []) {
		const patch = await (handler as unknown as (value: unknown, context: unknown) => unknown)({ type: "message_end", message: current }, ctx) as { message?: Record<string, unknown> } | undefined;
		if (patch?.message) current = patch.message;
	}
}

async function emitToolCall(stub: StubAPI, event: unknown, ctx: ExtensionContext): Promise<{ block?: boolean; reason?: string }> {
	let result: { block?: boolean; reason?: string } = {};
	for (const handler of stub.events.get("tool_call") ?? []) {
		const patch = await (handler as unknown as (value: unknown, context: unknown) => unknown)(event, ctx) as { block?: boolean; reason?: string } | undefined;
		if (patch) result = patch;
		if (result.block) break;
	}
	return result;
}

async function emitToolResult(stub: StubAPI, event: {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: Array<Record<string, unknown>>;
	isError: boolean;
	details?: unknown;
}): Promise<ReadResult> {
	const current = { type: "tool_result", ...event };
	for (const handler of stub.events.get("tool_result") ?? []) {
		const patch = await (handler as unknown as (value: unknown, context: unknown) => unknown)(current, undefined) as {
			content?: Array<Record<string, unknown>>;
			details?: unknown;
			isError?: boolean;
		} | undefined;
		if (patch?.content !== undefined) current.content = patch.content;
		if (patch?.details !== undefined) current.details = patch.details;
		if (patch?.isError !== undefined) current.isError = patch.isError;
	}
	return current as unknown as ReadResult;
}

function assistantReadBatch(calls: Array<{ id: string; params: Record<string, unknown> }>): Record<string, unknown> {
	return {
		role: "assistant",
		content: calls.map((call) => ({ type: "toolCall", id: call.id, name: "read", arguments: call.params })),
		provider: "test",
		model: "test",
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function textOf(result: ReadResult): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

function unquote(result: ReadResult): Buffer {
	const text = textOf(result);
	const begin = "--- BEGIN QUOTED FILE CONTENT ---\n";
	const end = "--- END QUOTED FILE CONTENT ---";
	const start = text.indexOf(begin);
	const finish = text.lastIndexOf(end);
	assert.ok(start >= 0 && finish > start);
	const body = text.slice(start + begin.length, finish);
	const raw = body.startsWith("│ ") ? body.slice(2).replaceAll("\n│ ", "\n") : "";
	const shown = result.details?.shown_bytes;
	assert.equal(typeof shown, "number");
	return Buffer.from(raw, "utf8").subarray(0, shown as number);
}

function nextCursor(result: ReadResult): string | undefined {
	const value = result.details?.next_cursor;
	return typeof value === "string" ? value : undefined;
}

function assertPageBound(result: ReadResult): void {
	const text = textOf(result);
	assert.ok(Buffer.byteLength(text, "utf8") <= READ_V3_MAX_OUTPUT_BYTES);
	assert.ok(text.split("\n").length <= READ_V3_MAX_TOTAL_LINES);
	const shownLines = result.details?.shown_lines;
	assert.equal(typeof shownLines, "number");
	assert.ok((shownLines as number) <= READ_V3_MAX_FILE_LINES);
}

function tinyBmp(): Buffer {
	const bmp = Buffer.alloc(58);
	bmp.write("BM", 0, "ascii");
	bmp.writeUInt32LE(bmp.length, 2);
	bmp.writeUInt32LE(54, 10);
	bmp.writeUInt32LE(40, 14);
	bmp.writeInt32LE(1, 18);
	bmp.writeInt32LE(1, 22);
	bmp.writeUInt16LE(1, 26);
	bmp.writeUInt16LE(24, 28);
	bmp.writeUInt32LE(4, 34);
	return bmp;
}

before(() => {
	delete process.env[WORKER_ROLE_ENV];
	delete process.env[WORKER_PROJECT_ROOT_ENV];
	delete process.env[WORKER_ALLOWED_PATHS_ENV];
	delete process.env[WORKER_SPEND_PROFILE_ENV];
});

test("read v3 schema fixes integer caps and adds a bounded cursor", () => {
	const properties = NATIVE_OVERRIDE_PARAMETERS.read.properties;
	const { offset, limit, cursor } = properties;
	assert.ok(offset && limit && cursor);
	const offsetSchema = offset as unknown as { type: string; minimum: number };
	const limitSchema = limit as unknown as { type: string; minimum: number; maximum: number };
	const cursorSchema = cursor as unknown as { minLength: number; maxLength: number };
	assert.equal(offsetSchema.type, "integer");
	assert.equal(offsetSchema.minimum, 1);
	assert.equal(limitSchema.type, "integer");
	assert.equal(limitSchema.minimum, 1);
	assert.equal(limitSchema.maximum, 240);
	assert.equal(cursorSchema.minLength, 1);
	assert.equal(cursorSchema.maxLength, 1024);
});

test("builder refuses an allocation that cannot fit a complete protocol and one-scalar progress", () => {
	assert.throws(() => buildNativeReadV3Page({
		displayPath: "tiny.txt",
		sourceId: "a".repeat(64),
		maxOutputBytes: 1,
		page: {
			text: "x",
			requestedStartByte: 0,
			startByte: 0,
			endExclusive: 1,
			shownBytes: 1,
			shownLines: 1,
			startLineNumber: 1,
			nextByteOffset: 1,
			nextLineNumber: 1,
			completeAfter: false,
			lineSegment: true,
			startsWithinLine: false,
			startAligned: true,
			source: { fileSize: 2, mtimeMs: 1 },
		},
	}), new RegExp(READ_V3_ALLOCATION_TOO_SMALL));
});

test("real 8/16-read turn batches render inside each reservation and cursor pages reconstruct exactly", async () => {
	await withTempDir(async (root) => {
		await mkdir(join(root, ".pi", "workbench"), { recursive: true });
		const source = Buffer.from(`${"line-中文🙂-abcdef\r\n".repeat(700)}tail-🙂`, "utf8");
		await writeFile(join(root, "batch.txt"), source);

		for (const scenario of [
			{ role: "commander" as const, lanes: 8, cap: COMMANDER_TURN_MAX_BYTES },
			{ role: "worker" as const, lanes: 16, cap: WORKER_TURN_MAX_BYTES },
		]) {
			const { stub, read } = registeredReadForRole(scenario.role);
			const ctx = trustedCtx(root) as ExtensionContext;
			if (scenario.role === "commander") {
				await emitEvent(stub, "model_select", {
					type: "model_select",
					model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" },
					previousModel: undefined,
					source: "set",
				}, ctx);
			}
			const pieces = Array.from({ length: scenario.lanes }, () => [] as Buffer[]);
			const cursors = Array<string | undefined>(scenario.lanes).fill(undefined);
			const complete = Array<boolean>(scenario.lanes).fill(false);
			for (let page = 0; page < 20 && complete.some((value) => !value); page += 1) {
				const active = complete.flatMap((done, lane) => done ? [] : [lane]);
				const calls = active.map((lane) => ({
					id: `${scenario.role}-${page}-${lane}`,
					params: { path: "batch.txt", ...(cursors[lane] ? { cursor: cursors[lane] } : {}) },
				}));
				await emitEvent(stub, "turn_start", { type: "turn_start", turnIndex: page, timestamp: 1 }, ctx);
				await emitMessageEnd(stub, assistantReadBatch(calls), ctx);
				const expected = planTurnOutputBudget({
					turnSerial: page,
					role: scenario.role,
					calls: calls.map((call) => ({ toolCallId: call.id, toolName: "read", args: call.params })),
				});
				let batchBytes = 0;
				for (const [ordinal, call] of calls.entries()) {
					const lane = active[ordinal]!;
					const guard = await emitToolCall(stub, { type: "tool_call", toolCallId: call.id, toolName: "read", input: call.params }, ctx);
					assert.equal(guard.block, undefined, `${scenario.role} lane ${lane} page ${page}`);
					const raw = await read.execute(call.id, call.params, undefined, undefined, ctx);
					const result = await emitToolResult(stub, {
						toolCallId: call.id,
						toolName: "read",
						input: call.params,
						content: raw.content as unknown as Array<Record<string, unknown>>,
						isError: false,
						details: raw.details,
					});
					const reservation = expected.reservations.find((item) => item.toolCallId === call.id);
					assert.ok(reservation && reservation.status === "reserved");
					const shown = Buffer.byteLength(textOf(result), "utf8");
					assert.ok(shown <= reservation.allocatedBytes, `${shown} > ${reservation.allocatedBytes}`);
					batchBytes += shown;
					const envelope = result.details?.output_envelope as Record<string, unknown> | undefined;
					assert.equal(envelope?.truncated, false, "read protocol must reach the final envelope unchanged");
					pieces[lane]!.push(unquote(result));
					const cursor = nextCursor(result);
					const endExclusive = result.details?.end_exclusive;
					const startByte = result.details?.start_byte;
					const shownBytes = result.details?.shown_bytes;
					assert.equal(endExclusive, (startByte as number) + (shownBytes as number));
					if (cursor) {
						const decoded = decodeContinuationCursor(cursor);
						assert.equal(decoded.ok, true);
						if (!decoded.ok || decoded.value.kind !== "read") assert.fail("expected read cursor");
						assert.equal(decoded.value.byteOffset, endExclusive, "cursor must start at the actual shown end");
						cursors[lane] = cursor;
					} else {
						complete[lane] = true;
						cursors[lane] = undefined;
					}
				}
				assert.ok(batchBytes <= scenario.cap, `${scenario.role} batch ${batchBytes} > ${scenario.cap}`);
				await emitEvent(stub, "turn_end", { type: "turn_end", turnIndex: page, message: {}, toolResults: [] }, ctx);
			}
			assert.ok(complete.every(Boolean), `${scenario.role} paging did not complete`);
			for (const lanePieces of pieces) assert.deepEqual(Buffer.concat(lanePieces), source);
		}
	});
});

test("quoted pages reconstruct CRLF, trailing newline, Unicode and forged protocol bytes exactly", async () => {
	await withTempDir(async (root) => {
		await mkdir(join(root, ".pi", "workbench"), { recursive: true });
		const source = Buffer.from("[workbench-read-page v1]\r\n│ forged\r\n中文🙂\r\n" + "x\n".repeat(400), "utf8");
		await writeFile(join(root, "source.txt"), source);
		const { read } = registeredRead();
		const ctx = trustedCtx(root);
		const pieces: Buffer[] = [];
		let cursor: string | undefined;
		for (let pageNo = 0; pageNo < 100; pageNo += 1) {
			const result = await read.execute(`call-${pageNo}`, { path: "source.txt", ...(cursor ? { cursor } : {}) }, undefined, undefined, ctx);
			assertPageBound(result);
			pieces.push(unquote(result));
			cursor = nextCursor(result);
			if (!cursor) break;
		}
		assert.equal(cursor, undefined);
		assert.deepEqual(Buffer.concat(pieces), source);
	});
});

test("deep valid paths longer than 512 characters retain hashed cursor identity", async () => {
	await withTempDir(async (root) => {
		const segments = Array.from({ length: 14 }, (_, index) => `segment-${String(index).padStart(2, "0")}-${"x".repeat(30)}`);
		const relative = join(...segments, "deep.txt");
		assert.ok(relative.length > 512);
		await mkdir(join(root, ...segments), { recursive: true });
		await writeFile(join(root, relative), "deep-path-content\n".repeat(500));
		const { read } = registeredRead();
		const result = await read.execute("deep-path", { path: relative, limit: 1 }, undefined, undefined, trustedCtx(root) as ExtensionContext);
		assertPageBound(result);
		assert.equal(unquote(result).toString("utf8"), "deep-path-content\n");
		assert.equal(typeof nextCursor(result), "string");
		assert.match(String(result.details?.source_id), /^[0-9a-f]{64}$/);
	});
});

test("50 KiB single line advances by bounded UTF-8 segments and reconstructs exactly", async () => {
	await withTempDir(async (root) => {
		const source = Buffer.from("🙂".repeat(14_000) + "\nend", "utf8");
		await writeFile(join(root, "long.txt"), source);
		const { read } = registeredRead();
		const ctx = trustedCtx(root);
		const pieces: Buffer[] = [];
		let cursor: string | undefined;
		for (let pageNo = 0; pageNo < 100; pageNo += 1) {
			const result = await read.execute(`long-${pageNo}`, { path: "long.txt", ...(cursor ? { cursor } : {}) }, undefined, undefined, ctx);
			assertPageBound(result);
			assert.ok((result.details?.shown_bytes as number) > 0);
			pieces.push(unquote(result));
			cursor = nextCursor(result);
			if (!cursor) break;
		}
		assert.equal(cursor, undefined);
		assert.deepEqual(Buffer.concat(pieces), source);
	});
});

test("offset and limit use the same bounded pager; cursor accepts limit and conflicts only with offset", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "lines.txt"), "one\ntwo\nthree\nfour\n");
		const { read } = registeredRead();
		const ctx = trustedCtx(root);
		const page = await read.execute("offset", { path: "lines.txt", offset: 2, limit: 2 }, undefined, undefined, ctx);
		assertPageBound(page);
		assert.equal(unquote(page).toString("utf8"), "two\nthree\n");
		const cursor = nextCursor(page);
		assert.ok(cursor);
		const conflict = await read.execute("conflict", { path: "lines.txt", cursor, offset: 2 }, undefined, undefined, ctx);
		assert.equal(textOf(conflict), "workbench_read: invalid_pagination");
		const limitedContinuation = await read.execute("limit-continuation", { path: "lines.txt", cursor, limit: 1 }, undefined, undefined, ctx);
		assertPageBound(limitedContinuation);
		assert.equal(unquote(limitedContinuation).toString("utf8"), "four\n");
		assert.equal(limitedContinuation.details?.shown_lines, 1);
		assert.equal(nextCursor(limitedContinuation), undefined);
	});
});

test("cursor plus a lower line limit reconstructs the complete UTF-8 source", async () => {
	await withTempDir(async (root) => {
		const source = Buffer.from(Array.from({ length: 37 }, (_, index) => `line-${index}-中文🙂\r\n`).join(""), "utf8");
		await writeFile(join(root, "cursor-limit.txt"), source);
		const { read } = registeredRead();
		const ctx = trustedCtx(root);
		const pieces: Buffer[] = [];
		let cursor: string | undefined;
		for (let pageNo = 0; pageNo < 100; pageNo += 1) {
			const limit = pageNo === 0 ? 4 : 3;
			const result = await read.execute(
				`cursor-limit-${pageNo}`,
				{ path: "cursor-limit.txt", limit, ...(cursor ? { cursor } : {}) },
				undefined,
				undefined,
				ctx,
			);
			assertPageBound(result);
			assert.ok((result.details?.shown_lines as number) <= limit);
			pieces.push(unquote(result));
			cursor = nextCursor(result);
			if (!cursor) break;
		}
		assert.equal(cursor, undefined);
		assert.deepEqual(Buffer.concat(pieces), source);
	});
});

test("cursor is source-bound, stale on file change, and malformed cursors fail closed", async () => {
	await withTempDir(async (root) => {
		const second = 1_700_000_000;
		await writeFile(join(root, "a.txt"), "a\n".repeat(500));
		await utimes(join(root, "a.txt"), second + 0.0001, second + 0.0001);
		await writeFile(join(root, "b.txt"), "b\n".repeat(500));
		const { read } = registeredRead();
		const ctx = trustedCtx(root);
		const first = await read.execute("first", { path: "a.txt", limit: 1 }, undefined, undefined, ctx);
		const cursor = nextCursor(first);
		assert.ok(cursor);
		const decoded = decodeContinuationCursor(cursor);
		assert.equal(decoded.ok, true);
		if (!decoded.ok || decoded.value.kind !== "read") assert.fail("expected read cursor");
		if (decoded.value.v !== 2) assert.fail("expected high-resolution read cursor");
		assert.match(decoded.value.mtimeNs, /^[0-9]+$/);
		const wrong = await read.execute("wrong", { path: "b.txt", cursor }, undefined, undefined, ctx);
		assert.equal(textOf(wrong), "workbench_read: source_mismatch");
		await writeFile(join(root, "a.txt"), "z\n".repeat(500));
		await utimes(join(root, "a.txt"), second + 0.0009, second + 0.0009);
		const stale = await read.execute("stale", { path: "a.txt", cursor }, undefined, undefined, ctx);
		assert.equal(textOf(stale), "workbench_read: stale_cursor");
		const invalid = await read.execute("invalid", { path: "a.txt", cursor: "wbcur1.not-valid.0000000000000000" }, undefined, undefined, ctx);
		assert.equal(textOf(invalid), "workbench_read: invalid_cursor");
	});
});

test("authoritative image classification fails closed when the path is replaced with text before Pi processing", async () => {
	await withTempDir(async (root) => {
		const imagePath = join(root, "race.png");
		const preservedImagePath = join(root, "original.png");
		const replacementPath = join(root, "replacement.txt");
		const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
		const secret = "replacement text must never enter the legacy full-read branch";
		await writeFile(imagePath, image);
		await writeFile(replacementPath, `${secret}\n`.repeat(4_000));
		const { read } = registeredRead();
		let closed = false;
		const restore = installNativeReadV3TestHooks("image-to-text-race", {
			afterMagicSniff: async (facts) => {
				assert.equal(facts.mimeType, "image/png");
				await rename(imagePath, preservedImagePath);
				await rename(replacementPath, imagePath);
			},
			afterAuthoritativeClose: (facts) => {
				assert.equal(facts.closed, true);
				closed = true;
			},
		});
		let result: ReadResult;
		try {
			result = await read.execute("image-to-text-race", { path: "race.png" }, undefined, undefined, trustedCtx(root) as ExtensionContext);
		} finally {
			restore();
		}
		assert.equal(textOf(result!), "workbench_read: source_changed_during_read");
		assert.equal(result!.details?.code, "source_changed_during_read");
		assert.ok(!textOf(result!).includes(secret), "replacement text is never returned");
		assert.ok(!result!.content.some((part) => part.type === "image"), "a changed path is not reported as the original image");
		assert.equal(closed, true, "the authoritative handle closes on the fail-closed path");
	});
});

test("unchanged images are exact Pi pass-throughs from one authoritative handle", async () => {
	await withTempDir(async (root) => {
		const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
		await writeFile(join(root, "pixel.png"), image);
		const ctx = trustedCtx(root) as ExtensionContext;
		const expected = await (createReadToolDefinition(root) as unknown as ReadTool).execute("oracle-image", { path: "pixel.png" }, undefined, undefined, ctx);
		const { read } = registeredRead();
		let sniffed = 0;
		let imageReads = 0;
		let closes = 0;
		const restore = installNativeReadV3TestHooks("same-handle-image", {
			afterMagicSniff: (facts) => {
				assert.equal(facts.mimeType, "image/png");
				assert.equal(facts.fileSize, image.length);
				sniffed += 1;
			},
			afterImageBytesRead: () => { imageReads += 1; },
			afterAuthoritativeClose: (facts) => {
				assert.equal(facts.closed, true);
				closes += 1;
			},
		});
		let actual: ReadResult;
		try {
			actual = await read.execute("same-handle-image", { path: "pixel.png" }, undefined, undefined, ctx);
		} finally {
			restore();
		}
		assert.deepEqual(actual!, expected, "custom operations preserve Pi's exact image result");
		assert.deepEqual({ sniffed, imageReads, closes }, { sniffed: 1, imageReads: 1, closes: 1 });
	});
});

test("text remains on the bounded pager and non-regular sources fail fixed with handles closed", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "text.txt"), `${"bounded-text-line\n".repeat(2_000)}tail`);
		await mkdir(join(root, "directory"));
		const { read } = registeredRead();
		let textClose = false;
		let directoryClose = false;
		const restoreText = installNativeReadV3TestHooks("text-same-source", {
			afterMagicSniff: (facts) => { assert.equal(facts.mimeType, null); },
			afterImageBytesRead: () => { assert.fail("text must never enter Pi's image/full-read operations"); },
			afterAuthoritativeClose: (facts) => {
				assert.equal(facts.closed, true);
				textClose = true;
			},
		});
		let textResult: ReadResult;
		try {
			textResult = await read.execute("text-same-source", { path: "text.txt", limit: 3 }, undefined, undefined, trustedCtx(root) as ExtensionContext);
		} finally {
			restoreText();
		}
		assertPageBound(textResult!);
		assert.equal(unquote(textResult!).toString("utf8"), "bounded-text-line\nbounded-text-line\nbounded-text-line\n");
		assert.equal(textClose, true);

		const restoreDirectory = installNativeReadV3TestHooks("directory-source", {
			afterAuthoritativeClose: (facts) => {
				assert.equal(facts.closed, true);
				directoryClose = true;
			},
		});
		let directoryResult: ReadResult;
		try {
			directoryResult = await read.execute("directory-source", { path: "directory" }, undefined, undefined, trustedCtx(root) as ExtensionContext);
		} finally {
			restoreDirectory();
		}
		assert.equal(textOf(directoryResult!), "workbench_read: source_not_regular");
		assert.equal(directoryResult!.details?.code, "source_not_regular");
		assert.equal(directoryClose, true);
	});
});

test("bounded image sniff preserves Pi image attachments without quoting", async () => {
	await withTempDir(async (root) => {
		const images = [
			["pixel.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")],
			["pixel.jpg", Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==", "base64")],
			["pixel.gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")],
			["pixel.webp", Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64")],
			["pixel.bmp", tinyBmp()],
		] as const;
		for (const [path, bytes] of images) await writeFile(join(root, path), bytes);
		const { read } = registeredRead();
		const ctx = trustedCtx(root);
		for (const [path] of images) {
			const result = await read.execute(`image-${path}`, { path }, undefined, undefined, ctx);
			assert.ok(!textOf(result).includes("[workbench-read-page v1]"));
			assert.ok(result.content.some((part) => part.type === "image") || textOf(result).startsWith("Read image file ["));
		}
		for (const path of ["@pixel.png", join(root, "pixel.png")]) {
			const result = await read.execute(`image-${path}`, { path }, undefined, undefined, ctx);
			assert.ok(result.content.some((part) => part.type === "image"));
			assert.ok(!textOf(result).includes("[workbench-read-page v1]"));
		}
	});
});
