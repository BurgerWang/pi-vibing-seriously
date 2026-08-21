/** Native read/grep/find override registration, isolated from runtime composition. */

import { constants as BUFFER_CONSTANTS } from "node:buffer";
import { open, type FileHandle } from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { fileSourceSnapshotFromStats, readTextPage } from "./bounded-file-io.ts";
import {
	computeFileSourceId,
	decodeContinuationCursor,
	validateFileCursorSource,
	type FileCursorPayload,
	type FileSourceSnapshot,
} from "./continuation-cursor.ts";
import {
	buildNativeReadV3Page,
	formatGrepCountLine,
	IMAGE_SNIFF_BYTES,
	NATIVE_OVERRIDE_METADATA,
	NATIVE_OVERRIDE_PARAMETERS,
	nativeResolveReadPath,
	READ_V3_ALLOCATION_TOO_SMALL,
	READ_V3_MAX_FILE_LINES,
	READ_V3_MAX_OUTPUT_BYTES,
	sniffImageMimeType,
} from "./native-tool-policy.ts";
import { runGrepCount } from "./native-search-adapter.ts";

type NativeReadV3IoErrorCode = "source_not_regular" | "source_changed_during_read" | "source_oversized" | "io_error";

class NativeReadV3IoFailure extends Error {
	constructor(readonly code: NativeReadV3IoErrorCode) {
		super(code);
		this.name = "NativeReadV3IoFailure";
	}
}

export interface NativeReadV3TestHookFacts {
	readonly toolCallId: string;
	readonly fileSize: number;
	readonly mimeType: string | null;
}

export interface NativeReadV3TestHooks {
	afterMagicSniff?: (facts: Readonly<NativeReadV3TestHookFacts>) => void | Promise<void>;
	afterImageBytesRead?: (facts: Readonly<NativeReadV3TestHookFacts>) => void | Promise<void>;
	afterAuthoritativeClose?: (facts: Readonly<{ toolCallId: string; closed: boolean }>) => void | Promise<void>;
}

const nativeReadV3TestHooks = new Map<string, Readonly<NativeReadV3TestHooks>>();

/** Test-only, opt-in hook lease; restoring cannot remove another lease. */
export function installNativeReadV3TestHooks(toolCallId: string, hooks: Readonly<NativeReadV3TestHooks>): () => void {
	if (toolCallId.length === 0 || toolCallId.length > 512 || nativeReadV3TestHooks.has(toolCallId)) {
		throw new Error("invalid native read v3 test hook lease");
	}
	nativeReadV3TestHooks.set(toolCallId, hooks);
	return () => {
		if (nativeReadV3TestHooks.get(toolCallId) === hooks) nativeReadV3TestHooks.delete(toolCallId);
	};
}

function sameNativeReadSnapshot(a: FileSourceSnapshot, b: FileSourceSnapshot): boolean {
	return a.fileSize === b.fileSize
		&& a.mtimeMs === b.mtimeMs
		&& a.mtimeNs === b.mtimeNs
		&& a.dev === b.dev
		&& a.ino === b.ino;
}

async function nativeReadHandleSnapshot(handle: FileHandle): Promise<FileSourceSnapshot> {
	try {
		const stats = await handle.stat({ bigint: true });
		if (!stats.isFile()) throw new NativeReadV3IoFailure("source_not_regular");
		const snapshot = fileSourceSnapshotFromStats(stats);
		if (!snapshot.ok) throw new NativeReadV3IoFailure("io_error");
		return snapshot.value;
	} catch (error) {
		if (error instanceof NativeReadV3IoFailure) throw error;
		throw new NativeReadV3IoFailure("io_error");
	}
}

async function verifyNativeReadHandle(handle: FileHandle, expected: FileSourceSnapshot): Promise<void> {
	let current: FileSourceSnapshot;
	try {
		current = await nativeReadHandleSnapshot(handle);
	} catch {
		throw new NativeReadV3IoFailure("source_changed_during_read");
	}
	if (!sameNativeReadSnapshot(expected, current)) throw new NativeReadV3IoFailure("source_changed_during_read");
}

async function verifyNativeReadPathIdentity(path: string, expected: FileSourceSnapshot): Promise<void> {
	let verifier: FileHandle;
	try {
		verifier = await open(path, "r");
	} catch {
		throw new NativeReadV3IoFailure("source_changed_during_read");
	}
	let current: FileSourceSnapshot | undefined;
	let failed = false;
	try {
		current = await nativeReadHandleSnapshot(verifier);
	} catch {
		failed = true;
	}
	try {
		await verifier.close();
	} catch {
		throw new NativeReadV3IoFailure("io_error");
	}
	if (failed || current === undefined || !sameNativeReadSnapshot(expected, current)) {
		throw new NativeReadV3IoFailure("source_changed_during_read");
	}
}

function throwIfNativeReadAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

async function readNativeHandleExactly(handle: FileHandle, size: number, signal: AbortSignal | undefined): Promise<Buffer> {
	if (!Number.isSafeInteger(size) || size < 0) throw new NativeReadV3IoFailure("io_error");
	if (size > BUFFER_CONSTANTS.MAX_LENGTH) throw new NativeReadV3IoFailure("source_oversized");
	let buffer: Buffer;
	try {
		buffer = Buffer.allocUnsafe(size);
	} catch {
		throw new NativeReadV3IoFailure("source_oversized");
	}
	let offset = 0;
	while (offset < buffer.length) {
		throwIfNativeReadAborted(signal);
		let bytesRead: number;
		try {
			({ bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset));
		} catch {
			throw new NativeReadV3IoFailure("io_error");
		}
		if (bytesRead <= 0) throw new NativeReadV3IoFailure("source_changed_during_read");
		offset += bytesRead;
	}
	return buffer;
}

async function closeNativeReadAuthority(handle: FileHandle, toolCallId: string): Promise<boolean> {
	let closed = true;
	try {
		await handle.close();
	} catch {
		closed = false;
	}
	try {
		await nativeReadV3TestHooks.get(toolCallId)?.afterAuthoritativeClose?.(Object.freeze({ toolCallId, closed }));
	} catch {
		closed = false;
	}
	return closed;
}

interface OutputAuthorizationReservation {
	readonly allowed: boolean;
	readonly allocatedBytes: number;
}

export interface NativeToolOverridesController {
	pi: Pick<ExtensionAPI, "registerTool">;
	peekOutputAuthorization(toolCallId: unknown, toolName: unknown): OutputAuthorizationReservation | undefined;
	rememberTrustedReadContinuation(toolCallId: unknown, cursor: unknown): void;
}

function nativeReadV3Error(code: string): {
	content: Array<{ type: "text"; text: string }>;
	details: { schema: "workbench-read-page-v1"; code: string };
} {
	return {
		content: [{ type: "text", text: `workbench_read: ${code}` }],
		details: { schema: "workbench-read-page-v1", code },
	};
}

