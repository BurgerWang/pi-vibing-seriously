/**
 * Atomic run-directory publication.
 *
 * Writers build the complete run under a hidden staging directory, write and
 * strictly re-read a content inventory, then publish the directory with one
 * rename. Consumers that need authority use readCommittedRunTransaction(); a
 * visible manifest without a valid commit record is diagnostic data only.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { runsDir } from "./config.ts";
import { isValidRunId, parseCommittedRunManifestV2, type RunRecord } from "./runs.ts";

export const RUN_TRANSACTION_SCHEMA_VERSION = 2 as const;
export const RUN_COMMIT_FILE = "run-commit.json" as const;
export const RUN_TRANSACTION_MAX_FILES = 10_000 as const;
export const RUN_COMMIT_MAX_BYTES = 4 * 1024 * 1024;
export const RUN_MANIFEST_MAX_BYTES = 1024 * 1024;
const REQUIRED_RUN_FILES = ["command.json", "environment.json", "manifest.json", "stderr.log", "stdout.log", "summary.json"] as const;

export interface RunCommittedFileV2 {
	path: string;
	bytes: number;
	sha256: string;
}

export interface RunCommitRecordV2 {
	schema_version: 2;
	run_id: string;
	committed_at: string;
	files: RunCommittedFileV2[];
}

export interface RunTransactionPaths {
	runId: string;
	stagingDir: string;
	finalDir: string;
}

export type RunTransactionReadResult =
	| { ok: true; record: RunCommitRecordV2; runDir: string }
	| { ok: false; code: "not_found" | "partial" | "invalid" | "identity_failed" };

const HASH_RE = /^[0-9a-f]{64}$/;

function canonicalRelativePath(path: string): boolean {
	return path.length > 0 && path.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(path) && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => part.length === 0 || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255);
}

function byteCompare(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

async function hashRegularFile(path: string): Promise<{ bytes: number; sha256: string } | null> {
	let handle;
	try {
		handle = await open(path, "r");
		const before = await handle.stat({ bigint: true });
		if (!before.isFile()) return null;
		const hash = createHash("sha256");
		let bytes = 0;
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (;;) {
			const read = await handle.read(buffer, 0, buffer.length, null);
			if (read.bytesRead === 0) break;
			hash.update(buffer.subarray(0, read.bytesRead));
			bytes += read.bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			BigInt(bytes) !== after.size
		) return null;
		return { bytes, sha256: hash.digest("hex") };
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function inventory(directory: string): Promise<RunCommittedFileV2[] | null> {
	const out: RunCommittedFileV2[] = [];
	const walk = async (current: string): Promise<boolean> => {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const entry of entries) {
			if (out.length >= RUN_TRANSACTION_MAX_FILES) return false;
			const absolute = join(current, entry.name);
			const rel = relative(directory, absolute).split(sep).join("/");
			if (!canonicalRelativePath(rel) || entry.isSymbolicLink()) return false;
			if (rel === RUN_COMMIT_FILE) continue;
			if (entry.isDirectory()) {
				if (!(await walk(absolute))) return false;
				continue;
			}
			if (!entry.isFile()) return false;
			const identity = await hashRegularFile(absolute);
			if (!identity) return false;
			out.push({ path: rel, ...identity });
		}
		return true;
	};
	if (!(await walk(directory))) return null;
	out.sort((a, b) => byteCompare(a.path, b.path));
	return out;
}

function parseCommit(value: unknown, expectedRunId: string): RunCommitRecordV2 | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).sort().join(",") !== "committed_at,files,run_id,schema_version") return null;
	if (raw.schema_version !== RUN_TRANSACTION_SCHEMA_VERSION || raw.run_id !== expectedRunId) return null;
	if (typeof raw.committed_at !== "string" || !Number.isFinite(Date.parse(raw.committed_at))) return null;
	if (!Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > RUN_TRANSACTION_MAX_FILES) return null;
	const files: RunCommittedFileV2[] = [];
	let prior: string | null = null;
	for (const item of raw.files) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
		const entry = item as Record<string, unknown>;
		if (Object.keys(entry).sort().join(",") !== "bytes,path,sha256") return null;
		if (typeof entry.path !== "string" || !canonicalRelativePath(entry.path) || entry.path === RUN_COMMIT_FILE) return null;
		if (prior !== null && byteCompare(prior, entry.path) >= 0) return null;
		if (typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return null;
		if (typeof entry.sha256 !== "string" || !HASH_RE.test(entry.sha256)) return null;
		files.push({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
		prior = entry.path;
	}
	if (!files.some((entry) => entry.path === "manifest.json")) return null;
	return { schema_version: 2, run_id: expectedRunId, committed_at: raw.committed_at, files };
}

export async function beginRunTransaction(projectRoot: string, runId: string): Promise<RunTransactionPaths> {
	if (!isValidRunId(runId)) throw new Error("invalid run id");
	const root = runsDir(projectRoot);
	await mkdir(root, { recursive: true });
	const finalDir = join(root, runId);
	try {
		await lstat(finalDir);
		throw new Error("run id already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const token = randomBytes(12).toString("hex");
	const stagingDir = join(root, `.${runId}.staging-${token}`);
	await mkdir(stagingDir, { recursive: false, mode: 0o700 });
	return { runId, stagingDir, finalDir };
}

export async function commitRunTransaction(transaction: RunTransactionPaths, committedAt: Date): Promise<RunCommitRecordV2> {
	const files = await inventory(transaction.stagingDir);
	if (!files) throw new Error("RUN_RECORD_COMMIT_FAILED: staging inventory invalid");
	for (const required of REQUIRED_RUN_FILES) {
		if (!files.some((entry) => entry.path === required)) throw new Error(`RUN_RECORD_COMMIT_FAILED: missing ${required}`);
	}
	const manifestEntry = files.find((entry) => entry.path === "manifest.json")!;
	if (manifestEntry.bytes <= 0 || manifestEntry.bytes > RUN_MANIFEST_MAX_BYTES) throw new Error("RUN_RECORD_COMMIT_FAILED: manifest size invalid");
	let manifest: RunRecord;
	try {
		const rawManifest = JSON.parse(await readFile(join(transaction.stagingDir, "manifest.json"), "utf8")) as unknown;
		const parsed = parseCommittedRunManifestV2(rawManifest, transaction.runId);
		if (!parsed) throw new Error("invalid");
		manifest = parsed;
	} catch {
		throw new Error("RUN_RECORD_COMMIT_FAILED: manifest readback invalid");
	}
	if (manifest.recipe === "gate") {
		const gatesEntry = files.find((entry) => entry.path === "gates.json");
		const evidenceEntry = files.find((entry) => entry.path === "evidence.json");
		const { GATE_AUTHORITY_RECORD_MAX_BYTES, validatePersistedGateRunRecords } = await import("./gate-engine.ts");
		if (!gatesEntry || !evidenceEntry
			|| gatesEntry.bytes <= 0 || gatesEntry.bytes > GATE_AUTHORITY_RECORD_MAX_BYTES
			|| evidenceEntry.bytes <= 0 || evidenceEntry.bytes > GATE_AUTHORITY_RECORD_MAX_BYTES) {
			throw new Error("RUN_RECORD_COMMIT_FAILED: gate authority files missing or oversized");
		}
		try {
			const gates = JSON.parse(await readFile(join(transaction.stagingDir, "gates.json"), "utf8")) as unknown;
			const evidence = JSON.parse(await readFile(join(transaction.stagingDir, "evidence.json"), "utf8")) as unknown;
			if (!validatePersistedGateRunRecords(transaction.runId, manifest, gates, evidence)) throw new Error("invalid");
		} catch {
			throw new Error("RUN_RECORD_COMMIT_FAILED: gate authority readback invalid");
		}
	}
	const record: RunCommitRecordV2 = {
		schema_version: RUN_TRANSACTION_SCHEMA_VERSION,
		run_id: transaction.runId,
		committed_at: committedAt.toISOString(),
		files,
	};
	const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
	if (bytes.length > RUN_COMMIT_MAX_BYTES) throw new Error("RUN_RECORD_COMMIT_FAILED: commit record oversized");
	const commitPath = join(transaction.stagingDir, RUN_COMMIT_FILE);
	const handle = await open(commitPath, "wx", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	const reread = await readFile(commitPath);
	if (reread.length !== bytes.length || !reread.equals(bytes) || !parseCommit(JSON.parse(reread.toString("utf8")), transaction.runId)) {
		throw new Error("RUN_RECORD_COMMIT_FAILED: commit record readback invalid");
	}
	await rename(transaction.stagingDir, transaction.finalDir);
	return record;
}

export async function readCommittedRunTransaction(projectRoot: string, runId: string): Promise<RunTransactionReadResult> {
	if (!isValidRunId(runId)) return { ok: false, code: "invalid" };
	const runDir = join(runsDir(projectRoot), runId);
	let dirStats;
	try {
		dirStats = await lstat(runDir);
	} catch (error) {
		return { ok: false, code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "invalid" };
	}
	if (!dirStats.isDirectory() || dirStats.isSymbolicLink()) return { ok: false, code: "invalid" };
	let raw: Buffer;
	try {
		const commitStats = await lstat(join(runDir, RUN_COMMIT_FILE));
		if (!commitStats.isFile() || commitStats.isSymbolicLink() || commitStats.size <= 0 || commitStats.size > RUN_COMMIT_MAX_BYTES) return { ok: false, code: "partial" };
		raw = await readFile(join(runDir, RUN_COMMIT_FILE));
	} catch {
		return { ok: false, code: "partial" };
	}
	let record: RunCommitRecordV2 | null = null;
	try {
		record = parseCommit(JSON.parse(raw.toString("utf8")), runId);
	} catch {
		return { ok: false, code: "invalid" };
	}
	if (!record) return { ok: false, code: "invalid" };
	const canonical = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
	if (!raw.equals(canonical)) return { ok: false, code: "invalid" };
	const current = await inventory(runDir);
	if (!current || current.length !== record.files.length) return { ok: false, code: "identity_failed" };
	for (let index = 0; index < current.length; index += 1) {
		const actual = current[index]!;
		const expected = record.files[index]!;
		if (actual.path !== expected.path || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
			return { ok: false, code: "identity_failed" };
		}
	}
	return { ok: true, record, runDir };
}

export function runCommitFileFor(projectRoot: string, runId: string): string {
	return join(runsDir(projectRoot), runId, RUN_COMMIT_FILE);
}
