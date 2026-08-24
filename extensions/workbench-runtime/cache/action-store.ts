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
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
	fileSourceSnapshotFromStats,
	type BoundedFileIoHooks,
} from "../core/bounded-file-io.ts";
import type { FileSourceSnapshot } from "../core/continuation-cursor.ts";
import { workbenchDir } from "../core/config.ts";
import {
	ACTION_RECORD_SCHEMA_VERSION,
	CACHE_INDEX_SCHEMA_VERSION,
	LOCK_STALE_MS,
	MAX_RECORD_INPUT_ENTRIES,
	type ActionRecord,
} from "./action-types.ts";

export const ACTIONS_DIR = "actions";
export const CAS_DIR = "cas";
export const LOCKS_DIR = "locks";
export const TMP_DIR = "tmp";
export const INDEX_FILE = "cache-index.json";
export const INDEX_LOCK_FILE = "cache-index.lock";
export const ACTION_RECORD_MAX_BYTES = 1_048_576;
export const CACHE_INDEX_MAX_BYTES = 1_048_576;
export const LOCK_RECORD_MAX_BYTES = 4_096;
/** Hard production ceilings for a complete actions/ index rebuild. */
export const CACHE_INDEX_REBUILD_MAX_ENTRIES = 4_096;
export const CACHE_INDEX_REBUILD_MAX_BYTES = 256 * 1024 * 1024;

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
	/** Process-instance identity seams; production uses kill(2) + Linux procfs. */
	isProcessAlive?: (pid: number) => boolean;
	readBootId?: () => Promise<string | null>;
	readProcessStartTicks?: (pid: number) => Promise<string | null>;
	/** Test-only numeric allocation/read observations; never receives path/content. */
	boundedReadHooks?: BoundedFileIoHooks;
	/** Test seam; may only lower the hard production rebuild entry ceiling. */
	indexRebuildMaxEntries?: number;
	/** Test seam; may only lower the hard production rebuild byte ceiling. */
	indexRebuildMaxBytes?: number;
	/** Test seam; may only lower the fixed wait for the fail-closed index lock. */
	indexLockWaitMs?: number;
	/** Content-free deterministic concurrency/fault hooks. */
	indexMutationHooks?: {
		afterAcquire?: () => void | Promise<void>;
		afterRecordPublishBeforeIndex?: () => void | Promise<void>;
		beforeWrite?: () => void | Promise<void>;
		afterWriteBeforeVerify?: () => void | Promise<void>;
	};
	/** Runs after a stale per-key lock observation and before its atomic claim. */
	afterStaleLockObserved?: () => void | Promise<void>;
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

const SHA256_RE = /^[0-9a-f]{64}$/;
const RUN_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/;
const BOOT_ID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PROCESS_START_TICKS_RE = /^(0|[1-9]\d*)$/;

function finiteNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function stringRecord(value: unknown): value is Record<string, string> {
	return isJsonObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function validInputFacts(value: unknown): boolean {
	if (!isJsonObject(value)) return false;
	return nonNegativeSafeInteger(value.files)
		&& nonNegativeSafeInteger(value.dirs)
		&& nonNegativeSafeInteger(value.symlinks)
		&& nonNegativeSafeInteger(value.missingPatterns)
		&& nonNegativeSafeInteger(value.protectedRefused)
		&& nonNegativeSafeInteger(value.totalBytes)
		&& typeof value.truncated === "boolean";
}

function validInputEntries(value: unknown): boolean {
	if (value === null) return true;
	if (!Array.isArray(value) || value.length > MAX_RECORD_INPUT_ENTRIES) return false;
	return value.every((entry) => isJsonObject(entry)
		&& typeof entry.p === "string"
		&& ["file", "dir", "symlink", "missing", "protected"].includes(String(entry.t))
		&& typeof entry.h === "string"
		&& (entry.x === undefined || entry.x === 0 || entry.x === 1));
}

function validQuantContractInfo(value: unknown, key: unknown): boolean {
	if (value === null) return key === null;
	if (!isJsonObject(value) || typeof key !== "string" || value.immutableKey !== key) return false;
	return ["data-snapshot", "feature-set", "backtest-result"].includes(String(value.type))
		&& typeof value.manifest === "string"
		&& typeof value.immutableKey === "string"
		&& typeof value.manifestHash === "string"
		&& SHA256_RE.test(value.manifestHash)
		&& ["validated", "unresolved", "invalid"].includes(String(value.validationStatus))
		&& (value.logicalReference === null || typeof value.logicalReference === "string")
		&& (value.resolvedReference === null || typeof value.resolvedReference === "string")
		&& stringArray(value.warnings);
}

function validIndexEntry(value: unknown): value is IndexEntry {
	if (!isJsonObject(value)) return false;
	const keys = Object.keys(value).sort();
	if (keys.join("\u0000") !== ["createdAt", "key", "lastUsedAt", "mode", "recipe", "sizeBytes", "success"].join("\u0000")) return false;
	return typeof value.key === "string" && SHA256_RE.test(value.key)
		&& typeof value.recipe === "string" && value.recipe.length > 0 && value.recipe.length <= 256
		&& typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
		&& typeof value.lastUsedAt === "string" && Number.isFinite(Date.parse(value.lastUsedAt))
		&& nonNegativeSafeInteger(value.sizeBytes) && value.sizeBytes <= ACTION_RECORD_MAX_BYTES
		&& typeof value.success === "boolean"
		&& (value.mode === "result-only" || value.mode === "artifacts");
}

function parseCacheIndex(value: unknown, maxEntries: number, maxBytes: number): CacheIndex | null {
	if (!isJsonObject(value)) return null;
	if (Object.keys(value).sort().join("\u0000") !== ["entries", "schemaVersion"].join("\u0000")) return null;
	if (value.schemaVersion !== CACHE_INDEX_SCHEMA_VERSION || !Array.isArray(value.entries) || value.entries.length > maxEntries) return null;
	if (!value.entries.every(validIndexEntry)) return null;
	const keys = new Set(value.entries.map((entry) => entry.key));
	if (keys.size !== value.entries.length) return null;
	const claimedBytes = value.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
	if (!Number.isSafeInteger(claimedBytes) || claimedBytes > maxBytes) return null;
	return { schemaVersion: CACHE_INDEX_SCHEMA_VERSION, entries: value.entries };
}

function lowerBoundedOption(value: number | undefined, hardMax: number): number {
	if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return hardMax;
	return Math.min(value, hardMax);
}

function errnoCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function samePathIdentity(
	before: Awaited<ReturnType<typeof lstat>>,
	after: Awaited<ReturnType<typeof lstat>>,
	source: { fileSize: number; dev?: number; ino?: number },
): boolean {
	return before.isFile() && !before.isSymbolicLink()
		&& after.isFile() && !after.isSymbolicLink()
		&& before.dev === after.dev && before.ino === after.ino
		&& before.size === after.size && before.mtimeMs === after.mtimeMs
		&& source.fileSize === before.size
		&& (source.dev === undefined || source.dev === before.dev)
		&& (source.ino === undefined || source.ino === before.ino);
}

function sameSourceSnapshot(left: FileSourceSnapshot, right: FileSourceSnapshot): boolean {
	return left.fileSize === right.fileSize
		&& left.mtimeMs === right.mtimeMs
		&& left.mtimeNs === right.mtimeNs
		&& left.dev === right.dev
		&& left.ino === right.ino;
}

export class ActionCacheIndexRebuildError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActionCacheIndexRebuildError";
	}
}

