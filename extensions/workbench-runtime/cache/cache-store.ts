/**
 * P6-A telemetry store — append-only JSONL with rotation, atomic report
 * writes, and a defensive privacy filter.
 *
 * Paths (CONFIG_DIR_NAME from Pi, never hardcoded):
 *   <project-root>/<CONFIG_DIR_NAME>/workbench/cache/telemetry.jsonl
 *   <project-root>/<CONFIG_DIR_NAME>/workbench/cache/reports/
 *
 * Guarantees:
 *   - append-only JSONL, one record per line
 *   - single-file size limit with rotation (telemetry.N.jsonl, oldest
 *     dropped) — the directory never grows without bound
 *   - corrupted lines are skipped and counted; invalid UTF-8 makes that
 *     source unavailable rather than replacement-decoding untrusted bytes
 *   - write failures degrade to {ok:false} — telemetry must never block or
 *     crash a model request
 *   - records containing forbidden fields are REFUSED before touching disk
 *   - report files are written atomically (tmp + rename)
 *   - file/dir modes are restricted to the current user (0o600/0o700)
 */

import { appendFile, mkdir, open, readdir, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder, types as nodeTypes } from "node:util";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { isTelemetryRecord, type TelemetryRecord } from "./cache-types.ts";
import {
	fileSourceSnapshotFromStats,
	type BoundedFileIoHooks,
} from "../core/bounded-file-io.ts";

export const CACHE_DIR_NAME = "cache";
export const TELEMETRY_FILE = "telemetry.jsonl";
export const REPORTS_DIR_NAME = "reports";
export const DEFAULT_MAX_TELEMETRY_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_ROTATED_FILES = 5;
export const DEFAULT_MAX_CHRONOLOGICAL_RECORDS = 100_000;
export const MAX_CHRONOLOGICAL_RECORDS = 1_000_000;
/** Includes the terminating JSONL newline. */
export const MAX_TELEMETRY_RECORD_BYTES = 64 * 1024;
export const UNINSPECTABLE_TELEMETRY_VALUE = "<uninspectable-telemetry-value>";
const MAX_TELEMETRY_SCAN_DEPTH = 32;
const MAX_TELEMETRY_SCAN_NODES = 4_096;
const MAX_TELEMETRY_SCAN_PROPERTIES = 16_384;
const MAX_TELEMETRY_SCAN_ARRAY_LENGTH = 16_384;

/**
 * Field names that must never appear in a telemetry record. The record
 * schema is hash-only; these names defend against future schema drift
 * (system prompt text, message text, tool schemas, tool input/output,
 * secrets, auth, full session ids, env values, absolute file lists).
 */
export const FORBIDDEN_TELEMETRY_KEYS: readonly string[] = [
	"systemPrompt",
	"prompt",
	"prompts",
	"promptSnippet",
	"promptGuidelines",
	"content",
	"text",
	"message",
	"messages",
	"toolSchema",
	"toolSchemaBody",
	"parameters",
	"toolArguments",
	"toolInput",
	"toolResult",
	"arguments",
	"args",
	"result",
	"payload",
	"headers",
	"apiKey",
	"api_key",
	"auth",
	"authInfo",
	"secret",
	"secrets",
	"password",
	"token",
	"sessionId",
	"session_id",
	"sessionFile",
	"session_file",
	"cwd",
	"environment",
	"env",
	"envValues",
	"fileContent",
	"file_content",
	"files",
	"absoluteFileList",
	"fileList",
];

/**
 * Deep-scan a value for forbidden field names. Returns the first forbidden
 * key found, or null when the value is clean. Exact key matching only —
 * `systemPromptHash` is allowed, `systemPrompt` is not. Values that cannot
 * be inspected without executing application code return the fixed
 * UNINSPECTABLE_TELEMETRY_VALUE sentinel and are refused by the store.
 */
export function hasForbiddenTelemetryFields(value: unknown): string | null {
	const forbidden = new Set(FORBIDDEN_TELEMETRY_KEYS);
	const result = scan(value, forbidden, { nodes: 0, properties: 0, ancestors: new WeakSet<object>() });
	if (result.kind === "clean") return null;
	return result.kind === "forbidden" ? result.key : UNINSPECTABLE_TELEMETRY_VALUE;
}

type TelemetryScanResult =
	| { readonly kind: "clean" }
	| { readonly kind: "forbidden"; readonly key: string }
	| { readonly kind: "unsafe" };

