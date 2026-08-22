/**
 * Durable storage for delegation transaction v2.
 *
 * The state machine remains pure in delegation-transaction.ts. This module
 * serializes every lifecycle mutation behind a per-delegation exclusive lock
 * and publishes immutable committed generations before it publishes a
 * terminal transaction state.
 */

import { createHash, randomBytes } from "node:crypto";
import { open, lstat, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	abortDelegationTransaction,
	beginDelegationCommit,
	createPreparedDelegationTransaction,
	DELEGATION_COMMITTED_RECORD_NAMES,
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
	DELEGATION_TRANSACTION_MAX_BYTES,
	DELEGATION_TRANSACTION_SCHEMA_VERSION,
	delegationCommitMarker,
	delegationPathAllowedV2,
	parseDelegationTransaction,
	publishDelegationCommit,
	requireDelegationRecovery,
	reviewDelegationTransaction,
	serializeDelegationTransaction,
	startDelegationTransaction,
	type BeginDelegationCommitInput,
	type DelegationCasInput,
	type DelegationCommittedGenerationProof,
	type DelegationCommittedRecordName,
	type DelegationTransactionRecord,
	type DelegationWorkerIdentity,
	type PrepareDelegationTransactionInput,
	type ReviewDelegationTransactionInput,
	type StopDelegationTransactionInput,
} from "./delegation-transaction.ts";
import {
	REVIEW_RECORD_MAX_BYTES,
	type ReviewPatchEntry,
	type ReviewRecord,
} from "./diff-review.ts";
import { computeDiffHash } from "./delegation-ledger.ts";
import { DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2 } from "./delegation-workspace-v2.ts";
import {
	computeReviewRelevanceProjectionHashV2,
	REVIEW_RELEVANCE_KIND_V2,
	validateReviewRelevanceBindingV2,
	validateReviewRelevanceProjectionV2,
} from "./review-relevance-v2.ts";
import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import { validateWorkspaceGuard, type WorkspaceGuardRecord } from "./workspace-guard.ts";
import {
	validateWorkerWriteJournalRecord,
	WRITE_JOURNAL_MAX_SERIALIZED_BYTES,
	type WorkerWriteJournalRecord,
} from "./write-journal.ts";

export const DELEGATION_TRANSACTION_RECORD_MAX_BYTES = 1_048_576 as const;
/** Scope embeds the bounded journal plus a bounded ChangeSet and envelope. */
export const DELEGATION_TRANSACTION_SCOPE_RECORD_MAX_BYTES =
	WRITE_JOURNAL_MAX_SERIALIZED_BYTES + (4 * DELEGATION_TRANSACTION_RECORD_MAX_BYTES);
export const DELEGATION_TRANSACTION_REPORT_MAX_BYTES = 524_288 as const;
export const DELEGATION_TRANSACTION_MARKER_MAX_BYTES = 32_768 as const;
export const DELEGATION_TRANSACTION_LOCK_MAX_BYTES = 4_096 as const;
export const DELEGATION_TRANSACTION_LOCK_RECOVERY_ATTEMPTS = 2 as const;

const COMMIT_MARKER_FILE = "commit-marker.json";
const TRANSACTION_FILE = "transaction.json";
const LOCK_FILE = "transaction.lock";
const REVIEW_FILE = "review.json";

export const DELEGATION_TRANSACTION_STORAGE_FAULT_POINTS = [
	"layout.mkdir",
	"lock.acquire",
	"lock.owner.write",
	"lock.owner.read",
	"lock.recover.rename",
	"lock.release.owner.rename",
	"lock.release.owner.read",
	"lock.release.owner.unlink",
	"state.read",
	"state.temp.write",
	"state.temp.read",
	"state.rename",
	"generation.mkdir",
	"generation.staging.mkdir",
	...DELEGATION_COMMITTED_RECORD_NAMES.flatMap((name) => [
		`generation.record.${name}.write`,
		`generation.record.${name}.read`,
	] as const),
	"generation.marker.write",
	"generation.marker.read",
	"generation.inventory.read",
	"generation.rename",
	"publish_state.temp.write",
	"publish_state.temp.read",
	"publish_state.rename",
] as const;

export const DELEGATION_REVIEW_STORAGE_FAULT_POINTS = [
	"review.temp.write",
	"review.temp.read",
	"review.rename",
	"review.final.read",
	"review_state.temp.write",
	"review_state.temp.read",
	"review_state.rename",
] as const;

export type DelegationTransactionStorageFaultPoint =
	| (typeof DELEGATION_TRANSACTION_STORAGE_FAULT_POINTS)[number]
	| (typeof DELEGATION_REVIEW_STORAGE_FAULT_POINTS)[number];

export interface DelegationStorageEntry {
	name: string;
	kind: "file" | "directory" | "symlink" | "other";
}

export interface DelegationStorageStat {
	kind: "file" | "directory" | "symlink" | "other";
	size: number;
	/** Present for the Node adapter; omitted adapters fail closed for legacy reboot proof. */
	mtime_ms?: number;
}

export interface DelegationTransactionStorageAdapter {
	makeDirectory(path: string, exclusive: boolean): Promise<void>;
	write(path: string, bytes: Uint8Array, exclusive: boolean): Promise<void>;
	readBounded(path: string, maxBytes: number): Promise<Uint8Array>;
	move(source: string, destination: string): Promise<void>;
	list(path: string): Promise<DelegationStorageEntry[]>;
	inspect(path: string): Promise<DelegationStorageStat>;
	removeFile(path: string): Promise<void>;
	randomToken(): string;
	processId: number;
	isProcessAlive(processId: number): boolean;
	fault?(point: DelegationTransactionStorageFaultPoint, bytes?: Readonly<Uint8Array>):
		void | Uint8Array | Promise<void | Uint8Array>;
}

function kindOf(stats: Awaited<ReturnType<typeof lstat>>): DelegationStorageStat["kind"] {
	if (stats.isSymbolicLink()) return "symlink";
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	return "other";
}

async function nodeReadBounded(path: string, maxBytes: number): Promise<Uint8Array> {
	const handle = await open(path, "r");
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || before.size < 0n || before.size > BigInt(maxBytes)) throw new Error("unsafe bounded record");
		const size = Number(before.size);
		const buffer = Buffer.allocUnsafe(size);
		let offset = 0;
		while (offset < size) {
			const result = await handle.read(buffer, offset, size - offset, offset);
			if (result.bytesRead <= 0) throw new Error("short bounded read");
			offset += result.bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		if (!after.isFile() || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
			after.dev !== before.dev || after.ino !== before.ino) throw new Error("record changed during read");
		return buffer;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** Default production adapter: Node filesystem only, no shell or argv. */
export function createNodeDelegationTransactionStorageAdapter(
	fault?: DelegationTransactionStorageAdapter["fault"],
): DelegationTransactionStorageAdapter {
	return {
		async makeDirectory(path, exclusive) {
			await mkdir(path, exclusive ? { mode: 0o700 } : { recursive: true, mode: 0o700 });
		},
		async write(path, bytes, exclusive) {
			await writeFile(path, bytes, { flag: exclusive ? "wx" : "w", mode: 0o600 });
		},
		readBounded: nodeReadBounded,
		move: rename,
		async list(path) {
			const entries = await readdir(path, { withFileTypes: true });
			return entries.map((entry) => ({
				name: entry.name,
				kind: entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
			}));
		},
		async inspect(path) {
			const stats = await lstat(path);
			return { kind: kindOf(stats), size: Number(stats.size), mtime_ms: stats.mtimeMs };
		},
		removeFile: unlink,
		randomToken: () => randomBytes(16).toString("hex"),
		processId: process.pid,
		isProcessAlive(processId) {
			if (!Number.isSafeInteger(processId) || processId <= 0) return false;
			try {
				process.kill(processId, 0);
				return true;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "EPERM";
			}
		},
		fault,
	};
}

export type DelegationTransactionStorageErrorCode =
	| "conflict"
	| "invalid_input"
	| "invalid_record"
	| "not_found"
	| "storage_failure"
	| "unsupported_version";

export interface DelegationTransactionStorageError {
	code: DelegationTransactionStorageErrorCode;
	message: string;
	point?: DelegationTransactionStorageFaultPoint;
}

export type DelegationTransactionStorageResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: DelegationTransactionStorageError };

export interface DelegationCommittedRecords {
	"after.json": unknown;
	"before.json": unknown;
	"identity.json": unknown;
	"review.json": unknown;
	"scope.json": unknown;
	"usage.json": unknown;
	"worker-report.md": string;
	"worker-summary.json": unknown;
}

export interface CommitDelegationGenerationInput extends DelegationCasInput {
	records: DelegationCommittedRecords;
}

export interface DelegationGenerationInventory {
	directory: string;
	record_names: string[];
	proof: DelegationCommittedGenerationProof;
}

export interface DelegationCommittedGenerationV2 {
	state: DelegationTransactionRecord;
	records: DelegationCommittedRecords;
	inventory: DelegationGenerationInventory;
	proof: DelegationCommittedGenerationProof;
}

export interface DelegationReviewArtifactV2 {
	schema_version: 2;
	delegation_id: string;
	task_kind: "implementation";
	contract_hash: string;
	worker_identity: DelegationWorkerIdentity;
	generation: number;
	transaction_revision: 3;
	reviewed_at: string;
	review: ReviewRecord;
}

export interface DelegationReviewAuthorityV2 {
	state: DelegationTransactionRecord;
	artifact: DelegationReviewArtifactV2;
	review: ReviewRecord;
	review_hash: string;
	review_path: string;
	finalized: boolean;
}

export interface PublishDelegationReviewV2Input extends DelegationCasInput {
	artifact: DelegationReviewArtifactV2;
}

