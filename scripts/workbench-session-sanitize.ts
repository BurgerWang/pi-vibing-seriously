#!/usr/bin/env tsx
/**
 * Offline, fail-closed migration for Pi v3 JSONL sessions that contain
 * legacy unbounded tool-result details/content. The input is never rewritten
 * and this command never switches Pi's active session.
 */

import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, stat, unlink, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { projectLegacyDetails } from "../extensions/workbench-runtime/core/details-projection.ts";
import {
	collapseHistoricalToolResult,
	type AgentMessage,
} from "../extensions/workbench-runtime/core/context-history-budget.ts";

export const SESSION_SANITIZE_MANIFEST_SCHEMA_VERSION = 1;
export const SESSION_SANITIZE_READ_CHUNK_BYTES = 64 * 1_024;
export const SESSION_SANITIZE_ENTRY_MAX_BYTES = 16 * 1_024 * 1_024;

const OUTPUT_MODE = 0o600;
const HEADER_KEYS = new Set(["type", "version", "id", "timestamp", "cwd", "parentSession"]);
const POINTER_KEYS = new Set(["fromId", "targetId", "firstKeptEntryId"]);
const USAGE = [
	"Usage: npm run session:sanitize -- --input <session.jsonl> --output <new-session.jsonl> [--collapse-content]",
	"Creates <new-session.jsonl>.manifest.json; never modifies or activates the input session.",
].join("\n");

export type SessionSanitizeErrorCode =
	| "USAGE"
	| "INPUT_INVALID"
	| "INPUT_NOT_REGULAR"
	| "INPUT_MUTATED"
	| "ENTRY_OVER_LIMIT"
	| "SESSION_INVALID"
	| "OUTPUT_EXISTS"
	| "IO_ERROR";

export class SessionSanitizeError extends Error {
	readonly code: SessionSanitizeErrorCode;

	constructor(code: SessionSanitizeErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionSanitizeError";
		this.code = code;
	}
}

export interface SessionSanitizeManifest {
	schema_version: 1;
	kind: "workbench-session-sanitize";
	input: { path: string; sha256: string; bytes: number; entry_count: number };
	output: { path: string; sha256: string; bytes: number; entry_count: number; manifest_path: string };
	tool_results: number;
	details_projected: number;
	content_collapsed: number;
	removed_bytes: {
		file: number;
		details: number;
		content: number;
	};
	tree: {
		canonical_sha256_before: string;
		canonical_sha256_after: string;
		preserved: true;
		active_leaf_id_before: string | null;
		active_leaf_id_after: string | null;
	};
}

export interface SanitizeSessionOptions {
	input: string;
	output: string;
	collapseContent?: boolean;
}

interface ParsedCli {
	help: boolean;
	input?: string;
	output?: string;
	collapseContent: boolean;
}

interface BigIntSnapshot {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

interface SessionState {
	headerSeen: boolean;
	entryCount: number;
	rootCount: number;
	ids: Set<string>;
	lastEntryId: string | null;
	toolResults: number;
	detailsProjected: number;
	contentCollapsed: number;
	detailsBytesRemoved: number;
	contentBytesRemoved: number;
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function jsonBytes(value: unknown): number {
	return utf8Bytes(JSON.stringify(value));
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new SessionSanitizeError("SESSION_INVALID", `${context}: ${key} must be a non-empty string`);
	}
	return value;
}

function optionalPointer(record: Record<string, unknown>, key: string, context: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) {
		throw new SessionSanitizeError("SESSION_INVALID", `${context}: ${key} must be a non-empty string when present`);
	}
	return value;
}

function headerTreeRecord(header: Record<string, unknown>): Record<string, unknown> {
	return {
		kind: "header",
		type: header.type,
		version: header.version,
		id: header.id,
		timestamp: header.timestamp,
		cwd: header.cwd,
		...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
	};
}

function entryTreeRecord(entry: Record<string, unknown>, order: number): Record<string, unknown> {
	const pointers: Record<string, unknown> = {};
	for (const key of Object.keys(entry).sort()) {
		if (POINTER_KEYS.has(key) || (key.endsWith("Id") && key !== "id" && key !== "parentId")) {
			pointers[key] = entry[key];
		}
	}
	return {
		kind: "entry",
		order,
		type: entry.type,
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		pointers,
	};
}

