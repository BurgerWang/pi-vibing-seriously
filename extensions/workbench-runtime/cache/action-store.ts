/**
 * P6-C Action Cache store — disk layout, atomic writes, locking, LRU prune,
 * corruption handling, and (opt-in, disabled in v1) CAS primitives.
 *
 * Layout (project-local, never shared across projects):
 *   <root>/<CONFIG_DIR_NAME>/workbench/cache/
 *     actions/<key>.json      — action records (result metadata only)
 *     cas/<hash>              — content-addressable artifacts (v1: disabled)
 *     cas/quarantine/         — CAS content that failed hash verification
 *     locks/<key>.lock        — per-key execution locks
 *     tmp/                    — staging for atomic writes
 *     cache-index.json        — LRU/space accounting (rebuildable)
 *
 * Guarantees:
 *   - atomic writes: write to tmp/, then rename
 *   - same action key executes once or waits safely (double-checked lock)
 *   - stale locks are recoverable (owner PID + createdAt)
 *   - corrupted action JSON → miss (+ quarantined copy)
 *   - CAS reads re-verify the SHA-256; mismatch → quarantine + miss
 *   - a corrupted index is rebuilt from the actions directory
 *   - prune never deletes runs/evidence/telemetry and skips in-use entries
 *   - runtime cache is gitignored (.pi/workbench/cache/)
 */

