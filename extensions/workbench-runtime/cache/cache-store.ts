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
 *   - corrupted lines are skipped and counted on read, never fatal
 *   - write failures degrade to {ok:false} — telemetry must never block or
 *     crash a model request
 *   - records containing forbidden fields are REFUSED before touching disk
 *   - report files are written atomically (tmp + rename)
 *   - file/dir modes are restricted to the current user (0o600/0o700)
 */

import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const CACHE_DIR_NAME = "cache";
export const TELEMETRY_FILE = "telemetry.jsonl";
export const REPORTS_DIR_NAME = "reports";
export const DEFAULT_MAX_TELEMETRY_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_ROTATED_FILES = 5;

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
 * `systemPromptHash` is allowed, `systemPrompt` is not.
 */
export function hasForbiddenTelemetryFields(value: unknown): string | null {
	const forbidden = new Set(FORBIDDEN_TELEMETRY_KEYS);
	return scan(value, forbidden);
}

function scan(value: unknown, forbidden: ReadonlySet<string>, depth = 0): string | null {
	if (depth > 32 || value === null || value === undefined) return null;
	if (typeof value !== "object") return null;
	if (Array.isArray(value)) {
		for (const item of value) {
			const hit = scan(item, forbidden, depth + 1);
			if (hit !== null) return hit;
		}
		return null;
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (forbidden.has(key)) return key;
	}
	for (const key of Object.keys(record)) {
		const hit = scan(record[key], forbidden, depth + 1);
		if (hit !== null) return hit;
	}
	return null;
}

export interface CacheStoreOptions {
	/** Rotation threshold for telemetry.jsonl (bytes). */
	maxFileBytes?: number;
	/** Number of rotated files kept (telemetry.1..N.jsonl). */
	maxRotatedFiles?: number;
}

export interface StoreAppendResult {
	ok: boolean;
	error?: string;
}

export interface StoreReadResult {
	records: unknown[];
	skipped: number;
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

	constructor(projectRoot: string, options: CacheStoreOptions = {}) {
		this.projectRoot = projectRoot;
		this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_TELEMETRY_BYTES;
		this.maxRotatedFiles = options.maxRotatedFiles ?? DEFAULT_MAX_ROTATED_FILES;
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
		const forbidden = hasForbiddenTelemetryFields(record);
		if (forbidden !== null) {
			return { ok: false, error: `refused: record contains forbidden field "${forbidden}"` };
		}
		try {
			await mkdir(this.cacheDir(), { recursive: true, mode: 0o700 });
			await this.rotateIfNeeded();
			await appendFile(this.telemetryPath(), `${JSON.stringify(record)}\n`, { flag: "a", mode: 0o600 });
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
		let text: string;
		try {
			text = await readFile(this.telemetryPath(), "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return { records: [], skipped: 0 };
			return { records: [], skipped: 0 };
		}
		const records: unknown[] = [];
		let skipped = 0;
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				records.push(JSON.parse(trimmed) as unknown);
			} catch {
				skipped += 1;
			}
		}
		return { records, skipped };
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
		// Drop the oldest rotated file first so a failed rename never loses data.
		await rm(this.rotatedPath(this.maxRotatedFiles), { force: true });
		for (let n = this.maxRotatedFiles - 1; n >= 1; n -= 1) {
			await rename(this.rotatedPath(n), this.rotatedPath(n + 1)).catch(() => {});
		}
		await rename(this.telemetryPath(), this.rotatedPath(1)).catch(() => {});
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