interface LockObservation {
	token: string;
	ownerPid: number | null;
	createdAtMs: number;
	bootId: string | null;
	processStartTicks: string | null;
	source: { fileSize: number; dev?: number; ino?: number };
}

interface MalformedLockObservation {
	source: { fileSize: number; dev: number; ino: number; mtimeMs: number };
}

interface PublishedLock {
	ownerPath: string;
}

interface CacheDirectoryIdentity {
	path: string;
	dev: number;
	ino: number;
}

/** Complete v1 action-record parser. Any field drift is cache corruption, never a runtime exception. */
function parseActionRecord(value: unknown, key: string): ActionRecord | null {
	if (!isJsonObject(value)) return null;
	if (value.schemaVersion !== ACTION_RECORD_SCHEMA_VERSION || value.actionKey !== key || !SHA256_RE.test(key)) return null;
	if (!nonNegativeSafeInteger(value.cachePolicyVersion) || value.cachePolicyVersion === 0) return null;
	if (typeof value.recipe !== "string" || value.recipe.length === 0) return null;
	if (value.mode !== "result-only" && value.mode !== "artifacts") return null;
	if (typeof value.success !== "boolean") return null;
	if (!(value.exitCode === null || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode)))) return null;
	if (!Array.isArray(value.expectedExitCodes) || value.expectedExitCodes.length === 0 || !value.expectedExitCodes.every((code) => typeof code === "number" && Number.isInteger(code))) return null;
	if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return null;
	if (typeof value.sourceRunId !== "string" || !RUN_ID_RE.test(value.sourceRunId)) return null;
	if (!finiteNonNegativeNumber(value.durationMs)) return null;
	if (typeof value.cwd !== "string" || value.cwd.length === 0) return null;
	if (typeof value.os !== "string" || value.os.length === 0 || typeof value.arch !== "string" || value.arch.length === 0) return null;
	for (const hash of [value.argvHash, value.definitionHash, value.cachePolicyHash, value.inputMerkleHash, value.workbenchConfigHash, value.profileHash, value.gateSchemaHash]) {
		if (typeof hash !== "string" || !SHA256_RE.test(hash)) return null;
	}
	if (!stringArray(value.environmentNames) || !stringRecord(value.envValueHashes)) return null;
	if (!Object.values(value.envValueHashes).every((hash) => hash === "unset" || SHA256_RE.test(hash))) return null;
	if (!stringRecord(value.toolchainVersions) || !stringRecord(value.lockfileHashes)) return null;
	if (!validInputFacts(value.inputFacts) || !validInputEntries(value.inputEntries)) return null;
	if (!Array.isArray(value.upstreamActionKeys) || !value.upstreamActionKeys.every((candidate) => typeof candidate === "string" && SHA256_RE.test(candidate))) return null;
	if (!(value.quantContractKey === null || typeof value.quantContractKey === "string")) return null;
	if (!validQuantContractInfo(value.quantContractInfo, value.quantContractKey)) return null;
	if (typeof value.allowedMode !== "string" || value.allowedMode.length === 0) return null;
	if (typeof value.packageVersion !== "string" || value.packageVersion.length === 0) return null;
	if (!isJsonObject(value.summary)
		|| typeof value.summary.stdout !== "string"
		|| typeof value.summary.stderr !== "string"
		|| typeof value.summary.stdoutTruncated !== "boolean"
		|| typeof value.summary.stderrTruncated !== "boolean"
		|| !stringArray(value.summary.artifactPaths)
		|| typeof value.summary.timedOut !== "boolean"
		|| typeof value.summary.cancelled !== "boolean") return null;
	if (!isJsonObject(value.artifacts)
		|| (value.artifacts.mode !== "result-only" && value.artifacts.mode !== "artifacts")
		|| value.artifacts.mode !== value.mode
		|| typeof value.artifacts.restored !== "boolean"
		|| typeof value.artifacts.restoreDisabled !== "boolean"
		|| !stringArray(value.artifacts.outputs)) return null;
	return value as unknown as ActionRecord;
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
	private readonly isProcessAlive: (pid: number) => boolean;
	private readonly readBootId: () => Promise<string | null>;
	private readonly readProcessStartTicks: (pid: number) => Promise<string | null>;
	private readonly boundedReadHooks: BoundedFileIoHooks | undefined;
	private readonly indexRebuildMaxEntries: number;
	private readonly indexRebuildMaxBytes: number;
	private readonly indexLockWaitMs: number;
	private readonly indexMutationHooks: StoreOptions["indexMutationHooks"];
	private readonly afterStaleLockObserved: StoreOptions["afterStaleLockObserved"];

	constructor(projectRoot: string, options: StoreOptions = {}) {
		this.projectRoot = projectRoot;
		this.maxBytes = options.maxBytes ?? 0; // 0 = caller decides (see setMaxBytes)
		this.now = options.now ?? (() => new Date());
		this.lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS;
		this.lockWaitMs = options.lockWaitMs ?? 120_000;
		this.pid = options.pid ?? process.pid;
		this.isProcessAlive = options.isProcessAlive ?? pidAlive;
		this.readBootId = options.readBootId ?? defaultReadBootId;
		this.readProcessStartTicks = options.readProcessStartTicks ?? defaultReadProcessStartTicks;
		this.boundedReadHooks = options.boundedReadHooks;
		this.indexRebuildMaxEntries = lowerBoundedOption(options.indexRebuildMaxEntries, CACHE_INDEX_REBUILD_MAX_ENTRIES);
		this.indexRebuildMaxBytes = lowerBoundedOption(options.indexRebuildMaxBytes, CACHE_INDEX_REBUILD_MAX_BYTES);
		this.indexLockWaitMs = lowerBoundedOption(options.indexLockWaitMs, 120_000);
		this.indexMutationHooks = options.indexMutationHooks;
		this.afterStaleLockObserved = options.afterStaleLockObserved;
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

	indexLockPath(): string {
		return join(this.locksDir(), INDEX_LOCK_FILE);
	}

	/** Create each cache directory one component at a time and reject links. */
	private async ensureSafeDirectory(path: string): Promise<void> {
		const rel = relative(this.projectRoot, path);
		if (rel === "" || rel === ".") return;
		if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("cache path escapes the project root");
		let current = this.projectRoot;
		for (const component of rel.split(sep)) {
			current = join(current, component);
			try {
				await mkdir(current, { mode: 0o700 });
			} catch (error) {
				if (errnoCode(error) !== "EEXIST") throw error;
			}
			const stats = await lstat(current);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				throw new Error(`cache directory component is unsafe: ${component}`);
			}
		}
	}

	/** Snapshot every real ancestor below the trusted project root. */
	private async safeAncestorIdentities(path: string): Promise<CacheDirectoryIdentity[] | null> {
		const rel = relative(this.projectRoot, dirname(path));
		if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
		const identities: CacheDirectoryIdentity[] = [];
		let current = this.projectRoot;
		for (const component of rel === "" || rel === "." ? [] : rel.split(sep)) {
			current = join(current, component);
			try {
				const stats = await lstat(current);
				if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
				identities.push({ path: current, dev: stats.dev, ino: stats.ino });
			} catch {
				return null;
			}
		}
		return identities;
	}

	private async sameSafeAncestors(identities: readonly CacheDirectoryIdentity[]): Promise<boolean> {
		for (const identity of identities) {
			try {
				const stats = await lstat(identity.path);
				if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== identity.dev || stats.ino !== identity.ino) return false;
			} catch {
				return false;
			}
		}
		return true;
	}

	/** Bounded JSON read from one O_NOFOLLOW descriptor with stable identity. */
	private async readSafeJson<T>(path: string, maxBytes: number): Promise<{
		value: T;
		bytes: number;
		source: FileSourceSnapshot;
	} | null> {
		const ancestors = await this.safeAncestorIdentities(path);
		if (!ancestors) return null;
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		let handle;
		try {
			handle = await open(path, constants.O_RDONLY | noFollow);
		} catch {
			return null;
		}
		try {
			const beforeStats = await handle.stat({ bigint: true });
			if (!beforeStats.isFile()) return null;
			const beforeResult = fileSourceSnapshotFromStats(beforeStats);
			if (!beforeResult.ok || beforeResult.value.fileSize > maxBytes) return null;
			const before = beforeResult.value;
			await this.boundedReadHooks?.afterInitialStat?.(Object.freeze({ ...before }));
			this.boundedReadHooks?.onBufferAllocate?.(before.fileSize);
			const bytes = Buffer.allocUnsafe(before.fileSize);
			this.boundedReadHooks?.beforeRead?.(bytes.length);
			let offset = 0;
			while (offset < bytes.length) {
				const result = await handle.read(bytes, offset, bytes.length - offset, offset);
				if (result.bytesRead <= 0) return null;
				offset += result.bytesRead;
			}
			await this.boundedReadHooks?.afterRead?.(Object.freeze({ ...before }));
			const afterResult = fileSourceSnapshotFromStats(await handle.stat({ bigint: true }));
			if (!afterResult.ok || !sameSourceSnapshot(before, afterResult.value)) return null;
			let lexical;
			try { lexical = await lstat(path); }
			catch { return null; }
			if (!lexical.isFile() || lexical.isSymbolicLink()
				|| before.dev !== lexical.dev || before.ino !== lexical.ino || before.fileSize !== lexical.size) return null;
			if (!(await this.sameSafeAncestors(ancestors))) return null;
			let textValue: string;
			try { textValue = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
			catch { return null; }
			try {
				return { value: JSON.parse(textValue) as T, bytes: bytes.length, source: afterResult.value };
			} catch {
				return null;
			}
		} catch {
			return null;
		} finally {
			await handle.close().catch(() => {});
		}
	}

	private async readLockObservation(path: string): Promise<LockObservation | null> {
		const loaded = await this.readSafeJson<unknown>(path, LOCK_RECORD_MAX_BYTES);
		if (!loaded || !isJsonObject(loaded.value)) return null;
		const token = loaded.value.token;
		const ownerPid = loaded.value.ownerPid;
		const createdAt = loaded.value.createdAt;
		const bootId = loaded.value.bootId;
		const processStartTicks = loaded.value.processStartTicks;
		if (typeof token !== "string" || token.length === 0 || token.length > 256) return null;
		if (!(ownerPid === null || (typeof ownerPid === "number" && Number.isSafeInteger(ownerPid) && ownerPid > 0))) return null;
		if (typeof createdAt !== "string") return null;
		const createdAtMs = Date.parse(createdAt);
		if (!Number.isFinite(createdAtMs)) return null;
		const hasBootId = bootId !== undefined;
		const hasStartTicks = processStartTicks !== undefined;
		if (hasBootId !== hasStartTicks) return null;
		if (hasBootId && (typeof bootId !== "string" || !BOOT_ID_RE.test(bootId)
			|| typeof processStartTicks !== "string" || !PROCESS_START_TICKS_RE.test(processStartTicks))) return null;
		return {
			token,
			ownerPid,
			createdAtMs,
			bootId: hasBootId ? bootId as string : null,
			processStartTicks: hasStartTicks ? processStartTicks as string : null,
			source: loaded.source,
		};
	}

	private sameLockObservation(left: LockObservation, right: LockObservation): boolean {
		return left.token === right.token
			&& left.ownerPid === right.ownerPid
			&& left.createdAtMs === right.createdAtMs
			&& left.bootId === right.bootId
			&& left.processStartTicks === right.processStartTicks
			&& left.source.fileSize === right.source.fileSize
			&& left.source.dev === right.source.dev
			&& left.source.ino === right.source.ino;
	}

	private async currentProcessIdentity(pid = this.pid): Promise<{ bootId: string; processStartTicks: string } | null> {
		try {
			if (!this.isProcessAlive(pid)) return null;
			const [bootId, processStartTicks] = await Promise.all([
				this.readBootId(),
				this.readProcessStartTicks(pid),
			]);
			if (bootId === null || !BOOT_ID_RE.test(bootId)
				|| processStartTicks === null || !PROCESS_START_TICKS_RE.test(processStartTicks)) return null;
			return { bootId, processStartTicks };
		} catch {
			return null;
		}
	}

	private async lockOwnerStatus(observed: LockObservation): Promise<"live" | "dead" | "legacy" | "unproven"> {
		if (observed.ownerPid === null || observed.bootId === null || observed.processStartTicks === null) return "legacy";
		let bootId: string | null;
		try { bootId = await this.readBootId(); }
		catch { return "unproven"; }
		if (bootId === null || !BOOT_ID_RE.test(bootId)) return "unproven";
		if (bootId !== observed.bootId) return "dead";
		try {
			if (!this.isProcessAlive(observed.ownerPid)) return "dead";
		} catch {
			return "unproven";
		}
		let processStartTicks: string | null;
		try { processStartTicks = await this.readProcessStartTicks(observed.ownerPid); }
		catch { return "unproven"; }
		if (processStartTicks === null || !PROCESS_START_TICKS_RE.test(processStartTicks)) return "unproven";
		return processStartTicks === observed.processStartTicks ? "live" : "dead";
	}

	private lockOwnerPath(path: string, token: string): string {
		return `${path}.owner.${createHash("sha256").update(token).digest("hex").slice(0, 24)}`;
	}

	/** Publish only a complete, fsynced owner inode; the fixed path is never written. */
	private async publishLock(path: string, token: string, payload: string): Promise<PublishedLock | null> {
		await this.ensureSafeDirectory(dirname(path));
		const ownerPath = this.lockOwnerPath(path, token);
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		let handle;
		let ownerCreated = false;
		try {
			handle = await open(ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
			ownerCreated = true;
			const bytes = Buffer.from(payload, "utf8");
			let offset = 0;
			while (offset < bytes.length) {
				const written = await handle.write(bytes, offset, bytes.length - offset, offset);
				if (written.bytesWritten <= 0) throw new Error("short cache lock owner write");
				offset += written.bytesWritten;
			}
			await handle.sync();
			await handle.close();
			handle = null;
			await link(ownerPath, path);
			return { ownerPath };
		} catch (error) {
			if (handle) await handle.close().catch(() => {});
			if (ownerCreated) await rm(ownerPath, { force: true }).catch(() => {});
			if (errnoCode(error) === "EEXIST") return null;
			throw error;
		}
	}

	/**
	 * Claim the token-derived owner name while the fixed name remains present.
	 * Only the winner can unlink fixed; losers never touch it, so a replacement
	 * owner cannot be moved aside or exposed through an acquisition gap.
	 */
	private async removeObservedLock(path: string, expected: LockObservation, purpose: string): Promise<boolean> {
		const ownerPath = this.lockOwnerPath(path, expected.token);
		let createdOwnerLink = false;
		try {
			await link(path, ownerPath);
			createdOwnerLink = true; // legacy complete lock upgraded in place
		} catch (error) {
			if (errnoCode(error) !== "EEXIST") return false;
		}
		const owner = await this.readLockObservation(ownerPath);
		if (!owner || !this.sameLockObservation(expected, owner)) {
			if (createdOwnerLink) await rm(ownerPath, { force: true }).catch(() => {});
			return false;
		}
		const claim = `${ownerPath}.${purpose}.${this.pid}.${randomBytes(6).toString("hex")}`;
		try {
			await rename(ownerPath, claim);
		} catch {
			return false;
		}
		const fixed = await this.readLockObservation(path);
		const claimed = await this.readLockObservation(claim);
		if (!fixed || !claimed || !this.sameLockObservation(expected, fixed) || !this.sameLockObservation(expected, claimed)) {
			await rm(claim, { force: true }).catch(() => {});
			return false;
		}
		await rm(path, { force: true });
		await rm(claim, { force: true }).catch(() => {});
		return true;
	}

	private async malformedLockObservation(path: string): Promise<MalformedLockObservation | null> {
		const ancestors = await this.safeAncestorIdentities(path);
		if (!ancestors) return null;
		try {
			const stats = await lstat(path);
			if (!stats.isFile() || stats.isSymbolicLink() || stats.size > LOCK_RECORD_MAX_BYTES
				|| !Number.isSafeInteger(stats.dev) || !Number.isSafeInteger(stats.ino)) return null;
			if (!(await this.sameSafeAncestors(ancestors))) return null;
			return { source: { fileSize: stats.size, dev: stats.dev, ino: stats.ino, mtimeMs: stats.mtimeMs } };
		} catch {
			return null;
		}
	}

	/** Recover a stable old malformed/partial legacy lock without moving fixed. */
	private async recoverMalformedLock(path: string, observed: MalformedLockObservation): Promise<boolean> {
		if (Date.now() - observed.source.mtimeMs <= this.lockStaleMs) return false;
		const ownerPath = `${path}.orphan.${observed.source.dev}.${observed.source.ino}`;
		let created = false;
		try {
			await link(path, ownerPath);
			created = true;
		} catch (error) {
			if (errnoCode(error) !== "EEXIST") return false;
		}
		const ownerStats = await lstat(ownerPath).catch(() => null);
		if (!ownerStats || ownerStats.dev !== observed.source.dev || ownerStats.ino !== observed.source.ino) {
			if (created) await rm(ownerPath, { force: true }).catch(() => {});
			return false;
		}
		const claim = `${ownerPath}.recover.${this.pid}.${randomBytes(6).toString("hex")}`;
		try { await rename(ownerPath, claim); }
		catch { return false; }
		const fixedStats = await lstat(path).catch(() => null);
		if (!fixedStats || fixedStats.dev !== observed.source.dev || fixedStats.ino !== observed.source.ino
			|| fixedStats.size !== observed.source.fileSize || fixedStats.mtimeMs !== observed.source.mtimeMs) {
			await rm(claim, { force: true }).catch(() => {});
			return false;
		}
		await rm(path, { force: true });
		await rm(claim, { force: true }).catch(() => {});
		return true;
	}

	private async acquireIndexMutationLock(): Promise<{ token: string; release: () => Promise<void> }> {
		const path = this.indexLockPath();
		const token = `index-${this.pid}-${randomBytes(8).toString("hex")}`;
		const identity = await this.currentProcessIdentity();
		if (!identity) throw new Error("cache index owner process identity is unavailable");
		const startedAt = Date.now();
		for (;;) {
			try {
				const published = await this.publishLock(
					path,
					token,
					JSON.stringify({
						token,
						ownerPid: this.pid,
						bootId: identity.bootId,
						processStartTicks: identity.processStartTicks,
						createdAt: this.now().toISOString(),
						kind: "cache-index",
					}),
				);
				if (!published) throw Object.assign(new Error("cache index lock occupied"), { code: "EEXIST" });
				return {
					token,
					release: async () => {
						const observed = await this.readLockObservation(path);
						if (observed?.token === token) await this.removeObservedLock(path, observed, "release");
					},
				};
			} catch (error) {
				if (errnoCode(error) !== "EEXIST") throw error;
				const observed = await this.readLockObservation(path);
				if (observed && Date.now() - observed.createdAtMs > this.lockStaleMs) {
					const status = await this.lockOwnerStatus(observed);
					if (status === "dead" || status === "legacy") {
						await this.removeObservedLock(path, observed, "recover");
						continue;
					}
				}
				if (!observed) {
					const malformed = await this.malformedLockObservation(path);
					if (malformed && await this.recoverMalformedLock(path, malformed)) continue;
				}
				if (Date.now() - startedAt > this.indexLockWaitMs) throw new Error("cache index mutation lock wait timed out");
				await sleep(25);
			}
		}
	}

	private async withIndexMutation<T>(operation: () => Promise<T>): Promise<T> {
		const lock = await this.acquireIndexMutationLock();
		try {
			await this.indexMutationHooks?.afterAcquire?.();
			return await operation();
		} finally {
			await lock.release().catch(() => {});
		}
	}

	// ------------------------------------------------------------------
	// Record writes / reads
	// ------------------------------------------------------------------

	/** Atomic record+index transaction; an unindexed record is never lookup-visible. */
	async writeRecord(record: ActionRecord): Promise<{ ok: boolean; error?: string }> {
		try {
			const payload = `${JSON.stringify(record, null, 2)}\n`;
			if (Buffer.byteLength(payload, "utf8") > ACTION_RECORD_MAX_BYTES) {
				return { ok: false, error: "action record exceeds the fixed size limit" };
			}
			await this.withIndexMutation(async () => {
				const index = await this.readIndexUnlocked();
				await this.ensureSafeDirectory(this.actionsDir());
				await this.ensureSafeDirectory(this.tmpDir());
				const tmp = join(this.tmpDir(), `${record.actionKey}.${this.pid}.${randomBytes(4).toString("hex")}.tmp`);
				let published = false;
				try {
					await writeFile(tmp, payload, { mode: 0o600 });
					await rename(tmp, this.actionPath(record.actionKey));
					published = true;
					await this.indexMutationHooks?.afterRecordPublishBeforeIndex?.();
					this.updateIndexEntry(index, record, Buffer.byteLength(payload, "utf8"));
					await this.writeIndexVerified(index);
				} catch (error) {
					await rm(tmp, { force: true }).catch(() => {});
					if (published) await rm(this.actionPath(record.actionKey), { force: true }).catch(() => {});
					throw error;
				}
			});
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
		let before: Awaited<ReturnType<typeof lstat>>;
		try {
			before = await lstat(path);
		} catch (error) {
			return errnoCode(error) === "ENOENT"
				? { record: null, corrupt: false }
				: { record: null, corrupt: true };
		}
		if (!before.isFile() || before.isSymbolicLink()) {
			await this.quarantineAction(key, "non-regular-record");
			return { record: null, corrupt: true };
		}
		const loaded = await this.readSafeJson<unknown>(path, ACTION_RECORD_MAX_BYTES);
		if (!loaded) {
			await this.quarantineAction(key, "bounded-read-rejected");
			return { record: null, corrupt: true };
		}
		let after: Awaited<ReturnType<typeof lstat>>;
		try {
			after = await lstat(path);
		} catch {
			return { record: null, corrupt: true };
		}
		if (!samePathIdentity(before, after, loaded.source)) {
			await this.quarantineAction(key, "path-changed-during-read");
			return { record: null, corrupt: true };
		}
		const record = parseActionRecord(loaded.value, key);
		if (!record) {
			await this.quarantineAction(key, "schema-or-key-mismatch");
			return { record: null, corrupt: true };
		}
		return { record, corrupt: false };
	}

	/** Lookup visibility is defined by strict index membership under the index mutex. */
	async readIndexedRecord(key: string): Promise<{ record: ActionRecord | null; corrupt: boolean }> {
		try {
			return await this.withIndexMutation(async () => {
				const index = await this.readIndexUnlocked();
				if (!index.entries.some((entry) => entry.key === key)) return { record: null, corrupt: false };
				return this.readRecord(key);
			});
		} catch {
			return { record: null, corrupt: true };
		}
	}

	private async quarantineAction(key: string, reason: string): Promise<void> {
		try {
			if (!(await this.safeAncestorIdentities(this.actionPath(key)))) return;
			await this.ensureSafeDirectory(this.tmpDir());
			const target = join(this.tmpDir(), `corrupt-${key}-${reason}-${this.now().toISOString().replace(/[:.]/g, "-")}.json`);
			await rename(this.actionPath(key), target).catch(() => {});
		} catch {
			// quarantine is best-effort
		}
	}

	private updateIndexEntry(index: CacheIndex, record: ActionRecord, sizeBytes: number): void {
		const existing = index.entries.find((entry) => entry.key === record.actionKey);
		const entry: IndexEntry = {
			key: record.actionKey,
			recipe: record.recipe,
			createdAt: existing?.createdAt ?? record.createdAt,
			lastUsedAt: this.now().toISOString(),
			sizeBytes,
			success: record.success,
			mode: record.mode,
		};
		index.entries = index.entries.filter((candidate) => candidate.key !== record.actionKey);
		index.entries.push(entry);
	}

	/** Touch lastUsedAt on a hit (LRU bookkeeping, best-effort). */
	async touch(key: string): Promise<void> {
		try {
			await this.withIndexMutation(async () => {
				const index = await this.readIndexUnlocked();
				const entry = index.entries.find((e) => e.key === key);
				if (!entry) return;
				entry.lastUsedAt = this.now().toISOString();
				await this.writeIndexVerified(index);
			});
		} catch {
			// best-effort
		}
	}

	// ------------------------------------------------------------------
	// Index
	// ------------------------------------------------------------------

	/** Read the index; a corrupted index is rebuilt from actions/. */
	async readIndex(): Promise<CacheIndex> {
		const parsed = await this.readIndexFile();
		if (parsed) return parsed;
		return this.withIndexMutation(() => this.readIndexUnlocked());
	}

	private async readIndexFile(): Promise<CacheIndex | null> {
		const loaded = await this.readSafeJson<unknown>(this.indexPath(), CACHE_INDEX_MAX_BYTES);
		if (!loaded) return null;
		return parseCacheIndex(loaded.value, this.indexRebuildMaxEntries, this.indexRebuildMaxBytes);
	}

	private async readIndexUnlocked(): Promise<CacheIndex> {
		return await this.readIndexFile() ?? this.rebuildIndexUnlocked();
	}

	private async writeIndexRaw(index: CacheIndex): Promise<void> {
		const payload = `${JSON.stringify(index, null, 2)}\n`;
		if (Buffer.byteLength(payload, "utf8") > CACHE_INDEX_MAX_BYTES) {
			throw new Error("cache index exceeds the fixed size limit");
		}
		await this.ensureSafeDirectory(this.cacheDir());
		const tmp = join(this.tmpDir(), `index.${this.pid}.${randomBytes(4).toString("hex")}.tmp`);
		await this.ensureSafeDirectory(this.tmpDir());
		await this.indexMutationHooks?.beforeWrite?.();
		await writeFile(tmp, payload, { mode: 0o600 });
		await rename(tmp, this.indexPath());
	}

	private async writeIndexVerified(index: CacheIndex): Promise<void> {
		await this.writeIndexRaw(index);
		await this.indexMutationHooks?.afterWriteBeforeVerify?.();
		const observed = await this.readIndexFile();
		if (!observed || JSON.stringify(observed) !== JSON.stringify(index)) {
			throw new Error("cache index strict write verification failed");
		}
	}

	/** Rebuild the index by scanning the actions directory. */
	async rebuildIndex(): Promise<CacheIndex> {
		return this.withIndexMutation(() => this.rebuildIndexUnlocked());
	}

	private async rebuildIndexUnlocked(): Promise<CacheIndex> {
		const entries: IndexEntry[] = [];
		let actionDirectory;
		try {
			const stats = await lstat(this.actionsDir());
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				throw new ActionCacheIndexRebuildError("actions index source is not a real directory");
			}
			actionDirectory = await opendir(this.actionsDir());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				const empty: CacheIndex = { schemaVersion: CACHE_INDEX_SCHEMA_VERSION, entries: [] };
				await this.writeIndexVerified(empty);
				return empty;
			}
			if (error instanceof ActionCacheIndexRebuildError) throw error;
			throw new ActionCacheIndexRebuildError(`actions index source cannot be opened: ${(error as Error).message}`);
		}
		const names: string[] = [];
		for await (const directoryEntry of actionDirectory) {
			if (names.length >= this.indexRebuildMaxEntries) {
				throw new ActionCacheIndexRebuildError(
					`actions index rebuild exceeds the ${this.indexRebuildMaxEntries}-entry scan limit`,
				);
			}
			names.push(directoryEntry.name);
			if (/^[0-9a-f]{64}\.json$/.test(directoryEntry.name) && !directoryEntry.isFile()) {
				throw new ActionCacheIndexRebuildError(`actions index source contains an unsafe record entry: ${directoryEntry.name}`);
			}
		}
		let totalRecordBytes = 0;
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const key = name.slice(0, -".json".length);
			if (!SHA256_RE.test(key)) continue;
			try {
				const loaded = await this.readSafeJson<unknown>(this.actionPath(key), ACTION_RECORD_MAX_BYTES);
				if (!loaded) continue;
				totalRecordBytes += loaded.bytes;
				if (totalRecordBytes > this.indexRebuildMaxBytes) {
					throw new ActionCacheIndexRebuildError(
						`actions index rebuild exceeds the ${this.indexRebuildMaxBytes}-byte record scan limit`,
					);
				}
				const record = parseActionRecord(loaded.value, key);
				if (!record) continue;
				entries.push({
					key,
					recipe: record.recipe,
					createdAt: record.createdAt,
					lastUsedAt: record.createdAt,
					sizeBytes: loaded.bytes,
					success: record.success,
					mode: record.mode,
				});
			} catch (error) {
				if (error instanceof ActionCacheIndexRebuildError) throw error;
				// corrupted record: leave it for readRecord to quarantine
			}
		}
		entries.sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : 0));
		const index: CacheIndex = { schemaVersion: CACHE_INDEX_SCHEMA_VERSION, entries };
		await this.writeIndexVerified(index);
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
		const identity = await this.currentProcessIdentity();
		if (!identity) return null;
		const startedAt = Date.now();
		for (;;) {
			try {
				const published = await this.publishLock(
					path,
					token,
					JSON.stringify({
						key,
						token,
						ownerPid: this.pid,
						bootId: identity.bootId,
						processStartTicks: identity.processStartTicks,
						createdAt: this.now().toISOString(),
					}),
				);
				if (!published) throw Object.assign(new Error("cache key lock occupied"), { code: "EEXIST" });
				return {
					key,
					token,
					release: async () => {
						const observed = await this.readLockObservation(path);
						if (observed?.token === token) await this.removeObservedLock(path, observed, "release");
					},
				};
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") return null;
				// Existing lock: check staleness.
				const stale = await this.staleLockObservation(path);
				if (stale) {
					await this.afterStaleLockObserved?.();
					await this.removeObservedLock(path, stale, "recover");
					continue;
				}
				const observed = await this.readLockObservation(path);
				if (!observed) {
					const malformed = await this.malformedLockObservation(path);
					if (malformed && await this.recoverMalformedLock(path, malformed)) continue;
				}
				if (Date.now() - startedAt > this.lockWaitMs) return null;
				await sleep(100);
			}
		}
	}

	private async staleLockObservation(path: string): Promise<LockObservation | null> {
		try {
			const observed = await this.readLockObservation(path);
			if (!observed) return null;
			if (Date.now() - observed.createdAtMs <= this.lockStaleMs) return null;
			const status = await this.lockOwnerStatus(observed);
			// Exact current process incarnation is never stale. Unavailable
			// identity is fail-closed; only proven-dead or legacy stale owners
			// enter the token/inode recovery protocol.
			return status === "dead" || status === "legacy" ? observed : null;
		} catch {
			return null;
		}
	}

	/** True when a fresh lock exists for a key (used by prune safety). */
	async hasFreshLock(key: string): Promise<boolean> {
		const path = this.lockPath(key);
		try {
			await lstat(path);
		} catch (error) {
			return errnoCode(error) !== "ENOENT";
		}
		return (await this.staleLockObservation(path)) === null;
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
		return this.withIndexMutation(async () => {
			const maxBytes = options.maxBytes ?? this.maxBytes;
			const index = await this.readIndexUnlocked();
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
				const actuallyRemoved: IndexEntry[] = [];
				let removalError: Error | null = null;
				for (const entry of removed) {
					try {
						await rm(this.actionPath(entry.key));
						actuallyRemoved.push(entry);
					} catch (error) {
						if (errnoCode(error) === "ENOENT") actuallyRemoved.push(entry);
						else removalError ??= error as Error;
					}
				}
				if (actuallyRemoved.length > 0) {
					index.entries = index.entries.filter((entry) => !actuallyRemoved.some((removedEntry) => removedEntry.key === entry.key));
					await this.writeIndexVerified(index);
				}
				if (removalError) throw new Error(`cache prune could not remove every selected record: ${removalError.message}`);
			}
			return {
				dryRun: !options.apply,
				reclaimableBytes: removed.reduce((sum, e) => sum + e.sizeBytes, 0),
				keptBytes: Math.max(0, total),
				totalBytes: total + removed.reduce((sum, e) => sum + e.sizeBytes, 0),
				removed,
				skippedInUse,
			};
		});
	}

	/** Clear records for one recipe or all. Never touches runs/evidence. */
	async clear(target: string): Promise<{ removed: number; recipe: string | "all" }> {
		return this.withIndexMutation(async () => {
			const index = await this.readIndexUnlocked();
			const removed = index.entries.filter((e) => target === "all" || e.recipe === target);
			const actuallyRemoved: IndexEntry[] = [];
			let removalError: Error | null = null;
			for (const entry of removed) {
				try {
					await rm(this.actionPath(entry.key));
					actuallyRemoved.push(entry);
				} catch (error) {
					if (errnoCode(error) === "ENOENT") actuallyRemoved.push(entry);
					else removalError ??= error as Error;
				}
			}
			if (actuallyRemoved.length > 0) {
				index.entries = index.entries.filter((entry) => !actuallyRemoved.some((removedEntry) => removedEntry.key === entry.key));
				await this.writeIndexVerified(index);
			}
			if (removalError) throw new Error(`cache clear could not remove every selected record: ${removalError.message}`);
			return { removed: actuallyRemoved.length, recipe: target };
		});
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function defaultReadBootId(): Promise<string | null> {
	try {
		const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
		return BOOT_ID_RE.test(value) ? value : null;
	} catch {
		return null;
	}
}

async function defaultReadProcessStartTicks(pid: number): Promise<string | null> {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		const raw = await readFile(`/proc/${pid}/stat`, "utf8");
		const commandEnd = raw.lastIndexOf(")");
		if (commandEnd < 0) return null;
		const fieldsAfterCommand = raw.slice(commandEnd + 1).trim().split(/\s+/);
		const startTicks = fieldsAfterCommand[19];
		return startTicks !== undefined && PROCESS_START_TICKS_RE.test(startTicks) ? startTicks : null;
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