function updateTreeHash(hash: Hash, value: Record<string, unknown>): void {
	hash.update(canonicalJson(value));
	hash.update("\n");
}

function validateHeader(value: unknown): Record<string, unknown> {
	const header = dataRecord(value);
	if (!header || header.type !== "session") {
		throw new SessionSanitizeError("SESSION_INVALID", "line 1: expected a Pi session header");
	}
	for (const key of Object.keys(header)) {
		if (!HEADER_KEYS.has(key)) {
			throw new SessionSanitizeError("SESSION_INVALID", `line 1: unsupported session header field ${JSON.stringify(key)}`);
		}
	}
	if (header.version !== 3) {
		throw new SessionSanitizeError("SESSION_INVALID", "line 1: only Pi session version 3 is supported");
	}
	requiredString(header, "id", "line 1");
	requiredString(header, "timestamp", "line 1");
	if (typeof header.cwd !== "string") {
		throw new SessionSanitizeError("SESSION_INVALID", "line 1: cwd must be a string");
	}
	if (header.parentSession !== undefined && (typeof header.parentSession !== "string" || header.parentSession.length === 0)) {
		throw new SessionSanitizeError("SESSION_INVALID", "line 1: parentSession must be a non-empty string when present");
	}
	return header;
}

function validateEntry(value: unknown, lineNumber: number, state: SessionState): Record<string, unknown> {
	const entry = dataRecord(value);
	const context = `line ${lineNumber}`;
	if (!entry || entry.type === "session") {
		throw new SessionSanitizeError("SESSION_INVALID", `${context}: expected one session entry object`);
	}
	requiredString(entry, "type", context);
	const id = requiredString(entry, "id", context);
	if (state.ids.has(id)) {
		throw new SessionSanitizeError("SESSION_INVALID", `${context}: duplicate entry id ${JSON.stringify(id)}`);
	}
	const parentId = entry.parentId;
	if (parentId !== null && (typeof parentId !== "string" || parentId.length === 0)) {
		throw new SessionSanitizeError("SESSION_INVALID", `${context}: parentId must be null or a non-empty string`);
	}
	if (typeof parentId === "string" && !state.ids.has(parentId)) {
		throw new SessionSanitizeError("SESSION_INVALID", `${context}: parentId does not reference an earlier entry`);
	}
	if (parentId === null) state.rootCount += 1;
	requiredString(entry, "timestamp", context);
	for (const key of POINTER_KEYS) {
		const pointer = optionalPointer(entry, key, context);
		if (pointer !== undefined && !state.ids.has(pointer)) {
			throw new SessionSanitizeError("SESSION_INVALID", `${context}: ${key} does not reference an earlier entry`);
		}
	}
	if (entry.type === "message") {
		const message = dataRecord(entry.message);
		if (!message || typeof message.role !== "string" || message.role.length === 0) {
			throw new SessionSanitizeError("SESSION_INVALID", `${context}: message entry has no valid role`);
		}
		if (message.role === "toolResult") {
			requiredString(message, "toolCallId", `${context} toolResult`);
			requiredString(message, "toolName", `${context} toolResult`);
			if (!Array.isArray(message.content)) {
				throw new SessionSanitizeError("SESSION_INVALID", `${context}: toolResult content must be an array`);
			}
		}
	}
	state.ids.add(id);
	state.entryCount += 1;
	state.lastEntryId = id;
	return entry;
}

function transformEntry(entry: Record<string, unknown>, state: SessionState, collapseContent: boolean): Record<string, unknown> {
	if (entry.type !== "message") return entry;
	let message = dataRecord(entry.message);
	if (!message || message.role !== "toolResult") return entry;
	state.toolResults += 1;

	if (Object.prototype.hasOwnProperty.call(message, "details")) {
		const before = jsonBytes(message.details);
		const projection = projectLegacyDetails(message.details);
		message.details = projection.details;
		state.detailsProjected += 1;
		state.detailsBytesRemoved += Math.max(0, before - projection.serializedBytes);
	}

	if (collapseContent) {
		const before = jsonBytes(message.content);
		message = collapseHistoricalToolResult(message as unknown as AgentMessage) as unknown as Record<string, unknown>;
		const after = jsonBytes(message.content);
		state.contentCollapsed += 1;
		state.contentBytesRemoved += Math.max(0, before - after);
	}
	entry.message = message;
	return entry;
}