interface DelegationLockOwner {
	schema_version: 1;
	delegation_id: string;
	token: string;
	process_id: number;
	created_at: string;
}

interface HeldLock {
	path: string;
	token: string;
}

const LOCK_FIELDS = ["schema_version", "delegation_id", "token", "process_id", "created_at"] as const;
const IDENTITY_RECORD_FIELDS = [
	"schema_version", "delegation_id", "task_kind", "contract_hash", "generation", "revision", "worker_identity",
] as const;
const SCOPE_RECORD_FIELDS = [
	"schema_version", "delegation_id", "task_kind", "contract_hash", "allowed_paths", "changed_paths",
	"write_journal", "change_set",
] as const;
const BEFORE_RECORD_FIELDS = [
	"schema_version", "delegation_id", "recorded_at", "contract", "git_head", "git_dirty", "diff_hash",
	"changed_paths", "path_statuses", "path_digests", "workspace_guard",
] as const;
const BEFORE_RECORD_FIELDS_GUARD_V2 = [...BEFORE_RECORD_FIELDS, "diff_identity_kind"] as const;
const AFTER_RECORD_FIELDS = [
	"schema_version", "delegation_id", "recorded_at", "status", "exit_code", "pinned_identity", "git_head",
	"git_dirty", "diff_hash", "changed_paths", "path_statuses", "path_digests", "changed_since_before",
	"workspace_guard", "change_set_status", "worker_delta_hash", "workspace_guard_hash", "change_set_hash",
	"reported_paths", "usage", "budget", "report_summary", "review_status",
] as const;
const AFTER_RECORD_FIELDS_GUARD_V2 = [...AFTER_RECORD_FIELDS, "diff_identity_kind"] as const;
const REVIEW_ARTIFACT_FIELDS = [
	"schema_version", "delegation_id", "task_kind", "contract_hash", "worker_identity",
	"generation", "transaction_revision", "reviewed_at", "review",
] as const;
const REVIEW_RECORD_FIELDS = [
	"schema_version", "delegation_id", "reviewed_at", "verdict", "bound_diff_hash",
	"recorded_after_hash", "mismatch", "drift_paths", "violations", "allowed_paths",
	"checked_paths", "include_paths", "patch", "patch_truncated", "patch_paths", "notes",
	"displayed_paths", "remaining_paths", "coverage_complete", "review_path",
] as const;
const REVIEW_RECORD_FIELDS_RELEVANCE_V2 = [
	...REVIEW_RECORD_FIELDS, "diff_identity_kind", "relevance_binding", "relevance_projection",
] as const;