interface TelemetryScanBudget {
	nodes: number;
	properties: number;
	ancestors: WeakSet<object>;
}

const CLEAN_TELEMETRY_SCAN: TelemetryScanResult = { kind: "clean" };
const UNSAFE_TELEMETRY_SCAN: TelemetryScanResult = { kind: "unsafe" };

/** Descriptor-only recursive scan. Proxy brand checks happen before reflection. */
function scan(
	value: unknown,
	forbidden: ReadonlySet<string>,
	budget: TelemetryScanBudget,
	depth = 0,
): TelemetryScanResult {
	try {
		if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			return CLEAN_TELEMETRY_SCAN;
		}
		if (typeof value !== "object") return UNSAFE_TELEMETRY_SCAN;
		if (nodeTypes.isProxy(value)) return UNSAFE_TELEMETRY_SCAN;
		if (depth >= MAX_TELEMETRY_SCAN_DEPTH || budget.nodes >= MAX_TELEMETRY_SCAN_NODES) return UNSAFE_TELEMETRY_SCAN;
		if (budget.ancestors.has(value)) return UNSAFE_TELEMETRY_SCAN;
		budget.nodes += 1;
		budget.ancestors.add(value);
		try {
			const prototype = Object.getPrototypeOf(value);
			const isArray = Array.isArray(value);
			if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
				return UNSAFE_TELEMETRY_SCAN;
			}
			const descriptors = Object.getOwnPropertyDescriptors(value);
			const ownKeys = Reflect.ownKeys(descriptors);
			if (ownKeys.some((key) => typeof key === "symbol")) return UNSAFE_TELEMETRY_SCAN;
			if (budget.properties + ownKeys.length > MAX_TELEMETRY_SCAN_PROPERTIES) return UNSAFE_TELEMETRY_SCAN;
			budget.properties += ownKeys.length;
			const keys = ownKeys as string[];

			if (isArray) {
				const lengthDescriptor = descriptors.length;
				if (!isDataDescriptor(lengthDescriptor) || lengthDescriptor.enumerable !== false) return UNSAFE_TELEMETRY_SCAN;
				const length = lengthDescriptor.value;
				if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_TELEMETRY_SCAN_ARRAY_LENGTH) {
					return UNSAFE_TELEMETRY_SCAN;
				}
				for (const key of keys) {
					if (key === "length") continue;
					if (!isCanonicalArrayIndex(key, length)) return UNSAFE_TELEMETRY_SCAN;
					const descriptor = descriptors[key];
					if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) return UNSAFE_TELEMETRY_SCAN;
					const nested = scan(descriptor.value, forbidden, budget, depth + 1);
					if (nested.kind !== "clean") return nested;
				}
				return CLEAN_TELEMETRY_SCAN;
			}

			for (const key of keys) {
				const descriptor = descriptors[key];
				if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) return UNSAFE_TELEMETRY_SCAN;
				if (forbidden.has(key)) return { kind: "forbidden", key };
			}
			for (const key of keys) {
				const descriptor = descriptors[key];
				if (!isDataDescriptor(descriptor)) return UNSAFE_TELEMETRY_SCAN;
				const nested = scan(descriptor.value, forbidden, budget, depth + 1);
				if (nested.kind !== "clean") return nested;
			}
			return CLEAN_TELEMETRY_SCAN;
		} finally {
			budget.ancestors.delete(value);
		}
	} catch {
		return UNSAFE_TELEMETRY_SCAN;
	}
}