function snapshotOf(stats: BigIntSnapshot): BigIntSnapshot {
	return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
}

function sameSnapshot(left: BigIntSnapshot, right: BigIntSnapshot): boolean {
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

async function pathMissing(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}

async function removeCreated(path: string, created: boolean): Promise<void> {
	if (!created) return;
	try {
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
	let offset = 0;
	while (offset < bytes.length) {
		const written = await handle.write(bytes, offset, bytes.length - offset, null);
		if (written.bytesWritten <= 0) throw new SessionSanitizeError("IO_ERROR", "output write made no progress");
		offset += written.bytesWritten;
	}
}

function parseJsonLine(bytes: Buffer, lineNumber: number): unknown {
	let content = bytes;
	if (content.at(-1) === 0x0d) content = content.subarray(0, content.length - 1);
	if (content.length === 0) {
		throw new SessionSanitizeError("SESSION_INVALID", `line ${lineNumber}: blank JSONL lines are not allowed`);
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch (error) {
		throw new SessionSanitizeError("SESSION_INVALID", `line ${lineNumber}: invalid UTF-8`, { cause: error });
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new SessionSanitizeError("SESSION_INVALID", `line ${lineNumber}: malformed JSON`, { cause: error });
	}
}

function parseCli(argv: readonly string[]): ParsedCli {
	if (argv.length === 1 && argv[0] === "--help") return { help: true, collapseContent: false };
	let input: string | undefined;
	let output: string | undefined;
	let collapseContent = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]!;
		if (argument === "--input" || argument === "--output") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new SessionSanitizeError("USAGE", `${argument} requires a path`);
			}
			if (argument === "--input") {
				if (input !== undefined) throw new SessionSanitizeError("USAGE", "--input may be specified only once");
				input = value;
			} else {
				if (output !== undefined) throw new SessionSanitizeError("USAGE", "--output may be specified only once");
				output = value;
			}
			index += 1;
			continue;
		}
		if (argument === "--collapse-content") {
			if (collapseContent) throw new SessionSanitizeError("USAGE", "--collapse-content may be specified only once");
			collapseContent = true;
			continue;
		}
		throw new SessionSanitizeError("USAGE", `unknown argument ${JSON.stringify(argument)}`);
	}
	if (input === undefined || output === undefined) {
		throw new SessionSanitizeError("USAGE", "both --input and --output are required");
	}
	return { help: false, input, output, collapseContent };
}

/**
 * Create a sanitized copy and its evidence manifest. All session processing
 * is one-pass/64-KiB-chunked; only the current (at most 16-MiB) entry is held.
 */