function failure<T>(
	code: DelegationTransactionStorageErrorCode,
	message: string,
	point?: DelegationTransactionStorageFaultPoint,
): DelegationTransactionStorageResult<T> {
	return { ok: false, error: { code, message: message.slice(0, 240), ...(point === undefined ? {} : { point }) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...fields].sort();
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function isCanonicalTime(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 20 || value.length > 32) return false;
	try { return new Date(value).toISOString() === value; } catch { return false; }
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function encodeJson(value: unknown, maxBytes: number): Uint8Array | undefined {
	try {
		const encoded = `${JSON.stringify(value, null, 2)}\n`;
		const bytes = Buffer.from(encoded, "utf8");
		return bytes.length <= maxBytes ? bytes : undefined;
	} catch {
		return undefined;
	}
}

function decodeJson(bytes: Uint8Array): unknown | undefined {
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function sameJson(left: unknown, right: unknown): boolean {
	try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function sameIdentity(left: DelegationWorkerIdentity, right: DelegationWorkerIdentity): boolean {
	return left.provider === right.provider && left.model === right.model && left.worker_id === right.worker_id;
}

function committedRecordMaxBytes(name: DelegationCommittedRecordName): number {
	if (name === "worker-report.md") return DELEGATION_TRANSACTION_REPORT_MAX_BYTES;
	return name === "scope.json" ? DELEGATION_TRANSACTION_SCOPE_RECORD_MAX_BYTES : DELEGATION_TRANSACTION_RECORD_MAX_BYTES;
}

function workerDeltaPaths(changeSet: Readonly<ChangeSetRecord>): string[] {
	return changeSet.worker_delta.map((entry) => entry.path);
}

function generationName(generation: number): string | undefined {
	return Number.isSafeInteger(generation) && generation > 0 && generation <= 99_999_999
		? `g${String(generation).padStart(8, "0")}`
		: undefined;
}

function isStrictReviewPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 400 || value !== value.trim() ||
		value.includes("\\") || value.includes("\0")) return false;
	const normalized = posix.normalize(value);
	return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && !normalized.startsWith("/");
}

function validReviewPaths(value: unknown, max = 500, sorted = false): value is string[] {
	if (!Array.isArray(value) || value.length > max || !value.every(isStrictReviewPath)) return false;
	const strings = value as string[];
	if (new Set(strings).size !== strings.length) return false;
	return !sorted || strings.every((path, index) => index === 0 || strings[index - 1]! < path);
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function validByteSortedPaths(value: unknown, max = 500): value is string[] {
	return validReviewPaths(value, max) && value.every((path, index) => index === 0 || byteCompare(value[index - 1]!, path) < 0);
}

function samePathSetByte(left: readonly string[], right: readonly string[]): boolean {
	const leftSorted = [...left].sort(byteCompare);
	const rightSorted = [...right].sort(byteCompare);
	return sameJson(leftSorted, rightSorted);
}

function validReviewPatchEntry(value: unknown): value is ReviewPatchEntry {
	if (!isRecord(value)) return false;
	const hasCompact = Object.prototype.hasOwnProperty.call(value, "compact");
	if (!exactFields(value, hasCompact ? ["path", "source", "text", "truncated", "compact"] : ["path", "source", "text", "truncated"])) return false;
	if (!isStrictReviewPath(value.path) || !["git-diff", "file-content", "deleted", "compact", "withheld"].includes(String(value.source)) ||
		typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > REVIEW_RECORD_MAX_BYTES || typeof value.truncated !== "boolean") return false;
	if ((value.source === "compact") !== hasCompact) return false;
	if (!hasCompact) return true;
	const compact = value.compact;
	if (!isRecord(compact) || !exactFields(compact, [
		"git_status", "size_bytes", "digest", "digest_kind", "digest_max_bytes", "digest_matches_after",
		"generator_equality", "head_preview", "tail_preview", "head_lines", "tail_lines", "head_partial_line",
		"tail_partial_line", "head_bytes", "tail_bytes", "content_truncated",
	])) return false;
	return typeof compact.git_status === "string" && compact.git_status.length <= 4 &&
		Number.isSafeInteger(compact.size_bytes) && Number(compact.size_bytes) >= 0 &&
		typeof compact.digest === "string" && /^[a-f0-9]{64}(?::\d+)?$/.test(compact.digest) &&
		(compact.digest_kind === "sha256" || compact.digest_kind === "sha256-prefix+size") &&
		Number.isSafeInteger(compact.digest_max_bytes) && Number(compact.digest_max_bytes) > 0 &&
		typeof compact.digest_matches_after === "boolean" && compact.generator_equality === "NOT_VERIFIED" &&
		typeof compact.head_preview === "string" && typeof compact.tail_preview === "string" &&
		[compact.head_lines, compact.tail_lines, compact.head_bytes, compact.tail_bytes].every((item) => Number.isSafeInteger(item) && Number(item) >= 0) &&
		typeof compact.head_partial_line === "boolean" && typeof compact.tail_partial_line === "boolean" &&
		typeof compact.content_truncated === "boolean";
}

function validReviewRecordForState(value: unknown, state: DelegationTransactionRecord): value is ReviewRecord {
	if (!isRecord(value)) return false;
	const relevanceV2 = value.schema_version === 2;
	if (!(relevanceV2 ? exactFields(value, REVIEW_RECORD_FIELDS_RELEVANCE_V2) : exactFields(value, REVIEW_RECORD_FIELDS))) return false;
	if ((value.schema_version !== 1 && !relevanceV2) || value.delegation_id !== state.delegation_id || !isCanonicalTime(value.reviewed_at) ||
		(value.verdict !== "PASS" && value.verdict !== "FAIL") ||
		typeof value.bound_diff_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(value.bound_diff_hash) ||
		typeof value.recorded_after_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(value.recorded_after_hash) ||
		typeof value.mismatch !== "boolean" || value.mismatch !== (value.bound_diff_hash !== value.recorded_after_hash) ||
		typeof value.patch_truncated !== "boolean" || typeof value.coverage_complete !== "boolean") return false;
	if (!validReviewPaths(value.drift_paths) || !validReviewPaths(value.allowed_paths, 50) ||
		!validByteSortedPaths(value.checked_paths, 500) || !validReviewPaths(value.include_paths, 50) ||
		!validByteSortedPaths(value.displayed_paths, 500) || !validByteSortedPaths(value.remaining_paths, 500)) return false;
	if (relevanceV2 && (value.diff_identity_kind !== REVIEW_RELEVANCE_KIND_V2 ||
		!validateReviewRelevanceBindingV2(value.relevance_binding) ||
		!validateReviewRelevanceProjectionV2(value.relevance_projection) ||
		value.relevance_binding.projection_hash !== computeReviewRelevanceProjectionHashV2(value.relevance_projection) ||
		value.bound_diff_hash !== value.relevance_binding.projection_hash ||
		value.relevance_projection.delegation_id !== state.delegation_id ||
		value.relevance_projection.contract_hash !== state.contract_hash)) return false;
	if (!sameJson(value.allowed_paths, state.allowed_paths) || state.terminal_outcome === null ||
		!sameJson(value.checked_paths, state.terminal_outcome.changed_paths)) return false;
	if (!Array.isArray(value.violations) || value.violations.length > 10 || !value.violations.every((item) =>
		isRecord(item) && exactFields(item, ["path", "reason"]) && isStrictReviewPath(item.path) &&
		typeof item.reason === "string" && item.reason.length > 0 && item.reason.length <= 240)) return false;
	if ((value.verdict === "PASS") !== (value.violations.length === 0)) return false;
	if (!Array.isArray(value.patch) || value.patch.length > 50 || !value.patch.every(validReviewPatchEntry)) return false;
	if (!Array.isArray(value.patch_paths) || value.patch_paths.length > 50 || !value.patch_paths.every((item) =>
		isRecord(item) && exactFields(item, ["path", "source", "bytes", "truncated"]) && isStrictReviewPath(item.path) &&
		["git-diff", "file-content", "deleted", "compact", "withheld", "omitted"].includes(String(item.source)) &&
		Number.isSafeInteger(item.bytes) && Number(item.bytes) >= 0 && typeof item.truncated === "boolean")) return false;
	if (!Array.isArray(value.notes) || value.notes.length > 10 || !value.notes.every((note) =>
		typeof note === "string" && Buffer.byteLength(note, "utf8") <= 240)) return false;
	const checked = value.checked_paths as string[];
	const displayed = value.displayed_paths as string[];
	const remaining = value.remaining_paths as string[];
	if (!displayed.every((path) => checked.includes(path)) || !remaining.every((path) => checked.includes(path)) ||
		displayed.some((path) => remaining.includes(path)) ||
		!samePathSetByte([...displayed, ...remaining], checked) || value.coverage_complete !== (remaining.length === 0)) return false;
	const expectedPath = delegationReviewRelativePathV2(state.delegation_id);
	return expectedPath !== undefined && value.review_path === expectedPath;
}

function parseReviewArtifactForState(value: unknown, state: DelegationTransactionRecord): DelegationReviewArtifactV2 | undefined {
	if (!isRecord(value) || !exactFields(value, REVIEW_ARTIFACT_FIELDS) || !isRecord(value.worker_identity)) return undefined;
	if (value.schema_version !== 2 || value.delegation_id !== state.delegation_id || value.task_kind !== "implementation" ||
		state.task_kind !== "implementation" || value.contract_hash !== state.contract_hash ||
		!exactFields(value.worker_identity, ["provider", "model", "worker_id"]) ||
		!sameIdentity(value.worker_identity as unknown as DelegationWorkerIdentity, state.worker_identity) ||
		value.generation !== state.generation || value.transaction_revision !== 3 || !isCanonicalTime(value.reviewed_at) ||
		!validReviewRecordForState(value.review, state) || (value.review as ReviewRecord).reviewed_at !== value.reviewed_at) return undefined;
	return value as unknown as DelegationReviewArtifactV2;
}

function encodeReviewArtifact(value: DelegationReviewArtifactV2): Uint8Array | undefined {
	const parsed = encodeJson(value, REVIEW_RECORD_MAX_BYTES);
	return parsed;
}

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function delegationReviewRelativePathV2(delegationId: string): string | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	return posix.join(CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2", REVIEW_FILE);
}

/**
 * Strict project-relative locator for one immutable v2 generation record.
 * This helper performs no filesystem I/O and never accepts arbitrary names.
 */
export function delegationGenerationRecordRelativePathV2(
	delegationId: string,
	generation: number,
	recordName: DelegationCommittedRecordName,
): string | undefined {
	const name = generationName(generation);
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId) || name === undefined ||
		!DELEGATION_COMMITTED_RECORD_NAMES.includes(recordName)) return undefined;
	return posix.join(CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2", "generations", name, recordName);
}

function transactionPaths(projectRoot: string, delegationId: string): {
	delegation: string;
	v2: string;
	transaction: string;
	lock: string;
	review: string;
	generations: string;
} | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	const delegation = join(resolve(projectRoot), CONFIG_DIR_NAME, "workbench", "delegations", delegationId);
	const v2 = join(delegation, "v2");
	return {
		delegation,
		v2,
		transaction: join(v2, TRANSACTION_FILE),
		lock: join(v2, LOCK_FILE),
		review: join(v2, REVIEW_FILE),
		generations: join(v2, "generations"),
	};
}

async function invokeFault(
	adapter: DelegationTransactionStorageAdapter,
	point: DelegationTransactionStorageFaultPoint,
	bytes?: Uint8Array,
): Promise<Uint8Array | undefined> {
	const changed = await adapter.fault?.(point, bytes === undefined ? undefined : Uint8Array.from(bytes));
	const result = changed instanceof Uint8Array ? Uint8Array.from(changed) : bytes;
	return result;
}

function storageToken(adapter: DelegationTransactionStorageAdapter): string | undefined {
	const token = adapter.randomToken();
	return /^[a-f0-9]{32}$/.test(token) ? token : undefined;
}

async function ensureLayout(
	projectRoot: string,
	delegationId: string,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<NonNullable<ReturnType<typeof transactionPaths>>>> {
	const paths = transactionPaths(projectRoot, delegationId);
	if (paths === undefined) return failure("invalid_input", "invalid delegation id");
	try {
		await invokeFault(adapter, "layout.mkdir");
		const root = resolve(projectRoot);
		const directories = [
			root,
			join(root, CONFIG_DIR_NAME),
			join(root, CONFIG_DIR_NAME, "workbench"),
			join(root, CONFIG_DIR_NAME, "workbench", "delegations"),
			paths.delegation,
			paths.v2,
		];
		for (const path of directories) {
			await adapter.makeDirectory(path, false);
			if ((await adapter.inspect(path)).kind !== "directory") return failure("storage_failure", "delegation v2 layout is unsafe", "layout.mkdir");
		}
		return { ok: true, value: paths };
	} catch {
		return failure("storage_failure", "delegation v2 layout creation failed", "layout.mkdir");
	}
}

function parseLockOwner(raw: unknown, delegationId: string): DelegationLockOwner | undefined {
	if (!isRecord(raw) || !exactFields(raw, LOCK_FIELDS)) return undefined;
	if (raw.schema_version !== 1 || raw.delegation_id !== delegationId) return undefined;
	if (typeof raw.token !== "string" || !/^[a-f0-9]{32}$/.test(raw.token)) return undefined;
	if (!Number.isSafeInteger(raw.process_id) || Number(raw.process_id) <= 0 || !isCanonicalTime(raw.created_at)) return undefined;
	return raw as unknown as DelegationLockOwner;
}

async function readBytesAtPoint(
	adapter: DelegationTransactionStorageAdapter,
	path: string,
	maxBytes: number,
	point: DelegationTransactionStorageFaultPoint,
): Promise<Uint8Array> {
	const raw = await adapter.readBounded(path, maxBytes);
	const changed = (await invokeFault(adapter, point, raw)) ?? raw;
	if (changed.length > maxBytes) throw new Error("fault hook exceeded bounded read");
	return changed;
}

async function acquireLock(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	delegationId: string,
	now: string,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<HeldLock>> {
	if (!isCanonicalTime(now)) return failure("invalid_input", "lock time must be canonical ISO-8601");
	for (let attempt = 0; attempt <= DELEGATION_TRANSACTION_LOCK_RECOVERY_ATTEMPTS; attempt += 1) {
		const token = storageToken(adapter);
		if (token === undefined) return failure("storage_failure", "storage random token is invalid", "lock.acquire");
		const owner: DelegationLockOwner = {
			schema_version: 1,
			delegation_id: delegationId,
			token,
			process_id: adapter.processId,
			created_at: now,
		};
		const encoded = encodeJson(owner, DELEGATION_TRANSACTION_LOCK_MAX_BYTES);
		if (encoded === undefined) return failure("storage_failure", "lock owner serialization failed", "lock.owner.write");
		let created = false;
		try {
			await invokeFault(adapter, "lock.acquire");
			await invokeFault(adapter, "lock.owner.write");
			// One exclusive file creation atomically publishes the complete owner;
			// there is no observable empty-lock window.
			await adapter.write(paths.lock, encoded, true);
			created = true;
			const read = await readBytesAtPoint(adapter, paths.lock, DELEGATION_TRANSACTION_LOCK_MAX_BYTES, "lock.owner.read");
			const parsed = parseLockOwner(decodeJson(read), delegationId);
			if (parsed === undefined || parsed.token !== token || parsed.process_id !== adapter.processId) {
				await releaseOwnedLockFile(paths.lock, token, adapter, false).catch(() => undefined);
				return failure("storage_failure", "lock owner readback failed", "lock.owner.read");
			}
			return { ok: true, value: { path: paths.lock, token } };
		} catch (error) {
			if (created) await releaseOwnedLockFile(paths.lock, token, adapter, false).catch(() => undefined);
			if (!isErrno(error, "EEXIST")) {
				// An exclusive write can fail after opening/writing a partial file.
				// Token-checked cleanup cannot delete a foreign owner's lock.
				if (!created) await releaseOwnedLockFile(paths.lock, token, adapter, false).catch(() => undefined);
				return failure("storage_failure", "exclusive delegation lock failed", "lock.acquire");
			}
		}

		let existing: DelegationLockOwner | undefined;
		try {
			const bytes = await readBytesAtPoint(adapter, paths.lock, DELEGATION_TRANSACTION_LOCK_MAX_BYTES, "lock.owner.read");
			existing = parseLockOwner(decodeJson(bytes), delegationId);
		} catch {
			existing = undefined;
		}
		if (existing !== undefined && adapter.isProcessAlive(existing.process_id)) {
			return failure("conflict", "delegation transaction is locked by an active owner", "lock.acquire");
		}
		if (attempt >= DELEGATION_TRANSACTION_LOCK_RECOVERY_ATTEMPTS) {
			return failure("conflict", "delegation transaction lock recovery was exhausted", "lock.recover.rename");
		}
		try {
			await invokeFault(adapter, "lock.recover.rename");
			const recoveryToken = storageToken(adapter);
			if (recoveryToken === undefined) return failure("storage_failure", "storage random token is invalid", "lock.recover.rename");
			await adapter.move(paths.lock, `${paths.lock}.recovered.${recoveryToken}`);
		} catch {
			return failure("conflict", "delegation transaction lock changed during recovery", "lock.recover.rename");
		}
	}
	return failure("conflict", "delegation transaction lock acquisition failed", "lock.acquire");
}

async function releaseOwnedLockFile(
	lockPath: string,
	token: string,
	adapter: DelegationTransactionStorageAdapter,
	injectFaults: boolean,
): Promise<void> {
	const releasePath = `${lockPath}.release.${token}`;
	if (injectFaults) await invokeFault(adapter, "lock.release.owner.rename");
	await adapter.move(lockPath, releasePath);
	const bytes = injectFaults
		? await readBytesAtPoint(adapter, releasePath, DELEGATION_TRANSACTION_LOCK_MAX_BYTES, "lock.release.owner.read")
		: await adapter.readBounded(releasePath, DELEGATION_TRANSACTION_LOCK_MAX_BYTES);
	const raw = decodeJson(bytes);
	if (!isRecord(raw) || raw.token !== token) {
		await adapter.move(releasePath, lockPath).catch(() => undefined);
		throw new Error("foreign lock token");
	}
	if (injectFaults) await invokeFault(adapter, "lock.release.owner.unlink");
	await adapter.removeFile(releasePath);
}

async function releaseLock(lock: HeldLock, adapter: DelegationTransactionStorageAdapter): Promise<void> {
	await releaseOwnedLockFile(lock.path, lock.token, adapter, true);
}

function parseStoredTransaction(bytes: Uint8Array): DelegationTransactionStorageResult<DelegationTransactionRecord> {
	const raw = decodeJson(bytes);
	if (raw === undefined) return failure("invalid_record", "delegation transaction is not valid bounded UTF-8 JSON");
	if (isRecord(raw) && typeof raw.schema_version === "number" && raw.schema_version > DELEGATION_TRANSACTION_SCHEMA_VERSION) {
		return failure("unsupported_version", "delegation transaction schema version is newer than supported");
	}
	const parsed = parseDelegationTransaction(raw);
	return parsed.ok ? { ok: true, value: parsed.state } : failure("invalid_record", "delegation transaction v2 record is invalid");
}

async function readStateAt(
	path: string,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<DelegationTransactionRecord>> {
	try {
		const stat = await adapter.inspect(path);
		if (stat.kind !== "file" || stat.size > DELEGATION_TRANSACTION_MAX_BYTES) {
			return failure("invalid_record", "delegation transaction v2 path is unsafe or oversized", "state.read");
		}
		const bytes = await readBytesAtPoint(adapter, path, DELEGATION_TRANSACTION_MAX_BYTES, "state.read");
		return parseStoredTransaction(bytes);
	} catch (error) {
		return isErrno(error, "ENOENT")
			? failure("not_found", "delegation transaction v2 record does not exist", "state.read")
			: failure("storage_failure", "delegation transaction v2 read failed", "state.read");
	}
}

function reviewArtifactBindsGeneration(
	artifact: DelegationReviewArtifactV2,
	records: DelegationCommittedRecords,
	state: DelegationTransactionRecord,
): boolean {
	const after = records["after.json"];
	const scope = records["scope.json"];
	if (!isRecord(after) || !isRecord(scope) || state.terminal_outcome === null) return false;
	const tagged = after.diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2;
	if (tagged !== (artifact.review.schema_version === 2)) return false;
	const base = typeof after.diff_hash === "string" && DELEGATION_TRANSACTION_HASH_RE.test(after.diff_hash) &&
		validByteSortedPaths(after.changed_paths, 500) &&
		sameJson(after.changed_paths, state.terminal_outcome.changed_paths) &&
		artifact.review.recorded_after_hash === (tagged ? artifact.review.bound_diff_hash : after.diff_hash) &&
		sameJson(artifact.review.checked_paths, after.changed_paths) &&
		validateScopeRecord(scope, state) &&
		sameJson(artifact.review.allowed_paths, scope.allowed_paths);
	if (!base || !tagged) return base;
	const review = artifact.review;
	const changeSet = scope.change_set;
	if (!isRecord(changeSet) || !validateChangeSet(changeSet) || review.relevance_projection === undefined ||
		review.relevance_binding === undefined) return false;
	const projection = review.relevance_projection;
	const worker = projection.entries.filter((entry) => entry.roles.includes("W")).map((entry) => entry.path);
	const dependencies = projection.entries.filter((entry) => entry.roles.includes("D")).map((entry) => entry.path);
	return projection.change_set_hash === changeSet.change_set_hash && projection.worker_delta_hash === changeSet.worker_delta_hash &&
		projection.git_head === after.git_head && sameJson(worker, after.changed_paths) &&
		sameJson(dependencies, changeSet.dependency_paths) && review.bound_diff_hash === review.relevance_binding.projection_hash;
}

async function readReviewArtifactAt(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	state: DelegationTransactionRecord,
	records: DelegationCommittedRecords,
	adapter: DelegationTransactionStorageAdapter,
	point?: "review.temp.read" | "review.final.read",
): Promise<DelegationTransactionStorageResult<DelegationReviewAuthorityV2 & { bytes: Uint8Array }>> {
	try {
		const stat = await adapter.inspect(paths.review);
		if (stat.kind !== "file" || stat.size > REVIEW_RECORD_MAX_BYTES) {
			return failure("invalid_record", "delegation v2 review path is unsafe or oversized", point);
		}
		const bytes = point === undefined
			? await adapter.readBounded(paths.review, REVIEW_RECORD_MAX_BYTES)
			: await readBytesAtPoint(adapter, paths.review, REVIEW_RECORD_MAX_BYTES, point);
		const raw = decodeJson(bytes);
		const artifact = parseReviewArtifactForState(raw, state);
		const canonical = artifact === undefined ? undefined : encodeReviewArtifact(artifact);
		if (artifact === undefined || canonical === undefined || !Buffer.from(canonical).equals(Buffer.from(bytes)) ||
			!reviewArtifactBindsGeneration(artifact, records, state)) {
			return failure("invalid_record", "delegation v2 review artifact is corrupt, non-canonical, or unbound", point);
		}
		const reviewHash = hashBytes(bytes);
		let finalized = false;
		if (state.status === "PENDING_REVIEW") {
			if (state.revision !== 3 || state.review !== null) return failure("invalid_record", "pending review state is inconsistent", point);
		} else if (state.status === "REVIEWED") {
			const review = state.review;
			if (state.revision !== 4 || review === null || review.delegation_id !== state.delegation_id ||
				review.generation !== state.generation || review.transaction_revision !== artifact.transaction_revision ||
				review.review_hash !== reviewHash || review.reviewed_at !== artifact.reviewed_at || review.reviewer !== "sol") {
				return failure("invalid_record", "finalized review proof conflicts with exact artifact bytes", point);
			}
			finalized = true;
		} else {
			return failure("invalid_record", "delegation state cannot own a v2 review artifact", point);
		}
		return {
			ok: true,
			value: {
				state,
				artifact,
				review: artifact.review,
				review_hash: reviewHash,
				review_path: delegationReviewRelativePathV2(state.delegation_id)!,
				finalized,
				bytes: Uint8Array.from(bytes),
			},
		};
	} catch (error) {
		return isErrno(error, "ENOENT")
			? failure("not_found", "delegation v2 review artifact does not exist", point)
			: failure("storage_failure", "delegation v2 review artifact read failed", point);
	}
}

async function publishState(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	state: DelegationTransactionRecord,
	adapter: DelegationTransactionStorageAdapter,
	phase: "state" | "publish_state" | "review_state",
): Promise<DelegationTransactionStorageResult<DelegationTransactionRecord>> {
	let serialized: DelegationTransactionRecord;
	try { serialized = serializeDelegationTransaction(state); } catch { return failure("invalid_record", "refusing to persist invalid delegation transaction state"); }
	const encoded = encodeJson(serialized, DELEGATION_TRANSACTION_MAX_BYTES);
	if (encoded === undefined) return failure("invalid_record", "delegation transaction state exceeds its bound");
	const token = storageToken(adapter);
	if (token === undefined) return failure("storage_failure", "storage random token is invalid", `${phase}.temp.write` as DelegationTransactionStorageFaultPoint);
	const temp = join(paths.v2, `.transaction.${token}.tmp`);
	const writePoint = `${phase}.temp.write` as DelegationTransactionStorageFaultPoint;
	const readPoint = `${phase}.temp.read` as DelegationTransactionStorageFaultPoint;
	const renamePoint = `${phase}.rename` as DelegationTransactionStorageFaultPoint;
	try {
		await invokeFault(adapter, writePoint);
		await adapter.write(temp, encoded, true);
		const readback = await readBytesAtPoint(adapter, temp, DELEGATION_TRANSACTION_MAX_BYTES, readPoint);
		const parsed = parseStoredTransaction(readback);
		if (!parsed.ok || !sameJson(parsed.value, serialized)) return failure("storage_failure", "delegation transaction temp readback mismatch", readPoint);
		await invokeFault(adapter, renamePoint);
		await adapter.move(temp, paths.transaction);
		return { ok: true, value: serialized };
	} catch {
		return failure("storage_failure", "delegation transaction atomic publish failed", renamePoint);
	}
}

async function withDelegationLock<T>(
	projectRoot: string,
	delegationId: string,
	now: string,
	adapter: DelegationTransactionStorageAdapter,
	operation: (paths: NonNullable<ReturnType<typeof transactionPaths>>) => Promise<DelegationTransactionStorageResult<T>>,
): Promise<DelegationTransactionStorageResult<T>> {
	const layout = await ensureLayout(projectRoot, delegationId, adapter);
	if (!layout.ok) return layout;
	const acquired = await acquireLock(layout.value, delegationId, now, adapter);
	if (!acquired.ok) return acquired;
	let result: DelegationTransactionStorageResult<T>;
	try {
		result = await operation(layout.value);
	} catch {
		result = failure("storage_failure", "delegation transaction operation failed");
	}
	try {
		await releaseLock(acquired.value, adapter);
	} catch {
		// The operation's atomic state rename is the commit point. Cleanup may
		// leave a diagnosable lock, but must never turn a published success into
		// a reported failure (or invite an unsafe retry of the same finish).
		await releaseOwnedLockFile(acquired.value.path, acquired.value.token, adapter, false).catch(() => undefined);
	}
	return result;
}

export interface DelegationTransactionStorageOptions {
	adapter?: DelegationTransactionStorageAdapter;
}

function adapterOf(options?: DelegationTransactionStorageOptions): DelegationTransactionStorageAdapter {
	return options?.adapter ?? createNodeDelegationTransactionStorageAdapter();
}

/** Strict v2-only read. It never treats v1 files as a v2 success. */
export async function readDelegationTransactionV2(
	projectRoot: string,
	delegationId: string,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTransactionRecord>> {
	const paths = transactionPaths(projectRoot, delegationId);
	if (paths === undefined) return failure("invalid_input", "invalid delegation id");
	const adapter = adapterOf(options);
	try {
		const stat = await adapter.inspect(paths.transaction);
		if (stat.kind !== "file" || stat.size > DELEGATION_TRANSACTION_MAX_BYTES) {
			return failure("invalid_record", "delegation transaction v2 path is unsafe or oversized");
		}
	} catch (error) {
		if (isErrno(error, "ENOENT")) return failure("not_found", "delegation transaction v2 record does not exist");
		return failure("storage_failure", "delegation transaction v2 inspection failed");
	}
	return readStateAt(paths.transaction, adapter);
}

export async function persistPreparedDelegationTransaction(
	projectRoot: string,
	input: PrepareDelegationTransactionInput,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTransactionRecord>> {
	const adapter = adapterOf(options);
	const prepared = createPreparedDelegationTransaction(input);
	if (!prepared.ok) return failure("invalid_input", "invalid prepared delegation transaction input");
	if (generationName(prepared.state.generation) === undefined) return failure("invalid_input", "delegation generation is outside the storage bound");
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const existing = await readStateAt(paths.transaction, adapter);
		if (existing.ok) return failure("conflict", "delegation transaction already exists");
		if (existing.error.code !== "not_found") return existing;
		return publishState(paths, prepared.state, adapter, "state");
	});
}

export async function persistRunningDelegationTransaction(
	projectRoot: string,
	input: DelegationCasInput,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTransactionRecord>> {
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const current = await readStateAt(paths.transaction, adapter);
		if (!current.ok) return current;
		const next = startDelegationTransaction(current.value, input);
		if (!next.ok) return failure("conflict", "delegation start CAS or lifecycle check failed");
		return publishState(paths, next.state, adapter, "state");
	});
}

export async function persistCommittingDelegationTransaction(
	projectRoot: string,
	input: BeginDelegationCommitInput,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTransactionRecord>> {
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const current = await readStateAt(paths.transaction, adapter);
		if (!current.ok) return current;
		const next = beginDelegationCommit(current.value, input);
		if (!next.ok) return failure("conflict", "delegation commit CAS, identity, or lifecycle check failed");
		return publishState(paths, next.state, adapter, "state");
	});
}

export async function persistReviewedDelegationTransaction(
	_projectRoot: string,
	_input: ReviewDelegationTransactionInput,
	_options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTransactionRecord>> {
	// Kept as an explicit fail-closed compatibility symbol.  A caller-provided
	// hash is not review authority: REVIEWED publication must atomically bind
	// the exact persisted v2 review bytes via publishDelegationReviewV2.
	return failure("invalid_input", "review state requires an exact persisted v2 review artifact");
}

export async function persistAbortedDelegationTransaction(
	projectRoot: string,
	input: StopDelegationTransactionInput,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTransactionRecord>> {
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const current = await readStateAt(paths.transaction, adapter);
		if (!current.ok) return current;
		const next = abortDelegationTransaction(current.value, input);
		if (!next.ok) return failure("conflict", "delegation abort CAS, identity, or lifecycle check failed");
		return publishState(paths, next.state, adapter, "state");
	});
}

export async function persistRecoveryRequiredDelegationTransaction(
	projectRoot: string,
	input: StopDelegationTransactionInput,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTransactionRecord>> {
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const current = await readStateAt(paths.transaction, adapter);
		if (!current.ok) return current;
		const next = requireDelegationRecovery(current.value, input);
		if (!next.ok) return failure("conflict", "delegation recovery CAS, identity, or lifecycle check failed");
		return publishState(paths, next.state, adapter, "state");
	});
}

function validateGenericJsonRecord(value: unknown, delegationId: string): boolean {
	return isRecord(value) && value.schema_version === DELEGATION_TRANSACTION_SCHEMA_VERSION && value.delegation_id === delegationId;
}

function validateIdentityRecord(value: unknown, state: DelegationTransactionRecord): boolean {
	if (!isRecord(value) || !exactFields(value, IDENTITY_RECORD_FIELDS)) return false;
	if (!isRecord(value.worker_identity) || !exactFields(value.worker_identity, ["provider", "model", "worker_id"])) return false;
	return value.schema_version === DELEGATION_TRANSACTION_SCHEMA_VERSION && value.delegation_id === state.delegation_id &&
		value.task_kind === state.task_kind && value.contract_hash === state.contract_hash && value.generation === state.generation &&
		value.revision === state.revision &&
		sameIdentity(value.worker_identity as unknown as DelegationWorkerIdentity, state.worker_identity);
}

function validateScopeRecord(value: unknown, state: DelegationTransactionRecord): boolean {
	if (!isRecord(value) || !exactFields(value, SCOPE_RECORD_FIELDS) || state.terminal_outcome === null) return false;
	if (value.schema_version !== DELEGATION_TRANSACTION_SCHEMA_VERSION || value.delegation_id !== state.delegation_id ||
		value.task_kind !== state.task_kind || value.contract_hash !== state.contract_hash ||
		!Array.isArray(value.allowed_paths) || !sameJson(value.allowed_paths, state.allowed_paths) ||
		!Array.isArray(value.changed_paths) || !sameJson(value.changed_paths, state.terminal_outcome.changed_paths)) return false;
	if (!validateWorkerWriteJournalRecord(value.write_journal) || !validateChangeSet(value.change_set)) return false;
	const journal = value.write_journal as WorkerWriteJournalRecord;
	const changeSet = value.change_set as ChangeSetRecord;
	const changedPaths = workerDeltaPaths(changeSet);
	const successfulWrites = journal.operations.filter((operation) =>
		operation.status === "completed" && operation.outcome === "succeeded").length;
	return journal.state === "SEALED" && journal.journal_hash !== null &&
		journal.delegation_id === state.delegation_id && journal.contract_hash === state.contract_hash &&
		changeSet.delegation_id === state.delegation_id && changeSet.contract_hash === state.contract_hash &&
		changeSet.journal_hash === journal.journal_hash && sameJson(value.changed_paths, changedPaths) &&
		state.terminal_outcome.change_set_status === changeSet.status &&
		state.terminal_outcome.terminal_facts_complete === true &&
		state.terminal_outcome.scope_complete === changedPaths.every((path) => delegationPathAllowedV2(path, state.allowed_paths)) &&
		state.terminal_outcome.successful_write_count === successfulWrites &&
		(state.task_kind === "implementation"
			? state.terminal_outcome.delta_hash === changeSet.worker_delta_hash
			: state.terminal_outcome.delta_hash === null);
}

function validateGuardDiagnostics(
	guard: Readonly<WorkspaceGuardRecord>,
	gitHead: unknown,
	gitDirty: unknown,
	pathStatuses: unknown,
	pathDigests: unknown,
): boolean {
	if (gitHead !== guard.git_head || gitDirty !== (guard.entries.length > 0) ||
		!isRecord(pathStatuses) || !isRecord(pathDigests)) return false;
	const paths = guard.entries.map((entry) => entry.path);
	const statusPaths = Object.keys(pathStatuses).sort(byteCompare);
	if (!sameJson(statusPaths, paths) || guard.entries.some((entry) => pathStatuses[entry.path] !== entry.status)) return false;
	for (const [path, digest] of Object.entries(pathDigests)) {
		const entry = guard.entries.find((candidate) => candidate.path === path);
		if (entry === undefined || entry.identity.kind !== "file" || typeof digest !== "string" ||
			!/^[a-f0-9]{64}(?::\d+)?$/u.test(digest)) return false;
	}
	return true;
}

function guardStatusDiagnostics(
	guard: Readonly<WorkspaceGuardRecord>,
	gitHead: unknown,
	gitDirty: unknown,
	pathStatuses: unknown,
): boolean {
	if (gitHead !== guard.git_head || gitDirty !== (guard.entries.length > 0) || !isRecord(pathStatuses)) return false;
	const paths = guard.entries.map((entry) => entry.path);
	const statusPaths = Object.keys(pathStatuses).sort(byteCompare);
	return sameJson(statusPaths, paths) && guard.entries.every((entry) => pathStatuses[entry.path] === entry.status);
}

function validateBeforeRecord(
	value: unknown,
	state: DelegationTransactionRecord,
	changeSet: ChangeSetRecord,
	allowLegacyRead: boolean,
): boolean {
	if (!isRecord(value) || !validateWorkspaceGuard(value.workspace_guard)) return false;
	const tagged = value.diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2;
	if (!(tagged ? exactFields(value, BEFORE_RECORD_FIELDS_GUARD_V2) : exactFields(value, BEFORE_RECORD_FIELDS)) || (!tagged && !allowLegacyRead)) return false;
	const guard = value.workspace_guard as WorkspaceGuardRecord;
	const paths = guard.entries.map((entry) => entry.path);
	const common = value.schema_version === DELEGATION_TRANSACTION_SCHEMA_VERSION && value.delegation_id === state.delegation_id &&
		isCanonicalTime(value.recorded_at) && typeof value.diff_hash === "string" &&
		DELEGATION_TRANSACTION_HASH_RE.test(value.diff_hash) && validReviewPaths(value.changed_paths, 500, true) &&
		samePathSetByte(value.changed_paths, paths) && isRecord(value.contract);
	if (!common) return false;
	if (!tagged) return allowLegacyRead &&
		validateGuardDiagnostics(guard, value.git_head, value.git_dirty, value.path_statuses, value.path_digests) &&
		value.diff_hash === computeDiffHash(
			value.changed_paths as string[], value.path_digests as Record<string, string>, value.path_statuses as Record<string, string>,
		) &&
		guard.workspace_guard_hash === changeSet.before_workspace_guard_hash;
	if (!guardStatusDiagnostics(guard, value.git_head, value.git_dirty, value.path_statuses) || !isRecord(value.path_digests) ||
		value.diff_hash !== guard.workspace_guard_hash || guard.workspace_guard_hash !== changeSet.before_workspace_guard_hash) return false;
	const expectedDigestPaths = changeSet.worker_delta
		.filter((entry) => entry.before.kind === "file")
		.map((entry) => entry.path);
	if (!sameJson(Object.keys(value.path_digests).sort(byteCompare), expectedDigestPaths)) return false;
	return Object.entries(value.path_digests).every(([path, digest]) => {
		const delta = changeSet.worker_delta.find((entry) => entry.path === path);
		return delta !== undefined && delta.before.kind === "file" && typeof digest === "string" &&
			/^[a-f0-9]{64}$/u.test(digest) && digest === delta.before.sha256;
	});
}

function validateAfterRecord(
	value: unknown,
	state: DelegationTransactionRecord,
	changeSet: ChangeSetRecord,
	allowLegacyRead: boolean,
): boolean {
	if (!isRecord(value) || !validateWorkspaceGuard(value.workspace_guard)) return false;
	const tagged = value.diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2;
	if (!(tagged ? exactFields(value, AFTER_RECORD_FIELDS_GUARD_V2) : exactFields(value, AFTER_RECORD_FIELDS)) || (!tagged && !allowLegacyRead)) return false;
	const guard = value.workspace_guard as WorkspaceGuardRecord;
	const changedPaths = workerDeltaPaths(changeSet);
	const fullPaths = guard.entries.map((entry) => entry.path);
	const common = value.schema_version === DELEGATION_TRANSACTION_SCHEMA_VERSION && value.delegation_id === state.delegation_id &&
		isCanonicalTime(value.recorded_at) && (value.status === "success" || value.status === "failure") &&
		Number.isSafeInteger(value.exit_code) && typeof value.diff_hash === "string" && DELEGATION_TRANSACTION_HASH_RE.test(value.diff_hash) &&
		validByteSortedPaths(value.changed_paths, 500) && sameJson(value.changed_paths, changedPaths) &&
		validReviewPaths(value.changed_since_before, 500) && validReviewPaths(value.reported_paths, 500) &&
		isRecord(value.pinned_identity) &&
		isRecord(value.usage) && isRecord(value.budget) && typeof value.report_summary === "string" && value.review_status === "PENDING_REVIEW" &&
		value.change_set_status === changeSet.status && value.worker_delta_hash === changeSet.worker_delta_hash &&
		value.workspace_guard_hash === changeSet.workspace_guard_hash && value.change_set_hash === changeSet.change_set_hash &&
		guard.workspace_guard_hash === changeSet.after_workspace_guard_hash;
	if (!common) return false;
	if (!tagged) return allowLegacyRead &&
		validateGuardDiagnostics(guard, value.git_head, value.git_dirty, value.path_statuses, value.path_digests) &&
		value.diff_hash === computeDiffHash(fullPaths, value.path_digests as Record<string, string>, value.path_statuses as Record<string, string>);
	if (!guardStatusDiagnostics(guard, value.git_head, value.git_dirty, value.path_statuses) || !isRecord(value.path_digests)
		|| value.diff_hash !== guard.workspace_guard_hash || !validByteSortedPaths(value.changed_since_before, 500)) return false;
	const unsafePaths = [...new Set([
		...changedPaths,
		...changeSet.workspace_drift.map((entry) => entry.path),
		...changeSet.conflicts.map((entry) => entry.path),
	])].sort(byteCompare);
	const expectedDigestPaths = changeSet.worker_delta
		.filter((entry) => entry.after.kind === "file")
		.map((entry) => entry.path);
	return sameJson(value.changed_since_before, unsafePaths) && sameJson(Object.keys(value.path_digests).sort(byteCompare), expectedDigestPaths) &&
	Object.entries(value.path_digests).every(([path, digest]) => {
		const delta = changeSet.worker_delta.find((entry) => entry.path === path);
		return delta !== undefined && delta.after.kind === "file" && typeof digest === "string" &&
			/^[a-f0-9]{64}$/u.test(digest) && digest === delta.after.sha256;
	});
}

function validateCommittedRecordBindings(
	state: DelegationTransactionRecord,
	records: DelegationCommittedRecords,
	allowLegacyRead: boolean,
): boolean {
	if (!validateScopeRecord(records["scope.json"], state)) return false;
	const scope = records["scope.json"] as { change_set: ChangeSetRecord; write_journal: WorkerWriteJournalRecord };
	const changeSet = scope.change_set;
	if (!validateBeforeRecord(records["before.json"], state, changeSet, allowLegacyRead) ||
		!validateAfterRecord(records["after.json"], state, changeSet, allowLegacyRead)) return false;
	const beforeTagged = isRecord(records["before.json"]) && records["before.json"].diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2;
	const afterTagged = isRecord(records["after.json"]) && records["after.json"].diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2;
	if (beforeTagged !== afterTagged || (!allowLegacyRead && !beforeTagged)) return false;
	const summary = records["worker-summary.json"];
	if (!isRecord(summary) || !validByteSortedPaths(summary.changed_paths, 500) ||
		!sameJson(summary.changed_paths, workerDeltaPaths(changeSet))) return false;
	const before = records["before.json"] as { workspace_guard: WorkspaceGuardRecord };
	const after = records["after.json"] as { workspace_guard: WorkspaceGuardRecord };
	return before.workspace_guard.workspace_guard_hash === changeSet.before_workspace_guard_hash &&
		after.workspace_guard.workspace_guard_hash === changeSet.after_workspace_guard_hash &&
		changeSet.workspace_guard_hash === after.workspace_guard.workspace_guard_hash &&
		changeSet.journal_hash === scope.write_journal.journal_hash;
}

function compileCommittedRecords(
	state: DelegationTransactionRecord,
	records: DelegationCommittedRecords,
): DelegationTransactionStorageResult<Map<DelegationCommittedRecordName, Uint8Array>> {
	if (!isRecord(records) || !exactFields(records, DELEGATION_COMMITTED_RECORD_NAMES)) {
		return failure("invalid_input", "committed generation must provide the exact record set");
	}
	const compiled = new Map<DelegationCommittedRecordName, Uint8Array>();
	for (const name of DELEGATION_COMMITTED_RECORD_NAMES) {
		const value = records[name];
		if (name === "worker-report.md") {
			if (typeof value !== "string" || value.includes("\0")) return failure("invalid_input", "worker report must be bounded UTF-8 text");
			if (state.terminal_outcome?.report_complete === true && value.trim().length === 0) {
				return failure("invalid_input", "a complete worker report cannot be empty");
			}
			const bytes = Buffer.from(value, "utf8");
			if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) return failure("invalid_input", "worker report contains invalid Unicode text");
			if (bytes.length > DELEGATION_TRANSACTION_REPORT_MAX_BYTES) return failure("invalid_input", "worker report exceeds its byte bound");
			compiled.set(name, bytes);
			continue;
		}
		if (!validateGenericJsonRecord(value, state.delegation_id)) return failure("invalid_input", `${name} lacks its v2 delegation binding`);
		if (name === "identity.json" && !validateIdentityRecord(value, state)) return failure("invalid_input", "identity record does not bind the committing state");
		if (name === "scope.json" && !validateScopeRecord(value, state)) return failure("invalid_input", "scope record does not bind the committing outcome");
		const bytes = encodeJson(value, committedRecordMaxBytes(name));
		if (bytes === undefined) return failure("invalid_input", `${name} is not bounded JSON`);
		compiled.set(name, bytes);
	}
	if (!validateCommittedRecordBindings(state, records, false)) return failure("invalid_input", "committed generation authority records are not cross-bound");
	return { ok: true, value: compiled };
}