/** Register the three fixed native overrides in canonical read/grep/find order. */
export function registerNativeToolOverrides(controller: NativeToolOverridesController): void {
	controller.pi.registerTool({
		...NATIVE_OVERRIDE_METADATA.read,
		parameters: NATIVE_OVERRIDE_PARAMETERS.read,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (params.cursor !== undefined && params.offset !== undefined) return nativeReadV3Error("invalid_pagination");
			throwIfNativeReadAborted(signal);
			const pendingAuthorization = controller.peekOutputAuthorization(toolCallId, "read");
			const maxOutputBytes = pendingAuthorization === undefined
				? READ_V3_MAX_OUTPUT_BYTES
				: pendingAuthorization.allowed
					? Math.min(READ_V3_MAX_OUTPUT_BYTES, pendingAuthorization.allocatedBytes)
					: 0;
			const absolutePath = await nativeResolveReadPath(params.path, ctx.cwd);
			const source = computeFileSourceId("read", absolutePath);
			if (!source.ok) return nativeReadV3Error(source.error.code);
			let authority: FileHandle | undefined;
			let authorityClosed = false;
			const closeAuthority = async (): Promise<boolean> => {
				if (authority === undefined || authorityClosed) return true;
				authorityClosed = true;
				return closeNativeReadAuthority(authority, toolCallId);
			};
			try {
				try {
					authority = await open(absolutePath, "r");
				} catch {
					throw new NativeReadV3IoFailure("io_error");
				}
				const initial = await nativeReadHandleSnapshot(authority);
				const prefix = await readNativeHandleExactly(authority, Math.min(initial.fileSize, IMAGE_SNIFF_BYTES), signal);
				const mimeType = sniffImageMimeType(prefix);
				const hookFacts = Object.freeze({ toolCallId, fileSize: initial.fileSize, mimeType });
				await nativeReadV3TestHooks.get(toolCallId)?.afterMagicSniff?.(hookFacts);
				await verifyNativeReadHandle(authority, initial);
				await verifyNativeReadPathIdentity(absolutePath, initial);

				if (mimeType !== null) {
					if (params.cursor !== undefined) return nativeReadV3Error("invalid_pagination");
					let imageRead = false;
					const verifyImageRequest = async (requestedPath: string): Promise<void> => {
						throwIfNativeReadAborted(signal);
						if (requestedPath !== absolutePath) throw new NativeReadV3IoFailure("source_changed_during_read");
						await verifyNativeReadHandle(authority!, initial);
						await verifyNativeReadPathIdentity(absolutePath, initial);
					};
					const imageTool = createReadToolDefinition(ctx.cwd, {
						operations: {
							access: verifyImageRequest,
							detectImageMimeType: async (requestedPath) => {
								await verifyImageRequest(requestedPath);
								return mimeType;
							},
							readFile: async (requestedPath) => {
								await verifyImageRequest(requestedPath);
								const bytes = await readNativeHandleExactly(authority!, initial.fileSize, signal);
								imageRead = true;
								await nativeReadV3TestHooks.get(toolCallId)?.afterImageBytesRead?.(hookFacts);
								await verifyNativeReadHandle(authority!, initial);
								await verifyNativeReadPathIdentity(absolutePath, initial);
								return bytes;
							},
						},
					});
					let imageResult: Awaited<ReturnType<typeof imageTool.execute>>;
					try {
						imageResult = await imageTool.execute(toolCallId, params, undefined, onUpdate, ctx);
					} catch (error) {
						if (error instanceof NativeReadV3IoFailure) return nativeReadV3Error(error.code);
						if (error instanceof Error && error.message === "Operation aborted") throw error;
						return nativeReadV3Error("io_error");
					}
					if (!imageRead) return nativeReadV3Error("io_error");
					throwIfNativeReadAborted(signal);
					await verifyNativeReadHandle(authority, initial);
					await verifyNativeReadPathIdentity(absolutePath, initial);
					if (!(await closeAuthority())) return nativeReadV3Error("io_error");
					return imageResult;
				}

				if (!(await closeAuthority())) return nativeReadV3Error("io_error");
				let cursorPayload: FileCursorPayload | undefined;
				if (params.cursor !== undefined) {
					const decoded = decodeContinuationCursor(params.cursor);
					if (!decoded.ok || decoded.value.kind !== "read") return nativeReadV3Error("invalid_cursor");
					cursorPayload = decoded.value;
					if (cursorPayload.sourceId !== source.value) return nativeReadV3Error("source_mismatch");
				}
				const page = await readTextPage(absolutePath, {
					...(cursorPayload
						? {
							startByte: cursorPayload.byteOffset,
							lineNumber: cursorPayload.lineNumber,
							expectedSource: cursorPayload,
							verifyStartByteForLine: true,
						}
						: params.offset !== undefined ? { startLine: params.offset } : {}),
					maxBytes: READ_V3_MAX_OUTPUT_BYTES,
					maxLines: params.limit ?? READ_V3_MAX_FILE_LINES,
					signal,
				});
				if (!page.ok) return nativeReadV3Error(page.error.code);
				if (!sameNativeReadSnapshot(initial, page.value.source)) return nativeReadV3Error("source_changed_during_read");
				if (cursorPayload) {
					const validated = validateFileCursorSource({
						payload: cursorPayload,
						expectedKind: "read",
						expectedSourceId: source.value,
						currentSnapshot: page.value.source,
					});
					if (!validated.ok) return nativeReadV3Error(validated.error.code);
				}
				const rendered = buildNativeReadV3Page({
					displayPath: params.path,
					sourceId: source.value,
					page: page.value,
					maxOutputBytes,
				});
				controller.rememberTrustedReadContinuation(toolCallId, rendered.details.next_cursor);
				return { content: [{ type: "text", text: rendered.text }], details: rendered.details };
			} catch (error) {
				if (error instanceof NativeReadV3IoFailure) return nativeReadV3Error(error.code);
				if (error instanceof Error && error.message === "Operation aborted") throw error;
				if (error instanceof Error && error.message === READ_V3_ALLOCATION_TOO_SMALL) {
					return nativeReadV3Error("output_allocation_too_small");
				}
				return nativeReadV3Error("io_error");
			} finally {
				if (!authorityClosed) await closeAuthority();
			}
		},
	});

	controller.pi.registerTool({
		...NATIVE_OVERRIDE_METADATA.grep,
		parameters: NATIVE_OVERRIDE_PARAMETERS.grep,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (params.output === "count") {
				const countKind = params.count_kind === "lines" ? "lines" : "matches";
				const { value, files } = await runGrepCount(
					{
						pattern: params.pattern,
						path: params.path,
						glob: params.glob,
						ignoreCase: params.ignoreCase,
						literal: params.literal,
						countKind,
					},
					{ cwd: ctx.cwd, signal },
				);
				return {
					content: [{ type: "text", text: formatGrepCountLine(countKind, value, files) }],
					details: undefined,
				};
			}
			const legacyParams = {
				pattern: params.pattern,
				path: params.path,
				glob: params.glob,
				ignoreCase: params.ignoreCase,
				literal: params.literal,
				context: params.context,
				limit: params.limit,
			};
			return createGrepToolDefinition(ctx.cwd).execute(toolCallId, legacyParams, signal, onUpdate, ctx);
		},
	});

	controller.pi.registerTool({
		...NATIVE_OVERRIDE_METADATA.find,
		parameters: NATIVE_OVERRIDE_PARAMETERS.find,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createFindToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}