export async function sanitizeSession(options: SanitizeSessionOptions): Promise<SessionSanitizeManifest> {
	const inputPath = resolve(options.input);
	const outputPath = resolve(options.output);
	const manifestPath = `${outputPath}.manifest.json`;
	if (inputPath === outputPath || inputPath === manifestPath) {
		throw new SessionSanitizeError("USAGE", "input, output, and manifest paths must be distinct");
	}
	if (!await pathMissing(outputPath)) {
		throw new SessionSanitizeError("OUTPUT_EXISTS", `output already exists: ${outputPath}`);
	}
	if (!await pathMissing(manifestPath)) {
		throw new SessionSanitizeError("OUTPUT_EXISTS", `manifest already exists: ${manifestPath}`);
	}

	let inputHandle: FileHandle | undefined;
	let outputHandle: FileHandle | undefined;
	let manifestHandle: FileHandle | undefined;
	let outputCreated = false;
	let manifestCreated = false;
	let success = false;
	try {
		try {
			inputHandle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			throw new SessionSanitizeError("INPUT_INVALID", `cannot open input session: ${inputPath}`, { cause: error });
		}
		const initialStats = await inputHandle.stat({ bigint: true });
		if (!initialStats.isFile()) {
			throw new SessionSanitizeError("INPUT_NOT_REGULAR", `input is not a regular file: ${inputPath}`);
		}
		const initialSnapshot = snapshotOf(initialStats);

		try {
			outputHandle = await open(
				outputPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				OUTPUT_MODE,
			);
			outputCreated = true;
			await outputHandle.chmod(OUTPUT_MODE);
			manifestHandle = await open(
				manifestPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				OUTPUT_MODE,
			);
			manifestCreated = true;
			await manifestHandle.chmod(OUTPUT_MODE);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new SessionSanitizeError("OUTPUT_EXISTS", "output or manifest appeared during exclusive creation", { cause: error });
			}
			throw error;
		}

		const inputHash = createHash("sha256");
		const outputHash = createHash("sha256");
		const beforeTreeHash = createHash("sha256");
		const afterTreeHash = createHash("sha256");
		const state: SessionState = {
			headerSeen: false,
			entryCount: 0,
			rootCount: 0,
			ids: new Set<string>(),
			lastEntryId: null,
			toolResults: 0,
			detailsProjected: 0,
			contentCollapsed: 0,
			detailsBytesRemoved: 0,
			contentBytesRemoved: 0,
		};
		let inputBytes = 0;
		let outputBytes = 0;
		let lineNumber = 0;
		let pendingChunks: Buffer[] = [];
		let pendingBytes = 0;

		const processLine = async (): Promise<void> => {
			lineNumber += 1;
			const rawLine = pendingChunks.length === 1 ? pendingChunks[0]! : Buffer.concat(pendingChunks, pendingBytes);
			pendingChunks = [];
			pendingBytes = 0;
			const parsed = parseJsonLine(rawLine, lineNumber);
			let rendered: Record<string, unknown>;
			if (!state.headerSeen) {
				rendered = validateHeader(parsed);
				state.headerSeen = true;
				const tree = headerTreeRecord(rendered);
				updateTreeHash(beforeTreeHash, tree);
				updateTreeHash(afterTreeHash, tree);
			} else {
				const entry = validateEntry(parsed, lineNumber, state);
				const beforeTree = entryTreeRecord(entry, state.entryCount);
				updateTreeHash(beforeTreeHash, beforeTree);
				rendered = transformEntry(entry, state, options.collapseContent === true);
				const afterTree = entryTreeRecord(rendered, state.entryCount);
				if (canonicalJson(beforeTree) !== canonicalJson(afterTree)) {
					throw new SessionSanitizeError("SESSION_INVALID", `line ${lineNumber}: sanitizer changed a session tree pointer`);
				}
				updateTreeHash(afterTreeHash, afterTree);
			}
			const encoded = Buffer.from(`${JSON.stringify(rendered)}\n`, "utf8");
			await writeAll(outputHandle!, encoded);
			outputHash.update(encoded);
			outputBytes += encoded.length;
		};

		const buffer = Buffer.allocUnsafe(SESSION_SANITIZE_READ_CHUNK_BYTES);
		while (true) {
			const read = await inputHandle.read(buffer, 0, buffer.length, null);
			if (read.bytesRead === 0) break;
			const chunk = buffer.subarray(0, read.bytesRead);
			inputHash.update(chunk);
			inputBytes += chunk.length;
			if (!Number.isSafeInteger(inputBytes)) {
				throw new SessionSanitizeError("INPUT_INVALID", "input session byte count exceeds safe integer range");
			}
			let start = 0;
			for (let index = 0; index < chunk.length; index += 1) {
				if (chunk[index] !== 0x0a) continue;
				const part = Buffer.from(chunk.subarray(start, index));
				if (pendingBytes + part.length > SESSION_SANITIZE_ENTRY_MAX_BYTES) {
					throw new SessionSanitizeError("ENTRY_OVER_LIMIT", `line ${lineNumber + 1}: entry exceeds ${SESSION_SANITIZE_ENTRY_MAX_BYTES} bytes`);
				}
				pendingChunks.push(part);
				pendingBytes += part.length;
				await processLine();
				start = index + 1;
			}
			if (start < chunk.length) {
				const part = Buffer.from(chunk.subarray(start));
				if (pendingBytes + part.length > SESSION_SANITIZE_ENTRY_MAX_BYTES) {
					throw new SessionSanitizeError("ENTRY_OVER_LIMIT", `line ${lineNumber + 1}: entry exceeds ${SESSION_SANITIZE_ENTRY_MAX_BYTES} bytes`);
				}
				pendingChunks.push(part);
				pendingBytes += part.length;
			}
		}
		if (pendingBytes > 0) await processLine();
		if (!state.headerSeen) throw new SessionSanitizeError("SESSION_INVALID", "input session is empty");
		if (state.entryCount > 0 && state.rootCount !== 1) {
			throw new SessionSanitizeError("SESSION_INVALID", `session must contain exactly one root entry; found ${state.rootCount}`);
		}
		if (BigInt(inputBytes) !== initialSnapshot.size) {
			throw new SessionSanitizeError("INPUT_MUTATED", "input size changed while sanitizing");
		}

		const finalHandleStats = snapshotOf(await inputHandle.stat({ bigint: true }));
		let finalPathStats: BigIntSnapshot;
		try {
			const currentPath = await stat(inputPath, { bigint: true });
			finalPathStats = snapshotOf(currentPath);
		} catch (error) {
			throw new SessionSanitizeError("INPUT_MUTATED", "input path changed while sanitizing", { cause: error });
		}
		if (!sameSnapshot(initialSnapshot, finalHandleStats) || !sameSnapshot(initialSnapshot, finalPathStats)) {
			throw new SessionSanitizeError("INPUT_MUTATED", "input metadata changed while sanitizing");
		}

		const inputSha256 = inputHash.digest("hex");
		const outputSha256 = outputHash.digest("hex");
		const beforeTreeSha256 = beforeTreeHash.digest("hex");
		const afterTreeSha256 = afterTreeHash.digest("hex");
		if (beforeTreeSha256 !== afterTreeSha256) {
			throw new SessionSanitizeError("SESSION_INVALID", "session tree canonical hashes differ after projection");
		}
		const manifest: SessionSanitizeManifest = {
			schema_version: SESSION_SANITIZE_MANIFEST_SCHEMA_VERSION,
			kind: "workbench-session-sanitize",
			input: { path: inputPath, sha256: inputSha256, bytes: inputBytes, entry_count: state.entryCount },
			output: {
				path: outputPath,
				sha256: outputSha256,
				bytes: outputBytes,
				entry_count: state.entryCount,
				manifest_path: manifestPath,
			},
			tool_results: state.toolResults,
			details_projected: state.detailsProjected,
			content_collapsed: state.contentCollapsed,
			removed_bytes: {
				file: Math.max(0, inputBytes - outputBytes),
				details: state.detailsBytesRemoved,
				content: state.contentBytesRemoved,
			},
			tree: {
				canonical_sha256_before: beforeTreeSha256,
				canonical_sha256_after: afterTreeSha256,
				preserved: true,
				active_leaf_id_before: state.lastEntryId,
				active_leaf_id_after: state.lastEntryId,
			},
		};

		await outputHandle.sync();
		const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		await writeAll(manifestHandle, manifestBytes);
		await manifestHandle.sync();
		success = true;
		return manifest;
	} catch (error) {
		if (error instanceof SessionSanitizeError) throw error;
		throw new SessionSanitizeError("IO_ERROR", "session sanitization failed", { cause: error });
	} finally {
		await Promise.allSettled([inputHandle?.close(), outputHandle?.close(), manifestHandle?.close()]);
		if (!success) {
			await Promise.allSettled([
				removeCreated(outputPath, outputCreated),
				removeCreated(manifestPath, manifestCreated),
			]);
		}
	}
}

async function main(argv: readonly string[]): Promise<number> {
	try {
		const parsed = parseCli(argv);
		if (parsed.help) {
			process.stdout.write(`${USAGE}\n`);
			return 0;
		}
		const manifest = await sanitizeSession({
			input: parsed.input!,
			output: parsed.output!,
			collapseContent: parsed.collapseContent,
		});
		process.stdout.write(`${JSON.stringify(manifest)}\n`);
		return 0;
	} catch (error) {
		const known = error instanceof SessionSanitizeError ? error : undefined;
		const code = known?.code === "USAGE" ? 2 : 1;
		const message = known?.message ?? "unexpected failure";
		process.stderr.write(`workbench-session-sanitize: ${message}\n`);
		if (code === 2) process.stderr.write(`${USAGE}\n`);
		return code;
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
	process.exitCode = await main(process.argv.slice(2));
}