/** Full-byte hash over ordered filename length/name and byte length/content. */
export function hashDelegationCommittedRecords(records: ReadonlyMap<DelegationCommittedRecordName, Uint8Array>): string {
	const hash = createHash("sha256");
	for (const name of DELEGATION_COMMITTED_RECORD_NAMES) {
		const bytes = records.get(name);
		if (bytes === undefined) throw new Error("incomplete committed record map");
		const nameBytes = Buffer.from(name, "utf8");
		const lengths = Buffer.alloc(16);
		lengths.writeBigUInt64BE(BigInt(nameBytes.length), 0);
		lengths.writeBigUInt64BE(BigInt(bytes.length), 8);
		hash.update(lengths);
		hash.update(nameBytes);
		hash.update(bytes);
	}
	return hash.digest("hex");
}

function makeProof(state: DelegationTransactionRecord, contentHash: string): DelegationCommittedGenerationProof {
	const withoutMarker = {
		schema_version: DELEGATION_TRANSACTION_SCHEMA_VERSION,
		delegation_id: state.delegation_id,
		task_kind: state.task_kind,
		contract_hash: state.contract_hash,
		worker_identity: { ...state.worker_identity },
		generation: state.generation,
		revision: state.revision,
		record_names: [...DELEGATION_COMMITTED_RECORD_NAMES],
		record_count: DELEGATION_COMMITTED_RECORD_NAMES.length,
		content_hash: contentHash,
	};
	return { ...withoutMarker, commit_marker: delegationCommitMarker(withoutMarker) };
}