import { randomBytes, createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { workbenchDir } from "../core/config.ts";
import {
	ACTION_RECORD_SCHEMA_VERSION,
	CACHE_INDEX_SCHEMA_VERSION,
	LOCK_STALE_MS,
	type ActionRecord,
} from "./action-types.ts";

export const ACTIONS_DIR = "actions";
export const CAS_DIR = "cas";
export const LOCKS_DIR = "locks";
export const TMP_DIR = "tmp";
export const INDEX_FILE = "cache-index.json";

export interface IndexEntry {
	key: string;
	recipe: string;
	createdAt: string;
	lastUsedAt: string;
	sizeBytes: number;
	success: boolean;
	mode: string;
}

export interface CacheIndex {
	schemaVersion: number;
	entries: IndexEntry[];
}

export interface LockHandle {
	key: string;
	token: string;
	release: () => Promise<void>;
}

export interface StoreOptions {
	maxBytes?: number;
	now?: () => Date;
	lockStaleMs?: number;
	lockWaitMs?: number;
	pid?: number;
}

export interface PruneResult {
	dryRun: boolean;
	reclaimableBytes: number;
	keptBytes: number;
	totalBytes: number;
	removed: IndexEntry[];
	skippedInUse: IndexEntry[];
}

export interface StoreStats {
	entries: number;
	totalBytes: number;
	perRecipe: Record<string, { entries: number; bytes: number }>;
}

/** CAS content verification result. */
export interface CasReadResult {
	ok: boolean;
	path?: string;
	reason?: "missing" | "hash-mismatch" | "read-error";
}

export class ActionCacheStore {
	readonly projectRoot: string;
	private readonly maxBytes: number;
	private readonly now: () => Date;
	private readonly lockStaleMs: number;
	private readonly lockWaitMs: number;
	private readonly pid: number;

	constructor(projectRoot: string, options: StoreOptions = {}) {
		this.projectRoot = projectRoot;
		this.maxBytes = options.maxBytes ?? 0; // 0 = caller decides (see setMaxBytes)
		this.now = options.now ?? (() => new Date());
		this.lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS;
		this.lockWaitMs = options.lockWaitMs ?? 120_000;
		this.pid = options.pid ?? process.pid;
	}

	cacheDir(): string {
		return join(workbenchDir(this.projectRoot), "cache");
	}

	actionsDir(): string {
		return join(this.cacheDir(), ACTIONS_DIR);
	}

	casDir(): string {
		return join(this.cacheDir(), CAS_DIR);
	}

	quarantineDir(): string {
		return join(this.casDir(), "quarantine");
	}

	locksDir(): string {
		return join(this.cacheDir(), LOCKS_DIR);
	}

	tmpDir(): string {
		return join(this.cacheDir(), TMP_DIR);
	}

	indexPath(): string {
		return join(this.cacheDir(), INDEX_FILE);
	}

	actionPath(key: string): string {
		return join(this.actionsDir(), `${key}.json`);
	}

	lockPath(key: string): string {
		return join(this.locksDir(), `${key}.lock`);
	}

	// ------------------------------------------------------------------
	// Record writes / reads
	// ------------------------------------------------------------------

	/** Atomic record write: tmp + rename. Best-effort index maintenance. */
	async writeRecord(record: ActionRecord): Promise<{ ok: boolean; error?: string }> {
		try {
			await mkdir(this.actionsDir(), { recursive: true, mode: 0o700 });
			await mkdir(this.tmpDir(), { recursive: true, mode: 0o700 });
			const payload = `${JSON.stringify(record, null, 2)}\n`;
			const tmp = join(this.tmpDir(), `${record.actionKey}.${this.pid}.${randomBytes(4).toString("hex")}.tmp`);
			await writeFile(tmp, payload, { mode: 0o600 });
			await rename(tmp, this.actionPath(record.actionKey));
			await this.updateIndex(record, payload.length);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	}

	/**
	 * Read + basic-validate an action record. Corruption → quarantined copy
	 * in tmp/ and a miss result (cache corruption is always a miss).
	 */
	async readRecord(key: string): Promise<{ record: ActionRecord | null; corrupt: boolean }> {
		const path = this.actionPath(key);
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			return { record: null, corrupt: false };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			await this.quarantineAction(key, "unparseable-json");
			return { record: null, corrupt: true };
		}
		const record = parsed as ActionRecord;
		if (
			typeof record !== "object" ||
			record === null ||
			record.schemaVersion !== ACTION_RECORD_SCHEMA_VERSION ||
			record.actionKey !== key
		) {
			await this.quarantineAction(key, "schema-or-key-mismatch");
			return { record: null, corrupt: true };
		}
		return { record, corrupt: false };
	}

	private async quarantineAction(key: string, reason: string): Promise<void> {
		try {
			await mkdir(this.tmpDir(), { recursive: true, mode: 0o700 });
			const target = join(this.tmpDir(), `corrupt-${key}-${reason}-${this.now().toISOString().replace(/[:.]/g, "-")}.json`);
			await rename(this.actionPath(key), target).catch(() => {});
		} catch {
			// quarantine is best-effort
		}
	}

	/** Update the index for a written record (upsert, atomic). */
	private async updateIndex(record: ActionRecord, sizeBytes: number): Promise<void> {
		const index = await this.readIndex();
		const existing = index.entries.find((e) => e.key === record.actionKey);
		const entry: IndexEntry = {
			key: record.actionKey,
			recipe: record.recipe,
			createdAt: existing?.createdAt ?? record.createdAt,
			lastUsedAt: this.now().toISOString(),
			sizeBytes,
			success: record.success,
			mode: record.mode,
		};
		index.entries = index.entries.filter((e) => e.key !== record.actionKey);
		index.entries.push(entry);
		await this.writeIndex(index);
	}

	/** Touch lastUsedAt on a hit (LRU bookkeeping, best-effort). */
	async touch(key: string): Promise<void> {
		try {
			const index = await this.readIndex();
			const entry = index.entries.find((e) => e.key === key);
			if (!entry) return;
			entry.lastUsedAt = this.now().toISOString();
			await this.writeIndex(index);
		} catch {
			// best-effort
		}
	}

	// ------------------------------------------------------------------
	// Index
	// ------------------------------------------------------------------

	/** Read the index; a corrupted index is rebuilt from actions/. */
	async readIndex(): Promise<CacheIndex> {
		try {
			const raw = await readFile(this.indexPath(), "utf8");
			const parsed = JSON.parse(raw) as CacheIndex;
			if (parsed.schemaVersion !== CACHE_INDEX_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
				return await this.rebuildIndex();
			}
			return parsed;
		} catch {
			return await this.rebuildIndex();
		}
	}

	private async writeIndex(index: CacheIndex): Promise<void> {
		await mkdir(this.cacheDir(), { recursive: true, mode: 0o700 });
		const tmp = join(this.tmpDir(), `index.${this.pid}.${randomBytes(4).toString("hex")}.tmp`);
		await mkdir(this.tmpDir(), { recursive: true, mode: 0o700 });
		await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
		await rename(tmp, this.indexPath());
	}

	/** Rebuild the index by scanning the actions directory. */
	async rebuildIndex(): Promise<CacheIndex> {
		const entries: IndexEntry[] = [];
		let names: string[] = [];
		try {
			names = await readdir(this.actionsDir());
		} catch {
			return { schemaVersion: CACHE_INDEX_SCHEMA_VERSION, entries: [] };
		}
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const key = name.slice(0, -".json".length);
			try {
				const path = this.actionPath(key);
				const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
				const record = JSON.parse(raw) as ActionRecord;
				if (record.schemaVersion !== ACTION_RECORD_SCHEMA_VERSION || record.actionKey !== key) continue;
				entries.push({
					key,
					recipe: record.recipe,
					createdAt: record.createdAt,
					lastUsedAt: record.createdAt,
					sizeBytes: info.size,
					success: record.success,
					mode: record.mode,
				});
			} catch {
				// corrupted record: leave it for readRecord to quarantine
			}
		}
		entries.sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : 0));
		const index: CacheIndex = { schemaVersion: CACHE_INDEX_SCHEMA_VERSION, entries };
		await this.writeIndex(index).catch(() => {});
		return index;
	}

	// ------------------------------------------------------------------
	// Locks
	// ------------------------------------------------------------------

	/**
	 * Acquire the per-key lock. Returns null when the wait times out — the
	 * caller proceeds WITHOUT the lock (cache writes become best-effort).
	 * Stale locks (dead owner PID or older than lockStaleMs) are broken.
	 */
	async acquireLock(key: string): Promise<LockHandle | null> {
		const path = this.lockPath(key);
		const token = `${this.pid}-${randomBytes(6).toString("hex")}`;
		const startedAt = Date.now();
		for (;;) {
			try {
				await mkdir(this.locksDir(), { recursive: true, mode: 0o700 });
				const handle = await open(path, "wx", 0o600);
				await handle.writeFile(JSON.stringify({ key, token, ownerPid: this.pid, createdAt: this.now().toISOString() }));
				await handle.close();
				return {
					key,
					token,
					release: async () => {
						try {
							const raw = await readFile(path, "utf8");
							const parsed = JSON.parse(raw) as { token?: string };
							if (parsed.token !== token) return; // someone else's lock now
							await rm(path, { force: true });
						} catch {
							// already gone
						}
					},
				};
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") return null;
				// Existing lock: check staleness.
				const stale = await this.isStaleLock(path);
				if (stale) {
					await rm(path, { force: true }).catch(() => {});
					continue;
				}
				if (Date.now() - startedAt > this.lockWaitMs) return null;
				await sleep(100);
			}
		}
	}

	private async isStaleLock(path: string): Promise<boolean> {
		try {
			const raw = await readFile(path, "utf8");
			const parsed = JSON.parse(raw) as { ownerPid?: number; createdAt?: string };
			const createdAt = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : NaN;
			const ownerPid = parsed.ownerPid;
			// A lock whose owner process is still alive is NEVER stale, no
			// matter how old — breaking it would double-execute a running
			// recipe. Age only applies to dead/unknown owners.
			if (typeof ownerPid === "number" && pidAlive(ownerPid)) return false;
			// Owner is dead or unknown: recoverable once old enough (or when
			// the owner pid is simply absent).
			if (!Number.isNaN(createdAt) && Date.now() - createdAt > this.lockStaleMs) return true;
			return typeof ownerPid !== "number";
		} catch {
			// unparseable lock = stale
			return true;
		}
	}

	/** True when a fresh lock exists for a key (used by prune safety). */
	async hasFreshLock(key: string): Promise<boolean> {
		try {
			const path = this.lockPath(key);
			await readFile(path, "utf8");
			return !(await this.isStaleLock(path));
		} catch {
			return false;
		}
	}

	// ------------------------------------------------------------------
	// Stats / prune / clear
	// ------------------------------------------------------------------

	async stats(): Promise<StoreStats> {
		const index = await this.readIndex();
		const perRecipe: Record<string, { entries: number; bytes: number }> = {};
		let totalBytes = 0;
		for (const entry of index.entries) {
			totalBytes += entry.sizeBytes;
			const bucket = (perRecipe[entry.recipe] ??= { entries: 0, bytes: 0 });
			bucket.entries += 1;
			bucket.bytes += entry.sizeBytes;
		}
		return { entries: index.entries.length, totalBytes, perRecipe };
	}

	/**
	 * LRU prune. Dry-run by default; `apply` deletes records (oldest
	 * lastUsedAt first) until the total fits under maxBytes. Entries with a
	 * fresh lock are skipped (never delete something in use). Never touches
	 * runs/, evidence, telemetry or reports.
	 */
	async prune(options: { apply: boolean; maxBytes?: number }): Promise<PruneResult> {
		const maxBytes = options.maxBytes ?? this.maxBytes;
		const index = await this.readIndex();
		const sorted = [...index.entries].sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? -1 : a.lastUsedAt > b.lastUsedAt ? 1 : 0));
		let total = sorted.reduce((sum, e) => sum + e.sizeBytes, 0);
		const removed: IndexEntry[] = [];
		const skippedInUse: IndexEntry[] = [];
		for (const entry of sorted) {
			if (total <= maxBytes) break;
			if (await this.hasFreshLock(entry.key)) {
				skippedInUse.push(entry);
				continue;
			}
			removed.push(entry);
			total -= entry.sizeBytes;
		}
		if (options.apply && removed.length > 0) {
			for (const entry of removed) {
				await rm(this.actionPath(entry.key), { force: true }).catch(() => {});
				await rm(this.lockPath(entry.key), { force: true }).catch(() => {});
			}
			index.entries = index.entries.filter((e) => !removed.some((r) => r.key === e.key));
			await this.writeIndex(index);
		}
		return {
			dryRun: !options.apply,
			reclaimableBytes: removed.reduce((sum, e) => sum + e.sizeBytes, 0),
			keptBytes: Math.max(0, total),
			totalBytes: total + removed.reduce((sum, e) => sum + e.sizeBytes, 0),
			removed,
			skippedInUse,
		};
	}

	/** Clear records for one recipe or all. Never touches runs/evidence. */
	async clear(target: string): Promise<{ removed: number; recipe: string | "all" }> {
		const index = await this.readIndex();
		const removed = index.entries.filter((e) => target === "all" || e.recipe === target);
		for (const entry of removed) {
			await rm(this.actionPath(entry.key), { force: true }).catch(() => {});
			await rm(this.lockPath(entry.key), { force: true }).catch(() => {});
		}
		index.entries = index.entries.filter((e) => !removed.some((r) => r.key === e.key));
		await this.writeIndex(index);
		return { removed: removed.length, recipe: target };
	}

	// ------------------------------------------------------------------
	// CAS primitives (opt-in; restore disabled in v1)
	// ------------------------------------------------------------------

	/** Store content under its SHA-256 (only when restore is enabled). */
	async storeCasArtifact(content: Buffer | string, hash: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
			const actual = sha256Bytes(bytes);
			if (actual !== hash) return { ok: false, error: "content hash mismatch at store time" };
			await mkdir(this.casDir(), { recursive: true, mode: 0o700 });
			await mkdir(this.tmpDir(), { recursive: true, mode: 0o700 });
			const path = join(this.casDir(), hash);
			const tmp = join(this.tmpDir(), `cas.${this.pid}.${randomBytes(4).toString("hex")}.tmp`);
			await writeFile(tmp, bytes, { mode: 0o600 });
			await rename(tmp, path);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	}

	/**
	 * Read a CAS artifact and RE-VERIFY its SHA-256. A mismatch moves the
	 * content to cas/quarantine/ and reports a miss — a corrupted CAS entry
	 * must never be restored.
	 */
	async readCasArtifact(hash: string): Promise<CasReadResult> {
		const path = join(this.casDir(), hash);
		let content: Buffer;
		try {
			content = await readFile(path);
		} catch {
			return { ok: false, reason: "missing" };
		}
		const actual = sha256Bytes(content);
		if (actual !== hash) {
			try {
				await mkdir(this.quarantineDir(), { recursive: true, mode: 0o700 });
				await rename(path, join(this.quarantineDir(), `${hash}.${Date.now()}.quarantined`));
			} catch {
				// quarantine is best-effort
			}
			return { ok: false, reason: "hash-mismatch" };
		}
		return { ok: true, path };
	}
}

/** SHA-256 of raw bytes (CAS content is hashed as bytes, never as text). */
function sha256Bytes(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