function isDataDescriptor(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor & { value: unknown } {
	return descriptor !== undefined
		&& Object.prototype.hasOwnProperty.call(descriptor, "value")
		&& descriptor.get === undefined
		&& descriptor.set === undefined;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
	if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

export interface CacheStoreOptions {
	/** Rotation threshold for telemetry.jsonl (bytes). */
	maxFileBytes?: number;
	/** Number of rotated files kept (telemetry.1..N.jsonl). */
	maxRotatedFiles?: number;
	/** Test-only numeric allocation/read observations; never receives path/content. */
	boundedReadHooks?: BoundedFileIoHooks;
	/** Test-only filesystem fault injection for rotation rename handling. */
	rotationRename?: (source: string, destination: string) => Promise<void>;
}

export interface StoreAppendResult {
	ok: boolean;
	error?: string;
}

export interface StoreReadResult {
	records: unknown[];
	skipped: number;
	unavailable?: "source_oversized" | "source_not_regular" | "source_changed_during_read" | "rotation_gap" | "read_error";
}

export interface ChronologicalReadOptions {
	/** Keep the newest N records, returned in chronological order. */
	maxRecords?: number;
}

export interface ChronologicalReadResult extends StoreReadResult {
	/** True only when a source file/line could not be read or parsed. */
	sourceIncomplete: boolean;
	/** Oldest valid records intentionally omitted by maxRecords. */
	truncatedRecords: number;
	filesRead: number;
}

export interface StoreReportResult {
	ok: boolean;
	path?: string;
	error?: string;
}

export class CacheStore {
	readonly projectRoot: string;
	private readonly maxFileBytes: number;
	private readonly maxRotatedFiles: number;
	private readonly boundedReadHooks: BoundedFileIoHooks | undefined;
	private readonly rotationRename: (source: string, destination: string) => Promise<void>;

	constructor(projectRoot: string, options: CacheStoreOptions = {}) {
		this.projectRoot = projectRoot;
		this.maxFileBytes = normalizeTelemetryThreshold(options.maxFileBytes);
		this.maxRotatedFiles = options.maxRotatedFiles ?? DEFAULT_MAX_ROTATED_FILES;
		this.boundedReadHooks = options.boundedReadHooks;
		this.rotationRename = options.rotationRename ?? rename;
	}

	cacheDir(): string {
		return join(this.projectRoot, CONFIG_DIR_NAME, "workbench", CACHE_DIR_NAME);
	}

	telemetryPath(): string {
		return join(this.cacheDir(), TELEMETRY_FILE);
	}

	reportsDir(): string {
		return join(this.cacheDir(), REPORTS_DIR_NAME);
	}

	rotatedPath(n: number): string {
		return join(this.cacheDir(), `telemetry.${n}.jsonl`);
	}

	/** Relative reference for the session state entry, e.g. ".pi/workbench/cache/telemetry.jsonl". */
	telemetryRef(): string {
		return `${CONFIG_DIR_NAME}/workbench/${CACHE_DIR_NAME}/${TELEMETRY_FILE}`;
	}

	/**
	 * Append one record (JSONL). Never throws: failures return {ok:false}
	 * with the error message so callers can degrade gracefully.
	 */
	async appendRecord(record: unknown): Promise<StoreAppendResult> {
		try {
			const forbidden = hasForbiddenTelemetryFields(record);
			if (forbidden !== null) {
				if (forbidden === UNINSPECTABLE_TELEMETRY_VALUE) {
					return { ok: false, error: "refused: telemetry record cannot be safely inspected" };
				}
				return { ok: false, error: `refused: record contains forbidden field "${forbidden}"` };
			}
			const serialized = JSON.stringify(record);
			if (typeof serialized !== "string") return { ok: false, error: "refused: telemetry record is not JSON-serializable" };
			const payload = `${serialized}\n`;
			if (Buffer.byteLength(payload, "utf8") > MAX_TELEMETRY_RECORD_BYTES) {
				return { ok: false, error: "refused: telemetry record exceeds the fixed 65536-byte limit" };
			}
			if (!isTelemetryRecord(record)) return { ok: false, error: "refused: invalid telemetry record schema" };
			await mkdir(this.cacheDir(), { recursive: true, mode: 0o700 });
			await this.rotateIfNeeded();
			await appendFile(this.telemetryPath(), payload, { flag: "a", mode: 0o600 });
			return { ok: true };
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	}

	/**
	 * Read all records from the current telemetry.jsonl. Corrupted lines are
	 * skipped and counted. Missing file = zero records, no error.
	 */
	async readRecords(): Promise<StoreReadResult> {
		const loaded = await readTelemetryFileBounded(
			this.telemetryPath(),
			this.maxFileBytes + MAX_TELEMETRY_RECORD_BYTES,
			this.boundedReadHooks,
		);
		if (!loaded.ok) {
			return loaded.reason === "missing"
				? { records: [], skipped: 0 }
				: { records: [], skipped: 0, unavailable: loaded.reason };
		}
		const retained = new RecordRing<TelemetryRecord>(DEFAULT_MAX_CHRONOLOGICAL_RECORDS);
		const parsed = parseTelemetryJsonlInto(loaded.text, retained);
		return { records: retained.toArray(), skipped: parsed.skipped };
	}

	/**
	 * Read rotated files oldest-first, then the current file. Each file uses
	 * the same bounded same-handle reader as readRecords(); the retained object
	 * count is independently capped and keeps the newest chronological window.
	 * Existing readRecords() intentionally remains current-file-only.
	 */
	async readRecordsChronological(options: ChronologicalReadOptions = {}): Promise<ChronologicalReadResult> {
		const maxRecords = normalizeChronologicalRecordLimit(options.maxRecords);
		const sources = this.chronologicalSources();
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const before = await snapshotTelemetryGeneration(sources);
			const read = await this.readChronologicalAttempt(sources, maxRecords);
			const after = await snapshotTelemetryGeneration(sources);
			if (sameTelemetryGeneration(before, after)) {
				return generationHasRotationGap(after)
					? { ...read, unavailable: "rotation_gap", sourceIncomplete: true }
					: read;
			}
			if (attempt === 1) {
				return {
					...read,
					unavailable: "source_changed_during_read",
					sourceIncomplete: true,
				};
			}
		}
		return {
			records: [],
			skipped: 0,
			unavailable: "read_error",
			sourceIncomplete: true,
			truncatedRecords: 0,
			filesRead: 0,
		};
	}

	private chronologicalSources(): Array<{ name: string; path: string }> {
		const sources: Array<{ name: string; path: string }> = [];
		for (let n = this.maxRotatedFiles; n >= 1; n -= 1) {
			sources.push({ name: `telemetry.${n}.jsonl`, path: this.rotatedPath(n) });
		}
		sources.push({ name: TELEMETRY_FILE, path: this.telemetryPath() });
		return sources;
	}

	private async readChronologicalAttempt(
		sources: readonly { name: string; path: string }[],
		maxRecords: number,
	): Promise<ChronologicalReadResult> {
		const retained = new RecordRing<TelemetryRecord>(maxRecords);
		let skipped = 0;
		let filesRead = 0;
		let unavailable: StoreReadResult["unavailable"];
		for (const source of sources) {
			const loaded = await readTelemetryFileBounded(
				source.path,
				this.maxFileBytes + MAX_TELEMETRY_RECORD_BYTES,
				this.boundedReadHooks,
			);
			if (!loaded.ok) {
				if (loaded.reason !== "missing" && unavailable === undefined) unavailable = loaded.reason;
				continue;
			}
			filesRead += 1;
			const parsed = parseTelemetryJsonlInto(loaded.text, retained);
			skipped += parsed.skipped;
		}
		return {
			records: retained.toArray(),
			skipped,
			...(unavailable !== undefined ? { unavailable } : {}),
			sourceIncomplete: unavailable !== undefined || skipped > 0,
			truncatedRecords: Math.max(0, retained.totalPushed - retained.size),
			filesRead,
		};
	}

	/** Total bytes of the current telemetry file (0 when missing). */
	async telemetryBytes(): Promise<number> {
		try {
			const info = await stat(this.telemetryPath());
			return info.size;
		} catch {
			return 0;
		}
	}

	/** Total bytes across the current + rotated telemetry files. */
	async telemetryBytesAll(): Promise<number> {
		let total = await this.telemetryBytes();
		try {
			const names = await readdir(this.cacheDir());
			for (const name of names) {
				const match = /^telemetry\.(\d+)\.jsonl$/.exec(name);
				if (!match) continue;
				try {
					total += (await stat(join(this.cacheDir(), name))).size;
				} catch {
					// raced with rotation — ignore
				}
			}
		} catch {
			// cache dir missing — total stays as-is
		}
		return total;
	}

	/** Rotate when the current file exceeds the limit; drop the oldest. */
	async rotateIfNeeded(): Promise<void> {
		const size = await this.telemetryBytes();
		if (size < this.maxFileBytes) return;
		await this.rotateNow();
	}

	/** telemetry.jsonl -> telemetry.1.jsonl, shift the rest, drop the oldest. */
	async rotateNow(): Promise<void> {
		// Drop the bounded oldest generation before shifting newer generations.
		await rm(this.rotatedPath(this.maxRotatedFiles), { force: true });
		for (let n = this.maxRotatedFiles - 1; n >= 1; n -= 1) {
			await this.renameRotationSourceIfPresent(this.rotatedPath(n), this.rotatedPath(n + 1));
		}
		await this.renameRotationSourceIfPresent(this.telemetryPath(), this.rotatedPath(1));
	}

	private async renameRotationSourceIfPresent(source: string, destination: string): Promise<void> {
		try {
			await this.rotationRename(source, destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}

/**
 * Atomically write a report file: tmp file + rename. Returns the
 * absolute path on success. The name is sanitized to [A-Za-z0-9_-] and the
 * final path is verified to stay inside the reports directory.
 */
	async saveReport(name: string, data: unknown): Promise<StoreReportResult> {
		const safeName = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
		if (safeName.length === 0 || safeName.startsWith(".")) {
			return { ok: false, error: "invalid report name" };
		}
		try {
			await mkdir(this.reportsDir(), { recursive: true, mode: 0o700 });
			const target = join(this.reportsDir(), `${safeName}.json`);
			// Defense in depth: the resolved target must stay inside reportsDir.
			const { resolve, relative } = await import("node:path");
			const resolved = resolve(target);
			const rel = relative(resolve(this.reportsDir()), resolved);
			if (rel.startsWith("..")) {
				return { ok: false, error: "report path escapes the reports directory" };
			}
			const tmp = join(this.reportsDir(), `.${safeName}.tmp`);
			await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
			await rename(tmp, target);
			return { ok: true, path: target };
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	}

	/** Report file names currently in the reports directory. */
	async listReports(): Promise<string[]> {
		try {
			const names = await readdir(this.reportsDir());
			return names.filter((n) => n.endsWith(".json")).sort();
		} catch {
			return [];
		}
	}

	/** Number of rotated telemetry files currently kept. */
	async rotatedFileCount(): Promise<number> {
		try {
			const names = await readdir(this.cacheDir());
			return names.filter((n) => /^telemetry\.\d+\.jsonl$/.test(n)).length;
		} catch {
			return 0;
		}
	}
}

function normalizeTelemetryThreshold(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_TELEMETRY_BYTES;
	if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_TELEMETRY_BYTES;
	return Math.min(Math.floor(value), DEFAULT_MAX_TELEMETRY_BYTES);
}

function normalizeChronologicalRecordLimit(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_CHRONOLOGICAL_RECORDS;
	return Math.min(Math.floor(value), MAX_CHRONOLOGICAL_RECORDS);
}

/** Fixed-cap newest-record ring; object retention never exceeds capacity. */
class RecordRing<T> {
	private readonly values: T[] = [];
	private next = 0;
	totalPushed = 0;

	constructor(private readonly capacity: number) {}

	get size(): number {
		return this.values.length;
	}

	push(value: T): void {
		this.totalPushed += 1;
		if (this.values.length < this.capacity) {
			this.values.push(value);
			return;
		}
		this.values[this.next] = value;
		this.next = (this.next + 1) % this.capacity;
	}

	toArray(): T[] {
		if (this.values.length < this.capacity || this.next === 0) return this.values.slice();
		const ordered: T[] = [];
		for (let index = 0; index < this.values.length; index += 1) {
			const value = this.values[(this.next + index) % this.values.length];
			if (value !== undefined) ordered.push(value);
		}
		return ordered;
	}
}

/** Scan one line at a time; never materialize an all-lines or all-records array. */
function parseTelemetryJsonlInto(text: string, retained: RecordRing<TelemetryRecord>): { skipped: number } {
	let skipped = 0;
	let start = 0;
	while (start < text.length) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline;
		const line = text.slice(start, end);
		start = newline === -1 ? text.length : newline + 1;
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (Buffer.byteLength(trimmed, "utf8") + 1 > MAX_TELEMETRY_RECORD_BYTES) {
			skipped += 1;
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (isTelemetryRecord(parsed)) retained.push(parsed);
			else skipped += 1;
		} catch {
			skipped += 1;
		}
	}
	return { skipped };
}

type GenerationState =
	| { name: string; state: "missing" }
	| { name: string; state: "source_not_regular" }
	| { name: string; state: "read_error" }
	| { name: string; state: "regular"; fileSize: number; mtimeNs: string; dev?: number; ino?: number };

/** Exact filename + regular-file identity snapshot across the rotation set. */
async function snapshotTelemetryGeneration(
	sources: readonly { name: string; path: string }[],
): Promise<GenerationState[]> {
	const generation: GenerationState[] = [];
	for (const source of sources) {
		try {
			const info = await stat(source.path, { bigint: true });
			if (!info.isFile()) {
				generation.push({ name: source.name, state: "source_not_regular" });
				continue;
			}
			const normalized = fileSourceSnapshotFromStats(info);
			if (!normalized.ok || normalized.value.mtimeNs === undefined) {
				generation.push({ name: source.name, state: "read_error" });
				continue;
			}
			generation.push({
				name: source.name,
				state: "regular",
				fileSize: normalized.value.fileSize,
				mtimeNs: normalized.value.mtimeNs,
				...(normalized.value.dev === undefined ? {} : { dev: normalized.value.dev }),
				...(normalized.value.ino === undefined ? {} : { ino: normalized.value.ino }),
			});
		} catch (error) {
			generation.push({
				name: source.name,
				state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "read_error",
			});
		}
	}
	return generation;
}

function sameTelemetryGeneration(left: readonly GenerationState[], right: readonly GenerationState[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index];
		const b = right[index];
		if (!a || !b || a.name !== b.name || a.state !== b.state) return false;
		if (a.state === "regular" && b.state === "regular") {
			if (a.fileSize !== b.fileSize || a.mtimeNs !== b.mtimeNs || a.dev !== b.dev || a.ino !== b.ino) return false;
		}
	}
	return true;
}

/**
 * Once any rotated generation exists, every newer generation through the
 * current file must exist. A missing file in that suffix proves that the
 * retained history is discontinuous. A project with no telemetry at all, or
 * a current file with no rotations yet, is complete rather than a gap.
 */
function generationHasRotationGap(generation: readonly GenerationState[]): boolean {
	let rotatedGenerationSeen = false;
	for (let index = 0; index < generation.length; index += 1) {
		const item = generation[index];
		if (!item) return true;
		const isCurrent = index === generation.length - 1;
		if (isCurrent) return rotatedGenerationSeen && item.state === "missing";
		if (item.state !== "missing") {
			rotatedGenerationSeen = true;
		} else if (rotatedGenerationSeen) {
			return true;
		}
	}
	return false;
}

type TelemetryReadFailure = "missing" | "source_oversized" | "source_not_regular" | "source_changed_during_read" | "read_error";
type TelemetryReadResult = { ok: true; text: string } | { ok: false; reason: TelemetryReadFailure };

/** Same-open-handle whole-file read with the rotation threshold plus one-record slack. */
async function readTelemetryFileBounded(
	path: string,
	maxBytes: number,
	hooks?: BoundedFileIoHooks,
): Promise<TelemetryReadResult> {
	let handle: FileHandle;
	try {
		handle = await open(path, "r");
	} catch (error) {
		return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "read_error" };
	}
	try {
		const initialStats = await handle.stat({ bigint: true });
		if (!initialStats.isFile()) return { ok: false, reason: "source_not_regular" };
		const initial = fileSourceSnapshotFromStats(initialStats);
		if (!initial.ok || initial.value.mtimeNs === undefined) return { ok: false, reason: "read_error" };
		await hooks?.afterInitialStat?.(Object.freeze({ ...initial.value }));
		if (initial.value.fileSize > maxBytes) return { ok: false, reason: "source_oversized" };
		hooks?.onBufferAllocate?.(initial.value.fileSize);
		const buffer = Buffer.allocUnsafe(initial.value.fileSize);
		hooks?.beforeRead?.(buffer.length);
		let offset = 0;
		while (offset < buffer.length) {
			const read = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (read.bytesRead <= 0) return { ok: false, reason: "read_error" };
			offset += read.bytesRead;
		}
		await hooks?.afterRead?.(Object.freeze({ ...initial.value }));
		const finalStats = await handle.stat({ bigint: true });
		if (!finalStats.isFile()) return { ok: false, reason: "source_changed_during_read" };
		const final = fileSourceSnapshotFromStats(finalStats);
		if (!final.ok || final.value.mtimeNs === undefined || !sameTelemetrySnapshot(initial.value, final.value)) {
			return { ok: false, reason: "source_changed_during_read" };
		}
		// Buffer.toString("utf8") silently replaces malformed byte sequences
		// with U+FFFD. A replacement can leave otherwise valid JSON and schema
		// data looking trustworthy, so telemetry must fail closed instead.
		return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
	} catch {
		return { ok: false, reason: "read_error" };
	} finally {
		await handle.close().catch(() => {});
	}
}

function sameTelemetrySnapshot(
	a: { fileSize: number; mtimeMs: number; mtimeNs?: string; dev?: number; ino?: number },
	b: { fileSize: number; mtimeMs: number; mtimeNs?: string; dev?: number; ino?: number },
): boolean {
	return a.fileSize === b.fileSize && a.mtimeMs === b.mtimeMs && a.mtimeNs === b.mtimeNs && a.dev === b.dev && a.ino === b.ino;
}