async function verifyGenerationDirectory(
	directory: string,
	state: DelegationTransactionRecord,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<{
	inventory: DelegationGenerationInventory;
	records: DelegationCommittedRecords;
}>> {
	try {
		if ((await adapter.inspect(directory)).kind !== "directory") {
			return failure("invalid_record", "committed generation directory is unsafe", "generation.inventory.read");
		}
		await invokeFault(adapter, "generation.inventory.read");
		const entries = (await adapter.list(directory)).sort((a, b) => a.name.localeCompare(b.name));
		const expected = [...DELEGATION_COMMITTED_RECORD_NAMES, COMMIT_MARKER_FILE].sort();
		if (entries.length !== expected.length || entries.some((entry, index) => entry.name !== expected[index] || entry.kind !== "file")) {
			return failure("invalid_record", "committed generation inventory is incomplete or unsafe", "generation.inventory.read");
		}
		const compiled = new Map<DelegationCommittedRecordName, Uint8Array>();
		const decoded = new Map<DelegationCommittedRecordName, unknown>();
		for (const name of DELEGATION_COMMITTED_RECORD_NAMES) {
			const point = `generation.record.${name}.read` as DelegationTransactionStorageFaultPoint;
			const cap = committedRecordMaxBytes(name);
			const bytes = await readBytesAtPoint(adapter, join(directory, name), cap, point);
			if (name === "worker-report.md") {
				try { decoded.set(name, new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return failure("invalid_record", "worker report is invalid UTF-8", point); }
			} else {
				const value = decodeJson(bytes);
				if (!validateGenericJsonRecord(value, state.delegation_id)) return failure("invalid_record", `${name} is not a bound v2 record`, point);
				if (name === "identity.json" && !validateIdentityRecord(value, state)) return failure("invalid_record", "identity record conflicts with transaction", point);
				if (name === "scope.json" && !validateScopeRecord(value, state)) return failure("invalid_record", "scope record conflicts with transaction", point);
				decoded.set(name, value);
			}
			compiled.set(name, bytes);
		}
		const markerBytes = await readBytesAtPoint(adapter, join(directory, COMMIT_MARKER_FILE), DELEGATION_TRANSACTION_MARKER_MAX_BYTES, "generation.marker.read");
		const markerRaw = decodeJson(markerBytes);
		if (!isRecord(markerRaw)) return failure("invalid_record", "commit marker is invalid", "generation.marker.read");
		const parsedMarker = markerRaw as unknown as DelegationCommittedGenerationProof;
		const contentHash = hashDelegationCommittedRecords(compiled);
		const expectedProof = makeProof(state, contentHash);
		if (!sameJson(parsedMarker, expectedProof)) return failure("invalid_record", "commit marker or content hash conflicts with generation", "generation.marker.read");
		const records: DelegationCommittedRecords = {
			"after.json": decoded.get("after.json"),
			"before.json": decoded.get("before.json"),
			"identity.json": decoded.get("identity.json"),
			"review.json": decoded.get("review.json"),
			"scope.json": decoded.get("scope.json"),
			"usage.json": decoded.get("usage.json"),
			"worker-report.md": decoded.get("worker-report.md") as string,
			"worker-summary.json": decoded.get("worker-summary.json"),
		};
		if (!validateCommittedRecordBindings(state, records, true)) {
			return failure("invalid_record", "committed generation authority records are not cross-bound", "generation.inventory.read");
		}
		return {
			ok: true,
			value: {
				inventory: { directory, record_names: entries.map((entry) => entry.name), proof: expectedProof },
				records,
			},
		};
	} catch {
		return failure("storage_failure", "committed generation verification failed", "generation.inventory.read");
	}
}

export async function verifyDelegationGenerationV2(
	projectRoot: string,
	delegationId: string,
	proof: DelegationCommittedGenerationProof,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationGenerationInventory>> {
	const paths = transactionPaths(projectRoot, delegationId);
	const name = generationName(proof.generation);
	if (paths === undefined || name === undefined) return failure("invalid_input", "invalid delegation generation identity");
	const state = await readDelegationTransactionV2(projectRoot, delegationId, options);
	if (!state.ok) return state;
	if (state.value.committed_proof === null || !sameJson(state.value.committed_proof, proof)) {
		return failure("invalid_record", "generation proof is not the proof published by transaction state");
	}
	const verified = await verifyGenerationDirectory(join(paths.generations, name), {
		...state.value,
		status: "COMMITTING",
		revision: proof.revision,
		committed_proof: null,
	}, adapterOf(options));
	return verified.ok ? { ok: true, value: verified.value.inventory } : verified;
}

/**
 * Strict authority read of a published immutable v2 generation. The
 * transaction is read and parsed first; v1 artifacts are never considered.
 * Every record byte, exact inventory entry, binding record, marker and proof
 * is revalidated before decoded records are returned.
 */
export async function readDelegationCommittedGenerationV2(
	projectRoot: string,
	delegationId: string,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationCommittedGenerationV2>> {
	const paths = transactionPaths(projectRoot, delegationId);
	if (paths === undefined) return failure("invalid_input", "invalid delegation id");
	const stateResult = await readDelegationTransactionV2(projectRoot, delegationId, options);
	if (!stateResult.ok) return stateResult;
	const state = stateResult.value;
	const proof = state.committed_proof;
	const publishedStatuses = new Set(["PENDING_REVIEW", "FINISHED", "REVIEWED", "FAILED", "RECOVERY_REQUIRED"]);
	if (proof === null || !publishedStatuses.has(state.status)) {
		return failure("invalid_record", "delegation transaction has no published committed-generation proof");
	}
	const name = generationName(proof.generation);
	if (name === undefined || proof.generation !== state.generation || proof.revision !== 2) {
		return failure("invalid_record", "delegation committed-generation proof has an invalid generation binding");
	}
	const verified = await verifyGenerationDirectory(join(paths.generations, name), {
		...state,
		status: "COMMITTING",
		revision: proof.revision,
		committed_proof: null,
		review: null,
	}, adapterOf(options));
	if (!verified.ok) return verified;
	if (!sameJson(verified.value.inventory.proof, proof)) {
		return failure("invalid_record", "committed generation conflicts with the transaction proof");
	}
	if (state.status === "REVIEWED") {
		const review = await readReviewArtifactAt(paths, state, verified.value.records, adapterOf(options));
		if (!review.ok || !review.value.finalized) {
			return failure("invalid_record", "reviewed transaction lacks exact finalized v2 review authority");
		}
	}
	return {
		ok: true,
		value: {
			state,
			records: verified.value.records,
			inventory: verified.value.inventory,
			proof,
		},
	};
}

/**
 * Strict v2 review read.  PENDING_REVIEW files are provisional evidence;
 * REVIEWED files are authority only when their exact full-byte hash and all
 * generation/time bindings match the transaction review proof.
 */
export async function readDelegationReviewV2(
	projectRoot: string,
	delegationId: string,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationReviewAuthorityV2>> {
	const generation = await readDelegationCommittedGenerationV2(projectRoot, delegationId, options);
	if (!generation.ok) return generation;
	if (generation.value.state.task_kind !== "implementation" ||
		(generation.value.state.status !== "PENDING_REVIEW" && generation.value.state.status !== "REVIEWED")) {
		return failure("invalid_record", "delegation is not an implementation review lifecycle");
	}
	const paths = transactionPaths(projectRoot, delegationId);
	if (paths === undefined) return failure("invalid_input", "invalid delegation id");
	const read = await readReviewArtifactAt(paths, generation.value.state, generation.value.records, adapterOf(options));
	if (!read.ok) return read;
	const { bytes: _bytes, ...authority } = read.value;
	return { ok: true, value: authority };
}

async function writeReviewArtifactLocked(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	state: DelegationTransactionRecord,
	records: DelegationCommittedRecords,
	artifact: DelegationReviewArtifactV2,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<DelegationReviewAuthorityV2 & { bytes: Uint8Array }>> {
	const encoded = encodeReviewArtifact(artifact);
	if (encoded === undefined) return failure("invalid_input", "delegation review artifact exceeds its fixed byte bound");
	try {
		const existing = await adapter.inspect(paths.review);
		if (existing.kind !== "file" || existing.size > REVIEW_RECORD_MAX_BYTES) {
			return failure("invalid_record", "existing delegation review path is unsafe or oversized");
		}
	} catch (error) {
		if (!isErrno(error, "ENOENT")) return failure("storage_failure", "delegation review destination inspection failed");
	}
	const token = storageToken(adapter);
	if (token === undefined) return failure("storage_failure", "storage random token is invalid", "review.temp.write");
	const temp = join(paths.v2, `.review.${token}.tmp`);
	try {
		await invokeFault(adapter, "review.temp.write");
		await adapter.write(temp, encoded, true);
		const tempBytes = await readBytesAtPoint(adapter, temp, REVIEW_RECORD_MAX_BYTES, "review.temp.read");
		const tempArtifact = parseReviewArtifactForState(decodeJson(tempBytes), state);
		const canonical = tempArtifact === undefined ? undefined : encodeReviewArtifact(tempArtifact);
		if (tempArtifact === undefined || canonical === undefined || !Buffer.from(canonical).equals(Buffer.from(tempBytes)) ||
			!Buffer.from(tempBytes).equals(Buffer.from(encoded)) ||
			!reviewArtifactBindsGeneration(tempArtifact, records, state)) {
			return failure("storage_failure", "delegation review temp readback mismatch", "review.temp.read");
		}
		await invokeFault(adapter, "review.rename");
		await adapter.move(temp, paths.review);
	} catch {
		return failure("storage_failure", "delegation review atomic publish failed", "review.rename");
	}
	const finalRead = await readReviewArtifactAt(paths, state, records, adapter, "review.final.read");
	if (!finalRead.ok || finalRead.value.finalized || !Buffer.from(finalRead.value.bytes).equals(Buffer.from(encoded))) {
		return failure("storage_failure", "delegation review final readback mismatch", "review.final.read");
	}
	return finalRead;
}

/** Persist segmented or failing review evidence without granting authority. */
export async function persistDelegationReviewProvisionalV2(
	projectRoot: string,
	input: PublishDelegationReviewV2Input,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationReviewAuthorityV2>> {
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const currentResult = await readStateAt(paths.transaction, adapter);
		if (!currentResult.ok) return currentResult;
		const current = currentResult.value;
		if (current.status !== "PENDING_REVIEW" || current.revision !== 3 || current.task_kind !== "implementation" ||
			current.committed_proof === null || current.review !== null || current.generation !== input.expected_generation ||
			current.revision !== input.expected_revision || current.contract_hash !== input.contract_hash ||
			!sameIdentity(current.worker_identity, input.worker_identity) || input.now !== input.artifact.reviewed_at) {
			return failure("conflict", "delegation provisional review CAS, identity, or lifecycle check failed");
		}
		const artifact = parseReviewArtifactForState(input.artifact, current);
		if (artifact === undefined || artifact.review.schema_version !== 2) {
			return failure("invalid_input", "only new-v2 relevance review artifacts may be persisted");
		}
		const generation = generationName(current.generation);
		if (generation === undefined) return failure("invalid_record", "delegation review generation is invalid");
		const verified = await verifyGenerationDirectory(join(paths.generations, generation), {
			...current, status: "COMMITTING", revision: current.committed_proof.revision, committed_proof: null, review: null,
		}, adapter);
		if (!verified.ok || !sameJson(verified.value.inventory.proof, current.committed_proof) ||
			!reviewArtifactBindsGeneration(artifact, verified.value.records, current)) {
			return failure("invalid_record", "provisional review conflicts with the committed generation");
		}
		const written = await writeReviewArtifactLocked(paths, current, verified.value.records, artifact, adapter);
		if (!written.ok) return written;
		const { bytes: _bytes, ...authority } = written.value;
		return { ok: true, value: authority };
	});
}

/**
 * Atomically publish the only valid implementation review authority.
 * The review file is committed first, hashed from a strict full-byte
 * readback, then the PENDING_REVIEW(rev3) transaction is CAS-published as
 * REVIEWED(rev4) while the same per-delegation lock remains held.
 */
export async function publishDelegationReviewV2(
	projectRoot: string,
	input: PublishDelegationReviewV2Input,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationReviewAuthorityV2>> {
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const currentResult = await readStateAt(paths.transaction, adapter);
		if (!currentResult.ok) return currentResult;
		const current = currentResult.value;
		if (current.status !== "PENDING_REVIEW" || current.revision !== 3 || current.task_kind !== "implementation" ||
			current.committed_proof === null || current.review !== null || current.generation !== input.expected_generation ||
			current.revision !== input.expected_revision || current.contract_hash !== input.contract_hash ||
			!sameIdentity(current.worker_identity, input.worker_identity) || input.now !== input.artifact.reviewed_at) {
			return failure("conflict", "delegation review CAS, identity, or lifecycle check failed");
		}
		const parsedArtifact = parseReviewArtifactForState(input.artifact, current);
		if (parsedArtifact === undefined || parsedArtifact.review.schema_version !== 2 ||
			parsedArtifact.review.verdict !== "PASS" || !parsedArtifact.review.coverage_complete) {
			return failure("invalid_input", "only a complete PASS review artifact may finalize a delegation");
		}
		const generation = generationName(current.generation);
		if (generation === undefined) return failure("invalid_record", "delegation review generation is invalid");
		const verified = await verifyGenerationDirectory(join(paths.generations, generation), {
			...current,
			status: "COMMITTING",
			revision: current.committed_proof.revision,
			committed_proof: null,
			review: null,
		}, adapter);
		if (!verified.ok || !sameJson(verified.value.inventory.proof, current.committed_proof) ||
			!reviewArtifactBindsGeneration(parsedArtifact, verified.value.records, current)) {
			return failure("invalid_record", "review artifact conflicts with the committed generation");
		}
		const finalRead = await writeReviewArtifactLocked(paths, current, verified.value.records, parsedArtifact, adapter);
		if (!finalRead.ok) return finalRead;
		const next = reviewDelegationTransaction(current, {
			delegation_id: input.delegation_id,
			contract_hash: input.contract_hash,
			worker_identity: input.worker_identity,
			expected_generation: input.expected_generation,
			expected_revision: input.expected_revision,
			now: input.now,
			review_hash: finalRead.value.review_hash,
		});
		if (!next.ok) return failure("conflict", "delegation review state transition failed");
		const published = await publishState(paths, next.state, adapter, "review_state");
		if (!published.ok) return published;
		const { bytes: _bytes, ...authority } = finalRead.value;
		return { ok: true, value: { ...authority, state: published.value, finalized: true } };
	});
}

export async function commitDelegationGeneration(
	projectRoot: string,
	input: CommitDelegationGenerationInput,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTransactionRecord>> {
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const current = await readStateAt(paths.transaction, adapter);
		if (!current.ok) return current;
		const state = current.value;
		if (state.status !== "COMMITTING" || state.generation !== input.expected_generation || state.revision !== input.expected_revision ||
			state.contract_hash !== input.contract_hash || !sameIdentity(state.worker_identity, input.worker_identity)) {
			return failure("conflict", "delegation generation commit CAS, identity, or lifecycle check failed");
		}
		const name = generationName(state.generation);
		if (name === undefined) return failure("invalid_record", "delegation generation is outside the storage bound");
		const compiled = compileCommittedRecords(state, input.records);
		if (!compiled.ok) return compiled;
		const proof = makeProof(state, hashDelegationCommittedRecords(compiled.value));
		const marker = encodeJson(proof, DELEGATION_TRANSACTION_MARKER_MAX_BYTES);
		if (marker === undefined) return failure("invalid_record", "commit marker exceeds its bound");
		const finalDirectory = join(paths.generations, name);
		const stagingToken = storageToken(adapter);
		if (stagingToken === undefined) return failure("storage_failure", "storage random token is invalid", "generation.staging.mkdir");
		const stagingDirectory = join(paths.generations, `.${name}.attempt-${stagingToken}.staging`);
		try {
			await invokeFault(adapter, "generation.mkdir");
			await adapter.makeDirectory(paths.generations, false);
			if ((await adapter.inspect(paths.generations)).kind !== "directory") {
				return failure("storage_failure", "generation root is unsafe", "generation.mkdir");
			}
			await invokeFault(adapter, "generation.staging.mkdir");
			await adapter.makeDirectory(stagingDirectory, true);
			if ((await adapter.inspect(stagingDirectory)).kind !== "directory") {
				return failure("storage_failure", "generation staging directory is unsafe", "generation.staging.mkdir");
			}
			for (const recordName of DELEGATION_COMMITTED_RECORD_NAMES) {
				await invokeFault(adapter, `generation.record.${recordName}.write` as DelegationTransactionStorageFaultPoint);
				await adapter.write(join(stagingDirectory, recordName), compiled.value.get(recordName)!, true);
			}
			await invokeFault(adapter, "generation.marker.write");
			await adapter.write(join(stagingDirectory, COMMIT_MARKER_FILE), marker, true);
		} catch {
			return failure("storage_failure", "committed generation staging write failed");
		}
		const verified = await verifyGenerationDirectory(stagingDirectory, state, adapter);
		if (!verified.ok) return verified;
		try {
			await adapter.inspect(finalDirectory);
			return failure("conflict", "immutable generation already exists");
		} catch (error) {
			if (!isErrno(error, "ENOENT")) return failure("storage_failure", "generation destination inspection failed");
		}
		try {
			await invokeFault(adapter, "generation.rename");
			await adapter.move(stagingDirectory, finalDirectory);
		} catch {
			return failure("storage_failure", "immutable generation publish failed", "generation.rename");
		}
		const next = publishDelegationCommit(state, { ...input, proof });
		if (!next.ok) return failure("invalid_record", "committed proof was refused by delegation state machine");
		return publishState(paths, next.state, adapter, "publish_state");
	});
}
